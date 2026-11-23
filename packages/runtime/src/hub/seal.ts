/**
 * Scout Hub chunk sealing. A reporter inside a vendor sandbox seals each chunk
 * of transcript bytes to the runtime's public key; the inbox stores the sealed
 * bytes and cannot read them; the runtime opens them.
 *
 * Envelope v1 (raw bytes):
 *   0x01 ‖ ephemeralPublicKey (32) ‖ nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16)
 * key = HKDF-SHA256(X25519(ephemeral, recipient), salt "openscout.hub.v1",
 *                   info ephemeralPublicKey ‖ recipientPublicKey, 32 bytes)
 * AAD = "openscout.hub.v1"
 *
 * Plaintext: u32be headerLength ‖ header JSON (UTF-8) ‖ data.
 *
 * Sealing gives confidentiality only. The recipient key is public (it sits in
 * the repo next to the reporter), so a chunk proves nothing about who sent it:
 * the collector validates every header before it writes anything.
 *
 * The reporter (reporter-source.ts) carries its own copy of this code, because
 * it must run as one dependency-free file. Tests check the two agree.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export const HUB_ENVELOPE_VERSION = 1;
const LABEL = Buffer.from("openscout.hub.v1", "utf8");
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + 32 + NONCE_BYTES;

export type HubKeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

export type HubChunkHeader = {
  v: 1;
  kind: "claude-code.transcript";
  /** Claude's session id (the transcript's file name). */
  sessionId: string;
  /** CLAUDE_CODE_REMOTE_SESSION_ID when the sandbox sets it. */
  remoteSessionId: string | null;
  /** Folder name the mirror files this session under, usually the repo name. */
  label: string;
  /** Path relative to the project folder: `<session>.jsonl` or `<session>/subagents/…/agent-<id>.jsonl`. */
  file: string;
  /** Byte offset in the source file where `data` starts. */
  offset: number;
  /** Per-file sequence number, from 0. */
  seq: number;
  cwd: string | null;
  sentAt: string;
};

export type OpenedHubChunk = { header: HubChunkHeader; data: Buffer };

export function generateHubKeyPair(): HubKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  return {
    publicKey: Uint8Array.from(spki.subarray(spki.length - 32)),
    privateKey: Uint8Array.from(pkcs8.subarray(pkcs8.length - 32)),
  };
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  const key = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]), format: "der", type: "pkcs8" }));
  const spki = key.export({ format: "der", type: "spki" });
  return Uint8Array.from(spki.subarray(spki.length - 32));
}

function x25519(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
  if (privateKey.length !== 32 || publicKey.length !== 32) throw new Error("X25519 keys must be 32 bytes");
  return diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]), format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, publicKey]), format: "der", type: "spki" }),
  });
}

function deriveKey(shared: Buffer, ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, LABEL, Buffer.concat([ephemeralPublicKey, recipientPublicKey]), 32));
}

export function frameChunk(header: HubChunkHeader, data: Uint8Array): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  return Buffer.concat([length, head, data]);
}

/** Seal a chunk for the runtime. The runtime only opens; this is for tests and tools. */
export function sealHubChunk(header: HubChunkHeader, data: Uint8Array, recipientPublicKey: Uint8Array): Buffer {
  const ephemeral = generateHubKeyPair();
  const key = deriveKey(x25519(ephemeral.privateKey, recipientPublicKey), ephemeral.publicKey, recipientPublicKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(LABEL);
  const ciphertext = Buffer.concat([cipher.update(frameChunk(header, data)), cipher.final()]);
  return Buffer.concat([Buffer.from([HUB_ENVELOPE_VERSION]), ephemeral.publicKey, nonce, ciphertext, cipher.getAuthTag()]);
}

/** Open a sealed chunk. Throws when the envelope is malformed or fails authentication. */
export function openHubChunk(sealed: Uint8Array, keys: HubKeyPair): OpenedHubChunk {
  const bytes = Buffer.from(sealed);
  if (bytes.length < HEADER_BYTES + TAG_BYTES || bytes[0] !== HUB_ENVELOPE_VERSION) {
    throw new Error("Unsupported Scout Hub envelope");
  }
  const ephemeralPublicKey = bytes.subarray(1, 33);
  const nonce = bytes.subarray(33, HEADER_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES);
  const key = deriveKey(x25519(keys.privateKey, ephemeralPublicKey), ephemeralPublicKey, keys.publicKey);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(LABEL);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plain.length < 4) throw new Error("Scout Hub chunk is too short");
  const headerLength = plain.readUInt32BE(0);
  if (headerLength > 64 * 1024 || 4 + headerLength > plain.length) throw new Error("Scout Hub chunk header is malformed");
  const header = JSON.parse(plain.subarray(4, 4 + headerLength).toString("utf8")) as HubChunkHeader;
  return { header, data: plain.subarray(4 + headerLength) };
}
