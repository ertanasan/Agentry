// The devices a recipe installs its project on, which its runner offers as deploy targets.
import { describe, expect, test } from "bun:test";
import { deployChoices } from "../src/devices.ts";
import { parseRecipe, type Recipe } from "../src/recipe.ts";

const base = { repo: "/r", deploy_group: "g", scope_path: "", test_cmd: "true" };
const phone = { id: "00000000-0000000000000001", name: "Test phone", model: "iPhone 18 Pro Max" };

describe("devices", () => {
  test("a project offers devices only when its recipe defines them; its own deploy is named by its targets", () => {
    const recipes: [string, Recipe][] = [
      ["app", { ...base, deploy_cmd: "ship", targets: [{ name: "TestFlight · team TEAM123456", live_version_cmd: "cat v" }], device_deploy_cmd: "install", devices: [phone] }],
      ["tool", { ...base, device_deploy_cmd: "install", devices: [phone] }],
      ["web", { ...base, deploy_cmd: "ship", targets: [{ name: "prod", live_version_cmd: "cat v" }] }],
    ];
    expect(deployChoices(recipes)).toEqual({
      app: { usual: "TestFlight · team TEAM123456", devices: [phone] },
      tool: { usual: "no deploy (built only)", devices: [phone] },
    });
  });

  test("a recipe's devices need its device_deploy_cmd, and each an id and a name", () => {
    const parse = (r: object) => () => parseRecipe(JSON.stringify({ ...base, ...r }));
    expect(parse({ devices: [phone] })).toThrow("device_deploy_cmd and devices go together");
    expect(parse({ device_deploy_cmd: "install" })).toThrow("device_deploy_cmd and devices go together");
    expect(parse({ device_deploy_cmd: "install", devices: [{ name: "No id" }] })).toThrow("each device needs an id (its UDID) and a name");
    expect(parse({ device_deploy_cmd: "install", devices: [phone] })().devices).toEqual([phone]);
  });
});
