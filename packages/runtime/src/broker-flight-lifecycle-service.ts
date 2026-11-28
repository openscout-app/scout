import {
  DEFAULT_SUPERVISOR_DEADLINES,
  flightCompletion,
  flightLastEvidenceAt,
  flightLiveness,
  flightOwnerNodeId,
  hasExplicitCompletion,
  isDeadFlight,
  recordedFlightLiveness,
  type SupervisorDeadlines,
} from "@openscout/protocol";
import { explicitReplyMatchesFlight } from "./broker-explicit-completion.js";
import { isFinalReplyForInvocation } from "./broker-conversation-helpers.js";
import { holdBlockedFlight } from "./broker-blocked-reply.js";
import { readMessageRecord } from "./broker-message-records.js";
import { isDeepStrictEqual } from "node:util";

import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";

import type {
  DeliveryAttempt,
  DeliveryIntent,
  DeliveryStatus,
  FlightRecord,
  InvocationRequest,
  AgentDefinition,
  AgentEndpoint,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import {
  endpointCandidateState,
  endpointLifecycleAt,
  endpointStartedAt,
} from "./broker-endpoint-selection.js";
import {
  closedAsSupersededTwin,
  deadFlightCorrectionMetadata,
  isSupersededTwinCopy,
  interruptedCodexFlight,
  isTerminalFlightState,
  staleLocalEndpointReason,
  staleWorkingFlightFailure,
  supersedingTwinFlight,
} from "./broker-local-invocation-helpers.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

type FlightLifecycleRuntime = {
  snapshot(): RuntimeSnapshot;
  peek?(): Readonly<RuntimeSnapshot>;
  upsertFlight(flight: FlightRecord, options?: { preserveCurrent?: boolean }): Promise<void>;
};

type FlightLifecycleJournal = {
  getFlight?: (id: string) => FlightRecord | undefined;
  getCurrentFlightForInvocation?: (invocationId: string) => FlightRecord | undefined;
  visitDeliveries(visitor: (delivery: DeliveryIntent) => void | Promise<void>, options?: { activeOnly?: boolean }): Promise<void>;
  listDeliveryAttempts?: (deliveryId: string) => DeliveryAttempt[];
};

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ): Promise<BrokerJournalEntry[]>;
  applyProjectedEntries(entries: BrokerJournalEntry | BrokerJournalEntry[]): Promise<void>;
};

export type BrokerFlightLifecycleServiceOptions = {
  runtime: FlightLifecycleRuntime;
  journal: FlightLifecycleJournal;
  durableStore: DurableStore;
  invocationFor: (invocationId: string) => InvocationRequest | undefined;
  updateDeliveryStatus: (input: {
    deliveryId: string;
    status: DeliveryIntent["status"];
    metadata?: Record<string, unknown>;
    leaseOwner?: string | null;
    leaseExpiresAt?: number | null;
  }) => Promise<unknown>;
  updateDeliveryStatusIf: (
    input: Parameters<BrokerFlightLifecycleServiceOptions["updateDeliveryStatus"]>[0],
    eligible: (current: DeliveryIntent) => boolean | Promise<boolean>,
  ) => Promise<boolean>;
  /** Pure Ready preparation inside the flight writer (see broker-task-ready). */
  prepareTaskReady?: (previous: FlightRecord | undefined, flight: FlightRecord, invocation: InvocationRequest | undefined) => FlightRecord;
  /** After a committed flight write: rings and lands the work item when it entered Ready. */
  onFlightRecorded?: (previous: FlightRecord | undefined, flight: FlightRecord, invocation: InvocationRequest | undefined) => Promise<void>;
  /** Pure preparation inside the terminal-flight writer; application runs after commit. */
  prepareWorkPromotion?: (flight: FlightRecord, invocation: InvocationRequest | undefined, previous?: FlightRecord) => FlightRecord;
  promoteInvocationFlightToWork: (
    invocation: InvocationRequest,
    flight: FlightRecord,
    output: string | undefined,
  ) => Promise<void>;
  maybeForwardFlightToAuthority: (flight: FlightRecord) => Promise<void>;
  isInvocationActive: (invocationId: string) => boolean;
  /** When this runtime process started; see `staleWorkingFlightFailure`. */
  bootedAt?: number;
  /**
   * This node's id. A flight owned by another node is a mirror here: this
   * node's supervisor never closes it (docs/specs/flight-supervisor.md).
   */
  localNodeId?: () => string | null | undefined;
  /** Newest transcript activity per harness session id, as liveness evidence. */
  sessionActivity?: () => ReadonlyMap<string, number>;
  deadlines?: Partial<SupervisorDeadlines>;
  /** Runs inside the writer; the report intent commits with terminal truth. */
  prepareTerminalReport?: (flight: FlightRecord, invocation: InvocationRequest | undefined) => FlightRecord;
  deliverTerminalReport?: (flightId: string) => Promise<unknown>;
  /**
   * Role lifecycle (e.g. orchestrator post_ask_summary). Fire-and-forget safe;
   * failures should be warned, not thrown into flight recording.
   */
  onTerminalFlight?: (input: {
    flight: FlightRecord;
    invocation?: InvocationRequest;
    previous: FlightRecord | undefined;
  }) => void | Promise<void>;
  warn?: (message: string, detail?: unknown) => void;
  now?: () => number;
};

