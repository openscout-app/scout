import { PermissionDeliveryUnconfirmedError } from "./broker-permission-service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerRequestReceipts } from "./broker-request-receipts.js";
import { BrokerIntegrationSetupService } from "./broker-integration-setup.js";
import { ChatQuestionError } from "./chat-question-transition.js";
import { clearOperatorTitle, markOperatorTitled } from "./conversation-title.js";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { ConversationDefinition, TrustedPeerRecord } from "@openscout/protocol";

import {
  createBrokerHttpRouter,
  type BrokerHttpRouterDeps,
} from "./broker-http-router.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { nodeFingerprint, nodeKeyId } from "./node-identity.js";
import { createRuntimeRegistrySnapshot, queryRuntimeNotificationRouting } from "./registry.js";
import {
  TrustEndpointRateLimiter,
  TrustEnrollmentService,
} from "./mesh-trust-enrollment.js";

class FakeResponse extends EventEmitter {
  body = "";
  destroyed = false;
  headers: Record<string, string> | undefined;
  status: number | undefined;
  writableEnded = false;

  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string): void {
    this.body += chunk;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
    this.writableEnded = true;
  }
}

type Harness = {
  conversations: Record<string, ConversationDefinition>;
  conversationWrites: ConversationDefinition[];
  cursorBodies: unknown[];
  deliverCalls: Array<{ payload: unknown; signal?: AbortSignal }>;
  invocationCalls: unknown[];
  deps: BrokerHttpRouterDeps;
  routed: ReturnType<typeof createBrokerHttpRouter>;
};

function createHarness(overrides: Partial<BrokerHttpRouterDeps> = {}): Harness {
  const conversations: Record<string, ConversationDefinition> = {};
  const conversationWrites: ConversationDefinition[] = [];
  const cursorBodies: unknown[] = [];
  const deliverCalls: Array<{ payload: unknown; signal?: AbortSignal }> = [];
  const invocationCalls: unknown[] = [];
  const node = {
    id: "node-1",
    name: "Node 1",
    meshId: "mesh-1",
    endpoints: [],
    lastSeenAt: 1,
  };
  const cursor = {
    conversationId: "conversation-1",
    actorId: "agent-1",
    lastReadAt: 100,
    updatedAt: 100,
  };
  const deps = {
    host: "127.0.0.1",
    port: 43110,
    nodeId: "node-1",
    meshId: "mesh-1",
    operatorActorId: "operator",
    runtime: {
      snapshot: () => ({ nodes: { [node.id]: node }, conversations }),
      recentEvents: (limit: number) => [{ id: "evt-1", limit }],
      collaborationRecord: () => undefined,
      flightForInvocation: () => undefined,
      deleteEndpoint: () => {},
      upsertAgentIdentity: () => {},
      upsertEndpoint: () => {},
    },
    journal: {
      listDeliveries: () => [],
      listScoutDispatches: () => [],
    },
    knownInvocations: new Map(),
    brokerService: {
      baseUrl: "http://broker.test",
      readHealth: async () => ({ ok: true, nodeId: "node-1", meshId: "mesh-1" }),
      readNode: async () => node,
      readSnapshot: async () => ({ nodes: { [node.id]: node } }),
      executeCommand: async () => ({ ok: true }),
      deliver: async (payload: unknown, options?: { signal?: AbortSignal }) => {
        deliverCalls.push({ payload, signal: options?.signal });
        return { kind: "delivery", deliveryId: "delivery-1" };
      },
    },
    webControl: {
      corsHeaders: () => ({ "access-control-allow-origin": "http://app.test" }),
      status: async () => ({ ok: true }),
      startIfNeeded: async () => ({ ok: true }),
      restartIfManaged: async () => ({ ok: true }),
      startContextFromRequest: () => ({ from: "test" }),
      failureStatus: (error: unknown) => ({ ok: false, detail: String(error) }),
    },
    a2aService: {
      agentCardForRequest: async () => ({ name: "OpenScout" }),
      handleJsonRpc: async () => ({ jsonrpc: "2.0", id: null, result: {} }),
      listScoutAgentCards: async () => [],
    },
    brokerRepoTailService: {
      warmRepoWatchSnapshot: () => {},
      readRepoWatchSnapshotForUrl: async () => ({ ok: true }),
      readTailRecentPayloadWithTiming: async () => ({
        payload: { generatedAt: 1, limit: 0, cursor: null, events: [] },
        timings: [],
      }),
      readTailRecentPayload: async () => ({ generatedAt: 1, limit: 0, cursor: null, events: [] }),
    },
    getHarnessTopologySnapshot: async () => ({ nodes: [] }),
    getTailDiscovery: async () => ({ tails: [] }),
    nudgeHarnessTopologyScan: async () => ({ ok: true }),
    deliveryHttpService: {
      readInboxItems: async () => [],
      readInboxSnapshot: async () => ({ targetId: "agent-1", items: [] }),
      claimInboxItem: async () => ({ ok: true, claimed: null }),
      acknowledgeInboxItem: async () => ({ status: 200, body: { ok: true } }),
      nackInboxItem: async () => ({ status: 200, body: { ok: true } }),
      listDeliveries: () => [],
      claimDelivery: async () => ({ ok: true, claimed: null }),
      listDeliveryAttempts: () => [],
      recordDeliveryAttempt: async () => ({ ok: true }),
      updateDeliveryStatus: async () => ({ ok: true }),
    },
    durableActionHttpService: {
      recordAction: async () => ({ ok: true, actionId: "action-1" }),
      heartbeat: async () => ({ status: 200, body: { ok: true } }),
    },
    controlStreams: {
      addInboxStream: () => {},
      addInvocationStream: () => {},
      addEventStream: () => {},
    },
    managedSessionHttpService: {
      listPairingSessionCandidates: async () => [],
      attachPairingSession: async () => ({ ok: true }),
      detachPairingSession: async () => ({ ok: true }),
      attachLocalSession: async () => ({ ok: true }),
      ensureLocalSession: async () => ({ ok: true }),
      detachLocalSession: async () => ({ ok: true }),
    },
    meshDiscoveryService: {
      discoverPeers: async () => ({ discovered: [], probes: [] }),
    },
    meshHttpService: {
      receiveMessageBundle: async () => ({ status: 200, body: { ok: true } }),
      receiveInvocationBundle: async () => ({ status: 200, body: { ok: true } }),
      receiveCollaborationRecordBundle: async () => ({ status: 200, body: { ok: true } }),
      receiveCollaborationEventBundle: async () => ({ status: 200, body: { ok: true } }),
    },
    threadEvents: {
      streamWatch: async () => {},
    },
    handleCommand: async () => ({ ok: true }),
    handleInvocationRequest: async (payload: unknown) => {
      invocationCalls.push(payload);
      return { ok: true };
    },
    recordFlight: async () => {},
    listReadCursorsForConversation: () => [cursor],
    resolveReadCursor: async (_conversationId: string, body: unknown) => {
      cursorBodies.push(body);
      return cursor;
    },
    recordReadCursor: async () => {},
    setConversationTitle: async (conversationId: string, named: string) => {
      const current = conversations[conversationId];
      if (!current) return null;
      const conversation = { ...current, title: named || current.title,
        metadata: named ? markOperatorTitled(current.metadata, Date.now()) : clearOperatorTitle(current.metadata) };
      conversationWrites.push(conversation);
      conversations[conversation.id] = conversation;
      return conversation;
    },
    acknowledgeDeliveriesForReadCursor: async () => ["delivery-1"],
    deliveryAcceptanceService: {
      accept: async () => ({ kind: "delivery", deliveryId: "fallback-delivery" }),
    },
    rendezvousService: {
      match: async (request: { topic: string; projectRoot: string; participantId: string }) => ({
        status: "waiting",
        topic: request.topic,
        projectRoot: request.projectRoot,
        participantId: request.participantId,
        joinedAt: 1,
        expiresAt: 2,
      }),
    },
    ...overrides,
  } as unknown as BrokerHttpRouterDeps;

  return {
    conversations,
    conversationWrites,
    cursorBodies,
    deliverCalls,
    invocationCalls,
    deps,
    routed: createBrokerHttpRouter(deps),
  };
}

