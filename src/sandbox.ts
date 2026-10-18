// The sandbox for every step that runs agent-written code: agent, build, test and verifier (eng review D4, D14).
// Pass `wrap` to runStep's `wrap` and `env` as its `env`. The step gets a scrubbed environment whose HOME,
// TMPDIR and CLAUDE_CONFIG_DIR all live in the run's own temp dir, so nothing carries over between runs.
import { mkdirSync, realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE = join(import.meta.dir, "../sandbox/run.sb");
export const AGENTRY_HOME = join(homedir(), ".agentry");
// Agentry's own NuGet cache, writable from the sandbox. Deploy runs unsandboxed with the user's ~/.nuget,
// so a run that tampers with this cache can only affect later sandboxed runs.
export const PKG_CACHE = join(AGENTRY_HOME, "cache", "nuget");
// apiKeyHelper script for `claude -p`. It must print the key itself (no other file is readable).
export const KEY_HELPER = join(AGENTRY_HOME, "api-key-helper");

const PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const NONE = "/nonexistent";

export type SandboxPaths = {
  worktree: string;
  runTmp: string;
  gitDir?: string;     // the repo's git common dir (`git rev-parse --git-common-dir`)
  claudeBin?: string;  // agent and verifier steps
  keyHelper?: string;  // default KEY_HELPER when claudeBin is set
  pkgCache?: string;   // default PKG_CACHE
  userHome?: string;   // the home to deny; default os.homedir()
};

let userDir: string | undefined;
// The per-user area under /var/folders that holds 0/, T/ (temp) and C/ (caches); other apps' files live there.
// DARWIN_USER_DIR names its 0/ subfolder.
function darwinUserDir(): string {
  userDir ??= realpathSync(join(Bun.spawnSync(["getconf", "DARWIN_USER_DIR"]).stdout.toString().trim(), ".."));
  return userDir;
}

export function sandbox(p: SandboxPaths): { wrap: string[]; env: Record<string, string> } {
  mkdirSync(p.runTmp, { recursive: true });
  const runTmp = realpathSync(p.runTmp);
  const pkgCache = p.pkgCache ?? PKG_CACHE;
  mkdirSync(pkgCache, { recursive: true });
  const home = join(runTmp, "home");
  const claudeConfig = join(runTmp, "claude");
  mkdirSync(home, { recursive: true });
  mkdirSync(claudeConfig, { recursive: true });
  const keyHelper = p.keyHelper ?? (p.claudeBin ? KEY_HELPER : NONE);

  const params: Record<string, string> = {
    USER_HOME: realpathSync(p.userHome ?? homedir()),
    USER_DIR: darwinUserDir(),
    WORKTREE: realpathSync(p.worktree),
    RUN_TMP: runTmp,
    PKG_CACHE: realpathSync(pkgCache),
    GIT_DIR: p.gitDir ? realpathSync(p.gitDir) : NONE,
    CLAUDE_BIN: p.claudeBin ? realpathSync(p.claudeBin) : NONE,
    KEY_HELPER: existsSync(keyHelper) ? realpathSync(keyHelper) : keyHelper,
  };
  const wrap = ["sandbox-exec", ...Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]), "-f", PROFILE];

  const env: Record<string, string> = {
    PATH,
    HOME: home,
    TMPDIR: runTmp + "/",
    LANG: "en_US.UTF-8",
    CLAUDE_CONFIG_DIR: claudeConfig,
    DOTNET_CLI_HOME: home,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    NUGET_PACKAGES: params.PKG_CACHE,
    xcrun_db: join(runTmp, "xcrun_db"), // xcrun (behind /usr/bin/git) otherwise caches in the denied per-user temp dir
  };
  return { wrap, env };
}
