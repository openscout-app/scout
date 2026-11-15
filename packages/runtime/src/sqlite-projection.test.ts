import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileBackedBrokerJournal,
  type BrokerJournalEntry,
  type BrokerJournalReplayOptions,
  type BrokerJournalReplayReport,
  type BrokerJournalReplayBoundary,
} from "./broker-journal.ts";
import {
  nativeReadThreadArtifactPath,
  type NativeReadThreadArtifact,
} from "./conversation-thread-artifact.ts";
import { RecoverableSQLiteProjection } from "./sqlite-projection.ts";
import { SQLiteControlPlaneStore } from "./sqlite-store.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createProjectionOptions(overrides: {
  busyOnFirstOpen?: boolean;
  failOnOpen?: Error;
  busyOnFirstEvent?: boolean;
  fatalOnFirstEvent?: boolean;
  busyOnFirstMessage?: boolean;
  busyOnMessageAttempts?: number;
  disabled?: boolean;
  replayEntries?: BrokerJournalEntry[];
  replayYieldEvery?: number;
  replayBatchBytes?: number;
  conversationFeedPublishDelayMs?: number;
  conversationThreadPublishDelayMs?: number;
  publishThreadSnapshots?: boolean;
  useRealConversationThreadPublisher?: boolean;
  suppressProjectionForMessageBodies?: string[];
  captureReplayBoundary?: () => Promise<BrokerJournalReplayBoundary>;
  replay?: (
    visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
    boundary?: BrokerJournalReplayBoundary,
  ) => Promise<void>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-projection-"));
  tempRoots.add(root);
  const threadArtifactDirectory = join(root, "thread-artifacts");

  const stats = {
    createStoreCalls: 0,
    closeCalls: 0,
    recordEventCalls: 0,
    recordMessageCalls: 0,
    replayCalls: 0,
    replayBoundaryCalls: 0,
    conversationProjectionBatchCalls: 0,
    conversationProjectionSequence: 0,
    observedProjectionBatchCalls: 0,
    conversationProjectionReconcileCalls: 0,
    conversationFeedPublishCalls: 0,
    conversationThreadPublishCalls: 0,
    publishedThreadSnapshots: [] as object[],
    transactionBatches: [] as string[][],
    transactionWorkSizes: [] as number[],
    replayTimerYieldObserved: false,
    replayOrder: [] as string[],
    conversationTitles: {} as Record<string, string>,
    deliveryBatchSizes: [] as number[],
    upsertAgentCalls: 0,
    upsertedAgentNames: [] as string[],
    successfulMessageIds: [] as string[],
    messagesById: new Map<string, {
      id: string;
      conversationId: string;
      actorId: string;
      body: string;
      class: string;
      createdAt: number;
    }>(),
  };

  const busyError = new Error("SQLITE_BUSY: database is locked");
  const fatalError = new Error("database disk image is malformed");
  let replayTransactionCount = 0;
  let replayTransactionTimerReached = false;

  const store = {
    writerDb: {
      query: () => ({ get: () => null }),
    },
    runReplayTransaction(operation: () => void): void {
      const operationStart = stats.replayOrder.length;
      try {
        operation();
      } finally {
        const operations = stats.replayOrder.slice(operationStart);
        stats.transactionBatches.push(operations);
        stats.transactionWorkSizes.push(operations.reduce((total, entry) => {
          if (entry.startsWith("deliveries:")) {
            return total + Number(entry.slice("deliveries:".length));
          }
          if (entry.startsWith("endpoint:")) {
            return total + 16;
          }
          return total + 1;
        }, 0));
        if (operations.some((entry) => (
          entry.startsWith("message:")
          || entry.startsWith("deliveries:")
          || entry.startsWith("endpoint:")
        ))) {
          replayTransactionCount += 1;
          if (replayTransactionCount === 1) {
            setTimeout(() => {
              replayTransactionTimerReached = true;
            }, 0);
          } else if (replayTransactionCount === 2) {
            stats.replayTimerYieldObserved = replayTransactionTimerReached;
          }
        }
      }
    },
    close(): void {
      stats.closeCalls += 1;
    },
    recordEvent(): void {
      stats.recordEventCalls += 1;
      if (overrides.fatalOnFirstEvent && stats.recordEventCalls === 1) {
        throw fatalError;
      }
      if (overrides.busyOnFirstEvent && stats.recordEventCalls === 1) {
        throw busyError;
      }
    },
    recordMessage(message: {
      id: string;
      conversationId: string;
      actorId: string;
      body: string;
      class: string;
      createdAt: number;
    }): [] {
      stats.recordMessageCalls += 1;
      stats.replayOrder.push(`message:${message.id}`);
      const busyAttempts = overrides.busyOnMessageAttempts
        ?? (overrides.busyOnFirstMessage ? 1 : 0);
      if (stats.recordMessageCalls <= busyAttempts) {
        throw busyError;
      }
      stats.successfulMessageIds.push(message.id);
      stats.messagesById.set(message.id, message);
      return [];
    },
    listActivityItems(): [] {
      return [];
    },
    latestThreadSeq(): number {
      return 0;
    },
    oldestThreadSeq(): number {
      return 0;
    },
    listThreadEvents(): [] {
      return [];
    },
    getThreadSnapshot(): null {
      return null;
    },
    getConversationThreadLaunchSnapshot(input: {
      conversationId: string;
      projectionId: string;
      projectionVersion: number;
      sequence: number;
    }): object | null {
      if (!overrides.publishThreadSnapshots) return null;
      const messages = [...stats.messagesById.values()]
        .filter((message) => message.conversationId === input.conversationId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map((message) => ({
          id: message.id,
          actorId: message.actorId,
          actorName: null,
          body: message.body,
          class: message.class,
          createdAt: message.createdAt,
        }));
      return {
        projectionId: input.projectionId,
        projectionVersion: input.projectionVersion,
        sequence: input.sequence,
        feedId: `conv:${input.conversationId}`,
        entityKind: "scout_conversation",
        conversationId: input.conversationId,
        cursor: messages[0]?.id ?? null,
        hasEarlier: false,
        generatedAt: 1,
        messages,
      };
    },
    upsertNode(node: { id: string }): void {
      stats.replayOrder.push(`node:${node.id}`);
    },
    upsertActor(actor: { id: string }): void {
      stats.replayOrder.push(`actor:${actor.id}`);
    },
    upsertAgent(agent: { displayName: string }): void {
      stats.upsertAgentCalls += 1;
      stats.upsertedAgentNames.push(agent.displayName);
      stats.replayOrder.push(`agent:${agent.displayName}`);
    },
    upsertEndpoint(endpoint: { id: string }): void {
      stats.replayOrder.push(`endpoint:${endpoint.id}`);
    },
    upsertConversation(conversation: { id: string; title?: string }): void {
      stats.replayOrder.push(`conversation:${conversation.id}`);
      stats.conversationTitles[conversation.id] = conversation.title ?? "";
    },
    upsertBinding(): void {},
    recordInvocation(): void {},
    recordFlight(): void {},
    recordCollaborationRecord(): void {},
    recordCollaborationEvent(): void {},
    recordDeliveries(deliveries: unknown[]): void {
      stats.deliveryBatchSizes.push(deliveries.length);
      stats.replayOrder.push(`deliveries:${deliveries.length}`);
    },
    recordDeliveryAttempt(): void {},
    updateDeliveryStatus(): void {},
    recordScoutDispatch(): void {},
  };

  const conversationProjection = {
    applyBrokerBatch(entries: readonly BrokerJournalEntry[]): object {
      stats.conversationProjectionBatchCalls += 1;
      const messageEntry = entries.find((entry): entry is Extract<
        BrokerJournalEntry,
        { kind: "message.record" }
      > => entry.kind === "message.record");
      const conversationId = messageEntry?.message.conversationId;
      if (
        messageEntry
        && overrides.suppressProjectionForMessageBodies?.includes(messageEntry.message.body)
      ) {
        return null as never;
      }
      stats.conversationProjectionSequence += 1;
      return {
        seq: stats.conversationProjectionSequence,
        delta: {
          upserted: conversationId
            ? [{
              feedId: `conv:${conversationId}`,
              entityKind: "scout_conversation",
              conversationId,
            }]
            : [],
          notVisible: [],
          hardDeleted: [],
          identityRedirects: [],
        },
      };
    },
    applyObservedSessionBatch(): object {
      stats.observedProjectionBatchCalls += 1;
      return {
        seq: stats.observedProjectionBatchCalls,
        delta: { upserted: [], notVisible: [], hardDeleted: [], identityRedirects: [] },
      };
    },
    eventsSince(): never {
      throw new Error("not used by this test helper");
    },
    meta(): object {
      return {
        projectionId: "projection-test",
        projectionVersion: 1,
        headSeq: stats.conversationProjectionSequence,
        minReplayableSeq: 1,
        updatedAt: 1,
      };
    },
    reconcileAll(): null {
      stats.conversationProjectionReconcileCalls += 1;
      return null;
    },
    snapshot(): object {
      return {
        projectionId: "projection-test",
        projectionVersion: 1,
        sequence: stats.conversationProjectionSequence,
        generatedAt: 1,
        sourceFreshAt: null,
        items: [],
        total: 0,
        hasMore: false,
        engagedFeedId: null,
        identityRedirects: [],
      };
    },
  };

  const journal = {
    captureReplayBoundary: async () => {
      stats.replayBoundaryCalls += 1;
      if (overrides.captureReplayBoundary) {
        return overrides.captureReplayBoundary();
      }
      return { endByteExclusive: overrides.replayEntries?.length ?? 0 };
    },
    replay: async (
      visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
      boundary?: BrokerJournalReplayBoundary,
    ): Promise<void> => {
      stats.replayCalls += 1;
      if (overrides.replay) {
        await overrides.replay(visitor, boundary);
        return;
      }
      for (const entry of overrides.replayEntries ?? []) {
        await visitor(entry);
      }
    },
  } as unknown as FileBackedBrokerJournal;

  return {
    stats,
    projection: new RecoverableSQLiteProjection(
      join(root, "projection.sqlite"),
      journal,
      {
        disabled: overrides.disabled,
        busyRetryDelayMs: 0,
        sleep: async () => {},
        replayYieldEvery: overrides.replayYieldEvery,
        replayBatchBytes: overrides.replayBatchBytes,
        conversationFeedPublishDelayMs: overrides.conversationFeedPublishDelayMs ?? 0,
        conversationThreadPublishDelayMs: overrides.conversationThreadPublishDelayMs ?? 0,
        conversationThreadArtifactDirectory: threadArtifactDirectory,
        createStore: () => {
          stats.createStoreCalls += 1;
          if (overrides.failOnOpen) {
            throw overrides.failOnOpen;
          }
          if (overrides.busyOnFirstOpen && stats.createStoreCalls === 1) {
            throw busyError;
          }
          return store as never;
        },
        createConversationProjection: () => conversationProjection as never,
        createConversationFeedPublisher: () => ({
          publish: () => {
            stats.conversationFeedPublishCalls += 1;
            return { status: "written" } as never;
          },
        }),
        createConversationThreadPublisher: overrides.useRealConversationThreadPublisher
          ? undefined
          : () => ({
            publish: (snapshot: object) => {
              stats.conversationThreadPublishCalls += 1;
              stats.publishedThreadSnapshots.push(snapshot);
              return { status: "written" } as never;
            },
          }),
      },
    ),
    threadArtifactDirectory,
  };
}

