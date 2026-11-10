import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import {
  constructAgentIdentity,
  diagnoseAgentIdentity,
  formatMinimalAgentIdentity,
  isScoutReservedAgentName,
  parseAgentIdentity,
  parseScoutComposerRouteTarget,
  type AgentDefinition,
  type AgentEndpoint,
  type AgentHarness,
  type AgentIdentity,
  type AgentIdentityCandidate,
  type AgentIdentityDiagnosis,
  type ScoutDispatchCandidate,
  type ScoutDispatchEnvelope,
  type ScoutDispatchKind,
  type ScoutId,
  type ScoutDispatchDiagnosticCode,
  type ScoutRoutePolicy,
  type ScoutRouteTarget,
  normalizeAgentSelectorSegment,
  normalizeScoutSessionHost,
} from "@openscout/protocol";

import type { createInMemoryControlRuntime } from "./broker.js";
import {
  endpointAvailabilityScore,
  endpointLifecycleAt,
  endpointCandidateState,
  endpointStronglyMatchesSession,
  endpointsForAgent,
  endpointsForSession,
  homeEndpointForAgent,
  isStaleLocalEndpoint,
  localEndpointPreferenceRank,
} from "./broker-endpoint-selection.js";
import {
  executionForBrokerRuntimeProfile,
  resolveBrokerRuntimeProfile,
} from "./broker-runtime-profiles.js";
import { sessionHostForNodeId, sessionHostNodeIds } from "./runtime-session-address.js";
import { routingRegistryVersion, routingRegistryView } from "./registry.js";

export type RuntimeSnapshot = ReturnType<ReturnType<typeof createInMemoryControlRuntime>["snapshot"]>;

/**
 * Addressable target for a cardless session (SCO-070). Carries no
 * AgentDefinition: the session resolves to a live endpoint directly, so the
 * dispatch path must read identity/label off this shape instead of `agent`.
 */
export interface ResolvedSessionTarget {
  /** The session id the caller addressed. */
  sessionId: string;
  /** Session-kind actor id occupying the identity slot (== endpoint.agentId marker). */
  actorId: ScoutId;
  /** Live endpoint to dispatch through. */
  endpoint: AgentEndpoint;
  /** Display label, e.g. `<cwd-basename>:<short-session>`. */
  label: string;
  /** endpoint.nodeId — the cross-node forwarding key. */
  nodeId: ScoutId;
}

export type BrokerLabelResolution =
  | { kind: "resolved"; agent: AgentDefinition }
  | { kind: "resolved_session"; session: ResolvedSessionTarget }
  | { kind: "ambiguous"; label: string; candidates: AgentDefinition[]; detail?: string }
  | { kind: "unparseable"; label: string }
  | { kind: "unknown"; label: string; detail?: string; candidates?: AgentDefinition[]; diagnosticCode?: ScoutDispatchDiagnosticCode; sessionWakeReason?: string };

export interface BrokerRouteTargetInput {
  target?: ScoutRouteTarget | null;
  targetAgentId?: string | null;
  targetSessionId?: string | null;
  targetLabel?: string | null;
  routePolicy?: ScoutRoutePolicy | null;
  execution?: { harness?: AgentHarness; targetSessionId?: string | null } | null;
}

/**
 * The exact harness session a request names without a session_id target: a
 * bare targetSessionId, or the session its execution continues when the
 * request names no agent. A project path only says where to look; the
 * session id is the more exact of the two, so it routes. An agent with a
 * session to continue still routes to that agent.
 */
export function bareRouteSessionId(input: BrokerRouteTargetInput): string | undefined {
  const bare = input.targetSessionId?.trim();
  if (bare) return bare;
  if (input.target && input.target.kind !== "project_path") return undefined;
  if (input.targetAgentId?.trim() || input.targetLabel?.trim()) return undefined;
  return input.execution?.targetSessionId?.trim() || undefined;
}

export type BrokerAgentCandidate = AgentIdentityCandidate & {
  agentId: string;
  agent: AgentDefinition;
};

export interface DispatcherHelpers {
  isStale: (agent: AgentDefinition | undefined) => boolean;
  homeEndpointFor: (snapshot: RuntimeSnapshot, agentId: string) => AgentEndpoint | null;
}

function normalizeTargetHandleInput(handle: string): string {
  return handle
    .trim()
    .replace(/^[@⌖]+/, "")
    .replace(/^(?:target|target-handle|target_handle):/i, "");
}

