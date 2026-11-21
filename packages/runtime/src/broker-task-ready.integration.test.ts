import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollaborationRecord, FlightRecord, ScoutDeliverResponse, TaskReadyDecideResponse } from "@openscout/protocol";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();
type Receipt = Extract<ScoutDeliverResponse, { kind: "delivery" }>;

// The worker is a deterministic fixture behind a simulated tmux transport, not
// an LLM. Routing, dispatch, the flight writer, work promotion, the Ready
// routes and the same-session Continue are the real runtime.
test("a task marked notify becomes Ready for the operator; Hold keeps it; Continue goes back into the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-task-ready-"));
  const log = broker.writeFakeTmuxBin(join(root, "bin"));
  const runtime = await broker.startBroker({ controlHome: root, devInstance: true, env: {
    PATH: `${join(root, "bin")}:${process.env.PATH}`, OPENSCOUT_FAKE_TMUX_SESSION: "ready-worker-session",
    OPENSCOUT_FAKE_TMUX_LOG: log, OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
  } });
  const url = runtime.baseUrl;
  await broker.postJson(url, "/v1/agents", {
    id: "ready-requester", kind: "agent", definitionId: "ready-requester", displayName: "Requester",
    agentClass: "general", capabilities: ["chat", "invoke"], wakePolicy: "on_demand",
    homeNodeId: runtime.nodeId, authorityNodeId: runtime.nodeId, advertiseScope: "local",
  });
  await broker.postJson(url, "/v1/endpoints", {
    id: "ready-requester-inbox", agentId: "ready-requester", nodeId: runtime.nodeId, harness: "mcp", transport: "mcp_poll", state: "idle",
  });
  await broker.postJson(url, "/v1/actors", {
    id: "ready-worker", kind: "session", displayName: "Worker", labels: [], metadata: { cardless: true, harness: "claude" },
  });
  await broker.postJson(url, "/v1/endpoints", {
    id: "ready-worker-endpoint", agentId: "ready-worker", nodeId: runtime.nodeId, harness: "claude", transport: "tmux",
    state: "idle", sessionId: "ready-worker-session", cwd: root, projectRoot: root,
    metadata: { cardless: true, sessionBacked: true, pendingExternalSession: true },
  });
  const pastes = () => readFileSync(log, "utf8").split("\n").filter(line => line.startsWith("paste-buffer")).length;
  const flightOf = (invocationId: string) => broker.getJson<{ flight: FlightRecord }>(url, `/v1/invocations/${invocationId}`).then(value => value.flight);
  const work = async (id: string) => (await broker.getJson<{ collaborationRecords: Record<string, CollaborationRecord> }>(url, "/v1/snapshot")).collaborationRecords[id];
  const ask = (requestId: string, body: string, notify: boolean) => broker.postJson<Receipt>(url, "/v1/deliver", {
    requestId, caller: { actorId: "ready-requester", nodeId: runtime.nodeId }, target: { kind: "session_id", sessionId: "ready-worker-session" },
    intent: "task_ask", body, task: { version: 1, ...(notify ? { notify: true } : {}) },
  });
  const answer = (requestId: string, messageId: string, body: string) => broker.postJson(url, "/v1/deliver", {
    requestId, caller: { actorId: "ready-worker", nodeId: runtime.nodeId }, target: { kind: "binding_ref", ref: messageId }, intent: "tell", body,
  });

  // An unmarked task behaves as before: done, no Ready.
  const plain = await ask("plain-ask", "Count the files.", false);
  await broker.waitFor(async () => pastes(), count => count === 1);
  await answer("plain-answer", plain.message!.id, "There are 12 files.");
  const plainDone = await broker.waitFor(() => flightOf(plain.flight!.invocationId), flight => flight.state === "completed");
  expect(plainDone.metadata?.ready).toBeUndefined();
  const plainWorkId = plainDone.metadata?.workPromotion && (plainDone.metadata.workPromotion as { workId: string }).workId;
  expect((await broker.waitFor(() => work(plainWorkId!), record => record?.state === "done"))?.acceptanceState).toBe("none");

  // A marked task: Ready on the flight, next move on the operator, work item in review.
  const marked = await ask("marked-ask", "Fix the flaky test.", true);
  await broker.waitFor(async () => pastes(), count => count === 2);
  await answer("marked-answer", marked.message!.id, "## Done\n\nFixed the flaky test in `a.test.ts`.\n\nDetails follow.");
  const ready = await broker.waitFor(() => flightOf(marked.flight!.invocationId), flight => Boolean(flight.metadata?.ready));
  expect(ready.state).toBe("completed");
  expect(ready.metadata).toMatchObject({
    nextMoveOwnerId: "operator",
    ready: { state: "ready", summary: "Fixed the flaky test in a.test.ts.", nodeId: runtime.nodeId },
  });
  const workId = (ready.metadata!.workPromotion as { workId: string }).workId;
  expect(await broker.waitFor(() => work(workId), record => record?.state === "review")).toMatchObject({
    state: "review", acceptanceState: "pending", nextMoveOwnerId: "operator",
  });

  // Hold: off the list, still Ready.
  const held = await broker.postJson<TaskReadyDecideResponse>(url, "/v1/tasks/ready/decide", { ref: marked.flight!.invocationId, decision: "hold" });
  expect(held.ready).toMatchObject({ state: "ready", heldById: "operator" });
  expect((await flightOf(marked.flight!.invocationId)).metadata?.ready).toMatchObject({ state: "ready", heldAt: held.ready.heldAt });

  // Continue: delivered into the same session, move back to the agent, work back to working.
  const continued = await broker.postJson<TaskReadyDecideResponse>(url, "/v1/tasks/ready/decide", { ref: marked.flight!.invocationId, decision: "continue" });
  expect(continued.ready.state).toBe("continued");
  expect(continued.continuation?.invocationId).toBeDefined();
  await broker.waitFor(async () => pastes(), count => count === 3);
  const after = await flightOf(marked.flight!.invocationId);
  expect(after.metadata).toMatchObject({ nextMoveOwnerId: "ready-worker", ready: { state: "continued" } });
  expect(await work(workId)).toMatchObject({ state: "working", acceptanceState: "none", nextMoveOwnerId: "ready-worker" });
  const successor = await flightOf(continued.continuation!.invocationId!);
  expect(successor.invocationId).not.toBe(marked.flight!.invocationId);

  // A task that is not Ready cannot be decided again.
  const refused = await broker.postJsonStatus(url, "/v1/tasks/ready/decide", { ref: marked.flight!.invocationId, decision: "continue" });
  expect(refused.status).toBe(409);
}, 60_000);
