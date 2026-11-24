import type { DurableAction } from "./durable-actions.js";
import {
  MANUAL_REVIEW_FIELD_MAX_LENGTH,
  type ManualReviewArtifactRevision,
  type ManualReviewDispatchResponse,
  type ManualReviewInput,
  type ManualReviewOccurrence,
  type ManualReviewPinnedField,
} from "./manual-review-occurrences.js";
import { isVercelBoardChannelPath } from "./vercel-board.js";

/**
 * A Board review routine: a saved, manual reviewer for one channel of one
 * Vercel Board connection on this host. Its project and harness are the
 * reviewer. Nothing runs on a schedule: a run starts only when the operator
 * asks for one item to be reviewed.
 *
 * The runtime owns the routine. It maps a routine to the Board channel it may
 * read and to the reviewer it may start, and a caller names only the routine
 * and the item. The routine holds no credential: the connection it names
 * holds a credential reference, and the runtime resolves it.
 *
 * The routine is stored as a durable action of kind `manual_review_routine`.
 * It carries no due time and no lease, so nothing claims or runs it.
 */
export const MANUAL_REVIEW_ROUTINE_ACTION_KIND = "manual_review_routine" as const;

/** The durable action metadata key that holds the stored routine. */
export const MANUAL_REVIEW_ROUTINE_METADATA_KEY = "manualReviewRoutine" as const;

export const MANUAL_REVIEW_ROUTINE_SCHEMA_VERSION = 1 as const;

/**
 * The scope of every run a Board review routine starts is this prefix and the
 * routine's ID. Only the Board review entry point records or dispatches in it.
 */
export const MANUAL_REVIEW_BOARD_SCOPE_PREFIX = "board-review:" as const;

/** The artifact a Board review run reviews: the commit checked out in the routine's project. */
export const MANUAL_REVIEW_BOARD_ARTIFACT_KIND = "git_commit" as const;

/** The harnesses a Board review routine may name as its reviewer. */
export const MANUAL_REVIEW_BOARD_HARNESSES = ["codex", "claude"] as const;
export type ManualReviewBoardHarness = typeof MANUAL_REVIEW_BOARD_HARNESSES[number];

export const MANUAL_REVIEW_ROUTINE_NAME_MAX_LENGTH = 200;
const ROUTINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONNECTION_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const CHANNEL_MAX_LENGTH = 256;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface ManualReviewBoardRoutine {
  id: string;
  name: string;
  /** Starts at 1 and grows by one on every save. A version never names different content twice. */
  version: number;
  /** The Vercel Board connection on this host that the routine reads. */
  connectionId: string;
  /** The one channel of that connection whose items the routine may review. */
  channel: string;
  /** The reviewer's project: the canonical absolute path of a Git work tree on this host. */
  projectPath: string;
  harness: ManualReviewBoardHarness;
  /** A disabled routine keeps its record. It reads nothing and starts nothing. */
  enabled: boolean;
}

export interface ManualReviewBoardRoutinesResponse {
  routines: ManualReviewBoardRoutine[];
}

/** Create a routine with `expectedVersion: 0`, or replace the one saved at `expectedVersion`. */
export interface ManualReviewBoardRoutineSaveRequest {
  id: string;
  name: string;
  connectionId: string;
  channel: string;
  projectPath: string;
  harness: ManualReviewBoardHarness;
  enabled: boolean;
  expectedVersion: number;
}

export interface ManualReviewBoardRoutineSaveResponse {
  routine: ManualReviewBoardRoutine;
  /** True when the save made the routine, false when it replaced a version. */
  created: boolean;
}

/** The answer when `expectedVersion` is not the saved version. Nothing is written. */
export interface ManualReviewBoardRoutineVersionConflict {
  error: "manual_review_routine_version_conflict";
  detail: string;
  /** The routine as saved, or absent when none is saved under the ID. */
  routine?: ManualReviewBoardRoutine;
}

export interface ManualReviewBoardPreviewRequest {
  routineId: string;
  /** The Board message to review. It must be in the routine's channel. */
  itemId: string;
}

/**
 * What a run requested now would pin, read by the runtime: the routine as
 * saved, the item's version on the board, and the commit checked out in the
 * routine's project. A run repeats `routine.version`, `input.version` and
 * `artifact.revision`.
 */
export interface ManualReviewBoardPreviewResponse {
  routine: ManualReviewBoardRoutine;
  input: ManualReviewInput;
  artifact: ManualReviewArtifactRevision;
}

export interface ManualReviewBoardRunRequest {
  routineId: string;
  itemId: string;
  /** Stable for one intended run. A retry sends the same ID. */
  requestId: string;
  /** `routine.version` from the preview. */
  routineVersion: number;
  /** `input.version` from the preview. */
  inputVersion: string;
  /** `artifact.revision` from the preview. */
  revision: string;
}

export type ManualReviewBoardRunResponse = ManualReviewDispatchResponse;

/**
 * The answer when a run does not match what the runtime reads now, so the
 * preview the operator saw is no longer what would be reviewed. Nothing is
 * recorded and nothing starts. `current` is what a new preview would show.
 */
export interface ManualReviewBoardPreviewChanged {
  error: "manual_review_preview_changed";
  detail: string;
  differs: ManualReviewPinnedField[];
  current: ManualReviewBoardPreviewResponse;
}

/** The scope of the runs one routine starts. A lookup of a run uses it. */
export function manualReviewBoardScope(routineId: string): string {
  return `${MANUAL_REVIEW_BOARD_SCOPE_PREFIX}${routineId}`;
}

