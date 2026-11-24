import type { AgentHarness } from "./actors.js";
import type { ScoutAttribution, ScoutId } from "./common.js";
import type { DurableAction } from "./durable-actions.js";
import { SCOUT_LAUNCHABLE_HARNESSES } from "./runtime-catalog-contract.js";

/**
 * A manual review occurrence: one requested run of a review, recorded by the
 * runtime before anything starts. It pins what the run reads and which
 * artifact revision it reviews, so a replay of the request returns the same
 * run instead of a new one.
 *
 * The occurrence is stored as a durable action of kind `manual_review`.
 * Recording starts no agent turn, takes no claim, and schedules nothing. A
 * recorded occurrence starts at most one ask, and only when a caller asks for
 * its dispatch to one explicit target (see `ManualReviewDispatchRequest`).
 */
export const MANUAL_REVIEW_ACTION_KIND = "manual_review" as const;

/** The durable action metadata key that holds the stored occurrence. */
export const MANUAL_REVIEW_METADATA_KEY = "manualReview" as const;

export const MANUAL_REVIEW_SCHEMA_VERSION = 1 as const;

/** The label on the work item of an ask a run started. */
export const MANUAL_REVIEW_WORK_LABEL = "scout:manual-review" as const;

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

/**
 * The saved routine a run came from, pinned at the version it had when the
 * run was requested. A routine's version never names different content twice,
 * so the pin says which reviewer and which source the run was admitted for.
 */
export interface ManualReviewRoutinePin {
  id: string;
  version: number;
}

export interface ManualReviewOccurrenceRequest {
  /** Namespace for `requestId`, such as the routine or the surface that asks. */
  scope: string;
  /** Stable for one intended run. A retry sends the same ID. */
  requestId: string;
  input: ManualReviewInput;
  artifact: ManualReviewArtifactRevision;
  /** Present only on a run a saved routine started. The runtime sets it; a caller of the general entry point cannot. */
  routine?: ManualReviewRoutinePin;
  /** The requesting actor as the caller reports it. The runtime resolves the stored value. */
  requestedById?: ScoutId;
}

/**
 * Where the run's one ask goes. Each kind names one recipient: an agent, a
 * session, or a fresh session in one project. A channel, a broadcast, a label
 * or an alias is not a target, because it can name more than one recipient or
 * a different one later.
 */
export type ManualReviewDispatchTarget =
  | { kind: "agent_id"; agentId: ScoutId }
  | { kind: "session_id"; sessionId: ScoutId }
  | {
      kind: "project_path";
      /** An absolute path on this machine. */
      projectPath: string;
      /** The harness that runs the review. The project's default when absent. */
      harness?: AgentHarness;
    };

/**
 * The work ticket of the ask a run started: the IDs to follow it by. A retry
 * returns the same ticket.
 */
export interface ManualReviewWorkTicket {
  /** The ask's work item. Absent only when the ask path linked none. */
  workId?: ScoutId;
  flightId: ScoutId;
  invocationId: ScoutId;
  messageId: ScoutId;
  conversationId: ScoutId;
  targetAgentId: ScoutId;
  targetSessionId?: ScoutId;
  /** The short ref a reply names the task by. */
  bindingRef?: string;
  acceptedAt: number;
}

/** Why the ask path did not accept the run's ask. No ask started. */
export interface ManualReviewDispatchRefusal {
  /** `rejected`: no such single target. `unavailable`: the target cannot take work now. */
  kind: "rejected" | "unavailable";
  reason?: string;
  detail: string;
  refusedAt: number;
}

/** The version of the request built for the ask. The ask's receipt binds its request ID to that content. */
export const MANUAL_REVIEW_ASK_VERSION = 1 as const;

/**
 * The dispatch pinned to an occurrence when its first dispatch request is
 * admitted. The target, the ask's request ID and the principal it is sent as
 * never change afterwards.
 */
export interface ManualReviewDispatch {
  target: ManualReviewDispatchTarget;
  /** The request ID of the one ask this occurrence may start. Derived from the occurrence ID. */
  askRequestId: string;
  askVersion: typeof MANUAL_REVIEW_ASK_VERSION;
  /** The principal the ask is sent as: the caller whose dispatch request was admitted. */
  requestedById: ScoutId;
  attribution: ScoutAttribution;
  admittedAt: number;
  /** Present once the ask was accepted. */
  ticket?: ManualReviewWorkTicket;
  /** Present once the ask path refused the ask. */
  refusal?: ManualReviewDispatchRefusal;
}

