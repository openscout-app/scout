import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
import { z } from "zod";
import { ATTACHMENT_LIMITS } from "@openscout/protocol";
import { AttachmentError, postWithAttachmentsSchema, readAttachmentSchema } from "./attachment-contract.js";
import type { BrokerAttachmentService } from "./broker-attachment-service.js";
import { badRequest, json, readRequestBody } from "./broker-http-helpers.js";
import type { HostWebRequest, HostWebResponse } from "./host-web-request.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import { brokerAttributionFor, brokerAttributionFromMetadata, brokerPersonActorIds } from "./broker-attribution.js";
export const ATTACHMENT_READ_PATH = "/v1/attachments/read";
const actorId = z.string().min(1).max(256);
export const attachmentPostHttpSchema = postWithAttachmentsSchema.extend({ actorId }).strict();
export const attachmentReadHttpSchema = readAttachmentSchema.extend({ actorId }).strict();
export const attachmentNotifyHttpSchema = z.object({
  actorId, requestId: z.string().min(1).max(256), body: z.string().trim().min(1).max(64_000),
  attachment: postWithAttachmentsSchema.shape.attachments.element.refine(a => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(a.mediaType)),
}).strict();
const hostSchema = z.object({ path: z.literal(ATTACHMENT_READ_PATH), method: z.literal("POST"), nodeId: actorId.optional(), body: attachmentReadHttpSchema }).strict();
export type AttachmentHttpDeps = {
  service?: BrokerAttachmentService;
  /** Protected local ingress currently buffers at most 16 MiB before routing. */
  uploadRequestBytes?: number;
  nodeId: string;
  snapshot?: () => RuntimeSnapshot;
  peerNode: (keyId: string) => string | undefined;
  forward?: (input: HostWebRequest & { nodeId: string }) => Promise<HostWebResponse>;
  notifyOperator?: (input: z.infer<typeof attachmentNotifyHttpSchema>, principal: { actorId: string; nodeId: string }) => Promise<unknown>;
};
export function attachmentHttpError(response: RuntimeHttpResponseLike, error: unknown) {
  if (error instanceof AttachmentError) json(response, error.status, { error: error.code });
  else badRequest(response, error);
}
function local(request: RuntimeHttpRequestLike) {
  const context = request.transportContext;
  if (!context || context.transport === "remote" || context.peer || context.guest || context.scoped) throw new AttachmentError("attachment_forbidden", 403);
}
function principalFor(request: RuntimeHttpRequestLike, actorId: string, nodeId: string, snapshot?: RuntimeSnapshot, parent?: import("@openscout/protocol").ScoutAttribution) {
  const attribution = brokerAttributionFor({ claimedActorId: actorId, context: request.transportContext,
    personActorIds: brokerPersonActorIds(snapshot ?? ({ actors: {} } as RuntimeSnapshot)), parent });
  return { actorId: attribution.actorId, nodeId, attribution };
}
const uploads = new WeakSet<AttachmentHttpDeps>();
export async function handleAttachmentRoute(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike, url: URL, deps: AttachmentHttpDeps): Promise<boolean> {
  const post = request.method === "POST" && url.pathname === "/v1/messages/with-attachments";
  const notify = request.method === "POST" && url.pathname === "/v1/operator/notify-with-attachment";
  const read = request.method === "POST" && url.pathname === ATTACHMENT_READ_PATH;
  const capability = request.method === "GET" && url.pathname === "/v1/attachments/capability";
  if (!post && !notify && !read && !capability) return false;
  let admittedUpload = false;
  try {
    local(request);
    if (notify && Object.keys(request.headers).some(name => /^(origin|forwarded|x-forwarded-.*|x-openscout-forwarded-.*)$/i.test(name)))
      throw new AttachmentError("attachment_forbidden", 403);
    if (!deps.service) { request.resume(); throw new AttachmentError("attachments_unavailable"); }
    if (capability) { json(response, 200, { available: true, ...ATTACHMENT_LIMITS, requestBytes: deps.uploadRequestBytes ?? ATTACHMENT_LIMITS.requestBytes }); return true; }
    if (post || notify) {
      if (uploads.has(deps)) { request.resume(); throw new AttachmentError("attachments_busy"); }
      uploads.add(deps); admittedUpload = true;
    }
    const raw = await readRequestBody(request, { maxBytes: post || notify ? (deps.uploadRequestBytes ?? ATTACHMENT_LIMITS.requestBytes) : 4096, requireJsonContentType: true });
    if (notify) {
      const input = attachmentNotifyHttpSchema.safeParse(raw);
      if (!input.success) throw new AttachmentError("invalid_attachment_request", 400);
      if (!deps.notifyOperator) throw new AttachmentError("attachments_unavailable");
      json(response, 200, await deps.notifyOperator(input.data, principalFor(request, input.data.actorId, deps.nodeId, deps.snapshot?.())));
      return true;
    }
    const parsed = (post ? attachmentPostHttpSchema : attachmentReadHttpSchema).safeParse(raw);
    if (!parsed.success) throw new AttachmentError("invalid_attachment_request", 400);
    const { actorId, ...input } = parsed.data;
    const replyToMessageId = post && "replyToMessageId" in input ? input.replyToMessageId : undefined;
    const parent = brokerAttributionFromMetadata(replyToMessageId ? deps.snapshot?.().messages?.[replyToMessageId]?.metadata : undefined);
    const principal = principalFor(request, actorId, deps.nodeId, deps.snapshot?.(), parent);
    const result = post ? await deps.service.postWithAttachments(input as Parameters<BrokerAttachmentService["postWithAttachments"]>[0], principal)
      : await deps.service.read(input as Parameters<BrokerAttachmentService["read"]>[0], principal);
    json(response, 200, result);
  } catch (error) { attachmentHttpError(response, error); }
  finally { if (admittedUpload) uploads.delete(deps); }
  return true;
}
/** Fixed local operation on the existing host routes. No URL forwarding or web
 * credential is involved. The destination obtains node authority from the
 * verified peer key, never the request body or forwarding headers. */