function sampleMessageEntry(): Extract<BrokerJournalEntry, { kind: "message.record" }> {
  return {
    kind: "message.record",
    message: {
      id: "msg-1",
      conversationId: "conv-1",
      actorId: "actor-1",
      originNodeId: "node-1",
      class: "agent",
      body: "hello",
      visibility: "private",
      policy: "durable",
      createdAt: 1_700_000_000_000,
    },
  };
}

function sampleAgentEntry(
  displayName = "Agent One",
): Extract<BrokerJournalEntry, { kind: "agent.upsert" }> {
  return {
    kind: "agent.upsert",
    agent: {
      id: "agent-1",
      kind: "agent",
      displayName,
      definitionId: "agent-1",
      agentClass: "builder",
      capabilities: ["chat", "execute"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
    },
  };
}

function createRealProjection(
  dbPath: string,
  journal: FileBackedBrokerJournal,
  options: { failOnReconcile?: boolean } = {},
): RecoverableSQLiteProjection {
  return new RecoverableSQLiteProjection(dbPath, journal, {
    conversationFeedPublishDelayMs: 0,
    conversationThreadPublishDelayMs: 0,
    createConversationFeedPublisher: () => ({
      publish: () => ({ status: "written" }) as never,
    }),
    createConversationThreadPublisher: () => ({
      publish: () => ({ status: "written" }) as never,
    }),
    ...(options.failOnReconcile
      ? {
          createConversationProjection: () => ({
            applyBrokerBatch: () => null,
            applyObservedSessionBatch: () => null,
            eventsSince: () => ({ events: [], nextCursor: null }),
            meta: () => ({
              projectionId: "projection-test",
              projectionVersion: 1,
              headSeq: 0,
              minReplayableSeq: 0,
              updatedAt: 0,
            }),
            persistedActiveObservedSessionUpdates: () => [],
            reconcileAll: () => {
              throw new Error("simulated crash after replay commit");
            },
            snapshot: () => ({
              projectionId: "projection-test",
              projectionVersion: 1,
              sequence: 0,
              generatedAt: 0,
              sourceFreshAt: null,
              items: [],
              total: 0,
              hasMore: false,
              engagedFeedId: null,
              identityRedirects: [],
            }),
          }) as never,
        }
      : {}),
  });
}

function readProjectionCheckpoint(dbPath: string): {
  projection_id: string;
  projection_version: number;
  barrier_id: string;
} | null {
  const store = new SQLiteControlPlaneStore(dbPath);
  try {
    return store.readerDb.query(
      `SELECT projection_id, projection_version, barrier_id
       FROM broker_journal_projection_checkpoints
       WHERE projection_id = 'control-plane'`,
    ).get() as {
      projection_id: string;
      projection_version: number;
      barrier_id: string;
    } | null;
  } finally {
    store.close();
  }
}

describe("RecoverableSQLiteProjection", () => {
  test("resolves the warm boundary before synchronous store construction starts", async () => {
    const { projection, stats } = createProjectionOptions();

    const warmBoundary = projection.warm();
    await warmBoundary;

    expect(stats.replayBoundaryCalls).toBe(1);
    expect(stats.createStoreCalls).toBe(0);
    expect(projection.statusSnapshot().state).toBe("warming");

    await projection.flush();
    expect(stats.createStoreCalls).toBe(1);
    expect(projection.statusSnapshot().state).toBe("ready");
  });

  test("reports ready after opening the projection store", async () => {
    const { projection } = createProjectionOptions();

    expect(projection.statusSnapshot()).toEqual({
      state: "degraded",
      detail: "SQLite projection is not ready.",
    });

    projection.warm();
    expect(projection.statusSnapshot()).toEqual({
      state: "warming",
      detail: "SQLite projections are reconciling from the broker journal; prior launch views remain readable.",
    });
    await projection.flush();

    expect(projection.statusSnapshot()).toEqual({ state: "ready", detail: null });
  });

  test("treats the launch snapshot as a nonblocking cache lookup while recovery warms", async () => {
    const boundary = Promise.withResolvers<BrokerJournalReplayBoundary>();
    const { projection, stats } = createProjectionOptions({
      captureReplayBoundary: () => boundary.promise,
    });

    expect(await projection.conversationSnapshot()).toBeNull();
    expect(projection.statusSnapshot().state).toBe("warming");
    expect(stats.createStoreCalls).toBe(0);

    boundary.resolve({ endByteExclusive: 0 });
    await projection.flush();
    expect(stats.replayBoundaryCalls).toBe(1);
    expect(stats.createStoreCalls).toBe(1);
    expect(projection.statusSnapshot().state).toBe("ready");
  });

  test("streams two replay passes and prepares FK parents before child records", async () => {
    const message = sampleMessageEntry();
    const { projection, stats } = createProjectionOptions({ replayEntries: [message] });

    projection.warm();
    await projection.flush();

    expect(stats.replayCalls).toBe(2);
    expect(stats.replayBoundaryCalls).toBe(1);
    expect(stats.replayOrder).toEqual([
      "node:node-1",
      "actor:actor-1",
      "conversation:conv-1",
      "message:msg-1",
    ]);
    expect(stats.conversationProjectionReconcileCalls).toBe(1);
    expect(stats.conversationProjectionBatchCalls).toBe(0);
    expect(stats.conversationFeedPublishCalls).toBe(1);
  });

  test("leaves a conversation seen only by reference untitled instead of titling it with its id", async () => {
    const message = sampleMessageEntry();
    const { projection, stats } = createProjectionOptions({ replayEntries: [message] });

    projection.warm();
    await projection.flush();

    expect(stats.conversationTitles["conv-1"]).toBe("");
  });

  test("does not let pre-recovery runtime events capture the journal boundary", async () => {
    const { projection, stats } = createProjectionOptions();
    projection.enqueueEvent({
      kind: "node.upserted",
      id: "evt-bootstrap-node",
      actorId: "system",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);

    await projection.flush();
    expect(stats.replayBoundaryCalls).toBe(0);
    expect(stats.createStoreCalls).toBe(0);
    expect(stats.recordEventCalls).toBe(0);

    await projection.warm();
    await projection.flush();
    expect(stats.replayBoundaryCalls).toBe(1);
    expect(stats.createStoreCalls).toBe(1);
    expect(stats.recordEventCalls).toBe(1);
  });

  test("batches parent preparation and replay writes in bounded transactions with timer yields", async () => {
    const replayEntries = Array.from({ length: 5 }, (_, index) => ({
      ...sampleMessageEntry(),
      message: {
        ...sampleMessageEntry().message,
        id: `msg-${index + 1}`,
      },
    }));
    const { projection, stats } = createProjectionOptions({
      replayEntries,
      replayYieldEvery: 2,
    });

    projection.warm();
    await projection.flush();

    expect(stats.transactionBatches).toEqual([
      ["node:node-1", "actor:actor-1"],
      ["conversation:conv-1"],
      ["message:msg-1", "message:msg-2"],
      ["message:msg-3", "message:msg-4"],
      ["message:msg-5"],
    ]);
    expect(stats.transactionBatches.every((batch) => batch.length <= 2)).toBe(true);
    expect(stats.replayTimerYieldObserved).toBe(true);
  });

  test("weights endpoint upserts so at most eight preserve order per replay turn", async () => {
    const replayEntries: BrokerJournalEntry[] = Array.from({ length: 10 }, (_, index) => ({
      kind: "agent.endpoint.upsert" as const,
      endpoint: {
        id: `endpoint-${index + 1}`,
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "active",
      },
    }));
    const { projection, stats } = createProjectionOptions({
      replayEntries,
      replayYieldEvery: 128,
    });

    await projection.warm();
    await projection.flush();

    expect(stats.transactionBatches).toEqual([
      ["node:node-1"],
      Array.from({ length: 8 }, (_, index) => `endpoint:endpoint-${index + 1}`),
      ["endpoint:endpoint-9", "endpoint:endpoint-10"],
    ]);
    expect(stats.transactionWorkSizes).toEqual([1, 128, 32]);
    expect(stats.replayOrder.filter((entry) => entry.startsWith("endpoint:"))).toEqual(
      Array.from({ length: 10 }, (_, index) => `endpoint:endpoint-${index + 1}`),
    );
    expect(stats.replayTimerYieldObserved).toBe(true);
  });

  test("replay byte budget isolates large accepted records instead of retaining a count-sized payload batch", async () => {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      ...sampleMessageEntry(), message: { ...sampleMessageEntry().message, id: `large-${index}`, body: "x".repeat(index === 2 ? 8000 : 1000) },
    }));
    const { projection, stats } = createProjectionOptions({ replayEntries: entries, replayYieldEvery: 128, replayBatchBytes: 2000 });
    await projection.warm(); await projection.flush();
    expect(stats.transactionBatches.filter(batch => batch.some(value => value.startsWith("message:")))).toEqual([
      ["message:large-0"], ["message:large-1"], ["message:large-2"], ["message:large-3"],
    ]);
    expect(stats.replayTimerYieldObserved).toBe(true);
  });

  test("replay splits a delivery batch by bytes as well as record count", async () => {
    const deliveries = Array.from({ length: 3 }, (_, index) => ({
      id: `bytes-${index}`, targetId: "agent-1", targetNodeId: "node-1", targetKind: "agent" as const,
      transport: "local_socket" as const, reason: "message" as const, policy: "best_effort" as const,
      status: "accepted" as const, metadata: { payload: "x".repeat(1800) },
    }));
    const { projection, stats } = createProjectionOptions({ replayEntries: [{ kind: "deliveries.record", deliveries }], replayYieldEvery: 128, replayBatchBytes: 2500 });
    await projection.warm(); await projection.flush();
    expect(stats.deliveryBatchSizes).toEqual([1, 1, 1]);
    expect(stats.transactionWorkSizes.filter(size => size > 0).every(size => size <= 1)).toBe(true);
  });

  test("splits one oversized delivery entry into bounded replay transactions", async () => {
    const deliveries = Array.from({ length: 300 }, (_, index) => ({
      id: `delivery-${index + 1}`,
      targetId: "agent-1",
      targetNodeId: "node-1",
      targetKind: "agent" as const,
      transport: "local_socket" as const,
      reason: "message" as const,
      policy: "best_effort" as const,
      status: "accepted" as const,
    }));
    const { projection, stats } = createProjectionOptions({
      replayEntries: [{ kind: "deliveries.record", deliveries }],
      replayYieldEvery: 128,
    });

    await projection.warm();
    await projection.flush();

    expect(stats.deliveryBatchSizes).toEqual([128, 128, 44]);
    expect(stats.transactionWorkSizes).toEqual([1, 128, 128, 44]);
    expect(stats.transactionWorkSizes.every((size) => size <= 128)).toBe(true);
    expect(stats.replayTimerYieldObserved).toBe(true);
  });

  test("applies each replayed and live agent upsert once", async () => {
    const { projection, stats } = createProjectionOptions({
      replayEntries: [sampleAgentEntry("Agent Old"), sampleAgentEntry("Agent Latest")],
    });

    await projection.warm();
    await projection.flush();

    expect(stats.upsertAgentCalls).toBe(3);
    expect(stats.upsertedAgentNames).toEqual([
      "Agent Latest",
      "Agent Old",
      "Agent Latest",
    ]);

    await projection.applyEntries(sampleAgentEntry("Agent Live"));

    expect(stats.upsertAgentCalls).toBe(4);
    expect(stats.upsertedAgentNames).toEqual([
      "Agent Latest",
      "Agent Old",
      "Agent Latest",
      "Agent Live",
    ]);
  });

  test.each([false, true])("sees endpoint, binding, and reply dependencies written earlier in one real replay batch (cache=%s)", async (cacheReplayLookups) => {
    const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-projection-real-"));
    tempRoots.add(root);
    const entries: BrokerJournalEntry[] = [
      {
        kind: "node.upsert",
        node: {
          id: "node-1",
          meshId: "mesh-1",
          name: "Node One",
          advertiseScope: "local",
          registeredAt: 1,
        },
      },
      {
        kind: "actor.upsert",
        actor: { id: "operator", kind: "person", displayName: "Operator" },
      },
      sampleAgentEntry(),
      {
        kind: "conversation.upsert",
        conversation: {
          id: "conv-1",
          kind: "direct",
          title: "Direct",
          visibility: "private",
          shareMode: "local",
          authorityNodeId: "node-1",
          participantIds: ["operator", "agent-1"],
        },
      },
      {
        kind: "agent.endpoint.upsert",
        endpoint: {
          id: "endpoint-1",
          agentId: "agent-1",
          nodeId: "node-1",
          harness: "codex",
          transport: "codex_app_server",
          state: "active",
          sessionId: "session-1",
          cwd: "/work/openscout",
          projectRoot: "/work/openscout",
        },
      },
      {
        kind: "binding.upsert",
        binding: {
          id: "binding-1",
          conversationId: "conv-1",
          platform: "webhook",
          mode: "bidirectional",
          externalChannelId: "channel-1",
        },
      },
      {
        ...sampleMessageEntry(),
        message: {
          ...sampleMessageEntry().message,
          id: "msg-original",
          actorId: "operator",
          body: "Please investigate",
          createdAt: 10,
        },
      },
      {
        ...sampleMessageEntry(),
        message: {
          ...sampleMessageEntry().message,
          id: "msg-reply",
          actorId: "agent-1",
          body: "Investigated",
          replyToMessageId: "msg-original",
          createdAt: 11,
        },
      },
    ];
    const journal = {
      captureReplayBoundary: async () => ({ endByteExclusive: entries.length }),
      replay: async (
        visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
        boundary?: BrokerJournalReplayBoundary,
      ) => {
        for (const entry of entries.slice(0, boundary?.endByteExclusive ?? entries.length)) {
          await visitor(entry);
        }
      },
    } as unknown as FileBackedBrokerJournal;
    const stores: SQLiteControlPlaneStore[] = [];
    const projection = new RecoverableSQLiteProjection(
      join(root, "projection.sqlite"),
      journal,
      {
        cacheReplayLookups,
        replayYieldEvery: entries.length,
        conversationFeedPublishDelayMs: 0,
        conversationThreadPublishDelayMs: 0,
        createStore: (dbPath) => {
          const store = new SQLiteControlPlaneStore(dbPath);
          stores.push(store);
          return store;
        },
      },
    );

    try {
      await projection.warm();
      await projection.flush();

      const replyActivity = (await projection.listActivityItems({ limit: 20 }))
        .find((item) => item.messageId === "msg-reply");
      expect(replyActivity).toMatchObject({
        kind: "ask_replied",
        workspaceRoot: "/work/openscout",
        sessionId: "session-1",
      });

      const replyThreadEvent = (await projection.listThreadEvents({
        conversationId: "conv-1",
        limit: 20,
      })).find((event) => event.payload.message?.id === "msg-reply");
      expect(replyThreadEvent?.notification).toEqual({
        tier: "badge",
        targetActorIds: ["operator"],
        reason: "thread_reply",
        summary: "Investigated",
      });
      expect(stores[0]?.loadSnapshot().bindings["binding-1"]?.conversationId).toBe("conv-1");
      expect(stores[0]?.readerDb).not.toBe(stores[0]?.writerDb);
    } finally {
      projection.close();
    }
  });

  test("resumes a complete real projection after its durable journal barrier", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-projection-checkpoint-"));
    tempRoots.add(root);
    const dbPath = join(root, "projection.sqlite");
    const journalPath = join(root, "broker-journal.jsonl");
    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    await journal.appendEntries([
      sampleAgentEntry("Agent Before Barrier"),
      sampleMessageEntry(),
    ]);

    const firstProjection = createRealProjection(dbPath, journal);
    await firstProjection.warm();
    await firstProjection.flush();
    firstProjection.close();
    const firstCheckpoint = readProjectionCheckpoint(dbPath);
    expect(firstCheckpoint).toMatchObject({
      projection_id: "control-plane",
      projection_version: 1,
    });

    const secondMessage: BrokerJournalEntry = {
      ...sampleMessageEntry(),
      message: {
        ...sampleMessageEntry().message,
        id: "msg-2",
        body: "only this suffix should replay",
        createdAt: sampleMessageEntry().message.createdAt + 1,
      },
    };
    await journal.appendEntries([
      sampleAgentEntry("Agent After Barrier"),
      secondMessage,
    ]);

    // A fresh journal instance models process restart. Its load compacts the
    // superseded agent definition while retaining the opaque replay marker.
    const restartedJournal = new FileBackedBrokerJournal(journalPath);
    const loadReport = await restartedJournal.load();
    expect(loadReport.compactionRequired).toBe(true);
    expect((await restartedJournal.readEntries()).some(
      (entry) => entry.kind === "journal.replay_barrier"
        && entry.barrier.id === firstCheckpoint?.barrier_id,
    )).toBe(true);

    const visited: string[] = [];
    const originalReplay = restartedJournal.replay.bind(restartedJournal);
    restartedJournal.replay = async (
      visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
      boundary?: BrokerJournalReplayBoundary,
      options?: BrokerJournalReplayOptions,
    ): Promise<BrokerJournalReplayReport> => originalReplay(async (entry) => {
      visited.push(entry.kind === "message.record" ? entry.message.id : entry.kind);
      await visitor(entry);
    }, boundary, options);

    const secondProjection = createRealProjection(dbPath, restartedJournal);
    await secondProjection.warm();
    await secondProjection.flush();
    secondProjection.close();

    expect(visited).toEqual([
      "agent.upsert",
      "msg-2",
      "agent.upsert",
      "msg-2",
    ]);
    const nextCheckpoint = readProjectionCheckpoint(dbPath);
    expect(nextCheckpoint?.barrier_id).not.toBe(firstCheckpoint?.barrier_id);
    const store = new SQLiteControlPlaneStore(dbPath);
    try {
      expect(Object.keys(store.loadSnapshot().messages).sort()).toEqual(["msg-1", "msg-2"]);
    } finally {
      store.close();
    }
  });

  test("keeps rich pre-checkpoint parents and membership when a suffix only references them", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-projection-rich-parents-"));
    tempRoots.add(root);
    const dbPath = join(root, "projection.sqlite");
    const journal = new FileBackedBrokerJournal(join(root, "broker-journal.jsonl"));
    await journal.load();
    await journal.appendEntries([
      {
        kind: "node.upsert",
        node: {
          id: "node-rich",
          meshId: "mesh-rich",
          name: "Rich Node",
          hostName: "rich-node.local",
          advertiseScope: "local",
          labels: ["primary"],
          metadata: { retained: "node" },
          registeredAt: 1_700_000_000_000,
        },
      },
      {
        kind: "actor.upsert",
        actor: {
          id: "actor-rich",
          kind: "person",
          displayName: "Rich Actor",
          handle: "rich-actor",
          labels: ["operator"],
          metadata: { retained: "actor" },
        },
      },
      {
        kind: "actor.upsert",
        actor: {
          id: "actor-member",
          kind: "agent",
          displayName: "Member Agent",
        },
      },
      {
        kind: "conversation.upsert",
        conversation: {
          id: "conversation-rich",
          kind: "direct",
          title: "Rich Conversation",
          topic: "Keep every rich field",
          visibility: "private",
          shareMode: "local",
          authorityNodeId: "node-rich",
          participantIds: ["actor-rich", "actor-member"],
          metadata: { retained: "conversation" },
        },
      },
    ]);

    const firstProjection = createRealProjection(dbPath, journal);
    await firstProjection.warm();
    await firstProjection.flush();
    firstProjection.close();

    await journal.appendEntries([
      {
        kind: "message.record",
        message: {
          id: "message-suffix",
          conversationId: "conversation-rich",
          actorId: "actor-rich",
          originNodeId: "node-rich",
          class: "agent",
          body: "Suffix reference",
          visibility: "private",
          policy: "durable",
          createdAt: 1_700_000_000_100,
        },
      },
      {
        kind: "conversation.read_cursor.upsert",
        cursor: {
          conversationId: "conversation-rich",
          actorId: "actor-rich",
          readerNodeId: "node-rich",
          lastReadMessageId: "message-suffix",
          lastReadAt: 1_700_000_000_101,
          updatedAt: 1_700_000_000_101,
        },
      },
    ]);

    const secondProjection = createRealProjection(dbPath, journal);
    await secondProjection.warm();
    await secondProjection.flush();
    secondProjection.close();

    const store = new SQLiteControlPlaneStore(dbPath);
    try {
      const snapshot = store.loadSnapshot();
      expect(snapshot.nodes["node-rich"]).toMatchObject({
        meshId: "mesh-rich",
        name: "Rich Node",
        hostName: "rich-node.local",
        labels: ["primary"],
        metadata: { retained: "node" },
      });
      expect(snapshot.actors["actor-rich"]).toMatchObject({
        kind: "person",
        displayName: "Rich Actor",
        handle: "rich-actor",
        labels: ["operator"],
        metadata: { retained: "actor" },
      });
      expect(snapshot.conversations["conversation-rich"]).toMatchObject({
        title: "Rich Conversation",
        topic: "Keep every rich field",
        metadata: { retained: "conversation" },
      });
      expect(new Set(snapshot.conversations["conversation-rich"]?.participantIds)).toEqual(
        new Set(["actor-rich", "actor-member"]),
      );
      expect(snapshot.messages["message-suffix"]?.body).toBe("Suffix reference");
      expect(Object.values(snapshot.readCursors)).toContainEqual(expect.objectContaining({
        conversationId: "conversation-rich",
        actorId: "actor-rich",
        lastReadMessageId: "message-suffix",
      }));
    } finally {
      store.close();
    }
  });

  test("falls back to full replay when the stored barrier is missing or version-old", async () => {
    for (const mismatch of ["missing", "version"] as const) {
      const root = mkdtempSync(join(tmpdir(), `openscout-sqlite-projection-${mismatch}-`));
      tempRoots.add(root);
      const dbPath = join(root, "projection.sqlite");
      const journal = new FileBackedBrokerJournal(join(root, "broker-journal.jsonl"));
      await journal.load();
      await journal.appendEntries(sampleMessageEntry());

      const firstProjection = createRealProjection(dbPath, journal);
      await firstProjection.warm();
      await firstProjection.flush();
      firstProjection.close();

      const checkpointStore = new SQLiteControlPlaneStore(dbPath);
      try {
        if (mismatch === "missing") {
          checkpointStore.writerDb.query(
            "UPDATE broker_journal_projection_checkpoints SET barrier_id = 'absent' WHERE projection_id = 'control-plane'",
          ).run();
        } else {
          checkpointStore.writerDb.query(
            "UPDATE broker_journal_projection_checkpoints SET projection_version = 999 WHERE projection_id = 'control-plane'",
          ).run();
        }
      } finally {
        checkpointStore.close();
      }

      const visited: string[] = [];
      const originalReplay = journal.replay.bind(journal);
      journal.replay = async (
        visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
        boundary?: BrokerJournalReplayBoundary,
        options?: BrokerJournalReplayOptions,
      ): Promise<BrokerJournalReplayReport> => originalReplay(async (entry) => {
        if (entry.kind === "message.record") visited.push(entry.message.id);
        await visitor(entry);
      }, boundary, options);

      const recoveredProjection = createRealProjection(dbPath, journal);
      await recoveredProjection.warm();
      await recoveredProjection.flush();
      recoveredProjection.close();

      expect(visited).toEqual(["msg-1", "msg-1"]);
      expect(readProjectionCheckpoint(dbPath)?.projection_version).toBe(1);
    }
  });

  test("does not advance the checkpoint when recovery fails after replay commits", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-projection-crash-"));
    tempRoots.add(root);
    const dbPath = join(root, "projection.sqlite");
    const journal = new FileBackedBrokerJournal(join(root, "broker-journal.jsonl"));
    await journal.load();
    await journal.appendEntries(sampleMessageEntry());

    const firstProjection = createRealProjection(dbPath, journal);
    await firstProjection.warm();
    await firstProjection.flush();
    firstProjection.close();
    const firstCheckpoint = readProjectionCheckpoint(dbPath)!;

    await journal.appendEntries({
      ...sampleMessageEntry(),
      message: {
        ...sampleMessageEntry().message,
        id: "msg-after-checkpoint",
        body: "committed before simulated crash",
        createdAt: sampleMessageEntry().message.createdAt + 1,
      },
    });

    const interruptedProjection = createRealProjection(dbPath, journal, {
      failOnReconcile: true,
    });
    await interruptedProjection.warm();
    await interruptedProjection.flush();
    expect(interruptedProjection.statusSnapshot().state).toBe("degraded");
    interruptedProjection.close();
    expect(readProjectionCheckpoint(dbPath)).toEqual(firstCheckpoint);

    const partiallyUpdatedStore = new SQLiteControlPlaneStore(dbPath);
    try {
      expect(partiallyUpdatedStore.loadSnapshot().messages["msg-after-checkpoint"]?.body)
        .toBe("committed before simulated crash");
    } finally {
      partiallyUpdatedStore.close();
    }

    const retriedProjection = createRealProjection(dbPath, journal);
    await retriedProjection.warm();
    await retriedProjection.flush();
    retriedProjection.close();
    expect(readProjectionCheckpoint(dbPath)?.barrier_id).not.toBe(firstCheckpoint.barrier_id);
  });

  test("applies a write arriving during warm exactly once after the fixed replay boundary", async () => {
    const base = sampleMessageEntry();
    const live: BrokerJournalEntry = {
      ...sampleMessageEntry(),
      message: {
        ...sampleMessageEntry().message,
        id: "msg-live",
        body: "arrived during warm",
      },
    };
    const entries = [base];
    const firstReplayStarted = Promise.withResolvers<void>();
    let releaseFirstReplay: () => void = () => {};
    let replayCall = 0;
    const { projection, stats } = createProjectionOptions({
      captureReplayBoundary: async () => {
        return { endByteExclusive: entries.length };
      },
      replay: async (visitor, boundary) => {
        replayCall += 1;
        for (const entry of entries.slice(0, boundary?.endByteExclusive ?? entries.length)) {
          await visitor(entry);
        }
        if (replayCall === 1) {
          firstReplayStarted.resolve();
          await new Promise<void>((resolve) => {
            releaseFirstReplay = resolve;
          });
        }
      },
    });

    const warmBoundary = projection.warm();
    await warmBoundary;
    expect(projection.statusSnapshot().state).toBe("warming");
    entries.push(live);
    let liveApplied = false;
    const liveWrite = projection.applyEntries(live).then(() => {
      liveApplied = true;
    });
    await firstReplayStarted.promise;

    expect(projection.statusSnapshot().state).toBe("warming");
    expect(liveApplied).toBe(false);
    releaseFirstReplay();
    await liveWrite;

    expect(stats.replayOrder.filter((entry) => entry.startsWith("message:"))).toEqual([
      "message:msg-1",
      "message:msg-live",
    ]);
    expect(stats.conversationProjectionReconcileCalls).toBe(1);
    expect(stats.conversationProjectionBatchCalls).toBe(1);
    expect(stats.conversationFeedPublishCalls).toBe(2);
    expect(projection.statusSnapshot()).toEqual({ state: "ready", detail: null });
  });

  test("reports the projection failure when opening degrades", async () => {
    const failure = new Error("schema v15 is newer than this build's v14");
    const { projection } = createProjectionOptions({ failOnOpen: failure });

    projection.warm();
    await projection.flush();

    expect(projection.statusSnapshot()).toEqual({
      state: "degraded",
      detail: failure.message,
    });
  });

  test("reports disabled without opening the projection store", async () => {
    const { projection, stats } = createProjectionOptions({ disabled: true });

    projection.warm();
    await projection.flush();

    expect(projection.statusSnapshot()).toEqual({
      state: "disabled",
      detail: "SQLite projection is disabled by configuration.",
    });
    expect(stats.createStoreCalls).toBe(0);
  });

  test("does not invalidate the store when opening the projection hits SQLITE_BUSY", async () => {
    const { projection, stats } = createProjectionOptions({ busyOnFirstOpen: true });

    projection.warm();
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-1",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-2",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    expect(stats.createStoreCalls).toBe(2);
    expect(stats.closeCalls).toBe(0);
    expect(stats.recordEventCalls).toBe(2);
  });

  test("preserves the projection store when SQLite reports busy contention", async () => {
    const { projection, stats } = createProjectionOptions({ busyOnFirstEvent: true });

    projection.warm();
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-1",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-2",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    expect(stats.createStoreCalls).toBe(1);
    expect(stats.closeCalls).toBe(0);
    expect(stats.recordEventCalls).toBe(3);
  });

  test("still invalidates the projection store on malformed database errors", async () => {
    const { projection, stats } = createProjectionOptions({ fatalOnFirstEvent: true });

    projection.warm();
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-1",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    projection.enqueueEvent({
      kind: "test.event",
      id: "evt-2",
      actorId: "actor-1",
      nodeId: "node-1",
      ts: Date.now(),
      payload: {},
    } as never);
    await projection.flush();

    expect(stats.createStoreCalls).toBe(2);
    expect(stats.closeCalls).toBe(1);
    expect(stats.recordEventCalls).toBe(2);
  });

  test("retries a busy live batch before applying a distinct later batch", async () => {
    const { projection, stats } = createProjectionOptions({ busyOnFirstMessage: true });

    projection.warm();
    await projection.flush();

    const first = sampleMessageEntry();
    const second: BrokerJournalEntry = {
      ...sampleMessageEntry(),
      message: {
        ...sampleMessageEntry().message,
        id: "msg-2",
      },
    };
    await projection.applyEntries(first);
    await projection.applyEntries(second);

    expect(stats.createStoreCalls).toBe(1);
    expect(stats.closeCalls).toBe(0);
    expect(stats.recordMessageCalls).toBe(3);
    expect(stats.successfulMessageIds).toEqual(["msg-1", "msg-2"]);
    expect(stats.conversationProjectionBatchCalls).toBe(2);
  });

  test("restarts startup replay when busy occurs after the candidate store is readable", async () => {
    const { projection, stats } = createProjectionOptions({
      replayEntries: [sampleMessageEntry()],
      busyOnFirstMessage: true,
    });

    await projection.warm();
    await projection.flush();

    expect(projection.statusSnapshot()).toEqual({ state: "ready", detail: null });
    expect(stats.createStoreCalls).toBe(2);
    expect(stats.closeCalls).toBe(1);
    expect(stats.replayCalls).toBe(4);
    expect(stats.recordMessageCalls).toBe(2);
    expect(stats.successfulMessageIds).toEqual(["msg-1"]);
    expect(stats.conversationProjectionReconcileCalls).toBe(1);
  });

  test("serializes observed folds through the shared projector and republishes the feed", async () => {
    const { projection, stats } = createProjectionOptions();
    await projection.warm();
    await projection.flush();
    const startupPublishes = stats.conversationFeedPublishCalls;

    await projection.applyObservedSessionBatch([{
      feedId: "obs:codex:session-1",
      entityKind: "observed_session",
      source: "codex",
      sourceSessionId: "session-1",
      runtimeSessionId: "session-1",
      title: "Observed session",
      project: "openscout",
      projectRoot: "/work/openscout",
      cwd: "/work/openscout",
      harness: "codex",
      activityState: "working",
      preview: "Running tests",
      lastActivityAt: 1_800_000_000_000,
      sourceFreshAt: 1_800_000_000_000,
      lastEventId: "event-1",
      lastEventKind: "assistant",
    }]);

    expect(stats.observedProjectionBatchCalls).toBe(1);
    expect(stats.conversationProjectionBatchCalls).toBe(0);
    expect(stats.conversationFeedPublishCalls).toBe(startupPublishes + 1);
  });

  test("coalesces feed artifact publication off the serialized projection write path", async () => {
    const { projection, stats } = createProjectionOptions({
      conversationFeedPublishDelayMs: 10,
    });
    await projection.warm();
    await projection.flush();
    await Bun.sleep(15);
    const startupPublishes = stats.conversationFeedPublishCalls;

    const baseUpdate = {
      feedId: "obs:codex:session-coalesced",
      entityKind: "observed_session" as const,
      source: "codex",
      sourceSessionId: "session-coalesced",
      runtimeSessionId: "session-coalesced",
      title: "Observed session",
      project: "openscout",
      projectRoot: "/work/openscout",
      cwd: "/work/openscout",
      harness: "codex",
      activityState: "working" as const,
      preview: "Running tests",
      lastActivityAt: 1_800_000_000_000,
      sourceFreshAt: 1_800_000_000_000,
      lastEventId: "event-1",
      lastEventKind: "assistant" as const,
    };
    await projection.applyObservedSessionBatch([baseUpdate]);
    await projection.applyObservedSessionBatch([{
      ...baseUpdate,
      preview: "Running more tests",
      lastActivityAt: baseUpdate.lastActivityAt + 1,
      sourceFreshAt: baseUpdate.sourceFreshAt + 1,
      lastEventId: "event-2",
    }]);

    expect(stats.conversationFeedPublishCalls).toBe(startupPublishes);
    await Bun.sleep(15);
    expect(stats.conversationFeedPublishCalls).toBe(startupPublishes + 1);
  });

  test("publishes changed thread pages off the durable write path and ignores observed heartbeats", async () => {
    const { projection, stats } = createProjectionOptions({
      conversationThreadPublishDelayMs: 10,
      publishThreadSnapshots: true,
    });
    await projection.warm();
    await projection.flush();

    await projection.applyEntries(sampleMessageEntry());
    await projection.applyEntries({
      ...sampleMessageEntry(),
      message: {
        ...sampleMessageEntry().message,
        id: "msg-2",
      },
    });
    expect(stats.conversationThreadPublishCalls).toBe(0);
    await Bun.sleep(15);
    expect(stats.conversationThreadPublishCalls).toBe(1);

    await projection.applyObservedSessionBatch([{
      feedId: "obs:codex:session-thread-heartbeat",
      entityKind: "observed_session",
      source: "codex",
      sourceSessionId: "session-thread-heartbeat",
      runtimeSessionId: "session-thread-heartbeat",
      title: "Observed session",
      project: "openscout",
      projectRoot: "/work/openscout",
      cwd: "/work/openscout",
      harness: "codex",
      activityState: "working",
      preview: "Still running",
      lastActivityAt: 1_800_000_000_000,
      sourceFreshAt: 1_800_000_000_000,
      lastEventId: "heartbeat-1",
      lastEventKind: "system",
    }]);
    await Bun.sleep(15);
    expect(stats.conversationThreadPublishCalls).toBe(1);
  });

  test("republishes a corrected non-latest thread message without advancing the feed sequence", async () => {
    const { projection, stats, threadArtifactDirectory } = createProjectionOptions({
      publishThreadSnapshots: true,
      useRealConversationThreadPublisher: true,
      suppressProjectionForMessageBodies: ["corrected older message"],
    });
    await projection.warm();
    await projection.flush();

    const first = sampleMessageEntry();
    await projection.applyEntries({
      ...first,
      message: {
        ...first.message,
        body: "original older message",
        createdAt: 1_700_000_000_000,
      },
    });
    await projection.applyEntries({
      ...first,
      message: {
        ...first.message,
        id: "msg-2",
        body: "latest message",
        createdAt: 1_700_000_000_001,
      },
    });
    const feedSequence = stats.conversationProjectionSequence;
    const feedPublishes = stats.conversationFeedPublishCalls;
    const outputPath = nativeReadThreadArtifactPath(
      threadArtifactDirectory,
      "conv:conv-1",
    );
    const originalArtifact = JSON.parse(
      readFileSync(outputPath, "utf8"),
    ) as NativeReadThreadArtifact;

    await projection.applyEntries({
      ...first,
      message: {
        ...first.message,
        body: "corrected older message",
        createdAt: 1_700_000_000_000,
      },
    });

    expect(stats.conversationProjectionSequence).toBe(feedSequence);
    expect(stats.conversationFeedPublishCalls).toBe(feedPublishes);
    const correctedArtifact = JSON.parse(
      readFileSync(outputPath, "utf8"),
    ) as NativeReadThreadArtifact;
    expect(correctedArtifact).toMatchObject({
      sequence: feedSequence,
      conversationId: "conv-1",
      messages: [
        { id: "msg-1", body: "corrected older message" },
        { id: "msg-2", body: "latest message" },
      ],
    });
    expect(correctedArtifact.contentCursor).not.toBe(originalArtifact.contentCursor);
  });
});

