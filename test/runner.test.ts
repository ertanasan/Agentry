// Runner paths from the test plan, against a fixture repo with a bare origin, a fake agent and verifier, and
// the real sandbox for build and test steps. "Production" is a directory holding a VERSION file.
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, openDb, runnerRow } from "../src/db.ts";
import * as g from "../src/git.ts";
import type { Recipe } from "../src/recipe.ts";
import type { AgentResult, Verdict } from "../src/adapters/types.ts";
import { checkDeployable, parseVersion, redeploy, runNext, type RunnerCtx } from "../src/runner.ts";
import { makeFixture } from "./fixture.ts";

type AgentFn = (wt: string) => AgentResult | void;

const editMain: AgentFn = (wt) => { appendFileSync(join(wt, "app/main.txt"), "more\n"); };

function trx(names: string[], skipped = 0, failing: string[] = []): string {
  const results = names.map((n) => `<UnitTestResult testName="${n}" outcome="${failing.includes(n) ? "Failed" : "Passed"}" />`).join("\n");
  return `<TestRun><Results>${results}</Results><ResultSummary><Counters total="${names.length + skipped}" passed="${names.length - failing.length}" failed="${failing.length}" notExecuted="${skipped}" /></ResultSummary></TestRun>\n`;
}

function setup(o: { recipe?: Partial<Recipe>; files?: Record<string, string>; agent?: AgentFn; verdict?: Verdict } = {}) {
  const fx = makeFixture({ "README.md": "hello\n", "app/main.txt": "v1\n", ".gitignore": "obj/\nTestResults/\n", ...o.files });
  const home = join(fx.root, "agentry");
  const prod = join(fx.root, "prod");
  mkdirSync(home);
  mkdirSync(prod);
  const initial = g.headSha(fx.repo);
  writeFileSync(join(prod, "VERSION"), `${initial.slice(0, 7)} 2026-10-17 12:00\n`);
  const db = openDb(join(home, "agentry.db"));
  acquireLease(db, "tok", process.pid);

  let agentFn = o.agent ?? editMain;
  let verdict: Verdict = o.verdict ?? { verdict: "PASS", evidence: "looks done" };
  const prompts: string[] = [];
  const ctx: RunnerCtx = {
    db, token: "tok", home, pushBackoffMs: [10, 10], currentRun: null,
    agent: { async run(io) { prompts.push(io.prompt); return agentFn(io.worktree) ?? { outcome: "finished" }; } },
    verifier: { async verify() { return verdict; } },
  };
  const recipe: Recipe = {
    repo: fx.repo, deploy_group: "g1", scope_path: "app/", test_cmd: "test -f app/main.txt",
    deploy_cmd: `printf '%s 2026-10-18 09:00\\n' "$(git rev-parse --short HEAD)" > '${prod}/VERSION'`,
    targets: [{ name: "prod", live_version_cmd: `cat '${prod}/VERSION'` }],
    ...o.recipe,
  };
  db.query("INSERT INTO repos (name, path) VALUES ('repo', ?)").run(fx.repo);
  const project = (name: string, r: Recipe) => {
    db.query("INSERT OR IGNORE INTO deploy_groups (name) VALUES (?)").run(r.deploy_group);
    const group = db.query("SELECT id FROM deploy_groups WHERE name = ?").get(r.deploy_group) as { id: number };
    return Number(db.query("INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES (?, 1, ?, ?)").run(name, group.id, JSON.stringify(r)).lastInsertRowid);
  };
  const p1 = project("p1", recipe);
  const add = (r: { project?: number; done_when?: string; done_when_test?: string } = {}) => Number(db.query(
    "INSERT INTO requests (project_id, title, body, done_when, done_when_test, created_at, updated_at) VALUES (?, 'Change main', 'Make it v2.', ?, ?, ?, ?)",
  ).run(r.project ?? p1, r.done_when ?? null, r.done_when_test ?? null, Date.now(), Date.now()).lastInsertRowid);

  return {
    fx, db, ctx, prod, recipe, initial, prompts, project, add,
    setAgent: (f: AgentFn) => { agentFn = f; },
    setVerdict: (v: Verdict) => { verdict = v; },
    req: (id: number) => db.query("SELECT * FROM requests WHERE id = ?").get(id) as any,
    lastRun: (id: number) => db.query("SELECT * FROM runs WHERE request_id = ? ORDER BY id DESC LIMIT 1").get(id) as any,
    group: (name = "g1") => db.query("SELECT * FROM deploy_groups WHERE name = ?").get(name) as any,
    originHead: () => g.git(fx.origin, ["rev-parse", "main"]).out,
    worktrees: () => (existsSync(join(home, "worktrees")) ? readdirSync(join(home, "worktrees")) : []),
    // A commit pushed to origin by someone else.
    pushFromUser: (path: string, text: string) => { fx.write(path, text); fx.commit(`user: ${path}`); g.git(fx.repo, ["push", "--quiet", "origin", "main"]); },
  };
}

