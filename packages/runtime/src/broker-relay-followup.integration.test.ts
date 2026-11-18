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
    requestId: "origin", caller, target: { kind: "session_id", sessionId: session, harness: "claude" },
    task: { version: 1 }, intent: "task_ask", body: "Review the original brief.",
  });
  const pasteCount = () => readFileSync(log, "utf8").split("\n").filter(line => line.startsWith("paste-buffer")).length;
  expect(await broker.waitFor(async () => pasteCount(), count => count === 1)).toBe(1);
  const current = () => broker.getJson<{ flight: FlightRecord }>(baseUrl, `/v1/invocations/${ask.flight!.invocationId}`);
  expect((await current()).flight.state).toBe("running");
  const endTurn = async () => {
    await broker.postJson(baseUrl, "/v1/deliver", {
      requestId: "answer", caller: { actorId: session, nodeId }, target: { kind: "binding_ref", ref: ask.message.id },
      intent: "tell", body: "Finished the original brief.",
    });
    expect((await current()).flight.state).toBe("completed");
  };
  return { ask, baseUrl, caller, session, pasteCount, endTurn };
}

test("a tmux turn can finish without reading its inbox; the sender gets a refusal, not acceptance", async () => {
  const relay = await runningRelay();
  const ref = relay.ask.bindingRef!;
  const request = { caller: relay.caller, requestId: "followup", target: { kind: "binding_ref", ref },
    targetLabel: `ref:${ref}`, task: { version: 1, ref }, intent: "task_ask", body: "Review the additional scope." };
  const send = () => broker.postJsonStatus(relay.baseUrl, "/v1/deliver", request);
  const response = await send();
  // The relay answers only the original prompt; it never polls Scout's inbox.
  await relay.endTurn();
  expect(relay.pasteCount()).toBe(1);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(response.body)).toContain(`--to session:claude:${relay.session}`);
  expect(await send()).toEqual(response);
  const messages = await broker.getJson<MessageRecord[]>(relay.baseUrl, `/v1/messages?conversationId=${relay.ask.conversation.id}`);
  expect(messages.some(m => m.body === request.body)).toBe(false);
}, 30_000);

test("continue with a copied ref routes a finished cardless task back to its relay", async () => {
  const relay = await runningRelay();
  await relay.endTurn();
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
