import { DEFAULT_OPENSCOUT_MESH_RELAY_URL } from "@openscout/protocol";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import {
  LEGACY_MESH_BRIDGE_LAUNCH_AGENT_LABEL,
  MESH_BRIDGE_EXIT_UNCONFIGURED,
  inspectLaunchdJob,
  legacyMeshBridgeLaunchAgentPath,
  legacyMeshBridgeLaunchdTarget,
  meshBridgeConfigPath,
  meshBridgeStatePath,
  waitForLaunchdJobAbsent,
} from "@openscout/runtime";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/config";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import {
  MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE,
  connectMeshBridge,
  deleteKeychainSecret,
  revokeMeshBridgeCredential,
  storeKeychainSecret,
} from "../../mcp/mesh-bridge-connect.ts";
import {
  SCOUT_MCP_CORE_TOOLS,
  meshBridgeTokenFilePath,
  readKeychainSecret,
  resolveBridgeTokenFromConfig,
  startScoutMeshMcpBridge,
  type ScoutMeshBridgeConfigFile,
} from "../../mcp/mesh-bridge.ts";

const MESH_BRIDGE_HELP = `scout mesh bridge — Hold the outbound MCP relay connection for this node

Serves the Scout MCP tool surface to remote MCP clients via a mesh-front-door
relay. Caller identity comes from the relay's agent tokens; each identity gets
its own pinned server instance. Spec: docs/eng/sco-095-remote-mcp-gateway.md.

Usage:
  scout mesh bridge connect [--node <id>] [--label <name>] [--no-open]
                                                  Sign in and connect this Mac
  scout mesh bridge disconnect                    Revoke this Mac's connection
  scout mesh bridge token <agent> [--label <name>]
                                                  Mint a token for a remote agent
  scout mesh bridge token list                    List agent tokens
  scout mesh bridge token revoke <id>             Revoke an agent token
  scout mesh bridge [--config <path>] [options]   Run in the foreground
  scout mesh bridge token <agent> [--label <name>]  Mint a token for a remote agent
  scout mesh bridge token list                    List agent tokens
  scout mesh bridge token revoke <id>             Revoke an agent token
  scout mesh bridge install [options]             Enable it under the Scout service
  scout mesh bridge uninstall                     Disable it (config kept)
  scout mesh bridge status                        Show service state

\`connect\` opens the browser, you sign in with GitHub and approve, and the
bridge gets its own credential for your account. MCP clients you approve at
mcp.oscout.net (Claude, ChatGPT, Grok Bot) then reach Scout on this Mac.

\`token\` gives an agent outside your machines (a cloud VM, a sandbox, a hosted
assistant) its own Scout identity on this node. The token goes to the clipboard,
never to the terminal, for the agent's secure credential prompt. Agents can
also sign themselves in with \`scout login\` and a code you approve.

The installed bridge is a child of scout-base: it restarts, upgrades and stops
with the rest of the Scout service.

Options (run + install):
  --relay <url>       MCP relay base URL (default: ${DEFAULT_OPENSCOUT_MESH_RELAY_URL})
  --token <bearer>    Relay infra token; prefer --token-keychain
  --token-keychain <service>
                      Read the token from the macOS keychain (default:
                      OPENSCOUT_MCP_BRIDGE_TOKEN)
  --sender <id>       Fallback identity for tokenless envelopes
                      (default: grokbot.spike)
  --node <id>         Node name in the relay (default: default)
  --tools <csv>       "core" (default) or explicit tool list
  --dir <path>        currentDirectory for tool resolution
  --config <path>     JSON config file; flags override its values
`;

/** The retired launchd job that used to own the suite's own mesh bridge. */
export const LAUNCH_AGENT_LABEL = LEGACY_MESH_BRIDGE_LAUNCH_AGENT_LABEL;

/** The same support directory scout-base resolves, so both see one config. */
function supportDirectory(): string {
  return resolveOpenScoutSupportPaths().supportDirectory;
}

function defaultConfigPath(): string {
  return meshBridgeConfigPath(supportDirectory());
}

function launchAgentPlistPath(): string {
  return legacyMeshBridgeLaunchAgentPath(homedir());
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1]?.trim() || undefined;
}

