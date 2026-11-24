/**
 * One Scout MCP process for every local harness session.
 *
 * Each harness connects by URL (Streamable HTTP) instead of launching its
 * own `scout mcp` child. On a connection's first request the server finds
 * the local process on the other end of the socket, resolves the harness
 * session behind it (see peer-process.ts) and opens a protocol endpoint for
 * that connection. Every endpoint runs one shared set of tool definitions
 * (see shared-tools.ts) with the environment and directory a stdio child
 * would have had. Later requests carry `Mcp-Session-Id` and reach the same
 * endpoint, from the same process. One shared server serves one runtime.
 *
 * Codex runs many threads in one app-server process and opens one MCP
 * session per thread. Its process says nothing about the thread, so a Codex
 * connection takes its thread from the first `tools/call` that names one
 * (see codex-threads.ts) and refuses a call that names another.
 *
 * Tool handlers mostly await the runtime, so one event loop serves many
 * sessions; the stats endpoint reports event-loop delay so a stall shows up
 * as a number instead of a guess.
 */
import { randomUUID } from "node:crypto";
import { homedir, hostname, networkInterfaces } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { resolveScoutBrokerUrl } from "../lib/core/broker/service.ts";
import { codexThreadIdFromMeta, codexTurnIdFromMeta, findCodexRollout, readCodexRolloutCwd } from "./codex-threads.ts";
import { findLoopbackPeerPid, isProcessAlive, resolvePeerIdentity, type PeerIdentity } from "./peer-process.ts";
import { resolveLocalMcpProfile, type LocalMcpProfile } from "./local-tool-profile.ts";
import { createSharedScoutTools, type ScoutSessionContext, type SharedToolRequest } from "./shared-tools.ts";

/** Keys that name one session. The shared process's own values never leak into a connection. */
const SESSION_KEYS = /^(CLAUDE_|CODEX_|OPENSCOUT_AGENT$|OPENSCOUT_SESSION_ID$|OPENSCOUT_REPLY_CONTEXT|OPENSCOUT_MCP_ENABLE_NOTIFICATIONS$|TMUX|TERM_PROGRAM|GHOSTTY_|HERDR_|REX_|PWD$)/;

/**
 * Keys that choose the runtime. A shared server serves one runtime: its own
 * values win in every session, so tools that read them at call time agree
 * with the ones that read them when the shared tools were built.
 */
const RUNTIME_KEYS = /^(OPENSCOUT_BROKER_|OPENSCOUT_WEB_|SCOUT_WEB_|OPENSCOUT_INSTANCE|OPENSCOUT_CLIENT_INSTANCE$|OPENSCOUT_EXPOSE_)/;

type CodexThread = {
  /** Claimed by the first call that names a thread, before anything awaits; never changes. */
  id: string;
  rollout: string | null;
  /** The folder of the last turn resolved, for /sessions. */
  cwd: string | null;
  /** The current turn's context. A promise, so concurrent calls in a turn share one lookup. */
  turn: { id: string | null; context: Promise<ScoutSessionContext> } | null;
};

type Connection = {
  id: string;
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  lifetime: AbortController;
  identity: PeerIdentity;
  /** The session as the process describes it: environment, folder, notification target. */
  context: ScoutSessionContext;
  /** A Codex connection's thread, set by its first call that names one. */
  thread: CodexThread | null;
  openedAt: number;
  lastRequestAt: number;
  requests: number;
  inFlight: number;
};

export type SharedMcpServerOptions = {
  profile?: LocalMcpProfile;
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** Cap on concurrent requests from one connection, so one session cannot crowd out the rest. */
  maxInFlightPerConnection?: number;
  /** How often to drop connections whose harness process has exited or that sat idle too long. */
  reapIntervalMs?: number;
  /**
   * Drop a Codex connection with nothing in flight after this long without
   * a request. Codex gets 404 on its next request and opens a new session.
   * 0 keeps idle connections.
   */
  idleTimeoutMs?: number;
  /** Send notifications/scout/reply on every connection (stdio's `--notifications`). */
  notifications?: boolean;
  log?: (message: string) => void;
  /** Resolves the session behind a peer process. Tests stand in a harness here. */
  resolveIdentity?: (pid: number) => Promise<PeerIdentity>;
};

