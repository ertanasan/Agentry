// The runner: takes one queued request from a fresh worktree through the gates to push and deploy.
//
//  queued ─pick (group free)─► fetch ─► drift guard (D5/D10) ─► worktree@origin ─► AGENT [sandbox]
//    ▲                                       │ needs_info · no changes → blocked_pre_push · infra_error
//    │                                       ▼
//    │               CANDIDATE COMMIT (git add -A, D15) ─► INSPECT ─► needs_review ─approve─┐
//    │                                       ▼                                            │
//    │               BUILD [sandbox, D16]* ─► TESTS [sandbox, TRX] ─► DONE-WHEN [D9] ◄─────┘
//    │                                       │ any fail · rebase conflict → blocked_pre_push
//    │               amend message; origin moved → rebase + re-gate ─► push_started ─► PUSH ─► ls-remote
//    │                                       │ remote unreachable → push_unknown, group blocked (D19)
//    │                                       ▼ origin has the commit
//    │               remote busy? (D18) ─► clean worktree ─► DEPLOY (D6) ─► live VERSION == sha (C1)
//    │                                       │ fail · timeout → blocked_post_push, group blocked
//    │                                       ▼
//    └── infra_error → queued (attempt not counted), runner paused              done
//
//  Re-run deploy (queued by the CLI/UI, slice 2 review D7) is handled before new work: origin must have the
//  commit, and every target must run it, an older commit or a later one containing it (never a rollback, D14).
//
//  A request may span several projects of one repo: the scope is their union, each distinct build, test and
//  deploy command runs once, and deploys go in deploy_order. A change outside every scope stops the request.
//
//  * A recipe with build_unsandboxed builds outside the sandbox on a cleaned worktree, as deploy does (D6).
//
// The runner may work on several requests at once (the settings page's worker count). Agent, build, tests and
// verifier of different requests run side by side; the drift guard, and everything from the last fetch before
// the push to the end of the deploy, hold the request's deploy groups, so one group never sees two pushes or
// deploys at once. A request whose group was blocked while it ran stops before its push.
//
// Every stop removes the worktree and keeps the branch (D12). Every state write is fenced by the lease
// token (D17); the caller holds the lease and runs the heartbeat, which reads `ctx.running`. Every git call
// is async and bounded, and its process group is recorded on the run while it runs (git.ts).
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { copyForRun } from "./attachments.ts";
import { fenced, LeaseLost, LEASE_TTL_MS, runnerRow, setRequestStatus, type PushState, type RequestStatus } from "./db.ts";
import * as g from "./git.ts";
import { countRegression, inspect, type Flag, type Owner } from "./inspect.ts";
import { readTail, runStep, type StepResult } from "./proc.ts";
import { parseRecipe, timeoutMs, type Recipe, type StepName, type Target } from "./recipe.ts";
import { namedTestPassed, parseTrx, type TestRun } from "./results/trx.ts";
import { sandbox } from "./sandbox.ts";
import type { Agent, Sandbox, Verifier } from "./adapters/types.ts";

export type RunnerCtx = {
  db: Database;
  token: string;            // this runner's lease token
  home: string;             // ~/.agentry: worktrees/, runs/<id>/ (logs, temp), cache/
  agent: Agent;
  verifier: Verifier;
  claudeBin?: string;
  keyHelper?: string;       // API key helper the sandbox lets claude read; default ~/.agentry/api-key-helper
  pushBackoffMs?: number[]; // ls-remote retries after a push (D19)
  running: Set<number>;     // the runs in progress, whose leases the heartbeat renews
};

export type RunOutcome = { kind: "paused" | "idle" } | { kind: "ran"; requestId: number; status: RequestStatus };
export type Started = { kind: "paused" | "idle" } | { kind: "started"; requestId: number; done: Promise<RunOutcome> };

type ReqRow = {
  id: number; project_id: number; title: string; body: string; done_when: string | null; done_when_test: string | null;
  attempts: number; resume_run: number | null; status: RequestStatus;
};
// One of the request's projects.
type Part = { projectId: number; name: string; recipe: Recipe; groupId: number };
type RunRow = {
  id: number; attempt: number; branch: string; base_sha: string | null; candidate_sha: string | null;
  commit_sha: string | null; push_state: PushState;
};

type Stop = {
  status: RequestStatus;
  reason: string | null;
  requeue?: boolean;                               // back to queued; the attempt does not count
  pause?: boolean;                                 // infrastructure failure: pause the runner
  lock?: { reason: string; sha: string | null; groups?: number[] };   // block these deploy groups; default all of the request's
};

type Job = {
  ctx: RunnerCtx; req: ReqRow; parts: Part[]; repo: string; remote: string; branch: string;
  runId: number; runBranch: string; wt: string; dir: string; base: string;
  prevAttempts: number; resumeFrom: number | null; flags: Flag[]; n: number; sbx?: Sandbox;
};

const DEFAULT_BACKOFF_MS = [2_000, 10_000, 30_000];

