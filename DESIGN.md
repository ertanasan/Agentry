---
name: Agentry
description: An AI delivery queue where every request is a parcel, tracked stop by stop until production signs for the commit.
colors:
  kraft-ground: "#d5c4a5"
  on-kraft: "#4a4031"
  label-stock: "#ffffff"
  label-sunk: "#f3eee5"
  thermal-ink: "#141414"
  ink-muted: "#5b5348"
  hairline: "rgb(20 20 20 / .14)"
  label-rule: "#141414"
  band-black: "#141414"
  on-band: "#f5f0e6"
  band-muted: "#b8ae9e"
  band-line: "rgb(245 240 230 / .24)"
  band-done: "#62d27e"
  band-fail: "#ff8a7a"
  band-attn: "#f6a465"
  band-work: "#8fb0ff"
  attn-orange: "#e5641a"
  attn-text: "#a8430a"
  on-attn: "#141414"
  work-blue: "#2b54c9"
  on-work: "#ffffff"
  fail-red: "#c8231c"
  on-fail: "#ffffff"
  done-green: "#1e7a3c"
  on-done: "#ffffff"
  idle-grey: "#6b6255"
  kraft-ground-dark: "#34291e"
  on-kraft-dark: "#c4b8a4"
  label-stock-dark: "#44382b"
  label-sunk-dark: "#3b3024"
  thermal-ink-dark: "#f1ebe0"
  ink-muted-dark: "#b9ae9c"
  label-rule-dark: "#a89c87"
  band-black-dark: "#0c0b09"
  attn-orange-dark: "#f0893c"
  attn-text-dark: "#f6a465"
  work-blue-dark: "#8fb0ff"
  fail-red-dark: "#ff9a8f"
  done-green-dark: "#62d27e"
  idle-grey-dark: "#b3a894"
typography:
  routing-number:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "40px"
    fontWeight: 850
    lineHeight: 1
    letterSpacing: "0.01em"
    fontVariation: "'wdth' 62"
  routing-number-row:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 850
    lineHeight: 1.1
    letterSpacing: "0.01em"
    fontVariation: "'wdth' 62"
  wordmark:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "23px"
    fontWeight: 800
    letterSpacing: "0.04em"
    fontVariation: "'wdth' 72"
  headline:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  section-head:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 800
    letterSpacing: "0.1em"
    fontVariation: "'wdth' 72"
  title:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  sticker:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 800
    lineHeight: 1.5
    letterSpacing: "0.07em"
    fontVariation: "'wdth' 75"
  label:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 750
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 85"
  track-stop:
    fontFamily: "Archivo, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 750
    letterSpacing: "0.05em"
    fontVariation: "'wdth' 80"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    lineHeight: 1.5
rounded:
  none: "0"
  tick: "2px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  page-gutter: "16px"
  page-width: "760px"
  target: "44px"
components:
  button:
    backgroundColor: "{colors.label-stock}"
    textColor: "{colors.thermal-ink}"
    rounded: "{rounded.tick}"
    padding: "8px 16px"
    height: "44px"
  button-hover:
    backgroundColor: "{colors.label-sunk}"
  button-primary:
    backgroundColor: "{colors.thermal-ink}"
    textColor: "{colors.label-stock}"
    rounded: "{rounded.tick}"
    padding: "8px 16px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.label-stock}"
    textColor: "{colors.fail-red}"
    rounded: "{rounded.tick}"
    padding: "8px 16px"
    height: "44px"
  new-request-bar:
    backgroundColor: "{colors.thermal-ink}"
    textColor: "{colors.label-stock}"
    typography: "{typography.section-head}"
    rounded: "{rounded.none}"
    padding: "0 18px"
    height: "52px"
  input:
    backgroundColor: "{colors.label-stock}"
    textColor: "{colors.thermal-ink}"
    rounded: "{rounded.tick}"
    padding: "10px 12px"
    height: "44px"
  label-card:
    backgroundColor: "{colors.label-stock}"
    textColor: "{colors.thermal-ink}"
    rounded: "{rounded.none}"
    padding: "14px"
  sticker-attn:
    backgroundColor: "{colors.attn-orange}"
    textColor: "{colors.on-attn}"
    typography: "{typography.sticker}"
    rounded: "{rounded.none}"
    padding: "1px 7px 1px 6px"
  sticker-work:
    backgroundColor: "{colors.work-blue}"
    textColor: "{colors.on-work}"
    typography: "{typography.sticker}"
    rounded: "{rounded.none}"
    padding: "1px 7px 1px 6px"
  sticker-fail:
    backgroundColor: "{colors.fail-red}"
    textColor: "{colors.on-fail}"
    typography: "{typography.sticker}"
    rounded: "{rounded.none}"
    padding: "1px 7px 1px 6px"
  sticker-done:
    backgroundColor: "{colors.done-green}"
    textColor: "{colors.on-done}"
    typography: "{typography.sticker}"
    rounded: "{rounded.none}"
    padding: "1px 7px 1px 6px"
  runner-plate:
    backgroundColor: "{colors.band-black}"
    textColor: "{colors.on-band}"
    rounded: "{rounded.none}"
    padding: "8px 11px 10px"
