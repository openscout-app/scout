import { KNOWLEDGE_INDEX_OFF, knowledgeIndexEnabled } from "./settings.js";
import { SQLiteKnowledgeStore } from "./store.js";
import type { KnowledgeCoverage, KnowledgeSearchHit, KnowledgeWarmSpan } from "./types.js";

/**
 * One bounded lexical query over this host's own session index. The local MCP
 * tool and the mesh route both answer through it, so a peer gets the same
 * coverage semantics as a local caller. It never indexes and never reads a
 * transcript: hits are chunks that an explicit `scout search index` stored.
 */
export const SESSION_SEARCH_MAX_QUERY = 300;
export const SESSION_SEARCH_MAX_LIMIT = 20;
export const SESSION_SEARCH_MAX_HOURS = 720;
export const SESSION_SEARCH_MAX_SNIPPET = 1200;
const SESSION_SEARCH_HARNESSES = ["codex", "claude", "kimi", "antigravity"] as const;

export type SessionKnowledgeSearchInput = {
  query: string;
  harness?: string[];
  project?: string;
  /** Lookback. Undefined searches every indexed span. */
  hours?: number;
  /** Search the widest warmed window when the requested one is not covered. */
  narrowToWarmed?: boolean;
  limit?: number;
  now?: number;
};

export type SessionKnowledgeSearchResult = {
  query: string;
  mode: "lexical";
  coverage: KnowledgeCoverage;
  searchedHours: number | null;
  requestedHours?: number;
  narrowedToWarmedWindow?: true;
  hitCount: number;
  hits: KnowledgeSearchHit[];
};

type SearchStore = Pick<SQLiteKnowledgeStore, "assessCoverage" | "searchLexical">;

/**
 * The largest indexed lookback that still overlaps the query, or null when no
 * viable span remains. assessCoverage verifies the selected window again.
 *
 * A span's reach is bounded by how far back it scanned and how long ago it
 * finished: a 72h scan that completed 80h ago covers nothing a
 * `sourceUpdatedAfterMs` filter would keep.
 */
export function warmedReachMs(spans: readonly KnowledgeWarmSpan[], now: number): number | null {
  let best: number | null = null;
  for (const span of spans) {
    // A scan that found files and indexed none is not coverage.
    if (span.discovered > 0 && span.indexed === 0) continue;
    if (span.lookbackMs <= now - span.completedAt) continue;
    if (best === null || span.lookbackMs > best) best = span.lookbackMs;
  }
  return best;
}

export function summarizeKnowledgeCoverage(coverage: KnowledgeCoverage): KnowledgeCoverage {
  if (coverage.kind === "not_warmed") return { ...coverage, nearestSpans: coverage.nearestSpans.slice(0, 3) };
  if (coverage.kind === "warmed") return { ...coverage, spans: coverage.spans.slice(0, 3) };
  return coverage;
}

export function searchSessionKnowledge(store: SearchStore, input: SessionKnowledgeSearchInput): SessionKnowledgeSearchResult {
  const now = input.now ?? Date.now();
  const harness = input.harness?.length ? input.harness : undefined;
  const limit = Math.min(Math.max(1, input.limit ?? 8), SESSION_SEARCH_MAX_LIMIT);
  const requestedMs = input.hours === undefined ? undefined : input.hours * 3_600_000;
  let coverage = store.assessCoverage({ source: "sessions", harness, lookbackMs: requestedMs });
  let searchedMs = requestedMs;
  let narrowedFromMs: number | null = null;
  if (input.narrowToWarmed && requestedMs !== undefined && coverage.kind === "not_warmed") {
    const reach = warmedReachMs(coverage.nearestSpans, now);
    if (reach !== null && reach < requestedMs) {
      const narrowed = store.assessCoverage({ source: "sessions", harness, lookbackMs: reach });
      if (narrowed.kind === "warmed") {
        coverage = narrowed;
        searchedMs = reach;
        narrowedFromMs = requestedMs;
      }
    }
  }
  coverage = summarizeKnowledgeCoverage(coverage);
  const facets: Record<string, string | string[]> = {};
  if (harness) facets.harness = harness.length === 1 ? harness[0]! : harness;
  if (input.project) facets.project = input.project;
  const hits = coverage.kind === "warmed" || coverage.kind === "bounded"
    ? store.searchLexical({
      q: input.query,
      sourceKinds: ["sessions"],
      ...(Object.keys(facets).length ? { facets } : {}),
      ...(searchedMs === undefined ? {} : { sourceUpdatedAfterMs: now - searchedMs }),
      limit,
    }).slice(0, limit).map((hit) => ({ ...hit, snippet: hit.snippet.slice(0, SESSION_SEARCH_MAX_SNIPPET) }))
    : [];
  return {
    query: input.query,
    mode: "lexical",
    coverage,
    searchedHours: searchedMs === undefined ? null : Math.round(searchedMs / 3_600_000),
    ...(narrowedFromMs === null ? {} : { requestedHours: Math.round(narrowedFromMs / 3_600_000), narrowedToWarmedWindow: true as const }),
    hitCount: hits.length,
    hits,
  };
}

/** Opens this host's index read-only for one query; a missing index stays missing. */
export function searchLocalSessionKnowledge(input: SessionKnowledgeSearchInput): SessionKnowledgeSearchResult {
  if (!knowledgeIndexEnabled()) {
    return { query: input.query, mode: "lexical", coverage: { kind: "index_off", suggestion: KNOWLEDGE_INDEX_OFF },
      searchedHours: input.hours ?? null, hitCount: 0, hits: [] };
  }
  const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
  try {
    return searchSessionKnowledge(store, input);
  } finally {
    store.close();
  }
}

/** Wire form of a peer's query: `GET /v1/mesh/knowledge/search?q=…`. */
export function sessionKnowledgeSearchParams(input: SessionKnowledgeSearchInput): URLSearchParams {
  const params = new URLSearchParams({ q: input.query });
  for (const harness of input.harness ?? []) params.append("harness", harness);
  if (input.project) params.set("project", input.project);
  if (input.hours !== undefined) params.set("hours", String(input.hours));
  if (input.narrowToWarmed) params.set("narrow", "1");
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  return params;
}

/** Strict parse of a peer's query. Throws TypeError on anything out of bounds. */
export function parseSessionKnowledgeSearchParams(params: URLSearchParams): SessionKnowledgeSearchInput {
  const query = params.get("q")?.trim() ?? "";
  if (!query || query.length > SESSION_SEARCH_MAX_QUERY) throw new TypeError(`q must be 1-${SESSION_SEARCH_MAX_QUERY} characters`);
  const harness = params.getAll("harness");
  for (const value of harness) {
    if (!(SESSION_SEARCH_HARNESSES as readonly string[]).includes(value)) throw new TypeError(`unknown harness: ${value}`);
  }
  const project = params.get("project")?.trim() || undefined;
  if (project && project.length > 160) throw new TypeError("project is too long");
  const int = (key: string, max: number): number | undefined => {
    const raw = params.get(key);
    if (raw === null) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new TypeError(`${key} must be an integer from 1 to ${max}`);
    return value;
  };
  return {
    query,
    ...(harness.length ? { harness } : {}),
    ...(project ? { project } : {}),
    ...(params.has("hours") ? { hours: int("hours", SESSION_SEARCH_MAX_HOURS) } : {}),
    ...(params.get("narrow") === "1" ? { narrowToWarmed: true } : {}),
    ...(params.has("limit") ? { limit: int("limit", SESSION_SEARCH_MAX_LIMIT) } : {}),
  };
}
