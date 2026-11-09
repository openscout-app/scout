import type { AgentEndpoint } from "@openscout/protocol";

/**
 * Harness session identity for relay-registry copies of tmux Claude sessions.
 *
 * A Scout session card or a flat Claude session that runs in tmux is written
 * twice: once as its own session-backed endpoint (the one Scout invokes), and
 * once as a relay-registry agent built from `relay-agents.json` when the tmux
 * worker is registered. Both describe the same tmux session. The broker reads
 * Claude Code's own process record for that tmux session and records the
 * result (`observedSessionId` plus `observedSessionEvidence`) on the endpoint
 * it invoked. The relay-registry copy is rebuilt from the registry on every
 * sync and so never kept that observation.
 *
 * The observation is a fact about the tmux session, not about one endpoint, so
 * a relay-registry endpoint for the same tmux session on the same node may
 * carry it. Only the observed binding moves: provider aliases such as
 * `externalSessionId` are not added, so endpoint matching by native session id
 * is unchanged. An alias on the target that disagrees with a newer observation
 * is cleared, because the observation is the newer harness evidence.
 */

export const RELAY_AGENT_REGISTRY_SOURCE = "relay-agent-registry";

const OBSERVATION_EVIDENCE_SOURCE = "claude-session-record";
const PROVIDER_ALIAS_KEYS = ["externalSessionId", "nativeSessionId", "threadId"] as const;

export type VerifiedTmuxSessionObservation = {
  endpointId: string;
  nodeId: string;
  tmuxSession: string;
  sessionId: string;
  evidence: Record<string, unknown>;
  observedAt: number;
};

function metadataString(metadata: AgentEndpoint["metadata"] | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isTmuxClaudeEndpoint(endpoint: AgentEndpoint): boolean {
  return endpoint.transport === "tmux" && endpoint.harness === "claude";
}

/** The tmux session name a tmux endpoint runs in. */
export function tmuxSessionNameForEndpoint(endpoint: AgentEndpoint): string | null {
  if (endpoint.transport !== "tmux") return null;
  const surface = recordValue(endpoint.metadata?.terminalSurface);
  const surfaceSession = typeof surface?.sessionName === "string" && surface.sessionName.trim()
    ? surface.sessionName.trim()
    : null;
  return metadataString(endpoint.metadata, "tmuxSession")
    ?? surfaceSession
    ?? (endpoint.sessionId?.trim() || null);
}

export function isRelayRegistryTmuxClaudeEndpoint(endpoint: AgentEndpoint): boolean {
  return isTmuxClaudeEndpoint(endpoint) && endpoint.metadata?.source === RELAY_AGENT_REGISTRY_SOURCE;
}

/**
 * The harness-verified observation recorded on a tmux Claude endpoint, or
 * null. It must come from Claude Code's process record for the endpoint's own
 * tmux session, must not be pending or caller-adopted, and must not be
 * contradicted by a provider alias on the same endpoint.
 */
export function verifiedTmuxSessionObservation(endpoint: AgentEndpoint): VerifiedTmuxSessionObservation | null {
  if (!isTmuxClaudeEndpoint(endpoint)) return null;
  const metadata = endpoint.metadata ?? {};
  if (metadata.pendingExternalSession === true || typeof metadata.externalSessionAdoptedAt === "number") return null;
  const sessionId = metadataString(metadata, "observedSessionId");
  const evidence = recordValue(metadata.observedSessionEvidence);
  if (!sessionId || !evidence || evidence.source !== OBSERVATION_EVIDENCE_SOURCE) return null;
  const tmuxSession = typeof evidence.tmuxSession === "string" ? evidence.tmuxSession.trim() : "";
  if (!tmuxSession || tmuxSession !== tmuxSessionNameForEndpoint(endpoint)) return null;
  if (sessionId === endpoint.sessionId?.trim()) return null;
  for (const key of PROVIDER_ALIAS_KEYS) {
    const alias = metadataString(metadata, key);
    if (alias && alias !== sessionId) return null;
  }
  const observedAt = typeof evidence.observedAt === "number" && Number.isFinite(evidence.observedAt)
    ? evidence.observedAt
    : typeof metadata.observedRuntimeAt === "number" && Number.isFinite(metadata.observedRuntimeAt)
      ? metadata.observedRuntimeAt
      : 0;
  return { endpointId: endpoint.id, nodeId: endpoint.nodeId, tmuxSession, sessionId, evidence, observedAt };
}

function observationKey(nodeId: string, tmuxSession: string): string {
  return `${nodeId}\0${tmuxSession}`;
}

/** The newest verified observation per node and tmux session. */
export function latestTmuxSessionObservations(
  endpoints: Iterable<AgentEndpoint>,
): Map<string, VerifiedTmuxSessionObservation> {
  const latest = new Map<string, VerifiedTmuxSessionObservation>();
  for (const endpoint of endpoints) {
    const observation = verifiedTmuxSessionObservation(endpoint);
    if (!observation) continue;
    const key = observationKey(observation.nodeId, observation.tmuxSession);
    const current = latest.get(key);
    if (!current || observation.observedAt > current.observedAt) latest.set(key, observation);
  }
  return latest;
}

/**
 * Give a relay-registry tmux Claude endpoint the newest verified observation
 * of its tmux session. Returns the endpoint unchanged when it is not such an
 * endpoint, when no observation exists, or when its own observation is at
 * least as new.
 */
export function withObservedTmuxSession(
  target: AgentEndpoint,
  observations: ReadonlyMap<string, VerifiedTmuxSessionObservation>,
): AgentEndpoint {
  if (!isRelayRegistryTmuxClaudeEndpoint(target)) return target;
  const tmuxSession = tmuxSessionNameForEndpoint(target);
  if (!tmuxSession) return target;
  const observation = observations.get(observationKey(target.nodeId, tmuxSession));
  if (!observation) return target;
  const current = verifiedTmuxSessionObservation(target);
  if (current && current.observedAt >= observation.observedAt) return target;

  const metadata = target.metadata ?? {};
  const patch: Record<string, unknown> = {
    observedSessionId: observation.sessionId,
    observedSessionEvidence: observation.endpointId === target.id || typeof observation.evidence.mirroredFromEndpointId === "string"
      ? { ...observation.evidence }
      : { ...observation.evidence, mirroredFromEndpointId: observation.endpointId },
  };
  for (const key of PROVIDER_ALIAS_KEYS) {
    const alias = metadataString(metadata, key);
    if (alias && alias !== observation.sessionId) patch[key] = null;
  }
  if (metadata.pendingExternalSession === true) patch.pendingExternalSession = false;
  return { ...target, metadata: { ...metadata, ...patch } };
}

/**
 * Relay-registry endpoints that should take the observation just recorded on
 * `source`, already updated. Empty unless `source` carries a verified
 * observation.
 */
export function relayEndpointsTakingObservation(
  source: AgentEndpoint,
  endpoints: Iterable<AgentEndpoint>,
): AgentEndpoint[] {
  const observation = verifiedTmuxSessionObservation(source);
  if (!observation) return [];
  const observations = new Map([[observationKey(observation.nodeId, observation.tmuxSession), observation]]);
  const updated: AgentEndpoint[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.id === source.id || endpoint.nodeId !== source.nodeId) continue;
    if (!isRelayRegistryTmuxClaudeEndpoint(endpoint)) continue;
    if (tmuxSessionNameForEndpoint(endpoint) !== observation.tmuxSession) continue;
    const next = withObservedTmuxSession(endpoint, observations);
    if (next !== endpoint) updated.push(next);
  }
  return updated;
}
