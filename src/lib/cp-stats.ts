/** Control-plane v2 stats read client + S8b operator reconcile helpers.
 * Runtime reads go exclusively through CP GET /v2/stats/* with the scoped
 * `stats.read` credential (BLOCKFIELD_CP_URL + BLOCKFIELD_CP_STATS_TOKEN);
 * never falls back to the site Postgres DB. */

import { createHash } from 'node:crypto'

export type ResultRef = { serverId: string; eventId: string; digest: string }
export type ShadowDiff = {
  missingInCentral: Array<{ serverId: string; eventId: string }>
  missingLocally: Array<{ serverId: string; eventId: string }>
  digestMismatch: Array<{ serverId: string; eventId: string }>
}
export type Eligibility = { eligible: boolean; needsReview: boolean }

const refKey = (ref: { serverId: string; eventId: string }) => `${ref.serverId}/${ref.eventId}`

/** Reconcile result IDs/digests between the local store and the central
 * export. Returns IDs missing on either side plus digest conflicts; both
 * inputs are left untouched. */
export function shadowCompareResults(local: ResultRef[], central: ResultRef[]): ShadowDiff {
  const localById = new Map(local.map((ref) => [refKey(ref), ref]))
  const centralById = new Map(central.map((ref) => [refKey(ref), ref]))
  const missingInCentral: ShadowDiff['missingInCentral'] = []
  const missingLocally: ShadowDiff['missingLocally'] = []
  const digestMismatch: ShadowDiff['digestMismatch'] = []
  for (const [key, ref] of localById) {
    const other = centralById.get(key)
    if (!other) missingInCentral.push({ serverId: ref.serverId, eventId: ref.eventId })
    else if (other.digest !== ref.digest)
      digestMismatch.push({ serverId: ref.serverId, eventId: ref.eventId })
  }
  for (const [key, ref] of centralById)
    if (!localById.has(key)) missingLocally.push({ serverId: ref.serverId, eventId: ref.eventId })
  const byId = (
    a: { serverId: string; eventId: string },
    b: { serverId: string; eventId: string },
  ) => a.serverId.localeCompare(b.serverId) || a.eventId.localeCompare(b.eventId)
  return {
    missingInCentral: missingInCentral.sort(byId),
    missingLocally: missingLocally.sort(byId),
    digestMismatch: digestMismatch.sort(byId),
  }
}

/** Control-plane test classification is authoritative: a CP-marked test
 * account never rates, and an unknown classification fails closed (excluded
 * with needsReview) instead of guessing. */
export function resolveTestEligibility(
  localWouldRate: boolean,
  cpIsTest: boolean | null | undefined,
): Eligibility {
  if (!localWouldRate) return { eligible: false, needsReview: false }
  if (cpIsTest == null) return { eligible: false, needsReview: true }
  if (cpIsTest) return { eligible: false, needsReview: false }
  return { eligible: true, needsReview: false }
}

export type SeasonDrift = {
  season: string
  since: string
  siteCount: number
  cpCount: number
  drift: number
} & ShadowDiff

/** Dual-write reconcile for one season window (both inputs already filtered to
 * it): site vs CP result counts plus the ID/digest diff. Read-only. */
export function reconcileSeasonCounts(
  season: { id: string; startsAt: string },
  site: ResultRef[],
  cp: ResultRef[],
): SeasonDrift {
  const diff = shadowCompareResults(site, cp)
  return {
    season: season.id,
    since: season.startsAt,
    siteCount: site.length,
    cpCount: cp.length,
    drift: diff.missingInCentral.length + diff.missingLocally.length + diff.digestMismatch.length,
    ...diff,
  }
}

