import test from 'node:test'
import assert from 'node:assert/strict'
import { StatsError, validateResult, handleStatsRequest } from '../src/lib/stats.ts'

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

test('telemetry validation mirrors the producer caps', () => {
  for (const mutate of [
    (t) => (t.shots = -1),
    (t) => (t.fallbackShare = 1.5),
    (t) => (t.tickMsP99 = Infinity),
    (t) => (t.ageTicksP50 = 1.5),
    (t) => (t.tickMsP99Overflow = 'no'),
    (t) => (t.counters = { 'bad key!': 1 }),
    (t) => (t.counters = { ok: -1 }),
    (t) => (t.tickMsBuckets = [{ le: 'soon', count: 1 }]),
    (t) => (t.disputes = [{ ticket: { nested: 'object' } }]),
    (t) => delete t.shots,
  ]) {
    const input = telemetry()
    mutate(input)
    assert.throws(() => validateResult(fixture(2, { telemetry: input })), StatsError)
  }
  const big = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`k${i}`, 1]))
  assert.throws(
    () => validateResult(fixture(2, { telemetry: telemetry({ counters: big }) })),
    StatsError,
  )
  assert.throws(
    () =>
      validateResult(
        fixture(2, {
          telemetry: telemetry({ disputes: Array.from({ length: 17 }, () => ({ a: 'b' })) }),
        }),
      ),
    StatsError,
  )
  assert.throws(() => validateResult(fixture(2, { telemetry: [1] })), StatsError)
})

test('telemetry is stored in the result payload; legacy payloads stay untouched', async (t) => {
  const db = await database(t)
  await db.ingest(fixture(2, { telemetry: telemetry() }))
  await db.ingest(fixture(3))
  const rows = await db.db.prepare('SELECT payload FROM results ORDER BY event_id').all()
  assert.equal(JSON.parse(rows[0].payload).telemetry.shots, 10)
  assert.ok(!Object.hasOwn(JSON.parse(rows[1].payload), 'telemetry'))
})

test('hitreg aggregates shots, fallback share, counters and disputes per window', async (t) => {
  const db = await database(t)
  await db.ingest(fixture(2, { telemetry: telemetry() }))
  await db.ingest(
    fixture(3, {
      modeId: 'deathmatch',
      telemetry: telemetry({
        shots: 20,
        fallbackShare: 0.1,
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
  assert.equal(all.perMatch.length, 2)
  assert.equal(all.truncated, false)
  const room = await db.hitreg('room', 0, Date.now() + 300000)
  assert.equal(room.shots, 10)
  await assert.rejects(db.hitreg('training', 0, 1), StatsError)
  await db.setVoided(server, uid(2), player)
  assert.equal((await db.hitreg(null, 0, Date.now() + 300000)).shots, 20)
})

test('GET /api/stats/hitreg serves the aggregate publicly', async (t) => {
  const store = await database(t),
    deps = { store, keys: { [server]: [token] } }
  await store.ingest(fixture(2, { telemetry: telemetry() }))
  const response = await handleStatsRequest(
    new Request('https://example.test/api/stats/hitreg'),
    deps,
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.schemaVersion, 1)
  assert.equal(body.shots, 10)
  assert.equal(
    await (
      await handleStatsRequest(
        new Request('https://example.test/api/stats/hitreg?season=s99'),
        deps,
      )
    ).status,
    400,
  )
})
