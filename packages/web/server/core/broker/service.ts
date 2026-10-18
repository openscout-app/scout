import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  buildScoutReturnAddress as buildScoutReturnAddressRecord,
  SCOUT_SESSION_INPUT_RECEIPTS_CAPABILITY,
  type ScoutSessionInputReceipt,
  type ScoutDeliverHttpRequest,
  conversationNaturalKey,
  conversationsWithNaturalKey,
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type AgentState,
  type AgentHarness,
  namedChannelNaturalKey,
  preferredConversationWithNaturalKey,
  type ConversationBinding,
  type ConversationDefinition,
  type ConversationProjectionSnapshot,
  type ControlEvent,
  type CollaborationEvent,
  type CollaborationRecord,
  directChannelNaturalKey,
  type ConversationReadCursor,
  diagnoseAgentIdentity,
  extractAgentMentions,
  extractAgentSelectors,
  formatMinimalAgentIdentity,
  mintChannelId,
  stableChannelId,
  systemChannelNaturalKey,
  type FlightRecord,
  type InvocationRequest,
  type NodeDefinition,
  type AgentSelector,
  type AgentSelectorCandidate,
  type MessageAttachment,
  type MessageReactionRecord,
  type MessageRecord,
  type ScoutDeliverRequest,
  type ScoutDeliverResponse,
  type ScoutDispatchRecord,
  type ScoutProjectAgentSpec,
  type ScoutOwnedRuntimeCatalog,
  type RouteAliasBinding,
  type ScoutRouteTarget,
  type WakePolicy,
  type ScoutReturnAddress,
  epochMs,
  normalizeAgentSelectorSegment,
} from "@openscout/protocol";
import {
  ensureRelayAgentConfigured,
  loadResolvedRelayAgents,
  resolveRelayAgentConfig,
  SCOUT_AGENT_ID,
  type ResolvedRelayAgentConfig,
} from "@openscout/runtime/setup";
import {
  requestScoutBrokerJson,
  ScoutBrokerHttpError,
  type ScoutBrokerBuildIdentity,
  type ScoutBrokerChildServiceSnapshots,
  type ScoutBrokerHealthPayload,
  type ScoutBrokerProjectionStatus,
  type ScoutBrokerStartupStatus,
} from "@openscout/runtime/broker-api";
import {
  resolveBrokerServiceConfig,
  resolveBrokerSocketPathForBaseUrl,
  resolveScoutBrokerControlUrl,
} from "@openscout/runtime/broker-process-manager";
import {
  inferLocalAgentBinding,
  SUPPORTED_LOCAL_AGENT_HARNESSES,
  SUPPORTED_SCOUT_HARNESSES,
  type LocalAgentBinding,
} from "@openscout/runtime/local-agents";
import type { RuntimeRegistrySnapshot } from "@openscout/runtime/registry";
import type { DiscoverySnapshot } from "@openscout/runtime/tail";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

import { configuredOperatorActorIds } from "@openscout/runtime/conversations/legacy-ids";
import { resolveOperatorName } from "@openscout/runtime/user-config";

import {
  openAiAudioSpeechUrl,
  scoutBrokerMessagesListPath,
  scoutBrokerPaths,
} from "./paths.ts";
import {
  queryFlightRecordById,
  queryInvocationById,
} from "../../db-queries.ts";
import { queryFlightRecords, queryInvocations } from "../../db/runs.ts";
import { resolveDbPath } from "../../db/internal/db.ts";
import { coalesce } from "../../server-core.ts";

export type ScoutBrokerActorRecord = ActorIdentity;
export type ScoutBrokerAgentRecord = AgentDefinition;
export type ScoutBrokerEndpointRecord = AgentEndpoint;
export type ScoutBrokerConversationRecord = ConversationDefinition;
export type ScoutBrokerReadCursorRecord = ConversationReadCursor;
export type ScoutBrokerMessageRecord = MessageRecord;
export type ScoutBrokerNodeRecord = NodeDefinition;
export type ScoutBrokerFlightRecord = FlightRecord;
export type ScoutBrokerConversationBindingRecord = ConversationBinding;
export type ScoutBrokerCollaborationRecord = CollaborationRecord;
export type ScoutBrokerSnapshot = RuntimeRegistrySnapshot;

const DEFAULT_SCOUT_BROKER_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SCOUT_BROKER_SNAPSHOT_BUCKET_MS = 60 * 1_000;
const SCOUT_BROKER_CONTEXT_CACHE_TTL_MS = 30_000;
const SCOUT_BROKER_CONTEXT_STALE_RETENTION_MS = 60_000;

type ScoutBrokerContextCacheEntry = {
  expiresAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  value: ScoutBrokerContext | null;
  hasValue: boolean;
  inFlight: Promise<ScoutBrokerContext | null> | null;
};

const scoutBrokerContextCache = new Map<string, ScoutBrokerContextCacheEntry>();

export function invalidateScoutBrokerContextCache(baseUrl: string): void {
  const prefix = [baseUrl, resolveBrokerSocketPathForBaseUrl(baseUrl) ?? "http"].join("\u0000") + "\u0000";
  for (const key of scoutBrokerContextCache.keys()) {
    if (key.startsWith(prefix)) scoutBrokerContextCache.delete(key);
  }
}

export type ScoutBrokerContext = {
  baseUrl: string;
  node: ScoutBrokerNodeRecord;
  snapshot: ScoutBrokerSnapshot;
  freshness?: {
    lastSuccessAt: number;
    ageMs: number;
    stale: boolean;
    refreshing: boolean;
    lastFailureAt: number | null;
  };
};

export type ScoutBrokerHealthState = {
  baseUrl: string;
  reachable: boolean;
  ok: boolean;
  nodeId: string | null;
  meshId: string | null;
  build: ScoutBrokerBuildIdentity | null;
  services: ScoutBrokerChildServiceSnapshots | null;
  projection: ScoutBrokerProjectionStatus | null;
  startup: ScoutBrokerStartupStatus | null;
  counts: {
    nodes: number;
    actors: number;
    agents: number;
    agentRecords?: number;
    rawAgentRecords?: number;
    configuredAgents?: number;
    scoutManagedAgents?: number;
    currentAgentRegistrations?: number;
    localAgentRegistrations?: number;
    remoteAgentRegistrations?: number;
    staleAgentRegistrations?: number;
    retiredAgentRegistrations?: number;
    oneTimeAgentCards?: number;
    persistentAgentCards?: number;
    conversations: number;
    messages: number;
    flights: number;
    collaborationRecords: number;
  } | null;
  error: string | null;
  observation?: {
    state: "healthy" | "slow" | "degraded" | "timed_out" | "unreachable" | "cancelled";
    checkedAt: number;
    durationMs: number;
    lastSuccessAt: number | null;
    statusCode: number | null;
  };
};

// This is provenance only, never a cached assertion that the broker is healthy.
// Bound the map because explicit remote URLs are accepted by these helpers.
const brokerHealthLastSuccess = new Map<string, number>();
const BROKER_HEALTH_TIMEOUT_MS = 2_000;
const BROKER_CONTEXT_TIMEOUT_MS = 5_000;

function boundedBrokerSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export type ScoutBrokerHomeAgentRecord = {
  id: string;
  title: string;
  role: string | null;
  summary: string | null;
  projectRoot: string | null;
  /** Node identity, carried by the broker so bounded rosters stay placeable. */
  homeNodeId?: string | null;
  authorityNodeId?: string | null;
  state: "offline" | "available" | "working";
  reachable: boolean;
  statusLabel: string;
  statusDetail: string | null;
  activeTask: string | null;
  lastSeenAt: number | null;
};

export type ScoutBrokerHomeActivityRecord = {
  id: string;
  kind: "message" | "system";
  actorId: string;
  actorName: string;
  title: string;
  detail: string | null;
  conversationId: string | null;
  channel: string | null;
  timestamp: number;
  /** The runtime the actor runs on ("claude", "codex", "kimi", …), resolved
   *  from the actor's registered endpoint. null when the actor has no endpoint
   *  (the operator, broker notices) — consumers must render nothing rather than
   *  guess a runtime. */
  harness: string | null;
};

export type ScoutBrokerHomePayload = {
  updatedAt: number;
  agents: ScoutBrokerHomeAgentRecord[];
  activity: ScoutBrokerHomeActivityRecord[];
  activitySource: "sqlite_projection" | "runtime_snapshot";
  activityState: "ready" | "warming" | "degraded" | "disabled";
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
      /** Broker detail, set alongside sessionWakeReason (why an exact session could not wake). */
      detail?: string;
      /** Exact-session wake refusal code, when the broker reported one. */
      sessionWakeReason?: string;
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
  flights?: ScoutFlightRecord[];
  invokedTargets: string[];
  notifiedTargets?: string[];
  unresolvedTargets: string[];
  targetDiagnostic?: ScoutTargetDiagnostic;
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
  inputSubmitted?: ScoutSessionInputReceipt;
  flight?: ScoutFlightRecord;
  conversationId?: string;
  messageId?: string;
  targetAgentId?: string;
  targetSessionId?: string;
  targetLabel?: string;
  unresolvedTarget?: string;
  targetDiagnostic?: ScoutAskTargetDiagnostic;
};

export type ScoutAskTargetDiagnostic = ScoutTargetDiagnostic;

export type ScoutAskAmbiguousCandidate = {
  agentId: string;
  label: string;
};

export type ScoutDirectSessionResult = {
  agent: ScoutBrokerAgentRecord;
  conversation: ScoutBrokerConversationRecord;
  existed: boolean;
};

export type ScoutPeerSessionResult = ScoutDirectSessionResult & {
  sourceId: string;
  targetId: string;
};

export type ScoutLocalAgentBindingSyncResult = {
  binding: LocalAgentBinding;
  brokerRegistered: boolean;
};

export type ScoutDirectMessageResult = {
  conversationId: string;
  messageId: string;
  flight?: ScoutFlightRecord;
};

export class ScoutDirectDeliveryUnavailableError extends Error {
  readonly delivery: Exclude<ScoutDeliverResponse, { kind: "delivery" }>;

  constructor(delivery: Exclude<ScoutDeliverResponse, { kind: "delivery" }>) {
    const detail = delivery.kind === "question"
      ? delivery.question.detail
      : delivery.rejection.detail;
    super(detail);
    this.name = "ScoutDirectDeliveryUnavailableError";
    this.delivery = delivery;
  }
}

export type ScoutWatchOptions = {
  agentId?: string;
  channel?: string;
  conversationId?: string;
  allConversations?: boolean;
  signal?: AbortSignal;
  onMessage: (message: ScoutBrokerMessageRecord) => void;
  onLifecycle?: (lifecycle: ScoutBrokerConversationLifecycleRecord) => void;
};

export type ScoutBrokerConversationLifecycleState =
  | "queued"
  | "dispatching"
  | "acknowledged"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ScoutBrokerConversationLifecycleRecord = {
  conversationId: string;
  messageId?: string | null;
  clientMessageId?: string | null;
  invocationId?: string | null;
  flightId?: string | null;
  targetAgentId?: string | null;
  state: ScoutBrokerConversationLifecycleState;
  summary?: string | null;
  error?: string | null;
};

export type ScoutWhoRegistrationKind = "broker" | "configured" | "discovered";

export type ScoutWhoEntry = {
  agentId: string;
  state: AgentState | "discovered";
  messages: number;
  lastSeen: number | null;
  registrationKind: ScoutWhoRegistrationKind;
  /** Broker-owned route pointers targeting this agent; never roster entries. */
  aliases?: Array<Pick<RouteAliasBinding, "id" | "alias" | "revision" | "state" | "scopeProjectKey" | "scopeProjectRoot" | "scopeNodeId" | "target">>;
};

type RelayConfig = {
  channels?: Record<string, { audio: boolean; voice?: string }>;
  defaultVoice?: string;
  pronunciations?: Record<string, string>;
  openaiApiKey?: string;
};

const OPERATOR_ID = "operator";

const SCOPED_ALIAS_POOL = [
  "Curie",
  "Dewey",
  "Turing",
  "Noether",
  "Lovelace",
  "Hopper",
  "Franklin",
  "Faraday",
  "Tesla",
  "Newton",
  "Darwin",
  "Ada",
  "Sagan",
  "Feynman",
  "Bohr",
  "Kepler",
];

function relayHubDirectory(): string {
  return resolveOpenScoutSupportPaths().relayHubDirectory;
}

/** Same-machine broker API base URL (runtime config + unix socket). */
export function resolveScoutBrokerUrl(): string {
  return resolveScoutBrokerControlUrl();
}

/** Mesh-advertised broker URL for peer discovery display. */
export function resolveScoutBrokerAdvertiseUrl(): string {
  return resolveBrokerServiceConfig().brokerUrl;
}

export function resolveScoutAgentName(agentName?: string | null): string {
  const trimmed = agentName?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (process.env.OPENSCOUT_AGENT?.trim()) {
    return process.env.OPENSCOUT_AGENT.trim();
  }
  return resolveOperatorName();
}

export async function resolveScoutSenderId(agentName: string | null | undefined, currentDirectory: string): Promise<string> {
  if (agentName?.trim()) {
    return agentName.trim();
  }
  if (process.env.OPENSCOUT_AGENT?.trim()) {
    return process.env.OPENSCOUT_AGENT.trim();
  }
  const { findNearestProjectRoot } = await import("@openscout/runtime/setup");
  const { resolveLocalAgentByName } = await import("@openscout/runtime/local-agents");
  const projectRoot = await findNearestProjectRoot(currentDirectory) ?? currentDirectory;
  const projectName = basename(projectRoot);
  const agent = await resolveLocalAgentByName(projectName, { matchProjectName: true });
  return agent?.agentId ?? projectName;
}

export async function appendScoutCollaborationEvent(
  event: CollaborationEvent,
  baseUrl = resolveScoutBrokerUrl(),
): Promise<unknown> {
  return brokerPostJson(
    baseUrl,
    scoutBrokerPaths.v1.collaborationEvents,
    event,
  );
}

export async function upsertScoutCollaborationRecord(
  record: CollaborationRecord,
  baseUrl = resolveScoutBrokerUrl(),
): Promise<unknown> {
  return brokerPostJson(
    baseUrl,
    scoutBrokerPaths.v1.collaborationRecords,
    record,
  );
}

/** Use the broker's lifecycle guard; changing a flight row does not stop execution. */
export async function cancelScoutChatFlight(flightId: string, baseUrl = resolveScoutBrokerUrl()): Promise<
  { ok: true; state: "cancelled" | "completed" | "failed" } | { ok: false; status: 409 | 502; error: string }
> {
  const response = await brokerPostJson<{ result?: { status?: { state?: string } }; error?: { code?: number } }>(baseUrl, "/a2a", {
    jsonrpc: "2.0", id: `chat-cancel:${flightId}`, method: "CancelTask", params: { id: flightId },
  });
  if (response.error?.code === -32004) {
    return { ok: false, status: 409, error: "This request has already started. Chat cannot stop its active session yet. Its status has not been changed." };
  }
  const state = response.result?.status?.state;
  if (state === "TASK_STATE_CANCELED") return { ok: true, state: "cancelled" };
  if (state === "TASK_STATE_COMPLETED") return { ok: true, state: "completed" };
  if (state === "TASK_STATE_FAILED") return { ok: true, state: "failed" };
  return { ok: false, status: 502, error: "Could not confirm cancellation. Refresh the request and try again." };
}

