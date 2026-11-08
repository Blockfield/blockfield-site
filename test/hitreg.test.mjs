import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HITREG_SCAN_CAP,
  TELEMETRY_MAX_BYTES,
  StatsError,
  telemetryDroppedCount,
  validateResult,
  handleStatsRequest,
} from '../src/lib/stats.ts'
import { handleAdmin } from '../src/lib/admin.ts'

const server = '00000000-0000-4000-8000-000000000001'
const player = '00000000-0000-4000-8000-000000000003'
const token = 'test-only-token-not-a-secret-000000000000'
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function telemetry(over = {}) {
  return {
    shots: 10,
    fallbackShare: 0.3,
    tickMsP50: 10,
    tickMsP99: 25,
    tickMsP99Overflow: false,
    ageTicksP50: 1,
    ageTicksP50Overflow: false,
    rewindTicksP50: 0,
    rewindTicksP50Overflow: false,
    counters: { shots: 10, 'viewCurrent:stale': 3 },
    tickMsBuckets: [
      { le: 5, count: 4 },
      { le: 'inf', count: 1 },
    ],
    ageTickBuckets: [{ le: 1, count: 10 }],
    rewindTickBuckets: [{ le: 0, count: 10 }],
    disputes: [
      { shooter: player, victim: uid(9), ticket: 'stale', label: 'head', subcause: 'none' },
    ],
    ...over,
  }
}
function fixture(n = 2, over = {}) {
  return {
    schemaVersion: 1,
    eventId: uid(n),
    serverId: server,
    kind: 'match',
    sessionPurpose: 'gameplay',
    modeId: 'room',
    ranked: false,
    rulesetVersion: '1',
    matchId: uid(n),
    campaignSessionId: null,
    mapId: 'test',
    startedAt: new Date(Date.now() - 120000).toISOString(),
    endedAt: new Date(Date.now() - 60000).toISOString(),
    endReason: 'completed',
    winner: 'RED',
    rounds: [],
    participants: [
      {
        uuid: player,
        name: 'Alpha',
        team: 'RED',
        score: 15,
        kills: 1,
        deaths: 0,
        captures: 1,
        neutralizations: 0,
        pointSeconds: 10,
        playSeconds: 60,
        suicides: 0,
        teamKills: 0,
        maxKillstreak: 1,
        classes: [
          {
            classId: 'assault',
            variantId: '0',
            timeSeconds: 60,
            kills: 1,
            deaths: 0,
            pointSeconds: 10,
          },
        ],
      },
    ],
    ...over,
  }
}
import { database } from './storage.mjs'

test('validateResult keeps sanitized telemetry and drops unknown fields', () => {
  const kept = validateResult(fixture(2, { telemetry: telemetry() }))
  assert.deepEqual(kept.telemetry, telemetry())
  const dirty = validateResult(
    fixture(2, { telemetry: { ...telemetry(), secret: 'do-not-store', extra: [1] } }),
  )
  assert.ok(!Object.hasOwn(dirty.telemetry, 'secret'))
  assert.ok(!Object.hasOwn(dirty.telemetry, 'extra'))
  assert.equal(validateResult(fixture(2)).telemetry, undefined)
})