export type SharedMcpServerHandle = {
  url: string;
  port: number;
  connections: () => Connection[];
  stats: () => ReturnType<typeof statsOf> & { profile: string };
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

/**
 * Every process this server has served that is still alive, connected or
 * not. A Codex app-server whose idle session was dropped reconnects to the
 * same URL on its next call, so scout-base keeps a draining server up until
 * this reaches zero.
 */
function liveClients(clientPids: Set<number>): number[] {
  for (const pid of clientPids) {
    if (!isProcessAlive(pid)) clientPids.delete(pid);
  }
  return [...clientPids].sort((a, b) => a - b);
}

function statsOf(connections: Map<string, Connection>, lag: ReturnType<typeof createLagSampler>, clientPids: Set<number>) {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    connections: connections.size,
    clientPids: liveClients(clientPids),
    rssMB: +(memory.rss / 1048576).toFixed(1),
    heapUsedMB: +(memory.heapUsed / 1048576).toFixed(1),
    eventLoopDelayMs: lag.summary(),
  };
}

/** What /sessions shows. Never the MCP session id: it authorizes requests. */
function describe(connection: Connection, now = Date.now()) {
  return {
    harness: connection.identity.harness,
    sessionId: connection.thread?.id ?? connection.identity.sessionId,
    pid: connection.identity.pid,
    harnessPid: connection.identity.harnessPid,
    cwd: connection.thread?.cwd ?? connection.identity.cwd,
    agent: connection.identity.env.OPENSCOUT_AGENT ?? null,
    idleSeconds: Math.round((now - connection.lastRequestAt) / 1000),
    requests: connection.requests,
    inFlight: connection.inFlight,
  };
}

export function sessionEnvironment(base: NodeJS.ProcessEnv, peer: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!SESSION_KEYS.test(key)) env[key] = value;
  for (const [key, value] of Object.entries(peer)) if (!RUNTIME_KEYS.test(key)) env[key] = value;
  return env;
}

/** Names and addresses of this machine. */
export function localHostNames(): Set<string> {
  const names = new Set(["localhost", "127.0.0.1", "::1"]);
  const host = hostname().toLowerCase();
  names.add(host);
  names.add(host.endsWith(".local") ? host.slice(0, -".local".length) : `${host}.local`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) names.add(address.address.toLowerCase());
  }
  return names;
}

/**
 * A runtime is a listener, so a URL is reduced to host and port, and any
 * address of this machine is the same host. The runtime advertises itself on
 * the LAN (https://192.168.x.y:43110) to the agents it starts, and listens
 * for this server on 127.0.0.1: both are the same runtime.
 */
