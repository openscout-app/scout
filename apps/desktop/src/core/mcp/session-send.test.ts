import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionSendTool, type SessionSendDependencies } from "./session-send.ts";
import { currentSessionReturnAddress, stampSessionReturnAddress } from "./session-return-address.ts";

async function useClient(deps: SessionSendDependencies, run: (client: Client) => Promise<void>) {
  const server = new McpServer({ name: "test", version: "1" });
  registerSessionSendTool(server, deps);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try { await run(client); } finally { await client.close(); await server.close(); }
}
test("return address uses only one process-owned harness identity", () => {
  expect(currentSessionReturnAddress({})).toBeNull();
  expect(currentSessionReturnAddress({ CODEX_THREAD_ID: "native-sender", CLAUDE_CODE_SESSION_ID: "other-sender" })).toBeNull();
  expect(currentSessionReturnAddress({ CODEX_THREAD_ID: "native-sender" })).toEqual({ harness: "codex", sessionId: "native-sender" });
});
test("direct request opts into an exact return address, while ordinary send is unchanged", async () => {
  const bodies: string[] = [];
  await useClient({ ownSessionId: () => "native-sender", returnAddress: () => ({ harness: "codex", sessionId: "native-sender" }), deliver: async input => { bodies.push(input.body); return { ok: true, via: "tmux", location: "test" }; } }, async client => {
    await client.callTool({ name: "session_send", arguments: { sessionId: "other-session", text: "review", requestReply: true } });
    await client.callTool({ name: "session_send", arguments: { sessionId: "other-session", text: "plain" } });
  });
  expect(bodies).toEqual([stampSessionReturnAddress("review", { harness: "codex", sessionId: "native-sender" }), "plain"]);
});
test("missing return identity refuses without delivery; draft reaches transport without submit", async () => {
  let delivered = 0;
  await useClient({ ownSessionId: () => null, deliver: async input => { delivered++; expect(input.mode).toBe("draft"); return { ok: true, delivered: "draft", via: "scout-app", location: "composer" }; } }, async client => {
    expect((await client.callTool({ name: "session_send", arguments: { sessionId: "other-session", text: "review", requestReply: true } })).isError).toBe(true);
    expect(delivered).toBe(0);
    expect((await client.callTool({ name: "session_send", arguments: { sessionId: "other-session", harness: "codex", text: "review", mode: "draft" } })).structuredContent).toMatchObject({ delivered: "draft" });
  });
  expect(delivered).toBe(1);
});
