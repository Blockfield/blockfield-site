import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatsStore, validateResult, filters, handleStatsRequest } from '../src/lib/stats.ts';

const server = '00000000-0000-4000-8000-000000000001';
const match = '00000000-0000-4000-8000-000000000002';
const alpha = '00000000-0000-4000-8000-000000000003';
const beta = '00000000-0000-4000-8000-000000000004';
const foreign = '00000000-0000-4000-8000-000000000005';
const token = 'test-only-stats-review-token-000000000000';
function fixture() {
  const player = uuid => ({ uuid, name: uuid === alpha ? 'Alpha' : 'Beta', team: 'NONE', score: 1,
    kills: 1, deaths: 1, captures: 0, neutralizations: 0, pointSeconds: 0, playSeconds: 60,
    suicides: 0, teamKills: 0, maxKillstreak: 1, classes: [] });
  return { schemaVersion: 1, eventId: match, serverId: server, kind: 'match', sessionPurpose: 'gameplay',
    modeId: 'deathmatch', ranked: false, rulesetVersion: 'ffa-v1', matchId: match, campaignSessionId: null,
    mapId: 'arena', startedAt: '2025-01-01T00:00:00Z', endedAt: '2025-01-01T00:01:00Z',
    endReason: 'completed', winner: 'NONE', rounds: [], participants: [player(alpha), player(beta)] };
}
const query = (text = '') => filters(new URLSearchParams(text));
import { database } from './storage.mjs';
function post(body, producer = server) {
  return new Request('https://example.test/api/stats/results', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Blockfield-Server-Id': producer },
    body: JSON.stringify(body) });
}

test('FFA winner UUID is persisted and counted once through the public API', async t => {
  const store = await database(t), deps = { store, keys: { [server]: [token] } };
  const result = { ...fixture(), winnerUuid: alpha };
  assert.equal((await handleStatsRequest(post(result), deps)).status, 201);
  assert.equal((await handleStatsRequest(post(result), deps)).status, 200);
  const response = await handleStatsRequest(new Request('https://example.test/api/stats/leaderboard?mode=deathmatch&sort=wins'), deps);
  const board = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(board.players.map(p => [p.uuid, p.matches, p.wins, p.mmr]), [[alpha, 1, 1, null], [beta, 1, 0, null]]);
  const detail = await store.player(alpha, query());
  assert.equal(detail.history[0].winnerUuid, alpha);
  assert.equal(detail.campaigns.completed, 0);
  assert.equal(detail.ratingStatus, 'glicko2-v1'); assert.equal(detail.mmr, null); // FFA never rates
});

test('personal winner must belong to a completed FFA roster, not a team or campaign', () => {
  for (const mutate of [
    r => r.winnerUuid = foreign, r => r.winnerUuid = null, r => r.winnerUuid = [alpha],
    r => r.winner = 'RED', r => r.participants[0].team = 'RED',
    r => r.campaignSessionId = foreign, r => r.modeId = 'room',
    r => r.endReason = 'draw', r => r.endReason = 'stopped',
    r => r.endReason = 'shutdown', r => r.endReason = 'error',
  ]) {
    const result = { ...fixture(), winnerUuid: alpha }; mutate(result);
    assert.throws(() => validateResult(result), error => error.status === 422);
  }
});

test('missing personal winner preserves legacy canonical bytes and never guesses an FFA victory', async t => {
  const store = await database(t), result = fixture(); await store.ingest(result);
  const row = await store.db.prepare('SELECT digest,payload FROM results').get();
  assert.equal(row.digest, '206a70ca88e066b886b3d1c52360659758caaa0eb033718d7d5c98e43f5dda4c');
  assert.ok(!Object.hasOwn(JSON.parse(row.payload), 'winnerUuid'));
  assert.equal((await store.ingest(result)).inserted, false);
  assert.deepEqual((await store.leaderboard(query())).players.map(p => p.wins), [0, 0]);
});

test('result identity fields reject regex string coercion of arrays', () => {
  const a = fixture(); a.eventId = a.matchId = [match];
  const b = fixture(); b.serverId = [server];
  for (const result of [a, b]) assert.throws(() => validateResult(result), error => error.status === 422);
});

test('invalid and inherited producer keys fail with 401 before parsing the body', async t => {
  const store = await database(t), deps = { store, keys: { [server]: [token] } };
  for (const producer of ['__proto__', 'constructor', 'toString', 'not-a-uuid', foreign]) {
    const request = post(fixture(), producer);
    let bodyRead = false;
    Object.defineProperty(request, 'body', { get() { bodyRead = true; throw new Error('must not read unauthorized body'); } });
    assert.equal((await handleStatsRequest(request, deps)).status, 401, producer);
    assert.equal(bodyRead, false);
  }
  const inherited = { store, keys: Object.create({ [server]: [token] }) };
  assert.equal((await handleStatsRequest(post(fixture()), inherited)).status, 401);
});

test('conflicting personal winner replay cannot rewrite an accepted victory', async t => {
  const store = await database(t), result = { ...fixture(), winnerUuid: alpha };
  await store.ingest(result);
  await assert.rejects(async () => await store.ingest({ ...result, winnerUuid: beta }), error => error.status === 409);
  assert.equal((await store.player(alpha, query())).totals.wins, 1);
  assert.equal((await store.player(beta, query())).totals.wins, 0);
});

