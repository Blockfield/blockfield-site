import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  clearCpStatsCache,
  CP_STATS_SEASONS_TTL_MS,
  cpStatsConfigured,
  readHitregCp,
  readLeaderboardCp,
  readPlayerCp,
  readSeasonsCp,
  StatsError,
} from '../src/lib/cp-stats.ts'
import { RENEWED_KEYS } from '../src/lib/cp-renew.ts'
import { handleStatsRequest } from '../src/lib/stats.ts'
import { handleAdmin } from '../src/lib/admin.ts'
import { saveReport, validateReport } from '../src/lib/diagnostics.ts'
import { database as store } from './storage.mjs'

const PLAYER = '00000000-0000-4000-8000-000000000003'
const SERVER = '00000000-0000-4000-8000-000000000001'
const ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function samplePlayerView(overrides = {}) {
  return {
    schemaVersion: 1,
    checkedAt: '2026-11-13T10:00:00.000Z',
    season: null,
    mmrSeason: 's2',
    page: 1,
    limit: 20,
    profile: { uuid: PLAYER, name: 'Alpha', lastSeen: 1763028000000 },
    totals: null,
    campaigns: { completed: 0, wins: 0 },
    classes: [],
    history: [],
    mmr: null,
    ratingHistory: [],
    ratingStatus: 'glicko2-v1',
    ...overrides,
  }
}

function sampleLeaderboardView(overrides = {}) {
  return {
    schemaVersion: 1,
    checkedAt: '2026-11-13T10:00:00.000Z',
    mode: null,
    season: null,
    mmrSeason: 's2',
    page: 1,
    limit: 50,
    total: 0,
    ratingStatus: 'glicko2-v1',
    players: [],
    ...overrides,
  }
}

function sampleSeasonsView(overrides = {}) {
  return {
    schemaVersion: 1,
    current: 's2',
    seasons: [
      {
        id: 's2',
        name: 'Сезон 1',
        startsAt: '2026-09-26T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.999Z',
      },
    ],
    ...overrides,
  }
}

function sampleHitregView(overrides = {}) {
  return {
    schemaVersion: 1,
    checkedAt: '2026-11-13T10:00:00.000Z',
    mode: null,
    matches: 2,
    withTelemetry: 1,
    telemetryDropped: 0,
    truncated: false,
    shots: 10,
    fallbackShare: 0.2,
    disputes: 0,
    counters: { shots: 10 },
    tickMsP50Median: 14,
    tickMsP50P99: 20,
    tickMsP99Median: 28,
    tickMsP99P99: 40,
    ageTicksP50Median: 1,
    ageTicksP50P99: 2,
    rewindTicksP50Median: 1,
    rewindTicksP50P99: 1,
    ...overrides,
  }
}

async function fakeCp(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

test('cp-stats auth: requires URL + token, sends Bearer, and participates in token renewal', async (t) => {
  assert.ok(RENEWED_KEYS.includes('BLOCKFIELD_CP_STATS_TOKEN'))
  assert.equal(cpStatsConfigured({}), false)
  assert.equal(
    cpStatsConfigured({ BLOCKFIELD_CP_URL: 'http://127.0.0.1:9', BLOCKFIELD_CP_STATS_TOKEN: '  ' }),
    false,
  )
  assert.equal(
    cpStatsConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_STATS_TOKEN: 'tok',
    }),
    true,
  )

  await assert.rejects(
    () => readSeasonsCp({ env: {}, noCache: true }),
    (err) => err instanceof StatsError && err.status === 503,
  )

  let authHeader = null
  const base = await fakeCp(t, (req, res) => {
    authHeader = req.headers.authorization ?? null
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(sampleSeasonsView()))
  })
  const view = await readSeasonsCp({
    env: { BLOCKFIELD_CP_URL: base, BLOCKFIELD_CP_STATS_TOKEN: 'scoped-stats-token' },
    noCache: true,
  })
  assert.equal(authHeader, 'Bearer scoped-stats-token')
  assert.equal(view.current, 's2')
})

