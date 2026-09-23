# Admin panel (`/admin`)

Staff page of the site: controller status and server mode, live moderation over RCON, persistent game settings, staff roles (and the workshop member list derived from them), statistics administration and an audit log. Code: `src/lib/admin.ts` (roles, validation, API), `src/lib/rcon.ts`, `src/pages/api/admin/[...path].ts`, `src/pages/admin.astro`; storage in the statistics DB (`src/lib/stats.ts`, schema v6). Tests: `test/admin.test.mjs`, `test/rcon.test.mjs`, `test/stats-admin.test.mjs`, `test/names.test.mjs`.

The landing page header (`src/pages/index.astro`) shows the signed-in player's nickname and, only when `siteIdentity()` (`src/lib/admin.ts`) reports any staff role, a button straight to `/admin` — both rendered server-side from the session cookie, so they are in the first response and never swap in after hydration.

## Interface

The page is written for people who do not know the internals: Russian sentences, no UUIDs, request ids, revisions, class/campaign ids, balance keys or command strings. Tabs are grouped by task and only those the role can use are shown: «Обзор» (server state in words, mode switch, message, range, maintenance), «Игроки» (online list with kick / remove from match / ban, announcement, actions by nickname, players banned through the site), «Матчи» (room cards, «Завершить матч» with draw / red / blue / no outcome), «Настройки игры» (short labels; number fields prefilled with the server default; classes as checkboxes; balance per «Все матчи», «Кампания Центр», «Кампания Юг», «Обычные бои»), «Команда» (role descriptions, add by nickname, per-builder «Карты: …»), «Мастерская» (every map with the builders who may edit it and a «Кто правит» picker, plus the workshop access sync), «Статистика» (readable match rows, «Не учитывать матч» / «Вернуть в статистику», ingest keys under «Для разработчиков»), «Журнал действий» (sentences with relative time). Every destructive action goes through a native `<dialog>` that says what will happen. Every input, select, checkbox and radio in the page is custom-styled (no native OS dropdown/checkbox); `<select>` is a button+listbox (arrow keys, Enter, Escape, click-outside) over a hidden native `<select>` that stays the actual form control, in `customSelect()` in `admin.astro`.

- Display names for class, map, mode and campaign ids, balance labels/groups and the game-file balance defaults live in `src/lib/game-names.ts`, a hand-kept copy of `blockfield-modpack/server/lobby/blockfield/{classes,campaigns,maps,modes}`. Update it when the modpack adds content; unknown ids show a neutral label and are preserved on save. A test checks that every `BALANCE` key has a label and a default.
- Read-only API additions: `GET bans` (`ban`): the latest successful site ban/pardon per nickname from the audit log (in-game bans are not listed; «Разбанить» by nickname covers them). `GET results` rows carry `mapId`, `players:[{uuid,name,team}]` (sorted by score, UUID-like names resolved or «Неизвестный игрок») and `winnerName`. `POST rcon` `stop-room` returns and audits the room's name and map; `POST results/void` audits the match mode, map and time. `overview.rooms.online` is the proxy's online count when it reports one.
- Settings keep "absent = server default" for every field: every number field and the lobby PvP select are prefilled with the server default rather than left empty, and a value equal to that default is treated exactly like an untouched field — neither is written. An untouched class list is not written either (`src/lib/settings-form.ts`, tested).
- All times on the site are UTC and labelled; relative times («5 минут назад») are used in lists.
- Owner rows fall back to the Drasl name, then the last known profile name, then the signed-in owner's own name, then «Неизвестный игрок».

## Roles

The site is the source of truth for roles. Identity is the Drasl session (`bf_session` cookie) → the account's player UUID, stored without dashes in lowercase.

