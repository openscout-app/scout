import { describe, expect, test } from "bun:test";
import {
  stubs,
  askScoutQuestionCalls,
  createOpenScoutWebServer,
  makeStaticRoot,
  queryRunsCalls,
  sendScoutConversationMessageCalls,
  sendScoutConversationSteerCalls,
  sendScoutDirectMessageCalls,
  sendScoutMessageCalls,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: send routes", () => {
  test("replies to a harness session by id through the phone's session path", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/sessions/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "no-such-live-session-7f3a",
        harness: "claude",
        clientMessageId: "reply-request-1",
        body: "keep going",
        source: "scout-tui",
      }),
    });

    expect(response.status).toBe(200);
    expect(askScoutQuestionCalls).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ kind: "session_id", sessionId: "no-such-live-session-7f3a" }),
        body: "keep going",
        sessionDelivery: "in_place_or_resume",
        clientMessageId: "reply-request-1",
        source: "scout-tui",
        currentDirectory: "/tmp/openscout",
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      mode: "resumed",
      sourceSessionId: "no-such-live-session-7f3a",
    });
  });

  test("keeps a stable client message identity through a direct Chat invoke", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "direct",
      agentId: "agent-1",
      participantIds: ["operator", "agent-1"],
    });
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      conversationId: "c.agent-1",
      messageId: "msg-1",
      invokedTargets: ["agent-1"],
      unresolvedTargets: [],
      flights: [{
        id: "flt-1",
        invocationId: "inv-1",
        targetAgentId: "agent-1",
        state: "queued",
      }],
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      "http://localhost/api/chats/c.agent-1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "Status update",
          clientMessageId: "web-message-stable-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      expect.objectContaining({
        conversationId: "c.agent-1",
        body: "Status update",
        clientMessageId: "web-message-stable-1",
        intent: "invoke",
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      }),
    ]);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({
      chatId: "c.agent-1",
      conversationId: "c.agent-1",
      messageId: "msg-1",
      runIds: ["run:flight:flt-1"],
    });
  });

  test("steers the active Run in the selected direct Chat by default", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "direct",
      agentId: "agent-1",
      participantIds: ["operator", "agent-1"],
    });
    stubs.queryRunsResult = [{
      id: "run:flight:flt-active",
      agentId: "agent-1",
      flightIds: ["flt-active"],
    }];

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Use the current Run context",
        chatId: "c.agent-1",
      }),
    });

    expect(response.status).toBe(200);
    expect(queryRunsCalls).toEqual([{
      conversationId: "c.agent-1",
      active: true,
      limit: 100,
    }]);
    expect(sendScoutConversationSteerCalls).toEqual([
      {
        conversationId: "c.agent-1",
        senderId: "operator",
        body: "Use the current Run context",
        intent: "steer",
        steerContextByTargetAgentId: {
          "agent-1": {
            runId: "run:flight:flt-active",
            flightId: "flt-active",
          },
        },
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      },
    ]);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
  });

  test("invokes attachment-only direct DM sends in the selected Chat", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "direct",
      agentId: "agent-1",
      participantIds: ["operator", "agent-1"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "",
        chatId: "c.agent-1",
        attachments: [
          {
            id: "att-only",
            mediaType: "image/png",
            fileName: "screenshot.png",
            url: "http://127.0.0.1:3200/api/blobs/blob-only",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      expect.objectContaining({
        conversationId: "c.agent-1",
        body: "",
        attachments: [expect.objectContaining({ id: "att-only" })],
        intent: "invoke",
      }),
    ]);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
  });

  test("honors explicit steer mode in direct DMs", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "direct",
      agentId: "agent-1",
      participantIds: ["operator", "agent-1"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Use the existing turn context",
        chatId: "c.agent-1",
        intent: "steer",
        replyToMessageId: "msg-parent",
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      {
        conversationId: "c.agent-1",
        senderId: "operator",
        body: "Use the existing turn context",
        replyToMessageId: "msg-parent",
        intent: "steer",
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      },
    ]);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutMessageCalls).toHaveLength(0);
  });

  test("creates a linked Run through Send without changing the selected Chat", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "direct",
      agentId: "agent-1",
      participantIds: ["operator", "agent-1"],
    });
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      conversationId: "c.agent-1",
      messageId: "msg-send-1",
      invokedTargets: ["agent-1"],
      unresolvedTargets: [],
      flights: [{
        id: "flt-send-1",
        invocationId: "inv-send-1",
        targetAgentId: "agent-1",
        state: "queued",
      }],
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Review this and report back",
        chatId: "c.agent-1",
        intent: "invoke",
        execution: { harness: "codex", model: "gpt-test" },
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      expect.objectContaining({
        conversationId: "c.agent-1",
        body: "Review this and report back",
        intent: "invoke",
        execution: { harness: "codex", model: "gpt-test" },
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      }),
    ]);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({
      conversationId: "c.agent-1",
      chatId: "c.agent-1",
      runIds: ["run:flight:flt-send-1"],
    });
    expect(askScoutQuestionCalls).toHaveLength(0);
  });

  test("invokes configured-operator direct DM sends in the selected Chat by default", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "arach";
    stubs.querySessionByIdImpl = () => ({
      kind: "direct",
      agentId: "agent-1",
      participantIds: ["arach", "agent-1"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Status update",
        conversationId: "c.arach-agent-1",
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      expect.objectContaining({
        conversationId: "c.arach-agent-1",
        senderId: "operator",
        body: "Status update",
        intent: "invoke",
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      }),
    ]);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    expect(sendScoutMessageCalls).toHaveLength(0);
  });

  test("invokes explicitly targeted sends in observed agent-to-agent conversations", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "direct",
      agentId: "hudson.main.mini",
      participantIds: ["hudson.main.mini", "narrative-studio.main.mini"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "@hudson hi",
        conversationId: "c.hudson-narrative",
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      {
        conversationId: "c.hudson-narrative",
        senderId: "operator",
        body: "@hudson hi",
        intent: "invoke",
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      },
    ]);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutMessageCalls).toHaveLength(0);
  });

  test("rejects structural DM ids instead of promoting them", async () => {
    stubs.querySessionByIdImpl = () => ({
      id: "dm.operator.agent-1",
      kind: "group_direct",
      agentId: null,
      participantIds: ["operator", "agent-1", "agent-2"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Status update",
        conversationId: "dm.operator.agent-1",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "chatId must be an opaque chat id",
    });
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutMessageCalls).toHaveLength(0);
  });

  test("posts an untargeted message in an existing channel Chat", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "channel",
      agentId: null,
      participantIds: ["operator", "agent-1", "agent-2"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Team update",
        conversationId: "c.ops",
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationMessageCalls).toEqual([
      {
        conversationId: "c.ops",
        senderId: "operator",
        body: "Team update",
        notifyParticipantAgents: true,
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      },
    ]);
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutMessageCalls).toHaveLength(0);
  });

  test("derives a canonical group Chat send without accepting client routing policy", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "channel",
      agentId: null,
      participantIds: ["operator", "agent-1", "agent-2"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/chats/c.ops/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Team update",
        // Product callers cannot override the context-derived group semantics.
        intent: "invoke",
        targetParticipantIds: ["agent-1"],
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationMessageCalls).toEqual([{
      conversationId: "c.ops",
      senderId: "operator",
      body: "Team update",
      notifyParticipantAgents: true,
      currentDirectory: "/tmp/openscout",
      source: "scout-web",
    }]);
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({
      chatId: "c.ops",
      conversationId: "c.ops",
      placement: { kind: "root" },
    });
  });

  test("posts to a broker-backed channel before the SQLite projection catches up", async () => {
    const chatId = "chn-cfb4a5738b0d4399aa21768ae5987c09";
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1", name: "Test node" },
      snapshot: {
        conversations: {
          [chatId]: {
            id: chatId,
            kind: "channel",
            title: "engineering-ci",
            visibility: "workspace",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["operator", "agent-1", "agent-2"],
            metadata: { channel: "engineering-ci" },
          },
        },
        messages: {},
        invocations: {},
        flights: {},
        agents: {},
        actors: {
          operator: { id: "operator", displayName: "Operator" },
          "agent-1": { id: "agent-1", displayName: "Agent One" },
          "agent-2": { id: "agent-2", displayName: "Agent Two" },
        },
        endpoints: {},
      },
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      `http://localhost/api/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Team update" }),
      },
    );

    expect(response.status).toBe(200);
    expect(sendScoutConversationMessageCalls).toEqual([{
      conversationId: chatId,
      senderId: "operator",
      body: "Team update",
      notifyParticipantAgents: true,
      currentDirectory: "/tmp/openscout",
      source: "scout-web",
    }]);
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({
      chatId,
      conversationId: chatId,
      placement: { kind: "root" },
    });
  });

  test("returns canonical inline-reply placement from the Chat message endpoint", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "channel",
      agentId: null,
      participantIds: ["operator", "agent-1", "agent-2"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/chats/c.ops/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "One detail",
        replyToMessageId: "msg-root",
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationMessageCalls[0]).toMatchObject({
      conversationId: "c.ops",
      replyToMessageId: "msg-root",
      notifyParticipantAgents: true,
    });
    await expect(response.json()).resolves.toMatchObject({
      placement: {
        kind: "inline_reply",
        replyToMessageId: "msg-root",
      },
    });
  });

  test("inherits group delivery semantics and placement for an anchored child thread", async () => {
    stubs.querySessionByIdImpl = (conversationId) => conversationId === "c.parent"
      ? {
          kind: "channel",
          agentId: null,
          participantIds: ["operator", "agent-1", "agent-2"],
        }
      : {
          kind: "thread",
          agentId: null,
          participantIds: ["operator", "agent-1", "agent-2"],
        };
    stubs.queryConversationDefinitionByIdImpl = (conversationId) => conversationId === "c.thread"
      ? {
          id: "c.thread",
          kind: "thread",
          title: "Thread",
          visibility: "workspace",
          shareMode: "local",
          authorityNodeId: "node-1",
          topic: null,
          parentConversationId: "c.parent",
          messageId: "msg-anchor",
          metadata: {},
          participantIds: ["operator", "agent-1", "agent-2"],
        }
      : null;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/chats/c.thread/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Thread update" }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationMessageCalls[0]).toMatchObject({
      conversationId: "c.thread",
      body: "Thread update",
      notifyParticipantAgents: true,
    });
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({
      chatId: "c.thread",
      placement: {
        kind: "thread_reply",
        parentConversationId: "c.parent",
        anchorMessageId: "msg-anchor",
      },
    });
  });

  test("invokes an explicitly targeted Send in an existing channel Chat", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "channel",
      agentId: null,
      participantIds: ["operator", "agent-1", "agent-2"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "@agent-1 investigate this",
        conversationId: "c.ops",
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      {
        conversationId: "c.ops",
        senderId: "operator",
        body: "@agent-1 investigate this",
        intent: "invoke",
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      },
    ]);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    expect(queryRunsCalls).toEqual([{
      conversationId: "c.ops",
      active: true,
      limit: 100,
    }]);
  });

  test("routes a shared Chat selector from that target's active Run", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "channel",
      agentId: null,
      participantIds: ["operator", "agent-1", "agent-2"],
    });
    stubs.queryAgentsResult = [
      {
        id: "agent-1",
        definitionId: "agent-1",
        name: "Agent One",
        handle: "agent-1",
        selector: "@agent-1",
      },
      {
        id: "agent-2",
        definitionId: "agent-2",
        name: "Agent Two",
        handle: "agent-2",
        selector: "@agent-2",
      },
    ];
    stubs.queryRunsResult = [{
      id: "run:flight:flt-agent-2",
      agentId: "agent-2",
      flightIds: ["flt-agent-2"],
    }];

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "@agent-1 investigate this",
        conversationId: "c.ops",
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      expect.objectContaining({
        conversationId: "c.ops",
        body: "@agent-1 investigate this",
        intent: "invoke",
      }),
    ]);
    expect(sendScoutConversationSteerCalls[0]).not.toHaveProperty("steerContextByTargetAgentId");
    expect(sendScoutConversationMessageCalls).toHaveLength(0);

    sendScoutConversationSteerCalls.length = 0;
    queryRunsCalls.length = 0;
    stubs.queryRunsResult = [
      {
        id: "run:flight:flt-agent-1",
        agentId: "agent-1",
        flightIds: ["flt-agent-1"],
      },
      {
        id: "run:flight:flt-agent-2",
        agentId: "agent-2",
        flightIds: ["flt-agent-2"],
      },
    ];

    const activeTargetResponse = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "@agent-1 one more detail",
        conversationId: "c.ops",
      }),
    });

    expect(activeTargetResponse.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      expect.objectContaining({
        conversationId: "c.ops",
        body: "@agent-1 one more detail",
        intent: "steer",
        steerContextByTargetAgentId: {
          "agent-1": {
            runId: "run:flight:flt-agent-1",
            flightId: "flt-agent-1",
          },
        },
      }),
    ]);
  });

  test("keeps passive comments available for existing opaque chats", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "channel",
      agentId: null,
      participantIds: ["operator", "agent-1", "agent-2"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Transcript note",
        conversationId: "c.ops",
        intent: "comment",
        replyToMessageId: "msg-parent",
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationMessageCalls).toEqual([
      {
        conversationId: "c.ops",
        senderId: "operator",
        body: "Transcript note",
        replyToMessageId: "msg-parent",
        notifyParticipantAgents: true,
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      },
    ]);
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutMessageCalls).toHaveLength(0);
  });

  test("rejects blank reply targets on existing opaque chats", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Transcript note",
        conversationId: "c.ops",
        intent: "comment",
        replyToMessageId: "   ",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "replyToMessageId must be a non-empty string",
    });
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    expect(sendScoutConversationSteerCalls).toHaveLength(0);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutMessageCalls).toHaveLength(0);
  });

  test("routes direct DM asks through askScoutQuestion and rejects channel asks", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    stubs.querySessionByIdImpl = (conversationId) => {
      if (conversationId === "c.agent-1") {
        return {
          kind: "direct",
          agentId: "agent-1",
          participantIds: ["operator", "agent-1"],
        };
      }
      return {
        kind: "channel",
        agentId: null,
        participantIds: ["operator", "agent-1", "agent-2"],
      };
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const dmResponse = await server.app.request("http://localhost/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Please own this and report back.",
        conversationId: "c.agent-1",
      }),
    });
    expect(dmResponse.status).toBe(200);
    expect(askScoutQuestionCalls).toEqual([
      {
        senderId: "operator",
        targetLabel: "agent-1",
        targetAgentId: "agent-1",
        body: "Please own this and report back.",
        source: "scout-web",
        currentDirectory: "/tmp/openscout",
      },
    ]);

    const channelResponse = await server.app.request(
      "http://localhost/api/ask",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "Someone take this.",
          conversationId: "c.ops",
        }),
      },
    );
    expect(channelResponse.status).toBe(400);
    expect(await channelResponse.json()).toEqual({
      error: "ask is only available in a direct conversation with one agent",
    });

    const explicitResponse = await server.app.request("http://localhost/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "What should we catch up on?",
        targetAgentId: "agent-2",
        targetLabel: "Talkie",
        attachments: [
          {
            mediaType: "text/markdown",
            fileName: "context.md",
            url: "/api/blobs/blob-1",
          },
        ],
        execution: {
          harness: "codex",
          model: "gpt-test",
          reasoningEffort: "high",
        },
      }),
    });
    expect(explicitResponse.status).toBe(200);
    expect(askScoutQuestionCalls).toEqual([
      {
        senderId: "operator",
        targetLabel: "agent-1",
        targetAgentId: "agent-1",
        body: "Please own this and report back.",
        source: "scout-web",
        currentDirectory: "/tmp/openscout",
      },
      {
        senderId: expect.any(String),
        targetLabel: "Talkie",
        targetAgentId: "agent-2",
        body: "What should we catch up on?",
        executionHarness: "codex",
        executionModel: "gpt-test",
        executionReasoningEffort: "high",
        attachments: [
          {
            mediaType: "text/markdown",
            fileName: "context.md",
            url: "/api/blobs/blob-1",
          },
        ],
        source: "scout-web",
        currentDirectory: "/tmp/openscout",
      },
    ]);
  });

  for (const harness of ["grok", "grok-acp", "kimi", "opencode", "codex"] as const) {
    test(`preserves ${harness} through session, ask, and in-chat execution payloads`, async () => {
      process.env.OPENSCOUT_OPERATOR_NAME = "operator";
      stubs.queryAgentsResult = [{ id: "agent-1", definitionId: "agent-1", name: "Agent One", projectRoot: "/tmp/openscout", cwd: "/tmp/openscout", harness: "claude" }];
      stubs.querySessionByIdImpl = () => ({ kind: "direct", agentId: "agent-1", participantIds: ["operator", "agent-1"] });
      const server = await createOpenScoutWebServer({ currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot() });
      const session = await server.app.request("http://localhost/api/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: { agentId: "agent-1" }, execution: { harness }, seed: { instructions: "Use the requested harness." } }),
      });
      expect(session.status).toBe(200);
      expect(askScoutQuestionCalls.at(-1)).toMatchObject({ executionHarness: harness });
      const ask = await server.app.request("http://localhost/api/ask", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetAgentId: "agent-1", body: "Keep this harness.", execution: { harness } }),
      });
      expect(ask.status).toBe(200);
      expect(askScoutQuestionCalls.at(-1)).toMatchObject({ executionHarness: harness });
      const send = await server.app.request("http://localhost/api/send", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: "c.agent-1", body: "Continue here.", intent: "invoke", execution: { harness } }),
      });
      expect(send.status).toBe(200);
      expect(sendScoutConversationSteerCalls.at(-1)).toMatchObject({ conversationId: "c.agent-1", execution: { harness } });
    });
  }

  test("omitted ask harness retains the target agent fallback", async () => {
    stubs.queryAgentsResult = [{ id: "agent-1", definitionId: "agent-1", name: "Agent One", harness: "claude" }];
    const server = await createOpenScoutWebServer({ currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot() });
    const response = await server.app.request("http://localhost/api/ask", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetAgentId: "agent-1", body: "Use the target default." }),
    });
    expect(response.status).toBe(200);
    expect(askScoutQuestionCalls.at(-1)).toMatchObject({ executionHarness: "claude" });
  });
});
