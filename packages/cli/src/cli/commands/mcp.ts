import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { SCOUT_MCP_LOCAL_DEFAULT_TOOLS } from "@openscout/protocol";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { LOCAL_MCP_TOOL_GROUPS, selectedLocalMcpProfile } from "../../mcp/local-tool-profile.ts";
import { runScoutMcpServer } from "../../mcp/scout-mcp.ts";
import { renderMcpInstallHelp, runMcpInstallCommand } from "./mcp-install.ts";
import { ScoutCliError } from "../errors.ts";

const serverFlags = {
  profile: { type: "string" },
  notifications: { type: "boolean" },
  "enable-notifications": { type: "boolean" },
} as const;

export function parseMcpCommandOptions(args: string[], defaultCurrentDirectory: string, env = process.env) {
  const { values } = parseArgs({ args, options: { ...serverFlags, "context-root": { type: "string" } } });
  return {
    currentDirectory: values["context-root"] === undefined ? defaultCurrentDirectory : resolve(values["context-root"]),
    enableNotifications: Boolean(values.notifications || values["enable-notifications"]),
    profile: selectedLocalMcpProfile(values.profile, env),
  };
}

export function parseMcpServeCommandOptions(args: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({ args, options: {
    ...serverFlags, host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" }, "idle-timeout": { type: "string" },
  } });
  // Identity comes from the local process on the other end of the socket.
  if (!["127.0.0.1", "localhost", "::1"].includes(values.host)) {
    throw new ScoutCliError("scout mcp serve listens on loopback only (127.0.0.1, localhost or ::1).");
  }
  return {
    host: values.host,
    port: Number(values.port),
    idleTimeoutMs: values["idle-timeout"] === undefined ? undefined : Number(values["idle-timeout"]) * 1000,
    notifications: Boolean(values.notifications || values["enable-notifications"]),
    profile: selectedLocalMcpProfile(values.profile, env),
  };
}

export function renderMcpCommandHelp(): string {
  return [
    "Usage:",
    "  scout mcp [--profile <selection>] [--context-root <path>] [--notifications]",
    "  scout mcp serve [--profile <selection>] [--port <n>] [--host 127.0.0.1] [--idle-timeout <seconds>] [--notifications]",
    "  scout mcp install [--profile <selection>] [--host <codex|claude|zed|antigravity>] [--shared] [--force] [--dry-run]",
    "",
    "Run a local MCP server over stdio, or use serve for one shared HTTP server.",
    "Both register the default coordination tools:",
    `  ${SCOUT_MCP_LOCAL_DEFAULT_TOOLS.join(", ")}`,
    "",
    "--profile full restores all tools. To add only selected groups to the default,",
    "pass a comma-separated list, for example --profile git,work. Available groups:",
    `  ${Object.keys(LOCAL_MCP_TOOL_GROUPS).join(", ")}`,
    "The flag overrides OPENSCOUT_MCP_PROFILE. Use --profile default for no groups.",
    "",
    "Route with tool fields, not quoted handles in the body. Use ask for tasks,",
    "ask with fyi=true for news, and reply by ref to answer an existing task.",
    "--notifications enables background MCP reply notifications.",
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
    const options = parseMcpServeCommandOptions(args.slice(1), context.env);
    const { runSharedScoutMcpServer } = await import("../../mcp/shared-http.ts");
    await runSharedScoutMcpServer({ ...options, env: context.env });
    return;
  }

  const options = parseMcpCommandOptions(args, defaultScoutContextDirectory(context), context.env);
  if (options.enableNotifications) {
    context.env.OPENSCOUT_MCP_ENABLE_NOTIFICATIONS = "1";
  }
  await runScoutMcpServer({
    defaultCurrentDirectory: options.currentDirectory,
    profile: options.profile,
    env: context.env,
  });
}
