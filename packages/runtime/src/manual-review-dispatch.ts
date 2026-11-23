/**
 * Dispatch of a manual review occurrence.
 *
 * A recorded occurrence starts at most one ask. A dispatch request names one
 * explicit target. The first one admitted pins that target, the ask's request
 * ID and the principal the ask is sent as to the occurrence, in one journaled
 * write, before anything is delivered. A later request with another target is
 * refused.
 *
 * The ask is an ordinary Scout task ask through the delivery acceptance path.
 * That path owns the guarantee that one request ID starts one ask: its
 * receipt ledger reserves the request before any effect and replays the first
 * outcome afterwards, and the message, invocation and work item IDs follow
 * from the request ID. This service adds no second ledger. It fixes the
 * request ID at admission, rebuilds the same request from the pins on every
 * attempt, and stores the accepted ask's ticket on the occurrence.
 *
 * The runtime carries the pinned references to the target and reads none of
 * them. The review itself runs in the target's own harness.
 *
 * Limits:
 *
 * - An ask that stopped after its receipt was reserved and before it was
 *   accepted stays unknown. The ledger holds no evidence either way and never
 *   runs a reserved request again, so neither does this service. The caller
 *   gets `manual_review_dispatch_unknown`, and a new occurrence is the way to
 *   review again. An ask that was accepted before the stop is recovered, and
 *   its original ticket is returned.
 * - A refusal by the ask path is final for the occurrence, also when the
 *   target was only unavailable for a while. The receipt replays the first
 *   answer for a request ID, so the same occurrence cannot ask again.
 * - The ask is sent as the principal whose request was admitted. A retry by
 *   another local principal returns the same ticket and changes nothing.
 * - A target is an agent, a session, or a fresh session in a project on this
 *   machine. There is no other machine, model or effort choice here.
 * - Nothing watches the ask. The ticket is how a caller follows it, and the
 *   occurrence records that it was accepted, not how the review ended.
 */
import {
  MANUAL_REVIEW_ACTION_KIND,
  MANUAL_REVIEW_ASK_VERSION,
  MANUAL_REVIEW_METADATA_KEY,
  MANUAL_REVIEW_WORK_LABEL,
  manualReviewOccurrenceOf,
  manualReviewTargetDifferences,
  validateManualReviewDispatchRequest,
  type DurableAction,
  type ManualReviewDispatch,
  type ManualReviewDispatchConflict,
  type ManualReviewDispatchRefusal,
  type ManualReviewDispatchRequest,
  type ManualReviewDispatchResponse,
  type ManualReviewOccurrence,
  type ManualReviewOccurrenceState,
  type ManualReviewStoredOccurrence,
  type ManualReviewWorkTicket,
  type ScoutAttribution,
  type ScoutDeliverRequest,
  type ScoutDeliverResponse,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { manualReviewOccurrenceId } from "./manual-review-occurrences.js";

export type ManualReviewDispatchServiceDeps = {
  /** The node that holds the occurrence and sends the ask. */
  authorityCellId: string;
  /** The writer the recording service uses, so admission and recording are serialized together. */
  runDurableWrite: <T>(work: () => Promise<T>) => Promise<T>;
  commitEntries: (
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ) => Promise<BrokerJournalEntry[]>;
  getDurableAction: (actionId: string) => DurableAction | null | undefined;
  /**
   * Starts an ordinary ask. It must be the delivery acceptance path with its
   * receipt ledger, because that ledger is what keeps a repeated request ID
   * from starting a second ask.
   */
  deliver: (request: ScoutDeliverRequest) => Promise<ScoutDeliverResponse>;
  /**
   * The delivery receipt held for an ask's request ID, or null when none was
   * reserved. Used only to say whether a failed attempt can have started the
   * ask. Without it, every failure is reported as unknown.
   */
  readAskReceipt?: (requesterId: string, requestId: string) => Promise<{ state: string } | null>;
  now?: () => number;
};

export type ManualReviewDispatchCommand = Omit<ManualReviewDispatchRequest, "requestedById"> & {
  /** The caller as the runtime attributed it. Pinned to the occurrence when this request is admitted. */
  attribution: ScoutAttribution;
};

export type ManualReviewDispatchOptions = {
  /**
   * Runs the delivery under the write guard of the principal the ask is sent
   * as. That is the pinned principal, who may differ from this caller.
   */
  admitAsk?: <T>(actorId: string, deliver: () => Promise<T>) => Promise<T>;
};

export type ManualReviewDispatchFailure =
  | { error: "invalid_manual_review_request"; detail: string }
  | { error: "not_found"; detail: string }
  | { error: "manual_review_dispatch_not_started"; detail: string; retryable: true }
  | ManualReviewDispatchConflict;

/**
 * 400: the request cannot be admitted. 404: no occurrence is recorded for it.
 * 409: a ticket cannot be returned and no second ask may start. 503: the ask
 * did not start and the same request may be sent again.
 */
export class ManualReviewDispatchError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly body: ManualReviewDispatchFailure,
  ) {
    super(body.detail);
  }
}

