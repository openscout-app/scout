/**
 * Real-data aggregator for the home/briefing service gauges.
 *
 * Sources per service:
 *   - codex:  most recent `token_count` event per rate-limit pool in
 *             ~/.codex/sessions/**.jsonl. The window's duration is authoritative,
 *             not its primary/secondary slot, and only the pool nearest
 *             exhaustion is reported (see `bindingCodexPoolSnapshots`).
 *   - claude: provider-reported Anthropic quota windows from statusline capture
 *             or the control-plane DB when available
 *   - kimi:   provider-reported Kimi Code 5-hour and weekly subscription quota
 *             from the same `/usages` endpoint used by Kimi Code's `/usage`
 *   - grok:   provider-reported weekly quota from Grok's local billing log,
 *             with normalized dashboard capture and content-free cumulative
 *             session telemetry as fallbacks.
 *   - cursor: locally reported membership plus normalized usage totals from an
 *             explicit dashboard text/CSV capture.
 *   - minimax: provider-reported Token Plan 5-hour and weekly quota windows
 *              from MiniMax's documented `/v1/token_plan/remains` endpoint.
 *   - github: `gh api rate_limit` resources.core (hourly window; honest about scope)
 *
 * Cached server-side so we can poll cheaply from the client.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  readCodexRolloutUsageObservation,
  type CodexUsageObservation,
} from "@openscout/agent-sessions";
import { Database } from "bun:sqlite";
import { epochMs } from "@openscout/protocol";
import { healProviderTelemetryIfStale } from "@openscout/runtime";
import { resolveClaudeStatuslineDirectory, buildPiRpcCredentialEnv } from "@openscout/runtime/harnesses";
import { execSystemFile } from "@openscout/runtime/setup";
import { db, resolveDbPath } from "./db/internal/db.ts";
import { closeWebDb, webDb } from "./db/internal/web-db.ts";

const CACHE_TTL_MS = 60 * 1000;
const FIVE_HOUR_MS = 5 * 3600 * 1000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const MONTH_MS = 30 * 24 * 3600 * 1000;
const CODEX_LOOKBACK_DAYS = 3;
const CODEX_JSONL_TAIL_MAX_BYTES = 2 * 1024 * 1024;
const CODEX_INITIAL_FILE_LIMIT = 32;
const CODEX_RECENT_CANDIDATE_LIMIT = 64;
const CODEX_JSONL_READ_CONCURRENCY = 8;
const LOCAL_QUOTA_FRESH_MS = 2 * 60 * 1000;
const REMOTE_QUOTA_FRESH_MS = 5 * 60 * 1000;
const GH_CLI_TIMEOUT_MS = 4000;
const KIMI_USAGE_TIMEOUT_MS = 4000;
const MINIMAX_REMAINS_TIMEOUT_MS = 4000;
const QUOTA_HISTORY_BUCKET_MS = 60 * 60 * 1000;
const QUOTA_HISTORY_LOOKBACK_MS = WEEK_MS;
const QUOTA_HISTORY_ID_PREFIX = "budget:quota:history:";
const PERSISTED_QUOTA_ROW_LIMIT = 768;
const CLAUDE_STATUSLINE_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
const GROK_BILLING_LOG_MAX_BYTES = 32 * 1024 * 1024;
const GH_CLI_BIN_ENV = "OPENSCOUT_GH_BIN";
const GH_RATE_LIMIT_JSON_ENV = "OPENSCOUT_GH_RATE_LIMIT_JSON";
const KIMI_USAGE_JSON_ENV = "OPENSCOUT_KIMI_USAGE_JSON";
const CURSOR_STATUS_JSON_ENV = "OPENSCOUT_CURSOR_STATUS_JSON";
const GROK_USAGE_JSON_ENV = "OPENSCOUT_GROK_USAGE_JSON";
const MINIMAX_REMAINS_JSON_ENV = "OPENSCOUT_MINIMAX_REMAINS_JSON";
const DASHBOARD_IMPORT_MAX_CHARS = 128 * 1024;

type GaugeTone = "ok" | "warn" | "err" | "dim";

export type ServiceQuotaHistoryPoint = {
  capturedAt: number;
  fill: number;
  usedLabel: string;
  resetAt?: number;
};

export type ServiceQuotaWindowGauge = {
  label: string;
  fill: number;
  usedLabel: string;
  capLabel: string;
  unitLabel: string;
  resetAt: number;
  windowMs?: number;
  capturedAt?: number;
  source?: string;
  history?: ServiceQuotaHistoryPoint[];
  /** True when the last reading's reset elapsed and no post-reset observation exists. */
  awaitingReset?: boolean;
};

export type ServiceGauge =
  | {
      id: string;
      label: string;
      kind: "quota";
      fill: number;
      usedLabel: string;
      capLabel: string;
      unitLabel: string;
      resetAt: number;
      windows?: ServiceQuotaWindowGauge[];
      plan?: string;
      capturedAt?: number;
      source?: string;
    }
  | {
      id: string;
      label: string;
      kind: "status";
      statusLabel: string;
      windowLabel?: string;
      detailLabel?: string;
      tone: GaugeTone;
      capturedAt?: number;
      source?: string;
    };

export type ServiceBudgetsResponse = {
  generatedAt: number;
  gauges: ServiceGauge[];
  cloudAccounts: CloudAccount[];
};

export type CloudAccount = {
  id: "cloudflare" | "vercel" | "exe";
  label: string;
  statusLabel: string;
  detailLabel: string;
};

let cached: { value: ServiceBudgetsResponse; expiresAt: number } | null = null;
let inflightNormal: Promise<ServiceBudgetsResponse> | null = null;
let inflightForce: Promise<ServiceBudgetsResponse> | null = null;

export function resetServiceBudgetsCache(): void {
  cached = null;
  inflightNormal = null;
  inflightForce = null;
  closeWebDb();
}

export async function loadServiceBudgets(forceRefresh = false): Promise<ServiceBudgetsResponse> {
  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.value;
  if (forceRefresh && inflightForce) return inflightForce;
  if (!forceRefresh && inflightForce) return inflightForce;
  if (!forceRefresh && inflightNormal) return inflightNormal;

  const request = (async () => {
    // A forced refresh that arrives during the initial cached read must run
    // after it, not silently reuse that non-forced request.
    if (forceRefresh && inflightNormal) await inflightNormal.catch(() => undefined);
    const [codex, claude, kimi, grok, cursor, minimax, github] = await Promise.all([
      loadCodexGauge(forceRefresh).catch((error) => serviceBudgetProviderFailed("codex", error)),
      loadClaudeGauge().catch((error) => serviceBudgetProviderFailed("claude", error)),
      loadKimiGauge(forceRefresh).catch((error) => serviceBudgetProviderFailed("kimi", error)),
      loadGrokGauge().catch((error) => serviceBudgetProviderFailed("grok", error)),
      loadCursorGauge().catch((error) => serviceBudgetProviderFailed("cursor", error)),
      loadMinimaxGauge(forceRefresh).catch((error) => serviceBudgetProviderFailed("minimax", error)),
      loadGithubGauge(forceRefresh).catch((error) => serviceBudgetProviderFailed("github", error)),
    ]);
    const gauges = [codex, claude, kimi, grok, cursor, minimax, github].filter((g): g is ServiceGauge => g !== null);
    const value: ServiceBudgetsResponse = {
      generatedAt: Date.now(),
      gauges,
      cloudAccounts: detectCloudAccounts(),
    };
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  })();
  if (forceRefresh) inflightForce = request;
  else inflightNormal = request;

  try {
    return await request;
  } finally {
    if (forceRefresh && inflightForce === request) inflightForce = null;
    if (!forceRefresh && inflightNormal === request) inflightNormal = null;
  }
}

function serviceBudgetProviderFailed(provider: string, error: unknown): null {
  debugServiceBudgetProvider(provider, "gauge failed", error);
  return null;
}

function debugServiceBudgetProvider(provider: string, message: string, detail?: unknown): void {
  if (process.env.OPENSCOUT_DEBUG_SERVICE_BUDGETS === "1") {
    console.error(`[service-budgets] ${provider} ${message}`, detail);
  }
}

/* ── codex ──────────────────────────────────────────────────────────── */

type CodexRateLimitsObservation = {
  usage: CodexUsageObservation;
  capturedAt: number;
};

async function loadCodexGauge(forceRefresh = false): Promise<ServiceGauge | null> {
  const fresh = loadPersistedProviderQuotaGauge({
    id: "codex",
    label: "codex",
    provider: "openai",
    harness: "codex",
    maxAgeMs: LOCAL_QUOTA_FRESH_MS,
  });
  if (!forceRefresh && fresh && !quotaGaugeAwaitingReset(fresh)) return fresh;

  const fallback = loadPersistedProviderQuotaGauge({
    id: "codex",
    label: "codex",
    provider: "openai",
    harness: "codex",
    maxAgeMs: WEEK_MS,
  });

  const root = join(homeDir(), ".codex", "sessions");
  if (!existsSync(root)) return fallback;

  const candidates = await findRecentCodexJsonl(root, CODEX_LOOKBACK_DAYS);
  if (candidates.length === 0) return fallback;

  const observations = (await harvestRecentCodexRateLimits(candidates))
    .sort((left, right) => left.capturedAt - right.capturedAt);
  if (observations.length === 0) return fallback;
  // A promo-only partial scan is not evidence that the account pool vanished.
  // Keep the prior real reading (or show nothing) instead of persisting a 0%
  // sliding pool over it.
  if (!observations.some(isCodexAccountPoolObservation)) return fallback;

  // Concurrent sessions can report different semantic windows. Harvest each
  // session's latest observation and let the reset-aware selector merge them.
  const snapshots = bindingCodexPoolSnapshots(observations.flatMap((observation) =>
    codexQuotaSnapshotsFromObservation(observation.usage, observation.capturedAt)));
  persistQuotaSnapshots(snapshots);
  const persisted = loadPersistedProviderQuotaGauge({
    id: "codex",
    label: "codex",
    provider: "openai",
    harness: "codex",
    maxAgeMs: WEEK_MS,
  });
  if (persisted) return persisted;
  return quotaGaugeFromSnapshots({
    id: "codex",
    label: "codex",
  }, snapshots);
}