export function shouldIgnoreFlightUpdate(previous: FlightRecord, next: FlightRecord): boolean {
  // The session's own late finish or error replaces the supervisor's guess.
  if (isDeadFlight(previous) && !isDeadFlight(next) && (next.state === "completed" || next.state === "failed")) {
    return false;
  }
  if (isTerminalFlightState(previous.state)) {
    // An invocation has one terminal outcome. Late adapter failures, stale
    // reconciliation and cancellation cannot replace captured work. Metadata
    // enrichment may retain that outcome, but must not erase its payload/time.
    return next.state !== previous.state
      || next.output !== previous.output
      || next.error !== previous.error
      || next.completedAt !== previous.completedAt;
  }

  if (
    previous.state !== "running"
    || next.state !== "running"
    || previous.metadata?.requesterTimedOut !== true
    || next.metadata?.requesterTimedOut === true
  ) {
    return false;
  }

  // requester_wait is a monotonic annotation for one dispatch attempt. Mesh
  // retries can deliver the earlier dispatch acknowledgement after the timeout
  // record; accepting it clears the timeout and creates an A/B write loop. A
  // strictly newer acknowledgement represents a real new attempt and may clear
  // the annotation.
  return dispatchAcknowledgedAt(next) <= dispatchAcknowledgedAt(previous);
}

export function isDuplicateFlightUpdate(previous: FlightRecord, next: FlightRecord): boolean {
  return isDeepStrictEqual(previous, next);
}

function dispatchAcknowledgedAt(flight: FlightRecord): number {
  const acknowledgement = flight.metadata?.dispatchAck;
  if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)) {
    return 0;
  }
  const value = (acknowledgement as Record<string, unknown>).acknowledgedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const terminalDeliveryStatuses = new Set<DeliveryStatus>(["completed", "failed", "cancelled"]);
const staleReconcileableDeliveryStatuses = new Set<DeliveryStatus>([
  "accepted",
  "deferred",
  "leased",
  "pending",
  "running",
  "sent",
]);

export const STALE_LOCAL_DELIVERY_GRACE_MS = 2 * 60_000;

export function deliveryStatusForFlight(flight: FlightRecord): DeliveryStatus | null {
  if (flight.state === "running" || flight.state === "waiting") {
    return "running";
  }
  if (flight.state === "completed") {
    return "completed";
  }
  if (flight.state === "failed") {
    return "failed";
  }
  if (flight.state === "cancelled") {
    return "cancelled";
  }
  return null;
}

