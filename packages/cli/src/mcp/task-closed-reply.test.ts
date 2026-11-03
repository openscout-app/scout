import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SCOUT_TASKS_CAPABILITY } from "@openscout/protocol";
import { runReplyCommand } from "../cli/commands/reply.ts";
import { createScoutCommandContext } from "../cli/context.ts";
import { createScoutMcpServer } from "./scout-mcp.ts";

test.each([
  ["already_answered", "task already has a final reply"],
  ["completed", "task is already completed"],
])("CLI and MCP replies retain the human task-closed detail: %s", async (reason, detail) => {
  const broker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (new URL(request.url).pathname === "/v1/node") return Response.json({ capabilities: [SCOUT_TASKS_CAPABILITY] });
    return Response.json({ error: "task_closed", taskId: "task", flightId: "flight", messageId: "answer", reason, detail }, { status: 409 });
  } });
  const previous = process.env.OPENSCOUT_BROKER_URL;
  process.env.OPENSCOUT_BROKER_URL = broker.url.origin;
  const server = createScoutMcpServer({ defaultCurrentDirectory: "/tmp", env: {},
    dependencies: { resolveSenderId: async () => "worker", resolveBrokerUrl: () => broker.url.origin } });
  const client = new Client({ name: "task-closed-reply", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    const context = createScoutCommandContext({ stdout: () => {}, stderr: () => {} });
    await expect(runReplyCommand(context, ["--as", "worker", "--ref", "task", "done"]))
      .rejects.toThrow(detail);
    await Promise.all([server.connect(b), client.connect(a)]);
    for (const route of [{}, { sessionId: "session", deliveryId: "delivery" }]) {
      const result = await client.callTool({ name: "reply", arguments: { ref: "task", body: "done", ...route } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(detail);
    }
  } finally {
    await client.close(); await server.close(); broker.stop(true);
    if (previous === undefined) delete process.env.OPENSCOUT_BROKER_URL;
    else process.env.OPENSCOUT_BROKER_URL = previous;
  }
});
