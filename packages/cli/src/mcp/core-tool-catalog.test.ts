import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SCOUT_MCP_CORE_TOOL_CATALOG, SCOUT_MCP_LOCAL_DEFAULT_TOOLS } from "@openscout/protocol";
import { deriveOpenScoutInstanceLayout } from "@openscout/runtime/config";
import { SCOUTBOT_ROLE_CONFIG, buildCodexEndpointSessionOptions } from "@openscout/runtime/harnesses";
import { resolveScoutMcpCodexLaunch } from "../../../agent-sessions/src/codex-launch-config.ts";
import portableTools from "../../../mesh-extension/src/core-tools.json";

import { LOCAL_MCP_TOOL_GROUPS } from "./local-tool-profile.ts";
import { parseMcpCommandOptions } from "../cli/commands/mcp.ts";
import { SCOUT_READ_ONLY_TOOLS } from "../lib/core/setup/agent-guide.ts";
import { createScoutMcpServer } from "./scout-mcp.ts";
import { SCOUT_MCP_CORE_TOOLS } from "./mesh-bridge.ts";

function launchConfigValue(args: string[], key: string) {
  const prefix = `${key}=`;
  const arg = args.find(value => value.startsWith(prefix));
  if (!arg) throw new Error(`Missing Codex launch setting: ${key}`);
  return JSON.parse(arg.slice(prefix.length));
}

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

