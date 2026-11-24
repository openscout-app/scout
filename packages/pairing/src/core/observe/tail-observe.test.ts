import { describe, expect, test } from "bun:test";

import type { DiscoveredTranscript, TailEvent } from "@openscout/runtime/harnesses";

import { buildObserveDataFromTail } from "./tail-observe.ts";

const transcript: DiscoveredTranscript = {
  source: "kimi",
  transcriptPath: "/Users/test/.kimi-code/sessions/wd_repo/session_123/agents/main/wire.jsonl",
  sessionId: "session_123",
  cwd: "/repo",
  project: "repo",
  harness: "unattributed",
  mtimeMs: 1_700_000_000_000,
  size: 100,
};

function event(overrides: Partial<TailEvent>): TailEvent {
  return {
    id: "kimi:session_123:event",
    ts: 1_700_000_000_000,
    source: "kimi",
    sessionId: "session_123",
    pid: -1,
    parentPid: null,
    project: "repo",
    cwd: "/repo",
    harness: "unattributed",
    kind: "system",
    summary: "event",
    ...overrides,
  };
}

describe("buildObserveDataFromTail Kimi mapping", () => {
  test("maps thinking and clean-log tool activity", () => {
    const data = buildObserveDataFromTail(transcript, [
      event({
        id: "think",
        summary: "[thinking] Inspect the source registry.",
      }),
      event({
        id: "tool",
        ts: 1_700_000_001_000,
        kind: "tool",
        summary: "Read runtime/tail/service.ts",
      }),
      event({
        id: "result",
        ts: 1_700_000_002_000,
        kind: "tool-result",
        summary: "Read runtime/tail/service.ts -> res: export function refreshTailDiscovery",
      }),
    ], true);

    expect(data.events).toEqual([
      expect.objectContaining({ id: "think", kind: "think", text: "Inspect the source registry." }),
      expect.objectContaining({ id: "tool", kind: "tool", tool: "Read", arg: "runtime/tail/service.ts" }),
      expect.objectContaining({
        id: "result",
        kind: "tool",
        tool: "Read",
        arg: "runtime/tail/service.ts",
        result: { outcome: "success" },
      }),
    ]);
    expect(data.metadata?.session?.adapterType).toBe("kimi");
    expect(data.metadata?.session?.externalSessionId).toBe("session_123");
  });
});
