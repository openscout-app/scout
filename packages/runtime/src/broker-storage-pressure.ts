import { stat, statfs } from "node:fs/promises";

export class BrokerBusyError extends Error {
  readonly code = "broker_busy";
  readonly retryable = true;
  constructor(reason: string) { super(`Broker admission paused: ${reason}. Retry with the same request ID.`); this.name = "BrokerBusyError"; }
}

/** Bounds commands awaiting durable acceptance, independently of running turns. */
export class BrokerCommandAdmission {
  private count = 0;
  private bytes = 0;
  constructor(private readonly options: { maxCommands?: number; maxBytes?: number; pressure?: () => string | null } = {}) {}
  status() { return { pendingCommands: this.count, pendingBytes: this.bytes, maxCommands: this.options.maxCommands ?? 256, maxBytes: this.options.maxBytes ?? 32 * 1024 * 1024 }; }
  reserve(payload: unknown): () => void {
    const reason = this.options.pressure?.();
    if (reason) throw new BrokerBusyError(reason);
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (this.count >= (this.options.maxCommands ?? 256) || this.bytes + bytes > (this.options.maxBytes ?? 32 * 1024 * 1024)) {
      throw new BrokerBusyError("the durable acceptance queue is at capacity");
    }
    this.count++; this.bytes += bytes; let released = false;
    return () => { if (!released) { released = true; this.count--; this.bytes -= bytes; } };
  }
}

type StorageStatus = {
  checkedAt: number | null;
  files: Record<string, { bytes: number; warningBytes: number; aboveWarning: boolean }>;
  freeDiskBytes: number | null;
  minimumFreeDiskBytes: number;
  state: "unknown" | "ready" | "maintenance_needed" | "critical";
  detail?: string;
};
/** Cached measurements keep stat/SQLite/filesystem scans off request paths. */
export class BrokerStorageMonitor {
  private current: StorageStatus = { checkedAt: null, files: {}, freeDiskBytes: null, minimumFreeDiskBytes: 256 * 1024 * 1024, state: "unknown" };
  private refreshing: Promise<void> | null = null;
  constructor(private readonly directory: string, private readonly paths: Record<string, { path: string; warningBytes: number }>,
    options: { minimumFreeDiskBytes?: number } = {}) {
    if (options.minimumFreeDiskBytes !== undefined && Number.isFinite(options.minimumFreeDiskBytes) && options.minimumFreeDiskBytes >= 0) {
      this.current = { ...this.current, minimumFreeDiskBytes: options.minimumFreeDiskBytes };
    }
  }
  status(): StorageStatus { return this.current; }
  admissionPressure(): string | null { return this.current.state === "critical" ? "available disk space is below the durable-write reserve" : null; }
  refresh(): Promise<void> {
    return this.refreshing ??= this.sample().finally(() => { this.refreshing = null; });
  }
  private async sample(): Promise<void> {
    try {
      const [disk, files] = await Promise.all([
        statfs(this.directory),
        Promise.all(Object.entries(this.paths).map(async ([name, input]) => {
          const bytes = await stat(input.path).then(value => value.size).catch(error => { if (error?.code === "ENOENT") return 0; throw error; });
          return [name, { bytes, warningBytes: input.warningBytes, aboveWarning: bytes >= input.warningBytes }] as const;
        })),
      ]);
      const freeDiskBytes = disk.bavail * disk.bsize;
      const state = freeDiskBytes < this.current.minimumFreeDiskBytes ? "critical"
        : files.some(([, file]) => file.aboveWarning) ? "maintenance_needed" : "ready";
      this.current = { ...this.current, files: Object.fromEntries(files), checkedAt: Date.now(), freeDiskBytes, state, detail: undefined };
    } catch (error) {
      // Preserve last known pressure instead of treating a failed probe as free space.
      this.current = { ...this.current, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
