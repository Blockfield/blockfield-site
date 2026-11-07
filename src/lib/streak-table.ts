/** DM kill-streak reward table (#344): rows the admin edits, flat entries the server stores. */

export type StreakItem = {
  id: string
  count: number
  scale: boolean
  throwableId?: string
  message?: string
}
export type StreakRow = { kills: number; items: StreakItem[] }
export type StreakEntry = {
  kills: number
  id: string
  count: number
  scale: boolean
  throwable_id?: string
  message?: string
}

const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/
const MAX_INT = 2 ** 31 - 1
export const MAX_STREAK_ENTRIES = 64
export const THROWABLE_ITEM = 'lrtactical:throwable'

/** Server default (blockfield-server KillStreakRewards.defaults): period 5, cycle 2 doubles support. */
export const DEFAULT_STREAK_ENTRIES: StreakEntry[] = [
  {
    kills: 2,
    id: 'superbwarfare:medical_kit',
    count: 1,
    scale: true,
    message:
      '<color:#82D66B>${name} жарит без остановки — ${streak} подряд! Медпак в карман.</color>',
  },
  {
    kills: 3,
    id: 'superbwarfare:armor_plate',
    count: 1,
    scale: true,
    message:
      '<color:#F5A524>${name} набирает обороты — ${streak} подряд! Держи бронепластину.</color>',
  },
  {
    kills: 5,
    id: 'superbwarfare:medical_kit',
    count: 1,
    scale: true,
    message:
      '<color:#FF5C5C>${name} — форменный ужас арены, ${streak} подряд! Бонус за счёт заведения.</color>',
  },
  { kills: 5, id: 'superbwarfare:armor_plate', count: 1, scale: true },
  {
    kills: 5,
    id: 'lrtactical:throwable',
    count: 1,
    scale: false,
    throwable_id: 'lrtactical:m67',
  },
]

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const fail = (path: string, reason: string): Error => new Error(`${path}: ${reason}.`)

/**
 * Normalized flat table or a throw. Mirrors the server parser: atomic table,
 * at most 64 entries, kills/count integers >= 1, required scale boolean,
 * throwable_id only with the throwable item (required there), id shape only —
 * registry membership stays server-side and rejects the whole revision there.
 */
export function parseStreakEntries(value: unknown): StreakEntry[] {
  if (!Array.isArray(value)) throw fail('streakRewards', 'нужен список наград')
  if (value.length > MAX_STREAK_ENTRIES)
    throw fail('streakRewards', `не больше ${MAX_STREAK_ENTRIES} записей`)
  return value.map((raw, index) => {
    const path = `награда ${index + 1}`
    if (!plain(raw)) throw fail(path, 'нужен объект {убийства, предмет, кол-во}')
    const kills = raw.kills
    if (typeof kills !== 'number' || !Number.isSafeInteger(kills) || kills < 1 || kills > MAX_INT)
      throw fail(path, 'убийств — целое число от 1')
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!ITEM_ID.test(id)) throw fail(path, 'предмет — ID вида пространство:предмет')
    const count = raw.count === undefined ? 1 : raw.count
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_INT)
      throw fail(path, 'кол-во — целое число от 1')
    if (typeof raw.scale !== 'boolean') throw fail(path, 'нужен признак умножения по циклам')
    const entry: StreakEntry = { kills, id, count, scale: raw.scale }
    if (id === THROWABLE_ITEM) {
      const throwable = typeof raw.throwable_id === 'string' ? raw.throwable_id.trim() : ''
      if (!throwable) throw fail(path, 'гранате нужен throwable_id')
      entry.throwable_id = raw.throwable_id as string
    } else if (raw.throwable_id !== undefined) throw fail(path, 'throwable_id — только у гранаты')
    if (raw.message !== undefined) {
      if (typeof raw.message !== 'string') throw fail(path, 'сообщение — строка')
      if (raw.message) entry.message = raw.message
    }
    return entry
  })
}

/** Flat entries grouped by threshold, ascending — the shape the editor edits. */
export function entriesToRows(entries: StreakEntry[]): StreakRow[] {
  const rows = new Map<number, StreakItem[]>()
  for (const entry of entries) {
    const { kills, id, count, scale, throwableId, message, throwable_id } = entry as StreakEntry & {
      throwableId?: string
    }
    const items = rows.get(kills) ?? []
    const item: StreakItem = { id, count, scale }
    const grenade = throwable_id ?? throwableId
    if (grenade !== undefined) item.throwableId = grenade
    if (message) item.message = message
    items.push(item)
    rows.set(kills, items)
  }
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([kills, items]) => ({ kills, items }))
}

/**
 * Rows back to flat entries, ascending. A row without items grants nothing and
 * the server would keep it silently, so the editor rejects it; duplicate
 * thresholds would render as two rows for one grant bundle, also rejected.
 */
export function rowsToEntries(rows: StreakRow[]): StreakEntry[] {
  const seen = new Set<number>()
  const entries: StreakEntry[] = []
  rows.forEach((row, index) => {
    const path = `порог ${index + 1}`
    if (
      typeof row?.kills !== 'number' ||
      !Number.isSafeInteger(row.kills) ||
      row.kills < 1 ||
      row.kills > MAX_INT
    )
      throw fail(path, 'убийств — целое число от 1')
    if (seen.has(row.kills)) throw fail(`убийств ${row.kills}`, 'порог уже есть в таблице')
    seen.add(row.kills)
    if (!Array.isArray(row.items) || !row.items.length)
      throw fail(`убийств ${row.kills}`, 'добавьте хотя бы один предмет')
    for (const item of row.items) {
      const entry: StreakEntry = {
        kills: row.kills,
        id: item.id,
        count: item.count,
        scale: item.scale,
      }
      if (item.throwableId !== undefined) entry.throwable_id = item.throwableId
      if (item.message) entry.message = item.message
      entries.push(entry)
    }
  })
  return parseStreakEntries(entries)
}

/** Cycle period: the max threshold; rewards repeat every period. */
export function streakPeriod(entries: StreakEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.kills), 0)
}

/** Grants at the given cycle (cycle 2 preview): scaled counts multiplied by the cycle number. */
export function streakCycle(
  entries: StreakEntry[],
  cycle: number,
): { kills: number; id: string; count: number }[] {
  return entries.map((entry) => ({
    kills: entry.kills,
    id: entry.id,
    count: entry.scale ? entry.count * cycle : entry.count,
  }))
}
