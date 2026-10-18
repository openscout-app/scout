import { describe, expect, test } from "bun:test";
import type { FlightRecord, InvocationRequest } from "@openscout/protocol";
import { createInMemoryControlRuntime } from "./broker.js";
import { BrokerDispatchRecoveryService } from "./broker-dispatch-recovery-service.js";
import { staleWorkingFlightReason } from "./broker-local-invocation-helpers.js";
import { BrokerReplyCompletionRecovery } from "./broker-reply-completion-recovery.js";

function invocation(id = "inv"): InvocationRequest {
  return { id, requesterId: "operator", requesterNodeId: "local", targetAgentId: "agent", action: "consult",
    task: "test", ensureAwake: false, stream: false, createdAt: 1 };
}
function flight(id = "inv"): FlightRecord {
  return { id: `flight-${id}`, invocationId: id, requesterId: "operator", targetAgentId: "agent", state: "queued", startedAt: 1 };
}

describe("accepted reply completion recovery", () => {
  test("startup holds queued dispatch and stale reconciliation until accepted replies are checked", async () => {
    const runtime = createInMemoryControlRuntime();
    const request = invocation();
    await runtime.upsertFlight(flight());
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let dispatched = 0;
    const recovery = new BrokerReplyCompletionRecovery({
      flights: () => Object.values(runtime.peek().flights), invocation: () => request,
      recoverReply: async () => { entered.resolve(); await gate.promise;
        await runtime.upsertFlight({ ...flight(), state: "completed", output: "stored reply", completedAt: 2 });
        return true;
      },
    });
    const dispatch = new BrokerDispatchRecoveryService({
      runtimeSnapshot: () => runtime.peek(), dispatchJobs: () => [], invocationFor: () => request,
      isInvocationActive: id => recovery.isPending(id), runDispatchJob: async () => { dispatched++; },
      dispatchAcceptedInvocation: async () => { dispatched++; },
    });
    expect((await dispatch.recoverQueuedFlights({ reason: "endpoint_online" })).skippedActive).toBe(1);
    const recovering = recovery.recover();
    await entered.promise;
    expect(recovery.recover()).toBe(recovering);
    expect(staleWorkingFlightReason(runtime.snapshot(), flight(), { now: 500_000,
      isInvocationActive: id => recovery.isPending(id) })).toBeNull();
    expect((await dispatch.recoverQueuedFlights({ reason: "startup" })).skippedActive).toBe(1);
    gate.resolve();
    expect(await recovering).toEqual({ scanned: 1, recovered: 1, failed: 0 });
    await dispatch.recoverQueuedFlights({ reason: "startup" });
    expect(dispatched).toBe(0);
    expect(recovery.isPending(request.id)).toBe(false);
  });

  test("one storage failure holds only its flight and is retried on the next sweep", async () => {
    const failed: string[] = [];
    let unavailable = true;
    const recovery = new BrokerReplyCompletionRecovery({
      flights: () => [flight("bad"), flight("good")], invocation: id => invocation(id),
      recoverReply: async request => { if (request.id === "bad" && unavailable) throw new Error("storage unavailable"); return true; },
      warn: id => failed.push(id),
    });
    expect(await recovery.recover()).toEqual({ scanned: 2, recovered: 1, failed: 1 });
    expect(recovery.isPending("bad")).toBe(true);
    expect(recovery.isPending("good")).toBe(false);
    expect(failed).toEqual(["bad"]);
    unavailable = false;
    expect(await recovery.recover()).toEqual({ scanned: 2, recovered: 2, failed: 0 });
    expect(recovery.isPending("bad")).toBe(false);
  });

  test("terminal history never triggers message lookup, and active scans yield between bounded batches", async () => {
    const visited: string[] = [];
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const recovery = new BrokerReplyCompletionRecovery({
      flights: function* () {
        for (let index = 0; index < 100; index++) yield { ...flight(`old-${index}`), state: "completed" };
        for (let index = 0; index < 65; index++) yield flight(String(index));
      },
      invocation: id => invocation(id),
      recoverReply: async request => {
        if (request.id === "64") expect(yielded).toBe(true);
        visited.push(request.id); return false;
      },
    });
    expect(await recovery.recover()).toEqual({ scanned: 65, recovered: 0, failed: 0 });
    expect(visited).toHaveLength(65);
    expect(visited[0]).toBe("0");
    expect(recovery.isPending("new-request")).toBe(false);
  });
});
