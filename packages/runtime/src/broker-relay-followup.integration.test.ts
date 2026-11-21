import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightRecord, MessageRecord, ScoutDeliverAcceptedResponse } from "@openscout/protocol";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

async function runningRelay() {
  const root = mkdtempSync(join(tmpdir(), "scout-followup-"));
  const bin = join(root, "bin"), log = broker.writeFakeTmuxBin(bin);
  const session = "session-test-worker";
  const { baseUrl, nodeId } = await broker.startBroker({ devInstance: true, controlHome: root, env: {
    PATH: `${bin}:${process.env.PATH}`, OPENSCOUT_FAKE_TMUX_SESSION: session, OPENSCOUT_FAKE_TMUX_LOG: log,
    OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
  } });
  await broker.postJson(baseUrl, "/v1/actors", {
    id: session, kind: "session", displayName: "Worker", labels: [], metadata: { cardless: true, harness: "claude" },
  });
  await broker.postJson(baseUrl, "/v1/endpoints", {
    id: "worker-endpoint", agentId: session, nodeId, harness: "claude", transport: "tmux", state: "idle",
    sessionId: session, cwd: root, projectRoot: root,
    metadata: { cardless: true, sessionBacked: true, pendingExternalSession: true },
  });
  const caller = { actorId: "operator", nodeId };
  const ask = await broker.postJson<ScoutDeliverAcceptedResponse>(baseUrl, "/v1/deliver", {
    requestId: "origin", caller, replyToSessionId: "caller-native-session",
    invocationMetadata: { replyToSessionHarness: "claude" }, target: { kind: "session_id", sessionId: session, harness: "claude" },
    task: { version: 1 }, intent: "task_ask", body: "Review the original brief.",
  });
  const pasteCount = () => readFileSync(log, "utf8").split("\n").filter(line => line.startsWith("paste-buffer")).length;
  expect(await broker.waitFor(async () => pasteCount(), count => count === 1)).toBe(1);
  const current = () => broker.getJson<{ flight: FlightRecord }>(baseUrl, `/v1/invocations/${ask.flight!.invocationId}`);
  expect((await current()).flight.state).toBe("running");
  const answerTask = async () => {
    await broker.postJson(baseUrl, "/v1/messages/reply", {
      requestId: "answer", senderId: session, ref: ask.flight!.invocationId,
      body: "Finished the original brief.",
    });
    expect((await current()).flight.state).toBe("completed");
  };
  return { ask, baseUrl, caller, session, pasteCount, answerTask };
}

test("a tmux turn can finish without reading its inbox; the sender gets a refusal, not acceptance", async () => {
  const relay = await runningRelay();
  const ref = relay.ask.bindingRef!;
  const request = { caller: { ...relay.caller, actorId: "project-agent" }, replyToSessionId: "caller-native-session",
    invocationMetadata: { replyToSessionHarness: "claude" }, requestId: "followup", target: { kind: "binding_ref", ref },
    targetLabel: `ref:${ref}`, task: { version: 1, ref }, intent: "task_ask", body: "Review the additional scope." };
  const send = () => broker.postJsonStatus(relay.baseUrl, "/v1/deliver", request);
  for (const [suffix, replyToSessionId, replyToSessionHarness] of [
    ["wrong-session", "another-session", "claude"],
    ["wrong-harness", "caller-native-session", "codex"],
    ["reply-address-only", "caller-native-session", undefined],
  ] as const) {
    const refused = await broker.postJsonStatus(relay.baseUrl, "/v1/deliver", {
      ...request, requestId: suffix, replyToSessionId, invocationMetadata: { replyToSessionHarness },
    });
    // Read the detail before toMatchObject: Bun writes matched asymmetric matchers back into the received object.
    const detail = (refused.body as { detail?: unknown } | null)?.detail;
    expect(refused).toMatchObject({ status: 409, body: { error: "task_followup_unauthorized" } });
    expect(typeof detail).toBe("string");
    expect(detail as string).toMatch(/is not authorized for sender project-agent\. Only the .+, the harness session that asked it, or a participant in the task conversation may add context to it\./);
    // The refusal names who may follow up; it never suggests claiming their identity.
    expect(detail as string).not.toContain("--as");
  }
  const response = await send();
  // The relay answers only the original prompt; it never polls Scout's inbox.
  await relay.answerTask();
  expect(relay.pasteCount()).toBe(1);
  expect(response).toMatchObject({ status: 409, body: {
    error: "task_followup_not_sent", detail: expect.stringContaining(`--to session:claude:${relay.session}`),
  } });
  const receipt = await broker.getJson(relay.baseUrl, "/v1/request-receipts/followup?requesterId=project-agent");
  expect(receipt).toMatchObject({ receipt: { state: "failed", failure: { code: "task_followup_not_sent", evidence: relay.ask.flight!.id } } });
  expect(await send()).toEqual(response);
  const messages = await broker.getJson<MessageRecord[]>(relay.baseUrl, `/v1/messages?conversationId=${relay.ask.conversation.id}`);
  expect(messages.some(m => m.body === request.body)).toBe(false);
}, 30_000);