function codexQuotaSnapshot(
  window: CodexUsageObservation["quotaWindows"][number],
  capturedAt: number,
  planType?: string,
  limitId?: string,
): ServiceQuotaSnapshot | null {
  const usedPercent = finiteNumber(window.usedPercent);
  const percentRemaining = finiteNumber(window.percentRemaining)
    ?? (usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent));
  if (usedPercent === undefined && percentRemaining === undefined) return null;
  const windowMs = finiteNumber(window.windowMs);
  const resetAt = finiteNumber(window.resetAt) ?? capturedAt + (windowMs ?? WEEK_MS);
  return {
    provider: "openai",
    harness: "codex",
    transport: "codex_app_server",
    planType,
    label: window.label,
    windowKind: window.windowKind,
    usedPercent,
    percentRemaining,
    used: window.used,
    limitValue: window.limit,
    resetAt,
    windowMs,
    capturedAt,
    metadata: {
      source: "service-budgets.codex-jsonl",
      // Deliberately not `resource`: that field keys the window identity, and
      // re-keying would split the stored series. This is for traceability only.
      ...(limitId ? { limitId } : {}),
    },
  };
}

function codexQuotaSnapshotsFromObservation(
  usage: CodexUsageObservation,
  capturedAt: number,
): ServiceQuotaSnapshot[] {
  return usage.quotaWindows
    .map((window) => codexQuotaSnapshot(window, capturedAt, usage.planType, usage.limitId))
    .filter((entry): entry is ServiceQuotaSnapshot => entry !== null);
}

/**
 * Codex Desktop reports the account's `codex` weekly window alongside separate
 * promotional pools that sit at 0% and carry a reset that slides forward with
 * every event. Those are not alternative readings of the same quota, so they
 * must not be merged as if they were: whichever pool is closest to exhaustion
 * is the one that actually constrains the next request, and it is the only one
 * worth reporting for a window.
 */
function bindingCodexPoolSnapshots(snapshots: ServiceQuotaSnapshot[]): ServiceQuotaSnapshot[] {
  const poolIdOf = (row: ServiceQuotaSnapshot) => stringValue(row.metadata?.limitId) ?? "";
  const pools = new Set(snapshots.map(poolIdOf));
  if (pools.size <= 1) return snapshots;

  const bindingPoolByLabel = new Map<string, {
    poolId: string;
    usedPercent: number;
    capturedAt: number;
    accountPool: boolean;
  }>();
  for (const row of snapshots) {
    const usedPercent = quotaSnapshotUsage(row)?.fill;
    if (usedPercent === undefined) continue;
    const poolId = poolIdOf(row);
    const accountPool = isCodexAccountPoolId(poolId);
    const best = bindingPoolByLabel.get(row.label);
    if (!best || usedPercent > best.usedPercent
      || (usedPercent === best.usedPercent && accountPool && !best.accountPool)
      || (usedPercent === best.usedPercent && accountPool === best.accountPool && row.capturedAt > best.capturedAt)) {
      bindingPoolByLabel.set(row.label, { poolId, usedPercent, capturedAt: row.capturedAt, accountPool });
    }
  }

  return snapshots.filter((row) => bindingPoolByLabel.get(row.label)?.poolId === poolIdOf(row));
}

