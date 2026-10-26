// Where a project deploys, as entries a request picks from: its recipe's targets and its real devices. Each runner
// reports its projects' entries from its own recipes with its lease (queue.setDeployChoices), so the queue owner's
// pages offer them for the projects a request is for; this machine's own runner's are read from the projects table.
import type { Database } from "bun:sqlite";
import { parseRecipe, type Device, type Recipe, type Target } from "./recipe.ts";
import { eligible, LOCAL } from "./routing.ts";

export type { Device };
// One thing a request can deploy to. `pick`: deployed unless the request says otherwise.
export type Entry = { id: string; name: string; pick: boolean };
// By project, its entries in deploy order.
export type DeployChoices = Record<string, Entry[]>;
// What a request picked, by project; a project left out deploys its default entries.
export type Picks = Record<string, { id: string; name: string }[]>;

export const deviceLabel = (d: Device) => d.model ? `${d.name} · ${d.model}` : d.name;

// What deploying an entry runs, and the targets it reads back afterwards.
export type Step = { id: string; name: string; cmd: string; check: Target[]; device?: Device };

// A recipe's entries, in deploy order: the targets its deploy_cmd deploys together ("deploy", one entry), each
// target with a deploy_cmd of its own ("target:<name>"), then each device ("device:<udid>"). Every target is picked
// by default, and no device is.
export function stepsOf(r: Recipe): Step[] {
  const together = (r.targets ?? []).filter((t) => !t.deploy_cmd);
  return [
    ...r.deploy_cmd ? [{ id: "deploy", name: together.map((t) => t.name).join(" + ") || "its deploy step", cmd: r.deploy_cmd, check: together }] : [],
    ...(r.targets ?? []).filter((t) => t.deploy_cmd).map((t) => ({ id: `target:${t.name}`, name: t.name, cmd: t.deploy_cmd!, check: [t] })),
    ...r.device_deploy_cmd ? (r.devices ?? []).map((d) => ({ id: `device:${d.id}`, name: deviceLabel(d), cmd: r.device_deploy_cmd!, check: [], device: d })) : [],
  ];
}

export const entriesOf = (r: Recipe): Entry[] => stepsOf(r).map((s) => ({ id: s.id, name: s.name, pick: !s.device }));

// The steps a request's picks run for a recipe, in deploy order; none picked for the project: its defaults.
export function pickedSteps(r: Recipe, picked: string[] | undefined): Step[] {
  return stepsOf(r).filter((s) => picked ? picked.includes(s.id) : !s.device);
}

export function deployChoices(recipes: [string, Recipe][]): DeployChoices {
  return Object.fromEntries(recipes.map(([name, r]) => [name, entriesOf(r)]));
}

// The entries of these projects, from the runner a request of them goes to: this machine's from its recipes, an
// attached one's as it reported them (none before it has).
export function choicesFor(db: Database, projects: string[]): DeployChoices {
  const ps = projects.map((name) => db.query("SELECT name, runners, recipe FROM projects WHERE name = ?").get(name) as
    { name: string; runners: string | null; recipe: string } | null).filter((p) => p !== null);
  const holder = eligible(ps)[0];
  if (holder === LOCAL) return Object.fromEntries(ps.map((p) => [p.name, entriesOf(parseRecipe(p.recipe))]));
  const row = holder ? db.query("SELECT deploy_choices FROM leases WHERE holder = ?").get(holder) as { deploy_choices: string | null } | null : null;
  const all = row?.deploy_choices ? JSON.parse(row.deploy_choices) as DeployChoices : {};
  return Object.fromEntries(ps.filter((p) => all[p.name]).map((p) => [p.name, all[p.name]]));
}
