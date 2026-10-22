// Which runner works a request when several share a queue (two-runners review). Each project lists the runners
// that may run it, home first ('local' is the queue owner's own runner; NULL means 'local' only). A request goes
// to a runner that may run all its projects: the first one of the first project's list that every other list has.
// A request that resumes a run's branch goes back to that run's runner, which alone has the branch (D7).
import type { Database } from "bun:sqlite";

export const LOCAL = "local";

export const runnersOf = (runners: string | null): string[] =>
  runners ? runners.split(",").map((s) => s.trim()).filter(Boolean) : [LOCAL];

// The runners that may run every one of these projects, in the first project's order.
export function eligible(projects: { runners: string | null }[]): string[] {
  const lists = projects.map((p) => runnersOf(p.runners));
  return lists.length ? lists[0].filter((h) => lists.every((l) => l.includes(h))) : [];
}

export type Route = { holder: string | null; eligible: string[]; projects: string[] };

// A request's runner, from the current project lists (a change re-routes queued requests) and its resume run.
export function routeOf(db: Database, requestId: number): Route {
  const parts = db.query(`SELECT p.name, p.runners FROM request_projects rp JOIN projects p ON p.id = rp.project_id
    WHERE rp.request_id = ? ORDER BY p.id`).all(requestId) as { name: string; runners: string | null }[];
  const resume = db.query(`SELECT ru.holder FROM requests r JOIN runs ru ON ru.id = r.resume_run WHERE r.id = ?`).get(requestId) as
    { holder: string } | null;
  const ok = eligible(parts);
  return { holder: resume?.holder ?? ok[0] ?? null, eligible: ok, projects: parts.map((p) => p.name) };
}

// The projects of `names` that `holder` reported no recipe for; none for a runner that reported nothing (local).
export function missingRecipes(db: Database, holder: string, names: string[]): string[] {
  const row = db.query("SELECT recipes FROM leases WHERE holder = ?").get(holder) as { recipes: string | null } | null;
  if (!row?.recipes) return [];
  const has = new Set(JSON.parse(row.recipes) as string[]);
  return names.filter((n) => !has.has(n));
}

// A runner as people name it: an attached runner by its key's name, the owner's own as this machine's.
export const runnerName = (holder: string) => holder === LOCAL ? "this machine's runner" : holder;

// Why a queued request isn't being worked on, or null when its runner can take it.
export type Wait =
  | { kind: "no-runner" }
  | { kind: "offline" | "not-allowed"; holder: string }
  | { kind: "no-recipe"; holder: string; projects: string[] };

export function waitOf(db: Database, requestId: number, now = Date.now()): Wait | null {
  const r = routeOf(db, requestId);
  if (!r.holder) return { kind: "no-runner" };
  const lease = db.query("SELECT expires_at FROM leases WHERE holder = ?").get(r.holder) as { expires_at: number } | null;
  if (!lease || lease.expires_at < now) return { kind: "offline", holder: r.holder };
  if (!r.eligible.includes(r.holder)) return { kind: "not-allowed", holder: r.holder };
  const missing = missingRecipes(db, r.holder, r.projects);
  return missing.length ? { kind: "no-recipe", holder: r.holder, projects: missing } : null;
}

export function waitText(w: Wait): string {
  switch (w.kind) {
    case "no-runner": return "no runner may run all of its projects";
    case "offline": return `waiting for ${runnerName(w.holder)}`;
    case "not-allowed": return `waiting for ${runnerName(w.holder)}, which may no longer run these projects`;
    case "no-recipe": return `${runnerName(w.holder)} has no recipe for ${w.projects.join(", ")}`;
  }
}

export function waitingFor(db: Database, requestId: number, now = Date.now()): string | null {
  const w = waitOf(db, requestId, now);
  return w ? waitText(w) : null;
}