/** One log line per check; detail lines only when the counts drift. */
export function formatSeasonDrift(drift: SeasonDrift): string {
  const head =
    `cp-stats reconcile ${drift.season} since ${drift.since}:` +
    ` site=${drift.siteCount} cp=${drift.cpCount} drift=${drift.drift}`
  if (!drift.drift) return head
  const lines = [head]
  for (const ref of drift.missingInCentral)
    lines.push(`  missing in CP: ${ref.serverId}/${ref.eventId}`)
  for (const ref of drift.missingLocally)
    lines.push(`  missing in site: ${ref.serverId}/${ref.eventId}`)
  for (const ref of drift.digestMismatch)
    lines.push(`  digest mismatch: ${ref.serverId}/${ref.eventId}`)
  return lines.join('\n')
}

export class StatsError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'StatsError'
    this.status = status
    if (code !== undefined) this.code = code
  }
}

export const UNKNOWN_PLAYER = 'Неизвестный игрок'
export const uuidLike = (name: string) =>
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(name.trim())
export const displayName = (name: string | null | undefined) =>
  !name || uuidLike(name) ? UNKNOWN_PLAYER : name

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const CP_TIMEOUT_MS = 2500
/** Season boundaries change at most once per quarter; cache in-process for 30 s (no file caches). */
export const CP_STATS_SEASONS_TTL_MS = 30_000

export type CpSeason = { id: string; name: string; startsAt: string; endsAt: string }
export type CpSeasonsView = { schemaVersion: 1; current: string | null; seasons: CpSeason[] }
export type CpMmr = { rating: number; rd: number; ratedCampaigns: number; provisional: boolean }
export type CpLeaderboardRow = {
  uuid: string
  name: string
  rank: number
  score: number
  kills: number
  deaths: number
  kd: number
  captures: number
  neutralizations: number
  pointSeconds: number
  playSeconds: number
  suicides: number
  teamKills: number
  maxKillstreak: number
  matches: number
  wins: number
  mmr: CpMmr | null
}
export type CpLeaderboardView = {
  schemaVersion: 1
  checkedAt: string
  mode: string | null
  season: string | null
  mmrSeason: string
  page: number
  limit: number
  total: number
  ratingStatus: string
  ratingsRebuilding: boolean
  players: CpLeaderboardRow[]
}
export type CpPlayerView = {
  schemaVersion: 1
  checkedAt: string
  season: string | null
  mmrSeason: string
  profile: { uuid: string; name: string; lastSeen: number; role?: string | null }
  totals: CpLeaderboardRow | null
  classes: Array<{
    classId: string
    variantId: string
    timeSeconds: number
    kills: number
    deaths: number
    pointSeconds: number
  }>
  campaigns: { completed: number; wins: number }
  history: Array<{
    eventId: string
    serverId: string
    kind: string
    mode: string
    campaignSessionId: string | null
    endedAt: number
    reason: string
    winner: string
    winnerUuid: string | null
    team: string
    score: number
    kills: number
    deaths: number
  }>
  page: number
  limit: number
  mmr: CpMmr | null
  ratingHistory: Array<{
    campaignSessionId: string
    ratedAt: number
    team: string
    score: number
    before: number
    after: number
    rd: number
  }>
  ratingStatus: string
  ratingsRebuilding?: boolean
}
export type CpHitregView = {
  schemaVersion: 1
  checkedAt: string
  mode: string | null
  matches: number
  withTelemetry: number
  telemetryDropped: number
  truncated: boolean
  shots: number
  fallbackShare: number
  disputes: number
  counters: Record<string, number>
  tickMsP50Median: number | null
  tickMsP50P99: number | null
  tickMsP99Median: number | null
  tickMsP99P99: number | null
  ageTicksP50Median: number | null
  ageTicksP50P99: number | null
  rewindTicksP50Median: number | null
  rewindTicksP50P99: number | null
}

export type CpStatsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type CpStatsReadOpts = {
  fetchImpl?: CpStatsFetch
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  now?: () => number
  noCache?: boolean
}

export type CpStatsQueryInput = URLSearchParams | Record<string, string | null | undefined>

function cpBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.BLOCKFIELD_CP_URL ?? '').trim().replace(/\/+$/, '')
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin + parsed.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export function cpStatsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return cpBaseUrl(env) !== null && (env.BLOCKFIELD_CP_STATS_TOKEN ?? '').trim().length > 0
}

