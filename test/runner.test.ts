// Runner paths from the test plan, against a fixture repo with a bare origin, a fake agent and verifier, and
// the real sandbox for build and test steps. "Production" is a directory holding a VERSION file.
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, openDb, runnerRow } from "../src/db.ts";
import * as g from "../src/git.ts";
import type { Recipe } from "../src/recipe.ts";
import type { AgentResult, Verdict } from "../src/adapters/types.ts";
import { checkDeployable, parseVersion, redeploy, runNext, startNext, type RunnerCtx, type RunOutcome, type Started } from "../src/runner.ts";
import { deployMain, requestRedeploy, resolve } from "../src/actions.ts";
import { saveUploads } from "../src/attachments.ts";
import { localQueue, unresolvedPushes } from "../src/queue.ts";
import { recover } from "../src/recovery.ts";
import { head, makeFixture } from "./fixture.ts";

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
  const initial = head(fx.repo);
  writeFileSync(join(prod, "VERSION"), `${initial.slice(0, 7)} 2026-10-17 12:00\n`);
  const db = openDb(join(home, "agentry.db"));
  acquireLease(db, "tok", process.pid);

  let agentFn = o.agent ?? editMain;
  let verdict: Verdict = o.verdict ?? { verdict: "PASS", evidence: "looks done" };
  const prompts: string[] = [];
  const ctx: RunnerCtx = {
    q: localQueue(db, "tok", home), home, pushBackoffMs: [10, 10], running: new Set(),
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
    expect(head(h.fx.repo)).toBe(h.initial);
    expect(g.git(h.fx.repo, ["status", "--porcelain"]).out).toBe("?? wip.txt");
    expect(await runNext(h.ctx)).toEqual({ kind: "idle" });
  });

  test("each run selects its request's own agent, or the queue's when it has none", async () => {
    const h = setup();
    const asked: (string | null | undefined)[] = [];
    const ctx: RunnerCtx = { ...h.ctx, selectAgent: async (agent) => { asked.push(agent); return h.ctx; } };
    const own = h.add();
    h.db.query("UPDATE requests SET ai_agent = 'codex' WHERE id = ?").run(own);
    await runNext(ctx);
    h.add();
    await runNext(ctx);
    expect(asked).toEqual(["codex", null]);
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

describe("runner: git that hangs (slice 2 review D12)", () => {
  test("a fetch that never answers ends as infra_error and pauses the runner, not a wedged runner", async () => {
    const h = setup();
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const saved = { ...g.timeouts };
    try {
      g.git(h.fx.repo, ["remote", "set-url", "origin", `http://127.0.0.1:${server.port}/repo.git`]);
      g.timeouts.network = 800;
      const id = h.add();
      await runNext(h.ctx);
      expect(h.req(id)).toMatchObject({ status: "queued", attempts: 0 });
      expect(runnerRow(h.db).pause_reason).toStartWith("git fetch failed");
    } finally { Object.assign(g.timeouts, saved); server.stop(true); }
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
    // A change outside the selected projects is never deployed, so the agent asks instead of making it.
    expect(h.prompts[1]).toContain("Change files only under app/. If the request needs a change");
    expect(h.prompts[1]).toContain("change nothing and reply with a\nsingle line `NEEDS_INFO:");
    expect(h.prompts[1]).toContain("do not edit build files");
  });

  test('a whole-repo project (scope_path "") gets no folder limit in the prompt and no out_of_scope flag', async () => {
    const h = setup({ recipe: { scope_path: "" }, agent: (wt) => { writeFileSync(join(wt, "README.md"), "changed\n"); } });
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id).status).toBe("done");
    expect(h.prompts[0]).toStartWith(`You are working on request #${id}.\nRules:`);
  });

  test("attached files reach the agent: copied into the run's temp dir and named in the prompt", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    let seen = null as Uint8Array | null;
    const h = setup({
      agent: (wt) => {
        const path = h.prompts.at(-1)!.match(/^- (\/.+\/attachments\/1\.png) \(shot\.png\)$/m)?.[1];
        if (path) seen = new Uint8Array(readFileSync(path)); // what the agent's Read tool would open
        editMain(wt);
      },
    });
    const id = h.add();
    saveUploads(h.db, h.ctx.home, id, [{ name: "shot.png", bytes: png }, { name: "brief.docx", bytes: new Uint8Array([1]) }],
      ["image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
    await runNext(h.ctx);
    expect(h.req(id).status).toBe("done");
    expect(h.prompts[0]).toContain("# Files attached to the request\nRead each one before you start");
    expect(h.prompts[0]).toMatch(/^- \/.+\/attachments\/2\.docx \(brief\.docx\): an Office file, a ZIP of XML\. Unpack it/m);
    expect(h.prompts[0]).toContain("and read word/document.xml");
    expect(seen).toEqual(png);
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
  test("a review flag → needs_review; approve resumes at build with the edits intact", async () => {
    const h = setup({ agent: (wt) => { writeFileSync(join(wt, "app/build.sh"), "echo hi\n"); } });
    const id = h.add();
    await runNext(h.ctx);
    const reviewed = h.lastRun(id);
    expect(h.req(id)).toMatchObject({ status: "needs_review", status_reason: "build_file: app/build.sh" });
    expect(JSON.parse(reviewed.flags)).toEqual([{ kind: "build_file", path: "app/build.sh" }]);
    expect(h.originHead()).toBe(h.initial);
    expect(h.worktrees()).toEqual([]);

    h.db.query("UPDATE requests SET status = 'queued', resume_run = ? WHERE id = ?").run(reviewed.id, id);
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "done", attempts: 1 });
    expect(h.prompts.length).toBe(1);
    expect(g.git(h.fx.origin, ["show", "main:app/build.sh"]).out).toBe("echo hi");
  });

  test("a change outside the selected projects → blocked_pre_push, and approval can't push it through", async () => {
    const h = setup({ agent: (wt) => { editMain(wt); mkdirSync(join(wt, "ios")); writeFileSync(join(wt, "ios/App.swift"), "x\n"); } });
    h.project("p-ios", { ...h.recipe, deploy_group: "g-ios", scope_path: "ios/" });
    const id = h.add();
    await runNext(h.ctx);
    const stopped = h.lastRun(id);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "changed files outside the selected projects: ios/App.swift (p-ios, not selected)" });
    expect(h.originHead()).toBe(h.initial);

    h.db.query("UPDATE requests SET status = 'queued', resume_run = ? WHERE id = ?").run(stopped.id, id);
    await runNext(h.ctx);
    expect(h.req(id).status).toBe("blocked_pre_push");
    expect(h.originHead()).toBe(h.initial);
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(h.initial.slice(0, 7));
  });

  test("build_unsandboxed builds outside the sandbox, after the files the agent left behind are cleaned", async () => {
    const h = setup({ agent: (wt) => { editMain(wt); mkdirSync(join(wt, "obj")); writeFileSync(join(wt, "obj/planted.targets"), "x\n"); } });
    // The user's checkout is unreadable from the sandbox; an ignored file the agent wrote must be gone.
    const build = `test ! -e obj/planted.targets && cat '${h.fx.repo}/README.md'`;
    h.db.query("UPDATE projects SET recipe = ?").run(JSON.stringify({ ...h.recipe, build_cmd: build, build_unsandboxed: true }));
    const id = h.add();
    await runNext(h.ctx);
    expect(h.req(id).status).toBe("done");
    h.db.query("UPDATE projects SET recipe = ?").run(JSON.stringify({ ...h.recipe, build_cmd: `cat '${h.fx.repo}/README.md'` }));
    const sandboxed = h.add();
    await runNext(h.ctx);
    expect(h.req(sandboxed)).toMatchObject({ status: "blocked_pre_push", status_reason: "build failed (exit 1)" });
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

  // Slice 2 review D10: before the fix, the redeploy run copied push_unknown and the resolver, which runs every
  // minute, set the deployed request back to blocked_post_push.
  test("a redeploy after push_unknown stays done: the resolver never reopens it", async () => {
    const h = setup();
    const hook = join(h.fx.origin, "hooks", "post-receive");
    writeFileSync(hook, `#!/bin/sh\nmv '${h.fx.origin}' '${h.fx.origin}.gone'\n`);
    chmodSync(hook, 0o755);
    const id = h.add();
    await runNext(h.ctx);
    renameSync(`${h.fx.origin}.gone`, h.fx.origin);
    rmSync(hook);
    expect(await redeploy(h.ctx, id)).toBe("done");
    expect(h.lastRun(id).push_state).toBe("pushed");
    expect(h.db.query("SELECT COUNT(*) AS n FROM runs WHERE request_id = ? AND push_state = 'push_unknown'").get(id)).toEqual({ n: 0 });
    expect(unresolvedPushes(h.db)).toEqual([]);
    await recover(h.ctx);
    expect(h.req(id).status).toBe("done");
    expect(h.group().lock).toBe("free");
  });

  test("a request resolved by hand after push_unknown is not reopened either", async () => {
    const h = setup();
    const hook = join(h.fx.origin, "hooks", "post-receive");
    writeFileSync(hook, `#!/bin/sh\nmv '${h.fx.origin}' '${h.fx.origin}.gone'\n`);
    chmodSync(hook, 0o755);
    const id = h.add();
    await runNext(h.ctx);
    renameSync(`${h.fx.origin}.gone`, h.fx.origin);
    resolve(h.db, id);
    expect(unresolvedPushes(h.db)).toEqual([]);
    await recover(h.ctx);
    expect(h.req(id).status).toBe("done_manual");
    expect(h.group().lock).toBe("free");
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

  // Winhost review D14: Re-run deploy never moves production backwards.
  function blockedAfterPush() {
    const h = setup();
    const deploy = h.recipe.deploy_cmd;
    h.recipe.deploy_cmd = `test -f '${h.prod}/allow' && ${deploy}`;
    h.db.query("UPDATE projects SET recipe = ?").run(JSON.stringify(h.recipe));
    return h;
  }
  const setLive = (h: ReturnType<typeof setup>, sha: string) => writeFileSync(join(h.prod, "VERSION"), `${sha.slice(0, 7)} 2026-10-19 08:00\n`);

  test("re-run deploy when a later commit containing it is already live: done, no deploy", async () => {
    const h = blockedAfterPush();
    const id = h.add();
    await runNext(h.ctx);
    const sha = h.lastRun(id).commit_sha;
    g.git(h.fx.repo, ["pull", "--quiet", "--ff-only", "origin", "main"]);
    h.pushFromUser("later.txt", "later\n");
    const later = h.originHead();
    setLive(h, later); // e.g. deployed from the Mac meanwhile
    writeFileSync(join(h.prod, "allow"), "");
    expect(await redeploy(h.ctx, id)).toBe("done");
    expect(h.req(id).status_reason).toBe(`deployed by a later commit that contains ${sha.slice(0, 7)}`);
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(later.slice(0, 7));
    expect(h.group().lock).toBe("free");
  });

  test("re-run deploy when the commit is already live: done, no deploy", async () => {
    const h = blockedAfterPush();
    const id = h.add();
    await runNext(h.ctx);
    const sha = h.lastRun(id).commit_sha;
    setLive(h, sha);
    expect(await redeploy(h.ctx, id)).toBe("done");
    expect(h.req(id).status_reason).toBe("already live");
  });

  test("re-run deploy that would replace an unrelated live commit is refused", async () => {
    const h = blockedAfterPush();
    const id = h.add();
    await runNext(h.ctx);
    const sha = h.lastRun(id).commit_sha;
    g.git(h.fx.repo, ["checkout", "--quiet", "-b", "side", h.initial]);
    h.fx.write("side.txt", "side\n");
    const side = h.fx.commit("side branch");
    setLive(h, side);
    writeFileSync(join(h.prod, "allow"), "");
    expect(await redeploy(h.ctx, id)).toBe("blocked_post_push");
    expect(h.req(id).status_reason).toBe(`prod runs ${side.slice(0, 7)}; deploying ${sha.slice(0, 7)} would roll it back`);
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(side.slice(0, 7));
    expect(h.group()).toMatchObject({ lock: "blocked", locked_by_request: id });
  });

  test("a queued re-run deploy is handled before new work, and its flag is cleared (slice 2 review D7)", async () => {
    const h = blockedAfterPush();
    const a = h.add();
    await runNext(h.ctx);
    const b = h.add();
    writeFileSync(join(h.prod, "allow"), "");
    requestRedeploy(h.db, a);
    expect(h.req(a)).toMatchObject({ status: "blocked_post_push", status_reason: "re-run deploy queued", redeploy_requested: 1 });
    expect(await runNext(h.ctx)).toEqual({ kind: "ran", requestId: a, status: "done" });
    expect(h.req(a).redeploy_requested).toBe(0);
    expect(await runNext(h.ctx)).toEqual({ kind: "ran", requestId: b, status: "done" });
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

describe("runner: deploy main without a change", () => {
  test("origin's main is built, tested and deployed as it is: no agent, no new commit", async () => {
    const h = setup();
    h.pushFromUser("app/main.txt", "v2 by hand\n");
    const main = h.originHead();
    const id = deployMain(h.db, "p1");
    expect(await runNext(h.ctx)).toEqual({ kind: "ran", requestId: id, status: "done" });
    expect(h.req(id)).toMatchObject({ status: "done", status_reason: "deployed" });
    expect(h.prompts).toEqual([]);
    expect(h.originHead()).toBe(main);
    expect(h.lastRun(id)).toMatchObject({ commit_sha: main, push_state: "pushed", status: "passed" });
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(main.slice(0, 7));
    expect(h.db.query("SELECT step FROM steps ORDER BY id").all().map((r: any) => r.step)).not.toContain("agent");
  });

  test("failing tests stop it before the deploy, and no agent is asked to repair them", async () => {
    const h = setup({ recipe: { test_cmd: "test -f app/missing.txt" } });
    const id = deployMain(h.db, "p1");
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "tests failed (exit 1)" });
    expect(h.prompts).toEqual([]);
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(h.initial.slice(0, 7));
  });

  test("main moved while it was built → stops; the older commit is never deployed", async () => {
    const h = setup();
    const q = h.ctx.q;
    const ctx: RunnerCtx = { ...h.ctx, q: { ...q, blockedGroup: async (groups) => { h.pushFromUser("other.txt", "x\n"); return q.blockedGroup(groups); } } };
    const id = deployMain(h.db, "p1");
    await runNext(ctx);
    expect(h.req(id).status).toBe("blocked_pre_push");
    expect(h.req(id).status_reason).toContain("moved to");
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(h.initial.slice(0, 7));
  });

  test("a project without a deploy_cmd ends as built", async () => {
    const h = setup({ recipe: { deploy_cmd: undefined, targets: undefined } });
    const id = deployMain(h.db, "p1");
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "done", status_reason: "built" });
    expect(h.originHead()).toBe(h.initial);
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

describe("runner: a request with several projects", () => {
  // A second project in the same repo: scope web/, its own group and "production" directory.
  function second(h: ReturnType<typeof setup>, r: Partial<Recipe> = {}) {
    const prod2 = join(h.fx.root, "prod2");
    mkdirSync(prod2);
    writeFileSync(join(prod2, "VERSION"), `${h.initial.slice(0, 7)} 2026-10-17 12:00\n`);
    const recipe: Recipe = {
      ...h.recipe, deploy_group: "g2", scope_path: "web/",
      deploy_cmd: `test ! -e '${prod2}/fail' && printf '%s 2026-10-18 09:00\\n' "$(git rev-parse --short HEAD)" > '${prod2}/VERSION'`,
      targets: [{ name: "prod2", live_version_cmd: `cat '${prod2}/VERSION'` }], ...r,
    };
    return { prod2, recipe, id: h.project("p2", recipe) };
  }
  const both = (h: ReturnType<typeof setup>, p2: number) => {
    const id = h.add();
    h.db.query("INSERT INTO request_projects (request_id, project_id) VALUES (?, ?)").run(id, p2);
    return id;
  };
  const editBoth: AgentFn = (wt) => { editMain(wt); mkdirSync(join(wt, "web"), { recursive: true }); writeFileSync(join(wt, "web/page.txt"), "page\n"); };
  const steps = (runId: number, step: string) => (h: ReturnType<typeof setup>) =>
    (h.db.query("SELECT log_path FROM steps WHERE run_id = ? AND step = ? ORDER BY id").all(runId, step) as { log_path: string }[]);

  test("both scopes are allowed, a shared test command runs once, and each project deploys in deploy_order", async () => {
    const h = setup({ agent: editBoth });
    const order = join(h.fx.root, "order");
    h.db.query("UPDATE projects SET recipe = ? WHERE name = 'p1'").run(JSON.stringify({ ...h.recipe, deploy_cmd: `${h.recipe.deploy_cmd} && echo p1 >> '${order}'` }));
    const p2 = second(h);
    p2.recipe.deploy_cmd += ` && echo p2 >> '${order}'`;
    p2.recipe.deploy_order = -1;
    h.db.query("UPDATE projects SET recipe = ? WHERE name = 'p2'").run(JSON.stringify(p2.recipe));
    const id = both(h, p2.id);
    await runNext(h.ctx);
    const run = h.lastRun(id);
    expect(h.req(id)).toMatchObject({ status: "done", status_reason: "deployed" });
    expect(readFileSync(order, "utf8")).toBe("p2\np1\n");
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(run.commit_sha.slice(0, 7));
    expect(readFileSync(join(p2.prod2, "VERSION"), "utf8")).toStartWith(run.commit_sha.slice(0, 7));
    expect(steps(run.id, "test")(h).length).toBe(1);
    expect(h.prompts[0]).toContain("Change files only under web/, app/.");
  });

  test("a shared deploy command runs once", async () => {
    const h = setup({ agent: editBoth });
    const p2 = second(h, { deploy_cmd: h.recipe.deploy_cmd, targets: h.recipe.targets });
    const id = both(h, p2.id);
    await runNext(h.ctx);
    expect(h.req(id).status).toBe("done");
    expect(steps(h.lastRun(id).id, "deploy")(h).length).toBe(1);
  });

  test("a failed deploy blocks only its group; the one before stays live, and re-run deploy ships just the failed one", async () => {
    const h = setup({ agent: editBoth });
    const p2 = second(h, { deploy_order: 1 });
    writeFileSync(join(p2.prod2, "fail"), "");
    const id = both(h, p2.id);
    await runNext(h.ctx);
    const sha = h.lastRun(id).commit_sha;
    expect(h.req(id)).toMatchObject({ status: "blocked_post_push", status_reason: "p2: deploy failed (exit 1)" });
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(sha.slice(0, 7));
    expect(h.group("g1")).toMatchObject({ lock: "free" });
    expect(h.group("g2")).toMatchObject({ lock: "blocked", locked_by_request: id, undeployed_sha: sha });

    rmSync(join(p2.prod2, "fail"));
    requestRedeploy(h.db, id);
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "done", status_reason: "deployed" });
    expect(steps(h.lastRun(id).id, "deploy")(h).length).toBe(1);
    expect(readFileSync(join(p2.prod2, "VERSION"), "utf8")).toStartWith(sha.slice(0, 7));
    expect(h.group("g2")).toMatchObject({ lock: "free", locked_by_request: null });
  });

  test("a request waits while any of its projects' groups is blocked", async () => {
    const h = setup({ agent: editBoth });
    const p2 = second(h);
    h.db.query("UPDATE deploy_groups SET lock = 'blocked', lock_reason = 'held' WHERE name = 'g2'").run();
    const id = both(h, p2.id);
    expect(await runNext(h.ctx)).toEqual({ kind: "idle" });
    expect(h.req(id).status).toBe("queued");
  });

  test("each project's test baseline is its own: a combined run doesn't raise a single project's", async () => {
    const h = setup({
      agent: editBoth, recipe: { test_cmd: "mkdir -p TestResults && cp app/trx.xml TestResults/a.trx", test_result_file: "TestResults/a.trx" },
      files: { "app/trx.xml": trx(["A", "B", "C"]), "web/trx.xml": trx(["W"]) },
    });
    const p2 = second(h, { test_cmd: "mkdir -p TestResults && cp web/trx.xml TestResults/w.trx", test_result_file: "TestResults/w.trx" });
    const combined = both(h, p2.id);
    await runNext(h.ctx);
    expect(h.req(combined)).toMatchObject({ status: "done" });
    expect(h.lastRun(combined).tests_total).toBe(4);
    h.setAgent(editMain);
    const alone = h.add();
    await runNext(h.ctx);
    expect(h.req(alone).status).toBe("done");
  });

  test("projects of different repositories in one request → blocked_pre_push before any work", async () => {
    const h = setup({ agent: editBoth });
    const p2 = second(h, { repo: join(h.fx.root, "elsewhere") });
    const id = both(h, p2.id);
    await runNext(h.ctx);
    expect(h.req(id)).toMatchObject({ status: "blocked_pre_push", status_reason: "p2 is not in the same repository and branch as p1" });
    expect(h.prompts).toEqual([]);
  });
});

describe("runner: several requests at once", () => {
  const done = (s: Started): Promise<RunOutcome> => {
    if (s.kind !== "started") throw new Error(`nothing started: ${s.kind}`);
    return s.done;
  };
  const requestOf = (prompt: string) => Number(prompt.match(/request #(\d+)/)![1]);
  // An agent that writes app/r<request>.txt, then waits for `wait(request)` before it finishes.
  function agentWaiting(h: ReturnType<typeof setup>, wait: (id: number) => Promise<unknown>) {
    h.ctx.agent = { async run(io) {
      const id = requestOf(io.prompt);
      writeFileSync(join(io.worktree, `app/r${id}.txt`), `${id}\n`);
      await wait(id);
      return { outcome: "finished" };
    } };
  }
  // Resolves once `n` agents are waiting on it: each agent finishes only when they all run at the same time.
  function barrier(n: number) {
    const all = Promise.withResolvers<void>();
    let arrived = 0;
    return () => { if (++arrived === n) all.resolve(); return all.promise; };
  }
  const subjects = (h: ReturnType<typeof setup>) => g.git(h.fx.origin, ["log", "--format=%B", "main"]).out;

  test("requests of different groups run side by side", async () => {
    const h = setup();
    const p2 = h.project("p2", { ...h.recipe, deploy_group: "g2", deploy_cmd: undefined, targets: undefined });
    agentWaiting(h, barrier(2));
    const a = h.add();
    const b = h.add({ project: p2 });
    const runs = [done(await startNext(h.ctx)), done(await startNext(h.ctx))];
    expect(h.ctx.running.size).toBe(2);
    expect(await startNext(h.ctx)).toEqual({ kind: "idle" });
    expect(await Promise.all(runs)).toEqual([{ kind: "ran", requestId: a, status: "done" }, { kind: "ran", requestId: b, status: "done" }]);
    expect(subjects(h)).toContain(`Agentry-Request: #${a}`);
    expect(subjects(h)).toContain(`Agentry-Request: #${b}`);
    expect(h.ctx.running.size).toBe(0);
    expect(h.worktrees()).toEqual([]);
  }, 30_000);

  test("requests of one group work at once, but push and deploy one at a time; the later one rebases", async () => {
    const h = setup();
    const log = join(h.fx.root, "deploys");
    h.recipe.deploy_cmd = `echo start >> '${log}' && sleep 1.5 && echo end >> '${log}' && ${h.recipe.deploy_cmd}`;
    h.db.query("UPDATE projects SET recipe = ?").run(JSON.stringify(h.recipe));
    agentWaiting(h, barrier(2));
    const a = h.add();
    const b = h.add();
    const outs = await Promise.all([done(await startNext(h.ctx)), done(await startNext(h.ctx))]);
    expect(outs.map((o) => o.kind === "ran" && o.status)).toEqual(["done", "done"]);
    expect(readFileSync(log, "utf8")).toBe("start\nend\nstart\nend\n");
    expect(subjects(h)).toContain(`Agentry-Request: #${a}`);
    expect(subjects(h)).toContain(`Agentry-Request: #${b}`);
    const live = h.originHead();
    expect(readFileSync(join(h.prod, "VERSION"), "utf8")).toStartWith(live.slice(0, 7));
    expect([h.lastRun(a).base_sha, h.lastRun(b).base_sha]).toContain(h.lastRun(live === h.lastRun(a).commit_sha ? b : a).commit_sha);
  }, 30_000);

  test("a request whose group was blocked while it ran stops before its push", async () => {
    const h = setup();
    h.recipe.deploy_cmd = `test ! -e app/fail.txt && ${h.recipe.deploy_cmd}`;
    h.db.query("UPDATE projects SET recipe = ?").run(JSON.stringify(h.recipe));
    const a = h.add();
    const b = h.add();
    let first: Promise<RunOutcome> | undefined;
    h.ctx.agent = { async run(io) {
      if (requestOf(io.prompt) === a) writeFileSync(join(io.worktree, "app/fail.txt"), "x\n");
      else { writeFileSync(join(io.worktree, "app/b.txt"), "b\n"); await first; }
      return { outcome: "finished" };
    } };
    first = done(await startNext(h.ctx));
    const second = done(await startNext(h.ctx));
    expect(await first).toEqual({ kind: "ran", requestId: a, status: "blocked_post_push" });
    expect(await second).toEqual({ kind: "ran", requestId: b, status: "blocked_pre_push" });
    expect(h.req(b).status_reason).toBe(`deploy group g1 (by #${a}) was blocked while this request ran; retry once it is free`);
    expect(h.lastRun(b).push_state).toBe("none");
    expect(h.originHead()).toBe(h.lastRun(a).commit_sha);
    expect(h.group()).toMatchObject({ lock: "blocked", locked_by_request: a });
  }, 30_000);
});

describe("parseVersion", () => {
  test("reads the SHA and the uncommitted marker", async () => {
    expect(parseVersion("abc1234 2026-10-17 12:00\n")).toEqual({ short: "abc1234", uncommitted: false });
    expect(parseVersion("warning: something\nabc1234+uncommitted 2026-10-17 12:00")).toEqual({ short: "abc1234", uncommitted: true });
    expect(parseVersion("not a version")).toBeNull();
  });
});

describe("checkDeployable (D6)", () => {
  test("refuses a wrong HEAD and a dirty tree", async () => {
    const fx = makeFixture();
    const wt = join(fx.root, "wt");
    await g.addWorktree(fx.repo, wt, "agentry/1-1", "main");
    const sha = head(wt);
    expect(await checkDeployable(wt, sha)).toBeNull();
    expect(await checkDeployable(wt, "0".repeat(40))).toContain("not the pushed");
    writeFileSync(join(wt, "README.md"), "dirty\n");
    expect(await checkDeployable(wt, sha)).toBe("worktree has uncommitted changes");
  });
});
