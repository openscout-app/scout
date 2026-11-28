import {
  logicalSessionTitle,
  observedSessionFeedId,
  type ObservedActivity,
} from "@openscout/protocol";
import { promptHeadline } from "@openscout/agent-sessions";

import { isTailNoiseEvent } from "./tail/display.js";
import {
  INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
  INTERNAL_TAIL_SESSION_STALLED_SUMMARY,
  subscribeTailInternal,
} from "./tail/service.js";
import type { TailEvent, TailEventKind } from "./tail/types.js";

const DEFAULT_FLUSH_INTERVAL_MS = 300;
const DEFAULT_ACTIVITY_HEARTBEAT_MS = 60_000;
const DEFAULT_MAX_PENDING_KEYS = 512;
const DEFAULT_MAX_TRACKED_KEYS = 4_096;
const DEFAULT_MAX_FLUSH_BATCH_SIZE = 128;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const TITLE_MAX_CHARS = 96;
const PREVIEW_MAX_CHARS = 240;

export type ObservedSessionProjectionUpdate = {
  feedId: string;
  entityKind: "observed_session";
  source: string;
  sourceSessionId: string;
  runtimeSessionId: string;
  title: string;
  project: string | null;
  projectRoot: string | null;
  cwd: string | null;
  harness: string;
  activityState: ObservedActivity;
  preview: string | null;
  lastActivityAt: number;
  sourceFreshAt: number;
  lastEventId: string;
  lastEventKind: TailEventKind;
};

/**
 * Adapter boundary for the broker's serialized conversation-projection writer.
 * A call contains at most one complete latest-state update per observed feed id.
 */
export interface ObservedSessionProjectionSink {
  applyObservedSessionBatch(
    updates: readonly ObservedSessionProjectionUpdate[],
  ): void | Promise<void>;
}

export type ObservedSessionReducerOptions = {
  flushIntervalMs?: number;
  activityHeartbeatMs?: number;
  maxPendingKeys?: number;
  maxTrackedKeys?: number;
  maxFlushBatchSize?: number;
  retryDelayMs?: number;
  now?: () => number;
};

export type ObservedSessionReducerDiagnostics = {
  trackedKeys: number;
  pendingKeys: number;
  flushInFlight: boolean;
  ingestedEvents: number;
  queuedUpdates: number;
  coalescedEvents: number;
  droppedKeys: number;
  staleEvents: number;
  sinkErrors: number;
  flushedBatches: number;
  flushedUpdates: number;
};

export type ObservedSessionReducerHydrationResult = {
  hydrated: number;
  dropped: number;
};

type TrackedSession = {
  update: ObservedSessionProjectionUpdate;
  explicitTitle: boolean;
  lastEmitted: ObservedSessionProjectionUpdate | null;
};

type PendingUpdate = {
  update: ObservedSessionProjectionUpdate;
  priority: number;
};

type ActivityDecision = {
  activity: ObservedActivity;
  priority: number;
};

const TRANSIENT_ACTIVE_STATES = new Set<ObservedActivity>([
  "queued",
  "waking",
  "thinking",
  "executing",
  "working",
  "stalled",
]);

