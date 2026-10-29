// Several runners on one queue (two-runners review): routing, atomic claims, cross-runner deploy-group exclusion,
// continuations that stay with their runner, and handing a removed runner's work back.
import { describe, expect, test } from "bun:test";
import * as A from "../src/actions.ts";
import { acquireLease, NotYours, openDb } from "../src/db.ts";
import { localQueue } from "../src/queue.ts";
import { addRunnerKey, removeRunnerKey, rotateRunnerKey, runnerApi } from "../src/remote.ts";
import { eligible, routeOf, waitingFor } from "../src/routing.ts";

// One repo; web and api share the vt-server group, ios has its own.
function setup() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO repos (name, path) VALUES ('r', '/r');
    INSERT INTO deploy_groups (name) VALUES ('vt-server'), ('vt-ios');
    INSERT INTO projects (name, repo_id, deploy_group_id, recipe, runners) VALUES
      ('web', 1, 1, '{}', 'local,mac'), ('api', 1, 1, '{}', 'local,mac'), ('ios', 1, 2, '{}', 'mac');`);
  addRunnerKey(db, "mac");
  acquireLease(db, "L", 1, Date.now(), "winhost");
  acquireLease(db, "M", 2, Date.now(), "machost", "mac", ["web", "api", "ios"]);
  return { db, local: localQueue(db, "L", ""), mac: localQueue(db, "M", "", "mac") };
}

describe("routing", () => {
  test("a request goes to the first runner of its first project that may run every project", () => {
    const table: [string | null, string | null, string[]][] = [
      ["local,mac", "mac,local", ["local", "mac"]],
      ["local,mac", null, ["local"]],
      ["local,mac", "mac", ["mac"]],
      ["mac,local", "local,mac", ["mac", "local"]],
      [null, null, ["local"]],     // NULL is this machine's only (existing setups behave as before)
      [null, "mac", []],           // nobody may run both
    ];
    for (const [a, b, want] of table) expect(eligible([{ runners: a }, { runners: b }])).toEqual(want);
  });

  test("web-only goes to this machine's runner, ios+web to mac, and no runner means refused when filed", () => {
    const { db } = setup();
    const web = A.addRequest(db, { projects: ["web"], title: "w" });
    const mixed = A.addRequest(db, { projects: ["web", "ios"], title: "m" });
    expect(routeOf(db, web).holder).toBe("local");
    expect(routeOf(db, mixed).holder).toBe("mac");
    db.exec("UPDATE projects SET runners = 'local' WHERE name = 'web'");
    expect(() => A.addRequest(db, { projects: ["web", "ios"], title: "x" })).toThrow("no runner may run all of these projects: web runs on local; ios runs on mac");
  });
});

describe("claim", () => {
  test("each runner claims only the requests routed to it, and a claimed request is running and its", async () => {
    const { db, local, mac } = setup();
    const ios = A.addRequest(db, { projects: ["ios"], title: "i" });
    const web = A.addRequest(db, { projects: ["web"], title: "w" });
    expect((await local.claim())?.id).toBe(web);
    expect((await mac.claim())?.id).toBe(ios);
    expect(await local.claim()).toBeNull();
    expect(db.query("SELECT id, status, holder FROM requests ORDER BY id").all()).toEqual([
      { id: ios, status: "running", holder: "mac" }, { id: web, status: "running", holder: "local" },
    ]);
  });

  test("a request waits while another runner works in one of its deploy groups (D2)", async () => {
    const { db, local, mac } = setup();
    const mixed = A.addRequest(db, { projects: ["api", "ios"], title: "m" });
    const web = A.addRequest(db, { projects: ["web"], title: "w" });
    expect((await mac.claim())?.id).toBe(mixed);
    expect(await local.claim()).toBeNull();               // vt-server is in use by mac
    expect(waitingFor(db, web)).toBeNull();               // routed to an online runner: only the group holds it
    db.exec(`UPDATE requests SET status = 'done' WHERE id = ${mixed}`);
    expect((await local.claim())?.id).toBe(web);
  });

  test("two runners claiming at once never both win the same group (D5)", async () => {
    const { db } = setup();
    const a = A.addRequest(db, { projects: ["web"], title: "a" });
    const b = A.addRequest(db, { projects: ["api"], title: "b" });
    db.exec("UPDATE projects SET runners = 'mac,local' WHERE name = 'api'");
    const [x, y] = await Promise.all([localQueue(db, "L", "").claim(), localQueue(db, "M", "", "mac").claim()]);
    expect([x?.id ?? null, y?.id ?? null].filter((id) => id !== null)).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS n FROM requests WHERE status = 'running'").get()).toEqual({ n: 1 });
    expect([a, b]).toContain((x ?? y)!.id);
  });

  test("a runner never gets a project it reported no recipe for (D9)", async () => {
    const { db, mac } = setup();
    acquireLease(db, "M", 2, Date.now(), "machost", "mac", ["web"]);
    const ios = A.addRequest(db, { projects: ["ios"], title: "i" });
    expect(await mac.claim()).toBeNull();
    expect(waitingFor(db, ios)).toBe("mac has no recipe for ios");
  });

  test("an approved request resumes on the runner that made its branch (D7)", async () => {
    const { db, local, mac } = setup();
    const web = A.addRequest(db, { projects: ["web"], title: "w" });
    const run = Number(db.query("INSERT INTO runs (request_id, attempt, holder, status, started_at) VALUES (?, 1, 'mac', 'failed', 0)").run(web).lastInsertRowid);
    db.query("UPDATE requests SET resume_run = ? WHERE id = ?").run(run, web);
    expect(await local.claim()).toBeNull();
    expect((await mac.claim())?.id).toBe(web);
  });

  test("a claimed request whose run can't start goes back; a dead runner's claims are requeued at its next start", async () => {
    const { db, local } = setup();
    const web = A.addRequest(db, { projects: ["web"], title: "w" });
    await local.claim();
    await local.unclaim(web);
    expect(db.query("SELECT status FROM requests").get()).toEqual({ status: "queued" });
    await local.claim();
    expect(await localQueue(db, "L", "").requeueStaleClaims()).toEqual([web]);
    expect(db.query("SELECT status FROM requests").get()).toEqual({ status: "queued" });
  });
});

describe("writes", () => {
  test("a runner writes only to its own runs and requests (D6)", async () => {
    const { db, local, mac } = setup();
    const web = A.addRequest(db, { projects: ["web"], title: "w" });
    await local.claim();
    const run = await local.startRun(web, { attempt: 1, branch: "b", base: null, candidate: null });
    expect(db.query("SELECT holder FROM runs").get()).toEqual({ holder: "local" });
    await expect(mac.setRun(run, { base_sha: "x" })).rejects.toThrow(NotYours);
    await expect(mac.setStatus(web, "done", null)).rejects.toThrow(NotYours);
    await expect(mac.startRun(web, { attempt: 2, branch: "b", base: null, candidate: null })).rejects.toThrow(NotYours);
    await local.setRun(run, { base_sha: "x" });
    expect(db.query("SELECT base_sha FROM runs").get()).toEqual({ base_sha: "x" });
  });
});

describe("removing a runner key", () => {
  test("refused while that runner is connected or a project lists it; then its work passes to this machine's runner", async () => {
    const { db, local, mac } = setup();
    const ios = A.addRequest(db, { projects: ["ios"], title: "i" });
    await mac.claim();
    const run = await mac.startRun(ios, { attempt: 1, branch: "b", base: null, candidate: null });
    const resumed = A.addRequest(db, { projects: ["web"], title: "r" });
    const old = Number(db.query("INSERT INTO runs (request_id, attempt, holder, status, started_at) VALUES (?, 1, 'mac', 'failed', 0)").run(resumed).lastInsertRowid);
    db.query("UPDATE requests SET resume_run = ? WHERE id = ?").run(old, resumed);

    expect(() => removeRunnerKey(db, "mac")).toThrow("mac's runner is connected");
    const later = Date.now() + 120_000;
    expect(() => removeRunnerKey(db, "mac", later)).toThrow("these projects still list mac: api, ios, web");
    db.exec("UPDATE projects SET runners = 'local'");
    expect(removeRunnerKey(db, "mac", later)).toEqual({ handedBack: 1 });

    expect(db.query("SELECT holder FROM runs WHERE id = ?").get(run)).toEqual({ holder: "local" });
    expect(db.query("SELECT resume_run FROM requests WHERE id = ?").get(resumed)).toEqual({ resume_run: null });
    expect(db.query("SELECT COUNT(*) AS n FROM runner_keys").get()).toEqual({ n: 0 });
    // This machine's runner sees the handed-back run as its own expired one, so its next poll recovers it.
    db.query("UPDATE runs SET lease_expires_at = 1 WHERE id = ?").run(run);
    expect((await local.expiredRuns(Date.now())).map((r) => r.id)).toEqual([run]);
  });

  test("rotating a runner key: the old key stops working, the new one works, and its projects and lease stay", async () => {
    const { db } = setup();
    const status = async (key: string) => (await runnerApi(db, "", new Request("http://q/api/runner/call/settings", { method: "POST", headers: { authorization: `Bearer ${key}` } }), new URL("http://q/api/runner/call/settings")))!.status;
    const old = rotateRunnerKey(db, "mac");
    expect(await status(old)).toBe(400);   // past the key check; stopped only for want of a lease token

    const key = rotateRunnerKey(db, "mac");
    expect(await status(old)).toBe(401);
    expect(await status(key)).toBe(400);
    expect(db.query("SELECT name FROM projects WHERE runners LIKE '%mac%' ORDER BY name").all()).toEqual([{ name: "api" }, { name: "ios" }, { name: "web" }]);
    expect(db.query("SELECT host FROM leases WHERE holder = 'mac'").get()).toEqual({ host: "machost" });
    expect(() => rotateRunnerKey(db, "pc")).toThrow("no runner key named pc");
  });

  test("a runner key can't be named after this machine's runner", () => {
    const { db } = setup();
    expect(() => addRunnerKey(db, "local")).toThrow("names this machine's own runner");
  });
});
