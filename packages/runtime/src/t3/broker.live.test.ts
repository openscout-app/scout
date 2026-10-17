import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBrokerDaemonTestHarness } from "../test-helpers/broker-daemon-harness.test.js";
import { T3Adapter, t3ScopedId } from "./adapter.js";

// Opt-in: a real, operator-configured T3 server and provider. No fake harness.
const enabled = Boolean(process.env.SCOUT_T3_LIVE_TOKEN_FILE && process.env.SCOUT_T3_LIVE_THREAD_ID);
const broker = createBrokerDaemonTestHarness();
async function createFixtureThread(adapter: T3Adapter, title: string) {
  const template = await adapter.thread(process.env.SCOUT_T3_LIVE_THREAD_ID!);
  const threadId = randomUUID();
  await adapter.call("orchestration.dispatchCommand", { type: "thread.create", commandId: randomUUID(), threadId,
    projectId: template.projectId, title, modelSelection: template.modelSelection, runtimeMode: template.runtimeMode,
    interactionMode: template.interactionMode, branch: template.branch ?? null, worktreePath: template.worktreePath ?? null,
    createdAt: new Date().toISOString() });
  return threadId;
}
test.skipIf(!enabled)("real Scout broker -> T3 -> coding provider -> durable original-conversation reply survives broker restart", async () => {
  const root = process.env.SCOUT_T3_LIVE_RECEIPTS!;
  const token = readFileSync(process.env.SCOUT_T3_LIVE_TOKEN_FILE!, "utf8").trim();
  const connectionId = "live-t3", projectId = process.env.SCOUT_T3_LIVE_PROJECT_ID!;
  const adapter = new T3Adapter({ id: connectionId, url: process.env.SCOUT_T3_LIVE_URL!, tokenEnv: "TOKEN" }, { TOKEN: token });
  const threadId = await createFixtureThread(adapter, "Scout adapter restart fixture");
  const env = { OPENSCOUT_T3_CONNECTIONS: JSON.stringify([{ id: connectionId, url: process.env.SCOUT_T3_LIVE_URL, tokenEnv: "SCOUT_T3_TEST_TOKEN" }]), SCOUT_T3_TEST_TOKEN: token,
    OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS: "[]" };
  let h = await broker.startBroker({ env });
  await broker.seedBasicConversation(h);
  const source = await broker.postJson<{ projects: Array<{ id: string }> }>(h.baseUrl, "/v1/integrations/t3/inspect", { connectionId });
  expect(source.projects.some(project => project.id === projectId)).toBe(true);
  const board = await broker.postJson<{ records: Array<{ externalContext: { source: { workItemId: string }; sourceState: string } }> }>(h.baseUrl, "/v1/integrations/t3/refresh", { connectionId, projectId });
  expect(Array.isArray(board.records)).toBe(true);
  const attached = await broker.postJson<{ sessionId: string }>(h.baseUrl, "/v1/integrations/t3/attach", { connectionId, threadId });
  expect(attached.sessionId).toBeTruthy();
  const sender = await broker.postJson<{ sessionId: string }>(h.baseUrl, "/v1/external-sessions/attach", { ownerId: "operator", nativeSessionId: "t3-live-origin" });
  const requestId = `t3-live-${Date.now()}`;
  const marker = `SCOUT_T3_BROKER_${Date.now()}`;
  const task = `In this fixture repository only, use a shell tool to wait 8 seconds, then create scout-broker-proof.txt containing exactly ${marker} followed by a newline. Do not commit. Reply with exactly ${marker}_COMPLETE after checking the file.`;
  const delivery = { id: requestId, caller: { actorId: "operator", nodeId: h.nodeId }, target: { kind: "session_id", sessionId: attached.sessionId },
    replyToSessionId: sender.sessionId, body: task, intent: "consult", ensureAwake: true, createdAt: Date.now(),
    workItem: { title: "Verify T3 adapter round trip" } };
  const receipt = await broker.postJson<{ accepted: boolean; flight: { invocationId: string }; conversation: { id: string }; workItem?: { id: string } }>(h.baseUrl, "/v1/deliver", delivery);
  expect(receipt.accepted).toBe(true);
  const invocationId = receipt.flight.invocationId;
  const flight = async () => broker.getJson<{ flight: { state: string; output?: string; error?: string; metadata?: Record<string, unknown> }; invocation: { conversationId: string; messageId: string } }>(h.baseUrl, `/v1/invocations/${invocationId}`);
  let running = await flight();
  for (let i = 0; i < 100 && !running.flight?.metadata?.t3DeliveryId; i++) { await Bun.sleep(100); running = await flight(); }
  expect(running.flight.metadata?.t3DeliveryId).toBeTruthy();
  const controlHome = h.controlHome;
  h.child.kill();
  await h.child.exited;
  h = await broker.startBroker({ controlHome, env });
  let done = await flight();
  for (let i = 0; i < 900 && !["completed", "failed", "cancelled"].includes(done.flight?.state); i++) { await Bun.sleep(250); done = await flight(); }
  expect(done.flight.error).toBeUndefined();
  expect(done.flight.state).toBe("completed");
  expect(done.flight.output).toBe(`${marker}_COMPLETE`);
  expect(readFileSync(join(process.env.SCOUT_T3_LIVE_PROJECT!, "scout-broker-proof.txt"), "utf8")).toBe(`${marker}\n`);
  const poll = () => broker.postJson<{ items: Array<{ body: string; kind: string }> }>(h.baseUrl, "/v1/external-sessions/poll", { ownerId: "operator", sessionId: sender.sessionId });
  let returned = await poll();
  for (let i = 0; !returned.items.length && i < 100; i++) { await Bun.sleep(100); returned = await poll(); }
  expect(returned.items.filter(item => item.kind === "result")).toHaveLength(1);
  expect(returned.items[0]!.body).toContain(`${marker}_COMPLETE`);
  const sourceThread = await adapter.thread(threadId);
  const exactSourceMessageCount = sourceThread.messages.filter((message: any) => message.id === t3ScopedId("scout-message", invocationId)).length;
  expect(exactSourceMessageCount).toBe(1);
  const messages = await broker.getJson<any>(h.baseUrl, `/v1/messages?conversationId=${encodeURIComponent(done.invocation.conversationId)}`);
  writeFileSync(join(root, "broker-receipt.json"), JSON.stringify({ requestId, invocationId, sessionId: attached.sessionId, threadId, projectId,
    conversationId: done.invocation.conversationId, flight: done.flight, returnedCount: returned.items.length, restarted: true, sourceBoardCards: board.records.length,
    messages, exactSourceMessageCount, sourceTurnId: sourceThread.latestTurn?.turnId, proof: `${marker}\n`, verifiedAt: new Date().toISOString() }, null, 2));
}, 300_000);

