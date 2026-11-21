import { describe, expect, test } from "bun:test";

import { OPERATOR_NEED_MAX_AGE_MS, pendingOperatorNeeds, type OperatorNeedMessage } from "./operator-needs.ts";

const NOW = 1_790_000_000_000;

function need(id: string, conversationId: string, createdAt: number, signal: Record<string, unknown> = {}): OperatorNeedMessage {
  return {
    id, conversationId, actorId: "session-a", body: "Red or blue?", createdAt,
    metadata: { operatorSignal: { kind: "need", blocking: true, replyExpectation: "required", question: "Red or blue?", ...signal } },
  };
}

function reply(conversationId: string, createdAt: number, actorId = "operator"): OperatorNeedMessage {
  return { id: `reply-${createdAt}`, conversationId, actorId, body: "Dogs", createdAt };
}

describe("pendingOperatorNeeds", () => {
  test("a need stays pending until the operator speaks after it in that conversation", () => {
    const messages = [
      need("m1", "c1", NOW - 5_000, { options: ["red", " blue ", ""], blockedReason: "test job" }),
      need("m2", "c2", NOW - 4_000, { question: "Cats or dogs?" }),
      reply("c2", NOW - 3_000),
    ];
    expect(pendingOperatorNeeds({ messages, operatorIds: ["operator"], now: NOW })).toEqual([{
      messageId: "m1", conversationId: "c1", actorId: "session-a", question: "Red or blue?",
      options: ["red", "blue"], blockedReason: "test job", createdAt: NOW - 5_000,
    }]);
  });

  test("carries a declared permission request kind", () => {
    const messages = [need("m1", "c1", NOW - 5_000, { requestKind: "permission" }), need("m2", "c2", NOW - 4_000)];
    const needs = pendingOperatorNeeds({ messages, operatorIds: ["operator"], now: NOW });
    expect(needs.find((n) => n.messageId === "m1")?.permission).toBe(true);
    expect(needs.find((n) => n.messageId === "m2")?.permission).toBeUndefined();
  });

  test("an operator message before the need does not answer it, whatever the input order", () => {
    const messages = [reply("c1", NOW - 1_000), need("m1", "c1", NOW - 500), reply("c1", NOW - 2_000)];
    expect(pendingOperatorNeeds({ messages, operatorIds: ["operator"], now: NOW }).map((n) => n.messageId)).toEqual(["m1"]);
  });

  test("the configured operator name counts as the operator", () => {
    const messages = [need("m1", "c1", NOW - 500), reply("c1", NOW - 100, "arach")];
    expect(pendingOperatorNeeds({ messages, operatorIds: ["arach", "operator"], now: NOW })).toEqual([]);
  });

  test("an unverified local reply that claims the operator answers the need", () => {
    const messages = [
      need("m1", "c1", NOW - 500),
      {
        ...reply("c1", NOW - 100, "local-unverified"),
        metadata: { source: "scout-mobile", attribution: { actorId: "local-unverified", rootActorId: "local-unverified", source: "unverified", claimedActorId: "operator" } },
      },
    ];
    expect(pendingOperatorNeeds({ messages, operatorIds: ["arach", "operator"], now: NOW })).toEqual([]);
  });

  test("a claim of the operator does not answer the need from a sender with its own identity", () => {
    const claim = (actorId: string, claimedActorId?: string): OperatorNeedMessage => ({
      ...reply("c1", NOW - 100, actorId),
      metadata: { attribution: { actorId, rootActorId: actorId, source: "scoped", ...(claimedActorId ? { claimedActorId } : {}) } },
    });
    for (const later of [claim("session-b", "operator"), claim("local-unverified"), claim("local-unverified", "session-b")]) {
      expect(pendingOperatorNeeds({ messages: [need("m1", "c1", NOW - 500), later], operatorIds: ["operator"], now: NOW })
        .map((n) => n.messageId)).toEqual(["m1"]);
    }
  });

  test("notify, consult, stale, blank and operator-authored signals are not needs", () => {
    const messages: OperatorNeedMessage[] = [
      need("notify", "c1", NOW, { kind: "notify" }),
      need("consult", "c1", NOW, { kind: "consult" }),
      need("stale", "c2", NOW - OPERATOR_NEED_MAX_AGE_MS - 1),
      { ...need("blank", "c3", NOW, { question: "  " }), body: "" },
      { ...need("own", "c4", NOW), actorId: "operator" },
      { id: "plain", conversationId: "c5", actorId: "session-a", body: "hi", createdAt: NOW },
    ];
    expect(pendingOperatorNeeds({ messages, operatorIds: ["operator"], now: NOW })).toEqual([]);
  });

  test("newest first", () => {
    const messages = [need("old", "c1", NOW - 9_000), need("new", "c2", NOW - 1_000)];
    expect(pendingOperatorNeeds({ messages, operatorIds: ["operator"], now: NOW }).map((n) => n.messageId)).toEqual(["new", "old"]);
  });
});
