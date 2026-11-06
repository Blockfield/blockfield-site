import { randomUUID } from 'node:crypto'
import { maintenanceFrom, type Maintenance } from './rooms.ts'

export type CpMode = 'open' | 'draining' | 'maintenance'
export type CpGate = {
  revision: number
  mode: CpMode
  message: string
  since: number | null
  observedAt: number
}
export type CpActor = { id: string; role: string }

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
  actor: CpActor,
  idempotencyKey: string,
): Promise<{ operationId: string; revision: number }> {
  const read = await cp('/v1/gate', process.env.BLOCKFIELD_CP_GATE_READ_TOKEN)
  if (!validGate(read)) throw new Error('Control-plane отдал неверное состояние.')
  return cp('/v1/gate', process.env.BLOCKFIELD_CP_GATE_WRITE_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      expectedRevision: read.revision,
      idempotencyKey,
      mode,
      message,
      actor,
    }),
  })
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
  peer_role_edit: [403, 'Чужую административную роль меняет только владелец.'],
  protected_owner: [403, 'Владельцы задаются только переменной окружения сервера.'],
  ineligible_account: [403, 'Этот аккаунт не может получить роль.'],
  account_not_found: [404, 'Участник не найден.'],
  revision_conflict: [409, 'Запрос устарел: обновите страницу.'],
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

export type StaffGrant = {
  accountUuid: string
  role: 'builder' | 'moderator' | 'admin'
  revoke?: boolean
  expectedRevision: number
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
