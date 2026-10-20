import { basename } from "node:path";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { redactSecrets, redactSecretsDeep } from "@openscout/agent-sessions/secret-redaction";

import { readClaudeSessionRecords, type ClaudeSessionRecord } from "../claude-session-records.js";

import { ClaudeSource } from "./claude-source.js";
import { CodexSource } from "./codex-source.js";
import { CursorSource } from "./cursor-source.js";
import { DevinSource } from "./devin-source.js";
import { GrokSource } from "./grok-source.js";
import { KimiSource } from "./kimi-source.js";
import { OpenCodeSource } from "./opencode-source.js";
import { PiSource } from "./pi-source.js";
import { sessionRegistryKey } from "./registry.js";
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  DiscoverySnapshot,
  TailDiscoveryOptions,
  TailDiscoveryScope,
  TailDiscoveryIssue,
  TailEvent,
  TailEventKind,
  TailContext,
  TranscriptSource,
} from "./types.js";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const DEFAULT_TAIL_POLL_INTERVAL_MS = 10_000;
const DEFAULT_HOT_DISCOVERY_INTERVAL_MS = 60_000;
const TAIL_POLL_INTERVAL_MS = readPositiveIntEnv(
  "OPENSCOUT_TAIL_POLL_INTERVAL_MS",
  DEFAULT_TAIL_POLL_INTERVAL_MS,
);
const HOT_DISCOVERY_INTERVAL_MS = readPositiveIntEnv(
  "OPENSCOUT_TAIL_HOT_DISCOVERY_INTERVAL_MS",
  DEFAULT_HOT_DISCOVERY_INTERVAL_MS,
);
const DISCOVERY_CACHE_MAX_AGE_MS = readPositiveIntEnv(
  "OPENSCOUT_TAIL_DISCOVERY_CACHE_MAX_AGE_MS",
  HOT_DISCOVERY_INTERVAL_MS,
);
const SHALLOW_DISCOVERY_INTERVAL_MS = readPositiveIntEnv("OPENSCOUT_TAIL_SHALLOW_DISCOVERY_INTERVAL_MS", 10 * 60_000);
const DEEP_DISCOVERY_INTERVAL_MS = readPositiveIntEnv("OPENSCOUT_TAIL_DEEP_DISCOVERY_INTERVAL_MS", 60 * 60_000);
const PER_SESSION_BUFFER_LIMIT = 2_000;
const AGGREGATE_BUFFER_LIMIT = 10_000;
// Assistant output drives the operator inbox. Keep it in an independent ring
// so a tool-heavy fleet cannot evict a completed reply from the generic tail.
const ASSISTANT_BUFFER_LIMIT = 10_000;
const QUIET_EVENT_COALESCE_WINDOW_MS = readPositiveIntEnv("OPENSCOUT_TAIL_QUIET_EVENT_COALESCE_WINDOW_MS", 5_000);
const QUIET_EVENT_COALESCE_MAX_KEYS = readPositiveIntEnv("OPENSCOUT_TAIL_QUIET_EVENT_COALESCE_MAX_KEYS", 2_000);
const RAW_MAX_DEPTH = 5;
const RAW_MAX_STRING_LEN = 1_000;
const RAW_MAX_ARRAY_ITEMS = 25;
const RAW_MAX_OBJECT_KEYS = 50;
const RECENT_TRANSCRIPT_READ_BYTES = 512 * 1024;
const WATCHER_READ_BYTES = readPositiveIntEnv(
  "OPENSCOUT_TAIL_WATCHER_READ_BYTES",
  512 * 1024,
);
const WATCHER_DRAIN_BYTES = Math.max(
  WATCHER_READ_BYTES,
  readPositiveIntEnv("OPENSCOUT_TAIL_WATCHER_DRAIN_BYTES", 4 * 1024 * 1024),
);
const WATCHER_PUMP_CONCURRENCY = readPositiveIntEnv(
  "OPENSCOUT_TAIL_WATCHER_PUMP_CONCURRENCY",
  16,
);
const SESSION_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;
// A completed reply can precede thousands of verbose tool-result records.
// Keep the cold inbox scan bounded, but large enough for 12k ~1 KiB records.
const RECENT_TRANSCRIPT_KIND_SCAN_READ_BYTES = 32 * 1024 * 1024;
const RECENT_TRANSCRIPT_LINES_PER_FILE = 200;
const RECENT_TRANSCRIPT_KIND_SCAN_MAX_LINES = 65_536;
const RECENT_TRANSCRIPT_MAX_FILES = readPositiveIntEnv("OPENSCOUT_TAIL_RECENT_TRANSCRIPT_MAX_FILES", 24);
// The broker's projection reducer needs a bounded catch-up after restart, but
// the public firehose must retain its live-only startup semantics. Reconcile a
// small newest-first slice per source directly to internal subscribers.
const INTERNAL_RECONCILE_SESSIONS_PER_SOURCE = readPositiveIntEnv(
  "OPENSCOUT_TAIL_INTERNAL_RECONCILE_SESSIONS_PER_SOURCE",
  12,
);
const INTERNAL_RECONCILE_LINES_PER_SESSION = readPositiveIntEnv(
  "OPENSCOUT_TAIL_INTERNAL_RECONCILE_LINES_PER_SESSION",
  128,
);
const INTERNAL_RECONCILE_READ_BYTES = readPositiveIntEnv(
  "OPENSCOUT_TAIL_INTERNAL_RECONCILE_READ_BYTES",
  256 * 1024,
);
// Internal materialization does not justify stat'ing every cold transcript at
// firehose cadence forever. Recently changing watchers stay hot; cold watchers
// are sampled in a bounded round-robin batch. Public subscribers retain the
// broad live view, but at the relaxed Tail cadence rather than a UI-frame pace.
const INTERNAL_HOT_WATCHER_WINDOW_MS = readPositiveIntEnv(
  "OPENSCOUT_TAIL_INTERNAL_HOT_WATCHER_WINDOW_MS",
  60_000,
);
const INTERNAL_IDLE_WATCHER_INTERVAL_MS = readPositiveIntEnv(
  "OPENSCOUT_TAIL_INTERNAL_IDLE_WATCHER_INTERVAL_MS",
  15_000,
);
const INTERNAL_IDLE_WATCHER_BATCH_SIZE = readPositiveIntEnv(
  "OPENSCOUT_TAIL_INTERNAL_IDLE_WATCHER_BATCH_SIZE",
  32,
);
const INTERNAL_ACTIVE_STALE_AFTER_MS = readPositiveIntEnv(
  "OPENSCOUT_TAIL_INTERNAL_ACTIVE_STALE_AFTER_MS",
  30 * 60_000,
);
const INTERNAL_STALE_CONFIRMATION_COUNT = 2;
const AUTHORITATIVE_MISSING_CONFIRMATION_COUNT = 2;
const INTERNAL_PERSISTED_OBSERVED_SEED_LIMIT = readPositiveIntEnv(
  "OPENSCOUT_TAIL_PERSISTED_OBSERVED_SEED_LIMIT",
  4_096,
);
const NATIVE_TAIL_SOURCES = new Set<TranscriptSource["name"]>(["grok", "kimi", "opencode", "cursor"]);
const TRANSCRIPT_REPLAY_MEMO_MAX_ENTRIES = readPositiveIntEnv("OPENSCOUT_TAIL_REPLAY_MEMO_MAX_ENTRIES", 256);
const TRANSCRIPT_REPLAY_ACTIVE_GRACE_MS = readPositiveIntEnv("OPENSCOUT_TAIL_REPLAY_MEMO_ACTIVE_GRACE_MS", 2_000);

type TranscriptReplayMemo = {
  events: TailEvent[];
  fingerprint: string;
  staleSinceMs?: number;
};
type TranscriptReplayDependencyFingerprint = {
  size: number;
  mtimeMs: number;
};
const transcriptReplayMemo = new Map<string, TranscriptReplayMemo>();
const transcriptReplayInFlight = new Map<string, Promise<TailEvent[]>>();

function resetTranscriptReplayMemo(): void {
  transcriptReplayMemo.clear();
  transcriptReplayInFlight.clear();
}

type Subscriber = (event: TailEvent) => void;
type InternalSubscriber = (event: TailEvent) => void;

/** @internal Marker consumed only by the observed-session reducer. */
export const INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY = "session lifecycle · confirmed offline";
/** @internal Marker consumed only by the observed-session reducer. */
export const INTERNAL_TAIL_SESSION_STALLED_SUMMARY = "session lifecycle · confirmed stale";

/**
 * Broker-projection identity used to restore lifecycle authority after a
 * runtime restart. Callers must supply the complete bounded set of persisted
 * transient-active observed rows, newest first or with `lastActivityAt` set.
 *
 * @internal This is projection reconciliation metadata, not a public tail API.
 */
export type PersistedActiveObservedSessionSeed = {
  source: string;
  sourceSessionId: string;
  lastActivityAt: number;
  project?: string | null;
  projectRoot?: string | null;
  cwd?: string | null;
};

export type PersistedObservedSessionSeedResult = {
  seeded: number;
  dropped: number;
};

type PersistedObservedSessionLifecycle = {
  seed: PersistedActiveObservedSessionSeed;
  missingAuthoritativePasses: number;
  lifecycleNotification: "none" | "stalled" | "offline";
};

