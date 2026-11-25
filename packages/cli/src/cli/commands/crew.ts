import {
  listBuiltinCrewSlotProfiles,
  type CrewCheckReport,
  type CrewConfigIssue,
  type CrewPreset,
  type CrewSlotProfile,
  type ResolvedCrewRole,
} from "@openscout/protocol";
import {
  checkCrewState,
  loadCrewState,
  saveCrewPreset,
  setCrewRole,
  unsetCrewRole,
  useCrewPreset,
  type CrewReachabilityChecker,
  type CrewScope,
} from "@openscout/runtime/crew";

import { createCliCrewReachabilityChecker } from "../../lib/core/crew/service.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

export type CrewCommandOptions =
  | { command: "help" }
  | { command: "list"; currentDirectory: string }
  | {
      command: "set";
      role: string;
      runtime: string;
      pool?: number;
      fallback?: string[];
      host?: string;
      note?: string;
      scope: CrewScope;
      currentDirectory: string;
    }
  | {
      command: "unset";
      role: string;
      scope: CrewScope;
      currentDirectory: string;
    }
  | {
      command: "preset-save";
      name: string;
      note?: string;
      scope: CrewScope;
      currentDirectory: string;
    }
  | {
      command: "preset-use";
      name: string;
      scope: CrewScope;
      currentDirectory: string;
    }
  | {
      command: "preset-list";
      currentDirectory: string;
    }
  | {
      command: "check";
      currentDirectory: string;
    };

export function renderCrewCommandHelp(): string {
  return [
    "Usage: scout crew <command> [options]",
    "",
    "Manage economic and behavioral role bindings in ~/.openscout/crew.json",
    "and optional project overrides in <project>/.openscout/crew.json.",
    "Scout core ships no hardcoded model defaults; roles start empty until configured.",
    "",
    "Commands:",
    "  list [--json]                              List configured roles, presets, and slot profiles",
    "  set <role> <runtime> [flags]               Bind a role to a RuntimeSpec",
    "      --pool <n>                             Target parallel pool size (positive integer)",
    "      --fallback <r1,r2>                     Comma-separated fallback RuntimeSpecs",
    "      --host <host>                          Mesh host target for the primary runtime",
    "      --note <text>                          Short note describing this binding",
    "      --project                              Write to <project>/.openscout/crew.json",
    "  unset <role> [--project]                   Remove a role binding",
    "  preset save <name> [--note <text>] [--project]",
    "                                             Save current roles as a named preset",
    "  preset use <name> [--project]              Switch active roles to a saved preset",
    "  preset list [--json]                       List saved presets",
    "  check [--json]                             Validate configured roles against live harnesses & mesh",
    "",
    "Built-in slot profiles: architect, lane, worker, systems, stylist, advisor (custom names also supported).",
    "",
    "Examples:",
    "  scout crew list",
    "  scout crew set worker codex/gpt-6-sol --pool 4 --fallback claude/sonnet",
    "  scout crew set worker codex/gpt-6-sol --pool 6 --project",
    "  scout crew preset save balanced --note \"Everyday mix\"",
    "  scout crew preset use balanced",
    "  scout crew check",
  ].join("\n");
}

function takeFlagValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index] ?? "";
  if (current === flag) {
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value: next, nextIndex: index + 1 };
  }
  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length);
    if (!value) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value, nextIndex: index };
  }
  throw new ScoutCliError(`missing value for ${flag}`);
}

