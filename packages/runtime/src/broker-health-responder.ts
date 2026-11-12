import { Worker } from "node:worker_threads";
import { basename, dirname, join } from "node:path";
import { heapObjectTypes, memoryUsageMb, runMemoryProbes } from "./memory-guard.js";

/** Something that fell behind. Health stays up; the flag says what and since when. */
export type BrokerHealthFlag = {
  source: string;
  reason: string;
  since: number;
  updatedAt: number;
};

export type BrokerHealthResponderMessage =
  | { type: "ready"; nodeId: string; brokerUrl?: string }
  | { type: "flags"; flags: BrokerHealthFlag[] }
  | { type: "stopping" };

export type BrokerHealthResponderWorkerData = {
  socketPath: string;
  beat: SharedArrayBuffer;
  pid: number;
  startedAt: number;
  busyAfterMs: number;
  /** The memory guard's limits and snapshot folder (memory-guard.ts); absent, the guard is off. */
  memory?: BrokerMemoryGuardOptions;
};

export type BrokerMemoryGuardOptions = {
  dir: string;
  softBytes: number;
  hardBytes: number;
  intervalMs?: number;
  /** after SIGTERM, how long the main thread has to stop before SIGKILL */
  graceMs?: number;
};

/** Worker to main thread: the guard took a snapshot, so the main thread adds what it holds. */
export type BrokerHealthResponderWorkerMessage =
  | { type: "listening" }
  | { type: "memory"; reason: "soft" | "hard-exit" | "hard-held"; at: string };

/** The health socket sits beside the runtime socket: `broker.sock` -> `broker-health.sock`. */
export function brokerHealthSocketPath(brokerSocketPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENSCOUT_BROKER_HEALTH_SOCKET_PATH?.trim();
  if (configured) return configured;
  const name = basename(brokerSocketPath);
  const stem = name.endsWith(".sock") ? name.slice(0, -".sock".length) : name;
  return join(dirname(brokerSocketPath), `${stem}-health.sock`);
}

/**
 * Health as a cache read. A worker thread owns the health socket and answers
 * from what it holds, so no runtime work can delay or fail a health check.
 * The main thread only stamps a shared clock and sends flag changes.
 */
export class BrokerHealthResponder {
  readonly #beat = new Float64Array(new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT));
  readonly #flags = new Map<string, BrokerHealthFlag>();
  #worker: Worker | null = null;
  #beatTimer: ReturnType<typeof setInterval> | null = null;
  #ready: Extract<BrokerHealthResponderMessage, { type: "ready" }> | null = null;

  constructor(private readonly options: {
    socketPath: string;
    /** Main thread silence that becomes a `main_thread` flag. */
    busyAfterMs?: number;
    beatMs?: number;
    now?: () => number;
    log?: (message: string) => void;
    workerUrl?: URL;
    memory?: BrokerMemoryGuardOptions;
    /** what the main thread adds to a memory snapshot: named reports such as cache sizes */
    memoryProbes?: Record<string, () => unknown>;
  }) {}

  get socketPath(): string { return this.options.socketPath; }

  start(): Promise<void> {
    if (this.#worker) return Promise.resolve();
    const now = this.#now();
    this.#beat[0] = now;
    this.#beatTimer = setInterval(() => { this.#beat[0] = this.#now(); }, this.options.beatMs ?? 250);
    this.#beatTimer.unref();
    const url = this.options.workerUrl ?? new URL(import.meta.url.endsWith(".ts")
      ? "./broker-health-responder-worker-entry.ts" : "./broker-health-responder-worker-entry.js", import.meta.url);
    const workerData: BrokerHealthResponderWorkerData = {
      socketPath: this.options.socketPath,
      beat: this.#beat.buffer as SharedArrayBuffer,
      pid: process.pid,
      startedAt: now,
      busyAfterMs: this.options.busyAfterMs ?? 1_000,
      ...(this.options.memory ? { memory: this.options.memory } : {}),
    };
    const worker = new Worker(url, { workerData });
    worker.on("message", (message: BrokerHealthResponderWorkerMessage) => {
      if (message?.type === "memory") this.#memoryDetail(message);
    });
    this.#worker = worker;
    worker.unref();
    return new Promise((resolve, reject) => {
      const onMessage = (message: unknown) => {
        if ((message as { type?: string })?.type !== "listening") return;
        worker.off("message", onMessage); worker.off("error", onStartError);
        worker.on("error", (error) => this.options.log?.(`health responder failed: ${error instanceof Error ? error.message : String(error)}`));
        if (this.#ready) worker.postMessage(this.#ready);
        this.#postFlags();
        resolve();
      };
      const onStartError = (error: unknown) => { worker.off("message", onMessage); this.#worker = null; reject(error); };
      worker.on("message", onMessage);
      worker.once("error", onStartError);
    });
  }

  markReady(identity: { nodeId: string; brokerUrl?: string }): void {
    this.#ready = { type: "ready", ...identity };
    this.#worker?.postMessage(this.#ready);
  }

  /** Raise, update or clear (`reason: null`) one source's flag. Sends only changes. */
  report(source: string, reason: string | null): void {
    const current = this.#flags.get(source);
    if (reason === null) {
      if (!current) return;
      this.#flags.delete(source);
    } else {
      if (current?.reason === reason) return;
      const now = this.#now();
      this.#flags.set(source, { source, reason, since: current?.since ?? now, updatedAt: now });
    }
    this.#postFlags();
  }

  flags(): BrokerHealthFlag[] { return [...this.#flags.values()]; }

  async stop(): Promise<void> {
    if (this.#beatTimer) clearInterval(this.#beatTimer);
    this.#beatTimer = null;
    const worker = this.#worker;
    this.#worker = null;
    if (!worker) return;
    worker.postMessage({ type: "stopping" } satisfies BrokerHealthResponderMessage);
    await worker.terminate().catch(() => undefined);
  }

  /** The main thread's half of a memory snapshot: its heap's object types and its probes, logged beside the worker's line. */
  #memoryDetail(message: Extract<BrokerHealthResponderWorkerMessage, { type: "memory" }>): void {
    const detail = {
      reason: message.reason,
      snapshotAt: message.at,
      at: new Date(this.#now()).toISOString(),
      ...memoryUsageMb(),
      jsc: heapObjectTypes(),
      probes: runMemoryProbes(this.options.memoryProbes),
    };
    (this.options.log ?? ((line: string) => console.warn(line)))(`[memory-guard] runtime detail ${JSON.stringify(detail)}`);
  }

  #postFlags(): void {
    this.#worker?.postMessage({ type: "flags", flags: this.flags() } satisfies BrokerHealthResponderMessage);
  }

  #now(): number { return this.options.now?.() ?? Date.now(); }
}