async function requestRouter(
  harness: Harness,
  method: string,
  path: string,
  options: {
    body?: unknown;
    beforeBody?: () => Promise<void>;
    rawBody?: string;
    transportContext?: { transport: "unix-socket" | "loopback" | "remote"; remoteAddress?: string };
  } = {},
): Promise<{ body: unknown; rawBody: string; response: FakeResponse }> {
  const request = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    method: string;
    url: string;
    transportContext?: { transport: "unix-socket" | "loopback" | "remote"; remoteAddress?: string };
  };
  request.headers = { host: "broker.test" };
  request.method = method;
  request.url = path;
  if (options.transportContext) {
    request.transportContext = options.transportContext;
  }
  const response = new FakeResponse();

  const routed = harness.routed(request as never, response as never);
  await options.beforeBody?.();
  if (options.rawBody !== undefined) {
    request.end(options.rawBody);
  } else if (options.body !== undefined) {
    request.end(JSON.stringify(options.body));
  } else {
    request.end();
  }
  await routed;

  return {
    body: response.body ? JSON.parse(response.body) : null,
    rawBody: response.body,
    response,
  };
}

describe("createBrokerHttpRouter", () => {
  test("node-state forwards optional projectRoot/agentId filters and preserves unfiltered GET", async () => {
    const harness = createHarness();
    const queries: unknown[] = [];
    harness.deps.brokerService.readMeshNodeState = (query) => {
      queries.push(query);
      return { kind: "mesh-node-state" };
    };
    const scoped = await requestRouter(harness, "GET", "/v1/mesh/node-state?projectRoot=%2Fwork%2Fmy%20project&agentId=agent-2");
    expect(scoped.response.status).toBe(200);
    expect(queries[0]).toEqual({ projectRoot: "/work/my project", agentId: "agent-2" });
    const unscoped = await requestRouter(harness, "GET", "/v1/mesh/node-state");
    expect(unscoped.response.status).toBe(200);
    expect(queries[1]).toEqual({});
  });

  test("requestId dedupes ask/send acceptance at the broker and exposes the original receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "broker-keyed-deliver-"));
    const harness = createHarness({ requestReceipts: new BrokerRequestReceipts(directory) });
    const payload = { requestId: "scoutbot-key", caller: { actorId: "scoutbot", nodeId: "node-1" }, body: "build", intent: "consult" };
    try {
      const first = await requestRouter(harness, "POST", "/v1/deliver", { body: payload });
      const again = await requestRouter(harness, "POST", "/v1/deliver", { body: payload });
      expect(first.response.status).toBe(202);
      expect(again.body).toEqual(first.body);
      expect(harness.deliverCalls).toHaveLength(1);
      expect(harness.deliverCalls[0]!.payload).toMatchObject({ caller: { actorId: "scoutbot" }, messageMetadata: { requestId: "scoutbot-key" }, invocationMetadata: { requestId: "scoutbot-key" } });
      const receipt = await requestRouter(harness, "GET", "/v1/request-receipts/scoutbot-key?requesterId=scoutbot&operation=deliver");
      expect(receipt.body).toMatchObject({ receipt: { state: "done", requesterId: "scoutbot", result: first.body } });
      const conflict = await requestRouter(harness, "POST", "/v1/deliver", { body: { ...payload, body: "other task" } });
      expect(conflict.response.status).toBe(400);
      expect(harness.deliverCalls).toHaveLength(1);
      const reopen = createHarness({ requestReceipts: new BrokerRequestReceipts(directory) });
      expect((await requestRouter(reopen, "POST", "/v1/deliver", { body: payload })).body).toEqual(first.body);
      expect(reopen.deliverCalls).toHaveLength(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });


  test("receipt observation capacity returns retryable pressure without a reservation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "broker-receipt-read-capacity-"));
    try {
      const harness = createHarness({ requestReceipts: new BrokerRequestReceipts(directory, { maxOperations: 0 }) });
      const result = await requestRouter(harness, "GET", "/v1/request-receipts/key?requesterId=operator");
      expect(result.response.status).toBe(503);
      expect(result.body).toMatchObject({ error: "broker_busy", retryable: true });
      expect(harness.deliverCalls).toHaveLength(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("question response route preserves version conflicts and rejects malformed identity", async () => {
    const calls: unknown[] = [];
    const harness = createHarness({ respondToChatQuestion: async (...args) => {
      calls.push(args);
      throw new ChatQuestionError(409, "This question changed.");
    } });
    const path = "/v1/conversations/channel/questions/question/respond";
    const conflict = await requestRouter(harness, "POST", path, { body: { actorId: "maya", isOperator: false, change: { action: "close", expectedUpdatedAt: 2 } } });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toEqual({ error: "This question changed.", status: 409 });
    expect(calls).toEqual([["channel", "question", "maya", false, { action: "close", expectedUpdatedAt: 2 }]]);
    const malformed = await requestRouter(harness, "POST", path, { body: { actorId: "maya", change: {} } });
    expect(malformed.response.status).toBe(400);
    expect(calls).toHaveLength(1);
  });


  function seedConversation(harness: Harness): ConversationDefinition {
    const conversation: ConversationDefinition = {
      id: "conversation-rename",
      kind: "direct",
      title: "Derived title",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", "agent-1"],
      metadata: { surface: "broker", naturalKey: "direct:agent-1,operator" },
    };
    harness.conversations[conversation.id] = conversation;
    return conversation;
  }

  test("conversation title HTTP rename waits for the durable writer before success", async () => {
    let releaseWrite!: () => void;
    let enteredWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { enteredWrite = resolve; });
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const harness = createHarness({
      setConversationTitle: async (conversationId, named) => {
        enteredWrite();
        await writeReleased;
        const current = harness.conversations[conversationId];
        if (!current) return null;
        const conversation = { ...current, title: named || current.title,
          metadata: markOperatorTitled(current.metadata, Date.now()) };
        harness.conversationWrites.push(conversation);
        harness.conversations[conversation.id] = conversation;
        return conversation;
      },
    });
    const original = seedConversation(harness);
    let completed = false;
    const request = requestRouter(harness, "POST", "/v1/conversations/conversation-rename/title", {
      body: { title: "  Terminal polish  " },
    }).then((result) => { completed = true; return result; });
    try {
      await writeStarted;
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(harness.conversations[original.id]).toBe(original);
    } finally {
      releaseWrite();
    }
    const result = await request;
    expect(result.response.status).toBe(200);
    expect(harness.conversationWrites).toHaveLength(1);
    const persisted = harness.conversationWrites[0]!;
    expect(persisted).toMatchObject({
      ...original,
      title: "Terminal polish",
      metadata: { ...original.metadata, titleSource: "operator", titleSetAt: expect.any(Number) },
    });
    expect(original.title).toBe("Derived title");
    expect(original.metadata).not.toHaveProperty("titleSource");
    expect(result.body).toEqual({ ok: true, conversation: persisted, titled: true });
  });

  test("conversation title HTTP retains coordination changes made while its body is pending", async () => {
    const harness = createHarness();
    const original = seedConversation(harness);
    const changed: ConversationDefinition = { ...original, participantIds: [...original.participantIds, "new-agent"],
      shareMode: "shared", metadata: { ...original.metadata, routingEpoch: 2 } };
    const result = await requestRouter(harness, "POST", "/v1/conversations/conversation-rename/title", {
      body: { title: "Current title" },
      beforeBody: async () => { harness.conversations[original.id] = changed; },
    });
    expect(result.response.status).toBe(200);
    expect(harness.conversationWrites[0]).toMatchObject({ ...changed, title: "Current title",
      metadata: { ...changed.metadata, titleSource: "operator" } });
  });

  test("conversation title HTTP clear preserves text and unrelated metadata", async () => {
    const harness = createHarness();
    const original = seedConversation(harness);
    original.title = "Operator title";
    original.metadata = { ...original.metadata, titleSource: "operator", titleSetAt: 123 };
    const result = await requestRouter(harness, "POST", "/v1/conversations/conversation-rename/title", {
      body: { title: "" },
    });
    expect(result.response.status).toBe(200);
    expect(harness.conversationWrites).toHaveLength(1);
    const persisted = harness.conversationWrites[0]!;
    expect(persisted.title).toBe("Operator title");
    expect(persisted.metadata).toEqual({ surface: "broker", naturalKey: "direct:agent-1,operator" });
    expect(persisted.participantIds).toEqual(original.participantIds);
    expect(result.body).toEqual({ ok: true, conversation: persisted, titled: false });
  });

  test("conversation title HTTP returns 404 without writing an unknown conversation", async () => {
    const harness = createHarness();
    const result = await requestRouter(harness, "POST", "/v1/conversations/missing/title", {
      body: { title: "Do not create" },
    });
    expect(result.response.status).toBe(404);
    expect(result.body).toEqual({ error: "unknown conversation", conversationId: "missing" });
    expect(harness.conversationWrites).toEqual([]);
    expect(harness.conversations).toEqual({});
  });

  test("conversation title HTTP never reports success when persistence fails", async () => {
    const harness = createHarness({
      setConversationTitle: async () => { throw new Error("journal write failed"); },
    });
    const original = seedConversation(harness);
    const result = await requestRouter(harness, "POST", "/v1/conversations/conversation-rename/title", {
      body: { title: "Unpersisted" },
    });
    expect(result.response.status).not.toBe(200);
    expect(result.body).not.toMatchObject({ ok: true });
    expect(harness.conversations[original.id]).toBe(original);
    expect(original.title).toBe("Derived title");
  });


  test("passes snapshot cutoffs to the broker service", async () => {
    const queries: unknown[] = [];
    const harness = createHarness({
      brokerService: {
        ...createHarness().deps.brokerService,
        readSnapshot: async (query) => {
          queries.push(query);
          return { nodes: {} } as never;
        },
      },
    });

    const result = await requestRouter(
      harness,
      "GET",
      "/v1/snapshot?since=1234&scope=conversations",
    );

    expect(result.response.status).toBe(200);
    expect(queries).toEqual([{ since: 1234, scope: "conversations" }]);
  });

  test("forces mesh snapshot reads to the agents-only scope", async () => {
    const queries: unknown[] = [];
    const harness = createHarness({
      brokerService: {
        ...createHarness().deps.brokerService,
        readSnapshot: async (query) => {
          queries.push(query);
          return { agents: {} } as never;
        },
      },
    });

    const results = await Promise.all([
      requestRouter(harness, "GET", "/v1/mesh/snapshot?scope=agents"),
      requestRouter(harness, "GET", "/v1/mesh/snapshot"),
      requestRouter(harness, "GET", "/v1/mesh/snapshot?scope=conversations"),
    ]);

    expect(results.map((result) => result.response.status)).toEqual([200, 200, 200]);
    expect(queries).toEqual([
      { since: null, scope: "agents" },
      { since: null, scope: "agents" },
      { since: null, scope: "agents" },
    ]);
  });

  test("notification routing is metadata-only, machine-local, and absent on older services", async () => {
    const snapshot = createRuntimeRegistrySnapshot({ conversations: { old: {
      id: "old", title: "Old operator thread", kind: "direct", participantIds: ["builder", "operator"], authorityNodeId: "node-1",
      visibility: "private", shareMode: "local", metadata: { createdAt: 1000, updatedAt: 1000 },
    } } });
    Object.defineProperty(snapshot, "messages", { get: () => { throw new Error("must not read history"); } });
    const harness = createHarness({ brokerService: {
      ...createHarness().deps.brokerService,
      readSnapshot: async () => { throw new Error("must not fall back to snapshot"); },
      readNotificationRouting: async () => queryRuntimeNotificationRouting(snapshot),
    } });
    const local = await requestRouter(harness, "GET", "/v1/notification-routing");
    expect(local.response.status).toBe(200);
    expect(local.body).toEqual({ conversations: { old: { id: "old", title: "Old operator thread", participantIds: ["builder", "operator"] } }, invocations: {} });
    const remote = await requestRouter(harness, "GET", "/v1/notification-routing", { transportContext: { transport: "remote" } as never });
    expect(remote.response.status).toBe(403);
    const older = await requestRouter(createHarness(), "GET", "/v1/notification-routing");
    expect(older.response.status).toBe(404);
  });

  test("serves the bounded conversation projection without reading the registry snapshot", async () => {
    const queries: unknown[] = [];
    const harness = createHarness({
      brokerService: {
        ...createHarness().deps.brokerService,
        readConversationProjection: async (query) => {
          queries.push(query);
          return {
            projectionId: "projection-1",
            projectionVersion: 1,
            sequence: 7,
            generatedAt: 10,
            sourceFreshAt: null,
            items: [],
            total: 0,
            hasMore: false,
            engagedFeedId: null,
            identityRedirects: [],
          };
        },
      },
    });

    const result = await requestRouter(
      harness,
      "GET",
      "/v1/conversation-projection?limit=160",
    );

    expect(result.response.status).toBe(200);
    expect(queries).toEqual([{ limit: 160 }]);
    expect(result.body).toMatchObject({ projectionId: "projection-1", sequence: 7 });
  });

  test("forwards scoped alias writes to the authoritative broker without touching the local store", async () => {
    const forwards: Array<{ nodeSelector: string; path: string; method: string; body?: unknown }> = [];
    const harness = createHarness({
      routeAliasService: {} as BrokerHttpRouterDeps["routeAliasService"],
      forwardRouteAliasRequest: async (input) => {
        forwards.push(input);
        return { status: 201, body: { binding: { id: "alias-remote", revision: 1 } } };
      },
    });

    const result = await requestRouter(harness, "POST", "/v1/aliases", {
      body: {
        alias: "review",
        scope: { projectRoot: "/work/alpha", nodeId: "node-remote" },
        target: { kind: "agent_id", agentId: "agent-remote" },
        caller: { actorId: "operator", currentDirectory: "/work/alpha" },
      },
    });

    expect(result.response.status).toBe(201);
    expect(result.body).toEqual({ binding: { id: "alias-remote", revision: 1 } });
    expect(forwards).toEqual([expect.objectContaining({
      nodeSelector: "node-remote",
      path: "/v1/aliases",
      method: "POST",
      body: expect.objectContaining({ alias: "review" }),
    })]);
  });

  test("forwards host-qualified alias delivery wholesale so exact remote sessions resolve at authority", async () => {
    const forwards: Array<{ nodeSelector: string; path: string; method: string; body?: unknown }> = [];
    const harness = createHarness({
      forwardRouteAliasRequest: async (input) => {
        forwards.push(input);
        return { status: 202, body: { kind: "delivery", accepted: true, aliasResolution: { bindingId: "alias-remote", revision: 3 } } };
      },
    });

    const result = await requestRouter(harness, "POST", "/v1/deliver", {
      body: {
        body: "continue exactly there",
        intent: "consult",
        target: { kind: "route_alias", alias: "patch", scope: { projectRoot: "/work/alpha", nodeId: "node-remote" } },
      },
    });

    expect(result.response.status).toBe(202);
    expect(result.body).toEqual(expect.objectContaining({
      kind: "delivery",
      aliasResolution: { bindingId: "alias-remote", revision: 3 },
    }));
    expect(forwards).toEqual([expect.objectContaining({
      nodeSelector: "node-remote",
      path: "/v1/deliver",
      method: "POST",
    })]);
    expect(harness.deliverCalls).toEqual([]);
  });

  test("routes common JSON responses and CORS preflight without daemon state", async () => {
    const harness = createHarness();

    const health = await requestRouter(harness, "GET", "/health");
    expect(health.response.status).toBe(200);
    expect(health.body).toEqual({ ok: true, nodeId: "node-1", meshId: "mesh-1" });

    const preflight = await requestRouter(harness, "OPTIONS", "/v1/web/status");
    expect(preflight.response.status).toBe(204);
    expect(preflight.response.headers).toEqual({
      "access-control-allow-origin": "http://app.test",
    });
    expect(preflight.rawBody).toBe("");

    const missing = await requestRouter(harness, "GET", "/missing");
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: "not_found" });
  });

  test("maps deliver outcomes onto transport status codes and passes an abort signal", async () => {
    const outcomes = [
      { kind: "delivery", deliveryId: "delivery-1" },
      { kind: "question", questionId: "question-1" },
      { kind: "unavailable", detail: "offline" },
    ];
    const harness = createHarness({
      brokerService: {
        ...createHarness().deps.brokerService,
        deliver: async (payload: unknown, options?: { signal?: AbortSignal }) => {
          harness.deliverCalls.push({ payload, signal: options?.signal });
          return outcomes.shift();
        },
      },
    } as Partial<BrokerHttpRouterDeps>);

    const delivery = await requestRouter(harness, "POST", "/v1/deliver", {
      body: { target: "agent-1", body: "hello", intent: "tell" },
    });
    const question = await requestRouter(harness, "POST", "/v1/deliver", {
      body: { target: "agent-2", body: "need input", intent: "tell" },
    });
    const unavailable = await requestRouter(harness, "POST", "/v1/deliver", {
      body: { target: "agent-3", body: "wake", intent: "tell" },
    });

    expect(delivery.response.status).toBe(202);
    expect(question.response.status).toBe(409);
    expect(unavailable.response.status).toBe(422);
    expect(harness.deliverCalls).toHaveLength(3);
    expect(harness.deliverCalls[0]?.payload).toEqual({
      target: "agent-1",
      body: "hello",
      intent: "tell",
    });
    expect(harness.deliverCalls[0]?.signal).toBeInstanceOf(AbortSignal);

    const malformedSignal = await requestRouter(harness, "POST", "/v1/deliver", {
      body: {
        targetLabel: "@operator",
        body: "Optional input",
        intent: "tell",
        operatorSignal: {
          kind: "consult",
          blocking: false,
          replyExpectation: "optional",
          defaultAction: " ",
        },
      },
    });
    expect(malformedSignal.response.status).toBe(400);
    expect(malformedSignal.body).toMatchObject({ error: "invalid_request" });
    expect(harness.deliverCalls).toHaveLength(3);
  });

  test("maps rendezvous results and validation failures onto HTTP statuses", async () => {
    const requests: unknown[] = [];
    const harness = createHarness({
      rendezvousService: {
        match: async (request: unknown) => {
          requests.push(request);
          const codename = (request as { codename?: string }).codename;
          if (codename === "BAD") {
            throw new Error("codename is invalid");
          }
          if (codename === "NO4FND") {
            return {
              status: "not_found",
              codename,
              projectRoot: "/repo",
              participantId: "session:three",
              suggestion: "check_codename_or_create",
            };
          }
          if (codename === "EX5PRD") {
            return {
              status: "expired",
              codename,
              projectRoot: "/repo",
              participantId: "session:three",
              expiresAt: 1,
              suggestion: "choose_another_codename",
            };
          }
          if (codename === "USED22") {
            return {
              status: "consumed",
              codename,
              projectRoot: "/repo",
              participantId: "session:three",
              expiresAt: 2,
              suggestion: "choose_another_codename",
            };
          }
          if (codename === "OTHER2") {
            return {
              status: "project_mismatch",
              codename,
              projectRoot: "/repo",
              participantId: "session:three",
              suggestion: "run_in_invitation_project",
            };
          }
          return {
            status: "codename_busy",
            codename: "BlueBird",
            projectRoot: "/repo",
            participantId: "session:three",
            participantCount: 2,
            expiresAt: 2,
            suggestion: "choose_another_codename",
          };
        },
      },
    } as Partial<BrokerHttpRouterDeps>);

    const busy = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: {
        action: "join",
        codename: "BlueBird",
        projectRoot: "/repo",
        participantId: "session:three",
        waitMs: 0,
      },
    });
    const invalid = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: {
        action: "join",
        codename: "BAD",
        projectRoot: "/repo",
        participantId: "session:three",
        waitMs: 0,
      },
    });
    const notFound = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: { action: "join", codename: "NO4FND", projectRoot: "/repo", participantId: "session:three" },
    });
    const expired = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: { action: "join", codename: "EX5PRD", projectRoot: "/repo", participantId: "session:three" },
    });
    const consumed = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: { action: "join", codename: "USED22", projectRoot: "/repo", participantId: "session:three" },
    });
    const projectMismatch = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: { action: "join", codename: "OTHER2", projectRoot: "/repo", participantId: "session:three" },
    });

    expect(busy.response.status).toBe(409);
    expect(busy.body).toMatchObject({ status: "codename_busy", participantCount: 2 });
    expect(notFound.response.status).toBe(404);
    expect(expired.response.status).toBe(410);
    expect(consumed.response.status).toBe(409);
    expect(projectMismatch.response.status).toBe(409);
    expect(invalid.response.status).toBe(400);
    expect(requests).toHaveLength(6);
  });

  test("validates invocation requests before dispatch", async () => {
    const harness = createHarness();

    const accepted = await requestRouter(harness, "POST", "/v1/invocations", {
      body: {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "help",
        ensureAwake: true,
        stream: false,
        createdAt: 100,
      },
    });
    expect(accepted.response.status).toBe(202);
    expect(accepted.body).toEqual({ ok: true });
    expect(harness.invocationCalls).toEqual([
      expect.objectContaining({
        id: "inv-1",
        action: "consult",
        task: "help",
      }),
    ]);

    const invalidShape = await requestRouter(harness, "POST", "/v1/invocations", {
      body: {
        id: "inv-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "dance",
        task: "help",
        ensureAwake: true,
        stream: false,
        createdAt: 100,
      },
    });
    expect(invalidShape.response.status).toBe(400);
    expect(invalidShape.body).toMatchObject({
      error: "invalid_request",
    });

    const invalidContinuation = await requestRouter(harness, "POST", "/v1/invocations", {
      body: {
        id: "inv-3",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "help",
        execution: { session: "existing" },
        ensureAwake: true,
        stream: false,
        createdAt: 100,
      },
    });
    expect(invalidContinuation.response.status).toBe(400);
    expect(invalidContinuation.body).toMatchObject({
      error: "invalid_request",
      detail: expect.stringContaining("session existing requires targetSessionId"),
    });
    expect(harness.invocationCalls).toHaveLength(1);
  });

  test("returns JSON-RPC parse errors on malformed A2A requests", async () => {
    const harness = createHarness();

    const result = await requestRouter(harness, "POST", "/v1/a2a/rpc", {
      rawBody: "{not-json",
    });

    expect(result.response.status).toBe(200);
    expect(result.response.headers?.["cache-control"]).toBe("no-cache");
    expect(result.body).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
      },
    });
  });

  test("preference operations never resolve a read boundary or acknowledge deliveries", async () => {
    const changes: unknown[] = [];
    let acknowledgements = 0;
    const harness = createHarness({
      updateChatPreferences: async (conversationId, actorId, change) => {
        changes.push({ conversationId, actorId, change });
        return { notificationMode: "muted", followedThreadIds: [] };
      },
      acknowledgeDeliveriesForReadCursor: async () => { acknowledgements++; },
    });
    const updated = await requestRouter(harness, "POST", "/v1/conversations/conversation-1/read-cursors", {
      body: { operation: "preferences", actorId: "agent-1", change: { notificationMode: "muted" } },
    });
    expect(updated.response.status).toBe(200);
    expect(changes).toEqual([{ conversationId: "conversation-1", actorId: "agent-1", change: { notificationMode: "muted" } }]);
    expect(harness.cursorBodies).toEqual([]);
    expect(acknowledgements).toBe(0);
  });

  test("wires read cursor GET and POST routes through explicit dependencies", async () => {
    const harness = createHarness();

    const listed = await requestRouter(harness, "GET", "/v1/conversations/conversation-1/read-cursors");
    expect(listed.response.status).toBe(200);
    expect(listed.body).toEqual([{
      conversationId: "conversation-1",
      actorId: "agent-1",
      lastReadAt: 100,
      updatedAt: 100,
    }]);

    const updated = await requestRouter(harness, "POST", "/v1/conversations/conversation-1/read-cursors", {
      body: {
        actorId: "agent-1",
        lastReadSeq: 7,
      },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body).toEqual({
      ok: true,
      cursor: {
        conversationId: "conversation-1",
        actorId: "agent-1",
        lastReadAt: 100,
        updatedAt: 100,
      },
      acknowledgedDeliveries: ["delivery-1"],
    });
    expect(harness.cursorBodies).toEqual([{ actorId: "agent-1", lastReadSeq: 7 }]);
  });

  test("routes assigned-role and mission-log writes through the broker database", async () => {
    const unavailable = createHarness();
    const unavailableResult = await requestRouter(
      unavailable,
      "GET",
      "/v1/roles/assignments",
    );
    expect(unavailableResult.response.status).toBe(503);

    const db = new Database(":memory:");
    try {
      migrateControlPlaneDatabaseSchema(db);
      const harness = createHarness({ openRolesDb: () => db });

      const catalog = await requestRouter(harness, "GET", "/v1/roles/catalog");
      expect(catalog.response.status).toBe(200);
      expect(catalog.body).toMatchObject({
        roles: [expect.objectContaining({ id: "orchestrator" })],
      });

      const assigned = await requestRouter(harness, "POST", "/v1/roles/assignments", {
        body: {
          roleId: "orchestrator",
          agentId: "agent-1",
          scope: { kind: "mission", missionId: "work-1" },
        },
      });
      expect(assigned.response.status).toBe(201);
      expect(assigned.body).toMatchObject({
        assignment: {
          roleId: "orchestrator",
          agentId: "agent-1",
          active: true,
        },
      });

      const listed = await requestRouter(
        harness,
        "GET",
        "/v1/roles/assignments?missionId=work-1",
      );
      expect(listed.response.status).toBe(200);
      expect(listed.body).toMatchObject({
        assignments: [expect.objectContaining({ agentId: "agent-1" })],
      });

      const appended = await requestRouter(harness, "POST", "/v1/missions/work-1/log", {
        body: {
          actorId: "agent-1",
          kind: "progress",
          intent: "Ship the role shell",
          status: "verified",
        },
      });
      expect(appended.response.status).toBe(201);
      expect(appended.body).toMatchObject({
        entry: {
          missionId: "work-1",
          actorId: "agent-1",
          seq: 1,
        },
      });

      const log = await requestRouter(harness, "GET", "/v1/missions/work-1/log");
      expect(log.response.status).toBe(200);
      expect(log.body).toMatchObject({
        missionId: "work-1",
        entries: [expect.objectContaining({ status: "verified" })],
      });

      const assignmentId = (assigned.body as { assignment: { id: string } }).assignment.id;
      const revoked = await requestRouter(
        harness,
        "POST",
        `/v1/roles/assignments/${encodeURIComponent(assignmentId)}/revoke`,
      );
      expect(revoked.response.status).toBe(200);
      expect(revoked.body).toMatchObject({ assignment: { active: false } });

      const denied = await requestRouter(harness, "POST", "/v1/missions/work-1/log", {
        body: {
          actorId: "agent-1",
          kind: "progress",
          intent: "Write after revoke",
          status: "should fail",
        },
      });
      expect(denied.response.status).toBe(400);
      expect(denied.body).toMatchObject({
        error: "bad_request",
        detail: expect.stringContaining("not an assigned mission-log writer"),
      });
    } finally {
      db.close();
    }
  });

  describe("mesh trust operator routes", () => {
    function trustHarness(peers: BrokerHttpRouterDeps["meshTrust"] extends infer T
      ? T extends { peers: infer P } ? P : never
      : never) {
      return createHarness({
        meshTrust: {
          enrollment: new TrustEnrollmentService({
            keyId: "f".repeat(64),
            publicKey: "local-public-key",
            nodeId: "node-1",
            fingerprint: "osc1:aaaa-bbbb",
          }),
          rateLimiter: new TrustEndpointRateLimiter(),
          nodeCard: () => ({ keyId: "f".repeat(64) }) as never,
          gateMode: () => "verify-warn",
          persistGrant: () => true,
          peers,
        },
      });
    }

    function memoryPeerStore(seed: TrustedPeerRecord[] = []) {
      const records = new Map(seed.map((peer) => [peer.keyId, peer]));
      return {
        records,
        store: {
          listTrustedPeers: () => [...records.values()],
          trustedPeer: (keyId: string) => records.get(keyId),
          upsertTrustedPeer: (peer: TrustedPeerRecord) => {
            records.set(peer.keyId, peer);
          },
          revokeTrustedPeer: (keyId: string) => records.delete(keyId),
        },
      };
    }

    function peerFixture(overrides: Partial<TrustedPeerRecord> = {}): TrustedPeerRecord {
      return {
        keyId: "a".repeat(64),
        publicKey: "peer-public-key",
        fingerprint: "osc1:cccc-dddd",
        label: "peer-a",
        tier: "observe",
        grantedVia: "sas",
        grantedAt: 1,
        ...overrides,
      };
    }

    test("lists trusted peers, 503 when persistence is disabled", async () => {
      const { store } = memoryPeerStore([peerFixture()]);
      const harness = trustHarness(store);

      const listed = await requestRouter(harness, "GET", "/v1/trust/peers");
      expect(listed.response.status).toBe(200);
      expect(listed.body).toMatchObject({
        peers: [expect.objectContaining({ keyId: "a".repeat(64), tier: "observe" })],
      });

      const disabled = trustHarness(null);
      const unavailable = await requestRouter(disabled, "GET", "/v1/trust/peers");
      expect(unavailable.response.status).toBe(503);
      expect(unavailable.body).toMatchObject({ error: "trust_persistence_unavailable" });
    });

    test("revokes a peer by full key ID", async () => {
      const { records, store } = memoryPeerStore([peerFixture()]);
      const harness = trustHarness(store);

      const malformed = await requestRouter(harness, "POST", "/v1/trust/revoke", {
        body: { keyId: "not-a-key-id" },
      });
      expect(malformed.response.status).toBe(400);

      const missing = await requestRouter(harness, "POST", "/v1/trust/revoke", {
        body: { keyId: "b".repeat(64) },
      });
      expect(missing.response.status).toBe(404);
      expect(missing.body).toMatchObject({ error: "unknown_peer" });

      const revoked = await requestRouter(harness, "POST", "/v1/trust/revoke", {
        body: { keyId: "a".repeat(64) },
      });
      expect(revoked.response.status).toBe(200);
      expect(revoked.body).toMatchObject({ keyId: "a".repeat(64), state: "revoked" });
      expect(records.size).toBe(0);
    });

    test("adjusts an existing peer's tier and label", async () => {
      const { records, store } = memoryPeerStore([peerFixture()]);
      const harness = trustHarness(store);

      const missing = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: { keyId: "b".repeat(64), tier: "control" },
      });
      expect(missing.response.status).toBe(404);

      const badTier = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: { keyId: "a".repeat(64), tier: "admin" },
      });
      expect(badTier.response.status).toBe(400);

      const granted = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: { keyId: "a".repeat(64), tier: "control", label: "peer-a-renamed" },
      });
      expect(granted.response.status).toBe(200);
      expect(granted.body).toMatchObject({
        peer: { keyId: "a".repeat(64), tier: "control", label: "peer-a-renamed" },
      });
      expect(records.get("a".repeat(64))?.tier).toBe("control");
    });

    test("installs a direct grant only when key ID and fingerprint match the public key", async () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const keyId = nodeKeyId(publicKeyBase64);
      const fingerprint = nodeFingerprint(publicKeyBase64);
      const { records, store } = memoryPeerStore();
      const harness = trustHarness(store);

      const mismatched = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: {
          keyId: "c".repeat(64),
          publicKey: publicKeyBase64,
          fingerprint,
          label: "peer-c",
          tier: "observe",
        },
      });
      expect(mismatched.response.status).toBe(400);
      expect(records.size).toBe(0);

      const granted = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: {
          keyId,
          publicKey: publicKeyBase64,
          fingerprint,
          label: "peer-c",
          tier: "control",
          nodeId: "node-c",
        },
      });
      expect(granted.response.status).toBe(200);
      expect(granted.body).toMatchObject({
        peer: { keyId, fingerprint, tier: "control", grantedVia: "sas" },
      });
      expect(records.get(keyId)?.publicKey).toBe(publicKeyBase64);

      // §3c SSH install-grant: grantedVia + TLS pin from verified card.
      const sshKey = generateKeyPairSync("ed25519");
      const sshPublicKey = sshKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const sshKeyId = nodeKeyId(sshPublicKey);
      const sshFingerprint = nodeFingerprint(sshPublicKey);
      const tlsPin = "cd".repeat(32);
      const sshGranted = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: {
          keyId: sshKeyId,
          publicKey: sshPublicKey,
          fingerprint: sshFingerprint,
          label: "peer-ssh",
          tier: "control",
          grantedVia: "ssh",
          tlsSpkiFingerprint: tlsPin,
        },
      });
      expect(sshGranted.response.status).toBe(200);
      expect(sshGranted.body).toMatchObject({
        peer: {
          keyId: sshKeyId,
          grantedVia: "ssh",
          tlsSpkiFingerprint: tlsPin,
        },
      });
      expect(records.get(sshKeyId)?.tlsSpkiFingerprint).toBe(tlsPin);
    });

    test("lists in-flight enrollment sessions for the responder-side operator", async () => {
      const harness = trustHarness(memoryPeerStore().store);
      const result = await requestRouter(harness, "GET", "/v1/trust/enroll/sessions");
      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ sessions: [] });
    });

    test("machine-local trust mutations refuse remote callers even in verify-warn gate mode", async () => {
      // The handler re-checks the transport context itself, so a remote
      // caller is denied regardless of gate rollout mode (the harness's
      // gateMode is verify-warn, where the ingress gate would only log).
      const { records, store } = memoryPeerStore([peerFixture()]);
      const harness = trustHarness(store);
      const remote = { transport: "remote" as const, remoteAddress: "10.0.0.5" };

      for (const [path, body] of [
        ["/v1/trust/revoke", { keyId: "a".repeat(64) }],
        ["/v1/trust/grant", { keyId: "a".repeat(64), tier: "control" }],
        ["/v1/trust/enroll/approve", { enrollmentId: "enr-1", tier: "observe" }],
        ["/v1/trust/enroll/reject", { enrollmentId: "enr-1" }],
      ] as const) {
        const result = await requestRouter(harness, "POST", path, { body, transportContext: remote });
        expect(result.response.status, path).toBe(403);
        expect(result.body).toMatchObject({ error: "forbidden" });
      }
      expect(records.get("a".repeat(64))?.tier).toBe("observe");

      // Loopback (and gate-bypassing in-process callers) still pass.
      const granted = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: { keyId: "a".repeat(64), tier: "control" },
        transportContext: { transport: "loopback", remoteAddress: "127.0.0.1" },
      });
      expect(granted.response.status).toBe(200);
    });
  });

  describe("remote-tier mesh read routes (mesh trust cone §4)", () => {
    test("POST /v1/mesh/aliases/resolve reuses the local alias resolution logic", async () => {
      const resolutions: unknown[] = [];
      const harness = createHarness({
        routeAliasService: {
          resolve: (body: unknown) => {
            resolutions.push(body);
            return { resolved: true, binding: { id: "alias-1" }, proof: { revision: 1 } };
          },
        } as unknown as BrokerHttpRouterDeps["routeAliasService"],
      });

      const result = await requestRouter(harness, "POST", "/v1/mesh/aliases/resolve", {
        body: { alias: "review", caller: { actorId: "operator" } },
      });

      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({ resolved: true });
      expect(resolutions).toHaveLength(1);
    });

    test("GET /v1/mesh/snapshot exposes only the peer agent projection", async () => {
      const harness = createHarness({
        brokerService: {
          ...createHarness().deps.brokerService,
          readSnapshot: async (query) => query?.scope === "agents"
            ? { agents: {} } as never
            : { nodes: { "node-1": { id: "node-1" } } } as never,
        },
      });

      const meshed = await requestRouter(harness, "GET", "/v1/mesh/snapshot");
      expect(meshed.response.status).toBe(200);
      expect(meshed.body).toEqual({ agents: {} });

      const local = await requestRouter(harness, "GET", "/v1/snapshot");
      expect(local.body).toEqual({ nodes: { "node-1": { id: "node-1" } } });
    });

    test("GET /v1/mesh/invocations/:id/stream reuses the invocation stream logic", async () => {
      const streams: Array<{ invocationId: string }> = [];
      const harness = createHarness({
        controlStreams: {
          addInboxStream: () => {},
          addEventStream: () => {},
          addInvocationStream: (args: { invocationId: string }) => {
            streams.push({ invocationId: args.invocationId });
          },
        } as unknown as BrokerHttpRouterDeps["controlStreams"],
      });

      await requestRouter(harness, "GET", "/v1/mesh/invocations/inv-42/stream");

      expect(streams).toEqual([{ invocationId: "inv-42" }]);
    });
  });

  describe("POST /v1/mesh/bind", () => {
    test("applies scope locally and refuses remote callers", async () => {
      const applied: string[] = [];
      const harness = createHarness({
        meshBind: {
          applyScope: async (scope) => {
            applied.push(scope);
            return {
              scope,
              port: 43110,
              tlsAddresses: scope === "mesh" ? ["192.168.1.10"] : [],
              endpoints: scope === "mesh" ? ["https://192.168.1.10:43110"] : ["http://127.0.0.1:43110"],
              brokerUrl: scope === "mesh" ? "https://192.168.1.10:43110" : "http://127.0.0.1:43110",
              tlsSpkiFingerprint: scope === "mesh" ? "a".repeat(64) : null,
              mdnsAdvertising: scope === "mesh",
              hasNonLoopbackListener: scope === "mesh",
            };
          },
          getState: () => ({ scope: "local" }),
        },
      });

      const ok = await requestRouter(harness, "POST", "/v1/mesh/bind", {
        body: { scope: "mesh" },
        transportContext: { transport: "loopback", remoteAddress: "127.0.0.1" },
      });
      expect(ok.response.status).toBe(200);
      expect(ok.body).toMatchObject({
        bind: {
          scope: "mesh",
          hasNonLoopbackListener: true,
          tlsSpkiFingerprint: "a".repeat(64),
        },
      });
      expect(applied).toEqual(["mesh"]);

      const remote = await requestRouter(harness, "POST", "/v1/mesh/bind", {
        body: { scope: "local" },
        transportContext: { transport: "remote", remoteAddress: "192.168.1.50" },
      });
      expect(remote.response.status).toBe(403);
      expect(remote.body).toMatchObject({ error: "forbidden", detail: "route is machine-local" });
      expect(applied).toEqual(["mesh"]); // remote call did not apply

      const bad = await requestRouter(harness, "POST", "/v1/mesh/bind", {
        body: { scope: "wan" },
        transportContext: { transport: "loopback" },
      });
      expect(bad.response.status).toBe(400);
    });
  });
});


