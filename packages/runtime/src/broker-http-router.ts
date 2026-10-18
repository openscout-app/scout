import { completionReply } from "@openscout/protocol";
import { PermissionDeliveryUnconfirmedError, type BrokerPermissionService } from "./broker-permission-service.js";
import { BrokerBusyError } from "./broker-storage-pressure.js";
import { handleBrokerHistoryRoute, type BrokerHistoryQueries } from "./broker-history-http-service.js";
import { handleBrokerQuarantineRoute, type BrokerQuarantineQueries } from "./broker-quarantine-http-service.js";
import { createHash } from "node:crypto";
import { BrokerRequestReceipts } from "./broker-request-receipts.js";
import { hasRetiredEndpointRegistration } from "./broker-endpoint-selection.js";
import { handleBrokerAccessRoute, type BrokerAccessHttpDeps } from "./broker-access-http-routes.js";
import { handleBrokerMcpEvents } from "./broker-mcp-event-routes.js";
import type { BrokerMcpEvents } from "./broker-mcp-events.js";
import { handleBrokerMeshApprovalsRoute, type MeshApprovalsHttpDeps } from "./mesh-approvals.js";
import type { IntegrationSlackEvents } from "./integration-slack-events.js";
import type { IntegrationSlackDeliveryService } from "./integration-slack-delivery.js";
import { BrokerIntegrationSetupService, IntegrationSetupError } from "./broker-integration-setup.js";
import { deckLanes } from "./deck-lanes.js";
import { isAllowedHostWebRequest, type HostWebRequest, type HostWebResponse } from "./host-web-request.js";
import { ChatQuestionError } from "./chat-question-transition.js";
import { ChatMessageCorrectionError } from "@openscout/protocol";
import type { BrokerExternalSessionService } from "./broker-external-session-service.js";
import { writeBrokerSnapshot } from "./broker-snapshot-response.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
import { performance } from "node:perf_hooks";

import type {
  A2AJsonRpcRequest,
  ActorIdentity,
  AgentEndpoint,
  CollaborationRecord,
  ControlCommand,
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryIntent,
  DurableAction,
  FlightRecord,
  InboxAckRequest,
  InboxClaimRequest,
  InboxNackRequest,
  InvocationRequest,
  MessageRecord,
  ScoutRendezvousRequest,
  ScoutDeliverRequest,
  ScoutDeliverResponse,
  ScoutDispatchRecord,
  NodeDefinition,
  RouteAliasListRequest,
  RouteAliasMutationRequest,
  RouteAliasResolveRequest,
  RouteAliasSetRequest,
  TrustedPeerRecord,
} from "@openscout/protocol";

import type { ActiveScoutBrokerService } from "./broker-api.js";
import { a2aJsonRpcError, type BrokerA2AService } from "./broker-a2a-service.js";
import {
  brokerDeliverRequestSchema,
  brokerInvocationRequestSchemaFor,
} from "./broker-command-boundary-schemas.js";
import {
  parseInboxReasons,
  parseInboxStatuses,
  type BrokerControlStreamService,
} from "./broker-control-stream-service.js";
import type { BrokerDeliveryAcceptanceService } from "./broker-delivery-acceptance-service.js";
import {
  brokerAppendMissionLog,
  brokerAssignRole,
  brokerListMissionLog,
  brokerListRoleAssignments,
  brokerRevokeRole,
  brokerRolesCatalog,
  parseRoleScope,
} from "./broker-roles-http.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";
import type {
  BrokerDeliveryHttpService,
  DeliveryAttemptBody,
  DeliveryClaimBody,
  DeliveryStatusBody,
} from "./broker-delivery-http-service.js";
import type {
  BrokerDurableActionHttpService,
  DurableActionHeartbeatBody,
} from "./broker-durable-action-http-service.js";
import {
  a2aJson,
  badRequest as writeBadRequest,
  json,
  jsonWithHeaders,
  notFound,
  parseBooleanQueryParam,
  parseLimit,
  parseSince,
  readValidatedRequestBody,
  readRequestBody,
  requestAbortSignal,
  serverTimingHeader,
  threadWatchError,
  throwIfAborted,
} from "./broker-http-helpers.js";
import { handleBrokerHttpEntityWriteRoute } from "./broker-http-entity-write-routes.js";
import { handleBrokerGuestRoute, type BrokerGuestHttpDeps } from "./broker-guest-http-routes.js";
import type { BrokerManagedSessionHttpService } from "./broker-managed-session-http-service.js";
import type {
  ManagedLocalSessionAttachBody,
  ManagedLocalSessionDetachBody,
  ManagedLocalSessionEnsureBody,
  ManagedPairingAttachBody,
  ManagedPairingDetachBody,
} from "./broker-managed-session-http-service.js";
import {
  MachineInventoryUnavailableError,
  type BrokerMachineService,
} from "./broker-machine-service.js";
import type { BrokerMeshDiscoveryService } from "./broker-mesh-discovery-service.js";
import type { BrokerMeshHttpService } from "./broker-mesh-http-service.js";
import { brokerActorDisplayName } from "./broker-conversation-helpers.js";
import type { BrokerRepoTailService } from "./broker-repo-tail-service.js";
import type { BrokerRendezvousService } from "./broker-rendezvous-service.js";
import type { BrokerWebControlService } from "./broker-web-control-service.js";
import { buildCollaborationInvocation } from "./collaboration-invocations.js";
import type { DiscoverySnapshot, TailDiscoveryOptions, TailDiscoveryScope } from "./tail/types.js";
import type {
  MeshCollaborationEventBundle,
  MeshCollaborationRecordBundle,
  MeshInvocationBundle,
  MeshMessageBundle,
} from "./mesh-forwarding.js";
import {
  upsertScoutAgentCardFromInput,
  type ExternalAgentCardInput,
} from "./scout-agent-cards.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import type { BrokerRouteTargetInput } from "./scout-dispatcher.js";
import type { ThreadEventPlane } from "./thread-events.js";
import {
  BrokerRouteAliasError,
  type BrokerRouteAliasService,
} from "./broker-route-alias-service.js";
import type { SignedNodeCard } from "./node-identity.js";
import { nodeFingerprint, nodeKeyId } from "./node-identity.js";
import type { MeshGateMode } from "./mesh-ingress-gate.js";
import {
  TrustEnrollmentError,
  type TrustEnrollmentService,
  type TrustEndpointRateLimiter,
  type TrustedPeerGrant,
} from "./mesh-trust-enrollment.js";
import { normalizeConversationTitle } from "./conversation-title.js";

function badRequest(response: RuntimeHttpResponseLike, error: unknown): void {
  if (error instanceof BrokerBusyError) json(response, 503, { error: error.code, retryable: true, detail: error.message });
  else writeBadRequest(response, error);
}

export type BrokerHttpRuntime = {
  /** Metadata-only peek: endpoint readers must not detach/message-scan the registry. */
  peek?: () => { endpoints: Record<string, AgentEndpoint> };
  snapshot: () => { nodes: Record<string, NodeDefinition>; conversations: Record<string, ConversationDefinition>; messages?: Record<string, MessageRecord>; invocations?: Record<string, InvocationRequest> };
  recentEvents: (limit: number) => unknown;
  collaborationRecord: (recordId: string) => CollaborationRecord | undefined;
  flightForInvocation: (invocationId: string) => FlightRecord | undefined;
  upsertAgentIdentity: (agent: {
    id: string;
    displayName: string;
    handle: string;
    selector?: string;
    labels?: string[];
    authorityNodeId: string;
    metadata?: Record<string, unknown>;
  }) => void;
  upsertEndpoint: (endpoint: AgentEndpoint) => void;
};

export type BrokerHttpJournal = {
  listDeliveries: (options: { limit: number; invocationId?: string }) => DeliveryIntent[];
  listScoutDispatches: (options: { limit: number; invocationId?: string }) => ScoutDispatchRecord[];
};

/**
 * Command kinds accepted over `POST /v1/commands`.
 *
 * Channel invitations are read-modify-write over one conversation's invitation
 * set, so the mutation must happen inside the broker rather than as a
 * whole-conversation upsert from a surface. These kinds are the crossing
 * point; nothing else is admitted here.
 */
const CHANNEL_INVITE_COMMAND_KINDS = new Set<string>([
  "channel.member.remove",
  "channel.invite.create",
  "channel.invite.revoke",
  "channel.invite.redeem",
]);

