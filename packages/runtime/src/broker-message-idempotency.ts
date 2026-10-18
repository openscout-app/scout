import { isDeepStrictEqual } from "node:util";
import type { MessageRecord } from "@openscout/protocol";

function clientMessageId(message: MessageRecord): string | null {
  const value = message.metadata?.clientMessageId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isIdempotentMessageRetry(
  existing: MessageRecord,
  incoming: MessageRecord,
): boolean {
  const existingClientId = clientMessageId(existing);
  return Boolean(
    existingClientId
    && existingClientId === clientMessageId(incoming)
    && existing.conversationId === incoming.conversationId
    && existing.actorId === incoming.actorId
    && existing.class === incoming.class
    && existing.body === incoming.body
    && isDeepStrictEqual(existing.metadata?.completionReply ?? null, incoming.metadata?.completionReply ?? null)
    && (existing.replyToMessageId ?? null) === (incoming.replyToMessageId ?? null)
    && (existing.threadConversationId ?? null) === (incoming.threadConversationId ?? null)
    && JSON.stringify(existing.mentions ?? []) === JSON.stringify(incoming.mentions ?? [])
    && JSON.stringify(existing.attachments ?? []) === JSON.stringify(incoming.attachments ?? [])
    && JSON.stringify(existing.speech ?? null) === JSON.stringify(incoming.speech ?? null)
  );
}