describe("integration setup HTTP boundaries", () => {
  test("rejects remote setup and status even when SQLite is unavailable", async () => {
    const harness = createHarness();
    for (const [method, path] of [["POST", "/v1/integrations/setup"], ["GET", "/v1/integrations/setup/op"], ["POST", "/v1/integrations/setup/op/credentials"], ["GET", "/v1/integrations/setup/op/manifest"], ["POST", "/v1/integrations/setup/op/lifecycle"], ["POST", "/v1/integrations/setup/op/worker"], ["POST", "/v1/integrations/setup/op/deliver"], ["POST", "/v1/integrations/setup/op/events"], ["POST", "/v1/integrations/setup/op/verify"], ["POST", "/v1/integrations/setup/op/rebind"]]) {
      const result = await requestRouter(harness, method!, path!, { transportContext: { transport: "remote" } });
      expect(result.response.status).toBe(403);
    }
  });
  test("reports SQLite unavailability without starting setup", async () => {
    const result = await requestRouter(createHarness(), "POST", "/v1/integrations/setup", { body: {} });
    expect(result.response.status).toBe(503);
  });
  test("persists and reads setup, rejects malformed input without echoing it", async () => {
    const database = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(database);
    try {
      const integrationSetupService = new BrokerIntegrationSetupService({
        database, ownerRealmId: "mesh-1", nodeId: "node-1",
        snapshot: () => ({ agents: { alpha: { id: "alpha", definitionId: "alpha", displayName: "Alpha", homeNodeId: "node-1", authorityNodeId: "node-1", metadata: { projectRoot: "/work/alpha" } } }, endpoints: {} }) as never,
      });
      const harness = createHarness({ integrationSetupService });
      const created = await requestRouter(harness, "POST", "/v1/integrations/setup", { body: { provider: "slack", mode: "project_agent", projectPath: "/work/alpha" } });
      expect(created.response.status).toBe(200);
      const id = (created.body as { operation: { id: string } }).operation.id;
      const unpreparedStart = await requestRouter(harness, "POST", `/v1/integrations/setup/${id}/lifecycle`, { body: { action: "start", expectedRevision: 1 } });
      expect(unpreparedStart.response.status).toBe(409);
      const unauthorizedWorker = await requestRouter(harness, "POST", `/v1/integrations/setup/${id}/worker`, { body: { action: "heartbeat", generation: 1, token: "not-a-lease", connected: true } });
      expect(unauthorizedWorker.response.status).toBe(403);
      const status = await requestRouter(harness, "GET", `/v1/integrations/setup/${id}`);
      expect(status.body).toEqual(created.body);
      const invalid = await requestRouter(harness, "POST", `/v1/integrations/setup/${id}/resume`, { body: { action: "verified", token: "DO_NOT_ECHO" } });
      expect(invalid.response.status).toBe(400);
      expect(invalid.rawBody).not.toContain("DO_NOT_ECHO");
      const advanced = await requestRouter(harness, "POST", `/v1/integrations/setup/${id}/resume`, { body: { action: "choose_workspace", expectedRevision: 1, workspaceId: "T123" } });
      expect(advanced.response.status).toBe(200);
      expect((advanced.body as { operation: { state: string } }).operation.state).toBe("awaiting_authority");
    } finally { database.close(); }
  });
});

