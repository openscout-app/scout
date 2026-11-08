import { mobileReadWorker } from "../../db/mobile-read.ts";
import { basename, join, resolve } from "node:path";
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import type {
  AgentDefinition,
  AgentEndpoint,
  AgentHarness,
  FlightRecord,
  MessageRecord,
} from "@openscout/protocol";
import {
  channelNaturalKeyFromMetadata,
  directChannelNaturalKey,
  epochMs,
  SCOUT_RUNTIME_CATALOG,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeDefaultsByHarness,
  scoutRuntimeEffortCatalog,
  scoutRuntimeModelCatalog,
} from "@openscout/protocol";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import {
  collectOccupiedDefinitionIdsFromBrokerSnapshot,
  resolveProjectProvisionalAgentName,
} from "@openscout/runtime";
import {
  type ProjectInventoryEntry,
  loadResolvedRelayAgents,
} from "@openscout/runtime/setup";
import { createAgentWorkspace } from "@openscout/runtime/agent-workspace";

import { upScoutAgent } from "../agents/service.ts";
import type { queryFleet } from "../../db-queries.ts";
import {
  loadServiceBudgets,
  type ServiceGauge,
} from "../../service-budgets.ts";
import {
  loadScoutBrokerContext,
  readScoutBrokerHome,
  readScoutBrokerRuntimeCatalog,
  openScoutPeerSession,
  recordScoutBrokerReadCursor,
  registerScoutLocalAgentBinding,
  ScoutDirectDeliveryUnavailableError,
  sendScoutConversationMessage,
  sendScoutDirectMessage,
  sendScoutMessage,
  type OutgoingAttachmentInput,
  type ScoutBrokerConversationRecord,
  type ScoutBrokerHomeActivityRecord,
  type ScoutBrokerSnapshot,
  type ScoutDirectMessageResult,
} from "../broker/service.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import { postScoutbotOperatorMessage } from "../../scoutbot/runner.ts";
import { SCOUTBOT_AGENT_ID } from "../../scoutbot/role.ts";
import type { AgentAttentionEntry } from "../attention/agent-attention.ts";
import { createAgentAttentionIndexReader } from "../attention/build-agent-attention-index.ts";

export async function getScoutMobileRuntimeCapabilities(
  projectRoot?: string,
  readRuntimeCatalog: typeof readScoutBrokerRuntimeCatalog = readScoutBrokerRuntimeCatalog,
) {
  const normalizedProjectRoot = projectRoot?.trim() ? resolve(projectRoot) : null;
  const liveCatalog = await readRuntimeCatalog();
  const runtimeCatalog = liveCatalog?.catalog ?? SCOUT_RUNTIME_CATALOG;
  const defaultHarness = scoutRuntimeDefaultHarness(runtimeCatalog);
  const defaultModel = scoutRuntimeDefaultModel(defaultHarness ?? "", runtimeCatalog);
  const models = scoutRuntimeModelCatalog(runtimeCatalog).map((model) => ({
    ...model,
    harnesses: [...model.harnesses],
  }));
  return {
    schemaVersion: "openscout.runtime-capabilities.v1" as const,
    catalogVersion: runtimeCatalog.schemaVersion,
    catalogRevision: runtimeCatalog.revision,
    source: liveCatalog?.source ?? "bundled",
    ...(liveCatalog?.checkedAt !== undefined ? { checkedAt: liveCatalog.checkedAt } : {}),
    ...(liveCatalog?.nextCheckAt !== undefined ? { nextCheckAt: liveCatalog.nextCheckAt } : {}),
    generatedAt: Date.now(),
    scope: projectRoot ? "global+project" as const : "global" as const,
    ...(normalizedProjectRoot ? { projectRoot: normalizedProjectRoot } : {}),
    defaults: {
      ...(defaultHarness ? { harness: defaultHarness } : {}),
      model: defaultModel,
      reasoningEffort: scoutRuntimeDefaultReasoningEffort(defaultHarness ?? "", defaultModel, runtimeCatalog),
    },
    defaultsByHarness: scoutRuntimeDefaultsByHarness(runtimeCatalog),
    harnesses: runtimeCatalog.harnesses
      .filter((entry) => entry.enabled && entry.listed !== false)
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        ...(entry.presentation ? { presentation: entry.presentation } : {}),
      })),
    models,
    efforts: scoutRuntimeEffortCatalog(runtimeCatalog).map((effort) => ({
      ...effort,
      harnesses: [...effort.harnesses],
      ...(effort.models ? { models: [...effort.models] } : {}),
    })),
    ...(liveCatalog?.warnings.length ? { warnings: liveCatalog.warnings } : {}),
  };
}

/// Shared, TTL-cached reader for the per-agent needs-attention index. Same
/// sourcing as web /api/agents (see core/attention/build-agent-attention-index),
/// so the phone's "Requests" band mirrors the web fleet. Module-level so the
/// short TTL cache is shared across mobile agents/home pulls.
const readMobileAgentAttentionIndex = createAgentAttentionIndexReader();

export type ScoutMobileListFilters = {
  query?: string;
  limit?: number;
};

export type ScoutMobileWorkspaceSummary = {
  id: string;
  title: string;
  projectName: string;
  root: string;
  sourceRoot: string;
  relativePath: string;
  registrationKind: ProjectInventoryEntry["registrationKind"];
  /** Checked-out branch, or null when detached / not a git checkout. */
  branch: string | null;
  /** True for a linked git worktree (its `.git` is a file), false for a main checkout. */
  isWorktree: boolean;
  defaultHarness: string;
  harnesses: Array<{
    harness: string;
    source: "manifest" | "marker" | "default";
    detail: string;
    readinessState: "ready" | "configured" | "installed" | "missing" | null;
    readinessDetail: string | null;
  }>;
};

export type ScoutMobileAgentSummary = {
  id: string;
  title: string;
  selector: string | null;
  defaultSelector: string | null;
  workspaceRoot: string | null;
  harness: string | null;
  transport: string | null;
  state: "offline" | "available" | "working";
  statusLabel: string;
  sessionId: string | null;
  /// The harness's own session id (Claude/Codex transcript UUID) when the
  /// broker recorded one — the key the tail uses, so the phone can tell an
  /// agent's session from a terminal session it only observes. Additive.
  harnessSessionId: string | null;
  /// The broker chat the phone should open for this agent. It is an existing
  /// opaque chat id, or null when no chat has been created yet.
  conversationId: string | null;
  lastActiveAt: number | null;
  /// True when the agent is waiting on the operator (a pending question,
  /// approval, or handoff). Feeds the phone's "Requests" band. Additive and
  /// backward-compatible: older clients ignore it.
  needsAttention: boolean;
  /// The pending ask text when `needsAttention` is true, else null. A flat
  /// string; the iOS client also accepts a structured object but a bare string
  /// is sufficient (it defaults the kind to a question).
  pendingAsk: string | null;
};

export type ScoutMobileSessionSummary = {
  id: string;
  kind: string;
  title: string;
  participantIds: string[];
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  currentBranch: string | null;
  preview: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  workspaceRoot: string | null;
};

export type ScoutMobileHomeState = {
  workspaces: ScoutMobileWorkspaceSummary[];
  agents: ScoutMobileAgentSummary[];
  sessions: ScoutMobileSessionSummary[];
  totals: {
    workspaces: number;
    agents: number;
    sessions: number;
  };
};

export type CreateScoutSessionInput = {
  workspaceId: string;
  harness?: AgentHarness;
  agentName?: string;
  worktree?: string | null;
  profile?: string | null;
  branch?: string;
  model?: string;
  reasoningEffort?: string;
  forceNew?: boolean;
  seed?: {
    instructions?: string | null;
    fromMessageId?: string | null;
    fromConversationId?: string | null;
    attachments?: OutgoingAttachmentInput[];
  } | null;
};

export type ScoutMobileSessionHandle = {
  workspace: ScoutMobileWorkspaceSummary;
  agent: ScoutMobileAgentSummary;
  session: {
    conversationId: string;
    title: string;
    existed: boolean;
  };
  messageId?: string | null;
  flightId?: string | null;
  unsupported: Array<"worktree" | "profile">;
};

export type ScoutMobileSessionSnapshot = {
  session: {
    id: string;
    name: string;
    adapterType: string;
    status: "connecting" | "active" | "idle" | "error" | "closed";
    cwd: string | null;
    model: string | null;
    providerMeta?: Record<string, unknown>;
  };
  history: {
    hasOlder: boolean;
    oldestTurnId: string | null;
    newestTurnId: string | null;
  };
  turns: Array<{
    id: string;
    status: "streaming" | "completed" | "interrupted" | "error";
    blocks: Array<{
      block: {
        id: string;
        turnId: string;
        type: "text" | "reasoning" | "action" | "file" | "error";
        status: "started" | "streaming" | "completed" | "failed";
        index: number;
        text?: string;
        mimeType?: string;
        name?: string;
        data?: string;
        url?: string;
        message?: string;
      };
      status: "streaming" | "completed";
    }>;
    startedAt: number;
    endedAt?: number;
    isUserTurn?: boolean;
    clientMessageId?: string | null;
  }>;
  currentTurnId: string | null;
};

