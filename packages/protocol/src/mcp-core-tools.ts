/**
 * The `mcp:core` tool tier: what the hosted MCP gateway (mcp.oscout.net)
 * exposes to a remote client through the bridge. The bridge filters on these
 * names, the gateway's agent guide counts them, and the public docs list them.
 * Titles and access must match the registered tools; a desktop test enforces it.
 */
export type ScoutMcpCoreToolAccess = "read" | "write";

export type ScoutMcpCoreTool = {
  name: string;
  title: string;
  access: ScoutMcpCoreToolAccess;
  summary: string;
};

export const SCOUT_MCP_CORE_TOOL_CATALOG = [
  { name: "whoami", title: "Scout Whoami", access: "read", summary: "Show the Scout identity and broker this connection acts as." },
  { name: "agents_search", title: "Search Scout Agents", access: "read", summary: "Find agents on the mesh that can take a request." },
  { name: "agents_resolve", title: "Resolve Scout Agent", access: "read", summary: "Resolve one agent handle, or report why it is ambiguous." },
  { name: "reply", title: "Reply", access: "write", summary: "Answer a task or record progress; use to for a conversation reply." },
  { name: "ask", title: "Ask", access: "write", summary: "Ask an agent to answer, review, or build something, and get a handle to follow." },
  { name: "invocations_get", title: "Get Scout Task", access: "read", summary: "Read the current state of a task." },
  { name: "invocations_wait", title: "Wait For Scout Task", access: "read", summary: "Wait briefly for a task to finish and return its state." },
  { name: "messages_inbox", title: "Read Scout Inbox", access: "read", summary: "Read recent messages addressed to this identity." },
  { name: "messages_channel", title: "Read Scout Channel", access: "read", summary: "Read recent messages in a named channel." },
  { name: "current_reply_context", title: "Current Scout Reply Context", access: "read", summary: "Check whether a reply would continue an inbound ask." },
  { name: "broker_feed", title: "Read Agent Broker Feed", access: "read", summary: "Read one agent's messages, deliveries, and errors in one view." },
  { name: "tail_events", title: "Read Tail Events", access: "read", summary: "Read recent activity from the coding agents on the Scout machine." },
  { name: "labels_brief", title: "Brief Scout Label", access: "read", summary: "Summarize the records that share a label." },
  { name: "labels_feed", title: "Read Scout Label Feed", access: "read", summary: "Read the event backlog for a label." },
  { name: "work_update", title: "Update Scout Work", access: "write", summary: "Move a work item through progress, review, and done." },
  { name: "feedback_send", title: "Send Scout Feedback", access: "write", summary: "Report a bug or rough edge in Scout to the OpenScout team." },
  { name: "sessions_attach", title: "Attach External Session", access: "write", summary: "Give this conversation a Scout mailbox so agents can reply to it." },
  { name: "sessions_get", title: "Get External Session", access: "read", summary: "Read the mailbox attached to this conversation." },
  { name: "sessions_poll", title: "Poll External Session", access: "read", summary: "Read pending items in the attached mailbox." },
  { name: "sessions_ack", title: "Acknowledge External Session Item", access: "write", summary: "Mark a mailbox item as received." },
] as const satisfies readonly ScoutMcpCoreTool[];

export type ScoutMcpCoreToolName = (typeof SCOUT_MCP_CORE_TOOL_CATALOG)[number]["name"];

export const SCOUT_MCP_CORE_TOOL_NAMES: readonly ScoutMcpCoreToolName[] =
  SCOUT_MCP_CORE_TOOL_CATALOG.map((tool) => tool.name);
