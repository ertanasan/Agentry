// The web UI's pages, server-rendered (winhost design "UI"). Every value goes through `html`, which escapes it
// unless it is itself the output of `html`: request text, logs and diffs are written by people and agents, and
// must never become markup on a page that carries the session cookie (slice 2 review Q1). Actions are plain
// forms posting to the server; htmx only refreshes the live parts: a running run's page, and the home page's lists.
import type { User } from "./accounts.ts";
import { AGENTS, type AgentId } from "./adapters/providers.ts";

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

// One quiet operations look: the system font, neutral surfaces, one accent for actions, and four state colors that
// always come with a shape and a word. Both themes follow the device; dark text sits on the dark theme's accent.
const CSS = `
:root { color-scheme: light dark;
  --bg:#f6f6f4; --surface:#fff; --sunk:#efefec; --fg:#18181d; --muted:#5d5d68; --line:#e2e2e0;
  --accent:#2350c8; --on-accent:#fff; --attn:#9a4a00; --work:#2350c8; --fail:#b42318; --done:#1b7a36; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#111114; --surface:#19191e; --sunk:#0c0c0f; --fg:#ececf0; --muted:#a3a3ae; --line:#2c2c34;
  --accent:#8fb0ff; --on-accent:#0b1222; --attn:#f2a65a; --work:#8fb0ff; --fail:#ff8a80; --done:#62d27e; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; caret-color: var(--accent); }
::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
a { color: var(--accent); text-underline-offset: .2em; }
main { max-width: 760px; margin: 0 auto; padding: 0 16px 48px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.muted { color: var(--muted); }
.num, table, .meta { font-variant-numeric: tabular-nums; }
code, pre, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.mono { font-size: .9em; }
p, .hint, .why { text-wrap: pretty; }
code { font-size: .9em; background: var(--sunk); padding: 1px 5px; border-radius: 4px; }

header.top { display: flex; align-items: center; gap: 4px 16px; flex-wrap: wrap; padding: 12px 0; margin-bottom: 4px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 650; font-size: 17px; color: var(--fg); text-decoration: none; margin-right: auto; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; }
.brand img { width: 22px; height: 22px; border-radius: 5px; }
nav.top { display: flex; align-items: center; gap: 2px; font-size: 15px; }
nav.top a { color: var(--muted); text-decoration: none; padding: 10px 10px; border-radius: 8px; min-height: 44px; display: inline-flex; align-items: center; }
nav.top a[aria-current="page"] { color: var(--fg); font-weight: 600; }
nav.top .who { color: var(--muted); padding: 0 6px 0 12px; border-left: 1px solid var(--line); margin-left: 6px; }
nav.top form { display: inline; }
nav.top button.link { color: var(--muted); }

.modebar { margin: 12px 0 0; padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, var(--work) 12%, var(--surface)); }
.modebar strong { font-weight: 600; }
.modebar p { margin: 0; } .modebar .hint { margin-top: 6px; }

h1 { font-size: 25px; line-height: 1.3; font-weight: 650; margin: 24px 0 6px; letter-spacing: -.01em; text-wrap: balance; }
h2 { font-size: 20px; font-weight: 650; margin: 36px 0 12px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; align-items: baseline; gap: 8px; letter-spacing: -.005em; }
h2 .count { font-weight: 500; color: var(--muted); }
h3 { font-size: 15px; font-weight: 600; margin: 0; }
p { margin: 6px 0; }

.statusbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin: 14px 0 0; color: var(--muted); font-size: 15px; }
.statusbar .runner { color: var(--fg); font-weight: 550; display: inline-flex; align-items: center; gap: 8px; }

.flash { margin: 14px 0 0; padding: 12px 14px; border-radius: 10px; }
.flash.ok { background: color-mix(in srgb, var(--done) 13%, var(--surface)); }
.flash.bad { background: color-mix(in srgb, var(--fail) 13%, var(--surface)); }

.alerts { display: grid; gap: 8px; margin-top: 14px; }
.alert { padding: 12px 14px; border-radius: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.alert .what { flex: 1 1 260px; }
.alert.fail { background: color-mix(in srgb, var(--fail) 12%, var(--surface)); }
.alert.attn { background: color-mix(in srgb, var(--attn) 13%, var(--surface)); }

/* A state: a shape and a word, colored by its family (waiting on you, working, failed, finished, idle). */
.st { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.st i { width: 9px; height: 9px; flex: none; display: inline-block; background: currentColor; }
.st.attn { color: var(--attn); } .st.attn i { transform: rotate(45deg); width: 8px; height: 8px; }
.st.work { color: var(--work); } .st.work i { border-radius: 50%; background: none; border: 2px solid currentColor; }
.st.work.now i { background: currentColor; animation: beat 1.6s ease-out infinite; }
.st.fail { color: var(--fail); } .st.fail i { border-radius: 2px; }
.st.done { color: var(--done); } .st.done i { border-radius: 50%; }
.st.idle { color: var(--muted); } .st.idle i { height: 2px; border-radius: 1px; }
@keyframes beat { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 55%, transparent); } 100% { box-shadow: 0 0 0 7px transparent; } }
@media (prefers-reduced-motion: reduce) { .st.work.now i { animation: none; } }

.list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.list > li { padding: 12px 0; border-bottom: 1px solid var(--line); }
.req .title { font-weight: 600; color: var(--fg); text-decoration: none; overflow-wrap: anywhere; }
.req a.title:hover { text-decoration: underline; }
.req .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; margin-top: 4px; font-size: 14px; color: var(--muted); }
.req .why { margin: 6px 0 0; font-size: 15px; overflow-wrap: anywhere; }
.req .why.wait { color: var(--attn); font-weight: 550; display: flex; align-items: baseline; gap: 8px; }
.empty { color: var(--muted); margin: 8px 0; }
.cards { list-style: none; margin: 0; padding: 0; }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin: 10px 0; }
.ask { margin: 10px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--sunk); white-space: pre-wrap; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; margin-top: 12px; }
.actions form { display: inline; margin: 0; }
.hint { font-size: 14px; color: var(--muted); margin: 6px 0 0; }

label { display: block; font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
label .opt { font-weight: 400; color: var(--muted); }
fieldset { border: 0; margin: 14px 0 0; padding: 0; min-width: 0; }
legend { font-size: 14px; font-weight: 600; padding: 0; margin-bottom: 6px; }
input[type=text], input[type=number], textarea, select { width: 100%; font: inherit; padding: 10px 12px; min-height: 44px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--fg); }
textarea { min-height: 92px; resize: vertical; }
::placeholder { color: var(--muted); opacity: 1; }
input:disabled, textarea:disabled, select:disabled { background: var(--sunk); color: var(--muted); cursor: not-allowed; }
input[type=file] { font: inherit; font-size: 14px; color: var(--muted); max-width: 100%; }
input[type=file]::file-selector-button { font: inherit; font-size: 15px; min-height: 44px; padding: 8px 14px; margin-right: 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; }
.picks { display: flex; flex-wrap: wrap; gap: 8px; }
.picks label { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-weight: 500; min-height: 44px; padding: 0 14px;
  border: 1px solid var(--line); border-radius: 999px; background: var(--surface); cursor: pointer; }
.picks label:has(input:checked) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
.picks input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.field-error { color: var(--fail); font-size: 14px; margin: 10px 0 0; }

button, .btn { font: inherit; font-size: 15px; font-weight: 550; min-height: 44px; padding: 9px 16px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--fg); display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; text-decoration: none; transition: background-color .15s ease-out, border-color .15s ease-out; }
button:hover, .btn:hover { border-color: color-mix(in srgb, var(--fg) 30%, var(--line)); }
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, var(--fg)); }
button.danger, .btn.danger { color: var(--fail); }
button:disabled { opacity: .55; cursor: not-allowed; }
button.link { background: none; border: 0; padding: 10px 6px; font-weight: 500; }

/* A disclosure: a 44 px row that opens a short form. A confirm is one with a button as its summary. */
details > summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; gap: 8px; list-style: none; }
details > summary::-webkit-details-marker { display: none; }
details.more > summary { color: var(--accent); font-weight: 550; font-size: 15px; }
details.more > summary::before { content: ""; width: 7px; height: 7px; border: solid currentColor; border-width: 0 2px 2px 0; transform: rotate(-45deg); transition: transform .15s ease-out; margin: 0 2px; }
details.more[open] > summary::before { transform: rotate(45deg); }
details.confirm, details.answer { display: inline-block; }
details.answer > summary { display: inline-flex; }
details.answer[open] { display: block; flex-basis: 100%; }
details.answer[open] > summary { display: none; }
details.confirm > summary { display: inline-flex; }
details.confirm[open] { display: block; flex-basis: 100%; }
.confirm-body { margin-top: 8px; padding: 12px; border-radius: 10px; background: color-mix(in srgb, var(--fail) 10%, var(--surface)); }
.confirm-body .actions { margin-top: 8px; }
.confirm.go .confirm-body { background: color-mix(in srgb, var(--attn) 11%, var(--surface)); }

details.new { margin-top: 16px; }
details.new > summary { font-weight: 600; font-size: 16px; color: var(--on-accent); background: var(--accent); border-radius: 10px; padding: 0 16px; width: fit-content; }
details.new[open] > summary { color: var(--fg); background: none; padding: 0; }
details.new > summary::before { content: "+"; font-size: 20px; font-weight: 500; line-height: 1; }
details.new[open] > summary::before { content: "–"; }
details.new form { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 4px 14px 14px; margin-top: 6px; }

.thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.thumbs img { height: 56px; max-width: 120px; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); display: block; }
.thumbs a.file { display: inline-flex; align-items: center; min-height: 32px; border: 1px solid var(--line); border-radius: 6px; padding: 2px 10px; font-size: 14px; }

/* The run page: the pipeline, the steps and the log of a run. */
.pipeline { list-style: none; margin: 18px 0 0; padding: 0; display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
.pipeline li { font-size: 13px; font-weight: 600; color: var(--muted); padding-top: 10px; position: relative; }
.pipeline li::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; border-radius: 2px; background: var(--line); }
.pipeline li.done { color: var(--fg); } .pipeline li.done::before { background: var(--done); }
.pipeline li.fail { color: var(--fail); } .pipeline li.fail::before { background: var(--fail); }
.pipeline li.now { color: var(--work); } .pipeline li.now::before { background: var(--work); animation: glow 1.6s ease-in-out infinite alternate; }
@keyframes glow { from { opacity: .45; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .pipeline li.now::before { animation: none; } }
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--work); }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
th { text-align: left; font-size: 13px; font-weight: 600; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--line); }
td { text-align: left; padding: 0 8px; border-bottom: 1px solid var(--line); height: 44px; }
td.n, th.n { width: 2.5em; color: var(--muted); } td.t, th.t { text-align: right; white-space: nowrap; } td.nw { white-space: nowrap; }
tr[aria-current] td { background: color-mix(in srgb, var(--accent) 9%, transparent); }
tr[aria-current] td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
td a { display: block; padding: 11px 0; }
.ok { color: var(--done); } .bad { color: var(--fail); } .warn { color: var(--attn); }
pre { background: var(--sunk); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 8px 0 0; overflow: auto;
  font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 60vh; }
pre.wide { white-space: pre; overflow-wrap: normal; }
.flags { list-style: none; padding: 0; margin: 0; }
.flags li { padding: 6px 0; overflow-wrap: anywhere; }
.flagbox { margin-top: 12px; }
.flagbox .flags { margin-top: 4px; }
.panel { margin-top: 10px; }
.settings-section { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 4px 14px 14px; }
.settings-section table { margin-top: 8px; }
.link-box { overflow-wrap: anywhere; }
.message::first-letter { text-transform: uppercase; }
`;

