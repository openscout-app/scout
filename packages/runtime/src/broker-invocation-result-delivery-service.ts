import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";
import { TaskClosedError, type TaskClosedRefusal, type FlightRecord, type MessageRecord } from "@openscout/protocol";
import type { BrokerJournalEntry } from "./broker-journal.js";
import type { QuarantineMetadata } from "./broker-quarantine.js";

/** Saved atomically with terminal output; delivery never invokes an executor. */
export type InvocationResultReplyIntent = {
  version: 1;
  status: "pending" | "delivered" | "superseded";
  supersededAt?: number;
  refusal?: TaskClosedRefusal;
  message: MessageRecord;
  deliveredAt?: number;
};

export function invocationResultMessageId(invocationId: string): string {
  return `invocation-result-${createHash("sha256").update(invocationId).digest("hex").slice(0, 32)}`;
}

export function createInvocationResultReplyIntent(
  invocationId: string,
  message: MessageRecord,
): InvocationResultReplyIntent {
  const id = invocationResultMessageId(invocationId);
  return {
    version: 1,
    status: "pending",
    message: {
      ...message,
      id,
      body: redactSecrets(message.body),
      metadata: { ...message.metadata, invocationId, clientMessageId: id },
    },
  };
}

/** Fail closed on a stale, malformed, or unrelated intent. */
export function pendingInvocationResultReply(flight: FlightRecord | undefined): InvocationResultReplyIntent | null {
  if (flight?.state !== "completed") return null;
  const intent = flight.metadata?.resultReply as InvocationResultReplyIntent | undefined;
  if (!intent || intent.version !== 1 || intent.status !== "pending") return null;
  const message = intent.message;
  if (!message || message.id !== invocationResultMessageId(flight.invocationId)
    || message.metadata?.clientMessageId !== message.id
    || message.metadata?.invocationId !== flight.invocationId
    || message.metadata?.flightId !== flight.id
    || message.actorId !== flight.targetAgentId
    || message.body !== flight.output
    || typeof message.conversationId !== "string" || !message.conversationId
    || typeof message.originNodeId !== "string" || !message.originNodeId
    || !Number.isFinite(message.createdAt) || message.createdAt !== flight.completedAt
    || message.class !== "agent" || message.policy !== "durable") return null;
  return intent;
}

export function matchesPendingInvocationResultReply(
  flight: FlightRecord | undefined,
  expected: InvocationResultReplyIntent,
): boolean {
  return isDeepStrictEqual(pendingInvocationResultReply(flight), expected);
}

export type InvocationResultDeliveryOutcome = "delivered" | "deferred" | "stale" | "failed" | "quarantined" | "superseded";

export type BrokerInvocationResultDeliveryServiceOptions = {
  /** Must synchronously return the latest durable state at the post boundary. */
  flightForInvocation: (invocationId: string) => FlightRecord | undefined;
  /** Must accept identical retries of the intent's deterministic message ID. */
  postMessage: (message: MessageRecord) => Promise<unknown>;
  /** Compare the current pending intent with expected inside the durable writer. */
  markDelivered: (invocationId: string, expected: InvocationResultReplyIntent) => Promise<boolean>;
  markSuperseded?: (invocationId: string, expected: InvocationResultReplyIntent, refusal: TaskClosedRefusal) => Promise<boolean>;
  /** Preserve complete malformed intent evidence; acknowledgement never retries an executor. */
  quarantineRecord?: (entry: BrokerJournalEntry, reason: string) => QuarantineMetadata | Promise<QuarantineMetadata>;
  maxPending?: number;
  concurrency?: number;
  warn?: (message: string, error: unknown) => void;
};

type PendingResult = {
  promise: Promise<InvocationResultDeliveryOutcome>;
  resolve: (outcome: InvocationResultDeliveryOutcome) => void;
};

export class BrokerInvocationResultDeliveryService {
  readonly #pending = new Map<string, PendingResult>();
  readonly #queue: string[] = [];
  // Runtime records are immutable replacements. Weak membership neither keeps
  // old result bodies alive nor repeats full evidence fsync on every sweep.
  readonly #quarantined = new WeakSet<FlightRecord>();
  readonly #maxPending: number;
  readonly #concurrency: number;
  #active = 0;

