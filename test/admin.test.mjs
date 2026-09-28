import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectedByServer, can, checkRoleChange, devUser, handleAdmin, owners, playerId, rconCommand, roleOf, saveSettings, siteIdentity, validateSettings, workshopMembers, writeRequest, withMapAccess, handleWorkshopAccess, handleWorkshopSubmit } from '../src/lib/admin.ts';
import { StatsStore } from '../src/lib/stats.ts';

const OWNER = 'e10438e4797b49718cfecec6a8fa171b', ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', MOD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', OTHER = 'cccccccccccccccccccccccccccccccc';
const status = (error) => error instanceof Response ? error.status : assert.fail(`expected Response, got ${error}`);
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'bf-admin-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
import { database as store } from './storage.mjs';

test('permission map: roles grow strictly, unknown/no role has nothing', () => {
  assert.equal(can('builder', 'view'), true); assert.equal(can('builder', 'moderate'), false);
  assert.equal(can('moderator', 'mode'), true); assert.equal(can('moderator', 'recover'), false); assert.equal(can('moderator', 'ban'), false);
  assert.equal(can('admin', 'settings'), true); assert.equal(can('admin', 'roles'), true); assert.equal(can('admin', 'roles-admin'), false);
  assert.equal(can('owner', 'roles-admin'), true);
  assert.equal(can(null, 'view'), false); assert.equal(can('root', 'view'), false);
});