test('cp-stats errors: maps 401/403 -> 503, 404 -> 404, 400 -> 400, malformed/5xx -> 502, unreachable -> 503', async () => {
  const env = { BLOCKFIELD_CP_URL: 'http://127.0.0.1:9', BLOCKFIELD_CP_STATS_TOKEN: 'tok' }

  for (const status of [401, 403]) {
    await assert.rejects(
      () =>
        readLeaderboardCp(undefined, {
          env,
          fetchImpl: async () => new Response(JSON.stringify({ error: 'forbidden' }), { status }),
        }),
      (err) => err instanceof StatsError && err.status === 503,
    )
  }

  await assert.rejects(
    () =>
      readPlayerCp(PLAYER, undefined, {
        env,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: 'player_not_found' }), { status: 404 }),
      }),
    (err) => err instanceof StatsError && err.status === 404,
  )

  await assert.rejects(
    () =>
      readLeaderboardCp(
        { season: 's99' },
        {
          env,
          fetchImpl: async () =>
            new Response(JSON.stringify({ error: 'invalid_stats_filter' }), { status: 400 }),
        },
      ),
    (err) => err instanceof StatsError && err.status === 400,
  )

  for (const status of [500, 502]) {
    await assert.rejects(
      () =>
        readHitregCp(undefined, {
          env,
          fetchImpl: async () => new Response(JSON.stringify({ error: 'boom' }), { status }),
        }),
      (err) => err instanceof StatsError && err.status === 502,
    )
  }

  await assert.rejects(
    () =>
      readLeaderboardCp(undefined, {
        env,
        fetchImpl: async () => Response.json({ schemaVersion: 1, players: 'not-array' }),
      }),
    (err) => err instanceof StatsError && err.status === 502,
  )

  await assert.rejects(
    () =>
      readPlayerCp(PLAYER, undefined, {
        env,
        fetchImpl: async () => {
          throw new TypeError('connect ECONNREFUSED')
        },
      }),
    (err) => err instanceof StatsError && err.status === 503,
  )

  let called = false
  for (const badUuid of [
    'not-a-uuid',
    '../staff',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    '0000',
  ]) {
    await assert.rejects(
      () =>
        readPlayerCp(badUuid, undefined, {
          env,
          fetchImpl: async () => {
            called = true
            return Response.json(samplePlayerView())
          },
        }),
      (err) => err instanceof StatsError && err.status === 400,
    )
  }
  assert.equal(called, false, 'invalid UUID is rejected before calling CP')
})

test('readSeasonsCp caches in-process for 30s and resets on TTL expiry, token change, or clearCpStatsCache', async (t) => {
  clearCpStatsCache()
  t.after(() => clearCpStatsCache())
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)

  let hits = 0
  const envA = { BLOCKFIELD_CP_URL: 'http://cp.local', BLOCKFIELD_CP_STATS_TOKEN: 'token-a' }
  const envB = { BLOCKFIELD_CP_URL: 'http://cp.local', BLOCKFIELD_CP_STATS_TOKEN: 'token-b' }
  const fetchImpl = async () => {
    hits++
    return Response.json(sampleSeasonsView({ current: `s${hits}` }))
  }

  assert.equal((await readSeasonsCp({ env: envA, fetchImpl })).current, 's1')
  assert.equal((await readSeasonsCp({ env: envA, fetchImpl })).current, 's1')
  assert.equal(hits, 1)

  // Token change bypasses stale token's cache entry.
  assert.equal((await readSeasonsCp({ env: envB, fetchImpl })).current, 's2')
  assert.equal(hits, 2)

  // Expiry after 30s refreshes.
  now += CP_STATS_SEASONS_TTL_MS + 1
  assert.equal((await readSeasonsCp({ env: envB, fetchImpl })).current, 's3')
  assert.equal(hits, 3)

  // Explicit clearCpStatsCache refreshes immediately.
  clearCpStatsCache()
  assert.equal((await readSeasonsCp({ env: envB, fetchImpl })).current, 's4')
  assert.equal(hits, 4)
})

