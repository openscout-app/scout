import type { ControlPlaneHistoryReader, HistoricalRecord, HistoricalPublication } from "./control-plane-history-store.js";
import type { BrokerMessageHistory } from "./broker-message-history.js";
import { journalEntryProblem, readableCanonicalMessage, readableJournalKinds } from "./broker-journal-record-contract.js";
import { isUtf8 } from "node:buffer";
import { BrokerQuarantine, type QuarantineListOptions } from "./broker-quarantine.js";
import { shareLoadedRecordStrings } from "./broker-record-strings.js";
import { captureMessageRecords, asyncMessageRecordView } from "./broker-message-records.js";
import type { BrokerMemoryMaintenance } from "./broker-memory-maintenance.js";
import { applyHistoryRotationEviction, emptyHistoryRotationPlan, planHistoryRotation, type HistoryRotationContext, type HistoryRotationPlan } from "./history-rotation.js";
import { setImmediate as yieldReadTurn } from "node:timers/promises";
import { readableDelivery, readableDeliveryStatus, readableMetadata, type BrokerRecordRead } from "./broker-record-reader.js";
import { BrokerMessageBodyCache, BrokerMessageBodyCacheUnavailable, type MessageBodyCacheOptions } from "./broker-message-body-cache.js";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readdir, rename, stat, truncate, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { decodeJournalLine, encodeJournalEntries, journalLines, JournalFrameLimitError, UnsupportedJournalFrameError } from "./broker-journal-framing.js";

import type {
  ControlEvent,
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  CollaborationEvent,
  CollaborationRecord,
  ConversationBinding,
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryAttempt,
  DeliveryIntent,
  DurableAction,
  DurableActionHeartbeatInput,
  DurableAttempt,
  DurableCheckpoint,
  DurableSignal,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
  ScoutDispatchRecord,
} from "@openscout/protocol";

import {
  createRuntimeRegistrySnapshot,
  type RuntimeActorIdentity,
  type RuntimeAgentDefinition,
  type RuntimeRegistrySnapshot,
} from "./registry.js";
import { invocationDispatchJobId, type BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";

export type BrokerJournalEntry =
  | { kind: "node.upsert"; node: NodeDefinition }
  | { kind: "actor.upsert"; actor: RuntimeActorIdentity }
  | { kind: "agent.upsert"; agent: RuntimeAgentDefinition }
  // conversationIds is the delete preimage — the memberships captured before
  // the row went away — so the conversation projection can re-evaluate exactly
  // those rooms instead of scanning every direct conversation.
  | { kind: "agent.delete"; agentId: string; conversationIds?: string[] }
  | { kind: "agent.endpoint.upsert"; endpoint: AgentEndpoint }
  | { kind: "agent.endpoint.delete"; endpointId: string; agentId?: string }
  | { kind: "actor.delete"; actorId: string; conversationIds?: string[] }
  | { kind: "conversation.upsert"; conversation: ConversationDefinition }
  | { kind: "binding.upsert"; binding: ConversationBinding }
  | { kind: "message.record"; message: MessageRecord }
  | { kind: "conversation.read_cursor.upsert"; cursor: ConversationReadCursor }
  | { kind: "invocation.record"; invocation: InvocationRequest }
  | { kind: "invocation.dispatch_job.record"; job: BrokerInvocationDispatchJob }
  | { kind: "flight.record"; flight: FlightRecord; preserveCurrent?: boolean }
  | { kind: "collaboration.record"; record: CollaborationRecord }
  | { kind: "collaboration.event.record"; event: CollaborationEvent }
  | { kind: "deliveries.record"; deliveries: DeliveryIntent[] }
  | { kind: "delivery.attempt.record"; attempt: DeliveryAttempt }
  | { kind: "durable.action.record"; action: DurableAction }
  | { kind: "durable.action.heartbeat"; input: DurableActionHeartbeatInput }
  | { kind: "durable.attempt.record"; attempt: DurableAttempt }
  | { kind: "durable.checkpoint.record"; checkpoint: DurableCheckpoint }
  | { kind: "durable.signal.record"; signal: DurableSignal }
  | { kind: "control.event.record"; event: ControlEvent }
  | { kind: "journal.replay_barrier"; barrier: BrokerJournalReplayBarrier }
  | {
      kind: "delivery.status.update";
      deliveryId: string;
      status: DeliveryIntent["status"];
      metadata?: Record<string, unknown>;
      leaseOwner?: string | null;
      leaseExpiresAt?: number | null;
    }
  | { kind: "scout.dispatch.record"; dispatch: ScoutDispatchRecord }
  // Week-clock hot-set rotation marker: the snapshot and journal keep only the
  // live windows; SQLite holds everything. One logical stream — only the
  // newest survives compaction.
  | {
      kind: "history.rotate";
      cutoff: number;
      rotatedAt: number;
      /** Durable publication receipts; replay completes SQL cleanup after a crash. */
      publications?: HistoricalPublication[];
      /**
       * The ids the writer verified as persisted in durable SQLite before
       * journaling this marker. Apply removes exactly these records and
       * compaction dooms exactly these lines — eligibility is never
       * recomputed. Absent only on markers written before the verified
       * plan landed; those fall back to recomputing the closure rules.
       */
      evicted?: {
        messageIds: string[];
        invocationIds: string[];
        flightIds: string[];
        deliveryIds: string[];
        collaborationEventIds: string[];
        /**
         * Optional only for markers written between the verified-marker
         * change and delivery-attempt verification; absent means no
         * attempts were doomed — an empty set must evict nothing.
         */
        deliveryAttemptIds?: string[];
        /** Full canonical job records published to indexed historical partitions. */
        dispatchJobIds?: string[];
        /** Exact unchanged event rows durably published to indexed history. */
        controlEventIds?: string[];
      };
    };


type JournalSnapshotState = {
  snapshot: RuntimeRegistrySnapshot;
  /** Actor ids deleted by a tombstone entry. Not part of the wire snapshot —
   * replayed deletes rebuild it so the runtime can fence stale roster writes
   * that would resurrect a retired actor's membership. */
  retiredActorIds: Set<string>;
  collaborationEvents: CollaborationEvent[];
  deliveries: Map<string, DeliveryIntent>;
  deliveryAttempts: Map<string, DeliveryAttempt[]>;
  durableActions: Map<string, DurableAction>;
  invocationDispatchJobs: Map<string, BrokerInvocationDispatchJob>;
  scoutDispatches: ScoutDispatchRecord[];
};

export type BrokerJournalLoadReport = {
  startedAt: number;
  completedAt: number;
  totalMs: number;
  scanMs: number;
  compactionMs: number;
  sourceBytes: number;
  compactedBytes: number;
  validEntries: number;
  invalidLines: number;
  blankLines: number;
  compactionRequired: boolean;
  estimatedReclaimBytes: number;
  estimatedReclaimRatio: number;
  compactionReason: BrokerJournalCompactionReason | null;
  countsByKind: Partial<Record<BrokerJournalEntry["kind"], number>>;
};

/** Only the candidate records needed to verify one historical relocation. */
export type BrokerJournalVerificationRecords = {
  messages: MessageRecord[];
  invocations: InvocationRequest[];
  flights: FlightRecord[];
  deliveries: DeliveryIntent[];
  deliveryAttempts: DeliveryAttempt[];
  collaborationEvents: CollaborationEvent[];
};

export type BrokerJournalCompactionReason = "bytes" | "ratio" | "high_water";

export type BrokerJournalLiveCompactionOptions = {
  signal?: AbortSignal;
  historicalCleanupApplied?: boolean;
  historicalCleanupBoundary?: BrokerJournalReplayBoundary;
  minimumBytes?: number;
  minimumIntervalMs?: number;
  maxEntries?: number;
  maxTrackedKeys?: number;
  maxDurationMs?: number;
};
export type BrokerJournalLiveCompactionReport = {
  state: "compacted" | "skipped" | "budget";
  reason: string;
  sourceBytes: number;
  resultingBytes: number;
  estimatedReclaimBytes: number;
  durationMs: number;
};

export type BrokerJournalCompactionPolicy = {
  minimumReclaimBytes: number;
  minimumReclaimRatio: number;
  highWaterBytes: number;
  highWaterMinimumReclaimBytes: number;
};

export type FileBackedBrokerJournalOptions = {
  messageHistory?: BrokerMessageHistory;
  dispatchJobHistory?: Pick<ControlPlaneHistoryReader, "read" | "readLocation" | "page">;
  progressiveStartup?: boolean;
  shareLoadedStrings?: boolean;
  compactionPolicy?: Partial<BrokerJournalCompactionPolicy>;
  messageBodyCache?: MessageBodyCacheOptions;
  memoryMaintenance?: BrokerMemoryMaintenance;
};

const DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY: BrokerJournalCompactionPolicy = {
  // Rewriting the journal has a fixed cost proportional to the whole file, not
  // to the superseded entries. A few changing registry heartbeats must not turn
  // every broker boot into a full-file rewrite.
  minimumReclaimBytes: 4 * 1024 * 1024,
  minimumReclaimRatio: 0.05,
  // Once the journal is large, accept a smaller absolute win so redundant
  // registry history cannot grow without bound. The 1 MiB floor still prevents
  // a single tiny duplicate from rewriting hundreds of megabytes.
  highWaterBytes: 256 * 1024 * 1024,
  highWaterMinimumReclaimBytes: 1024 * 1024,
};

type DedupableJournalEntry =
  | BrokerJournalEntry & { kind: "node.upsert" }
  | BrokerJournalEntry & { kind: "actor.upsert" }
  | BrokerJournalEntry & { kind: "actor.delete" }
  | BrokerJournalEntry & { kind: "agent.upsert" }
  | BrokerJournalEntry & { kind: "agent.delete" }
  | BrokerJournalEntry & { kind: "agent.endpoint.upsert" }
  | BrokerJournalEntry & { kind: "agent.endpoint.delete" }
  | BrokerJournalEntry & { kind: "conversation.upsert" }
  | BrokerJournalEntry & { kind: "binding.upsert" }
  | BrokerJournalEntry & { kind: "history.rotate" };

type JournalVisitReport = {
  rawLines: number;
  validEntries: number;
  invalidLines: number;
  blankLines: number;
};

type AppliedHistoryRotation = HistoryRotationPlan & {
  cutoff: number;
  dispatchJobIds?: Set<string>;
  controlEventIds?: Set<string>;
};

/** The `evicted` wire shape on a `history.rotate` marker, as id Sets. */
function historyRotationPlanFromMarker(
  evicted: NonNullable<Extract<BrokerJournalEntry, { kind: "history.rotate" }>["evicted"]>,
): HistoryRotationPlan & { dispatchJobIds: Set<string>; controlEventIds: Set<string> } {
  const plan = { ...emptyHistoryRotationPlan(), dispatchJobIds: new Set(evicted.dispatchJobIds ?? []), controlEventIds: new Set(evicted.controlEventIds ?? []) };
  for (const id of evicted.messageIds) plan.messageIds.add(id);
  for (const id of evicted.invocationIds) plan.invocationIds.add(id);
  for (const id of evicted.flightIds) plan.flightIds.add(id);
  for (const id of evicted.deliveryIds) plan.deliveryIds.add(id);
  for (const id of evicted.deliveryAttemptIds ?? []) plan.deliveryAttemptIds.add(id);
  for (const id of evicted.collaborationEventIds) plan.collaborationEventIds.add(id);
  return plan;
}

/**
 * Whether a record line that predates the rotate marker was evicted by it:
 * "all" drops the whole line, "partial" (a deliveries.record carrying both
 * doomed and surviving intents) keeps the line filtered, "none" keeps it.
 */
function historyRotationDropsEntry(
  rotations: readonly AppliedHistoryRotation[],
  entry: BrokerJournalEntry,
): "all" | "partial" | "none" {
  if (rotations.length === 0) return "none";
  switch (entry.kind) {
    case "control.event.record":
      return rotations.some(r => r.controlEventIds?.has(entry.event.id)) ? "all" : "none";
    case "invocation.dispatch_job.record":
      return rotations.some((r) => r.dispatchJobIds?.has(entry.job.id)) ? "all" : "none";
    case "message.record":
      return rotations.some((r) => r.messageIds.has(entry.message.id)) ? "all" : "none";
    case "flight.record":
      return rotations.some((r) => r.flightIds.has(entry.flight.id)) ? "all" : "none";
    case "invocation.record":
      return rotations.some((r) => r.invocationIds.has(entry.invocation.id)) ? "all" : "none";
    case "deliveries.record": {
      const kept = entry.deliveries.filter(
        (delivery) => !rotations.some((r) => r.deliveryIds.has(delivery.id)),
      );
      if (kept.length === 0) return "all";
      return kept.length === entry.deliveries.length ? "none" : "partial";
    }
    case "delivery.attempt.record":
      return rotations.some((r) => r.deliveryAttemptIds.has(entry.attempt.id)) ? "all" : "none";
    case "collaboration.event.record":
      return rotations.some((r) => r.collaborationEventIds.has(entry.event.id)) ? "all" : "none";
    default:
      return "none";
  }
}

export type BrokerJournalReplayBoundary = {
  endByteExclusive: number;
  barrier?: BrokerJournalReplayBarrier;
  /** Byte offsets may only be reused while this opened-file identity matches. */
  fileIdentity?: string;
};

/**
 * An opaque, durable position in the broker journal. Byte offsets are useful
 * only for one open file: journal compaction rewrites them. The marker itself
 * remains in the order-preserving journal stream, so a SQLite projection can
 * safely resume after it even when compaction changed every byte position.
 */
export type BrokerJournalReplayBarrier = {
  id: string;
  projectionId: string;
  projectionVersion: number;
  createdAt: number;
};

export type BrokerJournalReplayReport = {
  afterBarrierFound: boolean;
  visitedEntries: number;
};

export type BrokerJournalReplayOptions = {
  /** Internal tail cursor, valid only with a matching boundary fileIdentity. */
  startByteInclusive?: number;
  afterBarrier?: Pick<
    BrokerJournalReplayBarrier,
    "id" | "projectionId" | "projectionVersion"
  >;
};

function sameReplayBarrier(
  left: BrokerJournalReplayBarrier,
  right: NonNullable<BrokerJournalReplayOptions["afterBarrier"]>,
): boolean {
  return left.id === right.id
    && left.projectionId === right.projectionId
    && left.projectionVersion === right.projectionVersion;
}

function cloneSnapshot(snapshot: RuntimeRegistrySnapshot): RuntimeRegistrySnapshot {
  return createRuntimeRegistrySnapshot({
    nodes: { ...snapshot.nodes },
    actors: { ...snapshot.actors },
    agents: { ...snapshot.agents },
    endpoints: { ...snapshot.endpoints },
    conversations: { ...snapshot.conversations },
    bindings: { ...snapshot.bindings },
    messages: captureMessageRecords(snapshot.messages),
    readCursors: { ...snapshot.readCursors },
    invocations: { ...snapshot.invocations },
    flights: { ...snapshot.flights },
    collaborationRecords: { ...snapshot.collaborationRecords },
  });
}

function mergeMetadata(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!patch) {
    return current;
  }

  return {
    ...(current ?? {}),
    ...patch,
  };
}

function normalizeComparableValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableValue(entry));
  }

  if (value && typeof value === "object") {
    const normalizedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeComparableValue(entry)] as const);
    return Object.fromEntries(normalizedEntries);
  }

  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeComparableValue(left))
    === JSON.stringify(normalizeComparableValue(right));
}

function dedupeKey(entry: BrokerJournalEntry): string | null {
  switch (entry.kind) {
    case "node.upsert":
      return `${entry.kind}:${entry.node.id}`;
    case "actor.upsert":
      return `${entry.kind}:${entry.actor.id}`;
    case "actor.delete":
      // A delete shares its upsert's key so compaction keeps only the final
      // state for the record — whether that state is a row or its absence.
      return `actor.upsert:${entry.actorId}`;
    case "agent.upsert":
      return `${entry.kind}:${entry.agent.id}`;
    case "agent.delete":
      return `agent.upsert:${entry.agentId}`;
    case "agent.endpoint.upsert":
      return `${entry.kind}:${entry.endpoint.id}`;
    case "agent.endpoint.delete":
      return `agent.endpoint.upsert:${entry.endpointId}`;
    case "conversation.upsert":
      return `${entry.kind}:${entry.conversation.id}`;
    case "binding.upsert":
      return `${entry.kind}:${entry.binding.id}`;
    case "history.rotate":
      // One logical rotation stream — compaction keeps only the newest marker.
      return "history.rotate";
    default:
      return null;
  }
}

function isDedupableEntry(entry: BrokerJournalEntry): entry is DedupableJournalEntry {
  return dedupeKey(entry) !== null;
}

function resolveCompactionPolicy(
  input: FileBackedBrokerJournalOptions["compactionPolicy"],
): BrokerJournalCompactionPolicy {
  const resolveNonNegative = (value: number | undefined, fallback: number): number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
  );
  return {
    minimumReclaimBytes: resolveNonNegative(
      input?.minimumReclaimBytes,
      DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY.minimumReclaimBytes,
    ),
    minimumReclaimRatio: resolveNonNegative(
      input?.minimumReclaimRatio,
      DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY.minimumReclaimRatio,
    ),
    highWaterBytes: resolveNonNegative(
      input?.highWaterBytes,
      DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY.highWaterBytes,
    ),
    highWaterMinimumReclaimBytes: resolveNonNegative(
      input?.highWaterMinimumReclaimBytes,
      DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY.highWaterMinimumReclaimBytes,
    ),
  };
}

function journalCompactionReason(
  sourceBytes: number,
  estimatedReclaimBytes: number,
  policy: BrokerJournalCompactionPolicy,
): BrokerJournalCompactionReason | null {
  if (sourceBytes <= 0 || estimatedReclaimBytes <= 0) return null;
  if (estimatedReclaimBytes >= policy.minimumReclaimBytes) return "bytes";
  if (estimatedReclaimBytes / sourceBytes >= policy.minimumReclaimRatio) return "ratio";
  if (
    sourceBytes >= policy.highWaterBytes
    && estimatedReclaimBytes >= policy.highWaterMinimumReclaimBytes
  ) {
    return "high_water";
  }
  return null;
}

/** Health of canonical journal appends. `failing` clears on the next success. */
export type BrokerJournalWriteStatus =
  | { state: "ok" }
  | { state: "failing"; since: number; lastFailedAt: number; failures: number; code: string | null; error: string };

function errorCode(error: unknown): string | null {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

class JournalCompactionCapacityError extends Error {
  constructor(readonly operation: string, readonly code: "ENOSPC" | "EDQUOT", cause: unknown) {
    super(`Journal compaction ${operation}: ${String(cause)}`, { cause });
  }
}

async function writeCompactionOutput<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOSPC" || code === "EDQUOT") {
      throw new JournalCompactionCapacityError(operation, code, error);
    }
    throw error;
  }
}

export class FileBackedBrokerJournal {
  private readonly filePath: string;
  private readonly quarantine: BrokerQuarantine;
  private readonly warnedQuarantine = new Set<string>();

  quarantineStatus() { return this.quarantine.status(); }
  listQuarantine(options: QuarantineListOptions = {}) { return this.quarantine.list(options); }
  readQuarantine(id: string) { return this.quarantine.read(id); }
  acknowledgeQuarantine(id: string) { return this.quarantine.acknowledge(id); }
  quarantineRecord(entry: BrokerJournalEntry, reason: string) {
    return this.quarantine.preserve({ kind: entry.kind, reason, bytes: Buffer.from(JSON.stringify(entry)),
      source: { path: this.filePath }, entries: [entry] });
  }

  private readonly messageHistory?: BrokerMessageHistory;
  private readonly dispatchJobHistory?: FileBackedBrokerJournalOptions["dispatchJobHistory"];
  private readonly messageBodyCache?: BrokerMessageBodyCache;
  private readonly shareLoadedStrings: boolean;
  private readonly memoryMaintenance?: BrokerMemoryMaintenance;

  private readonly state: JournalSnapshotState = {
    snapshot: createRuntimeRegistrySnapshot(),
    retiredActorIds: new Set<string>(),
    collaborationEvents: [],
    deliveries: new Map<string, DeliveryIntent>(),
    deliveryAttempts: new Map<string, DeliveryAttempt[]>(),
    durableActions: new Map<string, DurableAction>(),
    invocationDispatchJobs: new Map<string, BrokerInvocationDispatchJob>(),
    scoutDispatches: [],
  };

  private loaded = false;

  private latestLoadReport: BrokerJournalLoadReport | null = null;

  /** Eviction sets per applied history.rotate, in journal order. Compaction
   * drops a record line when ANY rotation after the line doomed it — later
   * markers alone cannot describe what earlier ones evicted. */
  private appliedRotations: AppliedHistoryRotation[] = [];
  private readonly pendingResultFlights = new Map<string, FlightRecord>();
  private readonly currentFlightIds = new Map<string, string>();
  private readonly pendingTerminalReportFlights = new Map<string, FlightRecord>();
  private readonly pendingWorkPromotionFlights = new Map<string, FlightRecord>();
  private readonly dispatchJobIdsByInvocation = new Map<string, Set<string>>();
  private readonly dispatchJobIdsByFlight = new Map<string, Set<string>>();
  private readonly recoverableDispatchJobs = new Map<string, BrokerInvocationDispatchJob>();
  private readonly archivableDispatchJobs = new Map<string, BrokerInvocationDispatchJob>();
  private readonly pendingPeerMirrors = new Map<string, DeliveryIntent>();
  private readonly pendingPeerForwards = new Map<string, DeliveryIntent>();
  private readonly peerMirrorDeliveryIdsByFlight = new Map<string, Set<string>>();

  // Serializes journal writes. Every link must settle fulfilled: one failed
  // append (a full disk) would otherwise reject every later write forever.
  private writeQueue: Promise<void> = Promise.resolve();

  private writeFailure: Extract<BrokerJournalWriteStatus, { state: "failing" }> | null = null;

  // Keep the original boundary until rollback succeeds; never append behind
  // bytes from an unacknowledged write, even when the rollback itself fails.
  private pendingRollbackBytes: number | null = null;
  private appendPrefix: string | null = null;

  private readonly compactionPolicy: BrokerJournalCompactionPolicy;
  private readonly progressiveStartup: boolean;
  private finishStartupWork: (() => Promise<void>) | undefined;
  private startupWork: Promise<void> | undefined;
  private startupPhase: "journal" | "maintenance" | "history" | "complete" | "failed" = "journal";
  private startupCompactionMs = 0;
  private startupCompactionDeferral: { code: "ENOSPC" | "EDQUOT"; operation: string; error: string } | null = null;
  private startupError: string | null = null;
  private replayedEntries = 0;
  private replayedBytes = 0;
  private startupSourceBytes: number | null = null;
  private liveCompactionWork: Promise<BrokerJournalLiveCompactionReport> | null = null;
  private lastLiveCompactionAt = 0;
  private latestLiveCompaction: BrokerJournalLiveCompactionReport | null = null;

  startupStatus() { return { phase: this.startupPhase, entries: this.replayedEntries,
    messageCount: this.startupPhase === "complete" ? this.messageHistory?.status().count ?? Object.keys(this.state.snapshot.messages).length : null,
    bytes: this.replayedBytes, totalBytes: this.startupSourceBytes, compactionMs: this.startupCompactionMs,
    compactionDeferral: this.startupCompactionDeferral ? { ...this.startupCompactionDeferral } : null, error: this.startupError }; }

  writeStatus(): BrokerJournalWriteStatus {
    return this.writeFailure ? { ...this.writeFailure } : { state: "ok" };
  }

  liveCompactionStatus(): BrokerJournalLiveCompactionReport | null {
    return this.latestLiveCompaction ? { ...this.latestLiveCompaction } : null;
  }

