import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod/v4";

import type { AgentBrokerFeedCounts, ScoutOperatorSignal } from "@openscout/protocol";

import {
  SCOUT_MCP_UI_META_KEY,
  createScoutMcpServer,
  type ScoutMcpAgentCandidate,
} from "./scout-mcp.ts";
import type { ScoutAskCommand } from "../broker/ask-types.ts";

const openClients = new Set<Client>();
const openServers = new Set<ReturnType<typeof createScoutMcpServer>>();
const tempPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...openClients].map(async (client) => {
      await client.close();
      openClients.delete(client);
    }),
  );
  await Promise.all(
    [...openServers].map(async (server) => {
      await server.close();
      openServers.delete(server);
    }),
  );
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

async function connectTestServer(
  dependencies: Parameters<typeof createScoutMcpServer>[0]["dependencies"],
  envOverrides: NodeJS.ProcessEnv = {},
) {
  const server = createScoutMcpServer({
    defaultCurrentDirectory: "/tmp/openscout-test",
    env: {
      ...process.env,
      OPENSCOUT_BROKER_URL: "http://broker.test",
      CODEX_THREAD_ID: "019ddb1b-test-thread",
      OPENSCOUT_EXPOSE_DEPRECATED_INVOCATIONS_ASK: "1",
      OPENSCOUT_AGENT: "",
      OPENSCOUT_REPLY_CONTEXT: "",
      OPENSCOUT_REPLY_CONTEXT_FILE: "",
      ...envOverrides,
    },
    // Never read the real mesh from a test; a test that needs it passes its own.
    dependencies: {
      loadMeshOverview: async () => {
        throw new Error("mesh overview is not available in this test");
      },
      ...dependencies,
    },
  });
  const client = new Client(
    { name: "openscout-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  openServers.add(server);
  openClients.add(client);
  return { client, server };
}

describe("createScoutMcpServer", () => {
  test("registers the core Scout MCP tools", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      readLabelBrief: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_EXPOSE_DEPRECATED_INVOCATIONS_ASK: "",
    });

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "where",
      "check",
      "route_context",
      "sessions_inventory",
      "sessions_search",
      "herdr_workspaces",
      "session_send",
      "flight_cancel",
      "attachments_read",
      "integrations_setup",
      "integrations_get",
      "integrations_verify",
      "integrations_manifest",
      "integrations_start",
      "integrations_pause",
      "integrations_disconnect",
      "integrations_resume",
      "chat_status",
      "chat_catch_up",
      "chat_ack",
      "sessions_attach",
      "sessions_get",
      "sessions_poll",
      "sessions_ack",
      "sessions_reply",
      "aliases_set",
      "aliases_list",
      "aliases_resolve",
      "aliases_repoint",
      "aliases_unset",
      "whoami",
      "hosts_list",
      "feedback_send",
      "messages_inbox",
      "messages_channel",
      "broker_feed",
      "tail_events",
      "current_reply_context",
      "messages_reply",
      "session_attach_current",
      "card_create",
      "agents_start",
      "agents_search",
      "agents_resolve",
      "ask",
      "notify_operator",
      "consult_operator",
      "messages_send",
      "invocations_get",
      "invocations_wait",
      "labels_brief",
      "labels_feed",
      "work_update",
    ]);
    expect(result.tools.find((tool) => tool.name === "aliases_set")?.description)
      .toContain("never creates or mutates an agent card");
    expect(result.tools.find((tool) => tool.name === "whoami")?.description)
      .toContain("Use this when host or workspace context is unclear");
    expect(result.tools.find((tool) => tool.name === "messages_send")?.description)
      .toContain("For new agent-to-agent work, use ask instead.");
    expect(result.tools.find((tool) => tool.name === "notify_operator")?.description)
      .toContain("non-blocking FYI");
    expect(result.tools.find((tool) => tool.name === "consult_operator")?.description)
      .toContain("Always declare the safe default action");
    expect(result.tools.find((tool) => tool.name === "messages_inbox")?.description)
      .toContain("instead of curling broker HTTP endpoints");
    expect(result.tools.find((tool) => tool.name === "messages_channel")?.description)
      .toContain("instead of curling broker HTTP endpoints");
    expect(result.tools.find((tool) => tool.name === "broker_feed")?.description)
      .toContain("native broker view");
    expect(result.tools.find((tool) => tool.name === "tail_events")?.description)
      .toContain("observed harness events");
    expect(result.tools.find((tool) => tool.name === "messages_reply")?.description)
      .toContain("current ScoutReplyContext");
    expect(result.tools.find((tool) => tool.name === "work_update")?.description)
      .toContain("progress, waiting, review, and done transitions");
    expect(result.tools.find((tool) => tool.name === "labels_brief")?.description)
      .toContain("sharing a Scout label");
    expect(result.tools.find((tool) => tool.name === "labels_feed")?.description)
      .toContain("normalized firehose-style event backlog");
  });

  test("sends notify and consult operator signals without creating work lifecycle", async () => {
    const sent: Array<{
      senderId: string;
      body: string;
      targetLabel?: string;
      wake?: boolean;
      operatorSignal?: ScoutOperatorSignal;
    }> = [];
    const { client } = await connectTestServer({
      resolveSenderId: async () => "action.main",
      sendMessage: async (input) => {
        sent.push(input);
        return {
          usedBroker: true,
          conversationId: "dm.action.operator",
          messageId: `msg-${sent.length}`,
          invokedTargets: ["operator"],
          unresolvedTargets: [],
          routeKind: "dm",
        };
      },
    });

    const notifyResult = await client.callTool({
      name: "notify_operator",
      arguments: {
        message: "The HUD pass is ready for visual review.",
      },
    });
    const consultResult = await client.callTool({
      name: "consult_operator",
      arguments: {
        question: "Would you prefer the quieter animation?",
        defaultAction: "Continue with the quieter animation.",
      },
    });

    expect(sent).toEqual([
      expect.objectContaining({
        senderId: "action.main",
        body: "The HUD pass is ready for visual review.",
        targetLabel: "@operator",
        wake: false,
        operatorSignal: {
          kind: "notify",
          blocking: false,
          replyExpectation: "none",
        },
      }),
      expect.objectContaining({
        senderId: "action.main",
        body: "Would you prefer the quieter animation?\n\nDefault if there is no reply: Continue with the quieter animation.",
        targetLabel: "@operator",
        wake: false,
        operatorSignal: {
          kind: "consult",
          blocking: false,
          replyExpectation: "optional",
          defaultAction: "Continue with the quieter animation.",
        },
      }),
    ]);
    expect(notifyResult.structuredContent).toEqual(expect.objectContaining({
      kind: "notify",
      status: "recorded",
      blocking: false,
      replyExpectation: "none",
      notificationDelivery: "unconfirmed",
      conversationId: "dm.action.operator",
      messageId: "msg-1",
      signalId: "msg-1",
    }));
    expect(consultResult.structuredContent).toEqual(expect.objectContaining({
      kind: "consult",
      status: "recorded",
      blocking: false,
      replyExpectation: "optional",
      notificationDelivery: "unconfirmed",
      defaultAction: "Continue with the quieter animation.",
      messageId: "msg-2",
      signalId: "msg-2",
    }));
    const consultContent = consultResult.content as Array<{ text?: string }>;
    expect(consultContent[0]?.text).toContain("notification delivery is unconfirmed");
  });

  test("rejects blank operator signals and records explicit sender overrides", async () => {
    let sendCount = 0;
    let requestedSenderId: string | null | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async (senderId) => {
        requestedSenderId = senderId;
        return senderId ?? "operator";
      },
      sendMessage: async () => {
        sendCount += 1;
        return {
          usedBroker: true,
          conversationId: "dm.operator.operator",
          messageId: "msg-self",
          invokedTargets: [],
          unresolvedTargets: [],
        };
      },
    });

    const blank = await client.callTool({
      name: "consult_operator",
      arguments: { question: " ", defaultAction: "\t" },
    });
    expect(blank.isError).toBe(true);

    const overridden = await client.callTool({
      name: "notify_operator",
      arguments: { message: "A real update", senderId: "local-helper" },
    });
    expect(overridden.structuredContent).toEqual(expect.objectContaining({
      status: "recorded",
      senderId: "local-helper",
      notificationDelivery: "unconfirmed",
    }));
    expect(requestedSenderId).toBe("local-helper");
    expect(sendCount).toBe(1);
  });

  test("returns a compact label brief", async () => {
    const { client } = await connectTestServer({
      readLabelBrief: async (label) => ({
        label,
        generatedAt: 1_000,
        lastActivityAt: 900,
        participants: ["operator", "hudson.main"],
        counts: {
          flights: 1,
          activeFlights: 1,
          workItems: 0,
        },
        flightsByState: {
          running: 1,
        },
        activeFlights: [
          {
            id: "flt-1",
            invocationId: "inv-1",
            state: "running",
            requesterId: "operator",
            targetAgentId: "hudson.main",
            summary: "Running tests.",
            output: null,
            error: null,
            labels: [label],
            conversationId: null,
            messageId: null,
            workId: null,
            startedAt: 900,
            completedAt: null,
            lastActivityAt: 900,
          },
        ],
        recentFlights: [],
        workItems: [],
      }),
    });

    const result = await client.callTool({
      name: "labels_brief",
      arguments: {
        label: "release:0.2.66",
      },
    });

    const content = result.content as Array<{ text?: string }> | undefined;
    expect(content?.[0]?.text).toContain("Label release:0.2.66");
    expect((result.structuredContent as { found?: boolean; counts?: { activeFlights: number } }).found).toBe(true);
    expect((result.structuredContent as { counts?: { activeFlights: number } }).counts?.activeFlights).toBe(1);
  });

  test("returns a normalized label feed", async () => {
    let receivedOptions:
      | { since?: number | null; limit?: number | null }
      | undefined;
    const { client } = await connectTestServer({
      readLabelFeed: async (label, _baseUrl, options) => {
        receivedOptions = options;
        return {
          label,
          generatedAt: 1_000,
          cursor: "work-event:evt-1",
          since: options?.since ?? null,
          counts: {
            events: 1,
            messages: 0,
            invocations: 0,
            flights: 0,
            workEvents: 1,
          },
          events: [
            {
              id: "work-event:evt-1",
              label,
              at: 900,
              kind: "work_event",
              category: "work",
              actorId: "hudson.main",
              targetAgentId: "hudson.main",
              conversationId: "dm.operator.hudson",
              messageId: null,
              invocationId: null,
              flightId: null,
              workId: "work-1",
              state: "working",
              eventKind: "progressed",
              summary: "Tests are still running.",
              labels: [label],
            },
          ],
        };
      },
    });

    const result = await client.callTool({
      name: "labels_feed",
      arguments: {
        label: "release:0.2.66",
        since: 500,
        limit: 10,
      },
    });

    expect(receivedOptions).toEqual({
      since: 500,
      limit: 10,
    });
    const content = result.content as Array<{ text?: string }> | undefined;
    expect(content?.[0]?.text).toContain("Label release:0.2.66");
    expect(content?.[0]?.text).toContain("Tests are still running.");
    expect((result.structuredContent as { counts?: { events: number } }).counts?.events).toBe(1);
  });

  test("reads inbox messages through the broker dependency", async () => {
    let receivedInput:
      | {
        participantId?: string;
        inboxOnly?: boolean;
        limit?: number;
        baseUrl?: string;
      }
      | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async (senderId, currentDirectory) =>
        `${senderId ?? "operator"}@${currentDirectory}`,
      loadMessages: async (input) => {
        receivedInput = input;
        return [
          {
            id: "msg-inbox",
            conversationId: "dm.operator.hudson",
            actorId: "hudson.main.mini",
            originNodeId: "local",
            class: "agent",
            body: "latest inbox",
            visibility: "workspace",
            policy: "durable",
            createdAt: 123,
          },
        ];
      },
    });

    const result = await client.callTool({
      name: "messages_inbox",
      arguments: {
        currentDirectory: "/tmp/project",
        senderId: "hudson.main.mini",
        limit: 5,
      },
    });

    expect(receivedInput).toMatchObject({
      participantId: "hudson.main.mini@/tmp/project",
      inboxOnly: true,
      limit: 5,
      baseUrl: "http://broker.test",
    });
    const structured = result.structuredContent as {
      senderId: string;
      messages: Array<{ id: string; body: string }>;
    };
    expect(structured.senderId).toBe("hudson.main.mini@/tmp/project");
    expect(structured.messages[0]).toMatchObject({
      id: "msg-inbox",
      body: "latest inbox",
    });
  });

  test("reads channel messages through the broker dependency", async () => {
    let receivedInput:
      | {
        channel?: string;
        limit?: number;
        baseUrl?: string;
      }
      | undefined;
    const { client } = await connectTestServer({
      loadMessages: async (input) => {
        receivedInput = input;
        return [
          {
            id: "msg-channel",
            conversationId: "channel.homepage-polish",
            actorId: "hudsonos.homepage-polish.mini",
            originNodeId: "local",
            class: "agent",
            body: "latest channel",
            visibility: "workspace",
            policy: "durable",
            createdAt: 456,
          },
        ];
      },
    });

    const result = await client.callTool({
      name: "messages_channel",
      arguments: {
        channel: "homepage-polish",
        limit: 3,
      },
    });

    expect(receivedInput).toMatchObject({
      channel: "homepage-polish",
      limit: 3,
      baseUrl: "http://broker.test",
    });
    const structured = result.structuredContent as {
      channel: string;
      messages: Array<{ id: string; body: string }>;
    };
    expect(structured.channel).toBe("homepage-polish");
    expect(structured.messages[0]).toMatchObject({
      id: "msg-channel",
      body: "latest channel",
    });
  });

  test("validates the protocol broker feed without an invented unblock count through MCP", async () => {
    let receivedInput:
      | {
        agentId: string;
        since?: number | null;
        limit?: number;
        includeAcknowledged?: boolean;
        baseUrl?: string;
      }
      | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async (senderId, currentDirectory) =>
        `${senderId ?? "operator"}@${currentDirectory}`,
      readBrokerFeed: async (input) => {
        receivedInput = input;
        return {
          agentId: input.agentId,
          generatedAt: 1_000,
          since: input.since ?? null,
          limit: input.limit ?? 80,
          cursor: 900,
          status: {
            agentId: input.agentId,
            displayName: "Hudson",
            found: true,
            endpoints: [],
            activeFlightIds: ["flight-1"],
            pendingDeliveryIds: ["delivery-1"],
            errorCount: 1,
            warningCount: 0,
            lastError: "dispatch stalled",
            lastActivityAt: 900,
          },
          counts: {
            items: 1,
            messages: 0,
            statuses: 0,
            invocations: 0,
            flights: 1,
            deliveries: 0,
            deliveryAttempts: 0,
            dispatches: 0,
            errors: 1,
            warnings: 0,
          } satisfies AgentBrokerFeedCounts,
          items: [
            {
              id: "flight:flight-1",
              kind: "flight",
              severity: "error",
              at: 900,
              title: "Flight failed",
              summary: "dispatch stalled",
              agentId: input.agentId,
              targetAgentId: input.agentId,
              invocationId: "inv-1",
              flightId: "flight-1",
              status: "failed",
              source: "snapshot",
            },
          ],
        };
      },
    });

    const tools = await client.listTools();
    const advertised = tools.tools.find((tool) => tool.name === "broker_feed");
    const countsSchema = advertised?.outputSchema?.properties?.counts as
      | { required?: string[] }
      | undefined;
    expect(countsSchema?.required).toContain("errors");
    expect(countsSchema?.required).not.toContain("unblockRequests");

    // This invokes the SDK server's real output-schema validation over transport.
    const result = await client.callTool({
      name: "broker_feed",
      arguments: {
        currentDirectory: "/tmp/project",
        senderId: "hudson.main.mini",
        since: 500,
        limit: 5,
        includeAcknowledged: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(receivedInput).toMatchObject({
      agentId: "hudson.main.mini@/tmp/project",
      since: 500,
      limit: 5,
      includeAcknowledged: true,
      baseUrl: "http://broker.test",
    });
    const content = result.content as Array<{ text?: string }> | undefined;
    expect(content?.[0]?.text).toContain("Broker feed for hudson.main.mini@/tmp/project");
    expect(content?.[0]?.text).toContain("dispatch stalled");
    const structured = result.structuredContent as {
      found: boolean;
      counts: { errors: number };
      items: Array<{ kind: string; severity: string; summary: string }>;
    };
    expect(structured.found).toBe(true);
    expect(structured.counts.errors).toBe(1);
    expect(structured.counts).not.toHaveProperty("unblockRequests");
    expect(structured.items[0]).toMatchObject({
      kind: "flight",
      severity: "error",
      summary: "dispatch stalled",
    });
  });

  test("validates the unavailable broker feed without fabricating an unblock count", async () => {
    const { client } = await connectTestServer({
      readBrokerFeed: async () => null,
    });
    const result = await client.callTool({
      name: "broker_feed",
      arguments: { agentId: "agent-unavailable" },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      found: boolean;
      counts: AgentBrokerFeedCounts;
    };
    expect(structured.found).toBe(false);
    expect(structured.counts.items).toBe(0);
    expect(structured.counts).not.toHaveProperty("unblockRequests");
  });

  test("reads tail events through the broker dependency", async () => {
    let receivedInput:
      | {
        limit?: number;
        sources?: string[];
        kinds?: string[];
        query?: string;
        transcripts?: boolean;
        baseUrl?: string;
      }
      | undefined;
    const { client } = await connectTestServer({
      readTailEvents: async (input) => {
        receivedInput = input;
        return {
          generatedAt: 1_000,
          limit: input.limit ?? 80,
          cursor: "codex:s1:2",
          events: [
            {
              id: "codex:s1:2",
              ts: 900,
              source: "codex",
              sessionId: "s1",
              pid: 101,
              parentPid: null,
              project: "openscout",
              cwd: "/tmp/openscout",
              harness: "unattributed",
              kind: "tool-result",
              summary: "bun test passed",
            },
          ],
        };
      },
    });

    const result = await client.callTool({
      name: "tail_events",
      arguments: {
        sources: ["codex"],
        kinds: ["tool-result"],
        query: "test",
        limit: 5,
        transcripts: true,
      },
    });

    expect(receivedInput).toMatchObject({
      limit: 5,
      sources: ["codex"],
      kinds: ["tool-result"],
      query: "test",
      transcripts: true,
      baseUrl: "http://broker.test",
    });
    const content = result.content as Array<{ text?: string }> | undefined;
    expect(content?.[0]?.text).toContain("Tail events");
    expect(content?.[0]?.text).toContain("bun test passed");
    const structured = result.structuredContent as {
      counts?: { events: number; sources: number; sessions: number };
      events?: Array<{ source: string; kind: string; summary: string }>;
    };
    expect(structured.counts).toEqual({
      events: 1,
      sources: 1,
      sessions: 1,
    });
    expect(structured.events?.[0]).toMatchObject({
      source: "codex",
      kind: "tool-result",
      summary: "bun test passed",
    });
  });


  test("surfaces and uses active Scout reply context", async () => {
    let receivedReply: {
      senderId: string;
      body: string;
      conversationId: string;
      replyToMessageId: string;
      currentDirectory: string;
      source?: string;
    } | undefined;
    const { client } = await connectTestServer(
      {
        resolveSenderId: async (senderId, currentDirectory) =>
          `${senderId ?? "operator"}@${currentDirectory}`,
        replyMessage: async (input) => {
          receivedReply = input;
          return {
            usedBroker: true,
            conversationId: input.conversationId,
            messageId: "msg-reply-1",
            replyToMessageId: input.replyToMessageId,
            notifiedActorIds: ["sender.agent"],
          };
        },
      },
      {
        OPENSCOUT_REPLY_CONTEXT: JSON.stringify({
          mode: "broker_reply",
          fromAgentId: "sender.agent",
          toAgentId: "target.agent",
          conversationId: "dm.sender.target",
          messageId: "msg-original",
          replyToMessageId: "msg-original",
          replyPath: "mcp_reply",
          action: "consult",
        }),
      },
    );

    const contextResult = await client.callTool({
      name: "current_reply_context",
      arguments: {},
    });
    expect(contextResult.structuredContent).toMatchObject({
      active: true,
      context: {
        mode: "broker_reply",
        fromAgentId: "sender.agent",
        toAgentId: "target.agent",
        conversationId: "dm.sender.target",
        replyToMessageId: "msg-original",
        replyPath: "mcp_reply",
      },
    });

    const replyResult = await client.callTool({
      name: "messages_reply",
      arguments: {
        body: "Broker-visible reply",
        currentDirectory: "/worktree/app",
      },
    });

    expect(receivedReply).toEqual({
      senderId: "target.agent@/worktree/app",
      body: "Broker-visible reply",
      conversationId: "dm.sender.target",
      replyToMessageId: "msg-original",
      currentDirectory: "/worktree/app",
      source: "scout-mcp",
    });
    expect(replyResult.structuredContent).toMatchObject({
      conversationId: "dm.sender.target",
      messageId: "msg-reply-1",
      replyToMessageId: "msg-original",
      notifiedActorIds: ["sender.agent"],
      routingError: null,
    });
  });

  test("reads active Scout reply context from a long-lived context file", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-mcp-reply-context-"));
    tempPaths.add(tempRoot);
    const replyContextPath = join(tempRoot, "active-reply-context.json");
    writeFileSync(replyContextPath, JSON.stringify({
      mode: "broker_reply",
      fromAgentId: "sender.agent",
      toAgentId: "target.agent",
      conversationId: "dm.sender.target",
      messageId: "msg-original",
      replyToMessageId: "msg-original",
      replyPath: "mcp_reply",
      action: "consult",
    }));

    const { client } = await connectTestServer(
      {
        resolveSenderId: async () => "operator",
      },
      {
        OPENSCOUT_REPLY_CONTEXT_FILE: replyContextPath,
      },
    );

    const contextResult = await client.callTool({
      name: "current_reply_context",
      arguments: {},
    });

    expect(contextResult.structuredContent).toMatchObject({
      active: true,
      context: {
        conversationId: "dm.sender.target",
        replyToMessageId: "msg-original",
        replyPath: "mcp_reply",
      },
    });
  });

  test("messages_reply explains missing reply context", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
    });

    const result = await client.callTool({
      name: "messages_reply",
      arguments: { body: "No context" },
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "No active Scout broker reply context. Use messages_send for a new message, use ask for a new request, or pass conversationId and replyToMessageId explicitly.",
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      routingError: "missing_reply_context",
      conversationId: null,
      replyToMessageId: null,
    });
  });

  test("attaches the current Codex session when CODEX_THREAD_ID is available", async () => {
    let receivedExternalSessionId: string | undefined;
    const { client } = await connectTestServer({
      attachCurrentLocalSession: async (input) => {
        receivedExternalSessionId = input.externalSessionId;
        return {
          ok: true,
          agentId: "codex.current.mini",
          selector: "@codex-current",
          endpointId: "endpoint.codex.current",
          sessionId: "pairing-019ddb1b",
        };
      },
    });

    const result = await client.callTool({
      name: "session_attach_current",
      arguments: {
        currentDirectory: "/worktree/app",
        alias: "@codex-current",
      },
    });

    const structured = result.structuredContent as {
      currentDirectory: string;
      externalSessionId: string;
      transport: string;
      agentId: string;
      selector: string | null;
      endpointId: string;
      sessionId: string;
    };

    expect(receivedExternalSessionId).toBe("019ddb1b-test-thread");
    expect(structured.currentDirectory).toBe("/worktree/app");
    expect(structured.externalSessionId).toBe("019ddb1b-test-thread");
    expect(structured.transport).toBe("codex_app_server");
    expect(structured.agentId).toBe("codex.current.mini");
    expect(structured.selector).toBe("@codex-current");
    expect(structured.endpointId).toBe("endpoint.codex.current");
    expect(structured.sessionId).toBe("pairing-019ddb1b");
  });

  test("advertises host-consumable agent picker metadata for Scout routing fields", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const result = await client.listTools();
    const sendTool = result.tools.find((tool) => tool.name === "messages_send") as
      | {
          _meta?: Record<string, unknown>;
          inputSchema?: {
            properties?: Record<string, { description?: string }>;
          };
        }
      | undefined;
    const askTool = result.tools.find((tool) => tool.name === "ask") as
      | {
          _meta?: Record<string, unknown>;
          inputSchema?: {
            properties?: Record<string, { description?: string }>;
          };
        }
      | undefined;

    expect(sendTool?._meta).toMatchObject({
      [SCOUT_MCP_UI_META_KEY]: {
        icon: {
          kind: "semantic",
          name: "agent",
          fallbackGlyph: "@",
        },
        fields: {
          targetLabel: {
            kind: "agent-picker",
            selection: "single",
            sourceTool: "agents_search",
            resolveTool: "agents_resolve",
            valueField: "label",
            labelField: "label",
            descriptionField: "displayName",
          },
          mentionAgentIds: {
            kind: "agent-picker",
            selection: "multiple",
            sourceTool: "agents_search",
            valueField: "agentId",
          },
        },
      },
    });
    expect(askTool?._meta).toMatchObject({
      [SCOUT_MCP_UI_META_KEY]: {
        fields: {
          to: {
            kind: "agent-picker",
            selection: "single",
            sourceTool: "agents_search",
            resolveTool: "agents_resolve",
            valueField: "label",
          },
        },
      },
    });
    expect(sendTool?.inputSchema?.properties?.targetLabel?.description).toBe(
      "Scout agent handle to contact when a specific target is known, such as @talkie, or a saved situated target such as target:talkie or ⌖talkie. For fresh capability work prefer projectPath plus optional harness; do not guess generic handles like claude.main. Treat harness/model/profile as instance constraints, not the base agent identity.",
    );
    expect(askTool?.inputSchema?.properties?.to?.description).toContain(
      "Agent id, label",
    );
    expect(askTool?.inputSchema?.properties?.projectPath?.description).toContain(
      "when you do not have a specific agent in mind",
    );
  });

  test("surfaces broker-backed search results", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async (_senderId, currentDirectory) =>
        `sender:${currentDirectory}`,
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async ({ query }) => {
        const candidates: ScoutMcpAgentCandidate[] = [
          {
            agentId: "hudson.main",
            label: "@hudson",
            defaultLabel: "@hudson",
            displayName: "Hudson",
            handle: "hudson",
            selector: "hudson",
            defaultSelector: "hudson",
            state: "active",
            registrationKind: "broker",
            routable: true,
            harness: "codex",
            model: "gpt-5.5",
            workspace: "main",
            node: "mini",
            projectRoot: "/tmp/openscout-test",
            transport: "codex_app_server",
          },
        ];
        return candidates.filter(
          (candidate) => !query || candidate.label.includes(query),
        );
      },
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const whoami = await client.callTool({
      name: "whoami",
      arguments: { currentDirectory: "/worktree/app" },
    });
    expect(
      (whoami.structuredContent as { defaultSenderId: string }).defaultSenderId,
    ).toBe("sender:/worktree/app");

    const result = await client.callTool({
      name: "agents_search",
      arguments: { query: "hud" },
    });
    expect(
      (result.structuredContent as { candidates: Array<{ agentId: string }> })
        .candidates,
    ).toHaveLength(1);
    expect(
      (result.structuredContent as { candidates: Array<{ agentId: string }> })
        .candidates[0]?.agentId,
    ).toBe("hudson.main");
  });

  test("feedback_send files a note tagged as the mcp client with its sender", async () => {
    let received: Record<string, any> | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "hudson.main",
      submitFeedback: async (feedback) => {
        received = feedback as Record<string, any>;
        return { id: "report-1", status: "saved", localPath: "/tmp/report-1.json" };
      },
    });

    const result = await client.callTool({
      name: "feedback_send",
      arguments: { note: "  ask swallowed my flags  ", currentDirectory: "/worktree/app", localOnly: true },
    });

    expect(result.structuredContent).toEqual({
      id: "report-1",
      status: "saved",
      localPath: "/tmp/report-1.json",
    });
    expect(received?.message).toBe("ask swallowed my flags");
    expect(received?.client).toBe("mcp");
    expect(received?.diagnostics).toBe(false);
    expect(received?.localOnly).toBe(true);
    expect(received?.reporter?.agentId).toBe("hudson.main");
    expect(received?.reporter?.project).toBe("app");
  });

  test("feedback_send still files when the sender cannot be resolved", async () => {
    let received: Record<string, any> | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => {
        throw new Error("broker unreachable");
      },
      submitFeedback: async (feedback) => {
        received = feedback as Record<string, any>;
        return { id: "report-2", status: "uploaded", localPath: "/tmp/report-2.json" };
      },
    });

    const result = await client.callTool({
      name: "feedback_send",
      arguments: { note: "broker down again" },
    });

    expect(result.isError).toBeFalsy();
    expect(received?.message).toBe("broker down again");
    expect(received?.reporter?.agentId).toBeUndefined();
  });

  test("ask wraps the ScoutAskHandler primitive", async () => {
    let receivedAsk: ScoutAskCommand | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      scoutAskHandler: async (input) => {
        receivedAsk = input;
        return {
          ok: true,
          state: "queued",
          ids: {
            targetAgentId: "talkie.main",
            invocationId: "inv-1",
            flightId: "flt-1",
            workId: "work-1",
          },
        };
      },
    }, { OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test" });

    const result = await client.callTool({
      name: "ask",
      arguments: {
        to: "talkie",
        body: "How did you handle auth?",
        harness: "claude",
        placement: "background",
        workspace: "new_worktree",
        session: "new",
      },
    });

    expect(receivedAsk).toEqual({
      senderId: "operator.main",
      to: "talkie",
      body: "How did you handle auth?",
      harness: "claude",
      placement: "background",
      executionSource: { harness: "flag" },
      workspace: "new_worktree",
      session: "new",
      replyToSessionId: "019ddb1b-test-thread",
      replyMode: "notify",
      currentDirectory: "/tmp/openscout-test",
      source: "scout-mcp",
      aliasScope: undefined,
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      state: "queued",
      delivery: "none",
      notification: {
        method: "notifications/scout/reply",
        status: "not_scheduled",
      },
      ids: {
        targetAgentId: "talkie.main",
        invocationId: "inv-1",
        flightId: "flt-1",
        workId: "work-1",
      },
      followUrl: "http://scout.test/work/work-1",
      links: {
        follow: "http://scout.test/work/work-1",
        work: "http://scout.test/work/work-1",
        tail: "http://scout.test/follow?view=tail&flightId=flt-1&invocationId=inv-1&workId=work-1&targetAgentId=talkie.main",
      },
    });
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toBe(
      "Ask queued to talkie.main; flight flt-1; work work-1. MCP notification was not scheduled; use invocations_wait with flightId=flt-1. Follow the task: http://scout.test/work/work-1",
    );
  });

  test("ask resolves a project path without an agent label", async () => {
    let receivedAsk: ScoutAskCommand | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      scoutAskHandler: async (input) => {
        receivedAsk = input;
        return {
          ok: true,
          state: "queued",
          ids: {
            targetAgentId: "talkie.main",
            invocationId: "inv-1",
            flightId: "flt-1",
          },
        };
      },
    });

    const result = await client.callTool({
      name: "ask",
      arguments: {
        projectPath: "talkie",
        body: "How did you handle auth?",
      },
    });

    expect(receivedAsk).toEqual({
      senderId: "operator.main",
      projectPath: "/tmp/openscout-test/talkie",
      body: "How did you handle auth?",
      replyToSessionId: "019ddb1b-test-thread",
      replyMode: "notify",
      currentDirectory: "/tmp/openscout-test",
      source: "scout-mcp",
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      state: "queued",
      ids: {
        targetAgentId: "talkie.main",
        invocationId: "inv-1",
        flightId: "flt-1",
      },
    });
  });

  test("every tool on the setup allow list is annotated read-only", async () => {
    const { SCOUT_READ_ONLY_TOOLS } = await import("../setup/agent-guide.ts");
    const { client } = await connectTestServer({});
    const { tools } = await client.listTools();
    for (const name of SCOUT_READ_ONLY_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect({ name, readOnly: tool?.annotations?.readOnlyHint }).toEqual({ name, readOnly: true });
    }
  });

  test("server instructions teach cross-machine asks", async () => {
    const { client } = await connectTestServer({});
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("`on`");
    expect(instructions).toContain("ssh");
    const { tools } = await client.listTools();
    const ask = tools.find((tool) => tool.name === "ask");
    expect(ask?.description).toContain("another mesh machine");
    expect(Object.keys(ask?.inputSchema.properties ?? {})).toContain("on");
  });

  test("hosts_list returns each machine with its projects and the ask that starts work there", async () => {
    let receivedMachine: string | undefined = "unset";
    const { client } = await connectTestServer({
      loadMeshOverview: async (machine) => {
        receivedMachine = machine;
        return {
          howTo: "Start work on another machine with `scout ask --on`.",
          machines: [
            {
              host: "arts-mini", nodeId: "arts-mini-openscout", nodeName: "arts-mini", local: true,
              reach: "answering",
              activity: { agents: 3, working: 1, liveSessions: 2, runningWork: 1 },
              projects: { total: 1, truncated: false, items: [{ root: "/Users/art/dev/openscout", name: "openscout", agents: 3, liveSessions: 2 }] },
              startWork: "scout ask --on arts-mini --project /Users/art/dev/openscout --harness codex \"<brief>\"",
            },
            {
              host: "archie", nodeId: "archie-openscout", nodeName: "archie", local: false,
              reach: "answering",
              activity: { agents: 1, working: 0, liveSessions: 0, runningWork: 0 },
              projects: { total: 1, truncated: false, items: [{ root: "/home/arach/renders/arsenal-x", name: "arsenal-x", agents: 1, liveSessions: 0 }] },
              startWork: "scout ask --on archie --project /home/arach/renders/arsenal-x --harness codex \"<brief>\"",
            },
            { host: "hutch", nodeId: "hutch-openscout", nodeName: "hutch", local: false, reach: "no_answer", error: "no answer in 3s", next: "scout mesh doctor" },
          ],
        };
      },
    });

    const result = await client.callTool({ name: "hosts_list", arguments: {} });
    expect(receivedMachine).toBeUndefined();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("arts-mini (this machine): 1 working · 2 live sessions · projects: /Users/art/dev/openscout");
    expect(text).toContain("archie: quiet · projects: /home/arach/renders/arsenal-x");
    expect(text).toContain("hutch: no answer (no answer in 3s) · try `scout mesh doctor`");
    expect(result.structuredContent).toMatchObject({ machines: [{ host: "arts-mini" }, { host: "archie" }, { host: "hutch", reach: "no_answer" }] });
  });

  test("agents_search names the machine when the query is a machine, even with every card offline", async () => {
    const { client } = await connectTestServer({
      searchAgents: async () => [],
      loadMeshOverview: async (machine) => {
        if (machine !== "archie") throw new Error(`Unknown machine: ${machine}`);
        return {
          howTo: "",
          machines: [{
            host: "archie", nodeId: "archie-openscout", nodeName: "archie", local: false,
            reach: "answering",
            activity: { agents: 11, working: 0, liveSessions: 0, runningWork: 0 },
            projects: { total: 1, truncated: false, items: [{ root: "/home/arach/renders/arsenal-x", name: "arsenal-x", agents: 1, liveSessions: 0 }] },
            startWork: "scout ask --on archie --project /home/arach/renders/arsenal-x --harness codex \"<brief>\"",
          }],
        };
      },
    });

    const hit = await client.callTool({ name: "agents_search", arguments: { query: "archie" } });
    expect(hit.structuredContent).toMatchObject({ candidates: [], machine: { host: "archie", reach: "answering" } });

    const miss = await client.callTool({ name: "agents_search", arguments: { query: "talkie" } });
    expect((miss.structuredContent as Record<string, unknown>).machine).toBeUndefined();
  });

  test("ask with on routes to the named machine and keeps the path raw", async () => {
    let receivedAsk: ScoutAskCommand | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      scoutAskHandler: async (input) => {
        receivedAsk = input;
        return {
          ok: true,
          state: "queued",
          ids: { targetAgentId: "x.archie", invocationId: "inv-1", flightId: "flt-1" },
        };
      },
    });

    await client.callTool({
      name: "ask",
      arguments: {
        on: "archie",
        projectPath: "~/renders/arsenal-x",
        harness: "codex",
        body: "Build the arsenal.",
      },
    });

    expect(receivedAsk?.host).toBe("archie");
    expect(receivedAsk?.projectPath).toBe("~/renders/arsenal-x");
    expect(receivedAsk?.harness).toBe("codex");
  });

  test("ask schedules MCP reply notifications in opt-in notify mode", async () => {
    let receivedWaitOptions: unknown;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      resolveBrokerUrl: () => "http://broker.test",
      scoutAskHandler: async () => ({
        ok: true,
        state: "queued",
        ids: {
          targetAgentId: "talkie.main",
          conversationId: "dm.operator.talkie",
          messageId: "msg-1",
          invocationId: "inv-1",
          flightId: "flight-1",
        },
      }),
      getFlight: async () => ({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator.main",
        targetAgentId: "talkie.main",
        state: "running",
      }),
      waitForFlight: async (_baseUrl, _flightId, options) => {
        receivedWaitOptions = options;
        return {
          id: "flight-1",
          invocationId: "inv-1",
          requesterId: "operator.main",
          targetAgentId: "talkie.main",
          state: "completed",
          output: "talkie replied",
        };
      },
    }, {
      OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1",
    });

    const notificationPromise = new Promise<{
      params: {
        status: string;
        flightId: string;
        output: string | null;
        targetAgentId: string | null;
      };
    }>((resolve) => {
      client.setNotificationHandler(
        z.object({
          method: z.literal("notifications/scout/reply"),
          params: z
            .object({
              status: z.string(),
              flightId: z.string(),
              output: z.string().nullable(),
              targetAgentId: z.string().nullable(),
            })
            .catchall(z.unknown()),
        }),
        (notification) => resolve(notification),
      );
    });

    const result = await client.callTool({
      name: "ask",
      arguments: {
        to: "talkie",
        body: "Review this.",
        replyMode: "notify",
        timeoutSeconds: 1,
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      state: "queued",
      delivery: "mcp_notification",
      notification: {
        method: "notifications/scout/reply",
        status: "scheduled",
      },
      ids: {
        targetAgentId: "talkie.main",
        flightId: "flight-1",
      },
    });

    const notification = await notificationPromise;
    expect(notification.params.status).toBe("completed");
    expect(notification.params.flightId).toBe("flight-1");
    expect(notification.params.output).toBe("talkie replied");
    expect(notification.params.targetAgentId).toBe("talkie.main");
    expect(receivedWaitOptions).toMatchObject({ invocationId: "inv-1", signal: expect.any(AbortSignal) });
  });

  test("ask without replyMode defaults to notify and schedules the reply notification", async () => {
    let receivedAsk: ScoutAskCommand | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      resolveBrokerUrl: () => "http://broker.test",
      scoutAskHandler: async (input) => {
        receivedAsk = input;
        return {
          ok: true,
          state: "queued",
          ids: {
            targetAgentId: "talkie.main",
            conversationId: "dm.operator.talkie",
            messageId: "msg-1",
            invocationId: "inv-1",
            flightId: "flight-1",
          },
        };
      },
      getFlight: async () => ({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator.main",
        targetAgentId: "talkie.main",
        state: "running",
      }),
      waitForFlight: async () => ({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator.main",
        targetAgentId: "talkie.main",
        state: "completed",
        output: "talkie replied",
      }),
    }, {
      OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1",
    });

    const notificationPromise = new Promise<{ params: { status: string; flightId: string } }>((resolve) => {
      client.setNotificationHandler(
        z.object({
          method: z.literal("notifications/scout/reply"),
          params: z
            .object({ status: z.string(), flightId: z.string() })
            .catchall(z.unknown()),
        }),
        (notification) => resolve(notification),
      );
    });

    const result = await client.callTool({
      name: "ask",
      arguments: {
        to: "talkie",
        body: "Review this.",
      },
    });

    expect(receivedAsk?.replyMode).toBe("notify");
    expect(result.structuredContent).toMatchObject({
      ok: true,
      state: "queued",
      delivery: "mcp_notification",
      notification: {
        method: "notifications/scout/reply",
        status: "scheduled",
      },
      ids: {
        targetAgentId: "talkie.main",
        conversationId: "dm.operator.talkie",
        flightId: "flight-1",
      },
    });

    const notification = await notificationPromise;
    expect(notification.params.status).toBe("completed");
    expect(notification.params.flightId).toBe("flight-1");
  });

  test("ask keeps explicit replyMode none as an ids-only opt-out", async () => {
    let receivedAsk: ScoutAskCommand | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      scoutAskHandler: async (input) => {
        receivedAsk = input;
        return {
          ok: true,
          state: "queued",
          ids: { targetAgentId: "talkie.main", invocationId: "inv-1", flightId: "flight-1" },
        };
      },
    }, {
      OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1",
    });

    const result = await client.callTool({
      name: "ask",
      arguments: { to: "talkie", body: "Review this.", replyMode: "none" },
    });

    expect(receivedAsk?.replyMode).toBe("none");
    expect(result.structuredContent).toMatchObject({ ok: true, delivery: "none" });
  });

  test("ask does not schedule MCP reply notifications by default", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      resolveBrokerUrl: () => "http://broker.test",
      scoutAskHandler: async () => ({
        ok: true,
        state: "queued",
        ids: {
          targetAgentId: "talkie.main",
          conversationId: "dm.operator.talkie",
          messageId: "msg-1",
          invocationId: "inv-1",
          flightId: "flight-1",
        },
      }),
      getFlight: async () => {
        throw new Error("flight temporarily unavailable");
      },
      waitForFlight: async () => {
        throw new Error("notify mode should not inline wait");
      },
    });

    const result = await client.callTool({
      name: "ask",
      arguments: {
        to: "talkie",
        body: "Review this.",
        wait: true,
        replyMode: "notify",
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      state: "queued",
      delivery: "none",
      notification: {
        method: "notifications/scout/reply",
        status: "not_scheduled",
      },
      ids: {
        targetAgentId: "talkie.main",
        flightId: "flight-1",
      },
    });
  });

  test("ask surfaces a broker preflight failure as preflight_failed", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      resolveBrokerUrl: () => "http://broker.test",
      scoutAskHandler: async () => ({
        ok: false,
        state: "failed",
        ids: {},
        error: {
          code: "preflight_failed",
          message: "broker preflight failed: /v1/snapshot read failed (500); the broker is up — the request is safe to retry",
        },
      }),
    });

    const result = await client.callTool({
      name: "ask",
      arguments: {
        to: "talkie",
        body: "Review this.",
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      state: "failed",
      error: {
        code: "preflight_failed",
        message: "broker preflight failed: /v1/snapshot read failed (500); the broker is up — the request is safe to retry",
      },
    });
  });

  test("ask reports inline delivery when the caller waits", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator.main",
      resolveBrokerUrl: () => "http://broker.test",
      scoutAskHandler: async () => ({
        ok: true,
        state: "queued",
        ids: {
          targetAgentId: "talkie.main",
          invocationId: "inv-1",
          flightId: "flight-1",
        },
      }),
      waitForFlight: async () => ({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator.main",
        targetAgentId: "talkie.main",
        state: "completed",
      }),
    });

    const result = await client.callTool({
      name: "ask",
      arguments: {
        to: "talkie",
        body: "Review this.",
        wait: true,
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      state: "completed",
      delivery: "inline",
      ids: {
        targetAgentId: "talkie.main",
        flightId: "flight-1",
      },
    });
  });

  test("creates a reply-ready card from the current sender and directory", async () => {
    let receivedModel: string | undefined;
    let receivedOneTimeUse: boolean | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "scout.main.mini",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      createAgentCard: async ({
        projectPath,
        currentDirectory,
        createdById,
        agentName,
        model,
        oneTimeUse,
      }) => {
        receivedModel = model;
        receivedOneTimeUse = oneTimeUse;
        return {
        id: "scout-codex-reply.main.mini",
        agentId: "scout-codex-reply.main.mini",
        definitionId: agentName ?? "scout-codex-reply",
        displayName: "Scout Codex Reply",
        handle: "scout-codex-reply",
        defaultSelector: "@scout-codex-reply",
        projectRoot: projectPath,
        currentDirectory,
        harness: "codex",
        transport: "codex_app_server",
        createdAt: 123,
        createdById,
        brokerRegistered: true,
        inboxConversationId: "dm.scout-codex-reply.main.mini.scout.main.mini",
        returnAddress: {
          actorId: "scout-codex-reply.main.mini",
          handle: "scout-codex-reply",
          defaultSelector: "@scout-codex-reply",
          conversationId: "dm.scout-codex-reply.main.mini.scout.main.mini",
        },
        };
      },
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const result = await client.callTool({
      name: "card_create",
      arguments: {
        agentName: "scout-codex-reply",
        model: "gpt-5.4-mini",
      },
    });

    const structured = result.structuredContent as {
      senderId: string;
      currentDirectory: string;
      card: {
        agentId: string;
        projectRoot: string;
        createdById?: string;
        inboxConversationId?: string;
        returnAddress: { conversationId?: string };
      };
    };

    expect(structured.senderId).toBe("scout.main.mini");
    expect(structured.currentDirectory).toBe("/tmp/openscout-test");
    expect(structured.card.agentId).toBe("scout-codex-reply.main.mini");
    expect(structured.card.projectRoot).toBe("/tmp/openscout-test");
    expect(structured.card.createdById).toBe("scout.main.mini");
    expect(structured.card.inboxConversationId).toBe(
      "dm.scout-codex-reply.main.mini.scout.main.mini",
    );
    expect(structured.card.returnAddress.conversationId).toBe(
      "dm.scout-codex-reply.main.mini.scout.main.mini",
    );
    expect(receivedModel).toBe("gpt-5.4-mini");
    expect(receivedOneTimeUse).toBe(true);
  });

  test("starts a concrete local agent session for precise routing", async () => {
    let receivedStart:
      | {
          projectPath: string;
          agentName?: string;
          harness?: string;
          model?: string;
          currentDirectory: string;
        }
      | undefined;
    const { client } = await connectTestServer({
      startAgent: async (input) => {
        receivedStart = input;
        return {
          agentId: "openscout.main.claude",
          definitionId: input.agentName ?? "openscout",
          projectName: "openscout",
          projectRoot: input.projectPath,
          sessionId: "session-1",
          startedAt: 123,
          harness: input.harness ?? "claude",
          transport: "claude_stream_json",
          isOnline: true,
          source: "manual",
        };
      },
    });

    const result = await client.callTool({
      name: "agents_start",
      arguments: {
        targetLabel: "@openscout#claude?sonnet",
      },
    });

    const structured = result.structuredContent as {
      requestedLabel: string | null;
      agentName: string | null;
      harness: string | null;
      model: string | null;
      exactTargetAgentId: string;
      nextTargetLabel: string;
      agent: { agentId: string; isOnline: boolean };
    };

    expect(receivedStart).toEqual({
      projectPath: "/tmp/openscout-test",
      agentName: "openscout",
      harness: "claude",
      model: "sonnet",
      currentDirectory: "/tmp/openscout-test",
    });
    expect(structured.requestedLabel).toBe("@openscout#claude?sonnet");
    expect(structured.agentName).toBe("openscout");
    expect(structured.harness).toBe("claude");
    expect(structured.model).toBe("sonnet");
    expect(structured.exactTargetAgentId).toBe("openscout.main.claude");
    expect(structured.nextTargetLabel).toBe("@openscout#claude?sonnet");
    expect(structured.agent.isOnline).toBe(true);
  });

  test("acknowledges explicit ask-by-id flights without a completion wait", async () => {
    let receivedAsk:
      | {
          senderId: string;
          targetAgentId: string;
          replyToSessionId?: string;
          replyMode?: "inline" | "notify" | "none";
          currentDirectory: string;
          source?: string;
        }
      | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async ({
        senderId,
        targetAgentId,
        replyToSessionId,
        replyMode,
        currentDirectory,
        source,
      }) => {
        receivedAsk = {
          senderId,
          targetAgentId,
          replyToSessionId,
          replyMode,
          currentDirectory,
          source,
        };
        return {
          usedBroker: true,
          conversationId: "dm.operator.hudson",
          messageId: "msg-1",
          workItem: {
            id: "work-1",
            title: "Review the auth module",
            summary: "Tracked work",
            state: "working",
            acceptanceState: "pending",
            ownerId: "hudson.main",
            nextMoveOwnerId: "hudson.main",
            conversationId: "dm.operator.hudson",
            priority: "high",
          },
          flight: {
            id: "flight-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "hudson.main",
            state: "running",
          },
        };
      },
      waitForFlight: async () => {
        throw new Error("invocations_ask should not wait for completion");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Review the auth module",
        targetAgentId: "hudson.main",
        replyToSessionId: "codex-thread-explicit",
        awaitReply: true,
      },
    });

    const structured = result.structuredContent as {
      awaited: boolean;
      waitStatus: string;
      output: string | null;
      flight: { state: string } | null;
      flightId: string | null;
      targetAgentId: string | null;
      replyToSessionId: string | null;
      workId: string | null;
      workUrl: string | null;
      followUrl: string | null;
      links: { work: string | null; follow: string | null; tail: string | null; observe: string | null };
    };

    expect(receivedAsk).toEqual({
      senderId: "operator",
      targetAgentId: "hudson.main",
      replyToSessionId: "codex-thread-explicit",
      replyMode: "inline",
      currentDirectory: "/tmp/openscout-test",
      source: "scout-mcp",
    });
    expect(structured.awaited).toBe(true);
    expect(structured.waitStatus).toBe("acknowledged");
    expect(structured.output).toBe(null);
    expect(structured.flight?.state).toBe("running");
    expect(structured.flightId).toBe("flight-1");
    expect(structured.targetAgentId).toBe("hudson.main");
    expect(structured.replyToSessionId).toBe("codex-thread-explicit");
    expect(structured.workId).toBe("work-1");
    expect(structured.workUrl).toBe("http://scout.test/work/work-1");
    expect(structured.followUrl).toBe(structured.workUrl);
    expect(structured.links.follow).toBe(structured.workUrl);
    expect(structured.links.work).toBe(structured.workUrl);
    expect(structured.links.tail).toContain("/follow?view=tail");
    expect(structured.links.observe).toContain("/agents/hudson.main?tab=observe");
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toContain("Ask acknowledged running; use invocations_wait with flightId=flight-1.");
    expect(content?.[0]?.text).toContain("Follow the task: http://scout.test/work/work-1");
    expect(content?.[0]?.text).not.toContain("Scout tail:");
  });

  test("continues a specific target session without asking for a new one", async () => {
    let receivedAsk:
      | {
          targetSessionId: string;
          replyToSessionId?: string;
          replyMode?: "inline" | "notify" | "none";
          currentDirectory: string;
        }
      | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => {
        throw new Error("session target should not use askAgentById");
      },
      askSessionById: async ({
        targetSessionId,
        replyToSessionId,
        replyMode,
        currentDirectory,
      }) => {
        receivedAsk = { targetSessionId, replyToSessionId, replyMode, currentDirectory };
        return {
          usedBroker: true,
          conversationId: "dm.operator.hudson",
          messageId: "msg-1",
          flight: {
            id: "flight-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "hudson.main",
            state: "running",
          },
        };
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Keep going in this session.",
        targetSessionId: "codex-thread-target",
        replyMode: "none",
      },
    });

    const structured = result.structuredContent as {
      targetAgentId: string | null;
      targetSessionId: string | null;
      ids: { sessionId: string | null };
      followUrl: string | null;
    };

    expect(receivedAsk).toEqual({
      targetSessionId: "codex-thread-target",
      replyToSessionId: "019ddb1b-test-thread",
      replyMode: "none",
      currentDirectory: "/tmp/openscout-test",
    });
    expect(structured.targetAgentId).toBe("hudson.main");
    expect(structured.targetSessionId).toBe("codex-thread-target");
    expect(structured.ids.sessionId).toBe("codex-thread-target");
    expect(structured.followUrl).toBe(
      "http://scout.test/agents/hudson.main/sessions/codex-thread-target",
    );
  });

  test("schedules MCP reply notifications for opt-in notify-mode asks", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({
        usedBroker: true,
        conversationId: "dm.operator.hudson",
        messageId: "msg-1",
        flight: {
          id: "flight-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "hudson.main",
          state: "running",
        },
      }),
      waitForFlight: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          id: "flight-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "hudson.main",
          state: "completed",
          output: "hudson replied",
        };
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1",
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const notificationPromise = new Promise<{
      params: {
        status: string;
        flightId: string;
        output: string | null;
        senderId: string;
        targetAgentId: string | null;
        followUrl: string | null;
        links?: {
          follow: string | null;
          observe: string | null;
          tail: string | null;
        };
      };
    }>((resolve) => {
      client.setNotificationHandler(
        z.object({
          method: z.literal("notifications/scout/reply"),
          params: z
            .object({
              status: z.string(),
              flightId: z.string(),
              output: z.string().nullable(),
              senderId: z.string(),
              targetAgentId: z.string().nullable(),
              followUrl: z.string().nullable(),
              links: z
                .object({
                  follow: z.string().nullable(),
                  observe: z.string().nullable(),
                  tail: z.string().nullable(),
                })
                .optional(),
            })
            .catchall(z.unknown()),
        }),
        (notification) => resolve(notification),
      );
    });

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Review the auth module",
        targetAgentId: "hudson.main",
        replyMode: "notify",
      },
    });

    const structured = result.structuredContent as {
      awaited: boolean;
      replyMode: string;
      delivery: string;
      notification: { method: string; status: string } | null;
      output: string | null;
      flight: { state: string } | null;
    };

    expect(structured.awaited).toBe(false);
    expect(structured.replyMode).toBe("notify");
    expect(structured.delivery).toBe("mcp_notification");
    expect(structured.notification).toEqual({
      method: "notifications/scout/reply",
      status: "scheduled",
    });
    expect(structured.output).toBeNull();
    expect(structured.flight?.state).toBe("running");

    const notification = await notificationPromise;
    expect(notification.params.status).toBe("completed");
    expect(notification.params.flightId).toBe("flight-1");
    expect(notification.params.output).toBe("hudson replied");
    expect(notification.params.senderId).toBe("operator");
    expect(notification.params.targetAgentId).toBe("hudson.main");
    const observeUrl = "http://scout.test/agents/hudson.main?tab=observe";
    const tailUrl =
      "http://scout.test/follow?view=tail&flightId=flight-1&invocationId=inv-1&conversationId=dm.operator.hudson&targetAgentId=hudson.main";
    expect(notification.params.followUrl).toBe(observeUrl);
    expect(notification.params.links?.follow).toBe(notification.params.followUrl);
    expect(notification.params.links?.observe).toBe(observeUrl);
    expect(notification.params.links?.tail).toBe(tailUrl);
  });

  test("inline ask by exact target returns follow-up guidance when the caller wait elapses", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({
        usedBroker: true,
        conversationId: "dm.operator.hudson",
        messageId: "msg-1",
        flight: {
          id: "flight-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "hudson.main",
          state: "running",
        },
      }),
      getFlight: async () => ({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "hudson.main",
        state: "running",
        summary: "Still working",
      }),
      waitForFlight: async () => {
        throw new Error("Timed out waiting for flight flight-1.");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Review the auth module",
        targetAgentId: "hudson.main",
        replyMode: "inline",
        timeoutSeconds: 1,
      },
    });

    const structured = result.structuredContent as {
      awaited: boolean;
      waitStatus: string;
      output: string | null;
      flight: { state: string } | null;
      followUrl: string | null;
    };

    expect(structured.awaited).toBe(true);
    expect(structured.waitStatus).toBe("acknowledged");
    expect(structured.output).toBe(null);
    expect(structured.flight?.state).toBe("running");
    const observeUrl = "http://scout.test/agents/hudson.main?tab=observe";
    const tailUrl =
      "http://scout.test/follow?view=tail&flightId=flight-1&invocationId=inv-1&conversationId=dm.operator.hudson&targetAgentId=hudson.main";
    expect(structured.followUrl).toBe(observeUrl);
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toBe(
      `Ask acknowledged running; use invocations_wait with flightId=flight-1. Observe agent: ${observeUrl} Scout tail: ${tailUrl}`,
    );
  });

  test("inline ask by target label returns follow-up guidance when the caller wait elapses", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askAgentById: async () => ({ usedBroker: true }),
      askQuestion: async () => ({
        usedBroker: true,
        conversationId: "dm.operator.hudson",
        messageId: "msg-1",
        flight: {
          id: "flight-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "hudson.main",
          state: "running",
        },
      }),
      getFlight: async () => ({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "hudson.main",
        state: "running",
        summary: "Still working",
      }),
      waitForFlight: async () => {
        throw new Error("Timed out waiting for flight flight-1.");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Review the auth module",
        targetLabel: "@hudson",
        replyMode: "inline",
        timeoutSeconds: 1,
      },
    });

    const structured = result.structuredContent as {
      targetAgentId: string | null;
      targetLabel: string | null;
      waitStatus: string;
      followUrl: string | null;
    };

    expect(structured.targetAgentId).toBe("hudson.main");
    expect(structured.targetLabel).toBe("@hudson");
    expect(structured.waitStatus).toBe("acknowledged");
    const observeUrl = "http://scout.test/agents/hudson.main?tab=observe";
    const tailUrl =
      "http://scout.test/follow?view=tail&flightId=flight-1&invocationId=inv-1&conversationId=dm.operator.hudson&targetAgentId=hudson.main";
    expect(structured.followUrl).toBe(observeUrl);
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toBe(
      `Ask acknowledged running; use invocations_wait with flightId=flight-1. Observe agent: ${observeUrl} Scout tail: ${tailUrl}`,
    );
  });

  test("fetches a previously-created ask flight without waiting and shares its work ticket", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      getFlight: async () => ({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "hudson.main",
        state: "running",
        summary: "Reviewing auth module",
        metadata: { collaborationRecordId: "work-1" },
      }),
      getInvocationLifecycle: async (_baseUrl, invocationId) => ({
        invocationId,
        flightId: "flight-1",
        state: "running",
        targetAgentId: "hudson.main",
      }),
      waitForFlight: async () => {
        throw new Error("invocations_get should not wait");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "invocations_get",
      arguments: {
        flightId: "flight-1",
      },
    });

    const structured = result.structuredContent as {
      found: boolean;
      terminal: boolean;
      waitStatus: string;
      output: string | null;
      flight: { state: string } | null;
      lifecycle: { state?: string; targetAgentId?: string } | null;
      links: {
        follow: string | null;
        observe: string | null;
        tail: string | null;
      };
    };

    expect(structured.found).toBe(true);
    expect(structured.terminal).toBe(false);
    expect(structured.waitStatus).toBe("not_requested");
    expect(structured.output).toBe("Reviewing auth module");
    expect(structured.flight?.state).toBe("running");
    expect(structured.lifecycle?.state).toBe("running");
    const observeUrl = "http://scout.test/agents/hudson.main?tab=observe";
    const tailUrl =
      "http://scout.test/follow?view=tail&flightId=flight-1&invocationId=inv-1&workId=work-1&targetAgentId=hudson.main";
    expect(structured.links.follow).toBe("http://scout.test/work/work-1");
    expect(structured.links.observe).toBe(observeUrl);
    expect(structured.links.tail).toBe(tailUrl);
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toContain("Flight flight-1 is running.");
    expect(content?.[0]?.text).toContain("Follow the task: http://scout.test/work/work-1");
  });

  test("bounded wait returns the latest flight state when the caller wait elapses", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      getFlight: async () => ({
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "hudson.main",
        state: "running",
        summary: "Still working",
      }),
      getInvocationLifecycle: async (_baseUrl, invocationId) => ({
        invocationId,
        flightId: "flight-1",
        state: "running",
        targetAgentId: "hudson.main",
      }),
      waitForFlight: async () => {
        throw new Error("Timed out waiting for flight flight-1.");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "invocations_wait",
      arguments: {
        flightId: "flight-1",
        timeoutSeconds: 1,
      },
    });

    const structured = result.structuredContent as {
      found: boolean;
      terminal: boolean;
      waitStatus: string;
      output: string | null;
      flight: { state: string } | null;
      lifecycle: { state?: string; targetAgentId?: string } | null;
    };

    expect(structured.found).toBe(true);
    expect(structured.terminal).toBe(false);
    expect(structured.waitStatus).toBe("pending");
    expect(structured.output).toBe("Still working");
    expect(structured.flight?.state).toBe("running");
    expect(structured.lifecycle?.state).toBe("running");
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toContain("Flight flight-1 is still running.");
  });

  test("updates a work item through the dedicated MCP tool", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "hudson.main",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async ({ workId, actorId, state, summary }) => ({
        id: workId,
        title: "Review the auth module",
        summary: summary ?? null,
        state: state ?? "working",
        acceptanceState: "pending",
        ownerId: actorId,
        nextMoveOwnerId: actorId,
        conversationId: "dm.operator.hudson",
        priority: "normal",
      }),
      waitForFlight: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "work_update",
      arguments: {
        work: {
          workId: "work-1",
          state: "review",
          summary: "Ready for review",
        },
      },
    });

    const structured = result.structuredContent as {
      senderId: string;
      workId: string | null;
      workUrl: string | null;
      workItem: { state: string; summary: string | null } | null;
    };

    expect(structured.senderId).toBe("hudson.main");
    expect(structured.workId).toBe("work-1");
    expect(structured.workUrl).toBe("http://scout.test/work/work-1");
    expect(structured.workItem?.state).toBe("review");
    expect(structured.workItem?.summary).toBe("Ready for review");
  });

  test("routes a direct ask by label without whoami or agents_resolve preflight", async () => {
    const resolveSenderCalls: Array<{
      senderId: string | null | undefined;
      currentDirectory: string;
    }> = [];
    let receivedAsk:
      | {
          senderId: string;
          targetLabel: string;
          replyMode?: "inline" | "notify" | "none";
          currentDirectory: string;
          source?: string;
        }
      | undefined;
    const { client } = await connectTestServer(
      {
        resolveSenderId: async (senderId, currentDirectory) => {
          resolveSenderCalls.push({ senderId, currentDirectory });
          return "operator.main.mini";
        },
        resolveBrokerUrl: () => "http://broker.test",
        searchAgents: async () => {
          throw new Error("unexpected agents_search preflight");
        },
        resolveAgent: async () => {
          throw new Error("unexpected agents_resolve preflight");
        },
        sendMessage: async () => ({
          usedBroker: true,
          invokedTargets: [],
          unresolvedTargets: [],
        }),
        sendMessageToAgentIds: async () => ({
          usedBroker: true,
          invokedTargetIds: [],
          unresolvedTargetIds: [],
        }),
        askQuestion: async ({
          senderId,
          targetLabel,
          replyMode,
          currentDirectory,
          source,
        }) => {
          receivedAsk = { senderId, targetLabel, replyMode, currentDirectory, source };
          return {
            usedBroker: true,
            conversationId: "dm.operator.hudson",
            messageId: "msg-1",
            flight: {
              id: "flight-1",
              invocationId: "inv-1",
              requesterId: senderId,
              targetAgentId: "hudson.main",
              state: "running",
            },
          };
        },
        askAgentById: async () => {
          throw new Error("unexpected askAgentById path");
        },
        updateWorkItem: async () => {
          throw new Error("not used");
        },
        waitForFlight: async () => {
          throw new Error("not used");
        },
      },
      {
        OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
      },
    );

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Use the simplified Scout path. Do not call whoami or agents_resolve first.",
        targetLabel: "@hudson",
        replyMode: "none",
      },
    });

    const structured = result.structuredContent as {
      currentDirectory: string;
      senderId: string;
      targetAgentId: string | null;
      targetLabel: string | null;
      conversationId: string | null;
      messageId: string | null;
      flightId: string | null;
      delivery: string;
      followUrl: string | null;
      ids: {
        flightId: string | null;
        invocationId: string | null;
        conversationId: string | null;
        targetAgentId: string | null;
      };
      links: {
        follow: string | null;
        observe: string | null;
        tail: string | null;
        chat: string | null;
        agent: string | null;
      };
    };

    expect(resolveSenderCalls).toEqual([
      { senderId: "operator", currentDirectory: "/tmp/openscout-test" },
    ]);
    expect(receivedAsk).toEqual({
      senderId: "operator.main.mini",
      targetLabel: "@hudson",
      replyMode: "none",
      currentDirectory: "/tmp/openscout-test",
      source: "scout-mcp",
    });
    expect(structured.currentDirectory).toBe("/tmp/openscout-test");
    expect(structured.senderId).toBe("operator.main.mini");
    expect(structured.targetAgentId).toBe("hudson.main");
    expect(structured.targetLabel).toBe("@hudson");
    expect(structured.conversationId).toBe("dm.operator.hudson");
    expect(structured.messageId).toBe("msg-1");
    expect(structured.flightId).toBe("flight-1");
    expect(structured.delivery).toBe("none");
    expect(structured.ids).toMatchObject({
      flightId: "flight-1",
      invocationId: "inv-1",
      conversationId: "dm.operator.hudson",
      targetAgentId: "hudson.main",
    });
    const tailUrl =
      "http://scout.test/follow?view=tail&flightId=flight-1&invocationId=inv-1&conversationId=dm.operator.hudson&targetAgentId=hudson.main";
    const observeUrl = "http://scout.test/agents/hudson.main?tab=observe";
    expect(structured.followUrl).toBe(
      observeUrl,
    );
    expect(structured.links).toMatchObject({
      follow: structured.followUrl,
      observe: observeUrl,
      tail: tailUrl,
      chat: "http://scout.test/c/dm.operator.hudson",
      agent: "http://scout.test/agents/hudson.main?tab=message",
    });
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]).toEqual({
      type: "text",
      text: `Ask sent to hudson.main; flight flight-1. Observe agent: ${observeUrl} Scout tail: ${tailUrl}`,
    });
  });

  test("suggests agents_start when a precise ask target is unresolved", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-mcp-start-suggestion-"));
    tempPaths.add(tempRoot);
    mkdirSync(join(tempRoot, ".git"));
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async ({ targetLabel }) => ({
        usedBroker: true,
        unresolvedTarget: targetLabel,
      }),
      askAgentById: async () => {
        throw new Error("unexpected askAgentById path");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Have a new OpenScout Claude session review this.",
        targetLabel: "@openscout#claude?sonnet",
        currentDirectory: tempRoot,
      },
    });

    const structured = result.structuredContent as {
      unresolvedTargetLabel: string | null;
      startSuggestion: {
        tool: string;
        targetLabel: string | null;
        agentName: string | null;
        harness: string | null;
        model: string | null;
        projectPath: string;
      } | null;
    };
    const content = result.content as Array<{ type: string; text: string }> | undefined;

    expect(structured.unresolvedTargetLabel).toBe("@openscout#claude?sonnet");
    expect(structured.startSuggestion).toMatchObject({
      tool: "agents_start",
      targetLabel: "@openscout#claude?sonnet",
      agentName: "openscout",
      harness: "claude",
      model: "sonnet",
      projectPath: tempRoot,
    });
    expect(content?.[0]?.text).toContain(
      "Ask was not sent; unresolved target: @openscout#claude?sonnet.",
    );
    expect(content?.[0]?.text).toContain(
      "call agents_start with agentName=\"openscout\", harness=\"claude\", model=\"sonnet\"",
    );
  });

  test("blocks precise ask labels that resolve to a mismatched harness", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "resolved",
        candidate: {
          agentId: "openscout.main.codex",
          label: "@openscout.main",
          defaultLabel: "@openscout",
          displayName: "OpenScout",
          handle: "openscout",
          selector: "@openscout.main",
          defaultSelector: "@openscout",
          state: "idle",
          registrationKind: "configured",
          routable: true,
          harness: "codex",
          model: "gpt-5.4",
          workspace: "main",
          node: "mini",
          projectRoot: "/tmp/openscout-test",
          transport: "codex_app_server",
        },
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => {
        throw new Error("precise target mismatch should not route");
      },
      askAgentById: async () => {
        throw new Error("unexpected askAgentById path");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Have a new OpenScout Claude session review this.",
        targetLabel: "@openscout#claude?sonnet",
      },
    });

    const structured = result.structuredContent as {
      targetAgentId: string | null;
      unresolvedTargetLabel: string | null;
      targetDiagnostic: {
        kind?: string;
        resolvedCandidate?: { agentId: string; harness: string | null };
      } | null;
      startSuggestion: {
        agentName: string | null;
        harness: string | null;
        model: string | null;
      } | null;
    };
    const content = result.content as Array<{ type: string; text: string }> | undefined;

    expect(structured.targetAgentId).toBeNull();
    expect(structured.unresolvedTargetLabel).toBe("@openscout#claude?sonnet");
    expect(structured.targetDiagnostic).toMatchObject({
      kind: "target_constraint_mismatch",
      resolvedCandidate: {
        agentId: "openscout.main.codex",
        harness: "codex",
      },
    });
    expect(structured.startSuggestion).toMatchObject({
      agentName: "openscout",
      harness: "claude",
      model: "sonnet",
    });
    expect(content?.[0]?.text).toContain(
      "target constraints did not match any resolved agent",
    );
  });

  test("documents unresolved exact ask targets without inventing a start suggestion", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => {
        throw new Error("unexpected askQuestion path");
      },
      askAgentById: async ({ targetAgentId }) => ({
        usedBroker: true,
        unresolvedTargetId: targetAgentId,
      }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const result = await client.callTool({
      name: "invocations_ask",
      arguments: {
        body: "Review this.",
        targetAgentId: "ghost.main",
      },
    });

    const structured = result.structuredContent as {
      unresolvedTargetId: string | null;
      startSuggestion?: unknown;
      targetDiagnostic: {
        kind?: string;
        unresolvedTargetIds?: string[];
        startSuggestionAvailable?: boolean;
      } | null;
    };
    const content = result.content as Array<{ type: string; text: string }> | undefined;

    expect(structured.unresolvedTargetId).toBe("ghost.main");
    expect(structured.startSuggestion).toBeNull();
    expect(structured.targetDiagnostic).toMatchObject({
      kind: "exact_target_id_unresolved",
      unresolvedTargetIds: ["ghost.main"],
      startSuggestionAvailable: false,
    });
    expect(content?.[0]?.text).toContain(
      "Exact targetAgentId paths cannot infer agents_start arguments",
    );
  });

  test("documents unresolved explicit message target ids without a start suggestion", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: ["ghost.main", "missing.main"],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => {
        throw new Error("unexpected askAgentById path");
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const result = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Status update",
        targetAgentId: "ghost.main",
        mentionAgentIds: ["missing.main"],
      },
    });

    const structured = result.structuredContent as {
      unresolvedTargetIds: string[];
      startSuggestion?: unknown;
      targetDiagnostic: {
        kind?: string;
        unresolvedTargetIds?: string[];
        startSuggestionAvailable?: boolean;
      } | null;
    };
    const content = result.content as Array<{ type: string; text: string }> | undefined;

    expect(structured.unresolvedTargetIds).toEqual([
      "ghost.main",
      "missing.main",
    ]);
    expect(structured.startSuggestion).toBeNull();
    expect(structured.targetDiagnostic).toMatchObject({
      kind: "exact_target_ids_unresolved",
      unresolvedTargetIds: ["ghost.main", "missing.main"],
      startSuggestionAvailable: false,
    });
    expect(content?.[0]?.text).toContain(
      "Exact targetAgentId paths cannot infer agents_start arguments",
    );
  });

  test("documents unresolved wake target ids without a start suggestion", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async ({ targetAgentId }) => ({
        usedBroker: true,
        unresolvedTargetId: targetAgentId,
      }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const result = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Please process this when you can.",
        targetAgentId: "ghost.main",
        wake: true,
      },
    });

    const structured = result.structuredContent as {
      unresolvedTargetIds: string[];
      startSuggestion?: unknown;
      targetDiagnostic: {
        kind?: string;
        unresolvedTargetIds?: string[];
        startSuggestionAvailable?: boolean;
      } | null;
    };

    expect(structured.unresolvedTargetIds).toEqual(["ghost.main"]);
    expect(structured.startSuggestion).toBeNull();
    expect(structured.targetDiagnostic).toMatchObject({
      kind: "exact_target_id_unresolved",
      unresolvedTargetIds: ["ghost.main"],
      startSuggestionAvailable: false,
    });
  });

  test("sends to a target label in one MCP call", async () => {
    let receivedTargetLabel: string | undefined;
    let receivedSource: string | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async ({ targetLabel, source }) => {
        receivedTargetLabel = targetLabel;
        receivedSource = source;
        return {
          usedBroker: true,
          conversationId: "dm.operator.hudson",
          messageId: "msg-1",
          invokedTargets: ["hudson.main"],
          unresolvedTargets: [],
          routeKind: "dm",
        };
      },
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const result = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Take a look at the auth module.",
        targetLabel: "@hudson",
      },
    });

    const structured = result.structuredContent as {
      mode: string;
      conversationId: string | null;
      messageId: string | null;
      invokedTargetIds: string[];
      unresolvedTargetIds: string[];
      routeKind: string | null;
    };

    expect(receivedTargetLabel).toBe("@hudson");
    expect(receivedSource).toBe("scout-mcp");
    expect(structured.mode).toBe("target_label");
    expect(structured.conversationId).toBe("dm.operator.hudson");
    expect(structured.messageId).toBe("msg-1");
    expect(structured.invokedTargetIds).toEqual(["hudson.main"]);
    expect(structured.unresolvedTargetIds).toEqual([]);
    expect(structured.routeKind).toBe("dm");
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]).toEqual({
      type: "text",
      text: "Message sent to hudson.main in dm.operator.hudson (msg-1).",
    });
  });

  test("renders actionable advice for message routing errors", async () => {
    let nextRoutingError:
      | "missing_destination"
      | "multi_target_requires_explicit_channel" = "missing_destination";
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        invokedTargets: [],
        unresolvedTargets: [],
        routingError: nextRoutingError,
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    });

    const missingDestination = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Status update",
      },
    });
    let structured = missingDestination.structuredContent as {
      routingAdvice: { code: string; summary: string; nextAction: string } | null;
    };
    let content = missingDestination.content as Array<{ type: string; text: string }> | undefined;
    expect(structured.routingAdvice).toMatchObject({
      code: "missing_destination",
      summary: "no destination",
    });
    expect(content?.[0]?.text).toBe(
      "Message was not sent: no destination. Pass one targetAgentId or targetLabel for a DM, or pass channel for a group update.",
    );

    nextRoutingError = "multi_target_requires_explicit_channel";
    const multiTarget = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "@hudson @arc please coordinate",
      },
    });
    structured = multiTarget.structuredContent as {
      routingAdvice: { code: string; summary: string; nextAction: string } | null;
    };
    content = multiTarget.content as Array<{ type: string; text: string }> | undefined;
    expect(structured.routingAdvice).toMatchObject({
      code: "multi_target_requires_explicit_channel",
      summary: "multiple targets need an explicit channel",
    });
    expect(content?.[0]?.text).toBe(
      "Message was not sent: multiple targets need an explicit channel. Pass channel for group coordination, or send separate one-target DMs.",
    );
  });

  test("supports tell plus asynchronous wake from messages_send", async () => {
    let receivedWake: boolean | undefined;
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async ({ wake }) => {
        receivedWake = wake;
        return {
          usedBroker: true,
          conversationId: "dm.operator.hudson",
          messageId: "msg-1",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "hudson.main",
            state: "working",
          },
          invokedTargets: ["hudson.main"],
          unresolvedTargets: [],
          routeKind: "dm",
        };
      },
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Please process this when you can.",
        targetLabel: "@hudson",
        wake: true,
      },
    });

    const structured = result.structuredContent as {
      wake: boolean;
      flightId: string | null;
      followUrl: string | null;
      links: {
        follow: string | null;
        observe: string | null;
        tail: string | null;
      };
    };
    const content = result.content as Array<{ type: string; text: string }> | undefined;

    expect(receivedWake).toBe(true);
    expect(structured.wake).toBe(true);
    expect(structured.flightId).toBe("flt-1");
    const observeUrl = "http://scout.test/agents/hudson.main?tab=observe";
    const tailUrl =
      "http://scout.test/follow?view=tail&flightId=flt-1&invocationId=inv-1&conversationId=dm.operator.hudson&targetAgentId=hudson.main";
    expect(structured.followUrl).toBe(observeUrl);
    expect(structured.links.follow).toBe(structured.followUrl);
    expect(structured.links.observe).toBe(observeUrl);
    expect(structured.links.tail).toBe(tailUrl);
    expect(content?.[0]).toEqual({
      type: "text",
      text: `Message sent to hudson.main in dm.operator.hudson (msg-1). Wake queued as flt-1. Observe agent: ${observeUrl} Scout tail: ${tailUrl}`,
    });
  });

  test("surfaces broker-dispatched direct messages without requiring wake", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => ({
        usedBroker: true,
        conversationId: "dm.operator.hudson",
        messageId: "msg-1",
        flight: {
          id: "flt-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "hudson.main",
          state: "waking",
        },
        invokedTargets: ["hudson.main"],
        unresolvedTargets: [],
        routeKind: "dm",
      }),
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async () => ({ usedBroker: true }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Please process this when you can.",
        targetLabel: "@hudson",
      },
    });

    const structured = result.structuredContent as {
      wake: boolean;
      flightId: string | null;
      followUrl: string | null;
    };
    const content = result.content as Array<{ type: string; text: string }> | undefined;

    expect(structured.wake).toBe(false);
    expect(structured.flightId).toBe("flt-1");
    expect(structured.followUrl).toBe("http://scout.test/agents/hudson.main?tab=observe");
    expect(content?.[0]?.text).toContain(
      "Dispatch queued as flt-1. Observe agent: http://scout.test/agents/hudson.main?tab=observe Scout tail: http://scout.test/follow",
    );
  });

  test("returns follow links for explicit target wake messages", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({
        kind: "unresolved",
        candidate: null,
        candidates: [],
      }),
      sendMessage: async () => {
        throw new Error("wake with targetAgentId should use askAgentById");
      },
      sendMessageToAgentIds: async () => ({
        usedBroker: true,
        invokedTargetIds: [],
        unresolvedTargetIds: [],
      }),
      askQuestion: async () => ({ usedBroker: true }),
      askAgentById: async ({ targetAgentId }) => ({
        usedBroker: true,
        conversationId: "dm.operator.hudson",
        messageId: "msg-1",
        flight: {
          id: "flt-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId,
          state: "queued",
        },
      }),
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    }, {
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "http://scout.test",
    });

    const result = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Please process this when you can.",
        targetAgentId: "hudson.main",
        wake: true,
      },
    });

    const structured = result.structuredContent as {
      invokedTargetIds: string[];
      followUrl: string | null;
      ids: { flightId: string | null; targetAgentId: string | null };
    };

    expect(structured.invokedTargetIds).toEqual(["hudson.main"]);
    expect(structured.ids).toMatchObject({
      flightId: "flt-1",
      targetAgentId: "hudson.main",
    });
    expect(structured.followUrl).toBe(
      "http://scout.test/agents/hudson.main?tab=observe",
    );
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.[0]?.text).toContain(
      "Wake queued as flt-1. Observe agent: http://scout.test/agents/hudson.main?tab=observe Scout tail: http://scout.test/follow",
    );
  });

  test("uses the active broker reply agent as the default MCP sender", async () => {
    let receivedSenderId: string | null | undefined;
    let receivedMessageSenderId: string | undefined;
    const { client } = await connectTestServer(
      {
        resolveSenderId: async (senderId) => {
          receivedSenderId = senderId;
          return senderId?.trim() || "operator";
        },
        sendMessage: async ({ senderId }) => {
          receivedMessageSenderId = senderId;
          return {
            usedBroker: true,
            conversationId: "dm.openscout.talkie",
            messageId: "msg-1",
            invokedTargets: ["talkie.main.mini"],
            unresolvedTargets: [],
            routeKind: "dm",
          };
        },
        resolveBrokerUrl: () => "http://broker.test",
        searchAgents: async () => [],
        resolveAgent: async () => ({
          kind: "unresolved",
          candidate: null,
          candidates: [],
        }),
        sendMessageToAgentIds: async () => ({
          usedBroker: true,
          invokedTargetIds: [],
          unresolvedTargetIds: [],
        }),
        askQuestion: async () => ({ usedBroker: true }),
        askAgentById: async () => ({ usedBroker: true }),
        updateWorkItem: async () => {
          throw new Error("not used");
        },
        waitForFlight: async () => {
          throw new Error("not used");
        },
      },
      {
        OPENSCOUT_REPLY_CONTEXT: JSON.stringify({
          mode: "broker_reply",
          fromAgentId: "operator",
          toAgentId: "openscout-card-h-jsjh6n",
          conversationId: "dm.operator.openscout",
          messageId: "msg-request",
          replyToMessageId: "msg-request",
          replyPath: "final_response",
        }),
      },
    );

    await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Delegating this to Talkie.",
        targetLabel: "@talkie",
      },
    });

    expect(receivedSenderId).toBe("openscout-card-h-jsjh6n");
    expect(receivedMessageSenderId).toBe("openscout-card-h-jsjh6n");
  });

  test("preserves managed agent identity from the MCP environment", async () => {
    let receivedSenderId: string | null | undefined;
    let receivedMessageSenderId: string | undefined;
    const { client } = await connectTestServer(
      {
        resolveSenderId: async (senderId) => {
          receivedSenderId = senderId;
          return "ranger.main.mini";
        },
        sendMessage: async ({ senderId }) => {
          receivedMessageSenderId = senderId;
          return {
            usedBroker: true,
            conversationId: "dm.hudson.main.mini.ranger.main.mini",
            messageId: "msg-1",
            invokedTargets: ["hudson.main.mini"],
            unresolvedTargets: [],
            routeKind: "dm",
          };
        },
        resolveBrokerUrl: () => "http://broker.test",
        searchAgents: async () => [],
        resolveAgent: async () => ({
          kind: "unresolved",
          candidate: null,
          candidates: [],
        }),
        sendMessageToAgentIds: async () => ({
          usedBroker: true,
          invokedTargetIds: [],
          unresolvedTargetIds: [],
        }),
        askQuestion: async () => ({ usedBroker: true }),
        askAgentById: async () => ({ usedBroker: true }),
        updateWorkItem: async () => {
          throw new Error("not used");
        },
        waitForFlight: async () => {
          throw new Error("not used");
        },
      },
      {
        OPENSCOUT_AGENT: "ranger.main.mini",
      },
    );

    await client.callTool({
      name: "messages_send",
      arguments: {
        body: "Status update",
        targetLabel: "@hudson",
      },
    });

    expect(receivedSenderId).toBeUndefined();
    expect(receivedMessageSenderId).toBe("ranger.main.mini");
  });
});


