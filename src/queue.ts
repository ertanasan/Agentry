// The queue a runner works: every read and write the runner and recovery make. `localQueue` is this machine's
// SQLite database; remote.ts serves the same methods over HTTP, so a runner on another machine can work this
// queue (`agentry attach`). Every write is fenced by the runner's lease token (D17).
import type { Database } from "bun:sqlite";
import { copyForRun, type RunFile } from "./attachments.ts";
import {
  acquireLease, fenced, HEARTBEAT_MS, LEASE_TTL_MS, LeaseLost, releaseLease, renewLease, runnerRow, setRequestStatus,
  type PushState, type RequestStatus,
} from "./db.ts";

export type ReqRow = {
  id: number; project_id: number; title: string; body: string; done_when: string | null; done_when_test: string | null;
  attempts: number; resume_run: number | null; status: RequestStatus; status_reason: string | null;
};
export type RunRow = {
  id: number; attempt: number; branch: string; base_sha: string | null; candidate_sha: string | null;
  commit_sha: string | null; push_state: PushState;
};
// A project as stored: its recipe is JSON.
export type ProjectRow = { id: number; name: string; recipe: string };
export type PartRow = ProjectRow & { deploy_group_id: number };
// A run as recovery sees it, with its request's first project.
export type RecoveryRun = {
  id: number; request_id: number; current_step: string | null; pgid: number | null; base_sha: string | null;
  commit_sha: string | null; push_state: PushState; project: string; recipe: string;
};
export type Settings = { paused: number; pause_reason: string | null; workers: number };
// Who holds the lease when this runner can't take it.
export type Holder = { pid: number | null; host: string | null; until: number };
export type NewRun = { attempt: number; branch: string; base: string | null; candidate: string | null; commit?: string; pushState?: PushState };
export type RunFields = Partial<{
  base_sha: string; candidate_sha: string; push_state: PushState; commit_sha: string; tests_total: number; tests_skipped: number;
}>;
export type Finish = {
  runId: number; requestId: number; runStatus: "passed" | "failed" | "interrupted"; flags: unknown[];
  status: RequestStatus; reason: string | null;
  requeue: { attempts: number; resumeRun: number | null } | null; // back to queued: the attempt does not count
  pause: boolean;
  free: boolean;                                                   // free the groups the request holds
  lock: { reason: string; sha: string | null; groups: number[] } | null;
};
export type Interrupt = { pushState: PushState; sha: string | null; status: RequestStatus; reason: string; post: boolean };

export interface Queue {
  acquire(pid: number, host: string): Promise<Holder | null>;  // null: taken
  renew(runIds: number[]): Promise<void>;
  release(): Promise<void>;
  settings(): Promise<Settings>;

  takeRedeploy(): Promise<number | null>;  // a queued Re-run deploy, now no longer queued
  pick(): Promise<ReqRow | null>;
  request(id: number): Promise<ReqRow | null>;
  run(id: number): Promise<RunRow | null>;
  lastCommitRun(requestId: number): Promise<RunRow | null>;
  parts(requestId: number): Promise<PartRow[]>;
  projects(): Promise<ProjectRow[]>;
  blockedGroup(groupIds: number[]): Promise<string | null>;
  baseCounts(projectId: number): Promise<{ total: number; skipped: number } | null>;
  answers(requestId: number): Promise<string[]>;
  copyAttachments(requestId: number, dir: string): Promise<RunFile[]>;

  startRun(requestId: number, o: NewRun): Promise<number>;
  setRun(runId: number, fields: RunFields): Promise<void>;
  setRunTests(runId: number, projectId: number, total: number, skipped: number): Promise<void>;
  // Synchronous: it is called as a process starts. Process groups only mean something on the runner's machine.
  setPgid(runId: number, pgid: number | null): void;
  beginStep(runId: number, step: string, logPath: string): Promise<number>;
  endStep(runId: number, stepId: number, exitCode: number): Promise<void>;
  setStatus(requestId: number, status: RequestStatus, reason: string | null): Promise<void>;
  markPushed(requestId: number, sha: string): Promise<void>;
  finish(f: Finish): Promise<void>;
  // A queue that can't read the runner's worktree stores the diff the run page shows.
  saveDiff?(runId: number, worktree: string, base: string, head: string): Promise<void>;

  orphans(): Promise<{ id: number; pgid: number }[]>;
  unresolvedPushes(): Promise<number[]>;
  recoveryRun(runId: number): Promise<RecoveryRun | null>;
  expiredRuns(now: number): Promise<RecoveryRun[]>;
  resolvePush(run: RecoveryRun, sha: string | null): Promise<boolean>;  // false: no longer unresolved
  interrupt(run: RecoveryRun, o: Interrupt, now: number): Promise<void>;
}

