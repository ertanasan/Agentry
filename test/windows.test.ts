// The Windows platform layer on a real Windows machine (winhost review D10): steps under the run-as helper, PowerShell
// exit codes, tree kills, and the AgentrySandbox user's limits. Run as the runner account after setup:
// `setup/windows-setup.ps1 -SelfTest`. Skipped on other systems; the sandbox part also needs setup's password file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEP_MEMORY_MB } from "../src/platform-windows.ts";
import { platform } from "../src/platform.ts";
import { groupAlive, killGroup, runStep } from "../src/proc.ts";
import { AGENTRY_HOME, SANDBOX_PASSWORD, sandbox } from "../src/sandbox.ts";

const win = process.platform === "win32";
const SLOW = 60_000; // tests that wait on processes; bun's default is 5 s

function scratch(parent = tmpdir()): string {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "agentry-wintest-"));
}

async function step(command: string | string[], o: { cwd: string; wrap?: string[]; env?: Record<string, string>; timeoutMs?: number; onStart?: (id: number) => void }) {
  const logPath = join(o.cwd, `step-${process.hrtime.bigint()}.log`);
  const r = await runStep(command, { cwd: o.cwd, logPath, timeoutMs: o.timeoutMs ?? 60_000, wrap: o.wrap, env: o.env, onStart: o.onStart });
  return { ...r, log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "" };
}

// A grandchild, started with Start-Process, that rewrites `file` every 200 ms until it is killed.
const heartbeat = (file: string) =>
  `Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','while ($true) { Set-Content -LiteralPath ''${file}'' ([DateTime]::Now.Ticks); Start-Sleep -Milliseconds 200 }'; ` +
  `while (-not (Test-Path -LiteralPath '${file}')) { Start-Sleep -Milliseconds 100 }; Start-Sleep 600`;

async function stopsBeating(file: string): Promise<boolean> {
  await Bun.sleep(1_000);
  const before = statSync(file).mtimeMs;
  await Bun.sleep(1_500);
  return statSync(file).mtimeMs === before;
}

describe.if(win)("windows: steps under the run-as helper", () => {
  test("the exit code and both streams reach the log", async () => {
    const r = await step(["cmd", "/c", "echo to-out& echo to-err 1>&2& exit 7"], { cwd: scratch() });
    expect(r.exitCode).toBe(7);
    expect(r.log).toContain("to-out");
    expect(r.log).toContain("to-err");
  });

  test("arguments arrive exactly as given", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "argv.ts"), "console.log(JSON.stringify(process.argv.slice(2)));");
    const args = ["plain", "with space", 'a "quoted" word', "trailing\\", "", 'slash\\"quote', "C:\\Program Files\\x\\"];
    const r = await step([process.execPath, join(dir, "argv.ts"), ...args], { cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.log.trim().split("\n").at(-1)!)).toEqual(args);
  });

  test("a recipe command's exit code is its last native command's, or its exit", async () => {
    const cwd = scratch();
    expect((await step("Write-Output fine", { cwd })).exitCode).toBe(0);
    expect((await step("cmd /c exit 5", { cwd })).exitCode).toBe(5);
    expect((await step("exit 3", { cwd })).exitCode).toBe(3);
    expect((await step("throw 'broken'", { cwd })).exitCode).toBe(1);
    expect((await step(`cmd /c "echo it's ""quoted"" & exit 0"`, { cwd })).log).toContain(`it's "quoted"`);
  }, SLOW);

  test("a timeout kills the whole tree, grandchildren included", async () => {
    const cwd = scratch();
    const hb = join(cwd, "hb.txt");
    const r = await step(platform.shell(heartbeat(hb)), { cwd, timeoutMs: 6_000 });
    expect(r.timedOut).toBe(true);
    expect(await stopsBeating(hb)).toBe(true);
  }, SLOW);

  test("a restarted runner kills a tree from its recorded id, and nothing else", async () => {
    const cwd = scratch();
    const hb = join(cwd, "hb.txt");
    let id = 0;
    const running = step(platform.shell(heartbeat(hb)), { cwd, timeoutMs: 120_000, onStart: (n) => { id = n; } });
    while (!existsSync(hb)) await Bun.sleep(100);
    expect(groupAlive(id)).toBe(true);
    await killGroup(id);
    expect(groupAlive(id)).toBe(false);
    expect((await running).timedOut).toBe(false);
    expect(await stopsBeating(hb)).toBe(true);
    expect(groupAlive(process.pid)).toBe(false); // alive, but not a run-as helper
  }, SLOW);
});