type Watcher = {
  source: TranscriptSource;
  process: DiscoveredProcess;
  transcript: DiscoveredTranscript;
  transcriptPath: string;
  offset: number;
  lineCounter: number;
  carry: string;
  decoder: StringDecoder;
  emittedEventIds: Set<string>;
  state: Record<string, unknown>;
  lastPumpAt: number;
  lastObservedChangeAt: number;
  lastKnownSize: number;
  lastKnownMtimeMs: number;
  missingAuthoritativePasses: number;
  staleObservations: number;
  lifecycleNotification: "none" | "stalled" | "offline";
  internalObserved: boolean;
  lastInternalEvent: TailEvent | null;
  pumpInFlight: Promise<void> | null;
};

const sources: TranscriptSource[] = [GrokSource, KimiSource, ClaudeSource, CodexSource, CursorSource, OpenCodeSource, PiSource, DevinSource];

const watchers = new Map<string, Watcher>(); // key = `${source}:${transcriptPath}` (one watcher per file, regardless of how many processes share it)
const aggregateBuffer: TailEvent[] = [];
const assistantBuffer: TailEvent[] = [];
const perSessionBuffer = new Map<string, TailEvent[]>();
const subscribers = new Set<Subscriber>();
// Broker-owned reducers consume the normalized stream independently of the
// demand-driven public firehose. Keep this listener set private to the runtime
// implementation: internal consumers must not affect public subscription
// counts, and public idle teardown must not stop their tail loop.
const internalSubscribers = new Set<InternalSubscriber>();
const watcherPumpQueue: Array<() => void> = [];
let activeWatcherPumps = 0;
const knownTranscripts = new Map<string, DiscoveredTranscript>();
// This registry is deliberately distinct from `watchers`: it is restored from
// SQLite projection rows and therefore retains lifecycle authority for a
// session whose transcript disappeared while the broker was offline.
const persistedObservedSessions = new Map<string, PersistedObservedSessionLifecycle>();
const quietEventLastSeen = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let hotDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
let shallowDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
let deepDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
let discoveryInFlight: Promise<DiscoverySnapshot> | null = null;
let lastDiscovery: DiscoverySnapshot | null = null;

function emptyDiscoverySnapshot(): DiscoverySnapshot {
  return {
    generatedAt: Date.now(),
    processes: [],
    transcripts: [],
    totals: {
      total: 0,
      scoutManaged: 0,
      hudsonManaged: 0,
      unattributed: 0,
      transcripts: 0,
    },
  };
}

const ATTRIBUTION_RANK: Record<DiscoveredProcess["harness"], number> = {
  "scout-managed": 3,
  "hudson-managed": 2,
  unattributed: 1,
};

/**
 * Pick the best-attributed process to represent a transcript file.
 * Prefer Scout-managed > Hudson-managed > native; tie-break by lowest pid
 * (typically the earliest/root process in a fanout).
 */
function pickPrimaryProcess(procs: DiscoveredProcess[]): DiscoveredProcess {
  return procs.reduce((best, candidate) => {
    const bestRank = ATTRIBUTION_RANK[best.harness] ?? 0;
    const candRank = ATTRIBUTION_RANK[candidate.harness] ?? 0;
    if (candRank > bestRank) return candidate;
    if (candRank === bestRank && candidate.pid < best.pid) return candidate;
    return best;
  });
}

function virtualPidForPath(path: string): number {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return -((hash >>> 0) % 900_000 + 1_000);
}

function processForTranscript(
  transcript: DiscoveredTranscript,
  processes: DiscoveredProcess[],
): DiscoveredProcess {
  const cwd = transcript.cwd?.trim();
  if (cwd) {
    const matches = processes.filter((proc) => proc.source === transcript.source && proc.cwd === cwd);
    if (matches.length > 0) {
      return pickPrimaryProcess(matches);
    }
  }

  return {
    pid: virtualPidForPath(transcript.transcriptPath),
    ppid: 0,
    command: `${transcript.source} transcript`,
    etime: "0",
    cwd: transcript.cwd,
    harness: transcript.harness,
    parentChain: [],
    source: transcript.source,
  };
}

function trimRawString(value: string): string {
  if (value.length <= RAW_MAX_STRING_LEN) return value;
  return `${value.slice(0, RAW_MAX_STRING_LEN)}... [truncated ${value.length - RAW_MAX_STRING_LEN} chars]`;
}

function compactRawValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(trimRawString(value));
  if (value == null || typeof value !== "object") return value;
  if (depth >= RAW_MAX_DEPTH) return "[truncated depth]";

  if (Array.isArray(value)) {
    const out = value.slice(0, RAW_MAX_ARRAY_ITEMS).map((entry) => compactRawValue(entry, depth + 1));
    if (value.length > RAW_MAX_ARRAY_ITEMS) {
      out.push(`[truncated ${value.length - RAW_MAX_ARRAY_ITEMS} items]`);
    }
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, RAW_MAX_OBJECT_KEYS)) {
    out[key] = compactRawValue(entry, depth + 1);
  }
  if (entries.length > RAW_MAX_OBJECT_KEYS) {
    out.__truncatedKeys = entries.length - RAW_MAX_OBJECT_KEYS;
  }
  return out;
}

function compactEvent(event: TailEvent): TailEvent {
  const summary = redactSecrets(event.summary);
  if (!event.raw) return summary === event.summary ? event : { ...event, summary };
  return {
    ...event,
    summary,
    raw: compactRawValue(event.raw),
  };
}

/**
 * Whole-file parsers (parseFile) bypass compactEvent; scrub registered
 * credentials from their events before they reach buffers and HTTP reads.
 */
function redactTailEvent(event: TailEvent): TailEvent {
  return {
    ...event,
    summary: redactSecrets(event.summary),
    ...(event.raw ? { raw: redactSecretsDeep(event.raw) } : {}),
  };
}

function parsedEventsToArray(events: TailEvent | TailEvent[] | null): TailEvent[] {
  if (!events) return [];
  return Array.isArray(events) ? events : [events];
}

const GROK_QUIET_PHASES = new Set([
  "streaming_reasoning",
  "streaming_text",
  "tool_execution",
  "permission_prompt",
]);

function normalizedSummary(event: TailEvent): string {
  return event.summary.trim().toLowerCase();
}

function quietTailEventKey(event: TailEvent): string | null {
  const summary = normalizedSummary(event);
  if (!summary) return null;

  if (event.source === "grok") {
    if (summary === "first token") return `${event.source}:${event.sessionId}:first-token`;
    if (summary.startsWith("loop ")) return `${event.source}:${event.sessionId}:loop`;
    if (!summary.startsWith("phase ·")) return null;
    const phase = summary.slice("phase ·".length).trim();
    return GROK_QUIET_PHASES.has(phase)
      ? `${event.source}:${event.sessionId}:phase:${phase}`
      : null;
  }

  if (event.source !== "codex") return null;

  if (event.kind === "tool-result") {
    if (summary.startsWith("-> chunk id:")) return `${event.source}:${event.sessionId}:tool-result-chunk`;
    if (/^->\s+wall time:/u.test(summary)) return `${event.source}:${event.sessionId}:tool-result-wall-time`;
    if (summary.includes("_end ·")) return `${event.source}:${event.sessionId}:tool-result-end`;
    if (summary.startsWith("->")) return `${event.source}:${event.sessionId}:tool-result-arrow`;
    return null;
  }

  if (event.kind !== "system") return null;
  if (summary === "user_message") return `${event.source}:${event.sessionId}:user-message-meta`;
  if (summary === "agent_message") return `${event.source}:${event.sessionId}:agent-message-meta`;
  if (summary === "[reasoning]") return `${event.source}:${event.sessionId}:reasoning-marker`;
  if (summary.startsWith("turn context")) return `${event.source}:${event.sessionId}:turn-context`;
  if (summary.startsWith("tokens ·")) return `${event.source}:${event.sessionId}:tokens`;
  if (summary.startsWith("session ")) return `${event.source}:${event.sessionId}:session-meta`;
  return null;
}

function pruneQuietTailCoalescer(now: number): void {
  if (quietEventLastSeen.size <= QUIET_EVENT_COALESCE_MAX_KEYS) return;
  const cutoff = now - QUIET_EVENT_COALESCE_WINDOW_MS * 4;
  for (const [key, seenAt] of quietEventLastSeen) {
    if (seenAt < cutoff) quietEventLastSeen.delete(key);
  }
  if (quietEventLastSeen.size <= QUIET_EVENT_COALESCE_MAX_KEYS) return;
  for (const key of quietEventLastSeen.keys()) {
    quietEventLastSeen.delete(key);
    if (quietEventLastSeen.size <= QUIET_EVENT_COALESCE_MAX_KEYS) break;
  }
}

function shouldCoalesceQuietTailEvent(event: TailEvent): boolean {
  const key = quietTailEventKey(event);
  if (!key) return false;
  const now = Number.isFinite(event.ts) ? event.ts : Date.now();
  const lastSeenAt = quietEventLastSeen.get(key);
  if (lastSeenAt != null && now - lastSeenAt < QUIET_EVENT_COALESCE_WINDOW_MS) {
    return true;
  }
  quietEventLastSeen.set(key, now);
  pruneQuietTailCoalescer(now);
  return false;
}

