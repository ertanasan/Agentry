// Recipes as people edit them: `agentry project add` and the Recipes tab both store a recipe here, in the projects
// table and in its JSON file, so the two never drift apart. A recipe belongs to the machine whose runner runs it:
// the queue owner edits its own at once; an edit of an attached runner's waits in recipe_edits until that runner
// checks in (each minute, cli.ts), applies it and reports its recipes back.
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Queue } from "./queue.ts";
import { parseRecipe } from "./recipe.ts";

// A project's recipe as its runner has it: the JSON as written, and the file it lives in.
export type RecipeText = { json: string; file: string | null };
// An edit waiting for an attached runner.
export type RecipeEdit = { id: number; project: string; recipe: string };

// This checkout: a recipe file in it is a shipped example, which an edit doesn't overwrite.
const APP_DIR = resolve(import.meta.dir, "..");

// Stores `json` (checked) as `name`'s recipe, adding the project if it is new, and records the file it lives in.
export function storeRecipe(db: Database, name: string, json: string, file: string | null): void {
  const recipe = parseRecipe(json);
  db.transaction(() => {
    db.query("INSERT OR IGNORE INTO repos (name, path) VALUES (?, ?)").run(recipe.repo, recipe.repo);
    db.query("INSERT OR IGNORE INTO deploy_groups (name) VALUES (?)").run(recipe.deploy_group);
    db.query(`INSERT INTO projects (name, repo_id, deploy_group_id, recipe, recipe_file)
      VALUES (?, (SELECT id FROM repos WHERE path = ?), (SELECT id FROM deploy_groups WHERE name = ?), ?, ?)
      ON CONFLICT(name) DO UPDATE SET repo_id = excluded.repo_id, deploy_group_id = excluded.deploy_group_id, recipe = excluded.recipe,
        recipe_file = excluded.recipe_file`)
      .run(name, recipe.repo, recipe.deploy_group, json, file);
  })();
}

// An edit of an existing project's recipe: checked, stored, and written to its file; a project added from this
// checkout's examples, or from no file, gets $AGENTRY_HOME/recipes/<name>.json. Returns the file.
export function saveRecipe(db: Database, home: string, name: string, json: string): string {
  const row = db.query("SELECT recipe_file FROM projects WHERE name = ?").get(name) as { recipe_file: string | null } | null;
  if (!row) throw new Error(`no project "${name}"`);
  parseRecipe(json);
  const file = row.recipe_file && !row.recipe_file.startsWith(APP_DIR + sep) ? row.recipe_file : join(home, "recipes", `${name}.json`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, json.endsWith("\n") ? json : json + "\n");
  storeRecipe(db, name, json, file);
  return file;
}

// Reports this machine's recipes to the queue and applies the edits made there for this runner, reporting each
// outcome and then the recipes again. Returns what it applied, as lines for the log.
export async function syncRecipes(db: Database, home: string, q: Pick<Queue, "syncRecipes" | "recipeEdited">): Promise<string[]> {
  const edits = await q.syncRecipes(recipeTexts(db));
  const said: string[] = [];
  for (const e of edits) {
    let error: string | null = null;
    try { said.push(`recipe of ${e.project} edited on the queue's Recipes tab: ${saveRecipe(db, home, e.project, e.recipe)}`); }
    catch (err) { error = err instanceof Error ? err.message : String(err); said.push(`recipe edit of ${e.project} refused: ${error}`); }
    await q.recipeEdited(e.id, error);
  }
  if (edits.length) await q.syncRecipes(recipeTexts(db));
  return said;
}

// This machine's recipes, by project.
export function recipeTexts(db: Database): Record<string, RecipeText> {
  const rows = db.query("SELECT name, recipe, recipe_file FROM projects ORDER BY name").all() as { name: string; recipe: string; recipe_file: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.name, { json: r.recipe, file: r.recipe_file }]));
}
