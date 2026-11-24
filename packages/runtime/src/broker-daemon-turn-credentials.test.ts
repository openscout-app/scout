import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { FlightRecord, InvocationRequest } from "@openscout/protocol";

import { readNodeIdentity } from "./node-identity.js";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";
import { issueTurnCredential } from "./turn-credentials.js";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon turn credentials", () => {
  test("POST /v1/access/turn accepts a live turn's credential and refuses the rest", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);
    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ghost", kind: "agent", definitionId: "ghost", displayName: "Ghost", handle: "ghost", labels: ["test"],
      selector: "@ghost", defaultSelector: "@ghost", metadata: { source: "test" }, agentClass: "general",
      capabilities: ["chat", "invoke"], wakePolicy: "on_demand", homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId, advertiseScope: "local",
    });
    await broker.seedHangingReceiver(harness, "ghost");
    const invocation: InvocationRequest = {
      id: "inv-turn-1", requesterId: "operator", requesterNodeId: harness.nodeId, targetAgentId: "ghost",
      action: "consult", task: "read the channel", conversationId: "channel.shared", ensureAwake: true,
      stream: false, createdAt: Date.now(), metadata: { source: "test" },
    };
    await broker.postJson(harness.baseUrl, "/v1/invocations", invocation);
    const { flight } = await broker.waitFor(
      () => broker.getJson<{ flight: FlightRecord }>(harness.baseUrl, "/v1/invocations/inv-turn-1"),
      snapshot => snapshot.flight?.state === "running",
    );

    const identity = readNodeIdentity(join(harness.controlHome, "support"));
    expect(identity).not.toBeNull();
    const { credential, claims } = issueTurnCredential({ identity: identity!, nodeId: harness.nodeId, invocation, flight });

    const live = await broker.postJsonStatus(harness.baseUrl, "/v1/access/turn", { credential });
    expect(live).toEqual({ status: 200, body: { live: true, claims } });

    const ended = issueTurnCredential({ identity: identity!, nodeId: harness.nodeId, invocation, flight: { ...flight, id: "flt-missing" } });
    expect(await broker.postJsonStatus(harness.baseUrl, "/v1/access/turn", { credential: ended.credential }))
      .toEqual({ status: 403, body: { live: false, error: "turn_not_live" } });
    expect(await broker.postJsonStatus(harness.baseUrl, "/v1/access/turn", { credential: "flt-1" }))
      .toEqual({ status: 400, body: { live: false, error: "malformed_turn_credential" } });
  });
});
