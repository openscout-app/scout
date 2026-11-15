import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ftsRowidForChunk } from "../knowledge/chunk-fts-rowid.js";
import { openRuntimeSqliteDatabase } from "../sqlite-adapter.js";
import { RoutingStore, ROUTE_EXTRACTOR_VERSION, ROUTE_SOURCE_TERM_LIMIT } from "./store.js";
import { RoutingChunks } from "./chunks.js";
import { extractTerms, scoreRouteName, words } from "./text.js";
import { parseRouteQuery, resolveRoute } from "./resolve.js";
import { projectCanonicalizer, projectId } from "./identity.js";
import { mineRoutingGold, refreshRoutingIndex, type RoutingSnapshot } from "./refresh.js";
import { readRoutingBrokerSource, type RoutingRead } from "./broker-source.js";
import { evaluateRouting } from "./eval.js";
import type { RouteTarget } from "./types.js";

const NOW = 1_800_000_000_000;
const cleanup: (() => void)[] = [];
beforeEach(() => {
  const previous = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  const support = temp();
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = support;
  writeFileSync(join(support, "settings.json"), JSON.stringify({ knowledgeIndexEnabled: true }));
  cleanup.push(() => { if (previous === undefined) delete process.env.OPENSCOUT_SUPPORT_DIRECTORY; else process.env.OPENSCOUT_SUPPORT_DIRECTORY = previous; });
});
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function temp() { const p = mkdtempSync(join(tmpdir(), "scout-routing-test-")); cleanup.push(() => rmSync(p, { recursive: true, force: true })); return p; }
function store() { const s = new RoutingStore(":memory:"); cleanup.push(() => s.close()); return s; }
function target(root: string, names = [root.split("/").at(-1)!]): RouteTarget {
  return { id: projectId("mini", root), kind: "project", projectRoot: root, nodeId: "mini", projectKey: null, agentId: null, sessionId: null, harness: null, names };
}
function doc(s: RoutingStore, t: RouteTarget, body = "", field: "stable" | "recent" = "stable") {
  s.putTarget(t, NOW);
  s.putEvidence({ key: `fixture:${t.id}`, targetId: t.id, hash: body, terms: extractTerms(body, field, NOW) });
  s.finish(NOW);
  s.setMeta("machines", [{ id: "mini", names: ["Arts Mac mini", "arts-mini.local"] }]);
  s.setMeta("nodeId", "mini");
  s.setMeta("indexedAt", NOW);
}
function snapshot(root: string): RoutingSnapshot {
  return { nodes: {}, agents: { a: { id: "a", displayName: "builder", handle: "builder", kind: "agent", definitionId: "d", agentClass: "worker", capabilities: [], wakePolicy: "manual", homeNodeId: "mini", authorityNodeId: "mini", advertiseScope: "local", metadata: { projectRoot: root } } }, endpoints: {}, messages: {}, invocations: {} } as RoutingSnapshot;
}
function chunksFixture(entries: { collection: string; text: string; time?: number }[]) {
  const path = join(temp(), "knowledge.sqlite");
  const db = openRuntimeSqliteDatabase(path, { create: true });
  db.exec(`CREATE TABLE collections (id TEXT PRIMARY KEY, kind TEXT, title TEXT, content_hash TEXT, facets_json TEXT, source_refs_json TEXT, updated_at INTEGER);
    CREATE TABLE chunks (id TEXT PRIMARY KEY,collection_id TEXT,text TEXT,facets_json TEXT,source_refs_json TEXT,ordinal INTEGER,text_hash TEXT);
    CREATE INDEX chunks_col ON chunks(collection_id);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED,collection_id UNINDEXED,body); BEGIN;`);
  entries.forEach((entry, i) => {
    const refs = JSON.stringify([{ anchor: { mtimeMs: entry.time ?? NOW } }]);
    const facets = JSON.stringify({ projectPath: `/repos/${entry.collection}`, sessionId: entry.collection, harness: "codex" });
    db.query("INSERT OR IGNORE INTO collections VALUES (?,'sessions',?,?,?,?,?)").run(entry.collection, entry.collection, "hash", facets, refs, NOW);
    db.query("INSERT INTO chunks VALUES (?,?,?,?,?,?,?)").run(String(i), entry.collection, entry.text, facets, refs, i, createHash("sha256").update(entry.text).digest("hex"));
    db.query("INSERT INTO chunks_fts(rowid,chunk_id,collection_id,body) VALUES (?,?,?,?)").run(ftsRowidForChunk(String(i)), String(i), entry.collection, entry.text);
  });
  db.exec("COMMIT"); db.close?.();
  const reader = new RoutingChunks(path, true); cleanup.push(() => reader.close());
  return { reader, path };
}

