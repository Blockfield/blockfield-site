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
  return error
}

async function settingsRequest(
  namespace: string,
  target: string,
  token: string | undefined,
  init?: RequestInit,
): Promise<any> {
  const url = config()
  if (!token) throw new Error('Control-plane не настроен на сайте (токен).')
  const response = await fetch(
    `${url}/v2/settings/${settingsSegment(namespace, 'раздел')}/${settingsSegment(target, 'адресат')}`,
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
  const data = await settingsRequest(namespace, target, token, {
    method: 'PATCH',
    body: JSON.stringify({
      expectedRevision: patch.expectedRevision,
      idempotencyKey: patch.idempotencyKey,
      patch: patch.patch,
    }),
  })
  if (typeof data?.operationId !== 'string' || !Number.isSafeInteger(data?.revision))
    throw new Error('Control-plane отдал неверное состояние.')
  return { operationId: data.operationId, revision: data.revision }
}
