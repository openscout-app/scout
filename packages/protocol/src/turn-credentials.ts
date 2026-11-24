/**
 * Turn credentials: what the runtime hands an agent when it dispatches a turn
 * for an ask, so the agent can prove which turn an action belongs to.
 *
 * The runtime signs the claims with its node key (Ed25519). Anyone who knows
 * that node's public key can check the signature and expiry offline, with
 * WebCrypto: a Worker, a browser, another host. Only the issuing runtime can
 * also check that the turn is still live (its flight has not ended).
 *
 * Wire form: `st1.<base64url canonical-JSON claims>.<base64url signature>`.
 * The signature covers the claims' canonical JSON, UTF-8.
 */

import type { ScoutAttributionSource } from "./common.js";
import { isAccessAction, type AccessAction, type AccessTurn, type PrincipalPerson } from "./access-evaluator.js";

export const TURN_CREDENTIAL_PROTOCOL = "scout-turn/1" as const;
export const TURN_CREDENTIAL_PREFIX = "st1" as const;
/** Default lifetime. A turn's credential also dies with its flight on the issuing runtime. */
export const TURN_CREDENTIAL_TTL_MS = 60 * 60_000;
export const TURN_CREDENTIAL_MAX_TTL_MS = 2 * 60 * 60_000;
export const TURN_CREDENTIAL_CLOCK_SKEW_MS = 15_000;
export const TURN_CREDENTIAL_MAX_BYTES = 4096;
/** Invocation metadata key for the scope an ask requests for its turn: an array of access actions. */
export const TURN_SCOPE_METADATA_KEY = "accessScope" as const;

export type TurnCredentialClaims = {
  protocol: typeof TURN_CREDENTIAL_PROTOCOL;
  /** Unique per issued credential. */
  id: string;
  /** Key id of the issuing node's public key. */
  issuerKeyId: string;
  nodeId: string;
  invocationId: string;
  flightId: string;
  /** The agent the turn was dispatched to. */
  agentId: string;
  /** The root actor of the ask, and how the runtime knew it. */
  initiatorId: string;
  initiatorSource: ScoutAttributionSource;
  scope: AccessAction[];
  issuedAt: number;
  expiresAt: number;
};

const CLAIM_KEYS = ["protocol", "id", "issuerKeyId", "nodeId", "invocationId", "flightId", "agentId", "initiatorId", "initiatorSource", "scope", "issuedAt", "expiresAt"] as const;
const SOURCES: readonly ScoutAttributionSource[] = ["local-admin", "scoped", "system", "unverified"];

export class TurnCredentialError extends Error {
  constructor(readonly code: TurnCredentialErrorCode, message: string) { super(message); this.name = "TurnCredentialError"; }
}
export type TurnCredentialErrorCode =
  | "malformed_turn_credential"
  | "turn_credential_signature"
  | "turn_credential_expired"
  | "turn_credential_issuer"
  | "turn_not_live";

/** Canonical JSON: sorted keys, no whitespace. Byte-equal to the runtime's node-card form. */
export function turnCredentialCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(turnCredentialCanonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${turnCredentialCanonicalJson(record[key])}`).join(",")}}`;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2]! + ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 63]!;
  }
  return out;
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0, bits = 0;
  for (const character of value) {
    buffer = ((buffer << 6) | ALPHABET.indexOf(character)) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  // Reject non-zero padding bits so each byte string has one encoding.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return new Uint8Array(bytes);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/.test(value);
}

export function validateTurnCredentialClaims(value: unknown): asserts value is TurnCredentialClaims {
  const fail = (message: string): never => { throw new TurnCredentialError("malformed_turn_credential", message); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("claims must be an object");
  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims);
  if (keys.length !== CLAIM_KEYS.length || !keys.every((key) => (CLAIM_KEYS as readonly string[]).includes(key))) fail("unexpected or missing claim fields");
  if (claims.protocol !== TURN_CREDENTIAL_PROTOCOL) fail("unsupported turn credential protocol");
  for (const key of ["id", "issuerKeyId", "nodeId", "invocationId", "flightId", "agentId", "initiatorId"] as const) {
    if (!validId(claims[key])) fail(`invalid ${key}`);
  }
  if (!SOURCES.includes(claims.initiatorSource as ScoutAttributionSource)) fail("invalid initiatorSource");
  const scope = claims.scope;
  if (!Array.isArray(scope) || scope.length > 16 || !scope.every(isAccessAction) || new Set(scope).size !== scope.length) fail("invalid scope");
  const issuedAt = claims.issuedAt, expiresAt = claims.expiresAt;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
    || (expiresAt as number) <= (issuedAt as number)
    || (expiresAt as number) - (issuedAt as number) > TURN_CREDENTIAL_MAX_TTL_MS) fail("invalid lifetime");
}

