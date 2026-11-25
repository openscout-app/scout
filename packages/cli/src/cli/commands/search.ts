import {
  indexRecentSessionKnowledge,
  knowledgeIndexEnabled, KNOWLEDGE_INDEX_OFF, disabledKnowledgeStatus,
  SQLiteKnowledgeStore,
  type KnowledgeCoverage,
  type KnowledgeSearchHit,
  type KnowledgeStatus,
  type KnowledgeWarmSpan,
} from "@openscout/runtime";

import { searchSessionsOnMachine } from "../../lib/core/mesh/session-search.ts";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

const SEARCH_HELP = `scout search — explicit harness-session knowledge index and query

Indexing is explicit (not ambient). Warm a span, then query the built FTS index.

Usage:
  scout search status
  scout search index [--source sessions] [--days N | --hours N] [--harness <id>] [--limit N] [--force]
  scout search query <text> [--harness <id>] [--project <name>] [--limit N] [--hours N | --days N] [--on <host>]

Options:
  --source sessions     Only sessions is implemented for the first product slice
  --days N              Lookback window in days (default 3 for index)
  --hours N             Lookback window in hours (overrides --days)
  --harness <id>        Filter by harness (codex, claude, kimi, antigravity). Repeatable.
  --project <name>      Query facet filter on project basename
  --limit N             Index discovery cap or query hit limit
  --on <host>           Run the query on another host in this mesh, over that
                        host's own index (scout hosts lists them; use the node
                        id when a name matches more than one)
  --force               Re-index even when content hash matches

Examples:
  scout search index --source sessions --harness kimi --hours 12
  scout search status
  scout search query "iOS build steps" --harness kimi --hours 12
  scout search query xcodebuild --harness kimi --project openscout --json
  scout search query "release notes" --on build-host-openscout --days 7
`;

function takeFlagValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index]!;
  if (current.startsWith(`${flag}=`)) {
    return { value: current.slice(flag.length + 1), nextIndex: index };
  }
  const next = args[index + 1];
  if (!next || next.startsWith("-")) {
    throw new ScoutCliError(`missing value for ${flag}`);
  }
  return { value: next, nextIndex: index + 1 };
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScoutCliError(`invalid ${flag}: ${raw}`);
  }
  return value;
}

function parseHarnessList(args: string[]): { harness: string[]; rest: string[] } {
  const harness: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i]!;
    if (current === "--harness" || current.startsWith("--harness=")) {
      const taken = takeFlagValue(args, i, "--harness");
      harness.push(taken.value);
      i = taken.nextIndex;
      continue;
    }
    rest.push(current);
  }
  return { harness, rest };
}

