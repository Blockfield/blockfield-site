import test from 'node:test'
import assert from 'node:assert/strict'
import { filters } from '../src/lib/stats.ts'
import { postgresSql } from '../src/lib/database.ts'
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

test('sessions expire server-side after 30 days even when used (site#116 item 4)', async (t) => {
  const store = await database(t)
  const id = 'a'.repeat(32)
  const old = Date.now() - 31 * 86_400_000
  await store.insertSession(id, 'sealed-token', 'b'.repeat(32), old)
  await store.touchSession(id, Date.now())
  assert.equal(await store.getSession(id), undefined, '31-day-old session is dead')
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