test("endpoint inventory uses metadata-only peek, supports exact selection and never scans a snapshot", async () => {
  const endpoint = { id: "endpoint-proof", agentId: "session-proof", nodeId: "node-1", sessionId: "native-proof", state: "idle", harness: "claude" } as any;
  const h = createHarness();
  h.deps.runtime.snapshot = () => { throw Error("must not scan message history"); };
  h.deps.runtime.peek = () => ({ endpoints: { [endpoint.id]: endpoint } });
  expect((await requestRouter(h, "GET", "/v1/endpoints?endpointId=endpoint-proof")).body).toEqual({ endpoints: [endpoint] });
  expect((await requestRouter(h, "GET", "/v1/endpoints?agentId=other")).body).toEqual({ endpoints: [] });
  expect((await requestRouter(h, "GET", "/v1/endpoints?endpointId=missing")).body).toEqual({ endpoints: [] });
  delete h.deps.runtime.peek;
  expect((await requestRouter(h, "GET", "/v1/endpoints")).response.status).toBe(503);
});

test("native owner control is local-only, refuses invalid input and never invokes or discovers a replacement", async () => {
  const h = createHarness();
  const endpoint = { id: "owner", agentId: "not-owned", nodeId: "node-1", sessionId: "no-session", state: "idle",
    harness: "claude", transport: "claude_stream_json", metadata: { placement: "background" } } as any;
  h.deps.runtime.peek = () => ({ endpoints: { owner: endpoint } });
  const observe = await requestRouter(h, "POST", "/v1/native-session-attention", { body: { endpointId: "owner" } });
  expect(observe.body).toEqual({ state: "unknown" });
  const invalid = await requestRouter(h, "POST", "/v1/native-session-attention", { body: { endpointId: "owner", action: "spawn" } });
  expect(invalid.response.status).toBe(400);
  const remote = await requestRouter(h, "POST", "/v1/native-session-attention", { body: { endpointId: "owner" }, transportContext: { transport: "remote", remoteAddress: "192.168.1.9" } });
  expect(remote.response.status).toBe(403); expect(h.invocationCalls).toHaveLength(0); expect(h.deliverCalls).toHaveLength(0);
});

