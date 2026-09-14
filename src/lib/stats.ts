/** Durable, Minecraft-independent result ingestion. Node >=22.19; no browser imports. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { composite, inflate, initial, softReset, update, RULES_VERSION } from './glicko2.ts';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID = /^[a-z0-9_.:-]{1,128}$/;
const MAX_BODY = 1_048_576;
const MODES = ['room', 'campaign', 'deathmatch'];
const REASONS = ['completed', 'draw', 'abandoned', 'stopped', 'shutdown', 'error'];
const COUNTERS = ['kills', 'deaths', 'captures', 'neutralizations', 'pointSeconds', 'playSeconds', 'suicides', 'teamKills', 'maxKillstreak'] as const;
const SORTS: Record<string, string> = { score: 'score', kills: 'kills', captures: 'captures', pointSeconds: 'pointSeconds', playSeconds: 'playSeconds', wins: 'wins', kd: 'kd', rating: 'COALESCE(rating,-1)' };
/** An idle week is one Glicko-2 rating period: RD grows before the next rated campaign. */
const RATING_PERIOD_MS = 7 * 86400000;
function mmr(row: { rating: number | null; rd: number | null; ratedCampaigns: number | null }) {
  return row.rating === null ? null : { rating: Math.round(row.rating), rd: Math.round(row.rd!), ratedCampaigns: row.ratedCampaigns!, provisional: row.ratedCampaigns! < 5 || row.rd! > 150 };
}
export type ClassResult = { classId: string; variantId: string; timeSeconds: number; kills: number; deaths: number; pointSeconds: number };
export type Participant = { uuid: string; name: string; team: 'RED' | 'BLUE' | 'NONE'; score: number; classes: ClassResult[] } & Record<typeof COUNTERS[number], number>;
export type Result = {
  schemaVersion: 1; eventId: string; serverId: string; kind: 'match' | 'campaign';
  sessionPurpose: 'gameplay'; modeId: string; ranked: boolean; rulesetVersion: string;
  matchId: string | null; campaignSessionId: string | null; mapId: string | null;
  startedAt: string; endedAt: string; endReason: string; winner: 'RED' | 'BLUE' | 'NONE';
  participants: Participant[]; rounds: string[];
  winnerUuid?: string; // Additive FFA result; absent legacy fields stay absent for replay digests.
};
export class StatsError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StatsError(422, message);
}
function integer(value: unknown, max = 1_000_000_000): boolean { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max; }
function utc(value: unknown): number {
  requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value), 'UTC timestamp required');
  const time = Date.parse(value as string); requireValue(Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === (value as string).slice(0, 19), 'Invalid timestamp'); return time;
}
/** Strict allow-list of gameplay producers: training/playtest never reaches the aggregate tables. */
export function validateResult(value: any, now = Date.now()): Result {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Result object required');
  requireValue(value.schemaVersion === 1 && typeof value.eventId === 'string' && UUID.test(value.eventId) && typeof value.serverId === 'string' && UUID.test(value.serverId), 'Invalid result identity/version');
  requireValue(value.sessionPurpose === 'gameplay', 'Non-gameplay results are not accepted');
  requireValue(MODES.includes(value.modeId) && typeof value.ranked === 'boolean' && value.ranked === (value.modeId === 'campaign'), 'Invalid mode/ranking context');
  requireValue(typeof value.rulesetVersion === 'string' && ID.test(value.rulesetVersion), 'Invalid ruleset version');
  requireValue(['match', 'campaign'].includes(value.kind) && REASONS.includes(value.endReason), 'Invalid finalization');
  requireValue(['RED', 'BLUE', 'NONE'].includes(value.winner), 'Invalid winner');
  requireValue(value.endReason === 'completed' || value.winner === 'NONE', 'Interrupted/drawn results cannot declare a winner');
  const start = utc(value.startedAt), end = utc(value.endedAt);
  requireValue(end >= start && end <= now + 300_000, 'Invalid result time interval');
  requireValue(Array.isArray(value.rounds) && value.rounds.length <= 10_000 && value.rounds.every((id: any) => typeof id === 'string' && UUID.test(id)) && new Set(value.rounds).size === value.rounds.length, 'Invalid round IDs');
  if (value.kind === 'match') {
    requireValue(value.matchId === value.eventId && typeof value.mapId === 'string' && ID.test(value.mapId), 'Invalid match identity/map');
    requireValue(value.campaignSessionId === null || (typeof value.campaignSessionId === 'string' && UUID.test(value.campaignSessionId)), 'Invalid campaign session ID');
    requireValue(!value.ranked || value.campaignSessionId !== null, 'Ranked match requires campaign session');
    requireValue(value.rounds.length === 0, 'A match cannot contain rounds');
  } else {
    requireValue(value.modeId === 'campaign' && value.matchId === null && value.mapId === null && value.campaignSessionId === value.eventId, 'Invalid campaign identity');
    requireValue(value.endReason !== 'completed' || value.rounds.length > 0, 'Completed campaign has no rounds');
  }
  requireValue(Array.isArray(value.participants) && value.participants.length <= 512, 'Invalid participants');
  const seen = new Set<string>();
  for (const p of value.participants) {
    requireValue(p && typeof p.uuid === 'string' && UUID.test(p.uuid) && !seen.has(p.uuid), 'Participants must be deduplicated by UUID'); seen.add(p.uuid);
    requireValue(typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 64 && !/[\x00-\x1f\x7f]/.test(p.name), 'Invalid display name');
    requireValue(['RED', 'BLUE', 'NONE'].includes(p.team) && Number.isFinite(p.score) && Math.abs(p.score) <= 1_000_000_000, 'Invalid team/score');
    requireValue(COUNTERS.every(key => integer(p[key])), 'Invalid player counters');
    requireValue(Array.isArray(p.classes) && p.classes.length <= 256, 'Invalid class breakdown');
    const classes = new Set<string>();
    for (const c of p.classes) {
      requireValue(c && typeof c.classId === 'string' && ID.test(c.classId) && typeof c.variantId === 'string' && ID.test(c.variantId), 'Stable class/variant IDs required');
      const key = `${c.classId}/${c.variantId}`;
      requireValue(!classes.has(key), 'Duplicate class breakdown'); classes.add(key);
      requireValue(['timeSeconds', 'kills', 'deaths', 'pointSeconds'].every(key => integer(c[key])), 'Invalid class counters');
    }
  }
  const hasPersonalWinner = Object.hasOwn(value, 'winnerUuid');
  if (hasPersonalWinner) {
    requireValue(value.modeId === 'deathmatch' && value.kind === 'match' && value.endReason === 'completed'
      && value.winner === 'NONE' && value.campaignSessionId === null, 'Personal winner requires a completed FFA match');
    requireValue(typeof value.winnerUuid === 'string' && UUID.test(value.winnerUuid) && seen.has(value.winnerUuid), 'Personal winner must belong to the match');
    requireValue(value.participants.every((p: Participant) => p.team === 'NONE'), 'FFA participants cannot declare teams');
  }
  // Return only the public contract; never persist arbitrary producer-supplied fields or secrets.
  return {
    schemaVersion: 1, eventId: value.eventId, serverId: value.serverId, kind: value.kind,
    sessionPurpose: 'gameplay', modeId: value.modeId, ranked: value.ranked, rulesetVersion: value.rulesetVersion,
    matchId: value.matchId, campaignSessionId: value.campaignSessionId, mapId: value.mapId,
    startedAt: value.startedAt, endedAt: value.endedAt, endReason: value.endReason, winner: value.winner,
    ...(hasPersonalWinner ? { winnerUuid: value.winnerUuid } : {}),
    rounds: [...value.rounds].sort(), participants: value.participants.map((p: any) => ({
      uuid: p.uuid, name: p.name, team: p.team, score: p.score,
      ...Object.fromEntries(COUNTERS.map(key => [key, p[key]])),
      classes: p.classes.map((c: any) => ({ classId: c.classId, variantId: c.variantId, timeSeconds: c.timeSeconds, kills: c.kills, deaths: c.deaths, pointSeconds: c.pointSeconds }))
        .sort((a: ClassResult, b: ClassResult) => `${a.classId}/${a.variantId}`.localeCompare(`${b.classId}/${b.variantId}`)),
    })).sort((a: Participant, b: Participant) => a.uuid.localeCompare(b.uuid)),
  } as Result;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Season 1 starts with the production stats export; later seasons are UTC calendar quarters. */
export const SEASON_ONE_STARTS_AT = Date.UTC(2026, 8, 14);
export type Season = { id: string; name: string; startsAt: string; endsAt: string };
/** Started seasons, oldest first. endsAt is inclusive (1 ms before the next season starts). */
export function seasons(now = Date.now()): Season[] {
  const list: Season[] = [];
  for (let start = SEASON_ONE_STARTS_AT, n = 1; start <= now; n++) {
    // Season 1 absorbs the rest of 2026 Q3; every later season starts on a quarter boundary.
    const date = new Date(start), next = n === 1 ? Date.UTC(2027, 0, 1) : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, 1);
    list.push({ id: `s${n}`, name: `Сезон ${n}`, startsAt: new Date(start).toISOString(), endsAt: new Date(next - 1).toISOString() });
    start = next;
  }
  return list;
}
/** The season containing a timestamp; anything before season 1 belongs to season 1. */
export function seasonAt(time: number): Season { return seasons(Math.max(time, SEASON_ONE_STARTS_AT)).at(-1)!; }
export type Filters = { mode: string | null; season: string | null; mmrSeason: string; since: number; until: number; sort: string; limit: number; page: number };
export function filters(params: URLSearchParams, now = Date.now()): Filters {
  const mode = params.get('mode') || null, season = params.get('season') || null, period = params.get('period') || 'all', sort = params.get('sort') || 'score';
  if (mode !== null && !MODES.includes(mode)) throw new StatsError(400, 'Unknown mode');
  if (!['all', 'week', 'month'].includes(period) || !Object.hasOwn(SORTS, sort)) throw new StatsError(400, 'Unknown period/sort');
  if (season !== null && params.get('period')) throw new StatsError(400, 'Use either season or period');
  const selected = season === null ? null : seasons(now).find(s => s.id === season);
  if (selected === undefined) throw new StatsError(400, 'Unknown season');
  const limitText = params.get('limit') || '25', pageText = params.get('page') || '1';
  if (!/^\d+$/.test(limitText) || !/^\d+$/.test(pageText)) throw new StatsError(400, 'Invalid pagination');
  const limit = Number(limitText), page = Number(pageText);
  if (!integer(limit, 100) || limit < 1 || !integer(page, 1000) || page < 1) throw new StatsError(400, 'Invalid pagination');
  const mmrSeason = season ?? seasonAt(now).id;
  if (selected) return { mode, season, mmrSeason, since: Date.parse(selected.startsAt), until: Date.parse(selected.endsAt), sort, limit, page };
  return { mode, season, mmrSeason, since: period === 'all' ? 0 : now - (period === 'week' ? 7 : 30) * 86400000, until: now + 300000, sort, limit, page };
}
export class StatsStore {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') { if (!isAbsolute(path)) throw new Error('BLOCKFIELD_STATS_DB must be absolute'); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (![0, 1, 2, 3].includes(version.user_version)) { this.db.close(); throw new Error('Unsupported statistics schema; restore/migrate explicitly'); }
    this.db.function('season_at', (time: any) => seasonAt(Number(time)).id);
    const columns = (table: string) => (this.db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map(c => c.name);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // v2 -> v3: lifetime ratings become per-season rows; existing rows move to the season of their rating time.
      const legacyRatings = columns('ratings').length > 0 && !columns('ratings').includes('season_id');
      if (legacyRatings) this.db.exec('ALTER TABLE ratings RENAME TO ratings_v2');
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL,
        campaign_id TEXT, ended_at INTEGER NOT NULL, reason TEXT NOT NULL, winner TEXT NOT NULL,
        digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(server_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS results_mode_time ON results(mode,ended_at);
      CREATE TABLE IF NOT EXISTS profiles (uuid TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, uuid TEXT NOT NULL, team TEXT NOT NULL,
        score REAL NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, captures INTEGER NOT NULL,
        neutralizations INTEGER NOT NULL, point_seconds INTEGER NOT NULL, play_seconds INTEGER NOT NULL,
        suicides INTEGER NOT NULL, team_kills INTEGER NOT NULL, max_streak INTEGER NOT NULL,
        PRIMARY KEY(server_id,event_id,uuid), FOREIGN KEY(server_id,event_id) REFERENCES results(server_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS participants_uuid ON participants(uuid);
      CREATE TABLE IF NOT EXISTS classes (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, uuid TEXT NOT NULL, class_id TEXT NOT NULL, variant_id TEXT NOT NULL,
        time_seconds INTEGER NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, point_seconds INTEGER NOT NULL,
        PRIMARY KEY(server_id,event_id,uuid,class_id,variant_id),
        FOREIGN KEY(server_id,event_id,uuid) REFERENCES participants(server_id,event_id,uuid)
      );
      CREATE TABLE IF NOT EXISTS ratings (
        season_id TEXT NOT NULL, uuid TEXT NOT NULL, rating REAL NOT NULL, rd REAL NOT NULL, volatility REAL NOT NULL,
        rated_campaigns INTEGER NOT NULL, last_rated_at INTEGER NOT NULL, PRIMARY KEY(season_id,uuid)
      );
      CREATE TABLE IF NOT EXISTS rating_changes (
        server_id TEXT NOT NULL, event_id TEXT NOT NULL, uuid TEXT NOT NULL, rules_version TEXT NOT NULL, team TEXT NOT NULL,
        score REAL NOT NULL, opp_rating REAL NOT NULL, opp_rd REAL NOT NULL,
        before_rating REAL NOT NULL, before_rd REAL NOT NULL, before_volatility REAL NOT NULL,
        after_rating REAL NOT NULL, after_rd REAL NOT NULL, after_volatility REAL NOT NULL, rated_at INTEGER NOT NULL, season_id TEXT NOT NULL,
        PRIMARY KEY(server_id,event_id,uuid), FOREIGN KEY(server_id,event_id) REFERENCES results(server_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS rating_changes_uuid ON rating_changes(uuid,rated_at);
      `);
      if (legacyRatings) this.db.exec(`INSERT INTO ratings SELECT season_at(last_rated_at),uuid,rating,rd,volatility,rated_campaigns,last_rated_at FROM ratings_v2;
        DROP TABLE ratings_v2;`);
      if (!columns('rating_changes').includes('season_id')) this.db.exec(`ALTER TABLE rating_changes ADD COLUMN season_id TEXT NOT NULL DEFAULT '';
        UPDATE rating_changes SET season_id=season_at(rated_at);`);
      this.db.exec('PRAGMA user_version=3; COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  ingest(input: unknown): { inserted: boolean; eventId: string } {
    const result = validateResult(input), payload = canonical(result), digest = createHash('sha256').update(payload).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT digest FROM results WHERE server_id=? AND event_id=?').get(result.serverId, result.eventId) as { digest: string } | undefined;
      if (existing) {
        if (existing.digest !== digest) throw new StatsError(409, 'Result ID already exists with different content');
        this.db.exec('COMMIT'); return { inserted: false, eventId: result.eventId };
      }
      this.db.prepare('INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?)').run(result.serverId, result.eventId, result.kind, result.modeId, result.campaignSessionId, Date.parse(result.endedAt), result.endReason, result.winner, digest, payload);
      const participant = this.db.prepare('INSERT INTO participants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const profile = this.db.prepare('INSERT INTO profiles VALUES (?,?,?) ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen WHERE excluded.last_seen>=profiles.last_seen');
      const cls = this.db.prepare('INSERT INTO classes VALUES (?,?,?,?,?,?,?,?,?)');
      for (const p of result.participants) {
        profile.run(p.uuid, p.name, Date.parse(result.endedAt));
        participant.run(result.serverId, result.eventId, p.uuid, p.team, p.score, p.kills, p.deaths, p.captures, p.neutralizations, p.pointSeconds, p.playSeconds, p.suicides, p.teamKills, p.maxKillstreak);
        for (const c of p.classes) cls.run(result.serverId, result.eventId, p.uuid, c.classId, c.variantId, c.timeSeconds, c.kills, c.deaths, c.pointSeconds);
      }
      // Only a fresh insert rates: outbox replays return above, so one campaign changes MMR at most once.
      if (result.kind === 'campaign' && result.modeId === 'campaign' && ['completed', 'draw'].includes(result.endReason)) this.rate(result);
      this.db.exec('COMMIT'); return { inserted: true, eventId: result.eventId };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /**
   * One Glicko-2 period per rated player: the whole opposing side as a composite opponent. Team NONE is unrated.
   * The season comes from endedAt. A player's first campaign in a season starts from their latest earlier season, soft-reset once per boundary crossed.
   * ponytail: a late result rates only its own season; later seasons that already carried over from it are not recomputed.
   * Replay rating_changes in endedAt order per season if late cross-season results become common.
   */
  private rate(result: Result) {
    const sides = { RED: result.participants.filter(p => p.team === 'RED'), BLUE: result.participants.filter(p => p.team === 'BLUE') };
    if (!sides.RED.length || !sides.BLUE.length) return;
    const ended = Date.parse(result.endedAt), season = seasonAt(ended), seasonNumber = Number(season.id.slice(1));
    const periods = (since: number) => Math.floor(Math.max(0, ended - since) / RATING_PERIOD_MS);
    const load = this.db.prepare('SELECT rating,rd,volatility,rated_campaigns ratedCampaigns,last_rated_at lastRatedAt FROM ratings WHERE season_id=? AND uuid=?');
    const carry = this.db.prepare(`SELECT rating,rd,volatility,CAST(substr(season_id,2) AS INTEGER) seasonNumber FROM ratings
      WHERE uuid=? AND CAST(substr(season_id,2) AS INTEGER)<? ORDER BY seasonNumber DESC LIMIT 1`);
    const before = new Map([...sides.RED, ...sides.BLUE].map(p => {
      const row = load.get(season.id, p.uuid) as { rating: number; rd: number; volatility: number; ratedCampaigns: number; lastRatedAt: number } | undefined;
      const previous = row ? undefined : carry.get(p.uuid, seasonNumber) as { rating: number; rd: number; volatility: number; seasonNumber: number } | undefined;
      const rating = row ? inflate({ rating: row.rating, rd: row.rd, volatility: row.volatility }, periods(row.lastRatedAt))
        : previous ? inflate(softReset(previous, seasonNumber - previous.seasonNumber), periods(Date.parse(season.startsAt))) : initial();
      return [p.uuid, { rating, campaigns: row?.ratedCampaigns ?? 0 }];
    }));
    const save = this.db.prepare(`INSERT INTO ratings (season_id,uuid,rating,rd,volatility,rated_campaigns,last_rated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(season_id,uuid) DO UPDATE SET rating=excluded.rating,rd=excluded.rd,
      volatility=excluded.volatility,rated_campaigns=excluded.rated_campaigns,last_rated_at=MAX(ratings.last_rated_at,excluded.last_rated_at)`);
    const change = this.db.prepare('INSERT INTO rating_changes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const team of ['RED', 'BLUE'] as const) {
      const opponent = composite(sides[team === 'RED' ? 'BLUE' : 'RED'].map(o => before.get(o.uuid)!.rating));
      const score = result.endReason === 'draw' ? 0.5 : result.winner === team ? 1 : 0;
      for (const p of sides[team]) {
        const { rating: from, campaigns } = before.get(p.uuid)!, to = update(from, [{ opponent, score }]);
        save.run(season.id, p.uuid, to.rating, to.rd, to.volatility, campaigns + 1, ended);
        change.run(result.serverId, result.eventId, p.uuid, RULES_VERSION, team, score, opponent.rating, opponent.rd,
          from.rating, from.rd, from.volatility, to.rating, to.rd, to.volatility, ended, season.id);
      }
    }
  }
  leaderboard(query: Filters, uuid: string | null = null) {
    // Campaign summaries contain the same players/counters: count combat metrics from MATCHES ONLY.
    const where = `r.kind='match' AND r.ended_at>=? AND r.ended_at<=? AND (? IS NULL OR r.mode=?)`;
    const args = [query.since, query.until, query.mode, query.mode];
    // rank is numbered over the whole filtered aggregate BEFORE the uuid/page cut, so a player's rank matches the board.
    const rows = this.db.prepare(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER (ORDER BY ${SORTS[query.sort]} DESC,uuid ASC) "rank" FROM (
      SELECT p.uuid,pr.name,SUM(p.score) score,SUM(p.kills) kills,SUM(p.deaths) deaths,
      SUM(p.captures) captures,SUM(p.neutralizations) neutralizations,SUM(p.point_seconds) pointSeconds,
      SUM(p.play_seconds) playSeconds,SUM(p.suicides) suicides,SUM(p.team_kills) teamKills,MAX(p.max_streak) maxKillstreak,
      COUNT(*) matches,SUM(CASE WHEN r.reason='completed' AND (
        (r.mode='deathmatch' AND json_extract(r.payload,'$.winnerUuid')=p.uuid) OR
        (r.mode!='deathmatch' AND p.team!='NONE' AND r.winner=p.team)
      ) THEN 1 ELSE 0 END) wins,
      ROUND(SUM(p.kills)*1.0/MAX(1,SUM(p.deaths)),3) kd,
      MAX(rt.rating) rating,MAX(rt.rd) rd,MAX(rt.rated_campaigns) ratedCampaigns
      FROM participants p JOIN results r USING(server_id,event_id) JOIN profiles pr ON pr.uuid=p.uuid LEFT JOIN ratings rt ON rt.season_id=? AND rt.uuid=p.uuid
      WHERE ${where} GROUP BY p.uuid)) WHERE (? IS NULL OR uuid=?) ORDER BY "rank" LIMIT ? OFFSET ?`)
      .all(query.mmrSeason, ...args, uuid, uuid, query.limit, (query.page - 1) * query.limit) as any[];
    const total = this.db.prepare(`SELECT COUNT(DISTINCT p.uuid) total FROM participants p JOIN results r USING(server_id,event_id) WHERE ${where}`).get(...args) as { total: number };
    return { schemaVersion: 1, checkedAt: new Date().toISOString(), mode: query.mode, season: query.season, mmrSeason: query.mmrSeason, page: query.page, limit: query.limit, total: total.total, ratingStatus: RULES_VERSION,
      players: rows.map(({ rating, rd, ratedCampaigns, ...row }) => ({ ...row, mmr: mmr({ rating, rd, ratedCampaigns }) })) };
  }
  player(uuid: string, query: Filters) {
    if (!UUID.test(uuid)) throw new StatsError(400, 'Invalid player UUID');
    const profile = this.db.prepare('SELECT uuid,name,last_seen lastSeen FROM profiles WHERE uuid=?').get(uuid);
    if (!profile) throw new StatsError(404, 'No recorded gameplay for this player');
    const totals = this.leaderboard({ ...query, page: 1, limit: 1 }, uuid).players[0] || null;
    const history = this.db.prepare(`SELECT r.event_id eventId,r.server_id serverId,r.kind,r.mode,r.campaign_id campaignSessionId,r.ended_at endedAt,r.reason,r.winner,json_extract(r.payload,'$.winnerUuid') winnerUuid,p.team,p.score,p.kills,p.deaths
      FROM participants p JOIN results r USING(server_id,event_id) WHERE p.uuid=? AND r.ended_at>=? AND r.ended_at<=? AND (? IS NULL OR r.mode=?)
      ORDER BY r.ended_at DESC,r.server_id,r.event_id LIMIT ? OFFSET ?`)
      .all(uuid, query.since, query.until, query.mode, query.mode, query.limit, (query.page - 1) * query.limit);
    const classes = this.db.prepare(`SELECT c.class_id classId,c.variant_id variantId,SUM(c.time_seconds) timeSeconds,SUM(c.kills) kills,SUM(c.deaths) deaths,SUM(c.point_seconds) pointSeconds
      FROM classes c JOIN results r USING(server_id,event_id) WHERE r.kind='match' AND c.uuid=? AND r.ended_at>=? AND r.ended_at<=? AND (? IS NULL OR r.mode=?)
      GROUP BY c.class_id,c.variant_id ORDER BY timeSeconds DESC,c.class_id,c.variant_id`).all(uuid, query.since, query.until, query.mode, query.mode);
    const campaigns = this.db.prepare(`SELECT COUNT(*) completed,COALESCE(SUM(CASE WHEN r.winner=p.team AND p.team!='NONE' THEN 1 ELSE 0 END),0) wins
      FROM participants p JOIN results r USING(server_id,event_id) WHERE r.kind='campaign' AND r.reason IN ('completed','draw') AND p.uuid=?
      AND r.ended_at>=? AND r.ended_at<=? AND (? IS NULL OR r.mode=?)`).get(uuid, query.since, query.until, query.mode, query.mode);
    // mmr and ratingHistory belong to mmrSeason (selected or current); history is also cut to the requested window (Ranked campaigns only).
    const rating = this.db.prepare('SELECT rating,rd,rated_campaigns ratedCampaigns FROM ratings WHERE season_id=? AND uuid=?').get(query.mmrSeason, uuid) as any;
    const ratingHistory = this.db.prepare(`SELECT event_id campaignSessionId,rated_at ratedAt,team,score,ROUND(before_rating) before,ROUND(after_rating) after,ROUND(after_rd) rd
      FROM rating_changes WHERE uuid=? AND season_id=? AND rated_at>=? AND rated_at<=? AND (? IS NULL OR ?='campaign') ORDER BY rated_at DESC,event_id LIMIT 20`)
      .all(uuid, query.mmrSeason, query.since, query.until, query.mode, query.mode);
    return { schemaVersion: 1, checkedAt: new Date().toISOString(), season: query.season, mmrSeason: query.mmrSeason, profile, totals, classes, campaigns, history, page: query.page, limit: query.limit,
      mmr: rating ? mmr(rating) : null, ratingHistory, ratingStatus: RULES_VERSION };
  }
}
let singleton: StatsStore | undefined;
export function statsStore(): StatsStore {
  if (singleton) return singleton;
  const path = process.env.BLOCKFIELD_STATS_DB;
  if (!path) throw new StatsError(503, 'Statistics storage is not configured');
  return singleton = new StatsStore(path);
}
export function ingestKeys(): Record<string, string[]> {
  try {
    const value = JSON.parse(process.env.BLOCKFIELD_STATS_INGEST_KEYS || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const result: Record<string, string[]> = {};
    for (const [server, tokens] of Object.entries(value)) {
      const list = typeof tokens === 'string' ? [tokens] : tokens;
      if (!UUID.test(server) || !Array.isArray(list) || !list.length || list.length > 2 || !list.every(t => typeof t === 'string' && /^[\x21-\x7e]{32,256}$/.test(t))) throw new Error();
      result[server] = list;
    }
    return result;
  } catch { throw new StatsError(503, 'Statistics ingestion keys are not configured correctly'); }
}
function authorized(request: Request, keys: Record<string, string[]>): string {
  const server = request.headers.get('X-Blockfield-Server-Id') || '', header = request.headers.get('Authorization') || '';
  if (!UUID.test(server) || !Object.hasOwn(keys, server)) throw new StatsError(401, 'Invalid producer credentials');
  const provided = createHash('sha256').update(header).digest();
  let match = false;
  for (const token of keys[server] || []) match = timingSafeEqual(provided, createHash('sha256').update(`Bearer ${token}`).digest()) || match;
  if (!match) throw new StatsError(401, 'Invalid producer credentials');
  return server;
}
async function boundedJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new StatsError(415, 'application/json required');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw new StatsError(413, 'Result too large');
  const reader = request.body?.getReader(); if (!reader) throw new StatsError(400, 'Result body required');
  let size = 0, timeout: ReturnType<typeof setTimeout> | undefined;
  const chunks: Uint8Array[] = [];
  const expired = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new StatsError(408, 'Body timeout')), 8000); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]); if (done) break;
      size += value.byteLength; if (size > MAX_BODY) throw new StatsError(413, 'Result too large'); chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new StatsError(400, 'Invalid JSON'); }
  } finally { clearTimeout(timeout); void reader.cancel().catch(() => {}); }
}
export async function handleStatsRequest(request: Request, dependencies?: { store: StatsStore; keys: Record<string, string[]> }): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
    if (path === '/api/stats/results') {
      if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'POST' } });
      // Authenticate before reading any request body or opening the database.
      const server = authorized(request, dependencies?.keys ?? ingestKeys()), input = validateResult(await boundedJson(request));
      if (input.serverId !== server) throw new StatsError(403, 'Producer cannot submit another server identity');
      const result = (dependencies?.store ?? statsStore()).ingest(input);
      return Response.json(result, { status: result.inserted ? 201 : 200, headers });
    }
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    if (path === '/api/stats/seasons') { const list = seasons(); return Response.json({ schemaVersion: 1, current: list.at(-1)?.id ?? null, seasons: list }, { headers }); }
    const query = filters(url.searchParams);
    if (path === '/api/stats/leaderboard') return Response.json((dependencies?.store ?? statsStore()).leaderboard(query), { headers });
    const player = /^\/api\/stats\/players\/([^/]+)$/.exec(path);
    if (player) return Response.json((dependencies?.store ?? statsStore()).player(player[1], query), { headers });
    throw new StatsError(404, 'Unknown statistics endpoint');
  } catch (error) {
    if (!(error instanceof StatsError)) console.error('Statistics storage operation failed', error instanceof Error ? error.message : 'unknown');
    return Response.json({ error: error instanceof StatsError ? error.message : 'Statistics storage unavailable' }, { status: error instanceof StatsError ? error.status : 503, headers });
  }
}