describe("routing lexical index", () => {
  test("live discovery scope applies before the shortlist cap and fails closed for no nodes", () => {
    const s = store();
    for (let i = 0; i < 5; i++) doc(s, target(`/repo/${i}`, ["permissions"]));
    const selected = resolveRoute(s, "permissions", { nodeIds: ["mini"], projectRoot: "/repo/4" });
    expect(selected.candidates.map((c) => c.target.projectRoot)).toEqual(["/repo/4"]);
    expect(selected.coverage.scopedTargets).toBe(1);
    expect(resolveRoute(s, "permissions", { nodeIds: [] }).candidates).toEqual([]);
  });
  test("empty index returns none and coverage, without a broker or invented targets", () => {
    const result = resolveRoute(store(), "companion", { signals: ["S0", "S1"], now: NOW });
    expect(result.outcome).toBe("none"); expect(result.coverage.targets).toBe(0);
    expect(result.coverage.peerDigests).toEqual([]); expect(result.coverage.indexedAt).toBeNull();
  });
  test("sparse project is routable by name but gets no invented topic", () => {
    const s = store(); doc(s, target("/repo/empty"));
    expect(resolveRoute(s, "empty").outcome).toBe("resolved");
    expect(resolveRoute(s, "giraffe", { signals: ["S0", "S1"] }).outcome).toBe("none");
    expect(s.terms(target("/repo/empty").id)).toEqual([]);
    doc(s, target("/repo/test"));
    expect(resolveRoute(s, "test").outcome).toBe("resolved"); // stoplists must not erase exact names
  });
  test("same basename in two roots returns candidates, exact paths disambiguate", () => {
    const s = store(); doc(s, target("/one/scout", ["scout", "/one/scout"]), "voice"); doc(s, target("/two/scout", ["scout", "/two/scout"]), "unrelated");
    const tie = resolveRoute(s, "scout"); expect(tie.outcome).toBe("candidates"); expect(tie.candidates).toHaveLength(2);
    expect(resolveRoute(s, "/two/scout").outcome).toBe("resolved");
  });
  test("machine-only, unknown machine, and conflicting machine constraints never score", () => {
    const s = store(); doc(s, target("/repo/mini-music"), "music piano");
    for (const query of ["on mini"]) {
      expect(resolveRoute(s, query).outcome).toBe("none"); expect(resolveRoute(s, query).candidates).toEqual([]);
    }
    expect(resolveRoute(s, "mini-music", { machine: "unknown" }).coverage.scopedTargets).toBe(0);
    expect(parseRouteQuery("music on mini", [{ id: "a", names: ["mini"] }, { id: "b", names: ["mini"] }], {}).selected).toEqual(["a", "b"]);
    expect(parseRouteQuery("music on mini", [{ id: "a", names: ["mini"] }, { id: "b", names: ["other"] }], { machine: "b" }).selected).toEqual([]);
  });
  test("identity matcher follows the existing exact/prefix/token-prefix/substring ladder", () => {
    expect([scoreRouteName("foo", "foo"), scoreRouteName("foobar", "foo"), scoreRouteName("x.foo", "foo"), scoreRouteName("xfoobar", "foo")]).toEqual([900, 700, 500, 300]);
    expect(words("ScoutCompanionController.swift snake_case kebab-case fix bun test")).toContain("companion");
    expect(extractTerms("render queue render queue", "stable", NOW).some((t) => t.term === "render queue")).toBe(true);
  });
  test("S1 correctly inverts negative bm25; recent decay is query-time only", () => {
    const s = store(); const a = target("/repo/a"), b = target("/repo/b");
    doc(s, a, "quartz aurora", "recent"); doc(s, b, "bananas pears");
    const before = s.db.query("SELECT source_hash,updated_at FROM route_targets WHERE id=?").get(a.id);
    const fresh = resolveRoute(s, "quartz aurora", { signals: ["S1"], now: NOW });
    const stale = resolveRoute(s, "quartz aurora", { signals: ["S1"], now: NOW + 12 * 86_400_000 });
    expect(fresh.candidates[0]?.target.id).toBe(a.id);
    expect(fresh.candidates[0]!.signals.S1!.score).toBeGreaterThan(0);
    expect(stale.candidates[0]!.signals.S1!.score).toBeCloseTo(fresh.candidates[0]!.signals.S1!.score / 16, 9);
    expect(s.db.query("SELECT source_hash,updated_at FROM route_targets WHERE id=?").get(a.id)).toEqual(before);
  });
  test("feedback validates actual choices and survives full rebuild", () => {
    const s = store(); const a = target("/repo/a"), b = target("/repo/b"); doc(s, a); doc(s, b);
    s.feedback({ query: "music", chosenTarget: a.id, outcome: "corrected", correctedTo: b.id }, NOW);
    expect(() => s.feedback({ query: "music", outcome: "used" })).toThrow();
    expect(() => s.feedback({ query: "music", chosenTarget: "missing", outcome: "used" })).toThrow();
    s.reset(); expect(s.db.query<{ n: number }>("SELECT count(*) AS n FROM route_feedback").get()!.n).toBe(1);
  });
  test("schema contains no live status and input hash doesn't change on a no-op", () => {
    const s = store(); const t = target("/repo/a"); doc(s, t, "companion figures");
    const before = s.db.query("SELECT * FROM route_targets").all();
    doc(s, t, "companion figures"); expect(s.db.query("SELECT * FROM route_targets").all()).toEqual(before);
    const columns = s.db.query<{ name: string }>("PRAGMA table_info(route_targets)").all().map((r) => r.name);
    for (const forbidden of ["status", "state", "lastSeenAt", "online", "activity"]) expect(columns).not.toContain(forbidden);
  });
  test("source cache is bounded and updates counts by replacement, not accumulation", () => {
    const s = store(); const t = target("/repo/a"); doc(s, t);
    const terms = Array.from({ length: 10_000 }, (_, i) => ({ term: `term${i}`, field: "stable" as const, weight: 1, lastUsedAt: NOW }));
    s.putEvidence({ key: "large", targetId: t.id, hash: "first", terms }); s.finish(NOW);
    expect(s.terms(t.id, false)).toHaveLength(ROUTE_SOURCE_TERM_LIMIT);
    s.putEvidence({ key: "large", targetId: t.id, hash: "second", terms: [{ term: "replacement", field: "stable", weight: 2, lastUsedAt: NOW }] }); s.finish(NOW);
    expect(s.terms(t.id, false)).toEqual([{ term: "replacement", field: "stable", weight: 2, lastUsedAt: NOW }]);
  });
  test("transaction preserves original failure if SQLite has already rolled back", () => {
    const s = store();
    expect(() => s.transaction(() => { s.db.exec("ROLLBACK"); throw new Error("original failure"); })).toThrow("original failure");
  });
  test("agents are scored inside the winning project, not by another project's text", () => {
    const s = store(); const a = target("/repo/a"), b = target("/repo/b");
    doc(s, a, "quartz aurora"); doc(s, b, "piano bananas");
    doc(s, { ...a, id: "agent:a", kind: "agent", names: ["builder-a"], agentId: "a" }, "quartz aurora");
    doc(s, { ...b, id: "agent:b", kind: "agent", names: ["builder-b"], agentId: "b" }, "quartz piano");
    const result = resolveRoute(s, "quartz aurora", { kind: "agent", signals: ["S0", "S1"] });
    expect(result.candidates[0]?.target.id).toBe("agent:a");
    expect(resolveRoute(s, "builder-b", { kind: "agent" }).outcome).toBe("resolved");
  });
});

