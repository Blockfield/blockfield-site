---
name: Blockfield
description: Field-console interface for a Minecraft team shooter — square plates, amber signal, mono labels.
colors:
  bg: '#070604'
  bg-2: '#0b0906'
  panel: '#11100d'
  panel-2: '#18130d'
  line: '#2a2116'
  line-2: '#3a2c1d'
  amber: '#f5a524'
  amber-hi: '#ffc861'
  amber-dim: '#8a571c'
  cream: '#f3e7d0'
  sand: '#c7ae86'
  muted: '#8e7a5e'
  dim: '#5e5040'
  ok: '#82d66b'
  danger: '#ff9d99'
  info: '#91c8ff'
  line-warn: '#4a3317'
  stage-glow: '#3a2410'
  shade: 'rgb(0 0 0 / 0.7)'
typography:
  display:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(40px, 6.3vw, 96px)'
    fontWeight: 800
    lineHeight: 1
    letterSpacing: '-0.02em'
  page-title:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(32px, 5vw, 48px)'
    fontWeight: 800
    lineHeight: 1
    letterSpacing: '-0.02em'
  headline:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(24px, 3.2vw, 34px)'
    fontWeight: 800
    lineHeight: 1
    letterSpacing: '-0.02em'
  title:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(17px, 1.4vw, 20px)'
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: '-0.01em'
  body:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(15px, 1.17vw, 17px)'
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 'normal'
  label:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: 'clamp(10px, 0.8vw, 12px)'
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: '0.18em'
  data:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: '16px'
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: '0.01em'
  small:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 'normal'
  stencil:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: 'clamp(9px, 0.7vw, 11px)'
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: '0.28em'
  compact-headline:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(20px, 2.4vw, 26px)'
    fontWeight: 800
    lineHeight: 1.1
  lead:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(15px, 1.36vw, 21px)'
    lineHeight: 1.45
  brand-mark:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(20px, 1.75vw, 27px)'
    fontWeight: 800
  metadata:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: '13px'
    lineHeight: 1.45
  dialog-title:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: '22px'
    fontWeight: 800
  status-title:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(19px, 3vw, 23px)'
    fontWeight: 700
  server-address:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: 'clamp(18px, 1.9vw, 29px)'
  display-tablet:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(40px, 6.6vw, 58px)'
    fontWeight: 800
  display-mobile:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(28px, 8.8vw, 44px)'
    fontWeight: 800
rounded:
  none: '0'
  dot: '50%'
spacing:
  hair: '4px'
  xs: '8px'
  sm: '12px'
  md: '16px'
  lg: '24px'
  xl: '32px'
  '2xl': '48px'
  '3xl': '64px'
components:
  button-primary:
    backgroundColor: '{colors.amber}'
    textColor: '{colors.bg}'
    rounded: '{rounded.none}'
    padding: '0 18px'
    height: '44px'
  button-large:
    backgroundColor: '{colors.amber}'
    textColor: '{colors.bg}'
    rounded: '{rounded.none}'
    padding: '0 clamp(18px, 1.7vw, 26px)'
    height: '56px'
  button-primary-hover:
    backgroundColor: '{colors.amber-hi}'
    textColor: '{colors.bg}'
  button-secondary:
    backgroundColor: 'transparent'
    textColor: '{colors.cream}'
    rounded: '{rounded.none}'
    padding: '0 18px'
    height: '44px'
  button-secondary-hover:
    backgroundColor: '{colors.line}'
    textColor: '{colors.cream}'
  button-danger:
    backgroundColor: 'transparent'
    textColor: '{colors.danger}'
    rounded: '{rounded.none}'
    padding: '0 18px'
    height: '44px'
  input:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.cream}'
    rounded: '{rounded.none}'
    padding: '0 12px'
    height: '44px'
  card:
    backgroundColor: '{colors.panel}'
    textColor: '{colors.cream}'
    rounded: '{rounded.none}'
    padding: 'clamp(16px, 3vw, 24px)'
  badge:
    backgroundColor: '{colors.line}'
    textColor: '{colors.sand}'
    rounded: '{rounded.none}'
    padding: '3px 8px'
  nav-link:
    backgroundColor: 'transparent'
    textColor: '{colors.sand}'
    typography: '{typography.label}'
    rounded: '{rounded.none}'
