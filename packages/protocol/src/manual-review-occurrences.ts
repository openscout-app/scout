import type { ScoutId } from "./common.js";
import type { DurableAction } from "./durable-actions.js";

/**
 * A manual review occurrence: one requested run of a review, recorded by the
 * runtime before anything starts. It pins what the run reads and which
 * artifact revision it reviews, so a replay of the request returns the same
 * run instead of a new one.
 *
 * The occurrence is stored as a durable action of kind `manual_review`. This
 * slice records and looks up occurrences only. It starts no agent turn, takes
 * no claim, and schedules nothing.
 */
export const MANUAL_REVIEW_ACTION_KIND = "manual_review" as const;

/** The durable action metadata key that holds the stored occurrence. */
export const MANUAL_REVIEW_METADATA_KEY = "manualReview" as const;

export const MANUAL_REVIEW_SCHEMA_VERSION = 1 as const;

/** The longest value any identifying field may carry. */
export const MANUAL_REVIEW_FIELD_MAX_LENGTH = 512;

/**
 * What the run reads, pinned at the version it had when the run was
 * requested. `version` belongs to the input's own system, such as a message
 * version. It is not the revision of the artifact under review.
 */
export interface ManualReviewInput {
  /** The system that holds the input, such as an adapter and its connection. */
  source: string;
  id: string;
  version: string;
}

/**
 * Evidence of the exact artifact revision under review, such as a pull
 * request's head commit. The caller states it; the runtime never derives it
 * from the input version or from a claim's epoch, which change for other
 * reasons.
 */
export interface ManualReviewArtifactRevision {
  /** The kind of artifact, such as `pull_request`. */
  kind: string;
  /** The artifact's address in its own system, such as `owner/repo#12`. */
  ref: string;
  /** The revision reviewed, such as a head commit SHA. */
  revision: string;
  /** When the caller read that revision. Informational: it does not identify the run. */
  observedAt?: number;
}

export interface ManualReviewOccurrenceRequest {
  /** Namespace for `requestId`, such as the routine or the surface that asks. */
  scope: string;
  /** Stable for one intended run. A retry sends the same ID. */
  requestId: string;
  input: ManualReviewInput;
  artifact: ManualReviewArtifactRevision;
  /** The requesting actor as the caller reports it. The runtime resolves the stored value. */
  requestedById?: ScoutId;
}

/**
 * `recorded`: stored, and nothing has started. Dispatch states arrive with
 * the slice that starts runs.
 */
export type ManualReviewOccurrenceState = "recorded";

export interface ManualReviewOccurrence {
  /** The durable action ID. The same scope and request ID always give the same one. */
  id: ScoutId;
  scope: string;
  requestId: string;
  input: ManualReviewInput;
  artifact: ManualReviewArtifactRevision;
  requestedById: ScoutId;
  state: ManualReviewOccurrenceState;
  createdAt: number;
}

export interface ManualReviewOccurrenceResponse {
  occurrence: ManualReviewOccurrence;
  /** False when the request replayed an occurrence that was already recorded. */
  created: boolean;
}

export interface ManualReviewOccurrenceLookup {
  scope: string;
  requestId: string;
}

/** A pinned field that a request must repeat exactly to replay an occurrence. */
export type ManualReviewPinnedField =
  | "input.source"
  | "input.id"
  | "input.version"
  | "artifact.kind"
  | "artifact.ref"
  | "artifact.revision";

/**
 * The answer when a request reuses a scope and request ID with different
 * pinned values, or when the occurrence's ID holds a record that is not a
 * readable occurrence. Nothing is written. `occurrence` is the run already
 * recorded, when it can be read.
 */
export interface ManualReviewOccurrenceConflict {
  error: "manual_review_conflict";
  detail: string;
  differs: ManualReviewPinnedField[];
  occurrence?: ManualReviewOccurrence;
}

