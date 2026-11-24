/**
 * Manual review occurrences in the runtime.
 *
 * An occurrence is one requested review run, written once as a durable action
 * of kind `manual_review`. The journal is canonical, so an occurrence survives
 * a restart and replays into SQLite with every other durable action.
 *
 * This service only records and looks up. It starts no agent turn, takes no
 * claim, and schedules nothing: the action carries no due time and no lease,
 * so no worker picks it up. An ask starts only through the separate dispatch
 * service (manual-review-dispatch.ts), on an explicit request.
 */
import { createHash } from "node:crypto";

import {
  MANUAL_REVIEW_ACTION_KIND,
  MANUAL_REVIEW_METADATA_KEY,
  MANUAL_REVIEW_ROUTINE_ACTION_KIND,
  MANUAL_REVIEW_SCHEMA_VERSION,
  manualReviewOccurrenceOf,
  manualReviewPinnedDifferences,
  validateManualReviewOccurrenceRequest,
  type DurableAction,
  type ManualReviewOccurrence,
  type ManualReviewOccurrenceConflict,
  type ManualReviewOccurrenceLookup,
  type ManualReviewOccurrenceRequest,
  type ManualReviewOccurrenceResponse,
  type ManualReviewStoredOccurrence,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";

export type ManualReviewOccurrenceServiceDeps = {
  /** The node that holds the occurrence. Request IDs are unique within it. */
  authorityCellId: string;
  runDurableWrite: <T>(work: () => Promise<T>) => Promise<T>;
  commitEntries: (
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ) => Promise<BrokerJournalEntry[]>;
  /** Journal state, so a lookup after a restart sees what was recorded before it. */
  getDurableAction: (actionId: string) => DurableAction | null | undefined;
  now?: () => number;
};

export type ManualReviewOccurrenceInvalid = {
  error: "invalid_manual_review_request";
  detail: string;
};

/** 400 for a request that cannot be recorded, 409 for one that collides with a recorded run. */
export class ManualReviewOccurrenceError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly body: ManualReviewOccurrenceInvalid | ManualReviewOccurrenceConflict,
  ) {
    super(body.detail);
  }
}

function invalid(detail: string): ManualReviewOccurrenceError {
  return new ManualReviewOccurrenceError(400, { error: "invalid_manual_review_request", detail });
}

/**
 * The action ID for a scope and request ID on one node. It is derived, not
 * generated, so a replay finds the first write by ID with no index, before
 * and after a restart.
 */
export function manualReviewOccurrenceId(authorityCellId: string, scope: string, requestId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([authorityCellId, scope, requestId])).digest("hex");
  return `manual-review-${digest.slice(0, 32)}`;
}

/** Unique per scope and request ID. SQLite enforces it per node and action kind. */
export function manualReviewIdempotencyKey(scope: string, requestId: string): string {
  return JSON.stringify([scope, requestId]);
}

/** Whether an action is one only the manual review services may write: an occurrence, or a saved routine. */
export function isManualReviewAction(action: Pick<DurableAction, "kind"> | null | undefined): boolean {
  return action?.kind === MANUAL_REVIEW_ACTION_KIND || action?.kind === MANUAL_REVIEW_ROUTINE_ACTION_KIND;
}

export class ManualReviewOccurrenceService {
  constructor(private readonly deps: ManualReviewOccurrenceServiceDeps) {}

  /**
   * Record the occurrence for a request, or return the one already recorded.
   * A request that repeats the pinned input, artifact revision and routine
   * version is a replay. A request that changes any of them is refused, and
   * the recorded run stays as it was.
   */
  readonly record = async (request: ManualReviewOccurrenceRequest, checkGrant?: () => void): Promise<ManualReviewOccurrenceResponse> => {
    const errors = validateManualReviewOccurrenceRequest(request);
    if (errors.length > 0) throw invalid(errors.join("; "));
    const requestedById = request.requestedById;
    if (!requestedById) throw invalid("requestedById is required");

    const { scope, requestId } = request;
    const id = manualReviewOccurrenceId(this.deps.authorityCellId, scope, requestId);

    // The check and the write share the serialized writer, so two first uses
    // of one request ID cannot both create.
    return this.deps.runDurableWrite(async () => {
      const existing = this.deps.getDurableAction(id);
      if (existing) return this.replay(existing, request);

      checkGrant?.();
      const createdAt = this.deps.now?.() ?? Date.now();
      const stored: ManualReviewStoredOccurrence = {
        schemaVersion: MANUAL_REVIEW_SCHEMA_VERSION,
        scope,
        requestId,
        input: { source: request.input.source, id: request.input.id, version: request.input.version },
        artifact: {
          kind: request.artifact.kind,
          ref: request.artifact.ref,
          revision: request.artifact.revision,
          ...(request.artifact.observedAt !== undefined ? { observedAt: request.artifact.observedAt } : {}),
        },
        ...(request.routine ? { routine: { id: request.routine.id, version: request.routine.version } } : {}),
        requestedById,
        state: "recorded",
      };
      const action: DurableAction = {
        id,
        kind: MANUAL_REVIEW_ACTION_KIND,
        subjectId: request.input.id,
        authorityCellId: this.deps.authorityCellId,
        state: "pending",
        idempotencyKey: manualReviewIdempotencyKey(scope, requestId),
        leaseGeneration: 0,
        createdAt,
        updatedAt: createdAt,
        metadata: { [MANUAL_REVIEW_METADATA_KEY]: stored },
      };
      const occurrence = manualReviewOccurrenceOf(action);
      if (!occurrence) throw new Error("manual review occurrence is not readable in its stored form");
      await this.deps.commitEntries({ kind: "durable.action.record", action }, async () => {});
      return { occurrence, created: true };
    });
  };

  /** The occurrence recorded for a scope and request ID, or null. Reads only. */
  readonly lookup = (lookup: ManualReviewOccurrenceLookup): ManualReviewOccurrence | null => {
    const scope = typeof lookup.scope === "string" ? lookup.scope : "";
    const requestId = typeof lookup.requestId === "string" ? lookup.requestId : "";
    if (!scope || !requestId) throw invalid("scope and requestId are required");
    const occurrence = manualReviewOccurrenceOf(
      this.deps.getDurableAction(manualReviewOccurrenceId(this.deps.authorityCellId, scope, requestId)),
    );
    return occurrence && occurrence.scope === scope && occurrence.requestId === requestId ? occurrence : null;
  };

  private replay(existing: DurableAction, request: ManualReviewOccurrenceRequest): ManualReviewOccurrenceResponse {
    const occurrence = manualReviewOccurrenceOf(existing);
    if (!occurrence || occurrence.scope !== request.scope || occurrence.requestId !== request.requestId) {
      // An older or foreign record holds the ID. It is left as it is.
      throw new ManualReviewOccurrenceError(409, {
        error: "manual_review_conflict",
        detail: "The occurrence ID for this request holds a record that is not a readable manual review occurrence. Nothing was written.",
        differs: [],
      });
    }
    const differs = manualReviewPinnedDifferences(occurrence, request);
    if (differs.length > 0) {
      throw new ManualReviewOccurrenceError(409, {
        error: "manual_review_conflict",
        detail: `A run is already recorded for this request ID with different pinned values (${differs.join(", ")}). Use a new request ID to review a different version or revision.`,
        differs,
        occurrence,
      });
    }
    return { occurrence, created: false };
  }
}