// A queue on another machine could not be reached; the runner retries what it can.
export class Unreachable extends Error {}

const REQ_COLUMNS = "r.id, r.project_id, r.title, r.body, r.done_when, r.done_when_test, r.attempts, r.resume_run, r.status, r.status_reason";
const RUN_COLUMNS = `ru.id, ru.request_id, ru.current_step, ru.pgid, ru.base_sha, ru.commit_sha, ru.push_state,
  p.name AS project, p.recipe`;
const RUN_JOIN = "FROM runs ru JOIN requests r ON r.id = ru.request_id JOIN projects p ON p.id = r.project_id";
const RUN_FIELDS = new Set(["base_sha", "candidate_sha", "push_state", "commit_sha", "tests_total", "tests_skipped"]);

// `only`, on the methods that choose work: the projects a remote runner has recipes for (remote.ts); every one when
// absent. `home` holds the attachments.
export function localQueue(db: Database, token: string, home: string) {
  const w = <T>(write: () => T): T => fenced(db, token, write);
  const named = (only: string[] | undefined, column: string) =>
    only ? { sql: ` AND ${column} IN (${only.map(() => "?").join(",") || "NULL"})`, args: only } : { sql: "", args: [] };

  const q = {
    async acquire(pid: number, host: string): Promise<Holder | null> {
      if (acquireLease(db, token, pid, Date.now(), host)) return null;
      const r = runnerRow(db);
      return { pid: r.owner_pid, host: r.owner_host, until: r.lease_expires_at };
    },
    async renew(runIds: number[]) { renewLease(db, token, runIds); },
    async release() { releaseLease(db, token); },
    async settings(): Promise<Settings> {
      const { paused, pause_reason, workers } = runnerRow(db);
      return { paused, pause_reason, workers };
    },

    // The request's projects must all be in `only`.
    async takeRedeploy(only?: string[]): Promise<number | null> {
      const f = named(only, "p.name");
      return w(() => {
        const row = db.query(`SELECT r.id FROM requests r WHERE r.redeploy_requested = 1 AND r.status = 'blocked_post_push' AND NOT EXISTS (
            SELECT 1 FROM request_projects rp JOIN projects p ON p.id = rp.project_id WHERE rp.request_id = r.id AND NOT (1${f.sql}))
          ORDER BY r.updated_at, r.id LIMIT 1`).get(...f.args) as { id: number } | null;
        if (row) db.query("UPDATE requests SET redeploy_requested = 0 WHERE id = ?").run(row.id);
        return row?.id ?? null;
      });
    },
    // Highest priority, then oldest, among queued requests whose projects are all enabled (and in `only`) and
    // deploy groups all free.
    async pick(only?: string[]): Promise<ReqRow | null> {
      const f = named(only, "p.name");
      return db.query(`SELECT ${REQ_COLUMNS} FROM requests r WHERE r.status = 'queued' AND NOT EXISTS (
          SELECT 1 FROM request_projects rp JOIN projects p ON p.id = rp.project_id JOIN deploy_groups dg ON dg.id = p.deploy_group_id
          WHERE rp.request_id = r.id AND (p.enabled = 0 OR dg.lock != 'free' OR NOT (1${f.sql})))
        ORDER BY r.priority DESC, r.created_at, r.id LIMIT 1`).get(...f.args) as ReqRow | null;
    },
    async request(id: number) {
      return db.query(`SELECT ${REQ_COLUMNS} FROM requests r WHERE r.id = ?`).get(id) as ReqRow | null;
    },
    async run(id: number) {
      return db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;
    },
    async lastCommitRun(requestId: number) {
      return db.query("SELECT * FROM runs WHERE request_id = ? AND commit_sha IS NOT NULL ORDER BY id DESC LIMIT 1").get(requestId) as RunRow | null;
    },
    async parts(requestId: number) {
      return db.query(`SELECT p.id, p.name, p.recipe, p.deploy_group_id FROM request_projects rp JOIN projects p ON p.id = rp.project_id
        WHERE rp.request_id = ? ORDER BY p.id`).all(requestId) as PartRow[];
    },
    async projects() {
      return db.query("SELECT id, name, recipe FROM projects").all() as ProjectRow[];
    },
    // One of the groups that is blocked, by name and holder.
    async blockedGroup(ids: number[]) {
      const row = db.query(`SELECT name, locked_by_request FROM deploy_groups WHERE lock != 'free' AND id IN (${ids.map(() => "?").join(",")})
        ORDER BY id LIMIT 1`).get(...ids) as { name: string; locked_by_request: number | null } | null;
      return row ? `${row.name}${row.locked_by_request ? ` (by #${row.locked_by_request})` : ""}` : null;
    },
    // Test counts of the project's last passing run, the baseline for deleted or skipped tests.
    async baseCounts(projectId: number) {
      return db.query(`SELECT t.total, t.skipped FROM run_tests t JOIN runs ru ON ru.id = t.run_id
        WHERE t.project_id = ? AND ru.status = 'passed' ORDER BY ru.id DESC LIMIT 1`)
        .get(projectId) as { total: number; skipped: number } | null;
    },
    async answers(requestId: number) {
      return (db.query("SELECT payload FROM events WHERE request_id = ? AND type = 'answer' ORDER BY id").all(requestId) as { payload: string }[])
        .map((r) => (JSON.parse(r.payload) as { text: string }).text);
    },
    async copyAttachments(requestId: number, dir: string) {
      return copyForRun(db, home, requestId, dir);
    },

    async startRun(requestId: number, o: NewRun) {
      const now = Date.now();
      return w(() => {
        db.query("UPDATE requests SET attempts = ?, resume_run = NULL WHERE id = ?").run(o.attempt, requestId);
        setRequestStatus(db, requestId, "running", null, now);
        return Number(db.query(`INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, base_sha,
          candidate_sha, commit_sha, push_state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(requestId, o.attempt, token, now + LEASE_TTL_MS, o.branch, o.base, o.candidate, o.commit ?? null, o.pushState ?? "none", now)
          .lastInsertRowid);
      });
    },
    async setRun(runId: number, fields: RunFields) {
      const keys = Object.keys(fields);
      const bad = keys.find((k) => !RUN_FIELDS.has(k));
      if (bad || !keys.length) throw new Error(`can't set run field ${bad ?? "(none)"}`);
      w(() => db.query(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .run(...keys.map((k) => fields[k as keyof RunFields] ?? null), runId));
    },
    async setRunTests(runId: number, projectId: number, total: number, skipped: number) {
      w(() => {
        db.query("DELETE FROM run_tests WHERE run_id = ? AND project_id = ?").run(runId, projectId);
        db.query("INSERT INTO run_tests (run_id, project_id, total, skipped) VALUES (?, ?, ?, ?)").run(runId, projectId, total, skipped);
      });
    },
    setPgid(runId: number, pgid: number | null) {
      w(() => db.query("UPDATE runs SET pgid = ? WHERE id = ?").run(pgid, runId));
    },
    async beginStep(runId: number, step: string, logPath: string) {
      return w(() => {
        db.query("UPDATE runs SET current_step = ? WHERE id = ?").run(step, runId);
        return Number(db.query("INSERT INTO steps (run_id, step, started_at, log_path) VALUES (?, ?, ?, ?)").run(runId, step, Date.now(), logPath).lastInsertRowid);
      });
    },
    async endStep(runId: number, stepId: number, exitCode: number) {
      w(() => {
        db.query("UPDATE steps SET ended_at = ?, exit_code = ? WHERE id = ?").run(Date.now(), exitCode, stepId);
        db.query("UPDATE runs SET pgid = NULL WHERE id = ?").run(runId);
      });
    },
    async setStatus(requestId: number, status: RequestStatus, reason: string | null) {
      w(() => setRequestStatus(db, requestId, status, reason));
    },
    // Origin has the commit: record that on earlier unknown pushes of it (slice 2 review D10).
    async markPushed(requestId: number, sha: string) {
      w(() => db.query("UPDATE runs SET push_state = 'pushed' WHERE request_id = ? AND commit_sha = ? AND push_state IN ('push_unknown', 'push_started')")
        .run(requestId, sha));
    },
    async finish(f: Finish) {
      const now = Date.now();
      w(() => {
        db.query("UPDATE runs SET status = ?, current_step = NULL, pgid = NULL, flags = ?, ended_at = ? WHERE id = ?")
          .run(f.runStatus, JSON.stringify(f.flags), now, f.runId);
        if (f.requeue) db.query("UPDATE requests SET attempts = ?, resume_run = ? WHERE id = ?").run(f.requeue.attempts, f.requeue.resumeRun, f.requestId);
        setRequestStatus(db, f.requestId, f.status, f.reason, now);
        if (f.pause) db.query("UPDATE runner SET paused = 1, pause_reason = ? WHERE id = 1").run(f.reason);
        if (f.free) {
          db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, locked_by_request = NULL, undeployed_sha = NULL WHERE locked_by_request = ?")
            .run(f.requestId);
        }
        for (const group of f.lock?.groups ?? []) {
          db.query("UPDATE deploy_groups SET lock = 'blocked', lock_reason = ?, locked_by_request = ?, undeployed_sha = ? WHERE id = ?")
            .run(f.lock!.reason, f.lock!.sha ? f.requestId : null, f.lock!.sha, group);
        }
      });
    },

    // The recorded process group of every run this runner does not own (D17).
    async orphans() {
      return db.query(`SELECT id, pgid FROM runs WHERE status = 'running' AND pgid IS NOT NULL
        AND (lease_token IS NULL OR lease_token != ?)`).all(token) as { id: number; pgid: number }[];
    },
    async unresolvedPushes(only?: string[]) {
      return unresolvedPushes(db, only);
    },
    async recoveryRun(runId: number) {
      return db.query(`SELECT ${RUN_COLUMNS} ${RUN_JOIN} WHERE ru.id = ?`).get(runId) as RecoveryRun | null;
    },
    // Runs whose lease expired. `remote`: skip runs with a recorded process group, which only a runner on the
    // machine that ran them can kill; that runner recovers them.
    async expiredRuns(now: number, only?: string[], remote = false) {
      const f = named(only, "p.name");
      return db.query(`SELECT ${RUN_COLUMNS} ${RUN_JOIN} WHERE ru.status = 'running' AND ru.lease_expires_at < ?
        AND (ru.lease_token IS NULL OR ru.lease_token != ?)${remote ? " AND ru.pgid IS NULL" : ""}${f.sql}`).all(now, token, ...f.args) as RecoveryRun[];
    },
    // Pushed: the request stays blocked_post_push and its group stays blocked until it is deployed. Not pushed:
    // blocked_pre_push and the group is freed (D19). The runner works on other requests meanwhile: a re-run
    // deploy may have taken this one since the caller checked.
    async resolvePush(run: RecoveryRun, sha: string | null) {
      return w(() => {
        if (!unresolvedPushes(db).includes(run.id)) return false;
        if (sha) {
          db.query("UPDATE runs SET push_state = 'pushed', commit_sha = ? WHERE id = ?").run(sha, run.id);
          setRequestStatus(db, run.request_id, "blocked_post_push", `${sha.slice(0, 7)} is on origin; deploy not run`);
          lockGroups(db, run.request_id, `${sha.slice(0, 7)} pushed, not deployed`, sha);
        } else {
          db.query("UPDATE runs SET push_state = 'not_pushed' WHERE id = ?").run(run.id);
          setRequestStatus(db, run.request_id, "blocked_pre_push", "push did not reach origin");
          db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, locked_by_request = NULL, undeployed_sha = NULL WHERE locked_by_request = ?")
            .run(run.request_id);
        }
        return true;
      });
    },
    async interrupt(run: RecoveryRun, o: Interrupt, now: number) {
      w(() => {
        db.query("UPDATE runs SET status = 'interrupted', current_step = NULL, pgid = NULL, push_state = ?, commit_sha = ?, ended_at = ? WHERE id = ?")
          .run(o.pushState, o.sha || run.commit_sha, now, run.id);
        setRequestStatus(db, run.request_id, o.status, o.reason, now);
        if (o.post) lockGroups(db, run.request_id, o.reason, o.sha || run.commit_sha);
      });
    },
  };
  return q satisfies Queue;
}

export type LocalQueue = ReturnType<typeof localQueue>;

// Runs whose push outcome is still open: push_unknown, finished, the latest run of a request that is still
// blocked_post_push. A request that was since redeployed, resolved or retried is never reopened by the
// resolver (slice 2 review D10).
export function unresolvedPushes(db: Database, only?: string[]): number[] {
  const f = only ? ` AND p.name IN (${only.map(() => "?").join(",") || "NULL"})` : "";
  return (db.query(`SELECT ru.id ${RUN_JOIN} WHERE ru.push_state = 'push_unknown' AND ru.status != 'running'
    AND r.status = 'blocked_post_push' AND ru.id = (SELECT MAX(id) FROM runs WHERE request_id = r.id)${f}`).all(...(only ?? [])) as { id: number }[])
    .map((r) => r.id);
}

// Which of the request's projects were deployed is not known, so all their groups are blocked; a re-run
// deploy skips the ones already live.
function lockGroups(db: Database, requestId: number, reason: string, sha: string | null): void {
  db.query(`UPDATE deploy_groups SET lock = 'blocked', lock_reason = ?, locked_by_request = ?, undeployed_sha = ? WHERE id IN (
    SELECT p.deploy_group_id FROM request_projects rp JOIN projects p ON p.id = rp.project_id WHERE rp.request_id = ?)`)
    .run(reason, requestId, sha, requestId);
}

// Starts a heartbeat that keeps the leases alive for as long as the runner process is alive (D7).
// `onLost` fires once if a renewal finds that another runner has taken over. A remote queue that can't be
// reached is tried again on the next beat: the lease outlasts three missed ones.
export function startHeartbeat(q: Queue, currentRuns: () => number[], onLost: () => void): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await q.renew(currentRuns()); }
    catch (e) {
      if (e instanceof LeaseLost) { clearInterval(timer); onLost(); }
      else if (e instanceof Unreachable) console.error(`heartbeat: ${e.message}`);
      else throw e;
    } finally { busy = false; }
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}
