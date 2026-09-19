# Durable statistics

Refs: netherg-io/blockfield-releases#3 and #6. This service is part of the existing Astro SSR application, **not** the retired launcher API/CMS. It does not query Minecraft to read history. Deploy the site with its own persistent storage; replacing/stopping the game backend must not replace this volume. This provides process independence, not availability through failure of a shared physical host.

## Runtime and storage

Use Node 22.19+ (the existing Astro dependency graph also requires this). Statistics uses built-in `node:sqlite`; some Node 22 releases report its experimental status. No SQLite native addon or database server is installed.

Required site environment:

```dotenv
BLOCKFIELD_STATS_DB=/data/stats/blockfield.sqlite
# Map persistent game-server UUIDs to 32+ character random producer tokens.
# During rotation an ID may map to ["current-token", "previous-token"].
BLOCKFIELD_STATS_INGEST_KEYS={"00000000-0000-4000-8000-000000000001":"REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS"}
```

Mount a **named persistent volume** at `/data/stats` owned by the image's `node` user (UID 1000). Do not commit real tokens, put them in client configs, or print them. Set the matching server ID/token on the game producer. HTTPS is required outside a private trusted network. Ingestion does not authenticate with player accounts: it accepts only server credentials and rejects submissions for another server ID.

Without `BLOCKFIELD_STATS_DB`, reads return 503 rather than an empty leaderboard. Producer keys can also be created and revoked in `/admin` (stored as SHA-256 hashes in `ingest_keys`); env and DB keys are both accepted. Without any ingestion key, writes are unauthorized. Bad key configuration fails closed. Keep one writer deployment per local SQLite volume; do not place the database on NFS or share it between hosts. Use WAL-aware SQLite backup tooling, or stop **the site only** and copy the database plus any WAL/SHM files before upgrades. Do not copy a live `.sqlite` file alone. Restore to an isolated instance and replay the producer outbox to verify a backup. Unknown database schema versions are rejected, not overwritten.

Schema is `PRAGMA user_version=4`. Versions 0, 1, 2 and 3 upgrade in place on startup inside one transaction (any failure rolls back and the site refuses to open the file). v2 → v3: `ratings` is re-keyed from `uuid` to `(season_id, uuid)` and `rating_changes` gains `season_id`; every existing row is assigned to the season that contains its `last_rated_at` / `rated_at` (before season 1 → `s1`). Nothing is recalculated: on the production data (all rated after 2026-09-14) every rating stays exactly as it was, now as season `s1`. v3 → v4 adds `results.voided_at`/`voided_by` (voided results are excluded from every read) and the tables `admin_audit`, `ingest_keys` and `staff_roles` for the admin panel (`docs/admin.md`); no existing row changes. Back up the volume before deploying; a file opened by a newer build cannot be opened by older builds.

There are no automatic deletes or destructive migrations. MMR is recalculated only when an administrator voids/restores a rated campaign. Add retention/administration policies explicitly before a large public rollout. Put public read endpoints behind reverse-proxy rate limits appropriate to the deployment.

## Contract v1

`POST /api/stats/results`, `Content-Type: application/json`, headers `Authorization: Bearer TOKEN` and `X-Blockfield-Server-Id: UUID`.

The contract is defined and strictly validated by `validateResult` in `src/lib/stats.ts`; a complete executable fixture is in `test/stats.test.mjs`. Important invariants:

- `schemaVersion: 1`, stable `serverId` and immutable UUID `eventId`.
- `kind: match`: `eventId == matchId`, immutable `mapId`; `campaignSessionId` is a session UUID, never a campaign configuration name. `rounds` is empty.
- `kind: campaign`: `eventId == campaignSessionId`, `matchId` and `mapId` are null; `rounds` contains unique match UUIDs. A completed campaign must have rounds.
- Only `sessionPurpose: gameplay`; allowed modes are `room`, `campaign`, `deathmatch`. `ranked` is true only for `campaign`.
- UTC `startedAt`/`endedAt`, `rulesetVersion`, structured `endReason` (`completed`, `draw`, `abandoned`, `stopped`, `shutdown`, `error`), winner `RED`, `BLUE` or `NONE`. Interrupted/drawn events cannot name a winner.
- `participants` is already consolidated by UUID. Use `team: NONE` for genuinely mixed/unknown team participation, not a fabricated victory. Stable class and variant IDs are required. Display names are not identity.
- All counters are finite/bounded, zero deaths produces finite K/D. Unknown fields (including accidental tokens/IPs) are discarded.

