import type { APIContext } from 'astro';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { openSync, readSync, readFileSync, closeSync, renameSync, writeFileSync, unlinkSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AstroCookies } from 'astro';
import { account, drasl, fail, nickname, readJson, session, token } from './account.ts';
import { rcon } from './rcon.ts';
import { currentRooms, roomId } from './rooms.ts';
import { resolveNames, seasons, statsStore, StatsError, UNKNOWN_PLAYER, type StatsStore } from './stats.ts';
import { BALANCE_LABELS, BALANCE_SCOPES, MAP_NAMES, PARCOOL_IDS, WORKSHOP_PLACES } from './game-names.ts';

export const ROLES = ['builder', 'moderator', 'admin', 'owner'] as const;
export type Role = typeof ROLES[number];
const moderator = ['view', 'moderate', 'mode', 'message'];
const admin = [...moderator, 'ban', 'maintenance', 'recover', 'settings', 'stats', 'audit', 'roles', 'workshop'];
const PERMISSIONS: Record<Role, string[]> = { builder: ['view'], moderator, admin, owner: [...admin, 'roles-admin'] };
export const permissions = (role: Role | null) => (role && Object.hasOwn(PERMISSIONS, role) ? PERMISSIONS[role] : []);
export const can = (role: Role | null, permission: string) => permissions(role).includes(permission);
export const ROLE_NAMES: Record<Role, string> = { builder: 'Строитель', moderator: 'Модератор', admin: 'Администратор', owner: 'Владелец' };

export type Actor = { uuid: string; name: string; role: Role | null };
const noStore = { 'Cache-Control': 'no-store' };
const dir = (name: string, fallback: string) => process.env[name] || fallback;
const adminDir = () => dir('BLOCKFIELD_ADMIN_DIR', '/workshop-admin');
const inboxDir = () => dir('BLOCKFIELD_INBOX_DIR', '/workshop-inbox');
const settingsDir = () => dir('BLOCKFIELD_SETTINGS_DIR', '/blockfield-admin');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bad = (message: string) => fail(400, message);

/** Player UUID as Drasl/Minecraft shows it, with or without dashes, to the workshop key: 32 lowercase hex digits. */
export function playerId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.replaceAll('-', '').toLowerCase() : '';
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}
export function owners(env = process.env.BLOCKFIELD_OWNER_UUIDS): Set<string> {
  return new Set((env ?? '').split(',').map(playerId).filter((id): id is string => !!id));
}
/** Owners come only from the environment; anyone else needs a stored grant. No env and no rows = nobody. */
export async function roleOf(uuid: string, store: StatsStore, ownerIds = owners()): Promise<Role | null> {
  if (ownerIds.has(uuid)) return 'owner';
  const role = (await store.staff()).find(s => s.uuid === uuid)?.role;
  return role === 'builder' || role === 'moderator' || role === 'admin' ? role : null;
}

/** Whether `actor` may move `target` from `from` to `to` (null = no role). Throws the reason as a 403 response. */
export function checkRoleChange(actor: Actor, target: string, from: Role | null, to: Role | null, ownerIds = owners()) {
  if (!can(actor.role, 'roles')) throw fail(403, 'Недостаточно прав.');
  if (target === actor.uuid) throw fail(403, 'Свою роль менять нельзя.');
  if (ownerIds.has(target) || from === 'owner' || to === 'owner') throw fail(403, 'Владельцы задаются только переменной окружения сервера.');
  if ((from === 'admin' || to === 'admin') && !can(actor.role, 'roles-admin')) throw fail(403, 'Администраторов назначает только владелец.');
}

export function devUser(env = process.env): { uuid: string; name: string } | null {
  if (env.NODE_ENV === 'production' || !env.BLOCKFIELD_ADMIN_DEV_USER) return null;
  const [uuid, name] = env.BLOCKFIELD_ADMIN_DEV_USER.split(':');
  return playerId(uuid) && nickname.test(name ?? '') ? { uuid: playerId(uuid)!, name } : null;
}
async function currentActor(context: APIContext, store: StatsStore): Promise<Actor> {
  const dev = devUser();
  const who = dev ?? (({ uuid, username }) => ({ uuid: playerId(uuid) ?? '', name: String(username) }))(account(await drasl('/user', { token: token(context.cookies) })));
  return { ...who, role: who.uuid ? (await roleOf(who.uuid, store)) : null };
}

/** For the site header (SSR, no client round trip): the signed-in player's name and whether `/admin` would let them in. Never throws. */
export async function siteIdentity(cookies: Pick<AstroCookies, 'get'>): Promise<{ name: string; hasAdminAccess: boolean } | null> {
  const dev = devUser();
  if (dev) return { name: dev.name, hasAdminAccess: (await roleOf(dev.uuid, await statsStore())) !== null };
  const value = cookies.get(session)?.value;
  if (!value) return null;
  try {
    const { username, uuid } = account(await drasl('/user', { token: value }));
    if (!username) return null;
    const id = playerId(uuid);
    return { name: String(username), hasAdminAccess: id !== null && (await roleOf(id, await statsStore())) !== null };
  } catch { return null; }
}

function readText(path: string, max = 1024): string | null {
  try { const text = readFileSync(path, 'utf8'); return text.length > max ? null : text; } catch { return null; }
}
function readFile(path: string, max = 65_536): any {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const buffer = Buffer.alloc(max + 1), size = readSync(fd, buffer, 0, buffer.length, 0);
    return size > max ? null : JSON.parse(buffer.subarray(0, size).toString());
  } catch { return null; } finally { closeSync(fd); }
}
/** Readers (controller, game server) must never see a half-written file: write a dot-file in the same directory, then rename. */
export function writeAtomic(directory: string, name: string, value: unknown) {
  const temp = join(directory, `.${name}.${randomUUID()}.tmp`);
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); renameSync(temp, join(directory, name)); }
  catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}

