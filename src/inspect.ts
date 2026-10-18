// Step 4: inspects the candidate commit's diff. Blocking flags send the request to needs_review; info flags
// are only shown.
import type { FileChange } from "./git.ts";
import { BUILD_FILE_GLOBS, type Recipe } from "./recipe.ts";

export type Flag = { kind: "out_of_scope" | "gate_path" | "build_file" | "test_deleted" | "test_skipped" | "test_added"; path: string; detail?: string };
export type Inspection = { blocking: Flag[]; info: Flag[] };

const matches = (globs: string[], path: string) => globs.some((g) => new Bun.Glob(g).match(path));

export function inspect(changes: FileChange[], added: Map<string, string[]>, recipe: Recipe): Inspection {
  const blocking: Flag[] = [];
  const info: Flag[] = [];
  const tests = recipe.test_globs ?? [];
  const skips = (recipe.skip_patterns ?? []).map((p) => new RegExp(p));

  for (const { status, path } of changes) {
    if (!path.startsWith(recipe.scope_path)) blocking.push({ kind: "out_of_scope", path });
    if (matches(recipe.gate_paths ?? [], path)) blocking.push({ kind: "gate_path", path });
    if (matches(BUILD_FILE_GLOBS, path)) blocking.push({ kind: "build_file", path });
    if (matches(tests, path)) {
      if (status === "D") blocking.push({ kind: "test_deleted", path });
      if (status === "A") info.push({ kind: "test_added", path });
      const skipped = (added.get(path) ?? []).find((line) => skips.some((re) => re.test(line)));
      if (skipped) blocking.push({ kind: "test_skipped", path, detail: skipped.trim() });
    }
  }
  return { blocking, info };
}

// Test counts must not go down and skipped counts must not go up against the project's last passing run.
export function countRegression(now: { total: number; skipped: number }, base: { total: number; skipped: number } | null): Flag | null {
  if (!base) return null;
  if (now.total < base.total) return { kind: "test_deleted", path: "(test run)", detail: `tests ${base.total} → ${now.total}` };
  if (now.skipped > base.skipped) return { kind: "test_skipped", path: "(test run)", detail: `skipped ${base.skipped} → ${now.skipped}` };
  return null;
}
