import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { StatsStore } from '../src/lib/stats.ts'

export const tables = [
  'results',
  'profiles',
  'participants',
  'classes',
  'ratings',
  'rating_changes',
  'staff_roles',
  'ingest_keys',
  'admin_audit',
]
const digest = (rows) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        rows
          .map((row) => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
          .map(JSON.stringify)
          .sort(),
      ),
    )
    .digest('hex')

/** Input must be a SQLite backup, never the live source. Existing target data is never overwritten. */
export async function migrate(source, target) {
  if (source.db.postgres || !target.db.postgres)
    throw new Error('Expected a SQLite backup and a PostgreSQL target')
  return target.db.transaction(async () => {
    const counts = {}
    for (const table of tables) {
      const { count } = await target.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()
      if (count !== 0) throw new Error(`Target table ${table} is not empty; migration refused`)
    }
    for (const table of tables) {
      const rows = await source.db.prepare(`SELECT * FROM ${table}`).all()
      if (rows.length) {
        const columns = Object.keys(rows[0])
        const insert = target.db.prepare(
          `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        )
        for (const row of rows) await insert.run(...columns.map((c) => row[c]))
      }
      const copied = await target.db.prepare(`SELECT * FROM ${table}`).all()
      if (digest(rows) !== digest(copied))
        throw new Error(`Verification failed for ${table}; rolling back`)
      counts[table] = rows.length
    }
    for (const table of ['ingest_keys', 'admin_audit']) {
      await target.db.exec(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM ${table}`,
      )
    }
    return counts
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2],
    url = process.env.BLOCKFIELD_DATABASE_URL
  if (!path || !/^postgres(?:ql)?:\/\//.test(url ?? ''))
    throw new Error(
      'Usage: BLOCKFIELD_DATABASE_URL=... node --experimental-strip-types scripts/migrate-stats.mjs /absolute/backup.sqlite',
    )
  const source = await StatsStore.open(path)
  try {
    const target = await StatsStore.open(url)
    try {
      console.log(JSON.stringify(await migrate(source, target), null, 2))
    } finally {
      await target.close()
    }
  } finally {
    await source.close()
  }
}
