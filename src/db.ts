// SQLite store: schema, the runner lease (one worker at a time) and fenced writes.
// A runner owns the lease through a random token. Every state change it makes goes through `fenced`, which
// refuses the write if another runner has taken the lease since (eng review D7, D17).
import { Database } from "bun:sqlite";

export const LEASE_TTL_MS = 60_000;
export const HEARTBEAT_MS = 15_000;

export type RequestStatus =
  | "queued" | "running" | "done" | "done_manual" | "canceled"
  | "blocked_pre_push" | "blocked_post_push" | "needs_review" | "needs_info";

export type PushState = "none" | "push_started" | "pushed" | "push_unknown" | "not_pushed";

export class LeaseLost extends Error {
  constructor() { super("runner lease lost: another runner owns it"); }
}

// The slice 1 schema, frozen: every later change is a numbered migration below, so existing databases upgrade.
export const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS runner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_token TEXT, owner_pid INTEGER, lease_expires_at INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT
);
INSERT OR IGNORE INTO runner (id) VALUES (1);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
  remote TEXT NOT NULL DEFAULT 'origin', default_branch TEXT NOT NULL DEFAULT 'main'
);
CREATE TABLE IF NOT EXISTS deploy_groups (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  lock TEXT NOT NULL DEFAULT 'free' CHECK (lock IN ('free','blocked')),
  lock_reason TEXT, locked_by_request INTEGER, undeployed_sha TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  deploy_group_id INTEGER NOT NULL REFERENCES deploy_groups(id),
  recipe TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  done_when TEXT, done_when_test TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued', status_reason TEXT,
  agent TEXT NOT NULL DEFAULT 'claude',
  attempts INTEGER NOT NULL DEFAULT 0,
  reopened_from INTEGER REFERENCES requests(id),
  resume_run INTEGER REFERENCES runs(id), -- set by approve: the next run resumes this run's branch at build
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed','interrupted')),
  current_step TEXT, lease_token TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
  pgid INTEGER, branch TEXT, base_sha TEXT, candidate_sha TEXT, commit_sha TEXT,
  push_state TEXT NOT NULL DEFAULT 'none', flags TEXT NOT NULL DEFAULT '[]',
  tests_total INTEGER, tests_skipped INTEGER,
  started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), step TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, log_path TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, request_id INTEGER, type TEXT NOT NULL, payload TEXT
);
`;

// Schema changes after slice 1, in order. Migration i brings PRAGMA user_version from i to i + 1, in one
// transaction with the version bump (review D11). Never edit or reorder an entry; append.
export const MIGRATIONS: string[] = [
  // 1: Re-run deploy is queued for the runner instead of taking the lease (slice 2 review D7).
  "ALTER TABLE requests ADD COLUMN redeploy_requested INTEGER NOT NULL DEFAULT 0",
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(BASE_SCHEMA);
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const at = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (at > MIGRATIONS.length) throw new Error(`database schema version ${at} is newer than this Agentry (${MIGRATIONS.length})`);
  for (let v = at; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }).immediate();
  }
}

type RunnerRow = { owner_token: string | null; owner_pid: number | null; lease_expires_at: number; paused: number; pause_reason: string | null };

export function runnerRow(db: Database): RunnerRow {
  return db.query("SELECT owner_token, owner_pid, lease_expires_at, paused, pause_reason FROM runner WHERE id = 1").get() as RunnerRow;
}

// Takes the runner lease if it is free or expired. Returns false while another runner's lease is live.
export function acquireLease(db: Database, token: string, pid: number, now = Date.now()): boolean {
  const res = db.query(
    "UPDATE runner SET owner_token = ?, owner_pid = ?, lease_expires_at = ? WHERE id = 1 AND (owner_token IS NULL OR lease_expires_at < ? OR owner_token = ?)",
  ).run(token, pid, now + LEASE_TTL_MS, now, token);
  return res.changes === 1;
}

// Extends the runner lease and the lease of the run it is working on. Throws LeaseLost if it no longer owns it.
export function renewLease(db: Database, token: string, runId: number | null, now = Date.now()): void {
  fenced(db, token, () => {
    db.query("UPDATE runner SET lease_expires_at = ? WHERE id = 1").run(now + LEASE_TTL_MS);
    if (runId !== null) db.query("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run(now + LEASE_TTL_MS, runId);
  });
}

export function releaseLease(db: Database, token: string): void {
  db.query("UPDATE runner SET owner_token = NULL, owner_pid = NULL, lease_expires_at = 0 WHERE id = 1 AND owner_token = ?").run(token);
}

// Runs `write` in one transaction, only if `token` still owns the runner lease.
export function fenced<T>(db: Database, token: string, write: () => T): T {
  return db.transaction(() => {
    if (runnerRow(db).owner_token !== token) throw new LeaseLost();
    return write();
  })();
}

export function logEvent(db: Database, requestId: number | null, type: string, payload: unknown = null, now = Date.now()): void {
  db.query("INSERT INTO events (ts, request_id, type, payload) VALUES (?, ?, ?, ?)")
    .run(now, requestId, type, payload === null ? null : JSON.stringify(payload));
}

export function setRequestStatus(db: Database, id: number, status: RequestStatus, reason: string | null = null, now = Date.now()): void {
  db.query("UPDATE requests SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?").run(status, reason, now, id);
  logEvent(db, id, "status", { status, reason }, now);
}

// Starts a heartbeat that keeps the leases alive for as long as the runner process is alive (D7).
// `onLost` fires once if a renewal finds that another runner has taken over.
export function startHeartbeat(db: Database, token: string, currentRun: () => number | null, onLost: () => void): () => void {
  const timer = setInterval(() => {
    try { renewLease(db, token, currentRun()); }
    catch (e) {
      if (e instanceof LeaseLost) { clearInterval(timer); onLost(); }
      else throw e;
    }
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}
