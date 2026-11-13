import {
  CHANNEL_ID_PREFIX,
  conversationNaturalKey,
  conversationsWithNaturalKey,
  directChannelNaturalKey,
  namedChannelNaturalKey,
  stableChannelId,
  systemChannelNaturalKey,
  type ActorIdentity,
  type ConversationDefinition,
} from "@openscout/protocol";

import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import {
  brokerActorDisplayName,
  findConversationByIdentity,
  resolveConversationShareMode,
  titleCaseName,
} from "./broker-conversation-helpers.js";
import { isOperatorTitled, resolveConversationTitle } from "./conversation-title.js";

export type BrokerConversationRuntime = {
  snapshot(): RuntimeSnapshot;
};

export type BrokerConversationServiceDeps = {
  nodeId: string;
  operatorActorId: string;
  dispatcherAgentId: string;
  runtime: BrokerConversationRuntime;
  operatorDisplayName: () => string;
  createChannelId: () => string;
  upsertActor: (actor: ActorIdentity) => Promise<void>;
  /**
   * Canonical read-modify-write on one conversation — the mutator runs inside
   * the serialized durable writer against the latest record, so a roster
   * merged here cannot overwrite a concurrent membership change with a stale
   * preimage.
   */
  updateConversation: (
    conversationId: string,
    mutate: (
      current: ConversationDefinition | undefined,
    ) => ConversationDefinition | null | undefined,
  ) => Promise<{ conversation: ConversationDefinition | null }>;
};

export class BrokerConversationService {
  constructor(private readonly deps: BrokerConversationServiceDeps) {}

  readonly ensureActorForDelivery = async (actorId: string): Promise<void> => {
    const snapshot = this.deps.runtime.snapshot();
    const existingActor = snapshot.actors[actorId];
    const displayName = actorId === this.deps.operatorActorId
      ? this.deps.operatorDisplayName()
      : titleCaseName(actorId);

    if (existingActor || snapshot.agents[actorId]) {
      if (actorId === this.deps.operatorActorId
        && existingActor
        && existingActor.displayName !== displayName) {
        await this.deps.upsertActor({
          ...existingActor,
          kind: "person",
          displayName,
          handle: existingActor.handle || actorId,
          labels: existingActor.labels ?? ["scout"],
          metadata: existingActor.metadata ?? { source: "broker-deliver" },
        });
      }
      return;
    }

    await this.deps.upsertActor({
      id: actorId,
      kind: actorId === this.deps.operatorActorId ? "person" : "agent",
      displayName,
      handle: actorId,
      labels: ["scout"],
      metadata: { source: "broker-deliver" },
    });
  };

  readonly ensureDeliveryConversation = async (input: {
    requesterId: string;
    targetAgentId?: string;
    channel?: string;
  }): Promise<ConversationDefinition> => {
    const snapshot = this.deps.runtime.snapshot();
    const normalizedChannel = input.channel?.trim();
    const targetAgentId = input.targetAgentId?.trim();

    if (!normalizedChannel && targetAgentId) {
      return await this.ensureDirectConversation(snapshot, input.requesterId, targetAgentId);
    }

    if (!normalizedChannel) {
      throw new Error("Delivery requires an explicit target or channel; use scout broadcast to tell everyone.");
    }

    if (normalizedChannel.startsWith(CHANNEL_ID_PREFIX)) {
      return this.existingConversationById(snapshot, normalizedChannel, input.requesterId);
    }

    return await this.ensureChannelConversation(snapshot, {
      requesterId: input.requesterId,
      targetAgentId,
      // Keep the explicit legacy wire selector, but never feed the retired room.
      channel: normalizedChannel === "shared" ? "broadcast" : normalizedChannel,
    });
  };

  /**
   * A `chn-…` channel is a conversation id, not a name. Minting a named
   * channel from it would create a second room titled with the id, so the
   * delivery goes to that conversation or fails with a reason.
   */
  private existingConversationById(
    snapshot: RuntimeSnapshot,
    conversationId: string,
    requesterId: string,
  ): ConversationDefinition {
    const existing = snapshot.conversations[conversationId];
    if (!existing) {
      throw new Error(
        `Unknown conversation ${conversationId}: a chn- channel is a conversation id, not a channel name, and this broker has no conversation with that id. Reply with --ref, address the agent, or use a channel name.`,
      );
    }
    if (requesterId !== this.deps.operatorActorId && !existing.participantIds.includes(requesterId)) {
      throw new Error(
        `${requesterId} is not a participant of conversation ${conversationId}; address the agent or use a channel name instead.`,
      );
    }
    return existing;
  }

