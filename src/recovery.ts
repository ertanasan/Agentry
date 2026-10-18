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
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fenced, setRequestStatus, type PushState } from "./db.ts";
import * as g from "./git.ts";
import { killGroup, groupAlive } from "./proc.ts";
import { parseRecipe } from "./recipe.ts";

export type RecoveryCtx = { db: Database; token: string; home: string };

export type RecoveryReport = {
  killed: number[];
  worktreesRemoved: string[];
  resolved: { runId: number; result: Resolution }[];
  interrupted: { runId: number; requestId: number; status: "blocked_pre_push" | "blocked_post_push" }[];
};

export type Resolution = "pushed" | "not_pushed" | "unknown";

type RunRow = {
  id: number; request_id: number; current_step: string | null; pgid: number | null; base_sha: string | null;
  commit_sha: string | null; push_state: PushState; recipe: string; deploy_group_id: number;
};

const RUN_COLUMNS = `ru.id, ru.request_id, ru.current_step, ru.pgid, ru.base_sha, ru.commit_sha, ru.push_state,
  p.recipe, p.deploy_group_id`;
const RUN_JOIN = "FROM runs ru JOIN requests r ON r.id = ru.request_id JOIN projects p ON p.id = r.project_id";

export async function recover(ctx: RecoveryCtx, o: { graceMs?: number; now?: number } = {}): Promise<RecoveryReport> {
  const { db, token } = ctx;
  const w = <T>(write: () => T) => fenced(db, token, write);
  const report: RecoveryReport = { killed: [], worktreesRemoved: [], resolved: [], interrupted: [] };

  const orphans = db.query(`SELECT id, pgid FROM runs WHERE status = 'running' AND pgid IS NOT NULL
    AND (lease_token IS NULL OR lease_token != ?)`).all(token) as { id: number; pgid: number }[];
  for (const r of orphans) {
    if (groupAlive(r.pgid)) {
      await killGroup(r.pgid, o.graceMs);
      report.killed.push(r.pgid);
    }
    w(() => db.query("UPDATE runs SET pgid = NULL WHERE id = ?").run(r.id));
  }

  report.worktreesRemoved = removeLeftovers(ctx);

  const unknown = db.query(`SELECT ru.id ${RUN_JOIN} WHERE ru.push_state = 'push_unknown' AND ru.status != 'running'`).all() as { id: number }[];
  for (const r of unknown) report.resolved.push({ runId: r.id, result: resolvePushUnknown(ctx, r.id) });

  const now = o.now ?? Date.now();
  const expired = db.query(`SELECT ${RUN_COLUMNS} ${RUN_JOIN} WHERE ru.status = 'running' AND ru.lease_expires_at < ?
    AND (ru.lease_token IS NULL OR ru.lease_token != ?)`).all(now, token) as RunRow[];
  for (const run of expired) {
    const status = interrupt(ctx, run, now);
    report.interrupted.push({ runId: run.id, requestId: run.request_id, status });
  }
  return report;
}

// Every worktree left on disk belongs to a dead run: this runner holds the lease and has not started one yet.
function removeLeftovers(ctx: RecoveryCtx): string[] {
  const wtRoot = join(ctx.home, "worktrees");
  const removed = existsSync(wtRoot) ? readdirSync(wtRoot) : [];
  for (const name of removed) rmSync(join(wtRoot, name), { recursive: true, force: true });
  const runsRoot = join(ctx.home, "runs");
  for (const name of existsSync(runsRoot) ? readdirSync(runsRoot) : []) rmSync(join(runsRoot, name, "tmp"), { recursive: true, force: true });
  const recipes = ctx.db.query("SELECT recipe FROM projects").all() as { recipe: string }[];
  for (const repo of new Set(recipes.map((p) => parseRecipe(p.recipe).repo))) {
    if (existsSync(repo)) g.pruneWorktrees(repo);
  }
  return removed;
}

