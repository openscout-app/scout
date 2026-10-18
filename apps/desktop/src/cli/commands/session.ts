import { currentSessionReturnAddress, stampSessionReturnAddress } from "../../core/mcp/session-return-address.ts";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { buildHarnessResumeCommand, findHarnessEntry } from "@openscout/runtime/harness-catalog";
import {
  findGhosttyTerminalForTty,
  findHarnessAncestor,
  findHarnessOnTty,
  normalizeTty,
  parseProcessRows,
  resolveLiveHarnessProcess,
  sendGhosttyPrompt,
  stopProcessGracefully,
  type LiveHarnessProcess,
} from "@openscout/runtime/live-terminal-session";
import {
  SQLiteControlPlaneStore,
  endpointMatchesTargetSessionAddress,
  resolveOpenScoutSupportPaths,
  runtimeSessionAddressEntries,
  type RuntimeSessionAddressEntry,
} from "@openscout/runtime";
import { deliverInPlace, type InPlaceDelivery } from "@openscout/runtime/in-place";
import type {
  TerminalBackend,
  TerminalSessionRecord,
  TerminalSurface,
} from "@openscout/protocol";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { readCliInputFile } from "../input-file.ts";
import { readScoutWebJson } from "../web-api.ts";
import {
  attachScoutManagedLocalSession,
  ensureScoutCodexChatWork,
  readScoutBrokerSnapshotResult,
  resolveScoutSenderId,
} from "../../core/broker/service.ts";
import { askScoutApp } from "../scout-app-socket.ts";
import { resolveOpenScoutHomeForEnv } from "@openscout/runtime/support-paths";
import { wrapUserSpawnPaneCommand } from "@openscout/runtime/terminal-environment";
import { buildMultiplexerServerEnvironment, buildUserSpawnEnvironment } from "@openscout/runtime/instance";

const SESSION_HELP = `scout session — actions on a harness session

Usage:
  scout session intake --harness <name> --session <id> [--project <path>]
  scout session intake <harness> <session-id> [--project <path>]
  scout session handoff ...                 Alias for session intake
  scout session onboard ...                 Alias for session intake
  scout session list [--harness <name>] [--backend tmux|zellij]
  scout session address [<selector>] [--all] [--limit <n>]
                                            Copyable sess.<token>@<host> addresses
  scout session fork <session-id> [prompt]   Fork a recorded session into a new one
  scout session fork --last [prompt]         Fork the most recent recorded session
  scout session touched <session-id>         Show files observed in a session
  scout session send <session-id> <text>      Type into a live session (--draft fills; --request-reply stamps return address)
  scout session transfer [<pid>] [--name <tmux>] [--alias @x] [--dry-run] [--no-reattach]
                                            Move a live Claude/Grok TUI into tmux, same session
  scout session pin [--session <codex-thread-id>] [--title <name>]
                                            Pin a ChatGPT-app Codex chat as a desktop figure

Options (intake):
  --harness <name>      Harness that owns the source session (claude, codex, pi)
  --session <id>        Harness-native session id to resume
  --backend <name>      Terminal backend/substrate: tmux or zellij (default: tmux)
  --project <path>      Project/cwd for the resumed session (default: cwd)
  --cwd <path>          Alias for --project
  --name <name>         Explicit terminal session name (default: deterministic scout-* name)
  --dry-run             Print the intake plan without creating terminal state
  --attach              Attach to the terminal session after creating/reusing it

Options (send):
  --harness <name>      claude or codex, when the id alone is ambiguous
  --prompt-file <path>  Read the text from a file

Options (fork):
  --last                Fork the most recent session instead of naming an id
  --prompt-file <path>  Read the kickoff prompt from a file
  --all                 With no id, widen the picker beyond the current directory

Address prints your own session's address with no selector, or the addresses
a selector names (session handle, native session id, actor id, or an address).
Anyone can then reach that exact conversation with no agent card:
  scout ask --to sess.<token>@<host> "..."
Each row reports reachability: live, resumable (Scout will try the exact
wake), or unavailable. An address never falls back to a fresh session.

Pin turns a Codex chat from the ChatGPT app into Scout work and puts its
figure on the desktop. Inside Codex the chat names itself (CODEX_THREAD_ID),
so the /scout skill runs it with no arguments. Nothing is attached or resumed:
the app stays the chat's only writer, and the figure's Talk starts Codex's own
voice chat in that thread.

Intake gives an existing harness session a Scout-owned terminal home. It creates
or reuses a deterministic terminal backend session and starts the harness-native
resume command inside it, so a web/native terminal can attach by session name.

Transfer moves a live harness TUI (Claude or Grok) you started by hand into
tmux without changing its conversation. It stops the process (SIGTERM, no
kill), resumes the same session id in a new tmux session, gives that pane a
Scout address that delivers into it, and types \`tmux attach\` into the
Ghostty terminal it came from so it reappears where it was. With no <pid> it
moves the harness this command runs under, finishing in the background.
An in-flight turn is interrupted; transfer between turns.

Send types into the live session itself — its Herdr pane, Orca terminal,
tmux pane, or terminal tab — and presses Enter. It never resumes, forks, or
starts anything: a session that isn't open anywhere is reported and nothing
is sent. To reach it through Scout instead, use scout ask --to <address>.

Fork branches a session's context into a fresh run and leaves the original
untouched — hand the fork a prompt and it starts there with the full context
already loaded. It wraps the harness-native fork (today: codex fork) and opens
the forked session interactively. Deterministic when you pass an explicit
<session-id> (a codex session UUID).`;

export async function runSessionCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const action = args[0];
  if (!action || action === "help" || action === "--help" || action === "-h") {
    context.output.writeText(SESSION_HELP);
    return;
  }

  switch (action) {
    case "intake":
    case "handoff":
    case "onboard":
      await runSessionIntakeAction(context, args.slice(1));
      return;
    case "list":
    case "ls":
      await runSessionListAction(context, args.slice(1));
      return;
    case "address":
    case "addr":
      await runSessionAddressAction(context, args.slice(1));
      return;
    case "fork":
      await runSessionForkAction(context, args.slice(1));
      return;
    case "touched":
    case "touches":
      await runSessionTouchedAction(context, args.slice(1));
      return;
    case "send":
      await runSessionSendAction(context, args.slice(1));
      return;
    case "pin":
      await runSessionPinAction(context, args.slice(1));
      return;
    case "transfer":
    case "move":
      await runSessionTransferAction(context, args.slice(1));
      return;
    default:
      throw new ScoutCliError(
        `unknown session action: ${action} (try: scout session intake|list|address|fork|send|touched|pin|transfer <session-id>)`,
      );
  }
}

