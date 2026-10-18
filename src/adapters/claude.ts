// The claude adapter (slice 1): `claude -p` inside the run's sandbox, for the agent step and the verifier.
// Two ways to authenticate, neither touching the keychain the sandbox denies:
//   api_key        --bare: no hooks, plugins, keychain or CLAUDE.md discovery; auth only via the apiKeyHelper (D4)
//   subscription   a `claude setup-token` token in CLAUDE_CODE_OAUTH_TOKEN, billed to the Claude plan. --bare
//                  refuses OAuth, so --safe-mode turns off CLAUDE.md, plugins, hooks and MCP instead, and
//                  --setting-sources user reads only the run's empty CLAUDE_CONFIG_DIR, never the worktree's
//                  agent-writable .claude/ settings. Like the API key, the token is readable by agent code.
// Both: --strict-mcp-config (the user's own connectors alone are ~885k tokens per call) and an explicit
// --tools list; the sandbox, not the permission mode, is the boundary.
// The prompt goes through a file in the run's temp dir. Output is stream-json in the step log; its final
// `result` event decides: is_error, a crash without a result, or a timeout is infra_error.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runStep } from "../proc.ts";
import { AGENTRY_HOME, KEY_HELPER } from "../sandbox.ts";
import type { Agent, StepIO } from "./types.ts";

export type ClaudeAuth = { kind: "api_key"; keyHelper: string } | { kind: "subscription"; token: string };

export type ClaudeOptions = { bin: string; model?: string; auth?: ClaudeAuth }; // default: api_key with KEY_HELPER

// Output of `claude setup-token`, saved by the user (chmod 600).
export const OAUTH_TOKEN_FILE = join(AGENTRY_HOME, "claude-oauth-token");

// The subscription token when ~/.agentry/claude-oauth-token exists, else the API key helper. Whitespace is dropped
// anywhere in it: `claude setup-token` wraps the token over two lines, and a copied line break would cut it.
export function resolveAuth(tokenFile = OAUTH_TOKEN_FILE, keyHelper = KEY_HELPER): ClaudeAuth {
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, "utf8").replace(/\s+/g, "");
    if (!token) throw new Error(`${tokenFile} is empty`);
    return { kind: "subscription", token };
  }
  return { kind: "api_key", keyHelper };
}

export type Reply = { ok: true; text: string } | { ok: false; detail: string };

type ResultEvent = { type: "result"; is_error?: boolean; subtype?: string; result?: string };

const AGENT_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export async function callClaude(o: ClaudeOptions, io: StepIO, prompt: string, tools: string[], mode: "bypassPermissions" | "dontAsk"): Promise<Reply> {
  const promptFile = join(io.sandbox.env.TMPDIR, `prompt-${process.hrtime.bigint()}.txt`);
  writeFileSync(promptFile, prompt);
  const auth = o.auth ?? { kind: "api_key", keyHelper: KEY_HELPER };
  const authArgs = auth.kind === "api_key"
    ? ["--bare", "--settings", JSON.stringify({ apiKeyHelper: auth.keyHelper })]
    : ["--safe-mode", "--setting-sources", "user"];
  const argv = [
    o.bin, "-p", ...authArgs, "--strict-mcp-config", "--no-session-persistence", "--output-format", "stream-json", "--verbose",
    "--tools", tools.join(","), "--permission-mode", mode, ...(o.model ? ["--model", o.model] : []),
  ];
  const env = auth.kind === "subscription" ? { ...io.sandbox.env, CLAUDE_CODE_OAUTH_TOKEN: auth.token } : io.sandbox.env;
  const r = await runStep(`${argv.map(shq).join(" ")} < ${shq(promptFile)}`, {
    cwd: io.worktree, logPath: io.logPath, timeoutMs: io.timeoutMs, wrap: io.sandbox.wrap, env, onStart: io.onStart,
  });
  if (r.timedOut) return { ok: false, detail: `claude timed out after ${Math.round(io.timeoutMs / 1000)} s` };
  const result = lastResult(readFileSync(io.logPath, "utf8"));
  if (!result) return { ok: false, detail: `claude exited ${r.exitCode} without a result` };
  if (result.is_error) return { ok: false, detail: result.result || result.subtype || "error" };
  return { ok: true, text: result.result ?? "" };
}

function lastResult(log: string): ResultEvent | null {
  let found: ResultEvent | null = null;
  for (const line of log.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === "result") found = ev;
    } catch { /* stderr or a partial line */ }
  }
  return found;
}

export function claudeAgent(o: ClaudeOptions): Agent {
  return {
    async run(io) {
      const reply = await callClaude(o, io, io.prompt, AGENT_TOOLS, "bypassPermissions");
      if (!reply.ok) return { outcome: "infra_error", detail: reply.detail };
      const q = reply.text.match(/^\s*NEEDS_INFO:\s*(.+)$/m);
      return q ? { outcome: "needs_info", question: q[1].trim() } : { outcome: "finished" };
    },
  };
}
