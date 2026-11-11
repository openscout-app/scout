import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type { ControlEvent, ThreadEventEnvelope } from "@openscout/protocol";
import { FileBackedBrokerJournal, type BrokerJournalEntry, type BrokerJournalReplayBoundary } from "./broker-journal.js";
import type { BrokerPersistenceVerification, BrokerProjectionHealth, BrokerThreadEventPublisher } from "./broker-durable-store.js";
import type { HistoryRotationPlan } from "./history-rotation.js";
import { emptyHistoryRotationPlan } from "./history-rotation.js";
import type { RecoverableSQLiteProjection, SQLiteProjectionStatusSnapshot } from "./sqlite-projection.js";
import type { ArchiveEventsResult } from "./control-plane-archive.js";
import { projectionVerificationDigest, verificationPlanKeys, type ProjectionVerificationDigest } from "./sqlite-projection-verification.js";

export type WorkerSQLiteProjectionOptions = {
  disabled?: boolean;
  historyDirectory?: string;
  maxPendingRequests?: number;
  requestTimeoutMs?: number;
  /** A test worker can withhold responses without stalling the broker thread. */
  workerUrl?: URL;
};
type Request = { resolve: (value: any) => void; reject: (error: Error) => void; lastProgressAt: number };
type ReplayStats = { fullReplays: number; tailReplays: number; bytes: number };
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
// One accepted record may be much larger than an ordinary read/control RPC.
// Preserve it as one bounded exception; never multiply that payload by 16.
const MAX_QUARANTINE_REQUEST_BYTES = 64 * 1024 * 1024 + 64 * 1024;

/** One coalesced journal watermark replaces an in-memory queue of payloads. */
export class WorkerSQLiteProjection {
  private worker: Worker | null = null;
  private readonly requests = new Map<number, Request>();
  private nextRequestId = 0;
  private requestedRevision = 0;
  private projectedRevision = 0;
  private pumping: Promise<void> | null = null;
  private warmPromise: Promise<void> | null = null;
  private scheduled: ReturnType<typeof setImmediate> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private activeReads = 0;
  private quarantinePending = false;
  private threadEvents: BrokerThreadEventPublisher | null = null;
  private cachedStatus: SQLiteProjectionStatusSnapshot = { state: "degraded", detail: "SQLite projection worker has not started." };
  private cachedHealth: BrokerProjectionHealth = { failures: 0, unavailable: "sqlite projection worker has not started" };
  private replayStats: ReplayStats = { fullReplays: 0, tailReplays: 0, bytes: 0 };
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private workerProgress = 0;

  constructor(private readonly dbPath: string, private readonly journalPath: string,
    private readonly journal: FileBackedBrokerJournal, private readonly options: WorkerSQLiteProjectionOptions = {}) {
    if (options.disabled) {
      this.cachedStatus = { state: "disabled", detail: "SQLite projection is disabled by configuration." };
      this.cachedHealth = { failures: 0, unavailable: "sqlite projection disabled" };
    }
  }

  statusSnapshot(): SQLiteProjectionStatusSnapshot & { worker: { pendingRequests: number; dirty: boolean; replay: ReplayStats } } {
    return { ...this.cachedStatus, worker: { pendingRequests: this.requests.size, dirty: this.requestedRevision > this.projectedRevision, replay: { ...this.replayStats } } };
  }
  health(): BrokerProjectionHealth { return { ...this.cachedHealth }; }
  setThreadEventPublisher(publisher: BrokerThreadEventPublisher): void { this.threadEvents = publisher; }

  notifyCommitted(): void {
    if (this.closed || this.options.disabled) return;
    this.requestedRevision++;
    if (!this.pumping && !this.scheduled && !this.retry) {
      this.scheduled = setImmediate(() => { this.scheduled = null; void this.pump().catch(() => {}); });
    }
  }
  enqueueEntries(_entries: BrokerJournalEntry | BrokerJournalEntry[]): void { this.notifyCommitted(); }
  /** Control events must already be journaled by the canonical writer. */
  enqueueEvent(_event: ControlEvent): void { this.notifyCommitted(); }
  async applyEntries(_entries: BrokerJournalEntry | BrokerJournalEntry[]): Promise<ThreadEventEnvelope[]> {
    this.notifyCommitted(); await this.flush(); return [];
  }

