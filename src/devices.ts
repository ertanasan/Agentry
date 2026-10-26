// The real devices a project installs on (its recipe's devices, with a device_deploy_cmd), a deploy target beside the
// project's own (its targets, e.g. TestFlight). Each runner reports its projects' choices from its own recipes with
// its lease (queue.setDevices), so the queue owner's pages offer them for the projects a request is for.
import type { Database } from "bun:sqlite";
import type { Device, Recipe } from "./recipe.ts";
import { eligible } from "./routing.ts";

export type { Device };
// By project: what its own deploy reaches, and the devices it can install on instead.
export type DeployChoices = Record<string, { usual: string; devices: Device[] }>;

// The choices of the projects whose recipe defines devices.
export function deployChoices(recipes: [string, Recipe][]): DeployChoices {
  const out: DeployChoices = {};
  for (const [name, r] of recipes) {
    if (!r.device_deploy_cmd || !r.devices?.length) continue;
    out[name] = { usual: r.deploy_cmd ? (r.targets ?? []).map((t) => t.name).join(", ") || "its deploy step" : "no deploy (built only)", devices: r.devices };
  }
  return out;
}

export const deviceLabel = (d: Device) => d.model ? `${d.name} · ${d.model}` : d.name;

// What a request of these projects may deploy to, as the runner it goes to reported it: the projects that can
// install on a device, their own deploys' targets, and the devices.
export type Choices = { projects: string[]; usual: string[]; devices: Device[] };

export function choicesFor(db: Database, projects: string[]): Choices {
  const ps = projects.map((name) => db.query("SELECT name, runners FROM projects WHERE name = ?").get(name) as { name: string; runners: string | null } | null)
    .filter((p) => p !== null);
  const holder = eligible(ps)[0];
  const row = holder ? db.query("SELECT devices FROM leases WHERE holder = ?").get(holder) as { devices: string | null } | null : null;
  const all = row?.devices ? JSON.parse(row.devices) as DeployChoices : {};
  const cs = ps.filter((p) => all[p.name]).map((p) => ({ projects: [p.name], usual: [all[p.name].usual], devices: all[p.name].devices }));
  const devices = new Map(cs.flatMap((c) => c.devices).map((d) => [d.id, d]));
  return { projects: cs.flatMap((c) => c.projects), usual: [...new Set(cs.flatMap((c) => c.usual))], devices: [...devices.values()] };
}

// Each of these projects' choices, for the new-request form, which offers those of the projects selected.
export function choicesByProject(db: Database, projects: string[]): DeployChoices {
  const out: DeployChoices = {};
  for (const name of projects) {
    const c = choicesFor(db, [name]);
    if (c.devices.length) out[name] = { usual: c.usual[0], devices: c.devices };
  }
  return out;
}
