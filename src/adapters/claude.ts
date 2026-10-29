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
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readTail, runStep } from "../proc.ts";
import { AGENTRY_HOME, KEY_HELPER } from "../sandbox.ts";
import type { Agent, StepIO } from "./types.ts";

// account: with more than one subscription account, the one this run uses and the first account's token file.
export type ClaudeAuth = { kind: "api_key"; keyHelper: string } | { kind: "subscription"; token: string; account?: { name: string; tokenFile: string } };

export type ClaudeOptions = { bin: string; model?: string; auth?: ClaudeAuth }; // default: api_key with KEY_HELPER

// Each Claude account is the output of `claude setup-token`, saved by `agentry token claude <name>` as
// claude-oauth-token-<name> (chmod 600). This is the path the account files are named after.
export const OAUTH_TOKEN_FILE = join(AGENTRY_HOME, "claude-oauth-token");
export const ACCOUNT_NAME = /^[A-Za-z0-9._-]{1,32}$/;

// Each limited account's reset time (ms), beside the token files.
const limitsFile = (tokenFile: string) => join(dirname(tokenFile), "claude-limits.json");
// Without a reset time from Claude, a limited account is tried again after this.
const LIMIT_FALLBACK_MS = 60 * 60_000;

// The Claude accounts, in the order runs use them: by name. A token file without a name, saved before accounts had
// names, becomes the account "default" here (its usage limit was already kept under that name).
export function claudeAccounts(tokenFile = OAUTH_TOKEN_FILE): { name: string; file: string }[] {
  const dir = dirname(tokenFile), base = basename(tokenFile);
  if (existsSync(tokenFile) && !existsSync(`${tokenFile}-default`)) {
    try { renameSync(tokenFile, `${tokenFile}-default`); } catch { /* read it as "default" where it is */ }
  }
  const named = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${base}-`) && ACCOUNT_NAME.test(f.slice(base.length + 1))) : [];
  const all = named.map((f) => ({ name: f.slice(base.length + 1), file: join(dir, f) }));
  if (existsSync(tokenFile) && !all.some((a) => a.name === "default")) all.push({ name: "default", file: tokenFile });
  return all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Removes a Claude account and its usage limit. Returns how many accounts are left.
export function removeClaudeAccount(name: string, tokenFile = OAUTH_TOKEN_FILE): number {
  const account = claudeAccounts(tokenFile).find((a) => a.name === name);
  if (!account) throw new Error(`no Claude account named ${name}`);
  rmSync(account.file, { force: true });
  const limits = readLimits(tokenFile);
  if (name in limits) { delete limits[name]; writeFileSync(limitsFile(tokenFile), JSON.stringify(limits) + "\n"); }
  return claudeAccounts(tokenFile).length;
}

// Each account's usage-limit reset (ms), for those that hit one.
export function readLimits(tokenFile = OAUTH_TOKEN_FILE): Record<string, number> {
  try { return JSON.parse(readFileSync(limitsFile(tokenFile), "utf8")); } catch { return {}; }
}

// The subscription token when a Claude account exists, else the API key helper.
// Several accounts: the first not at its usage limit (failover); all of them limited, the one that resets first,
// whose run is refused and pauses the runner. Whitespace is dropped anywhere in a token: `claude setup-token`
// wraps it over two lines, and a copied line break would cut it.
export function resolveAuth(tokenFile = OAUTH_TOKEN_FILE, keyHelper = KEY_HELPER, now = Date.now()): ClaudeAuth {
  const all = claudeAccounts(tokenFile);
  if (!all.length) return { kind: "api_key", keyHelper };
  const limits = readLimits(tokenFile);
  const pick = all.find((a) => !(limits[a.name] > now)) ?? all.reduce((a, b) => (limits[b.name] < limits[a.name] ? b : a));
  const token = readFileSync(pick.file, "utf8").replace(/\s+/g, "");
  if (!token) throw new Error(`${pick.file} is empty`);
  return all.length === 1 ? { kind: "subscription", token } : { kind: "subscription", token, account: { name: pick.name, tokenFile } };
}

// A usage limit on one of several accounts: skip it until its reset. True when another account is free now.
function markLimited(account: { name: string; tokenFile: string }, resetsAt: number | undefined, now = Date.now()): boolean {
  const limits = readLimits(account.tokenFile);
  limits[account.name] = resetsAt ? resetsAt * 1000 : now + LIMIT_FALLBACK_MS;
  writeFileSync(limitsFile(account.tokenFile), JSON.stringify(limits) + "\n");
  return claudeAccounts(account.tokenFile).some((a) => !(limits[a.name] > now));
}

// retry: the account hit its usage limit and another is free, so the run goes back on the queue without a pause.
export type Reply = { ok: true; text: string } | { ok: false; detail: string; retry?: boolean };

type ResultEvent = { type: "result"; is_error?: boolean; subtype?: string; result?: string };
// stream-json reports each rate limit check; "rejected" is a usage limit, resetsAt in epoch seconds.
type RateLimitEvent = { type: "rate_limit_event"; rate_limit_info?: { status?: string; resetsAt?: number | null } };
const USAGE_LIMIT = /usage limit|hit your (?:\S+ )?limit/i;

const AGENT_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

// The final `result` event is the last line of the stream-json log; this much of the tail always holds it.
const RESULT_TAIL_BYTES = 4 * 1024 * 1024;

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
  const r = await runStep(argv, {
    cwd: io.worktree, logPath: io.logPath, timeoutMs: io.timeoutMs, wrap: io.sandbox.wrap, env, onStart: io.onStart, stdinPath: promptFile,
  });
  if (r.timedOut) return { ok: false, detail: `claude timed out after ${Math.round(io.timeoutMs / 1000)} s` };
  const { result, rejected } = scan(readTail(io.logPath, RESULT_TAIL_BYTES));
  if (!result) return failed(auth, `claude exited ${r.exitCode} without a result`, rejected);
  if (result.is_error) return failed(auth, result.result || result.subtype || "error", rejected);
  return { ok: true, text: result.result ?? "" };
}

function failed(auth: ClaudeAuth, detail: string, rejected: RateLimitEvent | null): Reply {
  if (auth.kind !== "subscription" || !auth.account || !(rejected || USAGE_LIMIT.test(detail))) return { ok: false, detail };
  const resetsAt = rejected?.rate_limit_info?.resetsAt ?? undefined;
  const retry = markLimited(auth.account, resetsAt);
  const until = new Date(resetsAt ? resetsAt * 1000 : Date.now() + LIMIT_FALLBACK_MS).toLocaleString();
  return { ok: false, detail: `${detail} (Claude account ${auth.account.name}, skipped until ${until}${retry ? "" : "; no other account is free"})`, retry };
}

// The final `result` event, and the last rate limit check that refused the call.
function scan(log: string): { result: ResultEvent | null; rejected: RateLimitEvent | null } {
  let result: ResultEvent | null = null, rejected: RateLimitEvent | null = null;
  for (const line of log.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === "result") result = ev;
      else if (ev?.type === "rate_limit_event" && ev.rate_limit_info?.status === "rejected") rejected = ev;
    } catch { /* stderr or a partial line */ }
  }
  return { result, rejected };
}

export function claudeAgent(o: ClaudeOptions): Agent {
  return {
    async run(io) {
      const reply = await callClaude(o, io, io.prompt, AGENT_TOOLS, "bypassPermissions");
      if (!reply.ok) return { outcome: "infra_error", detail: reply.detail, ...(reply.retry && { retry: true }) };
      const q = reply.text.match(/^\s*NEEDS_INFO:\s*(.+)$/m);
      return q ? { outcome: "needs_info", question: q[1].trim() } : { outcome: "finished" };
    },
  };
}