---

# Design System: Blockfield

## Overview

**Creative North Star: "The Field Console"**

Blockfield's interface is the equipment, not the poster. Every surface reads as a machined plate
bolted to a dark chassis: a hard rectangle, a hairline seam, a mono stencil code in the corner, and
one amber lamp that only lights where something matters. Nothing is soft, nothing floats, nothing is
rounded — a rounded corner in Blockfield is a manufacturing defect. The reference is a vehicle
instrument panel and a Minecraft block at the same time: both are made of right angles, and both look
better when you can see how they were assembled.

The palette is almost entirely dark warm neutrals — near-black with brown in it, never blue-black —
so that the single amber signal reads as illumination rather than as a brand colour. Cream and sand
carry the text; amber carries the verb. Because the whole product is played at night on a monitor,
the system is dark-native: there is no light theme and there will not be one.

Density is high but never cramped. Type does the hierarchy work, not decoration: uppercase Inter at
weight 800 with tight negative tracking for anything that shouts, IBM Plex Mono at wide positive
tracking for anything that labels, measures or identifies. The mono is not a costume for "technical"
— it appears only on labels, codes, addresses, timestamps and numeric data, which is exactly what a
console stencils.

**Key Characteristics:**

- Zero radius. Every corner in the product is 90°; the only circles are status dots and radio marks.
- Warm near-black chassis, four tonal steps of it, separated by 1px hairlines rather than shadow.
- One accent (amber) on ≤10% of any screen, always attached to an action or a live state.
- Uppercase 800-weight display type with -0.02em tracking; mono stencil labels at +0.18em.
- Flat at rest. Depth appears only when something is genuinely above the page (popover, dialog) or
  genuinely energised (primary button glow).
- Every state has a word, not only a colour.

## Colors

A warm, almost monochrome chassis lit by one amber lamp; every non-amber hue in the system exists
only to name a state (ok, danger, red team, blue team).

### Primary

- **Signal Amber** (`#f5a524`): the product's only accent. Primary buttons, the active tab, the
  focus ring, live state, section markers, links in body copy, the mark's chevron. If a screen has
  more than a tenth of its area in amber, the screen is wrong.
- **Signal Amber Bright** (`#ffc861`): hover only. Never a resting colour.
- **Signal Amber Deep** (`#8a571c`): amber that must sit under text or behind a hairline; never a
  fill for an interactive element.

### Neutral

- **Chassis Black** (`#070604`): the page. Warm near-black — there is brown in it. Also the text
  colour printed on amber fills.
- **Chassis Black Recessed** (`#0b0906`): alternating band for a section that must read as a
  different bay of the same machine (`.path`, `.rooms`).
- **Plate** (`#11100d`): every card, panel, popover, dialog and sticky bar. The one surface colour.
- **Plate Deep** (`#18130d`): inset wells inside a plate — icon tiles, code samples, field addons.
- **Seam** (`#2a2116`): the default 1px border and every divider, including table rules. Also the
  resting fill of a neutral badge.
- **Seam Lit** (`#3a2c1d`): the 1px stroke of an input, a checkbox, or any control the user can put
  a caret into. It is one step brighter than Seam precisely so a field reads as touchable.
- **Cream** (`#f3e7d0`): headings, primary body text, values in a table.
- **Sand** (`#c7ae86`): secondary text, descriptions, table headers, nav links at rest.
- **Muted** (`#8e7a5e`): tertiary text, hints under a field, footer.
- **Dim** (`#5e5040`): stencil codes and the quietest metadata. Never a label a user must read to
  act.

### Tertiary — state hues

