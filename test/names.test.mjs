import test from 'node:test';
import assert from 'node:assert/strict';
import { StatsStore, displayName, filters, handleStatsRequest, resolveNames, uuidLike } from '../src/lib/stats.ts';
import { BALANCE, siteBans } from '../src/lib/admin.ts';
import { BALANCE_GROUPS, BALANCE_DEFAULTS, CLASS_COSTS } from '../src/lib/game-names.ts';
import { settingsBody } from '../src/lib/settings-form.ts';

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const server = uid(1), player = 'fa21daa3-0c6e-31df-b689-b445b9f10ec8';
const row = (uuid, name) => ({ uuid, name, team: 'RED', score: 10, kills: 1, deaths: 0, captures: 0, neutralizations: 0, pointSeconds: 0, playSeconds: 60,
  suicides: 0, teamKills: 0, maxKillstreak: 1, classes: [] });
const match = (n, time, name) => ({ schemaVersion: 1, eventId: uid(n), serverId: server, sessionPurpose: 'gameplay', modeId: 'room', ranked: false, rulesetVersion: '1',
  kind: 'match', matchId: uid(n), campaignSessionId: null, mapId: 'baxmut', startedAt: time, endedAt: time, endReason: 'completed', winner: 'RED', rounds: [], participants: [row(player, name)] });
import { database } from './storage.mjs';
const name = async db => (await db.db.prepare('SELECT name FROM profiles WHERE uuid=?').get(player)).name;

test('uuid-like names are detected with or without dashes and never displayed', () => {
  assert.equal(uuidLike(player), true); assert.equal(uuidLike(player.replaceAll('-', '').toUpperCase()), true);
  assert.equal(uuidLike('Vano5lay'), false);
  assert.equal(displayName(player), 'Неизвестный игрок'); assert.equal(displayName('Vano5lay'), 'Vano5lay');
});

test('ingest: a real name replaces a uuid-like name even from an older result; a uuid-like name never replaces a real one', async t => {
  const db = await database(t);
  await db.ingest(match(20, '2026-09-10T00:00:00Z', player));
  assert.equal(await name(db), player);
  await db.ingest(match(21, '2026-09-01T00:00:00Z', 'Vano5lay'));
  assert.equal(await name(db), 'Vano5lay', 'older real name wins over newer uuid name');
  await db.ingest(match(22, '2026-09-12T00:00:00Z', player));
  assert.equal(await name(db), 'Vano5lay', 'newer uuid name does not erase the real one');
  await db.ingest(match(23, '2026-09-13T00:00:00Z', 'Renamed'));
  assert.equal(await name(db), 'Renamed');
  await db.ingest(match(24, '2026-09-02T00:00:00Z', 'OldName'));
  assert.equal(await name(db), 'Renamed', 'an older real name still does not replace a newer real name');
});

test('Drasl resolves uuid-like names into profiles; misses and slow lookups show «Неизвестный игрок»', async t => {
  const db = await database(t);
  await db.ingest(match(20, '2026-09-10T00:00:00Z', player));
  const urls = [];
  const drasl = async url => { urls.push(String(url)); return Response.json({ id: player.replaceAll('-', ''), name: 'Vano5lay' }); };
  assert.deepEqual([...await resolveNames(db, [player], 1500, drasl)], [[player, 'Vano5lay']]);
  assert.match(urls[0], /\/session\/minecraft\/profile\/fa21daa30c6e31dfb689b445b9f10ec8$/);
  assert.equal(await name(db), 'Vano5lay');
  assert.equal((await resolveNames(db, [player], 1500, drasl)).size, 0, 'already named: no lookup');
  assert.equal(urls.length, 1);

  const other = await database(t);
  const slow = { ...match(30, '2026-09-10T00:00:00Z', uid(77)), participants: [row(uid(77), uid(77))] };
  await other.ingest(slow);
  let release;
  const started = Date.now();
  const found = await resolveNames(other, [uid(77)], 50, () => new Promise(resolve => { release = () => resolve(Response.json({ name: 'LateName' })); }));
  assert.equal(found.size, 0); assert.ok(Date.now() - started < 1000, 'render is not blocked past the budget');
  release(); await new Promise(r => setTimeout(r, 20));
  assert.equal((await other.db.prepare('SELECT name FROM profiles WHERE uuid=?').get(uid(77))).name, 'LateName', 'late lookup still caches the name');

  const board = await database(t);
  await board.ingest({ ...match(40, '2026-09-10T00:00:00Z', uid(88)), participants: [row(uid(88), uid(88))] });
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('', { status: 204 });
  const response = await handleStatsRequest(new Request('https://example.test/api/stats/leaderboard'), { store: board, keys: {} });
  assert.equal((await response.json()).players[0].name, 'Неизвестный игрок');
  assert.equal((await board.leaderboard(filters(new URLSearchParams()))).players[0].uuid, uid(88), 'the link to the player page keeps the uuid');
  assert.equal((await board.results(null, 1)).results[0].players[0].name, 'Неизвестный игрок');
});