export type BrokerHttpRouterDeps = {
  encodedSnapshotBodies?: boolean;
  onSnapshotFlushedBytes?: (bytes: number) => void;
  host: string;
  port: number;
  nodeId: string;
  meshId: string;
  operatorActorId: string;
  runtime: BrokerHttpRuntime;
  requestReceipts?: BrokerRequestReceipts;
  historyQueries?: BrokerHistoryQueries;
  quarantineQueries?: BrokerQuarantineQueries;
  readHistoricalInvocationSnapshot?: (id: string) => Promise<{ invocation: InvocationRequest | null; flight: FlightRecord | null; deliveries: DeliveryIntent[] }>;
  deliveryReceiptsOwnedByService?: boolean;
  mcpEvents?: BrokerMcpEvents;
  /** Cross-machine approvals: share this machine's with chosen peers, watch theirs. */
  meshApprovals?: MeshApprovalsHttpDeps;
  permissionService?: BrokerPermissionService;
  journal: BrokerHttpJournal;
  knownInvocations: Map<string, InvocationRequest>;
  brokerService: ActiveScoutBrokerService;
  webControl: BrokerWebControlService;
  readHostInfo?: () => unknown | Promise<unknown>;
  a2aService: BrokerA2AService;
  brokerRepoTailService: BrokerRepoTailService<RuntimeRegistrySnapshot>;
  getHarnessTopologySnapshot: (force: boolean) => unknown | Promise<unknown>;
  getTailDiscovery: (options?: boolean | TailDiscoveryOptions) => DiscoverySnapshot | Promise<DiscoverySnapshot>;
  nudgeHarnessTopologyScan: () => unknown | Promise<unknown>;
  deliveryHttpService: BrokerDeliveryHttpService;
  durableActionHttpService: BrokerDurableActionHttpService;
  controlStreams: BrokerControlStreamService;
  managedSessionHttpService: BrokerManagedSessionHttpService;
  meshDiscoveryService: BrokerMeshDiscoveryService;
  meshHttpService: BrokerMeshHttpService;
  /**
   * Mesh session wake (T4 rung of flat session dispatch): run this node's
   * local harness-store wake on behalf of an enrolled peer and return the
   * registered endpoint so the peer can adopt it. Local wake only — the
   * handler must never fan out to other peers.
   */
  wakeMeshHarnessSession?: (input: {
    nativeSessionId: string;
    harness?: string;
    projectPath?: string;
  }) => Promise<
    | { ok: true; endpoint: AgentEndpoint; actor?: ActorIdentity }
    | { ok: false; reason: string; detail: string; remediation?: string }
  >;
  /**
   * Mesh session start: a peer asks this node to start a new cardless session
   * in a project that exists on this machine, and returns the registered
   * endpoint so the peer can adopt it. Local start only — never fans out.
   */
  startMeshProjectSession?: (input: {
    projectPath: string;
    harness?: string;
    model?: string;
    reasoningEffort?: string;
    placement?: string;
    requesterId?: string;
  }) => Promise<
    | { ok: true; endpoint: AgentEndpoint; actor?: ActorIdentity }
    | { ok: false; reason: string; detail: string }
  >;
  threadEvents: ThreadEventPlane;
  handleCommand: (command: ControlCommand) => Promise<unknown>;
  handleInvocationRequest: (payload: InvocationRequest & BrokerRouteTargetInput) => Promise<unknown>;
  deleteEndpoint: (endpointId: string) => Promise<void>;
  recordFlight: (flight: FlightRecord) => Promise<void>;
  listReadCursorsForConversation: (conversationId: string) => ConversationReadCursor[];
  resolveReadCursor: (
    conversationId: string,
    body: {
      actorId?: string;
      readerNodeId?: string;
      lastReadMessageId?: string;
      lastReadSeq?: number;
      lastReadAt?: number;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<ConversationReadCursor>;
  recordReadCursor: (cursor: ConversationReadCursor) => Promise<void>;
  respondToChatQuestion?: (channelId: string, questionId: string, actorId: string, isOperator: boolean, change: unknown) => Promise<import("@openscout/protocol").CollaborationRecord>;
  correctChatMessage?: (channelId: string, messageId: string, actorId: string, canModerate: boolean, change: unknown) => Promise<MessageRecord>;
  updateConversationPins?: (conversationId: string, actorId: string, change: unknown) => Promise<ConversationDefinition | null>;
  updateChatPreferences?: (conversationId: string, actorId: string, change: unknown) => Promise<unknown>;
  /** Canonical field mutation; reads current conversation inside the writer. */
  setConversationTitle: (conversationId: string, named: string) => Promise<ConversationDefinition | null>;
  acknowledgeDeliveriesForReadCursor: (cursor: ConversationReadCursor) => Promise<unknown>;
  deliveryAcceptanceService: BrokerDeliveryAcceptanceService;
  rendezvousService: BrokerRendezvousService;
  externalSessionService?: BrokerExternalSessionService;
  routeAliasService?: BrokerRouteAliasService;
  integrationSetupService?: BrokerIntegrationSetupService;
  integrationSlackDelivery?: IntegrationSlackDeliveryService;
  integrationSlackEvents?: IntegrationSlackEvents;
  forwardHostWebRequest?: (input: HostWebRequest & { nodeId: string }) => Promise<HostWebResponse>;
  forwardRouteAliasRequest?: (input: {
    nodeSelector: string;
    path: string;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
  }) => Promise<{ status: number; body: unknown } | null>;
  /**
   * Control-plane SQLite for assigned roles / mission log. When null/undefined,
   * role routes return 503 (tables owned by migrations; broker is writer).
   */
  openRolesDb?: () => ControlPlaneSqliteDatabase | null;
  /**
   * Mesh trust cone (docs/proposals/mesh-trust-cone.md): enrollment handshake
   * endpoints and the signed node card. When absent, the trust routes 404 and
   * /v1/node omits the card.
   */
  meshTrust?: {
    enrollment: TrustEnrollmentService;
    rateLimiter: TrustEndpointRateLimiter;
    nodeCard: () => SignedNodeCard;
    /** ingress gate rollout mode, surfaced on /v1/node for `scout mesh status` */
    gateMode: () => MeshGateMode;
    /** persist an approved grant; false when persistence is unavailable */
    persistGrant: (grant: TrustedPeerGrant) => boolean;
    /**
     * trusted_peers store surface for the operator routes (peers/revoke/
     * grant). Null when broker SQLite persistence is disabled — those routes
     * then answer 503, matching persistGrant's contract.
     */
    peers: {
      listTrustedPeers: () => TrustedPeerRecord[];
      trustedPeer: (keyId: string) => TrustedPeerRecord | undefined;
      upsertTrustedPeer: (peer: TrustedPeerRecord) => void;
      revokeTrustedPeer: (keyId: string, at: number) => boolean;
    } | null;
  };
  /**
   * Machine inventory (see machines.ts in @openscout/protocol). Absent when
   * broker SQLite persistence is disabled — the routes then answer 503, since
   * the roster is durable by definition and cannot be served from memory.
   */
  machines?: BrokerMachineService;
  /**
   * P1.5 restart-free bind flip (docs/proposals/mesh-trust-cone.md §11.5).
   * When absent, POST /v1/mesh/bind 404s.
   */
  meshBind?: {
    applyScope: (scope: "local" | "mesh") => Promise<unknown>;
    getState: () => unknown;
  };
  /**
   * Scout guest access (docs/proposals/scout-tailscale.md): `/v1/guest/*`
   * for gate-verified guest keys and loopback `/v1/guest-grants*`. When
   * absent, those paths fall through to 404.
   */
  guest?: BrokerGuestHttpDeps;
  access?: BrokerAccessHttpDeps;
};

const tailDiscoveryScopes = new Set<TailDiscoveryScope>(["hot", "shallow", "deep"]);

function parseTailDiscoveryScope(value: string | null): TailDiscoveryScope | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return tailDiscoveryScopes.has(normalized as TailDiscoveryScope)
    ? (normalized as TailDiscoveryScope)
    : undefined;
}

function parseTailDiscoveryLimit(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1_000) : undefined;
}

function tailDiscoveryProcessKey(source: string, cwd: string | null | undefined): string | null {
  const cleanCwd = cwd?.trim();
  return cleanCwd ? `${source}\u0000${cleanCwd}` : null;
}

function trimTailDiscoverySnapshot(
  snapshot: DiscoverySnapshot,
  limit: number | undefined,
): DiscoverySnapshot {
  if (!limit || limit <= 0) return snapshot;
  const transcripts = snapshot.transcripts.slice(0, limit);
  const transcriptProcessKeys = new Set(
    transcripts
      .map((transcript) => tailDiscoveryProcessKey(transcript.source, transcript.cwd))
      .filter((key): key is string => Boolean(key)),
  );
  const processIds = new Set<string>();
  const processes: DiscoverySnapshot["processes"] = [];
  for (const process of snapshot.processes) {
    const key = tailDiscoveryProcessKey(process.source, process.cwd);
    if (!key || !transcriptProcessKeys.has(key)) continue;
    const processId = `${process.source}\u0000${process.pid}`;
    if (processIds.has(processId)) continue;
    processIds.add(processId);
    processes.push(process);
    if (processes.length >= limit) break;
  }
  for (const process of snapshot.processes) {
    if (processes.length >= limit) break;
    const processId = `${process.source}\u0000${process.pid}`;
    if (processIds.has(processId)) continue;
    processIds.add(processId);
    processes.push(process);
  }
  return {
    ...snapshot,
    processes,
    transcripts,
  };
}

function trustEnrollmentFailure(response: RuntimeHttpResponseLike, error: unknown): void {
  if (error instanceof TrustEnrollmentError) {
    json(response, 400, {
      error: "trust_enrollment_failed",
      reason: error.reason,
      detail: error.message,
    });
    return;
  }
  badRequest(response, error);
}

function trustPersistenceUnavailable(response: RuntimeHttpResponseLike): void {
  json(response, 503, {
    error: "trust_persistence_unavailable",
    detail: "broker SQLite persistence is disabled; trusted peers are unavailable",
  });
}

/** Full-length lowercase SHA-256 hex key ID, or null when malformed. */
function normalizeTrustKeyId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

