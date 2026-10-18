import { describe, expect, test } from "bun:test";

import {
  OPENSCOUT_IROH_MESH_ALPN,
  OPENSCOUT_MESH_PROTOCOL_VERSION,
  type ActorIdentity,
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
} from "@openscout/protocol";

import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import {
  BrokerMeshForwardingService,
  STALE_MESH_AUTHORITY_NODE_MS,
  actorIdsForCollaboration,
  hasReachableMeshEntrypoint,
  isReachableMeshNode,
  isReachableRemoteBrokerUrl,
  isStaleMeshAuthorityNode,
  postMeshPeerJson,
  type BrokerMeshForwardingServiceDeps,
} from "./broker-mesh-forwarding-service.js";

test("postMeshPeerJson uses the broker-scoped authenticated peer client", async () => {
  const calls: Array<{ baseUrl: string; path: string; method?: string; body?: BodyInit | null }> = [];
  const peerFetch = async (baseUrl: string, path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ baseUrl, path, method: init?.method, body: init?.body });
    return Response.json({ ok: true });
  };

  await expect(postMeshPeerJson(
    "https://peer.tailnet.example:43110",
    "/v1/mesh/flights",
    { id: "flight-1" },
    peerFetch,
  )).resolves.toEqual({ ok: true });
  expect(calls).toEqual([{
    baseUrl: "https://peer.tailnet.example:43110",
    path: "/v1/mesh/flights",
    method: "POST",
    body: JSON.stringify({ id: "flight-1" }),
  }]);
});

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-local",
    meshId: "openscout",
    name: "Local",
    advertiseScope: "mesh",
    brokerUrl: "http://local.test",
    capabilities: ["broker"],
    registeredAt: 1,
    lastSeenAt: 1,
    ...input,
  };
}

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
    handle: "agent-1",
    selector: "@agent-1",
    defaultSelector: "@agent-1",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "mesh",
    ...input,
  };
}

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-local",
    harness: "codex",
    transport: "tmux",
    state: "offline",
    projectRoot: "/repo",
    metadata: {},
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
    metadata: {},
    ...input,
  };
}

function binding(input: Partial<ConversationBinding> = {}): ConversationBinding {
  return {
    id: "binding-1",
    conversationId: "conversation-1",
    actorId: "agent-1",
    role: "participant",
    joinedAt: 1,
    ...input,
  };
}

function message(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-local",
    class: "person",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: 1,
    ...input,
  };
}

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-local",
    targetAgentId: "agent-1",
    action: "consult",
    task: "work",
    ensureAwake: true,
    stream: false,
    createdAt: 1,
    ...input,
  };
}

function flight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    targetAgentId: "agent-1",
    state: "queued",
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

function delivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "message-1",
    targetId: "agent-1",
    targetKind: "agent",
    transport: "local_socket",
    reason: "direct_message",
    policy: "best_effort",
    status: "pending",
    ...input,
  };
}

function workItem(input: Partial<CollaborationRecord> = {}): CollaborationRecord {
  return {
    id: "work-1",
    kind: "work_item",
    state: "working",
    acceptanceState: "none",
    title: "Investigate mesh",
    createdById: "operator",
    ownerId: "agent-a",
    nextMoveOwnerId: "agent-b",
    requestedById: "operator",
    conversationId: "conversation-1",
    createdAt: 1,
    updatedAt: 1,
    ...input,
  } as CollaborationRecord;
}

function collaborationEvent(input: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    id: "event-1",
    recordId: "work-1",
    recordKind: "work_item",
    kind: "progressed",
    actorId: "agent-a",
    at: 2,
    ...input,
  };
}