export function staleLocalDeliveryReason(
  snapshot: RuntimeSnapshot,
  delivery: DeliveryIntent,
  options: { now?: number; graceMs?: number; latestAttemptAt?: number } = {},
): string | null {
  if (delivery.metadata?.externalSession === true) return null;
  if (delivery.targetKind !== "agent" || !staleReconcileableDeliveryStatuses.has(delivery.status)) {
    return null;
  }

  const messageCreatedAt = delivery.messageId
    ? snapshot.messages[delivery.messageId]?.createdAt
    : undefined;
  const invocationCreatedAt = delivery.invocationId
    ? snapshot.invocations[delivery.invocationId]?.createdAt
    : undefined;
  const metadataCreatedAt = numericMetadataTimestamp(delivery.metadata?.createdAt);
  const firstAttemptQueuedAt = numericMetadataTimestamp(delivery.metadata?.firstAttemptQueuedAt);
  const createdAt = Math.max(
    messageCreatedAt ?? 0,
    invocationCreatedAt ?? 0,
    options.latestAttemptAt ?? 0,
    metadataCreatedAt,
    firstAttemptQueuedAt,
  );
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? STALE_LOCAL_DELIVERY_GRACE_MS;
  if (createdAt > 0 && now - createdAt < graceMs) {
    return null;
  }

  const endpoints = Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === delivery.targetId);
  if (endpoints.length === 0) {
    return null;
  }

  const unavailableEndpoints = endpoints
    .map((endpoint) => ({
      endpoint,
      reason: localEndpointUnavailableReason(endpoint),
    }));
  if (unavailableEndpoints.some((entry) => entry.reason === null)) {
    return null;
  }

  const rankedUnavailable = unavailableEndpoints
    .sort((left, right) => endpointLifecycleAt(right.endpoint) - endpointLifecycleAt(left.endpoint));
  const transportMatch = rankedUnavailable.find((entry) => entry.endpoint.transport === delivery.transport);
  return (transportMatch ?? rankedUnavailable[0] ?? null)?.reason ?? null;
}

function numericMetadataTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function localEndpointUnavailableReason(endpoint: AgentEndpoint): string | null {
  const staleReason = staleLocalEndpointReason(endpoint);
  if (staleReason) {
    return staleReason;
  }

  if (endpointCandidateState(endpoint.state) === "offline") {
    return `endpoint ${endpoint.id} is ${endpoint.state}`;
  }

  return null;
}

function redactFlightRecordSecrets(flight: FlightRecord): FlightRecord {
  const output = flight.output ? redactSecrets(flight.output) : flight.output;
  const error = flight.error ? redactSecrets(flight.error) : flight.error;
  const summary = flight.summary ? redactSecrets(flight.summary) : flight.summary;
  if (output === flight.output && error === flight.error && summary === flight.summary) {
    return flight;
  }
  return { ...flight, output, error, summary };
}

function normalizeRecordedFlight(
  flight: FlightRecord,
  invocation: InvocationRequest | undefined,
  now: number,
): FlightRecord {
  if (
    invocation?.action !== "consult"
    || flight.state !== "completed"
    || flight.output?.trim()
  ) {
    return flight;
  }

  const error = `Consult flight ${flight.id} completed without broker-visible output.`;
  return {
    ...flight,
    state: "failed",
    output: undefined,
    summary: flight.summary?.trim()
      ? `${flight.summary.trim()} No broker-visible reply was posted.`
      : "The target completed without a broker-visible reply.",
    error,
    completedAt: flight.completedAt ?? now,
    metadata: {
      ...(flight.metadata ?? {}),
      failureStage: "empty_completed_output",
      failureCause: "harness_error",
    },
  };
}
function flightSessionId(flight: FlightRecord): string | null {
  const ack = flight.metadata?.dispatchAck;
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) return flight.sessionId ?? null;
  const sessionId = (ack as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId ? sessionId : flight.sessionId ?? null;
}

export class BrokerFlightLifecycleService {
  constructor(private readonly options: BrokerFlightLifecycleServiceOptions) {}