test("disconnect cancels an unfinished MCP notification wait", async () => {
  let waitSignal: AbortSignal | undefined;
  let cancelled = false;
  const { client } = await connectTestServer({
    resolveSenderId: async () => "operator",
    resolveBrokerUrl: () => "http://broker.test",
    askAgentById: async () => ({
      usedBroker: true,
      conversationId: "dm.operator.worker",
      messageId: "msg-1",
      flight: { id: "flight-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "worker", state: "running" },
    }),
    waitForFlight: async (_url, _id, options) => {
      waitSignal = options?.signal;
      expect(options?.invocationId).toBe("inv-1");
      return new Promise((_resolve, reject) => {
        waitSignal?.addEventListener("abort", () => { cancelled = true; reject(waitSignal?.reason); }, { once: true });
      });
    },
  }, { OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1" });
  await client.callTool({ name: "invocations_ask", arguments: { body: "Review", targetAgentId: "worker", replyMode: "notify" } });
  expect(waitSignal?.aborted).toBe(false);
  await client.close();
  expect(waitSignal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
});

describe("messages_send interaction", () => {
  function sendDeps(calls: {
    sendMessage: Array<Record<string, unknown>>;
    sendMessageToAgentIds: Array<Record<string, unknown>>;
    askQuestion: Array<Record<string, unknown>>;
    askAgentById: Array<Record<string, unknown>>;
  }): Parameters<typeof createScoutMcpServer>[0]["dependencies"] {
    const flight = {
      id: "flt-1",
      invocationId: "inv-1",
      requesterId: "operator",
      targetAgentId: "hudson.main",
      state: "queued" as const,
    };
    return {
      resolveSenderId: async () => "operator",
      resolveBrokerUrl: () => "http://broker.test",
      searchAgents: async () => [],
      resolveAgent: async () => ({ kind: "unresolved", candidate: null, candidates: [] }),
      sendMessage: async (input) => {
        calls.sendMessage.push(input as Record<string, unknown>);
        return { usedBroker: true, invokedTargets: ["hudson.main"], unresolvedTargets: [], conversationId: "dm.hudson", messageId: "msg-1" };
      },
      sendMessageToAgentIds: async (input) => {
        calls.sendMessageToAgentIds.push(input as Record<string, unknown>);
        return { usedBroker: true, invokedTargetIds: ["hudson.main"], unresolvedTargetIds: [], conversationId: "dm.hudson", messageId: "msg-1" };
      },
      askQuestion: async (input) => {
        calls.askQuestion.push(input as Record<string, unknown>);
        return { usedBroker: true, flight, conversationId: "dm.hudson", messageId: "msg-2" };
      },
      askAgentById: async (input) => {
        calls.askAgentById.push(input as Record<string, unknown>);
        return { usedBroker: true, flight, conversationId: "dm.hudson", messageId: "msg-2" };
      },
      updateWorkItem: async () => {
        throw new Error("not used");
      },
      waitForFlight: async () => {
        throw new Error("not used");
      },
    };
  }

  function emptyCalls() {
    return { sendMessage: [], sendMessageToAgentIds: [], askQuestion: [], askAgentById: [] } as {
      sendMessage: Array<Record<string, unknown>>;
      sendMessageToAgentIds: Array<Record<string, unknown>>;
      askQuestion: Array<Record<string, unknown>>;
      askAgentById: Array<Record<string, unknown>>;
    };
  }

  test("a directed send stays message-only by default", async () => {
    const calls = emptyCalls();
    const { client } = await connectTestServer(sendDeps(calls));
    const result = await client.callTool({
      name: "messages_send",
      arguments: { body: "branch pushed", targetAgentId: "hudson.main" },
    });
    expect(result.isError).not.toBe(true);
    expect(calls.askAgentById).toHaveLength(0);
    expect(calls.sendMessageToAgentIds).toHaveLength(1);
    expect((result.structuredContent as { interaction?: string }).interaction).toBe("message");
  });

  test("interaction='work' with a targetAgentId is tracked work on the ask lifecycle", async () => {
    const calls = emptyCalls();
    const { client } = await connectTestServer(sendDeps(calls));
    const result = await client.callTool({
      name: "messages_send",
      arguments: { body: "run the sweep and report back", targetAgentId: "hudson.main", interaction: "work" },
    });
    expect(result.isError).not.toBe(true);
    expect(calls.sendMessageToAgentIds).toHaveLength(0);
    expect(calls.askAgentById).toHaveLength(1);
    expect(calls.askAgentById[0]).toMatchObject({
      targetAgentId: "hudson.main",
      replyMode: "notify",
      source: "scout-mcp-send",
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      interaction: "work",
      flightId: "flt-1",
      invocationId: "inv-1",
      replyMode: "notify",
      invokedTargetIds: ["hudson.main"],
      notification: { method: "notifications/scout/reply", status: "not_scheduled" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Tracked send to hudson.main");
  });

  test("interaction='work' with a targetLabel and replyMode='none' suppresses the callback", async () => {
    const calls = emptyCalls();
    const { client } = await connectTestServer(sendDeps(calls));
    const result = await client.callTool({
      name: "messages_send",
      arguments: { body: "nightly sweep", targetLabel: "hudson", interaction: "work", replyMode: "none" },
    });
    expect(result.isError).not.toBe(true);
    expect(calls.sendMessage).toHaveLength(0);
    expect(calls.askQuestion).toHaveLength(1);
    expect(calls.askQuestion[0]).toMatchObject({ targetLabel: "hudson", replyMode: "none" });
    expect((result.structuredContent as Record<string, unknown>).notification).toBeNull();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Completion notifications suppressed");
  });

  test("interaction='work' fails closed on message-only routes", async () => {
    const calls = emptyCalls();
    const { client } = await connectTestServer(sendDeps(calls));
    for (const args of [
      { body: "status", targetLabel: "hudson", channel: "triage" },
      { body: "status", targetAgentId: "hudson.main", mentionAgentIds: ["vox.main"] },
      { body: "[ask:flt-9] the answer", targetAgentId: "hudson.main" },
      { body: "done", targetLabel: "ref:7f3a9c21" },
      { body: "@hudson build passed" },
    ]) {
      const result = await client.callTool({
        name: "messages_send",
        arguments: { ...args, interaction: "work" },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("needs exactly one directed target");
    }
    expect(calls.askAgentById).toHaveLength(0);
    expect(calls.askQuestion).toHaveLength(0);
    expect(calls.sendMessage).toHaveLength(0);
    expect(calls.sendMessageToAgentIds).toHaveLength(0);
  });

  test("interaction='work' rejects conflicting targetAgentId and targetLabel", async () => {
    const calls = emptyCalls();
    const { client } = await connectTestServer(sendDeps(calls));
    const result = await client.callTool({
      name: "messages_send",
      arguments: {
        body: "completed result",
        targetAgentId: "hudson.main",
        targetLabel: "ref:7f3a9c21",
        interaction: "work",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("exactly one routing field");
    expect(calls.askAgentById).toHaveLength(0);
    expect(calls.askQuestion).toHaveLength(0);
  });

  test("replyMode without interaction='work' fails closed", async () => {
    const calls = emptyCalls();
    const { client } = await connectTestServer(sendDeps(calls));
    const result = await client.callTool({
      name: "messages_send",
      arguments: { body: "fyi", targetAgentId: "hudson.main", replyMode: "none" },
    });
    expect(result.isError).toBe(true);
    expect(calls.sendMessageToAgentIds).toHaveLength(0);
  });
});


describe("explicit completion MCP contract", () => {
  const identity = { invocationId: "inv-1", flightId: "flt-1", revision: 0 };
  const context = { mode: "broker_reply", fromAgentId: "parent", toAgentId: "worker",
    conversationId: "dm.test", messageId: "msg-1", replyToMessageId: "msg-1", replyPath: "mcp_reply", completion: identity };

  test("refreshes the revision on every context read and fails closed when unavailable", async () => {
    let revision = 4;
    let available = true;
    const { client } = await connectTestServer({
      resolveBrokerUrl: () => "http://broker.test",
      getFlight: async (baseUrl, flightId) => {
        expect(baseUrl).toBe("http://broker.test");
        expect(flightId).toBe("flt-1");
        return available ? { id: flightId, invocationId: "inv-1", requesterId: "parent", targetAgentId: "worker",
          state: "running", metadata: { completion: { version: 1, revision, obligations: [] } } } : null;
      },
    }, { OPENSCOUT_REPLY_CONTEXT: JSON.stringify(context) });
    expect((await client.callTool({ name: "current_reply_context", arguments: {} })).structuredContent)
      .toMatchObject({ active: true, context: { completion: { ...identity, revision: 4 } } });
    revision = 7;
    expect((await client.callTool({ name: "current_reply_context", arguments: {} })).structuredContent)
      .toMatchObject({ context: { completion: { ...identity, revision: 7 } } });
    available = false;
    const missing = await client.callTool({ name: "current_reply_context", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toBeUndefined();
  });

  test("does not reuse completion context for another invocation or worker", async () => {
    const { client } = await connectTestServer({
      resolveBrokerUrl: () => "http://broker.test",
      getFlight: async () => ({ id: "flt-1", invocationId: "inv-other", requesterId: "parent", targetAgentId: "worker",
        state: "running", metadata: { completion: { version: 1, revision: 3, obligations: [] } } }),
    }, { OPENSCOUT_REPLY_CONTEXT: JSON.stringify(context) });
    expect((await client.callTool({ name: "current_reply_context", arguments: {} })).isError).toBe(true);
  });

  test("preserves typed replies and requires retry identity before calling the broker", async () => {
    const replies: unknown[] = [];
    const { client } = await connectTestServer({
      resolveSenderId: async () => "worker",
      replyMessage: async (input) => {
        replies.push(input);
        return { usedBroker: true, conversationId: input.conversationId, messageId: "reply-1", notifiedActorIds: ["parent"] };
      },
    }, { OPENSCOUT_REPLY_CONTEXT: JSON.stringify(context) });
    const completion = { ...identity, revision: 3, kind: "progress" };
    const missing = await client.callTool({ name: "messages_reply", arguments: { body: "Still working", completion } });
    expect(missing.isError).toBe(true);
    expect(replies).toEqual([]);
    const result = await client.callTool({ name: "messages_reply", arguments: { body: "Still working", requestId: "progress-1", completion } });
    expect(result.isError).not.toBe(true);
    expect(replies).toEqual([expect.objectContaining({ requestId: "progress-1", completion, senderId: "worker",
      conversationId: "dm.test", replyToMessageId: "msg-1" })]);
  });

  test("typed replies never claim sent without a canonical broker receipt", async () => {
    const { client } = await connectTestServer({
      resolveSenderId: async () => "worker",
      replyMessage: async () => ({ usedBroker: false, notifiedActorIds: [] }),
    }, { OPENSCOUT_REPLY_CONTEXT: JSON.stringify(context) });
    const result = await client.callTool({ name: "messages_reply", arguments: {
      body: "Finished", requestId: "final-offline", completion: { ...identity, kind: "final" },
    } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("Reply sent");
    expect(result.structuredContent).toBeUndefined();
  });

  test("passes explicit ask and parent receipt metadata without stripping fields", async () => {
    const asks: ScoutAskCommand[] = [];
    const completion = { mode: "explicit" };
    const relation = { kind: "joined", parentFlightId: "parent-flight" };
    const { client } = await connectTestServer({
      resolveSenderId: async () => "worker",
      scoutAskHandler: async (command) => {
        asks.push(command);
        return { ok: true, state: "queued", ids: { flightId: "flt-child", invocationId: "inv-child" },
          completion: { version: 1, revision: 0, obligations: [], invocationId: "inv-child", flightId: "flt-child" }, parentCompletion: { flightId: "parent-flight", revision: 5 } };
      },
    });
    const missing = await client.callTool({ name: "ask", arguments: { to: "id:child", body: "Review", relation, replyMode: "none" } });
    expect(missing.isError).toBe(true);
    expect(asks).toEqual([]);
    expect((await client.callTool({ name: "ask", arguments: { to: "id:child", body: "Review", completion, replyMode: "none" } })).isError).toBe(true);
    expect(asks).toEqual([]);
    const result = await client.callTool({ name: "ask", arguments: { targetSessionId: "child-session", body: "Review",
      completion, relation, requestId: "child-1", replyMode: "none" } });
    expect(result.isError).not.toBe(true);
    expect(asks).toEqual([expect.objectContaining({ to: "session:child-session", requestId: "child-1", completion, relation })]);
    expect(result.structuredContent).toMatchObject({ completion: { version: 1, revision: 0, obligations: [] },
      parentCompletion: { flightId: "parent-flight", revision: 5 } });
  });
});
