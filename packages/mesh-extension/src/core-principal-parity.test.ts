import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SCOUT_MCP_CORE_TOOL_NAMES, type McpEventPrincipal } from "@openscout/protocol";
import { createScoutMcpServer } from "../../cli/src/mcp/scout-mcp.ts";
import { CoreHttpAdapter } from "./core-http-mcp.ts";
import { RuntimeHttpClient } from "./http-client.ts";

// Same valid request for both SDK surfaces. No tool may silently disappear.
const cases: Record<string, Record<string, unknown>> = {
  sessions_attach: { nativeSessionId: "native" }, sessions_get: { sessionId: "s" }, sessions_poll: { sessionId: "s" },
  sessions_ack: { sessionId: "s", deliveryId: "d" },
  whoami: {}, feedback_send: { note: "note", localOnly: true }, messages_inbox: {}, messages_channel: { channel: "room" },
  broker_feed: {}, tail_events: {}, current_reply_context: {}, reply: { body: "reply", to: "m" },
  agents_search: { query: "target" }, agents_resolve: { label: "target" }, ask: { to: "id:target", body: "work" },
  invocations_get: { flightId: "f" },
  invocations_wait: { flightId: "f", timeoutSeconds: 1 }, labels_brief: { label: "label" }, labels_feed: { label: "label" },
  work_update: { work: { workId: "w", state: "working" } },
};
const actorTools = new Set(["sessions_attach", "sessions_get", "sessions_poll", "sessions_ack", "whoami",
  "feedback_send", "messages_inbox", "broker_feed", "reply", "ask", "work_update"]);
