import type { InvocationRequest } from "@openscout/protocol";
import { isDeepStrictEqual } from "node:util";

/** Creation timestamps are receipt metadata; execution and reply identity are not. */
export function isIdempotentInvocationRetry(existing: InvocationRequest, incoming: InvocationRequest): boolean {
  return existing.requesterId === incoming.requesterId
    && existing.targetAgentId === incoming.targetAgentId
    && existing.action === incoming.action && existing.task === incoming.task
    && (existing.conversationId ?? null) === (incoming.conversationId ?? null)
    && (existing.messageId ?? null) === (incoming.messageId ?? null)
    && isDeepStrictEqual(existing.context ?? null, incoming.context ?? null)
    && isDeepStrictEqual(existing.execution ?? null, incoming.execution ?? null)
    && isDeepStrictEqual(existing.metadata?.completion ?? null, incoming.metadata?.completion ?? null)
    && isDeepStrictEqual(existing.metadata?.completionRelation ?? null, incoming.metadata?.completionRelation ?? null)
    && existing.ensureAwake === incoming.ensureAwake && existing.stream === incoming.stream;
}
