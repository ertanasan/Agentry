import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTail, runStep } from "../proc.ts";
import { parseVerdict, verifierPrompt } from "../verifier.ts";
import type { Agent, StepIO, Verifier } from "./types.ts";
import type { Reply } from "./claude.ts";

export type CodexOptions = { bin: string; model?: string; token?: string; authFile?: string };

// Accept ChatGPT login credentials only; never silently switch to API billing.
export function readCodexAuth(file: string): string {
  const auth = JSON.parse(readFileSync(file, "utf8"));
  if (auth.OPENAI_API_KEY || !auth.tokens?.access_token || !auth.tokens?.refresh_token) {
    throw new Error("Codex needs ChatGPT login credentials. Run codex login with cli_auth_credentials_store=\"file\", or save a Codex access token.");
  }
  return JSON.stringify({ ...auth, OPENAI_API_KEY: null });
}

export async function callCodex(o: CodexOptions, io: StepIO, prompt: string, readOnly = false): Promise<Reply> {
  let authPath: string | undefined;
  try {
    const home = join(io.sandbox.env.TMPDIR, `codex-${process.hrtime.bigint()}`);
    mkdirSync(home, { recursive: true });
    if (!o.token) {
      if (!o.authFile) throw new Error("Codex authentication is missing: use agentry token codex or set AGENTRY_CODEX_AUTH_FILE to a ChatGPT auth.json.");
      authPath = join(home, "auth.json");
      writeFileSync(authPath, readCodexAuth(o.authFile), { mode: 0o600 });
    }
    const input = join(home, "prompt.txt");
    writeFileSync(input, prompt);
    const argv = [o.bin, "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "-c", "mcp_servers={}", "-c", 'cli_auth_credentials_store="file"',
      ...(readOnly ? ["--sandbox", "read-only"] : ["--dangerously-bypass-approvals-and-sandbox"]),
      ...(o.model ? ["--model", o.model] : []), "-"];
    const env = { ...io.sandbox.env, CODEX_HOME: home, ...(o.token ? { CODEX_ACCESS_TOKEN: o.token } : {}) };
    delete (env as Record<string, string>).OPENAI_API_KEY;
    delete (env as Record<string, string>).CODEX_API_KEY;
    const r = await runStep(argv, { cwd: io.worktree, logPath: io.logPath, timeoutMs: io.timeoutMs,
      wrap: io.sandbox.wrap, env, onStart: io.onStart, stdinPath: input });
    if (r.timedOut) return { ok: false, detail: `codex timed out after ${Math.round(io.timeoutMs / 1000)} s` };
    return codexReply(readTail(io.logPath, 4 * 1024 * 1024), r.exitCode);
  } catch (e) {
    // Do not include credential file contents in logs, including JSON parser errors.
    return { ok: false, detail: e instanceof SyntaxError ? "Invalid Codex authentication JSON" : (e as Error).message };
  } finally {
    if (authPath) { try { unlinkSync(authPath); } catch { /* missing or removed by the step */ } }
  }
}

export function codexReply(log: string, exitCode: number | null): Reply {
  let complete = false;
  let failed = false;
  let text = "";
  for (const line of log.split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "turn.completed") complete = true;
      if (ev.type === "turn.failed" || ev.type === "error") failed = true;
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text ?? "";
    } catch { /* stderr or partial line */ }
  }
  return exitCode === 0 && complete && !failed && text.trim()
    ? { ok: true, text } : { ok: false, detail: `codex exited ${exitCode} without a successful completed reply; see step log` };
}

export function codexAgent(o: CodexOptions): Agent {
  return { async run(io) {
    const reply = await callCodex(o, io, io.prompt);
    if (!reply.ok) return { outcome: "infra_error", detail: reply.detail };
    const q = reply.text.match(/^\s*NEEDS_INFO:\s*(.+)$/m);
    return q ? { outcome: "needs_info", question: q[1].trim() } : { outcome: "finished" };
  } };
}

export function codexVerifier(o: CodexOptions): Verifier {
  return { async verify(io) {
    const reply = await callCodex(o, io, verifierPrompt(io), true);
    return reply.ok ? parseVerdict(reply.text) : { verdict: "infra_error", evidence: reply.detail };
  } };
}
