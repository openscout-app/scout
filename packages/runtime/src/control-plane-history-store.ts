import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";
import { ensureDurableDirectory } from "./control-plane-archive.js";

/** Full serialized records, including context and fields unknown to SQL mappers. */
export type HistoricalRecord = {
  kind: string;
  id: string;
  record: unknown;
  conversationId?: string;
  invocationId?: string;
  timestamp?: number;
};
export type HistoricalRecordLocation = {
  kind: string;
  id: string;
  partition: string;
  digest: string;
  conversationId: string | null;
  invocationId: string | null;
  timestamp: number;
};
export type HistoricalPublication = { partition: string; records: HistoricalRecordLocation[]; payloadBytes: number };
export const HISTORY_PARTITION_LIMITS = { records: 1000, payloadBytes: 8 * 1024 * 1024, openPartitions: 4, overflowPayloadBytes: 64 * 1024 * 1024 } as const;

type StoredRow = { kind: string; id: string; payload_json: string; digest: string; conversation_id: string | null; invocation_id: string | null; record_ts: number };
type LocationRow = Omit<StoredRow, "payload_json"> & { partition_id: string };
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const historicalRecordKey = (kind: string, id: string): string => JSON.stringify([kind, id]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("history_record_not_json");
  return encoded;
}
function syncFile(path: string) {
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
}
function location(row: LocationRow): HistoricalRecordLocation {
  return { kind: row.kind, id: row.id, partition: row.partition_id, digest: row.digest,
    conversationId: row.conversation_id, invocationId: row.invocation_id ?? null, timestamp: row.record_ts };
}
function transaction<T>(db: ControlPlaneSqliteDatabase, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = run(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Lazy read-only historical access. Missing history is empty; corrupt history throws.
 * Opening this reader never creates directories/schema or runs a durability barrier.
 */
export class ControlPlaneHistoryReader {
  protected catalogConnection: ControlPlaneSqliteDatabase | null = null;
  private readonly openPartitions = new Map<string, ControlPlaneSqliteDatabase>();
  protected readonly catalogPath: string;
  protected readonly partitionsDirectory: string;
  constructor(protected readonly directory: string) {
    this.catalogPath = join(directory, "catalog.sqlite");
    this.partitionsDirectory = join(directory, "partitions");
  }
  protected openCatalog(): ControlPlaneSqliteDatabase | undefined {
    if (this.catalogConnection) return this.catalogConnection;
    if (!existsSync(this.catalogPath)) return undefined;
    this.catalogConnection = openControlPlaneSqliteDatabase(this.catalogPath, { readonly: true, create: false });
    return this.catalogConnection;
  }
  locate(kind: string, id: string): HistoricalRecordLocation | null {
    const row = this.openCatalog()?.query<LocationRow>("SELECT * FROM records WHERE kind=?1 AND id=?2").get(kind, id);
    return row ? location(row) : null;
  }

  read<T = unknown>(kind: string, id: string): T | undefined {
    const found = this.locate(kind, id);
    return found ? this.readLocation<T>(found) : undefined;
  }

  readLocation<T = unknown>(found: HistoricalRecordLocation): T {
    const row = this.partition(found.partition).query<StoredRow>("SELECT * FROM records WHERE kind=?1 AND id=?2").get(found.kind, found.id);
    if (!row || row.digest !== found.digest || digest(row.payload_json) !== found.digest) throw new Error("history_record_missing_or_corrupt");
    const record = JSON.parse(row.payload_json);
    if (found.kind === "invocation") record.origin ??= { source: "unknown" };
    return record as T;
  }

  page(options: { kind: string; conversationId?: string; invocationId?: string; order?: "asc" | "desc"; after?: { timestamp: number; id: string }; limit?: number }): HistoricalRecordLocation[] {
    if (!Number.isFinite(options.limit ?? 100) || !Number.isFinite(options.after?.timestamp ?? 0)) throw new Error("invalid_history_page");
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
    const clauses = ["kind=?"];
    const params: (string | number)[] = [options.kind];
    if (options.after) {
      clauses.push(`(record_ts,id)${options.order === "desc" ? "<" : ">"}(?,?)`);
      params.push(options.after.timestamp, options.after.id);
    }
    if (options.conversationId !== undefined) {
      clauses.push("conversation_id=?"); params.push(options.conversationId);
    }
    if (options.invocationId !== undefined) { clauses.push("invocation_id=?"); params.push(options.invocationId); }
    params.push(limit);
    return this.openCatalog()?.query<LocationRow>(`SELECT * FROM records WHERE ${clauses.join(" AND ")} ORDER BY record_ts ${options.order === "desc" ? "DESC" : "ASC"},id ${options.order === "desc" ? "DESC" : "ASC"} LIMIT ?`)
      .all(...params).map(location) ?? [];
  }

  protected partition(id: string): ControlPlaneSqliteDatabase {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_history_partition_id");
    const cached = this.openPartitions.get(id);
    if (cached) { this.openPartitions.delete(id); this.openPartitions.set(id, cached); return cached; }
    const db = openControlPlaneSqliteDatabase(join(this.partitionsDirectory, `${id}.sqlite`), { readonly: true, create: false });
    this.openPartitions.set(id, db);
    if (this.openPartitions.size > HISTORY_PARTITION_LIMITS.openPartitions) {
      const oldest = this.openPartitions.keys().next().value!;
      this.openPartitions.get(oldest)?.close?.(); this.openPartitions.delete(oldest);
    }
    return db;
  }

  close(): void {
    for (const db of this.openPartitions.values()) db.close?.();
    this.openPartitions.clear(); this.catalogConnection?.close?.(); this.catalogConnection = null;
  }
}

/**
 * Historical payloads live in immutable bounded SQLite partitions. A separate
 * disk index maps exact identities and ordered conversation pages to partitions.
 * This store never deletes hot records: callers must revalidate the current hot
 * version after publication before removing it. Run publication in maintenance
 * workers, since SQLite/fsync are synchronous.
 */
export class ControlPlaneHistoryStore extends ControlPlaneHistoryReader {
  private get catalog(): ControlPlaneSqliteDatabase { return this.catalogConnection!; }

  constructor(directory: string) {
    super(directory);
    ensureDurableDirectory(directory);
    ensureDurableDirectory(this.partitionsDirectory);
    syncFile(this.partitionsDirectory); syncFile(directory);
    this.catalogConnection = openControlPlaneSqliteDatabase(this.catalogPath, { create: true });
    this.catalog.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, partition_id TEXT NOT NULL, digest TEXT NOT NULL,
        conversation_id TEXT, invocation_id TEXT, record_ts REAL NOT NULL, PRIMARY KEY(kind, id));
      CREATE INDEX IF NOT EXISTS history_conversation_page ON records(kind, conversation_id, record_ts, id);
      CREATE INDEX IF NOT EXISTS history_kind_page ON records(kind, record_ts, id);`);
    if (!this.catalog.query<{ name: string }>("PRAGMA table_info(records)").all().some(column => column.name === "invocation_id")) {
      this.catalog.exec("ALTER TABLE records ADD COLUMN invocation_id TEXT");
    }
    this.catalog.exec("CREATE INDEX IF NOT EXISTS history_invocation_page ON records(kind, invocation_id, record_ts, id)");
    syncFile(this.catalogPath); syncFile(directory);
  }

  /** A differing previously archived version requires explicit compare-and-swap. */
  publishPage(records: readonly HistoricalRecord[], options: { expectedDigests?: ReadonlyMap<string, string>; allowOversizedRecordBundle?: boolean } = {}): HistoricalPublication {
    if (!records.length || records.length > HISTORY_PARTITION_LIMITS.records) throw new Error("history_partition_record_limit");
    const keys = new Set<string>();
    const rows = records.map((entry): StoredRow => {
      if (!entry.kind || !entry.id || !Number.isFinite(entry.timestamp ?? 0)) throw new Error("invalid_history_record");
      const key = historicalRecordKey(entry.kind, entry.id);
      if (keys.has(key)) throw new Error("duplicate_history_record");
      keys.add(key);
      const serialized = JSON.stringify(entry.record);
      if (serialized === undefined) throw new Error("history_record_not_json");
      const payload = canonical(JSON.parse(serialized));
      return { kind: entry.kind, id: entry.id, payload_json: payload, digest: digest(payload),
        conversation_id: entry.conversationId ?? null, invocation_id: entry.invocationId ?? null, record_ts: entry.timestamp ?? 0 };
    }).sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const encoded = canonical(rows);
    const payloadBytes = Buffer.byteLength(encoded);
    const byteLimit = options.allowOversizedRecordBundle && records.length <= 2
      ? HISTORY_PARTITION_LIMITS.overflowPayloadBytes : HISTORY_PARTITION_LIMITS.payloadBytes;
    if (payloadBytes > byteLimit) throw new Error("history_partition_byte_limit");
    const partition = digest(encoded);
    const finalPath = join(this.partitionsDirectory, `${partition}.sqlite`);
    if (!existsSync(finalPath)) {
      const temporary = join(this.partitionsDirectory, `${partition}.${randomUUID()}.tmp`);
      const db = openControlPlaneSqliteDatabase(temporary, { create: true });
      try {
        db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
          CREATE TABLE records(kind TEXT NOT NULL, id TEXT NOT NULL, payload_json TEXT NOT NULL,
          digest TEXT NOT NULL, conversation_id TEXT, invocation_id TEXT, record_ts REAL NOT NULL, PRIMARY KEY(kind,id));`);
        const insert = db.query("INSERT INTO records (kind,id,payload_json,digest,conversation_id,invocation_id,record_ts) VALUES (?1,?2,?3,?4,?5,?6,?7)");
        transaction(db, () => {
          for (const row of rows) insert.run(row.kind, row.id, row.payload_json, row.digest, row.conversation_id, row.invocation_id, row.record_ts);
        });
      } catch (error) {
        db.close?.(); unlinkSync(temporary); throw error;
      }
      db.close?.(); syncFile(temporary); renameSync(temporary, finalPath);
    }
    // Reopened bytes, not successful INSERT calls, prove publication. Also
    // validates an identical partition left by a crash before catalog commit.
    syncFile(finalPath); syncFile(this.partitionsDirectory);
    const published = this.partition(partition);
    const read = published.query<StoredRow>("SELECT * FROM records WHERE kind=?1 AND id=?2");
    if (published.query<{ count: number }>("SELECT count(*) AS count FROM records").get()?.count !== rows.length) throw new Error("history_partition_count_mismatch");
    for (const row of rows) {
      if (canonical(read.get(row.kind, row.id)) !== canonical(row)) throw new Error("history_partition_payload_mismatch");
    }
    transaction(this.catalog, () => {
      const current = this.catalog.query<LocationRow>("SELECT * FROM records WHERE kind=?1 AND id=?2");
      const upsert = this.catalog.query(`INSERT INTO records (kind,id,partition_id,digest,conversation_id,invocation_id,record_ts) VALUES (?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(kind,id) DO UPDATE SET partition_id=excluded.partition_id,digest=excluded.digest,
        conversation_id=excluded.conversation_id,invocation_id=excluded.invocation_id,record_ts=excluded.record_ts`);
      for (const row of rows) {
        const prior = current.get(row.kind, row.id);
        if (prior && prior.digest !== row.digest && options.expectedDigests?.get(historicalRecordKey(row.kind, row.id)) !== prior.digest) {
          throw new Error(`history_version_conflict:${row.kind}:${row.id}`);
        }
        upsert.run(row.kind, row.id, partition, row.digest, row.conversation_id, row.invocation_id, row.record_ts);
      }
    });
    syncFile(this.catalogPath); syncFile(this.directory);
    return { partition, payloadBytes, records: rows.map((row) => location({ ...row, partition_id: partition })) };
  }


}

/** Digest of JSON-persisted content, independent of object property order. */
export function historicalRecordDigest(record: unknown): string { return digest(canonical(JSON.parse(JSON.stringify(record)))); }