describe("chunk fallback and refresh", () => {
  test("per-target top-k defeats global-100 starvation and duplicate floods", () => {
    const entries = Array.from({ length: 12_000 }, (_, i) => ({ collection: "chatty", text: i < 11_900 ? "rareidentifier duplicate" : `rareidentifier distinct topic ${i}` }));
    entries.push({ collection: "quiet", text: "rareidentifier unique" });
    const { reader } = chunksFixture(entries);
    const votes = reader.votes("rareidentifier", [
      { collectionId: "chatty", projectId: "p1", sessionId: null, agentId: null },
      { collectionId: "quiet", projectId: "p2", sessionId: null, agentId: null },
    ], new Set(["p1", "p2"]), NOW);
    expect(votes.size).toBe(2); expect(votes.get("p2")!.score).toBeGreaterThan(0);
    expect(votes.get("p1")!.score).toBeLessThan(votes.get("p2")!.score * 20);
  });
  test("S2 alone resolves a clear winner without a fingerprint gate", () => {
    const { reader } = chunksFixture([{ collection: "a", text: "NSSupportsAutomaticTermination" }]);
    const s = store(); const a = target("/repo/a"); doc(s, a);
    s.putMapping({ collectionId: "a", projectId: a.id, sessionId: null, agentId: null });
    const result = resolveRoute(s, "NSSupportsAutomaticTermination", { signals: ["S2"], now: NOW }, reader);
    expect(result.outcome).toBe("resolved"); expect(result.candidates[0]?.target.id).toBe(a.id);
  });
  test("explicit refresh cursors skip unchanged chunks, replacement removes old terms", () => {
    const { reader, path } = chunksFixture([{ collection: "a", text: "oldtopic" }]);
    const s = store(); const input = { node: { id: "mini", name: "mini", hostName: "mini" }, snapshot: snapshot("/not-real/empty"), chunks: reader, now: NOW };
    expect(refreshRoutingIndex(s, input).chunkCollectionsRead).toBe(1);
    expect(refreshRoutingIndex(s, { ...input, now: NOW + 86_400_000 }).chunkCollectionsRead).toBe(0);
    const db = openRuntimeSqliteDatabase(path);
    db.query("UPDATE chunks SET text='newtopic'").run(); db.query("UPDATE collections SET content_hash='changed'").run(); db.close?.();
    expect(refreshRoutingIndex(s, input).chunkCollectionsRead).toBe(1);
    const terms = s.terms(projectId("mini", "/repos/a"), false).map((t) => t.term);
    expect(terms).toContain("newtopic"); expect(terms).not.toContain("oldtopic");
  });
  test("cached S2 identity/signature lookup does not read chunk bodies at query time", () => {
    const { reader, path } = chunksFixture([{ collection: "a", text: "rareidentifier\n" + "payload ".repeat(16_000) }]);
    reader.useCachedKeys(reader.keys());
    const db = openRuntimeSqliteDatabase(path); db.exec("DROP TABLE chunks"); db.close?.();
    const votes = reader.votes("rareidentifier", [{ collectionId: "a", projectId: "p", sessionId: null, agentId: null }], new Set(["p"]), NOW);
    expect(votes.get("p")?.terms).toContain("rareidentifier");
    expect(votes.get("p")!.score).toBeGreaterThan(0);
  });
  test("git cursor recovers from rewrite/missing object and tracks changed paths", () => {
    const root = temp(); const run = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    run("init"); run("config", "user.email", "test@example.invalid"); run("config", "user.name", "Test");
    writeFileSync(join(root, "ScoutCompanionController.swift"), "// hello\n"); run("add", "."); run("commit", "-m", "Build floating figures");
    const s = store(); const reader = new RoutingChunks(join(root, "absent.sqlite")); cleanup.push(() => reader.close());
    const input = { node: { id: "mini", name: "mini", hostName: "mini" }, snapshot: snapshot(root), chunks: reader, now: NOW };
    refreshRoutingIndex(s, input);
    const canonical = projectCanonicalizer()(root)!;
    const id = projectId("mini", canonical);
    expect(s.terms(id, false).map((t) => t.term)).toContain("companion");
    s.setCursor(`git:${id}`, "deadbeef");
    expect(refreshRoutingIndex(s, input).warnings.some((w) => w.includes("stale git cursor"))).toBe(true);
    expect(s.cursor(`git:${id}`, "")).toBe(run("rev-parse", "HEAD").toString().trim());
  });
  test("broker source resets a future cursor and commits it only after successful refresh", async () => {
    const s = store(); s.setMeta("extractor", ROUTE_EXTRACTOR_VERSION); s.setCursor("broker", Date.now() + 100_000);
    const paths: string[] = [];
    const read = (async (path: string) => { paths.push(path); return path === "/v1/node" ? { id: "mini", name: "mini" } : path.startsWith("/v1/aliases") ? { bindings: [] } : snapshot("/repo/a"); }) as RoutingRead;
    const result = await readRoutingBrokerSource(s, "unused", false, read);
    expect(paths).toContain("/v1/snapshot"); expect(result.full).toBe(true);
    expect(s.cursor("broker", 0)).toBeGreaterThan(Date.now());
    expect(result.warnings).toContain("Reset stale broker cursor");
  });
  test("mines ask prompts by explicit resolved target, not mentions or same basename", () => {
    const snap = snapshot("/one/scout");
    snap.invocations.i = { id: "i", targetAgentId: "a", task: "please repair delivery", createdAt: NOW, metadata: { source: "scout-cli" } } as never;
    snap.invocations.remote = { id: "remote", targetAgentId: "a", targetNodeId: "elsewhere", task: "please repair delivery", createdAt: NOW, metadata: { source: "scout-cli" } } as never;
    const gold = mineRoutingGold(snap, "mini"); expect(gold).toHaveLength(1); expect(gold[0]?.projectRoot).toBe("/one/scout");
    const s = store(); doc(s, target("/one/scout"));
    const evaluated = evaluateRouting(s, [{ id: "a", source: "B", query: "scout", projectRoot: "/one/scout" }], { chunks: new RoutingChunks(join(temp(), "missing")) });
    expect(evaluated[0]!.top1).toBe(1); expect(evaluated[0]!.wrongResolved).toBe(0); expect(evaluated).toHaveLength(5);
  });
  test("cardless asks are indexed and mined as session-owned work, not missing agents", () => {
    const root = temp(); const snap = snapshot(root); snap.agents = {};
    snap.endpoints.e = { id: "e", agentId: "cardless", nodeId: "mini", projectRoot: root, sessionId: "broker-session", harness: "codex", metadata: { externalSessionId: "native-session", displayName: "Named session" } } as never;
    snap.invocations.i = { id: "i", targetAgentId: "cardless", task: "quartz aurora displays", createdAt: NOW, metadata: { source: "scout-mcp" } } as never;
    snap.invocations.mobile = { ...snap.invocations.i, id: "mobile", metadata: { source: "scout-mobile" } } as never;
    expect(mineRoutingGold(snap, "mini")).toHaveLength(1);
    const s = store(); const reader = new RoutingChunks(join(root, "missing")); cleanup.push(() => reader.close());
    refreshRoutingIndex(s, { node: { id: "mini", name: "mini" }, snapshot: snap, chunks: reader, now: NOW });
    expect(s.targets().filter((t) => t.kind === "agent")).toHaveLength(0);
    const result = resolveRoute(s, "Named session", { kind: "session" });
    expect(result.outcome).toBe("resolved");
    expect(s.terms(projectId("mini", projectCanonicalizer()(root)!)).map((t) => t.term)).toContain("quartz");
  });
  test("an exact source reappearing after deletion invalidates its stale cursor", () => {
    const { reader } = chunksFixture([{ collection: "a", text: "phoenix" }]); const s = store();
    const input = { node: { id: "mini", name: "mini" }, snapshot: snapshot("/not-real/sparse"), chunks: reader, now: NOW };
    refreshRoutingIndex(s, input);
    s.transaction(() => { s.removeSources("chunks:"); s.finish(NOW); });
    expect(refreshRoutingIndex(s, input).chunkCollectionsRead).toBe(1);
    expect(s.terms(projectId("mini", "/repos/a")).map((t) => t.term)).toContain("phoenix");
  });
  test("removed aliases disappear on refresh, including project aliases", () => {
    const root = temp(); const s = store(); const reader = new RoutingChunks(join(root, "missing")); cleanup.push(() => reader.close());
    const input = { node: { id: "mini", name: "mini" }, snapshot: snapshot(root), chunks: reader, now: NOW };
    const alias = { alias: "the hex", scopeNodeId: "mini", state: "active", target: { kind: "agent", agentId: "a" } } as never;
    refreshRoutingIndex(s, { ...input, aliases: [alias] }); expect(resolveRoute(s, "the hex").outcome).toBe("resolved");
    refreshRoutingIndex(s, { ...input, aliases: [] });
    expect(resolveRoute(s, "the hex", { signals: ["S0"] }).outcome).toBe("none");
  });
  test("session chunk-only queries first use project fallback, then narrow sessions", () => {
    const { reader } = chunksFixture([{ collection: "a", text: "unusualidentifier" }]); const s = store();
    refreshRoutingIndex(s, { node: { id: "mini", name: "mini" }, snapshot: snapshot("/not-real/sparse"), chunks: reader, now: NOW });
    const result = resolveRoute(s, "unusualidentifier", { kind: "session", signals: ["S2"] }, reader);
    expect(result.outcome).toBe("resolved"); expect(result.candidates[0]?.target.kind).toBe("session");
  });
});