function normalizedRouteTargetValue(target: ScoutRouteTarget | null | undefined): string | undefined {
  if (!target) {
    return undefined;
  }
  const direct = target.kind === "agent_id"
    ? target.agentId
    : target.kind === "agent_label"
    ? target.label
    : target.kind === "existing_handle"
    ? target.handle
    : target.kind === "runtime_profile"
    ? target.value ?? `profile:${target.profile}`
    : target.kind === "route_alias"
    ? target.value ?? `alias:${target.alias}`
    : target.kind === "target_handle"
    ? target.value ?? `target:${normalizeTargetHandleInput(target.handle)}`
    : target.kind === "session_id"
    ? target.sessionId
    : target.kind === "binding_ref"
    ? target.ref
    : target.kind === "project_path"
    ? target.projectPath
    : target.kind === "channel"
    ? target.channel
    : target.value;
  const trimmed = direct?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function askedLabelForRouteTarget(input: BrokerRouteTargetInput): string {
  return normalizedRouteTargetValue(input.target)
    ?? input.targetSessionId?.trim()
    ?? input.targetLabel?.trim()
    ?? input.targetAgentId?.trim()
    ?? "";
}

export function routeChannelForTarget(input: BrokerRouteTargetInput): string | undefined {
  const target = input.target;
  if (!target) {
    return undefined;
  }
  if (target.kind === "broadcast") {
    return "shared";
  }
  if (target.kind !== "channel") {
    return undefined;
  }
  return normalizedRouteTargetValue(target);
}

function metadataStringValue(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionRouteLabel(sessionId: string, harness?: AgentHarness, host?: string): string {
  const base = harness ? `session:${harness}:${sessionId}` : `session:${sessionId}`;
  return host ? `${base}@${host}` : base;
}

function endpointMatchesSessionRouteScope(
  endpoint: AgentEndpoint,
  options: { harness?: AgentHarness },
): boolean {
  return !options.harness || endpoint.harness === options.harness;
}

function isReservedProductIdentity(definitionId: string): boolean {
  return isScoutReservedAgentName(definitionId);
}

function isBareReservedProductIdentity(identity: AgentIdentity): boolean {
  return isReservedProductIdentity(identity.definitionId)
    && !identity.nodeQualifier
    && !identity.workspaceQualifier
    && !identity.profile
    && !identity.harness
    && !identity.model;
}

export function buildAgentLabelCandidates(
  snapshot: RuntimeSnapshot,
  helpers: Pick<DispatcherHelpers, "isStale">,
  options: { includeStale?: boolean } = {},
): BrokerAgentCandidate[] {
  return agentCandidateIndex(routingRegistryView(snapshot)).all
    .filter((candidate) => options.includeStale || !helpers.isStale(candidate.agent));
}

type AgentCandidateIndex = {
  all: BrokerAgentCandidate[];
  byName: Map<string, BrokerAgentCandidate[]>;
};
const agentCandidateIndexes = new WeakMap<object, AgentCandidateIndex>();

function agentCandidateIndex(snapshot: RuntimeSnapshot): AgentCandidateIndex {
  const version = routingRegistryVersion(snapshot)!;
  const cached = agentCandidateIndexes.get(version);
  if (cached) return cached;
  const all = Object.values(snapshot.agents).map((agent) => buildAgentLabelCandidate(snapshot, agent));
  const byName = new Map<string, BrokerAgentCandidate[]>();
  for (const candidate of all) {
    // This is a superset index. The protocol diagnosis still owns alias
    // precedence, qualifiers, model aliases, and ambiguity rules.
    const names = new Set([
      normalizeAgentSelectorSegment(candidate.definitionId || candidate.agentId),
      ...(candidate.aliases ?? []).map(normalizeAgentSelectorSegment),
    ]);
    if (names.has("openscout")) names.add("scout");
    for (const name of names) {
      const matches = byName.get(name) ?? [];
      matches.push(candidate);
      byName.set(name, matches);
    }
  }
  const index = { all, byName };
  agentCandidateIndexes.set(version, index);
  return index;
}

function projectRootForAgent(
  snapshot: RuntimeSnapshot,
  agent: AgentDefinition,
): string | undefined {
  const endpoint = homeEndpointForAgent(snapshot, agent.id);
  return endpoint?.projectRoot?.trim()
    || metadataStringValue(agent.metadata, "projectRoot")
    || endpoint?.cwd?.trim();
}

function normalizeProjectPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const home = process.env.HOME?.trim() || homedir();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2));
  return resolve(trimmed);
}

function buildAgentLabelCandidate(
  snapshot: RuntimeSnapshot,
  agent: AgentDefinition,
): BrokerAgentCandidate {
  const metadata = agent.metadata ?? {};
  const endpoint = homeEndpointForAgent(snapshot, agent.id);
  const aliases = [
    agent.handle,
    metadataStringValue(metadata, "handle"),
    agent.selector,
    agent.defaultSelector,
    metadataStringValue(metadata, "selector"),
    metadataStringValue(metadata, "defaultSelector"),
  ].filter((value): value is string => Boolean(value));
  const definitionId = agent.definitionId ?? metadataStringValue(metadata, "definitionId") ?? agent.id;

  return {
    agentId: agent.id,
    agent,
    definitionId,
    nodeQualifier: agent.nodeQualifier ?? metadataStringValue(metadata, "nodeQualifier"),
    workspaceQualifier: agent.workspaceQualifier ?? metadataStringValue(metadata, "workspaceQualifier"),
    harness: endpoint?.harness
      ?? metadataStringValue(endpoint?.metadata, "harness")
      ?? metadataStringValue(metadata, "harness")
      ?? metadataStringValue(metadata, "defaultHarness"),
    profile: metadataStringValue(metadata, "profile"),
    model: metadataStringValue(endpoint?.metadata, "model")
      ?? metadataStringValue(metadata, "model"),
    aliases,
  };
}

function stripHarnessQualifier(identity: AgentIdentity): AgentIdentity | null {
  if (!identity.harness) {
    return null;
  }

  return constructAgentIdentity({
    definitionId: identity.definitionId,
    workspaceQualifier: identity.workspaceQualifier,
    profile: identity.profile,
    model: identity.model,
    nodeQualifier: identity.nodeQualifier,
  });
}

function stripModelQualifier(identity: AgentIdentity): AgentIdentity | null {
  if (!identity.model) {
    return null;
  }

  return constructAgentIdentity({
    definitionId: identity.definitionId,
    workspaceQualifier: identity.workspaceQualifier,
    profile: identity.profile,
    harness: identity.harness,
    nodeQualifier: identity.nodeQualifier,
  });
}

