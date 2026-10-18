#!/usr/bin/env bun
// agentry: the slice-1 command line (eng review D3). It reads and writes SQLite (WAL) directly; there is no API.
// State actions follow the design's table and refuse a request that is not in the state they act on.
// `run` is the only executor: it takes the lease (a second runner refuses), runs startup recovery, then works
// the queue, retrying unknown pushes now and then (D19). A runner that loses its lease exits with code 3 (D17).
//
// AGENTRY_HOME (default ~/.agentry) holds agentry.db, worktrees/, runs/, cache/, claude-oauth-token and
// api-key-helper. AGENTRY_CLAUDE_BIN overrides the claude on PATH; AGENTRY_MODEL picks its model.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { claudeAgent, resolveAuth } from "./adapters/claude.ts";
import { acquireLease, LeaseLost, logEvent, openDb, releaseLease, runnerRow, setRequestStatus, startHeartbeat, type RequestStatus } from "./db.ts";
import { parseRecipe } from "./recipe.ts";
import { recover, resolvePushUnknown } from "./recovery.ts";
import { redeploy, runNext, type RunnerCtx } from "./runner.ts";
import { AGENTRY_HOME } from "./sandbox.ts";
import { claudeVerifier } from "./verifier.ts";

const POLL_MS = 5_000;
const RESOLVE_EVERY_MS = 60_000;

const USAGE = `usage: agentry <command>
  project add <name> <recipe.json>
  add <project> <title> [--body B] [--done-when D] [--done-when-test T] [--priority N]
  list [--all]
  run [--once]                       work the queue (--once: stop when idle or paused)
  answer <id> <text>                 needs_info → queued
  approve <id> | reject <id>         needs_review → queued (resumes at build) | canceled
  retry <id> [--body B] [--done-when D] [--done-when-test T]   blocked_pre_push → queued
  cancel <id>
  redeploy <id> | resolve <id>       blocked_post_push → deploy again | done_manual
  reopen <id> <what's wrong>         done → a new linked request (counts one false-done)
  unblock <group>                    clear a deploy group's lock that no request holds (drift guard)
  resume                             unpause the runner
  token                              save a \`claude setup-token\` token for subscription auth (paste, then Ctrl-D)`;

class CliError extends Error {}
const fail = (msg: string): never => { throw new CliError(msg); };

type Req = { id: number; status: RequestStatus; title: string; body: string; project_id: number; done_when: string | null; done_when_test: string | null; deploy_group_id: number };

const home = process.env.AGENTRY_HOME ?? AGENTRY_HOME;