const DEFAULT_MOBILE_RECENT_TURN_LIMIT = 24;
const DEFAULT_MOBILE_HISTORY_PAGE_LIMIT = 40;

export type SendScoutMobileMessageInput = {
  source?: "scout-mobile" | "scout-tui-harness";
  agentId: string;
  body: string;
  attachments?: OutgoingAttachmentInput[];
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
  referenceMessageIds?: string[];
  harness?: AgentHarness;
};

export type ScoutMobileSendLifecycleState =
  | "queued"
  | "dispatching"
  | "acknowledged"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ScoutMobileSendResult = {
  conversationId: string;
  messageId: string;
  flightId?: string | null;
  invocationId?: string | null;
  targetAgentId?: string | null;
  lifecycleState?: ScoutMobileSendLifecycleState | null;
  summary?: string | null;
  error?: string | null;
  delivery?: ScoutMobileDeliveryState | null;
};

export type ScoutMobileDeliveryState = {
  state: "accepted" | "recoverable";
  reason?: "session_ended" | "target_unavailable";
  action?: "start_replacement" | "retry";
  detail?: string;
};

function mobileLifecycleStateForFlight(flight: { state?: string } | null | undefined): ScoutMobileSendLifecycleState | null {
  switch (flight?.state) {
    case "queued": return "queued";
    case "waking": return "dispatching";
    case "running": return "working";
    case "waiting": return "waiting";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return null;
  }
}

function mobileSendResultFromDirect(result: ScoutDirectMessageResult): ScoutMobileSendResult {
  return {
    conversationId: result.conversationId,
    messageId: result.messageId,
    flightId: result.flight?.id ?? null,
    invocationId: result.flight?.invocationId ?? null,
    targetAgentId: result.flight?.targetAgentId ?? null,
    lifecycleState: mobileLifecycleStateForFlight(result.flight) ?? (result.flight ? "dispatching" : null),
    summary: result.flight?.summary ?? null,
    error: result.flight?.error ?? null,
    delivery: { state: "accepted" },
  };
}

function recoverableMobileDelivery(
  error: ScoutDirectDeliveryUnavailableError,
): ScoutMobileDeliveryState {
  const remediation = error.delivery.remediation;
  const sessionEnded = remediation?.kind === "session_reference_not_attachable";
  return sessionEnded
    ? {
        state: "recoverable",
        reason: "session_ended",
        action: "start_replacement",
        detail: "This session ended. Start a new session from the project to deliver this message.",
      }
    : {
        state: "recoverable",
        reason: "target_unavailable",
        action: "retry",
        detail: "Message saved. Retry delivery when the target is available.",
      };
}

