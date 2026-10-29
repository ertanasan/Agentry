// agentry export / import: a fresh install takes over the projects, runner keys and queue settings of an old one.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, setAgent, setProjectEnabled, setWorkers } from "../src/actions.ts";
import { openDb } from "../src/db.ts";
import { addRunnerKey } from "../src/remote.ts";
import { exportSetup, importSetup } from "../src/transfer.ts";

const recipe = (repo: string, group: string) =>
  JSON.stringify({ _comment: ["kept as written"], repo, deploy_group: group, scope_path: "", test_cmd: "true" }, null, 2);

function oldInstall() {
  const db = openDb(":memory:");
  addRunnerKey(db, "macea");
  addProject(db, "web", recipe("C:\\Agentry\\repos\\App", "app"), "C:\\old\\web.json", ["local", "macea"]);
  addProject(db, "ios", recipe("C:\\Agentry\\repos\\App", "app"), null, ["macea"]);
  addProject(db, "site", recipe("C:\\Agentry\\repos\\Site", "site"), null, null);
  setProjectEnabled(db, "site", false);
  setAgent(db, "codex");
  setWorkers(db, 3);
  return db;
}

const projects = (db: ReturnType<typeof openDb>) =>
  db.query("SELECT name, recipe, runners, enabled FROM projects ORDER BY name").all();

describe("export and import", () => {
  test("a fresh install gets the projects, runner keys and queue settings", () => {
    const old = oldInstall();
    const dir = mkdtempSync(join(tmpdir(), "agentry-export-"));
    const m = exportSetup(old, dir, { AGENTRY_MODEL: "opus", PATH: "x" });
    expect(m.models).toEqual({ AGENTRY_MODEL: "opus" });
    expect(readFileSync(join(dir, "recipes", "web.json"), "utf8")).toBe(recipe("C:\\Agentry\\repos\\App", "app"));

    const fresh = openDb(":memory:");
    const home = mkdtempSync(join(tmpdir(), "agentry-home-"));
    const said = importSetup(fresh, dir, home);
    expect(projects(fresh)).toEqual(projects(old));
    // Each recipe now lives in the new install's own file, where the Recipes tab saves its edits.
    expect(fresh.query("SELECT recipe_file FROM projects WHERE name = 'web'").get()).toEqual({ recipe_file: join(home, "recipes", "web.json") });
    expect(readFileSync(join(home, "recipes", "web.json"), "utf8")).toBe(recipe("C:\\Agentry\\repos\\App", "app") + "\n");
    expect(fresh.query("SELECT name, key_hash FROM runner_keys").all()).toEqual(old.query("SELECT name, key_hash FROM runner_keys").all());
    expect(fresh.query("SELECT ai_agent, workers FROM runner").get()).toEqual({ ai_agent: "codex", workers: 3 });
    expect(said).toContain("project site: runs on local, disabled");
    expect(said).toContain("model: set AGENTRY_MODEL=opus in the runner's environment (not imported)");
    expect(fresh.query("SELECT COUNT(*) n FROM events WHERE type = 'import'").get()).toEqual({ n: 1 });
  });

  test("importing again changes nothing, and an edited recipe is taken", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentry-export-"));
    exportSetup(oldInstall(), dir);
    const fresh = openDb(":memory:");
    importSetup(fresh, dir, mkdtempSync(join(tmpdir(), "agentry-home-")));
    const edited = recipe("D:\\repos\\App", "app");
    writeFileSync(join(dir, "recipes", "web.json"), edited);
    expect(importSetup(fresh, dir, mkdtempSync(join(tmpdir(), "agentry-home-")))).toContain("runner key macea: already here");
    expect(fresh.query("SELECT COUNT(*) n FROM projects").get()).toEqual({ n: 3 });
    expect(fresh.query("SELECT recipe FROM projects WHERE name = 'web'").get()).toEqual({ recipe: edited });
  });

  test("a runner key this install already has keeps its own hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentry-export-"));
    exportSetup(oldInstall(), dir);
    const fresh = openDb(":memory:");
    addRunnerKey(fresh, "macea");
    const own = fresh.query("SELECT key_hash FROM runner_keys").get();
    expect(importSetup(fresh, dir, mkdtempSync(join(tmpdir(), "agentry-home-")))).toContain("runner key macea: this install's own key kept");
    expect(fresh.query("SELECT key_hash FROM runner_keys").get()).toEqual(own);
  });

  test("a folder without an export is refused", () => {
    expect(() => importSetup(openDb(":memory:"), mkdtempSync(join(tmpdir(), "agentry-empty-")), tmpdir())).toThrow("no agentry-export.json");
  });
});
