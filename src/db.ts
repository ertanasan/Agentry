// SQLite store: schema, the runner leases and fenced writes.
// Each runner of the queue holds its own lease, by holder name: 'local' for this machine's runner, a runner key's
// name for one on another machine (remote.ts). A runner owns its lease through a random token. Every state change
// it makes goes through `fenced`, which refuses the write if another process has taken that holder's lease since
// (eng review D7, D17; two-runners review D1).
import { Database } from "bun:sqlite";
import { hostname } from "node:os";
import type { AgentId } from "./adapters/providers.ts";

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
  // 2: accounts for the web UI: passkeys, sessions, one-time registration links, login challenges; the acting
  // user on audit events (winhost design "Accounts and login").
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
     webauthn_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE credentials (
     id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), public_key BLOB NOT NULL,
     counter INTEGER NOT NULL, transports TEXT, device TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), device TEXT,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE registrations (
     code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL,
     used_at INTEGER, challenge TEXT);
   CREATE TABLE challenges (id_hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
   ALTER TABLE events ADD COLUMN actor TEXT;`,
  // 3: images attached to a request (attachments.ts); the files live under $AGENTRY_HOME/attachments.
  `CREATE TABLE attachments (
     id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), name TEXT NOT NULL,
     mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE INDEX attachments_request ON attachments(request_id);`,
  // 4: a request may span several projects of one repo. requests.project_id stays the first one, and the trigger
  // puts it in request_projects on every insert. Test counts move to one row per project, so each project's
  // baseline is its own even when one test command served several.
  `CREATE TABLE request_projects (
     request_id INTEGER NOT NULL REFERENCES requests(id), project_id INTEGER NOT NULL REFERENCES projects(id),
     PRIMARY KEY (request_id, project_id));
   INSERT INTO request_projects (request_id, project_id) SELECT id, project_id FROM requests;
   CREATE TRIGGER request_first_project AFTER INSERT ON requests BEGIN
     INSERT OR IGNORE INTO request_projects (request_id, project_id) VALUES (NEW.id, NEW.project_id);
   END;
   CREATE TABLE run_tests (
     run_id INTEGER NOT NULL REFERENCES runs(id), project_id INTEGER NOT NULL REFERENCES projects(id),
     total INTEGER NOT NULL, skipped INTEGER NOT NULL);
   INSERT INTO run_tests (run_id, project_id, total, skipped)
     SELECT ru.id, r.project_id, ru.tests_total, ru.tests_skipped FROM runs ru JOIN requests r ON r.id = ru.request_id
     WHERE ru.tests_total IS NOT NULL;`,
  // 5: how many requests the runner works on at once, set on the settings page.
  "ALTER TABLE runner ADD COLUMN workers INTEGER NOT NULL DEFAULT 1",
  // 6: when a session's passkey was last checked (sign-in, registration, or a step-up before a settings change).
  "ALTER TABLE sessions ADD COLUMN verified_at INTEGER",
  // 7: the machine of the runner that holds the lease, and the keys of runners on other machines that work this
  // queue over HTTP (remote.ts).
  `ALTER TABLE runner ADD COLUMN owner_host TEXT;
   CREATE TABLE runner_keys (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);`,
  // 8: several runners on one queue (two-runners review). A lease per holder replaces the runner row's lease
  // columns, which stay unused; `recipes` is what an attached runner said it has (D9). Runs and claimed requests
  // record their holder; a project lists the holders that may run it, home first (NULL: 'local' only).
  `CREATE TABLE leases (holder TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER, host TEXT, expires_at INTEGER NOT NULL, recipes TEXT);
   ALTER TABLE runs ADD COLUMN holder TEXT NOT NULL DEFAULT 'local';
   ALTER TABLE requests ADD COLUMN holder TEXT;
   UPDATE requests SET holder = 'local' WHERE status = 'running';
   ALTER TABLE projects ADD COLUMN runners TEXT;`,
  // 9: the selectable coding agent; existing queues continue with Claude Code.
  "ALTER TABLE runner ADD COLUMN ai_agent TEXT NOT NULL DEFAULT 'claude' CHECK (ai_agent IN ('claude', 'codex'))",
  // 10: expand the provider constraint without changing migration 9 or resetting the saved selection.
  `ALTER TABLE runner ADD COLUMN ai_agent_next TEXT NOT NULL DEFAULT 'claude'
     CHECK (ai_agent_next IN ('claude', 'codex', 'gemini', 'antigravity'));
   UPDATE runner SET ai_agent_next = ai_agent;
   ALTER TABLE runner DROP COLUMN ai_agent;
   ALTER TABLE runner RENAME COLUMN ai_agent_next TO ai_agent;`,
  // 11: a request's own coding agent; NULL takes the queue's (runner.ai_agent) when its run starts.
  "ALTER TABLE requests ADD COLUMN ai_agent TEXT CHECK (ai_agent IN ('claude', 'codex', 'gemini', 'antigravity'))",
  // 12: a request that deploys its project's main as it is, without a change (actions.deployMain).
  "ALTER TABLE requests ADD COLUMN deploy_only INTEGER NOT NULL DEFAULT 0",
  // 13: the devices a runner can install its projects on (devices.ts DeployChoices, JSON), and the one a request
  // installs on instead of its projects' own deploy: its UDID, and its name and model as filed.
  `ALTER TABLE leases ADD COLUMN devices TEXT;
   ALTER TABLE requests ADD COLUMN device TEXT;
   ALTER TABLE requests ADD COLUMN device_name TEXT;`,
  // 14: a request picks any of its projects' deploy entries (devices.ts Picks, JSON; NULL: each project's defaults),
  // its targets as well as its devices; a request that picked a device keeps it, instead of its project's own deploy.
  // A runner reports every project's entries, in the new shape, from its next report.
  `ALTER TABLE requests ADD COLUMN deploy_to TEXT;
   UPDATE requests SET deploy_to = json_object((SELECT name FROM projects WHERE id = requests.project_id),
     json_array(json_object('id', 'device:' || device, 'name', device_name))) WHERE device IS NOT NULL;
   ALTER TABLE requests DROP COLUMN device;
   ALTER TABLE requests DROP COLUMN device_name;
   ALTER TABLE leases RENAME COLUMN devices TO deploy_choices;
   UPDATE leases SET deploy_choices = NULL;`,
  // 15: the Recipes tab (recipes.ts). The file a project's recipe lives in; the recipes an attached runner reports
  // (JSON, by project: RecipeText); and edits of them that wait for that runner to apply them.
  `ALTER TABLE projects ADD COLUMN recipe_file TEXT;
   ALTER TABLE leases ADD COLUMN recipes_report TEXT;
   CREATE TABLE recipe_edits (id INTEGER PRIMARY KEY, holder TEXT NOT NULL, project TEXT NOT NULL, recipe TEXT NOT NULL,
     by_user TEXT NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER, error TEXT);`,
  // 16: each user's theme for the web UI (views.ts THEMES); NULL is the default.
  `ALTER TABLE users ADD COLUMN theme TEXT;`,
  // 17: GitHub Copilot CLI as an AI agent. A CHECK can't change in place, so each agent column is made again.
  `ALTER TABLE runner ADD COLUMN ai_agent_next TEXT NOT NULL DEFAULT 'claude'
     CHECK (ai_agent_next IN ('claude', 'codex', 'gemini', 'antigravity', 'copilot'));
   UPDATE runner SET ai_agent_next = ai_agent;
   ALTER TABLE runner DROP COLUMN ai_agent;
   ALTER TABLE runner RENAME COLUMN ai_agent_next TO ai_agent;
   ALTER TABLE requests ADD COLUMN ai_agent_next TEXT CHECK (ai_agent_next IN ('claude', 'codex', 'gemini', 'antigravity', 'copilot'));
   UPDATE requests SET ai_agent_next = ai_agent;
   ALTER TABLE requests DROP COLUMN ai_agent;
   ALTER TABLE requests RENAME COLUMN ai_agent_next TO ai_agent;`,
];

// Checks run before a migration; a message refuses it and leaves the database as it was.
const MIGRATION_GUARDS: Record<number, (db: Database) => string | null> = {
  // Before 8, runs don't say whose they are, and the migration makes them this machine's. That is wrong only for
  // the work of a runner on another machine that holds the lease now (two-runners review O6).
  7: (db) => {
    const r = db.query("SELECT owner_token, owner_host, lease_expires_at FROM runner WHERE id = 1").get() as
      { owner_token: string | null; owner_host: string | null; lease_expires_at: number };
    if (!r.owner_token || !r.owner_host || r.owner_host === hostname() || r.lease_expires_at < Date.now()) return null;
    const busy = db.query(`SELECT COUNT(*) AS n FROM runs ru WHERE ru.lease_token = ? AND (ru.status = 'running'
      OR ru.id IN (SELECT resume_run FROM requests WHERE resume_run IS NOT NULL AND status NOT IN ('done', 'done_manual', 'canceled')))`)
      .get(r.owner_token) as { n: number };
    return busy.n ? `the runner on ${r.owner_host} is working this queue (${busy.n} run(s) in progress or waiting to resume): ` +
      "let them finish, or detach that runner and wait a minute, then start this Agentry again" : null;
  },
};

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  // The busy timeout first: the server and the runner start together (login, startup tasks), and the second to open
  // the database must wait for the first's journal setup, not fail with "database is locked".
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(BASE_SCHEMA);
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const at = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (at > MIGRATIONS.length) throw new Error(`database schema version ${at} is newer than this Agentry (${MIGRATIONS.length})`);
  for (let v = at; v < MIGRATIONS.length; v++) {
    const refused = MIGRATION_GUARDS[v]?.(db);
    if (refused) throw new Error(`can't upgrade the database yet: ${refused}`);
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }).immediate();
  }
}

