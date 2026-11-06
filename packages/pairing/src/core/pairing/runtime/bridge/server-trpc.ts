import { createCredentialBinding } from "./credential-binding.ts";
import { timingSafeEqual } from "node:crypto";
import { localConfigHome, resolveWebAuthToken } from "@openscout/runtime/local-config";
import { mountPairingRoutes } from "../../../../routes/pairing.ts";
import { createPendingPairRequestStore, pairRequestStatePath, type PendingPairRequestStore } from "../../../../pairing-pair-requests.ts";
import { isSameMacScoutRequest } from "../../../../pairing-request-trust.ts";
import type { PairingOpportunityControlAction, PairingRequestBinding } from "@openscout/runtime/pairing-local-socket";
import { watchSharedScoutMessages } from "./broker-message-fanout.ts";
// Bridge server — Hono + tRPC edition.
//
// Drop-in replacement for server.ts.  Exports `startBridgeServerTRPC` with the
// same signature as `startBridgeServer` so runtime.ts can swap between them.
//
// Architecture:
//   - Hono handles health and host pairing HTTP ingress only
//   - Bridge tRPC queries, mutations, and subscriptions remain Noise-only
//   - WebSocket connections are upgraded manually and go through the same
//     Noise Protocol handshake as the original server.  Once the secure
//     channel is established, decrypted messages are parsed as tRPC wire
//     format and dispatched via `callTRPCProcedure`.  Responses and
//     subscription events are encrypted before sending.
//
// Wire protocol (WS):
//   Inbound:  tRPC JSON-RPC 2.0 messages (parsed after Noise decrypt)
//   Outbound: tRPC JSON-RPC 2.0 responses + subscription data (encrypted)

import { Hono } from "hono";
import {
  callTRPCProcedure,
  getErrorShape,
  getTRPCErrorFromUnknown,
  isTrackedEnvelope,
  TRPCError,
  transformTRPCResponse,
  type AnyRouter,
  type TrackedEnvelope,
} from "@trpc/server";
import { parseTRPCMessage } from "@trpc/server/rpc";
import { isObservable, observableToAsyncIterable } from "@trpc/server/observable";
import type { ServerWebSocket } from "bun";

import { realpathSync } from "fs";
import { homedir } from "os";
import type { SessionState } from "@openscout/agent-sessions";
import { agentNotificationForSessionAttention, pushDeliveryForLevel } from "@openscout/runtime/agent-notification-builders";
import { broadcastApnsAlertToActiveMobileDevices } from "@openscout/runtime/mobile-push";

import { log } from "./log.ts";
import type { Bridge } from "./bridge.ts";
import { resolveConfig } from "./config.ts";
import { handleRPC, type BridgeServerOptions } from "./server.ts";
import { bridgeRouter, lookupMobileInboxItemForEvent, type MobileInboxItem } from "./router.ts";
import {
  type ScoutBrokerConversationLifecycleRecord,
  type ScoutBrokerMessageRecord,
} from "../../../broker/service.ts";
import {
  SecureTransport,
  type SocketLike,
  type KeyPair,
  isTrustedPeer,
  bytesToHex,
} from "../security/index.ts";

// ---------------------------------------------------------------------------
// Context type — must match what the router expects.
// Imported from router.ts when it exists; defined inline for now.
// ---------------------------------------------------------------------------

