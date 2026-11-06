import { createCredentialBinding } from "./credential-binding.ts";
import { pairingTrustOwner } from "@openscout/runtime/pairing-security/trust-owner";
import type { AdmitAccountDevice } from "../account-admission.ts";
import { isTrustedPeer } from "@openscout/runtime/pairing-security/identity";
import { watchSharedScoutMessages } from "./broker-message-fanout.ts";
// Relay client — connects the bridge OUTBOUND to a relay server.
//
// This lets phones and tablets reach the bridge when they're not on the same
// LAN. The bridge connects to the relay as the "bridge" role, and each mobile
// device connects as a "client". The relay assigns each client socket a relay
// id, and the bridge keeps a distinct Noise transport per relay client so
// reconnects or multiple devices cannot corrupt one another's cipher state.
//
// The bridge is the Noise "responder" — the phone initiates the handshake
// because it scanned the QR code containing the bridge's public key.

import type { Bridge } from "./bridge.ts";
import { handleRPC } from "./server.ts";
import { bridgeRouter } from "./router.ts";
import { callTRPCProcedure, getErrorShape, getTRPCErrorFromUnknown, isTrackedEnvelope, TRPCError, type TrackedEnvelope } from "@trpc/server";
import { isObservable, observableToAsyncIterable } from "@trpc/server/observable";
import { log } from "./log.ts";
import {
  type ScoutBrokerConversationLifecycleRecord,
  type ScoutBrokerMessageRecord,
} from "../../../broker/service.ts";
import {
  SecureTransport,
  type SocketLike,
  type KeyPair,
  type QRPayload,
  createQRPayload,
  bytesToHex,
} from "../security/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelayRoomKind = "pairing" | "reconnect" | "account";

export interface RelayClientOptions {
  kind?: RelayRoomKind;
  /** Only the account room waits for this trusted, host-local decision path. */
  admitNewDevice?: AdmitAccountDevice;
  /** Request windows must authorize trusted keys too, through the owner. */
  authorizePeer?: (publicKey: string, room: string, isLive: () => boolean) => boolean;
  privateRoom?: boolean;
  reconnectRoom?: string;
  /** Enable Noise encryption on the relay connection. Default: true. */
  secure?: boolean;
  /** Relay URL advertised to phones. Defaults to the URL used by the bridge. */
  publicRelayUrl?: string;
  /** Additional relay URLs phones should try after the advertised primary. */
  fallbackRelayUrls?: string[];
  /** Shared QR payload when one bridge joins multiple relay servers. */
  qrPayload?: QRPayload;
  /** Optional lifecycle callbacks for status surfaces. */
  events?: RelayEventHandlers;
  /** Trusted local workflow, never a wire field. Absent means reconnect only. */
  onPeerAdmitted?: () => void;
  admitNewPeer?: (publicKey: string, room: string, isLive: () => boolean) => boolean;
}

export interface RelayConnection {
  /** QR payload for the phone to scan — contains relay URL, room ID, bridge public key. */
  qrPayload: QRPayload;
  /** Disconnect from the relay and stop reconnecting. */
  disconnect: () => void;
  /** Keep admitted devices, reject new connections, leave when empty. */
  retire: (onEmpty?: () => void) => void;
}

export interface RelayEventHandlers {
  onConnecting?: (detail: { relayUrl: string; room: string }) => void;
  onConnected?: (detail: { relayUrl: string; room: string }) => void;
  onPaired?: (detail: { relayUrl: string; room: string; remotePublicKey: Uint8Array }) => void;
  onError?: (detail: { relayUrl: string; room: string; error: Error }) => void;
  onClosed?: (detail: { relayUrl: string; room: string; code: number; reason: string }) => void;
  onReconnectScheduled?: (detail: { relayUrl: string; room: string; delayMs: number }) => void;
}

interface RelayEnvelope {
  phase: "relay";
  event: "message" | "close";
  clientId: string;
  payload?: string;
  code?: number;
  reason?: string;
}

