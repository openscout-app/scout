import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import { assessScoutSetupCompletion, loadScoutCoreReport } from "./readiness.ts";
import { healthyCoreReport } from "../../../cli/test-fixtures/core-report.ts";
import type { HarnessCatalogSnapshot } from "@openscout/runtime/harnesses";
import type { CoreReportHealthPayload } from "@openscout/runtime/setup";

const servers: ReturnType<typeof Bun.serve>[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function payload(): CoreReportHealthPayload {
  const health = healthyCoreReport().service.health;
  if (health.state !== "observed") throw Error("invalid fixture");
  return structuredClone(health.payload);
}
function endpoint(body: unknown, status = 200) {
  let reads = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    expect(new URL(request.url).pathname).toBe("/health");
    reads++;
    return Response.json(body, { status });
  } });
  servers.push(server);
  return { env: { OPENSCOUT_BROKER_URL: server.url.href, OPENSCOUT_INSTANCE: "core-proof", OPENSCOUT_NODE_ID: "node-test" }, reads: () => reads };
}
const broker = { health: { ok: true } };
test("core completion uses the public assessor, with no app or coding agent required", async () => {
  const e = endpoint(payload());
  const coreReport = await loadScoutCoreReport({ env: e.env });
  const result = assessScoutSetupCompletion({ coreReport, broker });
  expect(result).toMatchObject({ scope: "core", outcome: "ready", webUrl: null, browserGuidance: null,
    coreCompletion: { schema: "scout.core-setup-completion/v1", outcome: "complete" } });
  expect(result.headline).toContain("sign-in has not been checked");
  expect(coreReport).toMatchObject({ custody: "not_assessed", service: { identity: "matched", state: "working" }, harnesses: [] });
  expect(Object.values(coreReport.optional).every(row => row.availability === "not_checked" && row.evidence === null)).toBe(true);
  expect(result.alsoAvailable.join(" ")).not.toMatch(/scout (menu|install|pair|server)/);
  expect(e.reads()).toBe(1);
});
test("an unverified or wrong identity cannot complete core setup", async () => {
  const e = endpoint(payload());
  for (const expected of [undefined, "another-node"]) {
    const report = await loadScoutCoreReport({ env: { ...e.env, OPENSCOUT_NODE_ID: expected } });
    expect(assessScoutSetupCompletion({ coreReport: report, broker }).outcome).toBe("running");
    expect(report.service.identity).toBe(expected ? "mismatch" : "unverified");
  }
});
test("real startup, journal and storage failures remain visible, not repaired by optional app fields", async () => {
  for (const body of [
    { ...payload(), storage: { journal: { state: "failing", code: "ENOSPC" } } },
    { ...payload(), projection: { state: "degraded" } },
    { ...payload(), memory: { storage: { checkedAt: 100, state: "critical" } } },
  ]) {
    const e = endpoint(body);
    const report = await loadScoutCoreReport({ env: e.env });
    expect(report.service.state).toBe("impaired");
    expect(assessScoutSetupCompletion({ coreReport: report, broker }).outcome).toBe("failed");
    expect(report.service.health).toMatchObject({ state: "observed", payload: body });
  }
});
test("HTTP refusals retain their status and body, unhealthy HTTP health is observed impairment", async () => {
  const refusal = { error: "core_refused", detail: "fixture refusal" };
  const e = endpoint(refusal, 403);
  const refused = await loadScoutCoreReport({ env: e.env });
  expect(refused.service.health).toMatchObject({ state: "refused", status: 403, body: refusal });
  expect(refused.service.state).toBe("inconclusive");
  const down = endpoint({ ...payload(), ok: false }, 503);
  const report = await loadScoutCoreReport({ env: down.env });
  expect(report.service.health).toMatchObject({ state: "observed", status: 503, payload: { ok: false } });
  expect(assessScoutSetupCompletion({ coreReport: report, broker }).outcome).toBe("failed");
});
test("invalid and unavailable health never mean healthy or stopped", async () => {
  const e = endpoint({ status: "not a health payload" });
  const invalid = await loadScoutCoreReport({ env: e.env });
  expect(invalid.service.health).toMatchObject({ state: "invalid_response", body: { status: "not a health payload" } });
  const missing = await loadScoutCoreReport({ env: { ...e.env, OPENSCOUT_BROKER_URL: "http://127.0.0.1:1" } });
  expect(missing.service.health.state).toBe("unavailable");
  for (const report of [invalid, missing]) expect(assessScoutSetupCompletion({ coreReport: report, broker }).outcome).toBe("running");
});
test("foreground handoff is acquisition guidance, never a core-ready claim; required failures survive it", async () => {
  const coreReport = await loadScoutCoreReport({ env: { OPENSCOUT_BROKER_URL: "http://127.0.0.1:1" } });
  const input = { coreReport, broker: { health: { ok: false }, reachable: false, serviceAdapter: "headless-foreground" }, brokerHandoff: { command: "openscout-runtime broker" } };
  expect(assessScoutSetupCompletion(input)).toMatchObject({ outcome: "handoff", nextStep: "openscout-runtime broker", coreCompletion: { outcome: "pending" } });
  expect(assessScoutSetupCompletion({ ...input, failures: ["required setup failed"] }).outcome).toBe("failed");
  expect(assessScoutSetupCompletion({ ...input, brokerWarning: "start failed" }).outcome).toBe("failed");
});


