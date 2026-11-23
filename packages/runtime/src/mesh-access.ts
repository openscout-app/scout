/**
 * Public cryptographic access contract. All signatures use Scout's existing
 * Ed25519/SPKI and canonical JSON primitives. Authority installation and
 * resource enrollment are separate local acts; an imported key grants nothing.
 */
import { createHash, createPublicKey } from "node:crypto";
import { HOST_ACTIONS, type HostAction, type HostRole } from "@openscout/protocol";
import { canonicalJson, nodeKeyId, signNodePayload, verifyNodeSignature, type NodeIdentity } from "./node-identity-wire.js";

export const ACCESS_PROTOCOL = "scout-access/1" as const;
export const ACCESS_POLICY_TTL_MS = 30 * 24 * 60 * 60_000;
export const ACCESS_DELEGATION_TTL_MS = 24 * 60 * 60_000;
export const ACCESS_CLOCK_SKEW_MS = 15_000;
export const accessRevocationTarget = (issuerId: string, id: string): string => `${issuerId}:${id}`;
export const accessRequestHash = (request: object): string => createHash("sha256").update(canonicalJson(request)).digest("hex");
const keyIds = new Map<string, string>();
const verifiedSignatures = new Set<string>();
/** The host verbs and host roles of the shared evaluator (@openscout/protocol access-evaluator.ts). */
export const ACCESS_ACTIONS = HOST_ACTIONS;
export type AccessAction = HostAction;
export type AccessRole = HostRole;
export type AccessPrincipal = { id: string; publicKey: string; kind: "person" | "service"; label: string };
/** Agent and project selectors are a union. Empty is always no access. */
export type AccessScope = { all: boolean; agentIds: string[]; projectIds: string[] };
export type AccessMember = { principal: AccessPrincipal; role: Exclude<AccessRole, "owner"> };
export type AccessPolicy = {
  protocol: typeof ACCESS_PROTOCOL;
  kind: "policy";
  networkId: string;
  root: AccessPrincipal;
  label: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  members: AccessMember[];
  revokedPrincipalIds: string[];
  revokedGrantIds: string[];
  revokedDelegationIds: string[];
  revokedDeviceIds: string[];
  signature: string;
};
export type AccessGrant = {
  protocol: typeof ACCESS_PROTOCOL;
  kind: "grant";
  id: string;
  networkId: string;
  issuerId: string;
  subjectId: string;
  audience: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
  scope: AccessScope;
  actions: AccessAction[];
  signature: string;
};
export type AccessDelegation = {
  protocol: typeof ACCESS_PROTOCOL;
  kind: "delegation";
  id: string;
  networkId: string;
  principalId: string;
  devicePublicKey: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  scope: AccessScope;
  actions: AccessAction[];
  signature: string;
};
/** Negative-only, self-authenticating withdrawal of an already known artifact. */
export type AccessRevocation = {
  protocol: typeof ACCESS_PROTOCOL;
  kind: "revocation";
  networkId: string;
  issuerId: string;
  issuerPublicKey: string;
  targetKind: "grant" | "device" | "delegation";
  targetId: string;
  issuedAt: number;
  signature: string;
};
export type AccessSubmission = AccessPolicy | AccessGrant | AccessRevocation;
export const ACCESS_ARTIFACT_MAX_BYTES = 256 * 1024;
export type AccessResource = { agentId: string; projectId?: string };
export type AccessProof = { networkId: string; principalId: string; deviceId: string; delegation: AccessDelegation };

