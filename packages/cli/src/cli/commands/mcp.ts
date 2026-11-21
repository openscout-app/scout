import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseContextRootCommandOptions } from "../options.ts";
import { runScoutMcpServer } from "../../mcp/scout-mcp.ts";
import { renderMcpInstallHelp, runMcpInstallCommand } from "./mcp-install.ts";
import { ScoutCliError } from "../errors.ts";

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
    "  scout mcp install [--host <codex|claude|zed>] [--shared] [--force] [--dry-run]",
    "  scout mcp serve [--port <n>] [--host 127.0.0.1] [--idle-timeout <seconds>] [--notifications]",
    "                   one shared server for every local session (Streamable HTTP)",
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
    "  work_retry       retry a failed run in a fresh session; reuse the attempt for receipts",
    "  work_move        move work to a lifecycle station; the runtime checks it",
    "  work_review      confirm, reopen, or consult on a move pending review",
    "  work_lifecycle   stations, where an item sits, and its recent moves",
    "  derived_read     a derived record on a work item, and whether it is current",
    "  derived_write    write a derived record against the version you read",
    "  derived_pending  work items that need a derived record",
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

  if (subcommand === "serve") {
    const rest = args.slice(1);
    const flag = (name: string) => {
      const index = rest.indexOf(name);
      return index === -1 ? undefined : rest[index + 1];
    };
    const host = flag("--host") ?? "127.0.0.1";
    // Identity comes from the local process on the other end of the socket.
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      throw new ScoutCliError("scout mcp serve listens on loopback only (127.0.0.1, localhost or ::1).");
    }
    const idleSeconds = flag("--idle-timeout");
    const { runSharedScoutMcpServer } = await import("../../mcp/shared-http.ts");
    await runSharedScoutMcpServer({
      host,
      port: Number(flag("--port") ?? 0),
      env: context.env,
      idleTimeoutMs: idleSeconds === undefined ? undefined : Number(idleSeconds) * 1000,
      notifications: rest.includes("--notifications") || rest.includes("--enable-notifications"),
    });
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
