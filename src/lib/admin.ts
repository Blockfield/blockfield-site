import type { APIContext } from 'astro'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  openSync,
  constants,
  fstatSync,
  readSync,
  readFileSync,
  closeSync,
  readdirSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  createReadStream,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { AstroCookies } from 'astro'
import { account, drasl, fail, nickname, readJson, session, sessionToken } from './account.ts'
import { rcon } from './rcon.ts'
import { eventStream, heartbeat, redactKeyResult } from './admin-events.ts'
import {
  consoleLogPage,
  consoleSince,
  consoleSuggestPage,
  rawCommand,
  rconTarget,
  suggestInput,
  type RconTarget,
  stripColors,
} from './console.ts'
import { parseTickQuery, readDiagnostics, redact } from './diagnostics.ts'
import { currentRooms, roomId } from './rooms.ts'
import { gateToggle } from './cp.ts'
import { readGunBalance, validateGunOverrides, type GunBalanceCatalog } from './gun-balance.ts'
import { readAiLimits, validateAiAccounts } from './ai-limits.ts'
import {
  readWorkshopAiKeyStatus,
  readWorkshopAiSettings,
  validateWorkshopAiKey,
  validateWorkshopAiSettings,
} from './workshop-ai-policy.ts'
import {
  isCustomProviderId,
  isWorkshopAiProviderId,
  workshopAiKeyStatusFile,
} from './workshop-ai.ts'
import { parseKitCatalog, validateKitChanges } from './kit-schema.ts'
import { parseStreakEntries } from './streak-table.ts'
import {
  resolveNames,
  seasons,
  statsStore,
  StatsError,
  UNKNOWN_PLAYER,
  type StatsStore,
} from './stats.ts'
import {
  BALANCE_LABELS,
  BALANCE_SCOPES,
  ARENA_MODES,
  MAP_NAMES,
  PARCOOL_IDS,
  WORKSHOP_PLACES,
} from './game-names.ts'

export const ROLES = ['builder', 'moderator', 'admin', 'owner'] as const
export type Role = (typeof ROLES)[number]
const moderator = ['view', 'map-edit', 'moderate', 'maps', 'message']
const admin = [
  ...moderator,
  'mode',
  'ban',
  'maintenance',
  'recover',
  'settings',
  'stats',
  'audit',
  'roles',
  'workshop',
  'diagnostics',
]
const PERMISSIONS: Record<Role, string[]> = {
  builder: ['view', 'map-edit'],
  moderator,
  admin,
  // Money and every Workshop AI setting are owner-only: admins below owner cannot change them.
  owner: [...admin, 'roles-admin', 'rcon-raw', 'ai'],
}
export const permissions = (role: Role | null) =>
  role && Object.hasOwn(PERMISSIONS, role) ? PERMISSIONS[role] : []
export const can = (role: Role | null, permission: string) => permissions(role).includes(permission)
export const ROLE_NAMES: Record<Role, string> = {
  builder: 'Строитель',
  moderator: 'Модератор',
  admin: 'Администратор',
  owner: 'Владелец',
}

export type Actor = { uuid: string; name: string; role: Role | null }
const noStore = { 'Cache-Control': 'no-store' }
const dir = (name: string, fallback: string) => process.env[name] || fallback
const adminDir = () => dir('BLOCKFIELD_ADMIN_DIR', '/workshop-admin')
const inboxDir = () => dir('BLOCKFIELD_INBOX_DIR', '/workshop-inbox')
const settingsDir = () => dir('BLOCKFIELD_SETTINGS_DIR', '/blockfield-admin')
const packagesDir = () => dir('BLOCKFIELD_MAP_PACKAGES_DIR', join(adminDir(), 'packages'))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const COPY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VERSION_DIGEST = /^[0-9a-f]{64}$/
const bad = (message: string) => fail(400, message)

/** Per-staff throttle on admin writes: keys are staff UUIDs only, so the map stays tiny. */
const WRITE_LIMIT = 60,
  WRITE_WINDOW = 60_000
const writeHits = new Map<string, number[]>()
function throttled(uuid: string, now = Date.now()): boolean {
  const recent = (writeHits.get(uuid) ?? []).filter((at) => now - at < WRITE_WINDOW)
  if (recent.length >= WRITE_LIMIT) {
    writeHits.set(uuid, recent)
    return true
  }
  writeHits.set(uuid, [...recent, now])
  return false
}

/** Player UUID as Drasl/Minecraft shows it, with or without dashes, to the workshop key: 32 lowercase hex digits. */
export function playerId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.replaceAll('-', '').toLowerCase() : ''
  return /^[0-9a-f]{32}$/.test(id) ? id : null
}
export function owners(env = process.env.BLOCKFIELD_OWNER_UUIDS): Set<string> {
  return new Set(
    (env ?? '')
      .split(',')
      .map(playerId)
      .filter((id): id is string => !!id),
  )
}
/** Owners come only from the environment; anyone else needs a stored grant. No env and no rows = nobody. */
export async function roleOf(
  uuid: string,
  store: StatsStore,
  ownerIds = owners(),
): Promise<Role | null> {
  if (ownerIds.has(uuid)) return 'owner'
  const role = (await store.staff()).find((s) => s.uuid === uuid)?.role
  return role === 'builder' || role === 'moderator' || role === 'admin' ? role : null
}

/** Whether `actor` may move `target` from `from` to `to` (null = no role). Throws the reason as a 403 response. */
export function checkRoleChange(
  actor: Actor,
  target: string,
  from: Role | null,
  to: Role | null,
  ownerIds = owners(),
) {
  if (!can(actor.role, 'roles')) throw fail(403, 'Недостаточно прав.')
  if (target === actor.uuid) throw fail(403, 'Свою роль менять нельзя.')
  if (ownerIds.has(target) || from === 'owner' || to === 'owner')
    throw fail(403, 'Владельцы задаются только переменной окружения сервера.')
  if ((from === 'admin' || to === 'admin') && !can(actor.role, 'roles-admin'))
    throw fail(403, 'Администраторов назначает только владелец.')
}

export function devUser(env = process.env): { uuid: string; name: string } | null {
  if (env.NODE_ENV === 'production' || !env.BLOCKFIELD_ADMIN_DEV_USER) return null
  const [uuid, name] = env.BLOCKFIELD_ADMIN_DEV_USER.split(':')
  return playerId(uuid) && nickname.test(name ?? '') ? { uuid: playerId(uuid)!, name } : null
}
async function currentActor(context: APIContext, store: StatsStore): Promise<Actor> {
  const dev = devUser()
  const who =
    dev ??
    (({ uuid, username }) => ({ uuid: playerId(uuid) ?? '', name: String(username) }))(
      account(await drasl('/user', { token: await sessionToken(context.cookies, store) })),
    )
  if ((await import('./cp.ts')).cpStaffConfigured()) {
    // CP mode: the roster read is the only role authority. A replica row may
    // linger after a direct-CP revoke, so it is never consulted for roles here.
    if (owners().has(who.uuid)) return { ...who, role: 'owner' }
    try {
      const cp = await import('./cp.ts')
      const read = await cp.readStaffGrantsCp(who.uuid)
      return {
        ...who,
        role: cp.roleFromCpMe(
          { accountId: read.accountId, owner: false, grants: read.grants },
          cp.cpScope(),
        ),
      }
    } catch (error) {
      // Unknown accounts stay unauthenticated; a CP outage fails closed.
      if (isUnknownOutcome(error)) throw cpStaffClosed()
      return { ...who, role: null }
    }
  }
  const role = who.uuid ? await roleOf(who.uuid, store) : null
  return { ...who, role }
}

/** For the site header (SSR, no client round trip): the signed-in player's name and whether `/admin` would let them in. Never throws. */
export async function siteIdentity(
  cookies: Pick<AstroCookies, 'get'>,
): Promise<{ name: string; hasAdminAccess: boolean } | null> {
  const dev = devUser()
  if (dev)
    return { name: dev.name, hasAdminAccess: (await roleOf(dev.uuid, await statsStore())) !== null }
  const value = cookies.get(session)?.value
  if (!value) return null
  try {
    const store = await statsStore()
    const { username, uuid } = account(
      await drasl('/user', { token: await sessionToken(cookies, store) }),
    )
    if (!username) return null
    const id = playerId(uuid)
    return {
      name: String(username),
      hasAdminAccess: id !== null && (await roleOf(id, store)) !== null,
    }
  } catch {
    return null
  }
}

function readText(path: string, max = 1024): string | null {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > max ? null : text
  } catch {
    return null
  }
}
export function readFile(path: string, max = 65_536): any {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    if (!fstatSync(fd).isFile()) return null
    const buffer = Buffer.alloc(max + 1),
      size = readSync(fd, buffer, 0, buffer.length, 0)
    return size > max ? null : JSON.parse(buffer.subarray(0, size).toString())
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export type MapHead = {
  schema: 1
  mapId: string
  kind: 'arena' | 'lobby' | 'limbo'
  versionDigest: string
  generation: number
  bundle: string
  activatedAt: number
  activatedBy: Record<string, unknown>
}
export type MapVersion = {
  schema: 1
  mapId: string
  kind: MapHead['kind']
  versionDigest: string
  parent: string | null
  parents?: string[]
  createdAt: number
  author: Record<string, unknown>
  source: string
  sourceId?: string | null
  note: string
  worldDigest: string
  changed: string[]
  deleted: string[]
  fileCount: number
}
export type MapBranch = {
  schema: 1
  mapId: string
  name: string
  versionDigest: string
  generation: number
  workingCopyId: string | null
  createdAt: number
  createdBy: Record<string, unknown>
}
export type MapCatalogEntry = {
  mapId: string
  kind: MapHead['kind']
  mapJson: Record<string, unknown>
  head: MapHead | null
  versions: MapVersion[]
  branches?: MapBranch[]
  draft?: { workingCopyId: string; name: string }
}
export type MapSession = {
  schema: 1
  id: string
  maps: string[] | null
  branches?: Record<string, string>
  startedAt?: number
  startedBy?: Record<string, unknown> | null
  selectionDigest?: string
}
export type MapCatalogAvailability =
  | {
      available: true
      maps: MapCatalogEntry[]
      session?: MapSession
      sessions?: MapSession[]
      sessionsTotal?: number
      sessionsNext?: number | null
    }
  | { available: false; error: string }
const mapKind = (value: unknown) => ['arena', 'lobby', 'limbo'].includes(value as string)
const digest = (value: unknown): value is string =>
  typeof value === 'string' && VERSION_DIGEST.test(value)
const timestamp = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const mapId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_]{1,32}$/.test(value)
const newMapId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z0-9][a-z0-9_]{0,31}$/.test(value) &&
  !['hub', 'lobby', 'limbo'].includes(value)
function mapTitle(value: unknown): string {
  if (typeof value !== 'string' || /[\p{Cc}§]/u.test(value))
    throw bad('Название карты: 1–100 символов без управляющих знаков.')
  const name = value.trim()
  if (![...name].length || [...name].length > 100)
    throw bad('Название карты: 1–100 символов без управляющих знаков.')
  return name
}
const arenaMode = (value: unknown): value is keyof typeof ARENA_MODES =>
  typeof value === 'string' && Object.hasOwn(ARENA_MODES, value)
const branchName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
const mutableBranch = (value: unknown): value is string => branchName(value) && value !== 'main'
const mapPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  (value === 'map.json' ||
    /^world\/(region|entities|poi)\/[rc]\.-?\d+\.-?\d+\.(mca|mcc)$/.test(value))
function resolutions(value: unknown): Record<string, 'ours' | 'theirs'> | undefined {
  if (value === undefined) return undefined
  if (
    !plain(value) ||
    Object.keys(value).length > 10_000 ||
    !Object.entries(value).every(
      ([path, choice]) =>
        path.length <= 4096 &&
        (mapPath(path) || /^map\.json#(?:\/(?:[^~]|~[01])*)*$/.test(path)) &&
        (choice === 'ours' || choice === 'theirs'),
    )
  )
    throw bad('Для каждого конфликта выберите версию main или версию на проверке.')
  return value as Record<string, 'ours' | 'theirs'>
}
function mapJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 16) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 65_536
  if (!plain(value) && !Array.isArray(value)) return false
  return (
    Object.keys(value).length <= 10_000 &&
    Object.values(value).every((child) => mapJsonSafe(child, depth + 1))
  )
}

function catalogSession(value: unknown, maps: MapCatalogEntry[]): MapSession | null {
  if (
    !plain(value) ||
    value.schema !== 1 ||
    typeof value.id !== 'string' ||
    !COPY_UUID.test(value.id) ||
    !mapJsonSafe(value) ||
    (value.startedAt !== undefined && !timestamp(value.startedAt)) ||
    (value.startedBy !== undefined && value.startedBy !== null && !plain(value.startedBy)) ||
    (value.selectionDigest !== undefined && !digest(value.selectionDigest))
  )
    return null
  const ids = maps.map((entry) => entry.mapId),
    selected = value.maps === null ? ids : value.maps
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    new Set(selected).size !== selected.length ||
    !selected.every((id) => typeof id === 'string' && ids.includes(id))
  )
    return null
  if (
    value.branches !== undefined &&
    (!plain(value.branches) ||
      Object.keys(value.branches).length !== selected.length ||
      !Object.entries(value.branches).every(
        ([id, name]) =>
          selected.includes(id) &&
          mutableBranch(name) &&
          maps
            .find((entry) => entry.mapId === id)
            ?.branches?.some((branch) => branch.name === name),
      ))
  )
    return null
  return value as MapSession
}

