import { createInterface } from "node:readline";

import { formatScoutPermissionProfiles } from "@openscout/protocol";
import { resolveLocalAgentByName, resolveLocalAgentIdentity, SUPPORTED_LOCAL_AGENT_HARNESSES } from "@openscout/runtime/harnesses";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { parseCardCreateCommandOptions } from "../options.ts";
import { cleanupScoutAgentCards, createScoutAgentCard, retireScoutAgentCard, updateScoutAgentCard } from "../../lib/core/agents/service.ts";
import { parseScoutLocalHarness, resolveScoutAgentName } from "../../lib/core/broker/service.ts";
import { renderScoutAgentCard } from "../../lib/ui/terminal/cards.ts";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);

export function renderCardCommandHelp(): string {
  return [
    "Usage:",
    `  scout card create [path] [--name <alias>] [--display-name <name>] [--harness <${SUPPORTED_LOCAL_AGENT_HARNESSES.join("|")}>] [--provider <provider>] [--model <model>] [--reasoning-effort <effort>] [--permission-profile <profile>] [--as <requester>] [--one-time] [--no-input] [--path <path>]`,
    `  scout card update <agent> [--harness <${SUPPORTED_LOCAL_AGENT_HARNESSES.join("|")}>] [--model <model>|--clear-model] [--reasoning-effort <effort>|--clear-reasoning-effort] [--permission-profile <${formatScoutPermissionProfiles()}>|--clear-permission-profile] [--restart]`,
    "  scout card cleanup [--all]",
    "  scout card retire <agent>",
    "",
    "Create, update, or retire a dedicated Scout agent card with a reply-ready return address.",
    "",
    "Use this when another agent should get back to you on a fresh project-scoped inbox,",
    "or when a worktree needs its own obvious handle instead of reusing a shared project agent.",
    "",
    "Examples:",
    "  scout card create",
    '  scout card create ~/dev/openscout-worktrees/shell-fix --name shellfix --harness claude --model claude-sonnet-4-6',
    "  scout card create --one-time --name review",
    "  scout card cleanup",
    "  scout card update talkie-drift-investigator --harness claude --model claude-opus-4-7",
    "  scout card retire talkie-drift-investigator",
  ].join("\n");
}

type CardUpdateOptions = {
  harness?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionProfile?: string | null;
  restart: boolean;
};

function readRequiredFlagValue(args: string[], index: number, flag: string): { value: string; index: number } {
  const current = args[index] ?? "";
  if (current.startsWith(`${flag}=`)) {
    return { value: current.slice(flag.length + 1), index };
  }
  const value = args[index + 1];
  if (!value) {
    throw new ScoutCliError(`missing value for ${flag}`);
  }
  return { value, index: index + 1 };
}

function parseCardUpdateOptions(args: string[]): { target: string; options: CardUpdateOptions } {
  const target = args[0]?.trim();
  if (!target) {
    throw new ScoutCliError(renderCardCommandHelp());
  }

  const options: CardUpdateOptions = { restart: false };
  for (let index = 1; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (current === "--harness" || current.startsWith("--harness=")) {
      const parsed = readRequiredFlagValue(args, index, "--harness");
      options.harness = parsed.value;
      index = parsed.index;
      continue;
    }
    if (current === "--model" || current.startsWith("--model=")) {
      const parsed = readRequiredFlagValue(args, index, "--model");
      options.model = parsed.value;
      index = parsed.index;
      continue;
    }
    if (current === "--clear-model") {
      options.model = null;
      continue;
    }
    if (current === "--reasoning-effort" || current === "--effort" || current.startsWith("--reasoning-effort=") || current.startsWith("--effort=")) {
      const flag = current.startsWith("--effort") ? "--effort" : "--reasoning-effort";
      const parsed = readRequiredFlagValue(args, index, flag);
      options.reasoningEffort = parsed.value;
      index = parsed.index;
      continue;
    }
    if (current === "--clear-reasoning-effort") {
      options.reasoningEffort = null;
      continue;
    }
    if (current === "--permission-profile" || current.startsWith("--permission-profile=")) {
      const parsed = readRequiredFlagValue(args, index, "--permission-profile");
      options.permissionProfile = parsed.value;
      index = parsed.index;
      continue;
    }
    if (current === "--clear-permission-profile") {
      options.permissionProfile = null;
      continue;
    }
    if (current === "--restart") {
      options.restart = true;
      continue;
    }
    if (current.startsWith("--")) {
      throw new ScoutCliError(`unexpected argument for card update: ${current}`);
    }
    throw new ScoutCliError(`unexpected arguments for card update: ${args.join(" ")}`);
  }

  return { target, options };
}

async function resolveCardAgentId(target: string): Promise<string> {
  const resolved = await resolveLocalAgentByName(target)
    ?? await resolveLocalAgentByName(target, { matchProjectName: true });
  if (!resolved) {
    throw new ScoutCliError(`unknown Scout card "${target}"`);
  }
  return resolved.agentId;
}

function renderCardUpdateResult(value: {
  agentId: string;
  config: NonNullable<Awaited<ReturnType<typeof updateScoutAgentCard>>>;
  restarted: boolean;
}): string {
  return [
    `Updated ${value.agentId}`,
    `Harness: ${value.config.runtime.harness}`,
    `Transport: ${value.config.runtime.transport}`,
    `Session: ${value.config.runtime.sessionId}`,
    `Model: ${value.config.model ?? "default"}`,
    `Permission: ${value.config.permissionProfile ?? "default"}`,
    `Restarted: ${value.restarted ? "yes" : "no"}`,
  ].join("\n");
}

