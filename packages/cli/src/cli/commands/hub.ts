import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  connectClaudeCode,
  connectManagedAgents,
  disconnectClaudeCode,
  HubCollectorService,
  HubInboxClient,
  isValidManagedAgentsLabel,
  loadManagedAgentsConfig,
  ManagedAgentsPuller,
  readManagedAgentsStatus,
  removeManagedAgentsConfig,
  resolveManagedAgentsMirrorRoot,
  loadHubConfig,
  loadHubIdentity,
  loadOrCreateHubIdentity,
  newHubToken,
  normalizeInboxUrl,
  resolveHubClaudeMirrorRoot,
  resolveHubHome,
  saveHubConfig,
  type HubConfig,
  type HubCollectSummary,
} from "@openscout/runtime/hub";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

type HubCommand = "status" | "init" | "connect" | "disconnect" | "collect";
type HubOptions = {
  command: HubCommand;
  target?: string;
  path?: string;
  inbox?: string;
  label?: string;
  readToken?: string;
  writeToken?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  sinceDays?: string;
  json: boolean;
  help: boolean;
};

export function renderHubCommandHelp(): string {
  return [
    "Usage:",
    "  scout hub [status]",
    "  scout hub init --inbox <url> [--read-token <t> --write-token <t>]",
    "  scout hub connect claude-code [<repo>] [--label <name>]",
    "  scout hub connect managed-agents [--label <name>] [--api-key-env <VAR>] [--since-days <n>]",
    "  scout hub disconnect claude-code [<repo>]",
    "  scout hub disconnect managed-agents",
    "  scout hub collect",
    "",
    "Scout Hub brings agent sessions that run in a vendor's cloud into this runtime.",
    "A reporter in the sandbox seals new transcript bytes to this runtime's key and",
    "posts them to your inbox. The runtime collects them into local copies that Scout",
    "reads like any other session. The inbox cannot read what it holds.",
    "",
    "init        Create this runtime's key pair and save the inbox URL and tokens.",
    "            Without tokens, it makes new ones and prints the commands that put",
    "            them on the inbox.",
    "connect     Write the reporter, its config and gated hooks into a repo. Review and",
    "            commit them; cloud sessions of that repo then report. Local sessions",
    "            skip the hooks.",
    "            For managed-agents: read Claude Managed Agents sessions with an API key.",
    "            The key is read from $ANTHROPIC_API_KEY (or --api-key-env) and kept in",
    "            the hub folder, readable only by you. No inbox is needed; the runtime",
    "            pulls each workspace's recent sessions and their events every 15 seconds.",
    "            Only sessions created in the last --since-days (default 7) are listed;",
    "            older sessions stop syncing.",
    "disconnect  Take Scout's hooks and files out of a repo, or forget the API key.",
    "collect     Collect waiting chunks and pull Managed Agents sessions now.",
    "status      Show the inbox, what is waiting, and the mirrored sessions.",
  ].join("\n");
}

export function parseHubCommandOptions(args: string[]): HubOptions {
  const result: HubOptions = { command: "status", json: false, help: false };
  const positional: string[] = [];
  const valueFlags: Record<string, keyof HubOptions> = {
    "--inbox": "inbox", "--label": "label", "--read-token": "readToken", "--write-token": "writeToken",
    "--api-key-env": "apiKeyEnv", "--base-url": "baseUrl", "--since-days": "sinceDays",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h" || arg === "help") return { ...result, help: true };
    if (arg === "--json") { result.json = true; continue; }
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const key = valueFlags[flag];
    if (key) {
      const value = inline ?? args[++index];
      if (!value) throw new ScoutCliError(`${flag} needs a value`);
      (result as Record<string, unknown>)[key] = value;
      continue;
    }
    if (arg.startsWith("-")) throw new ScoutCliError(`Unknown hub option: ${arg}`);
    positional.push(arg);
  }
  const command = (positional.shift() ?? "status") as HubCommand;
  if (!["status", "init", "connect", "disconnect", "collect"].includes(command)) throw new ScoutCliError(`Unknown hub command: ${command}`);
  result.command = command;
  if (command === "connect" || command === "disconnect") {
    const target = positional.shift();
    if (target !== "claude-code" && target !== "managed-agents") {
      throw new ScoutCliError(`scout hub ${command} needs a platform: claude-code or managed-agents`);
    }
    result.target = target;
    if (target === "claude-code") result.path = positional.shift();
  }
  if (positional.length > 0) throw new ScoutCliError(`Unexpected argument: ${positional[0]}`);
  if ((result.readToken && !result.writeToken) || (!result.readToken && result.writeToken)) {
    throw new ScoutCliError("Pass both --read-token and --write-token, or neither.");
  }
  return result;
}

