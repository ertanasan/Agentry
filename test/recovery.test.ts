// Startup recovery (T1, T9): orphaned process groups, leftover worktrees, push_unknown and interrupted runs,
// against a fixture repo with a bare origin. A crashed runner is either simulated in the db (token "old",
// expired lease) or, for the orphan test, a real runner process that is SIGKILLed mid-step.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, LEASE_TTL_MS, openDb, type PushState } from "../src/db.ts";
import * as g from "../src/git.ts";
import { groupAlive, killGroup } from "../src/proc.ts";
import { recover, resolvePushUnknown } from "../src/recovery.ts";
import type { Recipe } from "../src/recipe.ts";
import { head, makeFixture } from "./fixture.ts";

function setup() {
  const fx = makeFixture({ "README.md": "hello\n", "app/main.txt": "v1\n" });
  const home = join(fx.root, "agentry");
  mkdirSync(home);
  const dbPath = join(home, "agentry.db");
  const db = openDb(dbPath);
  const recipe: Recipe = { repo: fx.repo, deploy_group: "g1", scope_path: "app/", test_cmd: "true" };
  db.query("INSERT INTO repos (name, path) VALUES ('repo', ?)").run(fx.repo);
  db.query("INSERT INTO deploy_groups (name) VALUES ('g1')").run();
  db.query("INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('p', 1, 1, ?)").run(JSON.stringify(recipe));
  const id = Number(db.query("INSERT INTO requests (project_id, title, status, created_at, updated_at) VALUES (1, 'Change main', 'running', 0, 0)").run().lastInsertRowid);
  const initial = head(fx.repo);
  const ctx = { db, token: "new", home };
  return {
    fx, db, dbPath, home, ctx, id, initial,
    // A run left behind by runner "old", whose lease has expired.
    crashed: (r: { push_state?: PushState; commit_sha?: string | null; base_sha?: string | null; step?: string } = {}) => {
      db.query("UPDATE runner SET owner_token = 'old', owner_pid = 1, lease_expires_at = 1").run();
      return Number(db.query(`INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, current_step, base_sha,
        commit_sha, push_state, started_at) VALUES (?, 1, 'old', 1, 'agentry/1-1', ?, ?, ?, ?, 0)`)
        .run(id, r.step ?? "push", r.base_sha === undefined ? initial : r.base_sha, r.commit_sha ?? null, r.push_state ?? "none").lastInsertRowid);
    },
    takeOver: () => expect(acquireLease(db, "new", process.pid)).toBe(true),
    req: () => db.query("SELECT * FROM requests WHERE id = ?").get(id) as any,
    run: (runId: number) => db.query("SELECT * FROM runs WHERE id = ?").get(runId) as any,
    group: () => db.query("SELECT * FROM deploy_groups WHERE id = 1").get() as any,
    // A commit on origin/main, as if the crashed runner's push had gone through.
    pushed: (msg: string) => { fx.write("app/main.txt", `${msg}\n`); const sha = fx.commit(msg); g.git(fx.repo, ["push", "--quiet", "origin", "main"]); return sha; },
    // A commit that exists locally but never reached origin.
    unpushed: () => { fx.write("app/main.txt", "local\n"); const sha = fx.commit("local only"); g.git(fx.repo, ["reset", "--quiet", "--hard", "HEAD~1"]); return sha; },
    originOffline: () => renameSync(fx.origin, `${fx.origin}.off`),
    originOnline: () => renameSync(`${fx.origin}.off`, fx.origin),
  };
}

