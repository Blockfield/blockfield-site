/**
 * Game-server health: periodic tick/memory samples and a journal of freezes and errors, pushed by the server
 * through the statistics producer path (`POST /api/stats/diagnostics`, same keys as results). Server-only.
 */
import type { Database } from './database.ts'
import { StatsError } from './stats.ts'

const MINUTE = 60_000,
  DAY = 24 * 60 * MINUTE
export const SAMPLE_DAYS = 7
export const EVENT_DAYS = 14
const MAX_EVENTS = 5000,
  MAX_SAMPLES = 50_000
const KINDS = new Set(['freeze', 'error', 'warning', 'crash'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type Sample = {
  at: number
  tps: number
  msptAvg: number
  msptP95: number | null
  msptMax: number
  players: number | null
  heapUsedMb: number | null
  heapMaxMb: number | null
  gcPauseMs: number | null
}
export type ServerEvent = {
  id: string
  at: number
  kind: string
  durationMs: number | null
  source: string | null
  message: string
  repeats: number
}
export type Report = {
  serverId: string
  startedAt: number | null
  samples: Sample[]
  events: ServerEvent[]
}

/**
 * Log text may carry player IPs, webhook/API URLs, e-mails and credentials; none of it is stored.
 * ponytail: pattern-based, so an unusual secret format can slip through; the producer must not send secret-bearing loggers either.
 */
export function redact(text: string): string {
  return (
    text
      .replace(/[^\S\n]*(?:(?![\n\t])\p{Cc})[^\S\n]*/gu, ' ')
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[url]')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[ip]')
      // IPv6: five or more groups (timestamps have at most three) or a compressed `::` form.
      .replace(/\[?\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b\]?(?::\d{1,5})?/gi, '[ip]')
      .replace(
        /(?<![\w:])\[?(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\]?(?::\d{1,5})?(?![\w:])/gi,
        '[ip]',
      )
      .replace(/\b(bearer)\s+\S+/gi, '$1 [secret]')
      .replace(
        /\b(authorization|token|password|passwd|secret|api[_-]?key|access[_-]?key)(\s*[:=]\s*)("[^"]*"|\S+)/gi,
        '$1$2[secret]',
      )
      // Long mixed letter+digit runs look like keys; canonical UUIDs (rooms, players) stay readable.
      .replace(
        /\b(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{32,}/g,
        '[secret]',
      )
  )
}

// `whole` fields are BIGINT columns on PostgreSQL, which refuses fractions.
const finite = (value: unknown, min: number, max: number, whole: boolean) =>
  typeof value === 'number' &&
  (whole ? Number.isSafeInteger(value) : Number.isFinite(value)) &&
  value >= min &&
  value <= max
function optional(value: unknown, min: number, max: number, name: string, whole = false) {
  if (value === undefined || value === null) return null
  if (!finite(value, min, max, whole)) throw new StatsError(400, `Invalid ${name}`)
  return value as number
}
function required(value: unknown, min: number, max: number, name: string, whole = false) {
  if (!finite(value, min, max, whole)) throw new StatsError(400, `Invalid ${name}`)
  return value as number
}
function line(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new StatsError(400, 'Invalid text')
  const text = redact(value).trim()
  return text ? text.slice(0, max) : null
}

/** Schema v1. Items outside retention are dropped, future ones (beyond clock skew) refuse the whole report. */
export function validateReport(value: any, now = Date.now()): Report {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    typeof value.serverId !== 'string' ||
    !UUID.test(value.serverId) ||
    !Array.isArray(value.samples ?? []) ||
    !Array.isArray(value.events ?? []) ||
    (value.samples ?? []).length > 120 ||
    (value.events ?? []).length > 200
  )
    throw new StatsError(400, 'Invalid diagnostics report')
  const time = (at: unknown) => required(at, 0, now + 5 * MINUTE, 'time', true)
  const samples = (value.samples ?? []).map((s: any): Sample => {
    if (!s || typeof s !== 'object') throw new StatsError(400, 'Invalid sample')
    return {
      at: time(s.at),
      tps: required(s.tps, 0, 1000, 'tps'),
      msptAvg: required(s.msptAvg, 0, 3_600_000, 'msptAvg'),
      msptP95: optional(s.msptP95, 0, 3_600_000, 'msptP95'),
      msptMax: required(s.msptMax, 0, 3_600_000, 'msptMax'),
      players: optional(s.players, 0, 10_000, 'players', true),
      heapUsedMb: optional(s.heapUsedMb, 0, 1_048_576, 'heapUsedMb', true),
      heapMaxMb: optional(s.heapMaxMb, 0, 1_048_576, 'heapMaxMb', true),
      gcPauseMs: optional(s.gcPauseMs, 0, 3_600_000, 'gcPauseMs', true),
    }
  })
  const events = (value.events ?? []).map((e: any): ServerEvent => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !UUID.test(e.id))
      throw new StatsError(400, 'Invalid event id')
    if (!KINDS.has(e.kind)) throw new StatsError(400, 'Invalid event kind')
    const message = line(e.message, 4000)
    if (!message) throw new StatsError(400, 'Event message required')
    return {
      id: e.id,
      at: time(e.at),
      kind: e.kind,
      durationMs:
        e.kind === 'freeze'
          ? required(e.durationMs, 0, 3_600_000, 'durationMs', true)
          : optional(e.durationMs, 0, 3_600_000, 'durationMs', true),
      source: line(e.source, 120),
      message,
      repeats: Number.isSafeInteger(e.repeats ?? 1) && (e.repeats ?? 1) >= 1 ? (e.repeats ?? 1) : 1,
    }
  })
  return {
    serverId: value.serverId,
    startedAt: optional(value.startedAt, 0, now + 5 * MINUTE, 'startedAt', true),
    samples: samples.filter((s: Sample) => s.at >= now - SAMPLE_DAYS * DAY),
    events: events.filter((e: ServerEvent) => e.at >= now - EVENT_DAYS * DAY),
  }
}

