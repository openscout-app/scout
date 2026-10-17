import { describe, expect, test } from "bun:test";
import { resolveT3TurnResult } from "./turn-result.js";

const SOURCE_TIME = "2026-10-17T20:00:00.007Z";
const source = { id: "scout-user", role: "user", text: "request", createdAt: SOURCE_TIME, turnId: null };
const final = { id: "assistant", role: "assistant", turnId: "turn", streaming: false, text: "Exact result" };
const completed = { turnId: "turn", state: "completed", requestedAt: SOURCE_TIME, assistantMessageId: "assistant" };
const snapshot = (patch: Record<string, unknown> = {}) => ({ messages: [source, final], latestTurn: completed, checkpoints: [], ...patch });

describe("T3 exact source turn result", () => {
  test("uses the exact accepted user ID and T3's canonical message timestamp", () => {
    expect(resolveT3TurnResult(snapshot(), { messageId: "scout-user" })).toEqual({ turnId: "turn", state: "completed", output: "Exact result" });
    expect(resolveT3TurnResult(snapshot({ messages: [{ ...source, id: "foreign-user" }, final] }), { messageId: "scout-user" })).toEqual({ state: "unconfirmed" });
  });

  test("rejects a later turn's same-thread response", () => {
    expect(resolveT3TurnResult(snapshot({ latestTurn: { ...completed, turnId: "foreign", requestedAt: "2026-10-17T20:00:01.000Z" } }), { messageId: "scout-user" })).toEqual({ state: "unconfirmed" });
    expect(resolveT3TurnResult(snapshot({ messages: [source, { ...final, turnId: "foreign" }] }), { messageId: "scout-user" })).toEqual({ turnId: "turn", state: "waiting" });
  });

  test("never infers a binding from absent or malformed timestamps", () => {
    expect(resolveT3TurnResult(snapshot({ messages: [{ ...source, createdAt: undefined }, final], latestTurn: { ...completed, requestedAt: undefined } }), { messageId: "scout-user" })).toEqual({ state: "unconfirmed" });
    expect(resolveT3TurnResult(snapshot({ messages: [{ ...source, createdAt: "invalid" }, final], latestTurn: { ...completed, requestedAt: "invalid" } }), { messageId: "scout-user" })).toEqual({ state: "unconfirmed" });
  });

  test("retains a previously observed binding after latestTurn is replaced", () => {
    expect(resolveT3TurnResult(snapshot({ latestTurn: { ...completed, turnId: "newer" } }), { messageId: "scout-user", turnId: "turn" })).toEqual({ turnId: "turn", state: "waiting" });
    expect(resolveT3TurnResult(snapshot({ messages: [{ ...source, turnId: "different" }, final] }), { messageId: "scout-user", turnId: "turn" })).toEqual({ state: "unconfirmed" });
  });

  test.each([["error", "failed"], ["interrupted", "cancelled"], ["running", "running"]] as const)("maps source %s to %s", (sourceState, state) => {
    expect(resolveT3TurnResult(snapshot({ latestTurn: { ...completed, state: sourceState } }), { messageId: "scout-user" })).toEqual({ turnId: "turn", state });
  });

  test("a checkpoint created during a turn cannot establish completion", () => {
    const checkpoints = [{ turnId: "turn", status: "ready", assistantMessageId: "assistant", completedAt: SOURCE_TIME }];
    expect(resolveT3TurnResult(snapshot({ checkpoints, latestTurn: { ...completed, state: "running" } }), { messageId: "scout-user" })).toEqual({ turnId: "turn", state: "running" });
    expect(resolveT3TurnResult(snapshot({ checkpoints, latestTurn: { ...completed, turnId: "newer" } }), { messageId: "scout-user", turnId: "turn" })).toEqual({ turnId: "turn", state: "waiting" });
  });

  test("uses a checkpoint's exact assistant only after separate persisted terminal proof", () => {
    const checkpoints = [{ turnId: "turn", status: "ready", assistantMessageId: "assistant", completedAt: SOURCE_TIME }];
    expect(resolveT3TurnResult(snapshot({ checkpoints, latestTurn: { ...completed, turnId: "newer" } }), { messageId: "scout-user", turnId: "turn", terminalState: "completed" }))
      .toEqual({ turnId: "turn", state: "completed", output: "Exact result" });
    expect(resolveT3TurnResult(snapshot({ checkpoints, latestTurn: { ...completed, turnId: "newer" }, messages: [source, { ...final, streaming: true }] }), { messageId: "scout-user", turnId: "turn", terminalState: "completed" }))
      .toEqual({ turnId: "turn", state: "waiting" });
  });
});
