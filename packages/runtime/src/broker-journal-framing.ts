import { createHash, randomUUID } from "node:crypto";
import type { BrokerJournalEntry } from "./broker-journal.js";

/** Bounds apply before acceptance and before parsing an on-disk frame. */
export const JOURNAL_FRAME_LIMITS = { bytes: 16 * 1024 * 1024, entries: 4096 } as const;
export const JOURNAL_BATCH_KIND = "journal.batch";
export const JOURNAL_GENERATION_KIND = "journal.generation";

/** Physical framing metadata, not a domain record or a replay/checkpoint barrier. */
export function encodeJournalGeneration(): string {
  return JSON.stringify({ kind: JOURNAL_GENERATION_KIND, version: 1, id: randomUUID() }) + "\n";
}

export function journalGenerationId(value: unknown): string | null {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== JOURNAL_GENERATION_KIND) return null;
  const header = value as { version?: unknown; id?: unknown };
  if (header.version !== 1 || typeof header.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(header.id)) {
    throw new UnsupportedJournalFrameError("unsupported_journal_generation");
  }
  return header.id;
}

export class JournalFrameLimitError extends Error {}
export class UnsupportedJournalFrameError extends Error {}

const digest = (payload: string) => createHash("sha256").update(payload, "utf8").digest("hex");
const isEntry = (value: unknown): value is BrokerJournalEntry => Boolean(value
  && typeof value === "object" && !Array.isArray(value)
  && typeof (value as { kind?: unknown }).kind === "string"
  && (value as { kind: string }).kind !== JOURNAL_BATCH_KIND
  && (value as { kind: string }).kind !== JOURNAL_GENERATION_KIND);

/** Legacy singletons stay readable; one logical batch occupies one JSON line. */
export function encodeJournalEntries(entries: readonly BrokerJournalEntry[]): string {
  if (!entries.length || entries.length > JOURNAL_FRAME_LIMITS.entries) {
    throw new JournalFrameLimitError("journal_batch_entry_limit");
  }
  const payload = JSON.stringify(entries);
  const line = entries.length === 1 ? JSON.stringify(entries[0]) : JSON.stringify({
    kind: JOURNAL_BATCH_KIND, version: 1, count: entries.length,
    sha256: digest(payload), payload,
  });
  if (Buffer.byteLength(line) > JOURNAL_FRAME_LIMITS.bytes) {
    throw new JournalFrameLimitError("journal_frame_byte_limit");
  }
  return line + "\n";
}

/** Validate the entire frame before returning any entry to a reducer. */
export function decodeJournalLine(line: string): BrokerJournalEntry[] {
  if (Buffer.byteLength(line) > JOURNAL_FRAME_LIMITS.bytes) {
    throw new JournalFrameLimitError("journal_frame_byte_limit");
  }
  if (!line.trim()) return [];
  const value: unknown = JSON.parse(line.trim());
  if (journalGenerationId(value) !== null) return [];
  if (isEntry(value)) return [value];
  const frame = value as { kind?: unknown; version?: unknown; count?: unknown; sha256?: unknown; payload?: unknown } | null;
  if (!frame || frame.kind !== JOURNAL_BATCH_KIND) throw new Error("invalid_journal_entry");
  if (frame.version !== 1) throw new UnsupportedJournalFrameError("unsupported_journal_batch_version");
  if (!Number.isSafeInteger(frame.count) || (frame.count as number) < 1
    || (frame.count as number) > JOURNAL_FRAME_LIMITS.entries
    || typeof frame.payload !== "string" || typeof frame.sha256 !== "string"
    || digest(frame.payload) !== frame.sha256) throw new Error("invalid_journal_batch");
  const entries: unknown = JSON.parse(frame.payload);
  if (!Array.isArray(entries) || entries.length !== frame.count || !entries.every(isEntry)) {
    throw new Error("invalid_journal_batch_entries");
  }
  return entries;
}

/** A readline replacement which never accumulates an unbounded torn line. */
export async function* journalLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<{ raw: Buffer; bytes: number }> {
  let parts: Buffer[] = [], length = 0;
  for await (const chunk of chunks) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(start, end);
      length += part.length;
      if (length > JOURNAL_FRAME_LIMITS.bytes) throw new JournalFrameLimitError("journal_frame_byte_limit");
      parts.push(part);
      if (newline < 0) break;
      const raw = parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
      yield { raw, bytes: length + 1 };
      parts = []; length = 0; start = newline + 1;
    }
  }
  // Complete legacy records without LF are supported. A torn JSON frame fails
  // whole-frame validation; removing only LF never creates a partial batch.
  if (length) yield { raw: parts.length === 1 ? parts[0]! : Buffer.concat(parts, length), bytes: length };
}
