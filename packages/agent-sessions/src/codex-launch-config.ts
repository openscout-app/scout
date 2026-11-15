import { repoScoutEntrypoint } from "./repo-scout-entry.js";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
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
export type CodexMcpGet = (codexExecutable: string, env: Record<string, string | undefined>) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const runCodexMcpGet: CodexMcpGet = (codexExecutable, env) => {
  const result = spawnSync(codexExecutable, ["mcp", "get", "scout", "--json"], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * How the Codex home (CODEX_HOME in `env`) declares the `scout` MCP server,
 * asked of Codex itself so its own config parser decides: a url entry (the
 * shared server, from `scout mcp install --shared`), a command entry
 * (stdio), none, or "unknown" when Codex could not say.
 */
export function codexHomeScoutMcpEntry(
  env: Record<string, string | undefined>,
  codexExecutable: string,
  mcpGet: CodexMcpGet = runCodexMcpGet,
): CodexScoutMcpEntry {
  const result = mcpGet(codexExecutable, env);
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

/**
 * The `-c` overrides that give a Scout-started Codex app-server Scout MCP.
 * The Codex home's own `scout` entry wins: with a url entry there are no
 * overrides (stdio keys on a url entry make Codex refuse the server). With no
 * entry, OPENSCOUT_MCP_SHARED_URL (set by the runtime while the shared server
 * is on) points Scout MCP at the shared server. Otherwise, or when Codex
 * can't say, Scout MCP runs over stdio for this app-server, as before.
 * Without `codexExecutable` the home is not asked and stdio is used.
 */
export function buildScoutMcpCodexLaunchArgs(options: {
  currentDirectory: string;
  env?: Record<string, string | undefined>;
  codexExecutable?: string | null;
  mcpGet?: CodexMcpGet;
}): string[] {
  const env = options.env ?? process.env;
  const homeEntry = options.codexExecutable
    ? codexHomeScoutMcpEntry(env, options.codexExecutable, options.mcpGet)
    : "unknown";
  if (homeEntry === "url") {
    return [];
  }
  const sharedUrl = env.OPENSCOUT_MCP_SHARED_URL?.trim();
  if (!homeEntry && sharedUrl) {
    return ["-c", `mcp_servers.scout.url=${JSON.stringify(sharedUrl)}`];
  }

  const resolved = resolveScoutMcpCommand({ currentDirectory: options.currentDirectory, env });
  if (!resolved) {
    return [];
  }

  return [
    "-c",
    `mcp_servers.scout.command=${JSON.stringify(resolved.command)}`,
    "-c",
    `mcp_servers.scout.args=${JSON.stringify(resolved.args)}`,
    "-c",
    `mcp_servers.scout.cwd=${JSON.stringify(resolved.cwd)}`,
  ];
}
