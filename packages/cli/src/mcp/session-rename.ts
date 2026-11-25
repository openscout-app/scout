import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  SESSION_NAME_MAX_LENGTH,
  scoutBrokerPaths,
  type SessionNameListResult,
  type SessionNameSetResult,
} from "@openscout/protocol";

type BrokerRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

function textContent(value: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];
}

/** Current harness session from the MCP server's environment, if any. */
function selfSession(env: NodeJS.ProcessEnv): { harness: string; nativeSessionId: string } | null {
  const codex = env.CODEX_THREAD_ID?.trim() || env.OPENSCOUT_CODEX_THREAD_ID?.trim();
  if (codex) return { harness: "codex", nativeSessionId: codex };
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim() || env.CLAUDE_SESSION_ID?.trim();
  if (claude) return { harness: "claude", nativeSessionId: claude };
  const antigravity = env.ANTIGRAVITY_CONVERSATION_ID?.trim();
  if (antigravity) return { harness: "antigravity", nativeSessionId: antigravity };
  return null;
}

export function registerSessionRenameTools(server: McpServer, request: BrokerRequest, env: NodeJS.ProcessEnv = process.env): void {
  server.registerTool(
    "sessions_rename",
    {
      title: "Rename a Scout Session",
      description: "Set or clear the operator's name for one harness session on this machine. The name wins over the harness title in every Scout session read; the harness title stays available as harnessTitle. Select the session with selector (native session id, <harness>:<id>, agent or session actor id, or sess.<token>@<host> address), with harness plus nativeSessionId, or with self=true for the session this tool runs in. name null or empty clears it; the session then shows its current work item title, then the harness title. Local metadata only: harness session files are never written.",
      inputSchema: z.object({
        selector: z.string().trim().min(1).max(1024).optional(),
        harness: z.string().trim().min(1).max(64).optional(),
        nativeSessionId: z.string().trim().min(1).max(1024).optional(),
        self: z.boolean().optional(),
        name: z.string().max(SESSION_NAME_MAX_LENGTH * 4).nullable(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      let target: { selector?: string; harness?: string; nativeSessionId?: string } = {
        ...(input.selector ? { selector: input.selector } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
      };
      if (input.self) {
        const self = selfSession(env);
        if (!self) throw new Error("self=true needs CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, or ANTIGRAVITY_CONVERSATION_ID in the MCP server's environment; pass a selector instead");
        target = self;
      }
      if (!target.selector && !target.nativeSessionId) {
        throw new Error("name the session: selector, harness plus nativeSessionId, or self=true");
      }
      const result = await request<SessionNameSetResult>(scoutBrokerPaths.v1.sessionNames, {
        method: "POST",
        body: JSON.stringify({ ...target, name: input.name }),
      });
      return { content: textContent(result), structuredContent: { ...result } };
    },
  );

  server.registerTool(
    "sessions_names",
    {
      title: "List Scout Session Names",
      description: "List the session names the operator set on this machine (harness, nativeSessionId, name). Derived work titles and harness titles are not listed; read sessions_inventory for every session's resolved title.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const result = await request<SessionNameListResult>(scoutBrokerPaths.v1.sessionNames);
      return { content: textContent(result), structuredContent: { ...result } };
    },
  );
}
