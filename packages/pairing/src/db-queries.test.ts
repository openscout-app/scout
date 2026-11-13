import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTENTION_STALE_AFTER_MS,
  closeDb,
  queryActivity,
  queryAgentById,
  queryAgents,
  queryBrokerDiagnostics,
  queryBrokerAttentionHints,
  queryFleet,
  queryFleetAttentionRows,
  queryFlightRecordById,
  queryFlightRecords,
  queryFollowTarget,
  queryFlights,
  queryHeartrate,
  queryInvocationById,
  queryInvocations,
  queryMobileAgents,
  queryMobileAgentDetail,
  queryMobileSessions,
  queryRecentMessages,
  queryRuns,
  querySessions,
  querySessionById,
  queryWorkItemById,
  queryWorkItems,
} from "./db-queries.ts";
import { db } from "./db/internal/db.ts";
import { queryAgentFlightPhases } from "./db/internal/sql-helpers.ts";
import { RECENT_ENDPOINT_AGENT_IDS_SQL } from "./db/agents.ts";
import { SQLiteControlPlaneStore } from "../../runtime/src/sqlite-store.ts";
import { directChannelNaturalKey } from "../../protocol/src/channel-identity.ts";
import {
  MAX_MESSAGE_PAGE_LIMIT,
  MessageCursorError,
  compareMessagesAsc,
  encodeMessageHistoryCursor,
} from "./shared/message-pagination.ts";

const tempRoots = new Set<string>();
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
const originalOperatorName = process.env.OPENSCOUT_OPERATOR_NAME;

afterEach(() => {
  closeDb();
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }
  if (originalOperatorName === undefined) {
    delete process.env.OPENSCOUT_OPERATOR_NAME;
  } else {
    process.env.OPENSCOUT_OPERATOR_NAME = originalOperatorName;
  }

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createSeededStore(): SQLiteControlPlaneStore {
  const root = mkdtempSync(join(tmpdir(), "openscout-web-db-queries-"));
  tempRoots.add(root);
  process.env.OPENSCOUT_CONTROL_HOME = root;
  const store = new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));

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
    id: "c.conv-1",
    kind: "direct",
    title: "Direct",
    visibility: "private",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["agent-1", "operator"],
  });
  store.recordCollaborationRecord({
    id: "work-1",
    kind: "work_item",
    title: "Observed work",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    conversationId: "c.conv-1",
    state: "working",
    acceptanceState: "none",
    requestedById: "operator",
    createdAt: 90,
    updatedAt: 90,
  });
  store.recordCollaborationRecord({
    id: "work-1-child",
    kind: "work_item",
    title: "Child work",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    parentId: "work-1",
    conversationId: "c.conv-1",
    state: "open",
    acceptanceState: "none",
    requestedById: "agent-1",
    createdAt: 95,
    updatedAt: 95,
  });
  store.recordCollaborationEvent({
    id: "event-1",
    recordId: "work-1",
    recordKind: "work_item",
    kind: "claimed",
    actorId: "agent-1",
    summary: "Claimed for implementation",
    at: 110,
  });
  store.recordInvocation({
    id: "inv-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "Do the work",
    collaborationRecordId: "work-1",
    conversationId: "c.conv-1",
    ensureAwake: true,
    stream: false,
    createdAt: 100,
  });
  store.recordFlight({
    id: "flight-1",
    invocationId: "inv-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "running",
    summary: "In progress",
    startedAt: 101,
  });

  return store;
}

function setConversationCreatedAt(conversationId: string, createdAt: number): void {
  const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
  try {
    rawDb.query("UPDATE conversations SET created_at = ?1 WHERE id = ?2").run(createdAt, conversationId);
  } finally {
    rawDb.close();
  }
}

function seedConversationMessages(store: SQLiteControlPlaneStore, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    store.recordMessage({
      id: `msg-page-${index}`,
      conversationId: "c.conv-1",
      actorId: "operator",
      originNodeId: "node-1",
      class: "operator",
      body: `Page ${index}`,
      visibility: "private",
      policy: "durable",
      createdAt: 10_000 + index,
    });
  }
}

function deleteMessages(messageIds: string[]): void {
  const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
  try {
    const remove = rawDb.query("DELETE FROM messages WHERE id = ?1");
    for (const messageId of messageIds) remove.run(messageId);
  } finally {
    rawDb.close();
  }
}

function setSeededRunTimestamps(createdAt: number, startedAt: number): void {
  const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
  try {
    rawDb.query("UPDATE invocations SET created_at = ?1, started_at = ?2 WHERE id = 'inv-1'").run(createdAt, startedAt);
    rawDb.query("UPDATE flights SET started_at = ?1 WHERE id = 'flight-1'").run(startedAt);
    rawDb.query("UPDATE activity_items SET ts = ?1 WHERE id = 'activity:invocation:inv-1'").run(createdAt);
    rawDb.query("UPDATE activity_items SET ts = ?1 WHERE id = 'activity:flight:flight-1'").run(startedAt);
  } finally {
    rawDb.close();
  }
}

