import {
  signLocalAdminRequest,
  readLocalAdminKey,
  nodeFingerprint,
  verifySignedNodeCard,
  type SignedNodeCard,
  type NodeIdentity,
  PRE_BOOT_GRACE_MS,
  signScopedPeerRequest,
  ACCESS_PROTOCOL,
  ACCESS_POLICY_TTL_MS,
  ACCESS_ARTIFACT_MAX_BYTES,
  accessKeyId,
  signAccessArtifact,
  validateAccessPolicy,
  validateAccessGrant,
  validateAccessDelegation,
  validateAccessScope,
  validateAccessRevocation,
  type AccessPrincipal,
  type AccessPolicy,
  type AccessGrant,
  type AccessDelegation,
  type AccessRevocation,
} from "@openscout/runtime/mesh";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createPinnedHttpsClient, type PinnedHttpsClient } from "@openscout/runtime/mesh/pinned-https-client";
import type { ScoutCommandContext } from "./cli-context.ts";
import { ScoutCliError } from "./cli-context.ts";
import { runtimeFetch, resolveScoutBrokerUrl } from "./cli-context.ts";

export const MESH_ACCESS_HELP = `scout mesh access — scoped person and service access (v1)

Offline keys and signed public artifacts:
  admin-key create --file <new-private-key-file>
  identity create --directory <new-dir> --kind person|service --label <name>
  device create --directory <new-dir>
  network create --identity <identity.json> --label <name> --out <policy.json>
  policy sign --identity <identity.json> --file <unsigned.json> --out <policy.json>
  delegate --identity <identity.json> --policy <policy.json> --file <unsigned.json> --out <delegation.json>
  grant sign --identity <identity.json> --policy <policy.json> --file <unsigned.json> --out <grant.json>
  revocation sign --identity <identity.json> --file <unsigned.json> --out <revocation.json>
  inspect --file <artifact.json>
  verify --file <artifact.json> [--policy <policy.json>]

Local broker administration (loopback only; add --admin-key <private-key-file> in protected mode):
  status [--broker <url>]
  import --file <policy-grant-delegation-or-revocation.json> [--broker <url>]
  enroll --file <enrollment.json> [--broker <url>]
  revoke --file <revocation.json> [--broker <url>]
  unrevoke --file <revocation.json> [--broker <url>]
    Removes only a local deny; signed revocations remain permanent.
  preview --file <preview.json> [--broker <url>]

Public signed artifact delivery (maximum 256 KiB):
  submit --url <peer-url> --tls-pin <verified-spki-hex> --audience <receiver-key-id> --file <signed-policy-grant-or-revocation.json>
  The receiving broker checks issuer authority; no device or admin key is needed.

Signed remote operation:
  call --url <peer-url> --tls-pin <verified-spki-hex> --device <device.json> --delegation <delegation.json>
       --policy <policy.json> --file <operation.json>
  Operations: whoami, discover, message, request, result; authorized owners/admins
  may also use policy.import, grant.import, and revoke for policy synchronization.

Remote access requires HTTPS and an explicit verified TLS SPKI pin matching the
receiver's signed node card. Cleartext HTTP is permitted only on loopback.
All output is JSON. Keys are created exclusively in a new private directory.
Share public.json and signed artifacts only; identity.json/device.json are private.
Signing input is a complete unsigned artifact; policy revision must advance.
Network policy expires after at most 30 days; delegations after at most 24 hours.
Project scopes include future agents in those projects; agent/project selectors
are a union. Empty scopes confer nothing. Import does not enroll resources.
Verification checks the supplied policy, not the receiver's current revocations.
Revocation verification checks only its signature; the receiver checks authority.
Local grant/delegation deny IDs are issuerKeyId:grantId / principalKeyId:delegationId.
Existing mesh grants remain legacy machine access; there is no automatic migration.
`;