export interface BridgeContext {
  credentialBinding?: object;
  bridge: Bridge;
  deviceId: string | undefined;
  cwd: string;
  secureTransport?: boolean;
  trustedPeer?: boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-socket state, same role as in server.ts but extended for tRPC. */
interface SocketState {
  credentialBinding?: object;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
  /** Unsubscribe from bridge event stream. */
  unsub?: () => void;
  /** Abort the broker message invalidation watch for this socket. */
  brokerWatchAbort?: AbortController;
  /** Noise encryption transport (when secure=true). */
  transport?: SecureTransport;
  /** Short device ID derived from the remote peer's public key. */
  deviceId?: string;
  /** True only for encrypted mobile WebSocket/relay transport. */
  secureTransport?: boolean;
  /** True only when the phone key was already paired before this connection. */
  trustedPeer?: boolean;
  /** Abort controller for the connection lifetime — aborts all subscriptions on close. */
  abortController: AbortController;
  /** Per-request abort controllers keyed by tRPC message id. */
  abortControllers: Map<string | number, AbortController>;
  /** tRPC context resolved after handshake (or immediately in plaintext). */
  ctx?: BridgeContext;
  /** Whether the Noise handshake is complete (always true in plaintext mode). */
  ready: boolean;
  /** Verified equality with this host's own Noise key; never request metadata. */
  localService?: boolean;
  /** Queue of raw messages received before handshake completes (secure mode). */
  pendingMessages: string[];
  /** Active subscription iterators keyed by tRPC message id. */
  activeSubscriptions: Map<string | number, AbortController>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCurrentDirectory(): string {
  // Mirrors resolveMobileCurrentDirectory from server.ts.
  try {
    const config = resolveConfig();
    const configuredRoot = config.workspace?.root;
    if (!configuredRoot) return process.cwd();
    const expanded = configuredRoot.replace(/^~/, homedir());
    return realpathSync(expanded);
  } catch {
    return process.cwd();
  }
}

let loggedMissingApnsCredentials = false;

function mobileConversationChangedEvent(message: ScoutBrokerMessageRecord) {
  const rawClientMessageId = message.metadata?.clientMessageId;
  const clientMessageId = typeof rawClientMessageId === "string" && rawClientMessageId.trim().length > 0
    ? rawClientMessageId.trim()
    : null;
  return {
    event: "mobile:conversation:changed" as const,
    conversationId: message.conversationId,
    messageId: message.id,
    clientMessageId,
  };
}

function mobileConversationLifecycleEvent(lifecycle: ScoutBrokerConversationLifecycleRecord) {
  return {
    event: "mobile:conversation:lifecycle" as const,
    conversationId: lifecycle.conversationId,
    messageId: lifecycle.messageId ?? null,
    clientMessageId: lifecycle.clientMessageId ?? null,
    invocationId: lifecycle.invocationId ?? null,
    flightId: lifecycle.flightId ?? null,
    targetAgentId: lifecycle.targetAgentId ?? null,
    lifecycleState: lifecycle.state,
    summary: lifecycle.summary ?? null,
    error: lifecycle.error ?? null,
  };
}

async function sendMobileInboxPushNotification(item: MobileInboxItem, snapshot: SessionState | null) {
  // The command, diff, or question itself, sealed to each paired phone.
  const notification = agentNotificationForSessionAttention({ item, snapshot });
  const result = await broadcastApnsAlertToActiveMobileDevices({
    title: "Scout",
    body: genericMobileInboxAlertBody(item.kind),
    ...pushDeliveryForLevel(notification.level),
    threadId: "scout.inbox",
    payload: {
      destination: "inbox",
      itemId: item.id,
      kind: item.kind,
      sessionId: item.sessionId,
      turnId: item.turnId,
      blockId: item.blockId,
    },
    notification,
  });

  if (result.attemptedCount === 0) {
    return;
  }

  if (result.configMissing && !loggedMissingApnsCredentials) {
    loggedMissingApnsCredentials = true;
    log.warn(
      "push",
      "APNs credentials are not configured; remote mobile push notifications are registered but disabled",
    );
  }

  if (result.deliveredCount > 0) {
    log.info(
      "push",
      `Delivered ${result.deliveredCount}/${result.attemptedCount} APNs inbox alert(s)`,
      { itemId: item.id },
    );
  }

  for (const failure of result.failures) {
    log.warn(
      "push",
      `APNs delivery failed for ${failure.deviceId} (${failure.tokenSuffix})`,
      { reason: failure.reason, status: failure.status, itemId: item.id },
    );
  }
}

function genericMobileInboxAlertBody(kind: string): string {
  switch (kind) {
    case "approval": return "A local agent is asking for approval.";
    case "question": return "A local agent has a question.";
    case "failed_action":
    case "failed_turn":
    case "session_error": return "A local agent needs review.";
    default: return "A local agent has a request.";
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const BRIDGE_CONNECTION_LIMITS = {
  maxConnections: 64,
  queryLifetimeMs: 60_000,
  handshakeTimeoutMs: 10_000,
  closeGraceMs: 1_000,
  backpressureBytes: 4 * 1024 * 1024,
} as const;

export function startBridgeServerTRPC(options: {
  bridge: Bridge;
  port: number;
  secure?: boolean;
  identity?: KeyPair;
  /** Trusted bootstrap hook; intercepted before the remotely callable router. */
  pairingControl?: (action: PairingOpportunityControlAction, windowId?: string, binding?: PairingRequestBinding) => unknown;
  connectionLimits?: Partial<Record<keyof typeof BRIDGE_CONNECTION_LIMITS, number>>;
}): { stop: () => void } {
  const { bridge, port, secure = false, identity } = options;
  const limits = { ...BRIDGE_CONNECTION_LIMITS, ...options.connectionLimits };

  if (secure && !identity) {
    throw new Error("[bridge-trpc] secure mode requires an identity (key pair)");
  }
  const ownPublicKeyHex = identity ? bytesToHex(identity.publicKey) : null;

  // -------------------------------------------------------------------------
  // Hono app — HTTP surface
  // -------------------------------------------------------------------------

  // The existing bridge listener also owns host pairing ingress. It serves no
  // browser client and never exposes the bridge tRPC router over plaintext HTTP.
  const requestPeers = new WeakMap<Request, string>();
  let pairingIngress: Hono | null = null;
  let pairRequests: PendingPairRequestStore | null = null;
  function hostPairingIngress(): Hono {
    if (pairingIngress) return pairingIngress;
    const ingress = new Hono();
    ingress.use("/api/*", async (c, next) => {
      const supplied = Buffer.from(c.req.header("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${resolveWebAuthToken()}`);
      if (!isSameMacScoutRequest(c.req.raw, requestPeers.get(c.req.raw))
        || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return c.json({ error: "Local pairing operator authentication required" }, 401);
      }
      return next();
    });
    pairRequests = createPendingPairRequestStore({ statePath: pairRequestStatePath(localConfigHome()) });
    mountPairingRoutes(ingress, {
      options: { webPort: port, resolvePeerAddress: c => requestPeers.get(c.req.raw) },
      currentDirectory: resolveCurrentDirectory(), pendingPairRequests: pairRequests,
      shellStateCache: { invalidate() {} },
    });
    pairingIngress = ingress;
    return ingress;
  }

  let connectionCount = 0;
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, mode: secure ? "secure" : "plaintext", uptime: process.uptime(), connections: connectionCount, connectionLimit: limits.maxConnections }),
  );

  // SECURITY: the plaintext HTTP tRPC adapter was removed. It served the full
  // bridge router over HTTP with secureTransport:false / trustedPeer:false and a
  // client-supplied x-device-id header, bypassing the Noise handshake entirely —
  // any LAN host could call session.create / prompt.send / history.read
  // unauthenticated while pairing was active. All real clients (iOS) speak tRPC
  // over the WS+Noise path below, which is the only authenticated transport.
  // Do NOT re-add an unauthenticated HTTP tRPC surface.

  // -------------------------------------------------------------------------
  // Per-socket state map
  // -------------------------------------------------------------------------

  const socketState = new WeakMap<ServerWebSocket<unknown>, SocketState>();

  // -------------------------------------------------------------------------
  // tRPC message dispatcher — runs on decrypted/plaintext JSON strings
  // -------------------------------------------------------------------------

  function createSender(ws: ServerWebSocket<unknown>, state: SocketState) {
    /** Send a tRPC response frame. Encrypts if a SecureTransport is active. */
    return (data: unknown) => {
      const json = JSON.stringify(
        bridgeRouter
          ? transformTRPCResponse(bridgeRouter._def._config, data as any)
          : data,
      );
      if (state.transport) {
        state.transport.send(json);
      } else {
        ws.send(json);
      }
    };
  }

  async function handleTRPCMessage(
    ws: ServerWebSocket<unknown>,
    state: SocketState,
    text: string,
  ) {
    const send = createSender(ws, state);
    try {
      const request = JSON.parse(text);
      if (request.method === "pairing/opportunity") {
        // This local JSON-RPC control is not a tRPC result envelope.
        const sendControl = (value: unknown) => {
          const frame = JSON.stringify(value);
          if (state.transport) state.transport.send(frame); else ws.send(frame);
        };
        const {action, windowId, binding} = request.params ?? {};
        const requestAction = ["request-open", "request-read", "request-cancel"].includes(action);
        const validBinding = binding && typeof binding.requestId === "string"
          && /^[a-zA-Z0-9._:-]{1,128}$/.test(binding.requestId)
          && (binding.authorityStamp === undefined || (typeof binding.authorityStamp === "string" && /^[a-f0-9]{64}$/.test(binding.authorityStamp)))
          && (binding.publicKey === undefined || (typeof binding.publicKey === "string" && /^[a-f0-9]{64}$/.test(binding.publicKey)));
        if (!state.localService || !options.pairingControl || !["open", "cancel", "request-open", "request-read", "request-cancel"].includes(action)
          || (requestAction && !validBinding)
          || (windowId !== undefined && typeof windowId !== "string")) {
          sendControl({id: request.id, error: {code: -32001, message: "Local pairing control requires the host identity"}});
        } else {
          try { sendControl({id: request.id, result: options.pairingControl(action, windowId, binding)}); }
          catch (error) { log.error("pairing", `Local pairing control failed: ${String(error)}`); sendControl({id: request.id, error: {code: -32000, message: "Pairing authority unavailable"}}); }
        }
        return;
      }
    } catch { /* Normal dispatcher handles invalid JSON. */ }

    // If the router isn't loaded, fall back to the legacy RPC handler.
    if (!bridgeRouter) {
      await handleLegacyFallback(ws, state, text);
      return;
    }

    try {
      const msgJSON = JSON.parse(text);
      const msgs = Array.isArray(msgJSON) ? msgJSON : [msgJSON];

      for (const raw of msgs) {
        log.debug("rpc:req", `→ ${raw.params?.path ?? raw.method ?? "?"}`);
        const parsed = parseTRPCMessage(raw, bridgeRouter._def._config.transformer);
        const { id, method } = parsed;

        // -- subscription.stop ------------------------------------------------
        if (method === "subscription.stop") {
          state.abortControllers.get(id!)?.abort();
          state.abortControllers.delete(id!);
          continue;
        }

        if (id == null) continue;

        const type = method as "query" | "mutation" | "subscription";
        const { path, lastEventId } = (parsed as any).params ?? {};
        let { input } = (parsed as any).params ?? {};

        // Inject lastEventId into input for tracked subscriptions.
        if (lastEventId !== undefined) {
          if (input && typeof input === "object" && !Array.isArray(input)) {
            input = { ...input, lastEventId };
          } else {
            input ??= { lastEventId };
          }
        }

        // Duplicate check.
        if (state.abortControllers.has(id)) {
          send({
            id,
            jsonrpc: (parsed as any).jsonrpc,
            error: getErrorShape({
              config: bridgeRouter._def._config,
              error: new TRPCError({ code: "BAD_REQUEST", message: `Duplicate id ${id}` }),
              type: type ?? "unknown",
              path,
              input,
              ctx: undefined,
            }),
          });
          continue;
        }

        const abortController = new AbortController();
        state.abortControllers.set(id, abortController);

        // Also abort when the connection closes.
        state.abortController.signal.addEventListener("abort", () => abortController.abort(), {
          once: true,
        });

        try {
          const result = await callTRPCProcedure({
            router: bridgeRouter,
            path,
            getRawInput: () => Promise.resolve(input),
            ctx: state.ctx!,
            type,
            signal: abortController.signal,
            batchIndex: 0,
          });

          const isIterableResult =
            isAsyncIterable(result) || isObservable(result);

          if (type !== "subscription") {
            // Query / Mutation — single response.
            if (isIterableResult) {
              throw new TRPCError({
                code: "UNSUPPORTED_MEDIA_TYPE",
                message: `Cannot return an async iterable from a ${type} procedure over WebSocket`,
              });
            }

            send({
              id,
              jsonrpc: (parsed as any).jsonrpc,
              result: { type: "data", data: result },
            });
            state.abortControllers.delete(id);
            continue;
          }

          // -- Subscription -----------------------------------------------------
          if (!isIterableResult) {
            throw new TRPCError({
              message: `Subscription ${path} did not return an observable or AsyncGenerator`,
              code: "INTERNAL_SERVER_ERROR",
            });
          }

          const iterable = isObservable(result)
            ? observableToAsyncIterable(result, abortController.signal)
            : result;

          const iterator = (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          const abortPromise = new Promise<"abort">((resolve) => {
            abortController.signal.addEventListener("abort", () => resolve("abort"), {
              once: true,
            });
          });

          // Run the subscription loop in the background.
          (async () => {
            try {
              while (true) {
                const raced = await Promise.race([
                  iterator.next().catch(getTRPCErrorFromUnknown),
                  abortPromise,
                ]);

                if (raced === "abort") {
                  await iterator.return?.();
                  break;
                }

                if (raced instanceof Error) {
                  const error = getTRPCErrorFromUnknown(raced);
                  send({
                    id,
                    jsonrpc: (parsed as any).jsonrpc,
                    error: getErrorShape({
                      config: bridgeRouter!._def._config,
                      error,
                      type,
                      path,
                      input,
                      ctx: state.ctx,
                    }),
                  });
                  break;
                }

                if ((raced as IteratorResult<unknown>).done) {
                  break;
                }

                const value = (raced as IteratorResult<unknown>).value;

                if (isTrackedEnvelope(value)) {
                  const envelope = value as TrackedEnvelope<unknown>;
                  const eventId = envelope[0];
                  const eventData = envelope[1];
                  send({
                    id,
                    jsonrpc: (parsed as any).jsonrpc,
                    result: {
                      type: "data",
                      id: eventId,
                      data: { id: eventId, data: eventData },
                    },
                  });
                  continue;
                }

                send({
                  id,
                  jsonrpc: (parsed as any).jsonrpc,
                  result: { type: "data", data: value },
                });
              }

              await iterator.return?.();
              send({ id, jsonrpc: (parsed as any).jsonrpc, result: { type: "stopped" } });
            } catch (cause) {
              const error = getTRPCErrorFromUnknown(cause);
              send({
                id,
                jsonrpc: (parsed as any).jsonrpc,
                error: getErrorShape({
                  config: bridgeRouter!._def._config,
                  error,
                  type,
                  path,
                  input,
                  ctx: state.ctx,
                }),
              });
              abortController.abort();
            } finally {
              state.abortControllers.delete(id);
            }
          })();

          // Signal that the subscription has started.
          send({ id, jsonrpc: (parsed as any).jsonrpc, result: { type: "started" } });
        } catch (cause) {
          const error = getTRPCErrorFromUnknown(cause);
          send({
            id,
            jsonrpc: (parsed as any).jsonrpc,
            error: getErrorShape({
              config: bridgeRouter._def._config,
              error,
              type,
              path,
              input,
              ctx: state.ctx,
            }),
          });
          state.abortControllers.delete(id);
        }
      }
    } catch (cause) {
      // Top-level parse error.
      log.error("rpc:err", `parse/dispatch error: ${cause instanceof Error ? cause.message : String(cause)}`);
      const error = new TRPCError({ code: "PARSE_ERROR", cause });
      send({
        id: null,
        error: bridgeRouter
          ? getErrorShape({
              config: bridgeRouter._def._config,
              error,
              type: "unknown",
              path: undefined,
              input: undefined,
              ctx: undefined,
            })
          : { code: -32700, message: "Parse error" },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Legacy RPC fallback — used when router.ts hasn't been created yet.
  // Delegates to the existing handleRPC from server.ts so the phone can
  // connect using the old { id, method, params } wire format.
  // -------------------------------------------------------------------------

  async function handleLegacyFallback(
    ws: ServerWebSocket<unknown>,
    state: SocketState,
    text: string,
  ) {
    const sendRaw = (json: string) => {
      if (state.transport) {
        state.transport.send(json);
      } else {
        ws.send(json);
      }
    };

    let req: { id: string; method: string; params?: unknown };
    try {
      req = JSON.parse(text);
    } catch {
      sendRaw(JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    const res = await handleRPC(bridge, req, { deviceId: state.deviceId, secureTransport: state.secureTransport, trustedPeer: state.trustedPeer, credentialBinding: state.credentialBinding });
    sendRaw(JSON.stringify(res));
  }

  // -------------------------------------------------------------------------
  // Shared setup: subscribe to bridge events and push to client
  // -------------------------------------------------------------------------

  function subscribeBridgeEvents(
    ws: ServerWebSocket<unknown>,
    state: SocketState,
  ) {
    // Short-lived status/RPC clients do not need replay or a broker SSE watch.
    if ((ws.data as { subscribeEvents?: boolean } | undefined)?.subscribeEvents === false) return;

    const sendEvent = (json: string) => {
      if (state.transport) {
        state.transport.send(json);
      } else {
        ws.send(json);
      }
    };

    // Push current sessions on connect.
    for (const session of bridge.listSessions()) {
      sendEvent(
        JSON.stringify({ seq: 0, event: { event: "session:update", session } }),
      );
    }

    // Subscribe to future events.
    state.unsub = bridge.onEvent((sequenced) => {
      logBridgeEvent(sequenced.event, sequenced.seq);
      sendEvent(
        JSON.stringify({ seq: sequenced.seq, event: sequenced.event }),
      );

      const attentionItem = lookupMobileInboxItemForEvent(bridge, sequenced.event);
      if (attentionItem) {
        sendEvent(JSON.stringify({
          event: "operator:notify",
          tier: attentionItem.risk === "low" ? "badge" : "interrupt",
          item: attentionItem,
        }));
        void sendMobileInboxPushNotification(
          attentionItem,
          bridge.getSessionSnapshot(attentionItem.sessionId) ?? null,
        ).catch((error) => {
          log.warn(
            "push",
            "Unexpected error while sending APNs inbox alert",
            { itemId: attentionItem.id, error: error instanceof Error ? error.message : String(error) },
          );
        });
      }
    });

    // Mobile Tail is NOT pushed the live firehose here. The phone polls a recent
    // slice (mobile.tail) only while the Tail view is open — bandwidth/battery
    // friendly and resilient to broker restarts, where this singleton push would
    // silently go stale. See readScoutBrokerTailRecent / TailSurface.

    state.brokerWatchAbort?.abort();
    const brokerWatchAbort = new AbortController();
    state.brokerWatchAbort = brokerWatchAbort;
    void watchSharedScoutMessages({
      allConversations: true,
      signal: brokerWatchAbort.signal,
      onMessage(message) {
        sendEvent(JSON.stringify(mobileConversationChangedEvent(message)));
      },
      onLifecycle(lifecycle) {
        sendEvent(JSON.stringify(mobileConversationLifecycleEvent(lifecycle)));
      },
    }).catch((error) => {
      if (brokerWatchAbort.signal.aborted) return;
      log.warn(
        "broker",
        "Broker message invalidation stream ended unexpectedly",
        { error: error instanceof Error ? error.message : String(error) },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Bun.serve — combined HTTP + WebSocket
  // -------------------------------------------------------------------------

  const server = Bun.serve<{ subscribeEvents: boolean }>({
    port,

    fetch(req, server) {
      // WebSocket upgrade.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (connectionCount >= limits.maxConnections) {
          return new Response("Pairing connection limit reached", { status: 503, headers: { "retry-after": "5" } });
        }
        const upgraded = server.upgrade(req, {
          data: { subscribeEvents: new URL(req.url).searchParams.get("events") !== "0" },
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 500 });
        }
        connectionCount++;
        return undefined;
      }

      const pathname = new URL(req.url).pathname;
      if (options.pairingControl && (pathname === "/pair" || pathname.startsWith("/api/"))) {
        const address = server.requestIP(req)?.address;
        if (address) requestPeers.set(req, address);
        return hostPairingIngress().fetch(req);
      }
      return app.fetch(req);
    },

    websocket: {
      backpressureLimit: limits.backpressureBytes,
      closeOnBackpressureLimit: true,
      open(ws) {
        log.debug("srv", "client connected");

        const state: SocketState = {
          abortController: new AbortController(),
          abortControllers: new Map(),
          activeSubscriptions: new Map(),
          ready: false,
          pendingMessages: [],
        };

        socketState.set(ws, state);
        const queryOnly = ws.data.subscribeEvents === false;
        const lifetimeMs = queryOnly ? limits.queryLifetimeMs : secure ? limits.handshakeTimeoutMs : null;
        if (lifetimeMs !== null) {
          state.lifetimeTimer = setTimeout(() => {
            // A peer that ignores the close handshake must still release its slot.
            state.lifetimeTimer = setTimeout(() => ws.terminate(), limits.closeGraceMs);
            ws.close(1008, queryOnly ? "Status connection expired" : "Handshake timed out");
          }, lifetimeMs);
        }

        if (secure && identity) {
          // --- Secure mode: Noise handshake first, then tRPC ----------------
          const socketAdapter: SocketLike = { send: (data) => ws.send(data) };

          const transport = new SecureTransport(
            socketAdapter,
            "responder",
            identity,
            {
              onReady: (remotePublicKey, readyInfo) => {
                if (!queryOnly) clearTimeout(state.lifetimeTimer);
                const pubHex = bytesToHex(remotePublicKey);
                // This machine's own processes (broker, web server) authenticate
                // with the bridge's own identity key: holding the private key
                // proves the same user on the same Mac. They are never written
                // to the paired-device list (trustOnComplete is false here).
                const trusted = pubHex === ownPublicKeyHex
                  || (readyInfo.wasTrustedPeer && isTrustedPeer(pubHex));
                state.localService = pubHex === ownPublicKeyHex;
                state.deviceId = pubHex.slice(0, 16);
                state.secureTransport = true;
                state.trustedPeer = trusted;
                log.info(
                  "server-trpc",
                  `secure handshake complete (peer: ${pubHex.slice(0, 12)}..., trusted: ${trusted}, device: ${state.deviceId})`,
                );
                if (!trusted) {
                  log.warn(
                    "server-trpc",
                    `rejecting untrusted direct secure peer ${pubHex.slice(0, 12)}...; pair via the QR relay first`,
                  );
                  ws.close(4003, "Untrusted peer");
                  return;
                }

                if (!state.localService) {
                  try {
                    state.credentialBinding = createCredentialBinding(bridge, pubHex,
                      () => ws.readyState === WebSocket.OPEN && !state.abortController.signal.aborted
                        && state.transport === transport && transport.isReady());
                  } catch { ws.close(4003, "Credential authority unavailable; reconnect"); return; }
                }

                // Build tRPC context now that we know the peer.
                state.ctx = {
                  bridge,
                  deviceId: state.deviceId,
                  credentialBinding: state.credentialBinding,
                  cwd: resolveCurrentDirectory(),
                  secureTransport: true,
                  trustedPeer: trusted,
                };
                state.ready = true;

                // Push bridge events through the encrypted channel.
                subscribeBridgeEvents(ws, state);

                // Drain any messages that arrived after handshake completion
                // but were queued because `ready` wasn't set yet.
                for (const pending of state.pendingMessages) {
                  handleTRPCMessage(ws, state, pending);
                }
                state.pendingMessages = [];
              },

              onMessage: (message) => {
                // Decrypted message from the peer.
                if (!state.ready) {
                  // Shouldn't happen — handshake must complete before
                  // application messages arrive — but be safe.
                  state.pendingMessages.push(message);
                  return;
                }
                handleTRPCMessage(ws, state, message);
              },

              onError: (err) => {
                log.error("trns:cry", `secure transport error: ${err.message}`);
              },

              onClose: () => {
                state.unsub?.();
                state.brokerWatchAbort?.abort();
                state.abortController.abort();
              },
            },
            { trustOnComplete: false, skipTrustWrite: (hex) => hex === ownPublicKeyHex },
          );

          state.transport = transport;
        } else {
          // --- Plaintext mode -----------------------------------------------
          state.ctx = {
            bridge,
            deviceId: undefined,
            cwd: resolveCurrentDirectory(),
            secureTransport: false,
            trustedPeer: false,
          };
          state.ready = true;

          subscribeBridgeEvents(ws, state);
        }
      },

      message(ws, raw) {
        const state = socketState.get(ws);
        if (!state) return;

        if (secure && state.transport) {
          // Feed raw bytes/strings into the SecureTransport.
          // Pre-handshake: handshake frames.  Post-handshake: encrypted data.
          const data = typeof raw === "string" ? raw : new Uint8Array(raw);
          state.transport.receive(data);
        } else {
          // Plaintext — dispatch directly.
          const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          handleTRPCMessage(ws, state, text);
        }
      },

      close(ws) {
        log.debug("srv", "client disconnected");
        const state = socketState.get(ws);
        if (!state) return;
        socketState.delete(ws);
        connectionCount = Math.max(0, connectionCount - 1);

        clearTimeout(state.lifetimeTimer);
        state.unsub?.();
        state.brokerWatchAbort?.abort();
        state.abortController.abort();
        // Abort all per-request controllers (subscriptions, etc.).
        for (const ctrl of state.abortControllers.values()) {
          ctrl.abort();
        }
      },
    },
  });

  const mode = secure ? "secure (Noise)" : "plaintext";
  const routerStatus = bridgeRouter ? "tRPC router loaded" : "legacy RPC fallback";
  log.info("srv", `listening on ws://localhost:${port} (${mode}, ${routerStatus})`);
  console.log(`[bridge-trpc] listening on ws://localhost:${port} (${mode}, ${routerStatus})`);

  return {
    stop() {
      pairRequests?.dispose();
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Event logging — same as server.ts
// ---------------------------------------------------------------------------

function logBridgeEvent(event: unknown, seq: number): void {
  if (!event || typeof event !== "object") return;
  const e = event as Record<string, unknown>;
  const eventType = (e.event as string) ?? "unknown";
  const sessionId = (e.sessionId ?? (e.session as any)?.id ?? "") as string;
  const shortSession = sessionId ? sessionId.slice(0, 20) : "";

  switch (eventType) {
    case "session:update":
      log.info("evt", `↓ session:update ${shortSession} status=${(e.session as any)?.status ?? "?"}`, { seq });
      break;
    case "turn:start":
      log.info("evt", `↓ turn:start ${shortSession} turn=${e.turnId ?? "?"}`, { seq });
      break;
    case "turn:end":
      log.info("evt", `↓ turn:end ${shortSession} turn=${e.turnId ?? "?"}`, { seq });
      break;
    case "block:start":
      log.debug("event", `[trpc] block:start ${shortSession} type=${(e.block as any)?.type ?? "?"}`, { seq });
      break;
    case "block:delta":
      // Too noisy — skip.
      break;
    case "block:end":
      log.debug("event", `[trpc] block:end ${shortSession}`, { seq });
      break;
    default:
      log.info("evt", `↓ ${eventType} ${shortSession}`, { seq });
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as any)[Symbol.asyncIterator] === "function"
  );
}