/** The controller catalog supplies available IDs and immutable history; static labels never invent map versions. */
export function readMapCatalog(directory: string): MapCatalogAvailability {
  const value = readFile(join(directory, 'maps.json'), 16 * 1024 * 1024)
  const unavailable: MapCatalogAvailability = {
    available: false,
    error: 'Каталог карт недоступен: контроллер не передал корректные данные.',
  }
  if (
    !plain(value) ||
    value.schema !== 1 ||
    !Array.isArray(value.maps) ||
    value.maps.length > 1024 ||
    !mapJsonSafe(value)
  )
    return unavailable
  const ids = new Set<string>()
  for (const entry of value.maps) {
    if (
      !plain(entry) ||
      !mapId(entry.mapId) ||
      ids.has(entry.mapId) ||
      !mapKind(entry.kind) ||
      !plain(entry.mapJson) ||
      entry.mapJson.id !== entry.mapId ||
      (entry.draft !== undefined &&
        (!plain(entry.draft) ||
          typeof entry.draft.workingCopyId !== 'string' ||
          !COPY_UUID.test(entry.draft.workingCopyId) ||
          typeof entry.draft.name !== 'string' ||
          !entry.draft.name.trim() ||
          [...entry.draft.name].length > 100 ||
          /[\p{Cc}§]/u.test(entry.draft.name))) ||
      (entry.mapJson.kind ?? 'arena') !== entry.kind ||
      !Array.isArray(entry.versions) ||
      entry.versions.length > 10_000
    )
      return unavailable
    ids.add(entry.mapId)
    const versions = new Set<string>()
    for (const version of entry.versions) {
      if (
        !plain(version) ||
        version.schema !== 1 ||
        version.mapId !== entry.mapId ||
        !mapKind(version.kind) ||
        !digest(version.versionDigest) ||
        versions.has(version.versionDigest) ||
        (version.parent !== null && !digest(version.parent)) ||
        !timestamp(version.createdAt) ||
        !plain(version.author) ||
        typeof version.source !== 'string' ||
        !version.source ||
        version.source.length > 128 ||
        (version.sourceId !== undefined &&
          version.sourceId !== null &&
          (typeof version.sourceId !== 'string' || version.sourceId.length > 256)) ||
        typeof version.note !== 'string' ||
        version.note.length > 4096 ||
        !digest(version.worldDigest) ||
        !Number.isSafeInteger(version.fileCount) ||
        (version.fileCount as number) < 1 ||
        (version.fileCount as number) > 10_000 ||
        Object.hasOwn(version, 'files') ||
        !['changed', 'deleted'].every(
          (key) =>
            Array.isArray(version[key]) &&
            (version[key] as unknown[]).every(
              (name) => typeof name === 'string' && name.length <= 256,
            ),
        )
      )
        return unavailable
      versions.add(version.versionDigest)
    }
    if (
      entry.versions.some(
        (version: any) =>
          (version.parent !== null &&
            (!versions.has(version.parent) || version.parent === version.versionDigest)) ||
          (version.parents !== undefined &&
            (!Array.isArray(version.parents) ||
              version.parents.length > 2 ||
              new Set(version.parents).size !== version.parents.length ||
              (version.parents[0] ?? null) !== version.parent ||
              version.parents.some(
                (parent: unknown) =>
                  !digest(parent) || !versions.has(parent) || parent === version.versionDigest,
              ))),
      )
    )
      return unavailable
    const head = entry.head as MapHead | null
    if (
      head !== null &&
      (!plain(head) ||
        head.schema !== 1 ||
        head.mapId !== entry.mapId ||
        head.kind !== entry.kind ||
        !digest(head.versionDigest) ||
        !versions.has(head.versionDigest) ||
        !Number.isSafeInteger(head.generation) ||
        (head.generation as number) < 1 ||
        typeof head.bundle !== 'string' ||
        !head.bundle ||
        head.bundle.length > 4096 ||
        !timestamp(head.activatedAt) ||
        !plain(head.activatedBy))
    )
      return unavailable
    if (entry.branches !== undefined) {
      const names = new Set<string>()
      if (!Array.isArray(entry.branches) || entry.branches.length > 1024) return unavailable
      for (const branch of entry.branches) {
        if (
          !plain(branch) ||
          branch.schema !== 1 ||
          branch.mapId !== entry.mapId ||
          !branchName(branch.name) ||
          names.has(branch.name) ||
          !digest(branch.versionDigest) ||
          !versions.has(branch.versionDigest) ||
          !Number.isSafeInteger(branch.generation) ||
          (branch.generation as number) < 1 ||
          (branch.workingCopyId !== null &&
            (typeof branch.workingCopyId !== 'string' || !COPY_UUID.test(branch.workingCopyId))) ||
          !timestamp(branch.createdAt) ||
          !plain(branch.createdBy) ||
          (branch.name === 'main' &&
            (branch.versionDigest !== head?.versionDigest ||
              branch.generation !== head?.generation))
        )
          return unavailable
        names.add(branch.name)
      }
      if (head !== null && !names.has('main')) return unavailable
    }
  }
  const maps = value.maps as MapCatalogEntry[]
  if (
    (value.sessionsTotal !== undefined &&
      (!Number.isSafeInteger(value.sessionsTotal) || (value.sessionsTotal as number) < 0)) ||
    (value.sessionsNext !== undefined &&
      value.sessionsNext !== null &&
      (!Number.isSafeInteger(value.sessionsNext) || (value.sessionsNext as number) < 0))
  )
    return unavailable
  if (
    value.sessions !== undefined &&
    (!Array.isArray(value.sessions) ||
      value.sessions.length > 1024 ||
      value.sessions.some((session) => catalogSession(session, maps) === null) ||
      new Set(value.sessions.map((session: any) => session.id)).size !== value.sessions.length ||
      (value.sessionsTotal !== undefined &&
        (value.sessionsTotal as number) < value.sessions.length) ||
      (typeof value.sessionsNext === 'number' &&
        (value.sessionsNext < value.sessions.length ||
          (typeof value.sessionsTotal === 'number' && value.sessionsNext > value.sessionsTotal))))
  )
    return unavailable
  const session = catalogSession(readFile(join(directory, 'session.json')), maps),
    status = readFile(join(directory, 'status.json'))
  const verified =
    session !== null &&
    plain(status) &&
    status.schema === 1 &&
    // Asleep the editor is saved and stopped, and the controller commits its copy from disk.
    ((status.phase === 'workshop' && status.gate === 'builders') || status.phase === 'sleeping') &&
    plain(status.desired) &&
    status.desired.profile === 'workshop' &&
    status.desired.session === session.id
  return {
    available: true,
    maps,
    ...(verified ? { session: session as MapSession } : {}),
    ...(value.sessions === undefined ? {} : { sessions: value.sessions as MapSession[] }),
    ...(value.sessionsTotal === undefined ? {} : { sessionsTotal: value.sessionsTotal as number }),
    ...(value.sessionsNext === undefined
      ? {}
      : { sessionsNext: value.sessionsNext as number | null }),
  }
}
function requiredMapCatalog() {
  const catalog = readMapCatalog(adminDir())
  if (catalog.available === false) throw fail(503, catalog.error)
  return catalog
}
function existingCandidate(id: unknown) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw bad('Неверный ID кандидата.')
  const candidates = readFile(join(adminDir(), 'candidates.json'), 16 * 1024 * 1024)
  if (!plain(candidates) || candidates.schema !== 1 || !Array.isArray(candidates.candidates))
    throw fail(503, 'Каталог кандидатов недоступен.')
  const candidate = candidates.candidates.find((value: any) => plain(value) && value.id === id)
  if (!candidate || !mapId(candidate.mapId)) throw fail(404, 'Кандидат не найден.')
  return candidate
}
function expectedMapHead(body: any, entry: MapCatalogEntry) {
  if (
    !plain(body) ||
    !Object.hasOwn(body, 'expectedHead') ||
    (body.expectedHead !== null && !digest(body.expectedHead))
  )
    throw bad('Укажите текущую версию карты или null, если она ещё не опубликована.')
  if (body.expectedHead !== (entry.head?.versionDigest ?? null))
    throw fail(409, 'Версия карты уже изменилась. Обновите историю.')
  return body.expectedHead as string | null
}
function editorRevision(body: any) {
  const status = readFile(join(adminDir(), 'status.json'))
  if (status?.schema !== 1 || !Number.isSafeInteger(status.revision) || status.revision < 0)
    throw fail(503, 'Состояние мастерской недоступно. Обновите страницу.')
  if (status.phase !== 'workshop' || status.gate !== 'builders')
    throw fail(409, 'Дождитесь открытия мастерской перед изменением карты.')
  if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 0)
    throw bad('Нет ревизии состояния: обновите страницу.')
  if (body.expectedRevision !== status.revision)
    throw fail(409, 'Состояние мастерской изменилось. Обновите страницу.')
}
async function editableMapIds(
  actor: Actor,
  store: StatsStore,
  catalog: MapCatalogAvailability,
): Promise<string[]> {
  if (!catalog.available || !can(actor.role, 'map-edit')) return []
  const ids = catalog.maps.map((entry) => entry.mapId)
  if (actor.role !== 'builder') return ids
  // The replica is only a names/maps book: match by uuid alone (any role).
  // The caller already checked the CP-derived actor role above.
  const grant = (await store.staff()).find((row) => row.uuid === actor.uuid)
  return grant ? ids.filter((id) => grant.maps == null || grant.maps.includes(id)) : []
}
async function editableMap(actor: Actor, store: StatsStore, id: unknown) {
  const catalog = requiredMapCatalog(),
    entry = catalog.maps.find((map) => map.mapId === id)
  if (!entry) throw bad('Неизвестная карта.')
  if (!(await editableMapIds(actor, store, catalog)).includes(entry.mapId))
    throw fail(403, 'Нет права строить на этой карте.')
  return { catalog, entry }
}
function selectedMapBranch(
  catalog: Extract<MapCatalogAvailability, { available: true }>,
  entry: MapCatalogEntry,
) {
  const copy = catalog.session,
    name = copy?.branches?.[entry.mapId]
  const branch = entry.branches?.find((ref) => ref.name === name)
  if (
    !copy ||
    !(copy.maps === null || copy.maps.includes(entry.mapId)) ||
    !branch ||
    !mutableBranch(name)
  )
    throw fail(409, 'Выберите ветку этой карты в действующем сеансе мастерской.')
  return { copy, branch }
}
function workshopMapIds() {
  const catalog = readMapCatalog(adminDir())
  return catalog.available ? new Set(['hub', ...catalog.maps.map((entry) => entry.mapId)]) : MAP_IDS
}
/** Readers (controller, game server) must never see a half-written file: write a dot-file in the same directory, then rename. */
export function writeAtomic(directory: string, name: string, value: unknown, mode?: number) {
  const contents = JSON.stringify(value, null, 2) + '\n'
  if (name === 'settings.json' && Buffer.byteLength(contents) > 1_048_576)
    throw fail(413, 'Настройки превышают доступный размер. Уменьшите наборы перед сохранением.')
  const temp = join(directory, `.${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, contents, { flag: 'wx', mode })
    renameSync(temp, join(directory, name))
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // A failed rename may leave no temporary file to remove.
    }
    throw error
  }
}

// Workshop access scopes, not only maps: `hub` gates building in the workshop hub.
export const MAP_IDS = new Set(Object.keys(WORKSHOP_PLACES))
/** One builder's list after granting (`allowed`) or taking away one map; null stays null when granting, and a new map is never silently implied. */
export function withMapAccess(
  maps: string[] | null,
  mapId: string,
  allowed: boolean,
  knownMaps = MAP_IDS,
): string[] | null {
  if (allowed) return maps === null || maps.includes(mapId) ? maps : [...maps, mapId]
  return (maps ?? [...knownMaps]).filter((id) => id !== mapId)
}
// Staff map edits are read-modify-write across awaits: a tablet grant and a web grant for one
// builder can read the same snapshot, and the second write then loses the first grant.
// Every such edit queues on one chain per process instead.
let staffMapsQueue: Promise<unknown> = Promise.resolve()
function withStaffMapsLock<T>(work: () => Promise<T>): Promise<T> {
  const next = staffMapsQueue.then(work, work)
  staffMapsQueue = next.then(
    () => {},
    () => {},
  )
  return next
}
export type WorkshopMember = {
  draslId: string
  name: string
  role: 'admin' | 'lead' | 'builder'
  maps?: string[]
}
const WORKSHOP_ROLE: Record<Role, WorkshopMember['role']> = {
  owner: 'admin',
  admin: 'admin',
  moderator: 'lead',
  builder: 'builder',
}
/** `lead`/`admin` always have every map; only a `builder` row's `maps` (null = every map) is carried over. */
export function workshopMembers(
  staff: { uuid: string; name: string; role: string; maps?: string[] | null }[],
  ownerNames: Map<string, string>,
): WorkshopMember[] {
  const members = new Map<string, WorkshopMember>()
  for (const s of staff)
    if (s.role in WORKSHOP_ROLE) {
      const role = WORKSHOP_ROLE[s.role as Role]
      members.set(s.uuid, {
        draslId: s.uuid,
        name: s.name,
        role,
        ...(role === 'builder' && s.maps != null ? { maps: s.maps } : {}),
      })
    }
  for (const [uuid, name] of ownerNames) members.set(uuid, { draslId: uuid, name, role: 'admin' })
  return [...members.values()].sort((a, b) => a.draslId.localeCompare(b.draslId))
}

/** Validates a UI request and writes it to the controller inbox. Returns the request id. */
export function writeRequest(
  directory: string,
  actor: Actor,
  body: any,
  knownMaps = new Set(Object.keys(MAP_NAMES)),
): string {
  const base = {
    schema: 1,
    id: randomUUID(),
    kind: body?.kind,
    actor: { draslId: actor.uuid, name: actor.name },
    createdAt: Date.now(),
  }
  let request: Record<string, unknown>
  if (body?.kind === 'mode') {
    if (!['game', 'workshop', 'test'].includes(body.profile))
      throw bad('Режим: game, workshop или test.')
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)
      throw bad('Нет ревизии состояния: обновите страницу.')
    if (body.recover !== undefined && typeof body.recover !== 'boolean')
      throw bad('Некорректный запрос.')
    if (body.recover && body.profile !== 'game')
      throw bad('Для восстановления мастерской используйте запрос game.')
    if (body.recover && !can(actor.role, 'recover'))
      throw fail(403, 'Восстановление доступно администратору.')
    let extra: Record<string, unknown> = {}
    if (body.profile === 'workshop') {
      if (body.session !== 'new' && body.session !== 'resume')
        throw bad('Сеанс мастерской: new или resume.')
      if (body.session === 'new') {
        const maps = body.maps
        if (
          maps !== null &&
          (!Array.isArray(maps) ||
            !maps.length ||
            new Set(maps).size !== maps.length ||
            !maps.every(
              (id: unknown) => typeof id === 'string' && (knownMaps.has(id) || id === 'hub'),
            ))
        )
          throw bad('Некорректный список карт.')
        extra = { session: 'new', maps }
        if (body.branches !== undefined) {
          if (
            !Array.isArray(maps) ||
            !plain(body.branches) ||
            Object.keys(body.branches).length !== maps.length ||
            !Object.entries(body.branches).every(
              ([id, name]) => maps.includes(id) && mutableBranch(name),
            )
          )
            throw bad('Выберите одну рабочую ветку для каждой карты сеанса.')
          extra.branches = body.branches
        }
      } else {
        if (
          body.sessionId !== undefined &&
          (typeof body.sessionId !== 'string' || !COPY_UUID.test(body.sessionId))
        )
          throw bad('Выберите сохранённый черновик мастерской.')
        extra = {
          session: 'resume',
          ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        }
      } // resume keeps its stored maps/branches; a client-sent selection is never forwarded.
    } else if (body.profile === 'test') {
      if (typeof body.candidateId !== 'string' || !/^[0-9a-f]{32}$/.test(body.candidateId))
        throw bad('Неизвестная версия карты.')
      extra = { candidateId: body.candidateId }
      if (body.modeId !== undefined) {
        if (!arenaMode(body.modeId)) throw bad('Выберите поддерживаемый режим теста.')
        extra.modeId = body.modeId
      }
    }
    request = {
      ...base,
      profile: body.profile,
      expectedRevision: body.expectedRevision,
      ...(body.recover ? { recover: true } : {}),
      ...extra,
    }
  } else if (body?.kind === 'map-create' || body?.kind === 'map-properties') {
    if (!can(actor.role, 'maps')) throw fail(403, 'Создание и название карты доступны модератору.')
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)
      throw bad('Нет ревизии состояния: обновите страницу.')
    const name = mapTitle(body.name)
    if (body.kind === 'map-create') {
      if (!newMapId(body.mapId))
        throw bad(
          'ID карты: до 32 строчных латинских букв, цифр и подчёркиваний; первый знак — буква или цифра.',
        )
      if (
        !Array.isArray(body.supportedModes) ||
        !body.supportedModes.length ||
        body.supportedModes.length > 7 ||
        new Set(body.supportedModes).size !== body.supportedModes.length ||
        !body.supportedModes.every(arenaMode)
      )
        throw bad('Выберите хотя бы один поддерживаемый режим карты.')
      request = {
        ...base,
        mapId: body.mapId,
        name,
        supportedModes: body.supportedModes,
        expectedRevision: body.expectedRevision,
        sessionId: randomUUID(),
      }
    } else {
      if (
        !mapId(body.mapId) ||
        !knownMaps.has(body.mapId) ||
        typeof body.workingCopyId !== 'string' ||
        !COPY_UUID.test(body.workingCopyId)
      )
        throw bad('Выберите рабочую копию карты для изменения названия.')
      request = {
        ...base,
        mapId: body.mapId,
        name,
        workingCopyId: body.workingCopyId,
        expectedRevision: body.expectedRevision,
      }
    }
  } else if (body?.kind === 'message') {
    // Same rule as the controller: strip control characters (Unicode Cc) and §, keep format characters such as ZWJ.
    const message =
      typeof body.message === 'string' ? body.message.replace(/[\p{Cc}§]/gu, '').trim() : null
    if (message === null || [...message].length > 200) throw bad('Сообщение: до 200 символов.')
    request = { ...base, message }
  } else if (body?.kind === 'cancel') {
    request = { ...base }
  } else if (body?.kind === 'wake') {
    // Waking a sleeping Workshop carries no parameters: the controller starts the stored goal.
    request = { ...base }
  } else if (body?.kind === 'members') {
    // `maps` absent/null: every map, including ones added later. `maps: []`: no map (the builder still gets a workshop account, just nothing to edit).
    const validMaps = (m: any) =>
      m.maps === undefined ||
      (Array.isArray(m.maps) &&
        new Set(m.maps).size === m.maps.length &&
        m.maps.every(
          (id: unknown) => typeof id === 'string' && (knownMaps.has(id) || id === 'hub'),
        ))
    const valid =
      Array.isArray(body.members) &&
      body.members.every(
        (m: any) =>
          playerId(m?.draslId) === m.draslId &&
          nickname.test(m.name) &&
          ['admin', 'lead', 'builder'].includes(m.role) &&
          validMaps(m),
      )
    if (!valid) throw bad('Некорректный список участников.')
    request = {
      ...base,
      members: body.members.map(({ draslId, name, role, maps }: WorkshopMember) => ({
        draslId,
        name,
        role,
        ...(maps ? { maps } : {}),
      })),
    }
  } else if (body?.kind === 'limbo-export') {
    if (!digest(body.versionDigest)) throw bad('Неизвестная версия лобби прокси.')
    request = { ...base, versionDigest: body.versionDigest }
  } else if (body?.kind === 'sessions') {
    if (
      !Number.isSafeInteger(body.offset) ||
      body.offset < 0 ||
      body.offset > 1_000_000 ||
      (body.limit !== undefined &&
        (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 100))
    )
      throw bad('Некорректная страница сохранённых черновиков.')
    request = { ...base, offset: body.offset, limit: body.limit ?? 100 }
  } else if (['branch-create', 'commit', 'compare', 'merge-preview'].includes(body?.kind)) {
    if (!mapId(body.mapId) || !knownMaps.has(body.mapId)) throw bad('Неизвестная карта.')
    const common = { ...base, mapId: body.mapId }
    if (body.kind === 'branch-create') {
      if (!mutableBranch(body.branch) || !digest(body.versionDigest))
        throw bad('Укажите имя рабочей ветки и сохранённую версию.')
      request = { ...common, branch: body.branch, versionDigest: body.versionDigest }
    } else if (body.kind === 'commit') {
      if (
        !mutableBranch(body.branch) ||
        typeof body.workingCopyId !== 'string' ||
        !COPY_UUID.test(body.workingCopyId) ||
        !digest(body.expectedBranchHead) ||
        typeof body.note !== 'string' ||
        !body.note.trim() ||
        body.note.length > 200
      )
        throw bad(
          'Коммит требует выбранную ветку, рабочую копию, её текущую версию и описание изменений до 200 символов.',
        )
      request = {
        ...common,
        branch: body.branch,
        workingCopyId: body.workingCopyId,
        expectedBranchHead: body.expectedBranchHead,
        note: body.note.trim(),
      }
    } else if (body.kind === 'compare') {
      if (!digest(body.before) || !digest(body.after))
        throw bad('Выберите две сохранённые версии карты.')
      request = { ...common, before: body.before, after: body.after }
    } else {
      if (
        !digest(body.versionDigest) ||
        !Object.hasOwn(body, 'expectedHead') ||
        (body.expectedHead !== null && !digest(body.expectedHead))
      )
        throw bad('Слияние требует исходную версию и текущую main.')
      request = {
        ...common,
        versionDigest: body.versionDigest,
        expectedHead: body.expectedHead,
        ...(body.resolutions === undefined ? {} : { resolutions: resolutions(body.resolutions) }),
      }
    }
  } else if (body?.kind === 'candidate' || body?.kind === 'rollback') {
    if (typeof body.mapId !== 'string' || !knownMaps.has(body.mapId))
      throw bad('Неизвестная карта.')
    if (body.kind === 'candidate') {
      if (
        body.workingCopyId !== undefined &&
        (typeof body.workingCopyId !== 'string' || !COPY_UUID.test(body.workingCopyId))
      )
        throw bad('Неверная рабочая копия карты.')
      request = {
        ...base,
        mapId: body.mapId,
        ...(body.workingCopyId === undefined ? {} : { workingCopyId: body.workingCopyId }),
      }
      if (body.branch !== undefined || body.expectedBranchHead !== undefined) {
        if (
          !mutableBranch(body.branch) ||
          !digest(body.expectedBranchHead) ||
          typeof body.workingCopyId !== 'string'
        )
          throw bad('Проверка требует выбранную ветку, её текущую версию и рабочую копию.')
        Object.assign(request, { branch: body.branch, expectedBranchHead: body.expectedBranchHead })
      }
      if (body.commit !== undefined && typeof body.commit !== 'boolean')
        throw bad('Некорректный запрос сохранения перед проверкой.')
      if (body.commit === true) {
        if (
          body.branch === undefined ||
          typeof body.note !== 'string' ||
          !body.note.trim() ||
          body.note.length > 200 ||
          /\p{Cc}/u.test(body.note)
        )
          throw bad(
            'Сохранение перед проверкой требует ветку и описание изменений до 200 символов.',
          )
        Object.assign(request, { commit: true, note: body.note.trim() })
      }
    } else {
      if (
        !digest(body.versionDigest) ||
        !Object.hasOwn(body, 'expectedHead') ||
        (body.expectedHead !== null && !digest(body.expectedHead))
      )
        throw bad('Откат требует выбранную версию и текущую вершину истории.')
      request = {
        ...base,
        mapId: body.mapId,
        versionDigest: body.versionDigest,
        expectedHead: body.expectedHead,
      }
    }
  } else if (body?.kind === 'publish' || body?.kind === 'reject' || body?.kind === 'export') {
    if (typeof body.candidateId !== 'string' || !/^[0-9a-f]{32}$/.test(body.candidateId))
      throw bad('Неизвестная версия карты.')
    if (body.kind === 'publish' && body.force !== undefined && typeof body.force !== 'boolean')
      throw bad('Некорректный запрос.')
    if (
      body.kind === 'publish' &&
      Object.hasOwn(body, 'expectedHead') &&
      body.expectedHead !== null &&
      !digest(body.expectedHead)
    )
      throw bad('Неверная текущая версия карты.')
    request = {
      ...base,
      candidateId: body.candidateId,
      ...(body.kind === 'publish' && body.force ? { force: true } : {}),
      ...(body.kind === 'publish' && Object.hasOwn(body, 'expectedHead')
        ? { expectedHead: body.expectedHead }
        : {}),
      ...(body.kind === 'publish' && body.resolutions !== undefined
        ? { resolutions: resolutions(body.resolutions) }
        : {}),
    }
  } else if (body?.kind === 'ai-key' || body?.kind === 'ai-gateway-key') {
    // Keys are write-only: they travel to the controller inbox and never
    // land in settings, the DB, logs or responses. Validation errors never echo them.
    if (!plain(body) || !Object.hasOwn(body, 'key')) throw bad('Укажите ключ или его удаление.')
    request = { ...base, kind: body.kind, key: validateWorkshopAiKey(body.key) }
  } else if (body?.kind === 'ai-provider-key') {
    // Custom registry provider key: the provider id travels alongside (nonsecret),
    // the value itself never lands in settings, the DB, logs or responses.
    // Only genuine custom ids pass: preset and colliding ids keep their own endpoints.
    if (!plain(body) || !Object.hasOwn(body, 'key')) throw bad('Укажите ключ или его удаление.')
    if (!isCustomProviderId(body.provider)) throw bad('Некорректный провайдер.')
    request = {
      ...base,
      kind: body.kind,
      provider: body.provider,
      key: validateWorkshopAiKey(body.key),
    }
  } else throw bad('Неизвестный тип запроса.')
  // The site and the controller's reader share UID 1000; a key request is readable by them only.
  const keyKinds = ['ai-key', 'ai-gateway-key', 'ai-provider-key']
  writeAtomic(
    directory,
    `${base.id}.json`,
    request,
    keyKinds.includes(request.kind as string) ? 0o600 : undefined,
  )
  return base.id
}

/**
 * A `wake` request already waiting in the inbox: its id, so callers reuse it instead of
 * queueing another. Answered (a result file exists) and malformed files do not count.
 */
export function pendingWakeId(inboxDirectory: string, resultsDirectory: string): string | null {
  let names: string[]
  try {
    names = readdirSync(inboxDirectory)
  } catch {
    return null
  }
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    const id = name.slice(0, -'.json'.length)
    const request = readFile(join(inboxDirectory, name), 4096)
    if (!request || request.schema !== 1 || request.kind !== 'wake' || request.id !== id) continue
    if (readFile(join(resultsDirectory, `${id}.json`)) !== null) continue
    return id
  }
  return null
}

const range = (min: number, max: number) => (v: unknown) =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const LOBBY: Record<string, (v: unknown) => boolean> = {
  pvpEnabled: (v) => typeof v === 'boolean',
  pvpCooldownSeconds: range(0, 600),
}
const ROOMS: Record<string, (v: unknown) => boolean> = {
  maxRooms: range(1, 16),
  idleCloseSeconds: range(30, 3600),
  abandonCloseSeconds: range(5, 600),
}
/** Must match the mod's DeathmatchMode: at least 1 player (owner can start alone), arenas are small so 24 is a generous ceiling. */
const DEATHMATCH: Record<string, (v: unknown) => boolean> = { minPlayers: range(1, 24) }
/** Must match the mod's campaign balance parser: type and inclusive range per key. */
export const BALANCE: Record<
  string,
  { type: 'int' | 'double' | 'bool'; min?: number; max?: number }
> = {
  max_tickets: { type: 'int', min: 1, max: 100_000 },
  ticket_bleed_multiplier: { type: 'int', min: 0, max: 100 },
  ticket_bleed_timer_seconds: { type: 'int', min: 1, max: 600 },
  death_ticket_cost: { type: 'int', min: 0, max: 1000 },
  capture_speed_percent_per_tick: { type: 'int', min: 1, max: 100 },
  uncapture_speed_percent_per_tick: { type: 'int', min: 1, max: 100 },
  score_per_kill: { type: 'int', min: 0, max: 10_000 },
  score_per_obj_sec: { type: 'double', min: 0, max: 1000 },
  score_per_capture: { type: 'int', min: 0, max: 10_000 },
  score_per_uncapture: { type: 'int', min: 0, max: 10_000 },
  preparation_time_seconds: { type: 'int', min: 0, max: 600 },
  transition_time_seconds: { type: 'int', min: 0, max: 600 },
  enable_spawn_shield: { type: 'bool' },
  spawn_shield_duration_seconds: { type: 'int', min: 0, max: 60 },
  safe_spawn_threshold: { type: 'int', min: 0, max: 100 },
  base_warn_radius: { type: 'double', min: 0, max: 1000 },
  base_kill_radius: { type: 'double', min: 0, max: 1000 },
  max_players_per_team: { type: 'int', min: 1, max: 64 },
  min_players_per_team: { type: 'int', min: 1, max: 64 },
  base_spawn_time_seconds: { type: 'int', min: 0, max: 300 },
  spawn_time_per_point_seconds: { type: 'int', min: 0, max: 300 },
  shuffle_teams_between_rounds: { type: 'bool' },
  ready_countdown_seconds: { type: 'int', min: 0, max: 300 },
  reserve_seconds: { type: 'int', min: 0, max: 3600 },
  ready_timeout_seconds: { type: 'int', min: 10, max: 3600 },
}
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
function section(value: unknown, rules: Record<string, (v: unknown) => boolean>, name: string) {
  if (
    !plain(value) ||
    !Object.entries(value).every(([k, v]) => Object.hasOwn(rules, k) && rules[k](v))
  )
    throw bad(`Настройки: неверный раздел «${name}».`)
  return value
}
/** Present sections replace stored ones; saveSettings preserves gunBalance when the general form omits it. */
export function validateSettings(body: any, catalog?: GunBalanceCatalog) {
  if (
    !plain(body) ||
    Object.keys(body).some(
      (k) =>
        ![
          'expectedRevision',
          'cpRevisions',
          'lobby',
          'rooms',
          'deathmatch',
          'classLocks',
          'classCosts',
          'campaignBalance',
          'parcool',
          'gunBalance',
        ].includes(k),
    )
  )
    throw bad('Некорректные настройки.')
  const out: Record<string, unknown> = {}
  if (body.lobby !== undefined) out.lobby = section(body.lobby, LOBBY, 'лобби')
  if (body.rooms !== undefined) out.rooms = section(body.rooms, ROOMS, 'комнаты')
  if (body.deathmatch !== undefined) {
    // streakRewards is a validated table, not a number: split it off before the numeric check.
    if (!plain(body.deathmatch)) throw bad('Настройки: неверный раздел «каждый сам за себя».')
    const { streakRewards, ...numbers } = body.deathmatch
    const deathmatch = section(numbers, DEATHMATCH, 'каждый сам за себя')
    if (streakRewards !== undefined) {
      try {
        ;(deathmatch as Record<string, unknown>).streakRewards = parseStreakEntries(streakRewards)
      } catch (error) {
        throw bad(`Настройки: ${(error as Error).message}`)
      }
    }
    out.deathmatch = deathmatch
  }
  if (body.classCosts !== undefined) {
    out.classCosts = section(
      body.classCosts,
      Object.fromEntries(
        ['tech', 'sniper', 'drone'].map((id) => [
          id,
          (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10_000,
        ]),
      ),
      'стоимость классов',
    )
  }
  if (body.classLocks !== undefined) {
    const list = body.classLocks
    if (
      !Array.isArray(list) ||
      list.length > 64 ||
      new Set(list).size !== list.length ||
      !list.every((c: unknown) => typeof c === 'string' && /^[a-z0-9_]{1,32}$/.test(c))
    )
      throw bad('Настройки: неверный список закрытых классов.')
    out.classLocks = list
  }
  if (body.campaignBalance !== undefined) {
    const balance = body.campaignBalance,
      rules = Object.fromEntries(
        Object.entries(BALANCE).map(([k, r]) => [
          k,
          (v: unknown) =>
            r.type === 'bool'
              ? typeof v === 'boolean'
              : typeof v === 'number' &&
                Number.isFinite(v) &&
                (r.type === 'double' || Number.isSafeInteger(v)) &&
                v >= r.min! &&
                v <= r.max!,
        ]),
      )
    if (
      !plain(balance) ||
      Object.keys(balance).length > 64 ||
      !Object.keys(balance).every((k) => k === '*' || /^[A-Za-z0-9_-]{1,32}$/.test(k))
    )
      throw bad('Настройки: неверные кампании в балансе.')
    for (const [campaign, values] of Object.entries(balance)) {
      section(values, rules, `баланс ${campaign}`)
      // The mod applies "*" first, then the campaign's own section.
      const merged: any = { ...(balance['*'] as object), ...(values as object) }
      const scope = BALANCE_SCOPES.find((s) => s.id === campaign)?.name ?? 'Другая кампания'
      if (merged.min_players_per_team > merged.max_players_per_team)
        throw bad(
          `${scope}: «${BALANCE_LABELS.min_players_per_team}» больше, чем «${BALANCE_LABELS.max_players_per_team}».`,
        )
      if (merged.base_kill_radius > merged.base_warn_radius)
        throw bad(
          `${scope}: «${BALANCE_LABELS.base_kill_radius}» больше, чем «${BALANCE_LABELS.base_warn_radius}».`,
        )
    }
    out.campaignBalance = balance
  }
  if (body.parcool !== undefined) {
    const value = body.parcool,
      list = plain(value) ? value.allowedActions : undefined
    if (
      !plain(value) ||
      Object.keys(value).some((k) => k !== 'allowedActions') ||
      !Array.isArray(list) ||
      new Set(list).size !== list.length ||
      !list.every((a: unknown) => typeof a === 'string' && PARCOOL_IDS.has(a))
    )
      throw bad('Настройки: неверный список действий паркура.')
    out.parcool = { allowedActions: list }
  }
  if (Object.hasOwn(body, 'gunBalance')) {
    if (!catalog) throw fail(503, 'Каталог баланса оружия недоступен.')
    out.gunBalance = validateGunOverrides(body.gunBalance, catalog)
  }
  return out
}
export function readSettings(directory: string) {
  return {
    settings: readFile(join(directory, 'settings.json'), 1_048_576) ?? { schema: 1, revision: 0 },
    applied: readFile(join(directory, 'applied.json')),
  }
}
function storedSettings(directory: string) {
  const path = join(directory, 'settings.json'),
    stored = readFile(path, 1_048_576)
  if (stored !== null) return stored
  try {
    statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, revision: 0 }
  }
  throw fail(503, 'Текущие настройки повреждены. Сохранение недоступно.')
}
const disabledMapId = (value: unknown) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)
const disabledMapList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 4096 &&
  new Set(value).size === value.length &&
  value.every(disabledMapId)
function mapAvailability(directory: string) {
  let settings
  try {
    settings = storedSettings(directory)
  } catch {
    return { available: false as const, error: 'Состояние доступности карт повреждено.' }
  }
  const ids = settings.disabledMapIds ?? [],
    rawApplied = readSettings(directory).applied
  if (
    settings.schema !== 1 ||
    !Number.isSafeInteger(settings.revision) ||
    settings.revision < 0 ||
    !disabledMapList(ids)
  )
    return { available: false as const, error: 'Состояние доступности карт повреждено.' }
  const applied =
    rawApplied &&
    Number.isSafeInteger(rawApplied.revision) &&
    rawApplied.revision >= 0 &&
    disabledMapList(rawApplied.disabledMapIds) &&
    (rawApplied.errors === undefined ||
      (Array.isArray(rawApplied.errors) &&
        rawApplied.errors.length <= 256 &&
        rawApplied.errors.every((error: unknown) => typeof error === 'string')))
      ? {
          revision: rawApplied.revision,
          attemptedRevision: rawApplied.attemptedRevision,
          errors: rawApplied.errors ?? [],
          disabledMapIds: rawApplied.disabledMapIds,
        }
      : null
  return { available: true as const, revision: settings.revision, disabledMapIds: ids, applied }
}
export function saveMapAvailability(directory: string, body: any, actorName: string) {
  if (
    !plain(body) ||
    Object.keys(body).some((key) => !['mapId', 'enabled', 'expectedRevision'].includes(key)) ||
    typeof body.enabled !== 'boolean' ||
    !mapId(body.mapId)
  )
    throw bad('Укажите карту и её доступность для новых матчей.')
  const availability = mapAvailability(directory)
  if (!availability.available) throw fail(503, availability.error)
  if (body.expectedRevision !== availability.revision)
    throw fail(409, 'Настройки уже изменил кто-то другой. Обновите историю; черновики сохранены.')
  const current = readSettings(directory).settings,
    disabled = new Set(availability.disabledMapIds)
  if (body.enabled) disabled.delete(body.mapId)
  else disabled.add(body.mapId)
  if (disabled.size > 4096) throw bad('Слишком много отключённых карт.')
  const settings = {
    ...current,
    disabledMapIds: [...disabled].sort(),
    schema: 1,
    revision: availability.revision + 1,
    updatedAt: Date.now(),
    updatedBy: actorName,
  }
  writeAtomic(directory, 'settings.json', settings)
  return settings
}
function readKits(directory: string) {
  try {
    return {
      available: true as const,
      catalog: parseKitCatalog(readFile(join(directory, 'kits.json'), 8 * 1024 * 1024)),
    }
  } catch {
    return {
      available: false as const,
      error: 'Каталог наборов недоступен. Дождитесь данных игрового сервера.',
    }
  }
}
export function saveKitSettings(directory: string, body: any, actorName: string) {
  if (
    !plain(body) ||
    Object.keys(body).some(
      (key) => !['expectedRevision', 'cpRevisions', 'kits', 'fixedModeKits'].includes(key),
    )
  )
    throw bad('Некорректные настройки наборов.')
  const current = storedSettings(directory)
  if (current.schema !== 1 || !Number.isSafeInteger(current.revision) || current.revision < 0)
    throw fail(503, 'Текущие настройки повреждены. Сохранение недоступно.')
  if (body.expectedRevision !== current.revision)
    throw fail(409, 'Настройки уже изменил кто-то другой. Обновите страницу.')
  const availability = readKits(directory)
  if (!availability.available) throw fail(503, availability.error)
  let changes: ReturnType<typeof validateKitChanges>
  try {
    changes = validateKitChanges(
      body.kits,
      body.fixedModeKits,
      availability.catalog,
      current.classCosts ?? {},
    )
  } catch (error) {
    throw bad((error as Error).message)
  }
  const settings = {
    ...current,
    ...changes,
    schema: 1,
    revision: current.revision + 1,
    updatedAt: Date.now(),
    updatedBy: actorName,
  }
  writeAtomic(directory, 'settings.json', settings)
  return settings
}
export function saveSettings(
  directory: string,
  body: any,
  actorName: string,
  gunBalanceOnly = false,
) {
  if (!plain(body)) throw bad('Некорректные настройки.')
  const current = readSettings(directory).settings
  const revision = Number.isSafeInteger(current?.revision) ? current.revision : 0
  // ponytail: the read-compare-rename is synchronous, so it is atomic within this single site process; a second writer to the directory would need a lock file.
  if (body.expectedRevision !== revision)
    throw fail(409, 'Настройки уже изменил кто-то другой. Обновите страницу.')
  const editingGuns = gunBalanceOnly || Object.hasOwn(body, 'gunBalance')
  const availability = editingGuns ? readGunBalance(directory) : null
  if (editingGuns && !availability?.available) throw fail(503, 'Каталог баланса оружия недоступен.')
  const catalog = availability?.available ? availability.catalog : undefined
  let values: Record<string, unknown>
  if (gunBalanceOnly) {
    if (
      Object.keys(body).some(
        (key) => !['expectedRevision', 'cpRevisions', 'gunBalance'].includes(key),
      )
    )
      throw bad('Некорректные настройки оружия.')
    values = {
      ...current,
      gunBalance: validateGunOverrides(
        Object.hasOwn(body, 'gunBalance') ? body.gunBalance : {},
        catalog!,
      ),
    }
  } else {
    values = validateSettings(body, catalog)
    for (const key of ['gunBalance', 'kits', 'fixedModeKits', 'disabledMapIds'])
      if (!Object.hasOwn(body, key) && Object.hasOwn(current, key)) values[key] = current[key]
  }
  if (editingGuns && Object.keys(values.gunBalance as object).length === 0) delete values.gunBalance
  const settings = {
    ...values,
    schema: 1,
    revision: revision + 1,
    updatedAt: Date.now(),
    updatedBy: actorName,
  }
  writeAtomic(directory, 'settings.json', settings)
  return settings
}

export function saveAiLimits(directory: string, body: any) {
  if (
    !plain(body) ||
    Object.keys(body).some(
      (key) => !['expectedRevision', 'cpRevisions', 'mode', 'sessions', 'builders'].includes(key),
    ) ||
    (body.mode !== 'session' && body.mode !== 'builder')
  )
    throw bad('Бюджет AI: некорректные настройки.')
  const current = readAiLimits(directory)
  if (body.expectedRevision !== current.revision)
    throw fail(409, 'Бюджет AI уже изменил кто-то другой. Обновите состояние; черновик сохранён.')
  if (current.revision === Number.MAX_SAFE_INTEGER)
    throw fail(503, 'Ревизия бюджета AI исчерпана. Сохранение отключено.')
  const policy = {
    ...current,
    revision: current.revision + 1,
    mode: body.mode,
    sessions: Object.hasOwn(body, 'sessions')
      ? validateAiAccounts(body.sessions)
      : current.sessions,
    builders: Object.hasOwn(body, 'builders')
      ? validateAiAccounts(body.builders)
      : current.builders,
  }
  writeAtomic(directory, 'ai-limits.json', policy)
  return policy
}

export function saveWorkshopAiSettings(
  directory: string,
  body: any,
  hasKey: (provider: string) => boolean,
) {
  if (
    !plain(body) ||
    Object.keys(body).some(
      (key) =>
        ![
          'expectedRevision',
          'cpRevisions',
          'enabled',
          'provider',
          'generationProvider',
          // Retired guard-model keys (ws#53): an admin tab opened before the update still
          // sends them; accepted and dropped.
          'guardProvider',
          'transcriptionProvider',
          'providers',
          'generationModel',
          'guardModel',
          'transcriptionModel',
          'cleanupModel',
          'cleanupProvider',
          'maxBlocks',
          'blocksPerTick',
          'minimumBuildTicks',
          'applyBudgetMs',
          'hourlyRequestLimit',
          'hourlyPlayerRequestLimit',
          'maxHourlyBuilders',
          'generationMaxPricePromptUsdPerM',
          'generationMaxPriceCompletionUsdPerM',
          'inputGuardEnabled',
        ].includes(key),
    )
  )
    throw bad('AI мастерской: некорректные настройки.')
  const current = readWorkshopAiSettings(directory)
  if (body.expectedRevision !== current.revision)
    throw fail(409, 'Настройки AI мастерской уже изменил кто-то другой. Обновите страницу.')
  if (current.revision === Number.MAX_SAFE_INTEGER)
    throw fail(503, 'Ревизия настроек AI исчерпана. Сохранение отключено.')
  const settings = validateWorkshopAiSettings({
    schema: 1,
    revision: current.revision + 1,
    enabled: body.enabled,
    provider: body.provider,
    // Absent per-model/registry/cleanup keys keep the stored values: a stale form
    // must not reroute models or wipe the registry.
    generationProvider: body.generationProvider ?? current.generationProvider,
    transcriptionProvider: body.transcriptionProvider ?? current.transcriptionProvider,
    providers: body.providers ?? current.providers,
    generationModel: body.generationModel,
    transcriptionModel: body.transcriptionModel,
    cleanupModel: body.cleanupModel ?? current.cleanupModel,
    cleanupProvider: body.cleanupProvider ?? current.cleanupProvider,
    maxBlocks: body.maxBlocks,
    blocksPerTick: body.blocksPerTick,
    minimumBuildTicks: body.minimumBuildTicks,
    applyBudgetMs: body.applyBudgetMs,
    hourlyRequestLimit: body.hourlyRequestLimit,
    hourlyPlayerRequestLimit: body.hourlyPlayerRequestLimit,
    maxHourlyBuilders: body.maxHourlyBuilders,
    generationMaxPricePromptUsdPerM: body.generationMaxPricePromptUsdPerM,
    generationMaxPriceCompletionUsdPerM: body.generationMaxPriceCompletionUsdPerM,
  })
  // Enabled AI needs a key for every referenced provider. The gateway key lives in a host
  // file, which the site cannot verify; cleanup counts only when set.
  if (settings.enabled) {
    const needed = new Set([settings.generationProvider, settings.transcriptionProvider])
    if (settings.cleanupModel) needed.add(settings.cleanupProvider)
    needed.delete('vercel-gateway')
    const missing = [...needed].filter((id) => !hasKey(id))
    if (missing.length === 1 && missing[0] === 'openrouter')
      throw fail(400, 'Сначала сохраните ключ OpenRouter и дождитесь статуса «Ключ задан».')
    if (missing.length > 0)
      throw fail(
        400,
        `Нет ключа провайдера ${missing.join(', ')}: сохраните ключ и дождитесь статуса «Ключ задан».`,
      )
  }
  // The reader caps the settings file: refuse a doc that would not fit once serialized.
  if (Buffer.byteLength(JSON.stringify(settings, null, 2) + '\n') > 8192)
    throw fail(413, 'Настройки AI превышают доступный размер. Укоротите записи провайдеров.')
  writeAtomic(directory, 'workshop-ai-settings.json', settings)
  return settings
}

/** One controller answer, validated the same way for status polling and the request view. */
function readRequestResult(id: string) {
  if (!UUID.test(id)) throw bad('Некорректный запрос.')
  const result = readFile(join(adminDir(), 'results', `${id}.json`), 8 * 1024 * 1024)
  if (
    result !== null &&
    (!plain(result) ||
      (result.schema !== undefined && result.schema !== 1) ||
      result.id !== id ||
      typeof result.ok !== 'boolean' ||
      !mapJsonSafe(result))
  )
    throw fail(503, 'Ответ контроллера повреждён. Обновите состояние позже.')
  return result
}

/** Only these command shapes ever reach RCON; every argument is checked, nothing is passed through. */
function text(value: unknown, required: boolean): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad('Укажите текст.')
    return ''
  }
  if (typeof value !== 'string') throw bad('Некорректный текст.')
  const clean = value
    .replace(/[\p{Cc}§]/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (!clean && required) throw bad('Укажите текст.')
  if (clean.length > 120) throw bad('Текст длиннее 120 символов.')
  if (clean.startsWith('/')) throw bad('Текст не может начинаться с «/».')
  return clean
}
const player = (value: unknown) => {
  if (typeof value !== 'string' || !nickname.test(value))
    throw bad('Никнейм: 3–16 символов, латинские буквы, цифры и _.')
  return value
}
const withReason = (command: string, reason: string) => (reason ? `${command} ${reason}` : command)
export function rconCommand(body: any): {
  permission: string
  commands: string[]
  target: string | null
} {
  switch (body?.action) {
    case 'list':
      return { permission: 'moderate', commands: ['list'], target: null }
    case 'say':
      return { permission: 'moderate', commands: [`say ${text(body.text, true)}`], target: null }
    case 'kick':
      return {
        permission: 'moderate',
        commands: [withReason(`kick ${player(body.player)}`, text(body.reason, false))],
        target: body.player,
      }
    case 'ban':
      return {
        permission: 'ban',
        commands: [withReason(`ban ${player(body.player)}`, text(body.reason, false))],
        target: body.player,
      }
    case 'pardon':
      return { permission: 'ban', commands: [`pardon ${player(body.player)}`], target: body.player }
    case 'team-kick':
      return {
        permission: 'moderate',
        commands: [`bf team kick ${player(body.player)}`],
        target: body.player,
      }
    case 'class-lock':
    case 'class-unlock': {
      if (typeof body.classId !== 'string' || !/^[a-z0-9_]{1,32}$/.test(body.classId))
        throw bad('Некорректный класс.')
      return {
        permission: 'moderate',
        commands: [`bf class ${body.action.slice(6)} ${body.classId}`],
        target: body.classId,
      }
    }
    case 'range':
      if (!['open', 'close', 'reset'].includes(body.op))
        throw bad('Полигон: open, close или reset.')
      return { permission: 'moderate', commands: [`bf range ${body.op}`], target: body.op }
    case 'stop-room': {
      if (typeof body.roomId !== 'string' || !roomId.test(body.roomId))
        throw bad('Некорректная комната.')
      const reason = text(body.reason, false),
        room = `bf stop room ${body.roomId}`
      if (body.outcome === 'draw')
        return {
          permission: 'moderate',
          commands: [withReason(`${room} draw`, reason)],
          target: body.roomId,
        }
      if (body.outcome === 'RED' || body.outcome === 'BLUE')
        return {
          permission: 'moderate',
          commands: [
            withReason(`${room} win ${body.outcome === 'RED' ? 'RedTeam' : 'BlueTeam'}`, reason),
          ],
          target: body.roomId,
        }
      if (body.outcome !== 'none') throw bad('Итог: none, draw, RED или BLUE.')
      // A bare reason starting with a sub-command word would be parsed as that sub-command.
      if (/^(win|draw)\b/.test(reason)) throw bad('Причина не может начинаться с win или draw.')
      return { permission: 'moderate', commands: [withReason(room, reason)], target: body.roomId }
    }
    case 'maintenance-status':
      return { permission: 'maintenance', commands: ['bf maintenance status'], target: null }
    case 'drain':
      return { permission: 'maintenance', commands: ['bf maintenance drain'], target: null }
    case 'resume':
      return { permission: 'maintenance', commands: ['bf maintenance resume'], target: null }
    // The server confirms an interrupt only from the same sender within 60 s, so both commands share one connection.
    case 'interrupt':
      return {
        permission: 'maintenance',
        commands: [
          'bf maintenance interrupt',
          `bf maintenance interrupt confirm ${text(body.reason, true)}`,
        ],
        target: null,
      }
    default:
      throw bad('Неизвестное действие.')
  }
}
/** Brigadier answers a bad command with text, not an error code. */
export const rejectedByServer = (output: string) =>
  /^\s*(Unknown or incomplete command|Unknown command)/i.test(output) ||
  output.includes('<--[HERE]')
/** «Начать/Закончить техработы» (POST gate): mapping lives in ./cp.ts. */
/** A failure whose `internal` text goes only to the server log and the audit log, never to the browser. */
function hidden(status: number, message: string, internal: string) {
  return Object.assign(fail(status, message), { internal })
}
function rconConfigured(target: RconTarget = 'game') {
  const env = process.env
  if (target === 'workshop') {
    if (!env.BLOCKFIELD_WORKSHOP_RCON_HOST || !env.BLOCKFIELD_WORKSHOP_RCON_PASSWORD)
      throw fail(503, 'RCON для Workshop не настроен на сайте.')
    return
  }
  if (!env.BLOCKFIELD_RCON_HOST || !env.BLOCKFIELD_RCON_PASSWORD)
    throw fail(503, 'RCON не настроен на сайте.')
}
function sendRcon(commands: string[], target: RconTarget = 'game') {
  const env = process.env
  const isWorkshop = target === 'workshop'
  const host = isWorkshop ? env.BLOCKFIELD_WORKSHOP_RCON_HOST : env.BLOCKFIELD_RCON_HOST
  const port = Number(
    (isWorkshop ? env.BLOCKFIELD_WORKSHOP_RCON_PORT : env.BLOCKFIELD_RCON_PORT) || 25575,
  )
  const password = isWorkshop ? env.BLOCKFIELD_WORKSHOP_RCON_PASSWORD : env.BLOCKFIELD_RCON_PASSWORD
  return rcon(commands, {
    host: host!,
    port,
    password: password!,
  }).catch((error: Error) => {
    console.error(`RCON [${target}] failed`, error.message)
    const serverDesc = isWorkshop ? 'Сервер Workshop' : 'Игровой сервер'
    throw hidden(502, `${serverDesc} не отвечает.`, error.message)
  })
}
/**
 * The mod's console link (log stream + Brigadier completion) lives next to RCON: same host, the
 * RCON port plus one unless overridden, the RCON password as the bearer token. No new secrets.
 */
function consoleLink(target: RconTarget = 'game') {
  const env = process.env
  const isWorkshop = target === 'workshop'
  rconConfigured(target)
  const rconPort = Number(
    (isWorkshop ? env.BLOCKFIELD_WORKSHOP_RCON_PORT : env.BLOCKFIELD_RCON_PORT) || 25575,
  )
  const port = Number(
    (isWorkshop ? env.BLOCKFIELD_WORKSHOP_CONSOLE_PORT : env.BLOCKFIELD_CONSOLE_PORT) ||
      rconPort + 1,
  )
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw fail(503, 'Порт консоли настроен неверно.')
  const host = isWorkshop ? env.BLOCKFIELD_WORKSHOP_RCON_HOST : env.BLOCKFIELD_RCON_HOST
  // The mod's console link accepts only its console-read bearer (BLOCKFIELD_CP_CONSOLE_READ_TOKEN
  // on the server), never the RCON password.
  const token = isWorkshop
    ? env.BLOCKFIELD_WORKSHOP_CONSOLE_READ_TOKEN
    : env.BLOCKFIELD_CONSOLE_READ_TOKEN
  if (!token) throw fail(503, 'Токен консоли не настроен.')
  return { host: host!, port, token }
}
/** One proxied call to the mod's console link: structured data only, never raw JSON to the browser. */
async function fetchConsole(target: RconTarget, path: 'logs' | 'suggest', search: string) {
  const { host, port, token } = consoleLink(target)
  const response = await fetch(`http://${host}:${port}/blockfield/console/v1/${path}?${search}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  }).catch((error: Error) => {
    console.error(`Console [${target}] failed`, error.message)
    const serverDesc = target === 'workshop' ? 'Сервер Workshop' : 'Игровой сервер'
    throw hidden(502, `${serverDesc} не отвечает.`, error.message)
  })
  if (response.status === 401 || response.status === 403)
    throw fail(502, 'Консоль сервера отвергла ключ сайта.')
  if (response.status !== 200) throw fail(502, 'Консоль сервера вернула ошибку.')
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim()
  const data = type === 'application/json' ? await response.json().catch(() => null) : null
  try {
    return path === 'logs' ? consoleLogPage(data) : consoleSuggestPage(data)
  } catch {
    throw fail(502, 'Консоль сервера ответила непонятно.')
  }
}