- **Live Green** (`#82d66b`): running, applied, saved, ok.
- **Alert Rose** (`#ff9d99`): destructive actions, errors, invalid fields, RED team.
- **Comms Blue** (`#91c8ff`): BLUE team only. It is not an "info" colour and must not become one.
- **Seam Warm** (`#4a3317`): the border of a card that warns. The only border hue that is not Seam
  or a state hue, and it never becomes a fill.
- **Stage Glow** (`#3a2410`) and **Shade** (`rgb(0 0 0 / 0.7)`): the 3D stage's ground light and the
  dialog backdrop / ground shadow. Environment, not palette — they never touch text or a control.

### Named Rules

**The One Lamp Rule.** Amber marks the one thing that acts or the one thing that is live. A screen
gets one amber fill; everything else that needs emphasis gets a border, a weight step, or a word.

**The No Blue-Black Rule.** Every neutral in this system is warm. A neutral sampled from a stock
dark theme (`#0f1115`, `#111827`, any grey with blue in it) is instantly foreign and is a bug.

**The Colour-Plus-Word Rule.** A state is never communicated by hue alone. Green dot and "Сервер
работает"; rose border and "Не получилось: …". This is an accessibility floor, not a preference.

## Typography

**Display Font:** Inter Variable (fallback `system-ui, sans-serif`)
**Body Font:** Inter Variable (same family; the pairing is by weight and case, not by family)
**Label / Data Font:** IBM Plex Mono (fallback `ui-monospace, SFMono-Regular, monospace`)

**Character:** Inter at 800 with negative tracking, set in uppercase, reads stamped rather than
typeset — it behaves like the silkscreen on a case, not like a magazine headline. IBM Plex Mono at
+0.18em is the stencil beside it. The tension between the two — heavy shout, thin stencil — is the
entire typographic idea; there is no third voice.

### Hierarchy

- **Display** (800, `clamp(40px, 6.3vw, 96px)`, line-height 1, -0.02em, uppercase): the landing hero only. Every other page H1 uses Page title
  (800, `clamp(32px, 5vw, 48px)`, line-height 1, -0.02em, uppercase).
- **Headline** (800, `clamp(24px, 3.2vw, 34px)`, line-height 1, -0.02em, uppercase): section
  openers (`h2`).
- **Title** (800, `clamp(17px, 1.4vw, 20px)`, line-height 1.1, uppercase): card and panel headings
  (`h3`). Under 18px, drop the uppercase — stamped type stops being legible.
- **Body** (400, `clamp(15px, 1.17vw, 17px)`, line-height 1.6, sentence case): all prose. Measure
  capped at 34em (≈68ch); a paragraph wider than that is a layout bug.
- **Small** (400, 14px, line-height 1.45): hints under a field, metadata in a row, footer.
- **Label** (mono 500, `clamp(10px, 0.8vw, 12px)`, +0.18em, uppercase): section markers, eyebrow
  codes, stat captions, table headers. Never a full sentence.
- **Stencil code** (mono 500, `clamp(9px, 0.7vw, 11px)`, +0.28em, uppercase, Dim): the right-hand
  code in a section rule. Decorative by design; it may never carry information.
- **Data** (mono 500, 16px, `font-variant-numeric: tabular-nums`): every number in a table, every
  MMR, every score, the server address, every timestamp.

### Named Rules

**The Tabular Rule.** Any digit a user compares against another digit is mono and tabular. A
leaderboard column whose numbers jitter between rows is not shipped.

**The Sentence Case Rule.** Uppercase belongs to headings, labels and button verbs. A sentence is
never uppercased, and a label is never a sentence.

## Layout

The product uses two container widths and one gutter ramp:

- **Full-bleed sections** (landing): `padding: clamp(48px, 5vw, 86px) clamp(20px, 4.5vw, 70px)`,
  separated by a 1px Seam top border. Sections alternate Chassis Black and Chassis Black Recessed.
- **Reading and console pages** (leaderboard, profile, account, legal): `max-width: 1200px`
  centred, `padding: 24px clamp(20px, 5vw, 48px)`. Legal prose narrows further to 78ch. The admin
  console (`/admin`) is the one exception — see below.