  /** Scan a fixed prefix cooperatively, then preserve every accepted suffix
   * byte under the append queue before fsync + atomic rename. No accepted
   * history becomes eligible merely because it is old or projected. */
  compactIfNeeded(options: BrokerJournalLiveCompactionOptions = {}): Promise<BrokerJournalLiveCompactionReport> {
    if (this.liveCompactionWork) return this.liveCompactionWork;
    const work = this.compactLivePrefix(options);
    this.liveCompactionWork = work.finally(() => { this.liveCompactionWork = null; });
    return this.liveCompactionWork;
  }

  private async compactLivePrefix(options: BrokerJournalLiveCompactionOptions): Promise<BrokerJournalLiveCompactionReport> {
    const start = Date.now();
    const finite = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
    const minimumInterval = finite(options.minimumIntervalMs, 5 * 60_000);
    const report = (state: BrokerJournalLiveCompactionReport["state"], reason: string, sourceBytes = 0, resultingBytes = sourceBytes, estimatedReclaimBytes = 0) => {
      const value = { state, reason, sourceBytes, resultingBytes, estimatedReclaimBytes, durationMs: Date.now() - start };
      this.latestLiveCompaction = value; return value;
    };
    if (!this.loaded || this.startupPhase !== "complete") return report("skipped", "startup_pending");
    if (start - this.lastLiveCompactionAt < minimumInterval) return report("skipped", "interval");
    const boundary = await this.captureReplayBoundary();
    if (boundary.endByteExclusive < finite(options.minimumBytes, 64 * 1024 * 1024)) return report("skipped", "below_threshold", boundary.endByteExclusive);
    this.lastLiveCompactionAt = start;
    const maximumEntries = finite(options.maxEntries, 1_000_000);
    const maximumKeys = finite(options.maxTrackedKeys, 100_000);
    const maximumMs = finite(options.maxDurationMs, 30_000);
    const budgetError = new Error("journal_compaction_budget");
    const checkBudget = () => { options.signal?.throwIfAborted(); if (Date.now() - start > maximumMs) throw budgetError; };
    const latest = new Map<string, number>(), encodedBytes = new Map<string, number>();
    const rotations: AppliedHistoryRotation[] = [];
    let estimatedReclaimBytes = 0, trackedRotationIds = 0;
    let cleanupThroughIndex = -1;
    const cleanupBoundary = options.historicalCleanupApplied ? options.historicalCleanupBoundary : undefined;
    const legacyRotations = [...this.appliedRotations];
    try {
      await this.visitEntries(async (entry, index, bytes, physicalEndByte) => {
        if (cleanupBoundary?.fileIdentity && cleanupBoundary.fileIdentity === boundary.fileIdentity && physicalEndByte <= cleanupBoundary.endByteExclusive) cleanupThroughIndex = index;
        checkBudget();
        if (index >= maximumEntries) throw budgetError;
        if (index % 128 === 0) await yieldReadTurn();
        const key = dedupeKey(entry);
        if (key) {
          estimatedReclaimBytes += encodedBytes.get(key) ?? 0;
          latest.set(key, index); encodedBytes.set(key, bytes);
          if (latest.size + trackedRotationIds > maximumKeys) throw budgetError;
        }
        if (entry.kind === "history.rotate") {
          const rotation = entry.evicted ? { cutoff: entry.cutoff, ...historyRotationPlanFromMarker(entry.evicted) }
            : legacyRotations.find(value => value.cutoff === entry.cutoff);
          if (!rotation) throw new Error("journal_compaction_rotation_coverage_unavailable");
          rotations.push(rotation);
          for (const [key, value] of Object.entries(rotation)) if (key !== "cutoff" && value instanceof Set) trackedRotationIds += value.size;
          if (latest.size + trackedRotationIds > maximumKeys) throw budgetError;
        }
      }, boundary);
      const lastRotation = latest.get("history.rotate");
      if (lastRotation !== undefined) {
        const remaining = [...rotations];
        await this.visitEntries(async (entry, index, bytes) => {
          checkBudget(); if (index % 128 === 0) await yieldReadTurn();
          if (index >= lastRotation) return;
          if (entry.kind === "history.rotate") { remaining.shift(); return; }
          if (historyRotationDropsEntry(remaining, entry) === "all") estimatedReclaimBytes += bytes;
        }, boundary);
      }
      const reason = journalCompactionReason(boundary.endByteExclusive, estimatedReclaimBytes, this.compactionPolicy);
      if (!reason) return report("skipped", "insufficient_reclaim", boundary.endByteExclusive, boundary.endByteExclusive, estimatedReclaimBytes);
      await this.rewriteCompactedEntries(latest, boundary.endByteExclusive, { boundary, rotations, dedupeFlights: false, checkBudget, cleanupThroughIndex });
      // Generation refresh notices the inode change. Existing captures keep
      // their prior generation alive until their readers release it.
      await this.messageHistory?.refresh();
      return report("compacted", reason, boundary.endByteExclusive, (await stat(this.filePath)).size, estimatedReclaimBytes);
    } catch (error) {
      if (error === budgetError) return report("budget", "scan_budget", boundary.endByteExclusive, boundary.endByteExclusive, estimatedReclaimBytes);
      throw error;
    }
  }

