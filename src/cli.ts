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
import * as A from "./actions.ts";
import { claudeAgent, resolveAuth } from "./adapters/claude.ts";
import { acquireLease, LeaseLost, openDb, releaseLease, runnerRow, startHeartbeat } from "./db.ts";
import { parseRecipe } from "./recipe.ts";
import { recover, resolvePushUnknown, unresolvedPushes } from "./recovery.ts";
import { runNext, type RunnerCtx } from "./runner.ts";
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
  redeploy <id> | resolve <id>       blocked_post_push → queue a re-run of the deploy | done_manual
  reopen <id> <what's wrong>         done → a new linked request (counts one false-done)
  unblock <group>                    clear a deploy group's lock that no request holds (drift guard)
  resume                             unpause the runner
  token                              save a \`claude setup-token\` token for subscription auth (paste, then Ctrl-D)`;

class CliError extends Error {}
const fail = (msg: string): never => { throw new CliError(msg); };

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
    case "answer": A.answer(db, id(), text("the answer")); return 0;
    case "approve": A.approve(db, id()); return 0;
    case "reject": A.reject(db, id()); return 0;
    case "retry": A.retry(db, id(), { body: o.body, doneWhen: o["done-when"], doneWhenTest: o["done-when-test"] }); return 0;
    case "cancel": A.cancel(db, id()); return 0;
    case "resolve": A.resolve(db, id()); return 0;
    case "redeploy": {
      const rid = id();
      A.requestRedeploy(db, rid);
      console.log(`#${rid} re-run deploy queued (the runner handles it before new work)`);
      return 0;
    }
    case "reopen": {
      const from = id();
      console.log(`#${A.reopen(db, from, text("what's wrong"))} queued (reopened from #${from})`);
      return 0;
    }
    case "unblock": A.unblock(db, args[0] ?? fail("unblock needs a group name")); return 0;
    case "token": return saveToken();
    case "resume": A.resume(db); return 0;
    default: return fail(`unknown command "${cmd}"\n${USAGE}`);
  }
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
  const id = A.addRequest(db, {
    project, title: title.join(" "), body: o.body as string | undefined, doneWhen: o["done-when"] as string | undefined,
    doneWhenTest: o["done-when-test"] as string | undefined, priority: Number(o.priority ?? 0),
  });
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
        for (const runId of unresolvedPushes(db)) {
          const res = await resolvePushUnknown(ctx, runId);
          if (res !== "unknown") console.log(`run ${runId}: push ${res}`);
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError) && !(e instanceof A.ActionError)) throw e;
  console.error(`agentry: ${e.message}`);
  process.exitCode = 1;
}