test('bootstrap fails closed: no env and no rows means nobody; owners come only from env', async t => {
  const s = await store(t);
  assert.equal(owners(undefined).size, 0); assert.equal(owners('').size, 0);
  assert.equal(await roleOf(OWNER, s, owners(undefined)), null);
  assert.deepEqual([...owners(`e10438e4-797b-4971-8cfe-cec6a8fa171b, junk,${ADMIN.toUpperCase()}`)], [OWNER, ADMIN]);
  assert.equal(await roleOf(OWNER, s, owners(OWNER)), 'owner');
  await s.setStaff(MOD, 'Mod', 'moderator', 'x'); await s.setStaff(OTHER, 'Evil', 'owner', 'x');
  assert.equal(await roleOf(MOD, s, new Set()), 'moderator');
  assert.equal(await roleOf(OTHER, s, new Set()), null, 'a stored owner row is not an owner');
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

test('workshop members: a builder\'s map list rides along, lead/admin never carry one even if stored', () => {
  const members = workshopMembers([
    { uuid: OTHER, name: 'Bob', role: 'builder', maps: ['fields', 'konstaxa'] },
    { uuid: MOD, name: 'Mod', role: 'moderator', maps: ['fields'] },
    { uuid: ADMIN, name: 'Adm', role: 'admin', maps: null },
  ], new Map());
  assert.deepEqual(members, [
    { draslId: ADMIN, name: 'Adm', role: 'admin' }, { draslId: MOD, name: 'Mod', role: 'lead' },
    { draslId: OTHER, name: 'Bob', role: 'builder', maps: ['fields', 'konstaxa'] },
  ]);
  // null/absent maps means every map: the key is left out entirely. [] is a real, different value: no maps, and it must ride along too.
  assert.deepEqual(workshopMembers([{ uuid: OTHER, name: 'Bob', role: 'builder', maps: null }], new Map()), [{ draslId: OTHER, name: 'Bob', role: 'builder' }]);
  assert.deepEqual(workshopMembers([{ uuid: OTHER, name: 'Bob', role: 'builder', maps: [] }], new Map()), [{ draslId: OTHER, name: 'Bob', role: 'builder', maps: [] }]);
});

test('inbox request is validated and written atomically as <id>.json', t => {
  const dir = temp(t), lead = { uuid: MOD, name: 'Mod', role: 'moderator' }, admin = { uuid: ADMIN, name: 'Adm', role: 'admin' };
  const id = writeRequest(dir, lead, { kind: 'mode', profile: 'workshop', expectedRevision: 3, session: 'new', maps: null });
  assert.deepEqual(readdirSync(dir), [`${id}.json`], 'no temp file is left behind');
  const request = JSON.parse(readFileSync(join(dir, `${id}.json`)));
  assert.deepEqual({ ...request, createdAt: 0 }, { schema: 1, id, kind: 'mode', actor: { draslId: MOD, name: 'Mod' }, createdAt: 0, profile: 'workshop', expectedRevision: 3, session: 'new', maps: null });
  for (const [actor, body, code] of [
    [lead, { kind: 'mode', profile: 'game', expectedRevision: 3, recover: true }, 403],
    [admin, { kind: 'mode', profile: 'workshop', expectedRevision: 3, recover: true }, 400],
    [admin, { kind: 'mode', profile: 'maintenance', expectedRevision: 3 }, 400],
    [admin, { kind: 'mode', profile: 'game' }, 400],
    [admin, { kind: 'mode', profile: 'workshop', expectedRevision: 3 }, 400, 'no session'],
    [admin, { kind: 'message', message: 'x'.repeat(201) }, 400],
    [admin, { kind: 'members', members: [{ draslId: 'bad', name: 'Bob', role: 'admin' }] }, 400],
    [admin, { kind: 'shell' }, 400],
  ]) assert.throws(() => writeRequest(dir, actor, body), e => status(e) === code, JSON.stringify(body));
  writeRequest(dir, admin, { kind: 'mode', profile: 'game', expectedRevision: 0, recover: true });
  assert.equal(readdirSync(dir).length, 2);
  // maps: [] is a valid, distinct value (no maps, not "every map"), and must survive the request as written.
  const mapsId = writeRequest(dir, admin, { kind: 'members', members: [{ draslId: OTHER, name: 'Bob', role: 'builder', maps: [] }] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${mapsId}.json`))).members, [{ draslId: OTHER, name: 'Bob', role: 'builder', maps: [] }]);
});

test('mode request: workshop needs a session; "new" validates maps against MAP_IDS (hub included), "resume" never carries maps', t => {
  const dir = temp(t), admin = { uuid: ADMIN, name: 'Adm', role: 'admin' };
  const allId = writeRequest(dir, admin, { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'new', maps: null });
  assert.equal(JSON.parse(readFileSync(join(dir, `${allId}.json`))).maps, null);
  const someId = writeRequest(dir, admin, { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'new', maps: ['fields', 'hub'] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${someId}.json`))).maps, ['fields', 'hub']);
  const resumeId = writeRequest(dir, admin, { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'resume', maps: ['fields'] });
  assert.equal('maps' in JSON.parse(readFileSync(join(dir, `${resumeId}.json`))), false, 'resume never carries maps, even if the caller sent some');
  for (const body of [
    { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'later' },
    { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'new', maps: [] },
    { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'new', maps: ['not_a_map'] },
    { kind: 'mode', profile: 'workshop', expectedRevision: 1, session: 'new', maps: ['fields', 'fields'] },
  ]) assert.throws(() => writeRequest(dir, admin, body), e => status(e) === 400, JSON.stringify(body));
});

test('mode request: test profile needs a known candidate id', t => {
  const dir = temp(t), admin = { uuid: ADMIN, name: 'Adm', role: 'admin' };
  const id = writeRequest(dir, admin, { kind: 'mode', profile: 'test', expectedRevision: 2, candidateId: 'a'.repeat(32) });
  assert.equal(JSON.parse(readFileSync(join(dir, `${id}.json`))).candidateId, 'a'.repeat(32));
  for (const body of [
    { kind: 'mode', profile: 'test', expectedRevision: 2 }, { kind: 'mode', profile: 'test', expectedRevision: 2, candidateId: 'nope' },
  ]) assert.throws(() => writeRequest(dir, admin, body), e => status(e) === 400, JSON.stringify(body));
});