function main(argv: string[]): Promise<number> | number {
  const { values: o, positionals: [cmd, ...args] } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      body: { type: "string" }, "done-when": { type: "string" }, "done-when-test": { type: "string" },
      priority: { type: "string" }, once: { type: "boolean" }, all: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (!cmd || o.help) { console.log(USAGE); return cmd ? 0 : 1; }
  mkdirSync(home, { recursive: true });
  const db = openDb(join(home, "agentry.db"));
  const id = () => Number(args[0]) || fail(`${cmd} needs a request id`);
  const text = (what: string) => args.slice(1).join(" ") || fail(`${cmd} needs ${what}`);

  switch (cmd) {
    case "project": return projectAdd(db, args);
    case "add": return add(db, args, o);
    case "list": return list(db, !!o.all);
    case "run": return run(db, !!o.once);
    case "answer": {
      const answer = text("the answer");
      move(db, id(), ["needs_info"], "queued", null, "answer", { text: answer });
      return 0;
    }
    case "approve": return tx(db, () => {
      const req = move(db, id(), ["needs_review"], "queued", null, "approve");
      const last = db.query("SELECT id FROM runs WHERE request_id = ? ORDER BY id DESC LIMIT 1").get(req.id) as { id: number };
      db.query("UPDATE requests SET resume_run = ? WHERE id = ?").run(last.id, req.id);
    });
    case "reject": move(db, id(), ["needs_review"], "canceled", "rejected", "reject"); return 0;
    case "retry": return tx(db, () => {
      const req = move(db, id(), ["blocked_pre_push"], "queued", null, "retry");
      db.query("UPDATE requests SET body = ?, done_when = ?, done_when_test = ? WHERE id = ?")
        .run(o.body ?? req.body, o["done-when"] ?? req.done_when, o["done-when-test"] ?? req.done_when_test, req.id);
    });
    case "cancel": move(db, id(), ["queued", "needs_info", "needs_review", "blocked_pre_push"], "canceled", "canceled", "cancel"); return 0;
    case "resolve": return tx(db, () => {
      const req = move(db, id(), ["blocked_post_push"], "done_manual", "resolved by hand", "resolve");
      db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, locked_by_request = NULL, undeployed_sha = NULL WHERE id = ? AND locked_by_request = ?")
        .run(req.deploy_group_id, req.id);
    });
    case "redeploy": return redeployCmd(db, id());
    case "reopen": return reopen(db, id(), text("what's wrong"));
    case "unblock": {
      const name = args[0] ?? fail("unblock needs a group name");
      const res = db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, undeployed_sha = NULL WHERE name = ? AND lock = 'blocked' AND locked_by_request IS NULL").run(name);
      if (res.changes !== 1) fail(`group ${name} is not blocked, or a request holds it (use resolve or redeploy on that request)`);
      logEvent(db, null, "unblock", { group: name });
      return 0;
    }
    case "token": return saveToken();
    case "resume": {
      db.query("UPDATE runner SET paused = 0, pause_reason = NULL WHERE id = 1").run();
      logEvent(db, null, "resume");
      return 0;
    }
    default: return fail(`unknown command "${cmd}"\n${USAGE}`);
  }
}

// Runs a state action's writes in one transaction, so the runner never sees half of it.
function tx(db: Database, write: () => void): number {
  db.transaction(write)();
  return 0;
}

// Moves a request from one of `from` to `to` in one transaction, with an event. Refuses any other state.
function move(db: Database, id: number, from: RequestStatus[], to: RequestStatus, reason: string | null, event: string, payload: unknown = null): Req {
  return db.transaction(() => {
    const req = db.query(`SELECT r.id, r.status, r.title, r.body, r.project_id, r.done_when, r.done_when_test, p.deploy_group_id
      FROM requests r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`).get(id) as Req | null;
    if (!req) fail(`no request #${id}`);
    if (!from.includes(req!.status)) fail(`#${id} is ${req!.status}; this needs ${from.join(" or ")}`);
    logEvent(db, id, event, payload);
    setRequestStatus(db, id, to, reason);
    return req!;
  })();
}

function projectAdd(db: Database, args: string[]): number {
  if (args[0] !== "add" || args.length !== 3) fail("usage: agentry project add <name> <recipe.json>");
  const [, name, file] = args;
  const json = readFileSync(file, "utf8");
  const recipe = parseRecipe(json);
  db.transaction(() => {
    db.query("INSERT OR IGNORE INTO repos (name, path) VALUES (?, ?)").run(recipe.repo, recipe.repo);
    db.query("INSERT OR IGNORE INTO deploy_groups (name) VALUES (?)").run(recipe.deploy_group);
    db.query(`INSERT INTO projects (name, repo_id, deploy_group_id, recipe)
      VALUES (?, (SELECT id FROM repos WHERE path = ?), (SELECT id FROM deploy_groups WHERE name = ?), ?)
      ON CONFLICT(name) DO UPDATE SET repo_id = excluded.repo_id, deploy_group_id = excluded.deploy_group_id, recipe = excluded.recipe`)
      .run(name, recipe.repo, recipe.deploy_group, json);
  })();
  console.log(`project ${name}: ${basename(recipe.repo)}, group ${recipe.deploy_group}`);
  return 0;
}

