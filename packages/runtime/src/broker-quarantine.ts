import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

export type QuarantineStatus = "open" | "acknowledged" | "deferred" | "resolved";
export type QuarantineDecision = { action: "acknowledge" | "defer" | "retry"; at: number; outcome: string; detail: string | null };
export type QuarantineRetryResult = { record: QuarantineMetadata; outcome: "resolved" | "failed"; detail: string | null };
export type QuarantineScope = { recordIds: string[]; sessionIds: string[]; invocationIds: string[]; actorIds: string[] };
export type QuarantineMetadata = {
  id: string; status: QuarantineStatus; kind: string; reason: string; bytes: number; digest: string;
  createdAt: number; acknowledgedAt: number | null; scope: QuarantineScope;
};
export type QuarantineEvidence = QuarantineMetadata & {
  decisions?: QuarantineDecision[];
  encoding: "base64"; payload: string; source: { path: string; startByte?: number; endByte?: number; fileIdentity?: string };
};
export type QuarantineListOptions = { limit?: number; status?: QuarantineStatus; sessionId?: string };
export type QuarantineSummary = { openCount: number; acknowledgedCount: number; deferredCount?: number; resolvedCount?: number; samples: QuarantineMetadata[] };
export class QuarantinePersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "QuarantinePersistenceError"; }
}
type Row = { id: string; status: QuarantineStatus; kind: string; reason: string; bytes: number; digest: string;
  created_at: number; acknowledged_at: number | null; scope_json: string; payload: string; source_json: string };
const columns = "id,status,kind,reason,bytes,digest,created_at,acknowledged_at,scope_json";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function metadata(row: Omit<Row, "payload" | "source_json">): QuarantineMetadata {
  return { id: row.id, status: row.status, kind: row.kind, reason: row.reason, bytes: row.bytes, digest: row.digest,
    createdAt: row.created_at, acknowledgedAt: row.acknowledged_at, scope: JSON.parse(row.scope_json) };
}

