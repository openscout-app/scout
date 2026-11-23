import { describe, expect, test } from "bun:test";

import {
  parseSessionKnowledgeSearchParams,
  searchSessionKnowledge,
  sessionKnowledgeSearchParams,
  SESSION_SEARCH_MAX_SNIPPET,
} from "./session-search.js";
import type { KnowledgeCoverage, KnowledgeSearchHit, KnowledgeSearchQuery } from "./types.js";

const hit = { id: "h", collectionId: "c", documentId: "d", chunkId: "k", title: "t", snippet: "x".repeat(5000), score: 1,
  facets: {}, sourceRefs: [], drilldown: [] } as unknown as KnowledgeSearchHit;

describe("session knowledge search", () => {
  test("wire params round-trip and refuse out-of-bound values", () => {
    const input = { query: "build steps", harness: ["codex", "claude"], project: "scout", hours: 24, limit: 5, narrowToWarmed: true };
    expect(parseSessionKnowledgeSearchParams(sessionKnowledgeSearchParams(input))).toEqual(input);
    expect(parseSessionKnowledgeSearchParams(new URLSearchParams("q=x"))).toEqual({ query: "x" });
    for (const bad of ["", "q=", `q=${"a".repeat(301)}`, "q=x&limit=21", "q=x&hours=0", "q=x&hours=1.5", "q=x&harness=gpt"]) {
      expect(() => parseSessionKnowledgeSearchParams(new URLSearchParams(bad))).toThrow(TypeError);
    }
  });

  test("does not search an uncovered index", () => {
    const store = {
      assessCoverage: (): KnowledgeCoverage => ({ kind: "empty_index", suggestion: "scout search index" }),
      searchLexical: () => { throw new Error("must not search"); },
    };
    expect(searchSessionKnowledge(store, { query: "x", hours: 24 })).toMatchObject({ hitCount: 0, coverage: { kind: "empty_index" } });
  });

  test("narrows to the warmed window, clips snippets and caps the limit", () => {
    const now = 10 * 3_600_000 * 24;
    const span = { harness: "codex", lookbackMs: 24 * 3_600_000, completedAt: now - 3_600_000, discovered: 2, indexed: 2 };
    const requests: KnowledgeSearchQuery[] = [];
    const store = {
      assessCoverage: ({ lookbackMs }: { lookbackMs?: number }): KnowledgeCoverage => lookbackMs && lookbackMs > span.lookbackMs
        ? { kind: "not_warmed", source: "sessions", harness: [], suggestion: "", nearestSpans: [span as never] }
        : { kind: "warmed", spans: [span as never], stale: false, staleAfterMs: 1 },
      searchLexical: (query: KnowledgeSearchQuery) => { requests.push(query); return Array.from({ length: 30 }, () => hit); },
    };
    const result = searchSessionKnowledge(store, { query: "x", hours: 72, narrowToWarmed: true, limit: 50, now });
    expect(result).toMatchObject({ searchedHours: 24, requestedHours: 72, narrowedToWarmedWindow: true, hitCount: 20 });
    expect(result.hits[0]!.snippet).toHaveLength(SESSION_SEARCH_MAX_SNIPPET);
    expect(requests[0]).toMatchObject({ limit: 20, sourceUpdatedAfterMs: now - 24 * 3_600_000 });
    expect(requests[0]!.facets).toBeUndefined();
  });
});