export function parseCrewCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): CrewCommandOptions {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    return { command: "help" };
  }

  let currentDirectory = defaultCurrentDirectory;
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (current === "--context-root" || current.startsWith("--context-root=")) {
      const parsed = takeFlagValue(args, index, "--context-root");
      currentDirectory = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (current === "--json") {
      continue;
    }
    filtered.push(current);
  }

  if (filtered.length === 0) {
    return { command: "list", currentDirectory };
  }

  const [subcommand, ...rest] = filtered;

  if (subcommand === "list") {
    if (rest.length > 0) {
      throw new ScoutCliError(`unexpected arguments for crew list: ${rest.join(" ")}`);
    }
    return { command: "list", currentDirectory };
  }

  if (subcommand === "check") {
    if (rest.length > 0) {
      throw new ScoutCliError(`unexpected arguments for crew check: ${rest.join(" ")}`);
    }
    return { command: "check", currentDirectory };
  }

  if (subcommand === "set") {
    const positionals: string[] = [];
    let pool: number | undefined;
    let fallback: string[] | undefined;
    let host: string | undefined;
    let note: string | undefined;
    let scope: CrewScope = "global";

    for (let index = 0; index < rest.length; index += 1) {
      const current = rest[index] ?? "";
      if (current === "--project") {
        scope = "project";
        continue;
      }
      if (current === "--pool" || current.startsWith("--pool=")) {
        const parsed = takeFlagValue(rest, index, "--pool");
        const parsedPool = Number(parsed.value);
        if (!Number.isSafeInteger(parsedPool) || parsedPool < 1) {
          throw new ScoutCliError(`--pool must be a positive integer (got "${parsed.value}")`);
        }
        pool = parsedPool;
        index = parsed.nextIndex;
        continue;
      }
      if (current === "--fallback" || current.startsWith("--fallback=")) {
        const parsed = takeFlagValue(rest, index, "--fallback");
        const items = parsed.value.split(",").map((item) => item.trim()).filter(Boolean);
        if (items.length === 0) {
          throw new ScoutCliError("--fallback requires at least one RuntimeSpec");
        }
        fallback = [...(fallback ?? []), ...items];
        index = parsed.nextIndex;
        continue;
      }
      if (current === "--host" || current.startsWith("--host=")) {
        const parsed = takeFlagValue(rest, index, "--host");
        host = parsed.value.trim();
        index = parsed.nextIndex;
        continue;
      }
      if (current === "--note" || current.startsWith("--note=")) {
        const parsed = takeFlagValue(rest, index, "--note");
        note = parsed.value;
        index = parsed.nextIndex;
        continue;
      }
      if (current.startsWith("-")) {
        throw new ScoutCliError(`unknown flag for crew set: ${current}`);
      }
      positionals.push(current);
    }

    if (positionals.length !== 2) {
      throw new ScoutCliError("Usage: scout crew set <role> <runtime> [--pool <n>] [--fallback <r1,r2>] [--host <host>] [--note <text>] [--project]");
    }

    return {
      command: "set",
      role: positionals[0]!,
      runtime: positionals[1]!,
      ...(pool !== undefined ? { pool } : {}),
      ...(fallback ? { fallback } : {}),
      ...(host ? { host } : {}),
      ...(note ? { note } : {}),
      scope,
      currentDirectory,
    };
  }

  if (subcommand === "unset") {
    const positionals: string[] = [];
    let scope: CrewScope = "global";
    for (const current of rest) {
      if (current === "--project") {
        scope = "project";
        continue;
      }
      if (current.startsWith("-")) {
        throw new ScoutCliError(`unknown flag for crew unset: ${current}`);
      }
      positionals.push(current);
    }
    if (positionals.length !== 1) {
      throw new ScoutCliError("Usage: scout crew unset <role> [--project]");
    }
    return {
      command: "unset",
      role: positionals[0]!,
      scope,
      currentDirectory,
    };
  }

  if (subcommand === "preset") {
    const [action, ...presetRest] = rest;
    if (!action || action === "list") {
      if (presetRest.length > 0) {
        throw new ScoutCliError(`unexpected arguments for crew preset list: ${presetRest.join(" ")}`);
      }
      return { command: "preset-list", currentDirectory };
    }
    if (action === "save") {
      const positionals: string[] = [];
      let note: string | undefined;
      let scope: CrewScope = "global";
      for (let index = 0; index < presetRest.length; index += 1) {
        const current = presetRest[index] ?? "";
        if (current === "--project") {
          scope = "project";
          continue;
        }
        if (current === "--note" || current.startsWith("--note=")) {
          const parsed = takeFlagValue(presetRest, index, "--note");
          note = parsed.value;
          index = parsed.nextIndex;
          continue;
        }
        if (current.startsWith("-")) {
          throw new ScoutCliError(`unknown flag for crew preset save: ${current}`);
        }
        positionals.push(current);
      }
      if (positionals.length !== 1) {
        throw new ScoutCliError("Usage: scout crew preset save <name> [--note <text>] [--project]");
      }
      return {
        command: "preset-save",
        name: positionals[0]!,
        ...(note ? { note } : {}),
        scope,
        currentDirectory,
      };
    }
    if (action === "use") {
      const positionals: string[] = [];
      let scope: CrewScope = "global";
      for (const current of presetRest) {
        if (current === "--project") {
          scope = "project";
          continue;
        }
        if (current.startsWith("-")) {
          throw new ScoutCliError(`unknown flag for crew preset use: ${current}`);
        }
        positionals.push(current);
      }
      if (positionals.length !== 1) {
        throw new ScoutCliError("Usage: scout crew preset use <name> [--project]");
      }
      return {
        command: "preset-use",
        name: positionals[0]!,
        scope,
        currentDirectory,
      };
    }
    throw new ScoutCliError(`unknown crew preset action: ${action} (expected save, use, or list)`);
  }

  throw new ScoutCliError(`unknown crew command: ${subcommand} (run \`scout crew --help\`)`);
}

