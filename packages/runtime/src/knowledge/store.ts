import { existsSync, mkdirSync, readdirSync, lstatSync, writeFileSync, renameSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";
import { acquireKnowledgeWriter, KnowledgeStorageBudget, knowledgeStorageUsage, removeCollectionQmd, directoryBytes, fileBytes } from "./storage-budget.js";
import { knowledgeIndexEnabled } from "./settings.js";
import { ftsRowidForChunk } from "./chunk-fts-rowid.js";

import { resolveOpenScoutKnowledgePaths, type OpenScoutKnowledgePaths } from "./paths.js";
import type {
  KnowledgeChunk,
  KnowledgeCollection,
  KnowledgeCoverage,
  KnowledgeCoverageRequest,
  KnowledgeDocument,
  KnowledgeDrilldown,
  KnowledgeFacets,
  KnowledgeFacetValue,
  KnowledgeIndexJob,
  KnowledgeIndexJobState,
  KnowledgeIndexRequest,
  KnowledgeSearchHit,
  KnowledgeSearchPage,
  KnowledgeSearchQuery,
  KnowledgeSourceRef,
  KnowledgeStatus,
  KnowledgeWarmSpan,
} from "./types.js";

type SQLiteBinding = string | number | bigint | boolean | null | Uint8Array;

type SQLiteTransactionalDatabase = Database & {
  transaction<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult;
};

type CollectionRow = {
  id: string;
  kind: KnowledgeCollection["kind"];
  title: string;
  source_refs_json: string;
  qmd_path: string;
  status: KnowledgeCollection["status"];
  content_hash: string;
  extractor_version: string;
  chunk_policy_version: string;
  created_at: number;
  updated_at: number;
  facets_json: string;
};

type ChunkRow = {
  id: string;
  collection_id: string;
  document_id: string;
  document_path: string;
  ordinal: number;
  text: string;
  text_hash: string;
  origin: KnowledgeChunk["origin"];
  ownership: KnowledgeChunk["ownership"];
  source_refs_json: string;
  facets_json: string;
  collection_facets_json?: string;
  title?: string;
  rank?: number;
};

type JobRow = {
  id: string;
  source: KnowledgeIndexJob["source"];
  state: KnowledgeIndexJobState;
  lease_owner: string | null;
  lease_generation: number;
  progress_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  error: string | null;
};

type WarmSpanRow = {
  id: string;
  source: string;
  harness: string;
  lookback_ms: number;
  cutoff_ms: number;
  completed_at: number;
  job_id: string;
  discovered: number;
  indexed: number;
  failed: number;
};

const KNOWLEDGE_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS storage_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  qmd_path TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  chunk_policy_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  facets_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT,
  UNIQUE(collection_id, path)
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  ownership TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  facets_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(collection_id, document_path, ordinal)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  collection_id UNINDEXED,
  document_id UNINDEXED,
  title,
  body,
  tokenize = "unicode61 tokenchars '-_./'"
);

