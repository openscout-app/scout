import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  CollaborationRecord,
  ConversationBinding,
  ConversationDefinition,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  ConversationReadCursor,
} from "@openscout/protocol";
import type { NodeDefinition } from "@openscout/protocol";
import { filterMessageRecords, filterMessageRecordsAsync } from "./broker-message-records.js";

/**
 * ActorIdentity plus the actor's first-registration timestamp. Stamped at the
 * durable upsert funnel so journal replay preserves it; `actors.created_at`
 * in SQLite carries it across restarts. Retention uses it as the last resort
 * for records with no other age evidence.
 */
export type RuntimeActorIdentity = ActorIdentity & { createdAt?: number };

/** AgentDefinition carrying the same first-registration stamp as its actor. */
export type RuntimeAgentDefinition = AgentDefinition & { createdAt?: number };

export interface RuntimeRegistrySnapshot {
  nodes: Record<string, NodeDefinition>;
  actors: Record<string, RuntimeActorIdentity>;
  agents: Record<string, AgentDefinition>;
  endpoints: Record<string, AgentEndpoint>;
  conversations: Record<string, ConversationDefinition>;
  bindings: Record<string, ConversationBinding>;
  messages: Record<string, MessageRecord>;
  readCursors: Record<string, ConversationReadCursor>;
  invocations: Record<string, InvocationRequest>;
  flights: Record<string, FlightRecord>;
  collaborationRecords: Record<string, CollaborationRecord>;
}

// Cache tokens are process-local and never enter snapshots on the wire or disk.
// The broker replaces its token at every routing identity/endpoint mutation.
const routingVersions = new WeakMap<RuntimeRegistrySnapshot, object>();

export function routingRegistryVersion(snapshot: RuntimeRegistrySnapshot): object | undefined {
  return routingVersions.get(snapshot);
}

export function markRoutingRegistryVersion(snapshot: RuntimeRegistrySnapshot, version: object = {}): void {
  routingVersions.set(snapshot, version);
}

/** A synchronous resolver may index an unversioned caller's view for one call. */
export function routingRegistryView(snapshot: RuntimeRegistrySnapshot): RuntimeRegistrySnapshot {
  if (routingVersions.has(snapshot)) return snapshot;
  const view = { ...snapshot };
  markRoutingRegistryVersion(view);
  return view;
}

export interface RuntimeRegistrySnapshotQuery {
  since?: number | null;
  /**
   * Keep only records needed to render conversation lists and transcripts.
   * This avoids serializing thousands of unrelated historical agent
   * registrations on the latency-sensitive app startup path.
   * `identity` keeps just the routing identity records — nodes, actors, and
   * agents — for callers that resolve senders and targets without reading
   * any conversation history.
   */
  scope?: "conversations" | "agents" | "identity";
}

export function createRuntimeRegistrySnapshot(
  value: Omit<Partial<RuntimeRegistrySnapshot>, "invocations"> & {
    invocations?: Record<string, Omit<InvocationRequest, "origin"> & { origin?: InvocationRequest["origin"] }>;
  } = {},
): RuntimeRegistrySnapshot {
  return {
    nodes: value.nodes ?? {},
    actors: value.actors ?? {},
    agents: value.agents ?? {},
    endpoints: value.endpoints ?? {},
    conversations: value.conversations ?? {},
    bindings: value.bindings ?? {},
    messages: value.messages ?? {},
    readCursors: value.readCursors ?? {},
    invocations: Object.fromEntries(Object.entries(value.invocations ?? {}).map(([id, invocation]) =>
      [id, invocation.origin ? invocation as InvocationRequest : { ...invocation, origin: { source: "unknown" as const } }])),
    flights: value.flights ?? {},
    collaborationRecords: value.collaborationRecords ?? {},
  };
}

const ACTIVE_FLIGHT_STATES = new Set(["queued", "waking", "running", "waiting"]);

/** Routing metadata for live notifications; never includes historical payloads. */
export type RuntimeNotificationRoutingSnapshot = {
  conversations: Record<string, Pick<ConversationDefinition, "id" | "participantIds" | "title">>;
  invocations: Record<string, Pick<InvocationRequest, "id" | "requesterId" | "conversationId"> & { metadata?: { replyMode?: string } }>;
};

