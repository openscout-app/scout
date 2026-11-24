import { runtimeFetch } from "./cli-context.ts";
import { randomBytes } from "node:crypto";

import type {
  TrustedPeerRecord,
  TrustedPeerTier,
} from "@openscout/protocol";
import {
  TrustEnrollmentService,
  createEnrollmentCommitment,
  enrollViaSsh,
  formatSas,
  grantFromVerifiedCard,
  verifySignedNodeCard,
  type EnrollmentSessionSummary,
  type SignedNodeCard,
  type SshExec,
  type SshEnrollResult,
  type TrustedPeerGrant,
} from "@openscout/runtime/mesh";

/**
 * Mesh trust cone CLI service (docs/proposals/mesh-trust-cone.md §7): thin
 * HTTP client for the broker's trust operator routes plus the initiator side
 * of the SAS enrollment handshake. All broker calls hit loopback-only local
 * routes; the only remote calls are the peer's public enrollment routes.
 *
 * Every function takes an injectable fetch so tests can stub the wire.
 */

export type MeshTrustFetch = typeof fetch;

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
};

async function requestJson(
  fetchImpl: MeshTrustFetch,
  url: string,
  options: RequestOptions = {},
): Promise<unknown> {
  let response: Awaited<ReturnType<MeshTrustFetch>>;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json", accept: "application/json" },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    throw new Error(
      "could not reach mesh HTTP endpoint",
    );
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload
      ? String((payload as { detail: unknown }).detail)
      : payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : text || `HTTP ${response.status}`;
    throw new Error(`mesh HTTP request refused (${response.status})`);
  }
  return payload;
}

function brokerUrlFor(brokerUrl: string, path: string): string {
  return new URL(path, brokerUrl).toString();
}

