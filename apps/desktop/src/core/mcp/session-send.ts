import { currentSessionReturnAddress, stampSessionReturnAddress, type SessionReturnAddress } from "./session-return-address.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { deliverInPlace, type InPlaceDelivery } from "@openscout/runtime/in-place";

import { renderInPlaceDelivery } from "../../cli/commands/session.ts";

/**
 * `session_send` — the write side next to `herdr_workspaces`.
 *
 * Types into a live harness session where it runs (its Herdr pane, Orca
 * terminal, tmux pane, or terminal tab) and presses Enter. It is the direct
 * path: no broker record, no flight, no resume. A session that isn't open
 * anywhere is reported, never started; reaching it through Scout is `ask`.
 *
 * Registered on the local MCP server only. The mesh bridge serves an explicit
 * tool allowlist, so a remote caller cannot type into this machine's panes
 * unless that list names this tool.
 */

export type SessionSendDependencies = {
  deliver: (input: { sessionId: string; harness?: string | null; body: string; mode?: "submit" | "draft" }) => Promise<InPlaceDelivery>;
  /** The caller's own harness session, which it must not type into. */
  ownSessionId: () => string | null;
  returnAddress?: () => SessionReturnAddress | null;
};

export function sessionSendDependencies(env: NodeJS.ProcessEnv): SessionSendDependencies {
  return {
    deliver: (input) => deliverInPlace(input),
    returnAddress: () => currentSessionReturnAddress(env),
    ownSessionId: () => env.CLAUDE_CODE_SESSION_ID?.trim() || env.CODEX_THREAD_ID?.trim() || null,
  };
}

export function registerSessionSendTool(server: McpServer, deps: SessionSendDependencies): void {
  server.registerTool("session_send", {
    title: "Send Into a Live Session",
    description: [
      "Type text into another harness session where it is running — its Herdr pane, Orca terminal, tmux pane, or terminal tab on this machine — and press Enter.",
      "Address it by the harness session id (herdr_workspaces reports it per pane; Claude Code and Codex session ids work directly).",
      "This is the direct path: nothing is recorded in Scout and no reply is tracked. It never resumes, forks, or starts a session; one that isn't open is reported and nothing is sent. For a tracked request or reply, use ask.",
      "A session waiting on a permission prompt or a question is refused as blocked; the operator answers that first.",
    ].join(" "),
    inputSchema: z.object({
      sessionId: z.string().trim().min(8).max(200)
        .describe("Harness session id of the target (e.g. a Claude Code session UUID or Codex thread id)."),
      harness: z.enum(["claude", "codex"]).optional()
        .describe("The target's harness, when known. Narrows the lookup."),
      requestReply: z.boolean().optional().describe("Opt in to stamping this process’s exact harness return address on a direct typed request. Refuses if sender identity is unavailable; does not create broker tracking."),
      mode: z.enum(["submit", "draft"]).optional().describe("Default submit. Draft requires harness codex, fills the native app composer, and never presses send."),
      text: z.string().min(1).max(20_000)
        .describe("What to type. Sent as one prompt followed by Enter."),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ sessionId, harness, text, mode, requestReply }) => {
    if (sessionId === deps.ownSessionId()) {
      const structuredContent = { ok: false, code: "own_session", sessionId };
      return {
        content: [{ type: "text" as const, text: "That is your own session; nothing was sent." }],
        structuredContent,
        isError: true,
      };
    }
    const address = requestReply ? deps.returnAddress?.() : null;
    if (requestReply && !address) return {
      content: [{ type: "text" as const, text: "No unambiguous sender session id is available. Use broker ask for tracked replies, or provide an explicit return address in your request; nothing was typed." }],
      structuredContent: { ok: false, code: "return_address_unavailable", sessionId }, isError: true,
    };
    const body = address ? stampSessionReturnAddress(text, address) : text;
    const result = await deps.deliver({ sessionId, harness: harness ?? null, body, ...(mode ? { mode } : {}) });
    const structuredContent = { sessionId, ...result };
    return {
      content: [{ type: "text" as const, text: renderInPlaceDelivery(sessionId, result) }],
      structuredContent,
      ...(result.ok ? {} : { isError: true }),
    };
  });
}
