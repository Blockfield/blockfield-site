import { after } from 'node:test'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { StatsStore, statsStore } from '../src/lib/stats.ts'

const testUrl = () => {
  if (!process.env.BLOCKFIELD_TEST_DATABASE_URL)
    throw new Error(
      'BLOCKFIELD_TEST_DATABASE_URL is not set: this suite is PostgreSQL-only. ' +
        'Local setup is documented in docs/statistics.md (Tests); CI provides it as a service.',
    )
  return process.env.BLOCKFIELD_TEST_DATABASE_URL
}

/** Isolated schema URL for APIs that take a connection string (legacy import). */
export async function databaseUrl(t) {
  const url = new URL(testUrl())
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 })
  const schema = `test_${randomBytes(12).toString('hex')}`
  await pool.query(`CREATE SCHEMA ${schema}`)
  url.searchParams.set('options', `-c search_path=${schema}`)
  t.after(async () => {
    try {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`)
    } finally {
      await pool.end()
    }
  })
  return url.href
}

export async function database(t) {
  const url = new URL(testUrl())
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 })
  const schema = `test_${randomBytes(12).toString('hex')}`
  await pool.query(`CREATE SCHEMA ${schema}`)
  url.searchParams.set('options', `-c search_path=${schema}`)
  let store
  t.after(async () => {
    try {
      await store?.close()
      await pool.query(`DROP SCHEMA ${schema} CASCADE`)
    } finally {
      await pool.end()
    }
  })
  store = await StatsStore.open(url.href)
  return store
}

/**
 * Point the statsStore() singleton at an isolated schema, for test files that
 * exercise login/account routes (they reach the store through the singleton).
 * Call once at module top: `after(await singletonDatabase())`.
 */
export async function singletonDatabase() {
  const url = new URL(testUrl())
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 })
  const schema = `test_${randomBytes(12).toString('hex')}`
  await pool.query(`CREATE SCHEMA ${schema}`)
  url.searchParams.set('options', `-c search_path=${schema}`)
  process.env.BLOCKFIELD_DATABASE_URL = url.href
  return async () => {
    try {
      await (await statsStore()).close()
    } catch {
      // A test may have closed the singleton itself.
    }
    try {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`)
    } finally {
      await pool.end()
    }
  }
}

export { after }