---

# Design System: Agentry

## Overview

**Creative North Star: "Proof of Delivery"**

Every request is a parcel. It sits on kraft board, its label is white thermal stock boxed in a heavy black rule, and it is tracked stop by stop (Agent, Build, Test, Verify, Deploy) until production runs its commit. The header is a thermal-black band where each runner is a fixed plate with its worker slots shown as a visible budget. The world is a shipping dock, not an admin console: dense, ruled, legible at arm's length on a phone.

One family carries everything. Archivo, self-hosted as a variable font with a width axis, is squeezed to condensed widths for routing numbers, the wordmark, section heads, stickers and stop names, and runs at normal width for body copy. Monospace appears only where the content is machine text: hashes, logs, diffs, commands. State is a handling sticker: a color, a shape and a word, never color alone.

Both themes follow the device. Dark is the same dock at night: dark corrugated brown ground, labels in a lighter brown stock, rules softened to a warm grey, the band near-black, sticker colors lifted for contrast. The grey admin list with one blue accent and status pills is the explicit rejection.

**Key Characteristics:**
- Kraft ground, white labels, 2px black rules, no shadows, square corners.
- One variable family, Archivo, with width doing the hierarchy work.
- Four state colors as stickers, each paired with a fixed shape and a word.
- The five-stop tracking strip as the signature; stops sit at the same x in every row.
- 44px targets everywhere; no JavaScript required for any of it.

## Colors

Warm, papery neutrals (kraft, thermal stock, thermal ink) with four saturated handling-sticker colors reserved for state.

### Primary
- **Thermal Ink** (thermal-ink): text, the 2px label rules, primary buttons, the New request bar, filled track stops. In dark it inverts to a warm off-white and primary buttons become light slabs.

### Secondary (state stickers)
- **Needs-You Orange** (attn-orange; text variant attn-text for words on light stock): waiting on a person. Diamond shape. Also tints the "go" confirm panel.
- **In-Transit Blue** (work-blue): queued and running. Ring shape, filled and beating while it runs. Also the focus ring and caret.
- **Failed Red** (fail-red): failed and deploy failed. Square shape. Also danger buttons and the dashed confirm panel for destructive actions.
- **Delivered Green** (done-green): deployed, done. Disc shape. Tints the proof-of-delivery strip at 12%.
- **Idle Grey** (idle-grey): canceled and inactive. Flat bar shape; its sticker is outlined, not filled.

### Neutral
- **Kraft Board** (kraft-ground): page ground. Text sitting directly on it uses **Dark Kraft** (on-kraft).
- **Label Stock** (label-stock): every card, list, form, table and log surface.
- **Sunk Stock** (label-sunk): inset areas inside a label: agent questions, inline code, the current table row, button hover.
- **Faded Ink** (ink-muted): metadata, hints, stop names not yet reached.
- **Hairline** (hairline): 1px dividers between rows inside one label.
- **Thermal Band** (band-black, on-band, band-muted, band-line): the header band and its plates. The band has its own lifted state colors (band-done, band-fail, band-attn, band-work) so stickers read on black.