type SessionIntakePayload = {
  ok: true;
  action: "session_intake";
  harness: string;
  backend: TerminalBackend;
  sourceSessionId: string;
  terminalSession: string;
  terminalSurface: TerminalSurface;
  tmuxSession?: string;
  zellijSession?: string;
  zellijPaneId?: string | null;
  cwd: string;
  resumeCommand: string;
  created: boolean;
  dryRun: boolean;
  registered: boolean;
  terminalSessionRecord?: TerminalSessionRecord;
  attachCommand: string;
  observeCommand: string | null;
  relay: TerminalSurface["relay"];
};

type SessionListPayload = {
  ok: true;
  action: "session_list";
  count: number;
  sessions: TerminalSessionRecord[];
};

type SessionAddressPayload = {
  ok: true;
  action: "session_address";
  selector: string | null;
  scope: "self" | "selector" | "all";
  count: number;
  addresses: RuntimeSessionAddressEntry[];
  note?: string;
};

const SESSION_ENV_KEYS = [
  "CODEX_THREAD_ID",
  "OPENSCOUT_CODEX_THREAD_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
] as const;

async function runSessionAddressAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }
  let all = false;
  let limit = 20;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--all") {
      all = true;
    } else if (arg === "--limit") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new ScoutCliError("--limit expects a positive integer");
      limit = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session address: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new ScoutCliError("session address takes at most one selector");

  const snapshotResult = await readScoutBrokerSnapshotResult();
  if (!snapshotResult.ok) throw new ScoutCliError(`could not read the Scout broker: ${snapshotResult.detail}`);
  const snapshot = snapshotResult.snapshot;
  const endpoints = Object.values(snapshot.endpoints);

  const selector = positional[0]?.trim() || null;
  let scope: SessionAddressPayload["scope"];
  let selected: typeof endpoints;
  if (all) {
    scope = "all";
    selected = endpoints;
  } else if (selector) {
    scope = "selector";
    selected = endpoints.filter((endpoint) =>
      endpoint.agentId === selector || endpointMatchesTargetSessionAddress(snapshot, endpoint, selector)
    );
  } else {
    scope = "self";
    const senderId = await resolveScoutSenderId(null, defaultScoutContextDirectory(context), context.env);
    const sessionIds = SESSION_ENV_KEYS
      .map((key) => context.env[key]?.trim())
      .filter((value): value is string => Boolean(value));
    selected = endpoints.filter((endpoint) =>
      endpoint.agentId === senderId
      || sessionIds.some((sessionId) => endpointMatchesTargetSessionAddress(snapshot, endpoint, sessionId))
    );
  }

  const entries = runtimeSessionAddressEntries(snapshot, selected);
  const addresses = all
    ? entries.filter((entry) => entry.reachability !== "unavailable").slice(0, limit)
    : entries.slice(0, limit);
  const payload: SessionAddressPayload = {
    ok: true,
    action: "session_address",
    selector,
    scope,
    count: addresses.length,
    addresses,
    ...(addresses.length === 0
      ? {
          note: scope === "self"
            ? "This sender has no broker-registered session yet. It gets an address once its harness session attaches to Scout."
            : "No known session matches. Only sessions this broker has observed have addresses; another host's sessions appear only once that host shares them.",
        }
      : {}),
  };
  context.output.writeValue(payload, renderSessionAddresses);
}

function renderSessionAddresses(payload: SessionAddressPayload): string {
  if (payload.addresses.length === 0) return payload.note ?? "No session addresses.";
  const width = Math.max(...payload.addresses.map((entry) => entry.address.length));
  return payload.addresses.map((entry) => [
    entry.address.padEnd(width),
    entry.reachability.padEnd(11),
    entry.harness.padEnd(8),
    entry.projectRoot ? basename(entry.projectRoot) : "",
  ].join("  ").trimEnd()).join("\n");
}

type SessionTouchedPayload = {
  refId: string | null;
  agentId: string | null;
  sessionId: string | null;
  worktreePath: string | null;
  counts: { files: number; changedFiles: number; readFiles: number };
  files: Array<{ path: string; state: string; touches: number }>;
};

type SessionPinPayload = {
  ok: true;
  action: "session_pin";
  workId: string;
  threadId: string;
  title: string;
  created: boolean;
  pinned: boolean;
  note?: string;
};

async function runSessionPinAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }
  let threadId = "";
  let title = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--session" || arg.startsWith("--session=")) {
      const parsed = readOptionValue(args, index, "--session");
      threadId = parsed.value;
      index = parsed.nextIndex;
    } else if (arg === "--title" || arg.startsWith("--title=")) {
      const parsed = readOptionValue(args, index, "--title");
      title = parsed.value;
      index = parsed.nextIndex;
    } else if (!arg.startsWith("-") && !threadId) {
      threadId = arg;
    } else {
      throw new ScoutCliError(`unknown option for session pin: ${arg}`);
    }
  }
  threadId = threadId.trim() || context.env.CODEX_THREAD_ID?.trim() || "";
  if (!threadId) {
    throw new ScoutCliError("session pin needs a Codex thread: run it inside Codex (CODEX_THREAD_ID) or pass --session <id>");
  }
  const codexHome = operatorCodexHomeFor(context);
  const known = codexThreadName(codexHome, threadId);
  if (known === undefined) {
    throw new ScoutCliError(`Codex thread ${threadId} isn't in ${codexHome}, so the ChatGPT app can't open it`);
  }
  const work = await ensureScoutCodexChatWork({
    threadId,
    title: title.trim() || known || "",
    cwd: defaultScoutContextDirectory(context),
  });
  const reply = await askScoutApp({ op: "companion.pin", workId: work.workId }, { env: context.env });
  const payload: SessionPinPayload = {
    ok: true,
    action: "session_pin",
    workId: work.workId,
    threadId,
    title: work.title,
    created: work.created,
    pinned: reply.ok,
    ...(reply.ok ? {} : { note: reply.message }),
  };
  context.output.writeValue(payload, (value) => value.pinned
    ? `Pinned “${value.title}” to the desktop (${value.workId}).`
    : `Saved “${value.title}” as ${value.workId}, but the figure isn't out: ${value.note}`);
}

