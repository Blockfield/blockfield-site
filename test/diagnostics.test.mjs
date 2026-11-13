import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  parseTickQuery,
  readDiagnostics,
  redact,
  saveReport,
  validateReport,
} from '../src/lib/diagnostics.ts'
import { handleStatsRequest } from '../src/lib/stats.ts'
import { database as store } from './storage.mjs'

const SERVER = '11111111-1111-4111-8111-111111111111',
  OTHER = '22222222-2222-4222-8222-222222222222',
  KEY = 'k'.repeat(40),
  DAY = 86_400_000

const post = (s, body, { server = SERVER, key = KEY } = {}) =>
  handleStatsRequest(
    new Request('http://site/api/stats/diagnostics', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Blockfield-Server-Id': server,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    }),
    { store: s, keys: { [SERVER]: [KEY] } },
  )
const sample = (at, extra = {}) => ({ at, tps: 19.5, msptAvg: 21, msptMax: 340, ...extra })
const event = (at, extra = {}) => ({
  id: randomUUID(),
  at,
  kind: 'error',
  message: 'boom',
  ...extra,
})

test('diagnostics HTTP ingest is retired (404); saveReport resends are idempotent', async (t) => {
  const s = await store(t),
    now = Date.now()
  const body = {
    schemaVersion: 1,
    serverId: SERVER,
    startedAt: now - 3_600_000,
    samples: [sample(now - 60_000, { players: 12, heapUsedMb: 1800, heapMaxMb: 3072 })],
    events: [event(now - 30_000, { kind: 'freeze', durationMs: 3400, source: 'Server thread' })],
  }
  assert.equal((await post(s, body)).status, 404)
  assert.equal((await post(s, { ...body, serverId: OTHER }, { key: 'wrong' })).status, 404)
  const report = validateReport(body, now)
  await saveReport(s.db, report, now)
  await saveReport(s.db, report, now)
  const view = await readDiagnostics(s.db)
  assert.equal(view.samples.length, 1)
  assert.equal(view.events.length, 1)
  assert.equal(view.lastSampleAt, now - 60_000)
  assert.equal(view.events[0].durationMs, 3400)
  assert.equal(view.samples[0].startedAt, now - 3_600_000)
})

test('diagnostics validation refuses malformed reports and drops expired items', () => {
  const now = Date.now(),
    base = { schemaVersion: 1, serverId: SERVER }
  for (const bad of [
    { ...base, schemaVersion: 2 },
    { ...base, samples: [sample(now, { tps: Number.NaN })] },
    { ...base, samples: [sample(now, { heapUsedMb: 1800.5 })] },
    { ...base, samples: [sample(now + 0.5)] },
    { ...base, samples: [sample(now + 3_600_000)] },
    { ...base, events: [event(now, { kind: 'info' })] },
    { ...base, events: [event(now, { kind: 'freeze' })] },
    { ...base, events: [event(now, { message: '   ' })] },
    { ...base, samples: Array.from({ length: 121 }, (_, i) => sample(now - i)) },
  ])
    assert.throws(() => validateReport(bad, now), { status: 400 })
  const kept = validateReport(
    {
      ...base,
      samples: [sample(now - 8 * DAY), sample(now)],
      events: [event(now - 15 * DAY), event(now)],
    },
    now,
  )
  assert.deepEqual(
    [kept.samples.length, kept.events.length],
    [1, 1],
    'beyond retention is silently dropped',
  )
})

test('retention prunes old rows on every ingest', async (t) => {
  const s = await store(t),
    now = Date.now()
  await s.db
    .prepare('INSERT INTO server_samples (server_id,at,tps,mspt_avg,mspt_max) VALUES (?,?,?,?,?)')
    .run(SERVER, now - 8 * DAY, 20, 1, 1)
  await s.db
    .prepare(
      'INSERT INTO server_events (server_id,event_id,at,kind,message,repeats) VALUES (?,?,?,?,?,?)',
    )
    .run(SERVER, randomUUID(), now - 15 * DAY, 'error', 'old', 1)
  await saveReport(
    s.db,
    validateReport({ schemaVersion: 1, serverId: SERVER, samples: [sample(now)] }, now),
    now,
  )
  assert.equal((await s.db.prepare('SELECT count(*) n FROM server_samples').get()).n, 1)
  assert.equal((await s.db.prepare('SELECT count(*) n FROM server_events').get()).n, 0)
})

test('bounded journal retains errors and crashes before newer warnings, including tied times', async (t) => {
  const s = await store(t),
    now = Date.now()
  await s.db
    .prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<5001)
     INSERT INTO server_events (server_id,event_id,at,kind,message,repeats)
     SELECT ?,CAST(n AS TEXT),?,'warning','noise',1 FROM seq`,
    )
    .run(SERVER, now)
  const error = event(now - 1000),
    crash = event(now - 2000, { kind: 'crash' })
  await saveReport(
    s.db,
    validateReport({ schemaVersion: 1, serverId: SERVER, events: [error, crash] }, now),
    now,
  )
  assert.equal((await s.db.prepare('SELECT count(*) n FROM server_events').get()).n, 5000)
  for (const e of [error, crash])
    assert.equal(
      (await s.db.prepare('SELECT count(*) n FROM server_events WHERE event_id=?').get(e.id)).n,
      1,
    )
})

test('stored error text has no addresses, URLs, e-mails or credentials', () => {
  const text = redact(
    'Bob[/203.0.113.7:51234] lost; [0:0:0:0:0:0:0:1]:25565 and ::1 failed\n' +
      'POST https://discord.com/api/webhooks/123/abcDEF failed for admin@example.org\n' +
      'password=hunter2 Authorization: Bearer sk_live_0123456789abcdefABCDEF0123456789\u0007\n' +
      'room 0f8fad5b-d9cb-469f-a165-70867728950e at 12:34:56 in com.lunares.Room::tick',
  )
  for (const leak of [
    '203.0.113.7',
    '0:0:0:0',
    '::1',
    'discord.com',
    'example.org',
    'hunter2',
    'sk_live',
    '\u0007',
  ])
    assert.ok(!text.includes(leak), `${leak} leaked: ${text}`)
  assert.match(
    text,
    /0f8fad5b-d9cb-469f-a165-70867728950e at 12:34:56/,
    'room ids and times survive',
  )
  assert.equal(text.split('\n').length, 4, 'stack lines stay separate')
  const structured = redact(
    '{"password":"example-short-password","token":"abc","client_secret":"escaped\\"value","Authorization":"Bearer xyz"}' +
      " rcon_password=other-short-password access_token=short-token client_secret='quoted short secret' next=public",
  )
  for (const leak of [
    'example-short-password',
    'abc',
    'escaped',
    'xyz',
    'other-short-password',
    'short-token',
    'quoted short secret',
  ])
    assert.ok(!structured.includes(leak), `${leak} leaked: ${structured}`)
  assert.ok(structured.includes('next=public'))
  assert.equal(redact('a_'.repeat(2000)).length, 4000)
})

test('vanilla tick query output parses into authoritative tick timings', () => {
  // RCON joins the command's three messages without separators.
  const tick = parseTickQuery(
    "The game is running, but can't keep up with the target tick rate" +
      'Target tick rate: 20.0 per second.\nAverage time per tick: 80.0ms (Target: 50.0ms)' +
      'Percentiles: P50: 40.2ms P95: 250.5ms P99: 900.0ms, sample: 100',
  )
  assert.deepEqual(tick, {
    state: 'lagging',
    targetTps: 20,
    tps: 12.5,
    msptAvg: 80,
    msptP50: 40.2,
    msptP95: 250.5,
    msptP99: 900,
    sample: 100,
  })
  assert.equal(parseTickQuery('Unknown or incomplete command'), null)
  const ru = parseTickQuery(
    'The game is running normallyTarget tick rate: 20,0 per second.\nAverage time per tick: 12,5ms (Target: 50,0ms)' +
      'Percentiles: P50: 10,1ms P95: 30,0ms P99: 1200,4ms, sample: 100',
  )
  assert.deepEqual([ru.state, ru.msptAvg, ru.msptP99, ru.tps], ['running', 12.5, 1200.4, 20])
})
