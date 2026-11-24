import type { CrewWhoAmISummary } from "@openscout/protocol";
import type { CrewReachabilityChecker } from "@openscout/runtime/crew";
import { findNearestProjectRoot } from "@openscout/runtime/setup";
import {
  detectCodingAgentHost,
  OPENSCOUT_AGENT_DISCOVERY,
  PROJECT_AGENT_INSTRUCTION_CANDIDATES,
  type CodingAgentHostMatch,
  type OpenScoutAgentDiscovery,
} from "@openscout/runtime";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseContextRootCommandOptions } from "../options.ts";
import {
  resolveHerdrAgentName,
  resolveScoutBrokerUrl,
  resolveScoutSenderId,
} from "../../lib/core/broker/service.ts";
import { loadCliCrewWhoAmISummary } from "../../lib/core/crew/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

type ScoutWhoAmIReport = {
  defaultSenderId: string;
  envAgent: string | null;
  herdrAgentName: string | null;
  codingAgentHost: CodingAgentHostMatch | null;
  currentDirectory: string;
  projectRoot: string | null;
  projectAgentsMd: string | null;
  brokerUrl: string;
  discovery: OpenScoutAgentDiscovery;
  crew?: CrewWhoAmISummary;
};

async function resolveProjectAgentsMd(projectRoot: string | null): Promise<string | null> {
  if (!projectRoot) {
    return null;
  }

  for (const candidate of PROJECT_AGENT_INSTRUCTION_CANDIDATES) {
    const path = join(projectRoot, candidate);
    try {
      await access(path);
      return path;
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function loadScoutWhoAmIReport(
  context: ScoutCommandContext,
  currentDirectory: string,
  deps: { crewChecker?: CrewReachabilityChecker } = {},
): Promise<ScoutWhoAmIReport> {
  const defaultSenderId = await resolveScoutSenderId(null, currentDirectory, context.env);
  const projectRoot = await findNearestProjectRoot(currentDirectory);
  const crew = await loadCliCrewWhoAmISummary({
    currentDirectory,
    projectRoot,
    env: context.env,
    checker: deps.crewChecker,
  });

  return {
    defaultSenderId,
    envAgent: context.env.OPENSCOUT_AGENT?.trim() || null,
    herdrAgentName: resolveHerdrAgentName(context.env),
    codingAgentHost: detectCodingAgentHost(context.env),
    currentDirectory,
    projectRoot,
    projectAgentsMd: await resolveProjectAgentsMd(projectRoot),
    brokerUrl: resolveScoutBrokerUrl(),
    discovery: OPENSCOUT_AGENT_DISCOVERY,
    ...(crew ? { crew } : {}),
  };
}

function renderScoutWhoAmIReport(report: ScoutWhoAmIReport): string {
  const lines = [
    `Default Sender: ${report.defaultSenderId}`,
    `Current Directory: ${report.currentDirectory}`,
  ];

  if (report.envAgent) {
    lines.push(`OPENSCOUT_AGENT: ${report.envAgent}`);
  }

  if (report.herdrAgentName) {
    lines.push(`Herdr Agent: ${report.herdrAgentName}`);
  }

  if (report.codingAgentHost) {
    lines.push(`Host Harness: ${report.codingAgentHost.harness} (${report.codingAgentHost.signal})`);
  }

  lines.push(`Broker: ${report.brokerUrl}`);

  if (report.projectRoot) {
    lines.push(`Project Root: ${report.projectRoot}`);
  }

  if (report.projectAgentsMd) {
    lines.push(`Project Instructions: ${report.projectAgentsMd}`);
  }

  if (report.crew?.activeSeat) {
    const seat = report.crew.activeSeat;
    const posture = seat.profile ? ` — ${seat.profile.economics}` : "";
    lines.push(`Active Seat: ${seat.role}${seat.runtime ? ` (${seat.runtime})` : ""}${posture}`);
    if (seat.profile) {
      lines.push(`Seat Posture: ${seat.profile.posture}`);
    }
  }

  if (report.crew && report.crew.availableRoles.length > 0) {
    const summary = report.crew.availableRoles
      .map((entry) => {
        const hostSuffix = entry.host ? `@${entry.host}` : "";
        const poolSuffix = entry.pool && entry.pool > 1 ? ` x${entry.pool}` : "";
        return `${entry.role}=${entry.runtime}${hostSuffix}${poolSuffix}`;
      })
      .join(" · ");
    const presetPrefix = report.crew.activePreset ? `[${report.crew.activePreset}] ` : "";
    lines.push(`Crew Roles: ${presetPrefix}${summary}`);
  }

  lines.push(`Discovery: ${report.discovery.agentInstructions}`);

  return lines.join("\n");
}

export function renderWhoAmICommandHelp(): string {
  return [
    "Usage: scout whoami [--context-root <path>] [--json]",
    "",
    "Show the current Scout sender and broker context.",
    "",
    "The report includes the default sender id, current directory, nearest Scout project root when found,",
    "OPENSCOUT_AGENT when it overrides the sender, detected host harness signals (Cursor, Claude Code, Codex),",
    "the broker URL the CLI will contact, OpenScout discovery URLs, available crew roles and active seat posture,",
    "and the nearest project AGENTS.md path when found.",
    "",
    "Examples:",
    "  scout whoami",
    "  scout whoami --context-root ~/dev/openscout --json",
  ].join("\n");
}

export async function runWhoAmICommand(
  context: ScoutCommandContext,
  args: string[],
  deps: { crewChecker?: CrewReachabilityChecker } = {},
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderWhoAmICommandHelp());
    return;
  }

  const options = parseContextRootCommandOptions("whoami", args, defaultScoutContextDirectory(context));
  const report = await loadScoutWhoAmIReport(context, options.currentDirectory, deps);
  context.output.writeValue(report, renderScoutWhoAmIReport);
}