describe("web db query flights", () => {
  test("surfaces durable collaboration joins from invocations", () => {
    const store = createSeededStore();

    try {
      const flights = queryFlights({ conversationId: "c.conv-1", collaborationRecordId: "work-1" });

      expect(flights).toEqual([
        {
          id: "flight-1",
          invocationId: "inv-1",
          agentId: "agent-1",
          agentName: "Agent One",
          conversationId: "c.conv-1",
          collaborationRecordId: "work-1",
          state: "running",
          summary: "In progress",
          startedAt: 101_000,
          completedAt: null,
          sessions: [],
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("durable overlay reads project invocations and flights from the invocation shadow columns", () => {
    const store = createSeededStore();

    try {
      expect(queryInvocationById("inv-1")).toEqual(expect.objectContaining({
        id: "inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        conversationId: "c.conv-1",
        action: "consult",
      }));
      expect(queryInvocationById("missing")).toBeNull();
      expect(queryInvocationById("  ")).toBeNull();

      expect(queryInvocations({ conversationId: "c.conv-1" })).toEqual([
        expect.objectContaining({ id: "inv-1", targetAgentId: "agent-1" }),
      ]);
      expect(queryInvocations({ conversationId: "c.other" })).toEqual([]);
      expect(queryInvocations({ conversationId: " " })).toEqual([]);

      expect(queryFlightRecords({ conversationId: "c.conv-1" })).toEqual([
        expect.objectContaining({
          id: "flight-1",
          invocationId: "inv-1",
          state: "running",
          summary: "In progress",
        }),
      ]);
      expect(queryFlightRecords({ conversationId: "c.other" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("durable overlay reads project executionResolution and labels like the store does", () => {
    const store = createSeededStore();

    try {
      store.recordInvocation({
        id: "inv-resolved",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Resolved runtime differs from the request",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        execution: {
          harness: "claude",
          model: "opus",
        },
        executionResolution: {
          requested: { harness: "claude", model: "opus" },
          resolved: { harness: "claude", model: "opus-4-7" },
          observed: { harness: "claude", model: "opus-4-7" },
        },
        labels: ["review", "urgent"],
        createdAt: 105,
      });

      expect(queryInvocationById("inv-resolved")).toEqual(expect.objectContaining({
        execution: { harness: "claude", model: "opus" },
        executionResolution: {
          requested: { harness: "claude", model: "opus" },
          resolved: { harness: "claude", model: "opus-4-7" },
          observed: { harness: "claude", model: "opus-4-7" },
        },
        labels: ["review", "urgent"],
      }));
      expect(queryInvocations({ conversationId: "c.conv-1" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "inv-resolved", labels: ["review", "urgent"] }),
        ]),
      );
    } finally {
      store.close();
    }
  });

  test("durable overlay reads return the newest 200 rows, filtering the target before the limit", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({ id: "agent-2", kind: "agent", displayName: "Agent Two" });
      store.recordInvocation({
        id: "inv-older-target", requesterId: "operator", requesterNodeId: "node-1",
        targetAgentId: "agent-2", action: "consult", task: "Other participant",
        conversationId: "c.conv-1", createdAt: 500,
      });
      store.recordFlight({
        id: "flight-older-target", invocationId: "inv-older-target", requesterId: "operator",
        targetAgentId: "agent-2", state: "completed", startedAt: 500, completedAt: 501,
      });
      for (let index = 1; index <= 210; index += 1) {
        store.recordInvocation({
          id: `inv-page-${index}`,
          requesterId: "operator",
          requesterNodeId: "node-1",
          targetAgentId: "agent-1",
          action: "consult",
          task: `Bulk ${index}`,
          conversationId: "c.conv-1",
          ensureAwake: false,
          stream: false,
          createdAt: 1_000 + index,
        });
        store.recordFlight({
          id: `flight-page-${index}`,
          invocationId: `inv-page-${index}`,
          requesterId: "operator",
          targetAgentId: "agent-1",
          state: "completed",
          startedAt: 1_000 + index,
          completedAt: 1_000 + index,
        });
      }

      const invocations = queryInvocations({ conversationId: "c.conv-1" });
      const flights = queryFlightRecords({ conversationId: "c.conv-1" });

      // The newest 200 win the window — the oldest rows are the ones the
      // broker's hot set rotated out long ago anyway. inv-1 (createdAt 100)
      // and inv-page-1..10 fall outside it; order stays ascending.
      expect(invocations.map((invocation) => invocation.id)).toEqual(
        Array.from({ length: 200 }, (_, index) => `inv-page-${index + 11}`),
      );
      expect(flights.map((flight) => flight.id)).toEqual(
        Array.from({ length: 200 }, (_, index) => `flight-page-${index + 11}`),
      );
      expect(queryInvocations({ conversationId: "c.conv-1", targetAgentId: "agent-2" }).map(record => record.id))
        .toEqual(["inv-older-target"]);
      expect(queryFlightRecords({ conversationId: "c.conv-1", targetAgentId: "agent-2" }).map(record => record.id))
        .toEqual(["flight-older-target"]);
    } finally {
      store.close();
    }
  });

  test("filters flights by exact flight id", () => {
    const store = createSeededStore();

    try {
      const flights = queryFlights({ flightId: "flight-1" });

      expect(flights).toHaveLength(1);
      expect(flights[0]).toEqual(expect.objectContaining({
        id: "flight-1",
        invocationId: "inv-1",
        conversationId: "c.conv-1",
      }));
    } finally {
      store.close();
    }
  });

  test("normalizes recent active flights stored as milliseconds or seconds", () => {
    const store = createSeededStore();
    const recentMs = Date.now() - 1_000;
    const recentSeconds = Math.floor((Date.now() - 2_000) / 1000);

    try {
      store.recordInvocation({
        id: "inv-recent-active-ms",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Recent millisecond running work",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: recentMs,
      });
      store.recordFlight({
        id: "flight-recent-active-ms",
        invocationId: "inv-recent-active-ms",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        summary: "Agent One is running.",
        startedAt: recentMs,
      });
      store.recordInvocation({
        id: "inv-recent-active-seconds",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Recent legacy-second running work",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: recentSeconds,
      });
      store.recordFlight({
        id: "flight-recent-active-seconds",
        invocationId: "inv-recent-active-seconds",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "queued",
        summary: "Agent One is queued.",
        startedAt: recentSeconds,
      });

      const flights = queryFlights({ conversationId: "c.conv-1", activeOnly: true });
      const runs = queryRuns({ conversationId: "c.conv-1" });

      expect(flights).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "flight-recent-active-ms", startedAt: recentMs }),
        expect.objectContaining({ id: "flight-recent-active-seconds", startedAt: recentSeconds * 1000 }),
      ]));
      expect(runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ flightIds: ["flight-recent-active-ms"], updatedAt: recentMs }),
        expect.objectContaining({ flightIds: ["flight-recent-active-seconds"], updatedAt: recentSeconds * 1000 }),
      ]));
    } finally {
      store.close();
    }
  });

  test("surfaces queued dispatch outcome metadata on flights", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.recordInvocation({
        id: "inv-dispatch-outcome",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Queue until online",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: now - 1_000,
      });
      store.recordFlight({
        id: "flight-dispatch-outcome",
        invocationId: "inv-dispatch-outcome",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "queued",
        summary: "Message stored for Agent One. Will deliver when online.",
        startedAt: now,
        metadata: {
          dispatchOutcome: {
            status: "queued_until_online",
            reason: "no_runnable_endpoint",
            checkedAt: now,
          },
        },
      });

      expect(queryFlights({ conversationId: "c.conv-1", activeOnly: true }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: "flight-dispatch-outcome",
            dispatchOutcome: {
              status: "queued_until_online",
              reason: "no_runnable_endpoint",
              checkedAt: now,
            },
          }),
        ]));
    } finally {
      store.close();
    }
  });

  test("surfaces the requester-timeout marker on flights", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.recordInvocation({
        id: "inv-requester-timeout",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Just saying hi.",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: now - 1_000,
      });
      store.recordFlight({
        id: "flight-requester-timeout",
        invocationId: "inv-requester-timeout",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        summary: "Agent One is still working.",
        startedAt: now,
        metadata: {
          requesterTimedOut: true,
          timeoutMs: 300_000,
          timeoutScope: "requester_wait",
        },
      });

      const [flight] = queryFlights({ conversationId: "c.conv-1", activeOnly: true })
        .filter((candidate) => candidate.id === "flight-requester-timeout");

      expect(flight).toMatchObject({
        id: "flight-requester-timeout",
        state: "running",
        requesterWaitTimedOut: true,
      });
    } finally {
      store.close();
    }
  });

  test("resolves follow context from a flight id", () => {
    const store = createSeededStore();

    try {
      store.recordFlight({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        summary: "In progress",
        startedAt: 101,
        metadata: {
          dispatchAck: {
            sessionId: "flight-session-1",
            endpointId: "historical-endpoint",
            harness: "claude",
            transport: "tmux",
            strategy: "spawn",
            acknowledgedAt: 102,
          },
        },
      });
      store.upsertEndpoint({
        id: "agent-1-endpoint",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "active",
        sessionId: "newest-agent-session",
        metadata: {
          threadId: "newest-agent-session",
        },
      });

      expect(queryFollowTarget({ flightId: "flight-1" })).toEqual({
        flightId: "flight-1",
        invocationId: "inv-1",
        conversationId: "c.conv-1",
        workId: "work-1",
        sessionId: "flight-session-1",
        targetAgentId: "agent-1",
        harnessSessionId: null,
      });
      expect(queryFlights({ flightId: "flight-1", activeOnly: false })[0]?.sessions).toEqual([
        expect.objectContaining({ sessionId: "flight-session-1", endpointId: "historical-endpoint" }),
      ]);
    } finally {
      store.close();
    }
  });

  test("resolves the harness session id a tail link can match from the flight's own endpoint", () => {
    const store = createSeededStore();

    try {
      store.upsertEndpoint({
        id: "endpoint.scout-session-1.tmux",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "claude",
        transport: "tmux",
        state: "active",
        sessionId: "scout-session-1",
        metadata: {
          pendingExternalSession: false,
          externalSessionId: "2fcba627-da26-4d4b-9ecd-d052e4b8b27d",
          observedSessionId: "2fcba627-da26-4d4b-9ecd-d052e4b8b27d",
          observedSessionEvidence: { source: "claude-session-record", tmuxSession: "scout-session-1" },
        },
      });
      store.upsertEndpoint({
        id: "agent-1-newer-endpoint",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "active",
        sessionId: "unrelated-thread",
        metadata: { threadId: "unrelated-thread" },
      });
      store.recordFlight({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        summary: "In progress",
        startedAt: 101,
        metadata: {
          sessionTrace: [{
            sessionId: "scout-session-1",
            endpointId: "endpoint.scout-session-1.tmux",
            harness: "claude",
            transport: "tmux",
            startedAt: 101,
            lastAcknowledgedAt: 102,
          }],
        },
      });

      expect(queryFollowTarget({ flightId: "flight-1", sessionId: "scout-session-1" })).toEqual(
        expect.objectContaining({
          sessionId: "scout-session-1",
          harnessSessionId: "2fcba627-da26-4d4b-9ecd-d052e4b8b27d",
        }),
      );
      // Same answer from the Scout session id alone.
      expect(queryFollowTarget({ sessionId: "scout-session-1" }).harnessSessionId)
        .toBe("2fcba627-da26-4d4b-9ecd-d052e4b8b27d");
      // Ticket-only links resolve the same invocation, including after retry
      // URLs retain an older session handle.
      expect(queryFollowTarget({ workId: "work-1" })).toMatchObject({
        flightId: "flight-1", invocationId: "inv-1", sessionId: "scout-session-1",
        harnessSessionId: "2fcba627-da26-4d4b-9ecd-d052e4b8b27d",
      });
      expect(queryFollowTarget({ flightId: "flight-1", sessionId: "old-session" }).sessionId)
        .toBe("scout-session-1");
    } finally {
      store.close();
    }
  });

  test("resolves an unthreaded work id to its responsible agent", () => {
    const store = createSeededStore();

    try {
      store.recordCollaborationRecord({
        id: "work-unthreaded",
        kind: "work_item",
        title: "Needs an owner reply",
        createdById: "operator",
        ownerId: "agent-1",
        nextMoveOwnerId: "agent-1",
        state: "waiting",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: 300,
        updatedAt: 300,
      });

      expect(queryFollowTarget({ workId: "work-unthreaded" })).toEqual({
        flightId: null,
        invocationId: null,
        conversationId: null,
        workId: "work-unthreaded",
        sessionId: null,
        targetAgentId: "agent-1",
        harnessSessionId: null,
      });
    } finally {
      store.close();
    }
  });

  test("a queued task does not borrow the owner's unrelated session", () => {
    const store = createSeededStore();
    try {
      store.recordFlight({ id: "flight-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "agent-1", state: "queued" });
      store.upsertEndpoint({ id: "unrelated-endpoint", agentId: "agent-1", nodeId: "node-1", harness: "codex", transport: "codex_app_server", state: "active", sessionId: "other-task", metadata: { threadId: "other-task" } });
      expect(queryFollowTarget({ workId: "work-1" })).toMatchObject({
        workId: "work-1", flightId: "flight-1", sessionId: null, harnessSessionId: null,
      });
    } finally { store.close(); }
  });

  test("does not route ownerless work back to the operator as an agent", () => {
    const store = createSeededStore();

    try {
      store.recordCollaborationRecord({
        id: "work-operator-next",
        kind: "work_item",
        title: "Operator decision required",
        createdById: "agent-1",
        ownerId: null,
        nextMoveOwnerId: "operator",
        state: "waiting",
        acceptanceState: "pending",
        requestedById: "agent-1",
        createdAt: 301,
        updatedAt: 301,
      });

      expect(queryFollowTarget({ workId: "work-operator-next" })).toEqual({
        flightId: null,
        invocationId: null,
        conversationId: null,
        workId: "work-operator-next",
        sessionId: null,
        targetAgentId: null,
        harnessSessionId: null,
      });
    } finally {
      store.close();
    }
  });

  test("a superseded sibling flight id is intentionally unaddressable — the merged record is latest-flight-only", () => {
    // An invocation carries ONE current status. Once a later flight
    // supersedes flight-1, lookups by the old sibling id miss — no
    // flights-table fallback, the storage merge is the API contract. The
    // invocation (and its current flight) remain fully addressable.
    const store = createSeededStore();

    try {
      store.recordFlight({
        id: "flight-1-retry",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Recovered on retry",
        startedAt: 201,
        completedAt: 220,
      });

      // The merged record follows the retry.
      expect(queryFlightRecordById("flight-1-retry")).toEqual(
        expect.objectContaining({ id: "flight-1-retry", invocationId: "inv-1", state: "completed" }),
      );
      expect(queryFollowTarget({ invocationId: "inv-1" })).toEqual(
        expect.objectContaining({ flightId: "flight-1-retry", conversationId: "c.conv-1" }),
      );

      // The superseded sibling id no longer resolves anywhere.
      expect(queryFlightRecordById("flight-1")).toBeNull();
      expect(queryFlights({ flightId: "flight-1", activeOnly: false })).toEqual([]);
      expect(queryFollowTarget({ flightId: "flight-1" })).toEqual(
        expect.objectContaining({ flightId: "flight-1", invocationId: null, conversationId: null }),
      );
    } finally {
      store.close();
    }
  });

  test("omits stale non-terminal flights from active views", () => {
    const store = createSeededStore();
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000;

    try {
      store.recordInvocation({
        id: "inv-stale-active",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Old queued work",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: old,
      });
      store.recordFlight({
        id: "flight-stale-active",
        invocationId: "inv-stale-active",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "queued",
        summary: "Agent One queued for local execution.",
        startedAt: old,
      });

      expect(queryFlights({ activeOnly: true }).some((flight) => flight.id === "flight-stale-active")).toBe(false);
      expect(queryRuns({ active: true, limit: 50 }).some((run) => run.flightId === "flight-stale-active")).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("web db query runs", () => {
  test("projects latest flights through the AgentRun protocol shape", () => {
    const store = createSeededStore();

    try {
      const runs = queryRuns({ conversationId: "c.conv-1", collaborationRecordId: "work-1", active: false });

      expect(runs).toEqual([
        {
          id: "run:flight:flight-1",
          source: "ask",
          requesterId: "operator",
          agentId: "agent-1",
          agentName: "Agent One",
          workId: "work-1",
          collaborationRecordId: "work-1",
          conversationId: "c.conv-1",
          invocationId: "inv-1",
          flightIds: ["flight-1"],
          state: "running",
          input: {
            action: "consult",
            task: "Do the work",
            targetAgentId: "agent-1",
            requesterNodeId: "node-1",
            ensureAwake: true,
            stream: false,
          },
          output: {
            summary: "In progress",
          },
          createdAt: 100_000,
          startedAt: 101_000,
          updatedAt: 101_000,
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("does not treat question collaboration records as work ids", () => {
    const store = createSeededStore();

    try {
      store.recordCollaborationRecord({
        id: "question-1",
        kind: "question",
        title: "Need a decision",
        createdById: "agent-1",
        ownerId: "agent-1",
        nextMoveOwnerId: "operator",
        conversationId: "c.conv-1",
        state: "open",
        acceptanceState: "none",
        askedById: "agent-1",
        askedOfId: "operator",
        createdAt: 120,
        updatedAt: 120,
      });
      store.recordInvocation({
        id: "inv-question-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Answer the pending question",
        collaborationRecordId: "question-1",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 121,
      });

      const runs = queryRuns({ collaborationRecordId: "question-1", active: false });

      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(expect.objectContaining({
        collaborationRecordId: "question-1",
      }));
      expect(runs[0]?.workId).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("filters runs by agent, conversation, work, state, source, active, and limit", () => {
    const store = createSeededStore();

    try {
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
      store.upsertConversation({
        id: "conv-2",
        kind: "direct",
        title: "Second direct",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-2", "operator"],
      });
      store.recordCollaborationRecord({
        id: "work-2",
        kind: "work_item",
        title: "Completed work",
        createdById: "operator",
        ownerId: "agent-2",
        nextMoveOwnerId: "operator",
        conversationId: "conv-2",
        state: "done",
        acceptanceState: "none",
        requestedById: "operator",
        createdAt: 190,
        updatedAt: 240,
      });
      store.recordInvocation({
        id: "inv-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-2",
        action: "execute",
        task: "Finish the second work item",
        collaborationRecordId: "work-2",
        conversationId: "conv-2",
        ensureAwake: true,
        stream: false,
        createdAt: 200,
        metadata: {
          runSource: "external_issue",
        },
      });
      store.recordFlight({
        id: "flight-2",
        invocationId: "inv-2",
        requesterId: "operator",
        targetAgentId: "agent-2",
        state: "completed",
        summary: "Done",
        startedAt: 210,
        completedAt: 240,
      });

      expect(queryRuns().map((run) => run.id)).toEqual([]);
      expect(queryRuns({ active: false }).map((run) => run.id)).toEqual([
        "run:flight:flight-2",
        "run:flight:flight-1",
      ]);
      expect(queryRuns({ agentId: "agent-2", active: false }).map((run) => run.agentId))
        .toEqual(["agent-2"]);
      expect(queryRuns({ conversationId: "conv-2", active: false }).map((run) => run.conversationId))
        .toEqual(["conv-2"]);
      expect(queryRuns({ workId: "work-2", active: false }).map((run) => run.collaborationRecordId))
        .toEqual(["work-2"]);
      expect(queryRuns({ state: "completed" }).map((run) => run.id))
        .toEqual(["run:flight:flight-2"]);
      expect(queryRuns({ source: "external_issue", active: false }).map((run) => run.id))
        .toEqual(["run:flight:flight-2"]);
      expect(queryRuns({ active: false, limit: 1 })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("includes invocation-only rows as unknown runs", () => {
    const store = createSeededStore();

    try {
      store.recordInvocation({
        id: "inv-without-flight",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "This has not produced a flight yet",
        collaborationRecordId: "work-1",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 300,
        metadata: {
          permissionProfile: "trusted-local",
          reviewNeeded: true,
        },
      });

      const [run] = queryRuns({ state: "unknown" });

      expect(run).toMatchObject({
        id: "run:invocation:inv-without-flight",
        source: "ask",
        requesterId: "operator",
        agentId: "agent-1",
        agentName: "Agent One",
        workId: "work-1",
        collaborationRecordId: "work-1",
        conversationId: "c.conv-1",
        invocationId: "inv-without-flight",
        state: "unknown",
        reviewState: "needed",
        permissionProfile: "trusted_local",
        createdAt: 300_000,
        updatedAt: 300_000,
      });
      expect(run?.flightIds).toBeUndefined();
      expect(run?.output).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("web db query broker diagnostics", () => {
  test("shows latest history even when the health window is empty", () => {
    const store = createSeededStore();
    const old = Date.now() - 2 * 24 * 60 * 60_000;

    try {
      store.recordMessage({
        id: "msg-routed-old",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "A routed reply from before the health window.",
        visibility: "private",
        policy: "durable",
        createdAt: old,
        metadata: {
          source: "scout-cli",
          relayTarget: "operator",
          relayChannel: "dm",
        },
      });

      const diagnostics = queryBrokerDiagnostics({ limit: 10, windowMs: 1_000 });

      expect(diagnostics.totals).toMatchObject({
        successfulDispatches: 0,
        dialogueMessages: 0,
      });
      expect(diagnostics.attempts.map((attempt) => attempt.id)).toEqual(["message:msg-routed-old"]);
      expect(diagnostics.dialogue.map((message) => message.id)).toEqual(["msg-routed-old"]);
      expect(diagnostics.ledger.mode).toBe("latest");
    } finally {
      store.close();
    }
  });

  test("can scope broker rows to the health window and include delivery failure metadata", () => {
    const store = createSeededStore();
    const now = Date.now();
    const old = now - 2 * 60 * 60_000;

    try {
      store.recordMessage({
        id: "msg-failed-recent",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "Recent failed dispatch.",
        visibility: "private",
        policy: "durable",
        createdAt: now - 5_000,
        metadata: { source: "scout-cli", relayTarget: "agent-1", relayChannel: "dm" },
      });
      store.recordMessage({
        id: "msg-failed-old",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "Old failed dispatch.",
        visibility: "private",
        policy: "durable",
        createdAt: old,
        metadata: { source: "scout-cli", relayTarget: "agent-1" },
      });
      store.recordDeliveries([
        {
          id: "delivery-failed-recent",
          messageId: "msg-failed-recent",
          targetId: "agent-1",
          targetKind: "agent",
          transport: "local_socket",
          reason: "mention",
          policy: "durable",
          status: "failed",
          metadata: {
            failureReason: "local_socket_unreachable",
            failureDetail: "connect ENOENT /tmp/agent.sock",
            reconciledReason: "agent_endpoint_stale",
          },
        },
        {
          id: "delivery-failed-old",
          messageId: "msg-failed-old",
          targetId: "agent-1",
          targetKind: "agent",
          transport: "local_socket",
          reason: "mention",
          policy: "durable",
          status: "failed",
          metadata: { failureReason: "stale_old_failure" },
        },
      ]);

      const diagnostics = queryBrokerDiagnostics({
        limit: 10,
        windowMs: 30 * 60_000,
        scopeRowsToWindow: true,
      });

      expect(diagnostics.failedDeliveries.map((attempt) => attempt.id))
        .toEqual(["delivery:delivery-failed-recent"]);
      expect(diagnostics.failedDeliveries[0]).toMatchObject({
        detail: "Recent failed dispatch.",
        route: "dm",
      });
      expect(diagnostics.attempts.map((attempt) => attempt.id))
        .not.toContain("delivery:delivery-failed-old");
      expect(diagnostics.failedDeliveries[0]?.metadata).toMatchObject({
        failureReason: "local_socket_unreachable",
        failureDetail: "connect ENOENT /tmp/agent.sock",
        reconciledReason: "agent_endpoint_stale",
        raw: {
          delivery: {
            metadata: {
              failureReason: "local_socket_unreachable",
            },
          },
        },
      });
    } finally {
      store.close();
    }
  });

  test("classifies operator scoutbot thread sends as dispatch successes", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.upsertActor({
        id: "scoutbot",
        kind: "agent",
        displayName: "Scout",
      });
      store.upsertConversation({
        id: "c.scoutbot-default",
        kind: "direct",
        title: "Scout · default",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "scoutbot"],
        metadata: {
          surface: "scoutbot",
          scoutbotThreadId: "thr-default",
        },
      });
      store.recordMessage({
        id: "msg-scoutbot-send",
        conversationId: "c.scoutbot-default",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "What needs attention?",
        visibility: "private",
        policy: "durable",
        createdAt: now,
        metadata: {
          source: "scout-web",
          destinationKind: "scoutbot_thread",
          destinationId: "thr-default",
          scoutbotThreadId: "thr-default",
        },
      });
      store.recordMessage({
        id: "msg-scoutbot-reply",
        conversationId: "c.scoutbot-default",
        actorId: "scoutbot",
        originNodeId: "node-1",
        class: "agent",
        body: "Nothing urgent.",
        visibility: "private",
        policy: "durable",
        createdAt: now + 1,
        metadata: {
          source: "scoutbot",
          generatedBy: "scoutbot",
          scoutbotThreadId: "thr-default",
        },
      });

      const diagnostics = queryBrokerDiagnostics({
        limit: 10,
        windowMs: 30 * 60_000,
        scopeRowsToWindow: true,
      });

      expect(diagnostics.totals.successfulDispatches).toBe(1);
      expect(diagnostics.attempts.map((attempt) => attempt.id)).toEqual(["message:msg-scoutbot-send"]);
      expect(diagnostics.attempts[0]).toMatchObject({
        actorName: "Operator",
        target: "scoutbot",
        route: "dm",
        conversationId: "c.scoutbot-default",
        messageId: "msg-scoutbot-send",
      });
      expect(diagnostics.dialogue.map((message) => message.id)).toEqual([
        "msg-scoutbot-reply",
        "msg-scoutbot-send",
      ]);
    } finally {
      store.close();
    }
  });

  test("paginates the merged dispatch ledger with a stable cursor", () => {
    const store = createSeededStore();
    const old = Date.now() - 2 * 24 * 60 * 60_000;

    try {
      store.recordMessage({
        id: "msg-routed-newer",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Newest routed reply.",
        visibility: "private",
        policy: "durable",
        createdAt: old + 300,
        metadata: {
          source: "scout-cli",
          relayTarget: "operator",
          relayChannel: "dm",
        },
      });
      store.recordScoutDispatch({
        id: "dispatch-cursor",
        kind: "unknown",
        askedLabel: "@missing",
        detail: "no agent matches @missing",
        candidates: [],
        dispatchedAt: old + 200,
        dispatcherNodeId: "node-1",
        requesterId: "operator",
      });
      store.recordMessage({
        id: "msg-routed-older",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Older routed reply.",
        visibility: "private",
        policy: "durable",
        createdAt: old + 100,
        metadata: {
          source: "scout-cli",
          relayTarget: "operator",
          relayChannel: "dm",
        },
      });

      const first = queryBrokerDiagnostics({ limit: 1, windowMs: 1_000 });
      const second = queryBrokerDiagnostics({
        limit: 1,
        windowMs: 1_000,
        cursor: first.ledger.cursors.attempts,
      });
      const third = queryBrokerDiagnostics({
        limit: 1,
        windowMs: 1_000,
        cursor: second.ledger.cursors.attempts,
      });

      expect(first.attempts.map((attempt) => attempt.id)).toEqual(["message:msg-routed-newer"]);
      expect(first.ledger.hasMore.attempts).toBe(true);
      expect(second.attempts.map((attempt) => attempt.id)).toEqual(["dispatch:dispatch-cursor"]);
      expect(second.attempts[0]).toMatchObject({
        kind: "failed_query",
        status: "failed",
        metadata: { dispatchKind: "unknown" },
      });
      expect(second.ledger.hasMore.attempts).toBe(true);
      expect(third.attempts.map((attempt) => attempt.id)).toEqual(["message:msg-routed-older"]);
      expect(third.ledger.hasMore.attempts).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("web db query heartrate", () => {
  test("returns a smoothed trailing 7 day series across millisecond and second timestamps", () => {
    const store = createSeededStore();
    const now = 1_700_000_000_000;

    try {
      store.recordMessage({
        id: "msg-heartrate-1",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Six days ago.",
        visibility: "private",
        policy: "durable",
        createdAt: now - 6 * 24 * 60 * 60_000,
      });
      store.recordMessage({
        id: "msg-heartrate-2",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "Yesterday.",
        visibility: "private",
        policy: "durable",
        createdAt: now - 24 * 60 * 60_000,
      });
      store.recordFlight({
        id: "flight-heartrate-seconds",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Seconds timestamp activity.",
        startedAt: Math.floor((now - 90 * 60_000) / 1000),
        completedAt: Math.floor((now - 30 * 60_000) / 1000),
      });

      const heartrate = queryHeartrate(56, now);
      const filledIndexes = heartrate.buckets
        .map((bucket, index) => bucket.count > 0 ? index : -1)
        .filter((index) => index >= 0);

      expect(heartrate.windowLabel).toBe("trailing 7d");
      expect(heartrate.bucketLabel).toBe("3h buckets");
      expect(heartrate.buckets).toHaveLength(56);
      expect(heartrate.buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(3);
      expect(filledIndexes.length).toBe(3);

      const firstFilled = filledIndexes[0] ?? -1;
      expect(heartrate.buckets[firstFilled].value).toBeGreaterThan(0);
      expect(heartrate.buckets[firstFilled + 1].value).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});

describe("web db timestamp normalization", () => {
  test("returns epoch milliseconds for message, session, activity, and mobile agent projections", () => {
    const store = createSeededStore();
    const recentMs = Date.now() - 5_000;
    const recentSeconds = Math.floor((Date.now() - 4_000) / 1000);

    try {
      store.recordMessage({
        id: "msg-normalized-ms",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "Millisecond timestamp message.",
        visibility: "private",
        policy: "durable",
        createdAt: recentMs,
      });
      store.recordMessage({
        id: "msg-normalized-seconds",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Legacy second timestamp message.",
        visibility: "private",
        policy: "durable",
        createdAt: recentSeconds,
      });
      store.recordMessage({
        id: "msg-normalized-old-ms",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "Older millisecond timestamp message.",
        visibility: "private",
        policy: "durable",
        createdAt: recentMs - 24 * 60 * 60_000,
      });

      const messages = queryRecentMessages(10, { conversationId: "c.conv-1" });
      const session = querySessionById("c.conv-1");
      const activity = queryActivity(20);
      const fleet = queryFleet({ limit: 10, activityLimit: 1 });
      const mobileDetail = queryMobileAgentDetail("agent-1");
      const mobileSessions = queryMobileSessions(10);

      expect(messages[0]).toMatchObject({
        id: "msg-normalized-seconds",
        createdAt: recentSeconds * 1000,
      });
      expect(messages.find((message) => message.id === "msg-normalized-ms")?.createdAt)
        .toBe(recentMs);
      expect(session?.lastMessageAt).toBe(recentSeconds * 1000);
      expect(mobileSessions.find((item) => item.id === "c.conv-1")?.lastMessageAt)
        .toBe(recentSeconds * 1000);
      expect(activity.find((item) => item.id === "activity:message:msg-normalized-seconds")?.ts)
        .toBe(recentSeconds * 1000);
      expect(fleet.activity[0]).toMatchObject({
        id: "activity:message:msg-normalized-seconds",
        ts: recentSeconds * 1000,
      });
      expect(mobileDetail?.lastActiveAt).toBe(recentSeconds * 1000);
      expect(mobileDetail?.recentActivity.find((item) => item.id === "activity:message:msg-normalized-seconds")?.ts)
        .toBe(recentSeconds * 1000);
      expect(mobileDetail?.activeFlights.find((flight) => flight.id === "flight-1")?.startedAt)
        .toBe(101_000);
    } finally {
      store.close();
    }
  });
});

describe("web db message filtering", () => {
  test("bounds an agent page to the conversations it is actually in", () => {
    const store = createSeededStore();

    try {
      // A conversation the agent was addressed in but has not answered yet.
      store.upsertActor({ id: "agent-2", kind: "agent", displayName: "Agent Two" });
      store.upsertConversation({
        id: "c.conv-addressed",
        kind: "direct",
        title: "Addressed",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });
      // A conversation the agent spoke in without a membership row.
      store.upsertConversation({
        id: "c.conv-spoken",
        kind: "channel",
        title: "Spoken",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator"],
      });
      // An ask the agent has not answered. The broker puts a target into
      // participantIds when it opens the conversation, so membership is what
      // carries this case — nothing is authored by the agent yet.
      store.upsertConversation({
        id: "c.conv-unanswered",
        kind: "direct",
        title: "Unanswered",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });
      // Unrelated fleet traffic — the global tail this page must not return.
      store.upsertConversation({
        id: "c.conv-elsewhere",
        kind: "direct",
        title: "Elsewhere",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-2", "operator"],
      });

      const seed = [
        { id: "msg-addressed", conversationId: "c.conv-addressed", actorId: "operator", at: 20_001 },
        { id: "msg-spoken", conversationId: "c.conv-spoken", actorId: "agent-1", at: 20_002 },
        // The other side of a conversation the agent is in: scoping by
        // conversation has to bring this back, or the flow has no partner.
        { id: "msg-spoken-reply", conversationId: "c.conv-spoken", actorId: "operator", at: 20_003 },
        { id: "msg-elsewhere", conversationId: "c.conv-elsewhere", actorId: "agent-2", at: 20_004 },
        { id: "msg-unanswered", conversationId: "c.conv-unanswered", actorId: "operator", at: 20_005 },
      ];
      for (const row of seed) {
        store.recordMessage({
          id: row.id,
          conversationId: row.conversationId,
          actorId: row.actorId,
          originNodeId: "node-1",
          class: row.actorId === "operator" ? "operator" : "agent",
          body: row.id,
          visibility: "private",
          policy: "durable",
          createdAt: row.at,
        });
      }

      // A routing receipt alone must not add an unrelated conversation to
      // this agent's map.
      store.recordDeliveries([{
        id: "delivery-routing-only",
        messageId: "msg-elsewhere",
        targetId: "agent-1",
        targetKind: "agent",
        transport: "local_socket",
        reason: "direct_message",
        policy: "best_effort",
        status: "accepted",
      }]);

      const scoped = queryRecentMessages(50, { actorId: "agent-1" });
      const ids = scoped.map((message) => message.id);

      expect(ids).toContain("msg-addressed");
      expect(ids).toContain("msg-spoken");
      expect(ids).toContain("msg-spoken-reply");
      // Asked and not yet answered: membership brings this back before the
      // agent has said anything in it.
      expect(ids).toContain("msg-unanswered");
      // The whole point: unrelated traffic stays out, however recent it is.
      expect(ids).not.toContain("msg-elsewhere");
      expect(scoped.every((message) => message.conversationId !== "c.conv-elsewhere")).toBe(true);

      // Without the scope the same read is the global tail, which is what the
      // agent map was being served.
      expect(queryRecentMessages(50).map((message) => message.id)).toContain("msg-elsewhere");
    } finally {
      store.close();
    }
  });

  test("searches full scoped history literally and pages matching rows", () => {
    const store = createSeededStore();
    try {
      seedConversationMessages(store, 120);
      const first = queryRecentMessages(50, { conversationIds: ["c.conv-1"], search: "PAGE" });
      expect(first).toHaveLength(50);
      const next = queryRecentMessages(50, { conversationIds: ["c.conv-1"], search: "page", beforeMessageId: encodeMessageHistoryCursor(first.at(-1)!) });
      expect(next).toHaveLength(50);
      expect(new Set([...first, ...next].map(message => message.id)).size).toBe(100);
      expect(queryRecentMessages(50, { conversationIds: [], search: "page" })).toEqual([]);
      expect(queryRecentMessages(50, { conversationIds: ["c.other"], search: "page" })).toEqual([]);
      expect(queryRecentMessages(50, { conversationIds: ["c.conv-1"], search: "%" })).toEqual([]);
      expect(queryRecentMessages(50, { conversationIds: ["c.conv-1"], search: "' OR 1=1 --" })).toEqual([]);
    } finally { store.close(); }
  });

  test("finds a message by ID outside the recent window while retaining conversation scope", () => {
    const store = createSeededStore();
    try {
      seedConversationMessages(store, 120);
      expect(queryRecentMessages(1, { messageId: "msg-page-1", conversationId: "c.conv-1" }).map(message => message.id)).toEqual(["msg-page-1"]);
      expect(queryRecentMessages(1, { messageId: "msg-page-1", conversationId: "c.unrelated" })).toEqual([]);
      expect(queryRecentMessages(1, { messageId: "missing" })).toEqual([]);
    } finally { store.close(); }
  });

  test("pages to messages before a stable message id", () => {
    const store = createSeededStore();

    try {
      for (const index of [1, 2, 3, 4]) {
        store.recordMessage({
          id: `msg-page-${index}`,
          conversationId: "c.conv-1",
          actorId: index % 2 == 0 ? "agent-1" : "operator",
          originNodeId: "node-1",
          class: index % 2 == 0 ? "agent" : "operator",
          body: `Page ${index}`,
          visibility: "private",
          policy: "durable",
          createdAt: 10_000 + index,
        });
      }

      const messages = queryRecentMessages(2, {
        conversationId: "c.conv-1",
        beforeMessageId: "msg-page-4",
      });

      expect(messages.map((message) => message.id)).toEqual([
        "msg-page-3",
        "msg-page-2",
      ]);
    } finally {
      store.close();
    }
  });

  test("keeps paging when the cursor message was deleted between pages", () => {
    const store = createSeededStore();

    try {
      seedConversationMessages(store, 6);

      const firstPage = queryRecentMessages(3, { conversationId: "c.conv-1" });
      expect(firstPage.map((message) => message.id)).toEqual([
        "msg-page-6",
        "msg-page-5",
        "msg-page-4",
      ]);

      const oldestOnScreen = firstPage.at(-1)!;
      const cursor = encodeMessageHistoryCursor(oldestOnScreen);
      deleteMessages([oldestOnScreen.id]);

      // The anchor is gone, but the cursor carries its position, so the page
      // behind it is still reachable. Before the fix this returned [] and the
      // client read it as end-of-history.
      const earlier = queryRecentMessages(3, {
        conversationId: "c.conv-1",
        beforeMessageId: cursor,
      });
      expect(earlier.map((message) => message.id)).toEqual([
        "msg-page-3",
        "msg-page-2",
        "msg-page-1",
      ]);
    } finally {
      store.close();
    }
  });

  test("reports an unresolvable legacy cursor instead of an empty page", () => {
    const store = createSeededStore();

    try {
      seedConversationMessages(store, 3);

      expect(() =>
        queryRecentMessages(3, {
          conversationId: "c.conv-1",
          beforeMessageId: "msg-page-deleted",
        })
      ).toThrow(MessageCursorError);
      expect(() =>
        queryRecentMessages(3, {
          conversationId: "c.conv-1",
          beforeMessageId: "not-a-cursor|",
        })
      ).toThrow(MessageCursorError);
    } finally {
      store.close();
    }
  });

  test("breaks tied timestamps by binary id so a page never repeats itself", () => {
    const store = createSeededStore();

    try {
      // The reviewer's fixture: one timestamp, three id families whose order
      // differs between SQLite BINARY and ICU locale collation.
      for (const suffix of ["!000", "0000", "_000"]) {
        store.recordMessage({
          id: `msg-${suffix}`,
          conversationId: "c.conv-1",
          actorId: "operator",
          originNodeId: "node-1",
          class: "operator",
          body: suffix,
          visibility: "private",
          policy: "durable",
          createdAt: 10_000,
        });
      }

      const firstPage = queryRecentMessages(2, { conversationId: "c.conv-1" });
      expect(firstPage.map((message) => message.id)).toEqual(["msg-_000", "msg-0000"]);

      // Locale order would nominate "msg-_000" as the oldest row on screen; the
      // server reads that cursor in BINARY order and answers with "msg-0000",
      // a row already on screen. Dedupe hides it, the cursor never moves, and
      // "msg-!000" stays unreachable forever.
      const localeOldest = [...firstPage].sort((left, right) =>
        left.id.localeCompare(right.id)
      )[0]!;
      const duplicatePage = queryRecentMessages(1, {
        conversationId: "c.conv-1",
        beforeMessageId: encodeMessageHistoryCursor(localeOldest),
      });
      expect(duplicatePage.map((message) => message.id)).toEqual(["msg-0000"]);
      expect(firstPage.map((message) => message.id)).toContain(duplicatePage[0]!.id);

      // The shared order nominates the true oldest row, and the page advances.
      const sharedOldest = [...firstPage].sort(compareMessagesAsc)[0]!;
      expect(sharedOldest.id).toBe("msg-0000");
      const earlier = queryRecentMessages(1, {
        conversationId: "c.conv-1",
        beforeMessageId: encodeMessageHistoryCursor(sharedOldest),
      });
      expect(earlier.map((message) => message.id)).toEqual(["msg-!000"]);
    } finally {
      store.close();
    }
  });

  test("clamps an oversized page request to the shared maximum", () => {
    const store = createSeededStore();

    try {
      seedConversationMessages(store, MAX_MESSAGE_PAGE_LIMIT + 20);

      expect(queryRecentMessages(1_000, { conversationId: "c.conv-1" }))
        .toHaveLength(MAX_MESSAGE_PAGE_LIMIT);
    } finally {
      store.close();
    }
  });

  test("hides broker requester-wait timeout statuses from recent messages", () => {
    const store = createSeededStore();

    try {
      store.recordMessage({
        id: "msg-visible",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "Please keep going.",
        visibility: "private",
        policy: "durable",
        createdAt: 1_000,
      });
      store.recordMessage({
        id: "msg-timeout-status",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "status",
        body: "Agent One is still working; Scout stopped waiting for a synchronous result after 300000ms.",
        visibility: "private",
        policy: "durable",
        createdAt: 2_000,
        metadata: {
          source: "broker",
          invocationId: "inv-1",
          flightId: "flight-1",
        },
      });

      const messages = queryRecentMessages(10, { conversationId: "c.conv-1" });

      expect(messages.map((message) => message.id)).toEqual(["msg-visible"]);
    } finally {
      store.close();
    }
  });
});

describe("web db query agents", () => {
  test("resolves direct conversations for an agent list in one batch", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({ id: "agent-2", kind: "agent", displayName: "Agent Two" });
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
      store.upsertConversation({
        id: "dm.operator.agent-1",
        kind: "direct",
        title: "Agent One",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "agent-1"],
        metadata: { naturalKey: directChannelNaturalKey(["operator", "agent-1"]) },
      });
      store.upsertConversation({
        id: "dm.operator.agent-2",
        kind: "direct",
        title: "Agent Two",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "agent-2"],
        metadata: { naturalKey: directChannelNaturalKey(["operator", "agent-2"]) },
      });

      expect(new Map(queryAgents(10).map((agent) => [agent.id, agent.conversationId]))).toEqual(
        new Map([
          ["agent-1", "dm.operator.agent-1"],
          ["agent-2", "dm.operator.agent-2"],
        ]),
      );
    } finally {
      store.close();
    }
  });

  test("returns one row per agent using the latest endpoint and normalized state", () => {
    const store = createSeededStore();

    try {
      store.upsertEndpoint({
        id: "agent-1-old",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "claude",
        transport: "claude_stream_json",
        state: "offline",
        projectRoot: "/tmp/agent-1-old",
      });
      store.upsertEndpoint({
        id: "agent-1-new",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        projectRoot: "/tmp/agent-1-new",
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
        id: "agent-2-old",
        agentId: "agent-2",
        nodeId: "node-1",
        harness: "claude",
        transport: "claude_stream_json",
        state: "offline",
        projectRoot: "/tmp/agent-2-old",
      });
      store.upsertEndpoint({
        id: "agent-2-new",
        agentId: "agent-2",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        projectRoot: "/tmp/agent-2-new",
      });

      const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
      try {
        const setUpdatedAt = rawDb.query("UPDATE agent_endpoints SET updated_at = ?1 WHERE id = ?2");
        setUpdatedAt.run(5, "agent-1-old");
        setUpdatedAt.run(20, "agent-1-new");
        setUpdatedAt.run(10, "agent-2-old");
        setUpdatedAt.run(30, "agent-2-new");
      } finally {
        rawDb.close();
      }

      const agents = queryAgents(10);
      const exactAgent = queryAgentById("agent-1");

      expect(agents).toHaveLength(2);
      expect(agents.map((agent) => agent.id)).toEqual(["agent-2", "agent-1"]);
      expect(agents.map((agent) => agent.harness)).toEqual(["codex", "codex"]);
      expect(agents.map((agent) => agent.transport)).toEqual(["codex_app_server", "codex_app_server"]);
      expect(agents.map((agent) => agent.state)).toEqual(["available", "working"]);
      expect(agents.map((agent) => agent.projectRoot)).toEqual(["/tmp/agent-2-new", "/tmp/agent-1-new"]);
      expect(agents.map((agent) => agent.updatedAt)).toEqual([30_000, 20_000]);
      expect(agents.map((agent) => agent.conversationId)).toEqual([null, null]);
      expect(exactAgent?.id).toBe("agent-1");
      expect(exactAgent?.transport).toBe("codex_app_server");
      expect(exactAgent?.updatedAt).toBe(20_000);
    } finally {
      store.close();
    }
  });

  test("keeps bounded roster ordering equivalent to the canonical full scan", () => {
    const store = createSeededStore();

    try {
      const addAgent = (
        id: string,
        displayName: string,
        metadata?: Record<string, unknown>,
      ) => {
        store.upsertActor({ id, kind: "agent", displayName });
        store.upsertAgent({
          id,
          kind: "agent",
          definitionId: id,
          displayName,
          agentClass: "general",
          capabilities: ["chat"],
          wakePolicy: "on_demand",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
          metadata,
        });
      };
      const addEndpoint = (agentId: string, id: string, harness: "claude" | "codex") => {
        store.upsertEndpoint({
          id,
          agentId,
          nodeId: "node-1",
          harness,
          transport: harness === "codex" ? "codex_app_server" : "claude_stream_json",
          state: "idle",
        });
      };

      addAgent("agent-active", "Active");
      addEndpoint("agent-active", "active-old-ms", "claude");
      addEndpoint("agent-active", "active-new-seconds", "codex");
      addAgent("agent-second", "Second");
      addEndpoint("agent-second", "second-ms", "codex");
      addAgent("agent-tie-z", "Zulu Tie");
      addEndpoint("agent-tie-z", "tie-z", "codex");
      addAgent("agent-tie-a", "Alpha Tie");
      addEndpoint("agent-tie-a", "tie-a", "claude");
      addAgent("agent-retired", "Retired", { retiredFromFleet: true });
      addEndpoint("agent-retired", "retired-newest", "codex");
      addAgent("agent-stale", "Stale", { staleLocalRegistration: true });
      addEndpoint("agent-stale", "stale-newest", "codex");
      addAgent("agent-zero", "Aaron Zero");
      addEndpoint("agent-zero", "zero", "claude");
      addAgent("agent-none", "Bravo None");
      addAgent("agent-negative", "Negative");
      addEndpoint("agent-negative", "negative", "claude");

      const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
      try {
        const setUpdatedAt = rawDb.query("UPDATE agent_endpoints SET updated_at = ?1 WHERE id = ?2");
        // The newest endpoint for agent-active is encoded in legacy seconds;
        // raw integer ordering would incorrectly choose the older ms row.
        setUpdatedAt.run(1_800_000_000_000, "active-old-ms");
        setUpdatedAt.run(1_900_000_000, "active-new-seconds");
        setUpdatedAt.run(1_850_000_000_000, "second-ms");
        setUpdatedAt.run(1_840_000_000_000, "tie-z");
        setUpdatedAt.run(1_840_000_000_000, "tie-a");
        setUpdatedAt.run(2_100_000_000_000, "retired-newest");
        setUpdatedAt.run(2_000_000_000_000, "stale-newest");
        setUpdatedAt.run(0, "zero");
        setUpdatedAt.run(-10, "negative");

        const normalizedUpdatedAt = `CASE
          WHEN ep.updated_at IS NULL THEN NULL
          WHEN CAST(ep.updated_at AS REAL) < 1000000000000
            THEN CAST(CAST(ep.updated_at AS REAL) * 1000 AS INTEGER)
          ELSE CAST(ep.updated_at AS INTEGER)
        END`;
        const canonicalIds = (limit: number) => (
          rawDb.query(
            `SELECT a.id
             FROM agents a
             JOIN actors ac ON ac.id = a.id
             LEFT JOIN agent_endpoints ep ON ep.id = (
               SELECT ep2.id
               FROM agent_endpoints ep2
               WHERE ep2.agent_id = a.id
               ORDER BY COALESCE(CASE
                 WHEN ep2.updated_at IS NULL THEN NULL
                 WHEN CAST(ep2.updated_at AS REAL) < 1000000000000
                   THEN CAST(CAST(ep2.updated_at AS REAL) * 1000 AS INTEGER)
                 ELSE CAST(ep2.updated_at AS INTEGER)
               END, 0) DESC
               LIMIT 1
             )
             WHERE COALESCE(json_extract(a.metadata_json, '$.retiredFromFleet'), 0) != 1
               AND COALESCE(json_extract(a.metadata_json, '$.staleLocalRegistration'), 0) != 1
             ORDER BY COALESCE(${normalizedUpdatedAt}, 0) DESC, ac.display_name ASC
             LIMIT ?1`,
          ).all(limit) as Array<{ id: string }>
        ).map((row) => row.id);

        for (const limit of [1, 2, 3, 4, 5, 10, -1]) {
          expect(queryAgents(limit).map((agent) => agent.id)).toEqual(canonicalIds(limit));
        }
        expect(queryAgents(4).map((agent) => agent.id)).toEqual([
          "agent-active",
          "agent-second",
          "agent-tie-a",
          "agent-tie-z",
        ]);
        expect(queryAgents(1)[0]).toMatchObject({
          id: "agent-active",
          harness: "codex",
          updatedAt: 1_900_000_000_000,
        });
      } finally {
        rawDb.close();
      }
    } finally {
      store.close();
    }
  });

  test("walks the normalized endpoint-recency index for a bounded roster", () => {
    const store = createSeededStore();

    try {
      store.upsertEndpoint({
        id: "agent-1-endpoint",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
      });
      const rawDb = new Database(
        join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"),
        { readonly: true },
      );
      try {
        const plan = rawDb.query(
          `EXPLAIN QUERY PLAN ${RECENT_ENDPOINT_AGENT_IDS_SQL}`,
        ).all(20) as Array<{ detail?: string }>;
        const details = plan.map((row) => String(row.detail ?? ""));

        expect(details.some((detail) => (
          detail.includes("SCAN ep USING INDEX idx_agent_endpoints_roster_recency")
        ))).toBe(true);
        expect(details.some((detail) => detail === "SCAN a")).toBe(false);
      } finally {
        rawDb.close();
      }
    } finally {
      store.close();
    }
  });

  test("serves a bounded roster while the recency-index migration is still warming", () => {
    const store = createSeededStore();

    try {
      store.upsertEndpoint({
        id: "agent-1-endpoint",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
      });
      const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
      try {
        rawDb.exec("DROP INDEX idx_agent_endpoints_roster_recency");
      } finally {
        rawDb.close();
      }

      expect(queryAgents(20).map((agent) => agent.id)).toEqual(["agent-1"]);
    } finally {
      store.close();
    }
  });

  test("web agents carry their roster code, and none once gone or before the roster migration", () => {
    const store = createSeededStore();

    try {
      const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
      const write = (sql: string) => {
        rawDb.exec(sql);
      };
      try {
        write(`INSERT INTO roster_projects (project_key, name, code, code_source, created_at, updated_at)
               VALUES ('openscout', 'openscout', 'OS', 'default', 1, 1)`);
        write(`INSERT INTO roster_agents (agent_id, number, project_key, project, source, assigned_at, active_at, updated_at, gone_at)
               VALUES ('agent-1', 3, 'openscout', 'openscout', 'auto', 1, 1, 1, NULL)`);
        const tag = { number: 3, numberText: "003", projectCode: "OS", code: "OS-003", label: "OS 003" };
        expect(queryAgentById("agent-1")?.roster).toEqual(tag);
        expect(queryAgents(10).find((agent) => agent.id === "agent-1")?.roster).toEqual(tag);

        write("UPDATE roster_agents SET gone_at = 2 WHERE agent_id = 'agent-1'");
        expect(queryAgentById("agent-1")?.roster).toBeNull();

        write("DROP TABLE roster_agents");
        expect(queryAgents(10).find((agent) => agent.id === "agent-1")?.roster).toBeNull();
      } finally {
        rawDb.close();
      }
    } finally {
      store.close();
    }
  });

  test("does not synthesize a direct session for an agent before a chat exists", () => {
    const store = createSeededStore();

    try {
      const session = querySessionById("dm.operator.agent-1");

      expect(session).toBeNull();
    } finally {
      store.close();
    }
  });

  test("resolves a target agent for direct sessions with two agent participants", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({
        id: "scout.main.mini",
        kind: "agent",
        displayName: "Scout",
      });
      store.upsertAgent({
        id: "scout.main.mini",
        kind: "agent",
        definitionId: "scout.main.mini",
        displayName: "Scout",
        agentClass: "relay",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertActor({
        id: "local-session-agent-test",
        kind: "agent",
        displayName: "Codex 023e",
      });
      store.upsertAgent({
        id: "local-session-agent-test",
        kind: "agent",
        definitionId: "local-session-agent-test",
        displayName: "Codex 023e",
        agentClass: "relay",
        capabilities: ["chat"],
        wakePolicy: "manual",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertEndpoint({
        id: "local-session-agent-test-endpoint",
        agentId: "local-session-agent-test",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        projectRoot: "/tmp/openscout",
      });
      store.upsertConversation({
        id: "c.local-session-agent-test-scout-main",
        kind: "direct",
        title: "Scout <> Codex 023e",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["local-session-agent-test", "scout.main.mini"],
      });

      const session = querySessionById("c.local-session-agent-test-scout-main");

      expect(session?.agentId).toBe("local-session-agent-test");
      expect(session?.agentName).toBe("Codex 023e");
      expect(session?.harness).toBe("codex");
    } finally {
      store.close();
    }
  });

  test("does not rewrite local-session direct chat ids through aliases", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({
        id: "scout.main.mini",
        kind: "agent",
        displayName: "Scout",
      });
      store.upsertAgent({
        id: "scout.main.mini",
        kind: "agent",
        definitionId: "scout.main.mini",
        displayName: "Scout",
        agentClass: "relay",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertActor({
        id: "local-session-agent-test",
        kind: "agent",
        displayName: "Codex 023e",
      });
      store.upsertAgent({
        id: "local-session-agent-test",
        kind: "agent",
        definitionId: "local-session-agent-test",
        displayName: "Codex 023e",
        agentClass: "relay",
        capabilities: ["chat"],
        wakePolicy: "manual",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertConversation({
        id: "c.operator-local-session-agent-test",
        kind: "direct",
        title: "Codex 023e",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "local-session-agent-test"],
      });
      store.upsertConversation({
        id: "c.local-session-agent-test-scout-main",
        kind: "direct",
        title: "Scout <> Codex 023e",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["local-session-agent-test", "scout.main.mini"],
      });
      store.recordMessage({
        id: "legacy-msg",
        conversationId: "c.local-session-agent-test-scout-main",
        actorId: "scout.main.mini",
        originNodeId: "node-1",
        class: "agent",
        body: "legacy fork message",
        visibility: "private",
        policy: "durable",
        createdAt: 200,
      });
      store.recordMessage({
        id: "canonical-msg",
        conversationId: "c.operator-local-session-agent-test",
        actorId: "local-session-agent-test",
        originNodeId: "node-1",
        class: "agent",
        body: "canonical thread message",
        visibility: "private",
        policy: "durable",
        createdAt: 100,
      });

      const sessions = querySessions(80).filter((entry) => entry.agentId === "local-session-agent-test");

      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("c.local-session-agent-test-scout-main");
    } finally {
      store.close();
    }
  });

  test("orders the session list by latest message activity before applying the limit", () => {
    const store = createSeededStore();

    try {
      setConversationCreatedAt("c.conv-1", 1);

      store.recordMessage({
        id: "c.conv-1-late-message",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "I am the active old conversation.",
        visibility: "private",
        policy: "durable",
        createdAt: 10_000,
      });

      for (let i = 0; i < 5; i += 1) {
        const conversationId = `new-empty-conv-${i}`;
        store.upsertConversation({
          id: conversationId,
          kind: "channel",
          title: `New empty ${i}`,
          visibility: "private",
          shareMode: "local",
          authorityNodeId: "node-1",
          participantIds: ["operator"],
        });
        setConversationCreatedAt(conversationId, 1_000 + i);
      }

      expect(querySessions(1).map((session) => session.id)).toEqual(["c.conv-1"]);
    } finally {
      store.close();
    }
  });

  test("includes current opaque chat ids in durable session and recent-message reads", () => {
    const store = createSeededStore();
    const conversationId = "chn-0123456789abcdef0123456789abcdef";

    try {
      store.upsertConversation({
        id: conversationId,
        kind: "channel",
        title: "Current opaque chat",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "agent-1"],
      });
      store.recordMessage({
        id: "opaque-chat-message",
        conversationId,
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Visible during cold start.",
        visibility: "private",
        policy: "durable",
        createdAt: 20_000,
      });

      expect(querySessions(20)).toContainEqual(expect.objectContaining({
        id: conversationId,
        preview: "Visible during cold start.",
      }));
      expect(queryRecentMessages(20).map((message) => message.id)).toContain(
        "opaque-chat-message",
      );
    } finally {
      store.close();
    }
  });

  test("looks up an exact session id without depending on the capped session list", () => {
    const store = createSeededStore();

    try {
      setConversationCreatedAt("c.conv-1", 1);

      for (let i = 0; i < 205; i += 1) {
        const conversationId = `newer-conv-${i}`;
        store.upsertConversation({
          id: conversationId,
          kind: "channel",
          title: `Newer ${i}`,
          visibility: "private",
          shareMode: "local",
          authorityNodeId: "node-1",
          participantIds: ["operator"],
        });
        setConversationCreatedAt(conversationId, 1_000 + i);
      }

      const session = querySessionById("c.conv-1");

      expect(session?.id).toBe("c.conv-1");
      expect(session?.agentId).toBe("agent-1");
    } finally {
      store.close();
    }
  });

  test("does not read direct history through legacy local-session aliases", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({
        id: "scout.main.mini",
        kind: "agent",
        displayName: "Scout",
      });
      store.upsertActor({
        id: "local-session-agent-test",
        kind: "agent",
        displayName: "Codex 023e",
      });
      store.upsertAgent({
        id: "local-session-agent-test",
        kind: "agent",
        definitionId: "local-session-agent-test",
        displayName: "Codex 023e",
        agentClass: "relay",
        capabilities: ["chat"],
        wakePolicy: "manual",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertConversation({
        id: "dm.local-session-agent-test.scout.main.mini",
        kind: "direct",
        title: "Scout <> Codex 023e",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["local-session-agent-test", "scout.main.mini"],
      });
      store.recordMessage({
        id: "legacy-msg",
        conversationId: "dm.local-session-agent-test.scout.main.mini",
        actorId: "scout.main.mini",
        originNodeId: "node-1",
        class: "agent",
        body: "legacy alias message",
        visibility: "private",
        policy: "durable",
        createdAt: 200,
      });

      const messages = queryRecentMessages(20, {
        conversationId: "dm.operator.local-session-agent-test",
      });

      expect(messages.map((message) => message.body)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("surfaces harness session ids and log paths for bridge-backed local codex agents", () => {
    const store = createSeededStore();

    try {
      store.upsertEndpoint({
        id: "agent-1-bridge",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "pairing_bridge",
        state: "idle",
        sessionId: "pairing-019d9762",
        projectRoot: "/tmp/agent-1-bridge",
        metadata: {
          attachedTransport: "codex_app_server",
          pairingAdapterType: "codex",
          pairingSessionId: "pairing-019d9762",
          threadId: "019d9762-19f7-7792-8962-90d924ce7faa",
          externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
        },
      });

      const agent = queryAgents(10).find((entry) => entry.id === "agent-1");

      expect(agent?.harnessSessionId).toBe("019d9762-19f7-7792-8962-90d924ce7faa");
      expect(agent?.harnessLogPath).toBe(
        join(homedir(), ".scout", "pairing", "codex", "pairing-019d9762", "logs", "stdout.log"),
      );
    } finally {
      store.close();
    }
  });

  test("surfaces tmux session ids for tmux-backed local agents", () => {
    const store = createSeededStore();

    try {
      store.upsertEndpoint({
        id: "agent-1-tmux",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "claude",
        transport: "tmux",
        state: "idle",
        sessionId: "relay-agent-1-claude",
        projectRoot: "/tmp/agent-1-tmux",
        metadata: {
          tmuxSession: "relay-agent-1-claude",
        },
      });

      const agent = queryAgents(10).find((entry) => entry.id === "agent-1");

      expect(agent?.transport).toBe("tmux");
      expect(agent?.harnessSessionId).toBeNull();
      expect(agent?.terminalSurface).toEqual({
        backend: "tmux",
        sessionName: "relay-agent-1-claude",
        paneId: null,
        socketDir: null,
      });
    } finally {
      store.close();
    }
  });

  test("surfaces harness session ids and log paths on session summaries", () => {
    const store = createSeededStore();

    try {
      store.upsertEndpoint({
        id: "agent-1-bridge",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "codex",
        transport: "pairing_bridge",
        state: "idle",
        sessionId: "pairing-019d9762",
        projectRoot: "/tmp/agent-1-bridge",
        metadata: {
          attachedTransport: "codex_app_server",
          pairingAdapterType: "codex",
          pairingSessionId: "pairing-019d9762",
          threadId: "019d9762-19f7-7792-8962-90d924ce7faa",
          externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
        },
      });

      const session = querySessions(10).find((entry) => entry.id === "c.conv-1");

      expect(session?.harnessSessionId).toBe("019d9762-19f7-7792-8962-90d924ce7faa");
      expect(session?.harnessLogPath).toBe(
        join(homedir(), ".scout", "pairing", "codex", "pairing-019d9762", "logs", "stdout.log"),
      );
    } finally {
      store.close();
    }
  });

  test("keeps cold-start session runtime scoped to its invocation instead of the agent's newest endpoint", () => {
    const store = createSeededStore();

    try {
      store.upsertEndpoint({
        id: "agent-1-newer-claude",
        agentId: "agent-1",
        nodeId: "node-1",
        harness: "claude",
        transport: "claude_stream_json",
        state: "idle",
        sessionId: "newer-claude-session",
        projectRoot: "/tmp/agent-1-claude",
        lastSeenAt: 500,
        metadata: {
          externalSessionId: "newer-claude-session",
          observedModel: "claude-opus-4-1",
          observedReasoningEffort: "max",
        },
      });
      store.recordInvocation({
        id: "inv-runtime-codex",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Keep the conversation's original Codex runtime",
        conversationId: "c.conv-1",
        execution: {
          harness: "codex",
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
        },
        executionResolution: {
          schemaVersion: "openscout.execution-resolution.v1",
          harness: {
            requested: "codex",
            resolved: "codex",
            observed: "codex",
            source: "flag",
            drift: "match",
          },
          model: {
            requested: "gpt-5.6-terra",
            resolved: "gpt-5.6-terra",
            observed: "gpt-5.6-sol",
            source: "flag",
            drift: "mismatch",
          },
          reasoningEffort: {
            requested: "high",
            resolved: "high",
            observed: "xhigh",
            source: "flag",
            drift: "mismatch",
          },
          sessionId: "codex-thread-for-conversation",
          resolvedAt: 300,
          observedAt: 301,
        },
        ensureAwake: true,
        stream: false,
        createdAt: 300,
      });

      const session = querySessions(10).find((entry) => entry.id === "c.conv-1");

      expect(session).toEqual(expect.objectContaining({
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        sessionId: "codex-thread-for-conversation",
      }));
    } finally {
      store.close();
    }
  });

  test("marks queued backlog as in flight rather than in turn", () => {
    const store = createSeededStore();

    try {
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
        id: "endpoint-2",
        agentId: "agent-2",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        projectRoot: "/tmp/agent-2",
      });
      store.upsertConversation({
        id: "conv-2",
        kind: "direct",
        title: "Direct Two",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-2", "operator"],
      });
      store.recordInvocation({
        id: "inv-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-2",
        action: "consult",
        task: "Check later",
        conversationId: "conv-2",
        ensureAwake: true,
        stream: false,
        createdAt: 200,
      });
      store.recordFlight({
        id: "flight-2",
        invocationId: "inv-2",
        requesterId: "operator",
        targetAgentId: "agent-2",
        state: "queued",
        summary: "Queued for later delivery",
        startedAt: 201,
      });

      const listEntry = queryAgents(10).find((entry) => entry.id === "agent-2");
      const detail = queryMobileAgentDetail("agent-2");

      expect(listEntry?.state).toBe("in_flight");
      expect(detail?.state).toBe("in_flight");
      expect(detail?.activeFlights.map((flight) => flight.state)).toEqual(["queued"]);
    } finally {
      store.close();
    }
  });

  test("shows wake-on-demand agents as available even after their session drops", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({
        id: "scoutbot.main.mini",
        kind: "agent",
        displayName: "Scoutbot",
      });
      store.upsertAgent({
        id: "scoutbot.main.mini",
        kind: "agent",
        definitionId: "scoutbot",
        displayName: "Scoutbot",
        agentClass: "general",
        capabilities: ["chat", "invoke", "deliver"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertEndpoint({
        id: "endpoint-scoutbot",
        agentId: "scoutbot.main.mini",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "offline",
        projectRoot: "/tmp/openscout",
        metadata: {
          lastError: "codex_app_server session unavailable: relay-scoutbot-codex",
        },
      });

      const listEntry = queryAgents(20).find((entry) => entry.id === "scoutbot.main.mini");
      const mobileEntry = queryMobileAgents(20).find((entry) => entry.id === "scoutbot.main.mini");
      const detail = queryMobileAgentDetail("scoutbot.main.mini");

      expect(listEntry?.state).toBe("available");
      expect(mobileEntry?.state).toBe("available");
      expect(detail?.state).toBe("available");
    } finally {
      store.close();
    }
  });

  test("shows always-on agents as available even without a harness endpoint", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({
        id: "scoutbot",
        kind: "agent",
        displayName: "Scout",
        handle: "scoutbot",
      });
      store.upsertAgent({
        id: "scoutbot",
        kind: "agent",
        definitionId: "scoutbot",
        displayName: "Scout",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "always_on",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
        defaultSelector: "scoutbot",
      });

      const listEntry = queryAgents(20).find((entry) => entry.id === "scoutbot");
      const mobileEntry = queryMobileAgents(20, { query: "scoutbot" }).find(
        (entry) => entry.id === "scoutbot",
      );
      const detail = queryMobileAgentDetail("scoutbot");

      expect(listEntry?.state).toBe("available");
      expect(mobileEntry?.state).toBe("available");
      expect(detail?.state).toBe("available");
    } finally {
      store.close();
    }
  });

  test("does not surface stale wake-on-demand local agents as available choices", () => {
    const store = createSeededStore();

    try {
      store.upsertActor({
        id: "scoutbot.old-branch.mini",
        kind: "agent",
        displayName: "Scoutbot",
      });
      store.upsertAgent({
        id: "scoutbot.old-branch.mini",
        kind: "agent",
        definitionId: "scoutbot",
        displayName: "Scoutbot",
        agentClass: "general",
        capabilities: ["chat", "invoke", "deliver"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
        metadata: {
          staleLocalRegistration: true,
          replacedByAgentId: "scoutbot.current-branch.mini",
        },
      });
      store.upsertEndpoint({
        id: "endpoint-scoutbot-old",
        agentId: "scoutbot.old-branch.mini",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "offline",
        projectRoot: "/tmp/openscout",
        metadata: {
          staleLocalRegistration: true,
          replacedByAgentId: "scoutbot.current-branch.mini",
        },
      });

      expect(queryAgents(20).some((entry) => entry.id === "scoutbot.old-branch.mini")).toBe(false);
      expect(queryMobileAgents(20).some((entry) => entry.id === "scoutbot.old-branch.mini")).toBe(false);
      expect(queryMobileAgentDetail("scoutbot.old-branch.mini")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("filters mobile agents before applying the page limit", () => {
    const store = createSeededStore();

    try {
      for (let i = 0; i < 30; i += 1) {
        const id = `agent-${String(i).padStart(2, "0")}`;
        store.upsertActor({
          id,
          kind: "agent",
          displayName: `Agent ${String(i).padStart(2, "0")}`,
        });
        store.upsertAgent({
          id,
          kind: "agent",
          definitionId: id,
          displayName: `Agent ${String(i).padStart(2, "0")}`,
          agentClass: "general",
          capabilities: ["chat"],
          wakePolicy: "on_demand",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        });
      }
      store.upsertActor({
        id: "scoutbot",
        kind: "agent",
        displayName: "Scout",
        handle: "scoutbot",
      });
      store.upsertAgent({
        id: "scoutbot",
        kind: "agent",
        definitionId: "scoutbot",
        displayName: "Scout",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "manual",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
        defaultSelector: "scoutbot",
      });

      expect(queryMobileAgents(20).some((entry) => entry.id === "scoutbot")).toBe(false);
      expect(queryMobileAgents(20, { query: "scoutbot" }).map((entry) => entry.id)).toEqual(["scoutbot"]);
    } finally {
      store.close();
    }
  });

  test("does not read direct messages across operator identity aliases", () => {
    const store = createSeededStore();
    const home = mkdtempSync(join(tmpdir(), "openscout-web-user-config-"));
    tempRoots.add(home);
    process.env.OPENSCOUT_HOME = home;
    process.env.OPENSCOUT_OPERATOR_NAME = "arach";

    try {
      store.upsertActor({
        id: "arach",
        kind: "person",
        displayName: "Arach",
      });
      store.upsertConversation({
        id: "dm.arach.agent-1",
        kind: "direct",
        title: "Agent One",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "arach"],
      });
      store.recordMessage({
        id: "msg-arach",
        conversationId: "dm.arach.agent-1",
        actorId: "arach",
        originNodeId: "node-1",
        class: "agent",
        body: "Alias-visible message",
        visibility: "private",
        policy: "durable",
        createdAt: 300,
      });

      const messages = queryRecentMessages(10, {
        conversationId: "dm.operator.agent-1",
      });

      expect(messages.map((message) => message.id)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("filters duplicate replies and stale-flight reconciliation from top activity", () => {
    const store = createSeededStore();

    try {
      store.recordMessage({
        id: "msg-operator",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "Please check this",
        visibility: "private",
        policy: "durable",
        createdAt: 150,
      });
      store.recordMessage({
        id: "msg-reply",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Done.",
        replyToMessageId: "msg-operator",
        visibility: "private",
        policy: "durable",
        createdAt: 160,
      });
      store.recordFlight({
        id: "flight-stale",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        summary: "Agent One did not finish cleanly.",
        error: "Stale running flight reconciled: endpoint endpoint-1 moved to offline",
        startedAt: 155,
        completedAt: 170,
      });
      store.recordInvocation({
        id: "inv-dup-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Reply once",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 171,
      });
      store.recordFlight({
        id: "flight-dup-1",
        invocationId: "inv-dup-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Agent One replied.",
        startedAt: 172,
        completedAt: 180,
      });
      store.recordInvocation({
        id: "inv-dup-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Reply twice",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 173,
      });
      store.recordFlight({
        id: "flight-dup-2",
        invocationId: "inv-dup-2",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Agent One replied.",
        startedAt: 174,
        completedAt: 181,
      });

      const activity = queryActivity(20);

      expect(activity.some((item) => item.id === "activity:message:msg-reply")).toBe(false);
      expect(activity.some((item) => item.id === "activity:flight:flight-stale")).toBe(false);
      expect(activity.some((item) => item.id === "activity:message:msg-operator")).toBe(true);
      expect(activity.some((item) => item.id === "activity:flight:flight-1")).toBe(false);
      expect(activity.filter((item) => item.kind === "flight_updated")).toHaveLength(0);
      expect(queryFleet({ limit: 10, activityLimit: 20 }).activity.some(
        (item) => item.kind === "flight_updated" || item.kind === "ask_failed" || item.kind === "ask_replied",
      )).toBe(false);
    } finally {
      store.close();
    }
  });

  test("classifies channel posts as message activity rather than asks", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.upsertConversation({
        id: "channel.talkie-next",
        kind: "channel",
        title: "talkie-next",
        visibility: "workspace",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });
      store.recordMessage({
        id: "msg-channel-post",
        conversationId: "channel.talkie-next",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "hi!",
        visibility: "workspace",
        policy: "durable",
        createdAt: now,
      });

      expect(queryActivity(20).find((item) => item.messageId === "msg-channel-post"))
        .toMatchObject({ kind: "message_posted" });

      const rawDb = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
      try {
        rawDb.query(
          "UPDATE activity_items SET kind = 'ask_opened' WHERE id = 'activity:message:msg-channel-post'",
        ).run();
      } finally {
        rawDb.close();
      }

      expect(queryActivity(20).find((item) => item.messageId === "msg-channel-post"))
        .toMatchObject({ kind: "message_posted" });
      expect(queryFleet({ limit: 10, activityLimit: 20 }).activity.find((item) => item.messageId === "msg-channel-post"))
        .toMatchObject({ kind: "message_posted" });
    } finally {
      store.close();
    }
  });
});

describe("web db query fleet", () => {
  test("retires stale attention and collapses live duplicate title-owner rows", () => {
    const store = createSeededStore();
    const now = 1_900_000_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);

    const record = ({
      id,
      title,
      state = "review",
      updatedAt,
    }: {
      id: string;
      title: string;
      state?: "review" | "waiting";
      updatedAt: number;
    }) => {
      store.recordCollaborationRecord({
        id,
        kind: "work_item",
        title,
        // Agent-declared handbacks: only those are operator attention.
        createdById: "agent-1",
        ownerId: "agent-1",
        nextMoveOwnerId: "operator",
        conversationId: "c.conv-1",
        state,
        acceptanceState: "pending",
        requestedById: "agent-1",
        createdAt: updatedAt - 1_000,
        updatedAt,
      });
    };

    try {
      record({
        id: "attention-stale-review",
        title: "Stale review",
        updatedAt: now - ATTENTION_STALE_AFTER_MS - 1,
      });
      record({
        id: "attention-live-review",
        title: "Live review",
        updatedAt: now - ATTENTION_STALE_AFTER_MS + 1,
      });
      record({
        id: "attention-stale-waiting",
        title: "Stale waiting",
        state: "waiting",
        updatedAt: now - ATTENTION_STALE_AFTER_MS - 1,
      });
      record({
        id: "attention-live-waiting",
        title: "Live waiting",
        state: "waiting",
        updatedAt: now - 10_000,
      });
      record({
        id: "attention-duplicate-older",
        title: "Duplicate handback",
        updatedAt: now - 20_000,
      });
      record({
        id: "attention-duplicate-newer",
        title: "Duplicate handback",
        updatedAt: now - 5_000,
      });

      const ids = queryFleetAttentionRows(["operator"], 20).map((row) => row.record_id);

      expect(ids).toContain("attention-live-review");
      expect(ids).toContain("attention-live-waiting");
      expect(ids).not.toContain("attention-stale-review");
      expect(ids).not.toContain("attention-stale-waiting");
      expect(ids).toContain("attention-duplicate-newer");
      expect(ids).not.toContain("attention-duplicate-older");
    } finally {
      clock.mockRestore();
      store.close();
    }
  });

  test("focuses on active asks, recent completions, and attention owned by the operator", () => {
    const store = createSeededStore();
    const now = Date.now();
    const old = now - (5 * 24 * 60 * 60 * 1000);

    try {
      setSeededRunTimestamps(now - 60_000, now - 59_000);

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
      store.upsertConversation({
        id: "conv-2",
        kind: "direct",
        title: "Direct Two",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-2", "operator"],
      });
      store.recordInvocation({
        id: "inv-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-2",
        action: "consult",
        task: "Old completed ask",
        conversationId: "conv-2",
        ensureAwake: true,
        stream: false,
        createdAt: old,
      });
      store.recordFlight({
        id: "flight-2",
        invocationId: "inv-2",
        requesterId: "operator",
        targetAgentId: "agent-2",
        state: "completed",
        summary: "Agent Two replied.",
        startedAt: old + 1_000,
        completedAt: old + 2_000,
      });
      store.recordMessage({
        id: "msg-2",
        conversationId: "conv-2",
        actorId: "agent-2",
        originNodeId: "node-1",
        class: "agent",
        body: "Old done.",
        visibility: "private",
        policy: "durable",
        createdAt: old + 3_000,
      });

      store.upsertActor({
        id: "agent-3",
        kind: "agent",
        displayName: "Agent Three",
      });
      store.upsertAgent({
        id: "agent-3",
        kind: "agent",
        definitionId: "agent-3",
        displayName: "Agent Three",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertEndpoint({
        id: "endpoint-3",
        agentId: "agent-3",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "idle",
        sessionId: "session-3",
        cwd: join(tmpdir(), "openscout-agent-3", "cwd"),
        projectRoot: join(tmpdir(), "openscout-agent-3"),
      });
      store.upsertConversation({
        id: "conv-3",
        kind: "direct",
        title: "Direct Three",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-3", "operator"],
      });
      store.recordInvocation({
        id: "inv-3",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-3",
        action: "consult",
        task: "Recent completed ask",
        conversationId: "conv-3",
        ensureAwake: true,
        stream: false,
        createdAt: now - 60_000,
      });
      store.recordFlight({
        id: "flight-3",
        invocationId: "inv-3",
        requesterId: "operator",
        targetAgentId: "agent-3",
        state: "completed",
        summary: "Agent Three replied.",
        startedAt: now - 59_000,
        completedAt: now - 30_000,
      });
      store.recordInvocation({
        id: "inv-dismissed-failure",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-3",
        action: "consult",
        task: "Dismissed failed ask",
        conversationId: "conv-3",
        ensureAwake: true,
        stream: false,
        createdAt: now - 55_000,
      });
      store.recordFlight({
        id: "flight-dismissed-failure",
        invocationId: "inv-dismissed-failure",
        requesterId: "operator",
        targetAgentId: "agent-3",
        state: "failed",
        summary: "Failure was reviewed and dismissed.",
        error: "Synthetic dismissed failure.",
        startedAt: now - 54_000,
        completedAt: now - 53_000,
        metadata: {
          operatorAttentionDismissedAt: now - 52_000,
        },
      });
      store.recordMessage({
        id: "msg-3",
        conversationId: "conv-3",
        actorId: "agent-3",
        originNodeId: "node-1",
        class: "agent",
        body: "Done.",
        visibility: "private",
        policy: "durable",
        createdAt: now - 29_000,
      });
      store.recordCollaborationRecord({
        id: "question-1",
        kind: "question",
        title: "Need your decision",
        summary: "Should I ship this as-is?",
        createdById: "agent-3",
        ownerId: "agent-3",
        nextMoveOwnerId: "operator",
        conversationId: "conv-3",
        state: "open",
        acceptanceState: "none",
        askedById: "agent-3",
        askedOfId: "operator",
        createdAt: now - 20_000,
        updatedAt: now - 10_000,
      });
      store.recordCollaborationRecord({
        id: "work-pending-resolved",
        kind: "work_item",
        title: "Pending work with a later owner action",
        summary: "The owner replied after the pending handoff.",
        createdById: "operator",
        ownerId: "agent-3",
        nextMoveOwnerId: "agent-3",
        conversationId: "conv-3",
        state: "open",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: now - 26_000,
        updatedAt: now - 25_000,
      });
      store.recordMessage({
        id: "msg-3-pending-resolution",
        conversationId: "conv-3",
        actorId: "agent-3",
        originNodeId: "node-1",
        class: "agent",
        body: "I picked this up in the thread.",
        visibility: "private",
        policy: "durable",
        createdAt: now - 24_000,
      });
      store.recordCollaborationRecord({
        id: "work-pending-unresolved",
        kind: "work_item",
        title: "Review pending without a later owner action",
        summary: "This completed work still needs an acceptance decision.",
        createdById: "operator",
        ownerId: "agent-3",
        nextMoveOwnerId: "operator",
        conversationId: "conv-3",
        state: "review",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: now - 6_000,
        updatedAt: now - 5_000,
      });
      store.recordCollaborationRecord({
        id: "work-pending-in-progress",
        kind: "work_item",
        title: "Ordinary work still in progress",
        summary: "Pending acceptance is lifecycle bookkeeping until review is requested.",
        createdById: "operator",
        ownerId: "agent-3",
        nextMoveOwnerId: "agent-3",
        conversationId: "conv-3",
        state: "working",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: now - 8_000,
        updatedAt: now - 7_000,
      });
      store.recordCollaborationRecord({
        id: "question-dismissed",
        kind: "question",
        title: "Dismissed question",
        summary: "This should stay out of the operator queue.",
        createdById: "agent-3",
        ownerId: "agent-3",
        nextMoveOwnerId: "operator",
        conversationId: "conv-3",
        state: "open",
        acceptanceState: "none",
        askedById: "agent-3",
        askedOfId: "operator",
        createdAt: now - 4_000,
        updatedAt: now - 3_000,
      });
      store.recordCollaborationEvent({
        id: "event-question-dismissed",
        recordId: "question-dismissed",
        recordKind: "question",
        kind: "dismissed",
        actorId: "operator",
        summary: "Dismissed from operator queue.",
        at: now - 2_000,
      });
      store.upsertActor({
        id: "agent-4",
        kind: "agent",
        displayName: "Agent Four",
      });
      store.upsertAgent({
        id: "agent-4",
        kind: "agent",
        definitionId: "agent-4",
        displayName: "Agent Four",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertConversation({
        id: "conv-4",
        kind: "direct",
        title: "Direct Four",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-4", "operator"],
      });
      store.recordInvocation({
        id: "inv-4",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-4",
        action: "consult",
        task: "Synthetic stale failure",
        conversationId: "conv-4",
        ensureAwake: true,
        stream: false,
        createdAt: now - 45_000,
      });
      store.recordFlight({
        id: "flight-4",
        invocationId: "inv-4",
        requesterId: "operator",
        targetAgentId: "agent-4",
        state: "failed",
        summary: "Agent Four did not finish cleanly.",
        error: "Stale running flight reconciled: endpoint endpoint-4 started newer work at 1234567890",
        startedAt: now - 44_000,
        completedAt: now - 43_000,
      });

      const fleet = queryFleet({ limit: 10, activityLimit: 20 });

      expect(fleet.totals).toMatchObject({
        active: 1,
        recentCompleted: 1,
        needsAttention: 1,
      });

      expect(fleet.activeAsks).toHaveLength(1);
      expect(fleet.activeAsks[0]).toMatchObject({
        agentId: "agent-1",
        status: "working",
        agentState: "working",
      });

      expect(fleet.recentCompleted).toHaveLength(1);
      expect(fleet.recentCompleted[0]).toMatchObject({
        agentId: "agent-3",
        status: "completed",
        agentState: "available",
      });
      expect(fleet.recentCompleted.some((ask) => ask.invocationId === "inv-dismissed-failure")).toBe(false);

      // The operator's own dispatched work coming back for review is that ask
      // ending — only the agent-declared question is operator attention.
      expect(fleet.needsAttention.some((item) => item.recordId === "work-pending-unresolved")).toBe(false);
      expect(fleet.needsAttention).toEqual([
        expect.objectContaining({
          kind: "question",
          recordId: "question-1",
          title: "Need your decision",
          agentId: "agent-3",
          agentName: "Agent Three",
          conversationId: "conv-3",
          state: "open",
          acceptanceState: "none",
        }),
      ]);
      expect(fleet.needsAttention.some((item) => item.recordId === "work-pending-resolved")).toBe(false);
      expect(fleet.needsAttention.some((item) => item.recordId === "work-pending-in-progress")).toBe(false);
      expect(fleet.needsAttention.some((item) => item.recordId === "question-dismissed")).toBe(false);
      expect(fleet.activity.map((item) => item.ts)).toEqual([...fleet.activity.map((item) => item.ts)].sort((a, b) => b - a));
      expect(fleet.recentCompleted.some((ask) => ask.agentId === "agent-4")).toBe(false);
      expect(fleet.activity.some((item) => item.id === "activity:flight:flight-4")).toBe(false);
    } finally {
      store.close();
    }
  });

  test("operator-sent asks end on reply; only agent-declared records are operator attention", () => {
    const store = createSeededStore();
    const now = Date.now();

    const seedAgent = (agentId: string, conversationId: string, displayName: string) => {
      store.upsertActor({ id: agentId, kind: "agent", displayName });
      store.upsertAgent({
        id: agentId,
        kind: "agent",
        definitionId: agentId,
        displayName,
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertConversation({
        id: conversationId,
        kind: "direct",
        title: displayName,
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: [agentId, "operator"],
      });
    };

    try {
      // A dispatched work item remains explicitly agent-owned while it runs;
      // pending acceptance alone must not manufacture operator attention.
      seedAgent("agent-5", "conv-5", "Agent Five");
      store.recordCollaborationRecord({
        id: "work-born-pending",
        kind: "work_item",
        title: "Dispatched work still agent-owned",
        createdById: "operator",
        ownerId: "agent-5",
        nextMoveOwnerId: "agent-5",
        conversationId: "conv-5",
        state: "working",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: now - 50_000,
        updatedAt: now - 45_000,
      });
      store.recordInvocation({
        id: "inv-born-pending",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-5",
        action: "consult",
        task: "Born-pending dispatch",
        collaborationRecordId: "work-born-pending",
        conversationId: "conv-5",
        ensureAwake: true,
        stream: false,
        createdAt: now - 50_000,
      });
      store.recordFlight({
        id: "flight-born-pending",
        invocationId: "inv-born-pending",
        requesterId: "operator",
        targetAgentId: "agent-5",
        state: "completed",
        summary: "Agent Five replied.",
        startedAt: now - 49_000,
        completedAt: now - 48_000,
      });

      // A review handback on the operator's own dispatch, followed by an
      // unrelated failed re-dispatch in the same conversation.
      seedAgent("agent-6", "conv-6", "Agent Six");
      store.recordCollaborationRecord({
        id: "work-review-superseded",
        kind: "work_item",
        title: "Handback the operator moved past",
        createdById: "operator",
        ownerId: "agent-6",
        nextMoveOwnerId: "operator",
        conversationId: "conv-6",
        state: "review",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: now - 44_000,
        updatedAt: now - 35_000,
      });
      store.recordInvocation({
        id: "inv-superseded",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-6",
        action: "consult",
        task: "First dispatch",
        collaborationRecordId: "work-review-superseded",
        conversationId: "conv-6",
        ensureAwake: true,
        stream: false,
        createdAt: now - 44_000,
      });
      store.recordFlight({
        id: "flight-superseded",
        invocationId: "inv-superseded",
        requesterId: "operator",
        targetAgentId: "agent-6",
        state: "completed",
        summary: "Agent Six handed the work back.",
        startedAt: now - 43_000,
        completedAt: now - 40_000,
      });
      store.recordInvocation({
        id: "inv-failed-redispatch",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-6",
        action: "consult",
        task: "Second dispatch",
        conversationId: "conv-6",
        ensureAwake: true,
        stream: false,
        createdAt: now - 30_000,
      });
      store.recordFlight({
        id: "flight-failed-redispatch",
        invocationId: "inv-failed-redispatch",
        requesterId: "operator",
        targetAgentId: "agent-6",
        state: "failed",
        summary: "Agent Six failed to respond.",
        error: "Local agent turn was interrupted.",
        startedAt: now - 29_000,
        completedAt: now - 28_000,
      });

      // An unanswered review handback on the operator's own dispatch.
      seedAgent("agent-7", "conv-7", "Agent Seven");
      store.recordCollaborationRecord({
        id: "work-review-live",
        kind: "work_item",
        title: "Handback awaiting the operator",
        createdById: "operator",
        ownerId: "agent-7",
        nextMoveOwnerId: "operator",
        conversationId: "conv-7",
        state: "review",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: now - 26_000,
        updatedAt: now - 20_000,
      });
      store.recordInvocation({
        id: "inv-review-live",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-7",
        action: "consult",
        task: "Review-worthy dispatch",
        collaborationRecordId: "work-review-live",
        conversationId: "conv-7",
        ensureAwake: true,
        stream: false,
        createdAt: now - 26_000,
      });
      store.recordFlight({
        id: "flight-review-live",
        invocationId: "inv-review-live",
        requesterId: "operator",
        targetAgentId: "agent-7",
        state: "completed",
        summary: "Agent Seven asks for review.",
        startedAt: now - 25_000,
        completedAt: now - 24_000,
      });

      // Reading a handback is not a workflow transition and must not silently
      // accept or reassign the collaboration record.
      seedAgent("agent-8", "conv-8", "Agent Eight");
      store.recordCollaborationRecord({
        id: "work-review-read",
        kind: "work_item",
        title: "Handback the operator already read",
        createdById: "operator",
        ownerId: "agent-8",
        nextMoveOwnerId: "operator",
        conversationId: "conv-8",
        state: "review",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: now - 18_000,
        updatedAt: now - 15_000,
      });
      store.recordInvocation({
        id: "inv-review-read",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-8",
        action: "consult",
        task: "Read-review dispatch",
        collaborationRecordId: "work-review-read",
        conversationId: "conv-8",
        ensureAwake: true,
        stream: false,
        createdAt: now - 18_000,
      });
      store.recordFlight({
        id: "flight-review-read",
        invocationId: "inv-review-read",
        requesterId: "operator",
        targetAgentId: "agent-8",
        state: "completed",
        summary: "Agent Eight handed the work back.",
        startedAt: now - 17_000,
        completedAt: now - 15_000,
      });
      store.recordMessage({
        id: "msg-review-read-handback",
        conversationId: "conv-8",
        actorId: "agent-8",
        originNodeId: "node-1",
        class: "agent",
        body: "Here is the review you asked for.",
        visibility: "private",
        policy: "durable",
        createdAt: now - 14_500,
      });
      store.upsertReadCursor({
        conversationId: "conv-8",
        actorId: "operator",
        lastReadMessageId: "msg-review-read-handback",
        lastReadAt: now - 10_000,
        updatedAt: now - 10_000,
      });

      // Operator-created work assigned back to the operator is still the
      // operator's own ask, not an agent asking.
      seedAgent("agent-9", "conv-9", "Agent Nine");
      store.recordCollaborationRecord({
        id: "work-creator-awaiting",
        kind: "work_item",
        title: "Operator-created work explicitly returned",
        createdById: "operator",
        ownerId: "agent-9",
        nextMoveOwnerId: "operator",
        conversationId: "conv-9",
        state: "waiting",
        acceptanceState: "pending",
        requestedById: "operator",
        createdAt: now - 14_000,
        updatedAt: now - 12_000,
      });
      store.recordInvocation({
        id: "inv-creator-awaiting",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-9",
        action: "consult",
        task: "Operator-created explicit handback",
        collaborationRecordId: "work-creator-awaiting",
        conversationId: "conv-9",
        ensureAwake: true,
        stream: false,
        createdAt: now - 14_000,
      });
      store.recordFlight({
        id: "flight-creator-awaiting",
        invocationId: "inv-creator-awaiting",
        requesterId: "operator",
        targetAgentId: "agent-9",
        state: "completed",
        summary: "Agent Nine explicitly returned the next move.",
        startedAt: now - 13_500,
        completedAt: now - 13_000,
      });

      const fleet = queryFleet({ limit: 10, activityLimit: 5 });

      // Every invocation here is an ask the operator SENT. The agent's reply
      // and the broker's automatic review handback end that ask; none of them
      // is the agent asking the operator, however the record is assigned.
      expect(fleet.activeAsks.some((ask) => ask.status === "needs_attention")).toBe(false);

      const byInvocationId = new Map(
        [...fleet.activeAsks, ...fleet.recentCompleted].map((ask) => [ask.invocationId, ask]),
      );
      expect(byInvocationId.get("inv-born-pending")?.status).toBe("completed");
      expect(byInvocationId.get("inv-superseded")?.status).toBe("completed");
      expect(byInvocationId.get("inv-failed-redispatch")?.status).toBe("failed");
      expect(byInvocationId.get("inv-review-live")?.status).toBe("completed");
      expect(byInvocationId.get("inv-review-read")?.status).toBe("completed");
      expect(byInvocationId.get("inv-creator-awaiting")?.status).toBe("completed");
      for (const id of ["inv-review-live", "inv-review-read", "inv-creator-awaiting"]) {
        expect(byInvocationId.get(id)?.attention).toBe("silent");
      }
      // The operator's own handbacks are not Inbox attention either.
      expect(fleet.needsAttention).toEqual([]);

      // A question the operator asked, answered by the agent, is the operator's
      // ask ending — not attention. A question an agent declared to the
      // operator is attention until an explicit transition resolves it.
      store.recordCollaborationRecord({
        id: "question-operator-asked",
        kind: "question",
        title: "Operator asked the agent",
        createdById: "operator",
        ownerId: "agent-7",
        nextMoveOwnerId: "operator",
        conversationId: "conv-7",
        state: "answered",
        acceptanceState: "pending",
        askedById: "operator",
        askedOfId: "agent-7",
        createdAt: now - 4_000,
        updatedAt: now - 3_000,
      });
      const declaredQuestion = {
        id: "question-declared",
        kind: "question" as const,
        title: "Which export target?",
        createdById: "agent-7",
        ownerId: "agent-7",
        nextMoveOwnerId: "operator",
        conversationId: "conv-7",
        state: "open" as const,
        acceptanceState: "none" as const,
        askedById: "agent-7",
        askedOfId: "operator",
        createdAt: now - 2_500,
        updatedAt: now - 2_000,
      };
      store.recordCollaborationRecord(declaredQuestion);

      const withDeclared = queryFleet({ limit: 10, activityLimit: 5 });
      expect(withDeclared.needsAttention.map((item) => item.recordId)).toEqual([
        "question-declared",
      ]);

      store.recordCollaborationRecord({
        ...declaredQuestion,
        state: "closed",
        acceptanceState: "accepted",
        nextMoveOwnerId: undefined,
        updatedAt: now - 500,
      });
      const afterTransitions = queryFleet({ limit: 10, activityLimit: 5 });
      expect(afterTransitions.needsAttention).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("a standing operator dismissal resolves a declared handback until the record moves again", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.upsertActor({ id: "agent-10", kind: "agent", displayName: "Agent Ten" });
      store.upsertAgent({
        id: "agent-10",
        kind: "agent",
        definitionId: "agent-10",
        displayName: "Agent Ten",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertConversation({
        id: "conv-10",
        kind: "direct",
        title: "Agent Ten",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-10", "operator"],
      });
      // An agent-declared handback (the agent created it and returned the
      // next move to the operator) — the only kind of record that is attention.
      const record = {
        id: "work-dismissed-standing",
        kind: "work_item" as const,
        title: "Handback the operator dismissed",
        createdById: "agent-10",
        ownerId: "agent-10",
        nextMoveOwnerId: "operator",
        conversationId: "conv-10",
        state: "waiting" as const,
        acceptanceState: "pending" as const,
        requestedById: "agent-10",
        createdAt: now - 30_000,
        updatedAt: now - 20_000,
      };
      store.recordCollaborationRecord(record);
      expect(queryFleet({ limit: 10, activityLimit: 5 }).needsAttention
        .some((item) => item.recordId === "work-dismissed-standing")).toBe(true);

      store.recordCollaborationEvent({
        id: "event-work-dismissed-standing",
        recordId: "work-dismissed-standing",
        recordKind: "work_item",
        kind: "dismissed",
        actorId: "operator",
        summary: "Dismissed from operator queue.",
        at: now - 10_000,
      });

      // The dismissal outdates the record's last movement, so the handback is
      // resolved: no attention row.
      const fleet = queryFleet({ limit: 10, activityLimit: 5 });
      expect(fleet.needsAttention.some((item) => item.recordId === "work-dismissed-standing")).toBe(false);

      // New movement on the record outdates the dismissal; the handback is
      // attention again.
      store.recordCollaborationRecord({ ...record, updatedAt: now - 5_000 });
      const revived = queryFleet({ limit: 10, activityLimit: 5 });
      expect(revived.needsAttention.some((item) => item.recordId === "work-dismissed-standing")).toBe(true);
    } finally {
      store.close();
    }
  });

  test("does not let later replies refresh older unrelated ask failures", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.upsertActor({
        id: "system",
        kind: "system",
        displayName: "System",
      });
      store.recordMessage({
        id: "msg-recovered-stale-resume-request",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "Recovered stale resume failure",
        visibility: "private",
        policy: "durable",
        createdAt: now - 70_500,
      });
      store.recordInvocation({
        id: "inv-recovered-stale-resume",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Recovered stale resume failure",
        conversationId: "c.conv-1",
        messageId: "msg-recovered-stale-resume-request",
        ensureAwake: true,
        stream: false,
        createdAt: now - 70_000,
      });
      store.recordFlight({
        id: "flight-recovered-stale-resume",
        invocationId: "inv-recovered-stale-resume",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        summary: "Agent One failed to respond.",
        error: "No conversation found with session ID: stale-session",
        startedAt: now - 69_000,
        completedAt: now - 68_000,
      });
      store.recordMessage({
        id: "msg-recovered-stale-resume-status",
        conversationId: "c.conv-1",
        actorId: "system",
        originNodeId: "node-1",
        class: "status",
        body: "Agent One failed to respond.\nNo conversation found with session ID: stale-session",
        replyToMessageId: "msg-recovered-stale-resume-request",
        visibility: "private",
        policy: "durable",
        createdAt: now - 67_000,
        metadata: { targetAgentId: "agent-1" },
      });

      store.recordMessage({
        id: "msg-task-failure-request",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "Task failure should stay visible",
        visibility: "private",
        policy: "durable",
        createdAt: now - 60_500,
      });
      store.recordInvocation({
        id: "inv-task-failure",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Task failure should stay visible",
        conversationId: "c.conv-1",
        messageId: "msg-task-failure-request",
        ensureAwake: true,
        stream: false,
        createdAt: now - 60_000,
      });
      store.recordFlight({
        id: "flight-task-failure",
        invocationId: "inv-task-failure",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        summary: "Agent One failed the task.",
        error: "Tests failed.",
        startedAt: now - 59_000,
        completedAt: now - 58_000,
      });
      store.recordMessage({
        id: "msg-task-failure-status",
        conversationId: "c.conv-1",
        actorId: "system",
        originNodeId: "node-1",
        class: "status",
        body: "Task failed for this specific invocation.",
        replyToMessageId: "msg-task-failure-request",
        visibility: "private",
        policy: "durable",
        createdAt: now - 57_000,
        metadata: { targetAgentId: "agent-1" },
      });

      store.recordMessage({
        id: "msg-later-success-request",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "Later successful smoke check",
        visibility: "private",
        policy: "durable",
        createdAt: now - 40_500,
      });
      store.recordInvocation({
        id: "inv-later-success",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Later successful smoke check",
        conversationId: "c.conv-1",
        messageId: "msg-later-success-request",
        ensureAwake: true,
        stream: false,
        createdAt: now - 40_000,
      });
      store.recordFlight({
        id: "flight-later-success",
        invocationId: "inv-later-success",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Agent One replied.",
        startedAt: now - 39_000,
        completedAt: now - 38_000,
      });
      store.recordMessage({
        id: "msg-later-success-reply",
        conversationId: "c.conv-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Recovered and healthy.",
        replyToMessageId: "msg-later-success-request",
        visibility: "private",
        policy: "durable",
        createdAt: now - 37_000,
      });

      const fleet = queryFleet({ limit: 10, activityLimit: 20 });

      expect(fleet.recentCompleted.some((ask) => ask.invocationId === "inv-recovered-stale-resume")).toBe(false);
      expect(fleet.recentCompleted).toContainEqual(expect.objectContaining({
        invocationId: "inv-later-success",
        status: "completed",
        summary: "Recovered and healthy.",
      }));
      expect(fleet.recentCompleted).toContainEqual(expect.objectContaining({
        invocationId: "inv-task-failure",
        status: "failed",
        attention: "interrupt",
        summary: "Task failed for this specific invocation.",
        updatedAt: now - 57_000,
      }));
    } finally {
      store.close();
    }
  });

  test("projects noteworthy SIGTERM ask interruptions without interrupt-level attention", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.recordInvocation({
        id: "inv-noteworthy-sigterm",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Review the current spec",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: now - 20_000,
      });
      store.recordFlight({
        id: "flight-noteworthy-sigterm",
        invocationId: "inv-noteworthy-sigterm",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        summary: "Agent One was interrupted by a local Codex app-server SIGTERM.",
        startedAt: now - 19_000,
        completedAt: now - 18_000,
        metadata: {
          failureStage: "codex_app_server_sigterm",
          failureSeverity: "noteworthy",
          noteworthy: true,
        },
      });
      store.recordInvocation({
        id: "inv-proactive-stop",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Active turn stopped by OpenScout",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: now - 16_000,
      });
      store.recordFlight({
        id: "flight-proactive-stop",
        invocationId: "inv-proactive-stop",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "failed",
        summary: "Agent One was stopped by OpenScout before it could reply.",
        startedAt: now - 15_000,
        completedAt: now - 14_000,
        metadata: {
          failureStage: "codex_app_server_proactive_shutdown",
          failureSeverity: "noteworthy",
          noteworthy: true,
        },
      });

      const fleet = queryFleet({ limit: 10, activityLimit: 20 });

      expect(fleet.recentCompleted).toContainEqual(expect.objectContaining({
        invocationId: "inv-noteworthy-sigterm",
        status: "failed",
        statusLabel: "Interrupted",
        attention: "badge",
        summary: "Agent One was interrupted by a local Codex app-server SIGTERM.",
      }));
      expect(fleet.recentCompleted).toContainEqual(expect.objectContaining({
        invocationId: "inv-proactive-stop",
        status: "failed",
        statusLabel: "Stopped",
        attention: "badge",
        summary: "Agent One was stopped by OpenScout before it could reply.",
      }));
    } finally {
      store.close();
    }
  });

  test("keeps an acknowledged running ask active until the flight completes", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.recordMessage({
        id: "msg-ack-request",
        conversationId: "c.conv-1",
        actorId: "operator",
        originNodeId: "node-1",
        class: "agent",
        body: "Please review the current patch.",
        visibility: "private",
        policy: "durable",
        createdAt: now - 10_000,
      });
      store.recordInvocation({
        id: "inv-ack",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Review the current patch",
        conversationId: "c.conv-1",
        messageId: "msg-ack-request",
        ensureAwake: true,
        stream: false,
        createdAt: now - 9_000,
      });
      store.recordFlight({
        id: "flight-ack",
        invocationId: "inv-ack",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        summary: "Agent One acknowledged via codex_app_server.",
        startedAt: now - 8_000,
      });
      store.recordMessage({
        id: "msg-ack-reply",
        conversationId: "c.conv-1",
        replyToMessageId: "msg-ack-request",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "I have it and am working on it.",
        visibility: "private",
        policy: "durable",
        createdAt: now - 7_000,
      });

      const acknowledgedAsk = queryFleet({ limit: 10, activityLimit: 20 })
        .activeAsks
        .find((ask) => ask.invocationId === "inv-ack");

      expect(acknowledgedAsk).toMatchObject({
        invocationId: "inv-ack",
        status: "working",
        statusLabel: "Acknowledged",
        acknowledgedAt: now - 7_000,
        summary: "I have it and am working on it.",
      });
    } finally {
      store.close();
    }
  });

  test("a requester-timed-out running ask is not presented as active work", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.recordInvocation({
        id: "inv-stopped-waiting",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Just saying hi.",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: now - 120_000,
      });
      store.recordFlight({
        id: "flight-stopped-waiting",
        invocationId: "inv-stopped-waiting",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "running",
        // The broker's timeout path writes exactly this sentence, which names
        // none of the prose phrases the client used to sniff for.
        summary: "Agent One is still working.",
        startedAt: now - 119_000,
        metadata: {
          requesterTimedOut: true,
          timeoutMs: 300_000,
          timeoutScope: "requester_wait",
        },
      });

      const fleet = queryFleet({ limit: 10, activityLimit: 20 });
      const ask = [...fleet.activeAsks, ...fleet.recentCompleted]
        .find((candidate) => candidate.invocationId === "inv-stopped-waiting");

      expect(fleet.activeAsks.some((candidate) => candidate.invocationId === "inv-stopped-waiting"))
        .toBe(false);
      expect(ask).toMatchObject({
        invocationId: "inv-stopped-waiting",
        status: "completed",
        statusLabel: "Stopped waiting",
        attention: "silent",
      });
    } finally {
      store.close();
    }
  });

  test("an agent's reply to the operator's ask never reads as the agent asking", () => {
    // Regression: a completed consult is promoted by the broker to a `review`
    // work item with the next move on the operator and an automatic
    // `review_requested` event under the agent's id. That is the operator's
    // ask ending, not a declared ask addressed to the operator.
    const store = createSeededStore();
    const now = Date.now();
    try {
      store.recordCollaborationRecord({
        id: "work-replied", kind: "work_item", title: "Quick high-level design feedback",
        createdById: "operator", ownerId: "agent-1", nextMoveOwnerId: "operator",
        conversationId: "c.conv-1", state: "review", acceptanceState: "pending",
        requestedById: "operator", createdAt: now - 60_000, updatedAt: now - 20_000,
      });
      store.recordCollaborationEvent({
        id: "event-work-replied-review", recordId: "work-replied", recordKind: "work_item",
        kind: "review_requested", actorId: "agent-1", summary: "Overall shape is right.",
        at: now - 20_000,
      });
      store.recordInvocation({
        id: "inv-replied", requesterId: "operator", requesterNodeId: "node-1",
        targetAgentId: "agent-1", action: "consult", task: "Quick high-level design feedback, please.",
        collaborationRecordId: "work-replied", conversationId: "c.conv-1",
        ensureAwake: true, stream: false, createdAt: now - 60_000,
      });
      store.recordFlight({
        id: "flight-replied", invocationId: "inv-replied", requesterId: "operator",
        targetAgentId: "agent-1", state: "completed", summary: "Agent One replied.",
        startedAt: now - 59_000, completedAt: now - 20_000,
      });
      const fleet = queryFleet({ limit: 10, activityLimit: 20 });
      expect(fleet.activeAsks.some((ask) => ask.invocationId === "inv-replied")).toBe(false);
      const ask = fleet.recentCompleted.find((item) => item.invocationId === "inv-replied");
      expect(ask?.status).toBe("completed");
      expect(ask?.attention).toBe("silent");
      expect(fleet.needsAttention.some((item) => item.recordId === "work-replied")).toBe(false);
    } finally { store.close(); }
  });

  test("requester timeout on the operator's own reviewed dispatch ends quietly, not as an ask", () => {
    const store = createSeededStore();
    const now = Date.now();
    try {
      store.recordCollaborationRecord({
        id: "work-timeout-review", kind: "work_item", title: "Review the result",
        createdById: "operator", ownerId: "agent-1", nextMoveOwnerId: "operator",
        conversationId: "c.conv-1", state: "review", acceptanceState: "pending",
        requestedById: "operator", createdAt: now - 120_000, updatedAt: now - 1_000,
      });
      store.recordInvocation({
        id: "inv-timeout-review", requesterId: "operator", requesterNodeId: "node-1",
        targetAgentId: "agent-1", action: "consult", task: "Review work",
        collaborationRecordId: "work-timeout-review", conversationId: "c.conv-1",
        ensureAwake: true, stream: false, createdAt: now - 120_000,
      });
      store.recordFlight({
        id: "flight-timeout-review", invocationId: "inv-timeout-review",
        requesterId: "operator", targetAgentId: "agent-1", state: "running",
        summary: "Agent One is still working.", startedAt: now - 119_000,
        metadata: { requesterTimedOut: true, timeoutScope: "requester_wait" },
      });
      const fleet = queryFleet({ limit: 10, activityLimit: 20 });
      const ask = [...fleet.activeAsks, ...fleet.recentCompleted]
        .find((item) => item.invocationId === "inv-timeout-review");
      expect(ask?.status).toBe("completed");
      expect(ask?.statusLabel).toBe("Stopped waiting");
      expect(ask?.attention).toBe("silent");
      expect(fleet.needsAttention.some((item) => item.recordId === "work-timeout-review")).toBe(false);
    } finally { store.close(); }
  });

  test("projects queued-until-online asks as not delivered instead of active work", () => {
    const store = createSeededStore();
    const now = Date.now();

    try {
      store.upsertActor({
        id: "agent-offline",
        kind: "agent",
        displayName: "Offline Agent",
      });
      store.upsertAgent({
        id: "agent-offline",
        kind: "agent",
        definitionId: "agent-offline",
        displayName: "Offline Agent",
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      store.upsertConversation({
        id: "conv-offline",
        kind: "direct",
        title: "Offline Agent",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-offline", "operator"],
      });
      store.recordInvocation({
        id: "inv-offline",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-offline",
        action: "consult",
        task: "Hold this until the agent is reachable",
        conversationId: "conv-offline",
        ensureAwake: true,
        stream: false,
        createdAt: now - 2_000,
      });
      store.recordFlight({
        id: "flight-offline",
        invocationId: "inv-offline",
        requesterId: "operator",
        targetAgentId: "agent-offline",
        state: "queued",
        summary: "Message stored for Offline Agent. Will deliver when online.",
        startedAt: now - 1_000,
        metadata: {
          dispatchOutcome: {
            status: "queued_until_online",
            reason: "no_runnable_endpoint",
            checkedAt: now - 1_000,
          },
        },
      });
      const stale = now - 3 * 24 * 60 * 60 * 1000;
      store.recordInvocation({
        id: "inv-offline-stale",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-offline",
        action: "consult",
        task: "Old held message",
        conversationId: "conv-offline",
        ensureAwake: true,
        stream: false,
        createdAt: stale,
      });
      store.recordFlight({
        id: "flight-offline-stale",
        invocationId: "inv-offline-stale",
        requesterId: "operator",
        targetAgentId: "agent-offline",
        state: "queued",
        summary: "Message stored for Offline Agent. Will deliver when online.",
        startedAt: stale,
        metadata: {
          dispatchOutcome: {
            status: "queued_until_online",
            reason: "no_runnable_endpoint",
            checkedAt: stale,
          },
        },
      });

      const fleet = queryFleet({ limit: 10, activityLimit: 20 });
      const activeAsks = fleet.activeAsks;
      const recent = fleet.recentCompleted.find((candidate) => candidate.invocationId === "inv-offline");

      expect(recent).toMatchObject({
        invocationId: "inv-offline",
        status: "failed",
        statusLabel: "Not delivered",
        summary: "No runnable endpoint was available.",
      });
      expect(activeAsks.some((candidate) => candidate.invocationId === "inv-offline")).toBe(false);
      expect(activeAsks.some((candidate) => candidate.invocationId === "inv-offline-stale")).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("web db query work item by id", () => {
  test("returns detail with ordered timeline, child work, and active flights", () => {
    const store = createSeededStore();

    try {
      const now = Date.now();
      setSeededRunTimestamps(now - 60_000, now - 59_000);

      store.recordCollaborationEvent({
        id: "event-2",
        recordId: "work-1",
        recordKind: "work_item",
        kind: "progressed",
        actorId: "agent-1",
        summary: "Implemented first pass",
        at: 150,
      });
      const detail = queryWorkItemById("work-1");
      expect(detail).not.toBeNull();
      if (!detail) throw new Error("missing detail");

      expect(detail.id).toBe("work-1");
      expect(detail.title).toBe("Observed work");
      expect(detail.createdAt).toBe(90);
      expect(detail.updatedAt).toBe(90);
      expect(detail.parentId).toBeNull();
      expect(detail.childWork.map((c) => c.id)).toEqual(["work-1-child"]);
      expect(detail.activeFlights.map((f) => f.id)).toEqual(["flight-1"]);

      const descendingTimestamps = detail.timeline.map((item) => item.at);
      const sorted = [...descendingTimestamps].sort((a, b) => b - a);
      expect(descendingTimestamps).toEqual(sorted);

      const kinds = detail.timeline.map((item) => `${item.kind}:${item.id}`);
      expect(kinds).toContain("collaboration_event:event:event-1");
      expect(kinds).toContain("collaboration_event:event:event-2");
      expect(kinds).toContain("flight_started:flight:flight-1:started");
      expect(kinds.some((k) => k.startsWith("message:"))).toBe(false);
    } finally {
      store.close();
    }
  });

  test("keeps direct-message inferred flights scoped to work owners", () => {
    const store = createSeededStore();

    try {
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
      store.upsertConversation({
        id: "dm.operator.agent-1",
        kind: "direct",
        title: "Agent One",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });
      store.recordCollaborationRecord({
        id: "work-inferred-direct",
        kind: "work_item",
        title: "Direct inferred work",
        createdById: "operator",
        ownerId: "agent-1",
        nextMoveOwnerId: "operator",
        conversationId: "dm.operator.agent-1",
        state: "working",
        acceptanceState: "none",
        requestedById: "operator",
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      store.recordInvocation({
        id: "inv-inferred-owner",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Work on the direct item",
        conversationId: "dm.operator.agent-1",
        ensureAwake: true,
        stream: false,
        createdAt: 1_010,
      });
      store.recordFlight({
        id: "flight-inferred-owner",
        invocationId: "inv-inferred-owner",
        requesterId: "operator",
        targetAgentId: "agent-1",
        state: "completed",
        summary: "Owner finished the work.",
        startedAt: 1_020,
        completedAt: 1_030,
      });
      store.recordInvocation({
        id: "inv-inferred-other-agent",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-2",
        action: "consult",
        task: "Unrelated direct ask",
        conversationId: "dm.operator.agent-1",
        ensureAwake: true,
        stream: false,
        createdAt: 1_040,
      });
      store.recordFlight({
        id: "flight-inferred-other-agent",
        invocationId: "inv-inferred-other-agent",
        requesterId: "operator",
        targetAgentId: "agent-2",
        state: "completed",
        summary: "Unrelated reply.",
        startedAt: 1_050,
        completedAt: 1_060,
      });

      const detail = queryWorkItemById("work-inferred-direct");
      expect(detail).not.toBeNull();
      if (!detail) throw new Error("missing detail");

      const inferredFlightIds = detail.timeline
        .filter((item) => item.id.startsWith("inferred-flight:"))
        .map((item) => item.flightId);
      expect(inferredFlightIds).toContain("flight-inferred-owner");
      expect(inferredFlightIds).not.toContain("flight-inferred-other-agent");
    } finally {
      store.close();
    }
  });

  test("returns null for unknown id", () => {
    const store = createSeededStore();
    try {
      expect(queryWorkItemById("does-not-exist")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("web db query work items", () => {
  test("projects active work rows from collaboration and execution state", () => {
    const store = createSeededStore();

    try {
      const work = queryWorkItems({ agentId: "agent-1" });

      expect(work).toEqual([
        {
          id: "work-1",
          title: "Observed work",
          summary: null,
          ownerId: "agent-1",
          ownerName: "Agent One",
          nextMoveOwnerId: "agent-1",
          nextMoveOwnerName: "Agent One",
          conversationId: "c.conv-1",
          createdAt: 90,
          updatedAt: 90,
          parentId: null,
          parentTitle: null,
          state: "working",
          acceptanceState: "none",
          priority: null,
          currentPhase: "Working",
          attention: "silent",
          activeChildWorkCount: 1,
          activeFlightCount: 1,
          lastMeaningfulAt: 110,
          lastMeaningfulSummary: "Claimed for implementation",
          codexThreadId: null,
        },
        {
          id: "work-1-child",
          title: "Child work",
          summary: null,
          ownerId: "agent-1",
          ownerName: "Agent One",
          nextMoveOwnerId: "agent-1",
          nextMoveOwnerName: "Agent One",
          conversationId: "c.conv-1",
          createdAt: 95,
          updatedAt: 95,
          parentId: "work-1",
          parentTitle: "Observed work",
          state: "open",
          acceptanceState: "none",
          priority: null,
          currentPhase: "Open",
          attention: "silent",
          activeChildWorkCount: 0,
          activeFlightCount: 0,
          lastMeaningfulAt: 95,
          lastMeaningfulSummary: "Child work",
          codexThreadId: null,
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("filters work rows by conversation", () => {
    const store = createSeededStore();

    try {
      store.upsertConversation({
        id: "conv-work-2",
        kind: "channel",
        title: "Second channel",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
      });
      store.recordCollaborationRecord({
        id: "work-conversation-2",
        kind: "work_item",
        title: "Conversation scoped work",
        createdById: "operator",
        ownerId: "agent-1",
        nextMoveOwnerId: "agent-1",
        conversationId: "conv-work-2",
        state: "working",
        acceptanceState: "none",
        requestedById: "operator",
        createdAt: 140,
        updatedAt: 140,
      });

      expect(queryWorkItems({ conversationId: "conv-work-2" }).map((item) => item.id))
        .toEqual(["work-conversation-2"]);
      expect(queryWorkItems({ conversationId: "c.conv-1" }).map((item) => item.id))
        .toEqual(["work-1", "work-1-child"]);
    } finally {
      store.close();
    }
  });

  test("reads an exact set of work ids in one bounded query", () => {
    const store = createSeededStore();

    try {
      expect(queryWorkItems({ ids: ["work-1-child", "work-missing"] }).map((item) => item.id))
        .toEqual(["work-1-child"]);
      expect(queryWorkItems({ ids: ["work-1", "work-1-child"], limit: 1 })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("operator dismissal silences derived work attention until the record changes", () => {
    const store = createSeededStore();

    try {
      store.recordCollaborationRecord({
        id: "work-dismissed-attention",
        kind: "work_item",
        title: "Waiting work",
        summary: "This has already been reviewed.",
        createdById: "operator",
        ownerId: "agent-1",
        nextMoveOwnerId: "operator",
        conversationId: "c.conv-1",
        state: "waiting",
        acceptanceState: "none",
        requestedById: "operator",
        createdAt: 200,
        updatedAt: 220,
        waitingOn: {
          kind: "actor",
          label: "operator",
        },
      });

      expect(queryWorkItemById("work-dismissed-attention")?.attention).toBe("badge");

      store.recordCollaborationEvent({
        id: "event-dismiss-work-attention",
        recordId: "work-dismissed-attention",
        recordKind: "work_item",
        kind: "dismissed",
        actorId: "operator",
        summary: "Dismissed from operator queue.",
        at: 230,
      });

      expect(queryWorkItemById("work-dismissed-attention")?.attention).toBe("silent");
    } finally {
      store.close();
    }
  });
});

test("permission requests retain separate rows and point attention at the waiting agent", () => {
  const store = createSeededStore(); const now = Date.now();
  try {
    for (const id of ["permission-a", "permission-b"]) store.recordCollaborationRecord({
      id, kind: "question", title: "Permission request", summary: "Exact prompt", state: "open", acceptanceState: "none",
      createdById: "agent-1", askedById: "agent-1", ownerId: "operator", nextMoveOwnerId: "operator",
      createdAt: now, updatedAt: now, metadata: { permissionRequest: { sessionId: id, version: "v", projectRoot: "/p" } },
    });
    const rows = queryFleetAttentionRows(["operator"], 20).filter(row => row.record_id.startsWith("permission-"));
    expect(rows.map(row => row.record_id).sort()).toEqual(["permission-a", "permission-b"]);
    expect(rows.map(row => row.agent_id)).toEqual(["agent-1", "agent-1"]);
  } finally { store.close(); }
});

describe("web polling query plans", () => {
  test("attention and active flights use read indexes and avoid unused history", () => {
    const store = createSeededStore();
    const reader = db();
    const prepare = reader.prepare.bind(reader);
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const originalPrepare = Database.prototype.prepare;
    const spy = spyOn(Database.prototype, "prepare").mockImplementation((function(this: Database, sql: string) {
      const statement = originalPrepare.call(this, sql);
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (property === "all" || property === "get") return (...params: unknown[]) => {
            queries.push({ sql, params });
            return value.apply(target, params);
          };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof reader.prepare);
    try {
      queryBrokerAttentionHints();
      queryAgentFlightPhases();
      expect(queries).toHaveLength(4);
      for (const { sql } of queries.slice(0, 3)) expect(sql).not.toContain("JOIN invocations");
      expect(queries.some(({ sql }) => /COUNT\(|delivery_attempts/.test(sql))).toBe(false);
      const plans = queries.map(({ sql, params }) => prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as any[])
        .map((row: any) => row.detail).join("\n"));
      expect(plans[0]).toContain("idx_dispatches_epoch_id");
      expect(plans[1]).toContain("idx_deliveries_failure_epoch_id");
      expect(plans[2]).toContain("idx_messages_epoch_id");
      expect(plans[3]).toContain("idx_invocations_state");
      for (const plan of plans) expect(plan).not.toContain("TEMP B-TREE");
      queries.length = 0;
      queryFleet({ limit: 2, activityLimit: 0 });
      expect(queries[0]!.sql).toContain("AS MATERIALIZED");
      const recoveryPlan = prepare(`EXPLAIN QUERY PLAN ${queries[0]!.sql}`)
        .all(...queries[0]!.params as any[]).map((row: any) => row.detail).join("\n");
      expect(recoveryPlan).toContain("SEARCH recovery_inv USING INDEX idx_invocations_completed_recovery");
      expect(recoveryPlan).not.toContain("SEARCH recovery_inv USING INDEX idx_invocations_state");
      expect(queries.some(({ sql }) => /FROM activity_items ai\s+LEFT JOIN/.test(sql))).toBe(false);
    } finally {
      spy.mockRestore();
      store.close();
    }
  });

  test("attention still reads during mixed-version startup before the failure index exists", () => {
    const store = createSeededStore();
    try {
      store.writerDb.exec("DROP INDEX idx_deliveries_failure_epoch_id");
      expect(() => queryBrokerAttentionHints()).not.toThrow();
    } finally { store.close(); }
  });

  test("attention hints are recent and sort mixed seconds/milliseconds with stable ties", () => {
    const store = createSeededStore();
    const now = Math.floor(Date.now() / 1_000) * 1_000;
    try {
      for (const [id, createdAt] of [["hint-a", now / 1_000], ["hint-b", now], ["hint-old", now - 2 * 86_400_000]] as const) {
        store.recordMessage({ id, conversationId: "c.conv-1", actorId: "agent-1", originNodeId: "node-1",
          class: "agent", body: "Permission needed", visibility: "private", policy: "durable", createdAt });
      }
      const hints = queryBrokerAttentionHints({ limit: 2 });
      expect(hints.dialogue.map(({ id }) => id)).toEqual(["hint-a", "hint-b"]);
      expect(hints.dialogue.map(({ ts }) => ts)).toEqual([now, now]);
    } finally { store.close(); }
  });
});

describe("web db session and agent task links", () => {
  test("names a session and its agent by the ask that last steered them", () => {
    const store = createSeededStore();
    try {
      store.recordCollaborationRecord({
        id: "work-2",
        kind: "work_item",
        title: "Carry the task\non session rows",
        createdById: "operator",
        ownerId: "agent-1",
        conversationId: "c.conv-1",
        state: "open",
        acceptanceState: "none",
        requestedById: "operator",
        createdAt: 200,
        updatedAt: 200,
      });
      store.recordInvocation({
        id: "inv-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Previous task inv-1 (completed):\nDone.\n\nSuccessor task:\n## Add the **task** fields\n\nDetails follow.",
        collaborationRecordId: "work-2",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 200,
      });
      // A later wake has no task of its own and must not replace the ask.
      store.recordInvocation({
        id: "inv-3",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "wake",
        task: "wake",
        conversationId: "c.conv-1",
        ensureAwake: true,
        stream: false,
        createdAt: 300,
      });

      const expected = {
        workItemId: "work-2",
        workItemTitle: "Carry the task",
        currentTask: "Add the task fields",
      };
      expect(querySessions(10).find((entry) => entry.id === "c.conv-1")).toMatchObject(expected);
      expect(querySessionById("c.conv-1")).toMatchObject(expected);
      expect(queryAgents(10).find((entry) => entry.id === "agent-1")).toMatchObject(expected);
      expect(queryAgentById("agent-1")).toMatchObject(expected);
    } finally {
      store.close();
    }
  });

  test("leaves the fields null when no ask reached the session", () => {
    const store = createSeededStore();
    try {
      store.upsertConversation({
        id: "chn-quietroom0001",
        kind: "channel",
        title: "quiet",
        visibility: "workspace",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator"],
      });
      store.recordMessage({
        id: "msg-quiet",
        conversationId: "chn-quietroom0001",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "hello",
        visibility: "workspace",
        policy: "durable",
        createdAt: 400,
      });
      expect(querySessionById("chn-quietroom0001")).toMatchObject({
        title: "quiet",
        workItemId: null,
        workItemTitle: null,
        currentTask: null,
      });
    } finally {
      store.close();
    }
  });

  test("titles a room that carries its id as a title by its work item", () => {
    const store = createSeededStore();
    try {
      store.upsertConversation({
        id: "chn-6f87a504d64f422d",
        kind: "channel",
        title: "chn-6f87a504d64f422d",
        visibility: "workspace",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator"],
      });
      store.recordInvocation({
        id: "inv-room",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "Review the room",
        collaborationRecordId: "work-1",
        conversationId: "chn-6f87a504d64f422d",
        ensureAwake: true,
        stream: false,
        createdAt: 500,
      });
      expect(querySessionById("chn-6f87a504d64f422d")).toMatchObject({
        title: "Observed work",
        workItemId: "work-1",
        currentTask: "Review the room",
      });
    } finally {
      store.close();
    }
  });
});