function createHarness(input: {
  snapshot?: RuntimeRegistrySnapshot;
  invocations?: InvocationRequest[];
  forwardMessage?: BrokerMeshForwardingServiceDeps["forwardMessage"];
  forwardCollaborationRecord?: BrokerMeshForwardingServiceDeps["forwardCollaborationRecord"];
  forwardCollaborationEvent?: BrokerMeshForwardingServiceDeps["forwardCollaborationEvent"];
  postJson?: BrokerMeshForwardingServiceDeps["postJson"];
  now?: () => number;
} = {}) {
  const snapshot = input.snapshot ?? createRuntimeRegistrySnapshot();
  const invocations = new Map((input.invocations ?? []).map((item) => [item.id, item]));
  const service = new BrokerMeshForwardingService({
    nodeId: "node-local",
    runtime: {
      peek: () => snapshot,
      conversation: (conversationId) => snapshot.conversations[conversationId],
      node: (nodeId) => snapshot.nodes[nodeId],
      agent: (agentId) => snapshot.agents[agentId],
      collaborationRecord: (recordId) => snapshot.collaborationRecords[recordId],
      bindingsForConversation: (conversationId) =>
        Object.values(snapshot.bindings).filter((item) => item.conversationId === conversationId),
    },
    currentLocalNode: () => snapshot.nodes["node-local"] ?? node(),
    invocationFor: (invocationId) => invocations.get(invocationId),
    endpointForAgent: (agentId) =>
      Object.values(snapshot.endpoints).find((item) => item.agentId === agentId) ?? null,
    projectRootForTarget: (_agent, candidate) => candidate?.projectRoot ?? candidate?.cwd ?? null,
    forwardMessage: input.forwardMessage,
    forwardCollaborationRecord: input.forwardCollaborationRecord,
    forwardCollaborationEvent: input.forwardCollaborationEvent,
    postJson: input.postJson,
    now: input.now,
  });

  return { service, snapshot };
}

