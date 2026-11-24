import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createModernScoutHandler, eventBrokerClient, startMcpEventDeliveryWorker } from "./mcp-events.ts";
import { mcpEventPrincipalSchema } from "@openscout/runtime/client";
import type { McpEventPrincipal } from "@openscout/protocol";
import { SCOUT_MCP_CORE_TOOL_NAMES } from "@openscout/protocol";
import { resolveScoutBrokerUrl } from "../lib/core/broker/service.ts";

import { createScoutMcpServer } from "./scout-mcp.ts";
import { watchMailboxNotifications } from "./mailbox-notifications.ts";

export interface McpBridgeBoundEnvelope {
  v: 1;
  kind: "mcp_request" | "mcp_cancel";
  id: string;
  agent?: string;
  principal?: McpEventPrincipal;
  headers?: Record<string, string>;
  payload?: string;
}

export interface McpWorkerBoundEnvelope {
  v: 1;
  kind: "mcp_response" | "mcp_accepted" | "mcp_error" | "mcp_notify" | "bridge_ping";
  id: string;
  agent?: string;
  payload?: string;
  status?: number;
  message?: string;
}

export const SCOUT_MCP_CORE_TOOLS = SCOUT_MCP_CORE_TOOL_NAMES;

export function parseBridgeBoundEnvelope(data: unknown): McpBridgeBoundEnvelope | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Partial<McpBridgeBoundEnvelope>;
    if (parsed.v !== 1 || typeof parsed.id !== "string") return null;
    if (parsed.kind !== "mcp_request" && parsed.kind !== "mcp_cancel") return null;
    return {
      v: 1,
      kind: parsed.kind,
      id: parsed.id,
      agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
      payload: typeof parsed.payload === "string" ? parsed.payload : undefined,
      ...(parsed.principal && mcpEventPrincipalSchema.safeParse(parsed.principal).success ? { principal: parsed.principal } : {}),
      ...(parsed.headers && typeof parsed.headers === "object" ? { headers: Object.fromEntries(Object.entries(parsed.headers).filter(([key, value]) =>
        typeof value === "string" && (key.startsWith("mcp-") || key === "accept"))) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Server-side MCP Transport fed by relay envelopes instead of a socket the
 * SDK owns. Each inbound JSON-RPC request is tagged with its relay envelope
 * id so the eventual response can be routed back to the exact HTTP request
 * waiting at the Worker.
 */
export class MeshRelayServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private emitEnvelope: (envelope: McpWorkerBoundEnvelope) => void = () => {};
  private readonly envelopeIdByRequestId = new Map<string | number, string>();

  bindEmitter(emit: (envelope: McpWorkerBoundEnvelope) => void): void {
    this.emitEnvelope = emit;
  }

  async start(): Promise<void> {}

  deliver(envelope: McpBridgeBoundEnvelope): void {
    if (envelope.kind === "mcp_cancel") {
      for (const [requestId, envelopeId] of this.envelopeIdByRequestId) {
        if (envelopeId === envelope.id) {
          this.envelopeIdByRequestId.delete(requestId);
        }
      }
      return;
    }

    if (!envelope.payload) {
      this.emitEnvelope({ v: 1, kind: "mcp_error", id: envelope.id, status: 400, message: "empty payload" });
      return;
    }

    let message: JSONRPCMessage;
    try {
      message = JSON.parse(envelope.payload) as JSONRPCMessage;
    } catch {
      this.emitEnvelope({ v: 1, kind: "mcp_error", id: envelope.id, status: 400, message: "invalid JSON-RPC payload" });
      return;
    }

    const record = message as { id?: string | number; method?: string };
    const isRequest = record.method !== undefined && record.id !== undefined;
    if (isRequest && record.id !== undefined) {
      this.envelopeIdByRequestId.set(record.id, envelope.id);
    } else {
      this.emitEnvelope({ v: 1, kind: "mcp_accepted", id: envelope.id });
    }

    try {
      this.onmessage?.(message);
    } catch (error) {
      if (isRequest && record.id !== undefined) {
        this.envelopeIdByRequestId.delete(record.id);
      }
      this.emitEnvelope({
        v: 1,
        kind: "mcp_error",
        id: envelope.id,
        status: 500,
        message: error instanceof Error ? error.message : "handler failure",
      });
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const record = message as { id?: string | number; method?: string };
    if (record.id === undefined) {
      // Server-initiated notification: route to the relay's push stream so
      // a GET SSE listener (2025-era transport) receives it.
      this.emitEnvelope({
        v: 1,
        kind: "mcp_notify",
        id: crypto.randomUUID(),
        payload: JSON.stringify(message),
      });
      return;
    }
    const envelopeId = this.envelopeIdByRequestId.get(record.id);
    if (!envelopeId) {
      if (record.method !== undefined) {
        // Server-initiated request (sampling/elicitation): unsupported here.
        this.onerror?.(new Error(`mesh bridge cannot deliver server-initiated request ${String(record.method)}`));
      }
      return;
    }
    this.envelopeIdByRequestId.delete(record.id);
    this.emitEnvelope({
      v: 1,
      kind: "mcp_response",
      id: envelopeId,
      payload: JSON.stringify(message),
    });
  }

  async close(): Promise<void> {
    this.envelopeIdByRequestId.clear();
    this.onclose?.();
  }
}

export interface ScoutMeshMcpBridgeOptions {
  relayUrl: string;
  token: string;
  /** Fallback identity for envelopes that carry no agent (dev/back-compat). */
  senderId: string;
  currentDirectory: string;
  toolNames: string[];
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface ScoutMeshMcpBridgeHandle {
  close(): Promise<void>;
}

export interface ScoutMeshBridgeConfigFile {
  relayUrl: string;
  token?: string;
  tokenKeychainService?: string;
  /** Mode-0600 token file. Used off darwin, where the macOS keychain is unavailable. */
  tokenFile?: string;
  sender?: string;
  node?: string;
  tools?: string[] | "core";
  dir?: string;
}

export const MESH_BRIDGE_TOKEN_FILENAME = "mcp-bridge.token";

export function meshBridgeTokenFilePath(supportDirectory: string): string {
  return join(supportDirectory, MESH_BRIDGE_TOKEN_FILENAME);
}

type KeychainSpawn = (command: string[]) => {
  exitCode: number | null;
  stdout: { toString(): string };
};

/**
 * Read a mesh-bridge token only from a regular mode-0600 file owned by this
 * user. Open with O_NOFOLLOW and read that descriptor so a symlink cannot be
 * swapped in between the check and the read.
 */
export function readMode0600TokenFile(path: string): string | null {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stats = fstatSync(fd);
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) return null;
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) return null;
    const value = readFileSync(fd, "utf8").trim();
    return value || null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // closeSync throws if the descriptor was already released.
      }
    }
  }
}

