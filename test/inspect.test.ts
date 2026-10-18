import { describe, expect, test } from "bun:test";
import { inspect, countRegression } from "../src/inspect.ts";
import type { Recipe } from "../src/recipe.ts";

const recipe: Recipe = {
  repo: "/x", deploy_group: "g", scope_path: "VocaTrain_backend/", test_cmd: "true",
  gate_paths: ["VocaTrain_backend/agentry.json", ".github/**"],
  test_globs: ["**/*.Tests/**/*.cs"],
  skip_patterns: ["Skip\\s*=", "XCTSkip", "\\.disabled", "\\bit\\.skip\\("],
};
const kinds = (r: ReturnType<typeof inspect>) => r.blocking.map((f) => f.kind);

describe("inspect", () => {
  test("an ordinary source change in scope passes", () => {
    expect(inspect([{ status: "M", path: "VocaTrain_backend/Api/Reminder.cs" }], new Map(), recipe).blocking).toEqual([]);
  });

  test("a change outside the scope needs review", () => {
    expect(kinds(inspect([{ status: "M", path: "VocaTrain_web/Page.razor" }], new Map(), recipe))).toEqual(["out_of_scope"]);
  });

  test.each([
    "VocaTrain_backend/Api/Api.csproj", "VocaTrain_backend/Directory.Build.props", "VocaTrain_backend/x.targets",
    "VocaTrain_backend/Directory.Packages.props", "VocaTrain_backend/NuGet.config", "VocaTrain_backend/global.json",
    "VocaTrain_backend/deploy-prod-winhost.sh", "VocaTrain_backend/.tools/winhost/install-service.ps1",
    "VocaTrain_backend/Kit/Package.swift",
  ])("build file %s needs review (D13)", (path) => {
    expect(kinds(inspect([{ status: "M", path }], new Map(), recipe))).toContain("build_file");
  });

  test("recipe gate paths need review", () => {
    expect(kinds(inspect([{ status: "M", path: "VocaTrain_backend/agentry.json" }], new Map(), recipe))).toEqual(["gate_path"]);
  });

  test("a deleted test file needs review; a new one is only an info flag", () => {
    const del = inspect([{ status: "D", path: "VocaTrain_backend/Core.Tests/ReminderTests.cs" }], new Map(), recipe);
    expect(kinds(del)).toEqual(["test_deleted"]);
    const add = inspect([{ status: "A", path: "VocaTrain_backend/Core.Tests/NewTests.cs" }], new Map(), recipe);
    expect(add.blocking).toEqual([]);
    expect(add.info.map((f) => f.kind)).toEqual(["test_added"]);
  });

  test("an added Skip in a test file needs review", () => {
    const path = "VocaTrain_backend/Core.Tests/ReminderTests.cs";
    const r = inspect([{ status: "M", path }], new Map([[path, ['[Fact(Skip = "flaky")]']]]), recipe);
    expect(r.blocking).toEqual([{ kind: "test_skipped", path, detail: '[Fact(Skip = "flaky")]' }]);
  });
});

describe("countRegression", () => {
  test("fewer tests or more skipped than the baseline is flagged", () => {
    expect(countRegression({ total: 213, skipped: 0 }, { total: 214, skipped: 0 })?.kind).toBe("test_deleted");
    expect(countRegression({ total: 214, skipped: 1 }, { total: 214, skipped: 0 })?.kind).toBe("test_skipped");
    expect(countRegression({ total: 215, skipped: 0 }, { total: 214, skipped: 0 })).toBeNull();
    expect(countRegression({ total: 1, skipped: 0 }, null)).toBeNull();
  });
});
