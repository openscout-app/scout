import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { STALE_LOCAL_DELIVERY_GRACE_MS } from "./broker-flight-lifecycle-service.js";
import { createInvocationResultReplyIntent, invocationResultMessageId } from "./broker-invocation-result-delivery-service.js";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon reconciliation", () => {
  test("reconciles stale running flights when the endpoint has already moved on", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });
    await broker.seedBasicConversation(firstHarness);

    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "arc",
      kind: "agent",
      definitionId: "arc",
      displayName: "Arc",
      handle: "arc",
      labels: ["test"],
      selector: "@arc",
      defaultSelector: "@arc",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });

    const completedAt = Date.now();
    await broker.postJson(firstHarness.baseUrl, "/v1/endpoints", {
      id: "endpoint-arc",
      agentId: "arc",
      nodeId: firstHarness.nodeId,
      harness: "claude",
      transport: "claude_stream_json",
      state: "idle",
      address: null,
      sessionId: "relay-arc",
      pane: null,
      cwd: "/tmp/arc",
      projectRoot: "/tmp/arc",
      metadata: {
        source: "test",
        lastCompletedAt: completedAt,
      },
    });

    const startedAt = completedAt - 60_000;

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    appendFileSync(
      join(controlHome, "broker-journal.jsonl"),
      [
        JSON.stringify({
          kind: "invocation.record",
          invocation: {
            id: "inv-stale-arc",
            requesterId: "operator",
            requesterNodeId: firstHarness.nodeId,
            targetAgentId: "arc",
            action: "consult",
            task: "are you there?",
            conversationId: "channel.shared",
            ensureAwake: true,
            stream: false,
            createdAt: startedAt,
          },
        }),
        JSON.stringify({
          kind: "flight.record",
          flight: {
            id: "flt-stale-arc",
            invocationId: "inv-stale-arc",
            requesterId: "operator",
            targetAgentId: "arc",
            state: "running",
            summary: "Arc is working.",
            startedAt,
            metadata: { dispatchAck: { endpointId: "endpoint-arc", nodeId: firstHarness.nodeId, harness: "claude", sessionId: "relay-arc" } },
          },
        }),
      ].join("\n") + "\n",
    );

    const secondHarness = await broker.startBroker({ controlHome });
    const snapshot = await broker.waitFor(async () => broker.getJson<{
      flights: Record<string, { state: string; error?: string; completedAt?: number }>;
    }>(secondHarness.baseUrl, "/v1/snapshot"), (next) => next.flights["flt-stale-arc"]?.state === "failed");
    const flight = snapshot.flights["flt-stale-arc"];

    expect(flight).toBeDefined();
    expect(flight?.state).toBe("failed");
    expect(flight?.error).toContain("Didn't finish:");
    expect(flight?.metadata?.outcome).toBe("dead");
    expect(typeof flight?.completedAt).toBe("number");
  }, 15_000);

  test("does not reconcile a running flight from a dispatched endpoint because a sibling endpoint went offline", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });
    await broker.seedBasicConversation(firstHarness);

    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "arc",
      kind: "agent",
      definitionId: "arc",
      displayName: "Arc",
      handle: "arc",
      labels: ["test"],
      selector: "@arc",
      defaultSelector: "@arc",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });

    const startedAt = Date.now() - 60_000;
    const failedAt = startedAt + 1_000;
    await broker.postJson(firstHarness.baseUrl, "/v1/endpoints", {
      id: "endpoint-arc-claude",
      agentId: "arc",
      nodeId: firstHarness.nodeId,
      harness: "claude",
      transport: "claude_stream_json",
      state: "idle",
      address: null,
      sessionId: "relay-arc-claude",
      pane: null,
      cwd: "/tmp/arc",
      projectRoot: "/tmp/arc",
      metadata: { source: "test" },
    });
    await broker.postJson(firstHarness.baseUrl, "/v1/endpoints", {
      id: "endpoint-arc-codex",
      agentId: "arc",
      nodeId: firstHarness.nodeId,
      harness: "codex",
      transport: "codex_app_server",
      state: "offline",
      address: null,
      sessionId: "relay-arc-codex",
      pane: null,
      cwd: "/tmp/arc",
      projectRoot: "/tmp/arc",
      metadata: {
        source: "test",
        lastError: "codex_app_server session unavailable: relay-arc-codex",
        lastFailedAt: failedAt,
      },
    });

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    appendFileSync(
      join(controlHome, "broker-journal.jsonl"),
      [
        JSON.stringify({
          kind: "invocation.record",
          invocation: {
            id: "inv-arc-claude",
            requesterId: "operator",
            requesterNodeId: firstHarness.nodeId,
            targetAgentId: "arc",
            action: "consult",
            task: "are you there?",
            conversationId: "channel.shared",
            ensureAwake: true,
            stream: false,
            createdAt: startedAt,
          },
        }),
        JSON.stringify({
          kind: "flight.record",
          flight: {
            id: "flt-arc-claude",
            invocationId: "inv-arc-claude",
            requesterId: "operator",
            targetAgentId: "arc",
            state: "running",
            summary: "Arc acknowledged via spawn.",
            startedAt,
            metadata: {
              dispatchAck: {
                strategy: "spawn",
                endpointId: "endpoint-arc-claude",
                transport: "claude_stream_json",
                harness: "claude",
                sessionId: "relay-arc-claude",
                nodeId: firstHarness.nodeId,
                acknowledgedAt: startedAt + 100,
              },
            },
          },
        }),
      ].join("\n") + "\n",
    );

    const secondHarness = await broker.startBroker({ controlHome });
    await Bun.sleep(300);
    const snapshot = await broker.getJson<{
      flights: Record<string, { state: string; error?: string; completedAt?: number }>;
    }>(secondHarness.baseUrl, "/v1/snapshot");
    const flight = snapshot.flights["flt-arc-claude"];

    expect(flight).toBeDefined();
    expect(flight?.state).toBe("running");
    expect(flight?.error).toBeUndefined();
    expect(flight?.completedAt).toBeUndefined();
  }, 15_000);

  test("reports invocations targeting stale local endpoints instead of leaving them queued", async () => {
    const harness = await broker.startBroker({
      env: {
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
      },
    });
    const staleAt = Date.now() - 5_000;

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.test-node",
      kind: "agent",
      definitionId: "ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      selector: "@ranger.main.node:test-node",
      defaultSelector: "@ranger",
      metadata: {
        source: "relay-agent-registry",
        projectRoot: "/tmp/ranger",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-ranger-main",
      agentId: "ranger.main.test-node",
      nodeId: harness.nodeId,
      harness: "claude",
      transport: "claude_stream_json",
      state: "offline",
      address: null,
      sessionId: "relay-ranger-claude",
      pane: null,
      cwd: "/tmp/ranger",
      projectRoot: "/tmp/ranger",
      metadata: {
        source: "relay-agent-registry",
        staleLocalRegistration: true,
        staleAt,
        replacedByAgentId: "ranger.feature.test-node",
        lastError: "superseded local agent registration replaced by current setup",
        lastFailedAt: staleAt,
      },
    });

    const accepted = await broker.postJson<{
      accepted: boolean;
      invocationId: string;
      dispatch?: {
        kind: string;
        target?: {
          agentId?: string;
          reason?: string;
          detail?: string;
        };
      };
      flightId?: string;
      targetAgentId?: string;
    }>(harness.baseUrl, "/v1/invocations", {
      id: "inv-ranger-stale",
      requesterId: "operator",
      requesterNodeId: harness.nodeId,
      targetAgentId: "ranger.main.test-node",
      action: "consult",
      task: "wake up",
      execution: {
        session: "existing",
        targetSessionId: "relay-ranger-claude",
      },
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
    });

    expect(accepted.accepted).toBe(true);
    expect(accepted.invocationId).toBe("inv-ranger-stale");
    expect(accepted.targetAgentId).toBeUndefined();
    expect(accepted.flightId).toBeUndefined();
    expect(accepted.dispatch?.kind).toBe("unavailable");
    expect(accepted.dispatch?.target?.agentId).toBe("ranger.main.test-node");
    expect(accepted.dispatch?.target?.reason).toBe("session_reference_not_attachable");
    expect(accepted.dispatch?.target?.detail).toContain("superseded local registration");
    expect(accepted.dispatch?.target?.detail).toContain("replacement agent is ranger.feature.test-node");

    const snapshot = await broker.getJson<{
      flights: Record<string, unknown>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(
      Object.values(snapshot.flights).some((flight) =>
        (flight as { invocationId?: string }).invocationId === "inv-ranger-stale"
      ),
    ).toBe(false);
  }, 15_000);

  test("reconciles queued flights that already target stale local endpoints", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
      },
    });
    const staleAt = Date.now() - 5_000;
    const startedAt = staleAt + 1_000;

    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "ranger.main.test-node",
      kind: "agent",
      definitionId: "ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      selector: "@ranger.main.node:test-node",
      defaultSelector: "@ranger",
      metadata: {
        source: "relay-agent-registry",
        projectRoot: "/tmp/ranger",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(firstHarness.baseUrl, "/v1/endpoints", {
      id: "endpoint-ranger-main",
      agentId: "ranger.main.test-node",
      nodeId: firstHarness.nodeId,
      harness: "claude",
      transport: "claude_stream_json",
      state: "offline",
      address: null,
      sessionId: "relay-ranger-claude",
      pane: null,
      cwd: "/tmp/ranger",
      projectRoot: "/tmp/ranger",
      metadata: {
        source: "relay-agent-registry",
        staleLocalRegistration: true,
        staleAt,
        replacedByAgentId: "ranger.feature.test-node",
        lastError: "superseded local agent registration replaced by current setup",
        lastFailedAt: staleAt,
      },
    });

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    appendFileSync(
      join(controlHome, "broker-journal.jsonl"),
      [
        JSON.stringify({
          kind: "invocation.record",
          invocation: {
            id: "inv-ranger-already-queued",
            requesterId: "operator",
            requesterNodeId: firstHarness.nodeId,
            targetAgentId: "ranger.main.test-node",
            action: "consult",
            task: "wake up",
            execution: {
              session: "existing",
              targetSessionId: "relay-ranger-claude",
            },
            ensureAwake: true,
            stream: false,
            createdAt: startedAt,
          },
        }),
        JSON.stringify({
          kind: "flight.record",
          flight: {
            id: "flt-ranger-already-queued",
            invocationId: "inv-ranger-already-queued",
            requesterId: "operator",
            targetAgentId: "ranger.main.test-node",
            state: "queued",
            summary: "Message stored for Ranger. Will deliver when online.",
            startedAt,
          },
        }),
      ].join("\n") + "\n",
    );

    const secondHarness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
      },
    });

    const snapshot = await broker.waitFor(
      () => broker.getJson<{
        flights: Record<string, { state: string; error?: string; metadata?: Record<string, unknown> }>;
      }>(secondHarness.baseUrl, "/v1/snapshot"),
      (value) => value.flights["flt-ranger-already-queued"]?.state === "failed",
    );
    const flight = snapshot.flights["flt-ranger-already-queued"];
    expect(flight?.error).toContain("superseded local registration replaced by current setup");
    expect(flight?.metadata).toMatchObject({ outcome: "dead", deathCause: "agent_retired" });
  }, 15_000);

  test("reconciles pending message deliveries that target stale local endpoints", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
      },
    });
    const staleAt = Date.now() - STALE_LOCAL_DELIVERY_GRACE_MS - 5_000;
    const messageCreatedAt = staleAt + 1_000;

    await broker.postJson(firstHarness.baseUrl, "/v1/actors", {
      id: "operator",
      kind: "person",
      displayName: "Operator",
      handle: "operator",
      labels: ["test"],
      metadata: { source: "test" },
    });
    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "ranger.main.test-node",
      kind: "agent",
      definitionId: "ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      selector: "@ranger.main.node:test-node",
      defaultSelector: "@ranger",
      metadata: {
        source: "relay-agent-registry",
        projectRoot: "/tmp/ranger",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(firstHarness.baseUrl, "/v1/endpoints", {
      id: "endpoint-ranger-main",
      agentId: "ranger.main.test-node",
      nodeId: firstHarness.nodeId,
      harness: "claude",
      transport: "claude_stream_json",
      state: "offline",
      address: null,
      sessionId: "relay-ranger-claude",
      pane: null,
      cwd: "/tmp/ranger",
      projectRoot: "/tmp/ranger",
      metadata: {
        source: "relay-agent-registry",
        staleLocalRegistration: true,
        staleAt,
        replacedByAgentId: "ranger.feature.test-node",
        lastError: "superseded local agent registration replaced by current setup",
        lastFailedAt: staleAt,
      },
    });
    await broker.postJson(firstHarness.baseUrl, "/v1/conversations", {
      id: "dm.operator.ranger.main.test-node",
      kind: "direct",
      title: "Ranger",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: firstHarness.nodeId,
      participantIds: ["operator", "ranger.main.test-node"],
      metadata: { surface: "test" },
    });

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    appendFileSync(
      join(controlHome, "broker-journal.jsonl"),
      [
        JSON.stringify({
          kind: "message.record",
          message: {
            id: "msg-ranger-stale-delivery",
            conversationId: "dm.operator.ranger.main.test-node",
            actorId: "operator",
            originNodeId: firstHarness.nodeId,
            class: "agent",
            body: "wake up",
            audience: {
              notify: ["ranger.main.test-node"],
              reason: "direct_message",
            },
            visibility: "private",
            policy: "durable",
            createdAt: messageCreatedAt,
          },
        }),
        JSON.stringify({
          kind: "deliveries.record",
          deliveries: [
            {
              id: "del-msg-ranger-stale-delivery-ranger.main.test-node-direct_message-claude_stream_json",
              messageId: "msg-ranger-stale-delivery",
              targetId: "ranger.main.test-node",
              targetNodeId: firstHarness.nodeId,
              targetKind: "agent",
              transport: "claude_stream_json",
              reason: "direct_message",
              policy: "durable",
              status: "pending",
            },
          ],
        }),
      ].join("\n") + "\n",
    );

    const secondHarness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
      },
    });

    const deliveries = await broker.waitFor(
      () => broker.getJson<Array<{ status: string; metadata?: Record<string, unknown> }>>(
        secondHarness.baseUrl,
        "/v1/deliveries?messageId=msg-ranger-stale-delivery&targetId=ranger.main.test-node",
      ),
      (value) => value[0]?.status === "failed",
    );
    expect(deliveries[0]?.metadata?.failureReason).toBe("agent_offline");
    expect(deliveries[0]?.metadata?.reconciledStaleDelivery).toBe(true);
    expect(deliveries[0]?.metadata?.reconciledReason).toContain("replacement agent is ranger.feature.test-node");
  }, 15_000);

  test("reconciles replayed active runtime-owned endpoints for the same invocation after restart", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });
    await broker.seedBasicConversation(firstHarness);

    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "arc",
      kind: "agent",
      definitionId: "arc",
      displayName: "Arc",
      handle: "arc",
      labels: ["test"],
      selector: "@arc",
      defaultSelector: "@arc",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });

    const startedAt = Date.now() - 60_000;
    await broker.postJson(firstHarness.baseUrl, "/v1/endpoints", {
      id: "endpoint-arc",
      agentId: "arc",
      nodeId: firstHarness.nodeId,
      harness: "claude",
      transport: "claude_stream_json",
      state: "active",
      address: null,
      sessionId: "relay-arc",
      pane: null,
      cwd: "/tmp/arc",
      projectRoot: "/tmp/arc",
      metadata: {
        source: "test",
        lastInvocationId: "inv-same-arc",
        lastStartedAt: startedAt + 1_000,
      },
    });

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    appendFileSync(
      join(controlHome, "broker-journal.jsonl"),
      [
        JSON.stringify({
          kind: "invocation.record",
          invocation: {
            id: "inv-same-arc",
            requesterId: "operator",
            requesterNodeId: firstHarness.nodeId,
            targetAgentId: "arc",
            action: "consult",
            task: "still there?",
            conversationId: "channel.shared",
            ensureAwake: true,
            stream: false,
            createdAt: startedAt,
          },
        }),
        JSON.stringify({
          kind: "flight.record",
          flight: {
            id: "flt-same-arc",
            invocationId: "inv-same-arc",
            requesterId: "operator",
            targetAgentId: "arc",
            state: "running",
            summary: "Arc is working.",
            startedAt,
            metadata: { dispatchAck: { endpointId: "endpoint-arc", nodeId: firstHarness.nodeId, harness: "claude", sessionId: "relay-arc" } },
          },
        }),
      ].join("\n") + "\n",
    );

    const secondHarness = await broker.startBroker({ controlHome });
    await broker.waitFor(async () => broker.getJson<{
      flights: Record<string, { state: string }>;
    }>(secondHarness.baseUrl, "/v1/snapshot"), (next) => Boolean(next.flights["flt-same-arc"]));
    const snapshot = await broker.waitFor(async () => broker.getJson<{
      flights: Record<string, { state: string; error?: string; completedAt?: number }>;
    }>(secondHarness.baseUrl, "/v1/snapshot"), (next) => next.flights["flt-same-arc"]?.state === "failed");

    // claude_stream_json runs as a child of the runtime, so it died with it.
    expect(snapshot.flights["flt-same-arc"]?.state).toBe("failed");
    expect(snapshot.flights["flt-same-arc"]?.error).toContain("without a live broker task");
    expect(typeof snapshot.flights["flt-same-arc"]?.completedAt).toBe("number");
  }, 15_000);

  test("a placeholder closed at boot leaves its finished twin current and the twin's result is delivered", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });
    await broker.seedBasicConversation(firstHarness);
    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    const startedAt = Date.now() - 20_000;
    const completedAt = startedAt + 5_000;
    const invocationId = "inv-twin-fabric";
    const resultReply = createInvocationResultReplyIntent(invocationId, {
      id: invocationResultMessageId(invocationId),
      conversationId: "channel.shared",
      actorId: "fabric",
      originNodeId: firstHarness.nodeId,
      class: "agent",
      body: "twin result",
      policy: "durable",
      visibility: "workspace",
      createdAt: completedAt,
      metadata: { flightId: "flt-twin" },
    } as never);
    const dispatchAck = { endpointId: "endpoint-fabric", nodeId: firstHarness.nodeId, harness: "claude", sessionId: "relay-fabric" };
    appendFileSync(
      join(controlHome, "broker-journal.jsonl"),
      [
        { kind: "invocation.record", invocation: {
          id: invocationId, requesterId: "operator", requesterNodeId: firstHarness.nodeId, targetAgentId: "fabric",
          action: "consult", task: "are you there?", conversationId: "channel.shared", ensureAwake: true, stream: false,
          createdAt: startedAt,
        } },
        // The placeholder: recorded first, never dispatched, still waking.
        { kind: "flight.record", flight: {
          id: "flt-placeholder", invocationId, requesterId: "operator", targetAgentId: "fabric", state: "waking",
          summary: "Fabric waking.", startedAt,
          metadata: { dispatchOutcome: { status: "not_submitted", checkedAt: startedAt } },
        } },
        // The twin did the work; its result reply has not been posted yet.
        { kind: "flight.record", flight: {
          id: "flt-twin", invocationId, requesterId: "operator", targetAgentId: "fabric", state: "completed",
          summary: "Fabric replied.", output: "twin result", startedAt: startedAt + 100, completedAt,
          metadata: { dispatchAck, resultReply },
        } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );

    const secondHarness = await broker.startBroker({ controlHome });
    const snapshot = await broker.waitFor(async () => broker.getJson<{
      flights: Record<string, { state: string; metadata?: Record<string, unknown> }>;
      messages: Record<string, { body: string }>;
    }>(secondHarness.baseUrl, "/v1/snapshot"), (next) => next.flights["flt-placeholder"]?.state === "completed"
      && (next.flights["flt-twin"]?.metadata?.resultReply as { status?: string } | undefined)?.status === "delivered",
    // Boot reconciliation waits for reply recovery; allow for a loaded host.
    { attempts: 200 });

    expect(snapshot.flights["flt-placeholder"]?.metadata?.supersededByFlightId).toBe("flt-twin");
    expect(snapshot.messages[invocationResultMessageId(invocationId)]?.body).toBe("twin result");
    const detail = await broker.getJson<{ flight: { id: string; metadata?: Record<string, unknown> } }>(
      secondHarness.baseUrl, `/v1/invocations/${invocationId}`);
    expect(detail.flight.id).toBe("flt-twin");
    expect(detail.flight.metadata?.dispatchAck).toEqual(dispatchAck);
  }, 40_000);

  test("an explicit-completion placeholder closes once behind its settled twin", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });
    await broker.seedBasicConversation(firstHarness);
    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    const startedAt = Date.now() - 20_000;
    const invocationId = "inv-twin-explicit";
    const completion = { version: 1, revision: 0, obligations: [] };
    appendFileSync(
      join(controlHome, "broker-journal.jsonl"),
      [
        { kind: "invocation.record", invocation: {
          id: invocationId, requesterId: "operator", requesterNodeId: firstHarness.nodeId, targetAgentId: "fabric",
          action: "consult", task: "are you there?", conversationId: "channel.shared", ensureAwake: true, stream: false,
          createdAt: startedAt, metadata: { completion: { mode: "explicit" } },
        } },
        { kind: "flight.record", flight: {
          id: "flt-explicit-placeholder", invocationId, requesterId: "operator", targetAgentId: "fabric", state: "waking",
          summary: "Fabric waking.", startedAt,
          metadata: { completion, dispatchOutcome: { status: "not_submitted", checkedAt: startedAt } },
        } },
        { kind: "flight.record", flight: {
          id: "flt-explicit-twin", invocationId, requesterId: "operator", targetAgentId: "fabric", state: "failed",
          summary: "Fabric failed.", error: "boom", startedAt: startedAt + 100, completedAt: startedAt + 5_000,
          metadata: { completion, dispatchAck: { endpointId: "endpoint-fabric", nodeId: firstHarness.nodeId } },
        } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );

    const secondHarness = await broker.startBroker({ controlHome });
    const snapshot = await broker.waitFor(async () => broker.getJson<{
      flights: Record<string, { state: string; error?: string; metadata?: Record<string, unknown> }>;
    }>(secondHarness.baseUrl, "/v1/snapshot"), (next) => next.flights["flt-explicit-placeholder"]?.state === "failed",
      { attempts: 200 });

    expect(snapshot.flights["flt-explicit-placeholder"]).toMatchObject({
      error: "boom", metadata: { supersededByFlightId: "flt-explicit-twin" },
    });
    const detail = await broker.getJson<{ flight: { id: string } }>(secondHarness.baseUrl, `/v1/invocations/${invocationId}`);
    expect(detail.flight.id).toBe("flt-explicit-twin");
  }, 40_000);

  test("a flight awaiting its task reply fails with its turn's output once its session is gone", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });
    await broker.seedBasicConversation(firstHarness);
    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    const startedAt = Date.now() - 10 * 60_000;
    const invocationId = "inv-awaiting-final";
    appendFileSync(
      join(controlHome, "broker-journal.jsonl"),
      [
        { kind: "invocation.record", invocation: {
          id: invocationId, requesterId: "operator", requesterNodeId: firstHarness.nodeId, targetAgentId: "fabric",
          action: "consult", task: "build the deck", conversationId: "channel.shared", ensureAwake: true, stream: false,
          createdAt: startedAt, metadata: { completion: { mode: "explicit" }, completionEndpointId: "endpoint-gone" },
        } },
        // The session ended its turn without the task reply, then went away.
        { kind: "flight.record", flight: {
          id: "flt-awaiting-final", invocationId, requesterId: "operator", targetAgentId: "fabric", state: "waiting",
          summary: "Execution ended; awaiting an explicit final reply.", startedAt,
          metadata: {
            completion: { version: 1, revision: 0, obligations: [], awaitingFinal: true },
            awaitingFinalSince: startedAt + 60_000, awaitingFinalOutput: "The deck is half built.",
            dispatchAck: { endpointId: "endpoint-gone", nodeId: firstHarness.nodeId },
          },
        } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );

    const secondHarness = await broker.startBroker({ controlHome });
    const snapshot = await broker.waitFor(async () => broker.getJson<{
      flights: Record<string, { state: string; error?: string; output?: string }>;
    }>(secondHarness.baseUrl, "/v1/snapshot"), (next) => next.flights["flt-awaiting-final"]?.state === "failed",
      { attempts: 200 });

    expect(snapshot.flights["flt-awaiting-final"]).toMatchObject({
      state: "failed", output: "The deck is half built.",
      error: expect.stringContaining("no task reply can arrive"),
    });
  }, 40_000);
});
