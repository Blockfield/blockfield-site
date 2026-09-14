import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectedByServer, can, checkRoleChange, devUser, handleAdmin, owners, playerId, rconCommand, roleOf, saveSettings, validateSettings, workshopMembers, writeRequest } from '../src/lib/admin.ts';
import { StatsStore } from '../src/lib/stats.ts';

const OWNER = 'e10438e4797b49718cfecec6a8fa171b', ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', MOD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', OTHER = 'cccccccccccccccccccccccccccccccc';
const status = (error) => error instanceof Response ? error.status : assert.fail(`expected Response, got ${error}`);
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'bf-admin-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const store = (t) => { const s = new StatsStore(':memory:'); t.after(() => s.close()); return s; };

test('permission map: roles grow strictly, unknown/no role has nothing', () => {
  assert.equal(can('builder', 'view'), true); assert.equal(can('builder', 'moderate'), false);
  assert.equal(can('moderator', 'mode'), true); assert.equal(can('moderator', 'recover'), false); assert.equal(can('moderator', 'ban'), false);
  assert.equal(can('admin', 'settings'), true); assert.equal(can('admin', 'roles'), true); assert.equal(can('admin', 'roles-admin'), false);
  assert.equal(can('owner', 'roles-admin'), true);
  assert.equal(can(null, 'view'), false); assert.equal(can('root', 'view'), false);
});

test('bootstrap fails closed: no env and no rows means nobody; owners come only from env', t => {
  const s = store(t);
  assert.equal(owners(undefined).size, 0); assert.equal(owners('').size, 0);
  assert.equal(roleOf(OWNER, s, owners(undefined)), null);
  assert.deepEqual([...owners(`e10438e4-797b-4971-8cfe-cec6a8fa171b, junk,${ADMIN.toUpperCase()}`)], [OWNER, ADMIN]);
  assert.equal(roleOf(OWNER, s, owners(OWNER)), 'owner');
  s.setStaff(MOD, 'Mod', 'moderator', 'x'); s.setStaff(OTHER, 'Evil', 'owner', 'x');
  assert.equal(roleOf(MOD, s, new Set()), 'moderator');
  assert.equal(roleOf(OTHER, s, new Set()), null, 'a stored owner row is not an owner');
  assert.equal(playerId('E10438E4-797B-4971-8CFE-CEC6A8FA171B'), OWNER); assert.equal(playerId('nope'), null);
});

test('role change rules: admin manages builder/moderator only, no self change, owners immutable', () => {
  const ids = new Set([OWNER]), admin = { uuid: ADMIN, name: 'Adm', role: 'admin' }, owner = { uuid: OWNER, name: 'Own', role: 'owner' };
  checkRoleChange(admin, MOD, null, 'moderator', ids);
  checkRoleChange(admin, MOD, 'moderator', null, ids);
  for (const [actor, target, from, to] of [
    [admin, MOD, null, 'admin'], [admin, MOD, 'admin', null], [admin, ADMIN, 'admin', 'builder'], [owner, OWNER, 'owner', null],
    [owner, OWNER, 'owner', 'admin'], [owner, MOD, null, 'owner'], [{ uuid: MOD, name: 'M', role: 'moderator' }, OTHER, null, 'builder'],
  ]) assert.throws(() => checkRoleChange(actor, target, from, to, ids), e => status(e) === 403);
  checkRoleChange(owner, ADMIN, 'admin', null, ids); checkRoleChange(owner, MOD, null, 'admin', ids);
});

test('workshop members mapping: owner/admin→admin, moderator→lead, builder→builder', () => {
  const members = workshopMembers([{ uuid: MOD, name: 'Mod', role: 'moderator' }, { uuid: ADMIN, name: 'Adm', role: 'admin' }, { uuid: OTHER, name: 'Bob', role: 'builder' }], new Map([[OWNER, 'Nether']]));
  assert.deepEqual(members, [
    { draslId: ADMIN, name: 'Adm', role: 'admin' }, { draslId: MOD, name: 'Mod', role: 'lead' },
    { draslId: OTHER, name: 'Bob', role: 'builder' }, { draslId: OWNER, name: 'Nether', role: 'admin' },
  ]);
});

