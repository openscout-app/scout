import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SCOUT_MCP_CORE_TOOL_NAMES } from "@openscout/protocol";
import { registerIntegrationTools } from "./integrations.ts";

test("local MCP tools delegate setup and status but reject authority and token inputs", async () => {
  const server = new McpServer({ name: "test", version: "1" });
  const calls: { path: string; body?: unknown }[] = [];
  registerIntegrationTools(server, async (path, init) => {
    calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return { readiness: "not_connected" };
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await client.callTool({ name: "integrations_setup", arguments: { provider: "slack", mode: "project_agent", projectPath: "/work/alpha" } });
    await client.callTool({ name: "integrations_get", arguments: { operationId: "a/b" } });
    expect(calls).toEqual([
      { path: "/v1/integrations/setup", body: { provider: "slack", mode: "project_agent", projectPath: "/work/alpha" } },
      { path: "/v1/integrations/setup/a%2Fb" },
    ]);
    const authority = await client.callTool({ name: "integrations_resume", arguments: { operationId: "op", action: "confirm_authority", expectedRevision: 1 } });
    expect(authority.isError).toBe(true);
    const tokens = await client.callTool({ name: "integrations_setup", arguments: { provider: "slack", mode: "project_agent", projectPath: "/work/alpha", token: "secret" } });
    expect(tokens.isError).toBe(true);
    expect(calls).toHaveLength(2);
    await client.callTool({ name: "integrations_verify", arguments: { operationId: "op", expectedRevision: 5 } });
    expect(calls.at(-1)).toEqual({ path: "/v1/integrations/setup/op/verify", body: { expectedRevision: 5 } });
    for (const { name } of (await client.listTools()).tools) expect(SCOUT_MCP_CORE_TOOL_NAMES as readonly string[]).not.toContain(name);
  } finally { await client.close(); await server.close(); }
});

test("Rex tools read the caller context per call and cannot launch without a session", async () => {
  const server = new McpServer({ name: "test", version: "1" });
  const calls: unknown[] = [];
  const context = { env: {} as NodeJS.ProcessEnv, defaultCurrentDirectory: "/project" };
  registerIntegrationTools(server, async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return { agentId: "exact-child" };
  }, context);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    expect((await client.callTool({ name: "rex_start_agent", arguments: { harness: "codex" } })).isError).toBe(true);
    context.env.REX_SESSION = "parent";
    expect((await client.callTool({ name: "rex_start_agent", arguments: { harness: "codex" } })).structuredContent).toEqual({ agentId: "exact-child" });
    await client.callTool({ name: "rex_status", arguments: { sessionId: "other", blockId: "child" } });
    expect(calls).toEqual([
      { path: "/v1/integrations/rex/start", body: { harness: "codex", sessionId: "parent", projectPath: "/project" } },
      { path: "/v1/integrations/rex/status", body: { sessionId: "other", blockId: "child" } },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