// Workshop access scopes, not only maps: `hub` gates building in the workshop hub.
export const MAP_IDS = new Set(Object.keys(WORKSHOP_PLACES));
/** One builder's list after granting (`allowed`) or taking away one map; null stays null when granting, and a new map is never silently implied. */
export function withMapAccess(maps: string[] | null, mapId: string, allowed: boolean): string[] | null {
  if (allowed) return maps === null || maps.includes(mapId) ? maps : [...maps, mapId];
  return (maps ?? [...MAP_IDS]).filter(id => id !== mapId);
}
export type WorkshopMember = { draslId: string; name: string; role: 'admin' | 'lead' | 'builder'; maps?: string[] };
const WORKSHOP_ROLE: Record<Role, WorkshopMember['role']> = { owner: 'admin', admin: 'admin', moderator: 'lead', builder: 'builder' };
/** `lead`/`admin` always have every map; only a `builder` row's `maps` (null = every map) is carried over. */
export function workshopMembers(staff: { uuid: string; name: string; role: string; maps?: string[] | null }[], ownerNames: Map<string, string>): WorkshopMember[] {
  const members = new Map<string, WorkshopMember>();
  for (const s of staff) if (s.role in WORKSHOP_ROLE) {
    const role = WORKSHOP_ROLE[s.role as Role];
    members.set(s.uuid, { draslId: s.uuid, name: s.name, role, ...(role === 'builder' && s.maps != null ? { maps: s.maps } : {}) });
  }
  for (const [uuid, name] of ownerNames) members.set(uuid, { draslId: uuid, name, role: 'admin' });
  return [...members.values()].sort((a, b) => a.draslId.localeCompare(b.draslId));
}

/** Validates a UI request and writes it to the controller inbox. Returns the request id. */
export function writeRequest(directory: string, actor: Actor, body: any): string {
  const base = { schema: 1, id: randomUUID(), kind: body?.kind, actor: { draslId: actor.uuid, name: actor.name }, createdAt: Date.now() };
  let request: Record<string, unknown>;
  if (body?.kind === 'mode') {
    if (!['game', 'workshop', 'test'].includes(body.profile)) throw bad('Режим: game, workshop или test.');
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw bad('Нет ревизии состояния: обновите страницу.');
    if (body.recover !== undefined && typeof body.recover !== 'boolean') throw bad('Некорректный запрос.');
    if (body.recover && body.profile !== 'game') throw bad('Восстановление возможно только в игровой режим.');
    if (body.recover && !can(actor.role, 'recover')) throw fail(403, 'Восстановление доступно администратору.');
    let extra: Record<string, unknown> = {};
    if (body.profile === 'workshop') {
      if (body.session !== 'new' && body.session !== 'resume') throw bad('Сеанс мастерской: new или resume.');
      if (body.session === 'new') {
        const maps = body.maps;
        if (maps !== null && (!Array.isArray(maps) || !maps.length || new Set(maps).size !== maps.length || !maps.every((id: unknown) => typeof id === 'string' && MAP_IDS.has(id))))
          throw bad('Некорректный список карт.');
        extra = { session: 'new', maps };
      } else extra = { session: 'resume' }; // resume always keeps the previous session's maps; a client-sent list here is dropped, never forwarded.
    } else if (body.profile === 'test') {
      if (typeof body.candidateId !== 'string' || !/^[0-9a-f]{32}$/.test(body.candidateId)) throw bad('Неизвестная версия карты.');
      extra = { candidateId: body.candidateId };
    }
    request = { ...base, profile: body.profile, expectedRevision: body.expectedRevision, ...(body.recover ? { recover: true } : {}), ...extra };
  } else if (body?.kind === 'message') {
    // Same rule as the controller: strip control characters (Unicode Cc) and §, keep format characters such as ZWJ.
    const message = typeof body.message === 'string' ? body.message.replace(/[\p{Cc}§]/gu, '').trim() : null;
    if (message === null || [...message].length > 200) throw bad('Сообщение: до 200 символов.');
    request = { ...base, message };
  } else if (body?.kind === 'cancel') {
    request = { ...base };
  } else if (body?.kind === 'members') {
    // `maps` absent/null: every map, including ones added later. `maps: []`: no map (the builder still gets a workshop account, just nothing to edit).
    const validMaps = (m: any) => m.maps === undefined || (Array.isArray(m.maps) && new Set(m.maps).size === m.maps.length && m.maps.every((id: unknown) => typeof id === 'string' && MAP_IDS.has(id)));
    const valid = Array.isArray(body.members) && body.members.every((m: any) => playerId(m?.draslId) === m.draslId && nickname.test(m.name) && ['admin', 'lead', 'builder'].includes(m.role) && validMaps(m));
    if (!valid) throw bad('Некорректный список участников.');
    request = { ...base, members: body.members.map(({ draslId, name, role, maps }: WorkshopMember) => ({ draslId, name, role, ...(maps ? { maps } : {}) })) };
  } else if (body?.kind === 'candidate' || body?.kind === 'rollback') {
    // Only real maps: the hub is an access scope, not something that is published.
    if (typeof body.mapId !== 'string' || !(body.mapId in MAP_NAMES)) throw bad('Неизвестная карта.');
    request = { ...base, mapId: body.mapId };
  } else if (body?.kind === 'publish' || body?.kind === 'reject') {
    if (typeof body.candidateId !== 'string' || !/^[0-9a-f]{32}$/.test(body.candidateId)) throw bad('Неизвестная версия карты.');
    if (body.kind === 'publish' && body.force !== undefined && typeof body.force !== 'boolean') throw bad('Некорректный запрос.');
    request = { ...base, candidateId: body.candidateId, ...(body.kind === 'publish' && body.force ? { force: true } : {}) };
  } else throw bad('Неизвестный тип запроса.');
  writeAtomic(directory, `${base.id}.json`, request);
  return base.id;
}