export function queryRuntimeNotificationRouting(
  snapshot: Pick<RuntimeRegistrySnapshot, "conversations" | "invocations" | "flights">,
): RuntimeNotificationRoutingSnapshot {
  const activeInvocationIds = new Set(Object.values(snapshot.flights)
    .filter(flight => ACTIVE_FLIGHT_STATES.has(flight.state)).map(flight => flight.invocationId));
  return {
    conversations: Object.fromEntries(Object.values(snapshot.conversations).map(({ id, participantIds, title }) =>
      [id, { id, participantIds: [...participantIds], title }])),
    invocations: Object.fromEntries(Object.values(snapshot.invocations)
      .filter(invocation => activeInvocationIds.has(invocation.id))
      .map(({ id, requesterId, conversationId, metadata }) => [id, {
        id, requesterId, ...(conversationId !== undefined && { conversationId }),
        ...(typeof metadata?.replyMode === "string" && { metadata: { replyMode: metadata.replyMode } }),
      }])),
  };
}
const TERMINAL_COLLABORATION_STATES = new Set(["done", "cancelled", "closed", "declined"]);
const SNAPSHOT_TIMESTAMP_KEYS = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "lastSeenAt",
  "registeredAt",
  "staleAt",
  "retiredAt",
  "lastStartedAt",
  "lastCompletedAt",
  "lastFailedAt",
] as const;

function finiteTimestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function recordTimestamp(value: { metadata?: Record<string, unknown> }): number {
  const record = value as object as Record<string, unknown>;
  let latest = 0;
  for (const key of SNAPSHOT_TIMESTAMP_KEYS) {
    latest = Math.max(
      latest,
      finiteTimestamp(record[key]) ?? 0,
      finiteTimestamp(value.metadata?.[key]) ?? 0,
    );
  }
  return latest;
}

function recordById<T extends { id: string }>(values: Iterable<T>): Record<string, T> {
  return Object.fromEntries([...values].map((value) => [value.id, value]));
}

function currentAgent(agent: AgentDefinition): boolean {
  return agent.metadata?.staleLocalRegistration !== true
    && agent.metadata?.retiredFromFleet !== true;
}

function currentOrRecentEndpoint(endpoint: AgentEndpoint, since: number): boolean {
  return endpoint.metadata?.staleLocalRegistration !== true
    && (endpoint.state !== "offline" || recordTimestamp(endpoint) >= since);
}

function activeCollaboration(record: CollaborationRecord): boolean {
  return !TERMINAL_COLLABORATION_STATES.has(record.state);
}

/**
 * Return a coherent working-set view of the registry from a cutoff timestamp.
 * Current routable agents/endpoints are retained regardless of age; historical
 * coordination records are bounded and their referenced actors/conversations
 * are pulled in to keep the result usable without loading lifetime history.
 */
export function queryRuntimeRegistrySnapshot(
  snapshot: RuntimeRegistrySnapshot,
  query: RuntimeRegistrySnapshotQuery = {},
): RuntimeRegistrySnapshot {
  if (query.scope === "agents") {
    return createRuntimeRegistrySnapshot({
      agents: { ...snapshot.agents },
    });
  }
  if (query.scope === "identity") {
    return createRuntimeRegistrySnapshot({
      nodes: { ...snapshot.nodes },
      actors: { ...snapshot.actors },
      agents: { ...snapshot.agents },
    });
  }

  const since = finiteTimestamp(query.since);
  const conversationScoped = query.scope === "conversations";
  if (since === null && !conversationScoped) {
    return snapshot;
  }
  const cutoff = since ?? 0;

  const messageConversationIds = new Set<string>();
  const messageActorIds = new Set<string>();
  const messages = filterMessageRecords(snapshot.messages, (message) => {
    if (!(message.createdAt >= cutoff)) return false;
    messageConversationIds.add(message.conversationId);
    messageActorIds.add(message.actorId);
    return true;
  });
  return finishRegistryQuery(snapshot,query,cutoff,conversationScoped,messages,messageConversationIds,messageActorIds);
}

