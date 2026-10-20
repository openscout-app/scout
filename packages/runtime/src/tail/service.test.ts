import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __testing,
  joinClaudeRegistryStatus,
  INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
  INTERNAL_TAIL_SESSION_STALLED_SUMMARY,
  readRecentLiveEvents,
  readRecentTranscriptEvents,
  replacePersistedActiveObservedSessionSeeds,
  subscribeTail,
  subscribeTailInternal,
} from "./service.js";
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  TailEvent,
  TranscriptSource,
} from "./types.js";

const testDirectories = new Set<string>();

async function transcriptFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openscout-tail-memo-"));
  testDirectories.add(directory);
  const path = join(directory, "session.jsonl");
  await writeFile(path, "first\n", "utf8");
  const old = new Date(Date.now() - 10_000);
  await utimes(path, old, old);
  return path;
}

function event(overrides: Partial<TailEvent>): TailEvent {
  return {
    id: `event-${Math.random()}`,
    ts: 1_781_991_000_000,
    source: "grok",
    sessionId: "session-1",
    pid: 123,
    parentPid: null,
    project: "openscout",
    cwd: "/Users/arach/dev/openscout",
    harness: "unattributed",
    kind: "system",
    summary: "phase · streaming_text",
    ...overrides,
  };
}

const testProcess: DiscoveredProcess = {
  pid: 123,
  ppid: 1,
  command: "test harness",
  etime: "1",
  cwd: "/repo",
  harness: "unattributed",
  parentChain: [],
  source: "test",
};

function testSource(): TranscriptSource {
  return {
    name: "test",
    discoverProcesses: () => [],
    discoverTranscripts: () => [],
    parseLine(line) {
      return JSON.parse(line) as TailEvent;
    },
  };
}

function testTranscript(
  transcriptPath: string,
  sessionId: string,
  overrides: Partial<DiscoveredTranscript> = {},
): DiscoveredTranscript {
  return {
    source: "test",
    transcriptPath,
    sessionId,
    cwd: "/repo",
    project: "project",
    harness: "unattributed",
    mtimeMs: Date.now(),
    size: 0,
    ...overrides,
  };
}

beforeEach(() => {
  __testing.resetQuietTailCoalescer();
  __testing.resetTranscriptReplayMemo();
  __testing.resetTailEventBuffers();
  __testing.clearWatchers();
});