function requireConfig(): HubConfig {
  const config = loadHubConfig();
  if (!config) throw new ScoutCliError("Scout Hub is not set up on this runtime. Run `scout hub init --inbox <url>` first.");
  return config;
}

function runInit(options: HubOptions): { value: Record<string, unknown>; text: string } {
  if (!options.inbox) throw new ScoutCliError("scout hub init needs --inbox <url>");
  let inbox: string;
  try {
    inbox = normalizeInboxUrl(options.inbox);
  } catch (error) {
    throw new ScoutCliError(error instanceof Error ? error.message : String(error));
  }
  const previous = loadHubConfig();
  const generated = !options.readToken;
  const config: HubConfig = {
    v: 1,
    inbox,
    readToken: options.readToken ?? previous?.readToken ?? newHubToken("shr"),
    writeToken: options.writeToken ?? previous?.writeToken ?? newHubToken("shw"),
    createdAt: previous?.createdAt || new Date().toISOString(),
  };
  const identity = loadOrCreateHubIdentity();
  saveHubConfig(config);
  const publicKey = Buffer.from(identity.publicKey).toString("base64url");
  const lines = [
    `Scout Hub is set up. Config and key: ${resolveHubHome()} (only you can read them).`,
    `Inbox: ${inbox}`,
    `Runtime public key: ${publicKey}`,
  ];
  if (generated && !previous) {
    lines.push(
      "",
      "New tokens were made. Put them on the inbox (from integrations/hub-inbox):",
      `  printf %s '${config.readToken}' | bunx wrangler@4 secret put READ_TOKEN`,
      `  printf %s '${config.writeToken}' | bunx wrangler@4 secret put WRITE_TOKEN`,
    );
  }
  lines.push("", "Next: scout hub connect claude-code <repo>");
  return { value: { inbox, home: resolveHubHome(), publicKey, tokensGenerated: generated && !previous }, text: lines.join("\n") };
}

function runConnect(options: HubOptions, cwd: string): { value: Record<string, unknown>; text: string } {
  const config = requireConfig();
  const identity = loadHubIdentity();
  if (!identity) throw new ScoutCliError("This runtime has no Scout Hub key. Run `scout hub init --inbox <url>`.");
  const repoRoot = resolve(cwd, options.path ?? ".");
  let result;
  try {
    result = connectClaudeCode({ repoRoot, config, recipientPublicKey: identity.publicKey, label: options.label });
  } catch (error) {
    throw new ScoutCliError(error instanceof Error ? error.message : String(error));
  }
  const host = new URL(config.inbox).host;
  const text = [
    result.changed.length ? `Connected ${result.repoRoot} as "${result.label}". Changed: ${result.changed.join(", ")}.` : `Already connected as "${result.label}"; nothing changed.`,
    `Reporter v${result.reporterVersion}, sha256 ${result.reporterSha256}`,
    "",
    "Next:",
    "  1. Review and commit .claude/scout/ and .claude/settings.json, then push.",
    "     hub.json holds a write-only token: it can add sealed chunks to your inbox and nothing else.",
    `  2. If the repo's cloud environment limits network access, allow ${host}.`,
    "  3. Start a cloud session on the repo. It shows up in Scout within about a minute of its first tool call.",
  ].join("\n");
  return { value: { ...result }, text };
}

