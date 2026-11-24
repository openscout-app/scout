import { buildCoreServiceReport, describeCoreHarnessPresence } from "@openscout/runtime/setup";

export function healthyCoreReport() {
  const target = { instance: "test", brokerUrl: "http://127.0.0.1:1", expectedNodeId: "node-test" };
  return buildCoreServiceReport({ target, health: { target, state: "observed", checkedAt: 100, status: 200, payload: {
    ok: true, nodeId: "node-test",
    startup: { state: "ready", phase: "ready", mutationsAdmitted: true, coreReady: true, historyReady: true, error: null, milestones: {} },
    projection: { state: "ready", detail: null }, storage: { journal: { state: "ok" } },
    memory: { storage: { checkedAt: 100, state: "ready", files: {}, freeDiskBytes: 1000, minimumFreeDiskBytes: 100 } },
  } }, harnesses: [describeCoreHarnessPresence({ harness: "codex", observation: { binaryPath: "/fixture/codex", source: "fixture", observedAt: 100 } })] });
}
