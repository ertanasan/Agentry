// The web UI's pages, server-rendered (winhost design "UI"). Every value goes through `html`, which escapes it
// unless it is itself the output of `html`: request text, logs and diffs are written by people and agents, and
// must never become markup on a page that carries the session cookie (slice 2 review Q1). Actions are plain
// forms posting to the server; htmx only refreshes a running step's log.
import type { User } from "./accounts.ts";

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

const CSS = `
:root { --bg:#fff; --fg:#1b1b1f; --muted:#6b6b76; --line:#e2e2e8; --card:#f6f6f9; --accent:#2457d6; --warn:#b4540a; --bad:#b42318; --ok:#1a7f37; }
@media (prefers-color-scheme: dark) { :root { --bg:#121216; --fg:#ececf1; --muted:#9a9aa6; --line:#2c2c35; --card:#1b1b22; --accent:#7aa2ff; --warn:#f0a35c; --bad:#ff7b72; --ok:#56d364; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
header { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; margin-bottom: 16px; }
header h1 { font-size: 20px; margin: 0; } header h1 a { color: inherit; text-decoration: none; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 24px 0 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 8px 0; }
.muted { color: var(--muted); } .warn { color: var(--warn); } .bad { color: var(--bad); } .ok { color: var(--ok); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
input[type=text], input[type=number], textarea, select { width: 100%; font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
textarea { min-height: 84px; resize: vertical; }
.thumbs img { height: 56px; max-width: 120px; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); margin: 6px 6px 0 0; }
.thumbs a.file { display: inline-block; border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; margin: 6px 6px 0 0; font-size: 14px; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; min-height: 40px; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--bad); }
button:disabled { opacity: .5; cursor: default; }
form.inline { display: inline; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; } .chips label { border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; }
.chips input { margin-right: 4px; }
details.combo { border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
details.combo summary { padding: 8px 10px; cursor: pointer; min-height: 40px; }
details.combo label { display: flex; gap: 8px; align-items: center; padding: 8px 10px; min-height: 40px; border-top: 1px solid var(--line); }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px; overflow-x: auto; font: 12px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; max-height: 60vh; overflow-y: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; } td, th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); }
a { color: var(--accent); }
.status { font-size: 13px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
`;

