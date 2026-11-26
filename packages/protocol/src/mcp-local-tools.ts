// The tools in every local coding session. The CLI registers these names and
// the runtime uses them for Claude's launch allowlist. Not the hosted mcp:core tier.
export const SCOUT_MCP_LOCAL_DEFAULT_TOOLS = [
  "whoami", "hosts_list", "agents_search", "agents_resolve",
  "ask", "reply", "current_reply_context", "invocations_get", "invocations_wait",
  "messages_inbox", "messages_channel", "broker_feed", "attachments_read", "show",
  "session_attach_current",
  "browser_status", "browser_profiles", "browser_open", "browser_snapshot",
  "browser_click", "browser_fill", "browser_resize", "browser_screenshot",
  "browser_tabs", "browser_close",
  "computer_status", "computer_windows", "computer_screenshot",
  "computer_focus", "computer_inspect", "computer_act",
] as const;
