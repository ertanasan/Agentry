// The verifier eval (eng review D11): runs the real claude verifier, sandboxed, on each labeled case and must
// score 10/10 before slice 1's exit test counts.
//   bun run eval:verifier             uses ~/.agentry/claude-oauth-token (subscription) if present, else
//                                     ~/.agentry/api-key-helper (or AGENTRY_KEY_HELPER); 10 verifier calls
//   bun run eval:verifier --dry-run   builds every case and prints its diff, no API calls
// AGENTRY_VERIFIER_MODEL picks the model (default: claude's own default).
// Each case is a throwaway repo: the base snapshot committed, then the case's edits committed on top.
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/git.ts";
import { timeoutMs, type Recipe } from "../../src/recipe.ts";
import { KEY_HELPER, sandbox } from "../../src/sandbox.ts";
import { OAUTH_TOKEN_FILE, resolveAuth } from "../../src/adapters/claude.ts";
import { claudeVerifier } from "../../src/verifier.ts";
import { CASES, type Case } from "./cases.ts";

const dry = process.argv.includes("--dry-run");

function build(c: Case, root: string): { repo: string; diff: string } {
  const repo = join(root, "repo");
  cpSync(join(import.meta.dir, "base"), repo, { recursive: true });
  const run = (args: string[]) => { const r = git(repo, args); if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.err}`); return r.out; };
  run(["init", "--quiet", "-b", "main"]);
  run(["-c", "user.email=eval@agentry", "-c", "user.name=eval", "add", "-A"]);
  run(["-c", "user.email=eval@agentry", "-c", "user.name=eval", "commit", "--quiet", "-m", "base"]);
  for (const e of c.edits) {
    const path = join(repo, e.path);
    const text = readFileSync(path, "utf8");
    const hits = text.split(e.find).length - 1;
    if (hits !== 1) throw new Error(`${c.name}: edit anchor found ${hits} times in ${e.path}: ${e.find.slice(0, 60)}`);
    writeFileSync(path, text.replace(e.find, () => e.replace));
  }
  run(["-c", "user.email=eval@agentry", "-c", "user.name=eval", "commit", "--quiet", "-am", c.title]);
  return { repo, diff: run(["diff", "--no-color", "HEAD~1", "HEAD"]) };
}

const keyHelper = process.env.AGENTRY_KEY_HELPER ?? KEY_HELPER;
const auth = resolveAuth(OAUTH_TOKEN_FILE, keyHelper);
const claude = Bun.which("claude");
if (!dry) {
  if (auth.kind === "api_key" && !existsSync(keyHelper)) {
    console.error(`No ${OAUTH_TOKEN_FILE} (run \`claude setup-token\` and save its token there, chmod 600) and no API key helper at ${keyHelper}.`);
    process.exit(2);
  }
  console.log(`auth: ${auth.kind}`);
  if (!claude) { console.error("claude is not on PATH"); process.exit(2); }
}
const verifier = claude ? claudeVerifier({ bin: realpathSync(claude), auth, model: process.env.AGENTRY_VERIFIER_MODEL }) : null;
const verifyTimeout = timeoutMs({} as Recipe, "verify");

let right = 0;
for (const c of CASES) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentry-eval-")));
  let keep = false; // a missed case keeps its repo and log for a look
  try {
    const { repo, diff } = build(c, root);
    if (dry) {
      console.log(`\n=== ${c.name} (expect ${c.expected}${c.flaw ? `, ${c.flaw}` : ""})\n${diff}`);
      continue;
    }
    const sbx = sandbox({ worktree: repo, runTmp: join(root, "tmp"), gitDir: join(repo, ".git"), claudeBin: realpathSync(claude!), keyHelper });
    const v = await verifier!.verify({
      worktree: repo, logPath: join(root, "verify.log"), timeoutMs: verifyTimeout, sandbox: sbx, onStart: () => {},
      title: c.title, body: c.body, doneWhen: c.doneWhen, diff, testSummary: c.testSummary,
    });
    const ok = v.verdict === c.expected;
    if (ok) right++;
    keep = !ok;
    console.log(`${ok ? "ok  " : "MISS"} ${c.name.padEnd(32)} expected ${c.expected}, got ${v.verdict}${c.flaw ? ` (${c.flaw})` : ""}`);
    if (!ok) console.log(`     ${v.evidence.replaceAll("\n", " ").slice(0, 400)}\n     log: ${join(root, "verify.log")}`);
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}
if (dry) process.exit(0);
console.log(`\n${right}/${CASES.length}`);
process.exit(right === CASES.length ? 0 : 1);
