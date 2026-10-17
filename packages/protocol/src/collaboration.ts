import type { MetadataMap, ScoutId } from "./common.js";

export type CollaborationKind = "work_item" | "question";

export type CollaborationPriority = "low" | "normal" | "high" | "urgent";

export type CollaborationAcceptanceState =
  | "none"
  | "pending"
  | "accepted"
  | "reopened";

export type WorkItemState =
  | "open"
  | "working"
  | "waiting"
  | "review"
  | "done"
  | "cancelled";

export type QuestionState =
  | "open"
  | "answered"
  | "closed"
  | "declined";

export type CollaborationRelationKind =
  | "blocks"
  | "depends_on"
  | "spawns"
  | "relates_to"
  | "references";

export interface CollaborationRelation {
  kind: CollaborationRelationKind;
  targetId: ScoutId;
  metadata?: MetadataMap;
}

export interface CollaborationWaitingOn {
  kind: "actor" | "work_item" | "approval" | "artifact" | "condition";
  label: string;
  targetId?: ScoutId;
  metadata?: MetadataMap;
}

export interface CollaborationProgress {
  completedSteps?: number;
  totalSteps?: number;
  checkpoint?: string;
  summary?: string;
  percent?: number;
}

/**
 * Identity in an external work system. Together, adapterId, instanceId,
 * projectId (when present), and workItemId form the source namespace. Source
 * ids remain opaque; none of these fields grant authority or identify a Scout
 * actor. The external system remains the writer of its board and workflow.
 */
export interface ExternalWorkSource {
  adapterId: string;
  instanceId: string;
  projectId?: string;
  workItemId: string;
  url?: string;
}

export interface ExternalWorkBoard {
  id: string;
  title?: string;
  column?: { id: string; title?: string };
}

/** A source-owned stage, which may have its own execution thread/provider. */
export interface ExternalWorkflowStage {
  id: string;
  kind?: string;
  title?: string;
  state: string;
  threadId?: string;
  provider?: string;
  model?: string;
}

/** Human acceptance is independent of a stage or provider turn completing. */
export interface ExternalHumanAcceptance {
  required: boolean;
  state: "pending" | "accepted" | "rejected" | "unknown";
  sourceState?: string;
  decidedById?: string;
  decidedAt?: number;
}

export interface ExternalWorkWorkflow {
  stages?: ExternalWorkflowStage[];
  activeStageId?: string;
  executionState?: string;
  humanAcceptance?: ExternalHumanAcceptance;
}

/**
 * An observation attached to Scout-owned work, rather than a replacement for
 * its state or acceptanceState. Columns, card status, execution, and human
 * decisions retain their separate source meanings. Adapters can refresh this
 * context without importing external transcripts into Scout messages.
 */
export interface ExternalWorkContext {
  source: ExternalWorkSource;
  observedAt: number;
  sourceState?: string;
  board?: ExternalWorkBoard;
  workflow?: ExternalWorkWorkflow;
}

