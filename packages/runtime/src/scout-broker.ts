import { prepareScoutDelivery, deliverScoutRequest } from "./delivery-client.js";
import { iterateMessageRecords } from "./broker-message-records.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  BUILT_IN_AGENT_DEFINITION_IDS,
  conversationNaturalKey,
  conversationsWithNaturalKey,
  namedChannelNaturalKey,
  diagnoseAgentIdentity,
  directChannelNaturalKey,
  extractAgentSelectors,
  formatMinimalAgentIdentity,
  mintChannelId,
  preferredConversationWithNaturalKey,
  stableChannelId,
  systemChannelNaturalKey,
  normalizeAgentSelectorSegment,
  withAgentReferenceAliases,
  type AgentHarness,
  type AgentSelector,
  type AgentSelectorCandidate,
  type AgentState,
  type ControlEvent,
  type MessageRecord,
  type ScoutDeliverRequest,
  type ScoutDeliverResponse,
  type ScoutDispatchRecord,
  type ThreadEventEnvelope,
  type ThreadSnapshot,
  type ThreadWatchOpenRequest,
  type ThreadWatchOpenResponse,
  type ThreadWatchRenewResponse,
  type WakePolicy,
  epochMs,
} from "@openscout/protocol";

import {
  ensureRelayAgentConfigured,
  findNearestProjectRoot,
  loadResolvedRelayAgents,
  resolveRelayAgentConfig,
  SCOUT_AGENT_ID,
  type ResolvedRelayAgentConfig,
} from "./setup.js";
import {
  inferLocalAgentBinding,
  SUPPORTED_LOCAL_AGENT_HARNESSES,
  SUPPORTED_SCOUT_HARNESSES,
} from "./local-agents.js";
import {
  maybePostJsonToActiveScoutBrokerService,
  maybeReadJsonFromActiveScoutBrokerService,
  requestScoutBrokerJson,
  ScoutBrokerHttpError,
} from "./broker-api.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";
import {
  resolveScoutBrokerControlUrl,
  resolveBrokerSocketPathForBaseUrl,
} from "./broker-process-manager.js";
import { endpointAvailabilityScore } from "./broker-endpoint-selection.js";
import { isOperatorTitled, resolveConversationTitle } from "./conversation-title.js";

export type ScoutBrokerActorRecord = {
  id: string;
  kind?: string;
  displayName?: string;
  handle?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
};

export type ScoutBrokerAgentRecord = ScoutBrokerActorRecord & {
  definitionId?: string;
  nodeQualifier?: string;
  workspaceQualifier?: string;
  selector?: string;
  defaultSelector?: string;
  agentClass?: string;
  capabilities?: string[];
  wakePolicy?: string;
  homeNodeId?: string;
  authorityNodeId?: string;
  advertiseScope?: string;
};

export type ScoutBrokerEndpointRecord = {
  id: string;
  agentId: string;
  nodeId?: string;
  harness?: string;
  transport?: string;
  state?: AgentState;
  address?: string;
  sessionId?: string;
  cwd?: string;
  projectRoot?: string;
  metadata?: Record<string, unknown>;
};

export type ScoutBrokerConversationRecord = {
  id: string;
  kind: string;
  title: string;
  visibility: string;
  shareMode?: string;
  authorityNodeId: string;
  participantIds: string[];
  metadata?: Record<string, unknown>;
};

export type ScoutBrokerMessageRecord = MessageRecord;

export type ScoutBrokerSnapshot = {
  actors: Record<string, ScoutBrokerActorRecord>;
  agents: Record<string, ScoutBrokerAgentRecord>;
  endpoints: Record<string, ScoutBrokerEndpointRecord>;
  conversations: Record<string, ScoutBrokerConversationRecord>;
  messages: Record<string, ScoutBrokerMessageRecord>;
};

export type ScoutBrokerNodeRecord = {
  id: string;
  brokerUrl?: string;
};

export type ScoutBrokerContext = {
  baseUrl: string;
  node: ScoutBrokerNodeRecord;
  snapshot: ScoutBrokerSnapshot;
};

export type ScoutMentionTarget = {
  agentId: string;
  label: string;
  selector: AgentSelector;
};

export type ScoutTargetDiagnostic =
  | {
      agentId: string;
      state: AgentState | "discovered" | "unknown";
      registrationKind: ScoutWhoRegistrationKind | null;
      projectRoot: string | null;
    }
  | {
      agentId: string;
      state: "unavailable";
      detail: string;
      wakePolicy: WakePolicy | null;
      transport: string | null;
      projectRoot: string | null;
    }
  | {
      state: "ambiguous";
      candidates: ScoutAskAmbiguousCandidate[];
      detail?: string;
    }
  | {
      state: "invalid" | "missing";
      askedLabel: string;
      detail: string;
    };

export type ScoutMessagePostResult = {
  usedBroker: boolean;
  conversationId?: string;
  messageId?: string;
  flight?: ScoutFlightRecord;
  invokedTargets: string[];
  unresolvedTargets: string[];
  targetDiagnostic?: ScoutTargetDiagnostic;
  routeKind?: "dm" | "channel" | "broadcast";
  routingError?:
    | "missing_destination"
    | "multi_target_requires_explicit_channel";
};

export type ScoutFlightRecord = {
  id: string;
  invocationId: string;
  requesterId: string;
  targetAgentId: string;
  state: string;
  summary?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
};

export type ScoutAskResult = {
  usedBroker: boolean;
  flight?: ScoutFlightRecord;
  conversationId?: string;
  messageId?: string;
  unresolvedTarget?: string;
  targetDiagnostic?: ScoutAskTargetDiagnostic;
};

export type ScoutAskTargetDiagnostic = ScoutTargetDiagnostic;

export type ScoutAskAmbiguousCandidate = {
  agentId: string;
  label: string;
};

export type ScoutWatchOptions = {
  channel?: string;
  signal?: AbortSignal;
  onMessage: (message: ScoutBrokerMessageRecord) => void;
};

export type ScoutThreadWatchOptions = {
  baseUrl?: string;
  conversationId: string;
  watcherNodeId: string;
  watcherId: string;
  afterSeq?: number;
  leaseMs?: number;
  signal?: AbortSignal;
  onEvent: (event: ThreadEventEnvelope) => void;
};

export type ScoutWhoRegistrationKind = "broker" | "configured" | "discovered";

export type ScoutWhoEntry = {
  agentId: string;
  state: AgentState | "discovered";
  messages: number;
  lastSeen: number | null;
  registrationKind: ScoutWhoRegistrationKind;
};

type RelayConfig = {
  channels?: Record<string, { audio: boolean; voice?: string }>;
  defaultVoice?: string;
  pronunciations?: Record<string, string>;
  openaiApiKey?: string;
};

const OPERATOR_ID = "operator";

function relayHubDirectory(): string {
  return resolveOpenScoutSupportPaths().relayHubDirectory;
}

export function resolveScoutBrokerUrl(): string {
  const explicit = process.env.OPENSCOUT_BROKER_URL?.trim();
  if (explicit) return explicit;
  return resolveScoutBrokerControlUrl();
}

export function resolveScoutAgentName(agentName?: string | null): string {
  const trimmed = agentName?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (process.env.OPENSCOUT_AGENT?.trim()) {
    return process.env.OPENSCOUT_AGENT.trim();
  }
  return OPERATOR_ID;
}

export function parseScoutHarness(value?: string | null): AgentHarness | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (SUPPORTED_SCOUT_HARNESSES.includes(trimmed as AgentHarness)) {
    return trimmed as AgentHarness;
  }
  throw new Error(`Unsupported harness "${trimmed}". Use one of: ${SUPPORTED_SCOUT_HARNESSES.join(", ")}`);
}

