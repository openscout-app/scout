import { ProjectionSkipLedger } from './projection-skip-ledger.js';
import { BrokerQuarantine, QuarantinePersistenceError, type QuarantineListOptions, type QuarantineSummary } from "./broker-quarantine.js";
import type {
  ConversationProjectionCursor,
  ConversationProjectionEvent,
  ConversationProjectionSnapshot,
  ActorIdentity,
  AgentDefinition,
  ConversationDefinition,
  ControlEvent,
  MessageRecord,
  InvocationRequest,
  DeliveryIntent,
  NodeDefinition,
  ThreadEventEnvelope,
  ThreadSnapshot,
} from "@openscout/protocol";

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";

import {
  FileBackedBrokerJournal,
  type BrokerJournalEntry,
  type BrokerJournalVerificationRecords,
  type BrokerJournalReplayBarrier,
  type BrokerJournalReplayBoundary,
  type BrokerJournalReplayOptions,
  type BrokerJournalReplayReport,
} from "./broker-journal.js";
import { canonicalRecord, SQLiteControlPlaneStore, type ActivityItem, type CanonicalRecordContext, type PersistedRotationRecordKind } from "./sqlite-store.js";
import {
  ConversationProjectionStore,
  type ConversationProjectionEventPage,
} from "./conversation-projection-store.js";
import type { ObservedSessionProjectionUpdate } from "./observed-session-reducer.js";
import {
  ConversationFeedArtifactPublisher,
  NATIVE_READ_FEED_ARTIFACT_FILENAME,
} from "./conversation-feed-artifact.js";
import {
  ConversationThreadArtifactPublisher,
  NATIVE_READ_THREAD_ARTIFACT_DIRECTORY,
} from "./conversation-thread-artifact.js";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import type { BrokerPersistenceVerification, BrokerProjectionHealth } from "./broker-durable-store.js";
import { emptyHistoryRotationPlan, type HistoryRotationPlan } from "./history-rotation.js";
import { archiveEvents, type ArchiveEventsResult } from "./control-plane-archive.js";
import { ControlPlaneHistoryReader, ControlPlaneHistoryStore, type HistoricalRecord, type HistoricalPublication, type HistoricalRecordLocation } from "./control-plane-history-store.js";
import { projectionVerificationDigest, verificationPlanKeys, type ProjectionVerificationDigest } from "./sqlite-projection-verification.js";

type ActivityQuery = Parameters<SQLiteControlPlaneStore["listActivityItems"]>[0];

