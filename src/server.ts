// The web UI and its HTTP routes (winhost design "Server"). Listens on 127.0.0.1 only; on winhost, Caddy is the
// way in (agentry.example.com, basic auth in front). Every request is checked in this order:
//
//   Host in the allowlist (public name, localhost) ─► /api/runner/* (a runner key, remote.ts)
//     ─► static files and sign-in routes ─► session cookie (passkey sign-in) ─► POST: Origin must be ours ─► route ─► actions.ts
//
// The Host check stops DNS rebinding, the Origin check and SameSite=Strict stop cross-site forms (slice 2
// review D9). Request state changes only through src/actions.ts, the same code the CLI runs, with the user
// recorded as the actor on every audit event.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { availableParallelism, hostname, totalmem } from "node:os";
import { join } from "node:path";
import * as A from "./actions.ts";
import { attachment, attachmentFile, checkUploads, MAX_FILE_BYTES, MAX_FILES_PER_REQUEST, saveUploads, type Upload } from "./attachments.ts";
import {
  addUser, AuthError, endSession, finishLogin, finishRegistration, finishStepUp, LoginThrottle, loginOptions, recentlyVerified,
  registrationOptions, registrationUser, relyingParty, removeUser, resetUser, SESSION_TTL_MS, sessionUser, stepUpOptions, type User,
} from "./accounts.ts";
import { lastBackupAt, STALE_AFTER_MS } from "./backup.ts";
import { asActor, logEvent, runnerRow } from "./db.ts";
import { choicesFor } from "./devices.ts";
import * as g from "./git.ts";
import { suggestedWorkers } from "./platform.ts";
import { readTail } from "./proc.ts";
import { parseRecipe } from "./recipe.ts";
import { readAttached, runnerApi, storedDiff } from "./remote.ts";
import { LOCAL, waitOf, waitText, type Wait } from "./routing.ts";
import { MAX_DIFF_CHARS } from "./verifier.ts";
import {
  APP_JS, board, HOME_JS, homePage, liveBlock, loginPage, messagePage, offlinePage, OFFLINE_JS, queueLine, registerPage, RUN_JS, runPage,
  settingsPage, statusBar, SW_JS, type Draft, type Flash, type GroupLock, type Live, type ReqRow, type RunnerInfo, type StepRow,
} from "./views.ts";

export const DEFAULT_PORT = 4747;
const LOG_TAIL_BYTES = 64 * 1024;
// The names of request r's projects, comma-separated.
const PROJECT_NAMES = `(SELECT group_concat(p.name, ', ') FROM request_projects rp JOIN projects p ON p.id = rp.project_id WHERE rp.request_id = r.id)`;
const SESSION_COOKIE = "agentry_session";
const LOGIN_COOKIE = "agentry_login";
const STEP_UP_COOKIE = "agentry_step_up";

export type ServerOptions = { db: Database; home: string; port?: number; publicUrl?: string };