function cpAuth(env: NodeJS.ProcessEnv): { base: string; token: string } {
  const base = cpBaseUrl(env)
  const token = (env.BLOCKFIELD_CP_STATS_TOKEN ?? '').trim()
  if (!base || !token)
    throw new StatsError(503, 'Статистика через control-plane не настроена.', 'cp_unconfigured')
  return { base, token }
}

const isObj = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => Number.isSafeInteger(v)
const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isOptStr = (v: unknown): v is string | null => v === null || isStr(v)
const isOptNum = (v: unknown): v is number | null => v === null || isNum(v)

function validMmr(v: unknown): v is CpMmr | null {
  if (v === null) return true
  return (
    isObj(v) &&
    isNum(v.rating) &&
    isNum(v.rd) &&
    isNonNegInt(v.ratedCampaigns) &&
    isBool(v.provisional)
  )
}

function validSeason(v: unknown): v is CpSeason {
  return (
    isObj(v) &&
    isStr(v.id) &&
    v.id.length > 0 &&
    isStr(v.name) &&
    isStr(v.startsAt) &&
    isStr(v.endsAt)
  )
}

function parseSeasonsView(data: unknown): CpSeasonsView | null {
  if (!isObj(data) || data.schemaVersion !== 1 || !isOptStr(data.current)) return null
  if (!Array.isArray(data.seasons) || !data.seasons.every(validSeason)) return null
  return {
    schemaVersion: 1,
    current: data.current,
    seasons: data.seasons.map((s) => ({
      id: s.id,
      name: s.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
    })),
  }
}

function parseLeaderboardRow(row: unknown): CpLeaderboardRow | null {
  if (
    !isObj(row) ||
    !isStr(row.uuid) ||
    !isStr(row.name) ||
    !isInt(row.rank) ||
    row.rank < 1 ||
    !isNum(row.score) ||
    !isNonNegInt(row.kills) ||
    !isNonNegInt(row.deaths) ||
    !isNum(row.kd) ||
    !isNonNegInt(row.captures) ||
    !isNonNegInt(row.neutralizations) ||
    !isNonNegInt(row.pointSeconds) ||
    !isNonNegInt(row.playSeconds) ||
    !isNonNegInt(row.suicides) ||
    !isNonNegInt(row.teamKills) ||
    !isNonNegInt(row.maxKillstreak) ||
    !isNonNegInt(row.matches) ||
    !isNonNegInt(row.wins) ||
    !validMmr(row.mmr)
  )
    return null
  return {
    uuid: row.uuid,
    name: displayName(row.name),
    rank: row.rank,
    score: row.score,
    kills: row.kills,
    deaths: row.deaths,
    kd: row.kd,
    captures: row.captures,
    neutralizations: row.neutralizations,
    pointSeconds: row.pointSeconds,
    playSeconds: row.playSeconds,
    suicides: row.suicides,
    teamKills: row.teamKills,
    maxKillstreak: row.maxKillstreak,
    matches: row.matches,
    wins: row.wins,
    mmr: row.mmr ? { ...row.mmr } : null,
  }
}

function parseLeaderboardView(data: unknown): CpLeaderboardView | null {
  if (
    !isObj(data) ||
    data.schemaVersion !== 1 ||
    !isStr(data.checkedAt) ||
    !isOptStr(data.mode) ||
    !isOptStr(data.season) ||
    !isStr(data.mmrSeason) ||
    !isInt(data.page) ||
    data.page < 1 ||
    !isInt(data.limit) ||
    data.limit < 1 ||
    !isNonNegInt(data.total) ||
    !isStr(data.ratingStatus) ||
    (data.ratingsRebuilding !== undefined && !isBool(data.ratingsRebuilding)) ||
    !Array.isArray(data.players)
  )
    return null
  const players: CpLeaderboardRow[] = []
  for (const row of data.players) {
    const parsed = parseLeaderboardRow(row)
    if (!parsed) return null
    players.push(parsed)
  }
  return {
    schemaVersion: 1,
    checkedAt: data.checkedAt,
    mode: data.mode,
    season: data.season,
    mmrSeason: data.mmrSeason,
    page: data.page,
    limit: data.limit,
    total: data.total,
    ratingStatus: data.ratingStatus,
    ratingsRebuilding: Boolean(data.ratingsRebuilding),
    players,
  }
}

