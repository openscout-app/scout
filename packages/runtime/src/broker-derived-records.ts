/**
 * Derived records in the runtime.
 *
 * The runtime is the one writer of derived records (see the protocol module).
 * A write names the source version it read. When the source has moved on, the
 * write is refused as stale and nothing changes. A record lives in its
 * source's metadata, one per kind, and the write leaves the source's
 * `updatedAt` alone. So derivations never reorder a board, never count as
 * activity, and never make themselves stale.
 *
 * Pending derivations are computed, not queued: an item needs a kind when its
 * station names that kind and the item has no current record of it. A restart
 * finds the same set again. When a station also names where an agent runs, the
 * dispatcher starts one ordinary ask for it. The ask's request id is built
 * from item, kind and version, so a retry is idempotent. Dispatch is bounded:
 * one ask per item and kind per interval, and a daily cap.
 */
import {
  DERIVED_BODY_MAX_BYTES,
  DERIVED_RECORD_SCHEMA,
  DERIVED_WORK_LABEL,
  assertValidCollaborationRecord,
  collaborationRecordVersion,
  currentWorkStation,
  isValidDerivedKind,
  isWorkItemTerminalState,
  readDerived,
  withDerivedRecord,
  workPlacementOf,
  type CollaborationRecord,
  type CompiledWorkLifecycle,
  type DerivedPendingItem,
  type DerivedRead,
  type DerivedRecord,
  type DerivedWriteRequest,
  type DerivedWriteResponse,
  type ScoutDeliverRequest,
  type WorkItemRecord,
  type WorkStationDeriver,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";

export class DerivedRecordError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ): Promise<BrokerJournalEntry[]>;
};

export interface BrokerDerivedRecordServiceOptions {
  registry: { forRecord(record: CollaborationRecord): CompiledWorkLifecycle };
  durableStore: DurableStore;
  runtime: {
    collaborationRecord(recordId: string): CollaborationRecord | undefined;
    upsertCollaboration(record: CollaborationRecord): Promise<void>;
  };
  listWorkItems(): WorkItemRecord[];
  /** Starts an ordinary ask. Without it, nothing is dispatched and pending items wait for a producer to pull them. */
  deliver?: (request: ScoutDeliverRequest) => Promise<unknown>;
  /** The identity asks are sent under. */
  producerActorId: string;
  nodeId?: string;
  /** Least time between two asks for the same item and kind. Default 15 minutes. */
  minIntervalMs?: number;
  /** Most asks started in one day. Default 50. */
  maxDispatchesPerDay?: number;
  /** Wait before a dispatch pass, so a burst of changes makes one pass. Default 1 second. */
  debounceMs?: number;
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
}

export function derivedRequestId(item: Pick<DerivedPendingItem, "workId" | "kind" | "sourceVersion">): string {
  return `derive.${item.workId}.${item.kind}.${item.sourceVersion}`;
}

export function buildDerivedAsk(
  record: WorkItemRecord,
  deriver: WorkStationDeriver & { projectPath: string },
  sourceVersion: string,
  caller: { actorId: string; nodeId?: string },
): ScoutDeliverRequest {
  const body = [
    `Make the \`${deriver.kind}\` derived record for Scout work item ${record.id} ("${record.title}").`,
    "",
    deriver.instructions.trim(),
    ...(deriver.skill ? ["", `Load the ${deriver.skill} skill.`] : []),
    "",
    `You read source version ${sourceVersion}. Write the result once with the MCP tool \`derived_write\`: workId "${record.id}", kind "${deriver.kind}", sourceVersion "${sourceVersion}", and your result as body (JSON).`,
    "If the write answers stale, the item changed while you worked. Stop there; a later run covers it.",
    "Do not move, answer or change the work item itself.",
  ].join("\n");
  const metadata = { source: "scout-derived", derivedKind: deriver.kind, derivedSourceId: record.id, derivedSourceVersion: sourceVersion };
  return {
    requestId: derivedRequestId({ workId: record.id, kind: deriver.kind, sourceVersion }),
    caller: { actorId: caller.actorId, ...(caller.nodeId ? { nodeId: caller.nodeId } : {}) },
    target: { kind: "project_path", projectPath: deriver.projectPath },
    body,
    intent: "consult",
    execution: {
      ...(deriver.harness ? { harness: deriver.harness as NonNullable<ScoutDeliverRequest["execution"]>["harness"] } : {}),
      ...(deriver.model ? { model: deriver.model } : {}),
      session: "new",
    },
    projectAgent: { persistence: "one_time" },
    labels: [DERIVED_WORK_LABEL],
    workItem: { title: `Derive ${deriver.kind}: ${record.title}`.slice(0, 200), labels: [DERIVED_WORK_LABEL] },
    messageMetadata: metadata,
    invocationMetadata: metadata,
  };
}

export class BrokerDerivedRecordService {
  private readonly lastStarted = new Map<string, number>();
  private budget = { day: "", count: 0 };
  private budgetWarned = "";
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly options: BrokerDerivedRecordServiceOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private workItem(workId: string): WorkItemRecord {
    const record = this.options.runtime.collaborationRecord(workId);
    if (!record || record.kind !== "work_item") throw new DerivedRecordError(404, `No work item ${workId}.`);
    return record;
  }

  readonly read = (query: { workId: string; kind: string; producerVersion?: string }): DerivedRead => {
    if (!query.workId?.trim() || !isValidDerivedKind(query.kind)) throw new DerivedRecordError(400, "workId and a valid kind are required.");
    return readDerived(this.workItem(query.workId.trim()), query.kind, { producerVersion: query.producerVersion });
  };