async function runConnectManagedAgents(options: HubOptions): Promise<{ value: Record<string, unknown>; text: string }> {
  const envName = options.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[envName]?.trim();
  if (!apiKey) throw new ScoutCliError(`Set ${envName} to an API key of the workspace whose sessions Scout should read.`);
  const previous = loadManagedAgentsConfig();
  const label = options.label ?? previous?.label ?? "anthropic";
  if (!isValidManagedAgentsLabel(label)) throw new ScoutCliError(`--label "${label}" must be letters, digits, dot, dash or underscore`);
  const lookbackDays = options.sinceDays ? Number.parseInt(options.sinceDays, 10) : previous?.lookbackDays ?? 7;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) throw new ScoutCliError("--since-days must be a whole number from 1 to 90");
  const config = {
    v: 1 as const, label, apiKey, lookbackDays,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : previous?.baseURL ? { baseURL: previous.baseURL } : {}),
    createdAt: previous?.createdAt || new Date().toISOString(),
  };
  // Pull once now: it proves the key can read sessions, and fills the mirror.
  // On failure the previous config, if any, is put back unchanged.
  const result = await connectManagedAgents(config);
  if (result.status === "failed") {
    throw new ScoutCliError(`Could not read Managed Agents sessions: ${result.error}. ${result.restoredPrevious
      ? `The new key was not saved; the previous key (label "${previous?.label ?? label}") is still in use.`
      : "Nothing was saved."}`);
  }
  const { summary } = result;
  const days = `${lookbackDays} day${lookbackDays === 1 ? "" : "s"}`;
  const text = [
    `Connected Claude Managed Agents as "${label}". The key is kept in ${resolveHubHome()} (only you can read it).`,
    result.status === "pulled"
      ? `Found ${summary.listed} session${summary.listed === 1 ? "" : "s"} from the last ${days}; mirrored ${summary.appended} event${summary.appended === 1 ? "" : "s"}.`
      : "The key can read sessions. Another pull was already running, so the first pull with this key happens on the next pass.",
    "The runtime keeps pulling every 15 seconds. Scout lists these sessions under their agent's name.",
    `Sessions created more than ${days} ago stop syncing; widen the window with --since-days (at most 90).`,
  ].join("\n");
  return { value: { label, lookbackDays, status: result.status, ...summary }, text };
}

type MirrorSession = { label: string; sessionId: string; bytes: number; updatedAt: string };