function normalizeTimestamp(value: number | null | undefined): number | null {
  const ms = epochMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

function normalizeTimestampMs(value: number | null | undefined): number | null {
  return epochMs(value);
}

function requireTimestampMs(value: number | null | undefined): number {
  return normalizeTimestampMs(value) ?? 0;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataTimestampMs(metadata: Record<string, unknown> | undefined, key: string): number | null {
  return normalizeTimestampMs(metadata?.[key] as number | null | undefined);
}

function metadataBoolean(metadata: Record<string, unknown> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function isBrokerRequesterWaitTimeoutStatusMessage(message: MessageRecord): boolean {
  if (message.class !== "status" || metadataString(message.metadata, "source") !== "broker") {
    return false;
  }
  return message.body.includes("Scout stopped waiting for a synchronous result")
    || message.body.includes("the requester stopped waiting after");
}

function isRequesterWaitTimeoutFlight(flight: FlightRecord): boolean {
  return metadataBoolean(flight.metadata, "requesterTimedOut")
    || metadataString(flight.metadata, "timeoutScope") === "requester_wait"
    || Boolean(flight.summary?.includes("Scout stopped waiting for a synchronous result"));
}

function isInactiveAgent(agent: AgentDefinition | null | undefined): boolean {
  return metadataBoolean(agent?.metadata, "retiredFromFleet")
    || metadataBoolean(agent?.metadata, "staleLocalRegistration");
}

function isInactiveEndpoint(snapshot: ScoutBrokerSnapshot, endpoint: AgentEndpoint | null | undefined): boolean {
  if (!endpoint) {
    return true;
  }
  return metadataBoolean(endpoint.metadata, "retiredFromFleet")
    || metadataBoolean(endpoint.metadata, "staleLocalRegistration")
    || isInactiveAgent(snapshot.agents[endpoint.agentId]);
}

function titleCaseToken(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function humanizeWorkspaceName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const base = trimmed.split("/").at(-1)?.trim() || trimmed;
  if (!base) return null;
  return base
    .split(/[-_]+/g)
    .filter((token) => token.length > 0)
    .map(titleCaseToken)
    .join(" ");
}

function normalizeQuery(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function withQueryAndLimit<T>(
  values: T[],
  filters: ScoutMobileListFilters | undefined,
  match: (value: T, query: string) => boolean,
): T[] {
  const query = normalizeQuery(filters?.query);
  const limited = query ? values.filter((value) => match(value, query)) : values;
  const limit = typeof filters?.limit === "number" && filters.limit > 0 ? Math.floor(filters.limit) : null;
  return limit ? limited.slice(0, limit) : limited;
}

function harnessReadinessMap(snapshot: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>) {
  return new Map(snapshot.entries.map((entry) => [entry.harness, entry.readinessReport] as const));
}

async function loadMobileWorkspaceInventory(currentDirectory?: string): Promise<ScoutMobileWorkspaceSummary[]> {
  const [setup, catalog] = await Promise.all([
    loadResolvedRelayAgents({ currentDirectory }),
    loadHarnessCatalogSnapshot(),
  ]);
  const readinessByHarness = harnessReadinessMap(catalog);

  const checkouts = await Promise.all(
    setup.projectInventory.map((project) => readGitCheckout(project.projectRoot)),
  );

  return setup.projectInventory
    .map((project, index) => ({
      id: project.projectRoot,
      title: project.displayName,
      projectName: project.projectName,
      root: project.projectRoot,
      sourceRoot: project.sourceRoot,
      relativePath: project.relativePath,
      registrationKind: project.registrationKind,
      branch: checkouts[index]?.branch ?? null,
      isWorktree: checkouts[index]?.isWorktree ?? false,
      defaultHarness: project.defaultHarness,
      harnesses: project.harnesses.map((harness) => {
        const readiness = readinessByHarness.get(harness.harness);
        return {
          harness: harness.harness,
          source: harness.source,
          detail: harness.detail,
          readinessState: readiness?.state ?? null,
          readinessDetail: readiness?.detail ?? null,
        };
      }),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.title.localeCompare(right.title));
}

/**
 * The branch a checkout is on and whether it is a linked worktree, from its
 * `.git` alone: no git process, so a 200-project inventory stays cheap. A
 * worktree's `.git` is a file pointing at its gitdir, which holds its HEAD.
 */
export async function readGitCheckout(root: string): Promise<{ branch: string | null; isWorktree: boolean } | null> {
  const dotGit = join(root, ".git");
  try {
    const info = await stat(dotGit);
    let gitDir = dotGit;
    const isWorktree = info.isFile();
    if (isWorktree) {
      const pointer = (await readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!pointer) return { branch: null, isWorktree };
      gitDir = resolve(root, pointer);
    }
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    const branch = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] ?? null;
    return { branch, isWorktree };
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Rebase a legacy macOS user-home path onto the account running Scout. */
export function rehomeScoutMobileWorkspacePath(requestedPath: string, currentHome: string): string | null {
  const requested = resolve(requestedPath);
  const home = resolve(currentHome);
  const requestedMatch = requested.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (!requestedMatch || !/^\/Users\/[^/]+$/.test(home)) return null;
  const suffix = requestedMatch[1] ?? "";
  return resolve(home, `.${suffix || "/"}`);
}

async function resolveMobileWorkspaceRoot(rawWorkspaceId: string, currentDirectory?: string): Promise<string> {
  const requested = resolve(rawWorkspaceId);
  if (isDirectory(requested)) return requested;

  const currentHome = process.env.HOME?.trim();
  const rehomed = currentHome ? rehomeScoutMobileWorkspacePath(requested, currentHome) : null;
  if (rehomed && isDirectory(rehomed)) return rehomed;

  // Last-resort identity lookup for stale session-history paths. Only accept a
  // unique current workspace with the same leaf/name; ambiguity is safer as a
  // clear error than silently launching in the wrong repository.
  const requestedName = basename(requested).toLowerCase();
  const inventory = await loadMobileWorkspaceInventory(currentDirectory);
  const matches = inventory.filter((workspace) => (
    isDirectory(workspace.root)
    && [basename(workspace.root), workspace.projectName, workspace.title]
      .some((value) => value.toLowerCase() === requestedName)
  ));
  if (matches.length === 1) return resolve(matches[0]!.root);

  throw new Error(`Workspace is not available on this Mac: ${rawWorkspaceId}. Choose a project from the current workspace list.`);
}

function latestMessageByConversation(snapshot: ScoutBrokerSnapshot): Map<string, MessageRecord[]> {
  const buckets = new Map<string, MessageRecord[]>();
  for (const message of Object.values(snapshot.messages)) {
    if (isBrokerRequesterWaitTimeoutStatusMessage(message)) {
      continue;
    }
    const next = buckets.get(message.conversationId) ?? [];
    next.push(message);
    buckets.set(message.conversationId, next);
  }
  for (const messages of buckets.values()) {
    messages.sort((left, right) => requireTimestampMs(left.createdAt) - requireTimestampMs(right.createdAt));
  }
  return buckets;
}

function agentDisplayName(snapshot: ScoutBrokerSnapshot, agentId: string): string {
  const endpoint = endpointForAgent(snapshot, agentId);
  const workspaceTitle = humanizeWorkspaceName(endpoint?.projectRoot ?? endpoint?.cwd ?? null);
  if (workspaceTitle) {
    return workspaceTitle;
  }
  return snapshot.agents[agentId]?.displayName
    ?? snapshot.actors[agentId]?.displayName
    ?? agentId;
}

function rawConversationTitle(conversation: ScoutBrokerConversationRecord): string | null {
  const title = typeof conversation.title === "string" ? conversation.title.trim() : "";
  return title.length > 0 ? title : null;
}

function mobileConversationTitle(
  snapshot: ScoutBrokerSnapshot,
  conversation: ScoutBrokerConversationRecord,
  directAgentId: string | null = null,
): string {
  if (conversation.kind === "direct" && directAgentId) {
    return agentDisplayName(snapshot, directAgentId);
  }
  return rawConversationTitle(conversation) ?? conversation.id;
}

function endpointsForAgent(snapshot: ScoutBrokerSnapshot, agentId: string): AgentEndpoint[] {
  const stateRank = (state: AgentEndpoint["state"]): number => {
    switch (state) {
      case "active": return 0;
      case "idle": return 1;
      case "waiting": return 2;
      case "offline": return 4;
      default: return 3;
    }
  };
  return Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === agentId && !isInactiveEndpoint(snapshot, endpoint))
    .sort((left, right) => (
      Number(right.preferred === true) - Number(left.preferred === true)
      || stateRank(left.state) - stateRank(right.state)
      || (endpointActivityAt(right) ?? 0) - (endpointActivityAt(left) ?? 0)
      || left.id.localeCompare(right.id)
    ));
}

/**
 * The runtime an actor runs on, for feed attribution.
 *
 * Unlike `endpointForAgent`, this deliberately accepts inactive/offline
 * endpoints: a post from an hour ago still ran on whatever harness it ran on,
 * and the phone needs that to badge it. Cardless flight actors
 * ("openscout-faraday-2") never appear in the AGENT roster, so their endpoint
 * is the only place their runtime is recorded. Returns null for actors with no
 * endpoint at all (the operator, broker notices) — the caller must render
 * nothing rather than guess.
 */
function harnessForActor(snapshot: ScoutBrokerSnapshot, actorId: string): string | null {
  const live = endpointForAgent(snapshot, actorId);
  if (live?.harness) return live.harness;
  const any = Object.values(snapshot.endpoints ?? {}).find(
    (endpoint) => endpoint.agentId === actorId && endpoint.harness,
  );
  return any?.harness ?? null;
}

function endpointForAgent(snapshot: ScoutBrokerSnapshot, agentId: string): AgentEndpoint | null {
  return endpointsForAgent(snapshot, agentId)[0] ?? null;
}

function maxTimestampMs(values: Array<number | null | undefined>): number | null {
  const timestamps = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function endpointActivityAt(endpoint: AgentEndpoint | null): number | null {
  if (!endpoint) return null;
  return maxTimestampMs([
    metadataTimestampMs(endpoint.metadata, "lastSeenAt"),
    metadataTimestampMs(endpoint.metadata, "lastEnsuredAt"),
    metadataTimestampMs(endpoint.metadata, "lastStartedAt"),
    metadataTimestampMs(endpoint.metadata, "lastCompletedAt"),
    metadataTimestampMs(endpoint.metadata, "lastFailedAt"),
    metadataTimestampMs(endpoint.metadata, "startedAt"),
  ]);
}

function flightActivityAt(flight: FlightRecord): number | null {
  return maxTimestampMs([
    normalizeTimestampMs(flight.completedAt),
    normalizeTimestampMs(flight.startedAt),
  ]);
}

function isActiveMobileFlight(flight: FlightRecord): boolean {
  return flight.state === "running"
    || flight.state === "waiting"
    || flight.state === "queued"
    || flight.state === "waking";
}

/// The conversation id the phone should route an agent tap to. It is always an
/// existing broker chat id. When no chat exists yet, callers get null and must
/// create one explicitly.
function mobileAgentConversationId(snapshot: ScoutBrokerSnapshot, agentId: string): string | null {
  return resolveMobileConversation(snapshot, agentId)?.id ?? null;
}

export function buildMobileAgentSummary(
  snapshot: ScoutBrokerSnapshot,
  agent: AgentDefinition,
  attention?: ReadonlyMap<string, AgentAttentionEntry>,
): ScoutMobileAgentSummary {
  const endpoints = endpointsForAgent(snapshot, agent.id);
  const endpoint = endpoints[0] ?? null;
  const flights = Object.values(snapshot.flights as Record<string, FlightRecord>).filter((flight) => flight.targetAgentId === agent.id);
  const hasActiveFlight = flights.some(isActiveMobileFlight);
  const lastAuthoredMessageAt = Object.values(snapshot.messages)
    .filter((message) => message.actorId === agent.id)
    .reduce<number | null>((latest, message) => {
      const createdAt = normalizeTimestampMs(message.createdAt);
      return typeof createdAt === "number" && (!latest || createdAt > latest) ? createdAt : latest;
    }, null);
  const lastActiveAt = maxTimestampMs([
    lastAuthoredMessageAt,
    ...endpoints.map(endpointActivityAt),
    ...flights.map(flightActivityAt),
  ]);

  const state = hasActiveFlight
    ? "working"
    : endpoints.some((candidate) => candidate.state !== "offline")
      ? "available"
      : agent.wakePolicy !== "manual"
        ? "available"
        : "offline";

  const attentionEntry = attention?.get(agent.id) ?? null;

  return {
    id: agent.id,
    title: agent.displayName,
    selector: agent.selector ?? null,
    defaultSelector: agent.defaultSelector ?? null,
    workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
    harness: endpoint?.harness ?? null,
    transport: endpoint?.transport ?? null,
    state,
    statusLabel: state === "working" ? "Working" : state === "available" ? "Available" : "Offline",
    sessionId: endpoint?.sessionId ?? null,
    harnessSessionId: mobileEndpointHarnessSessionId(endpoint),
    conversationId: mobileAgentConversationId(snapshot, agent.id),
    lastActiveAt,
    needsAttention: attentionEntry !== null,
    pendingAsk: attentionEntry?.ask ?? null,
  };
}

/** The harness transcript id the broker recorded for an endpoint, if any. */
function mobileEndpointHarnessSessionId(
  endpoint: { metadata?: Record<string, unknown> | null } | null | undefined,
): string | null {
  const value = endpoint?.metadata?.externalSessionId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildMobileSessionSummaries(snapshot: ScoutBrokerSnapshot): ScoutMobileSessionSummary[] {
  const messagesByConversation = latestMessageByConversation(snapshot);
  const summaries: ScoutMobileSessionSummary[] = Object.values(snapshot.conversations)
    .filter((conversation) => conversation.kind === "direct")
    .flatMap((conversation) => {
      const messages = messagesByConversation.get(conversation.id) ?? [];
      const latestMessage = messages.at(-1) ?? null;
      const directAgentId = conversation.kind === "direct"
        ? conversation.participantIds.find((participantId) => participantId !== "operator") ?? null
        : null;
      const agent = directAgentId ? snapshot.agents[directAgentId] ?? null : null;
      if (!directAgentId || !agent || isInactiveAgent(agent) || messages.length === 0) {
        return [];
      }
      const endpoint = endpointForAgent(snapshot, directAgentId);
      if (!endpoint || endpoint.state === "offline") {
        return [];
      }
      return [{
        id: conversation.id,
        kind: conversation.kind,
        title: mobileConversationTitle(snapshot, conversation, directAgentId),
        participantIds: [...conversation.participantIds],
        agentId: directAgentId,
        agentName: directAgentId ? agentDisplayName(snapshot, directAgentId) : null,
        harness: endpoint?.harness ?? null,
        currentBranch:
          metadataString(endpoint?.metadata, "branch")
          ?? metadataString(endpoint?.metadata, "workspaceQualifier")
          ?? metadataString(agent?.metadata, "branch")
          ?? metadataString(agent?.metadata, "workspaceQualifier"),
        preview: latestMessage?.body ?? null,
        messageCount: messages.length,
        lastMessageAt: normalizeTimestampMs(latestMessage?.createdAt),
        workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
      }];
    });

  const deduped = new Map<string, ScoutMobileSessionSummary>();
  for (const summary of summaries) {
    const agent = summary.agentId ? snapshot.agents[summary.agentId] : null;
    const endpoint = summary.agentId ? endpointForAgent(snapshot, summary.agentId) : null;
    const branchQualifier =
      metadataString(endpoint?.metadata, "branch")
      ?? metadataString(endpoint?.metadata, "workspaceQualifier")
      ?? metadataString(agent?.metadata, "branch")
      ?? metadataString(agent?.metadata, "workspaceQualifier");
    const identityKey = [
      endpoint?.projectRoot?.trim().toLowerCase(),
      endpoint?.cwd?.trim().toLowerCase(),
      branchQualifier?.trim().toLowerCase(),
      endpoint?.harness?.trim().toLowerCase(),
      summary.agentName?.trim().toLowerCase(),
    ].filter((value): value is string => Boolean(value)).join("|") || summary.id;
    const existing = deduped.get(identityKey);
    if (!existing || (summary.lastMessageAt ?? 0) >= (existing.lastMessageAt ?? 0)) {
      deduped.set(identityKey, summary);
    }
  }

  return [...deduped.values()]
    .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
}

function messagesForConversation(
  snapshot: ScoutBrokerSnapshot,
  conversationId: string,
): MessageRecord[] {
  return Object.values(snapshot.messages)
    .filter((message) => !isBrokerRequesterWaitTimeoutStatusMessage(message))
    .filter((message) => message.conversationId === conversationId)
    .sort((left, right) => requireTimestampMs(left.createdAt) - requireTimestampMs(right.createdAt));
}

function pageMessagesForConversation(
  snapshot: ScoutBrokerSnapshot,
  conversationId: string,
  options: {
    beforeTurnId?: string | null;
    limit?: number | null;
  } = {},
): {
  messages: MessageRecord[];
  hasOlder: boolean;
  oldestTurnId: string | null;
  newestTurnId: string | null;
} {
  const allMessages = messagesForConversation(snapshot, conversationId);
  const normalizedLimit = Math.max(
    1,
    Math.floor(options.limit ?? (options.beforeTurnId ? DEFAULT_MOBILE_HISTORY_PAGE_LIMIT : DEFAULT_MOBILE_RECENT_TURN_LIMIT)),
  );

  if (allMessages.length === 0) {
    return {
      messages: [],
      hasOlder: false,
      oldestTurnId: null,
      newestTurnId: null,
    };
  }

  if (options.beforeTurnId) {
    const beforeIndex = allMessages.findIndex((message) => message.id === options.beforeTurnId);
    const endExclusive = beforeIndex >= 0 ? beforeIndex : allMessages.length;
    const start = Math.max(0, endExclusive - normalizedLimit);
    const messages = allMessages.slice(start, endExclusive);
    return {
      messages,
      hasOlder: start > 0,
      oldestTurnId: messages[0]?.id ?? null,
      newestTurnId: messages.at(-1)?.id ?? null,
    };
  }

  const start = Math.max(0, allMessages.length - normalizedLimit);
  const messages = allMessages.slice(start);
  return {
    messages,
    hasOlder: start > 0,
    oldestTurnId: messages[0]?.id ?? null,
    newestTurnId: messages.at(-1)?.id ?? null,
  };
}

function latestActiveFlightForAgent(
  snapshot: ScoutBrokerSnapshot,
  agentId: string | null,
): FlightRecord | null {
  if (!agentId) return null;
  return Object.values(snapshot.flights as Record<string, FlightRecord>)
    .filter((flight) => (
      flight.targetAgentId === agentId
      && (flight.state === "running" || flight.state === "waiting")
      && !isRequesterWaitTimeoutFlight(flight)
    ))
    .sort((left, right) => (normalizeTimestamp(right.startedAt) ?? 0) - (normalizeTimestamp(left.startedAt) ?? 0))[0] ?? null;
}

async function loadMobileRelayState(): Promise<{
  agents: ScoutMobileAgentSummary[];
  sessions: ScoutMobileSessionSummary[];
}> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { agents: [], sessions: [] };
  }

  // Build the SAME per-agent attention index the web /api/agents path uses, so
  // the phone's "Requests" band surfaces the identical set of waiting agents.
  // Never throws — a broken source yields an empty index, not an empty fleet.
  const attention = await readMobileAgentAttentionIndex(broker);

  const snapshot = broker.snapshot;
  const agents = Object.values(snapshot.agents)
    .filter((agent) => !isInactiveAgent(agent))
    .filter((agent) => {
      const endpoints = Object.values(snapshot.endpoints)
        .filter((endpoint) => endpoint.agentId === agent.id);
      return endpoints.length === 0 || endpoints.some((endpoint) => !isInactiveEndpoint(snapshot, endpoint));
    })
    .map((agent) => buildMobileAgentSummary(snapshot, agent, attention))
    .sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0) || left.title.localeCompare(right.title));

  return {
    agents,
    sessions: buildMobileSessionSummaries(snapshot),
  };
}

function matchesWorkspace(workspace: ScoutMobileWorkspaceSummary, query: string): boolean {
  return [
    workspace.title,
    workspace.projectName,
    workspace.root,
    workspace.relativePath,
    workspace.defaultHarness,
  ].some((value) => value.toLowerCase().includes(query));
}

function matchesAgent(agent: ScoutMobileAgentSummary, query: string): boolean {
  return [
    agent.title,
    agent.id,
    agent.selector ?? "",
    agent.defaultSelector ?? "",
    agent.workspaceRoot ?? "",
    agent.harness ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

function matchesSession(session: ScoutMobileSessionSummary, query: string): boolean {
  return [
    session.title,
    session.id,
    session.agentName ?? "",
    session.workspaceRoot ?? "",
    session.preview ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

export async function getScoutMobileHome(input: {
  currentDirectory?: string;
  workspaceLimit?: number;
  agentLimit?: number;
  sessionLimit?: number;
} = {}): Promise<ScoutMobileHomeState> {
  const [workspaces, relay] = await Promise.all([
    loadMobileWorkspaceInventory(input.currentDirectory),
    loadMobileRelayState(),
  ]);

  const workspaceLimit = input.workspaceLimit ?? 6;
  const agentLimit = input.agentLimit ?? 6;
  const sessionLimit = input.sessionLimit ?? 6;

  return {
    workspaces: workspaces.slice(0, workspaceLimit),
    agents: relay.agents.slice(0, agentLimit),
    sessions: relay.sessions.slice(0, sessionLimit),
    totals: {
      workspaces: workspaces.length,
      agents: relay.agents.length,
      sessions: relay.sessions.length,
    },
  };
}

export async function getScoutMobileWorkspaces(
  filters: ScoutMobileListFilters = {},
  currentDirectory?: string,
): Promise<ScoutMobileWorkspaceSummary[]> {
  const workspaces = await loadMobileWorkspaceInventory(currentDirectory);
  return withQueryAndLimit(workspaces, filters, matchesWorkspace);
}

export async function getScoutMobileAgents(
  filters: ScoutMobileListFilters = {},
  currentDirectory?: string,
): Promise<ScoutMobileAgentSummary[]> {
  void currentDirectory;
  const relay = await loadMobileRelayState();
  return withQueryAndLimit(relay.agents, filters, matchesAgent);
}

export async function getScoutMobileSessions(
  filters: ScoutMobileListFilters = {},
  currentDirectory?: string,
): Promise<ScoutMobileSessionSummary[]> {
  void currentDirectory;
  const relay = await loadMobileRelayState();
  return withQueryAndLimit(relay.sessions, filters, matchesSession);
}

export async function getScoutFleet(
  options?: Parameters<typeof queryFleet>[0],
): Promise<ReturnType<typeof queryFleet>> {
  return mobileReadWorker.read("fleet", options);
}

/**
 * Resolve whatever id the phone routed with onto a real broker conversation.
 * The phone may send a chat id directly or a bare agent id from the Agents tab.
 * Bare agent ids resolve to an existing direct chat by natural key, then to the
 * most-recent non-channel conversation the agent actually participates in.
 */
export function resolveMobileConversation(
  snapshot: ScoutBrokerSnapshot,
  rawId: string,
): ScoutBrokerConversationRecord | null {
  const direct = snapshot.conversations[rawId];
  if (direct) return direct;

  const directNaturalKey = directChannelNaturalKey(["operator", rawId]);
  const directByNaturalKey = Object.values(snapshot.conversations).find(
    (conversation) =>
      channelNaturalKeyFromMetadata(conversation.metadata) === directNaturalKey,
  );
  if (directByNaturalKey) return directByNaturalKey;

  const participating = Object.values(snapshot.conversations).filter(
    (conversation) => conversation.kind !== "channel" && conversation.participantIds?.includes(rawId),
  );
  if (participating.length === 0) return null;

  const lastActivityMs = (conversationId: string): number =>
    Object.values(snapshot.messages).reduce((latest, message) => {
      if (message.conversationId !== conversationId) return latest;
      return Math.max(latest, normalizeTimestampMs(message.createdAt) ?? 0);
    }, 0);

  return participating
    .slice()
    .sort((a, b) => lastActivityMs(b.id) - lastActivityMs(a.id))[0] ?? null;
}

export async function getScoutMobileSessionSnapshot(
  conversationId: string,
  options: {
    beforeTurnId?: string | null;
    limit?: number | null;
  } = {},
  currentDirectory?: string,
): Promise<ScoutMobileSessionSnapshot> {
  void currentDirectory;
  const broker = await requireMobileRelayContext();
  return buildMobileSessionSnapshot(broker.snapshot, conversationId, options);
}

export function buildMobileSessionSnapshot(
  snapshot: ScoutBrokerSnapshot,
  conversationId: string,
  options: { beforeTurnId?: string | null; limit?: number | null } = {},
): ScoutMobileSessionSnapshot {
  const conversation = resolveMobileConversation(snapshot, conversationId);
  // A known lane without a chat renders empty history, never a global room.
  if (!conversation) {
    const inferredAgentId = snapshot.agents[conversationId] ? conversationId : null;
    if (!inferredAgentId) throw new Error(`Unknown mobile session "${conversationId}".`);
    const agent = inferredAgentId ? snapshot.agents[inferredAgentId] : null;
    const endpoint = inferredAgentId ? endpointForAgent(snapshot, inferredAgentId) : null;
    const agentName = agent
      ? agentDisplayName(snapshot, inferredAgentId!)
      : inferredAgentId ?? conversationId;
    return {
      session: {
        id: conversationId,
        name: agentName,
        adapterType: endpoint?.harness ?? "relay",
        status: endpoint?.state === "offline" ? "idle" : "active",
        cwd: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
        model: typeof endpoint?.metadata?.model === "string" ? endpoint.metadata.model : null,
        providerMeta: {
          conversationId: null,
          conversationKind: "direct",
          agentId: inferredAgentId,
          workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
          harness: endpoint?.harness ?? null,
          selector: agent?.selector ?? null,
          defaultSelector: agent?.defaultSelector ?? null,
          project: agentName,
          currentBranch:
            metadataString(endpoint?.metadata, "branch")
            ?? metadataString(endpoint?.metadata, "workspaceQualifier")
            ?? metadataString(agent?.metadata, "branch")
            ?? metadataString(agent?.metadata, "workspaceQualifier"),
          workspaceQualifier:
            metadataString(endpoint?.metadata, "workspaceQualifier")
            ?? metadataString(agent?.metadata, "workspaceQualifier"),
        },
      },
      history: { hasOlder: false, oldestTurnId: null, newestTurnId: null },
      turns: [],
      currentTurnId: null,
    };
  }


  const directAgentId = conversation.kind === "direct"
    ? conversation.participantIds.find((participantId) => participantId !== "operator") ?? null
    : null;
  const endpoint = directAgentId ? endpointForAgent(snapshot, directAgentId) : null;
  const agent = directAgentId ? snapshot.agents[directAgentId] : null;
  const messagePage = pageMessagesForConversation(snapshot, conversation.id, options);
  const messages = messagePage.messages;
  const title = mobileConversationTitle(snapshot, conversation, directAgentId);
  const activeFlight = latestActiveFlightForAgent(snapshot, directAgentId);
  const lastAgentMessageAt = messages
    .filter((message) => message.actorId === directAgentId)
    .reduce<number | null>((latest, message) => {
      const createdAt = normalizeTimestampMs(message.createdAt);
      return typeof createdAt === "number" && (!latest || createdAt > latest) ? createdAt : latest;
    }, null);
  const shouldShowWorkingTurn = Boolean(
    activeFlight
    && ((normalizeTimestampMs(activeFlight.startedAt) ?? 0) > (lastAgentMessageAt ?? 0)),
  );

  const turns: ScoutMobileSessionSnapshot["turns"] = messages.map((message) => ({
    id: message.id,
    status: "completed",
    blocks: [{
      block: {
        id: `${message.id}:body`,
        turnId: message.id,
        type: message.class === "system" ? "reasoning" : "text",
        status: "completed",
        index: 0,
        text: message.body,
      },
      status: "completed",
    }, ...((message.attachments ?? []).map((attachment, index) => ({
      block: {
        id: `${message.id}:attachment:${attachment.id}`,
        turnId: message.id,
        type: "file" as const,
        status: "completed" as const,
        index: index + 1,
        mimeType: attachment.mediaType,
        name: attachment.fileName ?? attachment.url ?? attachment.id,
        url: attachment.url,
      },
      status: "completed" as const,
    })))],
    startedAt: normalizeTimestampMs(message.createdAt) ?? Date.now(),
    endedAt: normalizeTimestampMs(message.createdAt) ?? Date.now(),
    isUserTurn: message.actorId === "operator",
    clientMessageId: metadataString(message.metadata, "clientMessageId"),
  }));

  if (!options.beforeTurnId && shouldShowWorkingTurn && activeFlight) {
    turns.push({
      id: `flight:${activeFlight.id}`,
      status: "streaming",
      blocks: [{
        block: {
          id: `flight:${activeFlight.id}:status`,
          turnId: `flight:${activeFlight.id}`,
          type: "reasoning",
          status: "streaming",
          index: 0,
          text: activeFlight.summary?.trim() || "Working…",
        },
        status: "streaming",
      }],
      startedAt: normalizeTimestampMs(activeFlight.startedAt) ?? Date.now(),
      isUserTurn: false,
    });
  }

  return {
    session: {
      id: conversation.id,
      name: title,
      adapterType: endpoint?.harness ?? "relay",
      status: shouldShowWorkingTurn ? "active" : endpoint?.state === "offline" ? "idle" : "active",
      cwd: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
      model: typeof endpoint?.metadata?.model === "string" ? endpoint.metadata.model : null,
      providerMeta: {
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        agentId: directAgentId,
        workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
        harness: endpoint?.harness ?? null,
        selector: agent?.selector ?? null,
        defaultSelector: agent?.defaultSelector ?? null,
        project: directAgentId ? agentDisplayName(snapshot, directAgentId) : title,
        currentBranch:
          metadataString(endpoint?.metadata, "branch")
          ?? metadataString(endpoint?.metadata, "workspaceQualifier")
          ?? metadataString(agent?.metadata, "branch")
          ?? metadataString(agent?.metadata, "workspaceQualifier"),
        workspaceQualifier:
          metadataString(endpoint?.metadata, "workspaceQualifier")
          ?? metadataString(agent?.metadata, "workspaceQualifier"),
      },
    },
    history: {
      hasOlder: messagePage.hasOlder,
      oldestTurnId: messagePage.oldestTurnId,
      newestTurnId: messagePage.newestTurnId,
    },
    turns,
    currentTurnId: shouldShowWorkingTurn && activeFlight ? `flight:${activeFlight.id}` : null,
  };
}

export async function createScoutSession(
  input: CreateScoutSessionInput,
  currentDirectory?: string,
  deviceId?: string,
): Promise<ScoutMobileSessionHandle> {
  // The mobile client passes a projectRoot path as workspaceId. Valid current
  // directories stay on the hot path; missing/legacy paths take the guarded
  // inventory fallback before we construct the minimal downstream summary.
  const rawWorkspaceId = input.workspaceId?.trim();
  if (!rawWorkspaceId) {
    throw new Error(`Invalid workspaceId.`);
  }
  const workspaceRoot = await resolveMobileWorkspaceRoot(rawWorkspaceId, currentDirectory);
  const projectName = basename(workspaceRoot) || workspaceRoot;
  const checkout = await readGitCheckout(workspaceRoot);
  const workspace: ScoutMobileWorkspaceSummary = {
    id: workspaceRoot,
    title: projectName,
    projectName,
    root: workspaceRoot,
    sourceRoot: workspaceRoot,
    relativePath: workspaceRoot.replace(`${process.env.HOME ?? ""}/`, ""),
    registrationKind: "configured",
    branch: checkout?.branch ?? null,
    isWorktree: checkout?.isWorktree ?? false,
    defaultHarness: input.harness ?? "claude",
    harnesses: [],
  };

  // When forceNew is true, generate a unique agent name so it gets
  // a fresh agent ID and conversation (the broker derives conversation ID
  // deterministically from the agent ID).
  const agentName = input.forceNew
    ? await deriveNewAgentName(workspace.projectName, input.branch, input.harness)
    : workspace.projectName;

  // If worktree requested, create a git worktree so the agent works in isolation.
  let agentCwd = workspace.root;
  let worktreeCreated = false;
  if (input.worktree) {
    const worktreeResult = await createGitWorktree(workspace.root, agentName, input.branch);
    if (worktreeResult) {
      agentCwd = worktreeResult.path;
      worktreeCreated = true;
    }
  }

  // projectPath = original root (for agent config resolution)
  // cwdOverride = worktree path (agent works here instead of project root)
  const localAgent = await upScoutAgent({
    projectPath: workspace.root,
    agentName,
    harness: input.harness,
    currentDirectory: currentDirectory ?? workspace.root,
    cwdOverride: agentCwd !== workspace.root ? agentCwd : undefined,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    permissionProfile: input.profile?.trim() || undefined,
    branch: input.branch,
  });

  const broker = await loadScoutBrokerContext();
  const bindingSync = await registerScoutLocalAgentBinding({
    agentId: localAgent.agentId,
    broker,
  });
  const resolvedAgentId = bindingSync?.binding.agent.id ?? localAgent.agentId;

  const directSession = await openScoutPeerSession({
    sourceId: "operator",
    targetId: resolvedAgentId,
    currentDirectory: currentDirectory ?? workspace.root,
  });

  const snapshot = broker?.snapshot;
  const targetAgentId = directSession.targetId;
  const brokerAgent = snapshot?.agents[targetAgentId] ?? null;
  const brokerEndpoint = snapshot ? endpointForAgent(snapshot, targetAgentId) : null;
  const agentTitle = brokerAgent && snapshot
    ? agentDisplayName(snapshot, brokerAgent.id)
    : localAgent.projectName;

  const agentSummary: ScoutMobileAgentSummary = {
    id: targetAgentId,
    title: agentTitle,
    selector: brokerAgent?.selector ?? null,
    defaultSelector: brokerAgent?.defaultSelector ?? null,
    workspaceRoot: brokerEndpoint?.projectRoot ?? brokerEndpoint?.cwd ?? workspace.root,
    harness: brokerEndpoint?.harness ?? localAgent.harness,
    transport: localAgent.transport,
    state: brokerEndpoint?.state === "offline" ? "offline" : "available",
    statusLabel: brokerEndpoint?.state === "offline" ? "Offline" : "Available",
    sessionId: localAgent.sessionId,
    harnessSessionId: mobileEndpointHarnessSessionId(brokerEndpoint),
    conversationId: directSession.conversation.id,
    lastActiveAt: null,
    needsAttention: false,
    pendingAsk: null,
  };

  const seedInstructions = input.seed?.instructions?.trim() ?? "";
  const seedAttachments = input.seed?.attachments;
  const seedDelivery = seedInstructions || seedAttachments?.length
    ? await sendScoutDirectMessage({
        agentId: targetAgentId,
        body: seedInstructions,
        attachments: seedAttachments,
        currentDirectory: currentDirectory ?? workspace.root,
        executionHarness: input.harness,
        executionModel: input.model,
        executionReasoningEffort: input.reasoningEffort,
        source: "scout-mobile",
        deviceId,
      })
    : null;

  return {
    workspace,
    agent: agentSummary,
    session: {
      conversationId: seedDelivery?.conversationId ?? directSession.conversation.id,
      title: agentTitle,
      existed: directSession.existed,
    },
    messageId: seedDelivery?.messageId ?? null,
    flightId: seedDelivery?.flight?.id ?? null,
    unsupported: [
      ...(input.worktree && !worktreeCreated ? ["worktree" as const] : []),
    ],
  };
}

export async function sendScoutMobileMessage(
  input: SendScoutMobileMessageInput,
  currentDirectory?: string,
  deviceId?: string,
): Promise<ScoutDirectMessageResult> {
  if (input.agentId === SCOUTBOT_AGENT_ID) {
    const result = await postScoutbotOperatorMessage({
      currentDirectory: currentDirectory ?? process.cwd(),
      body: input.body,
      attachments: input.attachments,
      source: input.source ?? "scout-mobile",
      clientMessageId: input.clientMessageId,
      replyToMessageId: input.replyToMessageId,
      referenceMessageIds: input.referenceMessageIds,
      deviceId,
    });
    if (!result.usedBroker || !result.conversationId || !result.messageId) {
      throw new Error("Scoutbot is not available.");
    }
    return {
      conversationId: result.conversationId,
      messageId: result.messageId,
    };
  }

  return sendScoutDirectMessage({
    agentId: input.agentId,
    body: input.body,
    attachments: input.attachments,
    currentDirectory,
    clientMessageId: input.clientMessageId,
    replyToMessageId: input.replyToMessageId,
    referenceMessageIds: input.referenceMessageIds,
    executionHarness: input.harness,
    source: input.source ?? "scout-mobile",
    deviceId,
  });
}

/** Mint a collision-free provisional agent name from the curated rotation pool. */
async function deriveNewAgentName(
  projectName: string,
  branch?: string,
  harness?: string,
): Promise<string> {
  const broker = await loadScoutBrokerContext();
  const occupied = broker
    ? collectOccupiedDefinitionIdsFromBrokerSnapshot(broker.snapshot)
    : new Set<string>();
  return resolveProjectProvisionalAgentName({
    occupied,
    seedParts: [
      "mobile-new-project-agent",
      projectName,
      branch ?? "",
      harness ?? "",
    ],
  });
}

/**
 * Create an isolated git worktree for an agent session.
 *
 * Delegates to the shared runtime helper (createAgentWorkspace), which
 * materializes a `git worktree` on branch `scout/<agentName>` under
 * `<projectRoot>/.scout-worktrees/<agentName>`. Kept as a thin wrapper so
 * callers retain the historical `createGitWorktree` name and `{ path, branch }`
 * shape.
 *
 * Returns the worktree path + branch, or null if the project isn't a git repo.
 */
async function createGitWorktree(
  projectRoot: string,
  agentName: string,
  requestedBranch?: string,
): Promise<{ path: string; branch: string } | null> {
  const result = await createAgentWorkspace(projectRoot, agentName, requestedBranch);
  if (!result) return null;
  return { path: result.path, branch: result.branch };
}

async function requireMobileRelayContext() {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    throw new Error("Relay is not reachable.");
  }
  return broker;
}

// -- Activity Feed --------------------------------------------------------

export type ScoutMobileActivityFilters = {
  agentId?: string;
  actorId?: string;
  conversationId?: string;
  limit?: number;
};

export async function getScoutMobileActivity(
  filters: ScoutMobileActivityFilters = {},
): Promise<ScoutBrokerHomeActivityRecord[]> {
  // Home is an orientation surface: show the actual recent exchanges Scout
  // mediated, not the raw `/v1/activity` lifecycle firehose. Reading the broker
  // message ledger directly also avoids depending on the optional home activity
  // projection, which may legitimately be empty after a broker restart.
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    const home = await readScoutBrokerHome();
    // The home projection predates harness attribution; be explicit that this
    // path carries none rather than leaking `undefined` onto the wire.
    return (home?.activity ?? [])
      .slice(0, filters.limit ?? 100)
      .map((record) => ({ ...record, harness: record.harness ?? null }));
  }

  const { snapshot } = broker;
  const selfIds = operatorActorIds();
  const mediatedKinds = new Set(["channel", "direct", "group_direct", "thread"]);
  const rows = Object.values(snapshot.messages ?? {})
    .filter((message) => {
      const conversation = snapshot.conversations?.[message.conversationId];
      if (!conversation || !mediatedKinds.has(conversation.kind)) return false;
      if (filters.agentId && message.actorId !== filters.agentId) return false;
      if (filters.actorId && message.actorId !== filters.actorId) return false;
      if (filters.conversationId && message.conversationId !== filters.conversationId) return false;
      return true;
    })
    .sort((left, right) => requireTimestampMs(right.createdAt) - requireTimestampMs(left.createdAt))
    .map((message): ScoutBrokerHomeActivityRecord => {
      const conversation = snapshot.conversations[message.conversationId]!;
      const actorName = commsActorLabel(snapshot, message.actorId, selfIds);
      const channel = conversation.kind === "channel"
        ? channelNaturalKeyFromMetadata(conversation.metadata) ?? conversation.title ?? null
        : null;
      return {
        id: message.id,
        kind: message.class === "status" || message.actorId === "system" ? "system" : "message",
        actorId: message.actorId,
        actorName,
        title: actorName,
        detail: message.body,
        conversationId: message.conversationId,
        channel,
        timestamp: requireTimestampMs(message.createdAt),
        harness: harnessForActor(snapshot, message.actorId),
      };
    });

  const limit = filters.limit && filters.limit > 0 ? Math.floor(filters.limit) : 100;
  return rows.slice(0, limit);
}

// -- Service budgets (usage quotas) --------------------------------------
//
// The phone's usage-quota readout: Claude / Codex / Kimi / GitHub. Projects the web
// `loadServiceBudgets()` gauges (which carry per-window quota detail) down to a
// per-provider row that PRESERVES each provider's individual quota windows so
// the phone can render one meter per window (e.g. Claude 5h + weekly) instead of
// a single collapsed percent. Windows are emitted in source order (short window
// first). Every provider the aggregator reports is sent, in its order: a quota
// provider with live windows, or a status provider as `activity` text. The
// phone arranges and hides them itself (Settings › Home quotas).

export type ScoutMobileServiceBudgetWindow = {
  /// Short window label, e.g. "5h", "wk", "7d".
  label: string;
  /// Fraction of the window used, 0-100, rounded to an integer.
  usedPercent: number;
  /// Absolute reset time in epoch milliseconds. The phone uses this to reject
  /// stale pre-reset samples reported by another paired Mac.
  resetAt: number;
  /// Short reset text, e.g. "48m", "4d", "Sun"; "" when unknown or already past.
  reset: string;
};

export type ScoutMobileServiceBudget = {
  provider: string;
  /// Display name, e.g. "Claude".
  label: string;
  /// Plan/tier string from the gauge (for example Kimi's membership level); "" if none.
  plan: string;
  /// Per-window meters in source order (short window first).
  windows: ScoutMobileServiceBudgetWindow[];
  /// Observed activity for a provider with no readable quota (Grok's local
  /// telemetry), e.g. "138M tokens · 7d". Only set when `windows` is empty.
  activity?: string;
};

const MOBILE_RESET_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/// Display name: the gauge's own label, capitalized ("grok" → "Grok").
function mobileServiceBudgetLabel(gauge: ServiceGauge): string {
  const label = gauge.label?.trim() || gauge.id;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/// Short reset text for a single window: minutes under an hour ("48m"), hours
/// under two days ("4h"), days under a week ("4d"), then the weekday name for
/// anything a week or more out ("Sun"). "" when the reset is unknown or already
/// in the past.
function formatMobileWindowReset(resetAt: number): string {
  const deltaMs = resetAt - Date.now();
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return "";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return MOBILE_RESET_WEEKDAYS[new Date(resetAt).getDay()] ?? `${days}d`;
}

/// A provider's plan/tier string, if the gauge ever surfaces one. Today's
/// aggregator carries no plan/tier (the quota gauge only exposes a provider slug
/// in `label`), so this resolves to "" — but reading it defensively here means a
/// future aggregator that populates a plan flows through without a phone change.
function mobileServiceBudgetPlan(gauge: ServiceGauge): string {
  const plan = (gauge as { plan?: unknown }).plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan.trim() : "";
}

/// Project one quota gauge onto the phone's per-provider budget row, preserving
/// each quota window as its own meter. A status gauge (no quota) becomes a row
/// with `activity` text. Returns null for a quota gauge with no live windows or
/// a status gauge with nothing to say.
export function mobileServiceBudgetFromGauge(gauge: ServiceGauge): ScoutMobileServiceBudget | null {
  const provider = gauge.id;
  if (!provider) return null;
  if (gauge.kind === "status") {
    // No quota to meter: carry the lead of the activity readout instead.
    const lead = gauge.detailLabel?.split("·")[0]?.trim();
    if (!lead) return null;
    const window = gauge.windowLabel?.replace(/^observed\s+/u, "").trim();
    return {
      provider,
      label: mobileServiceBudgetLabel(gauge),
      plan: "",
      windows: [],
      activity: window ? `${lead} · ${window}` : lead,
    };
  }
  if (gauge.kind !== "quota") return null;

  // Each window carries a `fill` (0-1 fraction used). Preserve source order (the
  // aggregator already sorts short window → long window, e.g. 5h → 7d).
  const now = Date.now();
  const windows: ScoutMobileServiceBudgetWindow[] = (gauge.windows ?? [])
    .filter((window) => Number.isFinite(window.resetAt) && window.resetAt > now)
    .map((window) => ({
      label: window.label,
      usedPercent: Math.round(Math.max(0, Math.min(1, window.fill)) * 100),
      resetAt: window.resetAt,
      reset: formatMobileWindowReset(window.resetAt),
    }));
  if (windows.length === 0) return null;

  return {
    provider,
    label: mobileServiceBudgetLabel(gauge),
    plan: mobileServiceBudgetPlan(gauge),
    windows,
  };
}

/// The phone's usage-quota surface. Reads the shared service-budget aggregator
/// (same source as web `GET /api/service-budgets`) and returns each provider's
/// individual quota windows so the phone renders one meter per window. No params;
/// accepts and ignores an empty object.
export async function getScoutMobileServiceBudgets(
  _filters: Record<string, never> = {},
): Promise<{ budgets: ScoutMobileServiceBudget[] }> {
  void _filters;
  const response = await loadServiceBudgets();
  const budgets = response.gauges
    .map(mobileServiceBudgetFromGauge)
    .filter((budget): budget is ScoutMobileServiceBudget => budget !== null);
  return { budgets };
}

// -- Terminal sessions ---------------------------------------------------
//
// The phone's terminal-session surface. Reads the terminal-session registry
// (same source as web terminal handoff) and flattens each record onto a flat
// row the phone can render without joining against surfaces. `running` collapses
// the record's per-surface state to a single "any surface live" flag. No params.

export type ScoutMobileTerminal = {
  id: string;
  /// Harness-native session id — the stable session identity across surfaces.
  sessionId: string;
  /// Working directory, verbatim (full path).
  cwd: string;
  /// The command to resume/attach the session.
  command: string;
  /// Owning harness, e.g. "claude", "codex".
  harness: string;
  /// True when any surface on the record is live (not detached/exited).
  running: boolean;
  /// Last-updated timestamp, ms epoch (integer).
  updatedAt: number;
};

/// The phone's terminal-session surface. Reads the terminal-session registry
/// and returns a flat row per recent session (most-recently-updated first).
/// `queryTerminalSessions` already orders by updated_at DESC and tolerates a
/// missing registry table; the try/catch is a defensive belt-and-braces.
export async function getScoutMobileTerminals(): Promise<{ terminals: ScoutMobileTerminal[] }> {
  try {
    const records = await mobileReadWorker.read("terminalSessions", { limit: 12 });
    const terminals: ScoutMobileTerminal[] = records.map((record) => ({
      id: record.id,
      sessionId: record.sourceSessionId,
      cwd: record.cwd,
      command: record.resumeCommand,
      harness: record.harness,
      running: record.surfaces.some((surface) => surface.state === "live"),
      updatedAt: record.updatedAt,
    }));
    return { terminals };
  } catch {
    return { terminals: [] };
  }
}

// -- Comms (channels + DMs) ----------------------------------------------
//
// The phone's mesh-comms surface. Reads channels/DMs straight from the broker
// snapshot (conversations + messages + actors, all in memory) and flattens them
// for the phone — participants and authors pre-resolved to display labels so the
// client never joins against the actor table. Posting routes by conversation
// kind: channels via `sendScoutMessage`, DMs via the existing direct-message path.

const MOBILE_OPERATOR_ID = "operator";

/// Actor ids that represent "you" (the phone operator): the canonical "operator"
/// plus the configured operator name/handle. Older DMs and read cursors can be
/// authored under the configured identity (e.g. "dm.arach.hudson…" by "arach"),
/// so a single hard-coded id would mislabel the counterpart and miscount unread.
function operatorActorIds(): Set<string> {
  const ids = new Set<string>([MOBILE_OPERATOR_ID]);
  const name = resolveOperatorName().trim();
  if (name) {
    ids.add(name);
    ids.add(name.toLowerCase());
  }
  return ids;
}

export type ScoutMobileCommsConversation = {
  id: string;
  kind: "channel" | "direct" | "group" | "thread" | "system" | "unknown";
  title: string;
  participants: string[];
  topic: string | null;
  lastMessagePreview: string | null;
  lastMessageAuthor: string | null;
  lastMessageAt: number | null;
  messageCount: number;
  unreadCount: number;
};

export type ScoutMobileCommsMessage = {
  id: string;
  conversationId: string;
  actorId: string;
  authorLabel: string;
  authorKind: "person" | "agent" | "system";
  body: string;
  createdAt: number;
  replyToMessageId: string | null;
  isOperator: boolean;
  clientMessageId: string | null;
  attachments: Array<{
    id: string;
    mediaType: string;
    fileName?: string;
    blobKey?: string;
    url?: string;
  }>;
};

function commsActorLabel(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  selfIds: Set<string>,
): string {
  if (selfIds.has(actorId)) return "You";
  return snapshot.agents[actorId]?.displayName
    ?? snapshot.actors[actorId]?.displayName
    ?? actorId;
}

function commsAuthorKind(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  selfIds: Set<string>,
): "person" | "agent" | "system" {
  if (selfIds.has(actorId)) return "person";
  if (snapshot.agents[actorId]) return "agent";
  const kind = snapshot.actors[actorId]?.kind;
  if (kind === "person") return "person";
  if (kind === "agent") return "agent";
  return "system";
}

function commsMobileKind(kind: string): ScoutMobileCommsConversation["kind"] {
  switch (kind) {
    case "channel": return "channel";
    case "direct": return "direct";
    case "group_direct": return "group";
    case "thread": return "thread";
    case "system": return "system";
    default: return "unknown";
  }
}

export async function getScoutMobileConversations(
  filters: { kind?: string; limit?: number } = {},
): Promise<ScoutMobileCommsConversation[]> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return [];
  const { snapshot } = broker;
  const selfIds = operatorActorIds();

  const byConversation = new Map<string, MessageRecord[]>();
  for (const message of Object.values(snapshot.messages ?? {})) {
    const bucket = byConversation.get(message.conversationId);
    if (bucket) bucket.push(message);
    else byConversation.set(message.conversationId, [message]);
  }

  const operatorReadAt = new Map<string, number>();
  for (const cursor of Object.values(snapshot.readCursors ?? {})) {
    if (selfIds.has(cursor.actorId)) {
      const prev = operatorReadAt.get(cursor.conversationId) ?? 0;
      operatorReadAt.set(cursor.conversationId, Math.max(prev, normalizeTimestampMs(cursor.lastReadAt) ?? 0));
    }
  }

  const includeKinds = new Set(["channel", "direct", "group_direct", "thread"]);
  const rows: ScoutMobileCommsConversation[] = [];
  for (const conv of Object.values(snapshot.conversations ?? {})) {
    if (!includeKinds.has(conv.kind)) continue;
    const mobileKind = commsMobileKind(conv.kind);
    if (filters.kind && filters.kind !== mobileKind) continue;

    const messages = (byConversation.get(conv.id) ?? [])
      .sort((a, b) => requireTimestampMs(a.createdAt) - requireTimestampMs(b.createdAt));
    const last = messages[messages.length - 1];
    const readAt = operatorReadAt.get(conv.id);
    const unread = readAt != null
      ? messages.filter((m) => requireTimestampMs(m.createdAt) > readAt && !selfIds.has(m.actorId)).length
      : 0;
    const directAgentId = conv.kind === "direct"
      ? conv.participantIds.find((participantId) => !selfIds.has(participantId)) ?? null
      : null;

    rows.push({
      id: conv.id,
      kind: mobileKind,
      title: mobileConversationTitle(snapshot, conv, directAgentId),
      participants: conv.participantIds
        .filter((p) => !selfIds.has(p))
        .map((p) => commsActorLabel(snapshot, p, selfIds)),
      topic: conv.topic ?? null,
      lastMessagePreview: last ? last.body.replace(/\s+/g, " ").trim().slice(0, 140) : null,
      lastMessageAuthor: last ? commsActorLabel(snapshot, last.actorId, selfIds) : null,
      lastMessageAt: last ? normalizeTimestampMs(last.createdAt) : null,
      messageCount: messages.length,
      unreadCount: unread,
    });
  }

  rows.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  const limit = filters.limit && filters.limit > 0 ? filters.limit : 100;
  return rows.slice(0, limit);
}

export async function getScoutMobileConversationMessages(
  conversationId: string,
  limit = 200,
): Promise<ScoutMobileCommsMessage[]> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return [];
  const { snapshot } = broker;
  const selfIds = operatorActorIds();

  const messages = Object.values(snapshot.messages ?? {})
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => requireTimestampMs(a.createdAt) - requireTimestampMs(b.createdAt));
  const trimmed = limit > 0 && messages.length > limit
    ? messages.slice(messages.length - limit)
    : messages;

  return trimmed.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    actorId: m.actorId,
    authorLabel: commsActorLabel(snapshot, m.actorId, selfIds),
    authorKind: commsAuthorKind(snapshot, m.actorId, selfIds),
    body: m.body,
    createdAt: requireTimestampMs(m.createdAt),
    replyToMessageId: m.replyToMessageId ?? null,
    isOperator: selfIds.has(m.actorId),
    clientMessageId: metadataString(m.metadata, "clientMessageId"),
    attachments: (m.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      mediaType: attachment.mediaType,
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.blobKey ? { blobKey: attachment.blobKey } : {}),
      ...(attachment.url ? { url: attachment.url } : {}),
    })),
  }));
}