afterEach(async () => {
  __testing.clearWatchers();
  await Promise.all([...testDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  testDirectories.clear();
});

describe("tail quiet event coalescing", () => {
  test("coalesces repeated Grok streaming_text phases inside the window", () => {
    const first = event({ id: "first", ts: 1_000 });
    const second = event({ id: "second", ts: 1_250 });
    const later = event({ id: "later", ts: 7_000 });

    expect(__testing.shouldCoalesceQuietTailEvent(first)).toBe(false);
    expect(__testing.shouldCoalesceQuietTailEvent(second)).toBe(true);
    expect(__testing.shouldCoalesceQuietTailEvent(later)).toBe(false);
  });

  test("does not coalesce substantive Grok work events", () => {
    const tool = event({
      source: "grok",
      kind: "tool",
      summary: "Read · apps/macos/Sources/ScoutAppCore/ScoutTailStore.swift",
    });
    const assistant = event({
      source: "grok",
      kind: "assistant",
      summary: "Implemented the store split.",
    });

    expect(__testing.shouldCoalesceQuietTailEvent(tool)).toBe(false);
    expect(__testing.shouldCoalesceQuietTailEvent(assistant)).toBe(false);
  });

  test("coalesces repeated Codex metadata markers without hiding task starts", () => {
    const first = event({
      source: "codex",
      kind: "system",
      summary: "tokens · 104453775",
      ts: 2_000,
    });
    const second = event({
      source: "codex",
      kind: "system",
      summary: "tokens · 104453776",
      ts: 2_100,
    });
    const taskStarted = event({
      source: "codex",
      kind: "system",
      summary: "task started",
      ts: 2_200,
    });

    expect(__testing.shouldCoalesceQuietTailEvent(first)).toBe(false);
    expect(__testing.shouldCoalesceQuietTailEvent(second)).toBe(true);
    expect(__testing.shouldCoalesceQuietTailEvent(taskStarted)).toBe(false);
  });
});

describe("internal tail subscribers", () => {
  test("uses relaxed background defaults without changing tiered watcher cadence", () => {
    expect(__testing.defaultLoopCadence).toEqual({
      pumpIntervalMs: 10_000,
      hotDiscoveryIntervalMs: 60_000,
    });
    expect(__testing.cadence).toEqual(expect.objectContaining({
      idleIntervalMs: 15_000,
      staleAfterMs: 30 * 60_000,
    }));
  });

  test("receive pre-coalesced events and keep tailing alive without a public subscriber", async () => {
    // Exercise the real subscriber loop with an owned transcript. Starting it
    // with no watcher launches ambient harness discovery, whose asynchronous
    // results can populate later tests with the operator's live sessions.
    const path = await transcriptFile();
    await __testing.installWatcher({
      source: testSource(),
      process: testProcess,
      transcript: testTranscript(path, "subscriber-fixture"),
    });
    const internalEvents: TailEvent[] = [];
    const publicEvents: TailEvent[] = [];
    const unsubscribeInternal = subscribeTailInternal((entry) => internalEvents.push(entry));
    const unsubscribePublic = subscribeTail((entry) => publicEvents.push(entry));

    try {
      __testing.pushEvent(event({ id: "first", ts: 1_000 }));
      __testing.pushEvent(event({ id: "second", ts: 1_250 }));

      expect(internalEvents.map((entry) => entry.id)).toEqual(["first", "second"]);
      expect(publicEvents.map((entry) => entry.id)).toEqual(["first"]);

      unsubscribePublic();
      expect(__testing.tailLoopState()).toEqual({
        running: true,
        publicSubscriberCount: 0,
        internalSubscriberCount: 1,
      });
    } finally {
      unsubscribePublic();
      unsubscribeInternal();
    }

    expect(__testing.tailLoopState()).toEqual({
      running: false,
      publicSubscriberCount: 0,
      internalSubscriberCount: 0,
    });
  });

  test("reconciles a bounded existing tail after restart and continues at EOF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-restart-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    const historical = Array.from({ length: 160 }, (_, index) => event({
      id: `existing-${index}`,
      source: "test",
      sessionId: "restart-session",
      ts: 1_000 + index,
      summary: `existing ${index}`,
    }));
    const body = `${historical.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(transcriptPath, body, "utf8");

    const internalEvents: TailEvent[] = [];
    const removeInternal = __testing.addInternalSubscriberWithoutLoop((entry) => {
      internalEvents.push(entry);
    });
    try {
      const sessionKey = await __testing.installWatcher({
        source: testSource(),
        process: testProcess,
        transcript: testTranscript(transcriptPath, "restart-session", {
          size: Buffer.byteLength(body),
        }),
        reconcileInternal: true,
      });

      expect(internalEvents).toHaveLength(128);
      expect(internalEvents[0]?.id).toBe("existing-32");
      expect(internalEvents.at(-1)?.id).toBe("existing-159");

      const live = event({
        id: "written-during-downtime-boundary",
        source: "test",
        sessionId: "restart-session",
        ts: 2_000,
        summary: "new after restart",
      });
      await appendFile(transcriptPath, `${JSON.stringify(live)}\n`, "utf8");
      await __testing.pumpWatcher(sessionKey);

      expect(internalEvents.filter((entry) => entry.id === "existing-159")).toHaveLength(1);
      expect(internalEvents.at(-1)?.id).toBe("written-during-downtime-boundary");
    } finally {
      removeInternal();
    }
  });

  test("coalesces overlapping pumps for the same watcher", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-single-flight-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(transcriptPath, "", "utf8");
    const sessionKey = await __testing.installWatcher({
      source: testSource(),
      process: testProcess,
      transcript: testTranscript(transcriptPath, "single-flight-session"),
    });
    const nextEvent = event({
      id: "single-flight-event",
      source: "test",
      sessionId: "single-flight-session",
      summary: "one read",
    });
    await appendFile(transcriptPath, `${JSON.stringify(nextEvent)}\n`, "utf8");

    const first = __testing.pumpWatcher(sessionKey);
    const second = __testing.pumpWatcher(sessionKey);

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(__testing.snapshotSessionEvents("single-flight-session", "test", 10)).toEqual([nextEvent]);
  });

  test("globally bounds concurrent watcher work", async () => {
    const limit = __testing.watcherPumpConcurrency;
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tasks = Array.from({ length: limit * 2 }, () => (
      __testing.scheduleWatcherPump(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
      })
    ));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(limit);
    expect(__testing.watcherPumpSchedulerState()).toEqual({
      active: limit,
      queued: limit,
    });

    release?.();
    await Promise.all(tasks);
    expect(__testing.watcherPumpSchedulerState()).toEqual({ active: 0, queued: 0 });
  });

  test("drains growing transcripts in bounded ordered chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-bounded-read-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(transcriptPath, "", "utf8");
    const sessionKey = await __testing.installWatcher({
      source: testSource(),
      process: testProcess,
      transcript: testTranscript(transcriptPath, "bounded-read-session"),
    });
    const payload = "é".repeat(900);
    const events = Array.from({ length: 3_000 }, (_, index) => event({
      id: `bounded-${index}`,
      source: "test",
      sessionId: "bounded-read-session",
      ts: index,
      summary: `${index}:${payload}`,
    }));
    const body = `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await appendFile(transcriptPath, body, "utf8");

    const offsets = [__testing.watcherOffset(sessionKey) ?? 0];
    await __testing.pumpWatcher(sessionKey);
    offsets.push(__testing.watcherOffset(sessionKey) ?? 0);
    expect(offsets[1]! - offsets[0]!).toBeGreaterThan(__testing.watcherReadBytes);
    expect(offsets[1]! - offsets[0]!).toBeLessThanOrEqual(__testing.watcherDrainBytes);
    while ((offsets.at(-1) ?? 0) < Buffer.byteLength(body)) {
      await __testing.pumpWatcher(sessionKey);
      offsets.push(__testing.watcherOffset(sessionKey) ?? 0);
    }

    expect(offsets.slice(1).every((offset, index) => (
      offset - offsets[index]! <= __testing.watcherDrainBytes
    ))).toBe(true);
    const emitted = __testing.snapshotSessionEvents("bounded-read-session", "test", events.length);
    expect(emitted).toHaveLength(2_000);
    expect(emitted[0]?.id).toBe("bounded-1000");
    expect(emitted.at(-1)?.id).toBe("bounded-2999");
    expect(emitted.every((entry) => !entry.summary.includes("�"))).toBe(true);
  });

  test("keeps the seeded offset when best-effort history parsing fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-seed-failure-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    const body = "malformed historical record\n";
    await writeFile(transcriptPath, body, "utf8");

    const sessionKey = await __testing.installWatcher({
      source: testSource(),
      process: testProcess,
      transcript: testTranscript(transcriptPath, "seed-failure-session"),
      reconcileInternal: true,
    });

    expect(__testing.watcherOffset(sessionKey)).toBe(Buffer.byteLength(body));
  });

  test("requires two successful inventories before expiring a missing watcher", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-missing-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    const existing = event({
      id: "existing-active",
      source: "test",
      sessionId: "missing-session",
      kind: "tool",
      summary: "Shell · build",
    });
    const body = `${JSON.stringify(existing)}\n`;
    await writeFile(transcriptPath, body, "utf8");

    const internalEvents: TailEvent[] = [];
    const removeInternal = __testing.addInternalSubscriberWithoutLoop((entry) => {
      internalEvents.push(entry);
    });
    try {
      await __testing.installWatcher({
        source: testSource(),
        process: testProcess,
        transcript: testTranscript(transcriptPath, "missing-session", {
          size: Buffer.byteLength(body),
        }),
        reconcileInternal: true,
      });
      const successfulSources = new Set(["test"]);
      __testing.reconcileMissingWatchers(new Set(), successfulSources, 10_000);

      expect(__testing.watcherCount()).toBe(1);
      expect(internalEvents.some((entry) => (
        entry.summary === INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY
      ))).toBe(false);

      // A failed source inventory supplies no negative evidence.
      __testing.reconcileMissingWatchers(new Set(), new Set(), 10_500);
      expect(__testing.watcherCount()).toBe(1);

      __testing.reconcileMissingWatchers(new Set(), successfulSources, 11_000);
      expect(__testing.watcherCount()).toBe(0);
      expect(internalEvents.at(-1)).toEqual(expect.objectContaining({
        source: "test",
        sessionId: "missing-session",
        summary: INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
        raw: { reason: "missing" },
      }));
    } finally {
      removeInternal();
    }
  });

  test("reconciles a persisted active identity deleted during downtime after two successful inventories", () => {
    const internalEvents: TailEvent[] = [];
    const removeInternal = __testing.addInternalSubscriberWithoutLoop((entry) => {
      internalEvents.push(entry);
    });
    try {
      expect(replacePersistedActiveObservedSessionSeeds([{
        source: "test",
        sourceSessionId: "persisted-missing",
        lastActivityAt: 9_000,
        project: "project",
        projectRoot: "/repo",
      }])).toEqual({ seeded: 1, dropped: 0 });

      const successfulSources = new Set(["test"]);
      __testing.reconcilePersistedObservedSessions(new Set(), successfulSources, 10_000);
      expect(__testing.persistedObservedSessionCount()).toBe(1);
      expect(internalEvents).toHaveLength(0);

      // A failed inventory is not negative evidence and cannot advance expiry.
      __testing.reconcilePersistedObservedSessions(new Set(), new Set(), 10_500);
      expect(__testing.persistedObservedSessionCount()).toBe(1);
      expect(internalEvents).toHaveLength(0);

      // Seeing the identity again resets the first negative observation.
      const seen = new Set([
        __testing.observedSessionLifecycleKey("test", "persisted-missing"),
      ]);
      __testing.reconcilePersistedObservedSessions(seen, successfulSources, 10_750);
      __testing.reconcilePersistedObservedSessions(new Set(), successfulSources, 11_000);
      expect(internalEvents).toHaveLength(0);

      __testing.reconcilePersistedObservedSessions(new Set(), successfulSources, 12_000);
      expect(__testing.persistedObservedSessionCount()).toBe(0);
      expect(internalEvents).toEqual([
        expect.objectContaining({
          source: "test",
          sessionId: "persisted-missing",
          project: "project",
          cwd: "/repo",
          summary: INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
          raw: { reason: "missing" },
        }),
      ]);
    } finally {
      removeInternal();
    }
  });

  test("makes a present quiet watcher outside bounded replay lifecycle-eligible from persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-persisted-quiet-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(transcriptPath, "", "utf8");
    const internalEvents: TailEvent[] = [];
    const removeInternal = __testing.addInternalSubscriberWithoutLoop((entry) => {
      internalEvents.push(entry);
    });
    try {
      replacePersistedActiveObservedSessionSeeds([{
        source: "test",
        sourceSessionId: "persisted-quiet",
        lastActivityAt: 1_000,
        projectRoot: "/repo",
      }]);
      const sessionKey = await __testing.installWatcher({
        source: testSource(),
        process: testProcess,
        transcript: testTranscript(transcriptPath, "persisted-quiet", {
          mtimeMs: 1_000,
          lastEventAt: 1_000,
        }),
        // This models a present transcript beyond the newest-12 internal replay
        // allowance: no historical event is replayed into this watcher.
        reconcileInternal: false,
      });

      expect(__testing.watcherInternalObserved(sessionKey)).toBe(true);
      expect(internalEvents).toHaveLength(0);
      __testing.setWatcherCadence(sessionKey, { lastObservedChangeAt: 1_000 });
      const staleAt = 1_000 + __testing.cadence.staleAfterMs + 1;
      __testing.observeWatcherStaleness(sessionKey, staleAt);
      expect(internalEvents).toHaveLength(0);
      __testing.observeWatcherStaleness(sessionKey, staleAt + 1);
      expect(internalEvents).toEqual([
        expect.objectContaining({
          source: "test",
          sessionId: "persisted-quiet",
          summary: INTERNAL_TAIL_SESSION_STALLED_SUMMARY,
          raw: { reason: "stale" },
        }),
      ]);
    } finally {
      removeInternal();
    }
  });

  test("bounds persisted observed lifecycle seeds newest-first", () => {
    const seeds = Array.from(
      { length: __testing.persistedObservedSeedLimit + 3 },
      (_, index) => ({
        source: "test",
        sourceSessionId: `persisted-${index}`,
        lastActivityAt: index,
      }),
    );
    expect(replacePersistedActiveObservedSessionSeeds(seeds)).toEqual({
      seeded: __testing.persistedObservedSeedLimit,
      dropped: 3,
    });
    expect(__testing.persistedObservedSessionCount())
      .toBe(__testing.persistedObservedSeedLimit);
  });

  test("confirms stagnant watchers twice before emitting a stalled transition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-stale-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    const existing = event({
      id: "existing-working",
      source: "test",
      sessionId: "stale-session",
      kind: "user",
      summary: "Keep working",
    });
    const body = `${JSON.stringify(existing)}\n`;
    await writeFile(transcriptPath, body, "utf8");

    const internalEvents: TailEvent[] = [];
    const removeInternal = __testing.addInternalSubscriberWithoutLoop((entry) => {
      internalEvents.push(entry);
    });
    try {
      const sessionKey = await __testing.installWatcher({
        source: testSource(),
        process: testProcess,
        transcript: testTranscript(transcriptPath, "stale-session", {
          mtimeMs: 1_000,
          lastEventAt: 1_000,
          size: Buffer.byteLength(body),
        }),
        reconcileInternal: true,
      });
      __testing.setWatcherCadence(sessionKey, { lastObservedChangeAt: 1_000 });
      const staleAt = 1_000 + __testing.cadence.staleAfterMs + 1;
      __testing.observeWatcherStaleness(sessionKey, staleAt);
      expect(internalEvents.at(-1)?.summary).not.toBe(INTERNAL_TAIL_SESSION_STALLED_SUMMARY);

      __testing.observeWatcherStaleness(sessionKey, staleAt + 1);
      expect(internalEvents.at(-1)).toEqual(expect.objectContaining({
        summary: INTERNAL_TAIL_SESSION_STALLED_SUMMARY,
        raw: { reason: "stale" },
      }));
    } finally {
      removeInternal();
    }
  });

  test("tiers cold internal polling while keeping public polling exhaustive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-cadence-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(transcriptPath, "", "utf8");
    const now = __testing.cadence.hotWindowMs + 50_000;
    const sessionKeys: string[] = [];
    const removeInternal = __testing.addInternalSubscriberWithoutLoop(() => {});
    try {
      for (let index = 0; index < __testing.cadence.idleBatchSize + 8; index++) {
        const sessionKey = await __testing.installWatcher({
          source: testSource(),
          process: testProcess,
          transcript: testTranscript(transcriptPath, `cadence-${index}`, {
            mtimeMs: 1,
          }),
        });
        __testing.setWatcherCadence(sessionKey, {
          lastObservedChangeAt: 1,
          lastPumpAt: now,
        });
        sessionKeys.push(sessionKey);
      }

      expect(__testing.selectWatchersForCurrentDemand(now)).toEqual([]);
      const coldDue = __testing.selectWatchersForCurrentDemand(
        now + __testing.cadence.idleIntervalMs,
      );
      expect(coldDue).toHaveLength(__testing.cadence.idleBatchSize);

      __testing.setWatcherCadence(sessionKeys.at(-1)!, {
        lastObservedChangeAt: now + __testing.cadence.idleIntervalMs,
      });
      expect(__testing.selectWatchersForCurrentDemand(
        now + __testing.cadence.idleIntervalMs,
      )).toHaveLength(__testing.cadence.idleBatchSize + 1);

      const removePublic = __testing.addPublicSubscriberWithoutLoop(() => {});
      try {
        expect(__testing.selectWatchersForCurrentDemand(now)).toHaveLength(sessionKeys.length);
      } finally {
        removePublic();
      }
    } finally {
      removeInternal();
    }
  });

  test("reads the recent ring without pumping transcript watchers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-snapshot-read-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(transcriptPath, "", "utf8");
    const sessionKey = await __testing.installWatcher({
      source: testSource(),
      process: testProcess,
      transcript: testTranscript(transcriptPath, "snapshot-read-session"),
    });
    const nextEvent = event({
      id: "event-after-snapshot",
      source: "test",
      sessionId: "snapshot-read-session",
      summary: "arrived through watcher loop",
    });
    await appendFile(transcriptPath, `${JSON.stringify(nextEvent)}\n`, "utf8");
    __testing.setWatcherCadence(sessionKey, { lastPumpAt: 1 });
    const removeInternal = __testing.addInternalSubscriberWithoutLoop(() => {});

    try {
      await expect(readRecentLiveEvents(10)).resolves.toEqual([]);
      await Promise.resolve();
      expect(__testing.watcherLastPumpAt(sessionKey)).toBe(1);
      expect(__testing.watcherOffset(sessionKey)).toBe(0);

      const loopTickAt = Date.now() + 1;
      await __testing.pumpWatchersForCurrentDemand(loopTickAt);
      expect(__testing.watcherLastPumpAt(sessionKey)).toBe(loopTickAt);
      await expect(readRecentLiveEvents(10)).resolves.toEqual([nextEvent]);
    } finally {
      removeInternal();
    }
  });
});

