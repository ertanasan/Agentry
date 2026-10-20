// Step 4: inspects the candidate commit's diff. Blocking flags send the request to needs_review, except
// out_of_scope, which stops it: a change outside the request's projects is never deployed. Info flags are
// only shown.
import type { FileChange } from "./git.ts";
import { BUILD_FILE_GLOBS, type Recipe } from "./recipe.ts";

export type Flag = { kind: "out_of_scope" | "gate_path" | "build_file" | "test_deleted" | "test_skipped" | "test_added"; path: string; detail?: string };
export type Inspection = { blocking: Flag[]; info: Flag[] };
export type Owner = { name: string; scope_path: string };

// Case-insensitive: APFS and NTFS are case-insensitive by default, so MSBuild and NuGet pick up
// directory.build.props or NUGET.CONFIG as well as the canonical names.
const matches = (globs: string[], path: string) => globs.some((g) => new Bun.Glob(g.toLowerCase()).match(path.toLowerCase()));

const under = (scope: string, path: string) => path.toLowerCase().startsWith(scope.toLowerCase());

// `recipes` are the request's projects; `others` are the repo's other projects, named in an out-of-scope flag.
export function inspect(changes: FileChange[], added: Map<string, string[]>, recipes: Recipe[], others: Owner[] = []): Inspection {
  const blocking: Flag[] = [];
  const info: Flag[] = [];
  const tests = recipes.flatMap((r) => r.test_globs ?? []);
  const gates = recipes.flatMap((r) => r.gate_paths ?? []);
  const skips = recipes.flatMap((r) => r.skip_patterns ?? []).map((p) => new RegExp(p));
  const owners = [...others].sort((a, b) => b.scope_path.length - a.scope_path.length); // the deepest scope owns a path

  for (const { status, path } of changes) {
    if (!recipes.some((r) => under(r.scope_path, path))) {
      const owner = owners.find((o) => under(o.scope_path, path));
      blocking.push({ kind: "out_of_scope", path, ...(owner ? { detail: `${owner.name}, not selected` } : {}) });
    }
    if (matches(gates, path)) blocking.push({ kind: "gate_path", path });
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
