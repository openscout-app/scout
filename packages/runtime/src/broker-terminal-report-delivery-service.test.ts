import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightRecord, InvocationRequest, MessageRecord } from "@openscout/protocol";
import { createInMemoryControlRuntime } from "./broker.js";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { BrokerFlightLifecycleService } from "./broker-flight-lifecycle-service.js";
import { isIdempotentMessageRetry } from "./broker-message-idempotency.js";
import { pendingInvocationResultReply } from "./broker-invocation-result-delivery-service.js";
import { BrokerTerminalReportDeliveryService, matchesPendingTerminalReport, pendingTerminalReport,
  prepareTerminalReport, terminalReportMessageId } from "./broker-terminal-report-delivery-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const invocation: InvocationRequest = {
  id: "inv", requesterId: "operator", requesterNodeId: "node", targetAgentId: "agent", action: "consult",
  task: "inspect", conversationId: "conversation", messageId: "request", ensureAwake: false, stream: false, createdAt: 1,
};
function terminal(id = "f1", state: "failed" | "cancelled" = "failed"): FlightRecord {
  return { id, invocationId: invocation.id, requesterId: invocation.requesterId, targetAgentId: invocation.targetAgentId,
    state, summary: `Task ${state}`, error: state === "failed" ? "transport failed" : undefined, completedAt: 2 };
}
const context = { nodeId: "node", systemActorId: "system", now: () => 3,
  conversation: () => ({ id: "conversation", kind: "direct" as const, title: "Work", participantIds: ["operator", "agent"] }),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "terminal-report-")); roots.push(directory);
  const path = join(directory, "journal.jsonl");
  let journal = new FileBackedBrokerJournal(path); await journal.load();
  let runtime = createInMemoryControlRuntime();
  let serial = Promise.resolve();
  const runWrite = <T>(work: () => Promise<T>): Promise<T> => {
    const result = serial.then(work); serial = result.then(() => {}, () => {}); return result;
  };
  const commit = async (entries: BrokerJournalEntry | BrokerJournalEntry[], apply: (entries: BrokerJournalEntry[]) => Promise<void>) => {
    const list = Array.isArray(entries) ? entries : [entries]; await journal.appendEntries(list); await apply(list); return list;
  };
  let postFails = false, ackFails = false, bookkeepingFails = false;
  let posts = 0;
  const messages = new Map<string, MessageRecord>();
  let outbox: BrokerTerminalReportDeliveryService;
  function resetOutbox() {
    outbox = new BrokerTerminalReportDeliveryService({ nodeId: "node", flightById: id => journal.getFlight(id),
      async postMessage(message) {
        posts++; if (postFails) throw new Error("post unavailable");
        const previous = messages.get(message.id);
        if (previous && !isIdempotentMessageRetry(previous, message)) throw new Error("conflicting retry");
        messages.set(message.id, structuredClone(message));
      },
      markDelivered: (id, expected) => runWrite(async () => {
        if (ackFails) throw new Error("crash before ack");
        const current = journal.getFlight(id);
        if (!current || !matchesPendingTerminalReport(current, expected)) return false;
        const flight = { ...current, metadata: { ...current.metadata, terminalReport: { ...expected, status: "delivered" } } };
        await commit({ kind: "flight.record", flight, preserveCurrent: true }, async () => runtime.upsertFlight(flight, { preserveCurrent: true }));
        return true;
      }),
    });
  }
  resetOutbox();
  const lifecycle = new BrokerFlightLifecycleService({
    runtime: { snapshot: () => runtime.snapshot(), upsertFlight: flight => runtime.upsertFlight(flight) },
    journal: { visitDeliveries: async () => { if (bookkeepingFails) throw new Error("postcommit delivery failure"); } },
    durableStore: { runWrite, commitEntries: commit, applyProjectedEntries: async () => {} },
    invocationFor: () => invocation, updateDeliveryStatus: async () => {}, updateDeliveryStatusIf: async () => false,
    promoteInvocationFlightToWork: async () => {}, maybeForwardFlightToAuthority: async () => {}, isInvocationActive: () => false,
    prepareTerminalReport: (flight, request) => prepareTerminalReport(flight, request, context),
    // Omit eager delivery to model a crash immediately after the durable commit.
  });
  return { lifecycle, messages, get journal() { return journal; }, get runtime() { return runtime; },
    get outbox() { return outbox!; }, get posts() { return posts; },
    failPost: (value: boolean) => { postFails = value; }, failAck: (value: boolean) => { ackFails = value; },
    failBookkeeping: () => { bookkeepingFails = true; },
    async reopen() {
      journal = new FileBackedBrokerJournal(path); await journal.load();
      runtime = createInMemoryControlRuntime();
      for (const flight of Object.values(journal.snapshot().flights)) await runtime.upsertFlight(flight);
      resetOutbox();
    },
  };
}

