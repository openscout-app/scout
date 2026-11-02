import { expect, test } from "bun:test";
import { registrySubstanceChanged, registrySubstanceKey } from "./registry-liveness.js";
test("the allowlist does not hide endpoint state, keys, capabilities, scope or arbitrary timestamped evidence", () => {
  for (const kind of ["node", "actor", "agent", "endpoint"] as const) {
    expect(registrySubstanceChanged(kind, { metadata: { lastSeenAt: 1 } }, { metadata: { lastSeenAt: 2 } })).toBe(false);
    for (const field of ["name", "state", "url", "capabilities", "keys", "advertiseScope", "registeredAt", "createdAt", "updatedAt"]) {
      expect(registrySubstanceChanged(kind, { [field]: "before" }, { [field]: "after" })).toBe(true);
    }
    expect(registrySubstanceChanged(kind, { metadata: { evidence: { lastSeenAt: 1 } } }, { metadata: { evidence: { lastSeenAt: 2 } } })).toBe(true);
  }
  expect(registrySubstanceChanged("endpoint", { metadata: { source: "other", startedAt: 1 } }, { metadata: { source: "other", startedAt: 2 } })).toBe(true);
  expect(registrySubstanceChanged("node", { meshEntrypoints: [{ expiresAt: 1 }] }, { meshEntrypoints: [{ expiresAt: 2 }] })).toBe(true);
  expect(registrySubstanceChanged("actor", { metadata: {} }, {})).toBe(false);
});

test("signed-card renewal is liveness but keys, claims, TTL and anomalous envelope changes are not", () => {
  const before = { card: { issuedAt: 1000, expiresAt: 2000, nonce: "a", signature: "a", publicKey: "key", keyId: "kid", fingerprint: "fp", capabilities: ["mesh"], endpoints: ["https://one"], tls: { spkiFingerprint: "tls" } } };
  const after = { card: { ...before.card, issuedAt: 1500, expiresAt: 2500, nonce: "b", signature: "b" } };
  expect(registrySubstanceChanged("node", before, after)).toBe(false);
  for (const changed of [{ publicKey: "other" }, { keyId: "other" }, { fingerprint: "other" }, { capabilities: ["new"] }, { endpoints: ["https://two"] }, { tls: { spkiFingerprint: "other" } }, { expiresAt: 2400 }, { issuedAt: 500, expiresAt: 1500 }]) {
    expect(registrySubstanceChanged("node", before, { card: { ...after.card, ...changed } })).toBe(true);
  }
  expect(registrySubstanceChanged("node", before, { card: { ...before.card, signature: "new" } })).toBe(true);
  expect(registrySubstanceChanged("node", before, {})).toBe(true);
  expect(registrySubstanceChanged("node", {}, after)).toBe(true);
});

test("repeated stale/failure observations keep transitions and replacement identities eventful", () => {
  const before = { state: "unavailable", metadata: { staleLocalRegistration: true, staleAt: 1, lastFailedAt: 1, lastError: "offline", replacedByAgentId: "new" } };
  const after = { ...before, metadata: { ...before.metadata, staleAt: 2, lastFailedAt: 2 } };
  expect(registrySubstanceChanged("endpoint", before, after)).toBe(false);
  for (const metadata of [{ staleLocalRegistration: false }, { replacedByAgentId: "different" }, { lastError: "new failure" }]) {
    expect(registrySubstanceChanged("endpoint", before, { ...after, metadata: { ...after.metadata, ...metadata } })).toBe(true);
  }
  expect(registrySubstanceChanged("endpoint", { state: "idle", metadata: { lastError: "offline" } }, { state: "idle", metadata: { lastError: "offline", lastFailedAt: 1 } })).toBe(true);
  expect(registrySubstanceChanged("actor", { metadata: { staleAt: 1 } }, { metadata: { staleAt: 2 } })).toBe(true);
});

test("a substance key ignores liveness and key order but not state", () => {
  const endpoint = { id: "e1", state: "idle", metadata: { lastSeenAt: 1, source: "local" } };
  expect(registrySubstanceKey("endpoint", { metadata: { source: "local", lastSeenAt: 2 }, state: "idle", id: "e1" }))
    .toBe(registrySubstanceKey("endpoint", endpoint));
  expect(registrySubstanceKey("endpoint", { ...endpoint, state: "offline" })).not.toBe(registrySubstanceKey("endpoint", endpoint));
  expect(registrySubstanceKey("agent", undefined)).toBe("");
});