export async function sendScoutMobileComms(
  input: {
    conversationId: string;
    body: string;
    attachments?: OutgoingAttachmentInput[];
    replyToMessageId?: string | null;
    clientMessageId?: string | null;
  },
  currentDirectory?: string,
  deviceId?: string,
): Promise<ScoutMobileSendResult> {
  const broker = await loadScoutBrokerContext();
  if (!broker) throw new Error("Relay is not reachable.");
  const conv = broker.snapshot.conversations?.[input.conversationId];
  if (!conv) {
    throw new Error(`Unknown conversation: ${input.conversationId}`);
  }
  const selfIds = operatorActorIds();

  // 1:1 DMs route through the direct-message path, addressed to the single
  // non-self participant (it resolves to this same conversation).
  if (conv.kind === "direct") {
    const targetAgentId = conv.participantIds.find((p) => !selfIds.has(p));
    if (!targetAgentId) throw new Error("Conversation has no agent participant to address.");
    try {
      const result = await sendScoutMobileMessage(
        {
          agentId: targetAgentId,
          body: input.body,
          attachments: input.attachments,
          clientMessageId: input.clientMessageId,
          replyToMessageId: input.replyToMessageId,
        },
        currentDirectory,
        deviceId,
      );
      return mobileSendResultFromDirect(result);
    } catch (error) {
      if (!(error instanceof ScoutDirectDeliveryUnavailableError)) throw error;

      // Routing/session liveness is broker-owned, but drafting is not. Keep the
      // operator's outbound message in the conversation even when its transport
      // cannot currently attach, and return a typed recovery action to the app.
      const persisted = await sendScoutConversationMessage({
        conversationId: input.conversationId,
        senderId: MOBILE_OPERATOR_ID,
        body: input.body.trim() || (input.attachments?.length ? "Review the attached message." : ""),
        attachments: input.attachments,
        replyToMessageId: input.replyToMessageId,
        clientMessageId: input.clientMessageId,
        source: "scout-mobile",
        currentDirectory,
      });
      if (!persisted.usedBroker || !persisted.messageId) {
        throw new Error("The broker disconnected before it could save this message.");
      }
      const delivery = recoverableMobileDelivery(error);
      return {
        conversationId: persisted.conversationId ?? input.conversationId,
        messageId: persisted.messageId,
        flightId: null,
        invocationId: null,
        targetAgentId,
        lifecycleState: "failed",
        summary: delivery.detail ?? null,
        error: null,
        delivery,
      };
    }
  }

  // Groups and threads must post to THIS conversation — collapsing to a 1:1 DM
  // with the first participant would land the message in the wrong room.
  if (conv.kind === "group_direct" || conv.kind === "thread") {
    const result = await sendScoutConversationMessage({
      conversationId: input.conversationId,
      senderId: MOBILE_OPERATOR_ID,
      body: input.body,
      attachments: input.attachments,
      replyToMessageId: input.replyToMessageId,
      clientMessageId: input.clientMessageId,
      source: "scout-mobile",
      currentDirectory,
    });
    return {
      conversationId: result.conversationId ?? input.conversationId,
      messageId: result.messageId ?? `local-${Date.now().toString(36)}`,
      flightId: null,
      invocationId: null,
      targetAgentId: null,
      lifecycleState: null,
      summary: null,
      error: null,
    };
  }

  // Channels: post as the operator to the channel name carried in metadata.
  const channel = typeof conv.metadata?.channel === "string" && conv.metadata.channel.trim()
    ? conv.metadata.channel.trim()
    : conv.title;
  const result = await sendScoutMessage({
    senderId: MOBILE_OPERATOR_ID,
    body: input.body,
    channel,
    attachments: input.attachments,
    clientMessageId: input.clientMessageId,
    currentDirectory,
  });
  return {
    conversationId: result.conversationId ?? input.conversationId,
    messageId: result.messageId ?? `local-${Date.now().toString(36)}`,
    flightId: result.flight?.id ?? null,
    invocationId: result.flight?.invocationId ?? null,
    targetAgentId: result.flight?.targetAgentId ?? null,
    lifecycleState: mobileLifecycleStateForFlight(result.flight),
    summary: result.flight?.summary ?? null,
    error: result.flight?.error ?? null,
  };
}