describe("invocation working and historical reads", () => {
  test("stream snapshot captures terminal progress that arrives during a deferred historical read", async () => {
    let release!: (value: any) => void;
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const stored = new Promise<any>(resolve => { release = resolve; });
    const oldFlight = { id: "flight-race", invocationId: "inv-race", state: "running" } as any;
    const terminal = { ...oldFlight, state: "completed", completedAt: 30, output: "terminal while loading" };
    const invocation = { id: "inv-race", context: { preserved: true } } as any;
    let current = oldFlight;
    let delivery = { id: "delivery-race", invocationId: "inv-race", status: "peer_acked" } as any;
    let subscribed: any;
    const harness = createHarness({ readHistoricalInvocationSnapshot: async () => { entered(); return stored; } });
    harness.deps.runtime.flightForInvocation = () => current;
    harness.deps.journal.listDeliveries = () => [delivery];
    harness.deps.controlStreams.addInvocationStream = input => { subscribed = input.snapshot; };
    const pending = requestRouter(harness, "GET", "/v1/invocations/inv-race/stream");
    await reading;
    expect(subscribed).toBeUndefined();
    current = terminal;
    delivery = { ...delivery, status: "completed" };
    harness.deps.knownInvocations.set(invocation.id, invocation);
    release({ invocation, flight: oldFlight, deliveries: [] });
    await pending;
    expect(subscribed.flight).toEqual(terminal);
    expect(subscribed.invocation).toEqual(invocation);
    expect(subscribed.deliveries).toEqual([delivery]);
  });

  test("hot stream refresh closes the microtask gap before registering", async () => {
    const invocation = { id: "inv-hot-race" } as any;
    const running = { id: "flight-hot-race", invocationId: invocation.id, state: "running" } as any;
    const terminal = { ...running, state: "completed", output: "completed during await" };
    let current = running;
    let reads = 0;
    let subscribed: any;
    const harness = createHarness({ knownInvocations: new Map([[invocation.id, invocation]]),
      readHistoricalInvocationSnapshot: async () => { throw new Error("hot handle must not read storage"); } });
    harness.deps.runtime.flightForInvocation = () => {
      if (++reads === 1) queueMicrotask(() => { current = terminal; });
      return current;
    };
    harness.deps.controlStreams.addInvocationStream = input => { subscribed = input.snapshot; };
    await requestRouter(harness, "GET", `/v1/invocations/${invocation.id}/stream`);
    expect(subscribed.flight).toEqual(terminal);
  });

  test("hot handles filter before limiting without waiting on historical storage", async () => {
    const invocation = { id: "inv-hot", messageId: "m" } as never;
    const flight = { id: "flight-hot", invocationId: "inv-hot", state: "running" } as never;
    const harness = createHarness({ knownInvocations: new Map([["inv-hot", invocation]]),
      readHistoricalInvocationSnapshot: async () => { throw new Error("must not read worker"); } });
    harness.deps.runtime.flightForInvocation = () => flight;
    const filters: unknown[] = [];
    harness.deps.journal.listDeliveries = options => { filters.push(options); return []; };
    harness.deps.journal.listScoutDispatches = options => { filters.push(options); return []; };
    const result = await requestRouter(harness, "GET", "/v1/invocations/inv-hot");
    expect(result.response.status).toBe(200);
    expect(result.body.flight).toEqual(flight);
    expect(filters).toEqual([{ invocationId: "inv-hot", limit: 500 }, { invocationId: "inv-hot", limit: 50 }]);
  });
  test("old handle and stream recover original context from historical storage", async () => {
    const stored = { invocation: { id: "inv-old", context: { nested: ["original"] } },
      flight: { id: "flight-old", invocationId: "inv-old", state: "completed", output: "original result" }, deliveries: [] };
    const harness = createHarness({ readHistoricalInvocationSnapshot: async id => {
      expect(id).toBe("inv-old"); return stored as never;
    } });
    const result = await requestRouter(harness, "GET", "/v1/invocations/inv-old");
    expect(result.body).toEqual({ invocationId: "inv-old", ...stored, dispatches: [] });
    let snapshot: unknown;
    harness.deps.controlStreams.addInvocationStream = input => { snapshot = input.snapshot; };
    await requestRouter(harness, "GET", "/v1/invocations/inv-old/stream");
    expect(snapshot).toEqual(result.body);
  });
  test("unavailable historical storage returns retryable failure rather than empty success", async () => {
    const harness = createHarness({ readHistoricalInvocationSnapshot: async () => { throw new Error("worker unavailable"); } });
    const result = await requestRouter(harness, "GET", "/v1/invocations/inv-old");
    expect(result.response.status).toBe(503); expect(result.body.retryable).toBe(true);
  });
});