function parsePlayerView(data: unknown): CpPlayerView | null {
  if (
    !isObj(data) ||
    data.schemaVersion !== 1 ||
    !isStr(data.checkedAt) ||
    !isOptStr(data.season) ||
    !isStr(data.mmrSeason) ||
    !isObj(data.profile) ||
    !isStr(data.profile.uuid) ||
    !isStr(data.profile.name) ||
    !isInt(data.profile.lastSeen) ||
    !isObj(data.campaigns) ||
    !isNonNegInt(data.campaigns.completed) ||
    !isNonNegInt(data.campaigns.wins) ||
    !isInt(data.page) ||
    data.page < 1 ||
    !isInt(data.limit) ||
    data.limit < 1 ||
    !validMmr(data.mmr) ||
    !isStr(data.ratingStatus) ||
    (data.ratingsRebuilding !== undefined && !isBool(data.ratingsRebuilding)) ||
    !Array.isArray(data.classes) ||
    !Array.isArray(data.history) ||
    !Array.isArray(data.ratingHistory)
  )
    return null

  const totals = data.totals === null ? null : parseLeaderboardRow(data.totals)
  if (data.totals !== null && totals === null) return null

  const classes: CpPlayerView['classes'] = []
  for (const c of data.classes) {
    if (
      !isObj(c) ||
      !isStr(c.classId) ||
      !isStr(c.variantId) ||
      !isNonNegInt(c.timeSeconds) ||
      !isNonNegInt(c.kills) ||
      !isNonNegInt(c.deaths) ||
      !isNonNegInt(c.pointSeconds)
    )
      return null
    classes.push({
      classId: c.classId,
      variantId: c.variantId,
      timeSeconds: c.timeSeconds,
      kills: c.kills,
      deaths: c.deaths,
      pointSeconds: c.pointSeconds,
    })
  }

  const history: CpPlayerView['history'] = []
  for (const h of data.history) {
    if (
      !isObj(h) ||
      !isStr(h.eventId) ||
      !isStr(h.serverId) ||
      !isStr(h.kind) ||
      !isStr(h.mode) ||
      !isOptStr(h.campaignSessionId) ||
      !isInt(h.endedAt) ||
      !isStr(h.reason) ||
      !isStr(h.winner) ||
      !(h.winnerUuid === null || h.winnerUuid === undefined || isStr(h.winnerUuid)) ||
      !isStr(h.team) ||
      !isNum(h.score) ||
      !isNonNegInt(h.kills) ||
      !isNonNegInt(h.deaths)
    )
      return null
    history.push({
      eventId: h.eventId,
      serverId: h.serverId,
      kind: h.kind,
      mode: h.mode,
      campaignSessionId: h.campaignSessionId,
      endedAt: h.endedAt,
      reason: h.reason,
      winner: h.winner,
      winnerUuid: h.winnerUuid ?? null,
      team: h.team,
      score: h.score,
      kills: h.kills,
      deaths: h.deaths,
    })
  }

  const ratingHistory: CpPlayerView['ratingHistory'] = []
  for (const r of data.ratingHistory) {
    if (
      !isObj(r) ||
      !isStr(r.campaignSessionId) ||
      !isInt(r.ratedAt) ||
      !isStr(r.team) ||
      !isNum(r.score) ||
      !isNum(r.before) ||
      !isNum(r.after) ||
      !isNum(r.rd)
    )
      return null
    ratingHistory.push({
      campaignSessionId: r.campaignSessionId,
      ratedAt: r.ratedAt,
      team: r.team,
      score: r.score,
      before: r.before,
      after: r.after,
      rd: r.rd,
    })
  }

  return {
    schemaVersion: 1,
    checkedAt: data.checkedAt,
    season: data.season,
    mmrSeason: data.mmrSeason,
    profile: {
      uuid: data.profile.uuid,
      name: displayName(data.profile.name),
      lastSeen: data.profile.lastSeen,
    },
    totals,
    classes,
    campaigns: { completed: data.campaigns.completed, wins: data.campaigns.wins },
    history,
    page: data.page,
    limit: data.limit,
    mmr: data.mmr ? { ...data.mmr } : null,
    ratingHistory,
    ratingStatus: data.ratingStatus,
    ...(data.ratingsRebuilding !== undefined ? { ratingsRebuilding: data.ratingsRebuilding } : {}),
  }
}

