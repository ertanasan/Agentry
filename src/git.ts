// Git operations the runner needs. Everything works on worktrees under ~/.agentry/worktrees; the user's own
// checkout is never checked out, reset or committed to.
//
// Sandboxed steps can write the whole worktree, including its `.git` pointer file. Git run unsandboxed in a
// worktree would follow a rewritten pointer to a git dir of the agent's making, whose config (core.fsmonitor,
// filter drivers, hooksPath) it then executes. So every worktree is pinned when Agentry creates it: git in a
// pinned worktree gets its real git dir and work tree on the command line and never reads `.git`, and
// fsmonitor and hooks are off (push keeps the repository's own hooks, e.g. git-lfs pre-push, which live in the
// shared git dir the sandbox can only read). The runner also stops a run whose pointer changed (eng review D12).
//
// Every operation the runner uses is async and bounded: each git process runs as its own process tree with a
// timeout (network 120 s, ls-remote 30 s, other commands 120 s; git-lfs hooks and filters make "local"
// commands network-bound too) and is killed with its group when it overruns. While it runs, its process group
// is reported to `observer`, so the runner records it and a restarted runner kills a leftover push before
// asking the remote what happened (slice 2 review D12, D13). The synchronous `git` is for tests and tooling.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { platform } from "./platform.ts";
import { killGroup } from "./proc.ts";

export type GitResult = { code: number; out: string; err: string };

export const timeouts = { network: 120_000, lsRemote: 30_000, local: 120_000 };

// Set by the runner around a run: told the process group of each git process while it runs.
export const observer: { onStart?: (pgid: number) => void; onEnd?: () => void } = {};

type Pin = { gitDir: string; pointer: string };
const pinned = new Map<string, Pin>();
let noHooks: string | undefined;

function pinnedArgs(cwd: string, args: string[]): string[] {
  const pin = pinned.get(cwd);
  if (!pin) return args;
  noHooks ??= mkdtempSync(join(tmpdir(), "agentry-no-hooks-"));
  const hooks = args[0] === "push" ? [] : ["-c", `core.hooksPath=${noHooks}`];
  return [`--git-dir=${pin.gitDir}`, `--work-tree=${cwd}`, "-c", "core.fsmonitor=false", ...hooks, ...args];
}

