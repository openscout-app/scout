import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askClaudeChannel,
  claudeChannelSocketPath,
  ClaudeChannelSocketInUseError,
  findClaudeChannelHost,
  isClaudeChannelSessionId,
  launchFlagsLoadScoutChannel,
  serveClaudeChannelSocket,
  type ClaudeChannelSocketServer,
} from "./claude-channel-socket.js";

const SESSION = "7d4f98dc-a46e-4759-b118-ee15960643fc";
const OTHER = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

let folder: string | null = null;
const servers: ClaudeChannelSocketServer[] = [];
const raw: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const server of raw.splice(0)) await new Promise((resolve) => server.close(resolve));
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = null;
});

async function channelEnv(): Promise<NodeJS.ProcessEnv> {
  folder = await mkdtemp(join(tmpdir(), "scc-"));
  return { OPENSCOUT_CLAUDE_CHANNEL_DIR: join(folder, "ch") };
}

async function serve(env: NodeJS.ProcessEnv, deliver: (body: string) => Promise<boolean>, hostPid: number | null = 4242) {
  const server = await serveClaudeChannelSocket({ sessionId: SESSION, hostPid, env, deliver });
  servers.push(server);
  return server;
}

/** A listener at the session's path that is not a channel of this version. */
async function foreignListener(path: string, reply: string | null): Promise<void> {
  const server = createServer((socket) => {
    socket.on("data", () => { if (reply !== null) socket.end(`${reply}\n`); });
    socket.on("error", () => undefined);
  });
  raw.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
}

test("session ids are checked, and the socket is named by a short hash that fits in sun_path", () => {
  expect(isClaudeChannelSessionId(SESSION)).toBe(true);
  for (const bad of ["", "short", "../../etc/passwd", "a/b/c/d/e/f/g/h", "a".repeat(129), ".hiddenfile1"]) {
    expect(isClaudeChannelSessionId(bad)).toBe(false);
    expect(claudeChannelSocketPath(bad, { OPENSCOUT_CLAUDE_CHANNEL_DIR: "/tmp/x" })).toBeNull();
  }
  const path = claudeChannelSocketPath(SESSION, { OPENSCOUT_CLAUDE_CHANNEL_DIR: "/tmp/x" })!;
  expect(path).toMatch(/^\/tmp\/x\/[0-9a-f]{16}\.sock$/u);
  expect(claudeChannelSocketPath(OTHER, { OPENSCOUT_CLAUDE_CHANNEL_DIR: "/tmp/x" })).not.toBe(path);
  // The longest dev-instance home in use stays within the limit.
  const env = { HOME: "/Users/someone", OPENSCOUT_INSTANCE: "dev-scout-interconnection-architecture" };
  const long = claudeChannelSocketPath(SESSION, env)!;
  expect(long).toContain("/run/cc/");
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(103);
});

test("a path that cannot fit is refused by name, never truncated", async () => {
  const env = { OPENSCOUT_CLAUDE_CHANNEL_DIR: `/tmp/${"d".repeat(90)}` };
  await expect(serveClaudeChannelSocket({ sessionId: SESSION, env, deliver: async () => true })).rejects.toThrow("too long");
  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toMatchObject({ ok: false, code: "channel_unavailable" });
});

test("a channel answers a ping with its host process, and takes words for its own session", async () => {
  const env = await channelEnv();
  const received: string[] = [];
  const server = await serve(env, async (body) => { received.push(body); return true; });
  expect((await stat(server.path)).mode & 0o777).toBe(0o600);

  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toEqual({ ok: true, sessionId: SESSION, hostPid: 4242 });
  expect(await askClaudeChannel({ op: "deliver", sessionId: SESSION, body: "check the build" }, { env }))
    .toEqual({ ok: true, sessionId: SESSION, hostPid: 4242 });
  expect(received).toEqual(["check the build"]);
});

test("a channel never answers for another session", async () => {
  const env = await channelEnv();
  const received: string[] = [];
  const server = await serve(env, async (body) => { received.push(body); return true; });
  expect(await askClaudeChannel({ op: "deliver", sessionId: OTHER, body: "x" }, { socketPath: server.path }))
    .toMatchObject({ ok: false, code: "channel_refused" });
  expect(received).toEqual([]);
});

test("nothing listening, or a socket file left behind, is unavailable; a new channel takes over a dead path", async () => {
  const env = await channelEnv();
  expect(await askClaudeChannel({ op: "deliver", sessionId: SESSION, body: "x" }, { env }))
    .toMatchObject({ ok: false, code: "channel_unavailable" });

  const first = await serve(env, async () => true);
  await first.close();
  await writeFile(first.path, "");
  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toMatchObject({ ok: false, code: "channel_unavailable" });
  await serve(env, async () => true);
  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toMatchObject({ ok: true });
});