Maximum body 1 MiB, maximum 512 participants, bounded per-player class breakdown, bounded body read timeout. Declared length is not trusted: streamed bytes are counted. Credentials are checked before body parsing. Authorization tokens are compared via fixed-length SHA-256 digests and a constant-time comparison.

The result and all participant/class rows are inserted in **one transaction**. `(serverId,eventId)` is unique. Exact semantic replay returns 200 without changes; a new result returns 201. Reusing an ID with changed data returns 409 and must be quarantined/operator-reviewed by the producer, not assigned a fresh ID and replayed as another match. Other non-success responses must not be acknowledged as delivered. Aggregation reads only match rows: campaign summaries never count round kills/score twice.

## Read API

All reads are `GET`, public, `Cache-Control: no-store`, and served from SQLite only.

- `/api/stats/leaderboard?mode=campaign&season=s1&sort=score&page=1&limit=25`
- `/api/stats/players/<UUID>` with the same filters (sort only affects `totals.rank`).
- `/api/stats/seasons` → `{schemaVersion, current, seasons: [{id, name, startsAt, endsAt}]}`; only started seasons, oldest first; `current` is `null` before season 1.

Filters: `mode` = `room`, `campaign`, `deathmatch` (omitted = all). `period` = `all`, rolling `week` (7 days), rolling `month` (30 days). `season` = a started season ID; `season` together with `period` (even `period=all`), an unknown season or a future season is **400**. `sort` = `score` (default), `rating` (the MMR season's rating), `kills`, `captures`, `pointSeconds`, `playSeconds`, `wins`, `kd`. `limit` 1–100, `page` 1–1000, otherwise 400. A page past the end returns `players: []` with the real `total`.

Leaderboard response: `schemaVersion`, `checkedAt` (server read time, not last result time), `mode`, `season` (or `null`), `mmrSeason`, `page`, `limit`, `total`, `ratingStatus` (rules version, `glicko2-v1`), `players[]`. Each row: `uuid`, `name` (latest known display name), `rank`, `score`, `kills`, `deaths`, `kd`, `captures`, `neutralizations`, `pointSeconds`, `playSeconds`, `suicides`, `teamKills`, `maxKillstreak`, `matches`, `wins` (battle wins), `mmr`.

- `mmrSeason` is the season whose MMR is shown: the `season` parameter, or the current season when it is omitted (also with `period`). Label MMR with it («MMR · Сезон 1»).
- `rank` is the 1-based position under the same filter and sort, numbered over the whole filtered set: `(page-1)*limit+index+1`. Ties sort by `uuid` ascending; on `sort=rating` players without MMR in `mmrSeason` come last.
- `kd` = `kills / max(1, deaths)` rounded to 3 decimals: zero deaths gives `kd = kills`, never `Infinity`/`NaN`/`null`.
- `mmr` is `null` (no rated campaign in `mmrSeason`) or `{rating, rd, ratedCampaigns, provisional}`; `provisional` = fewer than 5 rated campaigns **in that season** or RD > 150.

Player response: `schemaVersion`, `checkedAt`, `season`, `mmrSeason`, `profile {uuid, name, lastSeen}`, `totals` (a leaderboard row incl. `rank` for this filter/sort, or `null` when the player has no battles in the filter), `classes[]`, `campaigns {completed, wins}` (numbers, `0` when none), `history[]` (paged by `page`/`limit`), `mmr` (for `mmrSeason`), `ratingHistory[]` (up to 20 MMR changes of `mmrSeason` inside the filter window; empty for non-Ranked modes), `ratingStatus`. An unknown UUID is 404; a known player with a non-matching filter is 200 with `totals: null` and empty arrays.

Combat metrics come from `kind=match` rows only; campaign summaries never add round kills/score twice.

## Outcome rules

| `endReason` | Stored | Battle/campaign winner | MMR (Ranked campaign summary only) |
| --- | --- | --- | --- |
| `completed` | yes | `winner` side (FFA: `winnerUuid`) | win = 1, loss = 0 |
| `draw` | yes | none | 0.5 for everyone |
| `abandoned`, `stopped`, `shutdown`, `error` | yes | none (a declared winner is rejected with 422) | none |

A win awarded by an administrator (`/bf stop … win TEAM`) is exported and stored as `stopped`: no winner, no MMR. MMR is Glicko-2 (`src/lib/glicko2.ts`), one operation per completed/drawn Ranked campaign per participant with team `RED`/`BLUE` (the other side is a composite opponent). Rounds, Casual and Deathmatch never rate. Rating is keyed by `(serverId, eventId, uuid)`: replays and a summary arriving before or after its rounds do not rate twice; later rounds never change ratings.

## Seasons

Default (owner can change): quarterly time windows. `s1` "Сезон 1" = `2026-09-14T00:00:00.000Z` (production export start) … `2026-12-31T23:59:59.999Z`; then each UTC calendar quarter (`s2` = 2027 Q1, …), generated by `seasons()` in `src/lib/stats.ts`, so no edits per quarter. `endsAt` is inclusive; a result is in a season by `endedAt`. Changing the first start or length changes historical season membership of results, but not the season already stored with ratings.

### Seasonal MMR with soft reset (owner decision 2026-09-14)

MMR is kept per season (`ratings` keyed by `(season_id, uuid)`). A campaign rates in the season that contains its `endedAt` (not the arrival time); a campaign ending exactly at a season start belongs to the new season. Results before season 1 rate in `s1`.

- A player's first rated campaign in a season starts from their latest earlier season, soft-reset once per season boundary crossed (`softReset` in `src/lib/glicko2.ts`): `rating = 1500 + 0.5·(previous − 1500)`, `rd = max(previous_rd, 200)`, volatility unchanged. Example: 1700 / RD 60 → 1600 / RD 200. A player who skipped a season is reset twice (1700 → 1550).
- Without any earlier season the player starts at the Glicko-2 initial state (1500 / 350 / 0.06).
- Idle RD growth (one period per full idle week) is measured inside the season: from the last rating in this season, or from the season start for a carried-over state.
- Opponent composites use the opponents' state in the same season, carried over the same way.
- `ratedCampaigns` and therefore `provisional` count campaigns within the season.

Late results: a campaign that ended in an earlier season but arrives later updates only that season's ratings. Later seasons are **not** recomputed on ingest, even if a player's carry-over was already taken from the old state. Voiding or restoring a rated campaign in `/admin` replays its season and every later season from scratch in `endedAt, serverId, eventId` order, which also folds in any earlier late results.

## Display rules (site, launcher, game)

- MMR is shown as the rounded `mmr.rating`; append `?` when `provisional`. `null` → `—`.
- K/D is shown as `kills / deaths` (raw counters), not the ratio; `kd` is for sorting.
- Score is shown with up to 2 decimals.
- Position is `rank` from the API, never recomputed from list order.
- Show `checkedAt`/stale state separately from "game server unavailable".

## For developers and AI agents

- Code: contract/validation, storage, aggregation, seasons and HTTP in `src/lib/stats.ts`; rating math in `src/lib/glicko2.ts`; route `src/pages/api/stats/[...path].ts`; tests `test/stats*.test.mjs`, `test/glicko2.test.mjs`.
- Site: `/leaderboard` and `/players/<UUID>` call `StatsStore` directly on the server; `/account` fetches `/api/stats/players/<UUID>` in the browser with the Drasl profile UUID.
- Launcher and in-game UI must read the same public HTTP endpoints and apply the display rules above; do not re-aggregate or recompute rank/MMR locally.
- The read API never calls Minecraft, RCON or Server List Ping; only the game server's producer writes, via `POST /api/stats/results`.
- The app uses the DB at `BLOCKFIELD_STATS_DB` (absolute path). For local work point it at a throwaway file and seed it by `StatsStore.ingest()` with the test fixtures; never at production data.

## Verification and remaining integration

`npm ci && npm test && npm run build`. Tests cover replay/conflict, transactional rollback, restarts on disk, both authorization boundaries, streamed limits, non-gameplay rejection, duplicate participants, stable paging, zero deaths, filters, name changes, round/campaign double counting, season carry-over and boundaries, late results, season-specific API MMR and the v1→v3 / v2→v3 migrations. Run the producer/API end-to-end check from the companion mod PR before merging both.

Local review: submit the test fixture with a configured producer key, replay it, verify exactly one battle; submit a campaign summary, verify counters are unchanged; stop Minecraft, refresh leaderboard/account, and verify history still loads. Invalid/missing DB must show unavailable, not zero stats. Check layout at 360px and desktop, keyboard navigation, long display names and logout during a slow request.

Not implemented by this site PR: a legacy CamelCase-log importer (historical mode/time/class IDs require an explicit mapping), recomputing later seasons after late results, class-filtered leaderboard, and large-dataset load testing. Existing log files are never silently reinterpreted or rewritten.

## PostgreSQL and SQLite compatibility (schema 6)

Set `BLOCKFIELD_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE` for PostgreSQL.
Without it, `BLOCKFIELD_STATS_DB=/absolute/path/blockfield.sqlite` retains SQLite support.
An unavailable or invalid PostgreSQL configuration returns an error; it never silently falls back to a different SQLite database.
Both engines use the same validation, queries, ratings and admin roles. Storage methods and `StatsStore.open()` are asynchronous.
PostgreSQL uses `pg`, parameterized queries, a pool and one connection per transaction. Ingestion and rating rebuilds take a transaction-level advisory lock across site replicas.
SQLite serializes connection access so an asynchronous request cannot observe another request's uncommitted writes.
Schema 6 gives ingestion keys explicit IDs and preserves existing SQLite row IDs when upgrading.

### Migration from SQLite

1. Build/test the new site before the cutover. Keep the existing SQLite volume and record the previous image and environment.
2. Pause **site writes** for the final backup/copy. Game servers can continue queueing finalized results in their outboxes; do not stop the game server for this migration.
3. Take a consistent SQLite backup (Node's `node:sqlite` `backup()` or SQLite backup tooling), including every committed WAL transaction. Never copy only a live `.sqlite` file.
4. From this repository, with the target URL set in the environment, run:
   ```sh
   node --experimental-strip-types scripts/migrate-stats.mjs /absolute/path/backup.sqlite
   ```
   Use a backup copy: opening it upgrades its schema. The command requires an empty PostgreSQL target, copies all nine data tables, verifies row counts/content digests before committing, and preserves audit/key IDs. It copies existing ratings exactly rather than replaying them.
5. Set `BLOCKFIELD_DATABASE_URL`, preserving all other environment settings, especially `BLOCKFIELD_OWNER_UUIDS`, RCON and admin mount paths. Deploy the new site, check statistics and owner access, and let the producer replay its queue.

Keep the pre-cutover SQLite backup for recovery. SQLite is an alternative backend, **not a live replica**: switching back after PostgreSQL has accepted writes requires transferring those changes first. Before any new PostgreSQL writes, the previous image/environment and original SQLite volume remain a rollback option.
Back up PostgreSQL with `pg_dump` and retain the SQLite snapshot independently.

Tests: `npm test` covers SQLite. Set `BLOCKFIELD_TEST_DATABASE_URL` to a PostgreSQL database where the test user may create schemas, then run `npm run test:postgres`. Tests create isolated random schemas and remove only those schemas; migration/reopen fixtures still exercise legacy SQLite files. CI runs both engines.
