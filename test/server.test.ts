// The web UI over real HTTP (winhost design "Server"): passkey sign-up and sign-in with a software passkey, the
// Host / Origin / session guards, actions through actions.ts with the user as actor, escaping of request text
// and logs, the bounded log tail, sign-in throttling and the security headers.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addUser } from "../src/accounts.ts";
import { openDb, runnerRow } from "../src/db.ts";
import { suggestedWorkers } from "../src/platform.ts";
import { startServer } from "../src/server.ts";
import { settingsPage } from "../src/views.ts";
import { makeFixture } from "./fixture.ts";
import { SoftPasskey } from "./helpers/passkey.ts";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

async function setup() {
  const fx = makeFixture({ "README.md": "hello\n", "app/main.txt": "v1\n" });
  const home = join(fx.root, "agentry");
  mkdirSync(home);
  const db = openDb(join(home, "agentry.db"));
  db.query("INSERT INTO repos (name, path) VALUES ('r', ?)").run(fx.repo);
  db.query("INSERT INTO deploy_groups (name) VALUES ('g1')").run();
  db.query("INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('vt-web', 1, 1, ?)")
    .run(JSON.stringify({ repo: fx.repo, deploy_group: "g1", scope_path: "app/", test_cmd: "true" }));
  const srv = startServer({ db, home, port: 0 });
  stops.push(srv.stop);
  const url = srv.url;

  const call = (path: string, o: { method?: string; json?: unknown; form?: Record<string, string>; multipart?: FormData; cookie?: string; origin?: string | null; host?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (o.cookie) headers.cookie = o.cookie;
    if (o.origin !== null && (o.method ?? "GET") === "POST") headers.origin = o.origin ?? url;
    if (o.host) headers.host = o.host;
    let body: string | undefined;
    if (o.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.json); }
    if (o.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(o.form).toString(); }
    return fetch(url + path, { method: o.method ?? "GET", headers, body: o.multipart ?? body, redirect: "manual" });
  };
  const sessionOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];

  // Registers `name` over HTTP with a fresh software passkey; returns the session cookie and the passkey.
  async function signUp(name = "ertan", role: "owner" | "admin" = "owner") {
    const code = addUser(db, name, role);
    expect((await call(`/register/${code}`)).status).toBe(200);
    const options = await (await call(`/register/${code}/options`, { method: "POST", json: {} })).json();
    const key = await SoftPasskey.create();
    const r = await call(`/register/${code}/verify`, { method: "POST", json: await key.register(options, url) });
    expect(r.status).toBe(200);
    return { cookie: sessionOf(r), key };
  }

  async function signIn(key: SoftPasskey) {
    const o = await call("/login/options", { method: "POST", json: {} });
    const challenge = o.headers.get("set-cookie")!.split(";")[0];
    const r = await call("/login/verify", { method: "POST", json: await key.login(await o.json(), url), cookie: challenge });
    return r;
  }

  return { fx, db, home, url, call, signUp, signIn, sessionOf };
}