function resolutionFromDiagnosis(
  diagnosis: AgentIdentityDiagnosis<BrokerAgentCandidate>,
  label: string,
): BrokerLabelResolution | null {
  if (diagnosis.kind === "resolved") {
    return { kind: "resolved", agent: diagnosis.match.agent };
  }
  if (diagnosis.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      label,
      candidates: diagnosis.candidates.map((candidate) => candidate.agent),
    };
  }
  return null;
}

function unknownModelQualifiedResolution(
  identity: AgentIdentity,
  candidates: BrokerAgentCandidate[],
): BrokerLabelResolution | null {
  if (!identity.model) {
    return null;
  }

  const modelAgnosticIdentity = stripModelQualifier(identity);
  if (!modelAgnosticIdentity) {
    return null;
  }

  const modelAgnosticDiagnosis = diagnoseAgentIdentity(modelAgnosticIdentity, candidates);
  const matches = modelAgnosticDiagnosis.kind === "resolved"
    ? [modelAgnosticDiagnosis.match]
    : modelAgnosticDiagnosis.kind === "ambiguous"
    ? modelAgnosticDiagnosis.candidates
    : [];
  if (matches.length === 0) {
    return null;
  }

  const missingModelCount = matches.filter((candidate) => !candidate.model).length;
  const mismatchCount = matches.length - missingModelCount;
  const reason = missingModelCount === matches.length
    ? "matching candidates do not advertise a model"
    : mismatchCount === matches.length
    ? "matching candidates advertise a different model"
    : "matching candidates do not advertise the requested model";

  return {
    kind: "unknown",
    label: identity.label,
    detail: `no exact agent matches ${identity.label}; requested model:${identity.model}, but ${reason}`,
    candidates: matches.map((candidate) => candidate.agent),
  };
}

type SessionHandleMatch = { actor: RuntimeSnapshot["actors"][string]; endpoint: AgentEndpoint };
type SessionHandleIndex = {
  byLabel: Map<string, SessionHandleMatch[]>;
  byHandle: Map<string, SessionHandleMatch[]>;
};
const sessionHandleIndexes = new WeakMap<object, SessionHandleIndex>();

function sessionHandleIndex(snapshot: RuntimeSnapshot): SessionHandleIndex {
  const version = routingRegistryVersion(snapshot)!;
  const cached = sessionHandleIndexes.get(version);
  if (cached) return cached;
  const index: SessionHandleIndex = { byLabel: new Map(), byHandle: new Map() };
  for (const actor of Object.values(snapshot.actors)) {
    if (actor.kind !== "session") continue;
    const endpoint = endpointsForAgent(snapshot, actor.id)
      .filter((candidate) => !isStaleLocalEndpoint(snapshot, candidate))
      .sort((left, right) => localEndpointPreferenceRank(left) - localEndpointPreferenceRank(right))[0];
    if (!endpoint) continue;
    const home = homeEndpointForAgent(snapshot, actor.id);
    const handles = [actor.handle, metadataStringValue(actor.metadata, "handle"), metadataStringValue(home?.metadata, "handle")]
      .filter((value): value is string => Boolean(value));
    const match = { actor, endpoint };
    for (const [map, values] of [[index.byHandle, handles], [index.byLabel, [...handles, actor.id]]] as const) {
      for (const alias of new Set(values.map(normalizeAgentSelectorSegment))) {
        const matches = map.get(alias) ?? [];
        matches.push(match);
        map.set(alias, matches);
      }
    }
  }
  sessionHandleIndexes.set(version, index);
  return index;
}

function resolveSessionHandleLabel(
  snapshot: RuntimeSnapshot,
  identity: AgentIdentity,
  options: {
    helpers: Pick<DispatcherHelpers, "isStale">;
    rejectAmbiguous?: boolean;
  },
): Extract<BrokerLabelResolution, { kind: "resolved_session" | "ambiguous" }> | null {
  if (
    identity.workspaceQualifier
    || identity.nodeQualifier
    || identity.profile
    || identity.harness
    || identity.model
  ) {
    return null;
  }

  const handle = normalizeAgentSelectorSegment(identity.definitionId);
  if (!handle) {
    return null;
  }

  const matches = sessionHandleIndex(snapshot).byLabel.get(handle) ?? [];

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1 && options.rejectAmbiguous) {
    const sessionIds = matches
      .map(({ actor }) => `session:${actor.id}`)
      .sort((left, right) => left.localeCompare(right));
    return {
      kind: "ambiguous",
      label: identity.label,
      candidates: [],
      detail: `${identity.label} matches multiple live sessions: ${sessionIds.join(", ")}; use one exact session:<id> target`,
    };
  }

  const { actor, endpoint } = [...matches].sort((left, right) => (
    endpointAvailabilityScore(right.endpoint) - endpointAvailabilityScore(left.endpoint)
    || endpointLifecycleAt(right.endpoint) - endpointLifecycleAt(left.endpoint)
    || right.actor.id.localeCompare(left.actor.id)
  ))[0]!;
  const sessionId = actor.id;
  return {
    kind: "resolved_session",
    session: {
      sessionId,
      actorId: actor.id,
      endpoint,
      label: actor.displayName || sessionTargetLabel(endpoint, sessionId),
      nodeId: endpoint.nodeId,
    },
  };
}