/** The request ID of the one ask an occurrence may start. */
export function manualReviewAskRequestId(occurrenceId: string): string {
  return `${occurrenceId}.ask`;
}

/** The work item of the one ask an occurrence may start. */
export function manualReviewWorkId(occurrenceId: string): string {
  return `work-${occurrenceId}`;
}

/** Pinned values are caller text. Keep each on one line of the ask. */
function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/**
 * The ask for an occurrence. It is a function of the occurrence's pins only,
 * so every attempt sends the same request and the receipt for its request ID
 * accepts each of them as the same content. A change to what this builds
 * needs a new `MANUAL_REVIEW_ASK_VERSION`.
 */
export function buildManualReviewAsk(
  occurrence: Pick<ManualReviewOccurrence, "id" | "scope" | "requestId" | "input" | "artifact">,
  dispatch: ManualReviewDispatch,
  nodeId: string,
): ScoutDeliverRequest {
  const { input, artifact } = occurrence;
  const reference = {
    occurrenceId: occurrence.id,
    scope: occurrence.scope,
    requestId: occurrence.requestId,
    input: { source: input.source, id: input.id, version: input.version },
    artifact: { kind: artifact.kind, ref: artifact.ref, revision: artifact.revision },
  };
  const subject = `${oneLine(artifact.kind)} ${oneLine(artifact.ref)}`;
  const body = [
    `Review ${subject} at revision ${oneLine(artifact.revision)}.`,
    "",
    `The request for this review came from ${oneLine(input.source)}, item ${oneLine(input.id)}, version ${oneLine(input.version)}.`,
    "Scout fetched neither the request nor the artifact. Read them yourself from these references:",
    JSON.stringify(reference),
    "",
    "Review that revision and no other. If the artifact has moved to a newer revision, review the pinned one and say that it is no longer the latest.",
    "Reply once with your findings.",
  ].join("\n");
  const metadata = {
    source: "scout-manual-review",
    manualReviewOccurrenceId: occurrence.id,
    manualReviewScope: occurrence.scope,
    manualReviewRequestId: occurrence.requestId,
    manualReviewArtifactRevision: artifact.revision,
    attribution: dispatch.attribution,
  };
  const target = dispatch.target;
  return {
    task: { version: 1 },
    requestId: dispatch.askRequestId,
    caller: { actorId: dispatch.requestedById, nodeId },
    target: target.kind === "project_path" ? { kind: "project_path", projectPath: target.projectPath } : target,
    body,
    intent: "consult",
    ...(target.kind === "project_path"
      ? {
          execution: { ...(target.harness ? { harness: target.harness } : {}), session: "new" as const },
          projectAgent: { persistence: "one_time" as const },
        }
      : {}),
    labels: [MANUAL_REVIEW_WORK_LABEL],
    createdAt: dispatch.admittedAt,
    workItem: {
      id: manualReviewWorkId(occurrence.id),
      title: `Review ${subject} at ${oneLine(artifact.revision).slice(0, 12)}`.slice(0, 200),
      labels: [MANUAL_REVIEW_WORK_LABEL],
      metadata,
    },
    messageMetadata: metadata,
    invocationMetadata: metadata,
  };
}

function ticketOfAcceptedAsk(response: Extract<ScoutDeliverResponse, { kind: "delivery" }>): ManualReviewWorkTicket {
  const flight = response.flight;
  const targetAgentId = response.targetAgentId ?? flight?.targetAgentId;
  if (!flight || !targetAgentId) throw new Error("the manual review ask was accepted without a flight to follow");
  const targetSessionId = response.targetSessionId ?? response.receipt.targetSessionId;
  const bindingRef = response.bindingRef ?? response.receipt.bindingRef;
  return {
    ...(response.workItem ? { workId: response.workItem.id } : {}),
    flightId: flight.id,
    invocationId: flight.invocationId,
    messageId: response.message.id,
    conversationId: response.conversation.id,
    targetAgentId,
    ...(targetSessionId ? { targetSessionId } : {}),
    ...(bindingRef ? { bindingRef } : {}),
    acceptedAt: response.receipt.acceptedAt,
  };
}