/** The Codex store the ChatGPT app reads. */
function operatorCodexHomeFor(context: ScoutCommandContext): string {
  const explicit = context.env.CODEX_HOME?.trim();
  return explicit ? resolve(explicit) : join(context.env.HOME?.trim() || homedir(), ".codex");
}

/**
 * The thread's name from Codex's session index (the last line for an id
 * wins); "" when the thread exists but has no name yet; undefined when this
 * store has no such thread.
 */
function codexThreadName(codexHome: string, threadId: string): string | undefined {
  let name: string | undefined;
  try {
    for (const line of readFileSync(join(codexHome, "session_index.jsonl"), "utf8").split("\n")) {
      if (!line.includes(threadId)) continue;
      try {
        const entry = JSON.parse(line) as { id?: string; thread_name?: string };
        if (entry.id === threadId) name = entry.thread_name?.trim() ?? "";
      } catch {
        // A line being written; skip it.
      }
    }
  } catch {
    // No index: fall through to the rollout files.
  }
  if (name !== undefined) return name;
  return codexRolloutExists(join(codexHome, "sessions"), threadId) ? "" : undefined;
}

function codexRolloutExists(dir: string, threadId: string, depth = 0): boolean {
  if (depth > 3 || !existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) return true;
    if (entry.isDirectory() && codexRolloutExists(join(dir, entry.name), threadId, depth + 1)) return true;
  }
  return false;
}

async function runSessionTouchedAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  const refId = args.find((arg) => arg !== "--help" && arg !== "-h");
  if (!refId || args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }
  const payload = await readScoutWebJson<SessionTouchedPayload>(
    context,
    `/api/session-ref/${encodeURIComponent(refId)}/touched`,
  );
  context.output.writeValue(payload, renderTouchedFiles);
}

function renderTouchedFiles(payload: SessionTouchedPayload): string {
  const lines = [
    `session ${payload.refId ?? payload.sessionId ?? "(unknown)"}`,
    `worktree ${payload.worktreePath ?? "(unknown)"}`,
    `${payload.counts.changedFiles} changed · ${payload.counts.readFiles} read · ${payload.counts.files} touched`,
  ];
  for (const file of payload.files) {
    lines.push(`${file.state.padEnd(8)} ${file.path} ×${file.touches}`);
  }
  return lines.join("\n");
}

async function runSessionIntakeAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }

  const options = parseSessionIntakeOptions(context, args);
  const harnessEntry = findHarnessEntry(options.harness);
  if (!harnessEntry) {
    throw new ScoutCliError(`unknown harness for session intake: ${options.harness}`);
  }

  const resumeCommand = buildHarnessResumeCommand(harnessEntry, options.sessionId, options.cwd);
  if (!resumeCommand) {
    throw new ScoutCliError(
      `harness "${options.harness}" does not advertise a resume command, so Scout cannot intake it yet`,
    );
  }

  const terminalSession = options.terminalSession ?? defaultTerminalSessionName({
    backend: options.backend,
    harness: options.harness,
    cwd: options.cwd,
    sessionId: options.sessionId,
  });
  validateTerminalSessionName(terminalSession);

  let created = false;
  let paneId: string | null = null;
  if (!options.dryRun) {
    const result = materializeTerminalSurface(context, {
      backend: options.backend,
      sessionName: terminalSession,
      cwd: options.cwd,
      resumeCommand,
      paneName: harnessEntry.name,
    });
    created = result.created;
    paneId = result.paneId;
  }

  const terminalSurface = buildTerminalSurfacePayload({
    backend: options.backend,
    sessionName: terminalSession,
    paneId,
    zellijSocketDir: options.backend === "zellij" ? resolveZellijSocketDir(context) : undefined,
  });
  const terminalSessionRecord = options.dryRun
    ? undefined
    : registerTerminalSessionIntake(context, {
        harness: harnessEntry.name,
        sourceSessionId: options.sessionId,
        cwd: options.cwd,
        resumeCommand,
        surface: {
          ...terminalSurface,
          state: "live",
        },
      });
  const payload: SessionIntakePayload = {
    ok: true,
    action: "session_intake",
    harness: harnessEntry.name,
    backend: options.backend,
    sourceSessionId: options.sessionId,
    terminalSession,
    terminalSurface,
    ...(options.backend === "tmux" ? { tmuxSession: terminalSession } : {}),
    ...(options.backend === "zellij" ? { zellijSession: terminalSession, zellijPaneId: paneId } : {}),
    cwd: options.cwd,
    resumeCommand,
    created,
    dryRun: options.dryRun,
    registered: Boolean(terminalSessionRecord),
    ...(terminalSessionRecord ? { terminalSessionRecord } : {}),
    attachCommand: terminalSurface.attachCommand.map(quoteForShell).join(" "),
    observeCommand: terminalSurface.observeCommand?.map(quoteForShell).join(" ") ?? null,
    relay: terminalSurface.relay,
  };

  context.output.writeValue(payload, renderSessionIntake);

  if (options.attach && !options.dryRun) {
    attachTerminalSurface(context, {
      backend: options.backend,
      sessionName: terminalSession,
    });
  }
}