const range = (min: number, max: number) => (v: unknown) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const LOBBY: Record<string, (v: unknown) => boolean> = { pvpEnabled: v => typeof v === 'boolean', pvpCooldownSeconds: range(0, 600) };
const ROOMS: Record<string, (v: unknown) => boolean> = { maxRooms: range(1, 16), idleCloseSeconds: range(30, 3600), abandonCloseSeconds: range(5, 600) };
/** Must match the mod's DeathmatchMode: at least 1 player (owner can start alone), arenas are small so 24 is a generous ceiling. */
const DEATHMATCH: Record<string, (v: unknown) => boolean> = { minPlayers: range(1, 24) };
/** Must match the mod's campaign balance parser: type and inclusive range per key. */
export const BALANCE: Record<string, { type: 'int' | 'double' | 'bool'; min?: number; max?: number }> = {
  max_tickets: { type: 'int', min: 1, max: 100_000 }, ticket_bleed_multiplier: { type: 'int', min: 0, max: 100 }, ticket_bleed_timer_seconds: { type: 'int', min: 1, max: 600 },
  death_ticket_cost: { type: 'int', min: 0, max: 1000 }, capture_speed_percent_per_tick: { type: 'int', min: 1, max: 100 }, uncapture_speed_percent_per_tick: { type: 'int', min: 1, max: 100 },
  score_per_kill: { type: 'int', min: 0, max: 10_000 }, score_per_obj_sec: { type: 'double', min: 0, max: 1000 }, score_per_capture: { type: 'int', min: 0, max: 10_000 },
  score_per_uncapture: { type: 'int', min: 0, max: 10_000 }, preparation_time_seconds: { type: 'int', min: 0, max: 600 }, transition_time_seconds: { type: 'int', min: 0, max: 600 },
  enable_spawn_shield: { type: 'bool' }, spawn_shield_duration_seconds: { type: 'int', min: 0, max: 60 }, safe_spawn_threshold: { type: 'int', min: 0, max: 100 },
  base_warn_radius: { type: 'double', min: 0, max: 1000 }, base_kill_radius: { type: 'double', min: 0, max: 1000 },
  max_players_per_team: { type: 'int', min: 1, max: 64 }, min_players_per_team: { type: 'int', min: 1, max: 64 },
  base_spawn_time_seconds: { type: 'int', min: 0, max: 300 }, spawn_time_per_point_seconds: { type: 'int', min: 0, max: 300 }, shuffle_teams_between_rounds: { type: 'bool' },
  ready_countdown_seconds: { type: 'int', min: 0, max: 300 }, reserve_seconds: { type: 'int', min: 0, max: 3600 }, ready_timeout_seconds: { type: 'int', min: 10, max: 3600 },
};
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function section(value: unknown, rules: Record<string, (v: unknown) => boolean>, name: string) {
  if (!plain(value) || !Object.entries(value).every(([k, v]) => Object.hasOwn(rules, k) && rules[k](v))) throw bad(`Настройки: неверный раздел «${name}».`);
  return value;
}
/** Settings sections are optional and replace the stored ones as a whole; an absent key means the server default. */
export function validateSettings(body: any) {
  if (!plain(body) || Object.keys(body).some(k => !['expectedRevision', 'lobby', 'rooms', 'deathmatch', 'classLocks', 'classCosts', 'campaignBalance', 'parcool'].includes(k))) throw bad('Некорректные настройки.');
  const out: Record<string, unknown> = {};
  if (body.lobby !== undefined) out.lobby = section(body.lobby, LOBBY, 'лобби');
  if (body.rooms !== undefined) out.rooms = section(body.rooms, ROOMS, 'комнаты');
  if (body.deathmatch !== undefined) out.deathmatch = section(body.deathmatch, DEATHMATCH, 'каждый сам за себя');
  if (body.classCosts !== undefined) {
    out.classCosts = section(body.classCosts, Object.fromEntries(['tech', 'sniper', 'drone'].map(id =>
      [id, (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10_000])), 'стоимость классов');
  }
  if (body.classLocks !== undefined) {
    const list = body.classLocks;
    if (!Array.isArray(list) || list.length > 64 || new Set(list).size !== list.length || !list.every((c: unknown) => typeof c === 'string' && /^[a-z0-9_]{1,32}$/.test(c))) throw bad('Настройки: неверный список закрытых классов.');
    out.classLocks = list;
  }
  if (body.campaignBalance !== undefined) {
    const balance = body.campaignBalance, rules = Object.fromEntries(Object.entries(BALANCE).map(([k, r]) => [k, (v: unknown) => r.type === 'bool' ? typeof v === 'boolean'
      : typeof v === 'number' && Number.isFinite(v) && (r.type === 'double' || Number.isSafeInteger(v)) && v >= r.min! && v <= r.max!]));
    if (!plain(balance) || Object.keys(balance).length > 64 || !Object.keys(balance).every(k => k === '*' || /^[A-Za-z0-9_-]{1,32}$/.test(k))) throw bad('Настройки: неверные кампании в балансе.');
    for (const [campaign, values] of Object.entries(balance)) {
      section(values, rules, `баланс ${campaign}`);
      // The mod applies "*" first, then the campaign's own section.
      const merged: any = { ...(balance['*'] as object), ...(values as object) };
      const scope = BALANCE_SCOPES.find(s => s.id === campaign)?.name ?? 'Другая кампания';
      if (merged.min_players_per_team > merged.max_players_per_team) throw bad(`${scope}: «${BALANCE_LABELS.min_players_per_team}» больше, чем «${BALANCE_LABELS.max_players_per_team}».`);
      if (merged.base_kill_radius > merged.base_warn_radius) throw bad(`${scope}: «${BALANCE_LABELS.base_kill_radius}» больше, чем «${BALANCE_LABELS.base_warn_radius}».`);
    }
    out.campaignBalance = balance;
  }
  if (body.parcool !== undefined) {
    const value = body.parcool, list = plain(value) ? value.allowedActions : undefined;
    if (!plain(value) || Object.keys(value).some(k => k !== 'allowedActions') || !Array.isArray(list) || new Set(list).size !== list.length
      || !list.every((a: unknown) => typeof a === 'string' && PARCOOL_IDS.has(a))) throw bad('Настройки: неверный список действий паркура.');
    out.parcool = { allowedActions: list };
  }
  return out;
}
export function readSettings(directory: string) {
  return { settings: readFile(join(directory, 'settings.json')) ?? { schema: 1, revision: 0 }, applied: readFile(join(directory, 'applied.json')) };
}
export function saveSettings(directory: string, body: any, actorName: string) {
  const values = validateSettings(body), current = readSettings(directory).settings;
  const revision = Number.isSafeInteger(current?.revision) ? current.revision : 0;
  // ponytail: the read-compare-rename is synchronous, so it is atomic within this single site process; a second writer to the directory would need a lock file.
  if (body.expectedRevision !== revision) throw fail(409, 'Настройки уже изменил кто-то другой. Обновите страницу.');
  const settings = { schema: 1, revision: revision + 1, updatedAt: Date.now(), updatedBy: actorName, ...values };
  writeAtomic(directory, 'settings.json', settings);
  return settings;
}

/** Only these command shapes ever reach RCON; every argument is checked, nothing is passed through. */
function text(value: unknown, required: boolean): string {
  if (value === undefined || value === null || value === '') { if (required) throw bad('Укажите текст.'); return ''; }
  if (typeof value !== 'string') throw bad('Некорректный текст.');
  const clean = value.replace(/[\p{Cc}§]/gu, ' ').replace(/ {2,}/g, ' ').trim();
  if (!clean && required) throw bad('Укажите текст.');
  if (clean.length > 120) throw bad('Текст длиннее 120 символов.');
  if (clean.startsWith('/')) throw bad('Текст не может начинаться с «/».');
  return clean;
}
const player = (value: unknown) => { if (typeof value !== 'string' || !nickname.test(value)) throw bad('Никнейм: 3–16 символов, латинские буквы, цифры и _.'); return value; };
const withReason = (command: string, reason: string) => (reason ? `${command} ${reason}` : command);
export function rconCommand(body: any): { permission: string; commands: string[]; target: string | null } {
  switch (body?.action) {
    case 'list': return { permission: 'moderate', commands: ['list'], target: null };
    case 'say': return { permission: 'moderate', commands: [`say ${text(body.text, true)}`], target: null };
    case 'kick': return { permission: 'moderate', commands: [withReason(`kick ${player(body.player)}`, text(body.reason, false))], target: body.player };
    case 'ban': return { permission: 'ban', commands: [withReason(`ban ${player(body.player)}`, text(body.reason, false))], target: body.player };
    case 'pardon': return { permission: 'ban', commands: [`pardon ${player(body.player)}`], target: body.player };
    case 'team-kick': return { permission: 'moderate', commands: [`bf team kick ${player(body.player)}`], target: body.player };
    case 'class-lock': case 'class-unlock': {
      if (typeof body.classId !== 'string' || !/^[a-z0-9_]{1,32}$/.test(body.classId)) throw bad('Некорректный класс.');
      return { permission: 'moderate', commands: [`bf class ${body.action.slice(6)} ${body.classId}`], target: body.classId };
    }
    case 'range':
      if (!['open', 'close', 'reset'].includes(body.op)) throw bad('Полигон: open, close или reset.');
      return { permission: 'moderate', commands: [`bf range ${body.op}`], target: body.op };
    case 'stop-room': {
      if (typeof body.roomId !== 'string' || !roomId.test(body.roomId)) throw bad('Некорректная комната.');
      const reason = text(body.reason, false), room = `bf stop room ${body.roomId}`;
      if (body.outcome === 'draw') return { permission: 'moderate', commands: [withReason(`${room} draw`, reason)], target: body.roomId };
      if (body.outcome === 'RED' || body.outcome === 'BLUE') return { permission: 'moderate', commands: [withReason(`${room} win ${body.outcome === 'RED' ? 'RedTeam' : 'BlueTeam'}`, reason)], target: body.roomId };
      if (body.outcome !== 'none') throw bad('Итог: none, draw, RED или BLUE.');
      // A bare reason starting with a sub-command word would be parsed as that sub-command.
      if (/^(win|draw)\b/.test(reason)) throw bad('Причина не может начинаться с win или draw.');
      return { permission: 'moderate', commands: [withReason(room, reason)], target: body.roomId };
    }
    case 'maintenance-status': return { permission: 'maintenance', commands: ['bf maintenance status'], target: null };
    case 'drain': return { permission: 'maintenance', commands: ['bf maintenance drain'], target: null };
    // The server confirms an interrupt only from the same sender within 60 s, so both commands share one connection.
    case 'interrupt': return { permission: 'maintenance', commands: ['bf maintenance interrupt', `bf maintenance interrupt confirm ${text(body.reason, true)}`], target: null };
    default: throw bad('Неизвестное действие.');
  }
}
const stripColors = (output: string) => output.replace(/§./g, '');
/** Brigadier answers a bad command with text, not an error code. */
export const rejectedByServer = (output: string) => /^\s*(Unknown or incomplete command|Unknown command)/i.test(output) || output.includes('<--[HERE]');
/** A failure whose `internal` text goes only to the server log and the audit log, never to the browser. */
function hidden(status: number, message: string, internal: string) { return Object.assign(fail(status, message), { internal }); }

async function lookupName(name: unknown): Promise<{ uuid: string; name: string }> {
  if (typeof name !== 'string' || !nickname.test(name)) throw bad('Никнейм: 3–16 символов, латинские буквы, цифры и _.');
  const base = (process.env.DRASL_URL || 'https://skins.blockfield.pro').replace(/\/+$/, '');
  const response = await fetch(`${base}/account/users/profiles/minecraft/${name}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (response?.status === 404 || response?.status === 204) throw fail(404, 'Игрок с таким никнеймом не найден.');
  const data = response?.ok ? await response.json().catch(() => null) : null;
  if (!playerId(data?.id) || typeof data.name !== 'string') throw fail(502, 'Сервер аккаунтов недоступен. Попробуйте позже.');
  return { uuid: playerId(data.id)!, name: data.name };
}
const ownerNames = new Map<string, string>();
/** Last name seen in match results; used when Drasl cannot be reached. */
async function knownName(store: StatsStore, uuid: string): Promise<string | null> {
  const dashed = uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const row = await store.db.prepare('SELECT name FROM profiles WHERE uuid=?').get(dashed) as { name: string } | undefined;
  return row && nickname.test(row.name) ? row.name : null;
}
async function ownerName(uuid: string): Promise<string> {
  if (ownerNames.has(uuid)) return ownerNames.get(uuid)!;
  const base = (process.env.DRASL_URL || 'https://skins.blockfield.pro').replace(/\/+$/, '');
  const data = await fetch(`${base}/session/minecraft/profile/${uuid}`, { signal: AbortSignal.timeout(10_000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (typeof data?.name !== 'string' || !nickname.test(data.name)) throw fail(502, 'Не удалось узнать никнейм владельца в сервере аккаунтов.');
  ownerNames.set(uuid, data.name);
  return data.name;
}
async function syncWorkshop(store: StatsStore, actor: Actor, resolve = ownerName) {
  const names = new Map<string, string>();
  for (const uuid of owners()) names.set(uuid, await resolve(uuid).catch(async error => (await knownName(store, uuid)) ?? Promise.reject(error)));
  const members = workshopMembers(await store.staff(), names);
  const id = writeRequest(inboxDir(), actor, { kind: 'members', members });
  return { id, members };
}

/**
 * Players banned through the site: the latest successful ban/pardon per nickname in the audit log.
 * ponytail: bans made in-game or older than the newest 10 000 audit rows are not listed (RCON `banlist` output has no separators to parse); «Разбанить по нику» covers them.
 */
export async function siteBans(store: StatsStore) {
  const rows = await store.db.prepare(`SELECT action,target,actor_name "actorName",at,detail FROM admin_audit WHERE ok=1 AND action IN ('rcon:ban','rcon:pardon') AND target IS NOT NULL ORDER BY id`).all() as any[];
  const latest = new Map<string, any>();
  for (const row of rows) latest.set(String(row.target).toLowerCase(), row);
  return [...latest.values()].filter(r => r.action === 'rcon:ban').reverse().map(r => {
    let reason = '';
    try { reason = String(JSON.parse(r.detail)?.reason ?? ''); } catch {}
    return { player: r.target as string, by: r.actorName as string, at: r.at as number, reason };
  });
}

type Handler = (args: { context: APIContext; actor: Actor; store: StatsStore; body: any }) => Promise<unknown> | unknown;
type Route = { permission: string; handler: Handler; audit?: (body: any, result: any) => { action: string; target?: string | null; detail?: unknown } };
const page = (url: URL) => { const n = Number(url.searchParams.get('page') || '1'); if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw bad('Некорректная страница.'); return n; };

const routes: Record<string, Route> = {
  'GET overview': { permission: 'view', handler: async () => ({ status: readFile(join(adminDir(), 'status.json')), session: readFile(join(adminDir(), 'session.json')), rooms: await currentRooms() }) },
  'GET request': { permission: 'view', handler: ({ context }) => {
    const id = context.url.searchParams.get('id') ?? '';
    if (!UUID.test(id)) throw bad('Некорректный запрос.');
    return { result: readFile(join(adminDir(), 'results', `${id}.json`)) };
  } },
  'POST mode': { permission: 'mode', handler: ({ actor, body }) => ({ id: writeRequest(inboxDir(), actor, { ...body, kind: 'mode' }) }),
    audit: body => ({ action: 'mode', target: String(body?.profile), detail: { expectedRevision: body?.expectedRevision, recover: body?.recover === true, session: body?.session, maps: body?.maps, candidateId: body?.candidateId } }) },
  'POST message': { permission: 'message', handler: ({ actor, body }) => ({ id: writeRequest(inboxDir(), actor, { kind: 'message', message: body?.message }) }),
    audit: body => ({ action: 'message', detail: { message: body?.message } }) },
  // Same gate as switching: an unprivileged rollback of a switch that is still DRAINING/STARTING, no --recover/root needed.
  'POST cancel': { permission: 'mode', handler: ({ actor }) => ({ id: writeRequest(inboxDir(), actor, { kind: 'cancel' }) }),
    audit: () => ({ action: 'cancel' }) },
  'POST rcon': { permission: 'moderate', handler: async ({ actor, body }) => {
    const { permission, commands } = rconCommand(body);
    if (!can(actor.role, permission)) throw fail(403, 'Недостаточно прав.');
    const env = process.env;
    if (!env.BLOCKFIELD_RCON_HOST || !env.BLOCKFIELD_RCON_PASSWORD) throw fail(503, 'RCON не настроен на сайте.');
    // Room ids are not meaningful to people: keep the room's name and map for the audit log.
    const found = body.action === 'stop-room' ? (await currentRooms()).rooms.find(r => r.id === body.roomId) : undefined;
    const room = found ? { name: found.name, map: found.map } : undefined;
    const outputs = await rcon(commands, { host: env.BLOCKFIELD_RCON_HOST, port: Number(env.BLOCKFIELD_RCON_PORT || 25575), password: env.BLOCKFIELD_RCON_PASSWORD })
      .catch((error: Error) => { console.error('RCON failed', error.message); throw hidden(502, 'Игровой сервер не отвечает.', error.message); });
    const output = stripColors(outputs.at(-1) ?? '');
    const rejected = outputs.map(stripColors).find(rejectedByServer);
    if (rejected !== undefined) throw fail(502, `Сервер не принял команду: ${rejected.slice(0, 200)}`);
    return { output, room, players: body.action === 'list' ? (output.split(':')[1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : undefined };
  }, audit: (body, result) => ({ action: `rcon:${body?.action}`, target: body?.player ?? body?.roomId ?? body?.classId ?? body?.op ?? null, detail: { ...body, room: result?.room, output: result?.output?.slice(0, 500) } }) },
  'GET bans': { permission: 'ban', handler: async ({ store }) => ({ bans: await siteBans(store) }) },
  // Подсказки к полям с никнеймом: кого сайт уже видел в матчах, начиная с недавних.
  'GET players': { permission: 'moderate', handler: async ({ store }) => ({
    players: (await store.db.prepare('SELECT name FROM profiles WHERE uuid_like(name)=0 ORDER BY last_seen DESC LIMIT 300').all() as { name: string }[])
      .map(row => row.name).filter(name => nickname.test(name)),
  }) },
  'GET settings': { permission: 'settings', handler: () => ({ ...readSettings(settingsDir()), balance: BALANCE }) },
  'PUT settings': { permission: 'settings', handler: ({ actor, body }) => ({ settings: saveSettings(settingsDir(), body, actor.name) }),
    audit: (body, result) => ({ action: 'settings', target: result?.settings ? `revision ${result.settings.revision}` : null, detail: body }) },
  // Map candidates (controller candidates.py): the list is for everyone in the panel, decisions for admins.
  'GET candidates': { permission: 'view', handler: () => readFile(join(adminDir(), 'candidates.json')) ?? { schema: 1, candidates: [], backups: {} } },
  'GET candidates/download': { permission: 'workshop', handler: ({ context }) => {
    const id = new URL(context.request.url).searchParams.get('id');
    if (!id || !/^[0-9a-f]{32}$/.test(id)) throw bad('Неверный ID кандидата.');
    const candidate = readFile(join(adminDir(), 'candidates.json'))?.candidates?.find((c: any) => c.id === id && c.status === 'accepted');
    if (!candidate || !/^[0-9a-f]{64}$/.test(candidate.sha256)) throw fail(404, 'Принятый пакет не найден.');
    const path = join(adminDir(), 'packages', candidate.sha256 + '.zip');
    let size: number;
    try { const stat = statSync(path); if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error(); size = stat.size; }
    catch { throw fail(503, 'Пакет ещё не готов к скачиванию.'); }
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: {
      ...noStore, 'Content-Type': 'application/zip', 'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${id}.zip"`, 'X-Checksum-Sha256': candidate.sha256,
    } });
  } },
  'POST candidates/create': { permission: 'workshop', handler: ({ actor, body }) => ({ id: writeRequest(inboxDir(), actor, { kind: 'candidate', mapId: body?.mapId }) }),
    audit: body => ({ action: 'workshop-candidate', target: body?.mapId ?? null }) },
  'POST candidates/publish': { permission: 'workshop', handler: ({ actor, body }) => ({ id: writeRequest(inboxDir(), actor, { kind: 'publish', candidateId: body?.candidateId, force: body?.force }) }),
    audit: body => ({ action: 'workshop-publish', target: body?.mapId ?? null, detail: { candidateId: body?.candidateId, force: body?.force === true } }) },
  'POST candidates/reject': { permission: 'workshop', handler: ({ actor, body }) => ({ id: writeRequest(inboxDir(), actor, { kind: 'reject', candidateId: body?.candidateId }) }),
    audit: body => ({ action: 'workshop-reject', target: body?.mapId ?? null, detail: { candidateId: body?.candidateId } }) },
  'POST maps/rollback': { permission: 'workshop', handler: ({ actor, body }) => ({ id: writeRequest(inboxDir(), actor, { kind: 'rollback', mapId: body?.mapId }) }),
    audit: body => ({ action: 'workshop-rollback', target: body?.mapId ?? null }) },
  'GET staff': { permission: 'roles', handler: async ({ actor, store }) => {
    const ids = owners();
    await Promise.all([...ids].map(async uuid => ownerName(uuid).catch(() => null)));
    const last = (await store.auditLog(200) as any[]).find(e => e.action === 'workshop-sync' && e.ok && e.target);
    const lastSync = last ? { id: last.target, at: last.at, result: readFile(join(adminDir(), 'results', `${last.target}.json`)) } : null;
    const names = new Map(await Promise.all([...ids].map(async uuid => [uuid, ownerNames.get(uuid) ?? await knownName(store, uuid) ?? (uuid === actor.uuid ? actor.name : null)] as const)));
    const name = (uuid: string) => names.get(uuid);
    return { owners: [...ids].map(uuid => ({ uuid, name: name(uuid) ?? UNKNOWN_PLAYER })), staff: await store.staff(), workshop: readFile(join(adminDir(), 'members.json')),
      expected: workshopMembers(await store.staff(), new Map([...ids].map(uuid => [uuid, name(uuid) ?? '']))), lastSync };
  } },
  'POST staff': { permission: 'roles', handler: async ({ actor, store, body }) => {
    if (body?.role !== null && !['builder', 'moderator', 'admin'].includes(body?.role)) throw bad('Неизвестная роль.');
    const target = body?.uuid ? { uuid: playerId(body.uuid), name: (await store.staff()).find(s => s.uuid === playerId(body.uuid))?.name } : await lookupName(body?.name);
    if (!target.uuid || !target.name) throw fail(404, 'Участник не найден.');
    checkRoleChange(actor, target.uuid, await roleOf(target.uuid, store), body.role);
    await store.setStaff(target.uuid, target.name, body.role, actor.name);
    const sync = await syncWorkshop(store, actor).then(({ id }) => ({ id }), (error: unknown) => ({ error: error instanceof Response ? 'Не удалось отправить список в мастерскую.' : String((error as Error).message) }));
    return { uuid: target.uuid, name: target.name, role: body.role, sync };
  }, audit: (body, result) => ({ action: body?.role === null ? 'role-revoke' : 'role-grant', target: result?.uuid ?? body?.uuid ?? body?.name ?? null, detail: { name: result?.name ?? body?.name, role: body?.role, sync: result?.sync } }) },
  'POST staff/sync': { permission: 'workshop', handler: async ({ actor, store }) => await syncWorkshop(store, actor), audit: (_, result) => ({ action: 'workshop-sync', target: result?.id ?? null, detail: { members: result?.members } }) },
  // `maps: null` means every map; only meaningful for a `builder` row, checked here rather than trusted from the client.
  'POST staff/maps': { permission: 'roles', handler: async ({ actor, store, body }) => {
    const uuid = playerId(body?.uuid), row = uuid ? (await store.staff()).find(s => s.uuid === uuid) : undefined;
    if (!row) throw fail(404, 'Участник не найден.');
    if (row.role !== 'builder') throw bad('Список карт задаётся только строителям.');
    // null = every map, including ones added later; [] = the builder gets a workshop account but nothing to edit.
    const maps = body?.maps;
    if (maps !== null && (!Array.isArray(maps) || new Set(maps).size !== maps.length || !maps.every((id: unknown) => typeof id === 'string' && MAP_IDS.has(id))))
      throw bad('Некорректный список карт.');
    await store.setStaffMaps(uuid!, maps);
    const sync = await syncWorkshop(store, actor).then(({ id }) => ({ id }), (error: unknown) => ({ error: error instanceof Response ? 'Не удалось отправить список в мастерскую.' : String((error as Error).message) }));
    return { uuid, name: row.name, maps, sync };
  }, audit: (body, result) => ({ action: 'workshop-maps', target: result?.uuid ?? body?.uuid ?? null, detail: { name: result?.name, maps: body?.maps, sync: result?.sync } }) },
  // Map-centric view of the same `maps` lists: who of the builders may edit one map; one workshop sync for the whole change.
  'POST staff/map-access': { permission: 'roles', handler: async ({ actor, store, body }) => {
    const mapId = body?.mapId, uuids = body?.uuids;
    if (typeof mapId !== 'string' || !MAP_IDS.has(mapId)) throw bad('Неизвестная карта.');
    const builders = (await store.staff()).filter(s => s.role === 'builder');
    const ids = Array.isArray(uuids) ? uuids.map(playerId) : null;
    if (!ids || ids.some(id => !id || !builders.some(b => b.uuid === id)) || new Set(ids).size !== ids.length) throw bad('Некорректный список строителей.');
    const changed = [];
    for (const b of builders) {
      const maps = withMapAccess(b.maps ?? null, mapId, ids.includes(b.uuid));
      if (JSON.stringify(maps) === JSON.stringify(b.maps ?? null)) continue;
      await store.setStaffMaps(b.uuid, maps);
      changed.push(b.name);
    }
    const sync = changed.length ? await syncWorkshop(store, actor).then(({ id }) => ({ id }), (error: unknown) => ({ error: error instanceof Response ? 'Не удалось отправить список в мастерскую.' : String((error as Error).message) })) : null;
    return { mapId, changed, sync };
  }, audit: (body, result) => ({ action: 'workshop-map-access', target: body?.mapId ?? null, detail: { changed: result?.changed, sync: result?.sync } }) },
  'GET results': { permission: 'stats', handler: async ({ context, store }) => {
    const load = async () => await store.results(context.url.searchParams.get('mode') || null, page(context.url)), data = await load();
    const unknown = data.results.flatMap(r => r.players.filter(p => p.name === UNKNOWN_PLAYER).map(p => p.uuid));
    return unknown.length && (await resolveNames(store, unknown)).size ? (await load()) : data;
  } },
  'POST results/void': { permission: 'stats', handler: async ({ actor, store, body }) => {
    if (!UUID.test(body?.serverId) || !UUID.test(body?.eventId) || typeof body.voided !== 'boolean') throw bad('Некорректный результат.');
    return await store.setVoided(body.serverId, body.eventId, body.voided ? actor.name : null);
  }, audit: (body, result) => ({ action: body?.voided ? 'result-void' : 'result-restore', target: `${body?.serverId}/${body?.eventId}`, detail: result?.match }) },
  'GET keys': { permission: 'stats', handler: async ({ store }) => ({ keys: await store.ingestKeys() }) },
  'POST keys': { permission: 'stats', handler: async ({ store, body }) => {
    if (!UUID.test(body?.serverId)) throw bad('ID сервера — UUID.');
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 64 || /[\x00-\x1f\x7f]/.test(body.label)) throw bad('Подпись: до 64 символов.');
    return { key: await store.createIngestKey(body.serverId, body.label.trim()) };
  }, audit: body => ({ action: 'ingest-key-create', target: body?.serverId ?? null, detail: { label: body?.label } }) },
  'POST keys/revoke': { permission: 'stats', handler: async ({ store, body }) => {
    if (!Number.isSafeInteger(body?.id) || !(await store.revokeIngestKey(body.id))) throw fail(404, 'Ключ не найден или уже отозван.');
    return { revoked: body.id };
  }, audit: body => ({ action: 'ingest-key-revoke', target: String(body?.id) }) },
  'GET seasons': { permission: 'stats', handler: () => ({ seasons: seasons() }) },
  'GET audit': { permission: 'audit', handler: async ({ store }) => ({ entries: await store.auditLog(200) }) },
};

