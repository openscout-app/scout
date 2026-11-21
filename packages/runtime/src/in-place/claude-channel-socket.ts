// A Claude Code session's Scout channel, reached by its session id.
//
// The Scout channel (`scout channel`, loaded by the claude-scout plugin) is an
// MCP server inside one Claude Code session. It can put words into that
// session with `notifications/claude/channel`, without a terminal, a pane or a
// composer. Its broker inbox is keyed by agent, and every session in one
// project shares that agent, so the inbox cannot reach one session. This
// socket can: the channel listens on a path named by its host's current
// session id, answers only for that id, and names the Claude process it runs
// in so a sender can check it against Claude's own record of the session.
//
// One JSON line in, one out, like the Scout app's socket beside it in run/.

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import {
  parseClaudeSessionRecord,
  readBoundedClaudeFile,
  resolveClaudeConfigDirectory,
  resolveClaudeSessionRecordsDirectory,
} from "../claude-session-records.js";
import { deriveOpenScoutInstanceLayout } from "../instance.js";
import { execSystemFile } from "../system-probes/exec.js";

const REQUEST_SCHEMA = "scout.claude-channel.request.v1";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_REQUEST_BYTES = 256 * 1024;
/** sun_path is 104 bytes on macOS, 108 on Linux, including the terminator. */
const MAX_SOCKET_PATH_BYTES = 103;
const HOST_SEARCH_DEPTH = 10;

/** Session ids are checked before use; anything odd is refused. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;

export type ClaudeChannelRequest =
  | { op: "ping"; sessionId: string }
  | { op: "deliver"; sessionId: string; body: string };

export type ClaudeChannelReply =
  /** `hostPid` is the Claude Code process the channel runs in, when it knows. */
  | { ok: true; sessionId: string; hostPid: number | null }
  | { ok: false; code: ClaudeChannelFailure; message: string };

export type ClaudeChannelFailure =
  /** Nothing answers at this session's path. Nothing was sent. */
  | "channel_unavailable"
  /** A channel answered, but for another session or with a bad request. Nothing was sent. */
  | "channel_refused"
  /** The channel took the request and Claude Code did not accept the notification. */
  | "channel_not_accepted"
  /** The request was written and no answer came back: the words may have arrived. */
  | "channel_no_answer";

export class ClaudeChannelSocketInUseError extends Error {
  constructor(sessionId: string) {
    super(`Another Scout channel already answers for session ${sessionId}.`);
    this.name = "ClaudeChannelSocketInUseError";
  }
}

export function isClaudeChannelSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function claudeChannelSocketDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENSCOUT_CLAUDE_CHANNEL_DIR?.trim();
  if (explicit) return explicit;
  return join(deriveOpenScoutInstanceLayout({ env }).openscoutHome, "run", "cc");
}

/**
 * Named by a hash of the session id: a socket path must fit in sun_path, and a
 * dev instance's home alone is long. The channel still checks the full id.
 */
export function claudeChannelSocketPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isClaudeChannelSessionId(sessionId)) return null;
  const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return join(claudeChannelSocketDirectory(env), `${name}.sock`);
}

function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES;
}