export function createBrokerHttpRouter(
  deps: BrokerHttpRouterDeps,
): (request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike) => Promise<void> {
  const {
    host,
    port,
    nodeId,
    meshId,
    operatorActorId,
    runtime,
    journal,
    knownInvocations,
    brokerService,
    webControl,
    readHostInfo,
    a2aService,
    brokerRepoTailService,
    getHarnessTopologySnapshot,
    getTailDiscovery,
    nudgeHarnessTopologyScan,
    deliveryHttpService,
    durableActionHttpService,
    controlStreams,
    managedSessionHttpService,
    meshDiscoveryService,
    meshHttpService,
    wakeMeshHarnessSession,
    startMeshProjectSession,
    threadEvents,
    handleCommand,
    handleInvocationRequest,
    deleteEndpoint,
    recordFlight,
    listReadCursorsForConversation,
    resolveReadCursor,
    recordReadCursor,
    updateChatPreferences,
    setConversationTitle,
    updateConversationPins,
    correctChatMessage,
    respondToChatQuestion,
    acknowledgeDeliveriesForReadCursor,
    deliveryAcceptanceService,
    rendezvousService,
    routeAliasService,
    integrationSetupService,
    integrationSlackDelivery,
    integrationSlackEvents,
    forwardRouteAliasRequest,
    forwardHostWebRequest,
    machines,
    meshTrust,
    meshBind,
    guest,
  } = deps;

  const requestReceipts = deps.requestReceipts ?? new BrokerRequestReceipts();

  return async function routeRequest(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  // Mesh trust cone §4 / §11.9 defense in depth: machine-local mutation
  // handlers re-check the transport context themselves, so a remote caller is
  // refused even while the ingress gate runs in verify-warn. Undefined
  // context means the request never crossed the gate (tests, in-process) —
  // treated as local.
  // Guest routes are answered before any other routing, so a guest request
  // never reaches peer, forwarding, or local handlers.
  if (method === "POST" && url.pathname === "/v1/access/admin") {
    if (deps.access) { await handleBrokerAccessRoute(request, response, url, method, deps.access); return; }
    json(response, 503, { error: "access_unavailable" }); return;
  }
  if (method === "POST" && url.pathname === "/v1/access/policy") {
    if (deps.access) { await handleBrokerAccessRoute(request, response, url, method, deps.access); return; }
    json(response, 503, { error: "access_unavailable" }); return;
  }
  if (method === "POST" && url.pathname === "/v1/access/rpc") {
    if (deps.access) { await handleBrokerAccessRoute(request, response, url, method, deps.access); return; }
    json(response, 503, { error: "access_unavailable" }); return;
  }
  if (request.transportContext?.scoped) { json(response, 403, { error: "access_denied" }); return; }
  if (method === "POST" && url.pathname === "/v1/mcp-events") {
    await handleBrokerMcpEvents(request, response, deps.mcpEvents); return;
  }
  if (method === "POST" && url.pathname === "/v1/permissions/decide") {
    if (request.transportContext?.transport === "remote") { json(response, 403, { error: "forbidden", detail: "route is machine-local" }); return; }
    try {
      const body = await readRequestBody<{ requestId?: unknown; version?: unknown; decision?: unknown }>(request);
      if (typeof body.requestId !== "string" || typeof body.version !== "string"
        || !["once", "project", "deny"].includes(String(body.decision))) throw new Error("requestId, version, and decision (once/project/deny) are required");
      if (!deps.permissionService) throw new Error("Permission decisions are unavailable");
      await deps.permissionService.decide(body.requestId, body.version, body.decision as "once" | "project" | "deny");
      json(response, 200, { ok: true });
    } catch (error) { json(response, error instanceof PermissionDeliveryUnconfirmedError ? 502 : 409, { error: error instanceof Error ? error.message : String(error), outcome: error instanceof PermissionDeliveryUnconfirmedError ? "unconfirmed" : "refused" }); }
    return;
  }

  if (url.pathname.startsWith("/v1/mesh/approvals/") || url.pathname.startsWith("/v1/approvals/remote")) {
    if (await handleBrokerMeshApprovalsRoute(request, response, url, method, deps.meshApprovals ?? {})) return;
  }
  if (guest && await handleBrokerGuestRoute(request, response, url, method, guest)) return;
  const denyRemoteMutation = (): boolean => {
    if (request.transportContext?.transport !== "remote") return false;
    json(response, 403, { error: "forbidden", detail: "route is machine-local" });
    return true;
  };
  const forwardedNodeHeader = request.headers["x-openscout-forwarded-node-id"];
  const forwardedNodeId = Array.isArray(forwardedNodeHeader) ? forwardedNodeHeader[0] : forwardedNodeHeader;
  if (forwardedNodeId) {
    const forwardedMeshHeader = request.headers["x-openscout-mesh-id"];
    const forwardedMeshId = Array.isArray(forwardedMeshHeader) ? forwardedMeshHeader[0] : forwardedMeshHeader;
    const origin = runtime.snapshot().nodes[forwardedNodeId];
    if (forwardedMeshId !== meshId || !origin || origin.meshId !== meshId) {
      json(response, 403, { error: "not_authorized", detail: "forwarded broker request failed owner-realm authentication" });
      return;
    }
  }
  const aliasItemMatch = method === "PATCH" || method === "DELETE"
    ? url.pathname.match(/^\/v1\/aliases\/([^/]+)$/)
    : null;
  const aliasHistoryMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/aliases\/([^/]+)\/history$/)
    : null;

  const handleAliasError = (error: unknown): void => {
    if (error instanceof BrokerRouteAliasError) {
      json(response, error.code === "not_authorized" ? 403 : error.code === "unknown_alias" ? 404 : error.code === "revision_conflict" ? 409 : 400, {
        error: error.code,
        detail: error.message,
        ...(error.details ?? {}),
      });
      return;
    }
    badRequest(response, error);
  };

  const forwardAliasIfRemote = async (
    nodeSelector: string | undefined,
    path: string,
    aliasMethod: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<boolean> => {
    if (!nodeSelector?.trim() || !forwardRouteAliasRequest) return false;
    const forwarded = await forwardRouteAliasRequest({
      nodeSelector: nodeSelector.trim(),
      path,
      method: aliasMethod,
      body,
    });
    if (!forwarded) return false;
    json(response, forwarded.status, forwarded.body);
    return true;
  };

  if (method === "POST" && url.pathname === "/v1/surfaces/deck") {
    if (denyRemoteMutation()) return;
    try {
      const body = await readRequestBody(request) as { action?: string; agentId?: string; text?: string; connect?: boolean };
      if (!body || typeof body.agentId !== "string" || !body.agentId.trim()) return badRequest(response, "agentId is required");
      const id = body.agentId;
      if (body.action === "snapshot") return json(response, 200, await deckLanes.snapshot(id, body.connect === true));
      if (body.action === "interrupt") return json(response, 200, await deckLanes.interrupt(id));
      if ((body.action === "start" || body.action === "steer") && typeof body.text === "string" && body.text.trim() && body.text.length <= 65536) {
        return json(response, 200, await deckLanes[body.action](id, body.text));
      }
      return badRequest(response, "Invalid Deck action or text");
    } catch (error) { return badRequest(response, error instanceof Error ? error.message : String(error)); }
  }

  if (method === "POST" && (url.pathname === "/v1/external-sessions/ack" || url.pathname === "/v1/external-sessions/poll" || url.pathname === "/v1/external-sessions/attach" || url.pathname === "/v1/external-sessions/get" || url.pathname === "/v1/external-sessions/reply")) {
    if (!deps.externalSessionService) { json(response, 503, { error: "external_sessions_unavailable" }); return; }
    try {
      const input = await readRequestBody<Record<string, unknown>>(request);
      if (typeof input.ownerId !== "string" || !input.ownerId.trim()) throw new Error("external_session_owner_required");
      const string = (key: string) => {
        const value = input[key];
        if (typeof value !== "string" || !value.trim()) throw new Error(`external_session_${key}_required`);
        return value;
      };
      const service = deps.externalSessionService;
      const result = url.pathname.endsWith("/attach")
        ? await service.attach({ ownerId: input.ownerId, connectionId: typeof input.connectionId === "string" ? input.connectionId : undefined, nativeSessionId: string("nativeSessionId") })
        : url.pathname.endsWith("/reply")
        ? await service.reply({ ownerId: input.ownerId, sessionId: string("sessionId"), deliveryId: string("deliveryId"), replyToken: typeof input.replyToken === "string" ? input.replyToken : undefined, body: string("body") })
        : url.pathname.endsWith("/poll")
        ? await service.poll({ ownerId: input.ownerId, sessionId: string("sessionId"), cursor: typeof input.cursor === "string" ? input.cursor : undefined, limit: typeof input.limit === "number" ? input.limit : undefined })
        : url.pathname.endsWith("/ack")
        ? await service.acknowledge({ ownerId: input.ownerId, sessionId: string("sessionId"), deliveryId: string("deliveryId") })
        : service.get({ ownerId: input.ownerId, sessionId: string("sessionId") });
      json(response, 200, result);
    } catch (error) { badRequest(response, error); }
    return;
  }

  if (url.pathname === "/v1/integrations/setup" || url.pathname.startsWith("/v1/integrations/setup/")) {
    // Even reads are local: setup reveals project bindings and operator actions.
    if (denyRemoteMutation()) return;
    if (forwardedNodeId) {
      json(response, 403, { error: "forbidden", detail: "integration setup cannot be forwarded" });
      return;
    }
    if (!integrationSetupService) {
      json(response, 503, { error: "integrations_unavailable", detail: "integration setup requires broker SQLite persistence" });
      return;
    }
    try {
      const match = /^\/v1\/integrations\/setup\/([^/]+)(\/(?:resume|credentials|manifest|verify|rebind|lifecycle|worker|deliver|events))?$/.exec(url.pathname);
      if (method === "POST" && url.pathname === "/v1/integrations/setup") {
        json(response, 200, integrationSetupService.setup(await readRequestBody(request)));
      } else if (method === "GET" && match?.[2] === "/manifest") {
        json(response, 200, integrationSetupService.manifest(decodeURIComponent(match[1]!)));
      } else if (method === "GET" && match && !match[2]) {
        json(response, 200, integrationSetupService.get(decodeURIComponent(match[1]!)));
      } else if (method === "POST" && match?.[2] === "/events") {
        if (!integrationSlackEvents) throw new IntegrationSetupError("events_unavailable", "Slack event persistence is unavailable.", 503);
        json(response, 200, integrationSlackEvents.request(decodeURIComponent(match[1]!), await readRequestBody(request)));
      } else if (method === "POST" && match?.[2] === "/deliver") {
        if (!integrationSlackDelivery) throw new IntegrationSetupError("delivery_unavailable", "Project Slack delivery is unavailable.", 503);
        const result = await integrationSlackDelivery.deliver(decodeURIComponent(match[1]!), await readRequestBody(request), payload =>
          brokerService.deliver ? brokerService.deliver(payload) : deliveryAcceptanceService.accept(payload));
        json(response, result.kind === "delivery" ? 202 : result.kind === "question" ? 409 : 422, result);
      } else if (method === "POST" && match?.[2] === "/rebind") {
        json(response, 200, integrationSetupService.rebind(decodeURIComponent(match[1]!), await readRequestBody(request)));
      } else if (method === "POST" && match?.[2] === "/verify") {
        json(response, 200, integrationSetupService.verify(decodeURIComponent(match[1]!), await readRequestBody(request)));
      } else if (method === "POST" && match?.[2] === "/lifecycle") {
        json(response, 200, integrationSetupService.setLifecycle(decodeURIComponent(match[1]!), await readRequestBody(request)));
      } else if (method === "POST" && match?.[2] === "/worker") {
        json(response, 200, integrationSetupService.workerRequest(decodeURIComponent(match[1]!), await readRequestBody(request)));
      } else if (method === "POST" && match?.[2] === "/credentials") {
        json(response, 200, await integrationSetupService.attachCredentials(decodeURIComponent(match[1]!), await readRequestBody(request)));
      } else if (method === "POST" && match?.[2] === "/resume") {
        json(response, 200, integrationSetupService.resume(decodeURIComponent(match[1]!), await readRequestBody(request)));
      } else {
        json(response, 404, { error: "not_found" });
      }
    } catch (error) {
      if (error instanceof IntegrationSetupError) json(response, error.status, { error: error.code, detail: error.message });
      else json(response, 500, { error: "integration_setup_failed", detail: "Integration setup could not be persisted. Read status before retrying." });
    }
    return;
  }

  if ((url.pathname.startsWith("/v1/aliases") || url.pathname.startsWith("/v1/mesh/aliases")) && !routeAliasService) {
    json(response, 503, { error: "aliases_unavailable", detail: "route aliases require broker SQLite persistence" });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/aliases") {
    try {
      const body = await readRequestBody<RouteAliasSetRequest>(request);
      if (await forwardAliasIfRemote(body.scope?.nodeId, url.pathname, "POST", body)) return;
      json(response, 201, { binding: routeAliasService!.set(body) });
    } catch (error) {
      handleAliasError(error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/aliases") {
    try {
      const query: RouteAliasListRequest = {
        scope: {
          projectKey: url.searchParams.get("projectKey") ?? undefined,
          projectRoot: url.searchParams.get("projectRoot") ?? undefined,
          nodeId: url.searchParams.get("nodeId") ?? undefined,
        },
        targetAgentId: url.searchParams.get("targetAgentId") ?? undefined,
        targetSessionId: url.searchParams.get("targetSessionId") ?? undefined,
        includeInactive: parseBooleanQueryParam(url.searchParams.get("includeInactive")) ?? false,
        limit: Math.max(1, Math.min(Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1_000)),
        caller: {
          actorId: url.searchParams.get("actorId") ?? operatorActorId,
          currentDirectory: url.searchParams.get("currentDirectory") ?? undefined,
          nodeId,
        },
      };
      if (await forwardAliasIfRemote(query.scope?.nodeId, `${url.pathname}${url.search}`, "GET")) return;
      json(response, 200, { bindings: routeAliasService!.list(query) });
    } catch (error) {
      handleAliasError(error);
    }
    return;
  }

  // /v1/mesh/aliases/resolve is the remote-tier twin (mesh trust cone §4):
  // signed peers resolve aliases here in enforce mode; the local-tier route
  // below stays loopback-only and is never widened.
  if (method === "POST" && (url.pathname === "/v1/aliases/resolve" || url.pathname === "/v1/mesh/aliases/resolve")) {
    try {
      const body = await readRequestBody<RouteAliasResolveRequest>(request);
      if (await forwardAliasIfRemote(body.scope?.nodeId, url.pathname, "POST", body)) return;
      json(response, 200, routeAliasService!.resolve(body));
    } catch (error) {
      handleAliasError(error);
    }
    return;
  }

  if (method === "GET" && aliasHistoryMatch) {
    try {
      if (await forwardAliasIfRemote(url.searchParams.get("nodeId") ?? undefined, `${url.pathname}${url.search}`, "GET")) return;
      json(response, 200, { history: routeAliasService!.history(decodeURIComponent(aliasHistoryMatch[1]!)) });
    } catch (error) {
      handleAliasError(error);
    }
    return;
  }

  if (method === "PATCH" && aliasItemMatch) {
    try {
      const body = await readRequestBody<RouteAliasMutationRequest>(request);
      if (await forwardAliasIfRemote(body.scope?.nodeId, url.pathname, "PATCH", body)) return;
      json(response, 200, { binding: routeAliasService!.repoint(decodeURIComponent(aliasItemMatch[1]!), body) });
    } catch (error) {
      handleAliasError(error);
    }
    return;
  }

  if (method === "DELETE" && aliasItemMatch) {
    try {
      const body: RouteAliasMutationRequest = await readRequestBody<RouteAliasMutationRequest>(request).catch(() => ({}));
      if (await forwardAliasIfRemote(body.scope?.nodeId, url.pathname, "DELETE", body)) return;
      json(response, 200, { binding: routeAliasService!.unset(decodeURIComponent(aliasItemMatch[1]!), body) });
    } catch (error) {
      handleAliasError(error);
    }
    return;
  }
  const collaborationInvokeMatch = method === "POST"
    ? url.pathname.match(/^\/v1\/collaboration\/records\/([^/]+)\/invoke$/)
    : null;
  const durableActionHeartbeatMatch = method === "POST"
    ? url.pathname.match(/^\/v1\/durable-actions\/([^/]+)\/heartbeat$/)
    : null;
  const a2aAgentCardMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/a2a\/agents\/([^/]+)\/agent-card\.json$/)
    : null;
  const a2aAgentRpcMatch = method === "POST"
    ? url.pathname.match(/^\/v1\/a2a\/agents\/([^/]+)\/rpc$/)
    : null;
  const threadEventsMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/conversations\/([^/]+)\/thread-events$/)
    : null;
  const threadSnapshotMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/conversations\/([^/]+)\/thread-snapshot$/)
    : null;
  const readCursorsMatch = method === "GET" || method === "POST"
    ? url.pathname.match(/^\/v1\/conversations\/([^/]+)\/read-cursors$/)
    : null;
  const conversationQuestionMatch = method === "POST" ? url.pathname.match(/^\/v1\/conversations\/([^/]+)\/questions\/([^/]+)\/respond$/) : null;
  const conversationCorrectionsMatch = method === "POST" ? url.pathname.match(/^\/v1\/conversations\/([^/]+)\/corrections$/) : null;
  const conversationPinsMatch = method === "POST" ? url.pathname.match(/^\/v1\/conversations\/([^/]+)\/pins$/) : null;
  const conversationTitleMatch = method === "POST"
    ? url.pathname.match(/^\/v1\/conversations\/([^/]+)\/title$/)
    : null;
  const threadWatchStreamMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/thread-watches\/([^/]+)\/stream$/)
    : null;
  if ((url.pathname === "/v1/web/status" || url.pathname === "/v1/web/start" || url.pathname === "/v1/web/restart") && method === "OPTIONS") {
    response.writeHead(204, webControl.corsHeaders(request));
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    json(response, 200, await brokerService.readHealth());
    return;
  }

  if (method === "GET" && url.pathname === "/.host-info") {
    json(response, 200, readHostInfo ? await readHostInfo() : {
      schemaVersion: 1,
      source: "openscout-broker",
      updatedAtMs: Date.now(),
      nodeId,
      meshId,
      brokerUrl: `http://${host}:${port}`,
      ports: { broker: port },
    });
    return;
  }

  if (
    method === "GET"
    && (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/v1/a2a/agent-card.json" || a2aAgentCardMatch)
  ) {
    const pathAgentId = a2aAgentCardMatch
      ? decodeURIComponent(a2aAgentCardMatch[1] ?? "")
      : url.searchParams.get("agentId")?.trim() || undefined;
    const card = await a2aService.agentCardForRequest(url.origin, pathAgentId);
    if (!card) {
      a2aJson(response, 404, {
        error: "not_found",
        detail: `A2A agent card not found: ${pathAgentId ?? "openscout"}`,
      });
      return;
    }
    a2aJson(response, 200, card);
    return;
  }

  if (method === "POST" && (url.pathname === "/a2a" || url.pathname === "/v1/a2a/rpc" || a2aAgentRpcMatch)) {
    try {
      const body = await readRequestBody<A2AJsonRpcRequest>(request);
      const pathAgentId = a2aAgentRpcMatch ? decodeURIComponent(a2aAgentRpcMatch[1] ?? "") : undefined;
      const result = await a2aService.handleJsonRpc(body, url.origin, pathAgentId);
      a2aJson(response, result.error ? 200 : 200, result);
    } catch (error) {
      a2aJson(response, 200, a2aJsonRpcError(
        null,
        -32700,
        `A2A JSON-RPC parse error: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
    return;
  }

  if (method === "POST" && (url.pathname === "/v1/hosts/web-request" || url.pathname === "/v1/mesh/web-request")) {
    try {
      const input = await readRequestBody<HostWebRequest & { nodeId?: string }>(request, { maxBytes: 36 * 1024 * 1024, requireJsonContentType: true });
      if (!isAllowedHostWebRequest(input)) {
        json(response, 400, { error: "unsupported_host_operation" });
        return;
      }
      const result = url.pathname === "/v1/mesh/web-request"
        ? await webControl.requestForHost(input)
        : input.nodeId && forwardHostWebRequest
          ? await forwardHostWebRequest({ ...input, nodeId: input.nodeId })
          : { status: 400, body: { error: "Exact destination node is required" } };
      json(response, 200, result);
    } catch (error) { badRequest(response, error); }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/web/status") {
    jsonWithHeaders(response, 200, await webControl.status(), webControl.corsHeaders(request));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/web/start") {
    try {
      jsonWithHeaders(
        response,
        200,
        await webControl.startIfNeeded(webControl.startContextFromRequest(request)),
        webControl.corsHeaders(request),
      );
    } catch (error) {
      jsonWithHeaders(
        response,
        500,
        webControl.failureStatus(error),
        webControl.corsHeaders(request),
      );
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/web/restart") {
    try {
      jsonWithHeaders(
        response,
        200,
        await webControl.restartIfManaged(webControl.startContextFromRequest(request)),
        webControl.corsHeaders(request),
      );
    } catch (error) {
      jsonWithHeaders(
        response,
        500,
        webControl.failureStatus(error),
        webControl.corsHeaders(request),
      );
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/node") {
    const node = await brokerService.readNode();
    // Mesh trust cone §1: the signed node card rides the public node route so
    // enrolling peers can fetch and verify this node's identity. The gate mode
    // is operator-facing rollout state for `scout mesh status`.
    json(response, 200, meshTrust
      ? { ...node, card: meshTrust.nodeCard(), gateMode: meshTrust.gateMode() }
      : node);
    return;
  }

  // ─── Mesh trust enrollment (docs/proposals/mesh-trust-cone.md §3) ─────────
  // begin/reveal are the public handshake (rate-limited per remote address);
  // status/approve/reject are loopback-only operator acts — remote reachability
  // is denied by the ingress gate's route matrix, not here.

  if (method === "POST" && url.pathname === "/v1/trust/enroll/begin") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    const remoteAddress = request.transportContext?.remoteAddress ?? "unknown";
    if (!meshTrust.rateLimiter.allow(remoteAddress)) {
      json(response, 429, { error: "rate_limited", detail: "too many enrollment attempts" });
      return;
    }
    try {
      const body = await readRequestBody<{ card: SignedNodeCard; commitment: string }>(request);
      const result = meshTrust.enrollment.begin({
        card: body.card,
        commitment: body.commitment,
        remoteAddress,
      });
      json(response, 200, { ...result, card: meshTrust.nodeCard() });
    } catch (error) {
      trustEnrollmentFailure(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/trust/enroll/reveal") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    const remoteAddress = request.transportContext?.remoteAddress ?? "unknown";
    if (!meshTrust.rateLimiter.allow(remoteAddress)) {
      json(response, 429, { error: "rate_limited", detail: "too many enrollment attempts" });
      return;
    }
    try {
      const body = await readRequestBody<{ enrollmentId: string; nonce: string }>(request);
      json(response, 200, meshTrust.enrollment.reveal({
        enrollmentId: body.enrollmentId,
        nonce: body.nonce,
      }));
    } catch (error) {
      trustEnrollmentFailure(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/trust/enroll/status") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    const enrollmentId = url.searchParams.get("enrollmentId")?.trim();
    if (!enrollmentId) {
      badRequest(response, "missing enrollmentId");
      return;
    }
    try {
      json(response, 200, { enrollmentId, state: meshTrust.enrollment.status(enrollmentId) });
    } catch (error) {
      trustEnrollmentFailure(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/trust/enroll/approve") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    if (denyRemoteMutation()) return;
    try {
      const body = await readRequestBody<{ enrollmentId: string; tier: string }>(request);
      if (body.tier !== "observe" && body.tier !== "control") {
        badRequest(response, "tier must be observe or control");
        return;
      }
      const grant = meshTrust.enrollment.approve({ enrollmentId: body.enrollmentId, tier: body.tier });
      if (!meshTrust.persistGrant(grant)) {
        json(response, 503, {
          error: "trust_persistence_unavailable",
          detail: "broker SQLite persistence is disabled; the grant was not persisted",
        });
        return;
      }
      json(response, 200, { grant });
    } catch (error) {
      trustEnrollmentFailure(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/trust/enroll/reject") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    if (denyRemoteMutation()) return;
    try {
      const body = await readRequestBody<{ enrollmentId: string }>(request);
      meshTrust.enrollment.reject({ enrollmentId: body.enrollmentId });
      json(response, 200, { enrollmentId: body.enrollmentId, state: "rejected" });
    } catch (error) {
      trustEnrollmentFailure(response, error);
    }
    return;
  }

  // Responder-side operator listing: lets the local CLI show in-flight
  // enrollments (SAS words included) so the operator can approve one.
  if (method === "GET" && url.pathname === "/v1/trust/enroll/sessions") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    json(response, 200, { sessions: meshTrust.enrollment.list() });
    return;
  }

  // ─── Mesh trust operator surface (docs/proposals/mesh-trust-cone.md §7) ───
  // peers/revoke/grant manage this node's own trusted_peers rows. All are
  // loopback-only operator acts (route matrix tier: local); remote peers can
  // never reach them.

  if (method === "GET" && url.pathname === "/v1/trust/peers") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    if (!meshTrust.peers) {
      trustPersistenceUnavailable(response);
      return;
    }
    json(response, 200, { peers: meshTrust.peers.listTrustedPeers() });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/trust/revoke") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    if (denyRemoteMutation()) return;
    if (!meshTrust.peers) {
      trustPersistenceUnavailable(response);
      return;
    }
    try {
      const body = await readRequestBody<{ keyId: string }>(request);
      const keyId = normalizeTrustKeyId(body.keyId);
      if (!keyId) {
        badRequest(response, "keyId must be the full 64-char lowercase SHA-256 hex key ID");
        return;
      }
      if (!meshTrust.peers.revokeTrustedPeer(keyId, Date.now())) {
        json(response, 404, {
          error: "unknown_peer",
          detail: "no active trusted peer with that key ID",
        });
        return;
      }
      json(response, 200, { keyId, state: "revoked" });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  // Two shapes (docs/proposals/mesh-trust-cone.md §7 "adjust tier"):
  // - {keyId, tier, label?} adjusts an existing peer's tier/label.
  // - {keyId, publicKey, fingerprint, label, tier, nodeId?, grantedVia?,
  //   tlsSpkiFingerprint?} installs a grant directly — SAS initiator confirm
  //   and SSH install-grant (§3c). Key ID and fingerprint are re-derived from
  //   the public key so a mismatched card cannot be stored. TLS pin is only
  //   stored when well-formed (never-clear on absent).
  if (method === "POST" && url.pathname === "/v1/trust/grant") {
    if (!meshTrust) {
      notFound(response);
      return;
    }
    if (denyRemoteMutation()) return;
    if (!meshTrust.peers) {
      trustPersistenceUnavailable(response);
      return;
    }
    try {
      const body = await readRequestBody<{
        keyId: string;
        tier: string;
        label?: string;
        publicKey?: string;
        fingerprint?: string;
        nodeId?: string;
        grantedVia?: string;
        tlsSpkiFingerprint?: string;
      }>(request);
      if (body.tier !== "observe" && body.tier !== "control") {
        badRequest(response, "tier must be observe or control");
        return;
      }
      const keyId = normalizeTrustKeyId(body.keyId);
      if (!keyId) {
        badRequest(response, "keyId must be the full 64-char lowercase SHA-256 hex key ID");
        return;
      }
      if (body.publicKey) {
        const label = body.label?.trim();
        const fingerprint = body.fingerprint?.trim();
        if (!label || !fingerprint) {
          badRequest(response, "a direct grant requires label and fingerprint alongside publicKey");
          return;
        }
        if (nodeKeyId(body.publicKey) !== keyId) {
          badRequest(response, "keyId does not match the supplied public key");
          return;
        }
        if (nodeFingerprint(body.publicKey) !== fingerprint) {
          badRequest(response, "fingerprint does not match the supplied public key");
          return;
        }
        const grantedVia =
          body.grantedVia === "ssh" || body.grantedVia === "github" || body.grantedVia === "sas"
            ? body.grantedVia
            : "sas";
        const tlsPin = body.tlsSpkiFingerprint?.trim();
        if (tlsPin !== undefined && tlsPin !== "" && !/^[0-9a-f]{64}$/.test(tlsPin)) {
          badRequest(response, "tlsSpkiFingerprint must be 64 lowercase hex chars when provided");
          return;
        }
        const peer: TrustedPeerRecord = {
          keyId,
          publicKey: body.publicKey,
          fingerprint,
          ...(body.nodeId?.trim() ? { nodeId: body.nodeId.trim() } : {}),
          label,
          tier: body.tier,
          grantedVia,
          grantedAt: Date.now(),
          ...(tlsPin ? { tlsSpkiFingerprint: tlsPin } : {}),
        };
        meshTrust.peers.upsertTrustedPeer(peer);
        json(response, 200, { peer });
        return;
      }
      const existing = meshTrust.peers.trustedPeer(keyId);
      if (!existing) {
        json(response, 404, {
          error: "unknown_peer",
          detail: "no active trusted peer with that key ID; enroll first (scout mesh enroll)",
        });
        return;
      }
      const peer: TrustedPeerRecord = {
        ...existing,
        tier: body.tier,
        label: body.label?.trim() || existing.label,
      };
      meshTrust.peers.upsertTrustedPeer(peer);
      json(response, 200, { peer });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/home") {
    json(response, 200, await brokerService.readHome?.());
    return;
  }

  if (method === "GET" && url.pathname === "/v1/notification-routing") {
    if (denyRemoteMutation()) return;
    if (!brokerService.readNotificationRouting) { notFound(response); return; }
    json(response, 200, await brokerService.readNotificationRouting());
    return;
  }

  // /v1/mesh/snapshot is the remote-tier twin (mesh trust cone §4): peer
  // discovery (fetchPeerAgents) reads it in enforce mode; the local-tier
  // route stays loopback-only and is never widened. Keep the remote route
  // agents-only even for older callers that omit or send an unsupported scope:
  // exporting a full registry here turns routine mesh discovery into an
  // unbounded serialization and transfer of local conversation history.
  if (method === "GET" && (url.pathname === "/v1/snapshot" || url.pathname === "/v1/mesh/snapshot")) {
    const requestedScope = url.searchParams.get("scope");
    const scope = url.pathname === "/v1/mesh/snapshot"
      ? "agents"
      : requestedScope === "conversations" || requestedScope === "agents" || requestedScope === "identity"
        ? requestedScope
        : undefined;
    const controller=new AbortController();const abort=()=>controller.abort(new Error('Snapshot request closed'));
    response.on('close',abort);response.on('error',abort);request.on('aborted',abort);
    try{
      const query={since:parseSince(url),scope:scope as "agents"|"conversations"|"identity"|undefined};
      if(brokerService.withSnapshot)await brokerService.withSnapshot(query,snapshot=>writeBrokerSnapshot(response,snapshot,{encodedBodies:deps.encodedSnapshotBodies,onFlushedBytes:deps.onSnapshotFlushedBytes,signal:controller.signal}),{signal:controller.signal});
      else await writeBrokerSnapshot(response,await brokerService.readSnapshot(query),{encodedBodies:deps.encodedSnapshotBodies,onFlushedBytes:deps.onSnapshotFlushedBytes});
    }finally{response.off?.('close',abort);response.off?.('error',abort);}
    return;
  }

  if (method === "GET" && url.pathname === "/v1/conversation-projection") {
    if (!brokerService.readConversationProjection) {
      notFound(response);
      return;
    }
    json(response, 200, await brokerService.readConversationProjection({
      limit: parseLimit(url),
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/capabilities/availability") {
    if (!brokerService.readCapabilityAvailability) {
      notFound(response);
      return;
    }
    const capabilityId = url.searchParams.get("capabilityId")?.trim();
    if (!capabilityId) {
      badRequest(response, "missing capabilityId");
      return;
    }
    json(response, 200, await brokerService.readCapabilityAvailability({
      capabilityId,
      methodName: url.searchParams.get("methodName")?.trim() || undefined,
      requireReady: parseBooleanQueryParam(url.searchParams.get("requireReady")),
      force: parseBooleanQueryParam(url.searchParams.get("force")),
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/capabilities") {
    if (!brokerService.readCapabilities) {
      notFound(response);
      return;
    }
    json(response, 200, await brokerService.readCapabilities({
      force: parseBooleanQueryParam(url.searchParams.get("force")),
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/runtime-catalog") {
    if (!brokerService.readRuntimeCatalog) {
      notFound(response);
      return;
    }
    json(response, 200, await brokerService.readRuntimeCatalog({
      force: parseBooleanQueryParam(url.searchParams.get("force")),
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/topology/snapshot") {
    json(response, 200, await getHarnessTopologySnapshot(url.searchParams.get("force") === "1"));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/tail/discover") {
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
    const scope = parseTailDiscoveryScope(url.searchParams.get("scope"));
    const limit = parseTailDiscoveryLimit(url.searchParams.get("limit"));
    const start = performance.now();
    const discoveryOptions: TailDiscoveryOptions = {
      force,
      ...(scope ? { scope } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    const timingDesc = [scope, limit ? `limit-${limit}` : null].filter(Boolean).join("-");
    const payload = trimTailDiscoverySnapshot(
      await getTailDiscovery(discoveryOptions),
      limit,
    );
    jsonWithHeaders(response, 200, payload, {
      "Server-Timing": serverTimingHeader([{
        name: force ? "tail-discover-force" : "tail-discover",
        dur: performance.now() - start,
        ...(timingDesc ? { desc: timingDesc } : {}),
      }]),
    });
    return;
  }

  if ((method === "GET" || method === "POST") && url.pathname === "/v1/repo-watch/warm") {
    void brokerRepoTailService.warmRepoWatchSnapshot("http-nudge");
    json(response, 202, { ok: true, status: "queued" });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/repo-watch/snapshot") {
    json(response, 200, await brokerRepoTailService.readRepoWatchSnapshotForUrl(url));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/tail/recent") {
    const result = await brokerRepoTailService.readTailRecentPayloadWithTiming(url);
    jsonWithHeaders(response, 200, result.payload, {
      "Server-Timing": serverTimingHeader(result.timings),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/topology/nudge") {
    json(response, 200, await nudgeHarnessTopologyScan());
    return;
  }

  if (method === "GET" && url.pathname === "/v1/message-reactions") {
    const channelId = url.searchParams.get("conversationId")?.trim()
      || url.searchParams.get("channelId")?.trim();
    if (!channelId) {
      badRequest(response, new Error("conversationId is required"));
      return;
    }
    try {
      json(response, 200, await brokerService.listMessageReactions?.(channelId) ?? []);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/messages") {
    json(response, 200, await brokerService.readMessages?.({
      conversationId: url.searchParams.get("conversationId")?.trim() || undefined,
      participantId: url.searchParams.get("participantId")?.trim() || undefined,
      inboxOnly: url.searchParams.get("inboxOnly") === "1",
      since: parseSince(url),
      limit: parseLimit(url),
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/broker/messages") {
    const agentId = url.searchParams.get("agentId")?.trim();
    if (!agentId) {
      badRequest(response, new Error("agentId is required"));
      return;
    }
    json(response, 200, await brokerService.readAgentBrokerFeed?.({
      agentId,
      since: parseSince(url),
      limit: parseLimit(url),
      includeAcknowledged: url.searchParams.get("includeAcknowledged") === "1"
        || url.searchParams.get("includeAcknowledged") === "true",
    }));
    return;
  }

  if (threadEventsMatch) {
    try {
      const conversationId = decodeURIComponent(threadEventsMatch[1] ?? "");
      const afterSeq = Number.parseInt(url.searchParams.get("afterSeq") ?? "0", 10);
      json(response, 200, await brokerService.readThreadEvents?.({
        conversationId,
        afterSeq: Number.isFinite(afterSeq) && afterSeq > 0 ? afterSeq : 0,
        limit: parseLimit(url),
      }));
    } catch (error) {
      threadWatchError(response, error);
    }
    return;
  }

  if (threadSnapshotMatch) {
    try {
      const conversationId = decodeURIComponent(threadSnapshotMatch[1] ?? "");
      json(response, 200, await brokerService.readThreadSnapshot?.(conversationId));
    } catch (error) {
      threadWatchError(response, error);
    }
    return;
  }

  if (readCursorsMatch && method === "GET") {
    const conversationId = decodeURIComponent(readCursorsMatch[1] ?? "");
    json(response, 200, listReadCursorsForConversation(conversationId));
    return;
  }

  if (readCursorsMatch && method === "POST") {
    try {
      const conversationId = decodeURIComponent(readCursorsMatch[1] ?? "");
      const body = await readRequestBody<{
        actorId?: string;
        operation?: "preferences";
        change?: unknown;
        readerNodeId?: string;
        lastReadMessageId?: string;
        lastReadSeq?: number;
        lastReadAt?: number;
        metadata?: Record<string, unknown>;
      }>(request);
      if (body.operation === "preferences") {
        if (!updateChatPreferences || typeof body.actorId !== "string" || !body.actorId.trim()) throw new Error("Preference writer and actor are required.");
        const preferences = await updateChatPreferences(conversationId, body.actorId, body.change);
        json(response, 200, { ok: true, preferences });
        return;
      }
      const cursor = await resolveReadCursor(conversationId, body);
      await recordReadCursor(cursor);
      const acknowledgedDeliveries = await acknowledgeDeliveriesForReadCursor(cursor);
      json(response, 200, { ok: true, cursor, acknowledgedDeliveries });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  /**
   * Name a conversation. An empty title hands it back to automatic naming.
   *
   * Goes out as an ordinary `conversation.upsert` so it journals, replicates
   * and reaches every surface the same way any other conversation change does.
   * The operator mark rides on metadata, and the derivation side reads it back
   * (see conversation-title.ts) so nothing automatic renames it again.
   */
  if (conversationQuestionMatch) {
    try {
      if (!respondToChatQuestion) throw new Error("Question responses are unavailable.");
      const body = await readRequestBody<{ actorId?: unknown; isOperator?: unknown; change?: unknown }>(request);
      if (typeof body.actorId !== "string" || !body.actorId.trim() || typeof body.isOperator !== "boolean") throw new ChatQuestionError(400, "Invalid question response identity.");
      const record = await respondToChatQuestion(decodeURIComponent(conversationQuestionMatch[1]!), decodeURIComponent(conversationQuestionMatch[2]!), body.actorId, body.isOperator, body.change);
      json(response, 200, { ok: true, record });
    } catch (error) {
      if (error instanceof ChatQuestionError) json(response, error.status, { error: error.message, status: error.status });
      else badRequest(response, error);
    }
    return;
  }

  if (conversationCorrectionsMatch) {
    try {
      if (!correctChatMessage) throw new Error("Message corrections are unavailable.");
      const body = await readRequestBody<{ messageId?: unknown; actorId?: unknown; canModerate?: unknown; change?: unknown }>(request);
      if (typeof body.actorId !== "string" || !body.actorId.trim() || typeof body.messageId !== "string" || typeof body.canModerate !== "boolean") throw new Error("Invalid message correction request.");
      const message = await correctChatMessage(decodeURIComponent(conversationCorrectionsMatch[1]!), body.messageId, body.actorId, body.canModerate, body.change);
      json(response, 200, { ok: true, message });
    } catch (error) {
      if (error instanceof ChatMessageCorrectionError) json(response, error.status, { error: error.message, status: error.status });
      else badRequest(response, error);
    }
    return;
  }

  if (conversationPinsMatch) {
    try {
      if (!updateConversationPins) throw new Error("Channel pins are unavailable.");
      const body = await readRequestBody<{ actorId?: unknown; change?: unknown }>(request);
      if (typeof body.actorId !== "string" || !body.actorId.trim()) throw new Error("actorId is required");
      const conversation = await updateConversationPins(decodeURIComponent(conversationPinsMatch[1]!), body.actorId, body.change);
      json(response, conversation ? 200 : 404, conversation ? { ok: true, conversation } : { error: "unknown conversation" });
    } catch (error) { badRequest(response, error); }
    return;
  }

  if (conversationTitleMatch) {
    try {
      const conversationId = decodeURIComponent(conversationTitleMatch[1] ?? "");
      const body = await readRequestBody<{ title?: unknown }>(request);
      const named = normalizeConversationTitle(body.title);
      const next = await setConversationTitle(conversationId, named);
      if (!next) {
        json(response, 404, { error: "unknown conversation", conversationId });
        return;
      }
      json(response, 200, { ok: true, conversation: next, titled: Boolean(named) });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/events") {
    json(response, 200, runtime.recentEvents(parseLimit(url)));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/activity") {
    json(response, 200, await brokerService.readActivity?.({
      limit: parseLimit(url),
      agentId: url.searchParams.get("agentId") ?? undefined,
      actorId: url.searchParams.get("actorId") ?? undefined,
      conversationId: url.searchParams.get("conversationId") ?? undefined,
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/collaboration/records") {
    json(response, 200, await brokerService.readCollaborationRecords?.({
      conversationId: url.searchParams.get("conversationId") ?? undefined,
      includeThreads: url.searchParams.get("includeThreads") === "true",
      orderByCreatedAt: url.searchParams.get("orderByCreatedAt") === "true",
      afterCreatedAt: url.searchParams.has("afterCreatedAt") ? Number(url.searchParams.get("afterCreatedAt")) : undefined,
      afterId: url.searchParams.get("afterId") ?? undefined,
      limit: parseLimit(url),
      kind: url.searchParams.get("kind") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      ownerId: url.searchParams.get("ownerId") ?? undefined,
      nextMoveOwnerId: url.searchParams.get("nextMoveOwnerId") ?? undefined,
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/collaboration/events") {
    json(response, 200, await brokerService.readCollaborationEvents?.({
      limit: parseLimit(url),
      recordId: url.searchParams.get("recordId") ?? undefined,
    }));
    return;
  }

  // ── Assigned roles + mission log (broker-canonical writer) ──
  if (method === "GET" && url.pathname === "/v1/roles/catalog") {
    json(response, 200, brokerRolesCatalog());
    return;
  }

  if (method === "GET" && url.pathname === "/v1/roles/assignments") {
    try {
      const db = deps.openRolesDb?.() ?? null;
      if (!db) {
        json(response, 503, { error: "roles_unavailable", detail: "control-plane roles store not open" });
        return;
      }
      json(response, 200, brokerListRoleAssignments(db, {
        agentId: url.searchParams.get("agentId") ?? undefined,
        missionId: url.searchParams.get("missionId") ?? undefined,
        roleId: url.searchParams.get("roleId") ?? undefined,
        activeOnly: url.searchParams.get("activeOnly") !== "0"
          && url.searchParams.get("activeOnly") !== "false",
        includeStanding: url.searchParams.get("includeStanding") !== "0",
        limit: parseLimit(url),
      }));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/roles/assignments") {
    try {
      const db = deps.openRolesDb?.() ?? null;
      if (!db) {
        json(response, 503, { error: "roles_unavailable", detail: "control-plane roles store not open" });
        return;
      }
      const body = await readRequestBody<{
        roleId?: string;
        agentId?: string;
        scope?: { kind?: string; missionId?: string; projectRoot?: string };
        assignedById?: string;
        enforceSingleOrchestrator?: boolean;
        metadata?: Record<string, unknown>;
      }>(request);
      if (!body.roleId?.trim() || !body.agentId?.trim()) {
        throw new Error("roleId and agentId are required");
      }
      const scope = parseRoleScope(body.scope ?? { kind: "agent" });
      json(response, 201, brokerAssignRole(db, {
        roleId: body.roleId.trim(),
        agentId: body.agentId.trim(),
        scope,
        assignedById: body.assignedById?.trim() || operatorActorId,
        enforceSingleOrchestrator: body.enforceSingleOrchestrator,
        metadata: body.metadata,
      }));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  const roleRevokeMatch = method === "POST"
    ? url.pathname.match(/^\/v1\/roles\/assignments\/([^/]+)\/revoke$/)
    : null;
  if (roleRevokeMatch) {
    try {
      const db = deps.openRolesDb?.() ?? null;
      if (!db) {
        json(response, 503, { error: "roles_unavailable", detail: "control-plane roles store not open" });
        return;
      }
      const assignmentId = decodeURIComponent(roleRevokeMatch[1] ?? "");
      const body = await readRequestBody<{ revokedById?: string }>(request).catch(() => ({} as { revokedById?: string }));
      json(response, 200, brokerRevokeRole(db, {
        assignmentId,
        revokedById: body.revokedById?.trim() || operatorActorId,
      }));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  const missionLogGetMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/missions\/([^/]+)\/log$/)
    : null;
  if (missionLogGetMatch) {
    try {
      const db = deps.openRolesDb?.() ?? null;
      if (!db) {
        json(response, 503, { error: "roles_unavailable", detail: "control-plane roles store not open" });
        return;
      }
      const missionId = decodeURIComponent(missionLogGetMatch[1] ?? "");
      const afterSeqRaw = url.searchParams.get("afterSeq");
      const afterSeq = afterSeqRaw ? Number.parseInt(afterSeqRaw, 10) : undefined;
      json(response, 200, brokerListMissionLog(db, {
        missionId,
        limit: parseLimit(url),
        afterSeq: Number.isFinite(afterSeq) ? afterSeq : undefined,
      }));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  const missionLogPostMatch = method === "POST"
    ? url.pathname.match(/^\/v1\/missions\/([^/]+)\/log$/)
    : null;
  if (missionLogPostMatch) {
    try {
      const db = deps.openRolesDb?.() ?? null;
      if (!db) {
        json(response, 503, { error: "roles_unavailable", detail: "control-plane roles store not open" });
        return;
      }
      const missionId = decodeURIComponent(missionLogPostMatch[1] ?? "");
      const body = await readRequestBody<{
        actorId?: string;
        kind?: string;
        intent?: string;
        status?: string;
        checkpoint?: string;
        nodeId?: string;
        note?: string;
        blockers?: Array<{ label: string; ownerId?: string }>;
        refs?: Record<string, string>;
        projectRoot?: string;
      }>(request);
      // Intentionally ignore any client bypassPermission field.
      if (!body.actorId?.trim() || !body.kind || !body.intent?.trim() || !body.status?.trim()) {
        throw new Error("actorId, kind, intent, and status are required");
      }
      json(response, 201, brokerAppendMissionLog(db, {
        missionId,
        actorId: body.actorId.trim(),
        kind: body.kind as import("@openscout/protocol").ScoutMissionLogKind,
        intent: body.intent,
        status: body.status,
        checkpoint: body.checkpoint,
        nodeId: body.nodeId,
        note: body.note,
        blockers: body.blockers,
        refs: body.refs,
      }, { projectRoot: body.projectRoot }));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/inbox") {
    try {
      json(response, 200, await deliveryHttpService.readInboxItems({
        targetId: url.searchParams.get("targetId"),
        statuses: parseInboxStatuses(url),
        reasons: parseInboxReasons(url),
        limit: parseLimit(url),
      }));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/inbox/stream") {
    try {
      const snapshot = await deliveryHttpService.readInboxSnapshot({
        targetId: url.searchParams.get("targetId"),
        statuses: parseInboxStatuses(url),
        reasons: parseInboxReasons(url),
        limit: parseLimit(url),
      });
      controlStreams.addInboxStream({
        request,
        response,
        targetId: snapshot.targetId,
        snapshot,
      });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/inbox/claim") {
    try {
      const body = await readRequestBody<InboxClaimRequest>(request);
      json(response, 200, await deliveryHttpService.claimInboxItem(body));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/inbox/ack") {
    try {
      const body = await readRequestBody<InboxAckRequest>(request);
      const result = await deliveryHttpService.acknowledgeInboxItem(body);
      json(response, result.status, result.body);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/inbox/nack") {
    try {
      const body = await readRequestBody<InboxNackRequest>(request);
      const result = await deliveryHttpService.nackInboxItem(body);
      json(response, result.status, result.body);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/deliveries") {
    json(response, 200, deliveryHttpService.listDeliveries({
      limit: parseLimit(url),
      transport: (url.searchParams.get("transport") as DeliveryIntent["transport"] | null) ?? undefined,
      status: (url.searchParams.get("status") as DeliveryIntent["status"] | null) ?? undefined,
      targetId: url.searchParams.get("targetId"),
      messageId: url.searchParams.get("messageId"),
      reason: url.searchParams.get("reason"),
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/deliveries/claim") {
    try {
      const body = await readRequestBody<DeliveryClaimBody>(request);
      json(response, 200, await deliveryHttpService.claimDelivery(body));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/delivery-attempts") {
    try {
      json(response, 200, deliveryHttpService.listDeliveryAttempts(url.searchParams.get("deliveryId")));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  const invocationLifecycleMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/invocations\/([^/]+)\/lifecycle$/)
    : null;
  if (invocationLifecycleMatch) {
    const invocationId = decodeURIComponent(invocationLifecycleMatch[1] ?? "");
    const lifecycle = await brokerService.readInvocationLifecycle?.({ invocationId });
    if (!lifecycle) {
      notFound(response);
      return;
    }
    json(response, 200, lifecycle);
    return;
  }

  // ── Machines (docs/eng/sco-104-machines.md) ────────────────────────────
  // The roster is durable, so every route here needs the store; without it the
  // honest answer is 503, not an empty list that reads like "no machines".
  if (url.pathname === "/v1/machines" || url.pathname.startsWith("/v1/machines/")) {
    if (!machines?.available) {
      json(response, 503, {
        error: "machines_unavailable",
        detail: "machine inventory requires broker SQLite persistence",
      });
      return;
    }

    try {
      if (method === "GET" && url.pathname === "/v1/machines") {
        // `?refresh=1` is the scan; the bare GET serves the cached roster so a
        // polling page never drives the probes.
        const refresh = parseBooleanQueryParam(url.searchParams.get("refresh")) === true;
        json(response, 200, await machines.list({ refresh }));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/machines/scan") {
        json(response, 200, await machines.scan({ refresh: true }));
        return;
      }

      const machineMatch = method === "GET" || method === "PATCH" || method === "DELETE"
        ? url.pathname.match(/^\/v1\/machines\/([^/]+)$/)
        : null;
      if (machineMatch) {
        const reference = decodeURIComponent(machineMatch[1] ?? "");
        const resolved = machines.resolve(reference);
        if (!resolved) {
          notFound(response);
          return;
        }
        if ("ambiguous" in resolved) {
          json(response, 400, {
            error: "ambiguous_machine",
            detail: `"${reference}" matches ${resolved.ambiguous.length} machines; use an exact id`,
            candidates: resolved.ambiguous,
          });
          return;
        }

        if (method === "GET") {
          json(response, 200, resolved.machine);
          return;
        }

        if (method === "PATCH") {
          const body = await readRequestBody<{
            displayName?: string | null;
            notes?: string | null;
            pinned?: boolean;
          }>(request);
          const updated = machines.annotate(resolved.machine.id, {
            ...(body?.displayName !== undefined ? { displayName: body.displayName } : {}),
            ...(body?.notes !== undefined ? { notes: body.notes } : {}),
            ...(typeof body?.pinned === "boolean" ? { pinned: body.pinned } : {}),
          });
          if (!updated) {
            notFound(response);
            return;
          }
          json(response, 200, updated);
          return;
        }

        if (method === "DELETE") {
          json(response, 200, { forgotten: machines.forget(resolved.machine.id) });
          return;
        }
      }
    } catch (error) {
      if (error instanceof MachineInventoryUnavailableError) {
        json(response, 503, { error: "machines_unavailable", detail: error.message });
        return;
      }
      badRequest(response, error);
      return;
    }
  }

  if (method === "GET" && url.pathname === "/v1/mesh/nodes") {
    json(response, 200, runtime.snapshot().nodes);
    return;
  }

  // Observe-tier compact node state (mesh trust cone §4). The remote-tier twin
  // of the local-only home feed: identity plus bounded workload state for the
  // agents homed HERE, so a peer's Network view can distinguish "broker
  // answered" from "workload unknown" without any local route being widened.
  if (method === "GET" && url.pathname === "/v1/mesh/node-state") {
    if (!brokerService.readMeshNodeState) {
      notFound(response);
      return;
    }
    json(response, 200, await brokerService.readMeshNodeState({
      ...(url.searchParams.get("projectRoot") ? { projectRoot: url.searchParams.get("projectRoot")! } : {}),
      ...(url.searchParams.get("agentId") ? { agentId: url.searchParams.get("agentId")! } : {}),
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/pairing/sessions") {
    try {
      json(response, 200, await managedSessionHttpService.listPairingSessionCandidates());
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (await handleBrokerHistoryRoute(request, response, url, deps.historyQueries, json)) return;
  if (await handleBrokerQuarantineRoute(request, response, url, deps.quarantineQueries, json)) return;

  async function readInvocationSnapshot(invocationId: string) {
    const invocation = knownInvocations.get(invocationId);
    const flight = runtime.flightForInvocation(invocationId);
    const deliveries = journal.listDeliveries({ invocationId, limit: 500 });
    const dispatches = journal.listScoutDispatches({ invocationId, limit: 50 });
    if ((invocation && flight) || !deps.readHistoricalInvocationSnapshot) {
      return { invocationId, invocation: invocation ?? null, flight: flight ?? null, deliveries, dispatches };
    }
    const stored = await deps.readHistoricalInvocationSnapshot(invocationId);
    // A live transition may occur during the worker read. Refresh synchronously
    // before seeding SSE so its terminal state cannot fall into the read/subscribe gap.
    const currentInvocation = knownInvocations.get(invocationId) ?? invocation;
    const currentFlight = runtime.flightForInvocation(invocationId) ?? flight;
    const currentDeliveries = journal.listDeliveries({ invocationId, limit: 500 });
    const mergedDeliveries = new Map(stored.deliveries.map(delivery => [delivery.id, delivery]));
    for (const delivery of currentDeliveries) mergedDeliveries.set(delivery.id, delivery);
    return { invocationId, invocation: currentInvocation ?? stored.invocation, flight: currentFlight ?? stored.flight,
      deliveries: [...mergedDeliveries.values()], dispatches };
  }

  // Per-invocation snapshot — current state of the invocation, its flight,
  // its deliveries, and any scout dispatch that fired for it. Callers use
  // this to seed UI state before subscribing to the stream.
  const invocationSnapshotMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/invocations\/([^/]+)$/)
    : null;
  if (invocationSnapshotMatch) {
    const invocationId = decodeURIComponent(invocationSnapshotMatch[1] ?? "");
    try {
      json(response, 200, await readInvocationSnapshot(invocationId));
    } catch (error) {
      json(response, 503, { error: "invocation_storage_unavailable", retryable: true, detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // Per-invocation SSE — initial snapshot frame, then every event whose
  // payload references this invocation. Caller closes the stream when done.
  // The /v1/mesh twin is the remote-tier mount (mesh trust cone §4): the
  // originator's delivery status mirror subscribes to it across the mesh in
  // enforce mode; the local-tier route stays loopback-only.
  const invocationStreamMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/invocations\/([^/]+)\/stream$/)
    : null;
  const meshInvocationStreamMatch = method === "GET"
    ? url.pathname.match(/^\/v1\/mesh\/invocations\/([^/]+)\/stream$/)
    : null;
  const anyInvocationStreamMatch = invocationStreamMatch ?? meshInvocationStreamMatch;
  if (anyInvocationStreamMatch) {
    const invocationId = decodeURIComponent(anyInvocationStreamMatch[1] ?? "");
    try {
      const snapshot = await readInvocationSnapshot(invocationId);
      snapshot.invocation = knownInvocations.get(invocationId) ?? snapshot.invocation;
      snapshot.flight = runtime.flightForInvocation(invocationId) ?? snapshot.flight;
      const currentDeliveries = new Map(snapshot.deliveries.map(delivery => [delivery.id, delivery]));
      for (const delivery of journal.listDeliveries({ invocationId, limit: 500 })) currentDeliveries.set(delivery.id, delivery);
      snapshot.deliveries = [...currentDeliveries.values()];
      controlStreams.addInvocationStream({ request, response, invocationId, snapshot });
    } catch (error) {
      json(response, 503, { error: "invocation_storage_unavailable", retryable: true, detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v1/events/stream") {
    controlStreams.addEventStream({
      request,
      response,
      hello: { nodeId, meshId },
    });
    return;
  }

  if (threadWatchStreamMatch) {
    try {
      const watchId = decodeURIComponent(threadWatchStreamMatch[1] ?? "");
      await threadEvents.streamWatch(watchId, request, response);
    } catch (error) {
      threadWatchError(response, error);
    }
    return;
  }

  if (await handleBrokerHttpEntityWriteRoute({
    method,
    url,
    request,
    response,
    deps: {
      brokerService,
      recordFlight,
    },
  })) {
    return;
  }

  if (method === "POST" && url.pathname === "/v1/mesh/discover") {
    try {
      const body = await readRequestBody<{ seeds?: string[] }>(request);
      const result = await meshDiscoveryService.discoverPeers(body.seeds ?? []);
      json(response, 200, {
        ok: true,
        discovered: result.discovered,
        probes: result.probes,
      });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  // P1.5 restart-free bind flip (§11.5): machine-local only — re-check
  // transport regardless of gate mode so verify-warn never elevates this.
  if (method === "POST" && url.pathname === "/v1/mesh/bind") {
    if (!meshBind) {
      notFound(response);
      return;
    }
    if (denyRemoteMutation()) return;
    try {
      const body = await readRequestBody<{ scope?: string }>(request);
      const scope = body.scope?.trim().toLowerCase();
      if (scope !== "mesh" && scope !== "local") {
        badRequest(response, "scope must be \"mesh\" or \"local\"");
        return;
      }
      const state = await meshBind.applyScope(scope);
      json(response, 200, { bind: state });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/mesh/messages") {
    try {
      const bundle = await readRequestBody<MeshMessageBundle>(request);
      const result = await meshHttpService.receiveMessageBundle(bundle);
      json(response, result.status, result.body);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/mesh/invocations") {
    try {
      const bundle = await readRequestBody<MeshInvocationBundle>(request);
      const result = await meshHttpService.receiveInvocationBundle(bundle);
      json(response, result.status, result.body);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/mesh/sessions/wake") {
    try {
      const input = await readRequestBody<{
        nativeSessionId?: string;
        harness?: string;
        projectPath?: string;
      }>(request);
      const nativeSessionId = input?.nativeSessionId?.trim();
      if (!nativeSessionId) {
        json(response, 400, { error: "nativeSessionId is required" });
        return;
      }
      if (!wakeMeshHarnessSession) {
        json(response, 200, {
          ok: false,
          reason: "session_unknown",
          detail: "this broker does not support mesh session wake",
        });
        return;
      }
      // Domain misses ride a 200 {ok:false} body so callers can tell them
      // apart from transport failures (which surface as non-2xx).
      json(response, 200, await wakeMeshHarnessSession({
        nativeSessionId,
        ...(input?.harness?.trim() ? { harness: input.harness.trim() } : {}),
        ...(input?.projectPath?.trim() ? { projectPath: input.projectPath.trim() } : {}),
      }));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/mesh/sessions/start") {
    try {
      const input = await readRequestBody<{
        projectPath?: string;
        harness?: string;
        model?: string;
        reasoningEffort?: string;
        placement?: string;
        requesterId?: string;
      }>(request);
      const projectPath = input?.projectPath?.trim();
      if (!projectPath) {
        json(response, 400, { error: "projectPath is required" });
        return;
      }
      if (!startMeshProjectSession) {
        json(response, 200, {
          ok: false,
          reason: "unsupported",
          detail: "this broker does not support mesh session start",
        });
        return;
      }
      const optional = (value: string | undefined) => value?.trim() || undefined;
      // Domain misses ride a 200 {ok:false} body, as with mesh session wake.
      json(response, 200, await startMeshProjectSession({
        projectPath,
        ...(optional(input?.harness) ? { harness: optional(input?.harness) } : {}),
        ...(optional(input?.model) ? { model: optional(input?.model) } : {}),
        ...(optional(input?.reasoningEffort) ? { reasoningEffort: optional(input?.reasoningEffort) } : {}),
        ...(optional(input?.placement) ? { placement: optional(input?.placement) } : {}),
        ...(optional(input?.requesterId) ? { requesterId: optional(input?.requesterId) } : {}),
      }));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/mesh/collaboration/records") {
    try {
      const bundle = await readRequestBody<MeshCollaborationRecordBundle>(request);
      const result = await meshHttpService.receiveCollaborationRecordBundle(bundle);
      json(response, result.status, result.body);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/mesh/collaboration/events") {
    try {
      const bundle = await readRequestBody<MeshCollaborationEventBundle>(request);
      const result = await meshHttpService.receiveCollaborationEventBundle(bundle);
      json(response, result.status, result.body);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/pairing/attach") {
    try {
      const input = await readRequestBody<ManagedPairingAttachBody>(request);
      json(response, 200, await managedSessionHttpService.attachPairingSession(input));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/pairing/detach") {
    try {
      const input = await readRequestBody<ManagedPairingDetachBody>(request);
      json(response, 200, await managedSessionHttpService.detachPairingSession(input));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/local-sessions/attach") {
    try {
      const input = await readRequestBody<ManagedLocalSessionAttachBody>(request);
      json(response, 200, await managedSessionHttpService.attachLocalSession(input));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/local-sessions/ensure") {
    try {
      const input = await readRequestBody<ManagedLocalSessionEnsureBody>(request);
      json(response, 200, await managedSessionHttpService.ensureLocalSession(input));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/local-sessions/detach") {
    try {
      const input = await readRequestBody<ManagedLocalSessionDetachBody>(request);
      json(response, 200, await managedSessionHttpService.detachLocalSession(input));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (collaborationInvokeMatch) {
    try {
      const recordId = decodeURIComponent(collaborationInvokeMatch[1] ?? "");
      const record = runtime.collaborationRecord(recordId);
      if (!record) {
        throw new Error(`unknown collaboration record: ${recordId}`);
      }

      const body = await readRequestBody<{
        requesterId?: string;
        requesterNodeId?: string;
        targetAgentId?: string;
        action?: InvocationRequest["action"];
        task?: string;
        messageId?: string;
        ensureAwake?: boolean;
        stream?: boolean;
        timeoutMs?: number;
        metadata?: Record<string, unknown>;
      }>(request);

      const invocation = buildCollaborationInvocation(record, {
        requesterId: body.requesterId?.trim() || operatorActorId,
        requesterNodeId: body.requesterNodeId?.trim() || nodeId,
        targetAgentId: body.targetAgentId?.trim() || undefined,
        action: body.action,
        task: body.task,
        messageId: body.messageId,
        ensureAwake: body.ensureAwake,
        stream: body.stream,
        timeoutMs: body.timeoutMs,
        metadata: body.metadata,
      });

      const result = await handleCommand({
        kind: "agent.invoke",
        invocation,
      });
      json(response, 200, {
        ...(result as Record<string, unknown>),
        recordId,
        targetAgentId: invocation.targetAgentId,
        wakeReason: invocation.wakeReason,
        invocation,
      });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/commands") {
    try {
      const command = await readRequestBody<ControlCommand>(request);
      // Deliberately not a general command executor. The broker accepts only
      // the command kinds that have to cross the process boundary from the web
      // server, because every other kind already has a purpose-built route
      // with its own validation. Widening this list is a security decision,
      // not a convenience one.
      if (!CHANNEL_INVITE_COMMAND_KINDS.has(command?.kind as string)) {
        json(response, 400, {
          error: `${command?.kind ?? "command"} is not accepted on /v1/commands.`,
        });
        return;
      }
      json(response, 200, await handleCommand(command));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/delivery-attempts") {
    try {
      const attempt = await readRequestBody<DeliveryAttemptBody>(request);
      json(response, 200, await deliveryHttpService.recordDeliveryAttempt(attempt));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/durable-actions") {
    try {
      const action = await readRequestBody<DurableAction>(request);
      json(response, 200, await durableActionHttpService.recordAction(action));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (durableActionHeartbeatMatch) {
    try {
      const actionId = decodeURIComponent(durableActionHeartbeatMatch[1] ?? "");
      const body = await readRequestBody<DurableActionHeartbeatBody>(request);
      const result = await durableActionHttpService.heartbeat(actionId, body);
      json(response, result.status, result.body);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/deliveries/status") {
    try {
      const body = await readRequestBody<DeliveryStatusBody>(request);
      json(response, 200, await deliveryHttpService.updateDeliveryStatus(body));
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/v1/request-receipts/")) {
    try {
      const key = decodeURIComponent(url.pathname.slice("/v1/request-receipts/".length));
      const requesterId = url.searchParams.get("requesterId") || "";
      const operation = url.searchParams.get("operation") || "deliver";
      let receipt = await requestReceipts.get(requesterId, key, operation);
      // The broker can die after committing canonical work but before saving its
      // receipt. Recover only from positive evidence; absence never authorizes replacement.
      if (receipt?.state === "unknown") {
        const snapshot = runtime.snapshot();
        if (operation === "deliver") {
          const recovered = await deliveryAcceptanceService.recoverReceipt?.(requesterId, key);
          if (recovered) receipt = await requestReceipts.recover(requesterId, key, operation, recovered);
          const message = Object.values(snapshot.messages ?? {}).find(m => m.actorId === requesterId && m.metadata?.requestId === key);
          const invocation = message && Object.values(snapshot.invocations ?? {}).find(i => i.messageId === message.id);
          const flight = invocation && runtime.flightForInvocation(invocation.id);
          const conversation = message && snapshot.conversations[message.conversationId];
          if (!recovered && message && conversation && (flight || message.metadata?.requestIntent === "tell")) {
            receipt = await requestReceipts.recover(requesterId, key, operation, {
              kind: "delivery", accepted: true, conversation, message,
              ...(flight ? { flight, targetAgentId: flight.targetAgentId } : {}),
            });
          }
        } else if (operation === "invoke") {
          const invocation = Object.values(snapshot.invocations ?? {}).find(i => i.requesterId === requesterId && i.requestId === key);
          const flight = invocation && runtime.flightForInvocation(invocation.id);
          if (invocation && flight) receipt = await requestReceipts.recover(requesterId, key, operation,
            { accepted: true, invocationId: invocation.id, flightId: flight.id, targetAgentId: flight.targetAgentId, state: flight.state, flight });
        }
      }
      json(response, 200, { receipt });
    } catch (error) { badRequest(response, error); }
    return;
  }

  if (method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/reply")) {
    try {
      let message = await readRequestBody<MessageRecord>(request);
      if (url.pathname === "/v1/messages/reply" && (!message.requestId || !completionReply(message))) {
        throw new Error("explicit reply requires requestId and completionReply identity");
      }
      if (message.requestId) {
        if (!message.requestId.trim() || message.requestId.length > 256) throw new Error("invalid message requestId");
        const id = `msg.request.${createHash("sha256").update(JSON.stringify([message.actorId, message.requestId])).digest("hex")}`;
        message = { ...message, id, metadata: { ...message.metadata, clientMessageId: id } };
      }
      const result = await brokerService.postConversationMessage?.(message);
      json(response, 200, result);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (
    method === "POST"
    && (url.pathname === "/v1/message-reactions"
      || url.pathname === "/v1/message-reactions/remove")
  ) {
    try {
      const body = await readRequestBody<{
        channelId?: string;
        messageId?: string;
        actorId?: string;
        emoji?: string;
        createdAt?: number;
      }>(request);
      const channelId = body.channelId?.trim();
      const messageId = body.messageId?.trim();
      const actorId = body.actorId?.trim();
      const emoji = body.emoji?.trim();
      if (!channelId || !messageId || !actorId || !emoji) {
        throw new Error("channelId, messageId, actorId, and emoji are required");
      }
      const removing = url.pathname === "/v1/message-reactions/remove";
      const result = removing
        ? await brokerService.removeMessageReaction?.({ channelId, messageId, actorId, emoji })
        : await brokerService.upsertMessageReaction?.({
          channelId,
          messageId,
          actorId,
          emoji,
          createdAt: typeof body.createdAt === "number" ? body.createdAt : Date.now(),
        });
      json(response, 200, result ?? { replayed: false });
    } catch (error) {
      const status = (error as { status?: number }).status;
      const reason = (error as { reason?: string }).reason;
      if (typeof status === "number" && typeof reason === "string") {
        json(response, status, {
          error: reason,
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/rendezvous/match") {
    try {
      const payload = await readRequestBody<ScoutRendezvousRequest>(request);
      const result = await rendezvousService.match(payload);
      const status = result.status === "not_found"
        ? 404
        : result.status === "expired"
          ? 410
          : result.status === "codename_busy"
            || result.status === "consumed"
            || result.status === "project_mismatch"
            ? 409
            : 200;
      json(response, status, result);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/deliver") {
    const signal = requestAbortSignal(request, response);
    try {
      const payload = await readValidatedRequestBody(request, brokerDeliverRequestSchema);
      if ((payload.completion || payload.relation) && payload.target
        && payload.target.kind !== "agent_id" && payload.target.kind !== "session_id") {
        throw new Error("completion_route_unsupported");
      }
      if (
        !payload.requestId && payload.target?.kind === "route_alias"
        && await forwardAliasIfRemote(payload.target.scope?.nodeId, url.pathname, "POST", payload)
      ) return;
      if (payload.requestId && !deps.deliveryReceiptsOwnedByService) {
        if (typeof payload.requestId !== "string") throw new Error("invalid requestId");
        payload.messageMetadata = { ...payload.messageMetadata, requestId: payload.requestId, requestIntent: payload.intent };
        payload.invocationMetadata = { ...payload.invocationMetadata, requestId: payload.requestId };
      }
      const reserveInRouter = Boolean(payload.requestId && (!deps.deliveryReceiptsOwnedByService
        || (payload.target?.kind === "route_alias" && payload.target.scope?.nodeId && forwardRouteAliasRequest)));
      const accept = async (): Promise<ScoutDeliverResponse> => {
        if (payload.requestId && payload.target?.kind === "route_alias" && payload.target.scope?.nodeId && forwardRouteAliasRequest) {
          const forwarded = await forwardRouteAliasRequest({ nodeSelector: payload.target.scope.nodeId, path: url.pathname, method: "POST", body: payload });
          if (forwarded) {
            if (forwarded.status >= 500) throw new Error("forwarded request outcome unknown");
            return forwarded.body as ScoutDeliverResponse;
          }
        }
        if (reserveInRouter && deps.deliveryReceiptsOwnedByService) {
          return deliveryAcceptanceService.accept(payload, { receiptReserved: true, admissionReserved: true });
        }
        return brokerService.deliver ? brokerService.deliver(payload, { signal }) : deliveryAcceptanceService.accept(payload, { signal });
      };
      const result = payload.requestId && reserveInRouter
        ? await requestReceipts.run(payload.caller?.actorId || payload.requesterId || operatorActorId,
            payload.requestId, "deliver", payload, accept,
            deps.deliveryReceiptsOwnedByService ? () => deliveryAcceptanceService.recoverReceipt(payload.caller?.actorId || payload.requesterId || operatorActorId, payload.requestId!) : undefined,
            deps.deliveryReceiptsOwnedByService ? () => deliveryAcceptanceService.reserveCommand(payload) : undefined)
        : await accept();
      throwIfAborted(signal);
      json(
        response,
        result.kind === "delivery" ? 202 : result.kind === "question" ? 409 : 422,
        result,
      );
    } catch (error) {
      if (signal.aborted || response.destroyed || response.writableEnded) {
        return;
      }
      badRequest(response, error);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/invocations") {
    try {
      const runtimeCatalogSnapshot = await brokerService.readRuntimeCatalog?.({})
        .catch(() => null);
      const payload = await readValidatedRequestBody(
        request,
        brokerInvocationRequestSchemaFor(runtimeCatalogSnapshot?.catalog),
      );
      if (
        !payload.requestId && payload.target?.kind === "route_alias"
        && await forwardAliasIfRemote(payload.target.scope?.nodeId, url.pathname, "POST", payload)
      ) return;
      const invoke = async () => {
        if (payload.requestId && payload.target?.kind === "route_alias" && payload.target.scope?.nodeId && forwardRouteAliasRequest) {
          const forwarded = await forwardRouteAliasRequest({ nodeSelector: payload.target.scope.nodeId, path: url.pathname, method: "POST", body: payload });
          if (forwarded) {
            if (forwarded.status >= 500) throw new Error("forwarded request outcome unknown");
            return forwarded.body as Awaited<ReturnType<typeof handleInvocationRequest>>;
          }
        }
        return brokerService.invokeAgent ? brokerService.invokeAgent(payload) : handleInvocationRequest(payload);
      };
      const result = payload.requestId
        ? await requestReceipts.run(payload.requesterId, payload.requestId, "invoke", payload, invoke)
        : await invoke();
      json(response, 202, result);
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  // Generic native-owner control only. Room policy/state/loop remains in scout-listening.
  if (url.pathname === "/v1/native-session-attention" && method === "POST") {
    if (request.transportContext?.transport === "remote" || request.headers["x-openscout-forwarded-node-id"]
      || request.headers.origin) { json(response, 403, { error: "machine_local_only" }); return; }
    try {
      const input = await readRequestBody<any>(request, { maxBytes: 8192, requireJsonContentType: true });
      const endpoint = typeof input?.endpointId === "string" ? runtime.peek?.().endpoints[input.endpointId] : undefined;
      if (!endpoint || endpoint.nodeId !== nodeId) { json(response, 200, { state: "unknown" }); return; }
      if (input.action !== undefined && (!["revive", "steer"].includes(input.action)
        || typeof input.sessionId !== "string" || typeof input.token !== "string"
        || typeof input.prompt !== "string" || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 4096)) {
        json(response, 400, { error: "invalid_native_input" }); return;
      }
      const { nativeSessionAttention } = await import("./native-session-attention.js");
      json(response, 200, await nativeSessionAttention(endpoint, input.action === undefined ? undefined : input, () => {
        const current = runtime.peek?.().endpoints[input.endpointId];
        return !!current && current.nodeId === nodeId && current.agentId === endpoint.agentId
          && current.sessionId === endpoint.sessionId && current.transport === endpoint.transport
          && current.metadata?.agentName === endpoint.metadata?.agentName
          && current.metadata?.runtimeInstanceId === endpoint.metadata?.runtimeInstanceId
          && current.metadata?.runtimeSessionId === endpoint.metadata?.runtimeSessionId
          && current.metadata?.definitionId === endpoint.metadata?.definitionId
          && !current.pane && current.metadata?.placement === "background"
          && !["stopped", "superseded"].includes(current.state)
          && !hasRetiredEndpointRegistration(current);
      }));
    } catch { json(response, 503, { error: "native_submission_unknown" }); }
    return;
  }

  // Local endpoint inventory. Registration already uses POST /v1/endpoints;
  // this read avoids pretending agents-only discovery carries live sessions.
  if (method === "GET" && url.pathname === "/v1/endpoints") {
    if (!runtime.peek) { json(response, 503, { error: "endpoint_inventory_unavailable" }); return; }
    const agentId = url.searchParams.get("agentId"), endpointId = url.searchParams.get("endpointId");
    const all = runtime.peek().endpoints;
    const endpoints = endpointId ? (all[endpointId] ? [all[endpointId]!] : []) : Object.values(all);
    json(response, 200, { endpoints: endpoints.filter(e => !agentId || e.agentId === agentId) });
    return;
  }

  // ─── External agent endpoints (SCO-016) ────────────────────────────────────
  if (method === "DELETE" && url.pathname.startsWith("/v1/endpoints/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/endpoints/".length));
    await deleteEndpoint(id);
    json(response, 200, { ok: true });
    return;
  }

  // ─── External agent cards (SCO-016) ────────────────────────────────────────
  if (method === "GET" && url.pathname === "/v1/agent-cards") {
    json(response, 200, { cards: await a2aService.listScoutAgentCards() });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/agent-cards") {
    try {
      const input = await readRequestBody<ExternalAgentCardInput>(request);
      const card = upsertScoutAgentCardFromInput(runtime, input);
      json(response, 200, { ok: true, card });
    } catch (error) {
      badRequest(response, error);
    }
    return;
  }

  notFound(response);
};
}