function pushInternalEvent(rawEvent: TailEvent): TailEvent {
  const event = compactEvent(rawEvent);
  for (const subscriber of [...internalSubscribers]) {
    try {
      subscriber(event);
    } catch {
      /* isolate internal consumer failures from transcript tailing */
    }
  }
  return event;
}

function pushEvent(rawEvent: TailEvent): TailEvent {
  // Internal consumers receive every normalized, redacted event before the
  // presentation-oriented quiet-event coalescer. Their own bounded reducer is
  // responsible for deciding whether an observation changes material state.
  const event = pushInternalEvent(rawEvent);
  if (shouldCoalesceQuietTailEvent(event)) return event;
  aggregateBuffer.push(event);
  if (aggregateBuffer.length > AGGREGATE_BUFFER_LIMIT) {
    aggregateBuffer.splice(0, aggregateBuffer.length - AGGREGATE_BUFFER_LIMIT);
  }
  if (event.kind === "assistant") {
    assistantBuffer.push(event);
    if (assistantBuffer.length > ASSISTANT_BUFFER_LIMIT) {
      assistantBuffer.splice(0, assistantBuffer.length - ASSISTANT_BUFFER_LIMIT);
    }
  }
  let bucket = perSessionBuffer.get(event.sessionId);
  if (!bucket) {
    bucket = [];
    perSessionBuffer.set(event.sessionId, bucket);
  }
  bucket.push(event);
  if (bucket.length > PER_SESSION_BUFFER_LIMIT) {
    bucket.splice(0, bucket.length - PER_SESSION_BUFFER_LIMIT);
  }
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(event);
    } catch {
      /* swallow subscriber errors */
    }
  }
  return event;
}

function rememberWatcherEvent(
  watcher: Watcher,
  rawEvent: TailEvent,
  delivery: "all" | "internal",
): void {
  if (watcher.emittedEventIds.has(rawEvent.id)) return;
  watcher.emittedEventIds.add(rawEvent.id);
  const event = delivery === "all"
    ? pushEvent(rawEvent)
    : pushInternalEvent(rawEvent);
  watcher.internalObserved = true;
  watcher.lastInternalEvent = event;
  watcher.staleObservations = 0;
  watcher.lifecycleNotification = "none";
  const lifecycle = persistedObservedSessions.get(
    observedSessionLifecycleKey(watcher.source.name, event.sessionId),
  );
  if (lifecycle) {
    lifecycle.missingAuthoritativePasses = 0;
    lifecycle.lifecycleNotification = "none";
  }
}

function observedSessionLifecycleKey(source: string, sourceSessionId: string): string {
  return `${source.trim()}\u0000${sourceSessionId.trim()}`;
}

function persistedSeedEvent(seed: PersistedActiveObservedSessionSeed): TailEvent {
  const source = seed.source.trim();
  const sourceSessionId = seed.sourceSessionId.trim();
  const timestamp = Number.isFinite(seed.lastActivityAt) && seed.lastActivityAt > 0
    ? seed.lastActivityAt
    : 0;
  return {
    id: `tail-persisted-seed:${source}:${sourceSessionId}:${timestamp}`,
    ts: timestamp,
    source,
    sessionId: sourceSessionId,
    pid: virtualPidForPath(`${source}:${sourceSessionId}`),
    parentPid: null,
    project: seed.project?.trim() ?? "",
    cwd: seed.cwd?.trim() || seed.projectRoot?.trim() || "",
    harness: "unattributed",
    kind: "system",
    summary: "session lifecycle · restored persisted active identity",
    raw: { reason: "persisted_active_seed" },
  };
}

function applyPersistedObservedSeedToWatcher(watcher: Watcher): void {
  if (watcher.internalObserved) return;
  const sessionId = watcher.transcript.sessionId?.trim();
  if (!sessionId) return;
  const lifecycle = persistedObservedSessions.get(
    observedSessionLifecycleKey(watcher.source.name, sessionId),
  );
  if (!lifecycle) return;
  watcher.internalObserved = true;
  watcher.lastInternalEvent = persistedSeedEvent(lifecycle.seed);
  watcher.missingAuthoritativePasses = lifecycle.missingAuthoritativePasses;
  watcher.lifecycleNotification = lifecycle.lifecycleNotification;
}

/**
 * Replace the restart lifecycle seed set with the broker projection's complete
 * bounded set of transient-active observed rows.
 *
 * The seed is metadata-only: it does not replay a synthetic event or touch the
 * public firehose. It makes current and future watchers lifecycle-eligible and
 * lets successful inventories expire identities whose files vanished while
 * the process was down.
 *
 * @internal
 */
export function replacePersistedActiveObservedSessionSeeds(
  seeds: readonly PersistedActiveObservedSessionSeed[],
): PersistedObservedSessionSeedResult {
  const byKey = new Map<string, PersistedActiveObservedSessionSeed>();
  for (const candidate of seeds) {
    const source = candidate.source.trim();
    const sourceSessionId = candidate.sourceSessionId.trim();
    if (!source || !sourceSessionId) continue;
    const lastActivityAt = Number.isFinite(candidate.lastActivityAt)
      ? Math.max(0, candidate.lastActivityAt)
      : 0;
    const seed = { ...candidate, source, sourceSessionId, lastActivityAt };
    const key = observedSessionLifecycleKey(source, sourceSessionId);
    const current = byKey.get(key);
    if (!current || seed.lastActivityAt > current.lastActivityAt) {
      byKey.set(key, seed);
    }
  }

  const retained = [...byKey.entries()]
    .sort((left, right) => (
      right[1].lastActivityAt - left[1].lastActivityAt
      || left[0].localeCompare(right[0])
    ))
    .slice(0, INTERNAL_PERSISTED_OBSERVED_SEED_LIMIT);
  const next = new Map<string, PersistedObservedSessionLifecycle>();
  for (const [key, seed] of retained) {
    const current = persistedObservedSessions.get(key);
    const refreshed = current && seed.lastActivityAt > current.seed.lastActivityAt;
    next.set(key, {
      seed,
      missingAuthoritativePasses: refreshed ? 0 : current?.missingAuthoritativePasses ?? 0,
      lifecycleNotification: refreshed ? "none" : current?.lifecycleNotification ?? "none",
    });
  }
  persistedObservedSessions.clear();
  for (const [key, lifecycle] of next) persistedObservedSessions.set(key, lifecycle);
  for (const watcher of watchers.values()) applyPersistedObservedSeedToWatcher(watcher);
  return {
    seeded: persistedObservedSessions.size,
    dropped: Math.max(0, byKey.size - persistedObservedSessions.size),
  };
}

function watcherSessionId(watcher: Watcher): string | null {
  return watcher.lastInternalEvent?.sessionId.trim()
    || watcher.transcript.sessionId?.trim()
    || null;
}

function notifyWatcherLifecycle(
  watcher: Watcher,
  reason: "missing" | "stale",
  observedAt: number,
): void {
  const nextNotification = reason === "missing" ? "offline" : "stalled";
  const sessionId = watcherSessionId(watcher);
  if (!sessionId) return;
  const lifecycleKey = observedSessionLifecycleKey(watcher.source.name, sessionId);
  const persistedLifecycle = persistedObservedSessions.get(lifecycleKey);
  if (
    !watcher.internalObserved
    || watcher.lifecycleNotification === nextNotification
    || watcher.lifecycleNotification === "offline"
    || persistedLifecycle?.lifecycleNotification === nextNotification
    || persistedLifecycle?.lifecycleNotification === "offline"
  ) return;
  watcher.lifecycleNotification = nextNotification;
  if (persistedLifecycle) {
    persistedLifecycle.lifecycleNotification = nextNotification;
  }
  pushInternalEvent({
    id: `tail-lifecycle:${watcher.source.name}:${sessionId}:${nextNotification}:${observedAt}`,
    ts: observedAt,
    source: watcher.source.name,
    sessionId,
    pid: watcher.process.pid,
    parentPid: watcher.process.ppid || null,
    project: watcher.transcript.project,
    cwd: watcher.transcript.cwd ?? watcher.process.cwd ?? "",
    harness: watcher.transcript.harness,
    kind: "system",
    summary: reason === "missing"
      ? INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY
      : INTERNAL_TAIL_SESSION_STALLED_SUMMARY,
    raw: { reason },
  });
  if (nextNotification === "offline") {
    persistedObservedSessions.delete(lifecycleKey);
  }
}

function observeWatcherStaleness(watcher: Watcher, observedAt: number): void {
  if (
    watcher.lifecycleNotification !== "none"
    || !watcher.internalObserved
    || observedAt - watcher.lastObservedChangeAt < INTERNAL_ACTIVE_STALE_AFTER_MS
  ) {
    watcher.staleObservations = 0;
    return;
  }
  watcher.staleObservations++;
  if (watcher.staleObservations >= INTERNAL_STALE_CONFIRMATION_COUNT) {
    notifyWatcherLifecycle(watcher, "stale", observedAt);
  }
}

async function readNew(
  handle: FileHandle,
  fromOffset: number,
  fileSize: number,
): Promise<{ bytes: Buffer; nextOffset: number }> {
  if (fileSize <= fromOffset) {
    return { bytes: Buffer.alloc(0), nextOffset: fromOffset };
  }
  const length = Math.min(fileSize - fromOffset, WATCHER_READ_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, fromOffset);
  return {
    bytes: buffer.subarray(0, bytesRead),
    nextOffset: fromOffset + bytesRead,
  };
}

