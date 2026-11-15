import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSharedScoutTools } from "./shared-tools.ts";
import { codexThreadIdFromMeta, codexTurnIdFromMeta, findCodexRollout, readCodexRolloutCwd, uuidV7Time } from "./codex-threads.ts";
import { parseLsofPeer, parseProcArgs2, readProcessEnvironment, resolvePeerIdentity, type PeerIdentity } from "./peer-process.ts";
import { runtimeMismatch, sessionEnvironment, startSharedScoutMcpServer, type SharedMcpServerHandle } from "./shared-http.ts";

const THREAD = "01a1de30-0d85-7523-91ab-a55828c0e4ac";
const OTHER_THREAD = "01a1de30-2422-7520-8aaa-30d696b4c9ea";

/** The metadata codex-cli 0.169 puts on a tools/call (trimmed). */
function codexMeta(threadId: string, turnId: string) {
  return {
    callId: "exec-1",
    "x-codex-turn-metadata": { session_id: threadId, thread_id: threadId, turn_id: turnId, model: "m", codex_version: "0.169.0" },
    threadId,
    sessionId: threadId,
    progressToken: 1,
  };
}

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** Writes a thread's rollout where Codex files it, by the date in the thread id. */
function writeRollout(home: string, threadId: string, lines: string[]): string {
  const directory = join(home, "sessions", localDay(uuidV7Time(threadId)!));
  mkdirSync(directory, { recursive: true });
  const rollout = join(directory, `rollout-2026-11-15T01-00-00-${threadId}.jsonl`);
  writeFileSync(rollout, lines.join("\n"));
  return rollout;
}

/** A CODEX_HOME holding one rollout for THREAD: started in /work/start, latest turn in `turnCwd`. */
function codexHomeWithRollout(turnCwd: string): { home: string; rollout: string } {
  const home = mkdtempSync(join(tmpdir(), "scout-codex-home-"));
  const rollout = writeRollout(home, THREAD, [
    JSON.stringify({ type: "session_meta", payload: { id: THREAD, cwd: "/work/start" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1", cwd: "/work/first-turn" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-2", cwd: turnCwd } }),
    "",
  ]);
  return { home, rollout };
}

function stubIdentity(overrides: Partial<PeerIdentity> = {}): (pid: number) => Promise<PeerIdentity> {
  return async (pid) => ({
    pid, harnessPid: pid, harness: "codex", processName: "codex", sessionId: null, cwd: "/work/app-server",
    env: { HOME: "/h", PATH: process.env.PATH ?? "" }, ...overrides,
  });
}