function resolveExistingHandle(
  snapshot: RuntimeSnapshot,
  handle: string,
  options: { helpers: Pick<DispatcherHelpers, "isStale"> },
): BrokerLabelResolution {
  const normalized = normalizeAgentSelectorSegment(handle.replace(/^@+/, ""));
  const label = normalized ? `@${normalized}` : handle;
  if (!normalized) {
    return { kind: "unparseable", label };
  }

  // Existing-handle routing is deliberately narrower than agent-label routing.
  // Only explicit handles/selectors are eligible: definition IDs, agent IDs,
  // project heuristics, and local-node preferences must not influence a match.
  const agentMatches = (agentCandidateIndex(snapshot).byName.get(normalized) ?? [])
    .filter((candidate) => !options.helpers.isStale(candidate.agent))
    .filter((candidate) => candidate.aliases?.some(
      (alias) => normalizeAgentSelectorSegment(alias.replace(/^@+/, "")) === normalized,
    ))
    .sort((left, right) => left.agent.id.localeCompare(right.agent.id));

  const sessionMatches = [...(sessionHandleIndex(snapshot).byHandle.get(normalized) ?? [])]
    .sort((left, right) => left.actor.id.localeCompare(right.actor.id));

  const matchCount = agentMatches.length + sessionMatches.length;
  if (matchCount === 0) {
    return {
      kind: "unknown",
      label,
      detail: `no live agent handle, selector, or session handle exactly matches ${label}`,
    };
  }

  if (matchCount > 1) {
    const targets = [
      ...agentMatches.map((candidate) => `agent:${candidate.agent.id}`),
      ...sessionMatches.map(({ actor }) => `session:${actor.id}`),
    ].sort((left, right) => left.localeCompare(right));
    return {
      kind: "ambiguous",
      label,
      candidates: agentMatches.map((candidate) => candidate.agent),
      detail: `${label} matches multiple live targets: ${targets.join(", ")}; use a unique exact agent handle/selector or session:<id>`,
    };
  }

  const agentMatch = agentMatches[0];
  if (agentMatch) {
    return { kind: "resolved", agent: agentMatch.agent };
  }

  const { actor, endpoint } = sessionMatches[0]!;
  return {
    kind: "resolved_session",
    session: {
      sessionId: actor.id,
      actorId: actor.id,
      endpoint,
      label: actor.displayName || sessionTargetLabel(endpoint, actor.id),
      nodeId: endpoint.nodeId,
    },
  };
}

function resolveTargetHandle(
  snapshot: RuntimeSnapshot,
  handle: string,
  options: { helpers: Pick<DispatcherHelpers, "isStale"> },
): BrokerLabelResolution {
  const trimmed = normalizeTargetHandleInput(handle);
  const label = `target:${trimmed}`;
  if (!trimmed) {
    return { kind: "unparseable", label };
  }

  const identity = parseAgentIdentity(trimmed.startsWith("@") ? trimmed : `@${trimmed}`);
  if (!identity) {
    return { kind: "unparseable", label };
  }

  const session = resolveSessionHandleLabel(snapshot, identity, options);
  if (session) {
    return session;
  }

  const bareHandle = normalizeAgentSelectorSegment(identity.definitionId);
  if (bareHandle && !bareHandle.startsWith("project-")) {
    const prefixed = parseAgentIdentity(`@project-${bareHandle}`);
    if (prefixed) {
      const prefixedSession = resolveSessionHandleLabel(snapshot, prefixed, options);
      if (prefixedSession) {
        return prefixedSession;
      }
    }
  }

  return { kind: "unknown", label };
}

export function resolveAgentLabel(
  snapshot: RuntimeSnapshot,
  label: string,
  options: { preferLocalNodeId?: string; helpers: Pick<DispatcherHelpers, "isStale"> },
): BrokerLabelResolution {
  snapshot = routingRegistryView(snapshot);
  const trimmed = label.trim();
  if (!trimmed) {
    return { kind: "unparseable", label };
  }

  const identity = parseAgentIdentity(trimmed.startsWith("@") ? trimmed : `@${trimmed}`);
  if (!identity) {
    return { kind: "unparseable", label };
  }
  if (isBareReservedProductIdentity(identity)) {
    return { kind: "unknown", label: identity.label };
  }

  const candidates = (agentCandidateIndex(snapshot).byName.get(identity.definitionId) ?? [])
    .filter((candidate) => !options.helpers.isStale(candidate.agent));
  const diagnosis = diagnoseAgentIdentity(identity, candidates);
  const harnessAgnosticIdentity = stripHarnessQualifier(identity);

  if (diagnosis.kind === "resolved") {
    return { kind: "resolved", agent: diagnosis.match.agent };
  }

  if (diagnosis.kind === "unknown") {
    const session = resolveSessionHandleLabel(snapshot, identity, options);
    if (session) {
      return session;
    }

    const bareHandle = normalizeAgentSelectorSegment(identity.definitionId);
    if (bareHandle && !bareHandle.startsWith("project-")) {
      const prefixed = parseAgentIdentity(`@project-${bareHandle}`);
      if (prefixed) {
        const prefixedSession = resolveSessionHandleLabel(snapshot, prefixed, options);
        if (prefixedSession) {
          return prefixedSession;
        }
      }
    }

    const modelQualifiedResolution = unknownModelQualifiedResolution(identity, candidates);
    if (modelQualifiedResolution) {
      return modelQualifiedResolution;
    }

    if (harnessAgnosticIdentity) {
      const agnosticResolution = resolutionFromDiagnosis(
        diagnoseAgentIdentity(harnessAgnosticIdentity, candidates),
        identity.label,
      );
      if (agnosticResolution) {
        return agnosticResolution;
      }
    }
    return { kind: "unknown", label: identity.label };
  }

  const preferLocal = options.preferLocalNodeId?.trim();
  if (preferLocal) {
    const localOnly = diagnosis.candidates.filter(
      (candidate) => candidate.agent.authorityNodeId === preferLocal,
    );
    if (localOnly.length === 1) {
      return { kind: "resolved", agent: localOnly[0].agent };
    }
    if (localOnly.length > 1 && localOnly.length < diagnosis.candidates.length) {
      return {
        kind: "ambiguous",
        label: identity.label,
        candidates: localOnly.map((candidate) => candidate.agent),
      };
    }
  }

  return {
    kind: "ambiguous",
    label: identity.label,
    candidates: diagnosis.candidates.map((candidate) => candidate.agent),
  };
}

