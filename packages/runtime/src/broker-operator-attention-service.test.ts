import { describe, expect, test } from "bun:test";

import type {
  ConversationDefinition,
  MessageRecord,
} from "@openscout/protocol";

import {
  BrokerOperatorAttentionService,
  type OperatorDeliveryIssueInput,
} from "./broker-operator-attention-service.js";
import type {
  MobilePushAlert,
  MobilePushBroadcastResult,
} from "./mobile-push.js";

function testConversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "channel.system",
    kind: "system",
    title: "System",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "scout.system"],
    metadata: {},
    ...input,
  };
}

function broadcastResult(input: Partial<MobilePushBroadcastResult> = {}): MobilePushBroadcastResult {
  return {
    attemptedCount: 0,
    deliveredCount: 0,
    skippedCount: 0,
    failedCount: 0,
    configMissing: false,
    failures: [],
    ...input,
  };
}

function issue(input: Partial<OperatorDeliveryIssueInput> = {}): OperatorDeliveryIssueInput {
  return {
    kind: "rejected",
    requestId: "deliver-1",
    requesterId: "remote-agent",
    requesterNodeId: "remote-node",
    targetLabel: "@missing",
    detail: "Could not route @missing",
    ...input,
  };
}

function createHarness(input: {
  broadcastResult?: MobilePushBroadcastResult;
  conversation?: ConversationDefinition;
  originConversation?: ConversationDefinition;
} = {}) {
  const ensuredActors: string[] = [];
  const conversationRequests: Array<{ requesterId: string; targetAgentId?: string; channel?: string }> = [];
  const messages: MessageRecord[] = [];
  const alerts: MobilePushAlert[] = [];
  const warnings: string[] = [];
  const service = new BrokerOperatorAttentionService({
    nodeId: "node-1",
    systemActorId: "scout.system",
    operatorActorId: "operator",
    createId: () => "msg-1",
    async ensureBrokerActorForDelivery(actorId) {
      ensuredActors.push(actorId);
    },
    async ensureBrokerDeliveryConversation(request) {
      conversationRequests.push(request);
      return input.conversation ?? testConversation();
    },
    conversationById: (conversationId) =>
      input.originConversation?.id === conversationId
        ? input.originConversation
        : undefined,
    messageVisibilityForConversation: (conversation) => conversation?.visibility ?? "workspace",
    async postConversationMessage(message) {
      messages.push(message);
      return { ok: true };
    },
    async broadcastApnsAlertToActiveMobileDevices(alert) {
      alerts.push(alert);
      return input.broadcastResult ?? broadcastResult();
    },
    warn: (message) => warnings.push(message),
    now: () => 10_000,
  });

  return {
    alerts,
    conversationRequests,
    ensuredActors,
    messages,
    service,
    warnings,
  };
}