function refusalOfRefusedAsk(
  response: Exclude<ScoutDeliverResponse, { kind: "delivery" }>,
  refusedAt: number,
): ManualReviewDispatchRefusal {
  if (response.kind === "rejected") {
    return { kind: "rejected", reason: response.reason, detail: response.rejection.detail, refusedAt };
  }
  return { kind: "unavailable", detail: response.question.detail, refusedAt };
}

export class ManualReviewDispatchService {
  constructor(private readonly deps: ManualReviewDispatchServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Start the ask for a recorded occurrence, or return the ticket of the ask
   * it already started. Safe to repeat: every call for one occurrence leads
   * to the same ask.
   */
  readonly dispatch = async (
    command: ManualReviewDispatchCommand,
    options: ManualReviewDispatchOptions = {},
  ): Promise<ManualReviewDispatchResponse> => {
    const errors = validateManualReviewDispatchRequest(command);
    if (errors.length > 0) {
      throw new ManualReviewDispatchError(400, { error: "invalid_manual_review_request", detail: errors.join("; ") });
    }
    const actorId = command.attribution?.actorId;
    if (typeof actorId !== "string" || !actorId || actorId !== actorId.trim()) {
      throw new ManualReviewDispatchError(400, { error: "invalid_manual_review_request", detail: "the caller could not be attributed" });
    }
    const id = manualReviewOccurrenceId(this.deps.authorityCellId, command.scope, command.requestId);

    const admitted = await this.admit(id, command);
    const settled = this.settledOutcome(admitted);
    if (settled) return settled;

    // From here the occurrence is admitted and the ask's identity is fixed.
    // Delivery runs outside the writer: the acceptance path takes it itself.
    const dispatch = admitted.dispatch!;
    const ask = buildManualReviewAsk(admitted, dispatch, this.deps.authorityCellId);
    // A refusal by the write guard is not a delivery failure: nothing reached the ask path.
    const deliver = async (): Promise<ScoutDeliverResponse> => {
      try {
        return await this.deps.deliver(ask);
      } catch (error) {
        throw await this.deliveryFailure(error, admitted);
      }
    };
    const response = await (options.admitAsk ? options.admitAsk(dispatch.requestedById, deliver) : deliver());
    return this.settle(id, response);
  };

  /**
   * Pin the target to the occurrence, or check the request against the pin
   * already there. The check and the write share the serialized writer, so of
   * two first requests with different targets exactly one is admitted.
   */
  private admit(id: string, command: ManualReviewDispatchCommand): Promise<ManualReviewOccurrence> {
    return this.deps.runDurableWrite(async () => {
      const action = this.deps.getDurableAction(id);
      if (!action) {
        throw new ManualReviewDispatchError(404, {
          error: "not_found",
          detail: "No manual review occurrence is recorded for this scope and request ID. Record it before dispatch.",
        });
      }
      const occurrence = this.readable(action, command);
      if (occurrence.dispatch) {
        const differs = manualReviewTargetDifferences(occurrence.dispatch.target, command.target);
        if (differs.length > 0) {
          throw new ManualReviewDispatchError(409, {
            error: "manual_review_dispatch_conflict",
            detail: `This occurrence is already pinned to another target (${differs.join(", ")}). Its ask is not sent anywhere else. Record a new occurrence to review with a different target.`,
            differs,
            occurrence,
          });
        }
        return occurrence;
      }
      const admittedAt = this.now();
      const target = command.target;
      return this.write(action, "admitted", {
        target: target.kind === "agent_id" ? { kind: "agent_id", agentId: target.agentId }
          : target.kind === "session_id" ? { kind: "session_id", sessionId: target.sessionId }
          : { kind: "project_path", projectPath: target.projectPath, ...(target.harness ? { harness: target.harness } : {}) },
        askRequestId: manualReviewAskRequestId(id),
        askVersion: MANUAL_REVIEW_ASK_VERSION,
        requestedById: command.attribution.actorId,
        attribution: command.attribution,
        admittedAt,
      }, admittedAt);
    });
  }

  /** Store what the ask path answered, unless a concurrent call already did. */
  private settle(id: string, response: ScoutDeliverResponse): Promise<ManualReviewDispatchResponse> {
    return this.deps.runDurableWrite(async () => {
      const action = this.deps.getDurableAction(id);
      const current = manualReviewOccurrenceOf(action);
      if (!action || !current?.dispatch) throw new Error("the manual review occurrence changed while its ask was delivered");
      const settled = this.settledOutcome(current);
      if (settled) return settled;
      const at = this.now();
      if (response.kind !== "delivery") {
        const refused = await this.write(action, "refused", { ...current.dispatch, refusal: refusalOfRefusedAsk(response, at) }, at);
        throw this.refused(refused);
      }
      const ticket = ticketOfAcceptedAsk(response);
      const occurrence = await this.write(action, "dispatched", { ...current.dispatch, ticket }, at);
      return { occurrence, ticket, replayed: false };
    });
  }

  /** The answer an occurrence already holds: its ticket, or its refusal. Null while only admitted. */
  private settledOutcome(occurrence: ManualReviewOccurrence): ManualReviewDispatchResponse | null {
    if (occurrence.state === "dispatched") return { occurrence, ticket: occurrence.dispatch!.ticket!, replayed: true };
    if (occurrence.state === "refused") throw this.refused(occurrence);
    return null;
  }

  private refused(occurrence: ManualReviewOccurrence): ManualReviewDispatchError {
    return new ManualReviewDispatchError(409, {
      error: "manual_review_dispatch_refused",
      detail: `The ask for this occurrence was refused and none started: ${occurrence.dispatch?.refusal?.detail ?? "no detail"}. The occurrence keeps its target. Record a new occurrence to try again.`,
      differs: [],
      occurrence,
    });
  }

  private readable(action: DurableAction, command: Pick<ManualReviewDispatchCommand, "scope" | "requestId">): ManualReviewOccurrence {
    const occurrence = manualReviewOccurrenceOf(action);
    if (!occurrence || occurrence.scope !== command.scope || occurrence.requestId !== command.requestId) {
      throw new ManualReviewDispatchError(409, {
        error: "manual_review_dispatch_conflict",
        detail: "The occurrence ID for this request holds a record that is not a readable manual review occurrence. Nothing was written and nothing was started.",
        differs: [],
      });
    }
    return occurrence;
  }

  private async write(
    action: DurableAction,
    state: ManualReviewOccurrenceState,
    dispatch: ManualReviewDispatch,
    updatedAt: number,
  ): Promise<ManualReviewOccurrence> {
    const stored = action.metadata?.[MANUAL_REVIEW_METADATA_KEY] as unknown as ManualReviewStoredOccurrence;
    const next: DurableAction = {
      ...action,
      kind: MANUAL_REVIEW_ACTION_KIND,
      updatedAt,
      metadata: { ...action.metadata, [MANUAL_REVIEW_METADATA_KEY]: { ...stored, state, dispatch } },
    };
    const occurrence = manualReviewOccurrenceOf(next);
    if (!occurrence) throw new Error("manual review dispatch is not readable in its stored form");
    await this.deps.commitEntries({ kind: "durable.action.record", action: next }, async () => {});
    return occurrence;
  }

  /**
   * A failed delivery leaves the occurrence admitted. Whether another attempt
   * may run the ask is the receipt ledger's decision, made again on the next
   * call. This only reports which case the caller is in.
   */
  private async deliveryFailure(error: unknown, occurrence: ManualReviewOccurrence): Promise<unknown> {
    const dispatch = occurrence.dispatch!;
    const reason = error instanceof Error ? error.message : String(error);
    let receipt: { state: string } | null | undefined;
    try {
      receipt = await this.deps.readAskReceipt?.(dispatch.requestedById, dispatch.askRequestId);
    } catch {
      receipt = undefined;
    }
    if (receipt === null || receipt?.state === "retryable") {
      return new ManualReviewDispatchError(503, {
        error: "manual_review_dispatch_not_started",
        detail: `The ask for this occurrence did not start: ${reason}. Send the same request again.`,
        retryable: true,
      });
    }
    return new ManualReviewDispatchError(409, {
      error: "manual_review_dispatch_unknown",
      detail: `The ask for this occurrence was reserved and its outcome is not known: ${reason}. It is not started again. `
        + `Its delivery receipt is request ${dispatch.askRequestId} from ${dispatch.requestedById}; a later request returns the ticket once that receipt is reconciled.`,
      differs: [],
      occurrence,
    });
  }
}