function renderCardRetireResult(value: Awaited<ReturnType<typeof retireScoutAgentCard>>): string {
  if (!value) {
    return "Agent not found.";
  }
  return `Retired ${value.agentId}`;
}

function renderCardCleanupResult(value: Awaited<ReturnType<typeof cleanupScoutAgentCards>>): string {
  const count = value.retired.length;
  if (count === 0) {
    return `No one-time cards retired. Inspected ${value.inspected}.`;
  }
  const agents = value.retired.map((agent) => `- ${agent.agentId}`).join("\n");
  return [
    `Retired ${count} one-time card${count === 1 ? "" : "s"}.`,
    agents,
  ].join("\n");
}

function promptWithDefault(question: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`  ${question} [${defaultValue}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

export async function runCardCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const subcommand = args[0] ?? "";
  if (!subcommand || HELP_FLAGS.has(subcommand)) {
    context.output.writeText(renderCardCommandHelp());
    return;
  }
  if (subcommand === "update") {
    if (args.slice(1).some((arg) => HELP_FLAGS.has(arg))) {
      context.output.writeText(renderCardCommandHelp());
      return;
    }
    const { target, options } = parseCardUpdateOptions(args.slice(1));
    const agentId = await resolveCardAgentId(target);
    const config = await updateScoutAgentCard(agentId, {
      harness: parseScoutLocalHarness(options.harness),
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      permissionProfile: options.permissionProfile,
      restart: options.restart,
    });
    if (!config) {
      throw new ScoutCliError(`unknown Scout card "${target}"`);
    }
    context.output.writeValue(
      { agentId, config, restarted: options.restart },
      renderCardUpdateResult,
    );
    return;
  }
  if (subcommand === "retire" || subcommand === "delete" || subcommand === "remove") {
    if (args.slice(1).some((arg) => HELP_FLAGS.has(arg))) {
      context.output.writeText(renderCardCommandHelp());
      return;
    }
    const target = args[1]?.trim();
    if (!target || args.length > 2) {
      throw new ScoutCliError(renderCardCommandHelp());
    }
    const agentId = await resolveCardAgentId(target);
    const retired = await retireScoutAgentCard(agentId);
    context.output.writeValue(retired, renderCardRetireResult);
    return;
  }
  if (subcommand === "cleanup" || subcommand === "prune") {
    if (args.slice(1).some((arg) => HELP_FLAGS.has(arg))) {
      context.output.writeText(renderCardCommandHelp());
      return;
    }
    let all = false;
    for (const arg of args.slice(1)) {
      if (arg === "--all") {
        all = true;
        continue;
      }
      throw new ScoutCliError(`unexpected argument for card cleanup: ${arg}`);
    }
    const cleaned = await cleanupScoutAgentCards({
      currentDirectory: defaultScoutContextDirectory(context),
      maxCount: all ? 0 : undefined,
    });
    context.output.writeValue(cleaned, renderCardCleanupResult);
    return;
  }
  if (subcommand !== "create") {
    throw new ScoutCliError(renderCardCommandHelp());
  }
  if (args.slice(1).some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderCardCommandHelp());
    return;
  }

  const options = parseCardCreateCommandOptions(args.slice(1), defaultScoutContextDirectory(context));

  let agentName = options.agentName;
  let displayName = options.displayName;

  const shouldPrompt = context.isTty && !options.noInput && !options.agentName && !options.displayName;

  if (shouldPrompt) {
    const identity = await resolveLocalAgentIdentity({
      projectPath: options.projectPath,
      agentName: options.agentName,
      displayName: options.displayName,
      harness: parseScoutLocalHarness(options.harness),
      currentDirectory: options.currentDirectory,
    });

    context.stderr("");
    context.stderr("  Proposed agent card:");
    context.stderr(`    Alias:   ${identity.definitionId}`);
    context.stderr(`    Display: ${identity.displayName}`);
    if (identity.branch) {
      context.stderr(`    Branch:  ${identity.branch}`);
    }
    context.stderr(`    Node:    ${identity.nodeQualifier}`);
    context.stderr(`    Harness: ${identity.harness}`);
    context.stderr(`    Source:  ${identity.source === "config" ? "project config" : identity.source === "existing" ? "existing agent" : "auto-detected"}`);
    context.stderr("");

    const confirmedAlias = await promptWithDefault("Alias", identity.definitionId);
    const confirmedDisplayName = await promptWithDefault("Display name", identity.displayName);
    context.stderr("");

    if (confirmedAlias !== identity.definitionId) {
      agentName = confirmedAlias;
    }
    if (confirmedDisplayName !== identity.displayName) {
      displayName = confirmedDisplayName;
    }
  }

  const card = await createScoutAgentCard({
    projectPath: options.projectPath,
    agentName: agentName,
    displayName: displayName,
    harness: parseScoutLocalHarness(options.harness),
    model: options.model,
    provider: options.provider,
    reasoningEffort: options.reasoningEffort,
    permissionProfile: options.permissionProfile,
    currentDirectory: options.currentDirectory,
    createdById: resolveScoutAgentName(options.requesterId),
    oneTimeUse: options.oneTimeUse,
  });

  context.output.writeValue(card, renderScoutAgentCard);
}
