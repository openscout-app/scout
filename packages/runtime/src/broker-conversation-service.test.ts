import { describe, expect, test } from "bun:test";

import {
  directChannelNaturalKey,
  namedChannelNaturalKey,
  stableChannelId,
  systemChannelNaturalKey,
  type ActorIdentity,
  type AgentDefinition,
  type ConversationDefinition,
} from "@openscout/protocol";

import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import { BrokerConversationService } from "./broker-conversation-service.js";

function actor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "operator",
    kind: "person",
    displayName: "Operator",
    handle: "operator",
    labels: [],
    metadata: {},
    ...input,
  };
}

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "channel",
    title: "shared",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-local",
    participantIds: ["operator", "agent-1"],
    metadata: { naturalKey: namedChannelNaturalKey("shared"), channel: "shared" },
    ...input,
  };
}

function createHarness(input: {
  snapshot?: RuntimeRegistrySnapshot;
  operatorDisplayName?: string;
} = {}) {
  const snapshot = input.snapshot ?? createRuntimeRegistrySnapshot();
  const upsertedActors: ActorIdentity[] = [];
  const upsertedConversations: ConversationDefinition[] = [];
  let nextChannel = 0;
  const service = new BrokerConversationService({
    nodeId: "node-local",
    operatorActorId: "operator",
    dispatcherAgentId: "scout.dispatcher",
    runtime: {
      snapshot: () => snapshot,
    },
    operatorDisplayName: () => input.operatorDisplayName ?? "Arach",
    createChannelId: () => `c-${++nextChannel}`,
    async upsertActor(nextActor) {
      upsertedActors.push(nextActor);
      snapshot.actors[nextActor.id] = nextActor;
    },
    async updateConversation(conversationId, mutate) {
      const current = snapshot.conversations[conversationId];
      const next = mutate(current);
      if (!next) return { updated: false, conversation: current ?? null };
      upsertedConversations.push(next);
      snapshot.conversations[next.id] = next;
      return { updated: true, conversation: next };
    },
  });

  return {
    service,
    snapshot,
    upsertedActors,
    upsertedConversations,
  };
}

