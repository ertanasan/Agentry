// Git operations the runner needs. Everything works on worktrees under ~/.agentry/worktrees; the user's own
// checkout is never checked out, reset or committed to.

export type GitResult = { code: number; out: string; err: string };

export function git(cwd: string, args: string[]): GitResult {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function must(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.err || r.out}`);
  return r.out;
}

export function fetch(repo: string, remote: string): GitResult {
  return git(repo, ["fetch", "--quiet", remote]);
}

export function remoteHead(repo: string, remote: string, branch: string): string {
  return must(repo, ["rev-parse", `refs/remotes/${remote}/${branch}^{commit}`]);
}

export function headSha(cwd: string): string {
  return must(cwd, ["rev-parse", "HEAD"]);
}

// New worktree on a new branch starting at `start`.
export function addWorktree(repo: string, path: string, branch: string, start: string): void {
  must(repo, ["worktree", "add", "--quiet", "-B", branch, path, start]);
}

// Worktree for an existing branch (resume after needs_review, retry from a kept branch, redeploy).
export function checkoutWorktree(repo: string, path: string, branch: string): void {
  must(repo, ["worktree", "add", "--quiet", path, branch]);
}

export function removeWorktree(repo: string, path: string): void {
  git(repo, ["worktree", "remove", "--force", path]);
  git(repo, ["worktree", "prune"]);
}

export function pruneWorktrees(repo: string): void {
  git(repo, ["worktree", "prune"]);
}

// Stages everything that is not ignored and commits it as the candidate (D15). Returns null when there is
// nothing to commit.
export function candidateCommit(wt: string, message: string): string | null {
  must(wt, ["add", "-A"]);
  if (git(wt, ["diff", "--cached", "--quiet"]).code === 0) return null;
  must(wt, ["commit", "--quiet", "--no-verify", "-m", message]);
  return headSha(wt);
}

export type FileChange = { status: string; path: string };

export function changedFiles(cwd: string, base: string, head: string): FileChange[] {
  const out = must(cwd, ["diff", "--name-status", "--no-renames", base, head]);
  return out ? out.split("\n").map((l) => { const [status, path] = l.split("\t"); return { status, path }; }) : [];
}

// Lines added between base and head, per file (for skip-pattern and reference checks).
export function addedLines(cwd: string, base: string, head: string): Map<string, string[]> {
  const out = must(cwd, ["diff", "--unified=0", "--no-color", "--no-renames", base, head]);
  const map = new Map<string, string[]>();
  let file = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.replace(/^\+\+\+ (b\/)?/, ""); map.set(file, []); }
    else if (line.startsWith("+") && file) map.get(file)!.push(line.slice(1));
  }
  return map;
}

export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).code === 0;
}

// Full SHA for an abbreviated one, or null if it is unknown or ambiguous (correction C1).
export function resolveCommit(repo: string, short: string): string | null {
  if (!/^[0-9a-f]{4,40}$/.test(short)) return null;
  const r = git(repo, ["rev-parse", "--verify", "--quiet", `${short}^{commit}`]);
  return r.code === 0 ? r.out : null;
}

// Rebases the worktree's branch onto `upstream`. On conflict the rebase is aborted and false returned.
export function rebaseOnto(wt: string, upstream: string): boolean {
  if (git(wt, ["rebase", "--quiet", upstream]).code === 0) return true;
  git(wt, ["rebase", "--abort"]);
  return false;
}

export function amendMessage(wt: string, message: string): string {
  must(wt, ["commit", "--quiet", "--amend", "--no-verify", "-m", message]);
  return headSha(wt);
}

// Fast-forward push of `sha` to the remote branch. The exit code alone never decides pushed vs not (D19).
export function push(wt: string, remote: string, sha: string, branch: string): GitResult {
  return git(wt, ["push", "--quiet", "--porcelain", remote, `${sha}:refs/heads/${branch}`]);
}

// The remote branch's current SHA, or null if the remote could not be reached.
export function lsRemote(repo: string, remote: string, branch: string): string | null {
  const r = git(repo, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]);
  if (r.code !== 0) return null;
  return r.out.split(/\s+/)[0] || null;
}

// True when the worktree has no changes to tracked files (untracked build output is ignored).
export function trackedClean(wt: string): boolean {
  return must(wt, ["status", "--porcelain", "--untracked-files=no"]) === "";
}