/** A runtime that answers every request and records each POST body. */
function recordingRuntime() {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async (request) => {
      if (request.method === "POST") bodies.push(await request.json());
      return Response.json({ ok: true });
    },
  });
  return { bodies, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function connectClient(url: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}

function rpc(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

function procArgs(argv: string[], env: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = [encoder.encode("/usr/bin/tool\0\0\0"), ...argv.map((a) => encoder.encode(`${a}\0`)), ...env.map((e) => encoder.encode(`${e}\0`)), encoder.encode("\0")];
  const size = 4 + parts.reduce((n, p) => n + p.length, 0);
  const buffer = new Uint8Array(size);
  new DataView(buffer.buffer).setInt32(0, argv.length, true);
  let offset = 4;
  for (const part of parts) { buffer.set(part, offset); offset += part.length; }
  return buffer;
}

describe("peer process lookup", () => {
  test("parses KERN_PROCARGS2, keeping values with spaces and equals signs", () => {
    const parsed = parseProcArgs2(procArgs(["tool", "--flag=a b"], ["HOME=/Users/x", "SUPPORT=/Library/Application Support/X", "Q=a=b"]));
    expect(parsed.argv).toEqual(["tool", "--flag=a b"]);
    expect(parsed.env).toEqual({ HOME: "/Users/x", SUPPORT: "/Library/Application Support/X", Q: "a=b" });
  });

  test("picks the client end of a loopback socket pair from lsof output", () => {
    const output = ["p100", "n127.0.0.1:43198->127.0.0.1:52001", "p200", "n127.0.0.1:52001->127.0.0.1:43198", ""].join("\n");
    expect(parseLsofPeer(output, 52001)).toBe(200);
    // Both ends in one process.
    expect(parseLsofPeer(["p100", "n127.0.0.1:43198->127.0.0.1:52002", "n127.0.0.1:52002->127.0.0.1:43198"].join("\n"), 52002)).toBe(100);
    expect(parseLsofPeer("p100\nn127.0.0.1:1->127.0.0.1:2\n", 52003)).toBeNull();
  });

  test.if(process.platform === "darwin")("reads this process's own environment", async () => {
    const env = await readProcessEnvironment(process.pid);
    expect(env?.HOME).toBe(process.env.HOME);
  });

  test.if(process.platform === "darwin")("a session id in a non-harness process's own environment names it", async () => {
    // Same precedence as the stdio server: OPENSCOUT_SESSION_ID, then
    // CODEX_THREAD_ID, then CLAUDE_CODE_SESSION_ID. Start from a clean slate.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|CODEX_|OPENSCOUT_SESSION_ID$)/.test(k)));
    // Not /bin/sleep: macOS hides the environment of its own platform binaries.
    const proc = Bun.spawn(["bun", "-e", "await Bun.sleep(5000)"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "own-session" } });
    try {
      await Bun.sleep(200);
      const identity = await resolvePeerIdentity(proc.pid);
      expect(identity.sessionId).toBe("own-session");
      expect(identity.harnessPid).toBe(proc.pid);
    } finally {
      proc.kill();
    }
  });
});

describe("session environment", () => {
  test("drops the shared process's own session keys and takes the peer's", () => {
    const env = sessionEnvironment(
      { HOME: "/h", OPENSCOUT_BROKER_URL: "http://runtime", OPENSCOUT_AGENT: "server-agent", CLAUDE_CODE_SESSION_ID: "server-session", TMUX_PANE: "%1" },
      { CLAUDE_CODE_SESSION_ID: "peer-session", PWD: "/p" },
    );
    expect(env).toEqual({ HOME: "/h", OPENSCOUT_BROKER_URL: "http://runtime", CLAUDE_CODE_SESSION_ID: "peer-session", PWD: "/p" });
  });

  test("the server's runtime wins over the one a session names", () => {
    const env = sessionEnvironment(
      { OPENSCOUT_BROKER_URL: "http://runtime", OPENSCOUT_WEB_PORT: "1" },
      { OPENSCOUT_BROKER_URL: "http://other", OPENSCOUT_WEB_PORT: "2", OPENSCOUT_AGENT: "peer" },
    );
    expect(env).toEqual({ OPENSCOUT_BROKER_URL: "http://runtime", OPENSCOUT_WEB_PORT: "1", OPENSCOUT_AGENT: "peer" });
  });
});

describe("shared tool definitions", () => {
  test("nothing that names a session is read while the shared tools are built", () => {
    const tools = createSharedScoutTools({ HOME: "/h", PATH: process.env.PATH });
    const sessionKeys = [...tools.buildTimeReads].filter((key) => !/^(OPENSCOUT_BROKER_|OPENSCOUT_WEB_|SCOUT_WEB_|OPENSCOUT_EXPOSE_)/.test(key));
    expect(sessionKeys).toEqual([]);
    expect(tools.methods).toContain("tools/call");
  });

  test("concurrent calls on two connections each see their own session", async () => {
    // The runtime holds every request open and records what each call sent,
    // so calls from both connections are suspended at the same time.
    const bodies: any[] = [];
    let open = 0;
    let maxOpen = 0;
    const runtime = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: async (request) => {
        open += 1; maxOpen = Math.max(maxOpen, open);
        if (request.method === "POST") bodies.push(await request.json());
        await Bun.sleep(150);
        open -= 1;
        return Response.json({ ok: true });
      },
    });
    try {
      const runtimeUrl = `http://127.0.0.1:${runtime.port}`;
      const tools = createSharedScoutTools({ HOME: "/h", PATH: process.env.PATH, OPENSCOUT_BROKER_URL: runtimeUrl });
      const connect = async (name: string) => {
        const context = {
          env: { HOME: "/h", PATH: process.env.PATH, OPENSCOUT_BROKER_URL: runtimeUrl, OPENSCOUT_AGENT: `agent-${name}`, CLAUDE_CODE_SESSION_ID: `session-${name}` },
          currentDirectory: `/work/${name}`,
          scope: { lifetime: new AbortController().signal, flights: new Set<string>(), notify: async () => {} },
        };
        const server = tools.connect(context);
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        const client = new Client({ name, version: "0" });
        await client.connect(a);
        return client;
      };
      const [one, two] = await Promise.all([connect("one"), connect("two")]);
      // `show` reads the session on both sides of an await, then posts the caller.
      const show = (client: Client, caption: string) => client.callTool({ name: "show", arguments: { path: "/work/shot.png", caption } });
      await Promise.all([show(one, "one-a"), show(two, "two-a"), show(one, "one-b"), show(two, "two-b")]);
      expect(maxOpen).toBeGreaterThanOrEqual(2);
      const seen = bodies
        .map((b) => [b.caption, b.caller.actorId, b.caller.currentDirectory, b.caller.metadata.sessionId, b.caller.metadata.harness])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      expect(seen).toEqual([
        ["one-a", "agent-one", "/work/one", "session-one", "claude"],
        ["one-b", "agent-one", "/work/one", "session-one", "claude"],
        ["two-a", "agent-two", "/work/two", "session-two", "claude"],
        ["two-b", "agent-two", "/work/two", "session-two", "claude"],
      ]);
      expect((await one.listTools()).tools.length).toBe((await two.listTools()).tools.length);
      await Promise.all([one.close(), two.close()]);
    } finally {
      runtime.stop(true);
    }
  });
});