test('publish request: optional force must be boolean, only written when true', t => {
  const dir = temp(t), admin = { uuid: ADMIN, name: 'Adm', role: 'admin' };
  const plain = writeRequest(dir, admin, { kind: 'publish', candidateId: 'a'.repeat(32) });
  assert.equal('force' in JSON.parse(readFileSync(join(dir, `${plain}.json`))), false);
  const forced = writeRequest(dir, admin, { kind: 'publish', candidateId: 'a'.repeat(32), force: true });
  assert.equal(JSON.parse(readFileSync(join(dir, `${forced}.json`))).force, true);
  const declined = writeRequest(dir, admin, { kind: 'publish', candidateId: 'a'.repeat(32), force: false });
  assert.equal('force' in JSON.parse(readFileSync(join(dir, `${declined}.json`))), false);
  assert.throws(() => writeRequest(dir, admin, { kind: 'publish', candidateId: 'a'.repeat(32), force: 'yes' }), e => status(e) === 400);
});

test('cancel request: same shape as mode/message, no extra fields, no extra validation to bypass', t => {
  const dir = temp(t), lead = { uuid: MOD, name: 'Mod', role: 'moderator' };
  const id = writeRequest(dir, lead, { kind: 'cancel' });
  const request = JSON.parse(readFileSync(join(dir, `${id}.json`)));
  assert.deepEqual({ ...request, createdAt: 0 }, { schema: 1, id, kind: 'cancel', actor: { draslId: MOD, name: 'Mod' }, createdAt: 0 });
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
    { deathmatch: { minPlayers: 0 } }, { deathmatch: { minPlayers: 25 } }, { deathmatch: { minPlayers: 2.5 } }, { deathmatch: { minPlayer: 3 } },
    { parcool: { allowedActions: ['Fastrun'] } }, { parcool: { allowedActions: ['FastRun', 'FastRun'] } }, { parcool: { allowedActions: 'FastRun' } },
    { parcool: { allowedActions: ['FastRun'], extra: 1 } }, { parcool: [] }, { parcool: 'FastRun' },
  ]) assert.throws(() => validateSettings(body), e => status(e) === 400, JSON.stringify(body));
  assert.deepEqual(validateSettings({ deathmatch: { minPlayers: 3 } }), { deathmatch: { minPlayers: 3 } });
  // Owner wants to be able to start deathmatch alone.
  assert.deepEqual(validateSettings({ deathmatch: { minPlayers: 1 } }), { deathmatch: { minPlayers: 1 } });
  // Present with an empty list forbids every parkour action; absent leaves the mod's base file in charge.
  assert.deepEqual(validateSettings({ parcool: { allowedActions: [] } }), { parcool: { allowedActions: [] } });
  assert.deepEqual(validateSettings({ parcool: { allowedActions: ['FastRun', 'ClimbUp'] } }), { parcool: { allowedActions: ['FastRun', 'ClimbUp'] } });
});

