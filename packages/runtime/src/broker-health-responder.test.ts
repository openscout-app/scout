import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { BrokerHealthResponder, brokerHealthSocketPath } from "./broker-health-responder.js";

const roots = new Set<string>();
const responders = new Set<BrokerHealthResponder>();
afterEach(async () => {
  for (const responder of responders) await responder.stop();
  responders.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function started(options: Partial<ConstructorParameters<typeof BrokerHealthResponder>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "openscout-health-")); roots.add(root);
  const responder = new BrokerHealthResponder({ socketPath: join(root, "broker-health.sock"), ...options });
  responders.add(responder);
  await responder.start();
  return responder;
}

/** Read health from a separate thread, as scoutd would from a separate process. */
function readFromAnotherThread(socketPath: string, delayMs: number): Promise<{ elapsedMs: number; body: any }> {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { request } = require("node:http");
    setTimeout(() => {
      const started = Date.now();
      request({ socketPath: workerData.socketPath, path: "/health" }, (response) => {
        let text = ""; response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => parentPort.postMessage({ elapsedMs: Date.now() - started, body: JSON.parse(text) }));
      }).end();
    }, workerData.delayMs);
  `, { eval: true, workerData: { socketPath, delayMs } });
  return new Promise((resolve, reject) => {
    worker.once("message", (value) => { void worker.terminate(); resolve(value); });
    worker.once("error", reject);
  });
}

function read(socketPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    request({ socketPath, path: "/health" }, (response) => {
      let text = ""; response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve(JSON.parse(text)));
    }).on("error", reject).end();
  });
}

describe("BrokerHealthResponder", () => {
  test("the health socket sits beside the runtime socket", () => {
    expect(brokerHealthSocketPath("/run/scout/broker.sock", {})).toBe("/run/scout/broker-health.sock");
    expect(brokerHealthSocketPath("/run/scout/broker", {})).toBe("/run/scout/broker-health.sock");
    expect(brokerHealthSocketPath("/run/scout/broker.sock", { OPENSCOUT_BROKER_HEALTH_SOCKET_PATH: "/x/h.sock" })).toBe("/x/h.sock");
  });

  test("reports starting until the runtime is ready, then up", async () => {
    const responder = await started();
    expect(await read(responder.socketPath)).toMatchObject({ ok: false, state: "starting", responder: "health_cache" });
    responder.markReady({ nodeId: "node-1" });
    await Bun.sleep(20);
    expect(await read(responder.socketPath)).toMatchObject({ ok: true, state: "up", nodeId: "node-1", flags: [] });
  });

  test("answers at once while the main thread is blocked, with a main_thread flag", async () => {
    const responder = await started({ busyAfterMs: 300 });
    responder.markReady({ nodeId: "node-1" });
    await Bun.sleep(50);
    const reading = readFromAnotherThread(responder.socketPath, 700);
    const until = Date.now() + 1_500;
    while (Date.now() < until) { /* hold the main thread */ }
    const { elapsedMs, body } = await reading;
    expect(elapsedMs).toBeLessThan(200);
    expect(body.ok).toBe(true);
    expect(body.mainThread.lagMs).toBeGreaterThanOrEqual(300);
    expect(body.flags.map((flag: { source: string }) => flag.source)).toContain("main_thread");
  });

  test("a flag carries its source, reason and first time, and clears when the source catches up", async () => {
    const responder = await started();
    responder.markReady({ nodeId: "node-1" });
    responder.report("storage", "journal 455 MB over its 64 MB limit");
    await Bun.sleep(20);
    const first = await read(responder.socketPath);
    expect(first.ok).toBe(true);
    expect(first.flags).toEqual([expect.objectContaining({ source: "storage", reason: "journal 455 MB over its 64 MB limit" })]);
    responder.report("storage", "journal 470 MB over its 64 MB limit");
    await Bun.sleep(20);
    const second = await read(responder.socketPath);
    expect(second.flags[0].since).toBe(first.flags[0].since);
    responder.report("storage", null);
    await Bun.sleep(20);
    expect((await read(responder.socketPath)).flags).toEqual([]);
  });

  test("over the soft memory limit it writes a snapshot, and the main thread logs what it holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openscout-memory-")); roots.add(dir);
    const lines: string[] = [];
    await started({
      memory: { dir, softBytes: 1, hardBytes: 0, intervalMs: 20 },
      memoryProbes: { tail: () => ({ watchers: 3 }) },
      log: (line) => lines.push(line),
    });
    for (let i = 0; i < 100 && !lines.length; i++) await Bun.sleep(20);
    expect(lines[0]).toStartWith("[memory-guard] runtime detail ");
    const detail = JSON.parse(lines[0]!.slice("[memory-guard] runtime detail ".length));
    expect(detail.reason).toBe("soft");
    expect(detail.probes).toEqual({ tail: { watchers: 3 } });
    expect(Object.keys(detail.jsc).length).toBeGreaterThan(0);
    expect(readdirSync(dir).some((file) => file.startsWith("runtime-memory-guard-") && file.endsWith("-soft.json"))).toBe(true);
  });
});
