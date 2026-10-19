// The runner: takes one queued request from a fresh worktree through the gates to push and deploy.
//
//  queued ─pick (group free)─► fetch ─► drift guard (D5/D10) ─► worktree@origin ─► AGENT [sandbox]
//    ▲                                       │ needs_info · no changes → blocked_pre_push · infra_error
//    │                                       ▼
//    │               CANDIDATE COMMIT (git add -A, D15) ─► INSPECT ─► needs_review ─approve─┐
//    │                                       ▼                                            │
//    │               BUILD [sandbox, D16] ─► TESTS [sandbox, TRX] ─► DONE-WHEN [D9] ◄──────┘
//    │                                       │ any fail · rebase conflict → blocked_pre_push
//    │               amend message; origin moved → rebase + re-gate ─► push_started ─► PUSH ─► ls-remote
//    │                                       │ remote unreachable → push_unknown, group blocked (D19)
//    │                                       ▼ origin has the commit
//    │               remote busy? (D18) ─► clean worktree ─► DEPLOY (D6) ─► live VERSION == sha (C1)
//    │                                       │ fail · timeout → blocked_post_push, group blocked
//    │                                       ▼
//    └── infra_error → queued (attempt not counted), runner paused              done
//
// Every stop removes the worktree and keeps the branch (D12). Every state write is fenced by the lease
// token (D17); the caller holds the lease and runs the heartbeat, which reads `ctx.currentRun`.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fenced, LeaseLost, LEASE_TTL_MS, runnerRow, setRequestStatus, type PushState, type RequestStatus } from "./db.ts";
import * as g from "./git.ts";
import { countRegression, inspect, type Flag } from "./inspect.ts";
import { runStep, type StepResult } from "./proc.ts";
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
  currentRun: number | null;
};

export type RunOutcome = { kind: "paused" | "idle" } | { kind: "ran"; requestId: number; status: RequestStatus };

type ReqRow = {
  id: number; project_id: number; title: string; body: string; done_when: string | null; done_when_test: string | null;
  attempts: number; resume_run: number | null; status: RequestStatus; recipe: string; deploy_group_id: number;
};
type RunRow = {
  id: number; attempt: number; branch: string; base_sha: string | null; candidate_sha: string | null;
  commit_sha: string | null; push_state: PushState;
};

type Stop = {
  status: RequestStatus;
  reason: string | null;
  requeue?: boolean;                               // back to queued; the attempt does not count
  pause?: boolean;                                 // infrastructure failure: pause the runner
  lock?: { reason: string; sha: string | null };   // block the deploy group
};

type Job = {
  ctx: RunnerCtx; req: ReqRow; recipe: Recipe; repo: string; remote: string; branch: string;
  runId: number; runBranch: string; wt: string; dir: string; base: string;
  prevAttempts: number; resumeFrom: number | null; flags: Flag[]; n: number; sbx?: Sandbox;
};

const DEFAULT_BACKOFF_MS = [2_000, 10_000, 30_000];

const pre = (reason: string): Stop => ({ status: "blocked_pre_push", reason });
const post = (reason: string, sha: string | null): Stop => ({ status: "blocked_post_push", reason, lock: { reason, sha } });
const infra = (reason: string): Stop => ({ status: "queued", reason, requeue: true, pause: true });

function w<T>(ctx: RunnerCtx, write: () => T): T {
  return fenced(ctx.db, ctx.token, write);
}

const REQ_COLUMNS = `r.id, r.project_id, r.title, r.body, r.done_when, r.done_when_test, r.attempts, r.resume_run, r.status,
  p.recipe, p.deploy_group_id`;

// Highest priority, then oldest, among queued requests of enabled projects whose deploy group is free.
function pick(db: Database): ReqRow | null {
  return db.query(`SELECT ${REQ_COLUMNS} FROM requests r
    JOIN projects p ON p.id = r.project_id JOIN deploy_groups dg ON dg.id = p.deploy_group_id
    WHERE r.status = 'queued' AND p.enabled = 1 AND dg.lock = 'free'
    ORDER BY r.priority DESC, r.created_at, r.id LIMIT 1`).get() as ReqRow | null;
}

