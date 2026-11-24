import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Local setup tools are intentionally absent from the hosted MCP core catalog. */
export function registerIntegrationTools(server: McpServer, request: (path: string, init?: RequestInit) => Promise<unknown>,
  context: { env: NodeJS.ProcessEnv; readonly defaultCurrentDirectory: string } = { env: process.env, defaultCurrentDirectory: process.cwd() }): void {
  const result = async (path: string, body?: unknown) => {
    const receipt = await request(path, body ? { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) } : { signal: AbortSignal.timeout(15_000) });
    return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], structuredContent: receipt as Record<string, unknown> };
  };
  const rexSession = (explicit?: string) => {
    const id = explicit ?? context.env.REX_SESSION;
    if (!id) throw new Error("Outside Rex, supply the full local Rex sessionId.");
    return id;
  };
  server.registerTool("rex_start_agent", {
    title: "Start an agent in a Rex window",
    description: "Create a fresh Claude or Codex agent in a new native window in the caller's Rex session. Use when asked to create another agent here in Rex. The window opens in the background. Route work using ask with the returned agentId. If the result is uncertain, inspect rex_status before retrying.",
    inputSchema: z.object({ harness: z.enum(["claude", "codex"]), sessionId: z.string().optional(),
      projectPath: z.string().optional(), name: z.string().optional() }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ harness, sessionId, projectPath, name }) => result("/v1/integrations/rex/start", {
    sessionId: rexSession(sessionId), harness, name, projectPath: resolve(context.defaultCurrentDirectory, projectPath ?? "."),
  }));
  server.registerTool("rex_status", {
    title: "Read Rex session or block status",
    description: "List windows and blocks in the caller's local Rex session, or pass a blockId to read its foreground process, exit and native program reports including progress and blocked reasons. An empty report list means no program reported status.",
    inputSchema: z.object({ sessionId: z.string().optional(), blockId: z.string().optional() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ sessionId, blockId }) => result("/v1/integrations/rex/status", { sessionId: rexSession(sessionId), blockId }));
  server.registerTool("integrations_setup", {
    title: "Prepare Project Slack Integration",
    description: "Prepare or resume broker-owned setup for a registered local project agent's dedicated Slack app. Does not create an app, install it, or connect credentials. Report the next action to the operator. Never infer workspace installation authority.",
    inputSchema: z.object({
      provider: z.literal("slack"), mode: z.literal("project_agent"), projectPath: z.string().min(1),
      agentId: z.string().optional(), displayName: z.string().optional(), workspaceId: z.string().optional(), idempotencyKey: z.string().optional(),
    }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => result("/v1/integrations/setup", input));
  server.registerTool("integrations_get", {
    title: "Get Integration Setup",
    description: "Read a local setup operation's persisted state and next action. Setup state does not imply a connected or verified Slack integration.",
    inputSchema: z.object({ operationId: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ operationId }) => result(`/v1/integrations/setup/${encodeURIComponent(operationId)}`));
  server.registerTool("integrations_verify", {
    title: "Verify Project Slack Delivery",
    description: "Check broker evidence for a completed Slack request, returned result, and exact threaded follow-up. Does not send Slack messages or manually mark an integration verified. Requires an active connection and the latest setup revision.",
    inputSchema: z.object({ operationId: z.string().min(1), expectedRevision: z.number().int().positive() }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ operationId, expectedRevision }) => result(`/v1/integrations/setup/${encodeURIComponent(operationId)}/verify`, { expectedRevision }));
  server.registerTool("integrations_manifest", {
    title: "Get Project Slack Manifest",
    description: "Read the canonical manifest for an existing setup operation after the operator has confirmed installation authority. Creating and installing the app still requires the operator's Slack approval.",
    inputSchema: z.object({ operationId: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ operationId }) => result(`/v1/integrations/setup/${encodeURIComponent(operationId)}/manifest`));
  for (const action of ["start", "pause", "disconnect"] as const) {
    server.registerTool(`integrations_${action}`, {
      title: `Integration ${action}`,
      description: `Request ${action} for a local project integration using its latest revision. Start requires verified credentials. Pause and disconnect revoke worker authority; they do not delete the Slack app or its credentials. Read status to observe the worker.`,
      inputSchema: z.object({ operationId: z.string().min(1), expectedRevision: z.number().int().positive() }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    }, async ({ operationId, expectedRevision }) => result(`/v1/integrations/setup/${encodeURIComponent(operationId)}/lifecycle`, { action, expectedRevision }));
  }
  server.registerTool("integrations_resume", {
    title: "Resume Integration Setup",
    description: "Record a chosen Slack workspace or an operator-created app ID using the latest revision. Human workspace-authority confirmation is a separate local CLI action. No credential values or verification claims are accepted.",
    inputSchema: z.object({
      operationId: z.string().min(1), expectedRevision: z.number().int().positive(),
      action: z.enum(["choose_workspace", "register_app"]), workspaceId: z.string().optional(), appId: z.string().optional(),
    }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ operationId, ...body }) => result(`/v1/integrations/setup/${encodeURIComponent(operationId)}/resume`, body));
}
