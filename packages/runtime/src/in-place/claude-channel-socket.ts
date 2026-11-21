// A Claude Code session's Scout channel, reached by its session id.
//
// The Scout channel (`scout channel`, loaded by the claude-scout plugin) is an
// MCP server inside one Claude Code session. It can put words into that
// session with `notifications/claude/channel`, without a terminal, a pane or a
// composer. Its broker inbox is keyed by agent, and every session in one
// project shares that agent, so the inbox cannot reach one session. This
// socket can: the channel listens on a path named by its own session id, and
// answers only for that id.
//
// One JSON line in, one out, like the Scout app's socket beside it in run/.

import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { deriveOpenScoutInstanceLayout } from "../instance.js";

const REQUEST_SCHEMA = "scout.claude-channel.request.v1";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_REQUEST_BYTES = 256 * 1024;

/** Session ids name files; anything that could leave the directory is refused. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;

export type ClaudeChannelRequest =
  | { op: "ping"; sessionId: string }
  | { op: "deliver"; sessionId: string; body: string };

export type ClaudeChannelReply =
  | { ok: true; sessionId: string }
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

export function isClaudeChannelSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId) && !sessionId.includes("..");
}

export function claudeChannelSocketDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENSCOUT_CLAUDE_CHANNEL_DIR?.trim();
  if (explicit) return explicit;
  return join(deriveOpenScoutInstanceLayout({ env }).openscoutHome, "run", "claude-channel");
}

export function claudeChannelSocketPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isClaudeChannelSessionId(sessionId)) return null;
  return join(claudeChannelSocketDirectory(env), `${sessionId}.sock`);
}

/** Resolves with the channel's reply; never rejects. */
export function askClaudeChannel(
  request: ClaudeChannelRequest,
  options: { timeoutMs?: number; socketPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeChannelReply> {
  const fail = (code: ClaudeChannelFailure, message: string): ClaudeChannelReply => ({ ok: false, code, message });
  const path = options.socketPath ?? claudeChannelSocketPath(request.sessionId, options.env);
  if (!path) return Promise.resolve(fail("channel_refused", "That is not a session id a channel can be named by."));
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
    return { ok: true, sessionId };
  }
  const code = typeof record.code === "string" && ["channel_refused", "channel_not_accepted"].includes(record.code)
    ? record.code as ClaudeChannelFailure
    : "channel_refused";
  return { ok: false, code, message: typeof record.message === "string" ? record.message : "The channel refused." };
}

export type ClaudeChannelSocketServer = {
  path: string;
  close: () => Promise<void>;
};

/**
 * Listen for this session. `deliver` resolves true once Claude Code accepted
 * the notification. Refuses to start when another live channel already answers
 * for the same session, so two never split one session's input.
 */
export async function serveClaudeChannelSocket(input: {
  sessionId: string;
  deliver: (body: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeChannelSocketServer> {
  const { sessionId } = input;
  const path = claudeChannelSocketPath(sessionId, input.env);
  if (!path) throw new Error(`"${sessionId}" cannot name a channel socket.`);
  const directory = claudeChannelSocketDirectory(input.env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  const existing = await askClaudeChannel({ op: "ping", sessionId }, { socketPath: path, timeoutMs: 1_000 });
  if (existing.ok) throw new Error(`Another Scout channel already answers for session ${sessionId}.`);
  await unlink(path).catch(() => undefined);

  const server = createServer((socket) => handleConnection(socket, sessionId, input.deliver));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600).catch(() => undefined);

  let closed = false;
  return {
    path,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await unlink(path).catch(() => undefined);
    },
  };
}

function handleConnection(socket: Socket, sessionId: string, deliver: (body: string) => Promise<boolean>): void {
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
    void respond(buffer.slice(0, newline), sessionId, deliver).then(answer);
  });
}

async function respond(line: string, sessionId: string, deliver: (body: string) => Promise<boolean>): Promise<ClaudeChannelReply> {
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
  if (request.op === "ping") return { ok: true, sessionId };
  if (request.op !== "deliver") return { ok: false, code: "channel_refused", message: "Unknown operation." };
  const body = typeof request.body === "string" ? request.body : "";
  if (!body.trim()) return { ok: false, code: "channel_refused", message: "Nothing to deliver." };
  const accepted = await deliver(body).catch(() => false);
  return accepted
    ? { ok: true, sessionId }
    : { ok: false, code: "channel_not_accepted", message: "Claude Code did not accept the channel notification." };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
