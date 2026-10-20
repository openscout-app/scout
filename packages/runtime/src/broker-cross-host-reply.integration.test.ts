import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorIdentity, AgentEndpoint, ConversationDefinition, FlightRecord, InvocationRequest, MessageRecord, NodeDefinition } from "@openscout/protocol";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";
import { decodeJournalLine } from "./broker-journal-framing.js";

const broker = createBrokerDaemonTestHarness();

test("a journal-only executor accepts a fresh mesh ask and returns its original receipt on retry", async () => {
  const fixture = authorityFixture();
  const home = mkdtempSync(join(tmpdir(), "scout-mesh-journal-only-"));
  const fakeBin = join(home, "bin");
  broker.writeFakeTmuxBin(fakeBin);
  const executor = await broker.startBroker({ controlHome: home, env: {
    OPENSCOUT_DISABLE_SQLITE: "1", OPENSCOUT_NODE_ID: fixture.conversation.authorityNodeId,
    PATH: `${fakeBin}:${process.env.PATH}`, OPENSCOUT_FAKE_TMUX_SESSION: fixture.invocation.targetAgentId,
    OPENSCOUT_FAKE_TMUX_LOG: join(fakeBin, "tmux.log"),
  } });
  await broker.postJson(executor.baseUrl, "/v1/actors", fixture.actors[1]);
  await broker.postJson(executor.baseUrl, "/v1/endpoints", {
    id: "endpoint-journal-only", agentId: fixture.invocation.targetAgentId, nodeId: executor.nodeId,
    harness: "claude", transport: "tmux", state: "idle", sessionId: fixture.invocation.targetAgentId,
    metadata: { cardless: true, sessionBacked: true, pendingExternalSession: true },
  });
  const bundle = { ...fixture, message: fixture.request };
  const first = await broker.postJson<{ flight: FlightRecord }>(executor.baseUrl, "/v1/mesh/invocations", bundle);
  expect(first.flight.invocationId).toBe(fixture.invocation.id);
  const retry = await broker.postJson<{ duplicate: boolean; flight: FlightRecord }>(executor.baseUrl, "/v1/mesh/invocations", bundle);
  expect(retry.duplicate).toBe(true);
  expect(retry.flight.id).toBe(first.flight.id);
  const messages = await broker.getJson<MessageRecord[]>(executor.baseUrl, `/v1/messages?conversationId=${fixture.conversation.id}`);
  expect(messages.filter(row => row.id === fixture.request.id)).toHaveLength(1);
  const entries = readFileSync(join(home, "broker-journal.jsonl"), "utf8").trim().split("\n").flatMap(line => decodeJournalLine(line));
  expect(entries.filter(entry => entry.kind === "invocation.record" && entry.invocation.id === fixture.invocation.id)).toHaveLength(1);
  expect(entries.filter(entry => entry.kind === "invocation.dispatch_job.record" && entry.job.invocationId === fixture.invocation.id && entry.job.state === "pending")).toHaveLength(1);
}, 20_000);