/**
 * `POST /api/workshop/access` from the workshop server (tablet «Разрешить/Запретить строить»): the same change as
 * «Кто правит» for one builder, authorised by BLOCKFIELD_WORKSHOP_KEY and then by the in-game actor's own site role.
 */
/** The workshop server's own requests: shared key (a file in the controller's admin export, both mount it read-only). */
function workshopKeyError(request: Request, env: Record<string, string | undefined>): Response | null {
  if (request.method !== 'POST') return fail(405, 'POST only.');
  const key = env.BLOCKFIELD_WORKSHOP_KEY || readText(join(adminDir(), 'workshop.key'))?.trim();
  if (!key || key.length < 32) return fail(503, 'Запись из мастерской не настроена.');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(request.headers.get('authorization') ?? ''), digest(`Bearer ${key}`))) return fail(401, 'Неверный ключ.');
  return null;
}

/**
 * `POST /api/workshop/submit {actor, actorName, mapId}`: «Отправить на проверку» from the tablet. The actor must be
 * able to build on that map by the site's own records; the controller then snapshots it (inbox kind `candidate`).
 */
export async function handleWorkshopSubmit(request: Request, env: Record<string, string | undefined> = process.env, storage?: StatsStore): Promise<Response> {
  const refused = workshopKeyError(request, env);
  if (refused) return refused;
  const body = await readJson(request, 4096);
  const actorId = playerId(body?.actor), mapId = body?.mapId;
  if (!actorId || typeof mapId !== 'string' || !(mapId in MAP_NAMES)) return fail(400, 'Некорректный запрос.');
  const store = storage ?? (await statsStore());
  const staff = await store.staff(), role = await roleOf(actorId, store), row = staff.find(s => s.uuid === actorId);
  const claimed = typeof body?.actorName === 'string' && nickname.test(body.actorName) ? body.actorName : null;
  const actor: Actor = { uuid: actorId, name: row?.name ?? (await knownName(store, actorId)) ?? claimed ?? 'Владелец', role };
  let error: string | null = null, id: string | null = null;
  try {
    const builds = role !== null && (role !== 'builder' || row?.maps == null || row.maps.includes(mapId));
    if (!builds) throw fail(403, 'Нет права строить на этой карте.');
    id = writeRequest(inboxDir(), actor, { kind: 'candidate', mapId });
    return Response.json({ id }, { headers: noStore });
  } catch (thrown) {
    error = thrown instanceof Response ? await thrown.clone().json().then(d => d.error, () => 'error') : 'internal error';
    throw thrown;
  } finally {
    await store.audit({ actorUuid: actor.uuid, actorName: actor.name, role: role ?? 'none', action: 'workshop-candidate', target: mapId,
      detail: { from: 'game', request: id }, ok: error === null, error });
  }
}