async function lookupName(name: unknown): Promise<{ uuid: string; name: string }> {
  if (typeof name !== 'string' || !nickname.test(name))
    throw bad('Никнейм: 3–16 символов, латинские буквы, цифры и _.')
  const base = (process.env.DRASL_URL || 'https://skins.blockfield.pro').replace(/\/+$/, '')
  const response = await fetch(`${base}/account/users/profiles/minecraft/${name}`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (response?.status === 404 || response?.status === 204)
    throw fail(404, 'Игрок с таким никнеймом не найден.')
  const data = response?.ok ? await response.json().catch(() => null) : null
  if (!playerId(data?.id) || typeof data.name !== 'string')
    throw fail(502, 'Сервер аккаунтов недоступен. Попробуйте позже.')
  return { uuid: playerId(data.id)!, name: data.name }
}
const ownerNames = new Map<string, string>()
/** Last name seen in match results; used when Drasl cannot be reached. */
async function knownName(store: StatsStore, uuid: string): Promise<string | null> {
  const dashed = uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
  const row = (await store.db.prepare('SELECT name FROM profiles WHERE uuid=?').get(dashed)) as
    | { name: string }
    | undefined
  return row && nickname.test(row.name) ? row.name : null
}
async function ownerName(uuid: string): Promise<string> {
  if (ownerNames.has(uuid)) return ownerNames.get(uuid)!
  const base = (process.env.DRASL_URL || 'https://skins.blockfield.pro').replace(/\/+$/, '')
  const data = await fetch(`${base}/session/minecraft/profile/${uuid}`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  if (typeof data?.name !== 'string' || !nickname.test(data.name))
    throw fail(502, 'Не удалось узнать никнейм владельца в сервере аккаунтов.')
  ownerNames.set(uuid, data.name)
  return data.name
}
async function syncWorkshop(
  store: StatsStore,
  actor: Actor,
  resolve = ownerName,
  staffOverride?: { uuid: string; name: string; role: string; maps?: string[] | null }[],
) {
  const names = new Map<string, string>()
  for (const uuid of owners())
    names.set(
      uuid,
      await resolve(uuid).catch(
        async (error) => (await knownName(store, uuid)) ?? Promise.reject(error),
      ),
    )
  const members = workshopMembers(staffOverride ?? (await store.staff()), names)
  const id = writeRequest(inboxDir(), actor, { kind: 'members', members }, workshopMapIds())
  return { id, members }
}

/**
 * Players banned through the site: the latest successful ban/pardon per nickname in the audit log.
 * ponytail: bans made in-game or older than the newest 10 000 audit rows are not listed (RCON `banlist` output has no separators to parse); «Разбанить по нику» covers them.
 */
export async function siteBans(store: StatsStore) {
  const rows = (await store.db
    .prepare(
      `SELECT action,target,actor_name "actorName",at,detail FROM admin_audit WHERE ok=1 AND action IN ('rcon:ban','rcon:pardon') AND target IS NOT NULL ORDER BY id`,
    )
    .all()) as any[]
  const latest = new Map<string, any>()
  for (const row of rows) latest.set(String(row.target).toLowerCase(), row)
  return [...latest.values()]
    .filter((r) => r.action === 'rcon:ban')
    .reverse()
    .map((r) => {
      let reason = ''
      try {
        reason = String(JSON.parse(r.detail)?.reason ?? '')
      } catch {
        // Older journal entries can contain plain text instead of JSON.
      }
      return { player: r.target as string, by: r.actorName as string, at: r.at as number, reason }
    })
}

type Handler = (args: {
  context: APIContext
  actor: Actor
  store: StatsStore
  body: any
}) => Promise<unknown> | unknown
type Route = {
  permission: string
  handler: Handler
  audit?: (body: any, result: any) => { action: string; target?: string | null; detail?: unknown }
  maxBody?: number
  /** Effect is a pure DB write: run it in the same transaction as the audit finalize. */
  tx?: boolean
}
const page = (url: URL) => {
  const n = Number(url.searchParams.get('page') || '1')
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw bad('Некорректная страница.')
  return n
}

export async function overviewSnapshot() {
  const rooms = await currentRooms()
  return {
    status: readFile(join(adminDir(), 'status.json')),
    session: readFile(join(adminDir(), 'session.json')),
    rooms,
  }
}

// Owner-only amounts/limits must never reach admins through the audit log,
// including rows written before the write callbacks started redacting them.
const redactAuditDetail = (action: string, detail: unknown): unknown => {
  if (action !== 'ai-limits' && action !== 'workshop-ai-settings') return detail
  let parsed: unknown
  try {
    parsed = typeof detail === 'string' ? JSON.parse(detail) : detail
  } catch {
    return null
  }
  if (!plain(parsed)) return null
  return action === 'ai-limits'
    ? { mode: parsed.mode }
    : { enabled: parsed.enabled, provider: parsed.provider }
}

/** CP mode staff routes read GET /v2/staff/grants and write POST /v2/staff/grants.
The replica below is only a name/maps book, never authority. When CP itself is
unreachable the routes fail closed instead of deciding from stale rows. */
const cpStaffClosed = () =>
  fail(503, 'Штат через CP недоступен: control-plane не отвечает. Обратитесь к координатору.')

type CpLib = typeof import('./cp.ts')

/** Site role seniority for the replica mirror: it shows the highest CP-held role. */
const SITE_ROLE_RANK: Record<string, number> = { builder: 1, moderator: 2, admin: 3 }

/** Role refresh for the admin event stream: CP authority in CP mode, replica otherwise. */
export async function refreshRole(actor: Actor, store: StatsStore): Promise<Role | null> {
  if ((await import('./cp.ts')).cpStaffConfigured()) {
    const cp = await import('./cp.ts')
    return cpActorRole(cp, actor)
  }
  return roleOf(actor.uuid, store)
}

/** A CP answer with a status code (denied, conflict, unknown account). */
function isCpProblem(error: unknown): error is Error & { status: number; code: string } {
  return (
    typeof (error as { status?: unknown })?.status === 'number' &&
    typeof (error as { code?: unknown })?.code === 'string'
  )
}

/** No CP answer at all: the mutation may still have applied. */
function isUnknownOutcome(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error as { name?: unknown })?.name === 'TimeoutError' ||
    (error as { name?: unknown })?.name === 'AbortError'
  )
}