async function runSessionListAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }

  let harness: string | undefined;
  let backend: TerminalBackend | undefined;
  let limit = 100;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--harness" || arg.startsWith("--harness=")) {
      const parsed = readOptionValue(args, index, "--harness");
      harness = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--backend" || arg.startsWith("--backend=")) {
      const parsed = readOptionValue(args, index, "--backend");
      backend = parseTerminalBackend(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = readOptionValue(args, index, "--limit");
      const parsedLimit = Number.parseInt(parsed.value, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new ScoutCliError(`invalid --limit value: ${parsed.value}`);
      }
      limit = Math.min(1000, Math.floor(parsedLimit));
      index = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session list: ${arg}`);
    }
    throw new ScoutCliError(`unexpected argument for session list: ${arg}`);
  }

  const store = openTerminalSessionStore(context);
  try {
    const sessions = store.listTerminalSessions({
      ...(harness ? { harness } : {}),
      ...(backend ? { backend } : {}),
      limit,
    });
    context.output.writeValue({
      ok: true,
      action: "session_list",
      count: sessions.length,
      sessions,
    } satisfies SessionListPayload, renderSessionList);
  } finally {
    store.close();
  }
}

type SessionIntakeOptions = {
  harness: string;
  sessionId: string;
  backend: TerminalBackend;
  cwd: string;
  terminalSession?: string;
  dryRun: boolean;
  attach: boolean;
};

function parseSessionIntakeOptions(context: ScoutCommandContext, args: string[]): SessionIntakeOptions {
  let harness: string | undefined;
  let sessionId: string | undefined;
  let backend: TerminalBackend = "tmux";
  let projectPath: string | undefined;
  let terminalSession: string | undefined;
  let dryRun = false;
  let attach = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--attach") {
      attach = true;
      continue;
    }

    if (arg === "--harness" || arg.startsWith("--harness=")) {
      const parsed = readOptionValue(args, index, "--harness");
      harness = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--session" || arg.startsWith("--session=") || arg === "--session-id" || arg.startsWith("--session-id=")) {
      const flag = arg.startsWith("--session-id") ? "--session-id" : "--session";
      const parsed = readOptionValue(args, index, flag);
      sessionId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--backend" || arg.startsWith("--backend=") || arg === "--terminal-backend" || arg.startsWith("--terminal-backend=")) {
      const flag = arg.startsWith("--terminal-backend") ? "--terminal-backend" : "--backend";
      const parsed = readOptionValue(args, index, flag);
      backend = parseTerminalBackend(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--project" || arg.startsWith("--project=") || arg === "--cwd" || arg.startsWith("--cwd=")) {
      const flag = arg.startsWith("--cwd") ? "--cwd" : "--project";
      const parsed = readOptionValue(args, index, flag);
      projectPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--name" || arg.startsWith("--name=") || arg === "--tmux" || arg.startsWith("--tmux=")) {
      const flag = arg.startsWith("--tmux") ? "--tmux" : "--name";
      const parsed = readOptionValue(args, index, flag);
      terminalSession = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session intake: ${arg}`);
    }

    positionals.push(arg);
  }

  if (!harness) {
    harness = positionals.shift();
  }
  if (!sessionId) {
    sessionId = positionals.shift();
  }
  if (positionals.length > 0) {
    throw new ScoutCliError(`unexpected arguments for session intake: ${positionals.join(" ")}`);
  }
  if (!harness) {
    throw new ScoutCliError("session intake needs --harness <name> (or: scout session intake <harness> <session-id>)");
  }
  if (!sessionId) {
    throw new ScoutCliError("session intake needs --session <id> (or: scout session intake <harness> <session-id>)");
  }

  return {
    harness,
    sessionId,
    backend,
    cwd: resolveProjectPath(context, projectPath),
    terminalSession,
    dryRun,
    attach,
  };
}

function parseTerminalBackend(value: string): TerminalBackend {
  const normalized = value.trim().toLowerCase();
  if (normalized === "tmux" || normalized === "zellij") {
    return normalized;
  }
  throw new ScoutCliError(`unknown terminal backend: ${value} (expected tmux or zellij)`);
}

function readOptionValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index] ?? "";
  if (current === flag) {
    const value = args[index + 1];
    if (!value) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value, nextIndex: index + 1 };
  }

  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length);
    if (!value) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value, nextIndex: index };
  }

  throw new ScoutCliError(`missing value for ${flag}`);
}

function resolveProjectPath(context: ScoutCommandContext, projectPath?: string): string {
  const rawPath = projectPath?.trim() || context.cwd;
  const expanded = rawPath === "~"
    ? context.env.HOME?.trim() || homedir()
    : rawPath.startsWith("~/")
      ? resolve(context.env.HOME?.trim() || homedir(), rawPath.slice(2))
      : rawPath;
  return resolve(context.cwd, expanded);
}

function resolveControlPlaneDbPath(context: ScoutCommandContext): string {
  const explicitPath = context.env.OPENSCOUT_CONTROL_PLANE_DB?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const controlHome = context.env.OPENSCOUT_CONTROL_HOME?.trim()
    || join(resolveOpenScoutHomeForEnv(context.env), "control-plane");
  return join(controlHome, "control-plane.sqlite");
}

function openTerminalSessionStore(context: ScoutCommandContext): SQLiteControlPlaneStore {
  return new SQLiteControlPlaneStore(resolveControlPlaneDbPath(context));
}

function registerTerminalSessionIntake(
  context: ScoutCommandContext,
  input: {
    harness: string;
    sourceSessionId: string;
    cwd: string;
    resumeCommand: string;
    surface: TerminalSurface;
  },
): TerminalSessionRecord {
  const store = openTerminalSessionStore(context);
  try {
    const existing = store.listTerminalSessions({
      harness: input.harness,
      sourceSessionId: input.sourceSessionId,
      limit: 1,
    })[0];
    return store.upsertTerminalSession({
      ...(existing ? { id: existing.id } : {}),
      harness: input.harness,
      sourceSessionId: input.sourceSessionId,
      cwd: input.cwd,
      resumeCommand: input.resumeCommand,
      surfaces: mergeTerminalSurfaces(existing?.surfaces ?? [], input.surface),
      metadata: {
        ...(existing?.metadata ?? {}),
        source: "scout-cli",
        updatedBy: "session_intake",
      },
    });
  } finally {
    store.close();
  }
}

export function mergeTerminalSurfaces(
  existing: readonly TerminalSurface[],
  next: TerminalSurface,
): TerminalSurface[] {
  const key = terminalSurfaceKey(next);
  let replaced = false;
  const merged = existing.map((surface) => {
    if (terminalSurfaceKey(surface) !== key) {
      return surface;
    }
    replaced = true;
    return {
      ...surface,
      ...next,
      paneId: next.paneId ?? surface.paneId,
      state: next.state ?? surface.state,
      socketDir: next.socketDir ?? surface.socketDir,
      relay: {
        ...surface.relay,
        ...next.relay,
      },
    };
  });
  if (!replaced) {
    merged.push(next);
  }
  return merged;
}

function terminalSurfaceKey(surface: Pick<TerminalSurface, "backend" | "sessionName">): string {
  return `${surface.backend}:${surface.sessionName}`;
}

