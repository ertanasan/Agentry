// A runner process for recovery tests: takes the lease with token "old", runs the heartbeat, records a run for
// the request and starts one step that forks a child and sleeps. The test SIGKILLs it mid-step.
//   bun test/helpers/fake-runner.ts <db> <request id> <log dir>
import { join } from "node:path";
import { acquireLease, fenced, LEASE_TTL_MS, openDb, setRequestStatus } from "../../src/db.ts";
import { localQueue, startHeartbeat } from "../../src/queue.ts";
import { runStep } from "../../src/proc.ts";

const [dbPath, requestId, logDir] = process.argv.slice(2);
const db = openDb(dbPath);
const token = "old";
if (!acquireLease(db, token, process.pid)) process.exit(3);
const now = Date.now();
const runId = fenced(db, token, () => {
  setRequestStatus(db, Number(requestId), "running");
  return Number(db.query(`INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, current_step, started_at)
    VALUES (?, 1, ?, ?, 'agentry/x-1', 'deploy', ?)`).run(requestId, token, now + LEASE_TTL_MS, now).lastInsertRowid);
});
startHeartbeat(localQueue(db, token, ""), () => [runId], () => process.exit(4));
await runStep("sleep 300 & sleep 300", {
  cwd: logDir, logPath: join(logDir, "step.log"), timeoutMs: 600_000,
  onStart: (pgid) => fenced(db, token, () => db.query("UPDATE runs SET pgid = ? WHERE id = ?").run(pgid, runId)),
});