export async function executeHostAttachmentRead(raw: unknown, request: RuntimeHttpRequestLike, path: string, deps: AttachmentHttpDeps): Promise<HostWebResponse> {
  try {
    const parsed = hostSchema.safeParse(raw);
    if (!parsed.success) throw new AttachmentError("invalid_attachment_request", 400);
    const input = parsed.data;
    let nodeId: string;
    if (path === "/v1/hosts/web-request") {
      local(request);
      if (!input.nodeId) throw new AttachmentError("attachment_wrong_node", 400);
      if (input.nodeId !== deps.nodeId) {
        if (!deps.forward) throw new AttachmentError("attachments_unavailable");
        return await deps.forward(input as HostWebRequest & { nodeId: string });
      }
      nodeId = deps.nodeId;
    } else {
      if (input.nodeId !== undefined || request.transportContext?.guest || request.transportContext?.scoped) throw new AttachmentError("attachment_forbidden", 403);
      if (request.transportContext?.peer?.tier !== "control") throw new AttachmentError("attachment_forbidden", 403);
      const key = request.transportContext?.peer?.keyId;
      const peerNode = key ? deps.peerNode(key) : undefined;
      if (!peerNode) throw new AttachmentError("attachment_forbidden", 403);
      nodeId = peerNode;
    }
    if (!deps.service) throw new AttachmentError("attachments_unavailable");
    const { actorId, ...read } = input.body;
    return { status: 200, body: await deps.service.read(read, principalFor(request, actorId, nodeId, deps.snapshot?.())) };
  } catch (error) {
    return { status: error instanceof AttachmentError ? error.status : 503, body: { error: error instanceof AttachmentError ? error.code : "attachment_unavailable" } };
  }
}
