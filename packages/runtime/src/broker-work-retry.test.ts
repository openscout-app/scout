import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILED_RUN_CAUSES, type AgentDefinition, type FlightRecord, type InvocationRequest,
  type ScoutDeliverRequest, type ScoutDeliverResponse, type WorkItemRecord } from "@openscout/protocol";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { FileBackedBrokerJournal } from "./broker-journal.js";
import { projectWorkFlight } from "./broker-failed-work.js";
import { BrokerWorkRetryService } from "./broker-work-retry.js";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function fixture(cause: string = "harness_start") {
  const directory = mkdtempSync(join(tmpdir(), "work-retry-test-")); paths.push(directory);
  const path = join(directory, "journal.ndjson");
  let journal = new FileBackedBrokerJournal(path); await journal.load();
  const original: InvocationRequest = { origin: { source: "unknown" }, id: "original-ask", requesterId: "operator", requesterNodeId: "node-1",
    targetAgentId: "agent-1", task: "Review this exact change", action: "consult", collaborationRecordId: "work-1",
    ensureAwake: true, stream: false, createdAt: 10,
    execution: { harness: "codex", model: "test-model", session: "existing", targetSessionId: "broken-session", reasoningEffort: "high" } };
  let failed: FlightRecord = { id: "failed-flight", invocationId: original.id, targetAgentId: "agent-1", requesterId: "operator",
    startedAt: 10, completedAt: 20, state: "failed", error: "Deliberately unrelated error prose", metadata: { failureCause: cause } };
  const work: WorkItemRecord = projectWorkFlight({ id: "work-1", kind: "work_item", state: "working", acceptanceState: "none",
    title: "Change", ownerId: "agent-1", createdById: "operator", requestedById: "operator", nextMoveOwnerId: "agent-1", createdAt: 10, updatedAt: 10 }, failed, 20);
  await journal.appendEntries([{ kind: "agent.upsert", agent: { id: "agent-1" } as AgentDefinition },
    { kind: "invocation.record", invocation: original }, { kind: "flight.record", flight: failed }, { kind: "collaboration.record", record: work }]);
  const calls: ScoutDeliverRequest[] = [];
  let hideExecutions = false;
  let fail: "none" | "before" | "after" | "refuse" = "none";
  const durableStore = new BrokerDurableStore({ journal: { appendEntries: entries => journal.appendEntries(entries) },
    projection: { applyEntries: async () => [] }, threadEvents: { publish() {} } });
  function wire() {
    return new BrokerWorkRetryService({ nodeId: "node-1", snapshot: () => hideExecutions ? { ...journal.snapshot(), invocations: {}, flights: {} } : journal.snapshot(), record: id => journal.getCollaborationRecord(id), durableStore,
      apply: async () => {}, appendEvent: async () => {},
      accept: async request => {
        calls.push(request);
        if (fail === "refuse") return { kind: "question", accepted: false } as ScoutDeliverResponse;
        if (fail === "before") throw new Error("uncertain before acceptance");
        const invocation: InvocationRequest = { ...original, id: `inv-${request.requestId}`, requestId: request.requestId,
          createdAt: request.createdAt!, execution: request.execution, metadata: request.invocationMetadata };
        const flight: FlightRecord = { id: `flight-${request.requestId}`, invocationId: invocation.id, targetAgentId: "agent-1", requesterId: "operator", state: "queued", startedAt: invocation.createdAt };
        await journal.appendEntries([{ kind: "invocation.record", invocation }, { kind: "flight.record", flight }]);
        if (fail === "after") throw new Error("uncertain after acceptance");
        return { kind: "delivery", accepted: true, flight } as ScoutDeliverResponse;
      },
    });
  }
  let service = wire();
  return { calls, original, failed, hideExecutions: () => { hideExecutions = true; }, journal: () => journal, service: () => service, setFailure: (value: typeof fail) => { fail = value; },
    async reopen() { await durableStore.flushProjectedEntries(); await journal.close(); journal = new FileBackedBrokerJournal(path); await journal.load(); service = wire(); },
    async edit(patch: Partial<WorkItemRecord>) { await journal.appendEntries({ kind: "collaboration.record", record: { ...journal.getCollaborationRecord("work-1"), ...patch } as WorkItemRecord }); },
    async sessionOnly(harness = "codex") {
      await journal.appendEntries([
        { kind: "agent.delete", agentId: "agent-1" },
        { kind: "agent.endpoint.upsert", endpoint: { id: "session-endpoint", agentId: "agent-1", nodeId: "node-1", harness: harness as "codex",
          transport: "tmux", state: "offline", sessionId: "broken-session", cwd: "/fixture/project" } },
      ]);
    },
    async failRetry() {
      const snapshot = journal.snapshot();
      const retry = Object.values(snapshot.flights).find(item => item.id !== failed.id)!;
      failed = { ...retry, state: "failed", completedAt: Date.now(), metadata: { failureCause: "harness_start" } };
      const record = projectWorkFlight(journal.getCollaborationRecord("work-1") as WorkItemRecord, failed, Date.now());
      await journal.appendEntries([{ kind: "flight.record", flight: failed }, { kind: "collaboration.record", record }]);
    },
    async close() { await durableStore.flushProjectedEntries(); await journal.close(); },
  };
}