export function formatScoutTimestamp(timestamp: number): string {
  const value = new Date(timestamp * 1000);
  const hh = String(value.getHours()).padStart(2, "0");
  const mm = String(value.getMinutes()).padStart(2, "0");
  const ss = String(value.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function formatScoutMessageLine(message: ScoutBrokerMessageRecord): string {
  const timestamp = normalizeUnixTimestamp(message.createdAt) ?? Math.floor(Date.now() / 1000);
  const body = message.body;
  const type = message.class === "system" || message.class === "status" ? "SYS" : "MSG";
  if (type === "SYS") {
    return `${formatScoutTimestamp(timestamp)} · ${body}`;
  }
  return `${formatScoutTimestamp(timestamp)} ${message.actorId}  ${body}`;
}

function generateMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function nextSseBlock(buffer: string): { block: string; rest: string } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");

  if (lfIndex === -1 && crlfIndex === -1) {
    return null;
  }

  if (crlfIndex === -1 || (lfIndex !== -1 && lfIndex < crlfIndex)) {
    return {
      block: buffer.slice(0, lfIndex),
      rest: buffer.slice(lfIndex + 2),
    };
  }

  return {
    block: buffer.slice(0, crlfIndex),
    rest: buffer.slice(crlfIndex + 4),
  };
}

function titleCaseName(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataBoolean(metadata: Record<string, unknown> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function isBuiltInBrokerAgent(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): boolean {
  const agent = snapshot.agents[agentId];
  const definitionId = agent?.definitionId
    ?? metadataString(agent?.metadata, "definitionId")
    ?? agentId;
  return BUILT_IN_AGENT_DEFINITION_IDS.has(definitionId);
}

function isInactiveBrokerAgent(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): boolean {
  const agent = snapshot.agents[agentId];
  if (!agent) {
    return false;
  }
  return metadataBoolean(agent.metadata, "retiredFromFleet")
    || metadataBoolean(agent.metadata, "staleLocalRegistration");
}

export function normalizeUnixTimestamp(value: unknown): number | null {
  const ms = epochMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

function maxDefined(values: Array<number | null | undefined>): number | null {
  let maxValue: number | null = null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    maxValue = maxValue === null ? value : Math.max(maxValue, value);
  }
  return maxValue;
}

async function brokerReadJson<T>(baseUrl: string, path: string): Promise<T> {
  const direct = await maybeReadJsonFromActiveScoutBrokerService<T>(
    baseUrl,
    path,
  );
  if (direct.handled) {
    return direct.value;
  }

  return requestScoutBrokerJson<T>(baseUrl, path, {
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
  });
}

type BrokerPostJsonOptions<T> = {
  acceptErrorJson?: (value: unknown) => value is T;
};

async function brokerPostJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  options: BrokerPostJsonOptions<T> = {},
): Promise<T> {
  const direct = await maybePostJsonToActiveScoutBrokerService<T>(
    baseUrl,
    path,
    body,
  );
  if (direct.handled) {
    return direct.value;
  }
  return requestScoutBrokerJson<T>(baseUrl, path, {
    method: "POST",
    body,
    acceptErrorJson: options.acceptErrorJson,
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
  });
}

async function brokerPostDeliver(baseUrl: string, body: ScoutDeliverRequest): Promise<ScoutDeliverResponse> {
  const direct = await maybePostJsonToActiveScoutBrokerService<ScoutDeliverResponse>(baseUrl, "/v1/deliver", body);
  if (direct.handled) return direct.value;
  return deliverScoutRequest({ baseUrl, expectedNodeId: body.requesterNodeId!, socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl) }, body);
}

function renderScoutTargetLabel(targetLabel: string): string {
  const trimmed = targetLabel.trim();
  if (!trimmed) {
    return "";
  }
  if (
    trimmed.startsWith("@")
    || /^(?:ref|session|target|target-handle|target_handle|channel):/i.test(trimmed)
    || /^broadcast$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return `@${trimmed}`;
}

function scoutTargetDiagnosticFromDeliveryFailure(
  delivery: Exclude<ScoutDeliverResponse, { kind: "delivery" }>,
): ScoutTargetDiagnostic | undefined {
  const dispatch = (delivery.kind === "question"
    ? delivery.question
    : delivery.rejection) as ScoutDispatchRecord | undefined;
  if (!dispatch) {
    return undefined;
  }

  if (dispatch.kind === "ambiguous") {
    return {
      state: "ambiguous",
      candidates: dispatch.candidates.map((candidate) => ({
        agentId: candidate.agentId,
        label: candidate.label,
      })),
      detail: dispatch.detail,
    };
  }
  if (dispatch.kind === "unavailable" && dispatch.target) {
    return {
      agentId: dispatch.target.agentId,
      state: "unavailable",
      detail: dispatch.target.detail,
      wakePolicy: dispatch.target.wakePolicy ?? null,
      transport: dispatch.target.transport ?? null,
      projectRoot: dispatch.target.projectRoot ?? null,
    };
  }
  if (dispatch.kind === "unknown") {
    return {
      agentId: dispatch.askedLabel,
      state: "unknown",
      registrationKind: null,
      projectRoot: null,
    };
  }
  if (delivery.kind === "rejected" && dispatch.kind === "unparseable") {
    return {
      state: delivery.reason === "missing_target" ? "missing" : "invalid",
      askedLabel: dispatch.askedLabel,
      detail: dispatch.detail,
    };
  }
  return undefined;
}

export async function loadScoutBrokerContext(baseUrl = resolveScoutBrokerUrl()): Promise<ScoutBrokerContext | null> {
  try {
    const health = await brokerReadJson<{ ok?: boolean }>(baseUrl, "/health");
    if (!health.ok) {
      return null;
    }

    const [node, snapshot] = await Promise.all([
      brokerReadJson<ScoutBrokerNodeRecord>(baseUrl, "/v1/node"),
      brokerReadJson<ScoutBrokerSnapshot>(baseUrl, "/v1/snapshot"),
    ]);

    if (!node.id) {
      return null;
    }

    return {
      baseUrl,
      node,
      snapshot,
    };
  } catch {
    return null;
  }
}

export async function requireScoutBrokerContext(baseUrl = resolveScoutBrokerUrl()): Promise<ScoutBrokerContext> {
  const context = await loadScoutBrokerContext(baseUrl);
  if (!context) {
    throw new Error(`Broker is not reachable at ${baseUrl}. Run scout setup first.`);
  }
  return context;
}

function resolveConversationIdForChannel(
  snapshot: ScoutBrokerSnapshot,
  channel?: string,
): string | null {
  const requestedChannel = channel?.trim() || "shared";
  const normalizedChannel = requestedChannel === "shared" ? "broadcast" : requestedChannel;
  const naturalKey = normalizedChannel === "system"
    ? systemChannelNaturalKey("system")
    : namedChannelNaturalKey(normalizedChannel);
  return findConversationByIdentity(snapshot, naturalKey)?.id ?? null;
}

function relayRouteKind(
  conversation: { id: string; kind: string; metadata?: Record<string, unknown> },
): "dm" | "channel" | "broadcast" {
  if (conversation.kind === "direct") {
    return "dm";
  }
  return conversation.metadata?.channel === "shared" || conversation.metadata?.channel === "broadcast"
    ? "broadcast"
    : "channel";
}

function preferredBrokerEndpointForAgent(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): ScoutBrokerEndpointRecord | undefined {
  return Object.values(snapshot.endpoints ?? {})
    .filter((endpoint) => endpoint.agentId === agentId)
    .sort((left, right) => endpointAvailabilityScore(right) - endpointAvailabilityScore(left))[0];
}

function buildMentionCandidate(
  snapshot: ScoutBrokerSnapshot,
  agent: ScoutBrokerAgentRecord,
): AgentSelectorCandidate {
  const preferred = preferredBrokerEndpointForAgent(snapshot, agent.id);
  const harness = preferred?.harness
    ?? metadataString(agent.metadata, "harness")
    ?? metadataString(agent.metadata, "defaultHarness");
  const profile = metadataString(agent.metadata, "profile");
  const model = metadataString(preferred?.metadata, "model")
    ?? metadataString(agent.metadata, "model");
  const workspaceQualifier = agent.workspaceQualifier ?? metadataString(agent.metadata, "workspaceQualifier");
  const referenceId = workspaceQualifier
    ?? metadataString(preferred?.metadata, "runtimeInstanceId")
    ?? preferred?.sessionId
    ?? agent.id;
  return {
    agentId: agent.id,
    definitionId: agent.definitionId || metadataString(agent.metadata, "definitionId") || agent.id,
    nodeQualifier: agent.nodeQualifier ?? metadataString(agent.metadata, "nodeQualifier"),
    workspaceQualifier,
    ...(harness ? { harness } : {}),
    ...(profile ? { profile } : {}),
    ...(model ? { model } : {}),
    ...(referenceId ? { referenceId } : {}),
    aliases: [
      agent.selector,
      agent.defaultSelector,
      metadataString(agent.metadata, "selector"),
      metadataString(agent.metadata, "defaultSelector"),
    ].filter(Boolean) as string[],
  };
}

function formatMentionCandidateLabel(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): string {
  const current = snapshot.agents[agentId];
  if (!current) {
    return `@${agentId}`;
  }
  const candidates = withAgentReferenceAliases(
    Object.values(snapshot.agents)
      .filter((agent) => !isInactiveBrokerAgent(snapshot, agent.id))
      .map((agent) => buildMentionCandidate(snapshot, agent)),
  );
  const currentCandidate = candidates.find((candidate) => candidate.agentId === current.id)
    ?? buildMentionCandidate(snapshot, current);
  return formatMinimalAgentIdentity(
    currentCandidate,
    candidates,
  );
}

function normalizeProjectLocalResolutionValue(
  value: string | null | undefined,
): string {
  return value?.trim().toLowerCase().replace(/^@+/, "") ?? "";
}

function matchesObviousProjectLocalAlias(
  value: string | null | undefined,
  query: string,
): boolean {
  const normalized = normalizeProjectLocalResolutionValue(value);
  if (!normalized || !query) {
    return false;
  }
  return normalized === query
    || normalized.startsWith(`${query}-`)
    || normalized.startsWith(`${query}.`)
    || normalized.startsWith(`${query}_`)
    || normalized.startsWith(`${query} `);
}

function agentProjectRoot(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): string | null {
  const preferred = preferredBrokerEndpointForAgent(snapshot, agentId);
  return preferred?.projectRoot
    ?? preferred?.cwd
    ?? metadataString(snapshot.agents[agentId]?.metadata, "projectRoot")
    ?? null;
}

function agentPreferredState(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): AgentState | "discovered" {
  const preferred = preferredBrokerEndpointForAgent(snapshot, agentId);
  return preferred?.state ?? "offline";
}

function scoreProjectLocalBrokerAgent(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
  currentProjectRoot: string,
  query: string,
): number {
  const projectRoot = agentProjectRoot(snapshot, agentId);
  if (!projectRoot || resolve(projectRoot) !== resolve(currentProjectRoot)) {
    return -1;
  }

  const agent = snapshot.agents[agentId];
  const formattedLabel = formatMentionCandidateLabel(snapshot, agentId);
  const values = [
    formattedLabel,
    agent?.defaultSelector,
    agent?.selector,
    agent?.handle,
    agent?.displayName,
    agent?.definitionId,
    agentId,
  ];
  const matches = values.filter((value) =>
    matchesObviousProjectLocalAlias(value, query),
  );
  if (matches.length === 0) {
    return -1;
  }

  return 1000 + whoStateRank(agentPreferredState(snapshot, agentId)) * 20;
}

async function findPreferredProjectLocalBrokerTarget(
  snapshot: ScoutBrokerSnapshot,
  label: string,
  currentDirectory: string,
): Promise<ScoutMentionTarget | null> {
  const query = normalizeProjectLocalResolutionValue(label);
  if (!query) {
    return null;
  }

  const currentProjectRoot =
    await findNearestProjectRoot(currentDirectory) ?? currentDirectory;
  const scored = Object.values(snapshot.agents)
    .filter((agent) => agent.id !== OPERATOR_ID)
    .filter((agent) => !isInactiveBrokerAgent(snapshot, agent.id))
    .map((agent) => ({
      agentId: agent.id,
      score: scoreProjectLocalBrokerAgent(
        snapshot,
        agent.id,
        currentProjectRoot,
        query,
      ),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return left.agentId.localeCompare(right.agentId);
    });

  if (scored.length === 0) {
    return null;
  }
  if (scored.length > 1 && scored[0]?.score === scored[1]?.score) {
    return null;
  }

  const agentId = scored[0]?.agentId;
  if (!agentId) {
    return null;
  }
  const resolvedLabel = formatMentionCandidateLabel(snapshot, agentId);
  const selector = extractAgentSelectors(resolvedLabel)[0];
  if (!selector) {
    return null;
  }
  return {
    agentId,
    label: resolvedLabel,
    selector,
  };
}

type ScoutMentionAmbiguity = {
  label: string;
  selector: AgentSelector;
  candidates: ScoutAskAmbiguousCandidate[];
};

type ScoutSingleTargetResolution =
  | { kind: "resolved"; target: ScoutMentionTarget }
  | { kind: "ambiguous"; candidates: ScoutAskAmbiguousCandidate[] }
  | { kind: "unresolved" };

async function resolveMentionTargets(
  snapshot: ScoutBrokerSnapshot,
  text: string,
  currentDirectory: string,
): Promise<{
  resolved: ScoutMentionTarget[];
  unresolved: string[];
  ambiguous: ScoutMentionAmbiguity[];
}> {
  const selectors = extractAgentSelectors(text);
  const resolved = new Map<string, ScoutMentionTarget>();
  const unresolved: string[] = [];
  const ambiguous: ScoutMentionAmbiguity[] = [];
  const candidateMap = new Map<string, AgentSelectorCandidate>();
  const endpointBackedAgentIds = unique(
    Object.values(snapshot.endpoints)
      .map((endpoint) => endpoint.agentId)
      .filter((agentId) => (
        agentId
        && agentId !== OPERATOR_ID
        && !isInactiveBrokerAgent(snapshot, agentId)
      )),
  );

  for (const agent of Object.values(snapshot.agents)) {
    if (isInactiveBrokerAgent(snapshot, agent.id)) {
      continue;
    }
    candidateMap.set(agent.id, buildMentionCandidate(snapshot, agent));
  }

  for (const selector of selectors) {
    if (selector.definitionId === "system") {
      continue;
    }

    const discovered = await resolveRelayAgentConfig(selector, {
      currentDirectory,
    });
    if (discovered && !candidateMap.has(discovered.agentId)) {
      candidateMap.set(discovered.agentId, {
        agentId: discovered.agentId,
        definitionId: discovered.definitionId,
        nodeQualifier: discovered.instance.nodeQualifier,
        workspaceQualifier: discovered.instance.workspaceQualifier,
        harness: discovered.runtime.harness,
        aliases: [discovered.instance.selector, discovered.instance.defaultSelector],
      });
    }

    const candidates = withAgentReferenceAliases(Array.from(candidateMap.values()));
    if (selector.definitionId === "all") {
      const targetAgentIds = endpointBackedAgentIds.length > 0
        ? endpointBackedAgentIds
        : candidates.map((candidate) => candidate.agentId);
      for (const agentId of targetAgentIds) {
        resolved.set(agentId, {
          agentId,
          label: selector.label,
          selector,
        });
      }
      continue;
    }

    const diagnosis = diagnoseAgentIdentity(selector, candidates);
    if (diagnosis.kind === "resolved") {
      resolved.set(diagnosis.match.agentId, {
        agentId: diagnosis.match.agentId,
        label: selector.label,
        selector,
      });
      continue;
    }
    if (diagnosis.kind === "ambiguous") {
      ambiguous.push({
        label: selector.label,
        selector,
        candidates: diagnosis.candidates.map((candidate) => ({
          agentId: candidate.agentId,
          label: formatMinimalAgentIdentity(candidate, diagnosis.candidates),
        })),
      });
      continue;
    }
    unresolved.push(selector.label);
  }

  return {
    resolved: Array.from(resolved.values()).sort((lhs, rhs) => lhs.agentId.localeCompare(rhs.agentId)),
    unresolved: Array.from(new Set(unresolved)).sort(),
    ambiguous,
  };
}

async function resolveSingleBrokerTarget(
  snapshot: ScoutBrokerSnapshot,
  label: string,
  currentDirectory: string,
): Promise<ScoutSingleTargetResolution> {
  const normalized = label.trim();
  if (!normalized) {
    return { kind: "unresolved" };
  }

  const resolution = await resolveMentionTargets(
    snapshot,
    normalized.startsWith("@") ? normalized : `@${normalized}`,
    currentDirectory,
  );
  const preferredProjectLocalTarget =
    await findPreferredProjectLocalBrokerTarget(
      snapshot,
      normalized,
      currentDirectory,
    );
  if (preferredProjectLocalTarget) {
    return { kind: "resolved", target: preferredProjectLocalTarget };
  }

  const firstAmbiguous = resolution.ambiguous[0];
  if (firstAmbiguous) {
    return { kind: "ambiguous", candidates: firstAmbiguous.candidates };
  }
  const first = resolution.resolved[0];
  if (first) {
    return { kind: "resolved", target: first };
  }
  return { kind: "unresolved" };
}

async function describeScoutTargetAvailability(
  snapshot: ScoutBrokerSnapshot,
  target: ScoutMentionTarget,
  currentDirectory: string,
): Promise<ScoutAskTargetDiagnostic> {
  const resolvedConfig = await resolveRelayAgentConfig(target.selector, {
    currentDirectory,
  });
  const registrationKind = resolvedConfig?.registrationKind ?? null;
  const endpoints = Object.values(snapshot.endpoints ?? {}).filter((endpoint) => endpoint.agentId === target.agentId);

  if (endpoints.length > 0) {
    return {
      agentId: target.agentId,
      state: whoEntryState(endpoints, registrationKind ?? "broker"),
      registrationKind,
      projectRoot: resolvedConfig?.projectRoot ?? null,
    };
  }

  if (registrationKind === "discovered") {
    return {
      agentId: target.agentId,
      state: "discovered",
      registrationKind,
      projectRoot: resolvedConfig?.projectRoot ?? null,
    };
  }

  return {
    agentId: target.agentId,
    state: snapshot.agents[target.agentId] || registrationKind === "configured" ? "offline" : "unknown",
    registrationKind,
    projectRoot: resolvedConfig?.projectRoot ?? null,
  };
}

function resolveConversationShareMode(
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  participantIds: string[],
  fallback: "local" | "shared",
): "local" | "shared" {
  if (fallback === "shared") {
    return "shared";
  }

  const hasRemoteParticipant = participantIds.some((participantId) => {
    const participant = snapshot.agents[participantId];
    return Boolean(participant?.authorityNodeId && participant.authorityNodeId !== nodeId);
  });

  return hasRemoteParticipant ? "shared" : fallback;
}

export function stripScoutAgentSelectorLabels(text: string): string {
  return extractAgentSelectors(text).reduce((next, selector) => (
    [selector.label, `@${selector.raw}`].reduce(
      (value, label) => value.replaceAll(label, ""),
      next,
    ).replace(/\s{2,}/g, " ").trim()
  ), text).trim();
}

async function ensureBrokerActor(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
): Promise<void> {
  if (snapshot.actors[actorId] || snapshot.agents[actorId]) {
    return;
  }

  const actor: ScoutBrokerActorRecord = {
    id: actorId,
    kind: actorId === OPERATOR_ID ? "person" : "agent",
    displayName: titleCaseName(actorId),
    handle: actorId,
    labels: ["scout"],
    metadata: { source: "scout-cli" },
  };

  await brokerPostJson(baseUrl, "/v1/actors", actor);
  snapshot.actors[actorId] = actor;
}

async function syncBrokerBinding(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  binding: Awaited<ReturnType<typeof inferLocalAgentBinding>>,
  options: { includeEndpoint?: boolean } = {},
): Promise<void> {
  if (!binding) {
    return;
  }

  await brokerPostJson(baseUrl, "/v1/actors", binding.actor);
  await brokerPostJson(baseUrl, "/v1/agents", binding.agent);
  snapshot.actors[binding.actor.id] = binding.actor;
  snapshot.agents[binding.agent.id] = binding.agent;
  if (options.includeEndpoint ?? true) {
    await brokerPostJson(baseUrl, "/v1/endpoints", binding.endpoint);
    snapshot.endpoints[binding.endpoint.id] = binding.endpoint;
  }
}

export function scoutBrokerAgentRegistrationFromConfig(
  config: ResolvedRelayAgentConfig,
  nodeId: string,
): { actor: ScoutBrokerActorRecord; agent: ScoutBrokerAgentRecord } {
  const source = config.source === "inferred" ? "project-inferred" : "relay-agent-registry";
  const metadata = {
    source,
    project: config.projectName,
    projectRoot: config.projectRoot,
    tmuxSession: config.runtime.sessionId,
    definitionId: config.definitionId,
    instanceId: config.instance.id,
    selector: config.instance.selector,
    defaultSelector: config.instance.defaultSelector,
    nodeQualifier: config.instance.nodeQualifier,
    workspaceQualifier: config.instance.workspaceQualifier,
    branch: config.instance.branch,
  };

  return {
    actor: {
      id: config.agentId,
      kind: "agent",
      displayName: config.displayName,
      handle: config.definitionId,
      labels: ["relay", "project", "agent", "local-agent"],
      metadata,
    },
    agent: {
      id: config.agentId,
      kind: "agent",
      definitionId: config.definitionId,
      nodeQualifier: config.instance.nodeQualifier,
      workspaceQualifier: config.instance.workspaceQualifier,
      selector: config.instance.selector,
      defaultSelector: config.instance.defaultSelector,
      displayName: config.displayName,
      handle: config.definitionId,
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        ...metadata,
        brokerRegistered: true,
        summary: `${config.displayName} agent for ${config.projectName}.`,
        role: "Agent",
      },
      agentClass: "general",
      capabilities: config.capabilities,
      wakePolicy: "on_demand",
      homeNodeId: nodeId,
      authorityNodeId: nodeId,
      advertiseScope: "local",
    },
  };
}

async function syncBrokerAgentRegistration(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  registration: { actor: ScoutBrokerActorRecord; agent: ScoutBrokerAgentRecord },
): Promise<void> {
  await brokerPostJson(baseUrl, "/v1/actors", registration.actor);
  await brokerPostJson(baseUrl, "/v1/agents", registration.agent);
  snapshot.actors[registration.actor.id] = registration.actor;
  snapshot.agents[registration.agent.id] = registration.agent;
}

async function ensureSenderRelayAgent(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  senderId: string,
  currentDirectory: string,
): Promise<void> {
  if (snapshot.agents[senderId]) {
    return;
  }

  const configured = await ensureRelayAgentConfigured(senderId, {
    currentDirectory,
    ensureCurrentProjectConfig: true,
  });
  if (!configured) {
    return;
  }

  await syncBrokerBinding(baseUrl, snapshot, await inferLocalAgentBinding(configured.agentId, nodeId));
}

export function isReusableBrokerRegisteredTargetAgent(
  agent: ScoutBrokerAgentRecord | undefined,
): boolean {
  return Boolean(
    agent
    && !metadataBoolean(agent.metadata, "staleLocalRegistration")
    && (
      metadataString(agent.metadata, "source") !== "relay-agent-registry"
      || metadataBoolean(agent.metadata, "brokerRegistered")
    ),
  );
}

async function ensureTargetRelayAgentRegistered(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  agentId: string,
  currentDirectory: string,
): Promise<boolean> {
  const existingAgent = snapshot.agents[agentId];
  if (existingAgent && metadataBoolean(existingAgent.metadata, "retiredFromFleet")) {
    return false;
  }
  if (isReusableBrokerRegisteredTargetAgent(existingAgent)) {
    return true;
  }

  const configured = await ensureRelayAgentConfigured(agentId, {
    currentDirectory,
    syncLegacyMirror: true,
  });
  if (!configured) {
    return Boolean(existingAgent);
  }

  const binding = await inferLocalAgentBinding(configured.agentId, nodeId);
  if (!binding) {
    await syncBrokerAgentRegistration(
      baseUrl,
      snapshot,
      scoutBrokerAgentRegistrationFromConfig(configured, nodeId),
    );
    return true;
  }

  await syncBrokerBinding(baseUrl, snapshot, binding, {
    includeEndpoint: binding.endpoint.state !== "waiting",
  });
  return Boolean(binding);
}

function conversationDefinition(
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  channel: string | undefined,
  senderId: string,
  targetParticipantIds: string[] = [],
): ScoutBrokerConversationRecord {
  const requestedChannel = channel?.trim();
  if (!requestedChannel) throw new Error("Delivery requires an explicit target or channel; use scout broadcast to tell everyone.");
  const normalizedChannel = requestedChannel === "shared" ? "broadcast" : requestedChannel;
  const broadcastParticipants = normalizedChannel === "broadcast" ? unique([
    OPERATOR_ID,
    senderId,
    ...Object.values(snapshot.endpoints)
      .filter((endpoint) => endpoint.state !== "offline" && snapshot.agents[endpoint.agentId])
      .map((endpoint) => endpoint.agentId),
  ]).sort() : [];
  const scopedParticipants = unique([
    OPERATOR_ID,
    senderId,
    ...targetParticipantIds,
  ]).sort();

  if (normalizedChannel === "voice") {
    const naturalKey = namedChannelNaturalKey("voice");
    return {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: "voice",
      visibility: "workspace",
      shareMode: resolveConversationShareMode(snapshot, nodeId, scopedParticipants, "local"),
      authorityNodeId: nodeId,
      participantIds: scopedParticipants,
      metadata: {
        surface: "scout-cli",
        channel: "voice",
        naturalKey,
      },
    };
  }

  if (normalizedChannel === "system") {
    const naturalKey = systemChannelNaturalKey("system");
    return {
      id: stableChannelId(naturalKey),
      kind: "system",
      title: "system",
      visibility: "system",
      shareMode: "local",
      authorityNodeId: nodeId,
      participantIds: unique([OPERATOR_ID, senderId]).sort(),
      metadata: {
        surface: "scout-cli",
        channel: "system",
        naturalKey,
      },
    };
  }

  if (normalizedChannel === "broadcast") {
    const naturalKey = namedChannelNaturalKey("broadcast");
    return {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: "broadcast",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: nodeId,
      participantIds: broadcastParticipants,
      metadata: {
        surface: "scout-cli",
        channel: "broadcast",
        naturalKey,
      },
    };
  }

  const naturalKey = namedChannelNaturalKey(normalizedChannel);
  return {
    id: stableChannelId(naturalKey),
    kind: "channel",
    title: normalizedChannel,
    visibility: "workspace",
    shareMode: resolveConversationShareMode(snapshot, nodeId, scopedParticipants, "local"),
    authorityNodeId: nodeId,
    participantIds: scopedParticipants,
    metadata: {
      surface: "scout-cli",
      channel: normalizedChannel,
      naturalKey,
    },
  };
}

async function ensureBrokerConversation(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  channel: string | undefined,
  senderId: string,
  targetParticipantIds: string[] = [],
): Promise<ScoutBrokerConversationRecord> {
  const definition = conversationDefinition(snapshot, nodeId, channel, senderId, targetParticipantIds);
  const existing = snapshot.conversations[definition.id];
  const naturalKey = conversationNaturalKey(definition);
  const equivalentConversations = naturalKey
    ? conversationsWithNaturalKey(Object.values(snapshot.conversations), naturalKey)
    : [];
  const nextParticipants = definition.metadata?.channel === "broadcast" ? definition.participantIds : unique([
    ...equivalentConversations.flatMap((conversation) => conversation.participantIds),
    ...definition.participantIds,
  ]).sort();

  if (
    !existing
    || existing.kind !== definition.kind
    || existing.visibility !== definition.visibility
    || existing.shareMode !== definition.shareMode
    || nextParticipants.join("\u0000") !== existing.participantIds.join("\u0000")
  ) {
    const nextConversation: ScoutBrokerConversationRecord = {
      ...definition,
      participantIds: nextParticipants,
    };
    await brokerPostJson(baseUrl, "/v1/conversations", nextConversation);
    snapshot.conversations[nextConversation.id] = nextConversation;
    return nextConversation;
  }

  return existing;
}

function displayNameForBrokerActor(snapshot: ScoutBrokerSnapshot, actorId: string): string {
  return snapshot.agents[actorId]?.displayName
    ?? snapshot.actors[actorId]?.displayName
    ?? titleCaseName(actorId);
}

function findConversationByIdentity(
  snapshot: ScoutBrokerSnapshot,
  naturalKey: string,
): ScoutBrokerConversationRecord | undefined {
  return preferredConversationWithNaturalKey(
    Object.values(snapshot.conversations),
    naturalKey,
  );
}

async function ensureBrokerDirectConversationBetween(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  sourceId: string,
  targetId: string,
): Promise<{ agent: ScoutBrokerAgentRecord | undefined; conversation: ScoutBrokerConversationRecord; existed: boolean }> {
  const participantIds = [...new Set([sourceId, targetId])].sort();
  const naturalKey = directChannelNaturalKey(participantIds);
  const existing = findConversationByIdentity(snapshot, naturalKey);
  const conversationId = existing?.id ?? mintChannelId(randomUUID);
  const nextShareMode = resolveConversationShareMode(snapshot, nodeId, participantIds, "local");
  const alreadyMatches = existing
    && existing.kind === "direct"
    && existing.shareMode === nextShareMode
    && existing.visibility === "private"
    && existing.participantIds.join("\u0000") === participantIds.join("\u0000");

  if (alreadyMatches) {
    const preferredTargetId = targetId === OPERATOR_ID ? sourceId : targetId;
    return {
      agent: snapshot.agents[preferredTargetId] ?? snapshot.agents[sourceId],
      conversation: existing,
      existed: true,
    };
  }

  const nonOperatorParticipants = participantIds.filter((id) => id !== OPERATOR_ID);
  const conversationTitle = sourceId === OPERATOR_ID || targetId === OPERATOR_ID
    ? displayNameForBrokerActor(snapshot, nonOperatorParticipants[0] ?? targetId)
    : `${displayNameForBrokerActor(snapshot, sourceId)} <> ${displayNameForBrokerActor(snapshot, targetId)}`;

  const definition: ScoutBrokerConversationRecord = {
    id: conversationId,
    kind: "direct",
    /* Automatic naming defers to a human one — see conversation-title.ts. */
    title: resolveConversationTitle({
      derived: targetId === SCOUT_AGENT_ID && sourceId === OPERATOR_ID ? "Scout" : conversationTitle,
      existingTitle: existing?.title,
      existingMetadata: existing?.metadata,
    }),
    visibility: "private",
    shareMode: nextShareMode,
    authorityNodeId: nodeId,
    participantIds,
    metadata: {
      surface: "scout",
      naturalKey,
      ...(targetId === SCOUT_AGENT_ID && sourceId === OPERATOR_ID ? { role: "partner" } : {}),
      /* The rename mark rides on metadata, and this object replaces it
         wholesale — carry it or the title guard has nothing to read. */
      ...(isOperatorTitled(existing?.metadata)
        ? { titleSource: existing!.metadata!.titleSource, titleSetAt: existing!.metadata!.titleSetAt }
        : {}),
    },
  };

  await brokerPostJson(baseUrl, "/v1/conversations", definition);
  snapshot.conversations[definition.id] = definition;

  return {
    agent: snapshot.agents[targetId] ?? snapshot.agents[sourceId],
    conversation: definition,
    existed: Boolean(existing),
  };
}

export async function sendScoutMessage(input: {
  senderId: string;
  clientMessageId?: string | null;
  body: string;
  channel?: string;
  shouldSpeak?: boolean;
  createdAtMs?: number;
  executionHarness?: AgentHarness;
  currentDirectory?: string;
}): Promise<ScoutMessagePostResult> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return {
      usedBroker: false,
      invokedTargets: [],
      unresolvedTargets: [],
    };
  }

  const currentDirectory = input.currentDirectory ?? process.cwd();
  const createdAtMs = input.createdAtMs ?? Date.now();
  const mentionResolution = await resolveMentionTargets(broker.snapshot, input.body, currentDirectory);
  const selectors = extractAgentSelectors(input.body);

  await ensureSenderRelayAgent(broker.baseUrl, broker.snapshot, broker.node.id, input.senderId, currentDirectory);
  await ensureBrokerActor(broker.baseUrl, broker.snapshot, input.senderId);
  if (
    selectors.length === 1
    && mentionResolution.resolved.length + mentionResolution.unresolved.length + mentionResolution.ambiguous.length === 1
  ) {
    const targetLabel = selectors[0]!.label;
    const delivery = await brokerPostDeliver(broker.baseUrl, prepareScoutDelivery({
      clientMessageId: input.clientMessageId, createdAtMs: input.createdAtMs, now: createdAtMs,
      command: {
        requesterId: input.senderId,
        requesterNodeId: broker.node.id,
        targetLabel,
        body: input.body,
        intent: "tell",
        channel: input.channel,
        speechText: input.shouldSpeak ? stripScoutAgentSelectorLabels(input.body) : undefined,
        messageMetadata: {
          source: "scout-cli",
          ...(input.clientMessageId?.trim() ? { clientMessageId: input.clientMessageId.trim() } : {}),
        },
      },
    }));
    if (delivery.kind !== "delivery") {
      return {
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [targetLabel],
        targetDiagnostic: scoutTargetDiagnosticFromDeliveryFailure(delivery),
      };
    }
    return {
      usedBroker: true,
      conversationId: delivery.conversation.id,
      messageId: delivery.message.id,
      flight: delivery.flight,
      invokedTargets: delivery.targetAgentId ? [delivery.targetAgentId] : [],
      unresolvedTargets: [],
      routeKind: delivery.routeKind,
    };
  }

  const availableTargets = (
    await Promise.all(
      mentionResolution.resolved.map(async (target) => (
        await ensureTargetRelayAgentRegistered(
          broker.baseUrl,
          broker.snapshot,
          broker.node.id,
          target.agentId,
          currentDirectory,
        )
          ? target
          : null
      )),
    )
  ).filter((target): target is ScoutMentionTarget => Boolean(target));
  const validTargets = unique(
    availableTargets
      .map((target) => target.agentId)
      .filter((target) => target !== input.senderId && Boolean(broker.snapshot.agents[target])),
  ).sort();
  const unresolvedTargets = mentionResolution.resolved
    .filter((target) => !validTargets.includes(target.agentId))
    .map((target) => target.label)
    .concat(mentionResolution.unresolved)
    .concat(mentionResolution.ambiguous.map((entry) => entry.label));
  if (unresolvedTargets.length > 0) {
    return {
      usedBroker: true,
      invokedTargets: [],
      unresolvedTargets,
    };
  }

  if (validTargets.length === 0 && !input.channel) {
    return {
      usedBroker: true,
      invokedTargets: [],
      unresolvedTargets: [],
      routingError: "missing_destination",
    };
  }
  if (validTargets.length > 1 && !input.channel) {
    return {
      usedBroker: true,
      invokedTargets: [],
      unresolvedTargets: [],
      routingError: "multi_target_requires_explicit_channel",
    };
  }

  const conversation = validTargets.length === 1 && !input.channel
    ? (await ensureBrokerDirectConversationBetween(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      input.senderId,
      validTargets[0]!,
    )).conversation
    : await ensureBrokerConversation(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      input.channel,
      input.senderId,
      validTargets,
    );
  const messageId = generateMessageId();
  const speechText = input.shouldSpeak
    ? stripScoutAgentSelectorLabels(input.body)
    : "";

  await brokerPostJson(broker.baseUrl, "/v1/messages", {
    id: messageId,
    conversationId: conversation.id,
    actorId: input.senderId,
    originNodeId: broker.node.id,
    class: conversation.kind === "system" ? "system" : "agent",
    body: input.body,
    mentions: mentionResolution.resolved
      .filter((target) => validTargets.includes(target.agentId))
      .map((target) => ({ actorId: target.agentId, label: target.label })),
    speech: speechText ? { text: speechText } : undefined,
    audience: validTargets.length > 0
      ? {
          notify: validTargets,
          reason: "mention",
        }
      : undefined,
    visibility: conversation.visibility,
    policy: "durable",
    createdAt: createdAtMs,
    metadata: {
      source: "scout-cli",
      relayChannel: input.channel ?? "shared",
      relayMessageId: messageId,
    },
  });

  return {
    usedBroker: true,
    invokedTargets: validTargets,
    unresolvedTargets,
    routeKind: relayRouteKind(conversation),
  };
}