export async function upsertScoutFlight(
  flight: FlightRecord,
  baseUrl = resolveScoutBrokerUrl(),
): Promise<unknown> {
  return brokerPostJson(
    baseUrl,
    scoutBrokerPaths.v1.flights,
    flight,
  );
}

export async function upsertScoutConversation(
  conversation: ConversationDefinition,
  baseUrl = resolveScoutBrokerUrl(),
): Promise<unknown> {
  return brokerPostJson(
    baseUrl,
    scoutBrokerPaths.v1.conversations,
    conversation,
  );
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

function titleCaseName(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function displayNameForBrokerActor(snapshot: ScoutBrokerSnapshot, actorId: string): string {
  return snapshot.agents[actorId]?.displayName
    ?? snapshot.actors[actorId]?.displayName
    ?? titleCaseName(metadataString(snapshot.agents[actorId]?.metadata, "definitionId") || actorId);
}

function stableAliasSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function scopedAliasForParticipant(
  scopeId: string,
  participantId: string,
  usedAliases: Set<string>,
): string {
  const seed = stableAliasSeed(`${scopeId}:${participantId}`);
  for (let offset = 0; offset < SCOPED_ALIAS_POOL.length; offset += 1) {
    const alias = SCOPED_ALIAS_POOL[(seed + offset) % SCOPED_ALIAS_POOL.length]!;
    if (!usedAliases.has(alias)) {
      usedAliases.add(alias);
      return alias;
    }
  }
  const fallback = `Agent ${usedAliases.size + 1}`;
  usedAliases.add(fallback);
  return fallback;
}

function scopedAliasTargetsForConversation(
  snapshot: ScoutBrokerSnapshot,
  conversation: ScoutBrokerConversationRecord,
  senderId: string,
): Map<string, { actorId: string; label: string }> {
  const usedAliases = new Set<string>();
  const targets = new Map<string, { actorId: string; label: string }>();
  for (const participantId of conversation.participantIds) {
    if (!isSteerableParticipant(snapshot, participantId, senderId)) {
      continue;
    }
    const alias = scopedAliasForParticipant(conversation.id, participantId, usedAliases);
    const displayName = displayNameForBrokerActor(snapshot, participantId);
    const values = [
      alias,
      `@${alias}`,
      displayName,
      `@${displayName}`,
      `${displayName} ${alias}`,
      `${displayName}-${alias}`,
      `${displayName}.${alias}`,
    ];
    for (const value of values) {
      const key = normalizeAgentSelectorSegment(value);
      if (key && !targets.has(key)) {
        targets.set(key, { actorId: participantId, label: `@${alias}` });
      }
    }
  }
  return targets;
}

function firstEndpointForActor(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
): ScoutBrokerEndpointRecord | undefined {
  return Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === actorId)
    .sort((lhs, rhs) => lhs.id.localeCompare(rhs.id))[0];
}

function endpointRank(endpoint: ScoutBrokerEndpointRecord): number {
  switch (endpoint.state) {
    case "active": return 5;
    case "working": return 5;
    case "waiting": return 4;
    case "idle": return 3;
    case "registered": return 2;
    default: return 0;
  }
}

function endpointTimestamp(endpoint: ScoutBrokerEndpointRecord): number {
  return Math.max(
    epochMs(endpoint.metadata?.lastStartedAt) ?? 0,
    epochMs(endpoint.metadata?.lastCompletedAt) ?? 0,
    epochMs(endpoint.metadata?.lastFailedAt) ?? 0,
    epochMs(endpoint.metadata?.startedAt) ?? 0,
  );
}

function bestEndpointForActor(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
): ScoutBrokerEndpointRecord | undefined {
  return Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === actorId)
    .sort((left, right) =>
      endpointRank(right) - endpointRank(left)
      || endpointTimestamp(right) - endpointTimestamp(left)
      || right.id.localeCompare(left.id)
    )[0];
}

function isSteerAvailableEndpoint(endpoint: ScoutBrokerEndpointRecord | undefined): boolean {
  switch (endpoint?.state) {
    case "active":
    case "working":
    case "waiting":
    case "idle":
      return true;
    default:
      return false;
  }
}

function bestSteerAvailableEndpointForActor(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
): ScoutBrokerEndpointRecord | undefined {
  const endpoint = bestEndpointForActor(snapshot, actorId);
  return isSteerAvailableEndpoint(endpoint) ? endpoint : undefined;
}

