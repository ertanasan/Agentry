// The web UI and its HTTP routes (winhost design "Server"). Listens on 127.0.0.1 only; on winhost, Caddy is the
// way in (agentry.example.com, basic auth in front). Every request is checked in this order:
//
//   Host in the allowlist (public name, localhost) ─► static files and sign-in routes
//     ─► session cookie (passkey sign-in) ─► POST: Origin must be ours ─► route ─► actions.ts
//
// The Host check stops DNS rebinding, the Origin check and SameSite=Strict stop cross-site forms (slice 2
// review D9). Request state changes only through src/actions.ts, the same code the CLI runs, with the user
// recorded as the actor on every audit event.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as A from "./actions.ts";
import {
  AuthError, endSession, finishLogin, finishRegistration, LoginThrottle, loginOptions, registrationOptions, registrationUser,
  relyingParty, SESSION_TTL_MS, sessionUser, type User,
} from "./accounts.ts";
import { lastBackupAt, STALE_AFTER_MS } from "./backup.ts";
import { asActor, runnerRow } from "./db.ts";
import * as g from "./git.ts";
import { readTail } from "./proc.ts";
import { parseRecipe } from "./recipe.ts";
import { MAX_DIFF_CHARS } from "./verifier.ts";
import {
  APP_JS, homePage, loginPage, logBlock, messagePage, registerPage, runPage, type GroupLock, type ReqRow, type StepRow,
} from "./views.ts";

export const DEFAULT_PORT = 4747;
const LOG_TAIL_BYTES = 64 * 1024;
const SESSION_COOKIE = "agentry_session";
const LOGIN_COOKIE = "agentry_login";

export type ServerOptions = { db: Database; home: string; port?: number; publicUrl?: string };

