import { Worker } from "node:worker_threads";
import type { queryFleet } from "./fleet.ts";
import type { queryMobileAgentDetail } from "./mobile/agents.ts";
import type { queryTerminalSessions } from "./terminal-sessions.ts";
import type { queryHeartrate } from "./activity.ts";

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** One reader, a bounded queue, and no synchronous fallback on bridge failures. */
export class MobileReadWorker {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  constructor(private readonly url = new URL(
    import.meta.url.endsWith(".ts") ? "./mobile-read-worker-entry.ts" : "./mobile-read-worker-entry.js",
    import.meta.url,
  ), private readonly requestTimeoutMs = 15_000) {}

  read(kind: "fleet", options?: Parameters<typeof queryFleet>[0]): Promise<ReturnType<typeof queryFleet>>;
  read(kind: "agentDetail", options: string): Promise<ReturnType<typeof queryMobileAgentDetail>>;
  read(kind: "terminalSessions", options: Parameters<typeof queryTerminalSessions>[0]): Promise<ReturnType<typeof queryTerminalSessions>>;
  read(kind: "heartrate"): Promise<ReturnType<typeof queryHeartrate>>;
  read(kind: "fleet" | "heartrate" | "agentDetail" | "terminalSessions", options?: Parameters<typeof queryFleet>[0] | Parameters<typeof queryTerminalSessions>[0] | string): Promise<any> {
    if (this.pending.size >= 32) return Promise.reject(new Error("Mobile read queue is full; try again shortly."));
    if (!this.worker) {
      const worker = new Worker(this.url);
      this.worker = worker;
      worker.on("message", ({ id, value, error }) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (error) pending.reject(new Error(error));
        else pending.resolve(value);
        if (!this.pending.size) worker.unref();
      });
      worker.on("error", (error) => { if (this.worker === worker) this.close(error); });
      worker.on("exit", (code) => {
        if (this.worker === worker) this.close(new Error(`Mobile read worker exited (${code}).`));
      });
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error(
        `Mobile SQLite reader did not finish within ${this.requestTimeoutMs} ms; the bridge remains available.`,
      )), this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker!.ref();
        this.worker!.postMessage({ id, kind, options });
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(error = new Error("Mobile read worker closed.")): void {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    void worker?.terminate();
  }
}

export const mobileReadWorker = new MobileReadWorker();
