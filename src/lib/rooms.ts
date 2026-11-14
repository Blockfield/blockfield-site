export type CapturePoint = {
  id: string
  name: string
  owner: string
  claiming: string
  capturing: string
  progress: number
}
export type Battle = { red: number; blue: number; points: CapturePoint[] }
export function validBattle(battle: any): boolean {
  return (
    battle == null ||
    (Number.isInteger(battle.red) &&
      battle.red >= 0 &&
      Number.isInteger(battle.blue) &&
      battle.blue >= 0 &&
      Array.isArray(battle.points) &&
      battle.points.length <= 100 &&
      battle.points.every(
        (p: any) =>
          p &&
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          ['RED', 'BLUE', 'NEUTRAL'].includes(p.owner) &&
          ['RED', 'BLUE', 'NONE'].includes(p.claiming) &&
          ['RED', 'BLUE', 'NONE'].includes(p.capturing) &&
          Number.isInteger(p.progress) &&
          p.progress >= 0 &&
          p.progress <= 100,
      ))
  )
}
// format/admission/ready come from blockfield-mod#28 pass-through room
// fields; the client ignores unknown values.
export type Room = {
  id: string
  name: string
  mode: string
  map: string
  phase: string
  players: number
  joinable: boolean
  battle?: Battle | null
  format?: string
  admission?: string
  ready?: { ready: number; required: number }
}
// build — тег релиза или короткий SHA коммита, на котором запущен игровой сервер.
export type RoomStatus = {
  available: boolean
  checkedAt: number
  rooms: Room[]
  build?: string
  maintenance?: Maintenance
}
export type Maintenance = { message: string; since: number | null }
export const maintenanceMessage =
  'На сервере проводятся технические работы. Обычный вход временно недоступен.'
// Любое значение, кроме валидного mode "game", закрывает вход (fail closed).
export function maintenanceFrom(value: any): Maintenance | null {
  if (value?.mode === 'game') return null
  const valid = ['draining', 'workshop', 'maintenance'].includes(value?.mode)
  const message =
    valid && typeof value.message === 'string' ? value.message.trim().slice(0, 500) : ''
  return {
    message: message || maintenanceMessage,
    since: valid && Number.isSafeInteger(value.since) ? value.since : null,
  }
}
const buildPattern = /^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/
export function validBuild(value: any): value is string {
  return typeof value === 'string' && buildPattern.test(value)
}
export const phases: Record<string, string> = {
  IDLE: 'Ожидание игроков',
  VOTING: 'Голосование',
  PREPARING: 'Подготовка',
  GAME: 'Бой',
  MATCH_END: 'Матч завершён',
}
export const roomId = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
// The presence row is latest-only: a report older than this never marks the game live.
const PRESENCE_STALE_MS = 30_000
/** Strict room list from the control-plane presence read; throws closed on any bad room. */
export function parsePresenceRooms(value: any): { rooms: Room[]; build?: string } {
  if (!value || typeof value !== 'object' || !Array.isArray(value.rooms))
    throw new Error('Room status unavailable')
  const rooms = value.rooms
    .filter(
      (r: any) =>
        r &&
        roomId.test(r.id) &&
        typeof r.name === 'string' &&
        typeof r.mode === 'string' &&
        typeof r.map === 'string' &&
        r.phase in phases &&
        Number.isInteger(r.players) &&
        r.players >= 0 &&
        typeof r.joinable === 'boolean' &&
        validBattle(r.battle),
    )
    .slice(0, 100)
  if (rooms.length !== value.rooms.length) throw new Error('Invalid room status')
  const build = validBuild(value.build) ? { build: value.build } : {}
  return { rooms, ...build }
}
let cache: RoomStatus = { available: false, checkedAt: 0, rooms: [] }
let until = 0
let inflight: Promise<RoomStatus> | undefined
export function currentRooms(): Promise<RoomStatus> {
  if (Date.now() < until) return Promise.resolve(cache)
  return refreshRooms()
}

/**
 * Stale-while-revalidate for the action path and the panel: a known snapshot is
 * served immediately and refreshed in the background, so an admin action never
 * blocks on the CP read. The first read (no snapshot yet) still awaits.
 */
export function cachedRooms(): Promise<RoomStatus> {
  if (cache.checkedAt !== 0) {
    if (Date.now() >= until) void refreshRooms().catch(() => {})
    return Promise.resolve(cache)
  }
  return refreshRooms()
}

function refreshRooms(): Promise<RoomStatus> {
  return (inflight ??= (async () => {
    const cp = await import('./cp.ts')
    // No file or TCP fallbacks: the gate and the rooms both come from the
    // control plane. An unreadable gate fails closed (entry shut) instead of
    // failing open; unreadable rooms only mark the game down.
    const maintenance = await cp.readGateCp().catch(() => ({
      message: maintenanceMessage,
      since: null,
    }))
    const presence = await cp.readPresenceCp().catch(() => null)
    const reportedAt =
      presence?.initialized && typeof presence.reportedAt === 'string'
        ? Date.parse(presence.reportedAt)
        : NaN
    const age = Date.now() - reportedAt
    let fresh =
      !!presence &&
      Number.isFinite(reportedAt) &&
      age >= -PRESENCE_STALE_MS &&
      age < PRESENCE_STALE_MS
    let rooms: Room[] = []
    let build: string | undefined
    if (fresh) {
      try {
        ;({ rooms, build } = parsePresenceRooms(presence.presence))
      } catch {
        fresh = false
        rooms = []
        build = undefined
      }
    }
    // The game drains rooms before a restart: like the old draining gate mode,
    // entry reads closed while the gate itself stays open.
    const gateMaintenance = maintenance ?? null
    const drainingMaintenance =
      !gateMaintenance && fresh && (presence!.presence as any)?.draining
        ? { message: maintenanceMessage, since: null }
        : null
    const shown = gateMaintenance ?? drainingMaintenance
    const value: RoomStatus = {
      available: !!fresh && !gateMaintenance,
      checkedAt: Date.now(),
      rooms: fresh && !gateMaintenance ? rooms : [],
      ...(build ? { build } : {}),
      ...(shown ? { maintenance: shown } : {}),
    }
    cache = value
    until = Date.now() + 5000
    return value
  })().finally(() => {
    inflight = undefined
  }))
}