const pre = (reason: string): Stop => ({ status: "blocked_pre_push", reason });
const post = (reason: string, sha: string | null, groups?: number[]): Stop => ({ status: "blocked_post_push", reason, lock: { reason, sha, groups } });
const infra = (reason: string): Stop => ({ status: "queued", reason, requeue: true, pause: true });

function w<T>(ctx: RunnerCtx, write: () => T): T {
  return fenced(ctx.db, ctx.token, write);
}

const REQ_COLUMNS = "r.id, r.project_id, r.title, r.body, r.done_when, r.done_when_test, r.attempts, r.resume_run, r.status";

// Highest priority, then oldest, among queued requests whose projects are all enabled and deploy groups all free.
function pick(db: Database): ReqRow | null {
  return db.query(`SELECT ${REQ_COLUMNS} FROM requests r WHERE r.status = 'queued' AND NOT EXISTS (
      SELECT 1 FROM request_projects rp JOIN projects p ON p.id = rp.project_id JOIN deploy_groups dg ON dg.id = p.deploy_group_id
      WHERE rp.request_id = r.id AND (p.enabled = 0 OR dg.lock != 'free'))
    ORDER BY r.priority DESC, r.created_at, r.id LIMIT 1`).get() as ReqRow | null;
}

// The request's projects, lowest deploy_order first, then by project.
function partsOf(db: Database, requestId: number): Part[] {
  const rows = db.query(`SELECT p.id, p.name, p.recipe, p.deploy_group_id FROM request_projects rp JOIN projects p ON p.id = rp.project_id
    WHERE rp.request_id = ? ORDER BY p.id`).all(requestId) as { id: number; name: string; recipe: string; deploy_group_id: number }[];
  return rows.map((r) => ({ projectId: r.id, name: r.name, recipe: parseRecipe(r.recipe), groupId: r.deploy_group_id }))
    .sort((a, b) => (a.recipe.deploy_order ?? 0) - (b.recipe.deploy_order ?? 0));
}

const groupsOf = (parts: Part[]) => [...new Set(parts.map((p) => p.groupId))];

// The first item for each key, in order.
function distinct<T>(items: T[], key: (item: T) => unknown): T[] {
  const seen = new Set<unknown>();
  return items.filter((item) => !seen.has(key(item)) && !!seen.add(key(item)));
}

export async function runNext(ctx: RunnerCtx): Promise<RunOutcome> {
  const s = startNext(ctx);
  return s.kind === "started" ? s.done : s;
}

// Starts the next request and returns at once, with `done` settling when its run ends. The request is marked
// running before this returns, so the next call starts a different one.
export function startNext(ctx: RunnerCtx): Started {
  if (runnerRow(ctx.db).paused) return { kind: "paused" };
  // A queued Re-run deploy goes first: its group stays blocked until it is handled (slice 2 review D7).
  const queued = ctx.db.query(`SELECT id FROM requests WHERE redeploy_requested = 1 AND status = 'blocked_post_push'
    ORDER BY updated_at, id LIMIT 1`).get() as { id: number } | null;
  if (queued) {
    w(ctx, () => ctx.db.query("UPDATE requests SET redeploy_requested = 0 WHERE id = ?").run(queued.id));
    const done = (async (): Promise<RunOutcome> => {
      try {
        return { kind: "ran", requestId: queued.id, status: await redeploy(ctx, queued.id) };
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        w(ctx, () => setRequestStatus(ctx.db, queued.id, "blocked_post_push", `re-run deploy failed: ${e instanceof Error ? e.message : String(e)}`));
        return { kind: "ran", requestId: queued.id, status: "blocked_post_push" };
      }
    })();
    return { kind: "started", requestId: queued.id, done };
  }
  const req = pick(ctx.db);
  if (!req) return { kind: "idle" };
  const resume = req.resume_run ? ctx.db.query("SELECT * FROM runs WHERE id = ?").get(req.resume_run) as RunRow : null;
  const attempt = resume ? resume.attempt : req.attempts + 1;
  const j = startRun(ctx, req, {
    attempt, branch: resume?.branch ?? `agentry/${req.id}-${attempt}`, base: resume?.base_sha ?? null, candidate: resume?.candidate_sha ?? null,
  });
  const done = execute(j, () => pipeline(j, resume !== null)).then((status): RunOutcome => ({ kind: "ran", requestId: req.id, status }));
  return { kind: "started", requestId: req.id, done };
}

// The deploy groups this runner is pushing or deploying to, each with the promise its next holder waits on.
const held = new Map<number, Promise<void>>();

// Runs `body` while holding `groups`, after every earlier holder of any of them has finished. Groups are taken
// in id order, so two requests that share several groups can't wait on each other.
async function holdGroups<T>(groups: number[], body: () => Promise<T>): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const id of [...groups].sort((a, b) => a - b)) {
      const before = held.get(id) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => { release = r; });
      const tail = before.then(() => mine);
      held.set(id, tail);
      releases.push(() => { release(); if (held.get(id) === tail) held.delete(id); });
      await before;
    }
    return await body();
  } finally {
    for (const release of releases) release();
  }
}