test("startup suffix catch-up excludes later writes and survives checkpoint restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-startup-suffix-")); tempRoots.add(root);
  const dbPath = join(root, "projection.sqlite");
  const journal = new FileBackedBrokerJournal(join(root, "broker.jsonl"));
  await journal.load();
  await journal.appendEntries(sampleMessageEntry());
  const projection = createRealProjection(dbPath, journal);
  await projection.warm();
  // These accepted records deliberately receive no live projection enqueue.
  await journal.appendEntries(sampleAgentEntry("During fill"));
  await projection.flush();
  const boundary = await projection.captureStartupCatchUpBoundary();
  const catchUp = projection.catchUpStartup(boundary);
  const later = sampleAgentEntry("After boundary");
  await journal.appendEntries(later);
  await catchUp;
  const reader = new SQLiteControlPlaneStore(dbPath);
  try { expect(reader.loadSnapshot().agents["agent-1"]?.displayName).toBe("During fill"); }
  finally { reader.close(); }
  await projection.applyEntries([later]);
  projection.close();
  const restarted = createRealProjection(dbPath, journal);
  await restarted.warm(); await restarted.flush(); restarted.close();
  const verified = new SQLiteControlPlaneStore(dbPath);
  try {
    expect(verified.loadSnapshot().agents["agent-1"]?.displayName).toBe("After boundary");
    expect(Object.keys(verified.loadSnapshot().messages)).toEqual(["msg-1"]);
  } finally { verified.close(); await journal.close(); }
});

