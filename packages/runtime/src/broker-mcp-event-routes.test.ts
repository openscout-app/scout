import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { handleBrokerMcpEvents } from "./broker-mcp-event-routes.js";
import type { BrokerMcpEvents } from "./broker-mcp-events.js";
import type { RuntimeRequestTransportContext } from "./portable-types.js";

async function call(context: RuntimeRequestTransportContext | undefined, body: unknown, events?: BrokerMcpEvents) {
  const request = Object.assign(new PassThrough(), { headers: { "content-type": "application/json" }, transportContext: context });
  let status = 0; let payload = "";
  const response = { writeHead(code: number) { status = code; }, end(data: string) { payload = data; } };
  const handled = handleBrokerMcpEvents(request as never, response as never, events);
  request.end(JSON.stringify(body)); await handled;
  return { status, payload: JSON.parse(payload) };
}

test("event administration is local-only even with otherwise privileged peer/guest identities", async () => {
  for (const context of [undefined, { transport: "remote", peer: { keyId: "k", tier: "control" } }, { transport: "loopback", guest: { keyId: "g", grantId: "g" } }, { transport: "loopback", scoped: {} }]) {
    expect((await call(context as RuntimeRequestTransportContext, {})).status).toBe(403);
  }
  expect((await call({ transport: "loopback" }, {})).status).toBe(503);
});

test("local event calls validate principal and translate schema failures without reflecting secrets", async () => {
  const events = { list: () => ({ events: [] }) } as unknown as BrokerMcpEvents;
  const principal = { kind: "agent_token", id: "t", ownerKey: "owner:a", node: "default", agentId: "agent:a" };
  expect(await call({ transport: "unix-socket" }, { operation: "rpc", principal, method: "events/list", params: {} }, events))
    .toEqual({ status: 200, payload: { result: { events: [] } } });
  const unavailableMode = await call({ transport: "loopback" }, { operation: "rpc", principal, method: "events/poll", params: { name: "flight.completed" } },
    { list: () => ({ events: [{ name: "flight.completed" }] }) } as unknown as BrokerMcpEvents);
  expect(unavailableMode.payload.error).toMatchObject({ code: -32026, data: { feature: "deliveryMode", value: "poll" } });
  const invalid = await call({ transport: "loopback" }, { operation: "rpc", principal: { ...principal, secret: "do-not-reflect" }, method: "events/list" }, events);
  expect(invalid.payload.error.code).toBe(-32602);
  expect(JSON.stringify(invalid)).not.toContain("do-not-reflect");
});
