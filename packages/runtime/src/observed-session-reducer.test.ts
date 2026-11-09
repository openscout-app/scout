import { describe, expect, test } from "bun:test";

import {
  ObservedSessionReducer,
  type ObservedSessionProjectionSink,
  type ObservedSessionProjectionUpdate,
} from "./observed-session-reducer.js";
import {
  INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
  INTERNAL_TAIL_SESSION_STALLED_SUMMARY,
} from "./tail/service.js";
import type { TailEvent } from "./tail/types.js";

function event(overrides: Partial<TailEvent> = {}): TailEvent {
  return {
    id: "codex:session-1:1",
    ts: 1_000,
    source: "codex",
    sessionId: "session-1",
    pid: 100,
    parentPid: null,
    project: "openscout",
    cwd: "/Users/you/dev/openscout",
    harness: "unattributed",
    kind: "user",
    summary: "Make launch instant",
    ...overrides,
  };
}

function collectingSink(): {
  sink: ObservedSessionProjectionSink;
  batches: ObservedSessionProjectionUpdate[][];
} {
  const batches: ObservedSessionProjectionUpdate[][] = [];
  return {
    batches,
    sink: {
      applyObservedSessionBatch(updates) {
        batches.push(updates.map((update) => ({ ...update })));
      },
    },
  };
}

const manualFlushOptions = {
  flushIntervalMs: 60_000,
  activityHeartbeatMs: 1_000,
};

