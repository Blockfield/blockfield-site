import test from 'node:test'
import assert from 'node:assert/strict'
import { validateResult, filters, handleStatsRequest } from '../src/lib/stats.ts'

const server = '00000000-0000-4000-8000-000000000001'
const match = '00000000-0000-4000-8000-000000000002'
const alpha = '00000000-0000-4000-8000-000000000003'
const beta = '00000000-0000-4000-8000-000000000004'
const foreign = '00000000-0000-4000-8000-000000000005'
const token = 'test-only-stats-review-token-000000000000'
function fixture() {
  const player = (uuid) => ({
    uuid,
    name: uuid === alpha ? 'Alpha' : 'Beta',
    team: 'NONE',
    score: 1,
    kills: 1,
    deaths: 1,
    captures: 0,
    neutralizations: 0,
    pointSeconds: 0,
    playSeconds: 60,
    suicides: 0,
    teamKills: 0,
    maxKillstreak: 1,
    classes: [],
  })
  return {
    schemaVersion: 1,
    eventId: match,
    serverId: server,
    kind: 'match',
    sessionPurpose: 'gameplay',
    modeId: 'deathmatch',
    ranked: false,
    rulesetVersion: 'ffa-v1',
    matchId: match,
    campaignSessionId: null,
    mapId: 'arena',
    startedAt: '2025-01-01T00:00:00Z',
    endedAt: '2025-01-01T00:01:00Z',
    endReason: 'completed',
    winner: 'NONE',
    rounds: [],
    participants: [player(alpha), player(beta)],
  }
}
const query = (text = '') => filters(new URLSearchParams(text))
import { database } from './storage.mjs'
function post(body, producer = server) {
  return new Request('https://example.test/api/stats/results', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Blockfield-Server-Id': producer,
    },
    body: JSON.stringify(body),
  })
}

test('FFA winner UUID is persisted and counted once through the public API', async (t) => {
  const store = await database(t),
    deps = { store, keys: { [server]: [token] } }
  const result = { ...fixture(), winnerUuid: alpha }
  assert.equal((await handleStatsRequest(post(result), deps)).status, 201)
  assert.equal((await handleStatsRequest(post(result), deps)).status, 200)
  const response = await handleStatsRequest(
    new Request('https://example.test/api/stats/leaderboard?mode=deathmatch&sort=wins'),
    deps,
  )
  const board = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(
    board.players.map((p) => [p.uuid, p.matches, p.wins, p.mmr]),
    [
      [alpha, 1, 1, null],
      [beta, 1, 0, null],
    ],
  )
  const detail = await store.player(alpha, query())
  assert.equal(detail.history[0].winnerUuid, alpha)
  assert.equal(detail.campaigns.completed, 0)
  assert.equal(detail.ratingStatus, 'glicko2-v1')
  assert.equal(detail.mmr, null) // FFA never rates
})

test('personal winner must belong to a completed FFA roster, not a team or campaign', () => {
  for (const mutate of [
    (r) => (r.winnerUuid = foreign),
    (r) => (r.winnerUuid = null),
    (r) => (r.winnerUuid = [alpha]),
    (r) => (r.winner = 'RED'),
    (r) => (r.participants[0].team = 'RED'),
    (r) => (r.campaignSessionId = foreign),
    (r) => (r.modeId = 'room'),
    (r) => (r.endReason = 'draw'),
    (r) => (r.endReason = 'stopped'),
    (r) => (r.endReason = 'shutdown'),
    (r) => (r.endReason = 'error'),
  ]) {
    const result = { ...fixture(), winnerUuid: alpha }
    mutate(result)
    assert.throws(
      () => validateResult(result),
      (error) => error.status === 422,
    )
  }
})

test('missing personal winner preserves legacy canonical bytes and never guesses an FFA victory', async (t) => {
  const store = await database(t),
    result = fixture()
  await store.ingest(result)
  const row = await store.db.prepare('SELECT digest,payload FROM results').get()
  assert.equal(row.digest, '206a70ca88e066b886b3d1c52360659758caaa0eb033718d7d5c98e43f5dda4c')
  assert.ok(!Object.hasOwn(JSON.parse(row.payload), 'winnerUuid'))
  assert.equal((await store.ingest(result)).inserted, false)
  assert.deepEqual(
    (await store.leaderboard(query())).players.map((p) => p.wins),
    [0, 0],
  )
})

test('result identity fields reject regex string coercion of arrays', () => {
  const a = fixture()
  a.eventId = a.matchId = [match]
  const b = fixture()
  b.serverId = [server]
  for (const result of [a, b])
    assert.throws(
      () => validateResult(result),
      (error) => error.status === 422,
    )
})

