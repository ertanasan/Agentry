// Runs one step command in its own process group (eng review D8).
// On timeout the whole group gets SIGTERM, then SIGKILL after a grace period, and the result is returned only
// once no process of the group is left. Leftovers of a step that exited normally are swept the same way.
import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type StepResult = { exitCode: number; timedOut: boolean; pgid: number };

export type StepOptions = {
  cwd: string;
  logPath: string;
  timeoutMs: number;
  env?: Record<string, string>;
  graceMs?: number;
  // Called with the process-group id as soon as the step starts, so it can be recorded for crash recovery (D17).
  onStart?: (pgid: number) => void;
  // Optional prefix, e.g. ["sandbox-exec", "-f", profile]; the command itself always runs through /bin/zsh -c.
  wrap?: string[];
};

export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (e: any) { return e.code === "EPERM"; }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* group already gone */ }
}

// Terminates every process in the group: SIGTERM, wait up to graceMs, then SIGKILL, then wait until it is gone.
export async function killGroup(pgid: number, graceMs = 20_000): Promise<void> {
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await Bun.sleep(50);
  if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
  while (groupAlive(pgid)) await Bun.sleep(50);
}

export async function runStep(command: string, opts: StepOptions): Promise<StepResult> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = openSync(opts.logPath, "a");
  const argv = [...(opts.wrap ?? []), "/bin/zsh", "-c", command];
  const child = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    stdio: ["ignore", log, log],
    detached: true, // new session, so the child leads its own process group
  });
  closeSync(log);
  const pgid = child.pid!;
  opts.onStart?.(pgid);

  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on("error", () => resolve(127));
  });
  let timer: Timer | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), opts.timeoutMs); });
  const first = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  const timedOut = first === "timeout";
  await killGroup(pgid, timedOut ? (opts.graceMs ?? 20_000) : 0);
  const exitCode = await exited;
  return { exitCode: timedOut ? 124 : exitCode, timedOut, pgid };
}