  warm(): Promise<void> {
    if (this.closed || this.options.disabled) return Promise.resolve();
    if (this.cachedStatus.state === "degraded") this.warmPromise = null;
    if (!this.warmPromise) this.cachedStatus = { state: "warming", detail: "SQLite projection worker is recovering." };
    return this.warmPromise ??= this.rpc<void>("warm", []);
  }
  async captureStartupCatchUpBoundary(): Promise<BrokerJournalReplayBoundary> {
    return this.journal.captureReplayBoundary({ barrier: {
      id: randomUUID(), projectionId: "control-plane", projectionVersion: 1, createdAt: Date.now(),
    } });
  }
  catchUpStartup(boundary: BrokerJournalReplayBoundary): Promise<void> { return this.rpc("catchUpStartup", [boundary]); }

  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    if (this.closed || this.options.disabled) return Promise.resolve();
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const work = (async () => {
      await this.warm();
      if (!this.closed && this.projectedRevision < this.requestedRevision) {
        const revision = this.requestedRevision;
        const boundary = await this.captureStartupCatchUpBoundary();
        await this.catchUpStartup(boundary);
        this.projectedRevision = revision;
      }
    })();
    this.pumping = work;
    void work.catch(error => {
      this.cachedHealth = { failures: this.cachedHealth.failures + 1, unavailable: String(error) };
      this.cachedStatus = { state: "degraded", detail: String(error) };
    }).finally(() => {
      this.pumping = null;
      if (!this.closed && this.projectedRevision < this.requestedRevision) {
        this.retry = setTimeout(() => { this.retry = null; void this.pump().catch(() => {}); }, this.cachedStatus.state === "degraded" ? 1_000 : 0);
        this.retry.unref();
      }
    });
    return work;
  }
  async flush(): Promise<void> {
    if (this.closed || this.options.disabled) return;
    const revision = this.requestedRevision;
    while (this.projectedRevision < revision) await this.pump();
    if (this.worker) await this.rpc("flush", []);
  }

  async verifyPersisted(plan: HistoryRotationPlan): Promise<BrokerPersistenceVerification> {
    await this.flush();
    if (this.closed || this.options.disabled) return { present: emptyHistoryRotationPlan(), missing: plan };
    const expected = this.journal.verificationRecords(plan);
    const present = emptyHistoryRotationPlan(), missing = emptyHistoryRotationPlan();
    for (const key of Object.values(verificationPlanKeys)) for (const id of plan[key]) missing[key].add(id);
    const invocations = new Map(expected.invocations.map(record => [record.id, record]));
    let page: ProjectionVerificationDigest[] = [], bytes = 0;
    const submit = async () => {
      if (!page.length) return;
      const result = await this.rpc<BrokerPersistenceVerification>("verifyPersistedDigests", [page]);
      for (const key of Object.values(verificationPlanKeys)) for (const id of result.present[key]) {
        present[key].add(id); missing[key].delete(id);
      }
      page = []; bytes = 0;
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    const groups = [
      ["message", expected.messages], ["invocation", expected.invocations], ["flight", expected.flights],
      ["delivery", expected.deliveries], ["deliveryAttempt", expected.deliveryAttempts], ["collaborationEvent", expected.collaborationEvents],
    ] as const;
    for (const [kind, records] of groups) for (const record of records) {
      if (!plan[verificationPlanKeys[kind]].has(record.id)) continue;
      const context = kind === "flight" && "invocationId" in record ? { flightInvocation: invocations.get(record.invocationId as string) } : undefined;
      const item = { kind, id: record.id, digest: projectionVerificationDigest(kind, record, context) };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > 128 * 1024) continue; // Pathological IDs remain hot; never infer coverage.
      if (page.length >= 128 || bytes + size > 128 * 1024) await submit();
      page.push(item); bytes += size;
    }
    await submit();
    return { present, missing };
  }

  async archiveEvents(options: { cutoff: number; archiveDir: string; pageSize?: number; maxPages?: number }): Promise<ArchiveEventsResult> {
    await this.flush();
    return this.rpc("archiveEvents", [{ ...options, maxPages: Math.min(options.maxPages ?? 1, 1) }]);
  }

  listActivityItems(...args: Parameters<RecoverableSQLiteProjection["listActivityItems"]>): ReturnType<RecoverableSQLiteProjection["listActivityItems"]> { return this.read("listActivityItems", args, []); }
  async quarantineRecord(...args: Parameters<RecoverableSQLiteProjection["quarantineRecord"]>): Promise<ReturnType<RecoverableSQLiteProjection["quarantineRecord"]>> {
    if (this.closed || this.options.disabled) throw new Error("Quarantine storage is unavailable.");
    if (this.quarantinePending) throw new Error("Quarantine preservation capacity: one record is already in flight.");
    this.quarantinePending = true;
    try {
      return await this.rpc("quarantineRecord", [args[0], args[1].slice(0, 512)], MAX_QUARANTINE_REQUEST_BYTES);
    } finally { this.quarantinePending = false; }
  }
  listQuarantine(...args: Parameters<RecoverableSQLiteProjection["listQuarantine"]>): Promise<ReturnType<RecoverableSQLiteProjection["listQuarantine"]>> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Quarantine storage is unavailable."));
    return this.rpc("listQuarantine", args);
  }
  readQuarantine(...args: Parameters<RecoverableSQLiteProjection["readQuarantine"]>): Promise<ReturnType<RecoverableSQLiteProjection["readQuarantine"]>> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Quarantine storage is unavailable."));
    return this.rpc("readQuarantine", args);
  }
  acknowledgeQuarantine(...args: Parameters<RecoverableSQLiteProjection["acknowledgeQuarantine"]>): Promise<ReturnType<RecoverableSQLiteProjection["acknowledgeQuarantine"]>> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Quarantine storage is unavailable."));
    return this.rpc("acknowledgeQuarantine", args);
  }
  deferQuarantine(...args: Parameters<RecoverableSQLiteProjection["deferQuarantine"]>): Promise<ReturnType<RecoverableSQLiteProjection["deferQuarantine"]>> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Quarantine storage is unavailable."));
    return this.rpc("deferQuarantine", args);
  }
  async retryQuarantine(...args: Parameters<RecoverableSQLiteProjection["retryQuarantine"]>): ReturnType<RecoverableSQLiteProjection["retryQuarantine"]> {
    if (this.closed || this.options.disabled) throw new Error("Quarantine retry is unavailable.");
    await this.flush();
    return this.rpc("retryQuarantine", args);
  }
  readMessages(...args: Parameters<RecoverableSQLiteProjection["readMessages"]>): ReturnType<RecoverableSQLiteProjection["readMessages"]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical message storage is unavailable."));
    return this.read("readMessages", args, new Map());
  }
  readInvocations(...args: Parameters<RecoverableSQLiteProjection["readInvocations"]>): ReturnType<RecoverableSQLiteProjection["readInvocations"]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical invocation storage is unavailable."));
    return this.read("readInvocations", args, new Map());
  }
  readFlights(...args: Parameters<RecoverableSQLiteProjection["readFlights"]>): ReturnType<RecoverableSQLiteProjection["readFlights"]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical flight storage is unavailable."));
    return this.read("readFlights", args, new Map());
  }
  readInvocationSnapshot(...args: Parameters<RecoverableSQLiteProjection["readInvocationSnapshot"]>): ReturnType<RecoverableSQLiteProjection["readInvocationSnapshot"]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical invocation storage is unavailable."));
    return this.read("readInvocationSnapshot", args, { invocation: null, flight: null, deliveries: [] });
  }
  publishHistoricalPage(...args: Parameters<RecoverableSQLiteProjection["publishHistoricalPage"]>): ReturnType<RecoverableSQLiteProjection["publishHistoricalPage"]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.rpc("publishHistoricalPage", args);
  }
  async publishHistoryRotation(...args: Parameters<RecoverableSQLiteProjection["publishHistoryRotation"]>): ReturnType<RecoverableSQLiteProjection["publishHistoryRotation"]> {
    if (this.closed || this.options.disabled) throw new Error("Historical storage is unavailable.");
    await this.flush();
    const page = emptyHistoryRotationPlan(); let count = 0, bytes = 0;
    for (const key of Object.values(verificationPlanKeys)) for (const id of args[0][key]) {
      const size = Buffer.byteLength(JSON.stringify(id));
      if (count >= 1000 || bytes + size > 128 * 1024) break;
      page[key].add(id); count++; bytes += size;
    }
    return this.rpc("publishHistoryRotation", [page]);
  }
  removePublishedHistory(...args: Parameters<RecoverableSQLiteProjection["removePublishedHistory"]>): ReturnType<RecoverableSQLiteProjection["removePublishedHistory"]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.rpc("removePublishedHistory", args);
  }
  readHistoricalRecords(...args: Parameters<RecoverableSQLiteProjection["readHistoricalRecords"]>): ReturnType<RecoverableSQLiteProjection["readHistoricalRecords"]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.read("readHistoricalRecords", args, new Map(), false);
  }
  pageHistoricalRecords(...args: Parameters<RecoverableSQLiteProjection["pageHistoricalRecords"]>): ReturnType<RecoverableSQLiteProjection["pageHistoricalRecords"]> {
    if (this.closed || this.options.disabled) return Promise.reject(new Error("Historical storage is unavailable."));
    return this.read("pageHistoricalRecords", args, [], false);
  }
  async listDeliveries(...args: Parameters<RecoverableSQLiteProjection["listDeliveries"]>): ReturnType<RecoverableSQLiteProjection["listDeliveries"]> {
    if (this.closed || this.options.disabled || this.cachedStatus.state === "degraded") return this.journal.listDeliveries(args[0]);
    return this.read("listDeliveries", args, []);
  }
  latestThreadSeq(...args: Parameters<RecoverableSQLiteProjection["latestThreadSeq"]>): ReturnType<RecoverableSQLiteProjection["latestThreadSeq"]> { return this.read("latestThreadSeq", args, 0); }
  oldestThreadSeq(...args: Parameters<RecoverableSQLiteProjection["oldestThreadSeq"]>): ReturnType<RecoverableSQLiteProjection["oldestThreadSeq"]> { return this.read("oldestThreadSeq", args, 0); }
  listThreadEvents(...args: Parameters<RecoverableSQLiteProjection["listThreadEvents"]>): ReturnType<RecoverableSQLiteProjection["listThreadEvents"]> { return this.read("listThreadEvents", args, []); }
  getThreadSnapshot(...args: Parameters<RecoverableSQLiteProjection["getThreadSnapshot"]>): ReturnType<RecoverableSQLiteProjection["getThreadSnapshot"]> { return this.read("getThreadSnapshot", args, null); }
  conversationEvents(...args: Parameters<RecoverableSQLiteProjection["conversationEvents"]>): ReturnType<RecoverableSQLiteProjection["conversationEvents"]> { return this.read("conversationEvents", args, null); }
  conversationSnapshot(...args: Parameters<RecoverableSQLiteProjection["conversationSnapshot"]>): ReturnType<RecoverableSQLiteProjection["conversationSnapshot"]> { return this.read("conversationSnapshot", args, null, false); }
  persistedActiveObservedSessionUpdates(...args: Parameters<RecoverableSQLiteProjection["persistedActiveObservedSessionUpdates"]>): ReturnType<RecoverableSQLiteProjection["persistedActiveObservedSessionUpdates"]> { return this.read("persistedActiveObservedSessionUpdates", args, null, false); }
  applyObservedSessionBatch(...args: Parameters<RecoverableSQLiteProjection["applyObservedSessionBatch"]>): ReturnType<RecoverableSQLiteProjection["applyObservedSessionBatch"]> {
    if (this.closed || this.options.disabled) return Promise.resolve();
    return this.rpc("applyObservedSessionBatch", args);
  }
  private async read<T>(method: string, args: unknown[], disabledValue: T, catchUp = true): Promise<T> {
    if (this.closed || this.options.disabled) return disabledValue;
    if (this.activeReads >= (this.options.maxPendingRequests ?? 16)) throw new Error("sqlite projection read capacity");
    this.activeReads++;
    try {
      if (catchUp) await this.flush();
      return await this.rpc(method, args);
    } finally { this.activeReads--; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearInterval(this.watchdog);
    this.failRequests(new Error("sqlite projection worker closed"));
    const worker = this.worker; this.worker = null;
    if (worker) this.terminateWorker(worker);
    this.cachedHealth = { ...this.cachedHealth, unavailable: "sqlite projection closed" };
  }
  private failRequests(error: Error): void {
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear(); this.warmPromise = null;
  }
  private terminateWorker(worker: Worker): void {
    // Retirement can race a worker's own exit. Neither a synchronous throw nor
    // a rejected termination promise belongs on the broker's fatal path.
    try { void worker.terminate().catch(() => {}); } catch { /* Already retired. */ }
  }
  private failed(worker: Worker, cause: unknown): void {
    if (this.worker !== worker) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this.worker = null; this.failRequests(error);
    this.cachedStatus = { state: "degraded", detail: error.message };
    this.cachedHealth = { failures: this.cachedHealth.failures + 1, unavailable: error.message };
    this.terminateWorker(worker);
  }
  private postMessage(worker: Worker, packet: unknown): void {
    if (this.worker !== worker) return;
    try { worker.postMessage(packet); }
    catch (error) { this.failed(worker, error); }
  }
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.closed) throw new Error("sqlite projection worker closed");
    const url = this.options.workerUrl ?? new URL(import.meta.url.endsWith(".ts") ? "./sqlite-projection-worker-entry.ts" : "./sqlite-projection-worker-entry.js", import.meta.url);
    const configuredTimeout = this.options.requestTimeoutMs;
    const timeout = configuredTimeout !== undefined && Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30_000;
    const heartbeatMs = Math.min(250, Math.max(10, Math.floor(timeout / 4)));
    const worker = new Worker(url, { workerData: { dbPath: this.dbPath, journalPath: this.journalPath, historyDirectory: this.options.historyDirectory, heartbeatMs } });
    this.worker = worker;
    this.workerProgress = 0;
    worker.on("message", packet => { void this.onMessage(worker, packet).catch(error => this.failed(worker, error)); });
    const failed = (error: Error) => this.failed(worker, error);
    worker.on("error", failed);
    worker.on("exit", code => { if (!this.closed) failed(new Error(`sqlite projection worker exited (${code})`)); });
    this.watchdog = setInterval(() => {
      if (this.worker !== worker) return;
      const now = Date.now();
      if ([...this.requests.values()].some(request => now - request.lastProgressAt >= timeout)) {
        failed(new Error(`sqlite projection worker stalled for ${timeout}ms without replay progress`));
      }
    }, heartbeatMs);
    this.watchdog.unref();
    return worker;
  }
  private rpc<T>(method: string, args: unknown[], maximumBytes = MAX_REQUEST_BYTES): Promise<T> {
    if (this.requests.size >= (this.options.maxPendingRequests ?? 16)) return Promise.reject(new Error("sqlite projection request capacity"));
    const encoded = JSON.stringify(args, (_key, value) => value instanceof Map ? [...value] : value instanceof Set ? [...value] : value);
    if (Buffer.byteLength(encoded) > maximumBytes) return Promise.reject(new Error("sqlite projection request byte capacity"));
    const worker = this.ensureWorker(), id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject, lastProgressAt: Date.now() });
      this.postMessage(worker, { kind: "request", id, method, args });
    });
  }
  private async onMessage(worker: Worker, packet: any): Promise<void> {
    if (this.worker !== worker) return;
    if (packet.status) this.cachedStatus = packet.status;
    if (packet.health) this.cachedHealth = packet.health;
    if (packet.replay) this.replayStats = packet.replay;
    if (typeof packet.progress === "number" && packet.progress > this.workerProgress) {
      this.workerProgress = packet.progress;
      const now = Date.now();
      for (const request of this.requests.values()) request.lastProgressAt = now;
    }
    if (packet.kind === "result") {
      const request = this.requests.get(packet.id); if (!request) return;
      this.requests.delete(packet.id);
      if (packet.error) request.reject(new Error(packet.error)); else request.resolve(packet.value);
    } else if (packet.kind === "source") {
      let reply: { kind: "sourceResult"; id: number; value?: unknown; error?: string };
      try {
        let value: unknown;
        if (packet.operation === "boundary") value = await this.journal.captureReplayBoundary(packet.value);
        else if (packet.operation === "threadEvents") this.threadEvents?.publish(packet.value);
        else throw new Error("unknown projection source request");
        reply = { kind: "sourceResult", id: packet.id, value };
      } catch (error) {
        reply = { kind: "sourceResult", id: packet.id, error: error instanceof Error ? error.message : String(error) };
      }
      // The journal await may outlive the watchdog, close(), or even a new
      // worker generation. Never reply to or fail that replacement generation.
      if (this.worker !== worker) return;
      this.postMessage(worker, reply);
    }
  }
}