describe("sign-up and sign-in", () => {
  test("a one-time link registers a passkey; the session opens the home page", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const home = await h.call("/", { cookie });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("New request");
  });

  test("while this machine's runner works another queue, the home page points there and takes no new requests", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const standalone = await (await h.call("/", { cookie })).text();
    expect(standalone).toContain("Runner offline");
    expect(standalone).toContain('action="/requests"');

    writeFileSync(join(h.home, "queue.json"), JSON.stringify({ url: "https://winhost.example.ts.net", key: "agentry_rk_x" }));
    const page = await (await h.call("/", { cookie })).text();
    const link = '<a href="https://winhost.example.ts.net">winhost</a>';
    // One band says it all: where to go instead, and how to come back.
    expect(page).toContain(`This machine's runner works <strong>${link}</strong>'s queue`);
    expect(page).toContain('(<a href="https://winhost.example.ts.net/settings">its settings</a>)');
    expect(page).toContain("<code>agentry detach</code> on this machine brings back its own queue.");
    expect(page).not.toContain("Runner offline");
    expect(page).not.toContain("0 running, 0 queued"); // this machine's own queue isn't worked while attached
    expect(page).not.toContain('action="/requests"');
    const r = await h.call("/requests", { method: "POST", cookie, form: { project: "vt-web", title: "Here anyway" } });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("file the request there");
    expect(h.db.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 });

    // The runner settings are the other machine's: shown read-only here, and refused.
    const settings = await (await h.call("/settings", { cookie })).text();
    expect(settings).toContain(`Pause and workers are set on ${link}`);
    expect(settings).toContain('<a href="https://winhost.example.ts.net/settings">change them there</a>');
    expect(settings).not.toContain('id="workers"');
    const pause = await h.call("/settings/pause", { method: "POST", cookie });
    expect(pause.status).toBe(409);
    expect(runnerRow(h.db).paused).toBe(0);
  });

  test("a passkey signs in again later; sign-out revokes the session", async () => {
    const h = await setup();
    const { key } = await h.signUp();
    const r = await h.signIn(key);
    expect(r.status).toBe(200);
    const cookie = h.sessionOf(r);
    expect((await h.call("/", { cookie })).status).toBe(200);
    expect((await h.call("/logout", { method: "POST", cookie })).status).toBe(303);
    expect((await h.call("/", { cookie })).headers.get("location")).toBe("/login");
  });

  test("session cookies are HttpOnly and SameSite=Strict", async () => {
    const h = await setup();
    const { key } = await h.signUp();
    const set = (await h.signIn(key)).headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
  });

  test("ten failed sign-ins from one address → 429", async () => {
    const h = await setup();
    await h.signUp();
    const stranger = await SoftPasskey.create();
    for (let i = 0; i < 10; i++) expect((await h.signIn(stranger)).status).toBe(401);
    expect((await h.call("/login/options", { method: "POST", json: {} })).status).toBe(429);
  });

  test("an unknown registration link shows an error page", async () => {
    const h = await setup();
    expect((await h.call(`/register/${"x".repeat(43)}`)).status).toBe(404);
  });
});

