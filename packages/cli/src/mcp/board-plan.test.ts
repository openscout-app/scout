import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BoardPlanRequest } from "@openscout/protocol";
import { registerBoardPlanTool } from "./board-plan.ts";
import { parseBoardCommand, parseCredentialReference } from "../cli/commands/board.ts";

test("board_plan sends the plan as the resolved sender and says it is outward-facing", async () => {
  const server = new McpServer({ name: "test", version: "1" });
  const sent: BoardPlanRequest[] = [];
  registerBoardPlanTool(server, {
    resolveSender: async senderId => senderId ?? "agent.planner",
    plan: async request => { sent.push(request); return { connectionId: request.connectionId, channel: request.channel, tasks: [{ taskId: "11", workId: "board-work-x", key: "a", state: "ready" }] }; },
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tool = (await client.listTools()).tools.find(entry => entry.name === "board_plan")!;
    expect(tool.description).toContain("OUTWARD-FACING");
    const result = await client.callTool({ name: "board_plan", arguments: {
      connectionId: "c1", channel: "work", planningTaskId: "work-1", requestId: "r1",
      tasks: [{ key: "a", text: "First" }, { text: "Second", needs: [{ key: "a" }] }],
    } });
    expect(result.structuredContent).toMatchObject({ senderId: "agent.planner", tasks: [{ taskId: "11", workId: "board-work-x" }] });
    expect(sent).toEqual([{ connectionId: "c1", channel: "work", planningTaskId: "work-1", requestId: "r1", actorId: "agent.planner",
      tasks: [{ key: "a", text: "First" }, { text: "Second", needs: [{ key: "a" }] }] }]);
  } finally { await client.close(); await server.close(); }
});

test("scout board parses a credential reference and refuses anything else", () => {
  expect(parseCredentialReference("secret_cli:vercel-board")).toEqual({ backend: "secret_cli", key: "vercel-board" });
  expect(() => parseCredentialReference("vcp_abc123")).toThrow("never pass the token");
  const connect = parseBoardCommand(["connect", "--url", "http://127.0.0.1:4000", "--credential", "env:BOARD_TOKEN", "--channels", "work, decisions", "--no-probe"]);
  expect(connect).toMatchObject({ kind: "connect", method: "POST", body: { url: "http://127.0.0.1:4000", credential: { backend: "env", key: "BOARD_TOKEN" }, channels: ["work", "decisions"], probe: false } });
  expect(parseBoardCommand(["status", "--connection", "c 1"]).path).toBe("/v1/board/status?connection=c%201");
  expect(parseBoardCommand(["claim", "--connection", "c1", "--task", "7", "--agent", "agent.dev"]).body).toMatchObject({ actorId: "operator", taskId: "7" });
  expect(() => parseBoardCommand(["connect", "--url", "x", "--credential", "env:A", "--takeover"])).toThrow("--experimental-marker");
  expect(() => parseBoardCommand(["claim", "--connection", "c1"])).toThrow("--task");
});
