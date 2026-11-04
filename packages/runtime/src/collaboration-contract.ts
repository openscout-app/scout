import type {
  CollaborationWaitingOn,
  InvocationRequest,
} from "@openscout/protocol";

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return metadata?.[key];
}

function stringValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadataValue(metadata, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function recordFromInvocation(invocation: InvocationRequest, key: string): unknown {
  const contextRecord = metadataValue(invocation.context, key);
  if (typeof contextRecord !== "undefined") {
    return contextRecord;
  }

  const nestedContext = metadataValue(invocation.context, "collaboration");
  if (nestedContext && typeof nestedContext === "object" && !Array.isArray(nestedContext)) {
    const nestedValue = metadataValue(nestedContext as Record<string, unknown>, key);
    if (typeof nestedValue !== "undefined") {
      return nestedValue;
    }
  }

  const metadataRecord = metadataValue(invocation.metadata, key);
  if (typeof metadataRecord !== "undefined") {
    return metadataRecord;
  }

  const nestedMetadata = metadataValue(invocation.metadata, "collaboration");
  if (nestedMetadata && typeof nestedMetadata === "object" && !Array.isArray(nestedMetadata)) {
    return metadataValue(nestedMetadata as Record<string, unknown>, key);
  }

  return undefined;
}

function stringFromInvocation(invocation: InvocationRequest, key: string): string | undefined {
  const value = recordFromInvocation(invocation, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function waitingOnLabel(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const waitingOn = value as CollaborationWaitingOn;
  const kind = typeof waitingOn.kind === "string" ? waitingOn.kind : undefined;
  const label = typeof waitingOn.label === "string" ? waitingOn.label.trim() : "";
  const targetId = typeof waitingOn.targetId === "string" ? waitingOn.targetId.trim() : "";
  const parts = [label || kind, targetId || undefined].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function buildCollaborationContractPrompt(agentId: string): string {
  return [
    "Collaboration contract:",
    `  - Identity: act as the stable OpenScout agent "${agentId}" for this turn`,
    "  - Default loop: orient -> resolve -> choose venue -> keep follow-up in that same venue",
    "  - Treat information-seeking requests as questions; treat durable execution as work with state, context, and artifacts",
    "  - Use canonical lifecycle verbs intentionally: answered, handoff, waiting, review_requested, done, cancelled",
    "  - For task progress use reply with progress=true; work_update is only for work not tied to a task",
    "  - For broker-requested work, acknowledge through the provided reply context/tool when one exists; if no reply context/tool exists, do not invent a second channel",
    "  - @mention another agent only when handing off real work or requesting a concrete answer",
    "  - One target means DM; group coordination means an explicit channel or separate DMs",
    "  - Do not broadcast ordinary delegation or wake agents who do not own the next move",
    "  - Use ask with fyi=true / scout ask --fyi only when no answer or task is expected",
    "  - Use ask / scout ask for any requested reply or owned next step; when in doubt, ask",
    "  - Ask returns on acceptance by default. Wait on its task handle when you need the outcome",
    "  - Reply mode controls how the caller waits; session placement separately controls whether a new harness task is background or openable in the native harness UI",
    "  - Keep broker-visible replies readable, but do not treat local message size as the problem",
    "  - For substantial reports, specs, code, diffs, logs, or research bundles, create or update a durable file when you have write access, then send a short broker reply that points to it",
    "  - If you do not have write access, keep the reply useful inline and say what file you would have created",
    "  - Cite relevant file paths and line numbers instead of pasting large source excerpts into messages",
    "  - If you can answer safely, answer directly",
    "  - If more work is required, make the next responsible agent explicit",
    "  - If blocked, say what you are waiting on and who owns the next move",
    // The operator is the one participant who cannot be woken by a message and
    // will not notice a status line. Naming the verb is the difference between
    // an agent describing that it is stuck and an agent actually raising a
    // human; before this, the contract asked for the former and hoped
    // something downstream inferred the latter.
    "  - If the next move is the OPERATOR's and you cannot proceed without them, run `scout ask --operator \"<what you need>\"` (add repeated --option for a choice, --because for why you are stuck)",
    "  - Use ask --operator --default-action when you can proceed with a safe default; --fyi is news, and --notify deliberately pushes that news",
    "  - If asking for review, say exactly what needs review and who should review it",
    "  - If complete, return the final answer without waking additional agents",
  ].join("\n");
}

export function buildInvocationCollaborationContextPrompt(
  invocation: InvocationRequest,
): string | undefined {
  const recordId = stringFromInvocation(invocation, "recordId")
    ?? stringFromInvocation(invocation, "collaborationRecordId");
  const kind = stringFromInvocation(invocation, "kind")
    ?? stringFromInvocation(invocation, "collaborationKind");
  const state = stringFromInvocation(invocation, "state")
    ?? stringFromInvocation(invocation, "collaborationState");
  const ownerId = stringFromInvocation(invocation, "ownerId");
  const nextMoveOwnerId = stringFromInvocation(invocation, "nextMoveOwnerId");
  const wakeReason = stringFromInvocation(invocation, "wakeReason");
  const targetAgentId = stringFromInvocation(invocation, "targetAgentId");
  const waitingOn = waitingOnLabel(
    recordFromInvocation(invocation, "waitingOn")
      ?? recordFromInvocation(invocation, "waiting_on"),
  );
  const acceptanceState = stringFromInvocation(invocation, "acceptanceState");
  const requestedById = stringFromInvocation(invocation, "requestedById");
  const askedById = stringFromInvocation(invocation, "askedById");
  const askedOfId = stringFromInvocation(invocation, "askedOfId");

  const lines = [
    recordId ? `  - Record: ${kind ? `${kind} ` : ""}${recordId}` : undefined,
    state ? `  - State: ${state}` : undefined,
    ownerId ? `  - Owner: ${ownerId}` : undefined,
    nextMoveOwnerId ? `  - Next move owner: ${nextMoveOwnerId}` : undefined,
    wakeReason ? `  - Wake reason: ${wakeReason}` : undefined,
    targetAgentId ? `  - Wake target: ${targetAgentId}` : undefined,
    waitingOn ? `  - Waiting on: ${waitingOn}` : undefined,
    acceptanceState ? `  - Acceptance: ${acceptanceState}` : undefined,
    requestedById ? `  - Requested by: ${requestedById}` : undefined,
    askedById ? `  - Asked by: ${askedById}` : undefined,
    askedOfId ? `  - Asked of: ${askedOfId}` : undefined,
  ].filter((value): value is string => Boolean(value));

  if (lines.length === 0) {
    return undefined;
  }

  return ["Collaboration context:", ...lines].join("\n");
}
