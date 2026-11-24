import { describe, expect, test } from "bun:test";
import type { ScoutBrokerFlightRecord, ScoutBrokerMessageRecord, ScoutBrokerSnapshot } from "../core/broker/service.ts";
import {
  admitScoutbotTurn,
  scoutbotThreadHasPendingTurn,
  buildScoutbotInvocation,
  hasCurrentScoutbotAgentRegistration,
  isScoutbotAddressedMessage,
  isScoutbotDirectDeliveryFlight,
} from "./runner.ts";
import {
  SCOUTBOT_ROLE_CONFIG,
  scoutbotCodexLaunchArgs,
} from "@openscout/runtime/scoutbot-role";

describe("scoutbot runner routing", () => {
  test("preserves contextual mentions and removes only a leading assistant routing address", () => {
    const thread = { threadId: "thr-context", conversationId: "c.context", name: "Context", transport: "codex_app_server", transportSessionId: null, pins: null, lastActiveAt: 1, model: "gpt-6-astra" };
    const payload = "Ask @agent-name about @session:abc @project:/workspace/example and @scoutbot later";
    for (const body of [payload, `@scoutbot ${payload}`, `@scoutbot: ${payload}`]) {
      const message = { id: "msg-context", actorId: "operator", body, metadata: {} } as ScoutBrokerMessageRecord;
      expect(buildScoutbotInvocation({ thread, message, nodeId: "node-local" }).task).toBe(payload);
    }
  });

  test("two simultaneous fresh-thread sends admit only one durable message before provider binding", async () => {
    const thread = { threadId: "thr-admission", conversationId: "c.admission", name: "Fresh", transport: "codex_app_server", transportSessionId: null, pins: null, lastActiveAt: 1, model: "gpt-6-astra" };
    const snapshot = { messages: {} } as ScoutBrokerSnapshot;
    let writes = 0;
    const send = () => admitScoutbotTurn("test-concurrent-admission", thread, async () => snapshot, async () => {
      await Promise.resolve();
      writes += 1;
      snapshot.messages["msg-first"] = { id: "msg-first", conversationId: thread.conversationId, actorId: "operator", body: "Hello", createdAt: 1 } as ScoutBrokerMessageRecord;
      return "msg-first";
    });
    const results = await Promise.allSettled([send(), send()]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(writes).toBe(1);
    expect(scoutbotThreadHasPendingTurn(thread, snapshot)).toBe(true);
    snapshot.messages["msg-answer"] = { id: "msg-answer", conversationId: thread.conversationId, actorId: "scoutbot", body: "Hello", createdAt: 2, replyToMessageId: "msg-first", metadata: { responderSessionId: "provider-first" } } as ScoutBrokerMessageRecord;
    expect(scoutbotThreadHasPendingTurn(thread, snapshot)).toBe(false);
  });

  test("a completed first flight without provider binding cannot open another fresh history", () => {
    const thread = { threadId: "thr-unbound", conversationId: "c.unbound", name: "Fresh", transport: "codex_app_server", transportSessionId: null, pins: null, lastActiveAt: 1, model: "gpt-6-astra" };
    const snapshot = {
      messages: { first: { id: "first", conversationId: thread.conversationId, actorId: "operator", createdAt: 1 } },
      flights: { flight: { id: "flight", invocationId: "inv", targetAgentId: "scoutbot", state: "completed", metadata: { returnAddress: { replyToMessageId: "first" } } } },
    } as unknown as ScoutBrokerSnapshot;
    expect(scoutbotThreadHasPendingTurn(thread, snapshot)).toBe(true);
    expect(scoutbotThreadHasPendingTurn({ ...thread, transportSessionId: "provider-existing" }, snapshot)).toBe(false);
  });

  test("uses each persisted thread's selected model for a fresh session and resumes its provider history", () => {
    const thread = {
      threadId: "thr-model", conversationId: "c.model", name: "Question", transport: "codex_app_server",
      transportSessionId: null, pins: null, lastActiveAt: 1, model: "gpt-6-astra", reasoningEffort: "high",
    };
    const message = { id: "msg-question", actorId: "operator", body: "Explain closures", metadata: {} } as ScoutBrokerMessageRecord;
    const first = buildScoutbotInvocation({ thread, message, nodeId: "node-local" });
    expect(first.execution).toEqual({ session: "new", harness: "codex", model: "gpt-6-astra", reasoningEffort: "high" });
    expect(first.conversationId).toBe("c.model");
    expect(buildScoutbotInvocation({ thread, message, nodeId: "node-local" }).id).toBe(first.id);
    const resumed = buildScoutbotInvocation({ thread: { ...thread, transportSessionId: "provider-123" }, message, nodeId: "node-local" });
    expect(resumed.execution).toEqual({ session: "existing", targetSessionId: "provider-123", harness: "codex", model: "gpt-6-astra", reasoningEffort: "high" });
    expect(resumed.conversationId).toBe(first.conversationId);
  });

  test("constrains Scoutbot to broker writes without shell or codebase writes", () => {
    expect(SCOUTBOT_ROLE_CONFIG.grants).toMatchObject({
      shell: false,
      codebaseWrites: false,
      write: ["ask"],
    });
    expect(scoutbotCodexLaunchArgs()).toEqual(expect.arrayContaining([
      "features.shell_tool=false",
      "features.unified_exec=false",
      "features.browser_use=false",
    ]));
  });

  test("recognizes direct-route metadata as addressed to scoutbot", () => {
    const message = {
      id: "msg-direct-status",
      conversationId: "dm.operator.scoutbot",
      actorId: "operator",
      body: "/status",
      createdAt: 1,
      class: "agent",
      metadata: {
        destinationKind: "direct",
        destinationId: "scoutbot",
        relayTargetIds: ["scoutbot"],
      },
    } as ScoutBrokerMessageRecord;

    expect(isScoutbotAddressedMessage(message)).toBe(true);
  });

  test("distinguishes broker direct deliveries from runner-owned scoutbot flights", () => {
    const directFlight = {
      id: "flight-direct",
      invocationId: "inv-direct",
      requesterId: "operator",
      targetAgentId: "scoutbot",
      state: "queued",
      metadata: {
        source: "scout-mobile",
        destinationKind: "direct",
        destinationId: "scoutbot",
      },
    } as ScoutBrokerFlightRecord;
    const runnerFlight = {
      ...directFlight,
      id: "flight-runner",
      metadata: {
        source: "scoutbot",
        relayTarget: "scoutbot",
      },
    } as ScoutBrokerFlightRecord;

    expect(isScoutbotDirectDeliveryFlight(directFlight)).toBe(true);
    expect(isScoutbotDirectDeliveryFlight(runnerFlight)).toBe(false);
  });

  test("requires scoutbot to be owned by the local node", () => {
    const agent = {
      id: "scoutbot",
      kind: "agent",
      displayName: "Scout",
      handle: "scoutbot",
      labels: ["assistant", "scout", "scoutbot"],
      metadata: {
        source: "scoutbot",
        brokerRegistered: true,
        roleConfig: SCOUTBOT_ROLE_CONFIG,
      },
      definitionId: "scoutbot",
      selector: "@scoutbot",
      defaultSelector: "@scoutbot",
      agentClass: "operator",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "keep_warm",
      homeNodeId: "peer-node",
      authorityNodeId: "peer-node",
      advertiseScope: "local",
    };

    expect(hasCurrentScoutbotAgentRegistration(agent, "local-node")).toBe(false);
    expect(hasCurrentScoutbotAgentRegistration({
      ...agent,
      homeNodeId: "local-node",
      authorityNodeId: "local-node",
    }, "local-node")).toBe(true);
  });
});