function formatLookbackShort(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours > 0 && hours % 24 === 0) return `${hours / 24}d`;
  if (hours > 0) return `${hours}h`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes}m`;
}

function formatWarmSpan(span: KnowledgeWarmSpan): string {
  const when = new Date(span.completedAt).toLocaleString();
  return `${span.harness} ${formatLookbackShort(span.lookbackMs)} @ ${when} (indexed=${span.indexed} failed=${span.failed})`;
}

function formatStatus(status: KnowledgeStatus): string {
  if (status.enabled === false) return status.message ?? KNOWLEDGE_INDEX_OFF;
  const lines = [
    "Knowledge search status",
    `  collections: ${status.readyCollections}/${status.collections} ready`,
    `  chunks:      ${status.chunks}`,
    `  sqlite:      ${status.paths.sqlitePath} (${status.sqliteBytes} bytes)`,
    `  qmd:         ${status.paths.qmdRoot}`,
  ];
  if (status.activeJobs.length > 0) {
    lines.push("  active jobs:");
    for (const job of status.activeJobs) {
      const progress = job.progress;
      lines.push(
        `    ${job.id} ${job.state} discovered=${progress.discovered ?? 0} indexed=${progress.indexed ?? 0} failed=${progress.failed ?? 0}`,
      );
    }
  } else {
    lines.push("  active jobs: none");
  }
  const spans = status.warmSpans ?? [];
  if (spans.length > 0) {
    lines.push("  warm spans (explicit):");
    for (const span of spans.slice(0, 12)) {
      lines.push(`    ${formatWarmSpan(span)}`);
    }
  } else {
    lines.push("  warm spans: none (run scout search index …)");
  }
  return lines.join("\n");
}

function formatCoverageNote(coverage: KnowledgeCoverage): string[] {
  if (coverage.kind === "index_off" || coverage.kind === "bounded") return [coverage.suggestion];
  if (coverage.kind === "empty_index") {
    return [
      "Coverage: empty index (never warmed).",
      `  Warm up: ${coverage.suggestion}`,
    ];
  }
  if (coverage.kind === "not_warmed") {
    const harness = coverage.harness.length > 0 ? coverage.harness.join(",") : "any";
    const lines = [
      `Coverage: not warmed for source=${coverage.source} harness=${harness}${
        coverage.lookbackMs != null ? ` lookback=${formatLookbackShort(coverage.lookbackMs)}` : ""
      }.`,
      `  Warm up: ${coverage.suggestion}`,
    ];
    if (coverage.nearestSpans.length > 0) {
      lines.push("  Nearest warm spans:");
      for (const span of coverage.nearestSpans.slice(0, 3)) {
        lines.push(`    ${formatWarmSpan(span)}`);
      }
    }
    return lines;
  }
  const newest = coverage.spans[0];
  const lines = [
    `Coverage: warmed${coverage.stale ? " (stale — re-index if you need fresher files)" : ""}.`,
  ];
  if (newest) {
    lines.push(`  Last cover: ${formatWarmSpan(newest)}`);
  }
  return lines;
}

function resolvePortablePath(path: KnowledgeSearchHit["sourceRefs"][number]): string | null {
  if (!("path" in path) || !path.path) return null;
  const portable = path.path;
  if (portable.root === "ABSOLUTE") return portable.relPath;
  if (portable.root === "HOME") return `~/${portable.relPath}`;
  return `${portable.root}/${portable.relPath}`;
}

function formatHit(hit: KnowledgeSearchHit, index: number): string {
  const harness = facetValue(hit.facets, "harness") ?? "?";
  const project = facetValue(hit.facets, "project") ?? "?";
  const sessionId = facetValue(hit.facets, "sessionId");
  const transcript = hit.sourceRefs
    .map((ref) => (ref.kind === "harness_transcript" ? resolvePortablePath(ref) : null))
    .find((value): value is string => Boolean(value));
  const docKind = facetValue(hit.facets, "documentKind");
  const lines = [
    `${index + 1}. [${harness}/${project}] ${hit.title}`,
    `   score=${hit.score.toFixed(3)}${docKind ? ` doc=${docKind}` : ""} chunk=${hit.chunkId.slice(0, 18)}`,
  ];
  if (sessionId) lines.push(`   session=${sessionId}`);
  if (transcript) lines.push(`   source=${transcript}`);
  lines.push(`   ${hit.snippet}`);
  return lines.join("\n");
}

function facetValue(facets: KnowledgeSearchHit["facets"], key: string): string | null {
  const raw = facets[key];
  if (typeof raw === "string" && raw.trim()) return raw;
  if (Array.isArray(raw) && raw[0]?.trim()) return raw[0];
  return null;
}

async function runStatus(context: ScoutCommandContext): Promise<void> {
  if (!knowledgeIndexEnabled()) { context.output.writeValue(disabledKnowledgeStatus(), formatStatus); return; }
  // Read path: never open a writable connection (no DDL / FTS migration on status).
  const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
  try {
    const status = store.status();
    context.output.writeValue(status, formatStatus);
  } finally {
    store.close();
  }
}

async function runIndex(context: ScoutCommandContext, args: string[]): Promise<void> {
  const { harness, rest } = parseHarnessList(args);
  let source = "sessions";
  let days: number | undefined;
  let hours: number | undefined;
  let limit: number | undefined;
  let force = false;

  for (let i = 0; i < rest.length; i += 1) {
    const current = rest[i]!;
    if (current === "--source" || current.startsWith("--source=")) {
      const taken = takeFlagValue(rest, i, "--source");
      source = taken.value;
      i = taken.nextIndex;
      continue;
    }
    if (current === "--days" || current.startsWith("--days=")) {
      const taken = takeFlagValue(rest, i, "--days");
      days = parsePositiveInt(taken.value, "--days");
      i = taken.nextIndex;
      continue;
    }
    if (current === "--hours" || current.startsWith("--hours=")) {
      const taken = takeFlagValue(rest, i, "--hours");
      hours = parsePositiveInt(taken.value, "--hours");
      i = taken.nextIndex;
      continue;
    }
    if (current === "--limit" || current.startsWith("--limit=")) {
      const taken = takeFlagValue(rest, i, "--limit");
      limit = parsePositiveInt(taken.value, "--limit");
      i = taken.nextIndex;
      continue;
    }
    if (current === "--force") {
      force = true;
      continue;
    }
    throw new ScoutCliError(`unknown index option: ${current}`);
  }

  if (source !== "sessions") {
    throw new ScoutCliError(`unsupported search source: ${source} (only sessions is implemented)`);
  }

  if (!knowledgeIndexEnabled()) { context.output.writeValue({ enabled: false, message: KNOWLEDGE_INDEX_OFF }, r => r.message); return; }
  context.stderr(
    `indexing sessions${harness.length ? ` harness=${harness.join(",")}` : ""}${
      hours != null ? ` hours=${hours}` : ` days=${days ?? 3}`
    }…`,
  );
  const result = await indexRecentSessionKnowledge({
    days,
    hours,
    limit,
    force,
    harness: harness.length > 0 ? harness : undefined,
  });

  const summary = {
    jobId: result.job.id,
    state: result.job.state,
    days: result.days,
    hours: result.hours,
    discovered: result.discovered,
    indexed: result.indexed,
    failed: result.failed,
    skipped: result.sessions.filter((session) => session.skipped).length,
    harnesses: [...new Set(result.sessions.map((session) => session.harness))].sort(),
    sessions: result.sessions.map((session) => ({
      collectionId: session.collectionId,
      harness: session.harness,
      project: session.project,
      sessionId: session.transcriptPath,
      records: session.records,
      chunks: session.chunks,
      skipped: session.skipped ?? false,
      error: session.error,
    })),
  };

  context.output.writeValue(summary, (value) => {
    const lines = [
      `Index job ${value.jobId} → ${value.state}`,
      `  discovered: ${value.discovered}`,
      `  indexed:    ${value.indexed} (skipped ${value.skipped})`,
      `  failed:     ${value.failed}`,
      `  harnesses:  ${value.harnesses.join(", ") || "(none)"}`,
    ];
    if (value.hours != null) lines.push(`  window:     ${value.hours}h`);
    else lines.push(`  window:     ${value.days}d`);
    const errors = value.sessions.filter((session) => session.error);
    if (errors.length > 0) {
      lines.push("  errors:");
      for (const session of errors.slice(0, 8)) {
        lines.push(`    ${session.harness} ${session.collectionId}: ${session.error}`);
      }
    }
    return lines.join("\n");
  });
}

async function runQuery(context: ScoutCommandContext, args: string[]): Promise<void> {
  const { harness, rest } = parseHarnessList(args);
  const queryParts: string[] = [];
  let project: string | undefined;
  let limit = 20;
  let hours: number | undefined;
  let days: number | undefined;
  let on: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const current = rest[i]!;
    if (current === "--on" || current.startsWith("--on=")) {
      const taken = takeFlagValue(rest, i, "--on");
      on = taken.value;
      i = taken.nextIndex;
      continue;
    }
    if (current === "--project" || current.startsWith("--project=")) {
      const taken = takeFlagValue(rest, i, "--project");
      project = taken.value;
      i = taken.nextIndex;
      continue;
    }
    if (current === "--limit" || current.startsWith("--limit=")) {
      const taken = takeFlagValue(rest, i, "--limit");
      limit = parsePositiveInt(taken.value, "--limit");
      i = taken.nextIndex;
      continue;
    }
    if (current === "--hours" || current.startsWith("--hours=")) {
      const taken = takeFlagValue(rest, i, "--hours");
      hours = parsePositiveInt(taken.value, "--hours");
      i = taken.nextIndex;
      continue;
    }
    if (current === "--days" || current.startsWith("--days=")) {
      const taken = takeFlagValue(rest, i, "--days");
      days = parsePositiveInt(taken.value, "--days");
      i = taken.nextIndex;
      continue;
    }
    if (current.startsWith("-")) {
      throw new ScoutCliError(`unknown query option: ${current}`);
    }
    queryParts.push(current);
  }

  const q = queryParts.join(" ").trim();
  if (!q) {
    throw new ScoutCliError("search query requires text (try: scout search query \"…\")");
  }

  if (on) {
    await runRemoteQuery(context, on, { q, harness, project, limit, hours: hours ?? (days != null ? days * 24 : undefined) });
    return;
  }

  const facets: Record<string, string | string[]> = {};
  if (harness.length === 1) facets.harness = harness[0]!;
  else if (harness.length > 1) facets.harness = harness;
  if (project) facets.project = project;

  let sourceUpdatedAfterMs: number | undefined;
  if (hours != null) sourceUpdatedAfterMs = Date.now() - hours * 60 * 60 * 1000;
  else if (days != null) sourceUpdatedAfterMs = Date.now() - days * 24 * 60 * 60 * 1000;

  let lookbackMs: number | undefined;
  if (hours != null) lookbackMs = hours * 60 * 60 * 1000;
  else if (days != null) lookbackMs = days * 24 * 60 * 60 * 1000;

  // Read path: never open a writable connection (no DDL / FTS migration on query).
  if (!knowledgeIndexEnabled()) {
    context.output.writeValue({ q, hits: [], hitCount: 0, coverage: { kind: "index_off", suggestion: KNOWLEDGE_INDEX_OFF } }, () => KNOWLEDGE_INDEX_OFF);
    return;
  }
  const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
  try {
    const status = store.status();
    const coverage = store.assessCoverage({
      source: "sessions",
      harness: harness.length > 0 ? harness : undefined,
      lookbackMs,
    });

    if (coverage.kind === "index_off" || coverage.kind === "empty_index" || coverage.kind === "not_warmed") {
      const payload = {
        q,
        hitCount: 0,
        coverage,
        status: {
          collections: status.collections,
          readyCollections: status.readyCollections,
          chunks: status.chunks,
        },
        hits: [] as KnowledgeSearchHit[],
      };
      context.output.writeValue(payload, (value) =>
        [
          `No search run for ${JSON.stringify(value.q)} — index is not covered for this query.`,
          ...formatCoverageNote(value.coverage),
        ].join("\n")
      );
      return;
    }

    const hits = store.searchLexical({
      q,
      sourceKinds: ["sessions"],
      facets: Object.keys(facets).length > 0 ? facets : undefined,
      sourceUpdatedAfterMs,
      limit,
    });
    const payload = {
      q,
      hitCount: hits.length,
      coverage,
      status: {
        collections: status.collections,
        readyCollections: status.readyCollections,
        chunks: status.chunks,
      },
      hits,
    };
    context.output.writeValue(payload, (value) => {
      const header = [
        `${value.hitCount} hit(s) for ${JSON.stringify(value.q)}`,
        ...formatCoverageNote(value.coverage),
      ];
      if (value.hits.length === 0) {
        return [
          ...header,
          "",
          coverage.kind === "bounded"
            ? "No matching chunks in retained history; evicted history was not searched."
            : "Warmed for this span, but no matching chunks.",
          "Try different terms, drop a facet, or re-index if the work is newer than the last warm-up.",
        ].join("\n");
      }
      return [
        ...header,
        "",
        ...value.hits.map((hit, index) => formatHit(hit, index)),
      ].join("\n");
    });
  } finally {
    store.close();
  }
}

async function runRemoteQuery(
  context: ScoutCommandContext,
  machine: string,
  input: { q: string; harness: string[]; project?: string; limit: number; hours?: number },
): Promise<void> {
  if (input.hours !== undefined && input.hours > 720) throw new ScoutCliError("--on searches at most 720 hours (30 days)");
  let result: Awaited<ReturnType<typeof searchSessionsOnMachine>>;
  try {
    result = await searchSessionsOnMachine(machine, {
      query: input.q,
      ...(input.harness.length ? { harness: input.harness } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.hours !== undefined ? { hours: input.hours } : {}),
      limit: Math.min(input.limit, 20),
    });
  } catch (error) {
    throw new ScoutCliError(`search on ${machine} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const host = `${result.nodeName ?? result.nodeId} (${result.nodeId})`;
  context.output.writeValue(result, (value) => {
    const covered = value.coverage.kind === "warmed" || value.coverage.kind === "bounded";
    if (!covered) {
      return [
        `No search run for ${JSON.stringify(value.query)} on ${host}: that host's index does not cover this query.`,
        ...formatCoverageNote(value.coverage),
      ].join("\n");
    }
    const header = [`${value.hitCount} hit(s) for ${JSON.stringify(value.query)} on ${host}`, ...formatCoverageNote(value.coverage)];
    if (value.hits.length === 0) return [...header, "", "Warmed on that host, but no matching chunks."].join("\n");
    return [...header, "", ...value.hits.map((hit, index) => formatHit(hit, index))].join("\n");
  });
}

export function renderSearchCommandHelp(): string {
  return SEARCH_HELP;
}

export async function runSearchCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.length === 0 || args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderSearchCommandHelp());
    return;
  }

  const action = args[0];
  const rest = args.slice(1);
  switch (action) {
    case "status":
      if (rest.length > 0) throw new ScoutCliError("search status takes no options");
      await runStatus(context);
      return;
    case "index":
      await runIndex(context, rest);
      return;
    case "query":
      await runQuery(context, rest);
      return;
    default:
      // Allow: scout search "text" as shorthand for query
      if (!action.startsWith("-")) {
        await runQuery(context, args);
        return;
      }
      throw new ScoutCliError(`unknown search action: ${action} (try: status|index|query)`);
  }
}
