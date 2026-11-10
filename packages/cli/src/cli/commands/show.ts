import { resolve } from "node:path";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl, resolveScoutSenderId } from "../../lib/core/broker/service.ts";
export async function runShowCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText("Usage: scout show <path> [--caption <text>]\nShow an immutable screenshot, short recording, or finished file on the project canvas. Never show secrets."); return;
  }
  const path = args[0];
  if (!path || path.startsWith("--") || (args.length > 1 && (args.length !== 3 || args[1] !== "--caption"))) throw new ScoutCliError("Usage: scout show <path> [--caption <text>]");
  const agentId = await resolveScoutSenderId(null, context.cwd, context.env);
  const sessionId = context.env.OPENSCOUT_SESSION_ID || context.env.CODEX_THREAD_ID || context.env.CLAUDE_CODE_SESSION_ID;
  const response = await fetch(new URL("/v1/shows", resolveScoutBrokerUrl()), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: resolve(context.cwd, path), caption: args[2], caller: { actorId: agentId, currentDirectory: context.cwd, metadata: { sessionId, harness: context.env.CODEX_THREAD_ID ? "codex" : context.env.CLAUDE_CODE_SESSION_ID ? "claude" : undefined } } }) });
  const result = await response.json() as { error?: string; show?: { id: string } };
  if (!response.ok) throw new ScoutCliError(result.error || `show failed (${response.status})`);
  context.output.writeValue(result, value => `Shown ${value.show?.id}`);
}
