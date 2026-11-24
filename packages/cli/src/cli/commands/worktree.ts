import { homedir } from "node:os";
import { resolve } from "node:path";

import { scoutBrokerPaths, type AgentEndpoint, type NodeDefinition } from "@openscout/protocol";
import { requestScoutBrokerJson } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";
import {
  gcScoutWorktrees,
  listScoutWorktrees,
  type ScoutWorktreeGcReport,
  type ScoutWorktreeList,
} from "@openscout/runtime/harnesses";

import { defaultScoutContextDirectory, type ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export function renderWorktreeCommandHelp(): string {
  return [
    "Usage:",
    "  scout worktree list [--project <path>] [--base <ref>] [--json]",
    "  scout worktree gc [--project <path>] [--base <ref>] [--dry-run] [--json]",
    "",
    "Inspect or remove Git worktrees directly under <project>/.scout-worktrees/.",
    "The project defaults to the current directory. The base defaults to origin/main, then main, then HEAD.",
    "GC keeps dirty, unmerged and locked worktrees. It also checks the local runtime for active sessions.",
    "If the runtime is unavailable, verify that no agents are using the worktrees before running GC.",
    "GC never forces removal or branch deletion. Ignored files do not count as changes.",
    "Use gc --dry-run to preview removal without changing files or Git metadata.",
    "Use scout worktrees for the runtime's idle retirement policy.",
  ].join("\n");
}

type WorktreeOptions = {
  command: "list" | "gc";
  projectRoot: string;
  baseRef?: string;
  dryRun: boolean;
  json: boolean;
};

export function parseWorktreeCommandOptions(args: string[], cwd: string): WorktreeOptions | null {
  if (args[0] === "help" || args.some(arg => arg === "--help" || arg === "-h")) return null;
  const [command, ...flags] = args;
  if (command !== "list" && command !== "gc") {
    throw new ScoutCliError("Use scout worktree list or scout worktree gc. See scout worktree --help.");
  }
  const options: WorktreeOptions = { command, projectRoot: cwd, dryRun: false, json: false };
  let projectSpecified = false;
  for (let i = 0; i < flags.length; i++) {
    const arg = flags[i]!;
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--dry-run") {
      if (command !== "gc") throw new ScoutCliError("--dry-run applies only to scout worktree gc.");
      options.dryRun = true;
      continue;
    }
    const equal = arg.indexOf("=");
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (flag !== "--project" && flag !== "--base") throw new ScoutCliError(`Unknown worktree option: ${arg}`);
    const value = equal < 0 ? flags[++i] : arg.slice(equal + 1);
    if (!value?.trim() || value.startsWith("-") || value.includes("\0")) {
      throw new ScoutCliError(`${flag} requires a non-empty ${flag === "--base" ? "Git ref" : "path"} that does not start with '-'.`);
    }
    if (flag === "--project") {
      if (projectSpecified) throw new ScoutCliError("--project may appear only once.");
      options.projectRoot = resolve(cwd, value.replace(/^~(?=$|\/)/, homedir()));
      projectSpecified = true;
    } else {
      if (options.baseRef !== undefined) throw new ScoutCliError("--base may appear only once.");
      options.baseRef = value;
    }
  }
  return options;
}

const INACTIVE_STATES: ReadonlySet<AgentEndpoint["state"]> = new Set(["offline", "stopped", "failed", "superseded"]);

async function readActivePaths(context: ScoutCommandContext): Promise<ReadonlySet<string>> {
  // Even offline, keep the worktree where this command is running.
  const paths = new Set([context.cwd]);
  try {
    const baseUrl = context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
    const options = {
      socketPath: context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined,
      signal: AbortSignal.timeout(2_000),
    };
    const [{ endpoints }, node] = await Promise.all([
      requestScoutBrokerJson<{ endpoints: AgentEndpoint[] }>(baseUrl, scoutBrokerPaths.v1.endpoints, options),
      // If the node read fails, keep matching paths from any returned endpoint.
      requestScoutBrokerJson<Pick<NodeDefinition, "id">>(baseUrl, scoutBrokerPaths.v1.node, options).catch(() => null),
    ]);
    for (const endpoint of endpoints) {
      if (node?.id && endpoint.nodeId !== node.id) continue;
      if (INACTIVE_STATES.has(endpoint.state)) continue;
      const cwd = endpoint.cwd || endpoint.metadata?.cwd;
      if (typeof cwd === "string" && cwd) paths.add(cwd);
    }
  } catch {
    context.stderr("Warning: Scout could not check active sessions. Verify that no agents are using these worktrees before removing them.");
  }
  return paths;
}

function renderReport(report: ScoutWorktreeList | ScoutWorktreeGcReport): string {
  const lines = [`Scout worktrees in ${report.projectRoot} (base: ${report.baseRef})`];
  if ("dryRun" in report && report.dryRun) lines.push("Dry run: no files or Git metadata changed.");
  if (!report.worktrees.length) lines.push("No registered Scout worktrees.");
  for (const entry of report.worktrees) {
    const action = "action" in entry ? entry.action : entry.eligible ? "eligible" : "kept";
    const label = action === "would_remove" ? "would remove" : action;
    const reason = entry.skipReason ? ` (${entry.skipReason})` : "";
    lines.push(`  ${label}${reason}: ${entry.path} [${entry.branch ?? "detached HEAD"} ${entry.head.slice(0, 12)}]`);
    if (entry.error) lines.push(`    ${entry.error}`);
  }
  if ("warnings" in report) lines.push(...report.warnings.map(warning => `  Warning: ${warning}`));
  return lines.join("\n");
}

export async function runWorktreeCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseWorktreeCommandOptions(args, defaultScoutContextDirectory(context));
  if (!options) { context.output.writeText(renderWorktreeCommandHelp()); return; }
  const activePaths = await readActivePaths(context);
  const input = { baseRef: options.baseRef, activePaths };
  const report = options.command === "gc"
    ? await gcScoutWorktrees(options.projectRoot, { ...input, dryRun: options.dryRun })
    : await listScoutWorktrees(options.projectRoot, input);
  if (options.json) context.output.writeText(JSON.stringify(report, null, 2));
  else context.output.writeValue(report, renderReport);
}