export class MeshAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message); this.name = "MeshAccessError"; }
}
function requireAccess(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MeshAccessError("invalid_access_artifact", message, 400);
}
export function accessKeyId(publicKey: unknown): string {
  requireAccess(typeof publicKey === "string" && publicKey.length <= 200, "invalid Ed25519 public key");
  const cached = keyIds.get(publicKey);
  if (cached) return cached;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    requireAccess(key.asymmetricKeyType === "ed25519" && key.export({ format: "der", type: "spki" }).toString("base64") === publicKey, "noncanonical Ed25519 public key");
    const id = nodeKeyId(publicKey);
    if (keyIds.size >= 4096) keyIds.clear();
    keyIds.set(publicKey, id);
    return id;
  } catch { throw new MeshAccessError("invalid_access_artifact", "invalid Ed25519 public key", 400); }
}
function exactKeys(value: object, expected: string[]): void {
  requireAccess(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key)), "unexpected or missing access fields");
}
function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,199}$/.test(value); }
function ids(value: unknown): asserts value is string[] {
  requireAccess(Array.isArray(value) && value.length <= 1000 && value.every(validId) && new Set(value).size === value.length, "invalid or duplicate identifiers");
}
export function validateAccessScope(scope: AccessScope): void {
  exactKeys(scope, ["all", "agentIds", "projectIds"]);
  requireAccess(scope && typeof scope.all === "boolean", "scope.all must be explicit");
  ids(scope.agentIds); ids(scope.projectIds);
  requireAccess(!scope.all || (scope.agentIds.length === 0 && scope.projectIds.length === 0), "all cannot be combined with selected resources");
}
function actions(value: unknown): asserts value is AccessAction[] {
  requireAccess(Array.isArray(value) && value.length > 0 && value.length <= ACCESS_ACTIONS.length
    && value.every((a) => ACCESS_ACTIONS.includes(a)) && new Set(value).size === value.length, "invalid actions");
}
function times(artifact: { issuedAt: number; expiresAt: number }, now: number, maxTtl: number): void {
  requireAccess(Number.isSafeInteger(artifact.issuedAt) && Number.isSafeInteger(artifact.expiresAt)
    && artifact.issuedAt <= now + ACCESS_CLOCK_SKEW_MS && artifact.expiresAt > now && artifact.expiresAt > artifact.issuedAt
    && artifact.expiresAt - artifact.issuedAt <= maxTtl, "artifact is expired, future-dated, or exceeds maximum lifetime");
}
function principal(value: AccessPrincipal): void {
  exactKeys(value, ["id", "publicKey", "kind", "label"]);
  requireAccess(value && accessKeyId(value.publicKey) === value.id, "principal key/id mismatch");
  requireAccess(value.kind === "person" || value.kind === "service", "invalid principal kind");
  requireAccess(typeof value.label === "string" && value.label.trim().length > 0 && value.label.length <= 100, "invalid principal label");
}
function signedPayload(value: object): string {
  const { signature: _, ...unsigned } = value as Record<string, unknown>;
  return canonicalJson(unsigned);
}
export function signAccessArtifact<T extends { signature: string }>(identity: NodeIdentity, value: Omit<T, "signature">): T {
  return { ...value, signature: signNodePayload(identity, canonicalJson(value)) } as T;
}
function signature(value: { protocol: string; signature: string }, publicKey: string): void {
  const payload = signedPayload(value);
  const cacheKey = createHash("sha256").update(canonicalJson([publicKey, payload, value.signature])).digest("hex");
  requireAccess(value.protocol === ACCESS_PROTOCOL && typeof value.signature === "string"
    && value.signature.length <= 100 && (verifiedSignatures.has(cacheKey) || verifyNodeSignature(publicKey, payload, value.signature)), "invalid access signature or protocol");
  if (verifiedSignatures.size >= 4096) verifiedSignatures.clear();
  verifiedSignatures.add(cacheKey);
}
export function validateAccessPolicy(policy: AccessPolicy, now = Date.now()): void {
  exactKeys(policy, ["protocol", "kind", "networkId", "root", "label", "revision", "issuedAt", "expiresAt", "members", "revokedPrincipalIds", "revokedGrantIds", "revokedDelegationIds", "revokedDeviceIds", "signature"]);
  requireAccess(policy?.kind === "policy", "expected policy"); principal(policy.root);
  requireAccess(policy.root.kind === "person" && policy.networkId === policy.root.id, "network root must be its person key identity");
  requireAccess(Number.isSafeInteger(policy.revision) && policy.revision >= 1, "invalid policy revision");
  requireAccess(typeof policy.label === "string" && policy.label.length > 0 && policy.label.length <= 100, "invalid network label");
  times(policy, now, ACCESS_POLICY_TTL_MS);
  requireAccess(Array.isArray(policy.members) && policy.members.length <= 1000, "invalid memberships");
  const seen = new Set([policy.root.id]);
  for (const member of policy.members) {
    exactKeys(member, ["principal", "role"]);
    principal(member.principal);
    requireAccess(!seen.has(member.principal.id), "duplicate principal"); seen.add(member.principal.id);
    requireAccess(["admin", "member", "service"].includes(member.role), "invalid member role");
    requireAccess((member.principal.kind === "service") === (member.role === "service"), "services cannot inherit human roles");
  }
  ids(policy.revokedPrincipalIds);
  requireAccess(!policy.revokedPrincipalIds.includes(policy.root.id), "last owner cannot be revoked");
  for (const selectors of [policy.revokedGrantIds, policy.revokedDelegationIds]) {
    requireAccess(Array.isArray(selectors) && selectors.length <= 1000 && new Set(selectors).size === selectors.length
      && selectors.every((id) => typeof id === "string" && /^[a-f0-9]{64}:[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,199}$/.test(id)), "revocation targets require issuer/principal key ID namespace");
  }
  ids(policy.revokedDeviceIds);
  signature(policy, policy.root.publicKey);
}
/** Target ownership is checked against receiver state by MeshAccessStore. */
export function validateAccessRevocation(revocation: AccessRevocation, now = Date.now()): void {
  exactKeys(revocation, ["protocol", "kind", "networkId", "issuerId", "issuerPublicKey", "targetKind", "targetId", "issuedAt", "signature"]);
  requireAccess(revocation.kind === "revocation" && validId(revocation.networkId) && validId(revocation.targetId)
    && ["grant", "device", "delegation"].includes(revocation.targetKind), "invalid revocation binding");
  requireAccess(accessKeyId(revocation.issuerPublicKey) === revocation.issuerId, "revocation issuer key/id mismatch");
  requireAccess(Number.isSafeInteger(revocation.issuedAt) && revocation.issuedAt >= 0 && revocation.issuedAt <= now + ACCESS_CLOCK_SKEW_MS, "invalid revocation issue time");
  signature(revocation, revocation.issuerPublicKey);
}
export function accessMembership(policy: AccessPolicy, id: string): { principal: AccessPrincipal; role: AccessRole } | undefined {
  if (policy.revokedPrincipalIds.includes(id)) return undefined;
  return id === policy.root.id ? { principal: policy.root, role: "owner" } : policy.members.find((m) => m.principal.id === id);
}
export function validateAccessGrant(grant: AccessGrant, policy: AccessPolicy, now = Date.now()): void {
  validateAccessPolicy(policy, now);
  validateGrantAgainstPolicy(grant, policy, now);
}
function validateGrantAgainstPolicy(grant: AccessGrant, policy: AccessPolicy, now: number): void {
  exactKeys(grant, ["protocol", "kind", "id", "networkId", "issuerId", "subjectId", "audience", "revision", "issuedAt", "expiresAt", "revoked", "scope", "actions", "signature"]);
  requireAccess(grant?.kind === "grant" && grant.networkId === policy.networkId && validId(grant.id) && validId(grant.audience), "invalid grant binding");
  requireAccess(Number.isSafeInteger(grant.revision) && grant.revision >= 1 && typeof grant.revoked === "boolean", "invalid grant revision");
  times(grant, now, ACCESS_POLICY_TTL_MS); validateAccessScope(grant.scope); actions(grant.actions);
  const issuer = accessMembership(policy, grant.issuerId);
  requireAccess(issuer && (issuer.role === "owner" || issuer.role === "admin"), "issuer has no grant authority");
  requireAccess(accessMembership(policy, grant.subjectId), "unknown subject");
  requireAccess(grant.issuerId !== grant.subjectId, "self-issued grants are not permitted");
  requireAccess(!grant.actions.includes("admin"), "resource grants cannot confer access administration");
  signature(grant, issuer.principal.publicKey);
}
export function validateAccessDelegation(delegation: AccessDelegation, policy: AccessPolicy, audience: string, now = Date.now()): AccessProof {
  validateAccessPolicy(policy, now);
  return validateDelegationAgainstPolicy(delegation, policy, audience, now);
}
function validateDelegationAgainstPolicy(delegation: AccessDelegation, policy: AccessPolicy, audience: string, now: number): AccessProof {
  exactKeys(delegation, ["protocol", "kind", "id", "networkId", "principalId", "devicePublicKey", "audience", "issuedAt", "expiresAt", "scope", "actions", "signature"]);
  requireAccess(delegation?.kind === "delegation" && delegation.networkId === policy.networkId
    && delegation.audience === audience && validId(delegation.id), "invalid delegation binding");
  times(delegation, now, ACCESS_DELEGATION_TTL_MS); validateAccessScope(delegation.scope); actions(delegation.actions);
  const member = accessMembership(policy, delegation.principalId);
  requireAccess(member, "principal is not a network member");
  const deviceId = accessKeyId(delegation.devicePublicKey);
  requireAccess(!accessMembership(policy, deviceId), "device keys must be separate from principal keys");
  requireAccess(!policy.revokedDelegationIds.includes(accessRevocationTarget(delegation.principalId, delegation.id)) && !policy.revokedDeviceIds.includes(deviceId), "delegation or device revoked");
  signature(delegation, member.principal.publicKey);
  return { networkId: policy.networkId, principalId: member.principal.id, deviceId, delegation };
}
export function accessScopeMatches(scope: AccessScope, resource: AccessResource): boolean {
  return scope.all || scope.agentIds.includes(resource.agentId) || Boolean(resource.projectId && scope.projectIds.includes(resource.projectId));
}
/** A request snapshot; signed artifact verification is performed once, then checks are pure scope intersections. */
export function prepareAccessEvaluation(input: { policy: AccessPolicy; proof: AccessProof; grants: AccessGrant[]; audience: string; now?: number }) {
  const now = input.now ?? Date.now();
  validateAccessPolicy(input.policy, now);
  const proof = validateDelegationAgainstPolicy(input.proof.delegation, input.policy, input.audience, now);
  requireAccess(proof.principalId === input.proof.principalId && proof.deviceId === input.proof.deviceId && proof.networkId === input.proof.networkId, "proof binding mismatch");
  const member = accessMembership(input.policy, proof.principalId)!;
  const grants = input.grants.filter((grant) => {
    try { validateGrantAgainstPolicy(grant, input.policy, now); } catch { return false; }
    return !grant.revoked && !input.policy.revokedGrantIds.includes(accessRevocationTarget(grant.issuerId, grant.id))
      && grant.audience === input.audience && grant.subjectId === proof.principalId;
  });
  return {
    expiresAt: Math.min(input.policy.expiresAt, proof.delegation.expiresAt, ...grants.map((g) => g.expiresAt)),
    admin: () => (member.role === "owner" || member.role === "admin") && proof.delegation.actions.includes("admin") && proof.delegation.scope.all,
    allowed: (action: AccessAction, resource: AccessResource): boolean => {
      if (!proof.delegation.actions.includes(action) || !accessScopeMatches(proof.delegation.scope, resource)) return false;
      if (member.role === "owner" || member.role === "admin") return true;
      return action !== "admin" && grants.some((grant) => grant.actions.includes(action) && accessScopeMatches(grant.scope, resource));
    },
  };
}
/** Resource must already be resolved against this broker's enrolled inventory. */
export function evaluateAccess(input: { policy: AccessPolicy; proof: AccessProof; grants: AccessGrant[]; audience: string; action: AccessAction; resource: AccessResource; now?: number }): boolean {
  try { return prepareAccessEvaluation(input).allowed(input.action, input.resource); } catch { return false; }
}
