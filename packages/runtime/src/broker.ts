import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  CollaborationEvent,
  CollaborationRecord,
  ControlCommand,
  ControlEvent,
  ConversationBinding,
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryIntent,
  DeliveryTargetKind,
  DeliveryTransport,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
  ScoutId,
} from "@openscout/protocol";
import {
  assertValidCollaborationEvent,
  assertValidCollaborationRecord,
} from "@openscout/protocol";

import { registrySubstanceChanged } from "./registry-liveness.js";
import { planMessageDeliveries, type DeliveryRoute } from "./planner.js";
import { captureMessageRecords, asyncMessageRecordView, readMessageRecord } from "./broker-message-records.js";
import { applyHistoryRotationEviction } from "./history-rotation.js";
import {
  createRuntimeRegistrySnapshot,
  markRoutingRegistryVersion,
  type RuntimeActorIdentity,
  type RuntimeAgentDefinition,
  type RuntimeRegistrySnapshot,
} from "./registry.js";
import type { ControlRuntime } from "./service.js";

function createRuntimeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toTargetKind(actor?: ActorIdentity): DeliveryTargetKind {
  if (!actor) return "participant";
  if (actor.kind === "agent") return "agent";
  if (actor.kind === "device") return "device";
  if (actor.kind === "bridge") return "bridge";
  return "participant";
}

function defaultTransportForActor(actor?: ActorIdentity): DeliveryTransport {
  if (!actor) return "local_socket";

  switch (actor.kind) {
    case "bridge":
      return "webhook";
    case "device":
      return "local_socket";
    case "agent":
      return "local_socket";
    default:
      return "local_socket";
  }
}

function endpointTransportRank(transport: AgentEndpoint["transport"]): number {
  switch (transport) {
    case "claude_channel":
      return 0;
    case "codex_app_server":
      return 1;
    case "claude_stream_json":
      return 2;
    case "tmux":
      return 3;
    case "local_socket":
      return 4;
    default:
      return 5;
  }
}

function shouldBridgeMessageToBinding(
  binding: ConversationBinding,
  message: MessageRecord,
): boolean {
  if (binding.platform !== "telegram") {
    return true;
  }

  const source = typeof message.metadata?.source === "string"
    ? String(message.metadata.source)
    : "";
  if (source === "telegram") {
    return false;
  }

  const outboundMode = typeof binding.metadata?.outboundMode === "string"
    ? String(binding.metadata.outboundMode)
    : "operator_only";
  const operatorId = typeof binding.metadata?.operatorId === "string"
    ? String(binding.metadata.operatorId)
    : "operator";
  const allowedActorIds = Array.isArray(binding.metadata?.allowedActorIds)
    ? binding.metadata.allowedActorIds.map((entry) => String(entry).trim()).filter(Boolean)
    : [];

  if (outboundMode === "all") {
    return true;
  }

  if (outboundMode === "allowlist") {
    return allowedActorIds.includes(message.actorId);
  }

  return message.actorId === operatorId;
}

function resolveBindingRoutes(
  bindings: ConversationBinding[],
  message: MessageRecord,
): DeliveryRoute[] {
  return bindings
    .filter((binding) => shouldBridgeMessageToBinding(binding, message))
    .map((binding) => ({
    targetId: binding.id,
    targetKind: "bridge",
    transport: binding.platform === "telegram"
      ? "telegram"
      : binding.platform === "discord"
        ? "discord"
        : "webhook",
    bindingId: binding.id,
    }));
}

function preferredEndpoint(endpoints: readonly AgentEndpoint[]): AgentEndpoint | undefined {
  let preferred: AgentEndpoint | undefined;
  let preferredRank = Number.POSITIVE_INFINITY;

  for (const endpoint of endpoints) {
    const rank = endpointTransportRank(endpoint.transport);
    if (!preferred || rank < preferredRank) {
      preferred = endpoint;
      preferredRank = rank;
    }
  }

  return preferred;
}

export class InMemoryControlRuntime implements ControlRuntime {
  private readonly registry: RuntimeRegistrySnapshot;