function peerUrlFor(peerUrl: string, path: string): string {
  const base = /^\w+:\/\//.test(peerUrl) ? peerUrl : `http://${peerUrl}`;
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/* ── Operator routes (local broker) ── */

export async function listMeshTrustedPeers(
  brokerUrl: string,
  fetchImpl: MeshTrustFetch = runtimeFetch,
): Promise<TrustedPeerRecord[]> {
  const payload = await requestJson(fetchImpl, brokerUrlFor(brokerUrl, "/v1/trust/peers")) as {
    peers: TrustedPeerRecord[];
  };
  return payload.peers;
}

export async function revokeMeshTrustedPeer(
  brokerUrl: string,
  keyId: string,
  fetchImpl: MeshTrustFetch = runtimeFetch,
): Promise<void> {
  await requestJson(fetchImpl, brokerUrlFor(brokerUrl, "/v1/trust/revoke"), {
    method: "POST",
    body: { keyId },
  });
}

/** Adjust an existing peer's tier (and optionally label) — `scout mesh grant`. */
export async function grantMeshTrustedPeer(
  brokerUrl: string,
  input: { keyId: string; tier: TrustedPeerTier; label?: string },
  fetchImpl: MeshTrustFetch = runtimeFetch,
): Promise<TrustedPeerRecord> {
  const payload = await requestJson(fetchImpl, brokerUrlFor(brokerUrl, "/v1/trust/grant"), {
    method: "POST",
    body: input,
  }) as { peer: TrustedPeerRecord };
  return payload.peer;
}

/** This node's trust identity + gate rollout mode, from the public node route. */
export async function readMeshNodeTrust(
  brokerUrl: string,
  fetchImpl: MeshTrustFetch = runtimeFetch,
): Promise<{ card: SignedNodeCard | null; gateMode: string | null }> {
  const payload = await requestJson(fetchImpl, brokerUrlFor(brokerUrl, "/v1/node")) as {
    card?: SignedNodeCard;
    gateMode?: string;
  };
  return { card: payload.card ?? null, gateMode: payload.gateMode ?? null };
}

/**
 * Install a grant from a verified signed node card (SSH install-grant / local
 * half of mutual SSH enroll). Verifies the card, then POSTs the direct-grant
 * shape to the loopback-only broker route with grantedVia + optional TLS pin.
 */
export async function installMeshGrantFromCard(
  brokerUrl: string,
  card: SignedNodeCard,
  tier: TrustedPeerTier,
  fetchImpl: MeshTrustFetch = runtimeFetch,
  now: number = Date.now(),
): Promise<TrustedPeerRecord> {
  if (!verifySignedNodeCard(card, now)) {
    throw new Error("node card failed verification; refusing to install grant");
  }
  const grant = grantFromVerifiedCard(card, { tier, grantedAt: now });
  const payload = await requestJson(fetchImpl, brokerUrlFor(brokerUrl, "/v1/trust/grant"), {
    method: "POST",
    body: {
      keyId: grant.keyId,
      publicKey: grant.publicKey,
      fingerprint: grant.fingerprint,
      ...(grant.nodeId ? { nodeId: grant.nodeId } : {}),
      label: grant.label,
      tier: grant.tier,
      grantedVia: grant.grantedVia,
      ...(grant.tlsSpkiFingerprint ? { tlsSpkiFingerprint: grant.tlsSpkiFingerprint } : {}),
    },
  }) as { peer: TrustedPeerRecord };
  return payload.peer;
}

/**
 * Mutual SSH enrollment (§3c): exchange cards over ssh, install remote grant
 * on the peer first, then install the local grant for the peer.
 */
export async function enrollMeshViaSsh(input: {
  brokerUrl: string;
  target: string;
  tier: TrustedPeerTier;
  fetchImpl?: MeshTrustFetch;
  exec?: SshExec;
  timeoutMs?: number;
}): Promise<{ result: SshEnrollResult; peer: TrustedPeerRecord }> {
  const fetchImpl = input.fetchImpl ?? runtimeFetch;
  const localTrust = await readMeshNodeTrust(input.brokerUrl, fetchImpl);
  if (!localTrust.card) {
    throw new Error(
      "the local broker does not publish a signed node card; restart it on a build with mesh trust support",
    );
  }

  const result = await enrollViaSsh({
    target: input.target,
    localCard: localTrust.card,
    tier: input.tier,
    exec: input.exec,
    timeoutMs: input.timeoutMs,
  });

  // Local grant only after remote accepted (enrollViaSsh ordering).
  const peer = await installMeshGrantFromCard(
    input.brokerUrl,
    result.remoteCard,
    input.tier,
    fetchImpl,
  );
  return { result, peer };
}

/* ── Responder-side enrollment (this node was begun by a peer) ── */

export async function listMeshEnrollmentSessions(
  brokerUrl: string,
  fetchImpl: MeshTrustFetch = runtimeFetch,
): Promise<EnrollmentSessionSummary[]> {
  const payload = await requestJson(
    fetchImpl,
    brokerUrlFor(brokerUrl, "/v1/trust/enroll/sessions"),
  ) as { sessions: EnrollmentSessionSummary[] };
  return payload.sessions;
}

export async function approveMeshEnrollment(
  brokerUrl: string,
  enrollmentId: string,
  tier: TrustedPeerTier,
  fetchImpl: MeshTrustFetch = runtimeFetch,
): Promise<TrustedPeerGrant> {
  const payload = await requestJson(
    fetchImpl,
    brokerUrlFor(brokerUrl, "/v1/trust/enroll/approve"),
    { method: "POST", body: { enrollmentId, tier } },
  ) as { grant: TrustedPeerGrant };
  return payload.grant;
}

/* ── Initiator-side enrollment handshake ── */

/**
 * Everything the initiator learns from a completed begin/reveal handshake.
 * Persisted between the `scout mesh enroll <url>` and `--confirm-sas`
 * invocations so the operator can compare words before granting.
 */
export type MeshEnrollmentHandshake = {
  version: 1;
  peerUrl: string;
  enrollmentId: string;
  tier: TrustedPeerTier;
  /** locally computed SAS — the words the operator compares with the peer's screen */
  words: string[];
  local: { keyId: string; fingerprint: string; label: string };
  remote: { keyId: string; fingerprint: string; label: string; nodeId: string };
  /** body for the local direct-grant route on confirmation (minus tier) */
  grant: {
    keyId: string;
    publicKey: string;
    fingerprint: string;
    nodeId?: string;
    label: string;
  };
  createdAt: number;
};

export async function beginMeshEnrollment(input: {
  brokerUrl: string;
  peerUrl: string;
  tier: TrustedPeerTier;
  fetchImpl?: MeshTrustFetch;
  /** injectable for tests */
  nonce?: Buffer;
}): Promise<MeshEnrollmentHandshake> {
  const fetchImpl = input.fetchImpl ?? runtimeFetch;

  const localTrust = await readMeshNodeTrust(input.brokerUrl, fetchImpl);
  if (!localTrust.card) {
    throw new Error(
      "the local broker does not publish a signed node card; restart it on a build with mesh trust support",
    );
  }
  const localCard = localTrust.card;

  const nonce = input.nonce ?? randomBytes(32);
  const begun = await requestJson(
    fetchImpl,
    peerUrlFor(input.peerUrl, "/v1/trust/enroll/begin"),
    {
      method: "POST",
      body: {
        card: localCard,
        commitment: createEnrollmentCommitment(nonce, localCard.signature),
      },
    },
  ) as { enrollmentId: string; responderNonce: string; card: SignedNodeCard };

  const responderCard = begun.card;
  if (!responderCard || !verifySignedNodeCard(responderCard)) {
    throw new Error("the peer returned an invalid node card; aborting enrollment");
  }

  const revealed = await requestJson(
    fetchImpl,
    peerUrlFor(input.peerUrl, "/v1/trust/enroll/reveal"),
    {
      method: "POST",
      body: { enrollmentId: begun.enrollmentId, nonce: nonce.toString("base64") },
    },
  ) as { sasWords: string[] };

  // The SAS is computed locally from the same transcript — never trust the
  // peer to tell us the words.
  const words = TrustEnrollmentService.initiatorSas({
    challengeId: begun.enrollmentId,
    ownCard: localCard,
    ownNonce: nonce,
    responderCard,
    responderNonce: Buffer.from(begun.responderNonce, "base64"),
  });
  if (formatSas(words) !== formatSas(revealed.sasWords ?? [])) {
    throw new Error("the peer computed different SAS words; aborting enrollment");
  }

  return {
    version: 1,
    peerUrl: input.peerUrl,
    enrollmentId: begun.enrollmentId,
    tier: input.tier,
    words,
    local: {
      keyId: localCard.keyId,
      fingerprint: localCard.fingerprint,
      label: localCard.label,
    },
    remote: {
      keyId: responderCard.keyId,
      fingerprint: responderCard.fingerprint,
      label: responderCard.label,
      nodeId: responderCard.nodeId,
    },
    grant: {
      keyId: responderCard.keyId,
      publicKey: responderCard.publicKey,
      fingerprint: responderCard.fingerprint,
      nodeId: responderCard.nodeId,
      label: responderCard.label,
    },
    createdAt: Date.now(),
  };
}

/** Normalize operator-typed SAS words for comparison (any spacing/dashes/case). */
export function normalizeSasWords(value: string): string[] {
  // EFF v1 has one hyphenated word. Preserve it before treating other dashes
  // as separators, including when the entire six-word SAS is dash-joined.
  return value.trim().toLowerCase().match(/yo-yo(?=$|[\s-])|[^\s-]+/g) ?? [];
}

/**
 * Confirmation step: verifies the operator-typed words against the locally
 * computed SAS, then installs the grant on the local broker via the
 * loopback-only direct-grant route.
 */
export async function confirmMeshEnrollment(
  brokerUrl: string,
  handshake: MeshEnrollmentHandshake,
  confirmedWords?: string,
  fetchImpl: MeshTrustFetch = runtimeFetch,
): Promise<TrustedPeerRecord> {
  if (confirmedWords !== undefined) {
    const typed = normalizeSasWords(confirmedWords);
    if (typed.join(" ") !== handshake.words.join(" ")) {
      throw new Error(
        "the words you entered do not match this enrollment; do not approve — start over with `scout mesh enroll`",
      );
    }
  }
  const payload = await requestJson(fetchImpl, brokerUrlFor(brokerUrl, "/v1/trust/grant"), {
    method: "POST",
    body: { ...handshake.grant, tier: handshake.tier },
  }) as { peer: TrustedPeerRecord };
  return payload.peer;
}