test("cardless tmux reply resolves the remote request anchor, settles both brokers, and releases the waiter", async () => {
  const home = mkdtempSync(join(tmpdir(), "scout-return-origin-"));
  const executorHome = mkdtempSync(join(tmpdir(), "scout-return-executor-"));
  const fakeBin = join(executorHome, "bin");
  broker.writeFakeTmuxBin(fakeBin);
  const startedAt = Date.now();
  const originNode: NodeDefinition = { id: "return-origin", meshId: "openscout", name: "Origin", advertiseScope: "local", registeredAt: startedAt };
  const requester: ActorIdentity = { id: "requester", kind: "person", displayName: "Requester", labels: [], metadata: {} };
  const target: ActorIdentity = { id: "session-return-mini", kind: "session", displayName: "Mini session", labels: ["cardless-session"], metadata: { cardless: true, harness: "claude" } };
  const conversation: ConversationDefinition = { id: "chn-return-test", kind: "direct", title: "Smoke", participantIds: [requester.id, target.id], authorityNodeId: originNode.id, visibility: "private", shareMode: "local", metadata: {} };
  const message: MessageRecord = { id: "msg-return-request", actorId: requester.id, originNodeId: originNode.id, conversationId: conversation.id, class: "agent", body: "smoke", visibility: "private", policy: "durable", createdAt: startedAt };
  const invocation: InvocationRequest = { id: "inv-return-test", requesterId: requester.id, requesterNodeId: originNode.id, targetAgentId: target.id, conversationId: conversation.id, messageId: message.id, action: "consult", task: "smoke", ensureAwake: true, stream: false, createdAt: startedAt, metadata: { replyMode: "none" } };
  const flight: FlightRecord = { id: "flt-return-origin", invocationId: invocation.id, requesterId: requester.id, targetAgentId: target.id, state: "running", startedAt };
  writeFileSync(join(home, "broker-journal.jsonl"), [
    { kind: "node.upsert", node: originNode }, { kind: "actor.upsert", actor: requester }, { kind: "actor.upsert", actor: target },
    { kind: "conversation.upsert", conversation }, { kind: "message.record", message },
    { kind: "invocation.record", invocation }, { kind: "flight.record", flight },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const origin = await broker.startBroker({ controlHome: home, env: { OPENSCOUT_NODE_ID: originNode.id } });
  const executor = await broker.startBroker({ controlHome: executorHome, env: {
    PATH: `${fakeBin}:${process.env.PATH}`, OPENSCOUT_FAKE_TMUX_SESSION: target.id,
    OPENSCOUT_FAKE_TMUX_LOG: join(fakeBin, "tmux.log"),
  } });
  const endpoint: AgentEndpoint = { id: "endpoint-return-tmux", agentId: target.id, nodeId: executor.nodeId, harness: "claude", transport: "tmux", state: "idle", sessionId: target.id, cwd: executorHome, projectRoot: executorHome, metadata: { source: "scout-cardless-session", cardless: true, sessionBacked: true, pendingExternalSession: true } };
  await broker.postJson(executor.baseUrl, "/v1/actors", target);
  await broker.postJson(executor.baseUrl, "/v1/endpoints", endpoint);
  const bundle = { originNode: { ...originNode, brokerUrl: origin.baseUrl }, actors: [requester, target], agents: [], conversation, message, invocation };
  await broker.postJson(executor.baseUrl, "/v1/mesh/invocations", bundle);
  // Receipt precedes asynchronous dispatch. Simulate a harness answer only
  // after its prompt arrives, or the answer can fence dispatch before paste.
  const tmuxLog = join(fakeBin, "tmux.log");
  for (let i = 0; i < 100; i++) {
    if (existsSync(tmuxLog) && readFileSync(tmuxLog, "utf8").split("\n").some(line => line.startsWith("paste-buffer"))) break;
    await Bun.sleep(100);
  }
  expect(readFileSync(tmuxLog, "utf8").split("\n").filter(line => line.startsWith("paste-buffer"))).toHaveLength(1);
  // Stand in for the harness's single `tell --as session-return-mini --ref msg-return-request`.
  // Actual /v1/deliver resolution and authority forwarding run in the brokers.
  const result = await broker.postJson<{ kind: string; message: MessageRecord }>(executor.baseUrl, "/v1/deliver", {
    caller: { actorId: target.id, nodeId: executor.nodeId }, target: { kind: "binding_ref", ref: message.id },
    body: "0.3.6-dev.3 mini", intent: "tell",
  });
  expect(result.kind).toBe("delivery");
  expect(result.message.replyToMessageId).toBe(message.id);
  const originMessages = await broker.getJson<MessageRecord[]>(origin.baseUrl, `/v1/messages?conversationId=${conversation.id}`);
  expect(originMessages.filter(row => row.body === "0.3.6-dev.3 mini")).toHaveLength(1);
  const state = async (baseUrl: string) => await broker.getJson<{ flights: Record<string, FlightRecord>; endpoints: Record<string, AgentEndpoint> }>(baseUrl, "/v1/snapshot");
  for (let i = 0; i < 50; i++) {
    const snapshot = await state(executor.baseUrl);
    if (snapshot.endpoints[endpoint.id]?.state === "idle") break;
    await Bun.sleep(100);
  }
  const executorState = await state(executor.baseUrl);
  const originState = await broker.getJson<{ flight: FlightRecord }>(origin.baseUrl, `/v1/invocations/${invocation.id}`);
  expect(Object.values(executorState.flights).find(row => row.invocationId === invocation.id)).toMatchObject({ state: "completed", output: "0.3.6-dev.3 mini" });
  expect(originState.flight).toMatchObject({ state: "completed", output: "0.3.6-dev.3 mini" });
  expect(executorState.endpoints[endpoint.id]?.state).toBe("idle");
  const journal = readFileSync(join(executorHome, "broker-journal.jsonl"), "utf8");
  expect(journal.split("\n").filter(line => line.includes('"kind":"message.record"') && line.includes(message.id))).toHaveLength(1);
  // No real harness launch and no second execution on a retry.
  await broker.postJson(executor.baseUrl, "/v1/mesh/invocations", bundle);
  const commands = readFileSync(join(fakeBin, "tmux.log"), "utf8");
  expect(commands.split("\n").filter(line => line.startsWith("paste-buffer"))).toHaveLength(1);
}, 40_000);

function authorityFixture() {
  const createdAt = Date.now();
  const originNode: NodeDefinition = { id: "mesh-peer", meshId: "openscout", name: "Peer", advertiseScope: "local", registeredAt: createdAt };
  const requester: ActorIdentity = { id: "operator", kind: "person", displayName: "Operator", labels: [], metadata: {} };
  const target: ActorIdentity = { id: "session-authority-test", kind: "session", displayName: "Target", labels: [], metadata: { cardless: true } };
  const conversation: ConversationDefinition = { id: "chn-authority-test", kind: "direct", title: "Authority test", participantIds: [requester.id, target.id], authorityNodeId: "mesh-authority", visibility: "private", shareMode: "local", metadata: {} };
  const invocation: InvocationRequest = { id: "inv-authority-test", requesterId: requester.id, requesterNodeId: originNode.id, targetAgentId: target.id, conversationId: conversation.id, messageId: "msg-authority-request", action: "consult", task: "work", ensureAwake: true, stream: false, createdAt };
  const flight: FlightRecord = { id: "flt-authority-test", invocationId: invocation.id, requesterId: requester.id, targetAgentId: target.id, state: "running", startedAt: createdAt };
  const request: MessageRecord = { id: invocation.messageId!, actorId: requester.id, originNodeId: originNode.id, conversationId: conversation.id, class: "agent", body: "work", visibility: "private", policy: "durable", createdAt };
  return { originNode, actors: [requester, target], agents: [], conversation, invocation, flight, request };
}

async function startAuthorityFixture(fixture: ReturnType<typeof authorityFixture>, messages: MessageRecord[] = []) {
  const home = mkdtempSync(join(tmpdir(), "scout-mesh-authority-"));
  writeFileSync(join(home, "broker-journal.jsonl"), [
    { kind: "node.upsert", node: fixture.originNode },
    ...fixture.actors.map(actor => ({ kind: "actor.upsert", actor })),
    { kind: "conversation.upsert", conversation: fixture.conversation },
    ...messages.map(message => ({ kind: "message.record", message })),
    { kind: "invocation.record", invocation: fixture.invocation },
    { kind: "flight.record", flight: fixture.flight },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return await broker.startBroker({ controlHome: home, env: { OPENSCOUT_NODE_ID: fixture.conversation.authorityNodeId } });
}

test("mesh authority rejects conflicting duplicate replies and completes only an accepted canonical answer", async () => {
  const fixture = authorityFixture();
  const canonical = { ...fixture.request, id: "msg-collision", body: "unrelated FYI" };
  const authority = await startAuthorityFixture(fixture, [canonical]);
  const forged: MessageRecord = { ...canonical, actorId: fixture.invocation.targetAgentId, replyToMessageId: fixture.invocation.messageId, body: "NONCANONICAL RESULT" };
  const bundle = { ...fixture, bindings: [], message: forged };
  await expect(broker.postJson(authority.baseUrl, "/v1/mesh/messages", bundle))
    .rejects.toThrow("conflicts with existing record");
  const state = await broker.getJson<{ flight: FlightRecord }>(authority.baseUrl, `/v1/invocations/${fixture.invocation.id}`);
  expect(state.flight.state).toBe("running");
  expect(state.flight.output).toBeUndefined();
  const messages = await broker.getJson<MessageRecord[]>(authority.baseUrl, `/v1/messages?conversationId=${fixture.conversation.id}`);
  expect(messages.find(row => row.id === canonical.id)).toMatchObject(canonical);
  // A real answer with a fresh id is accepted; an exact retry remains idempotent.
  const answer = { ...forged, id: "msg-accepted-answer", body: "canonical final result" };
  await broker.postJson(authority.baseUrl, "/v1/mesh/messages", { ...bundle, message: answer });
  expect(await broker.postJson(authority.baseUrl, "/v1/mesh/messages", { ...bundle, message: answer }))
    .toMatchObject({ ok: true, duplicate: true });
  const completed = await broker.getJson<{ flight: FlightRecord }>(authority.baseUrl, `/v1/invocations/${fixture.invocation.id}`);
  expect(completed.flight).toMatchObject({ state: "completed", output: answer.body, metadata: { replyMessageId: answer.id } });
}, 20_000);

test("mesh executor rejects replacement anchors on duplicate invocations but repairs the persisted anchor without dispatch", async () => {
  const fixture = authorityFixture();
  const executor = await startAuthorityFixture(fixture);
  // Duplicate-anchor repair needs a real receiver, not a nonexistent tmux session.
  await broker.seedHangingReceiver(executor, fixture.invocation.targetAgentId);
  // The retained invocation has no message yet, as with an older mesh bundle.
  const altered = { ...fixture.invocation, messageId: "msg-other", requesterId: "other-requester" };
  const message = { ...fixture.request, id: altered.messageId, actorId: altered.requesterId };
  await expect(broker.postJson(executor.baseUrl, "/v1/mesh/invocations", { ...fixture, invocation: altered, message }))
    .rejects.toThrow("persisted request anchor");
  const state = await broker.getJson<{ invocation: InvocationRequest; flight: FlightRecord }>(executor.baseUrl, `/v1/invocations/${fixture.invocation.id}`);
  expect(state.invocation).toMatchObject(fixture.invocation);
  expect(state.flight.state).toBe("running");
  expect(await broker.getJson<MessageRecord[]>(executor.baseUrl, `/v1/messages?conversationId=${fixture.conversation.id}`)).toEqual([]);
  const bundle = { ...fixture, message: fixture.request };
  expect(await broker.postJson(executor.baseUrl, "/v1/mesh/invocations", bundle)).toMatchObject({ ok: true, duplicate: true });
  expect(await broker.postJson(executor.baseUrl, "/v1/mesh/invocations", bundle)).toMatchObject({ ok: true, duplicate: true });
  const messages = await broker.getJson<MessageRecord[]>(executor.baseUrl, `/v1/messages?conversationId=${fixture.conversation.id}`);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject(fixture.request);
  const snapshot = await broker.getJson<{ flights: Record<string, FlightRecord> }>(executor.baseUrl, "/v1/snapshot");
  expect(snapshot.flights[fixture.flight.id]).toMatchObject({ state: "running" });
  const journal = readFileSync(join(executor.controlHome, "broker-journal.jsonl"), "utf8");
  expect(journal).not.toContain('"kind":"invocation.dispatch_job.record"');
  expect(journal).not.toContain("msg-other");
}, 20_000);
