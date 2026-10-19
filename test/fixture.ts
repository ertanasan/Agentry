// A throwaway "user repo" with a bare origin, for tests that need real git.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { git } from "../src/git.ts";

export type Fixture = { root: string; origin: string; repo: string; write: (path: string, text: string) => void; commit: (msg: string) => string };

export function makeFixture(files: Record<string, string> = { "README.md": "hello\n" }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentry-fx-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, ["init", "--quiet", "--bare", "-b", "main", origin]);
  git(root, ["init", "--quiet", "-b", "main", repo]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["remote", "add", "origin", origin]);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (msg: string) => {
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", msg]);
    return git(repo, ["rev-parse", "HEAD"]).out;
  };
  for (const [p, t] of Object.entries(files)) write(p, t);
  commit("initial");
  git(repo, ["push", "--quiet", "origin", "main"]);
  git(repo, ["fetch", "--quiet", "origin"]);
  return { root, origin, repo, write, commit };
}

// The commit a checkout or worktree is at (sync, for test setup).
export const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]).out;
