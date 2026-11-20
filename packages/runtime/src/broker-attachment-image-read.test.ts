import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConversationDefinition, MessageRecord } from "@openscout/protocol";
import { ATTACHMENT_LIMITS } from "@openscout/protocol";
import { AttachmentBlobStore, attachmentHash } from "./attachment-blob-store.js";
import { BrokerAttachmentService } from "./broker-attachment-service.js";
import { Readable } from "node:stream";
import { handleAttachmentRoute, executeHostAttachmentRead } from "./broker-attachments-http.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// A valid PNG with an ancillary text chunk. Exact size, not a forged ref or signature alone.
function image(size: number) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
  const bytes = Buffer.alloc(size, 65), start = png.length - 12, dataSize = size - png.length - 12;
  png.copy(bytes, 0, 0, start); bytes.writeUInt32BE(dataSize, start); bytes.write("tEXt", start + 4); bytes.write("Note\0", start + 8);
  const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); return n; });
  let crc = 0xffffffff; for (let i = start + 4; i < start + 8 + dataSize; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]!) & 255]!;
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, start + 8 + dataSize); png.copy(bytes, size - 12, png.length - 12);
  return bytes;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scout-image-reads-")); roots.push(root);
  const messages = new Map<string, MessageRecord>();
  const conversation: ConversationDefinition = { id: "chat_image", kind: "direct", participantIds: ["agent", "operator"], authorityNodeId: "local", title: "Image", visibility: "private", shareMode: "local" };
  const store = new AttachmentBlobStore({ supportDirectory: root, references: async () => new Set() });
  let authorized = true;
  let messageReads = 0, afterMessageRead: ((count: number) => Promise<void> | void) | undefined;
  const service = new BrokerAttachmentService({ nodeId: "local", operatorActorId: "operator", store,
    conversation: id => id === conversation.id ? conversation : undefined,
    authorizeActor: p => authorized && ["agent", "operator"].includes(p.actorId) && p.nodeId === "local",
    message: async id => { await afterMessageRead?.(++messageReads); return messages.get(id); },
    post: async m => { service.assertMessageAdmission(m); messages.set(m.id, m); },
  });
  const principal = { actorId: "agent", nodeId: "local" };
  const post = (bytes: Buffer) => service.postOperatorNotification({ requestId: "image", conversationId: conversation.id, body: "Review", attachments: [{ data: bytes.toString("base64"), mediaType: "image/png", fileName: "review.png" }] }, principal);
  const request = (m: MessageRecord) => ({ conversationId: m.conversationId, messageId: m.id, blobId: m.attachments![0]!.blob!.sha256, mode: "image" as const });
  return { root, service, store, messages, conversation, principal, post, request,
    revokeAuthority() { authorized = false; },
    onMessageRead(fn: typeof afterMessageRead) { messageReads = 0; afterMessageRead = fn; } };
}
test.each([ATTACHMENT_LIMITS.readBytes + 1, ATTACHMENT_LIMITS.imageBytes])("notification image of %s bytes is returned through the same authorized binding", async size => {
  const f = fixture(), bytes = image(size), posted = await f.post(bytes), read = f.request(posted.message);
  const result = await f.service.read(read, { actorId: "operator", nodeId: "local" });
  expect(result).toMatchObject({ mode: "image", byteSize: size, blobId: read.blobId, messageId: posted.message.id });
  if (result.mode !== "image") throw Error("not image");
  expect(result.data.length).toBe(Math.ceil(size / 3) * 4);
  expect(attachmentHash(Buffer.from(result.data, "base64"))).toBe(attachmentHash(bytes));
  await expect(f.service.read({ ...read, mode: "text" }, f.principal)).rejects.toThrow("attachment_unsupported_mime");
}, 30_000);
test("overmaximum upload/ref and oversized text remain refused", async () => {
  const f = fixture();
  await expect(f.post(image(ATTACHMENT_LIMITS.imageBytes + 1))).rejects.toThrow("attachment_too_large");
  await expect(f.store.read({ sha256: "a".repeat(64), mediaType: "image/png", byteSize: ATTACHMENT_LIMITS.imageBytes + 1 })).rejects.toThrow("attachment_too_large");
  await expect(f.service.postWithAttachments({ requestId: "text", conversationId: f.conversation.id, body: "Text", attachments: [{ data: Buffer.alloc(ATTACHMENT_LIMITS.readBytes + 1, 65).toString("base64"), mediaType: "text/plain" }] }, f.principal)).rejects.toThrow("attachment_too_large");
  const posted = await f.post(image(ATTACHMENT_LIMITS.readBytes + 1)), request = f.request(posted.message);
  f.messages.set(posted.message.id, { ...posted.message, attachments: posted.message.attachments!.map(a => ({ ...a, blob: { ...a.blob!, byteSize: ATTACHMENT_LIMITS.imageBytes + 1 } })) });
  await expect(f.service.read(request, f.principal)).rejects.toThrow("attachment_unavailable");
}, 30_000);
test("large images keep membership, local actor, message and origin authority checks", async () => {
  const f = fixture(), posted = await f.post(image(ATTACHMENT_LIMITS.readBytes + 1)), request = f.request(posted.message);
  for (const principal of [{ actorId: "stranger", nodeId: "local" }, { actorId: "agent", nodeId: "remote" }, { actorId: "operator", nodeId: "remote" }])
    await expect(f.service.read(request, principal)).rejects.toThrow("attachment_forbidden");
  await expect(f.service.read({ ...request, messageId: "another" }, f.principal)).rejects.toThrow("attachment_forbidden");
  f.messages.set(posted.message.id, { ...posted.message, originNodeId: "remote" });
  await expect(f.service.read(request, f.principal)).rejects.toThrow("attachment_forbidden");
  f.messages.set(posted.message.id, posted.message);
  f.conversation.participantIds = ["agent"];
  await expect(f.service.read(request, { actorId: "operator", nodeId: "local" })).rejects.toThrow("attachment_forbidden");
});
test("membership/actor revocation and changed binding/origin after large-file I/O prevent a result", async () => {
  for (const mutation of ["member", "actor", "origin", "binding", "mime", "id-alias", "conversation-alias"] as const) {
    const f = fixture(), posted = await f.post(image(ATTACHMENT_LIMITS.readBytes + 1));
    f.onMessageRead(count => { if (count !== 2) return;
      if (mutation === "member") f.conversation.participantIds = [];
      else if (mutation === "actor") f.revokeAuthority();
      else if (mutation === "id-alias") posted.message.id = "another-message";
      else if (mutation === "conversation-alias") posted.message.conversationId = "another-conversation";
      else f.messages.set(posted.message.id, { ...posted.message,
        ...(mutation === "origin" ? { originNodeId: "remote" } : { attachments: mutation === "binding" ? [] : posted.message.attachments!.map(a => ({ ...a, mediaType: "image/gif" })) }) });
    });
    await expect(f.service.read(f.request(posted.message), f.principal)).rejects.toThrow((mutation === "member" || mutation === "actor") ? "attachment_forbidden" : "attachment_unavailable");
  }
});
test("large same-size corruption never bypasses content-address/signature validation", async () => {
  const f = fixture(), posted = await f.post(image(ATTACHMENT_LIMITS.readBytes + 1)), request = f.request(posted.message);
  const corrupt = image(ATTACHMENT_LIMITS.readBytes + 1); corrupt[100] ^= 1;
  writeFileSync(join(f.root, "blobs/sha256", request.blobId), corrupt);
  await expect(f.service.read(request, f.principal)).rejects.toThrow("attachment_unavailable");
});
test("the existing signed host path cannot lend remote operator authority for a large image", async () => {
  const f = fixture(), posted = await f.post(image(ATTACHMENT_LIMITS.readBytes + 1));
  const result = await executeHostAttachmentRead({ path: "/v1/attachments/read", method: "POST", body: { ...f.request(posted.message), actorId: "operator" } },
    { transportContext: { transport: "remote", peer: { keyId: "verified", tier: "control" } } } as never,
    "/v1/mesh/web-request", { nodeId: "local", service: f.service, peerNode: () => "remote" });
  expect(result).toEqual({ status: 403, body: { error: "attachment_forbidden" } });
});
test("image read admission bounds stalled post-I/O rechecks to two and releases capacity on refusal", async () => {
  const f = fixture(), posted = await f.post(image(ATTACHMENT_LIMITS.readBytes + 1)), request = f.request(posted.message);
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  // The first result already holds bytes while its final authorization read is stalled.
  f.onMessageRead(async count => { if (count === 2) { entered(); await gate; } });
  const first = f.service.read(request, f.principal); await started;
  let secondEntered!: () => void; const secondStart = new Promise<void>(r => { secondEntered = r; });
  f.onMessageRead(async count => { if (count === 1) { secondEntered(); await gate; } });
  const second = f.service.read(request, f.principal); await secondStart;
  await expect(f.service.read(request, f.principal)).rejects.toThrow("attachments_busy");
  f.conversation.participantIds = []; release();
  await expect(first).rejects.toThrow("attachment_forbidden"); await expect(second).rejects.toThrow("attachment_forbidden");
  f.onMessageRead(undefined); f.conversation.participantIds = ["agent", "operator"];
  expect((await f.service.read(request, f.principal)).mode).toBe("image");
});

test("the existing local HTTP read returns a large authorized notification image without a new endpoint", async () => {
  const f = fixture(), posted = await f.post(image(ATTACHMENT_LIMITS.readBytes + 1));
  const body = { ...f.request(posted.message), actorId: "operator" };
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: "POST", url: "/v1/attachments/read", headers: { "content-type": "application/json" }, transportContext: { transport: "unix-socket", operator: true } });
  let status = 0, encoded = "";
  const res = { writeHead(code: number) { status = code; }, end(value: string) { encoded = value; } };
  await handleAttachmentRoute(req as never, res, new URL("http://localhost/v1/attachments/read"), { nodeId: "local", service: f.service, peerNode: () => undefined });
  expect(status).toBe(200);
  const result = JSON.parse(encoded);
  expect(result.byteSize).toBe(ATTACHMENT_LIMITS.readBytes + 1);
  expect(attachmentHash(Buffer.from(result.data, "base64"))).toBe(body.blobId);
});