describe("guards (slice 2 review D9)", () => {
  test("without a session: pages redirect to /login, posts get 401", async () => {
    const h = await setup();
    expect((await h.call("/")).headers.get("location")).toBe("/login");
    expect((await h.call("/requests", { method: "POST", form: { project: "vt-web", title: "x" } })).status).toBe(401);
  });

  test("an unknown Host is refused (DNS rebinding)", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    expect((await h.call("/", { cookie, host: "evil.example:4747" })).status).toBe(421);
  });

  test("a POST from another origin, or without one, is refused even with a valid session", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const form = { project: "vt-web", title: "sneaky" };
    expect((await h.call("/requests", { method: "POST", form, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await h.call("/requests", { method: "POST", form, cookie, origin: null })).status).toBe(403);
    expect(h.db.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 });
  });

  test("pages carry a strict Content-Security-Policy", async () => {
    const h = await setup();
    const csp = (await h.call("/login")).headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("pages link the icons, before sign-in too", async () => {
    const h = await setup();
    const login = await (await h.call("/login")).text();
    expect(login).toContain('<link rel="icon" href="/static/icon.png"');
    expect(login).toContain('<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">');
    expect((await h.call("/static/apple-touch-icon.png")).headers.get("content-type")).toBe("image/png");
  });
});

describe("actions", () => {
  test("capture queues a request recorded with the user as actor", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const r = await h.call("/requests", { method: "POST", cookie, form: { project: "vt-web", title: "Two idioms", body: "b", done_when: "it shows two" } });
    expect(r.status).toBe(303);
    expect(h.db.query("SELECT title, status, done_when FROM requests").get()).toEqual({ title: "Two idioms", status: "queued", done_when: "it shows two" });
    expect(h.db.query("SELECT actor FROM events WHERE type = 'add'").get()).toEqual({ actor: "user:ertan" });
  });

  test("a request can name several projects of one repo, never projects of different repos or none", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const recipe = (scope: string) => JSON.stringify({ repo: h.fx.repo, deploy_group: "g1", scope_path: scope, test_cmd: "true" });
    h.db.query("INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('vt-ios', 1, 1, ?)").run(recipe("ios/"));
    h.db.query("INSERT INTO repos (name, path) VALUES ('other', '/other')").run();
    h.db.query("INSERT INTO projects (name, repo_id, deploy_group_id, recipe) VALUES ('habit', 2, 1, ?)").run(recipe("x/"));
    const post = (projects: string[]) => {
      const form = new URLSearchParams([...projects.map((p) => ["project", p]), ["title", "t"]]);
      return fetch(h.url + "/requests", { method: "POST", redirect: "manual", body: form, headers: { cookie, origin: h.url, "content-type": "application/x-www-form-urlencoded" } });
    };
    expect((await post(["vt-web", "vt-ios"])).status).toBe(303);
    expect(h.db.query("SELECT p.name FROM request_projects rp JOIN projects p ON p.id = rp.project_id WHERE rp.request_id = 1 ORDER BY p.name").all())
      .toEqual([{ name: "vt-ios" }, { name: "vt-web" }]);
    expect(await (await h.call("/", { cookie })).text()).toContain('<span class="num">#1</span><span>vt-web, vt-ios</span>');
    // Refused: the form comes back open with the reason and what was typed.
    const mixed = await post(["vt-web", "habit"]);
    expect(mixed.status).toBe(400);
    const again = await mixed.text();
    expect(again).toContain('role="alert">the projects of one request must share a repository');
    expect(again).toContain('<details class="new" open>');
    expect(again).toContain('value="vt-web" checked');
    expect(again).toContain('value="habit" checked');
    expect(again).toMatch(/id="title"[^>]* value="t"/);
    expect((await post([])).status).toBe(400);
    expect(h.db.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 1 });
  });

  test("an action on the wrong state is refused with the reason; an unknown request is 404", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    await h.call("/requests", { method: "POST", cookie, form: { project: "vt-web", title: "x" } });
    const r = await h.call("/requests/1/approve", { method: "POST", cookie });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("#1 is queued; this needs needs_review");
    expect((await h.call("/requests/99/cancel", { method: "POST", cookie })).status).toBe(404);
  });

  test("Re-run deploy from the UI queues it for the runner (slice 2 review D7)", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.query("INSERT INTO requests (project_id, title, status, created_at, updated_at) VALUES (1, 'blocked', 'blocked_post_push', 0, 0)").run();
    h.db.query("INSERT INTO runs (request_id, attempt, commit_sha, started_at) VALUES (1, 1, 'abc', 0)").run();
    expect((await h.call("/requests/1/redeploy", { method: "POST", cookie })).status).toBe(303);
    expect(h.db.query("SELECT status, redeploy_requested FROM requests").get()).toEqual({ status: "blocked_post_push", redeploy_requested: 1 });
  });

  test("a drift lock appears in Needs you and Unblock clears it", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.query("UPDATE deploy_groups SET lock = 'blocked', lock_reason = 'prod runs abc+uncommitted'").run();
    expect(await (await h.call("/", { cookie })).text()).toContain("Deploy group g1 is blocked:</strong> prod runs abc+uncommitted");
    expect((await h.call("/groups/g1/unblock", { method: "POST", cookie })).status).toBe(303);
    expect(h.db.query("SELECT lock FROM deploy_groups").get()).toEqual({ lock: "free" });
  });

  test("with several runners, the home page lists each and says which runner a queued request waits for", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.exec("INSERT INTO runner_keys (name, key_hash, created_at) VALUES ('machost', 'h', 0); UPDATE projects SET runners = 'machost'");
    h.db.query("INSERT INTO leases (holder, token, pid, host, expires_at) VALUES ('local', 't', 1, 'winhost', ?)").run(Date.now() + 60_000);
    await h.call("/requests", { method: "POST", cookie, form: { project: "vt-web", title: "for the mac" } });
    const page = await (await h.call("/", { cookie })).text();
    expect(page).toContain("winhost online");
    expect(page).toContain("machost offline");
    expect(page).toContain('<span class="st attn"><i aria-hidden="true"></i></span>waiting for machost</p>');
    expect(page).toContain('<div class="alert attn"><div class="what">machost is offline: 1 request waits.</div></div>');
  });

  test("the status line names what each runner works on, and running rows say which runner has them", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.query("INSERT INTO leases (holder, token, pid, host, expires_at) VALUES ('local', 't', 1, 'winhost', ?)").run(Date.now() + 60_000);
    h.db.exec(`INSERT INTO requests (project_id, title, status, holder, created_at, updated_at) VALUES (1, 'busy', 'running', 'local', 0, 0);
      INSERT INTO runs (request_id, attempt, status, current_step, holder, started_at) VALUES (1, 1, 'running', 'build', 'local', 0);`);
    const page = await (await h.call("/", { cookie })).text();
    expect(page).toContain('Runner online on winhost · <a href="/runs/1">#1 Build</a>');
    expect(page).toContain("<span>on winhost</span>");
  });

  test("check flags show on the request's card and before the actions on its run page", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const flags = JSON.stringify([{ kind: "test_deleted", path: "T.cs", detail: "Paging" }, { kind: "skip_added", path: "T.cs" }]);
    h.db.query("INSERT INTO requests (project_id, title, status, status_reason, created_at, updated_at) VALUES (1, 'x', 'blocked_pre_push', 'tests failed', 0, 0)").run();
    h.db.query("INSERT INTO runs (request_id, attempt, status, flags, started_at) VALUES (1, 1, 'failed', ?, 0)").run(flags);
    expect(await (await h.call("/", { cookie })).text()).toContain('<i aria-hidden="true"></i>2 check flags</span>');
    const run = await (await h.call("/runs/1", { cookie })).text();
    expect(run.indexOf("2 check flags")).toBeGreaterThan(0);
    expect(run.indexOf("2 check flags")).toBeLessThan(run.indexOf(">Retry</button>"));
    expect(run).toContain("test deleted: <span class=\"mono\">T.cs</span> (Paging)");
  });

  test("a question's answer form is folded behind Answer…, beside Cancel", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.query("INSERT INTO requests (project_id, title, status, status_reason, created_at, updated_at) VALUES (1, 'x', 'needs_info', 'Which game?', 0, 0)").run();
    const home = await (await h.call("/", { cookie })).text();
    expect(home).toContain('<div class="actions"><details class="answer"><summary class="btn primary">Answer…</summary>');
    expect(home).toMatch(/<\/details>\s*<details class="confirm danger"><summary class="btn danger">Cancel…/);
    expect((await h.call("/requests/1/answer", { method: "POST", cookie, form: { text: "Fill in the blank" } })).status).toBe(303);
  });

  test("approving asks once more and names the push and deploy", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.query("INSERT INTO requests (project_id, title, status, created_at, updated_at) VALUES (1, 'x', 'needs_review', 0, 0)").run();
    const home = await (await h.call("/", { cookie })).text();
    expect(home).toContain('<details class="confirm go"><summary class="btn">Approve…</summary>');
    expect(home).toContain("Approve #1? Its changes, including those outside the request&#39;s scope, go on to build and tests, then are pushed and deployed (g1).");
  });

  test("an action ends on the home page saying what it did; only known confirmations show", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const added = await h.call("/requests", { method: "POST", cookie, form: { project: "vt-web", title: "x" } });
    expect(added.headers.get("location")).toBe("/?done=added&id=1");
    expect(await (await h.call("/?done=added&id=1", { cookie })).text()).toContain('<p class="flash ok" role="status">#1 is queued.</p>');
    const cancel = await h.call("/requests/1/cancel", { method: "POST", cookie });
    expect(cancel.headers.get("location")).toBe("/?done=cancel&id=1");
    for (const q of ["?done=hacked&id=1", "?done=cancel&id=x", "?done=constructor"]) {
      expect(await (await h.call(`/${q}`, { cookie })).text()).not.toContain('class="flash');
    }
  });

  test("a request waiting on a failed deploy offers to re-run it, naming the commit and its group", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.query("INSERT INTO requests (project_id, title, status, created_at, updated_at) VALUES (1, 'blocked', 'blocked_post_push', 0, 0)").run();
    h.db.query("INSERT INTO runs (request_id, attempt, commit_sha, started_at) VALUES (1, 1, 'abc1234def', 0)").run();
    expect(await (await h.call("/", { cookie })).text()).toContain(">Re-run deploy of abc1234 to g1</button>");
  });
});

