// Runs one step command in its own process group (eng review D8).
// On timeout the whole group gets SIGTERM, then SIGKILL after a grace period, and the result is returned only
// once no process of the group is left. Leftovers of a step that exited normally are swept the same way.
// A command line runs through the platform's shell; an argv array runs as is, with no shell (winhost review
// D16). Output reaches the log through Agentry, which stops writing at maxLogBytes (D15).
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "./platform.ts";

export const MAX_LOG_BYTES = 50 * 1024 * 1024;
const CLOSE_WAIT_MS = 5_000;

export type StepResult = { exitCode: number; timedOut: boolean; pgid: number };

export type StepOptions = {
  cwd: string;
  logPath: string;
  timeoutMs: number;
  env?: Record<string, string>;
  graceMs?: number;
  // Called with the process-group id as soon as the step starts, so it can be recorded for crash recovery (D17).
  onStart?: (pgid: number) => void;
  // Optional prefix, e.g. ["sandbox-exec", "-f", profile].
  wrap?: string[];
  // A file the step reads as its stdin (default: none).
  stdinPath?: string;
  // Output beyond this is dropped, after one marker line (default MAX_LOG_BYTES).
  maxLogBytes?: number;
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

export async function runStep(command: string | string[], opts: StepOptions): Promise<StepResult> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const argv = [...(opts.wrap ?? []), ...(typeof command === "string" ? platform.shell(command) : command)];
  const stdin = opts.stdinPath ? openSync(opts.stdinPath, "r") : "ignore";
  const child = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    stdio: [stdin, "pipe", "pipe"],
    detached: true, // new session, so the child leads its own process group
  });
  if (typeof stdin === "number") closeSync(stdin);
  const pgid = child.pid!;
  opts.onStart?.(pgid);
  const logged = capturedLog(opts.logPath, opts.maxLogBytes ?? MAX_LOG_BYTES, [child.stdout!, child.stderr!]);

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
  await logged.finish();
  return { exitCode: timedOut ? 124 : exitCode, timedOut, pgid };
}

// Appends both streams to the log until `max` bytes, then one marker line; the rest is read and dropped so the
// step never blocks on a full pipe. `finish`, called once the group is gone, resolves when both streams end,
// or after CLOSE_WAIT_MS if a process outside the group still holds them open.
function capturedLog(path: string, max: number, streams: NodeJS.ReadableStream[]): { finish(): Promise<void> } {
  const out = createWriteStream(path, { flags: "a" });
  let written = 0;
  let cut = false;
  const ended = Promise.all(streams.map((st) => new Promise<void>((resolve) => {
    st.on("data", (chunk: Buffer) => {
      if (cut) return;
      const room = max - written;
      if (chunk.length <= room) { out.write(chunk); written += chunk.length; return; }
      if (room > 0) out.write(chunk.subarray(0, room));
      written = max;
      cut = true;
      out.write(`\n[agentry: log cut at ${max} bytes; further output dropped]\n`);
    });
    st.on("end", resolve);
    st.on("close", resolve);
    st.on("error", () => resolve());
  })));
  return {
    async finish() {
      let timer: Timer | undefined;
      const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_WAIT_MS); });
      await Promise.race([ended, grace]);
      clearTimeout(timer);
      for (const st of streams) (st as any).destroy?.();
      await new Promise<void>((resolve) => out.end(resolve));
    },
  };
}

// The last `bytes` bytes of a file, as text (a log's tail, e.g. a VERSION line).
export function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  return buf.toString("utf8");
}