describe("BrokerOperatorAttentionService", () => {
  test("records a system message and mobile alert for delivery issues", async () => {
    const harness = createHarness();

    await harness.service.recordDeliveryIssue(issue());

    expect(harness.ensuredActors).toEqual(["operator"]);
    expect(harness.conversationRequests).toEqual([
      { requesterId: "scout.system", channel: "system" },
    ]);
    expect(harness.messages).toEqual([
      expect.objectContaining({
        id: "msg-1",
        conversationId: "channel.system",
        actorId: "scout.system",
        originNodeId: "node-1",
        class: "system",
        body: "Could not route @missing",
        audience: {
          notify: ["operator"],
          reason: "mention",
        },
        visibility: "workspace",
        createdAt: 10_000,
        metadata: expect.objectContaining({
          source: "broker",
          operatorAttention: "delivery_issue",
          deliveryIssueKind: "rejected",
          requestId: "deliver-1",
          requesterId: "remote-agent",
          requesterNodeId: "remote-node",
          targetLabel: "@missing",
          itemId: "delivery:deliver-1",
        }),
      }),
    ]);
    expect(harness.alerts).toEqual([
      expect.objectContaining({
      title: "Scout delivery needs attention",
      body: "Open Scout for details.",
      sound: "default",
      urgency: "interrupt",
        threadId: "scout.delivery",
        payload: expect.objectContaining({
          destination: "inbox",
          itemId: "delivery:deliver-1",
          kind: "delivery_issue",
          messageId: "msg-1",
          conversationId: "channel.system",
          requestId: "deliver-1",
          requesterId: "remote-agent",
          requesterNodeId: "remote-node",
          targetLabel: "@missing",
          reason: "rejected",
        }),
      }),
    ]);
  });

  test("does not queue operator self-notifications", async () => {
    const harness = createHarness();

    harness.service.queueDeliveryIssue(issue({ requesterId: "operator" }));
    await Promise.resolve();

    expect(harness.messages).toEqual([]);
    expect(harness.alerts).toEqual([]);
    expect(harness.warnings).toEqual([]);
  });

  test("mirrors a delivery failure into its originating conversation", async () => {
    const originConversation = testConversation({
      id: "chat-origin",
      kind: "direct",
      visibility: "private",
      participantIds: ["operator", "scout.dispatcher"],
    });
    const harness = createHarness({ originConversation });

    await harness.service.recordDeliveryIssue(issue({
      originConversationId: originConversation.id,
      originMessageId: "msg-origin",
    }));

    expect(harness.messages[0]).toEqual(expect.objectContaining({
      conversationId: "chat-origin",
      class: "status",
      replyToMessageId: "msg-origin",
      visibility: "private",
      metadata: expect.objectContaining({
        routingState: "failed",
        deliveryIssueKind: "rejected",
      }),
    }));
    expect(harness.messages[1]).toEqual(expect.objectContaining({
      conversationId: "channel.system",
      class: "system",
    }));
  });

  test("records an operator's own failure at the origin without a system-lane duplicate", async () => {
    const originConversation = testConversation({
      id: "chat-origin",
      kind: "direct",
      visibility: "private",
    });
    const harness = createHarness({ originConversation });

    await harness.service.recordDeliveryIssue(issue({
      requesterId: "operator",
      originConversationId: originConversation.id,
      originMessageId: "msg-origin",
    }));

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toEqual(expect.objectContaining({
      conversationId: "chat-origin",
      replyToMessageId: "msg-origin",
    }));
    expect(harness.alerts).toEqual([]);
  });

  test("blocking questions never put authored content in APNs", async () => {
    const harness = createHarness();
    await harness.service.sendOperatorSignalAlert({
      signal: { kind: "need", blocking: true, replyExpectation: "required", question: "Should I use /private/customer-data?" },
      messageId: "msg-need", conversationId: "dm", requesterId: "agent", requesterNodeId: "node",
    });
    expect(harness.alerts[0]?.urgency).toBe("interrupt");
    expect(harness.alerts[0]?.body).toContain("is asking a question");
    expect(JSON.stringify(harness.alerts)).not.toContain("customer-data");
  });

  test("carries what the agent said only as the notification, never in the alert text", async () => {
    const harness = createHarness();
    await harness.service.sendOperatorSignalAlert({
      signal: { kind: "need", blocking: true, replyExpectation: "required", question: "Should I use /private/customer-data?" },
      messageId: "msg-need", conversationId: "dm", requesterId: "agent", requesterNodeId: "node",
      body: "Should I use /private/customer-data?", requesterName: "cajun", projectRoot: "/Users/art/dev/fab", createdAt: 7,
    });
    const { notification, ...alert } = harness.alerts[0]!;
    expect(notification).toMatchObject({
      view: "ask", note: "Should I use /private/customer-data?", urgent: true,
      sender: { name: "cajun", agentId: "agent" }, project: "fab", itemId: "msg-need",
    });
    expect(JSON.stringify(alert)).not.toContain("customer-data");
  });

  test("pushes a generic non-blocking alert for an agent-authored operator signal", async () => {
    const harness = createHarness();

    await harness.service.sendOperatorSignalAlert({
      signal: {
        kind: "consult",
        blocking: false,
        replyExpectation: "optional",
        defaultAction: "Keep the restrained HUD animation.",
      },
      messageId: "msg-consult",
      conversationId: "dm.agent.operator",
      requesterId: "agent-1",
      requesterNodeId: "node-1",
    });

    expect(harness.messages).toEqual([]);
    expect(harness.alerts).toEqual([{
      title: "An agent would value your input",
      body: "Open Scout for details.",
      sound: null,
      urgency: "silent",
      threadId: "scout.agent-signal",
      payload: {
        destination: "inbox",
        itemId: "msg-consult",
        kind: "operator_signal",
        signalKind: "consult",
        messageId: "msg-consult",
        conversationId: "dm.agent.operator",
        requesterId: "agent-1",
        requesterNodeId: "node-1",
      },
    }]);
  });

  test("warns once for missing credentials and reports rate limits and failures", async () => {
    const harness = createHarness({
      broadcastResult: broadcastResult({
        configMissing: true,
        rateLimited: true,
        retryAfterSeconds: 12,
        rateLimitWindow: "minute",
        failures: [{
          deviceId: "device-1",
          tokenSuffix: "abcd",
          status: 500,
          reason: null,
        }],
      }),
    });

    await harness.service.recordDeliveryIssue(issue({ requestId: "deliver-1" }));
    await harness.service.recordDeliveryIssue(issue({ requestId: "deliver-2" }));

    expect(harness.warnings).toEqual([
      "[openscout-runtime] mobile push credentials are missing; operator attention was recorded without APNS.",
      "[openscout-runtime] push relay rate-limited (minute); retry in 12s.",
      "[openscout-runtime] failed to send operator delivery issue push to device-1 (abcd): 500",
      "[openscout-runtime] push relay rate-limited (minute); retry in 12s.",
      "[openscout-runtime] failed to send operator delivery issue push to device-1 (abcd): 500",
    ]);
  });
});

test("permission push carries the exact request only through the existing paired notification", async () => {
  const harness = createHarness();
  const prompt = "Accessing workspace: /private/project\nYes, I trust this folder";
  await harness.service.sendOperatorSignalAlert({ signal: { kind: "need", blocking: true, replyExpectation: "required", requestKind: "permission", question: prompt },
    messageId: "permission-1", conversationId: "chn-permission", requesterId: "agent", requesterNodeId: "node", body: prompt });
  const { notification, ...alert } = harness.alerts[0]!;
  expect(notification?.note).toBe(prompt); expect(alert.urgency).toBe("interrupt");
  expect(JSON.stringify(alert)).not.toContain("/private/project");
  expect(alert.payload).toMatchObject({ itemId: "permission-1", conversationId: "chn-permission" });
});

test("APNs enforces the durable FYI policy and interrupting override", async () => {
  const h = createHarness();
  const input = { signal: { kind: "notify" as const, blocking: false as const, replyExpectation: "none" as const,
    notificationPolicy: { requested: false, priority: "interrupting" as const } }, messageId: "msg-policy", conversationId: "dm", requesterId: "worker", requesterNodeId: "node-1" };
  await h.service.sendOperatorSignalAlert(input); expect(h.alerts).toHaveLength(0);
  await h.service.sendOperatorSignalAlert({ ...input, signal: { ...input.signal, notificationPolicy: { requested: true, priority: "interrupting" } } });
  expect(h.alerts).toHaveLength(1); expect(h.alerts[0]).toMatchObject({ urgency: "interrupt", sound: "default" });
});
