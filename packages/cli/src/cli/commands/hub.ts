import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  connectClaudeCode,
  disconnectClaudeCode,
  HubCollectorService,
  HubInboxClient,
  loadHubConfig,
  loadHubIdentity,
  loadOrCreateHubIdentity,
  newHubToken,
  normalizeInboxUrl,
  resolveHubClaudeMirrorRoot,
  resolveHubHome,
  saveHubConfig,
  type HubConfig,
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
  json: boolean;
  help: boolean;
};

export function renderHubCommandHelp(): string {
  return [
    "Usage:",
    "  scout hub [status]",
    "  scout hub init --inbox <url> [--read-token <t> --write-token <t>]",
    "  scout hub connect claude-code [<repo>] [--label <name>]",
    "  scout hub disconnect claude-code [<repo>]",
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
    "disconnect  Take Scout's hooks and files out of a repo.",
    "collect     Collect waiting chunks now. The runtime also does this every 15 seconds.",
    "status      Show the inbox, what is waiting, and the mirrored sessions.",
  ].join("\n");
}

export function parseHubCommandOptions(args: string[]): HubOptions {
  const result: HubOptions = { command: "status", json: false, help: false };
  const positional: string[] = [];
  const valueFlags: Record<string, keyof HubOptions> = {
    "--inbox": "inbox", "--label": "label", "--read-token": "readToken", "--write-token": "writeToken",
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
    if (target !== "claude-code") throw new ScoutCliError(`scout hub ${command} needs a platform: claude-code`);
    result.target = target;
    result.path = positional.shift();
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
    return { value: { configured: false }, text: "Scout Hub is not set up on this runtime. Run `scout hub init --inbox <url>`." };
  }
  let inbox: Record<string, unknown>;
  try {
    inbox = { reachable: true, ...(await new HubInboxClient(config.inbox, config.readToken).health()) };
  } catch (error) {
    inbox = { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
  const statusPath = join(resolveHubHome(), "status.json");
  const lastCollect = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown> : null;
  const sessions = mirroredSessions();
  const lines = [
    `Inbox: ${config.inbox} ${inbox.reachable ? `(reachable, ${inbox.pending ?? "?"} waiting)` : `(not reachable: ${inbox.error})`}`,
    lastCollect
      ? `Last collect: ${lastCollect.at}, ${lastCollect.appended} appended, ${lastCollect.waiting} waiting${lastCollect.error ? `, error: ${lastCollect.error}` : ""}`
      : "Last collect: never",
    `Mirror: ${resolveHubClaudeMirrorRoot()}`,
    ...(sessions.length
      ? sessions.slice(0, 20).map((s) => `  ${s.label}/${s.sessionId}  ${s.bytes} bytes  ${s.updatedAt}`)
      : ["  no cloud sessions yet"]),
  ];
  return { value: { configured: true, inbox: { url: config.inbox, ...inbox }, lastCollect, sessions }, text: lines.join("\n") };
}

async function runCollect(): Promise<{ value: Record<string, unknown>; text: string }> {
  requireConfig();
  const summary = await new HubCollectorService().collectOnce();
  if (summary.error) throw new ScoutCliError(`Collect failed: ${summary.error}`);
  const text = summary.notes.includes("another collector is running")
    ? "The runtime is collecting right now; try again in a moment."
    : `Fetched ${summary.fetched}: ${summary.appended} appended, ${summary.duplicate} already had, ${summary.waiting} waiting for earlier bytes, ${summary.rejected} rejected.`
      + (summary.sessions.length ? `\nUpdated: ${summary.sessions.join(", ")}` : "");
  return { value: { ...summary }, text };
}

export async function runHubCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseHubCommandOptions(args);
  if (options.help) { context.output.writeText(renderHubCommandHelp()); return; }
  let result: { value: Record<string, unknown>; text: string };
  switch (options.command) {
    case "init": result = runInit(options); break;
    case "connect": result = runConnect(options, context.cwd); break;
    case "disconnect": {
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
