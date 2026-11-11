import { createHash, randomUUID } from 'node:crypto'
import { maintenanceFrom, type Maintenance } from './rooms.ts'

export type CpMode = 'open' | 'draining' | 'maintenance'
export type CpGate = {
  revision: number
  mode: CpMode
  message: string
  since: number | null
  observedAt: number
}

/** «Начать/Закончить техработы»: admin action to CP mode (pure, unit-tested). */
export function gateToggle(body: any): { mode: 'maintenance' | 'open'; message: string } {
  if (body?.action === 'maintenance-start') return { mode: 'maintenance', message: '' }
  if (body?.action === 'maintenance-stop') return { mode: 'open', message: '' }
  throw new Error('Неизвестное действие.')
}

const TIMEOUT_MS = 2500

/** Кнопки «Начать/Закончить техработы» живы, только когда задан URL (иначе их нет на странице). */
export function cpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ((env.BLOCKFIELD_CP_URL ?? '') as string).replace(/\/+$/, '').trim().length > 0
}

function config() {
  const env = process.env
  const url = (env.BLOCKFIELD_CP_URL ?? '').replace(/\/+$/, '')
  if (!url) throw new Error('Control-plane не настроен на сайте (BLOCKFIELD_CP_URL).')
  return url
}

async function cp(path: string, token: string | undefined, init?: RequestInit): Promise<any> {
  if (!token) throw new Error('Control-plane не настроен на сайте (токен).')
  const response = await fetch(config() + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(
      typeof data?.revision === 'number'
        ? `Control-plane отклонил запрос (ревизия ${data.revision}).`
        : 'Control-plane отклонил запрос.',
    )
  return data
}

function validGate(data: any): data is CpGate {
  return (
    data?.schema === 1 &&
    Number.isSafeInteger(data.revision) &&
    ['open', 'draining', 'maintenance'].includes(data.mode) &&
    typeof data.message === 'string' &&
    Number.isFinite(data.observedAt)
  )
}

/** CP maintenance closes entry; draining/open keep it (drain flag stays an RCON status). */
export function maintenanceFromCp(gate: CpGate): Maintenance | null {
  if (gate.mode !== 'maintenance') return null
  return maintenanceFrom({ mode: 'maintenance', message: gate.message, since: gate.since })
}

export async function readGateCp(
  fetchGate: () => Promise<any> = () => cp('/v1/gate', process.env.BLOCKFIELD_CP_GATE_READ_TOKEN),
): Promise<Maintenance | null> {
  const data = await fetchGate()
  if (!validGate(data)) throw new Error('Control-plane отдал неверное состояние.')
  return maintenanceFromCp(data)
}

export async function postGateCp(
  mode: CpMode,
  message: string,
  idempotencyKey: string,
  token: string | undefined = process.env.BLOCKFIELD_CP_GATE_TOKEN,
): Promise<{ operationId: string; revision: number }> {
  const read = await cp('/v1/gate', process.env.BLOCKFIELD_CP_GATE_READ_TOKEN)
  if (!validGate(read)) throw new Error('Control-plane отдал неверное состояние.')
  try {
    // Game gate on CP v2: PATCH /v2/settings/gate/* with the moderation.ban
    // scope. The gate toggle sends no actor: that scope keeps the stable
    // service-principal attribution, unlike game settings writes where the
    // site asserts the acting admin.
    return await patchSettingsCp(
      'gate',
      '*',
      { expectedRevision: read.revision, idempotencyKey, patch: { mode, message } },
      token,
    )
  } catch (error) {
    // Callers (POST gate) map «ревизия N» to 409: keep that contract and the code.
    if (isRevisionConflict(error)) {
      const conflict = new Error(`Control-plane отклонил запрос (ревизия ${read.revision}).`)
      ;(conflict as { code?: string }).code = 'revision_conflict'
      throw conflict
    }
    throw error
  }
}

export type CpSettingsView = {
  initialized: boolean
  revision: number
  value: unknown
  hash: string
}

export type CpSettingsPatch = {
  expectedRevision: number
  idempotencyKey: string
  patch: Record<string, unknown>
  /**
   * Logged-in admin the service credential asserts (CP re-resolves the
   * account; required for game namespaces, omitted only for the gate
   * toggle whose moderation.ban scope keeps stable-principal attribution).
   */
  actorAccountId?: string
}

const settingsSegment = (value: string, name: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_*-]{1,64}$/.test(value))
    throw new Error(`Некорректный ${name} настроек control-plane.`)
  return value
}