test('parcool settings round-trip through saveSettings like the other sections', t => {
  const dir = temp(t);
  const saved = saveSettings(dir, { expectedRevision: 0, parcool: { allowedActions: ['FastRun', 'ClingToCliff'] } }, 'Adm');
  assert.deepEqual(saved.parcool, { allowedActions: ['FastRun', 'ClingToCliff'] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'))).parcool, { allowedActions: ['FastRun', 'ClingToCliff'] });
  // A later save that omits `parcool` drops the section entirely (every save replaces the whole file), returning control to the base file.
  const cleared = saveSettings(dir, { expectedRevision: 1, rooms: { maxRooms: 3 } }, 'Adm');
  assert.equal(cleared.parcool, undefined);
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
  const s = await store(t);
  await s.setStaff(ADMIN, 'Adm', 'admin', 'seed');
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

  // cancel: same "mode" gate as switching, and it writes a plain inbox request the controller can process.
  assert.equal((await call(`${OTHER}:Nobody`, 'POST', 'cancel', {})).status, 403);
  const cancelled = await call(`${MOD}:Moddy`, 'POST', 'cancel', {});
  assert.equal(cancelled.status, 200);
  const { id: cancelId } = await cancelled.json();
  assert.deepEqual(JSON.parse(readFileSync(join(dirs.BLOCKFIELD_INBOX_DIR, `${cancelId}.json`))).kind, 'cancel');

  const log = (await (await call(`${OWNER}:Nether`, 'GET', 'audit')).json()).entries;
  assert.deepEqual(log.map(e => [e.actorName, e.action, e.ok, e.error !== null]), [
    ['Moddy', 'cancel', 1, false], ['Adm', 'role-revoke', 0, true], ['Moddy', 'rcon:kick', 0, true], ['Moddy', 'rcon:ban', 0, true],
    ['Adm', 'role-grant', 1, false], ['Adm', 'role-grant', 0, true],
  ]);
  assert.equal(log[4].target, MOD); assert.equal(JSON.parse(log[4].detail).role, 'moderator');
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
  const s = await store(t);
  let read = false;
  const call = (as, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = as;
    const url = new URL(`http://site/api/admin/${path}`);
    const request = new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    Object.defineProperty(request, 'body', { get() { read = true; return null; } });
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, s).then(r => r, e => e);
  };
  assert.equal((await call(`${OTHER}:Nobody`, 'PUT', 'settings', { expectedRevision: 0, x: 'y'.repeat(60000) })).status, 403);
  assert.equal(read, false); assert.equal((await s.auditLog()).length, 0);
  const failed = await handleAdmin((() => { process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OWNER}:Nether`; const url = new URL('http://site/api/admin/rcon');
    return { request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list' }) }), url, cookies: { get: () => undefined } }; })(), 'rcon', s).then(r => r, e => e);
  assert.equal(failed.status, 502);
  const text = (await failed.json()).error;
  assert.equal(text, 'Игровой сервер не отвечает.'); assert.ok(!text.includes('127.0.0.1'));
  assert.match((await s.auditLog())[0].error, /ECONNREFUSED/);
});

test('owner row falls back to the last known profile name, the signed-in owner name, then «Неизвестный игрок», when Drasl is down', async t => {
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  const second = 'dddddddddddddddddddddddddddddddd', third = 'ffffffffffffffffffffffffffffffff';
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: `${OWNER},${second},${third}`, NODE_ENV: 'test', BLOCKFIELD_ADMIN_DEV_USER: `${second}:Second`, BLOCKFIELD_ADMIN_DIR: temp(t) });
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => { throw new Error('offline'); };
  const s = await store(t);
  await s.db.prepare('INSERT INTO profiles VALUES (?,?,?)').run('e10438e4-797b-4971-8cfe-cec6a8fa171b', 'Nether', 1);
  const url = new URL('http://site/api/admin/staff');
  const response = await handleAdmin({ request: new Request(url), url, cookies: { get: () => undefined } }, 'staff', s);
  assert.deepEqual((await response.json()).owners, [{ uuid: OWNER, name: 'Nether' }, { uuid: second, name: 'Second' }, { uuid: third, name: 'Неизвестный игрок' }]);
});

test('siteIdentity: dev user short-circuits, missing/invalid cookie is anonymous, role decides admin access', async t => {
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test', BLOCKFIELD_ADMIN_DEV_USER: `${OTHER}:Guest`, BLOCKFIELD_STATS_DB: join(temp(t), 'stats.sqlite') });
  assert.deepEqual(await siteIdentity({ get: () => undefined }), { name: 'Guest', hasAdminAccess: false }, 'dev user with no staff row can still open /admin as no-role');
  process.env.BLOCKFIELD_ADMIN_DEV_USER = `${OWNER}:Nether`;
  assert.deepEqual(await siteIdentity({ get: () => undefined }), { name: 'Nether', hasAdminAccess: true });
  delete process.env.BLOCKFIELD_ADMIN_DEV_USER;
  assert.equal(await siteIdentity({ get: () => undefined }), null, 'no session cookie, no dev user: signed out');
});

test('POST staff/maps: only a builder row accepts a map list, ids must be known and unique', async t => {
  const dirs = { BLOCKFIELD_ADMIN_DIR: temp(t), BLOCKFIELD_INBOX_DIR: temp(t), BLOCKFIELD_SETTINGS_DIR: temp(t) };
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test', BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether` });
  const s = await store(t);
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed'); await s.setStaff(MOD, 'Moddy', 'moderator', 'seed');
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('', { status: 404 });
  const call = (path, body) => { const url = new URL(`http://site/api/admin/${path}`); return handleAdmin({ request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, cookies: { get: () => undefined } }, path, s).then(r => r, e => e); };
  assert.equal((await call('staff/maps', { uuid: MOD, maps: ['fields'] })).status, 400, 'a moderator has every map, cannot be given a list');
  assert.equal((await call('staff/maps', { uuid: OTHER, maps: ['not_a_map'] })).status, 400);
  assert.equal((await call('staff/maps', { uuid: OTHER, maps: ['fields', 'fields'] })).status, 400, 'duplicates rejected');
  const ok = await call('staff/maps', { uuid: OTHER, maps: ['fields', 'konstaxa'] });
  assert.equal(ok.status, 200);
  assert.deepEqual((await s.staff()).find(row => row.uuid === OTHER).maps, ['fields', 'konstaxa']);
  // [] is a real, distinct value: the builder keeps a workshop account but has nothing to edit.
  const none = await call('staff/maps', { uuid: OTHER, maps: [] });
  assert.equal(none.status, 200);
  assert.deepEqual((await s.staff()).find(row => row.uuid === OTHER).maps, []);
  const cleared = await call('staff/maps', { uuid: OTHER, maps: null });
  assert.equal(cleared.status, 200);
  assert.equal((await s.staff()).find(row => row.uuid === OTHER).maps, null);
});

test('GET candidates/download: only an accepted candidate\'s exported package, with its checksum', async t => {
  const dirs = { BLOCKFIELD_ADMIN_DIR: temp(t), BLOCKFIELD_INBOX_DIR: temp(t), BLOCKFIELD_SETTINGS_DIR: temp(t) };
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test', BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether` });
  const s = await store(t);
  const accepted = { id: 'a'.repeat(32), status: 'accepted', sha256: '1'.repeat(64) }, pending = { id: 'b'.repeat(32), status: 'pending', sha256: '2'.repeat(64) };
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'candidates.json'), JSON.stringify({ schema: 1, candidates: [accepted, pending] }));
  const call = id => { const url = new URL(`http://site/api/admin/candidates/download?id=${id}`); return handleAdmin({ request: new Request(url), url, cookies: { get: () => undefined } }, 'candidates/download', s).then(r => r, e => e); };
  assert.equal((await call(accepted.id)).status, 503, 'accepted but not exported yet');
  mkdirSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'packages'));
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'packages', `${accepted.sha256}.zip`), 'zip-bytes');
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'packages', `${pending.sha256}.zip`), 'zip-bytes');
  const ok = await call(accepted.id);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-checksum-sha256'), accepted.sha256);
  assert.equal(await ok.text(), 'zip-bytes');
  assert.equal((await call(pending.id)).status, 404, 'a pending candidate is not downloadable');
  assert.equal((await call('../etc')).status, 400);
});