test("selected Unix health wins without asking the TCP endpoint or a private web service", async () => {
  const root = mkdtempSync(join(tmpdir(), "core-health-socket-")); roots.push(root);
  const socket = join(root, "control.sock");
  const tcp = endpoint({ error: "TCP must not be asked" }, 503);
  let reads = 0;
  const unix = Bun.serve({ unix: socket, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/health"); reads++;
    return Response.json(payload());
  } }); servers.push(unix);
  const report = await loadScoutCoreReport({ env: { ...tcp.env, OPENSCOUT_BROKER_SOCKET_PATH: socket } });
  expect(report.service.state).toBe("working");
  expect(report.service.identity).toBe("matched");
  expect(reads).toBe(1); expect(tcp.reads()).toBe(0);
});

test("deadline and cancellation retain unknown core state instead of proving stopped", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() {
    await Bun.sleep(100); return Response.json(payload());
  } }); servers.push(server);
  const env = { OPENSCOUT_BROKER_URL: server.url.href };
  const timed = await loadScoutCoreReport({ env, signal: AbortSignal.timeout(10) });
  expect(timed.service.health.state).toBe("timed_out");
  const controller = new AbortController(); controller.abort();
  const cancelled = await loadScoutCoreReport({ env, signal: controller.signal });
  expect(cancelled.service.health.state).toBe("cancelled");
  expect(timed.service.state).toBe("inconclusive"); expect(cancelled.service.state).toBe("inconclusive");
});


test("catalog presence is passive, and a stale handoff cannot override fresh verified core health", async () => {
  const e = endpoint(payload());
  const catalog = { generatedAt: 99, entries: [{ harness: "codex", readinessReport: {
    binaryPath: "/fixture/codex", binarySource: "fixture", ready: true, configured: true,
  } }] } as HarnessCatalogSnapshot;
  const coreReport = await loadScoutCoreReport({ env: e.env, catalog });
  expect(coreReport.harnesses).toEqual([{ harness: "codex", state: "found", binaryPath: "/fixture/codex",
    evidence: { source: "fixture", observedAt: 99 }, authentication: "not_checked", readiness: "not_checked" }]);
  const completion = assessScoutSetupCompletion({ coreReport,
    broker: { health: { ok: false }, reachable: false }, brokerHandoff: { command: "openscout-runtime broker" } });
  expect(completion).toMatchObject({ outcome: "ready", nextStep: "scout whoami" });
});
