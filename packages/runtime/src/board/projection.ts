import { createHash } from "node:crypto";
import { BOARD_ADAPTER_ID, type BoardTaskState, type CollaborationRecord, type CollaborationWaitingOn, type ExternalWorkContext, type WorkItemRecord, type WorkItemState } from "@openscout/protocol";
import type { BoardWireMessage, BoardWireTask } from "./wire.js";

/** Deterministic Scout IDs from Board IDs, as the T3 adapter makes them. */
export const boardScopedId = (prefix: string, ...ids: string[]): string =>
  `${prefix}-${createHash("sha256").update(JSON.stringify(ids)).digest("hex").slice(0, 32)}`;
/** The work item for a task root. A dependency resolves to the same ID before its own event arrives. */
export const boardWorkId = (connectionId: string, rootId: string): string => boardScopedId("board-work", connectionId, rootId);
/** A mapped Board actor, keyed on the principal ID, never a handle. Display only: it has no Scout authority. */
export const boardActorId = (connectionId: string, principal: string): string => boardScopedId("board-actor", connectionId, principal);
/** `vercel:user:u_1+scout` -> `vercel:user:u_1`. */
export const boardPrincipalOf = (actor: string): string => actor.split("+")[0] ?? actor;

const STATE: Record<BoardTaskState, WorkItemState> = {
  ready: "open", waiting: "waiting", claimed: "working", blocked: "waiting", failed: "waiting", completed: "done", canceled: "cancelled",
};
export const boardWorkState = (state: BoardTaskState): WorkItemState => STATE[state];

export interface BoardProjectionContext {
  connectionId: string;
  /** The Scout operator: the requester of every Board item. A mapped Board actor cannot confirm acceptance. */
  operatorId: string;
  now: number;
  /** When Scout holds the task's current claim: the agent doing the work. */
  scoutHolder?: { agentId: string; epoch: number };
}

const DELETED_TITLE = "Deleted on the board";

function title(text: string): string {
  const line = text.split("\n").map(part => part.trim()).find(Boolean) ?? "";
  return (line.length > 200 ? `${line.slice(0, 199)}…` : line) || "Board task";
}

function labels(source: Record<string, string>, task: BoardWireTask): string[] {
  const out = Object.entries(source)
    .filter(([key]) => !key.startsWith("board."))
    .map(([key, value]) => value ? `board:${key}=${value}` : `board:${key}`);
  if (task.state === "failed") out.push("failed");
  return [...new Set(out)].slice(0, 64);
}

function waitingOn(connectionId: string, task: BoardWireTask, ownerActor: string): CollaborationWaitingOn | undefined {
  if (task.state === "waiting") {
    const need = task.needs[0];
    return need
      ? { kind: "work_item", label: `Waiting on Board task ${need}`, targetId: boardWorkId(connectionId, need) }
      : { kind: "condition", label: "Waiting on Board" };
  }
  if (task.state === "blocked") {
    const reason = task.blocked?.reason?.trim() || "Blocked on the board";
    return { kind: task.blocked?.kind === "approval" ? "approval" : "actor", label: reason.slice(0, 500), targetId: ownerActor };
  }
  if (task.state === "failed") return { kind: "condition", label: `failed: ${(task.reason ?? "no reason given").slice(0, 480)}` };
  return undefined;
}

/**
 * A task root as a work item. Pure. The Scout `state` is a function of
 * Board's state; Board has no review state, so nothing projects into
 * `review`.
 */
