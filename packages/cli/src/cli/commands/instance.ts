import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import {
  canonicalPath,
  listOpenScoutInstances,
  normalizeOpenScoutInstanceName,
  OPENSCOUT_INSTANCES_DIRECTORY,
  openScoutInstanceLiveness,
  openScoutInstanceRegistryDir,
  releaseOpenScoutInstance,
  repairOpenScoutInstanceRegistry,
  type OpenScoutInstanceLedgerEntry,
} from "@openscout/runtime/instance";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

/** The home the command reads, from its own environment first. */
function commandHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

type InstanceRow = {
  name: string;
  portBase: number;
  root: string;
  rootExists: boolean;
  checkout: string | null;
  explicitBase: boolean;
  claimedAt: string;
  entry: OpenScoutInstanceLedgerEntry;
};

export function renderInstanceCommandHelp(): string {
  return [
    "Usage: scout instance list",
    "       scout instance release <name> [--purge]",
    "       scout instance repair [--force]",
    "",
    "Non-prod OpenScout instances (OPENSCOUT_INSTANCE) and the port blocks they",
    "hold (~/.openscout/instances/.slots and .claims). `list` prunes instances",
    "whose checkout or root is gone and that no longer run.",
    "",
    "release   Drop a claim so its port block can be reused. Refused while any of",
    "          the instance's ports answer or its processes are alive.",
    "          The root it leaves behind is marked <root>/.released so repair",
    "          does not bring it back; a new claim of the name clears the mark.",
    "--purge   Also delete the instance root (its real path must be under",
    "          ~/.openscout/instances/).",
    "repair    Rebuild unreadable or missing claims from their slots and roots and",
    "          re-create missing slots, without moving any healthy instance's",
    "          block. Root evidence must name a valid instance block; released",
    "          roots are skipped. Refused when nothing is broken unless --force.",
  ].join("\n");
}

async function rows(env: NodeJS.ProcessEnv): Promise<{ rows: InstanceRow[]; corruptClaims: string[]; pruned: string[] }> {
  const registry = await listOpenScoutInstances(env, commandHome(env));
  const list = Object.entries(registry.instances)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => {
      const root = entry.root ?? join(commandHome(env), ".openscout", OPENSCOUT_INSTANCES_DIRECTORY, name);
      return {
        name,
        portBase: entry.portBase,
        root,
        rootExists: existsSync(root),
        checkout: entry.checkout ?? null,
        explicitBase: entry.explicitBase === true,
        claimedAt: new Date(entry.claimedAt).toISOString(),
        entry,
      };
    });
  return { rows: list, corruptClaims: registry.corruptClaims, pruned: registry.pruned };
}

export async function runInstanceCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    context.output.writeText(renderInstanceCommandHelp());
    return;
  }
  if (subcommand === "repair") {
    const report = repairOpenScoutInstanceRegistry(context.env, commandHome(context.env), { force: rest.includes("--force") });
    if (report.healthy) {
      context.output.writeValue(report, () =>
        "The instance registry is healthy; nothing to repair (use --force to re-check anyway).");
      return;
    }
    context.output.writeValue(report, (value) => [
      `Repaired ${openScoutInstanceRegistryDir(context.env, commandHome(context.env))}.`,
      ...value.migrated.imported.map((name) => `  imported ${name} from the legacy ledger`),
      ...(value.migrated.corrupt ? [`  legacy ledger was unreadable; kept at ${value.migrated.corrupt}`] : []),
      ...value.rebuilt.map((entry) => `  rebuilt claim ${entry.name}: block ${entry.portBase} (from ${entry.source})`),
      ...value.reslotted.map((entry) => `  re-created slot ${entry.portBase} for ${entry.name}`),
      ...value.unresolved.map((line) => `  unresolved: ${line}`),
    ].join("\n"));
    return;
  }
  if (subcommand === "list") {
    const listed = await rows(context.env);
    context.output.writeValue(
      { instances: listed.rows.map(({ entry: _entry, ...row }) => row), corruptClaims: listed.corruptClaims, pruned: listed.pruned },
      (value) => [
        ...(value.instances.length === 0 ? ["No non-prod OpenScout instances are claimed."] : value.instances.map((row) => [
          `${row.name}  broker ${row.portBase} (block ${row.portBase}-${row.portBase + 49})${row.explicitBase ? " [OPENSCOUT_INSTANCE_PORT_BASE]" : ""}`,
          `  root ${row.root}${row.rootExists ? "" : " (missing)"}`,
          ...(row.checkout ? [`  checkout ${row.checkout}`] : []),
        ].join("\n"))),
        ...value.pruned.map((name) => `pruned ${name} (checkout or root gone, nothing running)`),
        ...value.corruptClaims.map((name) => `unreadable claim for ${name}: run \`scout instance repair\``),
      ].join("\n"),
    );
    return;
  }
  if (subcommand === "release") {
    const rawName = rest.find((arg) => !arg.startsWith("-"));
    if (!rawName) throw new ScoutCliError("usage: scout instance release <name> [--purge]");
    const name = normalizeOpenScoutInstanceName(rawName);
    const purge = rest.includes("--purge");
    const current = (await rows(context.env)).rows.find((row) => row.name === name);
    if (!current) throw new ScoutCliError(`no claimed instance named "${name}" (see: scout instance list)`);
    const live = await openScoutInstanceLiveness(name, current.entry, commandHome(context.env));
    if (live.length > 0) {
      throw new ScoutCliError(`instance "${name}" is still running (${live.join(", ")}); stop it before releasing its block`);
    }
    // Check the purge target before releasing anything, on real paths: an
    // intermediate symlink must not lead the delete outside the instances tree.
    // The tree is the registry dir (~/.openscout/instances, or
    // OPENSCOUT_INSTANCE_REGISTRY); canonicalPath resolves the deepest
    // existing ancestor, so a missing tail cannot hide a symlink above it.
    const instancesDir = canonicalPath(openScoutInstanceRegistryDir(context.env, commandHome(context.env)));
    const target = canonicalPath(current.root);
    if (purge) {
      const rel = relative(instancesDir, target);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new ScoutCliError(
          `refusing to purge ${current.root}${target !== current.root ? ` (really ${target})` : ""}: it is not under ${instancesDir} (release without --purge)`,
        );
      }
    }
    const released = releaseOpenScoutInstance(name, context.env, commandHome(context.env));
    if (!released) throw new ScoutCliError(`no claimed instance named "${name}" (see: scout instance list)`);
    let purged: string | null = null;
    if (purge && existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      purged = target;
    }
    context.output.writeValue({ released: name, portBase: released.portBase, purged }, (value) =>
      `Released ${value.released} (block ${value.portBase})${value.purged ? `; deleted ${value.purged}` : ""}.`);
    return;
  }
  throw new ScoutCliError(`unknown instance subcommand: ${subcommand} (try: scout instance --help)`);
}