  private async ensureDirectConversation(
    snapshot: RuntimeSnapshot,
    requesterId: string,
    targetAgentId: string,
  ): Promise<ConversationDefinition> {
    const participantIds = [...new Set([requesterId, targetAgentId])].sort();
    const shareMode = resolveConversationShareMode(snapshot, participantIds, "local", this.deps.nodeId);
    const naturalKey = directChannelNaturalKey(participantIds);
    const existing = findConversationByIdentity(snapshot, naturalKey);
    const conversationId = existing?.id ?? this.deps.createChannelId();
    const alreadyMatches = existing
      && existing.kind === "direct"
      && existing.visibility === "private"
      && existing.shareMode === shareMode
      && existing.participantIds.join("\u0000") === participantIds.join("\u0000");
    if (alreadyMatches) {
      return existing;
    }

    // The write goes through the canonical writer so the record journaled
    // here is derived from the latest conversation — a concurrent roster or
    // title write queued ahead of this one is not overwritten by `existing`.
    const result = await this.deps.updateConversation(conversationId, (current) => {
      const fresh = this.deps.runtime.snapshot();
      const freshShareMode = resolveConversationShareMode(fresh, participantIds, "local", this.deps.nodeId);
      if (current
        && current.kind === "direct"
        && current.visibility === "private"
        && current.shareMode === freshShareMode
        && current.participantIds.join("\u0000") === participantIds.join("\u0000")) {
        return null;
      }
      const nonOperatorParticipants = participantIds.filter((participantId) => participantId !== this.deps.operatorActorId);
      const conversationTitle = requesterId === this.deps.operatorActorId || targetAgentId === this.deps.operatorActorId
        ? this.actorDisplayName(fresh, nonOperatorParticipants[0] ?? targetAgentId)
        : `${this.actorDisplayName(fresh, requesterId)} <> ${this.actorDisplayName(fresh, targetAgentId)}`;
      return {
        id: conversationId,
        kind: "direct" as const,
        /* Automatic naming defers to a human one. Without this, re-deriving the
           conversation — a share-mode flip, a participant change — silently
           undoes a rename. */
        title: resolveConversationTitle({
          derived: targetAgentId === this.deps.dispatcherAgentId && requesterId === this.deps.operatorActorId
            ? "Scout"
            : conversationTitle,
          existingTitle: current?.title,
          existingMetadata: current?.metadata,
        }),
        visibility: "private" as const,
        shareMode: freshShareMode,
        authorityNodeId: this.deps.nodeId,
        participantIds,
        metadata: {
          surface: "broker",
          naturalKey,
          ...(targetAgentId === this.deps.dispatcherAgentId && requesterId === this.deps.operatorActorId ? { role: "partner" } : {}),
          /* The rename mark rides on metadata, and this object replaces it
             wholesale — carry it or the guard above has nothing to read next
             time. */
          ...(isOperatorTitled(current?.metadata)
            ? { titleSource: current!.metadata!.titleSource, titleSetAt: current!.metadata!.titleSetAt }
            : {}),
        },
      };
    });
    // The mutator only declines when a record exists, so `conversation` is
    // always populated here — either the write or the current record.
    return result.conversation!;
  }

