// Windows (winhost review T7): recipe commands run in Windows PowerShell, and every step and git command runs under
// tools/runas/agentry-runas.exe, which puts it in a job object; killing the helper closes the job and kills the
// tree. Sandboxed steps run as the AgentrySandbox user (winhost review D5, D8; setup/windows-setup.ps1 creates it),
// which may write only the folders `windowsSandbox` grants it for the run.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Platform } from "./platform.ts";

export const RUNAS = join(import.meta.dir, "../tools/runas/agentry-runas.exe");
export const SANDBOX_USER = "AgentrySandbox";
// Steps share the machine with production services, so each gets at most this much.
export const STEP_MEMORY_MB = 8192;
export const STEP_CPU_PERCENT = 50;

export const windows: Platform = {
  // A failing native command is the step's exit code, as with zsh -c. $ErrorActionPreference stays at Continue:
  // with Stop, Windows PowerShell 5.1 turns a native command's stderr into a terminating error once redirected.
  // -Command, not -EncodedCommand: with the latter it writes errors and progress to the log as CLIXML.
  shell(command) {
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", `${command}\nif (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }`];
  },
  // argv either starts with the helper already (a sandbox wrap) or gets it in front.
  spawnTree(argv, o) {
    const full = argv[0] === RUNAS ? argv : [RUNAS, "--", ...argv];
    return spawn(full[0], full.slice(1), {
      cwd: o.cwd, env: o.env ?? (process.env as Record<string, string>), stdio: [o.stdin, "pipe", "pipe"], windowsHide: true,
    });
  },
  // Windows reuses pids soon, so a recorded one counts only while it is still a run-as helper.
  treeAlive(pid) {
    if (!exists(pid)) return false;
    const p = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { stdout: "pipe", stderr: "pipe" });
    return p.stdout.toString().toLowerCase().startsWith('"agentry-runas.exe"');
  },
  // No polite stop on Windows: terminating the helper closes its job, which ends the tree at once.
  async killTree(pid) {
    if (!windows.treeAlive(pid)) return;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    while (exists(pid)) await Bun.sleep(50);
  },
};

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}

export type WindowsSandboxPaths = {
  worktree: string; runTmp: string; pkgCache: string; gitDir?: string; passwordFile: string;
  home: string; // Agentry's home, which setup lets the sandbox list; the folders between it and the run's are listed here
};

// The run's folders, opened to AgentrySandbox (modify; the git dir read-only), and the step's environment: a fresh
// profile, temp and claude config inside the run's temp dir, like the Mac sandbox's.
export function windowsSandbox(p: WindowsSandboxPaths): { wrap: string[]; env: Record<string, string> } {
  const home = join(p.runTmp, "home");
  const claudeConfig = join(p.runTmp, "claude");
  for (const d of [home, join(home, "AppData", "Roaming"), join(home, "AppData", "Local"), claudeConfig, p.pkgCache]) mkdirSync(d, { recursive: true });
  for (const d of [p.worktree, p.runTmp, p.pkgCache]) grant(d, "M");
  if (p.gitDir) grant(p.gitDir, "RX");
  // PowerShell (and Node's realpath) look a starting folder up in each of its parents: without listing them, PowerShell
  // starts with no current location and resolves relative paths against C:\. Names only, and not inherited.
  for (const d of [p.worktree, p.runTmp, p.pkgCache]) {
    for (let up = dirname(d); up.length > p.home.length && up.toLowerCase().startsWith(p.home.toLowerCase()); up = dirname(up)) listable(up);
  }

  const wrap = [RUNAS, "--memory-mb", String(STEP_MEMORY_MB), "--cpu-percent", String(STEP_CPU_PERCENT),
    "--sandbox", SANDBOX_USER, p.passwordFile, p.runTmp, "--"];
  const pass = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "ProgramData", "ALLUSERSPROFILE", "PATH"];
  const env: Record<string, string> = {};
  for (const k of pass) if (process.env[k]) env[k] = process.env[k]!;
  const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  Object.assign(env, {
    USERNAME: SANDBOX_USER,
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: p.runTmp,
    TMP: p.runTmp,
    TMPDIR: p.runTmp,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_CODE_TMPDIR: p.runTmp,
    DISABLE_AUTOUPDATER: "1",
    ...(existsSync(gitBash) ? { CLAUDE_CODE_GIT_BASH_PATH: gitBash } : {}),
    DOTNET_CLI_HOME: home,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    NUGET_PACKAGES: p.pkgCache,
    UseSharedCompilation: "false",   // no compiler server outliving the step
    MSBUILDDISABLENODEREUSE: "1",     // no MSBuild nodes outliving the step
  });
  return { wrap, env };
}

// Gives AgentrySandbox `rights` (icacls: M modify, RX read) on a folder and everything in it: Windows passes an
// inheritable grant on to what the folder already holds.
function grant(dir: string, rights: "M" | "RX"): void {
  icacls([dir, "/grant", `${SANDBOX_USER}:(OI)(CI)${rights}`, "/Q"]);
}

// Lets AgentrySandbox list a folder's names (not read its files or anything below it).
function listable(dir: string): void {
  icacls([dir, "/grant", `${SANDBOX_USER}:(RD,RA)`, "/Q"]);
}

function icacls(args: string[]): void {
  const p = Bun.spawnSync(["icacls", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`icacls ${args.join(" ")}: ${(p.stdout.toString() + p.stderr.toString()).trim()}`);
}
