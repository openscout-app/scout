import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askClaudeChannel,
  claudeChannelSocketPath,
  isClaudeChannelSessionId,
  serveClaudeChannelSocket,
  type ClaudeChannelSocketServer,
} from "./claude-channel-socket.js";

const SESSION = "7d4f98dc-a46e-4759-b118-ee15960643fc";
const OTHER = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

let folder: string | null = null;
const servers: ClaudeChannelSocketServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = null;
});

async function channelEnv(): Promise<NodeJS.ProcessEnv> {
  // Short: a unix socket path must fit in about 100 bytes.
  folder = await mkdtemp(join(tmpdir(), "scc-"));
  return { OPENSCOUT_CLAUDE_CHANNEL_DIR: join(folder, "ch") };
}

async function serve(env: NodeJS.ProcessEnv, deliver: (body: string) => Promise<boolean>, sessionId = SESSION) {
  const server = await serveClaudeChannelSocket({ sessionId, env, deliver });
  servers.push(server);
  return server;
}

test("only ids that cannot leave the socket directory name a channel", () => {
  expect(isClaudeChannelSessionId(SESSION)).toBe(true);
  for (const bad of ["", "short", "../../etc/passwd", "a/b/c/d/e/f/g/h", `${"a".repeat(129)}`, "abc..defgh", ".hiddenfile1"]) {
    expect(isClaudeChannelSessionId(bad)).toBe(false);
    expect(claudeChannelSocketPath(bad, { OPENSCOUT_CLAUDE_CHANNEL_DIR: "/tmp/x" })).toBeNull();
  }
  expect(claudeChannelSocketPath(SESSION, { OPENSCOUT_CLAUDE_CHANNEL_DIR: "/tmp/x" })).toBe(`/tmp/x/${SESSION}.sock`);
});

test("a channel answers a ping and takes words for its own session", async () => {
  const env = await channelEnv();
  const received: string[] = [];
  const server = await serve(env, async (body) => { received.push(body); return true; });
  expect((await stat(server.path)).mode & 0o777).toBe(0o600);

  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toEqual({ ok: true, sessionId: SESSION });
  expect(await askClaudeChannel({ op: "deliver", sessionId: SESSION, body: "check the build" }, { env }))
    .toEqual({ ok: true, sessionId: SESSION });
  expect(received).toEqual(["check the build"]);
});

test("a channel never answers for another session, and a reply for another session is not taken", async () => {
  const env = await channelEnv();
  const received: string[] = [];
  const server = await serve(env, async (body) => { received.push(body); return true; });

  // Asked at this channel's path, but for another session.
  const refused = await askClaudeChannel({ op: "deliver", sessionId: OTHER, body: "x" }, { socketPath: server.path });
  expect(refused).toMatchObject({ ok: false, code: "channel_refused" });
  expect(received).toEqual([]);
});

test("nothing listening, or a socket file left behind, is unavailable with nothing sent", async () => {
  const env = await channelEnv();
  expect(await askClaudeChannel({ op: "deliver", sessionId: SESSION, body: "x" }, { env }))
    .toMatchObject({ ok: false, code: "channel_unavailable" });

  // A channel that exited without cleaning up leaves its path behind; a new one replaces it.
  const server = await serve(env, async () => true);
  await server.close();
  await writeFile(server.path, "");
  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toMatchObject({ ok: false, code: "channel_unavailable" });
  await serve(env, async () => true);
  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toEqual({ ok: true, sessionId: SESSION });
});

test("a second channel for a session that already has a live one does not start", async () => {
  const env = await channelEnv();
  await serve(env, async () => true);
  await expect(serveClaudeChannelSocket({ sessionId: SESSION, env, deliver: async () => true }))
    .rejects.toThrow("already answers");
  expect(await askClaudeChannel({ op: "ping", sessionId: SESSION }, { env })).toEqual({ ok: true, sessionId: SESSION });
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