export function meshBridgeSecretDefaults(input: {
  explicitToken: boolean;
  tokenKeychainFromFlag?: string;
  tokenKeychainFromFile?: string;
  tokenFileFromFlag?: string;
  tokenFileFromFile?: string;
  supportDirectory: string;
}): { tokenKeychainService?: string; tokenFile?: string } {
  const tokenKeychainService = input.tokenKeychainFromFlag
    ?? input.tokenKeychainFromFile
    ?? (process.platform === "darwin" && !input.explicitToken ? "OPENSCOUT_MCP_BRIDGE_TOKEN" : undefined);
  const tokenFile = input.tokenFileFromFlag
    ?? input.tokenFileFromFile
    ?? (process.platform !== "darwin" && !input.explicitToken
      ? meshBridgeTokenFilePath(input.supportDirectory)
      : undefined);
  return {
    ...(tokenKeychainService ? { tokenKeychainService } : {}),
    ...(tokenFile ? { tokenFile } : {}),
  };
}

type LaunchctlSpawn = (command: string[]) => {
  exitCode: number | null;
  stdout: { toString(): string };
  stderr: { toString(): string };
};

export function runMeshBridgeLaunchctl(
  args: string[],
  spawn: LaunchctlSpawn = (command) => Bun.spawnSync(command),
): { ok: boolean; output: string } {
  if (process.platform !== "darwin") {
    return { ok: false, output: "launchctl is not applicable off darwin" };
  }
  const result = spawn(["launchctl", ...args]);
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  return { ok: result.exitCode === 0, output };
}

export function meshBridgeHelp(): string {
  if (process.platform === "darwin") return MESH_BRIDGE_HELP;
  return MESH_BRIDGE_HELP.replace(
    `  --token <bearer>    Relay infra token; prefer --token-keychain
  --token-keychain <service>
                      Read the token from the macOS keychain (default:
                      OPENSCOUT_MCP_BRIDGE_TOKEN)
`,
    `  --token <bearer>    Relay infra token; prefer --token-file
  --token-file <path> Read the token from a mode-0600 file (default:
                      <support-directory>/mcp-bridge.token)
`,
  );
}

function loadConfigFile(path: string): ScoutMeshBridgeConfigFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ScoutMeshBridgeConfigFile;
}

function resolveRunOptions(context: ScoutCommandContext, args: string[]): {
  config: ScoutMeshBridgeConfigFile;
  configPath: string;
} | { error: string } {
  const configPath = readFlag(args, "--config") ?? defaultConfigPath();
  const fromFile = loadConfigFile(configPath) ?? { relayUrl: DEFAULT_OPENSCOUT_MESH_RELAY_URL };
  const explicitToken = Boolean(readFlag(args, "--token") || fromFile.token);
  const secrets = meshBridgeSecretDefaults({
    explicitToken,
    tokenKeychainFromFlag: readFlag(args, "--token-keychain"),
    tokenKeychainFromFile: fromFile.tokenKeychainService,
    tokenFileFromFlag: readFlag(args, "--token-file"),
    tokenFileFromFile: fromFile.tokenFile,
    supportDirectory: supportDirectory(),
  });

  const config: ScoutMeshBridgeConfigFile = {
    relayUrl: readFlag(args, "--relay") ?? fromFile.relayUrl ?? DEFAULT_OPENSCOUT_MESH_RELAY_URL,
    token: readFlag(args, "--token") ?? fromFile.token,
    tokenKeychainService: secrets.tokenKeychainService,
    tokenFile: secrets.tokenFile,
    sender: readFlag(args, "--sender") ?? fromFile.sender ?? "grokbot.spike",
    node: readFlag(args, "--node") ?? fromFile.node ?? "default",
    tools: (() => {
      const flag = readFlag(args, "--tools");
      if (!flag) return fromFile.tools ?? "core";
      return flag === "core" ? "core" : flag.split(",").map((name) => name.trim()).filter(Boolean);
    })(),
    dir: readFlag(args, "--dir") ?? fromFile.dir,
  };
  if (!config.relayUrl) {
    return { error: "Missing relay URL: pass --relay or set relayUrl in the config file." };
  }
  return { config, configPath };
}