test.skipIf(!enabled)("real Scout cancellation targets only its correlated T3 turn", async () => {
  const token = readFileSync(process.env.SCOUT_T3_LIVE_TOKEN_FILE!, "utf8").trim();
  const connectionId = "live-t3";
  const adapter = new T3Adapter({ id: connectionId, url: process.env.SCOUT_T3_LIVE_URL!, tokenEnv: "TOKEN" }, { TOKEN: token });
  const threadId = await createFixtureThread(adapter, "Scout adapter cancellation fixture");
  const h = await broker.startBroker({ env: { OPENSCOUT_T3_CONNECTIONS: JSON.stringify([{ id: connectionId, url: process.env.SCOUT_T3_LIVE_URL, tokenEnv: "SCOUT_T3_TEST_TOKEN" }]), SCOUT_T3_TEST_TOKEN: token } });
  await broker.seedBasicConversation(h);
  const attached = await broker.postJson<{ sessionId: string }>(h.baseUrl, "/v1/integrations/t3/attach", { connectionId, threadId });
  const receipt = await broker.postJson<any>(h.baseUrl, "/v1/deliver", { id: `cancel-${Date.now()}`, caller: { actorId: "operator", nodeId: h.nodeId },
    target: { kind: "session_id", sessionId: attached.sessionId }, body: "Use a shell tool to sleep for 25 seconds, then reply SCOUT_T3_CANCEL_SHOULD_NOT_COMPLETE. Do not edit files.",
    intent: "consult", ensureAwake: true, createdAt: Date.now() });
  const invocationId = receipt.flight.invocationId;
  let state = await broker.getJson<any>(h.baseUrl, `/v1/invocations/${invocationId}`);
  for (let i = 0; i < 200 && !state.flight?.metadata?.t3TurnId; i++) { await Bun.sleep(100); state = await broker.getJson(h.baseUrl, `/v1/invocations/${invocationId}`); }
  expect(state.flight.state).toBe("running");
  const turnId = state.flight.metadata.t3TurnId;
  expect(turnId).toBeTruthy();
  await broker.postJson(h.baseUrl, "/v1/flights", { ...state.flight, state: "cancelled", completedAt: Date.now() });
  let thread = await adapter.thread(threadId);
  for (let i = 0; i < 200 && thread.latestTurn?.state !== "interrupted"; i++) { await Bun.sleep(100); thread = await adapter.thread(threadId); }
  expect(thread.latestTurn.turnId).toBe(turnId);
  expect(thread.latestTurn.state).toBe("interrupted");
  state = await broker.getJson(h.baseUrl, `/v1/invocations/${invocationId}`);
  expect(state.flight.state).toBe("cancelled");
  expect(state.flight.output).toBeUndefined();
  writeFileSync(join(process.env.SCOUT_T3_LIVE_RECEIPTS!, "broker-cancellation-receipt.json"), JSON.stringify({ invocationId, turnId,
    flight: state.flight, sourceLatestTurn: thread.latestTurn, verifiedAt: new Date().toISOString() }, null, 2));
}, 60_000);

