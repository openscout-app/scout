import { isDeepStrictEqual } from "node:util";

export type RegistryRecordKind = "node" | "actor" | "agent" | "endpoint";

/** Explicit liveness allowlist, NOT a recursive timestamp scrubber. In particular
 * registeredAt, createdAt, updatedAt, keys, state and observation evidence matter.
 * A node update that is liveness only stays in memory; the journal is
 * rewritten only as its signed card nears expiry (isNodeLivenessOnlyUpdate). */
function substantiveRecord(kind: RegistryRecordKind, record: object, renewal: boolean, repeatedFailure: boolean): unknown {
  const value = { ...record } as Record<string, unknown>;
  if (kind === "node") {
    delete value.lastSeenAt;
    if (renewal) {
      const card = { ...(value.card as Record<string, unknown>) };
      for (const field of ["issuedAt", "expiresAt", "nonce", "signature"]) delete card[field];
      value.card = card;
    }
    if (Array.isArray(value.meshEntrypoints)) {
      value.meshEntrypoints = value.meshEntrypoints.map((entry) => {
        const copy = { ...entry };
        delete copy.lastSeenAt;
        return copy;
      });
    }
  }
  if (value.metadata && typeof value.metadata === "object") {
    const metadata = { ...value.metadata } as Record<string, unknown>;
    delete metadata.lastSeenAt;
    // Re-observing an already-stale registration is a heartbeat. The flags,
    // replacement identity and peer origin remain substantive.
    if (metadata.staleLocalRegistration === true || metadata.staleMeshRegistration === true) delete metadata.staleAt;
    if (kind === "endpoint" && repeatedFailure) delete metadata.lastFailedAt;
    // scout-channel repeats its connection stamp with each heartbeat. For all
    // other sources startedAt remains lifecycle evidence, not liveness.
    if (kind === "endpoint" && metadata.source === "scout-channel") delete metadata.startedAt;
    value.metadata = metadata;
  }
  return normalize(value);
}

function normalize(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, normalize(v)] as const)
    .filter(([k, v]) => k !== "metadata" || v == null || Object.keys(v as object).length > 0);
  return Object.fromEntries(entries);
}

export function registrySubstanceChanged(kind: RegistryRecordKind, previous: object | undefined, next: object): boolean {
  if (!previous) return true;
  const before = previous as Record<string, any>, after = next as Record<string, any>;
  const renewal = kind === "node" && renewedCard(before.card, after.card);
  const repeatedFailure = kind === "endpoint" && Number.isFinite(before.metadata?.lastFailedAt) && Number.isFinite(after.metadata?.lastFailedAt);
  return !isDeepStrictEqual(substantiveRecord(kind, previous, renewal, repeatedFailure), substantiveRecord(kind, next, renewal, repeatedFailure));
}

/** Node discovery signs a fresh envelope on every heartbeat. Ignore only a
 * forward renewal with unchanged TTL, never key/claim changes, a policy change,
 * a signature-only mutation, or a card appearing/disappearing. Verification and
 * snapshot/journal storage still receive the complete new signed card. */
function renewedCard(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): boolean {
  if (!before || !after) return false;
  const a = before.issuedAt, b = before.expiresAt, c = after.issuedAt, d = after.expiresAt;
  return typeof a === "number" && typeof b === "number" && typeof c === "number" && typeof d === "number"
    && [a, b, c, d].every(Number.isFinite) && b > a && c > a && d > b && b - a === d - c
    && typeof before.nonce === "string" && typeof after.nonce === "string" && before.nonce !== after.nonce
    && typeof before.signature === "string" && typeof after.signature === "string" && before.signature !== after.signature;
}
