import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SessionNameSetResult } from "@openscout/protocol";

import { registerSessionRenameTools } from "../../mcp/session-rename.ts";
import { ScoutCliError } from "../errors.ts";
import { parseSessionRenameArgs, renderSessionRename } from "./session-rename.ts";

function result(overrides: Partial<SessionNameSetResult> = {}): SessionNameSetResult {
  return {
    ok: true,
    action: "set",
    session: { harness: "claude", nativeSessionId: "abc" },
    record: { harness: "claude", nativeSessionId: "abc", name: "Session names", setByActorId: "operator", createdAt: 1, updatedAt: 1 },
    resolution: { name: "Session names", source: "operator", operatorName: "Session names", derivedName: null, derivedFrom: null, harnessTitle: "kernel-panic-last-boot" },
    ...overrides,
  };
}

describe("scout session rename", () => {
  test("takes a selector and the rest of the words as the name", () => {
    expect(parseSessionRenameArgs(["abc", "Session", "names"], {}).request).toEqual({ selector: "abc", name: "Session names" });
    expect(parseSessionRenameArgs(["abc", "--harness", "codex", "Fix build"], {}).request).toEqual({ selector: "abc", harness: "codex", name: "Fix build" });
    expect(parseSessionRenameArgs(["claude:abc", "--", "--literal"], {}).request).toEqual({ selector: "claude:abc", name: "--literal" });
  });

  test("--clear sends a null name", () => {
    expect(parseSessionRenameArgs(["abc", "--clear"], {}).request).toEqual({ selector: "abc", name: null });
    expect(() => parseSessionRenameArgs(["abc", "--clear", "x"], {})).toThrow(ScoutCliError);
    expect(() => parseSessionRenameArgs(["abc"], {})).toThrow(/--clear/);
    expect(() => parseSessionRenameArgs([], {})).toThrow(/name a session/);
  });

  test("--self names the harness session in the environment", () => {
    expect(parseSessionRenameArgs(["--self", "Rename", "sessions"], { CLAUDE_CODE_SESSION_ID: "claude-1" }).request)
      .toEqual({ nativeSessionId: "claude-1", harness: "claude", name: "Rename sessions" });
    expect(parseSessionRenameArgs(["--self", "--clear"], { CODEX_THREAD_ID: "thread-1" }).request)
      .toEqual({ nativeSessionId: "thread-1", harness: "codex", name: null });
    expect(parseSessionRenameArgs(["--self", "Guides", "pass"], { ANTIGRAVITY_CONVERSATION_ID: "agy-conv-1" }).request)
      .toEqual({ nativeSessionId: "agy-conv-1", harness: "antigravity", name: "Guides pass" });
    expect(() => parseSessionRenameArgs(["--self", "x"], {})).toThrow(/CLAUDE_CODE_SESSION_ID/);
  });

  test("says what the session was renamed from, and what it shows after a clear", () => {
    expect(renderSessionRename(result())).toBe('Named claude:abc "Session names" (renamed from "kernel-panic-last-boot").');
    expect(renderSessionRename(result({
      action: "cleared",
      record: null,
      resolution: { name: "Home: Running list", source: "work", operatorName: null, derivedName: "Home: Running list", derivedFrom: { kind: "work_item", id: "w", agentId: "a" }, harnessTitle: "kernel-panic-last-boot" },
    }))).toBe('Cleared the name of claude:abc. It shows "Home: Running list" (from its current work).');
  });
});

describe("sessions_rename MCP tool", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  async function clientWith(env: NodeJS.ProcessEnv) {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const server = new McpServer({ name: "test", version: "1" });
    registerSessionRenameTools(server, async <T>(path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return (init?.method === "POST" ? result() : { names: [] }) as T;
    }, env);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    cleanups.push(async () => { await client.close(); await server.close(); });
    return { client, calls };
  }

  test("posts the selector and name, or the session it runs in", async () => {
    const { client, calls } = await clientWith({ CODEX_THREAD_ID: "thread-1" });
    const named = await client.callTool({ name: "sessions_rename", arguments: { selector: "abc", name: "Session names" } });
    expect(named.structuredContent).toMatchObject({ action: "set", resolution: { source: "operator" } });
    await client.callTool({ name: "sessions_rename", arguments: { self: true, name: null } });
    await client.callTool({ name: "sessions_names", arguments: {} });
    expect(calls.map((call) => [call.path, call.init?.method ?? "GET", call.init?.body ? JSON.parse(String(call.init.body)) : null])).toEqual([
      ["/v1/session-names", "POST", { selector: "abc", name: "Session names" }],
      ["/v1/session-names", "POST", { harness: "codex", nativeSessionId: "thread-1", name: null }],
      ["/v1/session-names", "GET", null],
    ]);
    const missing = await client.callTool({ name: "sessions_rename", arguments: { name: "x" } });
    expect(missing.isError).toBe(true);
  });
});