test('inbox request is validated and written atomically as <id>.json', t => {
  const dir = temp(t), lead = { uuid: MOD, name: 'Mod', role: 'moderator' }, admin = { uuid: ADMIN, name: 'Adm', role: 'admin' };
  const id = writeRequest(dir, lead, { kind: 'mode', profile: 'workshop', expectedRevision: 3 });
  assert.deepEqual(readdirSync(dir), [`${id}.json`], 'no temp file is left behind');
  const request = JSON.parse(readFileSync(join(dir, `${id}.json`)));
  assert.deepEqual({ ...request, createdAt: 0 }, { schema: 1, id, kind: 'mode', actor: { draslId: MOD, name: 'Mod' }, createdAt: 0, profile: 'workshop', expectedRevision: 3 });
  for (const [actor, body, code] of [
    [lead, { kind: 'mode', profile: 'game', expectedRevision: 3, recover: true }, 403],
    [admin, { kind: 'mode', profile: 'workshop', expectedRevision: 3, recover: true }, 400],
    [admin, { kind: 'mode', profile: 'maintenance', expectedRevision: 3 }, 400],
    [admin, { kind: 'mode', profile: 'game' }, 400],
    [admin, { kind: 'message', message: 'x'.repeat(201) }, 400],
    [admin, { kind: 'members', members: [{ draslId: 'bad', name: 'Bob', role: 'admin' }] }, 400],
    [admin, { kind: 'shell' }, 400],
  ]) assert.throws(() => writeRequest(dir, actor, body), e => status(e) === code, JSON.stringify(body));
  writeRequest(dir, admin, { kind: 'mode', profile: 'game', expectedRevision: 0, recover: true });
  assert.equal(readdirSync(dir).length, 2);
});

test('settings validation and optimistic revision conflict', t => {
  const dir = temp(t);
  const first = saveSettings(dir, { expectedRevision: 0, lobby: { pvpEnabled: true, pvpCooldownSeconds: 30 }, classLocks: ['sniper'], campaignBalance: { '*': { max_tickets: 300, enable_spawn_shield: false } } }, 'Adm');
  assert.equal(first.revision, 1); assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'))).updatedBy, 'Adm');
  assert.throws(() => saveSettings(dir, { expectedRevision: 0, rooms: { maxRooms: 2 } }, 'Other'), e => status(e) === 409);
  assert.equal(saveSettings(dir, { expectedRevision: 1, rooms: { maxRooms: 2 } }, 'Adm').revision, 2);
  for (const body of [
    { lobby: { pvpCooldownSeconds: 601 } }, { lobby: { pvp: true } }, { rooms: { maxRooms: 0 } }, { rooms: { idleCloseSeconds: 29.5 } },
    { classLocks: ['Sniper'] }, { classLocks: ['a', 'a'] }, { campaignBalance: { '*': { rm_rf: 1 } } }, { campaignBalance: { '*': { enable_spawn_shield: 1 } } },
    { campaignBalance: { 'bad id!': { max_tickets: 1 } } }, { campaignBalance: { '*': { max_tickets: Infinity } } }, { extra: 1 },
  ]) assert.throws(() => validateSettings(body), e => status(e) === 400, JSON.stringify(body));
});