function projectCandidateRank(
  snapshot: RuntimeSnapshot,
  agent: AgentDefinition,
  preferLocalNodeId: string | undefined,
): number {
  const endpoint = homeEndpointForAgent(snapshot, agent.id);
  const nodeRank = preferLocalNodeId && agent.authorityNodeId === preferLocalNodeId ? 100 : 0;
  return nodeRank + endpointAvailabilityScore(endpoint);
}

function resolveProjectPathTarget(
  snapshot: RuntimeSnapshot,
  projectPath: string,
  options: {
    preferLocalNodeId?: string;
    preferredAgentId?: string;
    helpers: Pick<DispatcherHelpers, "isStale">;
  },
): BrokerLabelResolution {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  if (!normalizedProjectPath) {
    return { kind: "unparseable", label: projectPath };
  }

  const candidates = Object.values(snapshot.agents)
    .filter((agent) => !options.helpers.isStale(agent))
    .filter((agent) => normalizeProjectPath(projectRootForAgent(snapshot, agent)) === normalizedProjectPath)
    .map((agent) => ({
      agent,
      rank: projectCandidateRank(snapshot, agent, options.preferLocalNodeId),
    }))
    .sort((left, right) => {
      const rankDelta = right.rank - left.rank;
      if (rankDelta !== 0) return rankDelta;
      return left.agent.id.localeCompare(right.agent.id);
    });

  if (candidates.length === 0) {
    return { kind: "unknown", label: projectPath };
  }

  const preferredAgentId = options.preferredAgentId?.trim();
  const preferred = preferredAgentId
    ? candidates.find((candidate) => candidate.agent.id === preferredAgentId)
    : undefined;
  if (preferred) {
    return { kind: "resolved", agent: preferred.agent };
  }

  const first = candidates[0]!;
  const second = candidates[1];
  if (!second || first.rank > second.rank) {
    return { kind: "resolved", agent: first.agent };
  }

  return {
    kind: "ambiguous",
    label: projectPath,
    candidates: candidates
      .filter((candidate) => candidate.rank === first.rank)
      .map((candidate) => candidate.agent),
  };
}

function sessionTargetLabel(endpoint: AgentEndpoint, sessionId: string): string {
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
  const root = endpoint.cwd?.trim() || endpoint.projectRoot?.trim();
  return root ? `${basename(root)}:${shortId}` : `session:${sessionId}`;
}

function compareSessionProjectionEndpoint(
  snapshot: RuntimeSnapshot,
  left: AgentEndpoint,
  right: AgentEndpoint,
  preferLocalNodeId?: string,
): number {
  const staleDelta = Number(isStaleLocalEndpoint(snapshot, left))
    - Number(isStaleLocalEndpoint(snapshot, right));
  if (staleDelta !== 0) return staleDelta;

  const localDelta = Number(Boolean(preferLocalNodeId) && right.nodeId === preferLocalNodeId)
    - Number(Boolean(preferLocalNodeId) && left.nodeId === preferLocalNodeId);
  if (localDelta !== 0) return localDelta;

  const availabilityDelta = endpointAvailabilityScore(right) - endpointAvailabilityScore(left);
  if (availabilityDelta !== 0) return availabilityDelta;

  const transportDelta = localEndpointPreferenceRank(left) - localEndpointPreferenceRank(right);
  if (transportDelta !== 0) return transportDelta;

  const lifecycleDelta = endpointLifecycleAt(right) - endpointLifecycleAt(left);
  if (lifecycleDelta !== 0) return lifecycleDelta;

  return left.id.localeCompare(right.id);
}

function canonicalNativeSessionId(endpoint: AgentEndpoint): string | null {
  return metadataStringValue(endpoint.metadata, "nativeSessionId")
    ?? metadataStringValue(endpoint.metadata, "externalSessionId")
    ?? null;
}

function compareRoutedSessionEndpoints(
  snapshot: RuntimeSnapshot,
  left: AgentEndpoint,
  right: AgentEndpoint,
  preferLocalNodeId: string | undefined,
  preferredNativeSessionId: string | undefined,
): number {
  if (preferredNativeSessionId) {
    const nativeDelta = Number(canonicalNativeSessionId(right) === preferredNativeSessionId)
      - Number(canonicalNativeSessionId(left) === preferredNativeSessionId);
    if (nativeDelta !== 0) return nativeDelta;
  }
  return compareSessionProjectionEndpoint(snapshot, left, right, preferLocalNodeId);
}

