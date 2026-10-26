// The web UI's pages, server-rendered (winhost design "UI"). Every value goes through `html`, which escapes it
// unless it is itself the output of `html`: request text, logs and diffs are written by people and agents, and
// must never become markup on a page that carries the session cookie (slice 2 review Q1). Actions are plain
// forms posting to the server; htmx only refreshes the live parts: a running run's page, and the home page's lists.
import { createHash } from "node:crypto";
import type { User } from "./accounts.ts";
import { AGENTS, type AgentId } from "./adapters/providers.ts";
import { deviceLabel, type Choices, type DeployChoices, type Device } from "./devices.ts";

export class Html { constructor(readonly s: string) {} toString() { return this.s; } }

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  values.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Html ? x.s : esc(x))).join("") : v instanceof Html ? v.s : esc(v);
    out += part + strings[i + 1];
  });
  return new Html(out);
}


// Proof of delivery: every request is a parcel on kraft board, its label boxed in black rules and tracked stop by
// stop until production runs its commit. One family, Archivo, condensed for routing numbers, heads and stickers.
// States are handling stickers: a color, a shape and a word. Both themes follow the device.
const CSS = `
@font-face { font-family: Archivo; src: url(/static/archivo.woff2) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; font-display: swap; }
:root { color-scheme: light dark;
  --ground:#d5c4a5; --on-ground:#4a4031; --label:#fff; --sunk:#f3eee5; --ink:#141414; --muted:#5b5348; --hair:rgb(20 20 20 / .14); --rule:#141414;
  --band:#141414; --on-band:#f5f0e6; --band-muted:#b8ae9e; --band-line:rgb(245 240 230 / .24);
  --band-done:#62d27e; --band-fail:#ff8a7a; --band-attn:#f6a465; --band-work:#8fb0ff;
  --attn:#e5641a; --attn-t:#a8430a; --on-attn:#141414; --work:#2b54c9; --on-work:#fff;
  --fail:#c8231c; --on-fail:#fff; --done:#1e7a3c; --on-done:#fff; --idle:#6b6255; }
@media (prefers-color-scheme: dark) { :root {
  --ground:#34291e; --on-ground:#c4b8a4; --label:#44382b; --sunk:#3b3024; --ink:#f1ebe0; --muted:#b9ae9c; --hair:rgb(241 235 224 / .13); --rule:#a89c87;
  --band:#0c0b09; --on-band:#f1ebe0; --band-muted:#a69c8b; --band-line:rgb(241 235 224 / .2);
  --attn:#f0893c; --attn-t:#f6a465; --on-attn:#141414; --work:#8fb0ff; --on-work:#0b1222;
  --fail:#ff9a8f; --on-fail:#1a0806; --done:#62d27e; --on-done:#06190c; --idle:#b3a894; } }
* { box-sizing: border-box; scrollbar-color: color-mix(in srgb, var(--ink) 35%, transparent) transparent; }
html { -webkit-text-size-adjust: 100%; background: var(--ground); }
body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.5 Archivo, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; caret-color: var(--work); }
::selection { background: color-mix(in srgb, var(--attn) 45%, transparent); }
:focus-visible { outline: 3px solid var(--work); outline-offset: 2px; }
.band :focus-visible { outline-color: var(--band-work); }
a { color: inherit; text-decoration-thickness: 1.5px; text-underline-offset: .2em; }
.wrap, main { max-width: 760px; margin: 0 auto; padding: 0 16px; }
main { padding-bottom: 56px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.muted { color: var(--muted); }
.num, table, .meta, .no { font-variant-numeric: tabular-nums; }
code, pre, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.mono { font-size: .9em; }
p, .hint, .why { text-wrap: pretty; }
code { font-size: .9em; background: var(--sunk); padding: 1px 5px; border-radius: 2px; }

/* The header band: thermal black, with the wordmark, the nav, and on the home page one plate per runner. */
.band { background: var(--band); color: var(--on-band); }
.band a { color: var(--on-band); }
.bar { display: flex; align-items: center; gap: 4px 16px; flex-wrap: wrap; min-height: 60px; }
.brand { font-weight: 800; font-stretch: 72%; font-size: 23px; letter-spacing: .04em; text-transform: uppercase; text-decoration: none;
  margin-right: auto; display: inline-flex; align-items: center; gap: 10px; min-height: 44px; }
.brand img { width: 24px; height: 24px; border-radius: 5px; }
.bar nav { display: flex; align-items: center; gap: 2px; font-size: 15px; }
.bar nav a { color: var(--band-muted); text-decoration: none; padding: 10px; min-height: 44px; display: inline-flex; align-items: center; }
.bar nav a:hover { color: var(--on-band); }
.bar nav a[aria-current="page"] { color: var(--on-band); font-weight: 650; box-shadow: inset 0 -3px 0 var(--attn); }
.bar .who { color: var(--band-muted); padding: 0 6px 0 12px; border-left: 1px solid var(--band-line); margin-left: 6px; }
.bar form { display: inline; }
.band button.link { color: var(--band-muted); }
.band button.link:hover { color: var(--on-band); background: none; }
.status { padding: 2px 0 14px; }
.plates { display: grid; grid-template-columns: repeat(auto-fill, minmax(164px, 1fr)); gap: 8px; }
.plate { border: 1.5px solid var(--band-line); padding: 8px 11px 10px; min-width: 0; }
.plate b { display: flex; align-items: center; gap: 8px; font-weight: 750; font-stretch: 75%; font-size: 17px; letter-spacing: .04em; text-transform: uppercase; overflow-wrap: anywhere; }
.plate .doing { display: block; font-size: 14px; color: var(--band-muted); margin-top: 1px; overflow-wrap: anywhere; }
.plate .doing a { color: var(--on-band); }
.plate.off { border-color: color-mix(in srgb, var(--band-fail) 55%, transparent); }
.plate.off .doing { color: var(--band-fail); }
.plate .os { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--band-muted); margin-top: 1px; }
.slots { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.slots i { width: 18px; height: 7px; border: 1.5px solid var(--band-muted); }
.slots i.on { background: var(--on-band); border-color: var(--on-band); }
.counts { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 10px 0 0; font-size: 14px; color: var(--band-muted); }
.band .st.done { color: var(--band-done); } .band .st.fail { color: var(--band-fail); }
.band .st.attn { color: var(--band-attn); } .band .st.work { color: var(--band-work); }
.modebar { margin: 0 0 14px; padding: 12px 14px; border: 1.5px solid var(--band-line); }
.modebar strong { font-weight: 650; }
.modebar p { margin: 0; } .modebar .hint { margin-top: 6px; color: var(--band-muted); }
.modebar code { background: rgb(255 255 255 / .1); }

h1 { font-size: 26px; line-height: 1.25; font-weight: 700; margin: 24px 0 6px; letter-spacing: -.01em; text-wrap: balance; }
h2 { font-size: 15px; font-weight: 800; font-stretch: 72%; letter-spacing: .1em; text-transform: uppercase; margin: 34px 0 10px;
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
h2 .count { font-weight: 700; color: var(--on-ground); letter-spacing: .04em; }
h3 { font-size: 15px; font-weight: 650; margin: 0; }
p { margin: 6px 0; }

/* A label: white thermal stock boxed in a heavy rule. */
.label, .card, .settings-section { background: var(--label); border: 2px solid var(--rule); }
.card { padding: 14px; margin: 12px 0; }
.settings-section { padding: 4px 14px 16px; }
.sheet { margin-top: 28px; padding: 2px 18px 18px; }
.sheet h1 { margin-top: 18px; }

.flash { margin: 16px 0 0; padding: 12px 14px 12px 40px; position: relative; background: var(--label); border: 2px solid var(--rule); }
.flash.ok, .flash.bad { color: var(--ink); }
.alerts { display: grid; gap: 8px; margin-top: 16px; }
.alert { padding: 12px 14px 12px 40px; position: relative; background: var(--label); border: 2px solid var(--rule); display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.alert .what { flex: 1 1 240px; }
.flash::before, .alert::before { content: ""; position: absolute; left: 15px; top: 18px; width: 12px; height: 12px; }
.alert.attn::before { background: var(--attn); transform: rotate(45deg); }
.alert.fail::before, .flash.bad::before { background: var(--fail); border-radius: 2px; }
.flash.ok::before { border: 2px solid var(--ink); border-radius: 50%; }

/* A state's mark: waiting on you is a diamond, working a ring (filled and beating while it runs), failed a square,
   finished a disc, idle a bar. As a sticker it is printed on its family's color; inline, it colors its word. */
.st { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 650; white-space: nowrap; }
.st i, .sticker i { width: 9px; height: 9px; flex: none; display: inline-block; background: currentColor; }
:is(.st, .sticker).attn i { transform: rotate(45deg); width: 8px; height: 8px; }
:is(.st, .sticker).work i { border-radius: 50%; background: none; border: 2px solid currentColor; }
:is(.st, .sticker).work.now i { background: currentColor; animation: beat 1.6s ease-out infinite; }
:is(.st, .sticker).fail i { border-radius: 1px; }
:is(.st, .sticker).done i { border-radius: 50%; }
:is(.st, .sticker).idle i { height: 2px; }
.st.attn { color: var(--attn-t); } .st.work { color: var(--work); } .st.fail { color: var(--fail); } .st.done { color: var(--done); } .st.idle { color: var(--idle); }
.sticker { display: inline-flex; align-items: center; gap: 6px; padding: 1px 7px 1px 6px; font-size: 13px; font-weight: 800; font-stretch: 75%;
  letter-spacing: .07em; text-transform: uppercase; white-space: nowrap; line-height: 1.5; }
.sticker.attn { background: var(--attn); color: var(--on-attn); } .sticker.work { background: var(--work); color: var(--on-work); }
.sticker.fail { background: var(--fail); color: var(--on-fail); } .sticker.done { background: var(--done); color: var(--on-done); }
.sticker.idle { color: var(--idle); box-shadow: inset 0 0 0 1.5px currentColor; }
@keyframes beat { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 55%, transparent); } 100% { box-shadow: 0 0 0 7px transparent; } }

/* A request: its routing number, then what it is and where it stands; in a list, its track at the same x on every row. */
.req { display: grid; grid-template-columns: 3.4em 1fr auto; gap: 0 12px; align-items: start; }
.no { font-weight: 850; font-stretch: 62%; font-size: 24px; line-height: 1.1; letter-spacing: .01em; white-space: nowrap; }
.no .h { font-size: .55em; font-weight: 650; color: var(--muted); vertical-align: .55em; margin-right: 1px; }
.req .body { min-width: 0; }
.req .title { display: block; font-weight: 650; line-height: 1.3; color: var(--ink); text-decoration: none; overflow-wrap: anywhere; }
.req a.title:hover { text-decoration: underline; }
.req .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 5px; font-size: 14px; color: var(--muted); }
.req .why { margin: 6px 0 0; font-size: 15px; overflow-wrap: anywhere; }
.req .why.wait { color: var(--attn-t); font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
.list { list-style: none; margin: 0; padding: 0; background: var(--label); border: 2px solid var(--rule); }
.list > li { padding: 12px; border-top: 1px solid var(--hair); }
.list > li:first-child { border-top: 0; }
.list > li > details { margin-left: calc(3.4em + 12px); }
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.parcel .req { grid-template-columns: auto 1fr; gap: 0; border-bottom: 2px solid var(--rule); }
.parcel .no { font-size: 40px; line-height: 1; padding: 10px 12px 8px; border-right: 2px solid var(--rule); align-self: stretch; min-width: 3.2ch; }
.parcel .req .body { padding: 10px 12px 12px; }
.parcel .lb { padding: 2px 12px 14px; }
.parcel h1 { margin: 0; font-size: 22px; }
#live > .parcel { margin-top: 20px; }
.empty { margin: 0; padding: 14px; color: var(--on-ground); border: 2px dashed color-mix(in srgb, var(--ink) 35%, transparent); }

/* The track: a request's five stops on one rule, solid where it has been, dotted where it has yet to go. */
.track { list-style: none; margin: 14px 0 6px; padding: 0; display: grid; grid-template-columns: repeat(5, 1fr); }
.track li { position: relative; padding-top: 22px; font-size: 12px; font-weight: 750; font-stretch: 80%; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.track li::before { content: ""; position: absolute; z-index: 1; top: 0; left: 0; width: 14px; height: 14px; border: 2px solid var(--ink); border-radius: 50%; background: var(--label); }
.track li::after { content: ""; position: absolute; top: 6px; left: 14px; right: 0; height: 2px; background: repeating-linear-gradient(90deg, var(--ink) 0 3px, transparent 3px 7px); opacity: .55; }
.track li:last-child::after { display: none; }
.track li.done { color: var(--ink); } .track li.done::before { background: var(--ink); }
.track li.done::after { background: var(--ink); opacity: 1; }
.track li.now { color: var(--work); } .track li.now::before { border-color: var(--work); background: var(--work); color: var(--work); animation: beat 1.6s ease-out infinite; }
.track li.fail { color: var(--fail); } .track li.fail::before { border-color: var(--fail); background: var(--fail); border-radius: 2px; }
.track li.hold { color: var(--attn-t); } .track li.hold::before { border-color: var(--attn); background: var(--attn); border-radius: 1px; transform: rotate(45deg) scale(.86); }
.track .when { display: block; font-size: 12.5px; font-weight: 500; font-stretch: 100%; letter-spacing: 0; text-transform: none; color: var(--muted); font-variant-numeric: tabular-nums; }
.track.mini { display: flex; width: 108px; margin: 5px 0 0; }
.track.mini li { flex: 1; padding-top: 10px; }
.track.mini li:last-child { flex: none; width: 10px; }
.track.mini li::before { width: 10px; height: 10px; border-width: 1.5px; }
.track.mini li::after { top: 4px; left: 10px; height: 1.5px; }
.track.mini .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .track li.now::before, :is(.st, .sticker).work.now i { animation: none; } }
.proof { margin: 0 -6px; padding: 12px 14px; border-top: 2px solid var(--rule); background: color-mix(in srgb, var(--done) 12%, var(--label)); overflow-wrap: anywhere; }

.ask { margin: 10px 0 0; padding: 10px 12px; background: var(--sunk); white-space: pre-wrap; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; margin-top: 12px; }
.actions form { display: inline; margin: 0; }
.hint { font-size: 14px; color: var(--muted); margin: 6px 0 0; }

label { display: block; font-size: 13px; font-weight: 750; font-stretch: 85%; letter-spacing: .06em; text-transform: uppercase; margin: 16px 0 6px; }
label .opt { font-weight: 500; font-stretch: 100%; letter-spacing: 0; text-transform: none; color: var(--muted); }
fieldset { border: 0; margin: 16px 0 0; padding: 0; min-width: 0; }
legend { font-size: 13px; font-weight: 750; font-stretch: 85%; letter-spacing: .06em; text-transform: uppercase; padding: 0; margin-bottom: 6px; }
input[type=text], input[type=number], textarea, select { width: 100%; font: inherit; padding: 10px 12px; min-height: 44px;
  border: 1.5px solid var(--ink); border-radius: 2px; background: var(--label); color: var(--ink); }
textarea { min-height: 96px; resize: vertical; }
::placeholder { color: var(--muted); opacity: 1; }
input:disabled, textarea:disabled, select:disabled { background: var(--sunk); color: var(--muted); border-style: dashed; border-color: var(--muted); cursor: not-allowed; }
input[type=file] { font: inherit; font-size: 14px; color: var(--muted); max-width: 100%; }
input[type=file]::file-selector-button { font: inherit; font-size: 15px; font-weight: 650; min-height: 44px; padding: 8px 14px; margin-right: 10px; border-radius: 2px;
  border: 2px solid var(--ink); background: var(--label); color: var(--ink); cursor: pointer; }
.picks { display: flex; flex-wrap: wrap; gap: 8px; }
.picks label { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 600; font-stretch: 100%; letter-spacing: 0; text-transform: none;
  min-height: 44px; padding: 0 14px; border: 2px solid var(--ink); background: var(--label); cursor: pointer; }
.picks label:has(input:checked) { background: var(--ink); color: var(--label); }
.picks input { width: 18px; height: 18px; margin: 0; accent-color: var(--attn); }
.field-error { color: var(--fail); font-size: 14px; font-weight: 600; margin: 12px 0 0; }

button, .btn { font: inherit; font-size: 15px; font-weight: 650; min-height: 44px; padding: 8px 16px; border-radius: 2px; cursor: pointer;
  border: 2px solid var(--ink); background: var(--label); color: var(--ink); display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; text-decoration: none; transition: background-color .15s ease-out, color .15s ease-out; }
button:hover, .btn:hover { background: var(--sunk); }
button.primary, .btn.primary { background: var(--ink); color: var(--label); }
button.primary:hover, .btn.primary:hover { background: color-mix(in srgb, var(--ink) 80%, var(--label)); }
button.danger, .btn.danger { color: var(--fail); border-color: var(--fail); }
button:disabled { opacity: .5; cursor: not-allowed; }
button.link { background: none; border: 0; padding: 10px 6px; font-weight: 500; }

/* A disclosure: a 44 px row that opens a short form. A confirm is one with a button as its summary. */
details > summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; gap: 8px; list-style: none; }
details > summary::-webkit-details-marker { display: none; }
details.more > summary { font-weight: 650; font-size: 15px; }
details.more > summary:hover { text-decoration: underline; text-underline-offset: .2em; }
details.more > summary::before { content: ""; width: 7px; height: 7px; border: solid currentColor; border-width: 0 2px 2px 0; transform: rotate(-45deg); transition: transform .15s ease-out; margin: 0 3px; }
details.more[open] > summary::before { transform: rotate(45deg); }
details.confirm, details.answer { display: inline-block; }
details.answer > summary { display: inline-flex; }
details.answer[open] { display: block; flex-basis: 100%; }
details.answer[open] > summary { display: none; }
details.confirm > summary { display: inline-flex; }
details.confirm[open] { display: block; flex-basis: 100%; }
.confirm-body { margin-top: 8px; padding: 12px; border: 2px dashed var(--fail); background: color-mix(in srgb, var(--fail) 8%, var(--label)); }
.confirm-body .actions { margin-top: 8px; }
.confirm.go .confirm-body { border-color: var(--attn); background: color-mix(in srgb, var(--attn) 10%, var(--label)); }

/* New request: a black bar that opens into a label. */
details.new { margin-top: 18px; }
details.new > summary { min-height: 52px; padding: 0 18px; justify-content: center; background: var(--ink); color: var(--label);
  font-weight: 800; font-stretch: 72%; font-size: 18px; letter-spacing: .08em; text-transform: uppercase; }
details.new > summary:hover { background: color-mix(in srgb, var(--ink) 85%, var(--label)); }
details.new > summary::before { content: ""; width: 14px; height: 14px; flex: none;
  background: linear-gradient(currentColor, currentColor) center / 100% 2.5px no-repeat, linear-gradient(currentColor, currentColor) center / 2.5px 100% no-repeat; }
details.new[open] { background: var(--label); border: 2px solid var(--rule); }
details.new[open] > summary { justify-content: flex-start; background: none; color: var(--ink); border-bottom: 1px solid var(--hair); }
details.new[open] > summary::before { background: linear-gradient(currentColor, currentColor) center / 100% 2.5px no-repeat; }
details.new form { padding: 0 14px 16px; }

.thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.thumbs img { height: 56px; max-width: 120px; object-fit: cover; border: 1.5px solid var(--hair); display: block; }
.thumbs a.file { display: inline-flex; align-items: center; min-height: 44px; border: 1.5px solid var(--ink); padding: 2px 10px; font-size: 14px; text-decoration: none; }

/* The run page: its label and track, the steps, and the log. */
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 650; color: var(--work); }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
th { text-align: left; font-size: 12px; font-weight: 750; font-stretch: 85%; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); padding: 8px; border-bottom: 2px solid var(--rule); }
td { text-align: left; padding: 0 8px; border-bottom: 1px solid var(--hair); height: 44px; }
tbody tr:last-child td { border-bottom: 0; }
td.n, th.n { width: 2.5em; color: var(--muted); } td.t, th.t { text-align: right; white-space: nowrap; } td.nw { white-space: nowrap; }
tr[aria-current] td { background: var(--sunk); font-weight: 650; }
td a { display: block; padding: 11px 0; }
.steps { padding: 0 6px; }
.ok { color: var(--done); } .bad { color: var(--fail); } .warn { color: var(--attn-t); }
p.warn { position: relative; padding-left: 20px; }
p.warn::before { content: ""; position: absolute; left: 2px; top: .55em; width: 8px; height: 8px; background: currentColor; transform: rotate(45deg); }
pre { background: var(--label); border: 2px solid var(--rule); padding: 12px; margin: 8px 0 0; overflow: auto;
  font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 60vh; }
pre.wide { white-space: pre; overflow-wrap: normal; }
.flags { list-style: none; padding: 0; margin: 0; }
.flags li { padding: 6px 0; overflow-wrap: anywhere; }
.flagbox { margin-top: 12px; }
.flagbox .flags { margin-top: 4px; }
.panel { margin-top: 10px; }
.settings-section table { margin-top: 8px; }
.link-box { overflow-wrap: anywhere; }
.message::first-letter { text-transform: uppercase; }
`;