test("permission decision route is machine-local and forwards the exact decision", async () => {
  const decisions: unknown[][] = [];
  const harness = createHarness({ permissionService: { decide: async (...args: unknown[]) => { decisions.push(args); } } as unknown as NonNullable<BrokerHttpRouterDeps["permissionService"]> });
  const body = { requestId: "permission-1", version: "v", decision: "project" };
  const result = await requestRouter(harness, "POST", "/v1/permissions/decide", { body });
  expect(result.response.status).toBe(200); expect(decisions).toEqual([["permission-1", "v", "project"]]);
  const remote = await requestRouter(harness, "POST", "/v1/permissions/decide", { body, transportContext: { transport: "remote" } });
  expect(remote.response.status).toBe(403); expect(decisions).toHaveLength(1);
  const invalid = await requestRouter(harness, "POST", "/v1/permissions/decide", { body: { ...body, decision: "allow-all" } });
  expect(invalid.response.status).toBe(409); expect(decisions).toHaveLength(1);
});

test("permission decision conflicts do not become successful receipts", async () => {
  const harness = createHarness({ permissionService: { decide: async () => { throw new Error("Permission request changed"); } } as unknown as NonNullable<BrokerHttpRouterDeps["permissionService"]> });
  const result = await requestRouter(harness, "POST", "/v1/permissions/decide", { body: { requestId: "p", version: "v", decision: "once" } });
  expect(result.response.status).toBe(409); expect(result.body).toEqual({ error: "Permission request changed", outcome: "refused" });
});