export async function askScoutQuestion(input: {
  senderId: string;
  clientMessageId?: string | null;
  targetLabel: string;
  body: string;
  channel?: string;
  shouldSpeak?: boolean;
  createdAtMs?: number;
  executionHarness?: AgentHarness;
  currentDirectory?: string;
}): Promise<ScoutAskResult> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return {
      usedBroker: false,
      unresolvedTarget: input.targetLabel,
    };
  }

  const currentDirectory = input.currentDirectory ?? process.cwd();
  await ensureBrokerActor(broker.baseUrl, broker.snapshot, input.senderId);
  if (input.senderId !== OPERATOR_ID) {
    await ensureSenderRelayAgent(broker.baseUrl, broker.snapshot, broker.node.id, input.senderId, currentDirectory);
  }
  const createdAt = input.createdAtMs ?? Date.now();
  const normalizedTargetLabel = renderScoutTargetLabel(input.targetLabel);
  const explicitTarget = broker.snapshot.agents[input.targetLabel.trim()];
  const explicitTargetAgentId = explicitTarget && !isInactiveBrokerAgent(broker.snapshot, explicitTarget.id)
    ? explicitTarget.id
    : undefined;
  if (explicitTargetAgentId) {
    await ensureTargetRelayAgentRegistered(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      explicitTargetAgentId,
      currentDirectory,
    );
  }
  const messageBody = input.body.trim().startsWith(normalizedTargetLabel)
    ? input.body.trim()
    : `${normalizedTargetLabel} ${input.body.trim()}`;
  const delivery = await brokerPostDeliver(broker.baseUrl, prepareScoutDelivery({
    clientMessageId: input.clientMessageId, createdAtMs: input.createdAtMs, now: createdAt,
    command: {
      requesterId: input.senderId,
      requesterNodeId: broker.node.id,
      targetLabel: input.targetLabel,
      targetAgentId: explicitTargetAgentId,
      body: messageBody,
      intent: "consult",
      channel: input.channel,
      speechText: input.shouldSpeak ? stripScoutAgentSelectorLabels(messageBody) : undefined,
      execution: input.executionHarness
        ? {
            harness: input.executionHarness,
          }
        : undefined,
      ensureAwake: true,
      messageMetadata: {
        source: "scout-cli",
          ...(input.clientMessageId?.trim() ? { clientMessageId: input.clientMessageId.trim() } : {}),
      },
      invocationMetadata: {
        source: "scout-cli",
      },
    },
  }));

  if (delivery.kind !== "delivery") {
    return {
      usedBroker: true,
      unresolvedTarget: input.targetLabel,
      targetDiagnostic: scoutTargetDiagnosticFromDeliveryFailure(delivery),
    };
  }

  return {
    usedBroker: true,
    flight: delivery.flight,
    conversationId: delivery.conversation.id,
    messageId: delivery.message.id,
  };
}