// "Re-run deploy" for a blocked_post_push request: steps 9-10 for its recorded commit, from a fresh worktree.
export async function redeploy(ctx: RunnerCtx, requestId: number): Promise<RequestStatus> {
  const req = ctx.db.query(`SELECT ${REQ_COLUMNS} FROM requests r WHERE r.id = ?`).get(requestId) as ReqRow | null;
  if (!req || req.status !== "blocked_post_push") throw new Error(`request #${requestId} is not blocked after push`);
  const last = ctx.db.query("SELECT * FROM runs WHERE request_id = ? AND commit_sha IS NOT NULL ORDER BY id DESC LIMIT 1").get(requestId) as RunRow | null;
  if (!last?.commit_sha) throw new Error(`request #${requestId} has no pushed commit`);
  const sha = last.commit_sha;
  const j = startRun(ctx, req, {
    attempt: last.attempt, branch: last.branch, base: last.base_sha, candidate: last.candidate_sha, commit: sha, pushState: last.push_state,
  });
  return execute(j, () => holdGroups(groupsOf(j.parts), async () => {
    const f = await g.fetch(j.repo, j.remote);
    if (f.code !== 0) throw new Error(fetchFailed(f));
    if (!await g.isAncestor(j.repo, sha, `${j.remote}/${j.branch}`)) throw new Error(`${sha.slice(0, 7)} is not on ${j.remote}/${j.branch}`);
    // Origin has the commit: record that on this run and on earlier unknown pushes of it (slice 2 review D10).
    w(ctx, () => ctx.db.query("UPDATE runs SET push_state = 'pushed' WHERE request_id = ? AND commit_sha = ? AND push_state IN ('push_unknown', 'push_started')")
      .run(requestId, sha));
    return deploy(j, sha, true);
  }));
}