async function runBridge(context: ScoutCommandContext, args: string[]): Promise<void> {
  const resolved = resolveRunOptions(context, args);
  if ("error" in resolved) {
    context.stderr(resolved.error);
    process.exitCode = 1;
    return;
  }
  const { config } = resolved;

  const token = resolveBridgeTokenFromConfig(config, { supportDirectory: supportDirectory() })
    ?? context.env.OPENSCOUT_MCP_RELAY_TOKEN?.trim()
    ?? context.env.OPENSCOUT_MESH_RENDEZVOUS_TOKEN?.trim();
  if (!token) {
    const lookedIn = process.platform === "darwin" ? "flag, config, keychain, or env" : "flag, config, token file, or env";
    context.stderr(`No relay token found (${lookedIn}). See: scout mesh bridge --help`);
    process.exitCode = MESH_BRIDGE_EXIT_UNCONFIGURED;
    return;
  }

  const relayUrl = new URL(config.relayUrl);
  if (config.node && !relayUrl.searchParams.get("node")) {
    relayUrl.searchParams.set("node", config.node);
  }
  const toolNames = config.tools === "core" || !config.tools
    ? [...SCOUT_MCP_CORE_TOOLS]
    : config.tools;

  const handle = await startScoutMeshMcpBridge({
    relayUrl: relayUrl.toString(),
    token,
    senderId: config.sender ?? "grokbot.spike",
    currentDirectory: config.dir ?? defaultScoutContextDirectory(context),
    toolNames,
    env: context.env,
    log: (line) => context.stderr(line),
  });

  context.stderr(`bridge: node=${config.node} relay=${config.relayUrl}`);
  context.stderr("bridge: running — Ctrl-C to stop");

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      // A wedged identity server must not turn shutdown into a zombie:
      // give graceful close a bounded window, then exit regardless.
      const force = setTimeout(() => process.exit(0), 5_000);
      void handle.close().finally(() => {
        clearTimeout(force);
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // Under scout-base, exit with the supervisor rather than hold the relay
    // connection as an orphan.
    const parentPid = Number.parseInt(context.env.OPENSCOUT_PARENT_PID ?? "0", 10);
    if (Number.isFinite(parentPid) && parentPid > 0 && parentPid !== process.pid) {
      setInterval(() => {
        try {
          process.kill(parentPid, 0);
        } catch {
          context.stderr(`bridge: parent ${parentPid} is gone, stopping`);
          stop();
        }
      }, 2_000).unref();
    }
  });
  process.exit(process.exitCode ?? 0);
}

function launchctl(_context: ScoutCommandContext, args: string[]): { ok: boolean; output: string } {
  return runMeshBridgeLaunchctl(args);
}

