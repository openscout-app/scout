import { isExternalSessionEndpoint } from "./external-session-transport.js";
import type {
  AgentDefinition,
  AgentEndpoint,
  AgentState,
  ScoutCandidateEndpointState,
  ScoutDispatchUnavailableTarget,
} from "@openscout/protocol";

import { isA2AHttpEndpoint } from "./a2a-http-endpoint.js";
import { isBrokerRunnableLocalAgentTransport } from "./local-agent-transports.js";
import { routingRegistryVersion, type RuntimeRegistrySnapshot } from "./registry.js";
import { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";

export const ENDPOINT_SESSION_ALIAS_METADATA_KEYS = [
  "sessionId",
  "externalSessionId",
  "threadId",
  "nativeSessionId",
  "runtimeSessionId",
  "runtimeInstanceId",
  "tmuxSession",
  "pairingSessionId",
] as const;

function metadataStringValue(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function endpointStartedAt(endpoint: AgentEndpoint): number {
  const value = endpoint.metadata?.lastStartedAt;
  return typeof value === "number" ? value : 0;
}

export function endpointTerminalAt(endpoint: AgentEndpoint): number {
  const completedAt = endpoint.metadata?.lastCompletedAt;
  const failedAt = endpoint.metadata?.lastFailedAt;
  return Math.max(
    typeof completedAt === "number" ? completedAt : 0,
    typeof failedAt === "number" ? failedAt : 0,
  );
}

export function endpointLifecycleAt(endpoint: AgentEndpoint): number {
  return Math.max(endpointStartedAt(endpoint), endpointTerminalAt(endpoint));
}

type EndpointStateLike = AgentState | undefined;

export function isEndpointOnlineState(state: EndpointStateLike): boolean {
  return state === "active" || state === "idle" || state === "waiting" || state === "working";
}

export function endpointCandidateState(
  state: EndpointStateLike,
): ScoutCandidateEndpointState {
  if (isEndpointOnlineState(state)) {
    return "online";
  }
  if (state === "offline") {
    return "offline";
  }
  if (
    state === "unreachable"
    || state === "failed"
    || state === "superseded"
    || state === "stopped"
  ) {
    return "offline";
  }
  return "unknown";
}

export function endpointAvailabilityScore(endpoint: { state?: EndpointStateLike } | null | undefined): number {
  switch (endpoint?.state) {
    case "active":
    case "working":
      return 40;
    case "idle":
      return 30;
    case "waiting":
      return 20;
    case "registered":
    case "attaching":
    case "waking":
      return 10;
    case "offline":
    case "unreachable":
    case "failed":
    case "superseded":
    case "stopped":
      return 0;
    default:
      return endpoint ? 10 : 0;
  }
}

export type EndpointClassification = {
  candidateState: ScoutCandidateEndpointState;
  reachable: boolean;
  runnable: boolean;
  attachable: boolean;
  wakeable: boolean;
  busy: boolean;
  supportedTransport: boolean;
  reasons: string[];
  score: number;
};

export function classifyEndpoint(
  endpoint: AgentEndpoint | null | undefined,
  options: {
    agent?: AgentDefinition;
    alive?: boolean;
  } = {},
): EndpointClassification {
  // A registered poll mailbox can accept durable work without a running host.
  const registeredMailbox = endpoint?.transport === "mcp_poll"
    && endpoint.metadata?.externalSession === true && endpoint.state === "registered";
  const candidateState = registeredMailbox ? "online" : endpointCandidateState(endpoint?.state);
  const onlineState = registeredMailbox || isEndpointOnlineState(endpoint?.state);
  const stale = !endpoint || hasRetiredEndpointRegistration(endpoint);
  const busy = endpoint?.state === "active" || endpoint?.state === "waiting" || endpoint?.state === "working";
  const supportedTransport = Boolean(
    endpoint
      && (
        endpoint.transport === "pairing_bridge"
        || endpoint.transport === "mcp_poll"
        || endpoint.transport === "claude_channel"
        || isA2AHttpEndpoint(endpoint)
        || isExternalSessionEndpoint(endpoint)
        || (endpoint.transport === "http" && endpoint.metadata?.t3Session === true)
        || isBrokerRunnableLocalAgentTransport(endpoint.transport)
      ),
  );
  const alive = options.alive ?? onlineState;
  const reachable = Boolean(endpoint && !stale && alive && candidateState === "online");
  const attachable = Boolean(endpoint && !stale && supportedTransport && (reachable || endpoint.state !== "offline"));
  const runnable = Boolean(reachable && supportedTransport && !busy);
  const wakeable = options.agent?.wakePolicy !== "manual";
  const reasons: string[] = [];
  if (!endpoint) reasons.push("missing_endpoint");
  if (stale) reasons.push("stale_registration");
  if (!alive) reasons.push("not_alive");
  if (!supportedTransport && endpoint) reasons.push("unsupported_transport");
  if (busy) reasons.push("busy");

  return {
    candidateState,
    reachable,
    runnable,
    attachable,
    wakeable,
    busy,
    supportedTransport,
    reasons,
    score: endpointAvailabilityScore(endpoint),
  };
}

export function latestEndpointForAgent(
  snapshot: RuntimeRegistrySnapshot,
  agentId: string,
): AgentEndpoint | null {
  const candidates = endpointsForAgent(snapshot, agentId);
  return [...candidates].sort((left, right) => endpointLifecycleAt(right) - endpointLifecycleAt(left))[0] ?? null;
}

export function isRetiredLocalAgent(agent: AgentDefinition | undefined): boolean {
  return agent?.metadata?.retiredFromFleet === true;
}

export function isInactiveLocalAgent(agent: AgentDefinition | undefined): boolean {
  return isRetiredLocalAgent(agent) || agent?.metadata?.staleLocalRegistration === true;
}

/**
 * Terminal endpoint states for a cardless/session endpoint that has no backing
 * agent card. Once an endpoint reaches one of these it should be ignored for
 * routing even before the reaper stamps `staleLocalRegistration`.
 */
const TERMINAL_ENDPOINT_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "failed",
  "superseded",
  "stopped",
]);

