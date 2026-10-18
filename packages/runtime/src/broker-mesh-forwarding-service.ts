import {
  OPENSCOUT_IROH_MESH_ALPN,
  OPENSCOUT_MESH_PROTOCOL_VERSION,
  type AgentDefinition,
  type AgentEndpoint,
  type CollaborationEvent,
  type CollaborationRecord,
  type ConversationBinding,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
  type ScoutDispatchUnavailableTarget,
  collaborationRequesterId,
  isWorkItem,
} from "@openscout/protocol";

import {
  DEFAULT_MESH_FORWARD_TIMEOUT_MS,
  buildMeshCollaborationEventBundle,
  buildMeshCollaborationRecordBundle,
  buildMeshMessageBundle,
  forwardMeshCollaborationEvent,
  forwardMeshCollaborationRecord,
  forwardMeshMessage,
  type MeshCollaborationEventBundle,
  type MeshCollaborationRecordBundle,
  type MeshMessageBundle,
} from "./mesh-forwarding.js";
import { meshPeerFetch, type MeshPeerFetch } from "./mesh-peer-client.js";
import { endpointCandidateState } from "./broker-endpoint-selection.js";
import { isReachableRemoteBrokerUrl, isRoutableBrokerUrl } from "./broker-url.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

export { isReachableRemoteBrokerUrl } from "./broker-url.js";

export const STALE_MESH_AUTHORITY_NODE_MS = 24 * 60 * 60 * 1000;

export type MeshAuthorityForwardResult = {
  forwarded: true;
  authorityNodeId: string;
  duplicate?: boolean;
};

export type MeshMessageAuthorityForwardResult = MeshAuthorityForwardResult & {
  /** Absent only on peers predating canonical message acknowledgements. */
  message?: MessageRecord;
  deliveries?: DeliveryIntent[];
};

export type PeerForwardResult = { forwarded: string[]; failed: string[] };

export type BrokerMeshForwardingRuntime = {
  peek(): RuntimeRegistrySnapshot;
  conversation(conversationId: string): ConversationDefinition | undefined;
  node(nodeId: string): NodeDefinition | undefined;
  agent(agentId: string): AgentDefinition | undefined;
  collaborationRecord(recordId: string): CollaborationRecord | undefined;
  bindingsForConversation(conversationId: string): ConversationBinding[];
};

export type BrokerMeshForwardingServiceDeps = {
  nodeId: string;
  runtime: BrokerMeshForwardingRuntime;
  currentLocalNode: () => NodeDefinition;
  invocationFor: (invocationId: string) => InvocationRequest | undefined;
  endpointForAgent: (agentId: string) => AgentEndpoint | null;
  projectRootForTarget: (agent: AgentDefinition, endpoint: AgentEndpoint | null) => string | null;
  forwardMessage?: typeof forwardMeshMessage;
  forwardCollaborationRecord?: typeof forwardMeshCollaborationRecord;
  forwardCollaborationEvent?: typeof forwardMeshCollaborationEvent;
  peerFetch?: MeshPeerFetch;
  postJson?: <TResponse>(brokerBaseUrl: string, path: string, payload: unknown) => Promise<TResponse>;
  now?: () => number;
};

export function hasReachableMeshEntrypoint(node: NodeDefinition | undefined): boolean {
  return Boolean(node?.meshEntrypoints?.some((entrypoint) =>
    entrypoint.kind === "iroh"
    && entrypoint.alpn === OPENSCOUT_IROH_MESH_ALPN
    && entrypoint.bridgeProtocolVersion === OPENSCOUT_MESH_PROTOCOL_VERSION
  ));
}

export function isReachableMeshNode(node: NodeDefinition | undefined): node is NodeDefinition {
  return Boolean(isRoutableBrokerUrl(node?.brokerUrl) || hasReachableMeshEntrypoint(node));
}

export function meshNodeLastSeenAt(node: NodeDefinition | undefined): number {
  return typeof node?.lastSeenAt === "number" && Number.isFinite(node.lastSeenAt)
    ? node.lastSeenAt
    : typeof node?.registeredAt === "number" && Number.isFinite(node.registeredAt)
    ? node.registeredAt
    : 0;
}

export function isStaleMeshAuthorityNode(
  node: NodeDefinition | undefined,
  options: { now?: number } = {},
): boolean {
  if (!node) {
    return false;
  }
  const lastSeenAt = meshNodeLastSeenAt(node);
  const now = options.now ?? Date.now();
  return lastSeenAt > 0 && now - lastSeenAt > STALE_MESH_AUTHORITY_NODE_MS;
}

export function formatMeshNodeLastSeen(node: NodeDefinition | undefined): string {
  const lastSeenAt = meshNodeLastSeenAt(node);
  if (!lastSeenAt) {
    return "with no recent heartbeat";
  }
  return `last seen ${new Date(lastSeenAt).toISOString()}`;
}

export function actorIdsForCollaboration(
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

  return [...ids];
}

export async function postMeshPeerJson<TResponse>(
  brokerBaseUrl: string,
  path: string,
  payload: unknown,
  peerFetch: MeshPeerFetch = meshPeerFetch,
): Promise<TResponse> {
  const response = await peerFetch(brokerBaseUrl, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DEFAULT_MESH_FORWARD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }

  return await response.json() as TResponse;
}

