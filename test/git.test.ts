import { afterEach, describe, expect, test } from "bun:test";
import { groupAlive } from "../src/proc.ts";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as g from "../src/git.ts";
import { head, makeFixture } from "./fixture.ts";

describe("git ops", () => {
  test("candidate commit includes new untracked files and leaves the user checkout alone (D15)", async () => {
    const fx = makeFixture();
    fx.write("wip.txt", "user work in progress\n"); // uncommitted change in the user's checkout
    const base = await g.remoteHead(fx.repo, "origin", "main");
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "agentry/1-1", base);
    writeFileSync(join(wt, "NewClass.cs"), "class NewClass {}\n");
    const sha = (await g.candidateCommit(wt, "candidate"))!;
    expect(await g.changedFiles(wt, base, sha)).toEqual([{ status: "A", path: "NewClass.cs" }]);
    expect(g.git(fx.repo, ["status", "--porcelain"]).out).toBe("?? wip.txt");
    expect(head(fx.repo)).toBe(base);
  });

  test("candidate commit returns null when the agent changed nothing", async () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    expect(await g.candidateCommit(wt, "candidate")).toBeNull();
  });

  test("the branch keeps the work after the worktree is removed, and can be checked out again (D12)", async () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    writeFileSync(join(wt, "a.txt"), "a\n");
    const sha = (await g.candidateCommit(wt, "candidate"))!;
    await g.removeWorktree(fx.repo, wt);
    await g.checkoutWorktree(fx.repo, wt, "agentry/1-1");
    expect(head(wt)).toBe(sha);
  });

  test("addedLines lists the added lines per file", async () => {
    const fx = makeFixture({ "t/FooTests.cs": "[Fact]\npublic void A() {}\n" });
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "b", "main");
    writeFileSync(join(wt, "t/FooTests.cs"), "[Fact(Skip = \"later\")]\npublic void A() {}\n");
    const sha = (await g.candidateCommit(wt, "c"))!;
    expect((await g.addedLines(wt, "main", sha)).get("t/FooTests.cs")).toEqual(['[Fact(Skip = "later")]']);
  });

  test("push then ls-remote sees the pushed sha; unreachable remote gives null", async () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    writeFileSync(join(wt, "a.txt"), "a\n");
    const sha = (await g.candidateCommit(wt, "c"))!;
    expect((await g.push(fx.repo, wt, "origin", sha, "main")).code).toBe(0);
    expect(await g.lsRemote(fx.repo, "origin", "main")).toBe(sha);
    g.git(fx.repo, ["remote", "set-url", "origin", join(fx.root, "missing.git")]);
    expect(await g.lsRemote(fx.repo, "origin", "main")).toBeNull();
  });

  test("push is rejected when origin moved; rebase brings it up to date", async () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "agentry/1-1", "origin/main");
    writeFileSync(join(wt, "a.txt"), "a\n");
    const sha = (await g.candidateCommit(wt, "c"))!;
    fx.write("b.txt", "b\n"); fx.commit("someone else");
    g.git(fx.repo, ["push", "--quiet", "origin", "main"]);
    expect((await g.push(fx.repo, wt, "origin", sha, "main")).code).not.toBe(0);
    await g.fetch(fx.repo, "origin");
    expect(await g.rebaseOnto(wt, "origin/main")).toBe(true);
    expect((await g.push(fx.repo, wt, "origin", head(wt), "main")).code).toBe(0);
  });

  test("rebase conflict is aborted and reported", async () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "x", "origin/main");
    writeFileSync(join(wt, "README.md"), "agent\n");
    await g.candidateCommit(wt, "c");
    fx.write("README.md", "user\n"); fx.commit("user");
    g.git(fx.repo, ["push", "--quiet", "origin", "main"]);
    await g.fetch(fx.repo, "origin");
    expect(await g.rebaseOnto(wt, "origin/main")).toBe(false);
    expect(await g.trackedClean(wt)).toBe(true);
  });

  test("resolveCommit resolves short shas and rejects unknown or malformed ones (C1)", async () => {
    const fx = makeFixture();
    const full = head(fx.repo);
    expect(await g.resolveCommit(fx.repo, full.slice(0, 7))).toBe(full);
    expect(await g.resolveCommit(fx.repo, "deadbee")).toBeNull();
    expect(await g.resolveCommit(fx.repo, "HEAD")).toBeNull();
    expect(await g.isAncestor(fx.repo, full, "origin/main")).toBe(true);
  });
});

