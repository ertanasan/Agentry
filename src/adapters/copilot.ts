import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTail, runStep } from "../proc.ts";
import { parseVerdict, verifierPrompt } from "../verifier.ts";
import type { Agent, StepIO, Verifier } from "./types.ts";
import type { Reply } from "./claude.ts";

export type CopilotOptions = { bin: string; token?: string; model?: string };

// A GitHub token Copilot CLI accepts: fine-grained (github_pat_, with the Copilot Requests permission) or the
// GitHub CLI's OAuth token (gho_). Classic tokens (ghp_) are refused.
export function copilotToken(raw: string): string {
  const token = raw.replace(/\s+/g, "");
  if (token.startsWith("ghp_")) throw new Error("Copilot CLI doesn't take classic tokens (ghp_): use a fine-grained token with the Copilot Requests permission");
  if (!/^(github_pat_|gho_)[A-Za-z0-9_]+$/.test(token)) throw new Error("Paste a fine-grained GitHub token (github_pat_...) or a gh OAuth token (gho_...)");
  return token;
}

// Tools the read-only verifier may use: reading and searching the worktree, nothing that writes or runs commands.
const READ_ONLY_TOOLS = ["read_file", "file_search", "grep_search"];

// One call: a fresh COPILOT_HOME (no user config, stored login, MCP servers or plugins), the token from Agentry,
// the prompt in a file that the -p prompt points at (a long prompt can't go on a Windows command line).
export async function callCopilot(o: CopilotOptions, io: StepIO, prompt: string, readOnly = false): Promise<Reply> {
  try {
    if (!o.token) throw new Error("Copilot authentication is missing: save a token with agentry token copilot.");
    const home = join(io.sandbox.env.TMPDIR, `copilot-${process.hrtime.bigint()}`);
    mkdirSync(home, { recursive: true });
    const input = join(home, "request.md");
    writeFileSync(input, prompt);
    const argv = [o.bin, "-p", `Read the file ${input} and carry out the request in it exactly. Its last instructions say how to end your reply.`,
      "--output-format", "json", "--no-auto-update", "--no-remote", "--no-ask-user", "--disable-builtin-mcps", "--no-color",
      "--add-dir", home, "--allow-all-tools",
      ...(readOnly ? ["--available-tools", ...READ_ONLY_TOOLS] : []),
      ...(o.model ? ["--model", o.model] : [])];
    const env: Record<string, string> = { ...io.sandbox.env, COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: o.token, COPILOT_AUTO_UPDATE: "false" };
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_PROVIDER_BASE_URL", "COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BEARER_TOKEN", "COPILOT_ALLOW_ALL"]) delete env[key];
    const r = await runStep(argv, { cwd: io.worktree, logPath: io.logPath, timeoutMs: io.timeoutMs,
      wrap: io.sandbox.wrap, env, onStart: io.onStart });
    if (r.timedOut) return { ok: false, detail: `copilot timed out after ${Math.round(io.timeoutMs / 1000)} s` };
    return copilotReply(readTail(io.logPath, 4 * 1024 * 1024), r.exitCode);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

// The JSONL session events: the reply is the last assistant message with text; a session error, or a shutdown
// for an error, fails the call. Anything else unexpected fails it too, so a format change can't pass as a reply.
export function copilotReply(log: string, exitCode: number | null): Reply {
  let text = "";
  let error: string | null = null;
  for (const line of log.split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "assistant.message" && typeof ev.data?.content === "string" && ev.data.content.trim()) text = ev.data.content;
      if (ev.type === "session.error") error = String(ev.data?.message ?? "session error");
      if (ev.type === "session.shutdown" && ev.data?.shutdownType === "error") error ??= "the session shut down with an error";
    } catch { /* stderr or partial line */ }
  }
  if (error) return { ok: false, detail: `copilot: ${error}` };
  return exitCode === 0 && text.trim()
    ? { ok: true, text } : { ok: false, detail: `copilot exited ${exitCode} without a completed reply; see step log` };
}

export function copilotAgent(o: CopilotOptions): Agent {
  return { async run(io) {
    const reply = await callCopilot(o, io, io.prompt);
    if (!reply.ok) return { outcome: "infra_error", detail: reply.detail };
    const q = reply.text.match(/^\s*NEEDS_INFO:\s*(.+)$/m);
    return q ? { outcome: "needs_info", question: q[1].trim() } : { outcome: "finished" };
  } };
}

export function copilotVerifier(o: CopilotOptions): Verifier {
  return { async verify(io) {
    const reply = await callCopilot(o, io, verifierPrompt(io), true);
    return reply.ok ? parseVerdict(reply.text) : { verdict: "infra_error", evidence: reply.detail };
  } };
}