function buildScoutReturnAddress(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  options: {
    conversationId?: string;
    replyToMessageId?: string;
  } = {},
): ScoutReturnAddress {
  const agent = snapshot.agents[actorId];
  const actor = snapshot.actors[actorId];
  const endpoint = firstEndpointForActor(snapshot, actorId);
  const selector = agent?.selector?.trim()
    || metadataString(agent?.metadata, "selector")
    || metadataString(actor?.metadata, "selector");
  const defaultSelector = agent?.defaultSelector?.trim()
    || metadataString(agent?.metadata, "defaultSelector")
    || metadataString(actor?.metadata, "defaultSelector");
  const projectRoot = endpoint?.projectRoot
    ?? endpoint?.cwd
    ?? metadataString(agent?.metadata, "projectRoot")
    ?? metadataString(actor?.metadata, "projectRoot");

  return buildScoutReturnAddressRecord({
    actorId,
    handle: agent?.handle?.trim() || actor?.handle?.trim() || actorId,
    displayName: agent?.displayName || actor?.displayName,
    selector,
    defaultSelector,
    conversationId: options.conversationId,
    replyToMessageId: options.replyToMessageId,
    nodeId: endpoint?.nodeId || agent?.authorityNodeId || agent?.homeNodeId,
    projectRoot,
    sessionId: endpoint?.sessionId,
  });
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clientMessageMetadata(clientMessageId: string | null | undefined): Record<string, string> {
  const normalized = typeof clientMessageId === "string" ? clientMessageId.trim() : "";
  return normalized ? { clientMessageId: normalized } : {};
}

function deliveryRequestId(clientMessageId: string | null | undefined, createdAt: number): string {
  const normalized = typeof clientMessageId === "string" ? clientMessageId.trim() : "";
  if (!normalized) {
    return `deliver-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `deliver-client-${digest}`;
}

function deliveryRequestIdentity(
  clientMessageId: string | null | undefined,
  createdAt: number,
  suppliedCreatedAt?: number,
): Pick<ScoutDeliverRequest, "id" | "requestId" | "createdAt"> {
  const id = deliveryRequestId(clientMessageId, createdAt);
  // The receipt fingerprints the entire command. Let the broker assign the
  // acceptance time when the caller did not retain one with its retry key.
  if (clientMessageId?.trim()) {
    return { id, requestId: id, ...(suppliedCreatedAt !== undefined ? { createdAt: suppliedCreatedAt } : {}) };
  }
  // A generated key cannot identify a later retry; do not reserve a receipt.
  return { id, createdAt };
}

function stableBrokerRecordId(
  prefix: "m" | "inv",
  clientMessageId: string | null | undefined,
  createdAt: number,
  discriminator = "",
): string {
  const normalized = typeof clientMessageId === "string" ? clientMessageId.trim() : "";
  if (!normalized) {
    return `${prefix}-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const digest = createHash("sha256")
    .update(`${normalized}\u0000${discriminator}`)
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-client-${digest}`;
}

function endpointSessionId(endpoint: ScoutBrokerEndpointRecord | undefined): string | undefined {
  return endpoint?.sessionId?.trim()
    || metadataString(endpoint?.metadata, "externalSessionId")
    || metadataString(endpoint?.metadata, "threadId")
    || metadataString(endpoint?.metadata, "sessionId");
}

function metadataBoolean(metadata: Record<string, unknown> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function isSupersededBrokerAgent(snapshot: ScoutBrokerSnapshot, agentId: string): boolean {
  const agent = snapshot.agents[agentId];
  if (!agent) {
    return false;
  }
  return metadataBoolean(agent.metadata, "retiredFromFleet")
    || metadataBoolean(agent.metadata, "staleLocalRegistration");
}

function operatorActorIdSet(senderId?: string): Set<string> {
  return new Set(
    [
      "operator",
      senderId?.trim(),
      process.env.OPENSCOUT_OPERATOR_NAME?.trim(),
      ...configuredOperatorActorIds(),
    ].filter((value): value is string => Boolean(value)),
  );
}

function isSteerableParticipant(
  snapshot: ScoutBrokerSnapshot,
  participantId: string,
  senderId: string,
): boolean {
  const actorId = participantId.trim();
  if (!actorId || operatorActorIdSet(senderId).has(actorId)) {
    return false;
  }
  if (snapshot.agents[actorId]) {
    return true;
  }
  if (bestSteerAvailableEndpointForActor(snapshot, actorId)) {
    return true;
  }
  const actorKind = snapshot.actors[actorId]?.kind;
  return actorKind === "agent"
    || actorKind === "helper"
    || actorKind === "bridge";
}

function steerTargetLabel(snapshot: ScoutBrokerSnapshot, actorId: string): string {
  return displayNameForBrokerActor(snapshot, actorId);
}

async function ensureSteerTargetAvailable(
  broker: ScoutBrokerContext,
  targetActorId: string,
  currentDirectory: string,
): Promise<boolean> {
  if (!broker.snapshot.agents[targetActorId]) {
    return Boolean(bestSteerAvailableEndpointForActor(broker.snapshot, targetActorId));
  }
  return await ensureTargetRelayAgentRegistered(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    targetActorId,
    currentDirectory,
  );
}

function invocationTargetRoute(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
): ScoutRouteTarget | undefined {
  if (snapshot.agents[actorId]) {
    return { kind: "agent_id", agentId: actorId };
  }
  if (snapshot.actors[actorId]?.kind === "session" || bestEndpointForActor(snapshot, actorId)) {
    return { kind: "session_id", sessionId: actorId };
  }
  return undefined;
}

async function invocationExecutionForSteer(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  conversationId: string,
): Promise<InvocationRequest["execution"]> {
  // A card can have a waiting launcher plus several isolated workers. Its
  // highest-ranked endpoint is not necessarily the worker in this chat.
  // Preserve the recorded session even if its endpoint disappeared: the
  // broker must decide whether that exact continuation can be resumed.
  const sessionId = await conversationTargetSessionId(baseUrl, snapshot, conversationId, actorId)
    ?? endpointSessionId(bestSteerAvailableEndpointForActor(snapshot, actorId));
  return sessionId
    ? { session: "existing", targetSessionId: sessionId }
    : { session: "reuse" };
}

async function conversationTargetSessionId(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  conversationId: string,
  actorId: string,
): Promise<string | undefined> {
  const evidence: Array<{ sessionId: string; at: number }> = [];
  for (const message of Object.values(snapshot.messages)) {
    if (message.conversationId !== conversationId || message.actorId !== actorId
      || message.metadata?.source !== "broker") continue;
    const sessionId = metadataString(message.metadata, "responderSessionId");
    if (sessionId) evidence.push({ sessionId, at: epochMs(message.createdAt) ?? 0 });
  }

  // Completed flights rotate out of the hot snapshot. Use the same durable
  // conversation records as the reader, overlaying current broker records.
  const invocations = new Map<string, InvocationRequest>();
  const flights = new Map<string, FlightRecord>();
  try {
    for (const invocation of queryInvocations({ conversationId, targetAgentId: actorId })) invocations.set(invocation.id, invocation);
    for (const flight of queryFlightRecords({ conversationId, targetAgentId: actorId })) flights.set(flight.id, flight);
  } catch (error) {
    // A fresh installation may not have a local projection database yet.
    // An unreadable existing database must not silently choose another session.
    if (existsSync(resolveDbPath())) {
      throw new Error("Conversation session storage is unavailable.", { cause: error });
    }
  }
  for (const invocation of Object.values(snapshot.invocations ?? {})) {
    if (invocation.conversationId === conversationId) invocations.set(invocation.id, invocation);
  }
  for (const flight of Object.values(snapshot.flights ?? {})) {
    if (invocations.has(flight.invocationId)) flights.set(flight.id, flight);
  }
  let latest = evidence.sort((left, right) => right.at - left.at)[0];
  const candidates = [...flights.values()].sort((left, right) =>
    (epochMs(invocations.get(right.invocationId)?.createdAt) ?? 0)
    - (epochMs(invocations.get(left.invocationId)?.createdAt) ?? 0));
  for (let flight of candidates) {
    const invocation = invocations.get(flight.invocationId);
    if (!invocation || invocation.targetAgentId !== actorId || flight.targetAgentId !== actorId) continue;
    const at = epochMs(invocation.createdAt) ?? 0;
    if (latest && at <= latest.at) break;
    // Relocation keeps indexed invocation/flight IDs but moves the session
    // receipt out of the working row. Hydrate that exact invocation lazily;
    // normal hot receipts require no additional broker request.
    if (!flight.metadata?.dispatchAck && !snapshot.flights?.[flight.id]) {
      try {
        const historical = await brokerReadJson<{
          invocation: InvocationRequest | null;
          flight: FlightRecord | null;
        }>(baseUrl, `/v1/invocations/${encodeURIComponent(invocation.id)}`);
        if (historical.invocation?.id !== invocation.id
          || historical.invocation.conversationId !== invocation.conversationId
          || historical.invocation.targetAgentId !== actorId
          || historical.flight?.invocationId !== invocation.id
          || historical.flight.targetAgentId !== actorId) {
          throw new Error("The recorded conversation invocation could not be resolved.");
        }
        flight = historical.flight;
      } catch (error) {
        throw new Error("Conversation session storage is unavailable.", { cause: error });
      }
    }
    const ack = flight.metadata?.dispatchAck;
    if (!ack || typeof ack !== "object" || Array.isArray(ack)) continue;
    const sessionId = metadataString(ack as Record<string, unknown>, "sessionId");
    if (sessionId) latest = { sessionId, at };
  }
  return latest?.sessionId;
}

type ScoutInvocationPostResponse = {
  accepted?: true;
  invocationId?: string;
  flightId?: string;
  targetAgentId?: string;
  state?: ScoutFlightRecord["state"];
  flight?: ScoutFlightRecord;
  dispatch?: unknown;
};

async function brokerReadJson<T>(
  baseUrl: string,
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return requestScoutBrokerJson<T>(baseUrl, path, {
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
    signal: options.signal,
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
  const response = await requestScoutBrokerJson<T>(baseUrl, path, {
    method: "POST",
    body,
    acceptErrorJson: options.acceptErrorJson,
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
  });
  // A successful broker mutation makes every bounded snapshot for this broker
  // stale immediately. Leaving the old promise cached after a send caused
  // the destination Chat to remount against a pre-send snapshot: the optimistic
  // message disappeared, then reappeared only after the TTL expired.
  invalidateScoutBrokerContextCache(baseUrl);
  return response;
}

function isScoutDeliverResponse(value: unknown): value is ScoutDeliverResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "delivery" || kind === "question" || kind === "rejected";
}

async function brokerPostDeliver(
  baseUrl: string,
  body: ScoutDeliverRequest,
): Promise<ScoutDeliverResponse> {
  const wireBody: ScoutDeliverHttpRequest = body.sessionDelivery
    ? { ...body, intent: "session_input" }
    : body;
  return brokerPostJson<ScoutDeliverResponse>(
    baseUrl,
    scoutBrokerPaths.v1.deliver,
    wireBody,
    { acceptErrorJson: isScoutDeliverResponse },
  );
}

function renderScoutTargetLabel(targetLabel: string): string {
  const trimmed = targetLabel.trim();
  if (!trimmed) {
    return "";
  }
  if (
    trimmed.startsWith("@")
    || /^(?:ref|session|alias|route-alias|route_alias|target|target-handle|target_handle|channel):/i.test(trimmed)
    || /^broadcast$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return `@${trimmed}`;
}

function renderedScoutAskTarget(target: ScoutRouteTarget): string {
  switch (target.kind) {
    case "agent_id":
      return target.agentId.trim();
    case "agent_label":
      return target.label.trim();
    case "existing_handle":
      return target.value?.trim() || `@${target.handle.trim().replace(/^@+/, "")}`;
    case "runtime_profile":
      return target.value?.trim() || `profile:${target.profile.trim()}`;
    case "route_alias":
      return target.value?.trim() || `alias:${target.alias.trim()}`;
    case "target_handle":
      return target.value?.trim() || `target:${target.handle.trim()}`;
    case "session_id":
      return target.value?.trim() || `session:${target.sessionId.trim()}`;
    case "binding_ref":
      return `ref:${target.ref.trim()}`;
    case "project_path":
      return target.projectPath.trim();
    case "channel":
      return `channel:${target.channel.trim()}`;
    case "broadcast":
      return "broadcast";
  }
}

function renderedScoutAskBodyTargetLabel(
  target: ScoutRouteTarget | undefined,
  renderedTarget: string,
): string {
  if (target?.kind === "project_path" || target?.kind === "runtime_profile") {
    return "";
  }
  if (target?.kind === "target_handle") {
    return renderedTarget.trim();
  }
  return renderScoutTargetLabel(renderedTarget);
}

function defaultScoutAskExecutionSession(
  target: ScoutRouteTarget | undefined,
): "new" | "existing" {
  return target?.kind === "target_handle" ? "existing" : "new";
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
      detail: dispatch.detail,
      candidates: dispatch.candidates.map((candidate) => ({
        agentId: candidate.agentId,
        label: candidate.label,
      })),
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
      ...(dispatch.sessionWakeReason
        ? { sessionWakeReason: dispatch.sessionWakeReason, detail: dispatch.detail }
        : {}),
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

export async function readScoutBrokerHealth(
  baseUrl = resolveScoutBrokerUrl(),
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ScoutBrokerHealthState> {
  const startedAt = Date.now();
  const signal = boundedBrokerSignal(options.signal, options.timeoutMs ?? BROKER_HEALTH_TIMEOUT_MS);
  const key = `${baseUrl}\u0000${resolveBrokerSocketPathForBaseUrl(baseUrl) ?? "http"}`;
  let receivedResponse = false;
  try {
    const health = await brokerReadJson<ScoutBrokerHealthPayload>(baseUrl, scoutBrokerPaths.health, {
      signal,
    });
    receivedResponse = true;
    if (!health || typeof health.ok !== "boolean") throw new Error("Broker health response has no boolean ok field");
    const checkedAt = Date.now();
    if (health.ok) {
      if (!brokerHealthLastSuccess.has(key) && brokerHealthLastSuccess.size >= 32) {
        brokerHealthLastSuccess.delete(brokerHealthLastSuccess.keys().next().value!);
      }
      brokerHealthLastSuccess.set(key, checkedAt);
    }

    return {
      baseUrl,
      reachable: true,
      ok: Boolean(health.ok),
      nodeId: health.nodeId ?? null,
      meshId: health.meshId ?? null,
      build: health.build ?? null,
      services: health.services ?? null,
      projection: health.projection ?? null,
      startup: health.startup ?? null,
      counts: health.counts
        ? {
            nodes: health.counts.nodes ?? 0,
            actors: health.counts.actors ?? 0,
            agents: health.counts.agents ?? 0,
            agentRecords: health.counts.agentRecords,
            rawAgentRecords: health.counts.rawAgentRecords,
            configuredAgents: health.counts.configuredAgents,
            scoutManagedAgents: health.counts.scoutManagedAgents,
            currentAgentRegistrations: health.counts.currentAgentRegistrations,
            localAgentRegistrations: health.counts.localAgentRegistrations,
            remoteAgentRegistrations: health.counts.remoteAgentRegistrations,
            staleAgentRegistrations: health.counts.staleAgentRegistrations,
            retiredAgentRegistrations: health.counts.retiredAgentRegistrations,
            oneTimeAgentCards: health.counts.oneTimeAgentCards,
            persistentAgentCards: health.counts.persistentAgentCards,
            conversations: health.counts.conversations ?? 0,
            messages: health.counts.messages ?? 0,
            flights: health.counts.flights ?? 0,
            collaborationRecords: health.counts.collaborationRecords ?? 0,
          }
        : null,
      error: null,
      observation: {
        state: !health.ok ? "degraded" : checkedAt - startedAt >= 1_000 ? "slow" : "healthy",
        checkedAt,
        durationMs: checkedAt - startedAt,
        lastSuccessAt: brokerHealthLastSuccess.get(key) ?? null,
        statusCode: 200,
      },
    };
  } catch (error) {
    return {
      baseUrl,
      reachable: receivedResponse || error instanceof ScoutBrokerHttpError,
      ok: false,
      nodeId: null,
      meshId: null,
      build: null,
      services: null,
      projection: null,
      startup: null,
      counts: null,
      error: error instanceof Error ? error.message : null,
      observation: {
        state: receivedResponse || error instanceof ScoutBrokerHttpError ? "degraded"
          : signal.aborted ? (signal.reason?.name === "TimeoutError" ? "timed_out" : "cancelled")
          : "unreachable",
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        lastSuccessAt: brokerHealthLastSuccess.get(key) ?? null,
        statusCode: error instanceof ScoutBrokerHttpError ? error.status : receivedResponse ? 200 : null,
      },
    };
  }
}

export async function readScoutBrokerHome(
  baseUrl = resolveScoutBrokerUrl(),
  options: { signal?: AbortSignal } = {},
): Promise<ScoutBrokerHomePayload | null> {
  try {
    return await brokerReadJson<ScoutBrokerHomePayload>(baseUrl, scoutBrokerPaths.v1.home, options);
  } catch {
    return null;
  }
}

export async function readScoutConversationProjection(
  limit = 160,
  baseUrl = resolveScoutBrokerUrl(),
  options: { signal?: AbortSignal } = {},
): Promise<ConversationProjectionSnapshot | null> {
  const query = new URLSearchParams({
    limit: String(Math.min(160, Math.max(1, Math.floor(limit)))),
  });
  try {
    return await brokerReadJson<ConversationProjectionSnapshot>(
      baseUrl,
      `${scoutBrokerPaths.v1.conversationProjection}?${query}`,
      {
        ...options,
        // This endpoint is only a first-paint cache lookup. It must lose quickly
        // to the local compatibility view rather than inherit the generic 30s
        // broker timeout when a daemon is wedged or rebuilding its projection.
        signal: options.signal ?? AbortSignal.timeout(450),
      },
    );
  } catch {
    return null;
  }
}

export async function readScoutBrokerRuntimeCatalog(
  baseUrl = resolveScoutBrokerUrl(),
  force = false,
): Promise<{ catalog: ScoutOwnedRuntimeCatalog; warnings: string[]; source?: string; checkedAt?: number; nextCheckAt?: number } | null> {
  try {
    return await brokerReadJson<{ catalog: ScoutOwnedRuntimeCatalog; warnings: string[]; source?: string; checkedAt?: number; nextCheckAt?: number }>(
      baseUrl,
      `${scoutBrokerPaths.v1.runtimeCatalog}${force ? "?force=true" : ""}`,
      { signal: AbortSignal.timeout(6_000) },
    );
  } catch { return null; }
}

export interface ScoutBrokerTailEvent {
  id: string;
  ts: number;
  source: string;
  sessionId: string;
  pid: number;
  parentPid?: number | null;
  project: string;
  cwd: string;
  harness: string;
  kind: string;
  summary: string;
}

interface ScoutBrokerTailRecentPayload {
  events?: ScoutBrokerTailEvent[];
}

/**
 * Recent tail snapshot for the mobile Tail surface. Queries the broker's
 * `/v1/tail/recent` endpoint fresh on every call (re-resolving the broker URL),
 * so it has no long-lived connection that can go stale across a broker restart —
 * the resilient counterpart to the singleton tail-fanout used for desktop push.
 * `transcripts=1` is essential here: the broker's live buffer can be empty on a
 * cold watcher, while the transcript backfill gives mobile the same initial
 * `tail -n` window users expect before new events begin flowing. Returns the
 * compact events (no `raw`), newest-last as the broker orders them.
 */
export async function readScoutBrokerTailRecent(
  limit = 50,
  baseUrl = resolveScoutBrokerUrl(),
  options: {
    /** Latest assistant reply per session only — what the Agents feed reads. */
    mode?: "assistant-replies";
    /** Look back at most this far; the broker caps it at 24h. */
    windowMs?: number;
  } = {},
): Promise<ScoutBrokerTailEvent[]> {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || 50), 200);
  const params = new URLSearchParams({ limit: String(safeLimit), transcripts: "1" });
  if (options.mode) params.set("mode", options.mode);
  if (options.windowMs && options.windowMs > 0) {
    params.set("windowMs", String(Math.min(Math.trunc(options.windowMs), 24 * 60 * 60 * 1_000)));
  }
  try {
    const payload = await brokerReadJson<ScoutBrokerTailRecentPayload>(
      baseUrl,
      `/v1/tail/recent?${params.toString()}`,
    );
    return (payload.events ?? []).map((event) => ({
      id: event.id,
      ts: event.ts,
      source: event.source,
      sessionId: event.sessionId,
      pid: event.pid,
      parentPid: event.parentPid ?? null,
      project: event.project,
      cwd: event.cwd,
      harness: event.harness,
      kind: event.kind,
      summary: event.summary,
    }));
  } catch {
    return [];
  }
}

/** Read the broker's already-materialized Tail inventory without starting a
 * second process/transcript discovery pass in the web process. */
export async function readScoutBrokerTailDiscovery(
  baseUrl = resolveScoutBrokerUrl(),
): Promise<DiscoverySnapshot | null> {
  try {
    return await brokerReadJson<DiscoverySnapshot>(
      baseUrl,
      scoutBrokerPaths.v1.tailDiscover,
    );
  } catch {
    return null;
  }
}

export async function readScoutBrokerSnapshot(
  baseUrl = resolveScoutBrokerUrl(),
  options: { signal?: AbortSignal; since?: number; scope?: "conversations" | "agents" } = {},
): Promise<ScoutBrokerSnapshot | null> {
  try {
    const query = new URLSearchParams();
    if (options.since !== undefined) query.set("since", String(options.since));
    if (options.scope) query.set("scope", options.scope);
    const path = scoutBrokerPaths.v1.snapshot + (query.size ? `?${query}` : "");
    return await brokerReadJson<ScoutBrokerSnapshot>(baseUrl, path, { signal: options.signal });
  } catch {
    return null;
  }
}

/**
 * This node's broker identity from `/v1/node` alone — a read of a few hundred
 * bytes. Callers that only need to know which node THIS machine is (terminal
 * workspace reconciliation, for one) must not pay for `loadScoutBrokerContext`,
 * whose registry snapshot can run to tens of megabytes on a long-running
 * broker. A success is held for 30s — a broker's node id does not change while
 * it runs — and a failure is never cached, so a broker coming up is seen on
 * the next request while concurrent callers still share one in-flight read.
 */
const readScoutBrokerNodeIdCoalesced = coalesce(async (): Promise<string> => {
  const node = await brokerReadJson<ScoutBrokerNodeRecord>(
    resolveScoutBrokerUrl(),
    scoutBrokerPaths.v1.node,
  );
  if (!node?.id) {
    throw new Error("broker /v1/node returned no node id");
  }
  return node.id;
}, 30_000);

export async function readScoutBrokerNodeId(): Promise<string | null> {
  try {
    return await readScoutBrokerNodeIdCoalesced();
  } catch {
    return null;
  }
}

/**
 * Read the broker's compact, canonical message feed without loading the full
 * registry snapshot. Dispatch only needs recent messages, and the full
 * snapshot can be tens of megabytes on a long-running broker.
 */
export async function readScoutBrokerMessages(options: {
  baseUrl?: string;
  since?: number;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<ScoutBrokerMessageRecord[] | null> {
  const search = new URLSearchParams();
  if (typeof options.since === "number" && Number.isFinite(options.since) && options.since > 0) {
    search.set("since", String(Math.trunc(options.since)));
  }
  if (typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0) {
    search.set("limit", String(Math.trunc(options.limit)));
  }
  try {
    return await brokerReadJson<ScoutBrokerMessageRecord[]>(
      options.baseUrl ?? resolveScoutBrokerUrl(),
      scoutBrokerMessagesListPath(search),
      { signal: options.signal },
    );
  } catch {
    return null;
  }
}

/// Advance an actor's read cursor in a conversation. With no `lastReadMessageId`
/// the broker marks read through the conversation's latest message (and stamps
/// `lastReadAt = now`), which is the "I just opened this thread" case. The broker
/// enforces monotonic progress, so this never rewinds a further-along cursor.
export async function recordScoutBrokerReadCursor(
  input: {
    conversationId: string;
    actorId: string;
    lastReadMessageId?: string | null;
    lastReadAt?: number;
  },
  baseUrl = resolveScoutBrokerUrl(),
): Promise<{ ok: boolean; acknowledgedDeliveries?: number }> {
  const path = `${scoutBrokerPaths.v1.conversations}/${encodeURIComponent(input.conversationId)}/read-cursors`;
  return brokerPostJson<{ ok: boolean; acknowledgedDeliveries?: number }>(baseUrl, path, {
    actorId: input.actorId,
    lastReadMessageId: input.lastReadMessageId ?? undefined,
    lastReadAt: input.lastReadAt,
  });
}

export async function loadScoutBrokerContext(
  baseUrl = resolveScoutBrokerUrl(),
  options: {
    signal?: AbortSignal;
    since?: number | null;
    force?: boolean;
    scope?: "conversations" | "agents";
    /**
     * Cold UI reads can paint from the durable projection while this large
     * snapshot warms. Once a value exists, callers still receive it
     * immediately and stale-while-revalidate continues to apply.
     */
    waitForInitial?: boolean;
    /** Delay a non-blocking cold refresh so the first browser paint wins. */
    initialRefreshDelayMs?: number;
  } = {},
): Promise<ScoutBrokerContext | null> {
  const usesRollingWindow = options.since === undefined;
  const since = usesRollingWindow
    ? Math.floor(
        (Date.now() - DEFAULT_SCOUT_BROKER_SNAPSHOT_WINDOW_MS)
        / DEFAULT_SCOUT_BROKER_SNAPSHOT_BUCKET_MS,
      ) * DEFAULT_SCOUT_BROKER_SNAPSHOT_BUCKET_MS
    : options.since;
  // A forced read follows an out-of-band mutation (mesh scope changes are
  // performed by scoutd rather than brokerPostJson). Evict every bounded
  // snapshot for this broker before repopulating the requested key so the
  // following ordinary poll cannot resurrect pre-mutation state.
  if (options.force) {
    invalidateScoutBrokerContextCache(baseUrl);
  }
  const cacheKey = options.signal
    ? null
    : [
        baseUrl,
        resolveBrokerSocketPathForBaseUrl(baseUrl) ?? "http",
        usesRollingWindow ? "rolling-24h" : since ?? "full",
        options.scope ?? "default",
      ].join("\u0000");
  const now = Date.now();
  for (const [key, entry] of scoutBrokerContextCache) {
    if (
      key !== cacheKey
      && !entry.inFlight
      && (entry.lastSuccessAt ?? entry.expiresAt) + SCOUT_BROKER_CONTEXT_CACHE_TTL_MS + SCOUT_BROKER_CONTEXT_STALE_RETENTION_MS <= now
    ) {
      scoutBrokerContextCache.delete(key);
    }
  }

  const readContext = async (): Promise<ScoutBrokerContext | null> => {
    // One deadline covers health + node + snapshot, including transport fallback.
    const signal = boundedBrokerSignal(options.signal, BROKER_CONTEXT_TIMEOUT_MS);
    const health = await readScoutBrokerHealth(baseUrl, { signal });
    if (!health.reachable || !health.ok) {
      return null;
    }
    const snapshotQuery = new URLSearchParams();
    if (since && since > 0) snapshotQuery.set("since", String(Math.trunc(since)));
    if (options.scope) snapshotQuery.set("scope", options.scope);
    const queryString = snapshotQuery.toString();
    const snapshotPath = queryString
      ? `${scoutBrokerPaths.v1.snapshot}?${queryString}`
      : scoutBrokerPaths.v1.snapshot;
    try {
      const [node, snapshot] = await Promise.all([
        brokerReadJson<ScoutBrokerNodeRecord>(baseUrl, scoutBrokerPaths.v1.node, { signal }),
        brokerReadJson<ScoutBrokerSnapshot>(baseUrl, snapshotPath, { signal }),
      ]);
      if (!node.id || !snapshot) {
        return null;
      }
      return { baseUrl, node, snapshot, freshness: {
        lastSuccessAt: Date.now(), ageMs: 0, stale: false, refreshing: false, lastFailureAt: null,
      } };
    } catch {
      return null;
    }
  };

  if (!cacheKey) {
    return readContext();
  }

  const refresh = (entry: ScoutBrokerContextCacheEntry, delayMs = 0) => {
    if (entry.inFlight) return entry.inFlight;
    if (entry.lastFailureAt !== null && entry.expiresAt > Date.now()) return Promise.resolve(null);
    const attempt = (delayMs > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      : Promise.resolve())
      .then(readContext)
      .then((context) => {
        if (scoutBrokerContextCache.get(cacheKey) !== entry) return context;
        if (context) {
          entry.value = context;
          entry.hasValue = true;
          entry.lastSuccessAt = context.freshness!.lastSuccessAt;
          entry.lastFailureAt = null;
          entry.expiresAt = Date.now() + SCOUT_BROKER_CONTEXT_CACHE_TTL_MS;
        } else {
          // Keep the last good snapshot through a transient broker miss, but
          // bound retry pressure so one outage does not refresh per caller.
          entry.expiresAt = Date.now() + (entry.hasValue ? SCOUT_BROKER_CONTEXT_CACHE_TTL_MS : 2_000);
          entry.lastFailureAt = Date.now();
        }
        return context;
      })
      .finally(() => {
        if (scoutBrokerContextCache.get(cacheKey) === entry) {
          entry.inFlight = null;
        }
      });
    entry.inFlight = attempt;
    return attempt;
  };

  const cached = scoutBrokerContextCache.get(cacheKey);
  if (cached) {
    if (cached.hasValue) {
      if (cached.expiresAt <= now && !cached.inFlight) {
        // Stale-while-revalidate: broker writes explicitly invalidate this
        // snapshot, so a 30-second fallback is enough to catch out-of-band
        // mutations without repeatedly serializing a large idle registry.
        void refresh(cached);
      }
      const ageMs = Math.max(0, now - cached.lastSuccessAt!);
      // Failed retries must not renew the lifetime of last-known-good data.
      if (ageMs > SCOUT_BROKER_CONTEXT_CACHE_TTL_MS + SCOUT_BROKER_CONTEXT_STALE_RETENTION_MS) return null;
      return cached.value ? { ...cached.value, freshness: {
        lastSuccessAt: cached.lastSuccessAt!,
        ageMs,
        stale: ageMs >= SCOUT_BROKER_CONTEXT_CACHE_TTL_MS || cached.lastFailureAt !== null,
        refreshing: cached.inFlight !== null,
        lastFailureAt: cached.lastFailureAt,
      } } : null;
    }
    if (options.waitForInitial === false) {
      void refresh(cached, options.initialRefreshDelayMs);
      return null;
    }
    return refresh(cached);
  }

  const entry: ScoutBrokerContextCacheEntry = {
    expiresAt: now + SCOUT_BROKER_CONTEXT_CACHE_TTL_MS,
    lastSuccessAt: null,
    lastFailureAt: null,
    value: null,
    hasValue: false,
    inFlight: null,
  };
  scoutBrokerContextCache.set(cacheKey, entry);
  if (options.waitForInitial === false) {
    void refresh(entry, options.initialRefreshDelayMs);
    return null;
  }
  return refresh(entry);
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

function buildMentionCandidate(
  snapshot: ScoutBrokerSnapshot,
  agent: AgentDefinition,
): AgentSelectorCandidate {
  const endpoints = Object.values(snapshot.endpoints ?? {}).filter(
    (endpoint) => endpoint.agentId === agent.id,
  );
  const preferred = endpoints.find((endpoint) => endpoint.state === "active")
    ?? endpoints.find((endpoint) => endpoint.state === "idle" || endpoint.state === "waiting")
    ?? endpoints[0];
  const harness = preferred?.harness
    ?? metadataString(agent.metadata, "harness")
    ?? metadataString(agent.metadata, "defaultHarness");
  const profile = metadataString(agent.metadata, "profile");
  return {
    agentId: agent.id,
    definitionId: metadataString(agent.metadata, "definitionId") || agent.id,
    nodeQualifier: metadataString(agent.metadata, "nodeQualifier"),
    workspaceQualifier: metadataString(agent.metadata, "workspaceQualifier"),
    ...(harness ? { harness } : {}),
    ...(profile ? { profile } : {}),
    aliases: [
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
  const candidates = Object.values(snapshot.agents)
    .filter((agent) => !isSupersededBrokerAgent(snapshot, agent.id))
    .map((agent) => buildMentionCandidate(snapshot, agent));
  return formatMinimalAgentIdentity(
    buildMentionCandidate(snapshot, current),
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
  const endpoints = Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === agentId);
  const preferred =
    endpoints.find((endpoint) => endpoint.state === "active")
    ?? endpoints.find(
      (endpoint) => endpoint.state === "idle" || endpoint.state === "waiting",
    )
    ?? endpoints[0];
  return preferred?.projectRoot
    ?? preferred?.cwd
    ?? metadataString(snapshot.agents[agentId]?.metadata, "projectRoot")
    ?? null;
}

function agentPreferredState(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): AgentState | "discovered" {
  const endpoints = Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === agentId);
  const preferred =
    endpoints.find((endpoint) => endpoint.state === "active")
    ?? endpoints.find(
      (endpoint) => endpoint.state === "idle" || endpoint.state === "waiting",
    )
    ?? endpoints[0];
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

  const { findNearestProjectRoot } = await import("@openscout/runtime/setup");
  const currentProjectRoot =
    await findNearestProjectRoot(currentDirectory) ?? currentDirectory;
  const scored = Object.values(snapshot.agents)
    .filter((agent) => agent.id !== OPERATOR_ID)
    .filter((agent) => !isSupersededBrokerAgent(snapshot, agent.id))
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

async function resolveMentionTargets(
  snapshot: ScoutBrokerSnapshot,
  text: string,
  currentDirectory: string,
): Promise<{
  resolved: ScoutMentionTarget[];
  unresolved: string[];
  ambiguous: ScoutMentionAmbiguity[];
}> {
  const mentions = extractAgentMentions(text);
  const selectors = mentions.parsed;
  const resolved = new Map<string, ScoutMentionTarget>();
  const unresolved: string[] = [...mentions.unparsed];
  const ambiguous: ScoutMentionAmbiguity[] = [];
  const candidateMap = new Map<string, AgentSelectorCandidate>();
  const endpointBackedAgentIds = [...new Set(
    Object.values(snapshot.endpoints)
      .map((endpoint) => endpoint.agentId)
      .filter((agentId) => agentId && agentId !== OPERATOR_ID && !isSupersededBrokerAgent(snapshot, agentId)),
  )];

  for (const agent of Object.values(snapshot.agents)) {
    if (isSupersededBrokerAgent(snapshot, agent.id)) {
      continue;
    }
    candidateMap.set(agent.id, buildMentionCandidate(snapshot, agent));
  }

  for (const selector of selectors) {
    if (selector.definitionId === "system") continue;

    const discovered = await resolveRelayAgentConfig(selector, { currentDirectory });
    if (discovered && !candidateMap.has(discovered.agentId)) {
      candidateMap.set(discovered.agentId, {
        agentId: discovered.agentId,
        definitionId: discovered.definitionId,
        nodeQualifier: discovered.instance.nodeQualifier,
        workspaceQualifier: discovered.instance.workspaceQualifier,
        aliases: [discovered.instance.selector, discovered.instance.defaultSelector],
      });
    }

    const candidates = Array.from(candidateMap.values());
    if (selector.definitionId === "all") {
      const targetAgentIds = endpointBackedAgentIds.length > 0 ? endpointBackedAgentIds : candidates.map((candidate) => candidate.agentId);
      for (const agentId of targetAgentIds) {
        resolved.set(agentId, { agentId, label: selector.label, selector });
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

type ScoutMentionAmbiguity = {
  label: string;
  selector: AgentSelector;
  candidates: ScoutAskAmbiguousCandidate[];
};

type ScoutSingleTargetResolution =
  | { kind: "resolved"; target: ScoutMentionTarget }
  | { kind: "ambiguous"; candidates: ScoutAskAmbiguousCandidate[] }
  | { kind: "unresolved" };

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
  if (fallback === "shared") return "shared";
  const hasRemoteParticipant = participantIds.some((participantId) => {
    const participant = snapshot.agents[participantId];
    return Boolean(participant?.authorityNodeId && participant.authorityNodeId !== nodeId);
  });
  return hasRemoteParticipant ? "shared" : fallback;
}

export function stripScoutAgentSelectorLabels(text: string): string {
  return extractAgentSelectors(text).reduce((next, selector) => (
    next.replaceAll(selector.label, "").replace(/\s{2,}/g, " ").trim()
  ), text).trim();
}

async function ensureBrokerActor(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  displayName?: string,
): Promise<void> {
  if (snapshot.actors[actorId] || snapshot.agents[actorId]) {
    return;
  }
  const actor: ScoutBrokerActorRecord = {
    id: actorId,
    kind: actorId === OPERATOR_ID ? "person" : "agent",
    displayName: displayName?.trim() || titleCaseName(actorId),
    handle: actorId,
    labels: ["scout"],
    metadata: { source: "scout-cli" },
  };
  await brokerPostJson(baseUrl, scoutBrokerPaths.v1.actors, actor);
  snapshot.actors[actorId] = actor;
}

async function syncBrokerBinding(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  binding: Awaited<ReturnType<typeof inferLocalAgentBinding>>,
  options: { includeEndpoint?: boolean } = {},
): Promise<void> {
  if (!binding) return;
  await brokerPostJson(baseUrl, scoutBrokerPaths.v1.actors, binding.actor);
  await brokerPostJson(baseUrl, scoutBrokerPaths.v1.agents, binding.agent);
  snapshot.actors[binding.actor.id] = binding.actor;
  snapshot.agents[binding.agent.id] = binding.agent;
  if (options.includeEndpoint ?? true) {
    await brokerPostJson(baseUrl, scoutBrokerPaths.v1.endpoints, binding.endpoint);
    snapshot.endpoints[binding.endpoint.id] = binding.endpoint;
  }
}

function scoutBrokerAgentRegistrationFromConfig(
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
  await brokerPostJson(baseUrl, scoutBrokerPaths.v1.actors, registration.actor);
  await brokerPostJson(baseUrl, scoutBrokerPaths.v1.agents, registration.agent);
  snapshot.actors[registration.actor.id] = registration.actor;
  snapshot.agents[registration.agent.id] = registration.agent;
}

export async function registerScoutLocalAgentBinding(input: {
  agentId: string;
  broker?: ScoutBrokerContext | null;
}): Promise<ScoutLocalAgentBindingSyncResult | null> {
  const broker = input.broker ?? await loadScoutBrokerContext();
  const nodeId = broker?.node.id ?? process.env.OPENSCOUT_NODE_ID ?? "local";
  const binding = await inferLocalAgentBinding(input.agentId, nodeId);
  if (!binding) {
    return null;
  }
  if (broker) {
    await syncBrokerBinding(broker.baseUrl, broker.snapshot, binding);
  }
  return {
    binding,
    brokerRegistered: Boolean(broker),
  };
}

export async function retireScoutLocalAgentBinding(input: {
  agentId: string;
  broker?: ScoutBrokerContext | null;
}): Promise<boolean> {
  const broker = input.broker ?? await loadScoutBrokerContext();
  if (!broker) {
    return false;
  }

  const retiredAt = Date.now();
  let retired = false;
  const agent = broker.snapshot.agents[input.agentId];
  if (agent) {
    const nextAgent: ScoutBrokerAgentRecord = {
      ...agent,
      metadata: {
        ...(agent.metadata ?? {}),
        retiredFromFleet: true,
        retiredAt,
      },
    };
    await brokerPostJson(broker.baseUrl, scoutBrokerPaths.v1.agents, nextAgent);
    broker.snapshot.agents[input.agentId] = nextAgent;
    retired = true;
  }

  for (const endpoint of Object.values(broker.snapshot.endpoints)) {
    if (endpoint.agentId !== input.agentId) {
      continue;
    }
    const nextEndpoint: ScoutBrokerEndpointRecord = {
      ...endpoint,
      state: "offline",
      metadata: {
        ...(endpoint.metadata ?? {}),
        retiredFromFleet: true,
        retiredAt,
        lastError: "local agent card retired",
        lastFailedAt: retiredAt,
      },
    };
    await brokerPostJson(broker.baseUrl, scoutBrokerPaths.v1.endpoints, nextEndpoint);
    broker.snapshot.endpoints[endpoint.id] = nextEndpoint;
    retired = true;
  }

  return retired;
}

async function resolveConversationActorId(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  actorId: string,
  currentDirectory: string,
  displayName?: string,
): Promise<string> {
  const normalized = actorId.trim() || OPERATOR_ID;
  if (snapshot.agents[normalized] || snapshot.actors[normalized]) {
    return normalized;
  }
  if (normalized === OPERATOR_ID) {
    await ensureBrokerActor(baseUrl, snapshot, normalized, displayName);
    return normalized;
  }

  const configured = await ensureRelayAgentConfigured(normalized, {
    currentDirectory,
    ensureCurrentProjectConfig: true,
  });
  if (!configured) {
    await ensureBrokerActor(baseUrl, snapshot, normalized, displayName);
    return normalized;
  }

  const binding = await inferLocalAgentBinding(configured.agentId, nodeId);
  if (binding) {
    await syncBrokerBinding(baseUrl, snapshot, binding);
    return binding.actor.id;
  }

  // Auto-register the agent in the broker even without a running session.
  // This gives Claude Code / Codex / Pi sessions an identity card automatically
  // when they send from a project directory — no explicit setup step needed.
  await syncBrokerAgentRegistration(
    baseUrl, snapshot,
    scoutBrokerAgentRegistrationFromConfig(configured, nodeId),
  );
  return configured.agentId;
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
  if (existingAgent && !metadataBoolean(existingAgent.metadata, "staleLocalRegistration")) {
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

export async function syncScoutBrokerBindings(input: {
  currentDirectory: string;
  operatorId?: string;
  operatorName?: string;
}): Promise<boolean> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return false;
  }

  const operatorId = input.operatorId?.trim() || OPERATOR_ID;
  await ensureBrokerActor(
    broker.baseUrl,
    broker.snapshot,
    operatorId,
    input.operatorName,
  );

  const setup = await loadResolvedRelayAgents({
    currentDirectory: input.currentDirectory,
  });

  for (const agent of setup.discoveredAgents) {
    await ensureTargetRelayAgentRegistered(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      agent.agentId,
      input.currentDirectory,
    );
  }

  return true;
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
  const broadcastParticipants = normalizedChannel === "broadcast" ? [...new Set([OPERATOR_ID, senderId, ...Object.values(snapshot.endpoints)
      .filter((endpoint) => endpoint.state !== "offline" && snapshot.agents[endpoint.agentId])
      .map((endpoint) => endpoint.agentId)])].sort() : [];
  const scopedParticipants = [...new Set([OPERATOR_ID, senderId, ...targetParticipantIds])].sort();

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
      participantIds: [OPERATOR_ID, senderId].sort(),
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
  const nextParticipants = definition.metadata?.channel === "broadcast" ? definition.participantIds : [...new Set([
    ...equivalentConversations.flatMap((conversation) => conversation.participantIds),
    ...definition.participantIds,
  ])].sort();

  if (
    !existing ||
    existing.kind !== definition.kind ||
    existing.visibility !== definition.visibility ||
    existing.shareMode !== definition.shareMode ||
    nextParticipants.join("\u0000") !== existing.participantIds.join("\u0000")
  ) {
    const nextConversation: ScoutBrokerConversationRecord = {
      ...definition,
      participantIds: nextParticipants,
    };
    await brokerPostJson(baseUrl, scoutBrokerPaths.v1.conversations, nextConversation);
    snapshot.conversations[nextConversation.id] = nextConversation;
    return nextConversation;
  }

  return existing;
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
): Promise<ScoutDirectSessionResult> {
  const participantIds = [...new Set([sourceId, targetId])].sort();
  const naturalKey = directChannelNaturalKey(participantIds);
  const existing = findConversationByIdentity(snapshot, naturalKey);
  const conversationId = existing?.id ?? mintChannelId(randomUUID);
  const nextShareMode = resolveConversationShareMode(
    snapshot,
    nodeId,
    participantIds,
    "local",
  );
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

  const nonOperatorParticipants = participantIds.filter((participantId) => participantId !== OPERATOR_ID);
  const conversationTitle = sourceId === OPERATOR_ID || targetId === OPERATOR_ID
    ? displayNameForBrokerActor(snapshot, nonOperatorParticipants[0] ?? targetId)
    : `${displayNameForBrokerActor(snapshot, sourceId)} <> ${displayNameForBrokerActor(snapshot, targetId)}`;

  const definition: ScoutBrokerConversationRecord = {
    id: conversationId,
    kind: "direct",
    title: targetId === SCOUT_AGENT_ID && sourceId === OPERATOR_ID ? "Scout" : conversationTitle,
    visibility: "private",
    shareMode: nextShareMode,
    authorityNodeId: nodeId,
    participantIds,
    metadata: {
      surface: "scout",
      naturalKey,
      ...(targetId === SCOUT_AGENT_ID && sourceId === OPERATOR_ID ? { role: "partner" } : {}),
    },
  };

  await brokerPostJson(baseUrl, scoutBrokerPaths.v1.conversations, definition);
  snapshot.conversations[definition.id] = definition;

  return {
    agent: snapshot.agents[targetId] ?? snapshot.agents[sourceId],
    conversation: definition,
    existed: Boolean(existing),
  };
}

/** Input shape for an attachment supplied by a caller (HTTP / MCP). */
export type OutgoingAttachmentInput = {
  id?: string;
  mediaType: string;
  fileName?: string;
  blobKey?: string;
  url?: string;
};

/**
 * Validate caller-supplied attachments and mint ids where absent. Drops any
 * attachment lacking a media type or a way to fetch it (url/blobKey). Returns
 * undefined when nothing usable remains, to keep the broker payload clean.
 */
export function normalizeOutgoingAttachments(
  attachments: OutgoingAttachmentInput[] | undefined,
  clientMessageId?: string | null,
): MessageAttachment[] | undefined {
  if (!attachments?.length) {
    return undefined;
  }
  const normalized: MessageAttachment[] = [];
  for (const attachment of attachments) {
    const mediaType = attachment?.mediaType?.trim();
    const url = attachment?.url?.trim();
    const blobKey = attachment?.blobKey?.trim();
    if (!mediaType || (!url && !blobKey)) {
      continue;
    }
    const fileName = attachment.fileName?.trim() || undefined;
    const generatedId = clientMessageId?.trim()
      ? `att-client-${createHash("sha256").update(JSON.stringify([
        clientMessageId.trim(), normalized.length, mediaType, fileName, url || undefined, blobKey || undefined,
      ])).digest("hex").slice(0, 32)}`
      : `att-${randomUUID()}`;
    normalized.push({
      id: attachment.id?.trim() || generatedId,
      mediaType,
      fileName,
      url: url || undefined,
      blobKey: blobKey || undefined,
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export async function sendScoutMessage(input: {
  senderId: string;
  body: string;
  channel?: string;
  explicitTargetAgentIds?: string[];
  shouldSpeak?: boolean;
  attachments?: OutgoingAttachmentInput[];
  clientMessageId?: string | null;
  createdAtMs?: number;
  executionHarness?: AgentHarness;
  executionModel?: string;
  executionReasoningEffort?: string;
  currentDirectory?: string;
}): Promise<ScoutMessagePostResult> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { usedBroker: false, invokedTargets: [], unresolvedTargets: [] };
  }

  const currentDirectory = input.currentDirectory ?? process.cwd();
  const createdAtMs = input.createdAtMs ?? Date.now();
  const mentionResolution = await resolveMentionTargets(broker.snapshot, input.body, currentDirectory);
  const selectors = extractAgentSelectors(input.body);
  const senderId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.senderId,
    currentDirectory,
  );
  const explicitTargetCandidates = [...new Set(
    (input.explicitTargetAgentIds ?? [])
      .map((targetId) => targetId.trim())
      .filter((targetId) => targetId.length > 0),
  )];

  if (explicitTargetCandidates.length === 1 && selectors.length === 0) {
    const delivery = await brokerPostDeliver(broker.baseUrl, {
      ...deliveryRequestIdentity(input.clientMessageId, createdAtMs, input.createdAtMs),
      requesterId: senderId,
      requesterNodeId: broker.node.id,
      targetAgentId: explicitTargetCandidates[0],
      body: input.body,
      attachments: normalizeOutgoingAttachments(input.attachments, input.clientMessageId),
      intent: "tell",
      channel: input.channel,
      speechText: input.shouldSpeak ? stripScoutAgentSelectorLabels(input.body) : undefined,
      messageMetadata: {
        source: "scout-cli",
        ...clientMessageMetadata(input.clientMessageId),
      },
    });
    if (delivery.kind !== "delivery") {
      return {
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [explicitTargetCandidates[0]!],
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
    };
  }

  if (
    explicitTargetCandidates.length === 0
    && selectors.length === 1
    && mentionResolution.resolved.length + mentionResolution.unresolved.length + mentionResolution.ambiguous.length === 1
  ) {
    const targetLabel = selectors[0]!.label;
    const delivery = await brokerPostDeliver(broker.baseUrl, {
      ...deliveryRequestIdentity(input.clientMessageId, createdAtMs, input.createdAtMs),
      requesterId: senderId,
      requesterNodeId: broker.node.id,
      targetLabel,
      body: input.body,
      attachments: normalizeOutgoingAttachments(input.attachments, input.clientMessageId),
      intent: "tell",
      channel: input.channel,
      speechText: input.shouldSpeak ? stripScoutAgentSelectorLabels(input.body) : undefined,
      messageMetadata: {
        source: "scout-cli",
        ...clientMessageMetadata(input.clientMessageId),
      },
    });
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

  const explicitTargets = (
    await Promise.all(
      explicitTargetCandidates.map(async (targetId) => (
        await ensureTargetRelayAgentRegistered(
          broker.baseUrl,
          broker.snapshot,
          broker.node.id,
          targetId,
          currentDirectory,
        )
          ? targetId
          : null
      )),
    )
  ).filter((targetId): targetId is string => Boolean(targetId));

  const validTargets = [...new Set(
    availableTargets
      .map((target) => target.agentId)
      .concat(explicitTargets)
      .filter((target) => target !== senderId && Boolean(broker.snapshot.agents[target])),
  )].sort();

  // Route to DM when there's a single mention target, otherwise use the channel
  let conversation: ScoutBrokerConversationRecord;
  if (validTargets.length === 1 && !input.channel) {
    const dm = await ensureBrokerDirectConversationBetween(
      broker.baseUrl, broker.snapshot, broker.node.id,
      senderId, validTargets[0],
    );
    conversation = dm.conversation;
  } else {
    conversation = await ensureBrokerConversation(
      broker.baseUrl, broker.snapshot, broker.node.id,
      input.channel, senderId,
      availableTargets.map((target) => target.agentId),
    );
  }
  const unresolvedTargets = mentionResolution.resolved
    .filter((target) => !validTargets.includes(target.agentId))
    .map((target) => target.label)
    .concat(mentionResolution.unresolved)
    .concat(mentionResolution.ambiguous.map((entry) => entry.label))
    .concat(explicitTargetCandidates.filter((targetId) => !validTargets.includes(targetId)));
  const messageId = stableBrokerRecordId("m", input.clientMessageId, createdAtMs);
  const speechText = input.shouldSpeak ? stripScoutAgentSelectorLabels(input.body) : "";
  const returnAddress = buildScoutReturnAddress(broker.snapshot, senderId, {
    conversationId: conversation.id,
    replyToMessageId: messageId,
  });

  await brokerPostJson(broker.baseUrl, scoutBrokerPaths.v1.messages, {
    id: messageId,
    conversationId: conversation.id,
    actorId: senderId,
    originNodeId: broker.node.id,
    class: conversation.kind === "system" ? "system" : "agent",
    body: input.body,
    mentions: mentionResolution.resolved
      .filter((target) => validTargets.includes(target.agentId))
      .map((target) => ({ actorId: target.agentId, label: target.label })),
    speech: speechText ? { text: speechText } : undefined,
    attachments: normalizeOutgoingAttachments(input.attachments),
    audience: validTargets.length > 0 ? { notify: validTargets, reason: "mention" } : undefined,
    visibility: conversation.visibility,
    policy: "durable",
    createdAt: createdAtMs,
    metadata: {
      source: "scout-cli",
      relayChannel: input.channel ?? "shared",
      relayMessageId: messageId,
      ...clientMessageMetadata(input.clientMessageId),
      returnAddress,
    },
  });

  for (const targetAgentId of validTargets) {
    await brokerPostJson(broker.baseUrl, scoutBrokerPaths.v1.invocations, {
      id: stableBrokerRecordId("inv", input.clientMessageId, createdAtMs, targetAgentId),
      requesterId: senderId,
      requesterNodeId: broker.node.id,
      targetAgentId,
      action: "consult",
      task: input.body,
      conversationId: conversation.id,
      messageId,
      execution: {
        ...(input.executionHarness ? { harness: input.executionHarness } : {}),
        ...(input.executionModel?.trim() ? { model: input.executionModel.trim() } : {}),
        ...(input.executionReasoningEffort?.trim()
          ? { reasoningEffort: input.executionReasoningEffort.trim() }
          : {}),
        session: "new",
      },
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
      metadata: {
        source: "scout-cli",
        relayChannel: input.channel ?? "shared",
        returnAddress,
      },
    });
  }

  return { usedBroker: true, conversationId: conversation.id, messageId, invokedTargets: validTargets, unresolvedTargets };
}

export async function sendScoutConversationMessage(input: {
  conversationId: string;
  senderId: string;
  body: string;
  attachments?: OutgoingAttachmentInput[];
  /** Persisted attention only; never a transport delivery or invocation. */
  attentionMentions?: MessageRecord["mentions"];
  replyToMessageId?: string | null;
  clientMessageId?: string | null;
  createdAtMs?: number;
  currentDirectory?: string;
  source?: string;
  /** A shared Chat post reaches its agent participants without requesting work. */
  notifyParticipantAgents?: boolean;
  /**
   * Whether an `@name` written in the body may route the message.
   *
   * The operator shell types addresses into prose, so this defaults to true and
   * its behaviour is unchanged. A surface whose targets are chosen structurally
   * -- Scout Chat picks an actor id from the roster -- passes `false`, and the
   * body is then payload only: quoting "@kepler said" must not reach Kepler.
   */
  resolveMentionsFromBody?: boolean;
}): Promise<ScoutMessagePostResult> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { usedBroker: false, invokedTargets: [], unresolvedTargets: [] };
  }

  const conversation = broker.snapshot.conversations[input.conversationId];
  if (!conversation) {
    throw new Error(`Conversation ${input.conversationId} is not available in the broker snapshot.`);
  }

  const currentDirectory = input.currentDirectory ?? process.cwd();
  const createdAtMs = input.createdAtMs ?? Date.now();
  const senderId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.senderId,
    currentDirectory,
  );
  const routeBodyMentions = input.attentionMentions === undefined && input.resolveMentionsFromBody !== false;
  const mentionResolution = routeBodyMentions
    ? await resolveMentionTargets(broker.snapshot, input.body, currentDirectory)
    : { resolved: [], unresolved: [], ambiguous: [] };
  const mentionedTargetIds = new Set(mentionResolution.resolved.map((target) => target.agentId));
  const participantTargetIds = input.attentionMentions === undefined && input.notifyParticipantAgents
    && (
      conversation.kind === "channel"
      || conversation.kind === "group_direct"
      || conversation.kind === "thread"
    )
    ? conversation.participantIds.filter((participantId) =>
        isSteerableParticipant(broker.snapshot, participantId, senderId)
      )
    : [];
  const candidateTargetIds = [...new Set([
    ...mentionedTargetIds,
    ...participantTargetIds,
  ])];

  const availableTargets = (
    await Promise.all(
      candidateTargetIds.map(async (agentId) => (
        await ensureTargetRelayAgentRegistered(
          broker.baseUrl,
          broker.snapshot,
          broker.node.id,
          agentId,
          currentDirectory,
        )
          ? agentId
          : null
      )),
    )
  ).filter((agentId): agentId is string => Boolean(agentId));

  const validTargets = [...new Set(
    availableTargets
      .filter((target) => target !== senderId && Boolean(broker.snapshot.agents[target])),
  )].sort();
  const mentionedValidTargets = validTargets.filter((targetId) => mentionedTargetIds.has(targetId));
  const participantValidTargets = validTargets.filter((targetId) => participantTargetIds.includes(targetId));
  const unresolvedTargets = mentionResolution.resolved
    .filter((target) => !validTargets.includes(target.agentId))
    .map((target) => target.label)
    .concat(mentionResolution.unresolved)
    .concat(mentionResolution.ambiguous.map((entry) => entry.label));
  const messageId = stableBrokerRecordId("m", input.clientMessageId, createdAtMs);
  const returnAddress = buildScoutReturnAddress(broker.snapshot, senderId, {
    conversationId: conversation.id,
    replyToMessageId: messageId,
  });

  await brokerPostJson(broker.baseUrl, scoutBrokerPaths.v1.messages, {
    id: messageId,
    conversationId: conversation.id,
    actorId: senderId,
    originNodeId: broker.node.id,
    class: conversation.kind === "system" ? "system" : "agent",
    body: input.body,
    ...(input.replyToMessageId?.trim() ? { replyToMessageId: input.replyToMessageId.trim() } : {}),
    mentions: input.attentionMentions ?? mentionResolution.resolved
      .filter((target) => mentionedValidTargets.includes(target.agentId))
      .map((target) => ({ actorId: target.agentId, label: target.label })),
    attachments: normalizeOutgoingAttachments(input.attachments),
    audience: input.attentionMentions !== undefined ? { delivery: "none" } : participantValidTargets.length > 0
      ? { notify: participantValidTargets, reason: "conversation_visibility" }
      : mentionedValidTargets.length > 0
        ? { notify: mentionedValidTargets, reason: "mention" }
        : undefined,
    visibility: conversation.visibility,
    policy: "durable",
    createdAt: createdAtMs,
    metadata: {
      source: input.source?.trim() || "scout-web",
      destinationKind: "conversation",
      destinationId: conversation.id,
      relayMessageId: messageId,
      ...(participantValidTargets.length
        ? {
            deliveryIntent: "group_message",
            relayTargetIds: participantValidTargets,
          }
        : {}),
      ...clientMessageMetadata(input.clientMessageId),
      returnAddress,
    },
  });

  return {
    usedBroker: true,
    conversationId: conversation.id,
    messageId,
    invokedTargets: mentionedValidTargets,
    ...(participantValidTargets.length ? { notifiedTargets: participantValidTargets } : {}),
    unresolvedTargets,
  };
}

export async function sendScoutMessageReaction(input: {
  channelId: string;
  messageId: string;
  actorId: string;
  emoji: string;
  remove?: boolean;
}): Promise<{ usedBroker: false } | { usedBroker: true; replayed: boolean }> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return { usedBroker: false };
  const result = await brokerPostJson<{ replayed?: boolean }>(
    broker.baseUrl,
    input.remove
      ? scoutBrokerPaths.v1.messageReactionsRemove
      : scoutBrokerPaths.v1.messageReactions,
    {
      channelId: input.channelId,
      messageId: input.messageId,
      actorId: input.actorId,
      emoji: input.emoji,
      createdAt: Date.now(),
    },
  );
  return { usedBroker: true, replayed: result.replayed === true };
}

export async function listScoutMessageReactions(
  channelId: string,
): Promise<MessageReactionRecord[] | null> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return null;
  const path = `${scoutBrokerPaths.v1.messageReactions}?conversationId=${encodeURIComponent(channelId)}`;
  try {
    return await brokerReadJson<MessageReactionRecord[]>(broker.baseUrl, path);
  } catch {
    // Reactions are additive. A restoring broker or a missing route must not
    // take the whole Chat feed down with it.
    return null;
  }
}

export async function sendScoutConversationSteer(input: {
  conversationId: string;
  senderId: string;
  body: string;
  attachments?: OutgoingAttachmentInput[];
  replyToMessageId?: string | null;
  targetParticipantIds?: string[];
  steerContextByTargetAgentId?: Record<string, { runId: string; flightId?: string }>;
  intent?: "invoke" | "steer" | "tell";
  execution?: InvocationRequest["execution"];
  clientMessageId?: string | null;
  createdAtMs?: number;
  currentDirectory?: string;
  source?: string;
  /**
   * Whether an `@name` or selector written in the body may add targets.
   *
   * Defaults to true for the operator shell, where addressing is prose. Scout
   * Chat passes `false`: the caller names exactly one actor id, and a quoted
   * name in the message must never widen that into a second invocation.
   */
  resolveMentionsFromBody?: boolean;
  /** Canonical attention recipients; these never add execution targets. */
  attentionMentions?: MessageRecord["mentions"];
}): Promise<ScoutMessagePostResult> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { usedBroker: false, invokedTargets: [], unresolvedTargets: [] };
  }

  const conversation = broker.snapshot.conversations[input.conversationId];
  if (!conversation) {
    throw new Error(`Conversation ${input.conversationId} is not available in the broker snapshot.`);
  }

  const currentDirectory = input.currentDirectory ?? process.cwd();
  const createdAtMs = input.createdAtMs ?? Date.now();
  const intent = input.intent === "tell"
    ? "tell"
    : input.intent === "invoke"
      ? "invoke"
      : "steer";
  const senderId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.senderId,
    currentDirectory,
  );
  const routeBodyMentions = input.attentionMentions === undefined && input.resolveMentionsFromBody !== false;
  const mentionResolution = routeBodyMentions
    ? await resolveMentionTargets(broker.snapshot, input.body, currentDirectory)
    : { resolved: [], unresolved: [], ambiguous: [] };
  const selectors = routeBodyMentions ? extractAgentSelectors(input.body) : [];
  const scopedAliasTargets = scopedAliasTargetsForConversation(
    broker.snapshot,
    conversation,
    senderId,
  );
  const scopedSelectorTargets = (
    await Promise.all(
      selectors.map(async (selector) => {
        const target = scopedAliasTargets.get(normalizeAgentSelectorSegment(selector.label))
          ?? scopedAliasTargets.get(normalizeAgentSelectorSegment(selector.definitionId));
        if (!target) {
          return null;
        }
        return await ensureSteerTargetAvailable(broker, target.actorId, currentDirectory)
          ? { ...target, selectorLabel: selector.label }
          : null;
      }),
    )
  ).filter((target): target is { actorId: string; label: string; selectorLabel: string } => Boolean(target));
  const scopedSelectorLabels = new Set(
    scopedSelectorTargets.flatMap((target) => [
      normalizeAgentSelectorSegment(target.label),
      normalizeAgentSelectorSegment(target.selectorLabel),
    ]),
  );
  const explicitTargetIds = [...new Set(
    (input.targetParticipantIds ?? [])
      .map((targetId) => targetId.trim())
      .filter((targetId) => targetId.length > 0),
  )];

  const availableMentionTargets = (
    await Promise.all(
      mentionResolution.resolved.map(async (target) => (
        await ensureSteerTargetAvailable(
          broker,
          target.agentId,
          currentDirectory,
        )
          ? target
          : null
      )),
    )
  ).filter((target): target is ScoutMentionTarget => Boolean(target));
  // With body routing off the caller's list is the whole address book for this
  // send. Treating it as an explicit attempt even when empty is what stops an
  // unroutable ask from falling back to steering the entire room.
  const explicitTargetAttempted =
    !routeBodyMentions || explicitTargetIds.length > 0 || selectors.length > 0;
  const explicitAvailableTargets = (
    await Promise.all(
      explicitTargetIds.map(async (targetId) => (
        isSteerableParticipant(broker.snapshot, targetId, senderId)
        && await ensureSteerTargetAvailable(broker, targetId, currentDirectory)
          ? targetId
          : null
      )),
    )
  ).filter((targetId): targetId is string => Boolean(targetId));
  const defaultScopeTargets = explicitTargetAttempted
    ? []
    : conversation.participantIds.filter((participantId) =>
        isSteerableParticipant(broker.snapshot, participantId, senderId)
      );
  const targetIds = [...new Set(
    availableMentionTargets
      .map((target) => target.agentId)
      .concat(scopedSelectorTargets.map((target) => target.actorId))
      .concat(explicitAvailableTargets)
      .concat(defaultScopeTargets)
      .filter((targetId) => targetId !== senderId),
  )];
  const unresolvedTargets = mentionResolution.resolved
    .filter((target) => !targetIds.includes(target.agentId))
    .map((target) => target.label)
    .concat(mentionResolution.unresolved.filter((label) =>
      !scopedSelectorLabels.has(normalizeAgentSelectorSegment(label))
    ))
    .concat(mentionResolution.ambiguous
      .map((entry) => entry.label)
      .filter((label) => !scopedSelectorLabels.has(normalizeAgentSelectorSegment(label))))
    .concat(explicitTargetIds.filter((targetId) => !targetIds.includes(targetId)));

  const messageId = stableBrokerRecordId("m", input.clientMessageId, createdAtMs);
  const returnAddress = buildScoutReturnAddress(broker.snapshot, senderId, {
    conversationId: conversation.id,
    replyToMessageId: messageId,
  });
  const targetLabels = targetIds.map((targetId) => ({
    actorId: targetId,
    label: availableMentionTargets.find((target) => target.agentId === targetId)?.label
      ?? scopedSelectorTargets.find((target) => target.actorId === targetId)?.label
      ?? steerTargetLabel(broker.snapshot, targetId),
  }));

  await brokerPostJson(broker.baseUrl, scoutBrokerPaths.v1.messages, {
    id: messageId,
    conversationId: conversation.id,
    actorId: senderId,
    originNodeId: broker.node.id,
    class: conversation.kind === "system" ? "system" : "agent",
    body: input.body,
    ...(input.replyToMessageId?.trim() ? { replyToMessageId: input.replyToMessageId.trim() } : {}),
    mentions: [...new Map([...targetLabels, ...(input.attentionMentions ?? [])].map(mention => [mention.actorId, mention])).values()],
    attachments: normalizeOutgoingAttachments(input.attachments),
    audience: targetIds.length > 0
      ? {
          notify: targetIds,
          reason: conversation.kind === "channel" ? "mention" : "direct_message",
        }
      : undefined,
    visibility: conversation.visibility,
    policy: "durable",
    createdAt: createdAtMs,
    metadata: {
      source: input.source?.trim() || "scout-web",
      destinationKind: "conversation",
      destinationId: conversation.id,
      intent,
      relayMessageId: messageId,
      relayTargetIds: targetIds,
      scopedTargets: targetLabels,
      ...clientMessageMetadata(input.clientMessageId),
      returnAddress,
    },
  });

  const flights: ScoutFlightRecord[] = [];
  for (const targetActorId of targetIds) {
    const target = invocationTargetRoute(broker.snapshot, targetActorId);
    const steerContext = intent === "steer"
      ? input.steerContextByTargetAgentId?.[targetActorId]
      : undefined;
    const requestedExecution = intent === "invoke" ? input.execution : undefined;
    const hasExplicitSession = requestedExecution?.session === "new"
      || (requestedExecution?.session === "existing" && Boolean(requestedExecution.targetSessionId?.trim()));
    const execution = hasExplicitSession
      ? requestedExecution
      : {
          ...await invocationExecutionForSteer(broker.baseUrl, broker.snapshot, targetActorId, conversation.id),
          ...requestedExecution,
        };
    const response = await brokerPostJson<ScoutInvocationPostResponse>(
      broker.baseUrl,
      scoutBrokerPaths.v1.invocations,
      {
        id: stableBrokerRecordId("inv", input.clientMessageId, createdAtMs, targetActorId),
        requesterId: senderId,
        requesterNodeId: broker.node.id,
        targetAgentId: targetActorId,
        ...(target ? { target } : {}),
        action: intent === "invoke" ? "consult" : "wake",
        task: input.body.trim() || "Review the attached message.",
        conversationId: conversation.id,
        messageId,
        execution,
        ensureAwake: true,
        stream: false,
        labels: [intent],
        createdAt: Date.now(),
        metadata: {
          source: input.source?.trim() || "scout-web",
          destinationKind: "conversation",
          destinationId: conversation.id,
          intent,
          ...(intent === "tell" ? { sourceIntent: "direct_message" } : {}),
          relayTarget: targetActorId,
          relayTargetIds: targetIds,
          relayMessageId: messageId,
          ...(steerContext
            ? {
                parentRunId: steerContext.runId,
                ...(steerContext.flightId ? { steeredFlightId: steerContext.flightId } : {}),
              }
            : {}),
          returnAddress,
        },
      },
    );
    if (response.flight) {
      flights.push(response.flight);
    }
  }

  return {
    usedBroker: true,
    conversationId: conversation.id,
    messageId,
    ...(flights[0] ? { flight: flights[0] } : {}),
    ...(flights.length ? { flights } : {}),
    invokedTargets: targetIds,
    unresolvedTargets,
  };
}

export async function loadScoutReadCursors(input: {
  conversationId: string;
  baseUrl?: string;
}): Promise<ScoutBrokerReadCursorRecord[]> {
  const path = `/v1/conversations/${encodeURIComponent(input.conversationId)}/read-cursors`;
  return brokerReadJson<ScoutBrokerReadCursorRecord[]>(
    input.baseUrl ?? resolveScoutBrokerUrl(),
    path,
  );
}

export async function updateScoutChatPreferences(input: {
  conversationId: string; actorId: string; change: unknown; baseUrl?: string;
}): Promise<{ ok: true; preferences: import("@openscout/protocol").ChatAttentionPreferences }> {
  return brokerPostJson(input.baseUrl ?? resolveScoutBrokerUrl(),
    `/v1/conversations/${encodeURIComponent(input.conversationId)}/read-cursors`,
    { operation: "preferences", actorId: input.actorId, change: input.change });
}

export async function markScoutConversationRead(input: {
  conversationId: string;
  actorId?: string;
  readerNodeId?: string;
  lastReadMessageId?: string;
  lastReadSeq?: number;
  lastReadAt?: number;
  metadata?: Record<string, unknown>;
  baseUrl?: string;
}): Promise<{
  ok: true;
  cursor: ScoutBrokerReadCursorRecord;
  acknowledgedDeliveries: number;
}> {
  const baseUrl = input.baseUrl ?? resolveScoutBrokerUrl();
  const path = `/v1/conversations/${encodeURIComponent(input.conversationId)}/read-cursors`;
  // The broker supplies its local node id when readerNodeId is omitted. A read
  // acknowledgement must not first load the multi-megabyte broker snapshot;
  // doing that put a best-effort UI write behind 30-second snapshot timeouts.
  return brokerPostJson(baseUrl, path, {
    actorId: input.actorId,
    readerNodeId: input.readerNodeId,
    lastReadMessageId: input.lastReadMessageId,
    lastReadSeq: input.lastReadSeq,
    lastReadAt: input.lastReadAt,
    metadata: input.metadata,
  });
}

/**
 * Give a conversation a human name, or hand it back to automatic naming.
 *
 * An empty title clears the operator's claim rather than blanking the row —
 * see packages/runtime/src/conversation-title.ts for why the mark lives on
 * metadata instead of being a plain title write.
 */
export async function renameScoutConversation(input: {
  conversationId: string;
  title: string;
  baseUrl?: string;
}): Promise<{ ok: true; conversation: { id: string; title: string }; titled: boolean }> {
  const baseUrl = input.baseUrl ?? resolveScoutBrokerUrl();
  const path = `/v1/conversations/${encodeURIComponent(input.conversationId)}/title`;
  // Like the read cursor, a rename must not sit behind a multi-megabyte
  // snapshot load — the broker resolves the conversation itself.
  return brokerPostJson(baseUrl, path, { title: input.title });
}

export async function openScoutDirectSession(input: {
  agentId: string;
  currentDirectory?: string;
  operatorName?: string;
  targetName?: string;
}): Promise<ScoutDirectSessionResult> {
  const session = await openScoutPeerSession({
    sourceId: OPERATOR_ID,
    targetId: input.agentId,
    currentDirectory: input.currentDirectory,
    sourceName: input.operatorName,
    targetName: input.targetName,
  });
  return {
    agent: session.agent,
    conversation: session.conversation,
    existed: session.existed,
  };
}

export async function openScoutPeerSession(input: {
  sourceId: string;
  targetId: string;
  currentDirectory?: string;
  sourceName?: string;
  targetName?: string;
}): Promise<ScoutPeerSessionResult> {
  const broker = await requireScoutBrokerContext();
  const currentDirectory = input.currentDirectory ?? process.cwd();
  const sourceId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.sourceId,
    currentDirectory,
    input.sourceName,
  );
  const targetId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.targetId,
    currentDirectory,
    input.targetName,
  );

  if (broker.snapshot.agents[targetId]) {
    const targetReady = await ensureTargetRelayAgentRegistered(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      targetId,
      currentDirectory,
    );
    if (!targetReady) {
      throw new Error(`Agent ${input.targetId} is not available.`);
    }
  }

  const session = await ensureBrokerDirectConversationBetween(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    sourceId,
    targetId,
  );

  return {
    ...session,
    sourceId,
    targetId,
  };
}

export async function sendScoutDirectMessage(input: {
  agentId: string;
  body: string;
  attachments?: OutgoingAttachmentInput[];
  currentDirectory?: string;
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
  referenceMessageIds?: string[];
  executionHarness?: AgentHarness;
  executionModel?: string;
  executionReasoningEffort?: string;
  source?: string;
  deviceId?: string;
}): Promise<ScoutDirectMessageResult> {
  const broker = await requireScoutBrokerContext();
  const createdAt = Date.now();
  const source = input.source?.trim() || "scout-mobile";
  const attachments = normalizeOutgoingAttachments(input.attachments, input.clientMessageId);
  // The mobile bridge deliberately accepts attachment-only posts. `/v1/deliver`
  // requires a non-empty body because consult deliveries also become invocation
  // tasks, so give a valid attachment-only send an explicit task instead of
  // letting the broker reject it after the upload succeeded.
  const body = input.body.trim() || (attachments?.length ? "Review the attached message." : "");
  const delivery = await brokerPostDeliver(broker.baseUrl, {
    ...deliveryRequestIdentity(input.clientMessageId, createdAt),
    requesterId: OPERATOR_ID,
    requesterNodeId: broker.node.id,
    targetAgentId: input.agentId,
    body,
    attachments,
    intent: "consult",
    replyToMessageId: input.replyToMessageId ?? undefined,
    execution: {
      ...(input.executionHarness ? { harness: input.executionHarness } : {}),
      ...(input.executionModel?.trim() ? { model: input.executionModel.trim() } : {}),
      ...(input.executionReasoningEffort?.trim()
        ? { reasoningEffort: input.executionReasoningEffort.trim() }
        : {}),
      session: "new",
    },
    ensureAwake: true,
    messageMetadata: {
      source,
      destinationKind: "direct",
      destinationId: input.agentId,
      referenceMessageIds: input.referenceMessageIds ?? [],
      ...clientMessageMetadata(input.clientMessageId),
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    },
    invocationMetadata: {
      source,
      destinationKind: "direct",
      destinationId: input.agentId,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    },
  });
  if (delivery.kind !== "delivery") {
    throw new ScoutDirectDeliveryUnavailableError(delivery);
  }

  return {
    conversationId: delivery.conversation.id,
    messageId: delivery.message.id,
    flight: delivery.flight,
  };
}

/** Pending approvals on other machines that share them with this one (runtime mesh-approvals.ts). */
export type ScoutRemoteApprovalNode = {
  nodeId: string;
  label: string;
  state: "connecting" | "live" | "stale" | "not_shared" | "unreachable";
  approvals: Array<{
    sessionId: string;
    sessionName: string;
    adapterType: string;
    turnId: string;
    turnStartedAt?: number;
    blockId: string;
    version: number;
    risk: "low" | "medium" | "high";
    title: string;
    description: string;
    detail: string | null;
    actionKind: string;
  }>;
  truncated: boolean;
  updatedAt: number | null;
};

export async function loadScoutRemoteApprovals(): Promise<ScoutRemoteApprovalNode[]> {
  const broker = await loadScoutBrokerContext().catch(() => null);
  if (!broker) return [];
  try {
    const payload = await brokerReadJson<{ nodes?: ScoutRemoteApprovalNode[] }>(broker.baseUrl, "/v1/approvals/remote", {
      signal: AbortSignal.timeout(2_000),
    });
    return Array.isArray(payload.nodes) ? payload.nodes : [];
  } catch {
    // Older broker without the route, or busy — remote approvals are optional.
    return [];
  }
}

export async function decideScoutRemoteApproval(input: {
  nodeId: string;
  sessionId: string;
  turnId: string;
  blockId: string;
  version: number;
  decision: "approve" | "deny";
  reason?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return { ok: false, error: "local broker is unavailable" };
  const { reason, ...rest } = input;
  const result = await brokerPostJson<{ ok?: true; error?: string }>(
    broker.baseUrl,
    "/v1/approvals/remote/decide",
    { ...rest, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
    { acceptErrorJson: (value): value is { error: string } => Boolean(value && typeof (value as { error?: unknown }).error === "string") },
  );
  return result.error ? { ok: false, error: result.error } : { ok: true };
}

export async function requestScoutHostWeb(input: { nodeId: string; path: string; method: "GET" | "POST"; body?: unknown }): Promise<{ status: number; body: unknown; binary?: { data: string; contentType: string } }> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return { status: 503, body: { error: "Local broker is unavailable" } };
  return brokerPostJson(broker.baseUrl, "/v1/hosts/web-request", input);
}

export async function askScoutQuestion(input: {
  senderId: string;
  targetLabel?: string;
  targetAgentId?: string;
  target?: ScoutRouteTarget;
  body: string;
  sessionDelivery?: "in_place_or_resume";
  channel?: string;
  shouldSpeak?: boolean;
  createdAtMs?: number;
  clientMessageId?: string | null;
  executionHarness?: AgentHarness;
  executionModel?: string;
  executionReasoningEffort?: string;
  executionSession?: "new" | "existing" | "any" | "fork";
  executionTargetSessionId?: string;
  executionForkFromSessionId?: string;
  executionForkFromStateId?: string;
  projectAgent?: ScoutProjectAgentSpec;
  attachments?: OutgoingAttachmentInput[];
  currentDirectory?: string;
  source?: string;
  messageMetadata?: Record<string, unknown>;
  invocationMetadata?: Record<string, unknown>;
}): Promise<ScoutAskResult> {
  const renderedTarget = input.targetLabel?.trim()
    || (input.target ? renderedScoutAskTarget(input.target) : "")
    || input.targetAgentId?.trim()
    || "";
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { usedBroker: false, unresolvedTarget: renderedTarget };
  }
  if (input.sessionDelivery) {
    if (!input.clientMessageId?.trim()) throw new Error("request_id_required: session input requires a stable client message id");
    // A context can be retained for 90 seconds while a broker is replaced.
    // Never authorize this option from that stale capability snapshot.
    const currentNode = await brokerReadJson<ScoutBrokerNodeRecord>(broker.baseUrl, scoutBrokerPaths.v1.node,
      { signal: boundedBrokerSignal(undefined, BROKER_CONTEXT_TIMEOUT_MS) });
    if (currentNode.id !== broker.node.id || !currentNode.capabilities?.includes(SCOUT_SESSION_INPUT_RECEIPTS_CAPABILITY)) {
      throw new Error("session_input_unsupported: update the broker before submitting live session replies");
    }
  }
  const currentDirectory = input.currentDirectory ?? process.cwd();
  const senderId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.senderId,
    currentDirectory,
  );
  if (!renderedTarget) {
    return { usedBroker: true, unresolvedTarget: renderedTarget };
  }
  const normalizedTargetLabel = renderedScoutAskBodyTargetLabel(input.target, renderedTarget);
  const explicitTargetAgentId = input.targetAgentId?.trim()
    || (input.target ? undefined : broker.snapshot.agents[renderedTarget]?.id);
  if (explicitTargetAgentId) {
    await ensureTargetRelayAgentRegistered(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      explicitTargetAgentId,
      currentDirectory,
    );
  }
  const messageBody = input.sessionDelivery ? input.body.trim() : normalizedTargetLabel && input.body.trim().startsWith(normalizedTargetLabel)
    ? input.body.trim()
    : normalizedTargetLabel
    ? `${normalizedTargetLabel} ${input.body.trim()}`
    : input.body.trim();
  const createdAt = input.createdAtMs ?? Date.now();
  const source = input.source?.trim() || "scout-cli";
  const delivery = await brokerPostDeliver(broker.baseUrl, {
    ...deliveryRequestIdentity(input.clientMessageId, createdAt, input.createdAtMs),
    requesterId: senderId,
    requesterNodeId: broker.node.id,
    ...(input.target ? { target: input.target } : {}),
    targetLabel: renderedTarget,
    targetAgentId: explicitTargetAgentId,
    body: messageBody,
    attachments: normalizeOutgoingAttachments(input.attachments, input.clientMessageId),
    intent: "consult",
    ...(input.sessionDelivery ? { sessionDelivery: input.sessionDelivery } : {}),
    channel: input.channel,
    speechText: input.shouldSpeak ? stripScoutAgentSelectorLabels(messageBody) : undefined,
    execution: {
      ...(input.executionHarness ? { harness: input.executionHarness } : {}),
      ...(input.executionModel?.trim() ? { model: input.executionModel.trim() } : {}),
      ...(input.executionReasoningEffort?.trim()
        ? { reasoningEffort: input.executionReasoningEffort.trim() }
        : {}),
      session: input.executionSession ?? (input.sessionDelivery ? "existing" : defaultScoutAskExecutionSession(input.target)),
      ...(input.executionTargetSessionId?.trim()
        ? { targetSessionId: input.executionTargetSessionId.trim() }
        : {}),
      ...(input.executionForkFromSessionId?.trim()
        ? { forkFromSessionId: input.executionForkFromSessionId.trim() }
        : {}),
      ...(input.executionForkFromStateId?.trim()
        ? { forkFromStateId: input.executionForkFromStateId.trim() }
        : {}),
    },
    ...(input.projectAgent ? { projectAgent: input.projectAgent } : {}),
    ensureAwake: true,
    messageMetadata: {
      source,
      ...clientMessageMetadata(input.clientMessageId),
      ...(input.messageMetadata ?? {}),
    },
    invocationMetadata: {
      source,
      ...(input.invocationMetadata ?? {}),
    },
  });

  if (delivery.kind !== "delivery") {
    return {
      usedBroker: true,
      unresolvedTarget: renderedTarget,
      targetDiagnostic: scoutTargetDiagnosticFromDeliveryFailure(delivery),
    };
  }

  return {
    usedBroker: true,
    flight: delivery.flight,
    ...(delivery.receipt?.inputSubmitted ? { inputSubmitted: delivery.receipt.inputSubmitted } : {}),
    conversationId: delivery.conversation.id,
    messageId: delivery.message.id,
    targetAgentId: delivery.targetAgentId,
    targetSessionId: delivery.targetSessionId,
    targetLabel: delivery.receipt?.targetLabel ?? renderedTarget,
  };
}

// The control-plane database can be absent on a fresh install — a durable
// miss must degrade to "not found", never break a previously snapshot-only
// reader.
function durableBrokerFlight(flightId: string): ScoutFlightRecord | null {
  try {
    return queryFlightRecordById(flightId);
  } catch {
    return null;
  }
}

function durableBrokerInvocation(invocationId: string): InvocationRequest | null {
  try {
    return queryInvocationById(invocationId);
  } catch {
    return null;
  }
}

// There is no per-flight broker route (only /v1/invocations/:id, keyed by
// invocation id), so a single-flight read uses the conversations-scoped
// snapshot — never the unscoped full-registry read. SQLite retains terminal
// flights the broker hot set rotated out, so a snapshot miss falls back to
// the durable record.
async function loadBrokerFlight(baseUrl: string, flightId: string): Promise<ScoutFlightRecord | null> {
  const snapshot = await brokerReadJson<{ flights?: Record<string, ScoutFlightRecord> }>(
    baseUrl,
    `${scoutBrokerPaths.v1.snapshot}?scope=conversations`,
  );
  return snapshot.flights?.[flightId] ?? durableBrokerFlight(flightId);
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
    if (flight.state === "completed") return flight;
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
  const conversationId = context
    ? resolveConversationIdForChannel(context.snapshot, options.channel)
    : null;
  if (!conversationId) {
    return [];
  }
  const search = new URLSearchParams();
  search.set("conversationId", conversationId);
  if (typeof options.since === "number" && Number.isFinite(options.since) && options.since > 0) {
    search.set("since", String(options.since));
  }
  if (typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0) {
    search.set("limit", String(options.limit));
  }
  return brokerReadJson<ScoutBrokerMessageRecord[]>(
    baseUrl,
    scoutBrokerMessagesListPath(search),
  );
}

export type ScoutActivityItem = {
  id: string;
  kind: string;
  ts: number;
  conversationId?: string;
  messageId?: string;
  invocationId?: string;
  flightId?: string;
  recordId?: string;
  actorId?: string;
  counterpartId?: string;
  agentId?: string;
  workspaceRoot?: string;
  sessionId?: string;
  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;
};

export async function loadScoutActivityItems(options: {
  agentId?: string;
  actorId?: string;
  conversationId?: string;
  limit?: number;
  baseUrl?: string;
} = {}): Promise<ScoutActivityItem[]> {
  const search = new URLSearchParams();
  if (options.agentId) search.set("agentId", options.agentId);
  if (options.actorId) search.set("actorId", options.actorId);
  if (options.conversationId) search.set("conversationId", options.conversationId);
  if (typeof options.limit === "number" && options.limit > 0) search.set("limit", String(options.limit));
  const q = search.toString();
  const path = q ? `${scoutBrokerPaths.v1.activity}?${q}` : scoutBrokerPaths.v1.activity;
  return brokerReadJson<ScoutActivityItem[]>(options.baseUrl ?? resolveScoutBrokerUrl(), path);
}

export async function watchScoutMessages(options: ScoutWatchOptions): Promise<void> {
  const broker = await requireScoutBrokerContext();
  const conversationId = options.conversationId ?? (
    options.allConversations ? undefined : resolveConversationIdForChannel(broker.snapshot, options.channel)
  );
  if (!conversationId && !options.allConversations) {
    throw new Error(`Channel "${options.channel?.trim() || "shared"}" does not have a chat yet.`);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  try {
    const response = await fetch(new URL(scoutBrokerPaths.v1.eventsStream, broker.baseUrl), {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`${scoutBrokerPaths.v1.eventsStream} returned ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const messagesById = new Map(
      Object.values(broker.snapshot.messages ?? {}).map((message) => [message.id, message]),
    );
    const invocationsById = new Map(
      Object.values(broker.snapshot.invocations ?? {}).map((invocation) => [invocation.id, invocation]),
    );

    const clientMessageIdFor = (message: ScoutBrokerMessageRecord | undefined): string | null => {
      const raw = message?.metadata?.clientMessageId;
      return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    };

    const lifecycleStateForFlight = (state: string | undefined): ScoutBrokerConversationLifecycleState | null => {
      switch (state) {
        case "queued": return "queued";
        case "waking": return "dispatching";
        case "running": return "working";
        case "waiting": return "waiting";
        case "completed": return "completed";
        case "failed": return "failed";
        case "cancelled": return "cancelled";
        default: return null;
      }
    };

    const maybeRefreshMaps = async () => {
      const latest = await loadScoutBrokerContext().catch(() => null);
      if (!latest) return;
      for (const message of Object.values(latest.snapshot.messages ?? {})) {
        messagesById.set(message.id, message);
      }
      for (const invocation of Object.values(latest.snapshot.invocations ?? {})) {
        invocationsById.set(invocation.id, invocation);
      }
    };

    // An invocation referenced by a live event may have rotated out of the
    // broker's hot window; SQLite retains it, so fall back to the durable row.
    const resolveInvocation = async (invocationId: string | undefined) => {
      if (!invocationId) return undefined;
      let invocation = invocationsById.get(invocationId);
      if (!invocation) {
        await maybeRefreshMaps();
        invocation = invocationsById.get(invocationId);
      }
      if (!invocation) {
        const durable = durableBrokerInvocation(invocationId);
        if (durable) {
          invocationsById.set(durable.id, durable);
          invocation = durable;
        }
      }
      return invocation;
    };

    const emitLifecycle = (record: ScoutBrokerConversationLifecycleRecord) => {
      if (conversationId && record.conversationId !== conversationId) return;
      options.onLifecycle?.(record);
    };

    const handleBlock = async (block: string) => {
      const trimmed = block.trim();
      if (!trimmed) return;
      let eventName = "";
      const dataLines: string[] = [];
      for (const line of trimmed.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
      }
      if (dataLines.length === 0) return;
      let event: ControlEvent;
      try {
        event = JSON.parse(dataLines.join("\n")) as ControlEvent;
      } catch {
        return;
      }
      if (event.kind === "message.posted" || eventName === "message.posted") {
        const message = (event as Extract<ControlEvent, { kind: "message.posted" }>).payload?.message as ScoutBrokerMessageRecord | undefined;
        if (!message) return;
        messagesById.set(message.id, message);
        if (conversationId && message.conversationId !== conversationId) return;
        if (options.agentId && message.actorId === options.agentId) return;
        options.onMessage(message);
        return;
      }

      if (!options.onLifecycle) return;

      if (event.kind === "invocation.requested") {
        const invocation = (event as Extract<ControlEvent, { kind: "invocation.requested" }>).payload?.invocation;
        if (!invocation?.conversationId) return;
        invocationsById.set(invocation.id, invocation);
        const message = invocation.messageId ? messagesById.get(invocation.messageId) : undefined;
        emitLifecycle({
          conversationId: invocation.conversationId,
          messageId: invocation.messageId ?? null,
          clientMessageId: clientMessageIdFor(message),
          invocationId: invocation.id,
          targetAgentId: invocation.targetAgentId,
          state: invocation.ensureAwake ? "dispatching" : "queued",
        });
        return;
      }

      if (event.kind === "flight.updated") {
        const flight = (event as Extract<ControlEvent, { kind: "flight.updated" }>).payload?.flight;
        if (!flight) return;
        const invocation = await resolveInvocation(flight.invocationId);
        if (!invocation?.conversationId) return;
        const message = invocation.messageId ? messagesById.get(invocation.messageId) : undefined;
        emitLifecycle({
          conversationId: invocation.conversationId,
          messageId: invocation.messageId ?? null,
          clientMessageId: clientMessageIdFor(message),
          invocationId: invocation.id,
          flightId: flight.id,
          targetAgentId: flight.targetAgentId,
          state: lifecycleStateForFlight(flight.state) ?? "dispatching",
          summary: flight.summary ?? null,
          error: flight.error ?? null,
        });
        return;
      }

      if (event.kind === "delivery.state.changed") {
        const delivery = (event as Extract<ControlEvent, { kind: "delivery.state.changed" }>).payload?.delivery;
        if (!delivery) return;
        if (delivery.status !== "peer_acked" && delivery.status !== "acknowledged" && delivery.status !== "running") return;
        const invocation = await resolveInvocation(delivery.invocationId);
        const message = delivery.messageId ? messagesById.get(delivery.messageId) : undefined;
        const lifecycleConversationId = invocation?.conversationId ?? message?.conversationId;
        if (!lifecycleConversationId) return;
        emitLifecycle({
          conversationId: lifecycleConversationId,
          messageId: delivery.messageId ?? invocation?.messageId ?? null,
          clientMessageId: clientMessageIdFor(message),
          invocationId: delivery.invocationId ?? invocation?.id ?? null,
          flightId: typeof delivery.metadata?.flightId === "string" ? delivery.metadata.flightId : null,
          targetAgentId: delivery.targetId,
          state: delivery.status === "running" ? "working" : "acknowledged",
        });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const delimiterIndex = buffer.indexOf("\n\n");
        if (delimiterIndex === -1) break;
        const block = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        await handleBlock(block);
      }
    }
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    if (!isAbort) throw error;
  } finally {
    if (options.signal) {
      options.signal.removeEventListener("abort", abort);
    }
  }
}

function whoStateRank(state: AgentState | "discovered"): number {
  switch (state) {
    case "active": return 5;
    case "waiting": return 4;
    case "idle": return 2;
    case "offline": return 1;
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

function whoEntryState(endpoints: ScoutBrokerEndpointRecord[], registrationKind: ScoutWhoRegistrationKind): AgentState | "discovered" {
  if (endpoints.length === 0) return registrationKind === "discovered" ? "discovered" : "offline";
  return endpoints.reduce<AgentState>((bestState, endpoint) => {
    const nextState = endpoint.state ?? "offline";
    return whoStateRank(nextState) > whoStateRank(bestState) ? nextState : bestState;
  }, "offline");
}

async function loadDiscoveredAgentMap(currentDirectory: string): Promise<Map<string, ResolvedRelayAgentConfig>> {
  try {
    const setup = await loadResolvedRelayAgents({ currentDirectory });
    return new Map(setup.discoveredAgents.map((agent) => [agent.agentId, agent]));
  } catch {
    return new Map();
  }
}

export async function listScoutAgents(options: { currentDirectory?: string } = {}): Promise<ScoutWhoEntry[]> {
  const broker = await requireScoutBrokerContext();
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const [discoveredAgents, aliasResult] = await Promise.all([
    loadDiscoveredAgentMap(currentDirectory),
    brokerReadJson<{ bindings: RouteAliasBinding[] }>(
      broker.baseUrl,
      `/v1/aliases?${new URLSearchParams({ currentDirectory })}`,
    ).catch(() => ({ bindings: [] })),
  ]);
  const aliasesByAgent = new Map<string, RouteAliasBinding[]>();
  for (const binding of aliasResult.bindings) {
    if (binding.state !== "active") continue;
    const entries = aliasesByAgent.get(binding.target.agentId) ?? [];
    entries.push(binding);
    aliasesByAgent.set(binding.target.agentId, entries);
  }
  const endpointsByAgent = new Map<string, ScoutBrokerEndpointRecord[]>();
  const messageStats = new Map<string, { messages: number; lastSeen: number | null }>();

  for (const endpoint of Object.values(broker.snapshot.endpoints ?? {})) {
    if (!endpoint.agentId || endpoint.agentId === OPERATOR_ID) continue;
    if (isSupersededBrokerAgent(broker.snapshot, endpoint.agentId)) continue;
    const existing = endpointsByAgent.get(endpoint.agentId) ?? [];
    existing.push(endpoint);
    endpointsByAgent.set(endpoint.agentId, existing);
  }
  for (const message of Object.values(broker.snapshot.messages ?? {})) {
    if (!message.actorId || message.actorId === OPERATOR_ID) continue;
    if (isSupersededBrokerAgent(broker.snapshot, message.actorId)) continue;
    const current = messageStats.get(message.actorId) ?? { messages: 0, lastSeen: null };
    current.messages += 1;
    current.lastSeen = maxDefined([current.lastSeen, normalizeUnixTimestamp(message.createdAt)]);
    messageStats.set(message.actorId, current);
  }

  return [...new Set([
    ...Object.keys(broker.snapshot.agents ?? {}),
    ...Array.from(endpointsByAgent.keys()),
    ...Array.from(messageStats.keys()),
    ...Array.from(discoveredAgents.keys()),
  ])]
    .filter((agentId) => agentId && agentId !== OPERATOR_ID)
    .filter((agentId) => !isSupersededBrokerAgent(broker.snapshot, agentId))
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
      const aliases = aliasesByAgent.get(agentId);
      return { agentId, state, messages, lastSeen, registrationKind, ...(aliases?.length ? { aliases } : {}) };
    })
    .sort((lhs, rhs) => {
      const stateDelta = whoStateRank(rhs.state) - whoStateRank(lhs.state);
      if (stateDelta !== 0) return stateDelta;
      const lastSeenDelta = (rhs.lastSeen ?? -1) - (lhs.lastSeen ?? -1);
      if (lastSeenDelta !== 0) return lastSeenDelta;
      return lhs.agentId.localeCompare(rhs.agentId);
    });
}

export async function loadScoutRelayConfig(): Promise<RelayConfig> {
  try {
    const raw = await readFile(join(relayHubDirectory(), "config.json"), "utf8");
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
  if (!pronunciations) return text;
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
      if (Date.now() - Number(lock.ts ?? 0) > 30_000) break;
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
  if (!apiKey || !clean) return;

  const { spawn } = await import("node:child_process");
  const response = await fetch(openAiAudioSpeechUrl, {
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
  if (!response.ok || !response.body) return;

  const player = spawn("ffplay", [
    "-nodisp", "-autoexit", "-loglevel", "quiet",
    "-f", "s16le", "-ar", "24000", "-ch_layout", "mono", "-",
  ], { stdio: ["pipe", "ignore", "ignore"] });

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    player.stdin.write(value);
  }
  player.stdin.end();
  await new Promise<void>((resolve) => player.on("close", () => resolve()));
}

export function defaultScoutAgentNameForPath(projectPath: string): string {
  return basename(projectPath);
}

export async function updateScoutChannelPins(input: {
  conversationId: string; actorId: string; change: unknown; baseUrl?: string;
}): Promise<{ ok: true; conversation: import("@openscout/protocol").ConversationDefinition }> {
  return brokerPostJson(input.baseUrl ?? resolveScoutBrokerUrl(), `/v1/conversations/${encodeURIComponent(input.conversationId)}/pins`, { actorId: input.actorId, change: input.change });
}

export async function correctScoutChatMessage(input: {
  conversationId: string; messageId: string; actorId: string; canModerate: boolean; change: unknown; baseUrl?: string;
}): Promise<{ ok: true; message: MessageRecord }> {
  type Result = { ok: true; message: MessageRecord } | { status: number; error: string };
  const result = await brokerPostJson<Result>(input.baseUrl ?? resolveScoutBrokerUrl(), `/v1/conversations/${encodeURIComponent(input.conversationId)}/corrections`, {
    messageId: input.messageId, actorId: input.actorId, canModerate: input.canModerate, change: input.change,
  }, { acceptErrorJson: (value): value is Result => Boolean(value && typeof value === "object" && "status" in value && "error" in value) });
  if ("error" in result) throw Object.assign(new Error(result.error), { status: result.status });
  return result;
}


export async function respondScoutChatQuestion(input: {
  channelId: string; questionId: string; actorId: string; isOperator: boolean; change: unknown; baseUrl?: string;
}): Promise<{ ok: true; record: import("@openscout/protocol").CollaborationRecord }> {
  type Result = { ok: true; record: import("@openscout/protocol").CollaborationRecord } | { status: number; error: string };
  const result = await brokerPostJson<Result>(input.baseUrl ?? resolveScoutBrokerUrl(), `/v1/conversations/${encodeURIComponent(input.channelId)}/questions/${encodeURIComponent(input.questionId)}/respond`, {
    actorId: input.actorId, isOperator: input.isOperator, change: input.change,
  }, { acceptErrorJson: (value): value is Result => Boolean(value && typeof value === "object" && "status" in value && "error" in value) });
  if ("error" in result) throw Object.assign(new Error(result.error), { status: result.status });
  return result;
}

/** Retained questions, scoped by the broker before pagination rather than the hot snapshot. */
export async function readScoutChatQuestionHistory(baseUrl: string, channelId: string, after: { createdAt: number; id: string } | null): Promise<CollaborationRecord[]> {
  const pages = await Promise.all(["closed", "declined"].map(state => {
    const params = new URLSearchParams({ kind: "question", state, conversationId: channelId, includeThreads: "true", orderByCreatedAt: "true", limit: "51" });
    if (after) { params.set("afterCreatedAt", String(after.createdAt)); params.set("afterId", after.id); }
    return brokerReadJson<CollaborationRecord[]>(baseUrl, `/v1/collaboration/records?${params}`, { signal: AbortSignal.timeout(5000) });
  }));
  return pages.flat();
}

export async function decideScoutPermission(input: { requestId: string; version: string; decision: "once" | "project" | "deny" }): Promise<void> {
  const broker = await loadScoutBrokerContext();
  if (!broker) throw new Error("Local broker is unavailable");
  const result = await brokerPostJson<{ ok?: boolean; error?: string; outcome?: string }>(broker.baseUrl, "/v1/permissions/decide", input, {
    acceptErrorJson: (value): value is { error: string; outcome: string } => Boolean(value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string" && ["refused", "unconfirmed"].includes(String((value as { outcome?: unknown }).outcome))),
  });
  if (result.error) throw Object.assign(new Error(result.error), { status: result.outcome === "refused" ? 409 : 502 });
}