describe("session hot-buffer identity", () => {
  test("keeps same-id harness events scoped to the selected transcript source", () => {
    const codex = event({
      id: "codex-reply",
      source: "codex",
      sessionId: "shared-native-id",
      kind: "assistant",
      summary: "Codex reply",
    });
    const claude = event({
      id: "claude-reply",
      source: "claude",
      sessionId: "shared-native-id",
      kind: "assistant",
      summary: "Claude reply",
    });
    __testing.setSessionBuffer("shared-native-id", [codex, claude]);

    expect(__testing.snapshotSessionEvents("shared-native-id", "codex", 20)).toEqual([codex]);
    expect(__testing.snapshotSessionEvents("shared-native-id", "claude", 20)).toEqual([claude]);
    expect(__testing.snapshotSessionEvents("shared-native-id", "kimi", 20)).toEqual([]);
  });

  test("keeps assistant replies outside the generic live-event eviction ring", async () => {
    const reply = event({
      id: "reply-before-tool-flood",
      source: "codex",
      kind: "assistant",
      summary: "Completed response",
      ts: 1,
    });
    __testing.pushEvent(reply);
    for (let index = 0; index < 12_000; index++) {
      __testing.pushEvent(event({
        id: `tool-${index}`,
        source: "codex",
        kind: "tool",
        summary: `Tool ${index}`,
        ts: index + 2,
      }));
    }

    await expect(readRecentLiveEvents(1, { kinds: ["assistant"] })).resolves.toEqual([reply]);
  });

  test("finds a cold assistant reply before a 12k-line technical flood", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-cold-reply-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "rollout-cold-reply.jsonl");
    const replyLine = JSON.stringify({
      timestamp: "2026-08-28T01:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "reply-before-cold-tool-flood",
        role: "assistant",
        content: [{ type: "output_text", text: "Cold completed response" }],
      },
    });
    const paddedToolOutput = "x".repeat(1_024);
    const toolLines = Array.from({ length: 12_000 }, (_, index) => JSON.stringify({
      timestamp: new Date(Date.parse("2026-08-28T01:00:01.000Z") + index).toISOString(),
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: `call-${index}`,
        output: `Tool result ${index} ${paddedToolOutput}`,
      },
    }));
    const transcriptBody = `${[replyLine, ...toolLines].join("\n")}\n`;
    await writeFile(transcriptPath, transcriptBody, "utf8");
    const discovery = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [{
        source: "codex",
        transcriptPath,
        sessionId: "cold-reply-session",
        cwd: "/Users/art/dev/openscout",
        project: "openscout",
        harness: "unattributed" as const,
        mtimeMs: Date.now(),
        size: Buffer.byteLength(transcriptBody),
      }],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    expect(Buffer.byteLength(transcriptBody)).toBeGreaterThan(8 * 1024 * 1024);

    const replies = await readRecentTranscriptEvents(1, {
      discovery,
      perTranscriptLineLimit: 200,
      kinds: ["assistant"],
      perTranscriptKindLimit: 1,
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.summary).toBe("Cold completed response");
  });
});