- **Spacing rhythm:** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96. Inside a group, 8–12. Between
  groups, 16–24. Between sections, 48–96. More space above a heading than below it, always.
- **Card grids:** `repeat(auto-fit, minmax(min(100%, 320px), 1fr))` with a 16px gutter and
  `align-items: start` — a card is only ever as tall as its own content; it never stretches to
  match a taller row neighbour and grows a blank body. A card that must span is
  `grid-column: 1 / -1`, never a second grid, and a spanning card lives outside any `.cards` grid
  it would otherwise share a row with (a spanning item forces the grid's columns to stay allocated
  for every row, so a later short row of non-spanning cards would leave a visibly blank column).
- **Breakpoints:** 900px (two-column layouts collapse), 760px (header links move into the burger),
  600px (phone: gutters drop to 14px, buttons go full width, tables scroll).
- **Minimum width 320px.** Below that the page is allowed to scroll horizontally rather than be
  crushed.
- **Tables** live in a focusable `.table-wrap` with `overflow-x: auto` and an `aria-label` that
  mentions the scroll. Numeric columns are right-aligned; the player column is the only one that
  wraps.

### Admin console (`/admin`)

Staff use the console to complete a specific server task. It keeps the Field-console palette and
square controls, with a compact identity header and a 1320px workspace.

- One permission-filtered navigation list groups «Операции», «Игра и карты», and «Управление».
  Desktop navigation stays at the top while scrolling; below 600px the same groups wrap into rows.
  Builder opens the Workshop, moderator opens Players, admin and owner open Overview.
  A forbidden or unknown hash returns to the role's permitted default. Console is owner-only.
- Operational sections use stacked rows separated by 1px seams. Status, mode changes, messages,
  moderation and map history retain their own permissions and action feedback.
- Workshop is one workflow: status card with its switch, pending decisions, then one disclosure
  per map whose summary already names the version in the game and its builders. Rows inside a
  map plate drop their own plate and become seam-divided lines; no card sits inside a card.
- Game settings use native disclosure groups. Weapon balance has its own section and save action;
  both forms retain the shared server revision. The settings save bar exposes the revision,
  unsaved changes and actual server application receipt. Reloading a draft requires confirmation.
- Native dialogs protect destructive actions, Escape cancels, and focus returns to the opener.
  The existing keyboard-accessible selects remain shared controls; no parallel mobile navigation
  or page-specific palette is introduced.

## Elevation & Depth

The system is **flat by default and layered by hairline**. Depth comes from four warm tonal steps
(Chassis → Recessed → Plate → Plate Deep) separated by 1px Seam borders. Cards do not lift. Sections
do not float. A shadow in this system means one of exactly two things: _this element is temporarily
above the page_, or _this element is energised_.

### Shadow Vocabulary

- **Popover** (`box-shadow: 0 12px 28px rgb(0 0 0 / 0.55)`): custom select listbox, combobox
  listbox, dialog. Real offset, real blur, no colour.
- **Energised** (`box-shadow: 0 0.3em 1.6em rgb(245 165 36 / 0.16)`, hover
  `0 0.5em 1.8em rgb(245 165 36 / 0.26)`): the amber primary CTA only. It is the lamp's spill, and
  it appears on at most one element per viewport.

### Named Rules

**The Hairline Rule.** Separation is a 1px Seam border. If two things need to be distinguished and a
border would do it, a shadow is wrong.

**The No Left-Stripe Rule.** A thick coloured `border-left` on a card or banner is banned. Tone is
carried by a dot plus a word plus, at most, a 1px border in the state hue.

## Shapes

- **Radius is 0.** Buttons, inputs, cards, badges, tabs, dialogs, popovers, table cells, textareas,
  checkboxes: all square. The only curved shapes in the product are the status dot, the radio mark,
  the 3D figure's ground shadow, and the logo mark itself.
- **Borders are 1px.** The one exception is the 2px amber top rule on a landing feature card, which
  is a deliberate accent bar, and the 1px hairline it never grows past elsewhere.
