import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseContextRootCommandOptions } from "../options.ts";
import { runScoutMcpServer } from "../../mcp/scout-mcp.ts";
import { renderMcpInstallHelp, runMcpInstallCommand } from "./mcp-install.ts";

export type ScoutMcpCommandOptions = {
  currentDirectory: string;
  enableNotifications: boolean;
};

export function parseMcpCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutMcpCommandOptions {
  const filteredArgs: string[] = [];
  let enableNotifications = false;

  for (const arg of args) {
    if (arg === "--notifications" || arg === "--enable-notifications") {
      enableNotifications = true;
      continue;
    }
    filteredArgs.push(arg);
  }

  const options = parseContextRootCommandOptions(
    "mcp",
    filteredArgs,
    defaultCurrentDirectory,
  );
  return {
    currentDirectory: options.currentDirectory,
    enableNotifications,
  };
}

export function renderMcpCommandHelp(): string {
  return [
    "Usage:",
    "  scout mcp [--context-root <path>] [--notifications]",
    "  scout mcp install [--host <codex|claude>] [--force] [--dry-run]",
    "",
    "Run or install the Scout MCP server.",
    "",
    "`--notifications` enables background MCP reply notifications on this",
    "stdio connection. Omit it for a quiet tool-only MCP lane.",
    "",
    "The stdio server form is intended to be launched by an MCP host. It exposes",
    "the same canonical Scout coordination loop the CLI teaches:",
    "",
    "  whoami           inspect sender identity when the host is unclear",
    "  messages_inbox   read recent direct/addressed messages for this sender",
    "  messages_channel read recent messages from a named channel",
    "  broker_feed      native broker messages/status/errors for an agent",
    "  tail_events      recent observed harness activity from the broker tail",
    "  session_attach_current",
    "                   pro integration: attach the current live Codex session",
    "  card_create      pro integration: fresh reply-ready return address",
    "  agents_start     pro integration: start/create a concrete local agent session",
    "  where            shortlist local projects, agents or sessions by topic",
    "  check            read live work, optionally resolving a topic first",
    "  agents_search    search the known roster by identity fields",
    "  agents_resolve   pin one exact target when needed",
    "  ask              broker front door for agent-to-agent work/replies",
    "  reply            final answer or task progress by ref",
    "  ask + fyi        deliberate no-answer message",
    "  ask + operator   human-owned task; defaultAction declares a safe default",
    "  invocations_get  fetch current state for an existing ask flight",
    "  invocations_wait bounded wait for an existing ask flight",
    "  work_update      progress / waiting / review / done for existing work",
    "",
    "Pass targets as tool fields. Message body text is payload, so quoted",
    "handles such as @codex should not become routing instructions.",
    "",
    renderMcpInstallHelp(),
  ].join("\n");
}

export async function runMcpCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  const subcommand = args[0]?.trim() || "";

  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(renderMcpCommandHelp());
    return;
  }

  if (subcommand === "install") {
    await runMcpInstallCommand(context, args.slice(1));
    return;
  }

  const options = parseMcpCommandOptions(
    args,
    defaultScoutContextDirectory(context),
  );
  if (options.enableNotifications) {
    context.env.OPENSCOUT_MCP_ENABLE_NOTIFICATIONS = "1";
  }
  await runScoutMcpServer({
    defaultCurrentDirectory: options.currentDirectory,
    env: context.env,
  });
}