  /** Resolves true when a record was written. */
  readonly recordFlight = async (flight: FlightRecord, eligible?: () => boolean): Promise<boolean> => {
    const invocation = this.options.invocationFor(flight.invocationId)
      ?? this.options.runtime.snapshot().invocations[flight.invocationId];
    // Single chokepoint before journal/sqlite persistence, work-item promotion,
    // and mesh forwarding: scrub registered credentials from free-text fields.
    let flightToRecord = redactFlightRecordSecrets(
      flight,
    );
    let didRecordFlight = false;
    let previousFlight: FlightRecord | undefined;
    const twinCopy = isSupersededTwinCopy(this.options.runtime.peek?.() ?? this.options.runtime.snapshot(), flightToRecord);
    await this.options.durableStore.runWrite(async () => {
      // Recheck the caller's observation after acquiring the canonical writer.
      if (eligible && !eligible()) return;
      const previous = this.options.journal.getFlight?.(flightToRecord.id) ?? this.options.runtime.snapshot().flights[flightToRecord.id];
      previousFlight = previous;
      if (previous?.metadata?.taskFinalReplyMessageId && flightToRecord.metadata?.replyMessageId !== previous.metadata.taskFinalReplyMessageId) return;
      if (previous?.metadata?.completion !== undefined && (!invocation || !hasExplicitCompletion(invocation)
        || previous.invocationId !== flightToRecord.invocationId || previous.targetAgentId !== flightToRecord.targetAgentId
        || previous.requesterId !== flightToRecord.requesterId)) {
        throw new Error("completion_flight_identity_mismatch");
      }
      // A twin copy repeats an outcome the current flight already settled
      // under the completion contract, so it skips the contract's gates.
      if (invocation && hasExplicitCompletion(invocation) && !twinCopy) {
        if (!previous) throw new Error("completion_flight_unknown");
        if (this.options.journal.getCurrentFlightForInvocation
          && this.options.journal.getCurrentFlightForInvocation(invocation.id)?.id !== flightToRecord.id) return;
        const completion = flightCompletion(previous);
        if (!completion) throw new Error("completion_state_invalid");
        // Adapter/status snapshots never own the contract revision or obligations.
        flightToRecord = { ...flightToRecord, metadata: { ...flightToRecord.metadata, completion } };
        if (flightToRecord.state === "completed" || (flightToRecord.state === "failed"
          && ["empty_reply", "empty_completed_output"].includes(String(flightToRecord.metadata?.failureStage)))) {
          const replyId = flightToRecord.metadata?.replyMessageId;
          const reply = typeof replyId === "string" ? await readMessageRecord(this.options.runtime.snapshot().messages, replyId) : undefined;
          if (!reply || !isFinalReplyForInvocation(reply, invocation)
            || !explicitReplyMatchesFlight(reply, invocation, previous, this.options.runtime.snapshot().flights, this.options.journal.getFlight?.bind(this.options.journal))) {
            if (flightToRecord.metadata?.completedByBrokerReply === true) return;
            const { resultReply: _result, failureStage: _failure, ...metadata } = flightToRecord.metadata ?? {};
            // Keep the turn's own output: if no task reply ever arrives, the
            // flight fails with it instead of losing it.
            const awaitingFinalOutput = flightToRecord.output ?? previous.metadata?.awaitingFinalOutput;
            // A repeated report of the same turn end keeps the clock it started.
            const repeatedSince = previous.state === "waiting" && completion.awaitingFinal === true
              ? previous.metadata?.awaitingFinalSince : undefined;
            const awaitingFinalSince = typeof repeatedSince === "number" ? repeatedSince : this.now();
            flightToRecord = { ...flightToRecord, state: "waiting", completedAt: undefined, output: undefined, error: undefined,
              summary: "Execution ended; awaiting an explicit final reply.",
              metadata: { ...metadata, completion: { ...completion, awaitingFinal: true }, awaitingFinalSince,
                ...(awaitingFinalOutput !== undefined ? { awaitingFinalOutput } : {}) } };
          }
        }
      }
      // A late finish for a dead flight: the report wins over the guess. A
      // writer that rebuilt the record from the dead one still carries its
      // markers, so a finish clears them here.
      const correcting = Boolean(previous && isDeadFlight(previous)
        && (flightToRecord.state === "completed" || (flightToRecord.state === "failed" && !isDeadFlight(flightToRecord))));
      if (correcting && previous) {
        const now = this.now();
        flightToRecord = {
          ...flightToRecord,
          completedAt: flightToRecord.completedAt && flightToRecord.completedAt !== previous.completedAt
            ? flightToRecord.completedAt
            : now,
          metadata: { ...flightToRecord.metadata, ...deadFlightCorrectionMetadata(now) },
        };
      }
      flightToRecord = holdBlockedFlight(previous, flightToRecord);
      flightToRecord = normalizeRecordedFlight(flightToRecord, invocation, this.now());
      // A delayed adapter/status update cannot erase an acknowledged reply
      // while its separate completion write is being recovered.
      if (previous?.metadata?.acceptedReply !== undefined) {
        flightToRecord = { ...flightToRecord, metadata: {
          ...flightToRecord.metadata, acceptedReply: previous.metadata.acceptedReply,
        } };
      }
      if (previous && isTerminalFlightState(previous.state)) {
        // Terminal enrichment must not erase/reopen a durable reply intent.
        // Only the result outbox's compare-and-write marks it delivered.
        flightToRecord = { ...flightToRecord,
          // Preserve the first report's human-readable terminal payload.
          ...(previous.metadata?.terminalReport && !correcting ? { summary: previous.summary } : {}),
          metadata: {
          ...previous.metadata, ...flightToRecord.metadata,
          ...(previous.metadata?.resultReply ? { resultReply: previous.metadata.resultReply } : {}),
          ...(previous.metadata?.terminalReport ? { terminalReport: previous.metadata.terminalReport } : {}),
        } };
      }
      if (twinCopy) {
        const { terminalReport: _report, workPromotion: _promotion, ...metadata } = flightToRecord.metadata ?? {};
        flightToRecord = { ...flightToRecord, metadata };
      } else {
        if (!previous?.metadata?.terminalReport) {
          flightToRecord = this.options.prepareTerminalReport?.(flightToRecord, invocation) ?? flightToRecord;
        }
        flightToRecord = this.options.prepareTaskReady?.(previous, flightToRecord, invocation) ?? flightToRecord;
        flightToRecord = this.options.prepareWorkPromotion?.(flightToRecord, invocation, previous) ?? flightToRecord;
      }
      if (previous && isDuplicateFlightUpdate(previous, flightToRecord)) {
        return;
      }
      if (previous && shouldIgnoreFlightUpdate(previous, flightToRecord)) {
        this.options.warn?.(
          `[openscout-runtime] ignored stale flight update ${flightToRecord.id}: ${previous.state} -> ${flightToRecord.state}`,
        );
        return;
      }

      // A twin copy never becomes the invocation's current flight: the twin
      // keeps its dispatch, pending result reply and work promotion.
      const entries = await this.options.durableStore.commitEntries(
        { kind: "flight.record", flight: flightToRecord, ...(twinCopy ? { preserveCurrent: true } : {}) },
        async () => {
          await this.options.runtime.upsertFlight(flightToRecord, twinCopy ? { preserveCurrent: true } : undefined);
        },
        { enqueueProjection: false },
      );
      await this.options.durableStore.applyProjectedEntries(entries);
      didRecordFlight = true;
    });
    if (!didRecordFlight) return false;

    // Start delivery before unrelated endpoint/work bookkeeping can fail. The
    // durable intent remains recoverable even when this process stops here.
    if (flightToRecord.metadata?.terminalReport) {
      void this.options.deliverTerminalReport?.(flightToRecord.id).catch((error) => {
        this.options.warn?.(`[openscout-runtime] terminal report pending ${flightToRecord.id}:`, error);
      });
    }
    await this.reconcileMessageDeliveriesForFlight(flightToRecord, invocation);
    if (twinCopy) return true;
    if (this.options.onFlightRecorded) {
      try {
        await this.options.onFlightRecorded(previousFlight, flightToRecord, invocation);
      } catch (error) {
        this.options.warn?.(
          `[openscout-runtime] Ready follow-up failed for flight ${flightToRecord.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (invocation && isTerminalFlightState(flightToRecord.state)) {
      try {
        await this.options.promoteInvocationFlightToWork(
          invocation,
          flightToRecord,
          flightToRecord.output ?? flightToRecord.error ?? flightToRecord.summary,
        );
      } catch (error) {
        this.options.warn?.(
          `[openscout-runtime] failed to update work item for flight ${flightToRecord.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Role lifecycle: post-ask summary when an assigned orchestrator is
    // target or requester. Only on transition into terminal (not re-writes).
    if (
      isTerminalFlightState(flightToRecord.state)
      && !isTerminalFlightState(previousFlight?.state ?? "queued")
      && this.options.onTerminalFlight
    ) {
      try {
        await this.options.onTerminalFlight({
          flight: flightToRecord,
          invocation,
          previous: previousFlight,
        });
      } catch (error) {
        this.options.warn?.(
          `[openscout-runtime] role lifecycle failed for flight ${flightToRecord.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    try {
      await this.options.maybeForwardFlightToAuthority(flightToRecord);
    } catch (error) {
      this.options.warn?.(
        `[openscout-runtime] failed to forward flight ${flightToRecord.id} to conversation authority:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (isTerminalFlightState(flightToRecord.state) && !isTerminalFlightState(previousFlight?.state ?? "queued")) {
      await this.closeSupersededTwins(flightToRecord, invocation);
    }
    return true;
  };

  readonly reconcileStaleLocalDeliveries = async (): Promise<void> => {
    const now = this.now();
    let snapshot: RuntimeSnapshot | undefined;
    let messageFreeSnapshot: RuntimeSnapshot | undefined;

    await this.options.journal.visitDeliveries(async (delivery) => {
      // Terminal/non-agent records cannot reconcile; avoid a full registry copy
      // on every incoming message when the scan contains no eligible records.
      if (delivery.targetKind !== "agent" || !staleReconcileableDeliveryStatuses.has(delivery.status)) return;
      snapshot ??= this.options.runtime.peek?.() ?? this.options.runtime.snapshot();
      const latestAttemptAt = this.options.journal
        .listDeliveryAttempts?.(delivery.id)
        .at(-1)?.createdAt;
      // Message age can only make a candidate younger. If other timestamps or
      // the endpoint state already rule out reconciliation, avoid opening a
      // cold history view for every active delivery on every accepted message.
      messageFreeSnapshot ??= { ...snapshot, messages: {} };
      if (!staleLocalDeliveryReason(messageFreeSnapshot, delivery, { now, latestAttemptAt })) return;
      const message = delivery.messageId
        ? await readMessageRecord(snapshot.messages, delivery.messageId) : undefined;
      const reason = staleLocalDeliveryReason({
        ...snapshot, messages: message ? { [message.id]: message } : {},
      }, delivery, { now, latestAttemptAt });
      if (!reason) {
        return;
      }

      const changed = await this.options.updateDeliveryStatusIf({
        deliveryId: delivery.id,
        status: "failed",
        metadata: {
          failureReason: "agent_offline",
          failureDetail: `Stale local delivery reconciled: ${reason}`,
          staleLocalRegistration: true,
          reconciledStaleDelivery: true,
          reconciledReason: reason,
          reconciledAt: now,
        },
        leaseOwner: null,
        leaseExpiresAt: null,
      }, (current) => current === delivery
        // Journal records are replaced, never mutated: rechecking identity under
        // the writer rejects claims/completions that raced the stale read.
        && !(current.leaseOwner && typeof current.leaseExpiresAt === "number"
          && current.leaseExpiresAt > this.now()));
      if (changed) this.options.warn?.(`[openscout-runtime] reconciled stale local delivery ${delivery.id}: ${reason}`);
    }, { activeOnly: true });
  };

  /** Closes open flights that this newly finished flight took over. */
  private async closeSupersededTwins(twin: FlightRecord, invocation: InvocationRequest | undefined): Promise<void> {
    // Operator-owned tasks settle through their own answer path.
    if (invocation?.metadata?.humanOwned === true) return;
    const snapshot = this.options.runtime.peek?.() ?? this.options.runtime.snapshot();
    const open = Object.values(snapshot.flights).filter((flight) => (
      flight.id !== twin.id
      && flight.invocationId === twin.invocationId
      && supersedingTwinFlight(snapshot, flight)?.id === twin.id
    ));
    if (open.length === 0 || this.options.isInvocationActive(twin.invocationId)) return;
    for (const flight of open) {
      try {
        await this.recordFlight(closedAsSupersededTwin(flight, twin, this.now()));
      } catch (error) {
        this.options.warn?.(
          `[openscout-runtime] failed to close flight ${flight.id} superseded by ${twin.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private supervising: Promise<void> | null = null;

  /**
   * The flight supervisor's tick (docs/specs/flight-supervisor.md). It runs on
   * a timer, at startup and after local agent sync. Runs never overlap: a
   * caller during a tick waits for that tick.
   */
  readonly superviseFlights = (): Promise<void> => {
    if (this.supervising) return this.supervising;
    this.supervising = this.superviseOnce().finally(() => {
      this.supervising = null;
    });
    return this.supervising;
  };

  /** Former name of {@link superviseFlights}. */
  readonly reconcileStaleWorkingFlights = (): Promise<void> => this.superviseFlights();

  /** True when another node owns this flight, so this node holds a mirror. */
  isMirroredFlight(flight: FlightRecord): boolean {
    const owner = flightOwnerNodeId(flight);
    const local = this.options.localNodeId?.()?.trim();
    return Boolean(owner && local && owner !== local);
  }

  private deadlines(): SupervisorDeadlines {
    return { ...DEFAULT_SUPERVISOR_DEADLINES, ...(this.options.deadlines ?? {}) };
  }

  private async superviseOnce(): Promise<void> {
    const snapshot = this.options.runtime.snapshot();
    const now = this.now();
    const deadlines = this.deadlines();
    let activity: ReadonlyMap<string, number> | null = null;

    for (const flight of Object.values(snapshot.flights)) {
      if (snapshot.invocations[flight.invocationId]?.metadata?.humanOwned === true) continue;
      if (isTerminalFlightState(flight.state)) continue;
      if (this.isMirroredFlight(flight)) continue;
      const twin = supersedingTwinFlight(snapshot, flight);
      if (twin && !this.options.isInvocationActive(flight.invocationId)) {
        if (await this.recordFlight(closedAsSupersededTwin(flight, twin, now))) {
          this.options.warn?.(`[openscout-runtime] closed flight ${flight.id}: superseded by ${twin.state} flight ${twin.id}`);
        }
        continue;
      }
      const interrupted = interruptedCodexFlight(flight, this.options.bootedAt);
      if (interrupted && !this.options.isInvocationActive(flight.invocationId)) {
        await this.recordFlight(interrupted, () => {
          const current = this.options.journal.getFlight?.(flight.id)
            ?? this.options.runtime.snapshot().flights[flight.id];
          return !this.options.isInvocationActive(flight.invocationId) && isDeepStrictEqual(current, flight);
        });
        continue;
      }
      const failure = staleWorkingFlightFailure(snapshot, flight, {
        isInvocationActive: this.options.isInvocationActive,
        now,
        bootedAt: this.options.bootedAt,
      });
      if (failure) {
        await this.declareDead(flight, failure, now);
        continue;
      }
      if (flight.state !== "running") continue;

      activity ??= this.options.sessionActivity?.() ?? new Map();
      const sessionId = flightSessionId(flight);
      const observedAt = sessionId ? activity.get(sessionId) ?? 0 : 0;
      const lastEvidenceAt = Math.max(flightLastEvidenceAt(flight), observedAt);
      if (deadlines.deadAfterMs !== null && lastEvidenceAt > 0 && now - lastEvidenceAt >= deadlines.deadAfterMs
        && !this.options.isInvocationActive(flight.invocationId)) {
        await this.declareDead(flight, {
          cause: "no_progress",
          detail: `no progress for ${Math.floor((now - lastEvidenceAt) / 60_000)} min`,
        }, now);
        continue;
      }
      const liveness = flightLiveness({ lastEvidenceAt, now, deadlines });
      if (liveness === recordedFlightLiveness(flight)) continue;
      // Only a change of level is written, so a quiet flight costs one write
      // per level, not one per tick.
      await this.recordFlight({
        ...flight,
        metadata: { ...(flight.metadata ?? {}), liveness, lastEvidenceAt },
      }, () => {
        const current = this.options.journal.getFlight?.(flight.id)
          ?? this.options.runtime.snapshot().flights[flight.id];
        return current?.state === "running" && recordedFlightLiveness(current) !== liveness;
      });
    }
  }

  private async declareDead(
    flight: FlightRecord,
    failure: { cause: string; detail: string; movedOnToFlightId?: string },
    now: number,
  ): Promise<void> {
    const snapshot = this.options.runtime.snapshot();
    const agent = snapshot.agents[flight.targetAgentId] as AgentDefinition | undefined;
    const unrepliedOutput = flight.metadata?.awaitingFinalOutput;
    const local = this.options.localNodeId?.()?.trim();
    const deadFlight: FlightRecord = {
      ...flight,
      ...(typeof unrepliedOutput === "string" && unrepliedOutput ? { output: unrepliedOutput } : {}),
      // On the wire a dead flight is `failed` with outcome "dead", so peers
      // that know only the seven states still treat it as terminal.
      state: "failed",
      summary: `${agent?.displayName ?? flight.targetAgentId} didn't finish.`,
      error: `Didn't finish: ${failure.detail}`,
      // Kept for storage and older readers. `flightFinishedAt` never reads
      // it for a dead flight.
      completedAt: now,
      metadata: {
        ...(flight.metadata ?? {}),
        outcome: "dead",
        deathCause: failure.cause,
        declaredDeadAt: now,
        liveness: "stalled",
        ...(failure.movedOnToFlightId ? { movedOnToFlightId: failure.movedOnToFlightId } : {}),
        ...(local ? { supervisor: { nodeId: flightOwnerNodeId(flight) ?? local } } : {}),
        reconciledReason: failure.detail,
        reconciledAt: now,
      },
    };
    await this.recordFlight(deadFlight);
    this.options.warn?.(`[openscout-runtime] flight ${flight.id} didn't finish (${failure.cause}): ${failure.detail}`);
  }

  private async reconcileMessageDeliveriesForFlight(
    flight: FlightRecord,
    invocation: InvocationRequest | undefined,
  ): Promise<void> {
    const status = deliveryStatusForFlight(flight);
    if (!status || !invocation?.messageId) {
      return;
    }

    const updatedAt = flight.completedAt ?? this.now();
    await this.options.journal.visitDeliveries(async (delivery) => {
      // External receipts report provider evidence, not local flight projections.
      if (delivery.metadata?.externalSession === true) return;
      if (!(delivery.messageId === invocation.messageId
        && delivery.targetId === flight.targetAgentId
        && delivery.status !== status
        && (
          !terminalDeliveryStatuses.has(delivery.status)
          || (
            delivery.status === "failed"
            && delivery.metadata?.reconciledStaleDelivery === true
            && (status === "running" || status === "completed")
          )
        )
      )) return;
      const recoveringFalseStaleFailure = delivery.status === "failed"
        && delivery.metadata?.reconciledStaleDelivery === true
        && (status === "running" || status === "completed");
      await this.options.updateDeliveryStatus({
        deliveryId: delivery.id,
        status,
        metadata: {
          invocationId: flight.invocationId,
          flightId: flight.id,
          flightState: flight.state,
          flightStatusUpdatedAt: updatedAt,
          ...(recoveringFalseStaleFailure ? {
            failureReason: null,
            failureDetail: null,
            recoveredFromStaleReconciliation: true,
            recoveredAt: updatedAt,
          } : {}),
          ...(flight.error ? { failureDetail: flight.error } : {}),
        },
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