  constructor(private readonly options: BrokerInvocationResultDeliveryServiceOptions) {
    this.#maxPending = positiveInteger(options.maxPending, 256);
    this.#concurrency = Math.min(this.#maxPending, positiveInteger(options.concurrency, 4));
  }

  get pendingCount(): number { return this.#pending.size; }
  get availableCapacity(): number { return this.#maxPending - this.#pending.size; }

  deliver(invocationId: string): Promise<InvocationResultDeliveryOutcome> {
    const existing = this.#pending.get(invocationId);
    if (existing) return existing.promise;
    if (this.availableCapacity === 0) return Promise.resolve("deferred");
    let resolve!: PendingResult["resolve"];
    const promise = new Promise<InvocationResultDeliveryOutcome>((complete) => { resolve = complete; });
    // Keep only IDs and completion promises in memory, never result bodies.
    this.#pending.set(invocationId, { promise, resolve });
    this.#queue.push(invocationId);
    queueMicrotask(() => this.pump());
    return promise;
  }

  /** Caller supplies a bounded durable page and advances its own scan cursor. */
  recover(flights: Iterable<FlightRecord>, maxScanned = 256): { scanned: number; scheduled: number; atCapacity: boolean } {
    let scanned = 0;
    let scheduled = 0;
    const limit = positiveInteger(maxScanned, 256);
    for (const flight of flights) {
      if (scanned >= limit || this.availableCapacity === 0) break;
      scanned += 1;
      if (!hasPendingResultReply(flight) || this.#pending.has(flight.invocationId)) continue;
      void this.deliver(flight.invocationId);
      scheduled += 1;
    }
    return { scanned, scheduled, atCapacity: this.availableCapacity === 0 };
  }

  private pump(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const invocationId = this.#queue.shift()!;
      const pending = this.#pending.get(invocationId)!;
      this.#active += 1;
      void this.attempt(invocationId).then((outcome) => {
        this.#active -= 1;
        this.#pending.delete(invocationId);
        pending.resolve(outcome);
        this.pump();
      });
    }
  }

  private async attempt(invocationId: string): Promise<InvocationResultDeliveryOutcome> {
    try {
      // No await separates this state check from the external posting call.
      const flight = this.options.flightForInvocation(invocationId);
      const intent = pendingInvocationResultReply(flight);
      if (!intent) {
        if (!flight || !hasPendingResultReply(flight)) return "stale";
        if (this.#quarantined.has(flight)) return "quarantined";
        const reason = "Pending result reply does not match its completed flight or supported intent schema; automatic delivery is held for this record.";
        if (!this.options.quarantineRecord) {
          this.options.warn?.(`[openscout-runtime] malformed result reply ${invocationId} remains pending:`, new Error(reason));
          return "stale";
        }
        await this.options.quarantineRecord({ kind: "flight.record", flight }, reason);
        this.#quarantined.add(flight);
        // Keep the original pending intent intact. Repair may later replace it
        // with valid evidence, but acknowledging a warning does not deliver it.
        return "quarantined";
      }
      try { await this.options.postMessage(intent.message); }
      catch (error) {
        // Only a typed, exactly correlated authority refusal can retire output.
        // Generic HTTP errors and text (even "already completed") stay retryable.
        if (!(error instanceof TaskClosedError) || error.refusal.taskId !== invocationId
          || error.refusal.flightId !== flight!.id || error.refusal.messageId !== intent.message.id
          || !this.options.markSuperseded) throw error;
        return await this.options.markSuperseded(invocationId, intent, error.refusal) ? "superseded" : "stale";
      }
      return await this.options.markDelivered(invocationId, intent) ? "delivered" : "stale";
    } catch (error) {
      // Both post failure and a crash/failure before acknowledgement leave the
      // durable intent pending. A later recovery pass retries the same message.
      this.options.warn?.(`[openscout-runtime] result reply ${invocationId} remains pending:`, error);
      return "failed";
    }
  }
}

function hasPendingResultReply(flight: FlightRecord): boolean {
  const intent = flight.metadata?.resultReply;
  return flight.state === "completed" && Boolean(intent && typeof intent === "object"
    && !Array.isArray(intent) && (intent as { status?: unknown }).status === "pending");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value) : fallback;
}