  private readonly listeners = new Set<(event: ControlEvent) => void>();

  private readonly eventBuffer: ControlEvent[] = [];

  private readonly localNodeId?: ScoutId;

  private readonly endpointIdsByAgentId = new Map<ScoutId, Set<ScoutId>>();

  private readonly bindingIdsByConversationId = new Map<ScoutId, Set<ScoutId>>();

  private readonly flightIdByInvocationId = new Map<ScoutId, ScoutId>();

  /**
   * Actor ids removed by an `actor.delete` tombstone. Presence in `actors`
   * alone cannot distinguish "deleted" from "never registered" — stale
   * whole-record conversation upserts would otherwise resurrect a deleted
   * actor's roster membership. Seeded at hydration from the journal's
   * retained tombstones; maintained live by deleteActor/upsertActor.
   */
  private readonly retiredActorIds = new Set<ScoutId>();

  constructor(
    initial: Partial<RuntimeRegistrySnapshot> = {},
    options: { localNodeId?: ScoutId; retiredActorIds?: Iterable<ScoutId> } = {},
  ) {
    this.registry = createRuntimeRegistrySnapshot(initial);
    markRoutingRegistryVersion(this.registry);
    this.localNodeId = options.localNodeId;
    for (const actorId of options.retiredActorIds ?? []) {
      this.retiredActorIds.add(actorId);
    }
    this.rebuildIndexes();
  }

  /** Whether an `actor.delete` tombstone retired this id — until a fresh
   * actor (or agent) registration revives it. */
  isRetiredActor(actorId: ScoutId): boolean {
    return this.retiredActorIds.has(actorId);
  }

  snapshot(): RuntimeRegistrySnapshot {
    return createRuntimeRegistrySnapshot({
      nodes: { ...this.registry.nodes },
      actors: { ...this.registry.actors },
      agents: { ...this.registry.agents },
      endpoints: { ...this.registry.endpoints },
      conversations: { ...this.registry.conversations },
      bindings: { ...this.registry.bindings },
      messages: captureMessageRecords(this.registry.messages),
      readCursors: { ...this.registry.readCursors },
      invocations: { ...this.registry.invocations },
      flights: { ...this.registry.flights },
      collaborationRecords: { ...this.registry.collaborationRecords },
    });
  }

  /** Read-only synchronous routing view; versions invalidate derived indexes. */
  routingSnapshot(): RuntimeRegistrySnapshot {
    return this.registry;
  }

  // Internal fast-path access for broker internals. Callers must treat this as read-only.
  peek(): Readonly<RuntimeRegistrySnapshot> {
    return this.registry;
  }

  node(nodeId: ScoutId): NodeDefinition | undefined {
    return this.registry.nodes[nodeId];
  }

  agent(agentId: ScoutId): AgentDefinition | undefined {
    return this.registry.agents[agentId];
  }

  actor(actorId: ScoutId): ActorIdentity | undefined {
    return this.registry.actors[actorId];
  }

  conversation(conversationId: ScoutId): ConversationDefinition | undefined {
    return this.registry.conversations[conversationId];
  }

  message(messageId: ScoutId): MessageRecord | undefined {
    return this.registry.messages[messageId];
  }

  async readMessage(messageId: ScoutId, options?: {signal?:AbortSignal}): Promise<MessageRecord | undefined> { return readMessageRecord(this.registry.messages,messageId,options); }

  readCursor(conversationId: ScoutId, actorId: ScoutId) {
    return this.registry.readCursors[`${conversationId}\u0000${actorId}`];
  }

  collaborationRecord(recordId: ScoutId): CollaborationRecord | undefined {
    return this.registry.collaborationRecords[recordId];
  }

  flight(flightId: ScoutId): FlightRecord | undefined {
    return this.registry.flights[flightId];
  }

  flightForInvocation(invocationId: ScoutId): FlightRecord | undefined {
    const flightId = this.flightIdByInvocationId.get(invocationId);
    return flightId ? this.registry.flights[flightId] : undefined;
  }