/**
 * `recorded`: stored, and nothing has started.
 * `admitted`: a target is pinned and the ask's identity is fixed. The ask may
 * or may not have started.
 * `dispatched`: the ask was accepted and its ticket is stored.
 * `refused`: the ask path refused the ask, and none started.
 */
export type ManualReviewOccurrenceState = "recorded" | "admitted" | "dispatched" | "refused";

export interface ManualReviewOccurrence {
  /** The durable action ID. The same scope and request ID always give the same one. */
  id: ScoutId;
  scope: string;
  requestId: string;
  input: ManualReviewInput;
  artifact: ManualReviewArtifactRevision;
  /** The routine version the run was admitted for, when a saved routine started it. */
  routine?: ManualReviewRoutinePin;
  requestedById: ScoutId;
  state: ManualReviewOccurrenceState;
  /** Present in every state but `recorded`. */
  dispatch?: ManualReviewDispatch;
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
  | "artifact.revision"
  | "routine.id"
  | "routine.version";

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

/** A request to start the run's ask, or to read the ticket of the ask it started. */
export interface ManualReviewDispatchRequest {
  scope: string;
  requestId: string;
  target: ManualReviewDispatchTarget;
  /** The requesting actor as the caller reports it. The runtime resolves the stored value. */
  requestedById?: ScoutId;
}

export interface ManualReviewDispatchResponse {
  occurrence: ManualReviewOccurrence;
  ticket: ManualReviewWorkTicket;
  /** True when the ticket was already stored on the occurrence. The call started nothing. */
  replayed: boolean;
}

/** A field of the pinned target that a dispatch request must repeat exactly. */
export type ManualReviewTargetField =
  | "target.kind"
  | "target.agentId"
  | "target.sessionId"
  | "target.projectPath"
  | "target.harness";

/**
 * The answer when a dispatch request cannot return a ticket and no second ask
 * may start. Nothing about the pinned dispatch changes.
 *
 * `manual_review_dispatch_conflict`: the occurrence is pinned to a different target.
 * `manual_review_dispatch_refused`: the ask path refused the ask. Record a new occurrence to try again.
 * `manual_review_dispatch_unknown`: the ask was reserved and its outcome is not known. It is not started again.
 */
export interface ManualReviewDispatchConflict {
  error: "manual_review_dispatch_conflict" | "manual_review_dispatch_refused" | "manual_review_dispatch_unknown";
  detail: string;
  differs: ManualReviewTargetField[];
  occurrence?: ManualReviewOccurrence;
}

/** The stored form, under `metadata.manualReview` on the durable action. */
export interface ManualReviewStoredOccurrence {
  schemaVersion: typeof MANUAL_REVIEW_SCHEMA_VERSION;
  scope: string;
  requestId: string;
  input: ManualReviewInput;
  artifact: ManualReviewArtifactRevision;
  routine?: ManualReviewRoutinePin;
  requestedById: ScoutId;
  state: ManualReviewOccurrenceState;
  dispatch?: ManualReviewDispatch;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A routine pin as stored: the routine's ID and a version that was saved, which starts at 1. */
function routinePinErrors(value: unknown): string[] {
  if (!isObject(value)) return ["routine must be an object"];
  const errors: string[] = [];
  if (!identifying(value.id)) errors.push("routine.id must be a non-empty string with no surrounding whitespace");
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) errors.push("routine.version must be a positive integer");
  return errors;
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
  if (request.routine !== undefined) errors.push(...routinePinErrors(request.routine));
  if (request.requestedById !== undefined && !identifying(request.requestedById)) {
    errors.push("requestedById must be a non-empty string with no surrounding whitespace");
  }
  return errors;
}

/** Check a dispatch target as received. The same exactness as the occurrence's pins applies. */
export function validateManualReviewDispatchTarget(target: unknown): string[] {
  if (!isObject(target)) return ["target must be an object"];
  const errors: string[] = [];
  const allowed = (keys: string[]): void => {
    for (const key of Object.keys(target)) {
      if (!keys.includes(key) && target[key] !== undefined) errors.push(`target.${key} is not part of a ${String(target.kind)} target`);
    }
  };
  const required = (value: unknown, path: string): void => {
    if (!identifying(value)) {
      errors.push(`${path} must be a non-empty string of at most ${MANUAL_REVIEW_FIELD_MAX_LENGTH} characters with no surrounding whitespace`);
    }
  };
  if (target.kind === "agent_id") {
    allowed(["kind", "agentId"]);
    required(target.agentId, "target.agentId");
  } else if (target.kind === "session_id") {
    allowed(["kind", "sessionId"]);
    required(target.sessionId, "target.sessionId");
  } else if (target.kind === "project_path") {
    allowed(["kind", "projectPath", "harness"]);
    required(target.projectPath, "target.projectPath");
    if (identifying(target.projectPath) && !target.projectPath.startsWith("/")) {
      errors.push("target.projectPath must be an absolute path");
    }
    if (target.harness !== undefined && !(SCOUT_LAUNCHABLE_HARNESSES as readonly unknown[]).includes(target.harness)) {
      errors.push(`target.harness must be one of ${SCOUT_LAUNCHABLE_HARNESSES.join(", ")}`);
    }
  } else {
    errors.push("target.kind must be agent_id, session_id or project_path: one explicit recipient");
  }
  return errors;
}

/** Check a dispatch request as received. */
export function validateManualReviewDispatchRequest(request: unknown): string[] {
  if (!isObject(request)) return ["request must be an object"];
  const errors: string[] = [];
  for (const key of ["scope", "requestId"] as const) {
    if (!identifying(request[key])) {
      errors.push(`${key} must be a non-empty string of at most ${MANUAL_REVIEW_FIELD_MAX_LENGTH} characters with no surrounding whitespace`);
    }
  }
  errors.push(...validateManualReviewDispatchTarget(request.target));
  if (request.requestedById !== undefined && !identifying(request.requestedById)) {
    errors.push("requestedById must be a non-empty string with no surrounding whitespace");
  }
  return errors;
}

/** The fields on which a requested target and the pinned target disagree. */
export function manualReviewTargetDifferences(
  pinned: ManualReviewDispatchTarget,
  requested: ManualReviewDispatchTarget,
): ManualReviewTargetField[] {
  if (pinned.kind !== requested.kind) return ["target.kind"];
  const differs: ManualReviewTargetField[] = [];
  if (pinned.kind === "agent_id" && requested.kind === "agent_id") {
    if (pinned.agentId !== requested.agentId) differs.push("target.agentId");
  } else if (pinned.kind === "session_id" && requested.kind === "session_id") {
    if (pinned.sessionId !== requested.sessionId) differs.push("target.sessionId");
  } else if (pinned.kind === "project_path" && requested.kind === "project_path") {
    if (pinned.projectPath !== requested.projectPath) differs.push("target.projectPath");
    if (pinned.harness !== requested.harness) differs.push("target.harness");
  }
  return differs;
}

function dispatchTargetOf(target: ManualReviewDispatchTarget): ManualReviewDispatchTarget {
  if (target.kind === "agent_id") return { kind: "agent_id", agentId: target.agentId };
  if (target.kind === "session_id") return { kind: "session_id", sessionId: target.sessionId };
  return { kind: "project_path", projectPath: target.projectPath, ...(target.harness ? { harness: target.harness } : {}) };
}

function ticketOf(value: unknown): ManualReviewWorkTicket | null {
  if (!isObject(value)) return null;
  for (const key of ["flightId", "invocationId", "messageId", "conversationId", "targetAgentId"] as const) {
    if (typeof value[key] !== "string" || !value[key]) return null;
  }
  for (const key of ["workId", "targetSessionId", "bindingRef"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key])) return null;
  }
  if (typeof value.acceptedAt !== "number" || !Number.isFinite(value.acceptedAt)) return null;
  const ticket = value as unknown as ManualReviewWorkTicket;
  return {
    ...(ticket.workId ? { workId: ticket.workId } : {}),
    flightId: ticket.flightId,
    invocationId: ticket.invocationId,
    messageId: ticket.messageId,
    conversationId: ticket.conversationId,
    targetAgentId: ticket.targetAgentId,
    ...(ticket.targetSessionId ? { targetSessionId: ticket.targetSessionId } : {}),
    ...(ticket.bindingRef ? { bindingRef: ticket.bindingRef } : {}),
    acceptedAt: ticket.acceptedAt,
  };
}

