import { expect, test } from "bun:test";
import {
  assessCoreSetupCompletion as complete, buildCoreServiceReport as build, describeCoreHarnessPresence as presence,
  CORE_OPTIONAL_CAPABILITIES, type CoreHealthObservation, type CoreReportHealthPayload, type CoreOptionalObservation,
} from "./core-report.js";

const target = { instance: "test-one", brokerUrl: "http://127.0.0.1:54321", expectedNodeId: "node-one" };
function healthy(): CoreReportHealthPayload {
  return {
    ok: true, nodeId: "node-one",
    startup: { state: "ready", mutationsAdmitted: true, coreReady: true, historyReady: true,
      phase: "ready", milestones: { readyAt: 100 }, error: null,
      journal: { phase: "complete", entries: 42, messageCount: 12, bytes: 1000, totalBytes: 1000,
        compactionMs: 0, compactionDeferral: null, error: null } },
    projection: { state: "ready", detail: null },
    storage: { journal: { state: "ok" } },
    memory: { storage: { checkedAt: 100, files: {}, freeDiskBytes: 10_000, minimumFreeDiskBytes: 100, state: "ready" } },
  };
}
function observation(payload = healthy()): Extract<CoreHealthObservation, { state: "observed" }> {
  return { target: { instance: target.instance, brokerUrl: target.brokerUrl }, checkedAt: 101, state: "observed", status: 200, payload };
}
function report(payload = healthy()) { return build({ target, health: observation(payload), now: 102 }); }
const capability: CoreOptionalObservation = { availability: "available",
  evidence: { source: "injected fixture", observedAt: 100, scope: "machine", detail: "Observed, not installed by report." } };