const modules = join(import.meta.dir, "..", "node_modules");
const STATIC: Record<string, { path?: string; body?: string; type: string }> = {
  "/static/htmx.js": { path: join(modules, "htmx.org", "dist", "htmx.min.js"), type: "text/javascript" },
  "/static/webauthn.js": { path: join(modules, "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js"), type: "text/javascript" },
  "/static/app.js": { body: APP_JS, type: "text/javascript" },
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

export function startServer(o: ServerOptions) {
  const throttle = new LoginThrottle();
  let publicUrl = o.publicUrl ?? "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port ?? DEFAULT_PORT,
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

    // Sign-in and registration: the only routes without a session.
    if (url.pathname === "/login" && req.method === "GET") return htmlRes(200, loginPage());
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
    if (url.pathname === "/" && req.method === "GET") return htmlRes(200, homePage(homeData(), user));

    const run = url.pathname.match(/^\/runs\/(\d+)(\/log)?$/);
    if (run && req.method === "GET") {
      const data = await runData(Number(run[1]), Number(url.searchParams.get("n")) || null);
      if (!data) return htmlRes(404, messagePage("Run", "No such run.", user));
      if (run[2]) return htmlRes(200, logBlock(data.run.id, data.logStep, data.log, data.run.status === "running").s);
      return htmlRes(200, runPage(data, user));
    }

    if (req.method === "POST") {
      const isForm = /^(application\/x-www-form-urlencoded|multipart\/form-data)/.test(req.headers.get("content-type") ?? "");
      return act(url.pathname, isForm ? await req.formData() : new FormData(), user);
    }
    return text(404, "not found");
  }

  function act(path: string, form: FormData, user: User): Response {
    const field = (k: string) => { const v = form.get(k); return typeof v === "string" ? v : undefined; };
    const optional = (k: string) => { const v = field(k)?.trim(); return v ? v : null; };
    try {
      asActor(`user:${user.name}`, () => {
        if (path === "/requests") {
          A.addRequest(db, {
            project: field("project") ?? "", title: field("title") ?? "", body: field("body") ?? "",
            doneWhen: optional("done_when"), doneWhenTest: optional("done_when_test"),
          });
          return;
        }
        if (path === "/runner/resume") return A.resume(db);
        const grp = path.match(/^\/groups\/([^/]+)\/unblock$/);
        if (grp) return A.unblock(db, decodeURIComponent(grp[1]));
        const m = path.match(/^\/requests\/(\d+)\/(answer|approve|reject|retry|cancel|redeploy|resolve|reopen)$/);
        if (!m) throw new A.ActionError("no such action", "not_found");
        const id = Number(m[1]);
        switch (m[2]) {
          case "answer": return A.answer(db, id, field("text") ?? "");
          case "approve": return A.approve(db, id);
          case "reject": return A.reject(db, id);
          case "retry": return A.retry(db, id, form.has("body") ? { body: field("body"), doneWhen: optional("done_when") } : {});
          case "cancel": return A.cancel(db, id);
          case "redeploy": return A.requestRedeploy(db, id);
          case "resolve": return A.resolve(db, id);
          case "reopen": { A.reopen(db, id, field("text") ?? ""); return; }
        }
      });
    } catch (e) {
      if (!(e instanceof A.ActionError)) throw e;
      return htmlRes(e.kind === "not_found" ? 404 : e.kind === "invalid" ? 400 : 409, messagePage("Not done", e.message, user));
    }
    return redirect("/");
  }

  function homeData() {
    const rows = (where: string, order = "r.id") => db.query(`SELECT r.id, p.name AS project, r.title, r.status, r.status_reason, r.updated_at,
      r.body, r.done_when, (SELECT MAX(id) FROM runs WHERE request_id = r.id) AS last_run
      FROM requests r JOIN projects p ON p.id = r.project_id WHERE ${where} ORDER BY ${order}`).all() as ReqRow[];
    const runner = runnerRow(db);
    const last = lastBackupAt(db);
    return {
      projects: db.query("SELECT name FROM projects WHERE enabled = 1 ORDER BY name").all() as { name: string }[],
      needs: rows("r.status IN ('needs_info', 'needs_review', 'blocked_pre_push', 'blocked_post_push')", "r.updated_at"),
      queue: rows("r.status IN ('queued', 'running')", "r.status DESC, r.priority DESC, r.created_at"),
      recent: rows("r.status IN ('done', 'done_manual', 'canceled')", "r.updated_at DESC LIMIT 10"),
      groupLocks: db.query("SELECT name, lock_reason FROM deploy_groups WHERE lock = 'blocked' AND locked_by_request IS NULL").all() as GroupLock[],
      paused: runner.paused ? runner.pause_reason ?? "paused" : null,
      runnerAlive: runner.owner_token !== null && runner.lease_expires_at > Date.now(),
      backupAgeMs: last === null ? null : Date.now() - last,
      backupStale: last === null || Date.now() - last > STALE_AFTER_MS,
    };
  }

  async function runData(id: number, n: number | null) {
    const run = db.query(`SELECT id, request_id, status, attempt, branch, current_step, flags, commit_sha, candidate_sha, base_sha, push_state
      FROM runs WHERE id = ?`).get(id) as any;
    if (!run) return null;
    const req = db.query(`SELECT r.id, r.title, r.status, r.status_reason, p.name AS project, p.recipe FROM requests r
      JOIN projects p ON p.id = r.project_id WHERE r.id = ?`).get(run.request_id) as any;
    const steps = (db.query("SELECT step, exit_code, started_at, ended_at, log_path FROM steps WHERE run_id = ? ORDER BY id").all(id) as
      (Omit<StepRow, "n"> & { log_path: string | null })[]).map((s, i) => ({ ...s, n: i + 1 }));
    const chosen = n ? steps.find((s) => s.n === n) : steps.at(-1);
    const log = chosen?.log_path && existsSync(chosen.log_path) ? readTail(chosen.log_path, LOG_TAIL_BYTES) : "";
    const head = run.commit_sha ?? run.candidate_sha;
    let diffStat = "", diff = "", diffCut = false;
    if (head && run.base_sha) {
      const repo = parseRecipe(req.recipe).repo;
      diffStat = (await g.run(repo, ["diff", "--stat", run.base_sha, head])).out;
      diff = (await g.run(repo, ["diff", "--no-color", run.base_sha, head])).out;
      if (diff.length > MAX_DIFF_CHARS) { diff = diff.slice(0, MAX_DIFF_CHARS); diffCut = true; }
    }
    return {
      run, req: { id: req.id, title: req.title, status: req.status, status_reason: req.status_reason, project: req.project },
      steps, log, logStep: chosen?.n ?? null, diffStat, diff, diffCut, recipe: JSON.stringify(JSON.parse(req.recipe), null, 2),
    };
  }

  return { server, url: publicUrl, stop: () => server.stop(true) };
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
const htmlRes = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
const json = (body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extra } });
const redirect = (location: string, extra: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location, ...SECURITY_HEADERS, ...extra } });