describe("tail transcript replay memo", () => {
  test("reuses unchanged replays without sharing mutable arrays", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => {
      loads++;
      return [event({ id: `load-${loads}` })];
    };

    const first = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    first.push(event({ id: "caller-only" }));
    const second = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);

    expect(loads).toBe(1);
    expect(second.map((item) => item.id)).toEqual(["load-1"]);
    expect(second).not.toBe(first);
  });

  test("replays changed files after the active grace window", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => [event({ id: `load-${++loads}` })];

    await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    await appendFile(path, "second\n", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
    const refreshed = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);

    expect(loads).toBe(2);
    expect(refreshed[0]?.id).toBe("load-2");
  });

  test("replays when a multi-file parser dependency fingerprint changes", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => [event({ id: `load-${++loads}` })];
    const firstDependency = { size: 100, mtimeMs: Date.now() - 20_000 };
    const changedDependency = { size: 140, mtimeMs: Date.now() - 10_000 };

    await __testing.memoizedTranscriptReplay(path, "recent:file:opencode", load, firstDependency);
    const refreshed = await __testing.memoizedTranscriptReplay(
      path,
      "recent:file:opencode",
      load,
      changedDependency,
    );

    expect(loads).toBe(2);
    expect(refreshed[0]?.id).toBe("load-2");
  });

  test("serves the prior replay while an actively written file is inside grace", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => [event({ id: `load-${++loads}` })];

    await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    await appendFile(path, "active\n", "utf8");
    const duringGrace = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);

    expect(loads).toBe(1);
    expect(duringGrace[0]?.id).toBe("load-1");

    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
    await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    expect(loads).toBe(2);
  });

  test("bounds stale replay time while a transcript is written continuously", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => [event({ id: `load-${++loads}` })];

    await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    const deadline = Date.now() + 2_400;
    let replay = [event({ id: "unread" })];
    while (Date.now() < deadline) {
      await appendFile(path, "active\n", "utf8");
      replay = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
      await Bun.sleep(300);
    }

    expect(loads).toBeGreaterThan(1);
    expect(replay[0]?.id).not.toBe("load-1");
  });

  test("coalesces concurrent loads for the same replay shape", async () => {
    const path = await transcriptFile();
    const gate = Promise.withResolvers<void>();
    let loads = 0;
    const load = async () => {
      loads++;
      await gate.promise;
      return [event({ id: "shared" })];
    };

    const first = __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    const second = __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    gate.resolve();
    const [left, right] = await Promise.all([first, second]);

    expect(loads).toBe(1);
    expect(right).toEqual(left);
    expect(right).not.toBe(left);
  });

  test("keeps list and detail replay budgets in separate memo entries", async () => {
    const path = await transcriptFile();
    let loads = 0;

    const recent = await __testing.memoizedTranscriptReplay(path, "recent:lines:50", async () => {
      loads++;
      return [event({ id: "recent" })];
    });
    const detail = await __testing.memoizedTranscriptReplay(path, "session:lines:2000", async () => {
      loads++;
      return [event({ id: "detail-1" }), event({ id: "detail-2" })];
    });

    expect(loads).toBe(2);
    expect(recent).toHaveLength(1);
    expect(detail).toHaveLength(2);
  });

  test("evicts the oldest replay shape at the configured bound", async () => {
    const path = await transcriptFile();
    let loads = 0;
    for (let index = 0; index <= 256; index++) {
      await __testing.memoizedTranscriptReplay(path, `variant-${index}`, async () => {
        loads++;
        return [event({ id: `event-${index}` })];
      });
    }

    expect(__testing.transcriptReplayMemoSize()).toBe(256);
    await __testing.memoizedTranscriptReplay(path, "variant-0", async () => {
      loads++;
      return [event({ id: "reloaded" })];
    });
    expect(loads).toBe(258);
  });
});