function mentionedTools(text: string): string[] {
  const names = [...text.matchAll(/\b([a-z]+_[a-z_]+)\b|`([a-z]+)`|\b([a-z]+)\(|\b(?:[Uu]se|[Cc]all) ([a-z]+)\b/g)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? match[4]!);
  return [...new Set(names.filter(name => catalog.includes(name) || (name.includes("_") && toolPrefixes.has(name.split("_")[0]!))))];
}

test.each([
  ["hosted", hosted],
  ["local default", { env: {} }],
  ...Object.keys(LOCAL_MCP_TOOL_GROUPS).map(group => [`local ${group}`, { env: { OPENSCOUT_MCP_PROFILE: group } }] as const),
] as const)(
  "%s descriptions never direct callers to an unavailable tool", (_, options) => withClient(options, async client => {
    const { tools } = await client.listTools();
    const exposed = new Set(tools.map((tool) => tool.name));
    for (const tool of tools) {
      for (const name of mentionedTools(tool.description ?? "")) {
        expect({ tool: tool.name, mentions: name, exposed: exposed.has(name) }).toEqual({ tool: tool.name, mentions: name, exposed: true });
      }
    }
  }),
);

test.each([
  ["a normal local launch", undefined],
  ["a launch with shared HTTP configured", "http://127.0.0.1:49100/mcp"],
] as const)("Scoutbot can call every granted and prompted tool in %s", async (_, sharedUrl) => {
  const options = buildCodexEndpointSessionOptions({
    id: "endpoint.scoutbot", agentId: "scoutbot", nodeId: "node",
    transport: "codex_app_server", harness: "codex", state: "idle", cwd: "/tmp",
    metadata: sharedUrl
      ? {
          source: "scout-isolated-agent-session", isolatedExecution: true, threadId: "existing-thread",
          systemPrompt: "Old prompt with messages_send.",
          launchArgs: ["-c", 'mcp_servers.scout.enabled_tools=["messages_send"]'],
          model: "gpt-6-astra", reasoningEffort: "high",
        }
      : { source: "scoutbot", systemPrompt: SCOUTBOT_ROLE_CONFIG.systemPrompt },
  });
  const env = {
    ...options.env,
    OPENSCOUT_CLI_BIN: process.execPath,
    OPENSCOUT_MCP_SHARED_URL: sharedUrl,
    OPENSCOUT_MCP_PROFILE: "default",
  };
  const launch = await resolveScoutMcpCodexLaunch({
    currentDirectory: options.cwd,
    profiledScoutMcp: options.profiledScoutMcp,
    env,
    codexExecutable: "/bin/codex",
    mcpGet: async () => sharedUrl
      ? { status: 0, stdout: JSON.stringify({ transport: { type: "streamable_http", url: sharedUrl } }), stderr: "" }
      : { status: 1, stdout: "", stderr: "No MCP server named scout" },
  });
  expect(launch.usesUrl).toBe(false);
  expect(launch.args.includes("mcp_servers.scout.enabled=false")).toBe(Boolean(sharedUrl));
  if (sharedUrl) {
    expect(options.threadId).toBe("existing-thread");
    expect(options.launchArgs.some(arg => arg.startsWith("mcp_servers.scout."))).toBe(false);
    expect(options.launchArgs).toEqual(expect.arrayContaining(['model="gpt-6-astra"', 'model_reasoning_effort="high"']));
  }

  const argv: string[] = launchConfigValue(launch.args, "mcp_servers.scout_role.args");
  expect(argv[0]).toBe("mcp");
  const { profile } = parseMcpCommandOptions(argv.slice(1), options.cwd, env);
  const allowlist: string[] = launchConfigValue(launch.args, "mcp_servers.scout_role.enabled_tools");
  expect(allowlist.sort()).toEqual([...SCOUTBOT_ROLE_CONFIG.grants.read, ...SCOUTBOT_ROLE_CONFIG.grants.write].sort());
  await withClient({ env, toolFilter: profile?.includes }, async client => {
    const { tools } = await client.listTools();
    const registered = new Map(tools.map(tool => [tool.name, tool]));
    for (const name of allowlist) expect(registered.has(name)).toBe(true);
    for (const name of mentionedTools(options.systemPrompt)) expect(allowlist).toContain(name);
    for (const name of SCOUTBOT_ROLE_CONFIG.grants.read) expect(registered.get(name)?.annotations?.readOnlyHint).toBe(true);
  });
});

test("Scoutbot's configured stdio server reads a turn attachment from its own Scout instance", async () => {
  // Keep the Unix socket path short enough on macOS. No installed broker is used.
  const home = mkdtempSync("/tmp/smcp-");
  const instance = "mcp-test";
  const layout = deriveOpenScoutInstanceLayout({ name: instance, home, env: {} });
  const replyFile = join(home, "reply.json");
  const replyContext = {
    mode: "broker_reply", fromAgentId: "operator", toAgentId: "scoutbot",
    conversationId: "c-test", messageId: "msg-test", replyToMessageId: "msg-test", replyPath: "final_response",
  };
  const text = "attachment from the test instance";
  const blobId = "a".repeat(64);
  const blob = { sha256: blobId, mediaType: "text/plain", byteSize: text.length };
  const client = new Client({ name: "scoutbot-stdio-test", version: "1" });
  mkdirSync(dirname(layout.brokerSocketPath), { recursive: true });
  const broker = Bun.serve({
    unix: layout.brokerSocketPath,
    async fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/health": return Response.json({ ok: true });
        case "/v1/node": return Response.json({ id: "node-test" });
        case "/v1/snapshot": return Response.json({ messages: {
          "msg-test": { id: "msg-test", originNodeId: "node-test", actorId: "operator", conversationId: "c-test",
            attachments: [{ id: "text-test", mediaType: blob.mediaType, blob }] },
        } });
        case "/v1/attachments/read":
          expect(await request.json()).toEqual({ actorId: "scoutbot", conversationId: "c-test", messageId: "msg-test", blobId, mode: "text" });
          return Response.json({ blobId, messageId: "msg-test", mediaType: blob.mediaType,
            byteSize: blob.byteSize, mode: "text", text, truncated: false, sourceTrust: "untrusted_attachment" });
        default: return new Response(null, { status: 404 });
      }
    },
  });
  try {
    const options = buildCodexEndpointSessionOptions({
      id: "endpoint.scoutbot", agentId: "scoutbot", nodeId: "node-test",
      transport: "codex_app_server", harness: "codex", state: "idle", cwd: home,
      metadata: { source: "scoutbot" },
    });
    // Use the real source CLI without requiring a bundled dist build.
    const command = join(home, "scout");
    writeFileSync(command, `#!/usr/bin/env bun\nawait import(${JSON.stringify(resolve(import.meta.dir, "../main.ts"))});\n`, { mode: 0o755 });
    const parentEnv = {
      OPENSCOUT_CLI_BIN: command,
      OPENSCOUT_CLIENT_INSTANCE: instance,
      OPENSCOUT_REPLY_CONTEXT_FILE: replyFile,
      OPENSCOUT_BROKER_SOCKET_ONLY: "1",
    };
    const { args } = await resolveScoutMcpCodexLaunch({
      currentDirectory: options.cwd, env: parentEnv, profiledScoutMcp: options.profiledScoutMcp,
    });
    const config = (key: string) => launchConfigValue(args, `mcp_servers.scout_role.${key}`);
    const envVars: string[] = config("env_vars");
    expect(envVars).toEqual(expect.arrayContaining(["OPENSCOUT_CLIENT_INSTANCE", "OPENSCOUT_REPLY_CONTEXT_FILE", "OPENSCOUT_BROKER_SOCKET_ONLY"]));
    // Like Codex, the transport starts the child with its base environment plus
    // only the requested names. Do not pass parentEnv directly to the CLI.
    const forwarded = Object.fromEntries(Object.entries(parentEnv).filter(([key]) => envVars.includes(key)));
    await client.connect(new StdioClientTransport({
      command: config("command"), args: config("args"), cwd: config("cwd"),
      env: { HOME: home, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, ...forwarded },
      stderr: "inherit",
    }));
    // Scoutbot starts before there is a turn; the running server must read the
    // context file at call time, not at startup.
    writeFileSync(replyFile, JSON.stringify(replyContext));
    expect(await client.callTool({ name: "attachments_read", arguments: { attachmentId: "text-test" } }))
      .toMatchObject({ structuredContent: { text, supported: true, sourceTrust: "untrusted_operator_attachment" } });
  } finally {
    await client.close();
    await broker.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("default, additive groups and full partition the actual local registrations", async () => {
  const names = (env: NodeJS.ProcessEnv) => withClient({ env }, async c => (await c.listTools()).tools.map(t => t.name).sort());
  const defaults = await names({});
  expect(defaults).toHaveLength(30);
  expect(defaults).toEqual([
    "agents_resolve", "agents_search", "ask", "attachments_read", "broker_feed",
    "browser_click", "browser_close", "browser_fill", "browser_open", "browser_profiles",
    "browser_resize", "browser_screenshot", "browser_snapshot", "browser_status", "browser_tabs",
    "computer_act", "computer_focus", "computer_inspect", "computer_screenshot", "computer_status", "computer_windows",
    "current_reply_context",
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
  const { DEFAULT_CLAUDE_SCOUT_ALLOWED_TOOLS, buildAttachedSessionInvocationPrompt } = await import("@openscout/runtime/harnesses");
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
