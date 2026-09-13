# Statistics follow-up: FFA result identity and ingestion validation

Reviewed PR #1 at `b5f730c20b2e7d60feb8d14fa20b9ff86aaf9335`. Companion feature: netherg-io/blockfield-releases#9 / netherg-io/blockfield-mod#1. This extends the v1 contract documented in statistics.md; it does not implement the game producer/outbox.

## Additive personal winner contract

A completed FFA match may now include `winnerUuid`, a lowercase UUID of one of its deduplicated participants. It requires `kind: match`, `modeId: deathmatch`, `ranked: false`, `endReason: completed`, `winner: NONE`, `campaignSessionId: null` and participant teams `NONE`. A foreign/malformed UUID, a team/campaign result or a drawn/interrupted match cannot declare a personal winner. For draws and interruptions omit this field; explicit null is not a producer-contract value.

The value is stored atomically inside the existing immutable payload. Leaderboard wins and profile history use the personal UUID for FFA rather than the old scoreboard team. History presentation now shows the correct personal win/loss and never invents an outcome for a legacy record without a personal winner. MMR remains null; no campaign result or second metric aggregation is created.

The field is deliberately **absent**, not normalized to null, when absent in input. Canonical bytes/digests of old valid payloads remain unchanged, preserving idempotent replay. A fixed pre-change digest is covered by a regression. Existing database schema version 1 remains usable without a migration. Previously discarded unknown fields are not magically recovered: adding a different winner to an already accepted event returns 409 and needs a separately reviewed correction procedure, never a fresh event ID to double-count the match. Legacy FFA team fields do not establish a personal victory.

## Input boundary fixes

`eventId` and `serverId` must actually be strings, not arrays coerced by a regular expression. Producer authentication checks UUID shape and own-property membership before iterating keys. Headers such as `__proto__`/`constructor`, unknown UUIDs and inherited credential properties now fail with 401 before reading the body, rather than causing 503 or accepting inherited configuration.

## Verification

Focused local command: `node --experimental-strip-types --test test/stats.test.mjs test/stats-review.test.mjs` — **25 passed** (16 existing + 9 new). Seven of the eight initial regression methods failed against the exact original source, then all passed after fixes; presentation coverage was added afterward. Cases cover authenticated ingestion/read/replay, winner conflicts, invalid winner/mode/roster, unchanged legacy digest, reopen/persistence, credential boundaries, secret allowlisting and outcome labels.

The local environment provides Node 22.16, below the application's declared minimum 22.19. It ran these dependency-free focused checks only; this is **not** a supported-runtime Astro build claim. The unchanged PR CI runs the complete npm test/build workflow on its Node 22 setup; inspect the new head's run, not the old green baseline. No browser, real Drasl, live Minecraft producer/outbox or two-client E2E was executed locally. No lockfile, dependency, deployment, main branch or release change.