describe("escaping (slice 2 review Q1)", () => {
  test("request text and step logs render as text, never as markup", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    await h.call("/requests", { method: "POST", cookie, form: { project: "vt-web", title: "<script>alert(1)</script>" } });
    const home = await (await h.call("/", { cookie })).text();
    expect(home).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(home).not.toContain("<script>alert(1)");

    const log = join(h.home, "runs", "1", "1-agent.log");
    mkdirSync(join(h.home, "runs", "1"), { recursive: true });
    writeFileSync(log, `<img src=x onerror="alert(2)">\n`);
    h.db.query("INSERT INTO runs (id, request_id, attempt, status, started_at) VALUES (1, 1, 1, 'failed', 0)").run();
    h.db.query("INSERT INTO steps (run_id, step, started_at, ended_at, exit_code, log_path) VALUES (1, 'agent', 0, 1, 0, ?)").run(log);
    const page = await (await h.call("/runs/1", { cookie })).text();
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
    expect(page).not.toContain("<img src=x");
  });

  test("a running run's live part returns only the last 64 KiB of the log, and keeps polling", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.query("INSERT INTO requests (project_id, title, status, created_at, updated_at) VALUES (1, 't', 'running', 0, 0)").run();
    const log = join(h.home, "runs", "1", "1-build.log");
    mkdirSync(join(h.home, "runs", "1"), { recursive: true });
    writeFileSync(log, "x".repeat(500_000) + "\nTHE END\n");
    h.db.query("INSERT INTO runs (id, request_id, attempt, status, started_at) VALUES (1, 1, 1, 'running', 0)").run();
    h.db.query("INSERT INTO steps (run_id, step, started_at, log_path) VALUES (1, 'build', 0, ?)").run(log);
    const r = await h.call("/runs/1/live", { cookie });
    const body = await r.text();
    expect(body).toContain("THE END");
    expect(body.length).toBeLessThan(70_000);
    expect(body).toContain('hx-trigger="every 2s"'); // still running → keeps polling
  });

  test("the home page's lists refresh from /live with the status line, never the new-request form", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const home = await (await h.call("/", { cookie })).text();
    expect(home).toContain('<div id="board" hx-get="/live" hx-trigger="every 5s" hx-swap="outerHTML">');
    expect(home).toContain('<script src="/static/htmx.js"></script>');

    await h.call("/requests", { method: "POST", cookie, form: { project: "vt-web", title: "<b>moved on</b>" } });
    const live = await (await h.call("/live", { cookie })).text();
    expect(live).toContain('id="statusbar" role="status" hx-swap-oob="true"');
    expect(live).toContain("0 running, 1 queued");
    expect(live).toContain('<div id="board" hx-get="/live"');
    expect(live).toContain("&lt;b&gt;moved on&lt;/b&gt;");
    expect(live).not.toContain('action="/requests"');
    expect((await h.call("/live")).status).toBe(303); // signed in only
  });
});

