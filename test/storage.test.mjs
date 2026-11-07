import test from 'node:test'
import assert from 'node:assert/strict'
import { StatsStore, filters } from '../src/lib/stats.ts'
import { postgresSql } from '../src/lib/database.ts'
import { roleOf } from '../src/lib/admin.ts'
import { migrate } from '../scripts/migrate-stats.mjs'
import { database } from './storage.mjs'

const serverId = '10000000-0000-4000-8000-000000000001'
const eventId = '10000000-0000-4000-8000-000000000002'
const uuid = '10000000-0000-4000-8000-000000000003'
const staffId = uuid.replaceAll('-', '')
const result = () => ({
  schemaVersion: 1,
  serverId,
  eventId,
  kind: 'match',
  sessionPurpose: 'gameplay',
  modeId: 'deathmatch',
  ranked: false,
  rulesetVersion: '1',
  matchId: eventId,
  campaignSessionId: null,
  mapId: 'test',
  startedAt: '2026-09-14T00:00:00Z',
  endedAt: '2026-09-14T00:01:00Z',
  endReason: 'completed',
  winner: 'NONE',
  winnerUuid: uuid,
  rounds: [],
  participants: [
    {
      uuid,
      name: 'Player',
      team: 'NONE',
      score: 1,
      kills: 1,
      deaths: 0,
      captures: 0,
      neutralizations: 0,
      pointSeconds: 0,
      playSeconds: 60,
      suicides: 0,
      teamKills: 0,
      maxKillstreak: 1,
      classes: [],
    },
  ],
})

test('PostgreSQL placeholders preserve quoted question marks', () => {
  assert.equal(postgresSql(`SELECT '?', "?", 'it''s ?', ?`), `SELECT '?', "?", 'it''s ?', $1`)
})

test('concurrent replay inserts once, conflicting replay cannot alter the result', async (t) => {
  const store = await database(t)
  const responses = await Promise.all(Array.from({ length: 8 }, () => store.ingest(result())))
  assert.equal(responses.filter((r) => r.inserted).length, 1)
  await assert.rejects(
    () => store.ingest({ ...result(), winnerUuid: undefined }),
    (e) => e.status === 422,
  )
  const board = await store.leaderboard(filters(new URLSearchParams()))
  assert.equal(board.players[0].matches, 1)
  assert.equal(board.players[0].wins, 1)
})

test('rolled-back writes are invisible to concurrent readers', async (t) => {
  const store = await database(t)
  let written, release
  const ready = new Promise((resolve) => {
    written = resolve
  })
  const resume = new Promise((resolve) => {
    release = resolve
  })
  const transaction = store.db.transaction(async () => {
    await store.setStaff(staffId, 'Player', 'admin', 'test')
    written()
    await resume
    throw new Error('abort')
  })
  await ready
  const reading = store.staff()
  release()
  await assert.rejects(transaction, /abort/)
  assert.deepEqual(await reading, [])
})

test('SQLite backup migrates exactly, preserves permissions and key IDs, and refuses an occupied target', async (t) => {
  if (!process.env.BLOCKFIELD_TEST_DATABASE_URL)
    throw new Error(
      'BLOCKFIELD_TEST_DATABASE_URL is not set: this test needs a PostgreSQL database where the test user may create schemas. ' +
        'Local setup is documented in docs/statistics.md (Tests); CI provides it as a service.',
    )
  {
    const source = await StatsStore.openBackup(':memory:')
    t.after(() => source.close())
    const target = await database(t)
    await source.ingest(result())
    await source.setStaff(staffId, 'Player', 'builder', 'owner')
    await source.setStaffMaps(staffId, ['test'])
    await source.audit({
      actorUuid: staffId,
      actorName: 'Player',
      role: 'builder',
      action: 'test',
      ok: true,
    })
    const key = await source.createIngestKey(serverId, 'producer')
    await source.db.prepare('UPDATE ingest_keys SET id=37').run()
    const counts = await migrate(source, target)
    assert.equal(counts.results, 1)
    assert.deepEqual(await target.staff(), await source.staff())
    assert.equal(await roleOf(staffId, target, new Set()), 'builder')
    assert.deepEqual(
      await target.ingestKeys(),
      JSON.parse(JSON.stringify(await source.ingestKeys())),
    )
    assert.deepEqual(await target.auditLog(), JSON.parse(JSON.stringify(await source.auditLog())))
    assert.equal((await target.ingest(result())).inserted, false)
    assert.equal((await target.leaderboard(filters(new URLSearchParams()))).players[0].wins, 1)
    assert.ok((await target.ingestKeyHashes(serverId)).length)
    assert.ok(key)
    await target.createIngestKey(serverId, 'next')
    assert.equal((await target.ingestKeys())[0].id, 38)
    await assert.rejects(() => migrate(source, target), /not empty/)
    assert.equal((await target.ingestKeys()).length, 2)
  }
})
