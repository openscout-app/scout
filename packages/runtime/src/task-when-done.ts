import type { InvocationRequest, ScoutReplyContext } from "@openscout/protocol";

/**
 * The requester's closing step (`scout ask --when-done`), as the worker sees
 * it. The step is flattened to one line. `requesterNodeId` is set only when the
 * requester is on another host, where the worker cannot act for them.
 */
export function invocationWhenDone(
  invocation: Pick<InvocationRequest, "metadata" | "requesterNodeId" | "targetNodeId">,
): ScoutReplyContext["whenDone"] {
  const raw = invocation.metadata?.whenDone;
  const step = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!step) return undefined;
  const elsewhere = Boolean(invocation.targetNodeId && invocation.requesterNodeId
    && invocation.targetNodeId !== invocation.requesterNodeId);
  return { step, ...(elsewhere ? { requesterNodeId: invocation.requesterNodeId } : {}) };
}

/** The block in the full delivery prompt, after the reply-mode lines. */
export function buildWhenDonePromptLines(whenDone: ScoutReplyContext["whenDone"]): string[] {
  if (!whenDone) return [];
  return [
    "",
    "<!-- SCOUT WHEN DONE -->",
    "> **When you finish:** the requester asked for this as the last step of the task:",
    `> ${whenDone.step}`,
    "> Do it once the work is done and before your final reply. Then say in that reply that you did it, or why you could not.",
    ...(whenDone.requesterNodeId ? [
      `> The requester is on another host (${whenDone.requesterNodeId}). You cannot act on their screen from here, so put the link or path in your final reply and say that the step is theirs to run.`,
    ] : []),
  ];
}

/** One line for deliveries that carry the raw task instead of the full prompt. */
export function whenDoneLine(
  invocation: Pick<InvocationRequest, "metadata" | "requesterNodeId" | "targetNodeId">,
): string | undefined {
  const whenDone = invocationWhenDone(invocation);
  if (!whenDone) return undefined;
  return whenDone.requesterNodeId
    ? `When you finish, the requester (on host ${whenDone.requesterNodeId}) asked for: ${whenDone.step}. You cannot act on their host, so put the link or path in your final reply.`
    : `When you finish, before your final reply: ${whenDone.step}. Say in that reply that you did it, or why you could not.`;
}
