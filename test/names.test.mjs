import test from 'node:test';
import assert from 'node:assert/strict';
import { StatsStore, displayName, filters, handleStatsRequest, resolveNames, uuidLike } from '../src/lib/stats.ts';
import { BALANCE, siteBans } from '../src/lib/admin.ts';
import { BALANCE_GROUPS, BALANCE_DEFAULTS } from '../src/lib/game-names.ts';
import { settingsBody } from '../src/lib/settings-form.ts';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const server = uid(1), player = 'fa21daa3-0c6e-31df-b689-b445b9f10ec8';
const row = (uuid, name) => ({ uuid, name, team: 'RED', score: 10, kills: 1, deaths: 0, captures: 0, neutralizations: 0, pointSeconds: 0, playSeconds: 60,
  suicides: 0, teamKills: 0, maxKillstreak: 1, classes: [] });
const match = (n, time, name) => ({ schemaVersion: 1, eventId: uid(n), serverId: server, sessionPurpose: 'gameplay', modeId: 'room', ranked: false, rulesetVersion: '1',
  kind: 'match', matchId: uid(n), campaignSessionId: null, mapId: 'baxmut', startedAt: time, endedAt: time, endReason: 'completed', winner: 'RED', rounds: [], participants: [row(player, name)] });
function database(t) { const store = new StatsStore(':memory:'); t.after(() => store.close()); return store; }
const name = db => db.db.prepare('SELECT name FROM profiles WHERE uuid=?').get(player).name;

test('uuid-like names are detected with or without dashes and never displayed', () => {
  assert.equal(uuidLike(player), true); assert.equal(uuidLike(player.replaceAll('-', '').toUpperCase()), true);
  assert.equal(uuidLike('Vano5lay'), false);
  assert.equal(displayName(player), 'Неизвестный игрок'); assert.equal(displayName('Vano5lay'), 'Vano5lay');
});

test('ingest: a real name replaces a uuid-like name even from an older result; a uuid-like name never replaces a real one', t => {
  const db = database(t);
  db.ingest(match(20, '2026-09-10T00:00:00Z', player));
  assert.equal(name(db), player);
  db.ingest(match(21, '2026-09-01T00:00:00Z', 'Vano5lay'));
  assert.equal(name(db), 'Vano5lay', 'older real name wins over newer uuid name');
  db.ingest(match(22, '2026-09-12T00:00:00Z', player));
  assert.equal(name(db), 'Vano5lay', 'newer uuid name does not erase the real one');
  db.ingest(match(23, '2026-09-13T00:00:00Z', 'Renamed'));
  assert.equal(name(db), 'Renamed');
  db.ingest(match(24, '2026-09-02T00:00:00Z', 'OldName'));
  assert.equal(name(db), 'Renamed', 'an older real name still does not replace a newer real name');
});

test('Drasl resolves uuid-like names into profiles; misses and slow lookups show «Неизвестный игрок»', async t => {
  const db = database(t);
  db.ingest(match(20, '2026-09-10T00:00:00Z', player));
  const urls = [];
  const drasl = async url => { urls.push(String(url)); return Response.json({ id: player.replaceAll('-', ''), name: 'Vano5lay' }); };
  assert.deepEqual([...await resolveNames(db, [player], 1500, drasl)], [[player, 'Vano5lay']]);
  assert.match(urls[0], /\/session\/minecraft\/profile\/fa21daa30c6e31dfb689b445b9f10ec8$/);
  assert.equal(name(db), 'Vano5lay');
  assert.equal((await resolveNames(db, [player], 1500, drasl)).size, 0, 'already named: no lookup');
  assert.equal(urls.length, 1);

  const other = database(t);
  const slow = { ...match(30, '2026-09-10T00:00:00Z', uid(77)), participants: [row(uid(77), uid(77))] };
  other.ingest(slow);
  let release;
  const started = Date.now();
  const found = await resolveNames(other, [uid(77)], 50, () => new Promise(resolve => { release = () => resolve(Response.json({ name: 'LateName' })); }));
  assert.equal(found.size, 0); assert.ok(Date.now() - started < 1000, 'render is not blocked past the budget');
  release(); await new Promise(r => setTimeout(r, 20));
  assert.equal(other.db.prepare('SELECT name FROM profiles WHERE uuid=?').get(uid(77)).name, 'LateName', 'late lookup still caches the name');

  const board = database(t);
  board.ingest({ ...match(40, '2026-09-10T00:00:00Z', uid(88)), participants: [row(uid(88), uid(88))] });
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('', { status: 204 });
  const response = await handleStatsRequest(new Request('https://example.test/api/stats/leaderboard'), { store: board, keys: {} });
  assert.equal((await response.json()).players[0].name, 'Неизвестный игрок');
  assert.equal(board.leaderboard(filters(new URLSearchParams())).players[0].uuid, uid(88), 'the link to the player page keeps the uuid');
  assert.equal(board.results(null, 1).results[0].players[0].name, 'Неизвестный игрок');
});

test('admin: banned list comes from successful site bans, pardons remove them', t => {
  const db = database(t), actor = { actorUuid: 'a', actorName: 'NetherG', role: 'owner' };
  db.audit({ ...actor, action: 'rcon:ban', target: 'Bob', detail: { player: 'Bob', reason: 'читы' }, ok: true });
  db.audit({ ...actor, action: 'rcon:ban', target: 'Eve', detail: { player: 'Eve' }, ok: false, error: 'x' });
  db.audit({ ...actor, action: 'rcon:ban', target: 'Ann', detail: { player: 'Ann' }, ok: true });
  db.audit({ ...actor, action: 'rcon:pardon', target: 'ann', detail: { player: 'ann' }, ok: true });
  assert.deepEqual(siteBans(db).map(({ at, ...b }) => b), [{ player: 'Bob', by: 'NetherG', reason: 'читы' }]);
});

test('every balance key has a Russian label and a default', () => {
  const labelled = BALANCE_GROUPS.flatMap(g => g.fields.map(f => f.key));
  assert.deepEqual([...labelled].sort(), Object.keys(BALANCE).sort());
  for (const scope of Object.values(BALANCE_DEFAULTS)) assert.deepEqual(Object.keys(scope).sort(), Object.keys(BALANCE).sort());
});

test('balance defaults follow the mod: no file sets min_players_per_team, CampaignConfig defaults to 1', () => {
  for (const scope of Object.values(BALANCE_DEFAULTS)) assert.equal(scope.min_players_per_team, 1);
  assert.equal(BALANCE_DEFAULTS.South.max_tickets, 100); assert.equal(BALANCE_DEFAULTS.Center.max_tickets, 500);
});

test('settings form: untouched fields, including PvP, are not written; explicit values are', () => {
  const empty = { pvpEnabled: '', lobby: { pvpCooldownSeconds: '' }, rooms: { maxRooms: '' }, lockedClasses: [], hadLocks: false, balance: { '*': {} } };
  assert.deepEqual(settingsBody(3, empty), { expectedRevision: 3 });
  assert.deepEqual(settingsBody(3, { ...empty, pvpEnabled: 'false', rooms: { maxRooms: '4' }, hadLocks: true, balance: { South: { max_tickets: 150 } } }),
    { expectedRevision: 3, lobby: { pvpEnabled: false }, rooms: { maxRooms: 4 }, classLocks: [], campaignBalance: { South: { max_tickets: 150 } } });
});