describe.if(win && existsSync(SANDBOX_PASSWORD))("windows: the AgentrySandbox user", () => {
  // Inside the runner's home, which only the runner may read, so a grant is the only way in.
  let root = "", wt = "";
  let sbx: ReturnType<typeof sandbox>;
  beforeAll(() => {
    root = scratch(join(AGENTRY_HOME, "selftest"));
    wt = join(root, "worktree");
    mkdirSync(join(wt, "src", "deep"), { recursive: true });
    writeFileSync(join(wt, "src", "deep", "checked-out.txt"), "by the runner"); // there before the grant, like a checkout
    sbx = sandbox({ worktree: wt, runTmp: join(root, "tmp"), pkgCache: join(root, "cache") });
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });
  const run = (command: string | string[], o: { wrap?: string[]; timeoutMs?: number } = {}) =>
    step(command, { cwd: wt, wrap: o.wrap ?? sbx.wrap, env: sbx.env, timeoutMs: o.timeoutMs });

  test("steps run as AgentrySandbox, with the run's own profile and temp", async () => {
    const r = await run("whoami; $env:USERPROFILE; $env:TEMP; \"cwd=$PWD\"; [Environment]::CurrentDirectory");
    expect(r.exitCode).toBe(0);
    expect(r.log.toLowerCase()).toContain("\\agentrysandbox");
    expect(r.log).toContain(sbx.env.USERPROFILE);
    expect(r.log).toContain(sbx.env.TEMP);
    expect(r.log).toContain(`cwd=${wt}`);
    expect(r.log).not.toContain("CLIXML");
  }, SLOW);

  test("it writes the worktree and the run's temp", async () => {
    const r = await run(`$ErrorActionPreference = 'Stop'; Set-Content made.txt 'by the sandbox'; Set-Content -LiteralPath '${join(sbx.env.TEMP, "t.txt")}' x; exit 0`);
    expect({ exitCode: r.exitCode, log: r.log }).toEqual({ exitCode: 0, log: "" });
    expect(readFileSync(join(wt, "made.txt"), "utf8")).toContain("by the sandbox");
  }, SLOW);

  test("it changes files the runner checked out before the run", async () => {
    const f = join(wt, "src", "deep", "checked-out.txt");
    const r = await run(`$ErrorActionPreference = 'Stop'; Add-Content -LiteralPath '${f}' ' and the sandbox'; exit 0`);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(f, "utf8")).toContain("by the runner and the sandbox");
  }, SLOW);

  test("it can neither read the runner's secrets nor write the runner's home", async () => {
    const secrets = [SANDBOX_PASSWORD, join(AGENTRY_HOME, "claude-oauth-token"), join(AGENTRY_HOME, "agentry.db")].filter(existsSync);
    for (const f of secrets) {
      const r = await run(`Get-Content -LiteralPath '${f}' -ErrorAction Stop | Out-Null; exit 0`);
      expect({ f, exitCode: r.exitCode }).toEqual({ f, exitCode: 1 });
    }
    const w = await run(`Set-Content -LiteralPath '${join(AGENTRY_HOME, "planted.txt")}' x -ErrorAction Stop; exit 0`);
    expect(w.exitCode).toBe(1);
    expect(existsSync(join(AGENTRY_HOME, "planted.txt"))).toBe(false);
  }, SLOW);

  test.if(existsSync("C:\\Sites"))("it cannot read C:\\Sites", async () => {
    const r = await run("Get-ChildItem C:\\Sites -ErrorAction Stop | Out-Null; exit 0");
    expect(r.exitCode).toBe(1);
  }, SLOW);

  test("the job's memory cap stops a large allocation", async () => {
    const capped = sbx.wrap.map((a) => (a === String(STEP_MEMORY_MB) ? "256" : a));
    const alloc = (size: string) => `$ErrorActionPreference = 'Stop'; $a = New-Object byte[] ${size}; exit 0`;
    expect((await run(alloc("16MB"), { wrap: capped })).exitCode).toBe(0);
    expect((await run(alloc("1GB"), { wrap: capped })).exitCode).not.toBe(0);
  }, SLOW);

  test("a timeout kills the sandbox user's whole tree", async () => {
    const hb = join(sbx.env.TEMP, "hb.txt");
    const r = await run(heartbeat(hb), { timeoutMs: 8_000 });
    expect(r.timedOut).toBe(true);
    expect(await stopsBeating(hb)).toBe(true);
  }, SLOW);

  test("command lines longer than CreateProcessWithLogonW's 1024 characters work", async () => {
    const long = "x".repeat(3_000);
    const r = await run(`Write-Output ('${long}'.Length)`);
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain("3000");
  }, SLOW);
});