function parseHitregView(data: unknown): CpHitregView | null {
  if (
    !isObj(data) ||
    data.schemaVersion !== 1 ||
    !isStr(data.checkedAt) ||
    !isOptStr(data.mode) ||
    !isNonNegInt(data.matches) ||
    !isNonNegInt(data.withTelemetry) ||
    !isNonNegInt(data.telemetryDropped) ||
    !isBool(data.truncated) ||
    !isNonNegInt(data.shots) ||
    !isNum(data.fallbackShare) ||
    !isNonNegInt(data.disputes) ||
    !isObj(data.counters) ||
    !isOptNum(data.tickMsP50Median) ||
    !isOptNum(data.tickMsP50P99) ||
    !isOptNum(data.tickMsP99Median) ||
    !isOptNum(data.tickMsP99P99) ||
    !isOptNum(data.ageTicksP50Median) ||
    !isOptNum(data.ageTicksP50P99) ||
    !isOptNum(data.rewindTicksP50Median) ||
    !isOptNum(data.rewindTicksP50P99)
  )
    return null
  const counters: Record<string, number> = {}
  for (const [k, v] of Object.entries(data.counters)) {
    if (!isNonNegInt(v)) return null
    counters[k] = v
  }
  return {
    schemaVersion: 1,
    checkedAt: data.checkedAt,
    mode: data.mode,
    matches: data.matches,
    withTelemetry: data.withTelemetry,
    telemetryDropped: data.telemetryDropped,
    truncated: data.truncated,
    shots: data.shots,
    fallbackShare: data.fallbackShare,
    disputes: data.disputes,
    counters,
    tickMsP50Median: data.tickMsP50Median,
    tickMsP50P99: data.tickMsP50P99,
    tickMsP99Median: data.tickMsP99Median,
    tickMsP99P99: data.tickMsP99P99,
    ageTicksP50Median: data.ageTicksP50Median,
    ageTicksP50P99: data.ageTicksP50P99,
    rewindTicksP50Median: data.rewindTicksP50Median,
    rewindTicksP50P99: data.rewindTicksP50P99,
  }
}

function buildSearch(params: CpStatsQueryInput | undefined, keys: readonly string[]): string {
  if (!params) return ''
  const out = new URLSearchParams()
  for (const key of keys) {
    const raw = params instanceof URLSearchParams ? params.get(key) : params[key]
    if (typeof raw === 'string' && raw !== '') out.set(key, raw)
  }
  const qs = out.toString()
  return qs ? `?${qs}` : ''
}

