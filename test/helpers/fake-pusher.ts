// A runner process for the git-orphan recovery test: takes the lease with token "old", records a run with
// push_started, and pushes from a pinned worktree of a repository whose pre-push hook sleeps. Like the runner,
// it records the git process group on the run while git runs. The test SIGKILLs it mid-push.
//   bun test/helpers/fake-pusher.ts <db> <request id> <repo> <worktree>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, fenced, LEASE_TTL_MS, openDb } from "../../src/db.ts";
import { localQueue, startHeartbeat } from "../../src/queue.ts";
import * as g from "../../src/git.ts";

const [dbPath, requestId, repo, wt] = process.argv.slice(2);
const db = openDb(dbPath);
const token = "old";
if (!acquireLease(db, token, process.pid)) process.exit(3);
const now = Date.now();
await g.addWorktree(repo, wt, "agentry/1-1", "main");
writeFileSync(join(wt, "pushed.txt"), "x\n");
const sha = (await g.candidateCommit(wt, "candidate"))!;
const base = await g.remoteHead(repo, "origin", "main");
const runId = fenced(db, token, () => Number(db.query(`INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch,
  base_sha, commit_sha, current_step, push_state, started_at) VALUES (?, 1, ?, ?, 'agentry/1-1', ?, ?, 'push', 'push_started', ?)`)
  .run(requestId, token, now + LEASE_TTL_MS, base, sha, now).lastInsertRowid));
startHeartbeat(localQueue(db, token, ""), () => [runId], () => process.exit(4));
await g.observer.run({ onStart: (pgid) => fenced(db, token, () => db.query("UPDATE runs SET pgid = ? WHERE id = ?").run(pgid, runId)) },
  () => g.push(repo, wt, "origin", sha, "main"));