test('invalid and inherited producer keys fail with 401 before parsing the body', async (t) => {
  const store = await database(t),
    deps = { store, keys: { [server]: [token] } }
  for (const producer of ['__proto__', 'constructor', 'toString', 'not-a-uuid', foreign]) {
    const request = post(fixture(), producer)
    let bodyRead = false
    Object.defineProperty(request, 'body', {
      get() {
        bodyRead = true
        throw new Error('must not read unauthorized body')
      },
    })
    assert.equal((await handleStatsRequest(request, deps)).status, 401, producer)
    assert.equal(bodyRead, false)
  }
  const inherited = { store, keys: Object.create({ [server]: [token] }) }
  assert.equal((await handleStatsRequest(post(fixture()), inherited)).status, 401)
})

test('conflicting personal winner replay cannot rewrite an accepted victory', async (t) => {
  const store = await database(t),
    result = { ...fixture(), winnerUuid: alpha }
  await store.ingest(result)
  await assert.rejects(
    async () => await store.ingest({ ...result, winnerUuid: beta }),
    (error) => error.status === 409,
  )
  assert.equal((await store.player(alpha, query())).totals.wins, 1)
  assert.equal((await store.player(beta, query())).totals.wins, 0)
})

test('allowlisting keeps the new result field but excludes unrelated producer data', async (t) => {
  const store = await database(t),
    result = { ...fixture(), winnerUuid: alpha, secret: 'never-persist-this' }
  await store.ingest(result)
  const raw = (await store.db.prepare('SELECT payload FROM results').get()).payload
  assert.equal(JSON.parse(raw).winnerUuid, alpha)
  assert.ok(!raw.includes('never-persist-this'))
})

test('history presentation distinguishes personal winners, draws and unknown legacy outcomes', async () => {
  const { outcomeLabel } = await import('../src/lib/stats-outcome.ts')
  const result = {
    mode: 'deathmatch',
    reason: 'completed',
    winner: 'NONE',
    team: 'NONE',
    winnerUuid: alpha,
  }
  assert.equal(outcomeLabel(result, alpha), ' · победа')
  assert.equal(outcomeLabel(result, beta), ' · поражение')
  for (const reason of ['draw', 'stopped', 'shutdown', 'error', 'abandoned']) {
    assert.equal(outcomeLabel({ ...result, reason }, alpha), '')
  }
  assert.equal(outcomeLabel({ ...result, winnerUuid: null }, alpha), '')
  assert.equal(outcomeLabel({ ...result, winnerUuid: null, winner: 'RED', team: 'RED' }, alpha), '')
  assert.equal(
    outcomeLabel({ ...result, mode: 'room', winner: 'RED', team: 'RED' }, alpha),
    ' · победа',
  )
  assert.equal(
    outcomeLabel({ ...result, mode: 'campaign', winner: 'BLUE', team: 'RED' }, alpha),
    ' · поражение',
  )
})

test('site#116 item 6: winner_uuid column is filled at ingest and drives the leaderboard', async (t) => {
  const { database } = await import('./storage.mjs')
  const store = await database(t)
  const { handleStatsRequest } = await import('../src/lib/stats.ts')
  const deps = { store, keys: { [server]: [token] } }
  const result = { ...fixture(), winnerUuid: alpha }
  assert.equal((await handleStatsRequest(post(result), deps)).status, 201)
  const row = await store.db.prepare('SELECT winner_uuid "winnerUuid",payload FROM results').get()
  assert.equal(row.winnerUuid, alpha, 'ingest fills the column')
  const board1 = await (
    await handleStatsRequest(
      new Request('https://example.test/api/stats/leaderboard?mode=deathmatch&sort=wins'),
      deps,
    )
  ).json()
  assert.deepEqual(
    board1.players.map((p) => [p.uuid, p.wins]),
    [
      [alpha, 1],
      [beta, 0],
    ],
  )
  await store.db.prepare('UPDATE results SET winner_uuid=NULL').run()
  const board2 = await (
    await handleStatsRequest(
      new Request('https://example.test/api/stats/leaderboard?mode=deathmatch&sort=wins'),
      deps,
    )
  ).json()
  assert.deepEqual(
    board2.players.map((p) => [p.uuid, p.wins]),
    [
      [alpha, 1],
      [beta, 0],
    ],
    'leaderboard falls back to the payload when the column is NULL (rolling-deploy replica row)',
  )
  assert.equal(
    (await store.player(alpha, query())).history[0].winnerUuid,
    alpha,
    'history falls back to the payload when the column is NULL',
  )
})

