import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon core routes", () => {
  test("reports build identity and cheap child service states on health", async () => {
    const harness = await broker.startBroker({
      env: {
        OPENSCOUT_BUILD_COMMIT: "abc123",
        OPENSCOUT_BUILD_BRANCH: "lane-c",
        OPENSCOUT_BUILD_ID: "build-health-test",
        OPENSCOUT_BUILD_NUMBER: "42",
      },
    });

    const health = await broker.getJson<{
      ok: boolean;
      build?: {
        packageName?: string;
        version?: string | null;
        commit?: string | null;
        branch?: string | null;
        buildId?: string | null;
        buildNumber?: string | null;
      };
      services?: {
        web?: { managedBy?: string; state?: string; pid?: number | null; healthy?: boolean | null };
        terminalRelay?: { managedBy?: string; state?: string; healthy?: boolean | null };
        localEdge?: { managedBy?: string; state?: string; healthy?: boolean | null };
      };
      projection?: { state?: string; detail?: string | null; worker?: { pendingRequests: number; dirty: boolean; replay: { bytes: number; fullReplays: number; tailReplays: number } } };
      counts?: { collaborationRecords?: number };
    }>(harness.baseUrl, "/health");

    expect(health.ok).toBe(true);
    expect(health.build).toEqual(expect.objectContaining({
      packageName: "@openscout/runtime",
      commit: "abc123",
      branch: "lane-c",
      buildId: "build-health-test",
      buildNumber: "42",
    }));
    expect(health.build?.version).toBeTruthy();
    expect(health.services?.web).toEqual(expect.objectContaining({
      managedBy: "broker",
      state: "stopped",
      pid: null,
      healthy: null,
    }));
    expect(health.services?.terminalRelay).toEqual(expect.objectContaining({
      managedBy: "web",
      state: "unknown",
      healthy: null,
    }));
    expect(health.services?.localEdge).toEqual(expect.objectContaining({
      managedBy: "base",
      state: "unknown",
      healthy: null,
    }));
    expect(health.projection).toEqual(expect.objectContaining({ state: "ready", detail: null }));
    expect(health.projection?.worker?.dirty).toEqual(expect.any(Boolean));
    expect(health.projection?.worker?.pendingRequests).toBeGreaterThanOrEqual(0);
    expect(health.projection?.worker?.replay.bytes).toBeGreaterThanOrEqual(0);
    expect(health.projection?.worker?.replay.fullReplays).toBeGreaterThanOrEqual(1);
    expect(health.counts?.collaborationRecords).toBe(0);
  });

  test("upserts endpoints through the canonical broker route", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "route-agent",
      kind: "agent",
      definitionId: "route-agent",
      displayName: "Route Agent",
      handle: "route-agent",
      labels: ["test"],
      selector: "@route-agent",
      defaultSelector: "@route-agent",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.postJson<{
      ok: boolean;
      endpointId?: string;
      endpoint?: unknown;
    }>(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-route-agent-http",
      agentId: "route-agent",
      nodeId: harness.nodeId,
      harness: "http",
      transport: "http",
      state: "active",
      address: "http://127.0.0.1:43110/a2a",
      metadata: { source: "test" },
    });

    expect(response).toEqual({
      ok: true,
      endpointId: "endpoint-route-agent-http",
    });
    expect(response.endpoint).toBeUndefined();

    const snapshot = await broker.getJson<{
      endpoints: Record<string, { agentId: string; nodeId: string; transport: string; state: string }>;
    }>(harness.baseUrl, "/v1/snapshot");

    expect(snapshot.endpoints["endpoint-route-agent-http"]).toEqual(expect.objectContaining({
      agentId: "route-agent",
      nodeId: harness.nodeId,
      transport: "http",
      state: "active",
    }));
  });

  test("keeps invocation snapshot lifecycle and stream routes distinct", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);
    await broker.seedHangingReceiver(harness, "fabric");

    const created = await broker.postJson<{
      accepted: boolean;
      invocationId: string;
      flightId: string;
      targetAgentId: string;
    }>(harness.baseUrl, "/v1/invocations", {
      id: "inv-route-read-1",
      requesterId: "operator",
      requesterNodeId: harness.nodeId,
      targetAgentId: "fabric",
      action: "consult",
      task: "Route read check.",
      conversationId: "channel.shared",
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
      metadata: { source: "test" },
    });

    expect(created.accepted).toBe(true);
    expect(created.targetAgentId).toBe("fabric");

    const snapshot = await broker.getJson<{
      invocationId: string;
      invocation: { id: string; targetAgentId: string } | null;
      flight: { id: string; invocationId: string; targetAgentId: string; state: string } | null;
      deliveries: unknown[];
      dispatches: unknown[];
    }>(harness.baseUrl, "/v1/invocations/inv-route-read-1");

    expect(snapshot.invocationId).toBe("inv-route-read-1");
    expect(snapshot.invocation).toEqual(expect.objectContaining({
      id: "inv-route-read-1",
      targetAgentId: "fabric",
    }));
    expect(snapshot.flight).toEqual(expect.objectContaining({
      id: created.flightId,
      invocationId: "inv-route-read-1",
      targetAgentId: "fabric",
    }));
    expect(snapshot.deliveries).toEqual([]);
    expect(snapshot.dispatches).toEqual([]);

    const lifecycle = await broker.getJson<{
      invocationId: string;
      flightId: string;
      targetAgentId: string;
      state: string;
    }>(harness.baseUrl, "/v1/invocations/inv-route-read-1/lifecycle");

    expect(lifecycle).toEqual(expect.objectContaining({
      invocationId: "inv-route-read-1",
      flightId: created.flightId,
      targetAgentId: "fabric",
    }));

    const streamed = await broker.readInvocationStreamSnapshot(harness.baseUrl, "inv-route-read-1");

    expect(streamed.invocationId).toBe("inv-route-read-1");
    expect(streamed.invocation).toEqual(expect.objectContaining({
      id: "inv-route-read-1",
      targetAgentId: "fabric",
    }));
    expect(streamed.flight).toEqual(expect.objectContaining({
      id: created.flightId,
      invocationId: "inv-route-read-1",
      targetAgentId: "fabric",
    }));
  }, 15_000);

  test("serves capability snapshots from the broker read endpoint", async () => {
    const harness = await broker.startBroker();

    const snapshot = await broker.getJson<{
      generatedAt: number;
      scope?: { machineId?: string };
      sources: Array<{ kind: string; id: string }>;
      capabilities: unknown[];
      harnessSupport?: Record<string, unknown>;
      warnings: string[];
    }>(harness.baseUrl, "/v1/capabilities");

    expect(snapshot.generatedAt).toBeGreaterThan(0);
    expect(snapshot.scope?.machineId).toBe(harness.nodeId);
    expect(snapshot.sources.some((source) => source.kind === "harness_adapter")).toBe(true);
    expect(snapshot.sources.some((source) => source.kind === "runtime_probe")).toBe(true);
    expect(snapshot.harnessSupport?.codex).toBeTruthy();
    expect(snapshot.capabilities).toEqual([]);
    expect(snapshot.warnings).toEqual([]);

    const cached = await broker.getJson<{ generatedAt: number }>(harness.baseUrl, "/v1/capabilities");
    expect(cached.generatedAt).toBe(snapshot.generatedAt);

    const availability = await broker.getJson<{
      decision: string;
      reason: string;
      capabilityId?: string;
    }>(
      harness.baseUrl,
      "/v1/capabilities/availability?capabilityId=cap%3Amissing&methodName=call&requireReady=1",
    );
    expect(availability).toEqual(expect.objectContaining({
      decision: "deny",
      capabilityId: "cap:missing",
      reason: "capability_missing",
    }));

    const missingId = await broker.requestJson(harness.baseUrl, "/v1/capabilities/availability");
    expect(missingId.status).toBe(400);
  });

  test("projects local model catalog entries into capability snapshots", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-model-catalog-"));
    const harness = await broker.startBroker({ controlHome });
    const catalogDirectory = join(harness.controlHome, "support", "catalog");
    mkdirSync(catalogDirectory, { recursive: true });
    writeFileSync(
      join(catalogDirectory, "model-catalog.json"),
      `${JSON.stringify({
        id: "local-models",
        name: "Local Models",
        models: [{
          providerId: "local",
          modelId: "scout-small",
          displayName: "Scout Small",
          features: { streaming: true, toolCalling: true },
        }],
      })}\n`,
      "utf8",
    );

    const snapshot = await broker.getJson<{
      sources: Array<{ kind: string; id: string }>;
      capabilities: Array<{ id: string; provider: string; displayName: string }>;
    }>(harness.baseUrl, "/v1/capabilities?force=1");

    expect(snapshot.sources).toContainEqual(expect.objectContaining({
      kind: "model_catalog",
      id: "local-models",
    }));
    expect(snapshot.capabilities).toContainEqual(expect.objectContaining({
      id: "cap:model:local:scout-small",
      provider: "model",
      displayName: "Scout Small",
    }));
  });

  test("projects configured MCP server catalog entries into capability snapshots", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-mcp-catalog-"));
    const harness = await broker.startBroker({ controlHome });
    const catalogDirectory = join(harness.controlHome, "support", "catalog");
    mkdirSync(catalogDirectory, { recursive: true });
    writeFileSync(
      join(catalogDirectory, "mcp-servers.json"),
      `${JSON.stringify({
        servers: [{
          id: "disabled-tools",
          name: "Disabled Tools",
          command: "node",
          disabled: true,
        }],
      })}\n`,
      "utf8",
    );

    const snapshot = await broker.getJson<{
      sources: Array<{ kind: string; id: string; raw?: { target?: string; state?: string } }>;
      warnings: string[];
    }>(harness.baseUrl, "/v1/capabilities?force=1");

    expect(snapshot.sources).toContainEqual(expect.objectContaining({
      kind: "runtime_probe",
      id: "mcp:disabled-tools",
      raw: expect.objectContaining({
        target: "mcp_server",
        state: "disabled",
      }),
    }));
    expect(snapshot.warnings).toEqual([]);
  });

  test("serves A2A cards and routes JSON-RPC tasks through Scout invocations", async () => {
    const harness = await broker.startBroker();
    const endpointUrl = broker.startA2AResponder((body) => {
      const params = body.params as { message?: { parts?: Array<{ text?: string }> } } | undefined;
      const text = params?.message?.parts?.[0]?.text ?? "";
      return {
        result: {
          task: {
            id: "external-task-1",
            contextId: "external-context-1",
            status: { state: "TASK_STATE_COMPLETED" },
            artifacts: [
              {
                artifactId: "external-output",
                parts: [{ text: `external reply: ${text}` }],
              },
            ],
          },
        },
      };
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "fabric.a2a",
      kind: "agent",
      definitionId: "fabric",
      displayName: "Fabric A2A",
      handle: "fabric-a2a",
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
      metadata: {
        brokerRegistered: true,
        description: "A test A2A-backed agent.",
        skills: [
          {
            id: "echo",
            name: "Echo",
            description: "Echoes a text task.",
          },
        ],
      },
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint.fabric.a2a",
      agentId: "fabric.a2a",
      nodeId: harness.nodeId,
      harness: "http",
      transport: "http",
      state: "active",
      address: endpointUrl,
      projectRoot: "/tmp/fabric-a2a",
      cwd: "/tmp/fabric-a2a",
      metadata: {
        a2aExecutionUrl: endpointUrl,
        a2aProtocolVersion: "1.0",
      },
    });

    const card = await broker.getJson<{
      protocolVersion: string;
      supportedInterfaces?: Array<{ tenant?: string; url?: string; protocolBinding?: string }>;
      skills?: Array<{ id?: string }>;
    }>(harness.baseUrl, "/v1/a2a/agents/fabric.a2a/agent-card.json");

    expect(card.protocolVersion).toBe("1.0");
    expect(card.supportedInterfaces?.[0]).toMatchObject({
      tenant: "fabric.a2a",
      protocolBinding: "JSONRPC",
    });
    expect(card.skills?.[0]?.id).toBe("echo");

    const brokerCard = await broker.getJson<{
      name: string;
      metadata?: { scoutAgentIds?: string[] };
    }>(harness.baseUrl, "/.well-known/agent-card.json");
    expect(brokerCard.name).toBe("OpenScout Broker");
    expect(brokerCard.metadata?.scoutAgentIds).toContain("fabric.a2a");

    const send = await broker.postJson<{
      jsonrpc: "2.0";
      id: string;
      result?: {
        task?: {
          id: string;
          status: { state: string };
          artifacts?: Array<{ parts?: Array<{ text?: string }> }>;
        };
      };
      error?: { message: string };
    }>(harness.baseUrl, "/v1/a2a/agents/fabric.a2a/rpc", {
      jsonrpc: "2.0",
      id: "send-1",
      method: "SendMessage",
      params: {
        message: {
          role: "ROLE_USER",
          messageId: "a2a-msg-1",
          parts: [{ text: "hello from a2a" }],
        },
        configuration: {
          blocking: true,
        },
      },
    });

    expect(send.error).toBeUndefined();
    expect(send.result?.task?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(send.result?.task?.artifacts?.[0]?.parts?.[0]?.text).toBe("external reply: hello from a2a");

    const taskId = send.result?.task?.id;
    expect(taskId).toBeTruthy();

    const getTask = await broker.postJson<{
      result?: { id: string; status: { state: string } };
    }>(harness.baseUrl, "/v1/a2a/agents/fabric.a2a/rpc", {
      jsonrpc: "2.0",
      id: "get-1",
      method: "GetTask",
      params: { id: taskId },
    });
    expect(getTask.result?.id).toBe(taskId);
    expect(getTask.result?.status.state).toBe("TASK_STATE_COMPLETED");

    const list = await broker.postJson<{
      result?: { tasks: Array<{ id: string }>; totalSize?: number };
    }>(harness.baseUrl, "/v1/a2a/agents/fabric.a2a/rpc", {
      jsonrpc: "2.0",
      id: "list-1",
      method: "ListTasks",
      params: { pageSize: 10 },
    });
    expect(list.result?.tasks.some((task) => task.id === taskId)).toBe(true);
  }, 15_000);
});