async function readTranscriptText(path: string, maxBytes = RECENT_TRANSCRIPT_READ_BYTES): Promise<string> {
  let handle: FileHandle | null = null;
  try {
    const stats = await stat(path);
    if (stats.size <= 0) return "";
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    handle = await open(path, "r");
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function runWatcherPump(watcher: Watcher, observedAt: number): Promise<void> {
  let handle: FileHandle | null = null;
  watcher.lastPumpAt = observedAt;
  try {
    const stats = await stat(watcher.transcriptPath);
    const changed = stats.size !== watcher.lastKnownSize
      || stats.mtimeMs !== watcher.lastKnownMtimeMs;
    watcher.lastKnownSize = stats.size;
    watcher.lastKnownMtimeMs = stats.mtimeMs;
    if (changed) {
      watcher.lastObservedChangeAt = observedAt;
      watcher.staleObservations = 0;
      watcher.lifecycleNotification = "none";
    }
    if (stats.size < watcher.offset) {
      // File was rotated/truncated; reset.
      watcher.offset = 0;
      watcher.carry = "";
      watcher.decoder = new StringDecoder("utf8");
      watcher.emittedEventIds.clear();
    }
    if (stats.size <= watcher.offset) {
      observeWatcherStaleness(watcher, observedAt);
      return;
    }
    if (watcher.source.parseFile) {
      const text = await readTranscriptText(watcher.transcriptPath);
      watcher.offset = stats.size;
      if (!text) return;
      const events = parsedEventsToArray(watcher.source.parseFile(text, {
        process: watcher.process,
        transcript: watcher.transcript,
        transcriptPath: watcher.transcriptPath,
        lineOffset: watcher.lineCounter,
        state: watcher.state,
      }));
      watcher.lineCounter += Math.max(1, events.length);
      for (const event of events) {
        rememberWatcherEvent(watcher, event, "all");
      }
      return;
    }
    const drainEnd = Math.min(stats.size, watcher.offset + WATCHER_DRAIN_BYTES);
    while (watcher.offset < drainEnd) {
      handle = await open(watcher.transcriptPath, "r");
      const { bytes, nextOffset } = await readNew(handle, watcher.offset, drainEnd);
      await handle.close();
      handle = null;
      if (nextOffset <= watcher.offset) break;
      watcher.offset = nextOffset;
      const text = watcher.decoder.write(bytes);
      if (!text) continue;
      const combined = watcher.carry + text;
      const lines = combined.split("\n");
      watcher.carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = watcher.source.parseLine(line, {
          process: watcher.process,
          transcript: watcher.transcript,
          transcriptPath: watcher.transcriptPath,
          lineOffset: watcher.lineCounter,
          state: watcher.state,
        });
        watcher.lineCounter++;
        if (event) {
          rememberWatcherEvent(watcher, event, "all");
        }
      }
    }
    if (stats.size > watcher.offset) {
      const continuation = setTimeout(() => {
        void pumpWatcher(watcher);
      }, 0);
      continuation.unref?.();
    }
  } catch {
    // File may be missing momentarily — skip this tick.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function scheduleWatcherPump(run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = () => {
      activeWatcherPumps++;
      void Promise.resolve().then(run).then(resolve, reject).finally(() => {
        activeWatcherPumps--;
        watcherPumpQueue.shift()?.();
      });
    };
    if (activeWatcherPumps < WATCHER_PUMP_CONCURRENCY) {
      start();
    } else {
      watcherPumpQueue.push(start);
    }
  });
}

function pumpWatcher(watcher: Watcher, observedAt = Date.now()): Promise<void> {
  if (watcher.pumpInFlight) {
    return watcher.pumpInFlight;
  }

  const request = scheduleWatcherPump(() => runWatcherPump(watcher, observedAt));
  watcher.pumpInFlight = request;
  void request.finally(() => {
    if (watcher.pumpInFlight === request) {
      watcher.pumpInFlight = null;
    }
  }).catch(() => {});
  return request;
}

function selectWatchersForCurrentDemand(now = Date.now()): Watcher[] {
  const all = [...watchers.values()];
  if (subscribers.size > 0) return all;
  if (internalSubscribers.size === 0) return [];

  const hot: Watcher[] = [];
  const coldDue: Watcher[] = [];
  for (const watcher of all) {
    if (now - watcher.lastObservedChangeAt <= INTERNAL_HOT_WATCHER_WINDOW_MS) {
      hot.push(watcher);
    } else if (now - watcher.lastPumpAt >= INTERNAL_IDLE_WATCHER_INTERVAL_MS) {
      coldDue.push(watcher);
    }
  }
  coldDue.sort((left, right) => left.lastPumpAt - right.lastPumpAt);
  return [...hot, ...coldDue.slice(0, INTERNAL_IDLE_WATCHER_BATCH_SIZE)];
}

async function pumpWatchersForCurrentDemand(now = Date.now()): Promise<void> {
  const selected = selectWatchersForCurrentDemand(now);
  await Promise.allSettled(selected.map((watcher) => pumpWatcher(watcher, now)));
}

async function seedTail(
  watcher: Watcher,
  options: { reconcileInternal: boolean } = { reconcileInternal: false },
): Promise<void> {
  // Seed the offset to the current end of the file so we don't replay a giant
  // historical transcript to public clients. Internal materialization may
  // replay only the bounded newest tail requested by the caller.
  let stats: Stats;
  try {
    stats = await stat(watcher.transcriptPath);
  } catch {
    watcher.offset = 0;
    return;
  }

  const seededAt = Date.now();
  watcher.offset = options.reconcileInternal || !watcher.source.parseFile
    ? stats.size
    : 0;
  watcher.lastPumpAt = seededAt;
  watcher.lastKnownSize = stats.size;
  watcher.lastKnownMtimeMs = stats.mtimeMs;
  watcher.lastObservedChangeAt = Math.max(
    watcher.transcript.lastEventAt ?? 0,
    watcher.transcript.mtimeMs,
    stats.mtimeMs,
  );

  try {
    if (options.reconcileInternal && watcher.source.parseFile) {
      const text = await readTranscriptText(
        watcher.transcriptPath,
        INTERNAL_RECONCILE_READ_BYTES,
      );
      if (!text) return;
      const events = parsedEventsToArray(watcher.source.parseFile(text, {
        process: watcher.process,
        transcript: watcher.transcript,
        transcriptPath: watcher.transcriptPath,
        lineOffset: 0,
        state: watcher.state,
      }));
      watcher.lineCounter = Math.max(1, events.length);
      for (const event of events) rememberWatcherEvent(watcher, event, "internal");
      return;
    }

    if (!watcher.source.parseFile && (options.reconcileInternal || watcher.source.name === "codex")) {
      const lines = await readRecentTranscriptLines(
        watcher.transcriptPath,
        options.reconcileInternal
          ? INTERNAL_RECONCILE_LINES_PER_SESSION
          : RECENT_TRANSCRIPT_LINES_PER_FILE,
        options.reconcileInternal
          ? INTERNAL_RECONCILE_READ_BYTES
          : RECENT_TRANSCRIPT_READ_BYTES,
      );
      lines.forEach((line, index) => {
        const parsed = watcher.source.parseLine(line, {
          process: watcher.process,
          transcript: watcher.transcript,
          transcriptPath: watcher.transcriptPath,
          lineOffset: index,
          state: watcher.state,
        });
        if (options.reconcileInternal && parsed) {
          rememberWatcherEvent(watcher, parsed, "internal");
        }
      });
      watcher.lineCounter = lines.length;
    }
  } catch {
    // Recent-history priming is best-effort. Retain the successfully seeded
    // offset so one malformed historical record cannot trigger a full replay.
  }
}

function reconcileMissingWatchers(
  seenSessionKeys: ReadonlySet<string>,
  successfullyScannedSources: ReadonlySet<string>,
  observedAt: number,
): void {
  for (const [sessionKey, watcher] of watchers) {
    if (seenSessionKeys.has(sessionKey)) {
      watcher.missingAuthoritativePasses = 0;
      continue;
    }
    // A source discovery failure is not evidence that all of its sessions
    // disappeared. Only successful shallow/deep inventories count.
    if (!successfullyScannedSources.has(watcher.source.name)) continue;
    watcher.missingAuthoritativePasses++;
    if (watcher.missingAuthoritativePasses < AUTHORITATIVE_MISSING_CONFIRMATION_COUNT) {
      continue;
    }
    notifyWatcherLifecycle(watcher, "missing", observedAt);
    watchers.delete(sessionKey);
    knownTranscripts.delete(sessionKey);
  }
}