- **The plate silhouette:** a rectangle, a 1px seam, and optionally a mono code in the corner. This
  is the repeated form of the whole product.
- **The diagonal:** the landing hero's clipped polygon (`clip-path: polygon(0 0, 57% 0, 45% 100%, 0
100%)`) is the one non-orthogonal shape in the system. It belongs to the hero and nowhere else.
- **The voxel field:** a two-scale radial dot grid at 16px (one Minecraft texel) and 96px (six
  blocks), amber at 11% / 22%, used behind sections that want to feel like ground. It is a texture,
  not a divider.
- **Pixels stay pixels.** Any Minecraft texture (skin head, 3D figure, cape) renders with
  `image-rendering: pixelated` and integer scaling. A blurred skin is a bug.

## Components

### Section rule (signature)

The system's recurring header: `▪ ЛАБЕЛ ─────────── CODE`. A 6px amber square, a mono uppercase
label in Cream, a 1px Seam line that eats the remaining width, and a wide-tracked stencil code in
Dim. It opens every landing section and every console page section. The code is decorative and never
carries meaning; the label always repeats in the heading below in plain words.

### Buttons

- **Shape:** square (`border-radius: 0`), height 44px on every page, `padding: 0 18px`, 14px
  text, uppercase, weight 700, +0.06em tracking. Buttons, button links, tabs, pagination and
  single-line fields share `--control-height`.
- **Large:** explicit `.button--large`, 56px at every viewport (`--control-height-large`),
  reserved for landing download actions. Colour variants never change height, padding or type.
- **Primary:** amber fill, Chassis Black text. Energised shadow belongs to the large landing
  variant only. `.primary` is the same colour variant for buttons and button links.
- **Hover:** background → Amber Bright, `translateY(-2px)` on the landing CTA only; console buttons
  do not move.
- **Secondary:** transparent fill, 1px amber border, Cream text; hover fills with Seam.
- **Ghost:** no border, Sand text, hover → amber. Used for tertiary actions inside a row.
- **Danger:** transparent fill, 1px Alert Rose border, Alert Rose text. Danger-primary (rose fill,
  black text) exists only inside a confirmation dialog.
- **Small:** 44px tall, 14px text, 12px horizontal padding — compact row actions retain the
  same height and touch target as regular buttons.
- **Disabled:** `opacity: 0.55`, `cursor: not-allowed`; a button that is disabled while working says
  so in the adjacent status line.
- **Focus:** 2px amber outline, 3px offset, on every variant.

### Inputs / Fields

- **Style:** Chassis Black fill, 1px Seam Lit stroke, square, 44px minimum height, 12px horizontal
  padding, inherited font. Placeholder in Muted (≥4.5:1).
- **Label** sits above the control at weight 600; the hint sits below it in Small/Muted and is bound
  with `aria-describedby`.
- **Focus:** 2px amber outline, 3px offset.
- **Invalid:** `:user-invalid` switches the stroke to Alert Rose. The error text names the problem
  and the fix.
- **Composite field (input + unit suffix, input + button):** the wrapper is the control. It carries
  `:focus-within` and takes the outline; the inner input's own outline is suppressed. The suffix is a
  Plate Deep well with a Seam Lit border sharing the input's edge, Muted 14px, `aria-hidden`. A focus
  ring that frames only part of a composite field is a defect.
- **Checkbox / radio:** native `<input>` with `appearance: none` and the box painted on — 20px,
  Seam Lit stroke, Chassis Black fill, amber when checked. Checkbox square, radio circular. Never a
  `<div role="checkbox">`.

### Select (signature)

The native OS dropdown is replaced everywhere, but never removed: a hidden native `<select>` stays
the single source of truth for value, name, form submission and `change` events, and a painted
button + `role="listbox"` pair is synced to it. Trigger looks exactly like an input plus a 9px
chevron drawn from a rotated border. Listbox: Plate, 1px Seam Lit, Popover shadow, `max-height:
260px`, sized to content but never narrower than the trigger. Active option gets a Seam background;
the selected option is amber. Full keyboard: ↑ ↓ Home End Enter Space Escape Tab, with
`aria-activedescendant`.

### Combobox (signature)

Same skin as the select, but the trigger is a real text `<input>`: the user may always type a value
that is not in the list. Options are filtered case-insensitively as they type, the listbox opens on
focus and on input, and the input keeps `autocomplete="off"` plus `role="combobox"`,
`aria-expanded`, `aria-controls`, `aria-activedescendant`. Used wherever staff must name a player:
the suggestions are known players, the freedom to type is the requirement.

### Cards / Containers

- **Corner:** square. **Background:** Plate. **Border:** 1px Seam. **Shadow:** none.
- **Padding:** `clamp(16px, 3vw, 24px)`; internal gap 12px.
- A card holds one job and names it in an `h3`. Cards are never nested. A warning card differs only
  by a Seam-Lit-warm border (`#4a3317`), not by a fill.
