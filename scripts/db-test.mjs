#!/usr/bin/env node
// One-command local DB test run: provisions a throwaway PostgreSQL (podman
// container, removed afterwards) unless BLOCKFIELD_TEST_DATABASE_URL is already
// set, then runs the whole suite. node --test reports every failure.
import { spawnSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

// Every container this run creates carries this label; cleanup removes by
// label only, so it never touches another container and also catches one
// created by a `podman run` that was interrupted before it returned.
const runId = randomUUID()
const label = `bf.test.run=${runId}`
const podman = (args) => spawnSync('podman', args, { stdio: 'pipe', encoding: 'utf8' })
let provisioned = false
let cleaned = false
let tests

function cleanup() {
  if (cleaned || !provisioned) return
  cleaned = true
  const ids = podman(['ps', '-aq', '--filter', `label=${label}`])
    .stdout.split('\n')
    .filter(Boolean)
  if (ids.length) podman(['rm', '-f', ...ids])
}

process.on('exit', cleanup)
// The test runner gets its own process group (detached) in both branches, so
// the terminal's Ctrl+C does not reach it directly: forward every termination
// signal to the whole group, then exit (which runs cleanup).
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
])
  process.on(signal, () => {
    if (tests?.pid) {
      try {
        process.kill(-tests.pid, signal)
      } catch {
        // the group already exited
      }
    }
    process.exit(code)
  })

const existing = process.env.BLOCKFIELD_TEST_DATABASE_URL
if (existing) {
  await runTests(existing)
} else {
  if (podman(['--version']).error)
    throw new Error('podman is required for pnpm test:local (or set BLOCKFIELD_TEST_DATABASE_URL)')
  const name = `bf-test-pg-${runId}`
  provisioned = true
  const start = podman([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    label,
    '-e',
    'POSTGRES_USER=blockfield',
    '-e',
    'POSTGRES_PASSWORD=test-only',
    '-e',
    'POSTGRES_DB=blockfield_test',
    // Loopback only, random free host port: never expose the test DB to the
    // LAN or collide with a PostgreSQL already running on 5432.
    '-p',
    '127.0.0.1::5432',
    'docker.io/library/postgres:18',
  ])
  if (start.status !== 0) throw new Error(`podman run failed: ${start.stderr}`)
  const port = podman(['port', name, '5432/tcp']).stdout.trim().split(':').pop()
  if (!/^\d+$/.test(port)) throw new Error(`podman port gave no host port for ${name}`)
  await runTests(`postgres://blockfield:test-only@127.0.0.1:${port}/blockfield_test`)
}

async function runTests(dbUrl) {
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
        throw new Error('PostgreSQL did not become ready within 60 s')
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  await pool.end()
  tests = spawn('node --experimental-strip-types --test test/*.test.mjs', {
    stdio: 'inherit',
    shell: true,
    detached: true,
    env: process.env,
  })
  tests.on('exit', (code) => process.exit(code ?? 1))
}
