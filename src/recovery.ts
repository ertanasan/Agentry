// Startup recovery: a runner calls `recover` right after it takes the lease and before it picks any work.
//
//  kill the recorded process group of every run this runner does not own (D17)
//    ─► delete leftover worktrees and run temp dirs, `git worktree prune` (D12)
//    ─► push_unknown runs: ask the remote, resolve to post-push or pre-push (D19)
//    ─► runs whose lease expired → interrupted; the remote decides the request's state:
//         origin has commit_sha (or a commit with its Agentry-Request trailer since base_sha) → blocked_post_push, group blocked
//         origin lacks it, or no push was ever started                                      → blocked_pre_push
//         origin unreachable after push_started                                             → push_unknown, group blocked
//
// The design lists prune before the kill. Worktrees are only deleted here once their processes are dead, so a
// killed deploy never runs from a directory that disappears underneath it.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PushState } from "./db.ts";
import * as g from "./git.ts";
import { killGroup, groupAlive } from "./proc.ts";
import type { Queue, RecoveryRun } from "./queue.ts";
import { parseRecipe } from "./recipe.ts";

export type RecoveryCtx = { q: Queue; home: string };

export type RecoveryReport = {
  killed: number[];
  worktreesRemoved: string[];
  resolved: { runId: number; result: Resolution }[];
  interrupted: { runId: number; requestId: number; status: "blocked_pre_push" | "blocked_post_push" }[];
  requeued: number[];  // requests claimed but never started by a runner of this holder that died
};

export type Resolution = "pushed" | "not_pushed" | "unknown";

export async function recover(ctx: RecoveryCtx, o: { graceMs?: number; now?: number } = {}): Promise<RecoveryReport> {
  const { q } = ctx;
  const report: RecoveryReport = { killed: [], worktreesRemoved: [], resolved: [], interrupted: [], requeued: [] };

  for (const r of await q.orphans()) {
    if (groupAlive(r.pgid)) {
      await killGroup(r.pgid, o.graceMs);
      report.killed.push(r.pgid);
    }
    q.setPgid(r.id, null);
  }

  report.worktreesRemoved = await removeLeftovers(ctx);

  for (const runId of await q.unresolvedPushes()) report.resolved.push({ runId, result: await resolvePushUnknown(ctx, runId) });

  report.interrupted = await recoverExpired(ctx, o.now ?? Date.now());
  report.requeued = await q.requeueStaleClaims();
  return report;
}

// This runner's runs whose lease expired → interrupted. At startup, and on every poll after it, so runs handed
// back by `agentry runner-key remove` are recovered without a restart (two-runners review D8).
export async function recoverExpired(ctx: RecoveryCtx, now = Date.now()): Promise<RecoveryReport["interrupted"]> {
  const out: RecoveryReport["interrupted"] = [];
  for (const run of await ctx.q.expiredRuns(now)) out.push({ runId: run.id, requestId: run.request_id, status: await interrupt(ctx, run, now) });
  return out;
}

// Every worktree left on disk belongs to a dead run: this runner holds the lease and has not started one yet.
async function removeLeftovers(ctx: RecoveryCtx): Promise<string[]> {
  const wtRoot = join(ctx.home, "worktrees");
  const removed = existsSync(wtRoot) ? readdirSync(wtRoot) : [];
  for (const name of removed) rmSync(join(wtRoot, name), { recursive: true, force: true });
  const runsRoot = join(ctx.home, "runs");
  for (const name of existsSync(runsRoot) ? readdirSync(runsRoot) : []) rmSync(join(runsRoot, name, "tmp"), { recursive: true, force: true });
  for (const repo of new Set((await ctx.q.projects()).map((p) => parseRecipe(p.recipe).repo))) {
    if (existsSync(repo)) await g.pruneWorktrees(repo);
  }
  return removed;
}

// Where the run's commit is on the remote: its SHA, null when origin doesn't have it, undefined when the
// remote can't be reached.
async function onRemote(run: RecoveryRun): Promise<string | null | undefined> {
  const recipe = parseRecipe(run.recipe);
  const remote = recipe.remote ?? "origin";
  const tracking = `${remote}/${recipe.branch ?? "main"}`;
  if ((await g.fetch(recipe.repo, remote)).code !== 0) return undefined;
  if (run.commit_sha && await g.isAncestor(recipe.repo, run.commit_sha, tracking)) return run.commit_sha;
  if (!run.base_sha) return null;
  const hit = await g.run(recipe.repo, ["log", "-1", "--format=%H", `--grep=^Agentry-Request: #${run.request_id}$`, `${run.base_sha}..${tracking}`]);
  return hit.code === 0 && hit.out ? hit.out : null;
}

// Asks the remote whether a push_unknown run's commit arrived. Pushed: the request stays blocked_post_push and
// its group stays blocked until it is deployed. Not pushed: blocked_pre_push and the group is freed (D19).
export async function resolvePushUnknown(ctx: RecoveryCtx, runId: number): Promise<Resolution> {
  const run = await ctx.q.recoveryRun(runId);
  if (!run || run.push_state !== "push_unknown") throw new Error(`run ${runId} has no unknown push`);
  if (!(await ctx.q.unresolvedPushes()).includes(runId)) throw new Error(`run ${runId} no longer decides its request's state`);
  const sha = await onRemote(run);
  if (sha === undefined) return "unknown";
  // The runner works on other requests meanwhile: a re-run deploy may have taken this one since the check above.
  if (!await ctx.q.resolvePush(run, sha)) return "unknown";
  return sha ? "pushed" : "not_pushed";
}

async function interrupt(ctx: RecoveryCtx, run: RecoveryRun, now: number): Promise<"blocked_pre_push" | "blocked_post_push"> {
  const stopped = `runner stopped during ${run.current_step ?? "setup"}`;
  const sha = await onRemote(run);
  // push_started is written (fenced) before every push, so without it nothing of this run can be on origin.
  let pushState: PushState = run.push_state;
  if (sha) pushState = "pushed";
  else if (run.push_state !== "none") pushState = sha === null ? "not_pushed" : "push_unknown";
  const post = pushState === "pushed" || pushState === "push_unknown";
  const reason = pushState === "pushed" ? `${stopped}; ${sha!.slice(0, 7)} is on origin, deploy not confirmed`
    : pushState === "push_unknown" ? `${stopped}; push outcome unknown for ${run.commit_sha?.slice(0, 7)}: origin unreachable`
    : stopped;
  const status = post ? "blocked_post_push" : "blocked_pre_push";
  await ctx.q.interrupt(run, { pushState, sha: sha ?? null, status, reason, post }, now);
  return status;
}
