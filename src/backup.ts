// Nightly backup (winhost design "Backups", review D11/D17): a consistent copy of the database with SQLite's
// VACUUM INTO (safe while the runner writes), plus a git bundle of each repository's agentry/* branches, since
// requests waiting for review or retry live only there, and a copy of the attached images. Keeps the 14 newest days. The same job deletes run
// logs older than 90 days. Every backup, or its failure, is an audit event; the UI warns after 48 hours.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { logEvent } from "./db.ts";
import * as g from "./git.ts";
import { parseRecipe } from "./recipe.ts";

export const KEEP_DAYS = 14;
export const LOG_RETENTION_MS = 90 * 24 * 3600_000;
export const STALE_AFTER_MS = 48 * 3600_000;

export type BackupResult =
  | { ok: true; file: string; bundles: string[]; removed: string[]; logsPruned: number }
  | { ok: false; error: string };

const stampOf = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

export async function runBackup(db: Database, home: string, dir: string, now = Date.now()): Promise<BackupResult> {
  if (!existsSync(dir)) {
    const error = `backup folder ${dir} does not exist`;
    logEvent(db, null, "backup_failed", { error }, now);
    return { ok: false, error };
  }
  try {
    const stamp = stampOf(now);
    const file = join(dir, `agentry-${stamp}.db`);
    rmSync(file, { force: true });
    db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);

    const bundles: string[] = [];
    const repos = new Set((db.query("SELECT recipe FROM projects").all() as { recipe: string }[]).map((p) => parseRecipe(p.recipe).repo));
    for (const repo of repos) {
      if (!existsSync(repo)) continue;
      const refs = await g.run(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/agentry/"]);
      if (refs.code !== 0 || !refs.out) continue;
      const tag = createHash("sha256").update(repo).digest("hex").slice(0, 8);
      const bundle = join(dir, `agentry-${stamp}-${basename(repo)}-${tag}.bundle`);
      rmSync(bundle, { force: true });
      const r = await g.run(repo, ["bundle", "create", bundle, ...refs.out.split("\n")]);
      if (r.code !== 0) throw new Error(`git bundle for ${repo} failed: ${r.err}`);
      bundles.push(bundle);
    }

    // Attached images never change, so one growing copy (new files only) is enough.
    const images = join(home, "attachments");
    if (existsSync(images)) cpSync(images, join(dir, "attachments"), { recursive: true, force: false });

    const removed = pruneOldBackups(dir);
    const logsPruned = pruneOldLogs(db, home, now);
    logEvent(db, null, "backup", { file, bundles, removed: removed.length, logsPruned }, now);
    return { ok: true, file, bundles, removed, logsPruned };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logEvent(db, null, "backup_failed", { error }, now);
    return { ok: false, error };
  }
}

// Deletes every backup file whose day is not among the KEEP_DAYS newest.
function pruneOldBackups(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => /^agentry-\d{8}(\.db|-.+\.bundle)$/.test(f));
  const days = [...new Set(files.map((f) => f.slice(8, 16)))].sort().reverse();
  const keep = new Set(days.slice(0, KEEP_DAYS));
  const removed = files.filter((f) => !keep.has(f.slice(8, 16)));
  for (const f of removed) rmSync(join(dir, f), { force: true });
  return removed;
}

// Deletes the log folders of runs that ended more than LOG_RETENTION_MS ago (their rows and summaries stay).
function pruneOldLogs(db: Database, home: string, now: number): number {
  const root = join(home, "runs");
  if (!existsSync(root)) return 0;
  const old = new Set((db.query("SELECT id FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?").all(now - LOG_RETENTION_MS) as { id: number }[])
    .map((r) => String(r.id)));
  let n = 0;
  for (const name of readdirSync(root)) {
    if (old.has(name)) { rmSync(join(root, name), { recursive: true, force: true }); n++; }
  }
  return n;
}

// The newest successful backup's time, or null if there has never been one.
export function lastBackupAt(db: Database): number | null {
  const row = db.query("SELECT MAX(ts) AS ts FROM events WHERE type = 'backup'").get() as { ts: number | null };
  return row.ts;
}

// Runs a backup when the newest is more than ~a day old: called at server start and then every hour.
export async function backupIfDue(db: Database, home: string, dir: string, now = Date.now()): Promise<BackupResult | null> {
  const last = lastBackupAt(db);
  if (last !== null && now - last < 23 * 3600_000) return null;
  return runBackup(db, home, dir, now);
}
