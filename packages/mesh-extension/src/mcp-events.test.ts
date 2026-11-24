import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createModernScoutHandler, deliverMcpEvent } from "./mcp-events.ts";
import type { McpEventDelivery, McpEventPrincipal } from "@openscout/protocol";

const principal: McpEventPrincipal = { kind: "oauth", id: "grant", userId: "github:1", ownerKey: "user:github:1", node: "default", agentId: "agent:a" };
export function modernRequest(method: string, params: Record<string, unknown> = {}, version = "2026-07-28") {
  return new Request("https://example.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version, "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }) });
}

test("official SDK serves stateless discovery, events and existing Scout tools", async () => {
  const legacy = new McpServer({ name: "scout", version: "test" });
  legacy.registerTool("whoami", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: principal.agentId }] }));
  const calls: Record<string, unknown>[] = [];
  const handler = await createModernScoutHandler(principal, legacy, async (body) => { calls.push(body); return { events: [{ name: "flight.completed" }] }; });
  try {
    const discovery = await handler.fetch(modernRequest("server/discover"));
    expect({ status: discovery.status, body: await discovery.clone().json() }).toMatchObject({ status: 200 });
    expect(await discovery.json()).toMatchObject({ result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/events": {} } } } });
    const events = await (await handler.fetch(modernRequest("events/list"))).json();
    expect(events).toMatchObject({ result: { events: [{ name: "flight.completed" }] } });
    const tool = await (await handler.fetch(modernRequest("tools/call", { name: "whoami", arguments: {} }))).json();
    expect(tool).toMatchObject({ result: { content: [{ type: "text", text: "agent:a" }] } });
    const catalog = await (await handler.fetch(modernRequest("tools/list"))).json();
    expect(catalog).toMatchObject({ result: { tools: [{ name: "whoami" }] } });
    expect(calls.every((call) => call.principal === principal)).toBe(true);
    const mismatch = modernRequest("events/list");
    mismatch.headers.set("mcp-protocol-version", "2099-01-01");
    expect((await handler.fetch(mismatch)).status).toBe(400);
  } finally { await handler.close(); }
});

test("revoked grants never send application data", async () => {
  let sent = 0;
  const job = { id: "sub_1:evt_1", principal, body: JSON.stringify({ eventId: "evt_1" }), secret: `whsec_${Buffer.alloc(32).toString("base64")}`, url: "https://example.com", subscriptionId: "sub_1" } as McpEventDelivery;
  expect(await deliverMcpEvent(job, async () => false, async () => { sent++; return { status: 200, body: "" }; })).toEqual({ status: 403, revoked: true });
  expect(sent).toBe(0);
  await deliverMcpEvent(job, async () => true, async (_url, body, headers) => {
    sent++; expect(headers["webhook-id"]).toBe(job.id); expect(body).toBe(job.body); return { status: 200, body: "" };
  });
  expect(sent).toBe(1);
  const body = JSON.stringify({ type: "terminated", error: { code: -32024, message: "Access revoked" } });
  await deliverMcpEvent(job, async () => false, async (_url, payload, headers) => {
    expect(payload).toBe(body);
    expect(headers["webhook-id"]).toBe("msg_terminated_1");
    return { status: 200, body: "" };
  }, async (delivery, revoked) => {
    expect(revoked).toBe(true);
    return { ...delivery, id: "msg_terminated_1", body };
  });
});

test("event lifecycle crosses the SDK facade, durable broker and signed delivery worker", async () => {
  const { BrokerMcpEvents } = await import("@openscout/runtime/client");
  const { Database } = await import("bun:sqlite");
  const { createHmac } = await import("node:crypto");
  const db = new Database(":memory:");
  const secret = `whsec_${Buffer.alloc(32, 3).toString("base64")}`;
  const verify = (body: string, headers: Record<string, string>) => {
    const digest = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64");
    expect(headers["webhook-signature"]).toBe(`v1,${digest}`);
    return JSON.parse(body);
  };
  const channel = { id: "channel:a", kind: "channel", participantIds: [principal.agentId] };
  const service = new BrokerMcpEvents(db, { flight: () => undefined, work: () => undefined, channel: () => channel as never }, {
    post: async (_url, body, headers) => {
      const verification = verify(body, headers) as { challenge: string };
      return { status: 200, body: JSON.stringify({ challenge: verification.challenge }) };
    },
  });
  const legacy = new McpServer({ name: "scout", version: "test" });
  const handler = await createModernScoutHandler(principal, legacy, async (call) => {
    expect(call.principal).toEqual(principal);
    if (call.method === "events/list") return service.list();
    if (call.method === "events/subscribe") return service.subscribe(principal, call.params);
    return service.unsubscribe(principal, call.params);
  });
  const params = { name: "message.created", arguments: { channel_id: "channel:a" }, delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret }, cursor: null };
  try {
    const accepted = await (await handler.fetch(modernRequest("events/subscribe", params))).json() as { result: { id: string } };
    expect(accepted.result.id).toStartWith("sub_");
    service.capture([{ kind: "message.record", message: { id: "msg_1", conversationId: channel.id, actorId: "writer", body: "hello café", visibility: "workspace", createdAt: Date.now() } } as never]);
    const job = service.claim(principal.ownerKey, principal.node)!;
    const result = await deliverMcpEvent(job, async () => true, async (_url, body, headers) => {
      expect(verify(body, headers)).toMatchObject({ eventId: JSON.parse(job.body).eventId, name: params.name, data: { text: "hello café" } });
      expect(headers["X-MCP-Subscription-Id"]).toBe(accepted.result.id);
      return { status: 200, body: "" };
    });
    service.settle(job.id, job.lease, result.status, result.revoked);
    const remove = { name: params.name, arguments: params.arguments, delivery: { url: params.delivery.url } };
    const mismatched = modernRequest("events/unsubscribe", remove);
    mismatched.headers.delete("mcp-name");
    const rejected = await handler.fetch(mismatched);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: -32020 } });
    const stopped = await (await handler.fetch(modernRequest("events/unsubscribe", remove))).json();
    expect(stopped).toMatchObject({ result: { resultType: "complete" } });
    service.capture([{ kind: "message.record", message: { id: "msg_2", conversationId: channel.id, actorId: "writer", body: "later", visibility: "workspace", createdAt: Date.now() } } as never]);
    expect(service.claim(principal.ownerKey, principal.node)).toBeNull();
  } finally { await handler.close(); db.close(); }
});