/** Explicit retirement evidence, unlike an offline heartbeat or failed probe. */
export function hasRetiredEndpointRegistration(endpoint: AgentEndpoint): boolean {
  return endpoint.metadata?.staleLocalRegistration === true
    || (endpoint.state === "offline" && Boolean(metadataStringValue(endpoint.metadata, "replacedByAgentId")));
}

export function isStaleLocalEndpoint(
  snapshot: RuntimeRegistrySnapshot,
  endpoint: AgentEndpoint | null,
): boolean {
  if (!endpoint || hasRetiredEndpointRegistration(endpoint)) {
    return true;
  }

  const agent = snapshot.agents[endpoint.agentId];
  if (!agent) {
    // SCO-070 cardless/session endpoint: no agent card backs `agentId`, so the
    // staleLocalRegistration marker (checked above) is the authoritative
    // liveness signal, with terminal endpoint state as a conservative backstop.
    return TERMINAL_ENDPOINT_STATES.has(endpoint.state);
  }

  return isInactiveLocalAgent(agent);
}

/**
 * SCO-070: availability for a cardless session endpoint. The resolver already
 * dropped stale/terminal endpoints, so a resolved session is unavailable only
 * when its live endpoint has gone offline (the harness exited mid-flight).
 */
export function describeUnavailableSessionEndpoint(
  endpoint: AgentEndpoint,
): ScoutDispatchUnavailableTarget | null {
  const availability = evaluateBrokerAvailability({
    endpoint, authority: endpoint.nodeId, authorityAvailable: true,
    checkedAt: Date.now(), targetSessionId: endpoint.sessionId ?? endpoint.id,
  });
  const endpointState = endpointCandidateState(endpoint.state);
  if (availability.state === "ready") return null;
  return {
    agentId: endpoint.agentId,
    displayName: endpoint.agentId,
    reason: "session_reference_not_attachable",
    detail: `Session ${endpoint.sessionId ?? endpoint.id} is no longer attachable (${availability.reason}). Start fresh explicitly: scout ask --project ${JSON.stringify(endpoint.projectRoot ?? endpoint.cwd ?? "/path/to/project")} --harness ${endpoint.harness} "your request".`,
    endpointState,
    transport: endpoint.transport,
    projectRoot: endpoint.projectRoot ?? endpoint.cwd ?? null,
  };
}

