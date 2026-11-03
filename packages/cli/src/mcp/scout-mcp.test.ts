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
import type { ScoutAskCommand } from "../lib/core/broker/ask-types.ts";

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

    expect(receivedAsk).toMatchObject({
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

    expect(receivedAsk).toMatchObject({
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
    const { SCOUT_READ_ONLY_TOOLS } = await import("../lib/core/setup/agent-guide.ts");
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

    expect(receivedAsk).toMatchObject({
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

    expect(receivedAsk).toMatchObject({
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
    expect(receivedAsk).toMatchObject({
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

test("pending reply subscriptions coalesce retries by canonical flight and release terminal ownership", async () => {
  const flight = { id: "retry-flight", invocationId: "retry-invocation", requesterId: "operator", targetAgentId: "worker", state: "running" as const };
  let waits = 0;
  let complete!: (flight: any) => void;
  let terminal = false;
  const { client } = await connectTestServer({
    resolveSenderId: async () => "operator",
    resolveBrokerUrl: () => "http://broker.test",
    askAgentById: async () => ({ usedBroker: true, conversationId: "conversation", messageId: "message", flight }),
    waitForFlight: async () => {
      waits++;
      if (terminal) return { ...flight, state: "completed", output: "late result" };
      return new Promise(resolve => { complete = resolve; });
    },
  }, { OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1" });
  const replies: unknown[] = [];
  client.setNotificationHandler(z.object({ method: z.literal("notifications/scout/reply"), params: z.any() }), note => { replies.push(note.params); });
  const retry = () => client.callTool({ name: "invocations_ask", arguments: { body: "Retry the same accepted work", targetAgentId: "worker", replyMode: "notify" } });
  for (let i = 0; i < 1000; i++) await retry();
  expect(waits).toBe(1);
  expect(replies).toHaveLength(0);
  terminal = true;
  complete({ ...flight, state: "completed", output: "late result" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ flightId: flight.id, status: "completed", output: "late result" });
  // Only active ownership is cached. A later terminal lookup can notify again;
  // the client does not accumulate a permanent deduplication history.
  await retry();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(waits).toBe(2);
  expect(replies).toHaveLength(2);
});

test("reply coalescing is per MCP server and disconnect cancels only its owned wait", async () => {
  const flight = { id: "shared-flight", invocationId: "shared-invocation", requesterId: "operator", targetAgentId: "worker", state: "running" as const };
  const signals: AbortSignal[] = [];
  let cancellations = 0;
  const dependencies = {
    resolveSenderId: async () => "operator",
    resolveBrokerUrl: () => "http://broker.test",
    askAgentById: async () => ({ usedBroker: true, conversationId: "conversation", messageId: "message", flight }),
    waitForFlight: async (_url: string, _id: string, options?: { signal?: AbortSignal }) => {
      const signal = options!.signal!;
      signals.push(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => { cancellations++; reject(signal.reason); }, { once: true });
      });
    },
  };
  const first = await connectTestServer(dependencies, { OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1" });
  const second = await connectTestServer(dependencies, { OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1" });
  for (let i = 0; i < 10; i++) {
    for (const { client } of [first, second]) await client.callTool({ name: "invocations_ask", arguments: { body: "still pending", targetAgentId: "worker", replyMode: "notify" } });
  }
  expect(signals).toHaveLength(2);
  await first.client.close();
  expect(cancellations).toBe(1);
  expect(signals.map(signal => signal.aborted)).toEqual([true, false]);
  await second.client.close();
  expect(cancellations).toBe(2);
});

describe("two-verb MCP contract", () => {
  test("registers only ask and reply for task sending; old tools have no definitions", async () => {
    const { client } = await connectTestServer({});
    const tools = (await client.listTools()).tools;
    for (const name of ["messages_send", "messages_reply", "sessions_reply", "notify_operator", "consult_operator"])
      expect(tools.some(tool => tool.name === name)).toBe(false);
    expect(tools.find(tool => tool.name === "ask")?.description).toContain("return on acceptance");
    expect(tools.find(tool => tool.name === "reply")?.description).toContain("first final wins");
    for (const word of ["fyi=true", "operator=true", "reply"]) expect(client.getInstructions()).toContain(word);
  });
  test.each([
    { to: "worker" },
    { operator: true },
    { operator: true, defaultAction: "staging", options: ["staging", "prod"], window: 60 },
    { operator: true, permission: true, because: "deploy blocked" },
    { operator: true, fyi: true },
    { operator: true, fyi: true, notify: true },
    { channel: "shared", fyi: true },
    { ref: "inv-parent" },
    { ref: "inv-parent", cancel: true },
    { continue: "inv-finished", harness: "codex", on: "build-host" },
    { to: "worker", fyi: true },
  ])("ask routes %# once with stable retry identity and never waits by default", async route => {
    const calls: ScoutAskCommand[] = [];
    const { client } = await connectTestServer({
      resolveSenderId: async () => "sender",
      scoutAskHandler: async command => { calls.push(command); return { ok: true, state: "queued", ids: { messageId: "msg", ...(!route.fyi ? { flightId: "flight" } : {}) } }; },
      waitForFlight: async () => { throw new Error("default must not wait"); },
    });
    const result = await client.callTool({ name: "ask", arguments: { ...route, requestId: "stable", body: "payload" } });
    expect(result.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ requestId: "stable", senderId: "sender", body: "payload", replyMode: "notify", task: { version: 1 } });
    for (const key of ["operator", "fyi", "ref", "continue", "cancel", "notify", "defaultAction", "options", "window", "permission", "because"] as const)
      if (key in route) expect((calls[0]!.task as any)[key]).toEqual((route as any)[key]);
  });
  test.each([
    { to: "worker", operator: true },
    { to: "worker", notify: true },
    { channel: "shared" },
    { operator: true, fyi: true, options: ["yes"] },
    { operator: true, defaultAction: "yes", permission: true },
    { ref: "task", harness: "codex" },
    { continue: "task", relation: { kind: "continuation", parentFlightId: "parent" }, requestId: "id" },
    { to: "worker", typo: true },
    { to: "worker", targetSessionId: "session" },
  ])("invalid ask %# never calls the broker", async route => {
    let calls = 0;
    const { client } = await connectTestServer({ resolveSenderId: async () => "sender",
      scoutAskHandler: async () => { calls++; throw new Error("must not dispatch"); } });
    const result = await client.callTool({ name: "ask", arguments: { ...route, body: "payload" } });
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });
  test.each([{ ref: "task" }, { ref: "task", progress: true }, { ref: "task", failed: true }, { to: "message" }])
    ("reply %# uses the canonical reply path", async flags => {
      const replies: unknown[] = [];
      const { client } = await connectTestServer({ resolveSenderId: async () => "worker",
        replyTask: async input => { replies.push(input); return { messageId: "answer" }; } });
      const result = await client.callTool({ name: "reply", arguments: { ...flags, body: "answer", requestId: "retry" } });
      expect(result.isError).not.toBe(true);
      expect(replies).toEqual([expect.objectContaining({ ...flags, body: "answer", requestId: "retry", senderId: "worker" })]);
    });
  test("reply validates route and outcome before dispatch and never reports success on broker failure", async () => {
    let calls = 0;
    const { client } = await connectTestServer({ resolveSenderId: async () => "worker",
      replyTask: async () => { calls++; throw new Error("canonical reply unavailable"); } });
    for (const flags of [{}, { ref: "task", to: "message" }, { ref: "task", progress: true, failed: true }, { to: "message", failed: true }])
      expect((await client.callTool({ name: "reply", arguments: { ...flags, body: "answer" } })).isError).toBe(true);
    expect(calls).toBe(0);
    const failed = await client.callTool({ name: "reply", arguments: { ref: "task", body: "answer", requestId: "retry" } });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain("canonical reply unavailable");
    expect(calls).toBe(1);
  });
});