test("unconfirmed permission actuation is not a refused decision", async () => {
  const harness = createHarness({ permissionService: { decide: async () => { throw new PermissionDeliveryUnconfirmedError("Acknowledgement timed out"); } } as unknown as NonNullable<BrokerHttpRouterDeps["permissionService"]> });
  const result = await requestRouter(harness, "POST", "/v1/permissions/decide", { body: { requestId: "p", version: "v", decision: "once" } });
  expect(result.response.status).toBe(502);
  expect(result.body).toEqual({ error: "Acknowledgement timed out", outcome: "unconfirmed" });
});

test("explicit asks cannot forward an alias payload after wire normalization", async () => {
  let forwarded = 0;
  const h = createHarness({ forwardRouteAliasRequest: async () => { forwarded++; return { status: 202, body: {} }; } });
  const result = await requestRouter(h, "POST", "/v1/deliver", { body: { requestId: "stable", intent: "explicit_consult", body: "inspect", completion: { mode: "explicit" },
    target: { kind: "route_alias", alias: "worker", scope: { nodeId: "remote" } } } });
  expect(result.response.status).toBe(400); expect(forwarded).toBe(0); expect(h.deliverCalls).toEqual([]);
});

test("explicit reply endpoint requires typed identity and stable requestId before posting", async () => {
  const h = createHarness(); const posted: any[] = [];
  h.deps.brokerService.postConversationMessage = async (message: any) => { posted.push(message); return { ok: true, message, deliveries: [] }; };
  const body = { id: "ignored", requestId: "stable", actorId: "worker", metadata: { completionReply: { kind: "progress", invocationId: "i", flightId: "f", revision: 0 } } };
  expect((await requestRouter(h, "POST", "/v1/messages/reply", { body: { ...body, requestId: undefined } })).response.status).toBe(400);
  expect((await requestRouter(h, "POST", "/v1/messages/reply", { body: { ...body, metadata: {} } })).response.status).toBe(400);
  expect(posted).toEqual([]);
  expect((await requestRouter(h, "POST", "/v1/messages/reply", { body })).response.status).toBe(200);
  expect(posted[0].id).toStartWith("msg.request."); expect(posted[0].metadata.completionReply.kind).toBe("progress");
});
