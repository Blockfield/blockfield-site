import net from 'node:net'
import { open } from 'node:fs/promises'

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
// format/admission/ready come from blockfield-mod#28; pass through untouched, the client ignores unknown values.
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
// available — игровой сервер отвечает; lobby — прокси с лобби отвечает (при рестарте игрового сервера туда можно зайти).
export type Maintenance = { message: string; since: number | null }
// online — игроков на прокси (все серверы за ним), если прокси отдал это число.
// build — тег релиза или короткий SHA коммита, на котором запущен игровой сервер.
export type RoomStatus = {
  available: boolean
  checkedAt: number
  rooms: Room[]
  build?: string
  lobby?: boolean
  online?: number
  maintenance?: Maintenance
}
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
export async function readGate(path: string | undefined): Promise<Maintenance | null> {
  if (!path) return null
  try {
    const file = await open(path)
    try {
      const buffer = Buffer.alloc(16_385)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead === buffer.length) throw new Error('Gate file too large')
      return maintenanceFrom(JSON.parse(buffer.subarray(0, bytesRead).toString()))
    } finally {
      await file.close()
    }
  } catch {
    return maintenanceFrom(null)
  }
}
export const phases: Record<string, string> = {
  IDLE: 'Ожидание игроков',
  VOTING: 'Голосование',
  PREPARING: 'Подготовка',
  GAME: 'Бой',
  MATCH_END: 'Матч завершён',
}
export const roomId = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
export function parseRooms(value: any): RoomStatus {
  if (
    !value ||
    !Number.isFinite(value.checkedAt) ||
    Math.abs(Date.now() - value.checkedAt) > 30_000 ||
    !Array.isArray(value.rooms)
  )
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
  const build =
    typeof value.build === 'string' && /^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/.test(value.build)
      ? { build: value.build }
      : {}
  return { available: true, checkedAt: value.checkedAt, rooms, ...build }
}
export function varint(value: number): Buffer {
  const bytes = []
  do {
    const byte = value & 127
    value >>>= 7
    bytes.push(byte | (value ? 128 : 0))
  } while (value)
  return Buffer.from(bytes)
}
export function readVarint(data: Buffer, offset = 0): [number, number] | null {
  let value = 0
  for (let i = 0; i < 5; i++) {
    if (offset + i >= data.length) return null
    const byte = data[offset + i]
    value |= (byte & 127) << (7 * i)
    if (!(byte & 128)) return [value, offset + i + 1]
  }
  throw new Error('Invalid varint')
}
export async function queryRooms(host: string, port: number): Promise<RoomStatus> {
  return parseRooms((await queryStatus(host, port)).blockfield)
}
export function queryStatus(host: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let data = Buffer.alloc(0)
    const finish = (error?: Error, value?: any) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value!)
    }
    const timer = setTimeout(() => finish(new Error('Server timeout')), 4000)
    socket.on('error', (e) => finish(e))
    socket.on('end', () => finish(new Error('Incomplete response')))
    socket.on('connect', () => {
      const address = Buffer.from(host)
      const targetPort = Buffer.alloc(2)
      targetPort.writeUInt16BE(port)
      const handshake = Buffer.concat([
        Buffer.from([0]),
        varint(767),
        varint(address.length),
        address,
        targetPort,
        Buffer.from([1]),
      ])
      socket.write(Buffer.concat([varint(handshake.length), handshake, Buffer.from([1, 0])]))
    })
    socket.on('data', (chunk) => {
      try {
        data = Buffer.concat([data, chunk])
        if (data.length > 1_048_576) throw new Error('Response too large')
        const frame = readVarint(data)
        if (!frame) return
        if (frame[0] < 1 || frame[0] > 1_048_576) throw new Error('Invalid frame')
        if (data.length < frame[1] + frame[0]) return
        const packet = data.subarray(frame[1], frame[1] + frame[0])
        const id = readVarint(packet)
        if (!id || id[0] !== 0) throw new Error('Invalid packet')
        const length = readVarint(packet, id[1])
        if (!length || length[0] < 0 || length[1] + length[0] !== packet.length)
          throw new Error('Invalid JSON length')
        finish(undefined, JSON.parse(packet.subarray(length[1]).toString()))
      } catch (e) {
        finish(e as Error)
      }
    })
  })
}
let cache: RoomStatus = { available: false, checkedAt: 0, rooms: [] }
let until = 0
let inflight: Promise<RoomStatus> | undefined
export function currentRooms(): Promise<RoomStatus> {
  if (Date.now() < until) return Promise.resolve(cache)
  const env = process.env
  const publicHost = 'play.blockfield.pro'
  // За Velocity комнаты отдаёт только игровой сервер (внутренний адрес), а публичный адрес — это прокси с лобби.
  // BLOCKFIELD_GATE_SOURCE=cp: вход читается из control-plane, файл — только запасной путь.
  const gate =
    env.BLOCKFIELD_GATE_SOURCE === 'cp'
      ? import('./cp.ts').then((cp) =>
          cp.readGateCp().catch(() => readGate(env.BLOCKFIELD_GATE_FILE)),
        )
      : readGate(env.BLOCKFIELD_GATE_FILE)
  return (inflight ??= gate
    .then((maintenance) =>
      Promise.all([
        maintenance
          ? { available: false, checkedAt: Date.now(), rooms: [], maintenance }
          : queryRooms(
              env.BLOCKFIELD_SERVER_HOST || publicHost,
              Number(env.BLOCKFIELD_SERVER_PORT || 25565),
            ).catch((): RoomStatus => ({ available: false, checkedAt: Date.now(), rooms: [] })),
        queryStatus(
          env.BLOCKFIELD_LOBBY_HOST || publicHost,
          Number(env.BLOCKFIELD_LOBBY_PORT || 25565),
        ).then(
          (status) => status,
          () => null,
        ),
      ]),
    )
    .then(([rooms, status]) => {
      const online = status?.players?.online
      const value = {
        ...rooms,
        lobby: status !== null,
        ...(Number.isSafeInteger(online) && online >= 0 ? { online } : {}),
      }
      cache = value
      until = Date.now() + 5000
      return value
    })
    .finally(() => {
      inflight = undefined
    }))
}