  /**
   * Append whole lines or nothing. A failed append (ENOSPC mid-write) can
   * leave a partial line; the next append would fuse onto it and replay would
   * drop both records. Roll the file back to its length before the attempt.
   */
  private async appendLines(payload: string): Promise<void> {
    try {
      await this.repairFailedAppend();
      const before = await stat(this.filePath).then((value) => value.size, (error) => {
        if (errorCode(error) === "ENOENT") return 0;
        throw error;
      });
      // A previous process may have left an unterminated line. Separate it
      // from new records so replay can reject only that old fragment. Preserve
      // complete legacy records that happen to lack a trailing newline.
      if (this.appendPrefix === null && before > 0) {
        const file = await open(this.filePath, "r");
        try {
          const last = Buffer.alloc(1);
          await file.read(last, 0, 1, before - 1);
          this.appendPrefix = last[0] === 10 ? "" : "\n";
        } finally {
          await file.close();
        }
      }
      try {
        await appendFile(this.filePath, (this.appendPrefix ?? "") + payload, "utf8");
        const durable = await open(this.filePath, "r+");
        try { await durable.sync(); } finally { await durable.close(); }
        // Persist a newly created journal's directory entry before acknowledging.
        if (before === 0) await this.syncDirectory();
        this.appendPrefix = "";
      } catch (error) {
        this.pendingRollbackBytes = before;
        // Preserve the original append error for this caller. Subsequent
        // writes retry repair and report its error until storage recovers.
        await this.repairFailedAppend().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      const now = Date.now();
      this.writeFailure = {
        state: "failing",
        since: this.writeFailure?.since ?? now,
        lastFailedAt: now,
        failures: (this.writeFailure?.failures ?? 0) + 1,
        code: errorCode(error),
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
    this.writeFailure = null;
  }

  private async repairFailedAppend(): Promise<void> {
    const boundary = this.pendingRollbackBytes;
    if (boundary === null) return;
    await truncate(this.filePath, boundary).catch(error => {
      // An append can fail before creating a previously absent journal.
      if (boundary !== 0 || errorCode(error) !== "ENOENT") throw error;
    });
    const file = await open(this.filePath, "r+").catch(error => {
      if (boundary === 0 && errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (file) try { await file.sync(); } finally { await file.close(); }
    this.pendingRollbackBytes = null;
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(dirname(this.filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  finishStartup(): Promise<void> {
    if (!this.loaded) return Promise.reject(new Error("Journal must be loaded before startup hydration."));
    if (this.startupWork) return this.startupWork;
    const work = this.finishStartupWork;
    // Release the compaction dedupe map after the one hydration call. The
    // resolved promise must not keep the historical metadata closure resident.
    this.finishStartupWork = undefined;
    return this.startupWork = (work?.() ?? Promise.resolve()).catch(error => {
      this.startupPhase = "failed";
      this.startupError = String(error);
      throw error;
    });
  }


  constructor(filePath: string, options: FileBackedBrokerJournalOptions = {}) {
    this.filePath = filePath;
    this.quarantine = new BrokerQuarantine(`${filePath}.quarantine.sqlite`);
    this.progressiveStartup = options.progressiveStartup ?? false;
    this.messageHistory = options.messageHistory;
    this.dispatchJobHistory = options.dispatchJobHistory;
    if(this.messageHistory)this.state.snapshot.messages=this.messageHistory.records;
    this.shareLoadedStrings = options.shareLoadedStrings ?? false;
    this.memoryMaintenance = options.memoryMaintenance;
    if (options.messageBodyCache) this.messageBodyCache = new BrokerMessageBodyCache(dirname(filePath), {
      ...options.messageBodyCache,
    });
    this.compactionPolicy = resolveCompactionPolicy(options.compactionPolicy);
  }

  async load(): Promise<BrokerJournalLoadReport> {
    if (this.loaded) {
      return this.latestLoadReport!;
    }

    if(this.messageHistory){await mkdir(dirname(this.filePath),{recursive:true});await appendFile(this.filePath, "", "utf8");}
    const startedAt = Date.now();
    await this.reapOrphanedCompactionTemps();
    const sourceBytes = await stat(this.filePath).then((value) => value.size).catch((error) => {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === "ENOENT") return 0;
      throw error;
    });
    this.startupSourceBytes = sourceBytes;
    const latestIndexByKey = new Map<string, number>();
    const latestEncodedBytesByKey = new Map<string, number>();
    const lastFlightById = new Map<string, FlightRecord>();
    const scannedCurrentFlightIds = new Map<string, string>();
    const countsByKind: BrokerJournalLoadReport["countsByKind"] = {};
    let estimatedReclaimBytes = 0;

    const scanStartedAt = Date.now();
    const scan = await this.visitEntries((entry, index, encodedLineBytes) => {
      this.replayedEntries++; this.replayedBytes += encodedLineBytes;
      if (this.shareLoadedStrings) shareLoadedRecordStrings(entry);
      this.apply(this.messageHistory && entry.kind === "message.record" ? entry : this.prepareEntry(entry));
      countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1;
      const key = dedupeKey(entry);
      if (key) {
        const previousBytes = latestEncodedBytesByKey.get(key);
        if (previousBytes !== undefined) {
          estimatedReclaimBytes += previousBytes;
        }
        latestIndexByKey.set(key, index);
        latestEncodedBytesByKey.set(key, encodedLineBytes);
      }
      if (entry.kind === "flight.record") {
        const previous = lastFlightById.get(entry.flight.id);
        const changesCurrent = !entry.preserveCurrent && scannedCurrentFlightIds.get(entry.flight.invocationId) !== entry.flight.id;
        if (!entry.preserveCurrent) scannedCurrentFlightIds.set(entry.flight.invocationId, entry.flight.id);
        if (previous && !changesCurrent && sameValue(previous, entry.flight)) {
          estimatedReclaimBytes += encodedLineBytes;
        }
        lastFlightById.set(entry.flight.id, entry.flight);
      }
    });
    const scanMs = Date.now() - scanStartedAt;
    // Rotated-out history lines are reclaim too, but they never appear in the
    // dedupe map — measure them in a second streaming pass only when a rotate
    // marker is present. Each line is evaluated against the rotations that
    // come after it (earlier markers cannot describe a later record's fate).
    const rotationIndex = latestIndexByKey.get("history.rotate");
    if (this.appliedRotations.length > 0 && rotationIndex !== undefined) {
      const remaining = [...this.appliedRotations];
      await this.visitEntries((entry, index, encodedLineBytes) => {
        if (index >= rotationIndex) return;
        if (entry.kind === "history.rotate") {
          remaining.shift();
          return;
        }
        if (historyRotationDropsEntry(remaining, entry) === "all") {
          estimatedReclaimBytes += encodedLineBytes;
        }
      });
    }
    const estimatedReclaimRatio = sourceBytes > 0
      ? estimatedReclaimBytes / sourceBytes
      : 0;
    const compactionReason = journalCompactionReason(
      sourceBytes,
      estimatedReclaimBytes,
      this.compactionPolicy,
    );
    const compactionRequired = compactionReason !== null;

    let compactionMs = 0;
    if (compactionRequired && !this.progressiveStartup) {
      const compactionStartedAt = Date.now();
      await this.compactStartupJournal(latestIndexByKey);
      compactionMs = Date.now() - compactionStartedAt;
      this.startupCompactionMs = compactionMs;
    }

    if (!this.progressiveStartup) await this.messageHistory?.accepted();
    this.loaded = true;
    this.startupPhase = this.progressiveStartup ? "maintenance" : "complete";
    this.finishStartupWork = !this.progressiveStartup ? undefined : async () => {
      if (compactionRequired && this.progressiveStartup) {
        const start = Date.now();
        await this.compactStartupJournal(latestIndexByKey, sourceBytes);
        this.startupCompactionMs = Date.now() - start;
        // The load report was published before this deferred compaction ran —
        // fold the real numbers back in so consumers do not read `compaction
        // 0ms`, a stale post-compaction size, or a total that ended before the
        // work did.
        const compactedBytes = await stat(this.filePath).then((value) => value.size).catch(() => 0);
        if (this.latestLoadReport) {
          const completedAt = Date.now();
          this.latestLoadReport = {
            ...this.latestLoadReport,
            completedAt,
            totalMs: completedAt - this.latestLoadReport.startedAt,
            compactionMs: this.startupCompactionMs,
            compactedBytes,
          };
        }
      }
      this.startupPhase = "history";
      // Unlike accepted(), startup must surface failed history coverage.
      await this.messageHistory?.refresh();
      this.startupPhase = "complete";
    };
    const completedAt = Date.now();
    const compactedBytes = await stat(this.filePath).then((value) => value.size).catch(() => 0);
    this.latestLoadReport = {
      startedAt,
      completedAt,
      totalMs: completedAt - startedAt,
      scanMs,
      compactionMs,
      sourceBytes,
      compactedBytes,
      validEntries: scan.validEntries,
      invalidLines: scan.invalidLines,
      blankLines: scan.blankLines,
      compactionRequired,
      estimatedReclaimBytes,
      estimatedReclaimRatio,
      compactionReason,
      countsByKind,
    };
    return this.latestLoadReport;
  }

  /**
   * Remove `broker-journal.jsonl.<pid>.<ts>.tmp` siblings left behind when a
   * broker died mid-compaction. The pid is the third dot-field of the temp
   * basename; only files whose pid is not a live process are touched.
   */
  private async reapOrphanedCompactionTemps(): Promise<void> {
    const journalBase = basename(this.filePath);
    const prefix = `${journalBase}.`;
    let names: string[];
    try {
      names = await readdir(dirname(this.filePath));
    } catch {
      return;
    }
    let removed = 0;
    let removedBytes = 0;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const pidField = name.slice(prefix.length, -".tmp".length).split(".")[0];
      const pid = Number.parseInt(pidField ?? "", 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;
      let dead = false;
      try {
        process.kill(pid, 0);
      } catch (error) {
        // ESRCH means no such process — the compaction temp is an orphan.
        // EPERM means the pid exists but is not ours; leave its file alone.
        dead = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead) continue;
      const orphanPath = `${dirname(this.filePath)}/${name}`;
      const size = await stat(orphanPath).then((value) => value.size).catch(() => 0);
      await unlink(orphanPath).then(
        () => { removed += 1; removedBytes += size; },
        () => undefined,
      );
    }
    if (removed > 0) {
      console.log(`[openscout-runtime] reaped ${removed} orphaned journal compaction temp file(s), ${removedBytes} bytes`);
    }
  }

  /**
   * Complete asynchronous durable lookup, independent of SQLite/body caches.
   * A bounded streaming scan is intentionally a correctness baseline, not a
   * per-message hot-path index. Callers receive explicit source coverage.
   */
  async readCanonicalMessage(messageId: string): Promise<BrokerRecordRead<MessageRecord>> {
    if (this.quarantine.hasRecord(messageId)) return { kind: "unavailable", reason: "record_quarantined", retryable: false };
    return this.readCanonicalRecord("message", (entry, current) => {
      if (entry.kind !== "message.record") return { value: current, valid: true };
      const message = entry.message;
      const valid = readableCanonicalMessage(message);
      return { value: valid && message.id === messageId ? message : current, valid };
    });
  }

  async readCanonicalDelivery(deliveryId: string): Promise<BrokerRecordRead<DeliveryIntent>> {
    if (this.quarantine.hasRecord(deliveryId)) return { kind: "unavailable", reason: "record_quarantined", retryable: false };
    return this.readCanonicalRecord("delivery", (entry, current) => {
      if (entry.kind === "deliveries.record") {
        if (!Array.isArray(entry.deliveries) || !entry.deliveries.every(readableDelivery)) return { value: current, valid: false };
        for (const delivery of entry.deliveries) if (delivery.id === deliveryId) current = delivery;
      } else if (entry.kind === "delivery.status.update") {
        const valid = typeof entry.deliveryId === "string" && readableDeliveryStatus(entry.status)
          && readableMetadata(entry.metadata)
          && (entry.leaseOwner == null || typeof entry.leaseOwner === "string")
          && (entry.leaseExpiresAt == null || (typeof entry.leaseExpiresAt === "number" && Number.isFinite(entry.leaseExpiresAt)));
        if (!valid) return { value: current, valid: false };
        // Legacy status updates for unknown IDs never create a delivery.
        if (current && entry.deliveryId === deliveryId) current = {
          ...current, status: entry.status,
          leaseOwner: entry.leaseOwner ?? undefined, leaseExpiresAt: entry.leaseExpiresAt ?? undefined,
          metadata: mergeMetadata(current.metadata, entry.metadata),
        };
      }
      return { value: current, valid: true };
    });
  }

  private async readCanonicalRecord<T>(
    recordKind: "message" | "delivery",
    reduce: (entry: BrokerJournalEntry, current: T | undefined) => { value: T | undefined; valid: boolean },
  ): Promise<BrokerRecordRead<T>> {
    try {
      await this.load();
      const boundary = await this.captureReplayBoundary();
      const before = await stat(this.filePath);
      if (before.size < boundary.endByteExclusive) {
        return { kind: "unavailable", reason: "journal_truncated", retryable: true };
      }
      let value: T | undefined;
      let unsupported = false;
      let visited = 0;
      const report = await this.visitEntries(async (entry) => {
        if (!entry || typeof entry !== "object" || !Object.hasOwn(readableJournalKinds, entry.kind)) {
          unsupported = true;
        } else {
          const next = reduce(entry, value);
          if (!next.valid) unsupported = true;
          value = next.value;
        }
        if (++visited % 128 === 0) await yieldReadTurn();
      }, { endByteExclusive: boundary.endByteExclusive });
      const after = await stat(this.filePath);
      if (before.dev !== after.dev || before.ino !== after.ino || after.size < boundary.endByteExclusive) {
        return { kind: "unavailable", reason: "journal_changed_during_read", retryable: true };
      }
      if (unsupported || report.invalidLines > 0 || this.quarantine.hasUnknownJournalFrame()) {
        return { kind: "unavailable", reason: `journal_${recordKind}_coverage_incomplete`, retryable: false };
      }
      const coverage = { source: "broker_journal" as const, fileIdentity: `${before.dev}:${before.ino}`, endByteExclusive: boundary.endByteExclusive };
      return value ? { kind: "found", value, coverage } : { kind: "not_found", coverage };
    } catch {
      return { kind: "unavailable", reason: "journal_read_failed", retryable: true };
    }
  }

  messageBodyCacheStatus() {
    return this.messageBodyCache?.status() ?? { enabled: false };
  }


  close(): Promise<void> { this.messageBodyCache?.close(); this.quarantine.close(); return this.messageHistory?.close() ?? Promise.resolve(); }

  private deliveryValues(activeOnly = false): IterableIterator<DeliveryIntent> {
    const values = this.state.deliveries.values();
    if (!activeOnly) return values;
    return (function* () {
      for (const delivery of values) {
        if (!["acknowledged", "completed", "failed", "cancelled"].includes(delivery.status)) yield delivery;
      }
    })();
  }

  private prepareEntry(entry: BrokerJournalEntry): BrokerJournalEntry {
    return this.messageBodyCache && entry.kind === "message.record"
      ? { ...entry, message: this.messageBodyCache.prepare(entry.message) }
      : entry;
  }

  loadReport(): BrokerJournalLoadReport | null {
    return this.latestLoadReport
      ? {
          ...this.latestLoadReport,
          countsByKind: { ...this.latestLoadReport.countsByKind },
        }
      : null;
  }

  async readEntries(): Promise<BrokerJournalEntry[]> {
    const entries: BrokerJournalEntry[] = [];
    const boundary = await this.captureReplayBoundary();
    await this.visitEntries((entry) => { entries.push(entry); }, boundary);
    return entries;
  }

  captureReplayBoundary(options: {
    barrier?: BrokerJournalReplayBarrier;
  } = {}): Promise<BrokerJournalReplayBoundary> {
    let boundary: BrokerJournalReplayBoundary = { endByteExclusive: 0 };
    const capture = this.writeQueue.then(async () => {
      await this.repairFailedAppend();
      if (options.barrier) {
        await mkdir(dirname(this.filePath), { recursive: true });
        const entry: BrokerJournalEntry = {
          kind: "journal.replay_barrier",
          barrier: options.barrier,
        };
        await this.appendLines(`${JSON.stringify(entry)}\n`);
        // Deliberately a no-op for domain state, but keeping all journal state
        // transitions on this path prevents future entry kinds from silently
        // diverging between capture and ordinary append.
        this.apply(entry);
      }
      const source = await stat(this.filePath).catch((error) => {
            const code = error && typeof error === "object" && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            if (code === "ENOENT") return null;
            throw error;
          });
      boundary = {
        endByteExclusive: source?.size ?? 0,
        ...(source ? { fileIdentity: `${source.dev}:${source.ino}` } : {}),
        ...(options.barrier ? { barrier: options.barrier } : {}),
      };
    });
    this.writeQueue = capture.then(() => undefined, () => undefined);
    return capture.then(() => boundary);
  }

  async replay(
    visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
    boundary?: BrokerJournalReplayBoundary,
    options: BrokerJournalReplayOptions = {},
  ): Promise<BrokerJournalReplayReport> {
    boundary ??= await this.captureReplayBoundary();
    let afterBarrierFound = options.afterBarrier === undefined;
    let visitedEntries = 0;
    await this.visitEntries(
      async (entry) => {
        if (!afterBarrierFound) {
          if (
            entry.kind === "journal.replay_barrier"
            && sameReplayBarrier(entry.barrier, options.afterBarrier!)
          ) {
            afterBarrierFound = true;
          }
          return;
        }
        // Replay barriers carry no domain state. They exist solely to locate a
        // crash-safe resume point and must never leak into projection reducers.
        if (entry.kind === "journal.replay_barrier") {
          return;
        }
        await visitor(entry);
        visitedEntries += 1;
      },
      { ...boundary, startByteInclusive: options.startByteInclusive },
    );
    return { afterBarrierFound, visitedEntries };
  }

  snapshot(): RuntimeRegistrySnapshot {
    return cloneSnapshot(this.state.snapshot);
  }

  verificationRecords(plan: HistoryRotationPlan): BrokerJournalVerificationRecords {
    const snapshot = this.state.snapshot;
    const flights = [...plan.flightIds].flatMap(id => snapshot.flights[id] ? [snapshot.flights[id]!] : []);
    const invocationIds = new Set([...plan.invocationIds, ...flights.map(flight => flight.invocationId)]);
    const attempts: DeliveryAttempt[] = [];
    for (const group of this.state.deliveryAttempts.values()) {
      for (const attempt of group) if (plan.deliveryAttemptIds.has(attempt.id)) attempts.push(attempt);
    }
    return {
      // Disk history owns these records when enabled; verification must not
      // materialize that historical map into the broker's working set.
      messages: this.messageHistory ? [] : [...plan.messageIds].flatMap(id => snapshot.messages[id] ? [snapshot.messages[id]!] : []),
      invocations: [...invocationIds].flatMap(id => snapshot.invocations[id] ? [snapshot.invocations[id]!] : []),
      flights,
      deliveries: [...plan.deliveryIds].flatMap(id => this.state.deliveries.has(id) ? [this.state.deliveries.get(id)!] : []),
      deliveryAttempts: attempts,
      collaborationEvents: this.state.collaborationEvents.filter(event => plan.collaborationEventIds.has(event.id)),
    };
  }

  /**
   * Actor ids retired by `actor.delete` tombstones — including tombstones
   * that survived compaction — used to seed the runtime's stale-roster fence
   * at hydration. Live view; callers must not mutate.
   */
  retiredActorIds(): ReadonlySet<string> {
    return this.state.retiredActorIds;
  }

  async appendEntries(entriesInput: BrokerJournalEntry | BrokerJournalEntry[]): Promise<BrokerJournalEntry[]> {
    const entries = Array.isArray(entriesInput) ? entriesInput : [entriesInput];
    if (entries.length === 0) {
      return [];
    }

    const retained = this.selectEntriesToAppend(entries);
    let prepared = retained;
    let acceptedEncodedBytes = 0;
    let preparationError: BrokerMessageBodyCacheUnavailable | undefined;
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      if (retained.length === 0) {
        return;
      }
      // Spill must succeed before accepting the canonical append. Tentative
      // cache bytes are disposable; a failed append never publishes records.
      try {
        prepared = retained.map((entry) => this.prepareEntry(entry));
      } catch (error) {
        if (!(error instanceof BrokerMessageBodyCacheUnavailable)) throw error;
        // Reject this new payload without poisoning the canonical write queue:
        // acknowledgements/leases/completions do not need fresh body spill space.
        preparationError = error;
        return;
      }
      const payload = encodeJournalEntries(retained);
      if (this.memoryMaintenance) acceptedEncodedBytes = Buffer.byteLength(payload, "utf8");
      await this.appendLines(payload);
      for (const entry of prepared) {
        this.apply(entry);
      }
      // Registration/control records do not change message membership. During
      // progressive startup they must not trigger the initial history scan.
      if (!this.progressiveStartup || prepared.some(entry => entry.kind === "message.record")) {
        await this.messageHistory?.accepted();
      }
    });
    // This caller sees the failure; the queue must not, or one failed append
    // rejects every write after it until the broker restarts.
    this.writeQueue = write.then(() => undefined, () => undefined);

    await write;
    if (preparationError) throw preparationError;
    this.memoryMaintenance?.accepted(prepared, acceptedEncodedBytes);
    return prepared;
  }

  listCollaborationRecords(options: {
    conversationId?: string;
    includeThreads?: boolean;
    orderByCreatedAt?: boolean;
    afterCreatedAt?: number;
    afterId?: string;
    limit?: number;
    kind?: CollaborationRecord["kind"];
    state?: string;
    ownerId?: string;
    nextMoveOwnerId?: string;
  } = {}): CollaborationRecord[] {
    const limit = options.limit ?? 200;
    return Object.values(this.state.snapshot.collaborationRecords)
      .filter(record => !options.conversationId || record.conversationId === options.conversationId
        || Boolean(options.includeThreads && record.conversationId && this.state.snapshot.conversations[record.conversationId]?.kind === "thread"
          && this.state.snapshot.conversations[record.conversationId]?.parentConversationId === options.conversationId))
      .filter(record => options.afterCreatedAt == null || record.createdAt > options.afterCreatedAt
        || (record.createdAt === options.afterCreatedAt && record.id > (options.afterId ?? "")))
      .filter((record) => !options.kind || record.kind === options.kind)
      .filter((record) => !options.state || record.state === options.state)
      .filter((record) => !options.ownerId || record.ownerId === options.ownerId)
      .filter((record) => !options.nextMoveOwnerId || record.nextMoveOwnerId === options.nextMoveOwnerId)
      .sort((left, right) => options.orderByCreatedAt
        ? left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        : right.updatedAt - left.updatedAt)
      .slice(0, limit);
  }

  listCollaborationEvents(options: { limit?: number; recordId?: string } = {}): CollaborationEvent[] {
    const limit = options.limit ?? 200;
    return [...this.state.collaborationEvents]
      .filter((event) => !options.recordId || event.recordId === options.recordId)
      .sort((left, right) => right.at - left.at)
      .slice(0, limit);
  }

  getDelivery(deliveryId: string): DeliveryIntent | undefined {
    return this.state.deliveries.get(deliveryId);
  }

  /** Complete insertion-order search without allocating a historical list. */
  findDelivery(predicate: (delivery: DeliveryIntent) => boolean, options: { activeOnly?: boolean } = {}): DeliveryIntent | undefined {
    for (const delivery of this.deliveryValues(options.activeOnly)) {
      if (predicate(delivery)) return delivery;
    }
    return undefined;
  }

  /**
   * Visit every delivery present at entry without allocating a history array.
   * Entries are never deleted/reinserted in this map; replacements retain their
   * insertion position. Later appends are outside this traversal's boundary.
   */
  async visitDeliveries(visitor: (delivery: DeliveryIntent) => void | Promise<void>, options: { activeOnly?: boolean } = {}): Promise<void> {
    const boundary = this.state.deliveries.size;
    const iterator = this.state.deliveries.values();
    for (let visited = 0; visited < boundary; visited++) {
      const next = iterator.next();
      if (next.done) return;
      // Count original map positions, including filtered terminal records.
      // Otherwise a sparse active scan can drift into later appended entries.
      if (!options.activeOnly || !["acknowledged", "completed", "failed", "cancelled"].includes(next.value.status)) {
        await visitor(next.value);
      }
      if ((visited + 1) % 128 === 0) await yieldReadTurn();
    }
  }

  listDeliveries(options: {
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    targetId?: string;
    invocationId?: string;
    statuses?: DeliveryIntent["status"][];
    reasons?: DeliveryIntent["reason"][];
    limit?: number;
  } = {}): DeliveryIntent[] {
    const limit = options.limit ?? 200;
    // Preserve Array.slice's public limit semantics, including negative limits.
    // Ordinary bounded reads must not allocate arrays for the entire history.
    const end = Number.isNaN(limit) ? 0 : Math.trunc(limit);
    if (end === 0 || end === -Infinity) return [];
    const deliveries: DeliveryIntent[] = [];
    for (const delivery of this.deliveryValues()) {
      if (options.invocationId !== undefined && delivery.invocationId !== options.invocationId) continue;
      if (options.transport && delivery.transport !== options.transport) continue;
      if (options.status && delivery.status !== options.status) continue;
      if (options.targetId !== undefined && delivery.targetId !== options.targetId) continue;
      if (options.statuses && !options.statuses.includes(delivery.status)) continue;
      if (options.reasons && !options.reasons.includes(delivery.reason)) continue;
      deliveries.push(delivery);
      if (end > 0 && deliveries.length >= end) break;
    }
    return end < 0 ? deliveries.slice(0, end) : deliveries;
  }

  listDeliveryAttempts(deliveryId: string): DeliveryAttempt[] {
    return [...(this.state.deliveryAttempts.get(deliveryId) ?? [])]
      .sort((left, right) => (
        left.attempt === right.attempt
          ? left.createdAt - right.createdAt
          : left.attempt - right.attempt
      ));
  }

  /** Every journaled delivery attempt by id — the verifier's expected records. */
  deliveryAttemptsById(): Map<string, DeliveryAttempt> {
    const found = new Map<string, DeliveryAttempt>();
    for (const attempts of this.state.deliveryAttempts.values()) {
      for (const attempt of attempts) {
        found.set(attempt.id, attempt);
      }
    }
    return found;
  }

  /** Every journaled collaboration event by id — the verifier's expected records. */
  collaborationEventsById(): Map<string, CollaborationEvent> {
    const found = new Map<string, CollaborationEvent>();
    for (const event of this.state.collaborationEvents) {
      found.set(event.id, event);
    }
    return found;
  }

  getDurableAction(actionId: string): DurableAction | null {
    return this.state.durableActions.get(actionId) ?? null;
  }

  getDurableActionByIdempotencyKey(input: {
    authorityCellId: string;
    kind: DurableAction["kind"];
    idempotencyKey: string;
  }): DurableAction | null {
    for (const action of this.state.durableActions.values()) {
      if (
        action.authorityCellId === input.authorityCellId
        && action.kind === input.kind
        && action.idempotencyKey === input.idempotencyKey
      ) {
        return action;
      }
    }
    return null;
  }

  getInvocationDispatchJob(jobId: string): BrokerInvocationDispatchJob | null {
    return this.state.invocationDispatchJobs.get(jobId)
      ?? this.dispatchJobHistory?.read<BrokerInvocationDispatchJob>("dispatch_job", jobId) ?? null;
  }

  getInvocationDispatchJobForInvocation(invocationId: string): BrokerInvocationDispatchJob | null {
    const deterministic = this.getInvocationDispatchJob(invocationDispatchJobId(invocationId));
    if (deterministic?.invocationId === invocationId) return deterministic;
    for (const id of this.dispatchJobIdsByInvocation.get(invocationId) ?? []) {
      const job = this.state.invocationDispatchJobs.get(id);
      if (job) return job;
    }
    const historical = this.dispatchJobHistory?.page({ kind: "dispatch_job", invocationId, limit: 1 })[0];
    return historical ? this.dispatchJobHistory!.readLocation<BrokerInvocationDispatchJob>(historical) : null;
  }

  pendingTerminalReports(): IterableIterator<FlightRecord> {
    return this.pendingTerminalReportFlights.values();
  }

  getCollaborationRecord(recordId: string): CollaborationRecord | undefined {
    return this.state.snapshot.collaborationRecords[recordId];
  }

  getCurrentFlightForInvocation(invocationId: string): FlightRecord | undefined {
    const id = this.currentFlightIds.get(invocationId);
    return id ? this.state.snapshot.flights[id] : undefined;
  }

  getInvocation(invocationId: string): InvocationRequest | undefined {
    return this.state.snapshot.invocations[invocationId];
  }

  getFlight(flightId: string): FlightRecord | undefined {
    return this.state.snapshot.flights[flightId];
  }

  /** Fair bounded pages; completed history and repeated failures cannot starve pending work. */
  listPendingWorkPromotionFlights(limit = 256): FlightRecord[] {
    const page: FlightRecord[] = [];
    const count = Math.min(this.pendingWorkPromotionFlights.size, Math.max(0, Math.min(256, Math.floor(limit))));
    for (let index = 0; index < count; index++) {
      const next = this.pendingWorkPromotionFlights.entries().next().value;
      if (!next) break;
      const [id, flight] = next;
      page.push(flight);
      this.pendingWorkPromotionFlights.delete(id);
      this.pendingWorkPromotionFlights.set(id, flight);
    }
    return page;
  }

  pendingInvocationResultFlights(): IterableIterator<FlightRecord> {
    return this.pendingResultFlights.values();
  }

  /** Bounded, fair observation recovery, independent of completed peer history. */
  listPendingPeerMirrorDeliveries(options: { limit?: number } = {}): DeliveryIntent[] {
    const limit = Math.max(0, Math.min(5000, Math.floor(options.limit ?? 500)));
    const count = Math.min(limit, this.pendingPeerMirrors.size);
    const iterator = this.pendingPeerMirrors.values();
    const deliveries: DeliveryIntent[] = [];
    for (let index = 0; index < count; index++) {
      const delivery = iterator.next().value;
      if (!delivery) break;
      deliveries.push(delivery);
      this.pendingPeerMirrors.delete(delivery.id);
      this.pendingPeerMirrors.set(delivery.id, delivery);
    }
    return deliveries;
  }

  /** Rotate leased/backed-off candidates too, so they cannot hide later work. */
  listPendingPeerForwardDeliveries(options: { limit?: number } = {}): DeliveryIntent[] {
    const count = Math.min(Math.max(0, Math.min(5000, Math.floor(options.limit ?? 500))), this.pendingPeerForwards.size);
    const iterator = this.pendingPeerForwards.values();
    const deliveries: DeliveryIntent[] = [];
    for (let index = 0; index < count; index++) {
      const delivery = iterator.next().value;
      if (!delivery) break;
      deliveries.push(delivery);
      this.pendingPeerForwards.delete(delivery.id);
      this.pendingPeerForwards.set(delivery.id, delivery);
    }
    return deliveries;
  }

  private indexPeerMirrorDelivery(delivery: DeliveryIntent, previous?: DeliveryIntent): void {
    if (delivery.transport === "peer_broker" && (delivery.status === "accepted" || delivery.status === "deferred")) {
      this.pendingPeerForwards.set(delivery.id, delivery);
    } else this.pendingPeerForwards.delete(delivery.id);
    const previousFlightId = previous?.metadata?.peerFlightId;
    const flightId = delivery.metadata?.peerFlightId;
    if (typeof previousFlightId === "string" && previousFlightId !== flightId) {
      const ids = this.peerMirrorDeliveryIdsByFlight.get(previousFlightId);
      ids?.delete(delivery.id);
      if (!ids?.size) this.peerMirrorDeliveryIdsByFlight.delete(previousFlightId);
    }
    const flight = typeof flightId === "string" ? this.state.snapshot.flights[flightId] : undefined;
    const invocation = delivery.invocationId ? this.state.snapshot.invocations[delivery.invocationId] : undefined;
    const terminal = flight && flight.invocationId === delivery.invocationId
      && flight.targetAgentId === delivery.targetId
      && (!invocation || flight.requesterId === invocation.requesterId)
      && (flight.state === "completed" || flight.state === "failed" || flight.state === "cancelled");
    const pendingAcknowledgement = delivery.metadata?.peerAcknowledgement;
    const submission = delivery.metadata?.peerSubmission as { version?: number; status?: string } | undefined;
    const uncertainSubmission = delivery.status === "sent" && submission?.version === 1 && submission.status === "unknown";
    if (delivery.transport === "peer_broker" && delivery.invocationId
      && ((delivery.status === "peer_acked" && (!terminal || pendingAcknowledgement)) || (uncertainSubmission && !terminal))) {
      this.pendingPeerMirrors.set(delivery.id, delivery);
      if (typeof flightId === "string") {
        const ids = this.peerMirrorDeliveryIdsByFlight.get(flightId) ?? new Set<string>();
        ids.add(delivery.id);
        this.peerMirrorDeliveryIdsByFlight.set(flightId, ids);
      }
    } else {
      this.pendingPeerMirrors.delete(delivery.id);
      if (typeof flightId === "string") {
        const ids = this.peerMirrorDeliveryIdsByFlight.get(flightId);
        ids?.delete(delivery.id);
        if (!ids?.size) this.peerMirrorDeliveryIdsByFlight.delete(flightId);
      }
    }
  }

  private updatePeerMirrorsForFlight(flightId: string): void {
    for (const id of this.peerMirrorDeliveryIdsByFlight.get(flightId) ?? []) {
      const delivery = this.state.deliveries.get(id);
      if (delivery) this.indexPeerMirrorDelivery(delivery);
    }
  }

  /**
   * Scheduler working set, independent of lifetime completed-job history.
   * Rotate visited entries so an unclaimable prefix cannot starve later work.
   * The recovery service still checks lease/deferral evidence before dispatch.
   */
  listRecoverableInvocationDispatchJobs(options: { limit?: number } = {}): BrokerInvocationDispatchJob[] {
    const limit = Math.max(0, Math.min(5000, Math.floor(options.limit ?? 1000)));
    const count = Math.min(limit, this.recoverableDispatchJobs.size);
    const iterator = this.recoverableDispatchJobs.values();
    const jobs: BrokerInvocationDispatchJob[] = [];
    for (let index = 0; index < count; index++) {
      const job = iterator.next().value;
      if (!job) break;
      jobs.push(job);
      this.recoverableDispatchJobs.delete(job.id);
      this.recoverableDispatchJobs.set(job.id, job);
    }
    return jobs;
  }

  /** Bounded round-robin candidates. Publication happens outside the write queue. */
  captureArchivableInvocationDispatchJobs(options: { cutoff: number; limit?: number; maxBytes?: number }): BrokerInvocationDispatchJob[] {
    const limit = Math.max(0, Math.min(1000, Math.floor(options.limit ?? 250)));
    const maxBytes = Math.max(0, Math.min(1024 * 1024, options.maxBytes ?? 512 * 1024));
    const count = Math.min(limit, this.archivableDispatchJobs.size);
    const iterator = this.archivableDispatchJobs.values();
    const records: BrokerInvocationDispatchJob[] = [];
    let bytes = 0;
    for (let index = 0; index < count; index++) {
      const job = iterator.next().value;
      if (!job) break;
      this.archivableDispatchJobs.delete(job.id); this.archivableDispatchJobs.set(job.id, job);
      if ((job.completedAt ?? job.updatedAt) >= options.cutoff) continue;
      const json = JSON.stringify(job);
      const size = Buffer.byteLength(json);
      if (bytes + size > maxBytes) continue;
      bytes += size; records.push(JSON.parse(json) as BrokerInvocationDispatchJob);
    }
    return records;
  }

  /** Call inside the broker write boundary immediately before the rotation marker. */
  revalidateArchivedInvocationDispatchJobs(jobs: readonly BrokerInvocationDispatchJob[], cutoff: number): string[] {
    return jobs.filter(job => {
      const current = this.archivableDispatchJobs.get(job.id);
      return current && (current.completedAt ?? current.updatedAt) < cutoff && sameValue(current, job);
    }).map(job => job.id);
  }

  dispatchJobHistoricalRecords(jobs: readonly BrokerInvocationDispatchJob[]): HistoricalRecord[] {
    return jobs.map(job => ({ kind: "dispatch_job", id: job.id, record: job,
      // Jobs belong to an invocation; this indexed grouping keeps legacy IDs discoverable.
      invocationId: job.invocationId, timestamp: job.createdAt }));
  }

  private removeDispatchJob(jobId: string): void {
    const job = this.state.invocationDispatchJobs.get(jobId);
    if (!job) return;
    for (const [index, key] of [[this.dispatchJobIdsByInvocation, job.invocationId], [this.dispatchJobIdsByFlight, job.flightId]] as const) {
      const ids = index.get(key); ids?.delete(jobId); if (!ids?.size) index.delete(key);
    }
    this.state.invocationDispatchJobs.delete(jobId);
    this.recoverableDispatchJobs.delete(jobId); this.archivableDispatchJobs.delete(jobId);
  }

  private indexDispatchJob(job: BrokerInvocationDispatchJob): void {
    const previous = this.state.invocationDispatchJobs.get(job.id);
    const update = (index: Map<string, Set<string>>, key: string, previousKey: string | undefined) => {
      if (previousKey && previousKey !== key) {
        const old = index.get(previousKey);
        old?.delete(job.id);
        if (old?.size === 0) index.delete(previousKey);
      }
      const ids = index.get(key) ?? new Set<string>();
      ids.add(job.id);
      index.set(key, ids);
    };
    update(this.dispatchJobIdsByInvocation, job.invocationId, previous?.invocationId);
    update(this.dispatchJobIdsByFlight, job.flightId, previous?.flightId);
    this.state.invocationDispatchJobs.set(job.id, job);
    this.updateRecoverableDispatchJob(job);
  }

  private updateRecoverableDispatchJob(job: BrokerInvocationDispatchJob): void {
    const flight = this.state.snapshot.flights[job.flightId];
    const terminal = flight && (flight.state === "completed" || flight.state === "failed" || flight.state === "cancelled");
    const active = !terminal && (job.state === "pending" || job.state === "running"
      || (job.state === "completed" && (flight?.state === "queued" || flight?.state === "waking")));
    if (active) this.recoverableDispatchJobs.set(job.id, job);
    else this.recoverableDispatchJobs.delete(job.id);
    const reply = flight?.metadata?.resultReply;
    const pendingReply = Boolean(reply && typeof reply === "object" && (reply as { status?: unknown }).status === "pending");
    const pendingReport = (flight?.metadata?.terminalReport as { status?: unknown } | undefined)?.status === "pending";
    const finalized = job.state === "completed" || job.state === "failed" || job.state === "cancelled";
    if (finalized && (!flight || terminal) && !pendingReply && !pendingReport) this.archivableDispatchJobs.set(job.id, job);
    else this.archivableDispatchJobs.delete(job.id);
  }

  private updateDispatchJobsForFlight(flightId: string): void {
    for (const jobId of this.dispatchJobIdsByFlight.get(flightId) ?? []) {
      const job = this.state.invocationDispatchJobs.get(jobId);
      if (job) this.updateRecoverableDispatchJob(job);
    }
  }

  listInvocationDispatchJobs(options: {
    limit?: number;
    state?: BrokerInvocationDispatchJob["state"];
  } = {}): BrokerInvocationDispatchJob[] {
    const limit = options.limit ?? 1000;
    return [...this.state.invocationDispatchJobs.values()]
      .filter((job) => !options.state || job.state === options.state)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit);
  }

  private async visitEntries(
    visitor: (
      entry: BrokerJournalEntry,
      index: number,
      encodedLineBytes: number,
      physicalEndByte: number,
    ) => void | Promise<void>,
    options: { endByteExclusive?: number; startByteInclusive?: number; fileIdentity?: string } = {},
  ): Promise<JournalVisitReport> {
    const endByteExclusive = options.endByteExclusive;
    if (endByteExclusive !== undefined && endByteExclusive <= 0) {
      return {
        rawLines: 0,
        validEntries: 0,
        invalidLines: 0,
        blankLines: 0,
      };
    }
    const maintenance = this.memoryMaintenance?.beginReplay();
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let index = 0;
    const report: JournalVisitReport = {
      rawLines: 0,
      validEntries: 0,
      invalidLines: 0,
      blankLines: 0,
    };
    try {
      const start = options.startByteInclusive ?? 0;
      if (!Number.isSafeInteger(start) || start < 0 || (start > 0 && !options.fileIdentity)) throw new Error("invalid_journal_tail_cursor");
      file = await open(this.filePath, "r");
      const source = await file.stat();
      if ((options.fileIdentity && `${source.dev}:${source.ino}` !== options.fileIdentity)
        || (endByteExclusive !== undefined && source.size < endByteExclusive)) throw new Error("journal_replay_boundary_changed");
      if (endByteExclusive !== undefined && start >= endByteExclusive) return report;
      const end = endByteExclusive ?? source.size;
      let physicalEndByte = start;
      async function* chunks() {
        let position = start;
        while (position < end) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
          const { bytesRead } = await file!.read(chunk, 0, chunk.length, position);
          if (bytesRead === 0) throw new Error("journal_replay_truncated");
          position += bytesRead;
          yield chunk.subarray(0, bytesRead);
        }
      }
      for await (const { raw, bytes: encodedLineBytes } of journalLines(chunks())) {
        physicalEndByte += encodedLineBytes;
        const rawLine = raw.toString("utf8");
        report.rawLines += 1;
        // Broker journal appends always use one-byte LF terminators. Reuse the
        // bytes already read instead of serializing every parsed entry again on
        // the startup scan's hot path.
        if (!rawLine.trim()) {
          report.blankLines += 1;
          maintenance?.add(encodedLineBytes);
          continue;
        }
        let entries: BrokerJournalEntry[];
        const preserve = (reason: string, entries?: BrokerJournalEntry[]) => {
          // Copy exact physical bytes before a replay skip or compaction can
          // remove the unusable source. A failed copy aborts this boundary.
          const bytes = encodedLineBytes > raw.length ? Buffer.concat([raw, Buffer.from("\n")]) : raw;
          const evidence = this.quarantine.preserve({ kind: entries ? "journal.semantic_frame" : "journal.invalid_frame", reason, bytes,
            source: { path: this.filePath, startByte: physicalEndByte - encodedLineBytes,
              endByte: physicalEndByte, fileIdentity: `${source.dev}:${source.ino}` }, entries });
          if (evidence.status === "open" && this.warnedQuarantine.size < 8 && !this.warnedQuarantine.has(evidence.id)) {
            this.warnedQuarantine.add(evidence.id);
            console.warn(`[broker] quarantined journal record ${evidence.id}: ${evidence.reason}`);
          }
        };
        try {
          if (!isUtf8(raw)) throw new Error("invalid_journal_utf8");
          entries = decodeJournalLine(rawLine);
        } catch (error) {
          if (error instanceof JournalFrameLimitError || error instanceof UnsupportedJournalFrameError) throw error;
          preserve(error instanceof Error ? error.message : String(error));
          report.invalidLines += 1;
          maintenance?.add(encodedLineBytes);
          continue;
        }
        const problems = entries.map(journalEntryProblem);
        const problem = problems.find(problem => problem?.structural) ?? problems.find(problem => problem !== null);
        if (problem) {
          // Keep the entire physical transaction indivisible. In particular,
          // never expose its invocation/job when its accepted message is bad.
          if (problem.structural) throw new UnsupportedJournalFrameError(problem.reason);
          preserve(`${problem.reason}; its whole physical frame is isolated.`, entries);
          report.invalidLines += 1;
          maintenance?.add(encodedLineBytes);
          continue;
        }
        // Logical counters/checkpoints keep their old meaning. Apportion frame
        // overhead for compaction estimates without charging its bytes N times.
        const perEntryBytes = Math.floor(encodedLineBytes / entries.length);
        for (let ordinal = 0; ordinal < entries.length; ordinal++) {
          await visitor(entries[ordinal]!, index, perEntryBytes + (ordinal === 0 ? encodedLineBytes % entries.length : 0), physicalEndByte);
          index += 1;
          report.validEntries += 1;
        }
        maintenance?.add(encodedLineBytes);
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    } finally {
      await file?.close();
      maintenance?.finish();
    }
    return report;
  }

  private async compactStartupJournal(latestIndexByKey: Map<string, number>, prefixBytes?: number): Promise<void> {
    try {
      await this.rewriteCompactedEntries(latestIndexByKey, prefixBytes);
    } catch (error) {
      // Capacity failure while writing the disposable replacement cannot
      // invalidate the original journal we already replayed. Preserve it and
      // continue required history coverage; never swallow source/rollback errors.
      if (!(error instanceof JournalCompactionCapacityError)) throw error;
      this.startupCompactionDeferral = { code: error.code, operation: error.operation,
        error: error.message.slice(0, 512) };
      console.warn(`[openscout-runtime] optional journal compaction deferred (${error.code}, ${error.operation}); original journal retained`);
    }
  }

  private async rewriteCompactedEntries(latestIndexByKey: Map<string, number>, prefixBytes?: number, live?: {
    boundary: BrokerJournalReplayBoundary; rotations: AppliedHistoryRotation[]; dedupeFlights: boolean; checkBudget: () => void; cleanupThroughIndex: number;
  }): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    // Observe open/write failures through awaited operations. A WriteStream can
    // emit its error before replay reaches a drain/finish listener, leaving
    // startup waiting forever after ENOSPC (even once free space recovers).
    const output = await writeCompactionOutput("open", () => open(temporaryPath, "wx"));
    let outputClosed = false;
    let pendingLines: string[] = [];
    let pendingBytes = 0;
    const flushOutput = async () => {
      if (pendingLines.length === 0) return;
      await writeCompactionOutput("write", () => output.writeFile(pendingLines.join(""), "utf8"));
      pendingLines = [];
      pendingBytes = 0;
    };
    const lastFlightById = new Map<string, FlightRecord>();
    const compactedCurrentFlightIds = new Map<string, string>();
    // Every history.rotate marker applied during the scan kept its eviction
    // sets in `appliedRotations`. A record line is dropped when ANY rotation
    // after it doomed the record — the marker itself survives via the shared
    // "history.rotate" dedupe key, so only the newest one is written.
    const rotationIndex = latestIndexByKey.get("history.rotate");
    const remainingRotations = rotationIndex !== undefined ? [...(live?.rotations ?? this.appliedRotations)] : [];

    try {
      await this.visitEntries(async (entry, index) => {
        if (live) { live.checkBudget(); if (index % 128 === 0) await yieldReadTurn(); }
        if (entry.kind === "history.rotate") {
          remainingRotations.shift();
        }
        let writeEntry = entry;
        if (index < (rotationIndex ?? -1) && remainingRotations.length > 0) {
          switch (historyRotationDropsEntry(remainingRotations, entry)) {
            case "all":
              return;
            case "partial":
              if (entry.kind === "deliveries.record") {
                writeEntry = {
                  ...entry,
                  deliveries: entry.deliveries.filter(
                    (delivery) => !remainingRotations.some(
                      (rotation) => rotation.deliveryIds.has(delivery.id),
                    ),
                  ),
                };
              }
              break;
            case "none":
              break;
          }
        }

        if (entry.kind === "flight.record" && live?.dedupeFlights !== false) {
          const previous = lastFlightById.get(entry.flight.id);
          lastFlightById.set(entry.flight.id, entry.flight);
          const changesCurrent = !entry.preserveCurrent && compactedCurrentFlightIds.get(entry.flight.invocationId) !== entry.flight.id;
          if (!entry.preserveCurrent) compactedCurrentFlightIds.set(entry.flight.invocationId, entry.flight.id);
          if (previous && !changesCurrent && sameValue(previous, entry.flight)) {
            return;
          }
        } else {
          const key = dedupeKey(entry);
          const protectedReceipt = entry.kind === "history.rotate" && ((entry.publications?.length ?? 0) > 0 || (entry.evicted?.controlEventIds?.length ?? 0) > 0)
            && index > (live?.cleanupThroughIndex ?? -1);
          if (key && latestIndexByKey.get(key) !== index && !protectedReceipt) {
            return;
          }
          // A latest-entry delete is KEPT as a tombstone. SQLite recovery
          // replays a checkpoint suffix onto an existing database — it cannot
          // infer deletes from absence, so dropping the tombstone would leave
          // the deleted row (and its references) in the store permanently.
        }

        const line = `${JSON.stringify(writeEntry)}\n`;
        pendingLines.push(line);
        pendingBytes += Buffer.byteLength(line, "utf8");
        if (pendingBytes >= 64 * 1024) await flushOutput();
      }, live?.boundary ?? (prefixBytes === undefined ? {} : { endByteExclusive: prefixBytes }));
      await flushOutput();
      const publish = async () => {
        live?.checkBudget();
        // The saved rollback offset belongs to the current file. Repair before
        // copying its suffix or replacing it with a differently sized prefix.
        await this.repairFailedAppend();
        if (live?.boundary.fileIdentity) {
          const current = await stat(this.filePath);
          if (`${current.dev}:${current.ino}` !== live.boundary.fileIdentity) throw new Error("journal_compaction_source_changed");
        }
        if (prefixBytes !== undefined) {
          // The prefix rewrite runs cooperatively while control registrations
          // append. Capture/copy its accepted suffix under the canonical writer
          // before atomic rename; no accepted late record can be dropped.
          const end = (await stat(this.filePath)).size;
          if (end > prefixBytes) {
            const suffix = createReadStream(this.filePath, { start: prefixBytes, end: end - 1 });
            for await (const bytes of suffix) await writeCompactionOutput("write suffix", () => output.writeFile(bytes));
          }
        }
        await writeCompactionOutput("sync", () => output.sync());
        await writeCompactionOutput("close", () => output.close());
        outputClosed = true;
        live?.checkBudget();
        await writeCompactionOutput("rename", () => rename(temporaryPath, this.filePath));
        await this.syncDirectory();
        this.appendPrefix = "";
      };
      if (prefixBytes === undefined) await publish();
      else {
        const committed = this.writeQueue.then(publish);
        this.writeQueue = committed.catch(() => {});
        await committed;
      }
    } finally {
      if (!outputClosed) await output.close().catch(() => undefined);
      // After publish() the path no longer exists (it was renamed away); on any
      // failure the half-written temp must not survive to the next boot.
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private selectEntriesToAppend(entries: BrokerJournalEntry[]): BrokerJournalEntry[] {
    // Duplicate selection only mutates entity/flight maps. Copy each touched
    // map once; message-only batches must not clone all historical messages.
    const nextSnapshot = { ...this.state.snapshot };
    let nextCurrentFlightIds: Map<string, string> | undefined;
    const copied = new Set<keyof RuntimeRegistrySnapshot>();
    const copy = <K extends keyof RuntimeRegistrySnapshot>(key: K): void => {
      if (copied.has(key)) return;
      nextSnapshot[key] = { ...nextSnapshot[key] };
      copied.add(key);
    };
    const retained: BrokerJournalEntry[] = [];

    for (const entry of entries) {
      if (!this.shouldAppendEntry(entry, nextSnapshot, nextCurrentFlightIds ?? this.currentFlightIds)) {
        continue;
      }
      retained.push(entry);
      switch (entry.kind) {
        case "node.upsert": copy("nodes"); break;
        case "actor.upsert": copy("actors"); break;
        case "agent.upsert": copy("agents"); copy("actors"); break;
        case "agent.delete": copy("agents"); copy("endpoints"); break;
        case "actor.delete": copy("actors"); break;
        case "agent.endpoint.upsert":
        case "agent.endpoint.delete": copy("endpoints"); break;
        case "conversation.upsert": copy("conversations"); break;
        case "binding.upsert": copy("bindings"); break;
        case "flight.record":
          copy("flights");
          if (!entry.preserveCurrent) {
            nextCurrentFlightIds ??= new Map(this.currentFlightIds);
            nextCurrentFlightIds.set(entry.flight.invocationId, entry.flight.id);
          }
          break;
        case "history.rotate":
          // The rotation deletes from the maps it touches — copy them so the
          // dedupe check cannot evict live records from the real snapshot.
          if (!asyncMessageRecordView(nextSnapshot.messages)) copy("messages");
          copy("flights");
          copy("invocations");
          break;
      }
      this.applyToSnapshot(nextSnapshot, entry);
    }

    return retained;
  }

  private shouldAppendEntry(
    entry: BrokerJournalEntry,
    snapshot: RuntimeRegistrySnapshot,
    currentFlightIds: ReadonlyMap<string, string>,
  ): boolean {
    if (entry.kind === "flight.record") {
      return (!entry.preserveCurrent && currentFlightIds.get(entry.flight.invocationId) !== entry.flight.id)
        || !sameValue(snapshot.flights[entry.flight.id], entry.flight);
    }

    if (!isDedupableEntry(entry)) {
      return true;
    }

    switch (entry.kind) {
      case "node.upsert":
        return !sameValue(snapshot.nodes[entry.node.id], entry.node);
      case "actor.upsert":
        return !sameValue(snapshot.actors[entry.actor.id], entry.actor);
      case "agent.upsert":
        return !sameValue(snapshot.agents[entry.agent.id], entry.agent);
      case "agent.endpoint.upsert":
        return !sameValue(snapshot.endpoints[entry.endpoint.id], entry.endpoint);
      case "conversation.upsert":
        return !sameValue(snapshot.conversations[entry.conversation.id], entry.conversation);
      case "binding.upsert":
        return !sameValue(snapshot.bindings[entry.binding.id], entry.binding);
      case "history.rotate":
        // A newly completed dependency component may become eligible within
        // the same week. Explicit verified id sets are separate relocations.
        return (entry.evicted && Object.values(entry.evicted).some(ids => ids.length > 0))
          || this.appliedRotations.at(-1)?.cutoff !== entry.cutoff;
      default:
        return true;
    }
  }

  private applyToSnapshot(snapshot: RuntimeRegistrySnapshot, entry: BrokerJournalEntry): void {
    switch (entry.kind) {
      case "node.upsert":
        snapshot.nodes[entry.node.id] = entry.node;
        return;
      case "actor.upsert":
        snapshot.actors[entry.actor.id] = entry.actor;
        return;
      case "agent.upsert":
        snapshot.agents[entry.agent.id] = entry.agent;
        if (!snapshot.actors[entry.agent.id]) {
          snapshot.actors[entry.agent.id] = {
            id: entry.agent.id,
            kind: entry.agent.kind,
            createdAt: entry.agent.createdAt,
            displayName: entry.agent.displayName,
            handle: entry.agent.handle,
            labels: entry.agent.labels,
            metadata: entry.agent.metadata,
          };
        }
        return;
      case "agent.endpoint.upsert":
        snapshot.endpoints[entry.endpoint.id] = entry.endpoint;
        return;
      case "agent.endpoint.delete":
        delete snapshot.endpoints[entry.endpointId];
        return;
      case "agent.delete":
        delete snapshot.agents[entry.agentId];
        // Deleting an agent also deletes its endpoints. The caller journals an
        // agent.endpoint.delete per endpoint first; these deletes must be
        // idempotent when those entries already removed them.
        for (const endpoint of Object.values(snapshot.endpoints)) {
          if (endpoint.agentId === entry.agentId) {
            delete snapshot.endpoints[endpoint.id];
          }
        }
        return;
      case "actor.delete":
        delete snapshot.actors[entry.actorId];
        return;
      case "conversation.upsert":
        snapshot.conversations[entry.conversation.id] = entry.conversation;
        return;
      case "binding.upsert":
        snapshot.bindings[entry.binding.id] = entry.binding;
        return;
      case "flight.record":
        snapshot.flights[entry.flight.id] = entry.flight;
        return;
      case "history.rotate": {
        const evicted = entry.evicted
          ? historyRotationPlanFromMarker(entry.evicted)
          : planHistoryRotation(snapshot, entry.cutoff, this.historyRotationContext());
        applyHistoryRotationEviction(snapshot, evicted);
        return;
      }
      default:
        return;
    }
  }

  private apply(entry: BrokerJournalEntry): void {
    switch (entry.kind) {
      case "node.upsert":
        this.state.snapshot.nodes[entry.node.id] = entry.node;
        return;
      case "actor.upsert":
        // Re-registration revives the identity — clear the tombstone.
        this.state.retiredActorIds.delete(entry.actor.id);
        this.state.snapshot.actors[entry.actor.id] = entry.actor;
        return;
      case "agent.upsert":
        // An agent registration synthesizes its actor identity — revive it.
        this.state.retiredActorIds.delete(entry.agent.id);
        this.state.snapshot.agents[entry.agent.id] = entry.agent;
        if (!this.state.snapshot.actors[entry.agent.id]) {
          this.state.snapshot.actors[entry.agent.id] = {
            id: entry.agent.id,
            kind: entry.agent.kind,
            createdAt: entry.agent.createdAt,
            displayName: entry.agent.displayName,
            handle: entry.agent.handle,
            labels: entry.agent.labels,
            metadata: entry.agent.metadata,
          };
        }
        return;
      case "agent.endpoint.upsert":
        this.state.snapshot.endpoints[entry.endpoint.id] = entry.endpoint;
        return;
      case "agent.endpoint.delete":
        delete this.state.snapshot.endpoints[entry.endpointId];
        return;
      case "agent.delete":
        delete this.state.snapshot.agents[entry.agentId];
        // Deleting an agent also deletes its endpoints; idempotent when the
        // caller's agent.endpoint.delete entries already removed them.
        for (const endpoint of Object.values(this.state.snapshot.endpoints)) {
          if (endpoint.agentId === entry.agentId) {
            delete this.state.snapshot.endpoints[endpoint.id];
          }
        }
        return;
      case "actor.delete":
        // The tombstone is the fact: mark retired even when the row is
        // already absent (idempotent replay).
        this.state.retiredActorIds.add(entry.actorId);
        delete this.state.snapshot.actors[entry.actorId];
        return;
      case "conversation.upsert":
        this.state.snapshot.conversations[entry.conversation.id] = entry.conversation;
        return;
      case "binding.upsert":
        this.state.snapshot.bindings[entry.binding.id] = entry.binding;
        return;
      case "message.record":
        if(!this.messageHistory)this.state.snapshot.messages[entry.message.id] = entry.message;
        return;
      case "conversation.read_cursor.upsert":
        this.state.snapshot.readCursors[`${entry.cursor.conversationId}\u0000${entry.cursor.actorId}`] = entry.cursor;
        return;
      case "invocation.record":
        this.state.snapshot.invocations[entry.invocation.id] = entry.invocation;
        return;
      case "invocation.dispatch_job.record":
        this.indexDispatchJob(entry.job);
        return;
      case "flight.record":
        this.state.snapshot.flights[entry.flight.id] = entry.flight;
        if (!entry.preserveCurrent) this.currentFlightIds.set(entry.flight.invocationId, entry.flight.id);
        this.updateDispatchJobsForFlight(entry.flight.id);
        this.updatePeerMirrorsForFlight(entry.flight.id);
        if ((entry.flight.metadata?.terminalReport as { status?: unknown } | undefined)?.status === "pending") {
          this.pendingTerminalReportFlights.set(entry.flight.id, entry.flight);
        } else {
          this.pendingTerminalReportFlights.delete(entry.flight.id);
        }
        if ((entry.flight.metadata?.workPromotion as { status?: unknown } | undefined)?.status === "pending") {
          this.pendingWorkPromotionFlights.set(entry.flight.id, entry.flight);
        } else {
          this.pendingWorkPromotionFlights.delete(entry.flight.id);
        }
        if ((entry.flight.metadata?.resultReply as { status?: unknown } | undefined)?.status === "pending") {
          this.pendingResultFlights.set(entry.flight.invocationId, entry.flight);
        } else {
          this.pendingResultFlights.delete(entry.flight.invocationId);
        }
        return;
      case "collaboration.record":
        this.state.snapshot.collaborationRecords[entry.record.id] = entry.record;
        return;
      case "collaboration.event.record":
        this.state.collaborationEvents.push(entry.event);
        return;
      case "deliveries.record":
        for (const delivery of entry.deliveries) {
          this.indexPeerMirrorDelivery(delivery, this.state.deliveries.get(delivery.id));
          this.state.deliveries.set(delivery.id, delivery);
        }
        return;
      case "delivery.attempt.record": {
        const attempts = this.state.deliveryAttempts.get(entry.attempt.deliveryId) ?? [];
        attempts.push(entry.attempt);
        this.state.deliveryAttempts.set(entry.attempt.deliveryId, attempts);
        return;
      }
      case "delivery.status.update": {
        const current = this.state.deliveries.get(entry.deliveryId);
        if (!current) {
          return;
        }

        const next = {
          ...current,
          status: entry.status,
          leaseOwner: entry.leaseOwner ?? undefined,
          leaseExpiresAt: entry.leaseExpiresAt ?? undefined,
          metadata: mergeMetadata(current.metadata, entry.metadata),
        };
        this.indexPeerMirrorDelivery(next, current);
        this.state.deliveries.set(entry.deliveryId, next);
        return;
      }
      case "durable.action.record":
        this.state.durableActions.set(entry.action.id, entry.action);
        return;
      case "durable.action.heartbeat": {
        const current = this.state.durableActions.get(entry.input.actionId);
        if (
          current
          && current.leaseOwner === entry.input.owner
          && current.leaseGeneration === entry.input.generation
          && current.state !== "completed"
          && current.state !== "failed"
          && current.state !== "cancelled"
        ) {
          this.state.durableActions.set(current.id, {
            ...current,
            leaseExpiresAt: entry.input.heartbeatAt + entry.input.leaseMs,
            updatedAt: entry.input.heartbeatAt,
          });
        }
        return;
      }
      case "durable.attempt.record":
      case "durable.checkpoint.record":
      case "durable.signal.record":
        // Durable action facts are intentionally not projected into the
        // in-memory RuntimeRegistrySnapshot. They are journal-durable and
        // replay into SQLite through RecoverableSQLiteProjection.
        return;
      case "control.event.record":
        return;
      case "journal.replay_barrier":
        // Opaque recovery metadata only. It intentionally has no domain-state
        // representation in the in-memory broker snapshot.
        return;
      case "scout.dispatch.record":
        this.state.scoutDispatches.push(entry.dispatch);
        return;
      case "history.rotate":
        this.applyHistoryRotation(entry);
        return;
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  }

  /**
   * The dependency-closure context history rotation needs: this journal's
   * delivery intents and invocation dispatch jobs (both live outside the
   * rotated snapshot) plus a presence probe for disk-backed message history.
   * The daemon passes the same context to the runtime mirror so both sides
   * evict identical records.
   */
  historyRotationContext(): HistoryRotationContext {
    return {
      deliveries: this.state.deliveries.values(),
      dispatchJobs: this.state.invocationDispatchJobs.values(),
      collaborationEvents: this.state.collaborationEvents,
      deliveryAttempts: [...this.state.deliveryAttempts.values()].flat(),
      // Under the disk-backed async history the records map is a proxy that
      // cannot answer `in`; assume present so referent-absent never evicts
      // a delivery whose message is safely on disk.
      messageIdPresent: asyncMessageRecordView(this.state.snapshot.messages)
        ? () => true
        : undefined,
    };
  }

  /**
   * Apply a `history.rotate` marker to the hot state. Modern markers carry
   * the id sets the writer verified against durable SQLite — apply removes
   * exactly those records and records them on `appliedRotations` so
   * compaction drops exactly the same journal lines; eligibility is never
   * recomputed. Markers written before the `evicted` sets existed fall back
   * to recomputing the closure rules. Registry, conversation, and binding
   * records are untouched — that is the retention sweep's job.
   */
  private applyHistoryRotation(
    entry: Extract<BrokerJournalEntry, { kind: "history.rotate" }>,
  ): void {
    const evicted = entry.evicted
      ? historyRotationPlanFromMarker(entry.evicted)
      : planHistoryRotation(this.state.snapshot, entry.cutoff, this.historyRotationContext());
    applyHistoryRotationEviction(this.state.snapshot, evicted);
    for (const jobId of entry.evicted?.dispatchJobIds ?? []) this.removeDispatchJob(jobId);
    for (const flightId of evicted.flightIds) {
      this.updateDispatchJobsForFlight(flightId);
      this.pendingWorkPromotionFlights.delete(flightId);
    }
    for (const invocationId of evicted.invocationIds) this.currentFlightIds.delete(invocationId);

    for (const deliveryId of evicted.deliveryIds) {
      const flightId = this.state.deliveries.get(deliveryId)?.metadata?.peerFlightId;
      if (typeof flightId === "string") {
        const ids = this.peerMirrorDeliveryIdsByFlight.get(flightId);
        ids?.delete(deliveryId);
        if (!ids?.size) this.peerMirrorDeliveryIdsByFlight.delete(flightId);
      }
      this.pendingPeerMirrors.delete(deliveryId);
      this.pendingPeerForwards.delete(deliveryId);
      this.state.deliveries.delete(deliveryId);
    }
    for (const [deliveryId, attempts] of this.state.deliveryAttempts) {
      const kept = attempts.filter((attempt) => !evicted.deliveryAttemptIds.has(attempt.id));
      if (kept.length === 0) {
        this.state.deliveryAttempts.delete(deliveryId);
      } else if (kept.length !== attempts.length) {
        this.state.deliveryAttempts.set(deliveryId, kept);
      }
    }
    this.state.collaborationEvents = this.state.collaborationEvents.filter(
      (event) => !evicted.collaborationEventIds.has(event.id),
    );

    this.appliedRotations.push({ cutoff: entry.cutoff, ...evicted, dispatchJobIds: new Set(entry.evicted?.dispatchJobIds ?? []), controlEventIds: new Set(entry.evicted?.controlEventIds ?? []) });
  }

  /** Cutoff of the newest applied `history.rotate` marker, if any. */
  historyRotationCutoff(): number | null {
    return this.appliedRotations.at(-1)?.cutoff ?? null;
  }

  listScoutDispatches(options: { limit?: number; askedLabel?: string; invocationId?: string } = {}): ScoutDispatchRecord[] {
    const limit = options.limit ?? 200;
    return [...this.state.scoutDispatches]
      .filter(record => options.invocationId === undefined || record.invocationId === options.invocationId)
      .filter((record) => !options.askedLabel || record.askedLabel === options.askedLabel)
      .sort((left, right) => right.dispatchedAt - left.dispatchedAt)
      .slice(0, limit);
  }
}
