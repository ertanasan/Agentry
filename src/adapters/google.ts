import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTail, runStep } from "../proc.ts";
import { parseVerdict, verifierPrompt } from "../verifier.ts";
import type { Reply } from "./claude.ts";
import type { Agent, StepIO, Verifier } from "./types.ts";

export type GoogleOptions = { bin: string; authFile: string; model?: string };

export function oauthCredentials(raw: string): string {
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error("Invalid Google OAuth credential JSON"); }
  if (typeof data?.refresh_token !== "string" || !data.refresh_token.trim() || data.type === "service_account" || data.api_key || data.GEMINI_API_KEY) {
    throw new Error("Google OAuth refresh-token credentials are required; API keys are not supported");
  }
  return JSON.stringify(data);
}

// System overrides take precedence over worktree settings, including for the read-only verifier.
export function geminiSettings(readOnly: boolean) {
  return {
    security: { auth: { selectedType: "oauth-personal", enforcedType: "oauth-personal" } },
    tools: { core: readOnly
      ? ["read_file", "read_many_files", "list_directory", "glob", "grep_search"]
      : ["read_file", "read_many_files", "list_directory", "glob", "grep_search", "write_file", "replace", "run_shell_command"],
      discoveryCommand: "", callCommand: "", sandbox: false },
    mcp: { allowed: [], serverCommand: "" }, mcpServers: {},
    hooksConfig: { enabled: false }, hooks: {},
    telemetry: { enabled: false }, advanced: { ignoreLocalEnv: true },
  };
}

export function googleReply(log: string, exitCode: number | null, provider: "gemini" | "antigravity"): Reply {
  // Both CLIs offer stream-json, but their terminal events have different schemas.
  let text = "";
  let result: any;
  for (const line of log.split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (provider === "gemini") {
        if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") text += ev.content;
        if (ev.type === "result") result = ev;
      } else if (ev.event === "result") { result = ev.result; text = result?.response; }
    } catch { /* stderr or partial event */ }
  }
  const success = provider === "gemini" ? result?.status === "success" : result?.status === "SUCCESS";
  return exitCode === 0 && success && !result.error && typeof text === "string" && text.trim()
    ? { ok: true, text } : { ok: false, detail: `${provider} exited ${exitCode} without a successful completed reply; see step log` };
}

export function googleEnvironment(env: Record<string, string>, home: string): Record<string, string> {
  const clean = { ...env, HOME: home, USERPROFILE: home };
  for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "GEMINI_CLI_USE_VERTEXAI", "AGY_ADC_AUTH", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_QUOTA_PROJECT", "GOOGLE_CLOUD_LOCATION", "GEMINI_API_BASE_URL"]) delete clean[key];
  return clean;
}

export async function callGemini(o: GoogleOptions, io: StepIO, prompt: string, readOnly = false): Promise<Reply> {
  let authPath: string | undefined;
  try {
    const home = join(io.sandbox.env.TMPDIR, `gemini-${process.hrtime.bigint()}`);
    const dir = join(home, ".gemini");
    mkdirSync(dir, { recursive: true });
    authPath = join(dir, "oauth_creds.json");
    writeFileSync(authPath, oauthCredentials(readFileSync(o.authFile, "utf8")), { mode: 0o600 });
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify(geminiSettings(readOnly)));
    const input = join(home, "prompt.txt");
    writeFileSync(input, prompt);
    const argv = [o.bin, "--output-format", "stream-json", "--approval-mode", readOnly ? "default" : "yolo",
      ...(o.model ? ["--model", o.model] : []), "--prompt", "Follow the request supplied on stdin."];
    const env = { ...googleEnvironment(io.sandbox.env, home), GEMINI_CLI_HOME: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: settings };
    const r = await runStep(argv, { cwd: io.worktree, logPath: io.logPath, timeoutMs: io.timeoutMs,
      wrap: io.sandbox.wrap, env, onStart: io.onStart, stdinPath: input });
    return r.timedOut ? { ok: false, detail: "gemini timed out" } : googleReply(readTail(io.logPath, 4 * 1024 * 1024), r.exitCode, "gemini");
  } catch {
    return { ok: false, detail: "Gemini CLI could not run. Configure AGENTRY_GEMINI_BIN and a Google OAuth login at AGENTRY_GEMINI_AUTH_FILE; API keys are not supported." };
  } finally {
    if (authPath) { try { unlinkSync(authPath); } catch { /* missing */ } }
  }
}

export function googleAgent(call: (io: StepIO, prompt: string, readOnly?: boolean) => Promise<Reply>): Agent {
  return { async run(io) {
    const reply = await call(io, io.prompt);
    if (!reply.ok) return { outcome: "infra_error", detail: reply.detail };
    const q = reply.text.match(/^\s*NEEDS_INFO:\s*(.+)$/m);
    return q ? { outcome: "needs_info", question: q[1].trim() } : { outcome: "finished" };
  } };
}
export function googleVerifier(call: (io: StepIO, prompt: string, readOnly?: boolean) => Promise<Reply>): Verifier {
  return { async verify(io) {
    const reply = await call(io, verifierPrompt(io), true);
    return reply.ok ? parseVerdict(reply.text) : { verdict: "infra_error", evidence: reply.detail };
  } };
}
