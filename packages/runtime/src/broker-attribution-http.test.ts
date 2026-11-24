import { expect, test } from "bun:test";
import { join } from "node:path";
import type { InvocationRequest, MessageRecord, QuestionRecord, RuntimeSnapshot, WorkItemRecord } from "@openscout/protocol";
import { requestScoutBrokerJson } from "./broker-api.js";
import { UNAUTHENTICATED_LOCAL_ACTOR_ID } from "./broker-attribution.js";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

async function post(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function snapshot(baseUrl: string): Promise<RuntimeSnapshot> {
  return (await fetch(`${baseUrl}/v1/snapshot`)).json() as Promise<RuntimeSnapshot>;
}

function delivery(actorId: string, extra: Record<string, unknown> = {}) {
  return {
    caller: { actorId },
    target: { kind: "agent_id", agentId: "fabric" },
    body: "Attribution test request",
    intent: "consult",
    ...extra,
  };
}

test("unsigned person claims become unverified; signed actors keep their true identities", async () => {
  const h = await broker.startBroker();
  await broker.seedBasicConversation(h);
  await broker.seedHangingReceiver(h, "fabric");

  const rawMessage = await post(h.baseUrl, "/v1/messages", {
    id: "attribution-raw-message", conversationId: "channel.shared", actorId: "operator", originNodeId: h.nodeId,
    class: "agent", body: "Unsigned operator claim", audience: { delivery: "none" }, visibility: "workspace", policy: "durable", createdAt: Date.now(),
  });
  expect(rawMessage.status).toBe(200);
  const rawDelivery = await post(h.baseUrl, "/v1/deliver", delivery("operator"));
  expect(rawDelivery.status).toBe(202);
  const rawRecord = await post(h.baseUrl, "/v1/collaboration/records", {
    id: "attribution-raw-question", kind: "question", state: "open", acceptanceState: "none", title: "Unsigned question",
    createdById: "operator", askedById: "operator", ownerId: "fabric", nextMoveOwnerId: "fabric", createdAt: 1, updatedAt: 1,
  });
  expect(rawRecord.status).toBe(200);

  const signedDelivery = await broker.postJson<any>(h.baseUrl, "/v1/deliver", delivery("operator"));
  const signedAgent = await broker.postJson<any>(h.baseUrl, "/v1/deliver", delivery("fabric"));
  const state = await snapshot(h.baseUrl);
  expect(state.messages["attribution-raw-message"]?.actorId).toBe(UNAUTHENTICATED_LOCAL_ACTOR_ID);
  expect(state.messages["attribution-raw-message"]?.metadata?.attribution).toMatchObject({
    actorId: UNAUTHENTICATED_LOCAL_ACTOR_ID, rootActorId: UNAUTHENTICATED_LOCAL_ACTOR_ID, source: "unverified", claimedActorId: "operator",
  });
  expect(state.invocations[(rawDelivery.body.flight as { invocationId: string }).invocationId]?.requesterId).toBe(UNAUTHENTICATED_LOCAL_ACTOR_ID);
  expect(state.collaborationRecords["attribution-raw-question"]).toMatchObject({
    createdById: UNAUTHENTICATED_LOCAL_ACTOR_ID, askedById: UNAUTHENTICATED_LOCAL_ACTOR_ID,
    metadata: { attribution: { actorId: UNAUTHENTICATED_LOCAL_ACTOR_ID, source: "unverified", claimedActorId: "operator" } },
  });
  expect(state.invocations[(signedDelivery.flight as { invocationId: string }).invocationId]).toMatchObject({
    requesterId: "operator", metadata: { attribution: { actorId: "operator", rootActorId: "operator", source: "local-admin" } },
  });
  expect(state.invocations[(signedAgent.flight as { invocationId: string }).invocationId]).toMatchObject({
    requesterId: "fabric", metadata: { attribution: { actorId: "fabric", rootActorId: "fabric", source: "local-admin" } },
  });
}, 15_000);

test("replies and work review preserve the root actor without changing the acting agent", async () => {
  const h = await broker.startBroker();
  await broker.seedBasicConversation(h);
  await broker.seedHangingReceiver(h, "fabric");

  const parent = await broker.postJson<any>(h.baseUrl, "/v1/deliver", delivery("operator", {
    workItem: { id: "attribution-work", title: "Attributed work", acceptanceState: "pending" },
  }));
  const child = await post(h.baseUrl, "/v1/messages", {
    id: "attribution-child-reply", conversationId: parent.conversation.id, actorId: "fabric", originNodeId: h.nodeId,
    class: "agent", body: "Delegated reply", replyToMessageId: parent.message.id,
    audience: { delivery: "none" }, visibility: "private", policy: "durable", createdAt: Date.now(),
  });
  expect(child.status).toBe(200);
  const state = await snapshot(h.baseUrl);
  expect(state.messages["attribution-child-reply"]).toMatchObject({
    actorId: "fabric",
    metadata: { attribution: { actorId: "fabric", rootActorId: "operator", source: "unverified" } },
  });
  expect(state.collaborationRecords["attribution-work"]).toMatchObject({
    createdById: "operator", metadata: { attribution: { actorId: "operator", rootActorId: "operator", source: "local-admin" } },
  });

  const moved = await broker.postJson<any>(h.baseUrl, "/v1/work/move", { workId: "attribution-work", to: "done", actorId: "fabric" });
  const reviewed = await post(h.baseUrl, "/v1/work/review", {
    workId: "attribution-work", moveId: moved.move.id, verdict: "confirm", revision: moved.move.revision, actorId: "operator",
  });
  expect(reviewed.status).toBe(200);
  expect(reviewed.body.move.reviewedById).toBe(UNAUTHENTICATED_LOCAL_ACTOR_ID);
  const events = await (await fetch(`${h.baseUrl}/v1/collaboration/events?recordId=attribution-work`)).json() as Array<{ metadata?: Record<string, any> }>;
  const reviewEvent = events.find(event => event.metadata?.workReview);
  expect(reviewEvent?.metadata?.workReview.attribution).toMatchObject({
    actorId: UNAUTHENTICATED_LOCAL_ACTOR_ID, rootActorId: "operator", source: "unverified", claimedActorId: "operator",
  });
}, 15_000);

test("person registration and operator-only routes require operator proof", async () => {
  const h = await broker.startBroker();
  await broker.seedBasicConversation(h);

  const person = await post(h.baseUrl, "/v1/actors", { id: "operator", kind: "person", displayName: "Operator" });
  expect(person.status).toBe(403);
  expect(person.body.error).toBe("person_attribution_unverified");
  await broker.postJson(h.baseUrl, "/v1/actors", { id: "operator", kind: "person", displayName: "Operator" });

  const body = { requestId: "missing-permission", version: "v", decision: "once" };
  expect((await post(h.baseUrl, "/v1/permissions/decide", body)).status).toBe(403);
  const signed = await broker.postJsonStatus(h.baseUrl, "/v1/permissions/decide", body);
  expect(signed.status).toBe(410);
  expect(signed.body).toMatchObject({ outcome: "ended" });
  expect((await post(h.baseUrl, "/v1/operator-requests/dismiss", { requestId: "missing" })).status).toBe(403);
  expect((await post(h.baseUrl, "/v1/tasks/ready/decide", { ref: "missing", decision: "hold" })).status).toBe(403);
  const answer = { id: "missing-ask", requestId: "decision-missing", answer: { kind: "text", text: "Go ahead" } };
  const unprovenAnswer = await post(h.baseUrl, "/v1/decisions/answer", answer);
  expect(unprovenAnswer.status).toBe(403);
  expect(unprovenAnswer.body.error).toBe("operator_attribution_required");
  // Signed, the route itself answers: the ask does not exist.
  const provenAnswer = await broker.postJsonStatus(h.baseUrl, "/v1/decisions/answer", answer);
  expect(provenAnswer.status).not.toBe(403);
  expect((provenAnswer.body as { error?: string }).error).not.toBe("operator_attribution_required");
  expect((await post(h.baseUrl, "/v1/commands", { kind: "message.post", message: {} })).status).toBe(403);
}, 15_000);

test("typed replies, mesh, and A2A overwrite forged verification metadata", async () => {
  const h = await broker.startBroker();
  await broker.seedBasicConversation(h);
  await broker.seedHangingReceiver(h, "fabric");
  const parent = await broker.postJson<any>(h.baseUrl, "/v1/deliver", delivery("operator"));
  const reply = await post(h.baseUrl, "/v1/messages/reply", {
    to: parent.message.id, senderId: "operator", requestId: "typed-reply", body: "Typed forged reply",
  });
  expect(reply.status).toBe(400);
  const signedReply = await broker.postJson<any>(h.baseUrl, "/v1/messages/reply", {
    to: parent.message.id, senderId: "operator", requestId: "typed-signed-reply", body: "Typed forged reply",
  });
  expect(signedReply.ok).toBe(true);

  const beforeMesh = await snapshot(h.baseUrl);
  const bundle = {
    originNode: beforeMesh.nodes[h.nodeId],
    actors: [beforeMesh.actors.operator],
    agents: [beforeMesh.agents.fabric],
    conversation: beforeMesh.conversations["channel.shared"],
    bindings: [],
    message: {
      id: "mesh-forged", conversationId: "channel.shared", actorId: "operator", originNodeId: h.nodeId,
      class: "agent", body: "Mesh forged operator", visibility: "workspace", policy: "durable", createdAt: Date.now(),
      metadata: { attribution: { actorId: "operator", rootActorId: "operator", source: "local-admin" } },
    },
  };
  const mesh = await post(h.baseUrl, "/v1/mesh/messages", bundle);
  expect(mesh.status).toBe(200);

  const a2a = await post(h.baseUrl, "/v1/a2a/agents/fabric/rpc", {
    jsonrpc: "2.0", id: "a2a-forged", method: "message/send",
    params: {
      message: {
        role: "ROLE_USER", messageId: "a2a-forged", contextId: "channel.shared", parts: [{ text: "A2A forged operator" }],
        metadata: { scoutRequesterId: "operator", attribution: { actorId: "operator", rootActorId: "operator", source: "local-admin" } },
      },
      metadata: { targetAgentId: "fabric", attribution: { actorId: "operator", rootActorId: "operator", source: "local-admin" } },
      configuration: { blocking: false },
    },
  });
  expect(a2a.status).toBe(200);

  const state = await snapshot(h.baseUrl);
  const typed = Object.values(state.messages).find(message => message.body === "Typed forged reply")!;
  expect(typed.actorId).toBe("operator");
  expect(typed.metadata?.attribution).toMatchObject({ actorId: "operator", rootActorId: "operator", source: "local-admin" });
  expect(state.messages["mesh-forged"]).toMatchObject({
    actorId: "operator",
    metadata: { attribution: { actorId: "operator", rootActorId: "operator", source: "unverified" } },
  });
  const invocation = Object.values(state.invocations).find(candidate => candidate.task === "A2A forged operator")!;
  expect(invocation.requesterId).toBe(UNAUTHENTICATED_LOCAL_ACTOR_ID);
  expect(invocation.metadata?.attribution).toMatchObject({ actorId: UNAUTHENTICATED_LOCAL_ACTOR_ID, rootActorId: UNAUTHENTICATED_LOCAL_ACTOR_ID, source: "unverified", claimedActorId: "operator" });
}, 15_000);

test("attachments and actor kind rewrites cannot claim person authority", async () => {
  const h = await broker.startBroker();
  await broker.seedBasicConversation(h);
  const rewrite = await post(h.baseUrl, "/v1/actors", { id: "operator", kind: "agent", displayName: "Not a person" });
  expect(rewrite.status).toBe(403);
  const beforeMesh = await snapshot(h.baseUrl);
  const syntheticRewrite = await post(h.baseUrl, "/v1/mesh/messages", {
    originNode: beforeMesh.nodes[h.nodeId], actors: [],
    agents: [{ ...beforeMesh.agents.fabric, id: "operator" }],
    conversation: beforeMesh.conversations["channel.shared"], bindings: [],
    message: {
      id: "mesh-person-rewrite", conversationId: "channel.shared", actorId: "fabric", originNodeId: h.nodeId,
      class: "agent", body: "Must not replace a person", visibility: "workspace", policy: "durable", createdAt: Date.now(),
    },
  });
  expect(syntheticRewrite.status).toBe(400);
  expect((await snapshot(h.baseUrl)).actors.operator?.kind).toBe("person");

  const input = (requestId: string) => ({
    actorId: "operator", conversationId: "channel.shared", requestId, body: "Attachment attribution",
    attachments: [{ mediaType: "text/plain", data: "aGVsbG8=" }],
  });
  const unsigned = await post(h.baseUrl, "/v1/messages/with-attachments", input("unsigned-attachment"));
  expect(unsigned.status).toBe(403);
  const signed = await broker.postJson<any>(h.baseUrl, "/v1/messages/with-attachments", input("signed-attachment"));
  expect(signed.message.actorId).toBe("operator");
  expect(signed.message.metadata?.attribution).toMatchObject({ actorId: "operator", rootActorId: "operator", source: "local-admin" });
}, 15_000);

test("the CLI signs operator requests with the configured attribution key", async () => {
  const h = await broker.startBroker();
  await broker.seedBasicConversation(h);
  await broker.seedHangingReceiver(h, "fabric");
  process.env.OPENSCOUT_ATTRIBUTION_KEY_FILE = join(h.controlHome, "attribution-key");
  try {
    const delivered = await requestScoutBrokerJson<any>(h.baseUrl, "/v1/deliver", {
      body: delivery("operator"), socketPath: null,
    });
    const state = await snapshot(h.baseUrl);
    const invocation = state.invocations[(delivered.flight as { invocationId: string }).invocationId] as InvocationRequest;
    expect(invocation.requesterId).toBe("operator");
    expect(invocation.metadata?.attribution).toMatchObject({ actorId: "operator", rootActorId: "operator", source: "local-admin" });
    process.env.OPENSCOUT_BROKER_SOCKET_ONLY = "1";
    const socketDelivered = await requestScoutBrokerJson<any>(h.baseUrl, "/v1/deliver", {
      body: delivery("operator", { requestId: "socket-cli" }), socketPath: join(h.controlHome, "broker.sock"),
    });
    expect(socketDelivered.accepted).toBe(true);
    process.env.OPENSCOUT_BROKER_SOCKET_ONLY = undefined;
  } finally {
    delete process.env.OPENSCOUT_ATTRIBUTION_KEY_FILE;
    delete process.env.OPENSCOUT_BROKER_SOCKET_ONLY;
  }
}, 15_000);
