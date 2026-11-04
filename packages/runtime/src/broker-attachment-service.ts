import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { ATTACHMENT_LIMITS, type AttachmentReadResult, type ConversationDefinition, type MessageRecord, type PostWithAttachments, type ReadAttachment } from "@openscout/protocol";
import { AttachmentBlobStore, attachmentHash } from "./attachment-blob-store.js";
import { AttachmentError, blobRefSchema, decodeAttachment, imageMimes, isTextMime, postWithAttachmentsSchema, readAttachmentSchema, validateAttachmentBytes } from "./attachment-contract.js";
import { isIdempotentMessageRetry } from "./broker-message-idempotency.js";
export type AttachmentPrincipal = { actorId: string; nodeId: string };
export type BrokerAttachmentServiceOptions = {
  nodeId: string;
  store?: AttachmentBlobStore;
  conversation: (id: string) => ConversationDefinition | undefined;
  /** Runtime composition verifies local/peer actor authority; no operator fallback. */
  authorizeActor: (principal: AttachmentPrincipal) => boolean;
  message: (id: string) => Promise<MessageRecord | undefined>;
  post: (message: MessageRecord) => Promise<unknown>;
  /** Fixed broker composition, never a caller-selected notification target. */
  operatorActorId?: string;
  operatorReturnAddress?: (message: MessageRecord) => unknown;
  now?: () => number;
};
export class BrokerAttachmentService {
  private readonly admitted = new WeakSet<MessageRecord>();
  private readonly notifications = new WeakSet<MessageRecord>();
  private uploadActive = false;
  private activeImageReads = 0;
  constructor(private readonly options: BrokerAttachmentServiceOptions) {}
  private available(): AttachmentBlobStore {
    if (!this.options.store) throw new AttachmentError("attachments_unavailable");
    return this.options.store;
  }
  private member(conversationId: string, principal: AttachmentPrincipal) {
    if (!this.options.authorizeActor(principal)) throw new AttachmentError("attachment_forbidden", 403);
    const conversation = this.options.conversation(conversationId);
    if (!conversation || !conversation.participantIds.includes(principal.actorId)) throw new AttachmentError("attachment_forbidden", 403);
    if (conversation.authorityNodeId !== this.options.nodeId) throw new AttachmentError("attachment_wrong_node", 409);
    return conversation;
  }
  assertLocalActor(principal: AttachmentPrincipal): void {
    this.available();
    if (principal.nodeId !== this.options.nodeId || !this.options.authorizeActor(principal))
      throw new AttachmentError("attachment_forbidden", 403);
  }
  async postOperatorNotification(input: PostWithAttachments, principal: AttachmentPrincipal) {
    const operator = this.options.operatorActorId;
    this.assertLocalActor(principal);
    const parsed = postWithAttachmentsSchema.safeParse(input);
    if (!parsed.success) throw new AttachmentError("invalid_attachment_request", 400);
    this.notificationConversation(parsed.data.conversationId, principal);
    if (parsed.data.replyToMessageId !== undefined || parsed.data.attachments.length !== 1
      || !imageMimes.has(parsed.data.attachments[0]!.mediaType) || !parsed.data.body.trim()) throw new AttachmentError("invalid_attachment_notification", 400);
    if (this.uploadActive) throw new AttachmentError("attachments_busy");
    this.uploadActive = true;
    try { return await this.postAdmitted({ ...parsed.data, body: parsed.data.body.trim() }, principal, operator); }
    finally { this.uploadActive = false; }
  }
  private notificationConversation(id: string, principal: AttachmentPrincipal) {
    const conversation = this.member(id, principal);
    const operator = this.options.operatorActorId;
    if (!operator || conversation.kind !== "direct" || !conversation.participantIds.includes(operator)
      || conversation.participantIds.some(id => id !== operator && id !== principal.actorId))
      throw new AttachmentError("invalid_attachment_notification", 400);
  }
  /** Called INSIDE the broker's serialized canonical writer, after file barriers.
   * Every other local write path refuses typed refs, even a caller who knows a hash. */
  assertMessageAdmission = (message: MessageRecord): void => {
    if (!message.attachments?.some(a => a.blob !== undefined)) return;
    if (!this.admitted.has(message)) throw new AttachmentError("attachment_inline_write_required", 400);
    this.member(message.conversationId, { actorId: message.actorId, nodeId: this.options.nodeId });
    if (this.notifications.has(message)) this.notificationConversation(message.conversationId, { actorId: message.actorId, nodeId: this.options.nodeId });
    for (const attachment of message.attachments) {
      const ref = blobRefSchema.parse(attachment.blob);
      if (attachment.mediaType !== ref.mediaType || attachment.url !== undefined || attachment.blobKey !== undefined) throw new AttachmentError("invalid_attachment_binding", 400);
    }
  };
  /** Bind an inline task image to its canonical message before the task/message transaction. */
  async withTaskImage<T>(message: MessageRecord, upload: import("@openscout/protocol").AttachmentUpload, commit: () => Promise<T>): Promise<T> {
    this.assertLocalActor({ actorId: message.actorId, nodeId: this.options.nodeId });
    this.member(message.conversationId, { actorId: message.actorId, nodeId: this.options.nodeId });
    const parsed = postWithAttachmentsSchema.shape.attachments.element.parse(upload);
    if (!imageMimes.has(parsed.mediaType)) throw new AttachmentError("invalid_task_image", 400);
    const bytes = decodeAttachment(parsed.data); validateAttachmentBytes(bytes, parsed.mediaType);
    if (this.uploadActive) throw new AttachmentError("attachments_busy");
    this.uploadActive = true;
    try {
      const ref = { sha256: attachmentHash(bytes), mediaType: parsed.mediaType, byteSize: bytes.length };
      return await this.available().withBlobs([{ ref, bytes }], async () => {
        message.attachments = [...(message.attachments ?? []), { id: `${message.id}.image`, mediaType: ref.mediaType,
          fileName: parsed.fileName, blob: ref }];
        this.admitted.add(message);
        try { return await commit(); } finally { this.admitted.delete(message); }
      });
    } finally { this.uploadActive = false; }
  }

