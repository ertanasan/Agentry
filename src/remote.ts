// A runner on one machine working the queue of another (`agentry attach`). The queue's owner serves the methods of
// its localQueue under /api/runner/; the attached runner calls them through `remoteQueue`, so it runs exactly
// the steps a local runner runs:
//
//   attached runner ──POST /api/runner/call/<method> [args]──► owner's server ──► localQueue(db, lease token, key's name)
//     Authorization: Bearer <runner key>   (agentry runner-key add, on the owner; its name is the runner's holder)
//     X-Agentry-Lease: <lease token>       (every write is fenced by it, as for a local runner)
//
// The attached runner works beside the owner's own: each holds its own lease and takes only the requests routed
// to it (routing.ts), for projects it reported recipes for when it took its lease (two-runners review).
// What stays on the runner's machine: the recipes (its own projects of the same names: its paths and commands),
// worktrees, full logs, and the process groups it starts, which only it can kill. The owner gets each step's
// log tail (on every heartbeat and at the end of the step) and each run's diff, for the run page.
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { attachment, attachmentFile, extOf, type RunFile } from "./attachments.ts";
import { fenced, LeaseLost, leaseOf, NotYours, setRequestStatus } from "./db.ts";
import * as g from "./git.ts";
import { readTail } from "./proc.ts";
import { localQueue, Unreachable, type LocalQueue, type PartRow, type ProjectRow, type Queue, type RecoveryRun } from "./queue.ts";
import { LOCAL, runnersOf } from "./routing.ts";
import { MAX_DIFF_CHARS } from "./verifier.ts";

const CALL_TIMEOUT_MS = 30_000;
// Out of reach: a call is tried again after each of these; the lease outlasts them. Not the calls that add a
// row or take work, which a lost reply would make run twice.
const RETRY_MS = [1_000, 3_000, 10_000];
const ONCE = new Set(["startRun", "beginStep", "takeRedeploy", "claim"]);
// As much of a log as the run page shows.
const LOG_TAIL_BYTES = 64 * 1024;

// The localQueue methods a remote runner may call. Not process groups (they stay on the runner's machine) and not
// attachment copies (the runner downloads them), and beginStep only through the wrapper below.
const CALLS = new Set<keyof LocalQueue>([
  "acquire", "renew", "release", "settings", "setDevices", "takeRedeploy", "claim", "unclaim", "requeueStaleClaims", "request", "run", "lastCommitRun", "parts", "projects",
  "blockedGroup", "baseCounts", "answers", "startRun", "setRun", "setRunTests", "endStep", "setStatus", "markPushed", "finish",
  "unresolvedPushes", "recoveryRun", "expiredRuns", "resolvePush", "interrupt",
]);

export type Diff = { stat: string; diff: string; cut: boolean };

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

// A new key for a runner on another machine; only its hash is kept.
export function addRunnerKey(db: Database, name: string): string {
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) throw new Error("a runner key's name is 1-32 letters, digits, '.', '_' or '-'");
  if (name === LOCAL) throw new Error(`"${LOCAL}" names this machine's own runner; pick another name`);
  const key = `agentry_rk_${randomBytes(32).toString("base64url")}`;
  db.query("INSERT INTO runner_keys (name, key_hash, created_at) VALUES (?, ?, ?)").run(name, hash(key), Date.now());
  return key;
}

