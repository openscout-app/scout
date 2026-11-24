import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import {
  DEFAULT_TURN_SCOPE,
  accessTurnFromClaims,
  can,
  verifyTurnCredentialOffline,
  type ContentResource,
  type FlightRecord,
  type InvocationRequest,
  type PrincipalAgent,
} from "@openscout/protocol";

import { buildScoutReplyContext } from "./local-agents.js";
import { signNodePayload, type NodeIdentity } from "./node-identity-wire.js";
import {
  createTurnCredentialIssuer,
  installTurnCredentialIssuer,
  issueTurnCredential,
  requestedTurnScope,
  verifyTurnCredential,
} from "./turn-credentials.js";

const NOW = 1_800_000_000_000;

function identity(): NodeIdentity {
  const pair = generateKeyPairSync("ed25519");
  return {
    version: 1, createdAt: NOW,
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  } as NodeIdentity;
}

const invocation: InvocationRequest = {
  id: "inv-1",
  requesterId: "operator",
  requesterNodeId: "node-a",
  targetAgentId: "helper",
  action: "consult",
  task: "summarize the channel",
  conversationId: "chat-1",
  messageId: "msg-1",
  ensureAwake: true,
  stream: false,
  createdAt: NOW,
  metadata: { attribution: { actorId: "operator", rootActorId: "person:bea", source: "local-admin" } },
};
const running: FlightRecord = { id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "helper", state: "running", startedAt: NOW };

describe("turn credentials", () => {
  afterEach(() => installTurnCredentialIssuer(undefined));

  test("the runtime issues a credential bound to the flight, the agent and the asker", () => {
    const key = identity();
    const { credential, claims } = issueTurnCredential({ identity: key, nodeId: "node-a", invocation, flight: running, now: NOW });
    expect(claims).toMatchObject({ invocationId: "inv-1", flightId: "flt-1", agentId: "helper", initiatorId: "person:bea", initiatorSource: "local-admin", scope: [...DEFAULT_TURN_SCOPE] });
    expect(verifyTurnCredential(credential, { publicKey: key.publicKey, nodeId: "node-a", flight: () => running, now: NOW + 1 })).toEqual(claims);
  });

  test("an ask with no verified attribution yields an unverified initiator", () => {
    const { claims } = issueTurnCredential({ identity: identity(), nodeId: "node-a", invocation: { ...invocation, metadata: {} }, flight: running, now: NOW });
    expect(claims).toMatchObject({ initiatorId: "operator", initiatorSource: "unverified" });
  });

  test("a requested scope narrows the turn; a malformed one grants nothing", () => {
    expect(requestedTurnScope({ metadata: { accessScope: ["read", "bogus", "read"] } })).toEqual(["read"]);
    expect(requestedTurnScope({ metadata: { accessScope: "write" } })).toEqual([]);
    expect(requestedTurnScope({ metadata: {} })).toEqual([...DEFAULT_TURN_SCOPE]);
  });

  test("the credential dies with its flight and is refused by another runtime", () => {
    const key = identity();
    const { credential } = issueTurnCredential({ identity: key, nodeId: "node-a", invocation, flight: running, now: NOW });
    const check = (overrides: Partial<Parameters<typeof verifyTurnCredential>[1]>) => () =>
      verifyTurnCredential(credential, { publicKey: key.publicKey, nodeId: "node-a", flight: () => running, now: NOW + 1, ...overrides });
    expect(check({ flight: () => ({ ...running, state: "completed" }) })).toThrow(expect.objectContaining({ code: "turn_not_live" }));
    expect(check({ flight: () => undefined })).toThrow(expect.objectContaining({ code: "turn_not_live" }));
    expect(check({ flight: () => ({ ...running, targetAgentId: "other" }) })).toThrow(expect.objectContaining({ code: "turn_not_live" }));
    expect(check({ publicKey: identity().publicKey })).toThrow(expect.objectContaining({ code: "turn_credential_issuer" }));
    expect(check({ nodeId: "node-b" })).toThrow(expect.objectContaining({ code: "turn_credential_issuer" }));
    expect(check({ now: NOW + 2 * 60 * 60_000 })).toThrow(expect.objectContaining({ code: "turn_credential_expired" }));
  });

  test("a credential signed by another key under this node's key id is refused", () => {
    const key = identity();
    const { credential } = issueTurnCredential({ identity: key, nodeId: "node-a", invocation, flight: running, now: NOW });
    const [prefix, claims] = credential.split(".");
    const forged = Buffer.from(signNodePayload(identity(), Buffer.from(claims!, "base64url")), "base64").toString("base64url");
    expect(() => verifyTurnCredential(`${prefix}.${claims}.${forged}`, { publicKey: key.publicKey, nodeId: "node-a", flight: () => running, now: NOW }))
      .toThrow(expect.objectContaining({ code: "turn_credential_signature" }));
  });

  test("a verifier elsewhere checks a runtime credential offline with WebCrypto", async () => {
    const key = identity();
    const { credential, claims } = issueTurnCredential({ identity: key, nodeId: "node-a", invocation, flight: running, now: NOW });
    expect(await verifyTurnCredentialOffline(credential, key.publicKey, { now: NOW + 1 })).toEqual(claims);
  });

  test("the reply context of a dispatched turn carries its credential", () => {
    const key = identity();
    expect(buildScoutReplyContext("helper", invocation)?.turn).toBeUndefined();
    installTurnCredentialIssuer(createTurnCredentialIssuer({ identity: key, nodeId: () => "node-a", flightForInvocation: () => running, now: () => NOW }));
    const turn = buildScoutReplyContext("helper", invocation)?.turn;
    expect(turn).toMatchObject({ flightId: "flt-1", expiresAt: NOW + 60 * 60_000 });
    expect(verifyTurnCredential(turn!.credential, { publicKey: key.publicKey, nodeId: "node-a", flight: () => running, now: NOW }).flightId).toBe("flt-1");
    installTurnCredentialIssuer(createTurnCredentialIssuer({ identity: key, nodeId: () => "node-a", flightForInvocation: () => ({ ...running, state: "failed" }) }));
    expect(buildScoutReplyContext("helper", invocation)?.turn).toBeUndefined();
  });

  test("a verified turn caps the agent by its asker; no credential, no action", () => {
    const key = identity();
    const { credential } = issueTurnCredential({ identity: key, nodeId: "node-a", invocation, flight: running, now: NOW });
    const claims = verifyTurnCredential(credential, { publicKey: key.publicKey, nodeId: "node-a", flight: () => running, now: NOW });
    const channel: ContentResource = { kind: "content", id: "chat-1", roles: { "person:ada": "owner", "person:bea": "viewer" } };
    const helper: PrincipalAgent = { kind: "agent", id: "helper", owner: { kind: "person", id: "person:ada" }, grant: { actions: ["read", "write"] } };
    const turn = accessTurnFromClaims(claims, { kind: "person", id: claims.initiatorId });
    expect(can(helper, "read", channel, turn, { now: NOW })).toEqual({ effect: "allow" });
    expect(can(helper, "write", channel, turn, { now: NOW })).toEqual({ effect: "never", reason: "initiator_lacks_permission" });
    expect(can(helper, "write", channel, null, { now: NOW })).toEqual({ effect: "never", reason: "turn_required" });
  });
});
