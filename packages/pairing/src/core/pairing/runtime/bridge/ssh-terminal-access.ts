import { createHash } from "crypto";

const SCOUT_AUTHORIZED_KEY_MARKER = "scout:terminal-access:v1";
const LEGACY_SCOUT_AUTHORIZED_KEY_MARKER = "scout:terminal-access:v0";
const SCOUT_AUTHORIZED_KEY_OPTIONS = "restrict,pty";

const SUPPORTED_IOS_PUBLIC_KEY_ALGORITHMS = new Set([
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-256",
  "rsa-sha2-512",
  "ssh-rsa",
]);

export type SshPublicKeyAlgorithm =
  | "ssh-ed25519"
  | "ecdsa-sha2-nistp256"
  | "ecdsa-sha2-nistp384"
  | "ecdsa-sha2-nistp521"
  | "rsa-sha2-256"
  | "rsa-sha2-512"
  | "ssh-rsa";

export interface ValidatedSshPublicKey {
  algorithm: SshPublicKeyAlgorithm;
  keyData: string;
  fingerprintSha256: string;
  normalizedPublicKey: string;
}

export interface SshTerminalAccessGrant {
  deviceId: string;
  sshPublicKey: ValidatedSshPublicKey;
  terminalSessionName?: string;
  pairingNoisePublicKey?: string;
  pairingNoiseFingerprintSha256?: string;
  authorizedKeyLine: string;
}

export interface SshTerminalAccessProvisionInput {
  authorizedKeys: string;
  deviceId: string;
  sshPublicKey: string;
  /** Tmux workspace assigned to this paired device. */
  terminalSessionName?: string;
  /**
   * Pairing Noise key that authorized this provisioning request. It is recorded
   * as an exact full-key-derived owner ID. Pairing revocation does not revoke
   * already-issued SSH credentials or terminate SSH/PTY sessions.
   */
  pairingNoisePublicKey: string;
}

export interface SshTerminalAccessProvisionResult {
  authorizedKeys: string;
  changed: boolean;
  grant: SshTerminalAccessGrant;
}

export interface SshTerminalAccessRevokeInput {
  authorizedKeys: string;
  /** Display metadata, never an owner selector. */
  deviceId?: string;
  pairingNoisePublicKey: string;
}

export interface SshTerminalAccessRevokeResult {
  authorizedKeys: string;
  changed: boolean;
  removed: number;
}

export interface SshHostKeyPin {
  algorithm: SshPublicKeyAlgorithm;
  fingerprintSha256: string;
  publicKey: string;
  source: "local-host-ssh-key";
}

export function validateIosGeneratedSshPublicKey(publicKey: string): ValidatedSshPublicKey {
  const fields = publicKey.trim().split(/\s+/);
  if (fields.length < 2) {
    throw new Error("SSH public key must include an algorithm and key data");
  }

  const [algorithm, keyData] = fields;
  // Accept every key-type family in the supported set below — not just the
  // `ssh-` prefix (ed25519/rsa). ecdsa keys announce `ecdsa-…`, rsa-sha2 keys
  // `rsa-…`; the authoritative gate is `isSupportedIosPublicKeyAlgorithm`.
  if (!/^(ssh|ecdsa|rsa)-/.test(algorithm)) {
    throw new Error("SSH public key algorithm is missing or invalid");
  }
  if (!isSupportedIosPublicKeyAlgorithm(algorithm)) {
    throw new Error(`Unsupported SSH public key algorithm: ${algorithm}`);
  }
  if (!isValidBase64KeyData(keyData)) {
    throw new Error("SSH public key data must be valid base64");
  }
  if (readSshWireString(Buffer.from(keyData, "base64"), 0)?.value !== algorithm) {
    throw new Error("SSH public key data does not match its declared algorithm");
  }

  return {
    algorithm,
    keyData,
    fingerprintSha256: fingerprintKeyData(keyData),
    normalizedPublicKey: `${algorithm} ${keyData}`,
  };
}

export function createSshHostKeyPin(publicKey: string): SshHostKeyPin {
  const validated = validateIosGeneratedSshPublicKey(publicKey);
  return {
    algorithm: validated.algorithm,
    fingerprintSha256: validated.fingerprintSha256,
    publicKey: validated.normalizedPublicKey,
    source: "local-host-ssh-key",
  };
}