interface RelayPeerState {
  credentialBinding?: object;
  subscriptions: Map<string | number, AbortController>;
  clientId: string;
  transport: SecureTransport;
  deviceId?: string;
  trustedPeer?: boolean;
  publicKey?: string;
  admitted?: boolean;
  awaitingAdmission?: AbortController;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const LEGACY_CLIENT_ID = "__legacy__";

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect the bridge to a relay server for remote mobile access.
 *
 * Returns a QR payload (to display / encode for the phone) and a disconnect
 * function. The connection auto-reconnects with exponential backoff.
 */
export function connectToRelay(
  relayUrl: string,
  identity: KeyPair,
  bridge: Bridge,
  options: RelayClientOptions = {},
): RelayConnection {
  const { secure = true, events } = options;
  const eventRelayUrl = options.publicRelayUrl?.trim() || relayUrl;
  const qrPayload = options.qrPayload
    ?? createQRPayload(identity.publicKey, eventRelayUrl, options.fallbackRelayUrls);

  const roomLabel = options.privateRoom ? "request-bound" : qrPayload.room;
  let ws: WebSocket | null = null;
  let eventUnsub: (() => void) | null = null;
  let brokerWatchAbort: AbortController | null = null;
  let stopped = false;
  let retired = false;
  let onRetiredEmpty: (() => void) | undefined;
  const kind = options.kind ?? "reconnect";
  if (kind === "account" && (!secure || typeof options.admitNewDevice !== "function")) {
    throw new Error("Account rooms require Noise and a host owner-admission callback");
  }
  let backoff = INITIAL_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const securePeers = new Map<string, RelayPeerState>();
  const plaintextClients = new Set<string>();

  function connect(): void {
    if (stopped) return;

    const bridgeKeyHex = bytesToHex(identity.publicKey);
    const url = buildRelayUrl(relayUrl, qrPayload.room, kind === "reconnect" ? bridgeKeyHex : undefined);
    console.log(`[relay-client] connecting to relay (room: ${roomLabel})`);
    events?.onConnecting?.({ relayUrl: eventRelayUrl, room: qrPayload.room });

    const socket = new WebSocket(url, relayWebSocketOptions(relayUrl) as never);
    ws = socket;

    socket.addEventListener("open", () => {
      if (stopped || ws !== socket) return;
      console.log(`[relay-client] connected to relay (room: ${roomLabel})`);
      backoff = INITIAL_BACKOFF_MS;
      events?.onConnected?.({ relayUrl: eventRelayUrl, room: qrPayload.room });
    });

    socket.addEventListener("message", (event) => {
      if (stopped || ws !== socket) return;
      handleRelaySocketMessage(event.data);
    });

    socket.addEventListener("close", (event) => {
      if (stopped || ws !== socket) return;
      console.log(`[relay-client] disconnected (code: ${event.code}, reason: ${event.reason})`);
      events?.onClosed?.({
        relayUrl: eventRelayUrl,
        room: qrPayload.room,
        code: event.code,
        reason: event.reason,
      });
      cleanup();
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (stopped || ws !== socket) return;
      const error = new Error("Relay websocket error");
      console.error("[relay-client] connection error");
      events?.onError?.({ relayUrl: eventRelayUrl, room: qrPayload.room, error });
      // The close event will fire after this, triggering reconnect.
    });
  }

  function handleRelaySocketMessage(raw: unknown): void {
    const envelope = parseRelayEnvelope(raw);

    if (!secure) {
      handlePlaintextRelayMessage(envelope, raw);
      return;
    }

    if (!envelope) {
      const payload = asStringPayload(raw);
      if (!payload) return;
      routeSecurePayload(LEGACY_CLIENT_ID, payload);
      return;
    }

    if (envelope.event === "close") {
      teardownSecurePeer(envelope.clientId);
      return;
    }

    if (!envelope.payload) {
      return;
    }

    routeSecurePayload(envelope.clientId, envelope.payload);
  }

  function routeSecurePayload(clientId: string, payload: string): void {
    let peer = securePeers.get(clientId);
    if (retired && !peer?.admitted) {
      sendRelayClose(clientId, 4003, "Untrusted peer");
      return;
    }
    const handshakePattern = detectHandshakePattern(payload);

    if (handshakePattern && (!peer || peer.transport.isReady())) {
      teardownSecurePeer(clientId);
      peer = createSecurePeer(clientId, handshakePattern);
    }

    if (!peer && !handshakePattern && clientId !== LEGACY_CLIENT_ID) {
      // A pre-reconnect session lost its keys. Ask the phone to handshake again.
      sendRelayClose(clientId, 4002, "Transport reset");
      return;
    }
    peer?.transport.receive(payload);
  }

  function createSecurePeer(clientId: string, pattern?: "XX" | "IK"): RelayPeerState | undefined {
    if (!ws) return undefined;

    const peer: RelayPeerState = {
      clientId,
      subscriptions: new Map(),
      transport: undefined as unknown as SecureTransport,
      deviceId: undefined,
      trustedPeer: false,
    };

    const socketAdapter: SocketLike = {
      send: (data) => {
        sendRelayMessage(clientId, data);
      },
    };

    const transport = new SecureTransport(
      socketAdapter,
      "responder",
      identity,
      {
        onReady: (remotePublicKey, readyInfo) => {
          const pubHex = bytesToHex(remotePublicKey);
          if (kind === "account" && !isTrustedPeer(pubHex)) {
            awaitAccountAdmission(peer, remotePublicKey);
            return;
          }
          try {
            const live = () => !stopped && ws?.readyState === WebSocket.OPEN && securePeers.get(clientId) === peer;
            const trusted = options.authorizePeer
              ? options.authorizePeer(pubHex, qrPayload.room, live)
              : isTrustedPeer(pubHex) || (kind === "pairing" && !retired && options.admitNewPeer?.(pubHex, qrPayload.room, live) === true);
            if (!live() || !trusted || !isTrustedPeer(pubHex)) {
              sendRelayClose(clientId, 4003, "Untrusted peer");
              teardownSecurePeer(clientId);
              return;
            }
            peer.publicKey = pubHex;
            peer.deviceId = pubHex.slice(0, 16);
            peer.trustedPeer = true;
            peer.admitted = true;
          } catch (error) {
            sendRelayClose(clientId, 4003, "Untrusted peer");
            teardownSecurePeer(clientId);
            return;
          }
          publishAdmittedPeer(peer, remotePublicKey);
        },

        onMessage: (message) => {
          if (kind === "account" && securePeers.get(clientId) === peer && handleAccountAdmissionMessage(peer, message)) return;
          if (peer.admitted && securePeers.get(clientId) === peer) handleIncomingRPC(peer, message);
        },

        onError: (err) => {
          console.error("[relay-client] secure transport error:", err.message);
          log.error("trns:cry", `decrypt failed for ${clientId} — resetting handshake: ${err.message}`);
          events?.onError?.({ relayUrl: eventRelayUrl, room: qrPayload.room, error: err });
          sendRelayClose(clientId, 4002, "Transport reset");
          teardownSecurePeer(clientId);
        },

        onClose: () => {
          teardownSecurePeer(clientId);
        },
      },
      { pattern, trustOnComplete: false },
    );

    peer.transport = transport;
    securePeers.set(clientId, peer);
    return peer;
  }

  function publishAdmittedPeer(peer: RelayPeerState, remotePublicKey: Uint8Array): void {
    const pubHex = bytesToHex(remotePublicKey), clientId = peer.clientId;
    const carrier = ws;
    try {
      peer.credentialBinding = createCredentialBinding(bridge, pubHex,
        () => !stopped && ws === carrier && carrier?.readyState === WebSocket.OPEN
          && peer.admitted === true && securePeers.get(clientId) === peer && peer.transport.isReady());
    } catch {
      sendRelayClose(clientId, 4003, "Credential authority unavailable; reconnect");
      teardownSecurePeer(clientId); return;
    }
    if (kind === "pairing") options.onPeerAdmitted?.();
    replaceOlderPeerForSameDevice(peer);
    ensureBridgeEventSubscription();
    ensureBrokerMessageSubscription();
    console.log(
      `[relay-client] secure handshake complete (peer: ${pubHex.slice(0, 12)}..., trusted: ${peer.trustedPeer}, device: ${peer.deviceId}, client: ${clientId})`,
    );
    events?.onPaired?.({ relayUrl: eventRelayUrl, room: qrPayload.room, remotePublicKey });
    sendExistingSessions((json) => {
      if (peer.admitted && securePeers.get(peer.clientId) === peer && peer.transport.isReady()) {
        peer.transport.send(json);
      }
    });
  }

  function awaitAccountAdmission(peer: RelayPeerState, remotePublicKey: Uint8Array): void {
    const pubHex = bytesToHex(remotePublicKey), waiting = new AbortController();
    const live = () => !stopped && !retired && !waiting.signal.aborted
      && ws?.readyState === WebSocket.OPEN && securePeers.get(peer.clientId) === peer;
    peer.publicKey = pubHex;
    peer.deviceId = pubHex.slice(0, 16);
    peer.awaitingAdmission = waiting;
    let authorityStamp: string;
    try { authorityStamp = pairingTrustOwner().pairingAuthorityStamp(); }
    catch { reject(); return; }
    function reject() {
      if (securePeers.get(peer.clientId) !== peer) return;
      sendRelayClose(peer.clientId, 4003, "Not allowed by the host");
      teardownSecurePeer(peer.clientId);
    }
    void Promise.resolve().then(() => options.admitNewDevice!(pubHex, waiting.signal)).then(decision => {
      if (!live()) return;
      if (decision !== "admitted") { reject(); return; }
      // Fulfillment is necessary, but a stale/withdrawn authority or a departed
      // transport still cannot publish trust. Use the canonical live gate.
      const opportunity = pairingTrustOwner().openPairingOpportunity(
        qrPayload.room, Date.now() + 5_000, pubHex, authorityStamp,
      );
      try {
        if (!opportunity.admit(pubHex, qrPayload.room, live)) { reject(); return; }
      } finally { opportunity.cancel(); }
      if (!live() || !isTrustedPeer(pubHex)) { reject(); return; }
      peer.awaitingAdmission = undefined;
      peer.trustedPeer = true;
      peer.admitted = true;
      publishAdmittedPeer(peer, remotePublicKey);
    }).catch(() => { if (live()) reject(); });
  }

  function handleAccountAdmissionMessage(peer: RelayPeerState, message: string): boolean {
    let req: any;
    try { req = JSON.parse(message); } catch { return !peer.admitted; }
    const statusQuery = req?.jsonrpc === "2.0" && req.method === "query" && req.params?.path === "web.admission";
    if (!statusQuery && peer.admitted) return false;
    if (req?.id == null || req?.method === "subscription.stop") return true;
    peer.transport.send(JSON.stringify(statusQuery
      ? { id: req.id, jsonrpc: "2.0", result: { type: "data", data: { state: peer.admitted ? "admitted" : "pending" } } }
      : { id: req.id, jsonrpc: "2.0", error: { code: -32001, message: "Waiting for host approval", data: { code: "UNAUTHORIZED", httpStatus: 401 } } }));
    return true;
  }

  function replaceOlderPeerForSameDevice(peer: RelayPeerState): void {
    if (!peer.admitted || !peer.publicKey) return;

    for (const [otherClientId, otherPeer] of securePeers) {
      if (otherClientId === peer.clientId || !otherPeer.admitted || otherPeer.publicKey !== peer.publicKey) {
        continue;
      }
      sendRelayClose(otherClientId, 4001, "Replaced by newer connection");
      teardownSecurePeer(otherClientId);
    }
  }

  function teardownSecurePeer(clientId: string): void {
    const leaving = securePeers.get(clientId);
    leaving?.awaitingAdmission?.abort();
    for (const subscription of leaving?.subscriptions.values() ?? []) subscription.abort();
    leaving?.subscriptions.clear();
    if (!securePeers.has(clientId)) {
      return;
    }
    securePeers.get(clientId)!.admitted = false;
    securePeers.delete(clientId);
    maybeReleaseMobileSubscriptions();
    if (retired && securePeers.size === 0) disconnect();
  }

  function handlePlaintextRelayMessage(envelope: RelayEnvelope | null, raw: unknown): void {
    if (envelope?.event === "close") {
      plaintextClients.delete(envelope.clientId);
      maybeReleaseMobileSubscriptions();
      return;
    }

    const clientId = envelope?.clientId ?? LEGACY_CLIENT_ID;
    const payload = envelope?.payload ?? asStringPayload(raw);
    if (!payload) return;

    const isNewClient = !plaintextClients.has(clientId);
    plaintextClients.add(clientId);
    ensureBridgeEventSubscription();
    ensureBrokerMessageSubscription();

    if (isNewClient) {
      sendExistingSessions((json) => sendRelayMessage(clientId, json));
    }

    handlePlaintextMessage(clientId, payload);
  }

  function ensureBridgeEventSubscription(): void {
    if (eventUnsub) return;

    eventUnsub = bridge.onEvent((sequenced) => {
      const json = JSON.stringify({
        seq: sequenced.seq,
        event: sequenced.event,
      });

      broadcastToMobileClients(json);
    });
  }

  function ensureBrokerMessageSubscription(): void {
    if (brokerWatchAbort) return;

    const abort = new AbortController();
    brokerWatchAbort = abort;
    void watchSharedScoutMessages({
      allConversations: true,
      signal: abort.signal,
      onMessage(message) {
        broadcastToMobileClients(JSON.stringify(mobileConversationChangedEvent(message)));
      },
      onLifecycle(lifecycle) {
        broadcastToMobileClients(JSON.stringify(mobileConversationLifecycleEvent(lifecycle)));
      },
    }).catch((error) => {
      if (abort.signal.aborted) return;
      log.warn(
        "broker",
        "Broker message invalidation stream ended unexpectedly",
        { error: error instanceof Error ? error.message : String(error) },
      );
      if (brokerWatchAbort === abort) brokerWatchAbort = null;
    });
  }

  function maybeReleaseMobileSubscriptions(): void {
    if (secure ? securePeers.size > 0 : plaintextClients.size > 0) {
      return;
    }

    eventUnsub?.();
    eventUnsub = null;
    brokerWatchAbort?.abort();
    brokerWatchAbort = null;
  }

  function broadcastToMobileClients(json: string): void {
    if (secure) {
      for (const peer of securePeers.values()) {
        if (peer.admitted && securePeers.get(peer.clientId) === peer && peer.transport.isReady()) {
          peer.transport.send(json);
        }
      }
      return;
    }

    for (const clientId of plaintextClients) {
      sendRelayMessage(clientId, json);
    }
  }

  function sendExistingSessions(send: (json: string) => void): void {
    for (const session of bridge.listSessions()) {
      send(JSON.stringify({
        seq: 0,
        event: { event: "session:update", session },
      }));
    }
  }

  async function dispatchTRPC(
    req: any,
    send: (json: string) => void,
    context: { credentialBinding?: object; deviceId?: string; secureTransport?: boolean; trustedPeer?: boolean; reconnectRoom?: string; relayUrls?: string[] } = {},
    subscriptions?: Map<string | number, AbortController>,
  ): Promise<void> {
    const { id, method, params } = req;

    if (method === "subscription.stop") {
      subscriptions?.get(id)?.abort();
      subscriptions?.delete(id);
      return;
    }

    const type = method as "query" | "mutation" | "subscription";
    const path = params?.path;
    let input = params?.input;

    if (!path) {
      send(JSON.stringify({ id, jsonrpc: "2.0", error: { code: -32600, message: "Missing path in params" } }));
      return;
    }

    const sendError = (cause: unknown) => {
      const error = getTRPCErrorFromUnknown(cause);
      send(JSON.stringify({
        id,
        jsonrpc: "2.0",
        error: getErrorShape({ config: bridgeRouter._def._config, error, type, path, input, ctx: undefined }),
      }));
    };

    if (type === "subscription") {
      // A resuming client names the last event it saw; the procedure reads it from its input.
      if (params?.lastEventId !== undefined) {
        input = input && typeof input === "object" && !Array.isArray(input)
          ? { ...input, lastEventId: params.lastEventId }
          : input ?? { lastEventId: params.lastEventId };
      }
      if (!subscriptions) {
        sendError(new TRPCError({ code: "METHOD_NOT_SUPPORTED", message: "Subscriptions need a secure channel" }));
        return;
      }
      if (subscriptions.has(id)) {
        sendError(new TRPCError({ code: "BAD_REQUEST", message: `Duplicate id ${id}` }));
        return;
      }
      const abort = new AbortController();
      subscriptions.set(id, abort);
      void runSubscription(id, path, input, abort, send, context, sendError).finally(() => {
        if (subscriptions.get(id) === abort) subscriptions.delete(id);
      });
      return;
    }

    try {
      const ctx = { bridge, cwd: process.cwd(), ...context };
      const result = await callTRPCProcedure({
        router: bridgeRouter,
        path,
        getRawInput: () => Promise.resolve(input),
        ctx,
        type,
        signal: AbortSignal.timeout(30_000),
        batchIndex: 0,
      });
      send(JSON.stringify({ id, jsonrpc: "2.0", result: { type: "data", data: result } }));
    } catch (cause) {
      const errMsg = cause instanceof Error ? cause.message : String(cause);
      log.error("rpc:err", `✗ ${path} — ${errMsg}`);
      sendError(cause instanceof TRPCError ? cause : new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause }));
    }
  }

  /** One subscription's frames, as the bridge's own socket sends them: started, data (tracked ids kept), stopped. */
  async function runSubscription(
    id: string | number,
    path: string,
    input: unknown,
    abort: AbortController,
    send: (json: string) => void,
    context: Record<string, unknown>,
    sendError: (cause: unknown) => void,
  ): Promise<void> {
    let iterator: AsyncIterator<unknown>;
    try {
      const result = await callTRPCProcedure({
        router: bridgeRouter,
        path,
        getRawInput: () => Promise.resolve(input),
        ctx: { bridge, cwd: process.cwd(), ...context },
        type: "subscription",
        signal: abort.signal,
        batchIndex: 0,
      });
      const iterable = isObservable(result)
        ? observableToAsyncIterable(result, abort.signal)
        : result as AsyncIterable<unknown>;
      if (!iterable || typeof (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Subscription ${path} did not return a stream` });
      }
      iterator = iterable[Symbol.asyncIterator]();
    } catch (cause) {
      sendError(cause);
      return;
    }

    send(JSON.stringify({ id, jsonrpc: "2.0", result: { type: "started" } }));
    const aborted = new Promise<"abort">((resolve) => {
      if (abort.signal.aborted) resolve("abort");
      abort.signal.addEventListener("abort", () => resolve("abort"), { once: true });
    });
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next === "abort" || next.done) break;
        const value = next.value;
        if (isTrackedEnvelope(value)) {
          const [eventId, data] = value as TrackedEnvelope<unknown>;
          send(JSON.stringify({ id, jsonrpc: "2.0", result: { type: "data", id: eventId, data: { id: eventId, data } } }));
        } else {
          send(JSON.stringify({ id, jsonrpc: "2.0", result: { type: "data", data: value } }));
        }
      }
      await iterator.return?.();
      if (!abort.signal.aborted) send(JSON.stringify({ id, jsonrpc: "2.0", result: { type: "stopped" } }));
    } catch (cause) {
      log.error("rpc:err", `✗ ${path} — ${cause instanceof Error ? cause.message : String(cause)}`);
      sendError(cause);
      await iterator.return?.().catch(() => undefined);
    }
  }

  function handlePlaintextMessage(clientId: string, raw: string): void {
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      sendRelayMessage(clientId, JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    const send = (json: string) => {
      sendRelayMessage(clientId, json);
    };

    if (isTRPCMessage(req)) {
      void dispatchTRPC(req, send);
    } else {
      void handleRPC(bridge, req, undefined).then((res) => send(JSON.stringify(res)));
    }
  }

  function handleIncomingRPC(peer: RelayPeerState, message: string): void {
    let req;
    try {
      req = JSON.parse(message);
    } catch {
      if (peer.admitted && securePeers.get(peer.clientId) === peer && peer.transport.isReady()) {
        peer.transport.send(
          JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }),
        );
      }
      return;
    }

    const send = (json: string) => {
      if (peer.admitted && securePeers.get(peer.clientId) === peer && peer.transport.isReady()) {
        peer.transport.send(json);
      }
    };

    if (isTRPCMessage(req)) {
      void dispatchTRPC(req, send, {
        deviceId: peer.deviceId,
        credentialBinding: peer.credentialBinding,
        secureTransport: true,
        trustedPeer: peer.trustedPeer,
        reconnectRoom: options.reconnectRoom,
        relayUrls: [qrPayload.relay, ...(qrPayload.fallbackRelays ?? [])],
      }, peer.subscriptions);
    } else {
      void handleRPC(bridge, req, {
        deviceId: peer.deviceId,
        credentialBinding: peer.credentialBinding,
        secureTransport: true,
        trustedPeer: peer.trustedPeer,
      }).then((res) => send(JSON.stringify(res)));
    }
  }

  function isTRPCMessage(req: any): boolean {
    return req.jsonrpc === "2.0" && ["query", "mutation", "subscription", "subscription.stop"].includes(req.method);
  }

  function sendRelayMessage(clientId: string, data: string | Uint8Array): void {
    const payload = asStringPayload(data);
    if (!payload || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({
      phase: "relay",
      event: "message",
      clientId,
      payload,
    } satisfies RelayEnvelope));
  }

  function sendRelayClose(clientId: string, code: number, reason: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({
      phase: "relay",
      event: "close",
      clientId,
      code,
      reason,
    } satisfies RelayEnvelope));
  }

  function cleanup(): void {
    eventUnsub?.();
    eventUnsub = null;
    brokerWatchAbort?.abort();
    brokerWatchAbort = null;
    for (const peer of securePeers.values()) {
      peer.admitted = false;
      peer.awaitingAdmission?.abort();
      for (const subscription of peer.subscriptions.values()) subscription.abort();
      peer.subscriptions.clear();
    }
    securePeers.clear();
    plaintextClients.clear();
    ws = null;
  }

  function scheduleReconnect(): void {
    if (retired) { disconnect(); return; }
    if (stopped) return;

    console.log(`[relay-client] reconnecting in ${backoff}ms...`);
    events?.onReconnectScheduled?.({ relayUrl: eventRelayUrl, room: qrPayload.room, delayMs: backoff });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);

    backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
  }

  function disconnect(): void {
    if (stopped) return;
    stopped = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const activeWs = ws;
    cleanup();
    activeWs?.close(1000, "Bridge disconnecting");
    onRetiredEmpty?.();
    onRetiredEmpty = undefined;
    console.log("[relay-client] disconnected from relay");
  }

  function retire(onEmpty?: () => void): void {
    if (stopped) { onEmpty?.(); return; }
    onRetiredEmpty = onEmpty;
    retired = true;
    // In-flight unauthenticated handshakes must not hold a retired room open.
    for (const [clientId, peer] of securePeers) {
      if (!peer.admitted) {
        sendRelayClose(clientId, 4003, "Untrusted peer");
        teardownSecurePeer(clientId);
      }
    }
    if (securePeers.size === 0) disconnect();
  }

  connect();

  return { qrPayload, disconnect, retire };
}

function relayWebSocketOptions(
  relayUrl: string,
): Bun.WebSocketOptions | undefined {
  if (!relayUrl.startsWith("wss://")) {
    return undefined;
  }

  return {
    tls: {
      rejectUnauthorized: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRelayUrl(baseUrl: string, roomId: string, bridgePublicKey?: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("room", roomId);
  url.searchParams.set("role", "bridge");
  if (bridgePublicKey) {
    url.searchParams.set("key", bridgePublicKey);
  } else {
    url.searchParams.delete("key");
  }
  return url.toString();
}

function detectHandshakePattern(payload: string): "XX" | "IK" | null {
  try {
    const wire = JSON.parse(payload) as { phase?: string; payload?: string };
    if (wire.phase !== "handshake" || typeof wire.payload !== "string") {
      return null;
    }
    const handshakePayload = Uint8Array.from(atob(wire.payload), (char) => char.charCodeAt(0));
    return handshakePayload.length > 32 ? "IK" : "XX";
  } catch {
    return null;
  }
}

function parseRelayEnvelope(raw: unknown): RelayEnvelope | null {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RelayEnvelope>;
    if (parsed.phase !== "relay" || typeof parsed.clientId !== "string") {
      return null;
    }
    if (parsed.event !== "message" && parsed.event !== "close") {
      return null;
    }
    return {
      phase: "relay",
      event: parsed.event,
      clientId: parsed.clientId,
      payload: typeof parsed.payload === "string" ? parsed.payload : undefined,
      code: typeof parsed.code === "number" ? parsed.code : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

function asStringPayload(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return new TextDecoder().decode(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw));
  }
  return null;
}
