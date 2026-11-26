import { resolve } from "node:path";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/client";
import { resolveBrokerSocketPathForBaseUrl } from "@openscout/runtime/daemon";
import { resolveScoutBrokerUrl, resolveScoutSenderId } from "../../lib/core/broker/service.ts";
type ShowResult = { error?: string; show?: { id: string } };
export async function runShowCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText("Usage: scout show <path> [--caption <text>]\nShow an immutable screenshot, short recording, or finished file on the project canvas. Never show secrets."); return;
  }
  const path = args[0];
  if (!path || path.startsWith("--") || (args.length > 1 && (args.length !== 3 || args[1] !== "--caption"))) throw new ScoutCliError("Usage: scout show <path> [--caption <text>]");
  const agentId = await resolveScoutSenderId(null, context.cwd, context.env);
  const sessionId = context.env.OPENSCOUT_SESSION_ID || context.env.CODEX_THREAD_ID || context.env.CLAUDE_CODE_SESSION_ID || context.env.ANTIGRAVITY_CONVERSATION_ID;
  const baseUrl = resolveScoutBrokerUrl();
  const body = { path: resolve(context.cwd, path), caption: args[2], caller: { actorId: agentId, currentDirectory: context.cwd, metadata: { sessionId, harness: context.env.CODEX_THREAD_ID ? "codex" : context.env.CLAUDE_CODE_SESSION_ID ? "claude" : context.env.ANTIGRAVITY_CONVERSATION_ID ? "antigravity" : undefined } } };
  // Same transport as every other broker write: the local socket first, so a
  // mesh-advertised https broker URL never needs its certificate trusted here.
  let result: ShowResult;
  try {
    result = await requestScoutBrokerJson<ShowResult>(baseUrl, "/v1/shows", { method: "POST", body, socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl) ?? undefined });
  } catch (error) {
    if (error instanceof ScoutBrokerHttpError) throw new ScoutCliError(showErrorMessage(error));
    throw error;
  }
  context.output.writeValue(result, value => `Shown ${value.show?.id}`);
}
function showErrorMessage(error: ScoutBrokerHttpError): string {
  try { const parsed = JSON.parse(error.body) as { error?: unknown }; if (typeof parsed.error === "string" && parsed.error) return parsed.error; } catch {}
  return `show failed (${error.status})`;
}
