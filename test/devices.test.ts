// The devices a runner offers as deploy targets: devicectl's list, and the choices of the projects that can install.
import { describe, expect, test } from "bun:test";
import { deployChoices, parseDevices } from "../src/devices.ts";
import type { Recipe } from "../src/recipe.ts";

// `xcrun devicectl list devices --json-output`, cut to the fields that matter.
const device = (name: string, udid: string, reality: string, pairingState: string, marketingName = "iPhone 18 Pro Max") => ({
  identifier: "BEB1EE5D-0000-0000-0000-000000000000", deviceProperties: { name },
  hardwareProperties: { reality, udid, marketingName, deviceType: "iPhone" }, connectionProperties: { pairingState },
});

describe("devices", () => {
  test("only paired physical devices are offered, by name and model, with their UDID", () => {
    const json = JSON.stringify({ info: { outcome: "success" }, result: { devices: [
      device("iPhone 17", "607B7CAC-0994-4475-85EF-E92C47D14F9A", "simulated", "paired"),
      device("Test phone", "00000000-0000000000000001", "physical", "paired"),
      device("Old phone", "00000000-0000000000000002", "physical", "unpaired"),
    ] } });
    expect(parseDevices(json)).toEqual([{ id: "00000000-0000000000000001", name: "Test phone", model: "iPhone 18 Pro Max" }]);
    expect(parseDevices(JSON.stringify({ info: { outcome: "failed" } }))).toEqual([]);
  });

  test("a project offers devices only when its recipe can install on one; its own deploy is named by its targets", () => {
    const base = { repo: "/r", deploy_group: "g", scope_path: "", test_cmd: "true" };
    const phone = { id: "00000000-0000000000000001", name: "Test phone", model: "iPhone 18 Pro Max" };
    const recipes: [string, Recipe][] = [
      ["app", { ...base, deploy_cmd: "ship", targets: [{ name: "TestFlight · team TEAM123456", live_version_cmd: "cat v" }], device_deploy_cmd: "install" }],
      ["tool", { ...base, device_deploy_cmd: "install" }],
      ["web", { ...base, deploy_cmd: "ship", targets: [{ name: "prod", live_version_cmd: "cat v" }] }],
    ];
    expect(deployChoices(recipes, [phone])).toEqual({
      app: { usual: "TestFlight · team TEAM123456", devices: [phone] },
      tool: { usual: "no deploy (built only)", devices: [phone] },
    });
  });
});