export async function runNext(ctx: RunnerCtx): Promise<RunOutcome> {
  if (runnerRow(ctx.db).paused) return { kind: "paused" };
  const req = pick(ctx.db);
  if (!req) return { kind: "idle" };
  const resume = req.resume_run ? ctx.db.query("SELECT * FROM runs WHERE id = ?").get(req.resume_run) as RunRow : null;
  const attempt = resume ? resume.attempt : req.attempts + 1;
  const j = startRun(ctx, req, {
    attempt, branch: resume?.branch ?? `agentry/${req.id}-${attempt}`, base: resume?.base_sha ?? null, candidate: resume?.candidate_sha ?? null,
  });
  return { kind: "ran", requestId: req.id, status: await execute(j, () => pipeline(j, resume !== null)) };
}

// "Re-run deploy" for a blocked_post_push request: steps 9-10 for its recorded commit, from a fresh worktree.
export async function redeploy(ctx: RunnerCtx, requestId: number): Promise<RequestStatus> {
  const req = ctx.db.query(`SELECT ${REQ_COLUMNS} FROM requests r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`).get(requestId) as ReqRow | null;
  if (!req || req.status !== "blocked_post_push") throw new Error(`request #${requestId} is not blocked after push`);
  const last = ctx.db.query("SELECT * FROM runs WHERE request_id = ? AND commit_sha IS NOT NULL ORDER BY id DESC LIMIT 1").get(requestId) as RunRow | null;
  if (!last?.commit_sha) throw new Error(`request #${requestId} has no pushed commit`);
  const sha = last.commit_sha;
  const j = startRun(ctx, req, {
    attempt: last.attempt, branch: last.branch, base: last.base_sha, candidate: last.candidate_sha, commit: sha, pushState: last.push_state,
  });
  return execute(j, async () => {
    if (g.fetch(j.repo, j.remote).code !== 0) throw new Error("git fetch failed");
    if (!g.isAncestor(j.repo, sha, `${j.remote}/${j.branch}`)) throw new Error(`${sha.slice(0, 7)} is not on ${j.remote}/${j.branch}`);
    g.detachedWorktree(j.repo, j.wt, sha);
    return deploy(j, sha);
  });
}

