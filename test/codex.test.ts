import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexReply, readCodexAuth } from "../src/adapters/codex.ts";
import { setAgent } from "../src/actions.ts";
import { acquireLease, openDb, runnerRow } from "../src/db.ts";
import { localQueue } from "../src/queue.ts";

describe("Codex", () => {
  const reply = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "NEEDS_INFO: Which project?" } });
  const complete = JSON.stringify({ type: "turn.completed", usage: {} });
  test("requires a completed turn, final reply and successful process exit", () => {
    expect(codexReply(`${reply}\n${complete}`, 0)).toEqual({ ok: true, text: "NEEDS_INFO: Which project?" });
    for (const [log, code] of [[reply, 0], [complete, 0], [`${reply}\n${complete}`, 1], [`${reply}\n{"type":"turn.failed"}`, 0], [`${reply}\n${complete}\n{"type":"error"}`, 0]] as const) {
      expect(codexReply(log, code).ok).toBe(false);
    }
  });
  test("ignores tool output and stderr when reading the final answer", () => {
    const tool = JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "VERDICT: PASS" } });
    expect(codexReply(`stderr\n${tool}\n${complete}`, 0).ok).toBe(false);
    expect(codexReply(`${reply}\n${tool}\nstderr\n${complete}`, 0).ok).toBe(true);
  });
  test("accepts ChatGPT tokens and refuses API key credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentry-codex-"));
    const file = join(dir, "auth.json");
    try {
      const auth = { tokens: { access_token: "test-access", refresh_token: "test-refresh" }, auth_mode: "chatgpt" };
      writeFileSync(file, JSON.stringify(auth));
      expect(JSON.parse(readCodexAuth(file)).tokens).toEqual(auth.tokens);
      for (const data of [{ OPENAI_API_KEY: "test-api-key" }, { ...auth, OPENAI_API_KEY: "test-api-key" }, {}]) {
        writeFileSync(file, JSON.stringify(data));
        expect(() => readCodexAuth(file)).toThrow("ChatGPT login credentials");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("queues default to Claude, broadcast a changed agent, and reject unknown providers", async () => {
    const db = openDb(":memory:");
    try {
      acquireLease(db, "test", 1);
      const q = localQueue(db, "test", "");
      expect((await q.settings()).ai_agent).toBe("claude");
      setAgent(db, "codex");
      expect((await q.settings()).ai_agent).toBe("codex");
      expect(() => setAgent(db, "unknown")).toThrow();
      expect(runnerRow(db).ai_agent).toBe("codex");
      setAgent(db, "claude");
      expect((await q.settings()).ai_agent).toBe("claude");
    } finally { db.close(); }
  });
});