export function provisionSshTerminalAccess(
  input: SshTerminalAccessProvisionInput,
): SshTerminalAccessProvisionResult {
  const deviceId = fullNoiseKey(input.pairingNoisePublicKey);
  const sshPublicKey = validateIosGeneratedSshPublicKey(input.sshPublicKey);
  const pairingNoiseFingerprintSha256 = credentialOwnerId(deviceId);
  const grant: SshTerminalAccessGrant = {
    deviceId,
    sshPublicKey,
    terminalSessionName: input.terminalSessionName,
    pairingNoisePublicKey: input.pairingNoisePublicKey?.trim(),
    pairingNoiseFingerprintSha256,
    authorizedKeyLine: createScoutAuthorizedKeyLine({
      deviceId,
      sshPublicKey,
      terminalSessionName: input.terminalSessionName,
      pairingNoiseFingerprintSha256,
    }),
  };

  const withoutExistingDeviceGrant = removeScoutAuthorizedKeysForDevice(
    splitAuthorizedKeys(input.authorizedKeys),
    deviceId,
  );
  const nextLines = [...withoutExistingDeviceGrant.lines, grant.authorizedKeyLine];
  const nextAuthorizedKeys = joinAuthorizedKeyLines(nextLines);

  return {
    authorizedKeys: nextAuthorizedKeys,
    changed: normalizeAuthorizedKeys(input.authorizedKeys) !== nextAuthorizedKeys,
    grant,
  };
}

export function revokeSshTerminalAccess(
  input: SshTerminalAccessRevokeInput,
): SshTerminalAccessRevokeResult {
  const deviceId = fullNoiseKey(input.pairingNoisePublicKey);
  const removal = removeScoutAuthorizedKeysForDevice(
    splitAuthorizedKeys(input.authorizedKeys),
    deviceId,
  );
  const authorizedKeys = joinAuthorizedKeyLines(removal.lines);
  return {
    authorizedKeys,
    changed: removal.removed > 0,
    removed: removal.removed,
  };
}

/** A full authenticated Noise key is required; a display prefix is never authority. */
export function credentialOwnerId(publicKey: string): string {
  return fingerprintUtf8(fullNoiseKey(publicKey));
}

export class SshCredentialOwnershipReviewRequired extends Error {
  constructor() {
    super("SSH credential ownership requires local review of the existing grant before re-provisioning; re-pairing alone is insufficient");
    this.name = "SshCredentialOwnershipReviewRequired";
  }
}

export function isScoutManagedAuthorizedKeyForDevice(line: string, publicKey: string): boolean {
  return ownsRecord(line, fullNoiseKey(publicKey));
}

/** No implicit `scout` fallback: missing session provenance remains unknown. */
export function findSshTerminalSessionForDevice(authorizedKeys: string, publicKey: string): string | undefined {
  const key = fullNoiseKey(publicKey), sessions = new Set<string>();
  for (const line of splitAuthorizedKeys(authorizedKeys)) {
    if (!ownsRecord(line, key)) continue;
    const marker = parseScoutAuthorizedKeyMarker(line)!;
    const session = marker.fields.get("session")?.[0];
    if (session) {
      const decoded = decodeMarkerValue(session);
      if (!decoded) throw new SshCredentialOwnershipReviewRequired();
      sessions.add(decoded);
    }
  }
  if (sessions.size > 1) throw new SshCredentialOwnershipReviewRequired();
  return sessions.values().next().value;
}

function createScoutAuthorizedKeyLine(input: {
  deviceId: string;
  sshPublicKey: ValidatedSshPublicKey;
  terminalSessionName?: string;
  pairingNoiseFingerprintSha256?: string;
}): string {
  const markerFields = [
    SCOUT_AUTHORIZED_KEY_MARKER,
    `owner=${credentialOwnerId(input.deviceId)}`,
    `ssh=${input.sshPublicKey.fingerprintSha256}`,
  ];
  if (input.terminalSessionName) markerFields.push(`session=${encodeMarkerValue(input.terminalSessionName)}`);
  return `${SCOUT_AUTHORIZED_KEY_OPTIONS} ${input.sshPublicKey.normalizedPublicKey} ${markerFields.join(" ")}`;
}

function removeScoutAuthorizedKeysForDevice(lines: string[], publicKey: string): {lines: string[]; removed: number} {
  const retained: string[] = []; let removed = 0;
  for (const line of lines) {
    if (ownsRecord(line, fullNoiseKey(publicKey))) removed++;
    else retained.push(line);
  }
  return {lines: retained, removed};
}