/** Stale expectedRevision (or a reused idempotency key with a changed body): re-read before retrying. */
export function isRevisionConflict(error: unknown) {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'revision_conflict'
  )
}

function settingsError(status: number, data: any): Error {
  const code = typeof data?.error === 'string' ? data.error : `http_${status}`
  const error = new Error(
    code === 'revision_conflict' || code === 'idempotency_conflict'
      ? 'Настройки уже изменил кто-то другой. Обновите страницу.'
      : `Control-plane отклонил запрос (${code}).`,
  )
  ;(error as { code?: string }).code = code
  ;(error as { status?: number }).status = status
  return error
}

async function settingsRequest(
  namespace: string,
  target: string,
  token: string | undefined,
  init?: RequestInit,
  suffix = '',
): Promise<any> {
  const url = config()
  if (!token) throw new Error('Control-plane не настроен на сайте (токен).')
  const response = await fetch(
    `${url}/v2/settings/${settingsSegment(namespace, 'раздел')}/${settingsSegment(target, 'адресат')}${suffix}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  )
  const data = await response.json().catch(() => null)
  if (!response.ok) throw settingsError(response.status, data)
  return data
}

function validSettingsView(data: any): data is CpSettingsView {
  return (
    typeof data?.initialized === 'boolean' &&
    Number.isSafeInteger(data?.revision) &&
    data.revision >= 0 &&
    !!data?.value &&
    typeof data.value === 'object' &&
    typeof data?.hash === 'string'
  )
}

/**
 * v2 settings transport. Namespaces (gameplay, gate, rooms, deathmatch,
 * classLocks, campaign, parcool, gunBalance, kits, disabledMapIds, ai-limits,
 * workshop-ai) come from control-plane PR #21: the contract is CP main after
 * #21 merges (coordinator-ordered), not the old gameplay+gate-only core.
 * Fails closed: no file fallback on CP errors.
 */
export async function readSettingsCp(
  namespace: string,
  target = '*',
  token: string | undefined = process.env.BLOCKFIELD_CP_SETTINGS_TOKEN,
): Promise<CpSettingsView> {
  const data = await settingsRequest(namespace, target, token)
  if (!validSettingsView(data)) throw new Error('Control-plane отдал неверное состояние.')
  return {
    initialized: data.initialized,
    revision: data.revision,
    value: data.value,
    hash: data.hash,
  }
}

export async function patchSettingsCp(
  namespace: string,
  target: string,
  patch: CpSettingsPatch,
  token: string | undefined = process.env.BLOCKFIELD_CP_SETTINGS_TOKEN,
): Promise<{ operationId: string; revision: number }> {
  if (
    !patch ||
    typeof patch !== 'object' ||
    !Number.isSafeInteger(patch.expectedRevision) ||
    typeof patch.idempotencyKey !== 'string' ||
    patch.idempotencyKey.length < 1 ||
    patch.idempotencyKey.length > 128 ||
    !patch.patch ||
    typeof patch.patch !== 'object'
  )
    throw new Error('Некорректный патч настроек control-plane.')
  // The site service credential asserts the logged-in admin for game
  // namespaces (like staff grants): CP refuses unasserted service writes
  // there. The gate toggle omits it: its moderation.ban scope keeps the
  // stable-principal path.
  const actor =
    patch.actorAccountId === undefined
      ? undefined
      : patch.actorAccountId.replaceAll('-', '').toLowerCase()
  if (actor !== undefined && !/^[0-9a-f]{32}$/.test(actor)) throw new Error('Некорректный запрос.')
  const data = await settingsRequest(namespace, target, token, {
    method: 'PATCH',
    body: JSON.stringify({
      expectedRevision: patch.expectedRevision,
      idempotencyKey: patch.idempotencyKey,
      patch: patch.patch,
      ...(actor === undefined
        ? {}
        : {
            actorAccountId: actor.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
          }),
    }),
  })
  if (typeof data?.operationId !== 'string' || !Number.isSafeInteger(data?.revision))
    throw new Error('Control-plane отдал неверное состояние.')
  return { operationId: data.operationId, revision: data.revision }
}

export type CpSettingsRollback = Pick<
  CpSettingsPatch,
  'expectedRevision' | 'idempotencyKey' | 'actorAccountId'
> & {
  revision: number
}

/** Rollback to a stored revision (used to clear merge-only dict state). */
export async function rollbackSettingsCp(
  namespace: string,
  target: string,
  rollback: CpSettingsRollback,
  token: string | undefined = process.env.BLOCKFIELD_CP_SETTINGS_TOKEN,
): Promise<{ operationId: string; revision: number }> {
  if (
    !rollback ||
    typeof rollback !== 'object' ||
    !Number.isSafeInteger(rollback.expectedRevision) ||
    typeof rollback.idempotencyKey !== 'string' ||
    rollback.idempotencyKey.length < 1 ||
    rollback.idempotencyKey.length > 128 ||
    !Number.isSafeInteger(rollback.revision) ||
    rollback.revision < 1
  )
    throw new Error('Некорректный откат настроек control-plane.')
  const actor =
    rollback.actorAccountId === undefined
      ? undefined
      : rollback.actorAccountId.replaceAll('-', '').toLowerCase()
  if (actor !== undefined && !/^[0-9a-f]{32}$/.test(actor)) throw new Error('Некорректный запрос.')
  const data = await settingsRequest(
    namespace,
    target,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision: rollback.expectedRevision,
        idempotencyKey: rollback.idempotencyKey,
        revision: rollback.revision,
        ...(actor === undefined
          ? {}
          : {
              actorAccountId: actor.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
            }),
      }),
    },
    '/rollback',
  )
  if (typeof data?.operationId !== 'string' || !Number.isSafeInteger(data?.revision))
    throw new Error('Control-plane отдал неверное состояние.')
  return { operationId: data.operationId, revision: data.revision }
}

export type CpScope = { environment: string; backend: string; resource: string }

/** v2 staff scope: game backend; environment follows the deployment, default prod. */
export function cpScope(env: NodeJS.ProcessEnv = process.env): CpScope {
  return {
    environment: (((env.BLOCKFIELD_CP_ENV ?? '') as string).trim() || 'prod').slice(0, 64),
    backend: 'game',
    resource: '*',
  }
}

/** Штат через control-plane v2: тот же URL, отдельный токен. Без токена — старый путь через staff_roles. */
export function cpStaffConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return cpConfigured(env) && ((env.BLOCKFIELD_CP_STAFF_TOKEN ?? '') as string).trim().length > 0
}

function staffConfig() {
  const url = config()
  const token = (process.env.BLOCKFIELD_CP_STAFF_TOKEN ?? '').trim()
  if (!token) throw new Error('Control-plane не настроен на сайте (токен).')
  return { url, token, ...cpScope() }
}

export type CpProblem = Error & { status: number; code: string }

const staffMessages: Record<string, [number, string]> = {
  self_role_edit: [403, 'Свою роль менять нельзя.'],
  service_actor_required: [500, 'Сайт не передал автора изменения. Обратитесь к координатору.'],
  actor_forbidden: [
    500,
    'Сайт не вправе подтверждать автора изменения. Обратитесь к координатору.',
  ],
  owner_approval_required: [
    403,
    'Назначение администратора требует шага владельца, недоступного на сайте. Обратитесь к координатору.',
  ],
  invalid_owner_assertion: [403, 'Подтверждение владельца отклонено. Обратитесь к координатору.'],
  forbidden: [403, 'У сайта нет доступа к штату в control-plane. Обратитесь к координатору.'],
  peer_role_edit: [403, 'Чужую административную роль меняет только владелец.'],
  protected_owner: [403, 'Владельцы задаются только переменной окружения сервера.'],
  ineligible_account: [403, 'Этот аккаунт не может получить роль.'],
  account_not_found: [404, 'Участник не найден.'],
  revision_conflict: [
    409,
    'Запрос устарел: обновите список и повторите. Не помогло — ревизия менялась мимо сайта, обратитесь к координатору.',
  ],
  idempotency_conflict: [409, 'Запрос уже обрабатывается: обновите страницу.'],
}

function staffProblem(status: number, code: string): CpProblem {
  const [mappedStatus, message] = staffMessages[code] ?? [status, 'Control-plane отклонил запрос.']
  const error = new Error(message) as CpProblem
  error.status = mappedStatus
  error.code = code
  return error
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

async function cpStaff(
  path: string,
  token: string,
  init: RequestInit | undefined,
  fetchImpl: FetchImpl,
): Promise<any> {
  const url = config()
  const response = await fetchImpl(url + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw staffProblem(
      response.status,
      typeof data?.error === 'string' ? data.error : 'control_plane_error',
    )
  return data
}

export type CpGrant = {
  role: string
  environment: string
  backend: string
  resource: string
  revision: number
  expires_at?: string | null
}
export type CpMe = { accountId: string | null; owner: boolean; grants: CpGrant[] }

function validGrant(data: any): data is CpGrant {
  return (
    typeof data?.role === 'string' &&
    typeof data?.environment === 'string' &&
    typeof data?.backend === 'string' &&
    typeof data?.resource === 'string' &&
    Number.isSafeInteger(data?.revision)
  )
}

function validMe(data: any): data is CpMe {
  return (
    (data?.accountId === null || typeof data?.accountId === 'string') &&
    typeof data?.owner === 'boolean' &&
    Array.isArray(data?.grants) &&
    data.grants.every(validGrant)
  )
}

/** Ростер одного участника в CP: живые гранты и ревизия для CAS-записей. Отказ несёт код CP. */
export type CpRosterRead = { accountId: string; expectedRevision: number; grants: CpGrant[] }

function validRosterRead(data: any): data is CpRosterRead {
  return (
    typeof data?.accountId === 'string' &&
    Number.isSafeInteger(data?.expectedRevision) &&
    Array.isArray(data?.grants) &&
    data.grants.every(validGrant)
  )
}

export async function readStaffGrantsCp(
  accountUuid: string,
  token: string = staffConfig().token,
  fetchImpl: FetchImpl = (url, init) => fetch(url, init),
): Promise<CpRosterRead> {
  const compact = accountUuid.replaceAll('-', '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error('Некорректный запрос.')
  const scope = cpScope()
  const dashed = compact.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
  const query =
    `accountId=${dashed}&environment=${encodeURIComponent(scope.environment)}` +
    `&backend=${encodeURIComponent(scope.backend)}`
  const data = await cpStaff(`/v2/staff/grants?${query}`, token, undefined, fetchImpl)
  if (!validRosterRead(data)) throw new Error('Control-plane отдал неверное состояние.')
  return data
}

/** Своя сессия в CP: кто я и какие права у меня есть. Отказ несёт код CP (status + code). */
export async function readMeCp(
  token: string = staffConfig().token,
  fetchImpl: FetchImpl = (url, init) => fetch(url, init),
): Promise<CpMe> {
  const data = await cpStaff('/v2/me', token, undefined, fetchImpl)
  if (!validMe(data)) throw new Error('Control-plane отдал неверное состояние.')
  return data
}

const roleRank: Record<string, number> = { builder: 1, moderator: 2, admin: 3 }

/** Роль сайта из своих CP-грантов: бит владельца важнее, из грантов засчитываются только общие (resource *). */
export function roleFromCpMe(
  me: CpMe,
  scope: CpScope = cpScope(),
): 'builder' | 'moderator' | 'admin' | 'owner' | null {
  if (me.owner) return 'owner'
  let best: 'builder' | 'moderator' | 'admin' | null = null
  for (const grant of me.grants) {
    if (grant.environment !== scope.environment || grant.backend !== scope.backend) continue
    if (grant.resource !== '*' && grant.resource !== scope.resource) continue
    if ((roleRank[grant.role] ?? 0) <= (best ? roleRank[best] : 0)) continue
    best = grant.role as 'builder' | 'moderator' | 'admin'
  }
  return best
}

/** Deterministic idempotency key for one admin intent: the same UI retry
reuses it and dedupes in CP, while a later list revision makes a genuinely new
change a new key. */
export function staffIdempotencyKey(request: {
  actorAccountId: string
  accountUuid: string
  role: string
  revoke: boolean
  scope: CpScope
  uiRevision: number
}): string {
  const material = [
    'staff-grant-v1',
    request.actorAccountId.replaceAll('-', '').toLowerCase(),
    request.accountUuid.replaceAll('-', '').toLowerCase(),
    request.role,
    request.revoke ? 'revoke' : 'grant',
    request.scope.environment,
    request.scope.backend,
    request.scope.resource,
    String(request.uiRevision),
  ].join('|')
  const compact = createHash('sha256').update(material).digest('hex').slice(0, 32)
  return compact.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
}

export type StaffGrant = {
  accountUuid: string
  role: 'builder' | 'moderator' | 'admin'
  revoke?: boolean
  expectedRevision: number
  actorAccountId: string
  idempotencyKey?: string
  scope?: CpScope
}

/** Запись штата в CP: грант или отзыв одной роли. Возвращает чек операции; отказ несёт код CP. */
export async function postStaffGrantCp(
  grant: StaffGrant,
  token: string = staffConfig().token,
  fetchImpl: FetchImpl = (url, init) => fetch(url, init),
): Promise<{ operationId: string; status: string; authorizationEpoch: number | null }> {
  const compact = grant.accountUuid.replaceAll('-', '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error('Некорректный запрос.')
  const actor = grant.actorAccountId.replaceAll('-', '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(actor)) throw new Error('Некорректный запрос.')
  if (!['builder', 'moderator', 'admin'].includes(grant.role)) throw new Error('Неизвестная роль.')
  if (!Number.isSafeInteger(grant.expectedRevision))
    throw new Error('Нет ревизии: обновите страницу.')
  const scope = grant.scope ?? cpScope()
  const data = await cpStaff(
    '/v2/staff/grants',
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: grant.idempotencyKey ?? randomUUID(),
        environment: scope.environment,
        backend: scope.backend,
        accountId: compact.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
        actorAccountId: actor.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
        expectedRevision: grant.expectedRevision,
        role: grant.role,
        resource: scope.resource,
        revoke: grant.revoke ?? false,
      }),
    },
    fetchImpl,
  )
  if (typeof data?.operationId !== 'string')
    throw new Error('Control-plane отдал неверное состояние.')
  const authorizationEpoch =
    typeof data?.result?.authorizationEpoch === 'number' ? data.result.authorizationEpoch : null
  return { operationId: data.operationId, status: data.status ?? 'accepted', authorizationEpoch }
}

/** Выход и в CP: отзывает текущую центральную сессию и её потомков. */
export async function revokeSessionCp(
  token: string = staffConfig().token,
  fetchImpl: FetchImpl = (url, init) => fetch(url, init),
): Promise<void> {
  await cpStaff('/v2/sessions/current', token, { method: 'DELETE' }, fetchImpl)
}

/**
 * Typed moderation via control-plane v2 (control-plane cp#32):
 * POST /v2/actions/moderation.<kind>. Only fire-and-forget commands move:
 * `list` stays on RCON (a read; CP ACKs carry no output), kick/ban keep the
 * RCON nickname flow until the UUID cutover, maintenance/raw/console have no
 * typed kind. Active only when fully configured; otherwise RCON stays.
 */
export const moderationCpKinds = [
  'say',
  'pardon',
  'team-kick',
  'class-lock',
  'class-unlock',
  'range',
  'stop-room',
] as const
export type ModerationCpKind = (typeof moderationCpKinds)[number]

const uuidLoose = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function cpModerationConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    cpConfigured(env) &&
    ((env.BLOCKFIELD_CP_MODERATION_TOKEN ?? '') as string).trim().length > 0 &&
    uuidLoose.test(((env.BLOCKFIELD_CP_CONSUMER_GENERATION ?? '') as string).trim())
  )
}

function moderationConfig() {
  const url = config()
  const token = (process.env.BLOCKFIELD_CP_MODERATION_TOKEN ?? '').trim()
  if (!token) throw new Error('Control-plane не настроен на сайте (токен).')
  const generation = (process.env.BLOCKFIELD_CP_CONSUMER_GENERATION ?? '').trim()
  if (!uuidLoose.test(generation))
    throw new Error('Control-plane не настроен на сайте (поколение получателя).')
  const consumerId = (process.env.BLOCKFIELD_CP_CONSUMER_ID ?? 'game').trim() || 'game'
  return { url, token, generation, consumerId, ...cpScope() }
}

const moderationMessages: Record<string, [number, string]> = {
  invalid_action: [502, 'Control-plane отклонил запрос.'],
  unknown_action: [500, 'Control-plane не знает это действие. Обратитесь к координатору.'],
  consumer_generation_or_capability: [
    503,
    'Версия получателя в control-plane устарела. Обратитесь к координатору.',
  ],
  consumer_lag: [503, 'Сервер занят подтверждением команд. Попробуйте позже.'],
  service_actor_required: [500, 'Сайт не передал автора изменения. Обратитесь к координатору.'],
  actor_forbidden: [
    500,
    'Сайт не вправе подтверждать автора изменения. Обратитесь к координатору.',
  ],
  ineligible_account: [403, 'Этот аккаунт не может выполнять модерацию.'],
  account_not_found: [404, 'Участник не найден.'],
  forbidden: [503, 'У сайта нет доступа к модерации в control-plane. Обратитесь к координатору.'],
}

function moderationProblem(status: number, code: string): CpProblem {
  const [mappedStatus, message] = moderationMessages[code] ?? [
    status,
    'Control-plane отклонил запрос.',
  ]
  const error = new Error(message) as CpProblem
  error.status = mappedStatus
  error.code = code
  return error
}

/** One typed moderation command: validated fields go out, the operation receipt comes back. */
export async function postModerationCp(
  kind: string,
  actorAccountId: string,
  fields: Record<string, unknown>,
  opts: { target?: string; idempotencyKey?: string; fetchImpl?: FetchImpl } = {},
): Promise<{ operationId: string; status: string }> {
  if (!(moderationCpKinds as readonly string[]).includes(kind))
    throw new Error('Неизвестное действие.')
  // The site service credential asserts the logged-in admin (like staff
  // grants): CP refuses unasserted service calls, so the actor is required.
  const actor = actorAccountId.replaceAll('-', '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(actor)) throw new Error('Некорректный запрос.')
  const { url, token, generation, consumerId, environment, backend } = moderationConfig()
  const fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init))
  const response = await fetchImpl(`${url}/v2/actions/moderation.${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: opts.idempotencyKey ?? randomUUID(),
      environment,
      backend,
      consumerId,
      generation,
      target: opts.target ?? '*',
      ...fields,
      actorAccountId: actor.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw moderationProblem(
      response.status,
      typeof data?.error === 'string' ? data.error : 'control_plane_error',
    )
  if (typeof data?.operationId !== 'string')
    throw new Error('Control-plane отдал неверное состояние.')
  return { operationId: data.operationId, status: data.status ?? 'accepted' }
}

/**
 * Typed Workshop operations via control-plane v2 (control-plane #33,
 * workshop #72): POST /v2/workshop/<kind>. Only the service-holdable write
 * kinds move: `members` needs a person session (plus the owner step-up for
 * admin entries), which the site service credential can never hold, so the
 * member list stays on the file inbox. Map/session/ai-key/mode ops have no
 * CP kind. Active only when fully configured; otherwise the routes fail
 * closed (no second transport, unlike the RCON fallback for moderation).
 */
export const workshopCpKinds = ['message', 'wake', 'cancel'] as const
export type WorkshopCpKind = (typeof workshopCpKinds)[number]

export function cpWorkshopConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    cpConfigured(env) &&
    ((env.BLOCKFIELD_CP_WORKSHOP_TOKEN ?? '') as string).trim().length > 0 &&
    uuidLoose.test(((env.BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION ?? '') as string).trim())
  )
}