function resolveSessionTarget(
  snapshot: RuntimeSnapshot,
  sessionId: string,
  options: {
    helpers: Pick<DispatcherHelpers, "isStale">;
    harness?: AgentHarness;
    host?: string;
    preferLocalNodeId?: string;
  },
): BrokerLabelResolution {
  const label = sessionRouteLabel(sessionId, options.harness, options.host);
  const anyHost = endpointsForSession(snapshot, sessionId)
    .filter((endpoint) => endpointMatchesSessionRouteScope(endpoint, options));
  const hostScope = options.host ? sessionHostScope(snapshot, options.host, options.preferLocalNodeId) : null;
  const matching = hostScope
    ? anyHost.filter((endpoint) => hostScope.nodeIds.has(endpoint.nodeId))
    : anyHost;
  if (matching.length === 0) {
    return hostScope
      ? unknownOnHost(snapshot, label, options.host!, hostScope, anyHost)
      : { kind: "unknown", label };
  }

  const liveMatching = matching.filter((endpoint) => !isStaleLocalEndpoint(snapshot, endpoint));
  // A stale projection cannot make a live exact-session route ambiguous. Keep
  // stale matches only when every projection is stale so downstream can still
  // return the established unavailable diagnostic instead of losing the card.
  const routingMatches = liveMatching.length > 0 ? liveMatching : matching;
  const harnesses = [...new Set(routingMatches.map((endpoint) => endpoint.harness))]
    .sort((left, right) => left.localeCompare(right));

  // A raw native id is the exact key within a harness. Broker agent cards,
  // projects, nodes, and endpoint transports are projections of that session,
  // not separate identities the caller must choose between. Only a genuine
  // cross-harness collision requires session:<harness>:<native-id>.
  const carded = [
    ...new Map(
      routingMatches
        .map((endpoint) => snapshot.agents[endpoint.agentId])
        .filter((agent): agent is AgentDefinition => Boolean(agent))
        .map((agent) => [agent.id, agent] as const),
    ).values(),
  ];
  if (!options.harness && harnesses.length > 1) {
    return {
      kind: "ambiguous",
      label,
      candidates: [],
      detail: `${label} exists in multiple harnesses (${harnesses.join(", ")}); use session:<harness>:${sessionId}`,
    };
  }

  // One session when every match shares a single harness-native id, or when
  // every match is a strong identity for this Scout session and the native ids
  // that are present agree. A relay copy of a tmux session often stores
  // observedSessionId and omits externalSessionId; that gap is not a second
  // session. A shared tmux, pairing, or runtime alias is still not proof,
  // including when one side has no native id.
  let preferredNativeSessionId: string | undefined;
  if (routingMatches.length > 1) {
    const canonicalIds = routingMatches.map(canonicalNativeSessionId);
    const present = [...new Set(canonicalIds.filter((value): value is string => Boolean(value)))];
    const missingNative = canonicalIds.some((value) => !value);
    const sameStrongSession = routingMatches.every((endpoint) => endpointStronglyMatchesSession(endpoint, sessionId));
    const collapse = (!missingNative && present.length === 1) || (sameStrongSession && present.length <= 1);
    if (!collapse) {
      const exactRoutes = [...new Set(routingMatches.flatMap((endpoint) => {
        const nativeId = canonicalNativeSessionId(endpoint);
        return nativeId ? [`session:${endpoint.harness}:${nativeId}`] : [];
      }))].sort((left, right) => left.localeCompare(right));
      return {
        kind: "ambiguous",
        label,
        candidates: carded,
        detail: exactRoutes.length > 0
          ? `${label} is an alias for multiple native sessions; use an exact route (${exactRoutes.join(", ")})`
          : `${label} matches multiple session projections without one canonical native session id`,
      };
    }
    if (present.length === 1) preferredNativeSessionId = present[0];
  }

  // Preserve card-backed identity and downstream unavailable diagnostics. If
  // every projection is stale, `routingMatches` intentionally still contains
  // those cards so the caller receives unavailable rather than unknown.
  if (carded.length === 1) {
    return { kind: "resolved", agent: carded[0]! };
  }
  if (carded.length > 1) {
    // Prefer the projection that carries the harness-native id. Availability
    // would otherwise pick an active tmux relay that never stored that id.
    const endpoint = [...routingMatches]
      .filter((candidate) => Boolean(snapshot.agents[candidate.agentId]))
      .sort((left, right) =>
        compareRoutedSessionEndpoints(snapshot, left, right, options.preferLocalNodeId, preferredNativeSessionId)
      )[0]!;
    return { kind: "resolved", agent: snapshot.agents[endpoint.agentId]! };
  }

  // Cardless path (SCO-070): no backing AgentDefinition on any matching endpoint.
  // Drop stale/terminal endpoints (staleLocalRegistration is authoritative) and
  // collapse to the preferred live endpoint — multiple endpoints sharing a session
  // id is a transport choice, not an identity ambiguity.
  const live = matching.filter((endpoint) => !isStaleLocalEndpoint(snapshot, endpoint));
  if (live.length === 0) {
    return { kind: "unknown", label };
  }
  const endpoint = [...live]
    .sort((left, right) =>
      compareRoutedSessionEndpoints(snapshot, left, right, options.preferLocalNodeId, preferredNativeSessionId)
    )[0]!;
  return {
    kind: "resolved_session",
    session: {
      sessionId,
      actorId: endpoint.agentId,
      endpoint,
      label: sessionTargetLabel(endpoint, sessionId),
      nodeId: endpoint.nodeId,
    },
  };
}

/**
 * Nodes a session-address host names. The host is the authority boundary:
 * resolution never leaves it, so an address cannot be satisfied by a
 * same-token projection on another machine.
 */