// Removes a runner key, for a machine that is gone for good. Refused while that runner holds a live lease (D8) or
// a project still lists it (D4). Its runs pass to this machine's runner, which recovers them at its next poll;
// its claimed requests go back to the queue, and those waiting to resume one of its branches start over from main,
// since the branch was on that machine (D7).
export function removeRunnerKey(db: Database, name: string, now = Date.now()): { handedBack: number } {
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM runner_keys WHERE name = ?").get(name)) throw new Error(`no runner key named ${name}`);
    const lease = leaseOf(db, name);
    if (lease && lease.expires_at >= now) {
      throw new Error(`${name}'s runner is connected: run \`agentry detach\` on ${lease.host ?? "it"}, or stop it, then try again in a minute`);
    }
    const listed = (db.query("SELECT name, runners FROM projects ORDER BY name").all() as { name: string; runners: string | null }[])
      .filter((p) => runnersOf(p.runners).includes(name)).map((p) => p.name);
    if (listed.length) throw new Error(`these projects still list ${name}: ${listed.join(", ")} (change them with agentry project add ... --runner)`);
    db.query("UPDATE requests SET resume_run = NULL WHERE resume_run IN (SELECT id FROM runs WHERE holder = ?)").run(name);
    const claimed = db.query(`SELECT id FROM requests r WHERE r.holder = ? AND r.status = 'running'
      AND NOT EXISTS (SELECT 1 FROM runs WHERE request_id = r.id AND status = 'running')`).all(name) as { id: number }[];
    for (const r of claimed) setRequestStatus(db, r.id, "queued", `${name} was removed before starting it`);
    const handedBack = db.query("UPDATE runs SET holder = ? WHERE holder = ? AND status = 'running'").run(LOCAL, name).changes;
    db.query("UPDATE runs SET holder = ? WHERE holder = ?").run(LOCAL, name);
    db.query("UPDATE requests SET holder = ? WHERE holder = ?").run(LOCAL, name);
    db.query("DELETE FROM leases WHERE holder = ?").run(name);
    db.query("DELETE FROM runner_keys WHERE name = ?").run(name);
    return { handedBack };
  })();
}

