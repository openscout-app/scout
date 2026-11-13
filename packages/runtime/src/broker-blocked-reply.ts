import {
  completionReply,
  flightWaitingOn,
  parseReplyWaitingOn,
  type CollaborationRecord,
  type FlightRecord,
  type FlightWaitingOn,
  type MessageRecord,
  type MetadataMap,
} from "@openscout/protocol";
import type { InvocationStatusPatch } from "./broker-local-invocation-helpers.js";

const TERMINAL = ["completed", "failed", "cancelled"];
const KIND_LABEL = { permission: "permission", question: "an answer", review: "review" } as const;

/** The permission request a waiting flight shows the operator, while that request is open. */
export function openPermissionRequestId(
  flight: FlightRecord | undefined,
  read: (id: string) => CollaborationRecord | undefined,
): string | undefined {
  const id = flight?.metadata?.permissionRequestId;
  if (flight?.state !== "waiting" || typeof id !== "string" || !id) return undefined;
  const record = read(id);
  return record?.kind === "question" && record.state === "open" ? id : undefined;
}

/**
 * While its flight waits on an open permission request, a reply cannot end
 * the task: the harness is still showing the prompt. A final reply is recorded
 * as blocked on that request. A failed reply still ends the task.
 */
export function holdFinalReplyWhilePermissionOpen(message: MessageRecord, permissionRequestId: string | undefined): MessageRecord {
  const reply = completionReply(message);
  if (!permissionRequestId || reply?.kind !== "final" || reply.outcome === "failed") return message;
  return { ...message, metadata: { ...message.metadata, completionReply: { ...reply, kind: "blocked", held: "final",
    waitingOn: { kind: "permission", summary: "Waiting on permission", requestRef: permissionRequestId } } } };
}

/** The flight a blocked reply leaves: waiting on what the reply names. */
export function blockedFlight(flight: FlightRecord, message: MessageRecord): FlightRecord | undefined {
  const reply = completionReply(message);
  const waiting = reply?.kind === "blocked" ? parseReplyWaitingOn(reply.waitingOn) : undefined;
  if (!waiting || TERMINAL.includes(flight.state)) return undefined;
  const permissionRequestId = typeof flight.metadata?.permissionRequestId === "string" ? flight.metadata.permissionRequestId : undefined;
  const waitingOn: FlightWaitingOn = {
    ...waiting,
    ...(!waiting.requestRef && waiting.kind === "permission" && permissionRequestId ? { requestRef: permissionRequestId } : {}),
    since: message.createdAt,
    replyMessageId: message.id,
  };
  return { ...flight, state: "waiting", summary: `Waiting on ${KIND_LABEL[waiting.kind]}: ${waiting.summary}`,
    metadata: { ...flight.metadata, waitingOn } };
}

/** A progress reply after a blocked one says the work moved again. */
export function resumedFlight(flight: FlightRecord, message: MessageRecord): FlightRecord | undefined {
  if (completionReply(message)?.kind !== "progress" || TERMINAL.includes(flight.state)) return undefined;
  if (!flightWaitingOn(flight)?.replyMessageId) return undefined;
  const { waitingOn: _waitingOn, ...metadata } = flight.metadata ?? {};
  const permissionOpen = Boolean(flight.metadata?.waitingOnPermission);
  return { ...flight, state: permissionOpen ? "waiting" : "running", summary: permissionOpen ? "Waiting on permission" : message.body,
    metadata: permissionOpen ? { ...metadata, waitingOn: permissionWaitingOn(String(flight.metadata?.permissionRequestId), message.createdAt) } : metadata };
}

function permissionWaitingOn(requestId: string, since: number): FlightWaitingOn {
  return { kind: "permission", summary: "Waiting on permission", requestRef: requestId, since };
}

/**
 * The patch for a permission wait. Opening one records a typed waitingOn
 * unless a blocked reply already set one. Resolving it clears a permission
 * waitingOn for that request; any other blocker stays.
 */
export function permissionWaitPatch(
  current: FlightRecord | undefined,
  state: "waiting" | "running",
  requestId: string | null,
  operatorActorId: string,
  now: number,
): InvocationStatusPatch {
  const existing = flightWaitingOn(current);
  const metadata: MetadataMap = { permissionRequestId: requestId, waitingOnPermission: Boolean(requestId),
    nextMoveOwnerId: requestId ? operatorActorId : null };
  if (requestId) {
    if (!existing) metadata.waitingOn = permissionWaitingOn(requestId, now);
    return { state, summary: "Waiting on permission", metadata };
  }
  const resolved = current?.metadata?.permissionRequestId;
  const clears = existing?.kind === "permission" && (!existing.requestRef || existing.requestRef === resolved);
  if (existing && !clears) return { state: "waiting", metadata };
  return { state, summary: "Permission wait resolved; continuing live session.",
    metadata: { ...metadata, ...(existing ? { waitingOn: undefined } : {}) } };
}

/**
 * The end of a harness turn does not finish a task its agent said is
 * blocked. Only a final reply, a failed reply, or a cancel ends it.
 */
export function holdBlockedFlight(previous: FlightRecord | undefined, next: FlightRecord): FlightRecord {
  const waitingOn = flightWaitingOn(previous);
  if (!previous || !waitingOn?.replyMessageId || TERMINAL.includes(previous.state)) return next;
  if (next.metadata?.completedByBrokerReply === true || next.state === "cancelled") return next;
  const turnEnded = next.state === "completed"
    || (next.state === "failed" && ["empty_reply", "empty_completed_output"].includes(String(next.metadata?.failureStage)));
  if (!turnEnded && next.state !== "running") return next;
  if (next.state === "running" && flightWaitingOn(next)?.replyMessageId !== waitingOn.replyMessageId) return next;
  const { resultReply: _result, failureStage: _failure, ...metadata } = next.metadata ?? {};
  return { ...next, state: "waiting", completedAt: undefined, output: undefined, error: undefined,
    summary: previous.summary, metadata: { ...metadata, waitingOn } };
}