function finishRegistryQuery(snapshot:RuntimeRegistrySnapshot,query:RuntimeRegistrySnapshotQuery,cutoff:number,conversationScoped:boolean,messages:Record<string,MessageRecord>,messageConversationIds:Set<string>,messageActorIds:Set<string>):RuntimeRegistrySnapshot {
  const recentInvocationIds = new Set(
    Object.values(snapshot.invocations)
      .filter((invocation) => invocation.createdAt >= cutoff)
      .map((invocation) => invocation.id),
  );
  const flights = Object.values(snapshot.flights)
    .filter((flight) =>
      ACTIVE_FLIGHT_STATES.has(flight.state)
      || recordTimestamp(flight) >= cutoff
      || recentInvocationIds.has(flight.invocationId)
    );
  const retainedInvocationIds = new Set([
    ...recentInvocationIds,
    ...flights.map((flight) => flight.invocationId),
  ]);
  const invocations = Object.values(snapshot.invocations)
    .filter((invocation) => retainedInvocationIds.has(invocation.id));
  const collaborationRecords = Object.values(snapshot.collaborationRecords)
    .filter((record) => activeCollaboration(record) || record.updatedAt >= cutoff);

  const conversationIds = new Set<string>(messageConversationIds);
  for (const invocation of invocations) {
    if (invocation.conversationId) conversationIds.add(invocation.conversationId);
  }
  for (const record of collaborationRecords) {
    if (record.conversationId) conversationIds.add(record.conversationId);
  }
  for (const conversation of Object.values(snapshot.conversations)) {
    // Records written before timestamps were stamped carry no timestamp at
    // all; treating them as "unknown age" keeps them visible instead of
    // silently dropping them from every incremental snapshot.
    const timestamp = recordTimestamp(conversation);
    if (timestamp === 0 || timestamp >= cutoff) conversationIds.add(conversation.id);
  }

  const conversations: ConversationDefinition[] = [];
  const pendingConversationIds = [...conversationIds];
  while (pendingConversationIds.length > 0) {
    const conversationId = pendingConversationIds.pop()!;
    const conversation = snapshot.conversations[conversationId];
    if (!conversation || conversations.some((candidate) => candidate.id === conversationId)) continue;
    conversations.push(conversation);
    if (conversation.parentConversationId && !conversationIds.has(conversation.parentConversationId)) {
      conversationIds.add(conversation.parentConversationId);
      pendingConversationIds.push(conversation.parentConversationId);
    }
  }

  let scopedInvocations = invocations;
  let scopedFlights = flights;
  if (conversationScoped) {
    const activeFlightInvocationIds = new Set(
      flights
        .filter((flight) => ACTIVE_FLIGHT_STATES.has(flight.state))
        .map((flight) => flight.invocationId),
    );
    const newestByConversation = new Map<string, InvocationRequest[]>();
    for (const invocation of invocations) {
      const conversationId = invocation.conversationId;
      if (!conversationId || !conversationIds.has(conversationId)) continue;
      const bucket = newestByConversation.get(conversationId) ?? [];
      bucket.push(invocation);
      newestByConversation.set(conversationId, bucket);
    }
    scopedInvocations = [...newestByConversation.values()].flatMap((bucket) => {
      const sorted = bucket.sort((left, right) => right.createdAt - left.createdAt);
      const selected = sorted.slice(0, 12);
      const selectedIds = new Set(selected.map((invocation) => invocation.id));
      for (const invocation of sorted) {
        if (activeFlightInvocationIds.has(invocation.id) && !selectedIds.has(invocation.id)) {
          selected.push(invocation);
          selectedIds.add(invocation.id);
        }
      }
      return selected;
    });
    const scopedInvocationIds = new Set(scopedInvocations.map((invocation) => invocation.id));
    scopedFlights = flights.filter((flight) => scopedInvocationIds.has(flight.invocationId));
  }

  const actorIds = new Set<string>();
  const agentIds = new Set<string>();
  const currentEndpointAgentIds = new Set(
    Object.values(snapshot.endpoints)
      .filter((endpoint) => currentOrRecentEndpoint(endpoint, cutoff))
      .map((endpoint) => endpoint.agentId),
  );
  for (const conversation of conversations) {
    const keepWholeRoster = !conversationScoped
      || conversation.kind === "direct"
      || conversation.kind === "group_direct";
    for (const [index, participantId] of conversation.participantIds.entries()) {
      if (
        keepWholeRoster
        || index < 32
        || snapshot.actors[participantId]?.kind === "person"
        || currentEndpointAgentIds.has(participantId)
      ) {
        actorIds.add(participantId);
      }
    }
  }
  for (const actorId of messageActorIds) actorIds.add(actorId);
  for (const invocation of scopedInvocations) {
    actorIds.add(invocation.requesterId);
    agentIds.add(invocation.targetAgentId);
  }
  for (const flight of scopedFlights) {
    actorIds.add(flight.requesterId);
    agentIds.add(flight.targetAgentId);
  }
  for (const record of collaborationRecords) {
    actorIds.add(record.createdById);
    if (record.ownerId) actorIds.add(record.ownerId);
    if (record.nextMoveOwnerId) actorIds.add(record.nextMoveOwnerId);
  }

  if (!conversationScoped) {
    for (const agent of Object.values(snapshot.agents)) {
      if (currentAgent(agent)) agentIds.add(agent.id);
    }
  }
  for (const actorId of actorIds) {
    if (snapshot.agents[actorId]) agentIds.add(actorId);
  }

  const endpoints = Object.values(snapshot.endpoints)
    .filter((endpoint) =>
      currentOrRecentEndpoint(endpoint, cutoff)
      && (!conversationScoped || agentIds.has(endpoint.agentId) || actorIds.has(endpoint.agentId))
    );
  for (const endpoint of endpoints) agentIds.add(endpoint.agentId);
  for (const agentId of agentIds) actorIds.add(agentId);

  const agents = Object.values(snapshot.agents)
    .filter((agent) => agentIds.has(agent.id) || actorIds.has(agent.id));
  for (const agent of agents) {
    agentIds.add(agent.id);
    actorIds.add(agent.id);
    if (agent.ownerId) actorIds.add(agent.ownerId);
  }

  return createRuntimeRegistrySnapshot({
    nodes: snapshot.nodes,
    actors: recordById(Object.values(snapshot.actors).filter((actor) => actorIds.has(actor.id))),
    agents: recordById(agents),
    endpoints: recordById(endpoints.filter((endpoint) => agentIds.has(endpoint.agentId))),
    conversations: recordById(conversations),
    bindings: recordById(
      Object.values(snapshot.bindings).filter((binding) => conversationIds.has(binding.conversationId)),
    ),
    messages,
    readCursors: Object.fromEntries(
      Object.entries(snapshot.readCursors)
        .filter(([, cursor]) => conversationIds.has(cursor.conversationId)),
    ),
    invocations: recordById(scopedInvocations),
    flights: recordById(scopedFlights),
    collaborationRecords: recordById(collaborationRecords),
  });
}

export async function queryRuntimeRegistrySnapshotAsync(snapshot:RuntimeRegistrySnapshot,query:RuntimeRegistrySnapshotQuery={},options?:{signal?:AbortSignal}):Promise<RuntimeRegistrySnapshot>{
 if(query.scope==='agents')return createRuntimeRegistrySnapshot({agents:{...snapshot.agents}});
 if(query.scope==='identity')return createRuntimeRegistrySnapshot({nodes:{...snapshot.nodes},actors:{...snapshot.actors},agents:{...snapshot.agents}});
 const since=finiteTimestamp(query.since),conversationScoped=query.scope==='conversations';if(since===null&&!conversationScoped)return snapshot;
 const cutoff=since??0,messageConversationIds=new Set<string>(),messageActorIds=new Set<string>();
 const messages=await filterMessageRecordsAsync(snapshot.messages,message=>{if(!(message.createdAt>=cutoff))return false;messageConversationIds.add(message.conversationId);messageActorIds.add(message.actorId);return true;},options);
 return finishRegistryQuery(snapshot,query,cutoff,conversationScoped,messages,messageConversationIds,messageActorIds);
}
