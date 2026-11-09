/** Durable, Minecraft-independent result ingestion. Node >=22.19; no browser imports. */
import { Database } from './database.ts'
import { publish } from './admin-events.ts'
import { openTokenRaw, sessionKeyBytes } from './session-crypto.ts'
import { saveReport, validateReport } from './diagnostics.ts'
import { playerId, roleOf } from './admin.ts'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { composite, inflate, initial, softReset, update, RULES_VERSION } from './glicko2.ts'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const ID = /^[a-z0-9_.:-]{1,128}$/
const MAX_BODY = 1_048_576
const MODES = ['room', 'campaign', 'deathmatch']
const REASONS = ['completed', 'draw', 'abandoned', 'stopped', 'shutdown', 'error']
const COUNTERS = [
  'kills',
  'deaths',
  'captures',
  'neutralizations',
  'pointSeconds',
  'playSeconds',
  'suicides',
  'teamKills',
  'maxKillstreak',
] as const
const SORTS: Record<string, string> = {
  score: 'score',
  kills: 'kills',
  captures: 'captures',
  pointSeconds: 'pointSeconds',
  playSeconds: 'playSeconds',
  wins: 'wins',
  kd: 'kd',
  rating: 'COALESCE(rating,-1)',
}
/** An idle week is one Glicko-2 rating period: RD grows before the next rated campaign. */
const RATING_PERIOD_MS = 7 * 86400000
function mmr(row: { rating: number | null; rd: number | null; ratedCampaigns: number | null }) {
  return row.rating === null
    ? null
    : {
        rating: Math.round(row.rating),
        rd: Math.round(row.rd!),
        ratedCampaigns: row.ratedCampaigns!,
        provisional: row.ratedCampaigns! < 5 || row.rd! > 150,
      }
}
export type ClassResult = {
  classId: string
  variantId: string
  timeSeconds: number
  kills: number
  deaths: number
  pointSeconds: number
}
/** Per-match hit-reg telemetry the game server attaches to its result payload (`StatsResult.telemetry`). */
export type Telemetry = {
  shots: number
  fallbackShare: number
  tickMsP50: number
  tickMsP99: number
  tickMsP99Overflow: boolean
  ageTicksP50: number
  ageTicksP50Overflow: boolean
  rewindTicksP50: number
  rewindTicksP50Overflow: boolean
  counters: Record<string, number>
  tickMsBuckets: { le: number | 'inf'; count: number }[]
  ageTickBuckets: { le: number | 'inf'; count: number }[]
  rewindTickBuckets: { le: number | 'inf'; count: number }[]
  disputes: Record<string, string | number | boolean>[]
}
export type Participant = {
  uuid: string
  name: string
  team: 'RED' | 'BLUE' | 'NONE'
  score: number
  classes: ClassResult[]
} & Record<(typeof COUNTERS)[number], number>
export type Result = {
  schemaVersion: 1
  eventId: string
  serverId: string
  kind: 'match' | 'campaign'
  sessionPurpose: 'gameplay'
  modeId: string
  ranked: boolean
  rulesetVersion: string
  matchId: string | null
  campaignSessionId: string | null
  mapId: string | null
  startedAt: string
  endedAt: string
  endReason: string
  winner: 'RED' | 'BLUE' | 'NONE'
  participants: Participant[]
  rounds: string[]
  winnerUuid?: string // Additive FFA result; absent legacy fields stay absent for replay digests.
  telemetry?: Telemetry // Additive hit-reg report; absent legacy payloads stay byte-identical.
}
export class StatsError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StatsError(422, message)
}
export type AuditEntry = {
  actorUuid: string
  actorName: string
  role: string
  action: string
  target?: string | null
  detail?: unknown
  ok: boolean
  error?: string | null
  /** Transport that delivered the action; the API fixes it, callers never trust the body. */
  via?: string | null
  client?: string | null
  correlation?: string | null
}
/** Fixed transports per central-api-design §7.1: a human client cannot spoof another one. */
const AUDIT_VIA = ['ui', 'mcp', 'cli', 'discord', 'game', 'release', 'recovery']
/** Manifest anchoring an audit export: deletion only accepts a manifest that still verifies. */
export type AuditExportManifest = {
  version: 1
  exportedAt: number
  firstId: number | null
  lastId: number | null
  count: number
  sha256: string
}
/** Retention deletion refuses unless the presented archive verifies against its manifest. */
function failDelete(): never {
  throw new StatsError(409, 'Audit retention deletion requires a verified export.')
}
/** Max ids per verification/deletion statement: one bind parameter per row. */
const AUDIT_DELETE_CHUNK = 500
/** Columns hashed into an audit export, in fixed order. */
const AUDIT_EXPORT_COLUMNS = [
  'id',
  'at',
  'actor_uuid',
  'actor_name',
  'role',
  'action',
  'target',
  'detail',
  'ok',
  'error',
  'pending',
  'via',
  'client',
  'correlation',
]
function auditArgs(entry: AuditEntry, at: number): any[] {
  const json = entry.detail === undefined ? null : JSON.stringify(entry.detail)
  const detail = json !== null && json.length > 2048 ? `${json.slice(0, 2048)}…` : json
  const via = entry.via ?? 'ui'
  if (!AUDIT_VIA.includes(via)) throw new StatsError(422, `Unknown audit via: ${via}`)
  return [
    at,
    entry.actorUuid,
    entry.actorName,
    entry.role,
    entry.action,
    entry.target?.slice(0, 200) ?? null,
    detail,
    entry.ok ? 1 : 0,
    entry.error?.slice(0, 500) ?? null,
    via,
    entry.client?.slice(0, 200) ?? null,
    entry.correlation?.slice(0, 200) ?? null,
  ]
}
function integer(value: unknown, max = 1_000_000_000): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
}
function utc(value: unknown): number {
  requireValue(
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value),
    'UTC timestamp required',
  )
  const time = Date.parse(value as string)
  requireValue(
    Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 19) === (value as string).slice(0, 19),
    'Invalid timestamp',
  )
  return time
}
// shortcut: process-local (resets on restart), shown in the admin hit-reg report; persist if drops must be audited.
let telemetryDropped = 0
export const telemetryDroppedCount = () => telemetryDropped
/** Serialized bytes one stored telemetry block may take. The producer's per-match
 * report (HitregTelemetry.Report.toMap: ≤512 counters, 8 disputes, fixed histograms)
 * serializes to ~3 KB worst case; 8 KB leaves margin while keeping the hit-reg read bounded. */
