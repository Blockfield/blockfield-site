import { Pool } from 'pg'
import { StatsStore, seasonAt } from '../src/lib/stats.ts'
import { reconcileSeasonCounts, formatSeasonDrift } from '../src/lib/cp-stats.ts'

// Dual-write reconcile (coordination#29 U2): compares site vs CP result
// counts for one season window and logs drift. Read-only on both sides.
// CP rows come from the CP read API once U3 lands; until then this script
// reads the CP database directly (stand/operator use, never prod site traffic).
// Usage: node --experimental-strip-types scripts/cp-stats-reconcile.mjs \
//   "$BLOCKFIELD_DATABASE_URL" "$BLOCKFIELD_CP_DATABASE_URL" [--since <ISO>]
function usage() {
  throw new Error(
    'Usage: node --experimental-strip-types scripts/cp-stats-reconcile.mjs <site-dsn> <cp-dsn> [--since <ISO>]',
  )
}

const args = process.argv.slice(2)
if (args.length < 2 || args.length > 4) usage()
const [siteDsn, cpDsn, sinceFlag, sinceValue] = args
if (!/^postgres(?:ql)?:\/\//.test(siteDsn) || !/^postgres(?:ql)?:\/\//.test(cpDsn)) usage()
if (sinceFlag !== undefined && (sinceFlag !== '--since' || !sinceValue)) usage()
const season = sinceValue ? { id: 'window', startsAt: sinceValue } : seasonAt(Date.now())
const since = Date.parse(season.startsAt)
if (!Number.isFinite(since)) usage()

const store = await StatsStore.open(siteDsn)
const cp = new Pool({ connectionString: cpDsn, max: 2 })
try {
  const site = await store.resultRefs(since)
  const { rows } = await cp.query(
    'SELECT server_id "serverId",event_id "eventId",digest FROM control.stat_results WHERE ended_at >= $1 ORDER BY server_id,event_id',
    [new Date(since)],
  )
  const drift = reconcileSeasonCounts(season, site, rows)
  console.log(formatSeasonDrift(drift))
  if (drift.drift) process.exitCode = 1
} finally {
  await cp.end()
  await store.close()
}
