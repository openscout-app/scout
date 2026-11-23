/**
 * The runtime's side of turn credentials: issue one when it dispatches an
 * agent turn for an ask, and verify one presented back, including that the
 * turn is still live. The wire form and offline check live in
 * @openscout/protocol (turn-credentials.ts).
 */
import { randomBytes } from "node:crypto";
import {
  DEFAULT_TURN_SCOPE,
  TURN_CREDENTIAL_PROTOCOL,
  TURN_CREDENTIAL_TTL_MS,
  TURN_SCOPE_METADATA_KEY,
  TurnCredentialError,
  checkTurnCredentialTime,
  decodeTurnCredential,
  encodeTurnCredential,
  isAccessAction,
  turnCredentialSigningInput,
  type AccessAction,
  type FlightRecord,
  type InvocationRequest,
  type ScoutReplyContext,
  type TurnCredentialClaims,
} from "@openscout/protocol";

import { brokerAttributionFromMetadata } from "./broker-attribution.js";
import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";
import { nodeKeyId, signNodePayload, verifyNodeSignature, type NodeIdentity } from "./node-identity-wire.js";

/**
 * The scope an ask requests. Absent means the default scope. A present but
 * malformed value narrows to nothing rather than widening to the default.
 */
export function requestedTurnScope(invocation: Pick<InvocationRequest, "metadata">): AccessAction[] {
  const raw = invocation.metadata?.[TURN_SCOPE_METADATA_KEY];
  if (raw === undefined) return [...DEFAULT_TURN_SCOPE];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isAccessAction))];
}

export type TurnCredentialIssueInput = {
  identity: NodeIdentity;
  nodeId: string;
  invocation: InvocationRequest;
  flight: Pick<FlightRecord, "id" | "invocationId" | "targetAgentId">;
  now?: number;
  ttlMs?: number;
};

export function issueTurnCredential(input: TurnCredentialIssueInput): { credential: string; claims: TurnCredentialClaims } {
  const now = input.now ?? Date.now();
  if (input.flight.invocationId !== input.invocation.id) throw new TurnCredentialError("turn_not_live", "flight does not belong to the invocation");
  const attribution = brokerAttributionFromMetadata(input.invocation.metadata);
  const claims: TurnCredentialClaims = {
    protocol: TURN_CREDENTIAL_PROTOCOL,
    id: `turn-${randomBytes(12).toString("hex")}`,
    issuerKeyId: nodeKeyId(input.identity.publicKey),
    nodeId: input.nodeId,
    invocationId: input.invocation.id,
    flightId: input.flight.id,
    agentId: input.flight.targetAgentId,
    // No verified attribution means the runtime cannot vouch for the asker.
    initiatorId: attribution?.rootActorId ?? input.invocation.requesterId,
    initiatorSource: attribution?.source ?? "unverified",
    scope: requestedTurnScope(input.invocation),
    issuedAt: now,
    expiresAt: now + Math.min(input.ttlMs ?? TURN_CREDENTIAL_TTL_MS, TURN_CREDENTIAL_TTL_MS),
  };
  const signature = Buffer.from(signNodePayload(input.identity, Buffer.from(turnCredentialSigningInput(claims))), "base64");
  return { credential: encodeTurnCredential(claims, signature), claims };
}

export type TurnCredentialVerifyInput = {
  publicKey: string;
  nodeId: string;
  flight: (flightId: string) => Pick<FlightRecord, "id" | "invocationId" | "targetAgentId" | "state"> | undefined;
  now?: number;
};

/** Signature, issuer, time, and that the flight is still running for the same agent. */
export function verifyTurnCredential(token: unknown, input: TurnCredentialVerifyInput): TurnCredentialClaims {
  const { claims, signedBytes, signature } = decodeTurnCredential(token);
  if (claims.issuerKeyId !== nodeKeyId(input.publicKey) || claims.nodeId !== input.nodeId) {
    throw new TurnCredentialError("turn_credential_issuer", "turn credential was issued by another runtime");
  }
  if (!verifyNodeSignature(input.publicKey, Buffer.from(signedBytes), Buffer.from(signature).toString("base64"))) {
    throw new TurnCredentialError("turn_credential_signature", "turn credential signature does not verify");
  }
  checkTurnCredentialTime(claims, input.now ?? Date.now());
  const flight = input.flight(claims.flightId);
  if (!flight || flight.invocationId !== claims.invocationId || flight.targetAgentId !== claims.agentId || isTerminalFlightState(flight.state)) {
    throw new TurnCredentialError("turn_not_live", "the turn's flight has ended or does not match");
  }
  return claims;
}

/**
 * The runtime installs one issuer at startup; prompt and reply-context builders
 * attach its credential to a dispatched turn. With none installed (tests,
 * embedded use) turns carry no credential.
 */
export type TurnCredentialIssuer = (invocation: InvocationRequest) => NonNullable<ScoutReplyContext["turn"]> | undefined;
let installedIssuer: TurnCredentialIssuer | undefined;

export function installTurnCredentialIssuer(issuer: TurnCredentialIssuer | undefined): void {
  installedIssuer = issuer;
}

export function turnCredentialForInvocation(invocation: InvocationRequest): ScoutReplyContext["turn"] {
  try { return installedIssuer?.(invocation); } catch { return undefined; }
}

/** Issuer for a runtime: finds the invocation's flight and signs with the node key. */
export function createTurnCredentialIssuer(input: {
  identity: NodeIdentity;
  nodeId: () => string;
  flightForInvocation: (invocationId: string) => Pick<FlightRecord, "id" | "invocationId" | "targetAgentId" | "state"> | undefined;
  now?: () => number;
}): TurnCredentialIssuer {
  return (invocation) => {
    const flight = input.flightForInvocation(invocation.id);
    if (!flight || isTerminalFlightState(flight.state)) return undefined;
    const { credential, claims } = issueTurnCredential({ identity: input.identity, nodeId: input.nodeId(), invocation, flight, now: input.now?.() });
    return { credential, flightId: claims.flightId, expiresAt: claims.expiresAt };
  };
}
