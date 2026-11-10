// Encrypted transport — wraps a WebSocket connection with Noise encryption.
//
// Usage from the bridge side:
//   1. Client connects via WebSocket
//   2. Bridge creates a SecureTransport with its static key
//   3. Handshake messages exchange automatically
//   4. Once complete, all subsequent messages are encrypted/decrypted transparently
//
// Wire format:
//   Binary frames with a 1-byte tag prefix:
//     0x01 + payload → handshake message
//     0x02 + payload → transport (encrypted application data)
//
//   Legacy JSON format is still accepted on receive for backward compat:
//     { phase: "handshake", payload: "<base64>" }
//     { phase: "transport", payload: "<base64>" }

import {
  NoiseHandshake,
  type KeyPair,
  type NoiseSession,
  type HandshakePattern,
  type Role,
} from "./noise.js";
import { saveTrustedPeer, refreshTrustedPeer, loadTrustedPeers, bytesToHex } from "./identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Binary wire tags
const TAG_HANDSHAKE = 0x01;
const TAG_TRANSPORT = 0x02;

// Legacy JSON format (accepted on receive for backward compat)
interface WireMessage {
  phase: "handshake" | "transport";
  payload: string; // base64
}

export interface SecureTransportEvents {
  /** Handshake complete — transport is ready for encrypted messages. */
  onReady?: (remotePublicKey: Uint8Array, info: SecureTransportReadyInfo) => void;
  /** Decrypted application message received. */
  onMessage?: (message: string) => void;
  /** Error during handshake or transport. */
  onError?: (error: Error) => void;
  /** Connection closed. */
  onClose?: () => void;
}

export interface SecureTransportReadyInfo {
  remotePublicKeyHex: string;
  /** True only when this peer was already in the trust store before this handshake. */
  wasTrustedPeer: boolean;
  /** True when this handshake left the peer trusted, either pre-existing or newly paired. */
  trustedPeer: boolean;
  /** True when this transport was allowed to persist a new trust record. */
  trustedOnComplete: boolean;
}

// Minimal WebSocket interface — works with both Bun.serve sockets and client WebSockets.
export interface SocketLike {
  send(data: string | Uint8Array): void;
}

// ---------------------------------------------------------------------------
// SecureTransport
// ---------------------------------------------------------------------------

export class SecureTransport {
  private handshake: NoiseHandshake;
  private session: NoiseSession | null = null;
  private socket: SocketLike;
  private events: SecureTransportEvents;
  private trustOnComplete: boolean;
  private skipTrustWrite: (remotePublicKeyHex: string) => boolean;
  private ready = false;

  constructor(
    socket: SocketLike,
    role: Role,
    staticKey: KeyPair,
    events: SecureTransportEvents,
    options?: {
      pattern?: HandshakePattern;
      remoteStaticKey?: Uint8Array;
      trustOnComplete?: boolean;
      /** Leave the trust store untouched for this peer, not even lastSeen. */
      skipTrustWrite?: (remotePublicKeyHex: string) => boolean;
    },
  ) {
    this.socket = socket;
    this.events = events;
    this.trustOnComplete = options?.trustOnComplete ?? true;
    this.skipTrustWrite = options?.skipTrustWrite ?? (() => false);

    const pattern = options?.pattern ?? "XX";
    this.handshake = new NoiseHandshake(pattern, role, staticKey, options?.remoteStaticKey);

    // If it's our turn to send first, kick off the handshake.
    if (this.handshake.isMySend()) {
      this.sendHandshakeMessage();
    }
  }

  /** Feed an incoming WebSocket message into the transport. */
  receive(raw: string | Uint8Array): void {
    try {
      // Binary frame: 1-byte tag + payload
      if (typeof raw !== "string") {
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
        if (bytes.length < 2) return;
        const tag = bytes[0];
        const payload = bytes.subarray(1);
        if (tag === TAG_HANDSHAKE) {
          this.handleHandshakeMessage(payload);
        } else if (tag === TAG_TRANSPORT) {
          this.handleTransportMessage(payload);
        }
        return;
      }

      // Legacy JSON format (backward compat)
      const wire: WireMessage = JSON.parse(raw);
      if (wire.phase === "handshake") {
        this.handleHandshakeMessage(base64ToBytes(wire.payload));
      } else if (wire.phase === "transport") {
        this.handleTransportMessage(base64ToBytes(wire.payload));
      }
    } catch (err: any) {
      this.events.onError?.(err);
    }
  }

  /** Encrypt and send an application message. */
  send(message: string): void {
    if (!this.ready || !this.session) {
      throw new Error("SecureTransport: not ready (handshake incomplete)");
    }

    const plaintext = new TextEncoder().encode(message);
    const ciphertext = this.session.encrypt(plaintext);
    const wire: WireMessage = {
      phase: "transport",
      payload: bytesToBase64(ciphertext),
    };
    this.socket.send(JSON.stringify(wire));
  }

  /** True if the handshake is complete and messages can be sent. */
  isReady(): boolean {
    return this.ready;
  }

  // ---------------------------------------------------------------------------
  // Handshake
  // ---------------------------------------------------------------------------

  private sendHandshakeMessage(): void {
    const payload = this.handshake.writeMessage();
    const wire: WireMessage = {
      phase: "handshake",
      payload: bytesToBase64(payload),
    };
    this.socket.send(JSON.stringify(wire));

    if (this.handshake.isComplete()) {
      this.completeHandshake();
    }
  }

  private handleHandshakeMessage(message: Uint8Array): void {
    this.handshake.readMessage(message);

    if (this.handshake.isComplete()) {
      this.completeHandshake();
      return;
    }

    // Our turn to respond.
    if (this.handshake.isMySend()) {
      this.sendHandshakeMessage();
    }
  }

  private completeHandshake(): void {
    const session = this.handshake.finalize();
    const remotePublicKeyHex = bytesToHex(session.remoteStaticKey);
    const trustedPeers = loadTrustedPeers();
    const existingPeer = trustedPeers.get(remotePublicKeyHex);
    const wasTrustedPeer = Boolean(existingPeer);
    const trustedPeer = wasTrustedPeer || this.trustOnComplete;

    if (trustedPeer && !this.skipTrustWrite(remotePublicKeyHex)) {
      const now = new Date().toISOString();
      if (wasTrustedPeer) refreshTrustedPeer(remotePublicKeyHex, now);
      else saveTrustedPeer({ publicKey: remotePublicKeyHex, pairedAt: now, lastSeen: now });
    }

    // Authority failure must leave no usable session, even if the caller only
    // logs onError. Crypto completion alone cannot admit application traffic.
    this.session = session;
    this.ready = true;
    this.events.onReady?.(session.remoteStaticKey, {
      remotePublicKeyHex,
      wasTrustedPeer,
      trustedPeer,
      trustedOnComplete: this.trustOnComplete,
    });
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private handleTransportMessage(ciphertext: Uint8Array): void {
    if (!this.ready || !this.session) {
      this.events.onError?.(new Error("SecureTransport: received transport message before handshake"));
      return;
    }

    try {
      const plaintext = this.session.decrypt(ciphertext);
      const message = new TextDecoder().decode(plaintext);
      this.events.onMessage?.(message);
    } catch (err: any) {
      // Decrypt failure = stale session (peer using old keys after restart).
      // Signal error + close so the peer reconnects with a fresh handshake.
      this.events.onError?.(err);
      this.events.onClose?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers (using built-in btoa/atob)
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid stack overflow on large payloads.
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
