import { describe, expect, test } from "bun:test";
import { brokerAttributionFor, brokerAttributionFromMetadata, UNAUTHENTICATED_LOCAL_ACTOR_ID } from "./broker-attribution.js";

const people = new Set(["operator", "person-two"]);

describe("broker attribution", () => {
  test("an unverified person claim becomes a non-person local identity", () => {
    expect(brokerAttributionFor({ claimedActorId: "operator", context: { transport: "loopback" }, personActorIds: people })).toEqual({
      actorId: UNAUTHENTICATED_LOCAL_ACTOR_ID,
      rootActorId: UNAUTHENTICATED_LOCAL_ACTOR_ID,
      source: "unverified",
      claimedActorId: "operator",
    });
    expect(brokerAttributionFor({ claimedActorId: "person-two", context: { transport: "loopback" }, personActorIds: people }).actorId).toBe(UNAUTHENTICATED_LOCAL_ACTOR_ID);
  });

  test("an unverified agent keeps its own claimed identity, not a user identity", () => {
    expect(brokerAttributionFor({ claimedActorId: "fabric", context: { transport: "loopback" }, personActorIds: people })).toMatchObject({
      actorId: "fabric", rootActorId: "fabric", source: "unverified",
    });
  });

  test("local administration verifies the operator, not another person", () => {
    expect(brokerAttributionFor({ claimedActorId: "operator", context: { transport: "loopback", operator: true }, personActorIds: people })).toMatchObject({
      actorId: "operator", rootActorId: "operator", source: "local-admin",
    });
    expect(brokerAttributionFor({ claimedActorId: "person-two", context: { transport: "loopback", operator: true }, personActorIds: people })).toMatchObject({
      actorId: UNAUTHENTICATED_LOCAL_ACTOR_ID, claimedActorId: "person-two",
    });
  });

  test("a scoped principal overrides a claimed operator and carries the root", () => {
    const scoped = { networkId: "network", principalId: "person-principal", deviceId: "device", delegation: {} as never };
    expect(brokerAttributionFor({ claimedActorId: "operator", context: { transport: "remote", scoped }, personActorIds: people })).toMatchObject({
      actorId: "person-principal", rootActorId: "person-principal", source: "scoped", claimedActorId: "operator",
    });
  });

  test("mesh identities stay stable without becoming verified people", () => {
    for (const personActorIds of [new Set<string>(), people]) {
      expect(brokerAttributionFor({ claimedActorId: "operator", context: { transport: "loopback", operator: true }, personActorIds, unverifiedPeer: true })).toEqual({
        actorId: "operator", rootActorId: "operator", source: "unverified",
      });
    }
  });

  test("a runtime parent carries the original actor through delegation", () => {
    const parent = { actorId: "operator", rootActorId: "operator", source: "local-admin" as const };
    const child = brokerAttributionFor({ claimedActorId: "fabric", context: { transport: "loopback" }, personActorIds: people, parent });
    expect(child).toMatchObject({ actorId: "fabric", rootActorId: "operator", source: "unverified" });
    expect(brokerAttributionFromMetadata({ attribution: child })).toEqual(child);
    expect(brokerAttributionFromMetadata({ attribution: { actorId: "operator" } })).toBeUndefined();
  });
});
