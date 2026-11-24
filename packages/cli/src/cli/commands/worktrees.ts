import { homedir } from "node:os";
import { resolve } from "node:path";

import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";
import {
  formatApproxBytes,
  type WorktreeRetirementReport,
  type WorktreeRetirementStatus,
  type WorktreeVerdict,
} from "@openscout/runtime/harnesses";
import { scoutBrokerPaths } from "@openscout/protocol";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

type WorktreesOptions = {
  command: "status" | "retire";
  dryRun: boolean;
  projects: string[];
  json: boolean;
  help: boolean;
};

export function renderWorktreesCommandHelp(): string {
  return [
    "Usage:",
    "  scout worktrees [status] [--json]",
    "  scout worktrees retire [--dry-run] [--project <path>]... [--json]",
    "",
    "Agent worktrees are the folders under <project>/.scout-worktrees/ that Scout",
    "makes for sessions asked to run in a new worktree. The runtime retires one",
    "when it is idle, clean and merged:",
    "  idle    no live session, flight or registered agent uses it, and nothing",
    "          has happened there for the idle threshold (24h by default)",
    "  clean   git status shows no changes and no untracked files",
    "  merged  its scout/<agent> branch is part of main or origin/main",
    "Retiring runs git worktree remove and git branch -d. It never forces either.",
    "",
    "status  The setting, and what the last sweep retired and kept.",
    "retire  Run one sweep now. --dry-run reports what it would retire.",
    "        --project limits the sweep to that project folder.",
    "",
    "Settings: scout config set worktree-retire on|off",
    "          scout config set worktree-retire-idle-hours <hours>",
  ].join("\n");
}

export function parseWorktreesCommandOptions(args: string[], cwd: string): WorktreesOptions {
  const result: WorktreesOptions = { command: "status", dryRun: false, projects: [], json: false, help: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h" || arg === "help") return { ...result, help: true };
    if (arg === "--json") { result.json = true; continue; }
    if (arg === "--dry-run") { result.dryRun = true; continue; }
    if (arg === "--project" || arg.startsWith("--project=")) {
      const value = arg === "--project" ? args[++index] : arg.slice("--project=".length);
      if (!value?.trim()) throw new ScoutCliError("--project needs a folder");
      result.projects.push(resolve(cwd, value.replace(/^~(?=$|\/)/, homedir())));
      continue;
    }
    if (arg.startsWith("-")) throw new ScoutCliError(`Unknown worktrees option: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 1) throw new ScoutCliError("scout worktrees takes one command: status or retire");
  const command = positional[0] ?? "status";
  if (command !== "status" && command !== "retire") throw new ScoutCliError(`Unknown worktrees command: ${command}`);
  if (command === "status" && (result.dryRun || result.projects.length > 0)) {
    throw new ScoutCliError("--dry-run and --project go with scout worktrees retire");
  }
  result.command = command;
  return result;
}

function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const ACTION_LABEL: Record<WorktreeVerdict["action"], string> = {
  retired: "retired",
  would_retire: "would retire",
  kept: "kept",
  skipped: "not Scout's",
};

function renderVerdict(verdict: WorktreeVerdict): string {
  const size = verdict.approxBytes !== undefined ? `  ${formatApproxBytes(verdict.approxBytes)}` : "";
  const head = `  ${ACTION_LABEL[verdict.action].padEnd(12)}  ${tildePath(verdict.path)}${size}`;
  return verdict.reasons.length ? `${head}\n${verdict.reasons.map((reason) => `                ${reason}`).join("\n")}` : head;
}

export function renderWorktreeRetirementReport(report: WorktreeRetirementReport): string {
  const scout = report.worktrees.filter((verdict) => verdict.action !== "skipped").length;
  const size = `${formatApproxBytes(report.approxBytesReclaimed)} by du, approximate (APFS clones share blocks, so du reads high)`;
  const head = report.dryRun
    ? `Dry run: would retire ${report.retired} of ${scout} agent worktree${scout === 1 ? "" : "s"}, ${size}. Nothing was changed.`
    : `Retired ${report.retired} of ${scout} agent worktree${scout === 1 ? "" : "s"}, ${size}.`;
  const lines = [head];
  if (report.projectRoots.length === 0) lines.push("No project with a .scout-worktrees folder is known to the runtime. Name one with --project.");
  lines.push(...report.worktrees.map(renderVerdict));
  lines.push(...report.errors.map((error) => `  note: ${error}`));
  return lines.join("\n");
}

export function renderWorktreeRetirementStatus(status: WorktreeRetirementStatus): string {
  const { settings, lastSweep } = status;
  const lines = [
    `Worktree retirement: ${settings.enabled ? "on" : "off"}, after ${settings.idleHours}h idle (the runtime sweeps every ${Math.round(status.intervalMs / 60_000)} min${settings.enabled ? "" : " when on"}).`,
  ];
  if (status.running) lines.push("A sweep is running now.");
  if (!lastSweep) {
    lines.push("No sweep has retired anything since the runtime started. Preview one: scout worktrees retire --dry-run");
  } else {
    lines.push(
      `Last sweep ${new Date(lastSweep.finishedAt).toLocaleString()} (${lastSweep.trigger}): retired ${lastSweep.retired}, kept ${lastSweep.kept}, ${formatApproxBytes(lastSweep.approxBytesReclaimed)} by du, approximate.`,
      ...lastSweep.worktrees.filter((verdict) => verdict.action === "retired").map(renderVerdict),
    );
  }
  return lines.join("\n");
}

export async function runWorktreesCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseWorktreesCommandOptions(args, defaultScoutContextDirectory(context));
  if (options.help) { context.output.writeText(renderWorktreesCommandHelp()); return; }
  const baseUrl = context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
  const socketPath = context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined;
  const json = options.json || context.output.mode === "json";
  try {
    if (options.command === "status") {
      const status = await requestScoutBrokerJson<WorktreeRetirementStatus>(baseUrl, scoutBrokerPaths.v1.worktreeRetirement, {
        socketPath,
        signal: AbortSignal.timeout(15_000),
      });
      context.output.writeText(json ? JSON.stringify(status, null, 2) : renderWorktreeRetirementStatus(status));
      return;
    }
    const report = await requestScoutBrokerJson<WorktreeRetirementReport>(baseUrl, scoutBrokerPaths.v1.worktreeRetirementSweep, {
      method: "POST",
      body: { dryRun: options.dryRun, ...(options.projects.length ? { projectRoots: options.projects } : {}) },
      socketPath,
      signal: AbortSignal.timeout(15 * 60_000),
    });
    context.output.writeText(json ? JSON.stringify(report, null, 2) : renderWorktreeRetirementReport(report));
  } catch (error) {
    if (error instanceof ScoutBrokerHttpError && error.status === 404) {
      throw new ScoutCliError("This runtime does not retire worktrees yet. Update Scout and restart the runtime (HTTP 404).");
    }
    throw error;
  }
}