function renderIssuesLines(issues: CrewConfigIssue[]): string[] {
  if (issues.length === 0) return [];
  return [
    "",
    "Warnings:",
    ...issues.map((issue) => `  - [${issue.source}:${issue.code}] ${issue.message}`),
  ];
}

function renderCrewListText(payload: {
  globalPath: string;
  projectPath: string | null;
  activePreset?: string;
  roles: ResolvedCrewRole[];
  presets: Array<{ name: string; active: boolean; roleCount: number; note?: string }>;
  profiles: CrewSlotProfile[];
  issues: CrewConfigIssue[];
}): string {
  const lines: string[] = [
    `Global crew: ${payload.globalPath}`,
    ...(payload.projectPath ? [`Project crew: ${payload.projectPath}`] : []),
    ...(payload.activePreset ? [`Active preset: ${payload.activePreset}`] : []),
    "",
  ];

  if (payload.roles.length === 0) {
    lines.push("Configured roles: none");
    lines.push("Configure a slot with: scout crew set <role> <runtime>");
  } else {
    lines.push("Configured roles:");
    for (const role of payload.roles) {
      const meta: string[] = [role.source];
      if (role.host) meta.push(`host:${role.host}`);
      if (role.pool !== undefined) meta.push(`pool:${role.pool}`);
      if (role.fallback?.length) meta.push(`fallback:${role.fallback.join(",")}`);
      lines.push(`  ${role.role.padEnd(12, " ")} ${role.runtime} (${meta.join(" · ")})`);
      if (role.note) {
        lines.push(`               note: ${role.note}`);
      }
    }
  }

  if (payload.presets.length > 0) {
    lines.push("", "Presets:");
    for (const preset of payload.presets) {
      const marker = preset.active ? "* " : "  ";
      const note = preset.note ? ` — ${preset.note}` : "";
      lines.push(`${marker}${preset.name.padEnd(12, " ")} ${preset.roleCount} role${preset.roleCount === 1 ? "" : "s"}${note}`);
    }
  }

  lines.push("", "Built-in slot profiles:");
  for (const profile of payload.profiles) {
    lines.push(`  ${profile.id.padEnd(12, " ")} ${profile.economics}`);
  }

  lines.push(...renderIssuesLines(payload.issues));
  return lines.join("\n");
}

function renderCrewPresetsText(payload: {
  activePreset?: string;
  presets: Array<{ name: string; active: boolean; roles: Record<string, { runtime: string }>; note?: string }>;
  issues: CrewConfigIssue[];
}): string {
  if (payload.presets.length === 0) {
    return [
      "No crew presets saved.",
      "Save current roles with: scout crew preset save <name>",
      ...renderIssuesLines(payload.issues),
    ].join("\n");
  }
  const lines = ["Crew presets:"];
  for (const preset of payload.presets) {
    const marker = preset.active ? "* " : "  ";
    const roleSummary = Object.entries(preset.roles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([role, binding]) => `${role}=${binding.runtime}`)
      .join(", ");
    lines.push(`${marker}${preset.name}${preset.note ? ` — ${preset.note}` : ""}`);
    lines.push(`    ${roleSummary || "(empty)"}`);
  }
  lines.push(...renderIssuesLines(payload.issues));
  return lines.join("\n");
}

function renderCrewCheckText(report: CrewCheckReport & { ok: boolean }): string {
  if (report.roles.length === 0) {
    return [
      "No crew roles configured.",
      "Configure a slot with: scout crew set <role> <runtime>",
      ...renderIssuesLines(report.issues),
    ].join("\n");
  }
  const lines: string[] = [
    ...(report.activePreset ? [`Active preset: ${report.activePreset}`] : []),
    "Crew reachability:",
  ];
  for (const role of report.roles) {
    const status = role.available
      ? (role.usedFallback ? "FALLBACK" : "OK")
      : "UNAVAILABLE";
    const selected = role.selectedRuntime
      ? ` -> ${role.selectedRuntime}${role.selectedHost ? `@${role.selectedHost}` : ""}`
      : "";
    lines.push(`  [${status}] ${role.role}${selected}`);
    for (const rung of role.rungs) {
      const mark = rung.available ? "+" : "-";
      const target = `${rung.runtime}${rung.host ? `@${rung.host}` : ""}`;
      lines.push(`      ${mark} ${target}: ${rung.reason}`);
    }
  }
  lines.push(...renderIssuesLines(report.issues));
  return lines.join("\n");
}

