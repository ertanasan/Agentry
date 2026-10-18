// Contracts between the runner and the agent and verifier adapters (design §Agent adapters, eng review D9).
// The runner decides changed vs no changes itself, from the candidate commit.
import type { sandbox } from "../sandbox.ts";

export type Sandbox = ReturnType<typeof sandbox>;

export type StepIO = {
  worktree: string;
  logPath: string;
  timeoutMs: number;
  sandbox: Sandbox;                  // pass `wrap` and `env` to runStep
  onStart: (pgid: number) => void;   // pass to runStep, so the process group is recorded (D17)
};

export type AgentResult =
  | { outcome: "finished" }
  | { outcome: "needs_info"; question: string }
  | { outcome: "infra_error"; detail: string }; // usage limit, auth, network, crash: requeue and pause

export type Agent = { run(io: StepIO & { prompt: string }): Promise<AgentResult> };

export type VerifyInput = { title: string; body: string; doneWhen: string; diff: string; testSummary: string };

// An unparseable verdict is FAIL with the raw output as evidence, never infra_error.
export type Verdict = { verdict: "PASS" | "FAIL" | "infra_error"; evidence: string };

export type Verifier = { verify(io: StepIO & VerifyInput): Promise<Verdict> };
