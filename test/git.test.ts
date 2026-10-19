import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as g from "../src/git.ts";
import { makeFixture } from "./fixture.ts";

describe("git ops", () => {
  test("candidate commit includes new untracked files and leaves the user checkout alone (D15)", () => {
    const fx = makeFixture();
    fx.write("wip.txt", "user work in progress\n"); // uncommitted change in the user's checkout
    const base = g.remoteHead(fx.repo, "origin", "main");
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "agentry/1-1", base);
    writeFileSync(join(wt, "NewClass.cs"), "class NewClass {}\n");
    const sha = g.candidateCommit(wt, "candidate")!;
    expect(g.changedFiles(wt, base, sha)).toEqual([{ status: "A", path: "NewClass.cs" }]);
    expect(g.git(fx.repo, ["status", "--porcelain"]).out).toBe("?? wip.txt");
    expect(g.headSha(fx.repo)).toBe(base);
  });

  test("candidate commit returns null when the agent changed nothing", () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    expect(g.candidateCommit(wt, "candidate")).toBeNull();
  });

  test("the branch keeps the work after the worktree is removed, and can be checked out again (D12)", () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    writeFileSync(join(wt, "a.txt"), "a\n");
    const sha = g.candidateCommit(wt, "candidate")!;
    g.removeWorktree(fx.repo, wt);
    g.checkoutWorktree(fx.repo, wt, "agentry/1-1");
    expect(g.headSha(wt)).toBe(sha);
  });

  test("addedLines lists the added lines per file", () => {
    const fx = makeFixture({ "t/FooTests.cs": "[Fact]\npublic void A() {}\n" });
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "b", "main");
    writeFileSync(join(wt, "t/FooTests.cs"), "[Fact(Skip = \"later\")]\npublic void A() {}\n");
    const sha = g.candidateCommit(wt, "c")!;
    expect(g.addedLines(wt, "main", sha).get("t/FooTests.cs")).toEqual(['[Fact(Skip = "later")]']);
  });

  test("push then ls-remote sees the pushed sha; unreachable remote gives null", () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    writeFileSync(join(wt, "a.txt"), "a\n");
    const sha = g.candidateCommit(wt, "c")!;
    expect(g.push(wt, "origin", sha, "main").code).toBe(0);
    expect(g.lsRemote(fx.repo, "origin", "main")).toBe(sha);
    g.git(fx.repo, ["remote", "set-url", "origin", join(fx.root, "missing.git")]);
    expect(g.lsRemote(fx.repo, "origin", "main")).toBeNull();
  });

  test("push is rejected when origin moved; rebase brings it up to date", () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "agentry/1-1", "origin/main");
    writeFileSync(join(wt, "a.txt"), "a\n");
    const sha = g.candidateCommit(wt, "c")!;
    fx.write("b.txt", "b\n"); fx.commit("someone else");
    g.git(fx.repo, ["push", "--quiet", "origin", "main"]);
    expect(g.push(wt, "origin", sha, "main").code).not.toBe(0);
    g.fetch(fx.repo, "origin");
    expect(g.rebaseOnto(wt, "origin/main")).toBe(true);
    expect(g.push(wt, "origin", g.headSha(wt), "main").code).toBe(0);
  });

  test("rebase conflict is aborted and reported", () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "x", "origin/main");
    writeFileSync(join(wt, "README.md"), "agent\n");
    g.candidateCommit(wt, "c");
    fx.write("README.md", "user\n"); fx.commit("user");
    g.git(fx.repo, ["push", "--quiet", "origin", "main"]);
    g.fetch(fx.repo, "origin");
    expect(g.rebaseOnto(wt, "origin/main")).toBe(false);
    expect(g.trackedClean(wt)).toBe(true);
  });

  test("resolveCommit resolves short shas and rejects unknown or malformed ones (C1)", () => {
    const fx = makeFixture();
    const full = g.headSha(fx.repo);
    expect(g.resolveCommit(fx.repo, full.slice(0, 7))).toBe(full);
    expect(g.resolveCommit(fx.repo, "deadbee")).toBeNull();
    expect(g.resolveCommit(fx.repo, "HEAD")).toBeNull();
    expect(g.isAncestor(fx.repo, full, "origin/main")).toBe(true);
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

  test("a rewritten .git pointer cannot make Agentry's git run the agent's config", () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    expect(g.pointerChanged(wt)).toBe(false);
    writeFileSync(join(wt, "x.txt"), "x\n");
    const marker = plantEvilGitDir(fx.root, wt);
    expect(g.pointerChanged(wt)).toBe(true);

    const sha = g.candidateCommit(wt, "candidate");
    expect(g.trackedClean(wt)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // The commit landed on the real branch in the real repository, not in the agent's git dir.
    expect(g.git(fx.repo, ["rev-parse", "agentry/1-1"]).out).toBe(sha!);
    expect(g.git(fx.repo, ["show", "--name-only", "--format=", sha!]).out.split("\n").sort()).toEqual([".gitattributes", "x.txt"]);
  });

  test("a worktree with a tampered pointer is still removed and pruned", () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    writeFileSync(join(wt, ".git"), "gitdir: /nonexistent\n");
    g.removeWorktree(fx.repo, wt);
    expect(existsSync(wt)).toBe(false);
    expect(g.git(fx.repo, ["worktree", "list", "--porcelain"]).out.match(/^worktree /gm)).toHaveLength(1);
  });

  test("an unpinned path (the user's checkout) is not affected", () => {
    const fx = makeFixture();
    expect(g.pointerChanged(fx.repo)).toBe(true); // never pinned
    expect(g.headSha(fx.repo)).toMatch(/^[0-9a-f]{40}$/);
  });
});
