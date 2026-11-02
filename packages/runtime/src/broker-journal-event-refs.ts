import { createHash } from "node:crypto";
import type { BrokerJournalEntry } from "./broker-journal.js";

/**
 * A control event usually announces the record its command just journaled:
 * flight.updated carries the flight, message.posted the message. Journaling
 * that copy twice is the largest redundancy in the journal. The writer stores
 * the event's own envelope and a reference to the record line written before
 * it; every reader restores the copy before any visitor sees the entry, so the
 * projection, compaction and diagnostics keep receiving complete events.
 */
export type ControlEventRecordField = "flight" | "message" | "invocation";
export type ControlEventPayloadRecord = { field: ControlEventRecordField; id: string; sha256: string };

const RECORD_FIELDS: Readonly<Record<string, ControlEventRecordField>> = {
  "flight.record": "flight",
  "message.record": "message",
  "invocation.record": "invocation",
};
const EVENT_FIELDS: readonly ControlEventRecordField[] = ["flight", "message", "invocation"];
/** A record and its event are written by one command, a few entries apart. */
const RECENT_RECORD_LIMIT = 256;

type RecordRef = { key: string; record: object };

function journaledRecord(entry: BrokerJournalEntry): RecordRef | null {
  const field = RECORD_FIELDS[entry.kind];
  if (!field) return null;
  const record = (entry as unknown as Record<string, unknown>)[field];
  if (!record || typeof record !== "object") return null;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" ? { key: `${field}:${id}`, record } : null;
}

/** JSON with sorted keys: equal for equal values whatever their key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]]))
    : item);
}

export function recordDigest(record: object): string {
  return createHash("sha256").update(canonicalJson(record), "utf8").digest("hex").slice(0, 32);
}

class RecentRecords {
  private readonly records = new Map<string, object>();
  get(key: string): object | undefined { return this.records.get(key); }
  clone(): RecentRecords { const copy = new RecentRecords(); for (const [key, record] of this.records) copy.records.set(key, record); return copy; }
  set(key: string, record: object): void {
    this.records.delete(key);
    this.records.set(key, record);
    if (this.records.size > RECENT_RECORD_LIMIT) this.records.delete(this.records.keys().next().value!);
  }
}

function eventRecordField(payload: Record<string, unknown>): { field: ControlEventRecordField; id: string; record: object } | null {
  let found: { field: ControlEventRecordField; id: string; record: object } | null = null;
  for (const field of EVENT_FIELDS) {
    const record = payload[field];
    if (record === undefined) continue;
    const id = record && typeof record === "object" ? (record as { id?: unknown }).id : undefined;
    // One record per event; anything ambiguous stays a complete copy.
    if (typeof id !== "string" || found) return null;
    found = { field, id, record: record as object };
  }
  return found;
}

/** Writer side. Apply in journal order to the exact entries being encoded. */
export class ControlEventThinner {
  private readonly recent = new RecentRecords();

  /** The returned commit runs only after the encoded bytes are durable. */
  encode(entries: readonly BrokerJournalEntry[]): { entries: BrokerJournalEntry[]; commit: () => void } {
    const staged = new Map<string, object>();
    const lookup = (key: string) => staged.has(key) ? staged.get(key) : this.recent.get(key);
    const encoded = entries.map((entry) => {
      const written = journaledRecord(entry);
      if (written) { staged.delete(written.key); staged.set(written.key, written.record); return entry; }
      return entry.kind === "control.event.record" ? thinEvent(entry, lookup) ?? entry : entry;
    });
    return { entries: encoded, commit: () => { for (const [key, record] of staged) this.recent.set(key, record); } };
  }

  encodeOne(entry: BrokerJournalEntry): BrokerJournalEntry {
    const result = this.encode([entry]);
    result.commit();
    return result.entries[0]!;
  }
}

function thinEvent(
  entry: Extract<BrokerJournalEntry, { kind: "control.event.record" }>,
  lookup: (key: string) => object | undefined,
): BrokerJournalEntry | null {
  if (entry.payloadRecord) return null;
  const payload = entry.event.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;
  const target = eventRecordField(payload);
  if (!target) return null;
  const written = lookup(`${target.field}:${target.id}`);
  if (!written) return null;
  const digest = recordDigest(written);
  if (written !== target.record && recordDigest(target.record) !== digest) return null;
  const { [target.field]: _copy, ...rest } = payload;
  // On disk the payload lacks its record until a reader restores it.
  return { ...entry, event: { ...entry.event, payload: rest }, payloadRecord: { field: target.field, id: target.id, sha256: digest } } as unknown as BrokerJournalEntry;
}

/** Reader side. One instance per ordered pass over the journal. */
export class ControlEventHydrator {
  private recent = new RecentRecords();
  unresolved = 0;

  clone(): ControlEventHydrator { const copy = new ControlEventHydrator(); copy.recent = this.recent.clone(); return copy; }

  decode(entry: BrokerJournalEntry): BrokerJournalEntry {
    const written = journaledRecord(entry);
    if (written) { this.recent.set(written.key, written.record); return entry; }
    if (entry.kind !== "control.event.record" || !entry.payloadRecord) return entry;
    const { payloadRecord: ref, ...complete } = entry;
    const record = this.recent.get(`${ref.field}:${ref.id}`);
    if (record && recordDigest(record) === ref.sha256) {
      return { ...complete, event: { ...entry.event, payload: { ...entry.event.payload, [ref.field]: record } } } as unknown as BrokerJournalEntry;
    }
    // The referenced line is gone (an evicted record). Say so instead of
    // inventing a version: the event keeps its identity and its record id.
    this.unresolved += 1;
    return { ...complete, event: { ...entry.event, payload: { ...entry.event.payload, [ref.field]: { id: ref.id }, recordUnavailable: true } } } as unknown as BrokerJournalEntry;
  }
}
