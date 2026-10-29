// The state actions a person takes on requests (design "Your actions on each state"). The CLI calls them today;
// the web UI calls the same functions, so a state rule lives in one place (slice 2 review D3). Each action runs
// in one transaction and refuses a request that is not in a state it acts on.
import type { Database } from "bun:sqlite";
import { AGENTS, isAgent } from "./adapters/providers.ts";
import { logEvent, setRequestStatus, type RequestStatus } from "./db.ts";
import { choicesFor, type Picks } from "./devices.ts";
import { storeRecipe } from "./recipes.ts";
import { eligible, LOCAL, runnersOf } from "./routing.ts";

// A refused action: wrong state, unknown request or project, or a user whose role may not take it. The CLI exits
// 1 with the message; the server answers 409 (wrong state), 404 (not found), 400 (invalid) or 403 (forbidden).
export class ActionError extends Error {
  constructor(message: string, readonly kind: "not_found" | "wrong_state" | "invalid" | "forbidden" = "wrong_state") { super(message); }
}

type Req = {
  id: number; status: RequestStatus; title: string; body: string; project_id: number;
  done_when: string | null; done_when_test: string | null;
};

// Moves a request from one of `from` to `to`, with an event. Callers needing more writes wrap it in theirs.
function move(db: Database, id: number, from: RequestStatus[], to: RequestStatus, reason: string | null, event: string, payload: unknown = null): Req {
  return db.transaction(() => {
    const req = db.query(`SELECT r.id, r.status, r.title, r.body, r.project_id, r.done_when, r.done_when_test
      FROM requests r WHERE r.id = ?`).get(id) as Req | null;
    if (!req) throw new ActionError(`no request #${id}`, "not_found");
    if (!from.includes(req.status)) throw new ActionError(`#${id} is ${req.status}; this needs ${from.join(" or ")}`);
    logEvent(db, id, event, payload);
    setRequestStatus(db, id, to, reason);
    return req;
  })();
}

// `projects`: one or more, all in one repo; the runner deploys each of them. `agent`: none takes the queue's.
// `deployOnly`: no change; the runner deploys main as it is (deployMain). `deployTo`: by project, the ids of the deploy
// entries its runner offers (devices.ts) to deploy to; a project left out deploys its defaults.
export type NewRequest = {
  projects: string[]; title: string; body?: string; doneWhen?: string | null; doneWhenTest?: string | null; priority?: number; agent?: string | null;
  deployOnly?: boolean; deployTo?: Record<string, string[]>;
};

// The picks worth keeping: each from the project's entries, at least one per project, and only those that differ
// from the project's defaults.
function picksOf(db: Database, names: string[], deployTo: Record<string, string[]>): Picks {
  const choices = choicesFor(db, names);
  const picks: Picks = {};
  for (const [project, ids] of Object.entries(deployTo)) {
    const entries = choices[project];
    if (!names.includes(project) || !entries?.length) continue;
    if (!ids.length) throw new ActionError(`pick at least one deploy target for ${project}`, "invalid");
    const chosen = entries.filter((e) => ids.includes(e.id));
    if (chosen.length !== new Set(ids).size) throw new ActionError(`${project} can't deploy to that target: pick from its list`, "invalid");
    const defaults = entries.filter((e) => e.pick);
    if (chosen.length !== defaults.length || chosen.some((e) => !e.pick)) picks[project] = chosen.map(({ id, name }) => ({ id, name }));
  }
  return picks;
}