describe("shortlist and fingerprint regressions", () => {
  test("does not remove machine, kind, harness, or time words from literal project names", () => {
    const s = store();
    for (const name of ["world week", "the codex one", "agent layer", "work on hex", "mini music", "on hex"]) {
      doc(s, target(`/repo/${name}`, [name]));
      expect(resolveRoute(s, name, { signals: ["S0"] }).outcome).toBe("resolved");
      expect(parseRouteQuery(name, [{ id: "mini", names: ["mini"] }], {}).topic).toBe(name);
    }
    expect(parseRouteQuery("music on mini", [{ id: "mini", names: ["mini"] }], {}).topic).toBe("music");
    expect(parseRouteQuery("music on mini extra", [{ id: "mini", names: ["mini"] }], {}).topic).toBe("music on mini extra");
  });
  test("scores and returns at most three candidates, including exact-name ties", () => {
    const s = store();
    for (let i = 0; i < 8; i++) doc(s, target(`/repo/${i}`, ["same"]));
    const r = resolveRoute(s, "same");
    expect(r.outcome).toBe("candidates"); expect(r.candidates).toHaveLength(3);
    expect(r.candidates.every((c) => c.score === 1)).toBe(true);
  });
  test("chunk evidence beats a confident but off-topic fingerprint, without fallback gating", () => {
    const { reader } = chunksFixture([{ collection: "a", text: "quartz aurora" }]);
    const s = store(); const a = target("/repo/a"), b = target("/repo/b");
    doc(s, a); doc(s, b, "quartz aurora");
    s.putMapping({ collectionId: "a", projectId: a.id, sessionId: null, agentId: null });
    const result = resolveRoute(s, "quartz aurora", { now: NOW }, reader);
    expect(result.candidates[0]?.target.id).toBe(a.id);
    expect(result.candidates[0]?.signals.S2?.contribution).toBeGreaterThan(result.candidates[1]!.signals.S1!.contribution);
    expect(result.outcome).toBe("resolved");
  });
  test("fingerprints keep topic nouns rather than UUIDs, path prefixes, or repeated synthetic pairs", () => {
    const noise = "/Users/guest/dev/project/a2eeb692-d62d-4dd6-b253-ed87146819f8/scratchpad/ScoutCompanionController.swift\n";
    const terms = extractTerms(noise.repeat(200) + "world week\ncharacters\nrender queue render queue\n", "stable", NOW);
    const tokens = terms.map((t) => t.term);
    for (const token of ["companion", "week", "characters", "render queue"]) expect(tokens).toContain(token);
    for (const token of ["users", "guest", "scratchpad", "a2eeb692", "d62d", "ed87146819f8", "swift"]) expect(tokens).not.toContain(token);
    expect(terms.every((t) => t.weight <= 4)).toBe(true);
    const s = store(); const t = target("/repo/a"); doc(s, t, noise.repeat(200) + "world week characters");
    expect(s.terms(t.id).map((t) => t.term)).toContain("characters");
  });
  test("recent selection reserves room for new vocabulary without wall-clock rebuilds", () => {
    const s = store(); const t = target("/repo/a"); doc(s, t);
    for (let i = 0; i < 10; i++) s.putEvidence({ key: `old-${i}`, targetId: t.id, hash: "old", terms: Array.from({ length: 128 }, (_, j) => ({ term: `older${j}`, field: "recent", lastUsedAt: NOW - 86400000, weight: 8 })) });
    s.putEvidence({ key: "new", targetId: t.id, hash: "new", terms: extractTerms("characters hex", "recent", NOW) });
    s.finish(NOW);
    expect(s.terms(t.id).map((t) => t.term)).toContain("hex");
  });
  test("S1 sampling covers session beginnings as well as endings", () => {
    const entries = Array.from({ length: 70 }, (_, i) => ({ collection: "a", text: i === 0 ? "earlytopic" : i === 69 ? "latetopic" : `body ${i}` }));
    const { reader } = chunksFixture(entries);
    const sample = reader.chunks("a"); expect(sample).toHaveLength(28);
    expect(sample.map((c) => c.text)).toContain("earlytopic");
    expect(sample.map((c) => c.text)).toContain("latetopic");
  });
});