function reconcilePersistedObservedSessions(
  seenLifecycleKeys: ReadonlySet<string>,
  successfullyScannedSources: ReadonlySet<string>,
  observedAt: number,
): void {
  for (const [lifecycleKey, lifecycle] of persistedObservedSessions) {
    if (seenLifecycleKeys.has(lifecycleKey)) {
      lifecycle.missingAuthoritativePasses = 0;
      continue;
    }
    if (!successfullyScannedSources.has(lifecycle.seed.source)) continue;
    lifecycle.missingAuthoritativePasses++;
    if (
      lifecycle.missingAuthoritativePasses < AUTHORITATIVE_MISSING_CONFIRMATION_COUNT
      || lifecycle.lifecycleNotification === "offline"
    ) {
      continue;
    }
    lifecycle.lifecycleNotification = "offline";
    const seedEvent = persistedSeedEvent(lifecycle.seed);
    pushInternalEvent({
      ...seedEvent,
      id: `tail-lifecycle:${lifecycle.seed.source}:${lifecycle.seed.sourceSessionId}:offline:${observedAt}`,
      ts: observedAt,
      summary: INTERNAL_TAIL_SESSION_OFFLINE_SUMMARY,
      raw: { reason: "missing" },
    });
    // The projection transition is non-destructive. This process-local seed is
    // retired only to prevent repeated offline notifications; the row remains
    // broker-owned and may be seeded again if it becomes transient-active.
    persistedObservedSessions.delete(lifecycleKey);
  }
}

/** Join by native id, never cwd or pid; a newer pid record replaces all older status fields. */
export function joinClaudeRegistryStatus(
  transcripts: DiscoveredTranscript[],
  records: ClaudeSessionRecord[],
): DiscoveredTranscript[] {
  const newest = new Map<string, ClaudeSessionRecord>();
  for (const record of records) {
    const prior = newest.get(record.sessionId);
    const rank = (r: ClaudeSessionRecord) => r.statusUpdatedAt ?? r.updatedAt ?? 0;
    if (!prior || rank(record) > rank(prior)
      || (rank(record) === rank(prior) && record.pid > prior.pid)) newest.set(record.sessionId, record);
  }
  return transcripts.map((transcript) => {
    if (transcript.source !== "claude") return transcript;
    const record = transcript.sessionId ? newest.get(transcript.sessionId) : null;
    return {
      ...transcript,
      status: record?.status ?? null,
      statusUpdatedAt: record?.statusUpdatedAt ?? null,
      waitingFor: record?.waitingFor ?? null,
      attention: record?.waitingFor ? {
        kind: "ask" as const, source: "registry" as const,
        reason: record.waitingFor, since: record.statusUpdatedAt ?? record.updatedAt ?? null,
      } : null,
    };
  });
}

async function refreshDiscovery(
  scope: TailDiscoveryScope = "shallow",
  options: { pruneMissing: boolean } = { pruneMissing: scope !== "hot" },
): Promise<DiscoverySnapshot> {
  const allProcesses: DiscoveredProcess[] = [];
  const cachedProcesses = lastDiscovery?.processes ?? [];
  const seenSessionKeys = new Set<string>();
  const seenObservedLifecycleKeys = new Set<string>();
  const successfullyScannedSources = new Set<string>();
  const discoveryIssues: TailDiscoveryIssue[] = [];
  const discoveryIssueKeys = new Set<string>();

  for (const source of sources) {
    let remainingInternalReconciliations = internalSubscribers.size > 0
      ? INTERNAL_RECONCILE_SESSIONS_PER_SOURCE
      : 0;
    let processes: DiscoveredProcess[] = [];
    if (scope === "hot" && cachedProcesses.length > 0) {
      processes = cachedProcesses.filter((proc) => proc.source === source.name);
    } else {
      try {
        processes = await source.discoverProcesses();
      } catch {
        processes = [];
      }
    }
    allProcesses.push(...processes);

    let transcripts: DiscoveredTranscript[] = [];
    try {
      transcripts = await source.discoverTranscripts(processes, scope);
      successfullyScannedSources.add(source.name);
    } catch {
      transcripts = [];
    }

    for (const transcript of [...transcripts].sort((left, right) => right.mtimeMs - left.mtimeMs)) {
      const primary = processForTranscript(transcript, processes);
      const transcriptPath = transcript.transcriptPath;
      const sessionKey = sessionRegistryKey(transcript);
      seenSessionKeys.add(sessionKey);
      const sourceSessionId = transcript.sessionId?.trim();
      if (sourceSessionId) {
        seenObservedLifecycleKeys.add(
          observedSessionLifecycleKey(source.name, sourceSessionId),
        );
      }

      const prior = knownTranscripts.get(sessionKey);
      if (
        transcript.source !== "cursor"
        && prior
        && prior.transcriptPath !== transcriptPath
      ) {
        const issueKey = `${sessionKey}\u0000${prior.transcriptPath}\u0000${transcriptPath}`;
        if (!discoveryIssueKeys.has(issueKey)) {
          discoveryIssueKeys.add(issueKey);
          const kept = transcript.mtimeMs >= prior.mtimeMs ? transcriptPath : prior.transcriptPath;
          discoveryIssues.push({
            kind: "transcript_path_collision",
            sessionKey,
            message: `Session ${sessionKey} maps to multiple transcript files; tail is watching ${kept}.`,
            transcriptPaths: [prior.transcriptPath, transcriptPath],
          });
        }
      }
      if (!prior || transcript.mtimeMs >= prior.mtimeMs) {
        knownTranscripts.set(sessionKey, transcript);
      }

      let watcher = watchers.get(sessionKey);
      if (!watcher) {
        if (subscribers.size === 0 && internalSubscribers.size === 0) continue;
        watcher = {
          source,
          process: primary,
          transcript,
          transcriptPath,
          offset: 0,
          lineCounter: 0,
          carry: "",
          decoder: new StringDecoder("utf8"),
          emittedEventIds: new Set(),
          state: {},
          lastPumpAt: 0,
          lastObservedChangeAt: Math.max(transcript.lastEventAt ?? 0, transcript.mtimeMs),
          lastKnownSize: transcript.size,
          lastKnownMtimeMs: transcript.mtimeMs,
          missingAuthoritativePasses: 0,
          staleObservations: 0,
          lifecycleNotification: "none",
          internalObserved: false,
          lastInternalEvent: null,
          pumpInFlight: null,
        };
        const reconcileInternal = remainingInternalReconciliations > 0;
        if (reconcileInternal) remainingInternalReconciliations--;
        await seedTail(watcher, { reconcileInternal });
        applyPersistedObservedSeedToWatcher(watcher);
        watchers.set(sessionKey, watcher);
        continue;
      }

      if (watcher.transcriptPath !== transcriptPath) {
        watcher.transcriptPath = transcriptPath;
        watcher.lineCounter = 0;
        watcher.carry = "";
        watcher.decoder = new StringDecoder("utf8");
        watcher.emittedEventIds = new Set();
        watcher.state = {};
        watcher.internalObserved = false;
        watcher.lastInternalEvent = null;
        const reconcileInternal = remainingInternalReconciliations > 0;
        if (reconcileInternal) remainingInternalReconciliations--;
        await seedTail(watcher, { reconcileInternal });
      }
      applyPersistedObservedSeedToWatcher(watcher);
      if (transcript.mtimeMs > watcher.transcript.mtimeMs) {
        watcher.lastObservedChangeAt = Date.now();
        watcher.staleObservations = 0;
        watcher.lifecycleNotification = "none";
        // Whole-file sources may use a primary metadata file as a dependency
        // root while discovery's mtime includes sibling message/part files.
        // Force one bounded reparse when that aggregate fingerprint advances.
        if (watcher.source.parseFile) watcher.offset = 0;
      }
      watcher.process = primary;
      watcher.transcript = transcript;
      watcher.missingAuthoritativePasses = 0;
    }
  }

  if (options.pruneMissing) {
    const observedAt = Date.now();
    reconcileMissingWatchers(
      seenSessionKeys,
      successfullyScannedSources,
      observedAt,
    );
    reconcilePersistedObservedSessions(
      seenObservedLifecycleKeys,
      successfullyScannedSources,
      observedAt,
    );
  }

  const allTranscripts = joinClaudeRegistryStatus(
    [...knownTranscripts.values()].sort((a, b) => b.mtimeMs - a.mtimeMs),
    await readClaudeSessionRecords().catch(() => []),
  );

  let scoutManaged = 0;
  let hudsonManaged = 0;
  let unattributed = 0;
  for (const proc of allProcesses) {
    if (proc.harness === "scout-managed") scoutManaged++;
    else if (proc.harness === "hudson-managed") hudsonManaged++;
    else unattributed++;
  }

  const snapshot: DiscoverySnapshot = {
    generatedAt: Date.now(),
    processes: allProcesses,
    transcripts: allTranscripts,
    issues: discoveryIssues.length > 0 ? discoveryIssues : undefined,
    totals: {
      total: allProcesses.length,
      scoutManaged,
      hudsonManaged,
      unattributed,
      transcripts: allTranscripts.length,
    },
  };
  lastDiscovery = snapshot;
  return snapshot;
}

function runDiscovery(
  scope: TailDiscoveryScope,
  options: { pruneMissing: boolean } = { pruneMissing: scope !== "hot" },
): Promise<DiscoverySnapshot> {
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = refreshDiscovery(scope, options)
    .finally(() => {
      discoveryInFlight = null;
    });
  return discoveryInFlight;
}

function scheduleDiscovery(
  scope: TailDiscoveryScope,
  options: { pruneMissing: boolean } = { pruneMissing: scope !== "hot" },
): void {
  void runDiscovery(scope, options).catch(() => {});
}