export function addRequest(db: Database, r: NewRequest): number {
  if (!r.title.trim()) throw new ActionError("a request needs a title", "invalid");
  const names = [...new Set(r.projects.map((n) => n.trim()).filter(Boolean))];
  if (!names.length) throw new ActionError("a request needs a project", "invalid");
  if (r.agent && !isAgent(r.agent)) throw new ActionError(`no AI agent "${r.agent}": choose ${Object.keys(AGENTS).join(", ")}`, "invalid");
  const ps = names.map((name) => {
    const p = db.query("SELECT id, repo_id, runners FROM projects WHERE name = ?").get(name) as { id: number; repo_id: number; runners: string | null } | null;
    if (!p) throw new ActionError(`no project "${name}"`, "not_found");
    return p;
  });
  if (new Set(ps.map((p) => p.repo_id)).size > 1) throw new ActionError("the projects of one request must share a repository", "invalid");
  // One runner works the whole request, so one must be allowed to run every project (two-runners review).
  if (!eligible(ps).length) {
    throw new ActionError(`no runner may run all of these projects: ${names.map((n, i) => `${n} runs on ${runnersOf(ps[i].runners).join(" or ")}`).join("; ")}`, "invalid");
  }
  const picks = r.deployTo ? picksOf(db, names, r.deployTo) : {};
  const now = Date.now();
  return db.transaction(() => {
    const id = Number(db.query(`INSERT INTO requests (project_id, title, body, done_when, done_when_test, priority, ai_agent, deploy_only, deploy_to,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ps[0].id, r.title.trim(), r.body ?? "", r.doneWhen ?? null, r.doneWhenTest ?? null,
      r.priority ?? 0, r.agent || null, r.deployOnly ? 1 : 0, Object.keys(picks).length ? JSON.stringify(picks) : null, now, now).lastInsertRowid);
    for (const p of ps.slice(1)) db.query("INSERT INTO request_projects (request_id, project_id) VALUES (?, ?)").run(id, p.id);
    logEvent(db, id, "add");
    return id;
  })();
}

// A deploy of `project`'s main as it is, without a change: for commits made outside Agentry, a target to bring
// back, or a fresh TestFlight build. The runner builds and tests origin's main, with no agent, then deploys it to
// `deployTo` (the ids of its deploy entries; default its defaults).
export function deployMain(db: Database, project: string, deployTo?: string[]): number {
  return addRequest(db, { projects: [project], title: "Deploy main", deployOnly: true, deployTo: deployTo && { [project]: deployTo } });
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

// blocked_pre_push or needs_review → queued: a new attempt on a new branch, optionally with an edited body or done-when.
export function retry(db: Database, id: number, edits: RetryEdits = {}): void {
  db.transaction(() => {
    const req = move(db, id, ["blocked_pre_push", "needs_review"], "queued", null, "retry");
    db.query("UPDATE requests SET body = ?, done_when = ?, done_when_test = ? WHERE id = ?")
      .run(edits.body ?? req.body, edits.doneWhen ?? req.done_when, edits.doneWhenTest ?? req.done_when_test, req.id);
  })();
}

export function cancel(db: Database, id: number): void {
  move(db, id, ["queued", "needs_info", "needs_review", "blocked_pre_push"], "canceled", "canceled", "cancel");
}

// blocked_post_push → done_manual, and the deploy groups this request holds are freed.
export function resolve(db: Database, id: number): void {
  db.transaction(() => {
    const req = move(db, id, ["blocked_post_push"], "done_manual", "resolved by hand", "resolve");
    db.query("UPDATE deploy_groups SET lock = 'free', lock_reason = NULL, locked_by_request = NULL, undeployed_sha = NULL WHERE locked_by_request = ?")
      .run(req.id);
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
    const added = Number(db.query(`INSERT INTO requests (project_id, title, body, done_when, done_when_test, reopened_from, ai_agent, deploy_to,
      created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ai_agent, deploy_to, ?, ? FROM requests WHERE id = ?`).run(orig.project_id,
      `Reopened #${id}: ${orig.title}`, `${what}\n\nOriginal request:\n${orig.body}`, orig.done_when, orig.done_when_test, id, now, now, id).lastInsertRowid);
    db.query("INSERT OR IGNORE INTO request_projects (request_id, project_id) SELECT ?, project_id FROM request_projects WHERE request_id = ?").run(added, id);
    return added;
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

// Stops the runner from starting new requests; the ones running finish. Resume undoes it.
export function pause(db: Database, reason: string): void {
  db.query("UPDATE runner SET paused = 1, pause_reason = ? WHERE id = 1").run(reason);
  logEvent(db, null, "pause", { reason });
}

// Registers a project, or updates the one with that name, with its recipe and the file that recipe lives in.
// `runners`: the runners that may run it, home first ('local' or runner-key names; two-runners review D4). Null: a
// new project is this machine's only and an existing one keeps its list.
export function addProject(db: Database, name: string, recipeJson: string, file: string | null, runners: string[] | null): void {
  if (runners) {
    if (!runners.length) throw new ActionError("--runner needs at least one runner", "invalid");
    const known = new Set([LOCAL, ...(db.query("SELECT name FROM runner_keys").all() as { name: string }[]).map((k) => k.name)]);
    const unknown = runners.filter((r) => !known.has(r));
    if (unknown.length) throw new ActionError(`no runner key named ${unknown.join(", ")} (agentry runner-key add <name>; this machine's runner is "${LOCAL}")`, "invalid");
  }
  db.transaction(() => {
    storeRecipe(db, name, recipeJson, file);
    if (runners) db.query("UPDATE projects SET runners = ? WHERE name = ?").run(runners.join(","), name);
  })();
}

// A disabled project's requests stay queued until it is enabled again.
export function setProjectEnabled(db: Database, name: string, enabled: boolean): void {
  const res = db.query("UPDATE projects SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, name);
  if (res.changes !== 1) throw new ActionError(`no project "${name}"`, "not_found");
  logEvent(db, null, enabled ? "project_enable" : "project_disable", { project: name });
}

export function resume(db: Database): void {
  db.query("UPDATE runner SET paused = 0, pause_reason = NULL WHERE id = 1").run();
  logEvent(db, null, "resume");
}

export function setAgent(db: Database, agent: string): void {
  if (!isAgent(agent)) throw new ActionError(`Choose ${Object.values(AGENTS).join(", ")}.`, "invalid");
  db.query("UPDATE runner SET ai_agent = ? WHERE id = 1").run(agent);
  logEvent(db, null, "settings", { ai_agent: agent });
}

export const MAX_WORKERS = 8;

// How many requests the runner works on at once. A running runner picks the change up before it starts the next
// request; lowering it lets the requests already running finish.
export function setWorkers(db: Database, workers: number): void {
  if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) throw new ActionError(`workers must be a whole number from 1 to ${MAX_WORKERS}`, "invalid");
  db.query("UPDATE runner SET workers = ? WHERE id = 1").run(workers);
  logEvent(db, null, "settings", { workers });
}
