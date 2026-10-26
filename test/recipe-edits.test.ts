// Recipes as people edit them (recipes.ts): saved to the database and their file, and an attached runner's edits
// handed to it through the queue.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, openDb } from "../src/db.ts";
import { localQueue } from "../src/queue.ts";
import { saveRecipe, storeRecipe, syncRecipes } from "../src/recipes.ts";

const recipe = (test_cmd: string) => JSON.stringify({ repo: "/r", deploy_group: "g", scope_path: "", test_cmd }, null, 2) + "\n";

function machine() {
  const home = mkdtempSync(join(tmpdir(), "agentry-recipes-"));
  const db = openDb(join(home, "agentry.db"));
  const project = (name: string, json: string, file: string | null) => storeRecipe(db, name, json, file);
  const stored = (name: string) => db.query("SELECT recipe, recipe_file FROM projects WHERE name = ?").get(name) as { recipe: string; recipe_file: string | null };
  return { home, db, project, stored };
}

describe("recipes", () => {
  test("an edit is stored and written to the file the project was added from", () => {
    const m = machine();
    const file = join(m.home, "mine", "app.json");
    mkdirSync(join(m.home, "mine"));
    writeFileSync(file, recipe("true"));
    m.project("app", recipe("true"), file);
    expect(saveRecipe(m.db, m.home, "app", recipe("make test"))).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(recipe("make test"));
    expect(m.stored("app")).toEqual({ recipe: recipe("make test"), recipe_file: file });
  });

  test("a project added from no file, or from this checkout's examples, gets a file in the home folder", () => {
    const m = machine();
    m.project("app", recipe("true"), null);
    m.project("example", recipe("true"), join(import.meta.dir, "..", "recipes", "vocatrain-web.json"));
    expect(saveRecipe(m.db, m.home, "app", recipe("make"))).toBe(join(m.home, "recipes", "app.json"));
    expect(saveRecipe(m.db, m.home, "example", recipe("make"))).toBe(join(m.home, "recipes", "example.json"));
    expect(readFileSync(join(import.meta.dir, "..", "recipes", "vocatrain-web.json"), "utf8")).not.toContain('"make"');
  });

  test("an invalid recipe is refused and changes nothing", () => {
    const m = machine();
    m.project("app", recipe("true"), null);
    expect(() => saveRecipe(m.db, m.home, "app", "{ not json")).toThrow();
    expect(() => saveRecipe(m.db, m.home, "app", JSON.stringify({ repo: "/r" }))).toThrow('recipe: "deploy_group" is required');
    expect(m.stored("app").recipe).toBe(recipe("true"));
    expect(existsSync(join(m.home, "recipes"))).toBe(false);
  });

  test("an attached runner applies the queue's edits of its recipes and reports them back", async () => {
    const owner = machine(), runner = machine();
    owner.project("app", recipe("owner's copy"), null);
    owner.db.query("UPDATE projects SET runners = 'macea' WHERE name = 'app'").run();
    acquireLease(owner.db, "tok", 1, Date.now(), "macea.local", "macea", ["app"]);
    const q = localQueue(owner.db, "tok", owner.home, "macea");
    runner.project("app", recipe("true"), null);
    const edit = (json: string) => owner.db.query("INSERT INTO recipe_edits (holder, project, recipe, by_user, created_at) VALUES ('macea', 'app', ?, 'ertan', 0)").run(json);
    const edits = () => owner.db.query("SELECT done_at IS NOT NULL AS done, error FROM recipe_edits ORDER BY id").all();
    const reported = () => JSON.parse((owner.db.query("SELECT recipes_report FROM leases WHERE holder = 'macea'").get() as { recipes_report: string }).recipes_report);

    expect(await syncRecipes(runner.db, runner.home, q)).toEqual([]);
    expect(reported()).toEqual({ app: { json: recipe("true"), file: null } });

    edit(recipe("make test"));
    edit("{ not json");
    const said = await syncRecipes(runner.db, runner.home, q);
    expect(said[0]).toBe(`recipe of app edited on the queue's Recipes tab: ${join(runner.home, "recipes", "app.json")}`);
    expect(said[1]).toStartWith("recipe edit of app refused: ");
    expect(edits()).toEqual([{ done: 1, error: null }, { done: 1, error: expect.any(String) }]);
    expect(runner.stored("app").recipe).toBe(recipe("make test"));
    expect(reported().app.json).toBe(recipe("make test"));
    expect(owner.stored("app").recipe).toBe(recipe("owner's copy")); // the owner's own copy isn't the runner's
  });
});
