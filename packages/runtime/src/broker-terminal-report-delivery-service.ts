import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";
import type { FlightRecord, MessageRecord, InvocationRequest, ConversationDefinition } from "@openscout/protocol";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { messageVisibilityForConversation } from "./broker-conversation-helpers.js";
import { shouldNotifyInvocationRequester } from "./broker-local-invocation-helpers.js";
import type { QuarantineMetadata } from "./broker-quarantine.js";

/** Saved atomically with terminal output; delivery never invokes an executor. */
export type TerminalReportIntent = {
  version: 1;
  status: "pending" | "delivered";
  message: MessageRecord;
  deliveredAt?: number;
};

/** The request origin owns terminal reporting, including remotely executed work. */
export function prepareTerminalReport(flight: FlightRecord, invocation: InvocationRequest | undefined, context: {
  nodeId: string;
  systemActorId: string;
  conversation: (id: string) => ConversationDefinition | undefined;
  now: () => number;
}): FlightRecord {
  if ((flight.state !== "failed" && flight.state !== "cancelled") || !invocation?.conversationId
    || invocation.requesterNodeId !== context.nodeId) return flight;
  const conversation = context.conversation(invocation.conversationId);
  if (!conversation) return flight;
  const terminal = { ...flight, completedAt: flight.completedAt ?? context.now() };
  return { ...terminal, metadata: { ...terminal.metadata, terminalReport: createTerminalReportIntent(terminal, {
    id: "pending", conversationId: invocation.conversationId, actorId: context.systemActorId, originNodeId: context.nodeId,
    class: "status", body: "", replyToMessageId: invocation.messageId,
    audience: shouldNotifyInvocationRequester(invocation) ? { notify: [invocation.requesterId] } : { delivery: "none" },
    visibility: messageVisibilityForConversation(conversation), policy: "durable", createdAt: terminal.completedAt,
    metadata: { source: "broker", targetAgentId: invocation.targetAgentId },
  }) } };
}

export function terminalReportMessageId(flightId: string, outcome: "failed" | "cancelled"): string {
  return `flight-report-${createHash("sha256").update(`${flightId}:${outcome}`).digest("hex").slice(0, 32)}`;
}

export function terminalReportBody(flight: FlightRecord): string {
  return redactSecrets([flight.summary, flight.error].filter((value) => value?.trim()).join("\n")
    || `Flight ${flight.id} ${flight.state}.`);
}

export function createTerminalReportIntent(flight: FlightRecord, message: MessageRecord): TerminalReportIntent {
  if (flight.state !== "failed" && flight.state !== "cancelled") throw new Error("terminal_report_outcome_invalid");
  const id = terminalReportMessageId(flight.id, flight.state);
  return { version: 1, status: "pending", message: {
    ...message, id, body: terminalReportBody(flight), createdAt: flight.completedAt!,
    metadata: { ...message.metadata, invocationId: flight.invocationId, flightId: flight.id,
      outcome: flight.state, clientMessageId: id },
  } };
}

/** Separate from successful result validation: failure reports cannot complete work. */
export function pendingTerminalReport(flight: FlightRecord | undefined): TerminalReportIntent | null {
  if (flight?.state !== "failed" && flight?.state !== "cancelled") return null;
  const intent = flight.metadata?.terminalReport as TerminalReportIntent | undefined;
  if (!intent || intent.version !== 1 || intent.status !== "pending") return null;
  const message = intent.message;
  if (!message || message.id !== terminalReportMessageId(flight.id, flight.state)
    || message.metadata?.clientMessageId !== message.id
    || message.metadata?.invocationId !== flight.invocationId
    || message.metadata?.flightId !== flight.id || message.metadata?.outcome !== flight.state
    || message.body !== terminalReportBody(flight)
    || typeof message.actorId !== "string" || !message.actorId
    || typeof message.conversationId !== "string" || !message.conversationId
    || typeof message.originNodeId !== "string" || !message.originNodeId
    || !Number.isFinite(message.createdAt) || message.createdAt !== flight.completedAt
    || message.class !== "status" || message.policy !== "durable") return null;
  return intent;
}

export function matchesPendingTerminalReport(
  flight: FlightRecord | undefined,
  expected: TerminalReportIntent,
): boolean {
  return isDeepStrictEqual(pendingTerminalReport(flight), expected);
}

export type TerminalReportDeliveryOutcome = "delivered" | "deferred" | "stale" | "failed" | "quarantined";

