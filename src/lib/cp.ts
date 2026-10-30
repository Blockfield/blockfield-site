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