type Marker = {version: "v0" | "v1"; fields: Map<string, string[]>};
function parseScoutAuthorizedKeyMarker(line: string): Marker | null {
  const fields = line.trim().split(/\s+/);
  // A marker in an unrelated comment is not a managed SSH grant.
  if (fields[0] !== SCOUT_AUTHORIZED_KEY_OPTIONS || fields.length < 4) return null;
  const version = fields[3] === SCOUT_AUTHORIZED_KEY_MARKER ? "v1"
    : fields[3] === LEGACY_SCOUT_AUTHORIZED_KEY_MARKER ? "v0" : null;
  if (!version) return null;
  try { validateIosGeneratedSshPublicKey(`${fields[1]} ${fields[2]}`); } catch { return null; }
  const values = new Map<string, string[]>();
  for (const field of fields.slice(4)) {
    const separator = field.indexOf("=");
    if (separator < 1) continue;
    const name = field.slice(0, separator), value = field.slice(separator + 1);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return {version, fields: values};
}

function ownsRecord(line: string, publicKey: string): boolean {
  const marker = parseScoutAuthorizedKeyMarker(line);
  if (!marker) return false;
  const owner = credentialOwnerId(publicKey), fields = marker.fields;
  const devices = (fields.get("device") ?? []).map(decodeMarkerValue);
  const candidate = devices.some(device => device && /^[a-f0-9]{1,64}$/.test(device) && publicKey.startsWith(device));
  const claims = [...(fields.get("owner") ?? []), ...(fields.get("pairing") ?? [])];
  if ([...fields.values()].some(values => values.length !== 1)) {
    if (candidate || claims.includes(owner)) throw new SshCredentialOwnershipReviewRequired();
    return false;
  }
  if (marker.version === "v1") return fields.get("owner")?.[0] === owner;
  const device = devices[0], pairing = fields.get("pairing")?.[0];
  if (device && /^[a-f0-9]{64}$/.test(device)) {
    if (pairing && pairing !== "unbound" && pairing !== credentialOwnerId(device)) {
      if (candidate || pairing === owner) throw new SshCredentialOwnershipReviewRequired();
      return false;
    }
    return device === publicKey;
  }
  if (pairing === owner) {
    if (device && /^[a-f0-9]{1,63}$/.test(device) && !candidate) throw new SshCredentialOwnershipReviewRequired();
    return true; // Established by the full authenticated key's exact fingerprint.
  }
  if (candidate && (!pairing || pairing === "unbound" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(pairing))) {
    throw new SshCredentialOwnershipReviewRequired();
  }
  return false; // Never migrate/remove a foreign or unestablished owner.
}

function fullNoiseKey(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Full Noise key required for credential ownership");
  return value;
}

function splitAuthorizedKeys(authorizedKeys: string): string[] {
  if (authorizedKeys.length === 0) return [];
  const lines = authorizedKeys
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function joinAuthorizedKeyLines(lines: string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function normalizeAuthorizedKeys(authorizedKeys: string): string {
  return joinAuthorizedKeyLines(splitAuthorizedKeys(authorizedKeys));
}

function isSupportedIosPublicKeyAlgorithm(
  algorithm: string,
): algorithm is SshPublicKeyAlgorithm {
  return SUPPORTED_IOS_PUBLIC_KEY_ALGORITHMS.has(algorithm);
}

function isValidBase64KeyData(keyData: string): boolean {
  try {
    const decoded = Buffer.from(keyData, "base64");
    return decoded.length > 0
      && decoded.toString("base64").replace(/=+$/, "") === keyData.replace(/=+$/, "");
  } catch {
    return false;
  }
}

function readSshWireString(
  buffer: Buffer,
  offset: number,
): { value: string; nextOffset: number } | null {
  if (offset + 4 > buffer.length) return null;
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > buffer.length) return null;
  return {
    value: buffer.subarray(start, end).toString("utf8"),
    nextOffset: end,
  };
}

function fingerprintKeyData(keyData: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(keyData, "base64")).digest("base64").replace(/=+$/, "")}`;
}

function fingerprintUtf8(value: string): string {
  return `SHA256:${createHash("sha256").update(value, "utf8").digest("base64").replace(/=+$/, "")}`;
}

function encodeMarkerValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeMarkerValue(value: string): string | undefined {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return encodeMarkerValue(decoded) === value ? decoded : undefined;
}
