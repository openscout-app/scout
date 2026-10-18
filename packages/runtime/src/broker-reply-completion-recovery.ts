import { setImmediate } from "node:timers/promises";
import type { FlightRecord, InvocationRequest } from "@openscout/protocol";
import { isWorkingFlightState } from "./broker-local-invocation-helpers.js";

type RecoveryOptions = {
  flights: () => Iterable<FlightRecord>;
  invocation: (id: string) => InvocationRequest | undefined;
  recoverReply: (invocation: InvocationRequest) => Promise<boolean>;
  warn?: (invocationId: string, error: unknown) => void;
};

/** Repairs accepted results before any stale/queued recovery can replace them. */
export class BrokerReplyCompletionRecovery {
  #initialized = false;
  #pending = new Set<string>();
  #running: Promise<{ scanned: number; recovered: number; failed: number }> | undefined;

  constructor(private readonly options: RecoveryOptions) {}

  isPending(invocationId: string): boolean {
    return !this.#initialized || this.#pending.has(invocationId);
  }

  recover(): Promise<{ scanned: number; recovered: number; failed: number }> {
    if (this.#running) return this.#running;
    const run = this.run();
    this.#running = run;
    void run.finally(() => { this.#running = undefined; }).catch(() => {});
    return run;
  }

  private async run() {
    const result = { scanned: 0, recovered: 0, failed: 0 };
    const failed = new Set<string>();
    for (const flight of this.options.flights()) {
      if (!isWorkingFlightState(flight.state)) continue;
      const invocation = this.options.invocation(flight.invocationId);
      if (!invocation) continue;
      result.scanned++;
      this.#pending.add(invocation.id);
      try {
        if (await this.options.recoverReply(invocation)) result.recovered++;
        this.#pending.delete(invocation.id);
      } catch (error) {
        failed.add(invocation.id);
        result.failed++;
        this.options.warn?.(invocation.id, error);
      }
      // Bound work per event-loop turn; the scan retains only flight/ID state,
      // never an array of history messages or completion payloads.
      if (result.scanned % 64 === 0) await setImmediate();
    }
    this.#pending = failed;
    this.#initialized = true;
    return result;
  }
}
