// The CLI end to end (T10): every user flow from the test plan through `bun src/cli.ts`, against a fixture repo with
// a bare origin, the real sandbox and a fake `claude`. The fake reads its prompt and acts on a MODE: marker in the
// request body; called as the verifier (--tools Read,Grep) it answers PASS unless the body says MODE:badverify.
// "Production" is a directory with a VERSION file; deploy fails while prod/fail exists.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, openDb } from "../../src/db.ts";
import * as g from "../../src/git.ts";
import { makeFixture } from "../fixture.ts";

const CLI = join(import.meta.dir, "../../src/cli.ts");

// Each test spawns several CLI processes; under load they outlast the 5 s default.
setDefaultTimeout(30_000);

const FAKE_CLAUDE = `#!/bin/zsh
prompt=$(cat)
out() { printf '{"type":"result","subtype":"success","is_error":%s,"result":%s}\\n' "$1" "$2"; }
if [[ " $* " == *" Read,Grep "* ]]; then
  if [[ $prompt == *MODE:badverify* ]]; then out false '"VERDICT: FAIL\\nEVIDENCE: main.txt is unchanged where it matters"'
  else out false '"VERDICT: PASS\\nEVIDENCE: main.txt has the line"'; fi
  exit 0
fi
case $prompt in
  *MODE:infra*) out true '"usage limit reached"'; exit 1 ;;
  *MODE:noop*) ;;
  *MODE:ask*)
    if [[ $prompt != *"# Answers to your earlier questions"*"use main.txt"* ]]; then out false '"NEEDS_INFO: Which file?"'; exit 0; fi
    echo more >> app/main.txt ;;
  *MODE:outside*) echo more >> README.md ;;
  *) echo more >> app/main.txt ;;
esac
out false '"done"'
`;