type JsonObject = Record<string, unknown>;
type Artifact = AccessPolicy | AccessGrant | AccessDelegation | AccessRevocation;
const FIELDS = {
  revocation: ["protocol", "kind", "networkId", "issuerId", "issuerPublicKey", "targetKind", "targetId", "issuedAt", "signature"],
  policy: ["protocol", "kind", "networkId", "root", "label", "revision", "issuedAt", "expiresAt", "members", "revokedGrantIds", "revokedDelegationIds", "revokedDeviceIds", "revokedPrincipalIds", "signature"],
  grant: ["protocol", "kind", "id", "networkId", "issuerId", "subjectId", "audience", "revision", "issuedAt", "expiresAt", "revoked", "scope", "actions", "signature"],
  delegation: ["protocol", "kind", "id", "networkId", "principalId", "devicePublicKey", "audience", "issuedAt", "expiresAt", "scope", "actions", "signature"],
};

/** Reject unknown/duplicate flags and extra positional text before reading keys. */
export function parseMeshAccessFlags(args: string[], allowed: string[], required: string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--json") continue;
    const split = token.indexOf("=");
    const flag = split < 0 ? token : token.slice(0, split);
    if (!flag.startsWith("--") || !allowed.includes(flag.slice(2))) throw new ScoutCliError("Unknown argument for mesh access; see --help.");
    const key = flag.slice(2);
    if (Object.hasOwn(result, key)) throw new ScoutCliError(`Duplicate ${flag}.`);
    const value = split < 0 ? args[++index] : token.slice(split + 1);
    if (!value?.trim() || value.startsWith("--")) throw new ScoutCliError(`Missing value for ${flag}.`);
    result[key] = value;
  }
  for (const key of required) if (!result[key]) throw new ScoutCliError(`Missing --${key}.`);
  return result;
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScoutCliError("Expected a JSON object.");
  return value as JsonObject;
}
function fields(value: JsonObject, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ScoutCliError("Unexpected fields in access JSON; private material and extensions are not accepted.");
}
function readJson(path: string, privateFile = false): JsonObject {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
    if (privateFile && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
      throw new ScoutCliError("Private identity must be owned by the current user with mode 0600 (or stricter).");
    }
    return object(JSON.parse(readFileSync(fd, "utf8")));
  } catch (error) {
    if (error instanceof ScoutCliError) throw error;
    // Never echo JSON parse errors: they can contain private input bytes.
    throw new ScoutCliError("Cannot read access JSON: require a regular non-symlink file containing valid JSON (maximum 1 MiB).");
  } finally { if (fd !== undefined) closeSync(fd); }
}
function publicPrincipal(value: unknown): AccessPrincipal {
  const item = object(value);
  fields(item, ["id", "publicKey", "kind", "label"]);
  if (accessKeyId(item.publicKey) !== item.id || !["person", "service"].includes(String(item.kind))
    || typeof item.label !== "string" || !item.label.trim() || item.label.length > 100) throw new ScoutCliError("Invalid public principal.");
  return item as AccessPrincipal;
}
/** Strict public schemas prevent accidental private-key export via extension fields. */
export function publicAccessArtifact(value: unknown): Artifact {
  const item = object(value);
  if (item.kind !== "policy" && item.kind !== "grant" && item.kind !== "delegation" && item.kind !== "revocation") throw new ScoutCliError("Expected a policy, grant, delegation, or revocation public artifact.");
  fields(item, FIELDS[item.kind]);
  if (item.protocol !== ACCESS_PROTOCOL || ("signature" in item && typeof item.signature !== "string")) throw new ScoutCliError("Invalid artifact protocol or signature format.");
  if (item.kind === "revocation") {
    for (const key of ["networkId", "issuerId", "issuerPublicKey", "targetKind", "targetId"]) if (typeof item[key] !== "string") throw new ScoutCliError("Expected string identifiers in public revocation.");
    if (!["grant", "device", "delegation"].includes(String(item.targetKind)) || !Number.isSafeInteger(item.issuedAt) || accessKeyId(item.issuerPublicKey) !== item.issuerId) throw new ScoutCliError("Invalid revocation target, timestamp, or issuer identity.");
    return item as AccessRevocation;
  }
  const arrays = item.kind === "policy" ? ["revokedGrantIds", "revokedDelegationIds", "revokedDeviceIds", "revokedPrincipalIds"] : ["actions"];
  for (const key of arrays) if (!Array.isArray(item[key]) || !(item[key] as unknown[]).every((value) => typeof value === "string")) throw new ScoutCliError("Expected arrays of strings in public artifact.");
  const numbers = item.kind === "delegation" ? ["issuedAt", "expiresAt"] : ["revision", "issuedAt", "expiresAt"];
  for (const key of numbers) if (!Number.isSafeInteger(item[key])) throw new ScoutCliError("Expected integer revision and timestamps in public artifact.");
  const strings = item.kind === "policy" ? ["networkId", "label"] : item.kind === "grant" ? ["id", "networkId", "issuerId", "subjectId", "audience"] : ["id", "networkId", "principalId", "devicePublicKey", "audience"];
  for (const key of strings) if (typeof item[key] !== "string") throw new ScoutCliError("Expected string identifiers in public artifact.");
  if (item.kind === "grant" && typeof item.revoked !== "boolean") throw new ScoutCliError("Expected explicit grant revoked boolean.");
  if (item.kind === "policy") {
    publicPrincipal(item.root);
    if (!Array.isArray(item.members)) throw new ScoutCliError("Expected policy members.");
    for (const member of item.members) {
      const m = object(member); fields(m, ["principal", "role"]); publicPrincipal(m.principal);
      if (!["admin", "member", "service"].includes(String(m.role))) throw new ScoutCliError("Invalid public member role.");
    }
  } else {
    fields(object(item.scope), ["all", "agentIds", "projectIds"]);
    validateAccessScope(item.scope as AccessGrant["scope"]);
  }
  return item as Artifact;
}
function identityFrom(value: unknown): NodeIdentity {
  const key = object(value);
  fields(key, ["version", "publicKey", "privateKey", "createdAt"]);
  if (key.version !== 1 || typeof key.privateKey !== "string" || typeof key.publicKey !== "string" || !Number.isSafeInteger(key.createdAt)) throw new ScoutCliError("Invalid private identity.");
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(key.privateKey, "base64"), format: "der", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519" || createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64") !== key.publicKey) throw new Error();
    accessKeyId(key.publicKey);
  } catch { throw new ScoutCliError("Invalid or mismatched Ed25519 identity keys."); }
  return key as NodeIdentity;
}
function readIdentity(path: string, device = false): { identity: NodeIdentity; principal?: AccessPrincipal } {
  const value = readJson(path, true);
  fields(value, device ? ["protocol", "kind", "identity"] : ["protocol", "kind", "principal", "identity"]);
  if (value.protocol !== ACCESS_PROTOCOL || value.kind !== (device ? "private-device" : "private-identity")) throw new ScoutCliError("Wrong private identity format; use mesh access identity/device create.");
  const identity = identityFrom(value.identity);
  const principal = device ? undefined : publicPrincipal(value.principal);
  if (principal && principal.publicKey !== identity.publicKey) throw new ScoutCliError("Principal and private identity do not match.");
  return { identity, principal };
}
function freshIdentity(): NodeIdentity {
  const pair = generateKeyPairSync("ed25519");
  return { version: 1, publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), createdAt: Date.now() };
}
function save(path: string, value: unknown): void {
  try { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); }
  catch { throw new ScoutCliError("Cannot create output file; the parent must exist and the output must not already exist."); }
}
function readPolicy(path: string): AccessPolicy {
  const policy = publicAccessArtifact(readJson(path));
  if (policy.kind !== "policy") throw new ScoutCliError("--policy must contain a signed network policy.");
  validateAccessPolicy(policy); return policy;
}
function verify(artifact: Artifact, policy?: AccessPolicy): void {
  if (artifact.kind === "policy") validateAccessPolicy(artifact);
  else if (artifact.kind === "revocation") validateAccessRevocation(artifact);
  else {
    if (!policy) throw new ScoutCliError("--policy is required to verify grant or delegation authority.");
    if (artifact.kind === "grant") validateAccessGrant(artifact, policy);
    else validateAccessDelegation(artifact, policy, artifact.audience);
  }
}
async function post(url: URL, payload: unknown, fetchImpl: typeof fetch, headers: Record<string, string> = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch { throw new ScoutCliError("Could not reach the scoped access endpoint; check the URL and peer compatibility."); }
  if (!response.ok) throw new ScoutCliError(`Scoped access request failed (HTTP ${response.status}); no legacy fallback was attempted.`);
  try { return await response.json(); } catch { throw new ScoutCliError("Peer returned invalid JSON; scoped access requires a compatible broker."); }
}
/** Capability discovery is public, but the capability itself must be signed by
 * the receiving audience key. Never send a delegation to an incompatible peer.
 */