export function readKeychainSecret(
  service: string,
  spawn: KeychainSpawn = (command) => Bun.spawnSync(command),
): string | null {
  if (process.platform !== "darwin") return null;
  const result = spawn(["security", "find-generic-password", "-s", service, "-w"]);
  if (result.exitCode !== 0) return null;
  const value = result.stdout.toString().trim();
  return value || null;
}

export function resolveBridgeTokenFromConfig(
  config: ScoutMeshBridgeConfigFile,
  options: { supportDirectory?: string } = {},
): string | null {
  if (config.token?.trim()) return config.token.trim();
  if (process.platform === "darwin") {
    if (config.tokenKeychainService?.trim()) {
      return readKeychainSecret(config.tokenKeychainService.trim());
    }
    return null;
  }
  const tokenPath = config.tokenFile?.trim()
    || (options.supportDirectory ? meshBridgeTokenFilePath(options.supportDirectory) : "");
  if (!tokenPath) return null;
  return readMode0600TokenFile(tokenPath);
}

const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_IDENTITY_INSTANCES = 16;
// The relay's Durable Object can lose the socket without a close frame
// reaching either side (idle eviction, NAT drop). Pings keep the tunnel
// non-idle; a silent relay past the stale window forces a reconnect.
const BRIDGE_PING_INTERVAL_MS = 20_000;
const BRIDGE_STALE_MS = 60_000;