describe("runner: through to done", () => {
  test("a request is committed, pushed and deployed; origin, VERSION and the commit agree", async () => {
    const h = setup({ agent: (wt) => { editMain(wt); writeFileSync(join(wt, "app/new.txt"), "new\n"); } });
    h.fx.write("wip.txt", "user work in progress\n");
    const id = h.add();
    expect(await runNext(h.ctx)).toEqual({ kind: "ran", requestId: id, status: "done" });
    const run = h.lastRun(id);
    expect(h.req(id).status_reason).toBe("deployed");
    expect(run).toMatchObject({ status: "passed", push_state: "pushed", attempt: 1, branch: `agentry/${id}-1` });
    expect(h.originHead()).toBe(run.commit_sha);
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(run.commit_sha.slice(0, 7));
    expect(g.git(h.fx.origin, ["log", "-1", "--format=%B", "main"]).out).toBe(`Change main\n\nMake it v2.\n\nAgentry-Request: #${id}`);
    expect(g.git(h.fx.origin, ["show", "--name-only", "--format=", "main"]).out.split("\n").sort()).toEqual(["app/main.txt", "app/new.txt"]);
    expect(h.worktrees()).toEqual([]);
    expect(g.git(h.fx.repo, ["rev-parse", "--verify", "--quiet", `agentry/${id}-1`]).out).toBe(run.commit_sha);
    expect(g.headSha(h.fx.repo)).toBe(h.initial);
    expect(g.git(h.fx.repo, ["status", "--porcelain"]).out).toBe("?? wip.txt");
    expect(await runNext(h.ctx)).toEqual({ kind: "idle" });
  });

  test("without a deploy_cmd the request ends as built", async () => {
    const h = setup({ recipe: { deploy_cmd: undefined, targets: undefined } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "done", status_reason: "built" });
    expect(h.originHead()).toBe(h.lastRun(id).commit_sha);
  });

  test("ignored files written by sandboxed steps are gone before the unsandboxed deploy", async () => {
    const h = setup({ recipe: { test_cmd: "mkdir -p obj && touch obj/planted.targets" } });
    h.recipe.deploy_cmd = `test ! -e obj/planted.targets && ${h.recipe.deploy_cmd}`;
    h.db.query("UPDATE projects SET recipe = ?").run(JSON.stringify(h.recipe));
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id).status).toBe("done");
  });
});