export function page(title: string, body: Html, user?: User | null, extraHead: Html = html``): string {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Agentry</title><link rel="icon" href="/static/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="Agentry"><style>${new Html(CSS)}</style>${extraHead}</head>
<body><main>
<header><h1><a href="/">Agentry</a></h1>${user ? html`<span class="muted"><a href="/settings">Settings</a> · ${user.name} · <form class="inline" method="post" action="/logout"><button>Sign out</button></form></span>` : ""}</header>
${body}
</main></body></html>`.s;
}

export type Project = { name: string };
export type ReqRow = {
  id: number; project: string; title: string; status: string; status_reason: string | null; updated_at: number; last_run: number | null;
  body: string; done_when: string | null; files: string; // the attachments, a JSON array of FileRef
};
export type GroupLock = { name: string; lock_reason: string | null };
export type HomeData = {
  projects: Project[]; needs: ReqRow[]; queue: ReqRow[]; recent: ReqRow[]; groupLocks: GroupLock[];
  paused: string | null; runnerAlive: boolean; backupAgeMs: number | null; backupStale: boolean;
};

const ago = (ms: number) => ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : ms < 86400_000 ? `${Math.round(ms / 3600_000)} h ago` : `${Math.round(ms / 86400_000)} d ago`;

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
const filePicker = html`<div class="row"><label class="muted">Files (optional, up to 5 of 10 MB: images, PDF, text or Office documents)
  <input type="file" name="files" accept="${ACCEPT}" multiple></label></div>`;

function reqLine(r: ReqRow): Html {
  return html`<div><span class="status">${r.status}</span> <strong>#${r.id}</strong> <span class="muted">${r.project}</span> ·
    ${r.last_run ? html`<a href="/runs/${r.last_run}">${r.title}</a>` : r.title}</div>
    ${r.status_reason ? html`<div class="muted">${r.status_reason}</div>` : ""}${thumbs(r.files)}`;
}

const action = (id: number, name: string, label: string, cls = "") =>
  html`<form class="inline" method="post" action="/requests/${id}/${name}"><button class="${cls}">${label}</button></form>`;

function needsCard(r: ReqRow): Html {
  let actions: Html = html``;
  switch (r.status) {
    case "needs_info":
      actions = html`<form method="post" action="/requests/${r.id}/answer" enctype="multipart/form-data"><textarea name="text" required placeholder="Your answer"></textarea>
        ${filePicker}<div class="row"><button class="primary">Answer</button></div></form><div class="row">${action(r.id, "cancel", "Cancel", "danger")}</div>`;
      break;
    case "needs_review":
      actions = html`<div class="row">${action(r.id, "approve", "Approve", "primary")} ${action(r.id, "reject", "Reject", "danger")}</div>`;
      break;
    case "blocked_pre_push":
      actions = html`<details><summary>Retry with changes</summary><form method="post" action="/requests/${r.id}/retry">
        <textarea name="body">${r.body}</textarea><input type="text" name="done_when" value="${r.done_when ?? ""}" placeholder="Done when">
        <div class="row"><button>Retry edited</button></div></form></details>
        <div class="row">${action(r.id, "retry", "Retry", "primary")} ${action(r.id, "cancel", "Cancel", "danger")}</div>`;
      break;
    case "blocked_post_push":
      actions = html`<div class="row">${action(r.id, "redeploy", "Re-run deploy", "primary")} ${action(r.id, "resolve", "Mark resolved")}</div>`;
      break;
  }
  return html`<div class="card">${reqLine(r)}${actions}</div>`;
}

export function homePage(d: HomeData, user: User, flash?: string): string {
  const needsYou = [
    ...(d.paused ? [html`<div class="card"><div class="warn">Runner paused: ${d.paused}</div>
      <div class="row"><form method="post" action="/runner/resume"><button class="primary">Resume</button></form></div></div>`] : []),
    ...d.groupLocks.map((g) => html`<div class="card"><div class="warn">Deploy group ${g.name} is blocked: ${g.lock_reason}</div>
      <div class="row"><form method="post" action="/groups/${g.name}/unblock"><button>Unblock</button></form></div></div>`),
    ...(d.backupStale ? [html`<div class="card warn">No backup for ${d.backupAgeMs === null ? "ever" : ago(d.backupAgeMs)}.</div>`] : []),
    ...d.needs.map(needsCard),
  ];
  return page("Home", html`
${flash ? html`<div class="card bad">${flash}</div>` : ""}
<div class="muted">${d.runnerAlive ? "Runner online" : html`<span class="warn">Runner offline</span>`} ·
  ${d.queue.length} in queue · backup ${d.backupAgeMs === null ? "never" : ago(d.backupAgeMs)}</div>

<h2>New request</h2>
<form method="post" action="/requests" class="card" enctype="multipart/form-data">
  <details class="combo"><summary>Projects: <span data-picked>choose one or more</span></summary>
    ${d.projects.map((p) => html`<label><input type="checkbox" name="project" value="${p.name}">${p.name}</label>`)}</details>
  <div class="row"><input type="text" name="title" required maxlength="200" placeholder="What should change?"></div>
  <div class="row"><textarea name="body" placeholder="Details (optional)"></textarea></div>
  <div class="row"><input type="text" name="done_when" placeholder="Done when (optional)"></div>
  <div class="row"><input type="text" name="done_when_test" placeholder="Done-when test name (optional)"></div>
  ${filePicker}
  <div class="row"><button class="primary">Queue it</button></div>
</form>

<h2>Needs you (${needsYou.length})</h2>
${needsYou.length ? needsYou : html`<div class="muted">Nothing.</div>`}

<h2>Queue</h2>
${d.queue.length ? d.queue.map((r) => html`<div class="card">${reqLine(r)}</div>`) : html`<div class="muted">Empty.</div>`}

<h2>Recently finished</h2>
${d.recent.map((r) => html`<div class="card">${reqLine(r)}${r.status === "done" ? html`<details><summary>Reopen</summary>
  <form method="post" action="/requests/${r.id}/reopen"><textarea name="text" required placeholder="What's wrong?"></textarea>
  <div class="row"><button>Reopen</button></div></form></details>` : ""}</div>`)}
`, user, html`<script src="/static/home.js" defer></script>`);
}

export type StepRow = { n: number; step: string; exit_code: number | null; started_at: number; ended_at: number | null };
export type RunData = {
  run: { id: number; status: string; attempt: number; branch: string | null; current_step: string | null; flags: string; commit_sha: string | null; push_state: string };
  req: { id: number; title: string; status: string; status_reason: string | null; project: string; files: string };
  steps: StepRow[]; log: string; logStep: number | null; diffStat: string; diff: string; diffCut: boolean; recipe: string;
};

export function logBlock(runId: number, n: number | null, log: string, live: boolean): Html {
  const poll = live ? html` hx-get="/runs/${runId}/log${n ? html`?n=${n}` : ""}" hx-trigger="every 2s" hx-swap="outerHTML"` : html``;
  return html`<pre id="log"${poll}>${log || "(no output yet)"}</pre>`;
}

export function runPage(d: RunData, user: User): string {
  const live = d.run.status === "running";
  const flags = (JSON.parse(d.run.flags || "[]") as { kind: string; path: string; detail?: string }[]);
  return page(`Run ${d.run.id}`, html`
<div class="card"><span class="status">${d.req.status}</span> <strong>#${d.req.id}</strong> <span class="muted">${d.req.project}</span> · ${d.req.title}
  ${d.req.status_reason ? html`<div class="muted">${d.req.status_reason}</div>` : ""}${thumbs(d.req.files)}
  <div class="muted">Run ${d.run.id} · attempt ${d.run.attempt} · ${d.run.branch ?? ""} · ${d.run.status}${d.run.current_step ? ` (${d.run.current_step})` : ""}
  ${d.run.commit_sha ? html` · commit ${d.run.commit_sha.slice(0, 7)} (${d.run.push_state})` : ""}</div></div>

<h2>Steps</h2>
<table><tr><th>#</th><th>Step</th><th>Exit</th><th>Time</th></tr>
${d.steps.map((s) => html`<tr><td>${s.n}</td><td><a href="/runs/${d.run.id}?n=${s.n}">${s.step}</a></td>
  <td class="${s.exit_code === 0 ? "ok" : s.exit_code === null ? "" : "bad"}">${s.exit_code ?? "…"}</td>
  <td>${s.ended_at ? `${Math.round((s.ended_at - s.started_at) / 1000)} s` : "running"}</td></tr>`)}
</table>

<h2>Log${d.logStep ? ` (step ${d.logStep})` : ""}</h2>
${logBlock(d.run.id, d.logStep, d.log, live)}

${flags.length ? html`<h2>Flags</h2>${flags.map((f) => html`<div>⚑ ${f.kind}: ${f.path}${f.detail ? ` (${f.detail})` : ""}</div>`)}` : ""}

<h2>Diff</h2>
${d.diffStat ? html`<pre>${d.diffStat}</pre><details><summary>Full diff${d.diffCut ? " (cut)" : ""}</summary><pre>${d.diff}</pre></details>` : html`<div class="muted">No commit yet.</div>`}

<h2>Recipe (read-only)</h2>
<pre>${d.recipe}</pre>
`, user, live ? html`<script src="/static/htmx.js"></script>` : html``);
}

export type SettingsData = {
  workers: number; maxWorkers: number; suggested: number; cores: number; memoryGb: number; windows: boolean;
  paused: string | null;
  verified: boolean; // the session's passkey was checked recently: owners may change settings
  projects: { name: string; deploy_group: string; enabled: number }[];
  users: { name: string; role: string; passkeys: number; last_used: number | null }[];
};
// A one-time registration link just made for a user, shown once.
export type NewLink = { name: string; url: string };

// Owners change settings after a recent passkey check (pausing needs none); everyone else sees them read-only.
export function settingsPage(d: SettingsData, user: User, link?: NewLink): string {
  const owner = user.role === "owner";
  const off = owner && d.verified ? html`` : html` disabled`;
  const post = (action: string, label: string, cls = "") =>
    html`<form class="inline" method="post" action="${action}"><button class="${cls}"${off}>${label}</button></form>`;
  const userPath = (name: string, verb: string) => `/settings/users/${encodeURIComponent(name)}/${verb}`;
  return page("Settings", html`
${!owner ? html`<div class="card muted">Only an owner can change settings.</div>`
  : d.verified ? html`<div class="muted">Passkey confirmed: you can change settings for a few minutes.</div>`
  : html`<div class="card"><div>Changing settings needs a fresh check of your passkey.</div>
    <div class="row"><button class="primary" id="step-up">Confirm with passkey</button></div><p id="msg" class="bad"></p></div>`}
${link ? html`<div class="card"><div class="ok">Open this link on the device that will hold ${link.name}'s passkey. It works once, for 30 minutes:</div>
  <pre>${link.url}</pre></div>` : ""}

<h2>Runner</h2>
<div class="card">${d.paused
  ? html`<span class="warn">Paused: ${d.paused}</span><div class="row"><form method="post" action="/runner/resume"><button class="primary">Resume</button></form></div>`
  : html`Running new requests.${owner ? html`<div class="row"><form method="post" action="/settings/pause"><button>Pause</button></form>
    <span class="muted">Requests already running finish.</span></div>` : ""}`}</div>
<form method="post" action="/settings" class="card">
  <label for="workers"><strong>Workers</strong></label>
  <div class="muted">How many requests the runner works on at once. Pushes and deploys still go one at a time for each deploy group.</div>
  <div class="row"><input type="number" id="workers" name="workers" min="1" max="${d.maxWorkers}" step="1" value="${d.workers}" required${off}></div>
  <div class="row muted">Suggested for this machine: ${d.suggested} (${d.cores} CPU cores, ${d.memoryGb} GB of memory: one worker for every 4 cores and every 8 GB).</div>
  ${d.workers > d.suggested ? html`<div class="row warn">${d.workers} workers is more than this machine suits. Builds and tests will slow each other down,
    and every worker uses the same Claude account, so runs may hit its rate limits.</div>` : ""}
  ${d.windows && d.workers > 1 ? html`<div class="row warn">On Windows every worker runs as the one AgentrySandbox user, so one request's agent can
    reach the files of the others running at the same time.</div>` : ""}
  ${owner ? html`<div class="row"><button class="primary"${off}>Save</button></div>` : ""}
</form>

<h2>Projects</h2>
<div class="card"><div class="muted">A disabled project's requests wait in the queue until it is enabled again.</div>
<table><tr><th>Project</th><th>Deploy group</th><th></th></tr>
${d.projects.map((p) => html`<tr><td>${p.name}${p.enabled ? "" : html` <span class="warn">(disabled)</span>`}</td><td>${p.deploy_group}</td>
  <td>${owner ? post(`/settings/projects/${encodeURIComponent(p.name)}/${p.enabled ? "disable" : "enable"}`, p.enabled ? "Disable" : "Enable") : ""}</td></tr>`)}
</table></div>

<h2>Users</h2>
<div class="card"><table><tr><th>User</th><th>Role</th><th>Passkeys</th><th>Last sign-in</th></tr>
${d.users.map((u) => html`<tr><td>${u.name}${u.name === user.name ? html` <span class="muted">(you)</span>` : ""}</td><td>${u.role}</td><td>${u.passkeys}</td>
  <td>${u.last_used ? ago(Date.now() - u.last_used) : "never"}</td></tr>
  ${owner && u.name !== user.name ? html`<tr><td colspan="4"><details><summary>Change ${u.name}</summary><div class="row">
    ${post(userPath(u.name, "reset"), "Reset passkeys")} ${post(userPath(u.name, "remove"), `Remove ${u.name}`, "danger")}</div>
    <div class="muted">Reset signs ${u.name} out everywhere and makes a new one-time link.</div></details></td></tr>` : ""}`)}
</table>
${owner ? html`<form method="post" action="/settings/users"><div class="row"><input type="text" name="name" required maxlength="32" placeholder="New user's name"${off}></div>
  <div class="row"><select name="role"${off}><option value="admin">admin</option><option value="owner">owner</option></select></div>
  <div class="row"><button${off}>Add user</button></div></form>` : ""}
</div>
`, user, html`<script src="/static/webauthn.js"></script><script src="/static/app.js"></script>`);
}

export function loginPage(message?: string): string {
  return page("Sign in", html`
<div class="card"><p>Sign in with your passkey.</p>
<div class="row"><button class="primary" id="login">Sign in</button></div>
<p id="msg" class="bad">${message ?? ""}</p></div>
<script src="/static/webauthn.js"></script><script src="/static/app.js"></script>`);
}

export function registerPage(code: string, name: string): string {
  return page("Set up passkey", html`
<div class="card"><p>Create a passkey for <strong>${name}</strong> on this device.</p>
<div class="row"><button class="primary" id="register" data-code="${code}">Create passkey</button></div>
<p id="msg" class="bad"></p></div>
<script src="/static/webauthn.js"></script><script src="/static/app.js"></script>`);
}

export function messagePage(title: string, message: string, user?: User | null): string {
  return page(title, html`<div class="card">${message}</div><p><a href="/">Back</a></p>`, user);
}

// The home page's project picker (served as /static/home.js): the summary names the ticked projects, and the
// form isn't sent with none.
export const HOME_JS = `
for (const combo of document.querySelectorAll("details.combo")) {
  const picked = () => [...combo.querySelectorAll("input:checked")].map((i) => i.value);
  const show = () => { combo.querySelector("[data-picked]").textContent = picked().join(", ") || "choose one or more"; };
  combo.addEventListener("change", show);
  combo.closest("form").addEventListener("submit", (e) => { if (!picked().length) { e.preventDefault(); combo.open = true; } });
  show();
}
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
