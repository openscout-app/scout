import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  renderHerdrWorkspaceDigest,
  type HerdrDigestPane,
  type HerdrWorkspaceDigest,
  type HerdrWorkspacesRead,
} from "@openscout/protocol";

import { HerdrWorkspacesReadError, readRuntimeHerdrWorkspaces } from "./herdr-workspaces-runtime.ts";

/**
 * `herdr_workspaces` — the read side of Scout's herdr coordination layer.
 *
 * Herdr owns workspaces, tabs and panes; Scout coordinates over whatever host
 * is present and never becomes a second layout manager. So this tool reads a
 * ranked digest and stops there. It has no mutation verb, and it deliberately
 * does not shell `herdr` itself: the broker already owns that probe and its
 * cache, and a caller that cannot reach the server should learn that rather
 * than quietly open a second path to the same binary.
 *
 * The tool returns the rendered digest as its text content — attention first,
 * then motion, then directories, then arrangement — because that ordering is
 * the presentation, not a formatting detail. Structured content carries the
 * same digest for callers that want the fields.
 */

export type HerdrWorkspacesDependencies = {
  readDigests: (session?: string) => Promise<{
    digests: HerdrWorkspaceDigest[];
    truncated: boolean;
    available: boolean;
    runtimeRead?: Omit<HerdrWorkspacesRead, "digests"> & {
      sessions: Array<{ session: string; availability: HerdrWorkspacesRead["availability"] }>;
    };
    readError?: { status: number | null; code: string };
  }>;
};

export type HerdrPanelIdentity = HerdrDigestPane & {
  herdrSession: string;
  live: boolean;
  observedAt: number;
  savedAt: number | null;
  /** Read-only handoff; arguments are separate so names remain literal data. */
  readCommand: { command: "herdr"; args: string[] } | null;
};

/** Preserve host identity without promoting a label into a Scout address. */
export function herdrPanelIdentities(digests: HerdrWorkspaceDigest[]): HerdrPanelIdentity[] {
  return digests.flatMap((digest) => digest.groups.flatMap((group) => group.panes.map((pane) => ({
    ...pane,
    target: digest.live ? pane.target : null,
    status: digest.live ? pane.status : "unknown" as const,
    herdrSession: digest.session,
    live: digest.live,
    observedAt: digest.observedAt,
    savedAt: digest.savedAt,
    readCommand: digest.live ? {
      command: "herdr" as const,
      args: ["--session", digest.session, "pane", "read", pane.paneId, "--source", "recent-unwrapped", "--lines", "100", "--format", "text"],
    } : null,
  }))));
}

export function matchesHerdrPanel(panel: HerdrPanelIdentity, query: string): boolean {
  const needle = query.toLowerCase();
  return [panel.name, panel.label, panel.paneId, panel.target, panel.herdrSession,
    panel.directory, panel.agent, panel.agentSession?.value]
    .some((value) => value?.toLowerCase().includes(needle));
}

export function herdrWorkspacesDependencies(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): HerdrWorkspacesDependencies {
  // Snapshot the runtime selection at registration, so a later env change
  // cannot redirect these reads. Only the OPENSCOUT_BROKER_* keys the read
  // uses: they choose the runtime, which is the same for every session the
  // shared MCP server serves, and nothing session-specific is fixed here.
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(source)) {
    if (key.startsWith("OPENSCOUT_BROKER_")) env[key] = source[key];
  }
  return {
    readDigests: async (session) => {
      try {
        const { digests, ...metadata } = await readRuntimeHerdrWorkspaces({ ...options, env, session });
        return {
          digests, available: ["available", "partial"].includes(metadata.availability),
          truncated: metadata.truncated || metadata.availability === "partial",
          runtimeRead: { ...metadata, sessions: digests.map(({ session, availability }) => ({ session, availability })) },
        };
      } catch (error) {
        return { digests: [], truncated: false, available: false,
          readError: { status: error instanceof HerdrWorkspacesReadError ? error.status : null,
            code: error instanceof HerdrWorkspacesReadError ? error.code : "herdr_workspaces_unavailable" } };
      }
    },
  };
}

