import type { NodeDefinition } from "@openscout/protocol";
import {
  searchLocalSessionKnowledge,
  sessionKnowledgeSearchParams,
  type SessionKnowledgeSearchInput,
  type SessionKnowledgeSearchResult,
} from "@openscout/runtime";
import { createMeshPeerFetch } from "@openscout/runtime/mesh-peer-client";

import { resolveScoutMachines } from "./machine-selector.ts";
import {
  isTimeoutError,
  loadScoutMachineInventory,
  readMeshPeerJson,
  withinDeadline,
  type ScoutRecentDeps,
} from "./recent.ts";

export const SESSION_SEARCH_PATH = "/v1/mesh/knowledge/search";
export const SESSION_SEARCH_TIMEOUT_MS = 10_000;

export type HostSessionSearchResult = SessionKnowledgeSearchResult & {
  nodeId: string;
  nodeName: string | null;
  local: boolean;
};

/** Exactly one node, or an error that names the exact ids to use instead. */
export function resolveSearchMachine(nodes: readonly NodeDefinition[], reference: string): NodeDefinition {
  const matches = resolveScoutMachines(nodes, reference);
  if (matches.length === 1) return matches[0]!;
  throw new Error(`Machine "${reference}" matches ${matches.length} nodes; use an exact node id: ${matches.map((node) => node.id).join(", ")}.`);
}

function requireSearchResult(value: unknown, nodeId: string): SessionKnowledgeSearchResult {
  const result = value as (SessionKnowledgeSearchResult & { nodeId?: unknown }) | undefined;
  if (result?.mode !== "lexical" || !Array.isArray(result.hits) || typeof result.coverage?.kind !== "string") {
    throw new Error("invalid or unsupported session search response");
  }
  if (result.nodeId !== nodeId) {
    throw new Error(`session search identity mismatch: expected ${nodeId}, received ${String(result.nodeId)}`);
  }
  const { nodeId: _nodeId, ...rest } = result;
  return rest;
}

/**
 * Ask one host in this mesh to run the query over its own index. The answer is
 * that host's bounded hits; no transcript leaves it. The local host answers
 * from its index directly, without a network hop.
 */
export async function searchSessionsOnMachine(
  machine: string,
  input: SessionKnowledgeSearchInput,
  deps: ScoutRecentDeps & { searchLocal?: (input: SessionKnowledgeSearchInput) => SessionKnowledgeSearchResult } = {},
): Promise<HostSessionSearchResult> {
  const timeoutMs = deps.timeoutMs ?? SESSION_SEARCH_TIMEOUT_MS;
  const { localNode, knownNodes } = await loadScoutMachineInventory({ ...deps, timeoutMs: Math.min(timeoutMs, 3_000) });
  const node = resolveSearchMachine(Object.values({ ...knownNodes, [localNode.id]: localNode }), machine);
  const identity = { nodeId: node.id, nodeName: node.name ?? null, local: node.id === localNode.id };
  if (identity.local) return { ...identity, ...(deps.searchLocal ?? searchLocalSessionKnowledge)(input) };
  const peerFetch = deps.peerFetch ?? createMeshPeerFetch({ log: () => {} });
  const path = `${SESSION_SEARCH_PATH}?${sessionKnowledgeSearchParams(input)}`;
  try {
    const result = await withinDeadline(timeoutMs, (signal) => readMeshPeerJson(node, path, {
      peerFetch, signal, timeoutMs, label: "session search", errorDetail: true,
      parse: (value) => requireSearchResult(value, node.id),
    }));
    return { ...identity, ...result };
  } catch (error) {
    const reported = isTimeoutError(error) ? new Error(`no answer in ${timeoutMs / 1_000}s`) : error;
    const message = (reported instanceof Error ? reported.message : String(reported)).replace(/\s+/g, " ").slice(0, 240);
    // A runtime without the route answers 404, or 403 "local-only" behind
    // the mesh gate's deny-by-default tier for routes it does not know.
    const hint = /HTTP 404|local-only/.test(message)
      ? " That host's runtime predates cross-host search; update Scout there."
      : /HTTP 403/.test(message) ? " This host needs a control grant there: scout mesh trust." : "";
    throw new Error(`${node.name ?? node.id} (${node.id}): ${message}.${hint}`);
  }
}
