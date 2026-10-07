# Admin panel (`/admin`)

Staff page of the site: controller status and server mode, live moderation over RCON, persistent game settings, staff roles, map history, statistics administration and an audit log. Code: [admin.ts](../src/lib/admin.ts) (roles, validation, API), [gun-balance.ts](../src/lib/gun-balance.ts) (server catalog and overrides), `src/lib/rcon.ts`, `src/pages/api/admin/[...path].ts`, `src/pages/admin.astro`; storage in the statistics DB (`src/lib/stats.ts`, schema v6). Tests: `test/admin.test.mjs`, `test/gun-balance.test.mjs`, `test/maps-admin.test.mjs`, `test/rcon.test.mjs`, `test/stats-admin.test.mjs`, `test/names.test.mjs`.

**Gun balance, native map history and isolated-copy integration below are implemented in the working code, pending release/deployment and game acceptance.** Selecting an archive head and applying it to a running game are separate operations.

The landing page header (`src/pages/index.astro`) shows the signed-in player's nickname and, only when `siteIdentity()` (`src/lib/admin.ts`) reports any staff role, a button straight to `/admin` — both rendered server-side from the session cookie, so they are in the first response and never swap in after hydration.

## Interface

Routine actions use Russian labels instead of UUIDs or command strings. Weapon settings expose their data keys and nested JSON; map history exposes version digests. Tabs are grouped by task and only those the role can use are shown: «Обзор» (server state, mode switch, message, range, maintenance), «Игроки» (moderation by nickname), «Матчи» (room cards and match outcome), «Настройки игры» (game rules, parkour and weapon balance), «Команда» (roles and builder access), «Мастерская» (editing access, candidates and archive history), «Статистика» (results and ingest keys), «Производительность» (server health), «Консоль» (owner's raw RCON), «Журнал действий». Destructive actions use a native `<dialog>`. `<select>` uses the keyboard-accessible `customSelect()` in `admin.astro` over a hidden native form control.

- Display names for class, map, mode and campaign ids, balance labels/groups and the game-file balance defaults live in `src/lib/game-names.ts`, a hand-kept copy of `blockfield-server/server/lobby/blockfield/{classes,campaigns,maps,modes}`. Update it when the server adds content; unknown ids show a neutral label and are preserved on save. A test checks that every `BALANCE` key has a label and a default.
- ParCool action ids and their Russian labels are `PARCOOL_ACTIONS` in `src/lib/game-names.ts`, a hand-kept copy of ParCool's action enum (not modpack content, so it does not follow the "unknown ids preserved" rule above: the site only ever writes ids from this list).
- Read-only API additions: `GET bans` (`ban`): the latest successful site ban/pardon per nickname from the audit log (in-game bans are not listed; «Разбанить» by nickname covers them). `GET results` rows carry `mapId`, `players:[{uuid,name,team}]` (sorted by score, UUID-like names resolved or «Неизвестный игрок») and `winnerName`. `POST rcon` `stop-room` returns and audits the room's name and map; `POST results/void` audits the match mode, map and time. `overview.rooms.online` is the proxy's online count when it reports one.
- General game fields keep "absent = server default": values equal to the displayed default and untouched class lists are omitted (`src/lib/settings-form.ts`, tested). Weapon overrides have a dedicated save; a general settings save preserves them when it omits `gunBalance`.
- All times on the site are UTC and labelled; relative times («5 минут назад») are used in lists.
- Owner rows fall back to the Drasl name, then the last known profile name, then the signed-in owner's own name, then «Неизвестный игрок».

## Roles

The site is the source of truth for roles. Identity is the Drasl session (`bf_session` cookie) → the account's player UUID, stored without dashes in lowercase.

| Role        | Can                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builder`   | open `/admin`, see status, rooms and map history (workshop access comes from the derived member list)                                                                                                            |
| `moderator` | + RCON moderation (`list`, `say`, `kick`, `bf team kick`, `bf stop room`, `bf class lock/unlock`, `range`), mode switch game/workshop without recover, maintenance/workshop message                              |
| `admin`     | + `ban`/`pardon`, maintenance/recover, game and weapon settings, statistics admin, audit log, grant/revoke builder/moderator, workshop sync, map publication/rollback/export, server performance (`diagnostics`) |
| `owner`     | + grant/revoke `admin`, raw RCON console (`rcon-raw`)                                                                                                                                                            |

Permissions are one map in `src/lib/admin.ts` (`can(role, permission)`); every API route checks it on the server, the page only hides what the role cannot use.

- **Bootstrap:** `BLOCKFIELD_OWNER_UUIDS` (comma-separated player UUIDs, dashes optional) are always `owner`. They are not stored and cannot be changed from the UI. Everybody else needs a row in `staff_roles`. No env and an empty table = nobody has access.
- Admins manage only builder/moderator; owners also manage admin. Nobody changes their own role. Grants resolve the nickname through Drasl's public profile lookup `GET <DRASL_URL>/account/users/profiles/minecraft/<name>` (`{id, name}`, 404 if unknown); owner names through `GET <DRASL_URL>/session/minecraft/profile/<uuid>`.
- **Workshop ACL is derived.** After every role change (and on «Синхронизировать мастерскую») the site writes a `members` inbox request with all staff and owners mapped `owner|admin → admin`, `moderator → lead`, `builder → builder`. The site no longer reads `members.json` for auth; it only displays whether the controller's `members.json` matches (drift) and the result of the last sync.

## Environment

```dotenv
BLOCKFIELD_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/blockfield
# Or, for SQLite compatibility (when BLOCKFIELD_DATABASE_URL is unset):
# BLOCKFIELD_STATS_DB=/data/stats/blockfield.sqlite
BLOCKFIELD_OWNER_UUIDS=e10438e4797b49718cfecec6a8fa171b
BLOCKFIELD_ADMIN_DIR=/workshop-admin                 # default
BLOCKFIELD_INBOX_DIR=/workshop-inbox                 # default
BLOCKFIELD_SETTINGS_DIR=/blockfield-admin            # default
BLOCKFIELD_MAP_PACKAGES_DIR=/map-packages            # read-only mount of controller BF_MAP_PACKAGES_DIR; otherwise legacy BLOCKFIELD_ADMIN_DIR/packages
BLOCKFIELD_RCON_HOST=blockfield-server-lfcxy0
BLOCKFIELD_RCON_PORT=25575
BLOCKFIELD_RCON_PASSWORD=...                         # secret; never sent to the browser
BLOCKFIELD_DEPLOY_ANNOUNCE_TOKEN=...                 # secret; modpack Deploy workflow (DEPLOY_ANNOUNCE_TOKEN) → POST /api/deploy-announce, fixed restart notice
BLOCKFIELD_WORKSHOP_KEY=...                          # optional; default: the file workshop.key in BLOCKFIELD_ADMIN_DIR (host /srv/minecraft/workshop/admin, root:1000 0640), shared with the workshop server
```

Mounts for the site container (host → container):

| Host                                    | Container           | Mode | Written by                                                                                                          |
| --------------------------------------- | ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| `/srv/minecraft/workshop/admin`         | `/workshop-admin`   | ro   | host controller: `status.json`, `session.json`, `members.json`, `maps.json`, `candidates.json`, `results/<id>.json` |
| `/srv/minecraft/workshop/inbox`         | `/workshop-inbox`   | rw   | site: one `<id>.json` request per file (written as a dot temp file, then renamed)                                   |
| `/srv/minecraft/lobby/blockfield-admin` | `/blockfield-admin` | rw   | site: `settings.json`; game server (`/data/blockfield-admin`): `applied.json`, `gun-balance.json`                   |
| Controller `BF_MAP_PACKAGES_DIR` (HDD)  | `/map-packages`     | ro   | host controller: derived `<sha256>.zip` cache; set `BLOCKFIELD_MAP_PACKAGES_DIR` to this mount                      |

The image runs as `node` (UID 1000): the rw directories must be writable by it. The site joins `dokploy-network` to reach RCON; do not publish the RCON port.

## Contracts

- Inbox request: `{schema:1, id, kind, actor:{draslId,name}, createdAt, ...}`; `mode` `{profile: game|workshop|test, expectedRevision, recover?}` (recover only toward game, admin only), `message` `{message}` (one line, ≤200 chars), `members` `{members:[{draslId,name,role,maps?}]}` (full replacement, generated by the site only; `maps` is only ever set on a `builder` entry — see «Workshop map access» below). The page polls `results/<id>.json` for up to a minute.
- Workshop sessions: `mode` toward `workshop` carries `session: new|resume` and, only for `new`, `maps: string[]|null`. The site validates against `WORKSHOP_PLACES`; the controller checks real catalog IDs. In canonical mode, `null` is frozen to the current explicit map list and every selected map is prepared in an isolated working copy before switching. `resume` preserves the same copy and map list; it does not rebase edits onto a newer head. `admin/session.json` `{schema:1,id,maps,startedAt,startedBy}` is the source of truth. The legacy `hub` access scope is not a map version; the runtime lobby map is `lobby`.
- Closed test matches: `mode` toward `test` carries `candidateId`, offered from phase `workshop` on a pending candidate. The controller exports `desired.candidate` as the derived package SHA256, not the candidate ID. From `test`, «Вернуться в мастерскую» sends `mode workshop session:resume`; «Вернуть игровой режим» sends `game`.
- `settings.json`: `{schema:1,revision,updatedAt,updatedBy,lobby?,rooms?,deathmatch?,classLocks?,classCosts?,campaignBalance?,parcool?,gunBalance?}`. General `PUT settings` replaces ordinary sections; absent keys use server defaults. An omitted `gunBalance` preserves its current value. Both settings save routes require the current `expectedRevision`; stale saves return 409. Ranges: `pvpCooldownSeconds` 0–600, `maxRooms` 1–16, `idleCloseSeconds` 30–3600, `abandonCloseSeconds` 5–600, `deathmatch.minPlayers` 1–24. Campaign rules come from `BALANCE` in `admin.ts`; merged minimum team size cannot exceed maximum, and kill radius cannot exceed warning radius. `applied.json` `{revision,attemptedRevision?,appliedAt,errors,gunBalance?}` reports the server's actual result. Deathmatch and campaign rules affect new matches, not matches already running.
- `parcool`: `{allowedActions: string[]}`, ids from `PARCOOL_ACTIONS` (`src/lib/game-names.ts`), no duplicates. Section present → exactly those actions are allowed, everything else forbidden (`allowedActions: []` forbids every parkour action). Section absent → the mod's base image file governs (currently `FastRun`, `ClingToCliff`, `Crawl`); the mod skips unknown names and reports them in `applied.json`. The UI has one toggle («Задать список действий на сайте»): off omits the section from the save entirely — even if it was set before, since every save replaces the whole file — and shows the checkboxes, disabled, reflecting the base file's own default so the effective value stays visible; on writes the checked ids. `ClimbUp` is the pull-up out of a cliff cling — without it, clinging only holds the player in place.
- Workshop map access: a `builder` row in `staff_roles` (schema v6) carries an optional `maps` array of access scopes (`WORKSHOP_PLACES` in `src/lib/game-names.ts`). Missing/`null` grants every scope, including future ones; `[]` grants no editing scope. This ACL is separate from the frozen selected-session map list. `workshopMembers` drops `maps` for lead/admin roles. `POST /api/admin/staff/maps {uuid,maps:string[]|null}` (`roles`: admin/owner) validates known scopes and uniqueness, then syncs the controller member list. `POST staff/map-access {mapId,uuids}` updates one scope for all builders: granting preserves an existing all-scopes ACL; revoking from all expands the remaining known scopes. Neither operation silently grants future maps through an explicit list.
- RCON: one connection per call, 5 s timeout. Only fixed command shapes from `rconCommand()`; nicknames `^[A-Za-z0-9_]{3,16}$`, room UUIDs, class ids, and free text ≤120 chars with control characters and `§` replaced, never starting with `/`. `range` is sent as `bf range <op>`. A reply starting with `Unknown or incomplete command`/`Unknown command` or containing `<--[HERE]` is reported as a failure. Connection errors reach the browser only as «Игровой сервер не отвечает»; the details go to the server log and the audit entry. `stop room … win RED|BLUE` is sent as `win RedTeam|BlueTeam` (the game's team names). A bare stop reason cannot start with `win`/`draw`. Interrupt sends `bf maintenance interrupt` and `… confirm <reason>` on the same connection (the game requires the same sender within 60 s).
- Raw console (`POST /api/admin/rcon/raw {command}`, `rcon-raw`: owner only; `src/lib/console.ts`): one command per call through the same `rcon()`. The command must be a string without control characters (newlines included), at most 1000 characters after trimming; leading `/` is removed. The reply is returned whole with `§` codes stripped: `{command, output, rejected}`, where `rejected` marks a Brigadier refusal (see above). Connection errors behave like other RCON calls. Audit action `rcon:raw`: target is the command, detail the first 500 characters of the reply and `rejected`. Refusals (403) are audited without the command, because the body of a refused call is never read. The page confirms commands matching `dangerousCommand()` (`stop`, `op`, `deop`, `ban`, `kick`, `kill`, `whitelist off|remove`, `execute`, `fill`, `gamerule`, `bf maintenance|stop`, …) with the native dialog; this is a UI guard only, the owner's server-side permission is the boundary. History (↑/↓) lives only in the open page.

- Workshop scopes: access lists include arena IDs, `lobby`, `limbo` and the legacy `hub` building scope (`WORKSHOP_PLACES` in `src/lib/game-names.ts`). `null` means every scope; an explicit list grants only those listed.
- `POST /api/workshop/access {actor, target, mapId, allowed}` (`src/pages/api/workshop/access.ts`, `handleWorkshopAccess`): called by the workshop server when an admin uses «Разрешить/Запретить строить» on the tablet. `Authorization: Bearer BLOCKFIELD_WORKSHOP_KEY` (constant-time compare; no key = 503), then the in-game actor's own site role must have `roles`; the target must be a builder. Applies `withMapAccess`, re-syncs the workshop `members` request and writes `workshop-map-access` to the journal with `from: 'game'` (refusals too).

### Weapon balance

`GET /api/admin/gun-balance` (`settings`: admin/owner) returns `{available:true,catalog}` or `{available:false,error}`. `GET settings` includes the same availability beside `settings` and `applied`. The server writes `gun-balance.json` next to `settings.json`: `{schema:1,revision,fields,guns}`. Each gun has its index `id`, shared `data` ID, `name`, `type`, complete `defaults`, current `effective` values and baseline `warnings`.

The recursive `fields` metadata describes all 33 synchronized root fields of pinned TaCZ bf7, including `bullet`, `reload`, `recoil`, `heat`, `charging`, attachment maps and script parameters. It supplies types, bounds, enum values, nullable fields and supported unions (`infinite`, legacy ignite boolean). Nested values are edited as JSON; kit weapons are listed first, with search across the full catalog. Defaults and metadata come from the server, not a copied ganpack in the site. Enum-map defaults use wire keys such as `aim`, `semi` and `scope`, without duplicate uppercase enum names. Missing or invalid catalog data disables saves (503) rather than inventing defaults.

`PUT /api/admin/gun-balance` takes `{expectedRevision,gunBalance}` and returns `{settings}`. It preserves every unrelated settings section. Keys are gun **index IDs**, for example `elitex:ak47`, not data filenames:

```json
{
  "expectedRevision": 7,
  "gunBalance": {
    "elitex:ak47": { "draw_time": 0.82 },
    "tacz:glock_17": { "bullet": { "damage": 9 } }
  }
}
```

Only changed fields are stored. Objects merge recursively; arrays replace the whole value. Remove a field or gun to restore current ganpack/datapack defaults; an omitted or empty `gunBalance` on this dedicated route resets the whole section. A general settings save omitting it preserves it. `null` disables only a metadata-nullable value and is not a reset; `gunBalance:null` is invalid. Multiple explicit indices sharing a `data` ID must produce identical effective data. Old baseline values outside edit bounds stay readable and resettable; changed values must satisfy the metadata.

The server polls settings every 5 seconds, validates the entire revision and sends a dedicated `blockfield:gun_balance` delta to online clients immediately after applying it. It does not run `/reload` or `tacz reload`, refill magazines, or restart draw/reload/bolt actions. Models, animations, sounds and Lua are outside this update. A join receives complete effective data; a natural TaCZ reload recaptures genuine defaults and reapplies overrides. A hot update is refused if an online client lacks delta support.

A saved file is not proof of application. In `applied.json`, `revision` is the last applied revision; `attemptedRevision` identifies the attempt. A gun update rejected as a whole reports the previous `revision`, the rejected `attemptedRevision`, and field errors. `settingsReceipt()` in `settings-form.ts` recognizes that result immediately rather than waiting for the new revision to become applied. Normal reports set both revisions to the same value. `gunBalance` reports `{revision,changedData,onlineUpdated,reloadError?}`. Type, range, alias or server invariant errors preserve previous data. A 409 means reload settings before retrying. Mod details and acceptance scenarios: [admin-settings.md](https://github.com/Blockfield/blockfield-mod/blob/main/docs/admin-settings.md).

Isolated-stand evidence on 2026-09-30: the primitive draw gate was changed from about 0.32 s to 3 s and reset to its baseline without a reload or reconnect. The fresh-JAR catalog exposes 91 guns and 33 fields and passes site validation, including enum keys. An invalid whole revision preserved the previous data and reported `attemptedRevision`; valid apply/reset each reported one online update. Other fields need their own game scenarios. This is stand evidence, not production deployment.

### Map archive and isolated copies

`GET /api/admin/maps` (`view`) reads controller `admin/maps.json`, validating `{schema:1,maps:[{mapId,kind,mapJson,head,versions}]}`. It returns `{available:true,maps,session?}` or `{available:false,error}`. Kinds are `arena`, `lobby`, `limbo`; IDs come from actual templates and stored manifests. `head` is the selected version or `null`; compact history retains version/parent digests, author, creation time, changes/deletions and file count. A missing head means the legacy/template source is still selected, not the latest accepted candidate.

`session` is returned only when its schema, canonical UUID and map scopes are valid, the controller is in phase `workshop`, and `status.desired.session` matches it. `POST candidates/create {mapId}` (`workshop`: admin/owner) obtains this `workingCopyId` on the server and checks selected map membership. The browser cannot choose another UUID. The tablet sends `POST /api/workshop/submit {actor,actorName,mapId,workingCopyId}`: shared workshop key first, then the actor's site role/map ACL, then exact active-copy verification. The controller repeats these checks before snapshotting.

| Route (`/api/admin/…`, admin/owner) | Body                                 | Effect                                                                |
| ----------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `POST candidates/publish`           | `{candidateId,expectedHead,force?}`  | Accept and select this candidate's immutable version                  |
| `POST candidates/reject`            | `{candidateId}`                      | Mark rejected; retain history                                         |
| `POST candidates/rollback`          | `{mapId,versionDigest,expectedHead}` | Select that exact archived version; `maps/rollback` is the same route |
| `POST candidates/export`            | `{candidateId,mapId}`                | Request a derived ZIP of a candidate belonging to this map            |
| `POST maps/export-limbo`            | `{versionDigest}`                    | Prepare the selected archived Limbo version for the proxy             |

`expectedHead` is the catalog's current version digest or explicit `null` if no head exists. Missing/malformed values are refused; stale heads return 409 before enqueueing, and the controller checks again under its lock. A rollback target must belong to that map. `force` permits a base mismatch but never bypasses the head comparison. Acceptance, head activation and game use remain separate; an accepted candidate whose activation failed can be retried against the same unchanged head. Follow the inbox result before refreshing history.

Native candidates carry `native:true`, `versionDigest`, `baseVersion`, `workingCopyId`, and initially `sha256:null,size:null`. Acceptance/activation do not create a ZIP. Use «Подготовить ZIP»; the controller exports with pinned zlib 1.3.2 into its HDD cache and reports checksum/size plus `exportReady`. Download uses `GET candidates/download?id=…`: an accepted candidate and a valid SHA256 are required; a missing cache artifact returns 503. If a derived cache entry is evicted, request export again. Mount controller `BF_MAP_PACKAGES_DIR` read-only at `BLOCKFIELD_MAP_PACKAGES_DIR`; do not copy packages into the SSD admin directory.

Runtime application depends on map kind. New arena matches capture the selected immutable version; running matches retain theirs. A lobby head must be captured when starting its world and does not replace a running lobby. A limbo head requires materializing/applying the derived proxy world before controlled proxy startup. These runtime adapters are part of the pending working-code integration: a selected head alone does not establish deployment or game acceptance.

For Limbo, the UI enables «Подготовить для прокси» only with a verified running workshop session. The API validates that the requested immutable version belongs to the Limbo archive, then enqueues `limbo-export`; the controller independently requires exactly one ready workshop instance and reports any refusal in the inbox result. It asks the workshop to export that version, checks its source/config binding, and stores the derived Sponge-v2 artifact on HDD. Preparation does not change the head or start, stop or restart either service. Selection or rollback requires that proxy service to be stopped; the controller checks this before changing the head/selection pair. At startup the proxy validates the selection, config, schematic and checksum together. Producer and consumer details: [workshop operations](https://github.com/Blockfield/blockfield-workshop/blob/main/docs/OPERATIONS.md), [proxy Limbo contract](https://github.com/Blockfield/blockfield-proxy/blob/main/docs/LIMBO.md).

Legacy candidates and overlay metadata remain readable. The old `tools/workshop/fetch-map.py` command is retired. Accepted-map release artifacts and review PRs are prepared by `scripts/maps/publish_map.py` in [blockfield-server](https://github.com/Blockfield/blockfield-server/blob/main/docs/DEVELOPING.md); controller storage and operations belong to [blockfield-workshop](https://github.com/Blockfield/blockfield-workshop/blob/main/docs/OPERATIONS.md).

## Server performance

«Производительность» (`diagnostics`: admin/owner) exists to catch freezes, TPS drops and game errors. Code: `src/lib/diagnostics.ts`; tests `test/diagnostics.test.mjs`.

- `GET /api/admin/diagnostics/live`: vanilla `tick query` over RCON (Minecraft 1.20.3+, no mod): state, target TPS, average and P50/P95/P99 tick time over the server's last 100 ticks. Read-only, not audited. Works today, without a producer.
- `GET /api/admin/diagnostics`: samples of the last 24 h, the newest 500 events, and `lastSampleAt`. No samples or a last sample older than 3 minutes is shown as unknown/stale, never as healthy. The journal filters by kind and text, copies the shown records as text and exports them with the samples as JSON.
- Producer: `POST /api/stats/diagnostics`, the same `Authorization: Bearer <ingest key>` and `X-Blockfield-Server-Id` as match results (env or DB keys, constant-time, authenticated before the body is read, 1 MiB limit); the body's `serverId` must equal the header. Response `{samples, events}` (counts accepted); resends are idempotent (`(serverId, at)` per sample, `(serverId, id)` per event).

```json
{
  "schemaVersion": 1,
  "serverId": "<server UUID>",
  "startedAt": 1759790000000,
  "samples": [
    {
      "at": 1759800000000,
      "tps": 19.6,
      "msptAvg": 21.4,
      "msptP95": 38.0,
      "msptMax": 3400,
      "players": 12,
      "heapUsedMb": 1800,
      "heapMaxMb": 3072,
      "gcPauseMs": 120
    }
  ],
  "events": [
    {
      "id": "<UUID>",
      "at": 1759800000000,
      "kind": "freeze",
      "durationMs": 3400,
      "source": "Server thread",
      "message": "…",
      "repeats": 1
    }
  ]
}
```

A sample summarizes one interval (one minute recommended): `tps` and `msptAvg` over it, `msptMax` its worst tick, `gcPauseMs` time spent in GC. `players`, `msptP95`, heap and GC fields are optional. `kind` is `freeze` (requires `durationMs`), `error`, `crash` or `warning`; `message` ≤ 4000 characters and `source` ≤ 120 after redaction; `repeats` coalesces identical events. At most 120 samples and 200 events per report; times more than 5 minutes ahead refuse the report, items older than retention are dropped. Retention: samples 7 days (cap 50 000 rows), events 14 days (cap 5000). Before storage `redact()` removes control characters except newline/tab, URLs (webhooks included), e-mails, IPv4/IPv6 addresses, credentials after `password=`, `token:`, `Bearer` and similar, and long letter+digit runs; canonical UUIDs stay. The producer must still never send secret-bearing logs.

## Statistics administration

- Void/restore a result (`results.voided_at/voided_by`). Voided results leave every leaderboard, profile and history query. A producer replay of a voided result stays voided. Voiding or restoring a rated campaign (campaign, completed/draw) deletes the ratings and rating changes of its season **and every later season** and replays all non-voided rated campaigns from that season's start in `ended_at, server_id, event_id` order through the normal rating code, so later seasons' carry-over stays consistent. Earlier seasons are untouched.
- Ingest keys: `ingest_keys` stores only SHA-256 of the key; the plaintext is shown once on creation. `POST /api/stats/results` accepts env keys (`BLOCKFIELD_STATS_INGEST_KEYS`) or non-revoked DB keys for the same server ID, compared in constant time.
- Seasons are read-only (generated by code).

## Audit

Every non-GET call by a staff member writes `admin_audit` (actor, role, action, target, JSON detail capped at 2 KB, ok, error), including permission refusals and failures. Players without a role are refused before the request body is read and are not audited, so they cannot grow the table. The table keeps the newest 10 000 rows; admin sees the last 200. Settings bodies and RCON output (first 500 chars) are kept in `detail`; RCON passwords and ingest keys never are.

## Local development

There is no Drasl login for a local test account, so a dev-only identity exists: when `NODE_ENV !== 'production'` **and** `BLOCKFIELD_ADMIN_DEV_USER=<uuid>:<name>` is set, the site treats every request as that player (role still comes from owners/`staff_roles`). The Docker image sets `NODE_ENV=production`, which disables it.

For a local test, create temporary admin, inbox and settings directories. Put their absolute paths
in `.env` as `BLOCKFIELD_STATS_DB`, `BLOCKFIELD_ADMIN_DIR`, `BLOCKFIELD_INBOX_DIR` and
`BLOCKFIELD_SETTINGS_DIR`, then run `pnpm dev`. Use a local test account via
`BLOCKFIELD_ADMIN_DEV_USER`; keep this file untracked.

## Threat notes

- Fail closed: no DB, no owners and no grants, an unknown role, or a Drasl error all mean no access. Owners cannot be demoted from the UI, so a compromised admin cannot lock out the owner or grant admin.
- Only the owner has a raw console (`rcon-raw`, environment-only role). Everyone else sends an action name and arguments, never a command string. Validation rejects newline/space injection in names and leading `/` in text.
- Mutations use the existing same-origin check (`route()`), the `SameSite=Strict` session cookie and `Cache-Control: no-store`. No rate limiting yet (put the reverse proxy in front).
- A stolen session gives that player's role until the Drasl token is reset; revoke the role on the site, which also updates the workshop list.
- The inbox is trusted by the controller: it must still validate requests itself (the site is not the only writer to the host directory).
- The dev identity is ignored in production; never set `NODE_ENV` to anything else in deployed containers.

A recognized account with no admin access is not necessarily a lost login. Check the effective `BLOCKFIELD_OWNER_UUIDS` and selected database first. Owner access is deliberately environment-only; restoring a database does not restore this variable. Persist it in Dokploy and preserve it when updating the application environment.

Repository boundaries and shared files are mapped in [ARCHITECTURE](https://github.com/Blockfield/blockfield-workspace/blob/main/docs/ARCHITECTURE.md). Update this contract and that map when their relationship changes.