function startRun(ctx: RunnerCtx, req: ReqRow, o: {
  attempt: number; branch: string; base: string | null; candidate: string | null; commit?: string; pushState?: PushState;
}): Job {
  const parts = partsOf(ctx.db, req.id);
  const { recipe } = parts[0];
  const now = Date.now();
  const runId = w(ctx, () => {
    ctx.db.query("UPDATE requests SET attempts = ?, resume_run = NULL WHERE id = ?").run(o.attempt, req.id);
    setRequestStatus(ctx.db, req.id, "running", null, now);
    return Number(ctx.db.query(`INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, base_sha,
      candidate_sha, commit_sha, push_state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.id, o.attempt, ctx.token, now + LEASE_TTL_MS, o.branch, o.base, o.candidate, o.commit ?? null, o.pushState ?? "none", now)
      .lastInsertRowid);
  });
  ctx.running.add(runId);
  const dir = join(ctx.home, "runs", String(runId));
  mkdirSync(dir, { recursive: true });
  return {
    ctx, req, parts, repo: recipe.repo, remote: recipe.remote ?? "origin", branch: recipe.branch ?? "main",
    runId, runBranch: o.branch, wt: join(ctx.home, "worktrees", `${req.id}-${o.attempt}`), dir, base: o.base ?? "",
    prevAttempts: req.attempts, resumeFrom: req.resume_run, flags: [], n: 0,
  };
}

async function execute(j: Job, body: () => Promise<Stop>): Promise<RequestStatus> {
  const { ctx, runId } = j;
  // Each git process's group is recorded on the run while it runs, like a step's (slice 2 review D13).
  const observer: g.Observer = {
    onStart: (pgid) => w(ctx, () => ctx.db.query("UPDATE runs SET pgid = ? WHERE id = ?").run(pgid, runId)),
    onEnd: () => w(ctx, () => ctx.db.query("UPDATE runs SET pgid = NULL WHERE id = ?").run(runId)),
  };
  return g.observer.run(observer, async () => {
    let s: Stop;
    try {
      s = await body();
    } catch (e) {
      if (e instanceof LeaseLost) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      const run = ctx.db.query("SELECT push_state, commit_sha FROM runs WHERE id = ?").get(runId) as RunRow;
      // Once a push has started, origin may have the commit: never requeue (D19).
      s = run.push_state === "none" ? infra(`runner error: ${msg}`) : post(`runner error after push started: ${msg}`, run.commit_sha);
    } finally {
      if (existsSync(j.wt)) await g.removeWorktree(j.repo, j.wt);
      rmSync(join(j.dir, "tmp"), { recursive: true, force: true });
      ctx.running.delete(runId);
    }
    finish(j, s);
    return s.status;
  });
}

function finish(j: Job, s: Stop): void {
  const { db } = j.ctx;
  const id = j.req.id;
  const now = Date.now();
  w(j.ctx, () => {
    const runStatus = s.status === "done" ? "passed" : s.requeue ? "interrupted" : "failed";
    db.query("UPDATE runs SET status = ?, current_step = NULL, pgid = NULL, flags = ?, ended_at = ? WHERE id = ?")
      .run(runStatus, JSON.stringify(j.flags), now, j.runId);
    if (s.requeue) db.query("UPDATE requests SET attempts = ?, resume_run = ? WHERE id = ?").run(j.prevAttempts, j.resumeFrom, id);
    setRequestStatus(db, id, s.status, s.reason, now);
    if (s.pause) db.query("UPDATE runner SET paused = 1, pause_reason = ? WHERE id = 1").run(s.reason);
    // A request holds only the groups of its latest stop: a re-run deploy that got further frees the rest.
    if (s.lock || s.status === "done") {
      db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, locked_by_request = NULL, undeployed_sha = NULL WHERE locked_by_request = ?")
        .run(id);
    }
    for (const group of s.lock ? s.lock.groups ?? groupsOf(j.parts) : []) {
      db.query("UPDATE deploy_groups SET lock = 'blocked', lock_reason = ?, locked_by_request = ?, undeployed_sha = ? WHERE id = ?")
        .run(s.lock!.reason, s.lock!.sha ? id : null, s.lock!.sha, group);
    }
  });
}

async function pipeline(j: Job, resumed: boolean): Promise<Stop> {
  const odd = j.parts.find((p) => p.recipe.repo !== j.repo || (p.recipe.remote ?? "origin") !== j.remote || (p.recipe.branch ?? "main") !== j.branch);
  if (odd) return pre(`${odd.name} is not in the same repository and branch as ${j.parts[0].name}`);
  const f = await g.fetch(j.repo, j.remote);
  if (f.code !== 0) return infra(fetchFailed(f));
  const drift = await holdGroups(groupsOf(j.parts), () => driftGuard(j));
  if (drift) return { status: "queued", reason: drift.reason, requeue: true, lock: { reason: drift.reason, sha: null, groups: [drift.group] } };

  if (resumed) {
    await g.checkoutWorktree(j.repo, j.wt, j.runBranch);
  } else {
    j.base = await g.remoteHead(j.repo, j.remote, j.branch);
    w(j.ctx, () => j.ctx.db.query("UPDATE runs SET base_sha = ? WHERE id = ?").run(j.base, j.runId));
    await g.addWorktree(j.repo, j.wt, j.runBranch, j.base);
  }
  j.sbx = sandbox({
    worktree: j.wt, runTmp: join(j.dir, "tmp"), gitDir: await g.commonDir(j.repo), claudeBin: j.ctx.claudeBin,
    keyHelper: j.ctx.keyHelper, pkgCache: join(j.ctx.home, "cache", "nuget"),
    userTemp: j.parts.some((p) => p.recipe.sandbox_user_temp),
  });

  if (!resumed) {
    const stopped = (await agentStep(j)) ?? tampered(j, "agent");
    if (stopped) return stopped;
    const candidate = await g.candidateCommit(j.wt, `agentry: candidate for #${j.req.id}`);
    if (!candidate) return pre("the agent made no changes");
    w(j.ctx, () => j.ctx.db.query("UPDATE runs SET candidate_sha = ? WHERE id = ?").run(candidate, j.runId));
  }
  return deliver(j, resumed);
}

// Gates, commit message, rebase if origin moved, push, deploy. `approved` skips the review flags.
async function deliver(j: Job, approved: boolean): Promise<Stop> {
  let stopped = await gates(j, approved);
  if (stopped) return stopped;
  let sha = await g.amendMessage(j.wt, commitMessage(j.req));
  return holdGroups(groupsOf(j.parts), async () => {
    const blocked = blockedGroup(j);
    if (blocked) return pre(`deploy group ${blocked} was blocked while this request ran; retry once it is free`);
    for (let round = 0; ; round++) {
      const f = await g.fetch(j.repo, j.remote);
      if (f.code !== 0) return infra(fetchFailed(f));
      const head = await g.remoteHead(j.repo, j.remote, j.branch);
      if (!await g.isAncestor(j.repo, head, sha)) {
        if (!await g.rebaseOnto(j.wt, `${j.remote}/${j.branch}`)) return pre(`rebase onto ${j.remote}/${j.branch} had conflicts`);
        j.base = head;
        sha = await g.headSha(j.wt);
        w(j.ctx, () => j.ctx.db.query("UPDATE runs SET base_sha = ? WHERE id = ?").run(head, j.runId));
        stopped = await gates(j, approved);
        if (stopped) return stopped;
      }
      const pushed = await push(j, sha);
      if (pushed === "pushed") break;
      if (pushed === "unknown") return post(`push outcome unknown for ${sha.slice(0, 7)}: ${j.remote} unreachable`, sha);
      if (round >= 1) return pre("push rejected twice");
    }
    return deploy(j, sha);
  });
}

// One of the request's deploy groups that another request (a failed deploy) or the drift guard blocked after
// this one was picked, by name and holder.
function blockedGroup(j: Job): string | null {
  const ids = groupsOf(j.parts);
  const row = j.ctx.db.query(`SELECT name, locked_by_request FROM deploy_groups WHERE lock != 'free' AND id IN (${ids.map(() => "?").join(",")})
    ORDER BY id LIMIT 1`).get(...ids) as { name: string; locked_by_request: number | null } | null;
  return row ? `${row.name}${row.locked_by_request ? ` (by #${row.locked_by_request})` : ""}` : null;
}

function commitMessage(r: ReqRow): string {
  return `${r.title}\n\n${r.body ? r.body + "\n\n" : ""}Agentry-Request: #${r.id}`;
}

// Step 4 (inspect), then build, tests and the done-when check on the worktree's HEAD. `approved` skips the
// review flags, never the scope: a change outside the request's projects would ship without their deploy.
async function gates(j: Job, approved: boolean): Promise<Stop | null> {
  const { req } = j;
  const head = await g.headSha(j.wt);
  const found = inspect(await g.changedFiles(j.wt, j.base, head), await g.addedLines(j.wt, j.base, head), j.parts.map((p) => p.recipe), otherProjects(j));
  const outside = found.blocking.filter((f) => f.kind === "out_of_scope");
  if (outside.length || !approved) j.flags = [...found.blocking, ...found.info];
  if (outside.length) {
    return pre(`changed files outside the selected projects: ${outside.map((f) => `${f.path}${f.detail ? ` (${f.detail})` : ""}`).join("; ")}`);
  }
  if (!approved && found.blocking.length) return { status: "needs_review", reason: describe(found.blocking) };

  for (const { recipe } of distinct(j.parts, (p) => p.recipe.build_cmd)) {
    if (!recipe.build_cmd) continue;
    // An unsandboxed build gets what deploy gets: no file a sandboxed step left behind (e.g. a planted plugin).
    if (recipe.build_unsandboxed) await g.cleanUntracked(j.wt);
    const b = await command(j, "build", recipe.build_cmd, { sandboxed: !recipe.build_unsandboxed, recipe });
    const t = tampered(j, "build");
    if (t) return t;
    if (b.exitCode !== 0) return pre(b.timedOut ? "build timed out" : `build failed (exit ${b.exitCode})`);
  }

  const runs: TestRun[] = [];
  let t: StepResult | null = null;
  for (const { recipe } of distinct(j.parts, (p) => p.recipe.test_cmd)) {
    const resultFile = recipe.test_result_file ? join(j.wt, recipe.test_result_file) : null;
    if (resultFile) rmSync(resultFile, { force: true });
    t = await command(j, "test", recipe.test_cmd, { sandboxed: true, recipe });
    const changed = tampered(j, "test");
    if (changed) return changed;
    if (t.exitCode !== 0) return pre(t.timedOut ? "tests timed out" : `tests failed (exit ${t.exitCode})`);
    if (!await g.trackedClean(j.wt)) return pre("the tests changed tracked files");
    if (!resultFile) continue;

    if (!existsSync(resultFile)) return pre(`no test results at ${recipe.test_result_file}`);
    const run = parseTrx(readFileSync(resultFile, "utf8"));
    runs.push(run);
    const sum = (k: "total" | "skipped") => runs.reduce((n, r) => n + r[k], 0);
    w(j.ctx, () => j.ctx.db.query("UPDATE runs SET tests_total = ?, tests_skipped = ? WHERE id = ?").run(sum("total"), sum("skipped"), j.runId));
    // Each project this command tests gets the counts and is checked against its own last passing run.
    for (const p of j.parts.filter((p) => p.recipe.test_cmd === recipe.test_cmd)) {
      w(j.ctx, () => {
        j.ctx.db.query("DELETE FROM run_tests WHERE run_id = ? AND project_id = ?").run(j.runId, p.projectId);
        j.ctx.db.query("INSERT INTO run_tests (run_id, project_id, total, skipped) VALUES (?, ?, ?, ?)").run(j.runId, p.projectId, run.total, run.skipped);
      });
      const regression = approved ? null : countRegression(run, baseCounts(j, p.projectId));
      if (regression) {
        j.flags.push(regression);
        return { status: "needs_review", reason: describe([regression]) };
      }
    }
  }
  const run = runs.length ? merged(runs) : null;

  if (req.done_when_test) {
    if (!run) return pre("done_when_test needs the recipe's test_result_file");
    const named = namedTestPassed(run, req.done_when_test);
    if (!named.ok) {
      return pre(named.matched.length ? `done-when test did not pass: ${named.matched.join(", ")}` : `no test matching "${req.done_when_test}" ran`);
    }
  }
  if (req.done_when) {
    const s = begin(j, "verify");
    const v = await j.ctx.verifier.verify({
      worktree: j.wt, logPath: s.logPath, timeoutMs: longest(j, "verify"), sandbox: j.sbx!, onStart: s.onStart,
      title: req.title, body: req.body, doneWhen: req.done_when, diff: await g.diff(j.wt, j.base, head), testSummary: summary(run, t!),
    });
    s.end(v.verdict === "PASS" ? 0 : 1);
    const changed = tampered(j, "verify");
    if (changed) return changed;
    if (v.verdict === "infra_error") return infra(`verifier: ${v.evidence}`);
    if (v.verdict === "FAIL") return pre(`done-when not met: ${v.evidence}`);
  }
  return null;
}

// A sandboxed step rewrote the worktree's `.git` pointer: stop before any unsandboxed git runs there (D12).
function tampered(j: Job, step: string): Stop | null {
  return g.pointerChanged(j.wt) ? pre(`worktree git metadata changed during the ${step} step`) : null;
}

function describe(flags: Flag[]): string {
  return flags.map((f) => `${f.kind}: ${f.path}${f.detail ? ` (${f.detail})` : ""}`).join("; ");
}

function summary(run: TestRun | null, t: StepResult): string {
  return run ? `tests: ${run.total} total, ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped` : `test command exited ${t.exitCode}`;
}

// One test run out of several: counts added up, outcomes of all of them.
function merged(runs: TestRun[]): TestRun {
  const sum = (k: "total" | "passed" | "failed" | "skipped") => runs.reduce((n, r) => n + r[k], 0);
  return { total: sum("total"), passed: sum("passed"), failed: sum("failed"), skipped: sum("skipped"), outcomes: new Map(runs.flatMap((r) => [...r.outcomes])) };
}

// Test counts of the project's last passing run, the baseline for deleted or skipped tests.
function baseCounts(j: Job, projectId: number): { total: number; skipped: number } | null {
  return j.ctx.db.query(`SELECT t.total, t.skipped FROM run_tests t JOIN runs ru ON ru.id = t.run_id
    WHERE t.project_id = ? AND ru.status = 'passed' ORDER BY ru.id DESC LIMIT 1`)
    .get(projectId) as { total: number; skipped: number } | null;
}

// The repo's projects this request did not select, to name the owner of an out-of-scope file.
function otherProjects(j: Job): Owner[] {
  const mine = new Set(j.parts.map((p) => p.projectId));
  return (j.ctx.db.query("SELECT id, name, recipe FROM projects").all() as { id: number; name: string; recipe: string }[])
    .filter((p) => !mine.has(p.id)).map((p) => ({ name: p.name, recipe: parseRecipe(p.recipe) }))
    .filter((p) => p.recipe.repo === j.repo).map((p) => ({ name: p.name, scope_path: p.recipe.scope_path }));
}

async function agentStep(j: Job): Promise<Stop | null> {
  const s = begin(j, "agent");
  // The request's images go into the run's temp dir, the one place outside the worktree the sandbox lets it read.
  const images = copyForRun(j.ctx.db, j.ctx.home, j.req.id, join(j.sbx!.env.TMPDIR, "attachments"));
  const res = await j.ctx.agent.run({
    worktree: j.wt, logPath: s.logPath, timeoutMs: longest(j, "agent"), sandbox: j.sbx!, onStart: s.onStart, prompt: prompt(j, images),
  });
  s.end(res.outcome === "infra_error" ? 1 : 0);
  if (res.outcome === "infra_error") return infra(`agent: ${res.detail}`);
  if (res.outcome === "needs_info") return { status: "needs_info", reason: res.question };
  return null;
}

function prompt(j: Job, images: string[]): string {
  const { req } = j;
  const scopes = j.parts.map((p) => p.recipe.scope_path);
  const answers = (j.ctx.db.query("SELECT payload FROM events WHERE request_id = ? AND type = 'answer' ORDER BY id").all(req.id) as { payload: string }[])
    .map((r) => `- ${(JSON.parse(r.payload) as { text: string }).text}`);
  const parts = [
    `You are working on request #${req.id}. Change files only under ${scopes.join(", ")}. If the request needs a change`,
    "anywhere else in the repository (a test in another project, an API the code calls), change nothing and reply with a",
    "single line `NEEDS_INFO: <what else must change, and where>`: a change outside those folders is never deployed.",
    "Rules: edit code only. Do not commit, push or deploy, and do not edit build files, CI config or test-gate files.",
    "If the request is ambiguous, reply with a single line `NEEDS_INFO: <question>` and change nothing.",
    `\n# Request: ${req.title}\n\n${req.body}`,
  ];
  if (req.done_when) parts.push(`\nDone when: ${req.done_when}`);
  if (req.done_when_test) parts.push(`\nDone when a test matching "${req.done_when_test}" passes.`);
  if (answers.length) parts.push(`\n# Answers to your earlier questions\n${answers.join("\n")}`);
  if (images.length) parts.push(`\n# Images attached to the request\nLook at each with the Read tool before you start:\n${images.map((p) => `- ${p}`).join("\n")}`);
  for (const scope of scopes) {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const path = join(j.wt, scope, name);
      if (existsSync(path)) parts.push(`\n# Project instructions (${scope}${name})\n\n${readFileSync(path, "utf8")}`);
    }
  }
  return parts.join("\n");
}

// Records push_started before pushing. Only the remote's state decides the outcome, never the exit code (D19).
async function push(j: Job, sha: string): Promise<"pushed" | "rejected" | "unknown"> {
  const setState = (state: PushState) => w(j.ctx, () => j.ctx.db.query("UPDATE runs SET push_state = ?, commit_sha = ? WHERE id = ?").run(state, sha, j.runId));
  setState("push_started");
  await g.push(j.repo, j.wt, j.remote, sha, j.branch);
  for (const wait of [0, ...(j.ctx.pushBackoffMs ?? DEFAULT_BACKOFF_MS)]) {
    if (wait) await Bun.sleep(wait);
    const live = await g.lsRemote(j.repo, j.remote, j.branch);
    if (live === null) continue;
    // Someone may have pushed on top of the commit already; it still counts as pushed.
    const pushed = live === sha || ((await g.fetch(j.repo, j.remote)).code === 0 && await g.isAncestor(j.repo, sha, `${j.remote}/${j.branch}`));
    setState(pushed ? "pushed" : "not_pushed");
    return pushed ? "pushed" : "rejected";
  }
  setState("push_unknown");
  return "unknown";
}

// Deploys each project in deploy order; a deploy command shared with an earlier project runs once. A failed
// deploy blocks its own group and those of the projects after it; the ones deployed before it stay live.
// A re-run deploy (`redeploy`) skips the projects whose targets already run this commit or a later one.
async function deploy(j: Job, sha: string, redeploy = false): Promise<Stop> {
  const done = new Set<string>();
  let ran = false;
  let later = false;
  let checkedOut = !redeploy;
  for (const [i, { name, recipe }] of j.parts.entries()) {
    if (!recipe.deploy_cmd || done.has(recipe.deploy_cmd)) continue;
    done.add(recipe.deploy_cmd);
    const fail = (reason: string) => post(j.parts.length > 1 ? `${name}: ${reason}` : reason, sha, groupsOf(j.parts.slice(i).filter((p) => p.recipe.deploy_cmd)));
    if (redeploy) {
      const plan = await redeployPlan(j, recipe, sha);
      if (typeof plan === "object") return fail(plan.error);
      if (plan !== "deploy") { later ||= plan === "later"; continue; }
      if (!checkedOut) await g.detachedWorktree(j.repo, j.wt, sha);
      checkedOut = true;
    }
    if (recipe.remote_busy_cmd) {
      const busy = await command(j, "remote_busy", recipe.remote_busy_cmd, { cwd: j.dir, timeout: "version", recipe });
      if (busy.exitCode === 0) return fail("previous install still running on the target");
      if (busy.exitCode !== 1) return fail(`could not check for a running install (exit ${busy.exitCode})`);
    }
    // Deploy builds unsandboxed with credentials, so nothing a sandboxed step wrote may survive (e.g. obj/*.targets).
    await g.cleanUntracked(j.wt);
    const refused = await checkDeployable(j.wt, sha);
    if (refused) return fail(refused);
    const d = await command(j, "deploy", recipe.deploy_cmd, { recipe });
    if (d.timedOut) return fail("deploy timed out: remote state unknown");
    if (d.exitCode !== 0) return fail(`deploy failed (exit ${d.exitCode})`);
    for (const t of recipe.targets ?? []) {
      const live = await liveVersion(j, recipe, t);
      if ("error" in live) return fail(`${t.name}: ${live.error}`);
      if (live.sha !== sha || live.uncommitted) return fail(`${t.name} runs ${live.short}${live.uncommitted ? "+uncommitted" : ""}, expected ${sha.slice(0, 7)}`);
    }
    ran = true;
  }
  if (ran) return { status: "done", reason: "deployed" };
  if (!redeploy) return { status: "done", reason: "built" };
  return { status: "done", reason: later ? `deployed by a later commit that contains ${sha.slice(0, 7)}` : "already live" };
}

// Re-run deploy never moves a target backwards (winhost review D14): every target must run this commit, an
// older one, or a later one that already contains it. Deploys only when some target is behind.
async function redeployPlan(j: Job, recipe: Recipe, sha: string): Promise<"deploy" | "live" | "later" | { error: string }> {
  let behind = false;
  let later = false;
  for (const t of recipe.targets ?? []) {
    const live = await liveVersion(j, recipe, t);
    if ("error" in live) return { error: `${t.name}: ${live.error}` };
    if (live.uncommitted) return { error: `${t.name} runs ${live.short}+uncommitted` };
    if (live.sha === sha) continue;
    if (await g.isAncestor(j.repo, live.sha, sha)) { behind = true; continue; }
    if (await g.isAncestor(j.repo, sha, live.sha)) { later = true; continue; }
    return { error: `${t.name} runs ${live.short}; deploying ${sha.slice(0, 7)} would roll it back` };
  }
  return behind ? "deploy" : later ? "later" : "live";
}

// Deploy only runs on exactly the pushed commit with no tracked changes (D6).
export async function checkDeployable(wt: string, sha: string): Promise<string | null> {
  const head = await g.headSha(wt);
  if (head !== sha) return `worktree is at ${head.slice(0, 7)}, not the pushed ${sha.slice(0, 7)}`;
  if (!await g.trackedClean(wt)) return "worktree has uncommitted changes";
  return null;
}

// Before touching a deploying group: every target must run a commit that origin already has (D5, D10). A
// drifted target blocks its own project's group.
async function driftGuard(j: Job): Promise<{ reason: string; group: number } | null> {
  const tracking = `${j.remote}/${j.branch}`;
  for (const { recipe, groupId } of distinct(j.parts, (p) => p.recipe.deploy_cmd)) {
    if (!recipe.deploy_cmd) continue;
    for (const t of recipe.targets ?? []) {
      const live = await liveVersion(j, recipe, t);
      const reason = "error" in live ? `can't read live version of ${t.name}: ${live.error}`
        : live.uncommitted ? `${t.name} runs ${live.short}+uncommitted`
        : !await g.isAncestor(j.repo, live.sha, tracking) ? `${t.name} runs ${live.short}, not on ${tracking}`
        : null;
      if (reason) return { reason, group: groupId };
    }
  }
  return null;
}

type LiveVersion = { sha: string; short: string; uncommitted: boolean } | { error: string };

// A live_version_cmd prints one short line; its log is never read whole (winhost review D15).
const VERSION_TAIL_BYTES = 64 * 1024;

async function liveVersion(j: Job, recipe: Recipe, t: Target): Promise<LiveVersion> {
  const r = await command(j, "version", t.live_version_cmd, { cwd: j.dir, recipe });
  if (r.exitCode !== 0) return { error: `live_version_cmd exited ${r.exitCode}` };
  const v = parseVersion(readTail(r.logPath, VERSION_TAIL_BYTES));
  if (!v) return { error: "no VERSION line in the output" };
  const sha = await g.resolveCommit(j.repo, v.short);
  if (!sha) return { error: `unknown or ambiguous commit ${v.short}` };
  return { sha, ...v };
}

// A VERSION line is "<short-sha>[+uncommitted] <date> <time>" (D10). The SHA must still be resolved (C1).
// "git fetch failed", with git's last line of complaint, so a paused runner says why.
function fetchFailed(r: g.GitResult): string {
  const why = r.err.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return why ? `git fetch failed: ${why}` : "git fetch failed";
}

export function parseVersion(text: string): { short: string; uncommitted: boolean } | null {
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{4,40})(\+uncommitted)?(\s|$)/);
    if (m) return { short: m[1], uncommitted: !!m[2] };
  }
  return null;
}

