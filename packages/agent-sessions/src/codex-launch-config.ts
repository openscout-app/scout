import { repoScoutEntrypoint } from "./repo-scout-entry.js";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ScoutMcpCommand = {
  command: string;
  args: string[];
  cwd: string;
};

function isExecutable(filePath: string | undefined | null): filePath is string {
  if (!filePath) {
    return false;
  }

  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniquePaths(values: Array<string | null | undefined>): string[] {
  return [...new Set(
    values
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => resolve(value)),
  )];
}

function ancestorChain(start: string): string[] {
  const chain: string[] = [];
  let current = resolve(start);

  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) {
      return chain;
    }
    current = parent;
  }
}

function resolveExecutableFromSearchPath(
  names: string[],
  env: Record<string, string | undefined>,
): string | null {
  const pathEntries = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const commonDirectories = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  for (const directory of [...pathEntries, ...commonDirectories]) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveBunExecutable(env: Record<string, string | undefined>): string | null {
  const explicitCandidates = [
    env.OPENSCOUT_BUN_BIN,
    env.SCOUT_BUN_BIN,
    env.BUN_BIN,
  ];

  for (const candidate of explicitCandidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  if (basename(process.execPath).startsWith("bun") && isExecutable(process.execPath)) {
    return process.execPath;
  }

  return resolveExecutableFromSearchPath(["bun"], env);
}

function resolveExplicitScoutExecutable(env: Record<string, string | undefined>): string | null {
  const explicitCandidates = [
    env.OPENSCOUT_CLI_BIN,
    env.SCOUT_CLI_BIN,
    env.OPENSCOUT_SCOUT_BIN,
    env.SCOUT_BIN,
  ];

  for (const candidate of explicitCandidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveRepoScoutScript(currentDirectory: string): string | null {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const starts = uniquePaths([currentDirectory, moduleDirectory]);

  for (const start of starts) {
    for (const candidate of ancestorChain(start)) {
      const scriptPath = repoScoutEntrypoint(candidate);
      if (existsSync(scriptPath)) {
        return scriptPath;
      }
    }
  }

  return null;
}

function resolveContextRoot(currentDirectory: string, env: Record<string, string | undefined>): string {
  const configured = env.OPENSCOUT_SETUP_CWD?.trim();
  return resolve(configured || currentDirectory);
}

function resolveScoutMcpCommand(options: {
  currentDirectory: string;
  env?: Record<string, string | undefined>;
}): ScoutMcpCommand | null {
  const env = options.env ?? process.env;
  const contextRoot = resolveContextRoot(options.currentDirectory, env);

  const scoutExecutable = resolveExplicitScoutExecutable(env);
  if (scoutExecutable) {
    return {
      command: scoutExecutable,
      args: ["mcp", "--context-root", contextRoot],
      cwd: contextRoot,
    };
  }

  // Explicit overrides win; a source checkout then uses its own CLI, not a
  // potentially stale installed scout found through PATH or a common directory.
  const scoutScript = resolveRepoScoutScript(options.currentDirectory);
  const bunExecutable = resolveBunExecutable(env);
  if (scoutScript && bunExecutable) {
    return {
      command: bunExecutable,
      args: [scoutScript, "mcp", "--context-root", contextRoot],
      cwd: contextRoot,
    };
  }

  const installedScout = resolveExecutableFromSearchPath(["scout"], env);
  return installedScout ? {
    command: installedScout,
    args: ["mcp", "--context-root", contextRoot],
    cwd: contextRoot,
  } : null;
}

export type CodexScoutMcpEntry = "url" | "command" | null | "unknown";

/** Runs `codex mcp get scout --json`; injectable for tests. */
export type CodexMcpGet = (codexExecutable: string, env: Record<string, string | undefined>, cwd?: string) => Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

const CODEX_MCP_GET_TIMEOUT_MS = 5_000;

// Async, so a launch never blocks the runtime's event loop on Codex.
const runCodexMcpGet: CodexMcpGet = (codexExecutable, env, cwd) => new Promise((resolve) => {
  let stdout = "";
  let stderr = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const finish = (status: number | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve({ status, stdout, stderr });
  };
  try {
    const child = spawn(codexExecutable, ["mcp", "get", "scout", "--json"], {
      env: env as NodeJS.ProcessEnv,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, CODEX_MCP_GET_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  } catch {
    finish(null);
  }
});

/**
 * How the Codex home (CODEX_HOME in `env`) declares the `scout` MCP server,
 * asked of Codex itself so its own config parser decides: a url entry (the
 * shared server, from `scout mcp install --shared`), a command entry
 * (stdio), none, or "unknown" when Codex could not say.
 */
export async function codexHomeScoutMcpEntry(
  env: Record<string, string | undefined>,
  codexExecutable: string,
  mcpGet: CodexMcpGet = runCodexMcpGet,
  cwd?: string,
): Promise<CodexScoutMcpEntry> {
  const result = await mcpGet(codexExecutable, env, cwd);
  if (result.status === 0) {
    try {
      const type = (JSON.parse(result.stdout) as { transport?: { type?: string } }).transport?.type;
      if (type === "stdio") return "command";
      if (type === "streamable_http" || type === "http" || type === "sse") return "url";
    } catch {
      // Fall through.
    }
    return "unknown";
  }
  return /No MCP server named/i.test(result.stderr) ? null : "unknown";
}

export type ScoutMcpCodexLaunch = {
  /** `-c` overrides for `codex app-server`. */
  args: string[];
  /** The app-server will reach Scout MCP over a URL: register it as a shared-server client. */
  usesUrl: boolean;
  /** Set when Codex could not report its scout entry; the home's config is then left as it is. */
  unknownReason: string | null;
};

export type ProfiledScoutMcp = {
  profile: string;
  enabledTools: string[];
};

// Codex starts stdio MCP servers with a short default environment. Forward
// names from the filtered harness environment, not values or service markers.
const PROFILED_SCOUT_MCP_ENV_VARS = [
  "OPENSCOUT_CLIENT_INSTANCE",
  "OPENSCOUT_REPLY_CONTEXT_FILE", "OPENSCOUT_AGENT", "OPENSCOUT_SESSION_ID",
  "OPENSCOUT_CREW_ROLE",
  "OPENSCOUT_HOME", "OPENSCOUT_SUPPORT_DIRECTORY", "OPENSCOUT_CONTROL_HOME",
  "OPENSCOUT_SCOUT_HOME", "OPENSCOUT_RELAY_HUB",
  "OPENSCOUT_BROKER_URL", "OPENSCOUT_BROKER_INTERNAL_URL", "OPENSCOUT_BROKER_HOST",
  "OPENSCOUT_BROKER_PORT", "OPENSCOUT_BROKER_SOCKET_PATH", "OPENSCOUT_BROKER_SOCKET_ONLY",
  "OPENSCOUT_WEB_PUBLIC_ORIGIN", "OPENSCOUT_WEB_HOST", "OPENSCOUT_WEB_PORT",
  "SCOUT_WEB_HOST", "SCOUT_WEB_PORT",
] as const;

/**
 * How a Scout-started Codex app-server gets Scout MCP. The Codex home's own
 * `scout` entry wins: with a url entry there are no overrides (stdio keys on
 * a url entry make Codex refuse the server). With no entry,
 * OPENSCOUT_MCP_SHARED_URL (set by the runtime while the shared server is on)
 * points Scout MCP at the shared server; otherwise, and over a stdio entry,
 * Scout MCP runs over stdio for this app-server. When Codex can't report the
 * entry, nothing is added, so a url entry is never mixed with stdio keys.
 * Without `codexExecutable` the home is not asked and stdio is used.
 * Scoutbot uses its own stdio server for `sessions,terminals`, even when shared
 * HTTP is configured. Its discovery tools must not widen the 14-tool default.
 */
export async function resolveScoutMcpCodexLaunch(options: {
  currentDirectory: string;
  env?: Record<string, string | undefined>;
  codexExecutable?: string | null;
  mcpGet?: CodexMcpGet;
  profiledScoutMcp?: ProfiledScoutMcp;
}): Promise<ScoutMcpCodexLaunch> {
  const env = options.env ?? process.env;
  const homeEntry = options.codexExecutable
    ? await codexHomeScoutMcpEntry(env, options.codexExecutable, options.mcpGet, options.profiledScoutMcp ? options.currentDirectory : undefined)
    : null;
  const unknownReason = homeEntry === "unknown"
    ? `\`${options.codexExecutable} mcp get scout --json\` did not report the scout MCP entry for CODEX_HOME=${env.CODEX_HOME ?? "~/.codex"}`
    : null;
  if (options.profiledScoutMcp) {
    const { profile, enabledTools } = options.profiledScoutMcp;
    if (unknownReason) throw new Error(`Cannot launch the dedicated Scout MCP profile: ${unknownReason}. Check the Codex MCP configuration and retry.`);
    const resolved = resolveScoutMcpCommand({ currentDirectory: options.currentDirectory, env });
    if (!resolved) throw new Error(`Scout MCP profile "${profile}" requires the Scout CLI; install Scout or set OPENSCOUT_CLI_BIN.`);
    // Codex merges config layers. Reusing the "scout" name could leave a
    // configured URL on the stdio entry, or expose a second, unfiltered server.
    return {
      args: [
        // An absent server cannot be disabled with a transport-less entry.
        ...(homeEntry ? ["-c", "mcp_servers.scout.enabled=false"] : []),
        "-c", "mcp_servers.scout_role.enabled=true",
        "-c", "mcp_servers.scout_role.required=true",
        "-c", `mcp_servers.scout_role.command=${JSON.stringify(resolved.command)}`,
        "-c", `mcp_servers.scout_role.args=${JSON.stringify([...resolved.args, "--profile", profile])}`,
        "-c", `mcp_servers.scout_role.cwd=${JSON.stringify(resolved.cwd)}`,
        "-c", `mcp_servers.scout_role.env_vars=${JSON.stringify(PROFILED_SCOUT_MCP_ENV_VARS)}`,
        "-c", `mcp_servers.scout_role.enabled_tools=${JSON.stringify(enabledTools)}`,
        "-c", 'mcp_servers.scout_role.default_tools_approval_mode="approve"',
      ],
      usesUrl: false,
      unknownReason: null,
    };
  }
  if (homeEntry === "url") {
    return { args: [], usesUrl: true, unknownReason: null };
  }
  if (unknownReason) {
    return {
      args: [],
      usesUrl: false,
      unknownReason: `${unknownReason}; Scout added no MCP overrides and left that home's config as it is`,
    };
  }
  const sharedUrl = env.OPENSCOUT_MCP_SHARED_URL?.trim();
  if (options.codexExecutable && !homeEntry && sharedUrl) {
    return { args: ["-c", `mcp_servers.scout.url=${JSON.stringify(sharedUrl)}`], usesUrl: true, unknownReason: null };
  }

  const resolved = resolveScoutMcpCommand({ currentDirectory: options.currentDirectory, env });
  if (!resolved) {
    return { args: [], usesUrl: false, unknownReason: null };
  }

  return {
    args: [
      "-c",
      `mcp_servers.scout.command=${JSON.stringify(resolved.command)}`,
      "-c",
      `mcp_servers.scout.args=${JSON.stringify(resolved.args)}`,
      "-c",
      `mcp_servers.scout.cwd=${JSON.stringify(resolved.cwd)}`,
      ...(env.OPENSCOUT_CREW_ROLE?.trim()
        ? ["-c", `mcp_servers.scout.env_vars=${JSON.stringify(PROFILED_SCOUT_MCP_ENV_VARS)}`]
        : []),
    ],
    usesUrl: false,
    unknownReason: null,
  };
}

/** The `-c` overrides alone; see resolveScoutMcpCodexLaunch. */
export async function buildScoutMcpCodexLaunchArgs(options: Parameters<typeof resolveScoutMcpCodexLaunch>[0]): Promise<string[]> {
  return (await resolveScoutMcpCodexLaunch(options)).args;
}

/**
 * Registers a Codex app-server pointed at the shared Scout MCP server, so a
 * drain keeps the server up for it: an empty file named by its pid in
 * OPENSCOUT_MCP_SHARED_CLIENTS_DIR (the runtime's shared-mcp.ts reads it).
 */
export function registerSharedScoutMcpClient(env: Record<string, string | undefined>, pid: number | null | undefined): string | null {
  const directory = env.OPENSCOUT_MCP_SHARED_CLIENTS_DIR?.trim();
  if (!directory || !pid) return null;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, String(pid)), "");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