// The queue's settings, shared by all its runners.
type RunnerRow = { paused: number; pause_reason: string | null; workers: number; ai_agent: AgentId };

export function runnerRow(db: Database): RunnerRow {
  return db.query("SELECT paused, pause_reason, workers, ai_agent FROM runner WHERE id = 1").get() as RunnerRow;
}

export type Lease = { holder: string; token: string; pid: number | null; host: string | null; expires_at: number; recipes: string | null };

export function leaseOf(db: Database, holder = "local"): Lease | null {
  return db.query("SELECT holder, token, pid, host, expires_at, recipes FROM leases WHERE holder = ?").get(holder) as Lease | null;
}

// Takes `holder`'s lease if it is free or expired. Returns false while another process holds it. `recipes`: the
// projects an attached runner has recipes for (null: every project, as for this machine's runner).
export function acquireLease(db: Database, token: string, pid: number, now = Date.now(), host = hostname(), holder = "local",
  recipes: string[] | null = null): boolean {
  const res = db.query(`INSERT INTO leases (holder, token, pid, host, expires_at, recipes) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(holder) DO UPDATE SET token = excluded.token, pid = excluded.pid, host = excluded.host, expires_at = excluded.expires_at,
      recipes = excluded.recipes WHERE leases.expires_at < ? OR leases.token = excluded.token`)
    .run(holder, token, pid, host, now + LEASE_TTL_MS, recipes ? JSON.stringify(recipes) : null, now);
  return res.changes === 1;
}

