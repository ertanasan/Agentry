import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, acquireLease, renewLease, releaseLease, fenced, LeaseLost, runnerRow, LEASE_TTL_MS, BASE_SCHEMA, MIGRATIONS } from "../src/db.ts";

const mem = () => openDb(":memory:");

describe("runner lease", () => {
  test("a second runner cannot take a live lease", () => {
    const db = mem();
    expect(acquireLease(db, "a", 1, 1000)).toBe(true);
    expect(acquireLease(db, "b", 2, 1000 + LEASE_TTL_MS - 1)).toBe(false);
  });

  test("an expired lease can be taken over", () => {
    const db = mem();
    acquireLease(db, "a", 1, 1000);
    expect(acquireLease(db, "b", 2, 1000 + LEASE_TTL_MS + 1)).toBe(true);
    expect(runnerRow(db).owner_token).toBe("b");
  });

  test("renewing keeps a lease alive past its first TTL", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    renewLease(db, "a", null, LEASE_TTL_MS - 1);
    expect(acquireLease(db, "b", 2, LEASE_TTL_MS + 1)).toBe(false);
  });

  test("a stale runner's write is rejected after takeover (D17)", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    acquireLease(db, "b", 2, LEASE_TTL_MS + 1);
    expect(() => fenced(db, "a", () => db.exec("UPDATE runner SET paused = 1"))).toThrow(LeaseLost);
    expect(runnerRow(db).paused).toBe(0);
    expect(() => renewLease(db, "a", null)).toThrow(LeaseLost);
  });

  test("release frees the lease only for its owner", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    releaseLease(db, "b");
    expect(runnerRow(db).owner_token).toBe("a");
    releaseLease(db, "a");
    expect(acquireLease(db, "b", 2, 1)).toBe(true);
  });
});

describe("migrations (review D11)", () => {
  const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const columns = (db: Database) => (db.query("PRAGMA table_info(requests)").all() as { name: string }[]).map((c) => c.name);

  test("a populated slice-1 database upgrades in place and keeps its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentry-db-")), "agentry.db");
    const old = new Database(path, { create: true });
    old.exec(BASE_SCHEMA);
    old.exec(`INSERT INTO repos (name, path) VALUES ('r', '/r'); INSERT INTO deploy_groups (name) VALUES ('g');
      INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('p', 1, 1, '{}');
      INSERT INTO requests (project_id, title, status, created_at, updated_at) VALUES (1, 'old one', 'done', 1, 1);
      INSERT INTO runs (request_id, attempt, status, tests_total, tests_skipped, started_at) VALUES (1, 1, 'passed', 214, 2, 1);`);
    old.close();

    const db = openDb(path);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(columns(db)).toContain("redeploy_requested");
    expect(db.query("SELECT title, status, redeploy_requested FROM requests").all()).toEqual([{ title: "old one", status: "done", redeploy_requested: 0 }]);
    expect(db.query("SELECT * FROM request_projects").all()).toEqual([{ request_id: 1, project_id: 1 }]);
    expect(db.query("SELECT * FROM run_tests").all()).toEqual([{ run_id: 1, project_id: 1, total: 214, skipped: 2 }]);
    db.query("INSERT INTO requests (project_id, title, created_at, updated_at) VALUES (1, 'new one', 2, 2)").run();
    expect(db.query("SELECT project_id FROM request_projects WHERE request_id = 2").all()).toEqual([{ project_id: 1 }]);
    db.close();
    const again = openDb(path); // idempotent
    expect(version(again)).toBe(MIGRATIONS.length);
  });

  test("a new database gets every migration", () => {
    const db = mem();
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(columns(db)).toContain("redeploy_requested");
  });

  test("a database from a newer Agentry is refused, not downgraded", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentry-db-")), "agentry.db");
    const db = new Database(path, { create: true });
    db.exec(BASE_SCHEMA);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    expect(() => openDb(path)).toThrow("newer than this Agentry");
  });
});