async function loadBrokerFlight(baseUrl: string, flightId: string): Promise<ScoutFlightRecord | null> {
  const snapshot = await brokerReadJson<{
    flights?: Record<string, ScoutFlightRecord>;
  }>(baseUrl, "/v1/snapshot");
  const hot = snapshot.flights?.[flightId];
  if (hot) return hot;
  // History rotation evicts terminal flights from the snapshot hot set, often
  // within the hour. The exact flight read is served from durable storage, so
  // a finished flight is still found instead of "no longer available".
  try {
    const stored = await brokerReadJson<{ flight?: ScoutFlightRecord }>(
      baseUrl,
      `/v1/flights/${encodeURIComponent(flightId)}`,
    );
    return stored.flight?.id === flightId ? stored.flight : null;
  } catch (error) {
    if (error instanceof ScoutBrokerHttpError && error.status === 404) return null;
    throw error;
  }
}

export async function waitForScoutFlight(
  baseUrl: string,
  flightId: string,
  options: {
    timeoutSeconds?: number;
    waitUntil?: "acknowledged" | "completed";
    onUpdate?: (flight: ScoutFlightRecord, detail: string) => void;
  } = {},
): Promise<ScoutFlightRecord> {
  const deadline = typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
    ? Date.now() + options.timeoutSeconds * 1000
    : null;
  let lastState = "";
  let lastSummary = "";

  while (true) {
    const flight = await loadBrokerFlight(baseUrl, flightId);
    if (!flight) {
      throw new Error(`Flight ${flightId} is no longer available.`);
    }

    if (flight.state !== lastState || (flight.summary ?? "") !== lastSummary) {
      const detail = [flight.state, flight.summary].filter(Boolean).join(" - ");
      if (detail) {
        options.onUpdate?.(flight, detail);
      }
      lastState = flight.state;
      lastSummary = flight.summary ?? "";
    }

    if (
      options.waitUntil === "acknowledged"
      && ["running", "waiting", "completed"].includes(flight.state)
    ) {
      return flight;
    }

    if (flight.state === "completed") {
      return flight;
    }

    if (flight.state === "failed" || flight.state === "cancelled") {
      throw new Error(flight.error || flight.summary || `Flight ${flight.id} failed.`);
    }

    if (deadline !== null && Date.now() > deadline) {
      throw new Error(`Timed out waiting for flight ${flight.id}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function loadScoutMessages(options: {
  channel?: string;
  since?: number;
  limit?: number;
  baseUrl?: string;
} = {}): Promise<ScoutBrokerMessageRecord[]> {
  const baseUrl = options.baseUrl ?? resolveScoutBrokerUrl();
  const context = await loadScoutBrokerContext(baseUrl);
  const search = new URLSearchParams();
  const conversationId = context
    ? resolveConversationIdForChannel(context.snapshot, options.channel)
    : null;
  if (!conversationId) {
    return [];
  }
  if (conversationId) {
    search.set("conversationId", conversationId);
  }
  if (typeof options.since === "number" && Number.isFinite(options.since) && options.since > 0) {
    search.set("since", String(options.since));
  }
  if (typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0) {
    search.set("limit", String(options.limit));
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return brokerReadJson<ScoutBrokerMessageRecord[]>(baseUrl, `/v1/messages${suffix}`);
}

export async function watchScoutMessages(options: ScoutWatchOptions): Promise<void> {
  const broker = await requireScoutBrokerContext();
  const conversationId = resolveConversationIdForChannel(broker.snapshot, options.channel);
  if (!conversationId) {
    throw new Error(`Channel "${options.channel?.trim() || "shared"}" does not have a chat yet.`);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", abort, { once: true });
    }
  }

  try {
    const response = await fetch(new URL("/v1/events/stream", broker.baseUrl), {
      headers: {
        accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`/v1/events/stream returned ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleBlock = (block: string) => {
      const trimmed = block.trim();
      if (!trimmed) {
        return;
      }

      let eventName = "";
      const dataLines: string[] = [];
      for (const line of trimmed.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }

      if (eventName !== "message.posted" || dataLines.length === 0) {
        return;
      }

      let event: ControlEvent;
      try {
        event = JSON.parse(dataLines.join("\n")) as ControlEvent;
      } catch {
        return;
      }

      const message = (event as Extract<ControlEvent, { kind: "message.posted" }>).payload?.message as ScoutBrokerMessageRecord | undefined;
      if (!message || message.conversationId !== conversationId) {
        return;
      }

      options.onMessage(message);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const next = nextSseBlock(buffer);
        if (!next) {
          break;
        }
        buffer = next.rest;
        handleBlock(next.block);
      }
    }
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    if (!isAbort) {
      throw error;
    }
  } finally {
    if (options.signal) {
      options.signal.removeEventListener("abort", abort);
    }
  }
}

export async function openScoutThreadWatch(
  input: ThreadWatchOpenRequest & { baseUrl?: string },
): Promise<ThreadWatchOpenResponse> {
  const baseUrl = input.baseUrl ?? resolveScoutBrokerUrl();
  return brokerPostJson<ThreadWatchOpenResponse>(baseUrl, "/v1/thread-watches/open", {
    conversationId: input.conversationId,
    watcherNodeId: input.watcherNodeId,
    watcherId: input.watcherId,
    afterSeq: input.afterSeq,
    leaseMs: input.leaseMs,
  });
}

export async function renewScoutThreadWatch(
  input: { baseUrl?: string; watchId: string; leaseMs?: number },
): Promise<ThreadWatchRenewResponse> {
  const baseUrl = input.baseUrl ?? resolveScoutBrokerUrl();
  return brokerPostJson<ThreadWatchRenewResponse>(baseUrl, "/v1/thread-watches/renew", {
    watchId: input.watchId,
    leaseMs: input.leaseMs,
  });
}

export async function closeScoutThreadWatch(
  input: { baseUrl?: string; watchId: string; reason?: string },
): Promise<void> {
  const baseUrl = input.baseUrl ?? resolveScoutBrokerUrl();
  await brokerPostJson<{ ok: boolean }>(baseUrl, "/v1/thread-watches/close", {
    watchId: input.watchId,
    reason: input.reason,
  });
}

export async function replayScoutThreadEvents(input: {
  baseUrl?: string;
  conversationId: string;
  afterSeq?: number;
  limit?: number;
}): Promise<ThreadEventEnvelope[]> {
  const baseUrl = input.baseUrl ?? resolveScoutBrokerUrl();
  const search = new URLSearchParams();
  if (typeof input.afterSeq === "number" && Number.isFinite(input.afterSeq) && input.afterSeq > 0) {
    search.set("afterSeq", String(input.afterSeq));
  }
  if (typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0) {
    search.set("limit", String(input.limit));
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return brokerReadJson<ThreadEventEnvelope[]>(
    baseUrl,
    `/v1/conversations/${encodeURIComponent(input.conversationId)}/thread-events${suffix}`,
  );
}

export async function loadScoutThreadSnapshot(input: {
  baseUrl?: string;
  conversationId: string;
}): Promise<ThreadSnapshot> {
  const baseUrl = input.baseUrl ?? resolveScoutBrokerUrl();
  return brokerReadJson<ThreadSnapshot>(
    baseUrl,
    `/v1/conversations/${encodeURIComponent(input.conversationId)}/thread-snapshot`,
  );
}

export async function watchScoutThread(options: ScoutThreadWatchOptions): Promise<void> {
  const baseUrl = options.baseUrl ?? resolveScoutBrokerUrl();
  const watch = await openScoutThreadWatch({
    baseUrl,
    conversationId: options.conversationId,
    watcherNodeId: options.watcherNodeId,
    watcherId: options.watcherId,
    afterSeq: options.afterSeq,
    leaseMs: options.leaseMs,
  });

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", abort, { once: true });
    }
  }

  const renewEveryMs = Math.max(5_000, Math.floor((watch.leaseExpiresAt - Date.now()) / 2));
  const renewTimer = setInterval(() => {
    void renewScoutThreadWatch({
      baseUrl,
      watchId: watch.watchId,
      leaseMs: options.leaseMs,
    }).catch(() => {});
  }, renewEveryMs);
  renewTimer.unref?.();

  try {
    const response = await fetch(new URL(`/v1/thread-watches/${encodeURIComponent(watch.watchId)}/stream`, baseUrl), {
      headers: {
        accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`/v1/thread-watches/${watch.watchId}/stream returned ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleBlock = (block: string) => {
      const trimmed = block.trim();
      if (!trimmed) {
        return;
      }

      let eventName = "";
      const dataLines: string[] = [];
      for (const line of trimmed.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }

      if (eventName !== "thread.event" || dataLines.length === 0) {
        return;
      }

      let event: ThreadEventEnvelope;
      try {
        event = JSON.parse(dataLines.join("\n")) as ThreadEventEnvelope;
      } catch {
        return;
      }

      options.onEvent(event);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const next = nextSseBlock(buffer);
        if (!next) {
          break;
        }
        buffer = next.rest;
        handleBlock(next.block);
      }
    }
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    if (!isAbort) {
      throw error;
    }
  } finally {
    clearInterval(renewTimer);
    if (options.signal) {
      options.signal.removeEventListener("abort", abort);
    }
    try {
      await closeScoutThreadWatch({
        baseUrl,
        watchId: watch.watchId,
        reason: controller.signal.aborted ? "aborted" : "stream_closed",
      });
    } catch {
      // Best-effort close.
    }
  }
}

function whoStateRank(state: AgentState | "discovered"): number {
  switch (state) {
    case "active":
      return 5;
    case "waiting":
      return 4;
    case "idle":
      return 2;
    case "offline":
      return 1;
    case "discovered":
    default:
      return 0;
  }
}

function whoEndpointActivity(endpoint: ScoutBrokerEndpointRecord): number | null {
  return maxDefined([
    normalizeUnixTimestamp(endpoint.metadata?.lastCompletedAt),
    normalizeUnixTimestamp(endpoint.metadata?.lastStartedAt),
    normalizeUnixTimestamp(endpoint.metadata?.lastFailedAt),
    normalizeUnixTimestamp(endpoint.metadata?.startedAt),
  ]);
}

function whoEntryState(
  endpoints: ScoutBrokerEndpointRecord[],
  registrationKind: ScoutWhoRegistrationKind,
): AgentState | "discovered" {
  if (endpoints.length === 0) {
    return registrationKind === "discovered" ? "discovered" : "offline";
  }

  return endpoints.reduce<AgentState>((bestState, endpoint) => {
    const nextState = endpoint.state ?? "offline";
    return whoStateRank(nextState) > whoStateRank(bestState) ? nextState : bestState;
  }, "offline");
}

async function loadDiscoveredAgentMap(currentDirectory: string): Promise<Map<string, ResolvedRelayAgentConfig>> {
  try {
    const setup = await loadResolvedRelayAgents({
      currentDirectory,
    });
    return new Map(setup.discoveredAgents.map((agent) => [agent.agentId, agent]));
  } catch {
    return new Map();
  }
}

export async function listScoutAgents(options: { currentDirectory?: string } = {}): Promise<ScoutWhoEntry[]> {
  const broker = await requireScoutBrokerContext();
  const discoveredAgents = await loadDiscoveredAgentMap(options.currentDirectory ?? process.cwd());
  const endpointsByAgent = new Map<string, ScoutBrokerEndpointRecord[]>();
  const messageStats = new Map<string, { messages: number; lastSeen: number | null }>();

  for (const endpoint of Object.values(broker.snapshot.endpoints ?? {})) {
    if (!endpoint.agentId || endpoint.agentId === OPERATOR_ID) {
      continue;
    }
    if (isBuiltInBrokerAgent(broker.snapshot, endpoint.agentId)) {
      continue;
    }
    if (isInactiveBrokerAgent(broker.snapshot, endpoint.agentId)) {
      continue;
    }
    const existing = endpointsByAgent.get(endpoint.agentId) ?? [];
    existing.push(endpoint);
    endpointsByAgent.set(endpoint.agentId, existing);
  }

  for (const message of iterateMessageRecords(broker.snapshot.messages ?? {})) {
    if (!message.actorId || message.actorId === OPERATOR_ID) {
      continue;
    }
    if (isBuiltInBrokerAgent(broker.snapshot, message.actorId)) {
      continue;
    }
    if (isInactiveBrokerAgent(broker.snapshot, message.actorId)) {
      continue;
    }
    const current = messageStats.get(message.actorId) ?? { messages: 0, lastSeen: null };
    current.messages += 1;
    current.lastSeen = maxDefined([
      current.lastSeen,
      normalizeUnixTimestamp(message.createdAt),
    ]);
    messageStats.set(message.actorId, current);
  }

  return unique([
    ...Object.keys(broker.snapshot.agents ?? {}),
    ...Array.from(endpointsByAgent.keys()),
    ...Array.from(messageStats.keys()),
    ...Array.from(discoveredAgents.keys()),
  ])
    .filter((agentId) => agentId && agentId !== OPERATOR_ID)
    .filter((agentId) => !isBuiltInBrokerAgent(broker.snapshot, agentId))
    .filter((agentId) => !isInactiveBrokerAgent(broker.snapshot, agentId))
    .map((agentId): ScoutWhoEntry => {
      const endpoints = endpointsByAgent.get(agentId) ?? [];
      const brokerMessages = messageStats.get(agentId);
      const registrationKind = discoveredAgents.get(agentId)?.registrationKind ?? "broker";
      const state = whoEntryState(endpoints, registrationKind);
      const lastSeen = maxDefined([
        brokerMessages?.lastSeen,
        ...endpoints.map((endpoint) => whoEndpointActivity(endpoint)),
      ]);
      const messages = brokerMessages?.messages ?? 0;

      return {
        agentId,
        state,
        messages,
        lastSeen,
        registrationKind,
      };
    })
    .sort((lhs, rhs) => {
      const stateDelta = whoStateRank(rhs.state) - whoStateRank(lhs.state);
      if (stateDelta !== 0) {
        return stateDelta;
      }

      const lastSeenDelta = (rhs.lastSeen ?? -1) - (lhs.lastSeen ?? -1);
      if (lastSeenDelta !== 0) {
        return lastSeenDelta;
      }

      return lhs.agentId.localeCompare(rhs.agentId);
    });
}

export async function loadScoutRelayConfig(): Promise<RelayConfig> {
  const hub = relayHubDirectory();
  try {
    const raw = await readFile(join(hub, "config.json"), "utf8");
    return JSON.parse(raw) as RelayConfig;
  } catch {
    return {};
  }
}

export function getScoutVoiceForChannel(config: RelayConfig, channel?: string): string {
  const entry = channel ? config.channels?.[channel] : undefined;
  return entry?.voice || config.defaultVoice || "nova";
}

function applyPronunciations(text: string, pronunciations?: Record<string, string>): string {
  if (!pronunciations) {
    return text;
  }
  let result = text;
  for (const [word, phonetic] of Object.entries(pronunciations)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, "gi"), phonetic);
  }
  return result;
}

export async function acquireScoutOnAir(agent: string, timeoutMs = 30_000): Promise<void> {
  const hub = relayHubDirectory();
  await mkdir(hub, { recursive: true });
  const lockPath = join(hub, "on-air.lock");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = await readFile(lockPath, "utf8");
      const lock = JSON.parse(raw) as { ts?: number };
      if (Date.now() - Number(lock.ts ?? 0) > 30_000) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } catch {
      break;
    }
  }

  await writeFile(lockPath, JSON.stringify({ agent, ts: Date.now() }) + "\n");
}

export async function releaseScoutOnAir(): Promise<void> {
  try {
    await unlink(join(relayHubDirectory(), "on-air.lock"));
  } catch {
    // Ignore missing locks.
  }
}

export async function speakScoutText(text: string, voice: string): Promise<void> {
  const config = await loadScoutRelayConfig();
  const apiKey = process.env.OPENAI_API_KEY || config.openaiApiKey || null;
  const clean = applyPronunciations(text.trim(), config.pronunciations);
  if (!apiKey || !clean) {
    return;
  }

  const { spawn } = await import("node:child_process");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice,
      input: clean,
      response_format: "pcm",
      speed: 1.1,
    }),
  });
  if (!response.ok || !response.body) {
    return;
  }

  const player = spawn("ffplay", [
    "-nodisp",
    "-autoexit",
    "-loglevel",
    "quiet",
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ch_layout",
    "mono",
    "-",
  ], { stdio: ["pipe", "ignore", "ignore"] });

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    player.stdin.write(value);
  }
  player.stdin.end();
  await new Promise<void>((resolve) => player.on("close", () => resolve()));
}

export function defaultScoutAgentNameForPath(projectPath: string): string {
  return basename(projectPath);
}