| Role | Can |
| --- | --- |
| `builder` | open `/admin`, see status and rooms (workshop access comes from the derived member list) |
| `moderator` | + RCON moderation (`list`, `say`, `kick`, `bf team kick`, `bf stop room`, `bf class lock/unlock`, `range`), mode switch game/workshop without recover, maintenance/workshop message |
| `admin` | + `ban`/`pardon`, `bf maintenance status/drain/interrupt`, recover, settings, statistics admin, audit log, grant/revoke `builder` and `moderator`, workshop sync |
| `owner` | + grant/revoke `admin` |

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
BLOCKFIELD_RCON_HOST=blockfield-server-lfcxy0
BLOCKFIELD_RCON_PORT=25575
BLOCKFIELD_RCON_PASSWORD=...                         # secret; never sent to the browser
BLOCKFIELD_DEPLOY_ANNOUNCE_TOKEN=...                 # secret; modpack Deploy workflow (DEPLOY_ANNOUNCE_TOKEN) → POST /api/deploy-announce, fixed restart notice
```

Mounts for the site container (host → container):

| Host | Container | Mode | Written by |
| --- | --- | --- | --- |
| `/srv/minecraft/workshop/admin` | `/workshop-admin` | ro | host controller: `status.json`, `members.json`, `results/<id>.json` |
| `/srv/minecraft/workshop/inbox` | `/workshop-inbox` | rw | site: one `<id>.json` request per file (written as a dot temp file, then renamed) |
| `/srv/minecraft/lobby/blockfield-admin` | `/blockfield-admin` | rw | site: `settings.json`; game server (`/data/blockfield-admin`): `applied.json` |

The image runs as `node` (UID 1000): the rw directories must be writable by it. The site joins `dokploy-network` to reach RCON; do not publish the RCON port.

## Contracts

- Inbox request: `{schema:1, id, kind, actor:{draslId,name}, createdAt, ...}`; `mode` `{profile: game|workshop, expectedRevision, recover?}` (recover only toward game, admin only), `message` `{message}` (one line, ≤200 chars), `members` `{members:[{draslId,name,role,maps?}]}` (full replacement, generated by the site only; `maps` is only ever set on a `builder` entry — see «Workshop map access» below). The page polls `results/<id>.json` for up to a minute.
- `settings.json`: `{schema:1, revision, updatedAt, updatedBy, lobby?, rooms?, deathmatch?, classLocks?, campaignBalance?}`. Each save replaces all sections; an absent section/key means the server default. A save with a stale `expectedRevision` is 409. Ranges: `pvpCooldownSeconds` 0–600, `maxRooms` 1–16, `idleCloseSeconds` 30–3600, `abandonCloseSeconds` 5–600, `deathmatch.minPlayers` 2–24; class ids `[a-z0-9_]{1,32}`; campaign ids `*` or `[A-Za-z0-9_-]{1,32}`; balance keys, types and ranges from the single table `BALANCE` in `src/lib/admin.ts`, matching the mod (integers except `score_per_obj_sec`, `base_warn_radius`, `base_kill_radius`; booleans `enable_spawn_shield`, `shuffle_teams_between_rounds`); after merging `*` with each campaign section `min_players_per_team ≤ max_players_per_team` and `base_kill_radius ≤ base_warn_radius`. The UI renders `*` as inputs with those min/max, prefilled with the server default so an untouched field is indistinguishable from one explicitly set back to the default — both are left out of the save. Message: Unicode control characters (Cc) and `§` are stripped, then trimmed, ≤200 code points (same rule as the controller). `applied.json` `{revision, appliedAt, errors}` is shown as «применено» / «ожидает» / errors. `deathmatch.minPlayers` is read by the mod's `DeathmatchMode` at the start of the next Deathmatch room (see `blockfield-mod`'s `AdminSettings`/`DeathmatchMode.loadRules`), so a change never affects a match already in progress, matching `campaignBalance`.
- Workshop map access: a `builder` row in `staff_roles` (schema v6) carries an optional `maps` array of modpack map ids (`src/lib/game-names.ts` `MAP_NAMES`, the same list the rest of the UI uses). Missing/`null` means every map, including ones added later; `[]` means the builder still gets a workshop account (can open the hub) but has no map to edit. `lead`/`admin` never carry one (`workshopMembers` in `src/lib/admin.ts` drops it for anything but `builder`). Set through `POST /api/admin/staff/maps {uuid, maps: string[]|null}` (`roles` permission, i.e. admin/owner), validated server-side against the known id list (no unknown ids, no duplicates; `null` or any array length, including empty, is valid), and re-synced to the workshop `members` inbox request like a role change. The «Команда» tab shows the picker only for builders, labelled «все» when `maps` is `null`, «нет» when it is `[]`, and «N из M» for more than three maps. The «Мастерская» tab shows the same lists per map: `POST /api/admin/staff/map-access {mapId, uuids}` (`roles`) sets that one map for every builder in one change (`withMapAccess`: granting keeps `null`, revoking from `null` becomes every other known map, a grant never turns a list into `null`), then sends one `members` request.
- RCON: one connection per call, 5 s timeout. Only fixed command shapes from `rconCommand()`; nicknames `^[A-Za-z0-9_]{3,16}$`, room UUIDs, class ids, and free text ≤120 chars with control characters and `§` replaced, never starting with `/`. `range` is sent as `bf range <op>`. A reply starting with `Unknown or incomplete command`/`Unknown command` or containing `<--[HERE]` is reported as a failure. Connection errors reach the browser only as «Игровой сервер не отвечает»; the details go to the server log and the audit entry. `stop room … win RED|BLUE` is sent as `win RedTeam|BlueTeam` (the game's team names). A bare stop reason cannot start with `win`/`draw`. Interrupt sends `bf maintenance interrupt` and `… confirm <reason>` on the same connection (the game requires the same sender within 60 s).

## Statistics administration

- Void/restore a result (`results.voided_at/voided_by`). Voided results leave every leaderboard, profile and history query. A producer replay of a voided result stays voided. Voiding or restoring a rated campaign (campaign, completed/draw) deletes the ratings and rating changes of its season **and every later season** and replays all non-voided rated campaigns from that season's start in `ended_at, server_id, event_id` order through the normal rating code, so later seasons' carry-over stays consistent. Earlier seasons are untouched.
- Ingest keys: `ingest_keys` stores only SHA-256 of the key; the plaintext is shown once on creation. `POST /api/stats/results` accepts env keys (`BLOCKFIELD_STATS_INGEST_KEYS`) or non-revoked DB keys for the same server ID, compared in constant time.
- Seasons are read-only (generated by code).

## Audit

Every non-GET call by a staff member writes `admin_audit` (actor, role, action, target, JSON detail capped at 2 KB, ok, error), including permission refusals and failures. Players without a role are refused before the request body is read and are not audited, so they cannot grow the table. The table keeps the newest 10 000 rows; admin sees the last 200. Settings bodies and RCON output (first 500 chars) are kept in `detail`; RCON passwords and ingest keys never are.

## Local development

There is no Drasl login for a local test account, so a dev-only identity exists: when `NODE_ENV !== 'production'` **and** `BLOCKFIELD_ADMIN_DEV_USER=<uuid>:<name>` is set, the site treats every request as that player (role still comes from owners/`staff_roles`). The Docker image sets `NODE_ENV=production`, which disables it.

```sh
d=$(mktemp -d); mkdir -p $d/admin/results $d/inbox $d/settings
BLOCKFIELD_STATS_DB=$d/stats.sqlite BLOCKFIELD_ADMIN_DIR=$d/admin BLOCKFIELD_INBOX_DIR=$d/inbox BLOCKFIELD_SETTINGS_DIR=$d/settings \
BLOCKFIELD_OWNER_UUIDS=e10438e4797b49718cfecec6a8fa171b BLOCKFIELD_ADMIN_DEV_USER=e10438e4797b49718cfecec6a8fa171b:Nether npm run dev
```

## Threat notes

- Fail closed: no DB, no owners and no grants, an unknown role, or a Drasl error all mean no access. Owners cannot be demoted from the UI, so a compromised admin cannot lock out the owner or grant admin.
- No raw console: the browser sends an action name and arguments, never a command string. Validation rejects newline/space injection in names and leading `/` in text.
- Mutations use the existing same-origin check (`route()`), the `SameSite=Strict` session cookie and `Cache-Control: no-store`. No rate limiting yet (put the reverse proxy in front).
- A stolen session gives that player's role until the Drasl token is reset; revoke the role on the site, which also updates the workshop list.
- The inbox is trusted by the controller: it must still validate requests itself (the site is not the only writer to the host directory).
- The dev identity is ignored in production; never set `NODE_ENV` to anything else in deployed containers.

A recognized account with no admin access is not necessarily a lost login. Check the effective `BLOCKFIELD_OWNER_UUIDS` and selected database first. Owner access is deliberately environment-only; restoring a database does not restore this variable. Persist it in Dokploy and preserve it when updating the application environment.
