import { setTimeout as delay } from "node:timers/promises";
import { resolveScoutMachines } from "../mesh/machine-selector.ts";
import type { LiveTerminalSession } from "@openscout/runtime/live-terminal-session";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  buildScoutReturnAddress as buildScoutReturnAddressRecord,
  type ActorIdentity,
  type AgentBrokerFeed,
  type AgentDefinition,
  type AgentEndpoint,
  diagnoseAgentIdentity,
  extractAgentMentions,
  extractAgentSelectors,
  formatMinimalAgentIdentity,
  type FlightRecord,
  type InvocationRequest,
  type NodeDefinition,
  type AgentHarness,
  type AgentSelector,
  type AgentSelectorCandidate,
  type AgentState,
  type ConversationBinding,
  type ConversationDefinition,
  type ConversationReadCursor,
  conversationNaturalKey,
  conversationsWithNaturalKey,
  BUILT_IN_AGENT_DEFINITION_IDS,
  type ControlEvent,
  type CollaborationAcceptanceState,
  type CollaborationEvent,
  type CollaborationEventKind,
  type CollaborationProgress,
  type CollaborationPriority,
  type CollaborationRecord,
  type CollaborationWaitingOn,
  type MessageAttachment,
  type MessageRecord,
  type ScoutDeliverResponse,
  type ScoutCompletionRequest,
  type ScoutCompletionRelation,
  type ScoutCompletionReply,
  SCOUT_COMPLETION_CAPABILITY,
  type ScoutDeliverRequest,
  type ScoutDispatchRecord,
  type ScoutCapabilityMatrixSnapshot,
  type ScoutOwnedRuntimeCatalog,
  type ScoutProjectAgentSpec,
  type WakePolicy,
  type WorkItemRecord,
  type WorkItemState,
  type ScoutReturnAddress,
  type ScoutRouteTarget,
  type ScoutRendezvousRequest,
  type ScoutRendezvousResponse,
  SCOUT_RENDEZVOUS_MAX_WAIT_MS,
  isScoutRendezvousFailureResponse,
  type RouteAliasBinding,
  type RouteAliasScope,
  epochMs,
  namedChannelNaturalKey,
  parseScoutComposerRouteTarget,
  stableChannelId,
  systemChannelNaturalKey,
} from "@openscout/protocol";
import {
  ensureRelayAgentConfigured,
  findNearestProjectRoot,
  loadResolvedRelayAgents,
  readRelayAgentOverrides,
  resolveRelayAgentConfig,
  SCOUT_AGENT_ID,
  type ResolvedRelayAgentConfig,
} from "@openscout/runtime/setup";
import {
  maybePostJsonToActiveScoutBrokerService,
  maybeReadJsonFromActiveScoutBrokerService,
  requestScoutBrokerJson,
  requestScoutBrokerJsonWithTrace,
  type ScoutBrokerBuildIdentity,
  type ScoutBrokerChildServiceSnapshots,
  type ScoutBrokerHealthPayload,
  type ScoutBrokerJsonRequestTrace,
} from "@openscout/runtime/broker-api";
import {
  resolveScoutBrokerControlUrl,
  resolveBrokerSocketPathForBaseUrl,
} from "@openscout/runtime/broker-process-manager";
import {
  SUPPORTED_LOCAL_AGENT_HARNESSES,
  SUPPORTED_SCOUT_HARNESSES,
} from "@openscout/runtime/local-agent-harnesses";
import type { inferLocalAgentBinding, LocalAgentBinding } from "@openscout/runtime/local-agents";
import {
  createRuntimeRegistrySnapshot,
  type RuntimeRegistrySnapshot,
} from "@openscout/runtime/registry";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";
import { resolveOperatorName } from "@openscout/runtime/user-config";

import {
  openAiAudioSpeechUrl,
  scoutBrokerMessagesPath,
  scoutBrokerInvocationPath,
  scoutBrokerInvocationLifecyclePath,
  scoutBrokerInvocationStreamPath,
  scoutBrokerMessagesListPath,
  scoutBrokerPaths,
} from "./paths.ts";
import { buildScoutAskMetadata } from "./ask-metadata.ts";
import type {
  ScoutAskReplyMode,
  ScoutAskSenderContext,
  ScoutAskWorkspace,
} from "./ask-types.ts";
export {
  resolveHerdrAgentName,
  resolveHumanAskSenderName,
  resolveScoutAgentName,
  resolveScoutMatchParticipantId,
  resolveScoutSenderId,
} from "./sender.ts";

export type ScoutBrokerActorRecord = ActorIdentity;
export type ScoutBrokerAgentRecord = AgentDefinition;
export type ScoutBrokerEndpointRecord = AgentEndpoint;
export type ScoutBrokerConversationRecord = ConversationDefinition;
export type ScoutBrokerMessageRecord = MessageRecord;
export type ScoutBrokerReadCursorRecord = ConversationReadCursor;
export type ScoutBrokerNodeRecord = NodeDefinition;
export type ScoutBrokerFlightRecord = FlightRecord;
export type ScoutBrokerInvocationRecord = InvocationRequest;
export type ScoutBrokerConversationBindingRecord = ConversationBinding;
export type ScoutBrokerCollaborationRecord = CollaborationRecord;
export type ScoutBrokerSnapshot = RuntimeRegistrySnapshot;
export type ScoutAgentBrokerFeed = AgentBrokerFeed;
export type ScoutCapabilitySnapshot = ScoutCapabilityMatrixSnapshot;

export type ScoutBrokerContext = {
  baseUrl: string;
  node: ScoutBrokerNodeRecord;
  snapshot: ScoutBrokerSnapshot;
};

export type ScoutManagedLocalSessionTransport = "codex_app_server" | "tmux" | "ghostty";

export type ScoutManagedLocalSessionAttachment = {
  ok: boolean;
  agentId: string;
  selector: string | null;
  endpointId: string;
  sessionId: string;
};

export type ScoutBrokerHealthState = {
  baseUrl: string;
  reachable: boolean;
  ok: boolean;
  checkedAt: number;
  transport: ScoutBrokerJsonRequestTrace["transport"] | "in_process" | null;
  socketPath: string | null;
  socketFallbackError: string | null;
  nodeId: string | null;
  meshId: string | null;
  build: ScoutBrokerBuildIdentity | null;
  services: ScoutBrokerChildServiceSnapshots | null;
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
};

export type ScoutBrokerHomeAgentRecord = {
  id: string;
  title: string;
  role: string | null;
  summary: string | null;
  projectRoot: string | null;
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
  bindingRef?: string;
  flight?: ScoutFlightRecord;
  invokedTargets: string[];
  unresolvedTargets: string[];
  targetDiagnostic?: ScoutTargetDiagnostic;
  routeKind?: "dm" | "channel" | "broadcast";
  routingError?:
    | "missing_destination"
    | "multi_target_requires_explicit_channel";
};

export type ScoutStructuredMessagePostResult = {
  usedBroker: boolean;
  conversationId?: string;
  messageId?: string;
  flight?: ScoutFlightRecord;
  invokedTargetIds: string[];
  unresolvedTargetIds: string[];
  targetDiagnostic?: ScoutTargetDiagnostic;
  routeKind?: "dm" | "channel" | "broadcast";
  routingError?:
    | "missing_destination"
    | "multi_target_requires_explicit_channel";
};

export type ScoutReplyPostResult = {
  usedBroker: boolean;
  conversationId?: string;
  messageId?: string;
  replyToMessageId?: string;
  notifiedActorIds: string[];
  routingError?:
    | "missing_reply_context"
    | "unknown_conversation"
    | "unknown_reply_target"
    | "reply_target_conversation_mismatch";
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
  labels?: string[];
  metadata?: Record<string, unknown>;
};

/**
 * Minimal compatibility shape returned by `GET /v1/invocations/:id/lifecycle`.
 * The rich `ScoutInvocationLifecycle` projection was removed in the ask-overbuild
 * simplification (Phase 2); the invocations_get/wait tools read the flight first
 * and only used this as a fallback (targetAgentId). Mirror of the broker's
 * `InvocationLifecycleSummary`.
 */
export type ScoutInvocationLifecycleRecord = {
  invocationId: string;
  flightId?: string;
  targetAgentId?: string;
  state?: string;
  startedAt?: number;
  completedAt?: number;
};

export type ScoutLabelBriefFlight = {
  id: string;
  invocationId: string;
  state: string;
  requesterId: string;
  targetAgentId: string;
  summary: string | null;
  output: string | null;
  error: string | null;
  labels: string[];
  conversationId: string | null;
  messageId: string | null;
  workId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  lastActivityAt: number | null;
};

export type ScoutLabelBriefWorkItem = {
  id: string;
  title: string;
  state: string;
  ownerId: string | null;
  nextMoveOwnerId: string | null;
  summary: string | null;
  labels: string[];
  updatedAt: number;
};

export type ScoutLabelBrief = {
  label: string;
  generatedAt: number;
  lastActivityAt: number | null;
  participants: string[];
  counts: {
    flights: number;
    activeFlights: number;
    workItems: number;
  };
  flightsByState: Record<string, number>;
  activeFlights: ScoutLabelBriefFlight[];
  recentFlights: ScoutLabelBriefFlight[];
  workItems: ScoutLabelBriefWorkItem[];
};

export type ScoutLabelFeedEventKind =
  | "message"
  | "invocation_created"
  | "flight_started"
  | "flight_state"
  | "flight_completed"
  | "flight_failed"
  | "flight_cancelled"
  | "work_event"
  | "work_snapshot";

export type ScoutLabelFeedEvent = {
  id: string;
  label: string;
  at: number;
  kind: ScoutLabelFeedEventKind;
  category: "message" | "invocation" | "flight" | "work";
  actorId: string | null;
  targetAgentId: string | null;
  conversationId: string | null;
  messageId: string | null;
  invocationId: string | null;
  flightId: string | null;
  workId: string | null;
  state: string | null;
  eventKind: string | null;
  summary: string;
  labels: string[];
};

export type ScoutLabelFeedOptions = {
  since?: number | null;
  limit?: number | null;
};

export type ScoutLabelFeed = {
  label: string;
  generatedAt: number;
  cursor: string | null;
  since: number | null;
  counts: {
    events: number;
    messages: number;
    invocations: number;
    flights: number;
    workEvents: number;
  };
  events: ScoutLabelFeedEvent[];
};

export type ScoutInvocationSnapshot = {
  invocationId: string;
  invocation: ScoutBrokerInvocationRecord | null;
  flight: ScoutFlightRecord | null;
  deliveries: unknown[];
  dispatches: ScoutDispatchRecord[];
};

export type ScoutWaitResolution =
  | {
      found: true;
      input: string;
      kind: "invocation" | "flight" | "message" | "ref";
      invocationId: string;
      flightId: string | null;
      messageId: string | null;
      bindingRef: string | null;
    }
  | {
      found: false;
      input: string;
      candidates: string[];
    };

export type ScoutAskResult = {
  usedBroker: boolean;
  flight?: ScoutFlightRecord;
  conversationId?: string;
  messageId?: string;
  bindingRef?: string;
  sessionAlias?: string;
  executionResolution?: import("@openscout/protocol").ScoutExecutionResolution;
  workItem?: ScoutTrackedWorkItem;
  unresolvedTarget?: string;
  targetDiagnostic?: ScoutAskTargetDiagnostic;
  preflightFailure?: {
    reason: ScoutBrokerReadFailureReason;
    detail: string;
  };
};

export type ScoutAskByIdResult = {
  usedBroker: boolean;
  flight?: ScoutFlightRecord;
  conversationId?: string;
  messageId?: string;
  workItem?: ScoutTrackedWorkItem;
  unresolvedTargetId?: string;
  targetDiagnostic?: ScoutAskTargetDiagnostic;
};

export type ScoutWorkItemInput = {
  title: string;
  summary?: string;
  priority?: CollaborationPriority;
  labels?: string[];
  parentId?: string;
  acceptanceState?: CollaborationAcceptanceState;
  metadata?: Record<string, unknown>;
};

export type ScoutTrackedWorkItem = {
  id: string;
  title: string;
  summary: string | null;
  state: "open" | "working" | "waiting" | "review" | "done" | "cancelled";
  acceptanceState: CollaborationAcceptanceState;
  ownerId: string | null;
  nextMoveOwnerId: string | null;
  conversationId: string | null;
  priority: CollaborationPriority | null;
};

export type ScoutWorkItemUpdate = {
  workId: string;
  actorId: string;
  title?: string;
  summary?: string | null;
  state?: WorkItemState;
  acceptanceState?: CollaborationAcceptanceState;
  ownerId?: string | null;
  nextMoveOwnerId?: string | null;
  priority?: CollaborationPriority | null;
  labels?: string[];
  waitingOn?: CollaborationWaitingOn | null;
  progress?: CollaborationProgress | null;
  metadata?: Record<string, unknown>;
  eventSummary?: string;
  updatedAtMs?: number;
  source?: string;
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
  nodeId: string | null;
  nodeName: string | null;
  projectRoot: string | null;
  state: AgentState | "discovered";
  messages: number;
  lastSeen: number | null;
  registrationKind: ScoutWhoRegistrationKind;
  /** Route pointers targeting this agent; never separate roster entries. */
  aliases?: Array<Pick<RouteAliasBinding, "id" | "alias" | "revision" | "state" | "scopeProjectKey" | "scopeProjectRoot" | "scopeNodeId" | "target">>;
};

type RelayConfig = {
  channels?: Record<string, { audio: boolean; voice?: string }>;
  defaultVoice?: string;
  pronunciations?: Record<string, string>;
  openaiApiKey?: string;
};

const LEGACY_SCOUT_DIRECT_CONVERSATION_ID = "channel.shared";
const OPERATOR_ID = "operator";
function relayHubDirectory(): string {
  return resolveOpenScoutSupportPaths().relayHubDirectory;
}

export function resolveScoutBrokerUrl(): string {
  const explicit = process.env.OPENSCOUT_BROKER_URL?.trim();
  if (explicit) return explicit;
  return resolveScoutBrokerControlUrl();
}

export function parseScoutHarness(
  value?: string | null,
): AgentHarness | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (SUPPORTED_SCOUT_HARNESSES.includes(trimmed as AgentHarness)) {
    return trimmed as AgentHarness;
  }
  throw new Error(
    `Unsupported harness "${trimmed}". Use one of: ${SUPPORTED_SCOUT_HARNESSES.join(", ")}`,
  );
}

export function parseScoutLocalHarness(
  value?: string | null,
): AgentHarness | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (SUPPORTED_LOCAL_AGENT_HARNESSES.includes(trimmed as AgentHarness)) {
    return trimmed as AgentHarness;
  }
  throw new Error(
    `Unsupported local agent harness "${trimmed}". Use one of: ${SUPPORTED_LOCAL_AGENT_HARNESSES.join(", ")}`,
  );
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

function displayNameForBrokerActor(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
): string {
  if (actorId === OPERATOR_ID) {
    return resolveOperatorName();
  }

  return (
    snapshot.agents[actorId]?.displayName ??
    snapshot.actors[actorId]?.displayName ??
    titleCaseName(
      metadataString(snapshot.agents[actorId]?.metadata, "definitionId") ||
        actorId,
    )
  );
}

function firstEndpointForActor(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
): ScoutBrokerEndpointRecord | undefined {
  return Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === actorId)
    .sort((lhs, rhs) => lhs.id.localeCompare(rhs.id))[0];
}

function buildScoutReturnAddress(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  options: {
    conversationId?: string;
    replyToMessageId?: string;
    sessionId?: string;
  } = {},
): ScoutReturnAddress {
  const agent = snapshot.agents[actorId];
  const actor = snapshot.actors[actorId];
  const endpoint = firstEndpointForActor(snapshot, actorId);
  const selector =
    agent?.selector?.trim() ||
    metadataString(agent?.metadata, "selector") ||
    metadataString(actor?.metadata, "selector");
  const defaultSelector =
    agent?.defaultSelector?.trim() ||
    metadataString(agent?.metadata, "defaultSelector") ||
    metadataString(actor?.metadata, "defaultSelector");
  const projectRoot =
    endpoint?.projectRoot ??
    endpoint?.cwd ??
    metadataString(agent?.metadata, "projectRoot") ??
    metadataString(actor?.metadata, "projectRoot");

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
    sessionId: options.sessionId ?? endpoint?.sessionId,
  });
}

function sanitizeConversationSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-") || "shared"
  );
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function clientMessageMetadata(
  clientMessageId: string | null | undefined,
): Record<string, string> {
  const normalized =
    typeof clientMessageId === "string" ? clientMessageId.trim() : "";
  return normalized ? { clientMessageId: normalized } : {};
}