export async function handleWorkshopAccess(request: Request, env: Record<string, string | undefined> = process.env, storage?: StatsStore): Promise<Response> {
  const refused = workshopKeyError(request, env);
  if (refused) return refused;
  const body = await readJson(request, 4096);
  const actorId = playerId(body?.actor), targetId = playerId(body?.target), mapId = body?.mapId;
  if (!actorId || !targetId || typeof mapId !== 'string' || !MAP_IDS.has(mapId) || typeof body?.allowed !== 'boolean') return fail(400, 'Некорректный запрос.');
  const store = storage ?? (await statsStore());
  const staff = await store.staff(), role = await roleOf(actorId, store);
  // The workshop server knows the in-game nickname; the site's own record wins when it has one.
  const claimed = typeof body?.actorName === 'string' && nickname.test(body.actorName) ? body.actorName : null;
  const actor: Actor = { uuid: actorId, name: staff.find(s => s.uuid === actorId)?.name ?? (await knownName(store, actorId)) ?? claimed ?? 'Владелец', role };
  const target = staff.find(s => s.uuid === targetId);
  let error: string | null = null, result: any = null;
  try {
    if (!role || !can(role, 'roles')) throw fail(403, 'Менять права может только администратор.');
    if (target?.role !== 'builder') throw fail(400, 'Права по картам задаются только строителям.');
    const maps = withMapAccess(target.maps ?? null, mapId, body.allowed);
    await store.setStaffMaps(targetId, maps);
    const sync = await syncWorkshop(store, actor).then(({ id }) => ({ id }), (e: unknown) => ({ error: e instanceof Response ? 'Не удалось отправить список в мастерскую.' : String((e as Error).message) }));
    result = { mapId, name: target.name, maps, sync };
    return result instanceof Response ? result : Response.json(result, { headers: noStore });
  } catch (thrown) {
    error = thrown instanceof Response ? await thrown.clone().json().then(d => d.error, () => 'error') : 'internal error';
    throw thrown;
  } finally {
    await store.audit({ actorUuid: actor.uuid, actorName: actor.name, role: role ?? 'none', action: 'workshop-map-access', target: mapId,
      detail: { changed: result ? [result.name] : [], allowed: body.allowed, target: target?.name ?? targetId, from: 'game', sync: result?.sync }, ok: error === null, error });
  }
}

