import { expect, test } from "bun:test";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test.js";

const broker = createBrokerDaemonTestHarness();

test("a host refusal remains retryable with the same request content across restart", async () => {
  const first = await broker.startBroker();
  const payload = {
    requestId: "host-refusal", caller: { actorId: "operator", nodeId: first.nodeId },
    target: { kind: "project_path", projectPath: "/missing/example-project", host: "unknown-example-host" },
    body: "Inspect the project", intent: "consult", createdAt: Date.now(),
  };
  const send = (baseUrl: string, body = payload) => broker.requestJson(baseUrl, "/v1/deliver", {
    method: "POST", body: JSON.stringify(body),
  });
  const before = await broker.getJson<any>(first.baseUrl, "/v1/snapshot");
  for (let index = 0; index < 2; index += 1) {
    const refused = await send(first.baseUrl);
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused.body)).toContain("no mesh machine by that name");
    expect(JSON.stringify(refused.body)).not.toContain("request_outcome_unknown");
  }
  const after = await broker.getJson<any>(first.baseUrl, "/v1/snapshot");
  for (const key of ["messages", "invocations", "flights", "endpoints"]) {
    expect(after[key]).toEqual(before[key]);
  }
  first.child.kill();
  await first.child.exited;
  broker.harnesses.delete(first);
  const second = await broker.startBroker({ controlHome: first.controlHome });
  const refused = await send(second.baseUrl);
  expect(JSON.stringify(refused.body)).toContain("no mesh machine by that name");
  const changed = await send(second.baseUrl, { ...payload, body: "Different task" });
  expect(changed.ok).toBe(false);
  expect(JSON.stringify(changed.body)).toContain("different content");
}, 20_000);