async function installBridge(context: ScoutCommandContext, args: string[]): Promise<void> {
  const resolved = resolveRunOptions(context, args);
  if ("error" in resolved) {
    context.stderr(resolved.error);
    process.exitCode = 1;
    return;
  }
  // `--config` names a file to install FROM; scout-base only watches the
  // default path, so that is always what gets written.
  const { config } = resolved;
  const configPath = defaultConfigPath();
  if (!resolveBridgeTokenFromConfig(config, { supportDirectory: supportDirectory() })) {
    if (process.platform === "darwin") {
      context.stderr(
        `No token reachable at install time (keychain service: ${config.tokenKeychainService ?? "none"}). `
        + "Add it first: security add-generic-password -a openscout -s OPENSCOUT_MCP_BRIDGE_TOKEN -w <token>",
      );
    } else {
      const tokenPath = config.tokenFile ?? meshBridgeTokenFilePath(supportDirectory());
      context.stderr(
        `No token reachable at install time. Write the relay token to ${tokenPath} with mode 0600, or pass --token.`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // Retire the LaunchAgent before enabling the config so the two never both
  // hold this node's relay connection; scout-base defers to it while it exists.
  if (!(await retireLegacyLaunchAgent(context))) {
    process.exitCode = 1;
    return;
  }

  mkdirSync(supportDirectory(), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ ...config, enabled: true }, null, 2)}\n`);
  chmodSync(configPath, 0o600);

  context.stdout("Enabled the mesh bridge under the Scout service (scout-base starts it within a few seconds).");
  context.stdout(`  config: ${configPath}`);
  context.stdout(`  logs:   ${join(supportDirectory(), "logs", "base", "mesh-bridge.stderr.log")}`);
}

/**
 * Boot out and delete the legacy LaunchAgent. Its plist is what keeps
 * scout-base from starting a second bridge, so this fails closed: the plist is
 * deleted only once launchd confirms the job is absent, and a job still loaded
 * without its plist is booted out too. False means it may still be running.
 */
async function retireLegacyLaunchAgent(context: ScoutCommandContext): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const plistPath = launchAgentPlistPath();
  const target = legacyMeshBridgeLaunchdTarget();
  let state = inspectLaunchdJob(target);
  let bootoutOutput = "";
  if (state === "loaded") {
    bootoutOutput = launchctl(context, ["bootout", target]).output;
    state = await waitForLaunchdJobAbsent(target);
  }
  if (state !== "absent") {
    context.stderr(
      `Could not retire ${LAUNCH_AGENT_LABEL}: launchd reports it ${state === "loaded" ? "still loaded" : "in an unknown state"}`
      + `${bootoutOutput ? ` (bootout: ${bootoutOutput})` : ""}. `
      + (existsSync(plistPath) ? `Left ${plistPath} in place so scout-base keeps deferring to it.` : "scout-base will defer until it is gone."),
    );
    return false;
  }
  if (existsSync(plistPath)) {
    unlinkSync(plistPath);
    context.stdout(`Retired the ${LAUNCH_AGENT_LABEL} LaunchAgent.`);
  }
  return true;
}

async function uninstallBridge(context: ScoutCommandContext): Promise<void> {
  if (!(await retireLegacyLaunchAgent(context))) {
    process.exitCode = 1;
    return;
  }
  const configPath = defaultConfigPath();
  const config = loadConfigFile(configPath);
  if (!config) {
    context.stdout("mesh bridge: not configured");
    return;
  }
  writeFileSync(configPath, `${JSON.stringify({ ...config, enabled: false }, null, 2)}\n`);
  chmodSync(configPath, 0o600);
  context.stdout("Disabled the mesh bridge; scout-base stops it within a few seconds (config kept).");
}

type BaseMeshBridgeState = {
  state?: string;
  pid?: number | null;
  reason?: string;
  entrypoint?: string;
  updatedAt?: number;
};

async function bridgeStatus(context: ScoutCommandContext): Promise<void> {
  if (process.platform === "darwin" && (existsSync(launchAgentPlistPath()) || inspectLaunchdJob(legacyMeshBridgeLaunchdTarget()) === "loaded")) {
    const result = launchctl(context, ["print", legacyMeshBridgeLaunchdTarget()]);
    const pid = result.output.match(/pid = (\d+)/)?.[1];
    context.stdout(`mesh bridge: legacy LaunchAgent ${LAUNCH_AGENT_LABEL}${pid ? ` (pid ${pid})` : ""}`);
    context.stdout("  run `scout mesh bridge install` to hand it to scout-base");
    return;
  }
  const statePath = meshBridgeStatePath(supportDirectory());
  let state: BaseMeshBridgeState | null = null;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as BaseMeshBridgeState;
  } catch {
    state = null;
  }
  if (!state) {
    context.stdout(loadConfigFile(defaultConfigPath()) ? "mesh bridge: configured; scout-base has not reported it yet" : "mesh bridge: not configured");
    return;
  }
  const pidAlive = typeof state.pid === "number" && isProcessAlive(state.pid);
  const label = state.state === "running" && !pidAlive ? "stale (scout-base not running?)" : state.state ?? "unknown";
  context.stdout(`mesh bridge: ${label}${pidAlive ? ` (pid ${state.pid})` : ""}${state.reason ? ` — ${state.reason}` : ""}`);
  if (state.entrypoint) context.stdout(`  entrypoint: ${state.entrypoint}`);
  context.stdout(`  logs: ${join(supportDirectory(), "logs", "base", "mesh-bridge.stderr.log")}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function connectBridge(context: ScoutCommandContext, args: string[]): Promise<void> {
  const existing = loadConfigFile(defaultConfigPath());
  const relayUrl = readFlag(args, "--relay") ?? existing?.relayUrl ?? DEFAULT_OPENSCOUT_MESH_RELAY_URL;
  const node = (readFlag(args, "--node") ?? existing?.node ?? "default").toLowerCase();
  const label = readFlag(args, "--label") ?? hostname().replace(/\.local$/, "");
  const openBrowser = !args.includes("--no-open");

  let result;
  try {
    result = await connectMeshBridge({
      relayUrl,
      node,
      label,
      openUrl: (url) => {
        context.stdout(openBrowser ? "Opening your browser to approve this Mac. If it doesn't open, visit:" : "Visit this URL to approve this Mac:");
        context.stdout(`  ${url}`);
        if (openBrowser) Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
      },
    });
  } catch (error) {
    context.stderr(`Not connected: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (!storeKeychainSecret(MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE, result.credential)
    || readKeychainSecret(MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE) !== result.credential) {
    await revokeMeshBridgeCredential(relayUrl, result.credential).catch(() => false);
    context.stderr(`Could not save the bridge credential to the keychain (${MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE}); revoked it.`);
    process.exitCode = 1;
    return;
  }

  if (!(await retireLegacyLaunchAgent(context))) {
    process.exitCode = 1;
    return;
  }
  const { token: _dropped, ...kept } = existing ?? { relayUrl };
  const config: ScoutMeshBridgeConfigFile & { enabled: true } = {
    ...kept,
    relayUrl,
    tokenKeychainService: MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE,
    node: result.node,
    sender: existing?.sender ?? "remote-agent",
    tools: existing?.tools ?? "core",
    enabled: true,
  };
  mkdirSync(supportDirectory(), { recursive: true });
  writeFileSync(defaultConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(defaultConfigPath(), 0o600);

  context.stdout(`Connected ${label} to ${result.account || "your account"} (node ${result.node}).`);
  context.stdout("The Scout service starts the bridge within a few seconds; check with `scout mesh bridge status`.");
  context.stdout(`Next: add ${relayUrl} as a connector in Claude, ChatGPT, or any MCP client.`);
}

async function disconnectBridge(context: ScoutCommandContext): Promise<void> {
  const configPath = defaultConfigPath();
  const config = loadConfigFile(configPath);
  const credential = readKeychainSecret(MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE);
  if (credential) {
    const revoked = await revokeMeshBridgeCredential(config?.relayUrl ?? DEFAULT_OPENSCOUT_MESH_RELAY_URL, credential).catch(() => false);
    if (!revoked) {
      context.stderr("Could not reach the gateway to revoke the credential; kept it so you can retry.");
      process.exitCode = 1;
      return;
    }
    deleteKeychainSecret(MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE);
  }
  if (config && config.tokenKeychainService === MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE) {
    writeFileSync(configPath, `${JSON.stringify({ ...config, enabled: false }, null, 2)}\n`);
    chmodSync(configPath, 0o600);
  }
  context.stdout(credential ? "Disconnected this Mac: credential revoked and the bridge stopped." : "mesh bridge: this Mac has no self-serve connection");
}

/** The infra bearer that may administer agent tokens: the operator relay token. */
function tokenAdminBearer(): { relayUrl: string; node: string; bearer: string } | { error: string } {
  const config = loadConfigFile(defaultConfigPath());
  const relayUrl = config?.relayUrl ?? DEFAULT_OPENSCOUT_MESH_RELAY_URL;
  const node = config?.node ?? "default";
  const service = config?.tokenKeychainService?.trim();
  if (service === MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE) {
    return { error: "This Mac's self-serve bridge credential cannot mint agent tokens. Mint one at the gateway as the account owner." };
  }
  const bearer = config ? resolveBridgeTokenFromConfig(config) : readKeychainSecret("OPENSCOUT_MCP_BRIDGE_TOKEN");
  if (!bearer) {
    return { error: "No relay token on this Mac. Run `scout mesh bridge connect` first." };
  }
  return { relayUrl, node, bearer };
}

async function tokenAdminFetch(
  admin: { relayUrl: string; bearer: string },
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL(path, admin.relayUrl), {
    ...init,
    headers: { authorization: `Bearer ${admin.bearer}`, "content-type": "application/json" },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, body };
}

async function agentTokenCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const admin = tokenAdminBearer();
  if ("error" in admin) {
    context.stderr(admin.error);
    process.exitCode = 1;
    return;
  }
  const [action, target] = args;
  if (!action || action.startsWith("-")) {
    context.stderr("Usage: scout mesh bridge token <agent> [--label <name>] | list | revoke <id>");
    process.exitCode = 1;
    return;
  }

  if (action === "list") {
    const { status, body } = await tokenAdminFetch(admin, "/v1/mcp/tokens");
    if (status !== 200) {
      context.stderr(`Could not list tokens (${status}): ${String(body.error ?? "unknown error")}`);
      process.exitCode = 1;
      return;
    }
    const tokens = (body.tokens ?? []) as Array<{ id: string; agentId: string; label: string | null; node: string; revokedAt: string | null; lastUsedAt: string | null }>;
    const live = tokens.filter((token) => !token.revokedAt);
    if (live.length === 0) {
      context.stdout("No agent tokens.");
      return;
    }
    for (const token of live) {
      const used = token.lastUsedAt ? `last used ${token.lastUsedAt}` : "never used";
      context.stdout(`${token.id}  ${token.agentId}  node=${token.node}  ${token.label ?? ""}  ${used}`.replace(/ {3,}/g, "  "));
    }
    return;
  }

  if (action === "revoke") {
    if (!target) {
      context.stderr("Usage: scout mesh bridge token revoke <id>");
      process.exitCode = 1;
      return;
    }
    const { status } = await tokenAdminFetch(admin, `/v1/mcp/tokens/${encodeURIComponent(target)}`, { method: "DELETE" });
    if (status !== 200) {
      context.stderr(status === 404 ? `No token ${target}.` : `Could not revoke (${status}).`);
      process.exitCode = 1;
      return;
    }
    context.stdout(`Revoked ${target}.`);
    return;
  }

  const agent = action.trim().toLowerCase();
  const { status, body } = await tokenAdminFetch(admin, "/v1/mcp/tokens", {
    method: "POST",
    body: JSON.stringify({ agent, label: readFlag(args, "--label") ?? `${agent} (remote)`, node: admin.node }),
  });
  if (status !== 201 || typeof body.token !== "string") {
    context.stderr(`Could not mint a token (${status}): ${String(body.detail ?? body.error ?? "unknown error")}`);
    process.exitCode = 1;
    return;
  }
  const record = body.record as { id: string; node: string };
  // The token never reaches stdout, where it would land in scrollback and logs.
  const copied = Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(body.token) }).exitCode === 0;
  if (!copied) {
    await tokenAdminFetch(admin, `/v1/mcp/tokens/${encodeURIComponent(record.id)}`, { method: "DELETE" });
    context.stderr("Could not copy the token to the clipboard, so it was revoked instead of printed.");
    process.exitCode = 1;
    return;
  }
  context.stdout(`Copied a token for ${agent} (node ${record.node}) to the clipboard. It is not shown.`);
  context.stdout("Paste it only into the agent's secure credential prompt, never into a chat.");
  context.stdout(`Revoke it with: scout mesh bridge token revoke ${record.id}`);
}

export async function runMeshBridgeCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const subcommand = args[0];
  if (process.platform !== "darwin" && ["connect", "disconnect", "token"].includes(subcommand ?? "")) {
    context.stderr("Self-service bridge credentials currently require macOS Keychain. On Linux, use the documented mode-0600 token-file bridge configuration; no sign-in or credential change was started.");
    process.exitCode = 1;
    return;
  }
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    context.stdout(meshBridgeHelp());
    return;
  }
  if (subcommand === "connect") {
    return connectBridge(context, args.slice(1));
  }
  if (subcommand === "disconnect") {
    return disconnectBridge(context);
  }
  if (subcommand === "token") {
    return agentTokenCommand(context, args.slice(1));
  }
  if (subcommand === "install") {
    return installBridge(context, args.slice(1));
  }
  if (subcommand === "uninstall") {
    return uninstallBridge(context);
  }
  if (subcommand === "status") {
    return bridgeStatus(context);
  }
  return runBridge(context, args);
}
