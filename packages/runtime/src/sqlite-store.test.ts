import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import type { WorkItemRecord } from "@openscout/protocol";

import { applyControlPlaneSchemaMigrations } from "./control-plane-migrations.ts";
import { CONTROL_PLANE_SCHEMA_VERSION } from "./schema.ts";
import { SQLiteControlPlaneStore } from "./sqlite-store.ts";

const dbRoots = new Set<string>();

afterEach(() => {
  for (const root of dbRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  dbRoots.clear();
});

function createStore(): SQLiteControlPlaneStore {
  const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-store-"));
  dbRoots.add(root);
  return new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
}

function createStoreWithPath(): { store: SQLiteControlPlaneStore; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-store-"));
  dbRoots.add(root);
  const dbPath = join(root, "control-plane.sqlite");
  return {
    store: new SQLiteControlPlaneStore(dbPath),
    dbPath,
  };
}

function getIndexNames(db: Database, tables: string[]): string[] {
  const placeholders = tables.map(() => "?").join(", ");
  const rows = db.query(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'index'
       AND tbl_name IN (${placeholders})
     ORDER BY name ASC`,
  ).all(...tables) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function getWritableDb(store: SQLiteControlPlaneStore): Database {
  return (store as unknown as { db: Database }).db;
}

function seedAgent(store: SQLiteControlPlaneStore, agentId = "agent-1"): void {
  store.upsertNode({
    id: "node-1",
    meshId: "mesh-1",
    name: "Test node",
    advertiseScope: "local",
    registeredAt: Date.now(),
  });
  store.upsertActor({
    id: agentId,
    kind: "agent",
    displayName: "Agent One",
  });
  store.upsertAgent({
    id: agentId,
    kind: "agent",
    definitionId: agentId,
    displayName: "Agent One",
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
  });
}

function countRows(db: Database, table: string, where: string, value: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where} = ?1`).get(value) as {
    count: number;
  } | null;
  return row?.count ?? 0;
}

function testControlEvent(id: string, ts: number) {
  return {
    id,
    kind: "node.upserted",
    actorId: "node-1",
    nodeId: "node-1",
    ts,
    payload: {
      node: {
        id: "node-1",
        name: "Node One",
        kind: "local",
        lastSeenAt: ts,
        capabilities: [],
        metadata: {},
      },
    },
  } as const;
}

async function expectPromptResolution(promise: Promise<void>): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for pending event flush")), 500).unref?.();
    }),
  ]);
}