/** The stored form, under `metadata.manualReview` on the durable action. */
export interface ManualReviewStoredOccurrence {
  schemaVersion: typeof MANUAL_REVIEW_SCHEMA_VERSION;
  scope: string;
  requestId: string;
  input: ManualReviewInput;
  artifact: ManualReviewArtifactRevision;
  requestedById: ScoutId;
  state: ManualReviewOccurrenceState;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifying(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MANUAL_REVIEW_FIELD_MAX_LENGTH
    && value === value.trim();
}

/**
 * Check a request as received. Identifying values must be exact: a value with
 * surrounding whitespace is refused, not trimmed, so the stored pin is the
 * value the caller sent.
 */
export function validateManualReviewOccurrenceRequest(request: unknown): string[] {
  if (!isObject(request)) return ["request must be an object"];
  const errors: string[] = [];
  const required = (value: unknown, path: string): void => {
    if (!identifying(value)) {
      errors.push(`${path} must be a non-empty string of at most ${MANUAL_REVIEW_FIELD_MAX_LENGTH} characters with no surrounding whitespace`);
    }
  };
  required(request.scope, "scope");
  required(request.requestId, "requestId");
  if (!isObject(request.input)) {
    errors.push("input must be an object");
  } else {
    required(request.input.source, "input.source");
    required(request.input.id, "input.id");
    required(request.input.version, "input.version");
  }
  if (!isObject(request.artifact)) {
    errors.push("artifact must be an object");
  } else {
    required(request.artifact.kind, "artifact.kind");
    required(request.artifact.ref, "artifact.ref");
    required(request.artifact.revision, "artifact.revision");
    const observedAt = request.artifact.observedAt;
    if (observedAt !== undefined && (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt < 0)) {
      errors.push("artifact.observedAt must be a non-negative finite timestamp");
    }
  }
  if (request.requestedById !== undefined && !identifying(request.requestedById)) {
    errors.push("requestedById must be a non-empty string with no surrounding whitespace");
  }
  return errors;
}

/** The pinned fields on which a request and a recorded occurrence disagree. */
export function manualReviewPinnedDifferences(
  recorded: Pick<ManualReviewOccurrence, "input" | "artifact">,
  requested: Pick<ManualReviewOccurrenceRequest, "input" | "artifact">,
): ManualReviewPinnedField[] {
  const differs: ManualReviewPinnedField[] = [];
  if (recorded.input.source !== requested.input.source) differs.push("input.source");
  if (recorded.input.id !== requested.input.id) differs.push("input.id");
  if (recorded.input.version !== requested.input.version) differs.push("input.version");
  if (recorded.artifact.kind !== requested.artifact.kind) differs.push("artifact.kind");
  if (recorded.artifact.ref !== requested.artifact.ref) differs.push("artifact.ref");
  if (recorded.artifact.revision !== requested.artifact.revision) differs.push("artifact.revision");
  return differs;
}

/**
 * Read the occurrence a durable action holds. Returns null for every other
 * kind of action and for a `manual_review` action whose stored form this
 * version cannot read, so older and newer records pass through untouched.
 */
export function manualReviewOccurrenceOf(action: DurableAction | null | undefined): ManualReviewOccurrence | null {
  if (!action || action.kind !== MANUAL_REVIEW_ACTION_KIND) return null;
  const stored = action.metadata?.[MANUAL_REVIEW_METADATA_KEY];
  if (!isObject(stored) || stored.schemaVersion !== MANUAL_REVIEW_SCHEMA_VERSION) return null;
  if (stored.state !== "recorded" || !identifying(stored.requestedById)) return null;
  if (validateManualReviewOccurrenceRequest(stored).length > 0) return null;
  const { scope, requestId, input, artifact } = stored as unknown as ManualReviewStoredOccurrence;
  return {
    id: action.id,
    scope,
    requestId,
    input: { source: input.source, id: input.id, version: input.version },
    artifact: {
      kind: artifact.kind,
      ref: artifact.ref,
      revision: artifact.revision,
      ...(artifact.observedAt !== undefined ? { observedAt: artifact.observedAt } : {}),
    },
    requestedById: stored.requestedById,
    state: "recorded",
    createdAt: action.createdAt,
  };
}
