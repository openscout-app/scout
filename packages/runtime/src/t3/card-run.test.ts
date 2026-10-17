import { describe, expect, test } from "bun:test";
import type { AgentEndpoint, CollaborationRecord, DeliveryIntent, FlightRecord, InvocationRequest, ScoutDeliverRequest, ScoutDeliverResponse } from "@openscout/protocol";
import { type T3Adapter } from "./adapter.js";
import { admitT3CardRun, runT3BoardCard } from "./card-run.js";
import { T3RpcError } from "./rpc-client.js";

const endpoint: AgentEndpoint = { id: "card-endpoint", agentId: "t3-project", nodeId: "node", harness: "bridge", transport: "http", state: "idle",
  sessionId: "card-session", metadata: { t3Session: true, connectionId: "local", projectId: "project-1", t3CardId: "card-1" } };
const invocation: InvocationRequest = { id: "invocation", requesterId: "operator", requesterNodeId: "node", targetAgentId: "t3-project",
  action: "execute", task: "Run the card", conversationId: "original-conversation", messageId: "original-message", ensureAwake: true, stream: false, createdAt: 1 };
const sourceCard = (state: string, threadId?: string) => ({ id: "card-1", title: "Implement a fixture", state, createdAt: "2026-01-01T00:00:00Z",
  runtime: threadId ? { implementationRunId: threadId } : {} });

function harness(options: { states?: string[]; failSubmission?: boolean; submissionError?: unknown; initialReceipt?: DeliveryIntent; missingThread?: boolean;
  implementationState?: string; reviewThread?: boolean; reviewState?: string; reviewBypass?: boolean; observationWindowMs?: number } = {}) {
  const receipts = new Map<string, DeliveryIntent>();
  if (options.initialReceipt) receipts.set(options.initialReceipt.id, options.initialReceipt);
  const work = new Map<string, CollaborationRecord>();
  let flight: FlightRecord = { id: invocation.id, invocationId: invocation.id, requesterId: "operator", targetAgentId: endpoint.agentId, state: "running" };
  let mutations = 0, reads = 0;
  const outputs: string[] = [];
  const states = options.states ?? ["Ready", "Review"];
  const withReviewContext = (state: string) => {
    const card = sourceCard(state, state === "Ready" ? undefined : "implementation-thread");
    return { ...card, ...(options.reviewBypass ? { reviewBypass: { at: "2026-01-01T00:00:00Z", reason: "Fast Mode approved" } } : {}),
      runtime: { ...card.runtime, ...(options.reviewThread ? { reviewRunId: "review-thread" } : {}) } };
  };
  const adapter = {
    async board() {
      const state = states[Math.min(reads++, states.length - 1)]!;
      return { project: { id: "project-1", workspaceRoot: "/fixture" }, board: { cards: [withReviewContext(state)] } };
    },
    async call(tag: string, payload: unknown) {
      mutations++;
      expect(tag).toBe("projects.runAgentBoardCard");
      expect(payload).toEqual({ cwd: "/fixture", cardId: "card-1" });
      expect(receipts.get("delivery")?.metadata?.phase).toBe("submitting");
      expect(flight.state).toBe("running");
      if (options.submissionError) throw options.submissionError;
      if (options.failSubmission) throw new Error("network lost after send");
      return { card: sourceCard("Running", "implementation-thread"), ...(options.missingThread ? {} : { threadId: "implementation-thread" }) };
    },
    async thread(id: string) {
      expect(["implementation-thread", "review-thread"]).toContain(id);
      return { id, projectId: "project-1", latestTurn: { turnId: id === "implementation-thread" ? "source-turn-1" : "source-review-turn",
        state: id === "implementation-thread" ? options.implementationState ?? "completed" : options.reviewState ?? "completed" } };
    },
  } as unknown as T3Adapter;
  const deps = {
    nodeId: "node", adapter, deliveryId: "delivery", pollMs: 1, observationWindowMs: options.observationWindowMs ?? 1000,
    delivery: (id: string) => receipts.get(id),
    recordDelivery: async (receipt: DeliveryIntent) => { receipts.set(receipt.id, receipt); },
    mutateDelivery: async (id: string, update: (current: DeliveryIntent) => DeliveryIntent | null) => {
      const current = receipts.get(id); if (!current) return undefined;
      const next = update(current); if (next) receipts.set(id, next); return next ?? undefined;
    },
    flight: () => flight,
    update: async (patch: Partial<FlightRecord>) => { flight = { ...flight, ...patch }; },
    work: (id: string) => work.get(id),
    recordWork: async (record: CollaborationRecord) => { work.set(record.id, record); },
    complete: async (output: string, turnId: string) => { expect(turnId).toBe("source-turn-1"); outputs.push(output); flight = { ...flight, state: "completed", output }; },
  };
  return { deps, receipts, work, outputs, get flight() { return flight; }, get mutations() { return mutations; } };
}