// Where the run's commit is on the remote: its SHA, null when origin doesn't have it, undefined when the
// remote can't be reached.
function onRemote(run: RunRow): string | null | undefined {
  const recipe = parseRecipe(run.recipe);
  const remote = recipe.remote ?? "origin";
  const tracking = `${remote}/${recipe.branch ?? "main"}`;
  if (g.fetch(recipe.repo, remote).code !== 0) return undefined;
  if (run.commit_sha && g.isAncestor(recipe.repo, run.commit_sha, tracking)) return run.commit_sha;
  if (!run.base_sha) return null;
  const hit = g.git(recipe.repo, ["log", "-1", "--format=%H", `--grep=^Agentry-Request: #${run.request_id}$`, `${run.base_sha}..${tracking}`]);
  return hit.code === 0 && hit.out ? hit.out : null;
}

// Asks the remote whether a push_unknown run's commit arrived. Pushed: the request stays blocked_post_push and
// its group stays blocked until it is deployed. Not pushed: blocked_pre_push and the group is freed (D19).
export function resolvePushUnknown(ctx: RecoveryCtx, runId: number): Resolution {
  const { db } = ctx;
  const run = db.query(`SELECT ${RUN_COLUMNS} ${RUN_JOIN} WHERE ru.id = ?`).get(runId) as RunRow | null;
  if (!run || run.push_state !== "push_unknown") throw new Error(`run ${runId} has no unknown push`);
  const sha = onRemote(run);
  if (sha === undefined) return "unknown";
  fenced(db, ctx.token, () => {
    if (sha) {
      db.query("UPDATE runs SET push_state = 'pushed', commit_sha = ? WHERE id = ?").run(sha, run.id);
      setRequestStatus(db, run.request_id, "blocked_post_push", `${sha.slice(0, 7)} is on origin; deploy not run`);
      lockGroup(db, run, `${sha.slice(0, 7)} pushed, not deployed`, sha);
    } else {
      db.query("UPDATE runs SET push_state = 'not_pushed' WHERE id = ?").run(run.id);
      setRequestStatus(db, run.request_id, "blocked_pre_push", "push did not reach origin");
      db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, locked_by_request = NULL, undeployed_sha = NULL WHERE id = ? AND locked_by_request = ?")
        .run(run.deploy_group_id, run.request_id);
    }
  });
  return sha ? "pushed" : "not_pushed";
}

function interrupt(ctx: RecoveryCtx, run: RunRow, now: number): "blocked_pre_push" | "blocked_post_push" {
  const { db } = ctx;
  const stopped = `runner stopped during ${run.current_step ?? "setup"}`;
  const sha = onRemote(run);
  // push_started is written (fenced) before every push, so without it nothing of this run can be on origin.
  let pushState: PushState = run.push_state;
  if (sha) pushState = "pushed";
  else if (run.push_state !== "none") pushState = sha === null ? "not_pushed" : "push_unknown";
  const post = pushState === "pushed" || pushState === "push_unknown";
  const reason = pushState === "pushed" ? `${stopped}; ${sha!.slice(0, 7)} is on origin, deploy not confirmed`
    : pushState === "push_unknown" ? `${stopped}; push outcome unknown for ${run.commit_sha?.slice(0, 7)}: origin unreachable`
    : stopped;
  const status = post ? "blocked_post_push" : "blocked_pre_push";
  fenced(db, ctx.token, () => {
    db.query("UPDATE runs SET status = 'interrupted', current_step = NULL, pgid = NULL, push_state = ?, commit_sha = ?, ended_at = ? WHERE id = ?")
      .run(pushState, sha || run.commit_sha, now, run.id);
    setRequestStatus(db, run.request_id, status, reason, now);
    if (post) lockGroup(db, run, reason, sha || run.commit_sha);
  });
  return status;
}

function lockGroup(db: Database, run: RunRow, reason: string, sha: string | null): void {
  db.query("UPDATE deploy_groups SET lock = 'blocked', lock_reason = ?, locked_by_request = ?, undeployed_sha = ? WHERE id = ?")
    .run(reason, run.request_id, sha, run.deploy_group_id);
}