export class BrokerMeshForwardingService {
  private readonly forwardMessage: typeof forwardMeshMessage;
  private readonly forwardCollaborationRecord: typeof forwardMeshCollaborationRecord;
  private readonly forwardCollaborationEvent: typeof forwardMeshCollaborationEvent;
  private readonly postJson: <TResponse>(brokerBaseUrl: string, path: string, payload: unknown) => Promise<TResponse>;

  constructor(private readonly deps: BrokerMeshForwardingServiceDeps) {
    this.forwardMessage = deps.forwardMessage
      ?? ((target, bundle, options) => forwardMeshMessage(target, bundle, {
        ...options,
        peerFetch: deps.peerFetch,
      }));
    this.forwardCollaborationRecord = deps.forwardCollaborationRecord
      ?? ((target, bundle, options) => forwardMeshCollaborationRecord(target, bundle, {
        ...options,
        peerFetch: deps.peerFetch,
      }));
    this.forwardCollaborationEvent = deps.forwardCollaborationEvent
      ?? ((target, bundle, options) => forwardMeshCollaborationEvent(target, bundle, {
        ...options,
        peerFetch: deps.peerFetch,
      }));
    this.postJson = deps.postJson
      ?? ((brokerBaseUrl, path, payload) =>
        postMeshPeerJson(brokerBaseUrl, path, payload, deps.peerFetch));
  }

  describeRemoteAuthorityIssue(
    agent: AgentDefinition,
    authorityNode: NodeDefinition | undefined,
  ): ScoutDispatchUnavailableTarget | null {
    const displayName = agent.displayName ?? agent.id;
    const authorityNodeId = agent.authorityNodeId;
    if (!authorityNodeId || authorityNodeId === this.deps.nodeId) {
      return null;
    }

    const nodeLabel = authorityNode?.name
      ? `${authorityNode.name} (${authorityNodeId})`
      : authorityNodeId;

    const unavailable = !authorityNode || !isReachableMeshNode(authorityNode);
    const stale = isStaleMeshAuthorityNode(authorityNode, { now: this.deps.now?.() });
    if (!unavailable && !stale) {
      return null;
    }

    const endpoint = this.deps.endpointForAgent(agent.id);
    const projectRoot = this.deps.projectRootForTarget(agent, endpoint);
    const detail = unavailable
      ? `${displayName} belongs to peer node ${nodeLabel}, but that peer has no reachable broker URL or mesh entrypoint.`
      : `${displayName} belongs to peer node ${nodeLabel}, but that peer has not been seen recently (${formatMeshNodeLastSeen(authorityNode)}).`;

    return {
      agentId: agent.id,
      displayName,
      reason: "unknown",
      detail,
      wakePolicy: agent.wakePolicy,
      endpointState: endpointCandidateState(endpoint?.state),
      transport: endpoint?.transport ?? null,
      projectRoot,
    };
  }

  authorityNodeForConversation(conversationId: string): {
    conversation: ConversationDefinition;
    authorityNode: NodeDefinition;
  } | null {
    const conversation = this.deps.runtime.conversation(conversationId);
    if (!conversation || conversation.authorityNodeId === this.deps.nodeId) {
      return null;
    }

    const authorityNode = this.deps.runtime.node(conversation.authorityNodeId);
    if (!isReachableMeshNode(authorityNode)) {
      throw new Error(`authority node ${conversation.authorityNodeId} is not reachable`);
    }

    return { conversation, authorityNode };
  }

  async forwardConversationMessageToAuthority(
    message: MessageRecord,
  ): Promise<MeshMessageAuthorityForwardResult> {
    const authority = this.authorityNodeForConversation(message.conversationId);
    if (!authority) {
      throw new Error(`conversation ${message.conversationId} is locally owned`);
    }

    const bundle = buildMeshMessageBundle(this.deps.runtime.peek(), this.deps.currentLocalNode(), message, {
      bindings: this.deps.runtime.bindingsForConversation(authority.conversation.id),
    });
    const result = await this.forwardMessage(authority.authorityNode, bundle);
    return {
      forwarded: true,
      authorityNodeId: authority.conversation.authorityNodeId,
      duplicate: result.duplicate,
      message: result.message,
      deliveries: result.deliveries,
    };
  }

  async forwardCollaborationRecordToAuthority(
    record: CollaborationRecord,
  ): Promise<MeshAuthorityForwardResult> {
    if (!record.conversationId) {
      throw new Error(`collaboration record ${record.id} is not thread-scoped`);
    }

    const authority = this.authorityNodeForConversation(record.conversationId);
    if (!authority) {
      throw new Error(`conversation ${record.conversationId} is locally owned`);
    }

    const bundle = buildMeshCollaborationRecordBundle(
      this.deps.runtime.peek(),
      this.deps.currentLocalNode(),
      record,
    );
    const result = await this.forwardCollaborationRecord(authority.authorityNode, bundle);
    return {
      forwarded: true,
      authorityNodeId: authority.conversation.authorityNodeId,
      duplicate: result.duplicate,
    };
  }

