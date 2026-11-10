import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEndpoint, DeliveryIntent, FlightRecord, MessageRecord, ScoutDeliverResponse } from "@openscout/protocol";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";
import { decodeJournalLine } from "./broker-journal-framing.js";

const broker = createBrokerDaemonTestHarness();
type Receipt = Extract<ScoutDeliverResponse, { kind: "delivery" }>;

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`an ask survives runtime ${signal} and its later reply reaches the requester once`, async () => {
    const root = mkdtempSync(join(tmpdir(), "scout-ask-restart-"));
    const bin = join(root, "bin");
    const log = broker.writeFakeTmuxBin(bin);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      OPENSCOUT_FAKE_TMUX_SESSION: "restart-worker-session",
      OPENSCOUT_FAKE_TMUX_LOG: log,
      OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
    };
    let runtime = await broker.startBroker({ controlHome: root, devInstance: true, env });
    const baseUrl = runtime.baseUrl;
    const start = () => broker.startBroker({ controlHome: root, devInstance: true, port: Number(new URL(baseUrl).port), env });
    const stop = async () => {
      runtime.child.kill(signal);
      await runtime.child.exited;
      await Promise.all(runtime.outputDrain);
      broker.harnesses.delete(runtime); // retain durable state for the next process
    };
    const current = () => broker.getJson<{ flight: FlightRecord }>(runtime.baseUrl, `/v1/invocations/${ask.flight!.invocationId}`);
    await broker.postJson(runtime.baseUrl, "/v1/agents", {
      id: "restart-requester", kind: "agent", definitionId: "restart-requester", displayName: "Requester",
      agentClass: "general", capabilities: ["chat", "invoke"], wakePolicy: "on_demand",
      homeNodeId: runtime.nodeId, authorityNodeId: runtime.nodeId, advertiseScope: "local",
    });
    await broker.postJson(runtime.baseUrl, "/v1/endpoints", {
      id: "restart-requester-inbox", agentId: "restart-requester", nodeId: runtime.nodeId,
      harness: "mcp", transport: "mcp_poll", state: "idle",
    });
    await broker.postJson(runtime.baseUrl, "/v1/actors", {
      id: "restart-worker", kind: "session", displayName: "Worker", labels: [], metadata: { cardless: true, harness: "claude" },
    });
    await broker.postJson(runtime.baseUrl, "/v1/endpoints", {
      id: "restart-worker-endpoint", agentId: "restart-worker", nodeId: runtime.nodeId,
      harness: "claude", transport: "tmux", state: "idle", sessionId: "restart-worker-session",
      cwd: root, projectRoot: root,
      metadata: { cardless: true, sessionBacked: true, pendingExternalSession: true },
    });
    const request = {
      requestId: "restart-ask", caller: { actorId: "restart-requester", nodeId: runtime.nodeId },
      target: { kind: "session_id", sessionId: "restart-worker-session" },
      intent: "consult", body: "Wait for the test gate, then answer.",
    };
    const ask = await broker.postJson<Receipt>(runtime.baseUrl, "/v1/deliver", request);
    expect(ask.accepted).toBe(true);
    await broker.waitFor(async () => readFileSync(log, "utf8"), value => value.includes("paste-buffer"));
    expect(readFileSync(log, "utf8").split("\n").filter(line => line.startsWith("paste-buffer"))).toHaveLength(1);
    expect((await current()).flight.state).toBe("running");

    // Deterministic agent fixture, not an LLM: its independent process survives
    // the daemon. The tmux transport is simulated; routing, dispatch, journal,
    // restart, final-reply admission and requester inbox are the real runtime.
    const gate = join(root, "reply-gate.json"), ready = join(root, "worker-ready");
    const worker = Bun.spawn({
      cmd: [process.execPath, "-e", `
        const {existsSync,readFileSync,writeFileSync}=await import("node:fs");
        const [url,gate,ready]=process.argv.slice(1);
        writeFileSync(ready,"working");
        const deadline=Date.now()+20000;
        while(!existsSync(gate)){if(Date.now()>deadline)throw Error("reply gate timed out");await Bun.sleep(10);}
        const body=JSON.parse(readFileSync(gate,"utf8"));
        for(let i=0;i<3;i++){
          const response=await fetch(url+"/v1/deliver",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
          if(!response.ok)throw Error(await response.text());
        }
      `, baseUrl, gate, ready], stdout: "pipe", stderr: "pipe",
    });
    try {
      await broker.waitFor(async () => existsSync(ready), Boolean);
      expect(existsSync(ready)).toBe(true);
      const before = (await current()).flight;
      const firstPid = runtime.child.pid;
      await stop();
      expect(worker.exitCode).toBeNull();
      runtime = await start();
      expect(runtime.child.pid).not.toBe(firstPid);
      // Startup recovery has finished before startBroker returns. There is no
      // reply yet: restarting must not invent a terminal failure or redispatch.
      const restored = (await current()).flight;
      expect(restored.id).toBe(before.id);
      expect(restored.state).toBe("running");
      expect(restored.completedAt).toBeUndefined();
      expect(restored.error).toBeUndefined();
      expect(readFileSync(log, "utf8").split("\n").filter(line => line.startsWith("paste-buffer"))).toHaveLength(1);
      const endpoint = (await broker.getJson<{ endpoints: Record<string, AgentEndpoint> }>(runtime.baseUrl, "/v1/snapshot")).endpoints["restart-worker-endpoint"];
      expect(endpoint?.state).toBe("active");
      expect(runtime.baseUrl).toBe(baseUrl);
      writeFileSync(gate, JSON.stringify({
        requestId: "restart-answer", caller: { actorId: "restart-worker", nodeId: runtime.nodeId },
        target: { kind: "binding_ref", ref: ask.message!.id }, intent: "tell", body: "The delayed answer survived.",
      }));
      expect(await worker.exited).toBe(0);
      const completed = await broker.waitFor(current, value => value.flight.state === "completed");
      expect(completed.flight).toMatchObject({ id: before.id, state: "completed", output: "The delayed answer survived." });
      const assertOnce = async () => {
        const messages = await broker.getJson<MessageRecord[]>(runtime.baseUrl, `/v1/messages?conversationId=${ask.message!.conversationId}`);
        const replies = messages.filter(message => message.actorId === "restart-worker" && message.replyToMessageId === ask.message!.id);
        expect(replies).toHaveLength(1);
        expect(replies[0]?.body).toBe(completed.flight.output);
        const deliveries = await broker.getJson<DeliveryIntent[]>(runtime.baseUrl, `/v1/deliveries?messageId=${replies[0]!.id}&targetId=restart-requester`);
        expect(deliveries).toHaveLength(1);
        return deliveries[0]!;
      };
      const delivery = await assertOnce();
      const claim = await broker.postJson<{ claimed: DeliveryIntent | null }>(runtime.baseUrl, "/v1/deliveries/claim", {
        messageId: delivery.messageId, targetId: "restart-requester", leaseOwner: "requester-test",
      });
      expect(claim.claimed?.id).toBe(delivery.id);
      await broker.postJson(runtime.baseUrl, "/v1/deliveries/status", { deliveryId: delivery.id, status: "acknowledged", leaseOwner: "requester-test" });
      // Retry the accepted ask and restart again after completion/consumption.
      const retry = await broker.postJson<Receipt>(runtime.baseUrl, "/v1/deliver", request);
      expect(retry.flight?.id).toBe(before.id);
      await stop();
      runtime = await start();
      expect((await current()).flight).toMatchObject({ state: "completed", completedAt: completed.flight.completedAt, output: completed.flight.output });
      await broker.postJson(runtime.baseUrl, "/v1/deliver", JSON.parse(readFileSync(gate, "utf8")));
      await assertOnce();
      const secondClaim = await broker.postJson<{ claimed: DeliveryIntent | null }>(runtime.baseUrl, "/v1/deliveries/claim", {
        messageId: delivery.messageId, targetId: "restart-requester", leaseOwner: "requester-test",
      });
      expect(secondClaim.claimed).toBeNull();
      const entries = readFileSync(join(runtime.controlHome, "broker-journal.jsonl"), "utf8").trim().split("\n").flatMap(line => decodeJournalLine(line));
      const outcomes = entries.filter(entry => entry.kind === "flight.record" && entry.flight.id === before.id && ["completed", "failed", "cancelled"].includes(entry.flight.state));
      // Terminal metadata enrichment is legal, but only one completion time/result.
      expect(outcomes.length).toBeGreaterThan(0);
      expect(new Set(outcomes.map(entry => entry.kind === "flight.record" && JSON.stringify([entry.flight.state, entry.flight.completedAt, entry.flight.output]))).size).toBe(1);
      expect(readFileSync(log, "utf8").split("\n").filter(line => line.startsWith("paste-buffer"))).toHaveLength(1);
    } finally {
      worker.kill("SIGKILL");
      await worker.exited;
    }
  }, 40_000);
}