  readonly write = (request: DerivedWriteRequest): Promise<DerivedWriteResponse> =>
    this.options.durableStore.runWrite(async () => {
      if (!request.workId?.trim()) throw new DerivedRecordError(400, "workId is required.");
      if (!isValidDerivedKind(request.kind)) throw new DerivedRecordError(400, "kind must be lowercase letters, digits, dots, dashes or underscores.");
      if (typeof request.sourceVersion !== "string" || !request.sourceVersion) throw new DerivedRecordError(400, "sourceVersion is required.");
      if (request.body === undefined) throw new DerivedRecordError(400, "body is required.");
      const size = Buffer.byteLength(JSON.stringify(request.body) ?? "", "utf8");
      if (size > DERIVED_BODY_MAX_BYTES) throw new DerivedRecordError(413, `body is ${size} bytes; the limit is ${DERIVED_BODY_MAX_BYTES}.`);
      const record = this.workItem(request.workId.trim());
      const currentVersion = collaborationRecordVersion(record);
      if (request.sourceVersion !== currentVersion) return { status: "stale", currentVersion };
      const derived: DerivedRecord = {
        schema: DERIVED_RECORD_SCHEMA,
        kind: request.kind,
        sourceId: record.id,
        sourceVersion: currentVersion,
        producer: {
          id: request.producerId?.trim() || "unknown",
          kind: request.producerKind === "code" ? "code" : "agent",
          ...(request.producerVersion?.trim() ? { version: request.producerVersion.trim() } : {}),
        },
        body: request.body,
        generatedAt: this.now(),
        ...(request.flightId?.trim() ? { flightId: request.flightId.trim() } : {}),
      };
      const next = withDerivedRecord(record, derived);
      assertValidCollaborationRecord(next);
      await this.options.durableStore.commitEntries([{ kind: "collaboration.record", record: next }], async () => {
        await this.options.runtime.upsertCollaboration(next);
      });
      return { status: "written", record: derived };
    });

  /** Open items whose station names a kind they have no current record of. */
  readonly pending = (query: { limit?: number } = {}): DerivedPendingItem[] => {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const out: DerivedPendingItem[] = [];
    for (const { record, station, deriver, read } of this.pendingEntries()) {
      out.push({
        workId: record.id, kind: deriver.kind, station, sourceVersion: read.currentVersion,
        status: read.status as DerivedPendingItem["status"], dispatchable: Boolean(deriver.projectPath?.trim()),
      });
      if (out.length >= limit) break;
    }
    return out;
  };

  private *pendingEntries(): Generator<{ record: WorkItemRecord; station: string; deriver: WorkStationDeriver; read: DerivedRead }> {
    const items = this.options.listWorkItems()
      .filter((record) => !isWorkItemTerminalState(record.state) && !(record.labels ?? []).includes(DERIVED_WORK_LABEL))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const record of items) {
      const machine = this.options.registry.forRecord(record);
      const station = currentWorkStation(machine, { ...record, placement: workPlacementOf(record) });
      for (const deriver of machine.stations.get(station)?.derive ?? []) {
        const read = readDerived(record, deriver.kind);
        if (read.status !== "current") yield { record, station, deriver, read };
      }
    }
  }

  /** Ask for a dispatch pass. Bursts coalesce into one pass; a change during a pass schedules one more. */
  readonly kick = (): void => {
    if (!this.options.deliver) return;
    if (this.running) { this.again = true; return; }
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.running = this.dispatchPending().then(() => undefined)
        .catch((error) => this.options.warn?.("[openscout-runtime] derived record dispatch failed:", error))
        .finally(() => {
          this.running = undefined;
          if (this.again) { this.again = false; this.kick(); }
        });
    }, this.options.debounceMs ?? 1000);
    this.scheduled.unref?.();
  };

  /** One dispatch pass. Exposed for tests; the daemon calls `kick`. */
  async dispatchPending(): Promise<number> {
    const deliver = this.options.deliver;
    if (!deliver) return 0;
    const minInterval = this.options.minIntervalMs ?? 15 * 60 * 1000;
    const cap = this.options.maxDispatchesPerDay ?? 50;
    let started = 0;
    for (const { record, deriver, read } of [...this.pendingEntries()]) {
      const projectPath = deriver.projectPath?.trim();
      if (!projectPath) continue;
      const key = `${record.id}\u0000${deriver.kind}`;
      const now = this.now();
      const last = this.lastStarted.get(key);
      if (last !== undefined && now - last < minInterval) continue;
      const day = new Date(now).toISOString().slice(0, 10);
      if (this.budget.day !== day) this.budget = { day, count: 0 };
      if (this.budget.count >= cap) {
        if (this.budgetWarned !== day) {
          this.budgetWarned = day;
          this.options.warn?.(`[openscout-runtime] derived record dispatch reached its daily cap of ${cap}; the rest stay pending.`);
        }
        break;
      }
      this.lastStarted.set(key, now);
      this.budget.count += 1;
      started += 1;
      try {
        await deliver(buildDerivedAsk(record, { ...deriver, projectPath }, read.currentVersion, {
          actorId: this.options.producerActorId, nodeId: this.options.nodeId,
        }));
      } catch (error) {
        // The interval still applies, so a failing route is not retried in a hot loop.
        this.options.warn?.(`[openscout-runtime] derived ${deriver.kind} for ${record.id} could not start:`, error);
      }
    }
    return started;
  }

  stop(): void {
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = undefined;
  }
}
