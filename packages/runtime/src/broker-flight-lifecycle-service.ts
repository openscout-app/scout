import { flightCompletion, hasExplicitCompletion } from "@openscout/protocol";
import { explicitReplyMatchesFlight } from "./broker-explicit-completion.js";
import { isFinalReplyForInvocation } from "./broker-conversation-helpers.js";
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
  isTerminalFlightState,
  staleLocalEndpointReason,
  staleWorkingFlightReason,
} from "./broker-local-invocation-helpers.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

type FlightLifecycleRuntime = {
  snapshot(): RuntimeSnapshot;
  peek?(): Readonly<RuntimeSnapshot>;
  upsertFlight(flight: FlightRecord): Promise<void>;
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
  /** Pure preparation inside the terminal-flight writer; application runs after commit. */
  prepareWorkPromotion?: (flight: FlightRecord, invocation: InvocationRequest | undefined, previous?: FlightRecord) => FlightRecord;
  promoteInvocationFlightToWork: (
    invocation: InvocationRequest,
    flight: FlightRecord,
    output: string | undefined,
  ) => Promise<void>;
  maybeForwardFlightToAuthority: (flight: FlightRecord) => Promise<void>;
  isInvocationActive: (invocationId: string) => boolean;
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
    },
  };
}
export class BrokerFlightLifecycleService {
  constructor(private readonly options: BrokerFlightLifecycleServiceOptions) {}

  readonly recordFlight = async (flight: FlightRecord, eligible?: () => boolean): Promise<void> => {
    const invocation = this.options.invocationFor(flight.invocationId)
      ?? this.options.runtime.snapshot().invocations[flight.invocationId];
    // Single chokepoint before journal/sqlite persistence, work-item promotion,
    // and mesh forwarding: scrub registered credentials from free-text fields.
    let flightToRecord = redactFlightRecordSecrets(
      flight,
    );
    let didRecordFlight = false;
    let previousFlight: FlightRecord | undefined;
    await this.options.durableStore.runWrite(async () => {
      // Recheck the caller's observation after acquiring the canonical writer.
      if (eligible && !eligible()) return;
      const previous = this.options.journal.getFlight?.(flightToRecord.id) ?? this.options.runtime.snapshot().flights[flightToRecord.id];
      previousFlight = previous;
      if (previous?.metadata?.completion !== undefined && (!invocation || !hasExplicitCompletion(invocation)
        || previous.invocationId !== flightToRecord.invocationId || previous.targetAgentId !== flightToRecord.targetAgentId
        || previous.requesterId !== flightToRecord.requesterId)) {
        throw new Error("completion_flight_identity_mismatch");
      }
      if (invocation && hasExplicitCompletion(invocation)) {
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
            flightToRecord = { ...flightToRecord, state: "waiting", completedAt: undefined, output: undefined, error: undefined,
              summary: "Execution ended; awaiting an explicit final reply.",
              metadata: { ...metadata, completion: { ...completion, awaitingFinal: true } } };
          }
        }
      }
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
          ...(previous.metadata?.terminalReport ? { summary: previous.summary } : {}),
          metadata: {
          ...previous.metadata, ...flightToRecord.metadata,
          ...(previous.metadata?.resultReply ? { resultReply: previous.metadata.resultReply } : {}),
          ...(previous.metadata?.terminalReport ? { terminalReport: previous.metadata.terminalReport } : {}),
        } };
      }
      if (!previous?.metadata?.terminalReport) {
        flightToRecord = this.options.prepareTerminalReport?.(flightToRecord, invocation) ?? flightToRecord;
      }
      flightToRecord = this.options.prepareWorkPromotion?.(flightToRecord, invocation, previous) ?? flightToRecord;
      if (previous && isDuplicateFlightUpdate(previous, flightToRecord)) {
        return;
      }
      if (previous && shouldIgnoreFlightUpdate(previous, flightToRecord)) {
        this.options.warn?.(
          `[openscout-runtime] ignored stale flight update ${flightToRecord.id}: ${previous.state} -> ${flightToRecord.state}`,
        );
        return;
      }

      const entries = await this.options.durableStore.commitEntries(
        { kind: "flight.record", flight: flightToRecord },
        async () => {
          await this.options.runtime.upsertFlight(flightToRecord);
        },
        { enqueueProjection: false },
      );
      await this.options.durableStore.applyProjectedEntries(entries);
      didRecordFlight = true;
    });
    if (!didRecordFlight) return;

    // Start delivery before unrelated endpoint/work bookkeeping can fail. The
    // durable intent remains recoverable even when this process stops here.
    if (flightToRecord.metadata?.terminalReport) {
      void this.options.deliverTerminalReport?.(flightToRecord.id).catch((error) => {
        this.options.warn?.(`[openscout-runtime] terminal report pending ${flightToRecord.id}:`, error);
      });
    }
    await this.reconcileMessageDeliveriesForFlight(flightToRecord, invocation);
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

  readonly reconcileStaleWorkingFlights = async (): Promise<void> => {
    const snapshot = this.options.runtime.snapshot();
    const now = this.now();

    for (const flight of Object.values(snapshot.flights)) {
      const reason = staleWorkingFlightReason(snapshot, flight, {
        isInvocationActive: this.options.isInvocationActive,
        now,
      });
      if (!reason) {
        continue;
      }

      const agent = snapshot.agents[flight.targetAgentId] as AgentDefinition | undefined;
      const reconciledFlight: FlightRecord = {
        ...flight,
        state: "failed",
        summary: `${agent?.displayName ?? flight.targetAgentId} did not finish cleanly.`,
        error: `Stale running flight reconciled: ${reason}`,
        completedAt: now,
        metadata: {
          ...(flight.metadata ?? {}),
          reconciledStaleFlight: true,
          reconciledReason: reason,
          reconciledAt: now,
        },
      };
      await this.recordFlight(reconciledFlight);
      this.options.warn?.(`[openscout-runtime] reconciled stale running flight ${flight.id}: ${reason}`);
    }
  };

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
