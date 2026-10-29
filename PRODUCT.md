# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner, a developer running Agentry for their own projects, plus a few trusted admins. They use the web UI
mostly on an iPhone, as a home-screen app reached over a private network (Tailscale), away from the desk. A desktop
browser is secondary. On the phone the job is short and interrupt-driven: file a change, answer the agent's
question, review and approve a change that carries risk, retry or re-deploy after a failure, and check that
the runners are alive.

## Product Purpose

Agentry is an AI software-delivery queue with guardrails. A person describes a change in plain language; an AI
agent builds it in a sandbox, the change goes through inspection, build, tests and an independent verifier, then
it is pushed and deployed, and Agentry confirms production runs the new commit. Success: a request goes from intent
to a verified deploy with a person involved only where risk calls for it, and every failure stops in a named state
with a clear next action.

## Positioning

Not a coding agent, but the delivery layer around one: fixed pipeline, sandboxed agent, fail-closed gates,
scope enforcement, anti-gaming checks, an independent verifier against a "done when" line, and deploys verified
against the live `VERSION`. Nothing reaches production on a guess.

## Operating Context

- Server-rendered pages (TypeScript on Bun, `src/views.ts`), plain HTML forms, htmx for live refresh; works
  without JavaScript except passkey sign-in. Strict CSP: scripts from the same origin only, no inline handlers.
- Passkey sign-in (Face ID, Touch ID, Windows Hello); owners re-check their passkey before changing settings.
- One queue, one or more runners on different machines (macOS and Windows); a machine's runner may be attached to
  another machine's queue.
- Pages: home (status line, alerts, new request, needs you, queue, recently finished), run page (pipeline, steps,
  live log, flags, diff, recipe), settings (runner, workers, projects, users), sign-in, passkey setup, offline page,
  message page.
- Each user picks a theme in Settings (Apple by default, which follows the device's light or dark mode).

## Capabilities and Constraints

- Request states: queued, running, question for you, needs approval, failed, deploy failed, done (deployed or
  built), done by hand, canceled. Pipeline stages: agent, build, test, verify, deploy.
- Request text, logs and diffs come from people and agents and must always be escaped.
- Irreversible actions confirm once more, naming what they do.
- The repository is public: no real host names, IPs, paths or project code in UI examples or fixtures.

## Brand Commitments

- Name: Agentry. App icon at `static/icon.png` and `static/apple-touch-icon.png`.
- Voice: plain, precise, consequence-first. Copy says what happens and what to do next; no hype, no jargon
  like raw state codes.

## Evidence on Hand

- README.md describes the pipeline, security model and UI in full.
- No screenshots, testimonials or usage numbers; do not invent any.

## Product Principles

1. What needs a person comes first; everything else is ambient status.
2. Every state is legible at a glance: who runs what, on which runner, at which stage, and why it stopped.
3. Fail closed, say why, offer the next action.
4. Phone first: one hand, short sessions, 44 px targets.
5. Show the pipeline, not a pile of records.

## Accessibility & Inclusion

WCAG 2.2 AA. State is never color alone (shape plus word). 44 px touch targets. Respects reduced motion. Works in
light and dark.
