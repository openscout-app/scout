import { describe, expect, test } from "bun:test";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("ask follow-up handles", () => {
  test("an ask can be followed up through every receipt handle", async () => {
    const harness = await broker.startBroker();
    const scoutSessionId = "session-followup-handles";
    const relayAgentId = `${scoutSessionId}-relay`;
    const nativeId = "native-followup-handles";
    const workId = "work-followup-handles";
    const peer = broker.startHangingPeerServer();

    const agent = (id: string, handle: string) => ({
      id,
      kind: "agent",
      definitionId: id,
      displayName: handle,
      handle,
      labels: ["test"],
      selector: `@${handle}`,
      defaultSelector: `@${handle}`,
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/agents", agent(scoutSessionId, "followup"));
    await broker.postJson(harness.baseUrl, "/v1/agents", agent(relayAgentId, "followup-relay"));
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-followup-live",
      agentId: scoutSessionId,
      nodeId: harness.nodeId,
      harness: "claude",
      transport: "http",
      state: "idle",
      sessionId: scoutSessionId,
      address: `${peer}/a2a`,
      metadata: {
        source: "test",
        externalSessionId: nativeId,
        nativeSessionId: null,
        observedSessionId: nativeId,
      },
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-followup-relay",
      agentId: relayAgentId,
      nodeId: harness.nodeId,
      harness: "claude",
      transport: "http",
      state: "active",
      sessionId: scoutSessionId,
      address: `${peer}/a2a`,
      metadata: {
        source: "relay-agent-registry",
        tmuxSession: scoutSessionId,
        runtimeInstanceId: scoutSessionId,
        observedSessionId: nativeId,
      },
    });

    const asked = await broker.postJson<{
      kind: string;
      accepted: boolean;
      reason?: string;
      targetAgentId?: string;
      bindingRef?: string;
      workItem?: { id: string };
      flight?: { id: string; invocationId: string; targetAgentId: string; state: string };
    }>(harness.baseUrl, "/v1/deliver", {
      requestId: "ask-followup-origin",
      caller: { actorId: "operator", nodeId: harness.nodeId },
      target: { kind: "agent_id", agentId: scoutSessionId },
      intent: "task_ask",
      body: "Review the follow-up handles",
      task: { version: 1 },
      collaborationRecordId: workId,
      workItem: {
        id: workId,
        title: "Review the follow-up handles",
        acceptanceState: "pending",
      },
    });

    expect(asked.kind).toBe("delivery");
    expect(asked.accepted).toBe(true);
    expect(asked.targetAgentId).toBe(scoutSessionId);
    expect(asked.flight?.invocationId).toBeTruthy();
    expect(asked.bindingRef).toBe(asked.flight!.id.slice(-8));
    expect(asked.workItem?.id).toBe(workId);
    const invocationId = asked.flight!.invocationId;

    const stored = await broker.getJson<{
      endpoints: Record<string, { metadata?: { externalSessionId?: string } }>;
    }>(harness.baseUrl, "/v1/snapshot");
    const storedNative = stored.endpoints["endpoint-followup-live"]?.metadata?.externalSessionId;
    expect(storedNative).toBe(nativeId);

    const handles = [
      ["binding ref", asked.bindingRef!],
      ["work id", workId],
      ["flight id", asked.flight!.id],
      ["scout session", scoutSessionId],
      ["native session", `session:claude:${storedNative}`],
    ] as const;
    for (const [name, ref] of handles) {
      const followup = await broker.postJson<{
        kind: string;
        accepted: boolean;
        targetAgentId?: string;
        flight?: { invocationId: string };
        message?: { metadata?: { taskFollowup?: { invocationId?: string } } };
      }>(harness.baseUrl, "/v1/deliver", {
        requestId: `ask-followup-${name.replaceAll(" ", "-")}`,
        caller: { actorId: "operator", nodeId: harness.nodeId },
        target: { kind: "binding_ref", ref },
        targetLabel: `ref:${ref}`,
        intent: "task_ask",
        body: `Follow up through the ${name}`,
        task: { version: 1, ref },
      });
      expect(followup.kind, name).toBe("delivery");
      expect(followup.accepted, name).toBe(true);
      expect(followup.flight?.invocationId, name).toBe(invocationId);
      expect(followup.message?.metadata?.taskFollowup?.invocationId, name).toBe(invocationId);
      expect(followup.targetAgentId, name).toBe(scoutSessionId);
    }

    const afterRefs = await broker.getJson<{ invocations: Record<string, { id: string }> }>(harness.baseUrl, "/v1/snapshot");
    expect(Object.keys(afterRefs.invocations)).toEqual([invocationId]);

    const continued = await broker.postJson<{
      kind: string;
      accepted: boolean;
      reason?: string;
      targetAgentId?: string;
      rejection?: { detail?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      requestId: "ask-followup-session-route",
      caller: { actorId: "operator", nodeId: harness.nodeId },
      target: { kind: "session_id", sessionId: scoutSessionId, value: `session:${scoutSessionId}` },
      targetSessionId: scoutSessionId,
      targetLabel: `session:${scoutSessionId}`,
      intent: "task_ask",
      body: "Continue the scout session",
      task: { version: 1 },
      execution: { session: "existing", targetSessionId: scoutSessionId },
    });
    expect(continued.reason).toBeUndefined();
    expect(continued.rejection?.detail ?? "").not.toContain("ambiguous");
    expect(continued.kind).toBe("delivery");
    expect(continued.accepted).toBe(true);
    expect(continued.targetAgentId).toBe(scoutSessionId);

    const nativeRoute = await broker.postJson<{
      kind: string;
      accepted: boolean;
      reason?: string;
      targetAgentId?: string;
      rejection?: { detail?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      requestId: "ask-followup-native-route",
      caller: { actorId: "operator", nodeId: harness.nodeId },
      target: {
        kind: "session_id",
        sessionId: nativeId,
        harness: "claude",
        value: `session:claude:${nativeId}`,
      },
      targetSessionId: nativeId,
      targetLabel: `session:claude:${nativeId}`,
      intent: "task_ask",
      body: "Continue the native session",
      task: { version: 1 },
      execution: { session: "existing", harness: "claude", targetSessionId: nativeId },
    });
    expect(nativeRoute.reason).toBeUndefined();
    expect(nativeRoute.rejection?.detail ?? "").not.toContain("ambiguous");
    expect(nativeRoute.kind).toBe("delivery");
    expect(nativeRoute.accepted).toBe(true);
    expect(nativeRoute.targetAgentId).toBe(scoutSessionId);
  }, 30_000);
});