describe("T3 card admission", () => {
  test("persists a scoped exact target then creates the durable normal ask with stable retry content", async () => {
    const endpoints: AgentEndpoint[] = [];
    const requests: ScoutDeliverRequest[] = [];
    const deps = {
      nodeId: "node", endpoints: () => endpoints,
      persistActor: async () => {},
      persistEndpoint: async (value: AgentEndpoint) => { endpoints.push(value); },
      deliver: async (request: ScoutDeliverRequest) => {
        expect(endpoints.length).toBeGreaterThan(0);
        requests.push(request); return { accepted: true, kind: "delivery" } as ScoutDeliverResponse;
      },
    };
    const input = { connectionId: "local", projectId: "project-1", cardId: "card-1", requestId: "operator-request-1" };
    await admitT3CardRun(input, deps);
    await admitT3CardRun(input, deps);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({ intent: "consult", ensureAwake: true, workItem: { acceptanceState: "pending" }, invocationMetadata: { t3CardId: "card-1" } });
    expect(endpoints[0]!.metadata?.externalSessionId).toBeTruthy();
    expect(endpoints[0]!.metadata?.nativeSessionId).toBeUndefined();
    await admitT3CardRun({ ...input, connectionId: "remote" }, deps);
    expect(endpoints[2]!.metadata?.externalSessionId).not.toBe(endpoints[0]!.metadata?.externalSessionId);
    expect(requests[2]!.requestId).not.toBe(requests[0]!.requestId);
  });
});

describe("T3 card execution", () => {
  test("records submission before the RPC and completes at Review while source work awaits human acceptance", async () => {
    const h = harness({ states: ["Ready", "Reviewing", "Review"] });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.mutations).toBe(1);
    expect(h.flight.state).toBe("completed");
    expect(h.outputs).toEqual(["T3 card card-1 reached Review. Human acceptance remains pending in T3."]);
    expect(h.receipts.get("delivery")?.metadata).toMatchObject({ phase: "accepted", threadId: "implementation-thread", turnId: "source-turn-1", dispatchOutcome: "submitted" });
    const work = [...h.work.values()][0]!;
    expect(work).toMatchObject({ kind: "work_item", state: "review", acceptanceState: "pending", conversationId: "original-conversation" });
    expect(work.kind === "work_item" && work.externalContext?.workflow?.humanAcceptance?.state).toBe("pending");
  });

  test("resumes an accepted receipt without sending the board run again", async () => {
    const initialReceipt: DeliveryIntent = { id: "delivery", invocationId: invocation.id, targetId: endpoint.agentId, targetNodeId: "node", targetKind: "agent",
      transport: "http", reason: "invocation", policy: "durable", status: "acknowledged", metadata: { phase: "accepted", threadId: "implementation-thread" } };
    const h = harness({ states: ["Review"], initialReceipt });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.mutations).toBe(0);
    expect(h.flight.state).toBe("completed");
    expect(h.outputs).toHaveLength(1);
  });

  test("never attributes a scheduler-owned run or retries after an ambiguous acceptance", async () => {
    const h = harness({ failSubmission: true, states: ["Ready", "Review"] });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.flight.state).toBe("waiting");
    expect(h.receipts.get("delivery")?.metadata).toMatchObject({ phase: "submitting", observedState: "Review", observedImplementationThreadId: "implementation-thread" });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.mutations).toBe(1);
    expect(h.outputs).toHaveLength(0);
  });

  test("rejects cards already running before recording or issuing a new source mutation", async () => {
    const h = harness({ states: ["Running"] });
    await expect(runT3BoardCard(invocation, endpoint, h.deps)).rejects.toThrow("t3_card_requires_fresh_ready");
    expect(h.mutations).toBe(0);
    expect(h.receipts.size).toBe(0);
  });

  test("a successful response without an implementation thread cannot complete the Scout flight", async () => {
    const h = harness({ missingThread: true, states: ["Ready", "Review"] });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.flight.state).toBe("waiting");
    expect(h.mutations).toBe(1);
    expect(h.outputs).toHaveLength(0);
  });

  test("does not complete from a manually moved Review or Done column while implementation is still running", async () => {
    for (const column of ["Review", "Done"]) {
      const h = harness({ states: ["Ready", column], implementationState: "running", observationWindowMs: 10 });
      await runT3BoardCard(invocation, endpoint, h.deps);
      expect(h.flight.state).toBe("waiting");
      expect(h.outputs).toHaveLength(0);
      expect(h.mutations).toBe(1);
    }
  });

  test("waits for the configured review thread to complete even after the board is moved to Review", async () => {
    const h = harness({ reviewThread: true, reviewState: "running", observationWindowMs: 10 });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.flight.state).toBe("waiting");
    expect(h.outputs).toHaveLength(0);
  });

  test("an explicit Fast Mode review bypass does not require a stale review thread to complete", async () => {
    const h = harness({ reviewThread: true, reviewState: "running", reviewBypass: true });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.flight.state).toBe("completed");
    expect(h.outputs).toHaveLength(1);
  });

  test("fails an authentication rejection before source submission without claiming an uncertain execution", async () => {
    const h = harness({ submissionError: new T3RpcError("authentication", "upgrade rejected") });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.flight.state).toBe("failed");
    expect(h.flight.error).toBe("t3_rpc_authentication");
    expect(h.receipts.get("delivery")).toMatchObject({ status: "failed", metadata: { phase: "rejected", rejectionCode: "authentication" } });
    expect(h.outputs).toHaveLength(0);
  });

  test("keeps a remote runner error uncertain because source claim can precede the error", async () => {
    const h = harness({ submissionError: new T3RpcError("remote", "runner failed after claim") });
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.flight.state).toBe("waiting");
    expect(h.receipts.get("delivery")?.metadata?.phase).toBe("submitting");
    expect(h.mutations).toBe(1);
    expect(h.outputs).toHaveLength(0);
  });

  test("does not call the source runner when cancellation arrives during the awaited flight update", async () => {
    const h = harness();
    const update = h.deps.update;
    h.deps.update = async patch => { await update({ ...patch, state: "cancelled" }); };
    await runT3BoardCard(invocation, endpoint, h.deps);
    expect(h.flight.state).toBe("cancelled");
    expect(h.mutations).toBe(0);
    expect(h.outputs).toHaveLength(0);
  });
});
