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
  db.query("INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('p1', 1, 1, ?), ('ios', 1, 2, ?)").run(ownerRecipe("g1"), ownerRecipe("ios"));
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
      expect(h.db.query("SELECT owner_token FROM runner").get()).toEqual({ owner_token: null });

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
      h.db.query("UPDATE runner SET owner_token = 'other', owner_pid = 4242, owner_host = 'winhost', lease_expires_at = ?").run(Date.now() + 60_000);
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
      expect(await (await call("acquire", [42, "machost"], auth)).json()).toEqual({ result: null });
      expect(h.db.query("SELECT owner_host, owner_pid FROM runner").get()).toEqual({ owner_host: "machost", owner_pid: 42 });
      // A step's log can only go to that run's folder here.
      const req = A.addRequest(h.db, { projects: ["p1"], title: "x" });
      const runId = (await (await call("startRun", [req, { attempt: 1, branch: "agentry/x-1", base: null, candidate: null }], auth)).json()).result;
      expect((await call("beginStep", [runId, "agent", "/tmp/../../etc/x.log"], auth)).status).toBe(500);
      const stepId = (await (await call("beginStep", [runId, "agent", "/runner/runs/9/1-agent.log"], auth)).json()).result;
      expect((await call("saveLog", [stepId, "hello"], auth)).status).toBe(200);
      expect(readFileSync(join(h.ownerHome, "runs", String(runId), "1-agent.log"), "utf8")).toBe("hello");
    } finally {
      h.stop();
    }
  });

  test("an expired run with a process group recorded is left to the runner of its own machine", () => {
    const h = setup();
    h.stop();
    const req = A.addRequest(h.db, { projects: ["p1"], title: "x" });
    h.db.query("INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, pgid, started_at) VALUES (?, 1, 'old', 1, 'b', 999, 0)").run(req);
    h.db.query("INSERT INTO runs (request_id, attempt, lease_token, lease_expires_at, branch, started_at) VALUES (?, 1, 'old', 1, 'b', 0)").run(req);
    const q = localQueue(h.db, "new", h.ownerHome);
    return Promise.all([q.expiredRuns(Date.now()), q.expiredRuns(Date.now(), undefined, true)]).then(([all, remote]) => {
      expect(all.length).toBe(2);
      expect(remote.map((r) => r.pgid)).toEqual([null]);
    });
  });
});