/** CP Problem carries {status, code}; fetch outages are TypeErrors/TimeoutErrors. */
async function cpCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Response) throw error
    if (isCpProblem(error)) throw fail(error.status, error.message)
    if (isUnknownOutcome(error)) throw cpStaffClosed()
    throw error
  }
}

/** One roster read; accounts unknown to CP are null, anything else throws mapped. */
async function cpGrantsOrNull(cp: CpLib, uuid: string) {
  try {
    return await cp.readStaffGrantsCp(uuid)
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'account_not_found') return null
    throw error
  }
}

/** The acting admin's role from CP (owner env wins); null authorizes nothing. */
async function cpActorRole(cp: CpLib, actor: Actor): Promise<Role | null> {
  if (owners().has(actor.uuid)) return 'owner'
  if (!playerId(actor.uuid)) return null
  const read = await cpCall(() => cpGrantsOrNull(cp, actor.uuid))
  return read
    ? cp.roleFromCpMe(
        { accountId: read.accountId, owner: false, grants: read.grants },
        cp.cpScope(),
      )
    : null
}

/** Team list: replica rows are the name/maps book, CP grants are role authority.
One unreadable row never aborts the roster: it is left out and reported in
`failed`. When nothing at all resolves the read fails closed instead of
pushing an empty team. */
async function cpTeamList(cp: CpLib, store: StatsStore) {
  const scope = cp.cpScope()
  const team = []
  const failed: { uuid: string; name: string }[] = []
  // Serial reads keep the fake-CP request order deterministic in tests.
  for (const row of await store.staff()) {
    let read
    try {
      read = await cpGrantsOrNull(cp, row.uuid)
    } catch {
      // Malformed bodies and 5xx included: skip the row, do not abort the list.
      failed.push({ uuid: row.uuid, name: row.name })
      continue
    }
    if (!read) continue
    const role = cp.roleFromCpMe(
      { accountId: read.accountId, owner: false, grants: read.grants },
      scope,
    )
    if (!role) continue
    team.push({ ...row, role, expectedRevision: read.expectedRevision })
  }
  if (team.length === 0 && failed.length > 0) throw cpStaffClosed()
  return { team, failed }
}

/** Push the CP roster to the workshop. Unreadable accounts are left out of the
push and named in the sync error; a failed push lands there too. Never throws. */
async function syncCpTeam(store: StatsStore, actor: Actor, cp: CpLib) {
  try {
    const { team, failed } = await cpCall(() => cpTeamList(cp, store))
    const pushed = await syncWorkshop(store, actor, ownerName, team)
    if (!failed.length) return { id: pushed.id, members: pushed.members }
    const names = failed.map((m) => m.name ?? m.uuid).join(', ')
    return {
      id: pushed.id,
      members: pushed.members,
      error: `Доступ обновлён частично: нет данных CP по ${names} — нажмите «Обновить доступ» позже.`,
    }
  } catch (error) {
    return {
      error:
        error instanceof Response
          ? 'Не удалось отправить список в мастерскую.'
          : String((error as Error).message),
    }
  }
}