/** Whether a scope belongs to the Board review entry point. */
export function isManualReviewBoardScope(scope: unknown): boolean {
  return typeof scope === "string" && scope.startsWith(MANUAL_REVIEW_BOARD_SCOPE_PREFIX);
}

/** `input.source` of a Board review run: the adapter, the connection and the channel. */
export function manualReviewBoardInputSource(connectionId: string, channel: string): string {
  return `vercel-board:${connectionId}:${channel}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One Board message ID, or one request ID: exact text, as it will be pinned. */
function identifying(value: unknown, max = MANUAL_REVIEW_FIELD_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !CONTROL.test(value);
}

export function isManualReviewBoardRoutineId(value: unknown): value is string {
  return typeof value === "string" && ROUTINE_ID.test(value);
}

/** The fields of a routine that a save states, checked as received. The project is checked on disk by the runtime. */
function routineFieldErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isManualReviewBoardRoutineId(value.id)) errors.push("id must be 1-64 letters, digits, ., - or _, and start with a letter or digit");
  if (typeof value.name !== "string" || !value.name.trim() || value.name !== value.name.trim()
    || value.name.length > MANUAL_REVIEW_ROUTINE_NAME_MAX_LENGTH || CONTROL.test(value.name)) {
    errors.push(`name must be a non-empty single line of at most ${MANUAL_REVIEW_ROUTINE_NAME_MAX_LENGTH} characters with no surrounding whitespace`);
  }
  if (typeof value.connectionId !== "string" || !CONNECTION_ID.test(value.connectionId)) errors.push("connectionId must be a Vercel Board connection ID");
  if (!isVercelBoardChannelPath(value.channel) || value.channel.length > CHANNEL_MAX_LENGTH) errors.push("channel must be a Board channel path");
  if (typeof value.projectPath !== "string" || !value.projectPath.startsWith("/") || value.projectPath.length > MANUAL_REVIEW_FIELD_MAX_LENGTH
    || value.projectPath !== value.projectPath.trim() || CONTROL.test(value.projectPath)) {
    errors.push("projectPath must be an absolute path");
  }
  if (!(MANUAL_REVIEW_BOARD_HARNESSES as readonly unknown[]).includes(value.harness)) {
    errors.push(`harness must be one of ${MANUAL_REVIEW_BOARD_HARNESSES.join(", ")}`);
  }
  if (typeof value.enabled !== "boolean") errors.push("enabled must be true or false");
  return errors;
}

export function validateManualReviewBoardRoutineSaveRequest(request: unknown): string[] {
  if (!isObject(request)) return ["request must be an object"];
  const errors = routineFieldErrors(request);
  if (!Number.isSafeInteger(request.expectedVersion) || (request.expectedVersion as number) < 0) {
    errors.push("expectedVersion must be 0 to create the routine, or the version being replaced");
  }
  return errors;
}

export function validateManualReviewBoardPreviewRequest(request: unknown): string[] {
  if (!isObject(request)) return ["request must be an object"];
  const errors: string[] = [];
  if (!isManualReviewBoardRoutineId(request.routineId)) errors.push("routineId must be a routine ID");
  if (!identifying(request.itemId, 256)) errors.push("itemId must be one Board message ID");
  return errors;
}

export function validateManualReviewBoardRunRequest(request: unknown): string[] {
  if (!isObject(request)) return ["request must be an object"];
  const errors = validateManualReviewBoardPreviewRequest(request);
  if (!identifying(request.requestId)) errors.push("requestId must be a non-empty string with no surrounding whitespace");
  if (!Number.isSafeInteger(request.routineVersion) || (request.routineVersion as number) < 1) errors.push("routineVersion must be the routine version from the preview");
  if (!identifying(request.inputVersion)) errors.push("inputVersion must be the input version from the preview");
  if (!identifying(request.revision)) errors.push("revision must be the artifact revision from the preview");
  return errors;
}

/**
 * The pins on which a run request and a recorded run disagree. A request
 * that reuses a request ID must repeat every one of them.
 */
export function manualReviewBoardRunDifferences(
  recorded: Pick<ManualReviewOccurrence, "input" | "artifact" | "routine">,
  request: ManualReviewBoardRunRequest,
): ManualReviewPinnedField[] {
  const differs: ManualReviewPinnedField[] = [];
  if (recorded.input.id !== request.itemId) differs.push("input.id");
  if (recorded.input.version !== request.inputVersion) differs.push("input.version");
  if (recorded.artifact.revision !== request.revision) differs.push("artifact.revision");
  if (recorded.routine?.id !== request.routineId) differs.push("routine.id");
  if (recorded.routine?.version !== request.routineVersion) differs.push("routine.version");
  return differs;
}

/**
 * Read the routine a durable action holds. Returns null for every other kind
 * of action and for a stored form this version cannot read.
 */
export function manualReviewBoardRoutineOf(action: DurableAction | null | undefined): ManualReviewBoardRoutine | null {
  if (!action || action.kind !== MANUAL_REVIEW_ROUTINE_ACTION_KIND) return null;
  const stored = action.metadata?.[MANUAL_REVIEW_ROUTINE_METADATA_KEY];
  if (!isObject(stored) || stored.schemaVersion !== MANUAL_REVIEW_ROUTINE_SCHEMA_VERSION) return null;
  if (!Number.isSafeInteger(stored.version) || (stored.version as number) < 1) return null;
  if (routineFieldErrors(stored).length > 0) return null;
  const routine = stored as unknown as ManualReviewBoardRoutine;
  return {
    id: routine.id,
    name: routine.name,
    version: routine.version,
    connectionId: routine.connectionId,
    channel: routine.channel,
    projectPath: routine.projectPath,
    harness: routine.harness,
    enabled: routine.enabled,
  };
}
