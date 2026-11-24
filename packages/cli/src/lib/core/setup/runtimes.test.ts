import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSystemFile } from "@openscout/runtime/setup";
import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";
import type { ScoutBrokerHealthPayload } from "@openscout/runtime/client";
import { FileBackedBrokerJournal } from "../../../../../runtime/src/broker-journal.ts";
import { coreRuntimeHealth, loadScoutRuntimesReport } from "./runtimes.ts";
import { renderScoutRuntimesReport } from "../../ui/terminal/runtimes.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function state() {
  const root = mkdtempSync(join(tmpdir(), "core_runtimes_"));
  const saved = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(root, "support");
  cleanups.push(() => { if (saved === undefined) delete process.env.OPENSCOUT_SUPPORT_DIRECTORY; else process.env.OPENSCOUT_SUPPORT_DIRECTORY = saved; rmSync(root, { recursive: true, force: true }); });
  return root;
}
function health(overrides: Partial<ScoutBrokerHealthPayload> = {}): ScoutBrokerHealthPayload {
  return { ok: true, nodeId: "test-node", meshId: "test-mesh", counts: null, ...overrides };
}
function broker(payload: ScoutBrokerHealthPayload, errors = false) {
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; paths.push(path);
    if (path === "/health") return Response.json(payload);
    if (errors) return Response.json({ error: "unavailable" }, { status: 503 });
    if (path === "/v1/runtime-catalog") return Response.json({ catalog: SCOUT_RUNTIME_CATALOG, warnings: [] });
    return Response.json({ generatedAt: 123, sources: [], capabilities: [], warnings: [] });
  } });
  cleanups.push(() => server.stop(true)); return { url: server.url.origin, paths };
}