const routes: Record<string, Route> = {
  'GET overview': {
    permission: 'view',
    handler: overviewSnapshot,
  },
  'GET request': {
    permission: 'view',
    // Key tails are owner-only: the generic view-gated route serves a redacted
    // copy, owners read the full result through their key-status routes.
    handler: ({ context }) => ({
      result: redactKeyResult(readRequestResult(context.url.searchParams.get('id') ?? '')),
    }),
  },
  'POST mode': {
    permission: 'mode',
    handler: ({ actor, body }) => {
      const catalog = readMapCatalog(adminDir())
      if (body?.profile === 'test' && body.modeId !== undefined) {
        const candidate = existingCandidate(body.candidateId),
          modes = candidate.supportedModes
        if (
          !Array.isArray(modes) ||
          !modes.length ||
          modes.length > 7 ||
          new Set(modes).size !== modes.length ||
          !modes.every(arenaMode)
        )
          throw fail(503, 'Режимы сохранённой версии не подтверждены. Обновите список проверок.')
        if (!modes.includes(body.modeId))
          throw bad('Сохранённая версия карты не поддерживает этот режим.')
      }
      if (body?.profile === 'workshop' && body?.session === 'new' && body.branches !== undefined) {
        if (
          !catalog.available ||
          !plain(body.branches) ||
          !Object.entries(body.branches).every(([id, name]) =>
            catalog.maps
              .find((entry) => entry.mapId === id)
              ?.branches?.some((ref) => ref.name === name && ref.name !== 'main'),
          )
        )
          throw bad('Выбранная ветка отсутствует в каталоге карт.')
      }
      return {
        id: writeRequest(
          inboxDir(),
          actor,
          { ...body, kind: 'mode' },
          catalog.available ? new Set(catalog.maps.map((entry) => entry.mapId)) : MAP_IDS,
        ),
      }
    },
    audit: (body) => ({
      action: 'mode',
      target: String(body?.profile),
      detail: {
        expectedRevision: body?.expectedRevision,
        recover: body?.recover === true,
        session: body?.session,
        maps: body?.maps,
        candidateId: body?.candidateId,
        modeId: body?.modeId,
      },
    }),
  },
  'POST message': {
    permission: 'message',
    handler: ({ actor, body }) => ({
      id: writeRequest(inboxDir(), actor, { kind: 'message', message: body?.message }),
    }),
    audit: (body) => ({ action: 'message', detail: { message: body?.message } }),
  },
  // Cancelling rolls back only the Workshop transition; recovery remains admin-only.
  'POST cancel': {
    permission: 'mode',
    handler: ({ actor }) => ({ id: writeRequest(inboxDir(), actor, { kind: 'cancel' }) }),
    audit: () => ({ action: 'cancel' }),
  },
  // Waking is idempotent: a still-unanswered `wake` request is reused, never duplicated.
  // Every staff member is a Workshop member (the site derives the controller ACL from staff
  // roles), so this is open to all roles; POST maps/sessions sets the view-gated precedent.
  'POST wake': {
    permission: 'view',
    handler: ({ actor }) => ({
      id:
        pendingWakeId(inboxDir(), join(adminDir(), 'results')) ??
        writeRequest(inboxDir(), actor, { kind: 'wake' }),
    }),
    audit: () => ({ action: 'workshop-wake' }),
  },
  'POST rcon': {
    permission: 'moderate',
    handler: async ({ actor, body }) => {
      const { permission, commands } = rconCommand(body)
      if (!can(actor.role, permission)) throw fail(403, 'Недостаточно прав.')
      rconConfigured()
      // Room ids are not meaningful to people: keep the room's name and map for the audit log.
      const found =
        body.action === 'stop-room'
          ? (await currentRooms()).rooms.find((r) => r.id === body.roomId)
          : undefined
      const room = found ? { name: found.name, map: found.map } : undefined
      const outputs = await sendRcon(commands)
      const output = stripColors(outputs.at(-1) ?? '')
      const rejected = outputs.map(stripColors).find(rejectedByServer)
      if (rejected !== undefined)
        throw fail(502, `Сервер не принял команду: ${rejected.slice(0, 200)}`)
      return {
        output,
        room,
        players:
          body.action === 'list'
            ? (output.split(':')[1] ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
      }
    },
    audit: (body, result) => ({
      action: `rcon:${body?.action}`,
      target: body?.player ?? body?.roomId ?? body?.classId ?? body?.op ?? null,
      detail: { ...body, room: result?.room, output: result?.output?.slice(0, 500) },
    }),
  },
  // Entry gate via control-plane (U1): owner AND site admins; CP audits the actor too.
  'POST gate': {
    permission: 'maintenance',
    handler: async ({ actor, body }) => {
      let toggle
      try {
        toggle = gateToggle(body)
      } catch {
        throw bad('Неизвестное действие.')
      }
      const { mode, message } = toggle
      const { postGateCp } = await import('./cp.ts')
      try {
        return await postGateCp(
          mode,
          message,
          { id: actor.uuid, role: actor.role === 'owner' ? 'owner' : 'admin' },
          randomUUID(),
        )
      } catch (error) {
        const text = error instanceof Error ? error.message : ''
        // Безопасно для показа: ревизия CP — только номер, «не настроен» — без секретов.
        if (/ревизия \d+/.test(text)) throw fail(409, text)
        if (/не настроен/.test(text)) throw fail(503, text)
        throw error
      }
    },
    audit: (body, result) => ({
      action: `gate:${body?.action}`,
      detail: { revision: result?.revision },
    }),
  },
  // Owner only: any single command line. Refusals are audited too (without the command: the body is not read).
  'POST rcon/raw': {
    permission: 'rcon-raw',
    handler: async ({ body }) => {
      let command: string
      let target: RconTarget
      try {
        target = rconTarget(body?.target)
        command = rawCommand(body?.command)
      } catch (error) {
        throw bad((error as Error).message)
      }
      rconConfigured(target)
      const output = stripColors((await sendRcon([command], target))[0] ?? '')
      return { command, output, rejected: rejectedByServer(output), target }
    },
    audit: (body, result) => {
      let target: string | null = null
      if (body !== undefined) {
        // rconTarget defaults a missing target to 'game' — but only a real request object
        // can carry that default. A null/array/string body never named a target.
        if (typeof body !== 'object' || body === null || Array.isArray(body)) target = 'unknown'
        else {
          try {
            target = rconTarget(body.target)
          } catch {
            target = typeof body.target === 'string' ? redact(body.target).slice(0, 32) : 'unknown'
          }
        }
      }
      return {
        action: 'rcon:raw',
        target:
          typeof (result?.command ?? body?.command) === 'string'
            ? redact((result?.command ?? body.command).replace(/\p{Cc}/gu, ' '))
            : null,
        detail: {
          target: result?.target ?? target ?? undefined,
          output: result?.output === undefined ? undefined : redact(result.output).slice(0, 500),
          rejected: result?.rejected,
        },
      }
    },
  },
  'GET diagnostics': {
    permission: 'diagnostics',
    handler: async ({ store }) => readDiagnostics(store.db),
  },
  // Live server log stream and Brigadier completion from the mod's console link (read-only, unaudited).
  'GET console/logs': {
    permission: 'rcon-raw',
    handler: async ({ context }) => {
      let target: RconTarget, since: number
      try {
        target = rconTarget(context.url.searchParams.get('target'))
        since = consoleSince(context.url.searchParams.get('since'))
      } catch (error) {
        throw bad((error as Error).message)
      }
      return fetchConsole(target, 'logs', `since=${since}`)
    },
  },
  'GET console/suggest': {
    permission: 'rcon-raw',
    handler: async ({ context }) => {
      let target: RconTarget, input: string
      try {
        target = rconTarget(context.url.searchParams.get('target'))
        input = suggestInput(context.url.searchParams.get('input') ?? '')
      } catch (error) {
        throw bad((error as Error).message)
      }
      return fetchConsole(target, 'suggest', `input=${encodeURIComponent(input)}`)
    },
  },
  // The server's own tick window right now (vanilla `tick query`, read-only), independent of pushed samples.
  'GET diagnostics/live': {
    permission: 'diagnostics',
    handler: async () => {
      rconConfigured()
      const output = stripColors((await sendRcon(['tick query']))[0] ?? '')
      const tick = parseTickQuery(output)
      if (!tick) throw fail(502, 'Сервер не вернул данные о тиках.')
      return { at: Date.now(), ...tick }
    },
  },
  'GET bans': {
    permission: 'ban',
    handler: async ({ store }) => ({ bans: await siteBans(store) }),
  },
  // Подсказки к полям с никнеймом: кого сайт уже видел в матчах, начиная с недавних.
  'GET players': {
    permission: 'moderate',
    handler: async ({ store }) => ({
      players: (
        (await store.db
          .prepare(
            'SELECT name FROM profiles WHERE uuid_like(name)=0 ORDER BY last_seen DESC LIMIT 300',
          )
          .all()) as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => nickname.test(name)),
    }),
  },
  'GET settings': {
    permission: 'settings',
    handler: async () => {
      const { cpConfigured } = await import('./cp.ts')
      if (!cpConfigured())
        return {
          ...readSettings(settingsDir()),
          balance: BALANCE,
          gunBalance: readGunBalance(settingsDir()),
        }
      return {
        ...(await readSettingsCpView(settingsDir())),
        balance: BALANCE,
        gunBalance: readGunBalance(settingsDir()),
      }
    },
  },
  'PUT settings': {
    permission: 'settings',
    maxBody: 1_048_576,
    handler: async ({ actor, body }) => {
      const { cpConfigured } = await import('./cp.ts')
      if (cpConfigured()) {
        const { settings, cpRevisions } = await saveSettingsCp(settingsDir(), body, actor.name)
        return { settings, cpRevisions }
      }
      return { settings: saveSettings(settingsDir(), body, actor.name) }
    },
    audit: (body, result) => ({
      action: 'settings',
      target: result?.settings ? `revision ${result.settings.revision}` : null,
      detail: body,
    }),
  },
  'GET ai-limits': {
    permission: 'ai',
    handler: async () => {
      const { cpConfigured } = await import('./cp.ts')
      if (cpConfigured()) return { policy: await readAiLimitsCpView(settingsDir()) }
      return { policy: readAiLimits(settingsDir()) }
    },
  },
  'PUT ai-limits': {
    permission: 'ai',
    maxBody: 65_536,
    handler: async ({ actor, body }) => {
      const { cpConfigured } = await import('./cp.ts')
      if (cpConfigured()) {
        const { policy, cpRevisions } = await saveAiLimitsCp(settingsDir(), body, actor.role)
        return { policy, cpRevisions }
      }
      return { policy: saveAiLimits(settingsDir(), body) }
    },
    audit: (body, result) => ({
      action: 'ai-limits',
      target: result?.policy ? `revision ${result.policy.revision}` : null,
      // Grant amounts are owner-only and admins read the audit log: keep the mode only.
      detail: { mode: body?.mode },
    }),
  },
  'GET workshop-ai-settings': {
    permission: 'ai',
    handler: async () => {
      const { cpConfigured } = await import('./cp.ts')
      if (cpConfigured()) return { settings: await readWorkshopAiSettingsCpView(settingsDir()) }
      return { settings: readWorkshopAiSettings(settingsDir()) }
    },
  },
  'PUT workshop-ai-settings': {
    permission: 'ai',
    maxBody: 8192,
    handler: async ({ body }) => {
      const hasKey = (provider) =>
        readWorkshopAiKeyStatus(adminDir(), workshopAiKeyStatusFile(provider)).set
      const { cpConfigured } = await import('./cp.ts')
      if (cpConfigured()) {
        const { settings, cpRevisions } = await saveWorkshopAiSettingsCp(
          settingsDir(),
          body,
          hasKey,
        )
        return { settings, cpRevisions }
      }
      return { settings: saveWorkshopAiSettings(settingsDir(), body, hasKey) }
    },
    audit: (body, result) => ({
      action: 'workshop-ai-settings',
      target: result?.settings ? `revision ${result.settings.revision}` : null,
      // Limits, models and tariff ceilings are owner-only and admins read the
      // audit log: keep the operational switches only, never the values.
      detail: { enabled: body?.enabled, provider: body?.provider },
    }),
  },
  'GET workshop-ai-key': {
    permission: 'ai',
    handler: ({ context }) => {
      const id = context.url.searchParams.get('id')
      return {
        status: readWorkshopAiKeyStatus(adminDir()),
        result: id === null || id === '' ? null : readRequestResult(id),
      }
    },
  },
  'POST workshop-ai-key': {
    permission: 'ai',
    maxBody: 4096,
    handler: ({ actor, body }) => ({
      id: writeRequest(inboxDir(), actor, { kind: 'ai-key', key: body?.key }),
    }),
    // The key itself never reaches the audit log: only whether it is set or removed.
    audit: (body) => ({ action: 'workshop-ai-key', detail: { remove: body?.key == null } }),
  },
  'GET workshop-ai-gateway-key': {
    permission: 'ai',
    handler: ({ context }) => {
      const id = context.url.searchParams.get('id')
      return {
        status: readWorkshopAiKeyStatus(adminDir(), 'ai-gateway-key.json'),
        result: id === null || id === '' ? null : readRequestResult(id),
      }
    },
  },
  'POST workshop-ai-gateway-key': {
    permission: 'ai',
    maxBody: 4096,
    handler: ({ actor, body }) => ({
      id: writeRequest(inboxDir(), actor, { kind: 'ai-gateway-key', key: body?.key }),
    }),
    // The key itself never reaches the audit log: only whether it is set or removed.
    audit: (body) => ({
      action: 'workshop-ai-gateway-key',
      detail: { remove: body?.key == null },
    }),
  },
  // Custom registry provider keys. The controller side (per-provider `<id>.key`
  // files and `<id>-key.json` statuses) lands with the workshop gate; until then
  // these routes queue inbox `ai-provider-key` requests the same 0600 way.
  'GET workshop-ai-provider-key': {
    permission: 'ai',
    handler: ({ context }) => {
      const provider = context.url.searchParams.get('provider')
      if (!isWorkshopAiProviderId(provider)) throw bad('Некорректный провайдер.')
      const id = context.url.searchParams.get('id')
      return {
        status: readWorkshopAiKeyStatus(adminDir(), workshopAiKeyStatusFile(provider)),
        result: id === null || id === '' ? null : readRequestResult(id),
      }
    },
  },
  'POST workshop-ai-provider-key': {
    permission: 'ai',
    maxBody: 4096,
    handler: ({ actor, body }) => ({
      id: writeRequest(inboxDir(), actor, {
        kind: 'ai-provider-key',
        provider: body?.provider,
        key: body?.key,
      }),
    }),
    // The key itself never reaches the audit log: only its removal and the provider
    // id when it is already registered. A pasted key can match the id shape.
    audit: (body) => ({
      action: 'workshop-ai-provider-key',
      detail: {
        remove: body?.key == null,
        provider: readWorkshopAiSettings(settingsDir()).providers.some(
          (entry) => entry.id === body?.provider,
        )
          ? body.provider
          : null,
      },
    }),
  },
  'GET gun-balance': {
    permission: 'settings',
    handler: () => readGunBalance(settingsDir()),
  },
  'GET kits': {
    permission: 'settings',
    handler: () => readKits(settingsDir()),
  },
  'PUT kits': {
    permission: 'settings',
    maxBody: 1_048_576,
    handler: async ({ actor, body }) => {
      const { cpConfigured } = await import('./cp.ts')
      if (cpConfigured()) {
        const { settings, cpRevisions } = await saveKitSettingsCp(settingsDir(), body, actor.name)
        return { settings, cpRevisions }
      }
      return { settings: saveKitSettings(settingsDir(), body, actor.name) }
    },
    audit: (body, result) => ({
      action: 'kits',
      target: result?.settings ? `revision ${result.settings.revision}` : null,
      detail: body,
    }),
  },
  'PUT gun-balance': {
    permission: 'settings',
    maxBody: 1_048_576,
    handler: async ({ actor, body }) => {
      const { cpConfigured } = await import('./cp.ts')
      if (cpConfigured()) {
        const { settings, cpRevisions } = await saveSettingsCp(
          settingsDir(),
          body,
          actor.name,
          true,
        )
        return { settings, cpRevisions }
      }
      return { settings: saveSettings(settingsDir(), body, actor.name, true) }
    },
    audit: (body, result) => ({
      action: 'gun-balance',
      target: result?.settings ? `revision ${result.settings.revision}` : null,
      detail: body,
    }),
  },
  // Map candidates (controller candidates.py): the list is for everyone in the panel, decisions for admins.
  'GET candidates': {
    permission: 'view',
    handler: () =>
      readFile(join(adminDir(), 'candidates.json'), 16 * 1024 * 1024) ?? {
        schema: 1,
        candidates: [],
        backups: {},
      },
  },
  'GET maps': {
    permission: 'view',
    handler: async ({ actor, store }) => {
      const catalog = readMapCatalog(adminDir())
      let cpRevisions: Record<string, number> | undefined
      try {
        const { cpConfigured, readSettingsCp } = await import('./cp.ts')
        if (cpConfigured()) {
          const view = await readSettingsCp('disabledMapIds')
          if (view.initialized) cpRevisions = { disabledMapIds: view.revision }
        }
      } catch {
        // File availability stays authoritative when CP cannot be read.
      }
      return {
        ...catalog,
        editableMaps: await editableMapIds(actor, store, catalog),
        availability: mapAvailability(settingsDir()),
        ...(cpRevisions ? { cpRevisions } : {}),
      }
    },
  },
  'POST maps/branches': {
    permission: 'map-edit',
    handler: async ({ actor, store, body }) => {
      const { catalog, entry } = await editableMap(actor, store, body?.mapId)
      if (!entry.versions.some((version) => version.versionDigest === body?.versionDigest))
        throw bad('Выбранная версия отсутствует в истории карты.')
      if (entry.branches?.some((ref) => ref.name === body?.branch))
        throw fail(409, 'Ветка с таким именем уже существует.')
      return {
        id: writeRequest(
          inboxDir(),
          actor,
          { ...body, kind: 'branch-create' },
          new Set(catalog.maps.map((map) => map.mapId)),
        ),
      }
    },
    audit: (body) => ({
      action: 'map-branch-create',
      target: body?.mapId,
      detail: { branch: body?.branch, versionDigest: body?.versionDigest },
    }),
  },
  'POST maps/create': {
    permission: 'maps',
    handler: ({ actor, body }) => {
      const catalog = requiredMapCatalog()
      editorRevision(body)
      if (catalog.maps.some((map) => map.mapId === body?.mapId))
        throw fail(409, 'Карта с таким ID уже существует. Выберите другой ID.')
      return { id: writeRequest(inboxDir(), actor, { ...body, kind: 'map-create' }) }
    },
    audit: (body) => ({
      action: 'map-create',
      target: body?.mapId,
      detail: {
        name: body?.name,
        supportedModes: body?.supportedModes,
        expectedRevision: body?.expectedRevision,
      },
    }),
  },
  'PUT maps/availability': {
    permission: 'workshop',
    handler: async ({ actor, body }) => {
      const catalog = requiredMapCatalog(),
        entry = catalog.maps.find((map) => map.mapId === body?.mapId)
      if (!entry || entry.kind !== 'arena' || !entry.head)
        throw bad('Доступность меняется только для опубликованной арены.')
      const { cpConfigured } = await import('./cp.ts')
      if (cpConfigured()) {
        const { settings, cpRevisions } = await saveMapAvailabilityCp(
          settingsDir(),
          body,
          actor.name,
        )
        return { settings, cpRevisions }
      }
      return { settings: saveMapAvailability(settingsDir(), body, actor.name) }
    },
    audit: (body, result) => ({
      action: 'map-availability',
      target: body?.mapId,
      detail: { enabled: body?.enabled, revision: result?.settings?.revision },
    }),
  },
  'POST maps/properties': {
    permission: 'maps',
    handler: async ({ actor, store, body }) => {
      const { catalog, entry } = await editableMap(actor, store, body?.mapId),
        { copy } = selectedMapBranch(catalog, entry)
      editorRevision(body)
      if (body?.workingCopyId !== copy.id)
        throw fail(409, 'Рабочая копия изменилась. Обновите историю.')
      return {
        id: writeRequest(
          inboxDir(),
          actor,
          { ...body, kind: 'map-properties' },
          new Set(catalog.maps.map((map) => map.mapId)),
        ),
      }
    },
    audit: (body) => ({
      action: 'map-properties',
      target: body?.mapId,
      detail: { name: body?.name, expectedRevision: body?.expectedRevision },
    }),
  },
  'POST maps/sessions': {
    permission: 'view',
    handler: ({ actor, body }) => ({
      id: writeRequest(inboxDir(), actor, { ...body, kind: 'sessions' }),
    }),
    audit: (body) => ({ action: 'map-sessions', target: null, detail: { offset: body?.offset } }),
  },
  'POST maps/commit': {
    permission: 'map-edit',
    handler: async ({ actor, store, body }) => {
      const { catalog, entry } = await editableMap(actor, store, body?.mapId),
        { copy, branch } = selectedMapBranch(catalog, entry)
      if (
        body?.branch !== branch.name ||
        body?.workingCopyId !== copy.id ||
        body?.expectedBranchHead !== branch.versionDigest
      )
        throw fail(409, 'Ветка или рабочая копия изменилась. Обновите историю перед коммитом.')
      return {
        id: writeRequest(
          inboxDir(),
          actor,
          { ...body, kind: 'commit' },
          new Set(catalog.maps.map((map) => map.mapId)),
        ),
      }
    },
    audit: (body) => ({
      action: 'map-commit',
      target: body?.mapId,
      detail: {
        branch: body?.branch,
        expectedBranchHead: body?.expectedBranchHead,
        note: body?.note,
      },
    }),
  },
  'POST maps/compare': {
    permission: 'map-edit',
    handler: async ({ actor, store, body }) => {
      const { catalog, entry } = await editableMap(actor, store, body?.mapId)
      if (
        ![body?.before, body?.after].every((value) =>
          entry.versions.some((version) => version.versionDigest === value),
        )
      )
        throw bad('Обе версии должны принадлежать выбранной карте.')
      return {
        id: writeRequest(
          inboxDir(),
          actor,
          { ...body, kind: 'compare' },
          new Set(catalog.maps.map((map) => map.mapId)),
        ),
      }
    },
    audit: (body) => ({
      action: 'map-compare',
      target: body?.mapId,
      detail: { before: body?.before, after: body?.after },
    }),
  },
  'POST maps/merge-preview': {
    maxBody: 8 * 1024 * 1024,
    permission: 'map-edit',
    handler: async ({ actor, store, body }) => {
      const { catalog, entry } = await editableMap(actor, store, body?.mapId)
      if (!entry.versions.some((version) => version.versionDigest === body?.versionDigest))
        throw bad('Исходная версия не принадлежит этой карте.')
      return {
        id: writeRequest(
          inboxDir(),
          actor,
          { ...body, kind: 'merge-preview', expectedHead: expectedMapHead(body, entry) },
          new Set(catalog.maps.map((map) => map.mapId)),
        ),
      }
    },
    audit: (body) => ({
      action: 'map-merge-preview',
      target: body?.mapId,
      detail: { versionDigest: body?.versionDigest, expectedHead: body?.expectedHead },
    }),
  },
  'GET candidates/download': {
    permission: 'workshop',
    handler: ({ context }) => {
      const id = new URL(context.request.url).searchParams.get('id')
      if (!id || !/^[0-9a-f]{32}$/.test(id)) throw bad('Неверный ID кандидата.')
      const candidate = readFile(
        join(adminDir(), 'candidates.json'),
        16 * 1024 * 1024,
      )?.candidates?.find((c: any) => c.id === id && c.status === 'accepted')
      if (!candidate || !/^[0-9a-f]{64}$/.test(candidate.sha256))
        throw fail(404, 'Принятый пакет не найден.')
      const path = join(packagesDir(), candidate.sha256 + '.zip')
      let size: number
      try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error()
        size = stat.size
      } catch {
        throw fail(503, 'Пакет ещё не готов к скачиванию.')
      }
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        headers: {
          ...noStore,
          'Content-Type': 'application/zip',
          'Content-Length': String(size),
          'Content-Disposition': `attachment; filename="${id}.zip"`,
          'X-Checksum-Sha256': candidate.sha256,
        },
      })
    },
  },
  'POST candidates/create': {
    permission: 'map-edit',
    handler: async ({ actor, store, body }) => {
      const { catalog, entry } = await editableMap(actor, store, body?.mapId),
        { copy, branch } = selectedMapBranch(catalog, entry)
      if (
        ((body.commit === true || body.branch !== undefined) && body.branch !== branch.name) ||
        ((body.commit === true || body.expectedBranchHead !== undefined) &&
          body.expectedBranchHead !== branch.versionDigest) ||
        (body.commit === true && body.workingCopyId !== copy.id)
      )
        throw fail(409, 'Ветка уже изменилась. Обновите историю перед отправкой на проверку.')
      if (body.commit !== true && branch.versionDigest === entry.head?.versionDigest)
        throw fail(409, 'Сначала зафиксируйте изменения в ветке: её коммит совпадает с main.')
      return {
        id: writeRequest(
          inboxDir(),
          actor,
          {
            kind: 'candidate',
            mapId: entry.mapId,
            workingCopyId: copy.id,
            branch: branch.name,
            expectedBranchHead: branch.versionDigest,
            commit: body.commit,
            note: body.note,
          },
          new Set(catalog.maps.map((map) => map.mapId)),
        ),
      }
    },
    audit: (body) => ({ action: 'workshop-candidate', target: body?.mapId ?? null }),
  },
  'POST candidates/publish': {
    maxBody: 8 * 1024 * 1024,
    permission: 'workshop',
    handler: ({ actor, body }) => {
      const candidate = existingCandidate(body?.candidateId),
        catalog = requiredMapCatalog()
      const entry = catalog.maps.find((map) => map.mapId === candidate?.mapId)
      if (!candidate || !entry) throw fail(404, 'Кандидат или карта не найдены.')
      const expectedHead = expectedMapHead(body, entry)
      if (
        candidate.sourceBranch !== undefined &&
        (body.force === true || candidate.targetHead !== expectedHead)
      )
        throw fail(
          body.force === true ? 400 : 409,
          body.force === true
            ? 'Конфликты слияния требуют точного выбора main или версии на проверке.'
            : 'Main изменилась после отправки. Нужна новая проверка из ветки.',
        )
      return {
        id: writeRequest(inboxDir(), actor, {
          kind: 'publish',
          candidateId: body.candidateId,
          force: body.force,
          expectedHead,
          resolutions: body.resolutions,
        }),
      }
    },
    audit: (body) => ({
      action: 'workshop-publish',
      target: body?.mapId ?? null,
      detail: {
        candidateId: body?.candidateId,
        force: body?.force === true,
        expectedHead: body?.expectedHead,
      },
    }),
  },
  'POST candidates/export': {
    permission: 'workshop',
    handler: ({ actor, body }) => {
      const candidate = existingCandidate(body?.candidateId),
        catalog = requiredMapCatalog()
      if (
        body?.mapId !== candidate.mapId ||
        !catalog.maps.some((entry) => entry.mapId === candidate.mapId)
      )
        throw bad('Кандидат не принадлежит выбранной карте.')
      return { id: writeRequest(inboxDir(), actor, { kind: 'export', candidateId: candidate.id }) }
    },
    audit: (body) => ({
      action: 'workshop-export',
      target: body?.mapId ?? null,
      detail: { candidateId: body?.candidateId },
    }),
  },
  'POST candidates/reject': {
    permission: 'workshop',
    handler: ({ actor, body }) => ({
      id: writeRequest(inboxDir(), actor, { kind: 'reject', candidateId: body?.candidateId }),
    }),
    audit: (body) => ({
      action: 'workshop-reject',
      target: body?.mapId ?? null,
      detail: { candidateId: body?.candidateId },
    }),
  },
  'POST maps/export-limbo': {
    permission: 'workshop',
    handler: ({ actor, body }) => {
      const entry = requiredMapCatalog().maps.find((map) => map.mapId === 'limbo')
      if (
        entry?.kind !== 'limbo' ||
        !digest(body?.versionDigest) ||
        !entry.versions.some((version) => version.versionDigest === body.versionDigest)
      )
        throw bad('Выбранная версия отсутствует в истории лобби прокси.')
      return {
        id: writeRequest(inboxDir(), actor, {
          kind: 'limbo-export',
          versionDigest: body.versionDigest,
        }),
      }
    },
    audit: (body) => ({
      action: 'workshop-limbo-export',
      target: 'limbo',
      detail: { versionDigest: body?.versionDigest },
    }),
  },
  'POST maps/rollback': {
    permission: 'workshop',
    handler: ({ actor, body }) => {
      const catalog = requiredMapCatalog(),
        entry = catalog.maps.find((map) => map.mapId === body?.mapId)
      if (!entry) throw bad('Неизвестная карта.')
      if (
        !digest(body?.versionDigest) ||
        !entry.versions.some((version) => version.versionDigest === body.versionDigest)
      )
        throw bad('Выбранная версия отсутствует в истории этой карты.')
      return {
        id: writeRequest(
          inboxDir(),
          actor,
          {
            kind: 'rollback',
            mapId: entry.mapId,
            versionDigest: body.versionDigest,
            expectedHead: expectedMapHead(body, entry),
          },
          new Set(catalog.maps.map((map) => map.mapId)),
        ),
      }
    },
    audit: (body) => ({
      action: 'workshop-rollback',
      target: body?.mapId ?? null,
      detail: { versionDigest: body?.versionDigest, expectedHead: body?.expectedHead },
    }),
  },
  'GET staff': {
    permission: 'roles',
    handler: async ({ actor, store }) => {
      if ((await import('./cp.ts')).cpStaffConfigured()) {
        const cp = await import('./cp.ts')
        const actorRole = await cpActorRole(cp, actor)
        if (!can(actorRole, 'roles')) throw fail(403, 'Недостаточно прав.')
        const { team } = await cpCall(() => cpTeamList(cp, store))
        const ids = owners()
        await Promise.all([...ids].map(async (uuid) => ownerName(uuid).catch(() => null)))
        const last = ((await store.auditLog(200)) as any[]).find(
          (e) => e.action === 'workshop-sync' && e.ok && e.target,
        )
        const lastSync = last
          ? {
              id: last.target,
              at: last.at,
              result: readFile(join(adminDir(), 'results', `${last.target}.json`)),
            }
          : null
        const names = new Map(
          await Promise.all(
            [...ids].map(
              async (uuid) =>
                [
                  uuid,
                  ownerNames.get(uuid) ??
                    (await knownName(store, uuid)) ??
                    (uuid === actor.uuid ? actor.name : null),
                ] as const,
            ),
          ),
        )
        const name = (uuid: string) => names.get(uuid)
        return {
          owners: [...ids].map((uuid) => ({ uuid, name: name(uuid) ?? UNKNOWN_PLAYER })),
          staff: team,
          workshop: readFile(join(adminDir(), 'members.json')),
          expected: workshopMembers(
            team,
            new Map([...ids].map((uuid) => [uuid, name(uuid) ?? ''])),
          ),
          lastSync,
        }
      }
      const ids = owners()
      await Promise.all([...ids].map(async (uuid) => ownerName(uuid).catch(() => null)))
      const last = ((await store.auditLog(200)) as any[]).find(
        (e) => e.action === 'workshop-sync' && e.ok && e.target,
      )
      const lastSync = last
        ? {
            id: last.target,
            at: last.at,
            result: readFile(join(adminDir(), 'results', `${last.target}.json`)),
          }
        : null
      const names = new Map(
        await Promise.all(
          [...ids].map(
            async (uuid) =>
              [
                uuid,
                ownerNames.get(uuid) ??
                  (await knownName(store, uuid)) ??
                  (uuid === actor.uuid ? actor.name : null),
              ] as const,
          ),
        ),
      )
      const name = (uuid: string) => names.get(uuid)
      return {
        owners: [...ids].map((uuid) => ({ uuid, name: name(uuid) ?? UNKNOWN_PLAYER })),
        staff: await store.staff(),
        workshop: readFile(join(adminDir(), 'members.json')),
        expected: workshopMembers(
          await store.staff(),
          new Map([...ids].map((uuid) => [uuid, name(uuid) ?? ''])),
        ),
        lastSync,
      }
    },
  },
  'POST staff': {
    tx: true,
    permission: 'roles',
    handler: async ({ actor, store, body }) => {
      if (body?.role !== null && !['builder', 'moderator', 'admin'].includes(body?.role))
        throw bad('Неизвестная роль.')
      if ((await import('./cp.ts')).cpStaffConfigured()) {
        const cp = await import('./cp.ts')
        const uuid = playerId(body?.uuid)
        const target = body?.uuid
          ? {
              uuid,
              name: uuid ? (await store.staff()).find((s) => s.uuid === uuid)?.name : undefined,
            }
          : await lookupName(body?.name)
        if (!target.uuid || !target.name) throw fail(404, 'Участник не найден.')
        if (target.uuid === actor.uuid) throw fail(403, 'Свою роль менять нельзя.')
        if (owners().has(target.uuid))
          throw fail(403, 'Владельцы задаются только переменной окружения сервера.')
        const actorRole = await cpActorRole(cp, actor)
        if (!can(actorRole, 'roles')) throw fail(403, 'Недостаточно прав.')
        const scope = cp.cpScope()
        const read = await cpCall(() => cp.readStaffGrantsCp(target.uuid as string))
        const from = cp.roleFromCpMe(
          { accountId: read.accountId, owner: false, grants: read.grants },
          scope,
        )
        if ((from === 'admin' || body?.role === 'admin') && !can(actorRole, 'roles-admin'))
          throw fail(403, 'Администраторов назначает только владелец.')
        const finalRole = body?.role ?? null
        const grantedRole = (finalRole ?? from ?? 'builder') as 'builder' | 'moderator' | 'admin'
        // The idempotency key is derived from the admin request (including the
        // UI's list revision): a retry of the same intent dedupes in CP, while
        // a genuinely new change after a re-read gets a new key.
        const uiRevision = Number.isSafeInteger(body?.expectedRevision)
          ? (body.expectedRevision as number)
          : null
        const idempotencyKey =
          uiRevision === null
            ? randomUUID()
            : cp.staffIdempotencyKey({
                actorAccountId: actor.uuid,
                accountUuid: target.uuid as string,
                role: grantedRole,
                revoke: finalRole === null,
                scope,
                uiRevision,
              })
        const siteRole = (role: string) => ['builder', 'moderator', 'admin'].includes(role)
        const inScope = (g: {
          environment: string
          backend: string
          resource: string
          role: string
        }) =>
          g.environment === scope.environment &&
          g.backend === scope.backend &&
          g.resource === scope.resource &&
          siteRole(g.role)
        let receipt: { operationId: string } | null = null
        let held: string[]
        try {
          receipt = await cp.postStaffGrantCp({
            accountUuid: target.uuid as string,
            role: grantedRole,
            revoke: finalRole === null,
            expectedRevision: read.expectedRevision,
            actorAccountId: actor.uuid,
            idempotencyKey,
          })
          held = read.grants.filter(inScope).map((g) => g.role)
          if (finalRole === null) held = held.filter((r) => r !== grantedRole)
          else if (!held.includes(finalRole)) held.push(finalRole)
        } catch (error) {
          if (isCpProblem(error)) throw fail(error.status, error.message)
          if (!isUnknownOutcome(error)) throw error
          // Unknown outcome: the write may still have applied. Re-read CP truth.
          const confirmed = await cp.readStaffGrantsCp(target.uuid as string).then(
            (r) => r,
            () => null,
          )
          if (!confirmed) {
            // CP unreachable: surface a retry state, mirror nothing.
            return {
              uuid: target.uuid,
              name: target.name,
              role: body?.role,
              sync: {
                error:
                  'Не удалось подтвердить изменение в CP: обновите список и при необходимости повторите.',
              },
              operationId: null,
              unknownOutcome: true,
            }
          }
          const actual = confirmed.grants.filter(inScope).map((g) => g.role)
          const landed =
            finalRole === null ? !actual.includes(grantedRole) : actual.includes(finalRole)
          if (!landed)
            throw fail(
              503,
              'Control-plane не подтвердил изменение: обновите список и при необходимости повторите.',
            )
          held = [...actual]
        }
        try {
          // CP keeps every granted role, so remove the target's other in-scope
          // site roles one by one with a fresh revision each. Foreign grants are
          // not site authority and stay untouched; leftovers past the three site
          // roles mean concurrent CP writes.
          for (let i = 0; i < 3; i++) {
            const reread = await cpCall(() => cp.readStaffGrantsCp(target.uuid as string))
            const leftover = reread.grants
              .filter((g) => inScope(g) && (finalRole === null || g.role !== finalRole))
              .map((g) => g.role)
            held = [...leftover]
            if (!leftover.length) break
            if (i === 2) throw new Error('Control-plane не сошёлся: повторные гранты.')
            await cpCall(() =>
              cp.postStaffGrantCp({
                accountUuid: target.uuid as string,
                role: leftover[0] as 'builder' | 'moderator' | 'admin',
                revoke: true,
                expectedRevision: reread.expectedRevision,
                actorAccountId: actor.uuid,
              }),
            )
          }
        } catch {
          // held already names the remainder; mirror and report below.
        }
        // The mirror reflects what CP still holds: a row is deleted only when
        // a clean read confirmed no site role (empty held). Otherwise the row
        // stays with the highest held role, so the member keeps showing up in
        // GET staff, the workshop list and the uuid retry until the retry.
        const mirrored =
          held.length > 0
            ? (held.reduce((a, b) => (SITE_ROLE_RANK[a] >= SITE_ROLE_RANK[b] ? a : b)) as
                | 'builder'
                | 'moderator'
                | 'admin')
            : finalRole
        await store.setStaff(target.uuid, target.name, mirrored, actor.name)
        // The grant above is applied; a roster read that fails here must not
        // throw it away — it lands in the sync error field instead.
        const sync = await syncCpTeam(store, actor, cp)
        return {
          uuid: target.uuid,
          name: target.name,
          role: body?.role,
          sync,
          operationId: receipt?.operationId ?? null,
          ...(held.length ? { partialApply: held } : {}),
        }
      }
      const target = body?.uuid
        ? {
            uuid: playerId(body.uuid),
            name: (await store.staff()).find((s) => s.uuid === playerId(body.uuid))?.name,
          }
        : await lookupName(body?.name)
      if (!target.uuid || !target.name) throw fail(404, 'Участник не найден.')
      const from = await roleOf(target.uuid, store)
      checkRoleChange(actor, target.uuid, from, body.role)
      await store.setStaff(target.uuid, target.name, body.role, actor.name)
      const sync = await syncWorkshop(store, actor).then(
        ({ id }) => ({ id }),
        (error: unknown) => ({
          error:
            error instanceof Response
              ? 'Не удалось отправить список в мастерскую.'
              : String((error as Error).message),
        }),
      )
      return { uuid: target.uuid, name: target.name, role: body.role, sync }
    },
    audit: (body, result) => ({
      action: body?.role === null ? 'role-revoke' : 'role-grant',
      target: result?.uuid ?? body?.uuid ?? body?.name ?? null,
      detail: {
        name: result?.name ?? body?.name,
        role: body?.role,
        sync: result?.sync,
        operationId: result?.operationId ?? null,
        partialApply: result?.partialApply ?? null,
      },
    }),
  },
  'POST staff/sync': {
    permission: 'workshop',
    handler: async ({ actor, store }) => {
      if ((await import('./cp.ts')).cpStaffConfigured()) {
        const cp = await import('./cp.ts')
        const actorRole = await cpActorRole(cp, actor)
        if (!can(actorRole, 'workshop')) throw fail(403, 'Недостаточно прав.')
        return syncCpTeam(store, actor, cp)
      }
      return syncWorkshop(store, actor)
    },
    audit: (_, result) => ({
      action: 'workshop-sync',
      target: result?.id ?? null,
      detail: { members: result?.members },
    }),
  },
  // `maps: null` means every map; only meaningful for a `builder` row, checked here rather than trusted from the client.
  'POST staff/maps': {
    permission: 'roles',
    handler: async ({ actor, store, body }) => {
      if ((await import('./cp.ts')).cpStaffConfigured()) {
        const cp = await import('./cp.ts')
        const actorRole = await cpActorRole(cp, actor)
        if (!can(actorRole, 'roles')) throw fail(403, 'Недостаточно прав.')
        const uuid = playerId(body?.uuid)
        const replica = uuid ? (await store.staff()).find((s) => s.uuid === uuid) : undefined
        if (!uuid || !replica) throw fail(404, 'Участник не найден.')
        const read = await cpCall(() => cpGrantsOrNull(cp, uuid))
        if (
          cp.roleFromCpMe(
            { accountId: read?.accountId ?? uuid, owner: false, grants: read?.grants ?? [] },
            cp.cpScope(),
          ) !== 'builder'
        )
          throw bad('Список карт задаётся только строителям.')
        const maps = body?.maps
        if (
          maps !== null &&
          (!Array.isArray(maps) ||
            new Set(maps).size !== maps.length ||
            !maps.every((id: unknown) => typeof id === 'string' && workshopMapIds().has(id)))
        )
          throw bad('Некорректный список карт.')
        // Same chain as the tablet grants: concurrent map edits queue per process.
        // Snapshot and write are one locked step, like the non-CP branch:
        // the row is re-read inside for the name.
        const row = await withStaffMapsLock(async () => {
          const fresh = (await store.staff()).find((s) => s.uuid === uuid)
          if (!fresh) throw fail(404, 'Участник не найден.')
          await store.setStaffMaps(uuid, maps)
          return fresh
        })
        const sync = await syncCpTeam(store, actor, cp)
        return { uuid, name: row.name, maps: body?.maps, sync }
      }
      const uuid = playerId(body?.uuid)
      // A full-list write racing a grant must not slip between them: same chain as the grants.
      const row = await withStaffMapsLock(async () => {
        const row = uuid ? (await store.staff()).find((s) => s.uuid === uuid) : undefined
        if (!row) throw fail(404, 'Участник не найден.')
        if (row.role !== 'builder') throw bad('Список карт задаётся только строителям.')
        // null = every map, including ones added later; [] = the builder gets a workshop account but nothing to edit.
        const maps = body?.maps
        if (
          maps !== null &&
          (!Array.isArray(maps) ||
            new Set(maps).size !== maps.length ||
            !maps.every((id: unknown) => typeof id === 'string' && workshopMapIds().has(id)))
        )
          throw bad('Некорректный список карт.')
        await store.setStaffMaps(uuid!, maps)
        return row
      })
      const sync = await syncWorkshop(store, actor).then(
        ({ id }) => ({ id }),
        (error: unknown) => ({
          error:
            error instanceof Response
              ? 'Не удалось отправить список в мастерскую.'
              : String((error as Error).message),
        }),
      )
      return { uuid, name: row.name, maps: body?.maps, sync }
    },
    audit: (body, result) => ({
      action: 'workshop-maps',
      target: result?.uuid ?? body?.uuid ?? null,
      detail: { name: result?.name, maps: body?.maps, sync: result?.sync },
    }),
  },
  // Map-centric view of the same `maps` lists: who of the builders may edit one map; one workshop sync for the whole change.
  'POST staff/map-access': {
    permission: 'roles',
    handler: async ({ actor, store, body }) => {
      if ((await import('./cp.ts')).cpStaffConfigured()) {
        const cp = await import('./cp.ts')
        const actorRole = await cpActorRole(cp, actor)
        if (!can(actorRole, 'roles')) throw fail(403, 'Недостаточно прав.')
        const mapId = body?.mapId,
          uuids = body?.uuids
        if (typeof mapId !== 'string' || !workshopMapIds().has(mapId))
          throw bad('Неизвестная карта.')
        // Builder set is CP authority; the per-builder map lists stay site-local.
        // Snapshot, filter and writes are one locked step, like the non-CP
        // branch: CP reads inside the lock keep a concurrent maps edit from
        // slipping between the snapshot and the write.
        const changed = await withStaffMapsLock(async () => {
          const { team } = await cpCall(() => cpTeamList(cp, store))
          const builders = team.filter((s) => s.role === 'builder')
          const ids = Array.isArray(uuids) ? uuids.map(playerId) : null
          if (
            !ids ||
            ids.some((id) => !id || !builders.some((b) => b.uuid === id)) ||
            new Set(ids).size !== ids.length
          )
            throw bad('Некорректный список строителей.')
          const changed = []
          for (const b of builders) {
            const maps = withMapAccess(
              b.maps ?? null,
              mapId,
              ids.includes(b.uuid),
              workshopMapIds(),
            )
            if (JSON.stringify(maps) === JSON.stringify(b.maps ?? null)) continue
            await store.setStaffMaps(b.uuid, maps)
            changed.push(b.name)
          }
          return changed
        })
        const sync = changed.length ? await syncCpTeam(store, actor, cp) : null
        return { mapId, changed, sync }
      }
      const mapId = body?.mapId,
        uuids = body?.uuids
      if (typeof mapId !== 'string' || !workshopMapIds().has(mapId)) throw bad('Неизвестная карта.')
      // Same chain as the tablet grants: the snapshot, the per-builder writes and the
      // change list are one atomic step, the workshop sync after it stays outside the lock.
      const changed = await withStaffMapsLock(async () => {
        const builders = (await store.staff()).filter((s) => s.role === 'builder')
        const ids = Array.isArray(uuids) ? uuids.map(playerId) : null
        if (
          !ids ||
          ids.some((id) => !id || !builders.some((b) => b.uuid === id)) ||
          new Set(ids).size !== ids.length
        )
          throw bad('Некорректный список строителей.')
        const changed = []
        for (const b of builders) {
          const maps = withMapAccess(b.maps ?? null, mapId, ids.includes(b.uuid), workshopMapIds())
          if (JSON.stringify(maps) === JSON.stringify(b.maps ?? null)) continue
          await store.setStaffMaps(b.uuid, maps)
          changed.push(b.name)
        }
        return changed
      })
      const sync = changed.length
        ? await syncWorkshop(store, actor).then(
            ({ id }) => ({ id }),
            (error: unknown) => ({
              error:
                error instanceof Response
                  ? 'Не удалось отправить список в мастерскую.'
                  : String((error as Error).message),
            }),
          )
        : null
      return { mapId, changed, sync }
    },
    audit: (body, result) => ({
      action: 'workshop-map-access',
      target: body?.mapId ?? null,
      detail: { changed: result?.changed, sync: result?.sync },
    }),
  },
  'GET results': {
    permission: 'stats',
    handler: async ({ context, store }) => {
      const load = async () =>
          await store.results(context.url.searchParams.get('mode') || null, page(context.url)),
        data = await load()
      const unknown = data.results.flatMap((r) =>
        r.players.filter((p) => p.name === UNKNOWN_PLAYER).map((p) => p.uuid),
      )
      return unknown.length && (await resolveNames(store, unknown)).size ? await load() : data
    },
  },
  'POST results/void': {
    permission: 'stats',
    handler: async ({ actor, store, body }) => {
      if (
        !UUID.test(body?.serverId) ||
        !UUID.test(body?.eventId) ||
        typeof body.voided !== 'boolean'
      )
        throw bad('Некорректный результат.')
      return await store.setVoided(body.serverId, body.eventId, body.voided ? actor.name : null)
    },
    audit: (body, result) => ({
      action: body?.voided ? 'result-void' : 'result-restore',
      target: `${body?.serverId}/${body?.eventId}`,
      detail: result?.match,
    }),
  },
  'GET keys': {
    permission: 'stats',
    handler: async ({ store }) => ({ keys: await store.ingestKeys() }),
  },
  'POST keys': {
    tx: true,
    permission: 'stats',
    handler: async ({ store, body }) => {
      if (!UUID.test(body?.serverId)) throw bad('ID сервера — UUID.')
      if (
        typeof body.label !== 'string' ||
        !body.label.trim() ||
        body.label.length > 64 ||
        // eslint-disable-next-line no-control-regex -- Rejecting control characters is deliberate.
        /[\x00-\x1f\x7f]/.test(body.label)
      )
        throw bad('Подпись: до 64 символов.')
      return { key: await store.createIngestKey(body.serverId, body.label.trim()) }
    },
    audit: (body) => ({
      action: 'ingest-key-create',
      target: body?.serverId ?? null,
      detail: { label: body?.label },
    }),
  },
  'POST keys/revoke': {
    tx: true,
    permission: 'stats',
    handler: async ({ store, body }) => {
      if (!Number.isSafeInteger(body?.id) || !(await store.revokeIngestKey(body.id)))
        throw fail(404, 'Ключ не найден или уже отозван.')
      return { revoked: body.id }
    },
    audit: (body) => ({ action: 'ingest-key-revoke', target: String(body?.id) }),
  },
  'GET seasons': { permission: 'stats', handler: () => ({ seasons: seasons() }) },
  'GET audit': {
    permission: 'audit',
    handler: async ({ store }) => ({
      entries: (await store.auditLog(200)).map((entry: any) => ({
        ...entry,
        detail: redactAuditDetail(entry.action, entry.detail),
      })),
    }),
  },
}
routes['POST candidates/rollback'] = routes['POST maps/rollback']

