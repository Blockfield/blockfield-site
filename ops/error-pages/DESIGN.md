---
name: Blockfield shared 404
description: Scoped recovery surface in Blockfield's Field Console visual world.
colors:
  bg: '#070604'
  cream: '#f3e7d0'
  sand: '#c7ae86'
  line: '#3a2c1d'
  amber: '#f5a524'
  amber-hi: '#ffc861'
typography:
  headline:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: 'clamp(28px, 4vw, 42px)'
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: '-0.025em'
  body:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: '16px'
    fontWeight: 400
    lineHeight: 1.6
  action:
    fontFamily: "'Inter Variable', system-ui, sans-serif"
    fontSize: '14px'
    fontWeight: 700
    letterSpacing: '0.1em'
  data:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: '14px'
    fontWeight: 400
rounded:
  none: '0'
components:
  button-primary:
    backgroundColor: '{colors.amber}'
    textColor: '{colors.bg}'
    typography: '{typography.action}'
    rounded: '{rounded.none}'
    padding: '14px 22px'
  button-primary-hover:
    backgroundColor: '{colors.amber-hi}'
  button-secondary:
    backgroundColor: 'transparent'
    textColor: '{colors.cream}'
    typography: '{typography.action}'
    rounded: '{rounded.none}'
    padding: '14px 22px'
  button-secondary-hover:
    backgroundColor: '{colors.line}'
---

# Design System: Blockfield shared 404

## Overview

**Creative North Star: "The Field Console"**

This document records only `blockfield.html` in this directory. The project-root
`DESIGN.md` remains the wider brand authority. The shipped page uses its warm black,
amber signal, cream text, heavy Inter and square controls in a compact recovery surface.
The large particle numeral is a local expression of that world, not a new global pattern.

**Key Characteristics:**

- Warm dark background; amber numeral and one filled recovery action.
- Heavy uppercase heading and actions; sentence-case explanatory copy.
- Square controls and square particles; no card shadows.
- Recovery content is independent of decorative canvas rendering.

## Colors

### Primary

- **Signal Amber** (`amber`): 404 particles, solid fallback numeral, primary fill,
  secondary border and text selection.
- **Signal Amber Bright** (`amber-hi`): primary-button and install-link hover;
  keyboard-focus outline.

### Neutral

- **Chassis Black** (`bg`): page background and text on the primary action.
- **Cream** (`cream`): heading, wordmark, secondary action, address and install link.
- **Sand** (`sand`): explanation, hostname and launcher/server context.
- **Seam Lit** (`line`): secondary-button hover fill. The local name maps to the
  project-root `line-2` color, not the darker root `line`.

**The One Filled Action Rule.** Only the website recovery action has an amber fill
at rest; the server action remains outlined. The decorative amber numeral is not a state.

## Typography

Inter Variable supplies the heading, prose, wordmark and actions. IBM Plex Mono
supplies the selectable server address with tabular numerals. The hostname remains
Inter, as shipped. Embedded WOFF2 data includes Inter Latin and Cyrillic subsets
(normal variable weights 100–900) and IBM Plex Mono regular (400), using
`font-display: swap`; fonts need no external request. Both families' SIL OFL 1.1
notices are retained in `FONT-LICENSE.txt`.

The ramp runs from the large decorative 404 to the responsive recovery headline,
body copy, actions/address and small context. The fallback numeral uses heavy Inter
(800), a responsive size (`clamp(120px, 28vw, 360px)`), tight tracking and line-height 1;
the canvas sizes its mask to the available stage. Explanation is capped at 40ch.
Hostname and launcher context are small (13px); hostname becomes 11px on phones.

**The Case Rule.** Heading and button labels are uppercase; explanatory prose stays
in sentence case. The address keeps its literal spelling in mono.

## Layout

The header places the linked BLOCKFIELD wordmark opposite the current hostname.
Its horizontal gutter grows with the viewport (`clamp(20px, 5vw, 64px)`). Main content
is centered with 20px side gutters; the decorative stage caps at 1000px, recovery
content at 600px. Actions wrap with a 12px gap and have a minimum height of 48px.

At 480px and below, actions form a full-width vertical stack, the stage becomes
shorter (`clamp(180px, 35svh, 300px)`), and the hostname is capped at 45% of the
header with ellipsis. The desktop stage uses `clamp(210px, 48svh, 500px)`.
The page uses a minimum height of 100svh and allows content to determine its length.

## Elevation & Depth

There are no box shadows or lifted controls. A warm radial background glow provides
atmosphere behind the stage; it is an environment treatment rather than a new
reusable color token. Hover changes fill or text color without moving controls.

## Shapes

Buttons are hard rectangles with a one-pixel amber border and no radius. The
signature numeral is drawn from small square particles. The radial glow is diffuse;
it does not turn the controls into rounded or floating surfaces.

## Components

### Recovery actions

Native links provide website recovery (`https://blockfield.pro/`) and launcher entry
(`blockfield://join/lobby`). The website action is filled amber with dark text;
launcher entry is transparent with cream text and an amber border. Both use the
same uppercase action type and padding. Primary hover brightens amber; secondary
hover fills with Seam Lit. Background/color transitions take 0.15s and are removed
under reduced motion. Every link has a visible two-pixel bright-amber focus outline
with a five-pixel offset. No separate active or disabled treatment is shipped.

### Server and launcher context

The address `play.blockfield.pro` is cream mono and selects as a whole. Context
names Minecraft 1.21.1 and explains that joining opens Blockfield Launcher. The
underlined install link targets `https://blockfield.pro/#download`; its underline
sits three pixels below the text and hover turns the text bright amber.

### Particle 404

The canvas is decorative, aria-hidden and does not intercept pointer events.
Amber squares drift, repel the pointer and return to their numeral positions.
Animation pauses while the document is hidden. Reduced motion renders a static
particle numeral and skips particle movement; a change in preference rebuilds it.
The ordinary text numeral remains the fallback when canvas cannot initialize.
The heading and recovery links remain real HTML in either state.

### Language and hostname

JavaScript selects Russian, Ukrainian or English from browser language preferences,
with English as the unmatched-language fallback, and sets the document language.
The initial HTML is Russian. The header hostname comes from `location.hostname`;
localization and hostname rendering do not control link destinations.

## Do's and Don'ts

### Do:

- **Do** preserve the warm palette, hard corners and visible keyboard focus.
- **Do** keep the recovery heading and links usable without decorative rendering.
- **Do** keep the address mono, literal and selectable, with the launcher explanation nearby.
- **Do** preserve static reduced-motion rendering and the embedded-font license notices.

### Don't:

- **Don't** add a second decorative accent or a shadow lift to recovery controls.
- **Don't** uppercase explanatory paragraphs or use mono for prose.
- **Don't** make the canvas carry recovery instructions or required interactions.