test("discovery joins the newest registry status by native id, and clears missing records", () => {
  const transcript: DiscoveredTranscript = {
    source: "claude", sessionId: "native", transcriptPath: "/native.jsonl",
    cwd: "/repo", project: "repo", harness: "unattributed", mtimeMs: 1, size: 1,
  };
  const record = (pid: number, statusUpdatedAt: number, status: "busy" | "shell", waitingFor: string | null = null) => ({
    pid, sessionId: "native", statusUpdatedAt, status, waitingFor,
    cwd: null, startedAt: null, procStart: null, kind: null, entrypoint: null,
    version: null, tmux: null, name: null, nameSource: null, recordPath: "/registry.json",
  });
  const [joined] = joinClaudeRegistryStatus([transcript], [
    record(1, 200, "shell", " permission "), record(2, 100, "busy"),
  ]);
  expect(joined).toMatchObject({ status: "shell", statusUpdatedAt: 200,
    waitingFor: " permission ", attention: { source: "registry", kind: "ask", reason: " permission ", since: 200 } });
  expect(joinClaudeRegistryStatus([joined!], [record(3, 300, "busy")])[0]?.attention).toBeNull();
  expect(joinClaudeRegistryStatus([joined!], [])[0]).toMatchObject({
    status: null, statusUpdatedAt: null, waitingFor: null, attention: null,
  });
  expect(joinClaudeRegistryStatus([{ ...transcript, source: "codex" }], [record(1, 200, "busy")])[0]?.status).toBeUndefined();
  expect(joinClaudeRegistryStatus([{ ...transcript, sessionId: "child", parentSessionId: "native" }], [record(1, 200, "busy")])[0]?.status).toBeNull();
});