/** Every /api/admin/* call: session → role → permission; every non-GET is audited, including refusals and failures. */
export async function handleAdmin(context: APIContext, path: string, storage?: StatsStore): Promise<Response> {
  const method = context.request.method;
  let store: StatsStore, actor: Actor;
  // Roles and the audit log live in the statistics DB: without it nobody gets in.
  try { store = storage ?? (await statsStore()); actor = await currentActor(context, store); }
  catch (error) { if (error instanceof StatsError) throw fail(503, 'Хранилище сайта недоступно: админка отключена.'); throw error; }
  if (method === 'GET' && path === 'me') return Response.json({ uuid: actor.uuid, name: actor.name, role: actor.role, permissions: permissions(actor.role) }, { headers: noStore });
  const route = routes[`${method} ${path}`];
  if (!route) return fail(404, 'Неизвестный запрос.');
  // Non-staff are refused before the body is read and never reach the audit log, so they cannot grow it.
  if (!actor.role) return fail(403, 'Нет доступа.');
  let body: any, result: any;
  try {
    if (!can(actor.role, route.permission)) throw fail(403, 'Недостаточно прав.');
    if (method !== 'GET') body = await readJson(context.request, 65_536);
    result = await route.handler({ context, actor, store, body });
    if (method !== 'GET') await record(store, actor, route, body, result, null);
    return result instanceof Response ? result : Response.json(result, { headers: noStore });
  } catch (thrown) {
    const error = thrown instanceof StatsError ? fail(thrown.status, thrown.message) : thrown;
    const message = error instanceof Response ? await error.clone().json().then(d => d.error, () => 'error') : 'internal error';
    if (method !== 'GET') await record(store, actor, route, body, result, (error as any)?.internal ? `${message} (${(error as any).internal})` : message);
    throw error;
  }
}
async function record(store: StatsStore, actor: Actor, route: Route, body: any, result: any, error: string | null) {
  const entry = (await route.audit?.(body, result)) ?? { action: 'unknown' };
  await store.audit({ actorUuid: actor.uuid, actorName: actor.name, role: actor.role ?? 'none', ...entry, ok: error === null, error });
}