function sessionHostScope(
  snapshot: RuntimeSnapshot,
  host: string,
  localNodeId: string | undefined,
): { nodeIds: Set<string>; includesLocal: boolean } {
  const nodeIds = new Set(sessionHostNodeIds(snapshot, host));
  // The local broker always answers for itself, even before its own node
  // record is registered in the snapshot.
  if (localNodeId && sessionHostForNodeId(snapshot, localNodeId) === host) {
    nodeIds.add(localNodeId);
  }
  return { nodeIds, includesLocal: Boolean(localNodeId && nodeIds.has(localNodeId)) };
}

function unknownOnHost(
  snapshot: RuntimeSnapshot,
  label: string,
  host: string,
  scope: { nodeIds: Set<string>; includesLocal: boolean },
  anyHost: AgentEndpoint[],
): BrokerLabelResolution {
  if (scope.nodeIds.size === 0) {
    return {
      kind: "unknown",
      label,
      detail: `${label}: no mesh node is known as host "${host}"`,
      sessionWakeReason: "session_host_unknown",
    };
  }
  const elsewhere = [...new Set(anyHost.map((endpoint) => sessionHostForNodeId(snapshot, endpoint.nodeId)))]
    .sort((left, right) => left.localeCompare(right));
  if (elsewhere.length > 0) {
    return {
      kind: "unknown",
      label,
      detail: `${label}: that session is not on host "${host}" (known on ${elsewhere.join(", ")}); Scout does not substitute another host's session`,
      sessionWakeReason: "session_not_on_host",
    };
  }
  if (!scope.includesLocal) {
    return {
      kind: "unknown",
      label,
      detail: `${label}: host "${host}" (${[...scope.nodeIds].join(", ")}) has not shared this session with this broker; cross-host session-address resolution is not available yet`,
      sessionWakeReason: "session_host_not_projected",
    };
  }
  return { kind: "unknown", label };
}

export function resolveBrokerRouteTarget(
  snapshot: RuntimeSnapshot,
  input: BrokerRouteTargetInput,
  options: { preferLocalNodeId?: string; helpers: Pick<DispatcherHelpers, "isStale"> },
): BrokerLabelResolution {
  snapshot = routingRegistryView(snapshot);
  const policy = input.routePolicy;
  const routeTarget = input.target;
  const preferLocalNodeId = policy?.preferLocalNodeId?.trim() || options.preferLocalNodeId;
  const directRouteAgentId = routeTarget?.kind === "agent_id"
    ? normalizedRouteTargetValue(routeTarget)
    : undefined;

  const directSessionId = routeTarget?.kind === "session_id"
    ? normalizedRouteTargetValue(routeTarget)
    : bareRouteSessionId(input);
  if (directSessionId) {
    const directSessionHarness = routeTarget?.kind === "session_id"
      ? routeTarget.harness
      : input.execution?.harness;
    const directSessionHost = routeTarget?.kind === "session_id"
      ? normalizeScoutSessionHost(routeTarget.host) || undefined
      : undefined;
    return resolveSessionTarget(snapshot, directSessionId, {
      helpers: options.helpers,
      harness: directSessionHarness,
      ...(directSessionHost ? { host: directSessionHost } : {}),
      preferLocalNodeId,
    });
  }

  // Broker-owned alias state is dereferenced by BrokerRouteAliasService before
  // entering this pure snapshot resolver.
  if (routeTarget?.kind === "route_alias") {
    return { kind: "unknown", label: routeTarget.value ?? `alias:${routeTarget.alias}` };
  }

  if (routeTarget?.kind === "target_handle") {
    return resolveTargetHandle(snapshot, routeTarget.handle, {
      helpers: options.helpers,
    });
  }
  if (routeTarget?.kind === "existing_handle") {
    return resolveExistingHandle(snapshot, routeTarget.handle, {
      helpers: options.helpers,
    });
  }
  if (!routeTarget && input.targetLabel) {
    const parsedTargetLabel = parseScoutComposerRouteTarget(input.targetLabel);
    if (parsedTargetLabel?.kind === "target_handle") {
      return resolveTargetHandle(snapshot, parsedTargetLabel.handle, {
        helpers: options.helpers,
      });
    }
  }

  if (directRouteAgentId) {
    const agent = snapshot.agents[directRouteAgentId];
    if (agent && (policy?.allowHistoricalDirectId ?? policy?.allowStaleDirectId ?? true)) {
      return { kind: "resolved", agent };
    }
    if (agent && !options.helpers.isStale(agent)) {
      return { kind: "resolved", agent };
    }
  }

  if (
    routeTarget?.kind === "runtime_profile"
    && !resolveBrokerRuntimeProfile(routeTarget.profile)
  ) {
    return {
      kind: "unknown",
      label: `profile:${routeTarget.profile}`,
      detail: `unknown runtime profile "${routeTarget.profile}"`,
    };
  }
  if (
    routeTarget?.kind === "runtime_profile"
    && !executionForBrokerRuntimeProfile({
      profileId: routeTarget.profile,
      reasoningEffort: routeTarget.reasoningEffort,
    })
  ) {
    return {
      kind: "unparseable",
      label: `profile:${routeTarget.profile}`,
    };
  }

  const projectPath = routeTarget?.kind === "project_path"
    ? normalizedRouteTargetValue(routeTarget)
    : routeTarget?.kind === "runtime_profile"
    ? routeTarget.projectPath.trim()
    : "";
  if (projectPath) {
    return resolveProjectPathTarget(snapshot, projectPath, {
      preferLocalNodeId,
      preferredAgentId: input.targetAgentId?.trim() || undefined,
      helpers: options.helpers,
    });
  }

  const directId = input.targetAgentId?.trim();
  if (directId) {
    const agent = snapshot.agents[directId];
    if (agent && (policy?.allowHistoricalDirectId ?? policy?.allowStaleDirectId ?? true)) {
      return { kind: "resolved", agent };
    }
    if (agent && !options.helpers.isStale(agent)) {
      return { kind: "resolved", agent };
    }
  }

  const bindingRef = routeTarget?.kind === "binding_ref"
    ? normalizedRouteTargetValue(routeTarget)
    : input.targetLabel?.trim().startsWith("ref:")
    ? input.targetLabel.trim().slice("ref:".length)
    : "";
  if (bindingRef) {
    const normalizedRef = bindingRef.toLowerCase();
    const matches = Object.values(snapshot.flights ?? {}).filter((flight) =>
      flight.id.toLowerCase() === normalizedRef
      || flight.id.toLowerCase().endsWith(normalizedRef)
      || String(flight.metadata?.["bindingRef"] ?? "").toLowerCase() === normalizedRef
    );
    if (matches.length === 1) {
      const flight = matches[0]!;
      const agent = snapshot.agents[flight.targetAgentId];
      if (agent) {
        return { kind: "resolved", agent };
      }
      return resolveSessionTarget(snapshot, flight.targetAgentId, {
        helpers: options.helpers,
        preferLocalNodeId,
      });
    }
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        label: `ref:${bindingRef}`,
        candidates: matches
          .map((flight) => snapshot.agents[flight.targetAgentId])
          .filter((agent): agent is AgentDefinition => Boolean(agent)),
      };
    }
    return { kind: "unknown", label: `ref:${bindingRef}` };
  }

  const label = routeTarget?.kind === "agent_label"
    ? normalizedRouteTargetValue(routeTarget) ?? ""
    : input.targetLabel?.trim() || directId || "";
  if (!label) {
    return { kind: "unparseable", label: "" };
  }

  return resolveAgentLabel(snapshot, label, {
    preferLocalNodeId,
    helpers: options.helpers,
  });
}

