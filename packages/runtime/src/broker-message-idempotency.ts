import { isDeepStrictEqual } from "node:util";
import { submittedCompletionReply, type MessageRecord, type ScoutCompletionReply } from "@openscout/protocol";

function submittedReply(message: MessageRecord): ScoutCompletionReply | null {
  return submittedCompletionReply(message.metadata?.completionReply as ScoutCompletionReply | undefined) ?? null;
}

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
    && isDeepStrictEqual(submittedReply(existing), submittedReply(incoming))
    && (existing.replyToMessageId ?? null) === (incoming.replyToMessageId ?? null)
    && (existing.threadConversationId ?? null) === (incoming.threadConversationId ?? null)
    && JSON.stringify(existing.mentions ?? []) === JSON.stringify(incoming.mentions ?? [])
    && JSON.stringify(existing.attachments ?? []) === JSON.stringify(incoming.attachments ?? [])
    && JSON.stringify(existing.speech ?? null) === JSON.stringify(incoming.speech ?? null)
  );
}


export class MessageIdConflictError extends Error {
  constructor(messageId: string) { super(`message id ${messageId} is already assigned to a different record`); }
}
