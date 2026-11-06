import type {
  CollaborationRecord,
  CollaborationWaitingOn,
  InvocationRequest,
  MetadataMap,
} from "@openscout/protocol";
import { isWorkItem } from "@openscout/protocol";

export type CollaborationWakeReason =
  | "explicit_target"
  | "next_move_owner"
  | "owner"
  | "asked_of"
  | "requested_by";

type CollaborationInvocationOptions = {
  requesterId: string;
  requesterNodeId: string;
  targetAgentId?: string;
  action?: InvocationRequest["action"];
  task?: string;
  conversationId?: string;
  messageId?: string;
  ensureAwake?: boolean;
  stream?: boolean;
  timeoutMs?: number;
  createdAt?: number;
  metadata?: MetadataMap;
};

function titleCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function waitingOnContext(value: CollaborationWaitingOn | undefined): CollaborationWaitingOn | undefined {
  if (!value) {
    return undefined;
  }

  return {
    kind: value.kind,
    label: value.label,
    targetId: value.targetId,
    metadata: value.metadata,
  };
}

export function resolveCollaborationWakeTarget(
  record: CollaborationRecord,
  explicitTargetAgentId?: string,
): { targetAgentId: string; wakeReason: CollaborationWakeReason } {
  // The requester field and its wake reason differ by kind: a work item is
  // requested_by requestedById, a question is asked_of askedById. Collapsing
  // to requestedById would leave questions unwakeable.
  const requesterCandidate: { targetAgentId?: string; wakeReason: CollaborationWakeReason } =
    isWorkItem(record)
      ? { targetAgentId: record.requestedById, wakeReason: "requested_by" }
      : { targetAgentId: record.askedById, wakeReason: "asked_of" };

  const candidates: Array<{ targetAgentId?: string; wakeReason: CollaborationWakeReason }> = [
    { targetAgentId: explicitTargetAgentId, wakeReason: "explicit_target" },
    { targetAgentId: record.nextMoveOwnerId, wakeReason: "next_move_owner" },
    { targetAgentId: record.ownerId, wakeReason: "owner" },
    requesterCandidate,
  ];

  for (const candidate of candidates) {
    if (candidate.targetAgentId && candidate.targetAgentId.trim().length > 0) {
      return {
        targetAgentId: candidate.targetAgentId.trim(),
        wakeReason: candidate.wakeReason,
      };
    }
  }

  throw new Error(`collaboration record ${record.id} has no wakeable owner`);
}

function defaultTaskForRecord(
  record: CollaborationRecord,
  wakeReason: CollaborationWakeReason,
): string {
  const title = record.title.trim();
  const summary = record.summary?.trim();
  const reasonLabel = titleCase(wakeReason.replaceAll("_", " "));

  if (record.kind === "question") {
    const instruction = (() => {
      switch (record.state) {
        case "open":
          return "Answer this question directly. If you cannot answer, say so and explain what is needed or decline it.";
        case "answered":
          return "Confirm the answer resolves the question, or follow up with what remains unresolved.";
        case "closed":
          return "This question is closed. Review the resolution and report any follow-up.";
        case "declined":
        default:
          return "This question was declined. Report whether it needs to be reopened or asked differently.";
      }
    })();

    return [
      `Wake reason: ${reasonLabel}.`,
      `Question: ${title}`,
      summary ? `Summary: ${summary}` : undefined,
      record.answer?.trim() ? `Answer: ${record.answer.trim()}` : undefined,
      instruction,
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  const instruction = (() => {
    switch (record.state) {
      case "open":
        return "Take ownership of the work and move it forward with a progress update, a waiting transition, or a completion.";
      case "working":
        return "Provide a concrete progress update or move the work into waiting, review, or done.";
      case "waiting":
        return "Resolve or respond to the waiting dependency. If the work is still blocked, explain exactly what remains blocked.";
      case "review":
        return "Review the work and respond with accept, reopen, or concrete changes needed.";
      case "done":
        return "Confirm the completed work and report any follow-up.";
      case "cancelled":
      default:
        return "Review the cancelled work and report whether anything needs to be reopened.";
    }
  })();

  return [
    `Wake reason: ${reasonLabel}.`,
    `Work item: ${title}`,
    summary ? `Summary: ${summary}` : undefined,
    instruction,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

export function buildCollaborationInvocationContext(
  record: CollaborationRecord,
  wakeReason: CollaborationWakeReason,
  targetAgentId: string,
): MetadataMap {
  const collaboration = {
    recordId: record.id,
    kind: record.kind,
    state: record.state,
    title: record.title,
    summary: record.summary,
    ownerId: record.ownerId,
    nextMoveOwnerId: record.nextMoveOwnerId,
    wakeReason,
    targetAgentId,
    conversationId: record.conversationId,
    parentId: record.parentId,
    priority: record.priority,
    acceptanceState: record.acceptanceState,
    waitingOn: record.kind === "work_item" ? waitingOnContext(record.waitingOn) : undefined,
    requestedById: record.kind === "work_item" ? record.requestedById : undefined,
  };

  return {
    collaboration,
    collaborationRecordId: record.id,
    collaborationKind: record.kind,
    collaborationState: record.state,
    ownerId: record.ownerId,
    nextMoveOwnerId: record.nextMoveOwnerId,
    wakeReason,
    targetAgentId,
    acceptanceState: record.acceptanceState,
    waitingOn: record.kind === "work_item" ? waitingOnContext(record.waitingOn) : undefined,
    requestedById: record.kind === "work_item" ? record.requestedById : undefined,
  };
}

export function buildCollaborationInvocation(
  record: CollaborationRecord,
  options: CollaborationInvocationOptions,
): InvocationRequest & { wakeReason: CollaborationWakeReason } {
  const { targetAgentId, wakeReason } = resolveCollaborationWakeTarget(record, options.targetAgentId);
  const context = buildCollaborationInvocationContext(record, wakeReason, targetAgentId);

  return {
    origin: { source: "unknown" },
    id: `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    requesterId: options.requesterId,
    requesterNodeId: options.requesterNodeId,
    targetAgentId,
    action: options.action ?? "consult",
    task: options.task?.trim() || defaultTaskForRecord(record, wakeReason),
    collaborationRecordId: record.id,
    conversationId: options.conversationId ?? record.conversationId,
    messageId: options.messageId,
    context,
    ensureAwake: options.ensureAwake ?? true,
    stream: options.stream ?? false,
    timeoutMs: options.timeoutMs,
    createdAt: options.createdAt ?? Date.now(),
    metadata: {
      source: "collaboration-record",
      collaborationRecordId: record.id,
      collaborationKind: record.kind,
      collaborationState: record.state,
      wakeReason,
      targetAgentId,
      ...(options.metadata ?? {}),
    },
    wakeReason,
  };
}
