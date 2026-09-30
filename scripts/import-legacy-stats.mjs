import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StatsStore, validateResult } from '../src/lib/stats.ts'

function requireValue(ok, message) {
  if (!ok) throw new Error(message)
}
function identity(parts) {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
function timestamp(value) {
  const m =
    typeof value === 'string' &&
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT([+-])(\d{2})(\d{2}) \([^)]+\)$/.exec(
      value,
    )
  requireValue(m, 'Legacy timestamp requires the Java date format with an explicit GMT offset')
  const month = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').indexOf(m[1])
  const wall = Date.UTC(+m[3], month, +m[2], +m[4], +m[5], +m[6])
  const date = new Date(wall)
  requireValue(
    date.getUTCFullYear() === +m[3] &&
      date.getUTCMonth() === month &&
      date.getUTCDate() === +m[2] &&
      date.getUTCHours() === +m[4] &&
      date.getUTCMinutes() === +m[5] &&
      date.getUTCSeconds() === +m[6] &&
      +m[8] <= 14 &&
      +m[9] < 60 &&
      (+m[8] < 14 || +m[9] === 0),
    'Invalid legacy timestamp',
  )
  const offset = (+m[8] * 60 + +m[9]) * (m[7] === '+' ? 1 : -1)
  return new Date(wall - offset * 60000).toISOString()
}

function team(value, uuid, mode) {
  if (mode === 'deathmatch' && value === `ffa_${uuid}`) return 'NONE'
  const result = {
    RedTeam: 'RED',
    BlueTeam: 'BLUE',
    RED: 'RED',
    BLUE: 'BLUE',
    NONE: 'NONE',
    '': 'NONE',
  }[value]
  requireValue(result !== undefined, `Unknown team: ${value}`)
  return result
}

/** Unknown purposes, overlapping player segments and ambiguous class names fail closed. */
export function convertLegacy(raw, context, classMap = {}) {
  requireValue(context?.sessionPurpose === 'gameplay', 'Reviewed gameplay provenance is required')
  requireValue(
    raw.SessionPurpose === undefined || raw.SessionPurpose === 'gameplay',
    'Non-gameplay source rejected',
  )
  requireValue(
    Array.isArray(raw.Players) && Array.isArray(raw.ArchivedPlayers),
    'Expected a legacy match, not a campaign summary',
  )
  requireValue(
    ['room', 'campaign', 'deathmatch'].includes(context.modeId),
    'Explicit mode mapping required',
  )
  const expectedMode = context.modeId === 'deathmatch' ? 'Deathmatch' : 'Campaign'
  requireValue(raw.GameMode === expectedMode, 'Mode mapping conflicts with source')
  const eventId =
    raw.EventId ??
    identity([
      context.serverId,
      raw.GameMode,
      raw.CampaignId,
      raw.MatchNumber,
      raw.MapName,
      raw.StartDate,
    ])
  requireValue(
    Number.isSafeInteger(raw.MatchNumber) &&
      raw.MatchNumber > 0 &&
      typeof raw.MapName === 'string' &&
      raw.MapName,
    'Missing match identity',
  )
  const endReason = {
    Normal: 'completed',
    Stopped: 'stopped',
    Shutdown: 'shutdown',
    Draw: 'draw',
    Abandoned: 'abandoned',
    Error: 'error',
  }[raw.MatchEndStatus]
  requireValue(endReason, `Unknown finalization: ${raw.MatchEndStatus}`)
  const seen = new Set()
  const participants = [...raw.Players, ...raw.ArchivedPlayers].map((p) => {
    requireValue(
      !seen.has(p.Uuid),
      `Ambiguous overlapping/team segments for ${p.Uuid}; reconcile explicitly before import`,
    )
    seen.add(p.Uuid)
    requireValue(
      p.Classes && typeof p.Classes === 'object' && !Array.isArray(p.Classes),
      'Missing class breakdown',
    )
    const classes = Object.entries(p.Classes).map(([label, c]) => {
      const mapped =
        c.ClassId && c.VariantId ? { classId: c.ClassId, variantId: c.VariantId } : classMap[label]
      requireValue(mapped, `Unknown legacy class: ${label}`)
      return {
        ...mapped,
        timeSeconds: c.Time,
        kills: c.Kills,
        deaths: c.Deaths,
        pointSeconds: c.PointTime,
      }
    })
    return {
      uuid: p.Uuid,
      name: p.Name,
      team: team(p.Team, p.Uuid, context.modeId),
      score: p.Score,
      kills: p.Kills,
      deaths: p.Deaths,
      captures: p.Captures,
      neutralizations: p.Neutralizations,
      pointSeconds: p.PointTime,
      playSeconds: classes.reduce((sum, c) => sum + c.timeSeconds, 0),
      suicides: p.Suicides,
      teamKills: p.TeamKills,
      maxKillstreak: p.MaxKillstreak,
      classes,
    }
  })
  return validateResult({
    schemaVersion: 1,
    eventId,
    matchId: eventId,
    serverId: context.serverId,
    kind: 'match',
    sessionPurpose: 'gameplay',
    modeId: context.modeId,
    ranked: context.modeId === 'campaign',
    rulesetVersion: 'legacy-import-v1',
    mapId: context.mapId,
    campaignSessionId: context.modeId === 'campaign' ? context.campaignSessionId : null,
    startedAt: timestamp(raw.StartDate),
    endedAt: timestamp(raw.EndDate),
    endReason,
    winner: endReason === 'completed' ? team(raw.Winner, '', context.modeId) : 'NONE',
    participants,
    rounds: [],
  })
}

export async function importManifest(manifestPath, database, apply = false) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  requireValue(Array.isArray(manifest.files), 'Manifest files array required')
  const report = []
  const store = apply ? await StatsStore.open(database) : null
  try {
    for (const entry of manifest.files) {
      try {
        const bytes = readFileSync(resolve(dirname(manifestPath), entry.path))
        requireValue(bytes.length <= 1_048_576, 'Source exceeds 1 MiB')
        requireValue(
          createHash('sha256').update(bytes).digest('hex') === entry.sha256,
          'Reviewed source checksum mismatch',
        )
        const result = convertLegacy(
          JSON.parse(bytes),
          { ...entry, serverId: manifest.serverId },
          manifest.classMap,
        )
        const outcome = store ? await store.ingest(result) : null
        report.push({
          path: entry.path,
          eventId: result.eventId,
          status: outcome ? (outcome.inserted ? 'inserted' : 'duplicate') : 'validated',
        })
      } catch (error) {
        report.push({ path: entry.path, status: 'rejected', error: error.message })
      }
    }
  } finally {
    if (store) await store.close()
  }
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifest, database, reportPath, flag] = process.argv.slice(2)
  requireValue(
    manifest && database && reportPath && (!flag || flag === '--apply'),
    'Usage: node --experimental-strip-types scripts/import-legacy-stats.mjs MANIFEST DATABASE REPORT [--apply]',
  )
  requireValue(
    ![resolve(manifest), resolve(database)].includes(resolve(reportPath)),
    'Report must not overwrite the manifest or database',
  )
  const fd = openSync(reportPath, 'wx')
  let report
  try {
    report = await importManifest(manifest, database, flag === '--apply')
    writeFileSync(fd, JSON.stringify(report, null, 2) + '\n')
  } finally {
    closeSync(fd)
  }
  console.log(
    JSON.stringify({
      applied: flag === '--apply',
      entries: report.length,
      rejected: report.filter((r) => r.status === 'rejected').length,
    }),
  )
  if (report.some((r) => r.status === 'rejected')) process.exitCode = 1
}
