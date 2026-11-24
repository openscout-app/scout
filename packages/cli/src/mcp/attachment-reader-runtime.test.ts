import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ConversationDefinition, MessageRecord, ScoutReplyContext } from "@openscout/protocol";
import { BrokerAttachmentService } from "@openscout/runtime/storage";
// Test fixtures only: production code must not expose an unscoped blob store.
import { AttachmentBlobStore } from "../../../runtime/src/attachment-blob-store.ts";
import { handleAttachmentRoute, executeHostAttachmentRead } from "../../../runtime/src/broker-attachments-http.ts";
import type { RuntimeHttpRequestLike, RuntimeRequestTransportContext } from "../../../runtime/src/portable-types.ts";
import { readScopedAttachment, type AttachmentReaderDependencies } from "./attachment-reader.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Real service, durable CAS and HTTP admission/host schemas. The in-memory
 * canonical writer enforces exact-object admission; no daemon or mesh is started.
 * The peer key/tier here is a fixture, not proof of signed transport. */
async function fixture(remote: boolean, text = "project notes") {
  const owner = remote ? "owner" : "local";
  const root = mkdtempSync(join(tmpdir(), "attachment_authority_")); roots.push(root);
  const messages = new Map<string, MessageRecord>();
  const conversation: ConversationDefinition = { id: "chat-one", kind: "direct", title: "Test", participantIds: ["operator", "scoutbot"], visibility: "private", shareMode: "local", authorityNodeId: owner };
  const store = new AttachmentBlobStore({ supportDirectory: root, references: async () => new Set([...messages.values()].flatMap(m => m.attachments?.flatMap(a => a.blob ? [a.blob.sha256] : []) ?? [])) });
  const service: BrokerAttachmentService = new BrokerAttachmentService({ nodeId: owner, store,
    conversation: id => id === conversation.id ? conversation : undefined,
    authorizeActor: p => p.actorId === "operator" && p.nodeId === owner || p.actorId === "scoutbot" && p.nodeId === "local",
    message: async id => messages.get(id),
    post: async message => { service.assertMessageAdmission(message); messages.set(message.id, message); },
  });
  const post = async (requestId: string, value: string) => (await service.postWithAttachments({ requestId, conversationId: conversation.id, body: "Attached", attachments: [{ data: Buffer.from(value).toString("base64"), mediaType: "text/plain", fileName: "notes.txt" }] }, { actorId: "operator", nodeId: owner })).message;
  const message = await post("first", text);
  let projected = message;
  const context: ScoutReplyContext = { mode: "broker_reply", fromAgentId: "operator", toAgentId: "scoutbot", conversationId: conversation.id, messageId: message.id, replyToMessageId: message.id, replyPath: "final_response" };
  const calls: string[] = [];
  function request(body: unknown, path: string, transportContext: RuntimeRequestTransportContext = { transport: "loopback" }) {
    return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: path, headers: { "content-type": "application/json", host: "localhost" }, transportContext }) as unknown as RuntimeHttpRequestLike;
  }
  const fetchImpl = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = new URL(String(input)).pathname; calls.push(path);
    const body: unknown = JSON.parse(String(init?.body));
    let status = 0, payload = "";
    const response = { writeHead(code: number) { status = code; }, write(value: unknown) { payload += String(value); }, end(value?: unknown) { if (value !== undefined) payload += String(value); }, on() {} };
    if (path === "/v1/hosts/web-request") {
      const operation = await executeHostAttachmentRead(body, request(body, path), path, {
        nodeId: "local", peerNode: () => undefined,
        forward: async envelope => {
          // A wrong owner must not accidentally read from the correct local store.
          return executeHostAttachmentRead({ path: envelope.path, method: envelope.method, body: envelope.body },
            request(envelope.body, "/v1/mesh/web-request", { transport: "remote", peer: { keyId: "verified-local", tier: "control" } }), "/v1/mesh/web-request",
            { service: envelope.nodeId === owner ? service : new BrokerAttachmentService({
              nodeId: envelope.nodeId, store, conversation: id => id === conversation.id ? conversation : undefined,
              authorizeActor: p => p.actorId === "scoutbot" && p.nodeId === "local",
              message: async id => messages.get(id), post: async () => { throw Error("read-only fixture"); },
            }), nodeId: envelope.nodeId, peerNode: key => key === "verified-local" ? "local" : undefined });
        },
      });
      return Response.json(operation);
    }
    if (!await handleAttachmentRoute(request(body, path), response, new URL(path, "http://localhost"), { service, nodeId: "local", peerNode: () => undefined })) throw Error("unexpected route");
    return new Response(payload, { status, headers: { "content-type": "application/json" } });
  }, { preconnect: () => undefined }) as typeof fetch;
  const deps: AttachmentReaderDependencies = { currentContext: () => context, lookupMessage: async () => ({ message: projected, localNodeId: "local" }), brokerUrl: "http://localhost:1", env: {}, fetchImpl };
  const read = () => readScopedAttachment({ attachmentId: message.attachments![0]!.id }, deps);
  return { read, post, message, conversation, calls, project: (value: MessageRecord) => { projected = value; } };
}

for (const remote of [false, true]) {
  const scope = remote ? "authoritative host operation" : "local runtime operation";
  test(`${scope}: successful reads never cache current membership`, async () => {
    const f = await fixture(remote);
    expect(await f.read()).toMatchObject({ supported: true, text: "project notes" });
    f.conversation.participantIds = ["operator"];
    await expect(f.read()).rejects.toMatchObject({ status: 403, code: "attachment_forbidden" });
    expect(f.calls).toEqual([remote ? "/v1/hosts/web-request" : "/v1/attachments/read", remote ? "/v1/hosts/web-request" : "/v1/attachments/read"]);
  });
  test(`${scope}: guessed and unrelated canonical hashes cannot authorize a read`, async () => {
    const f = await fixture(remote);
    const other = await f.post("unrelated", "other content");
    for (const sha256 of ["b".repeat(64), other.attachments![0]!.blob!.sha256]) {
      f.project({ ...f.message, attachments: [{ ...f.message.attachments![0]!, blob: { ...f.message.attachments![0]!.blob!, sha256 } }] });
      await expect(f.read()).rejects.toMatchObject({ status: 503, code: "attachment_unavailable" });
    }
    expect(f.calls).toHaveLength(2);
  });
  test(`${scope}: wrong canonical authority refuses rather than choosing another node`, async () => {
    const f = await fixture(remote);
    f.conversation.authorityNodeId = "wrong-owner";
    await expect(f.read()).rejects.toMatchObject({ status: 409, code: "attachment_wrong_node" });
    expect(f.calls).toHaveLength(1);
  });
  test(`${scope}: wrong projected owner goes only to that node and refuses`, async () => {
    const f = await fixture(remote);
    f.project({ ...f.message, originNodeId: "wrong-owner" });
    await expect(f.read()).rejects.toMatchObject({ status: 409, code: "attachment_wrong_node" });
    expect(f.calls).toEqual(["/v1/hosts/web-request"]);
  });
  test(`${scope}: runtime byte count and 32000-character truncation reach MCP unchanged`, async () => {
    const f = await fixture(remote, "x".repeat(33000));
    expect(await f.read()).toMatchObject({ bytes: 33000, truncated: true, text: "x".repeat(32000), sourceTrust: "untrusted_operator_attachment" });
  });
}