export type BrokerTerminalReportDeliveryServiceOptions = {
  /** Must synchronously return the latest durable state at the post boundary. */
  flightById: (flightId: string) => FlightRecord | undefined;
  /** Only the originating broker delivers its locally created report. */
  nodeId: string;
  /** Must accept identical retries of the intent's deterministic message ID. */
  postMessage: (message: MessageRecord) => Promise<unknown>;
  /** Compare the current pending intent with expected inside the durable writer. */
  markDelivered: (flightId: string, expected: TerminalReportIntent) => Promise<boolean>;
  /** Preserve complete malformed intent evidence; acknowledgement never retries an executor. */
  quarantineRecord?: (entry: BrokerJournalEntry, reason: string) => QuarantineMetadata | Promise<QuarantineMetadata>;
  maxPending?: number;
  concurrency?: number;
  warn?: (message: string, error: unknown) => void;
};

type PendingReport = {
  promise: Promise<TerminalReportDeliveryOutcome>;
  resolve: (outcome: TerminalReportDeliveryOutcome) => void;
};

export class BrokerTerminalReportDeliveryService {
  readonly #pending = new Map<string, PendingReport>();
  readonly #queue: string[] = [];
  // Runtime records are immutable replacements. Weak membership neither keeps
  // old report bodies alive nor repeats full evidence fsync on every sweep.
  readonly #quarantined = new WeakSet<FlightRecord>();
  readonly #maxPending: number;
  readonly #concurrency: number;
  #active = 0;

  constructor(private readonly options: BrokerTerminalReportDeliveryServiceOptions) {
    this.#maxPending = positiveInteger(options.maxPending, 256);
    this.#concurrency = Math.min(this.#maxPending, positiveInteger(options.concurrency, 4));
  }

  get pendingCount(): number { return this.#pending.size; }
  get availableCapacity(): number { return this.#maxPending - this.#pending.size; }

  deliver(flightId: string): Promise<TerminalReportDeliveryOutcome> {
    const existing = this.#pending.get(flightId);
    if (existing) return existing.promise;
    if (this.availableCapacity === 0) return Promise.resolve("deferred");
    let resolve!: PendingReport["resolve"];
    const promise = new Promise<TerminalReportDeliveryOutcome>((complete) => { resolve = complete; });
    // Keep only IDs and completion promises in memory, never report bodies.
    this.#pending.set(flightId, { promise, resolve });
    this.#queue.push(flightId);
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
      if (!hasPendingTerminalReport(flight) || this.#pending.has(flight.id)) continue;
      void this.deliver(flight.id);
      scheduled += 1;
    }
    return { scanned, scheduled, atCapacity: this.availableCapacity === 0 };
  }

  private pump(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const flightId = this.#queue.shift()!;
      const pending = this.#pending.get(flightId)!;
      this.#active += 1;
      void this.attempt(flightId).then((outcome) => {
        this.#active -= 1;
        this.#pending.delete(flightId);
        pending.resolve(outcome);
        this.pump();
      });
    }
  }

  private async attempt(flightId: string): Promise<TerminalReportDeliveryOutcome> {
    try {
      // No await separates this state check from the external posting call.
      const flight = this.options.flightById(flightId);
      const intent = pendingTerminalReport(flight);
      if (!intent) {
        if (!flight || !hasPendingTerminalReport(flight)) return "stale";
        if (this.#quarantined.has(flight)) return "quarantined";
        const reason = "Pending terminal report does not match its terminal flight or supported intent schema; automatic delivery is held for this record.";
        if (!this.options.quarantineRecord) {
          this.options.warn?.(`[openscout-runtime] malformed terminal report ${flightId} remains pending:`, new Error(reason));
          return "stale";
        }
        await this.options.quarantineRecord({ kind: "flight.record", flight }, reason);
        this.#quarantined.add(flight);
        // Keep the original pending intent intact. Repair may later replace it
        // with valid evidence, but acknowledging a warning does not deliver it.
        return "quarantined";
      }
      if (intent.message.originNodeId !== this.options.nodeId) return "stale";
      await this.options.postMessage(intent.message);
      return await this.options.markDelivered(flightId, intent) ? "delivered" : "stale";
    } catch (error) {
      // Both post failure and a crash/failure before acknowledgement leave the
      // durable intent pending. A later recovery pass retries the same message.
      this.options.warn?.(`[openscout-runtime] terminal report ${flightId} remains pending:`, error);
      return "failed";
    }
  }
}

function hasPendingTerminalReport(flight: FlightRecord): boolean {
  const intent = flight.metadata?.terminalReport;
  return (flight.state === "failed" || flight.state === "cancelled") && Boolean(intent && typeof intent === "object"
    && !Array.isArray(intent) && (intent as { status?: unknown }).status === "pending");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value) : fallback;
}