/**
 * `POST /api/workshop/access` from the workshop server (tablet «Разрешить/Запретить строить»): the same change as
 * «Кто правит» for one builder, authorised by BLOCKFIELD_WORKSHOP_KEY and then by the in-game actor's own site role.
 */
/** The workshop server's own requests: shared key (a file in the controller's admin export, both mount it read-only). */
function workshopKeyError(
  request: Request,
  env: Record<string, string | undefined>,
  methods = ['POST'],
): Response | null {
  if (!methods.includes(request.method)) return fail(405, `${methods.join('/')} only.`)
  const key = env.BLOCKFIELD_WORKSHOP_KEY || readText(join(adminDir(), 'workshop.key'))?.trim()
  if (!key || key.length < 32) return fail(503, 'Запись из мастерской не настроена.')
  const digest = (value: string) => createHash('sha256').update(value).digest()
  if (!timingSafeEqual(digest(request.headers.get('authorization') ?? ''), digest(`Bearer ${key}`)))
    return fail(401, 'Неверный ключ.')
  return null
}

/**
 * `POST /api/workshop/submit {actor, actorName, mapId, workingCopyId}`: «Отправить на проверку» from the tablet. The actor must be
 * able to build on that map by the site's own records; the controller commits and reviews without restarting.
 * `GET /api/workshop/submit?id=<receipt>` reads the controller's answer with the same shared key.
 */
export async function handleWorkshopSubmit(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  storage?: StatsStore,
): Promise<Response> {
  const refused = workshopKeyError(request, env, ['POST', 'GET'])
  if (refused) return refused
  if (request.method === 'GET')
    return Response.json(
      { result: readRequestResult(new URL(request.url).searchParams.get('id') ?? '') },
      { headers: noStore },
    )
  const body = await readJson(request, 4096)
  const actorId = playerId(body?.actor),
    mapId = body?.mapId
  if (!actorId || typeof mapId !== 'string' || !/^[a-z0-9_]{1,32}$/.test(mapId))
    return fail(400, 'Некорректный запрос.')
  const store = storage ?? (await statsStore())
  const staff = await store.staff(),
    row = staff.find((s) => s.uuid === actorId)
  // Workshop-key callers assert identity; CP is the role authority in CP mode.
  let role: Role | null
  if ((await import('./cp.ts')).cpStaffConfigured()) {
    const cp = await import('./cp.ts')
    role = await cpCall(() => cpActorRole(cp, { uuid: actorId, name: '', role: null }))
  } else {
    role = await roleOf(actorId, store)
  }
  const claimed =
    typeof body?.actorName === 'string' && nickname.test(body.actorName) ? body.actorName : null
  const actor: Actor = {
    uuid: actorId,
    name: row?.name ?? (await knownName(store, actorId)) ?? claimed ?? 'Владелец',
    role,
  }
  let error: string | null, id: string | null
  // The attempt is journaled before the effect, like staff writes: a dead log fails closed.
  const pendingId = await store
    .auditPending({
      actorUuid: actor.uuid,
      actorName: actor.name,
      role: role ?? 'none',
      action: 'workshop-candidate',
      target: mapId,
      detail: { from: 'game', request: null },
      ok: false,
      error: null,
    })
    .catch(() => {
      throw fail(503, 'Хранилище сайта недоступно: мастерская отключена.')
    })
  const finalize = (ok: boolean, error: string | null, request: string | null) =>
    store.auditFinalize(pendingId, {
      actorUuid: actor.uuid,
      actorName: actor.name,
      role: role ?? 'none',
      action: 'workshop-candidate',
      target: mapId,
      detail: { from: 'game', request },
      ok,
      error,
    })
  let applied = false
  try {
    const { catalog, entry } = await editableMap(actor, store, mapId),
      { copy, branch } = selectedMapBranch(catalog, entry)
    if (body.workingCopyId !== copy.id)
      throw fail(409, 'Рабочая копия карты уже изменилась. Вернитесь в действующую мастерскую.')
    id = writeRequest(
      inboxDir(),
      actor,
      {
        kind: 'candidate',
        mapId,
        workingCopyId: copy.id,
        branch: branch.name,
        expectedBranchHead: branch.versionDigest,
        commit: true,
        note: `С планшета: ${actor.name}`
          .replace(/\p{Cc}/gu, ' ')
          .trim()
          .slice(0, 200),
      },
      new Set(catalog.maps.map((entry) => entry.mapId)),
    )
    applied = true
    store.emitAudit(await finalize(true, null, id))
    return Response.json({ id }, { headers: noStore })
  } catch (thrown) {
    error =
      thrown instanceof Response
        ? await thrown
            .clone()
            .json()
            .then(
              (d) => d.error,
              () => 'error',
            )
        : 'internal error'
    if (!applied) {
      try {
        store.emitAudit(await finalize(false, error, null))
      } catch {
        console.error('workshop-candidate audit failed; the original error stands')
      }
      throw thrown
    }
    console.error('workshop-candidate audit finalize failed; the change may have applied')
    throw fail(503, 'Запрос применён, но журнал недоступен: проверьте состояние перед повтором.')
  }
}

