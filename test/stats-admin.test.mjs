import test from 'node:test'
import assert from 'node:assert/strict'
import { StatsStore, filters, handleStatsRequest } from '../src/lib/stats.ts'

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const server = uid(1),
  red = uid(3),
  blue = uid(11),
  query = (text = '') => filters(new URLSearchParams(text))
import { database } from './storage.mjs'
const row = (uuid, name, team) => ({
  uuid,
  name,
  team,
  score: 10,
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
const base = (n, time) => ({
  schemaVersion: 1,
  eventId: uid(n),
  serverId: server,
  sessionPurpose: 'gameplay',
  modeId: 'campaign',
  ranked: true,
  rulesetVersion: '1',
  startedAt: time,
  endedAt: time,
  endReason: 'completed',
  participants: [row(red, 'Alpha', 'RED'), row(blue, 'Bravo', 'BLUE')],
})
const match = (n, time) => ({
  ...base(n, time),
  kind: 'match',
  matchId: uid(n),
  campaignSessionId: uid(n + 1000),
  mapId: 'test',
  rounds: [],
  winner: 'RED',
})
const campaign = (n, time, winner) => ({
  ...base(n, time),
  kind: 'campaign',
  matchId: null,
  mapId: null,
  campaignSessionId: uid(n),
  rounds: [uid(n + 500)],
  winner,
})
const ratings = async (db) =>
  (await db.db.prepare('SELECT * FROM ratings ORDER BY season_id,uuid').all()).map((r) => ({
    ...r,
  }))
const changes = async (db) =>
  (await db.db.prepare('SELECT * FROM rating_changes ORDER BY season_id,rated_at,uuid').all()).map(
    (r) => ({ ...r }),
  )

test('void removes a match from leaderboard, player history and classes; restore brings it back', async (t) => {
  const db = await database(t)
  await db.ingest(match(20, '2026-09-01T00:00:00Z'))
  await db.ingest(match(21, '2026-09-02T00:00:00Z'))
  assert.equal((await db.leaderboard(query())).players[0].matches, 2)
  assert.deepEqual(await db.setVoided(server, uid(20), 'Adm'), {
    rebuilt: null,
    match: {
      kind: 'match',
      mode: 'campaign',
      mapId: 'test',
      endedAt: Date.parse('2026-09-01T00:00:00Z'),
    },
  })
  assert.equal((await db.leaderboard(query())).players[0].matches, 1)
  assert.deepEqual(
    (await db.player(red, query())).history.map((h) => h.eventId),
    [uid(21)],
  )
  assert.equal(
    (await db.results(null, 1)).results.find((r) => r.eventId === uid(20)).voidedBy,
    'Adm',
  )
  await assert.rejects(
    async () => await db.setVoided(server, uid(20), 'Adm'),
    (e) => e.status === 409,
  )
  assert.equal(
    (await db.ingest(match(20, '2026-09-01T00:00:00Z'))).inserted,
    false,
    'a producer replay does not un-void',
  )
  assert.equal((await db.leaderboard(query())).players[0].matches, 1)
  await db.setVoided(server, uid(20), null)
  assert.equal((await db.leaderboard(query())).players[0].matches, 2)
  await assert.rejects(
    async () => await db.setVoided(server, uid(99), 'Adm'),
    (e) => e.status === 404,
  )
})

test('voiding a rated campaign rebuilds that season and later ones; restore equals the original ingest', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-02-01T00:00:00Z') })
  const db = await database(t)
  const list = [
    campaign(40, '2026-10-01T00:00:00Z', 'RED'),
    campaign(41, '2026-11-01T00:00:00Z', 'BLUE'),
    campaign(42, '2026-12-01T00:00:00Z', 'RED'),
    campaign(43, '2027-01-10T00:00:00Z', 'BLUE'),
  ]
  for (const result of list) await db.ingest(result)
  const originalRatings = await ratings(db),
    originalChanges = await changes(db)

  const reference = await database(t)
  for (const result of list.filter((r) => r.eventId !== uid(41))) await reference.ingest(result)
  assert.equal((await db.setVoided(server, uid(41), 'Adm')).rebuilt, 's2')
  assert.deepEqual(
    await ratings(db),
    await ratings(reference),
    'void = as if the campaign never arrived, including the s3 carry-over',
  )
  assert.deepEqual(await changes(db), await changes(reference))
  assert.equal((await db.player(red, query('season=s2'))).mmr.ratedCampaigns, 2)

  await db.setVoided(server, uid(41), null)
  assert.deepEqual(await ratings(db), originalRatings)
  assert.deepEqual(await changes(db), originalChanges)
})

test('DB ingest keys: accepted until revoked, only hashes are stored, env keys keep working', async (t) => {
  const db = await database(t),
    envToken = 'env-token-not-a-secret-00000000000000'
  const key = await db.createIngestKey(server, 'lobby')
  assert.ok(!JSON.stringify(await db.db.prepare('SELECT * FROM ingest_keys').all()).includes(key))
  assert.deepEqual(
    (await db.ingestKeys()).map((k) => [k.serverId, k.label, k.revokedAt]),
    [[server, 'lobby', null]],
  )
  const post = (token, n, serverId = server) =>
    handleStatsRequest(
      new Request('https://example.test/api/stats/results', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Blockfield-Server-Id': serverId,
        },
        body: JSON.stringify(match(n, '2026-09-01T00:00:00Z')),
      }),
      { store: db, keys: { [uid(2)]: [envToken] } },
    )
  assert.equal((await post(key, 30)).status, 201)
  assert.equal((await post(key, 31, uid(2))).status, 401, 'a DB key is bound to its server')
  assert.equal(
    (await post(envToken, 32, uid(2))).status,
    403,
    'env key still authenticates (body is for another server)',
  )
  assert.equal(await db.revokeIngestKey((await db.ingestKeys())[0].id), true)
  assert.equal(await db.revokeIngestKey((await db.ingestKeys())[0].id), false)
  assert.equal((await post(key, 33)).status, 401)
})