/** The bytes a runtime signs for these claims. */
export function turnCredentialSigningInput(claims: TurnCredentialClaims): Uint8Array {
  return new TextEncoder().encode(turnCredentialCanonicalJson(claims));
}

/** Join claims and a raw Ed25519 signature into the wire form. */
export function encodeTurnCredential(claims: TurnCredentialClaims, signature: Uint8Array): string {
  validateTurnCredentialClaims(claims);
  return `${TURN_CREDENTIAL_PREFIX}.${bytesToBase64Url(turnCredentialSigningInput(claims))}.${bytesToBase64Url(signature)}`;
}

export type DecodedTurnCredential = { claims: TurnCredentialClaims; signedBytes: Uint8Array; signature: Uint8Array };

/** Parse the wire form. Checks shape and canonical encoding, not the signature or time. */
export function decodeTurnCredential(token: unknown): DecodedTurnCredential {
  const fail = (message: string): never => { throw new TurnCredentialError("malformed_turn_credential", message); };
  if (typeof token !== "string" || token.length > TURN_CREDENTIAL_MAX_BYTES) fail("turn credential must be a short string");
  const parts = (token as string).split(".");
  if (parts.length !== 3 || parts[0] !== TURN_CREDENTIAL_PREFIX) fail("not a scout turn credential");
  const signedBytes = base64UrlToBytes(parts[1]!);
  const signature = base64UrlToBytes(parts[2]!);
  if (!signedBytes || !signature || signature.length !== 64) fail("invalid turn credential encoding");
  let claims: unknown;
  try { claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signedBytes!)); } catch { fail("invalid turn credential claims"); }
  validateTurnCredentialClaims(claims);
  if (turnCredentialCanonicalJson(claims) !== new TextDecoder().decode(signedBytes!)) fail("turn credential claims are not canonical");
  return { claims: claims as TurnCredentialClaims, signedBytes: signedBytes!, signature: signature! };
}

export function checkTurnCredentialTime(claims: TurnCredentialClaims, now: number): void {
  if (claims.issuedAt > now + TURN_CREDENTIAL_CLOCK_SKEW_MS) throw new TurnCredentialError("turn_credential_expired", "turn credential is future-dated");
  if (!(now < claims.expiresAt)) throw new TurnCredentialError("turn_credential_expired", "turn credential has expired");
}

/**
 * Offline check with WebCrypto, for verifiers that are not the issuing
 * runtime: signature by the given node key (base64 SPKI DER), and time.
 * It cannot see whether the flight has ended; the issuing runtime can.
 */
export async function verifyTurnCredentialOffline(
  token: string,
  issuerPublicKeySpkiBase64: string,
  options: { now?: number; subtle?: SubtleCrypto } = {},
): Promise<TurnCredentialClaims> {
  const decoded = decodeTurnCredential(token);
  const subtle = options.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) throw new TurnCredentialError("turn_credential_signature", "WebCrypto is unavailable");
  const spki = base64ToBytes(issuerPublicKeySpkiBase64);
  if (!spki) throw new TurnCredentialError("turn_credential_issuer", "invalid issuer public key");
  let ok = false;
  try {
    const key = await subtle.importKey("spki", spki as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    ok = await subtle.verify({ name: "Ed25519" }, key, decoded.signature as BufferSource, decoded.signedBytes as BufferSource);
  } catch { ok = false; }
  if (!ok) throw new TurnCredentialError("turn_credential_signature", "turn credential signature does not verify");
  checkTurnCredentialTime(decoded.claims, options.now ?? Date.now());
  return decoded.claims;
}

function base64ToBytes(value: string): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  return base64UrlToBytes(value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
}

/** Turn verified claims into the evaluator's turn, with the initiator the caller resolved right now. */
export function accessTurnFromClaims(claims: TurnCredentialClaims, initiator: PrincipalPerson | null): AccessTurn {
  return { id: claims.id, agentId: claims.agentId, initiator, scope: claims.scope, expiresAt: claims.expiresAt };
}