export function summarizeDispatchCandidate(
  agent: AgentDefinition,
  snapshot: RuntimeSnapshot,
  helpers: Pick<DispatcherHelpers, "homeEndpointFor">,
  label: string,
): ScoutDispatchCandidate {
  const endpoint = helpers.homeEndpointFor(snapshot, agent.id);
  return {
    agentId: agent.id,
    displayName: agent.displayName ?? agent.id,
    label,
    authorityNodeId: agent.authorityNodeId,
    homeNodeId: agent.homeNodeId,
    advertiseScope: agent.advertiseScope,
    selector: metadataStringValue(agent.metadata, "selector") ?? null,
    defaultSelector: metadataStringValue(agent.metadata, "defaultSelector") ?? null,
    workspace: metadataStringValue(agent.metadata, "workspaceQualifier") ?? null,
    node: metadataStringValue(agent.metadata, "nodeQualifier") ?? null,
    projectRoot: endpoint?.projectRoot
      ?? endpoint?.cwd
      ?? metadataStringValue(agent.metadata, "projectRoot")
      ?? null,
    endpointState: endpointCandidateState(endpoint?.state),
    transport: endpoint?.transport ?? null,
  };
}

export function buildDispatchEnvelope(
  resolution: Exclude<BrokerLabelResolution, { kind: "resolved" } | { kind: "resolved_session" }>,
  askedLabel: string,
  dispatcherNodeId: string,
  snapshot: RuntimeSnapshot,
  helpers: Pick<DispatcherHelpers, "homeEndpointFor">,
): ScoutDispatchEnvelope {
  const kind: ScoutDispatchKind = resolution.kind;
  const dispatchedAt = Date.now();
  const trimmedAsked = askedLabel.trim();

  if (resolution.kind === "unparseable") {
    return {
      kind,
      askedLabel: trimmedAsked,
      detail: trimmedAsked
        ? `could not parse "${trimmedAsked}" as an agent reference`
        : "no target agent provided",
      candidates: [],
      dispatchedAt,
      dispatcherNodeId,
    };
  }

  if (resolution.kind === "unknown") {
    const candidates = (resolution.candidates ?? []).map((agent) =>
      buildAgentLabelCandidate(snapshot, agent)
    );
    return {
      kind,
      askedLabel: resolution.label,
      detail: resolution.detail ?? `no agent matches ${resolution.label}`,
      candidates: (resolution.candidates ?? []).map((agent, index) =>
        summarizeDispatchCandidate(
          agent,
          snapshot,
          helpers,
          formatMinimalAgentIdentity(candidates[index]!, candidates),
        ),
      ),
      ...(resolution.diagnosticCode ? { diagnosticCode: resolution.diagnosticCode } : {}),
      ...(resolution.sessionWakeReason ? { sessionWakeReason: resolution.sessionWakeReason } : {}),
      dispatchedAt,
      dispatcherNodeId,
    };
  }

  const candidates = resolution.candidates.map((agent) =>
    buildAgentLabelCandidate(snapshot, agent)
  );

  return {
    kind,
    askedLabel: resolution.label,
    detail: resolution.detail ?? `${resolution.label} matches ${resolution.candidates.length} agents; pick one`,
    candidates: resolution.candidates.map((agent, index) =>
      summarizeDispatchCandidate(
        agent,
        snapshot,
        helpers,
        formatMinimalAgentIdentity(candidates[index]!, candidates),
      ),
    ),
    dispatchedAt,
    dispatcherNodeId,
  };
}
