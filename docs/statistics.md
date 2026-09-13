# Durable statistics (review implementation)

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

Without `BLOCKFIELD_STATS_DB`, reads return 503 rather than an empty leaderboard. Without ingestion keys, writes are unauthorized. Bad key configuration fails closed. Keep one writer deployment per local SQLite volume; do not place the database on NFS or share it between hosts. Use WAL-aware SQLite backup tooling, or stop **the site only** and copy the database plus any WAL/SHM files before upgrades. Do not copy a live `.sqlite` file alone. Restore to an isolated instance and replay the producer outbox to verify a backup. Unknown database schema versions are rejected, not overwritten.

There are no automatic deletes, destructive migrations, production deployments, or MMR recalculations in this PR. Add retention/administration policies explicitly before a large public rollout. Put public read endpoints behind reverse-proxy rate limits appropriate to the deployment.

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

## Reads and UI

- `/api/stats/leaderboard?mode=campaign&period=week&sort=score&page=1&limit=25`
- `/api/stats/players/<UUID>` with the same mode/period/pagination filters.
- Modes: `room`, `campaign`, `deathmatch`; omitted = all. Periods: `all`, rolling `week` (7 days), rolling `month` (30 days). Sort: `score`, `kills`, `captures`, `pointSeconds`, `playSeconds`, `wins`, `kd`. Limit 1–100, page 1–1000. Stable UUID tie-breaker.
- `/leaderboard`, `/players/<UUID>`, and the account's statistics card use these same persisted records. The account card uses Drasl's returned UUID and cancels stale requests after logout/account changes.

MMR is deliberately `null` with `ratingStatus: not_configured`. Battle wins are not a rating. Completed Ranked campaign wins are recorded separately. The approved formula, seasons and incomplete-participation policy must be implemented as a versioned, once-per-campaign calculation later; no Elo or penalty formula is guessed here.

## Verification and remaining integration

`npm ci && npm test && npm run build`. Tests cover replay/conflict, transactional rollback, restarts on disk, both authorization boundaries, streamed limits, non-gameplay rejection, duplicate participants, stable paging, zero deaths, filters, name changes and round/campaign double counting. Run the producer/API end-to-end check from the companion mod PR before merging both.

Local review: submit the test fixture with a configured producer key, replay it, verify exactly one battle; submit a campaign summary, verify counters are unchanged; stop Minecraft, refresh leaderboard/account, and verify history still loads. Invalid/missing DB must show unavailable, not zero stats. Check layout at 360px and desktop, keyboard navigation, long display names and logout during a slow request.

Not implemented by this site PR: a legacy CamelCase-log importer (historical mode/time/class IDs require an explicit mapping), MMR/seasons, class-filtered leaderboard, and large-dataset load testing. Existing log files are never silently reinterpreted or rewritten.