test('admin: banned list comes from successful site bans, pardons remove them', async t => {
  const db = await database(t), actor = { actorUuid: 'a', actorName: 'NetherG', role: 'owner' };
  await db.audit({ ...actor, action: 'rcon:ban', target: 'Bob', detail: { player: 'Bob', reason: 'читы' }, ok: true });
  await db.audit({ ...actor, action: 'rcon:ban', target: 'Eve', detail: { player: 'Eve' }, ok: false, error: 'x' });
  await db.audit({ ...actor, action: 'rcon:ban', target: 'Ann', detail: { player: 'Ann' }, ok: true });
  await db.audit({ ...actor, action: 'rcon:pardon', target: 'ann', detail: { player: 'ann' }, ok: true });
  assert.deepEqual((await siteBans(db)).map(({ at, ...b }) => b), [{ player: 'Bob', by: 'NetherG', reason: 'читы' }]);
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
  const empty = { pvpEnabled: '', lobby: { pvpCooldownSeconds: '' }, rooms: { maxRooms: '' }, deathmatch: { minPlayers: '' }, lockedClasses: [], hadLocks: false, balance: { '*': {} } };
  assert.deepEqual(settingsBody(3, empty), { expectedRevision: 3 });
  assert.deepEqual(settingsBody(3, { ...empty, pvpEnabled: 'false', rooms: { maxRooms: '4' }, deathmatch: { minPlayers: '3' }, hadLocks: true, balance: { South: { max_tickets: 150 } } }),
    { expectedRevision: 3, lobby: { pvpEnabled: false }, rooms: { maxRooms: 4 }, deathmatch: { minPlayers: 3 }, classLocks: [], campaignBalance: { South: { max_tickets: 150 } } });
});

test('settings form: a field prefilled with (and left at) its default is the same as leaving it empty', () => {
  const form = { pvpEnabled: '', lobby: {}, rooms: { maxRooms: '2' }, deathmatch: { minPlayers: '2' }, lockedClasses: [], hadLocks: false, balance: { '*': {} } };
  assert.deepEqual(settingsBody(3, form, { maxRooms: '2', minPlayers: '2' }), { expectedRevision: 3 }, 'prefilled defaults, untouched, write nothing');
  assert.deepEqual(settingsBody(3, { ...form, rooms: { maxRooms: '5' } }, { maxRooms: '2', minPlayers: '2' }),
    { expectedRevision: 3, rooms: { maxRooms: 5 } }, 'only the changed field is written; the untouched default is still omitted');
  const withPvp = { maxRooms: '2', minPlayers: '2', pvpEnabled: 'true' };
  assert.deepEqual(settingsBody(3, { ...form, pvpEnabled: 'true' }, withPvp), { expectedRevision: 3 }, 'PvP prefilled at its default is also omitted');
  assert.deepEqual(settingsBody(3, { ...form, pvpEnabled: 'false' }, withPvp), { expectedRevision: 3, lobby: { pvpEnabled: false } });
});

test('class cost form retains zero and unchanged prices on every save', () => {
  assert.deepEqual(CLASS_COSTS, { tech: 300, sniper: 300, drone: 300 });
  const form = { pvpEnabled: '', lobby: {}, rooms: {}, deathmatch: {}, lockedClasses: [], hadLocks: false, balance: {}, classCosts: { tech: '0', sniper: '90', drone: '120' } };
  assert.deepEqual(settingsBody(8, form).classCosts, { tech: 0, sniper: 90, drone: 120 });
});