function confirmedLifecycleActivity(event: TailEvent): "offline" | "stalled" | null {
  if (event.kind !== "system") return null;
  const summary = event.summary.trim().toLowerCase();
  if (summary === INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY.toLowerCase()) return "offline";
  if (summary === INTERNAL_TAIL_SESSION_STALLED_SUMMARY.toLowerCase()) return "stalled";
  return null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function compactText(value: string, maxChars: number): string {
  const flattened = value.replace(/\s+/gu, " ").trim();
  if (flattened.length <= maxChars) return flattened;
  let sliced = flattened.slice(0, Math.max(0, maxChars - 1));
  const finalCode = sliced.charCodeAt(sliced.length - 1);
  if (finalCode >= 0xd800 && finalCode <= 0xdbff) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}…`;
}

function compactOptional(value: string | null | undefined, maxChars: number): string | null {
  if (!value?.trim()) return null;
  return compactText(value, maxChars) || null;
}

function sourceDisplayName(source: string): string {
  return source
    .split(/[-_]+/gu)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ") || "Harness";
}

function fallbackTitle(event: TailEvent): string {
  const project = compactOptional(event.project, TITLE_MAX_CHARS);
  return project ?? `${sourceDisplayName(event.source)} session`;
}

function contentTitle(event: TailEvent): string | null {
  if (event.kind !== "user") return null;
  // A classified turn names the session only by the operator's words.
  if (event.prompt) return event.prompt.harnessOnly ? null : logicalSessionTitle(event.prompt.words);
  return logicalSessionTitle(event.summary);
}

function previewForEvent(event: TailEvent): string | null {
  if (event.kind !== "user" && event.kind !== "assistant" && event.kind !== "tool") {
    return null;
  }
  const text = event.kind === "user" && event.prompt ? promptHeadline(event.prompt) : event.summary;
  const summary = compactOptional(text, PREVIEW_MAX_CHARS);
  if (!summary || /^\[(user|assistant|reasoning)\]$/iu.test(summary)) return null;
  return summary;
}

function activityForEvent(event: TailEvent, current: ObservedActivity): ActivityDecision {
  const summary = event.summary.trim().toLowerCase();

  const lifecycleActivity = confirmedLifecycleActivity(event);
  if (lifecycleActivity) {
    return { activity: lifecycleActivity, priority: 3 };
  }

  if (
    summary.includes("permission requested")
    || summary.includes("permission prompt")
    || summary.includes("waiting for input")
    || summary.includes("waiting_for_input")
    || summary === "phase · permission_prompt"
  ) {
    return { activity: "waiting_for_input", priority: 4 };
  }
  if (summary.includes("blocked")) {
    return { activity: "blocked", priority: 4 };
  }
  if (
    summary.includes("turn aborted")
    || summary.includes("turn cancelled")
    || summary.includes("task cancelled")
  ) {
    return { activity: "cancelled", priority: 4 };
  }
  if (
    summary === "task failed"
    || summary === "turn failed"
    || summary.startsWith("task failed ·")
    || summary.startsWith("turn failed ·")
  ) {
    return { activity: "failed", priority: 4 };
  }
  if (
    summary === "task complete"
    || summary === "task completed"
    || summary === "turn complete"
    || summary === "turn completed"
  ) {
    return { activity: "completed", priority: 3 };
  }

  if (event.kind === "user") return { activity: "working", priority: 2 };
  if (event.kind === "assistant") return { activity: "completed", priority: 3 };
  if (event.kind === "tool") return { activity: "executing", priority: 2 };
  if (event.kind === "tool-result") return { activity: "working", priority: 1 };

  if (
    summary.startsWith("[thinking]")
    || summary === "[reasoning]"
    || summary === "phase · streaming_reasoning"
    || summary === "phase · waiting_for_model"
  ) {
    return { activity: "thinking", priority: 1 };
  }
  if (summary === "phase · tool_execution") {
    return { activity: "executing", priority: 2 };
  }
  if (
    summary === "first token"
    || summary === "phase · streaming_text"
    || summary === "task started"
    || summary === "turn started"
    || /^turn \d+(?:\s|$)/u.test(summary)
  ) {
    return { activity: "working", priority: 1 };
  }
  if (summary.startsWith("permission ") && !summary.includes("requested")) {
    return { activity: "working", priority: 2 };
  }
  if (summary === "process sample" || summary.startsWith("process sample ·")) {
    return { activity: current === "unknown" ? "idle" : current, priority: 0 };
  }

  return { activity: current, priority: 0 };
}

function visibleState(update: ObservedSessionProjectionUpdate): Omit<
  ObservedSessionProjectionUpdate,
  "sourceFreshAt" | "lastEventId" | "lastEventKind"
> {
  const {
    sourceFreshAt: _sourceFreshAt,
    lastEventId: _lastEventId,
    lastEventKind: _lastEventKind,
    ...visible
  } = update;
  return visible;
}

function visibleStateEqual(
  left: ObservedSessionProjectionUpdate,
  right: ObservedSessionProjectionUpdate,
): boolean {
  return JSON.stringify(visibleState(left)) === JSON.stringify(visibleState(right));
}

function eventTimestamp(event: TailEvent, now: () => number): number {
  return Number.isFinite(event.ts) && event.ts > 0 ? event.ts : now();
}

function pendingPriorityFor(update: ObservedSessionProjectionUpdate): number {
  switch (update.activityState) {
    case "waiting_for_input":
    case "waiting_on_actor":
    case "blocked":
    case "review":
    case "failed":
    case "cancelled":
      return 4;
    case "completed":
      return 3;
    case "executing":
    case "working":
    case "thinking":
      return 2;
    default:
      return 1;
  }
}

/**
 * Bounded, keyed fold from normalized tail events to complete observed-session
 * projection updates. Ingestion never performs filesystem or SQLite work.
 */
export class ObservedSessionReducer {
  private readonly flushIntervalMs: number;
  private readonly activityHeartbeatMs: number;
  private readonly maxPendingKeys: number;
  private readonly maxTrackedKeys: number;
  private readonly maxFlushBatchSize: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly tracked = new Map<string, TrackedSession>();
  private readonly pending = new Map<string, PendingUpdate>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;
  private stopped = false;
  private readonly counters = {
    ingestedEvents: 0,
    queuedUpdates: 0,
    coalescedEvents: 0,
    droppedKeys: 0,
    staleEvents: 0,
    sinkErrors: 0,
    flushedBatches: 0,
    flushedUpdates: 0,
  };

  constructor(
    private readonly sink: ObservedSessionProjectionSink,
    options: ObservedSessionReducerOptions = {},
  ) {
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
    this.activityHeartbeatMs = positiveInteger(
      options.activityHeartbeatMs,
      DEFAULT_ACTIVITY_HEARTBEAT_MS,
    );
    this.maxPendingKeys = positiveInteger(options.maxPendingKeys, DEFAULT_MAX_PENDING_KEYS);
    this.maxTrackedKeys = Math.max(
      this.maxPendingKeys,
      positiveInteger(options.maxTrackedKeys, DEFAULT_MAX_TRACKED_KEYS),
    );
    this.maxFlushBatchSize = Math.min(
      this.maxPendingKeys,
      positiveInteger(options.maxFlushBatchSize, DEFAULT_MAX_FLUSH_BATCH_SIZE),
    );
    this.retryDelayMs = positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    this.now = options.now ?? Date.now;
  }

  /**
   * Restore transient-active rows that were already committed before this
   * broker process started. Hydration is metadata-only: it neither queues a
   * projection write nor advances a source cursor. It exists so a confirmed
   * stalled/offline tail transition can update the persisted row even when no
   * new transcript event has arrived during this process lifetime.
   */
  hydratePersistedActiveSessions(
    updates: readonly ObservedSessionProjectionUpdate[],
  ): ObservedSessionReducerHydrationResult {
    if (this.stopped) return { hydrated: 0, dropped: updates.length };
    let hydrated = 0;
    let dropped = 0;
    for (const candidate of updates) {
      const source = candidate.source.trim();
      const sourceSessionId = candidate.sourceSessionId.trim();
      const feedId = observedSessionFeedId(source, sourceSessionId);
      if (
        !source
        || !sourceSessionId
        || candidate.feedId !== feedId
        || !TRANSIENT_ACTIVE_STATES.has(candidate.activityState)
      ) {
        dropped++;
        continue;
      }
      const existing = this.tracked.get(feedId);
      if (existing && existing.update.sourceFreshAt > candidate.sourceFreshAt) {
        dropped++;
        continue;
      }
      if (!existing && !this.makeRoomForTracked(feedId)) {
        dropped++;
        continue;
      }
      const update = { ...candidate, source, sourceSessionId, feedId };
      this.touchTracked(feedId, {
        update,
        explicitTitle: true,
        lastEmitted: update,
      });
      hydrated++;
    }
    return { hydrated, dropped };
  }

  ingest(event: TailEvent): void {
    if (this.stopped) return;
    this.counters.ingestedEvents++;

    const source = event.source.trim();
    const sourceSessionId = event.sessionId.trim();
    if (!source || !sourceSessionId) {
      this.counters.droppedKeys++;
      return;
    }

    const feedId = observedSessionFeedId(source, sourceSessionId);
    const observedAt = eventTimestamp(event, this.now);
    const existing = this.tracked.get(feedId);
    if (existing && observedAt < existing.update.sourceFreshAt) {
      this.counters.staleEvents++;
      return;
    }
    if (!existing && !this.makeRoomForTracked(feedId)) {
      this.counters.droppedKeys++;
      return;
    }

    const priorActivity = existing?.update.activityState ?? "unknown";
    const lifecycleActivity = confirmedLifecycleActivity(event);
    // Lifecycle expiration is a transition for an already materialized active
    // session, not a reason to manufacture a new offline row or overwrite a
    // terminal/attention state.
    if (lifecycleActivity && (!existing || !TRANSIENT_ACTIVE_STATES.has(priorActivity))) {
      return;
    }
    const classifiedActivity = activityForEvent(event, priorActivity);
    // Codex emits multiple transport/status fragments for one completed tool
    // call. They may refresh a cursor heartbeat, but they must not manufacture
    // an executing -> working transition (and therefore a projection write).
    const activity = isTailNoiseEvent(event) && event.kind === "tool-result"
      ? { activity: priorActivity, priority: 0 }
      : classifiedActivity;
    const explicitTitle = contentTitle(event);
    const preview = previewForEvent(event);
    const nextTitle = existing?.explicitTitle
      ? existing.update.title
      : explicitTitle ?? existing?.update.title ?? fallbackTitle(event);
    const nextExplicitTitle = existing?.explicitTitle === true || explicitTitle !== null;
    const cwd = lifecycleActivity
      ? existing!.update.cwd
      : compactOptional(event.cwd, PREVIEW_MAX_CHARS);
    const project = lifecycleActivity
      ? existing!.update.project
      : compactOptional(event.project, TITLE_MAX_CHARS);
    const activityChanged = activity.activity !== priorActivity;
    const meaningfulActivity = preview !== null || activityChanged || !existing;
    const lastActivityAt = lifecycleActivity
      ? existing!.update.lastActivityAt
      : meaningfulActivity
      ? Math.max(existing?.update.lastActivityAt ?? 0, observedAt)
      : existing?.update.lastActivityAt ?? observedAt;
    const next: ObservedSessionProjectionUpdate = {
      feedId,
      entityKind: "observed_session",
      source,
      sourceSessionId,
      runtimeSessionId: sourceSessionId,
      title: nextTitle,
      project,
      projectRoot: cwd,
      cwd,
      harness: source,
      activityState: activity.activity,
      preview: preview ?? existing?.update.preview ?? null,
      lastActivityAt,
      // An inferred lifecycle transition must not outrank a later transcript
      // event solely because the absence was noticed later in wall-clock time.
      sourceFreshAt: lifecycleActivity
        ? existing!.update.sourceFreshAt
        : Math.max(existing?.update.sourceFreshAt ?? 0, observedAt),
      lastEventId: event.id,
      lastEventKind: event.kind,
    };

    const tracked: TrackedSession = {
      update: next,
      explicitTitle: nextExplicitTitle,
      lastEmitted: existing?.lastEmitted ?? null,
    };
    this.touchTracked(feedId, tracked);

    const lastEmitted = tracked.lastEmitted;
    const materialChange = lastEmitted === null || !visibleStateEqual(lastEmitted, next);
    const heartbeatDue = lastEmitted !== null
      && next.sourceFreshAt - lastEmitted.sourceFreshAt >= this.activityHeartbeatMs;
    if (!materialChange && !heartbeatDue) {
      const pending = this.pending.get(feedId);
      if (pending) {
        pending.update = next;
        pending.priority = Math.max(pending.priority, activity.priority);
      }
      this.counters.coalescedEvents++;
      return;
    }

    this.queueUpdate(next, Math.max(activity.priority, pendingPriorityFor(next)));
  }

  /**
   * Newest transcript activity per source session id, for the flight
   * supervisor's liveness evidence. Bounded by `maxTrackedKeys`.
   */
  lastActivityBySession(): Map<string, number> {
    const latest = new Map<string, number>();
    for (const { update } of this.tracked.values()) {
      const prior = latest.get(update.sourceSessionId) ?? 0;
      if (update.lastActivityAt > prior) latest.set(update.sourceSessionId, update.lastActivityAt);
    }
    return latest;
  }

  diagnostics(): ObservedSessionReducerDiagnostics {
    return {
      trackedKeys: this.tracked.size,
      pendingKeys: this.pending.size,
      flushInFlight: this.flushInFlight !== null,
      ...this.counters,
    };
  }

  /** Flush all currently pending keys. Intended for shutdown and focused tests. */
  async flushNow(): Promise<void> {
    this.clearFlushTimer();
    while (this.flushInFlight || this.pending.size > 0) {
      if (this.flushInFlight) {
        await this.flushInFlight;
        continue;
      }
      await this.flushOneBatch(true);
    }
  }

  /** Stop accepting events; optionally commit the final bounded fold. */
  async close(options: { flush?: boolean } = { flush: true }): Promise<void> {
    this.stopped = true;
    this.clearFlushTimer();
    if (options.flush !== false) {
      await this.flushNow();
    }
  }

  private makeRoomForTracked(feedId: string): boolean {
    if (this.tracked.has(feedId) || this.tracked.size < this.maxTrackedKeys) return true;
    for (const key of this.tracked.keys()) {
      if (this.pending.has(key)) continue;
      this.tracked.delete(key);
      return true;
    }
    return false;
  }

  private touchTracked(feedId: string, tracked: TrackedSession): void {
    this.tracked.delete(feedId);
    this.tracked.set(feedId, tracked);
  }

  private queueUpdate(update: ObservedSessionProjectionUpdate, priority: number): void {
    const existing = this.pending.get(update.feedId);
    if (existing) {
      existing.update = update;
      existing.priority = Math.max(existing.priority, priority);
      this.counters.coalescedEvents++;
      return;
    }

    if (this.pending.size >= this.maxPendingKeys) {
      let victim: string | null = null;
      let victimPriority = Number.POSITIVE_INFINITY;
      for (const [feedId, candidate] of this.pending) {
        if (candidate.priority < victimPriority) {
          victim = feedId;
          victimPriority = candidate.priority;
        }
      }
      if (victim === null || priority <= victimPriority) {
        this.counters.droppedKeys++;
        this.scheduleFlush(0);
        return;
      }
      this.pending.delete(victim);
      this.counters.droppedKeys++;
    }

    this.pending.set(update.feedId, { update, priority });
    this.counters.queuedUpdates++;
    this.scheduleFlush(this.flushIntervalMs);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.stopped || this.flushTimer || this.flushInFlight) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushOneBatch(false);
    }, delayMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async flushOneBatch(propagateError: boolean): Promise<void> {
    if (this.flushInFlight || this.pending.size === 0) return;
    const entries = [...this.pending.entries()].slice(0, this.maxFlushBatchSize);
    for (const [feedId] of entries) this.pending.delete(feedId);
    const updates = entries
      .map(([, pending]) => pending.update)
      .sort((left, right) => left.feedId.localeCompare(right.feedId));

    const operation = Promise.resolve()
      .then(() => this.sink.applyObservedSessionBatch(updates))
      .then(() => {
        this.counters.flushedBatches++;
        this.counters.flushedUpdates += updates.length;
        for (const update of updates) {
          const tracked = this.tracked.get(update.feedId);
          if (tracked) tracked.lastEmitted = update;
        }
      });
    this.flushInFlight = operation;

    try {
      await operation;
    } catch (error) {
      this.counters.sinkErrors++;
      for (const [feedId, failed] of entries) {
        const newer = this.pending.get(feedId);
        if (newer) continue;
        this.queueUpdate(failed.update, failed.priority);
      }
      if (propagateError) throw error;
    } finally {
      this.flushInFlight = null;
      if (this.pending.size > 0) {
        this.scheduleFlush(propagateError ? this.flushIntervalMs : this.retryDelayMs);
      }
    }
  }
}

/** Attach a reducer to the private pre-public-coalesce tail stream. */
export function subscribeObservedSessionReducer(reducer: ObservedSessionReducer): () => void {
  return subscribeTailInternal((event) => reducer.ingest(event));
}