  async forwardCollaborationEventToAuthority(
    event: CollaborationEvent,
  ): Promise<MeshAuthorityForwardResult> {
    const record = this.deps.runtime.collaborationRecord(event.recordId);
    if (!record?.conversationId) {
      throw new Error(`collaboration event ${event.id} is not thread-scoped`);
    }

    const authority = this.authorityNodeForConversation(record.conversationId);
    if (!authority) {
      throw new Error(`conversation ${record.conversationId} is locally owned`);
    }

    const bundle = buildMeshCollaborationEventBundle(
      this.deps.runtime.peek(),
      this.deps.currentLocalNode(),
      event,
      record,
    );
    const result = await this.forwardCollaborationEvent(authority.authorityNode, bundle);
    return {
      forwarded: true,
      authorityNodeId: authority.conversation.authorityNodeId,
      duplicate: result.duplicate,
    };
  }

  async maybeForwardFlightToAuthority(flight: FlightRecord): Promise<void> {
    const invocation = this.deps.invocationFor(flight.invocationId);
    if (!invocation?.conversationId) {
      return;
    }

    const conversation = this.deps.runtime.conversation(invocation.conversationId);
    if (!conversation || conversation.authorityNodeId === this.deps.nodeId) {
      return;
    }

    const brokerUrl = this.deps.runtime.node(conversation.authorityNodeId)?.brokerUrl;
    if (!isReachableRemoteBrokerUrl(brokerUrl)) {
      return;
    }

    await this.postJson<{ ok: boolean }>(brokerUrl, "/v1/mesh/flights", flight);
  }

  async forwardPeerBrokerDeliveries(
    message: MessageRecord,
    deliveries: DeliveryIntent[],
  ): Promise<PeerForwardResult> {
    void message;
    void deliveries;
    // Canonical thread history stays on the authority broker. Remote nodes learn
    // about updates through watches/replay instead of mirrored message writes.
    return { forwarded: [], failed: [] };
  }

  async forwardPeerBrokerCollaborationRecord(
    record: CollaborationRecord,
  ): Promise<PeerForwardResult> {
    const conversation = record.conversationId
      ? this.deps.runtime.conversation(record.conversationId)
      : undefined;
    if (!conversation || conversation.shareMode === "local") {
      return { forwarded: [], failed: [] };
    }

    const registry = this.deps.runtime.peek();
    const actorIds = actorIdsForCollaboration(record, conversation);
    const targetNodeIds = this.targetNodeIdsForActors(actorIds);
    if (targetNodeIds.length === 0) {
      return { forwarded: [], failed: [] };
    }

    const originNode = this.deps.currentLocalNode();
    const bundle = buildMeshCollaborationRecordBundle(registry, originNode, record);
    return await this.forwardPeerCollaborationBundle(targetNodeIds, bundle, "record");
  }

  async forwardPeerBrokerCollaborationEvent(
    event: CollaborationEvent,
  ): Promise<PeerForwardResult> {
    const record = this.deps.runtime.collaborationRecord(event.recordId);
    if (!record) {
      return { forwarded: [], failed: [] };
    }
    const conversation = record.conversationId
      ? this.deps.runtime.conversation(record.conversationId)
      : undefined;
    if (!conversation || conversation.shareMode === "local") {
      return { forwarded: [], failed: [] };
    }

    const registry = this.deps.runtime.peek();
    const actorIds = actorIdsForCollaboration(record, conversation);
    const targetNodeIds = this.targetNodeIdsForActors(actorIds);
    if (targetNodeIds.length === 0) {
      return { forwarded: [], failed: [] };
    }

    const originNode = this.deps.currentLocalNode();
    const bundle = buildMeshCollaborationEventBundle(registry, originNode, event, record);
    return await this.forwardPeerCollaborationBundle(targetNodeIds, bundle, "event");
  }

  private targetNodeIdsForActors(actorIds: string[]): string[] {
    return [...new Set(
      actorIds
        .map((actorId) => this.deps.runtime.agent(actorId)?.authorityNodeId)
        .filter((id): id is string => Boolean(id && id !== this.deps.nodeId)),
    )];
  }

  private async forwardPeerCollaborationBundle(
    targetNodeIds: string[],
    bundle: MeshCollaborationRecordBundle | MeshCollaborationEventBundle,
    kind: "record" | "event",
  ): Promise<PeerForwardResult> {
    const forwarded: string[] = [];
    const failed: string[] = [];

    for (const targetNodeId of targetNodeIds) {
      const targetNode = this.deps.runtime.node(targetNodeId);
      if (!isReachableMeshNode(targetNode)) {
        failed.push(targetNodeId);
        continue;
      }

      try {
        if (kind === "record") {
          await this.forwardCollaborationRecord(targetNode, bundle as MeshCollaborationRecordBundle);
        } else {
          await this.forwardCollaborationEvent(targetNode, bundle as MeshCollaborationEventBundle);
        }
        forwarded.push(targetNodeId);
      } catch {
        failed.push(targetNodeId);
      }
    }

    return { forwarded, failed };
  }
}