const modules = join(import.meta.dir, "..", "node_modules");
const assets = join(import.meta.dir, "..", "static");
const STATIC: Record<string, { path?: string; body?: string; type: string }> = {
  "/static/htmx.js": { path: join(modules, "htmx.org", "dist", "htmx.min.js"), type: "text/javascript" },
  "/static/webauthn.js": { path: join(modules, "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js"), type: "text/javascript" },
  "/static/app.js": { body: APP_JS, type: "text/javascript" },
  "/static/home.js": { body: HOME_JS, type: "text/javascript" },
  "/static/run.js": { body: RUN_JS, type: "text/javascript" },
  "/static/offline.js": { body: OFFLINE_JS, type: "text/javascript" },
  "/sw.js": { body: SW_JS, type: "text/javascript" },
  "/static/icon.png": { path: join(assets, "icon.png"), type: "image/png" },
  "/static/apple-touch-icon.png": { path: join(assets, "apple-touch-icon.png"), type: "image/png" },  // iOS home screen
  "/static/archivo.woff2": { path: join(assets, "archivo.woff2"), type: "font/woff2" },              // OFL, static/archivo-OFL.txt
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

// This machine's system, for its runner's plate; an attached runner doesn't report its own.
const OS = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

export function startServer(o: ServerOptions) {
  const throttle = new LoginThrottle();
  let publicUrl = o.publicUrl ?? "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port ?? DEFAULT_PORT,
    maxRequestBodySize: (MAX_FILES_PER_REQUEST + 1) * MAX_FILE_BYTES, // the files plus the form's text
    fetch: (req) => handle(req).catch((e) => {
      console.error(e);
      return text(500, "internal error");
    }),
  });
  if (!publicUrl) publicUrl = `http://localhost:${server.port}`;
  const rp = relyingParty(publicUrl);
  const secure = publicUrl.startsWith("https:");
  const local = [`localhost:${server.port}`, `127.0.0.1:${server.port}`];
  const allowedHosts = new Set([new URL(publicUrl).host, ...local]);
  const allowedOrigins = new Set([new URL(publicUrl).origin, ...local.map((h) => `http://${h}`)]);
  const { db } = o;

  const cookie = (name: string, value: string, maxAgeS: number, path = "/") =>
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    if (!allowedHosts.has(host)) return text(421, "unknown host");
    // A runner on another machine authenticates with its key, not a cookie, so the Origin check doesn't apply.
    const api = await runnerApi(db, o.home, req, url);
    if (api) return api;
    if (req.method === "POST" && !allowedOrigins.has(req.headers.get("origin") ?? "")) return text(403, "cross-origin request refused");

    const stat = STATIC[url.pathname];
    if (stat && req.method === "GET") {
      if (stat.body !== undefined) return new Response(stat.body, { headers: { "content-type": stat.type } });
      if (stat.path && existsSync(stat.path)) return new Response(Bun.file(stat.path), { headers: { "content-type": stat.type } });
      return text(404, "not found");
    }

    const cookies = parseCookies(req.headers.get("cookie"));
    const client = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
    const device = (req.headers.get("user-agent") ?? "unknown device").slice(0, 200);

    // Sign-in, registration and the offline page: the only routes without a session.
    if (url.pathname === "/login" && req.method === "GET") return htmlRes(200, loginPage());
    if (url.pathname === "/offline" && req.method === "GET") return htmlRes(200, offlinePage(new URL(publicUrl).host));
    if (url.pathname === "/login/options" && req.method === "POST") {
      if (throttle.blocked(client)) return text(429, "too many failed sign-ins; wait a few minutes");
      const { options, challengeId } = await loginOptions(db, rp);
      return json(options, { "set-cookie": cookie(LOGIN_COOKIE, challengeId, 300, "/login") });
    }
    if (url.pathname === "/login/verify" && req.method === "POST") {
      if (throttle.blocked(client)) return text(429, "too many failed sign-ins; wait a few minutes");
      try {
        const { token } = await finishLogin(db, rp, cookies[LOGIN_COOKIE] ?? "", await req.json(), device);
        return json({}, { "set-cookie": cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000) });
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        logEvent(db, null, "login_failed", { reason: e.message, device }); // so a failed sign-in can be looked into later
        throttle.failed(client);
        return text(401, e.message);
      }
    }
    const reg = url.pathname.match(/^\/register\/([A-Za-z0-9_-]{20,})(\/options|\/verify)?$/);
    if (reg) {
      const [, code, step] = reg;
      try {
        if (!step && req.method === "GET") return htmlRes(200, registerPage(code, registrationUser(db, code)));
        if (step === "/options" && req.method === "POST") return json(await registrationOptions(db, rp, code));
        if (step === "/verify" && req.method === "POST") {
          const token = await finishRegistration(db, rp, code, await req.json(), device);
          return json({}, { "set-cookie": cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000) });
        }
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        return step ? text(400, e.message) : htmlRes(404, messagePage("Registration", e.message));
      }
      return text(405, "method not allowed");
    }

    const user = sessionUser(db, cookies[SESSION_COOKIE]);
    if (!user) return req.method === "GET" ? redirect("/login") : text(401, "sign in first");

    if (url.pathname === "/logout" && req.method === "POST") {
      endSession(db, cookies[SESSION_COOKIE]!);
      return redirect("/login", { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
    }
    if (url.pathname === "/" && req.method === "GET") return htmlRes(200, homePage(homeData(), user, { flash: doneFlash(url.searchParams) }));
    // The home page's live parts (views.ts Live): each poll sends the hash of what its part shows; 204 when unchanged.
    const part = (p: Live) => p.h === url.searchParams.get("h") ? new Response(null, { status: 204, headers: SECURITY_HEADERS }) : htmlRes(200, p.s);
    if (url.pathname === "/live" && req.method === "GET") return part(board(homeData()));
    if (url.pathname === "/live/status" && req.method === "GET") return part(statusBar(homeData()));
    const line = url.pathname.match(/^\/requests\/(\d+)\/line$/);
    if (line && req.method === "GET") {
      const r = homeData().queue.find((q) => q.id === Number(line[1]));
      return r ? part(queueLine(r)) : new Response(null, { status: 204, headers: SECURITY_HEADERS }); // left the queue: /live redraws the lists
    }
    const verified = recentlyVerified(db, cookies[SESSION_COOKIE]);
    if (url.pathname === "/settings" && req.method === "GET") return htmlRes(200, settingsPage(settingsData(verified), user));

    // Step-up: a fresh passkey check of the signed-in user, which settings changes need (accounts.ts).
    if (url.pathname === "/step-up/options" && req.method === "POST") {
      const { options, challengeId } = await stepUpOptions(db, rp, user.id);
      return json(options, { "set-cookie": cookie(STEP_UP_COOKIE, challengeId, 300, "/step-up") });
    }
    if (url.pathname === "/step-up/verify" && req.method === "POST") {
      if (throttle.blocked(client)) return text(429, "too many failed sign-ins; wait a few minutes");
      try {
        await finishStepUp(db, rp, cookies[SESSION_COOKIE]!, cookies[STEP_UP_COOKIE] ?? "", await req.json());
        return json({});
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        logEvent(db, null, "step_up_failed", { user: user.name, reason: e.message, device });
        throttle.failed(client);
        return text(401, e.message);
      }
    }

    // A run's page, or (/live) the part of it that refreshes while the run runs.
    const run = url.pathname.match(/^\/runs\/(\d+)(\/live)?$/);
    if (run && req.method === "GET") {
      const data = await runData(Number(run[1]), Number(url.searchParams.get("n")) || null);
      if (!data) return htmlRes(404, messagePage("No such run", "There is no run with that number.", user));
      if (run[2]) return htmlRes(200, liveBlock(data).s);
      return htmlRes(200, runPage(data, user));
    }

    // An attached file, signed in only. Served so it can never act as a page: its sniffed type (text always as plain
    // text), nosniff, and a sandboxing CSP. Images and text show in the browser; PDF and Office files download.
    const att = url.pathname.match(/^\/attachments\/(\d+)$/);
    if (att && req.method === "GET") {
      const a = attachment(db, Number(att[1]));
      const file = a && attachmentFile(o.home, a);
      if (!a || !file || !existsSync(file)) return text(404, "not found");
      const plain = a.mime === "text/plain";
      const inline = plain || a.mime.startsWith("image/");
      return new Response(Bun.file(file), { headers: {
        ...SECURITY_HEADERS, "content-type": plain ? "text/plain; charset=utf-8" : a.mime, "content-security-policy": "default-src 'none'; sandbox",
        "content-disposition": inline ? "inline" : `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`, "cache-control": "private, max-age=86400",
      } });
    }

    if (req.method === "POST") {
      const isForm = /^(application\/x-www-form-urlencoded|multipart\/form-data)/.test(req.headers.get("content-type") ?? "");
      const form = isForm ? await req.formData() : new FormData();
      return act(url.pathname, form, await uploadsOf(form), user, verified);
    }
    return text(404, "not found");
  }

  // `verified`: the session's passkey was checked recently, which every settings change but a pause needs.
  function act(path: string, form: FormData, uploads: Upload[], user: User, verified: boolean): Response {
    const field = (k: string) => { const v = form.get(k); return typeof v === "string" ? v : undefined; };
    const optional = (k: string) => { const v = field(k)?.trim(); return v ? v : null; };
    // What was done, for the confirmation on the home page (doneFlash).
    const done: { verb?: string; id?: number; from?: number } = {};
    try {
      const shown = asActor(`user:${user.name}`, (): Response | void => {
        if (path === "/requests") {
          const attached = readAttached(o.home);
          if (attached) throw new A.ActionError(`this machine's runner works the queue at ${attached.url}: file the request there`);
          const types = checkUploads(db, null, uploads);
          db.transaction(() => {
            const id = A.addRequest(db, {
              projects: form.getAll("project").filter((v): v is string => typeof v === "string"), title: field("title") ?? "", body: field("body") ?? "",
              doneWhen: optional("done_when"), doneWhenTest: optional("done_when_test"), agent: optional("ai_agent"), deployTo: deployPicks(form),
            });
            saveUploads(db, o.home, id, uploads, types);
            Object.assign(done, { verb: "added", id });
          })();
          return;
        }
        if (path === "/runner/resume") { A.resume(db); done.verb = "resumed"; return; }
        if (path === "/settings" || path.startsWith("/settings/")) return changeSettings(path, field, deployPicks(form), user, verified);
        const grp = path.match(/^\/groups\/([^/]+)\/unblock$/);
        if (grp) { A.unblock(db, decodeURIComponent(grp[1])); done.verb = "unblocked"; return; }
        const m = path.match(/^\/requests\/(\d+)\/(answer|approve|reject|retry|cancel|redeploy|resolve|reopen)$/);
        if (!m) throw new A.ActionError("no such action", "not_found");
        const id = Number(m[1]);
        Object.assign(done, { verb: m[2], id });
        switch (m[2]) {
          case "answer": {
            const types = checkUploads(db, id, uploads);
            db.transaction(() => { A.answer(db, id, field("text") ?? ""); saveUploads(db, o.home, id, uploads, types); })();
            return;
          }
          case "approve": return A.approve(db, id);
          case "reject": return A.reject(db, id);
          case "retry": return A.retry(db, id, form.has("body") ? { body: field("body"), doneWhen: optional("done_when") } : {});
          case "cancel": return A.cancel(db, id);
          case "redeploy": return A.requestRedeploy(db, id);
          case "resolve": return A.resolve(db, id);
          case "reopen": { Object.assign(done, { id: A.reopen(db, id, field("text") ?? ""), from: id }); return; }
        }
      });
      if (shown) return shown;
    } catch (e) {
      if (!(e instanceof AuthError) && !(e instanceof A.ActionError)) throw e;
      const status = e instanceof A.ActionError ? { not_found: 404, invalid: 400, forbidden: 403, wrong_state: 409 }[e.kind] : 400;
      // A refused new request comes back in its form with the reason, so nothing typed is lost.
      if (path === "/requests") {
        const data = homeData();
        const draft: Draft = {
          projects: form.getAll("project").filter((v): v is string => typeof v === "string"), title: field("title") ?? "", body: field("body") ?? "",
          done_when: field("done_when") ?? "", done_when_test: field("done_when_test") ?? "", ai_agent: field("ai_agent") ?? "", deploy_to: deployPicks(form), hadFiles: uploads.length > 0,
        };
        return htmlRes(status, homePage(data, user, data.attachedTo ? { flash: { kind: "bad", text: e.message } } : { draft, error: e.message }));
      }
      return htmlRes(status, messagePage("Not done", e.message, user));
    }
    if (path.startsWith("/settings")) return redirect("/settings");
    return redirect(done.verb ? `/?done=${done.verb}${done.id ? `&id=${done.id}` : ""}${done.from ? `&from=${done.from}` : ""}` : "/");
  }

  // The confirmation for `?done=<verb>&id=<n>`: fixed sentences, so a link can't put words on the page.
  function doneFlash(q: URLSearchParams): Flash | undefined {
    const id = Number(q.get("id")), from = Number(q.get("from"));
    const said: Record<string, string> = {
      added: `#${id} is queued.`, answer: `#${id} answered. It's back in the queue.`, approve: `#${id} approved. It goes on from the build.`,
      reject: `#${id} rejected and canceled.`, retry: `#${id} is queued for another try.`, cancel: `#${id} canceled.`,
      redeploy: `The deploy of #${id} is queued. The runner starts it next.`, resolve: `#${id} marked resolved.`,
      reopen: `#${from} reopened as #${id}.`, resumed: "The runner resumed.", unblocked: "Deploy group unblocked.",
    };
    const verb = q.get("done") ?? "";
    if (!Object.hasOwn(said, verb) || !Number.isInteger(id) || !Number.isInteger(from)) return undefined;
    return { kind: "ok", text: said[verb] };
  }

  // The settings page's changes: owners only, and all but a pause after a recent passkey check. Adding a user or
  // resetting one shows the new one-time registration link; Deploy main goes to the home page with the new request;
  // everything else goes back to the page.
  function changeSettings(path: string, field: (k: string) => string | undefined, picks: Record<string, string[]>, user: User, verified: boolean): Response | void {
    if (user.role !== "owner") throw new A.ActionError("Only an owner can change settings.", "forbidden");
    const attached = readAttached(o.home);
    if (attached && (path === "/settings/pause" || path === "/settings")) {
      throw new A.ActionError(`This machine's runner works the queue at ${attached.url}, so the runner settings there apply: change them there.`);
    }
    if (path === "/settings/pause") return A.pause(db, `paused by ${user.name}`);
    if (!verified) throw new A.ActionError("Confirm with your passkey first: the button at the top of the settings page.", "forbidden");
    if (path === "/settings") return db.transaction(() => {
      A.setWorkers(db, Number(field("workers")));
      if (field("ai_agent") !== undefined) A.setAgent(db, field("ai_agent")!);
    })();
    const project = path.match(/^\/settings\/projects\/([^/]+)\/(enable|disable|deploy)$/);
    if (project?.[2] === "deploy") {
      if (attached) throw new A.ActionError(`This machine's runner works the queue at ${attached.url}: deploy from there.`);
      const name = decodeURIComponent(project[1]);
      return redirect(`/?done=added&id=${A.deployMain(db, name, picks[name])}`);
    }
    if (project) return A.setProjectEnabled(db, decodeURIComponent(project[1]), project[2] === "enable");
    const linkFor = (name: string, code: string): Response =>
      htmlRes(200, settingsPage(settingsData(verified), user, { name, url: `${publicUrl}/register/${code}` }), { "cache-control": "no-store" });
    if (path === "/settings/users") {
      const name = field("name")?.trim() ?? "";
      return linkFor(name, addUser(db, name, field("role") === "owner" ? "owner" : "admin"));
    }
    const account = path.match(/^\/settings\/users\/([^/]+)\/(reset|remove)$/);
    if (!account) throw new A.ActionError("no such setting", "not_found");
    const name = decodeURIComponent(account[1]);
    if (name === user.name) throw new A.ActionError(`Your own account can't be changed here: use \`agentry user ${account[2]} ${name}\` on the server's machine.`, "invalid");
    if (account[2] === "reset") return linkFor(name, resetUser(db, name));
    removeUser(db, name);
  }

  function settingsData(verified: boolean) {
    const cores = availableParallelism();
    const memory = totalmem();
    const runner = runnerRow(db);
    return {
      aiAgent: runner.ai_agent, workers: runner.workers, maxWorkers: A.MAX_WORKERS, suggested: suggestedWorkers(cores, memory), cores,
      memoryGb: Math.round(memory / 2 ** 30), windows: process.platform === "win32",
      paused: runner.paused ? runner.pause_reason ?? "paused" : null, verified,
      projects: (db.query(`SELECT p.name, g.name AS deploy_group, p.enabled FROM projects p JOIN deploy_groups g ON g.id = p.deploy_group_id
        ORDER BY p.name`).all() as { name: string; deploy_group: string; enabled: number }[]).map((p) => ({ ...p, deployTo: choicesFor(db, [p.name])[p.name] ?? [] })),
      users: db.query(`SELECT u.name, u.role, COUNT(c.id) AS passkeys, MAX(c.last_used_at) AS last_used FROM users u
        LEFT JOIN credentials c ON c.user_id = u.id GROUP BY u.id ORDER BY u.name`).all() as
        { name: string; role: string; passkeys: number; last_used: number | null }[],
      attachedTo: readAttached(o.home)?.url ?? null,
    };
  }

  // Requests as the pages show them, with what their actions need: the last commit made, the deploy groups, the
  // runner that has it and the check flags of its latest run.
  const rows = (where: string, order = "r.id", ...args: number[]) => db.query(`SELECT r.id, ${PROJECT_NAMES} AS project, r.title, r.status,
    r.status_reason, r.updated_at, r.body, r.done_when, r.holder, r.ai_agent, r.deploy_to, (SELECT MAX(id) FROM runs WHERE request_id = r.id) AS last_run,
    (SELECT json_group_array(json_object('id', id, 'name', name, 'mime', mime)) FROM (SELECT id, name, mime FROM attachments WHERE request_id = r.id ORDER BY id)) AS files,
    (SELECT commit_sha FROM runs WHERE request_id = r.id AND commit_sha IS NOT NULL ORDER BY id DESC LIMIT 1) AS commit_sha,
    (SELECT group_concat(DISTINCT g.name) FROM request_projects rp JOIN projects p ON p.id = rp.project_id
      JOIN deploy_groups g ON g.id = p.deploy_group_id WHERE rp.request_id = r.id) AS groups,
    (SELECT json_array_length(flags) FROM runs WHERE request_id = r.id ORDER BY id DESC LIMIT 1) AS flag_count,
    (SELECT json_group_array(json_array(step, exit_code)) FROM (SELECT step, exit_code FROM steps
      WHERE run_id = (SELECT MAX(id) FROM runs WHERE request_id = r.id) ORDER BY id)) AS track
    FROM requests r WHERE ${where} ORDER BY ${order}`).all(...args) as (ReqRow & { holder: string | null })[];

  // A runner as the pages name it: this machine's by its host, an attached one by its runner key.
  const leaseHosts = () => new Map((db.query("SELECT holder, host, expires_at FROM leases").all() as
    { holder: string; host: string | null; expires_at: number }[]).map((l) => [l.holder, l]));
  const nameOf = (holder: string, leases = leaseHosts()) => holder === LOCAL ? leases.get(LOCAL)?.host ?? hostname() : holder;

  // The queue's runners: this machine's and every runner key's, each online while its lease is live, with what it
  // works on and how many queued requests wait for it.
  function runners(waitingFor: Map<string, number>, now = Date.now()): RunnerInfo[] {
    const leases = leaseHosts();
    const slots = runnerRow(db).workers;
    const working = db.query(`SELECT r.id, r.title, r.holder, ru.id AS run, ru.current_step AS step FROM requests r
      LEFT JOIN runs ru ON ru.id = (SELECT MAX(id) FROM runs WHERE request_id = r.id AND status = 'running')
      WHERE r.status = 'running' AND r.holder IS NOT NULL ORDER BY r.id`).all() as
      { id: number; title: string; holder: string; run: number | null; step: string | null }[];
    const keys = (db.query("SELECT name FROM runner_keys ORDER BY name").all() as { name: string }[]).map((k) => k.name);
    return [LOCAL, ...keys].map((h) => {
      const l = leases.get(h);
      const mine = working.filter((w) => w.holder === h).map(({ id, title, run, step }) => ({ id, title, run, step }));
      return { name: nameOf(h, leases), local: h === LOCAL, online: !!l && l.expires_at > now, running: mine.length, working: mine, waiting: waitingFor.get(h) ?? 0,
        slots: h === LOCAL ? slots : null, os: h === LOCAL ? OS : null };
    });
  }

  function homeData() {
    const runner = runnerRow(db);
    const last = lastBackupAt(db);
    const leases = leaseHosts();
    // A queued request says why it waits, when its runner can't take it now; a running one, which runner has it.
    const waits = new Map<number, Wait>();
    const queue = rows("r.status IN ('queued', 'running')", "r.status DESC, r.priority DESC, r.created_at").map((r) => {
      if (r.status === "running") return { ...r, runner: r.holder ? nameOf(r.holder, leases) : null };
      const w = waitOf(db, r.id);
      if (w) waits.set(r.id, w);
      return { ...r, waiting: w ? waitText(w) : null };
    });
    // Runner problems that hold queued requests, as alerts: the request lines alone read like ordinary queueing.
    const waitingFor = new Map<string, number>();
    const problems = new Map<string, number>();
    for (const w of waits.values()) {
      if (w.kind !== "no-runner") waitingFor.set(w.holder, (waitingFor.get(w.holder) ?? 0) + 1);
      const name = w.kind === "no-runner" ? "" : w.holder === LOCAL ? "This machine's runner" : w.holder;
      const text = w.kind === "offline" ? `${name} is offline` : w.kind === "not-allowed" ? `${name} may no longer run the projects it was given`
        : w.kind === "no-recipe" ? `${name} has no recipe for ${w.projects.join(", ")}` : "No runner may run all of their projects";
      problems.set(text, (problems.get(text) ?? 0) + 1);
    }
    const runnerAlerts = [...problems].map(([text, n]) => `${text}: ${n} request${n > 1 ? "s wait" : " waits"}.`);
    const projects = db.query("SELECT name FROM projects WHERE enabled = 1 ORDER BY name").all() as { name: string }[];
    return {
      projects, deployTo: Object.assign({}, ...projects.map((p) => choicesFor(db, [p.name]))),
      needs: rows("r.status IN ('needs_info', 'needs_review', 'blocked_pre_push', 'blocked_post_push')", "r.updated_at"),
      queue,
      recent: rows("r.status IN ('done', 'done_manual', 'canceled')", "r.updated_at DESC LIMIT 10"),
      groupLocks: db.query("SELECT name, lock_reason FROM deploy_groups WHERE lock = 'blocked' AND locked_by_request IS NULL").all() as GroupLock[],
      paused: runner.paused ? runner.pause_reason ?? "paused" : null, aiAgent: runner.ai_agent,
      runners: runners(waitingFor),
      runnerAlerts,
      backupAgeMs: last === null ? null : Date.now() - last,
      backupStale: last === null || Date.now() - last > STALE_AFTER_MS,
      attachedTo: readAttached(o.home)?.url ?? null,
    };
  }

  async function runData(id: number, n: number | null) {
    const run = db.query(`SELECT id, request_id, status, attempt, branch, current_step, flags, commit_sha, candidate_sha, base_sha, push_state, holder
      FROM runs WHERE id = ?`).get(id) as any;
    if (!run) return null;
    const req = db.query(`SELECT r.id, r.title, r.status, r.status_reason, ${PROJECT_NAMES} AS project, p.recipe,
      (SELECT json_group_array(json_object('id', id, 'name', name, 'mime', mime)) FROM (SELECT id, name, mime FROM attachments WHERE request_id = r.id ORDER BY id)) AS files FROM requests r
      JOIN projects p ON p.id = r.project_id WHERE r.id = ?`).get(run.request_id) as any;
    const recipes = db.query(`SELECT p.name, p.recipe FROM request_projects rp JOIN projects p ON p.id = rp.project_id
      WHERE rp.request_id = ? ORDER BY p.id`).all(run.request_id) as { name: string; recipe: string }[];
    const steps = (db.query("SELECT step, exit_code, started_at, ended_at, log_path FROM steps WHERE run_id = ? ORDER BY id").all(id) as
      (Omit<StepRow, "n"> & { log_path: string | null })[]).map((s, i) => ({ ...s, n: i + 1 }));
    const chosen = n ? steps.find((s) => s.n === n) : steps.at(-1);
    const log = chosen?.log_path && existsSync(chosen.log_path) ? readTail(chosen.log_path, LOG_TAIL_BYTES) : "";
    const head = run.commit_sha ?? run.candidate_sha;
    let diffStat = "", diff = "", diffCut = false;
    const stored = storedDiff(o.home, id);
    if (stored) ({ stat: diffStat, diff, cut: diffCut } = stored);
    else if (head && run.base_sha) {
      const repo = parseRecipe(req.recipe).repo;
      diffStat = (await g.run(repo, ["diff", "--stat", run.base_sha, head])).out;
      diff = (await g.run(repo, ["diff", "--no-color", run.base_sha, head])).out;
      if (diff.length > MAX_DIFF_CHARS) { diff = diff.slice(0, MAX_DIFF_CHARS); diffCut = true; }
    }
    // A running run of a runner on another machine (agentry attach): its log arrives with each heartbeat.
    const remoteHost = run.status === "running" && run.holder !== LOCAL ? run.holder : null;
    return {
      run, req: rows("r.id = ?", "r.id", req.id)[0], remoteHost, attachedTo: readAttached(o.home)?.url ?? null,
      steps, log, logStep: chosen?.n ?? null, diffStat, diff, diffCut,
      recipe: recipes.map((p) => `${recipes.length > 1 ? `// ${p.name}\n` : ""}${JSON.stringify(JSON.parse(p.recipe), null, 2)}`).join("\n\n"),
    };
  }

  return { server, url: publicUrl, stop: () => server.stop(true) };
}

// A form's Deploy to picks, by project (deploy:<project>). Each project's checkboxes come with an empty marker, so
// none checked reads as no pick, not as the project's defaults.
function deployPicks(form: FormData): Record<string, string[]> {
  const picks: Record<string, string[]> = {};
  for (const [key, value] of form.entries()) {
    const project = key.match(/^deploy:(.+)$/)?.[1];
    if (project && typeof value === "string") (picks[project] ??= []).push(...value ? [value] : []);
  }
  return picks;
}

// The non-empty files of a form's "files" field (a browser sends an empty one when none is chosen).
async function uploadsOf(form: FormData): Promise<Upload[]> {
  const files = form.getAll("files").filter((v): v is File => typeof v !== "string" && v.size > 0);
  return Promise.all(files.map(async (f) => ({ name: f.name || "file", bytes: new Uint8Array(await f.arrayBuffer()) })));
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
const htmlRes = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
const json = (body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extra } });
const redirect = (location: string, extra: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location, ...SECURITY_HEADERS, ...extra } });