export const TELEMETRY_MAX_BYTES = 8192
/** Hit-reg telemetry a match result may carry: the server's per-match report, kept verbatim (unknown fields dropped). */
export function validateTelemetry(value: unknown): Telemetry {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid telemetry')
  const t = value as Record<string, unknown>
  // Mirrors the producer caps (StatsResult): bounded top level, counters and dispute sample.
  // The serialized cap bounds what one stored block costs the hit-reg read, whatever shape it takes.
  requireValue(Object.keys(t).length <= 64, 'Telemetry oversized')
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0
  const amount = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000
  requireValue(count(t.shots), 'Invalid telemetry shots')
  requireValue(
    typeof t.fallbackShare === 'number' &&
      Number.isFinite(t.fallbackShare) &&
      t.fallbackShare >= 0 &&
      t.fallbackShare <= 1,
    'Invalid telemetry fallback share',
  )
  for (const key of ['tickMsP50', 'tickMsP99'] as const)
    requireValue(amount(t[key]), `Invalid telemetry ${key}`)
  for (const key of ['ageTicksP50', 'rewindTicksP50'] as const)
    requireValue(count(t[key]), `Invalid telemetry ${key}`)
  for (const key of ['tickMsP99Overflow', 'ageTicksP50Overflow', 'rewindTicksP50Overflow'] as const)
    requireValue(typeof t[key] === 'boolean', `Invalid telemetry ${key}`)
  requireValue(
    t.counters && typeof t.counters === 'object' && !Array.isArray(t.counters),
    'Invalid telemetry counters',
  )
  const counters = t.counters as Record<string, unknown>,
    names = Object.keys(counters)
  requireValue(names.length <= 512, 'Telemetry counters oversized')
  const cleanCounters: Record<string, number> = {}
  for (const name of names) {
    requireValue(
      /^[a-zA-Z0-9_.:-]{1,160}$/.test(name) && count(counters[name]),
      'Invalid telemetry counter',
    )
    cleanCounters[name] = counters[name] as number
  }
  const buckets = (v: unknown) => {
    requireValue(Array.isArray(v) && v.length <= 32, 'Invalid telemetry buckets')
    return (v as unknown[]).map((row) => {
      requireValue(
        row && typeof row === 'object' && !Array.isArray(row),
        'Invalid telemetry bucket',
      )
      const r = row as Record<string, unknown>
      requireValue(
        (typeof r.le === 'number' && Number.isFinite(r.le) && r.le >= 0) || r.le === 'inf',
        'Invalid telemetry bucket bound',
      )
      requireValue(count(r.count), 'Invalid telemetry bucket count')
      return { le: r.le as number | 'inf', count: r.count as number }
    })
  }
  requireValue(Array.isArray(t.disputes) && t.disputes.length <= 8, 'Invalid telemetry disputes')
  const disputes = (t.disputes as unknown[]).map((sample) => {
    requireValue(
      sample && typeof sample === 'object' && !Array.isArray(sample),
      'Invalid telemetry dispute',
    )
    const entries = Object.entries(sample as Record<string, unknown>)
    requireValue(entries.length > 0 && entries.length <= 32, 'Invalid telemetry dispute')
    const kept: Record<string, string | number | boolean> = {}
    for (const [key, entry] of entries) {
      requireValue(/^[a-zA-Z0-9_.:-]{1,64}$/.test(key), 'Invalid telemetry dispute')
      requireValue(
        // Postgres jsonb rejects NUL and lone surrogates; one such value would break every aggregate over the match.
        (typeof entry === 'string' && entry.length <= 512 && !/[\p{Cc}\p{Cs}]/u.test(entry)) ||
          (typeof entry === 'number' && Number.isFinite(entry)) ||
          typeof entry === 'boolean',
        'Invalid telemetry dispute',
      )
      kept[key] = entry as string | number | boolean
    }
    return kept
  })
  const clean = {
    shots: t.shots as number,
    fallbackShare: t.fallbackShare as number,
    tickMsP50: t.tickMsP50 as number,
    tickMsP99: t.tickMsP99 as number,
    tickMsP99Overflow: t.tickMsP99Overflow as boolean,
    ageTicksP50: t.ageTicksP50 as number,
    ageTicksP50Overflow: t.ageTicksP50Overflow as boolean,
    rewindTicksP50: t.rewindTicksP50 as number,
    rewindTicksP50Overflow: t.rewindTicksP50Overflow as boolean,
    counters: cleanCounters,
    tickMsBuckets: buckets(t.tickMsBuckets),
    ageTickBuckets: buckets(t.ageTickBuckets),
    rewindTickBuckets: buckets(t.rewindTickBuckets),
    disputes,
  }
  requireValue(JSON.stringify(clean).length <= TELEMETRY_MAX_BYTES, 'Telemetry oversized')
  return clean
}
/** Strict allow-list of gameplay producers: training/playtest never reaches the aggregate tables. */
export function validateResult(value: any, now = Date.now()): Result {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    'Result object required',
  )
  requireValue(
    value.schemaVersion === 1 &&
      typeof value.eventId === 'string' &&
      UUID.test(value.eventId) &&
      typeof value.serverId === 'string' &&
      UUID.test(value.serverId),
    'Invalid result identity/version',
  )
  requireValue(value.sessionPurpose === 'gameplay', 'Non-gameplay results are not accepted')
  requireValue(
    MODES.includes(value.modeId) &&
      typeof value.ranked === 'boolean' &&
      value.ranked === (value.modeId === 'campaign'),
    'Invalid mode/ranking context',
  )
  requireValue(
    typeof value.rulesetVersion === 'string' && ID.test(value.rulesetVersion),
    'Invalid ruleset version',
  )
  requireValue(
    ['match', 'campaign'].includes(value.kind) && REASONS.includes(value.endReason),
    'Invalid finalization',
  )
  requireValue(['RED', 'BLUE', 'NONE'].includes(value.winner), 'Invalid winner')
  requireValue(
    value.endReason === 'completed' || value.winner === 'NONE',
    'Interrupted/drawn results cannot declare a winner',
  )
  const start = utc(value.startedAt),
    end = utc(value.endedAt)
  requireValue(end >= start && end <= now + 300_000, 'Invalid result time interval')
  requireValue(
    Array.isArray(value.rounds) &&
      value.rounds.length <= 10_000 &&
      value.rounds.every((id: any) => typeof id === 'string' && UUID.test(id)) &&
      new Set(value.rounds).size === value.rounds.length,
    'Invalid round IDs',
  )
  if (value.kind === 'match') {
    requireValue(
      value.matchId === value.eventId && typeof value.mapId === 'string' && ID.test(value.mapId),
      'Invalid match identity/map',
    )
    requireValue(
      value.campaignSessionId === null ||
        (typeof value.campaignSessionId === 'string' && UUID.test(value.campaignSessionId)),
      'Invalid campaign session ID',
    )
    requireValue(
      !value.ranked || value.campaignSessionId !== null,
      'Ranked match requires campaign session',
    )
    requireValue(value.rounds.length === 0, 'A match cannot contain rounds')
  } else {
    requireValue(
      value.modeId === 'campaign' &&
        value.matchId === null &&
        value.mapId === null &&
        value.campaignSessionId === value.eventId,
      'Invalid campaign identity',
    )
    requireValue(
      value.endReason !== 'completed' || value.rounds.length > 0,
      'Completed campaign has no rounds',
    )
  }
  requireValue(
    Array.isArray(value.participants) && value.participants.length <= 512,
    'Invalid participants',
  )
  const seen = new Set<string>()
  for (const p of value.participants) {
    requireValue(
      p && typeof p.uuid === 'string' && UUID.test(p.uuid) && !seen.has(p.uuid),
      'Participants must be deduplicated by UUID',
    )
    seen.add(p.uuid)
    requireValue(
      typeof p.name === 'string' &&
        p.name.length > 0 &&
        p.name.length <= 64 &&
        // eslint-disable-next-line no-control-regex -- Rejecting control characters is deliberate.
        !/[\x00-\x1f\x7f]/.test(p.name),
      'Invalid display name',
    )
    requireValue(
      ['RED', 'BLUE', 'NONE'].includes(p.team) &&
        Number.isFinite(p.score) &&
        Math.abs(p.score) <= 1_000_000_000,
      'Invalid team/score',
    )
    requireValue(
      COUNTERS.every((key) => integer(p[key])),
      'Invalid player counters',
    )
    requireValue(Array.isArray(p.classes) && p.classes.length <= 256, 'Invalid class breakdown')
    const classes = new Set<string>()
    for (const c of p.classes) {
      requireValue(
        c &&
          typeof c.classId === 'string' &&
          ID.test(c.classId) &&
          typeof c.variantId === 'string' &&
          ID.test(c.variantId),
        'Stable class/variant IDs required',
      )
      const key = `${c.classId}/${c.variantId}`
      requireValue(!classes.has(key), 'Duplicate class breakdown')
      classes.add(key)
      requireValue(
        ['timeSeconds', 'kills', 'deaths', 'pointSeconds'].every((key) => integer(c[key])),
        'Invalid class counters',
      )
    }
  }
  const hasPersonalWinner = Object.hasOwn(value, 'winnerUuid')
  if (hasPersonalWinner) {
    requireValue(
      value.modeId === 'deathmatch' &&
        value.kind === 'match' &&
        value.endReason === 'completed' &&
        value.winner === 'NONE' &&
        value.campaignSessionId === null,
      'Personal winner requires a completed FFA match',
    )
    requireValue(
      typeof value.winnerUuid === 'string' &&
        UUID.test(value.winnerUuid) &&
        seen.has(value.winnerUuid),
      'Personal winner must belong to the match',
    )
    requireValue(
      value.participants.every((p: Participant) => p.team === 'NONE'),
      'FFA participants cannot declare teams',
    )
  }
  // Return only the public contract; never persist arbitrary producer-supplied fields or secrets.
  // Telemetry is diagnostics: a bad block must never cost the match's combat results, so it is dropped.
  let telemetry: Telemetry | undefined
  if (Object.hasOwn(value, 'telemetry'))
    try {
      telemetry = validateTelemetry(value.telemetry)
    } catch (error) {
      if (!(error instanceof StatsError)) throw error
      telemetryDropped++
      console.warn(`Telemetry dropped for ${value.serverId}/${value.eventId}: ${error.message}`)
    }
  return {
    schemaVersion: 1,
    eventId: value.eventId,
    serverId: value.serverId,
    kind: value.kind,
    sessionPurpose: 'gameplay',
    modeId: value.modeId,
    ranked: value.ranked,
    rulesetVersion: value.rulesetVersion,
    matchId: value.matchId,
    campaignSessionId: value.campaignSessionId,
    mapId: value.mapId,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    endReason: value.endReason,
    winner: value.winner,
    ...(hasPersonalWinner ? { winnerUuid: value.winnerUuid } : {}),
    ...(telemetry ? { telemetry } : {}),
    rounds: [...value.rounds].sort(),
    participants: value.participants
      .map((p: any) => ({
        uuid: p.uuid,
        name: p.name,
        team: p.team,
        score: p.score,
        ...Object.fromEntries(COUNTERS.map((key) => [key, p[key]])),
        classes: p.classes
          .map((c: any) => ({
            classId: c.classId,
            variantId: c.variantId,
            timeSeconds: c.timeSeconds,
            kills: c.kills,
            deaths: c.deaths,
            pointSeconds: c.pointSeconds,
          }))
          .sort((a: ClassResult, b: ClassResult) =>
            `${a.classId}/${a.variantId}`.localeCompare(`${b.classId}/${b.variantId}`),
          ),
      }))
      .sort((a: Participant, b: Participant) => a.uuid.localeCompare(b.uuid)),
  } as Result
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
/** The alpha season (s1) starts with the production stats export; season 1 (s2) opens on 2026-09-26; later seasons are UTC calendar quarters. */
export const SEASON_ONE_STARTS_AT = Date.UTC(2026, 8, 14)
const ALPHA_ENDS_AT = Date.UTC(2026, 8, 26)
export type Season = { id: string; name: string; startsAt: string; endsAt: string }
/** Started seasons, oldest first. endsAt is inclusive (1 ms before the next season starts). */
export function seasons(now = Date.now()): Season[] {
  const list: Season[] = []
  for (let start = SEASON_ONE_STARTS_AT, n = 1; start <= now; n++) {
    // IDs stay numeric (ratings are ordered by them); names are shifted by one because s1 is the alpha. Season 1 (s2) runs to the end of 2026.
    const date = new Date(start),
      next =
        n === 1
          ? ALPHA_ENDS_AT
          : n === 2
            ? Date.UTC(2027, 0, 1)
            : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, 1)
    list.push({
      id: `s${n}`,
      name: n === 1 ? 'Альфа Сезон' : `Сезон ${n - 1}`,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(next - 1).toISOString(),
    })
    start = next
  }
  return list
}
/** The season containing a timestamp; anything before season 1 belongs to season 1. */
export function seasonAt(time: number): Season {
  return seasons(Math.max(time, SEASON_ONE_STARTS_AT)).at(-1)!
}
export type Filters = {
  mode: string | null
  season: string | null
  mmrSeason: string
  since: number
  until: number
  sort: string
  limit: number
  page: number
}
export function filters(params: URLSearchParams, now = Date.now()): Filters {
  const mode = params.get('mode') || null,
    season = params.get('season') || null,
    period = params.get('period') || 'all',
    sort = params.get('sort') || 'score'
  if (mode !== null && !MODES.includes(mode)) throw new StatsError(400, 'Unknown mode')
  if (!['all', 'week', 'month'].includes(period) || !Object.hasOwn(SORTS, sort))
    throw new StatsError(400, 'Unknown period/sort')
  if (season !== null && params.get('period'))
    throw new StatsError(400, 'Use either season or period')
  const selected = season === null ? null : seasons(now).find((s) => s.id === season)
  if (selected === undefined) throw new StatsError(400, 'Unknown season')
  const limitText = params.get('limit') || '25',
    pageText = params.get('page') || '1'
  if (!/^\d+$/.test(limitText) || !/^\d+$/.test(pageText))
    throw new StatsError(400, 'Invalid pagination')
  const limit = Number(limitText),
    page = Number(pageText)
  if (!integer(limit, 100) || limit < 1 || !integer(page, 1000) || page < 1)
    throw new StatsError(400, 'Invalid pagination')
  const mmrSeason = season ?? seasonAt(now).id
  if (selected)
    return {
      mode,
      season,
      mmrSeason,
      since: Date.parse(selected.startsAt),
      until: Date.parse(selected.endsAt),
      sort,
      limit,
      page,
    }
  return {
    mode,
    season,
    mmrSeason,
    since: period === 'all' ? 0 : now - (period === 'week' ? 7 : 30) * 86400000,
    until: now + 300000,
    sort,
    limit,
    page,
  }
}
const SCHEMA = `
      CREATE TABLE IF NOT EXISTS results (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL,
        campaign_id TEXT, ended_at INTEGER NOT NULL, reason TEXT NOT NULL, winner TEXT NOT NULL,
        digest TEXT NOT NULL, payload TEXT NOT NULL, voided_at INTEGER, voided_by TEXT, PRIMARY KEY(server_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS results_mode_time ON results(mode,ended_at);
      CREATE TABLE IF NOT EXISTS profiles (uuid TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, uuid TEXT NOT NULL, team TEXT NOT NULL,
        score REAL NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, captures INTEGER NOT NULL,
        neutralizations INTEGER NOT NULL, point_seconds INTEGER NOT NULL, play_seconds INTEGER NOT NULL,
        suicides INTEGER NOT NULL, team_kills INTEGER NOT NULL, max_streak INTEGER NOT NULL,
        PRIMARY KEY(server_id,event_id,uuid), FOREIGN KEY(server_id,event_id) REFERENCES results(server_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS participants_uuid ON participants(uuid);
      CREATE TABLE IF NOT EXISTS classes (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, uuid TEXT NOT NULL, class_id TEXT NOT NULL, variant_id TEXT NOT NULL,
        time_seconds INTEGER NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, point_seconds INTEGER NOT NULL,
        PRIMARY KEY(server_id,event_id,uuid,class_id,variant_id),
        FOREIGN KEY(server_id,event_id,uuid) REFERENCES participants(server_id,event_id,uuid)
      );
      CREATE TABLE IF NOT EXISTS ratings (
        season_id TEXT NOT NULL, uuid TEXT NOT NULL, rating REAL NOT NULL, rd REAL NOT NULL, volatility REAL NOT NULL,
        rated_campaigns INTEGER NOT NULL, last_rated_at INTEGER NOT NULL, PRIMARY KEY(season_id,uuid)
      );
      CREATE TABLE IF NOT EXISTS rating_changes (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, uuid TEXT NOT NULL, rules_version TEXT NOT NULL, team TEXT NOT NULL,
        score REAL NOT NULL, opp_rating REAL NOT NULL, opp_rd REAL NOT NULL,
        before_rating REAL NOT NULL, before_rd REAL NOT NULL, before_volatility REAL NOT NULL,
        after_rating REAL NOT NULL, after_rd REAL NOT NULL, after_volatility REAL NOT NULL, rated_at INTEGER NOT NULL, season_id TEXT NOT NULL,
        PRIMARY KEY(server_id,event_id,uuid), FOREIGN KEY(server_id,event_id) REFERENCES results(server_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS rating_changes_uuid ON rating_changes(uuid,rated_at);
      CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor_uuid TEXT NOT NULL, actor_name TEXT NOT NULL, role TEXT NOT NULL,
        action TEXT NOT NULL, target TEXT, detail TEXT, ok INTEGER NOT NULL, error TEXT, pending INTEGER,
        via TEXT NOT NULL DEFAULT 'ui', client TEXT, correlation TEXT
      );
      CREATE TABLE IF NOT EXISTS staff_roles (uuid TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL, maps TEXT);
      CREATE TABLE IF NOT EXISTS ingest_keys (id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS site_sessions (id TEXT PRIMARY KEY, drasl_token TEXT NOT NULL, uuid TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS site_sessions_uuid ON site_sessions(uuid,last_seen);
      CREATE TABLE IF NOT EXISTS server_samples (
        server_id TEXT NOT NULL, at INTEGER NOT NULL, tps REAL NOT NULL, mspt_avg REAL NOT NULL, mspt_p95 REAL, mspt_max REAL NOT NULL,
        players INTEGER, heap_used_mb INTEGER, heap_max_mb INTEGER, gc_pause_ms INTEGER, started_at INTEGER, PRIMARY KEY(server_id,at)
      );
      CREATE INDEX IF NOT EXISTS server_samples_at ON server_samples(at);
      CREATE TABLE IF NOT EXISTS server_events (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, duration_ms INTEGER,
        source TEXT, message TEXT NOT NULL, repeats INTEGER NOT NULL, PRIMARY KEY(server_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS server_events_at ON server_events(at);
      `
