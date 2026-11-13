import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, types } from 'pg'

// Coordination#29 U6 archive helper: exports the 9 retired stats, diagnostics, and
// ingest-key tables from site PostgreSQL into verified NDJSON + manifest files before
// season-boundary cutover / schema drop. Never exports site_sessions, staff_roles, or admin_audit.

export const ARCHIVE_FORMAT = 'blockfield-site-stats-archive-v1'

export const LEGACY_STATS_TABLES = [
  { name: 'profiles', orderBy: 'uuid' },
  { name: 'results', orderBy: 'server_id, event_id' },
  { name: 'participants', orderBy: 'server_id, event_id, uuid' },
  { name: 'classes', orderBy: 'server_id, event_id, uuid, class_id, variant_id' },
  { name: 'ratings', orderBy: 'season_id, uuid' },
  { name: 'rating_changes', orderBy: 'server_id, event_id, uuid' },
  { name: 'server_samples', orderBy: 'server_id, at' },
  { name: 'server_events', orderBy: 'server_id, event_id' },
  { name: 'ingest_keys', orderBy: 'id' },
]

export const EXCLUDED_SITE_TABLES = ['site_sessions', 'staff_roles', 'admin_audit']

const parseNumeric = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Archive integer/numeric exceeds Number.MAX_SAFE_INTEGER: ${value}`)
  }
  return n
}

const pgTypes = {
  getTypeParser: (oid, format) =>
    [20, 1700].includes(oid) ? parseNumeric : types.getTypeParser(oid, format),
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

export async function archiveSiteStats(siteDsn, outDir, opts = {}) {
  if (!/^postgres(?:ql)?:\/\//.test(siteDsn)) {
    throw new Error('Site DSN must be a postgres:// or postgresql:// URL')
  }
  if (!outDir) throw new Error('Output directory is required')
  const manifestPath = join(outDir, 'manifest.json')
  if (!opts.overwrite) {
    const exists = await stat(manifestPath).then(
      () => true,
      () => false,
    )
    if (exists) throw new Error(`Archive manifest already exists at ${manifestPath}`)
  }

  await mkdir(outDir, { recursive: true })
  const pool = new Pool({
    connectionString: siteDsn,
    max: 2,
    connectionTimeoutMillis: 10_000,
    types: pgTypes,
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    let schemaVersion = null
    try {
      const schemaRes = await client.query('SELECT version FROM blockfield_schema WHERE id = 1')
      schemaVersion = schemaRes.rows[0]?.version ?? null
    } catch {
      schemaVersion = null
    }

    const tables = []
    for (const table of LEGACY_STATS_TABLES) {
      const reg = await client.query('SELECT to_regclass($1) AS oid', [table.name])
      const present = Boolean(reg.rows[0]?.oid)
      const file = `${table.name}.ndjson`
      let body = ''
      let rowCount = 0
      if (present) {
        const res = await client.query(`SELECT * FROM ${table.name} ORDER BY ${table.orderBy}`)
        rowCount = res.rows.length
        if (rowCount > 0) {
          body = res.rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
        }
      }
      const bytes = Buffer.from(body, 'utf8')
      await writeFile(join(outDir, file), bytes)
      tables.push({
        name: table.name,
        present,
        file,
        rows: rowCount,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
      })
    }

    await client.query('COMMIT')
    const manifest = {
      format: ARCHIVE_FORMAT,
      createdAt: new Date().toISOString(),
      isolation: 'REPEATABLE READ READ ONLY',
      schemaVersion,
      excludedTables: EXCLUDED_SITE_TABLES,
      tables,
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    return manifest
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function verifyArchive(outDir) {
  const manifestRaw = await readFile(join(outDir, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestRaw)
  if (manifest?.format !== ARCHIVE_FORMAT || !Array.isArray(manifest.tables)) {
    throw new Error(`Invalid archive manifest in ${outDir}`)
  }
  for (const entry of manifest.tables) {
    const bytes = await readFile(join(outDir, entry.file))
    if (bytes.length !== entry.bytes) {
      throw new Error(
        `Byte size mismatch for ${entry.file}: expected ${entry.bytes}, got ${bytes.length}`,
      )
    }
    const digest = sha256Hex(bytes)
    if (digest !== entry.sha256) {
      throw new Error(
        `Checksum mismatch for ${entry.file}: expected ${entry.sha256}, got ${digest}`,
      )
    }
    const text = bytes.toString('utf8')
    const lines = text === '' ? 0 : text.trimEnd().split('\n').length
    if (lines !== entry.rows) {
      throw new Error(`Row count mismatch for ${entry.file}: expected ${entry.rows}, got ${lines}`)
    }
  }
  return manifest
}

function usage() {
  throw new Error(
    'Usage: node --experimental-strip-types scripts/archive-site-stats.mjs <site-dsn> <out-dir> [--verify] | --verify-only <out-dir>',
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args[0] === '--verify-only' && args.length === 2) {
    const manifest = await verifyArchive(args[1])
    console.log(
      `Verified archive ${args[1]} (${manifest.tables.reduce((n, t) => n + t.rows, 0)} rows across ${manifest.tables.length} tables)`,
    )
  } else if (args.length === 2 || (args.length === 3 && args[2] === '--verify')) {
    const manifest = await archiveSiteStats(args[0], args[1])
    if (args[2] === '--verify') await verifyArchive(args[1])
    const totalRows = manifest.tables.reduce((n, t) => n + t.rows, 0)
    console.log(
      `Archived ${totalRows} rows to ${args[1]} (manifest verified=${args[2] === '--verify'})`,
    )
  } else {
    usage()
  }
}