test("concurrent and repeated retry calls produce one fresh ask and one receipt after reopen", async () => {
  const f = await fixture();
  try {
    expect(f.calls).toHaveLength(0);
    const input = { workId: "work-1", attempt: 1 };
    const [a, b] = await Promise.all([f.service().retry(input), f.service().retry(input)]);
    expect(a).toEqual(b); expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ body: f.original.task, target: { kind: "agent_id", agentId: "agent-1" },
      collaborationRecordId: "work-1", execution: { session: "new", harness: "codex", model: "test-model", reasoningEffort: "high" } });
    expect(f.calls[0]!.execution?.targetSessionId).toBeUndefined();
    expect(f.journal().getCollaborationRecord("work-1")).toMatchObject({ state: "working" });
    await f.reopen();
    expect(await f.service().retry(input)).toEqual(a); expect(f.calls).toHaveLength(1);
    expect(f.journal().listCollaborationEvents({ recordId: "work-1" })).toHaveLength(1);
  } finally { await f.close(); }
});

test.each(["before", "after"] as const)("retry recovers an uncertain %s acceptance receipt without changing the command", async failure => {
  const f = await fixture();
  try {
    f.setFailure(failure);
    await expect(f.service().retry({ workId: "work-1", attempt: 1 })).rejects.toThrow("uncertain");
    const originalCommand = f.calls[0];
    await f.reopen(); f.setFailure("none");
    await f.service().retry({ workId: "work-1", attempt: 1 });
    expect(f.calls).toHaveLength(failure === "before" ? 2 : 1);
    expect(f.calls.at(-1)).toEqual(originalCommand);
    expect(Object.keys(f.journal().snapshot().invocations)).toHaveLength(2);
    expect(f.journal().getCollaborationRecord("work-1")).toMatchObject({ state: "working" });
  } finally { await f.close(); }
});

test("a second attempt is distinct and an older attempt still returns its receipt", async () => {
  const f = await fixture();
  try {
    const a = await f.service().retry({ workId: "work-1", attempt: 1 });
    await f.failRetry();
    const b = await f.service().retry({ workId: "work-1", attempt: 2 });
    expect(a.requestId).not.toBe(b.requestId); expect(a.invocationId).not.toBe(b.invocationId);
    expect(await f.service().retry({ workId: "work-1", attempt: 1 })).toEqual(a);
    expect(f.calls).toHaveLength(2);
  } finally { await f.close(); }
});

test.each(FAILED_RUN_CAUSES)("retry policy refuses or accepts %s with an actionable result", async cause => {
  const f = await fixture(cause);
  try {
    const retry = f.service().retry({ workId: "work-1", attempt: 1 });
    if (cause === "endpoint_lost" || cause === "harness_start") await retry;
    else { await expect(retry).rejects.toThrow(`cannot retry cause ${cause}`); expect(f.calls).toHaveLength(0); }
  } finally { await f.close(); }
});

test("Done, Drop, ordinary waiting and active work cannot start a retry", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ state: "done" }, { state: "cancelled" }, { state: "working" },
      { state: "waiting", waitingOn: { kind: "condition", label: "CI" } }] as Partial<WorkItemRecord>[]) {
      await f.edit(patch);
      await expect(f.service().retry({ workId: "work-1", attempt: 1 })).rejects.toThrow("not waiting on its newest failed run");
    }
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test("skipping attempts and invalid attempts fail immediately", async () => {
  const f = await fixture();
  try {
    await expect(f.service().retry({ workId: "work-1", attempt: 2 })).rejects.toThrow("Next retry attempt is 1");
    expect(() => f.service().retry({ workId: "work-1", attempt: 0 })).toThrow("positive integer");
  } finally { await f.close(); }
});


test("the work retains accepted receipts after execution history leaves the hot snapshot", async () => {
  const f = await fixture();
  try {
    const input = { workId: "work-1", attempt: 1 };
    const receipt = await f.service().retry(input);
    await f.edit({ state: "done" }); await f.reopen(); f.hideExecutions();
    expect(await f.service().retry(input)).toEqual(receipt);
    expect(f.calls).toHaveLength(1);
    expect(f.journal().getCollaborationRecord("work-1")?.state).toBe("done");
  } finally { await f.close(); }
});


test("a session-only target retries its verified project and harness, not the broken session", async () => {
  const f = await fixture();
  try {
    await f.sessionOnly();
    await f.service().retry({ workId: "work-1", attempt: 1 });
    expect(f.calls[0]).toMatchObject({ target: { kind: "project_path", projectPath: "/fixture/project" }, execution: { harness: "codex", session: "new" } });
    expect(f.calls[0]?.execution?.targetSessionId).toBeUndefined();
  } finally { await f.close(); }
});

test("a mismatched session-only target refuses before dispatch instead of guessing another session", async () => {
  const f = await fixture();
  try {
    await f.sessionOnly("claude");
    await expect(f.service().retry({ workId: "work-1", attempt: 1 })).rejects.toThrow("--project and --harness");
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});


test("a known admission refusal stays idempotent but allows a new attempt after target repair", async () => {
  const f = await fixture();
  try {
    f.setFailure("refuse");
    await expect(f.service().retry({ workId: "work-1", attempt: 1 })).rejects.toThrow("refused before execution");
    f.setFailure("none"); await f.reopen();
    await expect(f.service().retry({ workId: "work-1", attempt: 1 })).rejects.toThrow("use attempt 2");
    expect(f.calls).toHaveLength(1);
    await f.service().retry({ workId: "work-1", attempt: 2 });
    expect(f.calls).toHaveLength(2);
  } finally { await f.close(); }
});
