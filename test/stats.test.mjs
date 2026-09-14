import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatsStore, StatsError, filters, seasons, validateResult, handleStatsRequest } from '../src/lib/stats.ts';

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
  // One side only: nobody to be rated against, so no MMR operation at all.
  assert.equal(detail.mmr, null); assert.equal(detail.ratingStatus, 'glicko2-v1');
});
test('completed Ranked campaign rates both sides once; replays, stops and matches never rate', t => {
  const db = database(t), blue = '00000000-0000-4000-8000-000000000008';
  const round = fixture(); round.participants.push({ ...structuredClone(round.participants[0]), uuid: blue, name: 'Bravo', team: 'BLUE' });
  db.ingest(round);
  assert.equal(db.player(player, query()).mmr, null); // a round alone is history, not MMR
  const result = { ...round, kind: 'campaign', eventId: campaign, matchId: null, mapId: null, rounds: [id] };
  db.ingest(result); db.ingest(structuredClone(result));
  const winner = db.player(player, query()).mmr, loser = db.player(blue, query()).mmr;
  assert.ok(winner.rating > 1500 && loser.rating < 1500, `${winner.rating} / ${loser.rating}`);
  assert.equal(winner.ratedCampaigns, 1); assert.equal(winner.provisional, true);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM rating_changes').get().n, 2);
  assert.equal(db.leaderboard(query('sort=rating')).players[0].uuid, player);
  const stopped = { ...result, eventId: '00000000-0000-4000-8000-000000000009', campaignSessionId: '00000000-0000-4000-8000-000000000009', endReason: 'stopped', winner: 'NONE' };
  db.ingest(stopped);
  assert.equal(db.player(player, query()).mmr.ratedCampaigns, 1);
  const draw = { ...result, eventId: '00000000-0000-4000-8000-00000000000a', campaignSessionId: '00000000-0000-4000-8000-00000000000a', endReason: 'draw', winner: 'NONE' };
  db.ingest(draw);
  const afterDraw = db.player(player, query());
  assert.equal(afterDraw.mmr.ratedCampaigns, 2); assert.ok(afterDraw.mmr.rating < winner.rating); // stronger side loses points on a draw
  assert.equal(afterDraw.ratingHistory.length, 2);
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

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const get = async (deps, path) => handleStatsRequest(new Request(`https://example.test/api/stats${path}`), deps);
const campaignOf = round => ({ ...round, kind: 'campaign', eventId: campaign, matchId: null, mapId: null, rounds: [id] });
function twoSided() {
  const round = fixture(); round.participants.push({ ...structuredClone(round.participants[0]), uuid: uid(11), name: 'Bravo', team: 'BLUE' });
  return round;
}
test('zero deaths gives a finite K/D and no Infinity/NaN/null kd in JSON', async t => {
  const deps = dependencies(t), result = fixture(); result.participants[0].kills = 3; deps.store.ingest(result);
  for (const path of ['/leaderboard?sort=kd', `/players/${player}`]) {
    const text = await (await get(deps, path)).text();
    assert.ok(!/Infinity|NaN|"kd":null/.test(text), text);
  }
  assert.equal(deps.store.leaderboard(query('sort=kd')).players[0].kd, 3);
  assert.equal(deps.store.player(player, query()).totals.kd, 3);
});
test('a nickname change is shown identically in the leaderboard row and the profile', t => {
  const db = database(t), older = fixture(); older.eventId = older.matchId = uid(20);
  older.startedAt = new Date(Date.now() - 7200000).toISOString(); older.endedAt = new Date(Date.now() - 3600000).toISOString(); db.ingest(older);
  const newer = fixture(); newer.participants[0].name = 'Renamed'; db.ingest(newer);
  const detail = db.player(player, query());
  assert.equal(db.leaderboard(query()).players[0].name, 'Renamed');
  assert.equal(detail.profile.name, 'Renamed'); assert.equal(detail.totals.name, 'Renamed'); assert.equal(db.leaderboard(query()).total, 1);
});
test('kd and rating ties break by UUID; players without MMR sort last on rating', t => {
  const db = database(t), round = fixture();
  for (const [uuid, team] of [[uid(11), 'BLUE'], [uid(12), 'RED'], [uid(13), 'RED']]) round.participants.push({ ...structuredClone(round.participants[0]), uuid, name: uuid.slice(-2), team });
  db.ingest(round);
  assert.deepEqual(db.leaderboard(query('sort=kd')).players.map(p => [p.uuid, p.rank]), [[player, 1], [uid(11), 2], [uid(12), 3], [uid(13), 4]]);
  const summary = campaignOf(round); summary.participants = summary.participants.slice(0, 2); db.ingest(summary);
  assert.deepEqual(db.leaderboard(query('sort=rating')).players.map(p => [p.uuid, p.mmr === null]), [[player, false], [uid(11), false], [uid(12), true], [uid(13), true]]);
  assert.equal(db.player(uid(13), query('sort=rating')).totals.rank, 4);
});
test('season boundaries: start inclusive, 1 ms before excluded, next season start belongs to the next season', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-02-01T00:00:00Z') });
  const deps = dependencies(t);
  for (const [n, at] of [[30, '2026-09-13T23:59:59.999Z'], [31, '2026-09-14T00:00:00.000Z'], [32, '2026-12-31T23:59:59.999Z'], [33, '2027-01-01T00:00:00.000Z']]) {
    deps.store.ingest({ ...fixture(), eventId: uid(n), matchId: uid(n), startedAt: at, endedAt: at });
  }
  assert.deepEqual(seasons(), [
    { id: 's1', name: 'Сезон 1', startsAt: '2026-09-14T00:00:00.000Z', endsAt: '2026-12-31T23:59:59.999Z' },
    { id: 's2', name: 'Сезон 2', startsAt: '2027-01-01T00:00:00.000Z', endsAt: '2027-03-31T23:59:59.999Z' },
  ]);
  assert.deepEqual(seasons(Date.parse('2026-09-13T23:59:59.999Z')), []);
  assert.deepEqual(seasons(Date.parse('2027-04-01T00:00:00Z')).at(-1), { id: 's3', name: 'Сезон 3', startsAt: '2027-04-01T00:00:00.000Z', endsAt: '2027-06-30T23:59:59.999Z' });
  const board = await (await get(deps, '/leaderboard?season=s1')).json();
  assert.equal(board.season, 's1'); assert.equal(board.players[0].matches, 2);
  assert.equal(deps.store.leaderboard(query('season=s2')).players[0].matches, 1);
  assert.equal(deps.store.player(player, query('season=s2')).history.length, 1);
  assert.equal(deps.store.leaderboard(query()).players[0].matches, 4);
  assert.deepEqual(await (await get(deps, '/seasons')).json(), { schemaVersion: 1, current: 's2', seasons: seasons() });
});
test('season with period, unknown or not-yet-started season, and out-of-range pagination are 400', async t => {
  const deps = dependencies(t);
  for (const q of ['season=s1&period=all', 'season=s1&period=week', 'season=s99', 'season=s2', 'season=S1', 'limit=0', 'limit=101', 'page=0', 'page=1001']) {
    assert.equal((await get(deps, `/leaderboard?${q}`)).status, 400, q);
    assert.equal((await get(deps, `/players/${player}?${q}`)).status, 400, q);
  }
  assert.equal((await get(deps, '/leaderboard?season=s1')).status, 200);
});
test('rank follows page offsets; a page past the end is empty with an unchanged total', t => {
  const db = database(t), round = fixture();
  for (const n of [11, 12, 13, 14]) round.participants.push({ ...structuredClone(round.participants[0]), uuid: uid(n), name: `P${n}`, score: n });
  db.ingest(round);
  const all = db.leaderboard(query('limit=100')).players.map(p => p.uuid);
  for (const page of [1, 2, 3]) {
    const board = db.leaderboard(query(`limit=2&page=${page}`));
    board.players.forEach((p, index) => { assert.equal(p.rank, (page - 1) * 2 + index + 1); assert.equal(p.uuid, all[p.rank - 1]); });
  }
  const past = db.leaderboard(query('limit=2&page=9'));
  assert.deepEqual(past.players, []); assert.equal(past.total, 5);
  assert.equal(db.player(uid(11), query('limit=1')).totals.rank, all.indexOf(uid(11)) + 1);
});
test('known profile with a non-matching filter has empty history, not errors or nulls', t => {
  const db = database(t), round = twoSided(); db.ingest(round); db.ingest(campaignOf(round));
  const detail = db.player(player, query('mode=room'));
  assert.equal(detail.totals, null); assert.deepEqual(detail.history, []); assert.deepEqual(detail.classes, []);
  assert.deepEqual({ ...detail.campaigns }, { completed: 0, wins: 0 }); assert.deepEqual(detail.ratingHistory, []);
  assert.ok(detail.mmr); assert.ok(Number.isFinite(Date.parse(detail.checkedAt))); assert.equal(detail.season, null);
});
test('campaign summary before its rounds rates once per participant; late rounds do not change ratings', t => {
  const db = database(t), round = twoSided(), summary = campaignOf(round);
  db.ingest(summary);
  const ratings = () => db.db.prepare('SELECT * FROM ratings ORDER BY uuid').all();
  const changes = () => db.db.prepare('SELECT uuid,COUNT(*) n FROM rating_changes GROUP BY uuid ORDER BY uuid').all().map(r => [r.uuid, r.n]);
  const before = ratings();
  assert.deepEqual(changes(), [[player, 1], [uid(11), 1]]);
  db.ingest(round); db.ingest(summary); db.ingest(round);
  assert.deepEqual(ratings(), before); assert.deepEqual(changes(), [[player, 1], [uid(11), 1]]);
  assert.equal(db.player(player, query()).totals.matches, 1);
});
test('draw campaign rates 0.5 for everyone; stopped campaign with a winner is rejected and never rates', t => {
  const db = database(t), round = twoSided();
  db.ingest({ ...campaignOf(round), endReason: 'draw', winner: 'NONE' });
  assert.deepEqual(db.db.prepare('SELECT DISTINCT score FROM rating_changes').all().map(r => r.score), [0.5]);
  const other = database(t);
  assert.throws(() => other.ingest({ ...campaignOf(round), endReason: 'stopped', winner: 'RED' }), error => error.status === 422);
  assert.equal(other.db.prepare('SELECT COUNT(*) n FROM rating_changes').get().n, 0);
  assert.equal(other.db.prepare('SELECT COUNT(*) n FROM ratings').get().n, 0);
});