test('RCON allowlist builds exact commands and rejects injection', () => {
  const room = '0f8e0c3a-1b2c-4d5e-8f90-123456789abc';
  assert.deepEqual(rconCommand({ action: 'kick', player: 'Bob_1', reason: 'spam\nstop' }).commands, ['kick Bob_1 spam stop']);
  assert.deepEqual(rconCommand({ action: 'say', text: 'Рестарт через §c5 минут' }).commands, ['say Рестарт через c5 минут']);
  assert.deepEqual(rconCommand({ action: 'stop-room', roomId: room, outcome: 'RED', reason: 'тест' }).commands, [`bf stop room ${room} win RedTeam тест`]);
  assert.deepEqual(rconCommand({ action: 'stop-room', roomId: room, outcome: 'draw' }).commands, [`bf stop room ${room} draw`]);
  assert.deepEqual(rconCommand({ action: 'stop-room', roomId: room, outcome: 'none', reason: 'window' }).commands, [`bf stop room ${room} window`]);
  assert.deepEqual(rconCommand({ action: 'interrupt', reason: 'авария' }).commands, ['bf maintenance interrupt', 'bf maintenance interrupt confirm авария']);
  assert.deepEqual(rconCommand({ action: 'class-unlock', classId: 'sniper' }).commands, ['bf class unlock sniper']);
  assert.equal(rconCommand({ action: 'ban', player: 'Bob' }).permission, 'ban');
  for (const body of [
    { action: 'kick', player: 'Bob\nstop' }, { action: 'kick', player: 'Bob Smith' }, { action: 'ban', player: '@a' }, { action: 'say', text: '/op x' },
    { action: 'say', text: '  /op x' }, { action: 'say', text: '' }, { action: 'say', text: 'x'.repeat(121) }, { action: 'op', player: 'Bob' },
    { action: 'stop-room', roomId: `${room} ; stop`, outcome: 'none' }, { action: 'stop-room', roomId: room, outcome: 'none', reason: 'draw now' },
    { action: 'stop-room', roomId: room, outcome: 'GREEN' }, { action: 'class-lock', classId: 'sniper forced' }, { action: 'range', op: 'delete' },
    { action: 'interrupt' }, { action: 'team-kick', player: 'ab' },
  ]) assert.throws(() => rconCommand(body), e => status(e) === 400, JSON.stringify(body));
});

test('dev escape hatch is off in production and needs a valid uuid:name', () => {
  assert.deepEqual(devUser({ BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether` }), { uuid: OWNER, name: 'Nether' });
  assert.equal(devUser({ NODE_ENV: 'production', BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether` }), null);
  assert.equal(devUser({ BLOCKFIELD_ADMIN_DEV_USER: 'nope:Nether' }), null);
});

test('API: role gate, audit of success and refusal, members request on role change', async t => {
  const dirs = { BLOCKFIELD_ADMIN_DIR: temp(t), BLOCKFIELD_INBOX_DIR: temp(t), BLOCKFIELD_SETTINGS_DIR: temp(t) };
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' });
  delete process.env.BLOCKFIELD_RCON_HOST;
  const s = store(t);
  s.setStaff(ADMIN, 'Adm', 'admin', 'seed');
  const call = async (as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as;
    const url = new URL(`http://site/api/admin/${path}`);
    const request = new Request(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path.split('?')[0], s).then(r => r, e => e);
  };
  assert.equal((await (await call(`${OTHER}:Nobody`, 'GET', 'me')).json()).role, null);
  assert.equal((await call(`${OTHER}:Nobody`, 'GET', 'overview')).status, 403);
  assert.equal((await call(`${ADMIN}:Adm`, 'GET', 'audit')).status, 200);

  mkdirSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'results'));
  // Owner names resolve through Drasl; stub it so the members request can be built offline.
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => String(url).includes(`/session/minecraft/profile/${OWNER}`) ? Response.json({ id: OWNER, name: 'Nether' })
    : String(url).endsWith('/Moddy') ? Response.json({ id: MOD, name: 'Moddy' }) : new Response('', { status: 404 });

  assert.equal((await call(`${ADMIN}:Adm`, 'POST', 'staff', { name: 'Moddy', role: 'admin' })).status, 403);
  const granted = await call(`${ADMIN}:Adm`, 'POST', 'staff', { name: 'Moddy', role: 'moderator' });
  assert.equal(granted.status, 200);
  const { sync } = await granted.json();
  const request = JSON.parse(readFileSync(join(dirs.BLOCKFIELD_INBOX_DIR, `${sync.id}.json`)));
  assert.deepEqual(request.members, [{ draslId: ADMIN, name: 'Adm', role: 'admin' }, { draslId: MOD, name: 'Moddy', role: 'lead' }, { draslId: OWNER, name: 'Nether', role: 'admin' }]);
  assert.equal((await call(`${MOD}:Moddy`, 'POST', 'rcon', { action: 'ban', player: 'Bob' })).status, 403);
  assert.equal((await call(`${MOD}:Moddy`, 'POST', 'rcon', { action: 'kick', player: 'Bob\nstop' })).status, 400);
  assert.equal((await call(`${ADMIN}:Adm`, 'POST', 'staff', { uuid: ADMIN, role: null })).status, 403);

  const log = (await (await call(`${OWNER}:Nether`, 'GET', 'audit')).json()).entries;
  assert.deepEqual(log.map(e => [e.actorName, e.action, e.ok, e.error !== null]), [
    ['Adm', 'role-revoke', 0, true], ['Moddy', 'rcon:kick', 0, true], ['Moddy', 'rcon:ban', 0, true],
    ['Adm', 'role-grant', 1, false], ['Adm', 'role-grant', 0, true],
  ]);
  assert.equal(log[3].target, MOD); assert.equal(JSON.parse(log[3].detail).role, 'moderator');
});