test("continue with a copied ref routes a finished cardless task back to its relay", async () => {
  const relay = await runningRelay();
  await relay.answerTask();
  // Older clients kept the copied prefix in the ref and rendered another in the label.
  const ref = `ref:${relay.ask.bindingRef}`;
  const next = await broker.postJson<ScoutDeliverAcceptedResponse>(relay.baseUrl, "/v1/deliver", {
    caller: relay.caller, requestId: "successor", target: { kind: "binding_ref", ref }, targetLabel: `ref:${ref}`,
    task: { version: 1, continue: ref }, intent: "task_ask", body: "Review the additional scope.",
  });
  expect(next.flight!.invocationId).not.toBe(relay.ask.flight!.invocationId);
  expect(next.targetAgentId).toBe(relay.session);
  expect(next.message.body).toContain("Finished the original brief.");
  expect(await broker.waitFor(async () => relay.pasteCount(), count => count === 2)).toBe(2);
}, 30_000);

test("an ask to a managed tmux Claude session stays open through a turn end until its task reply", async () => {
  const relay = await runningRelay();
  const detail = () => broker.getJson<{ invocation: { metadata?: Record<string, unknown> }; flight: FlightRecord }>(
    relay.baseUrl, `/v1/invocations/${relay.ask.flight!.invocationId}`);
  const accepted = await detail();
  expect(accepted.invocation.metadata).toMatchObject({
    completion: { mode: "explicit" }, completionEndpointId: "worker-endpoint",
  });
  // The session ends an interim turn: the adapter reports its output as a result.
  await broker.postJson(relay.baseUrl, "/v1/flights", {
    ...accepted.flight, state: "completed", output: "Started the build; reporting back when it lands.", completedAt: Date.now(),
  });
  const interim = (await detail()).flight;
  expect(interim).toMatchObject({ state: "waiting", metadata: {
    completion: { awaitingFinal: true }, awaitingFinalOutput: "Started the build; reporting back when it lands.",
  } });
  expect(interim.output).toBeUndefined();
  await relay.answerTask();
  expect((await detail()).flight.output).toBe("Finished the original brief.");
});

test("the requester session can add context to an open operator task with a different CLI actor", async () => {
  const { baseUrl, nodeId } = await broker.startBroker({ devInstance: true });
  const identity = { replyToSessionId: "caller-native-session", invocationMetadata: { replyToSessionHarness: "claude" } };
  const asked = await broker.postJson<ScoutDeliverAcceptedResponse>(baseUrl, "/v1/deliver", {
    requestId: "operator-task", caller: { actorId: "original-agent", nodeId }, ...identity,
    target: { kind: "agent_id", agentId: "operator" }, task: { version: 1, operator: true },
    intent: "task_ask", body: "Review this approach.",
  });
  const ref = asked.flight!.invocationId;
  const followup = { requestId: "context", caller: { actorId: "project-agent", nodeId }, ...identity,
    target: { kind: "binding_ref", ref }, task: { version: 1, ref }, intent: "task_ask", body: "One more detail." };
  const denied = await broker.postJsonStatus(baseUrl, "/v1/deliver", {
    ...followup, requestId: "cancel", task: { ...followup.task, cancel: true },
  });
  const deniedDetail = (denied.body as { detail?: unknown } | null)?.detail;
  expect(denied).toMatchObject({ status: 409, body: { error: "task_followup_unauthorized" } });
  expect(deniedDetail).toBe(`Task ${ref} is not authorized for sender project-agent. Only the original requester (original-agent) or the operator may cancel it. Ask one of them to send it.`);
  const receipt = await broker.postJson<ScoutDeliverAcceptedResponse>(baseUrl, "/v1/deliver", followup);
  expect(receipt).toMatchObject({ accepted: true, message: { actorId: "project-agent", body: followup.body } });
  expect(await broker.postJson(baseUrl, "/v1/deliver", followup)).toEqual(receipt);
}, 30_000);