export function registerHerdrWorkspaceTools(server: McpServer, deps: HerdrWorkspacesDependencies): void {
  server.registerTool("herdr_workspaces", {
    title: "Read Herdr Workspace Topology",
    description: [
      "Read the operator's herdr terminal workspaces: which panes are blocked and waiting on a person, which are working, what directory each sits in, and how each tab is arranged.",
      "Use query to find a named panel such as devon-2 before searching transcripts. Carries the assigned pane name, terminal title, and Herdr-reported harness session separately. These are observed identities, not Scout routing addresses. Multiple matches must be disambiguated; a bounded miss does not prove absence.",
      "Herdr reports agent state; Scout does not infer it. blocked means herdr recognized an approval or question UI. idle and done both mean ready for input. unknown means an agent is present that herdr could not classify — it is the absence of a signal, never completion.",
      "Read-only. This tool cannot split panes, start agents, focus, or close anything; herdr owns the layout. To type into a pane's agent, call session_send with the pane's harness session id; for a tracked request, dispatch with ask.",
      "A session reported not live is a persisted last-known layout, not running work. Never describe its panes as active.",
    ].join(" "),
    inputSchema: z.object({
      session: z.string().trim().min(1).max(120).optional()
        .describe("Herdr session name. Omit to read every session on this host."),
      query: z.string().trim().min(1).max(200).optional()
        .describe("Literal substring of the pane name, title, pane/terminal id, harness session id, or directory. Returns all candidates within coverage; never guesses a match."),
      limit: z.number().int().min(1).max(8).default(3)
        .describe("Maximum sessions to return, most workspaces first."),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ session, query, limit }) => {
    const { digests, truncated, available, runtimeRead, readError } = await deps.readDigests(session);
    const provenance = { ...(runtimeRead ? { runtimeRead } : {}), ...(readError ? { readError } : {}) };
    if (!available) {
      const structuredContent = {
        source: "herdr_topology_projection",
        available: false,
        reason: "herdr_unavailable",
        note: "Could not read an available Herdr observation from the local broker. The broker or host probes may be unavailable or not scanned. This is not evidence that there are no workspaces.",
        ...provenance,
        sessions: [] as HerdrWorkspaceDigest[],
      };
      return { content: [{ type: "text" as const, text: structuredContent.note }], structuredContent };
    }

    if (query) {
      const candidates = herdrPanelIdentities(digests).filter((pane) => matchesHerdrPanel(pane, query));
      const results = candidates.slice(0, 40);
      const bounded = truncated || digests.some((digest) => digest.truncated) || candidates.length > results.length;
      const structuredContent = {
        source: "herdr_topology_projection", available: true, coverage: "this_host_only",
        query, truncated: bounded, candidateCount: candidates.length,
        selection: "candidates_only", results,
        ...provenance,
        note: "Names are Herdr panel labels, not Scout addresses. Session references are reported by Herdr, not independently verified against transcripts. Idle is ready for input, not proof of completed work. Recheck the mapping before reading if the pane has changed since observedAt. A bounded miss is not proof of absence; scope by Herdr session to narrow coverage.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    }

    // Most workspaces first, so a bounded read spends its budget on the session
    // that actually has a topology to describe.
    const ordered = [...digests].sort((left, right) =>
      right.counts.blocked - left.counts.blocked
      || right.totals.panes - left.totals.panes
      || left.session.localeCompare(right.session, undefined, { numeric: true }));
    const sessions = ordered.slice(0, limit);
    const text = sessions.length
      ? sessions.map(renderHerdrWorkspaceDigest).join("\n\n")
      : truncated ? "No herdr sessions in this incomplete observation; absence is not established." : "No herdr sessions on this host.";
    const structuredContent = {
      source: "herdr_topology_projection",
      available: true,
      coverage: "this_host_only",
      truncated: truncated || ordered.length > sessions.length || sessions.some((digest) => digest.truncated),
      sessions,
      ...provenance,
    };
    return { content: [{ type: "text" as const, text }], structuredContent };
  });
}
