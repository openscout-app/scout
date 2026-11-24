import { z } from "zod";
import type { BrokerMcpEvents } from "./broker-mcp-events.js";
import { mcpEventPrincipalSchema } from "./broker-mcp-events.js";
import { McpEventError } from "./mcp-event-webhook.js";
import { json, readRequestBody } from "./broker-http-helpers.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

export async function handleBrokerMcpEvents(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike, events?: BrokerMcpEvents) {
  if (!request.transportContext || request.transportContext.transport === "remote" || request.transportContext.guest || request.transportContext.scoped) {
    json(response, 403, { error: "local_bridge_required" }); return;
  }
  if (!events) { json(response, 503, { error: "mcp_events_disabled" }); return; }
  try {
    const body = z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("rpc"), principal: mcpEventPrincipalSchema,
        method: z.enum(["events/list", "events/subscribe", "events/unsubscribe", "events/poll", "events/stream"]), params: z.unknown() }).strict(),
      z.object({ operation: z.literal("prepare"), id: z.string().min(1), lease: z.string().min(1), revoked: z.boolean().optional() }).strict(),
      z.object({ operation: z.literal("claim"), ownerKey: z.string().min(1), node: z.string().min(1) }).strict(),
      z.object({ operation: z.literal("settle"), id: z.string().min(1), lease: z.string().min(1), status: z.number().int(), revoked: z.boolean().optional() }).strict(),
    ]).parse(await readRequestBody(request));
    let result: unknown;
    if (body.operation === "prepare") result = events.prepare(body.id, body.lease, body.revoked);
    else if (body.operation === "claim") result = events.claim(body.ownerKey, body.node);
    else if (body.operation === "settle") result = events.settle(body.id, body.lease, body.status, body.revoked);
    else if (body.method === "events/list") result = events.list();
    else if (body.method === "events/subscribe") result = await events.subscribe(body.principal, body.params);
    else if (body.method === "events/unsubscribe") result = await events.unsubscribe(body.principal, body.params);
    else {
      const { name } = z.object({ name: z.string() }).parse(body.params);
      if (!events.list().events.some(event => event.name === name)) throw new McpEventError(-32023, "Unknown event", { kind: "event" });
      throw new McpEventError(-32026, "This event supports webhook delivery", { feature: "deliveryMode", value: body.method === "events/poll" ? "poll" : "push" });
    }
    json(response, 200, { result });
  } catch (error) {
    if (error instanceof McpEventError) { json(response, 200, { error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } }); return; }
    if (error instanceof z.ZodError) { json(response, 200, { error: { code: -32602, message: "Invalid MCP event request" } }); return; }
    // Do not reflect URLs or signing secrets from transport/database exceptions.
    json(response, 503, { error: "mcp_events_unavailable" });
  }
}
