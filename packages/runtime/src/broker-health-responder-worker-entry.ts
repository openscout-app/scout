import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";
import { listenUnixSocket } from "./broker-server-lifecycle.js";
import type { BrokerHealthFlag, BrokerHealthResponderMessage, BrokerHealthResponderWorkerData, BrokerHealthResponderWorkerMessage } from "./broker-health-responder.js";
import { memoryGuardAction, MemoryGuardRecord, memoryUsageMb } from "./memory-guard.js";

if (!parentPort) throw new Error("health responder requires a parent port");
const port = parentPort;
const data = workerData as BrokerHealthResponderWorkerData;
const beat = new Float64Array(data.beat);
let state: "starting" | "up" | "stopping" = "starting";
let identity: { nodeId?: string; brokerUrl?: string } = {};
let flags: BrokerHealthFlag[] = [];
let busySince: number | null = null;

port.on("message", (message: BrokerHealthResponderMessage) => {
  if (message.type === "ready") { state = "up"; identity = { nodeId: message.nodeId, brokerUrl: message.brokerUrl }; }
  else if (message.type === "flags") flags = message.flags;
  else if (message.type === "stopping") state = "stopping";
});

function mainThread(now: number) {
  const lastTurnAt = beat[0]!;
  return { lastTurnAt, lagMs: Math.max(0, Math.round(now - lastTurnAt)) };
}

/** The whole health answer: the cache as it stands, plus the main thread's clock. */
function read(now: number) {
  const main = mainThread(now);
  const current = main.lagMs >= data.busyAfterMs
    ? [...flags, { source: "main_thread", reason: `no turn for ${main.lagMs} ms`, since: main.lastTurnAt, updatedAt: now }]
    : flags;
  return {
    ok: state === "up",
    state,
    responder: "health_cache",
    pid: data.pid,
    startedAt: data.startedAt,
    ...identity,
    mainThread: main,
    flags: current,
    checkedAt: now,
  };
}

// A record of every stall, with times, so a slow moment can be traced later.
const stallWatch = setInterval(() => {
  const now = Date.now();
  const main = mainThread(now);
  if (main.lagMs >= data.busyAfterMs) {
    if (busySince === null) {
      busySince = main.lastTurnAt;
      console.warn(`[openscout-runtime] ${new Date(now).toISOString()} main thread has had no turn since ${new Date(busySince).toISOString()}`);
    }
  } else if (busySince !== null) {
    console.warn(`[openscout-runtime] ${new Date(now).toISOString()} main thread resumed after ${Math.round(main.lastTurnAt - busySince)} ms without a turn (from ${new Date(busySince).toISOString()})`);
    busySince = null;
  }
}, 250);
stallWatch.unref?.();

// The memory guard lives here, off the main thread, so it still acts when the main thread is too busy to.
// Its snapshot names the size and the main thread's lag; the main thread adds what it holds when it next gets a turn.
if (data.memory) {
  const guard = data.memory;
  const record = new MemoryGuardRecord(guard.dir, "runtime");
  const limits = { softBytes: guard.softBytes, hardBytes: guard.hardBytes };
  let lastSoftAt = 0, lastHeldAt = 0, exiting = false;
  const memoryWatch = setInterval(() => {
    if (exiting) return;
    const now = Date.now(), rss = process.memoryUsage().rss;
    const action = memoryGuardAction({ rss, now, limits, lastSoftAt, lastHeldAt, recentExits: record.recentExits(now) });
    if (action === "none") return;
    if (action === "soft") lastSoftAt = now;
    if (action === "hard-held") lastHeldAt = now;
    const at = new Date(now).toISOString();
    record.write({ reason: action, at, pid: data.pid, uptimeS: Math.round((now - data.startedAt) / 1000), ...memoryUsageMb(), rssMb: Math.round(rss / 1048576), mainThread: mainThread(now), flags }, (line) => console.warn(line));
    port.postMessage({ type: "memory", reason: action, at } satisfies BrokerHealthResponderWorkerMessage);
    if (action !== "hard-exit") return;
    // Stop cleanly if the main thread can; if it cannot within the grace period, stop it outright.
    exiting = true;
    record.noteExit(now);
    clearInterval(memoryWatch);
    setTimeout(() => process.kill(data.pid, "SIGTERM"), 2_000).unref?.();
    setTimeout(() => process.kill(data.pid, "SIGKILL"), 2_000 + (guard.graceMs ?? 20_000)).unref?.();
  }, guard.intervalMs ?? 5_000);
  memoryWatch.unref?.();
}

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  if (request.method !== "GET" || path !== "/health") {
    response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify(read(Date.now())));
});

listenUnixSocket(server, data.socketPath).then(
  () => port.postMessage({ type: "listening" }),
  (error) => { throw error; },
);