test('invalid telemetry is dropped with a log line and a counter; the result is kept', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const bad = [
    (x) => (x.shots = -1),
    (x) => ((x.shots = 0), (x.fallbackShare = null)), // 0/0 serialized by the producer
    (x) => (x.fallbackShare = 1.5),
    (x) => (x.tickMsP99 = Infinity),
    (x) => (x.ageTicksP50 = -1),
    (x) => (x.tickMsP99Overflow = 'no'),
    (x) => (x.counters = { 'bad key!': 1 }),
    (x) => (x.counters = { ok: -1 }),
    (x) => (x.tickMsBuckets = [{ le: 'soon', count: 1 }]),
    (x) => (x.disputes = [{ ticket: { nested: 'object' } }]),
    (x) => (x.disputes = [{ ticket: 'a\u0000b' }]),
    (x) => (x.disputes = [{ ticket: 'a\ud800b' }]),
    (x) => (x.counters = Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`k${i}`, 1]))),
    (x) => (x.disputes = Array.from({ length: 9 }, () => ({ a: 'b' }))),
    (x) => delete x.shots,
  ]
  const before = telemetryDroppedCount()
  for (const mutate of bad) {
    const input = telemetry()
    mutate(input)
    const result = validateResult(fixture(2, { telemetry: input }))
    assert.ok(!Object.hasOwn(result, 'telemetry'))
    assert.equal(result.participants[0].kills, 1)
  }
  for (const value of [[1], null, 'x'])
    assert.ok(!Object.hasOwn(validateResult(fixture(2, { telemetry: value })), 'telemetry'))
  assert.equal(telemetryDroppedCount() - before, bad.length + 3)
  assert.equal(warn.mock.callCount(), bad.length + 3)
  assert.match(warn.mock.calls[0].arguments[0], /Telemetry dropped/)
  // Combat fields stay strict.
  assert.throws(() => validateResult(fixture(2, { winner: 'GREEN' })), StatsError)
  assert.ok(Object.hasOwn(validateResult(fixture(2, { telemetry: telemetry() })), 'telemetry'))
})

test('telemetry over the serialized cap is dropped even when structurally valid', (t) => {
  // Producer-shaped (≤512 counters, ≤8 disputes) but over TELEMETRY_MAX_BYTES serialized.
  const big = telemetry({
    counters: Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`counter.${i}`, 1])),
  })
  assert.ok(JSON.stringify(big).length > TELEMETRY_MAX_BYTES)
  const warn = t.mock.method(console, 'warn', () => {})
  const before = telemetryDroppedCount()
  assert.ok(!Object.hasOwn(validateResult(fixture(2, { telemetry: big })), 'telemetry'))
  assert.equal(telemetryDroppedCount() - before, 1)
  assert.match(warn.mock.calls[0].arguments[0], /Telemetry dropped/)
  // A producer-realistic block (~3 KB worst case) still passes.
  assert.ok(JSON.stringify(telemetry()).length < TELEMETRY_MAX_BYTES)
  assert.ok(Object.hasOwn(validateResult(fixture(2, { telemetry: telemetry() })), 'telemetry'))
})

test('POST /api/stats/results stores a match whose telemetry is invalid', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const store = await database(t),
    deps = { store, keys: { [server]: [token] } }
  const response = await handleStatsRequest(
    new Request('https://example.test/api/stats/results', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-blockfield-server-id': server,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(fixture(2, { telemetry: telemetry({ shots: 0, fallbackShare: null }) })),
    }),
    deps,
  )
  assert.equal(response.status, 201)
  const row = await store.db.prepare('SELECT payload FROM results').get()
  assert.ok(!Object.hasOwn(JSON.parse(row.payload), 'telemetry'))
})

test('telemetry is stored in the result payload; legacy payloads stay untouched', async (t) => {
  const db = await database(t)
  await db.ingest(fixture(2, { telemetry: telemetry() }))
  await db.ingest(fixture(3))
  const rows = await db.db.prepare('SELECT payload FROM results ORDER BY event_id').all()
  assert.equal(JSON.parse(rows[0].payload).telemetry.shots, 10)
  assert.ok(!Object.hasOwn(JSON.parse(rows[1].payload), 'telemetry'))
})

