import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname } from "node:os";
import { openDb, acquireLease, renewLease, releaseLease, fenced, LeaseLost, leaseOf, runnerRow, LEASE_TTL_MS, BASE_SCHEMA, MIGRATIONS } from "../src/db.ts";

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
    expect(leaseOf(db)!.token).toBe("b");
  });

  test("renewing keeps a lease alive past its first TTL", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    renewLease(db, "a", [], LEASE_TTL_MS - 1);
    expect(acquireLease(db, "b", 2, LEASE_TTL_MS + 1)).toBe(false);
  });

  test("renewing extends the lease of every run in progress", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    db.exec("INSERT INTO repos (name, path) VALUES ('r', '/r'); INSERT INTO deploy_groups (name) VALUES ('g');");
    db.exec("INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('p', 1, 1, '{}')");
    for (let i = 0; i < 3; i++) {
      db.query("INSERT INTO requests (project_id, title, created_at, updated_at) VALUES (1, 't', 0, 0)").run();
      db.query("INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, started_at) VALUES (?, 1, 'a', 0, 0)").run(i + 1);
    }
    renewLease(db, "a", [1, 3], 1000);
    expect((db.query("SELECT lease_expires_at AS t FROM runs ORDER BY id").all() as { t: number }[]).map((r) => r.t)).toEqual([1000 + LEASE_TTL_MS, 0, 1000 + LEASE_TTL_MS]);
    expect(runnerRow(db).workers).toBe(1);
  });

  test("a stale runner's write is rejected after takeover (D17)", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    acquireLease(db, "b", 2, LEASE_TTL_MS + 1);
    expect(() => fenced(db, "a", () => db.exec("UPDATE runner SET paused = 1"))).toThrow(LeaseLost);
    expect(runnerRow(db).paused).toBe(0);
    expect(() => renewLease(db, "a", [])).toThrow(LeaseLost);
  });

  test("release frees the lease only for its owner", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    releaseLease(db, "b");
    expect(leaseOf(db)!.token).toBe("a");
    releaseLease(db, "a");
    expect(acquireLease(db, "b", 2, 1)).toBe(true);
  });

  test("two runners hold leases at once, each fenced by its own token (two-runners review D1)", () => {
    const db = mem();
    expect(acquireLease(db, "a", 1, 0, "winhost")).toBe(true);
    expect(acquireLease(db, "m", 2, 0, "machost", "machost", ["ios"])).toBe(true);
    expect(leaseOf(db, "machost")).toMatchObject({ token: "m", host: "machost", recipes: '["ios"]' });
    expect(fenced(db, "a", () => 1)).toBe(1);
    expect(fenced(db, "m", () => 2, "machost")).toBe(2);
    // A token is good only for its own holder.
    expect(() => fenced(db, "m", () => 0)).toThrow(LeaseLost);
    expect(() => fenced(db, "a", () => 0, "machost")).toThrow(LeaseLost);
    expect(() => renewLease(db, "a", [], 1, "machost")).toThrow(LeaseLost);
    // Each holder's lease expires and is taken over on its own.
    renewLease(db, "a", [], LEASE_TTL_MS - 1);
    expect(acquireLease(db, "a2", 3, LEASE_TTL_MS + 1)).toBe(false);
    expect(acquireLease(db, "m2", 4, LEASE_TTL_MS + 1, "machost", "machost")).toBe(true);
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

  // A database at `v` with this runner row, as an Agentry before migration 8 left it.
  const atVersion = (v: number, setup: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "agentry-db-")), "agentry.db");
    const old = new Database(path, { create: true });
    old.exec(BASE_SCHEMA);
    for (let i = 0; i < v; i++) old.exec(MIGRATIONS[i]);
    old.exec(`PRAGMA user_version = ${v};
      INSERT INTO repos (name, path) VALUES ('r', '/r'); INSERT INTO deploy_groups (name) VALUES ('g');
      INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('p', 1, 1, '{}');
      INSERT INTO requests (project_id, title, status, created_at, updated_at) VALUES (1, 'busy', 'running', 1, 1);
      ${setup}`);
    old.close();
    return path;
  };

  test("the upgrade to several runners waits while another machine's runner has work in flight (two-runners review O6)", () => {
    const later = Date.now() + 60_000;
    const elsewhere = atVersion(7, `UPDATE runner SET owner_token = 'x', owner_host = 'machost-elsewhere', lease_expires_at = ${later};
      INSERT INTO runs (request_id, attempt, status, lease_token, started_at) VALUES (1, 1, 'running', 'x', 1);`);
    expect(() => openDb(elsewhere)).toThrow("the runner on machost-elsewhere is working this queue");
    const raw = new Database(elsewhere);
    expect((raw.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(7);
    raw.exec("UPDATE runs SET status = 'passed'");
    raw.close();
    expect(version(openDb(elsewhere))).toBe(MIGRATIONS.length);

    // This machine's own runner, or a lease that lapsed: its runs become this machine's.
    const here = atVersion(7, `UPDATE runner SET owner_token = 'x', owner_host = '${hostname()}', lease_expires_at = ${later};
      INSERT INTO runs (request_id, attempt, status, lease_token, started_at) VALUES (1, 1, 'running', 'x', 1);`);
    const db = openDb(here);
    expect(db.query("SELECT holder FROM runs").get()).toEqual({ holder: "local" });
    expect(db.query("SELECT holder FROM requests").get()).toEqual({ holder: "local" });
    expect(leaseOf(db)).toBeNull();
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