function workshopConfig() {
  const url = config()
  const token = (process.env.BLOCKFIELD_CP_WORKSHOP_TOKEN ?? '').trim()
  if (!token) throw new Error('Control-plane не настроен на сайте (токен).')
  const generation = (process.env.BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION ?? '').trim()
  if (!uuidLoose.test(generation))
    throw new Error('Control-plane не настроен на сайте (поколение получателя).')
  const consumerId = (process.env.BLOCKFIELD_CP_WORKSHOP_CONSUMER_ID ?? 'workshop').trim()
  return { url, token, generation, consumerId: consumerId || 'workshop', ...cpScope() }
}

const workshopMessages: Record<string, [number, string]> = {
  invalid_action: [502, 'Control-plane отклонил запрос.'],
  unknown_action: [500, 'Control-plane не знает это действие. Обратитесь к координатору.'],
  consumer_generation_or_capability: [
    503,
    'Версия получателя в control-plane устарела. Обратитесь к координатору.',
  ],
  consumer_lag: [503, 'Мастерская занята подтверждением команд. Попробуйте позже.'],
  forbidden: [503, 'У сайта нет доступа к мастерской в control-plane. Обратитесь к координатору.'],
}

function workshopProblem(status: number, code: string): CpProblem {
  const [mappedStatus, message] = workshopMessages[code] ?? [
    status,
    'Control-plane отклонил запрос.',
  ]
  const error = new Error(message) as CpProblem
  error.status = mappedStatus
  error.code = code
  return error
}

/** One typed Workshop command: the CP-bound actor plus validated fields go out, the operation receipt comes back. */
export async function postWorkshopCp(
  kind: string,
  actor: { draslId: string; name: string },
  fields: Record<string, unknown> = {},
  opts: { idempotencyKey?: string; fetchImpl?: FetchImpl } = {},
): Promise<{ operationId: string; status: string }> {
  if (!(workshopCpKinds as readonly string[]).includes(kind))
    throw new Error('Неизвестное действие.')
  const { url, token, generation, consumerId, environment, backend } = workshopConfig()
  const fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init))
  const response = await fetchImpl(`${url}/v2/workshop/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: opts.idempotencyKey ?? randomUUID(),
      environment,
      backend,
      consumerId,
      generation,
      target: '*',
      actor,
      ...fields,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw workshopProblem(
      response.status,
      typeof data?.error === 'string' ? data.error : 'control_plane_error',
    )
  if (typeof data?.operationId !== 'string')
    throw new Error('Control-plane отдал неверное состояние.')
  return { operationId: data.operationId, status: data.status ?? 'accepted' }
}