### Named Rules
**The Sticker Rule.** A state color appears only as a state: sticker fill, a state word, a track stop, an alert mark, or a confirm panel tint. Every use carries its shape and its word.

**The Two Stocks Rule.** Content lives on label stock; kraft holds only section heads, counts and the empty-state outline. Never put readable content blocks directly on kraft.

## Typography

**Display Font:** Archivo, condensed (width 62% to 85%), with -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif
**Body Font:** Archivo at normal width, same fallbacks
**Label/Mono Font:** ui-monospace, SF Mono, Menlo, Consolas, monospace (machine text only)

**Character:** One family, stretched and squeezed like stencil and label print. Width and weight carry hierarchy; size stays modest because the phone is the primary screen.

### Hierarchy
- **Routing number** (850, 40px on a parcel label / 24px in a list row, width 62%, tabular figures, small raised "#" at 0.55em in faded ink): the request number as a routing code, everywhere a request appears.
- **Wordmark** (800, 23px, width 72%, 0.04em, uppercase): the band only.
- **Headline** (700, 26px, line-height 1.25, -0.01em, balanced): page titles; 22px inside a parcel label on the run page.
- **Section head** (800, 15px, width 72%, 0.1em, uppercase): "Needs you", "Queue" and similar, with the count pushed right. Runner names on plates use the same voice at 17px, width 75%.
- **Title** (650, 16px, line-height 1.3): request titles; h3 at 15px.
- **Body** (400, 16px, line-height 1.5): prose, request text, agent questions. Meta lines at 14px in faded ink.
- **Sticker** (800, 13px, width 75%, 0.07em, uppercase): state stickers.
- **Label** (750, 13px, width 85%, 0.06em, uppercase): form labels, legends, table heads (12px). Track stop names at 12px, width 80%, 0.05em.
- **Mono** (12.5px in logs, 0.9em inline): hashes, logs, diffs, commands.

### Named Rules
**The Width-Is-Hierarchy Rule.** Reach for the width axis before size: anything that names, routes or labels is condensed and uppercase; anything a person reads as sentences is normal width and sentence case.

**The Machine-Text Rule.** Monospace is for text a machine produced or will consume. Never for numbers, labels or decoration.

## Layout

A single centered column, 760px wide with 16px gutters, at every size; the desktop view is the phone view with more air, not a dashboard. The header band runs full width, holding the 60px bar (wordmark left, nav right) and, on home, the runner plates in an auto-fill grid of 164px minimum columns with 8px gaps.

A request row is a three-column grid: routing number (3.4em), body, then the mini track at the right, so stops align at the same x on every row. A parcel label instead splits into a ruled header (big routing number in its own cell, divided by a 2px rule) above the full-width five-stop track and actions.

Spacing runs on 4px steps, with 8, 12, 14 and 16 doing most of the work: 12px between parcel labels and inside list rows, 14px inside cards, 34px above section heads. Every interactive element holds a 44px minimum height (52px for the New request bar).

## Elevation & Depth

Flat. There are no drop shadows. Depth is paper on paper: white label stock on kraft, sunk stock inside a label, a black band above. Separation comes from rules, not lift: 2px solid for a label's edge and its internal header, 1px hairline between rows, dashed for things not yet real (empty states, confirm panels, disabled fields, the unreached track).

The only box-shadows in the build are functional strokes: the inset 3px orange underline on the current nav item, the inset 1.5px outline on the idle sticker, and the `beat` pulse ring on a running stop or sticker (disabled under reduced motion).

### Named Rules
**The Rule-Not-Lift Rule.** If two things need separating, draw a rule between them. Never float a surface with a shadow.

## Shapes

Square-cut. Labels, lists, plates, stickers and the New request bar have 0 radius. Controls (buttons, inputs, file pickers, inline code) take a 2px tick so they read as pressable without going soft. Circles appear only as meaning: track stops and the done and work state marks. Rules are 2px for structure, 1.5px for controls and plates, 1px for hairlines.

