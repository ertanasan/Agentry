// What differs between the systems a runner can run on: the shell recipe commands run in, and how a step's whole
// process tree is started, checked and killed (eng review D8, D17). macOS here; Windows in platform-windows.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import { windows } from "./platform-windows.ts";

export type TreeOptions = { cwd: string; env?: Record<string, string>; stdin: "ignore" | number };

export type Platform = {
  // The argv that runs one recipe command line in this system's shell.
  shell(command: string): string[];
  // Starts argv as a process tree of its own, stdout and stderr piped. The child's pid stands for the whole tree:
  // `treeAlive` and `killTree` take it, also in a restarted runner that only has the recorded number.
  spawnTree(argv: string[], o: TreeOptions): ChildProcess;
  treeAlive(id: number): boolean;
  // Ends every process of the tree, politely first where the system has a way (up to graceMs), and returns once
  // it is gone.
  killTree(id: number, graceMs: number): Promise<void>;
};

// macOS: the step leads a new process group; its pid is the group id.
export const mac: Platform = {
  shell: (command) => ["/bin/zsh", "-c", command],
  spawnTree: (argv, o) => spawn(argv[0], argv.slice(1), {
    cwd: o.cwd, env: o.env ?? (process.env as Record<string, string>), stdio: [o.stdin, "pipe", "pipe"],
    detached: true, // new session, so the child leads its own process group
  }),
  treeAlive(pgid) {
    try { process.kill(-pgid, 0); return true; }
    catch (e: any) { return e.code === "EPERM"; }
  },
  // SIGTERM, wait up to graceMs, then SIGKILL, then wait until the group is gone.
  async killTree(pgid, graceMs) {
    if (!mac.treeAlive(pgid)) return;
    signalGroup(pgid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (mac.treeAlive(pgid) && Date.now() < deadline) await Bun.sleep(50);
    if (mac.treeAlive(pgid)) signalGroup(pgid, "SIGKILL");
    while (mac.treeAlive(pgid)) await Bun.sleep(50);
  },
};

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* group already gone */ }
}

export const platform: Platform = process.platform === "win32" ? windows : mac;

// The worker count this machine suits: one per 4 CPU cores and per 8 GB of memory (a Windows step may use 8 GB),
// whichever allows fewer, and at least one.
export function suggestedWorkers(cores = availableParallelism(), memoryBytes = totalmem()): number {
  return Math.max(1, Math.min(Math.floor(cores / 4), Math.floor(memoryBytes / 2 ** 33)));
}