describe("runner: agent outcomes", () => {
  test("an agent that rewrites the worktree's .git pointer → blocked_pre_push, nothing committed or pushed (D12)", async () => {
    const h = setup({ agent: (wt) => { editMain(wt); writeFileSync(join(wt, ".git"), "gitdir: /tmp/agent-owned/.git\n"); } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "worktree git metadata changed during the agent step" });
    expect(h.lastRun(id).candidate_sha).toBeNull();
    expect(h.originHead()).toBe(h.initial);
    expect(h.worktrees()).toEqual([]);
  });

  test("a test step that rewrites the pointer is caught too", async () => {
    const h = setup({ recipe: { test_cmd: "printf 'gitdir: /tmp/x\\n' > .git" } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "worktree git metadata changed during the test step" });
    expect(h.originHead()).toBe(h.initial);
  });

  test("needs_info stops with the question; the answer reaches the next attempt's prompt", async () => {
    const h = setup({ agent: () => ({ outcome: "needs_info", question: "Which endpoint?" }) });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "needs_info", status_reason: "Which endpoint?", attempts: 1 });
    expect(h.worktrees()).toEqual([]);
    expect(h.originHead()).toBe(h.initial);

    h.db.query("INSERT INTO events (ts, request_id, type, payload) VALUES (?, ?, 'answer', ?)").run(Date.now(), id, JSON.stringify({ text: "The /words one" }));
    h.db.query("UPDATE requests SET status = 'queued' WHERE id = ?").run(id);
    h.setAgent(editMain);
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "done", attempts: 2 });
    expect(h.lastRun(id).branch).toBe(`agentry/${id}-2`);
    expect(h.prompts[1]).toContain("The /words one");
    expect(h.prompts[1]).toContain("# Request: Change main");
    // Out-of-scope changes are allowed and gated by review (design step 4), never forbidden; build files stay off limits.
    expect(h.prompts[1]).toContain("Keep your changes under app/. If the request needs a change");
    expect(h.prompts[1]).toContain("sends\nthe change to human review");
    expect(h.prompts[1]).toContain("do not edit build files");
  });

  test("no changes → blocked_pre_push", async () => {
    const h = setup({ agent: () => {} });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "the agent made no changes" });
  });

  test("agent infra_error → queued without counting the attempt, runner paused", async () => {
    const h = setup({ agent: () => ({ outcome: "infra_error", detail: "usage limit reached" }) });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(runnerRow(h.db)).toMatchObject({ paused: 1, pause_reason: "agent: usage limit reached" });
    expect(h.lastRun(id).status).toBe("interrupted");
    expect(await runNext(h.ctx)).toEqual({ kind: "paused" });
  });
});

describe("runner: gates", () => {
  test("a change outside scope → needs_review; approve resumes at build with the edits intact", async () => {
    const h = setup({ agent: (wt) => { writeFileSync(join(wt, "README.md"), "edited\n"); } });
    const id = h.add();
    await runNext(h.ctx);
    const reviewed = h.lastRun(id);
    expect(h.req(id)).toMatchObject({ status: "needs_review", status_reason: "out_of_scope: README.md" });
    expect(JSON.parse(reviewed.flags)).toEqual([{ kind: "out_of_scope", path: "README.md" }]);
    expect(h.originHead()).toBe(h.initial);
    expect(h.worktrees()).toEqual([]);

    h.db.query("UPDATE requests SET status = 'queued', resume_run = ? WHERE id = ?").run(reviewed.id, id);
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "done", attempts: 1 });
    expect(h.prompts.length).toBe(1);
    expect(g.git(h.fx.origin, ["show", "main:README.md"]).out).toBe("edited");
  });

  test("failing tests → blocked_pre_push, nothing pushed", async () => {
    const h = setup({ recipe: { test_cmd: "test -f app/missing.txt" } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "tests failed (exit 1)" });
    expect(h.originHead()).toBe(h.initial);
    expect(h.lastRun(id).push_state).toBe("none");
  });

  test("a failing build → blocked_pre_push", async () => {
    const h = setup({ recipe: { build_cmd: "exit 3" } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "build failed (exit 3)" });
  });

  test("tests that change tracked files → blocked_pre_push", async () => {
    const h = setup({ recipe: { test_cmd: "echo more >> app/main.txt" } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "the tests changed tracked files" });
  });

  const trxRecipe = { test_cmd: "mkdir -p TestResults && cp app/trx.xml TestResults/r.trx", test_result_file: "TestResults/r.trx" };

  test("done_when_test passes only when a matching test ran and passed", async () => {
    const h = setup({ recipe: trxRecipe, files: { "app/trx.xml": trx(["Words.AddsWord", "Words.Lists"], 0, ["Words.Lists"]) } });
    const ok = h.add({ done_when_test: "AddsWord" });
    await runNext(h.ctx);
    expect(h.req(ok).status).toBe("done");
    const failing = h.add({ done_when_test: "Words.Lists" });
    await runNext(h.ctx);
    expect(h.req(failing)).toMatchObject({ status: "blocked_pre_push", status_reason: "done-when test did not pass: Words.Lists" });
    const missing = h.add({ done_when_test: "Nope" });
    await runNext(h.ctx);
    expect(h.req(missing).status_reason).toBe('no test matching "Nope" ran');
  });

  test("fewer tests than the last passing run → needs_review", async () => {
    const h = setup({ recipe: trxRecipe, files: { "app/trx.xml": trx(["A", "B", "C"]) } });
    const first = h.add();
    await runNext(h.ctx);
    expect(h.req(first).status).toBe("done");
    h.setAgent((wt) => { writeFileSync(join(wt, "app/trx.xml"), trx(["A", "B"])); });
    const second = h.add();
    await runNext(h.ctx);
    expect(h.req(second)).toMatchObject({ status: "needs_review", status_reason: "test_deleted: (test run) (tests 3 → 2)" });
  });

  test("verifier FAIL → blocked_pre_push with its evidence", async () => {
    const h = setup({ verdict: { verdict: "FAIL", evidence: "endpoint still returns 404" } });
    const id = h.add({ done_when: "GET /words returns 200" });
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "done-when not met: endpoint still returns 404" });
  });

  test("verifier infra_error → queued, attempt not counted, runner paused (D9)", async () => {
    const h = setup({ verdict: { verdict: "infra_error", evidence: "rate limited" } });
    const id = h.add({ done_when: "GET /words returns 200" });
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(runnerRow(h.db).pause_reason).toBe("verifier: rate limited");
  });
});

