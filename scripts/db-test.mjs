#!/usr/bin/env node
// One-command local DB test run: provisions a throwaway PostgreSQL in the
// project cache (podman container, removed afterwards) unless
// BLOCKFIELD_TEST_DATABASE_URL is already set, then runs the whole suite.
// node --test reports every failure; nothing here stops at the first one.
import { spawnSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'

let tests
const url = process.env.BLOCKFIELD_TEST_DATABASE_URL
if (url) {
  runTests(url, null)
} else {
  const name = `bf-test-pg-${process.pid}-${randomBytes(4).toString('hex')}`
  const run = (args) => spawnSync('podman', args, { stdio: 'pipe', encoding: 'utf8' })
  if (run(['--version']).error)
    throw new Error('podman is required for pnpm test:local (or set BLOCKFIELD_TEST_DATABASE_URL)')
  const start = run([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-e',
    'POSTGRES_USER=blockfield',
    '-e',
    'POSTGRES_PASSWORD=test-only',
    '-e',
    'POSTGRES_DB=blockfield_test',
    // Loopback only, random free host port: never expose the test DB to the
    // LAN or collide with a PostgreSQL the owner already runs on 5432.
    '-p',
    '127.0.0.1::5432',
    'docker.io/library/postgres:18',
  ])
  if (start.status !== 0) throw new Error(`podman run failed: ${start.stderr}`)
  const stop = () => run(['rm', '-f', name])
  process.on('exit', stop)
  // 'exit' does not fire on an unhandled signal: remove the container (and
  // the test run) explicitly so an interrupted run never leaks it.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ])
    process.on(signal, () => {
      tests?.kill(signal)
      process.exit(code)
    })
  const port = run(['port', name, '5432/tcp']).stdout.trim().split(':').pop()
  if (!/^\d+$/.test(port)) throw new Error(`podman port gave no host port for ${name}`)
  runTests(`postgres://blockfield:test-only@127.0.0.1:${port}/blockfield_test`, stop)
}

async function runTests(dbUrl, stop) {
  process.env.BLOCKFIELD_TEST_DATABASE_URL = dbUrl
  const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 2000 })
  const deadline = Date.now() + 60000
  for (;;) {
    try {
      await pool.query('SELECT 1')
      break
    } catch {
      if (Date.now() > deadline) {
        await pool.end()
        stop?.()
        throw new Error('PostgreSQL did not become ready within 60 s')
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  await pool.end()
  const child = (tests = spawn('node --experimental-strip-types --test test/*.test.mjs', {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  }))
  child.on('exit', (code) => {
    stop?.()
    process.exit(code ?? 1)
  })
}