test.each(["failed", "cancelled"] as const)("%s report survives terminal commit followed by bookkeeping failure and restart", async state => {
  const h = await fixture(); h.failBookkeeping();
  await expect(h.lifecycle.recordFlight(terminal("f1", state))).rejects.toThrow("postcommit delivery failure");
  expect(h.messages.size).toBe(0);
  await h.reopen();
  expect([...h.journal.pendingTerminalReports()].map(f => f.id)).toEqual(["f1"]);
  expect(h.outbox.recover(h.journal.pendingTerminalReports()).scheduled).toBe(1);
  expect(await h.outbox.deliver("f1")).toBe("delivered");
  expect(h.messages.size).toBe(1);
  expect(h.runtime.flight("f1")?.state).toBe(state);
  expect(pendingInvocationResultReply(h.runtime.flight("f1"))).toBeNull();
  expect([...h.journal.pendingTerminalReports()]).toEqual([]);
  await h.reopen(); expect([...h.journal.pendingTerminalReports()]).toEqual([]);
});

test("lost report acknowledgement retries exact durable message and does not re-open an executor", async () => {
  const h = await fixture(); await h.lifecycle.recordFlight(terminal()); h.failAck(true);
  expect(await h.outbox.deliver("f1")).toBe("failed");
  const first = structuredClone([...h.messages.values()][0]!);
  await h.reopen(); h.failAck(false);
  expect(await h.outbox.deliver("f1")).toBe("delivered");
  expect(h.posts).toBe(2); expect([...h.messages.values()]).toEqual([first]);
  expect(h.runtime.flight("f1")?.state).toBe("failed");
});

test("post failure, duplicate terminal update and delayed enrichment preserve the first intent", async () => {
  const h = await fixture(); await h.lifecycle.recordFlight(terminal());
  const original = h.runtime.flight("f1")!; h.failPost(true);
  expect(await h.outbox.deliver("f1")).toBe("failed");
  await h.lifecycle.recordFlight({ ...terminal(), metadata: { terminalReport: { status: "delivered" } } });
  expect(pendingTerminalReport(h.runtime.flight("f1"))).toEqual(pendingTerminalReport(original));
  await h.lifecycle.recordFlight({ ...terminal(), summary: "later explanation" });
  await h.reopen();
  expect(pendingTerminalReport(h.runtime.flight("f1"))).toEqual(pendingTerminalReport(original));
  h.failPost(false); expect(await h.outbox.deliver("f1")).toBe("delivered");
  await h.lifecycle.recordFlight(original);
  expect(pendingTerminalReport(h.runtime.flight("f1"))).toBeNull();
  expect(await h.outbox.deliver("f1")).toBe("stale"); expect(h.posts).toBe(2);
});

test("two flights on the same invocation retain distinct reports and old acknowledgement cannot replace the current flight", async () => {
  const h = await fixture(); await h.lifecycle.recordFlight(terminal());
  await h.lifecycle.recordFlight(terminal("f2", "cancelled"));
  await h.reopen(); expect(h.runtime.flightForInvocation("inv")?.id).toBe("f2");
  expect([...h.journal.pendingTerminalReports()].map(f => f.id)).toEqual(["f1", "f2"]);
  expect(await h.outbox.deliver("f1")).toBe("delivered");
  expect(h.runtime.flightForInvocation("inv")?.id).toBe("f2");
  expect(await h.outbox.deliver("f2")).toBe("delivered");
  expect(h.messages.size).toBe(2);
  expect(terminalReportMessageId("f1", "failed")).not.toBe(terminalReportMessageId("f1", "cancelled"));
});

