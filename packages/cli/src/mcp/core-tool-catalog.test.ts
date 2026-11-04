import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SCOUT_MCP_CORE_TOOL_CATALOG } from "@openscout/protocol";
import portableTools from "../../../mesh-extension/src/core-tools.json";

import { createScoutMcpServer } from "./scout-mcp.ts";
import { SCOUT_MCP_CORE_TOOLS } from "./mesh-bridge.ts";

// The hosted gateway's directory listing and docs are generated from the
// protocol catalog, so it must describe exactly what the bridge serves.
test("mcp:core catalog matches the tools the hosted bridge registers", async () => {
  const server = createScoutMcpServer({
    defaultCurrentDirectory: "/tmp",
    env: {},
    toolFilter: (name) => (SCOUT_MCP_CORE_TOOLS as readonly string[]).includes(name),
  });
  const client = new Client({ name: "core-catalog-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const registered = new Map(tools.map((tool) => [tool.name, tool]));

    expect([...registered.keys()].sort()).toEqual(SCOUT_MCP_CORE_TOOL_CATALOG.map((tool) => tool.name).sort());
    for (const entry of SCOUT_MCP_CORE_TOOL_CATALOG) {
      const tool = registered.get(entry.name)!;
      const portable = portableTools.find(candidate => candidate.name === entry.name)!;
      expect(portable.description).toBe(tool.description ?? "");
      expect({ name: entry.name, title: tool.title }).toEqual({ name: entry.name, title: entry.title });
      expect({ name: entry.name, readOnly: tool.annotations?.readOnlyHint === true })
        .toEqual({ name: entry.name, readOnly: entry.access === "read" });
      expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
      expect(entry.name.length).toBeLessThanOrEqual(64);
    }
    const ask = registered.get("ask")!;
    const portableAsk = portableTools.find(tool => tool.name === "ask")!;
    expect(ask.inputSchema).toMatchObject({ properties: { on: { description: portableAsk.inputSchema.properties.on!.description } } });
    expect(portableAsk.inputSchema.properties.on!.description).toContain("e.g. build-host");
  } finally {
    await client.close();
    await server.close();
  }
});

test("hosted tier descriptions never point at tools it does not expose", async () => {
  const server = createScoutMcpServer({
    defaultCurrentDirectory: "/tmp",
    env: {},
    toolFilter: (name) => (SCOUT_MCP_CORE_TOOLS as readonly string[]).includes(name),
  });
  const client = new Client({ name: "core-description-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const exposed = new Set(tools.map((tool) => tool.name));
    for (const tool of tools) {
      const mentioned = (tool.description ?? "").match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
      for (const name of mentioned) {
        if (/^(agents|messages|sessions|invocations|labels|broker|tail|work|notify|consult|feedback|current)_/.test(name)) {
          expect({ tool: tool.name, mentions: name, exposed: exposed.has(name) }).toEqual({ tool: tool.name, mentions: name, exposed: true });
        }
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("harness tool allowlist and reply prompts only name registered tools", async () => {
  const { DEFAULT_CLAUDE_SCOUT_ALLOWED_TOOLS, buildAttachedSessionInvocationPrompt } = await import("@openscout/runtime/local-agents");
  const server = createScoutMcpServer({ defaultCurrentDirectory: "/tmp", env: {} });
  const client = new Client({ name: "harness-tool-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const registered = new Set((await client.listTools()).tools.map(tool => tool.name));
    const allowed = DEFAULT_CLAUDE_SCOUT_ALLOWED_TOOLS.filter(name => name.startsWith("mcp__scout__"))
      .map(name => name.replace("mcp__scout__", ""));
    expect(allowed).toContain("reply");
    for (const name of allowed) expect({ name, registered: registered.has(name) }).toEqual({ name, registered: true });
    for (const metadata of [{}, { completion: { mode: "explicit" } }, { completion: { mode: "explicit" }, completionFlightId: "flight-contract" }]) {
      const prompt = buildAttachedSessionInvocationPrompt({
        id: "inv-contract", requesterId: "operator", requesterNodeId: "node", targetAgentId: "worker",
        action: "consult", task: "Review", conversationId: "conversation", messageId: "request",
        ensureAwake: true, stream: false, createdAt: 1, metadata,
      }, "worker");
      const names = [...prompt.matchAll(/(?:call|Use|Submit|and) `([a-z_]+)`/gi)].map(match => match[1]!);
      expect(names).toContain("reply");
      for (const name of names) expect({ name, registered: registered.has(name) }).toEqual({ name, registered: true });
    }
  } finally { await client.close(); await server.close(); }
});