test('withMapAccess: grant keeps "every map", revoke from "every map" lists the rest, a grant never implies future maps', () => {
  assert.equal(withMapAccess(null, 'fields', true), null);
  assert.deepEqual(withMapAccess(['konstaxa'], 'fields', true), ['konstaxa', 'fields']);
  assert.deepEqual(withMapAccess(['fields'], 'fields', true), ['fields']);
  assert.deepEqual(withMapAccess(['konstaxa', 'fields'], 'fields', false), ['konstaxa']);
  const rest = withMapAccess(null, 'fields', false);
  assert.ok(!rest.includes('fields') && rest.includes('konstaxa'));
});

test('POST staff/map-access: sets one map for every builder in one request, only known maps and builders', async t => {
  const dirs = { BLOCKFIELD_ADMIN_DIR: temp(t), BLOCKFIELD_INBOX_DIR: temp(t), BLOCKFIELD_SETTINGS_DIR: temp(t) };
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test', BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether` });
  const s = await store(t);
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed'); await s.setStaff(MOD, 'Moddy', 'builder', 'seed');
  await s.setStaffMaps(MOD, ['konstaxa']);
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('', { status: 404 });
  const call = body => { const url = new URL('http://site/api/admin/staff/map-access'); return handleAdmin({ request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, cookies: { get: () => undefined } }, 'staff/map-access', s).then(r => r, e => e); };
  assert.equal((await call({ mapId: 'not_a_map', uuids: [] })).status, 400);
  assert.equal((await call({ mapId: 'fields', uuids: [OWNER] })).status, 400, 'only builders carry map lists');
  const ok = await call({ mapId: 'fields', uuids: [MOD] });
  assert.equal(ok.status, 200);
  const maps = uuid => s.staff().then(rows => rows.find(row => row.uuid === uuid).maps);
  assert.deepEqual(await maps(MOD), ['konstaxa', 'fields']);
  assert.ok(!(await maps(OTHER)).includes('fields') && (await maps(OTHER)).includes('konstaxa'), 'Bob had every map, now every map but fields');
  assert.equal(readdirSync(dirs.BLOCKFIELD_INBOX_DIR).filter(f => f.endsWith('.json')).length, 1, 'one members request for the whole change');
});

