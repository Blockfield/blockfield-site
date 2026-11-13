import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpDiagConfigured, readDiagnosticsCp } from '../src/lib/cp.ts'
import { handleAdmin } from '../src/lib/admin.ts'
import { database as store } from './storage.mjs'

const ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SERVER = '11111111-1111-4111-8111-111111111111'
const now = Date.now()

function cpView() {
  return {
    schemaVersion: 1,
    now,
    hours: 24,
    lastSampleAt: now - 60_000,
    samples: [
      {
        serverId: SERVER,
        at: now - 60_000,
        tps: 19.5,
        msptAvg: 21,
        msptP95: null,
        msptMax: 340,
        players: 12,
        heapUsedMb: 1800,
        heapMaxMb: 3072,
        gcPauseMs: 5,
        startedAt: now - 3_600_000,
      },
    ],
    events: [
      {
        serverId: SERVER,
        id: '22222222-2222-4222-8222-222222222222',
        at: now - 30_000,
        kind: 'freeze',
        durationMs: 3400,
        source: 'Server thread',
        message: 'stuck',
        repeats: 2,
      },
    ],
  }
}

async function fakeCp(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return server
}

function cpEnv(t, server) {
  const inbox = mkdtempSync(join(tmpdir(), 'bf-cpdiag-'))
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_STATS_TOKEN: 'diag-t',
    BLOCKFIELD_ADMIN_DEV_USER: `${ADMIN}:Adm`,
    BLOCKFIELD_INBOX_DIR: inbox,
    BLOCKFIELD_SESSION_SECRET: 'a'.repeat(64),
    NODE_ENV: 'test',
  })
  t.after(() => rmSync(inbox, { recursive: true, force: true }))
}

test('diagnostics switch: needs both the CP url and the stats token', () => {
  delete process.env.BLOCKFIELD_CP_STATS_TOKEN
  delete process.env.BLOCKFIELD_CP_URL
  assert.equal(cpDiagConfigured(), false)
  assert.equal(cpDiagConfigured({ BLOCKFIELD_CP_URL: 'http://127.0.0.1:9' }), false)
  assert.equal(
    cpDiagConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_STATS_TOKEN: 't',
    }),
    true,
  )
  assert.equal(
    cpDiagConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_STATS_TOKEN: '   ',
    }),
    false,
  )
})

test('readDiagnosticsCp passes the CP view through with the stats token', async (t) => {
  const view = cpView()
  let auth = null
  const server = await fakeCp(t, (req, res) => {
    auth = req.headers.authorization ?? null
    res.statusCode = 200
    res.end(JSON.stringify(view))
  })
  cpEnv(t, server)
  const data = await readDiagnosticsCp()
  assert.equal(auth, 'Bearer diag-t')
  assert.deepEqual(data, {
    hours: 24,
    lastSampleAt: view.lastSampleAt,
    samples: view.samples,
    events: view.events,
  })
})

test('readDiagnosticsCp maps denial and refuses a malformed view', async (t) => {
  const denied = await fakeCp(t, (req, res) => {
    res.statusCode = 403
    res.end(JSON.stringify({ error: 'forbidden' }))
  })
  cpEnv(t, denied)
  const error = await readDiagnosticsCp().then(
    () => null,
    (e) => e,
  )
  assert.equal(error?.status, 503)
  assert.equal(error?.code, 'forbidden')
  const garbage = await fakeCp(t, (req, res) => {
    res.statusCode = 200
    res.end(JSON.stringify({ samples: [{ nope: 1 }], events: [] }))
  })
  cpEnv(t, garbage)
  await assert.rejects(readDiagnosticsCp(), /неверное состояние/)
})

test('readDiagnosticsCp rejects an event missing repeats/durationMs/source', async (t) => {
  const view = cpView()
  delete view.events[0].repeats
  delete view.events[0].durationMs
  delete view.events[0].source
  const server = await fakeCp(t, (req, res) => {
    res.statusCode = 200
    res.end(JSON.stringify(view))
  })
  cpEnv(t, server)
  await assert.rejects(readDiagnosticsCp(), /неверное состояние/)
})

