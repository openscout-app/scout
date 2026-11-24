import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SCOUT_MCP_CORE_TOOL_CATALOG, SCOUT_MCP_LOCAL_DEFAULT_TOOLS } from "@openscout/protocol";
import portableTools from "../../../mesh-extension/src/core-tools.json";

import { LOCAL_MCP_TOOL_GROUPS } from "./local-tool-profile.ts";
import { SCOUT_READ_ONLY_TOOLS } from "../lib/core/setup/agent-guide.ts";
import { createScoutMcpServer } from "./scout-mcp.ts";
import { SCOUT_MCP_CORE_TOOLS } from "./mesh-bridge.ts";

async function withClient<T>(
  options: Pick<Parameters<typeof createScoutMcpServer>[0], "env" | "toolFilter">,
  run: (client: Client) => Promise<T>,
) {
  const server = createScoutMcpServer({ defaultCurrentDirectory: "/tmp", ...options });
  const client = new Client({ name: "catalog-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    return await run(client);
  } finally { await client.close(); await server.close(); }
}

const hosted = {
  env: { OPENSCOUT_MCP_PROFILE: "not-a-local-profile" }, // Ignored by the hosted filter.
  toolFilter: (name: string) => (SCOUT_MCP_CORE_TOOLS as readonly string[]).includes(name),
};

test("mcp:core catalog matches the tools the hosted bridge registers", () =>
  withClient(hosted, async client => {
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
  }));

// Include every tool prefix (not just the historical hosted prefixes), plus
// quoted or call-shaped references to single-word tools such as `where`.
const catalog: string[] = [...SCOUT_MCP_LOCAL_DEFAULT_TOOLS, ...Object.values(LOCAL_MCP_TOOL_GROUPS).flat(), "invocations_ask"];
const toolPrefixes = new Set([...catalog, "notify_", "consult_"].filter(n => n.includes("_")).map(n => n.split("_")[0]));
test.each([["hosted", hosted], ["local default", { env: {} }]] as const)(
  "%s descriptions never direct callers to an unavailable tool", (_, options) => withClient(options, async client => {
    const { tools } = await client.listTools();
    const exposed = new Set(tools.map((tool) => tool.name));
    for (const tool of tools) {
      for (const match of (tool.description ?? "").matchAll(/\b([a-z]+_[a-z_]+)\b|`([a-z]+)`|\b([a-z]+)\(|\b(?:[Uu]se|[Cc]all) ([a-z]+)\b/g)) {
        const name = match[1] ?? match[2] ?? match[3] ?? match[4]!;
        if ((name.includes("_") && toolPrefixes.has(name.split("_")[0]!)) || catalog.includes(name)) {
          expect({ tool: tool.name, mentions: name, exposed: exposed.has(name) }).toEqual({ tool: tool.name, mentions: name, exposed: true });
        }
      }
    }
  }),
);

test("default, additive groups and full partition the actual local registrations", async () => {
  const names = (env: NodeJS.ProcessEnv) => withClient({ env }, async c => (await c.listTools()).tools.map(t => t.name).sort());
  const defaults = await names({});
  expect(defaults).toHaveLength(14);
  expect(defaults).toEqual([
    "agents_resolve", "agents_search", "ask", "attachments_read", "broker_feed", "current_reply_context",
    "hosts_list", "invocations_get", "invocations_wait", "messages_channel", "messages_inbox", "reply", "show", "whoami",
  ]);
  const legacyFlag = { OPENSCOUT_EXPOSE_DEPRECATED_INVOCATIONS_ASK: "1" };
  expect(await names(legacyFlag)).toEqual(defaults);
  for (const [group, tools] of Object.entries(LOCAL_MCP_TOOL_GROUPS)) {
    expect(await names({ OPENSCOUT_MCP_PROFILE: group })).toEqual([...defaults, ...tools].sort());
  }
  // An unrestricted full registration catches unclassified tools and duplicate group entries.
  expect(await names({ OPENSCOUT_MCP_PROFILE: "full" })).toEqual([...defaults, ...Object.values(LOCAL_MCP_TOOL_GROUPS).flat()].sort());
  expect(await names({ ...legacyFlag, OPENSCOUT_MCP_PROFILE: "full" })).toEqual([...catalog].sort());
});

test("default local registration rejects calls to opt-in tools", () => withClient({ env: {} }, async client => {
  expect(client.getServerCapabilities()?.prompts).toBeUndefined(); // The routing prompt needs route_context.
  const result = await client.callTool({ name: "aliases_list", arguments: {} });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Tool aliases_list not found");
}));

test("harness allowlists and attached-session prompts use the default local tools", () => withClient({ env: {} }, async client => {
  const { DEFAULT_CLAUDE_SCOUT_ALLOWED_TOOLS, buildAttachedSessionInvocationPrompt } = await import("@openscout/runtime/local-agents");
  const registered = new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));
  const allowed = DEFAULT_CLAUDE_SCOUT_ALLOWED_TOOLS.filter(name => name.startsWith("mcp__scout__"))
    .map(name => name.replace("mcp__scout__", ""));
  expect(allowed.sort()).toEqual([...registered.keys()].sort());
  for (const name of SCOUT_READ_ONLY_TOOLS) expect(registered.get(name)?.annotations?.readOnlyHint).toBe(true);
  for (const metadata of [{}, { completion: { mode: "explicit" } }, { completion: { mode: "explicit" }, completionFlightId: "flight-contract" }]) {
    const prompt = buildAttachedSessionInvocationPrompt({
      origin: { source: "unknown" }, id: "inv-contract", requesterId: "operator", requesterNodeId: "node", targetAgentId: "scoutbot",
      action: "consult", task: "Review", conversationId: "conversation", messageId: "request",
      ensureAwake: true, stream: false, createdAt: 1, metadata,
      context: { scoutMessageAttachments: [{ id: "a", mediaType: "text/plain", url: "http://example.test/a" }] },
    }, "scoutbot");
    const names = [...prompt.matchAll(/`([a-z_]+)`|\bUse ([a-z]+_[a-z_]+) with/g)].map(match => match[1] ?? match[2]!);
    expect(names).toContain("attachments_read");
    expect(names).toContain("reply");
    for (const name of names) expect({ name, registered: registered.has(name) }).toEqual({ name, registered: true });
  }
}));
