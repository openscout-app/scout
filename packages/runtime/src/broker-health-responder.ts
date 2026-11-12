import { Worker } from "node:worker_threads";
import { basename, dirname, join } from "node:path";

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
};

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
    };
    const worker = new Worker(url, { workerData });
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

  #postFlags(): void {
    this.#worker?.postMessage({ type: "flags", flags: this.flags() } satisfies BrokerHealthResponderMessage);
  }

  #now(): number { return this.options.now?.() ?? Date.now(); }
}