export async function handleWorkshopAccess(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  storage?: StatsStore,
): Promise<Response> {
  const refused = workshopKeyError(request, env)
  if (refused) return refused
  const body = await readJson(request, 4096)
  const actorId = playerId(body?.actor),
    targetId = playerId(body?.target),
    mapId = body?.mapId
  if (
    !actorId ||
    !targetId ||
    typeof mapId !== 'string' ||
    !MAP_IDS.has(mapId) ||
    typeof body?.allowed !== 'boolean'
  )
    return fail(400, 'Некорректный запрос.')
  const store = storage ?? (await statsStore())
  // The workshop server knows the in-game nickname; the site's own record wins when it has one.
  const claimed =
    typeof body?.actorName === 'string' && nickname.test(body.actorName) ? body.actorName : null
  let actor: Actor = { uuid: actorId, name: claimed ?? 'Владелец', role: null },
    role: Role | null = null,
    target: Awaited<ReturnType<StatsStore['staff']>>[number] | undefined,
    error: string | null,
    result: any = null
  const outer = { actor, role }
  // The attempt is journaled before the effect, like staff writes: a dead log fails closed.
  // finalize() always re-reads actor/role/result, so refusals keep their resolved identity too.
  const finalize = (ok: boolean, error: string | null) =>
    store.auditFinalize(pendingId, {
      actorUuid: actor.uuid,
      actorName: actor.name,
      role: role ?? 'none',
      action: 'workshop-map-access',
      target: mapId,
      detail: {
        changed: result ? [result.name] : [],
        allowed: body.allowed,
        target: target?.name ?? targetId,
        from: 'game',
        sync: result?.sync,
      },
      ok,
      error,
    })
  const pendingId = await store
    .auditPending({
      actorUuid: actor.uuid,
      actorName: actor.name,
      role: 'none',
      action: 'workshop-map-access',
      target: mapId,
      detail: { changed: [], allowed: body.allowed, target: targetId, from: 'game' },
      ok: false,
      error: null,
    })
    .catch(() => {
      throw fail(503, 'Хранилище сайта недоступно: мастерская отключена.')
    })
  let applied = false
  try {
    // The read and the write bracket awaits, so concurrent grants queue on one chain (see
    // withStaffMapsLock) instead of overwriting each other from the same snapshot.
    const edit = await withStaffMapsLock(async () => {
      const staff = await store.staff()
      // Workshop-key callers assert identity; CP is the role authority in CP
      // mode. Snapshot, checks and write are one locked step.
      let role: Role | null
      let targetIsBuilder: boolean
      if ((await import('./cp.ts')).cpStaffConfigured()) {
        const cp = await import('./cp.ts')
        role = await cpCall(() => cpActorRole(cp, { uuid: actorId, name: '', role: null }))
        const targetRead = await cpCall(() => cpGrantsOrNull(cp, targetId))
        targetIsBuilder =
          cp.roleFromCpMe(
            {
              accountId: targetRead?.accountId ?? targetId,
              owner: false,
              grants: targetRead?.grants ?? [],
            },
            cp.cpScope(),
          ) === 'builder'
      } else {
        role = await roleOf(actorId, store)
        targetIsBuilder = staff.find((s) => s.uuid === targetId)?.role === 'builder'
      }
      const actor: Actor = {
        uuid: actorId,
        name:
          staff.find((s) => s.uuid === actorId)?.name ??
          (await knownName(store, actorId)) ??
          claimed ??
          'Владелец',
        role,
      }
      // A refused grant is audited too: record who tried before any permission check throws.
      outer.actor = actor
      outer.role = role
      const target = staff.find((s) => s.uuid === targetId)
      if (!role || !can(role, 'roles')) throw fail(403, 'Менять права может только администратор.')
      if (!target || !targetIsBuilder)
        throw fail(400, 'Права по картам задаются только строителям.')
      const maps = withMapAccess(target.maps ?? null, mapId, body.allowed)
      await store.setStaffMaps(targetId, maps)
      return { actor, role, target, maps }
    })
    ;({ actor, role, target } = edit)
    const cpLib = await import('./cp.ts')
    const sync = cpLib.cpStaffConfigured()
      ? await syncCpTeam(store, actor, cpLib)
      : await syncWorkshop(store, actor).then(
          ({ id }) => ({ id }),
          (error: unknown) => ({
            error:
              error instanceof Response
                ? 'Не удалось отправить список в мастерскую.'
                : String((error as Error).message),
          }),
        )
    result = { mapId, name: edit.target.name, maps: edit.maps, sync }
    applied = true
    store.emitAudit(await finalize(true, null))
    return result instanceof Response ? result : Response.json(result, { headers: noStore })
  } catch (thrown) {
    ;({ actor, role } = outer)
    error =
      thrown instanceof Response
        ? await thrown
            .clone()
            .json()
            .then(
              (d) => d.error,
              () => 'error',
            )
        : 'internal error'
    if (!applied) {
      try {
        store.emitAudit(await finalize(false, error))
      } catch {
        console.error('workshop-map-access audit failed; the original error stands')
      }
      throw thrown
    }
    console.error('workshop-map-access audit finalize failed; the change may have applied')
    throw fail(503, 'Запрос применён, но журнал недоступен: проверьте состояние перед повтором.')
  }
}

/** Every /api/admin/* call: session → role → permission; every administrative write is audited, including refusals and failures. */
export async function handleAdmin(
  context: APIContext,
  path: string,
  storage?: StatsStore,
): Promise<Response> {
  const method = context.request.method
  let store: StatsStore, actor: Actor
  // Roles and the audit log live in the statistics DB: without it nobody gets in.
  try {
    store = storage ?? (await statsStore())
    actor = await currentActor(context, store)
  } catch (error) {
    if (error instanceof StatsError)
      throw fail(503, 'Хранилище сайта недоступно: админка отключена.')
    throw error
  }
  if (method === 'GET' && path === 'me')
    return Response.json(
      {
        uuid: actor.uuid,
        name: actor.name,
        role: actor.role,
        permissions: permissions(actor.role),
      },
      { headers: noStore },
    )
  if ((method === 'GET' && path === 'events') || (method === 'POST' && path === 'presence')) {
    if (!can(actor.role, 'view')) return fail(403, 'Нет доступа.')
    if (path === 'events')
      return eventStream(context.request, actor, () => refreshRole(actor, store))
    // Heartbeats describe transient presence, not administrative changes.
    const body = await readJson(context.request, 4096)
    if (typeof body?.tab !== 'string' || !/^[a-z-]{1,24}$/.test(body.tab))
      return bad('Некорректная вкладка.')
    return Response.json({ presence: heartbeat(actor, body.tab) }, { headers: noStore })
  }
  const route = routes[`${method} ${path}`]
  if (!route) return fail(404, 'Неизвестный запрос.')
  // Non-staff are refused before the body is read and never reach the audit log, so they cannot grow it.
  if (!actor.role) return fail(403, 'Нет доступа.')
  // A stolen staff session can neither flood the inbox nor spam chat: writes share one throttle.
  if (method !== 'GET' && throttled(actor.uuid))
    return fail(429, 'Слишком много попыток. Подождите минуту.')
  let body: any,
    result: any,
    pendingId: number | null = null
  try {
    if (!can(actor.role, route.permission)) throw fail(403, 'Недостаточно прав.')
    if (method === 'GET') {
      result = await route.handler({ context, actor, store, body })
      return result instanceof Response ? result : Response.json(result, { headers: noStore })
    }
    body = await readJson(context.request, route.maxBody ?? 65_536)
    // The attempt is journaled before the effect runs: when the log is down,
    // nothing runs at all, so nothing goes unaudited.
    pendingId = await store.auditPending({
      actorUuid: actor.uuid,
      actorName: actor.name,
      role: actor.role,
      ...((await route.audit?.(body, undefined)) ?? { action: 'unknown' }),
      ok: false,
      error: null,
    })
    let applied = false
    const finalize = (ok: boolean, error: string | null) =>
      store.auditFinalize(pendingId!, {
        actorUuid: actor.uuid,
        actorName: actor.name,
        role: actor.role ?? 'none',
        ...((route.audit ? route.audit(body, result) : undefined) ?? { action: 'unknown' }),
        ok,
        error,
      })
    try {
      // Pure DB effects share one transaction with the finalize; RCON and file
      // effects cannot, so they finalize right after the handler instead.
      // applied flips only after the commit: a rolled-back effect never ran.
      // The live event goes out after the commit too: rolled-back rows never show as ok.
      if (route.tx) {
        let row
        await store.db.transaction(async () => {
          result = await route.handler({ context, actor, store, body })
          row = await finalize(true, null)
        })
        applied = true
        store.emitAudit(row)
      } else {
        result = await route.handler({ context, actor, store, body })
        applied = true
        store.emitAudit(await finalize(true, null))
      }
    } catch (inner) {
      const { response, message } = await adminError(inner)
      const detail =
        (inner as any)?.internal != null ? `${message} (${(inner as any).internal})` : message
      if (!applied) {
        try {
          store.emitAudit(await finalize(false, detail))
        } catch {
          console.error(`admin audit failed for ${method} ${path}; the original error stands`)
        }
        throw response
      }
      // The effect ran but the finalize did not: high-risk routes fail closed so
      // the operator verifies state instead of blindly retrying; the rest warn.
      console.error(
        `admin audit finalize failed for ${method} ${path}; the change may have applied`,
      )
      if (highRisk(method, path, body))
        throw fail(
          503,
          'Изменение, возможно, применено, но журнал недоступен: проверьте состояние перед повтором.',
        )
      return respond(result, AUDIT_WARNING)
    }
    return respond(result, null)
  } catch (thrown) {
    const { response, message } = await adminError(thrown)
    // Refusals (and anything before the pending row) are journaled once, as before.
    if (method !== 'GET' && pendingId === null) {
      try {
        await record(
          store,
          actor,
          route,
          body,
          result,
          (thrown as any)?.internal ? `${message} (${(thrown as any).internal})` : message,
        )
      } catch {
        console.error(`admin audit failed for ${method} ${path}; the original error stands`)
      }
    }
    throw response
  }
}
/** Routes whose retry must never silently re-run: roles, bans, raw console, mode switches. */
const HIGH_RISK_ROUTES = new Set([
  'POST staff',
  'POST staff/maps',
  'POST staff/map-access',
  'POST rcon/raw',
  'POST mode',
  'POST cancel',
])
function highRisk(method: string, path: string, body: any): boolean {
  const key = `${method} ${path}`
  if (HIGH_RISK_ROUTES.has(key)) return true
  return key === 'POST rcon' && (body?.action === 'ban' || body?.action === 'pardon')
}
const AUDIT_WARNING =
  'Изменение применено, но не записано в журнал: не повторяйте запрос вслепую, проверьте состояние.'
/** Header values must stay ASCII: the human-readable warning travels in the JSON field. */
const AUDIT_WARNING_HEADER = 'audit-write-failed'
function respond(result: any, warning: string | null) {
  if (result instanceof Response) {
    if (!warning) return result
    const headers = new Headers(result.headers)
    headers.set('X-Audit-Warning', AUDIT_WARNING_HEADER)
    return new Response(result.body, { status: result.status, headers })
  }
  return Response.json(
    warning && result !== null && typeof result === 'object' && !Array.isArray(result)
      ? { ...result, auditWarning: warning }
      : result,
    { headers: warning ? { ...noStore, 'X-Audit-Warning': AUDIT_WARNING_HEADER } : noStore },
  )
}
async function adminError(thrown: unknown): Promise<{ response: Response; message: string }> {
  const error = thrown instanceof StatsError ? fail(thrown.status, thrown.message) : thrown
  const message =
    error instanceof Response
      ? await error
          .clone()
          .json()
          .then(
            (d) => d.error,
            () => 'error',
          )
      : 'internal error'
  return { response: error instanceof Response ? error : fail(500, 'internal error'), message }
}
async function record(
  store: StatsStore,
  actor: Actor,
  route: Route,
  body: any,
  result: any,
  error: string | null,
) {
  const entry = (await route.audit?.(body, result)) ?? { action: 'unknown' }
  await store.audit({
    actorUuid: actor.uuid,
    actorName: actor.name,
    role: actor.role ?? 'none',
    ...entry,
    ok: error === null,
    error,
  })
}

/** Control-plane settings path (CP-S3b): one file section = one v2 namespace.
 * Active only when cpConfigured(); otherwise the file writers above stay
 * authoritative. The namespaces (rooms, deathmatch, classLocks, campaign,
 * parcool, gunBalance, kits, disabledMapIds, ai-limits, workshop-ai, plus the
 * gameplay core) come from control-plane PR #21. CP is the source of truth:
 * after the PATCH jobs the settings mirror is rebuilt from a fresh CP GET
 * (via mirrorFromCp, never from the request body), so omitted sections and
 * concurrent saves cannot drop each other; CP-mode saves are serialized on
 * one in-process mutex. Failure classes: 409/4xx means not applied (report
 * it); a timeout, network error or 5xx means outcome unknown — re-read CP
 * and, if it shows the intended value, treat the job as applied, else report
 * unknown and ask for a reload before retrying. The mirror is still refreshed
 * whenever CP answers. CP PATCH follows RFC 7396 (control-plane#25): a patch null
 * deletes its key recursively and validates like any other change, so dict
 * namespaces may become empty; absent keys are untouched. The only
 * stored-null exception is `kits.fixedModeKits.<mode>` ("kit id or null"):
 * null clears the fixed kit but keeps the explicit entry. Verified against
 * control-plane main (cpv2/settings.py merge, core.py settings_change). */
const cpSettingsTarget = '*'

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const pick = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]))

type CpSectionView = { initialized: boolean; revision: number; value: unknown }

async function cpReadViews(namespaces: string[]) {
  const cp = await import('./cp.ts')
  const entries = await Promise.all(
    namespaces.map(async (namespace) => {
      try {
        const view = (await cp.readSettingsCp(namespace)) as CpSectionView
        return [namespace, view] as const
      } catch {
        return [namespace, null] as const
      }
    }),
  )
  return { cp, views: new Map<string, CpSectionView | null>(entries) }
}

let cpSaveChain: Promise<void> = Promise.resolve()
async function cpSaving<T>(job: () => Promise<T>): Promise<T> {
  const run = cpSaveChain.then(job)
  cpSaveChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

type CpJob = {
  kind: 'patch'
  namespace: string
  patch: Record<string, unknown>
  conflict: string
  base: number
}

/** Failure classes: 4xx was never applied; anything else is unknown. */
function cpClassify(error: unknown): {
  kind: 'conflict' | 'rejected' | 'unknown'
  status: number
  code: string
} {
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : 0
  const code = typeof (error as any)?.code === 'string' ? (error as any).code : ''
  if (
    status === 409 ||
    code === 'revision_conflict' ||
    code === 'idempotency_conflict' ||
    /ревизия \d+/.test((error as Error)?.message ?? '')
  )
    return { kind: 'conflict', status: 409, code }
  if (status >= 400 && status < 500) return { kind: 'rejected', status, code }
  return { kind: 'unknown', status, code }
}

const cpSectionLabel: Record<string, string> = {
  gameplay: 'lobby',
  rooms: 'rooms',
  deathmatch: 'deathmatch',
  classLocks: 'classLocks',
  campaign: 'campaignBalance',
  parcool: 'parcool',
  gunBalance: 'gunBalance',
  kits: 'kits',
  disabledMapIds: 'disabledMapIds',
  'ai-limits': 'ai-limits',
  'workshop-ai': 'workshop-ai',
}
const labelOf = (namespace: string) => cpSectionLabel[namespace] ?? namespace

/** Changed-only job against the carried base revision; null when nothing changed. */
function cpChangedJob(
  body: any,
  views: Map<string, CpSectionView | null>,
  namespace: string,
  patch: Record<string, unknown>,
  currentShape: unknown,
  conflict: string,
): CpJob | null {
  const view = views.get(namespace) ?? null
  if (!view) throw fail(503, 'Control-plane недоступен. Настройки не изменены.')
  if (stable(patch) === stable(currentShape)) return null
  if (!view.initialized) return { kind: 'patch', namespace, patch, conflict, base: 0 }
  const base = body?.cpRevisions?.[namespace]
  if (!Number.isSafeInteger(base)) throw fail(409, conflict)
  return { kind: 'patch', namespace, patch, conflict, base }
}

/**
 * RFC 7396 diff for a CP Settings PATCH (control-plane#25: null deletes
 * recursively, only `fixedModeKits` keeps null as a stored value meaning
 * "no fixed kit"). Returns the merge-patch fragment, or undefined when
 * nothing changed. Removed keys become null, except directly under
 * fixedModeKits where a missing mode means "unchanged" (an explicit null in
 * `desired` still travels as the clearing value). Unchanged keys are absent.
 */
const CP_NULL_VALUED_PARENTS = new Set(['fixedModeKits'])

function cpMergePatch(
  desired: Record<string, unknown>,
  current: Record<string, unknown>,
  parent?: string,
): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(desired)) {
    if (!Object.hasOwn(current, key)) {
      patch[key] = value
      continue
    }
    const have = current[key]
    if (stable(value) === stable(have)) continue
    if (plain(value) && plain(have)) {
      const nested = cpMergePatch(value, have, key)
      if (nested !== undefined) patch[key] = nested
    } else patch[key] = value
  }
  for (const key of Object.keys(current)) {
    if (Object.hasOwn(desired, key)) continue
    if (parent !== undefined && CP_NULL_VALUED_PARENTS.has(parent)) continue
    patch[key] = null
  }
  return Object.keys(patch).length ? patch : undefined
}

/**
 * Reset fragment for a whole map field: an emptied dict deletes its parent
 * key (`{"<field>": null}`), which CP validates as fresh defaults; a
 * partially emptied dict diffs per key above. Never used for
 * fixedModeKits, whose missing modes are not removals.
 */
function cpResetFragment(
  desired: Record<string, unknown>,
  current: Record<string, unknown>,
  parent: string,
): Record<string, unknown> | null | undefined {
  if (!Object.keys(desired).length && Object.keys(current).length) return null
  return cpMergePatch(desired, current, parent)
}

/** Intended patch keys already visible in a fresh CP read: the job applied. A patch null counts as applied when the key is absent. */
function cpPatchApplied(view: CpSectionView | null, patch: Record<string, unknown>): boolean {
  if (!view?.initialized) return false
  return cpPatchVisible(patch, (view.value ?? {}) as Record<string, unknown>)
}

function cpPatchVisible(patch: Record<string, unknown>, current: unknown): boolean {
  if (!plain(current)) return false
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(current, key)) {
      if (value !== null) return false
      continue
    }
    if (value === null) return false // present where deletion was intended
    const have = (current as Record<string, unknown>)[key]
    if (plain(value) && plain(have)) {
      if (!cpPatchVisible(value, have)) return false
    } else if (stable(value) !== stable(have)) return false
  }
  return true
}

async function cpReadOne(cp: any, namespace: string): Promise<CpSectionView | null> {
  try {
    return (await cp.readSettingsCp(namespace)) as CpSectionView
  } catch {
    return null
  }
}

/**
 * Best-effort mirror rebuild from CP (never from the request body), so the
 * mirror always reflects what CP confirms. Transport keys (cpRevisions) are
 * stripped before stamping: they belong to the response, not to the files.
 */
async function cpRebuildMirror(args: {
  directory: string
  fileName: string
  revision: number
  actorName: string
  rebuild: () => Promise<{ value: any; cpRevisions: Record<string, number> }>
  /**
   * ai-limits.json keeps the exact file-mode contract: validateAiLimits
   * rejects unknown keys, so a stamped mirror (updatedAt/updatedBy) would
   * break every second CP save with a 503. Stamp only schema/revision there.
   */
  stamp?: boolean
}): Promise<{ value: any; cpRevisions: Record<string, number> } | null> {
  try {
    const view = await args.rebuild()
    const stamped = {
      ...(view.value as Record<string, unknown>),
      schema: 1,
      revision: args.revision + 1,
      ...(args.stamp === false ? {} : { updatedAt: Date.now(), updatedBy: args.actorName }),
    }
    delete (stamped as Record<string, unknown>).cpRevisions
    writeAtomic(args.directory, args.fileName, stamped)
    return { value: stamped, cpRevisions: view.cpRevisions }
  } catch {
    return null
  }
}

/**
 * Shared settle: run the jobs in order with deterministic idempotency keys,
 * then rebuild the mirror from CP. 409/4xx means not applied (report what was
 * saved vs pending); timeout/network/5xx means unknown — re-read CP, and if
 * it shows the intended value treat the job as applied, else report unknown.
 */
async function cpSettleSave(args: {
  cp: any
  directory: string
  fileName: string
  revision: number
  actorName: string
  jobs: CpJob[]
  rebuild: () => Promise<{ value: any; cpRevisions: Record<string, number> }>
  stamp?: boolean
}): Promise<{ value: any; cpRevisions: Record<string, number> }> {
  const { cp, jobs, revision } = args
  const joined = (list: CpJob[]) =>
    list.length ? ` (${list.map((job) => labelOf(job.namespace)).join(', ')})` : ''
  const revs = new Map<string, number>()
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index]
    const base = job.base === 0 && revs.has(job.namespace) ? revs.get(job.namespace)! : job.base
    try {
      const receipt = (await cp.patchSettingsCp(job.namespace, cpSettingsTarget, {
        expectedRevision: base,
        idempotencyKey: `site:${revision}:${job.namespace}:${job.kind}:${index}`,
        patch: job.patch,
      })) as { operationId: string; revision: number }
      revs.set(job.namespace, receipt.revision)
    } catch (error) {
      const problem = cpClassify(error)
      if (
        problem.kind === 'unknown' &&
        cpPatchApplied(await cpReadOne(cp, job.namespace), job.patch)
      )
        continue
      const built = await cpRebuildMirror(args)
      const mirrorNote = built ? ' Зеркало обновлено.' : ''
      if (problem.kind === 'unknown')
        throw fail(
          503,
          `Неизвестный итог (${labelOf(job.namespace)}): control-plane не подтвердил изменение. Обновите страницу перед повтором.${mirrorNote}`,
        )
      if (problem.kind === 'conflict')
        throw fail(
          409,
          `${job.conflict} Сохранено${joined(jobs.slice(0, index))}; не применено${joined(jobs.slice(index))}.${mirrorNote}`,
        )
      throw fail(
        problem.status || 503,
        `Control-plane отклонил запрос (${problem.code || 'unknown'}).${jobs.slice(0, index).length ? ` Сохранено${joined(jobs.slice(0, index))}.` : ' Ничего не сохранено.'}${jobs.slice(index).length ? ` Не применено${joined(jobs.slice(index))}.` : ''}${mirrorNote}`,
      )
    }
  }
  const built = await cpRebuildMirror(args)
  if (!built)
    throw fail(
      503,
      'Control-plane saved, but the local mirror could not be written; reload before retrying.',
    )
  return built
}
const CP_LOBBY_FIELDS = ['pvpEnabled']

