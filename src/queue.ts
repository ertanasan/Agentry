// The queue a runner works: every read and write the runner and recovery make. `localQueue` is this machine's
// SQLite database; remote.ts serves the same methods over HTTP, so a runner on another machine can work this
// queue (`agentry attach`) beside this machine's own. Each runner works as its holder: it claims only the requests
// routed to it (routing.ts), writes only to its own runs and requests, and recovers only its own runs. Every write
// is fenced by the holder's lease token (D17; two-runners review D1-D9).
import type { Database } from "bun:sqlite";
import type { AgentId } from "./adapters/providers.ts";
import { copyForRun, type RunFile } from "./attachments.ts";
import type { DeployChoices } from "./devices.ts";
import {
  acquireLease, fenced, HEARTBEAT_MS, LEASE_TTL_MS, LeaseLost, leaseOf, NotYours, releaseLease, renewLease, runnerRow, setRequestStatus,
  type PushState, type RequestStatus,
} from "./db.ts";
import { LOCAL, missingRecipes, routeOf } from "./routing.ts";

export type ReqRow = {
  id: number; project_id: number; title: string; body: string; done_when: string | null; done_when_test: string | null;
  attempts: number; resume_run: number | null; status: RequestStatus; status_reason: string | null;
  ai_agent?: AgentId | null; // its own agent; none takes the queue's (absent from a queue that predates it)
  deploy_only?: number;      // 1: deploy main as it is, no agent (actions.deployMain; absent from a queue that predates it)
  device?: string | null;    // the UDID of the device it installs on instead of its projects' own deploy (devices.ts)
  device_name?: string | null;
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
export type Settings = { paused: number; pause_reason: string | null; workers: number; ai_agent?: AgentId };
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
  setDevices(choices: DeployChoices): Promise<void>;  // the devices this runner can install its projects on, for the pages

  takeRedeploy(): Promise<number | null>;  // a queued Re-run deploy, now no longer queued and this runner's
  claim(): Promise<ReqRow | null>;         // the next request for this runner, now running and this runner's
  unclaim(requestId: number): Promise<void>;  // a claimed request whose run couldn't start goes back to the queue
  requeueStaleClaims(): Promise<number[]>; // at startup: requests a dead runner of this holder claimed, never started
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

const REQ_COLUMNS = "r.id, r.project_id, r.title, r.body, r.done_when, r.done_when_test, r.attempts, r.resume_run, r.status, r.status_reason, r.ai_agent, r.deploy_only, r.device, r.device_name";
const RUN_COLUMNS = `ru.id, ru.request_id, ru.current_step, ru.pgid, ru.base_sha, ru.commit_sha, ru.push_state,
  p.name AS project, p.recipe`;
const RUN_JOIN = "FROM runs ru JOIN requests r ON r.id = ru.request_id JOIN projects p ON p.id = r.project_id";
const RUN_FIELDS = new Set(["base_sha", "candidate_sha", "push_state", "commit_sha", "tests_total", "tests_skipped"]);

// `holder`: whose runner this is, 'local' or a runner key's name (remote.ts sets it from the key, never from the
// caller). `home` holds the attachments.
export function localQueue(db: Database, token: string, home: string, holder = LOCAL) {
  const w = <T>(write: () => T): T => fenced(db, token, write, holder);
  // The run must be this runner's (two-runners review D6).
  const ownRun = (runId: number) => {
    const run = db.query("SELECT holder, request_id FROM runs WHERE id = ?").get(runId) as { holder: string; request_id: number } | null;
    if (!run || run.holder !== holder) throw new NotYours(`run ${runId} is not ${holder}'s`);
    return run;
  };
  const ownRequest = (requestId: number) => {
    const req = db.query("SELECT holder FROM requests WHERE id = ?").get(requestId) as { holder: string | null } | null;
    if (!req || req.holder !== holder) throw new NotYours(`request #${requestId} is not ${holder}'s`);
  };
  // This runner may take the request: it is routed here, and this runner has a recipe for each project (D9).
  const mine = (requestId: number) => {
    const r = routeOf(db, requestId);
    return r.holder === holder && r.eligible.includes(holder) && !missingRecipes(db, holder, r.projects).length;
  };
  // Another runner is working on a request in one of its deploy groups (D2): pushes and deploys of a group are
  // serialized only within one runner (runner.ts holdGroups), so groups don't overlap across runners.
  const groupBusyElsewhere = (requestId: number) => !!db.query(`SELECT 1 FROM request_projects rp JOIN projects p ON p.id = rp.project_id
    WHERE rp.request_id = ? AND p.deploy_group_id IN (
      SELECT p2.deploy_group_id FROM requests r2 JOIN request_projects rp2 ON rp2.request_id = r2.id JOIN projects p2 ON p2.id = rp2.project_id
      WHERE r2.status = 'running' AND r2.holder IS NOT NULL AND r2.holder != ?) LIMIT 1`).get(requestId, holder);

  const q = {
    async acquire(pid: number, host: string, recipes: string[] | null = null): Promise<Holder | null> {
      if (acquireLease(db, token, pid, Date.now(), host, holder, holder === LOCAL ? null : recipes)) return null;
      const l = leaseOf(db, holder)!;
      return { pid: l.pid, host: l.host, until: l.expires_at };
    },
    async renew(runIds: number[]) { renewLease(db, token, runIds, Date.now(), holder); },
    async release() { releaseLease(db, token, holder); },
    async settings(): Promise<Settings> {
      const { paused, pause_reason, workers, ai_agent } = runnerRow(db);
      return { paused, pause_reason, workers, ai_agent };
    },
    async setDevices(choices: DeployChoices) {
      w(() => db.query("UPDATE leases SET devices = ? WHERE holder = ?").run(JSON.stringify(choices), holder));
    },

    // Taken in the same transaction that checks it, so two runners can't both take it (D5).
    async takeRedeploy(): Promise<number | null> {
      return w(() => {
        const rows = db.query(`SELECT r.id FROM requests r WHERE r.redeploy_requested = 1 AND r.status = 'blocked_post_push'
          ORDER BY r.updated_at, r.id`).all() as { id: number }[];
        const row = rows.find((r) => mine(r.id) && !groupBusyElsewhere(r.id));
        if (row) db.query("UPDATE requests SET redeploy_requested = 0, holder = ? WHERE id = ?").run(holder, row.id);
        return row?.id ?? null;
      });
    },
    // Highest priority, then oldest, among queued requests routed to this runner whose projects are all enabled,
    // deploy groups all free, and groups not in use by another runner. It is running and this runner's once
    // returned: checking and taking are one transaction (D2, D5).
    async claim(): Promise<ReqRow | null> {
      return w(() => {
        const queued = db.query(`SELECT ${REQ_COLUMNS} FROM requests r WHERE r.status = 'queued' AND NOT EXISTS (
            SELECT 1 FROM request_projects rp JOIN projects p ON p.id = rp.project_id JOIN deploy_groups dg ON dg.id = p.deploy_group_id
            WHERE rp.request_id = r.id AND (p.enabled = 0 OR dg.lock != 'free'))
          ORDER BY r.priority DESC, r.created_at, r.id`).all() as ReqRow[];
        const req = queued.find((r) => mine(r.id) && !groupBusyElsewhere(r.id));
        if (!req) return null;
        db.query("UPDATE requests SET holder = ? WHERE id = ?").run(holder, req.id);
        setRequestStatus(db, req.id, "running", null);
        return { ...req, status: "running" as RequestStatus, status_reason: null };
      });
    },
    async unclaim(requestId: number) {
      w(() => {
        ownRequest(requestId);
        if (!db.query("SELECT 1 FROM runs WHERE request_id = ? AND status = 'running'").get(requestId)) setRequestStatus(db, requestId, "queued", null);
      });
    },
    async requeueStaleClaims(): Promise<number[]> {
      return w(() => {
        const stale = (db.query(`SELECT r.id FROM requests r WHERE r.status = 'running' AND r.holder = ?
          AND NOT EXISTS (SELECT 1 FROM runs WHERE request_id = r.id AND status = 'running')`).all(holder) as { id: number }[]).map((r) => r.id);
        for (const id of stale) setRequestStatus(db, id, "queued", "its runner stopped before starting it");
        return stale;
      });
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

    // On a request this runner claimed (claim or takeRedeploy).
    async startRun(requestId: number, o: NewRun) {
      const now = Date.now();
      return w(() => {
        ownRequest(requestId);
        db.query("UPDATE requests SET attempts = ?, resume_run = NULL WHERE id = ?").run(o.attempt, requestId);
        const { status } = db.query("SELECT status FROM requests WHERE id = ?").get(requestId) as { status: RequestStatus };
        if (status !== "running") setRequestStatus(db, requestId, "running", null, now);
        return Number(db.query(`INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, base_sha,
          candidate_sha, commit_sha, push_state, started_at, holder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(requestId, o.attempt, token, now + LEASE_TTL_MS, o.branch, o.base, o.candidate, o.commit ?? null, o.pushState ?? "none", now, holder)
          .lastInsertRowid);
      });
    },
    async setRun(runId: number, fields: RunFields) {
      const keys = Object.keys(fields);
      const bad = keys.find((k) => !RUN_FIELDS.has(k));
      if (bad || !keys.length) throw new Error(`can't set run field ${bad ?? "(none)"}`);
      w(() => {
        ownRun(runId);
        db.query(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k as keyof RunFields] ?? null), runId);
      });
    },
    async setRunTests(runId: number, projectId: number, total: number, skipped: number) {
      w(() => {
        ownRun(runId);
        db.query("DELETE FROM run_tests WHERE run_id = ? AND project_id = ?").run(runId, projectId);
        db.query("INSERT INTO run_tests (run_id, project_id, total, skipped) VALUES (?, ?, ?, ?)").run(runId, projectId, total, skipped);
      });
    },
    setPgid(runId: number, pgid: number | null) {
      w(() => { ownRun(runId); db.query("UPDATE runs SET pgid = ? WHERE id = ?").run(pgid, runId); });
    },
    async beginStep(runId: number, step: string, logPath: string) {
      return w(() => {
        ownRun(runId);
        db.query("UPDATE runs SET current_step = ? WHERE id = ?").run(step, runId);
        return Number(db.query("INSERT INTO steps (run_id, step, started_at, log_path) VALUES (?, ?, ?, ?)").run(runId, step, Date.now(), logPath).lastInsertRowid);
      });
    },
    async endStep(runId: number, stepId: number, exitCode: number) {
      w(() => {
        ownRun(runId);
        db.query("UPDATE steps SET ended_at = ?, exit_code = ? WHERE id = ? AND run_id = ?").run(Date.now(), exitCode, stepId, runId);
        db.query("UPDATE runs SET pgid = NULL WHERE id = ?").run(runId);
      });
    },
    async setStatus(requestId: number, status: RequestStatus, reason: string | null) {
      w(() => { ownRequest(requestId); setRequestStatus(db, requestId, status, reason); });
    },
    // Origin has the commit: record that on earlier unknown pushes of it (slice 2 review D10).
    async markPushed(requestId: number, sha: string) {
      w(() => {
        ownRequest(requestId);
        db.query("UPDATE runs SET push_state = 'pushed' WHERE request_id = ? AND commit_sha = ? AND push_state IN ('push_unknown', 'push_started')")
          .run(requestId, sha);
      });
    },
    async finish(f: Finish) {
      const now = Date.now();
      w(() => {
        if (ownRun(f.runId).request_id !== f.requestId) throw new NotYours(`run ${f.runId} is not a run of #${f.requestId}`);
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

    // The recorded process group of every run of this holder that this process does not own (D17). Another
    // runner's process groups never reach this database (remote.ts keeps them on its machine).
    async orphans() {
      return db.query(`SELECT id, pgid FROM runs WHERE status = 'running' AND pgid IS NOT NULL AND holder = ?
        AND (lease_token IS NULL OR lease_token != ?)`).all(holder, token) as { id: number; pgid: number }[];
    },
    async unresolvedPushes() {
      return unresolvedPushes(db, holder);
    },
    async recoveryRun(runId: number) {
      return db.query(`SELECT ${RUN_COLUMNS} ${RUN_JOIN} WHERE ru.id = ?`).get(runId) as RecoveryRun | null;
    },
    // This holder's runs whose lease expired: a runner recovers only its own runs (D3), since only the machine
    // that ran them knows whether their processes are gone.
    async expiredRuns(now: number) {
      return db.query(`SELECT ${RUN_COLUMNS} ${RUN_JOIN} WHERE ru.status = 'running' AND ru.lease_expires_at < ? AND ru.holder = ?
        AND (ru.lease_token IS NULL OR ru.lease_token != ?)`).all(now, holder, token) as RecoveryRun[];
    },
    // Pushed: the request stays blocked_post_push and its group stays blocked until it is deployed. Not pushed:
    // blocked_pre_push and the group is freed (D19). The runner works on other requests meanwhile: a re-run
    // deploy may have taken this one since the caller checked.
    async resolvePush(run: RecoveryRun, sha: string | null) {
      return w(() => {
        ownRun(run.id);
        if (!unresolvedPushes(db, holder).includes(run.id)) return false;
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
        if (ownRun(run.id).request_id !== run.request_id) throw new NotYours(`run ${run.id} is not a run of #${run.request_id}`);
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
// resolver (slice 2 review D10). `holder`: only that runner's runs (two-runners review D3); every runner's when absent.
export function unresolvedPushes(db: Database, holder?: string): number[] {
  return (db.query(`SELECT ru.id ${RUN_JOIN} WHERE ru.push_state = 'push_unknown' AND ru.status != 'running'
    AND r.status = 'blocked_post_push' AND ru.id = (SELECT MAX(id) FROM runs WHERE request_id = r.id)${holder ? " AND ru.holder = ?" : ""}`)
    .all(...(holder ? [holder] : [])) as { id: number }[]).map((r) => r.id);
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