test("only the requester broker creates reports; successful replies retain their separate validator", () => {
  expect(prepareTerminalReport(terminal(), { ...invocation, requesterNodeId: "remote" }, context).metadata).toBeUndefined();
  expect(prepareTerminalReport({ ...terminal(), state: "completed", output: "done" }, invocation, context).metadata).toBeUndefined();
  const prepared = prepareTerminalReport(terminal(), invocation, context);
  expect(pendingTerminalReport(prepared)?.message).toMatchObject({ class: "status", replyToMessageId: "request", policy: "durable" });
  expect(pendingTerminalReport({ ...prepared, state: "completed" })).toBeNull();
  expect(pendingTerminalReport({ ...prepared, error: "different" })).toBeNull();
});

test("malformed reports are held without blocking valid work and copied remote reports are not delivered locally", async () => {
  const h = await fixture(); await h.lifecycle.recordFlight(terminal());
  const good = h.runtime.flight("f1")!;
  await h.journal.appendEntries({ kind: "flight.record", flight: { ...good, error: "changed after intent" } });
  expect(await h.outbox.deliver("f1")).toBe("stale");
  const intent = pendingTerminalReport(good)!;
  await h.journal.appendEntries({ kind: "flight.record", flight: { ...good, metadata: { terminalReport: { ...intent, message: { ...intent.message, originNodeId: "remote" } } } } });
  expect(await h.outbox.deliver("f1")).toBe("stale"); expect(h.posts).toBe(0);
  await h.journal.appendEntries({ kind: "flight.record", flight: good }); expect(await h.outbox.deliver("f1")).toBe("delivered");
});

test("report workers deduplicate and bound queued flight identities", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const flights = ["one", "two", "three"].map(id => prepareTerminalReport(terminal(id), invocation, context));
  const posted: string[] = [];
  const service = new BrokerTerminalReportDeliveryService({ nodeId: "node", maxPending: 2, concurrency: 1,
    flightById: id => flights.find(f => f.id === id),
    postMessage: async message => { posted.push(message.id); await gate; }, markDelivered: async () => true,
  });
  const first = service.deliver("one"); expect(service.deliver("one")).toBe(first);
  const second = service.deliver("two"); expect(await service.deliver("three")).toBe("deferred");
  expect(service.recover(flights).scanned).toBe(0); expect(service.pendingCount).toBe(2);
  release(); expect(await first).toBe("delivered"); expect(await second).toBe("delivered");
  expect(service.pendingCount).toBe(0); expect(posted).toHaveLength(2);
});

test("acknowledgement only consumes the exact report that was posted", async () => {
  let flight = prepareTerminalReport(terminal(), invocation, context);
  const expected = pendingTerminalReport(flight)!;
  const service = new BrokerTerminalReportDeliveryService({ nodeId: "node", flightById: () => flight,
    postMessage: async () => {
      flight = { ...flight, metadata: { terminalReport: { ...expected,
        message: { ...expected.message, audience: { delivery: "none" } } } } };
    }, markDelivered: async (_id, observed) => matchesPendingTerminalReport(flight, observed),
  });
  expect(await service.deliver(flight.id)).toBe("stale");
  expect(pendingTerminalReport(flight)).not.toEqual(expected);
});


test("report acknowledgement preserves other durable effects when runtime apply lagged the journal", async () => {
  const h = await fixture(); await h.lifecycle.recordFlight(terminal());
  const current = h.journal.getFlight("f1")!;
  // Model another writer's successful journal append followed by failed runtime apply.
  await h.journal.appendEntries({ kind: "flight.record", preserveCurrent: true, flight: { ...current,
    metadata: { ...current.metadata, workPromotion: { version: 1, status: "applied" } } } });
  expect(h.runtime.flight("f1")?.metadata?.workPromotion).toBeUndefined();
  expect(await h.outbox.deliver("f1")).toBe("delivered");
  expect(h.journal.getFlight("f1")?.metadata?.workPromotion).toEqual({ version: 1, status: "applied" });
  await h.reopen();
  expect(h.runtime.flight("f1")?.metadata?.workPromotion).toEqual({ version: 1, status: "applied" });
});
