import type {
  ActorIdentity,
  AgentDefinition,
  CollaborationEvent,
  CollaborationRecord,
  ConversationBinding,
  ConversationDefinition,
  FlightRecord,
  IrohMeshEntrypoint,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
} from "@openscout/protocol";
import {
  OPENSCOUT_IROH_MESH_ALPN,
  OPENSCOUT_MESH_PROTOCOL_VERSION,
  collaborationRequesterId,
  isWorkItem,
} from "@openscout/protocol";
import type { DeliveryIntent, ScoutId } from "@openscout/protocol";
import {
  canUseIrohBridge,
  forwardIrohMeshEnvelope,
  type IrohBridgeForwardOptions,
  type IrohBridgeMeshRoute,
} from "./iroh-bridge.js";
import {
  meshPeerFetch,
  isMeshPeerTrustError,
  type MeshPeerFetch,
} from "./mesh-peer-client.js";
import { httpMeshUrlsForNode, orderMeshDialUrls } from "./mesh-dial-order.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { readMessageRecord } from "./broker-message-records.js";

/**
 * Peer discovery should carry only an agent roster. The current local roster is
 * well below 1 MiB; 2 MiB leaves ample growth room while preventing a legacy
 * peer from making us buffer and parse its complete registry snapshot.
 */
export const MAX_PEER_AGENT_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/**
 * A peer returned something other than the bounded agent-roster projection.
 * Discovery treats this differently from ordinary reachability failures so a
 * legacy peer cannot make every sweep download the full response up to the
 * local byte ceiling.
 */
export class PeerAgentSnapshotTooLargeError extends Error {
  override readonly name = "PeerAgentSnapshotTooLargeError";

  constructor(
    readonly brokerUrl: string,
    readonly observedBytes: number,
    readonly maxBytes = MAX_PEER_AGENT_SNAPSHOT_BYTES,
  ) {
    super(`peer agent snapshot from ${brokerUrl} exceeds ${maxBytes} bytes`);
  }
}

export interface MeshMessageBundle {
  originNode: NodeDefinition;
  conversation: ConversationDefinition;
  actors: ActorIdentity[];
  agents: AgentDefinition[];
  bindings: ConversationBinding[];
  message: MessageRecord;
}

export interface MeshInvocationBundle {
  originNode: NodeDefinition;
  actors: ActorIdentity[];
  agents: AgentDefinition[];
  conversation?: ConversationDefinition;
  /** Scout-owned request anchor, replicated without dispatching it again. */
  message?: MessageRecord;
  invocation: InvocationRequest;
}

export interface MeshCollaborationRecordBundle {
  originNode: NodeDefinition;
  actors: ActorIdentity[];
  agents: AgentDefinition[];
  conversation?: ConversationDefinition;
  record: CollaborationRecord;
}