/// Mark a conversation read for the phone operator — advances the operator's
/// read cursor so `getScoutMobileConversations` stops counting these messages as
/// unread. The cursor is attributed to `MOBILE_OPERATOR_ID`, which is one of the
/// `operatorActorIds()` the unread tally recognizes. With no `lastReadMessageId`
/// the broker marks read through the latest message, so the badge clears to 0.
export async function markScoutMobileConversationRead(input: {
  conversationId: string;
  lastReadMessageId?: string | null;
}): Promise<{ conversationId: string; unreadCount: number }> {
  const broker = await loadScoutBrokerContext();
  if (!broker) throw new Error("Relay is not reachable.");
  if (!broker.snapshot.conversations?.[input.conversationId]) {
    throw new Error(`Unknown conversation: ${input.conversationId}`);
  }

  // Anchor the cursor on a CONCRETE message id, not broker inference. If we let
  // the broker infer (no message id), it auto-fills `lastReadSeq = latestThreadSeq`
  // — a small integer — and `resolveReadCursor`'s monotonic guard ranks that
  // against existing cursors, which rank by message `createdAt` (a ~1e12 ms
  // timestamp). The small seq always loses, so the guard reverts the write and
  // `lastReadAt` never advances (the badge never clears). Passing an explicit
  // `lastReadMessageId` makes the broker rank by that message's createdAt, which
  // is newer than the prior cursor ⇒ it advances. See SCO-061 read-cursor flow.
  let lastReadMessageId = input.lastReadMessageId ?? undefined;
  if (!lastReadMessageId) {
    let latest: { id: string; createdAt: number } | undefined;
    for (const m of Object.values(broker.snapshot.messages ?? {})) {
      if (m.conversationId !== input.conversationId) continue;
      const createdAt = requireTimestampMs(m.createdAt);
      if (!latest || createdAt > latest.createdAt) latest = { id: m.id, createdAt };
    }
    lastReadMessageId = latest?.id;
  }

  await recordScoutBrokerReadCursor(
    {
      conversationId: input.conversationId,
      actorId: MOBILE_OPERATOR_ID,
      lastReadMessageId,
    },
    broker.baseUrl,
  );
  // Read through the latest message ⇒ caught up. The next list pull reconciles
  // if a new inbound message landed in the same instant.
  return { conversationId: input.conversationId, unreadCount: 0 };
}