describe("recovery: interrupted runs, decided by the remote", () => {
  test("commit_sha on origin → blocked_post_push, group blocked with the undeployed sha", async () => {
    const h = setup();
    const sha = h.pushed("agentry change");
    const runId = h.crashed({ push_state: "push_started", commit_sha: sha, step: "deploy" });
    h.takeOver();
    const rep = await recover(h.ctx);
    expect(rep.interrupted).toEqual([{ runId, requestId: h.id, status: "blocked_post_push" }]);
    expect(h.run(runId)).toMatchObject({ status: "interrupted", push_state: "pushed", current_step: null });
    expect(h.req()).toMatchObject({ status: "blocked_post_push", status_reason: `runner stopped during deploy; ${sha.slice(0, 7)} is on origin, deploy not confirmed` });
    expect(h.group()).toMatchObject({ lock: "blocked", locked_by_request: h.id, undeployed_sha: sha });
  });

  test("no recorded sha, but a commit with the request's trailer on origin since base → post-push", async () => {
    const h = setup();
    const sha = h.pushed(`Change main\n\nAgentry-Request: #${h.id}`);
    const runId = h.crashed({ push_state: "push_started", commit_sha: null });
    h.takeOver();
    await recover(h.ctx);
    expect(h.run(runId)).toMatchObject({ push_state: "pushed", commit_sha: sha });
    expect(h.group()).toMatchObject({ lock: "blocked", undeployed_sha: sha });
  });

  test("a trailer commit from before base_sha does not count", async () => {
    const h = setup();
    h.pushed(`Old attempt\n\nAgentry-Request: #${h.id}`);
    const runId = h.crashed({ push_state: "push_started", commit_sha: null, base_sha: head(h.fx.repo) });
    h.takeOver();
    await recover(h.ctx);
    expect(h.run(runId).push_state).toBe("not_pushed");
    expect(h.req().status).toBe("blocked_pre_push");
  });

  test("push started but the commit is not on origin → blocked_pre_push, group free", async () => {
    const h = setup();
    const runId = h.crashed({ push_state: "push_started", commit_sha: h.unpushed() });
    h.takeOver();
    await recover(h.ctx);
    expect(h.run(runId)).toMatchObject({ status: "interrupted", push_state: "not_pushed" });
    expect(h.req()).toMatchObject({ status: "blocked_pre_push", status_reason: "runner stopped during push" });
    expect(h.group().lock).toBe("free");
  });

  test("no push started and origin unreachable → still pre-push, nothing blocked", async () => {
    const h = setup();
    const runId = h.crashed({ step: "test" });
    h.originOffline();
    h.takeOver();
    await recover(h.ctx);
    expect(h.run(runId).push_state).toBe("none");
    expect(h.req()).toMatchObject({ status: "blocked_pre_push", status_reason: "runner stopped during test" });
    expect(h.group().lock).toBe("free");
  });

  test("push started and origin unreachable → push_unknown, group blocked; a later start resolves it (D19)", async () => {
    const h = setup();
    const sha = h.unpushed();
    const runId = h.crashed({ push_state: "push_started", commit_sha: sha });
    h.originOffline();
    h.takeOver();
    await recover(h.ctx);
    expect(h.run(runId).push_state).toBe("push_unknown");
    expect(h.req().status).toBe("blocked_post_push");
    expect(h.group()).toMatchObject({ lock: "blocked", locked_by_request: h.id, undeployed_sha: sha });

    expect(await resolvePushUnknown(h.ctx, runId)).toBe("unknown");
    h.originOnline();
    const rep = await recover(h.ctx);
    expect(rep.resolved).toEqual([{ runId, result: "not_pushed" }]);
    expect(h.req()).toMatchObject({ status: "blocked_pre_push", status_reason: "push did not reach origin" });
    expect(h.group()).toMatchObject({ lock: "free", locked_by_request: null, undeployed_sha: null });
  });

  test("a push_unknown whose commit did arrive resolves to post-push and keeps the group blocked", async () => {
    const h = setup();
    const sha = h.pushed("arrived");
    const runId = h.crashed({ push_state: "push_unknown", commit_sha: sha });
    h.db.query("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
    h.db.query("UPDATE requests SET status = 'blocked_post_push'").run();
    h.db.query("UPDATE deploy_groups SET lock = 'blocked', locked_by_request = ?, undeployed_sha = ?").run(h.id, sha);
    h.takeOver();
    const rep = await recover(h.ctx);
    expect(rep.resolved).toEqual([{ runId, result: "pushed" }]);
    expect(h.run(runId).push_state).toBe("pushed");
    expect(h.req()).toMatchObject({ status: "blocked_post_push", status_reason: `${sha.slice(0, 7)} is on origin; deploy not run` });
    expect(h.group()).toMatchObject({ lock: "blocked", undeployed_sha: sha });
  });

  test("this runner's own live runs are left alone", async () => {
    const h = setup();
    h.takeOver();
    const runId = Number(h.db.query(`INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, started_at)
      VALUES (?, 1, 'new', ?, 'agentry/1-1', 0)`).run(h.id, Date.now() + LEASE_TTL_MS).lastInsertRowid);
    const rep = await recover(h.ctx);
    expect(rep.interrupted).toEqual([]);
    expect(h.run(runId).status).toBe("running");
  });
});

describe("recovery: leftovers", () => {
  test("leftover worktrees are deleted and pruned; the branch survives and can be checked out again (D12)", async () => {
    const h = setup();
    const wt = join(h.home, "worktrees", "1-1");
    await g.addWorktree(h.fx.repo, wt, "agentry/1-1", h.initial);
    writeFileSync(join(wt, "app/main.txt"), "half done\n");
    mkdirSync(join(h.home, "runs", "7", "tmp"), { recursive: true });
    h.crashed({ step: "agent" });
    h.takeOver();
    const rep = await recover(h.ctx);
    expect(rep.worktreesRemoved).toEqual(["1-1"]);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(h.home, "runs", "7", "tmp"))).toBe(false);
    expect(g.git(h.fx.repo, ["worktree", "list", "--porcelain"]).out.match(/^worktree /gm)).toHaveLength(1);
    expect(g.git(h.fx.repo, ["rev-parse", "--verify", "--quiet", "agentry/1-1"]).out).toBe(h.initial);
    await g.checkoutWorktree(h.fx.repo, wt, "agentry/1-1");
    expect(existsSync(join(wt, "app/main.txt"))).toBe(true);
  });

  test("a SIGKILLed runner's step keeps running; the next runner kills its group before recovery (D17)", async () => {
    const h = setup();
    const logDir = join(h.fx.root, "fake-runner");
    mkdirSync(logDir);
    const proc = Bun.spawn(["bun", join(import.meta.dir, "helpers/fake-runner.ts"), h.dbPath, String(h.id), logDir], { stdout: "inherit", stderr: "inherit" });
    let pgid: number | null = null;
    for (let i = 0; i < 200 && !pgid; i++) {
      await Bun.sleep(25);
      pgid = (h.db.query("SELECT pgid FROM runs WHERE request_id = ?").get(h.id) as { pgid: number | null } | null)?.pgid ?? null;
    }
    expect(pgid).not.toBeNull();
    proc.kill("SIGKILL");
    await proc.exited;
    expect(groupAlive(pgid!)).toBe(true);

    expect(acquireLease(h.db, "new", process.pid)).toBe(false); // its lease is still live
    const later = Date.now() + LEASE_TTL_MS + 1;
    expect(acquireLease(h.db, "new", process.pid, later)).toBe(true);
    const rep = await recover(h.ctx, { graceMs: 500, now: later });
    expect(rep.killed).toEqual([pgid!]);
    expect(groupAlive(pgid!)).toBe(false);
    expect(h.req()).toMatchObject({ status: "blocked_pre_push", status_reason: "runner stopped during deploy" });
    expect(h.db.query("SELECT status, pgid FROM runs WHERE request_id = ?").get(h.id)).toEqual({ status: "interrupted", pgid: null });
  }, 15_000);
});