test('hitreg aggregates shots, fallback share, counters and per-match percentiles in SQL', async (t) => {
  const db = await database(t)
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)
  await db.ingest(fixture(2, { telemetry: telemetry() }))
  await db.ingest(
    fixture(3, {
      modeId: 'deathmatch',
      telemetry: telemetry({
        shots: 20,
        fallbackShare: 0.1,
        tickMsP50: 30,
        tickMsP99: 45,
        ageTicksP50: 3,
        rewindTicksP50: 2,
        counters: { shots: 20, 'viewRewound:none': 2 },
        disputes: [],
      }),
    }),
  )
  await db.ingest(fixture(4))
  const all = await db.hitreg(null, 0, Date.now() + 300000)
  assert.equal(all.matches, 3)
  assert.equal(all.withTelemetry, 2)
  assert.equal(all.shots, 30)
  assert.equal(all.fallbackShare, (0.3 * 10 + 0.1 * 20) / 30)
  assert.equal(all.disputes, 1)
  assert.deepEqual(all.counters, { shots: 30, 'viewCurrent:stale': 3, 'viewRewound:none': 2 })
  close(all.tickMsP50Median, 20)
  close(all.tickMsP50P99, 29.8)
  close(all.tickMsP99Median, 35)
  close(all.tickMsP99P99, 44.8)
  close(all.ageTicksP50Median, 2)
  close(all.rewindTicksP50Median, 1)
  assert.equal(all.truncated, false)
  const room = await db.hitreg('room', 0, Date.now() + 300000)
  assert.equal(room.shots, 10)
  await assert.rejects(db.hitreg('training', 0, 1), StatsError)
  const empty = await db.hitreg(null, 0, 1)
  assert.equal(empty.matches, 0)
  assert.equal(empty.withTelemetry, 0)
  assert.equal(empty.shots, 0)
  assert.equal(empty.fallbackShare, 0)
  assert.deepEqual(empty.counters, {})
  assert.equal(empty.tickMsP50Median, null)
  assert.equal(empty.truncated, false)
  await db.setVoided(server, uid(2), player)
  assert.equal((await db.hitreg(null, 0, Date.now() + 300000)).shots, 20)
})

test('hitreg is staff-only, defaults to the last 7 days and caps the scan', async (t) => {
  const store = await database(t),
    admin = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    builder = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  process.env.NODE_ENV = 'test'
  await store.setStaff(admin, 'Adm', 'admin', 'seed')
  await store.setStaff(builder, 'Bld', 'builder', 'seed')
  const day = 86400000,
    old = new Date(Date.now() - 20 * day)
  await store.ingest(fixture(2, { telemetry: telemetry() }))
  await store.ingest(
    fixture(3, {
      startedAt: new Date(old - 60000).toISOString(),
      endedAt: old.toISOString(),
      telemetry: telemetry({ shots: 99 }),
    }),
  )
  const call = async (as, query = '') => {
    if (as) process.env.BLOCKFIELD_ADMIN_DEV_USER = as
    else delete process.env.BLOCKFIELD_ADMIN_DEV_USER
    const url = new URL(`http://site/api/admin/hitreg${query}`)
    return handleAdmin(
      { request: new Request(url), url, cookies: { get: () => undefined } },
      'hitreg',
      store,
    ).then(
      (r) => r,
      (e) => e,
    )
  }
  assert.equal((await call(null)).status, 401)
  assert.equal((await call(`${builder}:Bld`)).status, 403)
  const week = await call(`${admin}:Adm`)
  assert.equal(week.status, 200)
  assert.equal((await week.json()).shots, 10)
  assert.equal((await (await call(`${admin}:Adm`, '?period=month')).json()).shots, 109)
  assert.equal((await call(`${admin}:Adm`, '?season=s99')).status, 400)

  // Cap: only the newest HITREG_SCAN_CAP rows are read.
  const insert = store.db.prepare(
    'INSERT INTO results (server_id,event_id,kind,mode,campaign_id,ended_at,reason,winner,digest,payload) SELECT server_id,?,kind,mode,campaign_id,ended_at,reason,winner,?,payload FROM results WHERE event_id=?',
  )
  for (let i = 0; i < HITREG_SCAN_CAP; i++) await insert.run(`bulk-${i}`, `digest-${i}`, uid(2))
  const capped = await store.hitreg(null, 0, Date.now() + 300000)
  assert.equal(capped.matches, HITREG_SCAN_CAP)
  assert.equal(capped.truncated, true)
})
