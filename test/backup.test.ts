// Nightly backups (winhost design "Backups"): a consistent DB copy while another connection writes, bundles of
// agentry/* branches, 14 days kept, 90-day log retention, and a clear failure when the folder is missing.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupIfDue, lastBackupAt, LOG_RETENTION_MS, runBackup } from "../src/backup.ts";
import { saveUploads } from "../src/attachments.ts";
import { openDb } from "../src/db.ts";
import { git } from "../src/git.ts";
import { makeFixture } from "./fixture.ts";

const DAY = 24 * 3600_000;

function setup() {
  const fx = makeFixture();
  const home = join(fx.root, "agentry");
  const dir = join(fx.root, "backups");
  mkdirSync(home);
  mkdirSync(dir);
  const db = openDb(join(home, "agentry.db"));
  db.query("INSERT INTO repos (name, path) VALUES ('r', ?)").run(fx.repo);
  db.query("INSERT INTO deploy_groups (name) VALUES ('g')").run();
  db.query("INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('p', 1, 1, ?)")
    .run(JSON.stringify({ repo: fx.repo, deploy_group: "g", scope_path: "app/", test_cmd: "true" }));
  db.query("INSERT INTO requests (project_id, title, created_at, updated_at) VALUES (1, 'kept', 0, 0)").run();
  return { fx, home, dir, db };
}

describe("backup", () => {
  test("copies the database consistently while another connection writes", async () => {
    const h = setup();
    const writer = openDb(join(h.home, "agentry.db"));
    const timer = setInterval(() => writer.query("INSERT INTO events (ts, type) VALUES (?, 'noise')").run(Date.now()), 1);
    const r = await runBackup(h.db, h.home, h.dir);
    clearInterval(timer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const copy = new Database(r.file, { readonly: true });
    expect(copy.query("SELECT title FROM requests").all()).toEqual([{ title: "kept" }]);
    expect((copy.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
  });

  test("bundles the agentry/* branches so work waiting for review survives a restore", async () => {
    const h = setup();
    h.fx.write("wip.txt", "candidate\n");
    git(h.fx.repo, ["checkout", "--quiet", "-b", "agentry/7-1"]);
    h.fx.commit("candidate");
    const r = await runBackup(h.db, h.home, h.dir);
    expect(r.ok && r.bundles.length).toBe(1);
    if (!r.ok) return;
    expect(git(h.fx.repo, ["bundle", "verify", r.bundles[0]]).code).toBe(0);
    expect(git(h.fx.root, ["bundle", "list-heads", r.bundles[0]]).out).toContain("refs/heads/agentry/7-1");
  });

  test("a bundle holds only what origin lacks, and restores into a fresh clone", async () => {
    const h = setup();
    for (let i = 0; i < 20; i++) { h.fx.write(`history/${i}.txt`, "x".repeat(10_000) + i); h.fx.commit(`history ${i}`); }
    git(h.fx.repo, ["push", "--quiet", "origin", "main"]);
    git(h.fx.repo, ["checkout", "--quiet", "-b", "agentry/8-1"]);
    h.fx.write("wip.txt", "candidate\n");
    const candidate = h.fx.commit("candidate");
    const r = await runBackup(h.db, h.home, h.dir);
    if (!r.ok) throw new Error(r.error);
    const verify = git(h.fx.repo, ["bundle", "verify", r.bundles[0]]);
    expect(verify.code).toBe(0);
    expect(verify.out + verify.err).toContain("requires this ref"); // origin's main, not the whole history
    expect(git(h.fx.repo, ["bundle", "list-heads", r.bundles[0]]).out).toContain(`${candidate} refs/heads/agentry/8-1`);

    const clone = join(h.fx.root, "restore");
    git(h.fx.root, ["clone", "--quiet", h.fx.origin, clone]);
    expect(git(clone, ["fetch", "--quiet", r.bundles[0], "refs/heads/agentry/*:refs/heads/agentry/*"]).code).toBe(0);
    expect(git(clone, ["show", "agentry/8-1:wip.txt"]).out).toBe("candidate");
  });

  test("agentry branches already on origin need no bundle", async () => {
    const h = setup();
    git(h.fx.repo, ["checkout", "--quiet", "-b", "agentry/9-1"]);
    h.fx.write("done.txt", "pushed\n");
    h.fx.commit("pushed");
    git(h.fx.repo, ["push", "--quiet", "origin", "agentry/9-1"]);
    const r = await runBackup(h.db, h.home, h.dir);
    expect(r).toMatchObject({ ok: true, bundles: [] });
  });

  test("copies the attached images, adding new ones on later days", async () => {
    const h = setup();
    const png = (n: number) => ({ name: `s${n}.png`, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]) });
    saveUploads(h.db, h.home, 1, [png(1)], ["image/png"]);
    expect((await runBackup(h.db, h.home, h.dir)).ok).toBe(true);
    saveUploads(h.db, h.home, 1, [png(2)], ["image/png"]);
    expect((await runBackup(h.db, h.home, h.dir, Date.now() + DAY)).ok).toBe(true);
    expect(readdirSync(join(h.dir, "attachments", "1")).sort()).toEqual(["1.png", "2.png"]);
  });

  test("no agentry branches → no bundle, still a backup", async () => {
    const h = setup();
    const r = await runBackup(h.db, h.home, h.dir);
    expect(r).toMatchObject({ ok: true, bundles: [] });
  });

  test("keeps the 14 newest days", async () => {
    const h = setup();
    const start = new Date(2026, 9, 1, 3).getTime();
    for (let d = 0; d < 16; d++) await runBackup(h.db, h.home, h.dir, start + d * DAY);
    const days = readdirSync(h.dir).filter((f) => f.endsWith(".db")).sort();
    expect(days).toHaveLength(14);
    expect(days[0]).toBe("agentry-20261003.db");
  });

  test("a missing backup folder is reported, not ignored", async () => {
    const h = setup();
    const r = await runBackup(h.db, h.home, join(h.fx.root, "nowhere"));
    expect(r).toEqual({ ok: false, error: `backup folder ${join(h.fx.root, "nowhere")} does not exist` });
    expect(h.db.query("SELECT type FROM events WHERE type = 'backup_failed'").all()).toHaveLength(1);
    expect(lastBackupAt(h.db)).toBeNull();
  });

  test("deletes run logs older than 90 days and keeps newer ones", async () => {
    const h = setup();
    const now = Date.now();
    for (const [id, ended] of [[1, now - LOG_RETENTION_MS - DAY], [2, now - DAY]] as const) {
      h.db.query("INSERT INTO runs (id, request_id, attempt, status, started_at, ended_at) VALUES (?, 1, 1, 'passed', 0, ?)").run(id, ended);
      mkdirSync(join(h.home, "runs", String(id)), { recursive: true });
      writeFileSync(join(h.home, "runs", String(id), "1-agent.log"), "x");
    }
    const r = await runBackup(h.db, h.home, h.dir, now);
    expect(r.ok && r.logsPruned).toBe(1);
    expect(existsSync(join(h.home, "runs", "1"))).toBe(false);
    expect(existsSync(join(h.home, "runs", "2"))).toBe(true);
  });

  test("backupIfDue runs once a day", async () => {
    const h = setup();
    const t = Date.now();
    expect(await backupIfDue(h.db, h.home, h.dir, t)).not.toBeNull();
    expect(await backupIfDue(h.db, h.home, h.dir, t + 3600_000)).toBeNull();
    expect(await backupIfDue(h.db, h.home, h.dir, t + DAY)).not.toBeNull();
  });
});