function defaultTerminalSessionName(input: { backend: TerminalBackend; harness: string; cwd: string; sessionId: string }): string {
  const projectName = sanitizeTerminalSessionNamePart(basename(input.cwd) || "workspace", 28);
  const harnessName = sanitizeTerminalSessionNamePart(input.harness, 18);
  const fingerprint = createHash("sha1")
    .update(`${input.backend}\0${input.harness}\0${input.cwd}\0${input.sessionId}`)
    .digest("hex")
    .slice(0, 10);
  return `scout-${harnessName}-${projectName}-${fingerprint}`;
}

function sanitizeTerminalSessionNamePart(value: string, maxLength: number): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return (sanitized || "session").slice(0, maxLength);
}

function validateTerminalSessionName(sessionName: string): void {
  if (!/^[A-Za-z0-9_.-]+$/u.test(sessionName)) {
    throw new ScoutCliError(
      `invalid terminal session name "${sessionName}" — use letters, numbers, ".", "_", or "-"`,
    );
  }
}

function materializeTerminalSurface(
  context: ScoutCommandContext,
  input: {
    backend: TerminalBackend;
    sessionName: string;
    cwd: string;
    resumeCommand: string;
    paneName: string;
  },
): { created: boolean; paneId: string | null } {
  if (input.backend === "zellij") {
    return materializeZellijSurface(context, input);
  }
  return materializeTmuxSurface(context, input);
}

function materializeTmuxSurface(
  context: ScoutCommandContext,
  input: { sessionName: string; cwd: string; resumeCommand: string },
): { created: boolean; paneId: string | null } {
  assertTmuxAvailable(context);
  const exists = tmuxSessionExists(context, input.sessionName);
  if (exists) {
    return { created: false, paneId: null };
  }
  createTmuxSession(context, {
    tmuxSession: input.sessionName,
    cwd: input.cwd,
    resumeCommand: input.resumeCommand,
  });
  return { created: true, paneId: null };
}

function materializeZellijSurface(
  context: ScoutCommandContext,
  input: { sessionName: string; cwd: string; resumeCommand: string; paneName: string },
): { created: boolean; paneId: string | null } {
  assertZellijAvailable(context);
  const exists = zellijSessionExists(context, input.sessionName);
  if (exists) {
    return { created: false, paneId: null };
  }

  createZellijSession(context, input.sessionName);
  const paneId = createZellijResumePane(context, input);
  return { created: true, paneId };
}