// Records a step row and the step's process group while it runs (D17).
function begin(j: Job, name: string) {
  const { db } = j.ctx;
  const logPath = join(j.dir, `${++j.n}-${name}.log`);
  const stepId = w(j.ctx, () => {
    db.query("UPDATE runs SET current_step = ? WHERE id = ?").run(name, j.runId);
    return db.query("INSERT INTO steps (run_id, step, started_at, log_path) VALUES (?, ?, ?, ?)").run(j.runId, name, Date.now(), logPath).lastInsertRowid;
  });
  return {
    logPath,
    onStart: (pgid: number) => w(j.ctx, () => db.query("UPDATE runs SET pgid = ? WHERE id = ?").run(pgid, j.runId)),
    end: (exitCode: number) => w(j.ctx, () => {
      db.query("UPDATE steps SET ended_at = ?, exit_code = ? WHERE id = ?").run(Date.now(), exitCode, stepId);
      db.query("UPDATE runs SET pgid = NULL WHERE id = ?").run(j.runId);
    }),
  };
}

// A step that serves the whole request (agent, verify) gets the longest timeout any of its recipes allows.
function longest(j: Job, step: StepName): number {
  return Math.max(...j.parts.map((p) => timeoutMs(p.recipe, step)));
}

// `recipe`: the project whose command this is, for its timeout; default the longest of the request's.
async function command(j: Job, name: string, cmd: string, o: { sandboxed?: boolean; cwd?: string; timeout?: StepName; recipe?: Recipe }): Promise<StepResult & { logPath: string }> {
  const s = begin(j, name);
  const step = o.timeout ?? (name as StepName);
  const r = await runStep(cmd, {
    cwd: o.cwd ?? j.wt, logPath: s.logPath, timeoutMs: o.recipe ? timeoutMs(o.recipe, step) : longest(j, step),
    wrap: o.sandboxed ? j.sbx!.wrap : undefined, env: o.sandboxed ? j.sbx!.env : undefined, onStart: s.onStart,
  });
  s.end(r.exitCode);
  return { ...r, logPath: s.logPath };
}
