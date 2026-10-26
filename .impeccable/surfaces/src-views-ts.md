---
version: 1
slug: "src-views-ts"
primary_target: "src/views.ts"
related_targets: []
---

# Agentry web UI

Scope: the whole server-rendered web UI (home, run page, settings, sign-in, passkey setup, offline, message pages), all in src/views.ts. Mode: Operate.

Audience and job: the owner and a few admins, phone first (iPhone home-screen app over Tailscale). File a change, answer the agent, approve risky changes, retry or re-deploy, check the runners. What bothered them: it looks generic, and you can't see at a glance which runner does what, which stage a run is in, and what's blocked.

Data cuts: an attached runner reports neither its OS nor its worker count, so its plate shows only busy slots and no OS.

Constraints: no JavaScript needed except passkeys; CSP self-only (fonts served from /static); escape everything; 44 px targets; light and dark follow the device; state is a shape plus a word.

## Direction contract

THESIS: Every request is a parcel, tracked stop by stop and delivered only when production signs for the commit. Refuses the grey admin list with one blue accent and status pills.

OWN-WORLD: Kraft-board ground (dark: dark corrugated brown), white thermal labels boxed in 2 px black rules, thermal-black header band and solid black primary buttons. Archivo in condensed widths for routing numbers, section heads and stickers; Archivo at normal width for body; mono only for hashes and logs. State colors are handling stickers: orange = needs you, red = failed, green = delivered, blue = in transit, each with a shape and a word.

STORY: The visitor sees which runners are alive and busy, what waits on them, and how far each parcel has travelled; they act on the top label and leave.

FIRST VIEWPORT: Black header: wordmark, nav, then one plate per runner (machine, OS, worker slots filled/empty, current scan or offline). Kraft below: "Needs you" heading with count; white labels, each with a big condensed routing number at the left of a ruled header, the title, its sticker, a five-stop tracking strip (Agent, Build, Test, Verify, Deploy), the latest scan line, and its actions. Then the queue as a manifest of rows with mini tracks. "New request" sits as a black bar above the needs list.

FORM: Parcel tracking and thermal shipping labels; candidate 6 of 7 on my ordered list. Raises: worker slots and right-aligned step times as a visible budget (j-card); one family across display, labels and body (design annual); stops at the same x in every row (botanical folio); request number as routing code everywhere (Factory catalog); fixed runner plates (character roster). Signature move: the tracking strip, and on the run page a scan history that ends in proof of delivery (target runs commit). seed:3e670ee46b0fd4c0

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