export function boardTaskWorkItem(message: BoardWireMessage, context: BoardProjectionContext): WorkItemRecord {
  const task = message.task;
  if (!task) throw new Error("board_not_a_task: the message carries no task");
  const { connectionId, now } = context;
  const ownerActor = boardActorId(connectionId, boardPrincipalOf(task.owner));
  const state = boardWorkState(task.state);
  const scoutHolds = task.state === "claimed" && context.scoutHolder?.epoch === task.epoch;
  const claimActor = task.claim ? boardActorId(connectionId, boardPrincipalOf(task.claim.actor)) : ownerActor;
  const ownerId = scoutHolds ? context.scoutHolder!.agentId : task.state === "claimed" ? claimActor : ownerActor;
  const terminal = state === "done" || state === "cancelled";
  const createdAt = message.createdAt && Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) : now;
  const deleted = message.deleted;
  const text = deleted ? "" : message.text;
  const summary = deleted ? undefined : task.state === "completed" && task.result ? task.result : text.length > 2000 ? `${text.slice(0, 1999)}…` : text || undefined;
  const waiting = waitingOn(connectionId, task, ownerActor);
  const externalContext: ExternalWorkContext = {
    source: { adapterId: BOARD_ADAPTER_ID, instanceId: connectionId, workItemId: message.id },
    observedAt: now,
    sourceState: task.state,
    board: { id: connectionId, title: message.channel, column: { id: task.state, title: task.state } },
  };
  return {
    id: boardWorkId(connectionId, message.id),
    kind: "work_item",
    title: deleted ? DELETED_TITLE : title(text),
    ...(summary ? { summary } : {}),
    createdById: ownerActor,
    ownerId,
    nextMoveOwnerId: state === "working" ? ownerId : ownerActor,
    requestedById: context.operatorId,
    state,
    acceptanceState: "none",
    labels: deleted ? [] : labels(message.labels, task),
    ...(task.needs.length ? { relations: task.needs.map(need => ({
      kind: "depends_on" as const, targetId: boardWorkId(connectionId, need),
      metadata: { adapterId: BOARD_ADAPTER_ID, instanceId: connectionId, workItemId: need },
    })) } : {}),
    ...(waiting ? { waitingOn: waiting } : {}),
    createdAt,
    updatedAt: Math.max(createdAt, now),
    ...(terminal ? { completedAt: now } : {}),
    externalContext,
    metadata: {
      board: {
        channel: message.channel, version: message.version, epoch: task.epoch, state: task.state,
        owner: boardPrincipalOf(task.owner), ...(task.claim ? { claimActor: task.claim.actor, claimUntil: task.claim.until } : {}),
        ...(scoutHolds ? { scoutHolder: context.scoutHolder!.agentId } : {}),
        ...(deleted ? { deleted: true } : {}),
      },
    },
  };
}

/**
 * Merge a projection over the stored record, writing only the fields the
 * projector owns. Acceptance, the requester, the conversation and the work
 * placement survive every later Board event; spreading the projection over
 * the stored record, as the T3 refresh does, would reset acceptance on each
 * event.
 */
export function mergeBoardProjection(existing: CollaborationRecord | undefined, incoming: WorkItemRecord): WorkItemRecord {
  if (!existing) return incoming;
  if (existing.kind !== "work_item") throw new Error(`board_id_collision: ${incoming.id} is a ${existing.kind}`);
  const { summary: _summary, waitingOn: _waiting, relations: _relations, completedAt: _completed, ...kept } = existing;
  const completedAt = incoming.completedAt === undefined ? undefined : existing.completedAt ?? incoming.completedAt;
  return {
    ...kept,
    title: incoming.title,
    ...(incoming.summary !== undefined ? { summary: incoming.summary } : {}),
    state: incoming.state,
    ownerId: incoming.ownerId,
    nextMoveOwnerId: existing.acceptanceState === "pending" && incoming.state === "done" ? existing.nextMoveOwnerId ?? incoming.nextMoveOwnerId : incoming.nextMoveOwnerId,
    labels: incoming.labels,
    ...(incoming.relations ? { relations: incoming.relations } : {}),
    ...(incoming.waitingOn ? { waitingOn: incoming.waitingOn } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    requestedById: existing.requestedById ?? incoming.requestedById,
    acceptanceState: existing.acceptanceState,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
    externalContext: incoming.externalContext,
    metadata: { ...(existing.metadata ?? {}), board: incoming.metadata?.board },
  };
}
