import test from 'node:test';
import assert from 'node:assert/strict';
import { StatsStore, filters, handleStatsRequest } from '../src/lib/stats.ts';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const server = uid(1), red = uid(3), blue = uid(11), query = (text = '') => filters(new URLSearchParams(text));
function database(t) { const store = new StatsStore(':memory:'); t.after(() => store.close()); return store; }
const row = (uuid, name, team) => ({ uuid, name, team, score: 10, kills: 1, deaths: 1, captures: 0, neutralizations: 0, pointSeconds: 0, playSeconds: 60,
  suicides: 0, teamKills: 0, maxKillstreak: 1, classes: [] });
const base = (n, time) => ({ schemaVersion: 1, eventId: uid(n), serverId: server, sessionPurpose: 'gameplay', modeId: 'campaign', ranked: true, rulesetVersion: '1',
  startedAt: time, endedAt: time, endReason: 'completed', participants: [row(red, 'Alpha', 'RED'), row(blue, 'Bravo', 'BLUE')] });
const match = (n, time) => ({ ...base(n, time), kind: 'match', matchId: uid(n), campaignSessionId: uid(n + 1000), mapId: 'test', rounds: [], winner: 'RED' });
const campaign = (n, time, winner) => ({ ...base(n, time), kind: 'campaign', matchId: null, mapId: null, campaignSessionId: uid(n), rounds: [uid(n + 500)], winner });
const ratings = db => db.db.prepare('SELECT * FROM ratings ORDER BY season_id,uuid').all().map(r => ({ ...r }));
const changes = db => db.db.prepare('SELECT * FROM rating_changes ORDER BY season_id,rated_at,uuid').all().map(r => ({ ...r }));

test('void removes a match from leaderboard, player history and classes; restore brings it back', t => {
  const db = database(t);
  db.ingest(match(20, '2026-09-01T00:00:00Z')); db.ingest(match(21, '2026-09-02T00:00:00Z'));
  assert.equal(db.leaderboard(query()).players[0].matches, 2);
  assert.deepEqual(db.setVoided(server, uid(20), 'Adm'), { rebuilt: null });
  assert.equal(db.leaderboard(query()).players[0].matches, 1);
  assert.deepEqual(db.player(red, query()).history.map(h => h.eventId), [uid(21)]);
  assert.equal(db.results(null, 1).results.find(r => r.eventId === uid(20)).voidedBy, 'Adm');
  assert.throws(() => db.setVoided(server, uid(20), 'Adm'), e => e.status === 409);
  assert.equal(db.ingest(match(20, '2026-09-01T00:00:00Z')).inserted, false, 'a producer replay does not un-void');
  assert.equal(db.leaderboard(query()).players[0].matches, 1);
  db.setVoided(server, uid(20), null);
  assert.equal(db.leaderboard(query()).players[0].matches, 2);
  assert.throws(() => db.setVoided(server, uid(99), 'Adm'), e => e.status === 404);
});

test('voiding a rated campaign rebuilds that season and later ones; restore equals the original ingest', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-02-01T00:00:00Z') });
  const db = database(t);
  const list = [campaign(40, '2026-10-01T00:00:00Z', 'RED'), campaign(41, '2026-11-01T00:00:00Z', 'BLUE'), campaign(42, '2026-12-01T00:00:00Z', 'RED'), campaign(43, '2027-01-10T00:00:00Z', 'BLUE')];
  for (const result of list) db.ingest(result);
  const originalRatings = ratings(db), originalChanges = changes(db);

  const reference = database(t);
  for (const result of list.filter(r => r.eventId !== uid(41))) reference.ingest(result);
  assert.deepEqual(db.setVoided(server, uid(41), 'Adm'), { rebuilt: 's1' });
  assert.deepEqual(ratings(db), ratings(reference), 'void = as if the campaign never arrived, including the s2 carry-over');
  assert.deepEqual(changes(db), changes(reference));
  assert.equal(db.player(red, query('season=s1')).mmr.ratedCampaigns, 2);

  db.setVoided(server, uid(41), null);
  assert.deepEqual(ratings(db), originalRatings); assert.deepEqual(changes(db), originalChanges);
});