// The first bytes are all the server looks at; the rest only gives the files a size.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7)]);
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), ...new Array(200).fill(7)]);

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => typeof p === "string" ? [...new TextEncoder().encode(p)] : p)) as Uint8Array<ArrayBuffer>;
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const PDF = bytes("%PDF-1.7\n1 0 obj\n", [0xe2, 0xe3, 0xcf, 0xd3], "\n%%EOF\n");
// What an Office file's ZIP holds by name: its parts are listed uncompressed.
const DOCX = bytes(ZIP, "[Content_Types].xml", [0, 1, 2], "word/document.xml", [0, 9]);

describe("attached files", () => {
  const requestForm = (files: [Uint8Array<ArrayBuffer>, string][], title = "Fix the search box") => {
    const f = new FormData();
    f.set("project", "vt-web"); f.set("title", title); f.set("body", "see the screenshot");
    for (const [bytes, name] of files) f.append("files", new File([bytes], name));
    return f;
  };

  test("a new request keeps its images; they show as thumbnails and are served signed-in only, as images", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    expect((await h.call("/requests", { method: "POST", cookie, multipart: requestForm([[PNG, "shot.png"]]) })).status).toBe(303);
    expect(h.db.query("SELECT request_id, name, mime, size FROM attachments").get()).toEqual({ request_id: 1, name: "shot.png", mime: "image/png", size: PNG.length });
    expect(existsSync(join(h.home, "attachments", "1", "1.png"))).toBe(true);
    expect(await (await h.call("/", { cookie })).text()).toContain('<img src="/attachments/1"');

    const r = await h.call("/attachments/1", { cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
    expect((await h.call("/attachments/1")).headers.get("location")).toBe("/login");
    expect((await h.call("/attachments/9", { cookie })).status).toBe(404);
  });

  test("PDF, Office and text files are kept; PDF and Office download, text shows as plain text", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const json = bytes('{"word": "über"}\n');
    const files: [Uint8Array<ArrayBuffer>, string][] = [[PDF, "spec.pdf"], [DOCX, "brief notes.docx"], [json, "data.json"]];
    expect((await h.call("/requests", { method: "POST", cookie, multipart: requestForm(files) })).status).toBe(303);
    expect(h.db.query("SELECT name, mime FROM attachments ORDER BY id").all()).toEqual([
      { name: "spec.pdf", mime: "application/pdf" },
      { name: "brief notes.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { name: "data.json", mime: "text/plain" },
    ]);
    for (const f of ["1.pdf", "2.docx", "3.json"]) expect(existsSync(join(h.home, "attachments", "1", f))).toBe(true);
    const home = await (await h.call("/", { cookie })).text();
    expect(home).toContain('<a class="file" href="/attachments/2">brief notes.docx</a>');

    const docx = await h.call("/attachments/2", { cookie });
    expect(docx.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''brief%20notes.docx");
    expect((await h.call("/attachments/1", { cookie })).headers.get("content-type")).toBe("application/pdf");
    const text = await h.call("/attachments/3", { cookie });
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("content-disposition")).toBe("inline");
    expect(await text.text()).toBe('{"word": "über"}\n');
  });

  test("markup sent as a file is kept as text, never served as a page", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const svg = bytes("<svg onload=alert(1)>");
    expect((await h.call("/requests", { method: "POST", cookie, multipart: requestForm([[svg, "evil.png"]]) })).status).toBe(303);
    expect(existsSync(join(h.home, "attachments", "1", "1.txt"))).toBe(true);
    expect(await (await h.call("/", { cookie })).text()).not.toContain('<img src="/attachments/1"');
    const r = await h.call("/attachments/1", { cookie });
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("archives, executables, old Office files and HEIC photos are refused, and no request is created", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const refused = async (file: Uint8Array<ArrayBuffer>, name: string) => {
      const r = await h.call("/requests", { method: "POST", cookie, multipart: requestForm([[PNG, "ok.png"], [file, name]]) });
      expect(r.status).toBe(400);
      return r.text();
    };
    expect(await refused(bytes(ZIP, "notes.txt", [0, 0]), "notes.zip")).toContain("notes.zip is an archive");
    expect(await refused(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], [0, 0, 0]), "old.doc")).toContain("old.doc is an old Office file");
    expect(await refused(bytes("MZ", [0x90, 0, 3, 0]), "setup.exe")).toContain("setup.exe is not a supported file");
    expect(await refused(bytes([0xff, 0xfe, 0xfd]), "blob.bin")).toContain("blob.bin is not a supported file");
    expect(await refused(HEIC, "IMG_1.HEIC")).toContain("IMG_1.HEIC is a HEIC photo");
    expect(h.db.query("SELECT (SELECT COUNT(*) FROM requests) AS r, (SELECT COUNT(*) FROM attachments) AS a").get()).toEqual({ r: 0, a: 0 });
  });

  test("at most 5 files per request, counting those sent with answers", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const six = Array.from({ length: 6 }, (_, i) => [PNG, `s${i}.png`] as [Uint8Array<ArrayBuffer>, string]);
    expect((await h.call("/requests", { method: "POST", cookie, multipart: requestForm(six) })).status).toBe(400);

    await h.call("/requests", { method: "POST", cookie, multipart: requestForm(six.slice(0, 4)) });
    h.db.query("UPDATE requests SET status = 'needs_info' WHERE id = 1").run();
    const answer = (files: [Uint8Array<ArrayBuffer>, string][]) => {
      const f = new FormData();
      f.set("text", "like this");
      for (const [bytes, name] of files) f.append("files", new File([bytes], name));
      return h.call("/requests/1/answer", { method: "POST", cookie, multipart: f });
    };
    expect((await answer(six.slice(0, 2))).status).toBe(400);
    expect(h.db.query("SELECT status FROM requests").get()).toEqual({ status: "needs_info" });
    expect((await answer(six.slice(0, 1))).status).toBe(303);
    expect(h.db.query("SELECT status, (SELECT COUNT(*) FROM attachments) AS n FROM requests").get()).toEqual({ status: "queued", n: 5 });
  });

  test("a form with no file chosen adds the request without files", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const f = requestForm([]);
    f.append("files", new File([], ""));
    expect((await h.call("/requests", { method: "POST", cookie, multipart: f })).status).toBe(303);
    expect(h.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
  });
});