describe("ObservedSessionReducer", () => {
  test("hydrates persisted active state so restart lifecycle evidence can retire it", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);
    const persisted: ObservedSessionProjectionUpdate = {
      feedId: "obs:codex:session-1",
      entityKind: "observed_session",
      source: "codex",
      sourceSessionId: "session-1",
      runtimeSessionId: "session-1",
      title: "Persisted build",
      project: "openscout",
      projectRoot: "/Users/you/dev/openscout",
      cwd: "/Users/you/dev/openscout",
      harness: "codex",
      activityState: "executing",
      preview: "Running release checks",
      lastActivityAt: 1_000,
      sourceFreshAt: 1_000,
      lastEventId: "projection-seed",
      lastEventKind: "system",
    };

    expect(reducer.hydratePersistedActiveSessions([persisted])).toEqual({
      hydrated: 1,
      dropped: 0,
    });
    expect(reducer.diagnostics()).toEqual(expect.objectContaining({
      trackedKeys: 1,
      pendingKeys: 0,
    }));
    expect(batches).toEqual([]);

    reducer.ingest(event({
      id: "confirmed-offline-after-restart",
      ts: 100_000,
      kind: "system",
      summary: INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
    }));
    await reducer.flushNow();

    expect(batches).toEqual([[expect.objectContaining({
      feedId: persisted.feedId,
      title: "Persisted build",
      activityState: "offline",
      preview: "Running release checks",
      lastActivityAt: 1_000,
      sourceFreshAt: 1_000,
    })]]);
    await reducer.close({ flush: false });
  });

  test("coalesces a session to one complete latest-state update with stable identity", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);

    reducer.ingest(event());
    reducer.ingest(event({
      id: "codex:session-1:2",
      ts: 1_100,
      kind: "tool",
      summary: "Read · packages/runtime/src/tail/service.ts",
    }));
    reducer.ingest(event({
      id: "codex:session-1:3",
      ts: 1_200,
      kind: "assistant",
      summary: "The launch path is now bounded.",
    }));

    expect(reducer.diagnostics().pendingKeys).toBe(1);
    await reducer.flushNow();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([expect.objectContaining({
      feedId: "obs:codex:session-1",
      entityKind: "observed_session",
      source: "codex",
      sourceSessionId: "session-1",
      runtimeSessionId: "session-1",
      title: "Make launch instant",
      project: "openscout",
      projectRoot: "/Users/you/dev/openscout",
      cwd: "/Users/you/dev/openscout",
      harness: "codex",
      activityState: "completed",
      preview: "The launch path is now bounded.",
      lastActivityAt: 1_200,
      sourceFreshAt: 1_200,
      lastEventId: "codex:session-1:3",
      lastEventKind: "assistant",
    })]);
    expect(reducer.diagnostics()).toEqual(expect.objectContaining({
      pendingKeys: 0,
      queuedUpdates: 1,
      coalescedEvents: 2,
      flushedBatches: 1,
      flushedUpdates: 1,
    }));
    await reducer.close({ flush: false });
  });

  test("does not write every quiet token fragment and emits only a bounded heartbeat", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);

    reducer.ingest(event());
    await reducer.flushNow();
    reducer.ingest(event({
      id: "codex:session-1:tokens-1",
      ts: 1_100,
      kind: "system",
      summary: "tokens · 104453775",
    }));
    reducer.ingest(event({
      id: "codex:session-1:tokens-2",
      ts: 1_200,
      kind: "system",
      summary: "tokens · 104453776",
    }));
    await reducer.flushNow();
    expect(batches).toHaveLength(1);

    reducer.ingest(event({
      id: "codex:session-1:tokens-heartbeat",
      ts: 2_100,
      kind: "system",
      summary: "tokens · 104453999",
    }));
    await reducer.flushNow();

    expect(batches).toHaveLength(2);
    expect(batches[1]?.[0]).toEqual(expect.objectContaining({
      activityState: "working",
      preview: "Make launch instant",
      lastActivityAt: 1_000,
      sourceFreshAt: 2_100,
      lastEventId: "codex:session-1:tokens-heartbeat",
    }));
    await reducer.close({ flush: false });
  });

  test("defaults quiet projection freshness heartbeats to one minute", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, { flushIntervalMs: 60_000 });

    reducer.ingest(event());
    await reducer.flushNow();
    reducer.ingest(event({
      id: "codex:session-1:tokens-before-default-heartbeat",
      ts: 60_999,
      kind: "system",
      summary: "tokens · 104453776",
    }));
    await reducer.flushNow();
    expect(batches).toHaveLength(1);

    reducer.ingest(event({
      id: "codex:session-1:tokens-at-default-heartbeat",
      ts: 61_000,
      kind: "system",
      summary: "tokens · 104453999",
    }));
    await reducer.flushNow();

    expect(batches).toHaveLength(2);
    expect(batches[1]?.[0]).toEqual(expect.objectContaining({
      sourceFreshAt: 61_000,
      lastEventId: "codex:session-1:tokens-at-default-heartbeat",
    }));
    await reducer.close({ flush: false });
  });

  test("does not turn a quiet tool-result fragment into a projection transition", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);

    reducer.ingest(event({
      id: "tool-start",
      kind: "tool",
      summary: "Shell · bun test",
    }));
    await reducer.flushNow();
    reducer.ingest(event({
      id: "tool-wall-time",
      ts: 1_100,
      kind: "tool-result",
      summary: "-> Wall time: 0.12 seconds",
    }));
    await reducer.flushNow();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]).toEqual(expect.objectContaining({
      activityState: "executing",
      preview: "Shell · bun test",
    }));
    await reducer.close({ flush: false });
  });

  test("flushes a burst on the scheduled coalescing window", async () => {
    const flushed = Promise.withResolvers<readonly ObservedSessionProjectionUpdate[]>();
    const reducer = new ObservedSessionReducer({
      applyObservedSessionBatch(updates) {
        flushed.resolve(updates);
      },
    }, {
      flushIntervalMs: 5,
      activityHeartbeatMs: 1_000,
    });

    reducer.ingest(event());
    reducer.ingest(event({
      id: "latest",
      ts: 1_100,
      kind: "assistant",
      summary: "Latest coalesced result",
    }));

    const updates = await flushed.promise;
    expect(updates).toEqual([expect.objectContaining({
      feedId: "obs:codex:session-1",
      preview: "Latest coalesced result",
    })]);
    await reducer.flushNow();
    expect(reducer.diagnostics().flushedBatches).toBe(1);
    await reducer.close({ flush: false });
  });

  test("bounds pending keys while preserving an operator-attention transition", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, {
      ...manualFlushOptions,
      maxPendingKeys: 2,
      maxTrackedKeys: 3,
      maxFlushBatchSize: 2,
    });

    reducer.ingest(event({ sessionId: "session-a", id: "a" }));
    reducer.ingest(event({ sessionId: "session-b", id: "b" }));
    reducer.ingest(event({
      sessionId: "session-c",
      id: "c",
      kind: "system",
      summary: "permission requested · shell",
    }));

    expect(reducer.diagnostics()).toEqual(expect.objectContaining({
      trackedKeys: 3,
      pendingKeys: 2,
      droppedKeys: 1,
    }));
    await reducer.flushNow();

    const updates = batches.flat();
    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual(expect.objectContaining({
      feedId: "obs:codex:session-c",
      activityState: "waiting_for_input",
    }));
    await reducer.close({ flush: false });
  });

  test("ignores stale observations instead of regressing the latest fold", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);

    reducer.ingest(event({
      id: "newer",
      ts: 2_000,
      kind: "assistant",
      summary: "Finished result",
    }));
    reducer.ingest(event({
      id: "older",
      ts: 1_000,
      kind: "tool",
      summary: "Old tool call",
    }));
    await reducer.flushNow();

    expect(batches[0]?.[0]).toEqual(expect.objectContaining({
      activityState: "completed",
      preview: "Finished result",
      sourceFreshAt: 2_000,
      lastEventId: "newer",
    }));
    expect(reducer.diagnostics().staleEvents).toBe(1);
    await reducer.close({ flush: false });
  });

  test("ages transient work through stalled and offline without masking a later event", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);

    reducer.ingest(event({
      id: "tool-start",
      ts: 1_000,
      kind: "tool",
      summary: "Shell · build",
    }));
    await reducer.flushNow();
    reducer.ingest(event({
      id: "confirmed-stalled",
      ts: 100_000,
      kind: "system",
      summary: INTERNAL_TAIL_SESSION_STALLED_SUMMARY,
    }));
    await reducer.flushNow();

    expect(batches[1]?.[0]).toEqual(expect.objectContaining({
      activityState: "stalled",
      preview: "Shell · build",
      lastActivityAt: 1_000,
      sourceFreshAt: 1_000,
    }));

    reducer.ingest(event({
      id: "confirmed-offline",
      ts: 101_000,
      kind: "system",
      summary: INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
    }));
    await reducer.flushNow();
    expect(batches[2]?.[0]).toEqual(expect.objectContaining({
      activityState: "offline",
      lastActivityAt: 1_000,
      sourceFreshAt: 1_000,
    }));

    // Detection wall time is not a source cursor. A transcript event written
    // before detection but observed afterward can still revive the session.
    reducer.ingest(event({
      id: "late-result",
      ts: 1_100,
      kind: "assistant",
      summary: "Build finished",
    }));
    await reducer.flushNow();
    expect(batches[3]?.[0]).toEqual(expect.objectContaining({
      activityState: "completed",
      preview: "Build finished",
      lastActivityAt: 1_100,
      sourceFreshAt: 1_100,
    }));
    await reducer.close({ flush: false });
  });

  test("does not overwrite a terminal session with an inferred offline marker", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);

    reducer.ingest(event({
      id: "complete",
      kind: "assistant",
      summary: "Done",
    }));
    await reducer.flushNow();
    reducer.ingest(event({
      id: "irrelevant-offline",
      ts: 100_000,
      kind: "system",
      summary: INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
    }));
    await reducer.flushNow();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]).toEqual(expect.objectContaining({
      activityState: "completed",
      lastEventId: "complete",
    }));
    await reducer.close({ flush: false });
  });

  test("does not use Claude local-command caveats as the session title", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);
    reducer.ingest(event({
      source: "claude",
      summary: "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>\nPlease fix the sidebar sort",
    }));
    await reducer.flushNow();
    expect(batches[0]?.[0]?.title).toBe("Please fix the sidebar sort");
    await reducer.close({ flush: false });
  });

  test("falls back to the project when the first user turn is only a wrapper", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);
    reducer.ingest(event({
      source: "claude",
      summary: "<task-notification>Scheduled task output</task-notification>",
    }));
    await reducer.flushNow();
    expect(batches[0]?.[0]?.title).toBe("openscout");
    await reducer.close({ flush: false });
  });
});

describe("classified prompt projections", () => {
  test("uses operator words rather than the raw harness frame for the title and preview", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);
    try {
      reducer.ingest(event({
        summary: "Injected context the raw summary clipped before the request",
        prompt: { parts: [{ kind: "words", text: "Fix the sidebar sort" }], words: "Fix the sidebar sort", harnessOnly: false },
      }));
      await reducer.flushNow();
      expect(batches[0]?.[0]).toMatchObject({ title: "Fix the sidebar sort", preview: "Fix the sidebar sort" });
    } finally { await reducer.close({ flush: false }); }
  });

  test("a harness-only notice supplies a readable headline, never a task title", async () => {
    const { sink, batches } = collectingSink();
    const reducer = new ObservedSessionReducer(sink, manualFlushOptions);
    try {
      reducer.ingest(event({
        summary: "<task-notification>raw wrapper</task-notification>",
        prompt: { parts: [{ kind: "notice", source: "task", summary: "Background build completed" }], words: "", harnessOnly: true },
      }));
      await reducer.flushNow();
      expect(batches[0]?.[0]).toMatchObject({ title: "openscout", preview: "Background build completed" });
    } finally { await reducer.close({ flush: false }); }
  });
});
