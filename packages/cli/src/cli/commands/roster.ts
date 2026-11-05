import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  scoutBrokerPaths,
  type AgentRosterEntry,
  type AgentRosterImportEntry,
  type AgentRosterImportResult,
  type AgentRosterListResult,
  type AgentRosterResolveResult,
  type RosterProjectRecord,
} from "@openscout/protocol";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);

export function renderRosterCommandHelp(): string {
  return [
    "Usage:",
    "  scout roster [list]                      Every numbered agent and every project code",
    "  scout roster project <name> <code>       Set a project's code (two or three letters)",
    "  scout roster project <name> --reset      Give a project back its default code",
    "  scout roster import <file|-> [--dry-run] Take the numbers the apps handed out locally",
    "  scout roster resolve <code>              Show which agent OS-003, os003 or 003 names",
    "",
    "Each agent the runtime lists holds a roster number from 001 to 999, one roster",
    "across projects, kept by its agent id: agents that share a handle hold one each.",
    "Its project holds a code, so the agent reads as OS 003 and is addressed as OS-003,",
    "os003 or 003 wherever an agent target is accepted (scout ask --to OS-003).",
    "",
    "The import file is JSON: a list of { \"agentId\", \"number\", \"projectCode\" },",
    "or { \"entries\": [...] }. Numbers may be 3 or \"003\". Conflicts are reported, never guessed.",
    "",
    "Add --json to any form for the broker's JSON.",
  ].join("\n");
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, resolveScoutBrokerUrl()), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) throw new ScoutCliError(payload.detail ?? payload.error ?? `broker returned HTTP ${response.status}`);
  return payload;
}

function renderEntry(entry: AgentRosterEntry): string {
  const label = entry.label.padEnd(8);
  const gone = entry.goneAt ? "  (gone; number frees soon)" : "";
  return `${label} ${entry.agentId}${entry.project ? `  · ${entry.project}` : ""}${gone}`;
}

function renderProject(project: RosterProjectRecord): string {
  const code = (project.code ?? "—").padEnd(4);
  const source = project.codeSource === "default" ? "default" : `${project.codeSource}; default ${project.defaultCode}`;
  return `${code} ${project.name}  (${source})`;
}

function renderList(result: AgentRosterListResult): string {
  if (result.agents.length === 0) return "No agent holds a roster number yet.";
  const projectKeys = new Set(result.agents.map((entry) => entry.projectKey).filter(Boolean));
  const projects = result.projects.filter((project) => projectKeys.has(project.projectKey));
  return [
    ...result.agents.map(renderEntry),
    "",
    `${result.capacity.held} of ${result.capacity.max} numbers held.`,
    ...(projects.length ? ["", "Project codes:", ...projects.map((project) => `  ${renderProject(project)}`)] : []),
  ].join("\n");
}

function renderImport(result: AgentRosterImportResult): string {
  const lines: string[] = [result.dryRun ? "Dry run: nothing was written." : "Imported."];
  for (const entry of result.imported) lines.push(`  ${entry.code.padEnd(8)} ${entry.agentId}`);
  if (result.renumbered.length) {
    lines.push("", "Moved aside (numbered by the runtime, not the apps):");
    for (const entry of result.renumbered) {
      lines.push(`  ${entry.agentId}: ${String(entry.from).padStart(3, "0")} → ${entry.to === null ? "none (roster full)" : String(entry.to).padStart(3, "0")}`);
    }
  }
  if (result.projectCodes.length) {
    lines.push("", "Project codes set:");
    for (const entry of result.projectCodes) lines.push(`  ${entry.code.padEnd(4)} ${entry.projectKey}`);
  }
  if (result.conflicts.length) {
    lines.push("", `Conflicts (${result.conflicts.length}):`);
    for (const conflict of result.conflicts) lines.push(`  ${conflict.agentId || "(no agent id)"}: ${conflict.reason}: ${conflict.detail}`);
  }
  return lines.join("\n");
}

/** Read an import file: a list of entries, or `{ entries }`. */
export function parseRosterImportFile(text: string): AgentRosterImportEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ScoutCliError(`the import file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { entries?: unknown }).entries)
    ? (value as { entries: unknown[] }).entries
    : null;
  if (!entries) throw new ScoutCliError("the import file must be a list of { agentId, number, projectCode } or { \"entries\": [...] }");
  return entries as AgentRosterImportEntry[];
}

export async function runRosterCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderRosterCommandHelp());
    return;
  }
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "list";
  const rest = args[0] === command ? args.slice(1) : args;
  const positional = rest.filter((arg) => !arg.startsWith("--"));

  if (command === "list" || command === "ls") {
    const result = await requestJson<AgentRosterListResult>(scoutBrokerPaths.v1.roster);
    context.output.writeValue(result, renderList);
    return;
  }

  if (command === "project") {
    const [project, code] = positional;
    const reset = rest.includes("--reset");
    if (!project || (!code && !reset) || (code && reset)) {
      throw new ScoutCliError("usage: scout roster project <name> <code>, or scout roster project <name> --reset");
    }
    const result = await requestJson<{ project: RosterProjectRecord }>(scoutBrokerPaths.v1.rosterProjectCode, {
      method: "POST",
      body: JSON.stringify({ project, code: reset ? null : code }),
    });
    context.output.writeValue(result, ({ project: record }) => `${record.name} is ${record.code ?? "without a code"} (${record.codeSource})`);
    return;
  }

  if (command === "import") {
    const file = positional[0];
    if (!file) throw new ScoutCliError("usage: scout roster import <file|-> [--dry-run]");
    const text = await readFile(file === "-" ? "/dev/stdin" : resolve(context.cwd, file), "utf8");
    const entries = parseRosterImportFile(text);
    const result = await requestJson<AgentRosterImportResult>(scoutBrokerPaths.v1.rosterImport, {
      method: "POST",
      body: JSON.stringify({ entries, dryRun: rest.includes("--dry-run") }),
    });
    context.output.writeValue(result, renderImport);
    return;
  }

  if (command === "resolve") {
    const address = positional.join(" ");
    if (!address) throw new ScoutCliError("usage: scout roster resolve <code>");
    const result = await requestJson<AgentRosterResolveResult>(scoutBrokerPaths.v1.rosterResolve, {
      method: "POST",
      body: JSON.stringify({ address }),
    });
    context.output.writeValue(result, (value) => value.resolved && value.entry
      ? renderEntry(value.entry)
      : value.diagnostic?.detail ?? `${address} names no agent`);
    if (!result.resolved && context.output.mode !== "json") process.exitCode = 1;
    return;
  }

  throw new ScoutCliError(`unknown roster command: ${command}\n\n${renderRosterCommandHelp()}`);
}