test('readHitregCp defaults period=week only when neither period nor season is specified', async () => {
  const urls = []
  const env = { BLOCKFIELD_CP_URL: 'http://cp.local', BLOCKFIELD_CP_STATS_TOKEN: 'tok' }
  const fetchImpl = async (url) => {
    urls.push(String(url))
    return Response.json(sampleHitregView())
  }
  await readHitregCp(new URLSearchParams(), { env, fetchImpl })
  await readHitregCp(new URLSearchParams('period=month&mode=room'), { env, fetchImpl })
  await readHitregCp(new URLSearchParams('season=s2'), { env, fetchImpl })
  assert.deepEqual(urls, [
    'http://cp.local/v2/stats/hitreg?period=week',
    'http://cp.local/v2/stats/hitreg?mode=room&period=month',
    'http://cp.local/v2/stats/hitreg?season=s2',
  ])
})

test('zero fallback to site Postgres DB: reads fail with 502/503 or return CP empty state even with populated DB', async (t) => {
  clearCpStatsCache()
  t.after(() => clearCpStatsCache())
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const now = Date.now()
  const matchId = randomUUID()
  await s.ingest({
    schemaVersion: 1,
    serverId: SERVER,
    eventId: matchId,
    kind: 'match',
    sessionPurpose: 'gameplay',
    modeId: 'room',
    ranked: false,
    rulesetVersion: '1',
    matchId,
    campaignSessionId: null,
    mapId: 'fields',
    startedAt: new Date(now - 60_000).toISOString(),
    endedAt: new Date(now - 1000).toISOString(),
    endReason: 'completed',
    winner: 'RED',
    rounds: [],
    participants: [
      {
        uuid: PLAYER,
        name: 'LocalOnlyPlayer',
        team: 'RED',
        score: 99,
        kills: 5,
        deaths: 1,
        captures: 1,
        neutralizations: 0,
        pointSeconds: 20,
        playSeconds: 59,
        suicides: 0,
        teamKills: 0,
        maxKillstreak: 5,
        classes: [],
      },
    ],
    telemetry: {
      shots: 50,
      fallbackShare: 0.1,
      disputes: [],
      tickMsP50: 10,
      tickMsP99: 20,
      ageTicksP50: 1,
      rewindTicksP50: 1,
      counters: { shots: 50 },
    },
  })
  await saveReport(
    s.db,
    validateReport({
      schemaVersion: 1,
      serverId: SERVER,
      samples: [{ at: now - 30_000, tps: 20, msptAvg: 12, msptMax: 30 }],
    }),
  )

  const saved = { ...process.env }
  t.after(() => {
    clearCpStatsCache()
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  delete process.env.BLOCKFIELD_CP_URL
  delete process.env.BLOCKFIELD_CP_STATS_TOKEN
  process.env.BLOCKFIELD_OWNER_UUIDS = ''
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${ADMIN}:Adm`
  process.env.NODE_ENV = 'test'

  // Unconfigured CP: public and admin stats/diagnostics/hitreg must return 503, never local DB rows.
  for (const path of ['/seasons', '/leaderboard', `/players/${PLAYER}`]) {
    const res = await handleStatsRequest(new Request(`https://example.test/api/stats${path}`), {
      store: s,
    })
    assert.equal(res.status, 503, `${path} must fail closed without CP`)
  }
  for (const route of ['diagnostics', 'hitreg', 'seasons']) {
    const url = new URL(`http://site/api/admin/${route}`)
    const res = await handleAdmin(
      { request: new Request(url), url, cookies: { get: () => undefined } },
      route,
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
    assert.equal(res.status, 503, `admin/${route} must fail closed without CP`)
  }

  // Empty CP responses must return empty states rather than falling back to local DB rows.
  const emptyCp = await fakeCp(t, (req, res) => {
    const url = new URL(req.url, 'http://cp')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/v2/stats/seasons') return res.end(JSON.stringify(sampleSeasonsView()))
    if (url.pathname === '/v2/stats/leaderboard')
      return res.end(JSON.stringify(sampleLeaderboardView({ total: 0, players: [] })))
    if (url.pathname === '/v2/stats/hitreg')
      return res.end(
        JSON.stringify(
          sampleHitregView({
            matches: 0,
            withTelemetry: 0,
            shots: 0,
            fallbackShare: 0,
            counters: {},
          }),
        ),
      )
    if (url.pathname === '/v2/stats/diagnostics')
      return res.end(
        JSON.stringify({
          schemaVersion: 1,
          now,
          hours: 24,
          lastSampleAt: null,
          samples: [],
          events: [],
        }),
      )
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'player_not_found' }))
  })
  process.env.BLOCKFIELD_CP_URL = emptyCp
  process.env.BLOCKFIELD_CP_STATS_TOKEN = 'stats-tok'

  const lbRes = await handleStatsRequest(
    new Request('https://example.test/api/stats/leaderboard'),
    {
      store: s,
    },
  )
  assert.equal(lbRes.status, 200)
  assert.equal((await lbRes.json()).total, 0)

  const plRes = await handleStatsRequest(
    new Request(`https://example.test/api/stats/players/${PLAYER}`),
    { store: s },
  )
  assert.equal(plRes.status, 404)

  const hitRes = await handleAdmin(
    {
      request: new Request('http://site/api/admin/hitreg'),
      url: new URL('http://site/api/admin/hitreg'),
      cookies: { get: () => undefined },
    },
    'hitreg',
    s,
  )
  assert.equal(hitRes.status, 200)
  assert.equal((await hitRes.json()).shots, 0)

  const diagRes = await handleAdmin(
    {
      request: new Request('http://site/api/admin/diagnostics'),
      url: new URL('http://site/api/admin/diagnostics'),
      cookies: { get: () => undefined },
    },
    'diagnostics',
    s,
  )
  assert.equal(diagRes.status, 200)
  assert.equal((await diagRes.json()).lastSampleAt, null)

  // Public stats routes also work when BLOCKFIELD_DATABASE_URL is not set at all.
  delete process.env.BLOCKFIELD_DATABASE_URL
  const dbLessRes = await handleStatsRequest(
    new Request('https://example.test/api/stats/leaderboard'),
  )
  assert.equal(dbLessRes.status, 200)
})