export async function runCrewCommand(
  context: ScoutCommandContext,
  args: string[],
  deps: { checker?: CrewReachabilityChecker } = {},
): Promise<void> {
  const options = parseCrewCommandOptions(args, defaultScoutContextDirectory(context));
  if (options.command === "help") {
    context.output.writeText(renderCrewCommandHelp());
    return;
  }

  if (options.command === "list") {
    const state = loadCrewState({
      currentDirectory: options.currentDirectory,
      env: context.env,
    });
    const roles = Object.values(state.roles).sort((a, b) => a.role.localeCompare(b.role));
    const presets = Object.entries(state.presets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, preset]: [string, CrewPreset]) => ({
        name,
        active: state.activePreset === name,
        roleCount: Object.keys(preset.roles).length,
        ...(preset.note ? { note: preset.note } : {}),
      }));
    const payload = {
      globalPath: state.globalPath,
      projectPath: state.projectPath,
      ...(state.activePreset ? { activePreset: state.activePreset } : {}),
      roles,
      presets,
      profiles: listBuiltinCrewSlotProfiles(),
      issues: state.issues,
    };
    context.output.writeValue(payload, renderCrewListText);
    return;
  }

  if (options.command === "set") {
    try {
      const saved = setCrewRole(
        options.role,
        {
          runtime: options.runtime,
          ...(options.pool !== undefined ? { pool: options.pool } : {}),
          ...(options.fallback ? { fallback: options.fallback } : {}),
          ...(options.host ? { host: options.host } : {}),
          ...(options.note ? { note: options.note } : {}),
        },
        {
          scope: options.scope,
          currentDirectory: options.currentDirectory,
          env: context.env,
        },
      );
      context.output.writeValue(
        saved,
        (value) => `Set ${value.scope} crew role ${value.role} = ${value.binding.runtime} (${value.path})`,
      );
    } catch (error) {
      throw new ScoutCliError(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (options.command === "unset") {
    try {
      const result = unsetCrewRole(options.role, {
        scope: options.scope,
        currentDirectory: options.currentDirectory,
        env: context.env,
      });
      context.output.writeValue(
        result,
        (value) => value.removed
          ? `Removed ${value.scope} crew role ${value.role} (${value.path})`
          : `Crew role ${value.role} was not set in ${value.scope} config (${value.path})`,
      );
    } catch (error) {
      throw new ScoutCliError(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (options.command === "preset-save") {
    try {
      const result = saveCrewPreset(options.name, {
        note: options.note,
        scope: options.scope,
        currentDirectory: options.currentDirectory,
        env: context.env,
      });
      context.output.writeValue(
        result,
        (value) => `Saved ${value.scope} crew preset ${value.name} (${Object.keys(value.preset.roles).length} role${Object.keys(value.preset.roles).length === 1 ? "" : "s"}) in ${value.path}`,
      );
    } catch (error) {
      throw new ScoutCliError(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (options.command === "preset-use") {
    try {
      const result = useCrewPreset(options.name, {
        scope: options.scope,
        currentDirectory: options.currentDirectory,
        env: context.env,
      });
      context.output.writeValue(
        result,
        (value) => `Activated ${value.scope} crew preset ${value.name} (${Object.keys(value.preset.roles).length} role${Object.keys(value.preset.roles).length === 1 ? "" : "s"}) in ${value.path}`,
      );
    } catch (error) {
      throw new ScoutCliError(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (options.command === "preset-list") {
    const state = loadCrewState({
      currentDirectory: options.currentDirectory,
      env: context.env,
    });
    const presets = Object.entries(state.presets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, preset]) => ({
        name,
        active: state.activePreset === name,
        roles: preset.roles,
        ...(preset.note ? { note: preset.note } : {}),
      }));
    const payload = {
      ...(state.activePreset ? { activePreset: state.activePreset } : {}),
      presets,
      issues: state.issues,
    };
    context.output.writeValue(payload, renderCrewPresetsText);
    return;
  }

  if (options.command === "check") {
    const state = loadCrewState({
      currentDirectory: options.currentDirectory,
      env: context.env,
    });
    const checker = deps.checker ?? createCliCrewReachabilityChecker({ env: context.env });
    const report = await checkCrewState(state, checker);
    const ok = report.roles.every((role) => role.available) && report.issues.length === 0;
    context.output.writeValue({ ok, ...report }, renderCrewCheckText);
  }
}