test('DB ingest keys: accepted until revoked, only hashes are stored, env keys keep working', async t => {
  const db = database(t), envToken = 'env-token-not-a-secret-00000000000000';
  const key = db.createIngestKey(server, 'lobby');
  assert.ok(!JSON.stringify(db.db.prepare('SELECT * FROM ingest_keys').all()).includes(key));
  assert.deepEqual(db.ingestKeys().map(k => [k.serverId, k.label, k.revokedAt]), [[server, 'lobby', null]]);
  const post = (token, n, serverId = server) => handleStatsRequest(new Request('https://example.test/api/stats/results', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Blockfield-Server-Id': serverId }, body: JSON.stringify(match(n, '2026-09-01T00:00:00Z')) }),
  { store: db, keys: { [uid(2)]: [envToken] } });
  assert.equal((await post(key, 30)).status, 201);
  assert.equal((await post(key, 31, uid(2))).status, 401, 'a DB key is bound to its server');
  assert.equal((await post(envToken, 32, uid(2))).status, 403, 'env key still authenticates (body is for another server)');
  assert.equal(db.revokeIngestKey(db.ingestKeys()[0].id), true);
  assert.equal(db.revokeIngestKey(db.ingestKeys()[0].id), false);
  assert.equal((await post(key, 33)).status, 401);
});

test('schema 3 file upgrades to 4: results gain void columns, new tables appear, data and ratings stay', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'bf-migrate-v4-'));
  try {
    const path = join(directory, 'stats.sqlite'), result = campaign(50, '2026-09-01T00:00:00Z', 'RED');
    const first = new StatsStore(path); first.ingest(result); const before = ratings(first); first.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`DROP TABLE admin_audit; DROP TABLE ingest_keys; DROP TABLE staff_roles;
      ALTER TABLE results DROP COLUMN voided_at; ALTER TABLE results DROP COLUMN voided_by; PRAGMA user_version=3;`);
    legacy.close();
    const upgraded = new StatsStore(path);
    try {
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.deepEqual(ratings(upgraded), before);
      assert.equal(upgraded.ingest(result).inserted, false);
      assert.deepEqual(upgraded.setVoided(server, uid(50), 'Adm'), { rebuilt: 's1' });
      assert.equal(upgraded.db.prepare('SELECT COUNT(*) n FROM ratings').get().n, 0);
      upgraded.audit({ actorUuid: 'a', actorName: 'Adm', role: 'admin', action: 'x', ok: true }); upgraded.setStaff('b'.repeat(32), 'Bob', 'builder', 'Adm');
    } finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('audit entries are stored newest first and capped', t => {
  const db = database(t);
  for (let i = 0; i < 205; i++) db.audit({ actorUuid: 'a', actorName: 'Adm', role: 'admin', action: `a${i}`, detail: { i }, ok: i % 2 === 0, error: i % 2 ? 'x' : null });
  const log = db.auditLog();
  assert.equal(log.length, 200); assert.equal(log[0].action, 'a204'); assert.equal(JSON.parse(log[0].detail).i, 204); assert.equal(log[1].ok, 0);
});

test('review: voiding a campaign that ends minutes ahead, in the next season, rebuilds without a 500', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-12-31T23:58:00Z') });
  const db = database(t);
  db.ingest(campaign(60, '2027-01-01T00:01:00.000Z', 'RED'));
  assert.equal(db.player(red, query()).mmrSeason, 's1');
  assert.deepEqual(db.setVoided(server, uid(60), 'Adm'), { rebuilt: 's2' });
  assert.deepEqual(db.setVoided(server, uid(60), null), { rebuilt: 's2' });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM ratings WHERE season_id='s2'").get().n, 2);
});

test('review: audit detail is capped at 2 KB and the table keeps the newest 10 000 rows', t => {
  const db = database(t);
  db.audit({ actorUuid: 'a', actorName: 'Adm', role: 'admin', action: 'big', detail: { x: 'y'.repeat(70000) }, ok: true });
  assert.ok(db.auditLog(1)[0].detail.length <= 2049);
  db.db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10005) INSERT INTO admin_audit (at,actor_uuid,actor_name,role,action,ok) SELECT i,\'a\',\'A\',\'admin\',\'seed\',1 FROM n');
  db.audit({ actorUuid: 'a', actorName: 'Adm', role: 'admin', action: 'last', ok: true });
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM admin_audit').get().n, 10000);
  assert.equal(db.auditLog(1)[0].action, 'last');
});