function formatQuotaWindowLabel(
  windowMinutes: number | undefined,
  fallback: "primary" | "secondary",
): string {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return fallback === "primary" ? "5h" : "7d";
  }
  if (windowMinutes % (24 * 60) === 0) {
    return `${windowMinutes / (24 * 60)}d`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`;
  }
  return `${windowMinutes}m`;
}

type CodexJsonlCandidate = {
  path: string;
  mtimeMs: number;
};

async function findRecentCodexJsonl(root: string, lookbackDays: number): Promise<CodexJsonlCandidate[]> {
  const cutoffMs = Date.now() - lookbackDays * 86400 * 1000;
  const paths: CodexJsonlCandidate[] = [];

  // This tree can contain hundreds of thousands of session files. A recursive
  // sync walk monopolized the web server's event loop for seconds, so an
  // unrelated Lanes or chat request could appear frozen while the home budget
  // card refreshed. Traverse through fs/promises instead: total discovery work
  // is unchanged, but every directory boundary yields to interactive routes.
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const fileStat = await stat(full);
          if (fileStat.mtimeMs < cutoffMs) continue;
          paths.push({ path: full, mtimeMs: fileStat.mtimeMs });
        } catch {
          // A session can rotate between directory enumeration and stat.
        }
      }
    }
  }
  return paths
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, CODEX_RECENT_CANDIDATE_LIMIT);
}

/**
 * Preserve the existing newest-32 fast path. If it finds only irrelevant or
 * promotional sessions, probe the next 32 in bounded batches and stop as soon
 * as the account pool appears. Worst-case tail work is 64 × 2 MiB, while tiny
 * files do not consume a quota-observation slot merely by existing.
 */
async function harvestRecentCodexRateLimits(
  candidates: CodexJsonlCandidate[],
): Promise<CodexRateLimitsObservation[]> {
  const observations = await readCodexCandidateBatch(candidates.slice(0, CODEX_INITIAL_FILE_LIMIT));
  if (observations.some(isCodexAccountPoolObservation)) return observations;

  const overflow = candidates.slice(CODEX_INITIAL_FILE_LIMIT, CODEX_RECENT_CANDIDATE_LIMIT);
  for (let index = 0; index < overflow.length; index += CODEX_JSONL_READ_CONCURRENCY) {
    observations.push(...await readCodexCandidateBatch(
      overflow.slice(index, index + CODEX_JSONL_READ_CONCURRENCY),
    ));
    if (observations.some(isCodexAccountPoolObservation)) break;
  }

  return observations;
}

async function readCodexCandidateBatch(
  candidates: CodexJsonlCandidate[],
): Promise<CodexRateLimitsObservation[]> {
  return (await Promise.all(candidates.map(async (candidate) => {
    try {
      return await readLatestCodexRateLimits(candidate.path);
    } catch {
      // A rollout may disappear or become unreadable after discovery.
      return [];
    }
  }))).flat();
}

function isCodexAccountPoolObservation(observation: CodexRateLimitsObservation): boolean {
  return isCodexAccountPoolId(observation.usage.limitId);
}

function isCodexAccountPoolId(limitId: string | undefined): boolean {
  const normalized = limitId?.trim().toLowerCase();
  return !normalized || normalized === "codex";
}

/**
 * One session can report several rate-limit pools. Keep the newest reading of
 * each rather than the newest reading overall: taking only the last line loses
 * the account's real weekly window whenever a session happens to end on an
 * event belonging to some other pool.
 */
async function readLatestCodexRateLimits(path: string): Promise<CodexRateLimitsObservation[]> {
  const handle = await open(path, "r");
  try {
    const fileStat = await handle.stat();
    const start = Math.max(0, fileStat.size - CODEX_JSONL_TAIL_MAX_BYTES);
    const rl = createInterface({
      input: handle.createReadStream({
        encoding: "utf8",
        start,
        autoClose: false,
      }),
    });
    const latestByPool = new Map<string, CodexRateLimitsObservation>();
    let firstLine = start > 0;
    for await (const line of rl) {
      // A bounded tail may begin midway through a JSONL record. Discard only
      // that fragment; every subsequent line is a complete event.
      if (firstLine) {
        firstLine = false;
        continue;
      }
      if (!line.includes("\"rate_limits\"")) continue;
      try {
        const record = JSON.parse(line) as {
          timestamp?: unknown;
          ts?: unknown;
          payload?: unknown;
        };
        const capturedAt = timestampMs(record.timestamp) ?? timestampMs(record.ts) ?? Date.now();
        const usage = readCodexRolloutUsageObservation(record.payload, capturedAt);
        if (usage?.quotaWindows.length) {
          latestByPool.set(usage.limitId ?? "", { usage, capturedAt });
        }
      } catch {
        // skip malformed line
      }
    }
    return [...latestByPool.values()];
  } finally {
    await handle.close();
  }
}

/* ── claude ─────────────────────────────────────────────────────────── */

type ServiceQuotaSnapshot = {
  source?: "provider_reported" | "manual" | "observed";
  provider?: string | null;
  harness?: string | null;
  transport?: string | null;
  planType?: string | null;
  label: string;
  windowKind?: string | null;
  usedPercent?: number | null;
  percentRemaining?: number | null;
  used?: number | null;
  limitValue?: number | null;
  resetAt?: number | null;
  windowMs?: number | null;
  capturedAt: number;
  metadata?: Record<string, unknown>;
};

type StoredQuotaWindowRow = ServiceQuotaSnapshot & {
  id: string;
  createdAt: number;
  metadataJson: string | null;
};

async function loadClaudeGauge(): Promise<ServiceGauge | null> {
  healClaudeCaptureInBackground();
  const statusline = loadClaudeStatuslineGauge();
  if (statusline) return statusline;

  return loadPersistedProviderQuotaGauge({
    id: "claude",
    label: "claude",
    provider: "anthropic",
    harness: "claude",
    maxAgeMs: WEEK_MS,
  });
}

/* Quota only shows up while the statusline capture is wired. If capture has
   gone stale, let the runtime re-check and repair the wiring (throttled, and a
   no-op when healthy) without holding up this read. */
function healClaudeCaptureInBackground(): void {
  void healProviderTelemetryIfStale({ env: process.env })
    .then((report) => {
      if (report?.claude.status === "installed") {
        console.warn(`[scout] Repaired Claude quota capture (statusline → ${report.claude.wrapperPath})`);
        resetServiceBudgetsCache();
      }
    })
    .catch((error) => debugServiceBudgetProvider("claude", "statusline heal failed", error));
}

type ClaudeStatuslineSnapshot = Record<string, unknown>;

function loadClaudeStatuslineGauge(): ServiceGauge | null {
  const snapshots = loadClaudeStatuslineQuotaSnapshots();
  if (snapshots.length > 0) {
    persistQuotaSnapshots([...snapshots].sort((a, b) => a.capturedAt - b.capturedAt));
    const persisted = loadPersistedProviderQuotaGauge({
      id: "claude",
      label: "claude",
      provider: "anthropic",
      harness: "claude",
      maxAgeMs: WEEK_MS,
    });
    if (persisted) return persisted;

    const direct = quotaGaugeFromSnapshots({
      id: "claude",
      label: "claude",
      maxCurrentAgeMs: WEEK_MS,
    }, snapshots);
    if (direct) return direct;

    const stale = quotaGaugeFromSnapshots({
      id: "claude",
      label: "claude",
      maxCurrentAgeMs: WEEK_MS,
      allowExpiredWindows: true,
    }, snapshots);
    if (stale) return stale;
  }

  return null;
}

function claudeStatuslineDir(): string {
  return resolveClaudeStatuslineDirectory();
}

function readClaudeStatuslineLatest(): ClaudeStatuslineSnapshot | null {
  return readJsonRecord(join(claudeStatuslineDir(), "claude-latest.json"));
}

function loadClaudeStatuslineQuotaSnapshots(): ServiceQuotaSnapshot[] {
  const now = Date.now();
  const latest = readClaudeStatuslineLatest();
  const history = readClaudeStatuslineHistory(now - QUOTA_HISTORY_LOOKBACK_MS);
  return [
    ...(latest ? [latest] : []),
    ...history,
  ]
    .flatMap((record) => claudeQuotaSnapshotsFromStatusline(record))
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, PERSISTED_QUOTA_ROW_LIMIT);
}

function readClaudeStatuslineHistory(minCapturedAt: number): ClaudeStatuslineSnapshot[] {
  const path = join(claudeStatuslineDir(), "claude-history.jsonl");
  const stat = safeStat(path);
  if (!stat) return [];

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  if (stat.size > CLAUDE_STATUSLINE_HISTORY_MAX_BYTES) {
    content = content.slice(-CLAUDE_STATUSLINE_HISTORY_MAX_BYTES);
    const firstNewline = content.indexOf("\n");
    if (firstNewline >= 0) {
      content = content.slice(firstNewline + 1);
    }
  }

  const out: ClaudeStatuslineSnapshot[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = parseJsonRecord(trimmed);
    if (!record) continue;
    if (claudeStatuslineCapturedAt(record) < minCapturedAt) continue;
    out.push(record);
  }
  return out;
}

function claudeStatuslineWindowSpec(key: string): {
  label: string;
  windowKind: string;
  windowMs: number;
} | null {
  const raw = key.trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[-_\s]/gu, "");
  if (["fivehour", "fivehours", "primary", "5h"].includes(normalized)) {
    return { label: "5h", windowKind: "primary", windowMs: FIVE_HOUR_MS };
  }
  if (["sevenday", "weekly", "secondary", "7d"].includes(normalized)) {
    return { label: "7d", windowKind: "secondary", windowMs: WEEK_MS };
  }
  if (["monthly", "month", "thirtyday", "30d"].includes(normalized)) {
    return { label: "30d", windowKind: "monthly", windowMs: MONTH_MS };
  }
  if (normalized.includes("month")) {
    return { label: "30d", windowKind: "monthly", windowMs: MONTH_MS };
  }
  if (normalized.includes("fivehour") || normalized.endsWith("5h")) {
    return { label: raw.replace(/_/gu, " "), windowKind: raw, windowMs: FIVE_HOUR_MS };
  }
  if (normalized.startsWith("sevenday") || normalized.includes("weekly")) {
    return { label: raw.replace(/_/gu, " "), windowKind: raw, windowMs: WEEK_MS };
  }
  return { label: raw.replace(/_/gu, " "), windowKind: raw, windowMs: WEEK_MS };
}

function claudeQuotaSnapshotsFromStatusline(record: ClaudeStatuslineSnapshot): ServiceQuotaSnapshot[] {
  const rateLimits = recordValue(record.rate_limits);
  if (!rateLimits) return [];

  const capturedAt = claudeStatuslineCapturedAt(record);
  return Object.entries(rateLimits).flatMap(([key, value]) => {
    const spec = claudeStatuslineWindowSpec(key);
    if (!spec) return [];
    const snapshot = claudeQuotaSnapshotFromStatuslineWindow(record, value, {
      ...spec,
      capturedAt,
    });
    return snapshot ? [snapshot] : [];
  });
}

function claudeQuotaSnapshotFromStatuslineWindow(
  record: ClaudeStatuslineSnapshot,
  value: unknown,
  options: {
    label: string;
    windowKind: string;
    windowMs: number;
    capturedAt: number;
  },
): ServiceQuotaSnapshot | null {
  const window = recordValue(value);
  if (!window) return null;

  const usedPercent = numericValue(window.used_percentage)
    ?? numericValue(window.usedPercent)
    ?? numericValue(window.used_percent);
  const percentRemaining = numericValue(window.remaining_percentage)
    ?? numericValue(window.remainingPercent)
    ?? numericValue(window.percent_remaining)
    ?? (usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent));
  if (usedPercent === undefined && percentRemaining === undefined) return null;

  const resetAt = timestampMs(window.resets_at)
    ?? timestampMs(window.reset_at)
    ?? timestampMs(window.resetAt)
    ?? options.capturedAt + options.windowMs;

  return {
    provider: "anthropic",
    harness: "claude",
    transport: "claude_statusline",
    label: options.label,
    windowKind: options.windowKind,
    usedPercent,
    percentRemaining,
    resetAt,
    windowMs: options.windowMs,
    capturedAt: options.capturedAt,
    metadata: {
      source: "service-budgets.claude-statusline",
      sessionId: stringValue(record.session_id),
      cwd: stringValue(record.cwd),
      model: claudeStatuslineModel(record),
    },
  };
}

function claudeStatuslineCapturedAt(record: ClaudeStatuslineSnapshot): number {
  return timestampMs(record.openscoutCapturedAt)
    ?? timestampMs(record.capturedAt)
    ?? timestampMs(record.timestamp)
    ?? Date.now();
}

function claudeStatuslineModel(record: ClaudeStatuslineSnapshot): string | undefined {
  const model = recordValue(record.model);
  return stringValue(model?.id)
    ?? stringValue(model?.display_name);
}

function loadPersistedProviderQuotaGauge(input: {
  id: string;
  label: string;
  provider: string;
  harness: string;
  maxAgeMs: number;
}): ServiceGauge | null {
  return quotaGaugeFromSnapshots({
    id: input.id,
    label: input.label,
    maxCurrentAgeMs: input.maxAgeMs,
  }, loadPersistedProviderQuotaSnapshots(input));
}

function loadPersistedProviderQuotaSnapshots(input: {
  provider: string;
  harness: string;
  maxAgeMs: number;
}): ServiceQuotaSnapshot[] {
  const now = Date.now();
  const lookbackMs = Math.max(input.maxAgeMs, QUOTA_HISTORY_LOOKBACK_MS);
  // Two writers, one shape: the web server's own harvest, and the windows the
  // broker observed on endpoints. The web copy wins an id both hold — the
  // control plane may still carry rows this server wrote there before it had
  // its own database.
  const byId = new Map<string, StoredQuotaWindowRow>();
  for (const database of [webDb, db]) {
    for (const row of readPersistedQuotaRows(database, now - lookbackMs, input)) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.capturedAt - left.capturedAt || right.createdAt - left.createdAt)
    .slice(0, PERSISTED_QUOTA_ROW_LIMIT)
    .map(({ id: _id, createdAt: _createdAt, metadataJson, ...row }) => ({
      ...row,
      metadata: parseMetadataJson(metadataJson),
    }));
}

function readPersistedQuotaRows(
  database: () => Database,
  capturedSince: number,
  input: { provider: string; harness: string },
): StoredQuotaWindowRow[] {
  try {
    return database().query(
      `SELECT
        id,
        source,
        provider,
        harness,
        transport,
        plan_type AS planType,
        label,
        window_kind AS windowKind,
        used_percent AS usedPercent,
        percent_remaining AS percentRemaining,
        used,
        limit_value AS limitValue,
        reset_at AS resetAt,
        window_ms AS windowMs,
        captured_at AS capturedAt,
        metadata_json AS metadataJson,
        created_at AS createdAt
      FROM budget_quota_window_snapshots
      WHERE source IN ('provider_reported', 'manual', 'observed')
        AND captured_at >= ?1
        AND (provider = ?2 OR harness = ?3)
      ORDER BY captured_at DESC, created_at DESC
      LIMIT ?4`,
    ).all(capturedSince, input.provider, input.harness, PERSISTED_QUOTA_ROW_LIMIT) as StoredQuotaWindowRow[];
  } catch {
    // The broker has not created its schema yet, or the file is missing.
    return [];
  }
}

function selectLatestQuotaSnapshots(
  snapshots: ServiceQuotaSnapshot[],
  input: {
    minCurrentCapturedAt: number;
    now: number;
    allowExpiredWindows?: boolean;
  },
): Map<string, ServiceQuotaSnapshot> {
  const latestByWindow = new Map<string, ServiceQuotaSnapshot>();
  for (const row of snapshots) {
    if (row.capturedAt < input.minCurrentCapturedAt) continue;
    if (!input.allowExpiredWindows && quotaSnapshotIsExpired(row, input.now)) continue;
    const key = quotaSnapshotWindowKey(row);
    const existing = latestByWindow.get(key);
    if (!existing) {
      latestByWindow.set(key, row);
      continue;
    }
    // Usage is monotonic only within one reset cycle. Prefer a later reset
    // cycle even when its percentage is lower; for the same reset, keep the
    // high-water mark so a resumed session cannot replay stale lower usage.
    //
    // A rollover is only credible from a *newer* reading. Without that guard an
    // old sample carrying a further-out reset outranks everything measured
    // since, and the gauge stays pinned to it until real time catches up.
    const rowResetAt = finiteNumber(row.resetAt);
    const existingResetAt = finiteNumber(existing.resetAt);
    if (rowResetAt !== undefined && existingResetAt !== undefined && rowResetAt !== existingResetAt) {
      if (rowResetAt > existingResetAt && row.capturedAt >= existing.capturedAt) {
        latestByWindow.set(key, row);
        continue;
      }
      if (rowResetAt > existingResetAt || existing.capturedAt >= row.capturedAt) continue;
      // Otherwise `row` is both newer and on an earlier cycle: the reading that
      // claimed the later cycle is the stale one, so fall through and replace it.
      latestByWindow.set(key, row);
      continue;
    }
    const rowFill = quotaSnapshotUsage(row)?.fill ?? Number.NEGATIVE_INFINITY;
    const existingFill = quotaSnapshotUsage(existing)?.fill ?? Number.NEGATIVE_INFINITY;
    if (rowFill > existingFill || (rowFill === existingFill && row.capturedAt > existing.capturedAt)) {
      latestByWindow.set(key, row);
    }
  }
  return latestByWindow;
}

function quotaGaugeFromSnapshots(input: {
  id: string;
  label: string;
  maxCurrentAgeMs?: number;
  allowExpiredWindows?: boolean;
}, snapshots: ServiceQuotaSnapshot[]): ServiceGauge | null {
  const historyByWindow = quotaHistoryByWindow(snapshots);
  const now = Date.now();
  const minCurrentCapturedAt = input.maxCurrentAgeMs === undefined
    ? Number.NEGATIVE_INFINITY
    : now - input.maxCurrentAgeMs;

  const latestByWindow = selectLatestQuotaSnapshots(snapshots, {
    minCurrentCapturedAt,
    now,
    allowExpiredWindows: input.allowExpiredWindows,
  });
  const awaitingKeys = new Set<string>();

  // A live weekly window must not hide a supported 5-hour window that just
  // reset. Keep the latest expired sibling when it was observed recently, but
  // do not present the pre-reset percentage as current usage.
  //
  // When *every* window has reset, the provider has simply gone quiet since
  // its last reading (no Claude session ticking the statusline, say). The
  // windows rolled over; they are not still at their old percentages. Keep
  // them all, as awaiting a fresh reading.
  if (!input.allowExpiredWindows) {
    const everyWindowExpired = latestByWindow.size === 0;
    const expiredSiblings = selectLatestQuotaSnapshots(snapshots, {
      minCurrentCapturedAt,
      now,
      allowExpiredWindows: true,
    });
    for (const [key, row] of expiredSiblings) {
      if (latestByWindow.has(key)) continue;
      if (!quotaSnapshotIsExpired(row, now)) continue;
      if (!everyWindowExpired && !shouldRetainExpiredWindow(row, now)) continue;
      latestByWindow.set(key, row);
      awaitingKeys.add(key);
    }
  }

  const windows = [...latestByWindow.values()]
    .map((snapshot) => storedQuotaWindowGauge(
      snapshot,
      historyByWindow.get(quotaSnapshotWindowKey(snapshot)) ?? [],
      { awaitingReset: awaitingKeys.has(quotaSnapshotWindowKey(snapshot)), now },
    ))
    .filter((window): window is ServiceQuotaWindowGauge => Boolean(window))
    .sort((a, b) => quotaWindowSortRank(a.label) - quotaWindowSortRank(b.label) || a.label.localeCompare(b.label));
  if (windows.length === 0) return null;

  const displayWindow =
    windows.find((window) => window.label === "7d") ??
    windows[windows.length - 1]!;
  const fill = Math.max(...windows.map((window) => window.fill));
  const plan = snapshots
    .filter((snapshot) => snapshot.capturedAt >= minCurrentCapturedAt)
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .map((snapshot) => stringValue(snapshot.planType))
    .find((value): value is string => Boolean(value));

  return {
    id: input.id,
    label: input.label,
    kind: "quota",
    fill,
    usedLabel: displayWindow.usedLabel,
    capLabel: displayWindow.capLabel,
    unitLabel: displayWindow.label,
    resetAt: displayWindow.resetAt,
    windows,
    capturedAt: Math.max(...windows.map((window) => window.capturedAt ?? 0)),
    source: displayWindow.source,
    ...(plan ? { plan } : {}),
  };
}

function quotaHistoryByWindow(snapshots: ServiceQuotaSnapshot[]): Map<string, ServiceQuotaHistoryPoint[]> {
  const bucketsByWindow = new Map<string, Map<number, ServiceQuotaHistoryPoint>>();
  const minCapturedAt = Date.now() - QUOTA_HISTORY_LOOKBACK_MS;

  for (const row of snapshots) {
    if (row.capturedAt < minCapturedAt) continue;
    const usage = quotaSnapshotUsage(row);
    if (!usage) continue;

    const key = quotaSnapshotWindowKey(row);
    const bucket = Math.floor(row.capturedAt / QUOTA_HISTORY_BUCKET_MS);
    let buckets = bucketsByWindow.get(key);
    if (!buckets) {
      buckets = new Map();
      bucketsByWindow.set(key, buckets);
    }

    const resetAt = finiteNumber(row.resetAt);
    const point: ServiceQuotaHistoryPoint = {
      capturedAt: row.capturedAt,
      fill: usage.fill,
      usedLabel: usage.usedLabel,
      ...(resetAt === undefined ? {} : { resetAt }),
    };
    const existing = buckets.get(bucket);
    if (!existing || point.capturedAt >= existing.capturedAt) {
      buckets.set(bucket, point);
    }
  }

  const out = new Map<string, ServiceQuotaHistoryPoint[]>();
  for (const [key, buckets] of bucketsByWindow) {
    out.set(
      key,
      [...buckets.values()]
        .sort((a, b) => a.capturedAt - b.capturedAt)
        .slice(-Math.ceil(QUOTA_HISTORY_LOOKBACK_MS / QUOTA_HISTORY_BUCKET_MS)),
    );
  }
  return out;
}

function quotaSnapshotWindowKey(row: ServiceQuotaSnapshot): string {
  const resource = stringValue(row.metadata?.resource) ?? stringValue(row.metadata?.modelName) ?? "";
  return [resource, formatStoredQuotaWindowLabel(row)].join(":");
}

/** A window rolled over since the last reading: a "fresh" gauge still needs a re-read. */
function quotaGaugeAwaitingReset(gauge: ServiceGauge): boolean {
  return gauge.kind === "quota" && (gauge.windows ?? []).some((window) => window.awaitingReset === true);
}

function quotaSnapshotIsExpired(row: ServiceQuotaSnapshot, now: number): boolean {
  const resetAt = finiteNumber(row.resetAt);
  return resetAt !== undefined && resetAt <= now;
}

function inferredQuotaWindowMs(row: ServiceQuotaSnapshot): number | undefined {
  const explicit = finiteNumber(row.windowMs);
  if (explicit !== undefined) return explicit;
  const label = row.label.trim().toLowerCase();
  if (label === "5h" || row.windowKind === "primary") return FIVE_HOUR_MS;
  if (label === "7d" || label === "weekly" || row.windowKind === "secondary") return WEEK_MS;
  if (label === "30d" || label === "monthly" || row.windowKind === "monthly") return MONTH_MS;
  return undefined;
}

function shouldRetainExpiredWindow(row: ServiceQuotaSnapshot, now: number): boolean {
  const windowMs = inferredQuotaWindowMs(row) ?? FIVE_HOUR_MS;
  const silenceMs = Math.min(WEEK_MS, Math.max(24 * 3600 * 1000, windowMs * 2));
  return row.capturedAt >= now - silenceMs;
}

function forwardedResetAt(resetAt: number | undefined, windowMs: number | undefined, now: number): number | undefined {
  if (resetAt === undefined) return undefined;
  if (resetAt > now) return resetAt;
  if (windowMs === undefined || windowMs <= 0) return resetAt;
  const cycles = Math.floor((now - resetAt) / windowMs) + 1;
  return resetAt + cycles * windowMs;
}

function quotaSnapshotUsage(row: ServiceQuotaSnapshot): {
  fill: number;
  usedLabel: string;
  capLabel: string;
  unitLabel: string;
} | null {
  const remainingPercent = finiteNumber(row.percentRemaining);
  const usedPercent = finiteNumber(row.usedPercent)
    ?? (remainingPercent === undefined ? undefined : 100 - remainingPercent)
    ?? deriveUsedPercent(row.used, row.limitValue);
  const percentRemaining = remainingPercent
    ?? (usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent));

  if (usedPercent === undefined && percentRemaining === undefined) return null;

  const fill = Math.max(0, Math.min(1, (usedPercent ?? 100 - percentRemaining!) / 100));
  const used = finiteNumber(row.used);
  const limit = finiteNumber(row.limitValue);

  return {
    fill,
    usedLabel: used === undefined ? `${Math.round(fill * 100)}%` : formatRequestCount(used),
    capLabel: limit === undefined ? "100%" : formatRequestCount(limit),
    unitLabel: used === undefined || limit === undefined ? "quota" : "req",
  };
}

function storedQuotaWindowGauge(
  row: ServiceQuotaSnapshot,
  history: ServiceQuotaHistoryPoint[] = [],
  options: { awaitingReset?: boolean; now?: number } = {},
): ServiceQuotaWindowGauge | null {
  const usage = quotaSnapshotUsage(row);
  if (!usage) return null;
  const windowMs = finiteNumber(row.windowMs) ?? inferredQuotaWindowMs(row);
  const now = options.now ?? Date.now();
  const rawResetAt = finiteNumber(row.resetAt)
    ?? (windowMs === undefined ? undefined : row.capturedAt + windowMs)
    ?? now;
  const awaitingReset = options.awaitingReset === true;
  const resetAt = awaitingReset
    ? forwardedResetAt(rawResetAt, windowMs, now) ?? rawResetAt
    : rawResetAt;

  return {
    label: formatStoredQuotaWindowLabel(row),
    fill: awaitingReset ? 0 : usage.fill,
    usedLabel: awaitingReset ? "—" : usage.usedLabel,
    capLabel: usage.capLabel,
    unitLabel: usage.unitLabel,
    resetAt,
    ...(windowMs === undefined ? {} : { windowMs }),
    capturedAt: row.capturedAt,
    source: quotaSnapshotSourceLabel(row),
    ...(history.length === 0 ? {} : { history }),
    ...(awaitingReset ? { awaitingReset: true } : {}),
  };
}

function quotaSnapshotSourceLabel(row: ServiceQuotaSnapshot): string {
  if (row.source === "manual") return "dashboard capture";
  switch (row.transport) {
    case "codex_app_server": return "Codex local session";
    case "claude_statusline": return "Claude local status";
    case "kimi_acp": return "Kimi API";
    case "grok_local_log": return "Grok local billing";
    case "minimax_api": return "MiniMax API";
    case "gh_cli": return "GitHub API";
    default: return "provider report";
  }
}

function deriveUsedPercent(used: number | null | undefined, limit: number | null | undefined): number | undefined {
  const usedValue = finiteNumber(used);
  const limitValue = finiteNumber(limit);
  if (usedValue === undefined || limitValue === undefined || limitValue <= 0) return undefined;
  return (usedValue / limitValue) * 100;
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatStoredQuotaWindowLabel(row: ServiceQuotaSnapshot): string {
  const explicitDuration = row.label.trim();
  if (/^\d+(?:\.\d+)?[mhd]$/iu.test(explicitDuration)) return explicitDuration;
  if (/\s\d+(?:\.\d+)?[mhd]$/iu.test(explicitDuration)) return explicitDuration;

  const fromDuration = formatWindowMs(finiteNumber(row.windowMs));
  if (fromDuration) return fromDuration;

  const label = explicitDuration.toLowerCase();
  if (label === "monthly" || label === "month" || row.windowKind === "monthly") return "30d";
  if (label === "weekly" || label === "week" || row.windowKind === "secondary") return "7d";
  if (label === "primary" || row.windowKind === "primary") return "5h";
  return row.label;
}

function formatWindowMs(windowMs: number | undefined): string | null {
  if (windowMs === undefined || windowMs <= 0) return null;
  const minutes = Math.round(windowMs / 60_000);
  return formatQuotaWindowLabel(minutes, minutes >= 24 * 60 ? "secondary" : "primary");
}

function quotaWindowSortRank(label: string): number {
  if (label === "5h") return 0;
  if (label === "7d") return 1;
  if (label === "30d" || label === "monthly") return 2;
  return 3;
}

/* ── kimi ───────────────────────────────────────────────────────────── */

type KimiUsageDetail = {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
  resetAt?: unknown;
  reset_at?: unknown;
};

type KimiUsageLimit = {
  detail?: KimiUsageDetail;
  window?: {
    duration?: unknown;
    timeUnit?: unknown;
  };
};

type KimiUsageResponse = {
  usage?: KimiUsageDetail;
  limits?: KimiUsageLimit[];
  user?: {
    membership?: {
      level?: unknown;
    };
  };
};

async function loadKimiGauge(forceRefresh = false): Promise<ServiceGauge | null> {
  const fresh = loadPersistedProviderQuotaGauge({
    id: "kimi",
    label: "kimi",
    provider: "kimi",
    harness: "kimi",
    maxAgeMs: REMOTE_QUOTA_FRESH_MS,
  });
  if (!forceRefresh && fresh && !quotaGaugeAwaitingReset(fresh)) return fresh;
  const persisted = loadPersistedProviderQuotaGauge({
    id: "kimi",
    label: "kimi",
    provider: "kimi",
    harness: "kimi",
    maxAgeMs: WEEK_MS,
  });
  const payload = await readKimiUsageResponse();
  // Kimi OAuth access tokens are short-lived and refreshed by Kimi Code itself.
  // A manual Scout refresh while Kimi is closed should retain the last valid,
  // non-expired provider snapshot rather than blinking the gauge away.
  if (!payload) return persisted;

  const capturedAt = Date.now();
  const snapshots = kimiQuotaSnapshots(payload, capturedAt);
  if (snapshots.length === 0) return persisted;

  persistQuotaSnapshots(snapshots);
  const refreshed = loadPersistedProviderQuotaGauge({
    id: "kimi",
    label: "kimi",
    provider: "kimi",
    harness: "kimi",
    maxAgeMs: WEEK_MS,
  });
  const gauge = refreshed ?? quotaGaugeFromSnapshots({
    id: "kimi",
    label: "kimi",
  }, snapshots);
  const plan = kimiMembershipPlan(payload);
  return gauge?.kind === "quota" && plan ? { ...gauge, plan } : gauge;
}

async function readKimiUsageResponse(): Promise<KimiUsageResponse | null> {
  const fixtureJson = process.env[KIMI_USAGE_JSON_ENV];
  if (fixtureJson?.trim()) {
    const parsed = parseJsonRecord(fixtureJson);
    return parsed as KimiUsageResponse | null;
  }

  const credentials = readKimiCredentials();
  const accessToken = stringValue(credentials?.access_token);
  if (!accessToken) return null;

  let response: Response;
  try {
    response = await fetch("https://api.kimi.com/coding/v1/usages", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(KIMI_USAGE_TIMEOUT_MS),
    });
  } catch (error) {
    debugServiceBudgetProvider("kimi", "usage request failed", error);
    return null;
  }
  if (!response.ok) {
    debugServiceBudgetProvider("kimi", "usage request returned non-success status", {
      status: response.status,
    });
    return null;
  }

  try {
    const parsed = await response.json();
    return recordValue(parsed) as KimiUsageResponse | null;
  } catch (error) {
    debugServiceBudgetProvider("kimi", "usage response was not valid JSON", error);
    return null;
  }
}

function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homeDir(), ".kimi-code");
}

function readKimiCredentials(): Record<string, unknown> | null {
  const candidates = [join(kimiCodeHome(), "credentials", "kimi-code.json")];
  if (!process.env.KIMI_CODE_HOME?.trim()) {
    candidates.push(join(homeDir(), ".kimi", "credentials", "kimi-code.json"));
  }
  for (const path of candidates) {
    const credentials = readJsonRecord(path);
    if (credentials) return credentials;
  }
  return null;
}

function kimiQuotaSnapshots(payload: KimiUsageResponse, capturedAt: number): ServiceQuotaSnapshot[] {
  const planType = kimiMembershipPlan(payload);
  const weekly = kimiQuotaSnapshot(payload.usage, {
    label: "7d",
    windowKind: "secondary",
    windowMs: WEEK_MS,
    capturedAt,
    planType,
  });
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const rolling = limits.flatMap((limit, index) => {
    const windowMs = kimiWindowMs(limit.window);
    if (!limit.detail || !windowMs) return [];
    const label = formatWindowMs(windowMs) ?? `limit-${index + 1}`;
    const snapshot = kimiQuotaSnapshot(limit.detail, {
      label,
      windowKind: label === "5h" ? "primary" : `limit-${index + 1}`,
      windowMs,
      capturedAt,
      planType,
    });
    return snapshot ? [snapshot] : [];
  });
  return [weekly, ...rolling].filter((entry): entry is ServiceQuotaSnapshot => entry !== null);
}

function kimiQuotaSnapshot(
  detail: KimiUsageDetail | undefined,
  options: {
    label: string;
    windowKind: string;
    windowMs: number;
    capturedAt: number;
    planType?: string;
  },
): ServiceQuotaSnapshot | null {
  if (!detail) return null;
  const limit = numericValue(detail.limit);
  const used = numericValue(detail.used);
  const remaining = numericValue(detail.remaining);
  const usedPercent = limit !== undefined && limit > 0
    ? ((used ?? Math.max(0, limit - (remaining ?? limit))) / limit) * 100
    : undefined;
  const percentRemaining = limit !== undefined && limit > 0 && remaining !== undefined
    ? (remaining / limit) * 100
    : usedPercent === undefined
      ? undefined
      : Math.max(0, 100 - usedPercent);
  if (usedPercent === undefined && percentRemaining === undefined) return null;

  const resetAt = timestampMs(detail.resetTime)
    ?? timestampMs(detail.resetAt)
    ?? timestampMs(detail.reset_at)
    ?? options.capturedAt + options.windowMs;
  return {
    provider: "kimi",
    harness: "kimi",
    transport: "kimi_acp",
    planType: options.planType,
    label: options.label,
    windowKind: options.windowKind,
    usedPercent,
    percentRemaining,
    resetAt,
    windowMs: options.windowMs,
    capturedAt: options.capturedAt,
    metadata: {
      source: "service-budgets.kimi-usages",
    },
  };
}

function kimiWindowMs(window: KimiUsageLimit["window"]): number | null {
  const duration = numericValue(window?.duration);
  if (duration === undefined || duration <= 0) return null;
  const unit = stringValue(window?.timeUnit)?.toUpperCase() ?? "";
  if (unit.includes("MINUTE")) return duration * 60_000;
  if (unit.includes("HOUR")) return duration * 60 * 60_000;
  if (unit.includes("DAY")) return duration * 24 * 60 * 60_000;
  if (unit.includes("SECOND")) return duration * 1000;
  return null;
}

function kimiMembershipPlan(payload: KimiUsageResponse): string | undefined {
  const raw = stringValue(payload.user?.membership?.level);
  if (!raw) return undefined;
  return raw
    .replace(/^LEVEL_/u, "")
    .toLowerCase()
    .replace(/(^|_)([a-z])/gu, (_match, prefix: string, letter: string) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

/* ── signed-in dashboard captures + Grok local telemetry ───────────── */

type DashboardUsageProvider = "grok" | "cursor";

type DashboardUsageImport = {
  provider: DashboardUsageProvider;
  capturedAt: number;
  plan?: string;
  periodLabel?: string;
  usedPercent?: number;
  resetAt?: number;
  totalTokens?: number;
  eventCount?: number;
};

type DashboardUsageStore = {
  version: 1;
  providers: Partial<Record<DashboardUsageProvider, DashboardUsageImport>>;
};

export function importProviderDashboardUsage(input: {
  provider: unknown;
  text: unknown;
}): ServiceGauge {
  const provider = input.provider === "grok" || input.provider === "cursor" ? input.provider : null;
  if (!provider) throw new Error("Dashboard import supports Grok or Cursor.");
  if (typeof input.text !== "string" || !input.text.trim()) throw new Error("Paste usage dashboard text or CSV first.");
  if (input.text.length > DASHBOARD_IMPORT_MAX_CHARS) throw new Error("Dashboard capture is too large (128 KB maximum).");

  const capturedAt = Date.now();
  const snapshot = provider === "grok"
    ? parseGrokDashboardImport(input.text, capturedAt)
    : parseCursorDashboardImport(input.text, capturedAt);
  const store = readDashboardUsageStore();
  store.providers[provider] = snapshot;
  writeDashboardUsageStore(store);
  cached = null;

  const gauge = dashboardGauge(snapshot);
  if (!gauge) throw new Error("The dashboard capture did not contain usable usage data.");
  return gauge;
}

function dashboardImportPath(): string {
  return join(dirname(resolveDbPath()), "provider-usage-snapshots.json");
}

function readDashboardUsageStore(): DashboardUsageStore {
  const record = readJsonRecord(dashboardImportPath());
  const providers = recordValue(record?.providers);
  const store: DashboardUsageStore = { version: 1, providers: {} };
  for (const provider of ["grok", "cursor"] as const) {
    const value = recordValue(providers?.[provider]);
    const capturedAt = numericValue(value?.capturedAt);
    if (!capturedAt) continue;
    store.providers[provider] = {
      provider,
      capturedAt,
      plan: stringValue(value?.plan),
      periodLabel: stringValue(value?.periodLabel),
      usedPercent: numericValue(value?.usedPercent),
      resetAt: numericValue(value?.resetAt),
      totalTokens: numericValue(value?.totalTokens),
      eventCount: numericValue(value?.eventCount),
    };
  }
  return store;
}

function writeDashboardUsageStore(store: DashboardUsageStore): void {
  const path = dashboardImportPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function parseGrokDashboardImport(text: string, capturedAt: number): DashboardUsageImport {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const limitIndex = lines.findIndex((line) => /\b(?:weekly|monthly)\b.*\blimit\b/iu.test(line));
  const relevant = limitIndex >= 0 ? lines.slice(limitIndex, limitIndex + 12).join(" ") : text;
  const usedMatch = relevant.match(/(\d+(?:\.\d+)?)\s*%\s*(?:used)?/iu);
  const usedPercent = usedMatch ? Number(usedMatch[1]) : Number.NaN;
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new Error("Could not find Grok's overall percent used. Copy the Usage panel, including its weekly limit.");
  }
  const limitLine = limitIndex >= 0 ? lines[limitIndex]! : "Weekly Grok Limit";
  const periodLabel = /^monthly\b/iu.test(limitLine) ? "30d" : "7d";
  const plan = limitLine
    .replace(/^(?:weekly|monthly)\s+/iu, "")
    .replace(/\s+limit\b.*$/iu, "")
    .trim() || undefined;
  const resetText = relevant.match(/\bresets?\s+(?:on\s+)?(.+?)(?=\s{2,}|\s+(?:product|extra|usage|credits?)\b|$)/iu)?.[1];
  const resetAt = resetText ? Date.parse(resetText) : Number.NaN;
  return {
    provider: "grok",
    capturedAt,
    plan,
    periodLabel,
    usedPercent,
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
  };
}

function parseCursorDashboardImport(text: string, capturedAt: number): DashboardUsageImport {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  let tokenValues: number[] = [];
  let eventCount = 0;
  const headerIndex = lines.findIndex((line) => /\bdate\b/iu.test(line) && /\btokens?\b/iu.test(line) && line.includes(","));
  if (headerIndex >= 0) {
    const header = parseCsvLine(lines[headerIndex]!);
    const tokenIndex = header.findIndex((value) => value.trim().toLowerCase() === "tokens");
    for (const line of lines.slice(headerIndex + 1)) {
      const cells = parseCsvLine(line);
      const tokens = tokenIndex >= 0 ? compactNumber(cells[tokenIndex]) : undefined;
      if (tokens !== undefined) {
        tokenValues.push(tokens);
        eventCount += 1;
      }
    }
  } else {
    tokenValues = lines.flatMap((line) => {
      if (!/^\d[\d,.]*\s*[kmb]?\s*(?:tokens?)?$/iu.test(line)) return [];
      const value = compactNumber(line.replace(/\s*tokens?$/iu, ""));
      return value === undefined ? [] : [value];
    });
    eventCount = tokenValues.length;
  }
  if (tokenValues.length === 0) {
    throw new Error("Could not find Cursor token rows. Paste the exported usage CSV or the copied usage table.");
  }
  const plan = text.match(/\b(pro\s+plus|pro|ultra|business|hobby)\b/iu)?.[1]
    ?.replace(/\b\w/gu, (letter) => letter.toUpperCase());
  return {
    provider: "cursor",
    capturedAt,
    plan,
    periodLabel: /last\s+30\s+days/iu.test(text) ? "30d" : /last\s+7\s+days/iu.test(text) ? "7d" : "captured range",
    totalTokens: tokenValues.reduce((sum, value) => sum + value, 0),
    eventCount,
  };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function compactNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().replace(/,/gu, "").match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/iu);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === "b" ? 1_000_000_000
    : match[2]?.toLowerCase() === "m" ? 1_000_000
      : match[2]?.toLowerCase() === "k" ? 1_000
        : 1;
  return amount * multiplier;
}

function dashboardGauge(snapshot: DashboardUsageImport): ServiceGauge | null {
  if (snapshot.provider === "grok" && snapshot.usedPercent !== undefined) {
    const windowMs = snapshot.periodLabel === "30d" ? 30 * 24 * 3600_000 : WEEK_MS;
    const quota = quotaGaugeFromSnapshots({ id: "grok", label: "grok", allowExpiredWindows: true }, [{
      source: "manual",
      provider: "xai",
      harness: "grok",
      transport: "dashboard_import",
      planType: snapshot.plan,
      label: snapshot.periodLabel ?? "7d",
      windowKind: "subscription",
      usedPercent: snapshot.usedPercent,
      percentRemaining: 100 - snapshot.usedPercent,
      resetAt: snapshot.resetAt ?? snapshot.capturedAt + windowMs,
      windowMs,
      capturedAt: snapshot.capturedAt,
      metadata: { source: "service-budgets.grok-dashboard" },
    }]);
    return quota;
  }
  if (snapshot.provider === "cursor" && snapshot.totalTokens !== undefined) {
    const eventCount = Math.max(0, Math.round(snapshot.eventCount ?? 0));
    return {
      id: "cursor",
      label: "cursor",
      kind: "status",
      statusLabel: snapshot.plan ?? "Cursor dashboard",
      windowLabel: snapshot.periodLabel,
      detailLabel: `${eventCount} ${eventCount === 1 ? "event" : "events"} · ${formatTokenCount(snapshot.totalTokens)} tokens`,
      tone: "ok",
      capturedAt: snapshot.capturedAt,
      source: "dashboard capture",
    };
  }
  return null;
}

type GrokLocalUsage = {
  capturedAt: number;
  totalTokens: number;
  turns: number;
  modelCalls: number;
};

async function loadGrokGauge(): Promise<ServiceGauge | null> {
  const billingSnapshots = await loadGrokBillingQuotaSnapshots();
  if (billingSnapshots.length > 0) {
    persistQuotaSnapshots(billingSnapshots);
    const persisted = loadPersistedProviderQuotaGauge({
      id: "grok",
      label: "grok",
      provider: "xai",
      harness: "grok",
      maxAgeMs: WEEK_MS,
    });
    if (persisted) return persisted;
    const direct = quotaGaugeFromSnapshots({
      id: "grok",
      label: "grok",
      maxCurrentAgeMs: WEEK_MS,
    }, billingSnapshots);
    if (direct) return direct;
  }

  const imported = readDashboardUsageStore().providers.grok;
  const dashboard = imported ? dashboardGauge(imported) : null;
  if (dashboard) return dashboard;

  const sessions = loadGrokLocalUsage();
  if (sessions.length === 0) return null;
  const totalTokens = sessions.reduce((sum, usage) => sum + usage.totalTokens, 0);
  const turns = sessions.reduce((sum, usage) => sum + usage.turns, 0);
  const modelCalls = sessions.reduce((sum, usage) => sum + usage.modelCalls, 0);
  return {
    id: "grok",
    label: "grok",
    kind: "status",
    statusLabel: "Local activity",
    windowLabel: "observed 7d",
    detailLabel: `${formatTokenCount(totalTokens)} tokens · ${turns} turns · ${modelCalls} model calls`,
    tone: "dim",
    capturedAt: Math.max(...sessions.map((usage) => usage.capturedAt)),
    source: "Grok local telemetry",
  };
}

async function loadGrokBillingQuotaSnapshots(): Promise<ServiceQuotaSnapshot[]> {
  const path = join(homeDir(), ".grok", "logs", "unified.jsonl");
  const stat = safeStat(path);
  if (!stat || stat.size <= 0) return [];

  const length = Math.min(stat.size, GROK_BILLING_LOG_MAX_BYTES);
  const start = Math.max(0, stat.size - length);
  let content = "";
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    content = buffer.subarray(0, offset).toString("utf8");
  } catch (error) {
    debugServiceBudgetProvider("grok", "local billing log could not be read", error);
    return [];
  } finally {
    await handle?.close();
  }

  if (start > 0) {
    const firstNewline = content.indexOf("\n");
    content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
  }

  return content
    .split(/\r?\n/u)
    .flatMap((line) => {
      if (!line.includes('"billing: fetched credits config"')) return [];
      const snapshot = grokBillingQuotaSnapshot(parseJsonRecord(line));
      return snapshot ? [snapshot] : [];
    })
    .sort((left, right) => left.capturedAt - right.capturedAt)
    .slice(-PERSISTED_QUOTA_ROW_LIMIT);
}

function grokBillingQuotaSnapshot(record: Record<string, unknown> | null): ServiceQuotaSnapshot | null {
  if (!record || stringValue(record.msg) !== "billing: fetched credits config") return null;
  const context = recordValue(record.ctx);
  const config = recordValue(context?.config);
  const usedPercent = numericValue(config?.creditUsagePercent);
  if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return null;

  const capturedAt = timestampMs(record.ts) ?? Date.now();
  const period = recordValue(config?.currentPeriod);
  const startAt = timestampMs(period?.start) ?? timestampMs(config?.billingPeriodStart);
  const resetAt = timestampMs(period?.end) ?? timestampMs(config?.billingPeriodEnd);
  const periodType = stringValue(period?.type)?.toUpperCase() ?? "";
  const inferredWindowMs = periodType.includes("MONTH") ? 30 * 24 * 3600_000 : WEEK_MS;
  const windowMs = startAt !== undefined && resetAt !== undefined && resetAt > startAt
    ? resetAt - startAt
    : inferredWindowMs;
  const label = periodType.includes("MONTH") ? "30d"
    : periodType.includes("WEEK") ? "7d"
      : formatWindowMs(windowMs) ?? "quota";

  return {
    source: "provider_reported",
    provider: "xai",
    harness: "grok",
    transport: "grok_local_log",
    planType: stringValue(context?.subscriptionTier) ?? stringValue(config?.subscriptionTier),
    label,
    windowKind: "subscription",
    usedPercent,
    percentRemaining: 100 - usedPercent,
    resetAt: resetAt ?? capturedAt + windowMs,
    windowMs,
    capturedAt,
    metadata: {
      source: "service-budgets.grok-billing-log",
    },
  };
}

function loadGrokLocalUsage(): GrokLocalUsage[] {
  const fixture = process.env[GROK_USAGE_JSON_ENV];
  if (fixture?.trim()) {
    const parsed = parseJsonRecord(fixture);
    const usage = grokUsageFromRecord(parsed, Date.now());
    return usage ? [usage] : [];
  }
  const root = join(homeDir(), ".grok", "sessions");
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - WEEK_MS;
  const paths: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === "updates.jsonl" && (safeStat(path)?.mtimeMs ?? 0) >= cutoff) paths.push(path);
    }
  };
  walk(root);
  return paths.flatMap((path) => {
    let latest: GrokLocalUsage | null = null;
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
        if (!line.includes('"usage"')) continue;
        const record = parseJsonRecord(line);
        const usage = grokUsageFromRecord(record, safeStat(path)?.mtimeMs ?? Date.now());
        if (usage && (!latest || usage.capturedAt >= latest.capturedAt)) latest = usage;
      }
    } catch {
      return [];
    }
    return latest ? [latest] : [];
  });
}

function grokUsageFromRecord(record: Record<string, unknown> | null, fallbackCapturedAt: number): GrokLocalUsage | null {
  if (!record) return null;
  const params = recordValue(record.params);
  const update = recordValue(params?.update);
  const usage = recordValue(update?.usage) ?? recordValue(record.usage) ?? update;
  const totalTokens = numericValue(usage?.totalTokens)
    ?? ((numericValue(usage?.inputTokens) ?? 0) + (numericValue(usage?.outputTokens) ?? 0));
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  return {
    capturedAt: timestampMs(record.timestamp) ?? fallbackCapturedAt,
    totalTokens,
    turns: numericValue(usage?.numTurns) ?? 0,
    modelCalls: numericValue(usage?.modelCalls) ?? 0,
  };
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

/* ── cursor ─────────────────────────────────────────────────────────── */

type CursorSubscriptionState = {
  membershipType?: unknown;
  subscriptionStatus?: unknown;
};

async function loadCursorGauge(): Promise<ServiceGauge | null> {
  const state = readCursorSubscriptionState();
  const membership = stringValue(state?.membershipType);
  const subscriptionStatus = stringValue(state?.subscriptionStatus);
  const imported = readDashboardUsageStore().providers.cursor;
  const dashboard = imported ? dashboardGauge(imported) : null;
  if (!membership && !subscriptionStatus) return dashboard;

  const normalizedStatus = subscriptionStatus?.trim().toLowerCase();
  const dashboardDetail = dashboard?.kind === "status" ? dashboard.detailLabel : undefined;
  return {
    id: "cursor",
    label: "cursor",
    kind: "status",
    statusLabel: cursorMembershipLabel(membership) ?? "Cursor",
    windowLabel: "subscription",
    detailLabel: dashboardDetail ?? (normalizedStatus ? cursorMembershipLabel(normalizedStatus) ?? normalizedStatus : "detected locally"),
    tone: normalizedStatus === "active"
      ? "ok"
      : normalizedStatus?.includes("cancel") || normalizedStatus?.includes("past")
        ? "warn"
        : "dim",
    ...(dashboard?.capturedAt ? { capturedAt: dashboard.capturedAt } : {}),
    source: dashboard?.source ?? "Cursor local membership",
  };
}

function readCursorSubscriptionState(): CursorSubscriptionState | null {
  const fixtureJson = process.env[CURSOR_STATUS_JSON_ENV];
  if (fixtureJson?.trim()) {
    return parseJsonRecord(fixtureJson) as CursorSubscriptionState | null;
  }

  const candidates = [
    join(homeDir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(homeDir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let cursorDb: Database | null = null;
    try {
      cursorDb = new Database(path, { readonly: true });
      const readValue = (key: string): unknown => cursorDb?.query<{ value: unknown }, [string]>(
        "SELECT value FROM ItemTable WHERE key = ?1 LIMIT 1",
      ).get(key)?.value;
      const membershipType = readValue("cursorAuth/stripeMembershipType");
      const subscriptionStatus = readValue("cursorAuth/stripeSubscriptionStatus");
      if (membershipType !== undefined || subscriptionStatus !== undefined) {
        return { membershipType, subscriptionStatus };
      }
    } catch (error) {
      debugServiceBudgetProvider("cursor", "local subscription state could not be read", error);
    } finally {
      cursorDb?.close();
    }
  }
  return null;
}

function cursorMembershipLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .trim()
    .replace(/\+/gu, " plus ")
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

/* ── minimax ───────────────────────────────────────────────────────── */

type MinimaxRemainsModel = {
  model_name?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  current_interval_total_count?: unknown;
  current_interval_usage_count?: unknown;
  current_interval_remaining_percent?: unknown;
  weekly_start_time?: unknown;
  weekly_end_time?: unknown;
  current_weekly_total_count?: unknown;
  current_weekly_usage_count?: unknown;
  current_weekly_remaining_percent?: unknown;
};

type MinimaxRemainsResponse = {
  model_remains?: MinimaxRemainsModel[];
  base_resp?: {
    status_code?: unknown;
    status_msg?: unknown;
  };
};

async function loadMinimaxGauge(forceRefresh = false): Promise<ServiceGauge | null> {
  const fresh = loadPersistedProviderQuotaGauge({
    id: "minimax",
    label: "minimax",
    provider: "minimax",
    harness: "minimax",
    maxAgeMs: REMOTE_QUOTA_FRESH_MS,
  });
  if (!forceRefresh && fresh && !quotaGaugeAwaitingReset(fresh)) return fresh;
  const persisted = loadPersistedProviderQuotaGauge({
    id: "minimax",
    label: "minimax",
    provider: "minimax",
    harness: "minimax",
    maxAgeMs: WEEK_MS,
  });
  const payload = await readMinimaxRemainsResponse();
  if (!payload) return persisted;

  const capturedAt = Date.now();
  const snapshots = minimaxQuotaSnapshots(payload, capturedAt);
  if (snapshots.length === 0) return persisted;
  persistQuotaSnapshots(snapshots);
  return loadPersistedProviderQuotaGauge({
    id: "minimax",
    label: "minimax",
    provider: "minimax",
    harness: "minimax",
    maxAgeMs: WEEK_MS,
  }) ?? quotaGaugeFromSnapshots({ id: "minimax", label: "minimax" }, snapshots);
}

async function readMinimaxRemainsResponse(): Promise<MinimaxRemainsResponse | null> {
  const fixtureJson = process.env[MINIMAX_REMAINS_JSON_ENV];
  if (fixtureJson?.trim()) {
    return parseJsonRecord(fixtureJson) as MinimaxRemainsResponse | null;
  }

  const apiKey = process.env.MINIMAX_API_KEY?.trim()
    || process.env.MINIMAX_TOKEN?.trim()
    || buildPiRpcCredentialEnv({ provider: "minimax" })?.MINIMAX_API_KEY;
  if (!apiKey) return null;

  let response: Response;
  try {
    response = await fetch("https://www.minimax.io/v1/token_plan/remains", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(MINIMAX_REMAINS_TIMEOUT_MS),
    });
  } catch (error) {
    debugServiceBudgetProvider("minimax", "Token Plan request failed", error);
    return null;
  }
  if (!response.ok) {
    debugServiceBudgetProvider("minimax", "Token Plan request returned non-success status", { status: response.status });
    return null;
  }

  try {
    const parsed = recordValue(await response.json()) as MinimaxRemainsResponse | null;
    if (numericValue(parsed?.base_resp?.status_code) !== 0) {
      debugServiceBudgetProvider("minimax", "Token Plan response reported an error", {
        status: parsed?.base_resp?.status_code,
        message: parsed?.base_resp?.status_msg,
      });
      return null;
    }
    return parsed;
  } catch (error) {
    debugServiceBudgetProvider("minimax", "Token Plan response was not valid JSON", error);
    return null;
  }
}

function minimaxQuotaSnapshots(payload: MinimaxRemainsResponse, capturedAt: number): ServiceQuotaSnapshot[] {
  return (Array.isArray(payload.model_remains) ? payload.model_remains : []).flatMap((model, index) => {
    const modelName = stringValue(model.model_name) ?? `model-${index + 1}`;
    const prefix = modelName.toLowerCase() === "general" ? "" : `${modelName} `;
    const intervalStartAt = timestampMs(model.start_time);
    const intervalEndAt = timestampMs(model.end_time);
    const intervalLabel = formatWindowMs(
      intervalStartAt !== undefined && intervalEndAt !== undefined ? intervalEndAt - intervalStartAt : undefined,
    ) ?? "5h";
    return [
      minimaxQuotaSnapshot(model, {
        label: `${prefix}${intervalLabel}`,
        windowKind: `${modelName}:primary`,
        startAt: model.start_time,
        endAt: model.end_time,
        total: model.current_interval_total_count,
        used: model.current_interval_usage_count,
        remainingPercent: model.current_interval_remaining_percent,
        capturedAt,
      }),
      minimaxQuotaSnapshot(model, {
        label: `${prefix}7d`,
        windowKind: `${modelName}:secondary`,
        startAt: model.weekly_start_time,
        endAt: model.weekly_end_time,
        total: model.current_weekly_total_count,
        used: model.current_weekly_usage_count,
        remainingPercent: model.current_weekly_remaining_percent,
        capturedAt,
      }),
    ].filter((entry): entry is ServiceQuotaSnapshot => entry !== null);
  });
}

function minimaxQuotaSnapshot(
  model: MinimaxRemainsModel,
  input: {
    label: string;
    windowKind: string;
    startAt: unknown;
    endAt: unknown;
    total: unknown;
    used: unknown;
    remainingPercent: unknown;
    capturedAt: number;
  },
): ServiceQuotaSnapshot | null {
  const remainingPercent = numericValue(input.remainingPercent);
  const total = numericValue(input.total);
  const used = numericValue(input.used);
  if (remainingPercent === undefined && (total === undefined || used === undefined)) return null;
  const resetAt = timestampMs(input.endAt) ?? input.capturedAt + (input.windowKind.endsWith(":primary") ? 5 * 3600_000 : WEEK_MS);
  const startAt = timestampMs(input.startAt);
  const windowMs = startAt === undefined ? resetAt - input.capturedAt : resetAt - startAt;
  return {
    provider: "minimax",
    harness: "minimax",
    transport: "minimax_api",
    planType: "Token Plan",
    label: input.label,
    windowKind: input.windowKind,
    usedPercent: remainingPercent === undefined ? undefined : 100 - remainingPercent,
    percentRemaining: remainingPercent,
    used: total && total > 0 ? used : undefined,
    limitValue: total && total > 0 ? total : undefined,
    resetAt,
    windowMs,
    capturedAt: input.capturedAt,
    metadata: {
      source: "service-budgets.minimax-token-plan",
      modelName: stringValue(model.model_name),
    },
  };
}

/* ── github ───────────────────────────────────────────────────────────────── */

type GhRateLimitResponse = {
  resources?: {
    core?: { limit?: number; remaining?: number; reset?: number };
  };
};

async function loadGithubGauge(forceRefresh = false): Promise<ServiceGauge | null> {
  const fresh = loadPersistedProviderQuotaGauge({
    id: "github",
    label: "github",
    provider: "github",
    harness: "github",
    maxAgeMs: 15 * 60 * 1000,
  });
  if (!forceRefresh && fresh && !quotaGaugeAwaitingReset(fresh)) return fresh;

  let stdout: string;
  const fixtureJson = process.env[GH_RATE_LIMIT_JSON_ENV];
  if (fixtureJson?.trim()) {
    stdout = fixtureJson;
  } else {
    try {
      const ghBin = process.env[GH_CLI_BIN_ENV] || "gh";
      const result = await execSystemFile(ghBin, ["api", "rate_limit"], {
        env: { ...process.env },
        timeoutMs: GH_CLI_TIMEOUT_MS,
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 128 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      debugServiceBudgetProvider("github", "gh api failed", error);
      return null;
    }
  }

  let parsed: GhRateLimitResponse;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    debugServiceBudgetProvider("github", "gh api returned invalid json", { error, stdout });
    return null;
  }

  const core = parsed.resources?.core;
  if (!core || typeof core.limit !== "number" || typeof core.remaining !== "number") {
    debugServiceBudgetProvider("github", "gh api missing core rate limit", parsed);
    return null;
  }

  const snapshot = githubQuotaSnapshot(core, Date.now());
  if (!snapshot) {
    debugServiceBudgetProvider("github", "core rate limit could not become a snapshot", core);
    return null;
  }

  persistQuotaSnapshots([snapshot]);
  const persisted = loadPersistedProviderQuotaGauge({
    id: "github",
    label: "github",
    provider: "github",
    harness: "github",
    maxAgeMs: 15 * 60 * 1000,
  });
  if (persisted) return persisted;
  return quotaGaugeFromSnapshots({
    id: "github",
    label: "github",
  }, [snapshot]);
}

function githubQuotaSnapshot(
  core: NonNullable<NonNullable<GhRateLimitResponse["resources"]>["core"]>,
  capturedAt: number,
): ServiceQuotaSnapshot | null {
  if (typeof core.limit !== "number" || typeof core.remaining !== "number") {
    return null;
  }
  const limit = core.limit;
  const used = Math.max(0, limit - core.remaining);
  const resetAt = timestampMs(core.reset) ?? capturedAt + 3600 * 1000;

  return {
    provider: "github",
    harness: "github",
    transport: "gh_cli",
    label: "1h",
    windowKind: "primary",
    usedPercent: limit > 0 ? (used / limit) * 100 : undefined,
    percentRemaining: limit > 0 ? (core.remaining / limit) * 100 : undefined,
    used,
    limitValue: limit,
    resetAt,
    windowMs: Math.max(0, resetAt - capturedAt),
    capturedAt,
    metadata: {
      source: "service-budgets.gh-rate-limit",
      resource: "core",
      unitLabel: "req",
    },
  };
}

function detectCloudAccounts(): CloudAccount[] {
  const accounts: CloudAccount[] = [];
  const declaredAccounts = readJsonRecord(join(homeDir(), ".scout", "provider-accounts.json"));
  const exeAccount = recordValue(declaredAccounts?.exe);
  if (exeAccount && stringValue(exeAccount.status)?.toLowerCase() !== "inactive") {
    accounts.push({
      id: "exe",
      label: "exe.dev",
      statusLabel: "Connected",
      detailLabel: stringValue(exeAccount.detail) ?? "Persistent VMs for remote agents",
    });
  }
  const cloudflareConfig = [
    join(homeDir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
    join(homeDir(), ".wrangler", "config", "default.toml"),
    join(homeDir(), ".config", ".wrangler", "config", "default.toml"),
  ].find((path) => fileContainsAny(path, ["oauth_token", "api_token"]));
  if (cloudflareConfig) {
    accounts.push({
      id: "cloudflare",
      label: "Cloudflare",
      statusLabel: "Connected",
      detailLabel: "Wrangler account detected",
    });
  }

  const vercelConfig = [
    join(homeDir(), "Library", "Application Support", "com.vercel.cli", "config.json"),
    join(homeDir(), ".config", "com.vercel.cli", "config.json"),
  ].map((path) => readJsonRecord(path)).find((record) => Boolean(stringValue(record?.currentTeam)));
  const vercelAuth = existsSync(join(homeDir(), ".local", "share", "com.vercel.cli", "auth.json"));
  if (vercelConfig || vercelAuth) {
    accounts.push({
      id: "vercel",
      label: "Vercel",
      statusLabel: "Connected",
      detailLabel: "Vercel account detected",
    });
  }
  return accounts;
}

function fileContainsAny(path: string, needles: string[]): boolean {
  try {
    const content = readFileSync(path, "utf8");
    return needles.some((needle) => content.includes(needle));
  } catch {
    return false;
  }
}

function formatRequestCount(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/* ── shared ─────────────────────────────────────────────────────────── */

function persistQuotaSnapshots(snapshots: ServiceQuotaSnapshot[]): void {
  if (snapshots.length === 0) return;

  try {
    const writer = webDb();
    const statement = writer.query(
      `INSERT INTO budget_quota_window_snapshots (
        id, source, provider, harness, transport, model, agent_id, endpoint_id,
        session_id, user_id, account_id, plan_type, label, window_kind,
        used_percent, percent_remaining, used, limit_value, reset_at, window_ms,
        captured_at, metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL,
        NULL, NULL, NULL, ?6, ?7, ?8,
        ?9, ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17
      )
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        provider = excluded.provider,
        harness = excluded.harness,
        transport = excluded.transport,
        plan_type = excluded.plan_type,
        label = excluded.label,
        window_kind = excluded.window_kind,
        used_percent = excluded.used_percent,
        percent_remaining = excluded.percent_remaining,
        used = excluded.used,
        limit_value = excluded.limit_value,
        reset_at = excluded.reset_at,
        window_ms = excluded.window_ms,
        captured_at = excluded.captured_at,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at`,
    );
    const readExisting = writer.query<{
      usedPercent: number | null;
      percentRemaining: number | null;
      used: number | null;
      limitValue: number | null;
      resetAt: number | null;
    }, [string]>(
      `SELECT
        used_percent AS usedPercent,
        percent_remaining AS percentRemaining,
        used,
        limit_value AS limitValue,
        reset_at AS resetAt
      FROM budget_quota_window_snapshots
      WHERE id = ?1
      LIMIT 1`,
    );
    const pruneHistory = writer.query(
      `DELETE FROM budget_quota_window_snapshots
      WHERE id LIKE '${QUOTA_HISTORY_ID_PREFIX}%'
        AND captured_at < ?1`,
    );

    const createdAt = Date.now();
    const writeSnapshot = (
      id: string,
      snapshot: ServiceQuotaSnapshot,
      metadata: Record<string, unknown> | undefined,
    ): void => {
      const existing = readExisting.get(id);
      if (existing && !quotaSnapshotMayReplace(existing, snapshot)) return;
      statement.run(
        id,
        snapshot.source ?? "provider_reported",
        snapshot.provider ?? null,
        snapshot.harness ?? null,
        snapshot.transport ?? null,
        snapshot.planType ?? null,
        snapshot.label,
        snapshot.windowKind ?? null,
        finiteNumber(snapshot.usedPercent) ?? null,
        finiteNumber(snapshot.percentRemaining) ?? null,
        finiteNumber(snapshot.used) ?? null,
        finiteNumber(snapshot.limitValue) ?? null,
        finiteNumber(snapshot.resetAt) ?? null,
        finiteNumber(snapshot.windowMs) ?? null,
        snapshot.capturedAt,
        JSON.stringify(metadata ?? {}),
        createdAt,
      );
    };

    // A provider can yield hundreds of history samples. Letting every
    // read/insert auto-commit held the web event loop for most of a second and
    // made unrelated navigation wait behind the home budget poll. One SQLite
    // transaction preserves the same monotonic replacement rules while paying
    // the WAL commit cost once.
    writer.transaction(() => {
      for (const snapshot of snapshots) {
        writeSnapshot(quotaSnapshotId(snapshot), snapshot, snapshot.metadata);
        writeSnapshot(quotaHistorySnapshotId(snapshot), snapshot, quotaHistoryMetadata(snapshot));
      }
      pruneHistory.run(createdAt - QUOTA_HISTORY_LOOKBACK_MS - QUOTA_HISTORY_BUCKET_MS);
    })();
  } catch {
    // Quota harvesting is best-effort; the direct readers still return a UI
    // gauge when the write fails.
  }
}

function quotaSnapshotMayReplace(
  existing: Pick<ServiceQuotaSnapshot, "usedPercent" | "percentRemaining" | "used" | "limitValue" | "resetAt">,
  incoming: ServiceQuotaSnapshot,
): boolean {
  const existingResetAt = finiteNumber(existing.resetAt);
  const incomingResetAt = finiteNumber(incoming.resetAt);
  if (existingResetAt !== undefined && incomingResetAt !== undefined && existingResetAt !== incomingResetAt) {
    return incomingResetAt > existingResetAt;
  }
  const existingFill = quotaSnapshotUsage({ ...existing, label: "", capturedAt: 0 })?.fill;
  const incomingFill = quotaSnapshotUsage(incoming)?.fill;
  if (existingFill !== undefined && incomingFill !== undefined) return incomingFill >= existingFill;
  return true;
}

function quotaSnapshotId(snapshot: ServiceQuotaSnapshot): string {
  return `budget:quota:${stableHash([
    "service-budgets",
    snapshot.provider ?? "",
    snapshot.harness ?? "",
    quotaSnapshotWindowKey(snapshot),
  ])}`;
}

function quotaHistorySnapshotId(snapshot: ServiceQuotaSnapshot): string {
  return `${QUOTA_HISTORY_ID_PREFIX}${stableHash([
    "service-budgets",
    "history",
    snapshot.provider ?? "",
    snapshot.harness ?? "",
    quotaSnapshotWindowKey(snapshot),
    finiteNumber(snapshot.resetAt) ?? 0,
    Math.floor(snapshot.capturedAt / QUOTA_HISTORY_BUCKET_MS),
  ])}`;
}

function quotaHistoryMetadata(snapshot: ServiceQuotaSnapshot): Record<string, unknown> {
  const bucket = Math.floor(snapshot.capturedAt / QUOTA_HISTORY_BUCKET_MS);
  return {
    ...(snapshot.metadata ?? {}),
    historyBucketMs: QUOTA_HISTORY_BUCKET_MS,
    historyBucketStartAt: bucket * QUOTA_HISTORY_BUCKET_MS,
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

function timestampMs(value: unknown): number | undefined {
  const normalized = epochMs(value);
  if (normalized !== null) return normalized;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim().replace(/%$/u, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return recordValue(JSON.parse(value)) ?? null;
  } catch {
    return null;
  }
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  try {
    return parseJsonRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseMetadataJson(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function homeDir(): string {
  return process.env.HOME?.trim() || homedir();
}

function safeStat(path: string): { mtimeMs: number; size: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
