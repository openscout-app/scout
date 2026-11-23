export type DirectLocalAgentTransport = "codex_app_server" | "claude_stream_json" | "pi_rpc" | "grok_acp" | "kimi_acp" | "cursor_acp" | "opencode_acp" | "antigravity_acp" | "devin_acp";

const directLocalAgentTransports = new Set<string>([
  "codex_app_server",
  "claude_stream_json",
  "pi_rpc",
  "grok_acp",
  "kimi_acp",
  "cursor_acp",
  "opencode_acp",
  "antigravity_acp",
  "devin_acp",
]);

export function isDirectLocalAgentTransport(
  transport: string | null | undefined,
): transport is DirectLocalAgentTransport {
  return typeof transport === "string" && directLocalAgentTransports.has(transport);
}

export function isBrokerRunnableLocalAgentTransport(
  transport: string | null | undefined,
): boolean {
  // "ghostty" is only ever an attached live terminal; its delivery never spawns.
  return transport === "tmux" || transport === "ghostty" || transport === "rex" || isDirectLocalAgentTransport(transport);
}