/** Idempotent: a resent sample (same time) or event (same id) is ignored. Prunes by age and by row count. */
export async function saveReport(db: Database, report: Report, now = Date.now()) {
  return db.transaction(async () => {
    for (const s of report.samples)
      await db
        .prepare(
          'INSERT INTO server_samples (server_id,at,tps,mspt_avg,mspt_p95,mspt_max,players,heap_used_mb,heap_max_mb,gc_pause_ms,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .run(
          report.serverId,
          s.at,
          s.tps,
          s.msptAvg,
          s.msptP95,
          s.msptMax,
          s.players,
          s.heapUsedMb,
          s.heapMaxMb,
          s.gcPauseMs,
          report.startedAt,
        )
    for (const e of report.events)
      await db
        .prepare(
          'INSERT INTO server_events (server_id,event_id,at,kind,duration_ms,source,message,repeats) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .run(report.serverId, e.id, e.at, e.kind, e.durationMs, e.source, e.message, e.repeats)
    await db.prepare('DELETE FROM server_samples WHERE at < ?').run(now - SAMPLE_DAYS * DAY)
    await db.prepare('DELETE FROM server_events WHERE at < ?').run(now - EVENT_DAYS * DAY)
    await db
      .prepare(
        `DELETE FROM server_samples WHERE at < (SELECT at FROM server_samples ORDER BY at DESC LIMIT 1 OFFSET ${MAX_SAMPLES})`,
      )
      .run()
    await db
      .prepare(
        `DELETE FROM server_events WHERE at < (SELECT at FROM server_events ORDER BY at DESC LIMIT 1 OFFSET ${MAX_EVENTS})`,
      )
      .run()
    return { samples: report.samples.length, events: report.events.length }
  })
}

/** For /admin: the last `hours` of samples, the newest 500 events, and when anything last arrived at all. */
export async function readDiagnostics(db: Database, hours = 24, now = Date.now()) {
  const samples = await db
    .prepare(
      `SELECT server_id "serverId",at,tps,mspt_avg "msptAvg",mspt_p95 "msptP95",mspt_max "msptMax",players,heap_used_mb "heapUsedMb",heap_max_mb "heapMaxMb",gc_pause_ms "gcPauseMs",started_at "startedAt" FROM server_samples WHERE at >= ? ORDER BY at LIMIT 5000`,
    )
    .all(now - hours * 60 * MINUTE)
  const events = await db
    .prepare(
      `SELECT server_id "serverId",event_id id,at,kind,duration_ms "durationMs",source,message,repeats FROM server_events ORDER BY at DESC LIMIT 500`,
    )
    .all()
  const last = await db.prepare('SELECT max(at) "last" FROM server_samples').get()
  return { now, hours, lastSampleAt: last?.last ?? null, samples, events }
}

/**
 * Vanilla `tick query` (1.20.3+) over RCON: the server's own tick-time window (last 100 ticks), no mod needed.
 * RCON concatenates the command's messages without separators, so every field is matched on its own.
 */
export function parseTickQuery(output: string) {
  // The server formats with `%.1f` in its default locale: `80,0` under a Russian JVM locale.
  const num = (pattern: RegExp) => {
    const match = pattern.exec(output)
    return match ? Number(match[1].replace(',', '.')) : null
  }
  const target = num(/Target tick rate: (\d+(?:[.,]\d+)?)/),
    msptAvg = num(/Average time per tick: (\d+(?:[.,]\d+)?)ms/)
  if (target === null || msptAvg === null) return null
  const state = /frozen/.test(output)
    ? 'frozen'
    : /can't keep up/.test(output)
      ? 'lagging'
      : /sprinting/.test(output)
        ? 'sprinting'
        : 'running'
  return {
    state,
    targetTps: target,
    tps: state === 'frozen' ? 0 : Math.min(target, msptAvg > 0 ? 1000 / msptAvg : target),
    msptAvg,
    msptP50: num(/P50: (\d+(?:[.,]\d+)?)ms/),
    msptP95: num(/P95: (\d+(?:[.,]\d+)?)ms/),
    msptP99: num(/P99: (\d+(?:[.,]\d+)?)ms/),
    sample: num(/sample: (\d+)/),
  }
}
