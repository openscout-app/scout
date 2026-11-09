import { canonicalMeshNodeId, stripBonjourCollisionSuffix } from "./node-identity-wire.js";
export * from "./node-identity-wire.js";
import type { NodeIdentity } from "./node-identity-wire.js";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  assertTestIsolatedUserData,
  resolveOpenScoutSupportPaths,
} from "./support-paths.js";

/**
 * Mesh trust cone v2 (docs/proposals/mesh-trust-cone.md): every node owns a
 * long-term Ed25519 identity. The private key never leaves the support
 * directory. Two derived identities have distinct roles:
 *
 * - key ID — full SHA-256 hex of the public key; the canonical machine
 *   identity (trusted_peers PK, signing header, replay-claim key).
 * - fingerprint — `osc1:xxxx-xxxx`, 40 bits, display-only; shown to humans
 *   during enrollment. Never used for lookup or authorization.
 */

export const NODE_IDENTITY_FILE = "node-identity.json";
const stableNodeQualifierCache = new Map<string, string>();

export function nodeIdentityPath(supportDirectory?: string): string {
  const dir = supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
  return join(dir, NODE_IDENTITY_FILE);
}

export function loadOrCreateNodeIdentity(supportDirectory?: string): NodeIdentity {
  const path = nodeIdentityPath(supportDirectory);
  if (existsSync(path)) {
    return readAndValidateNodeIdentity(path);
  }
  return createNodeIdentity(supportDirectory);
}

/** Read the existing host identity without minting a replacement key. */
export function readNodeIdentity(supportDirectory?: string): NodeIdentity | null {
  const path = nodeIdentityPath(supportDirectory);
  return existsSync(path) ? readAndValidateNodeIdentity(path) : null;
}

/**
 * Return the machine qualifier persisted with the long-term node key, creating
 * it from the current hostname only once. Display names may follow the live
 * hostname; routing authority must not.
 */
export function loadOrCreateStableNodeQualifier(
  fallbackName: string,
  supportDirectory?: string,
): string {
  const path = nodeIdentityPath(supportDirectory);
  const cached = stableNodeQualifierCache.get(path);
  if (cached) {
    return cached;
  }
  const identity = loadOrCreateNodeIdentity(supportDirectory);
  const existing = normalizeNodeQualifier(identity.nodeQualifier);
  if (existing) {
    if (identity.nodeQualifier !== existing) {
      persistNodeIdentity(path, {
        ...identity,
        nodeQualifier: existing,
      });
    }
    stableNodeQualifierCache.set(path, existing);
    return existing;
  }

  const nodeQualifier = normalizeNodeQualifier(fallbackName) || "local";
  persistNodeIdentity(path, {
    ...identity,
    nodeQualifier,
  });
  stableNodeQualifierCache.set(path, nodeQualifier);
  return nodeQualifier;
}

/** Read the stable qualifier without creating user state. */
export function readStableNodeQualifier(supportDirectory?: string): string | null {
  const path = nodeIdentityPath(supportDirectory);
  const cached = stableNodeQualifierCache.get(path);
  if (cached) {
    return cached;
  }
  if (!existsSync(path)) {
    return null;
  }
  const nodeQualifier = normalizeNodeQualifier(readAndValidateNodeIdentity(path).nodeQualifier);
  if (nodeQualifier) {
    stableNodeQualifierCache.set(path, nodeQualifier);
  }
  return nodeQualifier || null;
}

export function resolveStableLocalNodeId(input: {
  configuredNodeId?: string;
  nodeName: string;
  meshId: string;
  supportDirectory?: string;
}): string {
  const nodeQualifier = loadOrCreateStableNodeQualifier(input.nodeName, input.supportDirectory);
  const configuredNodeId = input.configuredNodeId?.trim();
  if (configuredNodeId) {
    return configuredNodeId;
  }
  const meshQualifier = normalizeNodeQualifier(input.meshId) || "openscout";
  return `${nodeQualifier}-${meshQualifier}`;
}

function readAndValidateNodeIdentity(path: string): NodeIdentity {
  let parsed: NodeIdentity;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as NodeIdentity;
  } catch {
    throw new Error(`Corrupt node identity at ${path}; remove it to generate a fresh one.`);
  }
  if (parsed.version !== 1 || !parsed.publicKey || !parsed.privateKey) {
    throw new Error(`Corrupt node identity at ${path}; remove it to generate a fresh one.`);
  }
  if (parsed.nodeQualifier !== undefined && normalizePersistedNodeQualifier(parsed.nodeQualifier) !== parsed.nodeQualifier) {
    throw new Error(`Corrupt node identity at ${path}; remove it to generate a fresh one.`);
  }
  // Verify the pair: re-derive the public key from the private key.
  try {
    const derived = createPublicKey(importPrivateKey(parsed.privateKey))
      .export({ type: "spki", format: "der" })
      .toString("base64");
    if (derived !== parsed.publicKey) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error(`Node identity at ${path} has mismatched or invalid keys; remove it to generate a fresh one.`);
  }
  return parsed;
}
function normalizePersistedNodeQualifier(value: unknown): string {
  return typeof value === "string"
    ? value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
    : "";
}


export function normalizeNodeQualifier(value: unknown): string {
  return stripBonjourCollisionSuffix(normalizePersistedNodeQualifier(value));
}

function persistNodeIdentity(path: string, identity: NodeIdentity): void {
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function createNodeIdentity(supportDirectory?: string): NodeIdentity {
  if (!supportDirectory) {
    assertTestIsolatedUserData("write the node identity", "OPENSCOUT_SUPPORT_DIRECTORY");
  }
  const path = nodeIdentityPath(supportDirectory);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity: NodeIdentity = {
    version: 1,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    createdAt: Date.now(),
  };
  mkdirSync(dirname(path), { recursive: true });
  try {
    // Exclusive create: a concurrent first-run can never replace an identity
    // that another process already started announcing.
    writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readAndValidateNodeIdentity(path);
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; mode on create already restrictive
  }
  return identity;
}


function importPrivateKey(privateKeyBase64: string) {
  return createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
}
