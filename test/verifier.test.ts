// The claude adapter and the done-when verifier (T5, eng review D9), with a fake `claude` binary run through the
// real sandbox. The fake records its arguments and stdin in the run's temp dir and prints a canned reply.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAgent, resolveAuth } from "../src/adapters/claude.ts";
import type { StepIO } from "../src/adapters/types.ts";
import { addWorktree } from "../src/git.ts";
import { sandbox } from "../src/sandbox.ts";
import { claudeVerifier, MAX_DIFF_CHARS, parseVerdict, verifierPrompt } from "../src/verifier.ts";
import { makeFixture } from "./fixture.ts";

const FAKE = `#!/bin/zsh
printf '%s\\n' "$@" > "$TMPDIR/fake-args"
printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "$TMPDIR/fake-token"
cat > "$TMPDIR/fake-stdin"
[[ -f "$TMPDIR/fake-sleep" ]] && sleep "$(<"$TMPDIR/fake-sleep")"
[[ -f "$TMPDIR/fake-out" ]] && cat "$TMPDIR/fake-out"
exit "$(cat "$TMPDIR/fake-exit" 2>/dev/null || echo 0)"
`;

const resultLine = (result: string, isError = false) => JSON.stringify({ type: "result", subtype: "success", is_error: isError, result });

let n = 0;
function setup(o: { out?: string; exit?: number; sleep?: number; timeoutMs?: number } = {}) {
  const fx = makeFixture();
  const wt = join(fx.root, "wt");
  addWorktree(fx.repo, wt, "agentry/1-1", "main");
  const bin = join(fx.root, "claude");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const sbx = sandbox({ worktree: wt, runTmp: join(fx.root, "tmp"), claudeBin: bin, keyHelper: join(fx.root, "key-helper") });
  const tmp = sbx.env.TMPDIR;
  if (o.out !== undefined) writeFileSync(join(tmp, "fake-out"), o.out);
  if (o.exit !== undefined) writeFileSync(join(tmp, "fake-exit"), String(o.exit));
  if (o.sleep !== undefined) writeFileSync(join(tmp, "fake-sleep"), String(o.sleep));
  const pgids: number[] = [];
  const io: StepIO = { worktree: wt, logPath: join(fx.root, "logs", `${++n}.log`), timeoutMs: o.timeoutMs ?? 20_000, sandbox: sbx, onStart: (p) => pgids.push(p) };
  return {
    io, bin, pgids,
    args: () => readFileSync(join(tmp, "fake-args"), "utf8").trimEnd().split("\n"),
    stdin: () => readFileSync(join(tmp, "fake-stdin"), "utf8"),
    token: () => readFileSync(join(tmp, "fake-token"), "utf8"),
  };
}

const input = { title: "Reject empty words", body: "POST /words must refuse an empty term.", doneWhen: "POST /words with term \"\" returns 400", diff: "+if (string.IsNullOrWhiteSpace(term)) return BadRequest();", testSummary: "tests: 12 total, 12 passed, 0 failed, 0 skipped" };

describe("verifier (D9)", () => {
  test("PASS with evidence; claude runs bare, without MCP, with Read and Grep only, in dontAsk mode", async () => {
    const h = setup({ out: `{"type":"system","subtype":"init"}\n${resultLine("Checked WordsController.\n\nVERDICT: PASS\nEVIDENCE: WordsController.cs:41 returns BadRequest for blank terms.")}\n` });
    const v = await claudeVerifier({ bin: h.bin, auth: { kind: "api_key", keyHelper: "/k/helper" } }).verify({ ...h.io, ...input });
    expect(v).toEqual({ verdict: "PASS", evidence: "WordsController.cs:41 returns BadRequest for blank terms." });
    const args = h.args();
    expect(args[0]).toBe("-p");
    expect(args).toContain("--bare");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({ apiKeyHelper: "/k/helper" });
    expect(h.token()).toBe("");
    expect(h.stdin()).toBe(verifierPrompt(input));
    expect(h.pgids).toHaveLength(1);
  });

  test("FAIL with evidence", async () => {
    const h = setup({ out: resultLine("VERDICT: FAIL\nEVIDENCE: whitespace-only terms still pass.") + "\n" });
    expect(await claudeVerifier({ bin: h.bin }).verify({ ...h.io, ...input })).toEqual({ verdict: "FAIL", evidence: "whitespace-only terms still pass." });
  });

  test("a garbled reply is FAIL with the raw text, never PASS", async () => {
    const h = setup({ out: resultLine("I think this mostly works, probably fine.") + "\n" });
    expect(await claudeVerifier({ bin: h.bin }).verify({ ...h.io, ...input })).toEqual({
      verdict: "FAIL", evidence: "unparseable verifier reply: I think this mostly works, probably fine.",
    });
  });

  test("an API error result (usage limit) is infra_error", async () => {
    const h = setup({ out: resultLine("Credit balance is too low", true) + "\n", exit: 1 });
    expect(await claudeVerifier({ bin: h.bin }).verify({ ...h.io, ...input })).toEqual({ verdict: "infra_error", evidence: "Credit balance is too low" });
  });

  test("a crash without a result is infra_error", async () => {
    const h = setup({ out: "Error: something broke\n", exit: 1 });
    expect(await claudeVerifier({ bin: h.bin }).verify({ ...h.io, ...input })).toEqual({ verdict: "infra_error", evidence: "claude exited 1 without a result" });
  });

  test("a timeout is infra_error and the process group is gone", async () => {
    const h = setup({ sleep: 30, timeoutMs: 300 });
    const v = await claudeVerifier({ bin: h.bin }).verify({ ...h.io, ...input });
    expect(v).toEqual({ verdict: "infra_error", evidence: "claude timed out after 0 s" });
  });
});