test('readDiagnosticsCp rejects a sample with non-numeric players/heap/gcPause', async (t) => {
  for (const patch of [
    { players: '12' },
    { heapUsedMb: '1800' },
    { heapMaxMb: '3072' },
    { gcPauseMs: '5' },
  ]) {
    const view = cpView()
    Object.assign(view.samples[0], patch)
    const server = await fakeCp(t, (req, res) => {
      res.statusCode = 200
      res.end(JSON.stringify(view))
    })
    cpEnv(t, server)
    await assert.rejects(readDiagnosticsCp(), /неверное состояние/, JSON.stringify(patch))
  }
})

test('GET diagnostics refuses malformed CP payload (502) and never falls back to local DB', async (t) => {
  const view = cpView()
  delete view.events[0].repeats
  const server = await fakeCp(t, (req, res) => {
    res.statusCode = 200
    res.end(JSON.stringify(view))
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const at = Date.now() - 60_000
  await s.db
    .prepare('INSERT INTO server_samples (server_id,at,tps,mspt_avg,mspt_max) VALUES (?,?,?,?,?)')
    .run(SERVER, at, 19.5, 21, 340)
  const request = new Request('http://site/api/admin/diagnostics', { method: 'GET' })
  const res = await handleAdmin(
    { request, url: new URL(request.url), cookies: { get: () => undefined } },
    'diagnostics',
    s,
  ).then(
    (r) => r,
    (e) => e,
  )
  assert.equal(res.status, 502)
})

test('GET diagnostics returns empty CP state as-is and never falls back to local DB', async (t) => {
  const empty = {
    schemaVersion: 1,
    now: Date.now(),
    hours: 24,
    lastSampleAt: null,
    samples: [],
    events: [],
  }
  const server = await fakeCp(t, (req, res) => {
    res.statusCode = 200
    res.end(JSON.stringify(empty))
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const at = Date.now() - 60_000
  await s.db
    .prepare('INSERT INTO server_samples (server_id,at,tps,mspt_avg,mspt_max) VALUES (?,?,?,?,?)')
    .run(SERVER, at, 19.5, 21, 340)
  const request = new Request('http://site/api/admin/diagnostics', { method: 'GET' })
  const res = await handleAdmin(
    { request, url: new URL(request.url), cookies: { get: () => undefined } },
    'diagnostics',
    s,
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.lastSampleAt, null)
  assert.deepEqual(body.samples, [])
})

test('GET diagnostics returns stale CP sample as-is and never falls back to local fresh sample', async (t) => {
  const at = Date.now() - 10 * 60_000
  const stale = { ...cpView(), lastSampleAt: at, samples: [{ ...cpView().samples[0], at }] }
  const server = await fakeCp(t, (req, res) => {
    res.statusCode = 200
    res.end(JSON.stringify(stale))
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const fresh = Date.now() - 60_000
  await s.db
    .prepare('INSERT INTO server_samples (server_id,at,tps,mspt_avg,mspt_max) VALUES (?,?,?,?,?)')
    .run(SERVER, fresh, 19.5, 21, 340)
  const request = new Request('http://site/api/admin/diagnostics', { method: 'GET' })
  const res = await handleAdmin(
    { request, url: new URL(request.url), cookies: { get: () => undefined } },
    'diagnostics',
    s,
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.lastSampleAt, at)
  assert.equal(body.samples.length, 1)
})

test('GET diagnostics reads from CP when configured, even with the local tables gone', async (t) => {
  const view = cpView()
  const server = await fakeCp(t, (req, res) => {
    if (req.url === '/v2/stats/diagnostics') {
      res.statusCode = 200
      res.end(JSON.stringify(view))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not_found' }))
  })
  cpEnv(t, server)
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  // The site DB is unreachable for this path: the diagnostics tables are gone.
  await s.db.prepare('DROP TABLE server_samples').run()
  await s.db.prepare('DROP TABLE server_events').run()
  const request = new Request('http://site/api/admin/diagnostics', { method: 'GET' })
  const res = await handleAdmin(
    { request, url: new URL(request.url), cookies: { get: () => undefined } },
    'diagnostics',
    s,
  )
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {
    hours: 24,
    lastSampleAt: view.lastSampleAt,
    samples: view.samples,
    events: view.events,
  })
})