describe("SQLiteControlPlaneStore", () => {
  test("retains external board, workflow, and human acceptance context after reopening durable work", () => {
    const fixture = createStoreWithPath();
    const work: WorkItemRecord = {
      id: "external-work", kind: "work_item", title: "Implement board card", state: "review",
      acceptanceState: "pending", createdById: "agent-1", ownerId: "agent-1",
      nextMoveOwnerId: "operator", requestedById: "operator", createdAt: 100, updatedAt: 200,
      externalContext: {
        source: { adapterId: "t3-orchestrator", instanceId: "local", projectId: "project-1", workItemId: "card-1" },
        observedAt: 200, sourceState: "Review",
        board: { id: "project-1", column: { id: "Review", title: "Review" } },
        workflow: {
          stages: [{ id: "review", kind: "review", state: "completed", threadId: "thread-1", provider: "codex" }],
          executionState: "idle", humanAcceptance: { required: true, state: "pending" },
        },
      },
    };
    seedAgent(fixture.store);
    fixture.store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
    fixture.store.recordCollaborationRecord(work);
    fixture.store.recordCollaborationRecord({ ...work, id: "local-work", externalContext: undefined });
    fixture.store.close();
    const reopened = new SQLiteControlPlaneStore(fixture.dbPath);
    try {
      const observed = reopened.listCollaborationRecords().find(record => record.id === work.id);
      expect(observed).toMatchObject(work);
      expect(observed?.kind === "work_item" && observed.externalContext).toEqual(work.externalContext);
      expect(observed?.acceptanceState).toBe("pending");
      expect(reopened.loadSnapshot().collaborationRecords[work.id]).toMatchObject(work);
      const local = reopened.listCollaborationRecords().find(record => record.id === "local-work");
      expect(local?.kind === "work_item" && local.externalContext).toBeUndefined();
    } finally { reopened.close(); }
  });

  test("restores its normal reader when a replay transaction throws", () => {
    const store = createStore();
    const normalReader = store.readerDb;

    try {
      expect(() => store.runReplayTransaction(() => {
        expect(store.readerDb).toBe(store.writerDb);
        throw new Error("reject replay batch");
      })).toThrow("reject replay batch");
      expect(store.readerDb).toBe(normalReader);
      expect(store.readerDb).not.toBe(store.writerDb);
    } finally {
      store.close();
    }
  });

  test("canonical events commit or roll back with the replay transaction before timers", () => {
    const store = createStore();
    try {
      store.runReplayTransaction(() => store.recordEventDurably(testControlEvent("evt-durable", 1)));
      expect(store.recentEvents(10).map(event => event.id)).toEqual(["evt-durable"]);
      expect(() => store.runReplayTransaction(() => {
        store.recordEventDurably(testControlEvent("evt-rollback", 2));
        throw new Error("rollback canonical event");
      })).toThrow("rollback canonical event");
      expect(store.recentEvents(10).map(event => event.id)).toEqual(["evt-durable"]);
    } finally { store.close(); }
  });

  test("retries busy pending-event batches without losing order", async () => {
    const store = createStore();
    const internals = store as unknown as {
      persistEventsBatch: (events: Array<{ id: string }>) => void;
    };
    const persistEventsBatch = internals.persistEventsBatch;
    const attempts: string[][] = [];
    let firstAttemptResolved: (() => void) | undefined;
    let persistedResolved: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      firstAttemptResolved = resolve;
    });
    const persisted = new Promise<void>((resolve) => {
      persistedResolved = resolve;
    });
    let rejectOnce = true;

    internals.persistEventsBatch = (events) => {
      attempts.push(events.map((event) => event.id));
      if (rejectOnce) {
        rejectOnce = false;
        firstAttemptResolved?.();
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      persistEventsBatch(events);
      persistedResolved?.();
    };

    try {
      store.recordEvent(testControlEvent("evt-1", 1));
      await expectPromptResolution(firstAttempt);
      store.recordEvent(testControlEvent("evt-2", 2));
      await expectPromptResolution(persisted);

      expect(attempts).toEqual([["evt-1"], ["evt-1", "evt-2"]]);
      expect(store.recentEvents(10).map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
    } finally {
      internals.persistEventsBatch = persistEventsBatch;
      store.close();
    }
  });

  test("keeps a busy close retryable instead of closing under queued events", async () => {
    const store = createStore();
    const internals = store as unknown as {
      persistEventsBatch: (events: Array<{ id: string }>) => void;
    };
    const persistEventsBatch = internals.persistEventsBatch;
    const attempts: string[][] = [];
    let persistedResolved: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => {
      persistedResolved = resolve;
    });
    let busy = true;

    internals.persistEventsBatch = (events) => {
      attempts.push(events.map((event) => event.id));
      if (busy) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      persistEventsBatch(events);
      persistedResolved?.();
    };

    store.recordEvent(testControlEvent("evt-close", 1));
    expect(() => store.close()).toThrow("database is locked");
    busy = false;
    await expectPromptResolution(persisted);

    expect(attempts).toEqual([["evt-close"], ["evt-close"]]);
    expect(store.recentEvents(10).map((event) => event.id)).toEqual(["evt-close"]);
    internals.persistEventsBatch = persistEventsBatch;
    store.close();
  });

  test("persists execution resolution on invocation receipts", () => {
    const store = createStore();
    try {
      seedAgent(store);
      store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
      const executionResolution = {
        schemaVersion: "openscout.execution-resolution.v1" as const,
        harness: {
          requested: "codex",
          resolved: "codex",
          source: "flag" as const,
          drift: "unknown" as const,
        },
        model: {
          requested: "5.6",
          resolved: "gpt-5.6-sol",
          source: "flag" as const,
          observed: "gpt-5.6-sol",
          observedAt: 130,
          drift: "match" as const,
        },
        reasoningEffort: {
          requested: "high",
          resolved: "high",
          source: "flag" as const,
          drift: "unknown" as const,
        },
        sessionId: "session-execution-1",
        resolvedAt: 120,
        observedAt: 130,
      };

      store.recordInvocation({
        id: "inv-execution-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Preserve the exact runtime tuple",
        execution: { harness: "codex", model: "5.6", reasoningEffort: "high" },
        executionResolution,
        ensureAwake: true,
        stream: false,
        createdAt: 100,
      });

      expect(store.loadSnapshot().invocations["inv-execution-1"]?.executionResolution)
        .toEqual(executionResolution);
    } finally {
      store.close();
    }
  });

  test("persists a new conversation before its members and allows messages to be recorded", () => {
    const store = createStore();

    try {
      store.upsertNode({
        id: "node-1",
        meshId: "mesh-1",
        name: "Test node",
        advertiseScope: "local",
        registeredAt: Date.now(),
      });
      store.upsertActor({
        id: "operator",
        kind: "person",
        displayName: "Operator",
      });
      store.upsertActor({
        id: "agent-1",
        kind: "agent",
        displayName: "Agent One",
      });
      store.upsertAgent({
        id: "agent-1",
        kind: "agent",
        definitionId: "agent-1",
        displayName: "Agent One",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });

      store.upsertConversation({
        id: "conv-1",
        kind: "direct",
        title: "Direct",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });

      store.recordMessage({
        id: "msg-1",
        conversationId: "conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "hello",
        visibility: "private",
        policy: "durable",
        createdAt: Date.now(),
      });

      const snapshot = store.loadSnapshot();
      expect(snapshot.conversations["conv-1"]?.participantIds.sort()).toEqual(["agent-1", "operator"]);
      expect(snapshot.messages["msg-1"]?.conversationId).toBe("conv-1");
    } finally {
      store.close();
    }
  });

  test("derives replayable thread events and summary snapshots for summary conversations", () => {
    const store = createStore();

    try {
      store.upsertNode({
        id: "node-1",
        meshId: "mesh-1",
        name: "Test node",
        advertiseScope: "local",
        registeredAt: Date.now(),
      });
      store.upsertActor({
        id: "operator",
        kind: "person",
        displayName: "Operator",
      });
      store.upsertConversation({
        id: "conv-summary",
        kind: "channel",
        title: "Summary",
        visibility: "workspace",
        shareMode: "summary",
        authorityNodeId: "node-1",
        participantIds: ["operator"],
      });

      store.recordMessage({
        id: "msg-summary-1",
        conversationId: "conv-summary",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "hello from a summary conversation",
        visibility: "workspace",
        policy: "durable",
        createdAt: Date.now(),
      });

      const threadEvents = store.listThreadEvents({ conversationId: "conv-summary" });
      expect(threadEvents).toHaveLength(1);
      expect(threadEvents[0]?.seq).toBe(1);
      expect(threadEvents[0]?.kind).toBe("message.posted");
      expect((threadEvents[0]?.payload as { message?: { summary?: string; body?: string } }).message?.summary).toBe(
        "hello from a summary conversation",
      );
      expect((threadEvents[0]?.payload as { message?: { body?: string } }).message?.body).toBeUndefined();

      const snapshot = store.getThreadSnapshot("conv-summary");
      expect(snapshot?.latestSeq).toBe(1);
      expect((snapshot?.messages?.[0] as { summary?: string; body?: string } | undefined)?.summary).toBe(
        "hello from a summary conversation",
      );
      expect((snapshot?.messages?.[0] as { body?: string } | undefined)?.body).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("reads a bounded newest native thread page without scanning a whole registry snapshot", () => {
    const store = createStore();

    try {
      seedAgent(store);
      store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
      store.upsertConversation({
        id: "conv-launch",
        kind: "direct",
        title: "Launch thread",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });
      for (let index = 0; index < 4; index += 1) {
        store.recordMessage({
          id: `msg-${index}`,
          conversationId: "conv-launch",
          actorId: index % 2 === 0 ? "operator" : "agent-1",
          originNodeId: "node-1",
          class: "agent",
          body: `message ${index}`,
          visibility: "private",
          policy: "durable",
          createdAt: 1_800_000_000_000 + index,
        });
      }

      const snapshot = store.getConversationThreadLaunchSnapshot({
        conversationId: "conv-launch",
        projectionId: "projection-a",
        projectionVersion: 1,
        sequence: 9,
        limit: 2,
        generatedAt: 2_000,
      });

      expect(snapshot).toEqual({
        projectionId: "projection-a",
        projectionVersion: 1,
        sequence: 9,
        feedId: "conv:conv-launch",
        entityKind: "scout_conversation",
        conversationId: "conv-launch",
        cursor: "msg-2",
        hasEarlier: true,
        generatedAt: 2_000,
        messages: [
          {
            id: "msg-2",
            actorId: "operator",
            actorName: "Operator",
            body: "message 2",
            class: "agent",
            createdAt: 1_800_000_000_002,
          },
          {
            id: "msg-3",
            actorId: "agent-1",
            actorName: "Agent One",
            body: "message 3",
            class: "agent",
            createdAt: 1_800_000_000_003,
          },
        ],
      });
      expect(store.getConversationThreadLaunchSnapshot({
        conversationId: "missing",
        projectionId: "projection-a",
        projectionVersion: 1,
        sequence: 9,
      })).toBeNull();
    } finally {
      store.close();
    }
  });

  test("native thread index preserves mixed epoch ordering, ties and bounded page reads", () => {
    const store = createStore();
    try {
      seedAgent(store);
      store.upsertConversation({
        id: "epoch-thread", title: "Epoch ordering", kind: "channel", visibility: "private",
        shareMode: "local", authorityNodeId: "node-1", participantIds: ["agent-1"],
      });
      const records = [
        { id: "seconds-a", createdAt: 1_800_000_000 },
        { id: "seconds-z", createdAt: 1_800_000_000 },
        { id: "millis", createdAt: 1_800_000_000_001 },
        { id: "old-millis", createdAt: 1_700_000_000_000 },
        { id: "zero", createdAt: 0 },
        { id: "negative", createdAt: -1 },
      ];
      for (const record of records) store.recordMessage({
        ...record, conversationId: "epoch-thread", actorId: "agent-1",
        originNodeId: "node-1", class: "agent", visibility: "private", policy: "durable",
        body: `${record.id} 🦉\n${"body".repeat(2048)}`,
      });
      const read = () => store.getConversationThreadLaunchSnapshot({
        conversationId: "epoch-thread", projectionId: "test", projectionVersion: 1,
        sequence: 0, limit: 3, generatedAt: 0,
      });
      const indexed = read();
      expect(indexed?.messages.map((message) => message.id)).toEqual(["seconds-a", "seconds-z", "millis"]);
      expect(indexed?.hasEarlier).toBe(true);
      const db = getWritableDb(store);
      const plan = db.query(`EXPLAIN QUERY PLAN SELECT id, body FROM messages
        WHERE conversation_id = ?1 ORDER BY CASE
        WHEN created_at > 0 AND created_at < 1000000000000 THEN created_at * 1000
        ELSE created_at END DESC, id DESC LIMIT 65`).all("epoch-thread") as { detail: string }[];
      expect(plan.some((row) => row.detail.includes("idx_messages_conversation_epoch_id"))).toBe(true);
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
      const unindexed = db.query(`SELECT m.id, m.actor_id AS actorId,
        a.display_name AS actorName, m.body, m.class, m.created_at AS createdAt
        FROM messages m NOT INDEXED LEFT JOIN actors a ON a.id = m.actor_id
        WHERE m.conversation_id = ?1 ORDER BY CASE
        WHEN m.created_at > 0 AND m.created_at < 1000000000000 THEN m.created_at * 1000
        ELSE m.created_at END DESC, m.id DESC LIMIT 3`).all("epoch-thread").reverse();
      expect(indexed?.messages).toEqual(unindexed);
    } finally {
      store.close();
    }
  });

  test("indexes latest endpoint lookups used by activity projection", () => {
    const { store, dbPath } = createStoreWithPath();
    const db = new Database(dbPath, { readonly: true });

    try {
      const plan = db.query(
        `EXPLAIN QUERY PLAN
        SELECT project_root, cwd, session_id
        FROM agent_endpoints
        WHERE agent_id = ?1
        ORDER BY updated_at DESC
        LIMIT 1`,
      ).all("agent-1") as Array<{ detail?: string }>;

      expect(plan.some((row) => String(row.detail ?? "").includes("idx_agent_endpoints_agent_updated_at"))).toBe(true);
    } finally {
      db.close();
      store.close();
    }
  });

  test("stamps the agent's harness on the activity it records", () => {
    const store = createStore();
    try {
      seedAgent(store);
      store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
      store.upsertEndpoint({
        id: "endpoint-harness",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "grok-acp" as never,
        transport: "grok_acp" as never,
        state: "active",
        sessionId: "session-harness",
        projectRoot: "/repo",
        metadata: {},
      });
      store.upsertConversation({
        id: "conv-h",
        kind: "direct",
        title: "Direct",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });
      store.recordMessage({
        id: "msg-h",
        conversationId: "conv-h",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Done.",
        visibility: "private",
        policy: "durable",
        createdAt: Date.now(),
      });
      const row = getWritableDb(store).query(
        "SELECT workspace_root, json_extract(payload_json, '$.agentHarness') AS harness FROM activity_items WHERE message_id = ?1",
      ).get("msg-h") as { workspace_root: string | null; harness: string | null } | null;
      expect(row).toEqual({ workspace_root: "/repo", harness: "grok-acp" });
    } finally {
      store.close();
    }
  });

  test("advances endpoint recency from lifecycle evidence without refreshing projection replay", () => {
    const { store, dbPath } = createStoreWithPath();
    const db = new Database(dbPath, { readonly: true });
    const endpoint = {
      id: "endpoint-recency",
      agentId: "agent-1",
      nodeId: "node-1",
      harness: "codex" as const,
      transport: "codex_app_server" as const,
      state: "active" as const,
      sessionId: "session-recency",
      metadata: { lastStartedAt: 1_000 },
    };
    const updatedAt = () => (db.query(
      "SELECT updated_at FROM agent_endpoints WHERE id = ?1",
    ).get(endpoint.id) as { updated_at: number }).updated_at;

    try {
      seedAgent(store);
      store.upsertEndpoint(endpoint);
      expect(updatedAt()).toBe(1_000);

      store.upsertEndpoint({
        ...endpoint,
        state: "idle",
        metadata: { ...endpoint.metadata, lastCompletedAt: 2_000 },
      });
      expect(updatedAt()).toBe(2_000);

      store.upsertEndpoint({
        ...endpoint,
        state: "waiting",
        metadata: {},
      });
      expect(updatedAt()).toBe(2_000);
    } finally {
      db.close();
      store.close();
    }
  });

  test("creates dashboard read indexes on fresh databases", () => {
    const { store, dbPath } = createStoreWithPath();
    const db = new Database(dbPath, { readonly: true });

    try {
      const indexNames = getIndexNames(db, [
        "messages",
        "deliveries",
        "delivery_attempts",
        "durable_actions",
        "collaboration_records",
        "conversations",
        "flights",
        "activity_items",
        "budget_usage_events",
        "budget_quota_window_snapshots",
        "invocations",
        "runtime_sessions",
        "runtime_session_aliases",
      ]);

      expect(indexNames).toContain("idx_messages_created_at");
      expect(indexNames).toContain("idx_messages_actor_created_at");
      expect(indexNames).toContain("idx_deliveries_created_at");
      expect(indexNames).toContain("idx_delivery_attempts_created_at");
      expect(indexNames).toContain("idx_durable_actions_kind_due_at_updated_at");
      expect(indexNames).toContain("idx_collaboration_records_kind_state_updated_at");
      expect(indexNames).toContain("idx_collaboration_records_parent_kind_state_updated_at");
      expect(indexNames).toContain("idx_collaboration_records_owner_kind_state_updated_at");
      expect(indexNames).toContain("idx_collaboration_records_next_move_owner_kind_state_updated_at");
      expect(indexNames).toContain("idx_conversations_created_at");
      expect(indexNames).toContain("idx_flights_invocation_id");
      expect(indexNames).toContain("idx_activity_items_ts");
      expect(indexNames).toContain("idx_budget_usage_events_scope_occurred");
      expect(indexNames).toContain("idx_budget_usage_events_session_occurred");
      expect(indexNames).toContain("idx_budget_quota_windows_session_captured");
      expect(indexNames).toContain("idx_budget_quota_windows_provider_label");
      expect(indexNames).toContain("idx_invocations_requester_created_at");
      expect(indexNames).toContain("idx_runtime_sessions_agent_last_seen");
      expect(indexNames).toContain("idx_runtime_sessions_endpoint_last_seen");
      expect(indexNames).toContain("idx_runtime_sessions_external");
      expect(indexNames).toContain("idx_runtime_session_aliases_alias");
      expect(indexNames).toContain("idx_runtime_session_aliases_session");
      expect(indexNames).toContain("idx_runtime_session_aliases_endpoint");
    } finally {
      db.close();
      store.close();
    }
  });

  test("indexes endpoint alias expiration updates used by runtime session projection", () => {
    const { store, dbPath } = createStoreWithPath();
    const db = new Database(dbPath, { readonly: true });

    try {
      const plan = db.query(
        `EXPLAIN QUERY PLAN
        UPDATE runtime_session_aliases
        SET expires_at = COALESCE(expires_at, ?1),
            last_seen_at = CASE WHEN last_seen_at > ?2 THEN last_seen_at ELSE ?2 END
        WHERE endpoint_id = ?3 AND session_id != ?4`,
      ).all(2_000, 1_000, "endpoint-1", "session-1") as Array<{ detail?: string }>;

      expect(plan.some((row) =>
        String(row.detail ?? "").includes(
          "idx_runtime_session_aliases_endpoint (endpoint_id=?)",
        )
      )).toBe(true);
    } finally {
      db.close();
      store.close();
    }
  });

  test("projects runtime sessions and aliases from endpoint updates", () => {
    const store = createStore();
    const base = Date.now();

    try {
      seedAgent(store);
      store.upsertEndpoint({
        id: "endpoint-1",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        sessionId: "relay-talkie-codex",
        cwd: "/repo",
        projectRoot: "/repo",
        metadata: {
          externalSessionId: "codex-thread-1",
          threadId: "codex-thread-1",
          runtimeInstanceId: "relay-talkie-codex",
          startedAt: base - 5_000,
          lastSeenAt: base,
        },
      });

      const [session] = store.listRuntimeSessions({ agentId: "agent-1" });
      expect(session).toEqual(expect.objectContaining({
        agentId: "agent-1",
        endpointId: "endpoint-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        primaryAlias: "codex-thread-1",
        externalSessionId: "codex-thread-1",
        startedAt: base - 5_000,
        lastSeenAt: base,
      }));
      expect(session?.id.startsWith("sess.")).toBe(true);

      const aliases = store.listRuntimeSessionAliases({ sessionId: session!.id })
        .map((alias) => [alias.alias, alias.aliasKind])
        .sort((left, right) => left[0]!.localeCompare(right[0]!));
      expect(aliases).toEqual(expect.arrayContaining([
        [session!.id, "scout"],
        ["endpoint-1", "endpoint"],
        ["relay-talkie-codex", "endpoint_session"],
        ["codex-thread-1", "external"],
      ]));
      expect(store.resolveRuntimeSessionAlias("codex-thread-1")[0]?.id).toBe(session!.id);

      store.upsertEndpoint({
        id: "endpoint-1",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        sessionId: "relay-talkie-codex",
        cwd: "/repo",
        projectRoot: "/repo",
        metadata: {
          externalSessionId: "codex-thread-2",
          threadId: "codex-thread-2",
          runtimeInstanceId: "relay-talkie-codex",
          startedAt: base + 500,
          lastSeenAt: base + 1_000,
        },
      });

      const sessions = store.listRuntimeSessions({ endpointId: "endpoint-1", includeExpired: true })
        .sort((left, right) => left.primaryAlias.localeCompare(right.primaryAlias));
      expect(sessions.map((value) => value.primaryAlias)).toEqual(["codex-thread-1", "codex-thread-2"]);
      expect(sessions[0]?.state).toBe("superseded");
      expect(sessions[0]?.endedAt).toBe(base + 1_000);
      expect(sessions[0]?.expiresAt).toBeGreaterThan(base + 1_000);
      expect(sessions[1]?.state).toBe("idle");
      expect(sessions[1]?.expiresAt).toBeUndefined();

      const prune = store.pruneExpiredRuntimeSessions(base + 31 * 24 * 60 * 60 * 1000);
      expect(prune.sessionsDeleted).toBe(1);
      expect(prune.aliasesDeleted).toBeGreaterThan(0);
      expect(store.listRuntimeSessions({ endpointId: "endpoint-1", includeExpired: true })).toHaveLength(1);
      expect(store.resolveRuntimeSessionAlias("codex-thread-1", { includeExpired: true })).toHaveLength(0);
      expect(store.resolveRuntimeSessionAlias("codex-thread-2")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("records budget observations from endpoint provider metadata", () => {
    const store = createStore();

    try {
      store.upsertNode({
        id: "node-1",
        meshId: "mesh-1",
        name: "Test node",
        advertiseScope: "local",
        registeredAt: 1,
      });
      store.upsertActor({
        id: "agent-1",
        kind: "agent",
        displayName: "Agent One",
      });
      store.upsertAgent({
        id: "agent-1",
        kind: "agent",
        definitionId: "agent-1",
        displayName: "Agent One",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertActor({
        id: "agent-2",
        kind: "agent",
        displayName: "Agent Two",
      });
      store.upsertAgent({
        id: "agent-2",
        kind: "agent",
        definitionId: "agent-2",
        displayName: "Agent Two",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });

      store.upsertEndpoint({
        id: "endpoint-1",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        sessionId: "codex-session",
        cwd: "/repo",
        projectRoot: "/repo",
        metadata: {
          model: "gpt-5.4",
          lastSeenAt: 2000,
          providerMeta: {
            provider: "openai",
            observeRuntime: {
              model: "gpt-5.4",
              modelProvider: "openai",
            },
            observeUsage: {
              inputTokens: 1000,
              cacheReadInputTokens: 250,
              outputTokens: 80,
              reasoningOutputTokens: 20,
              totalTokens: 1080,
              planType: "plus",
            },
            observeQuota: {
              planType: "plus",
              capturedAt: 2000,
              windows: [
                {
                  label: "5h",
                  windowKind: "primary",
                  usedPercent: 60,
                  resetAt: 3000,
                  windowMs: 300 * 60 * 1000,
                },
                {
                  label: "weekly",
                  windowKind: "secondary",
                  percentRemaining: 72,
                  resetAt: 4000,
                  windowMs: 7 * 24 * 60 * 60 * 1000,
                },
              ],
            },
          },
        },
      });

      const usage = store.listBudgetUsageEvents({ sessionId: "codex-session" });
      expect(usage).toHaveLength(1);
      expect(usage[0]).toEqual(expect.objectContaining({
        scope: "harness_execution",
        source: "provider_session_snapshot",
        provider: "openai",
        harness: "codex",
        transport: "codex_app_server",
        model: "gpt-5.4",
        agentId: "agent-1",
        endpointId: "endpoint-1",
        sessionId: "codex-session",
        projectRoot: "/repo",
        inputTokens: 1000,
        cacheReadInputTokens: 250,
        outputTokens: 80,
        reasoningOutputTokens: 20,
        totalTokens: 1080,
        billedUsd: 0,
      }));
      expect(usage[0]?.estimatedUsd).toBeGreaterThan(0);
      expect(usage[0]?.metadata).toEqual(expect.objectContaining({
        billingMode: "subscription",
        planType: "plus",
        source: "codex.providerMeta.observeUsage",
      }));

      const quotaWindows = store.listBudgetQuotaWindowSnapshots({ sessionId: "codex-session" });
      const currentQuotaWindows = quotaWindows
        .filter((window) => !window.id.startsWith("budget:quota:history:"))
        .sort((a, b) => a.label.localeCompare(b.label));
      const historicalQuotaWindows = quotaWindows
        .filter((window) => window.id.startsWith("budget:quota:history:"))
        .sort((a, b) => a.label.localeCompare(b.label));
      expect(quotaWindows).toHaveLength(4);
      expect(currentQuotaWindows).toHaveLength(2);
      expect(historicalQuotaWindows).toHaveLength(2);
      expect(historicalQuotaWindows[0]?.metadata).toEqual(expect.objectContaining({
        historyBucketMs: 60 * 60 * 1000,
      }));
      expect(currentQuotaWindows[0]).toEqual(expect.objectContaining({
        source: "provider_reported",
        provider: "openai",
        label: "5h",
        windowKind: "primary",
        usedPercent: 60,
        percentRemaining: 40,
        resetAt: 3_000_000,
      }));
      expect(currentQuotaWindows[1]).toEqual(expect.objectContaining({
        source: "provider_reported",
        provider: "openai",
        label: "weekly",
        windowKind: "secondary",
        percentRemaining: 72,
        resetAt: 4_000_000,
      }));

      store.upsertEndpoint({
        id: "endpoint-1",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        sessionId: "codex-session",
        cwd: "/repo",
        projectRoot: "/repo",
        metadata: {
          model: "gpt-5.4",
          lastSeenAt: 2500,
          providerMeta: {
            provider: "openai",
            observeUsage: {
              inputTokens: 2200,
              outputTokens: 120,
              totalTokens: 2320,
              planType: "plus",
            },
            observeQuota: {
              planType: "plus",
              capturedAt: 2500,
              windows: [
                {
                  label: "5h",
                  windowKind: "primary",
                  usedPercent: 65,
                },
                {
                  label: "weekly",
                  windowKind: "secondary",
                  percentRemaining: 70,
                },
              ],
            },
          },
        },
      });

      const updatedUsage = store.listBudgetUsageEvents({ sessionId: "codex-session" });
      const updatedWindows = store.listBudgetQuotaWindowSnapshots({ sessionId: "codex-session" });
      expect(updatedUsage).toHaveLength(1);
      expect(updatedUsage[0]?.inputTokens).toBe(2200);
      expect(updatedWindows).toHaveLength(4);
      expect(updatedWindows.find((window) => window.label === "5h")?.usedPercent).toBe(65);

      store.upsertEndpoint({
        id: "endpoint-claude",
        agentId: "agent-2",
        nodeId: "node-1",
        harness: "claude",
        transport: "claude_stream_json",
        state: "idle",
        sessionId: "claude-session",
        cwd: "/repo",
        projectRoot: "/repo",
        metadata: {
          model: "claude-sonnet-4.5",
          lastSeenAt: 3000,
          providerMeta: {
            observeUsage: {
              inputTokens: 12,
              outputTokens: 24,
              cacheReadInputTokens: 125,
              cacheCreationInputTokens: 60,
              webSearchRequests: 1,
            },
            observeQuota: {
              planType: "max",
              capturedAt: 3000,
              windows: [
                {
                  label: "5h",
                  windowKind: "primary",
                  usedPercent: 25,
                  resetAt: 3600,
                  windowMs: 300 * 60 * 1000,
                },
                {
                  label: "weekly",
                  windowKind: "secondary",
                  percentRemaining: 64,
                  resetAt: 4000,
                  windowMs: 7 * 24 * 60 * 60 * 1000,
                },
              ],
            },
          },
        },
      });

      const claudeUsage = store.listBudgetUsageEvents({ sessionId: "claude-session" });
      expect(claudeUsage).toHaveLength(1);
      expect(claudeUsage[0]).toEqual(expect.objectContaining({
        provider: "anthropic",
        harness: "claude",
        transport: "claude_stream_json",
        model: "claude-sonnet-4.5",
        sessionId: "claude-session",
        inputTokens: 12,
        outputTokens: 24,
        cacheReadInputTokens: 125,
        cacheCreationInputTokens: 60,
        billedUsd: 0,
      }));
      expect(claudeUsage[0]?.metadata).toEqual(expect.objectContaining({
        billingMode: "subscription",
        source: "claude-code.providerMeta.observeUsage",
      }));
      const claudeQuotaWindows = store.listBudgetQuotaWindowSnapshots({ sessionId: "claude-session" });
      const currentClaudeQuotaWindows = claudeQuotaWindows
        .filter((window) => !window.id.startsWith("budget:quota:history:"))
        .sort((a, b) => a.label.localeCompare(b.label));
      const historicalClaudeQuotaWindows = claudeQuotaWindows
        .filter((window) => window.id.startsWith("budget:quota:history:"));
      expect(claudeQuotaWindows).toHaveLength(4);
      expect(currentClaudeQuotaWindows).toHaveLength(2);
      expect(historicalClaudeQuotaWindows).toHaveLength(2);
      expect(currentClaudeQuotaWindows[0]).toEqual(expect.objectContaining({
        source: "provider_reported",
        provider: "anthropic",
        harness: "claude",
        transport: "claude_stream_json",
        label: "5h",
        windowKind: "primary",
        usedPercent: 25,
        percentRemaining: 75,
        resetAt: 3_600_000,
        planType: "max",
      }));
      expect(currentClaudeQuotaWindows[0]?.metadata).toEqual(expect.objectContaining({
        source: "claude-code.providerMeta.observeQuota",
      }));
      expect(historicalClaudeQuotaWindows[0]?.metadata).toEqual(expect.objectContaining({
        historyBucketMs: 60 * 60 * 1000,
      }));
      expect(currentClaudeQuotaWindows[1]).toEqual(expect.objectContaining({
        source: "provider_reported",
        provider: "anthropic",
        label: "weekly",
        windowKind: "secondary",
        percentRemaining: 64,
        resetAt: 4_000_000,
        planType: "max",
      }));
    } finally {
      store.close();
    }
  });

  test("persists invocation collaboration record ids, including context fallback", () => {
    const { store, dbPath } = createStoreWithPath();
    const db = new Database(dbPath, { readonly: true });

    try {
      store.upsertNode({
        id: "node-1",
        meshId: "mesh-1",
        name: "Test node",
        advertiseScope: "local",
        registeredAt: Date.now(),
      });
      store.upsertActor({
        id: "operator",
        kind: "person",
        displayName: "Operator",
      });
      store.upsertActor({
        id: "agent-1",
        kind: "agent",
        displayName: "Agent One",
      });
      store.upsertAgent({
        id: "agent-1",
        kind: "agent",
        definitionId: "agent-1",
        displayName: "Agent One",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.recordCollaborationRecord({
        id: "work-1",
        kind: "work_item",
        title: "Top-level work",
        createdById: "operator",
        ownerId: "agent-1",
        nextMoveOwnerId: "agent-1",
        state: "working",
        acceptanceState: "none",
        requestedById: "operator",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      store.recordCollaborationRecord({
        id: "work-2",
        kind: "work_item",
        title: "Context work",
        createdById: "operator",
        ownerId: "agent-1",
        nextMoveOwnerId: "agent-1",
        state: "working",
        acceptanceState: "none",
        requestedById: "operator",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      store.recordInvocation({
        id: "inv-top-level",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Handle the top-level join",
        collaborationRecordId: "work-1",
        ensureAwake: true,
        stream: false,
        createdAt: Date.now(),
      });

      store.recordInvocation({
        id: "inv-context-fallback",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Handle the context join",
        context: {
          collaborationRecordId: "work-2",
        },
        ensureAwake: true,
        stream: false,
        createdAt: Date.now(),
      });

      const rows = db.query(
        `SELECT id, collaboration_record_id
         FROM invocations
         WHERE id IN ('inv-top-level', 'inv-context-fallback')
         ORDER BY id ASC`,
      ).all() as Array<{ id: string; collaboration_record_id: string | null }>;

      expect(rows).toEqual([
        { id: "inv-context-fallback", collaboration_record_id: "work-2" },
        { id: "inv-top-level", collaboration_record_id: "work-1" },
      ]);
    } finally {
      db.close();
      store.close();
    }
  });

  test("parent record upserts preserve children when SQLite foreign keys are enabled", () => {
    const store = createStore();
    const db = getWritableDb(store);
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      store.upsertNode({
        id: "node-1",
        meshId: "mesh-1",
        name: "Test node",
        advertiseScope: "local",
        registeredAt: 1,
      });
      store.upsertActor({
        id: "operator",
        kind: "person",
        displayName: "Operator",
      });
      store.upsertActor({
        id: "agent-1",
        kind: "agent",
        displayName: "Agent One",
      });
      store.upsertAgent({
        id: "agent-1",
        kind: "agent",
        definitionId: "agent-1",
        displayName: "Agent One",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertConversation({
        id: "conv-1",
        kind: "direct",
        title: "Direct",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });

      const message = {
        id: "msg-1",
        conversationId: "conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent" as const,
        body: "hello",
        visibility: "private" as const,
        policy: "durable" as const,
        createdAt: 100,
      };
      store.recordMessage(message);
      store.recordDeliveries([{
        id: "delivery-msg-1",
        messageId: "msg-1",
        targetId: "agent-1",
        targetKind: "agent",
        transport: "local_socket",
        reason: "direct_message",
        policy: "best_effort",
        status: "accepted",
      }]);
      const beforeCorrectionEvents = store.listThreadEvents({ conversationId: "conv-1" }).length;
      const correction = { revision: 1, editedAt: 200, changedBy: "operator" };
      expect(store.recordMessage({ ...message, body: "hello again", metadata: { chatCorrection: correction } })).toEqual([]);
      expect(store.listThreadEvents({ conversationId: "conv-1" })).toHaveLength(beforeCorrectionEvents);
      const correctedRow = db.query("SELECT body, metadata_json, created_at FROM messages WHERE id = 'msg-1'").get() as { body: string; metadata_json: string; created_at: number };
      expect(correctedRow.body).toBe("hello again");
      expect(JSON.parse(correctedRow.metadata_json).chatCorrection).toEqual(correction);
      expect(correctedRow.created_at).toBe(100);
      expect(countRows(db, "deliveries", "message_id", "msg-1")).toBe(1);

      const invocation = {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult" as const,
        task: "Handle this",
        ensureAwake: true,
        stream: false,
        labels: ["release:0.2.66"],
        createdAt: 110,
      };
      store.recordInvocation(invocation);
      store.recordFlight({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        labels: ["release:0.2.66"],
        startedAt: 120,
      });
      store.recordInvocation({ ...invocation, task: "Handle this updated" });
      expect(countRows(db, "flights", "invocation_id", "inv-1")).toBe(1);
      expect((db.query("SELECT labels_json FROM flights WHERE id = 'flight-1'").get() as { labels_json: string } | null)?.labels_json)
        .toBe("[\"release:0.2.66\"]");

      const collaborationRecord = {
        id: "work-1",
        kind: "work_item" as const,
        title: "Top-level work",
        createdById: "operator",
        ownerId: "agent-1",
        nextMoveOwnerId: "agent-1",
        state: "working" as const,
        acceptanceState: "none" as const,
        requestedById: "operator",
        createdAt: 130,
        updatedAt: 130,
      };
      store.recordCollaborationRecord(collaborationRecord);
      store.recordCollaborationEvent({
        id: "collab-event-1",
        recordId: "work-1",
        recordKind: "work_item",
        kind: "commented",
        actorId: "operator",
        at: 140,
      });
      store.recordCollaborationRecord({
        ...collaborationRecord,
        state: "completed",
        updatedAt: 150,
        completedAt: 150,
      });
      expect(countRows(db, "collaboration_events", "record_id", "work-1")).toBe(1);

      store.recordDurableAction({
        id: "action-1",
        kind: "message_delivery",
        subjectId: "delivery-msg-1",
        authorityCellId: "node-1",
        state: "pending",
        idempotencyKey: "delivery-msg-1:create",
        leaseGeneration: 0,
        createdAt: 190,
        updatedAt: 190,
      });
      store.recordDurableAttempt({
        id: "attempt-1",
        actionId: "action-1",
        attempt: 1,
        state: "running",
        leaseGeneration: 1,
        startedAt: 200,
      });
      store.recordDurableAction({
        id: "action-1",
        kind: "message_delivery",
        subjectId: "delivery-msg-1",
        authorityCellId: "node-1",
        state: "running",
        idempotencyKey: "delivery-msg-1:create",
        leaseGeneration: 1,
        createdAt: 190,
        updatedAt: 210,
      });
      store.recordDurableAction({
        id: "action-duplicate-idempotency",
        kind: "message_delivery",
        subjectId: "delivery-msg-1",
        authorityCellId: "node-1",
        state: "running",
        idempotencyKey: "delivery-msg-1:create",
        leaseGeneration: 1,
        createdAt: 190,
        updatedAt: 220,
      });
      expect(countRows(db, "durable_attempts", "action_id", "action-1")).toBe(1);
      expect(countRows(db, "durable_actions", "id", "action-duplicate-idempotency")).toBe(0);
    } finally {
      store.close();
    }
  });

  test("migrates legacy databases to add invocation collaboration joins", () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-store-"));
    dbRoots.add(root);
    const dbPath = join(root, "control-plane.sqlite");

    {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS flights (
          id TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          state TEXT NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS activity_items (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          ts INTEGER NOT NULL,
          conversation_id TEXT,
          agent_id TEXT,
          actor_id TEXT,
          workspace_root TEXT,
          session_id TEXT
        );
        CREATE TABLE IF NOT EXISTS invocations (
          id TEXT PRIMARY KEY,
          requester_id TEXT NOT NULL,
          requester_node_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          target_node_id TEXT,
          action TEXT NOT NULL,
          task TEXT NOT NULL,
          conversation_id TEXT,
          message_id TEXT,
          context_json TEXT,
          execution_json TEXT,
          ensure_awake INTEGER NOT NULL DEFAULT 1,
          stream INTEGER NOT NULL DEFAULT 1,
          timeout_ms INTEGER,
          metadata_json TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      legacyDb.close();
    }

    const store = new SQLiteControlPlaneStore(dbPath);
    const db = new Database(dbPath, { readonly: true });

    try {
      const invocationColumns = db.query("SELECT name FROM pragma_table_info('invocations')").all() as Array<{ name: string }>;
      const flightColumns = db.query("SELECT name FROM pragma_table_info('flights')").all() as Array<{ name: string }>;
      const indexNames = getIndexNames(db, ["conversations", "flights", "activity_items", "invocations"]);

      expect(invocationColumns.some((column) => column.name === "collaboration_record_id")).toBe(true);
      expect(invocationColumns.some((column) => column.name === "labels_json")).toBe(true);
      expect(flightColumns.some((column) => column.name === "labels_json")).toBe(true);
      expect(indexNames).toContain("idx_invocations_collaboration_record_id_created_at");
      expect(indexNames).toContain("idx_invocations_requester_created_at");
      expect(indexNames).toContain("idx_flights_invocation_id");
      expect(indexNames).toContain("idx_activity_items_ts");
      expect(indexNames).toContain("idx_conversations_created_at");
    } finally {
      db.close();
      store.close();
    }
  });

  test("stamps the control-plane user_version on startup", () => {
    const { store, dbPath } = createStoreWithPath();
    const db = new Database(dbPath, { readonly: true });

    try {
      const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
      expect(row?.user_version).toBe(CONTROL_PLANE_SCHEMA_VERSION);
    } finally {
      db.close();
      store.close();
    }
  });

  test("migrates current-version databases missing runtime session mapping tables", () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-store-"));
    dbRoots.add(root);
    const dbPath = join(root, "control-plane.sqlite");

    {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA user_version = ${CONTROL_PLANE_SCHEMA_VERSION};
      `);
      legacyDb.close();
    }

    const store = new SQLiteControlPlaneStore(dbPath);
    const db = new Database(dbPath, { readonly: true });

    try {
      const tables = db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runtime_sessions', 'runtime_session_aliases') ORDER BY name",
      ).all() as Array<{ name: string }>;
      const indexNames = getIndexNames(db, ["runtime_sessions", "runtime_session_aliases"]);

      expect(tables.map((table) => table.name)).toEqual([
        "runtime_session_aliases",
        "runtime_sessions",
      ]);
      expect(indexNames).toContain("idx_runtime_sessions_agent_last_seen");
      expect(indexNames).toContain("idx_runtime_sessions_endpoint_last_seen");
      expect(indexNames).toContain("idx_runtime_sessions_external");
      expect(indexNames).toContain("idx_runtime_sessions_expires");
      expect(indexNames).toContain("idx_runtime_session_aliases_alias");
      expect(indexNames).toContain("idx_runtime_session_aliases_session");
      expect(indexNames).toContain("idx_runtime_session_aliases_endpoint");
      expect(indexNames).toContain("idx_runtime_session_aliases_expires");
    } finally {
      db.close();
      store.close();
    }
  });

  test("migrates schema version 5 databases to durable action ledger tables", () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-sqlite-store-"));
    dbRoots.add(root);
    const dbPath = join(root, "control-plane.sqlite");

    {
      const legacyDb = new Database(dbPath);
      legacyDb.exec("PRAGMA user_version = 5;");
      legacyDb.close();
    }

    const store = new SQLiteControlPlaneStore(dbPath);
    const db = new Database(dbPath, { readonly: true });

    try {
      const tables = db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'durable_%' ORDER BY name",
      ).all() as Array<{ name: string }>;
      const version = db.query("PRAGMA user_version").get() as { user_version: number } | null;

      expect(tables.map((table) => table.name)).toEqual([
        "durable_actions",
        "durable_attempts",
        "durable_checkpoints",
        "durable_signals",
      ]);
      expect(version?.user_version).toBe(CONTROL_PLANE_SCHEMA_VERSION);
    } finally {
      db.close();
      store.close();
    }
  });

  test("reuses delivery upsert preparation and source timestamps while preserving conflict updates", () => {
    const store = createStore();
    const db = getWritableDb(store);
    const internals = store as unknown as {
      deliveryCreatedAt: (
        delivery: Parameters<SQLiteControlPlaneStore["recordDeliveries"]>[0][number],
      ) => number;
    };
    const deliveryCreatedAt = internals.deliveryCreatedAt;
    let createdAtLookups = 0;

    try {
      seedAgent(store);
      store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
      store.recordInvocation({
        id: "inv-delivery",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Deliver this",
        ensureAwake: true,
        stream: false,
        createdAt: 100,
      });
      internals.deliveryCreatedAt = (delivery) => {
        createdAtLookups += 1;
        return deliveryCreatedAt.call(store, delivery);
      };

      const first = {
        id: "delivery-upsert-1",
        invocationId: "inv-delivery",
        targetId: "agent-1",
        targetNodeId: "node-1",
        targetKind: "agent" as const,
        transport: "peer_broker" as const,
        reason: "invocation" as const,
        policy: "must_ack" as const,
        status: "accepted" as const,
        metadata: { version: 1 },
      };
      store.recordDeliveries([
        first,
        { ...first, id: "delivery-upsert-2" },
      ]);
      expect(createdAtLookups).toBe(1);

      store.recordDeliveries([{
        ...first,
        targetId: "agent-updated",
        transport: "local_socket",
        policy: "durable",
        status: "deferred",
        leaseOwner: "worker-1",
        leaseExpiresAt: 500,
        metadata: { version: 2, nextAttemptAt: 400 },
      }]);
      expect(createdAtLookups).toBe(2);
      expect(store.listDeliveries().find((delivery) => delivery.id === first.id)).toEqual({
        id: "delivery-upsert-1",
        invocationId: "inv-delivery",
        targetId: "agent-updated",
        targetNodeId: "node-1",
        targetKind: "agent",
        transport: "local_socket",
        reason: "invocation",
        policy: "durable",
        status: "deferred",
        leaseOwner: "worker-1",
        leaseExpiresAt: 500,
        metadata: { version: 2, nextAttemptAt: 400 },
      });
      expect((db.query(
        "SELECT created_at FROM deliveries WHERE id = ?1",
      ).get(first.id) as { created_at: number }).created_at).toBe(100_000);

      expect(() => store.recordDeliveries([
        { ...first, id: "delivery-atomic-valid" },
        { ...first, id: "delivery-atomic-invalid", invocationId: "missing-invocation" },
      ])).toThrow();
      expect(countRows(db, "deliveries", "id", "delivery-atomic-valid")).toBe(0);
    } finally {
      internals.deliveryCreatedAt = deliveryCreatedAt;
      store.close();
    }
  });

  test("round-trips deliveries and delivery attempts through the Drizzle proof path", () => {
    const store = createStore();

    try {
      store.recordDeliveries([
        {
          id: "delivery-1",
          targetId: "peer-node",
          targetKind: "node",
          transport: "peer_broker",
          reason: "invocation",
          policy: "must_ack",
          status: "accepted",
          metadata: {
            firstAttemptQueuedAt: 100,
          },
        },
        {
          id: "delivery-2",
          targetId: "thread-1",
          targetKind: "binding",
          transport: "thread_binding",
          reason: "message",
          policy: "best_effort",
          status: "accepted",
        },
      ]);

      store.updateDeliveryStatus("delivery-1", "peer_acked", {
        metadata: {
          peerAckedAt: 200,
        },
      });
      store.recordDeliveryAttempt({
        id: "attempt-1",
        deliveryId: "delivery-1",
        attempt: 1,
        status: "acknowledged",
        externalRef: "peer-flight-1",
        createdAt: 250,
        metadata: {
          durationMs: 50,
        },
      });

      expect(store.listDeliveries({ transport: "peer_broker" })).toEqual([
        {
          id: "delivery-1",
          targetId: "peer-node",
          targetKind: "node",
          transport: "peer_broker",
          reason: "invocation",
          policy: "must_ack",
          status: "peer_acked",
          metadata: {
            firstAttemptQueuedAt: 100,
            peerAckedAt: 200,
          },
        },
      ]);
      expect(store.listDeliveries({ status: "accepted" })).toEqual([
        {
          id: "delivery-2",
          targetId: "thread-1",
          targetKind: "binding",
          transport: "thread_binding",
          reason: "message",
          policy: "best_effort",
          status: "accepted",
          metadata: undefined,
        },
      ]);
      expect(store.listDeliveryAttempts("delivery-1")).toEqual([
        {
          id: "attempt-1",
          deliveryId: "delivery-1",
          attempt: 1,
          status: "acknowledged",
          externalRef: "peer-flight-1",
          createdAt: 250,
          metadata: {
            durationMs: 50,
          },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("inbox filters run before the database page limit", () => {
    const store = createStore();
    try {
      store.recordDeliveries(Array.from({ length: 5_001 }, (_, index) => ({
        id: `old-${index}`, targetId: index % 2 ? "other" : "wanted", targetKind: "agent" as const,
        transport: "local_socket" as const, reason: "direct_message" as const,
        policy: "durable" as const, status: "completed" as const,
      })));
      store.recordDeliveries([{ id: "pending-inbox", targetId: "wanted", targetKind: "agent", transport: "local_socket",
        reason: "invocation", policy: "durable", status: "accepted" }]);
      expect(store.listDeliveries({ targetId: "wanted", statuses: ["accepted"], reasons: ["invocation"], limit: 1 }).map(item => item.id)).toEqual(["pending-inbox"]);
      expect(store.listDeliveries({ targetId: "wanted", statuses: [], limit: 1 })).toEqual([]);
    } finally { store.close(); }
  });

  test("enforces durable action idempotency, leases, attempts, and first-write-wins facts", () => {
    const store = createStore();

    try {
      const created = store.createOrGetDurableAction({
        id: "action-1",
        kind: "message_delivery",
        subjectId: "delivery-1",
        authorityCellId: "node-1",
        idempotencyKey: "delivery-1:create",
        createdAt: 100,
        metadata: { source: "test" },
      });
      expect(created.duplicate).toBe(false);
      expect(created.action.state).toBe("pending");

      const duplicate = store.createOrGetDurableAction({
        id: "action-duplicate",
        kind: "message_delivery",
        subjectId: "delivery-other",
        authorityCellId: "node-1",
        idempotencyKey: "delivery-1:create",
        createdAt: 101,
      });
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.action.id).toBe("action-1");
      expect(store.getDurableActionByIdempotencyKey({
        authorityCellId: "node-1",
        kind: "message_delivery",
        idempotencyKey: "delivery-1:create",
      })?.id).toBe("action-1");
      expect(store.getDurableActionByIdempotencyKey({
        authorityCellId: "node-other",
        kind: "message_delivery",
        idempotencyKey: "delivery-1:create",
      })).toBeNull();
      expect(store.getDurableActionByIdempotencyKey({
        authorityCellId: "node-1",
        kind: "ask",
        idempotencyKey: "delivery-1:create",
      })).toBeNull();
      expect(store.getDurableActionByIdempotencyKey({
        authorityCellId: "node-1",
        kind: "message_delivery",
        idempotencyKey: "delivery-other:create",
      })).toBeNull();

      const claimed = store.claimDurableAction({
        actionId: "action-1",
        owner: "worker-a",
        leaseMs: 30_000,
        claimedAt: 200,
      });
      expect(claimed?.state).toBe("leased");
      expect(claimed?.leaseOwner).toBe("worker-a");
      expect(claimed?.leaseGeneration).toBe(1);

      const blockedClaim = store.claimDurableAction({
        actionId: "action-1",
        owner: "worker-b",
        leaseMs: 30_000,
        claimedAt: 250,
      });
      expect(blockedClaim?.leaseOwner).toBe("worker-a");
      expect(blockedClaim?.leaseGeneration).toBe(1);

      const heartbeat = store.heartbeatDurableAction({
        actionId: "action-1",
        owner: "worker-a",
        generation: 1,
        leaseMs: 60_000,
        heartbeatAt: 275,
      });
      expect(heartbeat?.leaseExpiresAt).toBe(60_275);
      expect(store.heartbeatDurableAction({
        actionId: "action-1",
        owner: "worker-b",
        generation: 1,
        leaseMs: 60_000,
        heartbeatAt: 276,
      })).toBeNull();

      const attempt = store.startDurableAttempt({
        id: "attempt-1",
        actionId: "action-1",
        owner: "worker-a",
        generation: 1,
        startedAt: 300,
      });
      expect(attempt?.attempt).toBe(1);

      const running = store.transitionDurableAction({
        actionId: "action-1",
        owner: "worker-a",
        generation: 1,
        nextState: "running",
        transitionedAt: 350,
      });
      expect(running?.state).toBe("running");

      expect(store.startDurableAttempt({
        id: "attempt-stale",
        actionId: "action-1",
        owner: "worker-b",
        generation: 1,
        startedAt: 301,
      })).toBeNull();

      expect(() => store.recordDurableAttempt({
        id: "attempt-conflict",
        actionId: "action-1",
        attempt: 1,
        state: "running",
        leaseGeneration: 1,
        startedAt: 302,
      })).toThrow();
      expect(store.listDurableAttempts("action-1")).toHaveLength(1);

      const checkpoint = store.commitDurableCheckpoint({
        actionId: "action-1",
        name: "peer_acked",
        payload: { peerFlightId: "flight-1" },
        ownerAttemptId: "attempt-1",
        leaseOwner: "worker-a",
        leaseGeneration: 1,
        createdAt: 400,
      });
      expect(checkpoint?.duplicate).toBe(false);
      const duplicateCheckpoint = store.commitDurableCheckpoint({
        actionId: "action-1",
        name: "peer_acked",
        payload: { peerFlightId: "flight-ignored" },
        leaseOwner: "worker-a",
        leaseGeneration: 1,
        createdAt: 401,
      });
      expect(duplicateCheckpoint?.duplicate).toBe(true);
      expect(duplicateCheckpoint?.checkpoint.payload).toEqual({ peerFlightId: "flight-1" });

      const signal = store.emitDurableSignal({
        actionId: "action-1",
        name: "cancel_requested",
        payload: { by: "operator" },
        leaseOwner: "worker-a",
        leaseGeneration: 1,
        emittedAt: 500,
      });
      expect(signal?.duplicate).toBe(false);
      const duplicateSignal = store.emitDurableSignal({
        actionId: "action-1",
        name: "cancel_requested",
        payload: { by: "other" },
        leaseOwner: "worker-a",
        leaseGeneration: 1,
        emittedAt: 501,
      });
      expect(duplicateSignal?.duplicate).toBe(true);
      expect(duplicateSignal?.signal.payload).toEqual({ by: "operator" });

      const reclaimed = store.claimDurableAction({
        actionId: "action-1",
        owner: "worker-c",
        leaseMs: 30_000,
        claimedAt: 60_276,
      });
      expect(reclaimed?.state).toBe("leased");
      expect(reclaimed?.leaseOwner).toBe("worker-c");
      expect(reclaimed?.leaseGeneration).toBe(2);

      expect(store.commitDurableCheckpoint({
        actionId: "action-1",
        name: "stale",
        payload: { ignored: true },
        ownerAttemptId: "attempt-1",
        leaseOwner: "worker-a",
        leaseGeneration: 1,
        createdAt: 402,
      })).toBeNull();
      expect(store.emitDurableSignal({
        actionId: "action-1",
        name: "stale_signal",
        payload: { ignored: true },
        leaseOwner: "worker-a",
        leaseGeneration: 1,
        emittedAt: 502,
      })).toBeNull();

      expect(store.transitionDurableAction({
        actionId: "action-1",
        owner: "worker-b",
        generation: 1,
        nextState: "completed",
        transitionedAt: 600,
      })).toBeNull();

      const completed = store.transitionDurableAction({
        actionId: "action-1",
        owner: "worker-c",
        generation: 2,
        nextState: "completed",
        transitionedAt: 650,
      });
      expect(completed?.state).toBe("completed");
    } finally {
      store.close();
    }
  });

  test("lists due checkback durable actions that are claimable", () => {
    const store = createStore();

    try {
      store.createOrGetDurableAction({
        id: "checkback-due",
        kind: "checkback",
        subjectId: "reminder-1",
        authorityCellId: "node-1",
        idempotencyKey: "reminder-1",
        createdAt: 100,
        metadata: {
          dueAt: 1_000,
          mode: "scoutbot",
          body: "check lattices status",
        },
      });
      store.createOrGetDurableAction({
        id: "checkback-future",
        kind: "checkback",
        subjectId: "reminder-2",
        authorityCellId: "node-1",
        createdAt: 101,
        metadata: {
          dueAt: 10_000,
          mode: "notify",
          body: "later",
        },
      });
      store.createOrGetDurableAction({
        id: "delivery-due",
        kind: "message_delivery",
        subjectId: "delivery-1",
        authorityCellId: "node-1",
        createdAt: 102,
        metadata: {
          dueAt: 1_000,
        },
      });

      expect(store.listDueDurableActions({
        kind: "checkback",
        dueAtLte: 1_500,
      }).map((action) => action.id)).toEqual(["checkback-due"]);

      const claimed = store.claimDurableAction({
        actionId: "checkback-due",
        owner: "checkback-worker",
        leaseMs: 30_000,
        claimedAt: 1_600,
      });
      expect(claimed?.state).toBe("leased");
      expect(store.listDueDurableActions({
        kind: "checkback",
        dueAtLte: 2_000,
        claimableAt: 2_000,
      })).toEqual([]);

      expect(store.listDueDurableActions({
        kind: "checkback",
        dueAtLte: 32_000,
        claimableAt: 32_000,
      }).map((action) => action.id)).toEqual(["checkback-due", "checkback-future"]);

      const completed = store.transitionDurableAction({
        actionId: "checkback-due",
        owner: "checkback-worker",
        generation: 1,
        nextState: "completed",
        transitionedAt: 32_100,
      });
      expect(completed?.state).toBe("completed");
      expect(store.listDueDurableActions({
        kind: "checkback",
        dueAtLte: 32_200,
        claimableAt: 32_200,
      }).map((action) => action.id)).toEqual(["checkback-future"]);
    } finally {
      store.close();
    }
  });
});

describe("invocation flight-status shadow columns", () => {
  // Phase 3 flight→invocation storage merge: recordFlight dual-writes the
  // flight's status onto the invocation row (web reads project from these
  // columns since the read switch), and the invocation-flight-status-reconcile
  // repair entry converges any diverged shadow on every boot.
  const invocation = {
    id: "inv-status-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult" as const,
    task: "Handle this",
    ensureAwake: true,
    stream: false,
    createdAt: 100,
  };

  type ShadowRow = {
    flight_id: string | null;
    state: string | null;
    summary: string | null;
    output: string | null;
    error: string | null;
    started_at: number | null;
    completed_at: number | null;
    flight_metadata_json: string | null;
  };

  function shadowRow(db: Database, invocationId = "inv-status-1"): ShadowRow {
    return db.query(
      `SELECT flight_id, state, summary, output, error, started_at, completed_at, flight_metadata_json
       FROM invocations WHERE id = ?1`,
    ).get(invocationId) as ShadowRow;
  }

  function seedInvocation(store: SQLiteControlPlaneStore): void {
    seedAgent(store);
    store.upsertActor({
      id: "operator",
      kind: "person",
      displayName: "Operator",
    });
    store.recordInvocation(invocation);
  }

  test("recordInvocation keeps a mesh-forwarded invocation whose message and work record live on the sender", () => {
    const store = createStore();
    try {
      seedAgent(store);
      store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
      store.recordInvocation({
        ...invocation,
        id: "inv-forwarded-1",
        messageId: "msg-on-sender",
        collaborationRecordId: "work-on-sender",
      });
      store.recordFlight({
        id: "flight-forwarded-1",
        invocationId: "inv-forwarded-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        startedAt: 120,
      });

      const db = getWritableDb(store);
      expect(db.query(
        "SELECT message_id, collaboration_record_id FROM invocations WHERE id = 'inv-forwarded-1'",
      ).get()).toEqual({ message_id: null, collaboration_record_id: null });
      expect(db.query("SELECT invocation_id FROM flights WHERE id = 'flight-forwarded-1'").get())
        .toEqual({ invocation_id: "inv-forwarded-1" });
    } finally {
      store.close();
    }
  });

  test("recordFlight dual-writes the flight status onto the invocation row", () => {
    const store = createStore();
    try {
      seedInvocation(store);
      const db = getWritableDb(store);
      expect(shadowRow(db).state).toBeNull();

      store.recordFlight({
        id: "flight-status-1",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        startedAt: 120,
        metadata: { dispatchAck: { strategy: "spawn" } },
      });
      expect(shadowRow(db)).toEqual({
        flight_id: "flight-status-1",
        state: "running",
        summary: null,
        output: null,
        error: null,
        started_at: 120,
        completed_at: null,
        flight_metadata_json: JSON.stringify({ dispatchAck: { strategy: "spawn" } }),
      });

      store.recordFlight({
        id: "flight-status-1",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Done",
        output: "All good",
        startedAt: 120,
        completedAt: 180,
      });
      expect(shadowRow(db)).toEqual({
        flight_id: "flight-status-1",
        state: "completed",
        summary: "Done",
        output: "All good",
        error: null,
        started_at: 120,
        completed_at: 180,
        flight_metadata_json: null,
      });
    } finally {
      store.close();
    }
  });

  test("recordFlight updates a flight without deleting referencing activity", () => {
    const store = createStore();
    try {
      seedInvocation(store);
      store.recordFlight({
        id: "flight-status-1",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        startedAt: 120,
      });

      const db = getWritableDb(store);
      db.query(
        `INSERT INTO activity_items (id, kind, ts, invocation_id, flight_id, title)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).run(
        "activity:flight:auxiliary",
        "flight_updated",
        121,
        "inv-status-1",
        "flight-status-1",
        "Independent flight activity",
      );

      store.recordFlight({
        id: "flight-status-1",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Done",
        output: "All good",
        startedAt: 120,
        completedAt: 180,
      });

      expect(db.query(
        "SELECT title FROM activity_items WHERE id = ?1",
      ).get("activity:flight:auxiliary")).toEqual({
        title: "Independent flight activity",
      });
      expect(db.query(
        `SELECT state, summary, output, started_at, completed_at
         FROM flights WHERE id = ?1`,
      ).get("flight-status-1")).toEqual({
        state: "completed",
        summary: "Done",
        output: "All good",
        started_at: 120,
        completed_at: 180,
      });
    } finally {
      store.close();
    }
  });

  test("an out-of-order write of an older sibling flight does not regress the shadow", () => {
    // Reproduced by adversarial review on #295: without the freshness guard,
    // last-writer-wins let a stale sibling flight overwrite a newer one.
    const store = createStore();
    try {
      seedInvocation(store);
      store.recordFlight({
        id: "flight-order-new",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Newest",
        startedAt: 250,
        completedAt: 300,
      });
      store.recordFlight({
        id: "flight-order-old",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        startedAt: 50,
      });

      const db = getWritableDb(store);
      const row = shadowRow(db);
      expect(row.flight_id).toBe("flight-order-new");
      expect(row.state).toBe("completed");
      expect(row.completed_at).toBe(300);
      // The sibling flight itself was still recorded.
      expect(countRows(db, "flights", "invocation_id", "inv-status-1")).toBe(2);
    } finally {
      store.close();
    }
  });

  test("rewrites of the shadowed flight itself always land, even with older timestamps", () => {
    const store = createStore();
    try {
      seedInvocation(store);
      store.recordFlight({
        id: "flight-status-1",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Done",
        startedAt: 120,
        completedAt: 180,
      });
      // Reconciliation rewriting the same flight must follow the flights row,
      // not be blocked by the invocation-shadow freshness guard.
      store.recordFlight({
        id: "flight-status-1",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        error: "reconciled",
        startedAt: 120,
      });

      const row = shadowRow(getWritableDb(store));
      expect(row.flight_id).toBe("flight-status-1");
      expect(row.state).toBe("failed");
      expect(row.error).toBe("reconciled");
      expect(row.completed_at).toBeNull();
    } finally {
      store.close();
    }
  });

  test("replaying recordInvocation preserves the dual-written status", () => {
    const store = createStore();
    try {
      seedInvocation(store);
      store.recordFlight({
        id: "flight-status-1",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Done",
        startedAt: 120,
        completedAt: 180,
      });

      store.recordInvocation({ ...invocation, task: "Handle this updated" });

      const db = getWritableDb(store);
      const row = shadowRow(db);
      expect(row.state).toBe("completed");
      expect(row.flight_id).toBe("flight-status-1");
      const task = db.query(
        "SELECT task FROM invocations WHERE id = 'inv-status-1'",
      ).get() as { task: string };
      expect(task.task).toBe("Handle this updated");
    } finally {
      store.close();
    }
  });

  test("the migration backfills the shadow from each invocation's latest flight", () => {
    const store = createStore();
    try {
      seedInvocation(store);
      // Two flights for one invocation; the backfill must pick the one with
      // the latest COALESCE(completed_at, started_at).
      store.recordFlight({
        id: "flight-old",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        error: "boom",
        startedAt: 110,
        completedAt: 150,
      });
      store.recordFlight({
        id: "flight-new",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Recovered",
        startedAt: 160,
        completedAt: 200,
      });

      // Simulate a database written before the dual-write existed: the flights
      // are there, but the invocation's shadow columns were never populated.
      const db = getWritableDb(store);
      db.exec(
        `UPDATE invocations SET
           flight_id = NULL, state = NULL, summary = NULL, output = NULL,
           error = NULL, started_at = NULL, completed_at = NULL
         WHERE id = 'inv-status-1'`,
      );

      applyControlPlaneSchemaMigrations(db);

      expect(shadowRow(db)).toEqual({
        flight_id: "flight-new",
        state: "completed",
        summary: "Recovered",
        output: null,
        error: null,
        started_at: 160,
        completed_at: 200,
        flight_metadata_json: null,
      });
    } finally {
      store.close();
    }
  });

  test("the reconcile converges a diverged shadow to the computed latest flight on every boot", () => {
    // The repair layer never trusts the shadow: whatever diverged it, the
    // shadow converges to the latest flight on the next boot. It cannot
    // fight the dual-write: both layers order by
    // COALESCE(completed_at, started_at) with ties to the most recent write.
    const store = createStore();
    try {
      seedInvocation(store);
      store.recordFlight({
        id: "flight-earlier",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        startedAt: 300,
      });
      store.recordFlight({
        id: "flight-latest",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        error: "boom",
        startedAt: 100,
        completedAt: 400,
        metadata: { failureStage: "transport" },
      });
      const db = getWritableDb(store);
      // Force the shadow onto the older sibling to simulate divergence.
      db.exec(
        "UPDATE invocations SET flight_id = 'flight-earlier', state = 'running', flight_metadata_json = NULL WHERE id = 'inv-status-1'",
      );

      applyControlPlaneSchemaMigrations(db);

      expect(shadowRow(db)).toEqual({
        flight_id: "flight-latest",
        state: "failed",
        summary: null,
        output: null,
        error: "boom",
        started_at: 100,
        completed_at: 400,
        flight_metadata_json: JSON.stringify({ failureStage: "transport" }),
      });
    } finally {
      store.close();
    }
  });

  test("old flight receipt acknowledgements preserve current selection and row order across reopen", () => {
    const fixture = createStoreWithPath();
    let store = fixture.store;
    try {
      seedInvocation(store);
      const first = { id: "report-first", invocationId: invocation.id, requesterId: "operator", targetAgentId: "agent-1",
        state: "failed" as const, completedAt: 520, summary: "first failure" };
      store.recordFlight(first);
      store.recordFlight({ ...first, id: "report-second", summary: "second failure" });
      const originalRow = getWritableDb(store).query("SELECT rowid FROM flights WHERE id = ?1").get(first.id);
      store.recordFlight({ ...first, metadata: { terminalReport: { status: "delivered" } } }, { preserveCurrent: true });
      expect(shadowRow(getWritableDb(store)).flight_id).toBe("report-second");
      expect(getWritableDb(store).query("SELECT rowid FROM flights WHERE id = ?1").get(first.id)).toEqual(originalRow);
      store.close(); store = new SQLiteControlPlaneStore(fixture.dbPath);
      expect(shadowRow(getWritableDb(store)).flight_id).toBe("report-second");
      expect(getWritableDb(store).query("SELECT metadata_json FROM flights WHERE id = ?1").get(first.id))
        .toEqual({ metadata_json: JSON.stringify({ terminalReport: { status: "delivered" } }) });
    } finally { store.close(); }
  });

  test("equal-timestamp flight rewrites survive activity references and remain latest after reconcile", () => {
    // Equal timestamps resolve by write order: the most recent statement
    // about an invocation's status stands. Both layers implement it: the live
    // guard accepts `>=`, while inserts and conflict updates advance rowid for
    // the boot-time reconcile without deleting the flight's child activity.
    const store = createStore();
    try {
      seedInvocation(store);
      store.recordFlight({
        id: "flight-tie-a",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "First write",
        startedAt: 500,
        completedAt: 520,
      });
      store.recordFlight({
        id: "flight-tie-b",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        error: "Second write",
        startedAt: 500,
        completedAt: 520,
      });

      const db = getWritableDb(store);
      expect(shadowRow(db).flight_id).toBe("flight-tie-b");
      expect(shadowRow(db).state).toBe("failed");
      db.query(
        `INSERT INTO activity_items (id, kind, ts, invocation_id, flight_id, title)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).run(
        "activity:flight:tie-a-auxiliary",
        "flight_updated",
        521,
        "inv-status-1",
        "flight-tie-a",
        "Retained tie activity",
      );

      store.recordFlight({
        id: "flight-tie-a",
        invocationId: "inv-status-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Third write",
        output: "Rewritten A",
        startedAt: 500,
        completedAt: 520,
      });

      expect(shadowRow(db).flight_id).toBe("flight-tie-a");
      expect(shadowRow(db).summary).toBe("Third write");
      expect(db.query(
        "SELECT title FROM activity_items WHERE id = ?1",
      ).get("activity:flight:tie-a-auxiliary")).toEqual({
        title: "Retained tie activity",
      });

      // The boot-time reconcile computes the same winner, so a restart cannot
      // flip the tie back to sibling B.
      applyControlPlaneSchemaMigrations(db);
      expect(shadowRow(db).flight_id).toBe("flight-tie-a");
      expect(shadowRow(db).summary).toBe("Third write");
      expect(db.query(
        "SELECT title FROM activity_items WHERE id = ?1",
      ).get("activity:flight:tie-a-auxiliary")).toEqual({
        title: "Retained tie activity",
      });
    } finally {
      store.close();
    }
  });

  test("recordFlight normalizes requester/target to the invocation's identity", () => {
    // The invocation is the identity authority; a flight is its status. Every
    // broker path already passes matching values — this guards the raw
    // FlightRecord surface (/v1/flights), so divergent identity fields can
    // never enter storage and disagree with what readers project from the
    // invocation row.
    const store = createStore();
    try {
      seedInvocation(store);
      seedAgent(store, "agent-2");
      store.recordFlight({
        id: "flight-mismatch",
        invocationId: "inv-status-1",
        requesterId: "agent-2",
        targetAgentId: "agent-2",
        state: "running",
        startedAt: 700,
      });

      const db = getWritableDb(store);
      const flightRow = db.query(
        "SELECT requester_id, target_agent_id FROM flights WHERE id = 'flight-mismatch'",
      ).get() as { requester_id: string; target_agent_id: string };
      expect(flightRow.requester_id).toBe("operator");
      expect(flightRow.target_agent_id).toBe("agent-1");
      expect(shadowRow(db).flight_id).toBe("flight-mismatch");
    } finally {
      store.close();
    }
  });
});

describe("terminal session registry", () => {
  const tmuxSurface = {
    backend: "tmux" as const,
    sessionName: "scout-tmux-7e55c009",
    paneId: null,
    attachCommand: ["tmux", "attach", "-t", "scout-tmux-7e55c009"],
    observeCommand: null,
    relay: { backend: "tmux" as const, sessionName: "scout-tmux-7e55c009", tmuxSession: "scout-tmux-7e55c009" },
    state: "exited" as const,
  };
  const zellijSurface = {
    backend: "zellij" as const,
    sessionName: "scout-zj-final-7e55c009",
    paneId: "terminal_0",
    attachCommand: ["env", "ZELLIJ_SOCKET_DIR=/home/u/.openscout/zellij-sockets", "zellij", "attach", "scout-zj-final-7e55c009"],
    observeCommand: ["env", "ZELLIJ_SOCKET_DIR=/home/u/.openscout/zellij-sockets", "zellij", "watch", "scout-zj-final-7e55c009"],
    relay: { backend: "zellij" as const, sessionName: "scout-zj-final-7e55c009", zellijSession: "scout-zj-final-7e55c009", zellijPaneId: "terminal_0" },
    state: "live" as const,
    socketDir: "/home/u/.openscout/zellij-sockets",
  };

  test("persists a harness session with its surfaces and round-trips them", () => {
    const store = createStore();
    try {
      const record = store.upsertTerminalSession({
        harness: "claude",
        sourceSessionId: "7e55c009-f579-439c-a817-988318789330",
        cwd: "/home/u/project",
        resumeCommand: "claude --resume 7e55c009-f579-439c-a817-988318789330",
        surfaces: [tmuxSurface, zellijSurface],
      });

      expect(record.id).toMatch(/^ts\./);
      expect(record.harness).toBe("claude");
      expect(record.surfaces).toHaveLength(2);
      // No harness transcript imported — surfaces are relay descriptors only.
      expect(record.surfaces.map((s) => s.backend).sort()).toEqual(["tmux", "zellij"]);
      const zellij = record.surfaces.find((s) => s.backend === "zellij");
      expect(zellij?.socketDir).toBe("/home/u/.openscout/zellij-sockets");
      expect(zellij?.observeCommand?.join(" ")).toContain("ZELLIJ_SOCKET_DIR=");

      const byId = store.getTerminalSession(record.id);
      expect(byId?.surfaces).toHaveLength(2);

      const listed = store.listTerminalSessions();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.sourceSessionId).toBe("7e55c009-f579-439c-a817-988318789330");
    } finally {
      store.close();
    }
  });

  test("re-intaking the same harness session updates one record (stable identity across backends)", () => {
    const store = createStore();
    try {
      const first = store.upsertTerminalSession({
        harness: "claude",
        sourceSessionId: "abc-123",
        cwd: "/home/u/project",
        resumeCommand: "claude --resume abc-123",
        surfaces: [tmuxSurface],
      });
      const second = store.upsertTerminalSession({
        harness: "claude",
        sourceSessionId: "abc-123",
        cwd: "/home/u/project",
        resumeCommand: "claude --resume abc-123",
        surfaces: [tmuxSurface, zellijSurface],
      });

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      expect(store.listTerminalSessions()).toHaveLength(1);
      expect(store.getTerminalSession(first.id)?.surfaces).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("filters by harness and backend", () => {
    const store = createStore();
    try {
      store.upsertTerminalSession({
        harness: "claude",
        sourceSessionId: "claude-1",
        cwd: "/p",
        resumeCommand: "claude --resume claude-1",
        surfaces: [zellijSurface],
      });
      store.upsertTerminalSession({
        harness: "codex",
        sourceSessionId: "codex-1",
        cwd: "/p",
        resumeCommand: "codex resume -C /p codex-1",
        surfaces: [tmuxSurface],
      });

      expect(store.listTerminalSessions({ harness: "codex" }).map((r) => r.sourceSessionId)).toEqual(["codex-1"]);
      expect(store.listTerminalSessions({ backend: "zellij" }).map((r) => r.sourceSessionId)).toEqual(["claude-1"]);
      expect(store.listTerminalSessions()).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe("terminal workspaces", () => {
  const cells = [
    {
      id: "cell-1",
      surfaceId: "srf1.abc",
      terminalSessionId: "ts.1",
      intent: {
        hostId: "tmux",
        sessionName: "scout-tmux-cell-1",
        cwd: "/home/u/project",
        harness: "claude",
        resumeCommand: "claude --resume abc-123",
      },
    },
    { id: "cell-2", intent: { hostId: "zellij", sessionName: "scout-zellij-cell-2" } },
  ];

  test("round-trips a named workspace and the intent each cell needs to be rebuilt", () => {
    const store = createStore();
    try {
      const record = store.upsertTerminalWorkspace({
        name: "Release desk",
        purpose: "Cross-project release monitoring",
        columns: 3,
        cells,
      });

      expect(record.id).toMatch(/^tw\./);
      expect(record.columns).toBe(3);
      expect(record.cells).toEqual(cells);
      // The point of the record: the revive plan survives the write.
      expect(record.cells[0]?.intent.resumeCommand).toBe("claude --resume abc-123");

      expect(store.getTerminalWorkspace(record.id)).toEqual(record);
      expect(store.listTerminalWorkspaces()).toEqual([record]);
    } finally {
      store.close();
    }
  });

  test("round-trips the authored layout, not just the resolved column count", () => {
    const store = createStore();
    try {
      // "dynamic" is the case the resolved count cannot carry: it comes back
      // pinned to whatever number the tile count produced.
      const created = store.upsertTerminalWorkspace({
        name: "Lanes desk",
        layout: { mode: "lanes", columns: "dynamic" },
        cells,
      });

      expect(created.layout).toEqual({ mode: "lanes", columns: "dynamic" });
      expect(store.getTerminalWorkspace(created.id)?.layout).toEqual({ mode: "lanes", columns: "dynamic" });
      expect(store.listTerminalWorkspaces()[0]?.layout).toEqual({ mode: "lanes", columns: "dynamic" });

      // An update rewrites the layout rather than leaving the first one behind.
      const updated = store.upsertTerminalWorkspace({
        id: created.id,
        name: "Lanes desk",
        layout: { mode: "grid", columns: 3 },
        cells,
      });
      expect(updated.layout).toEqual({ mode: "grid", columns: 3 });
      expect(store.getTerminalWorkspace(created.id)?.layout).toEqual({ mode: "grid", columns: 3 });
    } finally {
      store.close();
    }
  });

  test("a workspace saved without a layout, or with an unreadable one, reports none", () => {
    const store = createStore();
    try {
      const none = store.upsertTerminalWorkspace({ name: "No layout", cells });
      expect(none.layout).toBeUndefined();
      expect(store.getTerminalWorkspace(none.id)?.layout).toBeUndefined();

      // A mode nothing can render must fold back to "no stored layout" rather
      // than reach the client's grid resolver.
      const db = getWritableDb(store);
      db.query("UPDATE terminal_workspaces SET layout_json = ?1 WHERE id = ?2")
        .run(JSON.stringify({ mode: "hexagons", columns: 2 }), none.id);
      expect(store.getTerminalWorkspace(none.id)?.layout).toBeUndefined();

      db.query("UPDATE terminal_workspaces SET layout_json = ?1 WHERE id = ?2").run("{not json", none.id);
      expect(store.getTerminalWorkspace(none.id)?.layout).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("a row from a table that predates layout_json still loads", () => {
    const store = createStore();
    try {
      // The shape a machine that ran the earlier build actually has: the table
      // exists without the column, so `SELECT *` returns no `layout_json` at
      // all — not a null one.
      const db = getWritableDb(store);
      db.exec("DROP TABLE terminal_workspaces");
      db.exec(`CREATE TABLE terminal_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        columns_count INTEGER NOT NULL DEFAULT 2,
        cells_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.query(
        `INSERT INTO terminal_workspaces (id, name, purpose, columns_count, cells_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).run("tw.legacy", "Old desk", "", 3, JSON.stringify(cells), 1000, 1000);

      const record = store.getTerminalWorkspace("tw.legacy");
      expect(record?.name).toBe("Old desk");
      expect(record?.columns).toBe(3);
      expect(record?.cells).toEqual(cells);
      expect(record?.layout).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("updating a workspace keeps its identity and creation time", () => {
    const store = createStore();
    try {
      const first = store.upsertTerminalWorkspace({ name: "Desk", cells });
      const second = store.upsertTerminalWorkspace({
        id: first.id,
        name: "Desk renamed",
        columns: 1,
        cells: [cells[0]!],
      });

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.name).toBe("Desk renamed");
      expect(second.cells).toHaveLength(1);
      expect(store.listTerminalWorkspaces()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("clamps an out-of-range column count instead of storing it", () => {
    const store = createStore();
    try {
      expect(store.upsertTerminalWorkspace({ name: "Wide", columns: 99 }).columns).toBe(6);
      expect(store.upsertTerminalWorkspace({ name: "Thin", columns: 0 }).columns).toBe(1);
      expect(store.upsertTerminalWorkspace({ name: "Default" }).columns).toBe(2);
    } finally {
      store.close();
    }
  });

  test("deletes a workspace and reports whether anything was removed", () => {
    const store = createStore();
    try {
      const record = store.upsertTerminalWorkspace({ name: "Desk", cells });
      expect(store.deleteTerminalWorkspace(record.id)).toBe(true);
      expect(store.deleteTerminalWorkspace(record.id)).toBe(false);
      expect(store.getTerminalWorkspace(record.id)).toBeNull();
      expect(store.listTerminalWorkspaces()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("a workspace with no cells is a real workspace, not a missing one", () => {
    const store = createStore();
    try {
      const record = store.upsertTerminalWorkspace({ name: "Empty" });
      expect(record.cells).toEqual([]);
      expect(store.getTerminalWorkspace(record.id)?.cells).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("prunes quota history older than the charted week and keeps current windows", () => {
    const store = createStore();
    try {
      const now = Date.now();
      const old = now - 9 * 24 * 60 * 60 * 1000;
      const base = { source: "provider_reported" as const, provider: "openai", harness: "codex", label: "7d" };
      store.recordBudgetQuotaWindowSnapshot({ ...base, id: "budget:quota:history:old", capturedAt: old });
      store.recordBudgetQuotaWindowSnapshot({ ...base, id: "budget:quota:history:recent", capturedAt: now });
      store.recordBudgetQuotaWindowSnapshot({ ...base, id: "budget:quota:current", capturedAt: old });

      expect(store.pruneBudgetQuotaHistory(now)).toBe(1);
      expect(store.listBudgetQuotaWindowSnapshots().map((window) => window.id).sort())
        .toEqual(["budget:quota:current", "budget:quota:history:recent"]);
    } finally {
      store.close();
    }
  });

  test("compactAndPruneMeshNodes re-homes collision-suffixed ghost nodes and prunes them cleanly", () => {
    const store = createStore();
    try {
      // 1. Create a stale ghost node with Bonjour collision suffix
      const staleNodeId = "arachs-mac-mini-292-local-openscout";
      const canonicalNodeId = "arachs-mac-mini-local-openscout";
      const keyId = "1cf8f5a98049ab651cf8f5a98049ab651cf8f5a98049ab651cf8f5a98049ab65";

      store.upsertNode({
        id: staleNodeId,
        meshId: "openscout",
        name: "Arachs-Mac-mini-292.local",
        hostName: "Arachs-Mac-mini-292.local",
        advertiseScope: "local",
        brokerUrl: "http://192.168.18.9:43110",
        capabilities: ["control", "observe"],
        labels: [],
        metadata: {},
        registeredAt: Date.now() - 10000,
        lastSeenAt: Date.now() - 5000,
      });

      // 2. Create an agent referencing the stale node
      store.upsertActor({
        id: "agent.arach.main",
        kind: "agent",
        displayName: "Arach Agent",
      });
      store.upsertAgent({
        id: "agent.arach.main",
        kind: "agent",
        displayName: "Arach Agent",
        agentClass: "general",
        definitionId: "agent.arach.main",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        advertiseScope: "local",
        homeNodeId: staleNodeId,
        authorityNodeId: staleNodeId,
      });

      // 3. Create a trusted peer referencing the stale node
      store.upsertTrustedPeer({
        keyId,
        publicKey: "MCowBQYDK2VwAyEAexamplePubKeyForTestOnly1234567890=",
        fingerprint: "osc1:abcd-ef01",
        nodeId: staleNodeId,
        label: "Arach Mac Mini",
        tier: "control",
        grantedVia: "mesh-trust",
        grantedAt: Date.now(),
        metadata: {},
      });

      // Run compaction
      const result = store.compactAndPruneMeshNodes({ localNodeId: "arts-mac-mini-local-openscout" });

      expect(result.rehomedNodeCount).toBe(1);
      expect(result.prunedNodeCount).toBe(1);
      expect(result.rehomedMappings).toEqual([{ from: staleNodeId, to: canonicalNodeId }]);

      // Verify canonical node exists and stale node is gone
      const snapshot = store.loadSnapshot();
      expect(snapshot.nodes[staleNodeId]).toBeUndefined();
      expect(snapshot.nodes[canonicalNodeId]).toBeDefined();
      expect(snapshot.nodes[canonicalNodeId]?.name).toBe("Arachs-Mac-mini.local");

      // Verify agent was re-homed to canonical node
      const agent = snapshot.agents["agent.arach.main"];
      expect(agent?.homeNodeId).toBe(canonicalNodeId);
      expect(agent?.authorityNodeId).toBe(canonicalNodeId);

      // Verify trusted peer was re-homed
      const peer = store.trustedPeer(keyId);
      const rawPeer = getWritableDb(store).query("SELECT * FROM trusted_peers WHERE key_id = ?1").get(keyId) as any;
      expect(rawPeer?.node_id).toBe(canonicalNodeId);
      expect(peer?.nodeId).toBe(canonicalNodeId);
    } finally {
      store.close();
    }
  });
});

describe("registry deletes", () => {
  test("deleteAgent removes the agent row and all of its endpoint rows", () => {
    const store = createStore();
    try {
      seedAgent(store);
      store.upsertEndpoint({
        id: "ep-1",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "local_socket",
        state: "offline",
      });
      store.upsertEndpoint({
        id: "ep-2",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "local_socket",
        state: "stopped",
      });

      const snapshot = store.loadSnapshot();
      expect(snapshot.agents["agent-1"]).toBeDefined();
      expect(Object.keys(snapshot.endpoints)).toHaveLength(2);

      store.deleteAgent("agent-1");

      const after = store.loadSnapshot();
      expect(after.agents["agent-1"]).toBeUndefined();
      expect(Object.keys(after.endpoints)).toHaveLength(0);
      // The actor row survives — actors are deleted separately.
      expect(after.actors["agent-1"]).toBeDefined();

      // Idempotent.
      store.deleteAgent("agent-1");
      store.deleteAgent("never-existed");
    } finally {
      store.close();
    }
  });

  test("deleteActor removes the actor and throws loudly on a RESTRICT reference", () => {
    const store = createStore();
    try {
      seedAgent(store);
      store.upsertConversation({
        id: "conv-1",
        kind: "channel",
        title: "Room",
        visibility: "workspace",
        shareMode: "shared",
        authorityNodeId: "node-1",
        participantIds: ["agent-1"],
      });
      store.recordMessage({
        id: "msg-1",
        conversationId: "conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "authored",
        visibility: "private",
        policy: "durable",
        createdAt: 1_700_000_000_000,
      });

      // messages.actor_id is ON DELETE RESTRICT — the delete must throw, not
      // silently cascade.
      expect(() => store.deleteActor("agent-1")).toThrow();
      expect(store.loadSnapshot().actors["agent-1"]).toBeDefined();

      // Once the reference is gone the delete succeeds and is idempotent.
      getWritableDb(store).query("DELETE FROM messages WHERE id = ?1").run("msg-1");
      store.deleteActor("agent-1");
      expect(store.loadSnapshot().actors["agent-1"]).toBeUndefined();
      store.deleteActor("agent-1");
    } finally {
      store.close();
    }
  });

  test("reference counts mirror the retention guards", () => {
    const store = createStore();
    try {
      seedAgent(store);
      expect(store.agentReferenceCount("agent-1")).toBe(0);
      // The agents row itself counts: the actor only leaves with its agent.
      expect(store.actorReferenceCount("agent-1")).toBe(1);

      // Conversation membership deliberately counts for neither: channels
      // auto-enrol every agent, and member rows cascade-delete anyway.
      store.upsertConversation({
        id: "conv-1",
        kind: "channel",
        title: "Room",
        visibility: "workspace",
        shareMode: "shared",
        authorityNodeId: "node-1",
        participantIds: ["agent-1"],
      });
      expect(store.agentReferenceCount("agent-1")).toBe(0);
      expect(store.actorReferenceCount("agent-1")).toBe(1);

      store.upsertEndpoint({
        id: "ep-1",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "local_socket",
        state: "offline",
      });
      expect(store.agentReferenceCount("agent-1")).toBe(1);
      expect(store.actorReferenceCount("agent-1")).toBe(2);

      store.deleteEndpoint("ep-1");
      expect(store.agentReferenceCount("agent-1")).toBe(0);
      // The surviving agents row still references the actor id.
      expect(store.actorReferenceCount("agent-1")).toBe(1);
      store.deleteAgent("agent-1");
      expect(store.actorReferenceCount("agent-1")).toBe(0);
    } finally {
      store.close();
    }
  });

  test("actorReferenceCount counts collaboration ownership columns", () => {
    const store = createStore();
    try {
      seedAgent(store);
      store.upsertActor({ id: "owner-1", kind: "agent", displayName: "Owner" });
      store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });

      // owner_id and next_move_owner_id are ON DELETE SET NULL — without the
      // count veto, deleting the actor would silently erase ownership of an
      // open work item. created_by_id is RESTRICT; ownership is not.
      getWritableDb(store).query(
        `INSERT INTO collaboration_records (
          id, kind, state, acceptance_state, title,
          created_by_id, owner_id, next_move_owner_id,
          created_at, updated_at
        ) VALUES ('work-1', 'work_item', 'open', 'pending', 'Work',
          'operator', 'owner-1', 'owner-1', 1, 1)`,
      ).run();

      expect(store.actorReferenceCount("owner-1")).toBe(1);
      // The count veto protects the record; the row must stay owned.
      const row = getWritableDb(store).query(
        "SELECT owner_id, next_move_owner_id FROM collaboration_records WHERE id = 'work-1'",
      ).get() as { owner_id: string; next_move_owner_id: string };
      expect(row).toEqual({ owner_id: "owner-1", next_move_owner_id: "owner-1" });
    } finally {
      store.close();
    }
  });
});

test("retained question history is channel scoped and creation-order paginated", () => {
  const store = createStore();
  try {
    store.upsertNode({ id: "node", meshId: "mesh", name: "Test", advertiseScope: "local", registeredAt: 1 });
    store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
    for (const id of ["room", "other"]) store.upsertConversation({ id, title: id, shareMode: "shared", kind: "channel", authorityNodeId: "node", participantIds: [], visibility: "workspace", createdAt: 1 });
    store.upsertConversation({ id: "thread", title: "Thread", shareMode: "shared", kind: "thread", parentConversationId: "room", authorityNodeId: "node", participantIds: [], visibility: "workspace", createdAt: 1 });
    for (const [id, conversationId, createdAt, updatedAt] of [["a", "room", 1, 100], ["b", "thread", 1, 300], ["c", "room", 2, 200], ["hidden", "other", 1, 500]] as const) {
      store.recordCollaborationRecord({ id, kind: "question", conversationId, createdAt, updatedAt,
        title: id, createdById: "operator", state: "closed", acceptanceState: "accepted", answer: `answer ${id}` });
    }
    const query = { kind: "question" as const, state: "closed", conversationId: "room", includeThreads: true, orderByCreatedAt: true, limit: 2 };
    expect(store.listCollaborationRecords(query).map(row => row.id)).toEqual(["a", "b"]);
    expect(store.listCollaborationRecords({ ...query, afterCreatedAt: 1, afterId: "b" })).toMatchObject([{ id: "c", answer: "answer c" }]);
    expect(store.listCollaborationRecords({ ...query, includeThreads: false }).map(row => row.id)).toEqual(["a", "c"]);
    expect(store.listCollaborationRecords({ ...query, orderByCreatedAt: false }).map(row => row.id)).toEqual(["b", "c"]);
  } finally { store.close(); }
});