test('POST /api/workshop/access: key, then the in-game actor\'s own site role; hub is a scope; audited', async t => {
  const dirs = { BLOCKFIELD_ADMIN_DIR: temp(t), BLOCKFIELD_INBOX_DIR: temp(t), BLOCKFIELD_SETTINGS_DIR: temp(t) };
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' });
  const s = await store(t);
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed'); await s.setStaff(MOD, 'Moddy', 'moderator', 'seed');
  await s.setStaffMaps(OTHER, ['fields']);
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('', { status: 404 });
  const KEY = 'k'.repeat(40), env = { BLOCKFIELD_WORKSHOP_KEY: KEY };
  const call = (body, key = KEY, e = env) => handleWorkshopAccess(new Request('http://site/api/workshop/access', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }), e, s).then(r => r, e => e);
  const grant = { actor: OWNER, target: OTHER, mapId: 'hub', allowed: true };
  assert.equal((await call(grant, KEY, {})).status, 503, 'no key configured');
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'workshop.key'), `${KEY}\n`);
  assert.equal((await call({ ...grant, actor: MOD }, KEY, {})).status, 403, 'the key file in the admin export works like the env');
  assert.equal((await call(grant, 'wrong'.repeat(8))).status, 401);
  assert.equal((await call({ ...grant, actor: MOD })).status, 403, 'a moderator cannot change rights');
  assert.equal((await call({ ...grant, target: MOD })).status, 400, 'only builders carry map lists');
  assert.equal((await call({ ...grant, mapId: 'nowhere' })).status, 400);
  const ok = await call(grant);
  assert.equal(ok.status, 200);
  assert.deepEqual((await s.staff()).find(row => row.uuid === OTHER).maps, ['fields', 'hub']);
  assert.equal((await call({ ...grant, mapId: 'fields', allowed: false })).status, 200);
  assert.deepEqual((await s.staff()).find(row => row.uuid === OTHER).maps, ['hub']);
  const log = await s.auditLog(20);
  assert.ok(log.some(e => e.action === 'workshop-map-access' && e.ok && e.target === 'hub'), 'granted from the game is in the journal');
  assert.ok(log.some(e => e.action === 'workshop-map-access' && !e.ok), 'refusals are journaled too');
});

