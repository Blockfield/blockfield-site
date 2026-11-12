# Durable statistics

Refs: netherg-io/blockfield-releases#3 and #6. This service is part of the existing Astro SSR application, **not** the retired launcher API/CMS. It does not query Minecraft to read history. Deploy the site with its own persistent storage; replacing/stopping the game backend must not replace this volume. This provides process independence, not availability through failure of a shared physical host.

## Runtime and storage

Use Node 22.19+ (the existing Astro dependency graph also requires this). PostgreSQL through `pg` is the only store: `StatsStore.open()` accepts only `BLOCKFIELD_DATABASE_URL`. No `node:sqlite` code remains. See [PostgreSQL storage and the SQLite export](#postgresql-storage-schema-8) for deployment and migration.

Site environment (PostgreSQL is required):

```dotenv
BLOCKFIELD_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/blockfield
# Map persistent game-server UUIDs to 32+ character random producer tokens.
# During rotation an ID may map to ["current-token", "previous-token"].
BLOCKFIELD_STATS_INGEST_KEYS={"00000000-0000-4000-8000-000000000001":"REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS"}
```

Statistics live in PostgreSQL; the image keeps no local stats volume. Do not commit real tokens, put them in client configs, or print them. Set the matching server ID/token on the game producer. HTTPS is required outside a private trusted network. Ingestion does not authenticate with player accounts: it accepts only server credentials and rejects submissions for another server ID.

Without a configured database, reads return 503 rather than an empty leaderboard. An invalid PostgreSQL configuration fails instead of serving anything else. Producer keys can also be created and revoked in `/admin` (stored as SHA-256 hashes in `ingest_keys`); env and DB keys are both accepted. Without any ingestion key, writes are unauthorized. Bad key configuration fails closed. Restore to an isolated instance and replay the producer outbox to verify a backup. Unknown database schema versions are rejected, not overwritten.

Current schema is 8. Schema 6 gave ingestion keys explicit IDs. There are no automatic deletes or destructive migrations.

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
- Optional `telemetry`: the per-match hit-reg report the game server attaches (`shots`, `fallbackShare`, tick/age/rewind percentiles, `counters`, bucket histograms, `disputes`). It is validated against the producer caps (64 top-level fields, 512 counters, 8 disputes, 8 KB serialized) and stored in the result payload; results without it keep their legacy bytes. An invalid block never rejects the result: it is dropped, one `Telemetry dropped` warning is logged per result and the process-local `telemetryDropped` counter (shown in the hit-reg report) grows.

Maximum body 1 MiB, maximum 512 participants, bounded per-player class breakdown, bounded body read timeout. Declared length is not trusted: streamed bytes are counted. Credentials are checked before body parsing. Authorization tokens are compared via fixed-length SHA-256 digests and a constant-time comparison.

The result and all participant/class rows are inserted in **one transaction**. `(serverId,eventId)` is unique. Exact semantic replay returns 200 without changes; a new result returns 201. Reusing an ID with changed data returns 409 and must be quarantined/operator-reviewed by the producer, not assigned a fresh ID and replayed as another match. Other non-success responses must not be acknowledged as delivered. Aggregation reads only match rows: campaign summaries never count round kills/score twice.

## Read API

All reads are `GET`, public, `Cache-Control: no-store`, and served from the selected persistent database.

- `/api/stats/leaderboard?mode=campaign&season=s1&sort=score&page=1&limit=25`
- `/api/stats/players/<UUID>` with the same filters (sort only affects `totals.rank`).
- `/api/stats/seasons` → `{schemaVersion, current, seasons: [{id, name, startsAt, endsAt}]}`; only started seasons, oldest first; `current` is `null` before season 1.
- `/api/stats/hitreg?mode=&season=&period=` → **staff only** (site session with the `stats` permission, same guard as `/api/admin/*`; also served as `/api/admin/hitreg`). Hit-reg aggregate over the same window filters, `period` defaulting to `week` here: summed `shots`, shots-weighted `fallbackShare`, summed `counters` and `disputes`, plus the median and P99 across per-match tick/age/rewind percentiles. Voided results are excluded; the aggregation runs in PostgreSQL (no per-row parsing in Node) over the 5000 newest matches; `truncated` says that cap was hit.

Filters: `mode` = `room`, `campaign`, `deathmatch` (omitted = all). `period` = `all`, rolling `week` (7 days), rolling `month` (30 days). `season` = a started season ID; `season` together with `period` (even `period=all`), an unknown season or a future season is **400**. `sort` = `score` (default), `rating` (the MMR season's rating), `kills`, `captures`, `pointSeconds`, `playSeconds`, `wins`, `kd`. `limit` 1–100, `page` 1–1000, otherwise 400. A page past the end returns `players: []` with the real `total`.

Leaderboard response: `schemaVersion`, `checkedAt` (server read time, not last result time), `mode`, `season` (or `null`), `mmrSeason`, `page`, `limit`, `total`, `ratingStatus` (rules version, `glicko2-v1`), `players[]`. Each row: `uuid`, `name` (latest known display name), `rank`, `score`, `kills`, `deaths`, `kd`, `captures`, `neutralizations`, `pointSeconds`, `playSeconds`, `suicides`, `teamKills`, `maxKillstreak`, `matches`, `wins` (battle wins), `mmr`.

- `mmrSeason` is the season whose MMR is shown: the `season` parameter, or the current season when it is omitted (also with `period`). Label MMR with it («MMR · Сезон 1»).
- `rank` is the 1-based position under the same filter and sort, numbered over the whole filtered set: `(page-1)*limit+index+1`. Ties sort by `uuid` ascending; on `sort=rating` players without MMR in `mmrSeason` come last.
- `kd` = `kills / max(1, deaths)` rounded to 3 decimals: zero deaths gives `kd = kills`, never `Infinity`/`NaN`/`null`.
- `mmr` is `null` (no rated campaign in `mmrSeason`) or `{rating, rd, ratedCampaigns, provisional}`; `provisional` = fewer than 5 rated campaigns **in that season** or RD > 150.

Player response: `schemaVersion`, `checkedAt`, `season`, `mmrSeason`, `profile {uuid, name, lastSeen}`, `totals` (a leaderboard row incl. `rank` for this filter/sort, or `null` when the player has no battles in the filter), `classes[]`, `campaigns {completed, wins}` (numbers, `0` when none), `history[]` (paged by `page`/`limit`), `mmr` (for `mmrSeason`), `ratingHistory[]` (up to 20 MMR changes of `mmrSeason` inside the filter window; empty for non-Ranked modes), `ratingStatus`. An unknown UUID is 404; a known player with a non-matching filter is 200 with `totals: null` and empty arrays.

Combat metrics come from `kind=match` rows only; campaign summaries never add round kills/score twice.

## Outcome rules

| `endReason`                                 | Stored | Battle/campaign winner                        | MMR (Ranked campaign summary only) |
| ------------------------------------------- | ------ | --------------------------------------------- | ---------------------------------- |
| `completed`                                 | yes    | `winner` side (FFA: `winnerUuid`)             | win = 1, loss = 0                  |
| `draw`                                      | yes    | none                                          | 0.5 for everyone                   |
| `abandoned`, `stopped`, `shutdown`, `error` | yes    | none (a declared winner is rejected with 422) | none                               |

A win awarded by an administrator (`/bf stop … win TEAM`) is exported and stored as `stopped`: no winner, no MMR. MMR is Glicko-2 (`src/lib/glicko2.ts`), one operation per completed/drawn Ranked campaign per participant with team `RED`/`BLUE` (the other side is a composite opponent). Rounds, Casual and Deathmatch never rate. Rating is keyed by `(serverId, eventId, uuid)`: replays and a summary arriving before or after its rounds do not rate twice; later rounds never change ratings.

## Seasons

Default (owner can change): quarterly time windows. `s1` "Альфа Сезон" = `2026-09-14T00:00:00.000Z` (production export start) … `2026-09-25T23:59:59.999Z` (ended by the owner 2026-09-26); `s2` "Сезон 1" = `2026-09-26T00:00:00.000Z` … `2026-12-31T23:59:59.999Z`; then each UTC calendar quarter (`s3` "Сезон 2" = 2027 Q1, …), generated by `seasons()` in `src/lib/stats.ts`, so no edits per quarter. IDs stay numeric and are one ahead of the display number because of the alpha. `endsAt` is inclusive; a result is in a season by `endedAt`. Changing the first start or length changes historical season membership of results, but not the season already stored with ratings.

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
- The app requires `BLOCKFIELD_DATABASE_URL` (a PostgreSQL URL). For local work use an isolated test database seeded by `StatsStore.ingest()` with the test fixtures; never production data.

## Verification and remaining integration

`pnpm install --frozen-lockfile && pnpm check && pnpm build`. Tests cover replay/conflict, transactional rollback, both authorization boundaries, streamed limits, non-gameplay rejection, duplicate participants, stable paging, zero deaths, filters, name changes, round/campaign double counting, season carry-over and boundaries, late results and season-specific API MMR. Run the producer/API end-to-end check from the companion mod PR before merging both.

Local review: submit the test fixture with a configured producer key, replay it, verify exactly one battle; submit a campaign summary, verify counters are unchanged; stop Minecraft, refresh leaderboard/account, and verify history still loads. Invalid/missing DB must show unavailable, not zero stats. Check layout at 360px and desktop, keyboard navigation, long display names and logout during a slow request.

Legacy CamelCase import is provided below. Recomputing later seasons after late results, class-filtered leaderboard and large-dataset load testing remain separate work. Existing log files are never silently reinterpreted or rewritten.

## PostgreSQL storage (schema 8)

PostgreSQL is the only store. Set `BLOCKFIELD_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE`.
An unavailable or invalid PostgreSQL configuration returns an error; the app never serves from anything else.
Storage methods and `StatsStore.open()` are asynchronous.
PostgreSQL uses `pg`, parameterized queries, a pool and one connection per transaction. Ingestion and rating rebuilds take a transaction-level advisory lock across site replicas.
Schema 7 gives ingestion keys explicit IDs.
Schema 8 adds `results.winner_uuid` (deathmatch winner, null otherwise) so the leaderboard compares a column instead of parsing every payload; it is filled at ingest and backfilled once from the payload text on startup (text extraction, so payloads PostgreSQL cannot cast to `jsonb` still migrate). Reads fall back to the payload value when the column is `NULL`, covering rows a pre-upgrade replica writes during a rolling deploy.

Rollback for schema 8: before deploying, take a `pg_dump` backup. To roll back after PostgreSQL has accepted v8 writes, restore the dump on an isolated instance (or, when no v8-only data must be kept, `ALTER TABLE results DROP COLUMN winner_uuid` and `UPDATE blockfield_schema SET version=7 WHERE id=1`, then redeploy the previous image).

### Migration from SQLite

SQLite volumes are retired and the `node:sqlite` importer is removed: past cutover the only
supported path is the already-exported PostgreSQL data (plus `pg_dump` backups). The notes below
are kept for the pre-cutover backup only; `scripts/migrate-stats.mjs` and `StatsStore.openBackup()`
no longer exist. Owner step: retire the old SQLite volume once the PostgreSQL data is verified.

1. Build/test the new site before the cutover. Keep the existing SQLite volume and record the previous image and environment.
2. Pause **site writes** for the final backup/copy. Game servers can continue queueing finalized results in their outboxes; do not stop the game server for this migration.
3. Take a consistent SQLite backup (Node's `node:sqlite` `backup()` or SQLite backup tooling), including every committed WAL transaction. Never copy only a live `.sqlite` file.
4. From this repository, with the target URL set in the environment, run:
   ```sh
   node --experimental-strip-types scripts/migrate-stats.mjs /absolute/path/backup.sqlite
   ```
   Use a backup copy. The command requires an empty PostgreSQL target, copies all nine data tables, verifies row counts/content digests before committing, and preserves audit/key IDs. It copies existing ratings exactly rather than replaying them.
5. Set `BLOCKFIELD_DATABASE_URL`, preserving all other environment settings, especially `BLOCKFIELD_OWNER_UUIDS`, RCON and admin mount paths. Deploy the new site, check statistics and owner access, and let the producer replay its queue.

Keep the pre-cutover SQLite backup for recovery. SQLite is an alternative backend, **not a live replica**: switching back after PostgreSQL has accepted writes requires transferring those changes first. Before any new PostgreSQL writes, the previous image/environment and original SQLite volume remain a rollback option.
Back up PostgreSQL with `pg_dump` and retain the SQLite snapshot independently.

Tests: `pnpm test` requires PostgreSQL: set `BLOCKFIELD_TEST_DATABASE_URL` to a
PostgreSQL database where the test user may create schemas, then run `pnpm test:postgres`.
Local setup with Podman or Docker (same credentials as CI):

```sh
podman run -d --name bf-test-pg -e POSTGRES_USER=blockfield -e POSTGRES_PASSWORD=test-only \
  -e POSTGRES_DB=blockfield_test -p 5432:5432 docker.io/library/postgres:18
export BLOCKFIELD_TEST_DATABASE_URL=postgres://blockfield:test-only@localhost:5432/blockfield_test
pnpm test
```

Tests create isolated random schemas and remove only those schemas. CI runs the PostgreSQL suite.

## Legacy match import

Run locally as the trusted stats administrator, with a database backup. No HTTP producer key is needed: this is an explicit maintenance operation. Dry-run is the default and does not open the database. Source files are read-only. The report path must not already exist.

```sh
node --experimental-strip-types scripts/import-legacy-stats.mjs manifest.json "$BLOCKFIELD_DATABASE_URL" dry-run.json
node --experimental-strip-types scripts/import-legacy-stats.mjs manifest.json "$BLOCKFIELD_DATABASE_URL" applied.json --apply
```

Example manifest (replace the reviewed source checksum and IDs):

```json
{
  "serverId": "00000000-0000-4000-8000-000000000001",
  "classMap": { "Штурмовик (AK-47)": { "classId": "assault", "variantId": "0" } },
  "files": [
    {
      "path": "Stats_Campaign_123.json",
      "sha256": "SHA256_OF_REVIEWED_FILE",
      "sessionPurpose": "gameplay",
      "modeId": "room",
      "mapId": "fields"
    }
  ]
}
```

A trusted operator must establish each file's origin before marking it gameplay. An explicit non-gameplay `SessionPurpose` in the source cannot be overridden. A missing field in an old file is accepted only with the manifest's explicit gameplay attestation. Modern stable class IDs are retained; older display names require `classMap`. Ranked rounds need an explicitly verified `campaignSessionId`. Campaign summaries are rejected: this importer never grants historical MMR.

Unknown modes, teams, statuses, invalid/missing UUIDs, dates without numeric timezone, checksum mismatches, unknown classes and repeated UUID segments are reported as rejected rather than guessed. Overlapping/team-change legacy records must be reconciled from authoritative records before import; the importer does not sum potentially cumulative snapshots. Correct a copy, preserve the original and review a new checksum. An existing EventId is retained; older files derive an ID from server, mode, campaign, round number, map and start time. Replay uses the normal transactional ingestion deduplication. A changed result under the same identity is rejected as a conflict. Never import a JSON log already delivered through the outbox under a different interpretation.

Each file commits independently. Review the report after partial failures; rerun safely after correcting rejected entries. This command does not disable the normal protected ingestion endpoint or change season/rating rules.