function stdioIdentity(name: string, calls: any[], result: any): unknown {
  if (name === "whoami") return result.structuredContent?.defaultSenderId;
  const input = calls[0];
  if (name.startsWith("sessions_")) return input?.ownerId;
  if (name === "feedback_send") return input?.reporter?.agentId;
  if (name === "messages_inbox") return input?.participantId;
  if (name === "broker_feed") return input?.agentId;
  if (name === "work_update") return input?.actorId;
  return input?.senderId;
}
function httpIdentity(name: string, calls: any[], result: any): unknown {
  if (name === "whoami") return result.structuredContent?.defaultSenderId;
  if (name.startsWith("sessions_")) return calls[0]?.body?.ownerId;
  if (name === "feedback_send") return calls[0]?.body?.principal?.agentId;
  if (name === "messages_inbox") return calls[0]?.query?.participantId;
  if (name === "broker_feed") return calls[0]?.query?.agentId;
  if (name === "work_update") return calls.find(c => c.path === "/v1/collaboration/events")?.body?.actorId;
  if (name === "reply") return calls.find(c => c.path === "/v1/messages/reply")?.body?.senderId;
  return calls.find(c => c.path === "/v1/deliver")?.body?.caller?.actorId;
}
async function connect(server: any) {
  const client = new Client({ name: "principal-parity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return client;
}

test("all 20 core SDK tools retain authenticated identity across HTTP and relay-configured stdio", async () => {
  expect(Object.keys(cases).sort()).toEqual([...SCOUT_MCP_CORE_TOOL_NAMES].sort());
  for (const actor of ["principal-a", "principal-b"]) {
    const principal: McpEventPrincipal = { kind: actor === "principal-a" ? "oauth" : "agent_token", ...(actor === "principal-a" ? { userId: "user-a" } : {}), id: `identity-${actor}`, ownerKey: `owner-${actor}`, node: "fixture-node", agentId: actor };
    const httpCalls: any[] = [], stdioCalls: any[] = [];
    const snapshot = { agents: { target: { id: "target", displayName: "target" } }, actors: {},
      conversations: { c: { id: "c", participantIds: [actor, "target"], visibility: "private" } }, messages: { m: { id: "m", actorId: "target", conversationId: "c" } },
      flights: {}, collaborationRecords: { w: { id: "w", kind: "work_item", title: "Work", state: "open", ownerId: actor, nextMoveOwnerId: actor, createdById: actor, createdAt: 1, updatedAt: 1 } } };
    const reply = { usedBroker: true, conversationId: "c", messageId: "m", replyToMessageId: "m", notifiedActorIds: ["target"] };
    const broker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = request.method === "GET" ? { path: new URL(request.url).pathname } : await request.json(); stdioCalls.push(body); return Response.json({ sessionId: "s", ok: true });
    } });
    const origin = `http://127.0.0.1:${broker.port}`;
    const record = (result: any) => async (input: any) => { stdioCalls.push(input); return result; };
    const stdio = createScoutMcpServer({ defaultCurrentDirectory: "/fixture", env: { OPENSCOUT_BROKER_URL: origin, OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "0" },
      toolFilter: name => SCOUT_MCP_CORE_TOOL_NAMES.includes(name as never),
      // This is the same identity binding used by the relay's factory caller:
      // caller arguments never determine resolveSenderId's authenticated result.
      dependencies: {
        resolveSenderId: async () => actor, resolveBrokerUrl: () => origin,
        loadMessages: record([]), readBrokerFeed: record(null), readTailEvents: record({ events: [], limit: 80, cursor: null, generatedAt: 1 }),
        searchAgents: record([]), resolveAgent: record({ kind: "unresolved", candidate: null, candidates: [] }),
        submitFeedback: record({ id: "r", status: "saved", localPath: "/fixture/report" }),
        sendMessage: record({ usedBroker: true, invokedTargets: [], unresolvedTargets: [], messageId: "m", conversationId: "c" }),
        sendMessageToAgentIds: record({ usedBroker: true, invokedTargetIds: ["target"], unresolvedTargetIds: [] }), replyMessage: record(reply), replyTask: record(reply),
        scoutAskHandler: record({ ok: true, state: "queued", ids: {}, delivery: "none" }), updateWorkItem: record(null),
        getInvocationLifecycle: record(null), getFlight: record(null), waitForFlight: record({ id: "f", invocationId: "i", requesterId: actor, targetAgentId: "target", state: "completed" }),
        readLabelBrief: record(null), readLabelFeed: record(null),
      } as any,
    });
    const http = new CoreHttpAdapter({ principal, currentDirectory: "/fixture", client: new RuntimeHttpClient({ brokerUrl: origin, fetch: (async (input: any, init: any) => {
      const url = new URL(input), body = init.body ? JSON.parse(init.body) : undefined;
      httpCalls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const result = url.pathname === "/v1/snapshot" ? snapshot : url.pathname === "/v1/node" ? { nodeId: "fixture-node", capabilities: ["ask-reply/1"] }
        : url.pathname.endsWith("/collect") ? { id: "r", status: "saved" } : url.pathname === "/v1/messages" && !body ? []
        : url.pathname === "/v1/tail/recent" ? { events: [], limit: 80, cursor: null, generatedAt: 1 } : url.pathname === "/v1/deliver" ? { kind: "delivery", message: { id: "m" } } : { ok: true };
      return Response.json(result);
    }) as typeof fetch }) }).server();
    let stdioClient: Client | undefined, httpClient: Client | undefined;
    try {
      stdioClient = await connect(stdio); httpClient = await connect(http);
      for (const client of [stdioClient, httpClient]) expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual([...SCOUT_MCP_CORE_TOOL_NAMES].sort());
      for (const name of SCOUT_MCP_CORE_TOOL_NAMES) {
        stdioCalls.length = 0; httpCalls.length = 0;
        const a = await stdioClient.callTool({ name, arguments: cases[name] }, undefined, { timeout: 2_000 });
        const b = await httpClient.callTool({ name, arguments: cases[name] }, undefined, { timeout: 2_000 });
        expect({ name, transport: "stdio", error: a.isError, content: a.isError ? a.content : undefined }).toEqual({ name, transport: "stdio", error: undefined, content: undefined });
        expect({ name, transport: "http", error: b.isError }).toEqual({ name, transport: "http", error: undefined });
        if (actorTools.has(name)) {
          expect(stdioIdentity(name, stdioCalls, a), `${name} stdio binds ${actor}`).toBe(actor);
          expect(httpIdentity(name, httpCalls, b), `${name} HTTP binds ${actor}`).toBe(actor);
          if (name === "feedback_send") expect(httpCalls[0].body.principal).toEqual(principal);
        }
        // Local stdio is a trusted local API; the relay pins its resolver.
        // HTTP additionally rejects unknown fields and explicit mismatches.
        stdioCalls.length = 0; httpCalls.length = 0;
        const forged = await stdioClient.callTool({ name, arguments: { ...cases[name], senderId: "attacker", ownerId: "attacker", principal: { agentId: "attacker" } } }, undefined, { timeout: 2_000 });
        if (name === "ask" || name === "reply") {
          expect(forged.isError).toBe(true);
          expect(stdioCalls).toHaveLength(0);
        } else {
          expect(forged.isError, `${name} pinned stdio call`).not.toBe(true);
          if (actorTools.has(name)) expect(stdioIdentity(name, stdioCalls, forged), `${name} spoof cannot change stdio identity`).toBe(actor);
          expect(JSON.stringify({ calls: stdioCalls, result: forged })).not.toContain("attacker");
        }
        for (const identityOverride of [{ senderId: "attacker" }, { ownerId: "attacker" }, { principal: { ...principal, agentId: "attacker" } }]) {
          const refused = await httpClient.callTool({ name, arguments: { ...cases[name], ...identityOverride } }, undefined, { timeout: 2_000 });
          expect(refused.isError, `${name} HTTP refuses caller identity`).toBe(true);
          expect(httpCalls).toHaveLength(0);
        }
      }
    } finally { await stdioClient?.close(); await httpClient?.close(); await stdio.close(); await http.close(); broker.stop(true); }
  }
}, 15_000);