test('POST /api/workshop/submit: a builder only for maps they build on; writes a candidate request; journaled', async t => {
  const dirs = { BLOCKFIELD_ADMIN_DIR: temp(t), BLOCKFIELD_INBOX_DIR: temp(t), BLOCKFIELD_SETTINGS_DIR: temp(t) };
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, dirs, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test' });
  const s = await store(t);
  await s.setStaff(OTHER, 'Bob', 'builder', 'seed'); await s.setStaffMaps(OTHER, ['fields']);
  const KEY = 'k'.repeat(40);
  writeFileSync(join(dirs.BLOCKFIELD_ADMIN_DIR, 'workshop.key'), KEY);
  const call = body => handleWorkshopSubmit(new Request('http://site/api/workshop/submit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }), {}, s).then(r => r, e => e);
  assert.equal((await call({ actor: OTHER, mapId: 'konstaxa' })).status, 403, 'not his map');
  assert.equal((await call({ actor: OTHER, mapId: 'hub' })).status, 400, 'the hub is not a map');
  const ok = await call({ actor: OTHER, actorName: 'Bob', mapId: 'fields' });
  assert.equal(ok.status, 200);
  const files = readdirSync(dirs.BLOCKFIELD_INBOX_DIR).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const request = JSON.parse(readFileSync(join(dirs.BLOCKFIELD_INBOX_DIR, files[0]), 'utf8'));
  assert.deepEqual([request.kind, request.mapId, request.actor.name], ['candidate', 'fields', 'Bob']);
  assert.ok((await s.auditLog(5)).some(e => e.action === 'workshop-candidate' && e.ok && e.target === 'fields'));
});

test('writeRequest: candidate/rollback take a real map, publish/reject a candidate id', t => {
  const dir = temp(t), actor = { uuid: OWNER, name: 'Nether', role: 'owner' };
  assert.ok(writeRequest(dir, actor, { kind: 'candidate', mapId: 'konstaxa' }));
  assert.ok(writeRequest(dir, actor, { kind: 'publish', candidateId: 'a'.repeat(32) }));
  assert.throws(() => writeRequest(dir, actor, { kind: 'rollback', mapId: 'hub' }));
  assert.throws(() => writeRequest(dir, actor, { kind: 'reject', candidateId: '../x' }));
});

test('review: stop-room without RCON configured fails fast, before querying rooms', async t => {
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, { BLOCKFIELD_OWNER_UUIDS: OWNER, NODE_ENV: 'test', BLOCKFIELD_ADMIN_DEV_USER: `${OWNER}:Nether`, BLOCKFIELD_SERVER_HOST: '10.255.255.1', BLOCKFIELD_LOBBY_HOST: '10.255.255.1' });
  delete process.env.BLOCKFIELD_RCON_HOST; delete process.env.BLOCKFIELD_GATE_FILE;
  const s = await store(t), url = new URL('http://site/api/admin/rcon'), started = Date.now();
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop-room', roomId: '0f8e0c3a-1b2c-4d5e-8f90-123456789abc', outcome: 'draw' }) });
  const response = await handleAdmin({ request, url, cookies: { get: () => undefined } }, 'rcon', s).then(r => r, e => e);
  assert.equal(response.status, 503); assert.ok(Date.now() - started < 1000);
});

test('class prices round-trip through settings with strict numeric limits', t => {
  const dir = temp(t);
  const prices = { tech: 0, sniper: 150, drone: 10000 };
  const saved = saveSettings(dir, { expectedRevision: 0, classCosts: prices }, 'Adm');
  assert.deepEqual(saved.classCosts, prices);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'))).classCosts, prices);
  for (const classCosts of [{ sniper: -1 }, { sniper: 0.5 }, { sniper: 10001 }, { sniper: '90' }, { sniper: null }, { sniper: Infinity }, { assault: 10 }, [], null]) {
    assert.throws(() => validateSettings({ classCosts }), e => status(e) === 400);
  }
});