/** Newest matches one hit-reg report reads; the scan stops here and `truncated` says so. */
export const HITREG_SCAN_CAP = 5000
export class StatsStore {
  db: Database
  private constructor(location: string) {
    this.db = new Database(location)
  }
  static async open(location: string): Promise<StatsStore> {
    if (!/^postgres(?:ql)?:\/\//.test(location))
      throw new StatsError(503, 'BLOCKFIELD_DATABASE_URL must be a PostgreSQL URL')
    const store = new StatsStore(location)
    try {
      await store.initialize()
      return store
    } catch (error) {
      await store.close()
      throw error
    }
  }
  private async initialize() {
    await this.db.transaction(async () => {
      await this.db
        .exec(`CREATE TABLE IF NOT EXISTS blockfield_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
          INSERT INTO blockfield_schema VALUES (1,7) ON CONFLICT(id) DO NOTHING;`)
      const { version } = await this.db
        .prepare('SELECT version FROM blockfield_schema WHERE id=1')
        .get()
      // v6 -> v7: token-hash revocations are replaced by server-side sessions.
      if (version === 6)
        await this.db.exec(`DROP TABLE IF EXISTS revoked_sessions;
          UPDATE blockfield_schema SET version=7 WHERE id=1;`)
      if (version !== 6 && version !== 7)
        throw new Error('Unsupported statistics schema; restore/migrate explicitly')
      await this.db
        .exec(`CREATE OR REPLACE FUNCTION uuid_like(name TEXT) RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS
          $$ SELECT CASE WHEN trim(name) ~* '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$' THEN 1 ELSE 0 END $$;`)
      await this.db.exec(
        SCHEMA.replace(/\bINTEGER\b/g, 'BIGINT')
          .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
          .replace(
            /id BIGINT PRIMARY KEY/g,
            'id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY',
          ),
      )
      // v6 -> v7: token-hash revocations are replaced by server-side sessions; audit rows gain a pending flag.
      await this.db.exec('ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS pending BIGINT;')
      await this.db.exec(
        "ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'ui';",
      )
      await this.db.exec('ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS client TEXT;')
      await this.db.exec('ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS correlation TEXT;')
      // Crash orphans (pending rows from a killed request) are marked interrupted, never hidden.
      // A live row mis-marked by a concurrent replica still finalizes normally afterwards.
      await this.db
        .prepare(
          "UPDATE admin_audit SET pending=NULL,ok=0,error='Прервано перезапуском: проверьте, применилось ли изменение.' WHERE pending=1",
        )
        .run()
      // Sessions need the seal key: validate it while sessions exist, so a missing or
      // malformed secret fails fast instead of 503ing every login. Empty tables (fresh
      // installs, migrations, tests) need nothing.
      if (((await this.db.prepare('SELECT COUNT(*) n FROM site_sessions').get()) as any).n > 0) {
        const key = sessionKeyBytes()
        const sample = (await this.db
          .prepare('SELECT drasl_token "token" FROM site_sessions ORDER BY last_seen DESC LIMIT 1')
          .get()) as { token: string } | undefined
        if (sample && openTokenRaw(sample.token, key) === null)
          console.error('session secret changed: all sessions invalid')
      }
    })
  }
  async close() {
    await this.db.close()
  }
  async ingest(input: unknown): Promise<{ inserted: boolean; eventId: string }> {
    const result = validateResult(input),
      payload = canonical(result),
      digest = createHash('sha256').update(payload).digest('hex')
    return this.db.transaction(async () => {
      const existing = (await this.db
        .prepare('SELECT digest FROM results WHERE server_id=? AND event_id=?')
        .get(result.serverId, result.eventId)) as { digest: string } | undefined
      if (existing) {
        if (existing.digest !== digest)
          throw new StatsError(409, 'Result ID already exists with different content')
        return { inserted: false, eventId: result.eventId }
      }
      await this.db
        .prepare(
          'INSERT INTO results (server_id,event_id,kind,mode,campaign_id,ended_at,reason,winner,digest,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          result.serverId,
          result.eventId,
          result.kind,
          result.modeId,
          result.campaignSessionId,
          Date.parse(result.endedAt),
          result.endReason,
          result.winner,
          digest,
          payload,
        )
      const participant = this.db.prepare(
        'INSERT INTO participants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      // The mod sends the UUID as the name when it does not know the nickname: a real name always wins over a UUID-like one, regardless of order.
      const profile = this.db
        .prepare(`INSERT INTO profiles VALUES (?,?,?) ON CONFLICT(uuid) DO UPDATE SET
        name=CASE WHEN uuid_like(excluded.name)=1 AND uuid_like(profiles.name)=0 THEN profiles.name
          WHEN excluded.last_seen>=profiles.last_seen OR uuid_like(profiles.name)=1 THEN excluded.name ELSE profiles.name END,
        last_seen=greatest(profiles.last_seen,excluded.last_seen)`)
      const cls = this.db.prepare('INSERT INTO classes VALUES (?,?,?,?,?,?,?,?,?)')
      for (const p of result.participants) {
        await profile.run(p.uuid, p.name, Date.parse(result.endedAt))
        await participant.run(
          result.serverId,
          result.eventId,
          p.uuid,
          p.team,
          p.score,
          p.kills,
          p.deaths,
          p.captures,
          p.neutralizations,
          p.pointSeconds,
          p.playSeconds,
          p.suicides,
          p.teamKills,
          p.maxKillstreak,
        )
        for (const c of p.classes)
          await cls.run(
            result.serverId,
            result.eventId,
            p.uuid,
            c.classId,
            c.variantId,
            c.timeSeconds,
            c.kills,
            c.deaths,
            c.pointSeconds,
          )
      }
      // Only a fresh insert rates: outbox replays return above, so one campaign changes MMR at most once.
      if (rated(result)) await this.rate(result)
      return { inserted: true, eventId: result.eventId }
    })
  }
  /**
   * One Glicko-2 period per rated player: the whole opposing side as a composite opponent. Team NONE is unrated.
   * The season comes from endedAt. A player's first campaign in a season starts from their latest earlier season, soft-reset once per boundary crossed.
   * ponytail: a late result rates only its own season; later seasons that already carried over from it are not recomputed
   * until an administrator voids/restores a rated result, which replays that season and every later one (rebuildRatings).
   */
  private async rate(result: Result) {
    const sides = {
      RED: result.participants.filter((p) => p.team === 'RED'),
      BLUE: result.participants.filter((p) => p.team === 'BLUE'),
    }
    if (!sides.RED.length || !sides.BLUE.length) return
    const ended = Date.parse(result.endedAt),
      season = seasonAt(ended),
      seasonNumber = Number(season.id.slice(1))
    const periods = (since: number) => Math.floor(Math.max(0, ended - since) / RATING_PERIOD_MS)
    const load = this.db.prepare(
      'SELECT rating,rd,volatility,rated_campaigns "ratedCampaigns",last_rated_at "lastRatedAt" FROM ratings WHERE season_id=? AND uuid=?',
    )
    const carry = this.db
      .prepare(`SELECT rating,rd,volatility,CAST(substr(season_id,2) AS INTEGER) "seasonNumber" FROM ratings
      WHERE uuid=? AND CAST(substr(season_id,2) AS INTEGER)<? ORDER BY "seasonNumber" DESC LIMIT 1`)
    const before = new Map(
      await Promise.all(
        [...sides.RED, ...sides.BLUE].map(async (p) => {
          const row = (await load.get(season.id, p.uuid)) as
            | {
                rating: number
                rd: number
                volatility: number
                ratedCampaigns: number
                lastRatedAt: number
              }
            | undefined
          const previous = row
            ? undefined
            : ((await carry.get(p.uuid, seasonNumber)) as
                | { rating: number; rd: number; volatility: number; seasonNumber: number }
                | undefined)
          const rating = row
            ? inflate(
                { rating: row.rating, rd: row.rd, volatility: row.volatility },
                periods(row.lastRatedAt),
              )
            : previous
              ? inflate(
                  softReset(previous, seasonNumber - previous.seasonNumber),
                  periods(Date.parse(season.startsAt)),
                )
              : initial()
          return [p.uuid, { rating, campaigns: row?.ratedCampaigns ?? 0 }] as const
        }),
      ),
    )
    const save = this.db
      .prepare(`INSERT INTO ratings (season_id,uuid,rating,rd,volatility,rated_campaigns,last_rated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(season_id,uuid) DO UPDATE SET rating=excluded.rating,rd=excluded.rd,
      volatility=excluded.volatility,rated_campaigns=excluded.rated_campaigns,last_rated_at=greatest(ratings.last_rated_at,excluded.last_rated_at)`)
    const change = this.db.prepare(
      'INSERT INTO rating_changes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    for (const team of ['RED', 'BLUE'] as const) {
      const opponent = composite(
        sides[team === 'RED' ? 'BLUE' : 'RED'].map((o) => before.get(o.uuid)!.rating),
      )
      const score = result.endReason === 'draw' ? 0.5 : result.winner === team ? 1 : 0
      for (const p of sides[team]) {
        const { rating: from, campaigns } = before.get(p.uuid)!,
          to = update(from, [{ opponent, score }])
        await save.run(season.id, p.uuid, to.rating, to.rd, to.volatility, campaigns + 1, ended)
        await change.run(
          result.serverId,
          result.eventId,
          p.uuid,
          RULES_VERSION,
          team,
          score,
          opponent.rating,
          opponent.rd,
          from.rating,
          from.rd,
          from.volatility,
          to.rating,
          to.rd,
          to.volatility,
          ended,
          season.id,
        )
      }
    }
  }
  /** Deterministic replay of every non-voided rated campaign from `seasonId` on; earlier seasons (the carry-over source) stay untouched. Call inside a transaction. */
  private async rebuildRatings(season: Season) {
    const number = Number(season.id.slice(1)),
      since = number === 1 ? Number.MIN_SAFE_INTEGER : Date.parse(season.startsAt)
    await this.db
      .prepare('DELETE FROM rating_changes WHERE CAST(substr(season_id,2) AS INTEGER)>=?')
      .run(number)
    await this.db
      .prepare('DELETE FROM ratings WHERE CAST(substr(season_id,2) AS INTEGER)>=?')
      .run(number)
    const rows = (await this.db
      .prepare(
        `SELECT payload FROM results WHERE kind='campaign' AND mode='campaign' AND reason IN ('completed','draw') AND voided_at IS NULL AND ended_at>=?
      ORDER BY ended_at,server_id,event_id`,
      )
      .all(since)) as { payload: string }[]
    for (const row of rows) await this.rate(JSON.parse(row.payload))
  }
  async setVoided(serverId: string, eventId: string, by: string | null) {
    return this.db.transaction(async () => {
      const row = (await this.db
        .prepare('SELECT payload,voided_at FROM results WHERE server_id=? AND event_id=?')
        .get(serverId, eventId)) as { payload: string; voided_at: number | null } | undefined
      if (!row) throw new StatsError(404, 'Result not found')
      if ((row.voided_at !== null) === (by !== null))
        throw new StatsError(409, by ? 'Result is already voided' : 'Result is not voided')
      await this.db
        .prepare('UPDATE results SET voided_at=?,voided_by=? WHERE server_id=? AND event_id=?')
        .run(by ? Date.now() : null, by, serverId, eventId)
      // seasonAt generates seasons up to endedAt, which may be a few minutes ahead of now (and of the current season).
      const result: Result = JSON.parse(row.payload),
        season = rated(result) ? seasonAt(Date.parse(result.endedAt)) : null
      if (season) await this.rebuildRatings(season)
      return {
        rebuilt: season?.id ?? null,
        match: {
          kind: result.kind,
          mode: result.modeId,
          mapId: result.mapId,
          endedAt: Date.parse(result.endedAt),
        },
      }
    })
  }
  async results(mode: string | null, page: number, limit = 25) {
    if (mode !== null && !MODES.includes(mode)) throw new StatsError(400, 'Unknown mode')
    const rows = (await this.db
      .prepare(
        `SELECT server_id "serverId",event_id "eventId",kind,mode,ended_at "endedAt",reason,winner,voided_at "voidedAt",voided_by "voidedBy",payload
      FROM results WHERE (CAST(? AS TEXT) IS NULL OR mode=?) ORDER BY ended_at DESC,server_id,event_id LIMIT ? OFFSET ?`,
      )
      .all(mode, mode, limit, (page - 1) * limit)) as any[]
    const { total } = (await this.db
      .prepare('SELECT COUNT(*) total FROM results WHERE (CAST(? AS TEXT) IS NULL OR mode=?)')
      .get(mode, mode)) as { total: number }
    const known = this.db.prepare('SELECT name FROM profiles WHERE uuid=?')
    return {
      total,
      page,
      limit,
      results: await Promise.all(
        rows.map(async ({ payload, ...row }) => {
          const result: Result = JSON.parse(payload),
            name = async (p: Participant) =>
              ((await known.get(p.uuid)) as { name: string } | undefined)?.name ?? p.name
          const players = [...result.participants].sort((a, b) => b.score - a.score)
          return {
            ...row,
            rated: rated(result),
            mapId: result.mapId,
            participants: players.length,
            winnerName: result.winnerUuid
              ? displayName(await name(players.find((p) => p.uuid === result.winnerUuid)!))
              : null,
            players: await Promise.all(
              players.slice(0, 12).map(async (p) => ({
                uuid: p.uuid,
                name: displayName(await name(p)),
                team: p.team,
              })),
            ),
          }
        }),
      ),
    }
  }
  /** Hit-reg telemetry aggregated over a window. The sums and per-match percentiles come
   * straight from PostgreSQL (jsonb operators, SUM, percentile_cont); Node never parses
   * per-row telemetry. The scan stops at the HITREG_SCAN_CAP newest matches (`truncated` says so). */
  async hitreg(mode: string | null, since: number, until: number) {
    if (mode !== null && !MODES.includes(mode)) throw new StatsError(400, 'Unknown mode')
    // ponytail: payloads stay schemaless so telemetry needs no migration; the window scan stops
    // at HITREG_SCAN_CAP newest matches (truncated says so) and the report stays staff-only.
    const scan = `SELECT (payload::jsonb->'telemetry') t,
        row_number() OVER (ORDER BY ended_at DESC,server_id,event_id) rn FROM results
      WHERE kind='match' AND voided_at IS NULL AND ended_at>=? AND ended_at<=?
        AND (CAST(? AS TEXT) IS NULL OR mode=?) LIMIT ${HITREG_SCAN_CAP + 1}`
    const tele = (expr: string) => `(SELECT ${expr} FROM tele)`
    const mid = (field: string) =>
      `percentile_cont(0.5) WITHIN GROUP (ORDER BY (t->>'${field}')::double precision)`
    const p99 = (field: string) =>
      `percentile_cont(0.99) WITHIN GROUP (ORDER BY (t->>'${field}')::double precision)`
    const agg = (await this.db
      .prepare(
        `WITH scan AS (${scan}),
          capped AS (SELECT t FROM scan WHERE rn<=${HITREG_SCAN_CAP}),
          tele AS (SELECT t FROM capped WHERE jsonb_typeof(t)='object')
        SELECT (SELECT COUNT(*) FROM capped) matches,
          (SELECT COUNT(*) FROM scan)>${HITREG_SCAN_CAP} truncated,
          (SELECT COUNT(*) FROM tele) "withTelemetry",
          ${tele(`COALESCE(SUM((t->>'shots')::bigint),0)`)} shots,
          ${tele(`COALESCE(SUM((t->>'fallbackShare')::double precision*(t->>'shots')::bigint),0)`)} "fallbackShots",
          ${tele(`COALESCE(SUM(jsonb_array_length(t->'disputes')),0)`)} disputes,
          ${tele(mid('tickMsP50'))} "tickMsP50Median", ${tele(p99('tickMsP50'))} "tickMsP50P99",
          ${tele(mid('tickMsP99'))} "tickMsP99Median", ${tele(p99('tickMsP99'))} "tickMsP99P99",
          ${tele(mid('ageTicksP50'))} "ageTicksP50Median", ${tele(p99('ageTicksP50'))} "ageTicksP50P99",
          ${tele(mid('rewindTicksP50'))} "rewindTicksP50Median", ${tele(p99('rewindTicksP50'))} "rewindTicksP50P99"`,
      )
      .get(since, until, mode, mode)) as {
      matches: number
      truncated: boolean
      withTelemetry: number
      shots: number
      fallbackShots: number
      disputes: number
      tickMsP50Median: number | null
      tickMsP50P99: number | null
      tickMsP99Median: number | null
      tickMsP99P99: number | null
      ageTicksP50Median: number | null
      ageTicksP50P99: number | null
      rewindTicksP50Median: number | null
      rewindTicksP50P99: number | null
    }
    // One row per counter name; validated blocks keep ≤512 names each (see validateTelemetry).
    const counterRows = (await this.db
      .prepare(
        `WITH scan AS (${scan}),
          capped AS (SELECT t FROM scan WHERE rn<=${HITREG_SCAN_CAP} AND jsonb_typeof(t)='object')
        SELECT name,SUM(value::bigint) total FROM capped
          CROSS JOIN LATERAL jsonb_each_text(
            CASE WHEN jsonb_typeof(t->'counters')='object' THEN t->'counters' ELSE '{}'::jsonb END
          ) c(name,value) GROUP BY name`,
      )
      .all(since, until, mode, mode)) as { name: string; total: number }[]
    return {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      mode,
      matches: agg.matches,
      withTelemetry: agg.withTelemetry,
      telemetryDropped,
      truncated: agg.truncated,
      shots: agg.shots,
      fallbackShare: agg.shots === 0 ? 0 : agg.fallbackShots / agg.shots,
      disputes: agg.disputes,
      counters: Object.fromEntries(counterRows.map((row) => [row.name, row.total])),
      tickMsP50Median: agg.tickMsP50Median,
      tickMsP50P99: agg.tickMsP50P99,
      tickMsP99Median: agg.tickMsP99Median,
      tickMsP99P99: agg.tickMsP99P99,
      ageTicksP50Median: agg.ageTicksP50Median,
      ageTicksP50P99: agg.ageTicksP50P99,
      rewindTicksP50Median: agg.rewindTicksP50Median,
      rewindTicksP50P99: agg.rewindTicksP50P99,
    }
  }
  /** Profiles whose stored name is a UUID (see ingest), among `uuids`. */
  async unnamed(uuids: string[]): Promise<string[]> {
    const row = this.db.prepare('SELECT 1 FROM profiles WHERE uuid=? AND uuid_like(name)=1')
    const missing: string[] = []
    for (const uuid of new Set(uuids)) if (await row.get(uuid)) missing.push(uuid)
    return missing
  }
  /** Stores a resolved nickname only over a UUID-like name, so a newer real name from ingest is never overwritten. */
  async rename(uuid: string, name: string) {
    await this.db
      .prepare('UPDATE profiles SET name=? WHERE uuid=? AND uuid_like(name)=1')
      .run(name, uuid)
  }
  async createIngestKey(serverId: string, label: string): Promise<string> {
    const key = randomBytes(32).toString('base64url')
    await this.db
      .prepare(
        'INSERT INTO ingest_keys (server_id,key_hash,label,created_at,revoked_at) VALUES (?,?,?,?,NULL)',
      )
      .run(serverId, sha256(key).toString('hex'), label, Date.now())
    return key
  }
  async ingestKeys() {
    return await this.db
      .prepare(
        'SELECT id,server_id "serverId",label,created_at "createdAt",revoked_at "revokedAt" FROM ingest_keys ORDER BY id DESC',
      )
      .all()
  }
  async revokeIngestKey(id: number): Promise<boolean> {
    return (
      (
        await this.db
          .prepare('UPDATE ingest_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
          .run(Date.now(), id)
      ).changes === 1
    )
  }
  /** Server-side sessions: the cookie holds only a random id, the Drasl token never leaves the server. */
  async insertSession(id: string, token: string, uuid: string, now: number) {
    await this.db
      .prepare(
        'INSERT INTO site_sessions (id,drasl_token,uuid,created_at,last_seen) VALUES (?,?,?,?,?)',
      )
      .run(id, token, uuid, now, now)
  }
  async getSession(id: string): Promise<{ token: string; uuid: string } | undefined> {
    const row = (await this.db
      .prepare('SELECT drasl_token "token",uuid FROM site_sessions WHERE id=?')
      .get(id)) as { token: string; uuid: string } | undefined
    return row ?? undefined
  }
  async touchSession(id: string, now: number) {
    await this.db.prepare('UPDATE site_sessions SET last_seen=? WHERE id=?').run(now, id)
  }
  async deleteSession(id: string): Promise<boolean> {
    return (await this.db.prepare('DELETE FROM site_sessions WHERE id=?').run(id)).changes === 1
  }
  async deleteUserSessions(uuid: string) {
    await this.db.prepare('DELETE FROM site_sessions WHERE uuid=?').run(uuid)
  }
  /** One statement keeps the table bounded: stale rows go, each user keeps the newest `keep`. */
  async pruneSessions(uuid: string, cutoff: number, keep: number) {
    await this.db
      .prepare(
        'DELETE FROM site_sessions WHERE last_seen < ? OR (uuid=? AND id NOT IN (SELECT id FROM site_sessions WHERE uuid=? ORDER BY created_at DESC, id DESC LIMIT ?))',
      )
      .run(cutoff, uuid, uuid, keep)
  }
  async countSessions(): Promise<number> {
    return ((await this.db.prepare('SELECT COUNT(*) count FROM site_sessions').get()) as any).count
  }
  async ingestKeyHashes(serverId: string): Promise<Buffer[]> {
    return (
      (await this.db
        .prepare('SELECT key_hash h FROM ingest_keys WHERE server_id=? AND revoked_at IS NULL')
        .all(serverId)) as { h: string }[]
    ).map((r) => Buffer.from(r.h, 'hex'))
  }
  async audit(entry: AuditEntry) {
    const row = await this.db
      .prepare(
        'INSERT INTO admin_audit (at,actor_uuid,actor_name,role,action,target,detail,ok,error,pending,via,client,correlation) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?) RETURNING id,at,actor_uuid "actorUuid",actor_name "actorName",role,action,target,detail,ok,error,pending "pending",via,client,correlation "correlation"',
      )
      .get(...auditArgs(entry, Date.now()))
    publish({ type: 'audit', entry: row })
  }
  /** The attempt is journaled before the effect runs, so nothing goes unaudited; finalize updates the same row. */
  async auditPending(entry: AuditEntry): Promise<number> {
    const row = (await this.db
      .prepare(
        'INSERT INTO admin_audit (at,actor_uuid,actor_name,role,action,target,detail,ok,error,pending,via,client,correlation) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?) RETURNING id',
      )
      .get(...auditArgs(entry, Date.now()))) as { id: number }
    return row.id
  }
  async auditFinalize(id: number, entry: AuditEntry) {
    // No live event here: the caller publishes after the surrounding commit,
    // so a rolled-back write never shows as ok in the feed.
    // Transport stays as journaled: auditArgs still validates a supplied via,
    // but the row keeps auditPending's via/client/correlation.
    const args = auditArgs(entry, Date.now()).slice(0, 9)
    const row = await this.db
      .prepare(
        'UPDATE admin_audit SET at=?,actor_uuid=?,actor_name=?,role=?,action=?,target=?,detail=?,ok=?,error=?,pending=NULL WHERE id=? RETURNING id,at,actor_uuid "actorUuid",actor_name "actorName",role,action,target,detail,ok,error,pending "pending",via,client,correlation "correlation"',
      )
      .get(...args, id)
    return row
  }
  emitAudit(entry: any) {
    publish({ type: 'audit', entry })
  }
  /** Export finalized audit rows for owner-controlled archival. The hash anchors the
  export; retention deletion only accepts a manifest that still verifies (E5). */
  async exportAudit(): Promise<{ manifest: AuditExportManifest; jsonl: string }> {
    const rows = (await this.exportedRows(null, null)) as Record<string, unknown>[]
    const lines = rows.map((r) => JSON.stringify(AUDIT_EXPORT_COLUMNS.map((c) => r[c] ?? null)))
    const manifest: AuditExportManifest = {
      version: 1,
      exportedAt: Date.now(),
      firstId: rows.length ? (rows[0].id as number) : null,
      lastId: rows.length ? (rows[rows.length - 1].id as number) : null,
      count: rows.length,
      sha256: createHash('sha256').update(lines.join('\n')).digest('hex'),
    }
    return { manifest, jsonl: lines.join('\n') }
  }
  /** Parse and anchor a presented archive to its manifest: line count, id range and
  sha256 must all match. Pure: never reads the live table, so a manifest alone deletes nothing. */
  private archiveRows(manifest: AuditExportManifest, jsonl: string): Map<number, string> {
    if (manifest?.version !== 1 || !Number.isSafeInteger(manifest?.count) || manifest.count < 0)
      failDelete()
    if (typeof manifest?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256))
      failDelete()
    const lines = typeof jsonl === 'string' ? jsonl.split('\n').filter((l) => l.length > 0) : []
    if (lines.length !== manifest.count) failDelete()
    if (createHash('sha256').update(lines.join('\n')).digest('hex') !== manifest.sha256)
      failDelete()
    if (
      manifest.count > 0 &&
      (!Number.isSafeInteger(manifest.firstId) || !Number.isSafeInteger(manifest.lastId))
    )
      failDelete()
    const archived = new Map<number, string>()
    for (const line of lines) {
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        failDelete()
      }
      if (!Array.isArray(row) || !Number.isSafeInteger(row[0])) failDelete()
      const id = row[0] as number
      if (archived.has(id) || id < manifest.firstId! || id > manifest.lastId!) failDelete()
      archived.set(id, line)
    }
    return archived
  }
  /** Delete only archived rows whose live content still matches the archive, in one
  transaction. The DELETE targets the verified id set, never a re-evaluated range.
  Statements bind at most AUDIT_DELETE_CHUNK ids: one parameter per row would
  exceed the Postgres bind limit (65535 parameters) on large exports. */
  async deleteAuditExported(manifest: AuditExportManifest, jsonl: string): Promise<number> {
    const archived = this.archiveRows(manifest, jsonl)
    if (!manifest.count) {
      const live = (await this.db
        .prepare('SELECT COUNT(*) n FROM admin_audit WHERE pending IS NULL')
        .get()) as { n: number }
      if (live.n !== 0) failDelete()
      return 0
    }
    const ids = [...archived.keys()].sort((a, b) => a - b)
    return await this.db.transaction(async () => {
      const live: Record<string, unknown>[] = []
      for (let i = 0; i < ids.length; i += AUDIT_DELETE_CHUNK) {
        const chunk = ids.slice(i, i + AUDIT_DELETE_CHUNK)
        const inList = chunk.map(() => '?').join(',')
        live.push(
          ...((await this.db
            .prepare(
              `SELECT ${AUDIT_EXPORT_COLUMNS.join(',')} FROM admin_audit WHERE id IN (${inList})`,
            )
            .all(...chunk)) as Record<string, unknown>[]),
        )
      }
      const matched = live
        .filter(
          (r) =>
            archived.get(r.id as number) ===
            JSON.stringify(AUDIT_EXPORT_COLUMNS.map((c) => r[c] ?? null)),
        )
        .map((r) => r.id as number)
        .sort((a, b) => a - b)
      if (matched.length !== manifest.count) failDelete()
      let deleted = 0
      for (let i = 0; i < matched.length; i += AUDIT_DELETE_CHUNK) {
        const chunk = matched.slice(i, i + AUDIT_DELETE_CHUNK)
        deleted += (
          (await this.db
            .prepare(`DELETE FROM admin_audit WHERE id IN (${chunk.map(() => '?').join(',')})`)
            .run(...chunk)) as { changes: number }
        ).changes
      }
      if (deleted !== manifest.count) failDelete()
      return deleted
    })
  }
  private async exportedRows(firstId: number | null, lastId: number | null) {
    return await this.db
      .prepare(
        `SELECT ${AUDIT_EXPORT_COLUMNS.join(',')} FROM admin_audit WHERE pending IS NULL` +
          (firstId == null || lastId == null ? '' : ' AND id>=? AND id<=?') +
          ' ORDER BY id',
      )
      .all(...(firstId == null || lastId == null ? [] : [firstId, lastId]))
  }
  async staff(): Promise<
    {
      uuid: string
      name: string
      role: string
      grantedBy: string
      grantedAt: number
      maps: string[] | null
    }[]
  > {
    return (
      (await this.db
        .prepare(
          'SELECT uuid,name,role,granted_by "grantedBy",granted_at "grantedAt",maps FROM staff_roles ORDER BY lower(name),uuid',
        )
        .all()) as any[]
    ).map(({ maps, ...row }) => ({ ...row, maps: maps ? JSON.parse(maps) : null }))
  }
  async setStaff(uuid: string, name: string, role: string | null, by: string) {
    if (role === null) await this.db.prepare('DELETE FROM staff_roles WHERE uuid=?').run(uuid)
    // A fresh grant starts with every map; maps are set separately through setStaffMaps.
    else
      await this.db
        .prepare(
          'INSERT INTO staff_roles (uuid,name,role,granted_by,granted_at) VALUES (?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,role=excluded.role,granted_by=excluded.granted_by,granted_at=excluded.granted_at',
        )
        .run(uuid, name, role, by, Date.now())
  }
  /** `maps` null means every map; only meaningful for `builder` rows (checked by the caller). Returns false if `uuid` has no staff row. */
  async setStaffMaps(uuid: string, maps: string[] | null): Promise<boolean> {
    return (
      (
        await this.db
          .prepare('UPDATE staff_roles SET maps=? WHERE uuid=?')
          .run(maps ? JSON.stringify(maps) : null, uuid)
      ).changes === 1
    )
  }
  async auditLog(limit = 200) {
    // Pending=1 rows are unfinished attempts; the boot sweep marks orphans as interrupted.
    return await this.db
      .prepare(
        'SELECT id,at,actor_uuid "actorUuid",actor_name "actorName",role,action,target,detail,ok,error,pending "pending",via,client,correlation "correlation" FROM admin_audit ORDER BY id DESC LIMIT ?',
      )
      .all(limit)
  }
  async leaderboard(query: Filters, uuid: string | null = null) {
    // Campaign summaries contain the same players/counters: count combat metrics from MATCHES ONLY.
    const where = `r.kind='match' AND r.voided_at IS NULL AND r.ended_at>=? AND r.ended_at<=? AND (CAST(? AS TEXT) IS NULL OR r.mode=?)`
    const args = [query.since, query.until, query.mode, query.mode]
    // rank is numbered over the whole filtered aggregate BEFORE the uuid/page cut, so a player's rank matches the board.
    const rows = (await this.db
      .prepare(
        `SELECT * FROM (SELECT *,ROW_NUMBER() OVER (ORDER BY ${SORTS[query.sort]} DESC,uuid ASC) "rank" FROM (
      SELECT p.uuid,pr.name,SUM(p.score) score,SUM(p.kills) kills,SUM(p.deaths) deaths,
      SUM(p.captures) captures,SUM(p.neutralizations) neutralizations,SUM(p.point_seconds) "pointSeconds",
      SUM(p.play_seconds) "playSeconds",SUM(p.suicides) suicides,SUM(p.team_kills) "teamKills",MAX(p.max_streak) "maxKillstreak",
      COUNT(*) matches,SUM(CASE WHEN r.reason='completed' AND (
        (r.mode='deathmatch' AND (r.payload::jsonb->>'winnerUuid')=p.uuid) OR
        (r.mode!='deathmatch' AND p.team!='NONE' AND r.winner=p.team)
      ) THEN 1 ELSE 0 END) wins,
      ROUND(CAST(SUM(p.kills)*1.0/greatest(1,SUM(p.deaths)) AS NUMERIC),3) kd,
      MAX(rt.rating) rating,MAX(rt.rd) rd,MAX(rt.rated_campaigns) "ratedCampaigns"
      FROM participants p JOIN results r USING(server_id,event_id) JOIN profiles pr ON pr.uuid=p.uuid LEFT JOIN ratings rt ON rt.season_id=? AND rt.uuid=p.uuid
      WHERE ${where} GROUP BY p.uuid,pr.name) aggregate_rows) ranked_rows WHERE (CAST(? AS TEXT) IS NULL OR uuid=?) ORDER BY "rank" LIMIT ? OFFSET ?`,
      )
      .all(
        query.mmrSeason,
        ...args,
        uuid,
        uuid,
        query.limit,
        (query.page - 1) * query.limit,
      )) as any[]
    const total = (await this.db
      .prepare(
        `SELECT COUNT(DISTINCT p.uuid) total FROM participants p JOIN results r USING(server_id,event_id) WHERE ${where}`,
      )
      .get(...args)) as { total: number }
    return {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      mode: query.mode,
      season: query.season,
      mmrSeason: query.mmrSeason,
      page: query.page,
      limit: query.limit,
      total: total.total,
      ratingStatus: RULES_VERSION,
      players: rows.map(({ rating, rd, ratedCampaigns, ...row }) => ({
        ...row,
        mmr: mmr({ rating, rd, ratedCampaigns }),
      })),
    }
  }
  async player(uuid: string, query: Filters) {
    if (!UUID.test(uuid)) throw new StatsError(400, 'Invalid player UUID')
    const profile = await this.db
      .prepare('SELECT uuid,name,last_seen "lastSeen" FROM profiles WHERE uuid=?')
      .get(uuid)
    if (!profile) throw new StatsError(404, 'No recorded gameplay for this player')
    const totals =
      (await this.leaderboard({ ...query, page: 1, limit: 1 }, uuid)).players[0] || null
    const history = await this.db
      .prepare(
        `SELECT r.event_id "eventId",r.server_id "serverId",r.kind,r.mode,r.campaign_id "campaignSessionId",r.ended_at "endedAt",r.reason,r.winner,(r.payload::jsonb->>'winnerUuid') "winnerUuid",p.team,p.score,p.kills,p.deaths
      FROM participants p JOIN results r USING(server_id,event_id) WHERE p.uuid=? AND r.voided_at IS NULL AND r.ended_at>=? AND r.ended_at<=? AND (CAST(? AS TEXT) IS NULL OR r.mode=?)
      ORDER BY r.ended_at DESC,r.server_id,r.event_id LIMIT ? OFFSET ?`,
      )
      .all(
        uuid,
        query.since,
        query.until,
        query.mode,
        query.mode,
        query.limit,
        (query.page - 1) * query.limit,
      )
    const classes = await this.db
      .prepare(
        `SELECT c.class_id "classId",c.variant_id "variantId",SUM(c.time_seconds) "timeSeconds",SUM(c.kills) kills,SUM(c.deaths) deaths,SUM(c.point_seconds) "pointSeconds"
      FROM classes c JOIN results r USING(server_id,event_id) WHERE r.kind='match' AND r.voided_at IS NULL AND c.uuid=? AND r.ended_at>=? AND r.ended_at<=? AND (CAST(? AS TEXT) IS NULL OR r.mode=?)
      GROUP BY c.class_id,c.variant_id ORDER BY "timeSeconds" DESC,c.class_id,c.variant_id`,
      )
      .all(uuid, query.since, query.until, query.mode, query.mode)
    const campaigns = await this.db
      .prepare(
        `SELECT COUNT(*) completed,COALESCE(SUM(CASE WHEN r.winner=p.team AND p.team!='NONE' THEN 1 ELSE 0 END),0) wins
      FROM participants p JOIN results r USING(server_id,event_id) WHERE r.kind='campaign' AND r.voided_at IS NULL AND r.reason IN ('completed','draw') AND p.uuid=?
      AND r.ended_at>=? AND r.ended_at<=? AND (CAST(? AS TEXT) IS NULL OR r.mode=?)`,
      )
      .get(uuid, query.since, query.until, query.mode, query.mode)
    // mmr and ratingHistory belong to mmrSeason (selected or current); history is also cut to the requested window (Ranked campaigns only).
    const rating = (await this.db
      .prepare(
        'SELECT rating,rd,rated_campaigns "ratedCampaigns" FROM ratings WHERE season_id=? AND uuid=?',
      )
      .get(query.mmrSeason, uuid)) as any
    const ratingHistory = await this.db
      .prepare(
        `SELECT event_id "campaignSessionId",rated_at "ratedAt",team,score,ROUND(before_rating) before,ROUND(after_rating) after,ROUND(after_rd) rd
      FROM rating_changes WHERE uuid=? AND season_id=? AND rated_at>=? AND rated_at<=? AND (CAST(? AS TEXT) IS NULL OR ?='campaign') ORDER BY rated_at DESC,event_id LIMIT 20`,
      )
      .all(uuid, query.mmrSeason, query.since, query.until, query.mode, query.mode)
    return {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      season: query.season,
      mmrSeason: query.mmrSeason,
      profile,
      totals,
      classes,
      campaigns,
      history,
      page: query.page,
      limit: query.limit,
      mmr: rating ? mmr(rating) : null,
      ratingHistory,
      ratingStatus: RULES_VERSION,
    }
  }
}
export const UNKNOWN_PLAYER = 'Неизвестный игрок'
export const uuidLike = (name: string) =>
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(name.trim())
export const displayName = (name: string | null | undefined) =>
  !name || uuidLike(name) ? UNKNOWN_PLAYER : name

const lookups = new Map<string, Promise<string | null>>()
const missed = new Map<string, number>()
/**
 * Resolves UUID-like profile names through Drasl and caches hits into `profiles.name`. Waits at most `budgetMs`;
 * slower lookups keep running and still update the DB for the next render. Misses are not retried for 10 minutes.
 * Returns the names resolved within the budget.
 */
export async function resolveNames(
  store: StatsStore,
  uuids: string[],
  budgetMs = 1500,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const base = (process.env.DRASL_URL || 'https://skins.blockfield.pro').replace(/\/+$/, ''),
    now = Date.now(),
    found = new Map<string, string>()
  const pending = (await store.unnamed(uuids))
    .filter((uuid) => (missed.get(uuid) ?? 0) < now)
    .slice(0, 50)
    .map((uuid) => {
      let lookup = lookups.get(uuid)
      if (!lookup) {
        lookup = fetcher(`${base}/session/minecraft/profile/${uuid.replaceAll('-', '')}`, {
          signal: AbortSignal.timeout(10_000),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (data) =>
              typeof data?.name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(data.name)
                ? data.name
                : null,
            () => null,
          )
          .then(async (name) => {
            if (name) await store.rename(uuid, name)
            else missed.set(uuid, Date.now() + 600_000)
            return name
          })
          .catch(() => null)
          .finally(() => lookups.delete(uuid))
        lookups.set(uuid, lookup)
      }
      return lookup.then((name) => {
        if (name) found.set(uuid, name)
      })
    })
  if (!pending.length) return found
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => {
      timer = setTimeout(resolve, budgetMs)
    }),
  ])
  clearTimeout(timer)
  return new Map(found)
}

