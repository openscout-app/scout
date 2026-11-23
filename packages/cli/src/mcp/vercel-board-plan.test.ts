import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { VercelBoardPlanRequest } from "@openscout/protocol";
import { registerVercelBoardDispatcherTool, registerVercelBoardPlanTool } from "./vercel-board-plan.ts";
import { parseVercelBoardCommand, parseCredentialReference } from "../cli/commands/vercel-board.ts";

test("board_plan sends the plan as the resolved sender and says it is outward-facing", async () => {
  const server = new McpServer({ name: "test", version: "1" });
  const sent: VercelBoardPlanRequest[] = [];
  registerVercelBoardPlanTool(server, {
    resolveSender: async senderId => senderId ?? "agent.planner",
    plan: async request => { sent.push(request); return { connectionId: request.connectionId, channel: request.channel, conversationId: "conv-room", tasks: [{ taskId: "11", key: "a", state: "ready" }] }; },
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tool = (await client.listTools()).tools.find(entry => entry.name === "vercel_board_plan")!;
    expect(tool.description).toContain("OUTWARD-FACING");
    const result = await client.callTool({ name: "vercel_board_plan", arguments: {
      connectionId: "c1", channel: "work", planningTaskId: "work-1", requestId: "r1",
      tasks: [{ key: "a", text: "First" }, { text: "Second", needs: [{ key: "a" }] }],
    } });
    expect(result.structuredContent).toMatchObject({ senderId: "agent.planner", conversationId: "conv-room", tasks: [{ taskId: "11" }] });
    expect(sent).toEqual([{ connectionId: "c1", channel: "work", planningTaskId: "work-1", requestId: "r1", actorId: "agent.planner",
      tasks: [{ key: "a", text: "First" }, { text: "Second", needs: [{ key: "a" }] }] }]);
  } finally { await client.close(); await server.close(); }
});

test("scout board parses a credential reference and refuses anything else", () => {
  expect(parseCredentialReference("secret_cli:vercel-board")).toEqual({ backend: "secret_cli", key: "vercel-board" });
  expect(() => parseCredentialReference("vcp_abc123")).toThrow("never pass the token");
  const connect = parseVercelBoardCommand(["connect", "--url", "http://127.0.0.1:4000", "--credential", "env:VERCEL_BOARD_TOKEN", "--channels", "work, decisions", "--no-probe"]);
  expect(connect).toMatchObject({ kind: "connect", method: "POST", body: { url: "http://127.0.0.1:4000", credential: { backend: "env", key: "VERCEL_BOARD_TOKEN" }, channels: ["work", "decisions"], probe: false } });
  expect(parseVercelBoardCommand(["status", "--connection", "c 1"]).path).toBe("/v1/integrations/vercel-board/status?connection=c%201");
  expect(parseVercelBoardCommand(["claim", "--connection", "c1", "--task", "7", "--agent", "agent.dev"]).body).toMatchObject({ actorId: "operator", taskId: "7" });
  expect(() => parseVercelBoardCommand(["connect", "--url", "x", "--credential", "env:A", "--takeover"])).toThrow("Unknown or repeated option --takeover");
  expect(() => parseVercelBoardCommand(["claim", "--connection", "c1"])).toThrow("--task");
});

test("the dispatcher tool is read-only: it shows status or explains one task, and takes no settings", async () => {
  const server = new McpServer({ name: "test", version: "1" });
  const asked: string[] = [];
  registerVercelBoardDispatcherTool(server, {
    status: async connectionId => { asked.push(`status:${connectionId}`); return { connectionId, enabled: true, policy: "manual", channels: [], capabilities: {}, policies: {}, steps: [], wakes: { events: true, sweepMs: 5000 }, recent: [], claims: [], config: {} }; },
    explain: async (connectionId, taskId) => { asked.push(`explain:${connectionId}:${taskId}`); return { connectionId, decisions: [{ taskId, channel: "work", policy: "manual", outcome: "skip", step: "manual", reason: "manual", trail: [], at: 1 }] }; },
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tool = (await client.listTools()).tools.find(entry => entry.name === "vercel_board_dispatcher")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["connectionId", "taskId"]);
    expect((await client.callTool({ name: "vercel_board_dispatcher", arguments: { connectionId: "c1" } })).structuredContent).toMatchObject({ policy: "manual" });
    expect((await client.callTool({ name: "vercel_board_dispatcher", arguments: { connectionId: "c1", taskId: "7" } })).structuredContent).toMatchObject({ decisions: [{ taskId: "7", outcome: "skip" }] });
    expect(asked).toEqual(["status:c1", "explain:c1:7"]);
  } finally { await client.close(); await server.close(); }
});