describe("registry delete tombstones", () => {
  const tombstoneFixture = () => {
    const node = {
      id: "node-1",
      meshId: "mesh-1",
      name: "Node One",
      advertiseScope: "local",
      registeredAt: 1_700_000_000_000,
    };
    const actor = {
      id: "agent-1",
      kind: "agent",
      displayName: "Agent One",
      createdAt: 1_700_000_000_000,
    };
    const agent = {
      ...actor,
      definitionId: "agent-1",
      agentClass: "builder",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
    };
    const endpoint = {
      id: "ep-1",
      agentId: "agent-1",
      nodeId: "node-1",
      harness: "codex",
      transport: "local_socket",
      state: "offline",
    };
    // A legacy-shape channel roster that still lists the deleted actor —
    // journals written before membership-removal upserts look like this.
    const channel = {
      id: "conv-1",
      kind: "channel",
      title: "Room",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: "node-1",
      participantIds: ["agent-1"],
    };
    const entries = [
      { kind: "node.upsert", node },
      { kind: "actor.upsert", actor },
      { kind: "agent.upsert", agent },
      { kind: "agent.endpoint.upsert", endpoint },
      { kind: "conversation.upsert", conversation: channel },
      { kind: "agent.endpoint.delete", endpointId: "ep-1" },
      { kind: "agent.delete", agentId: "agent-1" },
      { kind: "actor.delete", actorId: "agent-1" },
    ];
    return { node, actor, agent, endpoint, channel, entries };
  };

  function writeCompactedJournal(
    root: string,
    entries: readonly unknown[],
  ): { journal: FileBackedBrokerJournal; journalPath: string } {
    const journalPath = join(root, "broker-journal.jsonl");
    writeFileSync(
      journalPath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );
    return {
      journal: new FileBackedBrokerJournal(journalPath, {
        // Forces compaction during load(): upserts superseded by deletes are
        // dropped, but the delete tombstones themselves must be retained.
        compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
      }),
      journalPath,
    };
  }

  test("replays compacted delete tombstones onto a lagging database", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-projection-tombstone-"));
    tempRoots.add(root);
    const dbPath = join(root, "projection.sqlite");
    const { node, actor, agent, endpoint, channel, entries } = tombstoneFixture();

    // The database committed the upserts but crashed before projecting the
    // deletes; compaction runs before recovery on the next boot.
    const seeded = new SQLiteControlPlaneStore(dbPath);
    seeded.upsertNode(node as never);
    seeded.upsertActor(actor as never);
    seeded.upsertAgent(agent as never);
    seeded.upsertEndpoint(endpoint as never);
    seeded.upsertConversation(channel as never);
    seeded.close();

    const { journal } = writeCompactedJournal(root, entries);
    await journal.load();

    const projection = createRealProjection(dbPath, journal);
    await projection.warm();
    await projection.flush();
    projection.close();

    const verified = new SQLiteControlPlaneStore(dbPath);
    try {
      const snapshot = verified.loadSnapshot();
      expect(snapshot.actors).toEqual({});
      expect(snapshot.agents).toEqual({});
      expect(snapshot.endpoints).toEqual({});
      expect(snapshot.conversations["conv-1"]?.participantIds).toEqual([]);
    } finally {
      verified.close();
      await journal.close();
    }
  });

  test("does not resurrect a deleted actor from retained membership on a fresh rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-projection-rebuild-"));
    tempRoots.add(root);
    const { entries } = tombstoneFixture();

    const { journal } = writeCompactedJournal(root, entries);
    await journal.load();

    const projection = createRealProjection(join(root, "projection.sqlite"), journal);
    await projection.warm();
    await projection.flush();
    projection.close();

    const verified = new SQLiteControlPlaneStore(join(root, "projection.sqlite"));
    try {
      const snapshot = verified.loadSnapshot();
      // The retained conversation upsert still names 'agent-1' — the stub
      // actor it synthesizes is removed again by the surviving tombstone.
      expect(snapshot.actors).toEqual({});
      expect(snapshot.agents).toEqual({});
      expect(snapshot.endpoints).toEqual({});
      expect(snapshot.conversations["conv-1"]).toBeDefined();
      expect(snapshot.conversations["conv-1"]?.participantIds).toEqual([]);
    } finally {
      verified.close();
      await journal.close();
    }
  });

  test("an agent.delete tombstone alone still cascades its endpoints after compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-projection-cascade-"));
    tempRoots.add(root);
    const { node, actor, agent, endpoint } = tombstoneFixture();
    // Legacy shape: agent.delete with no preceding endpoint tombstones —
    // the endpoint upsert survives compaction under its own key, so only the
    // agent tombstone's cascade keeps it gone.
    const entries = [
      { kind: "node.upsert", node },
      { kind: "actor.upsert", actor },
      { kind: "agent.upsert", agent },
      { kind: "agent.endpoint.upsert", endpoint },
      { kind: "agent.delete", agentId: "agent-1" },
    ];

    const { journal } = writeCompactedJournal(root, entries);
    await journal.load();
    expect(journal.snapshot().endpoints).toEqual({});

    const projection = createRealProjection(join(root, "projection.sqlite"), journal);
    await projection.warm();
    await projection.flush();
    projection.close();

    const verified = new SQLiteControlPlaneStore(join(root, "projection.sqlite"));
    try {
      const snapshot = verified.loadSnapshot();
      expect(snapshot.agents).toEqual({});
      expect(snapshot.endpoints).toEqual({});
      // The actor row is a separate record — it survives an agent delete.
      expect(snapshot.actors["agent-1"]).toBeDefined();
    } finally {
      verified.close();
      await journal.close();
    }
  });
});