export interface MeshCollaborationEventBundle {
  originNode: NodeDefinition;
  actors: ActorIdentity[];
  agents: AgentDefinition[];
  conversation?: ConversationDefinition;
  record?: CollaborationRecord;
  event: CollaborationEvent;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function invocationMetadataValue(
  invocation: InvocationRequest,
  key: string,
): unknown {
  const contextValue = invocation.context?.[key];
  if (typeof contextValue !== "undefined") {
    return contextValue;
  }

  const nestedContext = invocation.context?.collaboration;
  if (nestedContext && typeof nestedContext === "object" && !Array.isArray(nestedContext) && key in nestedContext) {
    return (nestedContext as Record<string, unknown>)[key];
  }

  const metadataValue = invocation.metadata?.[key];
  if (typeof metadataValue !== "undefined") {
    return metadataValue;
  }

  const nestedMetadata = invocation.metadata?.collaboration;
  if (nestedMetadata && typeof nestedMetadata === "object" && !Array.isArray(nestedMetadata) && key in nestedMetadata) {
    return (nestedMetadata as Record<string, unknown>)[key];
  }

  return undefined;
}

function invocationStringValue(
  invocation: InvocationRequest,
  key: string,
): string | undefined {
  const value = invocationMetadataValue(invocation, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function actorIdsForMessage(
  snapshot: Readonly<RuntimeRegistrySnapshot>,
  conversation: ConversationDefinition,
  message: MessageRecord,
): string[] {
  return unique([
    ...conversation.participantIds,
    message.actorId,
    ...(message.mentions ?? []).map((mention) => mention.actorId),
    ...(message.audience?.notify ?? []),
    ...(message.audience?.invoke ?? []),
  ]).filter((id) => Boolean(snapshot.actors[id] || snapshot.agents[id]));
}

function actorIdsForInvocation(
  snapshot: Readonly<RuntimeRegistrySnapshot>,
  invocation: InvocationRequest,
): string[] {
  return unique([
    invocation.requesterId,
    invocation.targetAgentId,
    invocationStringValue(invocation, "ownerId"),
    invocationStringValue(invocation, "nextMoveOwnerId"),
    invocationStringValue(invocation, "requestedById"),
    invocationStringValue(invocation, "askedById"),
    invocationStringValue(invocation, "askedOfId"),
    invocationStringValue(invocation, "targetAgentId"),
    (() => {
      const waitingOn = invocationMetadataValue(invocation, "waitingOn");
      if (!waitingOn || typeof waitingOn !== "object" || Array.isArray(waitingOn)) {
        return undefined;
      }
      return typeof (waitingOn as { targetId?: unknown }).targetId === "string"
        ? String((waitingOn as { targetId: string }).targetId).trim()
        : undefined;
    })(),
  ].filter((id): id is string => typeof id === "string" && id.trim().length > 0))
    .filter((id) => Boolean(snapshot.actors[id] || snapshot.agents[id]));
}

function actorIdsForCollaboration(
  snapshot: Readonly<RuntimeRegistrySnapshot>,
  record: CollaborationRecord,
  conversation?: ConversationDefinition,
): string[] {
  const ids = new Set<string>();

  ids.add(record.createdById);
  if (record.ownerId) ids.add(record.ownerId);
  if (record.nextMoveOwnerId) ids.add(record.nextMoveOwnerId);

  // requestedById (work item) / askedById (question) — never drop questions.
  const requesterId = collaborationRequesterId(record);
  if (requesterId) ids.add(requesterId);
  if (isWorkItem(record) && record.waitingOn?.kind === "actor" && record.waitingOn.targetId) {
    ids.add(record.waitingOn.targetId);
  }

  for (const participantId of conversation?.participantIds ?? []) {
    ids.add(participantId);
  }

  return [...ids].filter((id) => Boolean(snapshot.actors[id] || snapshot.agents[id]));
}

export function buildMeshMessageBundle(
  snapshot: Readonly<RuntimeRegistrySnapshot>,
  originNode: NodeDefinition,
  message: MessageRecord,
  options: { bindings?: ConversationBinding[] } = {},
): MeshMessageBundle {
  const conversation = snapshot.conversations[message.conversationId];
  if (!conversation) {
    throw new Error(`missing conversation ${message.conversationId} for mesh forward`);
  }

  const actorIds = actorIdsForMessage(snapshot, conversation, message);
  return {
    originNode,
    conversation,
    actors: actorIds
      .map((id) => snapshot.actors[id])
      .filter((entry): entry is ActorIdentity => Boolean(entry)),
    agents: actorIds
      .map((id) => snapshot.agents[id])
      .filter((entry): entry is AgentDefinition => Boolean(entry)),
    bindings: options.bindings ?? Object.values(snapshot.bindings).filter((binding) => binding.conversationId === conversation.id),
    message,
  };
}

export function buildMeshInvocationBundle(
  snapshot: Readonly<RuntimeRegistrySnapshot>,
  originNode: NodeDefinition,
  invocation: InvocationRequest,
): MeshInvocationBundle {
  const actorIds = actorIdsForInvocation(snapshot, invocation);

  return {
    originNode,
    actors: actorIds
      .map((id) => snapshot.actors[id])
      .filter((entry): entry is ActorIdentity => Boolean(entry)),
    agents: actorIds
      .map((id) => snapshot.agents[id])
      .filter((entry): entry is AgentDefinition => Boolean(entry)),
    conversation: invocation.conversationId
      ? snapshot.conversations[invocation.conversationId]
      : undefined,
    message: invocation.messageId ? snapshot.messages[invocation.messageId] : undefined,
    invocation,
  };
}

export async function buildMeshInvocationBundleAsync(
  snapshot: Readonly<RuntimeRegistrySnapshot>,
  originNode: NodeDefinition,
  invocation: InvocationRequest,
): Promise<MeshInvocationBundle> {
  const message = invocation.messageId
    ? await readMessageRecord(snapshot.messages, invocation.messageId)
    : undefined;
  // Async history views do not support synchronous property reads.
  const bundle = buildMeshInvocationBundle({ ...snapshot, messages: {} }, originNode, invocation);
  return { ...bundle, message };
}

export function buildMeshCollaborationRecordBundle(
  snapshot: Readonly<RuntimeRegistrySnapshot>,
  originNode: NodeDefinition,
  record: CollaborationRecord,
): MeshCollaborationRecordBundle {
  const conversation = record.conversationId
    ? snapshot.conversations[record.conversationId]
    : undefined;
  const actorIds = actorIdsForCollaboration(snapshot, record, conversation);

  return {
    originNode,
    conversation,
    actors: actorIds
      .map((id) => snapshot.actors[id])
      .filter((entry): entry is ActorIdentity => Boolean(entry)),
    agents: actorIds
      .map((id) => snapshot.agents[id])
      .filter((entry): entry is AgentDefinition => Boolean(entry)),
    record,
  };
}

export function buildMeshCollaborationEventBundle(
  snapshot: Readonly<RuntimeRegistrySnapshot>,
  originNode: NodeDefinition,
  event: CollaborationEvent,
  record?: CollaborationRecord,
): MeshCollaborationEventBundle {
  const resolvedRecord = record ?? snapshot.collaborationRecords[event.recordId];
  const conversation = resolvedRecord?.conversationId
    ? snapshot.conversations[resolvedRecord.conversationId]
    : undefined;
  const actorIds = resolvedRecord
    ? actorIdsForCollaboration(snapshot, resolvedRecord, conversation)
    : [event.actorId];

  return {
    originNode,
    conversation,
    actors: actorIds
      .map((id) => snapshot.actors[id])
      .filter((entry): entry is ActorIdentity => Boolean(entry)),
    agents: actorIds
      .map((id) => snapshot.agents[id])
      .filter((entry): entry is AgentDefinition => Boolean(entry)),
    record: resolvedRecord,
    event,
  };
}

/**
 * Network-level failure reaching the peer broker (DNS, TCP, TLS, abort).
 * Originator outbox treats this as retry-able.
 */
export class PeerUnreachableError extends Error {
  override readonly name = "PeerUnreachableError";
  constructor(
    message: string,
    readonly url: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Peer broker responded but rejected the request (HTTP non-2xx).
 * Originator outbox treats 5xx as retry-able and 4xx as terminal.
 */
export class PeerRejectedError extends Error {
  override readonly name = "PeerRejectedError";
  constructor(
    message: string,
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
    readonly body?: string,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.status >= 500;
  }
}

export interface MeshForwardRequestOptions {
  timeoutMs?: number;
  /** Broker-scoped signed/pinned client; defaults only for legacy callers. */
  peerFetch?: MeshPeerFetch;
  iroh?: IrohBridgeForwardOptions & {
    enabled?: boolean;
    forwarder?: <TResponse>(
      entrypoint: IrohMeshEntrypoint,
      route: IrohBridgeMeshRoute,
      payload: unknown,
      options: IrohBridgeForwardOptions,
    ) => Promise<{ status: number; body: TResponse }>;
  };
}

export const DEFAULT_MESH_FORWARD_TIMEOUT_MS = 5_000;

function resolveMeshForwardTimeoutMs(options?: MeshForwardRequestOptions): number {
  if (typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    return Math.floor(options.timeoutMs);
  }
  return DEFAULT_MESH_FORWARD_TIMEOUT_MS;
}

async function postJson<TResponse>(
  brokerUrl: string,
  path: string,
  payload: unknown,
  options?: MeshForwardRequestOptions,
): Promise<TResponse> {
  const timeoutMs = resolveMeshForwardTimeoutMs(options);
  const url = `${brokerUrl.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await (options?.peerFetch ?? meshPeerFetch)(brokerUrl, path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isMeshPeerTrustError(error)) {
      // A peer presenting an invalid card is a trust failure, not unreachability.
      throw error;
    }
    throw new PeerUnreachableError(
      `peer broker unreachable: ${error instanceof Error ? error.message : String(error)}`,
      url,
      error,
    );
  }

  if (!response.ok) {
    let body: string | undefined;
    try {
      body = await response.text();
    } catch {
      body = undefined;
    }
    throw new PeerRejectedError(
      `peer broker rejected request: ${response.status} ${response.statusText}`,
      url,
      response.status,
      response.statusText,
      body,
    );
  }

  return await response.json() as TResponse;
}

export type MeshForwardTarget = string | NodeDefinition;

function isNodeDefinition(target: MeshForwardTarget): target is NodeDefinition {
  return typeof target === "object" && target !== null && "id" in target;
}

function httpUrlsForTarget(target: MeshForwardTarget): string[] {
  if (typeof target === "string") {
    return orderMeshDialUrls([target]);
  }
  return httpMeshUrlsForNode(target);
}

function irohEntrypointForTarget(target: MeshForwardTarget): IrohMeshEntrypoint | undefined {
  if (!isNodeDefinition(target)) {
    return undefined;
  }
  return target.meshEntrypoints?.find((entrypoint): entrypoint is IrohMeshEntrypoint =>
    entrypoint.kind === "iroh"
    && entrypoint.alpn === OPENSCOUT_IROH_MESH_ALPN
    && entrypoint.bridgeProtocolVersion === OPENSCOUT_MESH_PROTOCOL_VERSION
  );
}

function shouldTryIrohForwarding(
  entrypoint: IrohMeshEntrypoint | undefined,
  options?: MeshForwardRequestOptions,
): entrypoint is IrohMeshEntrypoint {
  if (!entrypoint || options?.iroh?.enabled === false) {
    return false;
  }
  return Boolean(options?.iroh?.forwarder || canUseIrohBridge(options?.iroh));
}

async function forwardMeshEnvelope<TResponse>(
  target: MeshForwardTarget,
  route: IrohBridgeMeshRoute,
  path: string,
  payload: unknown,
  options?: MeshForwardRequestOptions,
): Promise<TResponse> {
  const httpUrls = httpUrlsForTarget(target);
  const irohEntrypoint = irohEntrypointForTarget(target);

  if (shouldTryIrohForwarding(irohEntrypoint, options)) {
    try {
      const forwarder = options?.iroh?.forwarder ?? forwardIrohMeshEnvelope;
      const response = await forwarder<TResponse>(
        irohEntrypoint,
        route,
        payload,
        options?.iroh ?? { timeoutMs: options?.timeoutMs },
      );

      if (response.status >= 200 && response.status < 300) {
        return response.body;
      }

      throw new PeerRejectedError(
        `peer broker rejected Iroh-forwarded request: ${response.status}`,
        `iroh:${irohEntrypoint.endpointId}/${route}`,
        response.status,
        "Iroh Bridge Response",
        JSON.stringify(response.body),
      );
    } catch (error) {
      if (httpUrls.length === 0) {
        throw new PeerUnreachableError(
          `Iroh peer unreachable and no HTTP broker URL is available: ${error instanceof Error ? error.message : String(error)}`,
          `iroh:${irohEntrypoint.endpointId}/${route}`,
          error,
        );
      }
      if (error instanceof PeerRejectedError && !error.retryable) {
        throw error;
      }
      // Fall through to the existing HTTP/Tailscale path. This keeps phase-one
      // rollout non-disruptive while the sidecar matures.
    }
  }

  if (httpUrls.length === 0) {
    throw new PeerUnreachableError(
      `peer broker unreachable: no broker URL or usable Iroh entrypoint for route ${route}`,
      `mesh:${route}`,
    );
  }

  let lastError: unknown;
  for (const url of httpUrls) {
    try {
      return await postJson(url, path, payload, options);
    } catch (error) {
      if (isMeshPeerTrustError(error) || error instanceof PeerRejectedError) {
        throw error;
      }
      lastError = error;
    }
  }

  if (lastError instanceof PeerUnreachableError) {
    throw lastError;
  }
  throw new PeerUnreachableError(
    `peer broker unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    httpUrls[httpUrls.length - 1] ?? `mesh:${route}`,
    lastError,
  );
}

export async function forwardMeshMessage(
  target: MeshForwardTarget,
  bundle: MeshMessageBundle,
  options?: MeshForwardRequestOptions,
): Promise<{ ok: true; message?: MessageRecord; deliveries?: DeliveryIntent[]; duplicate?: boolean }> {
  return forwardMeshEnvelope(target, "messages", "/v1/mesh/messages", bundle, options);
}

export async function forwardMeshInvocation(
  target: MeshForwardTarget,
  bundle: MeshInvocationBundle,
  options?: MeshForwardRequestOptions,
): Promise<{ ok: true; flight: FlightRecord; duplicate?: boolean }> {
  return forwardMeshEnvelope(target, "invocations", "/v1/mesh/invocations", bundle, options);
}

export async function forwardMeshCollaborationRecord(
  target: MeshForwardTarget,
  bundle: MeshCollaborationRecordBundle,
  options?: MeshForwardRequestOptions,
): Promise<{ ok: true; duplicate?: boolean }> {
  return forwardMeshEnvelope(target, "collaboration/records", "/v1/mesh/collaboration/records", bundle, options);
}

export async function forwardMeshCollaborationEvent(
  target: MeshForwardTarget,
  bundle: MeshCollaborationEventBundle,
  options?: MeshForwardRequestOptions,
): Promise<{ ok: true; duplicate?: boolean }> {
  return forwardMeshEnvelope(target, "collaboration/events", "/v1/mesh/collaboration/events", bundle, options);
}

/**
 * A fully read, under-cap, 2xx body with a JSON object `agents` field is
 * authoritative — including `{}`. Missing/malformed `agents`, non-2xx, and
 * parse failures never authorize retraction.
 */
export type PeerAgentRoster = {
  authoritative: boolean;
  agents: AgentDefinition[];
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unusablePeerAgentRoster(): PeerAgentRoster {
  return { authoritative: false, agents: [] };
}

export async function fetchPeerAgents(
  brokerUrl: string,
  peerFetch: MeshPeerFetch = meshPeerFetch,
): Promise<PeerAgentRoster> {
  // Remote-tier snapshot (mesh trust cone §4): /v1/snapshot is local-tier and
  // unreachable to peers in enforce mode, so discovery reads the narrow
  // /v1/mesh/snapshot equivalent. Pre-trust-cone peers lack it — fall back to
  // the legacy local path on 404.
  let response = await peerFetch(brokerUrl, "/v1/mesh/snapshot?scope=agents", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) {
    response = await peerFetch(brokerUrl, "/v1/snapshot?scope=agents", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
  }
  if (!response.ok) return unusablePeerAgentRoster();

  let parsed: unknown;
  try {
    parsed = await readBoundedPeerAgentSnapshot(response, brokerUrl);
  } catch (error) {
    if (error instanceof PeerAgentSnapshotTooLargeError) throw error;
    return unusablePeerAgentRoster();
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed.agents)) {
    return unusablePeerAgentRoster();
  }
  return {
    authoritative: true,
    agents: Object.values(parsed.agents) as AgentDefinition[],
  };
}

async function readBoundedPeerAgentSnapshot(
  response: Response,
  brokerUrl: string,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PEER_AGENT_SNAPSHOT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new PeerAgentSnapshotTooLargeError(brokerUrl, declaredLength);
  }

  if (!response.body) {
    const text = await response.text();
    const size = new TextEncoder().encode(text).byteLength;
    if (size > MAX_PEER_AGENT_SNAPSHOT_BYTES) {
      throw new PeerAgentSnapshotTooLargeError(brokerUrl, size);
    }
    return JSON.parse(text) as unknown;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PEER_AGENT_SNAPSHOT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PeerAgentSnapshotTooLargeError(brokerUrl, size);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}