function normalizeRuntimeUrl(value: string, localHosts: Set<string>): string {
  try {
    const url = new URL(value.trim());
    const name = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${localHosts.has(name) ? "127.0.0.1" : name}:${port}`;
  } catch {
    return value.trim();
  }
}

function instanceName(value: string | undefined): string {
  const name = value?.trim().toLowerCase();
  return !name || name === "default" || name === "production" ? "prod" : name;
}

/**
 * Why a session cannot use this server, or null. A session that names
 * another runtime (or another Scout instance) would act on the wrong one
 * here, so it is refused instead of quietly served.
 */
export function runtimeMismatch(
  server: NodeJS.ProcessEnv,
  peer: Record<string, string>,
  serverUrl: string,
  localHosts: Set<string> = localHostNames(),
): string | null {
  const peerUrl = peer.OPENSCOUT_BROKER_URL?.trim();
  if (peerUrl) {
    return normalizeRuntimeUrl(peerUrl, localHosts) === normalizeRuntimeUrl(serverUrl, localHosts)
      ? null
      : `this session uses the runtime at ${peerUrl}; this server serves ${serverUrl}`;
  }
  if (peer.OPENSCOUT_INSTANCE !== undefined && instanceName(peer.OPENSCOUT_INSTANCE) !== instanceName(server.OPENSCOUT_INSTANCE)) {
    return `this session uses Scout instance ${instanceName(peer.OPENSCOUT_INSTANCE)}; this server serves ${instanceName(server.OPENSCOUT_INSTANCE)}`;
  }
  return null;
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** DNS rebinding and cross-site requests: only loopback names, and no foreign browser origin. */
function refuseForeignRequest(request: Request): Response | null {
  if (!LOOPBACK_HOST.test(request.headers.get("host") ?? "")) return new Response("host not allowed", { status: 403 });
  const origin = request.headers.get("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { /* not a URL */ }
    if (!LOOPBACK_HOST.test(host)) return new Response("origin not allowed", { status: 403 });
  }
  return null;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

async function isInitializeRequest(request: Request): Promise<boolean> {
  try {
    const body = await request.clone().json();
    return (Array.isArray(body) ? body : [body]).some((message) => message?.method === "initialize");
  } catch {
    return false;
  }
}

export function startSharedScoutMcpServer(options: SharedMcpServerOptions = {}): SharedMcpServerHandle {
  const baseEnv = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.error(`[scout-mcp-shared] ${message}`));
  const maxInFlight = options.maxInFlightPerConnection ?? 32;
  const idleTimeoutMs = options.idleTimeoutMs ?? 2 * 60 * 60 * 1000;
  const serverRuntimeUrl = baseEnv.OPENSCOUT_BROKER_URL?.trim() || resolveScoutBrokerUrl();
  const connections = new Map<string, Connection>();
  const clientPids = new Set<number>();
  // Under scout-base, every process served is registered on disk before its
  // session is answered, so a drain outlives a crash of this server.
  const clientsDirectory = baseEnv.OPENSCOUT_MCP_SHARED_CLIENTS_DIR?.trim() || null;
  const registerClient = (pid: number) => {
    if (!clientsDirectory) return;
    try {
      mkdirSync(clientsDirectory, { recursive: true });
      writeFileSync(join(clientsDirectory, String(pid)), "");
    } catch (error) {
      log(`could not register client pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const profile = options.profile ?? resolveLocalMcpProfile(baseEnv.OPENSCOUT_MCP_PROFILE);
  const lag = createLagSampler();
  // Built once: every connection runs these tool definitions and handlers.
  const tools = createSharedScoutTools(baseEnv, profile);
  const stats = () => ({ ...statsOf(connections, lag, clientPids), profile: profile.name });

  const close = async (connection: Connection, reason: string) => {
    if (!connections.delete(connection.id)) return;
    log(`closed ${connection.identity.harness} ${connection.thread?.id ?? connection.identity.sessionId ?? "?"}: ${reason}; ${connections.size} open`);
    connection.lifetime.abort();
    await connection.server.close().catch(() => {});
  };

  /**
   * A Codex call runs as its thread: CODEX_THREAD_ID and the folder of the
   * thread's current turn. The thread is claimed before anything awaits, so
   * two first calls that name different threads can't both bind.
   */
  const threadContext = (connection: Connection, threadId: string, turnId: string | null): Promise<ScoutSessionContext> => {
    const thread = connection.thread ??= { id: threadId, rollout: null, cwd: null, turn: null };
    if (thread.id !== threadId) {
      throw new McpError(ErrorCode.InvalidRequest, `This MCP session belongs to Codex thread ${thread.id}, not ${threadId}. Open a new MCP session for that thread.`);
    }
    if (thread.turn && (turnId === null || thread.turn.id === turnId)) return thread.turn.context;

    const codexHome = connection.identity.env.CODEX_HOME || join(connection.identity.env.HOME || homedir(), ".codex");
    const resolve = async (): Promise<ScoutSessionContext> => {
      thread.rollout ??= await findCodexRollout(threadId, codexHome);
      if (!thread.rollout) {
        throw new McpError(ErrorCode.InvalidRequest, `Scout MCP found no rollout for Codex thread ${threadId} under ${join(codexHome, "sessions")}, so it can't tell which folder this call works in. Ephemeral threads need the stdio server (scout mcp).`);
      }
      // Codex writes a turn's turn_context before it samples the model; allow
      // a moment in case the call outruns the rollout writer.
      let cwd: string | null = null;
      for (let attempt = 0; attempt < 4 && !cwd; attempt += 1) {
        if (attempt) await Bun.sleep(100 * attempt);
        cwd = await readCodexRolloutCwd(thread.rollout, turnId);
      }
      if (!cwd) {
        throw new McpError(ErrorCode.InvalidRequest, `The rollout of Codex thread ${threadId} (${thread.rollout}) has no folder for turn ${turnId ?? "?"}, so Scout MCP can't tell where this call works.`);
      }
      if (thread.cwd === null) log(`bound ${connection.identity.harness} pid ${connection.identity.pid} to thread ${threadId} (${cwd})`);
      thread.cwd = cwd;
      return {
        env: { ...connection.context.env, CODEX_THREAD_ID: threadId },
        currentDirectory: cwd,
        scope: connection.context.scope,
      };
    };
    const turn = { id: turnId, context: resolve() };
    thread.turn = turn;
    // A failed lookup is not cached: the next call looks again.
    turn.context.catch(() => { if (thread.turn === turn) thread.turn = null; });
    return turn.context;
  };

  const open = async (request: Request, clientPort: number): Promise<Response> => {
    // Clients may probe first (Claude sends server/discover). Only an
    // initialize opens a session; answer anything else as the SDK would,
    // without the cost of resolving the peer.
    if (!(await isInitializeRequest(request))) return jsonRpcError(400, -32000, "Bad Request: Server not initialized");
    const peerPid = await findLoopbackPeerPid(clientPort);
    if (!peerPid) return new Response("could not find the local process for this connection", { status: 403 });
    const identity = await (options.resolveIdentity ?? resolvePeerIdentity)(peerPid);
    const mismatch = runtimeMismatch(baseEnv, identity.env, serverRuntimeUrl);
    if (mismatch) {
      log(`refused pid ${identity.pid}: ${mismatch}`);
      return new Response(`Scout MCP: ${mismatch}. Use that runtime's own MCP server.`, { status: 409 });
    }
    const env = sessionEnvironment(baseEnv, identity.env);
    if (options.notifications) env.OPENSCOUT_MCP_ENABLE_NOTIFICATIONS = "1";
    const lifetime = new AbortController();
    let server: Server | undefined;
    let connection: Connection | undefined;
    const context: ScoutSessionContext = {
      env,
      currentDirectory: identity.cwd ?? env.HOME ?? "/",
      scope: {
        lifetime: lifetime.signal,
        flights: new Set(),
        notify: (params) => server!.notification({ method: "notifications/scout/reply", params }),
      },
    };
    server = tools.connect(async (call: SharedToolRequest) => {
      // Catalog traffic (tools/list, prompts) is the same for every thread.
      if (!connection || identity.harness !== "codex" || call.method !== "tools/call") return context;
      const threadId = codexThreadIdFromMeta(call.params?._meta);
      if (!threadId) {
        // Guessing would credit the call to whichever thread came first.
        throw new McpError(ErrorCode.InvalidRequest, "Codex sent this tool call without _meta.threadId, so Scout MCP can't tell which thread made it. The shared server needs a Codex that names the thread on each call (codex-cli 0.169 does); otherwise use the stdio server (scout mcp).");
      }
      return threadContext(connection, threadId, codexTurnIdFromMeta(call.params?._meta));
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        const now = Date.now();
        connection = {
          id, transport, server: server!, lifetime, identity, context, thread: null,
          openedAt: now, lastRequestAt: now, requests: 1, inFlight: 0,
        };
        connections.set(id, connection);
        clientPids.add(identity.pid);
        registerClient(identity.pid);
        log(`opened ${identity.harness} ${identity.sessionId ?? "?"} (pid ${identity.harnessPid}, ${identity.cwd ?? "?"}); ${connections.size} open`);
      },
      onsessionclosed: (id) => {
        const existing = connections.get(id);
        if (existing) void close(existing, "client ended the session");
      },
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (!connection) {
      lifetime.abort();
      await server.close().catch(() => {});
    }
    return response;
  };

  /**
   * A session id authorizes requests only from the process that opened it.
   * Checked on every request: a port says nothing once its socket closes,
   * and Bun.serve doesn't tell us when that happens.
   */
  const fromSameProcess = async (connection: Connection, clientPort: number): Promise<boolean> => {
    // No process at all usually means the client already closed the socket;
    // look once more before refusing in case lsof caught it mid-change.
    const peer = (await findLoopbackPeerPid(clientPort)) ?? (await Bun.sleep(25), await findLoopbackPeerPid(clientPort));
    if (peer !== connection.identity.pid) {
      log(`client port ${clientPort} belongs to pid ${peer ?? "none"}, not ${connection.identity.pid}`);
      return false;
    }
    return true;
  };

  const httpServer = Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 0,
    async fetch(request, srv) {
      const refused = refuseForeignRequest(request);
      if (refused) return refused;
      const url = new URL(request.url);
      if (url.pathname === "/stats") return Response.json(stats());
      if (url.pathname === "/sessions") {
        const now = Date.now();
        return Response.json([...connections.values()].map((c) => describe(c, now)));
      }
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

      const address = srv.requestIP(request);
      if (!address) return new Response("no peer address", { status: 403 });
      const sessionId = request.headers.get("mcp-session-id");
      if (!sessionId) {
        if (request.method !== "POST") return new Response("missing Mcp-Session-Id", { status: 400 });
        return open(request, address.port);
      }
      const connection = connections.get(sessionId);
      // 404 tells a client to start a new session (Streamable HTTP spec).
      if (!connection) return new Response("unknown session", { status: 404 });
      if (!(await fromSameProcess(connection, address.port))) {
        log(`refused a request for ${connection.identity.harness} pid ${connection.identity.pid} from another process`);
        return new Response("this session belongs to another process", { status: 403 });
      }
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
        connection.lastRequestAt = Date.now();
      }
    },
  });

  const reap = () => {
    const now = Date.now();
    for (const connection of connections.values()) {
      if (!isProcessAlive(connection.identity.harnessPid)) {
        void close(connection, `harness pid ${connection.identity.harnessPid} exited`);
      } else if (idleTimeoutMs > 0 && connection.identity.harness === "codex" && connection.inFlight === 0
        && connection.context.scope.flights.size === 0 && now - connection.lastRequestAt > idleTimeoutMs) {
        // A long-lived Codex app-server keeps a session open for every thread
        // it ever ran; the process staying alive says nothing about them.
        // Codex reopens a dropped session on its next call. Other harnesses
        // run one session per process, which the exit check above covers;
        // Claude reconnects too, but tells the model the server disconnected.
        void close(connection, `idle ${Math.round((now - connection.lastRequestAt) / 1000)}s`);
      }
    }
  };
  const reaper = setInterval(reap, options.reapIntervalMs ?? 15_000);
  reaper.unref?.();

  const port = httpServer.port ?? 0;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}/mcp`,
    port,
    connections: () => [...connections.values()],
    stats,
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
  // Under scout-base: stop with it, or the port stays held and every
  // restart of the service fails.
  const parentPid = Number((options.env ?? process.env).OPENSCOUT_PARENT_PID);
  await new Promise<void>((resolve) => {
    let parentWatch: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (parentWatch) clearInterval(parentWatch);
      void handle.stop().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (Number.isInteger(parentPid) && parentPid > 1) {
      parentWatch = setInterval(() => {
        if (isProcessAlive(parentPid)) return;
        console.error(`[scout-mcp-shared] parent ${parentPid} exited; stopping`);
        stop();
      }, 5_000);
    }
  });
}