export type RecoverableSQLiteProjectionOptions = {
  disabled?: boolean;
  historyDirectory?: string;
  quarantinePath?: string;
  createStore?: (dbPath: string) => SQLiteControlPlaneStore;
  createConversationProjection?: (
    store: SQLiteControlPlaneStore,
  ) => Pick<
    ConversationProjectionStore,
    "applyBrokerBatch" | "applyObservedSessionBatch" | "eventsSince" | "meta" | "persistedActiveObservedSessionUpdates" | "reconcileAll" | "snapshot"
  >;
  createConversationFeedPublisher?: (
    outputPath: string,
  ) => Pick<ConversationFeedArtifactPublisher, "publish">;
  createConversationThreadPublisher?: (
    outputDirectory: string,
  ) => Pick<ConversationThreadArtifactPublisher, "publish">;
  conversationFeedArtifactPath?: string;
  conversationThreadArtifactDirectory?: string;
  conversationFeedPublishDelayMs?: number;
  conversationThreadPublishDelayMs?: number;
  replayYieldEvery?: number;
  replayBatchBytes?: number;
  busyRetryAttempts?: number;
  busyRetryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const DEFAULT_CONVERSATION_FEED_PUBLISH_DELAY_MS = 50;
const DEFAULT_CONVERSATION_THREAD_PUBLISH_DELAY_MS = 75;

// Replay writes are synchronous, but grouping them in a transaction removes
// the far larger per-entry commit cost. Keep batches bounded so broker HTTP
// still gets a timer turn throughout a large startup recovery.
const DEFAULT_REPLAY_YIELD_EVERY = 128;
const REPLAY_ENDPOINT_UPSERT_WORK = 16;
const DEFAULT_BUSY_RETRY_ATTEMPTS = 3;
const DEFAULT_BUSY_RETRY_DELAY_MS = 10;
const SQLITE_PROJECTION_ID = "control-plane";
// Bump whenever journal-to-SQLite reducer semantics change incompatibly. A
// version mismatch deliberately forces one complete replay before checkpointing.
const SQLITE_PROJECTION_VERSION = 1;

export type SQLiteProjectionStatusSnapshot = {
  state: "ready" | "warming" | "degraded" | "disabled";
  detail: string | null;
  skips?: ReturnType<ProjectionSkipLedger["snapshot"]>;
  quarantine?: QuarantineSummary;
  hydration?: { phase: string; processedEntries: number; totalEntries: null; boundaryBytes: number };
};

type SQLiteProjectionCheckpointRow = {
  projection_version: number;
  barrier_id: string;
};

function replayBarrierForCheckpoint(
  row: SQLiteProjectionCheckpointRow | null,
): BrokerJournalReplayOptions["afterBarrier"] {
  if (
    !row
    || row.projection_version !== SQLITE_PROJECTION_VERSION
    || typeof row.barrier_id !== "string"
    || row.barrier_id.length === 0
  ) {
    return undefined;
  }
  return {
    id: row.barrier_id,
    projectionId: SQLITE_PROJECTION_ID,
    projectionVersion: SQLITE_PROJECTION_VERSION,
  };
}

function readReplayCheckpoint(
  store: SQLiteControlPlaneStore,
): BrokerJournalReplayOptions["afterBarrier"] {
  const row = store.readerDb.query(
    `SELECT projection_version, barrier_id
     FROM broker_journal_projection_checkpoints
     WHERE projection_id = ?1
     LIMIT 1`,
  ).get(SQLITE_PROJECTION_ID) as SQLiteProjectionCheckpointRow | null;
  return replayBarrierForCheckpoint(row);
}

function writeReplayCheckpoint(
  store: SQLiteControlPlaneStore,
  barrier: BrokerJournalReplayBarrier,
): void {
  store.writerDb.query(
    `INSERT INTO broker_journal_projection_checkpoints (
       projection_id, projection_version, barrier_id, updated_at
     ) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(projection_id) DO UPDATE SET
       projection_version = excluded.projection_version,
       barrier_id = excluded.barrier_id,
       updated_at = excluded.updated_at`,
  ).run(
    SQLITE_PROJECTION_ID,
    SQLITE_PROJECTION_VERSION,
    barrier.id,
    Date.now(),
  );
}

function normalizeEntries(
  entriesInput: BrokerJournalEntry | BrokerJournalEntry[],
): BrokerJournalEntry[] {
  return Array.isArray(entriesInput) ? entriesInput : [entriesInput];
}

type ReplayParentScan = {
  providedNodes: Map<string, NodeDefinition>;
  providedActors: Map<string, ActorIdentity>;
  providedAgents: Map<string, AgentDefinition>;
  providedConversations: Map<string, ConversationDefinition>;
  referencedNodes: Set<string>;
  referencedActors: Set<string>;
  referencedConversations: Set<string>;
};

type ReplayParentWrite =
  | { kind: "node"; value: NodeDefinition; insertIfMissing: boolean }
  | { kind: "actor"; value: ActorIdentity; insertIfMissing: boolean }
  | { kind: "agent"; value: AgentDefinition; insertIfMissing: false }
  | { kind: "conversation"; value: ConversationDefinition; insertIfMissing: boolean };

function createReplayParentScan(): ReplayParentScan {
  return {
    providedNodes: new Map(),
    providedActors: new Map(),
    providedAgents: new Map(),
    providedConversations: new Map(),
    referencedNodes: new Set(),
    referencedActors: new Set(),
    referencedConversations: new Set(),
  };
}

/**
 * Scan journal entries for FK target IDs that are referenced but never
 * provided by an upsert entry.  Insert minimal stub rows so the main
 * replay doesn't hit FK constraint failures on old/incomplete journals.
 */
function collectReplayParents(scan: ReplayParentScan, entry: BrokerJournalEntry): void {
  // Older / partial journal entries occasionally lack fields like
  // `homeNodeId` or `originNodeId`. Don't propagate those undefineds
  // into the stub upserts — they'd fail NOT NULL on stub creation
  // and abort the whole replay.
  const addRef = (set: Set<string>, value: string | null | undefined): void => {
    if (typeof value === "string" && value.length > 0) set.add(value);
  };

  switch (entry.kind) {
    case "node.upsert":
      scan.providedNodes.set(entry.node.id, entry.node);
      break;
    case "actor.upsert":
      scan.providedActors.set(entry.actor.id, entry.actor);
      break;
    case "agent.upsert":
      scan.providedActors.set(entry.agent.id, entry.agent);
      scan.providedAgents.set(entry.agent.id, entry.agent);
      addRef(scan.referencedNodes, entry.agent.homeNodeId);
      addRef(scan.referencedNodes, entry.agent.authorityNodeId);
      break;
    case "agent.endpoint.upsert":
      addRef(scan.referencedNodes, entry.endpoint.nodeId);
      break;
    case "agent.endpoint.delete":
    case "agent.delete":
    case "actor.delete":
    case "invocation.dispatch_job.record":
    case "journal.replay_barrier":
    case "control.event.record":
      break;
    case "conversation.upsert":
      scan.providedConversations.set(entry.conversation.id, entry.conversation);
      addRef(scan.referencedNodes, entry.conversation.authorityNodeId);
      addRef(scan.referencedConversations, entry.conversation.parentConversationId);
      for (const participantId of entry.conversation.participantIds) {
        addRef(scan.referencedActors, participantId);
      }
      break;
    case "message.record":
      addRef(scan.referencedNodes, entry.message.originNodeId);
      addRef(scan.referencedActors, entry.message.actorId);
      addRef(scan.referencedConversations, entry.message.conversationId);
      addRef(scan.referencedConversations, entry.message.threadConversationId);
      break;
    case "conversation.read_cursor.upsert":
      addRef(scan.referencedNodes, entry.cursor.readerNodeId);
      addRef(scan.referencedActors, entry.cursor.actorId);
      addRef(scan.referencedConversations, entry.cursor.conversationId);
      break;
    case "invocation.record":
      addRef(scan.referencedActors, entry.invocation.requesterId);
      addRef(scan.referencedNodes, entry.invocation.requesterNodeId);
      addRef(scan.referencedNodes, entry.invocation.targetNodeId);
      break;
    case "flight.record":
      addRef(scan.referencedActors, entry.flight.requesterId);
      break;
    case "collaboration.record":
      addRef(scan.referencedActors, entry.record.createdById);
      addRef(scan.referencedActors, entry.record.ownerId);
      addRef(scan.referencedActors, entry.record.nextMoveOwnerId);
      addRef(scan.referencedConversations, entry.record.conversationId);
      break;
    case "collaboration.event.record":
      addRef(scan.referencedActors, entry.event.actorId);
      break;
    case "deliveries.record":
      for (const delivery of entry.deliveries) {
        addRef(scan.referencedNodes, delivery.targetNodeId);
      }
      break;
    default:
      break;
  }
}

function* replayParentWrites(scan: ReplayParentScan): Generator<ReplayParentWrite> {
  const now = Date.now();

  const nodeIds = new Set([...scan.providedNodes.keys(), ...scan.referencedNodes]);
  for (const id of nodeIds) {
    const provided = scan.providedNodes.get(id);
    yield {
      kind: "node",
      value: provided ?? {
        id,
        meshId: "unknown",
        name: id,
        advertiseScope: "local",
        registeredAt: now,
      } as NodeDefinition,
      insertIfMissing: !provided,
    };
  }

  const actorIds = new Set([...scan.providedActors.keys(), ...scan.referencedActors]);
  for (const id of actorIds) {
    const provided = scan.providedActors.get(id);
    yield {
      kind: "actor",
      value: provided ?? { id, kind: "agent", displayName: id } as ActorIdentity,
      insertIfMissing: !provided,
    };
  }
  for (const agent of scan.providedAgents.values()) {
    yield { kind: "agent", value: agent, insertIfMissing: false };
  }

  const anyNodeId =
    nodeIds.values().next().value ??
    "unknown";
  if (nodeIds.size === 0 && scan.referencedConversations.size > 0) {
    yield {
      kind: "node",
      value: {
        id: anyNodeId,
        meshId: "unknown",
        name: anyNodeId,
        advertiseScope: "local",
        registeredAt: now,
      } as NodeDefinition,
      insertIfMissing: true,
    };
  }
  const conversationIds = new Set([
    ...scan.providedConversations.keys(),
    ...scan.referencedConversations,
  ]);
  for (const id of conversationIds) {
    yield {
      kind: "conversation",
      value: {
        id,
        kind: "direct",
        title: id,
        visibility: "private",
        shareMode: "local",
        authorityNodeId: anyNodeId,
        participantIds: [],
      } as ConversationDefinition,
      insertIfMissing: true,
    };
  }
  // Every conversation ID now exists, so parent references are safe regardless
  // of the order in which compacted definitions appear in the journal.
  for (const conversation of scan.providedConversations.values()) {
    yield { kind: "conversation", value: conversation, insertIfMissing: false };
  }
}

function replayParentExists(
  store: SQLiteControlPlaneStore,
  write: ReplayParentWrite,
): boolean {
  if (!write.insertIfMissing) return false;
  const table = write.kind === "node"
    ? "nodes"
    : write.kind === "actor"
      ? "actors"
      : write.kind === "conversation"
        ? "conversations"
        : "agents";
  return store.writerDb.query(
    `SELECT 1 AS found FROM ${table} WHERE id = ?1 LIMIT 1`,
  ).get(write.value.id) !== null;
}

function applyReplayParentWrite(
  store: SQLiteControlPlaneStore,
  write: ReplayParentWrite,
): void {
  // Incremental suffixes often reference rich parents defined before their
  // checkpoint. Synthetic FK stubs may fill genuine holes, but must never
  // overwrite those retained definitions (or clear conversation membership).
  if (replayParentExists(store, write)) return;
  switch (write.kind) {
    case "node":
      store.upsertNode(write.value);
      return;
    case "actor":
      store.upsertActor(write.value);
      return;
    case "agent":
      store.upsertAgent(write.value);
      return;
    case "conversation":
      store.upsertConversation(write.value);
      return;
    default: {
      const exhaustive: never = write;
      return exhaustive;
    }
  }
}

function applyJournalEntryToStore(
  store: SQLiteControlPlaneStore,
  entry: BrokerJournalEntry,
  applyHistoricalCleanup?: (entry: Extract<BrokerJournalEntry, { kind: "history.rotate" }>) => void,
): ThreadEventEnvelope[] {
  switch (entry.kind) {
    case "node.upsert":
      store.upsertNode(entry.node);
      return [];
    case "actor.upsert":
      store.upsertActor(entry.actor);
      return [];
    case "agent.upsert":
      store.upsertAgent(entry.agent);
      return [];
    case "agent.endpoint.upsert":
      store.upsertEndpoint(entry.endpoint);
      return [];
    case "agent.endpoint.delete":
      store.deleteEndpoint(entry.endpointId);
      return [];
    case "agent.delete":
      store.deleteAgent(entry.agentId);
      return [];
    case "actor.delete":
      store.deleteActor(entry.actorId);
      return [];
    case "conversation.upsert":
      store.upsertConversation(entry.conversation);
      return [];
    case "binding.upsert":
      store.upsertBinding(entry.binding);
      return [];
    case "message.record":
      return store.recordMessage(entry.message);
    case "conversation.read_cursor.upsert":
      store.upsertReadCursor(entry.cursor);
      return [];
    case "invocation.record":
      store.recordInvocation(entry.invocation);
      return [];
    case "invocation.dispatch_job.record":
      return [];
    case "flight.record":
      return store.recordFlight(entry.flight, { preserveCurrent: entry.preserveCurrent });
    case "collaboration.record":
      return store.recordCollaborationRecord(entry.record);
    case "collaboration.event.record":
      return store.recordCollaborationEvent(entry.event);
    case "deliveries.record":
      store.recordDeliveries(entry.deliveries);
      return [];
    case "delivery.attempt.record":
      store.recordDeliveryAttempt(entry.attempt);
      return [];
    case "delivery.status.update":
      store.updateDeliveryStatus(entry.deliveryId, entry.status, {
        metadata: entry.metadata,
        leaseOwner: entry.leaseOwner,
        leaseExpiresAt: entry.leaseExpiresAt,
      });
      return [];
    case "durable.action.record":
      store.recordDurableAction(entry.action);
      return [];
    case "durable.action.heartbeat":
      store.heartbeatDurableAction(entry.input);
      return [];
    case "durable.attempt.record":
      store.recordDurableAttempt(entry.attempt);
      return [];
    case "durable.checkpoint.record":
      store.commitDurableCheckpoint({
        ...entry.checkpoint,
        leaseOwner: undefined,
        leaseGeneration: undefined,
      });
      return [];
    case "durable.signal.record":
      store.emitDurableSignal({
        ...entry.signal,
        leaseOwner: undefined,
        leaseGeneration: undefined,
      });
      return [];
    case "control.event.record":
      // A replay checkpoint may not overtake a timer-buffered event write.
      // Injected legacy test stores may expose only recordEvent.
      if (typeof store.recordEventDurably === "function") store.recordEventDurably(entry.event);
      else store.recordEvent(entry.event);
      return [];
    case "journal.replay_barrier":
      return [];
    case "scout.dispatch.record":
      store.recordScoutDispatch(entry.dispatch);
      return [];
    case "history.rotate":
      applyHistoricalCleanup?.(entry);
      return [];
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/**
 * Apply each entry independently. A single bad entry (NOT NULL / FK
 * violation from a malformed historical journal record) must not be
 * allowed to abort the batch — otherwise the caller invalidates the
 * whole store and the next write triggers a full re-replay that hits
 * the same entry again, degrading the projection forever.
 */
function applyJournalEntriesToStore(
  store: SQLiteControlPlaneStore,
  entriesInput: BrokerJournalEntry | BrokerJournalEntry[],
  onSkip?: (entry: BrokerJournalEntry, error: unknown) => void,
  applyHistoricalCleanup?: (entry: Extract<BrokerJournalEntry, { kind: "history.rotate" }>) => void,
): ThreadEventEnvelope[] {
  const threadEvents: ThreadEventEnvelope[] = [];
  for (const entry of normalizeEntries(entriesInput)) {
    try {
      threadEvents.push(...applyJournalEntryToStore(store, entry, applyHistoricalCleanup));
    } catch (error) {
      if (entry.kind === "history.rotate" && (entry.publications?.length || entry.evicted?.controlEventIds?.length)) throw error;
      if (isTransientStoreBusyError(error) || isFatalStoreError(error)) {
        throw error;
      }
      onSkip?.(entry, error);
    }
  }
  return threadEvents;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function isTransientStoreBusyError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      return true;
    }
  }

  const msg = formatError(error).toLowerCase();
  if (msg.includes("database is locked")) return true;
  if (msg.includes("database is busy")) return true;
  if (msg.includes("sqlite_busy")) return true;
  return false;
}

/**
 * Errors that mean the store itself is unusable (closed db, disk full,
 * schema mismatch). These must invalidate the store so the next call
 * rebuilds it. Transient lock contention is handled separately and must
 * preserve the store.
 */
function isFatalStoreError(error: unknown): boolean {
  if (error instanceof QuarantinePersistenceError) return true;
  if (isTransientStoreBusyError(error)) return false;
  const msg = formatError(error).toLowerCase();
  if (msg.includes("disk i/o")) return true;
  if (msg.includes("database disk image is malformed")) return true;
  if (msg.includes("no such table")) return true;
  if (msg.includes("readonly database")) return true;
  if (msg.includes("disk is full") || msg.includes("database or disk is full") || msg.includes("sqlite_full")) return true;
  return false;
}

export type SQLiteProjectionJournal = Pick<FileBackedBrokerJournal, "captureReplayBoundary" | "replay" | "listDeliveries" | "verificationRecords">;

export class RecoverableSQLiteProjection {
  private readonly skipLedger = new ProjectionSkipLedger();
  private quarantine: BrokerQuarantine | null = null;

  private quarantineStore(): BrokerQuarantine {
    return this.quarantine ??= new BrokerQuarantine(this.options.quarantinePath ?? `${this.dbPath}.quarantine.sqlite`);
  }
  quarantineRecord(entry: BrokerJournalEntry, reason: string) {
    return this.quarantineStore().preserve({ kind: entry.kind, reason,
      bytes: Buffer.from(JSON.stringify(entry)), source: { path: this.dbPath }, entries: [entry] });
  }
  listQuarantine(options: QuarantineListOptions = {}) { return this.quarantineStore().list(options); }
  readQuarantine(id: string) { return this.quarantineStore().read(id); }
  acknowledgeQuarantine(id: string) { return this.quarantineStore().acknowledge(id); }

  /**
   * Live-path write batches that exhausted busy retries or hit a fatal store
   * error. Reset when a full journal replay proves every write through its
   * barrier durable again; malformed-entry skips stay counted in the ledger
   * permanently because a reskipped row never lands.
   */
  private applyFailures = 0;

  private readonly reportSkippedEntry = (entry: BrokerJournalEntry, error: unknown): void => {
    const reason = formatError(error).slice(0, 256);
    const evidence = this.quarantineRecord(entry, reason);
    if (this.skipLedger.record(entry.kind, error)) {
      if (evidence.status === "open") console.warn(`[broker] sqlite projection quarantined ${entry.kind} entry ${evidence.id}: ${reason}`);
    }
  };

  private hydration: SQLiteProjectionStatusSnapshot["hydration"];
  private replayProgress = 0;
  private store: SQLiteControlPlaneStore | null = null;

  private conversationProjection: Pick<
    ConversationProjectionStore,
    "applyBrokerBatch" | "applyObservedSessionBatch" | "eventsSince" | "meta" | "persistedActiveObservedSessionUpdates" | "reconcileAll" | "snapshot"
  > | null = null;

  private conversationFeedPublisher: Pick<ConversationFeedArtifactPublisher, "publish"> | null = null;

  private conversationThreadPublisher: Pick<ConversationThreadArtifactPublisher, "publish"> | null = null;

  private pendingConversationFeedSnapshot: ConversationProjectionSnapshot | null = null;

  private conversationFeedPublishTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly conversationFeedPublishDelayMs: number;

  private readonly pendingConversationThreadIds = new Set<string>();

  private conversationThreadPublishTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly conversationThreadPublishDelayMs: number;

  private readonly busyRetryAttempts: number;

  private readonly busyRetryDelayMs: number;

  private readonly sleep: (milliseconds: number) => Promise<void>;

  private queue: Promise<void> = Promise.resolve();

  private closed = false;

  private lastUnavailableReason: string | null = null;

  private warming = false;

  private warmBoundaryReady: Promise<void> | null = null;

  private startupRecoveryInitiated = false;

  private deferredStartupEvents: ControlEvent[] = [];

  private historicalStore: ControlPlaneHistoryStore | null = null;
  private historicalReader: ControlPlaneHistoryReader | null = null;

  private applyHistoricalCleanup(store: SQLiteControlPlaneStore, entry: Extract<BrokerJournalEntry, { kind: "history.rotate" }>): void {
    if (!entry.publications?.length && !entry.evicted?.controlEventIds?.length) return;
    if (!entry.evicted || !this.options.historyDirectory) throw new Error("Historical cleanup receipt cannot be resolved.");
    this.historicalStore ??= new ControlPlaneHistoryStore(this.options.historyDirectory);
    const allowed = emptyHistoryRotationPlan();
    for (const key of Object.values(verificationPlanKeys)) for (const id of entry.evicted[key] ?? []) allowed[key].add(id);
    if (entry.publications?.length) {
      // Validate every page in the marker before any removal: deleting a
      // flight may change activity rows also owned by a later invocation page.
      const result = store.removePublishedHistory(entry.publications, allowed, this.historicalStore);
      if (result.blocked.length) console.warn(`[broker] historical cleanup retained ${result.blocked.length} changed or referenced records`);
    }
    const readEvent = store.writerDb.query<{ id: string; kind: string; actor_id: string; node_id: string | null; ts: number; payload_json: string }>(
      "SELECT id,kind,actor_id,node_id,ts,payload_json FROM events WHERE id=?1",
    );
    const deleteEvent = store.writerDb.query("DELETE FROM events WHERE id=?1");
    let changed = 0;
    for (const id of entry.evicted.controlEventIds ?? []) {
      const historical = this.historicalStore.read("control_event", id);
      if (!historical) throw new Error("Indexed event cleanup receipt is missing.");
      const row = readEvent.get(id);
      if (!row) continue;
      const current = { id: row.id, kind: row.kind, actorId: row.actor_id, ...(row.node_id === null ? {} : { nodeId: row.node_id }), ts: row.ts, payload: JSON.parse(row.payload_json) };
      if (!isDeepStrictEqual(historical, current)) { changed++; continue; }
      deleteEvent.run(id);
    }
    if (changed) console.warn(`[broker] indexed event cleanup retained ${changed} changed records`);
  }

  constructor(
    private readonly dbPath: string,
    private readonly journal: SQLiteProjectionJournal,
    private readonly options: RecoverableSQLiteProjectionOptions = {},
  ) {
    const configuredDelay = options.conversationFeedPublishDelayMs;
    this.conversationFeedPublishDelayMs = typeof configuredDelay === "number"
      && Number.isFinite(configuredDelay)
      && configuredDelay >= 0
      ? Math.floor(configuredDelay)
      : DEFAULT_CONVERSATION_FEED_PUBLISH_DELAY_MS;
    const configuredThreadDelay = options.conversationThreadPublishDelayMs;
    this.conversationThreadPublishDelayMs = typeof configuredThreadDelay === "number"
      && Number.isFinite(configuredThreadDelay)
      && configuredThreadDelay >= 0
      ? Math.floor(configuredThreadDelay)
      : DEFAULT_CONVERSATION_THREAD_PUBLISH_DELAY_MS;
    const configuredBusyRetryAttempts = options.busyRetryAttempts;
    this.busyRetryAttempts = typeof configuredBusyRetryAttempts === "number"
      && Number.isFinite(configuredBusyRetryAttempts)
      && configuredBusyRetryAttempts > 0
      ? Math.max(1, Math.floor(configuredBusyRetryAttempts))
      : DEFAULT_BUSY_RETRY_ATTEMPTS;
    const configuredBusyRetryDelayMs = options.busyRetryDelayMs;
    this.busyRetryDelayMs = typeof configuredBusyRetryDelayMs === "number"
      && Number.isFinite(configuredBusyRetryDelayMs)
      && configuredBusyRetryDelayMs >= 0
      ? Math.floor(configuredBusyRetryDelayMs)
      : DEFAULT_BUSY_RETRY_DELAY_MS;
    this.sleep = options.sleep
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  statusSnapshot(): SQLiteProjectionStatusSnapshot {
    const skips = this.skipLedger.snapshot();
    const quarantine = this.quarantineStore().status();
    return { ...this.readStatus(), ...(skips.total ? { skips } : {}),
      ...(quarantine.openCount || quarantine.acknowledgedCount ? { quarantine } : {}),
      ...(this.warming && this.hydration ? { hydration: { ...this.hydration } } : {}) };
  }

  /** Monotonic completed replay work, used by the worker watchdog. */
  progressRevision(): number { return this.replayProgress; }

  private readStatus(): SQLiteProjectionStatusSnapshot {
    if (this.options.disabled) {
      return {
        state: "disabled",
        detail: "SQLite projection is disabled by configuration.",
      };
    }
    if (this.warming) {
      return {
        state: "warming",
        detail: "SQLite projections are reconciling from the broker journal; prior launch views remain readable.",
      };
    }
    if (this.store) {
      return { state: "ready", detail: null };
    }
    return {
      state: "degraded",
      detail: this.lastUnavailableReason
        ?? (this.closed ? "SQLite projection is closed." : "SQLite projection is not ready."),
    };
  }

  warm(): Promise<void> {
    if (this.options.disabled || this.closed || this.store || this.warming) {
      return this.warmBoundaryReady ?? Promise.resolve();
    }
    this.startupRecoveryInitiated = true;
    const deferredStartupEvents = this.deferredStartupEvents.splice(0);
    this.warming = true;
    let resolveBoundary: () => void = () => {};
    let rejectBoundary: (error: unknown) => void = () => {};
    let boundaryCaptured = false;
    this.warmBoundaryReady = new Promise<void>((resolve, reject) => {
      resolveBoundary = resolve;
      rejectBoundary = reject;
    });
    this.enqueue(async () => {
      try {
        await this.ensureStore(() => {
          boundaryCaptured = true;
          resolveBoundary();
        });
      } finally {
        this.warming = false;
        if (!boundaryCaptured) {
          rejectBoundary(new Error(
            this.lastUnavailableReason ?? "SQLite projection replay boundary could not be established.",
          ));
        }
      }
    });
    for (const event of deferredStartupEvents) {
      this.enqueueEvent(event);
    }
    return this.warmBoundaryReady;
  }

  /** Enqueue before enabling live projection writes. The caller holds the
   * durable writer only while scheduling this fixed-boundary catch-up. Accepted
   * startup records stay in the journal, not in closures behind SQLite replay. */
  async captureStartupCatchUpBoundary(): Promise<BrokerJournalReplayBoundary> {
    return this.journal.captureReplayBoundary({ barrier: {
      id: randomUUID(), projectionId: SQLITE_PROJECTION_ID,
      projectionVersion: SQLITE_PROJECTION_VERSION, createdAt: Date.now(),
    } });
  }

  catchUpStartup(boundary: BrokerJournalReplayBoundary, publishThreadEvents?: (events: ThreadEventEnvelope[]) => Promise<void>): Promise<void> {
    return this.enqueueResult(async () => {
      if (this.options.disabled) return;
      const store = this.store;
      if (!store || this.warming || this.closed) throw new Error("Startup projection is unavailable.");
      const afterBarrier = readReplayCheckpoint(store);
      if (!afterBarrier) throw new Error("Startup projection has no committed replay checkpoint.");
      const parents = createReplayParentScan();
      const scan = await this.replayJournalInBatches(batch => {
        for (const entry of batch) collectReplayParents(parents, entry);
      }, boundary, { afterBarrier });
      if (!scan.afterBarrierFound) throw new Error("Startup replay checkpoint disappeared.");
      await this.prepareReplayParents(store, parents);
      const replay = await this.replayJournalInBatches(async batch => {
        let threadEvents: ThreadEventEnvelope[] = [];
        store.runReplayTransaction(() => {
          const entries = [...batch];
          threadEvents = applyJournalEntriesToStore(store, entries, (entry, error) => {
            this.reportSkippedEntry(entry, error);
          }, entry => this.applyHistoricalCleanup(store, entry));
          this.applyConversationProjectionBatch(store, entries);
        });
        if (threadEvents.length) await publishThreadEvents?.(threadEvents);
      }, boundary, { afterBarrier });
      if (!replay.afterBarrierFound) throw new Error("Startup replay checkpoint disappeared.");
      const projection = this.ensureConversationProjection(store);
      if (boundary.barrier) writeReplayCheckpoint(store, boundary.barrier);
      this.publishConversationFeed(projection);
      this.publishConversationThreads(store, projection);
    });
  }

  enqueueEntries(entriesInput: BrokerJournalEntry | BrokerJournalEntry[]): void {
    const entries = normalizeEntries(entriesInput);
    if (entries.length === 0 || this.options.disabled || this.closed) {
      return;
    }
    // Before explicit recovery starts, durable entries are already present in
    // the journal and will be included by warm()'s later fixed boundary.
    if (!this.startupRecoveryInitiated) {
      return;
    }

    this.enqueue(async () => {
      const store = await this.ensureStore();
      if (!store) {
        return;
      }

      try {
        await this.withBusyRetry(() => {
          applyJournalEntriesToStore(store, entries, (entry, error) => {
            this.reportSkippedEntry(entry, error);
          }, entry => this.applyHistoricalCleanup(store, entry));
          this.applyConversationProjectionBatch(store, entries);
        });
      } catch (error) {
        if (isTransientStoreBusyError(error)) {
          this.applyFailures += 1;
          await this.rebuildAfterExhaustedBusy(error);
          return;
        }
        if (isFatalStoreError(error)) {
          this.applyFailures += 1;
          this.invalidateStore(error);
        } else {
          this.reportSkippedEntry({ kind: "unknown" } as never, error);
        }
      }
    });
  }

  enqueueEvent(event: ControlEvent): void {
    if (this.options.disabled || this.closed) {
      return;
    }
    // Runtime priming emits control events before the daemon begins recovery.
    // Preserve those events without allowing this incidental path to choose
    // the authoritative journal replay boundary.
    if (!this.startupRecoveryInitiated) {
      this.deferredStartupEvents.push(event);
      return;
    }

    this.enqueue(async () => {
      const store = await this.ensureStore();
      if (!store) {
        return;
      }

      try {
        await this.withBusyRetry(() => store.recordEvent(event));
      } catch (error) {
        if (isTransientStoreBusyError(error)) {
          return;
        }
        this.invalidateStore(error);
      }
    });
  }

  async listActivityItems(options: ActivityQuery = {}): Promise<ActivityItem[]> {
    if (this.options.disabled || this.closed) {
      return [];
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return [];
    }

    try {
      return store.listActivityItems(options);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return [];
      }
      this.invalidateStore(error);
      return [];
    }
  }

  async readMessages(ids: readonly string[]): Promise<Map<string, MessageRecord>> {
    if (ids.length > 128) throw new Error("historical_message_read_capacity");
    if (this.closed || this.options.disabled) throw new Error("Historical message storage is unavailable.");
    await this.flush();
    const store = await this.ensureStore();
    if (!store) throw new Error("Historical message storage is unavailable.");
    return store.readMessages([...ids]);
  }

  async readInvocations(ids: readonly string[]): Promise<Map<string, InvocationRequest>> {
    if (ids.length > 128) throw new Error("historical_invocation_read_capacity");
    if (this.closed || this.options.disabled) throw new Error("Historical invocation storage is unavailable.");
    await this.flush();
    const store = await this.ensureStore();
    if (!store) throw new Error("Historical invocation storage is unavailable.");
    return store.readInvocations([...ids]);
  }

  async readInvocationSnapshot(id: string): Promise<ReturnType<SQLiteControlPlaneStore["readInvocationSnapshot"]>> {
    if (this.closed || this.options.disabled) throw new Error("Historical invocation storage is unavailable.");
    await this.flush();
    const store = await this.ensureStore();
    if (!store) throw new Error("Historical invocation storage is unavailable.");
    return store.readInvocationSnapshot(id);
  }

  publishHistoricalPage(records: readonly HistoricalRecord[], options?: Parameters<ControlPlaneHistoryStore["publishPage"]>[1]): Promise<HistoricalPublication> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.enqueueResult(async () => {
      if (!this.options.historyDirectory) throw new Error("Historical storage is not configured.");
      this.historicalStore ??= new ControlPlaneHistoryStore(this.options.historyDirectory);
      return this.historicalStore.publishPage(records, options);
    });
  }

  publishHistoryRotation(plan: HistoryRotationPlan): Promise<ReturnType<SQLiteControlPlaneStore["publishHistoryRotation"]>> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.enqueueResult(async () => {
      const store = await this.ensureStore();
      if (!store || !this.options.historyDirectory) throw new Error("Historical storage is unavailable.");
      this.historicalStore ??= new ControlPlaneHistoryStore(this.options.historyDirectory);
      return store.publishHistoryRotation(plan, this.historicalStore);
    });
  }

  removePublishedHistory(publication: HistoricalPublication, allowed: HistoryRotationPlan): Promise<ReturnType<SQLiteControlPlaneStore["removePublishedHistory"]>> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.enqueueResult(async () => {
      const store = await this.ensureStore();
      if (!store || !this.options.historyDirectory) throw new Error("Historical storage is unavailable.");
      this.historicalStore ??= new ControlPlaneHistoryStore(this.options.historyDirectory);
      return store.removePublishedHistory(publication, allowed, this.historicalStore);
    });
  }

  readHistoricalRecords(kind: string, ids: readonly string[]): Promise<Map<string, unknown>> {
    if (ids.length > 128) return Promise.reject(new Error("historical_record_read_capacity"));
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.enqueueResult(async () => {
      const reader = this.historyReader();
      const records = new Map<string, unknown>();
      for (const id of ids) {
        const record = reader.read(kind, id);
        if (record !== undefined) records.set(id, record);
      }
      return records;
    });
  }

  pageHistoricalRecords(options: Parameters<ControlPlaneHistoryReader["page"]>[0]): Promise<HistoricalRecordLocation[]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.enqueueResult(async () => this.historyReader().page(options));
  }

  private historyReader(): ControlPlaneHistoryReader {
    if (!this.options.historyDirectory) throw new Error("Historical storage is not configured.");
    return this.historicalStore ?? (this.historicalReader ??= new ControlPlaneHistoryReader(this.options.historyDirectory));
  }

  async listDeliveries(options: {
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    targetId?: string;
    statuses?: DeliveryIntent["status"][];
    reasons?: DeliveryIntent["reason"][];
    limit?: number;
  } = {}): Promise<DeliveryIntent[]> {
    if (this.options.disabled || this.closed) {
      return this.journal.listDeliveries(options);
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return this.journal.listDeliveries(options);
    }

    try {
      return store.listDeliveries(options);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return this.journal.listDeliveries(options);
      }
      this.invalidateStore(error);
      return this.journal.listDeliveries(options);
    }
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => {});
  }

  /** One maintenance page per queued turn; never monopolize the projection worker. */
  archiveEvents(options: { cutoff: number; archiveDir: string; pageSize?: number; maxPages?: number }): Promise<ArchiveEventsResult> {
    return this.enqueueResult(async () => {
      const store = await this.ensureStore();
      if (!store || this.closed || this.options.disabled) throw new Error("SQLite projection is unavailable for archive verification.");
      if (this.options.historyDirectory) this.historicalStore ??= new ControlPlaneHistoryStore(this.options.historyDirectory);
      return archiveEvents(store.writerDb, { ...options, pageSize: Math.min(options.pageSize ?? 1000, 1000), pageBytes: 1024 * 1024,
        maxPages: Math.min(options.maxPages ?? 1, 1), ...(this.historicalStore ? { historyStore: this.historicalStore, deferRemoval: true } : {}) });
    });
  }

  async applyEntries(entriesInput: BrokerJournalEntry | BrokerJournalEntry[]): Promise<ThreadEventEnvelope[]> {
    const entries = normalizeEntries(entriesInput);
    if (entries.length === 0 || this.options.disabled || this.closed) {
      return [];
    }

    return this.enqueueResult(async () => {
      const store = await this.ensureStore();
      if (!store) {
        return [];
      }

      try {
        return await this.withBusyRetry(() => {
          const threadEvents = applyJournalEntriesToStore(store, entries, (entry, error) => {
            this.reportSkippedEntry(entry, error);
          }, entry => this.applyHistoricalCleanup(store, entry));
          this.applyConversationProjectionBatch(store, entries);
          return threadEvents;
        });
      } catch (error) {
        if (isTransientStoreBusyError(error)) {
          this.applyFailures += 1;
          await this.rebuildAfterExhaustedBusy(error);
          return [];
        }
        if (isFatalStoreError(error)) {
          this.applyFailures += 1;
          this.invalidateStore(error);
        } else {
          this.reportSkippedEntry({ kind: "unknown" } as never, error);
        }
        return [];
      }
    });
  }

  /**
   * Health probe for the durable store's persistence boundary: a COARSE
   * gate only — live-path apply failures since the last proven replay, and
   * a reason whenever the projection cannot durably accept writes. It
   * deliberately carries no per-record coverage claim and does not count
   * skip-ledger entries: a permanently unprojectable record must not veto
   * rotation of everything else — `verifyPersisted` keeps that record
   * journaled while the rest still evict.
   */
  health(): BrokerProjectionHealth {
    return {
      failures: this.applyFailures,
      unavailable: this.options.disabled
        ? "sqlite projection disabled"
        : this.closed
          ? "sqlite projection closed"
          : !this.startupRecoveryInitiated
            ? "sqlite projection startup recovery not initiated"
            : this.lastUnavailableReason,
    };
  }

  /**
   * Positive per-record coverage proof for a rotation plan. The caller verifies
   * outside the durable writer, then revalidates the captured versions and
   * dependency closure under that writer before appending the rotation marker.
   * Every id the plan names is
   * answered individually — `present` only when the stored row reads back
   * EQUAL to the journaled record through the same row→record mapper
   * `loadSnapshot` uses (canonicalized identically on both sides), so a
   * missing row or stale contents — any field, not just existence or a
   * flight's state pair — reports the id `missing` and it stays journaled
   * for a later rotation.
   *
   * Fails closed: an unavailable store or any lookup error returns a fresh
   * empty `present` with every planned id `missing` — `present` and
   * `missing` always partition the plan, never overlap.
   */
  async verifyPersistedDigests(records: readonly ProjectionVerificationDigest[]): Promise<BrokerPersistenceVerification> {
    if (records.length > 128) throw new Error("projection_verification_page_capacity");
    const present = emptyHistoryRotationPlan(), missing = emptyHistoryRotationPlan();
    for (const record of records) missing[verificationPlanKeys[record.kind]].add(record.id);
    if (this.options.disabled || this.closed) return { present, missing };
    await this.flush();
    const store = await this.ensureStore();
    if (!store) return { present, missing };
    try {
      const readers = {
        message: (ids: string[]) => store.readMessages(ids),
        invocation: (ids: string[]) => store.readInvocations(ids),
        flight: (ids: string[]) => store.readFlights(ids),
        delivery: (ids: string[]) => store.readDeliveries(ids),
        deliveryAttempt: (ids: string[]) => store.readDeliveryAttempts(ids),
        collaborationEvent: (ids: string[]) => store.readCollaborationEvents(ids),
      };
      for (const kind of Object.keys(readers) as PersistedRotationRecordKind[]) {
        const group = records.filter(record => record.kind === kind);
        if (!group.length) continue;
        const stored = readers[kind](group.map(record => record.id));
        for (const record of group) {
          const value = stored.get(record.id);
          if (value !== undefined && projectionVerificationDigest(kind, value) === record.digest) {
            const key = verificationPlanKeys[kind]; missing[key].delete(record.id); present[key].add(record.id);
          }
        }
      }
      return { present, missing };
    } catch (error) {
      if (!isTransientStoreBusyError(error)) this.invalidateStore(error);
      const allMissing = emptyHistoryRotationPlan();
      for (const record of records) allMissing[verificationPlanKeys[record.kind]].add(record.id);
      return { present: emptyHistoryRotationPlan(), missing: allMissing };
    }
  }

  async verifyPersisted(plan: HistoryRotationPlan, suppliedRecords?: BrokerJournalVerificationRecords): Promise<BrokerPersistenceVerification> {
    const allMissing = (): BrokerPersistenceVerification => ({
      present: emptyHistoryRotationPlan(),
      missing: {
        messageIds: new Set(plan.messageIds),
        invocationIds: new Set(plan.invocationIds),
        flightIds: new Set(plan.flightIds),
        deliveryIds: new Set(plan.deliveryIds),
        deliveryAttemptIds: new Set(plan.deliveryAttemptIds),
        collaborationEventIds: new Set(plan.collaborationEventIds),
      },
    });
    if (this.options.disabled || this.closed) {
      return allMissing();
    }
    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return allMissing();
    }
    try {
      const present = emptyHistoryRotationPlan();
      const missing = emptyHistoryRotationPlan();
      const expectedRecords = suppliedRecords ?? this.journal.verificationRecords(plan);
      const snapshot = {
        messages: Object.fromEntries(expectedRecords.messages.map(value => [value.id, value])),
        invocations: Object.fromEntries(expectedRecords.invocations.map(value => [value.id, value])),
        flights: Object.fromEntries(expectedRecords.flights.map(value => [value.id, value])),
      };
      const journaledDeliveries = new Map(expectedRecords.deliveries.map(value => [value.id, value]));
      const matches = (
        kind: PersistedRotationRecordKind,
        stored: unknown,
        expected: unknown,
        expectedContext?: CanonicalRecordContext,
      ): boolean => (
        stored !== undefined
        && expected !== undefined
        && isDeepStrictEqual(
          canonicalRecord(kind, stored as Record<string, unknown>),
          canonicalRecord(kind, expected as Record<string, unknown>, expectedContext),
        )
      );

      const storedMessages = store.readMessages([...plan.messageIds]);
      for (const id of plan.messageIds) {
        const expected = snapshot.messages[id];
        (matches("message", storedMessages.get(id), expected)
          ? present : missing).messageIds.add(id);
      }
      const storedInvocations = store.readInvocations([...plan.invocationIds]);
      for (const id of plan.invocationIds) {
        (matches("invocation", storedInvocations.get(id), snapshot.invocations[id])
          ? present : missing).invocationIds.add(id);
      }
      const storedFlights = store.readFlights([...plan.flightIds]);
      for (const id of plan.flightIds) {
        const expected = snapshot.flights[id];
        // recordFlight normalizes a divergent identity to the parent
        // invocation's — pass the journaled parent so the expected record is
        // canonicalized through the same rule (stored rows carry the
        // normalized identity already).
        (matches("flight", storedFlights.get(id), expected, {
          flightInvocation: expected === undefined
            ? undefined
            : snapshot.invocations[expected.invocationId],
        })
          ? present : missing).flightIds.add(id);
      }
      const storedDeliveries = store.readDeliveries([...plan.deliveryIds]);
      for (const id of plan.deliveryIds) {
        (matches("delivery", storedDeliveries.get(id), journaledDeliveries.get(id))
          ? present : missing).deliveryIds.add(id);
      }
      const storedAttempts = store.readDeliveryAttempts([...plan.deliveryAttemptIds]);
      const journaledAttempts = new Map(expectedRecords.deliveryAttempts.map(value => [value.id, value]));
      for (const id of plan.deliveryAttemptIds) {
        (matches("deliveryAttempt", storedAttempts.get(id), journaledAttempts.get(id))
          ? present : missing).deliveryAttemptIds.add(id);
      }
      const storedEvents = store.readCollaborationEvents([...plan.collaborationEventIds]);
      const journaledEvents = new Map(expectedRecords.collaborationEvents.map(value => [value.id, value]));
      for (const id of plan.collaborationEventIds) {
        (matches("collaborationEvent", storedEvents.get(id), journaledEvents.get(id))
          ? present : missing).collaborationEventIds.add(id);
      }
      return { present, missing };
    } catch (error) {
      if (!isTransientStoreBusyError(error)) {
        this.invalidateStore(error);
      }
      return allMissing();
    }
  }

  /**
   * Serialized sink for the keyed transcript reducer. Observed summaries share
   * the broker projection cursor and artifact publisher, but never enter the
   * canonical Scout message tables.
   */
  async applyObservedSessionBatch(
    updates: readonly ObservedSessionProjectionUpdate[],
  ): Promise<void> {
    if (updates.length === 0 || this.options.disabled || this.closed) return;
    await this.enqueueResult(async () => {
      const store = await this.ensureStore();
      if (!store) return;
      try {
        await this.withBusyRetry(() => {
          const conversationProjection = this.ensureConversationProjection(store);
          const event = conversationProjection.applyObservedSessionBatch(updates);
          if (event) {
            this.publishConversationFeed(conversationProjection);
          }
        });
      } catch (error) {
        if (isFatalStoreError(error)) {
          this.invalidateStore(error);
        } else if (!isTransientStoreBusyError(error)) {
          console.warn(`[broker] observed session projection skipped batch: ${formatError(error)}`);
        }
        throw error;
      }
    });
  }

  async latestThreadSeq(conversationId: string): Promise<number> {
    if (this.options.disabled || this.closed) {
      return 0;
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return 0;
    }

    try {
      return store.latestThreadSeq(conversationId);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return 0;
      }
      this.invalidateStore(error);
      return 0;
    }
  }

  async oldestThreadSeq(conversationId: string): Promise<number> {
    if (this.options.disabled || this.closed) {
      return 0;
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return 0;
    }

    try {
      return store.oldestThreadSeq(conversationId);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return 0;
      }
      this.invalidateStore(error);
      return 0;
    }
  }

  async listThreadEvents(options: {
    conversationId: string;
    afterSeq?: number;
    limit?: number;
  }): Promise<ThreadEventEnvelope[]> {
    if (this.options.disabled || this.closed) {
      return [];
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return [];
    }

    try {
      return store.listThreadEvents(options);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return [];
      }
      this.invalidateStore(error);
      return [];
    }
  }

  async getThreadSnapshot(conversationId: string): Promise<ThreadSnapshot | null> {
    if (this.options.disabled || this.closed) {
      return null;
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return null;
    }

    try {
      return store.getThreadSnapshot(conversationId);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return null;
      }
      this.invalidateStore(error);
      return null;
    }
  }

  async conversationSnapshot(limit?: number): Promise<ConversationProjectionSnapshot | null> {
    if (this.options.disabled || this.closed) {
      return null;
    }

    // Unlike canonical/thread reads, the launch view is explicitly allowed to
    // serve its prior committed sequence while startup reconciliation runs.
    // Waiting on the projection queue here would put journal replay back on the
    // first-paint path this materialized view exists to remove.
    const store = this.store;
    if (!store) {
      // A launch read is a cache lookup, never a recovery barrier. If the
      // replaceable projection is unavailable, start one shared rebuild in the
      // background and let the caller use its bounded compatibility fallback.
      // Awaiting ensureStore() here used to inherit a full two-pass journal
      // replay (and the broker request's 30 second timeout) on first paint.
      if (!this.warming) void this.warm().catch(() => {});
      return null;
    }

    try {
      return this.ensureConversationProjection(store).snapshot(limit);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return null;
      }
      this.invalidateStore(error);
      return null;
    }
  }

  async persistedActiveObservedSessionUpdates(
    limit?: number,
  ): Promise<ObservedSessionProjectionUpdate[] | null> {
    if (this.options.disabled || this.closed) return null;
    // Startup hydration reads the last committed projection exactly like the
    // launch snapshot. Waiting for the recovery queue here would turn a
    // five-minute journal rebuild into a broker-startup dependency.
    const store = this.store;
    if (!store) return null;
    try {
      return await this.withBusyRetry(() => (
        this.ensureConversationProjection(store).persistedActiveObservedSessionUpdates(limit)
      ));
    } catch (error) {
      if (!isTransientStoreBusyError(error)) this.invalidateStore(error);
      return null;
    }
  }

  async conversationEvents(
    cursor: ConversationProjectionCursor,
    limit?: number,
  ): Promise<ConversationProjectionEventPage | null> {
    if (this.options.disabled || this.closed) {
      return null;
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return null;
    }

    try {
      return this.ensureConversationProjection(store).eventsSince(cursor, limit);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return null;
      }
      this.invalidateStore(error);
      return null;
    }
  }

  close(): void {
    this.closed = true;
    this.flushPendingConversationFeed();
    this.flushPendingConversationThreads();
    const current = this.store;
    this.store = null;
    this.conversationProjection = null;
    this.conversationFeedPublisher = null;
    this.conversationThreadPublisher = null;
    current?.close();
    this.historicalReader?.close(); this.historicalReader = null;
    this.historicalStore?.close(); this.historicalStore = null;
    this.quarantine?.close(); this.quarantine = null;
  }

  private enqueue(task: () => Promise<void>): void {
    if (this.closed) {
      return;
    }

    this.queue = this.queue
      .catch(() => {})
      .then(task);
  }

  private enqueueResult<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.resolve(undefined as T);
    }

    const next = this.queue
      .catch(() => {})
      .then(task);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  private async withBusyRetry<T>(operation: () => T | Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.busyRetryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isTransientStoreBusyError(error) || attempt >= this.busyRetryAttempts) {
          throw error;
        }
        await this.sleep(this.busyRetryDelayMs * attempt);
      }
    }
    throw new Error("unreachable SQLite busy retry state");
  }

  private discardCurrentStoreForRetry(): void {
    this.clearPendingConversationThreads();
    const current = this.store;
    this.store = null;
    this.conversationProjection = null;
    current?.close();
  }

  private async rebuildAfterExhaustedBusy(error: unknown): Promise<void> {
    this.invalidateStore(error);
    if (!this.closed) {
      await this.ensureStore();
    }
  }

  private replayBatchSize(): number {
    const configuredBatchSize = this.options.replayYieldEvery ?? DEFAULT_REPLAY_YIELD_EVERY;
    return Number.isFinite(configuredBatchSize)
      ? Math.max(1, Math.floor(configuredBatchSize))
      : DEFAULT_REPLAY_YIELD_EVERY;
  }

  private async yieldReplayTurn(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private async forEachReplayBatch<T>(
    values: Iterable<T>,
    visitor: (batch: readonly T[]) => void | Promise<void>,
  ): Promise<void> {
    const batchSize = this.replayBatchSize();
    let batch: T[] = [];
    for (const value of values) {
      if (batch.length === batchSize) {
        await visitor(batch);
        batch = [];
        await this.yieldReplayTurn();
      }
      batch.push(value);
    }
    if (batch.length > 0) {
      await visitor(batch);
    }
  }

  private async replayJournalInBatches(
    visitor: (batch: readonly BrokerJournalEntry[]) => void | Promise<void>,
    boundary: BrokerJournalReplayBoundary,
    options: BrokerJournalReplayOptions = {},
  ): Promise<BrokerJournalReplayReport> {
    const batchSize = this.replayBatchSize();
    this.hydration = { phase: this.hydration?.phase ?? "replay", processedEntries: 0, totalEntries: null, boundaryBytes: boundary.endByteExclusive };
    let batch: BrokerJournalEntry[] = [];
    let batchWork = 0;
    let batchBytes = 0;
    const configuredBytes = this.options.replayBatchBytes;
    const byteBudget = configuredBytes !== undefined && Number.isFinite(configuredBytes) && configuredBytes > 0
      ? Math.floor(configuredBytes) : 1024 * 1024;
    const flushForMoreWork = async (): Promise<void> => {
      await visitor(batch);
      batch = [];
      batchWork = 0;
      batchBytes = 0;
      await this.yieldReplayTurn();
    };
    const add = async (entry: BrokerJournalEntry, work: number): Promise<void> => {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (batchWork > 0 && (batchWork + work > batchSize || batchBytes + bytes > byteBudget)) await flushForMoreWork();
      batch.push(entry); batchWork += work; batchBytes += bytes;
      // A single legal frame can be larger than the batch budget. Process it
      // alone, never reject or retain another payload beside it.
      if (batchBytes >= byteBudget) await flushForMoreWork();
    };
    const replayReport = await this.journal.replay(async (entry) => {
      this.replayProgress++;
      if (this.hydration) this.hydration.processedEntries++;
      if (entry.kind !== "deliveries.record" || entry.deliveries.length === 0) {
        // Endpoint projection derives session aliases and budget observations,
        // so it is materially heavier than a scalar record upsert. Account for
        // that work while preserving journal order; with the default 128-unit
        // budget, at most eight endpoint upserts monopolize one event-loop turn.
        const entryWork = entry.kind === "agent.endpoint.upsert"
          ? Math.min(REPLAY_ENDPOINT_UPSERT_WORK, batchSize)
          : 1;
        await add(entry, entryWork);
        return;
      }

      let offset = 0;
      while (offset < entry.deliveries.length) {
        if (batchWork === batchSize) await flushForMoreWork();
        const chunkSize = Math.min(batchSize - batchWork, entry.deliveries.length - offset);
        const chunk = {
          kind: "deliveries.record",
          deliveries: entry.deliveries.slice(offset, offset + chunkSize),
        } as const;
        if (Buffer.byteLength(JSON.stringify(chunk)) > byteBudget && chunkSize > 1) {
          for (const delivery of chunk.deliveries) await add({ kind: "deliveries.record", deliveries: [delivery] }, 1);
        } else await add(chunk, chunkSize);
        offset += chunkSize;
      }
    }, boundary, options);
    if (batchWork > 0) {
      await visitor(batch);
    }
    return replayReport ?? {
      afterBarrierFound: options.afterBarrier === undefined,
      visitedEntries: 0,
    };
  }

  private async prepareReplayParents(
    store: SQLiteControlPlaneStore,
    scan: ReplayParentScan,
  ): Promise<void> {
    await this.forEachReplayBatch(replayParentWrites(scan), (batch) => {
      store.runReplayTransaction(() => {
        for (const write of batch) {
          applyReplayParentWrite(store, write);
          this.replayProgress++;
        }
      });
    });
  }

  private async applyReplayJournal(
    store: SQLiteControlPlaneStore,
    boundary: BrokerJournalReplayBoundary,
    options: BrokerJournalReplayOptions = {},
  ): Promise<BrokerJournalReplayReport> {
    const applyBatch = (batch: readonly BrokerJournalEntry[]): void => {
      store.runReplayTransaction(() => {
        for (const entry of batch) {
          try {
            applyJournalEntryToStore(store, entry, marker => this.applyHistoricalCleanup(store, marker));
          } catch (error) {
            if (entry.kind === "history.rotate" && (entry.publications?.length || entry.evicted?.controlEventIds?.length)) throw error;
            if (isTransientStoreBusyError(error)) {
              throw error;
            }
            if (isFatalStoreError(error)) {
              throw error;
            }
            this.reportSkippedEntry(entry, error);
          }
        }
      });
    };
    return this.replayJournalInBatches(applyBatch, boundary, options);
  }

  private async ensureStore(onReplayBoundaryCaptured?: () => void): Promise<SQLiteControlPlaneStore | null> {
    if (this.options.disabled || this.closed) {
      return null;
    }
    if (!this.startupRecoveryInitiated) {
      return null;
    }
    if (this.store) {
      return this.store;
    }

    let replayBoundary: BrokerJournalReplayBoundary;
    try {
      replayBoundary = await this.withBusyRetry(() => this.journal.captureReplayBoundary({
        barrier: {
          id: randomUUID(),
          projectionId: SQLITE_PROJECTION_ID,
          projectionVersion: SQLITE_PROJECTION_VERSION,
          createdAt: Date.now(),
        },
      }));
      onReplayBoundaryCaptured?.();
      // Let the daemon's listener-ready continuation run before synchronous
      // SQLite construction/migrations begin. Resolving the warm boundary and
      // immediately opening here would keep the same microtask occupied, so a
      // large database could still make already-bound listeners appear dead.
      await this.yieldReplayTurn();
    } catch (error) {
      this.invalidateStore(error);
      return null;
    }

    const createStore = this.options.createStore
      ?? ((dbPath: string) => new SQLiteControlPlaneStore(dbPath));
    for (let attempt = 1; attempt <= this.busyRetryAttempts; attempt += 1) {
      try {
        const store = createStore(this.dbPath);
        if (this.options.historyDirectory) store.configureHistory(this.options.historyDirectory);
        this.store = store;
        const conversationProjection = this.ensureConversationProjection(store);
        // Make the last committed launch view readable immediately. Durable
        // writes remain queued behind this recovery task, so the canonical store
        // still cannot race the fixed journal boundary.
        this.lastUnavailableReason = null;
        const priorSnapshot = conversationProjection.snapshot(160);
        if (priorSnapshot.total > 0) {
          this.publishConversationFeed(conversationProjection);
          this.publishConversationThreads(store, conversationProjection);
        }
        // A checkpoint is trusted only when the exact opaque marker still
        // exists in this journal. Compaction preserves marker ordering but can
        // change every byte offset, so marker identity — never an offset — is
        // the durable resume contract. Missing/foreign/version-old markers
        // fall back to the complete replay path.
        let replayAfter = replayBoundary.barrier
          ? readReplayCheckpoint(store)
          : undefined;
        this.hydration = { phase: "parents", processedEntries: 0, totalEntries: null, boundaryBytes: replayBoundary.endByteExclusive };
        let parents = createReplayParentScan();
        const parentReport = await this.replayJournalInBatches((batch) => {
          for (const entry of batch) collectReplayParents(parents, entry);
        }, replayBoundary, { afterBarrier: replayAfter });
        if (replayAfter && !parentReport.afterBarrierFound) {
          replayAfter = undefined;
          parents = createReplayParentScan();
          await this.replayJournalInBatches((batch) => {
            for (const entry of batch) collectReplayParents(parents, entry);
          }, replayBoundary);
        }
        await this.prepareReplayParents(store, parents);
        this.hydration.phase = "records";
        const replayReport = await this.applyReplayJournal(
          store,
          replayBoundary,
          { afterBarrier: replayAfter },
        );
        if (replayAfter && !replayReport.afterBarrierFound) {
          throw new Error("SQLite projection replay barrier disappeared during fixed-boundary recovery.");
        }
        this.hydration.phase = "conversations";
        conversationProjection.reconcileAll();
        // This commit is deliberately last among durable projection writes.
        // A crash before it leaves the old checkpoint in place, making the next
        // boot idempotently replay the suffix again. A committed new checkpoint
        // therefore proves every journal fact through its barrier committed.
        if (replayBoundary.barrier) {
          writeReplayCheckpoint(store, replayBoundary.barrier);
        }
        // The replay just proved every journaled write through the barrier
        // durable, so transient live-path failures before it are resolved.
        // Malformed-entry skips stay in the ledger — they never land.
        this.applyFailures = 0;
        this.publishConversationFeed(conversationProjection);
        this.publishConversationThreads(store, conversationProjection);
        return store;
      } catch (error) {
        if (isTransientStoreBusyError(error)) {
          // The store becomes readable before replay yields so launch reads can
          // use the prior projection. A later BUSY must revoke that candidate;
          // otherwise warm() would report ready around a partially replayed DB.
          this.discardCurrentStoreForRetry();
          if (attempt < this.busyRetryAttempts) {
            await this.sleep(this.busyRetryDelayMs * attempt);
            continue;
          }
          this.invalidateStore(error);
          return null;
        }
        this.invalidateStore(error);
        return null;
      }
    }
    return null;
  }

  private invalidateStore(error: unknown): void {
    const reason = formatError(error);
    if (this.lastUnavailableReason !== reason) {
      console.warn(`[broker] sqlite projection unavailable (degraded): ${reason}`);
      this.lastUnavailableReason = reason;
    }

    this.flushPendingConversationFeed();
    this.clearPendingConversationThreads();
    const current = this.store;
    this.store = null;
    this.conversationProjection = null;
    this.conversationFeedPublisher = null;
    this.conversationThreadPublisher = null;
    current?.close();
  }

  private ensureConversationProjection(
    store: SQLiteControlPlaneStore,
  ): Pick<
    ConversationProjectionStore,
    "applyBrokerBatch" | "applyObservedSessionBatch" | "eventsSince" | "meta" | "persistedActiveObservedSessionUpdates" | "reconcileAll" | "snapshot"
  > {
    if (!this.conversationProjection) {
      this.conversationProjection = this.options.createConversationProjection?.(store)
        ?? new ConversationProjectionStore(
          store.writerDb as ControlPlaneSqliteTransactionalDatabase,
          { readArchivedMessage: id => store.readArchivedMessage(id) },
        );
    }
    return this.conversationProjection;
  }

  private ensureConversationFeedPublisher(): Pick<ConversationFeedArtifactPublisher, "publish"> {
    if (!this.conversationFeedPublisher) {
      const outputPath = this.options.conversationFeedArtifactPath
        ?? join(dirname(this.dbPath), NATIVE_READ_FEED_ARTIFACT_FILENAME);
      this.conversationFeedPublisher = this.options.createConversationFeedPublisher?.(outputPath)
        ?? new ConversationFeedArtifactPublisher(outputPath);
    }
    return this.conversationFeedPublisher;
  }

  private ensureConversationThreadPublisher(): Pick<ConversationThreadArtifactPublisher, "publish"> {
    if (!this.conversationThreadPublisher) {
      const outputDirectory = this.options.conversationThreadArtifactDirectory
        ?? join(dirname(this.dbPath), NATIVE_READ_THREAD_ARTIFACT_DIRECTORY);
      this.conversationThreadPublisher = this.options.createConversationThreadPublisher?.(
        outputDirectory,
      ) ?? new ConversationThreadArtifactPublisher(outputDirectory);
    }
    return this.conversationThreadPublisher;
  }

  private applyConversationProjectionBatch(
    store: SQLiteControlPlaneStore,
    entries: readonly BrokerJournalEntry[],
  ): void {
    const projection = this.ensureConversationProjection(store);
    const event = projection.applyBrokerBatch(entries);
    if (event) {
      this.publishConversationFeed(projection);
    }

    // Thread content has a distinct revision domain from the feed list. In
    // particular, correcting a retained non-latest message can leave the list
    // item semantically unchanged (and therefore produce no projection event),
    // but the native selected-thread page must still be replaced. Include the
    // entry identities unconditionally and any prior conversation surfaced by
    // a move correction in the material list delta.
    const changedConversationIds = new Set(
      entries
        .filter((entry): entry is Extract<BrokerJournalEntry, { kind: "message.record" }> => (
          entry.kind === "message.record"
        ))
        .map((entry) => entry.message.conversationId)
        .filter(Boolean),
    );
    if (event && changedConversationIds.size > 0) {
      for (const item of event.delta.upserted) {
        if (item.entityKind === "scout_conversation" && item.conversationId) {
          changedConversationIds.add(item.conversationId);
        }
      }
    }
    if (changedConversationIds.size > 0) {
      this.publishConversationThreads(store, projection, [...changedConversationIds]);
    }
  }

  private publishConversationFeed(
    projection: Pick<ConversationProjectionStore, "snapshot">,
  ): void {
    const snapshot = projection.snapshot(160);
    if (this.conversationFeedPublishDelayMs === 0) {
      this.writeConversationFeed(snapshot);
      return;
    }

    this.pendingConversationFeedSnapshot = snapshot;
    if (this.conversationFeedPublishTimer) return;
    this.conversationFeedPublishTimer = setTimeout(() => {
      this.conversationFeedPublishTimer = null;
      const pending = this.pendingConversationFeedSnapshot;
      this.pendingConversationFeedSnapshot = null;
      if (pending) this.writeConversationFeed(pending);
    }, this.conversationFeedPublishDelayMs);
    this.conversationFeedPublishTimer.unref?.();
  }

  private writeConversationFeed(snapshot: ConversationProjectionSnapshot): void {
    try {
      this.ensureConversationFeedPublisher().publish(snapshot);
    } catch (error) {
      // The artifact is a replaceable delivery cache. A serialization or disk
      // failure must never invalidate the authoritative SQLite projection or
      // reject the durable broker write that already committed.
      console.warn(`[broker] native conversation feed publish failed: ${formatError(error)}`);
    }
  }

  private flushPendingConversationFeed(): void {
    if (this.conversationFeedPublishTimer) {
      clearTimeout(this.conversationFeedPublishTimer);
      this.conversationFeedPublishTimer = null;
    }
    const pending = this.pendingConversationFeedSnapshot;
    this.pendingConversationFeedSnapshot = null;
    if (pending) this.writeConversationFeed(pending);
  }

  private publishConversationThreads(
    store: SQLiteControlPlaneStore,
    projection: Pick<ConversationProjectionStore, "meta" | "snapshot">,
    conversationIds?: readonly string[],
  ): void {
    const ids = new Set(
      (conversationIds ?? [])
        .map((conversationId) => conversationId.trim())
        .filter(Boolean),
    );
    if (conversationIds === undefined) {
      const launch = projection.snapshot(160);
      if (launch.engagedFeedId?.startsWith("conv:")) {
        ids.add(launch.engagedFeedId.slice("conv:".length));
      }
      for (const item of launch.items) {
        if (ids.size >= 4) break;
        if (item.entityKind === "scout_conversation" && item.conversationId) {
          ids.add(item.conversationId);
        }
      }
    }
    if (ids.size === 0) return;
    for (const conversationId of ids) this.pendingConversationThreadIds.add(conversationId);

    if (this.conversationThreadPublishDelayMs === 0) {
      this.flushPendingConversationThreads(store, projection);
      return;
    }
    if (this.conversationThreadPublishTimer) return;
    this.conversationThreadPublishTimer = setTimeout(() => {
      this.conversationThreadPublishTimer = null;
      this.flushPendingConversationThreads(store, projection);
    }, this.conversationThreadPublishDelayMs);
    this.conversationThreadPublishTimer.unref?.();
  }

  private flushPendingConversationThreads(
    expectedStore: SQLiteControlPlaneStore | null = this.store,
    expectedProjection: Pick<ConversationProjectionStore, "meta" | "snapshot"> | null = this.conversationProjection,
  ): void {
    if (this.conversationThreadPublishTimer) {
      clearTimeout(this.conversationThreadPublishTimer);
      this.conversationThreadPublishTimer = null;
    }
    const conversationIds = [...this.pendingConversationThreadIds];
    this.pendingConversationThreadIds.clear();
    if (
      conversationIds.length === 0
      || !expectedStore
      || !expectedProjection
      || expectedStore !== this.store
      || expectedProjection !== this.conversationProjection
    ) return;
    try {
      const meta = expectedProjection.meta();
      for (const conversationId of conversationIds) {
        const snapshot = expectedStore.getConversationThreadLaunchSnapshot({
          conversationId,
          projectionId: meta.projectionId,
          projectionVersion: meta.projectionVersion,
          sequence: meta.headSeq,
          limit: 64,
          nativePreview: true,
        });
        if (snapshot) this.ensureConversationThreadPublisher().publish(snapshot);
      }
    } catch (error) {
      // Like the feed artifact, retained thread pages are disposable delivery
      // caches. A failure cannot reject the durable write or invalidate SQLite.
      console.warn(`[broker] native conversation thread publish failed: ${formatError(error)}`);
    }
  }

  private clearPendingConversationThreads(): void {
    if (this.conversationThreadPublishTimer) {
      clearTimeout(this.conversationThreadPublishTimer);
      this.conversationThreadPublishTimer = null;
    }
    this.pendingConversationThreadIds.clear();
  }
}