function refusalOf(value: unknown): ManualReviewDispatchRefusal | null {
  if (!isObject(value) || (value.kind !== "rejected" && value.kind !== "unavailable")) return null;
  if (typeof value.detail !== "string" || typeof value.refusedAt !== "number" || !Number.isFinite(value.refusedAt)) return null;
  if (value.reason !== undefined && typeof value.reason !== "string") return null;
  return {
    kind: value.kind,
    ...(value.reason ? { reason: value.reason } : {}),
    detail: value.detail,
    refusedAt: value.refusedAt,
  };
}

function attributionOf(value: unknown): ScoutAttribution | null {
  if (!isObject(value) || !identifying(value.actorId) || !identifying(value.rootActorId)) return null;
  if (!["local-admin", "scoped", "system", "unverified"].includes(value.source as string)) return null;
  if (value.claimedActorId !== undefined && typeof value.claimedActorId !== "string") return null;
  return {
    actorId: value.actorId,
    rootActorId: value.rootActorId,
    source: value.source as ScoutAttribution["source"],
    ...(value.claimedActorId ? { claimedActorId: value.claimedActorId } : {}),
  };
}

/**
 * The dispatch a stored occurrence carries: undefined when its state has
 * none, null when the state and the stored dispatch do not agree. A state
 * always agrees with what is stored, so `dispatched` always has a ticket.
 */
