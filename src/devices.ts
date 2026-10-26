// Real devices this machine's Xcode can install on (paired iPhones and iPads), a deploy target beside a project's own
// for a recipe with a device_deploy_cmd. Each runner reports its projects' choices with its lease (queue.setDevices),
// so the queue owner's pages list them: the project's own deploy first (its targets, e.g. TestFlight), then the devices.
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStep } from "./proc.ts";
import type { Recipe } from "./recipe.ts";
import { eligible } from "./routing.ts";

export type Device = { id: string; name: string; model: string };  // id: the UDID, which xcodebuild and devicectl take
// By project: what its own deploy reaches, and the devices it can install on instead.
export type DeployChoices = Record<string, { usual: string; devices: Device[] }>;

// The paired physical devices in `xcrun devicectl list devices --json-output`.
export function parseDevices(json: string): Device[] {
  const d = JSON.parse(json) as { result?: { devices?: {
    hardwareProperties?: { reality?: string; udid?: string; marketingName?: string; deviceType?: string };
    deviceProperties?: { name?: string }; connectionProperties?: { pairingState?: string };
  }[] } };
  return (d.result?.devices ?? []).flatMap((x) => {
    const hw = x.hardwareProperties ?? {};
    if (hw.reality !== "physical" || x.connectionProperties?.pairingState !== "paired" || !hw.udid) return [];
    return [{ id: hw.udid, name: x.deviceProperties?.name || hw.udid, model: hw.marketingName || hw.deviceType || "device" }];
  });
}

// This machine's devices; none off macOS, or when devicectl fails.
export async function listDevices(): Promise<Device[]> {
  if (process.platform !== "darwin") return [];
  const dir = mkdtempSync(join(tmpdir(), "agentry-devices-"));
  try {
    const out = join(dir, "devices.json");
    const r = await runStep(["xcrun", "devicectl", "list", "devices", "--quiet", "--json-output", out], { cwd: dir, logPath: join(dir, "log"), timeoutMs: 30_000 });
    return r.exitCode === 0 ? parseDevices(readFileSync(out, "utf8")) : [];
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The choices of the projects whose recipe can install on a device.
export function deployChoices(recipes: [string, Recipe][], devices: Device[]): DeployChoices {
  const out: DeployChoices = {};
  for (const [name, r] of recipes) {
    if (!r.device_deploy_cmd) continue;
    out[name] = { usual: r.deploy_cmd ? (r.targets ?? []).map((t) => t.name).join(", ") || "its deploy step" : "no deploy (built only)", devices };
  }
  return out;
}

export const deviceLabel = (d: Device) => `${d.name} · ${d.model}`;

// What a request of these projects may deploy to, as the runner it goes to reported it: the projects that can
// install on a device, their own deploys' targets, and the devices.
export type Choices = { projects: string[]; usual: string[]; devices: Device[] };

export function choicesFor(db: Database, projects: string[]): Choices {
  const ps = projects.map((name) => db.query("SELECT name, runners FROM projects WHERE name = ?").get(name) as { name: string; runners: string | null } | null)
    .filter((p) => p !== null);
  const holder = eligible(ps)[0];
  const row = holder ? db.query("SELECT devices FROM leases WHERE holder = ?").get(holder) as { devices: string | null } | null : null;
  const all = row?.devices ? JSON.parse(row.devices) as DeployChoices : {};
  return merge(ps.filter((p) => all[p.name]).map((p) => ({ projects: [p.name], usual: [all[p.name].usual], devices: all[p.name].devices })));
}

// Several projects' choices as one list, each device once.
export function merge(cs: Choices[]): Choices {
  const devices = new Map(cs.flatMap((c) => c.devices).map((d) => [d.id, d]));
  return { projects: cs.flatMap((c) => c.projects), usual: [...new Set(cs.flatMap((c) => c.usual))], devices: [...devices.values()] };
}