describe("runner: origin moves and push outcomes", () => {
  test("origin moved during the run → rebased, re-gated and pushed on top", async () => {
    const h = setup();
    h.setAgent((wt) => { editMain(wt); h.pushFromUser("other.txt", "x\n"); });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id).status).toBe("done");
    expect(h.originHead()).toBe(h.lastRun(id).commit_sha);
    expect(g.git(h.fx.origin, ["log", "--format=%s", "main"]).out.split("\n")).toEqual(["Change main", "user: other.txt", "initial"]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM steps WHERE step = 'test'").get()).toEqual({ n: 2 });
  });

  test("a rebase conflict → blocked_pre_push", async () => {
    const h = setup();
    h.setAgent((wt) => { editMain(wt); h.pushFromUser("app/main.txt", "theirs\n"); });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "rebase onto origin/main had conflicts" });
  });

  test("push rejected twice → blocked_pre_push; the remote state, not the exit code, decides", async () => {
    const h = setup();
    const hook = join(h.fx.origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "push rejected twice" });
    expect(h.lastRun(id).push_state).toBe("not_pushed");
    expect(h.group().lock).toBe("free");
  });

  test("origin unreachable after the push → push_unknown, group blocked, never requeued (D19)", async () => {
    const h = setup();
    const hook = join(h.fx.origin, "hooks", "post-receive");
    writeFileSync(hook, `#!/bin/sh\nmv '${h.fx.origin}' '${h.fx.origin}.gone'\n`);
    chmodSync(hook, 0o755);
    const id = h.add();
    await runNext(h.ctx);
    const run = h.lastRun(id);
    expect(h.req(id).status).toBe("blocked_post_push");
    expect(run.push_state).toBe("push_unknown");
    expect(h.group()).toMatchObject({ lock: "blocked", locked_by_request: id, undeployed_sha: run.commit_sha });
    renameSync(`${h.fx.origin}.gone`, h.fx.origin);
    expect(h.originHead()).toBe(run.commit_sha);
  });
});