function ensureLoopRunning(): void {
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void pumpWatchersForCurrentDemand();
    }, TAIL_POLL_INTERVAL_MS);
  }
  if (!hotDiscoveryTimer) {
    hotDiscoveryTimer = setInterval(() => {
      void runDiscovery("hot", { pruneMissing: false }).catch(() => {});
    }, HOT_DISCOVERY_INTERVAL_MS);
  }
  if (!shallowDiscoveryTimer) {
    shallowDiscoveryTimer = setInterval(() => {
      void runDiscovery("shallow", { pruneMissing: true }).catch(() => {});
    }, SHALLOW_DISCOVERY_INTERVAL_MS);
  }
  if (!deepDiscoveryTimer) {
    deepDiscoveryTimer = setInterval(() => {
      void runDiscovery("deep", { pruneMissing: true }).catch(() => {});
    }, DEEP_DISCOVERY_INTERVAL_MS);
  }
}

function stopLoopIfIdle(): void {
  if (subscribers.size > 0 || internalSubscribers.size > 0) return;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (hotDiscoveryTimer) {
    clearInterval(hotDiscoveryTimer);
    hotDiscoveryTimer = null;
  }
  if (shallowDiscoveryTimer) {
    clearInterval(shallowDiscoveryTimer);
    shallowDiscoveryTimer = null;
  }
  if (deepDiscoveryTimer) {
    clearInterval(deepDiscoveryTimer);
    deepDiscoveryTimer = null;
  }
  watchers.clear();
  persistedObservedSessions.clear();
}

function normalizeTailDiscoveryOptions(
  input: boolean | TailDiscoveryOptions = false,
): Required<Pick<TailDiscoveryOptions, "force">> & Omit<TailDiscoveryOptions, "force"> {
  if (typeof input === "boolean") {
    return { force: input };
  }
  return { ...input, force: input.force === true };
}

export async function getTailDiscovery(
  options: boolean | TailDiscoveryOptions = false,
): Promise<DiscoverySnapshot> {
  const { force, scope } = normalizeTailDiscoveryOptions(options);
  const discoveryScope: TailDiscoveryScope = scope ?? (force ? "deep" : "shallow");
  if (force) {
    scheduleDiscovery(discoveryScope, { pruneMissing: discoveryScope !== "hot" });
    return lastDiscovery ?? emptyDiscoverySnapshot();
  }
  if (lastDiscovery && Date.now() - lastDiscovery.generatedAt <= DISCOVERY_CACHE_MAX_AGE_MS) {
    return lastDiscovery;
  }
  scheduleDiscovery(discoveryScope, { pruneMissing: discoveryScope !== "hot" });
  return lastDiscovery ?? emptyDiscoverySnapshot();
}

export async function refreshTailDiscovery(
  scope: TailDiscoveryScope = "shallow",
): Promise<DiscoverySnapshot> {
  return runDiscovery(scope, { pruneMissing: scope !== "hot" });
}

export function subscribeTail(handler: Subscriber): () => void {
  subscribers.add(handler);
  startTailLoopForSubscriber();
  return () => {
    subscribers.delete(handler);
    stopLoopIfIdle();
  };
}

function startTailLoopForSubscriber(): void {
  ensureLoopRunning();
  // Kick one moderate inventory pass immediately so the new subscriber is live;
  // after that, slower timers discover new movers.
  if (watchers.size === 0) {
    void runDiscovery("shallow", { pruneMissing: true })
      .then(() => pumpWatchersForCurrentDemand())
      .catch(() => {});
  } else {
    void pumpWatchersForCurrentDemand();
  }
}

/**
 * Register a broker-internal consumer of normalized tail events.
 *
 * @internal This deliberately is not re-exported from `@openscout/runtime/tail`.
 * Internal listeners run before public quiet-event coalescing and keep the
 * singleton discovery/tailing loop alive even when no firehose client exists.
 */
export function subscribeTailInternal(handler: InternalSubscriber): () => void {
  internalSubscribers.add(handler);
  startTailLoopForSubscriber();
  return () => {
    internalSubscribers.delete(handler);
    stopLoopIfIdle();
  };
}

export function snapshotRecentEvents(limit = 500): TailEvent[] {
  return aggregateBuffer.slice(-limit);
}

async function installWatcherForTest(input: {
  source: TranscriptSource;
  process: DiscoveredProcess;
  transcript: DiscoveredTranscript;
  reconcileInternal?: boolean;
}): Promise<string> {
  const sessionKey = sessionRegistryKey(input.transcript);
  const watcher: Watcher = {
    source: input.source,
    process: input.process,
    transcript: input.transcript,
    transcriptPath: input.transcript.transcriptPath,
    offset: 0,
    lineCounter: 0,
    carry: "",
    decoder: new StringDecoder("utf8"),
    emittedEventIds: new Set(),
    state: {},
    lastPumpAt: 0,
    lastObservedChangeAt: Math.max(
      input.transcript.lastEventAt ?? 0,
      input.transcript.mtimeMs,
    ),
    lastKnownSize: input.transcript.size,
    lastKnownMtimeMs: input.transcript.mtimeMs,
    missingAuthoritativePasses: 0,
    staleObservations: 0,
    lifecycleNotification: "none",
    internalObserved: false,
    lastInternalEvent: null,
    pumpInFlight: null,
  };
  await seedTail(watcher, { reconcileInternal: input.reconcileInternal === true });
  applyPersistedObservedSeedToWatcher(watcher);
  watchers.set(sessionKey, watcher);
  knownTranscripts.set(sessionKey, input.transcript);
  return sessionKey;
}

export const __testing = {
  quietTailEventKey,
  resetQuietTailCoalescer: () => quietEventLastSeen.clear(),
  shouldCoalesceQuietTailEvent,
  transcriptReplayMemoSize: () => transcriptReplayMemo.size,
  resetTranscriptReplayMemo,
  memoizedTranscriptReplay,
  resetTailEventBuffers: () => {
    aggregateBuffer.length = 0;
    assistantBuffer.length = 0;
    perSessionBuffer.clear();
  },
  setSessionBuffer: (sessionId: string, events: TailEvent[]) => {
    perSessionBuffer.set(sessionId, [...events]);
  },
  pushEvent,
  pushInternalEvent,
  snapshotSessionEvents,
  observedSessionLifecycleKey,
  installWatcher: installWatcherForTest,
  pumpWatcher: (sessionKey: string, observedAt?: number) => {
    const watcher = watchers.get(sessionKey);
    return watcher ? pumpWatcher(watcher, observedAt) : Promise.resolve();
  },
  watcherOffset: (sessionKey: string) => watchers.get(sessionKey)?.offset,
  watcherLastPumpAt: (sessionKey: string) => watchers.get(sessionKey)?.lastPumpAt,
  watcherReadBytes: WATCHER_READ_BYTES,
  watcherDrainBytes: WATCHER_DRAIN_BYTES,
  watcherPumpConcurrency: WATCHER_PUMP_CONCURRENCY,
  scheduleWatcherPump,
  watcherPumpSchedulerState: () => ({
    active: activeWatcherPumps,
    queued: watcherPumpQueue.length,
  }),
  reconcileMissingWatchers,
  reconcilePersistedObservedSessions,
  observeWatcherStaleness: (sessionKey: string, observedAt: number) => {
    const watcher = watchers.get(sessionKey);
    if (watcher) observeWatcherStaleness(watcher, observedAt);
  },
  setWatcherCadence: (
    sessionKey: string,
    cadence: Partial<Pick<Watcher, "lastPumpAt" | "lastObservedChangeAt">>,
  ) => {
    const watcher = watchers.get(sessionKey);
    if (watcher) Object.assign(watcher, cadence);
  },
  pumpWatchersForCurrentDemand,
  selectWatchersForCurrentDemand: (now?: number) => (
    selectWatchersForCurrentDemand(now).map((watcher) => sessionRegistryKey(watcher.transcript))
  ),
  addInternalSubscriberWithoutLoop: (handler: InternalSubscriber) => {
    internalSubscribers.add(handler);
    return () => internalSubscribers.delete(handler);
  },
  addPublicSubscriberWithoutLoop: (handler: Subscriber) => {
    subscribers.add(handler);
    return () => subscribers.delete(handler);
  },
  clearWatchers: () => {
    watchers.clear();
    knownTranscripts.clear();
    persistedObservedSessions.clear();
  },
  watcherCount: () => watchers.size,
  watcherInternalObserved: (sessionKey: string) => watchers.get(sessionKey)?.internalObserved,
  persistedObservedSessionCount: () => persistedObservedSessions.size,
  persistedObservedSeedLimit: INTERNAL_PERSISTED_OBSERVED_SEED_LIMIT,
  cadence: {
    hotWindowMs: INTERNAL_HOT_WATCHER_WINDOW_MS,
    idleIntervalMs: INTERNAL_IDLE_WATCHER_INTERVAL_MS,
    idleBatchSize: INTERNAL_IDLE_WATCHER_BATCH_SIZE,
    staleAfterMs: INTERNAL_ACTIVE_STALE_AFTER_MS,
  },
  defaultLoopCadence: {
    pumpIntervalMs: DEFAULT_TAIL_POLL_INTERVAL_MS,
    hotDiscoveryIntervalMs: DEFAULT_HOT_DISCOVERY_INTERVAL_MS,
  },
  tailLoopState: () => ({
    running: pollTimer !== null,
    publicSubscriberCount: subscribers.size,
    internalSubscriberCount: internalSubscribers.size,
  }),
};