test("a live listener is never unlinked: not a second channel, not a slow one, not one on another version", async () => {
  const env = await channelEnv();
  await serve(env, async () => true);
  await expect(serveClaudeChannelSocket({ sessionId: SESSION, env, deliver: async () => true }))
    .rejects.toBeInstanceOf(ClaudeChannelSocketInUseError);
  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toMatchObject({ ok: true });
  for (const server of servers.splice(0)) await server.close();

  const path = claudeChannelSocketPath(SESSION, env)!;
  for (const reply of [null, JSON.stringify({ ok: false, code: "channel_refused", message: "Unknown request schema." })]) {
    await foreignListener(path, reply);
    await expect(serveClaudeChannelSocket({ sessionId: SESSION, env, deliver: async () => true }))
      .rejects.toBeInstanceOf(ClaudeChannelSocketInUseError);
    expect((await stat(path)).isSocket()).toBe(true);
    for (const server of raw.splice(0)) await new Promise((resolve) => server.close(resolve));
  }
});

test("a channel that closes leaves a newer channel's socket in place", async () => {
  const env = await channelEnv();
  const old = await serve(env, async () => true);
  // The old channel's path goes away (a cleanup, a restart) and a new channel binds it.
  await unlink(old.path);
  const fresh = await serve(env, async () => true);
  await old.close();
  expect((await stat(fresh.path)).isSocket()).toBe(true);
  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toMatchObject({ ok: true });
});

test("Claude Code refusing the notification, or empty words, are reported as not delivered", async () => {
  const env = await channelEnv();
  await serve(env, async () => false);
  expect(await askClaudeChannel({ op: "deliver", sessionId: SESSION, body: "x" }, { env }))
    .toMatchObject({ ok: false, code: "channel_not_accepted" });
  expect(await askClaudeChannel({ op: "deliver", sessionId: SESSION, body: "   " }, { env }))
    .toMatchObject({ ok: false, code: "channel_refused" });
});

test("a channel that takes the words and never answers may have delivered them", async () => {
  const env = await channelEnv();
  await serve(env, () => new Promise<boolean>(() => undefined));
  expect(await askClaudeChannel({ op: "deliver", sessionId: SESSION, body: "x" }, { env, timeoutMs: 200 }))
    .toMatchObject({ ok: false, code: "channel_no_answer" });
});

test("only launch flags that load a Scout channel count", () => {
  expect(launchFlagsLoadScoutChannel(["claude", "--dangerously-load-development-channels", "plugin:scout@openscout"])).toBe(true);
  expect(launchFlagsLoadScoutChannel(["claude", "--channels", "plugin:other@x,plugin:scout@openscout-dev"])).toBe(true);
  expect(launchFlagsLoadScoutChannel(["claude", "--channels=server:scout"])).toBe(true);
  expect(launchFlagsLoadScoutChannel(["claude", "--mcp-config", "scout.json"])).toBe(false);
  expect(launchFlagsLoadScoutChannel(["claude", "--channels", "plugin:telegram@official", "--model", "scout"])).toBe(false);
  expect(launchFlagsLoadScoutChannel(["claude", "--channels", "plugin:scoutish@x"])).toBe(false);
  expect(launchFlagsLoadScoutChannel(["--agent", "claude", "--model", "opus"])).toBe(false);
});

test("the host is the Claude process above, with its current session and how it was started", async () => {
  const env = { CLAUDE_CONFIG_DIR: "/claude" };
  const files: Record<string, string> = {
    "/claude/sessions/300.json": JSON.stringify({ pid: 300, sessionId: SESSION, kind: "interactive" }),
    "/claude/sessions/500.json": JSON.stringify({ pid: 500, sessionId: OTHER, kind: "bg", jobId: "7d4f98dc" }),
    "/claude/jobs/7d4f98dc/state.json": JSON.stringify({ respawnFlags: ["--channels", "plugin:scout@openscout", "--model", "opus"] }),
  };
  const parents: Record<number, number> = { 100: 200, 200: 300, 400: 500 };
  const deps = {
    parentOf: async (pid: number) => parents[pid] ?? null,
    commandOf: async (pid: number) => pid === 300 ? "claude --dangerously-load-development-channels plugin:scout@openscout" : null,
    readFile: async (path: string) => files[path] ?? null,
  };
  // Interactive: the channel runs under a wrapper (200) under Claude (300).
  expect(await findClaudeChannelHost(env, { ...deps, startPid: 100 })).toEqual({ pid: 300, sessionId: SESSION, channelLoaded: true });
  // Background job: its own process line has no flags; the job's state does.
  expect(await findClaudeChannelHost(env, { ...deps, startPid: 400 })).toEqual({ pid: 500, sessionId: OTHER, channelLoaded: true });
  // Started without the channel.
  expect(await findClaudeChannelHost(env, { ...deps, startPid: 100, commandOf: async () => "claude --model opus" }))
    .toEqual({ pid: 300, sessionId: SESSION, channelLoaded: false });
  // No Claude above at all.
  expect(await findClaudeChannelHost(env, { ...deps, startPid: 999 })).toBeNull();
  // A record that names another pid is not this process's record.
  expect(await findClaudeChannelHost(env, { ...deps, startPid: 300, readFile: async (path) => path.endsWith("300.json") ? JSON.stringify({ pid: 301, sessionId: SESSION }) : null }))
    .toBeNull();
});
