import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFlightCancelTool } from "./flight-cancel.ts";

test("MCP queued cancellation and running refusal use the broker result", async () => {
  const server = new McpServer({ name: "test", version: "1" });
  const calls: string[] = [];
  registerFlightCancelTool(server, async flightId => { calls.push(flightId); return flightId === "queued" ? { ok: true, flightId, state: "cancelled" } : { ok: false, flightId, code: "already_started", detail: "Already started; nothing cancelled" }; });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    expect((await client.callTool({ name: "flight_cancel", arguments: { flightId: "queued" } })).structuredContent).toMatchObject({ ok: true, state: "cancelled" });
    expect((await client.callTool({ name: "flight_cancel", arguments: { flightId: "running" } })).isError).toBe(true);
    expect(calls).toEqual(["queued", "running"]);
  } finally { await client.close(); await server.close(); }
});