export function homeEndpointForAgent(
  snapshot: RuntimeRegistrySnapshot,
  agentId: string,
): AgentEndpoint | null {
  const index = routingEndpointIndex(snapshot);
  if (index) return index.homeByAgentId.get(agentId) ?? null;
  const candidates = endpointsForAgent(snapshot, agentId)
    .filter((endpoint) => !isStaleLocalEndpoint(snapshot, endpoint));
  return [...candidates].sort(compareHomeEndpointPreference)[0] ?? null;
}

type RoutingEndpointIndex = {
  byAgentId: Map<string, AgentEndpoint[]>;
  bySessionAlias: Map<string, AgentEndpoint[]>;
  homeByAgentId: Map<string, AgentEndpoint>;
};
const routingEndpointIndexes = new WeakMap<object, RoutingEndpointIndex>();

function routingEndpointIndex(snapshot: RuntimeRegistrySnapshot): RoutingEndpointIndex | undefined {
  const version = routingRegistryVersion(snapshot);
  if (!version) return undefined;
  const cached = routingEndpointIndexes.get(version);
  if (cached) return cached;
  const index: RoutingEndpointIndex = {
    byAgentId: new Map(), bySessionAlias: new Map(), homeByAgentId: new Map(),
  };
  for (const endpoint of Object.values(snapshot.endpoints)) {
    const siblings = index.byAgentId.get(endpoint.agentId) ?? [];
    siblings.push(endpoint);
    index.byAgentId.set(endpoint.agentId, siblings);
    for (const alias of endpointSessionAliasValues(endpoint)) {
      const matches = index.bySessionAlias.get(alias) ?? [];
      matches.push(endpoint);
      index.bySessionAlias.set(alias, matches);
    }
    if (!isStaleLocalEndpoint(snapshot, endpoint)) {
      const previous = index.homeByAgentId.get(endpoint.agentId);
      // Preserve insertion order when preference scores tie, like stable sort.
      if (!previous || compareHomeEndpointPreference(endpoint, previous) < 0) {
        index.homeByAgentId.set(endpoint.agentId, endpoint);
      }
    }
  }
  routingEndpointIndexes.set(version, index);
  return index;
}

export function endpointsForAgent(snapshot: RuntimeRegistrySnapshot, agentId: string): readonly AgentEndpoint[] {
  return routingEndpointIndex(snapshot)?.byAgentId.get(agentId)
    ?? (routingRegistryVersion(snapshot) ? [] : Object.values(snapshot.endpoints).filter((endpoint) => endpoint.agentId === agentId));
}

export function endpointsForSession(snapshot: RuntimeRegistrySnapshot, sessionId: string): readonly AgentEndpoint[] {
  return routingEndpointIndex(snapshot)?.bySessionAlias.get(sessionId.trim())
    ?? (routingRegistryVersion(snapshot) ? [] : Object.values(snapshot.endpoints).filter((endpoint) => endpointMatchesTargetSession(endpoint, sessionId)));
}

export function endpointSessionAliasValues(endpoint: AgentEndpoint): string[] {
  const values = [
    runtimeSessionHandleForEndpoint(endpoint),
    endpoint.id,
    endpoint.sessionId,
    ...ENDPOINT_SESSION_ALIAS_METADATA_KEYS.map((key) => metadataStringValue(endpoint.metadata, key)),
  ];
  const aliases = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(aliases)];
}

export function endpointMatchesTargetSession(endpoint: AgentEndpoint, sessionId: string): boolean {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return false;
  }
  return endpointSessionAliasValues(endpoint).includes(normalizedSessionId);
}

export function localEndpointPreferenceRank(endpoint: AgentEndpoint): number {
  if (endpoint.transport === "tmux") {
    return 0;
  }
  if (endpoint.transport === "claude_stream_json") {
    return 50;
  }
  return 10;
}