/** Small indexed diagnostics; payload history is durable and never removed by acknowledgement. */
export class BrokerQuarantine {
  private db: ControlPlaneSqliteDatabase | null = null;
  private cachedStatus: { at: number; value: QuarantineSummary } | null = null;
  constructor(readonly path: string) {}
  private database(create: boolean): ControlPlaneSqliteDatabase | null {
    if (this.db) return this.db;
    if (!create && !existsSync(this.path)) return null;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = openControlPlaneSqliteDatabase(this.path, { create: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;
        CREATE TABLE IF NOT EXISTS quarantine (
          id TEXT PRIMARY KEY,status TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL,
          bytes INTEGER NOT NULL,digest TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER,
          scope_json TEXT NOT NULL,payload TEXT NOT NULL,source_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS quarantine_status_created ON quarantine(status,created_at,id);
        CREATE INDEX IF NOT EXISTS quarantine_kind ON quarantine(kind);
        CREATE TABLE IF NOT EXISTS quarantine_decisions (
          id INTEGER PRIMARY KEY, quarantine_id TEXT NOT NULL, action TEXT NOT NULL,
          at INTEGER NOT NULL, outcome TEXT NOT NULL, detail TEXT);
        CREATE INDEX IF NOT EXISTS quarantine_decisions_record ON quarantine_decisions(quarantine_id,id);
        CREATE TABLE IF NOT EXISTS quarantine_counts (singleton INTEGER PRIMARY KEY CHECK(singleton=1),open_count INTEGER NOT NULL,acknowledged_count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS quarantine_sessions (session_id TEXT NOT NULL,quarantine_id TEXT NOT NULL,
          PRIMARY KEY(session_id,quarantine_id));
        CREATE TABLE IF NOT EXISTS quarantine_records (record_id TEXT NOT NULL,quarantine_id TEXT NOT NULL,
          PRIMARY KEY(record_id,quarantine_id));
        CREATE TRIGGER IF NOT EXISTS quarantine_insert_count AFTER INSERT ON quarantine BEGIN
          UPDATE quarantine_counts SET open_count=open_count+(NEW.status='open'),acknowledged_count=acknowledged_count+(NEW.status='acknowledged') WHERE singleton=1; END;
        CREATE TRIGGER IF NOT EXISTS quarantine_update_count AFTER UPDATE OF status ON quarantine BEGIN
          UPDATE quarantine_counts SET open_count=open_count+(NEW.status='open')-(OLD.status='open'),
            acknowledged_count=acknowledged_count+(NEW.status='acknowledged')-(OLD.status='acknowledged') WHERE singleton=1; END;`);
      if (!db.query("SELECT 1 FROM quarantine_counts WHERE singleton=1").get()) {
        db.query("INSERT OR IGNORE INTO quarantine_counts SELECT 1,COALESCE(sum(status='open'),0),COALESCE(sum(status='acknowledged'),0) FROM quarantine").run();
      }
      const directory = openSync(dirname(this.path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.db = db; return db;
    } catch (error) { db.close?.(); throw error; }
  }
  preserve(input: { kind: string; reason: string; bytes: Uint8Array; source: QuarantineEvidence["source"]; entries?: unknown[] }): QuarantineMetadata {
    try {
      const db = this.database(true)!;
      const digest = sha(input.bytes), id = `quarantine-${sha(`${input.source.path}\0${input.kind}\0${digest}`)}`;
      const scope = quarantineScope(input.entries ?? []);
      // Visible samples are bounded; exact-read fences must cover every ID in
      // the preserved frame, including siblings after the first sixteen.
      const indexedScope = quarantineScope(input.entries ?? [], Number.MAX_SAFE_INTEGER);
      const payload = Buffer.from(input.bytes).toString("base64");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.query(`INSERT OR IGNORE INTO quarantine(id,status,kind,reason,bytes,digest,created_at,scope_json,payload,source_json)
          VALUES(?1,'open',?2,?3,?4,?5,?6,?7,?8,?9)`)
          .run(id, input.kind.slice(0, 128), input.reason.slice(0, 512), input.bytes.byteLength, digest, Date.now(), JSON.stringify(scope), payload, JSON.stringify(input.source));
        for (const sessionId of indexedScope.sessionIds) db.query("INSERT OR IGNORE INTO quarantine_sessions VALUES(?1,?2)").run(sessionId, id);
        for (const recordId of indexedScope.recordIds) db.query("INSERT OR IGNORE INTO quarantine_records VALUES(?1,?2)").run(recordId, id);
        const previous = db.query<Row>("SELECT * FROM quarantine WHERE id=?1").get(id);
        if (previous?.status === "resolved") {
          db.query("UPDATE quarantine SET status='open' WHERE id=?1").run(id);
          db.query("INSERT INTO quarantine_decisions(quarantine_id,action,at,outcome,detail) VALUES(?1,'retry',?2,'failed',?3)").run(id, Date.now(), `Failed again during projection: ${input.reason}`.slice(0, 1024));
        }
        const stored = db.query<Row>("SELECT * FROM quarantine WHERE id=?1").get(id);
        if (!stored || stored.bytes !== input.bytes.byteLength || stored.digest !== digest
          || sha(Buffer.from(stored.payload, "base64")) !== digest) throw new Error("quarantine preservation digest mismatch");
        db.exec("COMMIT");
        this.cachedStatus = null;
        return metadata(stored);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      throw new QuarantinePersistenceError("Could not preserve quarantined source; replay must retain its boundary.", { cause: error });
    }
  }
  list(options: QuarantineListOptions = {}): QuarantineMetadata[] {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
    const db = this.database(false); if (!db) return [];
    const where: string[] = [], values: (string | number)[] = [];
    if (options.status) { where.push("status=?"); values.push(options.status); }
    if (options.sessionId) { where.push("id IN (SELECT quarantine_id FROM quarantine_sessions WHERE session_id=?)"); values.push(options.sessionId); }
    return db.query<Row>(`SELECT ${columns} FROM quarantine${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(...values, limit).map(metadata);
  }
  read(id: string): QuarantineEvidence | null {
    const row = this.database(false)?.query<Row>("SELECT * FROM quarantine WHERE id=?1").get(id);
    return row ? { ...metadata(row), encoding: "base64", payload: row.payload, source: JSON.parse(row.source_json),
      decisions: this.database(false)!.query<{action: QuarantineDecision["action"]; at: number; outcome: string; detail: string | null}>(
        "SELECT action,at,outcome,detail FROM quarantine_decisions WHERE quarantine_id=?1 ORDER BY id DESC LIMIT 20").all(id).reverse() } : null;
  }
  acknowledge(id: string): QuarantineMetadata | null { return this.decide(id, "acknowledge", "acknowledged", "reviewed"); }
  defer(id: string): QuarantineMetadata | null { return this.decide(id, "defer", "deferred", "deferred"); }
  retryResult(id: string, outcome: "resolved" | "failed", detail: string | null): QuarantineMetadata | null {
    return this.decide(id, "retry", outcome === "resolved" ? "resolved" : "open", outcome, detail);
  }
  private decide(id: string, action: QuarantineDecision["action"], status: QuarantineStatus,
    outcome: string, detail: string | null = null): QuarantineMetadata | null {
    const db = this.database(false); if (!db) return null;
    const current = this.read(id); if (!current) return null;
    // A reviewed/deferred decision must not turn a successfully repaired row back into a fence.
    if (current.status === "resolved") return current;
    db.exec("BEGIN IMMEDIATE");
    try {
      const at = Date.now();
      db.query("UPDATE quarantine SET status=?1,acknowledged_at=CASE WHEN ?1='acknowledged' THEN COALESCE(acknowledged_at,?2) ELSE acknowledged_at END WHERE id=?3").run(status, at, id);
      db.query("INSERT INTO quarantine_decisions(quarantine_id,action,at,outcome,detail) VALUES(?1,?2,?3,?4,?5)").run(id, action, at, outcome, detail?.slice(0, 1024) ?? null);
      db.exec("COMMIT"); this.cachedStatus = null;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return this.read(id);
  }
  hasRecord(id: string): boolean {
    return Boolean(this.database(false)?.query("SELECT 1 FROM quarantine_records r JOIN quarantine q ON q.id=r.quarantine_id WHERE r.record_id=?1 AND q.status!='resolved' LIMIT 1").get(id));
  }
  hasUnknownJournalFrame(): boolean {
    return Boolean(this.database(false)?.query("SELECT 1 FROM quarantine WHERE kind='journal.invalid_frame' AND status!='resolved' LIMIT 1").get());
  }
  status(): QuarantineSummary {
    if (this.cachedStatus && Date.now() - this.cachedStatus.at < 1000) return this.cachedStatus.value;
    const counts = this.database(false)?.query<{ open_count: number; acknowledged_count: number }>("SELECT open_count,acknowledged_count FROM quarantine_counts WHERE singleton=1").get();
    const value = { openCount: counts?.open_count ?? 0, acknowledgedCount: counts?.acknowledged_count ?? 0,
      ...(() => {
        const db = this.database(false);
        const count = (status: string) => db?.query<{n: number}>("SELECT count(*) AS n FROM quarantine WHERE status=?1").get(status)?.n ?? 0;
        const deferredCount = count("deferred"), resolvedCount = count("resolved");
        return { ...(deferredCount ? { deferredCount } : {}), ...(resolvedCount ? { resolvedCount } : {}) };
      })(),
      samples: this.list({ status: "open", limit: 8 }) };
    this.cachedStatus = { at: Date.now(), value }; return value;
  }
  close(): void { this.db?.close?.(); this.db = null; }
}

/** Scope is bounded diagnostic metadata; complete IDs and context remain in the preserved payload. */
export function quarantineScope(entries: unknown[], limit = 16): QuarantineScope {
  const scope: QuarantineScope = { recordIds: [], sessionIds: [], invocationIds: [], actorIds: [] };
  const add = (key: keyof QuarantineScope, value: unknown) => {
    if (typeof value === "string" && value.length > 0 && value.length <= 4096 && scope[key].length < limit && !scope[key].includes(value)) scope[key].push(value);
  };
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, any>;
    for (const record of [entry.message, entry.invocation, entry.flight, entry.endpoint, entry.actor, entry.event, entry.attempt, entry.job, entry.record, entry.action, entry.checkpoint, entry.signal, entry.cursor, ...(Array.isArray(entry.deliveries) ? entry.deliveries : [])]) {
      if (!record || typeof record !== "object") continue;
      add("recordIds", record.id); add("actorIds", record.actorId); add("actorIds", record.requesterId); add("actorIds", record.targetAgentId);
      add("invocationIds", record.invocationId); if (record === entry.invocation) add("invocationIds", record.id);
      add("sessionIds", record.sessionId); add("sessionIds", record.metadata?.sessionId); add("sessionIds", record.metadata?.targetSessionId);
      if (record.kind === "session") add("sessionIds", record.id);
      if (typeof record.actorId === "string" && record.actorId.startsWith("session:")) add("sessionIds", record.actorId);
    }
  }
  return scope;
}
