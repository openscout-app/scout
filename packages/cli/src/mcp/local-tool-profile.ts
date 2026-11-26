import { SCOUT_MCP_LOCAL_DEFAULT_TOOLS } from "@openscout/protocol";
import { ScoutCliError } from "../cli/errors.ts";

// Every generally available non-default tool belongs to exactly one group.
// invocations_ask is a deprecated compatibility exception, not a domain tool.
export const LOCAL_MCP_TOOL_GROUPS = {
  routing: ["where", "check", "route_context"],
  aliases: ["aliases_list", "aliases_resolve", "aliases_set", "aliases_repoint", "aliases_unset"],
  sessions: ["agents_start", "card_create", "sessions_inventory",
    "sessions_search", "sessions_names", "sessions_rename", "tail_events"],
  mailbox: ["sessions_attach", "sessions_get", "sessions_poll", "sessions_ack"],
  chat: ["chat_status", "chat_catch_up", "chat_ack"],
  terminals: ["herdr_workspaces", "rex_start_agent", "rex_status", "session_send"],
  git: ["worktrees_changes", "diff_read"],
  work: ["flight_cancel", "labels_brief", "labels_feed", "work_update", "work_retry", "work_move",
    "work_review", "work_lifecycle", "derived_read", "derived_write", "derived_pending"],
  integrations: ["integrations_setup", "integrations_get", "integrations_verify", "integrations_manifest",
    "integrations_start", "integrations_pause", "integrations_disconnect", "integrations_resume",
    "vercel_board_plan", "vercel_board_dispatcher"],
  operator: ["decision_read", "feedback_send", "post"],
} as const;

export type LocalMcpProfile = { name: string; includes: (tool: string) => boolean };

export function resolveLocalMcpProfile(value = "default"): LocalMcpProfile {
  const groups = new Set(value.split(",").map(part => part.trim()));
  if (groups.size === 1 && groups.has("full")) return { name: "full", includes: () => true };
  groups.delete("default");
  const names = [...groups].sort();
  const tools = new Set<string>(SCOUT_MCP_LOCAL_DEFAULT_TOOLS);
  for (const name of names) {
    if (!Object.hasOwn(LOCAL_MCP_TOOL_GROUPS, name)) {
      throw new ScoutCliError(`Invalid MCP profile "${value}". Use default, full on its own, or comma-separated groups: ${Object.keys(LOCAL_MCP_TOOL_GROUPS).join(", ")}.`);
    }
    for (const tool of LOCAL_MCP_TOOL_GROUPS[name as keyof typeof LOCAL_MCP_TOOL_GROUPS]) tools.add(tool);
  }
  return { name: names.join(",") || "default", includes: tool => tools.has(tool) };
}

/** Leave an implicit stdio install unpinned so it can inherit its host's env. */
export function selectedLocalMcpProfile(flag: string | undefined, env: NodeJS.ProcessEnv) {
  const value = flag ?? env.OPENSCOUT_MCP_PROFILE;
  return value === undefined ? undefined : resolveLocalMcpProfile(value);
}