export function compareLocalEndpointPreference(left: AgentEndpoint, right: AgentEndpoint): number {
  const rankDelta = localEndpointPreferenceRank(left) - localEndpointPreferenceRank(right);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return endpointLifecycleAt(right) - endpointLifecycleAt(left);
}

function homeEndpointStateRank(state: EndpointStateLike): number {
  switch (state) {
    case "active":
    case "working":
      return 0;
    case "idle":
      return 1;
    case "waiting":
      return 2;
    case "attaching":
    case "waking":
      return 3;
    case "registered":
      return 4;
    case "offline":
    case "unreachable":
    case "failed":
    case "superseded":
    case "stopped":
      return 6;
    default:
      return 5;
  }
}

export function compareHomeEndpointPreference(left: AgentEndpoint, right: AgentEndpoint): number {
  if (left.preferred !== right.preferred) {
    return left.preferred ? -1 : 1;
  }
  const stateDelta = homeEndpointStateRank(left.state) - homeEndpointStateRank(right.state);
  if (stateDelta !== 0) {
    return stateDelta;
  }
  return endpointLifecycleAt(right) - endpointLifecycleAt(left);
}

/** Admission evidence, not a presence/card projection or a wake-policy hint. */
export type BrokerAvailability = {
  state: "ready" | "can_start" | "gone";
  reason: string;
  checkedAt: number;
  supportedActions: Array<"receive" | "queue" | "start">;
  authority: string;
  selectedRoute: { kind: "session"; endpointId: string; sessionId: string | null }
    | { kind: "launch"; projectRoot: string; harness: AgentEndpoint["harness"] }
    | null;
};

export type VerifiedLaunchRoute = {
  projectRoot: string;
  harness: AgentEndpoint["harness"];
};

/** A verified launcher must come from the authority's capability check. */
export function evaluateBrokerAvailability(input: {
  endpoint: AgentEndpoint | null;
  agent?: AgentDefinition;
  authority: string;
  authorityAvailable: boolean;
  checkedAt: number;
  alive?: boolean;
  queueSupported?: boolean;
  launchRoute?: VerifiedLaunchRoute | null;
  targetSessionId?: string;
}): BrokerAvailability {
  const { endpoint, agent } = input;
  const classification = classifyEndpoint(endpoint, { agent, alive: input.alive });
  const result: BrokerAvailability = {
    state: "gone", reason: "no_receive_or_verified_launcher",
    checkedAt: input.checkedAt, supportedActions: [], authority: input.authority,
    selectedRoute: null,
  };
  if (isInactiveLocalAgent(agent)) {
    result.reason = isRetiredLocalAgent(agent) ? "retired" : "stale_registration";
    return result;
  }
  if (endpoint && hasRetiredEndpointRegistration(endpoint)) {
    result.reason = "stale_registration";
    return result;
  }
  if (!input.authorityAvailable) {
    result.reason = "authority_unavailable";
    return result;
  }
  if (input.targetSessionId && (!endpoint || !endpointMatchesTargetSession(endpoint, input.targetSessionId))) {
    result.reason = "session_reference_not_attachable";
    return result;
  }
  if (endpoint && classification.reachable && classification.supportedTransport
    && (!classification.busy || input.queueSupported)) {
    return {
      ...result, state: "ready", reason: classification.busy ? "queue_supported" : "receive_supported",
      supportedActions: classification.busy ? ["queue"] : ["receive"],
      selectedRoute: { kind: "session", endpointId: endpoint.id, sessionId: endpoint.sessionId ?? null },
    };
  }
  // Exact continuation cannot fall through to launch, even with a valid launcher.
  if (input.targetSessionId) {
    result.reason = "session_reference_not_attachable";
    return result;
  }
  if (input.launchRoute?.projectRoot.trim() && input.launchRoute.harness) {
    return {
      ...result, state: "can_start", reason: "verified_launcher",
      supportedActions: ["start"], selectedRoute: { kind: "launch", ...input.launchRoute },
    };
  }
  result.reason = classification.reasons[0] ?? (classification.reachable ? "busy_without_queue" : "not_alive");
  if (classification.busy && classification.reachable && classification.supportedTransport) result.reason = "busy_without_queue";
  return result;
}