export async function saveSettingsCp(
  directory: string,
  body: any,
  actorName: string,
  gunBalanceOnly = false,
) {
  if (!plain(body)) throw bad('Некорректные настройки.')
  const current = readSettings(directory).settings
  const revision = Number.isSafeInteger(current?.revision) ? current.revision : 0
  if (body.expectedRevision !== revision)
    throw fail(409, 'Настройки уже изменил кто-то другой. Обновите страницу.')
  const editingGuns = gunBalanceOnly || Object.hasOwn(body, 'gunBalance')
  const availability = editingGuns ? readGunBalance(directory) : null
  if (editingGuns && !availability?.available) throw fail(503, 'Каталог баланса оружия недоступен.')
  const catalog = availability?.available ? availability.catalog : undefined
  let values: Record<string, unknown>
  if (gunBalanceOnly) {
    if (
      Object.keys(body).some(
        (key) => !['expectedRevision', 'cpRevisions', 'gunBalance'].includes(key),
      )
    )
      throw bad('Некорректные настройки оружия.')
    values = {
      ...current,
      gunBalance: validateGunOverrides(
        Object.hasOwn(body, 'gunBalance') ? body.gunBalance : {},
        catalog!,
      ),
    }
  } else {
    values = validateSettings(body, catalog)
  }
  if (!gunBalanceOnly && Object.hasOwn(body, 'lobby')) {
    const extra = Object.keys((body.lobby ?? {}) as object).filter(
      (key) => !CP_LOBBY_FIELDS.includes(key),
    )
    if (extra.length)
      throw fail(
        422,
        `Control-plane does not have these lobby fields yet: ${extra.join(', ')}. Сохранение отклонено, зеркало не тронуто.`,
      )
  }
  return cpSaving(async () => {
    const needed = gunBalanceOnly
      ? ['gunBalance']
      : [
          'gameplay',
          'rooms',
          'deathmatch',
          'classLocks',
          'campaign',
          'parcool',
          ...(Object.hasOwn(body, 'gunBalance') ? ['gunBalance'] : []),
        ]
    const { cp, views } = await cpReadViews(needed)
    const conflict = 'Настройки уже изменил кто-то другой. Обновите страницу.'
    const jobs: CpJob[] = []
    const queue = (namespace: string, patch: Record<string, unknown>, currentShape: unknown) => {
      const job = cpChangedJob(body, views, namespace, patch, currentShape, conflict)
      if (job) jobs.push(job)
    }
    const viewValue = (namespace: string) =>
      (views.get(namespace)?.value ?? {}) as Record<string, unknown>
    if (!gunBalanceOnly) {
      if (Object.hasOwn(body, 'lobby')) {
        const lobby = values.lobby as Record<string, unknown>
        queue('gameplay', { lobby }, { lobby: viewValue('gameplay').lobby })
      }
      if (Object.hasOwn(body, 'rooms'))
        queue('rooms', values.rooms as Record<string, unknown>, nonNullSection(viewValue('rooms')))
      if (Object.hasOwn(body, 'deathmatch'))
        queue(
          'deathmatch',
          values.deathmatch as Record<string, unknown>,
          nonNullSection(viewValue('deathmatch')),
        )
      if (Object.hasOwn(body, 'classLocks') || Object.hasOwn(body, 'classCosts')) {
        const patch: Record<string, unknown> = {}
        if (values.classLocks !== undefined) patch.classLocks = values.classLocks
        if (values.classCosts !== undefined) patch.classCosts = values.classCosts
        queue(
          'classLocks',
          patch,
          pick(
            {
              classLocks: viewValue('classLocks').classLocks,
              classCosts: viewValue('classLocks').classCosts,
            },
            Object.keys(patch),
          ),
        )
      }
      if (Object.hasOwn(body, 'campaignBalance')) {
        const desiredBalance = values.campaignBalance as Record<string, unknown>
        const currentBalance = (viewValue('campaign').campaignBalance ?? {}) as Record<
          string,
          unknown
        >
        const fragment = cpResetFragment(desiredBalance, currentBalance, 'campaignBalance')
        if (fragment !== undefined)
          queue('campaign', { campaignBalance: fragment }, { campaignBalance: currentBalance })
      }
      if (Object.hasOwn(body, 'parcool'))
        queue(
          'parcool',
          values.parcool as Record<string, unknown>,
          pick(viewValue('parcool'), Object.keys(values.parcool as object)),
        )
    }
    if (editingGuns) {
      const gunValue = (values.gunBalance ?? {}) as Record<string, unknown>
      const currentOverrides = (viewValue('gunBalance').overrides ?? {}) as Record<string, unknown>
      const fragment = cpResetFragment(gunValue, currentOverrides, 'overrides')
      if (fragment !== undefined)
        queue('gunBalance', { overrides: fragment }, { overrides: currentOverrides })
    }
    const built = await cpSettleSave({
      cp,
      directory,
      fileName: 'settings.json',
      revision,
      actorName,
      jobs,
      rebuild: async () => {
        const view = await readSettingsCpView(directory)
        return { value: view.settings, cpRevisions: view.cpRevisions ?? {} }
      },
    })
    return { settings: built.value, cpRevisions: built.cpRevisions }
  })
}
export async function saveKitSettingsCp(directory: string, body: any, actorName: string) {
  if (
    !plain(body) ||
    Object.keys(body).some(
      (key) => !['expectedRevision', 'cpRevisions', 'kits', 'fixedModeKits'].includes(key),
    )
  )
    throw bad('Некорректные настройки наборов.')
  const current = storedSettings(directory)
  if (current.schema !== 1 || !Number.isSafeInteger(current.revision) || current.revision < 0)
    throw fail(503, 'Текущие настройки повреждены. Сохранение недоступно.')
  if (body.expectedRevision !== current.revision)
    throw fail(409, 'Настройки уже изменил кто-то другой. Обновите страницу.')
  const availability = readKits(directory)
  if (!availability.available) throw fail(503, availability.error)
  let changes: ReturnType<typeof validateKitChanges>
  try {
    changes = validateKitChanges(
      body.kits,
      body.fixedModeKits,
      availability.catalog,
      current.classCosts ?? {},
    )
  } catch (error) {
    throw bad((error as Error).message)
  }
  const conflict = 'Настройки уже изменил кто-то другой. Обновите страницу.'
  return cpSaving(async () => {
    const { cp, views } = await cpReadViews(['kits'])
    const view = views.get('kits') ?? null
    if (!view) throw fail(503, 'Control-plane недоступен. Настройки не изменены.')
    const hasKits = Object.hasOwn(body, 'kits')
    const hasFixed = Object.hasOwn(body, 'fixedModeKits')
    const desired = {
      kits: hasKits ? (changes.kits ?? {}) : ((view.value as any)?.kits ?? {}),
      fixedModeKits: hasFixed
        ? (changes.fixedModeKits ?? {})
        : ((view.value as any)?.fixedModeKits ?? {}),
    }
    const currentShape = {
      kits: (view.value as any)?.kits ?? {},
      fixedModeKits: (view.value as any)?.fixedModeKits ?? {},
    }
    const jobs: CpJob[] = []
    {
      const patch: Record<string, unknown> = {}
      if (hasKits) {
        const kitsFragment = cpResetFragment(
          desired.kits as Record<string, unknown>,
          (currentShape.kits ?? {}) as Record<string, unknown>,
          'kits',
        )
        if (kitsFragment !== undefined) patch.kits = kitsFragment
      }
      if (hasFixed) {
        const fixedFragment = cpMergePatch(
          desired.fixedModeKits as Record<string, unknown>,
          (currentShape.fixedModeKits ?? {}) as Record<string, unknown>,
          'fixedModeKits',
        )
        if (fixedFragment !== undefined) patch.fixedModeKits = fixedFragment
      }
      if (Object.keys(patch).length) {
        if (!view.initialized)
          jobs.push({ kind: 'patch', namespace: 'kits', patch, conflict, base: 0 })
        else {
          const base = (body as any)?.cpRevisions?.kits
          if (!Number.isSafeInteger(base)) throw fail(409, conflict)
          jobs.push({ kind: 'patch', namespace: 'kits', patch, conflict, base })
        }
      }
    }
    const built = await cpSettleSave({
      cp,
      directory,
      fileName: 'settings.json',
      revision: current.revision,
      actorName,
      jobs,
      rebuild: async () => {
        const view = await readSettingsCpView(directory)
        return { value: view.settings, cpRevisions: view.cpRevisions ?? {} }
      },
    })
    return { settings: built.value, cpRevisions: built.cpRevisions }
  })
}

export async function saveMapAvailabilityCp(directory: string, body: any, actorName: string) {
  if (
    !plain(body) ||
    !mapId(body.mapId) ||
    typeof body.enabled !== 'boolean' ||
    !Number.isSafeInteger(body.expectedRevision)
  )
    throw bad('Укажите карту и её доступность для новых матчей.')
  const availability = mapAvailability(directory)
  if (!availability.available) throw fail(503, availability.error)
  if (body.expectedRevision !== availability.revision)
    throw fail(409, 'Настройки уже изменил кто-то другой. Обновите историю; черновики сохранены.')
  const conflict = 'Настройки уже изменил кто-то другой. Обновите историю; черновики сохранены.'
  return cpSaving(async () => {
    const { cp, views } = await cpReadViews(['disabledMapIds'])
    const disabled = new Set(availability.disabledMapIds)
    if (body.enabled) disabled.delete((body as any).mapId)
    else disabled.add((body as any).mapId)
    if (disabled.size > 4096) throw bad('Слишком много отключённых карт.')
    const patch = { disabledMapIds: [...disabled].sort() }
    const view = views.get('disabledMapIds') ?? null
    if (!view) throw fail(503, 'Control-plane недоступен. Настройки не изменены.')
    const jobs: CpJob[] = []
    const currentShape = { disabledMapIds: (view.value as any)?.disabledMapIds ?? [] }
    if (stable(patch) !== stable(currentShape)) {
      if (!view.initialized)
        jobs.push({ kind: 'patch', namespace: 'disabledMapIds', patch, conflict, base: 0 })
      else {
        const base = (body as any)?.cpRevisions?.disabledMapIds
        if (!Number.isSafeInteger(base)) throw fail(409, conflict)
        jobs.push({ kind: 'patch', namespace: 'disabledMapIds', patch, conflict, base })
      }
    }
    const built = await cpSettleSave({
      cp,
      directory,
      fileName: 'settings.json',
      revision: availability.revision,
      actorName,
      jobs,
      rebuild: async () => {
        const view = await readSettingsCpView(directory)
        return { value: view.settings, cpRevisions: view.cpRevisions ?? {} }
      },
    })
    return { settings: built.value, cpRevisions: built.cpRevisions }
  })
}

export async function saveAiLimitsCp(directory: string, body: any, actorRole: Role | null) {
  if (actorRole !== 'owner') throw fail(403, 'Недостаточно прав.')
  if (
    !plain(body) ||
    Object.keys(body).some(
      (key) => !['expectedRevision', 'cpRevisions', 'mode', 'sessions', 'builders'].includes(key),
    ) ||
    (body.mode !== 'session' && body.mode !== 'builder')
  )
    throw bad('Бюджет AI: некорректные настройки.')
  const current = readAiLimits(directory)
  if (body.expectedRevision !== current.revision)
    throw fail(409, 'Бюджет AI уже изменил кто-то другой. Обновите состояние; черновик сохранён.')
  if (current.revision === Number.MAX_SAFE_INTEGER)
    throw fail(503, 'Ревизия бюджета AI исчерпана. Сохранение отключено.')
  const sessions = Object.hasOwn(body, 'sessions')
    ? validateAiAccounts(body.sessions)
    : current.sessions
  const builders = Object.hasOwn(body, 'builders')
    ? validateAiAccounts(body.builders)
    : current.builders
  const conflict = 'Бюджет AI уже изменил кто-то другой. Обновите состояние; черновик сохранён.'
  return cpSaving(async () => {
    const { cp, views } = await cpReadViews(['ai-limits'])
    const view = views.get('ai-limits') ?? null
    if (!view) throw fail(503, 'Control-plane недоступен. Настройки не изменены.')
    const value = (view.value ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (body.mode !== value.mode) patch.mode = body.mode
    if ((value.currency ?? 'USD') !== 'USD') patch.currency = 'USD'
    const sessionsFragment = cpResetFragment(
      sessions as Record<string, unknown>,
      (value.sessions ?? {}) as Record<string, unknown>,
      'sessions',
    )
    if (sessionsFragment !== undefined) patch.sessions = sessionsFragment
    const buildersFragment = cpResetFragment(
      builders as Record<string, unknown>,
      (value.builders ?? {}) as Record<string, unknown>,
      'builders',
    )
    if (buildersFragment !== undefined) patch.builders = buildersFragment
    const jobs: CpJob[] = []
    if (Object.keys(patch).length) {
      if (!view.initialized)
        jobs.push({ kind: 'patch', namespace: 'ai-limits', patch, conflict, base: 0 })
      else {
        const base = (body as any)?.cpRevisions?.['ai-limits']
        if (!Number.isSafeInteger(base)) throw fail(409, conflict)
        jobs.push({ kind: 'patch', namespace: 'ai-limits', patch, conflict, base })
      }
    }
    const built = await cpSettleSave({
      cp,
      directory,
      fileName: 'ai-limits.json',
      revision: current.revision,
      actorName: String(actorRole),
      jobs,
      stamp: false,
      rebuild: async () => {
        const view = (await readAiLimitsCpView(directory)) as Record<string, unknown>
        return { value: view, cpRevisions: (view.cpRevisions ?? {}) as Record<string, number> }
      },
    })
    return { policy: built.value, cpRevisions: built.cpRevisions }
  })
}

export async function saveWorkshopAiSettingsCp(
  directory: string,
  body: any,
  hasKey: (provider: string) => boolean,
) {
  if (
    !plain(body) ||
    Object.keys(body).some(
      (key) =>
        ![
          'expectedRevision',
          'cpRevisions',
          'enabled',
          'provider',
          'generationProvider',
          // Retired guard-model keys (ws#53): an admin tab opened before the update still
          // sends them; accepted and dropped.
          'guardProvider',
          'transcriptionProvider',
          'providers',
          'generationModel',
          'guardModel',
          'transcriptionModel',
          'cleanupModel',
          'cleanupProvider',
          'maxBlocks',
          'blocksPerTick',
          'minimumBuildTicks',
          'applyBudgetMs',
          'hourlyRequestLimit',
          'hourlyPlayerRequestLimit',
          'maxHourlyBuilders',
          'generationMaxPricePromptUsdPerM',
          'generationMaxPriceCompletionUsdPerM',
          'inputGuardEnabled',
        ].includes(key),
    )
  )
    throw bad('AI мастерской: некорректные настройки.')
  const current = readWorkshopAiSettings(directory)
  if (body.expectedRevision !== current.revision)
    throw fail(409, 'Настройки AI мастерской уже изменил кто-то другой. Обновите страницу.')
  if (current.revision === Number.MAX_SAFE_INTEGER)
    throw fail(503, 'Ревизия настроек AI исчерпана. Сохранение отключено.')
  const settings = validateWorkshopAiSettings({
    schema: 1,
    revision: current.revision + 1,
    enabled: body.enabled,
    provider: body.provider,
    generationProvider: body.generationProvider ?? current.generationProvider,
    transcriptionProvider: body.transcriptionProvider ?? current.transcriptionProvider,
    providers: body.providers ?? current.providers,
    generationModel: body.generationModel,
    transcriptionModel: body.transcriptionModel,
    cleanupModel: body.cleanupModel ?? current.cleanupModel,
    cleanupProvider: body.cleanupProvider ?? current.cleanupProvider,
    maxBlocks: body.maxBlocks,
    blocksPerTick: body.blocksPerTick,
    minimumBuildTicks: body.minimumBuildTicks,
    applyBudgetMs: body.applyBudgetMs,
    hourlyRequestLimit: body.hourlyRequestLimit,
    hourlyPlayerRequestLimit: body.hourlyPlayerRequestLimit,
    maxHourlyBuilders: body.maxHourlyBuilders,
    generationMaxPricePromptUsdPerM: body.generationMaxPricePromptUsdPerM,
    generationMaxPriceCompletionUsdPerM: body.generationMaxPriceCompletionUsdPerM,
  })
  if (settings.enabled) {
    const needed = new Set([settings.generationProvider, settings.transcriptionProvider])
    if (settings.cleanupModel) needed.add(settings.cleanupProvider)
    needed.delete('vercel-gateway')
    const missing = [...needed].filter((id) => !hasKey(id))
    if (missing.length === 1 && missing[0] === 'openrouter')
      throw fail(400, 'Сначала сохраните ключ OpenRouter и дождитесь статуса «Ключ задан».')
    if (missing.length > 0)
      throw fail(
        400,
        `Нет ключа провайдера ${missing.join(', ')}: сохраните ключ и дождитесь статуса «Ключ задан».`,
      )
  }
  if (Buffer.byteLength(JSON.stringify(settings, null, 2) + '\n') > 8192)
    throw fail(413, 'Настройки AI превышают доступный размер. Укоротите записи провайдеров.')
  const conflict = 'Настройки AI мастерской уже изменил кто-то другой. Обновите страницу.'
  return cpSaving(async () => {
    const { cp, views } = await cpReadViews(['workshop-ai'])
    const view = views.get('workshop-ai') ?? null
    if (!view) throw fail(503, 'Control-plane недоступен. Настройки не изменены.')
    const { schema: _schema, revision: _revision, ...patch } = settings as Record<string, unknown>
    const value = (view.value ?? {}) as Record<string, unknown>
    const jobs: CpJob[] = []
    if (stable(patch) !== stable(pick(value, Object.keys(patch)))) {
      if (!view.initialized)
        jobs.push({ kind: 'patch', namespace: 'workshop-ai', patch, conflict, base: 0 })
      else {
        const base = (body as any)?.cpRevisions?.['workshop-ai']
        if (!Number.isSafeInteger(base)) throw fail(409, conflict)
        jobs.push({ kind: 'patch', namespace: 'workshop-ai', patch, conflict, base })
      }
    }
    const built = await cpSettleSave({
      cp,
      directory,
      fileName: 'workshop-ai-settings.json',
      revision: (current as Record<string, unknown>).revision as number,
      actorName: 'owner',
      jobs,
      rebuild: async () => {
        const view = (await readWorkshopAiSettingsCpView(directory)) as Record<string, unknown>
        return { value: view, cpRevisions: (view.cpRevisions ?? {}) as Record<string, number> }
      },
    })
    return { settings: built.value, cpRevisions: built.cpRevisions }
  })
}
const nonNullSection = (value: unknown) =>
  Object.fromEntries(
    Object.entries((value ?? {}) as Record<string, unknown>).filter(([, item]) => item !== null),
  )

const CP_SETTINGS_NAMESPACES = [
  'gameplay',
  'rooms',
  'deathmatch',
  'classLocks',
  'campaign',
  'parcool',
  'gunBalance',
  'kits',
  'disabledMapIds',
]

/**
 * Pure CP->mirror projection: copies ONLY known settings fields that are
 * present in the views (absent/undefined keys keep the mirror value; transport
 * keys like cpRevisions never enter the mirror). Every CP-mode mirror write
 * goes through here, so no overlay can drop a field it does not own.
 */
function mirrorFromCp(
  mirror: unknown,
  views: Map<string, CpSectionView | null>,
): Record<string, unknown> {
  const settings = { ...(mirror as Record<string, unknown>) }
  const view = (namespace: string) => views.get(namespace) ?? null
  const gameplay = view('gameplay')
  if (gameplay?.initialized) {
    const lobby = (gameplay.value as Record<string, unknown>).lobby
    if (lobby && typeof lobby === 'object')
      settings.lobby = { ...((settings.lobby ?? {}) as object), ...(lobby as object) }
  }
  const rooms = view('rooms')
  if (rooms?.initialized) {
    const section = nonNullSection(rooms.value)
    if (Object.keys(section).length > 0) settings.rooms = section
  }
  const deathmatch = view('deathmatch')
  if (deathmatch?.initialized) {
    const section = nonNullSection(deathmatch.value)
    if (Object.keys(section).length > 0) settings.deathmatch = section
  }
  const classLocks = view('classLocks')
  if (classLocks?.initialized && classLocks.value && typeof classLocks.value === 'object') {
    const value = classLocks.value as Record<string, unknown>
    if (value.classLocks !== undefined) settings.classLocks = value.classLocks
    if (value.classCosts !== undefined) settings.classCosts = value.classCosts
  }
  const campaign = view('campaign')
  if (campaign?.initialized && campaign.value && typeof campaign.value === 'object') {
    const balance = (campaign.value as Record<string, unknown>).campaignBalance
    if (balance && typeof balance === 'object' && Object.keys(balance).length > 0)
      settings.campaignBalance = balance
    else delete settings.campaignBalance
  }
  const parcool = view('parcool')
  if (parcool?.initialized && parcool.value && typeof parcool.value === 'object')
    settings.parcool = parcool.value
  const gunBalance = view('gunBalance')
  if (gunBalance?.initialized && gunBalance.value && typeof gunBalance.value === 'object') {
    const overrides = (gunBalance.value as Record<string, unknown>).overrides
    if (overrides && typeof overrides === 'object' && Object.keys(overrides).length > 0)
      settings.gunBalance = overrides
    else delete settings.gunBalance
  }
  const kits = view('kits')
  if (kits?.initialized && kits.value && typeof kits.value === 'object') {
    const value = kits.value as Record<string, unknown>
    if (value.kits && typeof value.kits === 'object' && Object.keys(value.kits).length > 0)
      settings.kits = value.kits
    else delete settings.kits
    if (
      value.fixedModeKits &&
      typeof value.fixedModeKits === 'object' &&
      Object.keys(value.fixedModeKits).length > 0
    )
      settings.fixedModeKits = value.fixedModeKits
    else delete settings.fixedModeKits
  }
  const maps = view('disabledMapIds')
  if (maps?.initialized && maps.value && typeof maps.value === 'object')
    settings.disabledMapIds = (maps.value as Record<string, unknown>).disabledMapIds ?? []
  return settings
}

/** GET settings in CP mode: CP namespaces overlaid on the file mirror (shape authority). */
export async function readSettingsCpView(directory: string) {
  const mirror = readSettings(directory)
  const { views } = await cpReadViews(CP_SETTINGS_NAMESPACES)
  const cpRevisions: Record<string, number> = {}
  for (const namespace of CP_SETTINGS_NAMESPACES) {
    const seen = views.get(namespace) ?? null
    if (seen?.initialized) cpRevisions[namespace] = seen.revision
  }
  return { settings: mirrorFromCp(mirror.settings, views), applied: mirror.applied, cpRevisions }
}

export async function readAiLimitsCpView(directory: string) {
  const mirror = readAiLimits(directory)
  try {
    const cp = await import('./cp.ts')
    const view = (await cp.readSettingsCp('ai-limits')) as CpSectionView
    if (view.initialized && view.value && typeof view.value === 'object') {
      const value = view.value as Record<string, unknown>
      return {
        schema: 1,
        revision: mirror.revision,
        currency: 'USD',
        mode: value.mode,
        // A null-delete reset removes the scope key in CP; read it back as
        // the default empty scope so the file policy still validates.
        sessions: (value.sessions ?? {}) as Record<string, number>,
        builders: (value.builders ?? {}) as Record<string, number>,
        cpRevisions: { 'ai-limits': view.revision },
      }
    }
  } catch {
    // CP read failure keeps the file mirror, like rooms.ts readGateCp.
  }
  return mirror
}

export async function readWorkshopAiSettingsCpView(directory: string) {
  const mirror = readWorkshopAiSettings(directory)
  try {
    const cp = await import('./cp.ts')
    const view = (await cp.readSettingsCp('workshop-ai')) as CpSectionView
    if (view.initialized && view.value && typeof view.value === 'object')
      return {
        schema: 1,
        revision: (mirror as Record<string, unknown>).revision,
        ...(view.value as object),
        cpRevisions: { 'workshop-ai': view.revision },
      }
  } catch {
    // CP read failure keeps the file mirror, like rooms.ts readGateCp.
  }
  return mirror
}