export type Nav = "home" | "settings" | null;

// `attachedTo`: the queue this machine's runner works instead of its own; every page then says so. `band`: what the
// page adds to the header band (the home page's runner plates).
export function page(title: string, body: Html, user?: User | null, extraHead: Html = html``,
  o: { nav?: Nav; attachedTo?: string | null; band?: Html } = {}): string {
  const here = (n: Nav) => o.nav === n ? html` aria-current="page"` : html``;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Agentry</title><link rel="icon" href="/static/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="Agentry">
<link rel="preload" href="/static/archivo.woff2" as="font" type="font/woff2" crossorigin><style>${new Html(CSS)}</style>
<script src="/static/offline.js" defer></script>${extraHead}</head>
<body><header class="band"><div class="wrap">
<div class="bar"><a class="brand" href="/"><img src="/static/icon.png" alt="">Agentry</a>${user ? html`<nav aria-label="Main">
  <a href="/"${here("home")}>Home</a><a href="/settings"${here("settings")}>Settings</a>
  <span class="who">${user.name}</span><form method="post" action="/logout"><button class="link">Sign out</button></form></nav>` : ""}</div>
${user && o.attachedTo ? html`<div class="modebar"><p>This machine's runner works <strong>${queueLink(o.attachedTo)}</strong>'s queue:
  file requests, follow runs and change runner settings <a href="${o.attachedTo}">there</a> (<a href="${o.attachedTo}/settings">its settings</a>).</p>
  <p class="hint"><code>agentry detach</code> on this machine brings back its own queue.</p></div>` : ""}
${o.band ?? ""}</div></header>
<main>
${body}
</main></body></html>`.s;
}

// The attached queue's machine by the first label of its host name, linked to its UI.
const queueLink = (url: string) => html`<a href="${url}">${new URL(url).hostname.split(".")[0]}</a>`;

export type Project = { name: string };
export type ReqRow = {
  id: number; project: string; title: string; status: string; status_reason: string | null; updated_at: number; last_run: number | null;
  body: string; done_when: string | null; files: string; // the attachments, a JSON array of FileRef
  ai_agent?: AgentId | null;                             // its own agent; none: the queue's
  device_name?: string | null;                           // the device it installs on instead of its projects' own deploy
  commit_sha: string | null; groups: string | null;     // the last commit made for it, and its deploy groups
  waiting?: string | null;                               // a queued request whose runner can't take it now: why
  runner?: string | null;                                // a running request: the runner working on it
  flag_count?: number | null;                            // the check flags of its latest run
  track?: string | null;                                 // its latest run's steps, a JSON array of [step, exit code]
};
// A runner of the queue: this machine's (named by its host) or an attached one (named by its runner key), what it
// works on and how many queued requests wait for it. `slots` and `os`: its worker count and system, when this
// machine knows them.
export type RunnerInfo = {
  name: string; local: boolean; online: boolean; running: number; waiting: number; slots?: number | null; os?: string | null;
  working: { id: number; title: string; run: number | null; step: string | null }[];
};
export type GroupLock = { name: string; lock_reason: string | null };
export type Flash = { kind: "ok" | "bad"; text: string };
// What was typed into the new-request form when the server refused it, to show again.
export type Draft = {
  projects: string[]; title: string; body: string; done_when: string; done_when_test: string; ai_agent: string; deploy_to: string; hadFiles: boolean;
};
export type HomeData = {
  projects: Project[]; needs: ReqRow[]; queue: ReqRow[]; recent: ReqRow[]; groupLocks: GroupLock[];
  paused: string | null; runners: RunnerInfo[]; backupAgeMs: number | null; backupStale: boolean;
  aiAgent: AgentId;           // the queue's agent, for requests that don't choose one
  deployTo: DeployChoices;    // by project, the devices it can install on instead of its own deploy (devices.ts)
  runnerAlerts: string[];     // runner problems that hold queued requests: offline, a missing recipe, no runner at all
  attachedTo: string | null;  // the queue this machine's runner works instead of this one (agentry attach)
};

const ago = (ms: number) => ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : ms < 86400_000 ? `${Math.round(ms / 3600_000)} h ago` : `${Math.round(ms / 86400_000)} d ago`;
const since = (ms: number) => ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 86400_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 86400_000)} days`;

// A request's state in words, and its family: waiting on you, working, failed, finished or idle.
type Family = "attn" | "work" | "fail" | "done" | "idle";
const STATES: Record<string, [string, Family]> = {
  queued: ["Queued", "work"], running: ["Running", "work"], needs_info: ["Question for you", "attn"],
  needs_review: ["Needs approval", "attn"], blocked_pre_push: ["Failed", "fail"], blocked_post_push: ["Deploy failed", "fail"],
  done: ["Done", "done"], done_manual: ["Done by hand", "done"], canceled: ["Canceled", "idle"],
};
// A request's state as its sticker.
function stateOf(status: string, reason: string | null): Html {
  const [label, family] = STATES[status] ?? [status, "idle" as Family];
  const word = status === "done" && reason === "deployed" ? "Deployed" : status === "done" && reason === "built" ? "Built" : label;
  return html`<span class="sticker ${family}${status === "running" ? " now" : ""}"><i aria-hidden="true"></i>${word}</span>`;
}
// The reason worth showing under a request: "deployed" and "built" are already in its state.
const reasonOf = (r: { status: string; status_reason: string | null }) =>
  r.status_reason && !(r.status === "done" && ["deployed", "built"].includes(r.status_reason)) ? r.status_reason : null;

const STEP_NAMES: Record<string, string> = {
  version: "Live version", agent: "Agent", build: "Build", test: "Test", verify: "Verify", remote_busy: "Install check", deploy: "Deploy",
};
// The five stops of a run, each done, running, failed, held for a person, or not reached ("").
const STAGES = ["agent", "build", "test", "verify", "deploy"];
type Stop = "" | "done" | "now" | "fail" | "hold";
// `status`: the request's, when these are its latest run's steps. A request waiting on you, or stopped with no step
// failing (a scope or check stop), is held or stopped at the first stop it hasn't reached.
function stopsOf(steps: [string, number | null][], status: string | null): Stop[] {
  if (status === "queued") return STAGES.map(() => "");
  const stops = STAGES.map((name): Stop => {
    const mine = steps.filter(([s]) => s === name);
    return !mine.length ? "" : mine.some(([, e]) => e === null) ? "now" : mine.some(([, e]) => e !== 0) ? "fail" : "done";
  });
  const family = status ? STATES[status]?.[1] : null;
  if ((family === "attn" || family === "fail") && !stops.includes("fail") && !stops.includes("now")) {
    const next = stops.indexOf("");
    stops[next === -1 ? stops.length - 1 : next] = family === "attn" ? "hold" : "fail";
  }
  return stops;
}
const reqStops = (r: ReqRow) => stopsOf(JSON.parse(r.track || "[]"), r.status);
// `mini`: the list form, marks only, at the same width on every row. `times`: how long each stop took.
function track(stops: Stop[], o: { mini?: boolean; times?: string[] } = {}): Html {
  const said = { "": "not reached", now: "running", fail: "failed", done: "done", hold: "waiting on you" };
  return html`<ol class="track${o.mini ? " mini" : ""}" aria-label="Progress">${STAGES.map((name, i) => html`<li class="${stops[i]}"><span class="lbl">${STEP_NAMES[name]}</span><span class="sr">: ${said[stops[i]]}</span>${
    o.times?.[i] ? html`<span class="when">${o.times[i]}</span>` : ""}</li>`)}</ol>`;
}

export type FileRef = { id: number; name: string; mime: string };

// A request's attachments: images as thumbnails, other files by name, each linking to the file.
function thumbs(files: string): Html {
  const list = JSON.parse(files) as FileRef[];
  if (!list.length) return html``;
  return html`<div class="thumbs">${list.map((f) => f.mime.startsWith("image/")
    ? html`<a href="/attachments/${f.id}"><img src="/attachments/${f.id}" alt="${f.name}" loading="lazy"></a>`
    : html`<a class="file" href="/attachments/${f.id}">${f.name}</a>`)}</div>`;
}

// A file picker; on a phone it offers the photo library, the camera and files.
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,.docx,.xlsx,.pptx,text/plain,.txt,.md,.json,.csv,.tsv,.log,.yaml,.yml,.xml,.html,.sql,.toml,.ini,.diff,.patch";
const filePicker = (id: string) => html`<label for="${id}">Files <span class="opt">(optional)</span></label>
  <input type="file" id="${id}" name="files" accept="${ACCEPT}" multiple>
  <p class="hint">Up to 5 files of 10 MB: images, PDF, text or Office documents.</p>`;

const routing = (id: number) => html`<span class="no"><span class="h">#</span>${id}</span>`;

// A request's line: its routing number, title, sticker and facts. `card`: on a label of its own, which shows the
// full track below; otherwise its mini track ends the line.
function reqLine(r: ReqRow, card = false): Html {
  const why = reasonOf(r);
  const flags = r.flag_count ?? 0;
  const shipped = r.status === "done" && r.status_reason === "deployed" && r.commit_sha;
  return html`<div class="req">${routing(r.id)}<div class="body">${r.last_run ? html`<a class="title" href="/runs/${r.last_run}">${r.title}</a>` : html`<span class="title">${r.title}</span>`}
  <div class="meta">${stateOf(r.status, r.status_reason)}<span>${r.project}</span>
    ${r.ai_agent ? html`<span>${AGENTS[r.ai_agent]}</span>` : ""}${r.device_name ? html`<span>to ${r.device_name}</span>` : ""}${r.runner ? html`<span>on ${r.runner}</span>` : ""}
    ${shipped ? html`<span class="mono">${r.commit_sha!.slice(0, 7)}</span>` : ""}
    ${flags ? html`<span class="st attn"><i aria-hidden="true"></i>${flags} check flag${flags > 1 ? "s" : ""}</span>` : ""}</div>
  ${r.waiting ? html`<p class="why wait"><span class="st attn"><i aria-hidden="true"></i></span>${r.waiting}</p>` : why ? html`<p class="why">${why}</p>` : ""}
  ${thumbs(r.files)}</div>${card ? "" : track(reqStops(r), { mini: true })}</div>`;
}

const post = (id: number, name: string, label: string, cls = "") =>
  html`<form method="post" action="/requests/${id}/${name}"><button class="${cls}">${label}</button></form>`;

// A step that can't be undone asks once more, naming what it does; it works without JavaScript. "go": one that
// goes ahead (approving), rather than one that stops something.
const confirm = (id: number, name: string, label: string, question: string, tone: "danger" | "go" = "danger") =>
  html`<details class="confirm ${tone}"><summary class="btn${tone === "danger" ? " danger" : ""}">${label}…</summary><div class="confirm-body"><p>${question}</p>
  <div class="actions">${post(id, name, `${label} #${id}`, tone === "danger" ? "danger" : "primary")}</div></div></details>`;

// Edit the request's details and queue it for a fresh attempt.
const reviseForm = (r: ReqRow): Html => html`<details class="more"><summary>Retry with changes</summary><form method="post" action="/requests/${r.id}/retry">
  <label for="retry-body-${r.id}">Details</label><textarea id="retry-body-${r.id}" name="body">${r.body}</textarea>
  <label for="retry-done-${r.id}">Done when <span class="opt">(optional)</span></label>
  <input type="text" id="retry-done-${r.id}" name="done_when" value="${r.done_when ?? ""}">
  <div class="actions"><button class="primary">Retry with these changes</button></div></form></details>`;

// The request as written, so a run's page shows what was asked.
const detailsPanel = (r: ReqRow): Html => r.body || r.done_when ? html`<details class="more panel" open><summary>Request details</summary>
  ${r.body ? html`<p style="white-space:pre-wrap">${r.body}</p>` : ""}${r.done_when ? html`<p><strong>Done when:</strong> ${r.done_when}</p>` : ""}</details>` : html``;

// The actions of a request that needs a person, by its state; the same on the home page and its run page.
function actionsFor(r: ReqRow): Html {
  const fid = `files-${r.id}`;
  switch (r.status) {
    case "needs_info":
      // Folded: a question card stays short on a phone until you answer it.
      return html`<div class="actions"><details class="answer"><summary class="btn primary">Answer…</summary>
        <form method="post" action="/requests/${r.id}/answer" enctype="multipart/form-data">
        <label for="answer-${r.id}">Your answer</label><textarea id="answer-${r.id}" name="text" required></textarea>
        ${filePicker(fid)}<div class="actions"><button class="primary">Send answer</button></div></form></details>
        ${confirm(r.id, "cancel", "Cancel", "Cancel this request? It leaves the queue for good.")}</div>`;
    case "needs_review":
      return html`<div class="actions">${r.last_run ? html`<a class="btn primary" href="/runs/${r.last_run}#diff">Review the diff</a>` : ""}
        ${confirm(r.id, "approve", "Approve", `Approve #${r.id}? Its changes, including those outside the request's scope, go on to build and tests, then are pushed${r.groups ? ` and deployed (${r.groups.replace(/,/g, ", ")})` : ""}.`, "go")}
        ${confirm(r.id, "reject", "Reject", "Reject this change? The request is canceled.")}</div>${reviseForm(r)}`;
    case "blocked_pre_push":
      return html`<div class="actions">${post(r.id, "retry", "Retry", "primary")}
        ${confirm(r.id, "cancel", "Cancel", "Cancel this request? It leaves the queue for good.")}</div>${reviseForm(r)}`;
    case "blocked_post_push": {
      const what = r.commit_sha ? `Re-run deploy of ${r.commit_sha.slice(0, 7)}${r.groups ? ` to ${r.groups.replace(/,/g, ", ")}` : ""}` : "Re-run deploy";
      return html`<div class="actions">${post(r.id, "redeploy", what, "primary")}${post(r.id, "resolve", "Mark resolved")}</div>
        <p class="hint">Mark resolved when you have deployed it another way.</p>`;
    }
  }
  return html``;
}

// A request that needs you, on a label of its own: its line, its track, the question asked, and what you can do.
function needsCard(r: ReqRow): Html {
  const asks = r.status === "needs_info" && r.status_reason;
  return html`<li class="label parcel">${reqLine(asks ? { ...r, status_reason: null } : r, true)}<div class="lb">${track(reqStops(r))}
    ${asks ? html`<p class="ask">${r.status_reason}</p>` : ""}${detailsPanel(r)}${actionsFor(r)}</div></li>`;
}

function newRequestForm(d: HomeData, draft?: Draft, error?: string): Html {
  const v = draft ?? { projects: [], title: "", body: "", done_when: "", done_when_test: "", ai_agent: "", deploy_to: "", hadFiles: false };
  return html`<details class="new"${draft ? html` open` : ""}><summary>New request</summary>
<form method="post" action="/requests" enctype="multipart/form-data">
  <fieldset><legend>Projects</legend><div class="picks">
    ${d.projects.map((p) => html`<label><input type="checkbox" name="project" value="${p.name}"${v.projects.includes(p.name) ? html` checked` : ""}>${p.name}</label>`)}
  </div><p class="hint">One or more, from the same repository.</p></fieldset>
  <label for="title">What should change?</label><input type="text" id="title" name="title" required maxlength="200" value="${v.title}">
  <label for="body">Details <span class="opt">(optional)</span></label><textarea id="body" name="body">${v.body}</textarea>
  <label for="done_when">Done when <span class="opt">(optional)</span></label>
  <input type="text" id="done_when" name="done_when" value="${v.done_when}" placeholder="e.g. the word list keeps its scroll position">
  <label for="done_when_test">Test that must pass <span class="opt">(optional)</span></label>
  <input type="text" id="done_when_test" name="done_when_test" value="${v.done_when_test}" placeholder="e.g. WordListTests.Paging_KeepsScrollPosition">
  <label for="ai_agent">AI agent</label>
  <select id="ai_agent" name="ai_agent">
    <option value="">Default: ${AGENTS[d.aiAgent]}</option>
    ${Object.entries(AGENTS).map(([id, label]) => html`<option value="${id}"${v.ai_agent === id ? html` selected` : ""}>${label}</option>`)}
  </select>
  ${requestDeployTo(d.deployTo, v)}
  ${filePicker("files-new")}
  ${error ? html`<p class="field-error message" role="alert">${error}${/[.!?]$/.test(error) ? "" : "."}${v.hadFiles ? " Attach the files again." : ""}</p>` : ""}
  <div class="actions"><button class="primary">Queue it</button></div>
</form></details>`;
}

// A new request's Deploy to list, for the projects selected whose recipe defines devices: their own deploy (e.g.
// TestFlight), the default, then their devices. It shows only while such a project is selected, and offers only the
// devices of the projects selected (home.js; data-usual and data-projects say whose each entry is).
function requestDeployTo(c: DeployChoices, v: Draft): Html {
  const names = Object.keys(c);
  if (!names.length) return html``;
  const devices = new Map<string, { d: Device; projects: string[] }>();
  for (const n of names) for (const d of c[n].devices) (devices.get(d.id) ?? devices.set(d.id, { d, projects: [] }).get(d.id)!).projects.push(n);
  const picked = v.projects.filter((p) => c[p]);
  const usual = Object.fromEntries(names.map((n) => [n, c[n].usual]));
  return html`<div class="deploy-to" data-usual="${JSON.stringify(usual)}"${picked.length ? "" : html` hidden`}>
  <label for="deploy_to">Deploy to</label>
  <select id="deploy_to" name="deploy_to"${picked.length ? "" : html` disabled`}>
    <option value="">${[...new Set(picked.map((p) => usual[p]))].join(" / ")}</option>
    ${[...devices.values()].map(({ d, projects }) => html`<option value="${d.id}" data-projects="${projects.join(" ")}"${v.deploy_to === d.id ? html` selected` : ""}>${deviceLabel(d)}</option>`)}
  </select>
  <p class="hint">A device gets a Debug build installed instead; the other projects deploy as usual.</p></div>`;
}

// Deploy main's list for one project: its own deploy, the default, then its devices.
function deployToPicker(id: string, c: Choices, disabled = html``): Html {
  return html`<label for="${id}">Deploy to</label>
  <select id="${id}" name="deploy_to"${disabled}>
    <option value="">${c.usual.join(" / ")}</option>
    ${c.devices.map((dv) => html`<option value="${dv.id}">${deviceLabel(dv)}</option>`)}
  </select>
  <p class="hint">A device gets a Debug build installed instead.</p>`;
}

// The runners as plates: attached elsewhere, or each one with its state, what it works on and its worker slots.
function runnerPlates(d: HomeData): Html {
  const mark = (family: string) => html`<span class="st ${family}"><i aria-hidden="true"></i></span>`;
  if (d.attachedTo) return html`<div class="plate"><b>${mark("work")}This machine</b><span class="doing">Runner attached to ${queueLink(d.attachedTo)}</span></div>`;
  // What a runner works on: its first request, linked to its run, with the step it's in.
  const doing = (r: RunnerInfo) => {
    const [w] = r.working;
    if (!w) return html``;
    const what = html`#${w.id} ${w.step ? STEP_NAMES[w.step] ?? w.step : "starting"}`;
    return html` · ${w.run ? html`<a href="/runs/${w.run}">${what}</a>` : what}${r.working.length > 1 ? ` +${r.working.length - 1}` : ""}`;
  };
  // Its workers, busy or free; a runner on another machine shows only the busy ones.
  const slots = (r: RunnerInfo) => {
    const n = Math.max(r.slots ?? 0, r.running);
    return n ? html`<span class="slots" aria-hidden="true">${Array.from({ length: n }, (_, i) => html`<i${i < r.running ? html` class="on"` : ""}></i>`)}</span>
      ${r.slots ? html`<span class="sr">${r.running} of ${r.slots} workers busy</span>` : ""}` : "";
  };
  return html`${d.runners.map((r) => {
    const state = r.online ? html`online${doing(r)}` : html`offline${r.waiting ? `, ${r.waiting} waiting` : ""}`;
    return html`<div class="plate${r.online ? "" : " off"}"><b>${mark(r.online ? "done" : "fail")}${r.name}</b>
      <span class="doing">${state}</span>${r.os || d.paused ? html`<span class="os">${r.os ?? ""}${r.os && d.paused ? " · " : ""}${
        d.paused ? html`<span class="st attn"><i aria-hidden="true"></i>paused</span>` : ""}</span>` : ""}${slots(r)}</div>`;
  })}`;
}

// `flash`: what the last action did. `draft` and `error`: a new request the server refused, shown again with why.
export function homePage(d: HomeData, user: User, o: { flash?: Flash; draft?: Draft; error?: string } = {}): string {
  const { flash, draft, error } = o;
  const pausedBy = d.paused && /^paused /.test(d.paused) ? `Runner ${d.paused}.` : `Runner paused${d.paused ? `: ${d.paused}` : ""}.`;
  const alerts = [
    ...(d.paused ? [html`<div class="alert attn"><div class="what"><strong>${pausedBy}</strong> No new requests start; those running finish.</div>
      <form method="post" action="/runner/resume"><button class="primary">Resume</button></form></div>`] : []),
    ...d.groupLocks.map((g) => html`<div class="alert fail"><div class="what"><strong>Deploy group ${g.name} is blocked:</strong> ${g.lock_reason}</div>
      <form method="post" action="/groups/${g.name}/unblock"><button>Unblock</button></form></div>`),
    ...d.runnerAlerts.map((t) => html`<div class="alert attn"><div class="what">${t}</div></div>`),
    ...(d.backupStale ? [html`<div class="alert attn"><div class="what">${d.backupAgeMs === null ? "No backup has run yet." : `The last backup was ${since(d.backupAgeMs)} ago.`}</div></div>`] : []),
  ];
  return page("Home", html`
<h1 class="sr">Home</h1>
${flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === "bad" ? "alert" : "status"}">${flash.text}</p>` : ""}
${alerts.length ? html`<div class="alerts">${alerts}</div>` : ""}
${d.attachedTo ? "" : newRequestForm(d, draft, error)}
${board(d)}
`, user, html`<script src="/static/htmx.js"></script><script src="/static/home.js" defer></script>`, { nav: "home", attachedTo: d.attachedTo, band: statusBar(d) });
}

// A part of the home page that refreshes itself every 5 s. `h` is a hash of what it shows, sent back with each poll:
// the server answers 204 when the part would show the same, and htmx swaps nothing, so nothing flickers.
export class Live extends Html { constructor(s: string, readonly h: string) { super(s); } }
const hashOf = (s: string) => createHash("sha1").update(s).digest("base64url").slice(0, 12);

// The home page's runner plates and counts, in the header band, refreshing from /live/status.
export function statusBar(d: HomeData): Live {
  const running = d.queue.filter((r) => r.status === "running").length;
  const waiting = d.queue.length - running;
  const inner = html`<div class="plates">${runnerPlates(d)}</div>
  <p class="counts">${d.attachedTo ? "" : html`<span>${running} running, ${waiting} queued</span>`}<span>Backup ${d.backupAgeMs === null ? "never ran" : ago(d.backupAgeMs)}</span></p>`;
  const h = hashOf(inner.s);
  return new Live(html`<div class="status" id="statusbar" role="status" hx-get="/live/status?h=${h}" hx-trigger="every 5s" hx-swap="outerHTML">${inner}</div>`.s, h);
}

// A queued or running request's line, refreshing from /requests/<id>/line.
export function queueLine(r: ReqRow): Live {
  const line = reqLine(r);
  const h = hashOf(line.s);
  return new Live(html`<li id="req-${r.id}" hx-get="/requests/${r.id}/line?h=${h}" hx-trigger="every 5s" hx-swap="outerHTML">${line}</li>`.s, h);
}

// The home page's lists, refreshing from /live. Only a change in which requests they hold redraws them (a request
// filed, started elsewhere, finished, or needing you anew); a queued or running one's own changes redraw just its
// line. They wait while you use them (home.js).
export function board(d: HomeData): Live {
  const own = d.attachedTo ? "This machine's own " : "";
  const h = hashOf(JSON.stringify([d.needs.map((r) => [r.id, r.updated_at]), d.queue.map((r) => r.id), d.recent.map((r) => [r.id, r.updated_at]), d.attachedTo]));
  return new Live(html`<div id="board" hx-get="/live?h=${h}" hx-trigger="every 5s" hx-swap="outerHTML">
<h2>${d.attachedTo ? "Needs you here" : "Needs you"} <span class="count num">${d.needs.length}</span></h2>
${d.needs.length ? html`<ul class="cards">${d.needs.map(needsCard)}</ul>` : html`<p class="empty">Nothing needs you.</p>`}

<h2>${own ? `${own}queue` : "Queue"} <span class="count num">${d.queue.length}</span></h2>
${d.queue.length ? html`<ul class="list">${d.queue.map(queueLine)}</ul>`
  : html`<p class="empty">${d.attachedTo ? "Nothing waiting here. While attached, requests here don't run." : "Nothing queued."}</p>`}

<h2>Recently finished</h2>
${d.recent.length ? html`<ul class="list">${d.recent.map((r) => html`<li>${reqLine(r)}${r.status === "done" && !d.attachedTo ? html`<details class="more"><summary>Reopen</summary>
  <form method="post" action="/requests/${r.id}/reopen"><label for="reopen-${r.id}">What's wrong?</label><textarea id="reopen-${r.id}" name="text" required></textarea>
  <div class="actions"><button class="primary">Reopen #${r.id}</button></div></form></details>` : ""}</li>`)}</ul>`
  : html`<p class="empty">Nothing finished yet.</p>`}
</div>`.s, h);
}

export type StepRow = { n: number; step: string; exit_code: number | null; started_at: number; ended_at: number | null };
export type RunData = {
  run: { id: number; status: string; attempt: number; branch: string | null; current_step: string | null; flags: string; commit_sha: string | null; push_state: string };
  req: ReqRow;
  steps: StepRow[]; log: string; logStep: number | null; diffStat: string; diff: string; diffCut: boolean; recipe: string;
  remoteHost?: string | null;   // the machine of an attached runner working this run: its log arrives every 15 s
  attachedTo?: string | null;
};

const PUSH: Record<string, string> = {
  none: "not pushed", push_started: "pushing", pushed: "pushed", push_unknown: "push unconfirmed", not_pushed: "not pushed",
};
const secs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 1 ? "<1 s" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
};
const duration = (s: StepRow) => s.ended_at === null ? "…" : secs(s.ended_at - s.started_at);
// A step's outcome in words. remote_busy exits 1 when nothing else is installing: that's good news.
function outcome(s: StepRow): Html {
  if (s.exit_code === null) return html`<span class="st work now"><i aria-hidden="true"></i>Running</span>`;
  const said = (family: Family, word: string) => html`<span class="st ${family}"><i aria-hidden="true"></i>${word}</span>`;
  if (s.step === "remote_busy") return s.exit_code === 1 ? said("idle", "Free") : s.exit_code === 0 ? said("attn", "Busy") : said("fail", `Unknown (exit ${s.exit_code})`);
  return s.exit_code === 0 ? said("done", "Passed") : said("fail", `Failed (exit ${s.exit_code})`);
}

// The run's track, each stop with the time its steps took. The request's state shapes it only on its latest run.
function runTrack(d: RunData): Html {
  const latest = d.req.last_run === d.run.id;
  const stops = stopsOf(d.steps.map((s) => [s.step, s.exit_code]), latest ? d.req.status : null);
  const times = STAGES.map((name) => {
    const mine = d.steps.filter((s) => s.step === name && s.ended_at !== null);
    return mine.length ? secs(mine.reduce((t, s) => t + s.ended_at! - s.started_at, 0)) : "";
  });
  return track(stops, { times });
}

// Proof of delivery, the last line of the steps: a deployed request whose live version was read back after the
// deploy, naming the commit.
function proof(d: RunData): Html {
  const r = d.req;
  const checked = d.steps.some((s) => s.step === "version" && s.exit_code === 0);
  if (!(r.status === "done" && r.status_reason === "deployed" && r.commit_sha && checked && r.last_run === d.run.id)) return html``;
  return html`<p class="proof"><strong>Signed for:</strong> ${r.groups ? r.groups.replace(/,/g, ", ") : "the target"} runs
    <span class="mono">${r.commit_sha.slice(0, 7)}</span>, read from its live version after the deploy.</p>`;
}

// The part of a run's page that changes while it runs; it refreshes itself every 2 s until the run ends.
export function liveBlock(d: RunData): Html {
  const live = d.run.status === "running";
  const poll = live ? html` hx-get="/runs/${d.run.id}/live${d.logStep ? html`?n=${d.logStep}` : ""}" hx-trigger="every 2s" hx-swap="outerHTML"` : html``;
  const chosen = d.steps.find((s) => s.n === d.logStep);
  const why = reasonOf(d.req);
  return html`<div id="live"${poll}>
<div class="label parcel"><div class="req">${routing(d.req.id)}<div class="body"><h1>${d.req.title}</h1>
  <div class="meta">${stateOf(d.req.status, d.req.status_reason)}<span>${d.req.project}</span>
  ${live ? html`<span class="live">${d.remoteHost ? `Running on ${d.remoteHost} · log every 15 s` : "Live"}</span>` : ""}</div></div></div>
<div class="lb"><p class="meta muted">Run ${d.run.id} · attempt ${d.run.attempt}${d.run.branch ? html` · <span class="mono">${d.run.branch}</span>` : ""}
  ${d.run.commit_sha ? html` · commit <span class="mono">${d.run.commit_sha.slice(0, 7)}</span>, ${PUSH[d.run.push_state] ?? d.run.push_state}` : ""}</p>
${runTrack(d)}
${why ? html`<p class="why">${why}</p>` : ""}${thumbs(d.req.files)}</div></div>
${detailsPanel(d.req)}
${flagsBox(d.run.flags)}
${actionsFor(d.req)}
<h2>Steps</h2>
<div class="label steps"><table><thead><tr><th class="n">#</th><th>Step</th><th>Result</th><th class="t">Time</th></tr></thead><tbody>
${d.steps.map((s) => html`<tr${s.n === d.logStep ? html` aria-current="true"` : ""}><td class="n">${s.n}</td>
  <td><a href="/runs/${d.run.id}?n=${s.n}#log">${STEP_NAMES[s.step] ?? s.step}</a></td><td>${outcome(s)}</td><td class="t">${duration(s)}</td></tr>`)}
</tbody></table>${proof(d)}</div>
<h2 id="log-title">Log${chosen ? html` <span class="count">${STEP_NAMES[chosen.step] ?? chosen.step}, step ${chosen.n}</span>` : ""}</h2>
<pre id="log" role="log" aria-labelledby="log-title" tabindex="0">${d.log || "(no output yet)"}</pre>
</div>`;
}

// What the checks noticed in the run, such as a deleted or skipped test: shown before the actions, since it bears on
// whether to retry or approve.
function flagsBox(json: string): Html {
  const flags = JSON.parse(json || "[]") as { kind: string; path: string; detail?: string }[];
  if (!flags.length) return html``;
  return html`<div class="alert attn flagbox"><div class="what"><strong>${flags.length} check flag${flags.length > 1 ? "s" : ""}</strong>
    <ul class="flags">${flags.map((f) => html`<li>${f.kind.replace(/_/g, " ")}: <span class="mono">${f.path}</span>${f.detail ? ` (${f.detail})` : ""}</li>`)}</ul></div></div>`;
}

export function runPage(d: RunData, user: User): string {
  return page(`Run ${d.run.id}`, html`
${liveBlock(d)}

<h2 id="diff">Changes</h2>
${d.diffStat ? html`<pre class="wide">${d.diffStat.replace(/^\n+/, "")}</pre><details class="more panel"><summary>Full diff${d.diffCut ? " (cut short)" : ""}</summary><pre class="wide">${d.diff}</pre></details>`
  : html`<p class="empty">No commit yet.</p>`}

<details class="more panel"><summary>Recipe</summary><p class="hint">How this project is built, tested and deployed. Read-only.</p><pre class="wide">${d.recipe}</pre></details>
`, user, d.run.status === "running" ? html`<script src="/static/htmx.js"></script><script src="/static/run.js" defer></script>` : html`<script src="/static/run.js" defer></script>`,
  { nav: null, attachedTo: d.attachedTo });
}


export type SettingsData = {
  aiAgent?: AgentId;
  workers: number; maxWorkers: number; suggested: number; cores: number; memoryGb: number; windows: boolean;
  paused: string | null;
  verified: boolean; // the session's passkey was checked recently: owners may change settings
  projects: { name: string; deploy_group: string; enabled: number; deployTo?: Choices }[];
  users: { name: string; role: string; passkeys: number; last_used: number | null }[];
  attachedTo?: string | null; // the queue this machine's runner works: its owner's runner settings apply, not these
};
// A one-time registration link just made for a user, shown once.
export type NewLink = { name: string; url: string };

// Owners change settings after a recent passkey check (pausing needs none); everyone else sees them read-only.
export function settingsPage(d: SettingsData, user: User, link?: NewLink): string {
  const owner = user.role === "owner";
  const off = owner && d.verified ? html`` : html` disabled`;
  // A change that can't be undone asks once more; before the passkey check it's a disabled button.
  const ask = (action: string, label: string, question: string) => owner && d.verified
    ? html`<details class="confirm danger"><summary class="btn danger">${label}…</summary><div class="confirm-body"><p>${question}</p>
      <div class="actions"><form method="post" action="${action}"><button class="danger">${label}</button></form></div></div></details>`
    : html`<button class="danger" disabled>${label}</button>`;
  const change = (action: string, label: string, cls = "") =>
    html`<form method="post" action="${action}"><button class="${cls}"${off}>${label}</button></form>`;
  // Deploy main, with the Deploy to list for a project that can install on a device.
  const deployMain = (p: SettingsData["projects"][number]) => {
    const action = `/settings/projects/${encodeURIComponent(p.name)}/deploy`;
    const devices = p.deployTo?.devices.length ? p.deployTo : null;
    const question = `Deploy ${p.name}'s main as it is? The runner builds and tests it, then ${devices ? "deploys it where you pick" : "runs its deploy step"}. Nothing is changed or committed.`;
    if (!devices) return ask(action, "Deploy main", question);
    // Before the passkey check the list shows too, disabled like the button, so the targets are visible.
    if (!(owner && d.verified)) return html`${deployToPicker(`deploy-to-${p.name}`, devices, html` disabled`)}<button class="danger" disabled>Deploy main</button>`;
    return html`<details class="confirm danger"><summary class="btn danger">Deploy main…</summary><div class="confirm-body"><p>${question}</p>
      <form method="post" action="${action}">${deployToPicker(`deploy-to-${p.name}`, devices)}<div class="actions"><button class="danger">Deploy main</button></div></form></div></details>`;
  };
  const userPath = (name: string, verb: string) => `/settings/users/${encodeURIComponent(name)}/${verb}`;
  return page("Settings", html`
<h1>Settings</h1>
${!owner ? html`<p class="muted">Only an owner can change settings.</p>`
  : d.verified ? html`<p class="flash ok" role="status">Passkey confirmed: you can change settings for a few minutes.</p>`
  : html`<div class="card"><p>Changing settings needs a fresh check of your passkey.</p>
    <div class="actions"><button class="primary" id="step-up">Confirm with passkey</button></div><p id="msg" class="bad" role="alert"></p></div>`}
${link ? html`<div class="card"><p class="ok">Open this link on the device that will hold ${link.name}'s passkey. It works once, for 30 minutes:</p>
  <pre class="link-box">${link.url}</pre></div>` : ""}

<h2>Runner</h2>
<div class="settings-section">
${d.attachedTo ? html`<p>Pause, workers and the default AI agent are set on ${queueLink(d.attachedTo)}: <a href="${d.attachedTo}/settings">change them there</a>.</p></div>`
  : html`${d.paused
  ? html`<p class="warn"><strong>Paused:</strong> ${d.paused}</p><div class="actions"><form method="post" action="/runner/resume"><button class="primary">Resume</button></form></div>`
  : html`<p>Running new requests.</p>${owner ? html`<div class="actions"><form method="post" action="/settings/pause"><button>Pause</button></form></div>
    <p class="hint">Requests already running finish.</p>` : ""}`}
<form method="post" action="/settings">
  <label for="ai-agent">Default AI agent</label>
  <select id="ai-agent" name="ai_agent"${off}>
    ${Object.entries(AGENTS).map(([id, label]) => html`<option value="${id}" ${(d.aiAgent ?? "claude") === id ? "selected" : ""}>${label}</option>`)}
  </select>
  <p class="hint">For requests that don't choose an agent of their own. Applies to new runs, including their verifier. Use subscription or ChatGPT token access configured on each runner.</p>
  <p class="hint">Gemini CLI uses Google OAuth. Antigravity CLI supports Google Free sign-in on Windows; import that login on each runner with agentry token antigravity --from-login.</p>
  <label for="workers">Workers</label>
  <p class="hint">How many requests the runner works on at once. Pushes and deploys still go one at a time for each deploy group.</p>
  <input type="number" id="workers" name="workers" min="1" max="${d.maxWorkers}" step="1" value="${d.workers}" required${off}>
  <p class="hint">Suggested for this machine: ${d.suggested} (${d.cores} CPU cores, ${d.memoryGb} GB of memory: one worker for every 4 cores and every 8 GB).</p>
  ${d.workers > d.suggested ? html`<p class="warn">${d.workers} workers is more than this machine suits. Builds and tests will slow each other down,
    and every worker uses the same agent account, so runs may hit its rate limits.</p>` : ""}
  ${d.windows && d.workers > 1 ? html`<p class="warn">On Windows every worker runs as the one AgentrySandbox user, so one request's agent can
    reach the files of the others running at the same time.</p>` : ""}
  ${owner ? html`<div class="actions"><button class="primary"${off}>Save</button></div>` : ""}
</form></div>`}

<h2>Projects</h2>
<div class="settings-section"><p class="hint">A disabled project's requests wait in the queue until it is enabled again.</p>
${d.attachedTo ? "" : html`<p class="hint">Deploy main builds and tests the project's main as it is, without an AI agent or a change, then runs
  its deploy step: for commits made outside Agentry, or a fresh build. A project whose recipe has no deploy step ends as built.</p>`}
<table><thead><tr><th>Project</th><th>Deploy group</th><th><span class="sr">Action</span></th></tr></thead><tbody>
${d.projects.map((p) => html`<tr><td>${p.name}${p.enabled ? "" : html` <span class="warn">(disabled)</span>`}</td><td class="nw">${p.deploy_group}</td>
  <td class="t">${owner ? html`${change(`/settings/projects/${encodeURIComponent(p.name)}/${p.enabled ? "disable" : "enable"}`, p.enabled ? "Disable" : "Enable")}
    ${d.attachedTo ? "" : deployMain(p)}` : ""}</td></tr>`)}
</tbody></table></div>

<h2>Users</h2>
<div class="settings-section"><table><thead><tr><th>User</th><th>Role</th><th>Passkeys</th><th class="t">Last sign-in</th></tr></thead><tbody>
${d.users.map((u) => html`<tr><td>${u.name}${u.name === user.name ? html` <span class="muted">(you)</span>` : ""}</td><td>${u.role}</td>
  <td class="num">${u.passkeys ? u.passkeys : html`<span class="warn">none yet</span>`}</td>
  <td class="t">${u.last_used ? ago(Date.now() - u.last_used) : "never"}</td></tr>
  ${owner && u.name !== user.name ? html`<tr><td colspan="4"><details class="more"><summary>Change ${u.name}</summary>
    <p class="hint">Reset signs ${u.name} out everywhere and makes a new one-time link.${u.passkeys ? "" : " Use it when their link has run out."}</p>
    <div class="actions">${ask(userPath(u.name, "reset"), "Reset passkeys", `Reset ${u.name}'s passkeys? ${u.name} is signed out everywhere and needs the new one-time link to sign in again.`)}
    ${ask(userPath(u.name, "remove"), `Remove ${u.name}`, `Remove ${u.name}? Their passkeys and sessions are deleted. This can't be undone.`)}</div></details></td></tr>` : ""}`)}
</tbody></table>
${owner ? html`<form method="post" action="/settings/users">
  <label for="new-user">New user's name</label><input type="text" id="new-user" name="name" required maxlength="32"${off}>
  <label for="new-role">Role</label><select id="new-role" name="role" aria-describedby="role-hint"${off}><option value="admin">admin</option><option value="owner">owner</option></select>
  <p class="hint" id="role-hint">Admins use Agentry; owners can also change settings.</p>
  <div class="actions"><button${off}>Add user</button></div></form>` : ""}
</div>
`, user, html`<script src="/static/webauthn.js"></script><script src="/static/app.js"></script>`, { nav: "settings", attachedTo: d.attachedTo });
}


export function loginPage(message?: string): string {
  return page("Sign in", html`<div class="label sheet">
<h1>Sign in</h1>
<p>Use the passkey on this device: Face ID, Touch ID or your device's lock.</p>
<div class="actions"><button class="primary" id="login">Sign in with passkey</button></div>
<p id="msg" class="bad" role="alert">${message ?? ""}</p></div>
<script src="/static/webauthn.js"></script><script src="/static/app.js"></script>`);
}

export function registerPage(code: string, name: string): string {
  return page("Set up passkey", html`<div class="label sheet">
<h1>Set up a passkey for ${name}</h1>
<p>It stays on this device and signs you in from now on. This link works once.</p>
<div class="actions"><button class="primary" id="register" data-code="${code}">Create passkey</button></div>
<p id="msg" class="bad" role="alert"></p></div>
<script src="/static/webauthn.js"></script><script src="/static/app.js"></script>`);
}

// What the service worker shows when this device can't reach the server (SW_JS), naming the site by its machine.
export function offlinePage(host: string): string {
  const site = host.split(".")[0].split(":")[0];
  return page(`Can't reach ${site}`, html`<div class="label sheet"><h1>Can't reach ${site}</h1>
<p class="message">This device can't reach Agentry at <strong>${host}</strong>.</p>
<p>Most likely Tailscale on this device is off or not connected. Open the Tailscale app: check that it's on and shows no
  warnings, or turn it off and on again.</p>
<p>If Tailscale looks fine, ${site} may be asleep, off or restarting.</p>
<div class="actions"><a class="btn" href="">Try again</a></div></div>`);
}

export function messagePage(title: string, message: string, user?: User | null): string {
  return page(title, html`<div class="label sheet"><h1>${title}</h1><p class="message">${message}</p><div class="actions"><a class="btn" href="/">Back to home</a></div></div>`, user);
}

// The home page's script (served as /static/home.js). The project picker: the form isn't sent with no project ticked.
// The lists: their refresh waits while one of their folded forms is open or focus is in them, so it never drops
// what you type or where you are.
export const HOME_JS = `
for (const form of document.querySelectorAll("form[action='/requests']")) {
  const picks = form.querySelector(".picks");
  form.addEventListener("submit", (e) => {
    if (picks && !picks.querySelector("input:checked")) { e.preventDefault(); picks.querySelector("input")?.focus(); }
  });
  // Deploy to follows the projects checked: shown while one of them has devices, with only their devices. The options
  // are rebuilt, not hidden, since Safari shows hidden options.
  const box = form.querySelector(".deploy-to");
  if (!box) continue;
  const select = box.querySelector("select"), usual = JSON.parse(box.dataset.usual);
  const [first, ...devices] = select.options;
  const follow = () => {
    const picked = [...form.querySelectorAll("input[name=project]:checked")].map((i) => i.value).filter((p) => p in usual);
    const keep = select.value;
    box.hidden = select.disabled = !picked.length;
    first.textContent = [...new Set(picked.map((p) => usual[p]))].join(" / ");
    select.replaceChildren(first, ...devices.filter((o) => o.dataset.projects.split(" ").some((p) => picked.includes(p))));
    select.value = [...select.options].some((o) => o.value === keep) ? keep : "";
  };
  form.addEventListener("change", (e) => { if (e.target.name === "project") follow(); });
  follow();
}
document.addEventListener("htmx:beforeRequest", (e) => {
  const board = document.getElementById("board");
  if (e.detail.elt === board && (board.querySelector("details[open]") || board.contains(document.activeElement))) e.preventDefault();
});
// Back from a run's page, the link that went there still has focus: let the lists refresh again.
addEventListener("pageshow", (e) => { if (e.persisted) document.activeElement?.blur(); });
`;

// The run page's log (served as /static/run.js): it opens at its newest line and stays there across htmx
// refreshes, unless the reader has scrolled up to read.
export const RUN_JS = `
let pinned = true, top = 0;
const log = () => document.getElementById("log");
const atEnd = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24;
const toEnd = () => { const l = log(); if (l) l.scrollTop = l.scrollHeight; };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", toEnd); else toEnd();
document.addEventListener("htmx:beforeSwap", () => { const l = log(); if (l) { pinned = atEnd(l); top = l.scrollTop; } });
document.addEventListener("htmx:afterSwap", () => { const l = log(); if (l) l.scrollTop = pinned ? l.scrollHeight : top; });
`;

// The browser half of sign-in and registration (served as /static/app.js).
export const APP_JS = `
async function agentryPost(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), credentials: "same-origin" });
  const text = await r.text();
  if (!r.ok) throw new Error(text || r.statusText);
  return text ? JSON.parse(text) : {};
}
// The browser's own passkey errors, in words that say what to do; the server's come as they are.
function agentryShow(e) {
  document.getElementById("msg").textContent = e.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
    ? "This device already has a passkey for this account on this site: sign in with it instead."
    : e.name === "NotAllowedError"
    ? "No passkey was used: the prompt was closed or timed out, or this device has no passkey for this site. Try again, or use another device's passkey (your phone, for example)."
    : e.message || String(e);
}
async function agentryLogin() {
  try {
    const options = await agentryPost("/login/options");
    const answer = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    await agentryPost("/login/verify", answer);
    location.href = "/";
  } catch (e) { agentryShow(e); }
}
// Step-up before a settings change: a fresh check of the signed-in user's own passkey.
async function agentryStepUp() {
  try {
    const options = await agentryPost("/step-up/options");
    const answer = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    await agentryPost("/step-up/verify", answer);
    location.reload();
  } catch (e) { agentryShow(e); }
}
async function agentryRegister(code) {
  try {
    const options = await agentryPost("/register/" + code + "/options");
    const answer = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
    await agentryPost("/register/" + code + "/verify", answer);
    location.href = "/";
  } catch (e) { agentryShow(e); }
}
// No inline handlers: the page's Content-Security-Policy allows scripts from this origin only.
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("login")?.addEventListener("click", agentryLogin);
  document.getElementById("step-up")?.addEventListener("click", agentryStepUp);
  const reg = document.getElementById("register");
  reg?.addEventListener("click", () => agentryRegister(reg.dataset.code));
});
`;

// Every page's script (served as /static/offline.js): it installs the service worker.
export const OFFLINE_JS = `if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});`;

// The service worker (served as /sw.js, so it covers every page): a page that can't load because this device can't
// reach the server gets the /offline page cached at install, instead of the browser's own error. Only page loads and
// the icon and font that page shows are handled; every other request goes to the network as if there were no worker.
export const SW_JS = `
const CACHE = "agentry-offline";
const KEPT = ["/static/icon.png", "/static/archivo.woff2"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([new Request("/offline", { cache: "reload" }), ...KEPT])).then(() => self.skipWaiting()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // a form post goes straight out: iOS WebKit truncates its files when re-sent
  const path = new URL(e.request.url).pathname;
  const fallback = e.request.mode === "navigate" ? "/offline" : KEPT.includes(path) ? path : null;
  if (fallback) e.respondWith(fetch(e.request).catch(() => caches.match(fallback)));
});
`;