- A landing feature card is the exception: no side or bottom border, a 2px amber top rule, and a
  short amber-to-transparent wash.

### Tables

Full width, `border-collapse: collapse`, `font-variant-numeric: tabular-nums`. Header cells are mono
Label in Sand, uppercase. Cells get 16px vertical / 12px horizontal padding and a 1px Seam bottom
border. Numeric columns right-align. Rows do not stripe and do not lift; the hairline is the
structure. Each table lives in a focusable, labelled `.table-wrap`.

### Player head (signature)

A 32px square of the player's Minecraft skin, face layer plus hat layer, drawn straight from the
texture with `image-rendering: pixelated` and integer scaling — never resampled, never circular. It
sits 12px left of the nickname in any list of players. With no skin, the block falls back to a flat
Seam-filled square with a 1px Seam Lit border: still a head-shaped plate, never a letter avatar,
never a coloured circle.

### 3D figure (signature)

The full skin rendered as CSS 3D cuboids from the raw texture (no WebGL, no library): six faces per
part, per-face brightness filters standing in for lighting, a slow 18s yaw, a gentle limb swing, and
pointer-drag to rotate. It stands on a voxel-grid stage with a radial ground shadow. Under
`prefers-reduced-motion` the rotation stops and the figure stands still; with no skin the figure
renders as flat Seam blocks. It is the one moment of delight in the product and appears exactly
twice: the account page and the player profile hero.

### Navigation

Header is a 1px-Seam-bottomed bar, `clamp(64px, 6.64vw, 102px)` tall: mark on the left, mono
uppercase +0.14em Sand links, then the player's nickname, then the console entrance, then the amber
link to the installation section. Links hover to amber and grow a 2px amber underline from the left. The console entrance
(«ПАНЕЛЬ») is a square amber-bordered chip in mono, not a pill. Below 760px every link collapses
into a burger that opens a full-height Plate overlay; the overlay's links are stacked rows separated
by Seam hairlines, and Escape closes it.

### Tabs

Square, no radius, mono-adjacent weight 600. Resting: Sand on transparent. Hover: Cream on a faint
Plate wash. Current: Chassis Black on amber fill. The strip is sticky under the header with a Seam
bottom border and scrolls horizontally on a phone rather than wrapping into two rows.

### Badges

Square, 13px, 3px/8px padding, Seam fill with Sand text. Variants recolour fill and text only:
ok (green at 12% / Live Green), warn (amber at 12% / amber), bad (rose at 12% / Alert Rose). A badge
never replaces a sentence — it abbreviates one that is already on screen.

### Dialogs

Native `<dialog>` with `showModal()`: focus trap, Escape, focus returned to the opener — all free,
all required. Plate fill, 1px Seam Lit border, square, `width: min(520px, 100vw - 24px)`, 22px
padding, backdrop `rgb(0 0 0 / 0.7)`. Title in Title type, body prose in Body, actions right-aligned
with cancel first and the confirming (often danger) action last. A dialog appears only for a
destructive or irreversible action, never for a form that could live on the page.

