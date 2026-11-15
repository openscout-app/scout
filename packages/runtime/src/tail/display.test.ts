import { describe, expect, test } from "bun:test";

import { filterTailEventsForDisplay, isTailNoiseEvent } from "./display.js";
import type { TailEvent } from "./types.js";

function event(overrides: Partial<TailEvent>): TailEvent {
  return {
    id: "evt-1",
    ts: 1_000,
    source: "grok",
    sessionId: "sess-1",
    pid: 1,
    parentPid: null,
    project: "scope",
    cwd: "/Users/you/dev/scope",
    harness: "unattributed",
    kind: "system",
    summary: "phase · streaming_text",
    ...overrides,
  };
}

describe("isTailNoiseEvent", () => {
  test("filters grok streaming phase noise", () => {
    expect(isTailNoiseEvent(event({ summary: "phase · streaming_text" }))).toBe(true);
    expect(isTailNoiseEvent(event({ summary: "phase · streaming_reasoning" }))).toBe(true);
    expect(isTailNoiseEvent(event({ summary: "phase · waiting_for_model" }))).toBe(true);
  });

  test("keeps grok tool work", () => {
    expect(isTailNoiseEvent(event({
      kind: "tool",
      summary: "Read · packages/local/src/ui/app/main.js",
    }))).toBe(false);
  });

  test("filters only Cursor process-monitor samples", () => {
    expect(isTailNoiseEvent(event({
      source: "cursor",
      kind: "system",
      summary: "process sample · openscout, vox",
    }))).toBe(true);
    expect(isTailNoiseEvent(event({
      source: "cursor",
      kind: "system",
      summary: "agent process exited",
    }))).toBe(false);
    expect(isTailNoiseEvent(event({
      source: "cursor",
      kind: "tool",
      summary: "Process sample data",
    }))).toBe(false);
  });

  test("filterTailEventsForDisplay drops noise only", () => {
    const events = [
      event({ id: "noise", summary: "phase · streaming_text" }),
      event({ id: "cursor-sample", source: "cursor", summary: "process sample · openscout" }),
      event({ id: "work", kind: "tool", summary: "Grep · pattern" }),
    ];
    expect(filterTailEventsForDisplay(events).map((entry) => entry.id)).toEqual(["work"]);
  });
});

test("flags codex lifecycle and chunk noise", () => {
  expect(isTailNoiseEvent(event({
    source: "codex",
    summary: "turn context · gpt-5.5 · xhigh",
  }))).toBe(true);
  expect(isTailNoiseEvent(event({
    source: "codex",
    summary: "tokens · 30991816",
  }))).toBe(true);
  expect(isTailNoiseEvent(event({
    source: "codex",
    summary: "agent_message",
  }))).toBe(true);
  expect(isTailNoiseEvent(event({
    source: "codex",
    summary: "-> Chunk ID: 66c6a0 Wall time: 0.0000 seconds Process exited with code 0",
    kind: "tool-result",
  }))).toBe(true);
  expect(isTailNoiseEvent(event({
    source: "codex",
    summary: "task started",
  }))).toBe(false);
});
