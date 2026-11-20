/**
 * Derived records.
 *
 * A derived record is made from a source record by code or by an agent: a
 * verdict, a presentation, a label, a digest. It names the source version it
 * read. A reader uses it only while that version is still current, and
 * otherwise falls back to the source. So a derivation that is late, wrong or
 * missing never breaks the page that reads it.
 *
 * Scout already works this way in several places: the search index keeps a
 * content hash, routing docs keep a source hash, and a work review names the
 * placement revision it judged. This module gives the pattern one record
 * shape and one read rule.
 *
 * The runtime is the only writer. It refuses, as stale, a write that names a
 * version the source has moved past.
 */
import type { MetadataMap } from "./common.js";

export const DERIVED_RECORD_SCHEMA = "openscout.derived.v1" as const;

/** Where a collaboration record keeps its derived records, one per kind. */
export const DERIVED_METADATA_KEY = "derived" as const;

/** The label on work that the runtime starts to make a derivation. Such work is never derived from itself. */
export const DERIVED_WORK_LABEL = "scout:derived" as const;

/** Upper bound for one record's body, as JSON. */
export const DERIVED_BODY_MAX_BYTES = 32 * 1024;

const KIND_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export interface DerivedProducer {
  /** Who made it: an agent id, or a code producer's name. */
  id: string;
  kind: "code" | "agent";
  /**
   * The producer's own version, such as a skill or extractor version. A reader
   * that knows the current producer version can treat older output as stale.
   */
  version?: string;
}

export interface DerivedRecord<Body = unknown> {
  schema: typeof DERIVED_RECORD_SCHEMA;
  /** What it is, such as `presentation` or `label`. The kind names the body's shape. */
  kind: string;
  sourceId: string;
  /** The source version the producer read. */
  sourceVersion: string;
  producer: DerivedProducer;
  body: Body;
  generatedAt: number;
  /** The run that made it, when an agent did. */
  flightId?: string;
}

export type DerivedStatus = "current" | "stale" | "missing";

export interface DerivedRead<Body = unknown> {
  status: DerivedStatus;
  /** The source's version now. A producer passes it back when it writes. */
  currentVersion: string;
  /** Present when stale too, so a reader can show it as old rather than hide it. */
  record?: DerivedRecord<Body>;
}

export function isValidDerivedKind(kind: unknown): kind is string {
  return typeof kind === "string" && KIND_PATTERN.test(kind);
}

/**
 * A collaboration record's version: its placement revision, and its last
 * change. Writing a derived record leaves `updatedAt` as it is, so the write
 * does not make itself stale; any other change does.
 */
export function collaborationRecordVersion(record: { updatedAt: number; metadata?: MetadataMap | null }): string {
  const placement = record.metadata?.workPlacement as { revision?: unknown } | undefined;
  const revision = typeof placement?.revision === "number" ? placement.revision : 0;
  return `r${revision}.u${record.updatedAt}`;
}

export function derivedRecordsOf(record: { metadata?: MetadataMap | null }): Record<string, DerivedRecord> {
  const value = record.metadata?.[DERIVED_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  // No prototype: a kind such as "constructor" must not read Object.prototype.
  const out: Record<string, DerivedRecord> = Object.create(null);
  for (const [kind, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isDerivedRecord(entry) && entry.kind === kind) out[kind] = entry;
  }
  return out;
}

function isDerivedRecord(value: unknown): value is DerivedRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<DerivedRecord>;
  return v.schema === DERIVED_RECORD_SCHEMA && typeof v.kind === "string" && typeof v.sourceVersion === "string"
    && typeof v.sourceId === "string" && typeof v.generatedAt === "number" && Boolean(v.producer && typeof v.producer.id === "string");
}

/** The read rule: current while the source version matches, and the producer version too when one is given. */
export function readDerived<Body = unknown>(
  record: { id: string; updatedAt: number; metadata?: MetadataMap | null },
  kind: string,
  options: { producerVersion?: string } = {},
): DerivedRead<Body> {
  const currentVersion = collaborationRecordVersion(record);
  const records = derivedRecordsOf(record);
  const found = (Object.hasOwn(records, kind) ? records[kind] : undefined) as DerivedRecord<Body> | undefined;
  if (!found) return { status: "missing", currentVersion };
  const current = found.sourceId === record.id && found.sourceVersion === currentVersion
    && (options.producerVersion === undefined || found.producer.version === options.producerVersion);
  return { status: current ? "current" : "stale", currentVersion, record: found };
}

/** Put a derived record on its source without touching `updatedAt`. */
export function withDerivedRecord<T extends { metadata?: MetadataMap | null }>(record: T, derived: DerivedRecord): T {
  const metadata = record.metadata ?? {};
  const existing = metadata[DERIVED_METADATA_KEY];
  const map = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
  return { ...record, metadata: { ...metadata, [DERIVED_METADATA_KEY]: { ...map, [derived.kind]: derived } } };
}

/**
 * A client write keeps the runtime's derived records. It can neither drop them
 * (by sending metadata without them) nor forge them (by sending its own).
 */
export function keepDerivedRecords<T extends { metadata?: MetadataMap | null }>(
  existing: { metadata?: MetadataMap | null } | undefined,
  incoming: T,
): T {
  const held = existing?.metadata?.[DERIVED_METADATA_KEY];
  const sent = incoming.metadata && DERIVED_METADATA_KEY in incoming.metadata;
  if (held === undefined && !sent) return incoming;
  const { [DERIVED_METADATA_KEY]: _ignored, ...rest } = incoming.metadata ?? {};
  return { ...incoming, metadata: held === undefined ? rest : { ...rest, [DERIVED_METADATA_KEY]: held } };
}

// ---------------------------------------------------------------------------
// Runtime API shapes

export interface DerivedWriteRequest {
  workId: string;
  kind: string;
  /** The version the producer read, from a read or from the ask that started it. */
  sourceVersion: string;
  body: unknown;
  producerId?: string;
  producerKind?: DerivedProducer["kind"];
  producerVersion?: string;
  flightId?: string;
}

export type DerivedWriteResponse =
  | { status: "written"; record: DerivedRecord }
  | { status: "stale"; currentVersion: string };

export interface DerivedPendingItem {
  workId: string;
  kind: string;
  station: string;
  sourceVersion: string;
  status: Exclude<DerivedStatus, "current">;
  /** Whether a station names where an agent runs for it; otherwise it waits for a producer to pull it. */
  dispatchable: boolean;
}