describe.if(process.platform === "darwin")("shared server", () => {
  let handle: SharedMcpServerHandle | undefined;
  afterEach(async () => { await handle?.stop(); handle = undefined; });

  test("serves several connections from one process, one Scout server each", async () => {
    handle = startSharedScoutMcpServer({ log: () => {} });
    const clients = await Promise.all([0, 1, 2].map(async () => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(handle!.url)));
      return client;
    }));
    const lists = await Promise.all(clients.map((c) => c.listTools()));
    expect(lists.every((l) => l.tools.some((t) => t.name === "whoami"))).toBe(true);
    expect(handle.connections()).toHaveLength(3);
    expect(new Set(handle.connections().map((c) => c.id)).size).toBe(3);
    expect(handle.connections().every((c) => c.identity.pid === process.pid)).toBe(true);
    await Promise.all(clients.map((c) => c.close()));
  });

  test("an unknown session id gets 404 so the client starts over", async () => {
    handle = startSharedScoutMcpServer({ log: () => {} });
    const response = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "missing" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
  });

  test("a Codex connection runs each call as the thread it names, in that thread's latest folder", async () => {
    const runtime = recordingRuntime();
    const { home } = codexHomeWithRollout("/work/latest-turn");
    try {
      handle = startSharedScoutMcpServer({
        env: { HOME: "/h", PATH: process.env.PATH, OPENSCOUT_BROKER_URL: runtime.url },
        log: () => {},
        resolveIdentity: stubIdentity({ env: { HOME: "/h", PATH: process.env.PATH ?? "", CODEX_HOME: home } }),
      });
      const { client } = await connectClient(handle.url);
      // Codex lists tools before any thread is known; that is process-scoped.
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      expect(handle.connections()[0]!.thread).toBeNull();

      await client.callTool({ name: "show", arguments: { path: "/work/shot.png", caption: "a" }, _meta: codexMeta(THREAD, "turn-2") });
      const caller = runtime.bodies.at(-1).caller;
      expect([caller.metadata.sessionId, caller.metadata.harness, caller.currentDirectory]).toEqual([THREAD, "codex", "/work/latest-turn"]);

      const [listed] = await (await fetch(handle.url.replace("/mcp", "/sessions"))).json() as any[];
      expect(listed).toMatchObject({ harness: "codex", sessionId: THREAD, cwd: "/work/latest-turn" });
      // The MCP session id authorizes requests; /sessions never shows it.
      expect(JSON.stringify(listed)).not.toContain(handle.connections()[0]!.id);

      // A call that names another thread is refused, and nothing reaches the runtime.
      const posts = runtime.bodies.length;
      await expect(client.callTool({ name: "show", arguments: { path: "/work/shot.png", caption: "b" }, _meta: codexMeta(OTHER_THREAD, "turn-9") }))
        .rejects.toThrow(/belongs to Codex thread/);
      expect(runtime.bodies.length).toBe(posts);
      await client.close();
    } finally {
      runtime.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two first calls naming different threads at once: one binds, the other is refused", async () => {
    const runtime = recordingRuntime();
    const { home, rollout } = codexHomeWithRollout("/work/thread-a");
    writeRollout(home, OTHER_THREAD, [JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-b", cwd: "/work/thread-b" } }), ""]);
    try {
      handle = startSharedScoutMcpServer({
        env: { HOME: "/h", PATH: process.env.PATH, OPENSCOUT_BROKER_URL: runtime.url },
        log: () => {},
        resolveIdentity: stubIdentity({ env: { HOME: "/h", PATH: process.env.PATH ?? "", CODEX_HOME: home } }),
      });
      const { client } = await connectClient(handle.url);
      // The first call names a turn the rollout doesn't hold yet, so its
      // lookup is still waiting when the second call arrives.
      const first = Promise.allSettled([client.callTool({ name: "show", arguments: { path: "/work/a.png", caption: "a" }, _meta: codexMeta(THREAD, "turn-3") })]);
      await Bun.sleep(80);
      const second = Promise.allSettled([client.callTool({ name: "show", arguments: { path: "/work/b.png", caption: "b" }, _meta: codexMeta(OTHER_THREAD, "turn-b") })]);
      await Bun.sleep(120);
      appendFileSync(rollout, `${JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-3", cwd: "/work/thread-a-3" } })}\n`);
      const results = [...await first, ...await second];
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/belongs to Codex thread/);
      expect(runtime.bodies.map((body) => [body.caller.metadata.sessionId, body.caller.currentDirectory])).toEqual([[THREAD, "/work/thread-a-3"]]);
      expect(handle.connections()[0]!.thread!.id).toBe(THREAD);
      await client.close();
    } finally {
      runtime.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a Codex call that names no thread, or whose folder can't be found", async () => {
    const runtime = recordingRuntime();
    const home = mkdtempSync(join(tmpdir(), "scout-codex-home-"));
    try {
      handle = startSharedScoutMcpServer({
        env: { HOME: "/h", PATH: process.env.PATH, OPENSCOUT_BROKER_URL: runtime.url },
        log: () => {},
        resolveIdentity: stubIdentity({ env: { HOME: "/h", PATH: process.env.PATH ?? "", CODEX_HOME: home } }),
      });
      const { client } = await connectClient(handle.url);
      await expect(client.callTool({ name: "show", arguments: { path: "/work/a.png", caption: "a" } }))
        .rejects.toThrow(/without _meta.threadId/);
      await expect(client.callTool({ name: "show", arguments: { path: "/work/a.png", caption: "a" }, _meta: codexMeta(THREAD, "turn-1") }))
        .rejects.toThrow(/found no rollout/);
      expect(runtime.bodies.length).toBe(0);
      await client.close();
    } finally {
      runtime.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session id works only from the process that opened it", async () => {
    handle = startSharedScoutMcpServer({ log: () => {} });
    const { client } = await connectClient(handle.url);
    const sessionId = handle.connections()[0]!.id;
    const script = `const r = await fetch(${JSON.stringify(handle.url)}, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": ${JSON.stringify(sessionId)} }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) }); console.log(r.status);`;
    const other = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
    expect((await new Response(other.stdout).text()).trim()).toBe("403");
    // The owner still works.
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  test("refuses foreign hosts and browser origins", async () => {
    handle = startSharedScoutMcpServer({ log: () => {} });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    expect((await rpc(handle.url, init, { origin: "https://example.com" })).status).toBe(403);
    expect((await rpc(handle.url, init, { host: "attacker.example" })).status).toBe(403);
    expect((await fetch(handle.url.replace("/mcp", "/sessions"), { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await rpc(handle.url, init, { origin: `http://127.0.0.1:${handle.port}` })).status).toBe(200);
  });

  test("answers a probe without a session before resolving the peer", async () => {
    let resolved = 0;
    const resolveIdentity = stubIdentity();
    handle = startSharedScoutMcpServer({ log: () => {}, resolveIdentity: (pid) => { resolved += 1; return resolveIdentity(pid); } });
    // Claude sends server/discover before initialize.
    const response = await rpc(handle.url, { jsonrpc: "2.0", id: 0, method: "server/discover", params: {} });
    expect(response.status).toBe(400);
    expect(resolved).toBe(0);
    expect(handle.connections()).toHaveLength(0);
  });

  test("refuses a session that names another runtime", async () => {
    handle = startSharedScoutMcpServer({
      env: { HOME: "/h", PATH: process.env.PATH, OPENSCOUT_BROKER_URL: "http://127.0.0.1:43110" },
      log: () => {},
      resolveIdentity: stubIdentity({ env: { OPENSCOUT_BROKER_URL: "http://127.0.0.1:24400" } }),
    });
    const response = await rpc(handle.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("http://127.0.0.1:24400");
    expect(handle.connections()).toHaveLength(0);
  });

  test("drops an idle Codex connection; Codex gets 404 and starts over", async () => {
    handle = startSharedScoutMcpServer({ log: () => {}, idleTimeoutMs: 150, reapIntervalMs: 50, resolveIdentity: stubIdentity() });
    const { client } = await connectClient(handle.url);
    const sessionId = handle.connections()[0]!.id;
    await Bun.sleep(400);
    expect(handle.connections()).toHaveLength(0);
    expect((await rpc(handle.url, { jsonrpc: "2.0", id: 9, method: "tools/list" }, { "mcp-session-id": sessionId })).status).toBe(404);
    await client.close().catch(() => {});
  });

  test("keeps an idle Claude connection: its process exiting ends it", async () => {
    handle = startSharedScoutMcpServer({ log: () => {}, idleTimeoutMs: 150, reapIntervalMs: 50, resolveIdentity: stubIdentity({ harness: "claude", processName: "claude" }) });
    const { client } = await connectClient(handle.url);
    await Bun.sleep(400);
    expect(handle.connections()).toHaveLength(1);
    await client.close();
  });
});

describe("Codex threads", () => {
  test("reads the thread and turn from the metadata Codex sends", () => {
    expect(codexThreadIdFromMeta(codexMeta(THREAD, "turn-1"))).toBe(THREAD);
    expect(codexThreadIdFromMeta({ "x-codex-turn-metadata": { thread_id: THREAD.toUpperCase() } })).toBe(THREAD);
    expect(codexTurnIdFromMeta(codexMeta(THREAD, "turn-1"))).toBe("turn-1");
    // Claude's metadata names a tool use, not a session.
    expect(codexThreadIdFromMeta({ "claudecode/toolUseId": "toolu_1", progressToken: 2 })).toBeNull();
    expect(codexThreadIdFromMeta({ threadId: "../../etc" })).toBeNull();
    expect(codexThreadIdFromMeta(undefined)).toBeNull();
  });

  test("finds a thread's rollout by the date in its id and reads its latest folder", async () => {
    const { home, rollout } = codexHomeWithRollout("/work/latest-turn");
    try {
      expect(await findCodexRollout(THREAD, home)).toBe(rollout);
      expect(await findCodexRollout(OTHER_THREAD, home)).toBeNull();
      expect(await readCodexRolloutCwd(rollout)).toBe("/work/latest-turn");
      writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/work/start" } })}\n`);
      expect(await readCodexRolloutCwd(rollout)).toBe("/work/start");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads the named turn's folder past megabytes of output", async () => {
    const home = mkdtempSync(join(tmpdir(), "scout-codex-home-"));
    // Multibyte text, so chunk edges fall inside characters; one line longer
    // than a chunk; and a quoted turn_context inside output, which isn't one.
    const output = (index: number) => JSON.stringify({ type: "response_item", payload: { text: `${"é—".repeat(400)} ${index} {"type":"turn_context","payload":{"cwd":"/fake"}}` } });
    const rollout = writeRollout(home, THREAD, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/work/start" } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1", cwd: "/work/first" } }),
      ...Array.from({ length: 300 }, (_, index) => output(index)),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-2", cwd: "/work/moved" } }),
      JSON.stringify({ type: "response_item", payload: { text: "x".repeat(300 * 1024) } }),
      ...Array.from({ length: 300 }, (_, index) => output(index)),
      "",
    ]);
    try {
      expect(Bun.file(rollout).size).toBeGreaterThan(1024 * 1024);
      expect(await readCodexRolloutCwd(rollout, "turn-2")).toBe("/work/moved");
      expect(await readCodexRolloutCwd(rollout)).toBe("/work/moved");
      expect(await readCodexRolloutCwd(rollout, "turn-1")).toBe("/work/first");
      expect(await readCodexRolloutCwd(rollout, "turn-3")).toBeNull();
      // A Codex whose turn_context names no turn: its latest turn is the one.
      writeRollout(home, THREAD, [
        JSON.stringify({ type: "turn_context", payload: { cwd: "/work/old" } }),
        JSON.stringify({ type: "turn_context", payload: { cwd: "/work/new" } }),
        "",
      ]);
      expect(await readCodexRolloutCwd(rollout, "turn-9")).toBe("/work/new");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runtime mismatch", () => {
  const server = { OPENSCOUT_BROKER_URL: "http://127.0.0.1:43110" };
  test("the same runtime spelled differently is not a mismatch", () => {
    expect(runtimeMismatch(server, { OPENSCOUT_BROKER_URL: "http://localhost:43110/" }, "http://127.0.0.1:43110")).toBeNull();
    expect(runtimeMismatch(server, {}, "http://127.0.0.1:43110")).toBeNull();
    // Agents the runtime starts get its LAN address, as seen on live Codex app-servers.
    const local = new Set(["localhost", "127.0.0.1", "::1", "192.0.2.25", "host-a"]);
    expect(runtimeMismatch(server, { OPENSCOUT_BROKER_URL: "https://192.0.2.25:43110" }, "http://127.0.0.1:43110", local)).toBeNull();
    expect(runtimeMismatch(server, { OPENSCOUT_BROKER_URL: "http://host-a:43110" }, "http://127.0.0.1:43110", local)).toBeNull();
    // This machine's real addresses count without being listed.
    expect(runtimeMismatch(server, { OPENSCOUT_BROKER_URL: "http://[::1]:43110" }, "http://127.0.0.1:43110")).toBeNull();
  });
  test("another runtime or another instance is", () => {
    const local = new Set(["localhost", "127.0.0.1", "::1", "192.0.2.25"]);
    expect(runtimeMismatch(server, { OPENSCOUT_BROKER_URL: "https://192.0.2.40:43110" }, "http://127.0.0.1:43110", local)).toContain("192.0.2.40");
    expect(runtimeMismatch(server, { OPENSCOUT_BROKER_URL: "http://127.0.0.1:24400" }, "http://127.0.0.1:43110")).toContain("24400");
    expect(runtimeMismatch({}, { OPENSCOUT_INSTANCE: "dev" }, "http://127.0.0.1:43110")).toContain("instance dev");
    expect(runtimeMismatch({}, { OPENSCOUT_INSTANCE: "default" }, "http://127.0.0.1:43110")).toBeNull();
  });
});

describe("MCP SDK internals", () => {
  test("the SDK is the version the shared tools were checked against", async () => {
    // shared-tools.ts copies Protocol._requestHandlers and reads _capabilities,
    // _serverInfo and _instructions. After an SDK upgrade, check those fields
    // still exist and mean the same, run this file, then update the version.
    const entry = Bun.resolveSync("@modelcontextprotocol/sdk/server/index.js", import.meta.dir);
    let directory = dirname(entry);
    while (!(await Bun.file(join(directory, "package.json")).exists()) || (await Bun.file(join(directory, "package.json")).json()).name !== "@modelcontextprotocol/sdk") {
      directory = dirname(directory);
    }
    expect((await Bun.file(join(directory, "package.json")).json()).version).toBe("1.29.0");
    const tools = createSharedScoutTools({ HOME: "/h", PATH: process.env.PATH });
    expect(tools.methods.sort()).toEqual(["prompts/get", "prompts/list", "tools/call", "tools/list"]);
  });
});