describe("pinned worktrees (D12)", () => {
  // What a sandboxed agent could do: make its own git dir whose config runs code, and point `.git` at it.
  function plantEvilGitDir(root: string, wt: string): string {
    const marker = join(root, "PWNED");
    const evil = join(root, "evil");
    g.git(root, ["init", "--quiet", evil]);
    const hook = join(root, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    g.git(evil, ["config", "core.fsmonitor", hook]);
    g.git(evil, ["config", "filter.evil.clean", `sh -c 'touch "${marker}"; cat'`]);
    writeFileSync(join(wt, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(evil, ".git")}\n`);
    return marker;
  }

  test("a rewritten .git pointer cannot make Agentry's git run the agent's config", async () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    expect(g.pointerChanged(wt)).toBe(false);
    writeFileSync(join(wt, "x.txt"), "x\n");
    const marker = plantEvilGitDir(fx.root, wt);
    expect(g.pointerChanged(wt)).toBe(true);

    const sha = await g.candidateCommit(wt, "candidate");
    expect(await g.trackedClean(wt)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // The commit landed on the real branch in the real repository, not in the agent's git dir.
    expect(g.git(fx.repo, ["rev-parse", "agentry/1-1"]).out).toBe(sha!);
    expect(g.git(fx.repo, ["show", "--name-only", "--format=", sha!]).out.split("\n").sort()).toEqual([".gitattributes", "x.txt"]);
  });

  test("a worktree with a tampered pointer is still removed and pruned", async () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    writeFileSync(join(wt, ".git"), "gitdir: /nonexistent\n");
    await g.removeWorktree(fx.repo, wt);
    expect(existsSync(wt)).toBe(false);
    expect(g.git(fx.repo, ["worktree", "list", "--porcelain"]).out.match(/^worktree /gm)).toHaveLength(1);
  });

  test("an unpinned path (the user's checkout) is not affected", async () => {
    const fx = makeFixture();
    expect(g.pointerChanged(fx.repo)).toBe(true); // never pinned
    expect(head(fx.repo)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("bounded git (slice 2 review D12, D13)", () => {
  const saved = { ...g.timeouts };
  afterEach(() => { Object.assign(g.timeouts, saved); });

  // A server that accepts connections and never answers: what a stalled network looks like to git.
  function silentServer() {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    return { url: `http://127.0.0.1:${server.port}/repo.git`, stop: () => server.stop(true) };
  }

  test("a git command that overruns its timeout is killed with its whole process group", async () => {
    const fx = makeFixture();
    let pgid = 0;
    const t0 = Date.now();
    const r = await g.observer.run({ onStart: (p) => { pgid = p; } }, () => g.run(fx.repo, ["-c", "alias.hang=!sleep 30 & sleep 30", "hang"], 500));
    expect(r.code).toBe(124);
    expect(r.err).toContain("timed out after 1 s");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(pgid).toBeGreaterThan(0);
    expect(groupAlive(pgid)).toBe(false);
  });

  test("fetch and ls-remote against a server that never answers end at their timeout", async () => {
    const fx = makeFixture();
    const srv = silentServer();
    try {
      g.git(fx.repo, ["remote", "add", "stalled", srv.url]);
      g.timeouts.network = 800;
      g.timeouts.lsRemote = 800;
      const t0 = Date.now();
      expect((await g.fetch(fx.repo, "stalled")).code).toBe(124);
      expect(await g.lsRemote(fx.repo, "stalled", "main")).toBeNull();
      expect(Date.now() - t0).toBeLessThan(6_000);
    } finally { srv.stop(); }
  });

  test("timers keep firing while git runs, so the lease heartbeat is never starved", async () => {
    const fx = makeFixture();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 100);
    await g.run(fx.repo, ["-c", "alias.wait=!sleep 1", "wait"], 5_000);
    clearInterval(timer);
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

