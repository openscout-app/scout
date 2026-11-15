/**
 * One Scout MCP process for every local harness session.
 *
 * Each harness connects by URL (Streamable HTTP) instead of launching its
 * own `scout mcp` child. On a connection's first request the server finds
 * the local process on the other end of the socket, resolves the harness
 * session behind it (see peer-process.ts) and builds a Scout MCP server for
 * that connection with the environment and directory a stdio child would
 * have had. Later requests carry `Mcp-Session-Id` and reach the same server.
 *
 * Tool handlers mostly await the runtime, so one event loop serves many
 * sessions; the stats endpoint reports event-loop delay so a stall shows up
 * as a number instead of a guess.
 */
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createScoutMcpServer } from "./scout-mcp.ts";
import { findLoopbackPeerPid, isProcessAlive, resolvePeerIdentity, type PeerIdentity } from "./peer-process.ts";

/** Keys that name one session. The shared process's own values never leak into a connection. */
const SESSION_KEYS = /^(CLAUDE_|CODEX_|OPENSCOUT_AGENT$|OPENSCOUT_SESSION_ID$|OPENSCOUT_REPLY_CONTEXT|OPENSCOUT_MCP_ENABLE_NOTIFICATIONS$|TMUX|TERM_PROGRAM|GHOSTTY_|HERDR_|PWD$)/;

type Connection = {
  id: string;
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  identity: PeerIdentity;
  openedAt: number;
  lastRequestAt: number;
  requests: number;
  inFlight: number;
};

export type SharedMcpServerOptions = {
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** Cap on concurrent requests from one connection, so one session cannot crowd out the rest. */
  maxInFlightPerConnection?: number;
  /** How often to drop connections whose harness process has exited. */
  reapIntervalMs?: number;
  log?: (message: string) => void;
};

export type SharedMcpServerHandle = {
  url: string;
  port: number;
  connections: () => Connection[];
  stats: () => ReturnType<typeof statsOf>;
  stop: () => Promise<void>;
};

function createLagSampler(intervalMs = 50, keep = 1200) {
  const samples: number[] = [];
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    samples.push(Math.max(0, now - expected));
    if (samples.length > keep) samples.shift();
    expected = now + intervalMs;
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    summary: () => {
      const sorted = [...samples].sort((a, b) => a - b);
      const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
      return { p50: +at(0.5).toFixed(2), p99: +at(0.99).toFixed(2), max: +(sorted.at(-1) ?? 0).toFixed(2), samples: sorted.length };
    },
  };
}

function statsOf(connections: Map<string, Connection>, lag: ReturnType<typeof createLagSampler>) {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    connections: connections.size,
    rssMB: +(memory.rss / 1048576).toFixed(1),
    heapUsedMB: +(memory.heapUsed / 1048576).toFixed(1),
    eventLoopDelayMs: lag.summary(),
  };
}

function describe(connection: Connection, now = Date.now()) {
  return {
    id: connection.id,
    harness: connection.identity.harness,
    sessionId: connection.identity.sessionId,
    pid: connection.identity.pid,
    harnessPid: connection.identity.harnessPid,
    cwd: connection.identity.cwd,
    agent: connection.identity.env.OPENSCOUT_AGENT ?? null,
    idleSeconds: Math.round((now - connection.lastRequestAt) / 1000),
    requests: connection.requests,
    inFlight: connection.inFlight,
  };
}

export function sessionEnvironment(base: NodeJS.ProcessEnv, peer: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!SESSION_KEYS.test(key)) env[key] = value;
  return { ...env, ...peer };
}

export function startSharedScoutMcpServer(options: SharedMcpServerOptions = {}): SharedMcpServerHandle {
  const baseEnv = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.error(`[scout-mcp-shared] ${message}`));
  const maxInFlight = options.maxInFlightPerConnection ?? 32;
  const connections = new Map<string, Connection>();
  const lag = createLagSampler();

  const close = async (connection: Connection, reason: string) => {
    if (!connections.delete(connection.id)) return;
    log(`closed ${connection.id} (${connection.identity.harness} ${connection.identity.sessionId ?? "?"}): ${reason}; ${connections.size} open`);
    await connection.server.close().catch(() => {});
  };

  const open = async (request: Request, clientPort: number): Promise<Response> => {
    const peerPid = await findLoopbackPeerPid(clientPort);
    if (!peerPid) return new Response("could not find the local process for this connection", { status: 403 });
    const identity = await resolvePeerIdentity(peerPid);
    const env = sessionEnvironment(baseEnv, identity.env);
    const server = createScoutMcpServer({
      defaultCurrentDirectory: identity.cwd ?? env.HOME ?? "/",
      env,
    });
    let connection: Connection | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        connection = {
          id, transport, server, identity,
          openedAt: Date.now(), lastRequestAt: Date.now(), requests: 1, inFlight: 0,
        };
        connections.set(id, connection);
        log(`opened ${id} for ${identity.harness} ${identity.sessionId ?? "?"} (pid ${identity.harnessPid}, ${identity.cwd ?? "?"}); ${connections.size} open`);
      },
      onsessionclosed: (id) => {
        const existing = connections.get(id);
        if (existing) void close(existing, "client ended the session");
      },
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (!connection) await server.close().catch(() => {});
    return response;
  };

  const httpServer = Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/stats") return Response.json(statsOf(connections, lag));
      if (url.pathname === "/sessions") {
        const now = Date.now();
        return Response.json([...connections.values()].map((c) => describe(c, now)));
      }
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

      const sessionId = request.headers.get("mcp-session-id");
      if (!sessionId) {
        if (request.method !== "POST") return new Response("missing Mcp-Session-Id", { status: 400 });
        const address = srv.requestIP(request);
        if (!address) return new Response("no peer address", { status: 403 });
        return open(request, address.port);
      }
      const connection = connections.get(sessionId);
      // 404 tells a client to start a new session (Streamable HTTP spec).
      if (!connection) return new Response("unknown session", { status: 404 });
      if (connection.inFlight >= maxInFlight) {
        return new Response("too many requests in flight for this session", { status: 429 });
      }
      connection.inFlight += 1;
      connection.requests += 1;
      connection.lastRequestAt = Date.now();
      try {
        return await connection.transport.handleRequest(request);
      } finally {
        connection.inFlight -= 1;
      }
    },
  });

  const reaper = setInterval(() => {
    for (const connection of connections.values()) {
      if (!isProcessAlive(connection.identity.harnessPid)) {
        void close(connection, `harness pid ${connection.identity.harnessPid} exited`);
      }
    }
  }, options.reapIntervalMs ?? 15_000);
  reaper.unref?.();

  const port = httpServer.port ?? 0;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}/mcp`,
    port,
    connections: () => [...connections.values()],
    stats: () => statsOf(connections, lag),
    stop: async () => {
      clearInterval(reaper);
      lag.stop();
      await Promise.all([...connections.values()].map((c) => close(c, "server stopping")));
      httpServer.stop(true);
    },
  };
}

export async function runSharedScoutMcpServer(options: SharedMcpServerOptions): Promise<void> {
  const handle = startSharedScoutMcpServer(options);
  console.error(`[scout-mcp-shared] listening on ${handle.url}`);
  await new Promise<void>((resolve) => {
    const stop = () => { void handle.stop().then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