test('schema 1 database with results opens under schema 4 without losing data', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'bf-migrate-'));
  try {
    const path = join(directory, 'stats.sqlite'), result = { ...fixture(), winnerUuid: alpha };
    const first = await StatsStore.open(path); await first.ingest(result); await first.close();
    // Simulate a production v1 file: drop the rating tables and the version bump.
    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE rating_changes; DROP TABLE ratings; PRAGMA user_version=1;'); await legacy.close();
    const upgraded = await StatsStore.open(path);
    try {
      assert.equal((await upgraded.db.prepare('PRAGMA user_version').get()).user_version, 6);
      assert.equal((await upgraded.ingest(result)).inserted, false);
      assert.equal((await upgraded.player(alpha, query())).totals.wins, 1);
      assert.equal((await upgraded.db.prepare('SELECT COUNT(*) n FROM ratings').get()).n, 0);
    } finally { await upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('schema 2 lifetime ratings migrate in place to schema 4 season 1 rows', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-02T00:00:00Z') });
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'bf-migrate-v3-'));
  try {
    const path = join(directory, 'stats.sqlite'), [red, blue] = fixture().participants;
    const result = { ...fixture(), kind: 'campaign', modeId: 'campaign', ranked: true, eventId: foreign, campaignSessionId: foreign, matchId: null, mapId: null,
      rounds: [match], startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:00:00Z', winner: 'RED',
      participants: [{ ...red, team: 'RED' }, { ...blue, team: 'BLUE' }] };
    const first = await StatsStore.open(path); await first.ingest(result);
    const columns = 'uuid,rating,rd,volatility,rated_campaigns,last_rated_at';
    const before = (await first.db.prepare(`SELECT ${columns} FROM ratings ORDER BY uuid`).all()).map(r => ({ season_id: 's1', ...r })); await first.close();
    // Rebuild the exact production v2 shape: lifetime ratings keyed by uuid, rating_changes without season_id.
    const legacy = new DatabaseSync(path);
    legacy.exec(`ALTER TABLE ratings RENAME TO v3;
      CREATE TABLE ratings (uuid TEXT PRIMARY KEY, rating REAL NOT NULL, rd REAL NOT NULL, volatility REAL NOT NULL, rated_campaigns INTEGER NOT NULL, last_rated_at INTEGER NOT NULL);
      INSERT INTO ratings SELECT ${columns} FROM v3; DROP TABLE v3;
      ALTER TABLE rating_changes DROP COLUMN season_id; PRAGMA user_version=2;`);
    await legacy.close();
    const upgraded = await StatsStore.open(path);
    try {
      assert.equal((await upgraded.db.prepare('PRAGMA user_version').get()).user_version, 6);
      const ratings = async () => (await upgraded.db.prepare(`SELECT season_id,${columns} FROM ratings ORDER BY uuid`).all()).map(r => ({ ...r }));
      assert.equal(before.length, 2); assert.deepEqual(await ratings(), before);
      assert.deepEqual((await upgraded.db.prepare('SELECT DISTINCT season_id FROM rating_changes').all()).map(r => r.season_id), ['s1']);
      assert.equal((await upgraded.ingest(result)).inserted, false); assert.deepEqual(await ratings(), before);
      const detail = await upgraded.player(alpha, query());
      assert.equal(detail.mmrSeason, 's1'); assert.equal(detail.mmr.ratedCampaigns, 1); assert.equal(detail.ratingHistory.length, 1);
    } finally { await upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('winner UUID survives reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bf-ffa-review-'));
  try {
    const path = join(directory, 'stats.sqlite'), result = { ...fixture(), winnerUuid: alpha };
    const first = await StatsStore.open(path); await first.ingest(result); await first.close();
    const second = await StatsStore.open(path);
    try {
      assert.equal((await second.db.prepare('PRAGMA user_version').get()).user_version, 6);
      assert.equal((await second.ingest(result)).inserted, false);
      assert.equal((await second.player(alpha, query())).totals.wins, 1);
    } finally { await second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('allowlisting keeps the new result field but excludes unrelated producer data', async t => {
  const store = await database(t), result = { ...fixture(), winnerUuid: alpha, secret: 'never-persist-this' };
  await store.ingest(result);
  const raw = (await store.db.prepare('SELECT payload FROM results').get()).payload;
  assert.equal(JSON.parse(raw).winnerUuid, alpha);
  assert.ok(!raw.includes('never-persist-this'));
});

test('history presentation distinguishes personal winners, draws and unknown legacy outcomes', async () => {
  const { outcomeLabel } = await import('../src/lib/stats-outcome.ts');
  const result = { mode: 'deathmatch', reason: 'completed', winner: 'NONE', team: 'NONE', winnerUuid: alpha };
  assert.equal(outcomeLabel(result, alpha), ' · победа');
  assert.equal(outcomeLabel(result, beta), ' · поражение');
  for (const reason of ['draw', 'stopped', 'shutdown', 'error', 'abandoned']) {
    assert.equal(outcomeLabel({ ...result, reason }, alpha), '');
  }
  assert.equal(outcomeLabel({ ...result, winnerUuid: null }, alpha), '');
  assert.equal(outcomeLabel({ ...result, winnerUuid: null, winner: 'RED', team: 'RED' }, alpha), '');
  assert.equal(outcomeLabel({ ...result, mode: 'room', winner: 'RED', team: 'RED' }, alpha), ' · победа');
  assert.equal(outcomeLabel({ ...result, mode: 'campaign', winner: 'BLUE', team: 'RED' }, alpha), ' · поражение');
});