// The stored diff of a run worked by a remote runner, whose worktree this machine can't read.
export function storedDiff(home: string, runId: number): Diff | null {
  const file = join(home, "runs", String(runId), "diff.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Diff : null;
}

// The owner's side: answers /api/runner/*, or returns null for any other path. `home` holds the queue's database,
// attachments, and the logs and diffs remote runners send.
export async function runnerApi(db: Database, home: string, req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/runner/")) return null;
  const key = (req.headers.get("authorization") ?? "").match(/^Bearer (\S+)$/)?.[1];
  const runner = key ? db.query("SELECT name FROM runner_keys WHERE key_hash = ?").get(hash(key)) as { name: string } | null : null;
  if (!runner) return reply(401, { error: "unknown runner key" });
  const token = req.headers.get("x-agentry-lease") ?? "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(token)) return reply(400, { error: "missing lease token" });
  // The key decides whose runner this is; the caller never names a holder.
  const holder = runner.name;
  const q = localQueue(db, token, home, holder);

  const file = url.pathname.match(/^\/api\/runner\/attachments\/(\d+)$/);
  if (file && req.method === "GET") {
    const a = attachment(db, Number(file[1]));
    const path = a && attachmentFile(home, a);
    return path && existsSync(path) ? new Response(Bun.file(path), { headers: { "content-type": a.mime } }) : reply(404, { error: "no such file" });
  }
  const call = url.pathname.match(/^\/api\/runner\/call\/([A-Za-z]+)$/);
  if (!call || req.method !== "POST") return reply(404, { error: "not found" });
  const args = await req.json().catch(() => null);
  if (!Array.isArray(args)) return reply(400, { error: "the body is a JSON array of arguments" });
  const method = call[1];

  // A run of this runner, for the writes that are files, not rows.
  const runDir = (runId: number) => {
    const ok = db.query("SELECT 1 FROM runs WHERE id = ? AND lease_token = ? AND holder = ? AND status = 'running'").get(runId, token, holder);
    if (!ok) throw new Error(`run ${runId} is not running under this lease`);
    const dir = join(home, "runs", String(runId));
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  try {
    let result: unknown;
    if (method === "beginStep") {
      // The log is kept here, under the queue's own runs/, by the name the runner gave it.
      const [runId, step, logPath] = args as [number, string, string];
      const name = basename(String(logPath));
      if (!/^\d+-[a-z_]+\.log$/.test(name)) throw new Error(`bad log name ${name}`);
      result = await q.beginStep(runId, step, join(runDir(runId), name));
    } else if (method === "attachments") {
      result = db.query("SELECT id, name, mime FROM attachments WHERE request_id = ? ORDER BY id").all(Number(args[0]));
    } else if (method === "saveLog") {
      const [stepId, text] = args as [number, string];
      fenced(db, token, () => {
        const step = db.query("SELECT run_id, log_path FROM steps WHERE id = ?").get(stepId) as { run_id: number; log_path: string } | null;
        if (!step || join(runDir(step.run_id), basename(step.log_path)) !== step.log_path) throw new Error(`step ${stepId} has no log here`);
        writeFileSync(step.log_path, String(text));
      }, holder);
    } else if (method === "saveDiff") {
      const [runId, d] = args as [number, Diff];
      fenced(db, token, () => writeFileSync(join(runDir(runId), "diff.json"), JSON.stringify({ stat: String(d.stat), diff: String(d.diff), cut: !!d.cut })), holder);
    } else if (CALLS.has(method as keyof LocalQueue)) {
      result = await (q[method as keyof LocalQueue] as (...a: unknown[]) => unknown)(...args);
    } else {
      return reply(404, { error: `no runner call ${method}` });
    }
    return reply(200, { result: result ?? null });
  } catch (e) {
    if (e instanceof LeaseLost || e instanceof NotYours) return reply(409, { error: e.message });
    return reply(500, { error: e instanceof Error ? e.message : String(e) });
  }
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type RemoteOptions = {
  url: string;                   // the owner's public URL
  key: string;                   // a runner key from the owner
  token: string;                 // this runner's lease token
  recipes: Map<string, string>;  // project name → this machine's recipe (JSON)
  work: string;                  // this machine's folder for the queue's worktrees and runs
};

// The attached runner's side. It reports the projects it has recipes for when it takes its lease; the owner hands
// it only requests routed to it whose projects are all among them (two-runners review D9).
export function remoteQueue(o: RemoteOptions): Queue {
  const base = o.url.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${o.key}`, "x-agentry-lease": o.token };

  async function send(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (e) {
      throw new Unreachable(`${base} unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A proxy in front of a stopped server (Tailscale Serve, Caddy) answers 502.
    if (res.status >= 502 && res.status <= 504) throw new Unreachable(`${base} unreachable: HTTP ${res.status}`);
    if (res.status === 409) throw new LeaseLost();
    return res;
  }
  async function call<T>(method: string, ...args: unknown[]): Promise<T> {
    const post = () => send(`/api/runner/call/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
    let res: Response | undefined;
    for (const wait of ONCE.has(method) ? [] : RETRY_MS) {
      try { res = await post(); break; } catch (e) {
        if (!(e instanceof Unreachable)) throw e;
        await Bun.sleep(wait);
      }
    }
    res ??= await post();
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { result?: T; error?: string };
    if (!res.ok) throw new Error(`${base}: ${method}: ${body.error ?? `HTTP ${res.status}`}`);
    return body.result as T;
  }

  const recipeOf = (name: string) => o.recipes.get(name) ?? (() => { throw new Error(`no recipe for project ${name} on this machine`); })();
  const local = (run: RecoveryRun): RecoveryRun => ({ ...run, recipe: recipeOf(run.project) });

  // Process groups, by run, in a file: a runner that restarts after a crash kills what the last one left.
  const pgidFile = join(o.work, "pgids.json");
  const pgids = (): Record<string, number> => existsSync(pgidFile) ? JSON.parse(readFileSync(pgidFile, "utf8")) : {};

  // The open steps' local logs, whose tails go to the owner.
  const open = new Map<number, string>();
  const sendLog = async (stepId: number, path: string) => {
    if (existsSync(path)) await call("saveLog", stepId, readTail(path, LOG_TAIL_BYTES));
  };

  return {
    acquire: (pid, host) => call("acquire", pid, host, [...o.recipes.keys()]),
    async renew(runIds) {
      await call("renew", runIds);
      for (const [stepId, path] of open) await sendLog(stepId, path);
    },
    release: () => call("release"),
    settings: () => call("settings"),
    setDevices: (choices) => call("setDevices", choices),

    takeRedeploy: () => call("takeRedeploy"),
    claim: () => call("claim"),
    unclaim: (requestId) => call("unclaim", requestId),
    requeueStaleClaims: () => call("requeueStaleClaims"),
    request: (id) => call("request", id),
    run: (id) => call("run", id),
    lastCommitRun: (requestId) => call("lastCommitRun", requestId),
    parts: async (requestId) => (await call<PartRow[]>("parts", requestId)).map((p) => ({ ...p, recipe: recipeOf(p.name) })),
    projects: async () => (await call<ProjectRow[]>("projects")).filter((p) => o.recipes.has(p.name)).map((p) => ({ ...p, recipe: recipeOf(p.name) })),
    blockedGroup: (ids) => call("blockedGroup", ids),
    baseCounts: (projectId) => call("baseCounts", projectId),
    answers: (requestId) => call("answers", requestId),
    async copyAttachments(requestId, dir) {
      const files: RunFile[] = [];
      for (const a of await call<{ id: number; name: string; mime: string }[]>("attachments", requestId)) {
        const res = await send(`/api/runner/attachments/${a.id}`, { method: "GET" });
        if (!res.ok) continue;
        mkdirSync(dir, { recursive: true });
        const to = join(dir, `${a.id}.${extOf(a)}`);
        writeFileSync(to, new Uint8Array(await res.arrayBuffer()));
        files.push({ path: to, name: a.name, mime: a.mime });
      }
      return files;
    },

    startRun: (requestId, run) => call("startRun", requestId, run),
    setRun: (runId, fields) => call("setRun", runId, fields),
    setRunTests: (runId, projectId, total, skipped) => call("setRunTests", runId, projectId, total, skipped),
    setPgid(runId, pgid) {
      const all = pgids();
      if (pgid === null) delete all[runId]; else all[runId] = pgid;
      mkdirSync(o.work, { recursive: true });
      writeFileSync(pgidFile, JSON.stringify(all));
    },
    async beginStep(runId, step, logPath) {
      const stepId = await call<number>("beginStep", runId, step, logPath);
      open.set(stepId, logPath);
      return stepId;
    },
    async endStep(runId, stepId, exitCode) {
      const path = open.get(stepId);
      open.delete(stepId);
      if (path) await sendLog(stepId, path);
      await call("endStep", runId, stepId, exitCode);
    },
    setStatus: (requestId, status, reason) => call("setStatus", requestId, status, reason),
    markPushed: (requestId, sha) => call("markPushed", requestId, sha),
    finish: (f) => call("finish", f),
    async saveDiff(runId, worktree, from, to) {
      const stat = (await g.run(worktree, ["diff", "--stat", from, to])).out;
      const full = (await g.run(worktree, ["diff", "--no-color", from, to])).out;
      await call("saveDiff", runId, { stat, diff: full.slice(0, MAX_DIFF_CHARS), cut: full.length > MAX_DIFF_CHARS } satisfies Diff);
    },

    orphans: async () => Object.entries(pgids()).map(([id, pgid]) => ({ id: Number(id), pgid })),
    unresolvedPushes: () => call("unresolvedPushes"),
    recoveryRun: async (runId) => {
      const run = await call<RecoveryRun | null>("recoveryRun", runId);
      return run && local(run);
    },
    expiredRuns: async (now) => (await call<RecoveryRun[]>("expiredRuns", now)).map(local),
    resolvePush: (run, sha) => call("resolvePush", run, sha),
    interrupt: (run, i, now) => call("interrupt", run, i, now),
  };
}

// The queue this machine's runner works instead of its own, saved by `agentry attach`.
export type Attached = { url: string; key: string };

export function readAttached(home: string): Attached | null {
  const file = join(home, "queue.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Attached : null;
}

// The attached runner's folder for that queue's worktrees and runs: their run ids are the queue's, not this
// machine's. No ":" in the name (repos are cloned on Windows too).
export function workDir(home: string, a: Attached): string {
  return join(home, "queues", new URL(a.url).host.replace(/[^A-Za-z0-9.-]/g, "_"));
}