test("runtimes keeps catalog output and explicitly separates optional app readiness", async () => {
  const root = state(), f = broker(health());
  const report = await loadScoutRuntimesReport(root, { PATH: "", OPENSCOUT_BROKER_URL: f.url });
  expect(report).toMatchObject({ readinessPolicy: "path_and_env_file_evidence_only", appReadiness: { availability: "unavailable", requiredForCore: false, reason: "private_app_not_inspected" }, coreHealth: { state: "working" } });
  expect(report.runtimeCapabilities.models.length).toBeGreaterThan(0);
  expect(f.paths.sort()).toEqual(["/health", "/v1/capabilities", "/v1/runtime-catalog"]);
  expect(renderScoutRuntimesReport(report)).toContain("App readiness: unavailable");
  expect(report.brokerReads.catalog.availability).toBe("available");
});
test("PATH discovery is passive: no harness version, helper, app candidate or provider status execution", async () => {
  const root = state(), f = broker(health()); const bin = join(root, "bin"); mkdirSync(bin);
  const marker = join(root, "executed"); const binary = join(bin, "codex");
  writeFileSync(binary, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(binary, 0o755);
  const report = await loadScoutRuntimesReport(root, { PATH: bin, HOME: root, OPENSCOUT_BROKER_URL: f.url });
  const codex = report.catalog.entries.find(e => e.name === "codex");
  expect(codex?.readinessReport.binaryPath).toBe(binary);
  expect(codex?.readinessReport.binaryVersion).toBeFalsy(); expect(existsSync(marker)).toBe(false);
  expect(JSON.stringify(report.catalog)).not.toContain("/Applications/");
});
test("unavailable catalog/capabilities keep bundled choices, never hide unavailable core health", async () => {
  const root = state();
  const report = await loadScoutRuntimesReport(root, { PATH: "", OPENSCOUT_BROKER_URL: "http://127.0.0.1:1", OPENSCOUT_BROKER_SOCKET_PATH: join(root, "absent.sock") });
  expect(report).toMatchObject({ coreHealth: { state: "inconclusive", observation: { availability: "unavailable" } }, brokerReads: { catalog: { availability: "unavailable" }, capabilities: { availability: "unavailable" } }, capabilities: null });
  expect(report.runtimeCapabilities.models.length).toBeGreaterThan(0);
  expect(renderScoutRuntimesReport(report)).toContain("Core broker: inconclusive");
});
test("HTTP refusals preserve status while fallback catalog remains explicitly non-authoritative", async () => {
  const root = state(), f = broker(health({ ok: false }), true);
  const report = await loadScoutRuntimesReport(root, { PATH: "", OPENSCOUT_BROKER_URL: f.url });
  expect(report).toMatchObject({ brokerReads: { catalog: { availability: "unavailable", status: 503 }, capabilities: { availability: "unavailable", status: 503 } }, coreHealth: { state: "impaired" } });
});
test("a real failed durable journal append remains impaired in JSON and human output", async () => {
  const root = state(), path = join(root, "journal.jsonl"); const journal = new FileBackedBrokerJournal(path);
  cleanups.push(() => journal.close()); await journal.load(); mkdirSync(path);
  await expect(journal.appendEntries({ kind: "actor.upsert", actor: { id: "operator", kind: "person", displayName: "Operator" } })).rejects.toThrow();
  const status = journal.writeStatus(); expect(status.state).toBe("failing");
  const f = broker(health({ storage: { journal: status } }), true);
  const report = await loadScoutRuntimesReport(root, { PATH: "", OPENSCOUT_BROKER_URL: f.url });
  expect(report.coreHealth.state).toBe("impaired");
  expect(report.coreHealth.observation).toMatchObject({ availability: "available", value: { ok: true, storage: { journal: { state: "failing" } } } });
  expect(renderScoutRuntimesReport(report)).toContain("journal writes failing");
  expect(JSON.stringify(report)).toContain('"state":"failing"');
});
test.each([
  health({ projection: { state: "degraded", detail: "projection failed" } }),
  health({ startup: { state: "degraded", mutationsAdmitted: false, error: "replay failed" } }),
  health({ startup: { state: "restoring", phase: "failed", mutationsAdmitted: false } }),
])("projection/startup failure cannot become healthy because the app is optional: %j", value => {
  expect(coreRuntimeHealth({ availability: "available", value }).state).toBe("impaired");
});
test("startup restore/warming is inconclusive, not confirmed write readiness", () => {
  expect(coreRuntimeHealth({ availability: "available", value: health({ startup: { state: "restoring", mutationsAdmitted: false } }) }).state).toBe("inconclusive");
  expect(coreRuntimeHealth({ availability: "available", value: health({ projection: { state: "warming", detail: null } }) }).state).toBe("inconclusive");
});

test("malformed 200 catalog/capability/health replies are explicit unavailable, not clean empty success", async () => {
  const root = state();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) }); cleanups.push(() => server.stop(true));
  const report = await loadScoutRuntimesReport(root, { PATH: "", OPENSCOUT_BROKER_URL: server.url.origin });
  expect(report).toMatchObject({ capabilities: null, brokerReads: { catalog: { availability: "unavailable", reason: "invalid_runtime_catalog_response" }, capabilities: { availability: "unavailable", reason: "invalid_capability_response" } }, coreHealth: { state: "inconclusive", observation: { availability: "unavailable", reason: "invalid_health_response" } } });
});
test("selected runtimes handler bundles without desktop or web source modules", async () => {
  const root = state(), output = join(root, "runtimes.mjs");
  const entry = new URL("../../../cli/commands/runtimes.ts", import.meta.url).pathname;
  const cwd = new URL("../../../../../../", import.meta.url).pathname;
  // The runtime's approved async executor isolates the build from bun:test's
  // filesystem/module mocks. No new raw process-spawn allowance is needed.
  const built = await execSystemFile(process.execPath, ["build", entry, "--target=bun", "--outfile", output], {
    cwd, timeoutMs: 10_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024,
  });
  expect(built.exitCode).toBe(0);
  const bundled = readFileSync(output, "utf8");
  expect(bundled).not.toMatch(/^\/\/ .*apps\/desktop\//m);
  expect(bundled).not.toMatch(/^\/\/ .*(?:packages\/web|\.\.\/web)\//m);
  expect(bundled).not.toMatch(/^\/\/ .*runtime\/src\/(?:onboarding|setup-completion|broker-process-manager|dist-access|pi-rpc)\.ts$/m);
});