/** The token rides in the Authorization header only: URLs end up in proxy and access logs. */
export function resolveBridgeWebSocketUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (!url.pathname.endsWith("/bridge")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/bridge`;
  }
  url.searchParams.delete("access_token");
  return url.toString();
}

export async function startScoutMeshMcpBridge(
  options: ScoutMeshMcpBridgeOptions,
): Promise<ScoutMeshMcpBridgeHandle> {
  const log = options.log ?? (() => {});
  const allowedTools = new Set(options.toolNames);

  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const sendRaw = (envelope: McpWorkerBoundEnvelope) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(envelope));
    } else {
      log(`bridge: dropped ${envelope.kind} for ${envelope.id} (socket not open)`);
    }
  };

  // One MCP server instance per remote agent identity: the identity from
  // the envelope is pinned as the Scout sender for every call that
  // instance serves, and its notifications route back to that identity's
  // push stream.
  const instances = new Map<string, { server: { close(): Promise<void> }; transport: MeshRelayServerTransport }>();
  const getOrCreateInstance = async (agent: string) => {
    const existing = instances.get(agent);
    if (existing) return existing;
    if (instances.size >= MAX_IDENTITY_INSTANCES) {
      return null;
    }
    const transport = new MeshRelayServerTransport();
    transport.bindEmitter((envelope) => {
      sendRaw(envelope.kind === "mcp_notify" ? { ...envelope, agent } : envelope);
    });
    const server = createScoutMcpServer({
      defaultCurrentDirectory: options.currentDirectory,
      env: {
        ...(options.env ?? process.env),
        OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1",
      },
      dependencies: {
        resolveSenderId: async () => agent,
      },
      toolFilter: (name) => allowedTools.has(name),
    });
    await server.connect(transport);
    const instance = { server, transport };
    instances.set(agent, instance);
    log(`bridge: serving identity ${agent} (${instances.size} active)`);
    return instance;
  };

  const eventsEnabled = (options.env ?? process.env).OPENSCOUT_MCP_EVENTS === "1";
  const broker = eventBrokerClient(options.env?.OPENSCOUT_BROKER_URL?.trim() || resolveScoutBrokerUrl());
  const modernInstances = new Map<string, Promise<Awaited<ReturnType<typeof createModernScoutHandler>>>>();
  const modernRequests = new Map<string, AbortController>();
  const deliveryWorker = eventsEnabled ? startMcpEventDeliveryWorker({ relayUrl: options.relayUrl, token: options.token, broker, log }) : undefined;
  const deliverModern = async (envelope: McpBridgeBoundEnvelope, agent: string) => {
    if (!eventsEnabled || !envelope.principal || envelope.principal.agentId !== agent) {
      sendRaw({ v: 1, kind: "mcp_error", id: envelope.id, status: eventsEnabled ? 403 : 503, message: "MCP Events unavailable for this connection" });
      return;
    }
    const principal = envelope.principal;
    const key = JSON.stringify([principal.kind, principal.id, principal.userId, principal.ownerKey, principal.node, principal.agentId]);
    let instance = modernInstances.get(key);
    if (!instance) {
      if (modernInstances.size >= MAX_IDENTITY_INSTANCES) {
        sendRaw({ v: 1, kind: "mcp_error", id: envelope.id, status: 503, message: "bridge identity capacity reached" });
        return;
      }
      instance = createModernScoutHandler(principal, createScoutMcpServer({
        defaultCurrentDirectory: options.currentDirectory,
        env: { ...(options.env ?? process.env), OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "0" },
        dependencies: { resolveSenderId: async () => agent },
        toolFilter: (name) => allowedTools.has(name),
      }), broker);
      modernInstances.set(key, instance);
      instance.catch(() => modernInstances.delete(key));
    }
    const abort = new AbortController();
    modernRequests.set(envelope.id, abort);
    try {
      const handler = await instance;
      const response = await handler.fetch(new Request("https://scout-bridge.invalid/mcp", {
        method: "POST", headers: { ...envelope.headers, "content-type": "application/json" },
        body: envelope.payload ?? "", signal: abort.signal,
      }));
      if (!abort.signal.aborted) sendRaw({ v: 1, kind: response.status === 202 ? "mcp_accepted" : "mcp_response", id: envelope.id,
        payload: await response.text(), status: response.status });
    } finally { modernRequests.delete(envelope.id); }
  };

  const wsUrl = resolveBridgeWebSocketUrl(options.relayUrl);

  const scheduleReconnect = () => {
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * 2 ** attempt)
      + Math.floor(Math.random() * 500);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
    return delay;
  };

  const connect = () => {
    if (closed) return;
    const ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${options.token}` },
    } as unknown as string[]);
    socket = ws;
    let lastFrameAt = Date.now();
    let openedAt = Date.now();
    let abandoned = false;
    let pingCount = 0;

    const forceReconnect = (reason: string) => {
      if (closed || abandoned) return;
      abandoned = true;
      clearInterval(heartbeat);
      if (socket === ws) socket = null;
      try {
        ws.close(4002, "bridge reconnect");
      } catch {
        // Half-open sockets may refuse a close handshake; reconnect regardless.
      }
      const delay = scheduleReconnect();
      log(`bridge: ${reason}; reconnecting in ${Math.round(delay / 1000)}s`);
    };

    const heartbeat = setInterval(() => {
      if (closed || abandoned || socket !== ws) {
        clearInterval(heartbeat);
        return;
      }
      if (Date.now() - lastFrameAt > BRIDGE_STALE_MS) {
        forceReconnect(`relay silent for ${Math.round(BRIDGE_STALE_MS / 1000)}s`);
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      // Byte-for-byte constant so the relay's WebSocket auto-response can
      // answer without waking the hibernated Durable Object (mcp-relay.ts
      // mirrors this literal).
      ws.send("{\"v\":1,\"kind\":\"bridge_ping\",\"id\":\"hb\"}");
      pingCount += 1;
      // Pongs only prove SOME relay instance holds this socket — during a
      // Worker deploy the old Durable Object can linger and keep answering
      // while new requests route to a fresh instance with no bridge. Ask the
      // routable instance over HTTPS whether it actually sees a bridge.
      if (pingCount % 3 === 0 && Date.now() - openedAt > 45_000) {
        void fetch(`${new URL(options.relayUrl).origin}/healthz`, {
          headers: { authorization: `Bearer ${options.token}` },
        }).then(async (res) => {
          if (!res.ok || closed || abandoned || socket !== ws) return;
          const health = await res.json() as { bridgeConnected?: boolean };
          if (health.bridgeConnected === false) {
            forceReconnect("relay no longer routes to this bridge socket");
          }
        }).catch(() => {
          // Transient healthz failures are not evidence of a dead socket.
        });
      }
    }, BRIDGE_PING_INTERVAL_MS);

    ws.addEventListener("open", () => {
      attempt = 0;
      lastFrameAt = Date.now();
      openedAt = Date.now();
      log(`bridge: connected to relay (tools: ${options.toolNames.join(", ")}; fallback identity ${options.senderId})`);
    });
    ws.addEventListener("message", (event) => {
      lastFrameAt = Date.now();
      const envelope = parseBridgeBoundEnvelope(
        typeof event.data === "string" ? event.data : "",
      );
      if (!envelope) return;
      const agent = envelope.agent?.trim() || options.senderId;
      if (envelope.kind === "mcp_cancel" && modernRequests.has(envelope.id)) {
        modernRequests.get(envelope.id)!.abort(); return;
      }
      const protocol = envelope.headers?.["mcp-protocol-version"];
      if (envelope.kind === "mcp_request" && shouldUseModernMcpRoute(protocol, eventsEnabled)) {
        void deliverModern(envelope, agent).catch(() => sendRaw({ v: 1, kind: "mcp_error", id: envelope.id, status: 503, message: "MCP event gateway unavailable" }));
        return;
      }
      void getOrCreateInstance(agent).then((instance) => {
        if (!instance) {
          if (envelope.kind === "mcp_request") {
            sendRaw({
              v: 1,
              kind: "mcp_error",
              id: envelope.id,
              status: 503,
              message: "bridge identity capacity reached",
            });
          }
          return;
        }
        instance.transport.deliver(envelope);
      }).catch((error) => {
        if (envelope.kind === "mcp_request") {
          sendRaw({
            v: 1,
            kind: "mcp_error",
            id: envelope.id,
            status: 500,
            message: error instanceof Error ? error.message : "instance failure",
          });
        }
      });
    });
    ws.addEventListener("close", (event) => {
      clearInterval(heartbeat);
      if (abandoned || socket !== ws) return;
      socket = null;
      if (closed) return;
      const delay = scheduleReconnect();
      log(`bridge: relay connection closed (${event.code}); reconnecting in ${Math.round(delay / 1000)}s`);
    });
    ws.addEventListener("error", () => {
      // The paired close event drives reconnection.
    });
  };

  connect();

  const mailboxAbort = new AbortController();
  let mailboxReconnect: ReturnType<typeof setTimeout> | null = null;
  let mailboxAttempt = 0;
  const watchMailbox = () => {
    if (closed) return;
    void watchMailboxNotifications({
      brokerUrl: options.env?.OPENSCOUT_BROKER_URL?.trim() || resolveScoutBrokerUrl(),
      signal: mailboxAbort.signal,
      // Route every hint to the relay, which delivers only to that owner's open stream.
      // Gating on this process's instances would drop hints after a bridge restart,
      // while the owner's GET stream is still connected but has not POSTed again.
      onNotification: ({ agent, payload }) => {
        mailboxAttempt = 0;
        sendRaw({ v: 1, kind: "mcp_notify", id: crypto.randomUUID(), agent, payload });
      },
    }).catch((error) => {
      if (!closed) log(`bridge: mailbox event stream unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    }).finally(() => {
      if (!closed) {
        const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * 2 ** Math.min(mailboxAttempt++, 5));
        mailboxReconnect = setTimeout(watchMailbox, delay);
      }
    });
  };
  watchMailbox();

  return {
    close: async () => {
      closed = true;
      mailboxAbort.abort();
      if (mailboxReconnect) clearTimeout(mailboxReconnect);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close(1000, "bridge shutting down");
      socket = null;
      for (const [, instance] of instances) {
        await instance.server.close().catch(() => {});
      }
      instances.clear();
      for (const abort of modernRequests.values()) abort.abort();
      await deliveryWorker?.close();
      for (const instance of modernInstances.values()) await instance.then((handler) => handler.close()).catch(() => {});
      modernInstances.clear();
    },
  };
}

/** Keep newer clients on the legacy transport until MCP Events is enabled. */
export function shouldUseModernMcpRoute(protocol: string | undefined, eventsEnabled: boolean): boolean {
  return eventsEnabled && Boolean(protocol && !/^202[45]-/.test(protocol));
}
