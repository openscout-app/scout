import { scoutSessionHostForNode } from "@openscout/protocol";
import type { MeshNodeStateProject } from "@openscout/runtime/mesh-node-state";
import { loadMachineNodeStates, type ScoutRecentDeps } from "./recent.ts";

/**
 * The mesh at a glance, for agents first: which machines answer, what they are
 * doing, which repos they hold, and the exact ask that starts work on each.
 * Everything comes from each machine's own node-state answer, read now; a
 * machine that does not answer is reported with the reason, never as idle.
 */
export type ScoutMeshMachine = {
  /** The name `--on` / MCP `on` accepts for this machine. */
  host: string;
  nodeId: string;
  nodeName: string | null;
  local: boolean;
} & ({
  reach: "answering";
  activity: { agents: number; working: number; liveSessions: number; runningWork: number };
  /** Undefined when the machine runs a Scout older than the project list. */
  projects?: { total: number; truncated: boolean; items: MeshNodeStateProject[] };
  /** Copy-paste ask that starts fresh work on this machine. */
  startWork: string;
} | {
  reach: "no_answer";
  error: string;
  /** The command that explains or fixes the miss. */
  next: string;
});

export type ScoutMeshOverview = {
  machines: ScoutMeshMachine[];
  /** One plain sentence on how to start work on another machine. */
  howTo: string;
};

export const MESH_HOW_TO =
  "Start work on another machine with `scout ask --on <host> --project <path on that host> --harness <claude|codex> \"brief\"` (MCP: ask with `on` + `projectPath`). Never ssh in to launch an agent: Scout carries the brief, the receipt and the replies.";

export function startWorkCommand(host: string, projectRoot?: string): string {
  return `scout ask --on ${host} --project ${projectRoot ?? "<path on " + host + ">"} --harness codex "<brief>"`;
}

export async function loadScoutMeshOverview(
  options: { machine?: string; all?: boolean } = {},
  deps: ScoutRecentDeps = {},
): Promise<ScoutMeshOverview> {
  const { machines: states } = await loadMachineNodeStates(options, deps);
  const machines = states.map((state): ScoutMeshMachine => {
    const host = scoutSessionHostForNode(state.node);
    const identity = { host, nodeId: state.nodeId, nodeName: state.nodeName, local: state.local };
    if (state.status === "unavailable") {
      return {
        ...identity,
        reach: "no_answer",
        error: state.error,
        next: /denied|403/.test(state.error) ? "scout mesh trust" : "scout mesh doctor",
      };
    }
    const report = state.report;
    const projects = report.projects;
    return {
      ...identity,
      reach: "answering",
      activity: {
        agents: report.workload.total,
        working: report.workload.working,
        liveSessions: report.sessions.total,
        runningWork: report.work.running,
      },
      ...(projects ? { projects } : {}),
      startWork: startWorkCommand(host, projects?.items[0]?.root),
    };
  });
  // This machine first, then answering machines, then by name.
  machines.sort((a, b) =>
    Number(b.local) - Number(a.local)
    || Number(b.reach === "answering") - Number(a.reach === "answering")
    || a.host.localeCompare(b.host));
  return { machines, howTo: MESH_HOW_TO };
}

/** Compact one-line-per-machine text, used by the CLI, MCP and the session-start hook. */
export function renderScoutMeshOverviewLines(overview: ScoutMeshOverview, options: { projectsPerMachine?: number; roots?: boolean } = {}): string[] {
  const limit = options.projectsPerMachine ?? 6;
  const lines = overview.machines.map((machine) => {
    const name = machine.local ? `${machine.host} (this machine)` : machine.host;
    if (machine.reach === "no_answer") return `${name}: no answer (${machine.error}) · try \`${machine.next}\``;
    const parts: string[] = [];
    const a = machine.activity;
    parts.push(a.working > 0 ? `${a.working} working` : "quiet");
    if (a.liveSessions > 0) parts.push(`${a.liveSessions} live session${a.liveSessions === 1 ? "" : "s"}`);
    if (machine.projects) {
      const names = machine.projects.items.slice(0, limit).map((project) => options.roots ? project.root : project.name);
      const more = machine.projects.total - names.length;
      if (names.length > 0) parts.push(`projects: ${names.join(", ")}${more > 0 ? ` +${more}` : ""}`);
    }
    return `${name}: ${parts.join(" · ")}`;
  });
  return [...lines, overview.howTo];
}