test("session chronology uses source event ranges, not per-document ordinals", () => {
  const entries = Array.from({ length: 70 }, (_, i) => ({ collection: "a", text: `event${i}` }));
  const { reader, path } = chunksFixture(entries);
  const db = openRuntimeSqliteDatabase(path);
  db.query("UPDATE chunks SET ordinal=0,source_refs_json=json_array(json_object('recordRange',json_array(CAST(id AS INT)*40,CAST(id AS INT)*40+39)))").run();
  db.close?.();
  const texts = reader.chunks("a").map((c) => c.text);
  expect(texts).toContain("event69"); expect(texts).toContain("event0"); expect(texts).not.toContain("event30");
});

test("old fingerprint versions request explicit refresh, never rebuild during a query", () => {
  const s = store(); doc(s, target("/repo/known")); s.setMeta("extractor", "routing-p1-v4");
  const result = resolveRoute(s, "known");
  expect(result.coverage.warnings.some((w) => w.includes("run scout where index"))).toBe(true);
  expect(s.meta("extractor", "")).toBe("routing-p1-v4");
});

test("index off suppresses cached exact/fingerprint routing and refresh mutations", () => {
  const s = store(); doc(s, target("/repo/needle"), "needle");
  writeFileSync(join(process.env.OPENSCOUT_SUPPORT_DIRECTORY!, "settings.json"), "{}");
  const result = resolveRoute(s, "needle");
  expect(result.outcome).toBe("none"); expect(result.candidates).toEqual([]);
  expect(result.reason).toContain("Settings › System");
  expect(refreshRoutingIndex(s, { node: { id: "mini", name: "mini" }, snapshot: snapshot("/new") }).mode).toBe("off");
  expect(s.targets()).toHaveLength(1);
});
