import { epochMs, type MessageAttachment, type MessageMention, type MessageRecord } from "@openscout/protocol";

/** JSON-column normalization shared with the persisted message representation. */
function jsonCanonical<T>(value: T | null | undefined): T | undefined {
  return value === undefined || value === null
    ? undefined
    : JSON.parse(JSON.stringify(value)) as T;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalMentions(mentions: MessageMention[] | undefined): MessageMention[] | undefined {
  // The child table cannot distinguish [] from absent — no rows reads back
  // as undefined, so collapse both to undefined.
  if (mentions === undefined || mentions.length === 0) {
    return undefined;
  }
  // message_mentions is keyed (message_id, actor_id): the write path's
  // INSERT OR REPLACE keeps the last mention per actor, and reads order by
  // actor_id. Mentions are a set, not a list — the canonical form is that set.
  const byActorId = new Map<string, MessageMention>();
  for (const mention of mentions) {
    byActorId.set(mention.actorId, {
      actorId: mention.actorId,
      label: mention.label ?? undefined,
    });
  }
  return [...byActorId.values()].sort((a, b) => compareIds(a.actorId, b.actorId));
}

function canonicalAttachments(attachments: MessageAttachment[] | undefined): MessageAttachment[] | undefined {
  if (attachments === undefined || attachments.length === 0) {
    return undefined;
  }
  // message_attachments is keyed by (message id, attachment id): INSERT OR REPLACE keeps
  // the last write per id and reads order by id. The canonical form is that set.
  const byId = new Map<string, MessageAttachment>();
  for (const attachment of attachments) {
    byId.set(attachment.id, {
      id: attachment.id,
      mediaType: attachment.mediaType,
      fileName: attachment.fileName ?? undefined,
      ...(attachment.blob ? { blob: jsonCanonical(attachment.blob) } : {}),
      blobKey: attachment.blobKey ?? undefined,
      url: attachment.url ?? undefined,
      metadata: jsonCanonical(attachment.metadata),
    });
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

/** Pure normalization used by SQL rows and mesh duplicate comparisons. */
export function canonicalMessageRecord(record: MessageRecord): MessageRecord {
  const r = record as unknown as Record<string, unknown>;
  return {
    id: r.id,
    conversationId: r.conversationId,
    actorId: r.actorId,
    originNodeId: r.originNodeId,
    class: r.class,
    body: r.body,
    replyToMessageId: r.replyToMessageId ?? undefined,
    threadConversationId: r.threadConversationId ?? undefined,
    mentions: canonicalMentions(r.mentions as MessageMention[] | undefined),
    attachments: canonicalAttachments(r.attachments as MessageAttachment[] | undefined),
    speech: jsonCanonical(r.speech),
    audience: jsonCanonical(r.audience),
    visibility: r.visibility,
    policy: r.policy,
    createdAt: epochMs(r.createdAt as number | null | undefined) ?? r.createdAt,
    metadata: jsonCanonical(r.metadata),
  } as unknown as MessageRecord;
}

/** Receiving brokers derive attribution independently; it is not message identity. */
export function canonicalMessageIdentity(record: MessageRecord): MessageRecord {
  const canonical = canonicalMessageRecord(record);
  if (!canonical.metadata || !("attribution" in canonical.metadata)) return canonical;
  const metadata = { ...canonical.metadata };
  delete metadata.attribution;
  return { ...canonical, metadata: Object.keys(metadata).length ? metadata : undefined };
}
