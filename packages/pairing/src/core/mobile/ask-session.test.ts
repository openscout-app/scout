import { describe, expect, test } from "bun:test";

import type { ScoutAskResult } from "../broker/service.ts";
import { askMobileHarnessSession } from "./ask-session.ts";
import { mobileAskSessionInputSchema } from "../pairing/runtime/bridge/router.ts";

const SOURCE = "4fad8bb9-b4d3-4432-be75-8cfd636e78c0";
const FORK = "9b1c2d3e-0000-4000-8000-000000000001";

function fakeAsk(result: ScoutAskResult) {
  const calls: Array<Parameters<typeof import("../broker/service.ts").askScoutQuestion>[0]> = [];
  const ask = (async (input) => {
    calls.push(input);
    return result;
  }) as typeof import("../broker/service.ts").askScoutQuestion;
  return { ask, calls };
}

describe("mobile.askSession", () => {
  test("resumes a session nothing holds with an exact-session ask that never forks", async () => {
    const { ask, calls } = fakeAsk({ usedBroker: true, conversationId: "dm.1", messageId: "msg.1", targetSessionId: SOURCE, flight: { id: "flt.1" } as never });
    const result = await askMobileHarnessSession(
      { sessionId: ` ${SOURCE} `, harness: "claude", cwd: "/Users/you/dev/openscout", body: " keep going ", clientMessageId: "c-1" },
      { ask, senderId: "art" },
    );
    expect(calls).toEqual([{
      senderId: "art",
      target: { kind: "session_id", sessionId: SOURCE, harness: "claude", forkIfLive: false },
      body: "keep going",
      sessionDelivery: "in_place_or_resume",
      clientMessageId: "c-1",
      currentDirectory: "/Users/you/dev/openscout",
      source: "scout-mobile",
    }]);
    expect(result).toEqual({ ok: true, mode: "resumed", delivery: "resumed", sessionId: SOURCE, sourceSessionId: SOURCE, conversationId: "dm.1", flightId: "flt.1", messageId: "msg.1" });
  });

  test("reports a fork when the broker delivered to a different session", async () => {
    const { ask } = fakeAsk({ usedBroker: true, conversationId: "dm.1", messageId: "msg.1", targetSessionId: FORK, flight: { id: "flt.1" } as never });
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "claude", body: "hi", clientMessageId: "c-1" }, { ask, senderId: "art" }))
      .toMatchObject({ ok: true, mode: "forked", sessionId: FORK, sourceSessionId: SOURCE });
  });

  test("turns known wake refusals into plain operator messages", async () => {
    for (const [code, fragment] of [
      ["session_unknown", "couldn't find this session"],
      ["session_live_fork_unsupported", "Close it there"],
      ["session_cwd_conflict", "different folder"],
    ] as const) {
      const { ask } = fakeAsk({
        usedBroker: true,
        unresolvedTarget: `session:claude:${SOURCE}`,
        targetDiagnostic: { agentId: `session:claude:${SOURCE}`, state: "unknown", registrationKind: null, projectRoot: null, sessionWakeReason: code, detail: "raw" },
      });
      const result = await askMobileHarnessSession({ sessionId: SOURCE, harness: "claude", body: "hi", clientMessageId: "c-1" }, { ask, senderId: "art" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.message).toContain(fragment);
      }
    }
  });

  test("does not throw for a missing broker, an empty body, or an unexpected failure", async () => {
    const offline = fakeAsk({ usedBroker: false, unresolvedTarget: "x" });
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "hi", clientMessageId: "c-1" }, { ask: offline.ask, senderId: "art" }))
      .toMatchObject({ ok: false, code: "broker_unavailable" });

    const empty = fakeAsk({ usedBroker: true });
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "   ", clientMessageId: "c-1" }, { ask: empty.ask, senderId: "art" }))
      .toMatchObject({ ok: false, code: "empty_body" });
    expect(empty.calls).toHaveLength(0);

    const thrown = (async () => { throw new Error("socket closed"); }) as unknown as typeof import("../broker/service.ts").askScoutQuestion;
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "hi", clientMessageId: "c-1" }, { ask: thrown, senderId: "art" }))
      .toMatchObject({ ok: false, code: "delivery_unconfirmed" });
  });

  test("router input schema accepts the phone payload and rejects a missing session id", () => {
    expect(mobileAskSessionInputSchema.safeParse({ sessionId: SOURCE, harness: "claude", cwd: null, body: "hi", clientMessageId: "c-1" }).success).toBe(true);
    expect(mobileAskSessionInputSchema.safeParse({ sessionId: "", harness: "claude", body: "hi", clientMessageId: "c-1" }).success).toBe(false);
  });

  test("a Codex resume keeps fork-if-live, which only refuses a thread open elsewhere", async () => {
    const { ask, calls } = fakeAsk({ usedBroker: true, conversationId: "dm.1", targetSessionId: SOURCE });
    await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "hi", clientMessageId: "c-1" }, { ask, senderId: "art" });
    expect(calls[0]?.target).toMatchObject({ kind: "session_id", harness: "codex", forkIfLive: true });
  });

  test("a live session receipt comes through the broker with a stable key and no execution flight", async () => {
    const { ask, calls } = fakeAsk({ usedBroker: true, conversationId: "dm.1", messageId: "msg.1",
      inputSubmitted: { kind: "in_place", state: "submitted", sessionId: SOURCE, harness: "claude", via: "herdr", location: "pane1" } });
    const input = { sessionId: SOURCE, harness: "claude", body: "keep going", clientMessageId: "retained-key" };
    const result = await askMobileHarnessSession(input, { ask, senderId: "art" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionDelivery: "in_place_or_resume", clientMessageId: "retained-key", body: "keep going" });
    expect(result).toEqual({ ok: true, mode: "resumed", delivery: "in_place", via: "herdr", location: "pane1", sessionId: SOURCE, sourceSessionId: SOURCE, conversationId: "dm.1", messageId: "msg.1" });
    expect(await askMobileHarnessSession(input, { ask, senderId: "art" })).toEqual(result);
    expect(calls[1]).toEqual(calls[0]);
  });

  test("refuses missing key or unobserved harness without submitting", async () => {
    const { ask, calls } = fakeAsk({ usedBroker: true });
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "claude", body: "hi" }, { ask, senderId: "art" }))
      .toMatchObject({ ok: false, code: "request_id_required" });
    expect(await askMobileHarnessSession({ sessionId: SOURCE, body: "hi", clientMessageId: "c-1" }, { ask, senderId: "art" }))
      .toMatchObject({ ok: false, code: "session_not_resumable" });
    expect(calls).toHaveLength(0);
  });

  test("unknown submission is never reported as nothing sent or retried under another key", async () => {
    let calls = 0;
    const ask = (async () => { calls++; throw new Error("request_outcome_unknown: keep original request"); }) as typeof import("../broker/service.ts").askScoutQuestion;
    const result = await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "hi", clientMessageId: "c-1" }, { ask, senderId: "art" });
    expect(result).toMatchObject({ ok: false, code: "request_outcome_unknown" });
    expect(calls).toBe(1);
    if (!result.ok) expect(result.message).not.toContain("nothing was sent");
  });

  test("a no-flight acceptance without a matching input receipt remains unconfirmed", async () => {
    for (const result of [{ usedBroker: true, conversationId: "dm.1" }, { usedBroker: true, conversationId: "dm.1",
      inputSubmitted: { kind: "in_place", state: "submitted", sessionId: "wrong", harness: "claude", via: "tmux", location: "%3" } }] as ScoutAskResult[]) {
      expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "claude", body: "hi", clientMessageId: "c-1" }, { ask: fakeAsk(result).ask, senderId: "art" }))
        .toMatchObject({ ok: false, code: "delivery_unconfirmed" });
    }
  });
});
