import type { APIContext } from 'astro';
import { randomUUID } from 'node:crypto';
import { openSync, readSync, closeSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { account, drasl, fail, nickname, readJson, token } from './account.ts';
import { rcon } from './rcon.ts';
import { currentRooms, roomId } from './rooms.ts';
import { resolveNames, seasons, statsStore, StatsError, UNKNOWN_PLAYER, type StatsStore } from './stats.ts';
import { BALANCE_LABELS, BALANCE_SCOPES } from './game-names.ts';

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
export function roleOf(uuid: string, store: StatsStore, ownerIds = owners()): Role | null {
  if (ownerIds.has(uuid)) return 'owner';
  const role = store.staff().find(s => s.uuid === uuid)?.role;
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
  return { ...who, role: who.uuid ? roleOf(who.uuid, store) : null };
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

export type WorkshopMember = { draslId: string; name: string; role: 'admin' | 'lead' | 'builder' };
const WORKSHOP_ROLE: Record<Role, WorkshopMember['role']> = { owner: 'admin', admin: 'admin', moderator: 'lead', builder: 'builder' };
export function workshopMembers(staff: { uuid: string; name: string; role: string }[], ownerNames: Map<string, string>): WorkshopMember[] {
  const members = new Map<string, WorkshopMember>();
  for (const s of staff) if (s.role in WORKSHOP_ROLE) members.set(s.uuid, { draslId: s.uuid, name: s.name, role: WORKSHOP_ROLE[s.role as Role] });
  for (const [uuid, name] of ownerNames) members.set(uuid, { draslId: uuid, name, role: 'admin' });
  return [...members.values()].sort((a, b) => a.draslId.localeCompare(b.draslId));
}

/** Validates a UI request and writes it to the controller inbox. Returns the request id. */
export function writeRequest(directory: string, actor: Actor, body: any): string {
  const base = { schema: 1, id: randomUUID(), kind: body?.kind, actor: { draslId: actor.uuid, name: actor.name }, createdAt: Date.now() };
  let request: Record<string, unknown>;
  if (body?.kind === 'mode') {
    if (!['game', 'workshop'].includes(body.profile)) throw bad('Режим: game или workshop.');
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw bad('Нет ревизии состояния: обновите страницу.');
    if (body.recover !== undefined && typeof body.recover !== 'boolean') throw bad('Некорректный запрос.');
    if (body.recover && body.profile !== 'game') throw bad('Восстановление возможно только в игровой режим.');
    if (body.recover && !can(actor.role, 'recover')) throw fail(403, 'Восстановление доступно администратору.');
    request = { ...base, profile: body.profile, expectedRevision: body.expectedRevision, ...(body.recover ? { recover: true } : {}) };
  } else if (body?.kind === 'message') {
    // Same rule as the controller: strip control characters (Unicode Cc) and §, keep format characters such as ZWJ.
    const message = typeof body.message === 'string' ? body.message.replace(/[\p{Cc}§]/gu, '').trim() : null;
    if (message === null || [...message].length > 200) throw bad('Сообщение: до 200 символов.');
    request = { ...base, message };
  } else if (body?.kind === 'members') {
    const valid = Array.isArray(body.members) && body.members.every((m: any) => playerId(m?.draslId) === m.draslId && nickname.test(m.name) && ['admin', 'lead', 'builder'].includes(m.role));
    if (!valid) throw bad('Некорректный список участников.');
    request = { ...base, members: body.members.map(({ draslId, name, role }: WorkshopMember) => ({ draslId, name, role })) };
  } else throw bad('Неизвестный тип запроса.');
  writeAtomic(directory, `${base.id}.json`, request);
  return base.id;
}

const range = (min: number, max: number) => (v: unknown) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const LOBBY: Record<string, (v: unknown) => boolean> = { pvpEnabled: v => typeof v === 'boolean', pvpCooldownSeconds: range(0, 600) };
const ROOMS: Record<string, (v: unknown) => boolean> = { maxRooms: range(1, 16), idleCloseSeconds: range(30, 3600), abandonCloseSeconds: range(5, 600) };
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
  if (!plain(body) || Object.keys(body).some(k => !['expectedRevision', 'lobby', 'rooms', 'classLocks', 'campaignBalance'].includes(k))) throw bad('Некорректные настройки.');
  const out: Record<string, unknown> = {};
  if (body.lobby !== undefined) out.lobby = section(body.lobby, LOBBY, 'лобби');
  if (body.rooms !== undefined) out.rooms = section(body.rooms, ROOMS, 'комнаты');
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
function knownName(store: StatsStore, uuid: string): string | null {
  const dashed = uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const row = store.db.prepare('SELECT name FROM profiles WHERE uuid=?').get(dashed) as { name: string } | undefined;
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
  for (const uuid of owners()) names.set(uuid, await resolve(uuid).catch(error => knownName(store, uuid) ?? Promise.reject(error)));
  const members = workshopMembers(store.staff(), names);
  const id = writeRequest(inboxDir(), actor, { kind: 'members', members });
  return { id, members };
}

/**
 * Players banned through the site: the latest successful ban/pardon per nickname in the audit log.
 * ponytail: bans made in-game or older than the newest 10 000 audit rows are not listed (RCON `banlist` output has no separators to parse); «Разбанить по нику» covers them.
 */
export function siteBans(store: StatsStore) {
  const rows = store.db.prepare(`SELECT action,target,actor_name actorName,at,detail FROM admin_audit WHERE ok=1 AND action IN ('rcon:ban','rcon:pardon') AND target IS NOT NULL ORDER BY id`).all() as any[];
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
  'GET overview': { permission: 'view', handler: async () => ({ status: readFile(join(adminDir(), 'status.json')), rooms: await currentRooms() }) },
  'GET request': { permission: 'view', handler: ({ context }) => {
    const id = context.url.searchParams.get('id') ?? '';
    if (!UUID.test(id)) throw bad('Некорректный запрос.');
    return { result: readFile(join(adminDir(), 'results', `${id}.json`)) };
  } },
  'POST mode': { permission: 'mode', handler: ({ actor, body }) => ({ id: writeRequest(inboxDir(), actor, { ...body, kind: 'mode' }) }),
    audit: body => ({ action: 'mode', target: String(body?.profile), detail: { expectedRevision: body?.expectedRevision, recover: body?.recover === true } }) },
  'POST message': { permission: 'message', handler: ({ actor, body }) => ({ id: writeRequest(inboxDir(), actor, { kind: 'message', message: body?.message }) }),
    audit: body => ({ action: 'message', detail: { message: body?.message } }) },
  'POST rcon': { permission: 'moderate', handler: async ({ actor, body }) => {
    const { permission, commands } = rconCommand(body);
    if (!can(actor.role, permission)) throw fail(403, 'Недостаточно прав.');
    // Room ids are not meaningful to people: keep the room's name and map for the audit log.
    const found = body.action === 'stop-room' ? (await currentRooms()).rooms.find(r => r.id === body.roomId) : undefined;
    const room = found ? { name: found.name, map: found.map } : undefined;
    const env = process.env;
    if (!env.BLOCKFIELD_RCON_HOST || !env.BLOCKFIELD_RCON_PASSWORD) throw fail(503, 'RCON не настроен на сайте.');
    const outputs = await rcon(commands, { host: env.BLOCKFIELD_RCON_HOST, port: Number(env.BLOCKFIELD_RCON_PORT || 25575), password: env.BLOCKFIELD_RCON_PASSWORD })
      .catch((error: Error) => { console.error('RCON failed', error.message); throw hidden(502, 'Игровой сервер не отвечает.', error.message); });
    const output = stripColors(outputs.at(-1) ?? '');
    const rejected = outputs.map(stripColors).find(rejectedByServer);
    if (rejected !== undefined) throw fail(502, `Сервер не принял команду: ${rejected.slice(0, 200)}`);
    return { output, room, players: body.action === 'list' ? (output.split(':')[1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : undefined };
  }, audit: (body, result) => ({ action: `rcon:${body?.action}`, target: body?.player ?? body?.roomId ?? body?.classId ?? body?.op ?? null, detail: { ...body, room: result?.room, output: result?.output?.slice(0, 500) } }) },
  'GET bans': { permission: 'ban', handler: ({ store }) => ({ bans: siteBans(store) }) },
  'GET settings': { permission: 'settings', handler: () => ({ ...readSettings(settingsDir()), balance: BALANCE }) },
  'PUT settings': { permission: 'settings', handler: ({ actor, body }) => ({ settings: saveSettings(settingsDir(), body, actor.name) }),
    audit: (body, result) => ({ action: 'settings', target: result?.settings ? `revision ${result.settings.revision}` : null, detail: body }) },
  'GET staff': { permission: 'roles', handler: async ({ actor, store }) => {
    const ids = owners();
    await Promise.all([...ids].map(uuid => ownerName(uuid).catch(() => null)));
    const last = (store.auditLog(200) as any[]).find(e => e.action === 'workshop-sync' && e.ok && e.target);
    const lastSync = last ? { id: last.target, at: last.at, result: readFile(join(adminDir(), 'results', `${last.target}.json`)) } : null;
    const name = (uuid: string) => ownerNames.get(uuid) ?? knownName(store, uuid) ?? (uuid === actor.uuid ? actor.name : null);
    return { owners: [...ids].map(uuid => ({ uuid, name: name(uuid) ?? UNKNOWN_PLAYER })), staff: store.staff(), workshop: readFile(join(adminDir(), 'members.json')),
      expected: workshopMembers(store.staff(), new Map([...ids].map(uuid => [uuid, name(uuid) ?? '']))), lastSync };
  } },
  'POST staff': { permission: 'roles', handler: async ({ actor, store, body }) => {
    if (body?.role !== null && !['builder', 'moderator', 'admin'].includes(body?.role)) throw bad('Неизвестная роль.');
    const target = body?.uuid ? { uuid: playerId(body.uuid), name: store.staff().find(s => s.uuid === playerId(body.uuid))?.name } : await lookupName(body?.name);
    if (!target.uuid || !target.name) throw fail(404, 'Участник не найден.');
    checkRoleChange(actor, target.uuid, roleOf(target.uuid, store), body.role);
    store.setStaff(target.uuid, target.name, body.role, actor.name);
    const sync = await syncWorkshop(store, actor).then(({ id }) => ({ id }), (error: unknown) => ({ error: error instanceof Response ? 'Не удалось отправить список в мастерскую.' : String((error as Error).message) }));
    return { uuid: target.uuid, name: target.name, role: body.role, sync };
  }, audit: (body, result) => ({ action: body?.role === null ? 'role-revoke' : 'role-grant', target: result?.uuid ?? body?.uuid ?? body?.name ?? null, detail: { name: result?.name ?? body?.name, role: body?.role, sync: result?.sync } }) },
  'POST staff/sync': { permission: 'workshop', handler: async ({ actor, store }) => syncWorkshop(store, actor), audit: (_, result) => ({ action: 'workshop-sync', target: result?.id ?? null, detail: { members: result?.members } }) },
  'GET results': { permission: 'stats', handler: async ({ context, store }) => {
    const load = () => store.results(context.url.searchParams.get('mode') || null, page(context.url)), data = load();
    const unknown = data.results.flatMap(r => r.players.filter(p => p.name === UNKNOWN_PLAYER).map(p => p.uuid));
    return unknown.length && (await resolveNames(store, unknown)).size ? load() : data;
  } },
  'POST results/void': { permission: 'stats', handler: ({ actor, store, body }) => {
    if (!UUID.test(body?.serverId) || !UUID.test(body?.eventId) || typeof body.voided !== 'boolean') throw bad('Некорректный результат.');
    return store.setVoided(body.serverId, body.eventId, body.voided ? actor.name : null);
  }, audit: (body, result) => ({ action: body?.voided ? 'result-void' : 'result-restore', target: `${body?.serverId}/${body?.eventId}`, detail: result?.match }) },
  'GET keys': { permission: 'stats', handler: ({ store }) => ({ keys: store.ingestKeys() }) },
  'POST keys': { permission: 'stats', handler: ({ store, body }) => {
    if (!UUID.test(body?.serverId)) throw bad('ID сервера — UUID.');
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 64 || /[\x00-\x1f\x7f]/.test(body.label)) throw bad('Подпись: до 64 символов.');
    return { key: store.createIngestKey(body.serverId, body.label.trim()) };
  }, audit: body => ({ action: 'ingest-key-create', target: body?.serverId ?? null, detail: { label: body?.label } }) },
  'POST keys/revoke': { permission: 'stats', handler: ({ store, body }) => {
    if (!Number.isSafeInteger(body?.id) || !store.revokeIngestKey(body.id)) throw fail(404, 'Ключ не найден или уже отозван.');
    return { revoked: body.id };
  }, audit: body => ({ action: 'ingest-key-revoke', target: String(body?.id) }) },
  'GET seasons': { permission: 'stats', handler: () => ({ seasons: seasons() }) },
  'GET audit': { permission: 'audit', handler: ({ store }) => ({ entries: store.auditLog(200) }) },
};

/** Every /api/admin/* call: session → role → permission; every non-GET is audited, including refusals and failures. */
export async function handleAdmin(context: APIContext, path: string, storage?: StatsStore): Promise<Response> {
  const method = context.request.method;
  let store: StatsStore, actor: Actor;
  // Roles and the audit log live in the statistics DB: without it nobody gets in.
  try { store = storage ?? statsStore(); actor = await currentActor(context, store); }
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
    if (method !== 'GET') record(store, actor, route, body, result, null);
    return Response.json(result, { headers: noStore });
  } catch (thrown) {
    const error = thrown instanceof StatsError ? fail(thrown.status, thrown.message) : thrown;
    const message = error instanceof Response ? await error.clone().json().then(d => d.error, () => 'error') : 'internal error';
    if (method !== 'GET') record(store, actor, route, body, result, (error as any)?.internal ? `${message} (${(error as any).internal})` : message);
    throw error;
  }
}
function record(store: StatsStore, actor: Actor, route: Route, body: any, result: any, error: string | null) {
  const entry = route.audit?.(body, result) ?? { action: 'unknown' };
  store.audit({ actorUuid: actor.uuid, actorName: actor.name, role: actor.role ?? 'none', ...entry, ok: error === null, error });
}