export async function readRecentLiveEvents(
  limit = 500,
  options?: { kinds?: TailEventKind[] },
): Promise<TailEvent[]> {
  // This is a snapshot read, not an ingestion trigger. The subscriber-owned
  // watcher loop keeps the event rings current through the bounded demand
  // selector, while getTailDiscovery/refreshTailDiscovery retain explicit
  // inventory-refresh semantics. Coupling every HTTP read to watcher pumping
  // made one `/tail/recent` request stat every retained transcript.
  const kinds = options?.kinds?.length ? new Set(options.kinds) : null;
  const source = kinds?.size === 1 && kinds.has("assistant")
    ? assistantBuffer
    : aggregateBuffer;
  return kinds
    ? source.filter((event) => kinds.has(event.kind)).slice(-limit)
    : snapshotRecentEvents(limit);
}

async function readRecentTranscriptLines(
  path: string,
  maxLines = RECENT_TRANSCRIPT_LINES_PER_FILE,
  maxBytes = RECENT_TRANSCRIPT_READ_BYTES,
): Promise<string[]> {
  let handle: FileHandle | null = null;
  try {
    const stats = await stat(path);
    if (stats.size <= 0) return [];
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    handle = await open(path, "r");
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) {
      lines.shift();
    }
    return lines.filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function parseRecentTranscriptLineEvents(input: {
  source: TranscriptSource;
  transcriptPath: string;
  context: TailContext;
  lineLimit: number;
  initialReadBytes: number;
  maxReadBytes: number;
  kinds?: Set<TailEventKind> | null;
  kindQuota?: number;
}): Promise<TailEvent[]> {
  let fileSize = 0;
  try {
    fileSize = (await stat(input.transcriptPath)).size;
  } catch {
    return [];
  }
  let lineLimit = Math.max(1, input.lineLimit);
  let readBytes = Math.max(1, Math.min(input.initialReadBytes, input.maxReadBytes));
  const kindQuota = input.kinds?.size
    ? Math.max(1, input.kindQuota ?? 1)
    : null;
  const maxLines = kindQuota
    ? Math.max(lineLimit, RECENT_TRANSCRIPT_KIND_SCAN_MAX_LINES)
    : lineLimit;

  while (true) {
    const lines = await readRecentTranscriptLines(input.transcriptPath, lineLimit, readBytes);
    const parseState: Record<string, unknown> = {};
    const parsed: TailEvent[] = [];
    let index = 0;
    for (const line of lines) {
      const event = input.source.parseLine(line, {
        ...input.context,
        lineOffset: index,
        state: parseState,
      });
      index++;
      if (event) parsed.push(compactEvent(event));
    }

    const matchingCount = kindQuota
      ? parsed.reduce((count, event) => count + (input.kinds!.has(event.kind) ? 1 : 0), 0)
      : 0;
    const exhaustedFile = readBytes >= fileSize && lines.length < lineLimit;
    if (!kindQuota || matchingCount >= kindQuota || exhaustedFile) return parsed;

    const nextLineLimit = Math.min(maxLines, lineLimit * 2);
    const nextReadBytes = Math.min(input.maxReadBytes, readBytes * 2);
    if (nextLineLimit === lineLimit && nextReadBytes === readBytes) return parsed;
    lineLimit = nextLineLimit;
    readBytes = nextReadBytes;
  }
}

function rememberTranscriptEvent(
  events: TailEvent[],
  seenEvents: Set<string>,
  event: TailEvent,
  dedupeKey?: string,
): void {
  const compacted = compactEvent(event);
  const key = dedupeKey ?? compacted.id;
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  events.push(compacted);
}

/**
 * Replay a transcript into events, memoising the parse keyed by path, parse
 * shape, primary-file stat, and any multi-file dependency fingerprint.
 * `variant` separates the bounded recent replay from
 * the larger session replay (and their line budgets), so a cheap list read can
 * never truncate a later detail view. Files touched within the active-grace
 * window fall back to the prior memo so a hot file does not trigger a re-read
 * on every poll; concurrent callers share one load. The replay path is the bulk
 * cost of `/v1/tail/recent` and used to repeat the whole read+parse per request.
 */
async function memoizedTranscriptReplay(
  transcriptPath: string,
  variant: string,
  load: () => Promise<TailEvent[]>,
  dependency?: TranscriptReplayDependencyFingerprint,
): Promise<TailEvent[]> {
  const cacheKey = `${transcriptPath}\u0000${variant}`;
  const inFlight = transcriptReplayInFlight.get(cacheKey);
  if (inFlight) return [...await inFlight];
  let stats: Stats;
  try {
    stats = await stat(transcriptPath);
  } catch {
    transcriptReplayMemo.delete(cacheKey);
    return [];
  }
  const fingerprint = [
    stats.size,
    stats.mtimeMs,
    dependency?.size ?? "",
    dependency?.mtimeMs ?? "",
  ].join(":");
  const effectiveMtimeMs = Math.max(stats.mtimeMs, dependency?.mtimeMs ?? 0);
  const cached = transcriptReplayMemo.get(cacheKey);
  const unchanged = cached && cached.fingerprint === fingerprint;
  if (unchanged) {
    cached.staleSinceMs = undefined;
    return [...cached.events];
  }
  const now = Date.now();
  if (cached && now - effectiveMtimeMs < TRANSCRIPT_REPLAY_ACTIVE_GRACE_MS) {
    cached.staleSinceMs ??= now;
    if (now - cached.staleSinceMs < TRANSCRIPT_REPLAY_ACTIVE_GRACE_MS) {
      return [...cached.events];
    }
  }
  const promise = (async () => {
    const events = await load();
    transcriptReplayMemo.delete(cacheKey);
    transcriptReplayMemo.set(cacheKey, {
      events: [...events],
      fingerprint,
    });
    while (transcriptReplayMemo.size > TRANSCRIPT_REPLAY_MEMO_MAX_ENTRIES) {
      const oldest = transcriptReplayMemo.keys().next().value;
      if (typeof oldest !== "string") break;
      transcriptReplayMemo.delete(oldest);
    }
    return events;
  })().finally(() => transcriptReplayInFlight.delete(cacheKey));
  transcriptReplayInFlight.set(cacheKey, promise);
  return [...await promise];
}

async function appendWatcherTranscriptEvents(
  events: TailEvent[],
  seenEvents: Set<string>,
  watcher: Watcher,
  options?: {
    perTranscriptLineLimit?: number;
    kinds?: Set<TailEventKind> | null;
    kindQuota?: number;
  },
): Promise<void> {
  const { source, transcript, process, transcriptPath } = watcher;
  if (source.parseFile) {
    const readBytes = options?.kinds?.size
      ? RECENT_TRANSCRIPT_KIND_SCAN_READ_BYTES
      : RECENT_TRANSCRIPT_READ_BYTES;
    const parsed = await memoizedTranscriptReplay(
      transcriptPath,
      `recent:file:${source.name}:${sessionRegistryKey(transcript)}:${readBytes}:${[...(options?.kinds ?? [])].sort().join(",")}`,
      async () => {
        const text = await readTranscriptText(transcriptPath, readBytes);
        if (!text) return [];
        return parsedEventsToArray(source.parseFile!(text, {
          process,
          transcript,
          transcriptPath,
          lineOffset: 0,
          state: {},
        }));
      },
      { size: transcript.size, mtimeMs: transcript.mtimeMs },
    );
    for (const event of parsed) {
      if (options?.kinds?.size && !options.kinds.has(event.kind)) continue;
      rememberTranscriptEvent(events, seenEvents, event);
    }
    return;
  }

  const lineLimit = options?.perTranscriptLineLimit ?? RECENT_TRANSCRIPT_LINES_PER_FILE;
  const kindKey = [...(options?.kinds ?? [])].sort().join(",");
  const parsed = await memoizedTranscriptReplay(
    transcriptPath,
    `recent:lines:${source.name}:${sessionRegistryKey(transcript)}:${lineLimit}:${RECENT_TRANSCRIPT_READ_BYTES}:${kindKey}:${options?.kindQuota ?? ""}`,
    () => parseRecentTranscriptLineEvents({
      source,
      transcriptPath,
      context: {
        process,
        transcript,
        transcriptPath,
        lineOffset: 0,
        state: {},
      },
      lineLimit,
      initialReadBytes: RECENT_TRANSCRIPT_READ_BYTES,
      maxReadBytes: options?.kinds?.size
        ? RECENT_TRANSCRIPT_KIND_SCAN_READ_BYTES
        : RECENT_TRANSCRIPT_READ_BYTES,
      kinds: options?.kinds,
      kindQuota: options?.kindQuota,
    }),
  );
  for (const event of parsed) {
    if (options?.kinds?.size && !options.kinds.has(event.kind)) continue;
    const eventKey = [
      event.source,
      event.sessionId,
      event.kind,
      event.summary,
    ].join("\u0000");
    rememberTranscriptEvent(events, seenEvents, event, eventKey);
  }
}

export async function readRecentTranscriptEvents(
  limit = 50,
  options?: {
    discovery?: DiscoverySnapshot | null;
    perTranscriptLineLimit?: number;
    kinds?: TailEventKind[];
    perTranscriptKindLimit?: number;
    since?: number;
  },
): Promise<TailEvent[]> {
  if (watchers.size === 0) {
    if (options?.discovery) {
      for (const transcript of options.discovery.transcripts) {
        knownTranscripts.set(sessionRegistryKey(transcript), transcript);
      }
    } else {
      scheduleDiscovery("shallow", { pruneMissing: true });
    }
  }
  const events: TailEvent[] = [];
  const seenEvents = new Set<string>();
  const seenTranscriptPaths = new Set<string>();

  const transcriptReadLimit = Math.min(RECENT_TRANSCRIPT_MAX_FILES, Math.max(12, limit));
  const lineLimit = options?.perTranscriptLineLimit ?? RECENT_TRANSCRIPT_LINES_PER_FILE;
  const kinds = options?.kinds?.length ? new Set(options.kinds) : null;
  const kindQuota = kinds
    ? Math.max(1, options?.perTranscriptKindLimit ?? limit)
    : undefined;
  const allowedPaths = options?.discovery?.transcripts
    ? new Set(options.discovery.transcripts.map((transcript) => transcript.transcriptPath))
    : null;
  const activeWatchers = [...watchers.values()]
    .filter((watcher) => (
      (!allowedPaths || allowedPaths.has(watcher.transcriptPath))
      && (options?.since === undefined || watcher.transcript.mtimeMs >= options.since)
    ))
    .sort((left, right) => right.transcript.mtimeMs - left.transcript.mtimeMs)
    .slice(0, transcriptReadLimit);

  for (const watcher of activeWatchers) {
    seenTranscriptPaths.add(watcher.transcriptPath);
    await appendWatcherTranscriptEvents(events, seenEvents, watcher, {
      perTranscriptLineLimit: lineLimit,
      kinds,
      kindQuota,
    });
  }

  // Replay discovered transcripts that are not actively watched — Claude/Codex
  // archives often have no live watcher while Grok floods the firehose buffer.
  if (options?.discovery?.transcripts?.length) {
    const discoveryTranscripts = [...options.discovery.transcripts]
      .filter((transcript) => (
        !seenTranscriptPaths.has(transcript.transcriptPath)
        && (options.since === undefined || transcript.mtimeMs >= options.since)
      ))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, Math.max(0, transcriptReadLimit - activeWatchers.length));

    for (const transcript of discoveryTranscripts) {
      const parsed = await parseTranscriptSessionEvents(
        transcript,
        options.discovery.processes,
        lineLimit,
        {
          kinds,
          kindQuota,
          initialReadBytes: RECENT_TRANSCRIPT_READ_BYTES,
        },
      );
      for (const event of parsed) {
        rememberTranscriptEvent(events, seenEvents, event);
      }
      seenTranscriptPaths.add(transcript.transcriptPath);
    }
  }

  return events
    .filter((event) => (
      (!kinds || kinds.has(event.kind))
      && (options?.since === undefined || event.ts >= options.since)
    ))
    .sort((left, right) => right.ts - left.ts)
    .slice(0, limit);
}

function normalizeTailSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = basename(trimmed);
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function transcriptMatchesSessionRef(
  transcript: DiscoveredTranscript,
  normalizedRef: string,
): boolean {
  const refs = [
    normalizeTailSessionRef(transcript.sessionId),
    normalizeTailSessionRef(transcript.transcriptPath),
  ].filter((ref): ref is string => Boolean(ref));
  return refs.includes(normalizedRef);
}

function snapshotSessionEvents(
  sessionId: string,
  source: string,
  limit: number,
): TailEvent[] {
  const bucket = perSessionBuffer.get(sessionId);
  if (bucket?.length) {
    const sourceEvents = bucket.filter((event) => event.source === source);
    if (sourceEvents.length > 0) return sourceEvents.slice(-limit);
  }
  return aggregateBuffer
    .filter((event) => event.sessionId === sessionId && event.source === source)
    .slice(-limit);
}

async function parseTranscriptSessionEvents(
  transcript: DiscoveredTranscript,
  processes: DiscoveredProcess[],
  limit: number,
  options?: {
    kinds?: Set<TailEventKind> | null;
    kindQuota?: number;
    initialReadBytes?: number;
  },
): Promise<TailEvent[]> {
  const source = sources.find((candidate) => candidate.name === transcript.source);
  if (!source) return [];

  const process = processForTranscript(transcript, processes);
  const ctxBase = {
    process,
    transcript,
    transcriptPath: transcript.transcriptPath,
    lineOffset: 0,
    state: {} as Record<string, unknown>,
  };
  const lineBudget = Math.max(limit, RECENT_TRANSCRIPT_LINES_PER_FILE);
  const kindKey = [...(options?.kinds ?? [])].sort().join(",");
  const maxReadBytes = options?.kinds?.size
    ? RECENT_TRANSCRIPT_KIND_SCAN_READ_BYTES
    : SESSION_TRANSCRIPT_READ_BYTES;
  const replayVariant = source.parseFile
    ? `session:file:${source.name}:${sessionRegistryKey(transcript)}:${maxReadBytes}:${kindKey}`
    : `session:lines:${source.name}:${sessionRegistryKey(transcript)}:${lineBudget}:${maxReadBytes}:${kindKey}:${options?.kindQuota ?? ""}`;

  const parsed = await memoizedTranscriptReplay(transcript.transcriptPath, replayVariant, async () => {
    if (source.parseFile) {
      const text = await readTranscriptText(transcript.transcriptPath, maxReadBytes);
      if (!text) return [];
      return parsedEventsToArray(source.parseFile(text, ctxBase))
        .map(redactTailEvent);
    }
    return parseRecentTranscriptLineEvents({
      source,
      transcriptPath: transcript.transcriptPath,
      context: ctxBase,
      lineLimit: lineBudget,
      initialReadBytes: options?.initialReadBytes ?? SESSION_TRANSCRIPT_READ_BYTES,
      maxReadBytes,
      kinds: options?.kinds,
      kindQuota: options?.kindQuota,
    });
  }, source.parseFile ? { size: transcript.size, mtimeMs: transcript.mtimeMs } : undefined);

  return parsed
    .filter((event) => !options?.kinds?.size || options.kinds.has(event.kind))
    .sort((left, right) => left.ts - right.ts)
    .slice(-limit);
}

export async function readTailEventsForSession(
  sessionRef: string,
  options?: {
    discovery?: DiscoverySnapshot;
    limit?: number;
    forceDiscovery?: boolean;
    /** Exact Tail history also supports Claude/Codex; Observe keeps its own adapters. */
    includeAllSources?: boolean;
  },
): Promise<{ transcript: DiscoveredTranscript; events: TailEvent[] } | null> {
  const normalizedRef = normalizeTailSessionRef(sessionRef);
  if (!normalizedRef) return null;

  const discovery = options?.discovery
    ?? await getTailDiscovery(options?.forceDiscovery ?? false);
  const allowsSource = (source: string) => Boolean(options?.includeAllSources) || NATIVE_TAIL_SOURCES.has(source);
  const transcript = discovery.transcripts.find(
    (candidate) => allowsSource(candidate.source)
      && transcriptMatchesSessionRef(candidate, normalizedRef),
  ) ?? locateTranscriptOutsideDiscovery(normalizedRef, Boolean(options?.includeAllSources), allowsSource);
  if (!transcript) return null;

  const limit = options?.limit ?? 2_000;
  const sessionId = transcript.sessionId?.trim() || normalizedRef;
  let events = snapshotSessionEvents(sessionId, transcript.source, limit);
  if (events.length === 0) {
    events = await parseTranscriptSessionEvents(transcript, discovery.processes, limit);
  }

  return { transcript, events };
}

const LOCATED_TRANSCRIPT_TTL_MS = 30_000;
/** Shorter for a miss: a just-started run writes its rollout a moment later. */
const LOCATED_TRANSCRIPT_MISS_TTL_MS = 10_000;
const LOCATED_TRANSCRIPT_LIMIT = 256;
const locatedTranscripts = new Map<string, { transcript: DiscoveredTranscript | null; checkedAt: number }>();

/**
 * Exact-session lookup past discovery. Discovery keeps only transcripts touched
 * within its window (a day) and the newest few hundred, so a task that finished
 * two days ago is not in it, however recently someone opens its page. Each
 * source that can find a transcript by id is asked directly. Answers are kept
 * briefly because an empty Task tail retries every few seconds.
 */
function locateTranscriptOutsideDiscovery(
  normalizedRef: string,
  includeAllSources: boolean,
  allowsSource: (source: string) => boolean,
): DiscoveredTranscript | null {
  const key = `${includeAllSources ? "all" : "native"}\u0000${normalizedRef}`;
  const now = Date.now();
  const cached = locatedTranscripts.get(key);
  const ttl = cached?.transcript ? LOCATED_TRANSCRIPT_TTL_MS : LOCATED_TRANSCRIPT_MISS_TTL_MS;
  if (cached && now - cached.checkedAt < ttl) return cached.transcript;

  let transcript: DiscoveredTranscript | null = null;
  for (const source of sources) {
    if (!source.findTranscript || !allowsSource(source.name)) continue;
    try {
      transcript = source.findTranscript(normalizedRef);
    } catch {
      transcript = null;
    }
    if (transcript) break;
  }
  locatedTranscripts.delete(key);
  locatedTranscripts.set(key, { transcript, checkedAt: now });
  while (locatedTranscripts.size > LOCATED_TRANSCRIPT_LIMIT) {
    const oldest = locatedTranscripts.keys().next().value;
    if (oldest === undefined) break;
    locatedTranscripts.delete(oldest);
  }
  return transcript;
}