export type Nav = "home" | "settings" | null;

// `attachedTo`: the queue this machine's runner works instead of its own; every page then says so.
export function page(title: string, body: Html, user?: User | null, extraHead: Html = html``, o: { nav?: Nav; attachedTo?: string | null } = {}): string {
  const here = (n: Nav) => o.nav === n ? html` aria-current="page"` : html``;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Agentry</title><link rel="icon" href="/static/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="Agentry"><style>${new Html(CSS)}</style>${extraHead}</head>
<body><main>
<header class="top"><a class="brand" href="/"><img src="/static/icon.png" alt="">Agentry</a>${user ? html`<nav class="top" aria-label="Main">
  <a href="/"${here("home")}>Home</a><a href="/settings"${here("settings")}>Settings</a>
  <span class="who">${user.name}</span><form method="post" action="/logout"><button class="link">Sign out</button></form></nav>` : ""}</header>
${user && o.attachedTo ? html`<div class="modebar"><p>This machine's runner works <strong>${queueLink(o.attachedTo)}</strong>'s queue:
  file requests, follow runs and change runner settings <a href="${o.attachedTo}">there</a> (<a href="${o.attachedTo}/settings">its settings</a>).</p>
  <p class="hint"><code>agentry detach</code> on this machine brings back its own queue.</p></div>` : ""}
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
  commit_sha: string | null; groups: string | null;     // the last commit made for it, and its deploy groups
  waiting?: string | null;                               // a queued request whose runner can't take it now: why
  runner?: string | null;                                // a running request: the runner working on it
  flag_count?: number | null;                            // the check flags of its latest run
};
// A runner of the queue: this machine's (named by its host) or an attached one (named by its runner key), what it
// works on and how many queued requests wait for it.
export type RunnerInfo = {
  name: string; local: boolean; online: boolean; running: number; waiting: number;
  working: { id: number; title: string; run: number | null; step: string | null }[];
};
export type GroupLock = { name: string; lock_reason: string | null };
export type Flash = { kind: "ok" | "bad"; text: string };
// What was typed into the new-request form when the server refused it, to show again.
export type Draft = { projects: string[]; title: string; body: string; done_when: string; done_when_test: string; ai_agent: string; hadFiles: boolean };
export type HomeData = {
  projects: Project[]; needs: ReqRow[]; queue: ReqRow[]; recent: ReqRow[]; groupLocks: GroupLock[];
  paused: string | null; runners: RunnerInfo[]; backupAgeMs: number | null; backupStale: boolean;
  aiAgent: AgentId;           // the queue's agent, for requests that don't choose one
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
function stateOf(status: string, reason: string | null): Html {
  const [label, family] = STATES[status] ?? [status, "idle" as Family];
  const word = status === "done" && reason === "deployed" ? "Deployed" : status === "done" && reason === "built" ? "Built" : label;
  return html`<span class="st ${family}${status === "running" ? " now" : ""}"><i aria-hidden="true"></i>${word}</span>`;
}
// The reason worth showing under a request: "deployed" and "built" are already in its state.
const reasonOf = (r: { status: string; status_reason: string | null }) =>
  r.status_reason && !(r.status === "done" && ["deployed", "built"].includes(r.status_reason)) ? r.status_reason : null;

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

function reqLine(r: ReqRow): Html {
  const why = reasonOf(r);
  const flags = r.flag_count ?? 0;
  return html`<div class="req">${r.last_run ? html`<a class="title" href="/runs/${r.last_run}">${r.title}</a>` : html`<span class="title">${r.title}</span>`}
  <div class="meta">${stateOf(r.status, r.status_reason)}<span class="num">#${r.id}</span><span>${r.project}</span>
    ${r.ai_agent ? html`<span>${AGENTS[r.ai_agent]}</span>` : ""}${r.runner ? html`<span>on ${r.runner}</span>` : ""}
    ${flags ? html`<span class="st attn"><i aria-hidden="true"></i>${flags} check flag${flags > 1 ? "s" : ""}</span>` : ""}</div>
  ${r.waiting ? html`<p class="why wait"><span class="st attn"><i aria-hidden="true"></i></span>${r.waiting}</p>` : why ? html`<p class="why">${why}</p>` : ""}
  ${thumbs(r.files)}</div>`;
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

function needsCard(r: ReqRow): Html {
  const asks = r.status === "needs_info" && r.status_reason;
  return html`<li class="card">${reqLine(asks ? { ...r, status_reason: null } : r)}
    ${asks ? html`<p class="ask">${r.status_reason}</p>` : ""}${actionsFor(r)}</li>`;
}

function newRequestForm(d: HomeData, draft?: Draft, error?: string): Html {
  const v = draft ?? { projects: [], title: "", body: "", done_when: "", done_when_test: "", ai_agent: "", hadFiles: false };
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
  ${filePicker("files-new")}
  ${error ? html`<p class="field-error message" role="alert">${error}${/[.!?]$/.test(error) ? "" : "."}${v.hadFiles ? " Attach the files again." : ""}</p>` : ""}
  <div class="actions"><button class="primary">Queue it</button></div>
</form></details>`;
}

// The runners in a few words: attached elsewhere, paused, or each one online or offline.
function runnerState(d: HomeData): Html {
  const mark = (family: string) => html`<span class="st ${family}"><i aria-hidden="true"></i></span>`;
  if (d.attachedTo) return html`<span class="runner">${mark("work")}Runner attached to ${queueLink(d.attachedTo)}</span>`;
  if (d.paused) return html`<span class="runner">${mark("attn")}Runner${d.runners.length > 1 ? "s" : ""} paused</span>`;
  // What a runner works on: its first request, linked to its run, with the step it's in.
  const doing = (r: RunnerInfo) => {
    const [w] = r.working;
    if (!w) return html``;
    const what = html`#${w.id} ${w.step ? STEP_NAMES[w.step] ?? w.step : "starting"}`;
    return html` · ${w.run ? html`<a href="/runs/${w.run}">${what}</a>` : what}${r.working.length > 1 ? ` +${r.working.length - 1}` : ""}`;
  };
  if (d.runners.length === 1) {
    const [r] = d.runners;
    return r.online ? html`<span class="runner">${mark("done")}Runner online on ${r.name}${doing(r)}</span>` : html`<span class="runner">${mark("fail")}Runner offline</span>`;
  }
  return html`${d.runners.map((r) => html`<span class="runner">${mark(r.online ? "done" : "fail")}${r.name} ${r.online ? "online" : "offline"}${doing(r)}${
    !r.online && r.waiting ? `, ${r.waiting} waiting` : ""}</span>`)}`;
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
${statusBar(d)}
${flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === "bad" ? "alert" : "status"}">${flash.text}</p>` : ""}
${alerts.length ? html`<div class="alerts">${alerts}</div>` : ""}
${d.attachedTo ? "" : newRequestForm(d, draft, error)}
${board(d)}
`, user, html`<script src="/static/htmx.js"></script><script src="/static/home.js" defer></script>`, { nav: "home", attachedTo: d.attachedTo });
}

// The home page's status line; `oob`: sent with the lists from /live, it replaces the one on the page too.
function statusBar(d: HomeData, oob = false): Html {
  const running = d.queue.filter((r) => r.status === "running").length;
  const waiting = d.queue.length - running;
  return html`<p class="statusbar" id="statusbar" role="status"${oob ? html` hx-swap-oob="true"` : ""}>${d.attachedTo ? "" : html`${runnerState(d)}<span>${running} running, ${waiting} queued</span>`}
  <span>Backup ${d.backupAgeMs === null ? "never ran" : ago(d.backupAgeMs)}</span></p>`;
}

// What /live sends the home page every 5 s: its lists, and the status line counting them.
export const homeLive = (d: HomeData): Html => html`${statusBar(d, true)}${board(d)}`;

// The home page's lists. They refresh themselves every 5 s, except while you use them (home.js).
function board(d: HomeData): Html {
  const own = d.attachedTo ? "This machine's own " : "";
  return html`<div id="board" hx-get="/live" hx-trigger="every 5s" hx-swap="outerHTML">
<h2>${d.attachedTo ? "Needs you here" : "Needs you"} <span class="count num">${d.needs.length}</span></h2>
${d.needs.length ? html`<ul class="cards">${d.needs.map(needsCard)}</ul>` : html`<p class="empty">Nothing needs you.</p>`}

<h2>${own ? `${own}queue` : "Queue"} <span class="count num">${d.queue.length}</span></h2>
${d.queue.length ? html`<ul class="list">${d.queue.map((r) => html`<li>${reqLine(r)}</li>`)}</ul>`
  : html`<p class="empty">${d.attachedTo ? "Nothing waiting here. While attached, requests here don't run." : "Nothing queued."}</p>`}

<h2>Recently finished</h2>
${d.recent.length ? html`<ul class="list">${d.recent.map((r) => html`<li>${reqLine(r)}${r.status === "done" && !d.attachedTo ? html`<details class="more"><summary>Reopen</summary>
  <form method="post" action="/requests/${r.id}/reopen"><label for="reopen-${r.id}">What's wrong?</label><textarea id="reopen-${r.id}" name="text" required></textarea>
  <div class="actions"><button class="primary">Reopen #${r.id}</button></div></form></details>` : ""}</li>`)}</ul>`
  : html`<p class="empty">Nothing finished yet.</p>`}
</div>`;
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
const duration = (s: StepRow) => {
  if (s.ended_at === null) return "…";
  const secs = Math.round((s.ended_at - s.started_at) / 1000);
  return secs < 1 ? "<1 s" : secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min${secs % 60 ? ` ${secs % 60} s` : ""}`;
};
// A step's outcome in words. remote_busy exits 1 when nothing else is installing: that's good news.
function outcome(s: StepRow): Html {
  if (s.exit_code === null) return html`<span class="st work now"><i aria-hidden="true"></i>Running</span>`;
  if (s.step === "remote_busy") return s.exit_code === 1 ? html`<span class="muted">Free</span>` : s.exit_code === 0 ? html`<span class="warn">Busy</span>` : html`<span class="bad">Unknown (exit ${s.exit_code})</span>`;
  return s.exit_code === 0 ? html`<span class="ok">Passed</span>` : html`<span class="bad">Failed (exit ${s.exit_code})</span>`;
}
const STEP_NAMES: Record<string, string> = {
  version: "Live version", agent: "Agent", build: "Build", test: "Test", verify: "Verify", remote_busy: "Install check", deploy: "Deploy",
};
// The five stages a run goes through, each done, failed, running or not reached.
function pipeline(d: RunData): Html {
  const stages = ["agent", "build", "test", "verify", "deploy"];
  return html`<ol class="pipeline" aria-label="Progress">${stages.map((name) => {
    const steps = d.steps.filter((s) => s.step === name);
    const state = !steps.length ? "" : steps.some((s) => s.exit_code === null) ? "now" : steps.some((s) => s.exit_code !== 0) ? "fail" : "done";
    const said = { "": "not reached", now: "running", fail: "failed", done: "done" }[state];
    return html`<li class="${state}">${STEP_NAMES[name]}<span class="sr">: ${said}</span></li>`;
  })}</ol>`;
}

// The part of a run's page that changes while it runs; it refreshes itself every 2 s until the run ends.
export function liveBlock(d: RunData): Html {
  const live = d.run.status === "running";
  const poll = live ? html` hx-get="/runs/${d.run.id}/live${d.logStep ? html`?n=${d.logStep}` : ""}" hx-trigger="every 2s" hx-swap="outerHTML"` : html``;
  const chosen = d.steps.find((s) => s.n === d.logStep);
  const why = reasonOf(d.req);
  return html`<div id="live"${poll}>
<div class="req"><div class="meta">${stateOf(d.req.status, d.req.status_reason)}<span class="num">#${d.req.id}</span><span>${d.req.project}</span>
  ${live ? html`<span class="live">${d.remoteHost ? `Running on ${d.remoteHost} · log every 15 s` : "Live"}</span>` : ""}</div>
  ${why ? html`<p class="why">${why}</p>` : ""}${thumbs(d.req.files)}</div>
${detailsPanel(d.req)}
${flagsBox(d.run.flags)}
${actionsFor(d.req)}
${pipeline(d)}
<h2>Steps</h2>
<table><thead><tr><th class="n">#</th><th>Step</th><th>Result</th><th class="t">Time</th></tr></thead><tbody>
${d.steps.map((s) => html`<tr${s.n === d.logStep ? html` aria-current="true"` : ""}><td class="n">${s.n}</td>
  <td><a href="/runs/${d.run.id}?n=${s.n}#log">${STEP_NAMES[s.step] ?? s.step}</a></td><td>${outcome(s)}</td><td class="t">${duration(s)}</td></tr>`)}
</tbody></table>
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
<h1>${d.req.title}</h1>
<p class="muted meta">Run ${d.run.id} · attempt ${d.run.attempt}${d.run.branch ? html` · <span class="mono">${d.run.branch}</span>` : ""}
  ${d.run.commit_sha ? html` · commit <span class="mono">${d.run.commit_sha.slice(0, 7)}</span>, ${PUSH[d.run.push_state] ?? d.run.push_state}` : ""}</p>
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
  projects: { name: string; deploy_group: string; enabled: number }[];
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
<table><thead><tr><th>Project</th><th>Deploy group</th><th><span class="sr">Action</span></th></tr></thead><tbody>
${d.projects.map((p) => html`<tr><td>${p.name}${p.enabled ? "" : html` <span class="warn">(disabled)</span>`}</td><td class="nw">${p.deploy_group}</td>
  <td class="t">${owner ? change(`/settings/projects/${encodeURIComponent(p.name)}/${p.enabled ? "disable" : "enable"}`, p.enabled ? "Disable" : "Enable") : ""}</td></tr>`)}
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
  return page("Sign in", html`
<h1>Sign in</h1>
<p>Use the passkey on this device: Face ID, Touch ID or your device's lock.</p>
<div class="actions"><button class="primary" id="login">Sign in with passkey</button></div>
<p id="msg" class="bad" role="alert">${message ?? ""}</p>
<script src="/static/webauthn.js"></script><script src="/static/app.js"></script>`);
}

export function registerPage(code: string, name: string): string {
  return page("Set up passkey", html`
<h1>Set up a passkey for ${name}</h1>
<p>It stays on this device and signs you in from now on. This link works once.</p>
<div class="actions"><button class="primary" id="register" data-code="${code}">Create passkey</button></div>
<p id="msg" class="bad" role="alert"></p>
<script src="/static/webauthn.js"></script><script src="/static/app.js"></script>`);
}

export function messagePage(title: string, message: string, user?: User | null): string {
  return page(title, html`<h1>${title}</h1><p class="message">${message}</p><div class="actions"><a class="btn" href="/">Back to home</a></div>`, user);
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
function agentryShow(e) { document.getElementById("msg").textContent = e.message || String(e); }
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