// Synchronous, unbounded: tests, fixtures and one-off tooling only. The runner and recovery use `run`.
export function git(cwd: string, args: string[]): GitResult {
  const p = Bun.spawnSync(["git", ...pinnedArgs(cwd, args)], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

// One git command in its own process group, killed with its group after `timeoutMs` (exit code 124).
export async function run(cwd: string, args: string[], timeoutMs = timeouts.local): Promise<GitResult> {
  const child = platform.spawnTree(["git", ...pinnedArgs(cwd, args)], {
    cwd, stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>, // never wait for a credential prompt
  });
  const pgid = child.pid!;
  observer.onStart?.(pgid);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout!.on("data", (c: Buffer) => out.push(c));
  child.stderr!.on("data", (c: Buffer) => err.push(c));
  const exited = new Promise<number>((resolve) => {
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on("error", () => resolve(127));
  });
  let timer: Timer | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
  const first = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  await killGroup(pgid, first === "timeout" ? 2_000 : 0);
  const code = await exited;
  observer.onEnd?.();
  const stderr = Buffer.concat(err).toString().trim();
  if (first === "timeout") return { code: 124, out: "", err: `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s${stderr ? `: ${stderr}` : ""}` };
  return { code, out: Buffer.concat(out).toString().trim(), err: stderr };
}

function readPointer(wt: string): string | null {
  try { return readFileSync(join(wt, ".git"), "utf8"); } catch { return null; }
}

// Records a worktree Agentry just created, before any sandboxed step has run in it.
function pin(wt: string): void {
  const pointer = readPointer(wt);
  const m = pointer?.match(/^gitdir: (.+)$/m);
  if (!pointer || !m) throw new Error(`worktree ${wt} has no gitdir pointer`);
  pinned.set(wt, { gitDir: m[1].trim(), pointer });
}

// True when a pinned worktree's `.git` is no longer what Agentry wrote (replaced, edited, turned into a folder).
export function pointerChanged(wt: string): boolean {
  const pin = pinned.get(wt);
  return !pin || readPointer(wt) !== pin.pointer;
}

async function must(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const r = await run(cwd, args, timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.err || r.out}`);
  return r.out;
}

export function fetch(repo: string, remote: string): Promise<GitResult> {
  return run(repo, ["fetch", "--quiet", remote], timeouts.network);
}

export function remoteHead(repo: string, remote: string, branch: string): Promise<string> {
  return must(repo, ["rev-parse", `refs/remotes/${remote}/${branch}^{commit}`]);
}

export function headSha(cwd: string): Promise<string> {
  return must(cwd, ["rev-parse", "HEAD"]);
}

// New worktree on a new branch starting at `start`.
export async function addWorktree(repo: string, path: string, branch: string, start: string): Promise<void> {
  await must(repo, ["worktree", "add", "--quiet", "-B", branch, path, start]);
  pin(path);
}

// Worktree for an existing branch (resume after needs_review, retry from a kept branch, redeploy).
export async function checkoutWorktree(repo: string, path: string, branch: string): Promise<void> {
  await must(repo, ["worktree", "add", "--quiet", path, branch]);
  pin(path);
}

// Worktree at an exact commit, for re-running a deploy.
export async function detachedWorktree(repo: string, path: string, sha: string): Promise<void> {
  await must(repo, ["worktree", "add", "--quiet", "--detach", path, sha]);
  pin(path);
}

// The repository's shared git dir, where the worktrees' metadata lives.
export async function commonDir(repo: string): Promise<string> {
  const dir = await must(repo, ["rev-parse", "--git-common-dir"]);
  return isAbsolute(dir) ? dir : join(repo, dir);
}

// Removes untracked and ignored files, e.g. build output that sandboxed steps left in the worktree.
export async function cleanUntracked(wt: string): Promise<void> {
  await must(wt, ["clean", "-fdxq"]);
}

export function diff(cwd: string, base: string, head: string): Promise<string> {
  return must(cwd, ["diff", "--no-color", base, head]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  pinned.delete(path);
  await run(repo, ["worktree", "remove", "--force", path]);
  // git refuses to remove a worktree whose `.git` no longer points back (a tampered pointer): delete it anyway.
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await run(repo, ["worktree", "prune"]);
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await run(repo, ["worktree", "prune"]);
}

// Stages everything that is not ignored and commits it as the candidate (D15). Returns null when there is
// nothing to commit.
export async function candidateCommit(wt: string, message: string): Promise<string | null> {
  await must(wt, ["add", "-A"]);
  if ((await run(wt, ["diff", "--cached", "--quiet"])).code === 0) return null;
  await must(wt, ["commit", "--quiet", "--no-verify", "-m", message]);
  return headSha(wt);
}

export type FileChange = { status: string; path: string };

export async function changedFiles(cwd: string, base: string, head: string): Promise<FileChange[]> {
  const out = await must(cwd, ["diff", "--name-status", "--no-renames", base, head]);
  return out ? out.split("\n").map((l) => { const [status, path] = l.split("\t"); return { status, path }; }) : [];
}

// Lines added between base and head, per file (for skip-pattern and reference checks).
export async function addedLines(cwd: string, base: string, head: string): Promise<Map<string, string[]>> {
  const out = await must(cwd, ["diff", "--unified=0", "--no-color", "--no-renames", base, head]);
  const map = new Map<string, string[]>();
  let file = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.replace(/^\+\+\+ (b\/)?/, ""); map.set(file, []); }
    else if (line.startsWith("+") && file) map.get(file)!.push(line.slice(1));
  }
  return map;
}

export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await run(repo, ["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}

// Full SHA for an abbreviated one, or null if it is unknown or ambiguous (correction C1).
export async function resolveCommit(repo: string, short: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,40}$/.test(short)) return null;
  const r = await run(repo, ["rev-parse", "--verify", "--quiet", `${short}^{commit}`]);
  return r.code === 0 ? r.out : null;
}

// Rebases the worktree's branch onto `upstream`. On conflict the rebase is aborted and false returned.
export async function rebaseOnto(wt: string, upstream: string): Promise<boolean> {
  if ((await run(wt, ["rebase", "--quiet", upstream])).code === 0) return true;
  await run(wt, ["rebase", "--abort"]);
  return false;
}

export async function amendMessage(wt: string, message: string): Promise<string> {
  await must(wt, ["commit", "--quiet", "--amend", "--no-verify", "-m", message]);
  return headSha(wt);
}

// Fast-forward push of `sha` to the remote branch. The exit code alone never decides pushed vs not (D19).
export function push(wt: string, remote: string, sha: string, branch: string): Promise<GitResult> {
  return run(wt, ["push", "--quiet", "--porcelain", remote, `${sha}:refs/heads/${branch}`], timeouts.network);
}

// The remote branch's current SHA, or null if the remote could not be reached (or did not answer in time).
export async function lsRemote(repo: string, remote: string, branch: string): Promise<string | null> {
  const r = await run(repo, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`], timeouts.lsRemote);
  if (r.code !== 0) return null;
  return r.out.split(/\s+/)[0] || null;
}

// True when the worktree has no changes to tracked files (untracked build output is ignored).
export async function trackedClean(wt: string): Promise<boolean> {
  return (await must(wt, ["status", "--porcelain", "--untracked-files=no"])) === "";
}
