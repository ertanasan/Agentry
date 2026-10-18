import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStep, groupAlive, killGroup } from "../src/proc.ts";

const dir = () => mkdtempSync(join(tmpdir(), "agentry-proc-"));

describe("runStep", () => {
  test("returns the exit code and writes output to the log", async () => {
    const d = dir();
    const r = await runStep("echo hello; exit 3", { cwd: d, logPath: join(d, "log"), timeoutMs: 5000 });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(readFileSync(join(d, "log"), "utf8")).toContain("hello");
  });

  test("timeout kills a forked child too, and returns only after the group is gone (D8)", async () => {
    const d = dir();
    let pgid = 0;
    const r = await runStep("sleep 30 & sleep 30; wait", {
      cwd: d, logPath: join(d, "log"), timeoutMs: 200, graceMs: 200, onStart: (g) => (pgid = g),
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(pgid).toBe(r.pgid);
    expect(groupAlive(r.pgid)).toBe(false);
  });

  test("a child that ignores SIGTERM is killed after the grace period", async () => {
    const d = dir();
    const started = Date.now();
    const r = await runStep("trap '' TERM; sleep 30", { cwd: d, logPath: join(d, "log"), timeoutMs: 100, graceMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(groupAlive(r.pgid)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("background leftovers of a step that exits normally are swept", async () => {
    const d = dir();
    const r = await runStep("sleep 30 &; exit 0", { cwd: d, logPath: join(d, "log"), timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(groupAlive(r.pgid)).toBe(false);
  });

  test("killGroup on a dead group returns at once", async () => {
    await killGroup(999_999, 0);
  });
});