describe("broker mesh forwarding helpers", () => {
  test("recognizes HTTP and supported Iroh mesh reachability", () => {
    expect(isReachableMeshNode(node({ brokerUrl: "http://peer.test" }))).toBe(true);
    expect(isReachableRemoteBrokerUrl("http://192.168.18.22:43110")).toBe(true);
    expect(isReachableRemoteBrokerUrl("https://peer.example.test")).toBe(true);
    expect(isReachableRemoteBrokerUrl("http://0.0.0.0:43110")).toBe(false);
    expect(isReachableRemoteBrokerUrl("http://[::]:43110")).toBe(false);
    expect(isReachableRemoteBrokerUrl("http://127.0.0.42:43110")).toBe(false);
    expect(isReachableRemoteBrokerUrl("http://localhost:43110")).toBe(false);
    expect(isReachableRemoteBrokerUrl("not a URL")).toBe(false);
    // Sibling brokers on one machine stay reachable mesh nodes; wildcard
    // listen addresses and non-http(s) schemes never do.
    expect(isReachableMeshNode(node({ brokerUrl: "http://127.0.0.1:43111" }))).toBe(true);
    expect(isReachableMeshNode(node({ brokerUrl: "http://0.0.0.0:43110" }))).toBe(false);
    expect(isReachableMeshNode(node({ brokerUrl: "ws://peer.test" }))).toBe(false);
    expect(hasReachableMeshEntrypoint(node({
      brokerUrl: undefined,
      meshEntrypoints: [{
        kind: "iroh",
        endpointId: "endpoint-1",
        endpointAddr: {},
        alpn: OPENSCOUT_IROH_MESH_ALPN,
        bridgeProtocolVersion: OPENSCOUT_MESH_PROTOCOL_VERSION,
      }],
    }))).toBe(true);
    expect(isReachableMeshNode(node({ brokerUrl: undefined, meshEntrypoints: [] }))).toBe(false);
  });

  test("classifies stale mesh authority nodes from last-seen timestamps", () => {
    const now = 10 * STALE_MESH_AUTHORITY_NODE_MS;
    expect(isStaleMeshAuthorityNode(node({ lastSeenAt: now - STALE_MESH_AUTHORITY_NODE_MS - 1 }), { now })).toBe(true);
    expect(isStaleMeshAuthorityNode(node({ lastSeenAt: now - 1000 }), { now })).toBe(false);
    expect(isStaleMeshAuthorityNode(undefined, { now })).toBe(false);
  });

  test("describes unavailable and stale remote authority targets", () => {
    const remoteAgent = agent({
      id: "agent-remote",
      displayName: "Remote Agent",
      authorityNodeId: "node-peer",
      homeNodeId: "node-peer",
    });
    const { service, snapshot } = createHarness({
      now: () => 10 * STALE_MESH_AUTHORITY_NODE_MS,
      snapshot: createRuntimeRegistrySnapshot({
        agents: { [remoteAgent.id]: remoteAgent },
        endpoints: {
          "endpoint-remote": endpoint({
            id: "endpoint-remote",
            agentId: remoteAgent.id,
            state: "offline",
            transport: "tmux",
            projectRoot: "/remote",
          }),
        },
      }),
    });

    const missing = service.describeRemoteAuthorityIssue(remoteAgent, undefined);
    expect(missing).toEqual(expect.objectContaining({
      agentId: remoteAgent.id,
      endpointState: "offline",
      projectRoot: "/remote",
    }));
    expect(missing?.detail).toContain("no reachable broker URL or mesh entrypoint");

    snapshot.nodes["node-peer"] = node({
      id: "node-peer",
      name: "Peer",
      brokerUrl: "http://peer.test",
      lastSeenAt: 1,
    });
    const stale = service.describeRemoteAuthorityIssue(remoteAgent, snapshot.nodes["node-peer"]);
    expect(stale?.detail).toContain("has not been seen recently");

    snapshot.nodes["node-peer"] = node({
      id: "node-peer",
      brokerUrl: "http://peer.test",
      lastSeenAt: 10 * STALE_MESH_AUTHORITY_NODE_MS,
    });
    expect(service.describeRemoteAuthorityIssue(remoteAgent, snapshot.nodes["node-peer"])).toBeNull();
    expect(service.describeRemoteAuthorityIssue(agent({ authorityNodeId: "node-local" }), snapshot.nodes["node-peer"])).toBeNull();
  });

  test("includes bindings when forwarding a conversation message to its authority", async () => {
    const localNode = node();
    const peerNode = node({ id: "node-peer", name: "Peer", brokerUrl: "http://peer.test" });
    const remoteConversation = conversation({ authorityNodeId: peerNode.id });
    const localActor = actor();
    const remoteAgent = agent({ authorityNodeId: peerNode.id, homeNodeId: peerNode.id });
    const snapshot = createRuntimeRegistrySnapshot({
      nodes: { [localNode.id]: localNode, [peerNode.id]: peerNode },
      actors: { [localActor.id]: localActor, [remoteAgent.id]: remoteAgent },
      agents: { [remoteAgent.id]: remoteAgent },
      conversations: { [remoteConversation.id]: remoteConversation },
      bindings: { "binding-1": binding() },
    });
    const forwarded: Array<{ target: NodeDefinition; bundle: unknown }> = [];
    const { service } = createHarness({
      snapshot,
      forwardMessage: async (target, bundle) => {
        forwarded.push({ target: target as NodeDefinition, bundle });
        return { ok: true, duplicate: true, message: message(), deliveries: [delivery()] };
      },
    });

    const result = await service.forwardConversationMessageToAuthority(message());

    expect(result).toEqual(expect.objectContaining({
      forwarded: true,
      authorityNodeId: peerNode.id,
      duplicate: true,
      message: message(),
      deliveries: [expect.objectContaining({ id: "delivery-1" })],
    }));
    expect(forwarded[0]?.target.id).toBe(peerNode.id);
    expect(forwarded[0]?.bundle).toEqual(expect.objectContaining({
      originNode: localNode,
      bindings: [expect.objectContaining({ id: "binding-1" })],
    }));
  });

  test("posts flight updates only to HTTP authority nodes", async () => {
    const localNode = node();
    const peerNode = node({ id: "node-peer", brokerUrl: "http://peer.test" });
    const remoteConversation = conversation({ authorityNodeId: peerNode.id });
    const posts: Array<{ baseUrl: string; path: string; payload: unknown }> = [];
    const { service, snapshot } = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        nodes: { [localNode.id]: localNode, [peerNode.id]: peerNode },
        conversations: { [remoteConversation.id]: remoteConversation },
      }),
      invocations: [invocation({ conversationId: remoteConversation.id })],
      postJson: async (baseUrl, path, payload) => {
        posts.push({ baseUrl, path, payload });
        return { ok: true };
      },
    });

    await service.maybeForwardFlightToAuthority(flight());
    expect(posts).toEqual([{ baseUrl: "http://peer.test", path: "/v1/mesh/flights", payload: flight() }]);

    posts.length = 0;
    snapshot.nodes["node-peer"] = node({
      id: "node-peer",
      brokerUrl: undefined,
      meshEntrypoints: [{
        kind: "iroh",
        endpointId: "endpoint-1",
        endpointAddr: {},
        alpn: OPENSCOUT_IROH_MESH_ALPN,
        bridgeProtocolVersion: OPENSCOUT_MESH_PROTOCOL_VERSION,
      }],
    });
    await service.maybeForwardFlightToAuthority(flight());
    expect(posts).toEqual([]);

    snapshot.nodes["node-peer"] = node({
      id: "node-peer",
      brokerUrl: "http://0.0.0.0:43110",
    });
    await service.maybeForwardFlightToAuthority(flight());
    expect(posts).toEqual([]);
  });

  test("fans shared collaboration records to reachable peer authorities", async () => {
    const localNode = node();
    const peerA = node({ id: "node-a", brokerUrl: "http://a.test" });
    const peerB = node({ id: "node-b", brokerUrl: undefined, meshEntrypoints: [] });
    const peerC = node({ id: "node-c", brokerUrl: "http://c.test" });
    const record = workItem();
    const snapshot = createRuntimeRegistrySnapshot({
      nodes: { [localNode.id]: localNode, [peerA.id]: peerA, [peerB.id]: peerB, [peerC.id]: peerC },
      actors: { operator: actor() },
      agents: {
        "agent-a": agent({ id: "agent-a", authorityNodeId: peerA.id, homeNodeId: peerA.id }),
        "agent-b": agent({ id: "agent-b", authorityNodeId: peerB.id, homeNodeId: peerB.id }),
        "agent-c": agent({ id: "agent-c", authorityNodeId: peerC.id, homeNodeId: peerC.id }),
      },
      conversations: {
        "conversation-1": conversation({ participantIds: ["operator", "agent-a", "agent-c"] }),
      },
      collaborationRecords: { [record.id]: record },
    });
    const forwardedTargets: string[] = [];
    const { service } = createHarness({
      snapshot,
      forwardCollaborationRecord: async (target) => {
        const targetId = (target as NodeDefinition).id;
        forwardedTargets.push(targetId);
        if (targetId === peerC.id) {
          throw new Error("peer rejected");
        }
        return { ok: true };
      },
    });

    expect(actorIdsForCollaboration(record, snapshot.conversations["conversation-1"])).toEqual([
      "operator",
      "agent-a",
      "agent-b",
      "agent-c",
    ]);

    await expect(service.forwardPeerBrokerCollaborationRecord(record)).resolves.toEqual({
      forwarded: [peerA.id],
      failed: [peerB.id, peerC.id],
    });
    expect(forwardedTargets).toEqual([peerA.id, peerC.id]);
  });

  test("fans shared collaboration events through their records", async () => {
    const localNode = node();
    const peerA = node({ id: "node-a", brokerUrl: "http://a.test" });
    const record = workItem({ ownerId: "agent-a", nextMoveOwnerId: "agent-a" });
    const event = collaborationEvent({ recordId: record.id });
    const snapshot = createRuntimeRegistrySnapshot({
      nodes: { [localNode.id]: localNode, [peerA.id]: peerA },
      actors: { operator: actor() },
      agents: {
        "agent-a": agent({ id: "agent-a", authorityNodeId: peerA.id, homeNodeId: peerA.id }),
      },
      conversations: {
        "conversation-1": conversation({ participantIds: ["operator", "agent-a"] }),
      },
      collaborationRecords: { [record.id]: record },
    });
    const forwardedTargets: string[] = [];
    const { service } = createHarness({
      snapshot,
      forwardCollaborationEvent: async (target) => {
        forwardedTargets.push((target as NodeDefinition).id);
        return { ok: true, duplicate: true };
      },
    });

    await expect(service.forwardPeerBrokerCollaborationEvent(event)).resolves.toEqual({
      forwarded: [peerA.id],
      failed: [],
    });
    expect(forwardedTargets).toEqual([peerA.id]);
  });
});
