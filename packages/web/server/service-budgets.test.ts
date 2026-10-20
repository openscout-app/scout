import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "./db/internal/db.ts";
import {
  importProviderDashboardUsage,
  loadServiceBudgets,
  resetServiceBudgetsCache,
} from "./service-budgets.ts";

const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalHome = process.env.HOME;
const fixtureHomeKeys = ["SCOUT_HOME", "OPENSCOUT_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;
const originalFixtureHomes = Object.fromEntries(fixtureHomeKeys.map(key => [key, process.env[key]]));
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalPath = process.env.PATH;
const originalGhBin = process.env.OPENSCOUT_GH_BIN;
const originalGhRateLimitJson = process.env.OPENSCOUT_GH_RATE_LIMIT_JSON;
const originalKimiCodeHome = process.env.KIMI_CODE_HOME;
const originalKimiUsageJson = process.env.OPENSCOUT_KIMI_USAGE_JSON;
const originalCursorStatusJson = process.env.OPENSCOUT_CURSOR_STATUS_JSON;
const originalGrokUsageJson = process.env.OPENSCOUT_GROK_USAGE_JSON;
const originalMinimaxApiKey = process.env.MINIMAX_API_KEY;
const originalMinimaxToken = process.env.MINIMAX_TOKEN;
const originalMinimaxRemainsJson = process.env.OPENSCOUT_MINIMAX_REMAINS_JSON;
const tempPaths = new Set<string>();

beforeEach(() => {
  // Each case supplies HOME; do not scan the launching agent's harness stores.
  for (const key of fixtureHomeKeys) delete process.env[key];
  delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_TOKEN;
  delete process.env.OPENSCOUT_MINIMAX_REMAINS_JSON;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalFixtureHomes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  resetServiceBudgetsCache();

  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalGhBin === undefined) {
    delete process.env.OPENSCOUT_GH_BIN;
  } else {
    process.env.OPENSCOUT_GH_BIN = originalGhBin;
  }
  if (originalGhRateLimitJson === undefined) {
    delete process.env.OPENSCOUT_GH_RATE_LIMIT_JSON;
  } else {
    process.env.OPENSCOUT_GH_RATE_LIMIT_JSON = originalGhRateLimitJson;
  }
  if (originalKimiCodeHome === undefined) {
    delete process.env.KIMI_CODE_HOME;
  } else {
    process.env.KIMI_CODE_HOME = originalKimiCodeHome;
  }
  if (originalKimiUsageJson === undefined) {
    delete process.env.OPENSCOUT_KIMI_USAGE_JSON;
  } else {
    process.env.OPENSCOUT_KIMI_USAGE_JSON = originalKimiUsageJson;
  }
  if (originalCursorStatusJson === undefined) {
    delete process.env.OPENSCOUT_CURSOR_STATUS_JSON;
  } else {
    process.env.OPENSCOUT_CURSOR_STATUS_JSON = originalCursorStatusJson;
  }
  if (originalGrokUsageJson === undefined) {
    delete process.env.OPENSCOUT_GROK_USAGE_JSON;
  } else {
    process.env.OPENSCOUT_GROK_USAGE_JSON = originalGrokUsageJson;
  }
  if (originalMinimaxApiKey === undefined) {
    delete process.env.MINIMAX_API_KEY;
  } else {
    process.env.MINIMAX_API_KEY = originalMinimaxApiKey;
  }
  if (originalMinimaxToken === undefined) {
    delete process.env.MINIMAX_TOKEN;
  } else {
    process.env.MINIMAX_TOKEN = originalMinimaxToken;
  }
  if (originalMinimaxRemainsJson === undefined) {
    delete process.env.OPENSCOUT_MINIMAX_REMAINS_JSON;
  } else {
    process.env.OPENSCOUT_MINIMAX_REMAINS_JSON = originalMinimaxRemainsJson;
  }
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function createQuotaTable(rawDb: Database): void {
  rawDb.exec(`
    CREATE TABLE budget_quota_window_snapshots (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      provider TEXT,
      harness TEXT,
      transport TEXT,
      model TEXT,
      agent_id TEXT,
      endpoint_id TEXT,
      session_id TEXT,
      user_id TEXT,
      account_id TEXT,
      plan_type TEXT,
      label TEXT NOT NULL,
      window_kind TEXT,
      used_percent REAL,
      percent_remaining REAL,
      used REAL,
      limit_value REAL,
      reset_at INTEGER,
      window_ms INTEGER,
      captured_at INTEGER NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

// Rows the web server harvested land in its own database, not the broker's.
function countWebStateRows(controlHome: string, sql: string): number | undefined {
  const database = new Database(join(controlHome, "web-state.sqlite"), { readonly: true });
  try {
    return database.query<{ count: number }, []>(sql).get()?.count;
  } finally {
    database.close();
  }
}

describe("service budgets", () => {
  test("uses Claude statusline hook capture for quota windows", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-claude-statusline-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const statuslineDir = join(home, "Library", "Application Support", "OpenScout", "runtime", "statusline");
    mkdirSync(statuslineDir, { recursive: true });
    // Keep latest and one-minute history in the same hourly history bucket so
    // this assertion does not change during the first minute of an hour.
    const historyBucketMs = 60 * 60 * 1000;
    const now = Math.floor(Date.now() / historyBucketMs) * historyBucketMs + 2 * 60 * 1000;
    const latest = {
      session_id: "claude-statusline-session",
      cwd: "/repo",
      model: { id: "claude-opus-4-8[1m]", display_name: "Opus 4.8" },
      context_window: {
        total_input_tokens: 313_707,
        total_output_tokens: 755,
        used_percentage: 31,
        remaining_percentage: 69,
      },
      rate_limits: {
        five_hour: {
          used_percentage: 11,
          resets_at: Math.floor((now + 5 * 60 * 60 * 1000) / 1000),
        },
        seven_day: {
          used_percentage: 70,
          resets_at: Math.floor((now + 7 * 24 * 60 * 60 * 1000) / 1000),
        },
      },
      openscoutCapturedAt: now,
    };
    writeFileSync(join(statuslineDir, "claude-latest.json"), JSON.stringify(latest), "utf8");
    writeFileSync(join(statuslineDir, "claude-history.jsonl"), JSON.stringify({
      ...latest,
      rate_limits: {
        five_hour: { ...latest.rate_limits.five_hour, used_percentage: 9 },
        seven_day: { ...latest.rate_limits.seven_day, used_percentage: 68 },
      },
      openscoutCapturedAt: now - 60_000,
    }) + "\n", "utf8");

    const response = await loadServiceBudgets(true);
    const claude = response.gauges.find((gauge) => gauge.id === "claude");

    expect(claude).toEqual(expect.objectContaining({
      id: "claude",
      label: "claude",
      kind: "quota",
      usedLabel: "70%",
      capLabel: "100%",
      unitLabel: "7d",
    }));
    expect(claude && claude.kind === "quota" ? claude.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "11%" }),
      expect.objectContaining({ label: "7d", usedLabel: "70%" }),
    ]);
    expect(countWebStateRows(
      controlHome,
      "SELECT count(*) AS count FROM budget_quota_window_snapshots WHERE provider = 'anthropic' AND harness = 'claude'",
    )).toBe(4);
    rawDb.close();
  });

  test("uses stale Claude statusline quota history when the latest tick only has context", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-claude-statusline-stale-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const statuslineDir = join(home, "Library", "Application Support", "OpenScout", "runtime", "statusline");
    mkdirSync(statuslineDir, { recursive: true });
    const now = Date.now();
    const latest = {
      session_id: "claude-statusline-session",
      cwd: "/repo",
      model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      context_window: {
        total_input_tokens: 78_572,
        total_output_tokens: 1_413,
        used_percentage: 8,
        remaining_percentage: 92,
      },
      openscoutCapturedAt: now,
    };
    writeFileSync(join(statuslineDir, "claude-latest.json"), JSON.stringify(latest), "utf8");
    writeFileSync(join(statuslineDir, "claude-history.jsonl"), JSON.stringify({
      ...latest,
      rate_limits: {
        five_hour: {
          used_percentage: 28,
          resets_at: Math.floor((now - 90_000) / 1000),
        },
        seven_day: {
          used_percentage: 47,
          resets_at: Math.floor((now - 60_000) / 1000),
        },
      },
      openscoutCapturedAt: now - 120_000,
    }) + "\n", "utf8");

    const response = await loadServiceBudgets(true);
    const claude = response.gauges.find((gauge) => gauge.id === "claude");

    // Both resets have passed since that reading: the windows rolled over, so
    // the pre-reset 28% / 47% are no longer current usage.
    expect(claude).toEqual(expect.objectContaining({
      id: "claude",
      label: "claude",
      kind: "quota",
      usedLabel: "—",
      capLabel: "100%",
      unitLabel: "7d",
    }));
    expect(claude && claude.kind === "quota" ? claude.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "—", awaitingReset: true, fill: 0 }),
      expect.objectContaining({ label: "7d", usedLabel: "—", awaitingReset: true, fill: 0 }),
    ]);
    rawDb.close();
  });

  test("rolls every Claude window over when the last statusline reading predates all resets", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-claude-rolled-over-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    // The cockpit bug: capture stopped 29h ago, so the 5h reset is 25h past
    // and the weekly reset 23h past. Before, the gauge kept 7% / 86% with
    // those past resets and the cockpit counted "stale +23h" into the past.
    const statuslineDir = join(home, "Library", "Application Support", "OpenScout", "runtime", "statusline");
    mkdirSync(statuslineDir, { recursive: true });
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const weeklyResetAt = now - 23 * hour;
    writeFileSync(join(statuslineDir, "claude-latest.json"), JSON.stringify({
      session_id: "claude-statusline-session",
      rate_limits: {
        five_hour: { used_percentage: 7, resets_at: Math.floor((now - 25 * hour) / 1000) },
        seven_day: { used_percentage: 86, resets_at: Math.floor(weeklyResetAt / 1000) },
      },
      openscoutCapturedAt: now - 29 * hour,
    }), "utf8");

    const response = await loadServiceBudgets(true);
    const claude = response.gauges.find((gauge) => gauge.id === "claude");
    const windows = claude && claude.kind === "quota" ? claude.windows ?? [] : [];

    expect(claude).toEqual(expect.objectContaining({ kind: "quota", fill: 0, usedLabel: "—" }));
    expect(windows).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "—", awaitingReset: true, fill: 0 }),
      expect.objectContaining({ label: "7d", usedLabel: "—", awaitingReset: true, fill: 0 }),
    ]);
    // No reset is reported in the past; the weekly one is carried a cycle on.
    for (const window of windows) expect(window.resetAt).toBeGreaterThan(now);
    expect(windows[1]!.resetAt).toBe(Math.floor(weeklyResetAt / 1000) * 1000 + 7 * 24 * hour);
    rawDb.close();
  });

  test("keeps a recently reset Claude 5-hour window beside a live weekly reading", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-claude-mixed-reset-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const statuslineDir = join(home, "Library", "Application Support", "OpenScout", "runtime", "statusline");
    mkdirSync(statuslineDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(statuslineDir, "claude-latest.json"), JSON.stringify({
      session_id: "claude-statusline-session",
      rate_limits: {
        seven_day: {
          used_percentage: 34,
          resets_at: Math.floor((now + 4 * 24 * 60 * 60 * 1000) / 1000),
        },
      },
      openscoutCapturedAt: now,
    }), "utf8");
    writeFileSync(join(statuslineDir, "claude-history.jsonl"), JSON.stringify({
      session_id: "claude-statusline-session",
      rate_limits: {
        five_hour: {
          used_percentage: 4,
          resets_at: Math.floor((now - 8 * 60 * 60 * 1000) / 1000),
        },
        seven_day: {
          used_percentage: 34,
          resets_at: Math.floor((now + 4 * 24 * 60 * 60 * 1000) / 1000),
        },
      },
      openscoutCapturedAt: now - 11 * 60 * 60 * 1000,
    }) + "\n", "utf8");

    const response = await loadServiceBudgets(true);
    const claude = response.gauges.find((gauge) => gauge.id === "claude");
    expect(claude && claude.kind === "quota" ? claude.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "—", awaitingReset: true, fill: 0 }),
      expect.objectContaining({ label: "7d", usedLabel: "34%" }),
    ]);
    rawDb.close();
  });

  test("maps Claude monthly statusline windows when the provider reports them", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-claude-monthly-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const statuslineDir = join(home, "Library", "Application Support", "OpenScout", "runtime", "statusline");
    mkdirSync(statuslineDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(statuslineDir, "claude-latest.json"), JSON.stringify({
      session_id: "claude-statusline-session",
      rate_limits: {
        five_hour: {
          used_percentage: 12,
          resets_at: Math.floor((now + 4 * 60 * 60 * 1000) / 1000),
        },
        seven_day: {
          used_percentage: 40,
          resets_at: Math.floor((now + 3 * 24 * 60 * 60 * 1000) / 1000),
        },
        monthly: {
          used_percentage: 22,
          resets_at: Math.floor((now + 20 * 24 * 60 * 60 * 1000) / 1000),
        },
      },
      openscoutCapturedAt: now,
    }), "utf8");

    const response = await loadServiceBudgets(true);
    const claude = response.gauges.find((gauge) => gauge.id === "claude");
    expect(claude && claude.kind === "quota" ? claude.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "12%" }),
      expect.objectContaining({ label: "7d", usedLabel: "40%" }),
      expect.objectContaining({ label: "30d", usedLabel: "22%" }),
    ]);
    rawDb.close();
  });

  test("does not revive a week-old Codex 5-hour window when the account only reports weekly", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-codex-stale-5h-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);
    const insert = rawDb.query(`
      INSERT INTO budget_quota_window_snapshots (
        id, source, provider, harness, transport, label, window_kind,
        used_percent, percent_remaining, reset_at, window_ms, captured_at,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    insert.run(
      "codex-old-5h",
      "provider_reported",
      "openai",
      "codex",
      "codex_app_server",
      "5h",
      "primary",
      40,
      60,
      now - 6 * 24 * 60 * 60 * 1000,
      5 * 60 * 60 * 1000,
      now - 6 * 24 * 60 * 60 * 1000,
      "{}",
      now - 6 * 24 * 60 * 60 * 1000,
    );
    insert.run(
      "codex-live-7d",
      "provider_reported",
      "openai",
      "codex",
      "codex_app_server",
      "7d",
      "primary",
      87,
      13,
      now + 2 * 24 * 60 * 60 * 1000,
      7 * 24 * 60 * 60 * 1000,
      now - 60_000,
      "{}",
      now - 60_000,
    );
    rawDb.close();

    const response = await loadServiceBudgets();
    const codex = response.gauges.find((gauge) => gauge.id === "codex");
    expect(codex && codex.kind === "quota" ? codex.windows : []).toEqual([
      expect.objectContaining({ label: "7d", usedLabel: "87%" }),
    ]);
  });

  test("does not expose Claude context-window data as a subscription budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-claude-context-only-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const statuslineDir = join(home, "Library", "Application Support", "OpenScout", "runtime", "statusline");
    mkdirSync(statuslineDir, { recursive: true });
    writeFileSync(join(statuslineDir, "claude-latest.json"), JSON.stringify({
      session_id: "claude-statusline-session",
      cwd: "/repo",
      model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      context_window: {
        total_input_tokens: 78_572,
        total_output_tokens: 1_413,
        used_percentage: 8,
        remaining_percentage: 92,
      },
      openscoutCapturedAt: Date.now(),
    }), "utf8");

    const response = await loadServiceBudgets(true);

    expect(response.gauges.find((gauge) => gauge.id === "claude")).toBeUndefined();
    rawDb.close();
  });

  test("uses persisted Anthropic quota windows for the Claude gauge", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-service-budgets-"));
    tempPaths.add(controlHome);
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = join(controlHome, "home");
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(controlHome, "home", "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);
    const insert = rawDb.query(`
      INSERT INTO budget_quota_window_snapshots (
        id,
        source,
        provider,
        harness,
        transport,
        label,
        window_kind,
        used_percent,
        percent_remaining,
        used,
        limit_value,
        reset_at,
        window_ms,
        captured_at,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    insert.run(
      "claude-primary",
      "provider_reported",
      "anthropic",
      "claude",
      "claude_stream_json",
      "5h",
      "primary",
      32,
      68,
      null,
      null,
      now + 300 * 60 * 1000,
      300 * 60 * 1000,
      now,
      "{}",
      now,
    );
    insert.run(
      "claude-secondary",
      "provider_reported",
      "anthropic",
      "claude",
      "claude_stream_json",
      "weekly",
      "secondary",
      null,
      59,
      null,
      null,
      now + 7 * 24 * 60 * 60 * 1000,
      7 * 24 * 60 * 60 * 1000,
      now,
      "{}",
      now,
    );
    rawDb.close();

    const response = await loadServiceBudgets(true);
    const claude = response.gauges.find((gauge) => gauge.id === "claude");

    expect(claude).toEqual(expect.objectContaining({
      id: "claude",
      label: "claude",
      kind: "quota",
      usedLabel: "41%",
      capLabel: "100%",
      unitLabel: "7d",
    }));
    expect(claude && claude.kind === "quota" ? claude.windows : []).toEqual([
      expect.objectContaining({
        label: "5h",
        fill: 0.32,
        usedLabel: "32%",
        capLabel: "100%",
        unitLabel: "quota",
      }),
      expect.objectContaining({
        label: "7d",
        fill: 0.41,
        usedLabel: "41%",
        capLabel: "100%",
        unitLabel: "quota",
      }),
    ]);
  });

  test("does not let a later stale replay lower an active quota window", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-service-budgets-monotonic-"));
    tempPaths.add(controlHome);
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = join(controlHome, "home");
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(controlHome, "home", "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);
    const insert = rawDb.query(`
      INSERT INTO budget_quota_window_snapshots (
        id, source, provider, harness, transport, label, window_kind,
        used_percent, percent_remaining, reset_at, window_ms, captured_at,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    const resetAt = now + 5 * 60 * 60 * 1000;
    insert.run(
      "codex-current",
      "provider_reported",
      "openai",
      "codex",
      "codex_jsonl",
      "5h",
      "primary",
      64,
      36,
      resetAt,
      5 * 60 * 60 * 1000,
      now - 60_000,
      "{}",
      now - 60_000,
    );
    insert.run(
      "codex-stale-replay",
      "provider_reported",
      "openai",
      "codex",
      "codex_jsonl",
      "5h",
      "primary",
      21,
      79,
      resetAt,
      5 * 60 * 60 * 1000,
      now,
      "{}",
      now,
    );
    rawDb.close();

    const response = await loadServiceBudgets();
    const codex = response.gauges.find((gauge) => gauge.id === "codex");

    expect(codex).toEqual(expect.objectContaining({
      id: "codex",
      kind: "quota",
      usedLabel: "64%",
    }));
    expect(codex && codex.kind === "quota" ? codex.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "64%", fill: 0.64 }),
    ]);
  });

  test("allows usage to drop when a newer Codex reset cycle starts", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-service-budgets-reset-cycle-"));
    tempPaths.add(controlHome);
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = join(controlHome, "home");
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(controlHome, "home", "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);
    const insert = rawDb.query(`
      INSERT INTO budget_quota_window_snapshots (
        id, source, provider, harness, transport, label, window_kind,
        used_percent, percent_remaining, reset_at, window_ms, captured_at,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    insert.run("codex-old-cycle", "provider_reported", "openai", "codex", "codex_app_server", "5h", "primary", 82, 18, now + 60 * 60_000, 5 * 60 * 60_000, now - 60_000, "{}", now - 60_000);
    insert.run("codex-new-cycle", "provider_reported", "openai", "codex", "codex_app_server", "5h", "primary", 4, 96, now + 6 * 60 * 60_000, 5 * 60 * 60_000, now, "{}", now);
    rawDb.close();

    const response = await loadServiceBudgets();
    const codex = response.gauges.find((gauge) => gauge.id === "codex");
    expect(codex && codex.kind === "quota" ? codex.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "4%", fill: 0.04 }),
    ]);
  });

  test("harvests Codex rate limits into quota snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-codex-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const sessionDir = join(home, ".codex", "sessions", "2026", "06", "08");
    mkdirSync(sessionDir, { recursive: true });
    const now = Date.now();
    const sessionPath = join(sessionDir, "session.jsonl");
    const primaryReset = Math.floor((now + 300 * 60 * 1000) / 1000);
    const weeklyReset = Math.floor((now + 7 * 24 * 60 * 60 * 1000) / 1000);
    writeFileSync(sessionPath, JSON.stringify({
      timestamp: new Date(now).toISOString(),
      payload: {
        rate_limits: {
          primary: {
            used_percent: 22,
            window_minutes: 300,
            resets_at: primaryReset,
          },
          secondary: {
            used_percent: 44,
            window_minutes: 7 * 24 * 60,
            resets_at: weeklyReset,
          },
        },
      },
    }) + "\n", "utf8");

    const response = await loadServiceBudgets(true);
    const codex = response.gauges.find((gauge) => gauge.id === "codex");

    expect(codex).toEqual(expect.objectContaining({
      id: "codex",
      kind: "quota",
      usedLabel: "44%",
      unitLabel: "7d",
    }));
    expect(codex && codex.kind === "quota" ? codex.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "22%" }),
      expect.objectContaining({ label: "7d", usedLabel: "44%" }),
    ]);
    const codexWindows = codex && codex.kind === "quota" ? codex.windows ?? [] : [];
    expect(codexWindows[0]?.history?.length).toBeGreaterThanOrEqual(1);
    expect(countWebStateRows(
      controlHome,
      "SELECT count(*) AS count FROM budget_quota_window_snapshots WHERE provider = 'openai' AND harness = 'codex'",
    )).toBe(4);
    expect(countWebStateRows(
      controlHome,
      "SELECT count(*) AS count FROM budget_quota_window_snapshots WHERE id LIKE 'budget:quota:history:%' AND provider = 'openai' AND harness = 'codex'",
    )).toBe(2);

    // A resumed session can replay a lower percentage for the same reset with
    // a newer capture timestamp. The persistence high-water mark must survive
    // that replay, not only the in-memory selector.
    writeFileSync(sessionPath, JSON.stringify({
      timestamp: new Date(now + 60_000).toISOString(),
      payload: {
        rate_limits: {
          primary: { used_percent: 10, window_minutes: 300, resets_at: primaryReset },
          secondary: { used_percent: 12, window_minutes: 7 * 24 * 60, resets_at: weeklyReset },
        },
      },
    }) + "\n", "utf8");
    resetServiceBudgetsCache();
    const replayed = await loadServiceBudgets(true);
    const replayedCodex = replayed.gauges.find((gauge) => gauge.id === "codex");
    expect(replayedCodex && replayedCodex.kind === "quota" ? replayedCodex.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "22%" }),
      expect.objectContaining({ label: "7d", usedLabel: "44%" }),
    ]);
    rawDb.close();
  });

  test("finds account quota in file 33 after irrelevant newer sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-codex-bound-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });
    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const sessionDir = join(home, ".codex", "sessions", "2026", "09", "01");
    mkdirSync(sessionDir, { recursive: true });
    const now = Date.now();
    for (let index = 0; index < 40; index += 1) {
      const path = join(sessionDir, `session-${String(index).padStart(2, "0")}.jsonl`);
      // Newest-first, index 7 is the 33rd candidate among these 40 files.
      const payload = index === 7
        ? {
            timestamp: new Date(now).toISOString(),
            payload: {
              rate_limits: {
                primary: {
                  used_percent: 91,
                  window_minutes: 300,
                  resets_at: Math.floor((now + 300 * 60_000) / 1000),
                },
              },
            },
          }
        : { timestamp: new Date(now).toISOString(), payload: { type: "turn_started" } };
      writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf8");
      const modifiedAt = new Date(now - (40 - index) * 1_000);
      utimesSync(path, modifiedAt, modifiedAt);
    }

    const response = await loadServiceBudgets(true);
    const codex = response.gauges.find((gauge) => gauge.id === "codex");
    expect(codex && codex.kind === "quota" ? codex.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "91%", source: "Codex local session" }),
    ]);
    rawDb.close();
  });

  test("uses semantic Codex window duration even when weekly quota is primary", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-codex-weekly-primary-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });
    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const sessionDir = join(home, ".codex", "sessions", "2026", "07", "29");
    mkdirSync(sessionDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(sessionDir, "usage.jsonl"), [
      JSON.stringify({ timestamp: new Date(now + 1_000).toISOString(), payload: { type: "turn_started" } }),
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        payload: {
          type: "token_count",
          rate_limits: {
            primary: {
              used_percent: 13,
              window_minutes: 7 * 24 * 60,
              resets_at: Math.floor((now + 7 * 24 * 60 * 60_000) / 1000),
            },
          },
        },
      }),
    ].join("\n") + "\n", "utf8");

    const response = await loadServiceBudgets(true);
    const codex = response.gauges.find((gauge) => gauge.id === "codex");
    expect(codex && codex.kind === "quota" ? codex.windows : []).toEqual([
      expect.objectContaining({ label: "7d", usedLabel: "13%", source: "Codex local session" }),
    ]);
    rawDb.close();
  });

  test("reports the binding Codex pool when a session interleaves several", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-codex-pools-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });
    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const sessionDir = join(home, ".codex", "sessions", "2026", "08", "02");
    mkdirSync(sessionDir, { recursive: true });
    const now = Date.now();
    const weekly = (at: number) => Math.floor((at + 7 * 24 * 60 * 60_000) / 1000);
    const rateLimits = (usedPercent: number, limitId: string, resetsAt: number) => ({
      type: "token_count",
      rate_limits: {
        limit_id: limitId,
        primary: { used_percent: usedPercent, window_minutes: 7 * 24 * 60, resets_at: resetsAt },
        secondary: null,
        plan_type: "pro",
      },
    });

    // Codex Desktop alternates pools inside one rollout. The promotional pool
    // sits at 0% and its reset slides forward with every event, so it always
    // looks like the newest cycle even though it measures nothing.
    writeFileSync(join(sessionDir, "usage.jsonl"), [
      JSON.stringify({
        timestamp: new Date(now - 120_000).toISOString(),
        payload: rateLimits(86, "codex", weekly(now - 3 * 24 * 60 * 60_000)),
      }),
      JSON.stringify({
        timestamp: new Date(now - 60_000).toISOString(),
        payload: rateLimits(0, "codex_bengalfox", weekly(now - 60_000)),
      }),
    ].join("\n") + "\n", "utf8");

    const response = await loadServiceBudgets(true);
    const codex = response.gauges.find((gauge) => gauge.id === "codex");
    expect(codex && codex.kind === "quota" ? codex.windows : []).toEqual([
      expect.objectContaining({ label: "7d", usedLabel: "86%", source: "Codex local session" }),
    ]);
    rawDb.close();
  });

  test("does not replace persisted account quota with a promo-only partial scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-codex-partial-pool-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });
    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const sessionDir = join(home, ".codex", "sessions", "2026", "09", "01");
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, "usage.jsonl");
    const now = Date.now();
    const rateLimits = (usedPercent: number, limitId: string, resetsAt: number) => ({
      type: "token_count",
      rate_limits: {
        limit_id: limitId,
        primary: { used_percent: usedPercent, window_minutes: 7 * 24 * 60, resets_at: resetsAt },
        secondary: null,
        plan_type: "pro",
      },
    });

    writeFileSync(sessionPath, `${JSON.stringify({
      timestamp: new Date(now - 60_000).toISOString(),
      payload: rateLimits(86, "codex", Math.floor((now + 4 * 24 * 60 * 60_000) / 1000)),
    })}\n`, "utf8");
    const accountResponse = await loadServiceBudgets(true);
    const accountGauge = accountResponse.gauges.find((gauge) => gauge.id === "codex");
    expect(accountGauge && accountGauge.kind === "quota" ? accountGauge.windows : []).toEqual([
      expect.objectContaining({ label: "7d", usedLabel: "86%" }),
    ]);

    // A later bounded harvest sees only the promotional pool. Its reset slides
    // farther out, but it must not overwrite the persisted binding account pool.
    writeFileSync(sessionPath, `${JSON.stringify({
      timestamp: new Date(now).toISOString(),
      payload: rateLimits(0, "codex_bengalfox", Math.floor((now + 7 * 24 * 60 * 60_000) / 1000)),
    })}\n`, "utf8");
    resetServiceBudgetsCache();

    const promoOnlyResponse = await loadServiceBudgets(true);
    const promoOnlyGauge = promoOnlyResponse.gauges.find((gauge) => gauge.id === "codex");
    expect(promoOnlyGauge && promoOnlyGauge.kind === "quota" ? promoOnlyGauge.windows : []).toEqual([
      expect.objectContaining({ label: "7d", usedLabel: "86%" }),
    ]);
    rawDb.close();
  });

  test("does not let an older reading with a further-out reset outrank newer usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-codex-stale-cycle-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });
    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);
    const insert = rawDb.query(`
      INSERT INTO budget_quota_window_snapshots
        (id, source, provider, harness, transport, label, window_kind, used_percent, percent_remaining,
         reset_at, window_ms, captured_at, metadata_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    `);
    const now = Date.now();
    const week = 7 * 24 * 60 * 60_000;
    // Captured two days ago but claiming a reset further out than the live
    // window: it must not pin the gauge to its reading.
    insert.run("codex-stale-far-reset", "provider_reported", "openai", "codex", "codex_app_server", "7d", "primary",
      0, 100, now + 5 * 24 * 60 * 60_000, week, now - 2 * 24 * 60 * 60_000, "{}", now - 2 * 24 * 60 * 60_000);
    insert.run("codex-live", "provider_reported", "openai", "codex", "codex_app_server", "7d", "primary",
      87, 13, now + 3 * 24 * 60 * 60_000, week, now - 60_000, "{}", now - 60_000);

    const response = await loadServiceBudgets(true);
    const codex = response.gauges.find((gauge) => gauge.id === "codex");
    expect(codex && codex.kind === "quota" ? codex.windows : []).toEqual([
      expect.objectContaining({ label: "7d", usedLabel: "87%" }),
    ]);
    rawDb.close();
  });

  test("harvests Kimi Code subscription windows and membership level", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-kimi-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.KIMI_CODE_HOME = join(home, ".kimi-code");
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const now = Date.now();
    process.env.OPENSCOUT_KIMI_USAGE_JSON = JSON.stringify({
      usage: {
        limit: "100",
        used: "53",
        remaining: "47",
        resetTime: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      limits: [
        {
          detail: {
            limit: "100",
            used: "6",
            remaining: "94",
            resetTime: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
          },
          window: {
            duration: 300,
            timeUnit: "TIME_UNIT_MINUTE",
          },
        },
      ],
      user: {
        membership: {
          level: "LEVEL_ADVANCED",
        },
      },
    });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const response = await loadServiceBudgets(true);
    const kimi = response.gauges.find((gauge) => gauge.id === "kimi");

    expect(kimi).toEqual(expect.objectContaining({
      id: "kimi",
      label: "kimi",
      kind: "quota",
      usedLabel: "53%",
      capLabel: "100%",
      unitLabel: "7d",
      plan: "Advanced",
    }));
    expect(kimi && kimi.kind === "quota" ? kimi.windows : []).toEqual([
      expect.objectContaining({ label: "5h", usedLabel: "6%", windowMs: 5 * 60 * 60_000 }),
      expect.objectContaining({ label: "7d", usedLabel: "53%", windowMs: 7 * 24 * 60 * 60_000 }),
    ]);
    delete process.env.OPENSCOUT_KIMI_USAGE_JSON;
    resetServiceBudgetsCache();
    const withoutFreshToken = await loadServiceBudgets(true);
    expect(withoutFreshToken.gauges.find((gauge) => gauge.id === "kimi")).toEqual(
      expect.objectContaining({ id: "kimi", kind: "quota", usedLabel: "53%", plan: "Advanced" }),
    );
    expect(countWebStateRows(
      controlHome,
      "SELECT count(*) AS count FROM budget_quota_window_snapshots WHERE provider = 'kimi' AND harness = 'kimi'",
    )).toBe(4);
    rawDb.close();
  });

  test("detects the local Cursor plan without claiming dashboard usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-cursor-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    process.env.OPENSCOUT_CURSOR_STATUS_JSON = JSON.stringify({
      membershipType: "pro_plus",
      subscriptionStatus: "active",
    });
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const response = await loadServiceBudgets(true);
    expect(response.gauges.find((gauge) => gauge.id === "cursor")).toEqual({
      id: "cursor",
      label: "cursor",
      kind: "status",
      statusLabel: "Pro Plus",
      windowLabel: "subscription",
      detailLabel: "Active",
      tone: "ok",
      source: "Cursor local membership",
    });
    rawDb.close();
  });

  test("aggregates only cumulative Grok usage totals from each recent local session", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-grok-local-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });
    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const now = Date.now();
    for (const [session, updates] of Object.entries({
      one: [
        { totalTokens: 1_000, numTurns: 2, modelCalls: 2 },
        { totalTokens: 2_000, numTurns: 4, modelCalls: 5 },
      ],
      two: [{ totalTokens: 500, numTurns: 1, modelCalls: 1 }],
    })) {
      const directory = join(home, ".grok", "sessions", session);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "updates.jsonl"), updates.map((usage, index) => JSON.stringify({
        timestamp: now + index,
        params: { update: { usage } },
      })).join("\n") + "\n", "utf8");
    }

    const response = await loadServiceBudgets(true);
    expect(response.gauges.find((gauge) => gauge.id === "grok")).toEqual(expect.objectContaining({
      id: "grok",
      kind: "status",
      statusLabel: "Local activity",
      windowLabel: "observed 7d",
      detailLabel: "2.5K tokens · 5 turns · 6 model calls",
      source: "Grok local telemetry",
    }));
    rawDb.close();
  });

  test("uses Grok's local billing log for subscription quota", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-grok-billing-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });
    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    // Keep both billing samples in one hourly history bucket, so the row count
    // does not change during the first minute of an hour.
    const historyBucketMs = 60 * 60 * 1000;
    const now = Math.floor(Date.now() / historyBucketMs) * historyBucketMs + 2 * 60 * 1000;
    const periodEnd = now + 4 * 24 * 60 * 60 * 1000;
    const periodStart = periodEnd - 7 * 24 * 60 * 60 * 1000;
    const logsDirectory = join(home, ".grok", "logs");
    mkdirSync(logsDirectory, { recursive: true });
    const billingRecord = (creditUsagePercent: number, capturedAt: number) => ({
      ts: new Date(capturedAt).toISOString(),
      src: "shell",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: new Date(periodStart).toISOString(),
            end: new Date(periodEnd).toISOString(),
          },
        },
        subscriptionTier: "SuperGrok Heavy",
      },
    });
    writeFileSync(join(logsDirectory, "unified.jsonl"), [
      JSON.stringify({ ts: new Date(now - 3_600_000).toISOString(), msg: "unrelated" }),
      JSON.stringify(billingRecord(22, now - 60_000)),
      "not json",
      JSON.stringify(billingRecord(25, now)),
    ].join("\n") + "\n", "utf8");

    const response = await loadServiceBudgets(true);
    const grok = response.gauges.find((gauge) => gauge.id === "grok");

    expect(grok).toEqual(expect.objectContaining({
      id: "grok",
      label: "grok",
      kind: "quota",
      plan: "SuperGrok Heavy",
      usedLabel: "25%",
      capLabel: "100%",
      unitLabel: "7d",
      resetAt: periodEnd,
      source: "Grok local billing",
    }));
    expect(grok && grok.kind === "quota" ? grok.windows : []).toEqual([
      expect.objectContaining({
        label: "7d",
        usedLabel: "25%",
        resetAt: periodEnd,
        source: "Grok local billing",
      }),
    ]);
    expect(countWebStateRows(
      controlHome,
      "SELECT count(*) AS count FROM budget_quota_window_snapshots WHERE provider = 'xai' AND harness = 'grok'",
    )).toBe(2);
    rawDb.close();
  });

  test("normalizes Grok and Cursor dashboard captures without retaining pasted rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-dashboard-import-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    process.env.OPENSCOUT_CURSOR_STATUS_JSON = JSON.stringify({ membershipType: "pro", subscriptionStatus: "active" });
    mkdirSync(controlHome, { recursive: true });
    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const grok = importProviderDashboardUsage({
      provider: "grok",
      text: "Usage\nWeekly SuperGrok Heavy Limit\n17% used\nResets August 5, 2026\nProduct usage",
    });
    expect(grok).toEqual(expect.objectContaining({
      id: "grok",
      kind: "quota",
      plan: "SuperGrok Heavy",
      usedLabel: "17%",
      source: "dashboard capture",
    }));

    const cursor = importProviderDashboardUsage({
      provider: "cursor",
      text: "Date (UTC),Type,Model,Tokens,Cost\n2026-07-28,Included,secret-model-name,1.2M,Included\n2026-07-29,Included,secret-model-name,850K,Included",
    });
    expect(cursor).toEqual(expect.objectContaining({
      id: "cursor",
      kind: "status",
      detailLabel: "2 events · 2.0M tokens",
      source: "dashboard capture",
    }));

    const stored = readFileSync(join(controlHome, "provider-usage-snapshots.json"), "utf8");
    expect(stored).not.toContain("secret-model-name");
    expect(stored).not.toContain("2026-07-28");

    resetServiceBudgetsCache();
    const response = await loadServiceBudgets();
    expect(response.gauges.find((gauge) => gauge.id === "grok")).toEqual(expect.objectContaining({ usedLabel: "17%" }));
    expect(response.gauges.find((gauge) => gauge.id === "cursor")).toEqual(expect.objectContaining({
      statusLabel: "Pro",
      detailLabel: "2 events · 2.0M tokens",
      source: "dashboard capture",
    }));
    rawDb.close();
  });

  test("harvests MiniMax Token Plan 5-hour and weekly windows", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-minimax-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    const now = Date.now();
    process.env.OPENSCOUT_MINIMAX_REMAINS_JSON = JSON.stringify({
      model_remains: [
        {
          model_name: "general",
          start_time: now,
          end_time: now + 5 * 60 * 60 * 1000,
          current_interval_total_count: 4500,
          current_interval_usage_count: 900,
          current_interval_remaining_percent: 80,
          weekly_start_time: now - 24 * 60 * 60 * 1000,
          weekly_end_time: now + 6 * 24 * 60 * 60 * 1000,
          current_weekly_total_count: 20_000,
          current_weekly_usage_count: 5_000,
          current_weekly_remaining_percent: 75,
        },
        {
          model_name: "video",
          start_time: now,
          end_time: now + 24 * 60 * 60 * 1000,
          current_interval_total_count: 100,
          current_interval_usage_count: 8,
          current_interval_remaining_percent: 92,
          weekly_start_time: now,
          weekly_end_time: now + 7 * 24 * 60 * 60 * 1000,
          current_weekly_total_count: 500,
          current_weekly_usage_count: 40,
          current_weekly_remaining_percent: 92,
        },
      ],
      base_resp: { status_code: 0, status_msg: "success" },
    });
    mkdirSync(controlHome, { recursive: true });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const response = await loadServiceBudgets(true);
    const minimax = response.gauges.find((gauge) => gauge.id === "minimax");
    expect(minimax).toEqual(expect.objectContaining({
      id: "minimax",
      kind: "quota",
      plan: "Token Plan",
      usedLabel: "5.0k",
      capLabel: "20k",
      unitLabel: "7d",
    }));
    expect(minimax && minimax.kind === "quota" ? minimax.windows : []).toEqual([
      expect.objectContaining({ label: "5h", fill: 0.2, usedLabel: "900", capLabel: "4.5k" }),
      expect.objectContaining({ label: "7d", fill: 0.25, usedLabel: "5.0k", capLabel: "20k" }),
      expect.objectContaining({ label: "video 1d", fill: 0.08, usedLabel: "8", capLabel: "100" }),
      expect.objectContaining({ label: "video 7d", fill: 0.08, usedLabel: "40", capLabel: "500" }),
    ]);
    rawDb.close();
  });

  test("detects configured Cloudflare and Vercel cloud accounts", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-cloud-accounts-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });
    mkdirSync(join(home, "Library", "Preferences", ".wrangler", "config"), { recursive: true });
    writeFileSync(join(home, "Library", "Preferences", ".wrangler", "config", "default.toml"), "oauth_token = \"secret\"\n", "utf8");
    mkdirSync(join(home, "Library", "Application Support", "com.vercel.cli"), { recursive: true });
    writeFileSync(join(home, "Library", "Application Support", "com.vercel.cli", "config.json"), JSON.stringify({ currentTeam: "team" }), "utf8");

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const response = await loadServiceBudgets(true);
    expect(response.cloudAccounts).toEqual([
      { id: "cloudflare", label: "Cloudflare", statusLabel: "Connected", detailLabel: "Wrangler account detected" },
      { id: "vercel", label: "Vercel", statusLabel: "Connected", detailLabel: "Vercel account detected" },
    ]);
    rawDb.close();
  });

  test("loads a manually declared exe.dev cloud account", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-exe-"));
    tempPaths.add(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".scout"), { recursive: true });
    writeFileSync(join(home, ".scout", "provider-accounts.json"), JSON.stringify({
      exe: {
        status: "active",
        detail: "Persistent VMs for remote agents",
      },
    }));
    process.env.HOME = home;
    process.env.OPENSCOUT_CONTROL_HOME = join(root, "control");

    const response = await loadServiceBudgets(true);
    expect(response.gauges.find((gauge) => gauge.id === "exe")).toBeUndefined();
    expect(response.cloudAccounts.find((account) => account.id === "exe")).toEqual({
      id: "exe",
      label: "exe.dev",
      statusLabel: "Connected",
      detailLabel: "Persistent VMs for remote agents",
    });
  });

  test("harvests GitHub rate limits into quota snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-service-budgets-github-"));
    tempPaths.add(root);
    const controlHome = join(root, "control-plane");
    const home = join(root, "home");
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.PATH = "";
    mkdirSync(controlHome, { recursive: true });

    const reset = Math.floor((Date.now() + 3600 * 1000) / 1000);
    process.env.OPENSCOUT_GH_RATE_LIMIT_JSON = JSON.stringify({
      resources: {
        core: {
          limit: 5000,
          remaining: 4993,
          reset,
        },
      },
    });

    const rawDb = new Database(join(controlHome, "control-plane.sqlite"));
    createQuotaTable(rawDb);

    const response = await loadServiceBudgets(true);
    const github = response.gauges.find((gauge) => gauge.id === "github");

    expect(github).toEqual(expect.objectContaining({
      id: "github",
      kind: "quota",
      usedLabel: "7",
      capLabel: "5.0k",
      unitLabel: "1h",
    }));
    expect(github && github.kind === "quota" ? github.windows : []).toEqual([
      expect.objectContaining({
        label: "1h",
        usedLabel: "7",
        capLabel: "5.0k",
        unitLabel: "req",
      }),
    ]);
    const githubWindows = github && github.kind === "quota" ? github.windows ?? [] : [];
    expect(githubWindows[0]?.history?.length).toBeGreaterThanOrEqual(1);
    expect(countWebStateRows(
      controlHome,
      "SELECT count(*) AS count FROM budget_quota_window_snapshots WHERE provider = 'github'",
    )).toBe(2);
    const webState = new Database(join(controlHome, "web-state.sqlite"), { readonly: true });
    const githubCurrent = webState.query<{ used: number; limit_value: number }, []>(
      "SELECT used, limit_value FROM budget_quota_window_snapshots WHERE provider = 'github' AND id NOT LIKE 'budget:quota:history:%'",
    ).get();
    webState.close();
    expect(githubCurrent).toEqual(expect.objectContaining({
      used: 7,
      limit_value: 5000,
    }));
    rawDb.close();
  });
});