describe("settings", () => {
  test("an owner changes AI agent; invalid selections roll back all settings", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    expect(runnerRow(h.db).ai_agent).toBe("claude");
    const body = await (await h.call("/settings", { cookie })).text();
    expect(body).toContain('name="ai_agent"');
    expect(body).toContain('value="claude" selected');
    expect((await h.call("/settings", { method: "POST", cookie, form: { workers: "2", ai_agent: "codex" } })).status).toBe(303);
    expect(runnerRow(h.db).ai_agent).toBe("codex");
    expect((await h.call("/settings", { method: "POST", cookie, form: { workers: "3", ai_agent: "unknown" } })).status).toBe(400);
    expect(runnerRow(h.db)).toMatchObject({ workers: 2, ai_agent: "codex" });
  });

  test("an owner sets the worker count; the change is audited with the owner as actor", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const page = await h.call("/settings", { cookie });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain(`value="1"`);
    expect(body).toContain(`Suggested for this machine: ${suggestedWorkers()}`);
    const r = await h.call("/settings", { method: "POST", cookie, form: { workers: "3" } });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/settings");
    expect(runnerRow(h.db).workers).toBe(3);
    expect(h.db.query("SELECT payload, actor FROM events WHERE type = 'settings'").get()).toEqual({ payload: `{"workers":3}`, actor: "user:ertan" });
  });

  test("an admin sees the settings but can't change them", async () => {
    const h = await setup();
    const { cookie } = await h.signUp("helper", "admin");
    const body = await (await h.call("/settings", { cookie })).text();
    expect(body).toContain("Only an owner can change settings.");
    expect(body).toContain(" disabled");
    expect((await h.call("/settings", { method: "POST", cookie, form: { workers: "4" } })).status).toBe(403);
    expect(runnerRow(h.db).workers).toBe(1);
  });

  test("a count outside 1 to 8, or not a whole number, is refused", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    for (const workers of ["0", "9", "2.5", "", "two"]) {
      expect((await h.call("/settings", { method: "POST", cookie, form: { workers } })).status).toBe(400);
    }
    expect(runnerRow(h.db).workers).toBe(1);
  });

  // The session's passkey check, made old: settings changes then need a step-up.
  const stale = (h: Awaited<ReturnType<typeof setup>>) => h.db.query("UPDATE sessions SET verified_at = 0").run();
  async function stepUp(h: Awaited<ReturnType<typeof setup>>, cookie: string, key: SoftPasskey) {
    const o = await h.call("/step-up/options", { method: "POST", json: {}, cookie });
    const challenge = o.headers.get("set-cookie")!.split(";")[0];
    return h.call("/step-up/verify", { method: "POST", json: await key.login(await o.json(), h.url), cookie: `${cookie}; ${challenge}` });
  }

  test("changes need a recent passkey check; a step-up with your own passkey opens them, a pause needs none", async () => {
    const h = await setup();
    const { cookie, key } = await h.signUp();
    stale(h);
    expect(await (await h.call("/settings", { cookie })).text()).toContain(`id="step-up"`);
    const refused = await h.call("/settings", { method: "POST", cookie, form: { workers: "2" } });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Confirm with your passkey first");
    expect((await h.call("/settings/pause", { method: "POST", cookie })).status).toBe(303);
    expect(runnerRow(h.db)).toMatchObject({ paused: 1, pause_reason: "paused by ertan" });

    expect((await stepUp(h, cookie, key)).status).toBe(200);
    expect(await (await h.call("/settings", { cookie })).text()).not.toContain(`id="step-up"`);
    expect((await h.call("/settings", { method: "POST", cookie, form: { workers: "2" } })).status).toBe(303);
    expect(runnerRow(h.db).workers).toBe(2);
    expect(h.db.query("SELECT payload FROM events WHERE type = 'step_up'").get()).toEqual({ payload: `{"user":"ertan"}` });
  });

  test("a step-up with another user's passkey is refused", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const other = await h.signUp("helper", "admin");
    stale(h);
    const r = await stepUp(h, cookie, other.key);
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("belongs to helper, not ertan");
    expect((await h.call("/settings", { method: "POST", cookie, form: { workers: "2" } })).status).toBe(403);
  });

  test("an owner disables and enables a project; its requests wait meanwhile", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    expect((await h.call("/settings/projects/vt-web/disable", { method: "POST", cookie })).status).toBe(303);
    expect(h.db.query("SELECT enabled FROM projects WHERE name = 'vt-web'").get()).toEqual({ enabled: 0 });
    expect(await (await h.call("/", { cookie })).text()).not.toContain(`value="vt-web"`);
    expect((await h.call("/settings/projects/vt-web/enable", { method: "POST", cookie })).status).toBe(303);
    expect(h.db.query("SELECT enabled FROM projects WHERE name = 'vt-web'").get()).toEqual({ enabled: 1 });
    expect((await h.call("/settings/projects/nope/enable", { method: "POST", cookie })).status).toBe(404);
  });

  test("an owner adds, resets and removes users, but not their own account", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const added = await h.call("/settings/users", { method: "POST", cookie, form: { name: "alice", role: "admin" } });
    expect(added.status).toBe(200);
    expect(added.headers.get("cache-control")).toBe("no-store");
    const link = (await added.text()).match(/http:\/\/[^<\s]+\/register\/[A-Za-z0-9_-]+/)![0];
    expect((await fetch(link)).status).toBe(200);
    expect(h.db.query("SELECT role FROM users WHERE name = 'alice'").get()).toEqual({ role: "admin" });
    expect((await h.call("/settings/users", { method: "POST", cookie, form: { name: "alice" } })).status).toBe(400);

    const reset = await h.call("/settings/users/alice/reset", { method: "POST", cookie });
    expect(await reset.text()).toContain("alice's passkey");
    expect((await fetch(link)).status).toBe(404); // the old link is used up
    expect((await h.call("/settings/users/ertan/remove", { method: "POST", cookie })).status).toBe(400);
    expect((await h.call("/settings/users/ertan/reset", { method: "POST", cookie })).status).toBe(400);
    expect((await h.call("/settings/users/alice/remove", { method: "POST", cookie })).status).toBe(303);
    expect(h.db.query("SELECT name FROM users").all()).toEqual([{ name: "ertan" }]);
    expect((h.db.query("SELECT type, actor FROM events WHERE type LIKE 'user_%' ORDER BY id").all())).toEqual([
      { type: "user_add", actor: null }, { type: "user_add", actor: "user:ertan" }, { type: "user_reset", actor: "user:ertan" },
      { type: "user_remove", actor: "user:ertan" },
    ]);
  });

  test("an admin can't pause, toggle projects or manage users", async () => {
    const h = await setup();
    await h.signUp();
    const { cookie } = await h.signUp("helper", "admin");
    for (const path of ["/settings/pause", "/settings/projects/vt-web/disable", "/settings/users", "/settings/users/ertan/remove"]) {
      expect((await h.call(path, { method: "POST", cookie, form: { name: "mallory", role: "owner" } })).status).toBe(403);
    }
    expect(runnerRow(h.db).paused).toBe(0);
    expect(h.db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
  });

  test("the suggestion: one worker per 4 cores and per 8 GB, whichever is fewer, at least one", () => {
    const gb = 2 ** 30;
    expect(suggestedWorkers(10, 16 * gb)).toBe(2);
    expect(suggestedWorkers(32, 16 * gb)).toBe(2);
    expect(suggestedWorkers(16, 64 * gb)).toBe(4);
    expect(suggestedWorkers(2, 4 * gb)).toBe(1);
  });

  test("the page warns above the suggestion, and on Windows about the shared sandbox user", () => {
    const user = { id: 1, name: "ertan", role: "owner" as const };
    const d = { workers: 2, maxWorkers: 8, suggested: 2, cores: 10, memoryGb: 16, windows: false, paused: null, verified: true, projects: [], users: [] };
    expect(settingsPage(d, user)).not.toContain("more than this machine suits");
    expect(settingsPage({ ...d, workers: 3 }, user)).toContain("3 workers is more than this machine suits");
    expect(settingsPage({ ...d, windows: true }, user)).toContain("AgentrySandbox");
    expect(settingsPage({ ...d, workers: 1, windows: true }, user)).not.toContain("AgentrySandbox");
  });

  test("resetting or removing a user asks once more; before the passkey check both are disabled", () => {
    const user = { id: 1, name: "ertan", role: "owner" as const };
    const sam = { name: "sam", role: "admin", passkeys: 1, last_used: null };
    const d = { workers: 1, maxWorkers: 8, suggested: 2, cores: 10, memoryGb: 16, windows: false, paused: null, verified: true, projects: [], users: [sam] };
    const page = settingsPage(d, user);
    expect(page).toContain('<summary class="btn danger">Remove sam…</summary>');
    expect(page).toContain("Remove sam? Their passkeys and sessions are deleted. This can&#39;t be undone.");
    expect(page).toContain('<summary class="btn danger">Reset passkeys…</summary>');
    const locked = settingsPage({ ...d, verified: false }, user);
    expect(locked).toContain('<button class="danger" disabled>Remove sam</button>');
    expect(locked).not.toContain("Remove sam…");
  });
});

describe("static files", () => {
  test("htmx, the WebAuthn browser bundle and the icons are served", async () => {
    const h = await setup();
    for (const p of ["/static/htmx.js", "/static/webauthn.js", "/static/app.js", "/static/icon.png", "/static/apple-touch-icon.png"]) {
      const r = await h.call(p);
      expect(r.status).toBe(200);
      expect((await r.text()).length).toBeGreaterThan(100);
    }
  });
});