test.skipIf(!enabled)("real Scout card run reaches independent review while preserving T3 human acceptance", async () => {
  const root = process.env.SCOUT_T3_LIVE_RECEIPTS!;
  const token = readFileSync(process.env.SCOUT_T3_LIVE_TOKEN_FILE!, "utf8").trim();
  const connectionId = "live-t3", projectId = process.env.SCOUT_T3_LIVE_PROJECT_ID!;
  const adapter = new T3Adapter({ id: connectionId, url: process.env.SCOUT_T3_LIVE_URL!, tokenEnv: "TOKEN" }, { TOKEN: token });
  const source = await adapter.board(projectId);
  const cardId = `scout-adapter-${Date.now()}`, marker = `SCOUT_T3_CARD_${Date.now()}`;
  const now = new Date().toISOString();
  const card = { id: cardId, title: "Verify Scout card adapter", priority: 3, state: "Ready", createdAt: now, updatedAt: now,
    parallelism: { safe: "false", conflictsWith: [], allowedWriteScopes: [] },
    runtime: { attemptCount: 0, proofNotes: [] }, dependencies: [], workflowMode: "standard", fastModeApproval: undefined, reviewBypass: undefined,
    intentBrief: { intent: `Create scout-board-proof.txt with exactly ${marker} followed by a newline. Do not commit.`,
      desiredOutcome: "A verified fixture file for the Scout adapter end-to-end test.", acceptanceCriteria: [`scout-board-proof.txt contains exactly ${marker} followed by a newline.`], constraints: ["Only create scout-board-proof.txt."], nonGoals: [], openDecisions: [] } };
  const h = await broker.startBroker({ env: {
    OPENSCOUT_T3_CONNECTIONS: JSON.stringify([{ id: connectionId, url: process.env.SCOUT_T3_LIVE_URL, tokenEnv: "SCOUT_T3_TEST_TOKEN" }]), SCOUT_T3_TEST_TOKEN: token,
    OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS: "[]",
  } });
  await broker.seedBasicConversation(h);
  await adapter.call("projects.saveAgentBoard", { cwd: source.project.workspaceRoot, board: { ...source.board, cards: [...source.board.cards, card] } });
  const input = { connectionId, projectId, cardId, requestId: `run-${cardId}` };
  const receipt = await broker.postJson<{ accepted: boolean; flight: { invocationId: string } }>(h.baseUrl, "/v1/integrations/t3/run", input);
  expect(receipt.accepted).toBe(true);
  const invocationId = receipt.flight.invocationId;
  let done = await broker.getJson<any>(h.baseUrl, `/v1/invocations/${invocationId}`);
  for (let i = 0; i < 900 && !["completed", "failed", "cancelled"].includes(done.flight?.state); i++) {
    await Bun.sleep(250);
    done = await broker.getJson(h.baseUrl, `/v1/invocations/${invocationId}`);
  }
  expect(done.flight.error).toBeUndefined();
  expect(done.flight.state).toBe("completed");
  expect(done.flight.output).toContain("Human acceptance remains pending in T3.");
  const duplicate = await broker.postJson<any>(h.baseUrl, "/v1/integrations/t3/run", input);
  expect(duplicate.flight.invocationId).toBe(invocationId);
  const refreshed = await broker.postJson<any>(h.baseUrl, "/v1/integrations/t3/refresh", { connectionId, projectId });
  const work = refreshed.records.find((record: any) => record.externalContext.source.workItemId === cardId);
  expect(work).toMatchObject({ kind: "work_item", state: "review", acceptanceState: "pending", externalContext: { sourceState: "Review", workflow: { humanAcceptance: { required: true, state: "pending" } } } });
  const actual = (await adapter.board(projectId)).board.cards.find((entry: any) => entry.id === cardId);
  expect(actual.state).toBe("Review");
  expect(actual.runtime.attemptCount).toBe(1);
  expect(actual.runtime.implementationRunId).toBeTruthy();
  expect(actual.runtime.reviewRunId).toBeTruthy();
  expect(actual.runtime.reviewRunId).not.toBe(actual.runtime.implementationRunId);
  expect(readFileSync(join(actual.runtime.workspacePath, "scout-board-proof.txt"), "utf8")).toBe(`${marker}\n`);
  writeFileSync(join(root, "broker-board-receipt.json"), JSON.stringify({ invocationId, flight: done.flight, work, sourceCard: actual,
    proof: `${marker}\n`, duplicateInvocationId: duplicate.flight.invocationId, verifiedAt: new Date().toISOString() }, null, 2));
}, 300_000);
