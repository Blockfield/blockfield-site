# Product

<!-- impeccable:product-schema 1 -->

> Facts here are derived from the repository (landing copy, legal pages, admin panel, launcher
> palette, stats schema) and the owner's brief, not from a live interview: this session had no
> question channel to the owner. Items marked **[inferred]** need a yes/no from the owner; everything
> else is quoted or directly traceable to code.

## Platform

web

## Users

- **Player (primary).** A Russian-speaking Minecraft player, usually on a home PC with Windows or
  Linux, who heard about Blockfield from a friend or a video. On the site they do exactly three
  things: get the game running, check how they are doing, and manage their account. They are not
  reading — they are on the way somewhere, usually back into a match.
- **Team member (staff).** A builder, moderator, administrator or the owner. They open `/admin`
  mid-session, often on a phone, usually because something needs fixing right now: someone is
  griefing, a match is stuck, the server has to go down for maintenance. Their time budget is one
  minute, not ten.
- **Prospective player (unregistered).** Arrives from a link, has never heard of the project, and
  decides within one screen whether to download a launcher from a stranger.

## Product Purpose

Blockfield is a team shooter built inside Minecraft 1.21.1 (Fabric): two teams, capture points,
tickets, classes and loadouts. The website is not the game — it is the front door and the record
book. It exists to:

1. **Get a player into a match** — Blockfield Launcher installs the modpack, Minecraft and Fabric,
   and connects to `play.blockfield.pro`. Manual install (ZIP / mrpack / Prism instance) stays
   available for people who refuse an unknown installer.
2. **Keep the record** — every finished match and campaign is ingested into a durable SQLite store
   and shown as a leaderboard and per-player history, with a seasonal Glicko-2 rating for Ranked
   campaigns. The record survives the game server: "История не зависит от доступности игрового
   сервера."
3. **Hold the identity** — Blockfield ID (a self-hosted Drasl auth server at `skins.blockfield.pro`)
   is one nickname and password for the launcher, the game and the site, plus skin and cape upload.
4. **Let the team run the server** — one panel for server mode, maintenance, players, live matches,
   game balance, roles, statistics and an audit journal, without anyone touching a console.

Success = a first-time visitor is in a match without asking a question, and a moderator can stop a
griefer from a phone in under a minute.

## Positioning

A small, self-hosted, Russian-language project that controls its whole stack — game mod, launcher,
auth server, stats ingestion, admin panel — and therefore can make promises a "Minecraft server with
a website" cannot: your identity is not Mojang's, your history is not the server's uptime, your
rating is a real seasonal Glicko-2 number, and the people running the server are visible and
reachable (support in Discord: `https://discord.gg/cAUcpeCVDM`).

The site's second promise is honesty about being small: there is no marketing fiction, no invented
player counts, no fake testimonials. Every number on the site is a number the database actually
holds.

## Operating Context

- **Routes:** `/` (landing + live room list + server address), `/leaderboard`, `/players/[uuid]`,
  `/account` (Blockfield ID: login, register, skin, cape, password), `/admin` (7 permission-gated
  tabs), `/terms`, `/privacy`. API under `/api/{account,admin,stats,rooms}`.
- **Language:** every interface string is Russian. Latin appears only in proper nouns (Blockfield,
  Minecraft, Fabric, Casual / Ranked / Deathmatch, MMR), file formats and the mono HUD codes.
- **Time:** the game server, the ingest payload and the server logs agree on UTC. Player and
  admin pages show the visitor's local time with the zone always labelled; the leaderboard and
  season boundaries stay UTC and labelled as such.
- **Rendering:** Astro SSR on Node; no client framework. Everything must work with JavaScript
  disabled except the parts that are genuinely live (room list, account forms, admin panel).
- **Sessions:** `bf_session` httpOnly cookie holding a Drasl token. `/admin` and `/account` are
  `noindex`, `no-store`.
- **Rituals:** the team checks `/admin` → Обзор before and after every release; a moderator's first
  move is the Игроки tab; the owner's is Настройки игры or Команда.

## Capabilities and Constraints

- **Stats are match-derived and voidable.** Combat counters come from matches only; campaign
  summaries never double-count. An administrator can exclude a match, which removes it from the
  leaderboard and profiles and replays the season's ratings.
- **MMR is seasonal Glicko-2**, changed once per completed Ranked campaign, never per round.
  Casual, Deathmatch, stopped and abandoned campaigns do not move it. Under 5 rated campaigns in a
  season (or RD > 150) is provisional. A new season soft-resets halfway toward 1500.
