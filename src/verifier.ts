// The done-when verifier (design step 6, eng review D9): a second claude call with Read/Grep only, inside the
// run's sandbox, that judges whether the diff meets the request's done-when line.
// PASS / FAIL with evidence; an unparseable reply is FAIL with the raw text; the call failing is infra_error.
import { callClaude, type ClaudeOptions } from "./adapters/claude.ts";
import type { Verdict, Verifier, VerifyInput } from "./adapters/types.ts";

// A diff larger than this is cut; the verifier can still Read the files in the worktree.
export const MAX_DIFF_CHARS = 150_000;

export function verifierPrompt(v: VerifyInput): string {
  const diff = v.diff.length > MAX_DIFF_CHARS
    ? `${v.diff.slice(0, MAX_DIFF_CHARS)}\n… (diff cut at ${MAX_DIFF_CHARS} characters; read the changed files in the working directory)`
    : v.diff;
  return [
    "You are the done-when verifier for an automated change. Another agent made the change below. Decide whether it",
    "meets the done-when condition. You can Read and Grep the working directory, which holds the changed code.",
    "",
    "Be strict. FAIL when:",
    "- any part of the done-when condition is not met, including an edge case or input it names;",
    "- the change uses the wrong field, value, route, status code or name compared with what was asked;",
    "- the condition says a test proves it, and the test does not actually assert the behavior (no assertion,",
    "  an assertion that always holds, or one that checks something else).",
    "Passing tests alone prove nothing about the condition. Judge only the condition, not style.",
    "",
    `# Request: ${v.title}`,
    "",
    v.body,
    "",
    `# Done when`,
    "",
    v.doneWhen,
    "",
    "# Test results",
    "",
    v.testSummary,
    "",
    "# Diff",
    "",
    "```diff",
    diff,
    "```",
    "",
    "End your reply with exactly these two lines:",
    "VERDICT: PASS or VERDICT: FAIL",
    "EVIDENCE: <one paragraph naming the files and lines that decide it>",
  ].join("\n");
}

export function parseVerdict(text: string): Verdict {
  const verdicts = [...text.matchAll(/^\s*\**VERDICT:?\**\s*(PASS|FAIL)\b/gim)];
  if (!verdicts.length) return { verdict: "FAIL", evidence: `unparseable verifier reply: ${text.trim() || "(empty)"}` };
  const last = verdicts[verdicts.length - 1];
  const after = text.slice(last.index! + last[0].length);
  const evidence = after.match(/EVIDENCE:?\**\s*([\s\S]+)/i)?.[1].trim() || text.trim();
  return { verdict: last[1].toUpperCase() as "PASS" | "FAIL", evidence };
}

export function claudeVerifier(o: ClaudeOptions): Verifier {
  return {
    async verify(io) {
      const reply = await callClaude(o, io, verifierPrompt(io), ["Read", "Grep"], "dontAsk");
      return reply.ok ? parseVerdict(reply.text) : { verdict: "infra_error", evidence: reply.detail };
    },
  };
}