  bindingsForConversation(conversationId: ScoutId): ConversationBinding[] {
    const bindingIds = this.bindingIdsByConversationId.get(conversationId);
    if (!bindingIds) {
      return [];
    }

    const bindings: ConversationBinding[] = [];
    for (const bindingId of bindingIds) {
      const binding = this.registry.bindings[bindingId];
      if (binding) {
        bindings.push(binding);
      }
    }

    return bindings;
  }

  endpointsForAgent(
    agentId: ScoutId,
    options: {
      includeOffline?: boolean;
      nodeId?: ScoutId;
      harness?: AgentEndpoint["harness"];
    } = {},
  ): AgentEndpoint[] {
    const endpointIds = this.endpointIdsByAgentId.get(agentId);
    if (!endpointIds) {
      return [];
    }

    const endpoints: AgentEndpoint[] = [];
    for (const endpointId of endpointIds) {
      const endpoint = this.registry.endpoints[endpointId];
      if (!endpoint) continue;
      if (!options.includeOffline && endpoint.state === "offline") continue;
      if (options.nodeId && endpoint.nodeId !== options.nodeId) continue;
      if (options.harness && endpoint.harness !== options.harness) continue;
      endpoints.push(endpoint);
    }

    return endpoints;
  }

  recentEvents(limit = 100): ControlEvent[] {
    return this.eventBuffer.slice(-limit);
  }

