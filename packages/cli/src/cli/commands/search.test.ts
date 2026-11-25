import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteKnowledgeStore, type KnowledgeSearchHit } from "@openscout/runtime";
import { createScoutCommandContext } from "../context.ts";
import { runSearchCommand } from "./search.ts";

const ENV_KEYS = ["OPENSCOUT_SUPPORT_DIRECTORY", "OPENSCOUT_CONTROL_HOME"] as const;
let originalEnv: Array<string | undefined>;
let root: string;
let coverage: unknown;
let hits: KnowledgeSearchHit[];
let searches: number;
let closes: number;
let requested: Parameters<SQLiteKnowledgeStore["searchLexicalPage"]>[0] | undefined;

beforeEach(() => {
  originalEnv = ENV_KEYS.map((key) => process.env[key]);
  root = mkdtempSync(join(tmpdir(), "scout-search-coverage-"));
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = root;
  process.env.OPENSCOUT_CONTROL_HOME = join(root, "control");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ knowledgeIndexEnabled: true }));
  coverage = { kind: "warmed", spans: [], stale: false, staleAfterMs: 1 };
  hits = [];
  searches = 0;
  closes = 0;
  // Supply both generations of coverage through the real readonly store. These
  // spies are restored after each test; no runtime module is replaced globally.
  spyOn(SQLiteKnowledgeStore.prototype, "assessCoverage").mockImplementation(() => coverage as ReturnType<SQLiteKnowledgeStore["assessCoverage"]>);
  spyOn(SQLiteKnowledgeStore.prototype, "searchLexicalPage").mockImplementation((query) => {
    searches++;
    requested = query;
    return { hits, ftsMode: query.ftsMode ?? "and" };
  });
  const close = SQLiteKnowledgeStore.prototype.close;
  spyOn(SQLiteKnowledgeStore.prototype, "close").mockImplementation(function (this: SQLiteKnowledgeStore) { closes++; close.call(this); });
});

afterEach(() => {
  mock.restore();
  ENV_KEYS.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[index];
  });
  rmSync(root, { recursive: true, force: true });
});

async function query() {
  const lines: string[] = [];
  await runSearchCommand(createScoutCommandContext({ cwd: "/fixture", stdout: (line) => lines.push(line) }), ["query", "needle"]);
  expect(closes).toBe(1);
  return lines.join("\n");
}

test("index_off reports the core's opt-in guidance without querying", async () => {
  coverage = { kind: "index_off", suggestion: "Local search index is off; enable it explicitly." };
  expect(await query()).toContain("Local search index is off; enable it explicitly.");
  expect(searches).toBe(0);
});

test("an explicit core opt-out refuses query, status and index before opening the index", async () => {
  writeFileSync(join(root, "settings.json"), JSON.stringify({ knowledgeIndexEnabled: false }));
  for (const args of [["query", "needle"], ["status"], ["index"]]) {
    const lines: string[] = [];
    await runSearchCommand(createScoutCommandContext({ stdout: (line) => lines.push(line) }), args);
    expect(lines.join("\n")).toContain("Search index is off.");
  }
  expect(searches).toBe(0);
  expect(closes).toBe(0);
});

test("bounded coverage searches retained history without claiming evicted history was covered", async () => {
  coverage = { kind: "bounded", suggestion: "Only retained history is indexed; evicted history is not covered." };
  const text = await query();
  expect(searches).toBe(1);
  expect(text).toContain("Only retained history is indexed; evicted history is not covered.");
  expect(text).toContain("No matching chunks in retained history; evicted history was not searched.");
  expect(text).not.toContain("Warmed for this span");
});

test("empty index keeps the existing warm-up guidance and never queries", async () => {
  coverage = { kind: "empty_index", suggestion: "scout search index" };
  expect(await query()).toContain("Coverage: empty index (never warmed).");
  expect(searches).toBe(0);
});