let singleton: Promise<StatsStore> | undefined
export function statsStore(): Promise<StatsStore> {
  if (singleton) return singleton
  const url = process.env.BLOCKFIELD_DATABASE_URL
  if (!url || !/^postgres(?:ql)?:\/\//.test(url))
    throw new StatsError(503, 'BLOCKFIELD_DATABASE_URL must be a PostgreSQL URL')
  return (singleton = StatsStore.open(url).catch((error) => {
    singleton = undefined
    throw error
  }))
}
export function ingestKeys(): Record<string, string[]> {
  try {
    const value = JSON.parse(process.env.BLOCKFIELD_STATS_INGEST_KEYS || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const result: Record<string, string[]> = {}
    for (const [server, tokens] of Object.entries(value)) {
      const list = typeof tokens === 'string' ? [tokens] : tokens
      if (
        !UUID.test(server) ||
        !Array.isArray(list) ||
        !list.length ||
        list.length > 2 ||
        !list.every((t) => typeof t === 'string' && /^[\x21-\x7e]{32,256}$/.test(t))
      )
        throw new Error()
      result[server] = list
    }
    return result
  } catch {
    throw new StatsError(503, 'Statistics ingestion keys are not configured correctly')
  }
}
const sha256 = (text: string) => createHash('sha256').update(text).digest()
const rated = (result: Result) =>
  result.kind === 'campaign' &&
  result.modeId === 'campaign' &&
  ['completed', 'draw'].includes(result.endReason)
/** Env keys or non-revoked DB keys (created in /admin); both compared as SHA-256 digests in constant time. */
async function authorized(
  request: Request,
  keys: Record<string, string[]>,
  store: () => StatsStore | Promise<StatsStore>,
): Promise<string> {
  const server = request.headers.get('X-Blockfield-Server-Id') || '',
    header = request.headers.get('Authorization') || ''
  if (!UUID.test(server)) throw new StatsError(401, 'Invalid producer credentials')
  const provided = sha256(header),
    bare = sha256(header.startsWith('Bearer ') ? header.slice(7) : '')
  let match = false
  for (const token of Object.hasOwn(keys, server) ? keys[server] : [])
    match = timingSafeEqual(provided, sha256(`Bearer ${token}`)) || match
  if (header.startsWith('Bearer '))
    for (const hash of await (await store()).ingestKeyHashes(server))
      match = timingSafeEqual(bare, hash) || match
  if (!match) throw new StatsError(401, 'Invalid producer credentials')
  return server
}
async function boundedJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    throw new StatsError(415, 'application/json required')
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY))
    throw new StatsError(413, 'Result too large')
  const reader = request.body?.getReader()
  if (!reader) throw new StatsError(400, 'Result body required')
  let size = 0,
    timeout: ReturnType<typeof setTimeout> | undefined
  const chunks: Uint8Array[] = []
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new StatsError(408, 'Body timeout')), 8000)
  })
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired])
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) throw new StatsError(413, 'Result too large')
      chunks.push(value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new StatsError(400, 'Invalid JSON')
    }
  } finally {
    clearTimeout(timeout)
    void reader.cancel().catch(() => {})
  }
}
export async function handleStatsRequest(
  request: Request,
  dependencies?: { store: StatsStore; keys: Record<string, string[]> },
): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  try {
    const url = new URL(request.url),
      path = url.pathname.replace(/\/$/, '')
    if (path === '/api/stats/results') {
      if (request.method !== 'POST')
        return Response.json(
          { error: 'Method not allowed' },
          { status: 405, headers: { ...headers, Allow: 'POST' } },
        )
      // Authenticate before reading any request body.
      const server = await authorized(
          request,
          dependencies?.keys ?? ingestKeys(),
          async () => dependencies?.store ?? (await statsStore()),
        ),
        input = validateResult(await boundedJson(request))
      if (input.serverId !== server)
        throw new StatsError(403, 'Producer cannot submit another server identity')
      const result = await (dependencies?.store ?? (await statsStore())).ingest(input)
      return Response.json(result, { status: result.inserted ? 201 : 200, headers })
    }
    // Health samples and freeze/error journal: the same producer keys and server identity rule as results.
    if (path === '/api/stats/diagnostics') {
      if (request.method !== 'POST')
        return Response.json(
          { error: 'Method not allowed' },
          { status: 405, headers: { ...headers, Allow: 'POST' } },
        )
      const store = async () => dependencies?.store ?? (await statsStore())
      const server = await authorized(request, dependencies?.keys ?? ingestKeys(), store),
        report = validateReport(await boundedJson(request))
      if (report.serverId !== server)
        throw new StatsError(403, 'Producer cannot submit another server identity')
      return Response.json(await saveReport((await store()).db, report), { headers })
    }
    if (request.method !== 'GET')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { ...headers, Allow: 'GET' } },
      )
    if (path === '/api/stats/seasons') {
      const list = seasons()
      return Response.json(
        { schemaVersion: 1, current: list.at(-1)?.id ?? null, seasons: list },
        { headers },
      )
    }
    const query = filters(url.searchParams)
    const store = dependencies?.store ?? (await statsStore())
    // Clients (site, launcher) show `name` as is, so a UUID-like name is resolved or replaced here.
    const named = async <T extends { uuid: string; name: string }>(rows: T[]) => {
      const names = await resolveNames(
        store,
        rows.filter((r) => uuidLike(r.name)).map((r) => r.uuid),
      )
      for (const row of rows) row.name = displayName(names.get(row.uuid) ?? row.name)
    }
    if (path === '/api/stats/leaderboard') {
      const board = await store.leaderboard(query)
      await named(board.players)
      return Response.json(board, { headers })
    }
    const player = /^\/api\/stats\/players\/([^/]+)$/.exec(path)
    if (player) {
      const data = (await store.player(player[1], query)) as any
      await named([data.profile, ...(data.totals ? [data.totals] : [])])
      // ponytail: staff without recorded gameplay 404 above, so the launcher shows them as a player; add a role endpoint if that matters.
      data.profile.role = await roleOf(playerId(player[1])!, store)
      return Response.json(data, { headers })
    }
    throw new StatsError(404, 'Unknown statistics endpoint')
  } catch (error) {
    if (!(error instanceof StatsError))
      console.error(
        'Statistics storage operation failed',
        error instanceof Error ? error.message : 'unknown',
      )
    return Response.json(
      { error: error instanceof StatsError ? error.message : 'Statistics storage unavailable' },
      { status: error instanceof StatsError ? error.status : 503, headers },
    )
  }
}
