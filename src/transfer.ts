// `agentry export` and `agentry import`: what a fresh install needs to take over from an old one. The projects
// (recipe, runners, enabled), the runner keys (hashes only, so attached machines keep theirs) and the queue's agent
// and worker count. Users, passkeys, requests and history stay behind with the old database and its backups.
// The export is a folder a person can read and edit: agentry-export.json, and each recipe as recipes/<project>.json.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError, addProject, setAgent, setProjectEnabled, setWorkers } from "./actions.ts";
import { logEvent } from "./db.ts";

const MANIFEST = "agentry-export.json";
const VERSION = 1;

type Manifest = {
  version: number;
  exported_at: string;
  queue: { ai_agent: string; workers: number };
  runner_keys: { name: string; key_hash: string; created_at: number }[];
  projects: { name: string; recipe: string; runners: string[] | null; enabled: boolean }[];
  models: Record<string, string>; // AGENTRY_*MODEL of the exporting process: environment, not database, so not imported
};

// Writes the export to `dir`, creating it; an earlier export there is replaced. Returns what it wrote.
export function exportSetup(db: Database, dir: string, env: Record<string, string | undefined> = process.env): Manifest {
  mkdirSync(join(dir, "recipes"), { recursive: true });
  const projects = (db.query("SELECT name, recipe, runners, enabled FROM projects ORDER BY id").all() as
    { name: string; recipe: string; runners: string | null; enabled: number }[]).map((p) => {
    const file = `recipes/${p.name}.json`;
    writeFileSync(join(dir, file), p.recipe);
    return { name: p.name, recipe: file, runners: p.runners ? p.runners.split(",") : null, enabled: !!p.enabled };
  });
  const m: Manifest = {
    version: VERSION,
    exported_at: new Date().toISOString(),
    queue: db.query("SELECT ai_agent, workers FROM runner WHERE id = 1").get() as Manifest["queue"],
    runner_keys: db.query("SELECT name, key_hash, created_at FROM runner_keys ORDER BY id").all() as Manifest["runner_keys"],
    projects,
    models: Object.fromEntries(Object.entries(env).filter(([k, v]) => /^AGENTRY_\w*MODEL$/.test(k) && v) as [string, string][]),
  };
  writeFileSync(join(dir, MANIFEST), JSON.stringify(m, null, 2) + "\n");
  return m;
}

// Applies an export in one transaction: runner keys first (projects name them), then projects, then the queue's
// settings. Each recipe is written to `home`/recipes/<project>.json, the file it lives in from then on (recipes.ts).
// Safe to run again: projects are updated by name, and a runner key this install already has stays as it is.
// Returns one line per thing done or left alone.
export function importSetup(db: Database, dir: string, home: string): string[] {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) throw new ActionError(`no ${MANIFEST} in ${dir} (make one with agentry export <dir>)`, "not_found");
  const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  if (m.version !== VERSION) throw new ActionError(`${file} is version ${m.version}; this Agentry reads version ${VERSION}`, "invalid");
  const said: string[] = [];
  db.transaction(() => {
    for (const k of m.runner_keys) {
      const had = db.query("SELECT key_hash FROM runner_keys WHERE name = ?").get(k.name) as { key_hash: string } | null;
      if (had) { said.push(`runner key ${k.name}: ${had.key_hash === k.key_hash ? "already here" : "this install's own key kept"}`); continue; }
      db.query("INSERT INTO runner_keys (name, key_hash, created_at) VALUES (?, ?, ?)").run(k.name, k.key_hash, k.created_at);
      said.push(`runner key ${k.name}: imported (that machine keeps its key)`);
    }
    mkdirSync(join(home, "recipes"), { recursive: true });
    for (const p of m.projects) {
      const json = readFileSync(join(dir, p.recipe), "utf8");
      const file = join(home, "recipes", `${p.name}.json`);
      addProject(db, p.name, json, file, p.runners);
      writeFileSync(file, json.endsWith("\n") ? json : json + "\n");
      if (!p.enabled) setProjectEnabled(db, p.name, false);
      said.push(`project ${p.name}: runs on ${(p.runners ?? ["local"]).join(", ")}${p.enabled ? "" : ", disabled"}`);
    }
    setAgent(db, m.queue.ai_agent);
    setWorkers(db, m.queue.workers);
    said.push(`queue: ${m.queue.ai_agent}, ${m.queue.workers} worker${m.queue.workers === 1 ? "" : "s"}`);
    logEvent(db, null, "import", { from: m.exported_at, projects: m.projects.length, runner_keys: m.runner_keys.length });
  })();
  for (const [k, v] of Object.entries(m.models ?? {})) said.push(`model: set ${k}=${v} in the runner's environment (not imported)`);
  return said;
}
