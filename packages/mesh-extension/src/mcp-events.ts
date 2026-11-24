import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/core";
import { createMcpHandler, readRequestBody, Server, ProtocolError } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server as LegacyServer } from "@modelcontextprotocol/sdk/server/index.js";
import { RuntimeHttpClient } from "./http-client.ts";
import type { McpEventDelivery, McpEventPrincipal } from "@openscout/protocol";
import { McpEventError, postWebhook, webhookHeaders, type WebhookPost } from "@openscout/runtime/client";
import * as z from "zod/v4";

export type EventBrokerCall = (body: Record<string, unknown>) => Promise<unknown>;

/** The SDK owns the modern wire protocol; existing Scout tools retain their tested implementation. */
export async function createModernScoutHandler(principal: McpEventPrincipal, legacy: LegacyServer, broker: EventBrokerCall) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "scout-mcp-compatibility", version: "1.0.0" });
  await legacy.connect(serverTransport);
  await client.connect(clientTransport);
  const handler = createMcpHandler(async () => {
    // Refuse discovery while the broker feature is unavailable instead of advertising partial support.
    await broker({ operation: "rpc", principal, method: "events/list", params: {} });
    // Keep the original webhook discovery key for clients using the earlier contract.
    const capabilities = { tools: {}, events: {}, extensions: { "io.modelcontextprotocol/events": {} } };
    const server = new Server({ name: "openscout", version: "0.3.1" }, {
      capabilities,
      supportedProtocolVersions: ["2026-07-28"],
    });
    server.setRequestHandler("tools/list", async (request, ctx) => ListToolsResultSchema.parse(await client.listTools(request.params, { signal: ctx.mcpReq.signal })));
    server.setRequestHandler("tools/call", async (request, ctx) => CallToolResultSchema.parse(await client.callTool(request.params, undefined, { signal: ctx.mcpReq.signal })));
    for (const method of ["events/list", "events/subscribe", "events/unsubscribe", "events/poll", "events/stream"]) {
      server.setRequestHandler(method, { params: z.record(z.string(), z.unknown()) }, async (params) => {
        try { return await broker({ operation: "rpc", principal, method, params }) as Record<string, unknown>; }
        catch (error) {
          if (error instanceof McpEventError) throw new ProtocolError(error.code, error.message, error.data);
          throw new ProtocolError(-32603, "Scout event service is unavailable");
        }
      });
    }
    return server;
  }, { legacy: "reject", responseMode: "json", maxSubscriptions: 0, maxRequestBodySize: 256 * 1024 });
  // SDK 2.3 checks core routing headers. SEP-3415 also binds Mcp-Name to the event name.
  async function fetchEventRequest(request: Request) {
    const method = request.headers.get("mcp-method");
    if (!["events/poll", "events/stream", "events/subscribe", "events/unsubscribe"].includes(method ?? "")) return handler.fetch(request);
    const body = await readRequestBody(request, 256 * 1024);
    if (body.tooLarge) return new Response(null, { status: 413 });
    let rpc;
    try { rpc = JSON.parse(body.text); }
    catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, { status: 400 }); }
    if (rpc?.method === method && typeof rpc.params?.name === "string" && request.headers.get("mcp-name") !== rpc.params.name) {
      return Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32020, message: "Mcp-Name must match the event name" } }, { status: 400 });
    }
    return handler.fetch(request, { parsedBody: rpc });
  }
  return { fetch: fetchEventRequest, async close() { await handler.close(); await client.close(); await legacy.close(); } };
}

export function eventBrokerClient(client: RuntimeHttpClient): EventBrokerCall {
  return async body => {
    const payload = await client.request('/v1/mcp-events', body);
    if (payload.error) throw new McpEventError(payload.error.code ?? -32603, payload.error.message ?? 'Scout event service error', payload.error.data);
    return payload.result;
  };
}

export async function deliverMcpEvent(job: McpEventDelivery, authorize: (principal: McpEventPrincipal) => Promise<boolean>, post: WebhookPost = postWebhook, prepare: (job: McpEventDelivery, revoked: boolean) => Promise<McpEventDelivery | null> = async (job, revoked) => revoked ? null : job) {
  const revoked = !await authorize(job.principal);
  const current = await prepare(job, revoked);
  // A bridge can briefly run ahead of the runtime during an upgrade.
  if (revoked && (!current || JSON.parse(current.body).type !== "terminated")) return { status: 403, revoked: true };
  if (!current) return { status: 0, revoked: false };
  const response = await post(current.url, current.body, webhookHeaders(current.id, current.subscriptionId, current.body, current.secret, current.previousSecret));
  return { status: response.status, revoked: false };
}

/** One leased job at a time. A crashed worker leaves a recoverable broker lease. */
export function startMcpEventDeliveryWorker(options: { relayUrl: string; token: string; broker: EventBrokerCall; log: (message: string) => void }) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const check = async (principal?: McpEventPrincipal) => {
    const url = new URL(options.relayUrl);
    url.pathname = "/v1/mcp/events/authorize";
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ principal }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Event authorization check unavailable");
    return await response.json() as { ownerKey: string; node: string; authorized: boolean };
  };
  let scope: { ownerKey: string; node: string } | undefined;
  let failed = false;
  const tick = async () => {
    if (closed) return;
    try {
      scope ??= await check();
      const job = await options.broker({ operation: "claim", ownerKey: scope.ownerKey, node: scope.node }) as McpEventDelivery | null;
      if (job && !closed) {
        let result: { status: number; revoked: boolean };
        try {
          result = await deliverMcpEvent(job, async (p) => (await check(p)).authorized, postWebhook,
            async (_, revoked) => closed ? null : await options.broker({ operation: "prepare", id: job.id, lease: job.lease, ...(revoked ? { revoked } : {}) }) as McpEventDelivery | null);
        }
        catch { result = { status: 503, revoked: false }; }
        await options.broker({ operation: "settle", id: job.id, lease: job.lease, ...result });
      }
      failed = false;
    } catch {
      if (!failed) options.log("bridge: MCP event delivery unavailable; retained jobs will retry");
      failed = true; scope = undefined;
    }
    if (!closed) timer = setTimeout(() => { active = tick(); }, failed ? 10_000 : 1000);
  };
  active = tick();
  return { async close() { closed = true; clearTimeout(timer); await active; } };
}