describe("recovery: git left running by a crashed runner (slice 2 review D13)", () => {
  test("a push in flight when the runner is SIGKILLed is killed before recovery asks the remote", async () => {
    const h = setup();
    h.db.query("UPDATE runner SET owner_token = NULL, lease_expires_at = 0").run();
    const hook = join(h.fx.repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nsleep 60\n");
    chmodSync(hook, 0o755);
    const proc = Bun.spawn(["bun", join(import.meta.dir, "helpers/fake-pusher.ts"), h.dbPath, String(h.id), h.fx.repo, join(h.home, "worktrees", "1-1")],
      { stdout: "inherit", stderr: "inherit" });
    let pgid: number | null = null;
    try {
      for (let i = 0; i < 400 && !pgid; i++) {
        await Bun.sleep(25);
        const row = h.db.query("SELECT pgid FROM runs WHERE request_id = ? AND push_state = 'push_started'").get(h.id) as { pgid: number | null } | null;
        if (row?.pgid) pgid = row.pgid; // the push's group (earlier git calls ran before the run row existed)
      }
      expect(pgid).not.toBeNull();
      proc.kill("SIGKILL");
      await proc.exited;
      expect(groupAlive(pgid!)).toBe(true); // git push is still running on its own

      const later = Date.now() + LEASE_TTL_MS + 1;
      expect(acquireLease(h.db, "new", process.pid, later)).toBe(true);
      const rep = await recover(h.ctx, { graceMs: 500, now: later });
      expect(rep.killed).toContain(pgid!);
      expect(groupAlive(pgid!)).toBe(false);
      expect(g.git(h.fx.origin, ["rev-parse", "main"]).out).toBe(h.initial); // the push never landed
      expect(h.req()).toMatchObject({ status: "blocked_pre_push", status_reason: "runner stopped during push" });
    } finally {
      proc.kill("SIGKILL"); // never leave the helper or its push behind when an assertion fails
      if (pgid) await killGroup(pgid, 0);
    }
  }, 20_000);
});

// Real time: ~2.5 min. AGENTRY_SLOW=1 bun test test/recovery.test.ts
describe.if(process.env.AGENTRY_SLOW === "1")("heartbeat, real time (D7)", () => {
  test("a step sleeping 90 s keeps its lease; once the runner is SIGKILLed the lease expires within 60 s", async () => {
    const h = setup();
    const logDir = join(h.fx.root, "fake-runner");
    mkdirSync(logDir);
    const proc = Bun.spawn(["bun", join(import.meta.dir, "helpers/fake-runner.ts"), h.dbPath, String(h.id), logDir]);
    await Bun.sleep(90_000);
    expect(acquireLease(h.db, "new", process.pid)).toBe(false);
    proc.kill("SIGKILL");
    await proc.exited;
    await Bun.sleep(LEASE_TTL_MS + 1_000);
    expect(acquireLease(h.db, "new", process.pid)).toBe(true);
    await recover(h.ctx, { graceMs: 500 });
  }, 200_000);
});