test('schema 3 file upgrades to 4: results gain void columns, new tables appear, data and ratings stay', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'bf-migrate-v4-'))
  try {
    const path = join(directory, 'stats.sqlite'),
      result = campaign(50, '2026-09-01T00:00:00Z', 'RED')
    const first = await StatsStore.open(path)
    await first.ingest(result)
    const before = await ratings(first)
    await first.close()
    const legacy = new DatabaseSync(path)
    legacy.exec(`DROP TABLE admin_audit; DROP TABLE ingest_keys; DROP TABLE staff_roles;
      ALTER TABLE results DROP COLUMN voided_at; ALTER TABLE results DROP COLUMN voided_by; PRAGMA user_version=3;`)
    await legacy.close()
    const upgraded = await StatsStore.open(path)
    try {
      assert.equal((await upgraded.db.prepare('PRAGMA user_version').get()).user_version, 7)
      assert.deepEqual(await ratings(upgraded), before)
      assert.equal((await upgraded.ingest(result)).inserted, false)
      assert.equal((await upgraded.setVoided(server, uid(50), 'Adm')).rebuilt, 's1')
      assert.equal((await upgraded.db.prepare('SELECT COUNT(*) n FROM ratings').get()).n, 0)
      await upgraded.audit({
        actorUuid: 'a',
        actorName: 'Adm',
        role: 'admin',
        action: 'x',
        ok: true,
      })
      await upgraded.setStaff('b'.repeat(32), 'Bob', 'builder', 'Adm')
    } finally {
      await upgraded.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('audit entries are stored newest first and capped', async (t) => {
  const db = await database(t)
  for (let i = 0; i < 205; i++)
    await db.audit({
      actorUuid: 'a',
      actorName: 'Adm',
      role: 'admin',
      action: `a${i}`,
      detail: { i },
      ok: i % 2 === 0,
      error: i % 2 ? 'x' : null,
    })
  const log = await db.auditLog()
  assert.equal(log.length, 200)
  assert.equal(log[0].action, 'a204')
  assert.equal(JSON.parse(log[0].detail).i, 204)
  assert.equal(log[1].ok, 0)
})

test('review: voiding a campaign that ends minutes ahead, in the next season, rebuilds without a 500', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-12-31T23:58:00Z') })
  const db = await database(t)
  await db.ingest(campaign(60, '2027-01-01T00:01:00.000Z', 'RED'))
  assert.equal((await db.player(red, query())).mmrSeason, 's2')
  assert.equal((await db.setVoided(server, uid(60), 'Adm')).rebuilt, 's3')
  assert.equal((await db.setVoided(server, uid(60), null)).rebuilt, 's3')
  assert.equal(
    (await db.db.prepare("SELECT COUNT(*) n FROM ratings WHERE season_id='s3'").get()).n,
    2,
  )
})

test('review: audit detail is capped at 2 KB and rows are never count-pruned', async (t) => {
  const db = await database(t)
  await db.audit({
    actorUuid: 'a',
    actorName: 'Adm',
    role: 'admin',
    action: 'big',
    detail: { x: 'y'.repeat(70000) },
    ok: true,
  })
  assert.ok((await db.auditLog(1))[0].detail.length <= 2049)
  await db.db.exec(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10005) INSERT INTO admin_audit (at,actor_uuid,actor_name,role,action,ok) SELECT i,'a','A','admin','seed',1 FROM n",
  )
  await db.audit({ actorUuid: 'a', actorName: 'Adm', role: 'admin', action: 'last', ok: true })
  // E5: no count-based pruning; retention deletion requires a verified export (see stats-audit.test.mjs).
  assert.equal((await db.db.prepare('SELECT COUNT(*) n FROM admin_audit').get()).n, 10007)
  assert.equal((await db.auditLog(1))[0].action, 'last')
})