  private async ensureChannelConversation(
    snapshot: RuntimeSnapshot,
    input: {
      requesterId: string;
      targetAgentId?: string;
      channel: string;
    },
  ): Promise<ConversationDefinition> {
    const broadcastParticipants = input.channel === "broadcast" ? [...new Set([
      this.deps.operatorActorId,
      input.requesterId,
      ...Object.values(snapshot.endpoints)
        .filter((endpoint) => endpoint.state !== "offline" && snapshot.agents[endpoint.agentId])
        .map((endpoint) => endpoint.agentId),
    ])].sort() : [];
    const scopedParticipants = [...new Set([
      this.deps.operatorActorId,
      input.requesterId,
      ...(input.targetAgentId ? [input.targetAgentId] : []),
    ])].sort();
    const systemParticipants = [...new Set([
      this.deps.operatorActorId,
      input.requesterId,
    ])].sort();

    const definition = this.channelDefinition(snapshot, {
      channel: input.channel,
      broadcastParticipants,
      scopedParticipants,
      systemParticipants,
    });
    const existing = snapshot.conversations[definition.id];
    const naturalKey = conversationNaturalKey(definition);
    const equivalentConversations = naturalKey
      ? conversationsWithNaturalKey(Object.values(snapshot.conversations), naturalKey)
      : [];
    // Broadcast membership is a send-time snapshot, not an accumulating roster.
    const nextParticipants = input.channel === "broadcast" ? definition.participantIds : [...new Set([
      ...equivalentConversations.flatMap((conversation) => conversation.participantIds),
      ...definition.participantIds,
    ])].sort();
    if (
      existing
      && existing.kind === definition.kind
      && existing.visibility === definition.visibility
      && existing.shareMode === definition.shareMode
      && existing.participantIds.join("\u0000") === nextParticipants.join("\u0000")
    ) {
      return existing;
    }

    // The write goes through the canonical writer so the roster merge — and
    // the broadcast membership snapshot — are recomputed against the latest
    // state inside the durable write, not the preimage read above.
    const result = await this.deps.updateConversation(definition.id, (current) => {
      const fresh = this.deps.runtime.snapshot();
      const freshBroadcastParticipants = input.channel === "broadcast" ? [...new Set([
        this.deps.operatorActorId,
        input.requesterId,
        ...Object.values(fresh.endpoints)
          .filter((endpoint) => endpoint.state !== "offline" && fresh.agents[endpoint.agentId])
          .map((endpoint) => endpoint.agentId),
      ])].sort() : [];
      const freshDefinition = this.channelDefinition(fresh, {
        channel: input.channel,
        broadcastParticipants: freshBroadcastParticipants,
        scopedParticipants,
        systemParticipants,
      });
      const freshNaturalKey = conversationNaturalKey(freshDefinition);
      const freshEquivalents = freshNaturalKey
        ? conversationsWithNaturalKey(Object.values(fresh.conversations), freshNaturalKey)
        : [];
      const mergedParticipants = input.channel === "broadcast" ? freshDefinition.participantIds : [...new Set([
        ...freshEquivalents.flatMap((conversation) => conversation.participantIds),
        ...freshDefinition.participantIds,
      ])].sort();
      if (
        current
        && current.kind === freshDefinition.kind
        && current.visibility === freshDefinition.visibility
        && current.shareMode === freshDefinition.shareMode
        && current.participantIds.join("\u0000") === mergedParticipants.join("\u0000")
      ) {
        return null;
      }
      return {
        ...freshDefinition,
        participantIds: mergedParticipants,
        // Merge rather than replace: keys this definition does not own —
        // invite sets, rename marks — survive the roster write.
        metadata: { ...(current?.metadata ?? {}), ...freshDefinition.metadata },
      };
    });
    // Same guarantee as ensureDirectConversation: `conversation` is the write
    // or the current record the mutator declined on.
    return result.conversation!;
  }

  private channelDefinition(
    snapshot: RuntimeSnapshot,
    input: {
      channel: string;
      broadcastParticipants: string[];
      scopedParticipants: string[];
      systemParticipants: string[];
    },
  ): ConversationDefinition {
    if (input.channel === "voice") {
      const naturalKey = namedChannelNaturalKey("voice");
      return {
        id: stableChannelId(naturalKey),
        kind: "channel",
        title: "voice",
        visibility: "workspace",
        shareMode: resolveConversationShareMode(snapshot, input.scopedParticipants, "local", this.deps.nodeId),
        authorityNodeId: this.deps.nodeId,
        participantIds: input.scopedParticipants,
        metadata: {
          surface: "broker",
          channel: "voice",
          naturalKey,
        },
      };
    }

    if (input.channel === "system") {
      const naturalKey = systemChannelNaturalKey("system");
      return {
        id: stableChannelId(naturalKey),
        kind: "system",
        title: "system",
        visibility: "system",
        shareMode: "local",
        authorityNodeId: this.deps.nodeId,
        participantIds: input.systemParticipants,
        metadata: {
          surface: "broker",
          channel: "system",
          naturalKey,
        },
      };
    }

    if (input.channel === "broadcast") {
      const naturalKey = namedChannelNaturalKey("broadcast");
      return {
        id: stableChannelId(naturalKey),
        kind: "channel",
        title: "broadcast",
        visibility: "workspace",
        shareMode: "shared",
        authorityNodeId: this.deps.nodeId,
        participantIds: input.broadcastParticipants,
        metadata: {
          surface: "broker",
          channel: "broadcast",
          naturalKey,
        },
      };
    }

    const naturalKey = namedChannelNaturalKey(input.channel);
    return {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: input.channel,
      visibility: "workspace",
      shareMode: resolveConversationShareMode(snapshot, input.scopedParticipants, "local", this.deps.nodeId),
      authorityNodeId: this.deps.nodeId,
      participantIds: input.scopedParticipants,
      metadata: {
        surface: "broker",
        channel: input.channel,
        naturalKey,
      },
    };
  }

  private actorDisplayName(snapshot: RuntimeSnapshot, actorId: string): string {
    return brokerActorDisplayName(snapshot, actorId, {
      operatorActorId: this.deps.operatorActorId,
      operatorDisplayName: this.deps.operatorDisplayName(),
    });
  }
}