State marks are drawn in CSS, never glyphs: diamond (attn), ring (work), square (fail), disc (done), bar (idle).

## Components

### Buttons
Heavy-ruled and plain, like a stamped tag.
- **Shape:** 2px tick radius, 2px Thermal Ink border, 44px minimum height, 8px 16px padding, 15px at weight 650.
- **Default:** label stock with ink text; hover drops to sunk stock.
- **Primary:** solid Thermal Ink with label-stock text; hover mixes 20% toward the stock.
- **Danger:** red text and red border on label stock. Destructive actions open a dashed red confirm panel that names the consequence; a forward-moving confirm uses the orange variant.
- **Link button:** borderless, weight 500, for sign out and similar.
- **Focus:** 3px In-Transit Blue outline, 2px offset (lifted blue in the band).
- Background and color transition at 0.15s ease-out.

### Chips (Stickers)
- **Style:** square-cut, solid fill in the state color with its on-color text, the shape mark at 9px before the uppercase word.
- **State:** running adds the beating filled ring. Idle is outlined, not filled. Inline state words (`.st`) use the same shape in the color's text variant without a fill.

### Cards / Containers (Labels)
- **Corner Style:** square (0).
- **Background:** label stock.
- **Shadow Strategy:** none; see Elevation & Depth.
- **Border:** 2px solid label rule.
- **Internal Padding:** 14px for cards and settings sections, 12px for list rows and parcel cells.

### Inputs / Fields
- **Style:** 1.5px ink border, 2px tick, label stock, 10px 12px padding, 44px minimum; textarea 96px minimum. Labels above in the condensed uppercase label voice; "optional" drops back to normal width in faded ink.
- **Focus:** the shared blue outline.
- **Error / Disabled:** error text in Failed Red at 14px, weight 600. Disabled fields go dashed in faded ink on sunk stock.
- **Picks:** radio and checkbox options are 44px ruled tiles that invert to solid ink when checked.

### Navigation
The thermal band: wordmark left, nav links in band-muted at 15px with 44px targets, the current page in on-band at weight 650 with an inset orange underline. The user's name sits behind a 1px band-line divider. Same layout on phone and desktop; the bar wraps.

### Tracking Strip (signature)
Five stops on one rule: Agent, Build, Test, Verify, Deploy. A stop is a 14px ring; reached stops fill with ink and join with a solid 2px rule; unreached stops join with a dotted rule at 55% opacity. The current stop fills blue and beats; a failed stop becomes a red square; a held stop becomes an orange diamond. Stop names sit under the marks in the condensed uppercase stop voice, with right-aligned step times in tabular figures on the run page. The mini track (108px, 10px stops, names visually hidden) sits at the right of every list row.

### Runner Plate
A 1.5px band-line box per runner in the header: condensed uppercase machine name with its state mark, the current scan or offline reason, the OS when known, and the worker slots as a row of 18 by 7px bars, filled for busy and outlined for free. An offline plate takes a red-tinted border and red reason text.

### Proof of Delivery
The run page's last scan: a strip under a 2px rule, tinted 12% Delivered Green, naming the commit production runs.

## Do's and Don'ts

### Do:
- **Do** put every request on label stock inside a 2px Thermal Ink rule, with its routing number in condensed Archivo at weight 850.
- **Do** show state as color, shape and word together: diamond orange, ring blue, square red, disc green, bar grey.
- **Do** keep track stops at the same x in every row of a list.
- **Do** separate with rules (2px structure, 1px hairline, dashed for not-yet) instead of shadows.
- **Do** hold every target at 44px minimum and keep the 3px blue focus outline.
- **Do** define every color as a custom property with a dark-theme counterpart.

### Don't:
- **Don't** use drop shadows or rounded cards; labels are square and flat.
- **Don't** use a state color for decoration or a color without its shape and word.
- **Don't** add a second type family; Archivo's width axis carries display, and monospace is only for machine text.
- **Don't** use icon fonts or glyph icons; state marks and the plus are drawn in CSS.
- **Don't** fall back to a grey admin list with a single blue accent and pill-shaped status badges.
