// A project's recipe: how the runner builds, tests, deploys and checks it. Stored as JSON in projects.recipe.

export type Target = {
  name: string;
  // Prints the live VERSION line ("<short-sha>[+uncommitted] <date> <time>") of what this target runs (D10).
  live_version_cmd: string;
};

export type Recipe = {
  repo: string;                 // absolute path of the user's checkout (only used for git metadata and worktrees)
  remote?: string;              // default "origin"
  branch?: string;              // default "main"
  deploy_group: string;         // projects sharing a deploy target share a group
  scope_path: string;           // e.g. "VocaTrain_backend/"; changes outside it go to needs_review
  build_cmd?: string;           // runs before tests, sandboxed (D16)
  build_unsandboxed?: boolean;  // build_cmd runs outside the sandbox on a cleaned worktree, like deploy (D6): for a
                                // toolchain the sandbox can't host (xcodebuild needs the user's SwiftPM cache)
  sandbox_user_temp?: boolean;  // sandboxed steps may use the per-user temp folder (Swift Build ignores TMPDIR)
  test_cmd: string;             // runs sandboxed
  test_result_file?: string;    // TRX file path relative to the worktree, e.g. "TestResults/agentry.trx"
  deploy_cmd?: string;          // runs unsandboxed from the worktree (D6); absent = "built", not deployed
  deploy_order?: number;        // a request with several projects deploys them lowest first; default 0
  targets?: Target[];           // live-version reads for the drift guard and the post-deploy check
  remote_busy_cmd?: string;     // exit 0 = an earlier install is still running remotely, 1 = free, else unknown (D18)
  gate_paths?: string[];        // extra blocking globs (recipe, CI, schema files, ...)
  test_globs?: string[];        // which files are tests
  skip_patterns?: string[];     // regexes that mark a test as skipped when added in a test file
  timeouts_s?: Partial<Record<StepName, number>>;
};

export type StepName = "agent" | "build" | "test" | "verify" | "deploy" | "version";

export const DEFAULT_TIMEOUTS_S: Record<StepName, number> = {
  agent: 30 * 60, build: 15 * 60, test: 20 * 60, verify: 5 * 60, deploy: 30 * 60, version: 60,
};

// Files that execute code at build time. Any change to them needs review, because deploy builds the code
// unsandboxed with the user's credentials (eng review D13).
export const BUILD_FILE_GLOBS = [
  "**/*.csproj", "**/*.props", "**/*.targets", "**/Directory.Build.*", "**/Directory.Packages.props",
  "**/NuGet.config", "**/nuget.config", "**/global.json", "**/*.sh", "**/*.ps1", "**/Package.swift", "**/.tools/**",
  "**/*.pbxproj", "**/*.xcscheme", "**/*.xcconfig", // Xcode: run-script phases and build settings
];

export function timeoutMs(r: Recipe, step: StepName): number {
  return (r.timeouts_s?.[step] ?? DEFAULT_TIMEOUTS_S[step]) * 1000;
}

export function parseRecipe(json: string): Recipe {
  const r = JSON.parse(json) as Recipe;
  for (const key of ["repo", "deploy_group", "scope_path", "test_cmd"] as const) {
    if (typeof r[key] !== "string" || !r[key]) throw new Error(`recipe: "${key}" is required`);
  }
  if (r.deploy_cmd && !r.targets?.length) throw new Error("recipe: a deploy_cmd needs targets with live_version_cmd");
  return r;
}