test('review: range goes through /bf, Brigadier rejections are detected', () => {
  assert.deepEqual(rconCommand({ action: 'range', op: 'close' }).commands, ['bf range close']);
  for (const reply of ['Unknown or incomplete command, see below for error', 'Unknown command', 'range close<--[HERE]']) assert.equal(rejectedByServer(reply), true, reply);
  assert.equal(rejectedByServer('[BlockField] Полигон закрыт, выведено игроков: 0'), false);
});

test('review: message strips exactly Cc and §, keeps ZWJ emoji, counts code points', t => {
  const dir = temp(t), actor = { uuid: MOD, name: 'Mod', role: 'moderator' }, family = '👨\u200d👩\u200d👧';
  const id = writeRequest(dir, actor, { kind: 'message', message: `  §cРаботы\n\u0085${family}\t ` });
  assert.equal(JSON.parse(readFileSync(join(dir, `${id}.json`))).message, `cРаботы${family}`);
  writeRequest(dir, actor, { kind: 'message', message: '😀'.repeat(200) });
  assert.throws(() => writeRequest(dir, actor, { kind: 'message', message: 'x'.repeat(201) }), e => status(e) === 400);
});

test('review: balance types, per-key ranges and merged cross-checks match the mod', () => {
  validateSettings({ campaignBalance: { '*': { max_tickets: 100000, score_per_obj_sec: 0.5, base_warn_radius: 50, base_kill_radius: 40, ready_timeout_seconds: 10 }, desert: { max_players_per_team: 8 } } });
  for (const balance of [
    { '*': { max_tickets: 0 } }, { '*': { max_tickets: 1.5 } }, { '*': { ready_timeout_seconds: 9 } }, { '*': { spawn_shield_duration_seconds: 61 } },
    { '*': { score_per_obj_sec: 1000.5 } }, { '*': { enable_spawn_shield: 'true' } }, { '*': { shuffle_teams_between_rounds: 1 } },
    { '*': { min_players_per_team: 5, max_players_per_team: 4 } }, { '*': { min_players_per_team: 5 }, desert: { max_players_per_team: 4 } },
    { '*': { base_warn_radius: 30 }, desert: { base_kill_radius: 31 } },
  ]) assert.throws(() => validateSettings({ campaignBalance: balance }), e => status(e) === 400, JSON.stringify(balance));
});

test('review: non-staff are refused before the body is read and never audited; RCON errors hide addresses', async t => {
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test', BLOCKFIELD_RCON_HOST: '127.0.0.1', BLOCKFIELD_RCON_PORT: '1', BLOCKFIELD_RCON_PASSWORD: 'x' });
  const s = store(t);
  let read = false;
  const call = (as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as;
    const url = new URL(`http://site/api/admin/${path}`);
    const request = new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    Object.defineProperty(request, 'body', { get() { read = true; return null; } });
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, s).then(r => r, e => e);
  };
  assert.equal((await call(`${OTHER}:Nobody`, 'PUT', 'settings', { expectedRevision: 0, x: 'y'.repeat(60000) })).status, 403);
  assert.equal(read, false); assert.equal(s.auditLog().length, 0);
  const failed = await handleAdmin((() => { process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OWNER}:Nether`; const url = new URL('http://site/api/admin/rcon');
    return { request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list' }) }), url, cookies: { get: () => undefined } }; })(), 'rcon', s).then(r => r, e => e);
  assert.equal(failed.status, 502);
  const text = (await failed.json()).error;
  assert.equal(text, 'Игровой сервер не отвечает.'); assert.ok(!text.includes('127.0.0.1'));
  assert.match(s.auditLog()[0].error, /ECONNREFUSED/);
});
