import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSharedScoutTools } from "./shared-tools.ts";
import { parseLsofPeer, parseProcArgs2, readProcessEnvironment, resolvePeerIdentity } from "./peer-process.ts";
import { sessionEnvironment, startSharedScoutMcpServer, type SharedMcpServerHandle } from "./shared-http.ts";

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
});