describe("parseVerdict", () => {
  test.each([
    ["VERDICT: PASS\nEVIDENCE: ok", "PASS", "ok"],
    ["**VERDICT:** FAIL\n**EVIDENCE:** wrong field", "FAIL", "wrong field"],
    ["verdict: pass\nevidence: fine", "PASS", "fine"],
    ["First thought VERDICT: PASS.\nOn reflection:\nVERDICT: FAIL\nEVIDENCE: edge case missed", "FAIL", "edge case missed"],
  ])("%p → %s", (text, verdict, evidence) => {
    expect(parseVerdict(text)).toEqual({ verdict: verdict as "PASS" | "FAIL", evidence });
  });

  test("a verdict mentioned mid-sentence does not count", () => {
    expect(parseVerdict("I would say VERDICT: PASS here").verdict).toBe("FAIL");
  });

  test("a huge diff is cut", () => {
    const p = verifierPrompt({ ...input, diff: "x".repeat(MAX_DIFF_CHARS + 10) });
    expect(p).toContain("diff cut at");
    expect(p.length).toBeLessThan(MAX_DIFF_CHARS + 5_000);
  });
});

describe("claude agent", () => {
  test("a normal reply is finished; it runs with the edit tools in bypassPermissions mode", async () => {
    const h = setup({ out: resultLine("Done: changed WordsController.") + "\n" });
    expect(await claudeAgent({ bin: h.bin, model: "opus" }).run({ ...h.io, prompt: "do it" })).toEqual({ outcome: "finished" });
    const args = h.args();
    expect(args[args.indexOf("--tools") + 1]).toBe("Bash,Read,Edit,Write,Glob,Grep");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(h.stdin()).toBe("do it");
  });

  test("NEEDS_INFO: becomes needs_info with the question", async () => {
    const h = setup({ out: resultLine("NEEDS_INFO: Which endpoint, /words or /lists?") + "\n" });
    expect(await claudeAgent({ bin: h.bin }).run({ ...h.io, prompt: "x" })).toEqual({ outcome: "needs_info", question: "Which endpoint, /words or /lists?" });
  });

  test("an error result is infra_error", async () => {
    const h = setup({ out: resultLine("rate limited", true) + "\n", exit: 1 });
    expect(await claudeAgent({ bin: h.bin }).run({ ...h.io, prompt: "x" })).toEqual({ outcome: "infra_error", detail: "rate limited" });
  });
});

describe("subscription auth", () => {
  test("the token goes in CLAUDE_CODE_OAUTH_TOKEN; safe mode and user-only settings replace --bare and the key helper", async () => {
    const h = setup({ out: resultLine("VERDICT: PASS\nEVIDENCE: ok") + "\n" });
    const v = await claudeVerifier({ bin: h.bin, auth: { kind: "subscription", token: "sk-ant-oat-test" } }).verify({ ...h.io, ...input });
    expect(v.verdict).toBe("PASS");
    const args = h.args();
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--settings");
    expect(h.token()).toBe("sk-ant-oat-test");
    expect(h.io.sandbox.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // only the claude step gets it, not build or test
  });

  test("resolveAuth: the token file wins over the key helper; without it, the key helper", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentry-auth-"));
    const tokenFile = join(dir, "claude-oauth-token");
    expect(resolveAuth(tokenFile, "/k/helper")).toEqual({ kind: "api_key", keyHelper: "/k/helper" });
    writeFileSync(tokenFile, "sk-ant-oat-abc\n");
    expect(resolveAuth(tokenFile, "/k/helper")).toEqual({ kind: "subscription", token: "sk-ant-oat-abc" });
    writeFileSync(tokenFile, "\n");
    expect(() => resolveAuth(tokenFile)).toThrow("is empty");
  });
});