function setup() {
  const fx = makeFixture({ "README.md": "hello\n", "app/main.txt": "v1\n" });
  const home = join(fx.root, "agentry");
  const prod = join(fx.root, "prod");
  mkdirSync(prod);
  writeFileSync(join(prod, "VERSION"), `${g.headSha(fx.repo).slice(0, 7)} 2026-10-17 12:00\n`);
  const bin = join(fx.root, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  const recipe = {
    repo: fx.repo, deploy_group: "g1", scope_path: "app/", test_cmd: "test -f app/main.txt",
    deploy_cmd: `test ! -e '${prod}/fail' && printf '%s 2026-10-18 09:00\\n' "$(git rev-parse --short HEAD)" > '${prod}/VERSION'`,
    targets: [{ name: "prod", live_version_cmd: `cat '${prod}/VERSION'` }],
  };
  writeFileSync(join(fx.root, "recipe.json"), JSON.stringify(recipe));

  const cli = (...args: string[]) => cliIn(undefined, ...args);
  const cliIn = (stdin: string | undefined, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], {
      env: { ...process.env, AGENTRY_HOME: home, AGENTRY_CLAUDE_BIN: bin }, stdout: "pipe", stderr: "pipe",
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const ok = (...args: string[]) => {
    const r = cli(...args);
    if (r.code !== 0) throw new Error(`agentry ${args.join(" ")} exited ${r.code}: ${r.err}`);
    return r.out;
  };
  expect(ok("project", "add", "p1", join(fx.root, "recipe.json"))).toContain("project p1");
  const db = openDb(join(home, "agentry.db"));
  return {
    fx, home, prod, cli, cliIn, ok, db,
    add: (title: string, ...flags: string[]) => Number(ok("add", "p1", title, ...flags).match(/#(\d+) queued/)![1]),
    req: (id: number) => db.query("SELECT * FROM requests WHERE id = ?").get(id) as any,
    group: () => db.query("SELECT * FROM deploy_groups WHERE name = 'g1'").get() as any,
    originHead: () => g.git(fx.origin, ["rev-parse", "main"]).out,
    live: () => readFileSync(join(prod, "VERSION"), "utf8").split(" ")[0],
  };
}

describe("agentry CLI, end to end", () => {
  test("add → run: committed, pushed, deployed; reopen counts a false-done", () => {
    const h = setup();
    const id = h.add("Add a line", "--body", "Append to main.", "--done-when", "main.txt has a second line");
    expect(h.ok("run", "--once")).toContain(`#${id} → done  (deployed)`);
    expect(h.originHead().startsWith(h.live())).toBe(true);
    expect(g.git(h.fx.origin, ["log", "-1", "--format=%B", "main"]).out).toContain(`Agentry-Request: #${id}`);
    expect(h.ok("list")).toContain("nothing open");
    expect(h.ok("list", "--all")).toContain(`#${id}`);

    const out = h.ok("reopen", String(id), "the line is in the wrong place");
    const reopened = Number(out.match(/#(\d+) queued/)![1]);
    expect(h.req(reopened)).toMatchObject({ reopened_from: id, status: "queued", title: `Reopened #${id}: Add a line` });
    expect(h.req(id)).toMatchObject({ status: "done", status_reason: "deployed" });
    expect(h.ok("list")).toContain("false-done: 1");
  });

  test("a second runner refuses while the lease is live; so does redeploy", () => {
    const h = setup();
    acquireLease(h.db, "someone-else", 4242);
    const r = h.cli("run", "--once");
    expect(r.code).toBe(1);
    expect(r.err).toContain("another runner holds the lease (pid 4242");
    expect(h.cli("redeploy", "1").err).toContain("another runner holds the lease");
  });

  test("needs_info → answer → the answer reaches the next attempt, which finishes", () => {
    const h = setup();
    const id = h.add("Ambiguous", "--body", "MODE:ask");
    expect(h.ok("run", "--once")).toContain(`#${id} → needs_info  (Which file?)`);
    h.ok("answer", String(id), "use main.txt");
    expect(h.ok("run", "--once")).toContain(`#${id} → done`);
    expect(h.req(id).attempts).toBe(2);
  });

  test("needs_review → reject cancels; approve resumes on the kept branch and ships the reviewed change", () => {
    const h = setup();
    const a = h.add("Touch the readme", "--body", "MODE:outside");
    const b = h.add("Touch the readme too", "--body", "MODE:outside");
    expect(h.ok("run", "--once")).toMatch(new RegExp(`#${a} → needs_review[\\s\\S]*#${b} → needs_review`));
    h.ok("reject", String(a));
    expect(h.req(a)).toMatchObject({ status: "canceled", status_reason: "rejected" });
    h.ok("approve", String(b));
    expect(h.ok("run", "--once")).toContain(`#${b} → done`);
    expect(h.req(b).attempts).toBe(1);
    expect(g.git(h.fx.origin, ["show", "--name-only", "--format=", "main"]).out).toBe("README.md");
  });

  test("blocked_pre_push → retry with a new body runs a new attempt on a new branch", () => {
    const h = setup();
    const id = h.add("Nothing to do", "--body", "MODE:noop");
    expect(h.ok("run", "--once")).toContain(`#${id} → blocked_pre_push  (the agent made no changes)`);
    h.ok("retry", String(id), "--body", "Append to main.");
    expect(h.ok("run", "--once")).toContain(`#${id} → done`);
    expect(g.git(h.fx.repo, ["rev-parse", "--verify", "--quiet", `agentry/${id}-2`]).code).toBe(0);
  });

  test("a FAIL verdict blocks before push with the verifier's evidence", () => {
    const h = setup();
    const id = h.add("Judge me", "--body", "MODE:badverify", "--done-when", "main.txt has the line in section 2");
    expect(h.ok("run", "--once")).toContain(`#${id} → blocked_pre_push  (done-when not met: main.txt is unchanged where it matters)`);
    expect(h.originHead()).toBe(g.headSha(h.fx.repo));
  });

  test("blocked_post_push blocks the group; redeploy ships it and frees the group for the waiting request", () => {
    const h = setup();
    writeFileSync(join(h.prod, "fail"), "");
    const a = h.add("First");
    expect(h.ok("run", "--once")).toContain(`#${a} → blocked_post_push  (deploy failed (exit 1))`);
    expect(h.group()).toMatchObject({ lock: "blocked", locked_by_request: a });
    const b = h.add("Second");
    h.ok("run", "--once");
    expect(h.req(b).status).toBe("queued");
    expect(h.ok("list")).toContain(`group g1 blocked by #${a}`);

    rmSync(join(h.prod, "fail"));
    expect(h.ok("redeploy", String(a))).toContain(`#${a} → done`);
    expect(h.group().lock).toBe("free");
    expect(h.ok("run", "--once")).toContain(`#${b} → done`);
    expect(h.originHead().startsWith(h.live())).toBe(true);
  });

  test("resolve marks a post-push block done_manual and frees the group", () => {
    const h = setup();
    writeFileSync(join(h.prod, "fail"), "");
    const id = h.add("Deploy breaks");
    h.ok("run", "--once");
    h.ok("resolve", String(id));
    expect(h.req(id)).toMatchObject({ status: "done_manual", status_reason: "resolved by hand" });
    expect(h.group()).toMatchObject({ lock: "free", locked_by_request: null });
  });

  test("an infra error requeues without counting and pauses the runner; resume unpauses; cancel ends it", () => {
    const h = setup();
    const id = h.add("Out of quota", "--body", "MODE:infra");
    expect(h.ok("run", "--once")).toContain("runner paused: agent: usage limit reached");
    expect(h.req(id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.ok("list")).toContain("runner paused");
    h.ok("resume");
    expect(h.ok("list")).not.toContain("runner paused");
    h.ok("cancel", String(id));
    expect(h.req(id).status).toBe("canceled");
  });

  test("actions refuse requests in the wrong state", () => {
    const h = setup();
    const id = h.add("Queued");
    const r = h.cli("approve", String(id));
    expect(r.code).toBe(1);
    expect(r.err).toContain(`#${id} is queued; this needs needs_review`);
    expect(h.cli("resolve", String(id)).err).toContain("this needs blocked_post_push");
    expect(h.cli("reopen", String(id), "x").err).toContain("reopen needs done");
    expect(h.cli("answer", "999", "x").err).toContain("no request #999");
  });

  test("token saves a wrapped setup-token token with mode 600 and refuses anything else", () => {
    const h = setup();
    const file = join(h.home, "claude-oauth-token");
    const bad = h.cliIn("pbpaste | tr -d ' \\n' > ~/.agentry/claude-oauth-token\n", "token");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("nothing saved");
    expect(h.cliIn("sk-ant-oat01-first-half-\n EbtrEAAA\n", "token").out).toContain("saved 32 characters");
    expect(readFileSync(file, "utf8")).toBe("sk-ant-oat01-first-half-EbtrEAAA\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("unblock clears a lock no request holds (drift guard), and only that kind", () => {
    const h = setup();
    h.db.query("UPDATE deploy_groups SET lock = 'blocked', lock_reason = 'prod runs abc1234, not on origin/main'").run();
    h.ok("unblock", "g1");
    expect(h.group().lock).toBe("free");
    expect(h.cli("unblock", "g1").code).toBe(1);
  });
});
