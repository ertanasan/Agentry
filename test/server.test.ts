// The web UI over real HTTP (winhost design "Server"): passkey sign-up and sign-in with a software passkey, the
// Host / Origin / session guards, actions through actions.ts with the user as actor, escaping of request text
// and logs, the bounded log tail, sign-in throttling and the security headers.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addUser } from "../src/accounts.ts";
import { openDb } from "../src/db.ts";
import { startServer } from "../src/server.ts";
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
  async function signUp(name = "ertan") {
    const code = addUser(db, name, "owner");
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
    expect(login).toContain('<link rel="icon" href="/static/icon.svg"');
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
    expect(await (await h.call("/", { cookie })).text()).toMatch(/#1<\/strong> <span class="muted">vt-web, vt-ios<\/span>/);
    const mixed = await post(["vt-web", "habit"]);
    expect(mixed.status).toBe(400);
    expect(await mixed.text()).toContain("the projects of one request must share a repository");
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
    expect(await (await h.call("/", { cookie })).text()).toContain("Deploy group g1 is blocked: prod runs abc+uncommitted");
    expect((await h.call("/groups/g1/unblock", { method: "POST", cookie })).status).toBe(303);
    expect(h.db.query("SELECT lock FROM deploy_groups").get()).toEqual({ lock: "free" });
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

  test("the live log endpoint returns only the last 64 KiB", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    h.db.query("INSERT INTO requests (project_id, title, status, created_at, updated_at) VALUES (1, 't', 'running', 0, 0)").run();
    const log = join(h.home, "runs", "1", "1-build.log");
    mkdirSync(join(h.home, "runs", "1"), { recursive: true });
    writeFileSync(log, "x".repeat(500_000) + "\nTHE END\n");
    h.db.query("INSERT INTO runs (id, request_id, attempt, status, started_at) VALUES (1, 1, 1, 'running', 0)").run();
    h.db.query("INSERT INTO steps (run_id, step, started_at, log_path) VALUES (1, 'build', 0, ?)").run(log);
    const r = await h.call("/runs/1/log", { cookie });
    const body = await r.text();
    expect(body).toContain("THE END");
    expect(body.length).toBeLessThan(70_000);
    expect(body).toContain('hx-trigger="every 2s"'); // still running → keeps polling
  });
});

// The first bytes are all the server looks at; the rest only gives the files a size.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7)]);
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), ...new Array(200).fill(7)]);

describe("attached images", () => {
  const requestForm = (files: [Uint8Array<ArrayBuffer>, string][], title = "Fix the search box") => {
    const f = new FormData();
    f.set("project", "vt-web"); f.set("title", title); f.set("body", "see the screenshot");
    for (const [bytes, name] of files) f.append("images", new File([bytes], name));
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

  test("a file that is not a supported image is refused, and no request is created", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const fake = new TextEncoder().encode("<svg onload=alert(1)>");
    const r = await h.call("/requests", { method: "POST", cookie, multipart: requestForm([[PNG, "ok.png"], [fake, "evil.png"]]) });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("evil.png is not a PNG, JPEG, GIF or WebP image");
    const heic = await h.call("/requests", { method: "POST", cookie, multipart: requestForm([[HEIC, "IMG_1.HEIC"]]) });
    expect(await heic.text()).toContain("IMG_1.HEIC is a HEIC photo");
    expect(h.db.query("SELECT (SELECT COUNT(*) FROM requests) AS r, (SELECT COUNT(*) FROM attachments) AS a").get()).toEqual({ r: 0, a: 0 });
  });

  test("at most 5 images per request, counting those sent with answers", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const six = Array.from({ length: 6 }, (_, i) => [PNG, `s${i}.png`] as [Uint8Array<ArrayBuffer>, string]);
    expect((await h.call("/requests", { method: "POST", cookie, multipart: requestForm(six) })).status).toBe(400);

    await h.call("/requests", { method: "POST", cookie, multipart: requestForm(six.slice(0, 4)) });
    h.db.query("UPDATE requests SET status = 'needs_info' WHERE id = 1").run();
    const answer = (files: [Uint8Array<ArrayBuffer>, string][]) => {
      const f = new FormData();
      f.set("text", "like this");
      for (const [bytes, name] of files) f.append("images", new File([bytes], name));
      return h.call("/requests/1/answer", { method: "POST", cookie, multipart: f });
    };
    expect((await answer(six.slice(0, 2))).status).toBe(400);
    expect(h.db.query("SELECT status FROM requests").get()).toEqual({ status: "needs_info" });
    expect((await answer(six.slice(0, 1))).status).toBe(303);
    expect(h.db.query("SELECT status, (SELECT COUNT(*) FROM attachments) AS n FROM requests").get()).toEqual({ status: "queued", n: 5 });
  });

  test("a form with no file chosen adds the request without images", async () => {
    const h = await setup();
    const { cookie } = await h.signUp();
    const f = requestForm([]);
    f.append("images", new File([], ""));
    expect((await h.call("/requests", { method: "POST", cookie, multipart: f })).status).toBe(303);
    expect(h.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
  });
});

describe("static files", () => {
  test("htmx, the WebAuthn browser bundle and the icons are served", async () => {
    const h = await setup();
    for (const p of ["/static/htmx.js", "/static/webauthn.js", "/static/app.js", "/static/icon.svg", "/static/apple-touch-icon.png"]) {
      const r = await h.call(p);
      expect(r.status).toBe(200);
      expect((await r.text()).length).toBeGreaterThan(100);
    }
  });
});