function startRun(ctx: RunnerCtx, req: ReqRow, o: {
  attempt: number; branch: string; base: string | null; candidate: string | null; commit?: string; pushState?: PushState;
}): Job {
  const recipe = parseRecipe(req.recipe);
  const now = Date.now();
  const runId = w(ctx, () => {
    ctx.db.query("UPDATE requests SET attempts = ?, resume_run = NULL WHERE id = ?").run(o.attempt, req.id);
    setRequestStatus(ctx.db, req.id, "running", null, now);
    return Number(ctx.db.query(`INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, base_sha,
      candidate_sha, commit_sha, push_state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.id, o.attempt, ctx.token, now + LEASE_TTL_MS, o.branch, o.base, o.candidate, o.commit ?? null, o.pushState ?? "none", now)
      .lastInsertRowid);
  });
  ctx.currentRun = runId;
  const dir = join(ctx.home, "runs", String(runId));
  mkdirSync(dir, { recursive: true });
  return {
    ctx, req, recipe, repo: recipe.repo, remote: recipe.remote ?? "origin", branch: recipe.branch ?? "main",
    runId, runBranch: o.branch, wt: join(ctx.home, "worktrees", `${req.id}-${o.attempt}`), dir, base: o.base ?? "",
    prevAttempts: req.attempts, resumeFrom: req.resume_run, flags: [], n: 0,
  };
}

async function execute(j: Job, body: () => Promise<Stop>): Promise<RequestStatus> {
  let s: Stop;
  try {
    s = await body();
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const run = j.ctx.db.query("SELECT push_state, commit_sha FROM runs WHERE id = ?").get(j.runId) as RunRow;
    // Once a push has started, origin may have the commit: never requeue (D19).
    s = run.push_state === "none" ? infra(`runner error: ${msg}`) : post(`runner error after push started: ${msg}`, run.commit_sha);
  } finally {
    if (existsSync(j.wt)) g.removeWorktree(j.repo, j.wt);
    rmSync(join(j.dir, "tmp"), { recursive: true, force: true });
    j.ctx.currentRun = null;
  }
  finish(j, s);
  return s.status;
}

function finish(j: Job, s: Stop): void {
  const { db } = j.ctx;
  const id = j.req.id;
  const group = j.req.deploy_group_id;
  const now = Date.now();
  w(j.ctx, () => {
    const runStatus = s.status === "done" ? "passed" : s.requeue ? "interrupted" : "failed";
    db.query("UPDATE runs SET status = ?, current_step = NULL, pgid = NULL, flags = ?, ended_at = ? WHERE id = ?")
      .run(runStatus, JSON.stringify(j.flags), now, j.runId);
    if (s.requeue) db.query("UPDATE requests SET attempts = ?, resume_run = ? WHERE id = ?").run(j.prevAttempts, j.resumeFrom, id);
    setRequestStatus(db, id, s.status, s.reason, now);
    if (s.pause) db.query("UPDATE runner SET paused = 1, pause_reason = ? WHERE id = 1").run(s.reason);
    if (s.lock) {
      db.query("UPDATE deploy_groups SET lock = 'blocked', lock_reason = ?, locked_by_request = ?, undeployed_sha = ? WHERE id = ?")
        .run(s.lock.reason, s.lock.sha ? id : null, s.lock.sha, group);
    }
    if (s.status === "done") {
      db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, locked_by_request = NULL, undeployed_sha = NULL WHERE id = ? AND locked_by_request = ?")
        .run(group, id);
    }
  });
}

async function pipeline(j: Job, resumed: boolean): Promise<Stop> {
  if (g.fetch(j.repo, j.remote).code !== 0) return infra("git fetch failed");
  const drift = await driftGuard(j);
  if (drift) return { status: "queued", reason: drift, requeue: true, lock: { reason: drift, sha: null } };

  if (resumed) {
    g.checkoutWorktree(j.repo, j.wt, j.runBranch);
  } else {
    j.base = g.remoteHead(j.repo, j.remote, j.branch);
    w(j.ctx, () => j.ctx.db.query("UPDATE runs SET base_sha = ? WHERE id = ?").run(j.base, j.runId));
    g.addWorktree(j.repo, j.wt, j.runBranch, j.base);
  }
  j.sbx = sandbox({
    worktree: j.wt, runTmp: join(j.dir, "tmp"), gitDir: g.commonDir(j.repo), claudeBin: j.ctx.claudeBin,
    keyHelper: j.ctx.keyHelper, pkgCache: join(j.ctx.home, "cache", "nuget"),
  });

  if (!resumed) {
    const stopped = (await agentStep(j)) ?? tampered(j, "agent");
    if (stopped) return stopped;
    const candidate = g.candidateCommit(j.wt, `agentry: candidate for #${j.req.id}`);
    if (!candidate) return pre("the agent made no changes");
    w(j.ctx, () => j.ctx.db.query("UPDATE runs SET candidate_sha = ? WHERE id = ?").run(candidate, j.runId));
  }
  return deliver(j, resumed);
}

// Gates, commit message, rebase if origin moved, push, deploy. `approved` skips the review flags.
async function deliver(j: Job, approved: boolean): Promise<Stop> {
  let stopped = await gates(j, approved);
  if (stopped) return stopped;
  let sha = g.amendMessage(j.wt, commitMessage(j.req));
  for (let round = 0; ; round++) {
    if (g.fetch(j.repo, j.remote).code !== 0) return infra("git fetch failed");
    const head = g.remoteHead(j.repo, j.remote, j.branch);
    if (!g.isAncestor(j.repo, head, sha)) {
      if (!g.rebaseOnto(j.wt, `${j.remote}/${j.branch}`)) return pre(`rebase onto ${j.remote}/${j.branch} had conflicts`);
      j.base = head;
      sha = g.headSha(j.wt);
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
}

function commitMessage(r: ReqRow): string {
  return `${r.title}\n\n${r.body ? r.body + "\n\n" : ""}Agentry-Request: #${r.id}`;
}

// Step 4 (inspect), unless approved, then build, tests and the done-when check on the worktree's HEAD.
async function gates(j: Job, approved: boolean): Promise<Stop | null> {
  const { recipe, req } = j;
  const head = g.headSha(j.wt);
  if (!approved) {
    const found = inspect(g.changedFiles(j.wt, j.base, head), g.addedLines(j.wt, j.base, head), recipe);
    j.flags = [...found.blocking, ...found.info];
    if (found.blocking.length) return { status: "needs_review", reason: describe(found.blocking) };
  }

  if (recipe.build_cmd) {
    const b = await command(j, "build", recipe.build_cmd, { sandboxed: true });
    const t = tampered(j, "build");
    if (t) return t;
    if (b.exitCode !== 0) return pre(b.timedOut ? "build timed out" : `build failed (exit ${b.exitCode})`);
  }
  const resultFile = recipe.test_result_file ? join(j.wt, recipe.test_result_file) : null;
  if (resultFile) rmSync(resultFile, { force: true });
  const t = await command(j, "test", recipe.test_cmd, { sandboxed: true });
  const changed = tampered(j, "test");
  if (changed) return changed;
  if (t.exitCode !== 0) return pre(t.timedOut ? "tests timed out" : `tests failed (exit ${t.exitCode})`);
  if (!g.trackedClean(j.wt)) return pre("the tests changed tracked files");

  let run: TestRun | null = null;
  if (resultFile) {
    if (!existsSync(resultFile)) return pre(`no test results at ${recipe.test_result_file}`);
    run = parseTrx(readFileSync(resultFile, "utf8"));
    w(j.ctx, () => j.ctx.db.query("UPDATE runs SET tests_total = ?, tests_skipped = ? WHERE id = ?").run(run!.total, run!.skipped, j.runId));
    const regression = approved ? null : countRegression(run, baseCounts(j));
    if (regression) {
      j.flags.push(regression);
      return { status: "needs_review", reason: describe([regression]) };
    }
  }

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
      worktree: j.wt, logPath: s.logPath, timeoutMs: timeoutMs(recipe, "verify"), sandbox: j.sbx!, onStart: s.onStart,
      title: req.title, body: req.body, doneWhen: req.done_when, diff: g.diff(j.wt, j.base, head), testSummary: summary(run, t),
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

// Test counts of the project's last passing run, the baseline for deleted or skipped tests.
function baseCounts(j: Job): { total: number; skipped: number } | null {
  return j.ctx.db.query(`SELECT ru.tests_total AS total, ru.tests_skipped AS skipped FROM runs ru
    JOIN requests r ON r.id = ru.request_id
    WHERE r.project_id = ? AND ru.status = 'passed' AND ru.tests_total IS NOT NULL ORDER BY ru.id DESC LIMIT 1`)
    .get(j.req.project_id) as { total: number; skipped: number } | null;
}

async function agentStep(j: Job): Promise<Stop | null> {
  const s = begin(j, "agent");
  const res = await j.ctx.agent.run({
    worktree: j.wt, logPath: s.logPath, timeoutMs: timeoutMs(j.recipe, "agent"), sandbox: j.sbx!, onStart: s.onStart, prompt: prompt(j),
  });
  s.end(res.outcome === "infra_error" ? 1 : 0);
  if (res.outcome === "infra_error") return infra(`agent: ${res.detail}`);
  if (res.outcome === "needs_info") return { status: "needs_info", reason: res.question };
  return null;
}

function prompt(j: Job): string {
  const { req, recipe } = j;
  const answers = (j.ctx.db.query("SELECT payload FROM events WHERE request_id = ? AND type = 'answer' ORDER BY id").all(req.id) as { payload: string }[])
    .map((r) => `- ${(JSON.parse(r.payload) as { text: string }).text}`);
  const parts = [
    `You are working on request #${req.id}. Keep your changes under ${recipe.scope_path}. If the request needs a change`,
    "elsewhere in the repository (a test in another project, an API the code calls), make it: it is allowed, and it sends",
    "the change to human review.",
    "Rules: edit code only. Do not commit, push or deploy, and do not edit build files, CI config or test-gate files.",
    "If the request is ambiguous, reply with a single line `NEEDS_INFO: <question>` and change nothing.",
    `\n# Request: ${req.title}\n\n${req.body}`,
  ];
  if (req.done_when) parts.push(`\nDone when: ${req.done_when}`);
  if (req.done_when_test) parts.push(`\nDone when a test matching "${req.done_when_test}" passes.`);
  if (answers.length) parts.push(`\n# Answers to your earlier questions\n${answers.join("\n")}`);
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(j.wt, recipe.scope_path, name);
    if (existsSync(path)) parts.push(`\n# Project instructions (${recipe.scope_path}${name})\n\n${readFileSync(path, "utf8")}`);
  }
  return parts.join("\n");
}

// Records push_started before pushing. Only the remote's state decides the outcome, never the exit code (D19).
async function push(j: Job, sha: string): Promise<"pushed" | "rejected" | "unknown"> {
  const setState = (state: PushState) => w(j.ctx, () => j.ctx.db.query("UPDATE runs SET push_state = ?, commit_sha = ? WHERE id = ?").run(state, sha, j.runId));
  setState("push_started");
  g.push(j.wt, j.remote, sha, j.branch);
  for (const wait of [0, ...(j.ctx.pushBackoffMs ?? DEFAULT_BACKOFF_MS)]) {
    if (wait) await Bun.sleep(wait);
    const live = g.lsRemote(j.repo, j.remote, j.branch);
    if (live === null) continue;
    // Someone may have pushed on top of the commit already; it still counts as pushed.
    const pushed = live === sha || (g.fetch(j.repo, j.remote).code === 0 && g.isAncestor(j.repo, sha, `${j.remote}/${j.branch}`));
    setState(pushed ? "pushed" : "not_pushed");
    return pushed ? "pushed" : "rejected";
  }
  setState("push_unknown");
  return "unknown";
}

async function deploy(j: Job, sha: string): Promise<Stop> {
  const { recipe } = j;
  if (!recipe.deploy_cmd) return { status: "done", reason: "built" };
  if (recipe.remote_busy_cmd) {
    const busy = await command(j, "remote_busy", recipe.remote_busy_cmd, { cwd: j.dir, timeout: "version" });
    if (busy.exitCode === 0) return post("previous install still running on the target", sha);
    if (busy.exitCode !== 1) return post(`could not check for a running install (exit ${busy.exitCode})`, sha);
  }
  // Deploy builds unsandboxed with credentials, so nothing a sandboxed step wrote may survive (e.g. obj/*.targets).
  g.cleanUntracked(j.wt);
  const refused = checkDeployable(j.wt, sha);
  if (refused) return post(refused, sha);
  const d = await command(j, "deploy", recipe.deploy_cmd, {});
  if (d.timedOut) return post("deploy timed out: remote state unknown", sha);
  if (d.exitCode !== 0) return post(`deploy failed (exit ${d.exitCode})`, sha);
  for (const t of recipe.targets ?? []) {
    const live = await liveVersion(j, t);
    if ("error" in live) return post(`${t.name}: ${live.error}`, sha);
    if (live.sha !== sha || live.uncommitted) return post(`${t.name} runs ${live.short}${live.uncommitted ? "+uncommitted" : ""}, expected ${sha.slice(0, 7)}`, sha);
  }
  return { status: "done", reason: "deployed" };
}

// Deploy only runs on exactly the pushed commit with no tracked changes (D6).
export function checkDeployable(wt: string, sha: string): string | null {
  const head = g.headSha(wt);
  if (head !== sha) return `worktree is at ${head.slice(0, 7)}, not the pushed ${sha.slice(0, 7)}`;
  if (!g.trackedClean(wt)) return "worktree has uncommitted changes";
  return null;
}

// Before touching a deploying group: every target must run a commit that origin already has (D5, D10).
async function driftGuard(j: Job): Promise<string | null> {
  if (!j.recipe.deploy_cmd) return null;
  const tracking = `${j.remote}/${j.branch}`;
  for (const t of j.recipe.targets ?? []) {
    const live = await liveVersion(j, t);
    if ("error" in live) return `can't read live version of ${t.name}: ${live.error}`;
    if (live.uncommitted) return `${t.name} runs ${live.short}+uncommitted`;
    if (!g.isAncestor(j.repo, live.sha, tracking)) return `${t.name} runs ${live.short}, not on ${tracking}`;
  }
  return null;
}

type LiveVersion = { sha: string; short: string; uncommitted: boolean } | { error: string };

async function liveVersion(j: Job, t: Target): Promise<LiveVersion> {
  const r = await command(j, "version", t.live_version_cmd, { cwd: j.dir });
  if (r.exitCode !== 0) return { error: `live_version_cmd exited ${r.exitCode}` };
  const v = parseVersion(r.log);
  if (!v) return { error: "no VERSION line in the output" };
  const sha = g.resolveCommit(j.repo, v.short);
  if (!sha) return { error: `unknown or ambiguous commit ${v.short}` };
  return { sha, ...v };
}

// A VERSION line is "<short-sha>[+uncommitted] <date> <time>" (D10). The SHA must still be resolved (C1).
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

async function command(j: Job, name: string, cmd: string, o: { sandboxed?: boolean; cwd?: string; timeout?: StepName }): Promise<StepResult & { log: string }> {
  const s = begin(j, name);
  const r = await runStep(cmd, {
    cwd: o.cwd ?? j.wt, logPath: s.logPath, timeoutMs: timeoutMs(j.recipe, o.timeout ?? (name as StepName)),
    wrap: o.sandboxed ? j.sbx!.wrap : undefined, env: o.sandboxed ? j.sbx!.env : undefined, onStart: s.onStart,
  });
  s.end(r.exitCode);
  return { ...r, log: readFileSync(s.logPath, "utf8") };
}