function mirroredSessions(): MirrorSession[] {
  const root = resolveHubClaudeMirrorRoot();
  const out: MirrorSession[] = [];
  let labels: string[] = [];
  try { labels = readdirSync(root); } catch { return out; }
  for (const label of labels) {
    let names: string[] = [];
    try { names = readdirSync(join(root, label)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const stats = statSync(join(root, label, name));
      out.push({ label, sessionId: name.slice(0, -".jsonl".length), bytes: stats.size, updatedAt: stats.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function runStatus(): Promise<{ value: Record<string, unknown>; text: string }> {
  const config = loadHubConfig();
  if (!config) {
    const managed = managedAgentsStatusLines();
    return {
      value: { configured: false, managedAgents: managedAgentsStatusValue() },
      text: ["Claude Code cloud: not set up. Run `scout hub init --inbox <url>`.", ...managed].join("\n"),
    };
  }
  let inbox: Record<string, unknown>;
  try {
    inbox = { reachable: true, ...(await new HubInboxClient(config.inbox, config.readToken).health()) };
  } catch (error) {
    inbox = { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
  const statusPath = join(resolveHubHome(), "status.json");
  const lastCollect = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) as Partial<HubCollectSummary> : null;
  const waiting = lastCollect?.waitingFiles ?? [];
  const now = Date.now();
  const sessions = mirroredSessions();
  const lines = [
    `Inbox: ${config.inbox} ${inbox.reachable ? `(reachable, ${inbox.pending ?? "?"} waiting)` : `(not reachable: ${inbox.error})`}`,
    lastCollect
      ? `Last collect: ${lastCollect.at}, ${lastCollect.appended} appended, ${lastCollect.waiting} waiting${lastCollect.error ? `, error: ${lastCollect.error}` : ""}`
      : "Last collect: never",
    ...(waiting.length ? [
      "Waiting for earlier bytes:",
      ...waiting.map((file) => {
        const seconds = Math.max(0, Math.floor((now - Date.parse(file.waitingSince)) / 1_000));
        return `  ${file.label}/${file.file} (session ${file.sessionId}): ${file.mirroredBytes} bytes mirrored, waiting offset ${file.waitingOffset}, waiting ${seconds}s`;
      }),
    ] : []),
    `Mirror: ${resolveHubClaudeMirrorRoot()}`,
    ...(sessions.length
      ? sessions.slice(0, 20).map((s) => `  ${s.label}/${s.sessionId}  ${s.bytes} bytes  ${s.updatedAt}`)
      : ["  no cloud sessions yet"]),
  ];
  lines.push(...managedAgentsStatusLines());
  return { value: { configured: true, inbox: { url: config.inbox, ...inbox }, lastCollect, sessions, managedAgents: managedAgentsStatusValue() }, text: lines.join("\n") };
}

function managedAgentsStatusValue(): Record<string, unknown> {
  let config;
  try { config = loadManagedAgentsConfig(); } catch (error) { return { configured: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!config) return { configured: false };
  return { configured: true, label: config.label, lookbackDays: config.lookbackDays, mirror: resolveManagedAgentsMirrorRoot(), lastPull: readManagedAgentsStatus() };
}

function managedAgentsStatusLines(): string[] {
  const value = managedAgentsStatusValue();
  if (!value.configured) return [value.error ? `Managed Agents: ${value.error}` : "Managed Agents: not connected. Run `scout hub connect managed-agents`."];
  const last = value.lastPull as ReturnType<typeof readManagedAgentsStatus>;
  return [
    `Managed Agents: "${value.label}", sessions from the last ${value.lookbackDays} days`,
    last
      ? `  Last pull: ${last.at}, ${last.listed} listed, ${last.changed} changed, ${last.appended} events mirrored${last.error ? `, error: ${last.error}` : ""}`
      : "  Last pull: never",
    `  Mirror: ${value.mirror}`,
  ];
}

async function runCollect(): Promise<{ value: Record<string, unknown>; text: string }> {
  const managed = loadManagedAgentsConfig();
  if (!loadHubConfig()) {
    if (!managed) requireConfig();
    const pulled = await new ManagedAgentsPuller().pullOnce();
    if (pulled.error) throw new ScoutCliError(`Managed Agents pull failed: ${pulled.error}`);
    return { value: { managedAgents: pulled }, text: managedAgentsPullText(pulled) };
  }
  const pulled = managed ? await new ManagedAgentsPuller().pullOnce() : null;
  const summary = await new HubCollectorService().collectOnce();
  if (summary.error) throw new ScoutCliError(`Collect failed: ${summary.error}`);
  const text = summary.notes.includes("another collector is running")
    ? "The runtime is collecting right now; try again in a moment."
    : `Fetched ${summary.fetched}: ${summary.appended} appended, ${summary.duplicate} already had, ${summary.waiting} waiting for earlier bytes, ${summary.rejected} rejected.`
      + (summary.sessions.length ? `\nUpdated: ${summary.sessions.join(", ")}` : "");
  return { value: { ...summary, ...(pulled ? { managedAgents: pulled } : {}) }, text: pulled ? `${text}\n${managedAgentsPullText(pulled)}` : text };
}

function managedAgentsPullText(summary: Awaited<ReturnType<ManagedAgentsPuller["pullOnce"]>>): string {
  if (summary.error) return `Managed Agents: pull failed: ${summary.error}`;
  if (summary.notes.includes("another pull is running")) return "Managed Agents: the runtime is pulling right now.";
  return `Managed Agents: ${summary.listed} listed, ${summary.changed} changed, ${summary.appended} events mirrored.`
    + (summary.sessions.length ? `\nUpdated: ${summary.sessions.join(", ")}` : "");
}

export async function runHubCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseHubCommandOptions(args);
  if (options.help) { context.output.writeText(renderHubCommandHelp()); return; }
  let result: { value: Record<string, unknown>; text: string };
  switch (options.command) {
    case "init": result = runInit(options); break;
    case "connect":
      result = options.target === "managed-agents" ? await runConnectManagedAgents(options) : runConnect(options, context.cwd);
      break;
    case "disconnect": {
      if (options.target === "managed-agents") {
        const removed = removeManagedAgentsConfig();
        result = {
          value: { removed },
          text: removed ? "Forgot the Managed Agents API key. Sessions already mirrored stay; delete the mirror folder to drop them." : "Managed Agents was not connected.",
        };
        break;
      }
      const repoRoot = resolve(context.cwd, options.path ?? ".");
      const { changed } = disconnectClaudeCode(repoRoot);
      result = { value: { repoRoot, changed }, text: changed.length ? `Removed from ${repoRoot}: ${changed.join(", ")}. Commit the change.` : "Nothing to remove." };
      break;
    }
    case "collect": result = await runCollect(); break;
    default: result = await runStatus();
  }
  context.output.writeValue(result.value, () => result.text);
}