function storedDispatchOf(state: unknown, stored: unknown): ManualReviewDispatch | undefined | null {
  if (state === "recorded") return stored === undefined ? undefined : null;
  if (state !== "admitted" && state !== "dispatched" && state !== "refused") return null;
  if (!isObject(stored) || stored.askVersion !== MANUAL_REVIEW_ASK_VERSION) return null;
  if (validateManualReviewDispatchTarget(stored.target).length > 0) return null;
  if (!identifying(stored.askRequestId) || !identifying(stored.requestedById)) return null;
  if (typeof stored.admittedAt !== "number" || !Number.isFinite(stored.admittedAt)) return null;
  const attribution = attributionOf(stored.attribution);
  if (!attribution || attribution.actorId !== stored.requestedById) return null;
  const ticket = stored.ticket === undefined ? undefined : ticketOf(stored.ticket);
  const refusal = stored.refusal === undefined ? undefined : refusalOf(stored.refusal);
  if (ticket === null || refusal === null) return null;
  if (Boolean(ticket) !== (state === "dispatched") || Boolean(refusal) !== (state === "refused")) return null;
  return {
    target: dispatchTargetOf(stored.target as ManualReviewDispatchTarget),
    askRequestId: stored.askRequestId,
    askVersion: MANUAL_REVIEW_ASK_VERSION,
    requestedById: stored.requestedById,
    attribution,
    admittedAt: stored.admittedAt,
    ...(ticket ? { ticket } : {}),
    ...(refusal ? { refusal } : {}),
  };
}

/** The pinned fields on which a request and a recorded occurrence disagree. */
export function manualReviewPinnedDifferences(
  recorded: Pick<ManualReviewOccurrence, "input" | "artifact" | "routine">,
  requested: Pick<ManualReviewOccurrenceRequest, "input" | "artifact" | "routine">,
): ManualReviewPinnedField[] {
  const differs: ManualReviewPinnedField[] = [];
  if (recorded.input.source !== requested.input.source) differs.push("input.source");
  if (recorded.input.id !== requested.input.id) differs.push("input.id");
  if (recorded.input.version !== requested.input.version) differs.push("input.version");
  if (recorded.artifact.kind !== requested.artifact.kind) differs.push("artifact.kind");
  if (recorded.artifact.ref !== requested.artifact.ref) differs.push("artifact.ref");
  if (recorded.artifact.revision !== requested.artifact.revision) differs.push("artifact.revision");
  // A run with a routine pin and one without are different runs, whatever else they share.
  if (recorded.routine?.id !== requested.routine?.id) differs.push("routine.id");
  if (recorded.routine?.version !== requested.routine?.version) differs.push("routine.version");
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
  if (!identifying(stored.requestedById)) return null;
  if (validateManualReviewOccurrenceRequest(stored).length > 0) return null;
  const dispatch = storedDispatchOf(stored.state, stored.dispatch);
  if (dispatch === null) return null;
  const state = stored.state as ManualReviewOccurrenceState;
  const { scope, requestId, input, artifact, routine } = stored as unknown as ManualReviewStoredOccurrence;
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
    ...(routine ? { routine: { id: routine.id, version: routine.version } } : {}),
    requestedById: stored.requestedById,
    state,
    ...(dispatch ? { dispatch } : {}),
    createdAt: action.createdAt,
  };
}
