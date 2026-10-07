import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { parseTickQuery, readDiagnostics, redact, validateReport } from '../src/lib/diagnostics.ts'
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

test('diagnostics ingestion: producer key and own server identity required, resends are idempotent', async (t) => {
  const s = await store(t),
    now = Date.now()
  const body = {
    schemaVersion: 1,
    serverId: SERVER,
    startedAt: now - 3_600_000,
    samples: [sample(now - 60_000, { players: 12, heapUsedMb: 1800, heapMaxMb: 3072 })],
    events: [event(now - 30_000, { kind: 'freeze', durationMs: 3400, source: 'Server thread' })],
  }
  assert.equal((await post(s, body, { key: 'x'.repeat(40) })).status, 401)
  assert.equal((await post(s, { ...body, serverId: OTHER })).status, 403)
  assert.equal((await post(s, body)).status, 200)
  assert.equal((await post(s, body)).status, 200, 'a retried batch is accepted')
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
  await post(s, { schemaVersion: 1, serverId: SERVER, samples: [sample(now)] })
  assert.equal((await s.db.prepare('SELECT count(*) n FROM server_samples').get()).n, 1)
  assert.equal((await s.db.prepare('SELECT count(*) n FROM server_events').get()).n, 0)
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
})