test("not_warmed keeps facet and lookback guidance and never queries", async () => {
  coverage = { kind: "not_warmed", source: "sessions", harness: ["codex"], lookbackMs: 3_600_000, suggestion: "warm codex", nearestSpans: [] };
  expect(await query()).toContain("Coverage: not warmed for source=sessions harness=codex lookback=1h.");
  expect(searches).toBe(0);
});

test("warmed coverage keeps the existing empty-result wording", async () => {
  const text = await query();
  expect(searches).toBe(1);
  expect(text).toContain("Coverage: warmed.");
  expect(text).toContain("Warmed for this span, but no matching chunks.");
});

test("stale warmed coverage keeps the re-index warning", async () => {
  coverage = { kind: "warmed", spans: [], stale: true, staleAfterMs: 1 };
  expect(await query()).toContain("stale — re-index if you need fresher files");
  expect(searches).toBe(1);
});

test("JSON output preserves a bounded coverage tag and suggestion", async () => {
  coverage = { kind: "bounded", suggestion: "retained history only" };
  const lines: string[] = [];
  await runSearchCommand(createScoutCommandContext({ outputMode: "json", stdout: (line) => lines.push(line) }), ["query", "needle"]);
  expect(JSON.parse(lines.join("\n"))).toMatchObject({ hitCount: 0, hits: [], coverage });
  expect(searches).toBe(1);
  expect(closes).toBe(1);
});

function hit(chunkId: string): KnowledgeSearchHit {
  return {
    id: chunkId,
    collectionId: "sessions/codex/session-1",
    documentId: "doc-session-1-overview",
    chunkId,
    title: "Session 1",
    snippet: "a matching passage",
    score: 1,
    scoreSource: "fts",
    origin: "mechanical",
    ownership: "derived",
    freshness: "fresh",
    sourceRefs: [],
    drilldown: [],
    facets: { harness: "codex" },
  };
}

async function queryJson(args: string[] = []) {
  const lines: string[] = [];
  await runSearchCommand(createScoutCommandContext({ outputMode: "json", stdout: (line) => lines.push(line) }), ["query", "needle", ...args]);
  return JSON.parse(lines.join("\n")) as { next: string | null; hitCount: number };
}

test("a full page prints a token that continues at the next offset", async () => {
  hits = [hit("chunk-1"), hit("chunk-2")];
  const first = await queryJson(["--limit", "2"]);
  expect(first.hitCount).toBe(2);
  expect(first.next).toBeString();
  expect(requested?.offset).toBeUndefined();

  hits = [hit("chunk-3")];
  const second = await queryJson(["--limit", "2", "--after", first.next!]);
  expect(second.hitCount).toBe(1);
  expect(second.next).toBeNull();
  expect(requested).toMatchObject({ offset: 2, ftsMode: "and", limit: 2 });
});

test("a page token is refused by a different query or window", async () => {
  hits = [hit("chunk-1"), hit("chunk-2")];
  const first = await queryJson(["--limit", "2"]);
  await expect(queryJson(["--limit", "2", "--after", first.next!, "--days", "7"]))
    .rejects.toThrow("That page token belongs to another search.");
  expect(searches).toBe(1);

  const other: string[] = [];
  await expect(runSearchCommand(
    createScoutCommandContext({ outputMode: "json", stdout: (line) => other.push(line) }),
    ["query", "different", "--limit", "2", "--after", first.next!],
  )).rejects.toThrow("That page token belongs to another search.");
});

test("a continuation with no further matches says so instead of blaming coverage", async () => {
  hits = [hit("chunk-1"), hit("chunk-2")];
  const first = await queryJson(["--limit", "2"]);
  hits = [];
  const lines: string[] = [];
  await runSearchCommand(createScoutCommandContext({ stdout: (line) => lines.push(line) }), ["query", "needle", "--limit", "2", "--after", first.next!]);
  expect(lines.join("\n")).toContain("No more matches in this window.");
});
