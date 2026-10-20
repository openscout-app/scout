import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon invocation dispatch", () => {
  test("reports unavailable for a card with no receiver or verified launcher", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ghost",
      kind: "agent",
      definitionId: "ghost",
      displayName: "Ghost",
      handle: "ghost",
      labels: ["test"],
      selector: "@ghost",
      defaultSelector: "@ghost",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.postJson<{
      accepted: boolean;
      dispatch?: { kind: string; target?: { agentId?: string } };
      invocationId: string;
      flightId: string;
      targetAgentId: string;
      state: string;
      flight: { id: string; state: string; targetAgentId: string };
    }>(harness.baseUrl, "/v1/invocations", {
      id: "inv-test-1",
      requesterId: "operator",
      requesterNodeId: harness.nodeId,
      targetAgentId: "ghost",
      action: "consult",
      task: "How is the build going?",
      conversationId: "channel.shared",
      context: { source: "test" },
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
      metadata: { source: "test" },
    });

    expect(response.accepted).toBe(true); // The routing decision itself is recorded.
    expect(response.flightId).toBeUndefined();
    expect(response.dispatch).toMatchObject({ kind: "unavailable", target: { agentId: "ghost" } });
    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(harness.baseUrl, "/v1/snapshot");
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("drains queued local invocations when the endpoint comes online", async () => {
    const pairing = broker.startPairingBridgeServer({
      sessions: [
        {
          id: "session-sleepy-1",
          name: "Sleepy",
          adapterType: "codex",
          status: "idle",
          cwd: "/tmp/sleepy",
        },
      ],
    });
    const home = broker.configurePairingHome(pairing.port);
    const harness = await broker.startBroker({
      env: {
        HOME: home,
      },
    });
    await broker.seedBasicConversation(harness);

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "sleepy",
      kind: "agent",
      definitionId: "sleepy",
      displayName: "Sleepy",
      handle: "sleepy",
      labels: ["test"],
      selector: "@sleepy",
      defaultSelector: "@sleepy",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.seedQueuedInvocation(harness, {
      id: "inv-sleepy-queued",
      requesterId: "operator",
      requesterNodeId: harness.nodeId,
      targetAgentId: "sleepy",
      action: "consult",
      task: "Wake and reply.",
      conversationId: "channel.shared",
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
      metadata: { source: "test" },
    });

    expect(response.accepted).toBe(true);
    await broker.waitFor(
      () => broker.getJson<{
        flights: Record<string, { state: string }>;
      }>(harness.baseUrl, "/v1/snapshot"),
      (snapshot) => snapshot.flights[response.flightId]?.state === "queued",
    );

    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-sleepy-pairing",
      agentId: "sleepy",
      nodeId: harness.nodeId,
      harness: "codex",
      transport: "pairing_bridge",
      state: "idle",
      sessionId: "session-sleepy-1",
      metadata: { source: "test", agentName: "Sleepy" },
    });

    const drained = await broker.waitFor(
      () => broker.getJson<{
        flights: Record<string, { state: string; summary?: string; metadata?: Record<string, unknown> }>;
      }>(harness.baseUrl, "/v1/snapshot"),
      (snapshot) => {
        const flight = snapshot.flights[response.flightId];
        const dispatchAck = flight?.metadata?.dispatchAck as { endpointId?: string } | undefined;
        return Boolean(
          flight
          && flight.state === "completed"
          && dispatchAck?.endpointId === "endpoint-sleepy-pairing",
        );
      },
    );
    const flight = drained.flights[response.flightId];

    expect(flight?.state).toBe("completed");
    expect(flight?.summary).not.toBe("Message stored for Sleepy. Will deliver when online.");
    expect(flight?.metadata?.dispatchAck).toEqual(expect.objectContaining({
      endpointId: "endpoint-sleepy-pairing",
      transport: "pairing_bridge",
    }));
  }, 15_000);

  test("dispatches to an active broker-only tmux endpoint instead of queueing until online", async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "openscout-fake-tmux-"));
    broker.temporaryDirectories.add(fakeBin);
    const tmuxLogPath = broker.writeFakeTmuxBin(fakeBin);
    const sessionId = "relay-card-active-claude";
    const preload = join(fakeBin, "prime-tmux.ts");
    writeFileSync(preload, `import { readTmuxSessionExists } from ${JSON.stringify(join(import.meta.dir, "system-probes/index.ts"))}; await readTmuxSessionExists(${JSON.stringify(sessionId)});`);
    const harness = await broker.startBroker({
      preload,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        OPENSCOUT_FAKE_TMUX_LOG: tmuxLogPath,
        OPENSCOUT_FAKE_TMUX_SESSION: sessionId,
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
      },
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "card-active",
      kind: "agent",
      definitionId: "card-active",
      displayName: "Card Active",
      handle: "card-active",
      labels: ["relay", "project", "agent", "local-agent"],
      selector: "@card-active",
      defaultSelector: "@card-active",
      metadata: {
        source: "relay-agent-registry",
        project: "Card",
        projectRoot: "/tmp/card",
        tmuxSession: sessionId,
        cardLifecycle: {
          kind: "one_time",
          createdAt: Date.now(),
          createdById: "operator",
          expiresAt: Date.now() + 60_000,
          maxUses: 1,
        },
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-card-active-tmux",
      agentId: "card-active",
      nodeId: harness.nodeId,
      harness: "claude",
      transport: "tmux",
      state: "active",
      sessionId,
      cwd: "/tmp/card",
      projectRoot: "/tmp/card",
      metadata: {
        source: "relay-agent-registry",
        tmuxSession: sessionId,
        runtimeInstanceId: sessionId,
        lastStartedAt: Date.now(),
      },
    });

    const response = await broker.postJson<{
      accepted: boolean;
      flightId: string;
      state: string;
    }>(harness.baseUrl, "/v1/invocations", {
      id: "inv-card-active",
      requesterId: "operator",
      requesterNodeId: harness.nodeId,
      targetAgentId: "card-active",
      action: "wake",
      task: "Ping active card.",
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
      metadata: { source: "test" },
    });

    expect(response.accepted).toBe(true);

    const snapshot = await broker.waitFor(
      () => broker.getJson<{
        flights: Record<string, { state: string; summary?: string; metadata?: Record<string, unknown> }>;
      }>(harness.baseUrl, "/v1/snapshot"),
      (value) => value.flights[response.flightId]?.state === "completed",
    );
    const flight = snapshot.flights[response.flightId];

    expect(flight?.summary).toBe("Card Active received the message.");
    expect(flight?.metadata?.dispatchAck).toEqual(expect.objectContaining({
      endpointId: "endpoint-card-active-tmux",
      transport: "tmux",
      sessionId,
    }));
    expect(readFileSync(tmuxLogPath, "utf8")).toContain("send-keys");
  }, 15_000);

  test("keeps replayed invocations available to daemon routes after restart", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });
    await broker.seedBasicConversation(firstHarness);

    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "ghost",
      kind: "agent",
      definitionId: "ghost",
      displayName: "Ghost",
      handle: "ghost",
      labels: ["test"],
      selector: "@ghost",
      defaultSelector: "@ghost",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });

    await broker.seedQueuedInvocation(firstHarness, {
      id: "inv-restart-1",
      requesterId: "operator",
      requesterNodeId: firstHarness.nodeId,
      targetAgentId: "ghost",
      action: "consult",
      task: "survive restart?",
      conversationId: "channel.shared",
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
      metadata: { source: "test" },
    });

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    const secondHarness = await broker.startBroker({ controlHome });
    const snapshot = await broker.getJson<{
      invocation: { id: string; targetAgentId: string } | null;
      flight: {
        id: string;
        invocationId: string;
        targetAgentId: string;
        state: string;
        metadata?: {
          dispatchOutcome?: {
            status?: string;
            reason?: string;
          };
        };
      } | null;
    }>(secondHarness.baseUrl, "/v1/invocations/inv-restart-1");

    expect(snapshot.invocation).toEqual(expect.objectContaining({
      id: "inv-restart-1",
      targetAgentId: "ghost",
    }));
    expect(snapshot.flight).toEqual(expect.objectContaining({
      invocationId: "inv-restart-1",
      targetAgentId: "ghost",
    }));
    expect(["waking", "queued"]).toContain(snapshot.flight?.state);
    if (snapshot.flight?.state === "queued") {
      expect(snapshot.flight.metadata?.dispatchOutcome).toEqual(expect.objectContaining({
        status: "queued_until_online",
        reason: "no_runnable_endpoint",
      }));
    }

    const lifecycle = await broker.getJson<{
      invocationId: string;
      flightId: string;
      state: string;
      targetAgentId: string;
    }>(secondHarness.baseUrl, "/v1/invocations/inv-restart-1/lifecycle");

    expect(lifecycle).toEqual(expect.objectContaining({
      invocationId: "inv-restart-1",
      targetAgentId: "ghost",
    }));
    // /lifecycle now returns the raw flight state (the projected "dispatching"
    // vocabulary was removed in ask-overbuild Phase 2), matching snapshot.flight.state.
    expect(["waking", "queued"]).toContain(lifecycle.state);
    expect(lifecycle.flightId).toBe(snapshot.flight?.id);
  }, 20_000);

  test("reconciles a dispatched invocation after its executor is lost on restart", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });
    await broker.seedBasicConversation(firstHarness);

    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "ghost",
      kind: "agent",
      definitionId: "ghost",
      displayName: "Ghost",
      handle: "ghost",
      labels: ["test"],
      selector: "@ghost",
      defaultSelector: "@ghost",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });

    await broker.seedHangingReceiver(firstHarness, "ghost");

    await broker.postJson(firstHarness.baseUrl, "/v1/invocations", {
      id: "inv-restart-1",
      requesterId: "operator",
      requesterNodeId: firstHarness.nodeId,
      targetAgentId: "ghost",
      action: "consult",
      task: "survive restart?",
      conversationId: "channel.shared",
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
      metadata: { source: "test" },
    });

    await broker.waitFor(
      () => broker.getJson<{ flight: { state: string } }>(firstHarness.baseUrl, "/v1/invocations/inv-restart-1"),
      snapshot => snapshot.flight?.state === "running",
    );

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    const secondHarness = await broker.startBroker({ controlHome });
    const snapshot = await broker.waitFor(() => broker.getJson<{
      invocation: { id: string; targetAgentId: string } | null;
      flight: {
        id: string;
        invocationId: string;
        targetAgentId: string;
        state: string;
        metadata?: {
          dispatchOutcome?: {
            status?: string;
            reason?: string;
          };
        };
      } | null;
    }>(secondHarness.baseUrl, "/v1/invocations/inv-restart-1"), snapshot => snapshot.flight?.state === "failed");

    expect(snapshot.invocation).toEqual(expect.objectContaining({
      id: "inv-restart-1",
      targetAgentId: "ghost",
    }));
    expect(snapshot.flight).toEqual(expect.objectContaining({
      invocationId: "inv-restart-1",
      targetAgentId: "ghost",
    }));
    expect(snapshot.flight?.state).toBe("failed");

    const lifecycle = await broker.getJson<{
      invocationId: string;
      flightId: string;
      state: string;
      targetAgentId: string;
    }>(secondHarness.baseUrl, "/v1/invocations/inv-restart-1/lifecycle");

    expect(lifecycle).toEqual(expect.objectContaining({
      invocationId: "inv-restart-1",
      targetAgentId: "ghost",
    }));
    // /lifecycle now returns the raw flight state (the projected "dispatching"
    // vocabulary was removed in ask-overbuild Phase 2), matching snapshot.flight.state.
    expect(lifecycle.state).toBe("failed");
    expect(lifecycle.flightId).toBe(snapshot.flight?.id);
  }, 20_000);

  test("routes exact session asks to the session owner and preserves existing-session execution", async () => {
    const pairing = broker.startPairingBridgeServer({ sessions: [{ id: "codex-thread-reviewer", name: "Reviewer", adapterType: "codex", status: "active" }] });
    const harness = await broker.startBroker({ env: { HOME: broker.configurePairingHome(pairing.port) } });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "reviewer.main",
      kind: "agent",
      definitionId: "reviewer",
      displayName: "Reviewer",
      handle: "reviewer",
      labels: ["test"],
      selector: "@reviewer",
      defaultSelector: "@reviewer",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-reviewer-main",
      agentId: "reviewer.main",
      nodeId: harness.nodeId,
      harness: "codex",
      transport: "pairing_bridge",
      state: "active",
      sessionId: "codex-thread-reviewer",
      metadata: {
        externalSessionId: "codex-thread-reviewer",
        threadId: "codex-thread-reviewer",
        runtimeInstanceId: "relay-reviewer-codex",
      },
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      targetSessionId?: string;
      receipt?: {
        targetAgentId?: string;
        targetSessionId?: string;
        flightId?: string;
      };
      message?: {
        metadata?: {
          targetSessionId?: string;
        };
      };
      flight?: {
        id: string;
        targetAgentId: string;
        metadata?: Record<string, unknown>;
      };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-session-target",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "session_id",
        sessionId: "codex-thread-reviewer",
      },
      body: "continue the review in the same context",
      intent: "consult",
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toBe("reviewer.main");
    expect(response.targetSessionId).toBe("codex-thread-reviewer");
    expect(response.receipt?.targetAgentId).toBe("reviewer.main");
    expect(response.receipt?.targetSessionId).toBe("codex-thread-reviewer");
    expect(response.message?.metadata?.targetSessionId).toBe("codex-thread-reviewer");

    const snapshot = await broker.getJson<{
      invocations: Record<string, {
        execution?: { session?: string; targetSessionId?: string };
        metadata?: Record<string, unknown>;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");
    const invocation = Object.values(snapshot.invocations).find(
      (value) => value.metadata?.targetSessionId === "codex-thread-reviewer",
    );
    expect(invocation?.execution).toMatchObject({
      session: "existing",
      targetSessionId: "codex-thread-reviewer",
    });
  }, 15_000);

  test("collapses broker projections for one exact native session", async () => {
    const sessionId = "session-msmj8lfe-plfxbs";
    const pairing = broker.startPairingBridgeServer({ sessions: [{ id: sessionId, name: "Reviewer", adapterType: "claude", status: "active" }] });
    const harness = await broker.startBroker({ env: { HOME: broker.configurePairingHome(pairing.port) } });
    const projections = [
      { id: "reviewer.main", state: "idle" },
      { id: "reviewer.review-a.node-1", state: "idle" },
      { id: "reviewer.review-b.node-2", state: "active" },
      { id: "reviewer.review-c.node-3", state: "idle" },
    ] as const;

    for (const projection of projections) {
      await broker.postJson(harness.baseUrl, "/v1/agents", {
        id: projection.id,
        kind: "agent",
        definitionId: "reviewer",
        displayName: projection.id,
        handle: projection.id,
        labels: ["test"],
        selector: `@${projection.id}`,
        defaultSelector: `@${projection.id}`,
        metadata: { source: "test" },
        agentClass: "general",
        capabilities: ["chat", "invoke"],
        wakePolicy: "on_demand",
        homeNodeId: harness.nodeId,
        authorityNodeId: harness.nodeId,
        advertiseScope: "local",
      });
      await broker.postJson(harness.baseUrl, "/v1/endpoints", {
        id: `endpoint-${projection.id}`,
        agentId: projection.id,
        nodeId: harness.nodeId,
        harness: "claude",
        transport: "pairing_bridge",
        state: projection.state,
        sessionId,
        metadata: {
          externalSessionId: sessionId,
          nativeSessionId: sessionId,
          lastStartedAt: projection.state === "active" ? 4_000 : 1_000,
        },
      });
    }

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      targetSessionId?: string;
      receipt?: { targetAgentId?: string; targetSessionId?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-projected-session-target",
      caller: { actorId: "operator", nodeId: harness.nodeId },
      target: { kind: "session_id", sessionId },
      body: "continue this exact session",
      intent: "tell",
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
      targetAgentId: "reviewer.review-b.node-2",
      targetSessionId: sessionId,
      receipt: expect.objectContaining({
        targetAgentId: "reviewer.review-b.node-2",
        targetSessionId: sessionId,
      }),
    }));
  }, 15_000);
});