export interface CollaborationRecordBase {
  id: ScoutId;
  kind: CollaborationKind;
  title: string;
  summary?: string;
  createdById: ScoutId;
  ownerId?: ScoutId;
  nextMoveOwnerId?: ScoutId;
  conversationId?: ScoutId;
  parentId?: ScoutId;
  priority?: CollaborationPriority;
  labels?: string[];
  relations?: CollaborationRelation[];
  createdAt: number;
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface WorkItemRecord extends CollaborationRecordBase {
  kind: "work_item";
  state: WorkItemState;
  acceptanceState: CollaborationAcceptanceState;
  requestedById?: ScoutId;
  waitingOn?: CollaborationWaitingOn;
  progress?: CollaborationProgress;
  startedAt?: number;
  reviewRequestedAt?: number;
  completedAt?: number;
  externalContext?: ExternalWorkContext;
}

function isExternalContextObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate nested adapter input before it enters the broker's durable work. */
export function validateExternalWorkContext(context: unknown): string[] {
  const errors: string[] = [];
  const requiredString = (value: unknown, path: string): void => {
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${path} must be a non-empty string`);
    }
  };
  const optionalString = (value: unknown, path: string): void => {
    if (value !== undefined) requiredString(value, path);
  };
  const timestamp = (value: unknown, path: string): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(`${path} must be a non-negative finite timestamp`);
    }
  };
  if (!isExternalContextObject(context)) {
    return ["externalContext must be an object"];
  }
  timestamp(context.observedAt, "externalContext.observedAt");
  optionalString(context.sourceState, "externalContext.sourceState");
  if (!isExternalContextObject(context.source)) {
    errors.push("externalContext.source must be an object");
  } else {
    for (const key of ["adapterId", "instanceId", "workItemId"] as const) {
      requiredString(context.source[key], `externalContext.source.${key}`);
    }
    for (const key of ["projectId", "url"] as const) {
      optionalString(context.source[key], `externalContext.source.${key}`);
    }
  }
  if (context.board !== undefined) {
    if (!isExternalContextObject(context.board)) {
      errors.push("externalContext.board must be an object");
    } else {
      requiredString(context.board.id, "externalContext.board.id");
      optionalString(context.board.title, "externalContext.board.title");
      if (context.board.column !== undefined) {
        if (!isExternalContextObject(context.board.column)) {
          errors.push("externalContext.board.column must be an object");
        } else {
          requiredString(context.board.column.id, "externalContext.board.column.id");
          optionalString(context.board.column.title, "externalContext.board.column.title");
        }
      }
    }
  }
  if (context.workflow === undefined) return errors;
  if (!isExternalContextObject(context.workflow)) {
    errors.push("externalContext.workflow must be an object");
    return errors;
  }
  const workflow = context.workflow;
  optionalString(workflow.activeStageId, "externalContext.workflow.activeStageId");
  optionalString(workflow.executionState, "externalContext.workflow.executionState");
  if (workflow.stages !== undefined) {
    if (!Array.isArray(workflow.stages)) {
      errors.push("externalContext.workflow.stages must be an array");
    } else {
      const stageIds = new Set<string>();
      for (const [index, stage] of workflow.stages.entries()) {
        const path = `externalContext.workflow.stages[${index}]`;
        if (!isExternalContextObject(stage)) {
          errors.push(`${path} must be an object`);
          continue;
        }
        requiredString(stage.id, `${path}.id`);
        requiredString(stage.state, `${path}.state`);
        for (const key of ["kind", "title", "threadId", "provider", "model"] as const) {
          optionalString(stage[key], `${path}.${key}`);
        }
        if (typeof stage.id === "string") {
          if (stageIds.has(stage.id)) errors.push(`${path}.id must be unique within the workflow`);
          stageIds.add(stage.id);
        }
      }
      if (typeof workflow.activeStageId === "string" && !stageIds.has(workflow.activeStageId)) {
        errors.push("externalContext.workflow.activeStageId must reference a supplied stage");
      }
    }
  }
  if (workflow.humanAcceptance !== undefined) {
    const acceptance = workflow.humanAcceptance;
    if (!isExternalContextObject(acceptance)) {
      errors.push("externalContext.workflow.humanAcceptance must be an object");
    } else {
      const path = "externalContext.workflow.humanAcceptance";
      if (typeof acceptance.required !== "boolean") errors.push(`${path}.required must be a boolean`);
      if (!["pending", "accepted", "rejected", "unknown"].includes(acceptance.state as string)) {
        errors.push(`${path}.state must be pending, accepted, rejected, or unknown`);
      }
      optionalString(acceptance.sourceState, `${path}.sourceState`);
      optionalString(acceptance.decidedById, `${path}.decidedById`);
      if (acceptance.decidedAt !== undefined) timestamp(acceptance.decidedAt, `${path}.decidedAt`);
    }
  }
  return errors;
}

/**
 * A lightweight information-seeking interaction. A peer of {@link WorkItemRecord},
 * not a point on the same severity ladder: a question can resolve directly, attach
 * to a work item, or spawn one.
 *
 * Acceptance is modeled separately from workflow state (via `acceptanceState`) so a
 * reply and satisfaction do not collapse into one transition — a question can be
 * `answered` without yet being `closed`.
 */
export interface QuestionRecord extends CollaborationRecordBase {
  kind: "question";
  state: QuestionState;
  acceptanceState: CollaborationAcceptanceState;
  /** The actor being asked to answer. */
  askedById?: ScoutId;
  answeredById?: ScoutId;
  /** The delivered answer text, present once `state` is `answered`. */
  answer?: string;
  answeredAt?: number;
  closedAt?: number;
}

export type CollaborationRecord = WorkItemRecord | QuestionRecord;

export type CollaborationEventKind =
  | "created"
  | "claimed"
  | "accepted"
  | "reopened"
  | "waiting"
  | "progressed"
  | "handoff"
  | "review_requested"
  | "done"
  | "dismissed"
  | "cancelled";

export interface CollaborationEvent {
  id: ScoutId;
  recordId: ScoutId;
  recordKind: CollaborationKind;
  kind: CollaborationEventKind;
  actorId: ScoutId;
  at: number;
  summary?: string;
  metadata?: MetadataMap;
}

export function isWorkItemTerminalState(state: WorkItemState): boolean {
  return state === "done" || state === "cancelled";
}

/**
 * A question is terminal once it is `closed` or `declined`. `answered` is NOT terminal
 * — acceptance is tracked separately, so an answered question may still await closure.
 */
export function isQuestionTerminalState(state: QuestionState): boolean {
  return state === "closed" || state === "declined";
}

/** Terminal-state check across both collaboration kinds. */
export function isCollaborationTerminalState(record: CollaborationRecord): boolean {
  return record.kind === "work_item"
    ? isWorkItemTerminalState(record.state)
    : isQuestionTerminalState(record.state);
}

/** Narrow a {@link CollaborationRecord} to a {@link WorkItemRecord}. */
export function isWorkItem(record: CollaborationRecord): record is WorkItemRecord {
  return record.kind === "work_item";
}

/** Narrow a {@link CollaborationRecord} to a {@link QuestionRecord}. */
export function isQuestion(record: CollaborationRecord): record is QuestionRecord {
  return record.kind === "question";
}

/**
 * The actor a collaboration record is directed at / awaiting acceptance from: the
 * `requestedById` for a work item, the `askedById` for a question. Consumers that
 * route or attribute a record by its requester should use this rather than reaching
 * for a kind-specific field, so questions are handled instead of silently dropped.
 */
export function collaborationRequesterId(record: CollaborationRecord): ScoutId | undefined {
  return isWorkItem(record) ? record.requestedById : record.askedById;
}

export function collaborationRequiresNextMoveOwner(record: CollaborationRecord): boolean {
  return !isCollaborationTerminalState(record);
}

export function collaborationRequiresOwner(record: CollaborationRecord): boolean {
  return record.kind === "work_item" && !isWorkItemTerminalState(record.state);
}

export function collaborationRequiresWaitingOn(record: CollaborationRecord): boolean {
  return record.kind === "work_item" && record.state === "waiting";
}

export function collaborationRequiresAcceptance(record: CollaborationRecord): boolean {
  if (record.acceptanceState === "none") {
    return false;
  }

  return Boolean(collaborationRequesterId(record));
}

export function validateCollaborationRecord(record: CollaborationRecord): string[] {
  const errors: string[] = [];

  if (!record.id.trim()) {
    errors.push("collaboration record id is required");
  }

  if (!record.title.trim()) {
    errors.push("collaboration title is required");
  }

  if (!record.createdById.trim()) {
    errors.push("createdById is required");
  }

  if (record.parentId && record.parentId === record.id) {
    errors.push("parentId cannot reference the record itself");
  }

  if (record.createdAt > record.updatedAt) {
    errors.push("updatedAt must be greater than or equal to createdAt");
  }

  if (collaborationRequiresOwner(record) && !record.ownerId) {
    errors.push("non-terminal work items require ownerId");
  }

  if (collaborationRequiresNextMoveOwner(record) && !record.nextMoveOwnerId) {
    errors.push("non-terminal collaboration records require nextMoveOwnerId");
  }

  if (record.kind === "work_item" && collaborationRequiresWaitingOn(record) && !record.waitingOn) {
    errors.push("waiting work items require waitingOn");
  }

  if (
    record.kind === "work_item"
    && record.waitingOn?.targetId
    && record.waitingOn.targetId === record.id
  ) {
    errors.push("waitingOn.targetId cannot reference the work item itself");
  }

  if (record.kind === "question" && record.state === "answered" && !record.answer?.trim()) {
    errors.push("answered questions require an answer");
  }

  if (record.acceptanceState !== "none" && !collaborationRequiresAcceptance(record)) {
    errors.push("acceptanceState requires the corresponding requester and reviewer identities");
  }

  if (record.kind === "work_item" && record.externalContext !== undefined) {
    errors.push(...validateExternalWorkContext(record.externalContext));
  }

  return errors;
}

export function assertValidCollaborationRecord(record: CollaborationRecord): void {
  const errors = validateCollaborationRecord(record);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export function validateCollaborationEvent(
  event: CollaborationEvent,
  record?: CollaborationRecord,
): string[] {
  const errors: string[] = [];

  if (!event.id.trim()) {
    errors.push("collaboration event id is required");
  }

  if (!event.recordId.trim()) {
    errors.push("collaboration event recordId is required");
  }

  if (!event.actorId.trim()) {
    errors.push("collaboration event actorId is required");
  }

  if (record) {
    if (record.id !== event.recordId) {
      errors.push("collaboration event recordId does not match the target record");
    }
    if (record.kind !== event.recordKind) {
      errors.push("collaboration event recordKind does not match the target record");
    }
  }

  if (
    (event.kind === "waiting"
      || event.kind === "progressed"
      || event.kind === "review_requested"
      || event.kind === "done"
      || event.kind === "cancelled"
      || event.kind === "claimed")
    && event.recordKind !== "work_item"
  ) {
    errors.push(`${event.kind} events only apply to work items`);
  }

  return errors;
}

export function assertValidCollaborationEvent(
  event: CollaborationEvent,
  record?: CollaborationRecord,
): void {
  const errors = validateCollaborationEvent(event, record);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}