// Extends `holder`'s lease and the leases of its runs in progress. Throws LeaseLost if it no longer owns it.
export function renewLease(db: Database, token: string, runIds: number[], now = Date.now(), holder = "local"): void {
  fenced(db, token, () => {
    db.query("UPDATE leases SET expires_at = ? WHERE holder = ?").run(now + LEASE_TTL_MS, holder);
    for (const id of runIds) db.query("UPDATE runs SET lease_expires_at = ? WHERE id = ? AND holder = ?").run(now + LEASE_TTL_MS, id, holder);
  }, holder);
}

export function releaseLease(db: Database, token: string, holder = "local"): void {
  db.query("DELETE FROM leases WHERE holder = ? AND token = ?").run(holder, token);
}

// Runs `write` in one transaction, only if `token` still owns `holder`'s lease.
export function fenced<T>(db: Database, token: string, write: () => T, holder = "local"): T {
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM leases WHERE holder = ? AND token = ?").get(holder, token)) throw new LeaseLost();
    return write();
  })();
}

// A write to a run or request that another runner works on (two-runners review D6).
export class NotYours extends Error {}

// Who is acting, for the audit log: "user:<name>" from the web UI, "cli" from the terminal, null for the runner.
const audit: { actor: string | null } = { actor: null };

// Runs a synchronous block with `actor` recorded on every event it logs. Actions are synchronous, so two web
// requests can never interleave inside one.
export function asActor<T>(actor: string, block: () => T): T {
  const before = audit.actor;
  audit.actor = actor;
  try { return block(); } finally { audit.actor = before; }
}

export function logEvent(db: Database, requestId: number | null, type: string, payload: unknown = null, now = Date.now()): void {
  db.query("INSERT INTO events (ts, request_id, type, payload, actor) VALUES (?, ?, ?, ?, ?)")
    .run(now, requestId, type, payload === null ? null : JSON.stringify(payload), audit.actor);
}

export function setRequestStatus(db: Database, id: number, status: RequestStatus, reason: string | null = null, now = Date.now()): void {
  db.query("UPDATE requests SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?").run(status, reason, now, id);
  logEvent(db, id, "status", { status, reason }, now);
}