describe("runner: deploy", () => {
  test("a failed deploy blocks only its own group; other groups keep running", async () => {
    const h = setup({ recipe: { deploy_cmd: "exit 1" } });
    const p2 = h.project("p2", { ...h.recipe, deploy_group: "g2", deploy_cmd: undefined, targets: undefined });
    const id = h.add();
    await runNext(h.ctx);
    const run = h.lastRun(id);
    expect(h.req(id)).toMatchObject({ status: "blocked_post_push", status_reason: "deploy failed (exit 1)" });
    expect(h.group()).toMatchObject({ lock: "blocked", locked_by_request: id, undeployed_sha: run.commit_sha });
    expect(h.worktrees()).toEqual([]);

    const sameGroup = h.add();
    const other = h.add({ project: p2 });
    expect(await runNext(h.ctx)).toEqual({ kind: "ran", requestId: other, status: "done" });
    expect(await runNext(h.ctx)).toEqual({ kind: "idle" });
    expect(h.req(sameGroup).status).toBe("queued");
  });

  test("re-run deploy from a fresh worktree at the pushed commit unblocks the group", async () => {
    const h = setup();
    const deploy = h.recipe.deploy_cmd;
    h.recipe.deploy_cmd = `test -f '${h.prod}/allow' && ${deploy}`;
    h.db.query("UPDATE projects SET recipe = ?").run(JSON.stringify(h.recipe));
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id).status).toBe("blocked_post_push");
    const sha = h.lastRun(id).commit_sha;

    writeFileSync(join(h.prod, "allow"), "");
    expect(await redeploy(h.ctx, id)).toBe("done");
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(sha.slice(0, 7));
    expect(h.group()).toMatchObject({ lock: "free", locked_by_request: null, undeployed_sha: null });
    expect(h.worktrees()).toEqual([]);
  });

  test("a busy remote, or one that can't be checked, refuses the deploy (D18)", async () => {
    const h = setup({ recipe: { remote_busy_cmd: "exit 0" } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_post_push", status_reason: "previous install still running on the target" });
    expect(h.originHead()).toBe(h.lastRun(id).commit_sha);

    h.recipe.remote_busy_cmd = "exit 255";
    h.db.query("UPDATE projects SET recipe = ?").run(JSON.stringify(h.recipe));
    expect(await redeploy(h.ctx, id)).toBe("blocked_post_push");
    expect(h.req(id).status_reason).toBe("could not check for a running install (exit 255)");
  });

  test("a deploy timeout → blocked_post_push, remote state unknown (D8)", async () => {
    const h = setup({ recipe: { deploy_cmd: "sleep 30", timeouts_s: { deploy: 1 } } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_post_push", status_reason: "deploy timed out: remote state unknown" });
  });

  test("a target still running the old commit after deploy → blocked_post_push", async () => {
    const h = setup({ recipe: { deploy_cmd: "true" } });
    const id = h.add();
    await runNext(h.ctx);
    const sha = h.lastRun(id).commit_sha;
    expect(h.req(id)).toMatchObject({ status: "blocked_post_push", status_reason: `prod runs ${h.initial.slice(0, 7)}, expected ${sha.slice(0, 7)}` });
  });
});

describe("runner: drift guard (D5, D10, C1)", () => {
  const cases: [string, (h: ReturnType<typeof setup>) => string, string][] = [
    ["an unknown commit", () => "deadbeef 2026-10-17 12:00", "can't read live version of prod: unknown or ambiguous commit deadbeef"],
    ["uncommitted changes", (h) => `${h.initial.slice(0, 7)}+uncommitted 2026-10-17 12:00`, "+uncommitted"],
    ["a commit that is not on origin", (h) => { h.fx.write("local.txt", "x\n"); return `${h.fx.commit("local only").slice(0, 7)} 2026-10-17 12:00`; }, "not on origin/main"],
    ["no VERSION line", () => "", "no VERSION line in the output"],
  ];
  for (const [name, version, reason] of cases) {
    test(`production running ${name} blocks the group; the request stays queued`, async () => {
      const h = setup();
      writeFileSync(join(h.prod, "VERSION"), version(h) + "\n");
      const id = h.add();
      await runNext(h.ctx);
      expect(h.req(id)).toMatchObject({ status: "queued", attempts: 0 });
      expect(h.req(id).status_reason).toContain(reason);
      expect(h.group()).toMatchObject({ lock: "blocked", locked_by_request: null });
      expect(h.group().lock_reason).toContain(reason);
      expect(runnerRow(h.db).paused).toBe(0);
      expect(h.prompts.length).toBe(0);
      expect(await runNext(h.ctx)).toEqual({ kind: "idle" });
    });
  }
});

describe("parseVersion", () => {
  test("reads the SHA and the uncommitted marker", () => {
    expect(parseVersion("abc1234 2026-10-17 12:00\n")).toEqual({ short: "abc1234", uncommitted: false });
    expect(parseVersion("warning: something\nabc1234+uncommitted 2026-10-17 12:00")).toEqual({ short: "abc1234", uncommitted: true });
    expect(parseVersion("not a version")).toBeNull();
  });
});

describe("checkDeployable (D6)", () => {
  test("refuses a wrong HEAD and a dirty tree", () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    const sha = g.headSha(wt);
    expect(checkDeployable(wt, sha)).toBeNull();
    expect(checkDeployable(wt, "0".repeat(40))).toContain("not the pushed");
    writeFileSync(join(wt, "README.md"), "dirty\n");
    expect(checkDeployable(wt, sha)).toBe("worktree has uncommitted changes");
  });
});
