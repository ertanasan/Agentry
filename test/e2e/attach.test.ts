// A runner working another machine's queue (remote.ts), end to end: the queue's owner is a server in this
// process with its own home; the runner is `bun src/cli.ts` with a home of its own, attached with a runner key.
// The owner's recipe names a path that doesn't exist, so the run can only pass with the runner's own recipe.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as A from "../../src/actions.ts";
import { openDb } from "../../src/db.ts";
import * as g from "../../src/git.ts";
import { localQueue } from "../../src/queue.ts";
import { addRunnerKey, storedDiff } from "../../src/remote.ts";
import { startServer } from "../../src/server.ts";
import { head, makeFixture } from "../fixture.ts";

const CLI = join(import.meta.dir, "../../src/cli.ts");

setDefaultTimeout(60_000);

// Edits app/main.txt as the agent; answers PASS as the verifier.
const FAKE_CLAUDE = `#!/bin/zsh
cat > /dev/null
out() { printf '{"type":"result","subtype":"success","is_error":false,"result":%s}\\n' "$1"; }
if [[ " $* " == *" Read,Grep "* ]]; then out '"VERDICT: PASS\\nEVIDENCE: main.txt has the line"'; exit 0; fi
echo more >> app/main.txt
out '"done"'
`;

function setup() {
  const fx = makeFixture({ "README.md": "hello\n", "app/main.txt": "v1\n" });
  const prod = join(fx.root, "prod");
  mkdirSync(prod);
  writeFileSync(join(prod, "VERSION"), `${head(fx.repo).slice(0, 7)} 2026-10-17 12:00\n`);
  const bin = join(fx.root, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  const recipe = {
    repo: fx.repo, deploy_group: "g1", scope_path: "app/", test_cmd: "test -f app/main.txt",
    deploy_cmd: `printf '%s 2026-10-18 09:00\\n' "$(git rev-parse --short HEAD)" > '${prod}/VERSION'`,
    targets: [{ name: "prod", live_version_cmd: `cat '${prod}/VERSION'` }],
  };

  // The queue's owner: its own recipes (another machine's paths), a request, a runner key, the server.
  const ownerHome = join(fx.root, "owner");
  mkdirSync(ownerHome);
  const db = openDb(join(ownerHome, "agentry.db"));
  db.query("INSERT INTO repos (name, path) VALUES ('repo', '/elsewhere/repo')").run();
  db.query("INSERT INTO deploy_groups (name) VALUES ('g1'), ('ios')").run();
  const ownerRecipe = (group: string) => JSON.stringify({ ...recipe, repo: "/elsewhere/repo", deploy_group: group });
  // Both may run on the attached machine ("mac"); it has a recipe only for p1.
  db.query("INSERT INTO projects (name, repo_id, deploy_group_id, recipe, runners) VALUES ('p1', 1, 1, ?, 'mac'), ('ios', 1, 2, ?, 'mac')")
    .run(ownerRecipe("g1"), ownerRecipe("ios"));
  const key = addRunnerKey(db, "mac");
  const srv = startServer({ db, home: ownerHome, port: 0 });
  const url = `http://127.0.0.1:${srv.server.port}`;

  // The attached machine: its own recipe for p1, none for ios.
  const home = join(fx.root, "runner");
  writeFileSync(join(fx.root, "recipe.json"), JSON.stringify(recipe));
  // Async: the server answers from this process while the CLI runs.
  const cli = async (stdin: string | undefined, ...args: string[]) => {
    const p = Bun.spawn(["bun", CLI, ...args], {
      env: { ...process.env, AGENTRY_HOME: home, AGENTRY_CLAUDE_BIN: bin }, stdout: "pipe", stderr: "pipe",
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  };
  return { fx, db, key, url, home, ownerHome, prod, bin, cli, stop: () => srv.stop() };
}

describe("a runner attached to another machine's queue", () => {
  test("works the owner's request with its own recipe; the owner gets the state, logs and diff", async () => {
    const h = setup();
    try {
      expect((await h.cli(undefined, "project", "add", "p1", join(h.fx.root, "recipe.json"))).code).toBe(0);
      const a = await h.cli(h.key, "attach", h.url);
      expect(a.err).toBe("");
      expect(a.out).toContain("It takes requests for p1");
      const id = A.addRequest(h.db, { projects: ["p1"], title: "Add a line", body: "Append to main.", doneWhen: "main.txt has a second line" });
      const ios = A.addRequest(h.db, { projects: ["ios"], title: "Not for this machine" });

      const r = await h.cli(undefined, "run", "--once");
      expect(r.out).toContain(`working the queue at ${h.url}`);
      expect(r.out).toContain(`#${id} → done  (deployed)`);

      expect(h.db.query("SELECT status FROM requests WHERE id = ?").get(id)).toEqual({ status: "done" });
      expect(h.db.query("SELECT status FROM requests WHERE id = ?").get(ios)).toEqual({ status: "queued" });
      const live = readFileSync(join(h.prod, "VERSION"), "utf8").split(" ")[0];
      expect(g.git(h.fx.origin, ["rev-parse", "main"]).out.startsWith(live)).toBe(true);
      expect(g.git(h.fx.origin, ["log", "-1", "--format=%B", "main"]).out).toContain(`Agentry-Request: #${id}`);

      const run = h.db.query("SELECT id, status, pgid FROM runs WHERE request_id = ?").get(id) as { id: number; status: string; pgid: number | null };
      expect(run).toMatchObject({ status: "passed", pgid: null });
      const steps = h.db.query("SELECT step, log_path FROM steps WHERE run_id = ? ORDER BY id").all(run.id) as { step: string; log_path: string }[];
      expect(steps.map((s) => s.step)).toEqual(["version", "agent", "test", "verify", "deploy", "version"]);
      for (const s of steps) {
        expect(s.log_path.startsWith(join(h.ownerHome, "runs", String(run.id)))).toBe(true);
        expect(existsSync(s.log_path)).toBe(true);
      }
      expect(readFileSync(steps[1].log_path, "utf8")).toContain('"result":"done"');
      expect(storedDiff(h.ownerHome, run.id)?.diff).toContain("+more");
      expect(h.db.query("SELECT COUNT(*) AS n FROM leases").get()).toEqual({ n: 0 });

      // Nothing of it in the runner's own database; its files under the queue's folder.
      const own = openDb(join(h.home, "agentry.db"));
      expect(own.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
      expect(existsSync(join(h.home, "queues", `127.0.0.1_${new URL(h.url).port}`, "runs", String(run.id)))).toBe(true);

      expect((await h.cli(undefined, "list")).out).toContain(`works the queue at ${h.url}`);
      expect((await h.cli(undefined, "detach")).code).toBe(0);
      expect(existsSync(join(h.home, "queue.json"))).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("attach refuses a key the owner doesn't know, and saves nothing", async () => {
    const h = setup();
    try {
      const r = await h.cli("agentry_rk_wrong", "attach", h.url);
      expect(r.code).toBe(1);
      expect(r.err).toContain("unknown runner key");
      expect(existsSync(join(h.home, "queue.json"))).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("while another runner holds the queue's lease, the runner waits for it instead of exiting", async () => {
    const h = setup();
    try {
      await h.cli(h.key, "attach", h.url);
      h.db.query("INSERT INTO leases (holder, token, pid, host, expires_at) VALUES ('mac', 'other', 4242, 'winhost', ?)").run(Date.now() + 60_000);
      const p = Bun.spawn(["bun", CLI, "run"], { env: { ...process.env, AGENTRY_HOME: h.home, AGENTRY_CLAUDE_BIN: h.bin }, stdout: "pipe", stderr: "pipe" });
      const reader = p.stdout.getReader();
      let out = "";
      while (!out.includes("waiting")) out += new TextDecoder().decode((await reader.read()).value);
      p.kill();
      await p.exited;
      expect(out).toContain("another runner holds the lease (pid 4242 on winhost");
    } finally {
      h.stop();
    }
  });

  test("a detach or attach while the runner runs switches queues without a restart", async () => {
    const h = setup();
    const p = Bun.spawn(["bun", CLI, "run"], { env: { ...process.env, AGENTRY_HOME: h.home, AGENTRY_CLAUDE_BIN: h.bin }, stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    const until = async (s: string) => {
      while (!out.includes(s)) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`the runner exited before "${s}":\n${out}`);
        out += decoder.decode(value, { stream: true });
      }
    };
    try {
      await until("working this machine's queue");
      h.db.query("INSERT INTO leases (holder, token, pid, host, expires_at) VALUES ('mac', 'other', 4242, 'winhost', ?)").run(Date.now() + 60_000);
      await h.cli(h.key, "attach", h.url);
      await until("switching queues");
      await until(`working the queue at ${h.url}`);
      await until("another runner holds the lease");
      const own = openDb(join(h.home, "agentry.db"));
      expect(own.query("SELECT COUNT(*) AS n FROM leases").get()).toEqual({ n: 0 });

      // Waiting for the owner's lease doesn't keep it from going back.
      out = "";
      expect((await h.cli(undefined, "detach")).code).toBe(0);
      await until("working this machine's queue");
      const ownLease = () => own.query("SELECT pid FROM leases WHERE holder = 'local'").get() as { pid: number } | null;
      for (let i = 0; i < 50 && ownLease()?.pid !== p.pid; i++) await Bun.sleep(100);
      expect(ownLease()).toEqual({ pid: p.pid });
    } finally {
      p.kill();
      await p.exited;
      h.stop();
    }
  });

  test("the runner API: a known key, a lease token, and only the queue's methods", async () => {
    const h = setup();
    try {
      const call = (method: string, args: unknown[], headers: Record<string, string>) =>
        fetch(`${h.url}/api/runner/call/${method}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(args) });
      const auth = { authorization: `Bearer ${h.key}`, "x-agentry-lease": "t1" };
      expect((await call("settings", [], {})).status).toBe(401);
      expect((await call("settings", [], { authorization: `Bearer ${h.key}` })).status).toBe(400);
      expect(await (await call("settings", [], auth)).json()).toEqual({ result: { paused: 0, pause_reason: null, workers: 1 } });
      for (const m of ["setPgid", "orphans", "copyAttachments", "constructor"]) expect((await call(m, [1, 1], auth)).status).toBe(404);
      // Writes are fenced by the lease, as a local runner's are.
      expect((await call("setStatus", [1, "done", null], auth)).status).toBe(409);
      expect(await (await call("acquire", [42, "machost", ["p1"]], auth)).json()).toEqual({ result: null });
      expect(h.db.query("SELECT host, pid, recipes FROM leases WHERE holder = 'mac'").get()).toEqual({ host: "machost", pid: 42, recipes: '["p1"]' });
      // The key decides the holder, and the holder gets only what is routed to it and it has recipes for.
      const ios = A.addRequest(h.db, { projects: ["ios"], title: "no recipe on mac" });
      const req = A.addRequest(h.db, { projects: ["p1"], title: "x" });
      expect((await (await call("claim", [], auth)).json()).result).toMatchObject({ id: req, status: "running" });
      expect(h.db.query("SELECT status, holder FROM requests WHERE id = ?").get(ios)).toEqual({ status: "queued", holder: null });
      const runId = (await (await call("startRun", [req, { attempt: 1, branch: "agentry/x-1", base: null, candidate: null }], auth)).json()).result;
      // Writes only to its own runs and requests (two-runners review D6).
      const other = Number(h.db.query("INSERT INTO runs (request_id, attempt, holder, started_at) VALUES (?, 1, 'local', 0)").run(ios).lastInsertRowid);
      expect((await call("setRun", [other, { base_sha: "x" }], auth)).status).toBe(409);
      expect((await call("setStatus", [ios, "done", null], auth)).status).toBe(409);
      expect((await call("finish", [{ runId, requestId: ios, runStatus: "passed", flags: [], status: "done", reason: null, requeue: null, pause: false, free: false, lock: null }], auth)).status).toBe(409);
      expect(h.db.query("SELECT status FROM requests WHERE id = ?").get(ios)).toEqual({ status: "queued" });
      // A step's log can only go to that run's folder here.
      expect((await call("beginStep", [runId, "agent", "/tmp/../../etc/x.log"], auth)).status).toBe(500);
      const stepId = (await (await call("beginStep", [runId, "agent", "/runner/runs/9/1-agent.log"], auth)).json()).result;
      expect((await call("saveLog", [stepId, "hello"], auth)).status).toBe(200);
      expect(readFileSync(join(h.ownerHome, "runs", String(runId), "1-agent.log"), "utf8")).toBe("hello");
    } finally {
      h.stop();
    }
  });

  test("on the owner, --runner names must exist, and a runner key can't be removed while projects list it (D4)", async () => {
    const h = setup();
    h.stop();
    const owner = async (...args: string[]) => {
      const p = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, AGENTRY_HOME: h.ownerHome }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, out, err };
    };
    const recipe = join(h.fx.root, "recipe.json");
    const typo = await owner("project", "add", "web", recipe, "--runner", "local,macea");
    expect(typo.code).toBe(1);
    expect(typo.err).toContain("no runner key named macea");
    const ok = await owner("project", "add", "web", recipe, "--runner", "local,mac");
    expect(ok.out).toContain("runs on local, mac");
    expect((await owner("project", "add", "web", recipe)).out).toContain("runs on local, mac"); // left out: kept
    const removal = await owner("runner-key", "remove", "mac");
    expect(removal.code).toBe(1);
    expect(removal.err).toContain("these projects still list mac: ios, p1, web");
  });

  test("each runner recovers only its own expired runs (two-runners review D3)", async () => {
    const h = setup();
    h.stop();
    const req = A.addRequest(h.db, { projects: ["p1"], title: "x" });
    const local = Number(h.db.query("INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, pgid, started_at) VALUES (?, 1, 'old', 1, 'b', 999, 0)").run(req).lastInsertRowid);
    const mac = Number(h.db.query("INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, holder, started_at) VALUES (?, 1, 'old', 1, 'b', 'mac', 0)").run(req).lastInsertRowid);
    expect((await localQueue(h.db, "new", h.ownerHome).expiredRuns(Date.now())).map((r) => r.id)).toEqual([local]);
    expect((await localQueue(h.db, "new", h.ownerHome, "mac").expiredRuns(Date.now())).map((r) => r.id)).toEqual([mac]);
    expect((await localQueue(h.db, "new", h.ownerHome, "mac").orphans()).map((r) => r.id)).toEqual([]);
  });
});
