import { readFileSync } from "node:fs";

import {
  createSettingsService,
  operatorCliActor,
  SettingsError,
  type SettingChange,
  type SettingsApplyResult,
  type SettingsService,
  type SettingView,
} from "@openscout/runtime";
import "./profile-hooks.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export function renderSettingsCommandHelp(): string {
  return [
    "usage: scout settings list",
    "       scout settings get <id>",
    "       scout settings set <id> <value> [--dry-run]",
    "       scout settings unset <id> [--dry-run]",
    "       scout settings apply <file.json> [--dry-run]",
    "",
    "One entry point for Scout settings. Every value is checked against the",
    "settings catalog, and every change is recorded in the settings change log.",
    "Add --json to any command for structured output.",
    "",
    "Risk:",
    "  apply    any caller may change it",
    "  confirm  the operator must approve it (you approve by running the command)",
    "  never    cannot be changed here",
    "",
    "apply reads a JSON object of setting id to value; null unsets a setting:",
    '  { "verbosity": "detailed", "agent-names": ["ada", "grace"], "bio": null }',
    "It checks the whole file, prints the diff and the risk of each change, and",
    "writes nothing unless every change is valid. --dry-run never writes.",
    "",
    "scout config is the older interface to the profile settings and still works.",
  ].join("\n");
}

function displayValue(text: string): string {
  return text.trim() ? text : "(unset)";
}

function viewValue(view: SettingView): string {
  if (!view.display.trim()) return "—";
  return view.isSet ? view.display : `${view.display} (default)`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderList(settings: SettingView[]): string {
  const idWidth = Math.max(2, ...settings.map((setting) => setting.id.length)) + 2;
  const lines = [`${pad("ID", idWidth)}${pad("RISK", 9)}${pad("KIND", 13)}VALUE`];
  for (const setting of settings) {
    lines.push(`${pad(setting.id, idWidth)}${pad(setting.risk, 9)}${pad(setting.kind, 13)}${viewValue(setting)}`);
  }
  return lines.join("\n");
}

function renderGet(view: SettingView): string {
  const kind = view.kind === "enum" ? `enum (${(view.enumValues ?? []).join(", ")})` : view.kind;
  return [
    `${view.id}: ${viewValue(view)}`,
    `  ${view.description}`,
    `  kind: ${kind}`,
    `  risk: ${view.risk}`,
    `  scope: ${view.scope}`,
    `  stored in: ${view.owner.path} (${view.owner.key})`,
  ].join("\n");
}

function renderChange(change: SettingChange, idWidth: number): string {
  const approval = change.approval === "required"
    ? "  needs operator approval"
    : change.approval === "operator" ? "  approved by operator" : "";
  return `  ${pad(change.id, idWidth)}${pad(change.risk, 9)}${displayValue(change.fromDisplay)} → ${displayValue(change.toDisplay)}${approval}`;
}

function renderApplyResult(result: SettingsApplyResult): string {
  const count = result.changes.length;
  const noun = count === 1 ? "change" : "changes";
  const headline = {
    "applied": `Applied ${count} ${noun}.`,
    "dry-run": `Dry run: ${count} ${noun}. Nothing written.`,
    "needs-approval": `Needs operator approval for: ${result.needsApproval.join(", ")}. Nothing written.`,
    "unchanged": "No changes: every value already matches.",
  }[result.status];
  const idWidth = Math.max(2, ...result.changes.map((change) => change.id.length)) + 2;
  return [
    headline,
    ...result.changes.map((change) => renderChange(change, idWidth)),
    ...(result.unchanged.length ? [`Unchanged: ${result.unchanged.join(", ")}`] : []),
  ].join("\n");
}

function readPatchFile(path: string): Record<string, unknown> {
  let body: string;
  try {
    body = readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch (error) {
    throw new ScoutCliError(`could not read settings file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new ScoutCliError(`settings file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScoutCliError(`settings file ${path} must hold a JSON object of setting id to value`);
  }
  return parsed as Record<string, unknown>;
}

function takeFlags(args: string[]): { positional: string[]; dryRun: boolean } {
  const positional: string[] = [];
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--") && arg.length > 2) {
      throw new ScoutCliError(`unknown flag for scout settings: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, dryRun };
}

export async function runSettingsCommand(
  context: ScoutCommandContext,
  args: string[],
  service: SettingsService = createSettingsService(),
): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) {
    context.output.writeText(renderSettingsCommandHelp());
    return;
  }

  try {
    const { positional, dryRun } = takeFlags(rest);
    const writeOptions = {
      actor: operatorCliActor("scout settings"),
      dryRun,
      context: { currentDirectory: defaultScoutContextDirectory(context) },
    };

    switch (command) {
      case "list": {
        const settings = service.list();
        context.output.writeValue({ settings }, (value) => renderList(value.settings));
        return;
      }
      case "get": {
        const [id] = positional;
        if (!id || positional.length > 1) throw new ScoutCliError("usage: scout settings get <id>");
        context.output.writeValue(service.get(id), renderGet);
        return;
      }
      case "set": {
        const [id, ...words] = positional;
        if (!id || words.length === 0) {
          throw new ScoutCliError("usage: scout settings set <id> <value> (use scout settings unset <id> to clear)");
        }
        const value = service.parseInput(id, words);
        const result = await service.set(id, value, writeOptions);
        context.output.writeValue(result, renderApplyResult);
        return;
      }
      case "unset": {
        const [id] = positional;
        if (!id || positional.length > 1) throw new ScoutCliError("usage: scout settings unset <id>");
        const result = await service.unset(id, writeOptions);
        context.output.writeValue(result, renderApplyResult);
        return;
      }
      case "apply": {
        const [path] = positional;
        if (!path || positional.length > 1) throw new ScoutCliError("usage: scout settings apply <file.json> [--dry-run]");
        const result = await service.apply(readPatchFile(path), writeOptions);
        context.output.writeValue(result, renderApplyResult);
        return;
      }
      default:
        throw new ScoutCliError(`unknown settings command: ${command}\n${renderSettingsCommandHelp()}`);
    }
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    if (context.output.mode === "json") {
      context.output.writeText(JSON.stringify({ error: error.code, issues: error.issues }, null, 2));
      process.exitCode = 1;
      return;
    }
    throw new ScoutCliError(error.message);
  }
}