test('retired ingest and admin stats-write routes return 404 without reading bodies', async (t) => {
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${ADMIN}:Adm`
  process.env.NODE_ENV = 'test'

  for (const path of ['/api/stats/results', '/api/stats/diagnostics']) {
    const req = new Request(`https://example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal((await handleStatsRequest(req)).status, 404)
  }

  for (const [method, route] of [
    ['GET', 'results'],
    ['POST', 'results/void'],
    ['GET', 'keys'],
    ['POST', 'keys'],
    ['POST', 'keys/revoke'],
  ]) {
    const url = new URL(`http://site/api/admin/${route}`)
    const res = await handleAdmin(
      {
        request: new Request(url, { method }),
        url,
        cookies: { get: () => undefined },
      },
      route,
      s,
    )
    assert.equal(res.status, 404, `${method} /api/admin/${route} must be 404`)
  }
})

test('GET /api/admin/diagnostics maps CP 401/403 (forbidden)/503 to 503 without falling back', async (t) => {
  const s = await store(t)
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed')
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${ADMIN}:Adm`
  process.env.NODE_ENV = 'test'

  for (const [status, code] of [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [503, 'unavailable'],
  ]) {
    const base = await fakeCp(t, (_req, res) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: code }))
    })
    process.env.BLOCKFIELD_CP_URL = base
    process.env.BLOCKFIELD_CP_STATS_TOKEN = 'diag-tok'
    const url = new URL('http://site/api/admin/diagnostics')
    const res = await handleAdmin(
      { request: new Request(url), url, cookies: { get: () => undefined } },
      'diagnostics',
      s,
    ).then(
      (r) => r,
      (e) => e,
    )
    assert.equal(res.status, 503, `CP ${status}/${code} must map to 503`)
  }
})
