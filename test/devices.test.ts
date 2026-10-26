// Where a project deploys: its recipe's targets and devices, as the entries a request picks from.
import { describe, expect, test } from "bun:test";
import { entriesOf, pickedSteps } from "../src/devices.ts";
import { parseRecipe, type Recipe } from "../src/recipe.ts";

const base = { repo: "/r", deploy_group: "g", scope_path: "", test_cmd: "true" };
const phone = { id: "00000000-0000000000000001", name: "Test phone", model: "iPhone 18 Pro Max" };
const ios: Recipe = { ...base, deploy_cmd: "ship", targets: [{ name: "TestFlight · team TEAM123456", live_version_cmd: "cat v" }], device_deploy_cmd: "install", devices: [phone] };

describe("deploy entries", () => {
  test("the targets the recipe's deploy_cmd deploys are one entry, picked; each device is one, not picked", () => {
    expect(entriesOf(ios)).toEqual([
      { id: "deploy", name: "TestFlight · team TEAM123456", pick: true },
      { id: `device:${phone.id}`, name: "Test phone · iPhone 18 Pro Max", pick: false },
    ]);
    const together = { ...base, deploy_cmd: "ship", targets: [{ name: "api", live_version_cmd: "a" }, { name: "web", live_version_cmd: "w" }] };
    expect(entriesOf(together)).toEqual([{ id: "deploy", name: "api + web", pick: true }]);
    expect(entriesOf(base)).toEqual([]);
  });

  test("a target with its own deploy_cmd is an entry of its own", () => {
    const apart: Recipe = { ...base, deploy_cmd: "ship", targets: [
      { name: "api", live_version_cmd: "a" }, { name: "web", live_version_cmd: "w", deploy_cmd: "ship-web" }] };
    expect(entriesOf(apart)).toEqual([{ id: "deploy", name: "api", pick: true }, { id: "target:web", name: "web", pick: true }]);
    expect(pickedSteps(apart, ["target:web"])).toEqual([{ id: "target:web", name: "web", cmd: "ship-web", check: [apart.targets![1]] }]);
  });

  test("a request's picks choose the steps, in deploy order; without picks the defaults run", () => {
    expect(pickedSteps(ios, undefined).map((s) => s.id)).toEqual(["deploy"]);
    expect(pickedSteps(ios, [`device:${phone.id}`, "deploy"]).map((s) => s.id)).toEqual(["deploy", `device:${phone.id}`]);
    expect(pickedSteps(ios, [`device:${phone.id}`])).toEqual([{ id: `device:${phone.id}`, name: "Test phone · iPhone 18 Pro Max", cmd: "install", check: [], device: phone }]);
  });

  test("a recipe's devices need its device_deploy_cmd, each an id and a name; every target needs a deploy command", () => {
    const parse = (r: object) => () => parseRecipe(JSON.stringify({ ...base, ...r }));
    expect(parse({ devices: [phone] })).toThrow("device_deploy_cmd and devices go together");
    expect(parse({ device_deploy_cmd: "install" })).toThrow("device_deploy_cmd and devices go together");
    expect(parse({ device_deploy_cmd: "install", devices: [{ name: "No id" }] })).toThrow("each device needs an id (its UDID) and a name");
    expect(parse({ targets: [{ name: "api", live_version_cmd: "a" }, { name: "web", live_version_cmd: "w", deploy_cmd: "ship-web" }] }))
      .toThrow("target api has no deploy_cmd, and the recipe has none");
    expect(parse({ device_deploy_cmd: "install", devices: [phone] })().devices).toEqual([phone]);
  });
});
