import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PEER_AUTH_MAX_SKEW_MS, PRE_BOOT_GRACE_MS, peerRequestSigningPayload, sha256Hex, type PeerNonceClaim } from "./mesh-peer-auth.js";
import type { RuntimeHttpHeaders } from "./portable-types.js";

export const LOCAL_ADMIN_HEADER = "x-openscout-local-admin";
/** Explicit opt-in only. Never create or print a credential at broker startup. */
export function readLocalAdminKey(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("local administration key requires an owner-only regular file");
    const value = readFileSync(fd, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("local administration key must be 32 random bytes in lowercase hex");
    return value;
  } finally { closeSync(fd); }
}
export const LOCAL_ADMIN_HEADERS = {
  signature: LOCAL_ADMIN_HEADER,
  ts: "x-openscout-local-admin-ts",
  nonce: "x-openscout-local-admin-nonce",
} as const;
export type LocalAdminRequestInput = {
  method: string;
  path: string;
  body?: Buffer | string;
  destinationKeyId: string;
};
function localAdminPayload(input: LocalAdminRequestInput & { ts: number; nonce: string }): string {
  return ["local-admin:v1", ...peerRequestSigningPayload({ ...input, bodySha256Hex: sha256Hex(input.body ?? "") }).split("\n").slice(1)].join("\n");
}
function localAdminMac(key: string, payload: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid local administration key");
  return createHmac("sha256", Buffer.from(key, "hex")).update(payload).digest("hex");
}
/** The key never crosses the wire. The MAC binds target, contents and freshness. */
export function signLocalAdminRequest(key: string, input: LocalAdminRequestInput & { ts?: number; nonce?: string }): Record<string, string> {
  const ts = input.ts ?? Date.now(), nonce = input.nonce ?? randomBytes(16).toString("base64");
  if (!Number.isSafeInteger(ts) || !/^[A-Za-z0-9+/=_-]{16,128}$/.test(nonce)) throw new Error("invalid local administration request freshness");
  return {
    [LOCAL_ADMIN_HEADERS.signature]: localAdminMac(key, localAdminPayload({ ...input, ts, nonce })),
    [LOCAL_ADMIN_HEADERS.ts]: String(ts),
    [LOCAL_ADMIN_HEADERS.nonce]: nonce,
  };
}
export function verifyLocalAdminRequest(key: string, input: LocalAdminRequestInput & {
  headers: RuntimeHttpHeaders;
  bootedAt: number;
  nonceClaim: PeerNonceClaim;
  now?: number;
  maxSkewMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  const mac = input.headers[LOCAL_ADMIN_HEADERS.signature], ts = input.headers[LOCAL_ADMIN_HEADERS.ts], nonce = input.headers[LOCAL_ADMIN_HEADERS.nonce];
  if (typeof mac !== "string" || !/^[a-f0-9]{64}$/.test(mac) || typeof ts !== "string" || !/^\d{1,16}$/.test(ts)
    || typeof nonce !== "string" || !/^[A-Za-z0-9+/=_-]{16,128}$/.test(nonce)) return { ok: false, reason: "missing or malformed local administration proof" };
  const timestamp = Number(ts), now = input.now ?? Date.now(), maxSkewMs = input.maxSkewMs ?? PEER_AUTH_MAX_SKEW_MS;
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(now) || Math.abs(now - timestamp) > maxSkewMs) return { ok: false, reason: "timestamp outside acceptable skew" };
  if (!Number.isFinite(input.bootedAt) || timestamp < input.bootedAt - PRE_BOOT_GRACE_MS) return { ok: false, reason: "timestamp predates broker boot" };
  try {
    const expected = localAdminMac(key, localAdminPayload({ ...input, ts: timestamp, nonce }));
    if (!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))) return { ok: false, reason: "invalid local administration MAC" };
  } catch { return { ok: false, reason: "invalid local administration signing context" }; }
  if (!input.nonceClaim.claim(`local-admin:${input.destinationKeyId}`, nonce, now)) return { ok: false, reason: "local administration nonce replay" };
  return { ok: true };
}

/**
 * Operator attribution key that `scout setup` creates. The runtime verifies
 * operator-only requests with it; only the operator's own surfaces (scout-web,
 * pairing) receive its path, and they read it into memory at startup and drop
 * the variable, so agents they spawn never inherit it.
 */
export const OPERATOR_ATTRIBUTION_KEY_FILE_NAME = "operator-attribution.key";

export function defaultOperatorAttributionKeyFile(supportDirectory: string): string {
  return join(supportDirectory, "runtime", OPERATOR_ATTRIBUTION_KEY_FILE_NAME);
}

/** Setup step, never broker startup: create the key once as an owner-only file. */
export function ensureOperatorAttributionKey(supportDirectory: string): { file: string; created: boolean } {
  const file = defaultOperatorAttributionKeyFile(supportDirectory);
  mkdirSync(join(supportDirectory, "runtime"), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
    return { file, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { file, created: false };
  }
}

/** Explicit OPENSCOUT_ATTRIBUTION_KEY_FILE first, then the setup key when it exists. Never creates one. */
export function resolveOperatorAttributionKeyFile(
  env: Record<string, string | undefined>,
  supportDirectory: string,
): { file: string; explicit: boolean } | undefined {
  const explicit = env.OPENSCOUT_ATTRIBUTION_KEY_FILE?.trim();
  if (explicit) return { file: explicit, explicit: true };
  const fallback = defaultOperatorAttributionKeyFile(supportDirectory);
  return existsSync(fallback) ? { file: fallback, explicit: false } : undefined;
}

/** Persist before serving any policy, so forgetting the opt-in cannot reopen
 * ambient local authority over previously scoped resources on next restart. */
export function preserveProtectedIngress(supportDirectory: string, key: string | undefined): void {
  const marker = join(supportDirectory, "mesh-access-protected-ingress.v1");
  if (!key) {
    if (existsSync(marker)) throw new Error("protected ingress was previously enabled; OPENSCOUT_LOCAL_ADMIN_KEY_FILE is required");
    return;
  }
  mkdirSync(supportDirectory, { recursive: true });
  try { writeFileSync(marker, "scout-access/1 protected local ingress\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
