import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatsStore, StatsError, filters, validateResult, handleStatsRequest } from '../src/lib/stats.ts';

const server = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const player = '00000000-0000-4000-8000-000000000003';
const campaign = '00000000-0000-4000-8000-000000000004';
const token = 'test-only-token-not-a-secret-000000000000';
function fixture() {
  return { schemaVersion: 1, eventId: id, serverId: server, kind: 'match', sessionPurpose: 'gameplay', modeId: 'campaign', ranked: true, rulesetVersion: '1',
    matchId: id, campaignSessionId: campaign, mapId: 'test', startedAt: new Date(Date.now() - 120000).toISOString(), endedAt: new Date(Date.now() - 60000).toISOString(),
    endReason: 'completed', winner: 'RED', rounds: [], participants: [{ uuid: player, name: 'Alpha', team: 'RED', score: 15, kills: 1, deaths: 0, captures: 1,
      neutralizations: 0, pointSeconds: 10, playSeconds: 60, suicides: 0, teamKills: 0, maxKillstreak: 1, classes: [{ classId: 'assault', variantId: '0', timeSeconds: 60, kills: 1, deaths: 0, pointSeconds: 10 }] }] };
}
const query = (text = '') => filters(new URLSearchParams(text));
function database(t) { const store = new StatsStore(':memory:'); t.after(() => store.close()); return store; }
function request(body, headers = {}, method = 'POST', path = '/results') {
  return new Request(`https://example.test/api/stats${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Blockfield-Server-Id': server, ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}
function dependencies(t) { return { store: database(t), keys: { [server]: [token] } }; }

test('result insert, reordered replay, and conflicting replay are atomic/idempotent', t => {
  const db = database(t), result = fixture();
  assert.equal(db.ingest(result).inserted, true);
  const reordered = Object.fromEntries(Object.entries(result).reverse());
  assert.equal(db.ingest(reordered).inserted, false);
  const conflict = structuredClone(result); conflict.participants[0].kills++;
  assert.throws(() => db.ingest(conflict), error => error.status === 409);
  const board = db.leaderboard(query());
  assert.equal(board.total, 1); assert.equal(board.players[0].kills, 1); assert.equal(board.players[0].matches, 1);
  assert.equal(board.players[0].kd, 1); assert.equal(board.players[0].mmr, null);
});

test('campaign completion never double-counts round metrics or awards provisional MMR', t => {
  const db = database(t), round = fixture(); db.ingest(round);
  const result = { ...round, kind: 'campaign', eventId: campaign, matchId: null, mapId: null, rounds: [id] };
  db.ingest(result); db.ingest(result);
  const detail = db.player(player, query());
  assert.equal(detail.totals.kills, 1); assert.equal(detail.totals.matches, 1);
  assert.equal(detail.campaigns.completed, 1); assert.equal(detail.campaigns.wins, 1);
  assert.equal(detail.classes[0].timeSeconds, 60); assert.equal(detail.history.length, 2);
  assert.equal(detail.mmr, null); assert.equal(detail.ratingStatus, 'not_configured');
});
test('interrupted campaign is stored but is not a victory or completed campaign', t => {
  const db = database(t), round = fixture(); db.ingest(round);
  const result = { ...round, kind: 'campaign', eventId: campaign, matchId: null, mapId: null, rounds: [id], endReason: 'stopped', winner: 'NONE' };
  db.ingest(result);
  assert.equal(db.player(player, query()).campaigns.completed, 0);
  assert.equal(db.leaderboard(query()).players[0].wins, 1); // the completed battle remains a battle win, not MMR
  assert.throws(() => validateResult({ ...result, winner: 'RED' }), StatsError);
});
test('all non-gameplay purposes are rejected at ingestion, even with valid credentials', async t => {
  const deps = dependencies(t);
  for (const purpose of ['training', 'workshop', 'playtest', 'lobby', 'unknown']) {
    const response = await handleStatsRequest(request({ ...fixture(), sessionPurpose: purpose }), deps);
    assert.equal(response.status, 422);
  }
  assert.equal(deps.store.leaderboard(query()).total, 0);
});
test('duplicate UUIDs and class/variant pairs cannot inflate counters', () => {
  const a = fixture(); a.participants.push(structuredClone(a.participants[0]));
  assert.throws(() => validateResult(a), StatsError);
  const b = fixture(); b.participants[0].classes.push(structuredClone(b.participants[0].classes[0]));
  assert.throws(() => validateResult(b), StatsError);
});
test('validation rejects non-finite/negative counters, invalid intervals and invalid IDs', () => {
  for (const mutate of [
    r => r.participants[0].kills = -1, r => r.participants[0].score = Infinity,
    r => r.startedAt = 'yesterday', r => r.endedAt = '3000-01-01T00:00:00Z',
    r => r.eventId = '../escape', r => r.mapId = '../escape', r => r.ranked = false,
    r => r.participants[0].classes[0].variantId = '', r => r.participants[0].name = 'bad\nname',
    r => r.matchId = campaign, r => r.campaignSessionId = null,
  ]) { const result = fixture(); mutate(result); assert.throws(() => validateResult(result), StatsError); }
  const loss = fixture(); loss.participants[0].score = -20; assert.equal(validateResult(loss).participants[0].score, -20);
});
test('only contract fields are stored; producer-specific secrets and IPs are dropped', t => {
  const db = database(t), result = fixture(); result.secret = 'do-not-store'; result.participants[0].address = 'private-address';
  db.ingest(result);
  const { payload } = db.db.prepare('SELECT payload FROM results').get();
  assert.ok(!payload.includes('do-not-store')); assert.ok(!payload.includes('private-address'));
});
test('same result ID from a separate trusted server is independent', t => {
  const db = database(t), result = fixture(); db.ingest(result);
  db.ingest({ ...result, serverId: '00000000-0000-4000-8000-000000000005' });
  assert.equal(db.leaderboard(query()).players[0].matches, 2);
});
test('ties have stable UUID ordering across pages; filters do not mix modes', t => {
  const db = database(t), result = fixture();
  result.participants.push({ ...structuredClone(result.participants[0]), uuid: '00000000-0000-4000-8000-000000000006', name: 'Beta' }); db.ingest(result);
  assert.equal(db.leaderboard(query('limit=1&page=1')).players[0].uuid, player);
  assert.equal(db.leaderboard(query('limit=1&page=2')).players[0].name, 'Beta');
  assert.equal(db.leaderboard(query('mode=room')).total, 0);
  assert.equal(db.leaderboard(query('mode=campaign')).total, 2);
});
test('old replay does not overwrite a newer display name; identity stays UUID', t => {
  const db = database(t), newer = fixture(); newer.participants[0].name = 'Renamed'; db.ingest(newer);
  const older = fixture(); older.eventId = older.matchId = '00000000-0000-4000-8000-000000000007';
  older.startedAt = new Date(Date.now() - 86400000 * 40 - 60000).toISOString(); older.endedAt = new Date(Date.now() - 86400000 * 40).toISOString(); db.ingest(older);
  assert.equal(db.player(player, query()).profile.name, 'Renamed');
  assert.equal(db.leaderboard(query()).players[0].matches, 2);
  assert.equal(db.leaderboard(query('period=week')).players[0].matches, 1);
  assert.equal(db.leaderboard(query('period=month')).players[0].matches, 1);
});
test('body size, content type, identity forgery and unauthorized writes are rejected', async t => {
  const deps = dependencies(t), result = fixture();
  for (const [headers, status] of [
    [{ Authorization: 'Bearer wrong' }, 401],
    [{ 'X-Blockfield-Server-Id': campaign }, 401],
    [{ 'Content-Type': 'text/plain' }, 415],
    [{ 'Content-Length': String(1_048_577) }, 413],
  ]) assert.equal((await handleStatsRequest(request(result, headers), deps)).status, status);
  assert.equal((await handleStatsRequest(request({ ...result, serverId: campaign }), deps)).status, 403);
  assert.equal(deps.store.leaderboard(query()).total, 0);
});
test('oversized streamed bodies are rejected without trusting Content-Length', async t => {
  const deps = dependencies(t);
  const response = await handleStatsRequest(new Request('https://example.test/api/stats/results', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Blockfield-Server-Id': server, 'Content-Type': 'application/json' },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(700000)); controller.enqueue(new Uint8Array(700000)); controller.close(); } }), duplex: 'half',
  }), deps);
  assert.equal(response.status, 413); assert.equal(deps.store.leaderboard(query()).total, 0);
});
test('read APIs require no game process or producer credentials and distinguish unknown/empty', async t => {
  const deps = dependencies(t);
  assert.equal((await handleStatsRequest(request(null, {}, 'GET', `/players/${player}`), deps)).status, 404);
  const original = fixture();
  const inserted = await handleStatsRequest(request(original), deps); assert.equal(inserted.status, 201);
  const replay = await handleStatsRequest(request(original), deps);
  assert.equal(replay.status, 200);
  const board = await handleStatsRequest(new Request('https://example.test/api/stats/leaderboard'), deps);
  assert.equal(board.status, 200); assert.equal(board.headers.get('cache-control'), 'no-store');
  assert.equal((await board.json()).players.length, 1);
  assert.equal((await handleStatsRequest(new Request(`https://example.test/api/stats/players/${player}`), deps)).status, 200);
});
test('result write and derived rows roll back together on storage failure', t => {
  const db = database(t);
  db.db.exec("CREATE TRIGGER fail_test BEFORE INSERT ON classes BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  assert.throws(() => db.ingest(fixture()), /injected failure/);
  for (const table of ['results', 'participants', 'profiles', 'classes']) assert.equal(db.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});
test('accepted data survives close/reopen with a persistent volume path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-stats-')), path = join(dir, 'stats.sqlite');
  try {
    const original = fixture(), first = new StatsStore(path); first.ingest(original); first.close();
    const second = new StatsStore(path);
    try { assert.equal(second.leaderboard(query()).players[0].kills, 1); assert.equal(second.ingest(original).inserted, false); } finally { second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('pagination/sort inputs are bounded and never become arbitrary SQL', () => {
  for (const value of ['limit=0', 'limit=101', 'page=-1', 'page=1e2', 'page=1001', 'sort=__proto__', 'sort=score;DROP TABLE profiles', 'mode=training', 'period=bad']) assert.throws(() => query(value), StatsError);
});