async function cpGet<T>(
  path: string,
  parse: (data: unknown) => T | null,
  opts: CpStatsReadOpts = {},
): Promise<{ result: T; base: string; tokenHash: string }> {
  const { base, token } = cpAuth(opts.env ?? process.env)
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  let response: Response
  try {
    response = await fetchImpl(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? CP_TIMEOUT_MS),
    })
  } catch {
    throw new StatsError(503, 'Сервер статистики control-plane недоступен.', 'cp_unreachable')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : undefined
    // Upstream site credential failure must never appear as visitor 401/403.
    if (response.status === 401 || response.status === 403)
      throw new StatsError(
        503,
        'У сайта нет доступа к статистике в control-plane. Обратитесь к координатору.',
        code ?? 'cp_auth_failed',
      )
    if (response.status === 400)
      throw new StatsError(
        400,
        'Некорректные параметры статистики.',
        code ?? 'invalid_stats_filter',
      )
    if (response.status === 404)
      throw new StatsError(404, 'Данные статистики не найдены.', code ?? 'player_not_found')
    throw new StatsError(502, 'Control-plane отклонил запрос статистики.', code ?? 'cp_error')
  }
  const parsed = parse(data)
  if (parsed === null)
    throw new StatsError(
      502,
      'Control-plane вернул некорректный ответ статистики.',
      'cp_invalid_response',
    )
  return { result: parsed, base, tokenHash }
}

let seasonsCache: { key: string; expiresAt: number; value: CpSeasonsView } | null = null

export function clearCpStatsCache(): void {
  seasonsCache = null
}

/** `GET /v2/stats/seasons` with an explicit 30 s in-process TTL cache keyed by (url, token hash). */
export async function readSeasonsCp(opts: CpStatsReadOpts = {}): Promise<CpSeasonsView> {
  const { base, token } = cpAuth(opts.env ?? process.env)
  const key = `${base}\0${createHash('sha256').update(token).digest('hex')}`
  const now = (opts.now ?? Date.now)()
  if (!opts.noCache && seasonsCache && seasonsCache.key === key && seasonsCache.expiresAt > now)
    return { ...seasonsCache.value, seasons: seasonsCache.value.seasons.map((s) => ({ ...s })) }
  const { result } = await cpGet('/v2/stats/seasons', parseSeasonsView, opts)
  if (!opts.noCache)
    seasonsCache = {
      key,
      expiresAt: now + CP_STATS_SEASONS_TTL_MS,
      value: { ...result, seasons: result.seasons.map((s) => ({ ...s })) },
    }
  return result
}

const LEADERBOARD_KEYS = ['mode', 'season', 'period', 'sort', 'limit', 'page'] as const

/** `GET /v2/stats/leaderboard` directly from CP (uncached). */
export async function readLeaderboardCp(
  params?: CpStatsQueryInput,
  opts: CpStatsReadOpts = {},
): Promise<CpLeaderboardView> {
  const qs = buildSearch(params, LEADERBOARD_KEYS)
  const { result } = await cpGet(`/v2/stats/leaderboard${qs}`, parseLeaderboardView, opts)
  return result
}

/** `GET /v2/stats/players/{uuid}` directly from CP (uncached). */
export async function readPlayerCp(
  uuid: string,
  params?: CpStatsQueryInput,
  opts: CpStatsReadOpts = {},
): Promise<CpPlayerView> {
  if (!UUID.test(uuid))
    throw new StatsError(400, 'Некорректный идентификатор игрока.', 'invalid_player')
  const qs = buildSearch(params, LEADERBOARD_KEYS)
  const { result } = await cpGet(`/v2/stats/players/${uuid}${qs}`, parsePlayerView, opts)
  return result
}

const HITREG_KEYS = ['mode', 'season', 'period'] as const

/** `GET /v2/stats/hitreg` directly from CP (uncached; defaults period=week when neither season nor period is given). */
export async function readHitregCp(
  params?: CpStatsQueryInput,
  opts: CpStatsReadOpts = {},
): Promise<CpHitregView> {
  const out = new URLSearchParams()
  if (params) {
    for (const key of HITREG_KEYS) {
      const raw = params instanceof URLSearchParams ? params.get(key) : params[key]
      if (typeof raw === 'string' && raw !== '') out.set(key, raw)
    }
  }
  if (!out.has('season') && !out.has('period')) out.set('period', 'week')
  const qs = out.toString()
  const { result } = await cpGet(`/v2/stats/hitreg${qs ? `?${qs}` : ''}`, parseHitregView, opts)
  return result
}
