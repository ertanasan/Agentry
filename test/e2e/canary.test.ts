// Sandbox canary (slice-1 exit test, eng review D4, D14). Runs commands through the real sandbox-exec profile
// against the real home folder. The agent step's Bash runs as a child of `claude` under the same profile, so
// these checks cover the agent step and the test step alike. Reads go to /dev/null: nothing is printed even
// if a check fails.
// The keychain and ssh-agent checks talk to those services, so they only run with AGENTRY_CANARY_SECRETS=1.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runStep } from "../../src/proc.ts";
import { sandbox } from "../../src/sandbox.ts";
import { addWorktree, git } from "../../src/git.ts";
import { makeFixture } from "../fixture.ts";

const fx = makeFixture();
const wt = join(fx.root, "wt");
addWorktree(fx.repo, wt, "agentry/1-1", "main");
const runTmp = join(fx.root, "run-tmp");
const pkgCache = join(fx.root, "pkg-cache");
const claudeBin = Bun.which("claude") ?? undefined;
const sb = sandbox({ worktree: wt, runTmp, pkgCache, gitDir: join(fx.repo, ".git"), claudeBin, keyHelper: join(fx.root, "key-helper") });
const home = homedir();
let n = 0;

async function inSandbox(command: string): Promise<{ code: number; out: string }> {
  const logPath = join(fx.root, "logs", `${++n}.log`);
  const r = await runStep(command, { cwd: wt, logPath, timeoutMs: 30_000, wrap: sb.wrap, env: sb.env });
  return { code: r.exitCode, out: readFileSync(logPath, "utf8") };
}

async function expectDenied(command: string) {
  const r = await inSandbox(command);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("Operation not permitted");
}

describe("sandbox canary: blocked", () => {
  for (const d of [".ssh", ".config", ".docker", ".aws", ".agentry", "Library/Keychains"]) {
    test.if(existsSync(join(home, d)))(`~/${d} cannot be listed`, () => expectDenied(`ls '${join(home, d)}' >/dev/null`));
  }

  test.if(existsSync(join(home, ".ssh")))("ssh keys cannot be read", async () => {
    // The names are guessed, because the directory cannot be listed. At least one must exist outside.
    const keys = ["id_ed25519", "id_rsa", "id_ecdsa"].map((k) => join(home, ".ssh", k)).filter(existsSync);
    for (const k of keys) await expectDenied(`head -c 1 '${k}' >/dev/null`);
  });

  test("the user's own checkout cannot be read", () => expectDenied(`head -c 1 '${join(fx.repo, "README.md")}' >/dev/null`));

  test("writes outside the worktree fail", async () => {
    const outside = [join(home, `agentry-canary-${process.pid}`), `/private/tmp/agentry-canary-${process.pid}`];
    for (const p of outside) {
      await expectDenied(`touch '${p}'`);
      expect(existsSync(p)).toBe(false);
    }
  });

  test("local unix sockets cannot be reached (ssh agent)", async () => {
    const path = `/private/tmp/agentry-canary-${process.pid}.sock`;
    const server = Bun.listen({ unix: path, socket: { data() {} } });
    try {
      // The marker is built at run time because a traceback echoes the source line.
      const r = await inSandbox(`python3 -I -c 'import socket; s = socket.socket(socket.AF_UNIX); s.connect("${path}"); print("CONN" + "ECTED")'`);
      expect(r.out).not.toContain("CONNECTED");
      expect(r.out).toContain("Operation not permitted");
    } finally { server.stop(true); if (existsSync(path)) unlinkSync(path); }
  });

  test("the environment is scrubbed", async () => {
    const r = await inSandbox("env");
    expect(r.out).not.toContain("SSH_AUTH_SOCK");
    expect(r.out).toContain(`HOME=${sb.env.HOME}`);
  });
});

describe.if(process.env.AGENTRY_CANARY_SECRETS === "1")("sandbox canary: keychain and ssh agent", () => {
  // The sandbox keeps securityd reachable for .NET's TLS, so this is the check that the login keychain itself
  // still refuses a sandboxed caller. The keychain is named explicitly, because the sandbox's temp HOME could
  // leave the search list empty and make "not found" look like a refusal.
  test("the login keychain cannot be queried", async () => {
    const keychain = join(home, "Library/Keychains/login.keychain-db");
    const r = await inSandbox(`security find-generic-password -s "Claude Code-credentials" '${keychain}' >/dev/null 2>&1`);
    expect(r.code).not.toBe(0);
  });

  test("the running ssh agent cannot be reached", async () => {
    // ssh-add -l exits 2 when it cannot talk to the agent (1 would mean it connected and found no keys).
    const r = await inSandbox(`SSH_AUTH_SOCK=$(launchctl getenv SSH_AUTH_SOCK) ssh-add -l >/dev/null 2>&1`);
    expect(r.code).toBe(2);
  });
});

describe("sandbox canary: allowed", () => {
  test("the worktree is writable and readable", async () => {
    const r = await inSandbox("echo canary > made-in-sandbox.txt && cat made-in-sandbox.txt");
    expect(r.code).toBe(0);
    expect(readFileSync(join(wt, "made-in-sandbox.txt"), "utf8")).toBe("canary\n");
  });

  test("git works in the worktree", async () => {
    writeFileSync(join(wt, "README.md"), "changed\n");
    const r = await inSandbox("git status --porcelain --untracked-files=no");
    expect(r.code).toBe(0);
    expect(r.out).toContain("M README.md");
    git(wt, ["checkout", "--", "README.md"]);
  }, 20_000); // the first git call of a run fills xcrun's cache (~2 s)

  test("the package cache and the run's temp dir are writable", async () => {
    const r = await inSandbox(`touch "$NUGET_PACKAGES/x" "$TMPDIR/x" "$HOME/x" "$CLAUDE_CONFIG_DIR/x"`);
    expect(r.code).toBe(0);
  });

  test.if(!!claudeBin)("claude starts", async () => {
    const r = await inSandbox(`'${claudeBin}' --version`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Claude Code");
  });
});