/** Resolves with the channel's reply; never rejects. */
export function askClaudeChannel(
  request: ClaudeChannelRequest,
  options: { timeoutMs?: number; socketPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeChannelReply> {
  const fail = (code: ClaudeChannelFailure, message: string): ClaudeChannelReply => ({ ok: false, code, message });
  const path = options.socketPath ?? claudeChannelSocketPath(request.sessionId, options.env);
  if (!path) return Promise.resolve(fail("channel_refused", "That is not a session id a channel can be named by."));
  if (!socketPathFits(path)) return Promise.resolve(fail("channel_unavailable", `The channel socket path is too long: ${path}`));
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let written = false;
    let buffer = "";
    let settled = false;
    const finish = (reply: ClaudeChannelReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    // Once the words are written, silence does not mean they were not delivered.
    const silent = () => written && request.op === "deliver"
      ? fail("channel_no_answer", "The channel took the words and did not confirm them.")
      : fail("channel_unavailable", "The session's Scout channel did not answer.");
    const timer = setTimeout(() => finish(silent()), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ schema: REQUEST_SCHEMA, ...request })}\n`, () => { written = true; });
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finish(readReply(buffer.slice(0, newline), request.sessionId));
    });
    socket.on("error", () => finish(written ? silent() : fail("channel_unavailable", "No Scout channel is listening for this session.")));
    socket.on("close", () => finish(silent()));
  });
}

function readReply(line: string, sessionId: string): ClaudeChannelReply {
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    return { ok: false, code: "channel_refused", message: "The channel sent an unreadable reply." };
  }
  const record = (reply ?? {}) as Record<string, unknown>;
  if (record.ok === true) {
    // A channel for another session must never be taken for this one.
    if (record.sessionId !== sessionId) {
      return { ok: false, code: "channel_refused", message: "A channel answered for a different session." };
    }
    const hostPid = typeof record.hostPid === "number" && Number.isInteger(record.hostPid) && record.hostPid > 1 ? record.hostPid : null;
    return { ok: true, sessionId, hostPid };
  }
  const code = typeof record.code === "string" && ["channel_refused", "channel_not_accepted"].includes(record.code)
    ? record.code as ClaudeChannelFailure
    : "channel_refused";
  return { ok: false, code, message: typeof record.message === "string" ? record.message : "The channel refused." };
}

/**
 * Whether something listens at `path`. Only a refused or missing path is
 * stale: a listener that is slow, or speaks another version, is still in use.
 */
async function socketPathState(path: string): Promise<"stale" | "in_use"> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (state: "stale" | "in_use") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish("in_use"), 1_000);
    socket.on("connect", () => finish("in_use"));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(error.code ?? "") ? "stale" : "in_use");
    });
  });
}

export type ClaudeChannelSocketServer = {
  path: string;
  sessionId: string;
  close: () => Promise<void>;
};

/**
 * Listen for one session. `deliver` resolves true once Claude Code accepted
 * the notification. Throws ClaudeChannelSocketInUseError while another
 * listener holds the path, so two never split one session's input; the caller
 * may try again later.
 */
export async function serveClaudeChannelSocket(input: {
  sessionId: string;
  deliver: (body: string) => Promise<boolean>;
  hostPid?: number | null;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeChannelSocketServer> {
  const { sessionId } = input;
  const path = claudeChannelSocketPath(sessionId, input.env);
  if (!path) throw new Error(`"${sessionId}" cannot name a channel socket.`);
  if (!socketPathFits(path)) throw new Error(`The channel socket path is too long for this system: ${path}`);
  const directory = claudeChannelSocketDirectory(input.env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  if (await socketPathState(path) === "in_use") throw new ClaudeChannelSocketInUseError(sessionId);

  // Bun and Node remove a server's path when it closes, even if another
  // channel has bound that path since. So bind a private name and rename it
  // into place: closing then removes only the private name, already gone.
  const hostPid = input.hostPid ?? null;
  const bound = join(directory, `.${randomBytes(6).toString("hex")}.sock`);
  const server = createServer((socket) => handleConnection(socket, sessionId, hostPid, input.deliver));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bound, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let own: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    await chmod(bound, 0o600);
    await rename(bound, path);
    own = await stat(path);
  } catch (error) {
    await closeServer(server);
    await unlink(bound).catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    path,
    sessionId,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
      // Another channel may have taken the path since; only our own is removed.
      const now = await stat(path).catch(() => null);
      if (now && now.ino === own.ino && now.dev === own.dev) await unlink(path).catch(() => undefined);
    },
  };
}

function handleConnection(
  socket: Socket,
  sessionId: string,
  hostPid: number | null,
  deliver: (body: string) => Promise<boolean>,
): void {
  let buffer = "";
  let handled = false;
  const answer = (reply: ClaudeChannelReply) => {
    socket.end(`${JSON.stringify(reply)}\n`);
  };
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (buffer.length > MAX_REQUEST_BYTES) {
      handled = true;
      answer({ ok: false, code: "channel_refused", message: "The request is too large." });
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    void respond(buffer.slice(0, newline), sessionId, hostPid, deliver).then(answer);
  });
}

async function respond(
  line: string,
  sessionId: string,
  hostPid: number | null,
  deliver: (body: string) => Promise<boolean>,
): Promise<ClaudeChannelReply> {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ok: false, code: "channel_refused", message: "The request is not JSON." };
  }
  if (request.schema !== REQUEST_SCHEMA) return { ok: false, code: "channel_refused", message: "Unknown request schema." };
  if (request.sessionId !== sessionId) {
    return { ok: false, code: "channel_refused", message: "This channel belongs to another session." };
  }
  if (request.op === "ping") return { ok: true, sessionId, hostPid };
  if (request.op !== "deliver") return { ok: false, code: "channel_refused", message: "Unknown operation." };
  const body = typeof request.body === "string" ? request.body : "";
  if (!body.trim()) return { ok: false, code: "channel_refused", message: "Nothing to deliver." };
  const accepted = await deliver(body).catch(() => false);
  return accepted
    ? { ok: true, sessionId, hostPid }
    : { ok: false, code: "channel_not_accepted", message: "Claude Code did not accept the channel notification." };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Whether launch flags load a Scout channel. Claude Code routes channel
 * notifications only from servers named by `--channels` or
 * `--dangerously-load-development-channels`, and never tells the server, so
 * without this a channel would report words Claude Code silently dropped.
 */
export function launchFlagsLoadScoutChannel(flags: readonly string[]): boolean {
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!;
    const [name, inline] = flag.split("=", 2) as [string, string | undefined];
    if (name !== "--channels" && name !== "--dangerously-load-development-channels") continue;
    const values = inline !== undefined ? [inline] : [];
    for (let next = index + 1; inline === undefined && next < flags.length && !flags[next]!.startsWith("-"); next += 1) {
      values.push(flags[next]!);
    }
    if (values.flatMap((value) => value.split(",")).some((value) => /(^|[:@/])scout([@:]|$)/u.test(value.trim()))) return true;
  }
  return false;
}

export type ClaudeChannelHost = {
  /** The Claude Code process this channel runs under. */
  pid: number;
  /** The session that process holds now; it changes on /clear and /resume. */
  sessionId: string;
  /** Whether that process was started with a Scout channel loaded. */
  channelLoaded: boolean;
};

export type FindClaudeChannelHostDeps = {
  startPid?: number;
  parentOf?: (pid: number) => Promise<number | null>;
  commandOf?: (pid: number) => Promise<string | null>;
  readFile?: (path: string) => Promise<string | null>;
};

/**
 * The Claude Code process above this one, by its session record
 * (~/.claude/sessions/<pid>.json). A background job's own process line carries
 * no flags; its job's state.json keeps the flags it was started with.
 */
export async function findClaudeChannelHost(
  env: NodeJS.ProcessEnv = process.env,
  deps: FindClaudeChannelHostDeps = {},
): Promise<ClaudeChannelHost | null> {
  const parentOf = deps.parentOf ?? parentPid;
  const commandOf = deps.commandOf ?? processCommand;
  const read = deps.readFile ?? ((path: string) => readBoundedClaudeFile(path));
  const records = resolveClaudeSessionRecordsDirectory(env);
  let pid: number | null = deps.startPid ?? process.ppid;
  for (let depth = 0; depth < HOST_SEARCH_DEPTH && pid !== null && pid > 1; depth += 1) {
    const recordPath = join(records, `${pid}.json`);
    const raw = await read(recordPath).catch(() => null);
    const record = raw ? parseClaudeSessionRecord(raw, recordPath) : null;
    if (record && record.pid === pid && isClaudeChannelSessionId(record.sessionId)) {
      let flags: string[] = [];
      if (record.kind === "bg" && record.jobId) {
        const state = await read(join(resolveClaudeConfigDirectory(env), "jobs", record.jobId, "state.json")).catch(() => null);
        flags = respawnFlags(state);
      } else {
        flags = (await commandOf(pid).catch(() => null))?.split(/\s+/u).filter(Boolean) ?? [];
      }
      return { pid, sessionId: record.sessionId, channelLoaded: launchFlagsLoadScoutChannel(flags) };
    }
    pid = await parentOf(pid).catch(() => null);
  }
  return null;
}

function respawnFlags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const flags = (JSON.parse(raw) as { respawnFlags?: unknown }).respawnFlags;
    return Array.isArray(flags) ? flags.filter((flag): flag is string => typeof flag === "string") : [];
  } catch {
    return [];
  }
}

async function parentPid(pid: number): Promise<number | null> {
  const { stdout } = await execSystemFile("ps", ["-p", String(pid), "-o", "ppid="], { timeoutMs: 2_000, maxStdoutBytes: 1024 });
  const parent = Number(stdout.trim());
  return Number.isInteger(parent) && parent > 0 ? parent : null;
}

async function processCommand(pid: number): Promise<string | null> {
  const { stdout } = await execSystemFile("ps", ["-p", String(pid), "-o", "command="], { timeoutMs: 2_000, maxStdoutBytes: 16 * 1024 });
  return stdout.trim() || null;
}