describe("BrokerConversationService", () => {
  test("rejects destinationless delivery without writing a conversation", async () => {
    const harness = createHarness();
    for (const route of [{}, { channel: "  " }, { targetAgentId: "  ", channel: " " }]) {
      await expect(harness.service.ensureDeliveryConversation({ requesterId: "operator", ...route }))
        .rejects.toThrow("Delivery requires an explicit target or channel");
    }
    expect(harness.upsertedConversations).toEqual([]);
    const dm = await harness.service.ensureDeliveryConversation({
      requesterId: "operator", targetAgentId: " agent-1 ", channel: "  ",
    });
    expect(dm.kind).toBe("direct");
    expect(dm.participantIds).toEqual(["agent-1", "operator"]);
  });

  test("delivers a chn- channel to that conversation instead of minting a room titled with the id", async () => {
    const direct = conversation({
      id: "chn-6f87a504d64f422dbbc721401dec6df9",
      kind: "direct",
      title: "Agent One",
      visibility: "private",
      shareMode: "local",
      participantIds: ["agent-1", "operator"],
      metadata: { naturalKey: directChannelNaturalKey(["agent-1", "operator"]) },
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({ conversations: { [direct.id]: direct } }),
    });

    for (const requesterId of ["agent-1", "operator"]) {
      await expect(harness.service.ensureDeliveryConversation({ requesterId, channel: ` ${direct.id} ` }))
        .resolves.toBe(direct);
    }
    await expect(harness.service.ensureDeliveryConversation({ requesterId: "agent-2", channel: direct.id }))
      .rejects.toThrow("agent-2 is not a participant of conversation chn-6f87a504d64f422dbbc721401dec6df9");
    await expect(harness.service.ensureDeliveryConversation({ requesterId: "agent-1", channel: "chn-0000missing" }))
      .rejects.toThrow("Unknown conversation chn-0000missing");
    expect(harness.upsertedConversations).toEqual([]);
  });

  test("creates missing broker actors and refreshes operator display names", async () => {
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        actors: {
          operator: actor({ displayName: "Old Operator", labels: undefined, metadata: undefined }),
        },
        agents: {
          "agent-known": agent({ id: "agent-known" }),
        },
      }),
    });

    await harness.service.ensureActorForDelivery("operator");
    await harness.service.ensureActorForDelivery("agent-new");
    await harness.service.ensureActorForDelivery("agent-known");

    expect(harness.upsertedActors).toEqual([
      expect.objectContaining({
        id: "operator",
        kind: "person",
        displayName: "Arach",
        labels: ["scout"],
        metadata: { source: "broker-deliver" },
      }),
      expect.objectContaining({
        id: "agent-new",
        kind: "agent",
        displayName: "Agent New",
        handle: "agent-new",
        labels: ["scout"],
      }),
    ]);
  });

  test("creates direct conversations with natural identity and remote share mode", async () => {
    const remoteAgent = agent({
      id: "agent-remote",
      displayName: "Remote Agent",
      authorityNodeId: "node-peer",
      homeNodeId: "node-peer",
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        actors: { operator: actor() },
        agents: {
          [remoteAgent.id]: remoteAgent,
          "scout.dispatcher": agent({ id: "scout.dispatcher", displayName: "Dispatcher" }),
        },
      }),
    });

    const direct = await harness.service.ensureDeliveryConversation({
      requesterId: "operator",
      targetAgentId: remoteAgent.id,
    });
    expect(direct).toEqual(expect.objectContaining({
      id: "c-1",
      kind: "direct",
      title: "Remote Agent",
      visibility: "private",
      shareMode: "shared",
      authorityNodeId: "node-local",
      participantIds: ["agent-remote", "operator"],
      metadata: expect.objectContaining({
        surface: "broker",
        naturalKey: directChannelNaturalKey(["agent-remote", "operator"]),
      }),
    }));

    const existing = await harness.service.ensureDeliveryConversation({
      requesterId: "operator",
      targetAgentId: remoteAgent.id,
    });
    expect(existing).toBe(direct);
    expect(harness.upsertedConversations).toHaveLength(1);

    const scout = await harness.service.ensureDeliveryConversation({
      requesterId: "operator",
      targetAgentId: "scout.dispatcher",
    });
    expect(scout.title).toBe("Scout");
    expect(scout.metadata?.role).toBe("partner");
  });

  test("broadcast snapshots live endpoints, replaces old membership, and leaves the retired room untouched", async () => {
    const legacy = conversation({ id: stableChannelId(namedChannelNaturalKey("shared")) });
    const alias = conversation({ id: "channel.shared" });
    const harness = createHarness({ snapshot: createRuntimeRegistrySnapshot({
      conversations: { [legacy.id]: legacy, [alias.id]: alias },
      agents: Object.fromEntries(["live", "offline", "unattached", "next"].map((id) => [id, agent({ id })])),
      endpoints: {
        live: { id: "live", agentId: "live", nodeId: "node-local", harness: "codex", transport: "acp", state: "active" },
        duplicate: { id: "duplicate", agentId: "live", nodeId: "node-local", harness: "codex", transport: "acp", state: "offline" },
        offline: { id: "offline", agentId: "offline", nodeId: "node-local", harness: "codex", transport: "acp", state: "offline" },
      },
    }) });
    const first = await harness.service.ensureDeliveryConversation({ requesterId: "operator", channel: "shared" });
    expect(first.id).toBe(stableChannelId(namedChannelNaturalKey("broadcast")));
    expect(first.participantIds).toEqual(["live", "operator"]);
    harness.snapshot.endpoints.live!.state = "offline";
    harness.snapshot.endpoints.next = { ...harness.snapshot.endpoints.live!, id: "next", agentId: "next", state: "active" };
    const second = await harness.service.ensureDeliveryConversation({ requesterId: "operator", channel: "shared" });
    expect(second.id).toBe(first.id);
    expect(second.participantIds).toEqual(["next", "operator"]);
    harness.snapshot.endpoints.next.state = "offline";
    const empty = await harness.service.ensureDeliveryConversation({ requesterId: "operator", channel: "shared" });
    expect(empty.participantIds).toEqual(["operator"]);
    expect(harness.snapshot.conversations[legacy.id]).toBe(legacy);
    expect(harness.snapshot.conversations[alias.id]).toBe(alias);
    expect(harness.upsertedConversations.every((record) => record.id === first.id)).toBe(true);
  });

  test("creates and merges channel conversations with scoped participant rules", async () => {
    const existingDocs = conversation({
      id: "channel.docs",
      title: "docs",
      shareMode: "local",
      metadata: { channel: "docs" },
      participantIds: ["operator"],
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        conversations: { [existingDocs.id]: existingDocs },
        agents: {
          "agent-1": agent({ id: "agent-1" }),
          "agent-2": agent({ id: "agent-2" }),
        },
      }),
    });

    const shared = await harness.service.ensureDeliveryConversation({
      requesterId: "operator",
      channel: "shared",
    });
    expect(shared).toEqual(expect.objectContaining({
      id: stableChannelId(namedChannelNaturalKey("broadcast")),
      kind: "channel",
      title: "broadcast",
      shareMode: "shared",
      participantIds: ["operator"],
      metadata: expect.objectContaining({
        channel: "broadcast",
        naturalKey: namedChannelNaturalKey("broadcast"),
      }),
    }));

    const docs = await harness.service.ensureDeliveryConversation({
      requesterId: "operator",
      targetAgentId: "agent-1",
      channel: "docs",
    });
    expect(docs).toEqual(expect.objectContaining({
      id: stableChannelId(namedChannelNaturalKey("docs")),
      title: "docs",
      participantIds: ["agent-1", "operator"],
      metadata: expect.objectContaining({
        naturalKey: namedChannelNaturalKey("docs"),
      }),
    }));

    const system = await harness.service.ensureDeliveryConversation({
      requesterId: "operator",
      targetAgentId: "agent-1",
      channel: "system",
    });
    expect(system).toEqual(expect.objectContaining({
      kind: "system",
      visibility: "system",
      shareMode: "local",
      participantIds: ["operator"],
      metadata: expect.objectContaining({
        naturalKey: systemChannelNaturalKey("system"),
      }),
    }));

    const voice = await harness.service.ensureDeliveryConversation({
      requesterId: "operator",
      targetAgentId: "agent-1",
      channel: "voice",
    });
    expect(voice).toEqual(expect.objectContaining({
      title: "voice",
      visibility: "workspace",
      participantIds: ["agent-1", "operator"],
      metadata: expect.objectContaining({
        channel: "voice",
        naturalKey: namedChannelNaturalKey("voice"),
      }),
    }));
  });
});
