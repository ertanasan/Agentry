import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotAgent, copilotReply, copilotToken, copilotVerifier } from "../src/adapters/copilot.ts";
import * as A from "../src/actions.ts";
import { openDb, runnerRow } from "../src/db.ts";
import type { StepIO } from "../src/adapters/types.ts";

const ev = (type: string, data: object) => JSON.stringify({ type, data, id: "1", parentId: null, timestamp: "2026-10-29T00:00:00Z" });

// A stand-in copilot: records its arguments and environment, then prints the events in $TMPDIR/out.
const FAKE = `#!/bin/sh
printf '%s\\n' "$@" > "$TMPDIR/args"
printf '%s|%s|%s' "$COPILOT_HOME" "$COPILOT_GITHUB_TOKEN" "$GH_TOKEN" > "$TMPDIR/env"
cat "$TMPDIR/out"
`;

function setup(out: string) {
  const root = mkdtempSync(join(tmpdir(), "agentry-copilot-"));
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  const bin = join(root, "copilot");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  writeFileSync(join(tmp, "out"), out);
  const io: StepIO = { worktree: root, logPath: join(root, "step.log"), timeoutMs: 10_000, onStart: () => {},
    sandbox: { wrap: [], env: { TMPDIR: tmp, PATH: process.env.PATH ?? "", GH_TOKEN: "ghp_leak" } } };
  return { io, bin, root, args: () => readFileSync(join(tmp, "args"), "utf8").trimEnd().split("\n"), env: () => readFileSync(join(tmp, "env"), "utf8").split("|") };
}

describe("GitHub Copilot CLI", () => {
  test("the reply is the last assistant message with text; an error or a missing reply fails", () => {
    const tool = ev("assistant.message", { content: "", messageId: "a", toolRequests: [{ name: "edit", toolCallId: "t" }] });
    const done = ev("assistant.message", { content: "NEEDS_INFO: Which project?", messageId: "b" });
    expect(copilotReply(`stderr\n${tool}\n${done}`, 0)).toEqual({ ok: true, text: "NEEDS_INFO: Which project?" });
    expect(copilotReply(`${done}\n${ev("session.error", { message: "quota exceeded", errorType: "rate_limit" })}`, 0)).toEqual({ ok: false, detail: "copilot: quota exceeded" });
    expect(copilotReply(`${done}\n${ev("session.shutdown", { shutdownType: "error" })}`, 0).ok).toBe(false);
    expect(copilotReply(`${done}\n${ev("session.shutdown", { shutdownType: "routine" })}`, 0).ok).toBe(true);
    expect(copilotReply(done, 1).ok).toBe(false);
    expect(copilotReply("plain text, not the JSON events", 0).ok).toBe(false); // a format change can't pass as a reply
  });

  test("takes fine-grained and gh OAuth tokens, refuses classic ones and anything else", () => {
    expect(copilotToken(" github_pat_11ABC_def\n")).toBe("github_pat_11ABC_def");
    expect(copilotToken("gho_abc123")).toBe("gho_abc123");
    expect(() => copilotToken("ghp_abc123")).toThrow("classic tokens");
    expect(() => copilotToken("sk-ant-oat01-x")).toThrow("fine-grained GitHub token");
  });

  test("runs headless with a fresh home and Agentry's token only; the verifier gets read-only tools", async () => {
    const h = setup(ev("assistant.message", { content: "done", messageId: "m" }) + "\n");
    try {
      expect(await copilotAgent({ bin: h.bin, token: "github_pat_test" }).run({ ...h.io, prompt: "Fix it" })).toEqual({ outcome: "finished" });
      const args = h.args();
      const [home, token, leaked] = h.env();
      expect(token).toBe("github_pat_test");
      expect(leaked).toBe(""); // GH_TOKEN from the environment never reaches it
      expect(readFileSync(join(home, "request.md"), "utf8")).toBe("Fix it");
      expect(args[1]).toContain(join(home, "request.md")); // -p points at the prompt file
      for (const flag of ["--output-format", "--no-auto-update", "--no-ask-user", "--disable-builtin-mcps", "--allow-all-tools"]) expect(args).toContain(flag);
      expect(args).not.toContain("--available-tools");

      writeFileSync(join(h.io.sandbox.env.TMPDIR, "out"), ev("assistant.message", { content: "VERDICT: PASS\nEVIDENCE: the test returns 400", messageId: "v" }) + "\n");
      const input = { title: "t", body: "b", doneWhen: "d", diff: "+x", testSummary: "1 passed" };
      expect((await copilotVerifier({ bin: h.bin, token: "github_pat_test" }).verify({ ...h.io, ...input })).verdict).toBe("PASS");
      expect(h.args().slice(h.args().indexOf("--available-tools") + 1, h.args().indexOf("--available-tools") + 4)).toEqual(["read_file", "file_search", "grep_search"]);

      expect(await copilotAgent({ bin: h.bin }).run({ ...h.io, prompt: "x" })).toMatchObject({ outcome: "infra_error", detail: expect.stringContaining("agentry token copilot") });
    } finally { rmSync(h.root, { recursive: true, force: true }); }
  });

  test("the queue and a request can use it", () => {
    const db = openDb(":memory:");
    try {
      A.setAgent(db, "copilot");
      expect(runnerRow(db).ai_agent).toBe("copilot");
      db.exec("INSERT INTO repos (name, path) VALUES ('r', '/r'); INSERT INTO deploy_groups (name) VALUES ('g'); INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('web', 1, 1, '{}')");
      const id = A.addRequest(db, { projects: ["web"], title: "t", body: "b", agent: "copilot" });
      expect(db.query("SELECT ai_agent FROM requests WHERE id = ?").get(id)).toEqual({ ai_agent: "copilot" });
    } finally { db.close(); }
  });
});