async function requireScopedPeer(url: URL, audience: string, fetchImpl: typeof fetch, tlsPin?: string): Promise<void> {
  try {
    const response = await fetchImpl(new URL("/v1/node", url).toString(), {
      method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error();
    const payload = object(await response.json());
    const card = object(payload.card) as SignedNodeCard;
    if (!verifySignedNodeCard(card) || card.keyId !== audience || !Array.isArray(card.capabilities)
      || !card.capabilities.includes(ACCESS_PROTOCOL) || !Number.isSafeInteger(card.issuedAt) || card.issuedAt > Date.now() + PRE_BOOT_GRACE_MS
      || (url.protocol === "https:" && (!tlsPin || card.tls?.spkiFingerprint !== tlsPin))) throw new Error();
  } catch {
    throw new ScoutCliError("Peer must advertise scout-access/1 in a valid signed node card matching the expected audience and TLS pin; update or verify the peer. No scoped request was sent and no legacy fallback was attempted.");
  }
}
async function localBrokerAudience(url: URL, fetchImpl: typeof fetch): Promise<string> {
  try {
    const response = await fetchImpl(new URL("/v1/node", url).toString(), { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error();
    const card = object(object(await response.json()).card) as SignedNodeCard;
    if (!verifySignedNodeCard(card) || !Number.isSafeInteger(card.issuedAt) || card.issuedAt > Date.now() + PRE_BOOT_GRACE_MS) throw new Error();
    return card.keyId;
  } catch { throw new ScoutCliError("Local broker must provide a valid signed node card before an administration request can be authenticated."); }
}
function warnAgentExecution(context: ScoutCommandContext): void {
  context.stderr(JSON.stringify({ warning: "request-execution-authority", message: "Request access to a tool-using agent can imply owner-level local execution unless that agent is sandboxed or runs as another OS user. The restricted service must run as a different OS user from both the broker and its agents; an agent running as the owner can read the administration key and write the control database." }));
}
function scopedTransport(url: URL, audience: string, tlsPin: string | undefined, fetchImpl: typeof fetch, pinnedFactory: () => PinnedHttpsClient): { fetch: typeof fetch; close: () => void } {
  if (url.protocol === "http:") {
    if (tlsPin) throw new ScoutCliError("--tls-pin requires HTTPS.");
    return { fetch: fetchImpl, close: () => {} };
  }
  if (!tlsPin || !/^[0-9a-f]{64}$/.test(tlsPin)) throw new ScoutCliError("HTTPS scoped access requires --tls-pin with the receiver's verified 64-character lowercase SPKI fingerprint.");
  const pinned = pinnedFactory();
  return {
    fetch: ((request: string | URL | Request, init?: RequestInit) => pinned.fetch(String(request), { spkiFingerprint: tlsPin, expectedKeyId: audience }, init)) as typeof fetch,
    close: () => pinned.close(),
  };
}
function endpoint(value: string, path: string, local = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ScoutCliError("Expected an absolute HTTP(S) broker URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new ScoutCliError("Broker URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
  if (local && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new ScoutCliError("Local access administration requires a loopback broker URL.");
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new ScoutCliError("Remote scoped access requires HTTPS; cleartext HTTP is allowed only on loopback.");
  return new URL(path, url);
}

export async function runMeshAccessCommand(context: ScoutCommandContext, args: string[], fetchImpl: typeof fetch = runtimeFetch, pinnedFactory: () => PinnedHttpsClient = createPinnedHttpsClient): Promise<void> {
  if (!args.length || args.includes("--help") || args.includes("-h") || args[0] === "help") { context.output.writeText(MESH_ACCESS_HELP); return; }
  const command = args[0]!;
  const compound = ["identity", "device", "network", "policy", "grant", "revocation", "admin-key"].includes(command);
  const verb = compound ? `${command} ${args[1] ?? ""}` : command;
  const tail = args.slice(compound ? 2 : 1);
  const emit = (value: unknown) => context.stdout(JSON.stringify(value, null, 2));
  const path = (value: string) => resolve(context.cwd, value);
  if (verb === "admin-key create") {
    const opts = parseMeshAccessFlags(tail, ["file"], ["file"]);
    const file = path(opts.file!);
    try { writeFileSync(file, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 }); }
    catch { throw new ScoutCliError("Cannot create administration key; choose a new file in a private directory."); }
    emit({ created: true, file, usage: "Set OPENSCOUT_LOCAL_ADMIN_KEY_FILE on an isolated broker; pass --admin-key for local administration. Existing uncredentialled local clients will be refused." }); return;
  }
  if (verb === "identity create" || verb === "device create") {
    const device = verb === "device create";
    const opts = parseMeshAccessFlags(tail, device ? ["directory"] : ["directory", "kind", "label"], device ? ["directory"] : ["directory", "kind", "label"]);
    if (!device && (!["person", "service"].includes(opts.kind!) || opts.label!.length > 100)) throw new ScoutCliError("Identity requires kind person|service and a label of 1–100 characters.");
    const identity = freshIdentity();
    const principal: AccessPrincipal = { id: accessKeyId(identity.publicKey), publicKey: identity.publicKey, kind: opts.kind as "person" | "service", label: opts.label! };
    const directory = path(opts.directory!);
    try { mkdirSync(directory, { mode: 0o700 }); } catch { throw new ScoutCliError("Identity directory must be new and its parent must exist."); }
    const publicValue = device ? { protocol: ACCESS_PROTOCOL, kind: "device", id: accessKeyId(identity.publicKey), publicKey: identity.publicKey } : principal;
    save(join(directory, device ? "device.json" : "identity.json"), { protocol: ACCESS_PROTOCOL, kind: device ? "private-device" : "private-identity", ...(device ? {} : { principal }), identity });
    save(join(directory, "public.json"), publicValue);
    emit({ ...publicValue, fingerprint: nodeFingerprint(identity.publicKey) }); return;
  }
  if (verb === "network create") {
    const opts = parseMeshAccessFlags(tail, ["identity", "label", "out"], ["identity", "label", "out"]);
    const { identity, principal } = readIdentity(path(opts.identity!));
    if (principal!.kind !== "person") throw new ScoutCliError("Only a person identity can create a network.");
    const now = Date.now();
    const policy = signAccessArtifact<AccessPolicy>(identity, { protocol: ACCESS_PROTOCOL, kind: "policy", networkId: principal!.id, root: principal!, label: opts.label!, revision: 1, issuedAt: now, expiresAt: now + ACCESS_POLICY_TTL_MS, members: [], revokedGrantIds: [], revokedDelegationIds: [], revokedDeviceIds: [], revokedPrincipalIds: [] });
    validateAccessPolicy(policy); save(path(opts.out!), policy);
    context.stderr(JSON.stringify({ warning: "root-key-custody", message: "The root key is stored in a local 0600 file and must sign policy renewals at least every 30 days. Key loss or compromise has no supported recovery or ownership transfer. Consider separately managed OS Keychain or secret storage; this CLI does not integrate with those stores." }));
    emit(policy); return;
  }
  if (["policy sign", "grant sign", "delegate", "revocation sign"].includes(verb)) {
    const opts = parseMeshAccessFlags(tail, ["identity", "file", "out", "policy"], ["identity", "file", "out", ...(["policy sign", "revocation sign"].includes(verb) ? [] : ["policy"])]);
    const unsigned = publicAccessArtifact(readJson(path(opts.file!)));
    const kind = verb === "policy sign" ? "policy" : verb === "grant sign" ? "grant" : verb === "revocation sign" ? "revocation" : "delegation";
    if (unsigned.kind !== kind || Object.hasOwn(unsigned, "signature")) throw new ScoutCliError("Signing requires an unsigned artifact of the requested kind; remove its signature first.");
    const { identity, principal } = readIdentity(path(opts.identity!));
    const signerId = unsigned.kind === "policy" ? unsigned.root.id : (unsigned.kind === "grant" || unsigned.kind === "revocation") ? unsigned.issuerId : unsigned.principalId;
    if (signerId !== principal!.id) throw new ScoutCliError("Artifact signer does not match --identity.");
    const signed = signAccessArtifact<Artifact>(identity, unsigned);
    verify(signed, opts.policy ? readPolicy(path(opts.policy)) : undefined);
    save(path(opts.out!), signed);
    if (signed.kind === "grant" && signed.actions.includes("request")) warnAgentExecution(context);
    emit(signed); return;
  }
  if (verb === "inspect" || verb === "verify") {
    const opts = parseMeshAccessFlags(tail, ["file", "policy"], ["file"]);
    const value = readJson(path(opts.file!));
    if (verb === "inspect" && (value.kind === "private-identity" || value.kind === "private-device")) {
      const { identity, principal } = readIdentity(path(opts.file!), value.kind === "private-device");
      emit({ ...(principal ?? { kind: "device", id: accessKeyId(identity.publicKey), publicKey: identity.publicKey }), fingerprint: nodeFingerprint(identity.publicKey) }); return;
    }
    if (verb === "inspect" && (value.kind === "person" || value.kind === "service")) { emit(publicPrincipal(value)); return; }
    if (verb === "inspect" && value.kind === "device") { fields(value, ["protocol", "kind", "id", "publicKey"]); if (accessKeyId(value.publicKey) !== value.id) throw new ScoutCliError("Device key/id mismatch."); emit(value); return; }
    const artifact = publicAccessArtifact(value);
    if (verb === "verify") verify(artifact, opts.policy ? readPolicy(path(opts.policy)) : undefined);
    emit(verb === "verify" ? { valid: true, verification: artifact.kind === "revocation" ? "signature-only" : "signature-and-supplied-policy", receiverStateChecked: false, artifact } : { verified: false, artifact }); return;
  }
  if (["status", "import", "enroll", "revoke", "unrevoke", "preview"].includes(verb)) {
    const opts = parseMeshAccessFlags(tail, ["broker", "admin-key", ...(verb === "status" ? [] : ["file"])], verb === "status" ? [] : ["file"]);
    const input = opts.file ? readJson(path(opts.file)) : {};
    let payload: JsonObject;
    if (verb === "import") {
      const artifact = publicAccessArtifact(input);
      payload = { operation: `${artifact.kind}.import`, artifact };
    } else {
      const allowed = verb === "enroll" ? ["networkId", "agentIds", "projects"] : ["revoke", "unrevoke"].includes(verb) ? ["networkId", "kind", "id"] : verb === "preview" ? ["delegation"] : [];
      fields(input, allowed);
      if (verb === "enroll") {
        if (typeof input.networkId !== "string" || !Array.isArray(input.agentIds) || !input.agentIds.every((id) => typeof id === "string") || !Array.isArray(input.projects)) throw new ScoutCliError("Enrollment requires networkId, agentIds, and projects arrays.");
        for (const project of input.projects) {
          const entry = object(project); fields(entry, ["id", "root"]);
          if (typeof entry.id !== "string" || typeof entry.root !== "string") throw new ScoutCliError("Enrollment projects require id and canonical root strings.");
        }
      }
      if (["revoke", "unrevoke"].includes(verb) && (typeof input.networkId !== "string" || typeof input.id !== "string" || !["grant", "device", "delegation", "principal"].includes(String(input.kind)))) throw new ScoutCliError("Revocation requires networkId, kind (grant|device|delegation|principal), and id.");
      if (verb === "preview" && publicAccessArtifact(input.delegation).kind !== "delegation") throw new ScoutCliError("Preview requires a delegation.");
      payload = { ...input, operation: verb === "enroll" ? "resources.enroll" : verb };
    }
    const url = endpoint(opts.broker ?? resolveScoutBrokerUrl(), "/v1/access/admin", true);
    let headers: Record<string, string> = {};
    if (opts["admin-key"]) {
      let key: string;
      try { key = readLocalAdminKey(path(opts["admin-key"]))!; }
      catch { throw new ScoutCliError("Cannot read protected local administration key; require an owner-only regular file."); }
      const destinationKeyId = await localBrokerAudience(url, fetchImpl);
      headers = signLocalAdminRequest(key, { method: "POST", path: url.pathname, body: JSON.stringify(payload), destinationKeyId });
    }
    if (verb === "preview" && publicAccessArtifact(input.delegation).kind === "delegation" && (input.delegation as AccessDelegation).actions.includes("request")) warnAgentExecution(context);
    emit(await post(url, payload, fetchImpl, headers)); return;
  }
  if (verb === "submit") {
    const opts = parseMeshAccessFlags(tail, ["url", "audience", "file", "tls-pin"], ["url", "audience", "file"]);
    if (!/^[0-9a-f]{64}$/.test(opts.audience!)) throw new ScoutCliError("--audience must be the receiver's full lowercase key ID.");
    const artifact = publicAccessArtifact(readJson(path(opts.file!)));
    if (artifact.kind === "delegation" || typeof artifact.signature !== "string" || !artifact.signature) throw new ScoutCliError("Submit requires a signed policy, grant, or revocation.");
    const payload = { artifact };
    if (Buffer.byteLength(JSON.stringify(payload)) > ACCESS_ARTIFACT_MAX_BYTES) throw new ScoutCliError("Serialized access submission exceeds the 256 KiB limit.");
    if (artifact.kind === "policy") validateAccessPolicy(artifact);
    if (artifact.kind === "revocation") validateAccessRevocation(artifact);
    if (artifact.kind === "grant" && artifact.audience !== opts.audience) throw new ScoutCliError("Grant audience does not match --audience.");
    const url = endpoint(opts.url!, "/v1/access/policy");
    const transport = scopedTransport(url, opts.audience!, opts["tls-pin"], fetchImpl, pinnedFactory);
    try {
      await requireScopedPeer(url, opts.audience!, transport.fetch, opts["tls-pin"]);
      // Signed artifacts authenticate themselves; no admin/device credential is sent.
      emit(await post(url, payload, transport.fetch));
    } finally { transport.close(); }
    return;
  }
  if (verb === "call") {
    const opts = parseMeshAccessFlags(tail, ["url", "device", "delegation", "policy", "file", "tls-pin"], ["url", "device", "delegation", "policy", "file"]);
    const { identity } = readIdentity(path(opts.device!), true);
    const delegation = publicAccessArtifact(readJson(path(opts.delegation!)));
    if (delegation.kind !== "delegation" || delegation.devicePublicKey !== identity.publicKey) throw new ScoutCliError("Delegation does not authorize this device key.");
    verify(delegation, readPolicy(path(opts.policy!)));
    const input = readJson(path(opts.file!));
    const operationFields: Record<string, string[]> = {
      whoami: [], discover: [], message: ["target", "requestId", "body"], request: ["target", "requestId", "body"], result: ["requestId"],
      "policy.import": ["artifact"], "grant.import": ["artifact"], revoke: ["networkId", "kind", "id"],
    };
    if (typeof input.operation !== "string" || !Object.hasOwn(operationFields, input.operation)) throw new ScoutCliError("Unsupported scoped operation; see mesh access --help.");
    fields(input, ["operation", ...operationFields[input.operation]!]);
    if (input.operation.endsWith(".import")) {
      const artifact = publicAccessArtifact(input.artifact);
      if (`${artifact.kind}.import` !== input.operation) throw new ScoutCliError("Artifact kind does not match import operation.");
    }
    if (input.operation === "revoke" && (typeof input.networkId !== "string" || typeof input.id !== "string" || !["grant", "device", "delegation", "principal"].includes(String(input.kind)))) throw new ScoutCliError("Revocation requires networkId, kind, and id.");
    for (const key of ["target", "requestId", "body"]) if (key in input && typeof input[key] !== "string") throw new ScoutCliError("Operation target, requestId, and body must be strings.");
    if (["message", "request", "result"].includes(input.operation) && (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(input.requestId))) throw new ScoutCliError("Operation requires a requestId of 8–64 letters, digits, underscores, or hyphens.");
    if (["message", "request"].includes(input.operation) && (typeof input.target !== "string" || !input.target || typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body) > 32768)) throw new ScoutCliError("Message/request requires an exact target and a nonempty body of at most 32 KiB.");
    const payload = { ...input, delegation };
    const url = endpoint(opts.url!, "/v1/access/rpc");
    const transport = scopedTransport(url, delegation.audience, opts["tls-pin"], fetchImpl, pinnedFactory);
    try {
      await requireScopedPeer(url, delegation.audience, transport.fetch, opts["tls-pin"]);
      const headers = signScopedPeerRequest(identity, { delegation, method: "POST", path: url.pathname, body: JSON.stringify(payload), destinationKeyId: delegation.audience });
      emit(await post(url, payload, transport.fetch, headers));
    } finally { transport.close(); }
    return;
  }
  throw new ScoutCliError("Unknown mesh access command; see scout mesh access --help.");
}