### Sticky bars

The settings save bar sticks to the bottom of the viewport with a Chassis Black 95% fill, a 1px Seam
top border and 16px vertical padding. It holds the primary action plus one status line and nothing
else. On a phone the button goes full width.

### Status line

Every form and every action owns one `role="status"` line directly beneath it. Empty = nothing to
say (and it collapses). Tones: `.ok` Live Green, `.error` Alert Rose, `.pending` amber. A pending
line always states the expected wait in seconds when the wait is known.

## Do's and Don'ts

### Do:

- **Do** set `border-radius: 0` on every new surface, and reach for a 1px `--line` border before any
  other separator.
- **Do** take colours from the tokens in `src/styles/system.css`; that file is the only place a hex
  value is written, and it mirrors the launcher's `theme.css`.
- **Do** put the focus ring on the wrapper of a composite control with `:focus-within`, and suppress
  the inner element's own ring.
- **Do** keep the native `<select>`, `<input>`, `<dialog>` and `<details>` underneath any painted
  UI, so keyboard and assistive technology keep working for free.
- **Do** give every number a mono, tabular setting and a plain-language label.
- **Do** name the state in words next to the colour that shows it, and say how long a pending action
  is expected to take.
- **Do** render Minecraft textures at integer scale with `image-rendering: pixelated`.
- **Do** gate every animation behind `prefers-reduced-motion`.

### Don't:

- **Don't** introduce a radius, a pill, a circular avatar or a rounded chip. The round «ПАНЕЛЬ» pill
  is the canonical example of what this system rejects.
- **Don't** use a cool grey or blue-black anywhere; every neutral is warm.
- **Don't** put a thick coloured `border-left` on a card, banner or list row.
- **Don't** add a second accent colour. Green, rose and blue are state hues with fixed meanings and
  are never used decoratively.
- **Don't** use mono type for prose, or uppercase for a sentence.
- **Don't** lift cards on hover or add ambient shadows to resting surfaces.
- **Don't** explain a formula in page body copy. If a mechanic needs arithmetic, it goes in a
  `<details>` or a hint; the body says what the player gets.
- **Don't** show a raw UUID, a schema version, a revision number, an English error string or any
  other internal identifier to a player. The console may show identifiers to staff who need them.
- **Don't** replace a native control with a `div` that re-implements its semantics.

## Shared implementation

`src/layouts/Site.astro` owns fonts, base CSS, page metadata, skip link, header and footer.
Every route composes this shell. `Community.astro` adds the shared `.page-main` and heading;
account and admin use the same page container directly. Admin retains its 1320px workspace,
and legal documents retain the 78ch reading measure. These are layout variants, not control variants.

Native file-selector buttons use the same 44px button style; upload controls do not introduce an OS button variant.

`SectionRule.astro` owns the recurring section marker and hides its decorative code from assistive
technology. `.form-grid`, `.disclosure`, `.oops` and `.stage-hint` live in `system.css`.
Legal prose selectors stay under `.legal-main`, so typography does not affect the shared chrome.

Native selects remain the source of truth. Their painted button follows value changes, form reset
and disabled state. The mobile menu makes the underlying page inert, restores it on close, and
closes when the viewport crosses the desktop breakpoint.

### Responsive action width

Action buttons and button links share `--action-width: 320px` above 1024px, capped by their
container. At 1024px and below, all actions fill their container, including `.small` buttons,
pagination and dialog actions. Colour and height do not change across these breakpoints.
Navigation tabs and the menu icon retain their own sizes. A file selector keeps its internal
button compact so the selected filename remains visible; the upload field itself fills the form.
The header download button uses the same desktop width; the mobile menu action fills its panel.
Button icons are 20px with a shared `--button-icon-gap: 12px`; text and icon are centred together.
Button variants do not override this spacing.

Landing actions keep their download destinations and use contextual labels: «Начать играть»
in the hero, the platform-specific download label in installation, and «Получить лаунчер»
next to the server address. The header uses «Скачать».