- **Seasons** are UTC calendar quarters; the alpha season ran 2026-09-14…25, season 1 absorbs the rest of 2026.
- **Identity is the UUID.** Nicknames change and are resolved through Drasl; the record belongs to
  the UUID. The site must never present a nickname as the identity, and must degrade to
  «Неизвестный игрок» rather than showing a raw UUID to a player.
- **Skins** live on Drasl at `skins.blockfield.pro`; the Yggdrasil profile endpoint
  (`/session/minecraft/profile/<uuid>`) is public and returns the texture URL. A player may have no
  skin at all — every skin surface needs a real fallback.
- **Admin actions are permission-gated and fully audited**, including refusals and failures. The
  panel talks to the game server over RCON and to the host controller through a file inbox with
  ~15 s apply latency; the UI must always say what is pending rather than pretend it is done.
- **Roles are cumulative:** builder ⊂ moderator ⊂ admin ⊂ owner. Owners come only from the server
  environment and cannot be granted or revoked in the panel.
- **No Mojang account is required or accepted** (decision of 2026-09-13); registration is open; a
  licensed skin of the same nickname is imported once as a courtesy.
- **Undecided:** whether the site will ever carry news/patch notes, and whether `/leaderboard`
  should gain per-class or per-map boards. **[inferred]**

## Brand Commitments

- **Name and mark:** BLOCKFIELD, always uppercase in the interface, with the chevron mark
  (`/logo.svg`).
- **Palette and typography are shared with Blockfield Launcher** (`src/styles/theme.css` there) and
  must change only together with it. This is a hard constraint, stated in the landing source.
- **Voice:** plain, confident, short. Sentences a player would say out loud. No marketing
  superlatives, no hype, no exclamation marks, no emoji. Second person plural («вы») without
  formality theatre.
- **Honesty clauses are mandatory:** "Проект не связан с Mojang и Microsoft"; the launcher's
  platform support is stated as it is (no macOS build); support goes to a named human.
- **Content rule — say what the player gets, not how it is computed.** Explain a mechanic only where
  the player can act on it; move the arithmetic behind a disclosure or drop it.
- **Content rule — one idea per sentence, one job per block.** A paragraph that needs a comma-spliced
  clause about edge cases belongs in a hint under the field it affects.

## Evidence on Hand

- Real launcher builds and versions, resolved live from the releases repository (`src/lib/launcher.ts`).
- Real live room state, including capture-point progress and ticket counts (`/api/rooms`).
- Real match history and ratings in the statistics store; `docs/statistics.md` and
  `docs/statistics-review-2026-09-13.md` document the schema and its audit.
- Real hero art at `public/plates/hero-art.webp`; OG image at `public/og.jpg`.
- **Absent, and must not be fabricated:** player counts, concurrent-user numbers, reviews,
  testimonials, press, "thousands of matches" style claims, roadmap dates, uptime percentages.

## Product Principles

1. **The next step is always obvious.** Every page has one primary action, sized and placed so a
   stranger finds it without reading: download on `/`, the player's own profile on `/leaderboard`,
   save on `/admin`.
2. **Never show a number without its meaning, never explain a number nobody can use.** A stat gets
   a plain-language label; the formula behind it goes in a disclosure, not the page body.
3. **State the truth about state.** Pending, stale, unavailable and empty are first-class: the site
   says "сервер применит в течение 15 секунд" or "история временно недоступна" rather than
   showing a hopeful blank.
4. **The record outlives the server.** Statistics, identity and history are presented as durable;
   nothing about them may depend on the game server answering right now.
5. **Staff speed beats staff elegance.** In `/admin`, scanability and a one-minute task beat
   expression every time; destructive actions always confirm and always say what will happen.

## Accessibility & Inclusion

- Keyboard-complete: every custom control (select, combobox, tabs, dialog) keeps native semantics and
  full keyboard operation; the native `<select>` stays the source of truth behind painted UI.
- Visible focus on every interactive element, including composite fields — the ring frames the whole
  control, not a fragment of it.
- `prefers-reduced-motion` is honored everywhere, including the 3D skin figure and the landing
  reveals.
- Body text ≥ 4.5:1 on its surface; the amber accent is never the only carrier of meaning (state is
  also named in words).
- Tables scroll horizontally in a focusable, labelled container rather than breaking the page.
