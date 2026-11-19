import { expect, test } from "bun:test";
import { createBrokerDaemonTestHarness } from "../test-helpers/broker-daemon-harness.test.js";
import type { RuntimeRegistrySnapshot } from "../registry.js";
import { deliverInPlace, type DeliverInPlaceDeps } from "./deliver.js";

const broker = createBrokerDaemonTestHarness();

test("direct input finds a managed tmux endpoint by native and Scout session id", async () => {
  const { baseUrl, nodeId } = await broker.startBroker({ devInstance: true });
  const session = "session-managed-test";
  const native = "89f2414e-4aae-4210-9aef-01838f30bdd6";
  await broker.postJson(baseUrl, "/v1/actors", {
    id: session, kind: "session", displayName: "Worker", labels: [], metadata: { cardless: true },
  });
  await broker.postJson(baseUrl, "/v1/endpoints", {
    id: "managed-worker", agentId: session, nodeId, harness: "claude", transport: "tmux",
    state: "active", sessionId: session, pane: "%17",
    metadata: { cardless: true, tmuxSession: session, externalSessionId: native },
  });
  const snapshot = await broker.getJson<RuntimeRegistrySnapshot>(baseUrl, "/v1/snapshot");
  const prompts: string[] = [];
  const deps = {
    findHerdrPane: async () => null,
    findClaudeRecord: async () => null,
    codexThreadPids: async () => [],
    codexHeldByApp: async () => false,
    scoutLaunchedTmuxSessions: async () => new Set([session]),
    self: [],
    readTmuxTail: async (target: string, socketPath: string) => {
      expect([target, socketPath]).toEqual(["%17", "/tmp/fixture-tmux.sock"]);
      return "❯ \n";
    },
    promptTmux: async (target: string) => { prompts.push(target); },
    managedTmuxContext: async () => ({ nodeId, snapshot }),
    managedTmuxPane: async (name: string, pane: string | undefined) => name === session && pane === "%17" ? { target: pane, socketPath: "/tmp/fixture-tmux.sock" } : null,
  } satisfies DeliverInPlaceDeps;
  for (const sessionId of [native, session]) {
    expect(await deliverInPlace({ sessionId, harness: "claude", body: "Follow up" }, deps))
      .toMatchObject({ ok: true, via: "tmux" });
  }
  const endpoint = snapshot.endpoints["managed-worker"]!;
  endpoint.metadata = { ...endpoint.metadata, externalSessionId: undefined };
  snapshot.flights["flight-test"] = {
    id: "flight-test", invocationId: "inv-test", requesterId: "operator", targetAgentId: session, state: "running",
    metadata: { dispatchAck: { acknowledgedAt: Date.now(), endpointId: endpoint.id, nodeId,
      sessionId: session, harness: "claude", executionResolution: { sessionId: native } } },
  };
  const input = { sessionId: native, harness: "claude", body: "Follow up" };
  expect(await deliverInPlace(input, deps)).toMatchObject({ ok: true, via: "tmux" });
  expect(await deliverInPlace({ ...input, harness: "codex" }, deps)).toEqual({ ok: false, code: "not_live" });
  expect(await deliverInPlace(input, { ...deps, managedTmuxPane: async () => null }))
    .toEqual({ ok: false, code: "not_live" });
  expect(await deliverInPlace(input, { ...deps, readTmuxTail: async () => "❯ unsent draft\n" }))
    .toMatchObject({ ok: false, code: "busy" });
  endpoint.state = "waiting";
  expect(await deliverInPlace(input, deps)).toMatchObject({ ok: false, code: "session_blocked" });
  snapshot.flights["flight-test"]!.state = "completed";
  expect(await deliverInPlace(input, deps)).toEqual({ ok: false, code: "not_live" });
  expect(prompts).toEqual(["%17", "%17", "%17"]);
}, 30_000);