function assertTmuxAvailable(context: ScoutCommandContext): void {
  const result = spawnSync("tmux", ["-V"], { env: context.env, stdio: "ignore" });
  if (result.error) {
    const detail = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "tmux not found on PATH"
      : result.error.message;
    throw new ScoutCliError(`session intake failed: ${detail}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new ScoutCliError("session intake failed: tmux is installed but did not respond to `tmux -V`");
  }
}

function assertZellijAvailable(context: ScoutCommandContext): void {
  const result = spawnSync("zellij", ["--version"], { env: zellijEnv(context), stdio: "ignore" });
  if (result.error) {
    const detail = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "zellij not found on PATH"
      : result.error.message;
    throw new ScoutCliError(`session intake failed: ${detail}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new ScoutCliError("session intake failed: zellij is installed but did not respond to `zellij --version`");
  }
}

function resolveZellijSocketDir(context: ScoutCommandContext): string {
  const configured = context.env.ZELLIJ_SOCKET_DIR?.trim() || context.env.OPENSCOUT_ZELLIJ_SOCKET_DIR?.trim();
  return configured || join(resolveOpenScoutHomeForEnv(context.env), "zellij-sockets");
}

function zellijEnv(context: ScoutCommandContext): NodeJS.ProcessEnv {
  const socketDir = resolveZellijSocketDir(context);
  try {
    mkdirSync(socketDir, { recursive: true });
  } catch {
    return context.env;
  }
  // A zellij session is its own server and keeps the creating client's env:
  // no instance keys (only the client pointer) in what Scout launches.
  return {
    ...(buildUserSpawnEnvironment(context.env) as NodeJS.ProcessEnv),
    ZELLIJ_SOCKET_DIR: socketDir,
  };
}

function tmuxSessionExists(context: ScoutCommandContext, tmuxSession: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", tmuxSession], { env: context.env, stdio: "ignore" });
  return result.status === 0;
}

function zellijSessionExists(context: ScoutCommandContext, sessionName: string): boolean {
  const result = spawnSync("zellij", ["list-sessions"], {
    env: zellijEnv(context),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || typeof result.stdout !== "string") {
    return false;
  }
  return parseZellijSessionList(result.stdout)
    .some((name) => name === sessionName);
}

export function parseZellijSessionList(output: string): string[] {
  return stripAnsi(output)
    .split(/\r?\n/gu)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter((name): name is string => Boolean(name));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function createTmuxSession(
  context: ScoutCommandContext,
  input: { tmuxSession: string; cwd: string; resumeCommand: string; env?: Record<string, string> },
): void {
  const result = spawnSync("tmux", [
    "new-session",
    "-d",
    "-s",
    input.tmuxSession,
    "-c",
    input.cwd,
    ...Object.entries(input.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    // Panes get the tmux server's global env: unset instance keys there.
    wrapUserSpawnPaneCommand(input.resumeCommand, context.env),
  ], {
    env: buildMultiplexerServerEnvironment(context.env) as NodeJS.ProcessEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new ScoutCliError(`session intake failed to create tmux session: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `tmux exited with status ${result.status}`;
    throw new ScoutCliError(`session intake failed to create tmux session: ${detail}`);
  }
}

function createZellijSession(context: ScoutCommandContext, sessionName: string): void {
  const result = spawnSync("zellij", ["attach", "--create-background", sessionName], {
    env: zellijEnv(context),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new ScoutCliError(`session intake failed to create zellij session: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `zellij exited with status ${result.status}`;
    throw new ScoutCliError(`session intake failed to create zellij session: ${detail}`);
  }
}

function createZellijResumePane(
  context: ScoutCommandContext,
  input: { sessionName: string; cwd: string; resumeCommand: string; paneName: string },
): string | null {
  const result = spawnSync("zellij", [
    "--session",
    input.sessionName,
    "action",
    "new-pane",
    "--cwd",
    input.cwd,
    "--name",
    input.paneName,
    "--",
    "sh",
    "-lc",
    input.resumeCommand,
  ], {
    env: zellijEnv(context),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new ScoutCliError(`session intake failed to create zellij pane: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `zellij exited with status ${result.status}`;
    throw new ScoutCliError(`session intake failed to create zellij pane: ${detail}`);
  }

  const paneId = result.stdout?.trim();
  return paneId && /^[A-Za-z0-9_:-]+$/u.test(paneId) ? paneId : null;
}

function buildTerminalSurfacePayload(input: {
  backend: TerminalBackend;
  sessionName: string;
  paneId: string | null;
  zellijSocketDir?: string;
}): TerminalSurface {
  if (input.backend === "zellij") {
    const zellijCommandPrefix = input.zellijSocketDir
      ? ["env", `ZELLIJ_SOCKET_DIR=${input.zellijSocketDir}`, "zellij"]
      : ["zellij"];
    return {
      backend: "zellij",
      sessionName: input.sessionName,
      paneId: input.paneId,
      attachCommand: [...zellijCommandPrefix, "attach", input.sessionName],
      observeCommand: [...zellijCommandPrefix, "watch", input.sessionName],
      relay: {
        backend: "zellij",
        sessionName: input.sessionName,
        zellijSession: input.sessionName,
        ...(input.paneId ? { zellijPaneId: input.paneId } : {}),
      },
      ...(input.zellijSocketDir ? { socketDir: input.zellijSocketDir } : {}),
    };
  }

  return {
    backend: "tmux",
    sessionName: input.sessionName,
    paneId: null,
    attachCommand: ["tmux", "attach", "-t", input.sessionName],
    observeCommand: null,
    relay: {
      backend: "tmux",
      sessionName: input.sessionName,
      tmuxSession: input.sessionName,
    },
  };
}

function attachTerminalSurface(
  context: ScoutCommandContext,
  input: { backend: TerminalBackend; sessionName: string },
): void {
  if (input.backend === "zellij") {
    attachZellijSession(context, input.sessionName);
    return;
  }
  attachTmuxSession(context, input.sessionName);
}

function attachTmuxSession(context: ScoutCommandContext, tmuxSession: string): void {
  const result = spawnSync("tmux", ["attach", "-t", tmuxSession], { env: context.env, stdio: "inherit" });
  if (result.error) {
    throw new ScoutCliError(`session intake failed to attach tmux session: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function attachZellijSession(context: ScoutCommandContext, sessionName: string): void {
  const result = spawnSync("zellij", ["attach", sessionName], { env: zellijEnv(context), stdio: "inherit" });
  if (result.error) {
    throw new ScoutCliError(`session intake failed to attach zellij session: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function renderSessionIntake(payload: SessionIntakePayload): string {
  const createdText = payload.dryRun
    ? "planned"
    : payload.created
      ? "created"
      : "reused";
  return [
    `session intake ${createdText}`,
    `harness ${payload.harness}`,
    `backend ${payload.backend}`,
    `source session ${payload.sourceSessionId}`,
    `terminal session ${payload.terminalSession}`,
    ...(payload.zellijPaneId ? [`pane ${payload.zellijPaneId}`] : []),
    `cwd ${payload.cwd}`,
    `resume ${payload.resumeCommand}`,
    ...(payload.registered && payload.terminalSessionRecord ? [`registered ${payload.terminalSessionRecord.id}`] : []),
    `attach ${payload.attachCommand}`,
    ...(payload.observeCommand ? [`observe ${payload.observeCommand}`] : []),
    `relay backend=${payload.relay.backend} sessionName=${payload.relay.sessionName}`,
  ].join("\n");
}

function renderSessionList(payload: SessionListPayload): string {
  if (payload.sessions.length === 0) {
    return "No terminal sessions registered.";
  }

  const lines = [`${payload.count} terminal session${payload.count === 1 ? "" : "s"}`];
  for (const session of payload.sessions) {
    const surfaces = session.surfaces.length === 0
      ? "no surfaces"
      : session.surfaces
        .map((surface) => `${surface.backend}:${surface.sessionName}${surface.state ? `:${surface.state}` : ""}`)
        .join(", ");
    lines.push(`${session.harness} ${session.sourceSessionId} -> ${surfaces}`);
  }
  return lines.join("\n");
}

async function runSessionForkAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  let last = false;
  let all = false;
  let promptFile: string | undefined;
  let draft = false;
  let requestReply = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--last") {
      last = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--prompt-file") {
      promptFile = args[index + 1];
      index += 1;
      if (!promptFile) {
        throw new ScoutCliError("--prompt-file needs a path");
      }
    } else if (arg === "--help" || arg === "-h") {
      context.output.writeText(SESSION_HELP);
      return;
    } else if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session fork: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  // First positional is the session id (unless --last); the rest form the inline prompt.
  let sessionId: string | undefined;
  if (!last) {
    sessionId = positionals.shift();
    if (!sessionId) {
      throw new ScoutCliError(
        "session fork needs a <session-id> (or --last) — e.g. scout session fork <codex-session-uuid>",
      );
    }
  }

  const inlinePrompt = positionals.join(" ").trim();
  const prompt = promptFile ? await readCliInputFile(promptFile, "prompt") : inlinePrompt;

  // codex fork [--last] [--all] [<SESSION_ID>] [<PROMPT>]
  const codexArgs = ["fork"];
  if (last) codexArgs.push("--last");
  if (all) codexArgs.push("--all");
  if (sessionId) codexArgs.push(sessionId);
  if (prompt) codexArgs.push(prompt);

  context.stderr(`forking via codex: codex ${codexArgs.map(quoteForLog).join(" ")}`);

  // Inherit stdio: the forked session is interactive (a TUI), and lands the
  // operator straight in it. The source session is never modified.
  // An interactive harness the operator drives: a user-facing spawn.
  const result = spawnSync("codex", codexArgs, {
    stdio: "inherit",
    env: buildUserSpawnEnvironment(context.env) as NodeJS.ProcessEnv,
  });
  if (result.error) {
    const detail =
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "codex CLI not found on PATH — install Codex, or run the fork on the machine that owns the session"
        : result.error.message;
    throw new ScoutCliError(`session fork failed: ${detail}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

type SessionTransferOptions = {
  pid?: number;
  terminalSession?: string;
  alias?: string;
  dryRun: boolean;
  reattach: boolean;
  detached: boolean;
};

type SessionTransferPayload = {
  ok: true;
  action: "session_transfer";
  harness: string;
  sessionId: string;
  cwd: string;
  fromPid: number;
  fromTty: string;
  ghosttyTerminalId: string | null;
  tmuxSession: string;
  resumeCommand: string;
  dryRun: boolean;
  pid?: number;
  pane?: string;
  selector?: string | null;
  attachError?: string;
  reattached?: boolean;
  reattachError?: string;
  attachCommand: string;
};

const TRANSFER_DETACHED_FLAG = "--internal-detached";

function parseSessionTransferOptions(args: string[]): SessionTransferOptions {
  const options: SessionTransferOptions = { dryRun: false, reattach: true, detached: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-reattach") options.reattach = false;
    else if (arg === TRANSFER_DETACHED_FLAG) options.detached = true;
    else if (arg === "--name" || arg.startsWith("--name=")) {
      const { value, nextIndex } = readOptionValue(args, index, "--name");
      options.terminalSession = value;
      index = nextIndex;
    } else if (arg === "--alias" || arg.startsWith("--alias=")) {
      const { value, nextIndex } = readOptionValue(args, index, "--alias");
      options.alias = value;
      index = nextIndex;
    } else if (/^\d+$/u.test(arg) && options.pid === undefined) {
      options.pid = Number(arg);
    } else {
      throw new ScoutCliError(`unexpected argument for session transfer: ${arg}`);
    }
  }
  return options;
}

function readProcessTable(): ReturnType<typeof parseProcessRows> {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,tty=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return parseProcessRows(result.stdout ?? "");
}

/** Absolute path of `command` on the caller's PATH, so tmux's own PATH doesn't matter. */
function resolveExecutable(context: ScoutCommandContext, command: string): string {
  for (const dir of (context.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, command))) return join(dir, command);
  }
  return command;
}

function readTmuxPaneOf(context: ScoutCommandContext, tmuxSession: string): { pane: string; tty: string } | null {
  const result = spawnSync("tmux", ["display-message", "-p", "-t", tmuxSession, "#{pane_id}|#{pane_tty}"], {
    env: context.env,
    encoding: "utf8",
  });
  const [pane, tty] = (result.stdout ?? "").trim().split("|");
  return pane && tty ? { pane, tty: normalizeTty(tty) } : null;
}

async function runSessionTransferAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_HELP);
    return;
  }
  const options = parseSessionTransferOptions(args);
  const rows = readProcessTable();
  const ownHarness = findHarnessAncestor(rows, process.pid);
  const pid = options.pid ?? ownHarness?.pid;
  if (!pid) {
    throw new ScoutCliError("no harness above this command; pass the pid of the claude or grok to transfer");
  }

  const resolved = await resolveLiveHarnessProcess(pid, { env: context.env });
  if (!resolved.ok) throw new ScoutCliError(`cannot transfer ${pid}: ${resolved.detail}`);
  const live: LiveHarnessProcess = resolved.process;
  const inTmux = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_tty}"], { env: context.env, encoding: "utf8" })
    .stdout?.split("\n").some((tty) => tty.trim() && normalizeTty(tty) === live.tty);
  if (inTmux) throw new ScoutCliError(`${live.harness} (pid ${pid}) already runs in a tmux pane; attach it with /scout card instead`);

  const entry = findHarnessEntry(live.harness);
  const resumeCommand = entry ? buildHarnessResumeCommand(entry, live.sessionId, live.cwd) : null;
  if (!entry?.resume || !resumeCommand) throw new ScoutCliError(`${live.harness} has no resume command`);
  const absoluteResume = resumeCommand.replace(
    /^\S+/u,
    quoteForShell(resolveExecutable(context, entry.resume.command)),
  );
  const tmuxSession = options.terminalSession ?? defaultTerminalSessionName({
    backend: "tmux",
    harness: live.harness,
    cwd: live.cwd,
    sessionId: live.sessionId,
  });
  validateTerminalSessionName(tmuxSession);
  if (!options.dryRun) {
    assertTmuxAvailable(context);
    if (tmuxSessionExists(context, tmuxSession)) throw new ScoutCliError(`tmux session ${tmuxSession} already exists`);
  }

  // Stopping our own harness would take this process down with it: finish in
  // a detached copy and report where its log goes.
  const selfTransfer = ownHarness?.pid === pid && !options.detached && !options.dryRun;
  if (selfTransfer) {
    const logPath = join(resolveOpenScoutSupportPaths().logsDirectory, `session-transfer-${pid}.log`);
    mkdirSync(join(logPath, ".."), { recursive: true });
    const log = openSync(logPath, "a");
    const child = spawn(process.execPath, [...process.argv.slice(1).filter((arg) => arg !== TRANSFER_DETACHED_FLAG), ...(options.pid ? [] : [String(pid)]), TRANSFER_DETACHED_FLAG], {
      cwd: context.cwd,
      env: context.env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    context.output.writeText(
      `Transferring this ${live.harness} session to tmux ${tmuxSession}; this process stops in a moment and reappears there. Log: ${logPath}`,
    );
    return;
  }
  // Give the harness time to print the reply above before it is stopped.
  if (options.detached) await new Promise((resolve) => setTimeout(resolve, 3_000));

  const ghosttyTerminalId = options.reattach && context.env.TERM_PROGRAM !== "tmux"
    ? await findGhosttyTerminalForTty(live.tty)
    : null;
  const payload: SessionTransferPayload = {
    ok: true,
    action: "session_transfer",
    harness: live.harness,
    sessionId: live.sessionId,
    cwd: live.cwd,
    fromPid: pid,
    fromTty: live.tty,
    ghosttyTerminalId,
    tmuxSession,
    resumeCommand: absoluteResume,
    dryRun: options.dryRun,
    attachCommand: `tmux attach -t ${quoteForShell(tmuxSession)}`,
  };
  if (options.dryRun) {
    context.output.writeValue(payload, renderSessionTransfer);
    return;
  }

  if (!(await stopProcessGracefully(pid))) {
    throw new ScoutCliError(`${live.harness} (pid ${pid}) did not exit after SIGTERM; nothing was moved`);
  }
  // The pane inherits the tmux server's environment, not ours: carry over what
  // decides where the harness finds its sessions.
  const carriedEnv = Object.fromEntries(
    ["HOME", "PATH", "CLAUDE_CONFIG_DIR", "GROK_HOME", "CODEX_HOME"]
      .flatMap((key) => context.env[key] ? [[key, context.env[key]!]] : []),
  );
  createTmuxSession(context, { tmuxSession, cwd: live.cwd, resumeCommand: absoluteResume, env: carriedEnv });
  const pane = readTmuxPaneOf(context, tmuxSession);
  if (!pane) throw new ScoutCliError(`tmux session ${tmuxSession} started but its pane could not be read`);
  payload.pane = pane.pane;

  let newPid: number | null = null;
  for (let attempt = 0; attempt < 100 && newPid === null; attempt += 1) {
    newPid = await findHarnessOnTty(pane.tty, live.harness);
    if (newPid === null) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (newPid !== null) {
    payload.pid = newPid;
    try {
      const attachment = await attachScoutManagedLocalSession({
        externalSessionId: live.sessionId,
        transport: "tmux",
        currentDirectory: live.cwd,
        ...(options.alias ? { alias: options.alias } : {}),
        liveTerminal: {
          harness: live.harness,
          pid: newPid,
          tty: pane.tty,
          surface: { backend: "tmux", pane: pane.pane, session: tmuxSession },
          nativeSessionId: live.sessionId,
        },
      });
      payload.selector = attachment.selector;
    } catch (error) {
      payload.attachError = error instanceof Error ? error.message : String(error);
    }
  } else {
    payload.attachError = `${live.harness} did not start in ${tmuxSession} within 20s; check the pane`;
  }

  if (ghosttyTerminalId) {
    try {
      await sendGhosttyPrompt(ghosttyTerminalId, payload.attachCommand);
      payload.reattached = true;
    } catch (error) {
      payload.reattached = false;
      payload.reattachError = error instanceof Error ? error.message : String(error);
    }
  }
  context.output.writeValue(payload, renderSessionTransfer);
}

function renderSessionTransfer(payload: SessionTransferPayload): string {
  const lines = [
    `${payload.dryRun ? "Would move" : "Moved"} ${payload.harness} session ${payload.sessionId} (pid ${payload.fromPid}, ${payload.fromTty}) to tmux ${payload.tmuxSession}.`,
    `Resume: ${payload.resumeCommand}`,
  ];
  if (payload.pane) lines.push(`Pane ${payload.pane}${payload.pid ? `, pid ${payload.pid}` : ""}.`);
  if (payload.selector) lines.push(`Address: ${payload.selector} (asks are typed into the pane).`);
  if (payload.attachError) lines.push(`Not addressed: ${payload.attachError}`);
  if (payload.reattached) lines.push("Reattached in the original Ghostty terminal.");
  else if (payload.reattachError) lines.push(`Could not reattach in Ghostty: ${payload.reattachError}`);
  if (!payload.reattached) lines.push(`Attach: ${payload.attachCommand}`);
  return lines.join("\n");
}

const IN_PLACE_REFUSALS: Record<string, string> = {
  not_live: "isn't open in Herdr, Orca, tmux, or a terminal tab on this machine; nothing was sent",
  draft_unsupported: "does not support draft mode",
  session_blocked: "is waiting on a prompt in its terminal; answer that first, then send again",
  in_place_failed: "is open, but Scout couldn't type into it",
  scout_app_unavailable: "is open in the ChatGPT app; open the Scout app on this Mac to send, or use session send --harness codex --draft to fill without sending",
  scout_app_accessibility: "is open in the ChatGPT app; turn on Scout › Settings › System › Send replies into open apps, or use --harness codex --draft",
};

export function renderInPlaceDelivery(sessionId: string, result: InPlaceDelivery): string {
  if (result.ok && result.delivered === "draft") return `draft filled for ${sessionId} in ${result.location}; not sent`;
  if (result.ok) return `sent to ${sessionId} in ${result.location}`;
  const reason = IN_PLACE_REFUSALS[result.code] ?? "couldn't be reached";
  const where = "location" in result ? ` (${result.location})` : "";
  const detail = "detail" in result ? `: ${result.detail}` : "";
  return `session ${sessionId} ${reason}${where}${detail}`;
}

async function runSessionSendAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  let harness: string | undefined;
  let promptFile: string | undefined;
  let draft = false;
  let requestReply = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--request-reply") {
      requestReply = true;
    } else if (arg === "--draft") {
      draft = true;
    } else if (arg === "--harness" || arg === "--prompt-file") {
      const value = args[index + 1];
      index += 1;
      if (!value) throw new ScoutCliError(`${arg} needs a value`);
      if (arg === "--harness") harness = value; else promptFile = value;
    } else if (arg === "--help" || arg === "-h") {
      context.output.writeText(SESSION_HELP);
      return;
    } else if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session send: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  const sessionId = positionals.shift()?.trim();
  if (!sessionId) {
    throw new ScoutCliError("session send needs a <session-id> — e.g. scout session send <session-id> \"run the tests\"");
  }
  let body = (promptFile ? await readCliInputFile(promptFile, "prompt") : positionals.join(" ")).trim();
  if (!body) throw new ScoutCliError("session send needs text to send (inline, or --prompt-file <path>)");

  const own = process.env.CLAUDE_CODE_SESSION_ID?.trim() || process.env.CODEX_THREAD_ID?.trim();
  if (sessionId === own) throw new ScoutCliError("that is the session you are running in; nothing was sent");

  if (requestReply) {
    const address = currentSessionReturnAddress(context.env);
    if (!address) throw new ScoutCliError("No unambiguous sender session id. Use scout ask for tracked replies, or include an explicit return address; nothing was typed.");
    body = stampSessionReturnAddress(body, address);
  }
  const result = await deliverInPlace({ sessionId, harness: harness ?? null, body, ...(draft ? { mode: "draft" as const } : {}) });
  context.output.writeValue({ sessionId, ...result }, () => renderInPlaceDelivery(sessionId, result));
  if (!result.ok) process.exitCode = 1;
}

function quoteForLog(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function quoteForShell(value: string): string {
  if (/^[A-Za-z0-9_./:+=@%-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