function add(db: Database, args: string[], o: Record<string, string | boolean | undefined>): number {
  const [project, ...title] = args;
  if (!project || !title.length) fail("usage: agentry add <project> <title> [--body B] [--done-when D] [--done-when-test T]");
  const p = db.query("SELECT id FROM projects WHERE name = ?").get(project) as { id: number } | null;
  if (!p) fail(`no project "${project}" (agentry project add)`);
  const now = Date.now();
  const id = Number(db.query(`INSERT INTO requests (project_id, title, body, done_when, done_when_test, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p!.id, title.join(" "), o.body ?? "", o["done-when"] ?? null, o["done-when-test"] ?? null,
    Number(o.priority ?? 0), now, now).lastInsertRowid);
  logEvent(db, id, "add");
  console.log(`#${id} queued`);
  return 0;
}

function list(db: Database, all: boolean): number {
  const rows = db.query(`SELECT r.id, r.status, r.status_reason, r.title, p.name AS project FROM requests r JOIN projects p ON p.id = r.project_id
    ${all ? "" : "WHERE r.status NOT IN ('done', 'done_manual', 'canceled')"} ORDER BY r.id`).all() as
    { id: number; status: string; status_reason: string | null; title: string; project: string }[];
  for (const r of rows) {
    console.log(`#${String(r.id).padEnd(4)} ${r.status.padEnd(18)} ${r.project.padEnd(14)} ${r.title}${r.status_reason ? `  (${r.status_reason})` : ""}`);
  }
  if (!rows.length) console.log(all ? "no requests" : "nothing open (--all shows finished ones)");
  const runner = runnerRow(db);
  if (runner.paused) console.log(`runner paused: ${runner.pause_reason}  (agentry resume)`);
  const groups = db.query("SELECT name, lock_reason, locked_by_request FROM deploy_groups WHERE lock = 'blocked'").all() as
    { name: string; lock_reason: string; locked_by_request: number | null }[];
  for (const g of groups) console.log(`group ${g.name} blocked${g.locked_by_request ? ` by #${g.locked_by_request}` : ""}: ${g.lock_reason}`);
  const falseDone = (db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'reopen'").get() as { n: number }).n;
  console.log(`false-done: ${falseDone}`);
  return 0;
}

// Reads a pasted `claude setup-token` token from stdin, refuses anything else, and saves it with mode 600.
async function saveToken(): Promise<number> {
  if (process.stdin.isTTY) console.log("Paste the token (line breaks are fine), then press Enter and Ctrl-D:");
  const token = (await Bun.stdin.text()).replace(/\s+/g, "");
  if (!/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(token)) fail("that is not a setup-token token (sk-ant-oat01-…); nothing saved");
  const file = join(home, "claude-oauth-token");
  rmSync(file, { recursive: false, force: true });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  console.log(`saved ${token.length} characters to ${file}`);
  return 0;
}

function claudeBin(): string {
  const bin = process.env.AGENTRY_CLAUDE_BIN ?? Bun.which("claude") ?? fail("claude is not on PATH (or set AGENTRY_CLAUDE_BIN)");
  return realpathSync(bin);
}

// Takes the lease for this process, or refuses because another runner holds it.
function lease(db: Database, ctxFor: (token: string) => RunnerCtx): RunnerCtx {
  const token = randomUUID();
  if (!acquireLease(db, token, process.pid)) {
    const r = runnerRow(db);
    fail(`another runner holds the lease (pid ${r.owner_pid}, until ${new Date(r.lease_expires_at).toLocaleTimeString()})`);
  }
  return ctxFor(token);
}

function makeCtx(db: Database, token: string): RunnerCtx {
  const bin = claudeBin();
  const keyHelper = join(home, "api-key-helper");
  const auth = resolveAuth(join(home, "claude-oauth-token"), keyHelper);
  const model = process.env.AGENTRY_MODEL;
  return {
    db, token, home, claudeBin: bin, keyHelper, currentRun: null,
    agent: claudeAgent({ bin, auth, model }), verifier: claudeVerifier({ bin, auth, model }),
  };
}

// Holds the lease and heartbeat around `body`; a runner that loses its lease exits at once (D17).
async function withLease(db: Database, body: (ctx: RunnerCtx) => Promise<void>): Promise<number> {
  const ctx = lease(db, (t) => makeCtx(db, t));
  const stop = startHeartbeat(db, ctx.token, () => ctx.currentRun, () => { console.error("lease lost: another runner took over"); process.exit(3); });
  try {
    await body(ctx);
    return 0;
  } catch (e) {
    if (e instanceof LeaseLost) { console.error(e.message); return 3; }
    throw e;
  } finally {
    stop();
    releaseLease(db, ctx.token);
  }
}

function run(db: Database, once: boolean): Promise<number> {
  return withLease(db, async (ctx) => {
    const rep = await recover(ctx);
    if (rep.killed.length) console.log(`recovery: killed leftover process groups ${rep.killed.join(", ")}`);
    for (const r of rep.interrupted) console.log(`recovery: #${r.requestId} was interrupted → ${r.status}`);
    for (const r of rep.resolved) console.log(`recovery: run ${r.runId} push ${r.result}`);

    let stopping = false;
    const onSignal = () => {
      if (stopping) process.exit(130);
      stopping = true;
      console.log("stopping after the current request (again to quit now)");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let lastResolve = Date.now();
    let saidPaused = false;
    while (!stopping) {
      if (Date.now() - lastResolve >= RESOLVE_EVERY_MS) {
        lastResolve = Date.now();
        const unknown = db.query("SELECT id FROM runs WHERE push_state = 'push_unknown' AND status != 'running'").all() as { id: number }[];
        for (const r of unknown) {
          const res = resolvePushUnknown(ctx, r.id);
          if (res !== "unknown") console.log(`run ${r.id}: push ${res}`);
        }
      }
      const out = await runNext(ctx);
      if (out.kind === "ran") {
        saidPaused = false;
        const reason = (db.query("SELECT status_reason FROM requests WHERE id = ?").get(out.requestId) as { status_reason: string | null }).status_reason;
        console.log(`#${out.requestId} → ${out.status}${reason ? `  (${reason})` : ""}`);
        continue;
      }
      if (out.kind === "paused" && !saidPaused) { console.log(`runner paused: ${runnerRow(db).pause_reason}  (agentry resume)`); saidPaused = true; }
      if (once) break;
      await Bun.sleep(POLL_MS);
    }
  });
}

function redeployCmd(db: Database, id: number): Promise<number> {
  return withLease(db, async (ctx) => {
    console.log(`#${id} → ${await redeploy(ctx, id)}`);
  });
}

function reopen(db: Database, id: number, what: string): number {
  const newId = db.transaction(() => {
    const orig = db.query("SELECT status, title, body, project_id, done_when, done_when_test FROM requests WHERE id = ?").get(id) as Req | null;
    if (!orig) fail(`no request #${id}`);
    if (orig!.status !== "done") fail(`#${id} is ${orig!.status}; reopen needs done`);
    logEvent(db, id, "reopen", { text: what });
    const now = Date.now();
    return Number(db.query(`INSERT INTO requests (project_id, title, body, done_when, done_when_test, reopened_from, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(orig!.project_id, `Reopened #${id}: ${orig!.title}`,
      `${what}\n\nOriginal request:\n${orig!.body}`, orig!.done_when, orig!.done_when_test, id, now, now).lastInsertRowid);
  })();
  logEvent(db, newId, "add", { reopened_from: id });
  console.log(`#${newId} queued (reopened from #${id})`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  console.error(`agentry: ${e.message}`);
  process.exitCode = 1;
}
