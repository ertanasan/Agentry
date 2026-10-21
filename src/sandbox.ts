// The sandbox for every step that runs agent-written code: agent, build, test and verifier (eng review D4, D14):
// sandbox-exec with sandbox/run.sb on the Mac, the AgentrySandbox user on Windows (platform-windows.ts).
// Pass `wrap` to runStep's `wrap` and `env` as its `env`. The step gets a scrubbed environment whose HOME,
// TMPDIR and CLAUDE_CONFIG_DIR all live in the run's own temp dir, so nothing carries over between runs.
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { windowsSandbox } from "./platform-windows.ts";

export const PROFILE = join(import.meta.dir, "../sandbox/run.sb");
export const AGENTRY_HOME = process.env.AGENTRY_HOME ?? join(homedir(), ".agentry");
// Agentry's own NuGet cache, writable from the sandbox. Deploy runs unsandboxed with the user's ~/.nuget,
// so a run that tampers with this cache can only affect later sandboxed runs.
export const PKG_CACHE = join(AGENTRY_HOME, "cache", "nuget");
// apiKeyHelper script for `claude -p`. It must print the key itself (no other file is readable).
export const KEY_HELPER = join(AGENTRY_HOME, "api-key-helper");
// Windows: AgentrySandbox's password, written by setup/windows-setup.ps1 and readable only by the runner account.
export const SANDBOX_PASSWORD = join(AGENTRY_HOME, "sandbox-password");

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
  userTemp?: boolean;  // open the per-user temp folder (a recipe's sandbox_user_temp)
};

let userDir: string | undefined;
// The per-user area under /var/folders that holds 0/, T/ (temp) and C/ (caches); other apps' files live there.
// DARWIN_USER_DIR names its 0/ subfolder.
function darwinUserDir(): string {
  userDir ??= realpathSync(join(Bun.spawnSync(["getconf", "DARWIN_USER_DIR"]).stdout.toString().trim(), ".."));
  return userDir;
}

// MSBuild's worker nodes and the C# compiler server talk over sockets in /tmp (hardcoded, whatever TMPDIR says),
// which the sandbox blocks. Allowing them would let sandboxed code reach the user's own unsandboxed nodes and
// compiler server. So a `dotnet` first on the sandbox's PATH keeps MSBuild in one process for every verb that
// runs it; without it, a build with project references hangs until MSBuild gives up after 5 minutes.
function writeDotnetShim(dir: string): void {
  const real = Bun.which("dotnet", { PATH });
  if (!real) return;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "dotnet");
  writeFileSync(path, `#!/bin/zsh
# Agentry sandbox: MSBuild in one process (no worker nodes, no compiler server); their pipes in /tmp are blocked.
case "$1" in
  build|test|restore|publish|pack|msbuild|clean) exec '${real}' "$1" -m:1 -nodeReuse:false -p:UseSharedCompilation=false "\${@:2}" ;;
esac
exec '${real}' "$@"
`);
  chmodSync(path, 0o755);
}

export function sandbox(p: SandboxPaths): { wrap: string[]; env: Record<string, string> } {
  mkdirSync(p.runTmp, { recursive: true });
  const runTmp = realpathSync(p.runTmp);
  const pkgCache = p.pkgCache ?? PKG_CACHE;
  mkdirSync(pkgCache, { recursive: true });
  if (process.platform === "win32") {
    // claude and the API key helper need no grant: setup makes Agentry's bin folder readable by the sandbox user.
    return windowsSandbox({ worktree: p.worktree, runTmp, pkgCache, gitDir: p.gitDir, passwordFile: SANDBOX_PASSWORD });
  }
  const home = join(runTmp, "home");
  const claudeConfig = join(runTmp, "claude");
  mkdirSync(home, { recursive: true });
  mkdirSync(claudeConfig, { recursive: true });
  const keyHelper = p.keyHelper ?? (p.claudeBin ? KEY_HELPER : NONE);
  const bin = join(runTmp, "bin");
  writeDotnetShim(bin);

  const params: Record<string, string> = {
    USER_HOME: realpathSync(p.userHome ?? homedir()),
    USER_DIR: darwinUserDir(),
    WORKTREE: realpathSync(p.worktree),
    RUN_TMP: runTmp,
    PKG_CACHE: realpathSync(pkgCache),
    GIT_DIR: p.gitDir ? realpathSync(p.gitDir) : NONE,
    CLAUDE_BIN: p.claudeBin ? realpathSync(p.claudeBin) : NONE,
    KEY_HELPER: existsSync(keyHelper) ? realpathSync(keyHelper) : keyHelper,
    USER_TEMP: p.userTemp ? join(darwinUserDir(), "T") : NONE,
  };
  const wrap = ["sandbox-exec", ...Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]), "-f", PROFILE];

  const env: Record<string, string> = {
    PATH: `${bin}:${PATH}`,
    HOME: home,
    TMPDIR: runTmp + "/",
    LANG: "en_US.UTF-8",
    CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_CODE_TMPDIR: runTmp, // claude otherwise writes to /tmp/claude-<uid>, whatever TMPDIR says
    DOTNET_CLI_HOME: home,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    NUGET_PACKAGES: params.PKG_CACHE,
    UseSharedCompilation: "false", // read by MSBuild as a property: no compiler server (see writeDotnetShim)
    MSBUILDDISABLENODEREUSE: "1",
    xcrun_db: join(runTmp, "xcrun_db"), // xcrun (behind /usr/bin/git) otherwise caches in the denied per-user temp dir
  };
  return { wrap, env };
}