CREATE TABLE IF NOT EXISTS facets (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facets_key_value ON facets(key, value);
CREATE INDEX IF NOT EXISTS idx_facets_collection_key ON facets(collection_id, key);
-- Per-chunk deletes in upsertChunk otherwise full-scan these tables once per chunk.
CREATE INDEX IF NOT EXISTS idx_facets_chunk ON facets(chunk_id);

CREATE TABLE IF NOT EXISTS source_refs (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_refs_kind ON source_refs(kind);
CREATE INDEX IF NOT EXISTS idx_source_refs_collection ON source_refs(collection_id);
CREATE INDEX IF NOT EXISTS idx_source_refs_chunk ON source_refs(chunk_id);

CREATE TABLE IF NOT EXISTS index_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_index_jobs_state_updated ON index_jobs(state, updated_at DESC);

-- Explicit warm-up coverage claims (not ambient). One row per (job, harness).
CREATE TABLE IF NOT EXISTS warm_spans (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  harness TEXT NOT NULL,
  lookback_ms INTEGER NOT NULL,
  cutoff_ms INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  discovered INTEGER NOT NULL,
  indexed INTEGER NOT NULL,
  failed INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_warm_spans_source_harness_completed
  ON warm_spans(source, harness, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_warm_spans_job ON warm_spans(job_id);
`;

// Check the whole read schema in one SQLite snapshot, not just the first table
// a bootstrapping writer happens to publish. Legacy/partial caches are empty
// until a writer upgrades them; a GET must never repair their schema.
const KNOWLEDGE_READ_TABLES = [
  "collections", "documents", "chunks", "chunks_fts", "facets", "source_refs",
  "index_jobs", "warm_spans", "storage_state",
] as const;

/** After this many ms without a covering re-warm, mark coverage stale (still "warmed"). */
export const KNOWLEDGE_WARM_SPAN_STALE_MS = 6 * 60 * 60 * 1000;

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nowMs(): number {
  return Date.now();
}

// Active index jobs heartbeat via updated_at on every progress write; a job
// untouched for this long means its indexer process is gone.
const STALE_INDEX_JOB_MS = 10 * 60 * 1000;

// A page is a starting point, not a ceiling: one query returns at most this
// many ranked chunks, and a caller continues from `offset`.
const SEARCH_PAGE_MAX = 500;

function normalizedLimit(value: number | undefined, fallback = 20, max = 100): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.floor(value));
}

function ftsTerms(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9_./-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 12);
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, "\"\"")}"`;
}

/** Exact multi-term AND (space-joined FTS tokens). */
function normalizeFtsQueryAnd(value: string): string {
  return ftsTerms(value).map(quoteFtsTerm).join(" ");
}

/** Multi-term OR for natural-language recall when AND returns zero rows. */
function normalizeFtsQueryOr(value: string): string {
  const terms = ftsTerms(value);
  if (terms.length <= 1) return terms.map(quoteFtsTerm).join(" ");
  return terms.map(quoteFtsTerm).join(" OR ");
}

/** Prefer AND precision; callers may fall back to OR on empty result sets. */
function normalizeFtsQuery(value: string): string {
  return normalizeFtsQueryAnd(value);
}

function textHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function deterministicKnowledgeChunkId(input: {
  collectionId: string;
  documentPath: string;
  ordinal: number;
  chunkPolicyVersion: string;
  text: string;
}): string {
  return textHash([
    input.collectionId,
    input.documentPath,
    String(input.ordinal),
    input.chunkPolicyVersion,
    textHash(input.text),
  ].join("\0"));
}

function collectionFromRow(row: CollectionRow): KnowledgeCollection {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    sourceRefs: parseJson<KnowledgeSourceRef[]>(row.source_refs_json, []),
    qmdPath: row.qmd_path,
    status: row.status,
    contentHash: row.content_hash,
    extractorVersion: row.extractor_version,
    chunkPolicyVersion: row.chunk_policy_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    facets: parseJson<KnowledgeFacets>(row.facets_json, {}),
  };
}

function chunkFromRow(row: ChunkRow): KnowledgeChunk {
  return {
    id: row.id,
    collectionId: row.collection_id,
    documentId: row.document_id,
    documentPath: row.document_path,
    ordinal: row.ordinal,
    text: row.text,
    textHash: row.text_hash,
    origin: row.origin,
    ownership: row.ownership,
    sourceRefs: parseJson<KnowledgeSourceRef[]>(row.source_refs_json, []),
    facets: { ...parseJson<KnowledgeFacets>(row.collection_facets_json, {}), ...parseJson<KnowledgeFacets>(row.facets_json, {}) },
  };
}

function jobFromRow(row: JobRow): KnowledgeIndexJob {
  return {
    id: row.id,
    source: row.source,
    state: row.state,
    leaseOwner: row.lease_owner ?? undefined,
    leaseGeneration: row.lease_generation,
    progress: parseJson<KnowledgeIndexJob["progress"]>(row.progress_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function warmSpanFromRow(row: WarmSpanRow): KnowledgeWarmSpan {
  return {
    id: row.id,
    source: row.source as KnowledgeWarmSpan["source"],
    harness: row.harness,
    lookbackMs: row.lookback_ms,
    cutoffMs: row.cutoff_ms,
    completedAt: row.completed_at,
    jobId: row.job_id,
    discovered: row.discovered,
    indexed: row.indexed,
    failed: row.failed,
  };
}

function normalizeCoverageHarnesses(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

function formatLookback(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours > 0 && hours % 24 === 0) return `--days ${hours / 24}`;
  if (hours > 0) return `--hours ${hours}`;
  return "";
}

function warmSuggestion(input: {
  source: string;
  harness: string[];
  lookbackMs?: number;
}): string {
  const parts = ["scout search index", `--source ${input.source}`];
  for (const harness of input.harness) {
    if (harness && harness !== "*") parts.push(`--harness ${harness}`);
  }
  const window = formatLookback(input.lookbackMs);
  if (window) parts.push(window);
  else parts.push("--days 3");
  return parts.join(" ");
}

function drilldownsForChunk(chunk: KnowledgeChunk): KnowledgeDrilldown[] {
  const drilldowns: KnowledgeDrilldown[] = [
    {
      kind: "qmd",
      collectionId: chunk.collectionId,
      documentPath: chunk.documentPath,
      chunkId: chunk.id,
    },
  ];
  for (const sourceRef of chunk.sourceRefs) {
    if (sourceRef.kind === "harness_transcript") {
      drilldowns.push({ kind: "harness_transcript", sourceRef });
    } else if (sourceRef.kind === "file" || sourceRef.kind === "skill" || sourceRef.kind === "context_pack") {
      drilldowns.push({ kind: "file", sourceRef });
    } else if (sourceRef.kind === "scout_record") {
      drilldowns.push({ kind: "scout_record", sourceRef });
    } else if (sourceRef.kind === "mcp_tool") {
      drilldowns.push({ kind: "mcp_tool", sourceRef });
    }
  }
  return drilldowns;
}

function snippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 220) return compact;
  const needle = query.toLowerCase().split(/\s+/).find((part) => part.length > 2);
  const index = needle ? compact.toLowerCase().indexOf(needle) : -1;
  const start = Math.max(0, index >= 0 ? index - 70 : 0);
  const end = Math.min(compact.length, start + 220);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

function searchHitFromRow(row: ChunkRow, query: string): KnowledgeSearchHit {
  const chunk = chunkFromRow(row);
  return {
    id: `hit:${chunk.id}`,
    collectionId: chunk.collectionId,
    documentId: chunk.documentId,
    chunkId: chunk.id,
    title: row.title ?? chunk.documentPath,
    snippet: snippet(chunk.text, query),
    score: typeof row.rank === "number" ? row.rank : 0,
    scoreSource: "fts",
    origin: chunk.origin,
    ownership: chunk.ownership,
    freshness: "unknown",
    sourceRefs: chunk.sourceRefs,
    drilldown: drilldownsForChunk(chunk),
    facets: chunk.facets,
  };
}

function insertFacetRows(db: Database, collectionId: string, chunkId: string | null, facets: KnowledgeFacets): void {
  const statement = db.query(
    `INSERT INTO facets (collection_id, chunk_id, key, value) VALUES (?1, ?2, ?3, ?4)`,
  );
  for (const [key, rawValue] of Object.entries(facets)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      statement.run(collectionId, chunkId, key, value);
    }
  }
}

function insertSourceRefs(db: Database, collectionId: string, chunkId: string | null, refs: KnowledgeSourceRef[]): void {
  const statement = db.query(
    `INSERT INTO source_refs (id, collection_id, chunk_id, kind, ref_json)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  );
  refs.forEach((ref, index) => {
    statement.run(
      textHash(`${collectionId}\0${chunkId ?? "collection"}\0${index}\0${stringify(ref)}`),
      collectionId,
      chunkId,
      ref.kind,
      stringify(ref),
    );
  });
}

/**
 * Open a read-only connection for search/status endpoints: no schema exec,
 * no migrations, no journal-mode changes. WAL permits snapshot reads during
 * indexing; the busy handler also covers the initial schema probe while a
 * writer initializes the database. A missing or incomplete database
 * is served from an empty in-memory schema
 * instead of falling back to a writable connection running DDL on a GET.
 */
function openReadonlyKnowledgeDatabase(sqlitePath: string): Database {
  if (existsSync(sqlitePath)) {
    const candidate = new Database(sqlitePath, { readonly: true, create: false } as {
      create?: boolean;
      strict?: boolean;
    });
    let retained = false;
    try {
      candidate.exec("PRAGMA busy_timeout = 1000;");
      const tables = new Set(candidate
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all().map((row) => (row as { name: string }).name));
      const initialized = KNOWLEDGE_READ_TABLES.every((name) => tables.has(name));
      if (initialized) {
        candidate.exec("PRAGMA query_only = ON;");
        retained = true;
        return candidate;
      }
    } finally {
      if (!retained) candidate.close();
    }
  }
  const memory = new Database(":memory:");
  memory.exec(KNOWLEDGE_SQLITE_SCHEMA);
  memory.exec("PRAGMA busy_timeout = 1000;");
  memory.exec("PRAGMA query_only = ON;");
  return memory;
}

export class SQLiteKnowledgeStore {
  private readonly db!: Database;
  private readonly paths: OpenScoutKnowledgePaths;
  private budget?: KnowledgeStorageBudget;
  private releaseWriter?: () => void;
  private insideWrite = false;
  private evictionsSinceMerge = 0;
  private hasStorageState = false;
  private evictedDuringBootstrap = false;

  constructor(dbPath?: string, paths?: OpenScoutKnowledgePaths, options?: { readonly?: boolean; maxBytes?: number; freeDiskBytes?: () => number }) {
    const resolvedPaths = paths ?? resolveOpenScoutKnowledgePaths();
    const sqlitePath = dbPath ?? resolvedPaths.sqlitePath;
    this.paths = { ...resolvedPaths, sqlitePath };
    if (options?.readonly) {
      this.db = openReadonlyKnowledgeDatabase(sqlitePath);
      this.hasStorageState = Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE name='storage_state'").get());
      return;
    }
    const inheritedUsage = knowledgeStorageUsage(this.paths); // Reject symlinks before any mutation.
    this.releaseWriter = acquireKnowledgeWriter(this.paths);
    try {
      mkdirSync(this.paths.qmdRoot, { recursive: true });
      this.db = new Database(sqlitePath, { create: true });
      this.db.exec("PRAGMA busy_timeout = 1000; PRAGMA auto_vacuum = INCREMENTAL;");
      this.db.exec("PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536;");
      // journal_mode cannot change inside a transaction; foreign_keys must be
      // enabled before one. Keep connection setup out of the atomic DDL batch.
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      const existingSchema = this.db.query("SELECT 1 FROM sqlite_master WHERE name='collections'").get();
      if (!existingSchema) {
        // Publish all tables together. Otherwise a concurrent status/search
        // reader can see collections before index_jobs exists.
        (this.db as SQLiteTransactionalDatabase).transaction(() => this.db.exec(KNOWLEDGE_SQLITE_SCHEMA))();
      }
      this.hasStorageState = Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE name='storage_state'").get());
      this.budget = new KnowledgeStorageBudget(this.db, this.paths, (id) => this.evictOldest(id), options);
      this.removeOrphanQmd();
      if (inheritedUsage.totalBytes > this.budget.maxBytes) {
        // An inherited oversized cache is a repair, not an admitted indexing
        // job. Bootstrap the small FK lookup index before pruning: otherwise
        // each document deletion scans all legacy chunk bodies. New/within-cap
        // stores admit this index below under the ordinary physical reservation.
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)");
      }
      this.budget.prepare();
      // Existing caches admit all schema upgrades, including storage_state,
      // only after repair/reservation. Do not let DDL create its own exception.
      this.writeBounded(() => {
        this.db.exec(KNOWLEDGE_SQLITE_SCHEMA);
        if (this.evictedDuringBootstrap) this.db.exec("INSERT OR REPLACE INTO storage_state VALUES ('retention_evicted', '1')");
      });
      this.hasStorageState = true;
      // Admission includes migration indexes, not only later content inserts.
      this.writeBounded(() => this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)"));
      this.writeBounded(() => this.migrateFtsRowids());
      this.migrateCollectionFacets();
    } catch (error) {
      this.db!?.close();
      this.releaseWriter();
      throw error;
    }
  }

  private writeBounded<T>(action: () => T, extraQmdBytes = 0, protectedId?: string): T {
    if (!this.budget) throw new Error("Knowledge store is read-only");
    return this.budget.run(() => {
      this.insideWrite = true;
      try { return action(); } finally { this.insideWrite = false; }
    }, extraQmdBytes, protectedId);
  }

  private evictOldest(protectedId?: string): number | false {
    const row = this.db.query("SELECT id FROM collections WHERE id != ?1 ORDER BY updated_at, id LIMIT 1")
      .get(protectedId ?? "") as { id: string } | null;
    if (!row) return false;
    const qmd = this.getCollection(row.id)!.qmdPath;
    const removedBytes = directoryBytes(qmd);
    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      this.deleteCollectionRows(row.id, false);
      this.evictedDuringBootstrap = true;
      if (this.hasStorageState) this.db.exec("INSERT OR REPLACE INTO storage_state VALUES ('retention_evicted', '1')");
      // A scanned window is no longer complete after capacity eviction.
      if (this.db.query("SELECT 1 FROM sqlite_master WHERE name='warm_spans'").get()) this.db.exec("DELETE FROM warm_spans");
      // FTS deletes leave tombstones. Merge them before admitting another large
      // insert; otherwise an empty corpus can still consume the entire budget.
      // Batch this on a legacy oversized file to avoid quadratic rebuild work.
      if (++this.evictionsSinceMerge >= 32 || fileBytes(this.paths.sqlitePath) <= this.budget!.maxBytes) {
        this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('optimize')");
        this.evictionsSinceMerge = 0;
      }
    })();
    removeCollectionQmd(this.paths, qmd);
    return removedBytes;
  }

  private removeOrphanQmd(): void {
    const known = new Set((this.db.query("SELECT qmd_path FROM collections").all() as { qmd_path: string }[]).map(r => r.qmd_path));
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        const stat = lstatSync(child);
        if (stat.isSymbolicLink()) continue;
        if (!stat.isDirectory()) continue;
        if (name.includes(".tmp-") || (existsSync(join(child, "manifest.json")) && !known.has(child))) {
          removeCollectionQmd(this.paths, child);
        } else if (!known.has(child)) walk(child);
      }
    };
    walk(this.paths.qmdRoot);
  }

  /** Shared session facets are collection facts, not repeated per-chunk facts.
   * Migrate retained legacy rows too, before a future explicit re-extraction. */
  private migrateCollectionFacets(): void {
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version >= 3) return;
    const keys = ["harness", "project", "projectPath", "source", "sessionId", "transcriptPath", "touchedPath", "recordKind", "recordTag", "toolName"];
    for (const row of this.db.query("SELECT id FROM collections WHERE kind='sessions'").all() as { id: string }[]) {
      if (!this.getCollection(row.id)) continue;
      this.writeBounded(() => {
        const collection = this.getCollection(row.id)!;
        const facets = { ...collection.facets };
        for (const key of keys) {
          const values = this.db.query("SELECT DISTINCT value FROM facets WHERE collection_id=? AND key=? ORDER BY value").all(row.id, key) as { value: string }[];
          if (values.length) facets[key] = values.length === 1 ? values[0]!.value : values.map(v => v.value);
        }
        this.upsertCollection({ ...collection, facets });
        const list = keys.map(k => `'${k}'`).join(",");
        this.db.query(`DELETE FROM facets WHERE collection_id=? AND chunk_id IS NOT NULL AND key IN (${list})`).run(row.id);
        this.db.query(`UPDATE chunks SET facets_json=json_remove(facets_json, ${keys.map(k => `'$.${k}'`).join(",")}) WHERE collection_id=?`).run(row.id);
      }, 0, row.id);
    }
    this.writeBounded(() => this.db.exec("PRAGMA user_version = 3"));
    this.budget!.reclaim();
  }

  /** Reserve all QMD bytes and worst-case WAL before inserting a whole collection.
   * Publishing QMD is synchronous while this job holds the cross-process lock. */
  replaceCollection(collection: KnowledgeCollection, documents: KnowledgeDocument[], entries: Array<{chunk: KnowledgeChunk; title?: string}>, files: Record<string, string>): void {
    const bytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    this.writeBounded(() => {
      // Rows are transactional; QMD stays untouched until a successful commit.
      this.deleteCollectionRows(collection.id, false);
      this.upsertCollection({ ...collection, status: "building", contentHash: "" });
      for (const document of documents) this.upsertDocument(document);
      this.upsertChunks(entries);
    }, bytes, collection.id);
    removeCollectionQmd(this.paths, collection.qmdPath);
    const temporary = `${collection.qmdPath}.tmp-${process.pid}`;
    removeCollectionQmd(this.paths, temporary);
    mkdirSync(temporary, { recursive: true });
    try {
      for (const [name, text] of Object.entries(files)) {
        if (name.includes("/") || name.includes("\\") || name === "..") throw new Error("Invalid QMD document name");
        writeFileSync(join(temporary, name), text);
      }
      renameSync(temporary, collection.qmdPath);
      this.upsertCollection(collection);
    } catch (error) {
      removeCollectionQmd(this.paths, temporary);
      this.deleteCollection(collection.id);
      throw error;
    }
  }

  /**
   * One-time rebuild of chunks_fts with deterministic rowids (user_version 2).
   * Legacy rows carry auto-assigned rowids that rowid-based deletes cannot
   * address; they are replaced wholesale by rows keyed by ftsRowidForChunk.
   */
  private migrateFtsRowids(): void {
    const row = this.db.query("PRAGMA user_version").get() as { user_version: number } | null;
    if ((row?.user_version ?? 0) >= 2) return;
    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      this.db.exec("DELETE FROM chunks_fts");
      const chunks = this.db.query(
        `SELECT c.id, c.collection_id, c.document_id, c.document_path, c.text,
                co.title AS collection_title
         FROM chunks c JOIN collections co ON co.id = c.collection_id`,
      ).all() as Array<{
        id: string;
        collection_id: string;
        document_id: string;
        document_path: string;
        text: string;
        collection_title: string;
      }>;
      const insert = this.db.query(
        `INSERT INTO chunks_fts (rowid, chunk_id, collection_id, document_id, title, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      );
      for (const chunk of chunks) {
        insert.run(
          ftsRowidForChunk(chunk.id),
          chunk.id,
          chunk.collection_id,
          chunk.document_id,
          `${chunk.collection_title} / ${chunk.document_path}`,
          chunk.text,
        );
      }
      this.db.exec("PRAGMA user_version = 2");
    })();
  }

  close(): void {
    try { this.db.close(); } finally { this.releaseWriter?.(); this.releaseWriter = undefined; }
  }

  upsertCollection(collection: KnowledgeCollection): void {
    if (!this.insideWrite) return this.writeBounded(() => this.upsertCollection(collection), 0, collection.id);
    this.db.query(
      `INSERT INTO collections (
        id, kind, title, source_refs_json, qmd_path, status, content_hash,
        extractor_version, chunk_policy_version, created_at, updated_at, facets_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        source_refs_json = excluded.source_refs_json,
        qmd_path = excluded.qmd_path,
        status = excluded.status,
        content_hash = excluded.content_hash,
        extractor_version = excluded.extractor_version,
        chunk_policy_version = excluded.chunk_policy_version,
        updated_at = excluded.updated_at,
        facets_json = excluded.facets_json`,
    ).run(
      collection.id,
      collection.kind,
      collection.title,
      stringify(collection.sourceRefs),
      collection.qmdPath,
      collection.status,
      collection.contentHash,
      collection.extractorVersion,
      collection.chunkPolicyVersion,
      collection.createdAt,
      collection.updatedAt,
      stringify(collection.facets),
    );

    this.db.query("DELETE FROM facets WHERE collection_id = ?1 AND chunk_id IS NULL").run(collection.id);
    this.db.query("DELETE FROM source_refs WHERE collection_id = ?1 AND chunk_id IS NULL").run(collection.id);
    insertFacetRows(this.db, collection.id, null, collection.facets);
    insertSourceRefs(this.db, collection.id, null, collection.sourceRefs);
  }

  getCollection(id: string): KnowledgeCollection | null {
    const row = this.db.query("SELECT * FROM collections WHERE id = ?1").get(id) as CollectionRow | null;
    return row ? collectionFromRow(row) : null;
  }

  deleteCollection(id: string): void {
    this.writeBounded(() => this.deleteCollectionRows(id));
  }

  private deleteCollectionRows(id: string, removeQmd = true): void {
    const collection = this.getCollection(id);
    if (collection && removeQmd) removeCollectionQmd(this.paths, collection.qmdPath);
    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      const chunkRows = this.db.query(
        "SELECT id FROM chunks WHERE collection_id = ?1",
      ).all(id) as Array<{ id: string }>;
      const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version < 2) this.db.query("DELETE FROM chunks_fts WHERE collection_id=?").run(id);
      // Free ordinary content/facet pages first: FTS tombstones/segment merges
      // may need scratch pages even though the operation is a deletion.
      this.db.query("DELETE FROM collections WHERE id = ?1").run(id);
      const deleteFts = this.db.query("DELETE FROM chunks_fts WHERE rowid = ?1");
      for (const row of chunkRows) {
        deleteFts.run(ftsRowidForChunk(row.id));
      }
    })();
  }

  upsertDocument(document: KnowledgeDocument): void {
    if (!this.insideWrite) return this.writeBounded(() => this.upsertDocument(document), 0, document.collectionId);
    this.db.query(
      `INSERT INTO documents (id, collection_id, path, kind, origin, content_hash, metadata_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
        collection_id = excluded.collection_id,
        path = excluded.path,
        kind = excluded.kind,
        origin = excluded.origin,
        content_hash = excluded.content_hash,
        metadata_json = excluded.metadata_json`,
    ).run(
      document.id,
      document.collectionId,
      document.path,
      document.kind,
      document.origin,
      document.contentHash,
      stringify(document.metadata ?? null),
    );
  }

  upsertChunk(chunk: KnowledgeChunk, title = chunk.documentPath): void {
    this.upsertChunks([{ chunk, title }]);
  }

  upsertChunks(entries: Array<{ chunk: KnowledgeChunk; title?: string }>): void {
    if (!this.insideWrite) return this.writeBounded(() => this.upsertChunks(entries), 0, entries[0]?.chunk.collectionId);
    if (entries.length === 0) return;
    const now = nowMs();
    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      for (const entry of entries) {
        this.upsertChunkRow(entry.chunk, entry.title ?? entry.chunk.documentPath, now);
      }
    })();
  }

  private upsertChunkRow(chunk: KnowledgeChunk, title: string, now: number): void {
    this.db.query(
      `INSERT INTO chunks (
        id, collection_id, document_id, document_path, ordinal, text, text_hash,
        origin, ownership, source_refs_json, facets_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(id) DO UPDATE SET
        collection_id = excluded.collection_id,
        document_id = excluded.document_id,
        document_path = excluded.document_path,
        ordinal = excluded.ordinal,
        text = excluded.text,
        text_hash = excluded.text_hash,
        origin = excluded.origin,
        ownership = excluded.ownership,
        source_refs_json = excluded.source_refs_json,
        facets_json = excluded.facets_json,
        updated_at = excluded.updated_at`,
    ).run(
      chunk.id,
      chunk.collectionId,
      chunk.documentId,
      chunk.documentPath,
      chunk.ordinal,
      chunk.text,
      chunk.textHash,
      chunk.origin,
      chunk.ownership,
      stringify(chunk.sourceRefs),
      stringify(chunk.facets),
      now,
      now,
    );

    this.db.query("DELETE FROM chunks_fts WHERE rowid = ?1").run(ftsRowidForChunk(chunk.id));
    this.db.query(
      `INSERT INTO chunks_fts (rowid, chunk_id, collection_id, document_id, title, body)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).run(ftsRowidForChunk(chunk.id), chunk.id, chunk.collectionId, chunk.documentId, title, chunk.text);

    this.db.query("DELETE FROM facets WHERE chunk_id = ?1").run(chunk.id);
    this.db.query("DELETE FROM source_refs WHERE chunk_id = ?1").run(chunk.id);
    insertFacetRows(this.db, chunk.collectionId, chunk.id, chunk.facets);
    insertSourceRefs(this.db, chunk.collectionId, chunk.id, chunk.sourceRefs);
  }

  searchLexical(query: KnowledgeSearchQuery): KnowledgeSearchHit[] {
    return this.searchLexicalPage(query).hits;
  }

  /**
   * One page of ranked chunks, reporting which FTS variant produced it.
   *
   * Precision comes first (all tokens present), then OR recall for natural
   * phrases where one token is rare/absent from a chunk. A continuation page
   * carries that choice back in `ftsMode`: re-deciding it at a non-zero offset
   * would silently switch ranking mid-search and repeat or skip hits.
   */
  searchLexicalPage(query: KnowledgeSearchQuery): KnowledgeSearchPage {
    const q = query.q.trim();
    if (!q) return { hits: [], ftsMode: "and" };
    const andQuery = normalizeFtsQueryAnd(q);
    if (!andQuery) return { hits: [], ftsMode: "and" };
    const orQuery = normalizeFtsQueryOr(q);
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const pinned = query.ftsMode ?? (offset > 0 ? "and" : undefined);

    if (pinned === "or") {
      const hits = orQuery ? this.searchLexicalWithFtsQuery(query, q, orQuery) : [];
      return { hits, ftsMode: "or" };
    }
    const andHits = this.searchLexicalWithFtsQuery(query, q, andQuery);
    if (pinned === "and" || andHits.length > 0) return { hits: andHits, ftsMode: "and" };
    if (orQuery && orQuery !== andQuery) {
      return { hits: this.searchLexicalWithFtsQuery(query, q, orQuery), ftsMode: "or" };
    }
    return { hits: [], ftsMode: "and" };
  }

  private searchLexicalWithFtsQuery(
    query: KnowledgeSearchQuery,
    originalQ: string,
    ftsQuery: string,
  ): KnowledgeSearchHit[] {
    const params: SQLiteBinding[] = [ftsQuery];
    const clauses = ["chunks_fts MATCH ?1"];

    if (query.collections?.length) {
      const placeholders = query.collections.map((collectionId) => {
        params.push(collectionId);
        return `?${params.length}`;
      }).join(", ");
      clauses.push(`c.collection_id IN (${placeholders})`);
    }

    if (query.sourceKinds?.length) {
      const placeholders = query.sourceKinds.map((kind) => {
        params.push(kind);
        return `?${params.length}`;
      }).join(", ");
      clauses.push(`col.kind IN (${placeholders})`);
    }

    if (query.facets) {
      for (const [key, rawValue] of Object.entries(query.facets)) {
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        const filtered = values
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        if (filtered.length === 0) continue;
        const placeholders = filtered.map((value) => {
          params.push(value);
          return `?${params.length}`;
        }).join(", ");
        params.push(key);
        clauses.push(`EXISTS (
          SELECT 1 FROM facets f
          WHERE f.collection_id = c.collection_id
            AND (f.chunk_id = c.id OR f.chunk_id IS NULL)
            AND f.key = ?${params.length}
            AND f.value IN (${placeholders})
        )`);
      }
    }

    if (typeof query.sourceUpdatedAfterMs === "number" && Number.isFinite(query.sourceUpdatedAfterMs)) {
      params.push(query.sourceUpdatedAfterMs);
      clauses.push(`EXISTS (
        SELECT 1 FROM source_refs sr
        WHERE sr.chunk_id = c.id
          AND CAST(json_extract(sr.ref_json, '$.anchor.mtimeMs') AS REAL) >= ?${params.length}
      )`);
    }

    if (typeof query.sourceUpdatedBeforeMs === "number" && Number.isFinite(query.sourceUpdatedBeforeMs)) {
      params.push(query.sourceUpdatedBeforeMs);
      clauses.push(`EXISTS (
        SELECT 1 FROM source_refs sr
        WHERE sr.chunk_id = c.id
          AND CAST(json_extract(sr.ref_json, '$.anchor.mtimeMs') AS REAL) <= ?${params.length}
      )`);
    }

    const sql = `
      SELECT
        c.*,
        col.title AS title,
        col.facets_json AS collection_facets_json,
        bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.chunk_id
      JOIN collections col ON col.id = c.collection_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank ASC
      LIMIT ?${params.length + 1}
      OFFSET ?${params.length + 2}`;
    params.push(normalizedLimit(query.limit, 20, SEARCH_PAGE_MAX));
    params.push(Math.max(0, Math.floor(query.offset ?? 0)));

    try {
      const rows = this.db.query(sql).all(...params) as ChunkRow[];
      return rows.map((row) => searchHitFromRow(row, originalQ));
    } catch {
      return [];
    }
  }

  listFacetValues(keys?: string[], limit?: number): KnowledgeFacetValue[] {
    const params: SQLiteBinding[] = [];
    const clauses: string[] = [];
    const requestedKeys = keys
      ?.map((key) => key.trim())
      .filter((key) => key.length > 0);

    if (requestedKeys?.length) {
      const placeholders = requestedKeys.map((key) => {
        params.push(key);
        return `?${params.length}`;
      }).join(", ");
      clauses.push(`key IN (${placeholders})`);
    }

    const sql = `
      SELECT key, value, COUNT(DISTINCT collection_id) AS count
      FROM facets
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      GROUP BY key, value
      ORDER BY key ASC, count DESC, value ASC
      LIMIT ?${params.length + 1}`;
    params.push(normalizedLimit(limit, 200, 1000));

    return this.db.query(sql).all(...params) as KnowledgeFacetValue[];
  }

  createIndexJob(request: KnowledgeIndexRequest, id = `knowledge-job-${randomUUID()}`): KnowledgeIndexJob {
    if (!this.insideWrite) return this.writeBounded(() => this.createIndexJob(request, id));
    this.db.exec("DELETE FROM index_jobs WHERE id NOT IN (SELECT id FROM index_jobs ORDER BY updated_at DESC LIMIT 99)");
    const now = nowMs();
    // A job whose indexer died (SIGKILL/OOM/timeout) never leaves the active
    // states on its own; fail stale ones for this source so they neither
    // block nor clutter status forever.
    this.db.query(
      `UPDATE index_jobs
       SET state = 'failed', error = ?2, completed_at = ?3, updated_at = ?3
       WHERE source = ?1 AND state IN ('queued', 'running', 'waiting') AND updated_at < ?4`,
    ).run(request.source, "indexer exited before completion", now, now - STALE_INDEX_JOB_MS);
    const job: KnowledgeIndexJob = {
      id,
      source: request.source,
      state: "queued",
      leaseGeneration: 0,
      progress: {},
      createdAt: now,
      updatedAt: now,
    };
    this.db.query(
      `INSERT INTO index_jobs (id, source, state, lease_generation, progress_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).run(job.id, job.source, job.state, job.leaseGeneration, stringify(job.progress), job.createdAt, job.updatedAt);
    return job;
  }

  updateIndexJob(input: {
    id: string;
    state?: KnowledgeIndexJobState;
    leaseOwner?: string | null;
    leaseGeneration?: number;
    progress?: KnowledgeIndexJob["progress"];
    error?: string | null;
    completedAt?: number | null;
  }): KnowledgeIndexJob | null {
    if (!this.insideWrite) return this.writeBounded(() => this.updateIndexJob(input));
    const existing = this.getIndexJob(input.id);
    if (!existing) return null;
    const next: KnowledgeIndexJob = {
      ...existing,
      state: input.state ?? existing.state,
      leaseOwner: input.leaseOwner === null ? undefined : input.leaseOwner ?? existing.leaseOwner,
      leaseGeneration: input.leaseGeneration ?? existing.leaseGeneration,
      progress: input.progress ?? existing.progress,
      updatedAt: nowMs(),
      completedAt: input.completedAt === null ? undefined : input.completedAt ?? existing.completedAt,
      error: input.error === null ? undefined : input.error ?? existing.error,
    };
    this.db.query(
      `UPDATE index_jobs
       SET state = ?2,
           lease_owner = ?3,
           lease_generation = ?4,
           progress_json = ?5,
           updated_at = ?6,
           completed_at = ?7,
           error = ?8
       WHERE id = ?1`,
    ).run(
      next.id,
      next.state,
      next.leaseOwner ?? null,
      next.leaseGeneration,
      stringify(next.progress),
      next.updatedAt,
      next.completedAt ?? null,
      next.error ?? null,
    );
    return next;
  }

  getIndexJob(id: string): KnowledgeIndexJob | null {
    const row = this.db.query("SELECT * FROM index_jobs WHERE id = ?1").get(id) as JobRow | null;
    return row ? jobFromRow(row) : null;
  }

  listActiveJobs(): KnowledgeIndexJob[] {
    const rows = this.db.query(
      `SELECT * FROM index_jobs
       WHERE state IN ('queued', 'running', 'waiting')
         AND updated_at >= ?1
       ORDER BY updated_at DESC
       LIMIT 50`,
    ).all(nowMs() - STALE_INDEX_JOB_MS) as JobRow[];
    return rows.map(jobFromRow);
  }

  private hasWarmSpansTable(): boolean {
    try {
      return this.db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'warm_spans'")
        .get() !== null;
    } catch {
      return false;
    }
  }

  recordWarmSpan(span: Omit<KnowledgeWarmSpan, "id"> & { id?: string }): KnowledgeWarmSpan {
    if (!this.insideWrite) return this.writeBounded(() => this.recordWarmSpan(span));
    this.db.exec("DELETE FROM warm_spans WHERE id NOT IN (SELECT id FROM warm_spans ORDER BY completed_at DESC LIMIT 199)");
    const full: KnowledgeWarmSpan = {
      id: span.id ?? `warm-${randomUUID()}`,
      source: span.source,
      harness: span.harness.trim() || "*",
      lookbackMs: span.lookbackMs,
      cutoffMs: span.cutoffMs,
      completedAt: span.completedAt,
      jobId: span.jobId,
      discovered: span.discovered,
      indexed: span.indexed,
      failed: span.failed,
    };
    this.db.query(
      `INSERT INTO warm_spans (
         id, source, harness, lookback_ms, cutoff_ms, completed_at, job_id, discovered, indexed, failed
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).run(
      full.id,
      full.source,
      full.harness,
      full.lookbackMs,
      full.cutoffMs,
      full.completedAt,
      full.jobId,
      full.discovered,
      full.indexed,
      full.failed,
    );
    return full;
  }

  listWarmSpans(limit = 50): KnowledgeWarmSpan[] {
    if (!this.hasWarmSpansTable()) return [];
    try {
      const rows = this.db.query(
        `SELECT * FROM warm_spans
         ORDER BY completed_at DESC
         LIMIT ?1`,
      ).all(normalizedLimit(limit, 50, 500)) as WarmSpanRow[];
      return rows.map(warmSpanFromRow);
    } catch {
      return [];
    }
  }

  /**
   * Whether an explicit warm-up covers the requested source/harness/lookback.
   * Does not run search — only answers silence vs staleness honesty.
   */
  assessCoverage(request: KnowledgeCoverageRequest = {}): KnowledgeCoverage {
    const source = request.source ?? "sessions";
    const harnesses = normalizeCoverageHarnesses(request.harness);
    const lookbackMs = typeof request.lookbackMs === "number" && Number.isFinite(request.lookbackMs) && request.lookbackMs > 0
      ? Math.floor(request.lookbackMs)
      : undefined;

    let chunks = 0;
    try {
      chunks = (this.db.query("SELECT COUNT(*) AS total FROM chunks").get() as { total: number } | null)?.total ?? 0;
    } catch {
      chunks = 0;
    }
    if (chunks === 0 && this.listWarmSpans(1).length === 0) {
      return {
        kind: "empty_index",
        suggestion: warmSuggestion({ source, harness: harnesses, lookbackMs }),
      };
    }

    try {
      if (chunks > 0 && this.hasStorageState && this.db.query("SELECT 1 FROM storage_state WHERE key='retention_evicted'").get()) {
        return { kind: "bounded", suggestion: "Searching retained history only. Oldest collections were evicted to keep the local index within 256 MiB; no matches does not cover evicted history." };
      }
    } catch { /* legacy read-only schema */ }

    const spans = this.listWarmSpans(200).filter((span) => span.source === source);
    const coversHarness = (span: KnowledgeWarmSpan, harness: string): boolean =>
      span.harness === "*" || span.harness.toLowerCase() === harness.toLowerCase();
    /**
     * A span covers a query window when:
     * - it ingested something (or explicitly scanned an empty root: discovered=0),
     * - its lookback is deep enough for the requested window,
     * - the query window is not entirely after the scan finished (zero-overlap).
     */
    const isViableSpan = (span: KnowledgeWarmSpan): boolean => {
      // All-failed warm (found files but indexed none) is not coverage.
      if (span.discovered > 0 && span.indexed === 0) return false;
      return true;
    };
    const coversLookback = (span: KnowledgeWarmSpan): boolean => {
      if (!isViableSpan(span)) return false;
      if (lookbackMs == null) return true;
      // Depth: span scanned at least as far back as the query requests.
      const deepEnough = span.lookbackMs + 1_000 >= lookbackMs || span.cutoffMs <= nowMs() - lookbackMs;
      if (!deepEnough) return false;
      // Overlap: query window [now-lookback, now] must not lie entirely after completedAt.
      // If age >= lookback, every sourceUpdatedAfterMs-filtered hit is outside the scan.
      return nowMs() - span.completedAt < lookbackMs;
    };
    const staleAfterFor = (span: KnowledgeWarmSpan, requestedLookbackMs: number | undefined): number => {
      if (requestedLookbackMs != null && requestedLookbackMs > 0) {
        return Math.min(KNOWLEDGE_WARM_SPAN_STALE_MS, requestedLookbackMs);
      }
      return Math.min(KNOWLEDGE_WARM_SPAN_STALE_MS, Math.max(span.lookbackMs, 60_000));
    };

    const required = harnesses.length > 0 ? harnesses : ["*"];
    const covering: KnowledgeWarmSpan[] = [];
    const missing: string[] = [];

    for (const requiredHarness of required) {
      const match = spans.find((span) =>
        (requiredHarness === "*"
          ? true
          : coversHarness(span, requiredHarness) || span.harness === "*")
        && coversLookback(span)
      );
      if (match) covering.push(match);
      else if (requiredHarness !== "*") missing.push(requiredHarness);
      else if (!spans.some(coversLookback)) missing.push("*");
    }

    // No harness filter: any covering span for source is enough.
    if (harnesses.length === 0) {
      const any = spans.filter(coversLookback);
      if (any.length === 0) {
        return {
          kind: "not_warmed",
          source,
          harness: [],
          lookbackMs,
          suggestion: warmSuggestion({ source, harness: [], lookbackMs }),
          nearestSpans: spans.slice(0, 5),
        };
      }
      // Weakest link: oldest covering span governs staleness.
      const oldest = [...any].sort((a, b) => a.completedAt - b.completedAt)[0]!;
      const age = nowMs() - oldest.completedAt;
      const staleAfterMs = staleAfterFor(oldest, lookbackMs);
      return {
        kind: "warmed",
        spans: any.slice(0, 8),
        stale: age > staleAfterMs,
        staleAfterMs,
      };
    }

    if (missing.length > 0 || covering.length === 0) {
      return {
        kind: "not_warmed",
        source,
        harness: missing.length > 0 ? missing : harnesses,
        lookbackMs,
        suggestion: warmSuggestion({
          source,
          harness: missing.length > 0 ? missing : harnesses,
          lookbackMs,
        }),
        nearestSpans: spans
          .filter((span) => harnesses.some((h) => coversHarness(span, h)) || span.harness === "*")
          .slice(0, 5),
      };
    }

    // Weakest link among required harnesses.
    const oldest = [...covering].sort((a, b) => a.completedAt - b.completedAt)[0]!;
    const age = nowMs() - oldest.completedAt;
    const staleAfterMs = staleAfterFor(oldest, lookbackMs);
    return {
      kind: "warmed",
      spans: covering,
      stale: age > staleAfterMs,
      staleAfterMs,
    };
  }

  status(): KnowledgeStatus {
    const collectionCounts = this.db.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready
       FROM collections`,
    ).get() as { total: number; ready: number | null } | null;
    const chunkCounts = this.db.query("SELECT COUNT(*) AS total FROM chunks").get() as { total: number } | null;
    let sqliteBytes = 0;
    try {
      sqliteBytes = statSync(this.paths.sqlitePath).size;
    } catch {
      sqliteBytes = 0;
    }
    return {
      enabled: knowledgeIndexEnabled(),
      storage: knowledgeStorageUsage(this.paths),
      generatedAt: nowMs(),
      paths: {
        knowledgeRoot: this.paths.knowledgeRoot,
        qmdRoot: this.paths.qmdRoot,
        sqlitePath: this.paths.sqlitePath,
      },
      collections: collectionCounts?.total ?? 0,
      readyCollections: collectionCounts?.ready ?? 0,
      chunks: chunkCounts?.total ?? 0,
      activeJobs: this.listActiveJobs(),
      sqliteBytes,
      warmSpans: this.listWarmSpans(20),
    };
  }
}
