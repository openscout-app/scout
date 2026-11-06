import { pairingTrustOwner } from "./pairing-security/trust-owner.js";
/**
 * Sealed push content: the Mac encrypts an agent notification for one paired
 * phone so it can ride inside the push. The relay and APNs carry it without
 * being able to read it, and the phone's Notification Service Extension opens
 * it locally — no call back to the Mac, so a push reads the same whether or
 * not the Mac is reachable.
 *
 * Keys are the pairing keys both sides already hold: the Mac's static X25519
 * identity (~/.scout/pairing/identity.json) and the phone's static key from
 * its trusted-peer record. A push registration's deviceId is the first 16 hex
 * characters of that phone key, which is how a registration finds its peer.
 *
 * Envelope v1, base64url:
 *   0x01 ‖ macPublicKey (32) ‖ nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16)
 * key = HKDF-SHA256(X25519(mac, phone), salt "openscout.push.v1",
 *                   info macPublicKey ‖ phonePublicKey, 32 bytes)
 * AAD = the item id (UTF-8), so a sealed body can't be replayed under another id.
 *
 * Bytes 33… are exactly CryptoKit's `AES.GCM.SealedBox(combined:)` layout.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  clampAgentNotification,
  collapseAgentNotification,
  sealedAgentNotification,
  type AgentNotification,
} from "@openscout/protocol";
import { resolveOpenScoutPairingHome } from "./support-paths.js";

export const SEALED_PUSH_VERSION = 1;
const SALT = Buffer.from("openscout.push.v1", "utf8");
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + 32 + NONCE_BYTES;

export type PushSealingKeys = {
  macPublicKey: Uint8Array;
  macPrivateKey: Uint8Array;
};

function x25519(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
  if (privateKey.length !== 32 || publicKey.length !== 32) {
    throw new Error("X25519 keys must be 32 bytes");
  }
  return diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]), format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, publicKey]), format: "der", type: "spki" }),
  });
}

function deriveKey(shared: Buffer, macPublicKey: Uint8Array, phonePublicKey: Uint8Array): Buffer {
  const info = Buffer.concat([macPublicKey, phonePublicKey]);
  return Buffer.from(hkdfSync("sha256", shared, SALT, info, 32));
}

/** Seal UTF-8 plaintext (the notification JSON) for one phone. */
export function sealPushContent(input: {
  plaintext: string;
  itemId: string;
  keys: PushSealingKeys;
  phonePublicKey: Uint8Array;
}): string {
  const { keys, phonePublicKey } = input;
  const key = deriveKey(x25519(keys.macPrivateKey, phonePublicKey), keys.macPublicKey, phonePublicKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(input.itemId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([
    Buffer.from([SEALED_PUSH_VERSION]),
    keys.macPublicKey,
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]).toString("base64url");
}

/**
 * The phone's side, in TypeScript: used by tests and as the reference the
 * Swift extension mirrors. Throws when the envelope is malformed, from an
 * unexpected Mac, or fails authentication.
 */
export function openPushContent(input: {
  sealed: string;
  itemId: string;
  phonePrivateKey: Uint8Array;
  phonePublicKey: Uint8Array;
  expectedMacPublicKey?: Uint8Array;
}): string {
  const bytes = Buffer.from(input.sealed, "base64url");
  if (bytes.length < HEADER_BYTES + TAG_BYTES || bytes[0] !== SEALED_PUSH_VERSION) {
    throw new Error("Unsupported sealed push envelope");
  }
  const macPublicKey = bytes.subarray(1, 33);
  if (input.expectedMacPublicKey && !Buffer.from(input.expectedMacPublicKey).equals(macPublicKey)) {
    throw new Error("Sealed push is from an unexpected Mac");
  }
  const nonce = bytes.subarray(33, HEADER_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES);
  const key = deriveKey(x25519(input.phonePrivateKey, macPublicKey), macPublicKey, input.phonePublicKey);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(input.itemId, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Pairing keys on disk
// ---------------------------------------------------------------------------

/** This instance's pairing home (~/.scout/pairing for prod), where the pairing bridge keeps its keys. */
export function defaultPairingDir(): string {
  return resolveOpenScoutPairingHome();
}

function hexBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(Buffer.from(value, "hex"));
}

/** The Mac's pairing identity, or null when this Mac has never paired. */
export function loadPushSealingKeys(pairingDir = defaultPairingDir()): PushSealingKeys | null {
  const path = join(pairingDir, "identity.json");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { publicKey?: unknown; privateKey?: unknown };
    const macPublicKey = hexBytes(data.publicKey);
    const macPrivateKey = hexBytes(data.privateKey);
    return macPublicKey && macPrivateKey ? { macPublicKey, macPrivateKey } : null;
  } catch {
    return null;
  }
}

/**
 * The trusted phone behind a push registration: its deviceId is the first 16
 * hex characters of the phone's static key. Returns null when no trusted peer
 * matches, or when the prefix is ambiguous.
 */
export function findTrustedPhoneKeyForDevice(
  deviceId: string,
  pairingDir = defaultPairingDir(),
): Uint8Array | null {
  const prefix = deviceId.trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(prefix)) return null;
  const path = join(pairingDir, "trusted-peers.json");
  if (!existsSync(path)) return null;
  try {
    const peers = pairingTrustOwner(pairingDir).read().peers;
    const matches = peers
      .map((peer) => (typeof peer.publicKey === "string" ? peer.publicKey.toLowerCase() : ""))
      .filter((key) => key.startsWith(prefix));
    return matches.length === 1 ? hexBytes(matches[0]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent notifications
// ---------------------------------------------------------------------------

/** What the relay accepts for `sealed`; APNs caps the whole push at 4 KB. */
export const MAX_SEALED_PUSH_CHARS = 2800;

/**
 * Seal an agent notification for the phone behind one push registration.
 * Returns null when this Mac has no pairing identity or the device isn't a
 * trusted phone; the push then goes out with its generic text only. A record
 * too large for one push is sealed as its lock-screen text instead.
 */
export function sealAgentNotificationForDevice(
  notification: AgentNotification,
  deviceId: string,
  options: { keys?: PushSealingKeys | null; pairingDir?: string } = {},
): string | null {
  const keys = options.keys === undefined ? loadPushSealingKeys(options.pairingDir) : options.keys;
  if (!keys) return null;
  const phonePublicKey = findTrustedPhoneKeyForDevice(deviceId, options.pairingDir);
  if (!phonePublicKey) return null;

  const seal = (record: AgentNotification) => sealPushContent({
    plaintext: JSON.stringify(sealedAgentNotification(record)),
    itemId: record.itemId,
    keys,
    phonePublicKey,
  });
  const collapsed = collapseAgentNotification(notification);
  const { v, itemId, sender, project, host, level, createdAt, route } = notification;
  const asText = (body?: string): AgentNotification => ({
    v, itemId, sender, project, host, level, createdAt, route,
    view: "text",
    title: collapsed.headline,
    ...(body ? { body } : {}),
  });
  const detail = collapsed.body.replace(/\n/g, " ").slice(0, 200);

  // Richest first; each rung drops detail until the envelope fits one push.
  for (const record of [notification, asText(detail), asText()]) {
    const sealed = seal(clampAgentNotification(record));
    if (sealed.length <= MAX_SEALED_PUSH_CHARS) return sealed;
  }
  return null;
}