test("reports existing core evidence without constructing a service ownership object", () => {
  const result = report();
  expect(result).toMatchObject({ schema: "scout.core-report/v1", observedAt: 102, target,
    custody: "not_assessed", service: { state: "working", identity: "matched" } });
  expect(result.service.checks.map(c => c.name)).toEqual(["health", "startup", "projection", "journal", "storage"]);
  expect(result.service.checks.every(c => c.state === "working")).toBe(true);
  expect(result.service.health).toEqual(observation());
  expect(result).not.toHaveProperty("pid");
  expect(result).not.toHaveProperty("installed");
  expect(result).not.toHaveProperty("loaded");
  expect(result).not.toHaveProperty("serviceAdapter");
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("default optional capabilities are not checked, not unavailable or impaired", () => {
  const result = report();
  expect(Object.keys(result.optional)).toEqual([...CORE_OPTIONAL_CAPABILITIES]);
  expect(Object.values(result.optional).every(row => row.availability === "not_checked" && row.evidence === null)).toBe(true);
  expect(result.service.state).toBe("working");
  expect(complete({ report: result }).outcome).toBe("complete");
});

test.each([...CORE_OPTIONAL_CAPABILITIES])("optional %s availability never repairs or impairs core", name => {
  for (const availability of ["available", "unavailable"] as const) {
    const optional = { [name]: { ...capability, availability } };
    const good = build({ target, health: observation(), optional });
    expect(good.optional[name]).toEqual(optional[name]!);
    expect(complete({ report: good }).outcome).toBe("complete");
    const bad = build({ target, health: observation({ ...healthy(), ok: false }), optional });
    expect(bad.service.state).toBe("impaired");
    expect(complete({ report: bad }).outcome).toBe("failed");
  }
});

test.each(["not_checked", "unavailable", "timed_out", "cancelled", "refused", "invalid_response"] as const)(
  "%s health is inconclusive, never proof the broker stopped", state => {
    const health: CoreHealthObservation = { target, checkedAt: state === "not_checked" ? null : 100,
      state, error: "original error", status: 403, body: { error: "original_refusal", detail: "retained verbatim" } };
    const result = build({ target, health });
    expect(result.service.state).toBe("inconclusive");
    expect(result.service.identity).toBe("unverified");
    expect(result.service.health).toEqual(health);
    expect(complete({ report: result }).outcome).toBe("pending");
  },
);

test("all optional capabilities available cannot turn absent core evidence into success", () => {
  const optional = Object.fromEntries(CORE_OPTIONAL_CAPABILITIES.map(name => [name, capability]));
  const result = build({ target, health: { target, state: "unavailable", checkedAt: 100 }, optional });
  expect(result.service.state).toBe("inconclusive");
  expect(complete({ report: result }).outcome).toBe("pending");
});

test("liveness alone does not verify startup, journal, projection or disk state", () => {
  const result = report({ ok: true, nodeId: "node-one" });
  expect(result.service.state).toBe("inconclusive");
  expect(result.service.checks.filter(c => c.state === "not_checked")).toHaveLength(4);
  expect(complete({ report: result }).outcome).toBe("pending");
});

test.each([
  ["unhealthy liveness", (p: CoreReportHealthPayload) => { p.ok = false; }, "health"],
  ["journal ENOSPC", (p: CoreReportHealthPayload) => { p.storage!.journal = { state: "failing", since: 1, lastFailedAt: 2, failures: 3, code: "ENOSPC", error: "disk full" }; }, "journal"],
  ["journal replay failure", (p: CoreReportHealthPayload) => { p.startup!.journal!.phase = "failed"; p.startup!.journal!.error = "unsupported frame"; }, "startup"],
  ["compaction capacity failure", (p: CoreReportHealthPayload) => { p.startup!.journal!.compactionDeferral = { code: "EDQUOT", operation: "write", error: "quota" }; }, "startup"],
  ["failed startup phase", (p: CoreReportHealthPayload) => { p.startup!.phase = "failed"; }, "startup"],
  ["startup degradation", (p: CoreReportHealthPayload) => { p.startup!.state = "degraded"; }, "startup"],
  ["startup error", (p: CoreReportHealthPayload) => { p.startup!.error = "schema newer"; }, "startup"],
  ["projection degradation", (p: CoreReportHealthPayload) => { p.projection = { state: "degraded", detail: "schema newer" }; }, "projection"],
  ["disabled core projection", (p: CoreReportHealthPayload) => { p.projection = { state: "disabled", detail: "disabled" }; }, "projection"],
  ["projection skips", (p: CoreReportHealthPayload) => { p.projection!.skips = { total: 1, byKind: { "message.record": { count: 1, firstReason: "bad", lastReason: "bad" } } }; }, "projection"],
  ["quarantined projection record", (p: CoreReportHealthPayload) => { p.projection!.quarantine = { openCount: 1, acknowledgedCount: 0, samples: [] }; }, "projection"],
  ["critical storage", (p: CoreReportHealthPayload) => { p.memory!.storage!.state = "critical"; }, "storage"],
  ["storage maintenance needed", (p: CoreReportHealthPayload) => { p.memory!.storage!.state = "maintenance_needed"; }, "storage"],
  ["maintenance error", (p: CoreReportHealthPayload) => { p.memory!.storageMaintenance = { phase: "error", running: false, requested: false,
    lastStartedAt: 1, lastCompletedAt: 2, pages: 0, relocated: 0, lastError: "write failed" }; }, "storage"],
] as const)("preserves %s as impaired core, not an optional dependency", (_label, mutate, component) => {
  const payload = healthy(); mutate(payload);
  const result = report(payload);
  expect(result.service.state).toBe("impaired");
  expect(result.service.checks.find(c => c.name === component)?.state).toBe("impaired");
  expect((result.service.health as Extract<CoreHealthObservation, {state:"observed"}>).payload).toEqual(payload);
  expect(complete({ report: result }).outcome).toBe("failed");
});

test.each([
  (p: CoreReportHealthPayload) => { p.startup!.state = "restoring"; p.startup!.mutationsAdmitted = false; },
  (p: CoreReportHealthPayload) => { p.startup!.coreReady = false; },
  (p: CoreReportHealthPayload) => { p.startup!.historyReady = false; },
  (p: CoreReportHealthPayload) => { p.startup!.journal!.phase = "history"; },
  (p: CoreReportHealthPayload) => { p.projection!.state = "warming"; },
])("startup/projection work is starting, not ordinary write readiness", mutate => {
  const payload = healthy(); mutate(payload);
  const result = report(payload);
  expect(result.service.state).toBe("starting");
  expect(complete({ report: result }).outcome).toBe("pending");
});

test("core failure wins over recovery in another component", () => {
  const payload = healthy(); payload.projection!.state = "warming";
  payload.storage!.journal = { state: "failing", since: 1, lastFailedAt: 2, failures: 1, code: "EIO", error: "write" };
  expect(report(payload).service.state).toBe("impaired");
});

test("unknown cached disk state/sample errors never become confirmed free space", () => {
  for (const change of [
    { state: "unknown" as const }, { detail: "statfs failed" }, { checkedAt: null },
  ]) {
    const payload = healthy(); Object.assign(payload.memory!.storage!, change);
    expect(report(payload).service.state).toBe("inconclusive");
  }
  const payload = healthy(); payload.memory!.storage!.state = "critical"; payload.memory!.storage!.detail = "last sampling failed";
  expect(report(payload).service.state).toBe("impaired"); // Keep known pressure.
});

test("wrong endpoint, instance or node cannot establish the selected core's state", () => {
  for (const health of [
    { ...observation(), target: { ...target, brokerUrl: "http://127.0.0.1:9999" } },
    { ...observation(), target: { ...target, instance: "another" } },
    observation({ ...healthy(), nodeId: "node-two" }),
  ]) {
    const result = build({ target, health });
    expect(result.service.state).toBe("inconclusive");
    expect(result.service.identity).toBe("mismatch");
    expect(result.service.health).toEqual(health);
  }
  const missing = report({ ...healthy(), nodeId: null });
  expect(missing.service.identity).toBe("unverified");
  expect(missing.service.state).toBe("inconclusive");
});

test("no expected node is endpoint-only evidence, never a custody proof", () => {
  const result = build({ target: { instance: target.instance, brokerUrl: target.brokerUrl }, health: observation() });
  expect(result.service.state).toBe("working");
  expect(result.service.identity).toBe("unverified");
  expect(result.custody).toBe("not_assessed");
});

test("non-success HTTP and unknown observation time cannot be clean success", () => {
  expect(build({ target, health: { ...observation(), status: 503 } }).service.state).toBe("impaired");
  expect(build({ target, health: { ...observation(), checkedAt: null } }).service.state).toBe("inconclusive");
});

test("malformed successful payloads remain inconclusive rather than throwing or becoming healthy", () => {
  for (const payload of [null, {}, "wrong", { ok: "yes" }]) {
    const result = build({ target: { instance: target.instance, brokerUrl: target.brokerUrl },
      health: { ...observation(), payload } as unknown as CoreHealthObservation });
    expect(result.service.state).toBe("inconclusive");
  }
});

test("PATH-only presence is found, not ready, configured or authenticated", () => {
  expect(presence({ harness: "claude" })).toMatchObject({ state: "not_checked", evidence: null });
  expect(presence({ harness: "claude", observation: { binaryPath: null, source: "PATH", observedAt: 100 } })).toMatchObject({ state: "missing" });
  const row = presence({ harness: "claude", observation: { binaryPath: "/fixture/bin/claude", source: "PATH", observedAt: 100 } });
  expect(row).toEqual({ harness: "claude", state: "found", binaryPath: "/fixture/bin/claude",
    evidence: { source: "PATH", observedAt: 100 }, authentication: "not_checked", readiness: "not_checked" });
  const result = build({ target, health: observation(), harnesses: [{ ...row, state: "ready" as never, authentication: "ready" as never }] });
  expect(result.harnesses[0]).toEqual(row);
});

test("core completion is independent of missing or chosen harness and never offers an app/server/pair destination", () => {
  for (const harnesses of [[], [presence({ harness: "codex" })],
    [presence({ harness: "codex", observation: { binaryPath: null, source: "PATH", observedAt: 100 } })],
    [presence({ harness: "codex", observation: { binaryPath: "/bin/codex", source: "PATH", observedAt: 100 } })]]) {
    const result = complete({ report: build({ target, health: observation(), harnesses }) });
    expect(result).toMatchObject({ schema: "scout.core-setup-completion/v1", scope: "core", outcome: "complete" });
    expect(result.headline).toContain("sign-in has not been checked");
    expect(result.nextStep).toMatch(/^scout (runtimes|whoami)$/);
    expect(result).not.toHaveProperty("webUrl");
    expect(result).not.toHaveProperty("browserGuidance");
  }
});

test("required setup failures and evidence override a forged working summary", () => {
  const good = report();
  expect(complete({ report: good, failures: ["required config write failed"] })).toMatchObject({
    outcome: "failed", failures: ["required config write failed"],
  });
  const bad = report({ ...healthy(), ok: false });
  bad.service.state = "working"; bad.service.checks = [];
  expect(complete({ report: bad }).outcome).toBe("failed");
});

test("retains extra supplied health diagnostics and snapshots mutable caller data", () => {
  const payload = healthy(); payload.memory!.futureDiagnostic = { error: "retained, not interpreted" };
  const health = observation(payload), optional = { app: structuredClone(capability) };
  const result = build({ target, health, optional });
  payload.startup!.milestones!.readyAt = 999;
  optional.app.evidence.detail = "mutated";
  expect((result.service.health as Extract<CoreHealthObservation, {state:"observed"}>).payload.startup!.milestones!.readyAt).toBe(100);
  expect((result.service.health as Extract<CoreHealthObservation, {state:"observed"}>).payload.memory!.futureDiagnostic).toEqual({ error: "retained, not interpreted" });
  expect(result.optional.app).toEqual(capability);
  const done = complete({ report: result });
  result.target.instance = "changed";
  expect(done.report.target.instance).toBe("test-one");
  expect(JSON.parse(JSON.stringify(done))).toEqual(done);
});

test("cold subpath import exposes only pure functions and constants", async () => {
  const specifier = "./core-report.ts?cold";
  const module = await import(specifier);
  expect(Object.keys(module).sort()).toEqual(["CORE_OPTIONAL_CAPABILITIES", "assessCoreSetupCompletion", "buildCoreServiceReport", "describeCoreHarnessPresence"]);
});

test("pending solely on absent health fields enumerates unsupplied checks", () => {
  const result = complete({ report: report({ ok: true, nodeId: "node-one" }) });
  expect(result.outcome).toBe("pending");
  expect(result.headline).toBe("Health did not supply these checks: startup, projection, journal, storage.");
  const payload = healthy(); delete payload.projection;
  expect(complete({ report: report(payload) }).headline).toBe("Health did not supply these checks: projection.");
});

test("a completely unchecked core names all unsupplied checks and its unverified identity", () => {
  const result = complete({ report: build({ target, health: { state: "not_checked", target, checkedAt: null } }) });
  expect(result.outcome).toBe("pending");
  expect(result.headline).toContain("identity is unverified");
  expect(result.headline).toContain("Health did not supply these checks: health, startup, projection, journal, storage.");
});

test("observed timeout, restore or impairment is not described as only unsupplied fields", () => {
  const timeout = complete({ report: build({ target, health: { state: "timed_out", target, checkedAt: 101 } }) });
  expect(timeout.outcome).toBe("pending");
  expect(timeout.headline).not.toContain("did not supply");
  const payload = healthy(); payload.projection!.state = "warming"; delete payload.storage;
  const restoring = complete({ report: report(payload) });
  expect(restoring.outcome).toBe("pending");
  expect(restoring.headline).not.toContain("did not supply");
  payload.ok = false;
  const impaired = complete({ report: report(payload) });
  expect(impaired.outcome).toBe("failed");
  expect(impaired.headline).toBe("Scout core needs attention.");
  const inconclusive = healthy(); delete inconclusive.projection;
  inconclusive.memory!.storage!.detail = "cached sample failed";
  expect(complete({ report: report(inconclusive) }).headline).not.toContain("did not supply");
});

test("working endpoint-only reports stay permissive but setup needs an expected matched identity", () => {
  for (const expectedNodeId of [undefined, ""]) {
    const endpointOnly = build({ target: { instance: target.instance, brokerUrl: target.brokerUrl, expectedNodeId }, health: observation() });
    expect(endpointOnly.service.state).toBe("working");
    expect(endpointOnly.service.identity).toBe("unverified");
    // An edited summary cannot bypass re-projection.
    endpointOnly.service.identity = "matched";
    const result = complete({ report: endpointOnly });
    expect(result.outcome).toBe("pending");
    expect(result.headline).toBe("Scout core identity is unverified: no expected node was supplied.");
  }
});

test("missing, mismatched or wrong-instance identity stays pending with a named identity reason", () => {
  for (const health of [
    observation({ ...healthy(), nodeId: null }),
    observation({ ...healthy(), nodeId: "another-node" }),
    { ...observation(), target: { ...target, instance: "another-instance" } },
  ]) {
    const result = complete({ report: build({ target, health }) });
    expect(result.outcome).toBe("pending");
    expect(result.headline).toContain("identity is unverified");
    expect(result.nextStep).toBe("scout doctor");
  }
});

test("matched complete core keeps whoami for found harness and runtimes otherwise", () => {
  expect(complete({ report: report() })).toMatchObject({ outcome: "complete", nextStep: "scout runtimes" });
  const found = presence({ harness: "codex", observation: { binaryPath: "/fixture/codex", source: "PATH", observedAt: 100 } });
  expect(complete({ report: build({ target, health: observation(), harnesses: [found] }) }))
    .toMatchObject({ outcome: "complete", nextStep: "scout whoami" });
});

test("required setup failure still fails even when expected identity was not supplied", () => {
  const endpointOnly = build({ target: { instance: target.instance, brokerUrl: target.brokerUrl }, health: observation() });
  expect(complete({ report: endpointOnly, failures: ["required write failed"] }).outcome).toBe("failed");
});

test("resolved quarantine does not retain a historical skip warning, while deferred records remain unresolved", () => {
  const projection = { ...healthy().projection!, skips: { total: 1, byKind: {} },
    quarantine: { openCount: 0, acknowledgedCount: 0, resolvedCount: 1, samples: [] } };
  expect(report({ ...healthy(), projection }).service.checks.find(c => c.name === "projection")?.state).toBe("working");
  expect(report({ ...healthy(), projection: { ...projection, quarantine: { ...projection.quarantine, deferredCount: 1 } } })
    .service.checks.find(c => c.name === "projection")?.state).toBe("impaired");
});
