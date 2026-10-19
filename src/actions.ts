// The state actions a person takes on requests (design "Your actions on each state"). The CLI calls them today;
// the web UI calls the same functions, so a state rule lives in one place (slice 2 review D3). Each action runs
// in one transaction and refuses a request that is not in a state it acts on.
import type { Database } from "bun:sqlite";
import { logEvent, setRequestStatus, type RequestStatus } from "./db.ts";

// A refused action: wrong state, unknown request or project. The CLI exits 1 with the message; the server
// answers 409 (wrong state) or 404 (not found).
export class ActionError extends Error {
  constructor(message: string, readonly kind: "not_found" | "wrong_state" | "invalid" = "wrong_state") { super(message); }
}

type Req = {
  id: number; status: RequestStatus; title: string; body: string; project_id: number;
  done_when: string | null; done_when_test: string | null; deploy_group_id: number;
};

// Moves a request from one of `from` to `to`, with an event. Callers needing more writes wrap it in theirs.
function move(db: Database, id: number, from: RequestStatus[], to: RequestStatus, reason: string | null, event: string, payload: unknown = null): Req {
  return db.transaction(() => {
    const req = db.query(`SELECT r.id, r.status, r.title, r.body, r.project_id, r.done_when, r.done_when_test, p.deploy_group_id
      FROM requests r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`).get(id) as Req | null;
    if (!req) throw new ActionError(`no request #${id}`, "not_found");
    if (!from.includes(req.status)) throw new ActionError(`#${id} is ${req.status}; this needs ${from.join(" or ")}`);
    logEvent(db, id, event, payload);
    setRequestStatus(db, id, to, reason);
    return req;
  })();
}

export type NewRequest = { project: string; title: string; body?: string; doneWhen?: string | null; doneWhenTest?: string | null; priority?: number };

export function addRequest(db: Database, r: NewRequest): number {
  if (!r.title.trim()) throw new ActionError("a request needs a title", "invalid");
  const p = db.query("SELECT id FROM projects WHERE name = ?").get(r.project) as { id: number } | null;
  if (!p) throw new ActionError(`no project "${r.project}"`, "not_found");
  const now = Date.now();
  const id = Number(db.query(`INSERT INTO requests (project_id, title, body, done_when, done_when_test, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, r.title.trim(), r.body ?? "", r.doneWhen ?? null, r.doneWhenTest ?? null, r.priority ?? 0, now, now)
    .lastInsertRowid);
  logEvent(db, id, "add");
  return id;
}

// needs_info → queued; the answer reaches the next attempt's prompt.
export function answer(db: Database, id: number, text: string): void {
  if (!text.trim()) throw new ActionError("an answer needs text", "invalid");
  move(db, id, ["needs_info"], "queued", null, "answer", { text });
}

// needs_review → queued; the next run resumes this run's branch at build.
export function approve(db: Database, id: number): void {
  db.transaction(() => {
    const req = move(db, id, ["needs_review"], "queued", null, "approve");
    const last = db.query("SELECT id FROM runs WHERE request_id = ? ORDER BY id DESC LIMIT 1").get(req.id) as { id: number };
    db.query("UPDATE requests SET resume_run = ? WHERE id = ?").run(last.id, req.id);
  })();
}

export function reject(db: Database, id: number): void {
  move(db, id, ["needs_review"], "canceled", "rejected", "reject");
}

export type RetryEdits = { body?: string; doneWhen?: string | null; doneWhenTest?: string | null };

// blocked_pre_push → queued: a new attempt on a new branch, optionally with an edited body or done-when.
export function retry(db: Database, id: number, edits: RetryEdits = {}): void {
  db.transaction(() => {
    const req = move(db, id, ["blocked_pre_push"], "queued", null, "retry");
    db.query("UPDATE requests SET body = ?, done_when = ?, done_when_test = ? WHERE id = ?")
      .run(edits.body ?? req.body, edits.doneWhen ?? req.done_when, edits.doneWhenTest ?? req.done_when_test, req.id);
  })();
}

export function cancel(db: Database, id: number): void {
  move(db, id, ["queued", "needs_info", "needs_review", "blocked_pre_push"], "canceled", "canceled", "cancel");
}

// blocked_post_push → done_manual, and the deploy group this request holds is freed.
export function resolve(db: Database, id: number): void {
  db.transaction(() => {
    const req = move(db, id, ["blocked_post_push"], "done_manual", "resolved by hand", "resolve");
    db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, locked_by_request = NULL, undeployed_sha = NULL WHERE id = ? AND locked_by_request = ?")
      .run(req.deploy_group_id, req.id);
  })();
}

// blocked_post_push → queued for the runner, which re-runs the deploy before new work (slice 2 review D7).
export function requestRedeploy(db: Database, id: number): void {
  db.transaction(() => {
    move(db, id, ["blocked_post_push"], "blocked_post_push", "re-run deploy queued", "redeploy");
    if (!db.query("SELECT 1 FROM runs WHERE request_id = ? AND commit_sha IS NOT NULL").get(id)) {
      throw new ActionError(`#${id} has no pushed commit to deploy`);
    }
    db.query("UPDATE requests SET redeploy_requested = 1 WHERE id = ?").run(id);
  })();
}

// done → a new linked request; counts one false-done.
export function reopen(db: Database, id: number, what: string): number {
  if (!what.trim()) throw new ActionError("reopen needs what's wrong", "invalid");
  const newId = db.transaction(() => {
    const orig = db.query("SELECT status, title, body, project_id, done_when, done_when_test FROM requests WHERE id = ?").get(id) as Req | null;
    if (!orig) throw new ActionError(`no request #${id}`, "not_found");
    if (orig.status !== "done") throw new ActionError(`#${id} is ${orig.status}; reopen needs done`);
    logEvent(db, id, "reopen", { text: what });
    const now = Date.now();
    return Number(db.query(`INSERT INTO requests (project_id, title, body, done_when, done_when_test, reopened_from, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(orig.project_id, `Reopened #${id}: ${orig.title}`,
      `${what}\n\nOriginal request:\n${orig.body}`, orig.done_when, orig.done_when_test, id, now, now).lastInsertRowid);
  })();
  logEvent(db, newId, "add", { reopened_from: id });
  return newId;
}

// Clears a deploy-group lock that no request holds (the drift guard's).
export function unblock(db: Database, group: string): void {
  const res = db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, undeployed_sha = NULL WHERE name = ? AND lock = 'blocked' AND locked_by_request IS NULL").run(group);
  if (res.changes !== 1) throw new ActionError(`group ${group} is not blocked, or a request holds it (use resolve or redeploy on that request)`);
  logEvent(db, null, "unblock", { group });
}

export function resume(db: Database): void {
  db.query("UPDATE runner SET paused = 0, pause_reason = NULL WHERE id = 1").run();
  logEvent(db, null, "resume");
}
