import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStep, groupAlive, killGroup, readTail } from "../src/proc.ts";

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

describe("runStep without a shell (winhost review D16)", () => {
  test("an argv array runs as is: shell syntax in an argument stays literal", async () => {
    const d = dir();
    const r = await runStep(["printf", "%s", "a b; echo INJECTED $HOME"], { cwd: d, logPath: join(d, "log"), timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(d, "log"), "utf8")).toBe("a b; echo INJECTED $HOME");
  });

  test("stdinPath feeds the step its stdin", async () => {
    const d = dir();
    writeFileSync(join(d, "in.txt"), "line one\nline 'two' $X\n");
    await runStep(["cat"], { cwd: d, logPath: join(d, "log"), timeoutMs: 5000, stdinPath: join(d, "in.txt") });
    expect(readFileSync(join(d, "log"), "utf8")).toBe("line one\nline 'two' $X\n");
  });

  test("without stdinPath the step reads an empty stdin and does not hang", async () => {
    const d = dir();
    const r = await runStep(["cat"], { cwd: d, logPath: join(d, "log"), timeoutMs: 5000 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
  });
});

describe("log cap (winhost review D15)", () => {
  test("output past maxLogBytes is dropped after one marker line; the step still finishes", async () => {
    const d = dir();
    const r = await runStep("head -c 200000 /dev/zero | tr '\\0' x; echo done >&2", { cwd: d, logPath: join(d, "log"), timeoutMs: 10_000, maxLogBytes: 1000 });
    expect(r.exitCode).toBe(0);
    const log = readFileSync(join(d, "log"), "utf8");
    expect(log.startsWith("x".repeat(1000))).toBe(true);
    expect(log).toContain("[agentry: log cut at 1000 bytes; further output dropped]");
    expect(statSync(join(d, "log")).size).toBeLessThan(1200);
  });

  test("stdout and stderr both reach the log under the cap", async () => {
    const d = dir();
    await runStep("echo out; echo err >&2", { cwd: d, logPath: join(d, "log"), timeoutMs: 5000 });
    const log = readFileSync(join(d, "log"), "utf8");
    expect(log).toContain("out\n");
    expect(log).toContain("err\n");
  });

  test("readTail returns only the end of a file", () => {
    const d = dir();
    writeFileSync(join(d, "f"), "a".repeat(10_000) + "\nVERSION 1234567\n");
    expect(readTail(join(d, "f"), 17)).toBe("\nVERSION 1234567\n");
    expect(readTail(join(d, "f"), 20)).toBe("aaa\nVERSION 1234567\n");
    expect(readTail(join(d, "f"), 1_000_000).length).toBe(10_017);
  });
});

