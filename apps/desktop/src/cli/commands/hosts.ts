import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { loadScoutMeshOverview, renderScoutMeshOverviewLines, type ScoutMeshOverview } from "../../core/mesh/overview.ts";

export function renderHostsCommandHelp(): string {
  return [
    "Usage: scout hosts [<host>] [--all] [--json]",
    "",
    "The machines in your mesh, read live (3s each): what each is doing, the projects",
    "it holds, and the ask that starts work there. A machine that does not answer is",
    "shown with the reason and the command to check it, never as idle.",
    "",
    "Start work on another machine (never ssh in to launch an agent):",
    "  scout ask --on archie --project ~/renders/arsenal-x --harness codex \"brief\"",
    "",
    "  scout hosts            every machine",
    "  scout hosts archie     one machine, all of its projects",
  ].join("\n");
}

function renderHosts(overview: ScoutMeshOverview, single: boolean): string {
  if (overview.machines.length === 0) return "No machines answered. Check `scout mesh doctor`.";
  if (!single) return renderScoutMeshOverviewLines(overview).join("\n");
  const lines: string[] = [];
  for (const machine of overview.machines) {
    lines.push(machine.local ? `${machine.host} (this machine)` : machine.host);
    if (machine.reach === "no_answer") {
      lines.push(`  no answer: ${machine.error}`, `  next: ${machine.next}`);
      continue;
    }
    const a = machine.activity;
    lines.push(`  ${a.working} working · ${a.liveSessions} live sessions · ${a.agents} agents`);
    if (!machine.projects) lines.push("  projects: unknown (that machine runs an older Scout)");
    else for (const project of machine.projects.items) {
      lines.push(`  ${project.root}${project.liveSessions ? ` · ${project.liveSessions} live` : ""}`);
    }
    if (machine.projects?.truncated) lines.push(`  …${machine.projects.total - machine.projects.items.length} more`);
    lines.push(`  start work: ${machine.startWork}`);
  }
  return lines.join("\n");
}

export async function runHostsCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    context.output.writeText(renderHostsCommandHelp());
    return;
  }
  const positional = args.filter((arg) => !arg.startsWith("--") && arg !== "--all");
  const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--all");
  if (unknown.length > 0) throw new ScoutCliError(`unexpected flag for hosts: ${unknown[0]} (see scout hosts --help)`);
  if (positional.length > 1) throw new ScoutCliError("scout hosts takes at most one host name");
  const machine = positional[0];
  const overview = await loadScoutMeshOverview({ machine, all: args.includes("--all") });
  context.output.writeValue(overview, (value) => renderHosts(value, Boolean(machine)));
}