test('site#116c-1: v8 backfill survives payloads PostgreSQL cannot cast to jsonb', async (t) => {
  const { databaseUrl } = await import('./storage.mjs')
  const { StatsStore } = await import('../src/lib/stats.ts')
  const url = await databaseUrl(t)
  const first = await StatsStore.open(url)
  // A schema-7 database: winner column gone, version back, one legacy row whose
  // name carries a lone-surrogate escape (validly ingested before, uncastable to jsonb).
  const payload = (winner) =>
    JSON.stringify({ winnerUuid: winner, participants: [{ uuid: alpha, name: 'Alpha' }] })
  const insert = first.db.prepare(
    'INSERT INTO results (server_id,event_id,kind,mode,campaign_id,ended_at,reason,winner,digest,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  await insert.run(
    server,
    match,
    'match',
    'deathmatch',
    null,
    1735689600000,
    'completed',
    'NONE',
    'good',
    payload(alpha),
  )
  await insert.run(
    server,
    beta,
    'match',
    'deathmatch',
    null,
    1735689600000,
    'completed',
    'NONE',
    'bad',
    payload(beta).replace('Alpha', 'a\\ud800b'),
  )
  await first.db.exec('ALTER TABLE results DROP COLUMN winner_uuid')
  await first.db.exec('UPDATE blockfield_schema SET version=7 WHERE id=1')
  await first.close()
  const store = await StatsStore.open(url)
  t.after(() => store.close())
  assert.equal((await store.db.prepare('SELECT version FROM blockfield_schema').get()).version, 8)
  assert.deepEqual(
    (
      await store.db
        .prepare('SELECT event_id "event",winner_uuid "winner" FROM results ORDER BY event_id')
        .all()
    ).map((r) => [r.event, r.winner]),
    [
      [match, alpha],
      [beta, beta],
    ],
    'Node backfill parses the top-level winner even when PostgreSQL cannot cast the payload',
  )
})

test('site#116c-2: rows a schema-7 replica wrote after the backfill still read their FFA win', async (t) => {
  const { database } = await import('./storage.mjs')
  const store = await database(t)
  await store.ingest({ ...fixture(), winnerUuid: alpha })
  await store.db.prepare('UPDATE results SET winner_uuid=NULL').run()
  assert.deepEqual(
    (await store.leaderboard(query())).players
      .map((p) => [p.uuid, p.wins])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [
      [alpha, 1],
      [beta, 0],
    ],
  )
  assert.equal((await store.player(alpha, query())).history[0].winnerUuid, alpha)
})

test('site#116d-1: only the top-level winnerUuid backfills and reads, never a nested one', async (t) => {
  const { database } = await import('./storage.mjs')
  const store = await database(t)
  await store.ingest({ ...fixture(), winnerUuid: alpha })
  await store.ingest({ ...fixture(), eventId: beta, matchId: beta, winnerUuid: beta })
  const nested = (parsed, winner) => {
    const payload = JSON.parse(parsed)
    payload.telemetry = { disputes: [{ winnerUuid: winner }] }
    return JSON.stringify(payload)
  }
  const first = await store.db.prepare('SELECT payload FROM results WHERE event_id=?').get(match)
  await store.db
    .prepare('UPDATE results SET payload=? WHERE event_id=?')
    .run(nested(first.payload, foreign), match)
  const second = await store.db.prepare('SELECT payload FROM results WHERE event_id=?').get(beta)
  const withoutTop = JSON.parse(nested(second.payload, beta))
  delete withoutTop.winnerUuid
  await store.db
    .prepare('UPDATE results SET payload=? WHERE event_id=?')
    .run(JSON.stringify(withoutTop), beta)
  await store.db.prepare('UPDATE results SET winner_uuid=NULL').run()
  assert.deepEqual(
    (await store.leaderboard(query())).players
      .map((p) => [p.uuid, p.wins])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [
      [alpha, 1],
      [beta, 0],
    ],
    'nested telemetry winnerUuid wins nothing; top-level still falls back',
  )
  assert.equal(
    (await store.player(alpha, query())).history.find((h) => h.eventId === match).winnerUuid,
    alpha,
  )
  assert.equal(
    (await store.player(beta, query())).history.find((h) => h.eventId === beta).winnerUuid,
    null,
  )
})