  subscribe(listener: (event: ControlEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispatch(command: ControlCommand): Promise<void> {
    switch (command.kind) {
      case "node.upsert":
        await this.upsertNode(command.node);
        return;
      case "actor.upsert":
        await this.upsertActor(command.actor);
        return;
      case "agent.upsert":
        await this.upsertAgent(command.agent);
        return;
      case "agent.endpoint.upsert":
        await this.upsertEndpoint(command.endpoint);
        return;
      case "conversation.upsert":
        await this.upsertConversation(command.conversation);
        return;
      case "binding.upsert":
        await this.upsertBinding(command.binding);
        return;
      case "collaboration.upsert":
        await this.upsertCollaboration(command.record);
        return;
      case "collaboration.event.append":
        await this.appendCollaborationEvent(command.event);
        return;
      case "conversation.post":
        await this.postMessage(command.message);
        return;
      case "agent.invoke":
        await this.invokeAgent(command.invocation);
        return;
      case "agent.ensure_awake":
        this.emit({
          id: createRuntimeId("evt"),
          kind: "flight.updated",
          ts: Date.now(),
          actorId: command.requesterId,
          nodeId: this.localNodeId,
          payload: {
            flight: {
              id: createRuntimeId("flt"),
              invocationId: command.agentId,
              requesterId: command.requesterId,
              targetAgentId: command.agentId,
              state: "waking",
              summary: command.reason,
            },
          },
        });
        return;
      case "stream.subscribe":
        return;
      case "channel.member.remove":
      case "channel.invite.create":
      case "channel.invite.revoke":
      case "channel.invite.redeem":
        // Invitation writes are a read-modify-write of one channel's
        // invitation set and must stay inside the durable broker's serialized
        // command queue. This in-memory registry has no durable conversation
        // writer, so routing one here would silently drop a concurrent write
        // rather than fail.
        throw new Error(
          `${command.kind} must be executed by the durable broker command service, not the in-memory registry.`,
        );
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  async upsertNode(node: NodeDefinition): Promise<void> {
    const changed = registrySubstanceChanged("node", this.registry.nodes[node.id], node);
    this.registry.nodes[node.id] = node;
    markRoutingRegistryVersion(this.registry);
    if (!changed) return;
    this.emit({
      id: createRuntimeId("evt"),
      kind: "node.upserted",
      ts: Date.now(),
      actorId: node.id,
      nodeId: node.id,
      payload: { node },
    });
  }

  async upsertActor(actor: RuntimeActorIdentity): Promise<void> {
    const previous = this.registry.actors[actor.id];
    // Re-registration revives the identity — clear the tombstone.
    this.retiredActorIds.delete(actor.id);
    this.registry.actors[actor.id] = {
      id: actor.id,
      kind: actor.kind,
      displayName: actor.displayName,
      handle: actor.handle,
      labels: actor.labels,
      metadata: actor.metadata,
      // First-registration stamp: preserved across re-upserts and replay,
      // retention's last-resort age evidence.
      createdAt: actor.createdAt ?? this.registry.actors[actor.id]?.createdAt ?? Date.now(),
    };
    markRoutingRegistryVersion(this.registry);
    if (!registrySubstanceChanged("actor", previous, this.registry.actors[actor.id]!)) return;
    this.emit({
      id: createRuntimeId("evt"),
      kind: "actor.registered",
      ts: Date.now(),
      actorId: actor.id,
      nodeId: this.localNodeId,
      payload: { actor },
    });
  }

  async upsertAgent(agent: RuntimeAgentDefinition): Promise<void> {
    const changed = registrySubstanceChanged("agent", this.registry.agents[agent.id], agent);
    // Agent registration synthesizes the actor identity — it revives the id.
    this.retiredActorIds.delete(agent.id);
    if (!this.registry.actors[agent.id]) {
      this.registry.actors[agent.id] = {
        id: agent.id,
        kind: agent.kind,
        displayName: agent.displayName,
        handle: agent.handle,
        labels: agent.labels,
        metadata: agent.metadata,
        createdAt: agent.createdAt ?? Date.now(),
      };
    }
    this.registry.agents[agent.id] = agent;
    markRoutingRegistryVersion(this.registry);
    if (!changed) return;
    this.emit({
      id: createRuntimeId("evt"),
      kind: "agent.registered",
      ts: Date.now(),
      actorId: agent.id,
      nodeId: agent.authorityNodeId,
      payload: { agent },
    });
  }

  /**
   * Upsert an agent using only identity fields. Used for external harnesses
   * (SCO-016) where the full AgentDefinition fields are not available.
   */
  upsertAgentIdentity(input: {
    id: string;
    displayName: string;
    handle: string;
    selector?: string;
    labels?: string[];
    authorityNodeId: string;
    metadata?: Record<string, unknown>;
  }): void {
    // Identity-only registration synthesizes the actor — it revives the id.
    this.retiredActorIds.delete(input.id);
    if (!this.registry.actors[input.id]) {
      this.registry.actors[input.id] = {
        id: input.id,
        kind: "agent" as const,
        displayName: input.displayName,
        handle: input.handle,
        labels: input.labels,
        metadata: input.metadata,
        createdAt: Date.now(),
      };
    }
    const partial: AgentDefinition = {
      id: input.id,
      definitionId: input.id as ScoutId,
      kind: "agent",
      authorityNodeId: input.authorityNodeId as ScoutId,
      displayName: input.displayName,
      handle: input.handle,
      labels: input.labels,
      selector: input.selector,
      agentClass: "general" as const,
      capabilities: [],
      wakePolicy: "on_demand" as const,
      homeNodeId: input.authorityNodeId as ScoutId,
      advertiseScope: "local" as const,
      metadata: input.metadata,
    };
    const changed = registrySubstanceChanged("agent", this.registry.agents[input.id], partial);
    this.registry.agents[input.id] = partial;
    markRoutingRegistryVersion(this.registry);
    if (!changed) return;
    this.emit({
      id: createRuntimeId("evt"),
      kind: "agent.registered",
      ts: Date.now(),
      actorId: input.id,
      nodeId: input.authorityNodeId,
      payload: { agent: partial },
    });
  }

  async upsertEndpoint(endpoint: AgentEndpoint): Promise<void> {
    const previous = this.registry.endpoints[endpoint.id];
    if (previous) {
      this.unindexEndpoint(previous);
    }
    this.registry.endpoints[endpoint.id] = endpoint;
    markRoutingRegistryVersion(this.registry);
    this.indexEndpoint(endpoint);
    if (!registrySubstanceChanged("endpoint", previous, endpoint)) return;
    this.emit({
      id: createRuntimeId("evt"),
      kind: "agent.endpoint.upserted",
      ts: Date.now(),
      actorId: endpoint.agentId,
      nodeId: endpoint.nodeId,
      payload: { endpoint },
    });
  }

  refreshEndpointSilently(endpoint: AgentEndpoint): void {
    const previous = this.registry.endpoints[endpoint.id];
    if (previous && previous.agentId !== endpoint.agentId) {
      this.unindexEndpoint(previous);
    }
    this.registry.endpoints[endpoint.id] = endpoint;
    markRoutingRegistryVersion(this.registry);
    if (!previous || previous.agentId !== endpoint.agentId) {
      this.indexEndpoint(endpoint);
    }
  }

  deleteEndpoint(id: string): void {
    const endpoint = this.registry.endpoints[id];
    if (!endpoint) return;
    this.unindexEndpoint(endpoint);
    delete this.registry.endpoints[id];
    markRoutingRegistryVersion(this.registry);
    this.emit({
      id: createRuntimeId("evt"),
      kind: "agent.endpoint.deleted",
      ts: Date.now(),
      actorId: endpoint.agentId,
      nodeId: endpoint.nodeId,
      payload: { endpointId: id },
    });
  }

  deleteAgent(id: string): void {
    // Endpoints ride along with their agent. Idempotent: an endpoint delete
    // journaled ahead of the agent delete may already have removed them.
    const endpointIds = this.endpointIdsByAgentId.get(id);
    if (endpointIds) {
      for (const endpointId of [...endpointIds]) {
        this.deleteEndpoint(endpointId);
      }
    }
    if (!this.registry.agents[id]) return;
    delete this.registry.agents[id];
    markRoutingRegistryVersion(this.registry);
    // No agent.deleted control-event kind exists; endpoint.deleted per endpoint
    // above is the only wire signal. Subscribers reconcile via snapshot diff.
  }

  deleteActor(id: string): void {
    // Mark even when the row is already gone — the tombstone is the fact.
    this.retiredActorIds.add(id);
    if (!this.registry.actors[id]) return;
    delete this.registry.actors[id];
    markRoutingRegistryVersion(this.registry);
  }

  /**
   * Evict exactly the ids a journaled `history.rotate` marker verified —
   * the runtime mirror of the rotation. Eligibility is never recomputed
   * here; the writer already verified each id against durable SQLite. No
   * tombstones, no control events: eviction is a cache rotation, not a
   * semantic delete; SQLite keeps the records.
   */
  applyHistoryRotation(evicted: {
    messageIds: Iterable<string>;
    invocationIds: Iterable<string>;
    flightIds: Iterable<string>;
  }): void {
    const flightIds = new Set(evicted.flightIds);
    applyHistoryRotationEviction(this.registry, {
      messageIds: new Set(evicted.messageIds),
      invocationIds: new Set(evicted.invocationIds),
      flightIds,
    });
    if (flightIds.size > 0) {
      for (const [invocationId, flightId] of this.flightIdByInvocationId) {
        if (flightIds.has(flightId)) {
          this.flightIdByInvocationId.delete(invocationId);
        }
      }
    }
  }

  async upsertConversation(conversation: ConversationDefinition): Promise<void> {
    // Conversations predate timestamp stamping; backfill createdAt/updatedAt
    // (via metadata, which the snapshot incremental filter reads) so every
    // stored record stays visible to `?since=` snapshot queries.
    const metadata = conversation.metadata as Record<string, unknown> | undefined;
    if (typeof metadata?.createdAt !== "number" || typeof metadata?.updatedAt !== "number") {
      const now = Date.now();
      conversation = {
        ...conversation,
        metadata: {
          ...metadata,
          createdAt: typeof metadata?.createdAt === "number" ? metadata.createdAt : now,
          updatedAt: now,
        },
      };
    }
    this.registry.conversations[conversation.id] = conversation;
    this.emit({
      id: createRuntimeId("evt"),
      kind: "conversation.upserted",
      ts: Date.now(),
      actorId: "system",
      nodeId: conversation.authorityNodeId,
      payload: { conversation },
    });
  }

  async upsertBinding(binding: ConversationBinding): Promise<void> {
    const previous = this.registry.bindings[binding.id];
    if (previous) {
      this.unindexBinding(previous);
    }
    this.registry.bindings[binding.id] = binding;
    this.indexBinding(binding);
    this.emit({
      id: createRuntimeId("evt"),
      kind: "binding.upserted",
      ts: Date.now(),
      actorId: "system",
      nodeId: this.localNodeId,
      payload: { binding },
    });
  }

  async upsertCollaboration(record: CollaborationRecord): Promise<void> {
    assertValidCollaborationRecord(record);
    this.registry.collaborationRecords[record.id] = record;
    this.emit({
      id: createRuntimeId("evt"),
      kind: "collaboration.upserted",
      ts: Date.now(),
      actorId: record.createdById,
      nodeId: this.localNodeId,
      payload: { record },
    });
  }

  async appendCollaborationEvent(event: CollaborationEvent): Promise<void> {
    const record = this.registry.collaborationRecords[event.recordId];
    if (!record) {
      throw new Error(`unknown collaboration record: ${event.recordId}`);
    }

    assertValidCollaborationEvent(event, record);
    this.emit({
      id: createRuntimeId("evt"),
      kind: "collaboration.event.appended",
      ts: Date.now(),
      actorId: event.actorId,
      nodeId: this.localNodeId,
      payload: { event },
    });
  }

  async upsertFlight(flight: FlightRecord, options: { preserveCurrent?: boolean } = {}): Promise<void> {
    const previous = this.registry.flights[flight.id];
    if (!options.preserveCurrent && previous && this.flightIdByInvocationId.get(previous.invocationId) === previous.id) {
      this.flightIdByInvocationId.delete(previous.invocationId);
    }
    this.registry.flights[flight.id] = flight;
    if (!options.preserveCurrent) this.flightIdByInvocationId.set(flight.invocationId, flight.id);
    this.emit({
      id: createRuntimeId("evt"),
      kind: "flight.updated",
      ts: Date.now(),
      actorId: flight.requesterId,
      nodeId: this.localNodeId,
      payload: { flight },
    });
  }

  async postMessage(
    message: MessageRecord,
    options: { localOnly?: boolean } = {},
  ): Promise<DeliveryIntent[]> {
    const deliveries = this.planMessage(message, options);
    await this.commitMessage(message, deliveries);
    return deliveries;
  }

  planMessage(
    message: MessageRecord,
    options: { localOnly?: boolean } = {},
  ): DeliveryIntent[] {
    const conversation = this.registry.conversations[message.conversationId];
    if (!conversation) {
      throw new Error(`unknown conversation: ${message.conversationId}`);
    }

    const bindingRoutes = resolveBindingRoutes(
      this.bindingsForConversation(conversation.id),
      message,
    );
    const plannedParticipantRoutes = this.resolveParticipantRoutes(conversation.participantIds);
    const participantRoutes = options.localOnly
      ? plannedParticipantRoutes.filter((route) => !route.nodeId || route.nodeId === this.localNodeId)
      : plannedParticipantRoutes;
    const deliveries = planMessageDeliveries({
      localNodeId: this.localNodeId,
      message,
      conversation,
      participantRoutes,
      bindingRoutes: options.localOnly ? [] : bindingRoutes,
    });

    return deliveries;
  }

  async correctMessage(message: MessageRecord): Promise<void> {
    if (!asyncMessageRecordView(this.registry.messages)) this.registry.messages[message.id] = message;
    this.emit({ id: createRuntimeId("evt"), kind: "message.corrected", ts: Date.now(), actorId: message.actorId,
      nodeId: message.originNodeId, payload: { message } });
  }

  async commitMessage(
    message: MessageRecord,
    deliveries: DeliveryIntent[],
  ): Promise<void> {
    if(!asyncMessageRecordView(this.registry.messages))this.registry.messages[message.id] = message;

    this.emit({
      id: createRuntimeId("evt"),
      kind: "message.posted",
      ts: Date.now(),
      actorId: message.actorId,
      nodeId: message.originNodeId,
      payload: { message },
    });

    for (const delivery of deliveries) {
      this.emit({
        id: createRuntimeId("evt"),
        kind: "delivery.planned",
        ts: Date.now(),
        actorId: message.actorId,
        nodeId: message.originNodeId,
        payload: { delivery },
      });
    }
  }

  async upsertReadCursor(cursor: ConversationReadCursor): Promise<void> {
    this.registry.readCursors[`${cursor.conversationId}\u0000${cursor.actorId}`] = cursor;
    this.emit({
      id: createRuntimeId("evt"),
      kind: "conversation.read_cursor.updated",
      ts: Date.now(),
      actorId: cursor.actorId,
      nodeId: cursor.readerNodeId ?? this.localNodeId,
      payload: { cursor },
    });
  }

  async invokeAgent(invocation: InvocationRequest): Promise<FlightRecord> {
    const flight = this.planInvocation(invocation);
    await this.commitInvocation(invocation, flight);
    return flight;
  }

  planInvocation(invocation: InvocationRequest): FlightRecord {
    const targetAgent = this.registry.agents[invocation.targetAgentId];
    const targetActor = this.registry.actors[invocation.targetAgentId] ?? targetAgent;
    if (!targetActor) {
      throw new Error(`unknown target actor: ${invocation.targetAgentId}`);
    }
    const targetNodeId = targetAgent?.authorityNodeId ?? invocation.targetNodeId ?? this.localNodeId;
    const targetDisplayName = targetActor.displayName || invocation.targetAgentId;

    const targetEndpoints = this.endpointsForAgent(
      invocation.targetAgentId,
      {
        nodeId: targetNodeId,
        harness: invocation.execution?.harness,
      },
    );
    const isLocalAuthority = !this.localNodeId || !targetNodeId || targetNodeId === this.localNodeId;
    const startedAt = Date.now();

    let state: FlightRecord["state"] = invocation.ensureAwake ? "waking" : "queued";
    let summary: string | undefined;
    let error: string | undefined;
    let completedAt: number | undefined;

    if (isLocalAuthority) {
      if (targetEndpoints.length == 0) {
        state = invocation.ensureAwake ? "waking" : "queued";
        summary = invocation.ensureAwake
          ? (invocation.execution?.harness
              ? `${targetDisplayName} waking on ${invocation.execution.harness}.`
              : `${targetDisplayName} waking.`)
          : `Message stored for ${targetDisplayName}. Will deliver when online.`;
      } else {
        state = "queued";
        summary = `${targetDisplayName} queued for local execution.`;
      }
    }

    const flight: FlightRecord = {
      id: createRuntimeId("flt"),
      invocationId: invocation.id,
      requesterId: invocation.requesterId,
      targetAgentId: invocation.targetAgentId,
      state,
      summary,
      error,
      startedAt,
      completedAt,
      labels: invocation.labels,
      metadata: invocation.metadata,
    };

    return flight;
  }

  async commitInvocation(
    invocation: InvocationRequest,
    flight: FlightRecord,
  ): Promise<void> {
    const previous = this.registry.flights[flight.id];
    if (previous && this.flightIdByInvocationId.get(previous.invocationId) === previous.id) {
      this.flightIdByInvocationId.delete(previous.invocationId);
    }
    this.registry.invocations[invocation.id] = invocation;
    this.registry.flights[flight.id] = flight;
    this.flightIdByInvocationId.set(flight.invocationId, flight.id);

    const targetAgent = this.registry.agents[invocation.targetAgentId];
    const targetEndpoint = preferredEndpoint(this.endpointsForAgent(invocation.targetAgentId));

    this.emit({
      id: createRuntimeId("evt"),
      kind: "invocation.requested",
      ts: Date.now(),
      actorId: invocation.requesterId,
      nodeId: invocation.requesterNodeId,
      payload: { invocation },
    });

    this.emit({
      id: createRuntimeId("evt"),
      kind: "flight.updated",
      ts: Date.now(),
      actorId: invocation.requesterId,
      nodeId: targetAgent?.authorityNodeId ?? targetEndpoint?.nodeId,
      payload: { flight },
    });
  }

  private rebuildIndexes(): void {
    for (const endpoint of Object.values(this.registry.endpoints)) {
      this.indexEndpoint(endpoint);
    }
    for (const binding of Object.values(this.registry.bindings)) {
      this.indexBinding(binding);
    }
    for (const flight of Object.values(this.registry.flights)) {
      this.flightIdByInvocationId.set(flight.invocationId, flight.id);
    }
  }

  private indexEndpoint(endpoint: AgentEndpoint): void {
    this.addIndexedId(this.endpointIdsByAgentId, endpoint.agentId, endpoint.id);
  }

  private unindexEndpoint(endpoint: AgentEndpoint): void {
    this.removeIndexedId(this.endpointIdsByAgentId, endpoint.agentId, endpoint.id);
  }

  private indexBinding(binding: ConversationBinding): void {
    this.addIndexedId(this.bindingIdsByConversationId, binding.conversationId, binding.id);
  }

  private unindexBinding(binding: ConversationBinding): void {
    this.removeIndexedId(this.bindingIdsByConversationId, binding.conversationId, binding.id);
  }

  private addIndexedId(index: Map<ScoutId, Set<ScoutId>>, key: ScoutId, value: ScoutId): void {
    const ids = index.get(key) ?? new Set<ScoutId>();
    ids.add(value);
    index.set(key, ids);
  }

  private removeIndexedId(index: Map<ScoutId, Set<ScoutId>>, key: ScoutId, value: ScoutId): void {
    const ids = index.get(key);
    if (!ids) {
      return;
    }

    ids.delete(value);
    if (ids.size === 0) {
      index.delete(key);
    }
  }

  private resolveParticipantRoutes(participantIds: ScoutId[]): DeliveryRoute[] {
    const routes: DeliveryRoute[] = [];

    for (const participantId of participantIds) {
      const actor = this.registry.actors[participantId];
      const agent = this.registry.agents[participantId];
      const targetIdentity = actor ?? agent;
      const endpoints = this.endpointsForAgent(participantId);
      const endpoint = preferredEndpoint(endpoints);

      if (!endpoint) {
        if (agent?.authorityNodeId && agent.authorityNodeId !== this.localNodeId) {
          routes.push({
            targetId: participantId,
            nodeId: agent.authorityNodeId,
            targetKind: toTargetKind(targetIdentity),
            transport: defaultTransportForActor(targetIdentity),
            speechEnabled: false,
          });
        } else if (agent) {
          routes.push({
            targetId: participantId,
            nodeId: agent.authorityNodeId ?? this.localNodeId,
            targetKind: toTargetKind(targetIdentity),
            transport: defaultTransportForActor(targetIdentity),
            speechEnabled: false,
          });
        }

        continue;
      }

      routes.push({
        targetId: participantId,
        nodeId: endpoint.nodeId ?? agent?.authorityNodeId,
        targetKind: toTargetKind(targetIdentity),
        transport: endpoint.transport ?? defaultTransportForActor(targetIdentity),
        speechEnabled: Boolean(
          actor?.kind === "device"
          || endpoints.some((candidate) => candidate.transport === "local_socket" || candidate.transport === "websocket"),
        ),
      });
    }

    return routes;
  }

  private emit(event: ControlEvent): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > 500) {
      this.eventBuffer.shift();
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function createInMemoryControlRuntime(
  initial: Partial<RuntimeRegistrySnapshot> = {},
  options: { localNodeId?: ScoutId; retiredActorIds?: Iterable<ScoutId> } = {},
): InMemoryControlRuntime {
  return new InMemoryControlRuntime(initial, options);
}