function deliveryRequestId(
  clientMessageId: string | null | undefined,
  createdAt: number,
): string {
  const normalized =
    typeof clientMessageId === "string" ? clientMessageId.trim() : "";
  if (!normalized) {
    return `deliver-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `deliver-client-${digest}`;
}

function metadataStringList(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter(Boolean);
}

function metadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeSingleScoutLabel(label: string): string {
  return label.trim();
}

function normalizeLabelList(labels: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels ?? []) {
    const trimmed = normalizeSingleScoutLabel(label);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function labelListIncludes(labels: string[], label: string): boolean {
  return Boolean(label) && labels.includes(label);
}

function labelsForMessage(message: ScoutBrokerMessageRecord): string[] {
  return normalizeLabelList([
    ...metadataStringList(message.metadata, "labels"),
  ]);
}

function messageWorkId(message: ScoutBrokerMessageRecord): string | undefined {
  return metadataString(message.metadata, "workId")
    ?? metadataString(message.metadata, "collaborationRecordId");
}

function labelsForFlight(
  flight: ScoutFlightRecord,
  invocation: ScoutBrokerInvocationRecord | undefined,
  workRecord: ScoutBrokerCollaborationRecord | undefined,
): string[] {
  return normalizeLabelList([
    ...(flight.labels ?? []),
    ...metadataStringList(flight.metadata, "labels"),
    ...(invocation?.labels ?? []),
    ...metadataStringList(invocation?.metadata, "labels"),
    ...(workRecord?.labels ?? []),
  ]);
}

function flightWorkId(
  flight: ScoutFlightRecord,
  invocation: ScoutBrokerInvocationRecord | undefined,
): string | undefined {
  return invocation?.collaborationRecordId
    ?? metadataString(flight.metadata, "workId")
    ?? metadataString(flight.metadata, "collaborationRecordId")
    ?? metadataString(invocation?.metadata, "workId")
    ?? metadataString(invocation?.metadata, "collaborationRecordId");
}

function flightConversationId(
  flight: ScoutFlightRecord,
  invocation: ScoutBrokerInvocationRecord | undefined,
): string | null {
  return invocation?.conversationId
    ?? metadataString(flight.metadata, "conversationId")
    ?? null;
}

function flightMessageId(
  flight: ScoutFlightRecord,
  invocation: ScoutBrokerInvocationRecord | undefined,
): string | null {
  return invocation?.messageId
    ?? metadataString(flight.metadata, "messageId")
    ?? null;
}

function flightLastActivityAt(
  flight: ScoutFlightRecord,
  invocation: ScoutBrokerInvocationRecord | undefined,
): number | null {
  return flight.completedAt
    ?? flight.startedAt
    ?? invocation?.createdAt
    ?? null;
}

function isActiveLabelFlightState(state: string): boolean {
  return state === "queued" || state === "waking" || state === "running" || state === "waiting";
}

function matchingWorkIdsForLabel(
  snapshot: ScoutBrokerSnapshot,
  label: string,
): string[] {
  const normalizedLabel = normalizeSingleScoutLabel(label);
  const workIds = new Set<string>();

  for (const record of Object.values(snapshot.collaborationRecords ?? {})) {
    if (record.kind === "work_item" && labelListIncludes(normalizeLabelList(record.labels), normalizedLabel)) {
      workIds.add(record.id);
    }
  }

  for (const invocation of Object.values(snapshot.invocations ?? {}) as ScoutBrokerInvocationRecord[]) {
    const labels = normalizeLabelList([
      ...(invocation.labels ?? []),
      ...metadataStringList(invocation.metadata, "labels"),
    ]);
    if (invocation.collaborationRecordId && labelListIncludes(labels, normalizedLabel)) {
      workIds.add(invocation.collaborationRecordId);
    }
  }

  for (const flight of Object.values(snapshot.flights ?? {}) as ScoutFlightRecord[]) {
    const invocation = snapshot.invocations?.[flight.invocationId] as ScoutBrokerInvocationRecord | undefined;
    const workId = flightWorkId(flight, invocation);
    const labels = labelsForFlight(
      flight,
      invocation,
      workId ? snapshot.collaborationRecords?.[workId] : undefined,
    );
    if (workId && labelListIncludes(labels, normalizedLabel)) {
      workIds.add(workId);
    }
  }

  for (const message of Object.values(snapshot.messages ?? {}) as ScoutBrokerMessageRecord[]) {
    const workId = messageWorkId(message);
    if (workId && labelListIncludes(labelsForMessage(message), normalizedLabel)) {
      workIds.add(workId);
    }
  }

  return [...workIds].sort((left, right) => left.localeCompare(right));
}

function metadataBoolean(
  metadata: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return metadata?.[key] === true;
}

function isSupersededBrokerAgent(
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

async function brokerReadJson<T>(baseUrl: string, path: string, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const direct = await maybeReadJsonFromActiveScoutBrokerService<T>(
    baseUrl,
    path,
  );
  if (direct.handled) {
    return direct.value;
  }

  return requestScoutBrokerJson<T>(baseUrl, path, {
    signal,
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
  });
}

type BrokerPostJsonOptions<T> = {
  acceptErrorJson?: (value: unknown) => value is T;
  signal?: AbortSignal;
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
    { signal: options.signal },
  );
  if (direct.handled) {
    return direct.value;
  }

  return requestScoutBrokerJson<T>(baseUrl, path, {
    method: "POST",
    body,
    acceptErrorJson: options.acceptErrorJson,
    signal: options.signal,
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
  });
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
  body: unknown,
): Promise<ScoutDeliverResponse> {
  return brokerPostJson<ScoutDeliverResponse>(
    baseUrl,
    scoutBrokerPaths.v1.deliver,
    body,
    { acceptErrorJson: isScoutDeliverResponse },
  );
}

export async function matchScoutRendezvous(
  request: ScoutRendezvousRequest,
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutRendezvousResponse> {
  const requestedWaitMs = request.action === "join"
    ? request.waitMs ?? SCOUT_RENDEZVOUS_MAX_WAIT_MS
    : 0;
  const requestTimeoutMs = Math.max(30_000, requestedWaitMs + 5_000);
  return brokerPostJson<ScoutRendezvousResponse>(
    baseUrl,
    scoutBrokerPaths.v1.rendezvousMatch,
    request,
    {
      signal: AbortSignal.timeout(requestTimeoutMs),
      acceptErrorJson: (value): value is ScoutRendezvousResponse =>
        Boolean(
          value
          && typeof value === "object"
          && isScoutRendezvousFailureResponse(value as ScoutRendezvousResponse),
        ),
    },
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

function routeTargetForTargetLabel(
  targetLabel: string,
  targetRef?: string,
  aliasScope?: RouteAliasScope,
): { target: ScoutRouteTarget; renderedTarget: string; isBindingRef: boolean } {
  const requestedTargetRef = targetRef?.trim()
    || (targetLabel.trim().startsWith("ref:") ? targetLabel.trim().slice("ref:".length) : "");
  if (requestedTargetRef) {
    return {
      target: { kind: "binding_ref", ref: requestedTargetRef },
      renderedTarget: `ref:${requestedTargetRef}`,
      isBindingRef: true,
    };
  }

  const parsed = parseScoutComposerRouteTarget(targetLabel);
  if (parsed?.kind === "route_alias") {
    return {
      target: { ...parsed, ...(aliasScope ? { scope: aliasScope } : {}) },
      renderedTarget: parsed.value ?? targetLabel.trim(),
      isBindingRef: false,
    };
  }
  if (
    parsed?.kind === "target_handle"
    || parsed?.kind === "binding_ref"
    || parsed?.kind === "session_id"
  ) {
    return {
      target: parsed,
      renderedTarget: parsed.value ?? targetLabel.trim(),
      isBindingRef: parsed.kind === "binding_ref",
    };
  }

  return {
    target: { kind: "agent_label", label: targetLabel },
    renderedTarget: targetLabel,
    isBindingRef: false,
  };
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
): Promise<ScoutBrokerHealthState> {
  const checkedAt = Date.now();
  try {
    const direct = await maybeReadJsonFromActiveScoutBrokerService<ScoutBrokerHealthPayload>(
      baseUrl,
      scoutBrokerPaths.health,
    );
    const healthResult = direct.handled
      ? {
          health: direct.value,
          transport: "in_process" as const,
          socketPath: null,
          socketFallbackError: null,
        }
      : await (async () => {
          const result = await requestScoutBrokerJsonWithTrace<ScoutBrokerHealthPayload>(baseUrl, scoutBrokerPaths.health, {
            socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
          });
          return {
            health: result.value,
            transport: result.trace.transport,
            socketPath: result.trace.socketPath ?? null,
            socketFallbackError: result.trace.socketFallbackError ?? null,
          };
        })();
    const health = healthResult.health;

    return {
      baseUrl,
      reachable: true,
      ok: Boolean(health.ok),
      checkedAt,
      transport: healthResult.transport,
      socketPath: healthResult.socketPath,
      socketFallbackError: healthResult.socketFallbackError,
      nodeId: health.nodeId ?? null,
      meshId: health.meshId ?? null,
      build: health.build ?? null,
      services: health.services ?? null,
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
    };
  } catch (error) {
    return {
      baseUrl,
      reachable: false,
      ok: false,
      checkedAt,
      transport: null,
      socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
      socketFallbackError: null,
      nodeId: null,
      meshId: null,
      build: null,
      services: null,
      counts: null,
      error: error instanceof Error ? error.message : null,
    };
  }
}

export async function readScoutBrokerHome(
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutBrokerHomePayload | null> {
  try {
    return await brokerReadJson<ScoutBrokerHomePayload>(
      baseUrl,
      scoutBrokerPaths.v1.home,
    );
  } catch {
    return null;
  }
}

export type ScoutBrokerReadFailureReason =
  | "health_failed"
  | "node_read_failed"
  | "snapshot_read_failed";

export type ScoutBrokerSnapshotResult =
  | { ok: true; snapshot: ScoutBrokerSnapshot }
  | { ok: false; reason: "snapshot_read_failed"; detail: string };

function scoutBrokerReadErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readScoutBrokerSnapshotResult(
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutBrokerSnapshotResult> {
  try {
    return {
      ok: true,
      snapshot: await brokerReadJson<ScoutBrokerSnapshot>(
        baseUrl,
        scoutBrokerPaths.v1.snapshot,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "snapshot_read_failed",
      detail: scoutBrokerReadErrorDetail(error),
    };
  }
}

export async function readScoutBrokerSnapshot(
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutBrokerSnapshot | null> {
  const result = await readScoutBrokerSnapshotResult(baseUrl);
  return result.ok ? result.snapshot : null;
}

export async function readScoutCapabilityMatrix(
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutCapabilitySnapshot | null> {
  try {
    return await brokerReadJson<ScoutCapabilitySnapshot>(
      baseUrl,
      scoutBrokerPaths.v1.capabilities,
    );
  } catch {
    return null;
  }
}

export type ScoutRuntimeCatalogSnapshot = {
  schemaVersion: "openscout.runtime-catalog-snapshot.v1";
  catalog: ScoutOwnedRuntimeCatalog;
  source: "remote" | "persisted" | "bundled";
  checkedAt: number;
  nextCheckAt: number;
  url: string;
  warnings: string[];
};

export async function readScoutRuntimeCatalog(
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutRuntimeCatalogSnapshot | null> {
  try {
    return await brokerReadJson<ScoutRuntimeCatalogSnapshot>(
      baseUrl,
      scoutBrokerPaths.v1.runtimeCatalog,
    );
  } catch {
    return null;
  }
}

export async function readScoutLabelBrief(
  label: string,
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutLabelBrief | null> {
  const snapshot = await readScoutBrokerSnapshot(baseUrl);
  return snapshot ? buildScoutLabelBrief(snapshot, label) : null;
}

export async function readScoutLabelFeed(
  label: string,
  options: ScoutLabelFeedOptions = {},
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutLabelFeed | null> {
  const snapshot = await readScoutBrokerSnapshot(baseUrl);
  if (!snapshot) {
    return null;
  }
  const collaborationEvents = await readLabelCollaborationEvents(
    baseUrl,
    snapshot,
    label,
    options.limit,
  );
  return buildScoutLabelFeed(snapshot, label, {
    ...options,
    collaborationEvents,
  });
}

export function buildScoutLabelBrief(
  snapshot: ScoutBrokerSnapshot,
  label: string,
  now = Date.now(),
): ScoutLabelBrief {
  const normalizedLabel = normalizeSingleScoutLabel(label);
  const participants = new Set<string>();
  const matchedFlights: ScoutLabelBriefFlight[] = [];
  const matchedWorkItems: ScoutLabelBriefWorkItem[] = [];
  const matchingWorkIds = new Set<string>();

  for (const record of Object.values(snapshot.collaborationRecords ?? {})) {
    if (record.kind !== "work_item") {
      continue;
    }
    const labels = normalizeLabelList(record.labels);
    if (!labelListIncludes(labels, normalizedLabel)) {
      continue;
    }
    matchingWorkIds.add(record.id);
    if (record.ownerId) participants.add(record.ownerId);
    if (record.nextMoveOwnerId) participants.add(record.nextMoveOwnerId);
    matchedWorkItems.push({
      id: record.id,
      title: record.title,
      state: record.state,
      ownerId: record.ownerId ?? null,
      nextMoveOwnerId: record.nextMoveOwnerId ?? null,
      summary: record.summary ?? null,
      labels,
      updatedAt: record.updatedAt,
    });
  }

  for (const flight of Object.values(snapshot.flights ?? {}) as ScoutFlightRecord[]) {
    const invocation = snapshot.invocations?.[flight.invocationId] as ScoutBrokerInvocationRecord | undefined;
    const workId = flightWorkId(flight, invocation);
    const labels = labelsForFlight(flight, invocation, workId ? snapshot.collaborationRecords?.[workId] : undefined);
    const matchesLabel = labelListIncludes(labels, normalizedLabel)
      || (workId ? matchingWorkIds.has(workId) : false);
    if (!matchesLabel) {
      continue;
    }

    participants.add(flight.requesterId);
    participants.add(flight.targetAgentId);
    matchedFlights.push({
      id: flight.id,
      invocationId: flight.invocationId,
      state: flight.state,
      requesterId: flight.requesterId,
      targetAgentId: flight.targetAgentId,
      summary: flight.summary ?? null,
      output: flight.output ?? null,
      error: flight.error ?? null,
      labels,
      conversationId: flightConversationId(flight, invocation),
      messageId: flightMessageId(flight, invocation),
      workId: workId ?? null,
      startedAt: flight.startedAt ?? null,
      completedAt: flight.completedAt ?? null,
      lastActivityAt: flightLastActivityAt(flight, invocation),
    });
  }

  matchedFlights.sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
  matchedWorkItems.sort((left, right) => right.updatedAt - left.updatedAt);

  const flightsByState: Record<string, number> = {};
  for (const flight of matchedFlights) {
    flightsByState[flight.state] = (flightsByState[flight.state] ?? 0) + 1;
  }

  const activeFlights = matchedFlights.filter((flight) => isActiveLabelFlightState(flight.state));
  const lastActivityAt = [
    ...matchedFlights.map((flight) => flight.lastActivityAt ?? 0),
    ...matchedWorkItems.map((workItem) => workItem.updatedAt),
  ].reduce((max, value) => Math.max(max, value), 0) || null;

  return {
    label: normalizedLabel,
    generatedAt: now,
    lastActivityAt,
    participants: [...participants].sort((left, right) => left.localeCompare(right)),
    counts: {
      flights: matchedFlights.length,
      activeFlights: activeFlights.length,
      workItems: matchedWorkItems.length,
    },
    flightsByState,
    activeFlights: activeFlights.slice(0, 12),
    recentFlights: matchedFlights.slice(0, 12),
    workItems: matchedWorkItems.slice(0, 12),
  };
}

export function buildScoutLabelFeed(
  snapshot: ScoutBrokerSnapshot,
  label: string,
  options: ScoutLabelFeedOptions & { collaborationEvents?: CollaborationEvent[] } = {},
  now = Date.now(),
): ScoutLabelFeed {
  const normalizedLabel = normalizeSingleScoutLabel(label);
  const matchingWorkIds = new Set(matchingWorkIdsForLabel(snapshot, normalizedLabel));
  const events = new Map<string, ScoutLabelFeedEvent>();

  for (const message of Object.values(snapshot.messages ?? {}) as ScoutBrokerMessageRecord[]) {
    const labels = labelsForMessage(message);
    const workId = messageWorkId(message);
    const matchesLabel = labelListIncludes(labels, normalizedLabel)
      || (workId ? matchingWorkIds.has(workId) : false);
    if (!matchesLabel) {
      continue;
    }
    addLabelFeedEvent(events, {
      id: `message:${message.id}`,
      label: normalizedLabel,
      at: message.createdAt,
      kind: "message",
      category: "message",
      actorId: message.actorId,
      targetAgentId: null,
      conversationId: message.conversationId,
      messageId: message.id,
      invocationId: metadataString(message.metadata, "invocationId") ?? null,
      flightId: metadataString(message.metadata, "flightId") ?? null,
      workId: workId ?? null,
      state: null,
      eventKind: message.class,
      summary: compactLabelFeedSummary(message.body),
      labels: labelFeedLabels(labels, normalizedLabel),
    });
  }

  for (const invocation of Object.values(snapshot.invocations ?? {}) as ScoutBrokerInvocationRecord[]) {
    const workRecord = invocation.collaborationRecordId
      ? snapshot.collaborationRecords?.[invocation.collaborationRecordId]
      : undefined;
    const labels = normalizeLabelList([
      ...(invocation.labels ?? []),
      ...metadataStringList(invocation.metadata, "labels"),
      ...(workRecord?.labels ?? []),
    ]);
    const matchesLabel = labelListIncludes(labels, normalizedLabel)
      || (invocation.collaborationRecordId
        ? matchingWorkIds.has(invocation.collaborationRecordId)
        : false);
    if (!matchesLabel) {
      continue;
    }
    addLabelFeedEvent(events, {
      id: `invocation:${invocation.id}`,
      label: normalizedLabel,
      at: invocation.createdAt,
      kind: "invocation_created",
      category: "invocation",
      actorId: invocation.requesterId,
      targetAgentId: invocation.targetAgentId,
      conversationId: invocation.conversationId ?? null,
      messageId: invocation.messageId ?? null,
      invocationId: invocation.id,
      flightId: null,
      workId: invocation.collaborationRecordId ?? null,
      state: null,
      eventKind: invocation.action,
      summary: compactLabelFeedSummary(invocation.task),
      labels: labelFeedLabels(labels, normalizedLabel),
    });
  }

  for (const flight of Object.values(snapshot.flights ?? {}) as ScoutFlightRecord[]) {
    const invocation = snapshot.invocations?.[flight.invocationId] as ScoutBrokerInvocationRecord | undefined;
    const workId = flightWorkId(flight, invocation);
    const labels = labelsForFlight(
      flight,
      invocation,
      workId ? snapshot.collaborationRecords?.[workId] : undefined,
    );
    const matchesLabel = labelListIncludes(labels, normalizedLabel)
      || (workId ? matchingWorkIds.has(workId) : false);
    if (!matchesLabel) {
      continue;
    }
    const conversationId = flightConversationId(flight, invocation);
    const messageId = flightMessageId(flight, invocation);
    const flightSummary = compactLabelFeedSummary(
      flight.summary
        ?? flight.output
        ?? flight.error
        ?? `${flight.targetAgentId} ${flight.state}`,
    );
    if (flight.startedAt) {
      addLabelFeedEvent(events, {
        id: `flight:${flight.id}:started`,
        label: normalizedLabel,
        at: flight.startedAt,
        kind: "flight_started",
        category: "flight",
        actorId: flight.requesterId,
        targetAgentId: flight.targetAgentId,
        conversationId,
        messageId,
        invocationId: flight.invocationId,
        flightId: flight.id,
        workId: workId ?? null,
        state: flight.state,
        eventKind: "started",
        summary: flightSummary,
        labels: labelFeedLabels(labels, normalizedLabel),
      });
    }
    if (flight.completedAt) {
      const kind = terminalFlightLabelEventKind(flight.state);
      addLabelFeedEvent(events, {
        id: `flight:${flight.id}:${flight.state}:${flight.completedAt}`,
        label: normalizedLabel,
        at: flight.completedAt,
        kind,
        category: "flight",
        actorId: flight.requesterId,
        targetAgentId: flight.targetAgentId,
        conversationId,
        messageId,
        invocationId: flight.invocationId,
        flightId: flight.id,
        workId: workId ?? null,
        state: flight.state,
        eventKind: flight.state,
        summary: flightSummary,
        labels: labelFeedLabels(labels, normalizedLabel),
      });
    } else {
      const stateAt = flightLastActivityAt(flight, invocation)
        ?? metadataNumber(flight.metadata, "updatedAt")
        ?? now;
      addLabelFeedEvent(events, {
        id: `flight:${flight.id}:state:${flight.state}:${stateAt}`,
        label: normalizedLabel,
        at: stateAt,
        kind: "flight_state",
        category: "flight",
        actorId: flight.requesterId,
        targetAgentId: flight.targetAgentId,
        conversationId,
        messageId,
        invocationId: flight.invocationId,
        flightId: flight.id,
        workId: workId ?? null,
        state: flight.state,
        eventKind: flight.state,
        summary: flightSummary,
        labels: labelFeedLabels(labels, normalizedLabel),
      });
    }
  }

  const seenWorkEventRecordIds = new Set<string>();
  for (const event of options.collaborationEvents ?? []) {
    if (!matchingWorkIds.has(event.recordId)) {
      continue;
    }
    seenWorkEventRecordIds.add(event.recordId);
    const record = snapshot.collaborationRecords?.[event.recordId];
    const labels = normalizeLabelList(record?.labels);
    addLabelFeedEvent(events, {
      id: `work-event:${event.id}`,
      label: normalizedLabel,
      at: event.at,
      kind: "work_event",
      category: "work",
      actorId: event.actorId,
      targetAgentId: record?.nextMoveOwnerId ?? record?.ownerId ?? null,
      conversationId: record?.conversationId ?? null,
      messageId: metadataString(event.metadata, "messageId") ?? null,
      invocationId: metadataString(event.metadata, "invocationId") ?? null,
      flightId: metadataString(event.metadata, "flightId") ?? null,
      workId: event.recordId,
      state: record && "state" in record ? record.state : null,
      eventKind: event.kind,
      summary: compactLabelFeedSummary(event.summary ?? record?.summary ?? record?.title ?? event.kind),
      labels: labelFeedLabels(labels, normalizedLabel),
    });
  }

  for (const workId of matchingWorkIds) {
    if (seenWorkEventRecordIds.has(workId)) {
      continue;
    }
    const record = snapshot.collaborationRecords?.[workId];
    if (!record?.kind || record.kind !== "work_item") {
      continue;
    }
    addLabelFeedEvent(events, {
      id: `work:${record.id}:snapshot:${record.updatedAt}`,
      label: normalizedLabel,
      at: record.updatedAt,
      kind: "work_snapshot",
      category: "work",
      actorId: record.nextMoveOwnerId ?? record.ownerId ?? record.createdById,
      targetAgentId: record.nextMoveOwnerId ?? record.ownerId ?? null,
      conversationId: record.conversationId ?? null,
      messageId: null,
      invocationId: null,
      flightId: null,
      workId: record.id,
      state: record.state,
      eventKind: record.state,
      summary: compactLabelFeedSummary(record.progress?.summary ?? record.summary ?? record.title),
      labels: labelFeedLabels(record.labels ?? [], normalizedLabel),
    });
  }

  const since = typeof options.since === "number" && Number.isFinite(options.since)
    ? options.since
    : null;
  let sorted = [...events.values()]
    .filter((event) => since === null || event.at > since)
    .sort((left, right) => {
      const timeDelta = left.at - right.at;
      if (timeDelta !== 0) return timeDelta;
      return left.id.localeCompare(right.id);
    });
  const limit = typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : null;
  if (limit !== null && sorted.length > limit) {
    sorted = sorted.slice(-limit);
  }
  const cursor = sorted.at(-1)?.id ?? null;

  return {
    label: normalizedLabel,
    generatedAt: now,
    cursor,
    since,
    counts: {
      events: sorted.length,
      messages: sorted.filter((event) => event.category === "message").length,
      invocations: sorted.filter((event) => event.category === "invocation").length,
      flights: sorted.filter((event) => event.category === "flight").length,
      workEvents: sorted.filter((event) => event.category === "work").length,
    },
    events: sorted,
  };
}

function addLabelFeedEvent(
  events: Map<string, ScoutLabelFeedEvent>,
  event: ScoutLabelFeedEvent,
): void {
  events.set(event.id, event);
}

function labelFeedLabels(labels: string[], label: string): string[] {
  return normalizeLabelList([...labels, label]);
}

function terminalFlightLabelEventKind(state: string): ScoutLabelFeedEventKind {
  if (state === "failed") return "flight_failed";
  if (state === "cancelled") return "flight_cancelled";
  return "flight_completed";
}

function compactLabelFeedSummary(value: string | null | undefined): string {
  const normalized = value
    ?.replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "(no summary)";
  }
  return normalized.length <= 220
    ? normalized
    : `${normalized.slice(0, 217)}...`;
}

async function readLabelCollaborationEvents(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  label: string,
  limit: number | null | undefined,
): Promise<CollaborationEvent[]> {
  const recordIds = matchingWorkIdsForLabel(snapshot, label);
  if (recordIds.length === 0) {
    return [];
  }

  const perRecordLimit = Math.max(
    20,
    Math.min(100, Math.ceil((limit ?? 50) / Math.max(1, Math.min(recordIds.length, 10)))),
  );
  const eventLists = await Promise.all(
    recordIds.map(async (recordId) => {
      const search = new URLSearchParams({
        recordId,
        limit: String(perRecordLimit),
      });
      try {
        return await brokerReadJson<CollaborationEvent[]>(
          baseUrl,
          `${scoutBrokerPaths.v1.collaborationEvents}?${search.toString()}`,
        );
      } catch {
        return [];
      }
    }),
  );
  return eventLists.flat();
}

export type ScoutBrokerContextResult =
  | { ok: true; context: ScoutBrokerContext }
  | { ok: false; reason: ScoutBrokerReadFailureReason; detail: string };

export async function loadScoutBrokerContextResult(
  baseUrl = resolveScoutBrokerUrl(),
  options: { scope?: "agents" | "conversations" | "identity" } = {},
): Promise<ScoutBrokerContextResult> {
  const health = await readScoutBrokerHealth(baseUrl);
  if (!health.reachable || !health.ok) {
    return {
      ok: false,
      reason: "health_failed",
      detail: health.error ?? `broker health check failed at ${baseUrl}`,
    };
  }

  const snapshotPath = options.scope
    ? `${scoutBrokerPaths.v1.snapshot}?scope=${options.scope}`
    : scoutBrokerPaths.v1.snapshot;
  const [nodeResult, snapshotResult] = await Promise.all([
    brokerReadJson<ScoutBrokerNodeRecord>(baseUrl, scoutBrokerPaths.v1.node).then(
      (node) => ({ ok: true as const, node }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    brokerReadJson<ScoutBrokerSnapshot>(baseUrl, snapshotPath).then(
      (snapshot) => ({ ok: true as const, snapshot }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  if (!nodeResult.ok || !nodeResult.node.id) {
    return {
      ok: false,
      reason: "node_read_failed",
      detail: nodeResult.ok
        ? `${scoutBrokerPaths.v1.node} returned no node id`
        : scoutBrokerReadErrorDetail(nodeResult.error),
    };
  }
  if (!snapshotResult.ok) {
    return {
      ok: false,
      reason: "snapshot_read_failed",
      detail: scoutBrokerReadErrorDetail(snapshotResult.error),
    };
  }
  return {
    ok: true,
    context: { baseUrl, node: nodeResult.node, snapshot: snapshotResult.snapshot },
  };
}

export async function loadScoutBrokerContext(
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutBrokerContext | null> {
  const result = await loadScoutBrokerContextResult(baseUrl);
  return result.ok ? result.context : null;
}

export async function requireScoutBrokerContext(
  baseUrl = resolveScoutBrokerUrl(),
): Promise<ScoutBrokerContext> {
  const context = await loadScoutBrokerContext(baseUrl);
  if (!context) {
    throw new Error(
      `Broker is not reachable at ${baseUrl}. Run scout setup first.`,
    );
  }
  return context;
}

export function scoutConversationIdForChannel(channel?: string): string {
  const channelName = scoutChannelName(channel);
  return stableChannelId(scoutChannelNaturalKey(channelName));
}

function scoutChannelName(channel?: string): string {
  const sanitized = sanitizeConversationSegment(channel?.trim() || "shared");
  const name = sanitized.startsWith("channel.")
    ? sanitized.slice("channel.".length) || "shared"
    : sanitized;
  return name === "shared" ? "broadcast" : name;
}

function scoutChannelNaturalKey(channelName: string): string {
  return channelName === "system"
    ? systemChannelNaturalKey(channelName)
    : namedChannelNaturalKey(channelName);
}

function buildMentionCandidate(
  snapshot: ScoutBrokerSnapshot,
  agent: AgentDefinition,
): AgentSelectorCandidate {
  const endpoints = Object.values(snapshot.endpoints ?? {}).filter(
    (endpoint) => endpoint.agentId === agent.id,
  );
  // Prefer an active endpoint's harness for disambiguation; fall back to the first registered.
  const preferred =
    endpoints.find((endpoint) => endpoint.state === "active") ??
    endpoints.find(
      (endpoint) => endpoint.state === "idle" || endpoint.state === "waiting",
    ) ??
    endpoints[0];
  const harness =
    preferred?.harness ??
    metadataString(agent.metadata, "harness") ??
    metadataString(agent.metadata, "defaultHarness");
  const profile = metadataString(agent.metadata, "profile");
  const model =
    metadataString(preferred?.metadata, "model") ??
    metadataString(agent.metadata, "model");
  return {
    agentId: agent.id,
    definitionId: agent.definitionId || metadataString(agent.metadata, "definitionId") || agent.id,
    nodeQualifier: agent.nodeQualifier ?? metadataString(agent.metadata, "nodeQualifier"),
    workspaceQualifier:
      agent.workspaceQualifier ?? metadataString(agent.metadata, "workspaceQualifier"),
    ...(harness ? { harness } : {}),
    ...(profile ? { profile } : {}),
    ...(model ? { model } : {}),
    aliases: [
      agent.selector,
      agent.defaultSelector,
      metadataString(agent.metadata, "selector"),
      metadataString(agent.metadata, "defaultSelector"),
    ].filter(Boolean) as string[],
  };
}

function formatBrokerTargetLabel(
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
  const candidate = buildMentionCandidate(snapshot, current);

  return formatMinimalAgentIdentity(candidate, candidates);
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
  const formattedLabel = formatBrokerTargetLabel(snapshot, agentId);
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
  const resolvedLabel = formatBrokerTargetLabel(snapshot, agentId);
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
  const endpointBackedAgentIds = [
    ...new Set(
      Object.values(snapshot.endpoints)
        .map((endpoint) => endpoint.agentId)
        .filter((agentId) => (
          agentId
          && agentId !== OPERATOR_ID
          && !isSupersededBrokerAgent(snapshot, agentId)
        )),
    ),
  ];

  for (const agent of Object.values(snapshot.agents)) {
    if (isSupersededBrokerAgent(snapshot, agent.id)) {
      continue;
    }
    candidateMap.set(agent.id, buildMentionCandidate(snapshot, agent));
  }

  for (const selector of selectors) {
    if (selector.definitionId === "system") continue;

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
        aliases: [
          discovered.instance.selector,
          discovered.instance.defaultSelector,
        ],
      });
    }

    const candidates = Array.from(candidateMap.values());
    if (selector.definitionId === "all") {
      const targetAgentIds =
        endpointBackedAgentIds.length > 0
          ? endpointBackedAgentIds
          : candidates.map((candidate) => candidate.agentId);
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
    resolved: Array.from(resolved.values()).sort((lhs, rhs) =>
      lhs.agentId.localeCompare(rhs.agentId),
    ),
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
  const endpoints = Object.values(snapshot.endpoints ?? {}).filter(
    (endpoint) => endpoint.agentId === target.agentId,
  );

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
    state:
      snapshot.agents[target.agentId] || registrationKind === "configured"
        ? "offline"
        : "unknown",
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
    return Boolean(
      participant?.authorityNodeId && participant.authorityNodeId !== nodeId,
    );
  });
  return hasRemoteParticipant ? "shared" : fallback;
}

export function stripScoutAgentSelectorLabels(text: string): string {
  return extractAgentSelectors(text)
    .reduce(
      (next, selector) =>
        [selector.label, `@${selector.raw}`]
          .reduce((value, label) => value.replaceAll(label, ""), next)
          .replace(/\s{2,}/g, " ")
          .trim(),
      text,
    )
    .trim();
}

async function ensureBrokerActor(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  displayName?: string,
): Promise<void> {
  const resolvedDisplayName = actorId === OPERATOR_ID
    ? displayName?.trim() || resolveOperatorName()
    : displayName?.trim() || titleCaseName(actorId);
  const existingActor = snapshot.actors[actorId];
  if (existingActor || snapshot.agents[actorId]) {
    if (actorId === OPERATOR_ID
      && existingActor
      && existingActor.displayName !== resolvedDisplayName) {
      const actor: ScoutBrokerActorRecord = {
        ...existingActor,
        kind: "person",
        displayName: resolvedDisplayName,
        handle: existingActor.handle || actorId,
        labels: existingActor.labels ?? ["scout"],
        metadata: existingActor.metadata ?? { source: "scout-cli" },
      };
      await brokerPostJson(baseUrl, scoutBrokerPaths.v1.actors, actor);
      snapshot.actors[actorId] = actor;
    }
    return;
  }
  const actor: ScoutBrokerActorRecord = {
    id: actorId,
    kind: actorId === OPERATOR_ID ? "person" : "agent",
    displayName: resolvedDisplayName,
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
    await brokerPostJson(
      baseUrl,
      scoutBrokerPaths.v1.endpoints,
      binding.endpoint,
    );
    snapshot.endpoints[binding.endpoint.id] = binding.endpoint;
  }
}

export function scoutBrokerAgentRegistrationFromConfig(
  config: ResolvedRelayAgentConfig,
  nodeId: string,
): { actor: ScoutBrokerActorRecord; agent: ScoutBrokerAgentRecord } {
  const source =
    config.source === "inferred" ? "project-inferred" : "relay-agent-registry";
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
  registration: {
    actor: ScoutBrokerActorRecord;
    agent: ScoutBrokerAgentRecord;
  },
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
  const broker = input.broker ?? (await loadScoutBrokerContext());
  const nodeId = broker?.node.id ?? process.env.OPENSCOUT_NODE_ID ?? "local";
  const { inferLocalAgentBinding } = await import("@openscout/runtime/local-agents");
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

  const { inferLocalAgentBinding } = await import("@openscout/runtime/local-agents");
  const binding = await inferLocalAgentBinding(configured.agentId, nodeId);
  if (binding) {
    await syncBrokerBinding(baseUrl, snapshot, binding);
    return binding.actor.id;
  }

  // Auto-register the agent in the broker even without a running session.
  // This gives Claude Code / Codex / Pi sessions an identity card automatically
  // when they send from a project directory — no explicit setup step needed.
  await syncBrokerAgentRegistration(
    baseUrl,
    snapshot,
    scoutBrokerAgentRegistrationFromConfig(configured, nodeId),
  );
  return configured.agentId;
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
    )
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
  if (isReusableBrokerRegisteredTargetAgent(existingAgent)) {
    return true;
  }
  const configured = await ensureRelayAgentConfigured(agentId, {
    currentDirectory,
    syncLegacyMirror: true,
  });
  if (!configured) {
    return false;
  }

  const { inferLocalAgentBinding } = await import("@openscout/runtime/local-agents");
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

  for (const error of setup.projectErrors) {
    console.warn(`[scout] quarantined project ${error.relativePath}: ${error.message}`);
  }

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
  const normalizedChannel = scoutChannelName(requestedChannel);
  const naturalKey = scoutChannelNaturalKey(normalizedChannel);
  const broadcastParticipants = normalizedChannel === "broadcast" ? [
    ...new Set([OPERATOR_ID, senderId, ...Object.values(snapshot.endpoints)
      .filter((endpoint) => endpoint.state !== "offline" && snapshot.agents[endpoint.agentId])
      .map((endpoint) => endpoint.agentId)]),
  ].sort() : [];
  const scopedParticipants = [
    ...new Set([OPERATOR_ID, senderId, ...targetParticipantIds]),
  ].sort();

  if (normalizedChannel === "voice") {
    return {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: "voice",
      visibility: "workspace",
      shareMode: resolveConversationShareMode(
        snapshot,
        nodeId,
        scopedParticipants,
        "local",
      ),
      authorityNodeId: nodeId,
      participantIds: scopedParticipants,
      metadata: { surface: "scout-cli", channel: "voice", naturalKey },
    };
  }
  if (normalizedChannel === "system") {
    return {
      id: stableChannelId(naturalKey),
      kind: "system",
      title: "system",
      visibility: "system",
      shareMode: "local",
      authorityNodeId: nodeId,
      participantIds: [OPERATOR_ID, senderId].sort(),
      metadata: { surface: "scout-cli", channel: "system", naturalKey },
    };
  }
  if (normalizedChannel === "broadcast") {
    return {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: "broadcast",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: nodeId,
      participantIds: broadcastParticipants,
      metadata: { surface: "scout-cli", channel: "broadcast", naturalKey },
    };
  }
  return {
    id: stableChannelId(naturalKey),
    kind: "channel",
    title: normalizedChannel,
    visibility: "workspace",
    shareMode: resolveConversationShareMode(
      snapshot,
      nodeId,
      scopedParticipants,
      "local",
    ),
    authorityNodeId: nodeId,
    participantIds: scopedParticipants,
    metadata: { surface: "scout-cli", channel: normalizedChannel, naturalKey },
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
  const definition = conversationDefinition(
    snapshot,
    nodeId,
    channel,
    senderId,
    targetParticipantIds,
  );
  const existing = snapshot.conversations[definition.id];
  const naturalKey = conversationNaturalKey(definition);
  const equivalentConversations = naturalKey
    ? conversationsWithNaturalKey(Object.values(snapshot.conversations), naturalKey)
    : [];
  const nextParticipants = definition.metadata?.channel === "broadcast" ? definition.participantIds : [
    ...new Set([
      ...equivalentConversations.flatMap((conversation) => conversation.participantIds),
      ...definition.participantIds,
    ]),
  ].sort();

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
    await brokerPostJson(
      baseUrl,
      scoutBrokerPaths.v1.conversations,
      nextConversation,
    );
    snapshot.conversations[nextConversation.id] = nextConversation;
    return nextConversation;
  }

  return existing;
}

function directConversationIdForActors(
  sourceId: string,
  targetId: string,
): string {
  if (sourceId === targetId) {
    return `dm.${sourceId}.${targetId}`;
  }
  if (sourceId === OPERATOR_ID || targetId === OPERATOR_ID) {
    const peerId = sourceId === OPERATOR_ID ? targetId : sourceId;
    return `dm.${OPERATOR_ID}.${peerId}`;
  }
  return `dm.${[sourceId, targetId].sort().join(".")}`;
}

function relayChannelMetadata(
  conversation: Pick<ScoutBrokerConversationRecord, "kind">,
  explicitChannel?: string,
): string {
  const normalized = explicitChannel?.trim();
  if (normalized) {
    return normalized;
  }
  return conversation.kind === "direct" ? "dm" : "shared";
}

function relayAudienceReason(
  conversation: Pick<ScoutBrokerConversationRecord, "kind">,
): "direct_message" | "mention" {
  return conversation.kind === "direct" ? "direct_message" : "mention";
}

function relayRouteKind(
  conversation: Pick<ScoutBrokerConversationRecord, "id" | "kind" | "metadata">,
): "dm" | "channel" | "broadcast" {
  if (conversation.kind === "direct") {
    return "dm";
  }
  return ["shared", "broadcast"].includes(String(conversation.metadata?.channel)) ? "broadcast" : "channel";
}

function buildScoutEntityId(prefix: string, createdAtMs: number): string {
  return `${prefix}-${createdAtMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTrackedWorkItemSummary(
  record: CollaborationRecord,
): ScoutTrackedWorkItem {
  if (record.kind !== "work_item") {
    throw new Error(
      `expected work_item collaboration record, received ${record.kind}`,
    );
  }

  return {
    id: record.id,
    title: record.title,
    summary: record.summary ?? null,
    state: record.state,
    acceptanceState: record.acceptanceState,
    ownerId: record.ownerId ?? null,
    nextMoveOwnerId: record.nextMoveOwnerId ?? null,
    conversationId: record.conversationId ?? null,
    priority: record.priority ?? null,
  };
}

/** The work id a pinned Codex chat always gets, so pinning twice reuses it. */
export function scoutCodexChatWorkId(threadId: string): string {
  return `work-codex-${threadId}`;
}

export type ScoutCodexChatWork = { workId: string; title: string; created: boolean };

/**
 * A ChatGPT-app Codex chat as Scout work, so a figure can stand for it.
 * Nothing is attached or resumed: the chat keeps its one writer (the app);
 * the work only remembers the thread id (`metadata.codexThreadId`) for Talk
 * and later replies in place. Idempotent per thread.
 */
export async function ensureScoutCodexChatWork(input: {
  threadId: string;
  title: string;
  cwd?: string | null;
  createdAtMs?: number;
}): Promise<ScoutCodexChatWork> {
  const threadId = input.threadId.trim();
  if (!/^[0-9a-f-]{16,64}$/iu.test(threadId)) throw new Error(`not a Codex thread id: ${input.threadId}`);
  const broker = await requireScoutBrokerContext();
  const workId = scoutCodexChatWorkId(threadId);
  const existing = broker.snapshot.collaborationRecords?.[workId];
  if (existing) return { workId, title: existing.title, created: false };

  const createdAt = input.createdAtMs ?? Date.now();
  const title = input.title.trim() || `Codex ${threadId.slice(0, 8)}`;
  const record: CollaborationRecord = {
    id: workId,
    kind: "work_item",
    state: "open",
    acceptanceState: "none",
    title,
    createdById: OPERATOR_ID,
    // The operator drives the chat in the ChatGPT app.
    ownerId: OPERATOR_ID,
    nextMoveOwnerId: OPERATOR_ID,
    requestedById: OPERATOR_ID,
    createdAt,
    updatedAt: createdAt,
    labels: ["codex-chat"],
    metadata: {
      source: "scout-session-pin",
      harness: "codex",
      codexThreadId: threadId,
      ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
    },
  };
  await brokerPostJson(broker.baseUrl, scoutBrokerPaths.v1.collaborationRecords, record);
  const event: CollaborationEvent = {
    id: buildScoutEntityId("evt", createdAt),
    recordId: workId,
    recordKind: "work_item",
    kind: "created",
    actorId: OPERATOR_ID,
    at: createdAt,
    summary: `Pinned the Codex chat “${title}”`,
    metadata: { source: "scout-session-pin" },
  };
  await brokerPostJson(broker.baseUrl, scoutBrokerPaths.v1.collaborationEvents, event);
  return { workId, title, created: true };
}

async function createScoutTrackedWorkItem(input: {
  baseUrl: string;
  senderId: string;
  targetAgentId: string;
  conversationId: string;
  createdAtMs: number;
  source: string;
  workItem: ScoutWorkItemInput;
  recordId?: string;
}): Promise<ScoutTrackedWorkItem> {
  const recordId = input.recordId?.trim() || buildScoutEntityId("work", input.createdAtMs);
  const record: CollaborationRecord = {
    id: recordId,
    kind: "work_item",
    state: "open",
    acceptanceState: input.workItem.acceptanceState ?? "pending",
    title: input.workItem.title.trim(),
    summary: input.workItem.summary?.trim() || undefined,
    createdById: input.senderId,
    ownerId: input.targetAgentId,
    nextMoveOwnerId: input.targetAgentId,
    conversationId: input.conversationId,
    parentId: input.workItem.parentId?.trim() || undefined,
    priority: input.workItem.priority,
    labels: input.workItem.labels?.map((label) => label.trim()).filter(Boolean),
    createdAt: input.createdAtMs,
    updatedAt: input.createdAtMs,
    requestedById: input.senderId,
    metadata: {
      source: input.source,
      ...(input.workItem.metadata ?? {}),
    },
  };

  await brokerPostJson(
    input.baseUrl,
    scoutBrokerPaths.v1.collaborationRecords,
    record,
  );

  const event: CollaborationEvent = {
    id: buildScoutEntityId("evt", input.createdAtMs),
    recordId,
    recordKind: "work_item",
    kind: "created",
    actorId: input.senderId,
    at: input.createdAtMs,
    summary: input.workItem.summary?.trim() || input.workItem.title.trim(),
    metadata: {
      source: input.source,
    },
  };

  await brokerPostJson(
    input.baseUrl,
    scoutBrokerPaths.v1.collaborationEvents,
    event,
  );

  return createTrackedWorkItemSummary(record);
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeWorkItemLabels(
  labels: string[] | undefined,
): string[] | undefined {
  if (!labels) {
    return undefined;
  }
  const normalized = labels.map((label) => label.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWorkItemProgress(
  progress: CollaborationProgress | null | undefined,
): CollaborationProgress | undefined {
  if (!progress) {
    return undefined;
  }

  const normalized: CollaborationProgress = {};
  if (typeof progress.completedSteps === "number") {
    normalized.completedSteps = progress.completedSteps;
  }
  if (typeof progress.totalSteps === "number") {
    normalized.totalSteps = progress.totalSteps;
  }
  if (typeof progress.percent === "number") {
    normalized.percent = progress.percent;
  }
  if (typeof progress.checkpoint === "string" && progress.checkpoint.trim()) {
    normalized.checkpoint = progress.checkpoint.trim();
  }
  if (typeof progress.summary === "string" && progress.summary.trim()) {
    normalized.summary = progress.summary.trim();
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeWorkItemWaitingOn(
  waitingOn: CollaborationWaitingOn | null | undefined,
): CollaborationWaitingOn | undefined {
  if (!waitingOn) {
    return undefined;
  }
  const label = waitingOn.label.trim();
  if (!label) {
    return undefined;
  }
  return {
    ...waitingOn,
    label,
    targetId: normalizeOptionalString(waitingOn.targetId),
  };
}

function deriveWorkItemEventKind(
  previous: WorkItemRecord,
  next: WorkItemRecord,
): CollaborationEventKind {
  if (next.acceptanceState !== previous.acceptanceState) {
    if (next.acceptanceState === "accepted") {
      return "accepted";
    }
    if (next.acceptanceState === "reopened") {
      return "reopened";
    }
  }

  if (next.state !== previous.state) {
    switch (next.state) {
      case "waiting":
        return "waiting";
      case "review":
        return "review_requested";
      case "done":
        return "done";
      case "cancelled":
        return "cancelled";
      case "working":
        return previous.state === "open" ? "claimed" : "progressed";
      case "open":
      default:
        return "progressed";
    }
  }

  if (
    next.ownerId !== previous.ownerId ||
    next.nextMoveOwnerId !== previous.nextMoveOwnerId
  ) {
    return "handoff";
  }

  return "progressed";
}

function summarizeWorkItemUpdate(record: WorkItemRecord): string {
  if (record.progress?.summary?.trim()) {
    return record.progress.summary.trim();
  }
  if (record.summary?.trim()) {
    return record.summary.trim();
  }
  return record.title.trim();
}

function brokerSnapshotWorkItem(
  snapshot: ScoutBrokerSnapshot,
  workId: string,
): WorkItemRecord | null {
  const record = snapshot.collaborationRecords[workId];
  return record?.kind === "work_item" ? record : null;
}

export async function updateScoutWorkItem(
  input: ScoutWorkItemUpdate,
): Promise<ScoutTrackedWorkItem | null> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return null;
  }

  const current = brokerSnapshotWorkItem(broker.snapshot, input.workId.trim());
  if (!current) {
    throw new Error(`unknown work item: ${input.workId}`);
  }

  const updatedAtMs = input.updatedAtMs ?? Date.now();
  const nextState = input.state ?? current.state;
  const nextSummary =
    input.summary === undefined
      ? current.summary
      : (normalizeOptionalString(input.summary) ?? undefined);
  const nextOwnerId =
    input.ownerId === undefined
      ? current.ownerId
      : normalizeOptionalString(input.ownerId);
  const nextMoveOwnerId =
    input.nextMoveOwnerId === undefined
      ? current.nextMoveOwnerId
      : normalizeOptionalString(input.nextMoveOwnerId);
  const nextPriority =
    input.priority === undefined
      ? current.priority
      : (input.priority ?? undefined);
  const nextLabels =
    input.labels === undefined
      ? current.labels
      : normalizeWorkItemLabels(input.labels);
  const nextProgress =
    input.progress === undefined
      ? current.progress
      : normalizeWorkItemProgress(input.progress);
  const waitingOn =
    input.waitingOn === undefined
      ? nextState === "waiting"
        ? current.waitingOn
        : undefined
      : normalizeWorkItemWaitingOn(input.waitingOn);

  const updated: WorkItemRecord = {
    ...current,
    title: normalizeOptionalString(input.title) ?? current.title,
    summary: nextSummary,
    state: nextState,
    acceptanceState: input.acceptanceState ?? current.acceptanceState,
    ownerId: nextOwnerId,
    nextMoveOwnerId: nextMoveOwnerId,
    priority: nextPriority,
    labels: nextLabels,
    waitingOn,
    progress: nextProgress,
    updatedAt: updatedAtMs,
    startedAt:
      current.startedAt ??
      (nextState === "working" ? updatedAtMs : current.startedAt),
    reviewRequestedAt:
      nextState === "review"
        ? (current.reviewRequestedAt ?? updatedAtMs)
        : current.reviewRequestedAt,
    completedAt:
      nextState === "done" || nextState === "cancelled"
        ? (current.completedAt ?? updatedAtMs)
        : current.completedAt,
    metadata: input.metadata
      ? { ...(current.metadata ?? {}), ...input.metadata }
      : current.metadata,
  };

  await brokerPostJson(
    broker.baseUrl,
    scoutBrokerPaths.v1.collaborationRecords,
    updated,
  );

  const event: CollaborationEvent = {
    id: buildScoutEntityId("evt", updatedAtMs),
    recordId: updated.id,
    recordKind: "work_item",
    kind: deriveWorkItemEventKind(current, updated),
    actorId: input.actorId,
    at: updatedAtMs,
    summary:
      normalizeOptionalString(input.eventSummary) ??
      summarizeWorkItemUpdate(updated),
    metadata: {
      source: input.source?.trim() || "scout-mcp",
    },
  };

  await brokerPostJson(
    broker.baseUrl,
    scoutBrokerPaths.v1.collaborationEvents,
    event,
  );

  return createTrackedWorkItemSummary(updated);
}

async function ensureBrokerDirectConversationBetween(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  sourceId: string,
  targetId: string,
): Promise<ScoutDirectSessionResult> {
  const conversationId =
    targetId === SCOUT_AGENT_ID && sourceId === OPERATOR_ID
      ? LEGACY_SCOUT_DIRECT_CONVERSATION_ID
      : directConversationIdForActors(sourceId, targetId);
  const participantIds = [...new Set([sourceId, targetId])].sort();
  const nextShareMode = resolveConversationShareMode(
    snapshot,
    nodeId,
    participantIds,
    "local",
  );
  const existing = snapshot.conversations[conversationId];
  const alreadyMatches =
    existing &&
    existing.kind === "direct" &&
    existing.shareMode === nextShareMode &&
    existing.visibility === "private" &&
    existing.participantIds.join("\u0000") === participantIds.join("\u0000");

  if (alreadyMatches) {
    const preferredTargetId = targetId === OPERATOR_ID ? sourceId : targetId;
    return {
      agent: snapshot.agents[preferredTargetId] ?? snapshot.agents[sourceId],
      conversation: existing,
      existed: true,
    };
  }

  const nonOperatorParticipants = participantIds.filter(
    (participantId) => participantId !== OPERATOR_ID,
  );
  const conversationTitle =
    sourceId === OPERATOR_ID || targetId === OPERATOR_ID
      ? displayNameForBrokerActor(
          snapshot,
          nonOperatorParticipants[0] ?? targetId,
        )
      : `${displayNameForBrokerActor(snapshot, sourceId)} <> ${displayNameForBrokerActor(snapshot, targetId)}`;

  const definition: ScoutBrokerConversationRecord = {
    id: conversationId,
    kind: "direct",
    title:
      targetId === SCOUT_AGENT_ID && sourceId === OPERATOR_ID
        ? "Scout"
        : conversationTitle,
    visibility: "private",
    shareMode: nextShareMode,
    authorityNodeId: nodeId,
    participantIds,
    metadata: {
      surface: "scout",
      ...(targetId === SCOUT_AGENT_ID && sourceId === OPERATOR_ID
        ? { role: "partner" }
        : {}),
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

export async function sendScoutMessage(input: {
  requestId?: string;
  senderId: string;
  body: string;
  targetLabel?: string;
  targetRef?: string;
  channel?: string;
  shouldSpeak?: boolean;
  attachments?: OutgoingAttachmentInput[];
  clientMessageId?: string | null;
  createdAtMs?: number;
  executionHarness?: AgentHarness;
  currentDirectory?: string;
  source?: string;
  wake?: boolean;
  operatorSignal?: ScoutDeliverRequest["operatorSignal"];
  aliasScope?: RouteAliasScope;
}): Promise<ScoutMessagePostResult> {
  const currentDirectory = input.currentDirectory ?? process.cwd();
  const source = input.source?.trim() || "scout-cli";
  const wake = input.wake ?? false;
  const deliveryIntent = wake ? "consult" : "tell";
  const wakeExecution = wake
    ? {
        ...(input.executionHarness ? { harness: input.executionHarness } : {}),
        session: "new" as const,
      }
    : undefined;
  const wakeInvocationMetadata = wake
    ? {
        source,
        sourceIntent: "tell_wake",
      }
    : undefined;

  const requestedTargetLabel = input.targetLabel?.trim();
  const requestedTargetRef = input.targetRef?.trim();
  if (requestedTargetLabel || requestedTargetRef) {
    // Explicit routes are already complete broker commands. Do not fetch and
    // clone the global registry just to post one delivery; the broker owns
    // target resolution and only the caller identity needs local enrichment.
    // The identity scope carries the registered actor rows sender resolution
    // needs — an empty snapshot would synthesize an upsert that replaces the
    // sender's labels/metadata.
    const contextResult = await loadScoutBrokerContextResult(undefined, {
      scope: "identity",
    });
    if (!contextResult.ok) {
      return { usedBroker: false, invokedTargets: [], unresolvedTargets: [] };
    }
    const senderId = await resolveConversationActorId(
      contextResult.context.baseUrl,
      contextResult.context.snapshot,
      contextResult.context.node.id,
      input.senderId,
      currentDirectory,
    );
    const { target, renderedTarget, isBindingRef } = routeTargetForTargetLabel(
      requestedTargetLabel ?? "",
      requestedTargetRef,
      input.aliasScope,
    );
    const delivery = await brokerPostDeliver(contextResult.context.baseUrl, {
      ...(input.requestId ? { requestId: input.requestId } : {}),
      caller: {
        actorId: senderId,
        nodeId: contextResult.context.node.id,
        currentDirectory,
        metadata: { source },
      },
      target,
      targetLabel: renderedTarget,
      body: input.body,
      attachments: normalizeOutgoingAttachments(input.attachments),
      intent: deliveryIntent,
      channel: input.channel,
      speechText: input.shouldSpeak ? stripScoutAgentSelectorLabels(input.body) : undefined,
      execution: wake
        ? {
            ...wakeExecution,
            session: isBindingRef || target.kind === "target_handle" ? "existing" : "new",
          }
        : undefined,
      ensureAwake: wake ? true : undefined,
      messageMetadata: {
        source,
        ...clientMessageMetadata(input.clientMessageId),
        ...(wake ? { wake } : {}),
      },
      invocationMetadata: wakeInvocationMetadata,
      operatorSignal: input.operatorSignal,
    });
    if (delivery.kind !== "delivery") {
      return {
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [renderedTarget],
        targetDiagnostic: scoutTargetDiagnosticFromDeliveryFailure(delivery),
      };
    }
    return {
      usedBroker: true,
      conversationId: delivery.conversation.id,
      messageId: delivery.message.id,
      bindingRef: delivery.receipt?.bindingRef ?? delivery.bindingRef,
      flight: delivery.flight,
      invokedTargets: delivery.targetAgentId ? [delivery.targetAgentId] : [],
      unresolvedTargets: [],
      routeKind: delivery.routeKind,
    };
  }

  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { usedBroker: false, invokedTargets: [], unresolvedTargets: [] };
  }

  const senderId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.senderId,
    currentDirectory,
  );

  // A channel is a complete destination. Package names and other @ text in
  // its body are payload, not additional targets or a request to wake agents.
  const mentionResolution = input.channel
    ? { resolved: [], unresolved: [], ambiguous: [] }
    : await resolveMentionTargets(broker.snapshot, input.body, currentDirectory);
  const selectors = input.channel ? [] : extractAgentSelectors(input.body);

  if (
    selectors.length === 1
    && mentionResolution.resolved.length + mentionResolution.unresolved.length + mentionResolution.ambiguous.length === 1
  ) {
    const targetLabel = selectors[0]!.label;
    const delivery = await brokerPostDeliver(broker.baseUrl, {
      ...(input.requestId ? { requestId: input.requestId } : {}),
      caller: {
        actorId: senderId,
        nodeId: broker.node.id,
        currentDirectory,
        metadata: { source },
      },
      target: {
        kind: "agent_label",
        label: targetLabel,
      },
      targetLabel,
      body: input.body,
      attachments: normalizeOutgoingAttachments(input.attachments),
      intent: deliveryIntent,
      channel: input.channel,
      speechText: input.shouldSpeak ? stripScoutAgentSelectorLabels(input.body) : undefined,
      execution: wakeExecution,
      ensureAwake: wake ? true : undefined,
      messageMetadata: {
        source,
        ...clientMessageMetadata(input.clientMessageId),
        ...(wake ? { wake } : {}),
      },
      invocationMetadata: wakeInvocationMetadata,
      operatorSignal: input.operatorSignal,
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
      routeKind: delivery.routeKind,
    };
  }

  const createdAtMs = input.createdAtMs ?? Date.now();
  const availableTargets = (
    await Promise.all(
      mentionResolution.resolved.map(async (target) =>
        (await ensureTargetRelayAgentRegistered(
          broker.baseUrl,
          broker.snapshot,
          broker.node.id,
          target.agentId,
          currentDirectory,
        ))
          ? target
          : null,
      ),
    )
  ).filter((target): target is ScoutMentionTarget => Boolean(target));

  const validTargets = [
    ...new Set(
      availableTargets
        .map((target) => target.agentId)
        .filter(
          (target) =>
            target !== senderId && Boolean(broker.snapshot.agents[target]),
        ),
    ),
  ].sort();

  const unresolvedTargets = mentionResolution.resolved
    .filter((target) => !validTargets.includes(target.agentId))
    .map((target) => target.label)
    .concat(mentionResolution.unresolved)
    .concat(mentionResolution.ambiguous.map((entry) => entry.label));
  if (unresolvedTargets.length > 0) {
    return { usedBroker: true, invokedTargets: [], unresolvedTargets };
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

  // Route to DM when there's a single mention target. Group delivery must pin
  // a channel explicitly instead of silently drifting into shared.
  let conversation: ScoutBrokerConversationRecord;
  if (validTargets.length === 1 && !input.channel) {
    const dm = await ensureBrokerDirectConversationBetween(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      senderId,
      validTargets[0],
    );
    conversation = dm.conversation;
  } else {
    conversation = await ensureBrokerConversation(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      input.channel,
      senderId,
      validTargets,
    );
  }
  const messageId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const speechText = input.shouldSpeak
    ? stripScoutAgentSelectorLabels(input.body)
    : "";
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
    attachments: normalizeOutgoingAttachments(input.attachments),
    mentions: mentionResolution.resolved
      .filter((target) => validTargets.includes(target.agentId))
      .map((target) => ({ actorId: target.agentId, label: target.label })),
    speech: speechText ? { text: speechText } : undefined,
    audience:
      validTargets.length > 0
        ? { notify: validTargets, reason: relayAudienceReason(conversation) }
        : undefined,
    visibility: conversation.visibility,
    policy: "durable",
    createdAt: createdAtMs,
    metadata: {
      source,
      relayChannel: relayChannelMetadata(conversation, input.channel),
      relayTargetIds: validTargets,
      relayMessageId: messageId,
      ...clientMessageMetadata(input.clientMessageId),
      returnAddress,
    },
  });

  return {
    usedBroker: true,
    conversationId: conversation.id,
    messageId,
    invokedTargets: validTargets,
    unresolvedTargets,
    routeKind: relayRouteKind(conversation),
  };
}

/** Input shape for an attachment supplied by a caller (MCP). */
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
 * A stable message ID makes generated attachment IDs repeatable on retries.
 */
export function normalizeOutgoingAttachments(
  attachments: OutgoingAttachmentInput[] | undefined,
  stableMessageId?: string,
): MessageAttachment[] | undefined {
  if (!attachments?.length) {
    return undefined;
  }
  const normalized: MessageAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const mediaType = attachment?.mediaType?.trim();
    const url = attachment?.url?.trim();
    const blobKey = attachment?.blobKey?.trim();
    if (!mediaType || (!url && !blobKey)) {
      continue;
    }
    normalized.push({
      id: attachment.id?.trim() || (stableMessageId
        ? `att-${createHash("sha256").update(JSON.stringify([stableMessageId, index])).digest("hex")}`
        : `att-${randomUUID()}`),
      mediaType,
      fileName: attachment.fileName?.trim() || undefined,
      url: url || undefined,
      blobKey: blobKey || undefined,
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export async function replyToScoutMessage(input: {
  requestId?: string;
  completion?: ScoutCompletionReply;
  senderId: string;
  body: string;
  conversationId: string;
  replyToMessageId: string;
  shouldSpeak?: boolean;
  attachments?: OutgoingAttachmentInput[];
  clientMessageId?: string | null;
  createdAtMs?: number;
  currentDirectory?: string;
  source?: string;
}): Promise<ScoutReplyPostResult> {
  if (input.completion && !input.requestId?.trim()) {
    throw new Error("Explicit completion replies require a stable requestId; reuse it when retrying.");
  }
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    if (input.completion) throw new Error("Explicit completion reply was not sent: broker context is unavailable; retry with the same requestId.");
    return { usedBroker: false, notifiedActorIds: [] };
  }

  if (input.completion && !broker.node.capabilities?.includes(SCOUT_COMPLETION_CAPABILITY)) {
    throw new Error("Broker does not support explicit-completion/1; upgrade the broker before replying.");
  }

  const conversationId = input.conversationId.trim();
  const replyToMessageId = input.replyToMessageId.trim();
  if (!conversationId || !replyToMessageId) {
    return {
      usedBroker: true,
      notifiedActorIds: [],
      routingError: "missing_reply_context",
    };
  }

  const conversation = broker.snapshot.conversations[conversationId];
  if (!conversation) {
    return {
      usedBroker: true,
      conversationId,
      replyToMessageId,
      notifiedActorIds: [],
      routingError: "unknown_conversation",
    };
  }

  const replyTarget = broker.snapshot.messages[replyToMessageId];
  if (!replyTarget) {
    return {
      usedBroker: true,
      conversationId,
      replyToMessageId,
      notifiedActorIds: [],
      routingError: "unknown_reply_target",
    };
  }
  if (replyTarget.conversationId !== conversationId) {
    return {
      usedBroker: true,
      conversationId,
      replyToMessageId,
      notifiedActorIds: [],
      routingError: "reply_target_conversation_mismatch",
    };
  }

  const currentDirectory = input.currentDirectory ?? process.cwd();
  const source = input.source?.trim() || "scout-mcp";
  const senderId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.senderId,
    currentDirectory,
  );
  const createdAtMs = input.createdAtMs ?? Date.now();
  const messageId = input.requestId
    ? `msg.request.${createHash("sha256").update(JSON.stringify([senderId, input.requestId])).digest("hex")}`
    : `m-${createdAtMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const notifiedActorIds = replyTarget.actorId !== senderId ? [replyTarget.actorId] : [];
  const speechText = input.shouldSpeak ? input.body.trim() : "";
  const returnAddress = buildScoutReturnAddress(broker.snapshot, senderId, {
    conversationId,
    replyToMessageId: messageId,
  });

  const accepted = await brokerPostJson<{ message?: MessageRecord }>(
    broker.baseUrl, input.completion ? "/v1/messages/reply" : scoutBrokerPaths.v1.messages, {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    id: messageId,
    conversationId,
    replyToMessageId,
    actorId: senderId,
    originNodeId: broker.node.id,
    class: conversation.kind === "system" ? "system" : "agent",
    body: input.body,
    speech: speechText ? { text: speechText } : undefined,
    attachments: normalizeOutgoingAttachments(input.attachments, input.requestId ? messageId : undefined),
    audience: notifiedActorIds.length > 0
      ? { notify: notifiedActorIds, reason: "thread_reply" }
      : undefined,
    visibility: conversation.visibility,
    policy: "durable",
    createdAt: createdAtMs,
    metadata: {
      source,
      ...(input.completion ? { completionReply: input.completion } : {}),
      relayChannel: relayChannelMetadata(conversation),
      relayMessageId: messageId,
      ...clientMessageMetadata(input.clientMessageId),
      returnAddress,
    },
  } satisfies MessageRecord);

  if (input.completion && accepted?.message?.id !== messageId) {
    throw new Error("Broker did not return the canonical explicit reply receipt; retry with the same requestId.");
  }
  return {
    usedBroker: true,
    conversationId,
    messageId,
    replyToMessageId,
    notifiedActorIds,
  };
}

export async function sendScoutMessageToAgentIds(input: {
  senderId: string;
  body: string;
  targetAgentIds: string[];
  channel?: string;
  shouldSpeak?: boolean;
  createdAtMs?: number;
  currentDirectory?: string;
  source?: string;
}): Promise<ScoutStructuredMessagePostResult> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return {
      usedBroker: false,
      invokedTargetIds: [],
      unresolvedTargetIds: [],
    };
  }

  const currentDirectory = input.currentDirectory ?? process.cwd();
  const createdAtMs = input.createdAtMs ?? Date.now();
  const source = input.source?.trim() || "scout-mcp";
  const senderId = await resolveConversationActorId(
    broker.baseUrl,
    broker.snapshot,
    broker.node.id,
    input.senderId,
    currentDirectory,
  );
  const requestedTargetIds = [
    ...new Set(
      input.targetAgentIds
        .map((targetId) => targetId.trim())
        .filter(Boolean)
        .filter((targetId) => targetId !== senderId),
    ),
  ];

  const availableTargets = (
    await Promise.all(
      requestedTargetIds.map(async (targetId) =>
        (await ensureTargetRelayAgentRegistered(
          broker.baseUrl,
          broker.snapshot,
          broker.node.id,
          targetId,
          currentDirectory,
        ))
          ? targetId
          : null,
      ),
    )
  ).filter((targetId): targetId is string =>
    Boolean(targetId && broker.snapshot.agents[targetId]),
  );

  const unresolvedTargetIds = requestedTargetIds.filter(
    (targetId) => !availableTargets.includes(targetId),
  );
  if (unresolvedTargetIds.length > 0) {
    return {
      usedBroker: true,
      invokedTargetIds: [],
      unresolvedTargetIds,
    };
  }

  if (availableTargets.length === 1 && !input.channel) {
    const targetAgentId = availableTargets[0]!;
    const delivery = await brokerPostDeliver(broker.baseUrl, {
      caller: {
        actorId: senderId,
        nodeId: broker.node.id,
        currentDirectory,
        metadata: { source },
      },
      target: {
        kind: "agent_id",
        agentId: targetAgentId,
      },
      body: input.body,
      intent: "tell",
      speechText: input.shouldSpeak ? input.body.trim() : undefined,
      createdAt: createdAtMs,
      messageMetadata: {
        source,
      },
      invocationMetadata: {
        source,
      },
    });
    if (delivery.kind !== "delivery") {
      return {
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [targetAgentId],
        targetDiagnostic: scoutTargetDiagnosticFromDeliveryFailure(delivery),
      };
    }
    return {
      usedBroker: true,
      conversationId: delivery.conversation.id,
      messageId: delivery.message.id,
      flight: delivery.flight,
      invokedTargetIds: delivery.targetAgentId ? [delivery.targetAgentId] : [targetAgentId],
      unresolvedTargetIds: [],
      routeKind: delivery.routeKind,
    };
  }

  if (availableTargets.length === 0 && !input.channel) {
    return {
      usedBroker: true,
      invokedTargetIds: [],
      unresolvedTargetIds: [],
      routingError: "missing_destination",
    };
  }
  if (availableTargets.length > 1 && !input.channel) {
    return {
      usedBroker: true,
      invokedTargetIds: [],
      unresolvedTargetIds: [],
      routingError: "multi_target_requires_explicit_channel",
    };
  }

  let conversation: ScoutBrokerConversationRecord;
  if (availableTargets.length === 1 && !input.channel) {
    const dm = await ensureBrokerDirectConversationBetween(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      senderId,
      availableTargets[0],
    );
    conversation = dm.conversation;
  } else {
    conversation = await ensureBrokerConversation(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      input.channel,
      senderId,
      availableTargets,
    );
  }

  const messageId = `m-${createdAtMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const speechText = input.shouldSpeak ? input.body.trim() : "";
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
    mentions: availableTargets.map((targetId) => ({
      actorId: targetId,
      label: formatBrokerTargetLabel(broker.snapshot, targetId),
    })),
    speech: speechText ? { text: speechText } : undefined,
    audience:
      availableTargets.length > 0
        ? {
            notify: availableTargets,
            reason: relayAudienceReason(conversation),
          }
        : undefined,
    visibility: conversation.visibility,
    policy: "durable",
    createdAt: createdAtMs,
    metadata: {
      source,
      relayChannel: relayChannelMetadata(conversation, input.channel),
      relayTargetIds: availableTargets,
      relayMessageId: messageId,
      returnAddress,
    },
  });

  return {
    usedBroker: true,
    conversationId: conversation.id,
    messageId,
    invokedTargetIds: availableTargets,
    unresolvedTargetIds,
    routeKind: relayRouteKind(conversation),
  };
}

export async function openScoutDirectSession(input: {
  agentId: string;
  currentDirectory?: string;
  operatorName?: string;
}): Promise<ScoutDirectSessionResult> {
  const session = await openScoutPeerSession({
    sourceId: OPERATOR_ID,
    targetId: input.agentId,
    currentDirectory: input.currentDirectory,
    sourceName: input.operatorName,
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

export async function attachScoutManagedLocalSession(input: {
  externalSessionId: string;
  transport: ScoutManagedLocalSessionTransport;
  currentDirectory: string;
  projectRoot?: string;
  agentId?: string;
  alias?: string;
  displayName?: string;
  liveTerminal?: LiveTerminalSession;
}): Promise<ScoutManagedLocalSessionAttachment> {
  const broker = await requireScoutBrokerContext();
  return brokerPostJson<ScoutManagedLocalSessionAttachment>(
    broker.baseUrl,
    scoutBrokerPaths.v1.localSessionsAttach,
    {
      ...(input.liveTerminal ? { liveTerminal: input.liveTerminal } : {}),
      externalSessionId: input.externalSessionId,
      transport: input.transport,
      cwd: input.currentDirectory,
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.alias ? { alias: input.alias } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    },
  );
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
  source?: string;
  deviceId?: string;
}): Promise<ScoutDirectMessageResult> {
  const broker = await requireScoutBrokerContext();
  const createdAt = Date.now();
  const source = input.source?.trim() || "scout-mobile";
  const attachments = normalizeOutgoingAttachments(input.attachments);
  // The bridge accepts attachment-only posts, while `/v1/deliver` requires a
  // non-empty consult body. Preserve the attachment and supply the invocation
  // task instead of surfacing a raw invalid_request after upload.
  const body = input.body.trim() || (attachments?.length ? "Review the attached message." : "");
  const delivery = await brokerPostDeliver(broker.baseUrl, {
    id: deliveryRequestId(input.clientMessageId, createdAt),
    caller: {
      actorId: OPERATOR_ID,
      nodeId: broker.node.id,
      currentDirectory: input.currentDirectory,
      metadata: { source },
    },
    target: {
      kind: "agent_id",
      agentId: input.agentId,
    },
    targetAgentId: input.agentId,
    body,
    attachments,
    intent: "consult",
    replyToMessageId: input.replyToMessageId ?? undefined,
    execution: {
      ...(input.executionHarness ? { harness: input.executionHarness } : {}),
      session: "new",
    },
    ensureAwake: true,
    createdAt,
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

export async function askScoutAgentById(input: {
  senderId: string;
  targetAgentId: string;
  body: string;
  workItem?: ScoutWorkItemInput;
  channel?: string;
  shouldSpeak?: boolean;
  createdAtMs?: number;
  executionHarness?: AgentHarness;
  executionModel?: string;
  executionReasoningEffort?: string;
  executionPlacement?: import("@openscout/protocol").SessionPlacement;
  executionSource?: ScoutDeliverRequest["executionSource"];
  executionSession?: "new" | "existing" | "any";
  workspace?: ScoutAskWorkspace;
  senderContext?: ScoutAskSenderContext;
  labels?: string[];
  replyToSessionId?: string;
  replyMode?: ScoutAskReplyMode;
  currentDirectory?: string;
  source?: string;
}): Promise<ScoutAskByIdResult> {
  const result = await deliverScoutAsk({
    senderId: input.senderId,
    target: {
      kind: "agent_id",
      agentId: input.targetAgentId.trim(),
    },
    targetLabel: input.targetAgentId.trim(),
    body: input.body,
    workItem: input.workItem,
    channel: input.channel,
    shouldSpeak: input.shouldSpeak,
    createdAtMs: input.createdAtMs,
    executionHarness: input.executionHarness,
    executionModel: input.executionModel,
    executionReasoningEffort: input.executionReasoningEffort,
    executionPlacement: input.executionPlacement,
    executionSource: input.executionSource,
    executionSession: input.executionSession,
    workspace: input.workspace,
    senderContext: input.senderContext,
    labels: input.labels,
    replyToSessionId: input.replyToSessionId,
    replyMode: input.replyMode,
    currentDirectory: input.currentDirectory,
    source: input.source ?? "scout-mcp",
  });
  return {
    usedBroker: result.usedBroker,
    flight: result.flight,
    conversationId: result.conversationId,
    messageId: result.messageId,
    workItem: result.workItem,
    unresolvedTargetId: result.unresolvedTarget,
    targetDiagnostic: result.targetDiagnostic,
  };
}

export async function askScoutSessionById(input: {
  senderId: string;
  targetSessionId: string;
  body: string;
  workItem?: ScoutWorkItemInput;
  channel?: string;
  shouldSpeak?: boolean;
  createdAtMs?: number;
  executionHarness?: AgentHarness;
  workspace?: ScoutAskWorkspace;
  senderContext?: ScoutAskSenderContext;
  labels?: string[];
  replyToSessionId?: string;
  replyMode?: ScoutAskReplyMode;
  currentDirectory?: string;
  source?: string;
}): Promise<ScoutAskByIdResult> {
  const targetSessionId = input.targetSessionId.trim();
  const result = await deliverScoutAsk({
    senderId: input.senderId,
    target: {
      kind: "session_id",
      sessionId: targetSessionId,
    },
    targetLabel: `session:${targetSessionId}`,
    targetSessionId,
    body: input.body,
    workItem: input.workItem,
    channel: input.channel,
    shouldSpeak: input.shouldSpeak,
    createdAtMs: input.createdAtMs,
    executionHarness: input.executionHarness,
    executionSession: "existing",
    workspace: input.workspace,
    senderContext: input.senderContext,
    labels: input.labels,
    replyToSessionId: input.replyToSessionId,
    replyMode: input.replyMode,
    currentDirectory: input.currentDirectory,
    source: input.source ?? "scout-mcp",
  });
  return {
    usedBroker: result.usedBroker,
    flight: result.flight,
    conversationId: result.conversationId,
    messageId: result.messageId,
    workItem: result.workItem,
    unresolvedTargetId: result.unresolvedTarget,
    targetDiagnostic: result.targetDiagnostic,
  };
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

function directAgentIdForAskTarget(target: ScoutRouteTarget): string | undefined {
  return target.kind === "agent_id" ? target.agentId.trim() : undefined;
}

function directSessionIdForAskTarget(target: ScoutRouteTarget): string | undefined {
  return target.kind === "session_id" ? target.sessionId.trim() : undefined;
}

function defaultAskExecutionSession(
  target: ScoutRouteTarget,
): "new" | "existing" {
  return target.kind === "binding_ref" || target.kind === "session_id" || target.kind === "target_handle"
    ? "existing"
    : "new";
}

export async function deliverScoutAsk(input: {
  requestId?: string;
  completion?: ScoutCompletionRequest;
  relation?: ScoutCompletionRelation;
  senderId: string;
  senderResolution?: "exact" | "legacy";
  target: ScoutRouteTarget;
  targetLabel?: string;
  body: string;
  workItem?: ScoutWorkItemInput;
  channel?: string;
  shouldSpeak?: boolean;
  createdAtMs?: number;
  executionHarness?: AgentHarness;
  executionModel?: string;
  executionReasoningEffort?: string;
  executionPlacement?: import("@openscout/protocol").SessionPlacement;
  executionSource?: ScoutDeliverRequest["executionSource"];
  executionSession?: "new" | "existing" | "any";
  workspace?: ScoutAskWorkspace;
  senderContext?: ScoutAskSenderContext;
  labels?: string[];
  projectAgent?: ScoutProjectAgentSpec;
  targetSessionId?: string;
  replyToSessionId?: string;
  replyMode?: ScoutAskReplyMode;
  currentDirectory?: string;
  source?: string;
}): Promise<ScoutAskResult> {
  const renderedTarget = input.targetLabel?.trim() || renderedScoutAskTarget(input.target);
  const brokerBaseUrl = resolveScoutBrokerUrl();
  if (input.completion || input.relation) {
    if ((!directAgentIdForAskTarget(input.target) && !directSessionIdForAskTarget(input.target) && !input.targetSessionId)
      || input.projectAgent || input.executionHarness || input.executionModel || input.executionReasoningEffort
      || input.executionPlacement || input.executionSession === "new" || input.workspace === "new_worktree") {
      throw new Error("Explicit completion requires an exact local agent or session without launch options.");
    }
    if (!input.requestId?.trim()) throw new Error("Explicit completion asks require a stable requestId.");
    const node = await brokerReadJson<ScoutBrokerNodeRecord>(brokerBaseUrl, scoutBrokerPaths.v1.node);
    if (!node.capabilities?.includes(SCOUT_COMPLETION_CAPABILITY)) {
      throw new Error("Broker does not support explicit-completion/1; upgrade the broker before asking.");
    }
  }
  let brokerNodeId: string | undefined;
  let senderId = input.senderId.trim() || OPERATOR_ID;
  const currentDirectory = input.currentDirectory ?? process.cwd();
  const createdAtMs = input.createdAtMs ?? Date.now();
  const source = input.source?.trim() || "scout-ask";
  // Normal asks carry an exact caller ID. The broker owns the default local
  // node and ensures missing actors without replacing existing metadata.
  // Explicit --as names retain the previous local registration resolution.
  if (input.senderResolution === "legacy") {
    const contextResult = await loadScoutBrokerContextResult(brokerBaseUrl, { scope: "identity" });
    if (!contextResult.ok) {
      return { usedBroker: false, unresolvedTarget: renderedTarget,
        preflightFailure: { reason: contextResult.reason, detail: contextResult.detail } };
    }
    brokerNodeId = contextResult.context.node.id;
    senderId = await resolveConversationActorId(brokerBaseUrl, contextResult.context.snapshot,
      brokerNodeId, senderId, currentDirectory);
  }

  const targetAgentId = directAgentIdForAskTarget(input.target);
  if (!renderedTarget) {
    return { usedBroker: true, unresolvedTarget: renderedTarget };
  }
  const labels = normalizeWorkItemLabels(input.labels);
  const targetSessionId =
    directSessionIdForAskTarget(input.target) ?? input.targetSessionId?.trim();
  // The receipt fingerprint includes this ID and its metadata copies. A retry
  // of one caller command must not acquire a new random work identity.
  const workRecordId = input.workItem
    ? input.requestId
      ? `work-request-${createHash("sha256").update(JSON.stringify([senderId, input.requestId])).digest("hex")}`
      : buildScoutEntityId("work", createdAtMs)
    : undefined;
  const deliveryWorkItem = input.workItem && workRecordId
    ? { id: workRecordId, ...input.workItem }
    : undefined;
  const askMetadata = buildScoutAskMetadata({
    source,
    workRecordId,
    senderContext: input.senderContext,
    workspace: input.workspace,
    labels,
  });
  const replyToSessionId = input.replyToSessionId?.trim();
  const deliveryMetadata = {
    ...askMetadata,
    ...(targetSessionId ? { targetSessionId } : {}),
    ...(replyToSessionId ? { replyToSessionId } : {}),
    ...(input.replyMode ? { replyMode: input.replyMode } : {}),
  };
  const delivery = await brokerPostDeliver(brokerBaseUrl, {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    caller: {
      actorId: senderId,
      ...(brokerNodeId ? { nodeId: brokerNodeId } : {}),
      currentDirectory,
      metadata: { source },
    },
    target: input.target,
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(targetSessionId ? { targetSessionId } : {}),
    targetLabel: renderedTarget,
    ...(replyToSessionId ? { replyToSessionId } : {}),
    body: input.body.trim(),
    intent: input.completion || input.relation ? "explicit_consult" : "consult",
    ...(input.completion ? { completion: input.completion } : {}),
    ...(input.relation ? { relation: input.relation } : {}),
    channel: input.channel,
    speechText: input.shouldSpeak
      ? input.target.kind === "agent_id"
        ? input.body.trim()
        : stripScoutAgentSelectorLabels(input.body.trim())
      : undefined,
    ...(deliveryWorkItem ? { collaborationRecordId: workRecordId, workItem: deliveryWorkItem } : {}),
    execution: {
      ...(input.executionHarness ? { harness: input.executionHarness } : {}),
      ...(input.executionModel?.trim() ? { model: input.executionModel.trim() } : {}),
      ...(input.executionReasoningEffort?.trim()
        ? { reasoningEffort: input.executionReasoningEffort.trim() }
        : {}),
      ...(input.executionPlacement ? { placement: input.executionPlacement } : {}),
      ...(targetSessionId ? { targetSessionId } : {}),
      session: input.executionSession ?? defaultAskExecutionSession(input.target),
    },
    ...(input.executionSource ? { executionSource: input.executionSource } : {}),
    ...(input.projectAgent ? { projectAgent: input.projectAgent } : {}),
    ensureAwake: true,
    ...(labels ? { labels } : {}),
    messageMetadata: deliveryMetadata,
    invocationMetadata: deliveryMetadata,
  });
  if (delivery.kind !== "delivery") {
    return {
      usedBroker: true,
      unresolvedTarget: renderedTarget,
      targetDiagnostic: scoutTargetDiagnosticFromDeliveryFailure(delivery),
    };
  }
  const workItem = delivery.workItem
    ? createTrackedWorkItemSummary(delivery.workItem)
    : input.workItem && delivery.targetAgentId
    ? await createScoutTrackedWorkItem({
        baseUrl: brokerBaseUrl,
        senderId,
        targetAgentId: delivery.targetAgentId,
        conversationId: delivery.conversation.id,
        createdAtMs,
        source,
        workItem: input.workItem,
        recordId: workRecordId,
      })
    : undefined;

  return {
    usedBroker: true,
    flight: delivery.flight,
    conversationId: delivery.conversation.id,
    messageId: delivery.message.id,
    bindingRef: delivery.receipt?.bindingRef ?? delivery.bindingRef,
    sessionAlias: delivery.receipt?.sessionAlias ?? delivery.sessionAlias,
    executionResolution: delivery.receipt?.executionResolution,
    workItem,
  };
}

export async function askScoutQuestion(input: {
  senderId: string;
  targetLabel: string;
  targetRef?: string;
  target?: ScoutRouteTarget;
  body: string;
  workItem?: ScoutWorkItemInput;
  channel?: string;
  shouldSpeak?: boolean;
  createdAtMs?: number;
  executionHarness?: AgentHarness;
  executionModel?: string;
  executionReasoningEffort?: string;
  executionSession?: "new" | "existing" | "any";
  workspace?: ScoutAskWorkspace;
  senderContext?: ScoutAskSenderContext;
  labels?: string[];
  projectAgent?: ScoutProjectAgentSpec;
  targetSessionId?: string;
  replyToSessionId?: string;
  replyMode?: ScoutAskReplyMode;
  currentDirectory?: string;
  source?: string;
  aliasScope?: RouteAliasScope;
}): Promise<ScoutAskResult> {
  const fallbackTarget = routeTargetForTargetLabel(input.targetLabel, input.targetRef, input.aliasScope);
  const target = input.target ?? fallbackTarget.target;
  return deliverScoutAsk({
    senderId: input.senderId,
    target,
    targetLabel: input.targetLabel,
    body: input.body,
    workItem: input.workItem,
    channel: input.channel,
    shouldSpeak: input.shouldSpeak,
    createdAtMs: input.createdAtMs,
    executionHarness: input.executionHarness,
    executionModel: input.executionModel,
    executionReasoningEffort: input.executionReasoningEffort,
    executionSession: input.executionSession,
    workspace: input.workspace,
    senderContext: input.senderContext,
    labels: input.labels,
    projectAgent: input.projectAgent,
    targetSessionId: input.targetSessionId,
    replyToSessionId: input.replyToSessionId,
    replyMode: input.replyMode,
    currentDirectory: input.currentDirectory,
    source: input.source ?? "scout-cli",
  });
}

async function loadBrokerFlight(
  baseUrl: string,
  flightId: string,
  signal?: AbortSignal,
): Promise<ScoutFlightRecord | null> {
  const snapshot = await brokerReadJson<{
    flights?: Record<string, ScoutFlightRecord>;
  }>(baseUrl, scoutBrokerPaths.v1.snapshot, signal);
  return snapshot.flights?.[flightId] ?? null;
}

export async function loadScoutFlight(
  baseUrl: string,
  flightId: string,
): Promise<ScoutFlightRecord | null> {
  return loadBrokerFlight(baseUrl, flightId);
}

export async function loadScoutInvocationSnapshot(
  baseUrl: string,
  invocationId: string,
  signal?: AbortSignal,
): Promise<ScoutInvocationSnapshot | null> {
  const snapshot = await brokerReadJson<ScoutInvocationSnapshot>(
    baseUrl,
    scoutBrokerInvocationPath(invocationId),
    signal,
  );
  if (!snapshot.invocation && !snapshot.flight) {
    return null;
  }
  return snapshot;
}

export async function loadScoutInvocationLifecycle(
  baseUrl: string,
  invocationId: string,
): Promise<ScoutInvocationLifecycleRecord | null> {
  try {
    return await brokerReadJson<ScoutInvocationLifecycleRecord | null>(
      baseUrl,
      scoutBrokerInvocationLifecyclePath(invocationId),
    );
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes(`${scoutBrokerInvocationLifecyclePath(invocationId)} returned 404`)
    ) {
      return null;
    }
    throw error;
  }
}

export async function resolveScoutWaitReference(
  baseUrl: string,
  input: string,
): Promise<ScoutWaitResolution> {
  const original = input.trim();
  const normalized = normalizeScoutWaitRef(original);
  if (!normalized) {
    return { found: false, input: original, candidates: [] };
  }

  const snapshot = await brokerReadJson<ScoutBrokerSnapshot>(
    baseUrl,
    scoutBrokerPaths.v1.snapshot,
  );
  const invocations = Object.values(snapshot.invocations ?? {});
  const flights = Object.values(snapshot.flights ?? {}) as ScoutFlightRecord[];
  const messages = Object.values(snapshot.messages ?? {});

  const exactInvocation = invocations.find((invocation) => invocation.id === normalized);
  if (exactInvocation) {
    const flight = flights.find((candidate) => candidate.invocationId === exactInvocation.id);
    return buildWaitResolution({
      input: original,
      kind: "invocation",
      invocationId: exactInvocation.id,
      flightId: flight?.id ?? null,
      messageId: exactInvocation.messageId ?? null,
      bindingRef: metadataString(flight?.metadata, "bindingRef") ?? flight?.id.slice(-8) ?? null,
    });
  }

  const exactFlight = flights.find((flight) => flight.id === normalized);
  if (exactFlight) {
    return buildWaitResolution({
      input: original,
      kind: "flight",
      invocationId: exactFlight.invocationId,
      flightId: exactFlight.id,
      messageId: invocationMessageId(invocations, exactFlight.invocationId),
      bindingRef: metadataString(exactFlight.metadata, "bindingRef") ?? exactFlight.id.slice(-8),
    });
  }

  const exactMessage = messages.find((message) => message.id === normalized);
  if (exactMessage) {
    const invocationId = messageInvocationId(exactMessage)
      ?? invocations.find((invocation) => invocation.messageId === exactMessage.id)?.id
      ?? null;
    if (invocationId) {
      const flight = flights.find((candidate) => candidate.invocationId === invocationId);
      return buildWaitResolution({
        input: original,
        kind: "message",
        invocationId,
        flightId: flight?.id ?? null,
        messageId: exactMessage.id,
        bindingRef: metadataString(flight?.metadata, "bindingRef") ?? flight?.id.slice(-8) ?? null,
      });
    }
  }

  const flightMatches = flights.filter((flight) => flightReferenceMatches(flight, normalized));
  if (flightMatches.length === 1) {
    const flight = flightMatches[0]!;
    return buildWaitResolution({
      input: original,
      kind: original.trim().startsWith("ref:") ? "ref" : "flight",
      invocationId: flight.invocationId,
      flightId: flight.id,
      messageId: invocationMessageId(invocations, flight.invocationId),
      bindingRef: metadataString(flight.metadata, "bindingRef") ?? flight.id.slice(-8),
    });
  }

  const invocationMatches = invocations.filter((invocation) => invocation.id.endsWith(normalized));
  if (invocationMatches.length === 1) {
    const invocation = invocationMatches[0]!;
    const flight = flights.find((candidate) => candidate.invocationId === invocation.id);
    return buildWaitResolution({
      input: original,
      kind: "invocation",
      invocationId: invocation.id,
      flightId: flight?.id ?? null,
      messageId: invocation.messageId ?? null,
      bindingRef: metadataString(flight?.metadata, "bindingRef") ?? flight?.id.slice(-8) ?? null,
    });
  }

  const messageMatches = messages.filter((message) => message.id.endsWith(normalized));
  if (messageMatches.length === 1) {
    const message = messageMatches[0]!;
    const invocationId = messageInvocationId(message)
      ?? invocations.find((invocation) => invocation.messageId === message.id)?.id
      ?? null;
    if (invocationId) {
      const flight = flights.find((candidate) => candidate.invocationId === invocationId);
      return buildWaitResolution({
        input: original,
        kind: "message",
        invocationId,
        flightId: flight?.id ?? null,
        messageId: message.id,
        bindingRef: metadataString(flight?.metadata, "bindingRef") ?? flight?.id.slice(-8) ?? null,
      });
    }
  }

  const candidates = [
    ...flightMatches.map((flight) => flight.id),
    ...invocationMatches.map((invocation) => invocation.id),
    ...messageMatches.map((message) => message.id),
  ];
  return { found: false, input: original, candidates };
}

export async function waitForScoutInvocation(
  baseUrl: string,
  invocationId: string,
  options: {
    timeoutSeconds?: number;
    onUpdate?: (snapshot: ScoutInvocationSnapshot, detail: string) => void;
  } = {},
): Promise<ScoutInvocationSnapshot> {
  const deadline =
    typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
      ? Date.now() + options.timeoutSeconds * 1000
      : null;
  let latest = await loadScoutInvocationSnapshot(baseUrl, invocationId);
  if (!latest) {
    throw new Error(`Invocation ${invocationId} is not available.`);
  }
  if (isTerminalFlightStateValue(latest.flight?.state)) {
    return latest;
  }

  let lastDetail = "";
  while (true) {
    if (deadline !== null && Date.now() > deadline) {
      throw new Error(`Timed out waiting for invocation ${invocationId}.`);
    }
    try {
      latest = await readScoutInvocationStream(baseUrl, invocationId, latest, {
        deadline,
        onSnapshot(snapshot) {
          const detail = renderInvocationWaitDetail(snapshot);
          if (detail && detail !== lastDetail) {
            options.onUpdate?.(snapshot, detail);
            lastDetail = detail;
          }
        },
      });
      if (isTerminalFlightStateValue(latest.flight?.state)) {
        return latest;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Timed out waiting for invocation ${invocationId}.`);
      }
      if (deadline !== null && Date.now() > deadline) {
        throw new Error(`Timed out waiting for invocation ${invocationId}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      latest = await loadScoutInvocationSnapshot(baseUrl, invocationId) ?? latest;
      if (isTerminalFlightStateValue(latest.flight?.state)) {
        return latest;
      }
    }
  }
}

export async function waitForScoutFlight(
  baseUrl: string,
  flightId: string,
  options: {
    timeoutSeconds?: number;
    signal?: AbortSignal;
    invocationId?: string;
    waitUntil?: "acknowledged" | "completed";
    onUpdate?: (flight: ScoutFlightRecord, detail: string) => void;
  } = {},
): Promise<ScoutFlightRecord> {
  const deadline =
    typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
      ? Date.now() + options.timeoutSeconds * 1000
      : null;
  let invocationId = options.invocationId;
  let lastState = "";
  let lastSummary = "";

  while (true) {
    options.signal?.throwIfAborted();
    // Resolve the invocation once; subsequent polls must not download the
    // entire registry (including unrelated messages and coordination records).
    const flight = invocationId
      ? (await loadScoutInvocationSnapshot(baseUrl, invocationId, options.signal))?.flight
      : await loadBrokerFlight(baseUrl, flightId, options.signal);
    if (!flight || flight.id !== flightId) {
      throw new Error(`Flight ${flightId} is no longer available.`);
    }

    invocationId = flight.invocationId;
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
      throw new Error(
        flight.error || flight.summary || `Flight ${flight.id} failed.`,
      );
    }
    if (deadline !== null && Date.now() > deadline) {
      throw new Error(`Timed out waiting for flight ${flight.id}.`);
    }
    await delay(1000, undefined, { signal: options.signal });
  }
}

async function readScoutInvocationStream(
  baseUrl: string,
  invocationId: string,
  initial: ScoutInvocationSnapshot,
  options: {
    deadline: number | null;
    onSnapshot: (snapshot: ScoutInvocationSnapshot) => void;
  },
): Promise<ScoutInvocationSnapshot> {
  const controller = new AbortController();
  const timeout = options.deadline === null
    ? null
    : setTimeout(() => controller.abort(), Math.max(options.deadline - Date.now(), 1));
  let latest = initial;

  try {
    const response = await fetch(
      new URL(scoutBrokerInvocationStreamPath(invocationId), baseUrl),
      {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`${scoutBrokerInvocationStreamPath(invocationId)} returned ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return latest;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const delimiterIndex = buffer.indexOf("\n\n");
        if (delimiterIndex === -1) break;
        const block = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        latest = applyInvocationStreamBlock(block, latest);
        options.onSnapshot(latest);
        if (isTerminalFlightStateValue(latest.flight?.state)) {
          controller.abort();
          return latest;
        }
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function applyInvocationStreamBlock(
  block: string,
  current: ScoutInvocationSnapshot,
): ScoutInvocationSnapshot {
  const trimmed = block.trim();
  if (!trimmed || trimmed.startsWith(":")) return current;
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (dataLines.length === 0) return current;

  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return current;
  }

  if (eventName === "snapshot") {
    const snapshot = payload as Partial<ScoutInvocationSnapshot>;
    return {
      invocationId: typeof snapshot.invocationId === "string" ? snapshot.invocationId : current.invocationId,
      invocation: snapshot.invocation ?? current.invocation,
      flight: snapshot.flight ?? current.flight,
      deliveries: Array.isArray(snapshot.deliveries) ? snapshot.deliveries : current.deliveries,
      dispatches: Array.isArray(snapshot.dispatches)
        ? snapshot.dispatches as ScoutDispatchRecord[]
        : current.dispatches,
    };
  }

  const event = payload as Partial<ControlEvent>;
  if (event.kind === "flight.updated") {
    const flight = (event as Extract<ControlEvent, { kind: "flight.updated" }>).payload?.flight;
    if (flight?.invocationId === current.invocationId) {
      return { ...current, flight };
    }
  }
  if (event.kind === "invocation.requested") {
    const invocation = (event as Extract<ControlEvent, { kind: "invocation.requested" }>).payload?.invocation;
    if (invocation?.id === current.invocationId) {
      return { ...current, invocation };
    }
  }

  return current;
}

function renderInvocationWaitDetail(snapshot: ScoutInvocationSnapshot): string {
  const state = snapshot.flight?.state;
  const summary = snapshot.flight?.summary;
  return [state, summary].filter(Boolean).join(" - ");
}

function normalizeScoutWaitRef(value: string): string {
  return value
    .trim()
    .replace(/^ref:/, "")
    .replace(/^flight:/, "")
    .replace(/^invocation:/, "")
    .replace(/^message:/, "");
}

function buildWaitResolution(input: {
  input: string;
  kind: "invocation" | "flight" | "message" | "ref";
  invocationId: string;
  flightId: string | null;
  messageId: string | null;
  bindingRef: string | null;
}): ScoutWaitResolution {
  return { found: true, ...input };
}

function invocationMessageId(
  invocations: ScoutBrokerInvocationRecord[],
  invocationId: string,
): string | null {
  return invocations.find((invocation) => invocation.id === invocationId)?.messageId ?? null;
}

function messageInvocationId(message: MessageRecord): string | null {
  const metadata = message.metadata;
  const dispatch = metadata?.["scoutDispatch"];
  if (dispatch && typeof dispatch === "object" && !Array.isArray(dispatch)) {
    const value = (dispatch as Record<string, unknown>)["invocationId"];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const invocationId = metadata?.["invocationId"];
  return typeof invocationId === "string" && invocationId.trim() ? invocationId.trim() : null;
}

function flightReferenceMatches(flight: ScoutFlightRecord, ref: string): boolean {
  const lowerRef = ref.toLowerCase();
  const lowerId = flight.id.toLowerCase();
  const bindingRef = metadataString(flight.metadata, "bindingRef")?.toLowerCase();
  return lowerId.endsWith(lowerRef) || bindingRef === lowerRef;
}

function isTerminalFlightStateValue(state: string | null | undefined): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export async function loadScoutMessages(
  options: {
    channel?: string;
    conversationId?: string;
    participantId?: string;
    inboxOnly?: boolean;
    since?: number;
    limit?: number;
    baseUrl?: string;
  } = {},
): Promise<ScoutBrokerMessageRecord[]> {
  const search = new URLSearchParams();
  if (options.conversationId || options.channel || !options.participantId) {
    search.set(
      "conversationId",
      options.conversationId ?? scoutConversationIdForChannel(options.channel),
    );
  }
  if (options.participantId) {
    search.set("participantId", options.participantId);
  }
  if (options.inboxOnly) {
    search.set("inboxOnly", "1");
  }
  if (
    typeof options.since === "number" &&
    Number.isFinite(options.since) &&
    options.since > 0
  ) {
    search.set("since", String(options.since));
  }
  if (
    typeof options.limit === "number" &&
    Number.isFinite(options.limit) &&
    options.limit > 0
  ) {
    search.set("limit", String(options.limit));
  }
  return brokerReadJson<ScoutBrokerMessageRecord[]>(
    options.baseUrl ?? resolveScoutBrokerUrl(),
    scoutBrokerMessagesListPath(search),
  );
}

export async function readScoutBrokerFeed(
  options: {
    agentId: string;
    since?: number | null;
    limit?: number;
    includeAcknowledged?: boolean;
    baseUrl?: string;
  },
): Promise<ScoutAgentBrokerFeed | null> {
  const agentId = options.agentId.trim();
  if (!agentId) {
    return null;
  }
  const search = new URLSearchParams();
  search.set("agentId", agentId);
  if (
    typeof options.since === "number" &&
    Number.isFinite(options.since) &&
    options.since > 0
  ) {
    search.set("since", String(options.since));
  }
  if (
    typeof options.limit === "number" &&
    Number.isFinite(options.limit) &&
    options.limit > 0
  ) {
    search.set("limit", String(options.limit));
  }
  if (options.includeAcknowledged) {
    search.set("includeAcknowledged", "1");
  }
  try {
    return await brokerReadJson<ScoutAgentBrokerFeed>(
      options.baseUrl ?? resolveScoutBrokerUrl(),
      scoutBrokerMessagesPath(search),
    );
  } catch {
    return null;
  }
}

export async function markScoutConversationRead(
  options: {
    channel?: string;
    conversationId?: string;
    actorId?: string;
    readerNodeId?: string;
    lastReadMessageId?: string;
    lastReadSeq?: number;
    lastReadAt?: number;
    metadata?: Record<string, unknown>;
    baseUrl?: string;
  } = {},
): Promise<{
  ok: true;
  cursor: ScoutBrokerReadCursorRecord;
  acknowledgedDeliveries: number;
}> {
  const broker = await requireScoutBrokerContext(options.baseUrl);
  const conversationId = options.conversationId ?? scoutConversationIdForChannel(options.channel);
  return brokerPostJson(
    broker.baseUrl,
    `/v1/conversations/${encodeURIComponent(conversationId)}/read-cursors`,
    {
      actorId: options.actorId,
      readerNodeId: options.readerNodeId ?? broker.node.id,
      lastReadMessageId: options.lastReadMessageId,
      lastReadSeq: options.lastReadSeq,
      lastReadAt: options.lastReadAt,
      metadata: options.metadata,
    },
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

export async function loadScoutActivityItems(
  options: {
    agentId?: string;
    actorId?: string;
    conversationId?: string;
    limit?: number;
    baseUrl?: string;
  } = {},
): Promise<ScoutActivityItem[]> {
  const search = new URLSearchParams();
  if (options.agentId) search.set("agentId", options.agentId);
  if (options.actorId) search.set("actorId", options.actorId);
  if (options.conversationId)
    search.set("conversationId", options.conversationId);
  if (typeof options.limit === "number" && options.limit > 0)
    search.set("limit", String(options.limit));
  const q = search.toString();
  const path = q
    ? `${scoutBrokerPaths.v1.activity}?${q}`
    : scoutBrokerPaths.v1.activity;
  return brokerReadJson<ScoutActivityItem[]>(
    options.baseUrl ?? resolveScoutBrokerUrl(),
    path,
  );
}

export async function watchScoutMessages(
  options: ScoutWatchOptions,
): Promise<void> {
  const broker = await requireScoutBrokerContext();
  const conversationId = options.conversationId ?? (
    options.allConversations ? undefined : scoutConversationIdForChannel(options.channel)
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
    const response = await fetch(
      new URL(scoutBrokerPaths.v1.eventsStream, broker.baseUrl),
      {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(
        `${scoutBrokerPaths.v1.eventsStream} returned ${response.status}`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const messagesById = new Map(
      Object.values(broker.snapshot.messages ?? {}).map((message) => [
        message.id,
        message,
      ]),
    );
    const invocationsById = new Map(
      Object.values(broker.snapshot.invocations ?? {}).map((invocation) => [
        invocation.id,
        invocation,
      ]),
    );

    const clientMessageIdFor = (
      message: ScoutBrokerMessageRecord | undefined,
    ): string | null => {
      const raw = message?.metadata?.clientMessageId;
      return typeof raw === "string" && raw.trim().length > 0
        ? raw.trim()
        : null;
    };

    const lifecycleStateForFlight = (
      state: string | undefined,
    ): ScoutBrokerConversationLifecycleState | null => {
      switch (state) {
        case "queued":
          return "queued";
        case "waking":
          return "dispatching";
        case "running":
          return "working";
        case "waiting":
          return "waiting";
        case "completed":
          return "completed";
        case "failed":
          return "failed";
        case "cancelled":
          return "cancelled";
        default:
          return null;
      }
    };

    const maybeRefreshMaps = async () => {
      const latest = await loadScoutBrokerContext().catch(() => null);
      if (!latest) return;
      for (const message of Object.values(latest.snapshot.messages ?? {})) {
        messagesById.set(message.id, message);
      }
      for (const invocation of Object.values(
        latest.snapshot.invocations ?? {},
      )) {
        invocationsById.set(invocation.id, invocation);
      }
    };

    const emitLifecycle = (
      record: ScoutBrokerConversationLifecycleRecord,
    ) => {
      if (conversationId && record.conversationId !== conversationId) return;
      options.onLifecycle?.(record);
    };

    const handleBlock = async (block: string) => {
      const trimmed = block.trim();
      if (!trimmed) return;
      let eventName = "";
      const dataLines: string[] = [];
      for (const line of trimmed.split("\n")) {
        if (line.startsWith("event:"))
          eventName = line.slice("event:".length).trim();
        if (line.startsWith("data:"))
          dataLines.push(line.slice("data:".length).trim());
      }
      if (dataLines.length === 0) return;
      let event: ControlEvent;
      try {
        event = JSON.parse(dataLines.join("\n")) as ControlEvent;
      } catch {
        return;
      }
      if (event.kind === "message.posted" || eventName === "message.posted") {
        const message = (
          event as Extract<ControlEvent, { kind: "message.posted" }>
        ).payload?.message as ScoutBrokerMessageRecord | undefined;
        if (!message) return;
        messagesById.set(message.id, message);
        if (conversationId && message.conversationId !== conversationId) return;
        options.onMessage(message);
        return;
      }

      if (!options.onLifecycle) return;

      if (event.kind === "invocation.requested") {
        const invocation = (
          event as Extract<ControlEvent, { kind: "invocation.requested" }>
        ).payload?.invocation;
        if (!invocation?.conversationId) return;
        invocationsById.set(invocation.id, invocation);
        const message = invocation.messageId
          ? messagesById.get(invocation.messageId)
          : undefined;
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
        const flight = (
          event as Extract<ControlEvent, { kind: "flight.updated" }>
        ).payload?.flight;
        if (!flight) return;
        let invocation = invocationsById.get(flight.invocationId);
        if (!invocation) {
          await maybeRefreshMaps();
          invocation = invocationsById.get(flight.invocationId);
        }
        if (!invocation?.conversationId) return;
        const message = invocation.messageId
          ? messagesById.get(invocation.messageId)
          : undefined;
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
        const delivery = (
          event as Extract<ControlEvent, { kind: "delivery.state.changed" }>
        ).payload?.delivery;
        if (!delivery) return;
        if (
          delivery.status !== "peer_acked" &&
          delivery.status !== "acknowledged" &&
          delivery.status !== "running"
        ) return;
        let invocation = delivery.invocationId
          ? invocationsById.get(delivery.invocationId)
          : undefined;
        if (delivery.invocationId && !invocation) {
          await maybeRefreshMaps();
          invocation = invocationsById.get(delivery.invocationId);
        }
        const message = delivery.messageId
          ? messagesById.get(delivery.messageId)
          : undefined;
        const lifecycleConversationId = invocation?.conversationId ?? message?.conversationId;
        if (!lifecycleConversationId) return;
        emitLifecycle({
          conversationId: lifecycleConversationId,
          messageId: delivery.messageId ?? invocation?.messageId ?? null,
          clientMessageId: clientMessageIdFor(message),
          invocationId: delivery.invocationId ?? invocation?.id ?? null,
          flightId:
            typeof delivery.metadata?.flightId === "string"
              ? delivery.metadata.flightId
              : null,
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

function whoEndpointActivity(
  endpoint: ScoutBrokerEndpointRecord,
): number | null {
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
  if (endpoints.length === 0)
    return registrationKind === "discovered" ? "discovered" : "offline";
  return endpoints.reduce<AgentState>((bestState, endpoint) => {
    const nextState = endpoint.state ?? "offline";
    return whoStateRank(nextState) > whoStateRank(bestState)
      ? nextState
      : bestState;
  }, "offline");
}

async function loadConfiguredAgentMap(): Promise<Map<string, { projectRoot: string }>> {
  try {
    const overrides = await readRelayAgentOverrides();
    return new Map(
      Object.entries(overrides)
        .filter(([agentId, record]) => {
          const defId = record.definitionId ?? agentId;
          return !BUILT_IN_AGENT_DEFINITION_IDS.has(defId);
        }),
    );
  } catch {
    return new Map();
  }
}

async function loadDiscoveredAgentMap(
  currentDirectory: string,
): Promise<Map<string, ResolvedRelayAgentConfig>> {
  try {
    const setup = await loadResolvedRelayAgents({ currentDirectory });
    return new Map(setup.discoveredAgents.map((agent) => [agent.agentId, agent]));
  } catch {
    return new Map();
  }
}

export async function listScoutAgents(
  options: { currentDirectory?: string; machine?: string } = {},
): Promise<ScoutWhoEntry[]> {
  const broker = await requireScoutBrokerContext();
  const nodes = { ...broker.snapshot.nodes, [broker.node.id]: broker.node };
  const selectedNodeIds = options.machine
    ? new Set(resolveScoutMachines(Object.values(nodes), options.machine).map((node) => node.id))
    : null;
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const aliasParams = new URLSearchParams({ currentDirectory });
  const [configuredAgents, discoveredAgents, aliasResult] = await Promise.all([
    loadConfiguredAgentMap(),
    loadDiscoveredAgentMap(currentDirectory),
    brokerReadJson<{ bindings: RouteAliasBinding[] }>(broker.baseUrl, `/v1/aliases?${aliasParams}`)
      .catch(() => ({ bindings: [] })),
  ]);
  const aliasesByAgent = new Map<string, RouteAliasBinding[]>();
  for (const binding of aliasResult.bindings) {
    if (binding.state !== "active") continue;
    const entries = aliasesByAgent.get(binding.target.agentId) ?? [];
    entries.push(binding);
    aliasesByAgent.set(binding.target.agentId, entries);
  }
  const endpointsByAgent = new Map<string, ScoutBrokerEndpointRecord[]>();
  const messageStats = new Map<
    string,
    { messages: number; lastSeen: number | null }
  >();

  for (const endpoint of Object.values(broker.snapshot.endpoints ?? {})) {
    if (!endpoint.agentId || endpoint.agentId === OPERATOR_ID) continue;
    if (isBuiltInBrokerAgent(broker.snapshot, endpoint.agentId)) continue;
    if (isSupersededBrokerAgent(broker.snapshot, endpoint.agentId)) continue;
    const existing = endpointsByAgent.get(endpoint.agentId) ?? [];
    existing.push(endpoint);
    endpointsByAgent.set(endpoint.agentId, existing);
  }
  for (const message of Object.values(broker.snapshot.messages ?? {})) {
    if (!message.actorId || message.actorId === OPERATOR_ID) continue;
    if (isBuiltInBrokerAgent(broker.snapshot, message.actorId)) continue;
    if (isSupersededBrokerAgent(broker.snapshot, message.actorId)) continue;
    const current = messageStats.get(message.actorId) ?? {
      messages: 0,
      lastSeen: null,
    };
    current.messages += 1;
    current.lastSeen = maxDefined([
      current.lastSeen,
      normalizeUnixTimestamp(message.createdAt),
    ]);
    messageStats.set(message.actorId, current);
  }

  return [
    ...new Set([
      ...Object.keys(broker.snapshot.agents ?? {}),
      ...Array.from(endpointsByAgent.keys()),
      ...Array.from(messageStats.keys()),
      ...Array.from(configuredAgents.keys()),
      ...Array.from(discoveredAgents.keys()),
    ]),
  ]
    .filter((agentId) => agentId && agentId !== OPERATOR_ID)
    .filter((agentId) => !isBuiltInBrokerAgent(broker.snapshot, agentId))
    .filter((agentId) => !isSupersededBrokerAgent(broker.snapshot, agentId))
    .map((agentId): ScoutWhoEntry => {
      const endpoints = endpointsByAgent.get(agentId) ?? [];
      const brokerMessages = messageStats.get(agentId);
      const registrationKind: ScoutWhoRegistrationKind =
        discoveredAgents.get(agentId)?.registrationKind
        ?? (configuredAgents.has(agentId) ? "configured" : "broker");
      const state = whoEntryState(endpoints, registrationKind);
      const lastSeen = maxDefined([
        brokerMessages?.lastSeen,
        ...endpoints.map((endpoint) => whoEndpointActivity(endpoint)),
      ]);
      const messages = brokerMessages?.messages ?? 0;
      const aliases = aliasesByAgent.get(agentId);
      const agent = broker.snapshot.agents?.[agentId];
      const discovered = discoveredAgents.get(agentId);
      const endpoint = [...endpoints].sort((a, b) =>
        (whoEndpointActivity(b) ?? 0) - (whoEndpointActivity(a) ?? 0))[0];
      const nodeId = agent?.homeNodeId ?? agent?.authorityNodeId ?? endpoint?.nodeId
        ?? (discovered || configuredAgents.has(agentId) ? broker.node.id : null);
      const nodeName = nodeId ? nodes[nodeId]?.name ?? null : null;
      const projectRoot = metadataString(agent?.metadata, "projectRoot")
        ?? endpoint?.projectRoot ?? discovered?.projectRoot ?? configuredAgents.get(agentId)?.projectRoot ?? null;
      return { agentId, nodeId, nodeName, projectRoot, state, messages, lastSeen, registrationKind, ...(aliases?.length ? { aliases } : {}) };
    })
    .filter((entry) => !selectedNodeIds || (entry.nodeId !== null && selectedNodeIds.has(entry.nodeId)))
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
    const raw = await readFile(
      join(relayHubDirectory(), "config.json"),
      "utf8",
    );
    return JSON.parse(raw) as RelayConfig;
  } catch {
    return {};
  }
}

export function getScoutVoiceForChannel(
  config: RelayConfig,
  channel?: string,
): string {
  const entry = channel ? config.channels?.[channel] : undefined;
  return entry?.voice || config.defaultVoice || "nova";
}

function applyPronunciations(
  text: string,
  pronunciations?: Record<string, string>,
): string {
  if (!pronunciations) return text;
  let result = text;
  for (const [word, phonetic] of Object.entries(pronunciations)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, "gi"), phonetic);
  }
  return result;
}

export async function acquireScoutOnAir(
  agent: string,
  timeoutMs = 30_000,
): Promise<void> {
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

export async function speakScoutText(
  text: string,
  voice: string,
): Promise<void> {
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

  const player = spawn(
    "ffplay",
    [
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
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );

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