test('site#116e-1: startup backfill repairs lone-surrogate winners, ignores nested keys, reruns cleanly', async (t) => {
  const { databaseUrl } = await import('./storage.mjs')
  const { StatsStore } = await import('../src/lib/stats.ts')
  const url = await databaseUrl(t)
  const gamma = '00000000-0000-4000-8000-000000000006'
  const seed = await StatsStore.open(url)
  const insert = seed.db.prepare(
    'INSERT INTO results (server_id,event_id,kind,mode,campaign_id,ended_at,reason,winner,digest,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  const payload = (winner) =>
    JSON.stringify({ winnerUuid: winner, participants: [{ uuid: alpha, name: 'Alpha' }] })
  await insert.run(
    server,
    match,
    'match',
    'deathmatch',
    null,
    1735689600000,
    'completed',
    'NONE',
    'good',
    payload(alpha),
  )
  await insert.run(
    server,
    beta,
    'match',
    'deathmatch',
    null,
    1735689600000,
    'completed',
    'NONE',
    'bad',
    payload(beta).replace('Alpha', 'a\\ud800b'),
  )
  const nested = JSON.parse(payload(alpha))
  delete nested.winnerUuid
  nested.telemetry = { disputes: [{ winnerUuid: foreign }] }
  await insert.run(
    server,
    gamma,
    'match',
    'deathmatch',
    null,
    1735689600000,
    'completed',
    'NONE',
    'nested',
    JSON.stringify(nested),
  )
  await insert.run(
    server,
    foreign,
    'match',
    'deathmatch',
    null,
    1735689600000,
    'completed',
    'NONE',
    'broken',
    '{not json',
  )
  await seed.close()
  const warnings = []
  const realWarn = console.warn
  console.warn = (...args) => void warnings.push(args.join(' '))
  const store = await StatsStore.open(url)
  console.warn = realWarn
  try {
    const winners = async () =>
      (
        await store.db
          .prepare('SELECT event_id "event",winner_uuid "winner" FROM results ORDER BY event_id')
          .all()
      ).map((r) => [r.event, r.winner])
    assert.deepEqual(await winners(), [
      [match, alpha],
      [beta, beta],
      [foreign, null],
      [gamma, null],
    ])
    assert.deepEqual(
      warnings.filter((w) => w.includes('winner backfill')),
      ['winner backfill: 1 payload(s) unparseable, winner left NULL'],
      'unparseable rows stay NULL and are logged once by count',
    )
    await store.db.prepare('UPDATE results SET winner_uuid=? WHERE event_id=?').run(foreign, match)
  } finally {
    await store.close()
  }
  const reopened = await StatsStore.open(url)
  t.after(() => reopened.close())
  assert.deepEqual(
    (
      await reopened.db
        .prepare('SELECT event_id "event",winner_uuid "winner" FROM results ORDER BY event_id')
        .all()
    ).map((r) => [r.event, r.winner]),
    [
      [match, foreign],
      [beta, beta],
      [foreign, null],
      [gamma, null],
    ],
    'a second start fills nothing new and never overwrites a set winner',
  )
})

test('site#116c-3: player statistics degrade to role null when CP fails', async (t) => {
  const { database } = await import('./storage.mjs')
  const { handleStatsRequest } = await import('../src/lib/stats.ts')
  const store = await database(t),
    deps = { store, keys: { [server]: [token] } }
  assert.equal(
    (await handleStatsRequest(post({ ...fixture(), winnerUuid: alpha }), deps)).status,
    201,
  )
  const saved = {
    url: process.env.BLOCKFIELD_CP_URL,
    staff: process.env.BLOCKFIELD_CP_STAFF_TOKEN,
    owners: process.env.BLOCKFIELD_OWNER_UUIDS,
  }
  process.env.BLOCKFIELD_CP_URL = 'http://127.0.0.1:9'
  process.env.BLOCKFIELD_CP_STAFF_TOKEN = 'test-only-cp-staff-token'
  delete process.env.BLOCKFIELD_OWNER_UUIDS
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
    if (saved.url === undefined) delete process.env.BLOCKFIELD_CP_URL
    else process.env.BLOCKFIELD_CP_URL = saved.url
    if (saved.staff === undefined) delete process.env.BLOCKFIELD_CP_STAFF_TOKEN
    else process.env.BLOCKFIELD_CP_STAFF_TOKEN = saved.staff
    if (saved.owners === undefined) delete process.env.BLOCKFIELD_OWNER_UUIDS
    else process.env.BLOCKFIELD_OWNER_UUIDS = saved.owners
  })
  for (const stub of [
    async () => {
      throw new TypeError('fetch failed')
    },
    async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
  ]) {
    globalThis.fetch = stub
    const response = await handleStatsRequest(
      new Request(`https://example.test/api/stats/players/${alpha}`),
      deps,
    )
    assert.equal(response.status, 200, 'statistics are served without CP')
    assert.equal((await response.json()).profile.role, null, 'role degrades to no link')
  }
})