  async postWithAttachments(input: PostWithAttachments, principal: AttachmentPrincipal) {
    if (this.uploadActive) throw new AttachmentError("attachments_busy");
    this.uploadActive = true;
    try { return await this.postAdmitted(input, principal); }
    finally { this.uploadActive = false; }
  }
  private async postAdmitted(input: PostWithAttachments, principal: AttachmentPrincipal, notifyOperator?: string) {
    const store = this.available();
    const parsed = postWithAttachmentsSchema.safeParse(input);
    if (!parsed.success) throw new AttachmentError("invalid_attachment_request", 400);
    const request = parsed.data;
    if (principal.nodeId !== this.options.nodeId) throw new AttachmentError("attachment_forbidden", 403);
    const conversation = this.member(request.conversationId, principal);
    if (request.attachments.reduce((n,a) => n+a.data.length,0) > Math.ceil(ATTACHMENT_LIMITS.imageBytes/3)*4 + 16) throw new AttachmentError("attachment_too_large", 413);
    const blobs = request.attachments.map(upload => {
      const bytes = decodeAttachment(upload.data); validateAttachmentBytes(bytes, upload.mediaType);
      return { ref: { sha256: attachmentHash(bytes), mediaType: upload.mediaType, byteSize: bytes.length }, bytes };
    });
    // A 25 MiB image fits the bounded 36 MiB JSON upload route. Multiple files
    // share this decoded budget; no larger hidden aggregate is admitted.
    if (blobs.reduce((n,b) => n+b.bytes.length,0) > ATTACHMENT_LIMITS.imageBytes) throw new AttachmentError("attachment_too_large", 413);
    const id = `msg.request.${createHash("sha256").update(JSON.stringify([principal.actorId, request.requestId])).digest("hex")}`;
    const message: MessageRecord = {
      id, requestId: request.requestId, conversationId: conversation.id, actorId: principal.actorId,
      originNodeId: this.options.nodeId, class: "agent", body: request.body,
      ...(request.replyToMessageId ? { replyToMessageId: request.replyToMessageId } : {}),
      visibility: conversation.visibility, policy: "durable", createdAt: (this.options.now ?? Date.now)(),
      metadata: { clientMessageId: id, ...(notifyOperator ? {
        source: "scout-notify", operatorSignal: { kind: "notify", blocking: false, replyExpectation: "none" },
        operatorSignalId: id, relayChannel: "dm", relayTarget: notifyOperator,
        relayTargetIds: principal.actorId === notifyOperator ? [] : [notifyOperator], relayMessageId: id,
      } : {}) },
      ...(notifyOperator ? { mentions: [{ actorId: notifyOperator, label: "@operator" }],
        audience: { reason: "direct_message" as const, notify: principal.actorId === notifyOperator ? [] : [notifyOperator] } } : {}),
      attachments: blobs.map((blob,i) => ({ id: `${id}.attachment.${i}`, mediaType: blob.ref.mediaType, blob: blob.ref,
        ...(request.attachments[i]!.fileName ? { fileName: request.attachments[i]!.fileName } : {}) })),
    };
    const retry = async () => {
      this.member(conversation.id, principal);
      if (notifyOperator) this.notificationConversation(conversation.id, principal);
      const existing = await this.options.message(id);
      if (existing && (!isIdempotentMessageRetry(existing, message)
        || existing.originNodeId !== message.originNodeId
        || !isDeepStrictEqual(existing.metadata?.operatorSignal ?? null, message.metadata?.operatorSignal ?? null)
        || (notifyOperator && existing.metadata?.relayTarget !== notifyOperator))) throw new AttachmentError("attachment_request_conflict", 409);
      return existing;
    };
    const existing = await retry();
    if (existing) return { ok: true as const, message: existing, duplicate: true };
    if (request.replyToMessageId) {
      const parent = await this.options.message(request.replyToMessageId);
      if (!parent || parent.conversationId !== conversation.id) throw new AttachmentError("attachment_forbidden", 403);
    }
    return store.withBlobs(blobs, async () => {
      const accepted = await retry();
      if (accepted) return { ok: true as const, message: accepted, duplicate: true };
      if (notifyOperator) {
        message.metadata!.returnAddress = this.options.operatorReturnAddress?.(message);
        this.notifications.add(message);
      }
      this.admitted.add(message);
      try {
        await this.options.post(message);
        return { ok: true as const, message, duplicate: false };
      } finally { this.admitted.delete(message); this.notifications.delete(message); }
    });
  }
  async read(input: ReadAttachment, principal: AttachmentPrincipal): Promise<AttachmentReadResult> {
    if (input?.mode !== "image") return this.readAdmitted(input, principal);
    // Hold image admission through post-I/O authorization and encoding, not just file I/O.
    if (this.activeImageReads >= 2) throw new AttachmentError("attachments_busy");
    this.activeImageReads++;
    try { return await this.readAdmitted(input, principal); }
    finally { this.activeImageReads--; }
  }
  private async readAdmitted(input: ReadAttachment, principal: AttachmentPrincipal): Promise<AttachmentReadResult> {
    const store = this.available();
    const parsed = readAttachmentSchema.safeParse(input);
    if (!parsed.success) throw new AttachmentError("invalid_attachment_request", 400);
    const request = parsed.data;
    this.member(request.conversationId, principal);
    const message = await this.options.message(request.messageId);
    if (!message || message.id !== request.messageId || message.conversationId !== request.conversationId
      || message.originNodeId !== this.options.nodeId) throw new AttachmentError("attachment_forbidden", 403);
    const attachment = message.attachments?.find(a => a.blob?.sha256 === request.blobId);
    if (!attachment) throw new AttachmentError("attachment_unavailable");
    const ref = blobRefSchema.safeParse(attachment.blob);
    if (!ref.success || ref.data.mediaType !== attachment.mediaType) throw new AttachmentError("attachment_unavailable");
    if (request.mode === "text" ? !isTextMime(ref.data.mediaType) : !imageMimes.has(ref.data.mediaType)) throw new AttachmentError("attachment_unsupported_mime", 415);
    const bytes = await store.read(ref.data);
    validateAttachmentBytes(bytes, ref.data.mediaType);
    // Recheck both membership and the current binding after asynchronous IO.
    const current = await this.options.message(request.messageId);
    this.member(request.conversationId, principal);
    if (current?.id !== request.messageId || current.originNodeId !== this.options.nodeId
      || current.conversationId !== request.conversationId || !current.attachments?.some(a => a.mediaType === ref.data.mediaType && a.blob?.sha256 === ref.data.sha256 && a.blob.mediaType === ref.data.mediaType && a.blob.byteSize === ref.data.byteSize)) throw new AttachmentError("attachment_unavailable");
    const base = { blobId: request.blobId, messageId: request.messageId, mediaType: ref.data.mediaType, byteSize: bytes.length, ...(attachment.fileName ? { fileName: attachment.fileName } : {}) };
    if (request.mode === "image") return { ...base, mode: "image", data: bytes.toString("base64") };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ...base, mode: "text", text: text.slice(0, ATTACHMENT_LIMITS.textCharacters), truncated: text.length > ATTACHMENT_LIMITS.textCharacters, sourceTrust: "untrusted_attachment" };
  }
}
