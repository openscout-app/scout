/**
 * The web server's own SQLite file, for the product objects the web server
 * authors: terminal workspaces, Briefing Room briefs, and the provider quota
 * snapshots it harvests.
 *
 * These used to be written straight into the broker's control-plane database
 * through side handles, which meant the web server ran DDL and ALTERs against a
 * file whose schema the broker owns. Now the control-plane database is read-only
 * from here (`internal/db.ts`) and every web-authored write lands in this file,
 * next to its siblings `scoutbot-usage.sqlite` and
 * `realtime-voice-admission.sqlite`.
 *
 * On first open, workspaces and briefs already in the control plane are copied
 * over once, so an upgrade does not look like data loss. The control-plane
 * rows are left in place; nothing here writes there.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONTROL_PLANE_TERMINAL_WORKSPACE_SQLITE_SCHEMA } from "@openscout/runtime/storage";

import { resolveDbPath } from "./db.ts";

const DB_BUSY_TIMEOUT_MS = 2_500;
const CONTROL_PLANE_IMPORT_KEY = "control-plane-import-v1";

const WEB_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS web_state_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

${CONTROL_PLANE_TERMINAL_WORKSPACE_SQLITE_SCHEMA}

CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT,
  prepared_at INTEGER NOT NULL,
  ttl_ms INTEGER NOT NULL,
  brief_json TEXT NOT NULL,
  observations_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  call_json TEXT NOT NULL,
  markdown TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- Same columns as the broker's table of the same name, so one query reads
-- both: the broker records windows observed on endpoints, the web server
-- records the ones it harvests from provider APIs and local session files.
CREATE TABLE IF NOT EXISTS budget_quota_window_snapshots (
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
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_web_quota_windows_provider_captured
  ON budget_quota_window_snapshots (provider, harness, captured_at DESC);
`;

let _db: Database | null = null;
let _dbPath: string | null = null;

export function resolveWebStateDbPath(): string {
  return join(dirname(resolveDbPath()), "web-state.sqlite");
}

export function webDb(): Database {
  const path = resolveWebStateDbPath();
  // Reopen when the control home moves. It does not move in a running server,
  // but tests redirect it, and a handle on a stale path fails opaquely.
  if (_db && _dbPath !== path) closeWebDb();
  if (!_db) {
    mkdirSync(dirname(path), { recursive: true });
    const database = new Database(path, { create: true });
    database.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = NORMAL;");
    database.exec(WEB_STATE_SCHEMA);
    importFromControlPlaneOnce(database);
    _db = database;
    _dbPath = path;
  }
  return _db;
}

/** Call on server shutdown. */
export function closeWebDb(): void {
  _db?.close();
  _db = null;
  _dbPath = null;
}

function importFromControlPlaneOnce(database: Database): void {
  const done = database.query("SELECT value FROM web_state_meta WHERE key = ?1")
    .get(CONTROL_PLANE_IMPORT_KEY);
  if (done) return;

  const sourcePath = resolveDbPath();
  if (existsSync(sourcePath)) {
    // A separate readonly handle: the control plane is only ever read here.
    // A locked or unreadable source skips the copy without marking it done,
    // so the next open tries again instead of the web server failing to boot.
    let source: Database;
    try {
      source = new Database(sourcePath, { readonly: true });
    } catch {
      return;
    }
    try {
      source.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
      const workspaces = readSourceTable(source, "terminal_workspaces", [
        "id", "name", "purpose", "columns_count", "layout_json", "cells_json", "metadata_json", "created_at", "updated_at",
      ]);
      const briefings = readSourceTable(source, "briefings", [
        "id", "kind", "title", "summary", "recommendation", "prepared_at", "ttl_ms", "brief_json",
        "observations_json", "snapshot_json", "call_json", "markdown", "created_at",
      ]);
      database.transaction(() => {
        copyRows(database, "terminal_workspaces", workspaces);
        copyRows(database, "briefings", briefings);
      })();
    } catch {
      return;
    } finally {
      source.close();
    }
  }

  database.query("INSERT OR REPLACE INTO web_state_meta (key, value) VALUES (?1, ?2)")
    .run(CONTROL_PLANE_IMPORT_KEY, String(Date.now()));
}

type SourceRows = { columns: string[]; rows: Array<Record<string, unknown>> };

/**
 * Rows of `table` restricted to `wanted` columns the source actually has; an
 * older control plane may predate a column (`layout_json`, `markdown`), and
 * the destination default fills it.
 */
function readSourceTable(source: Database, table: string, wanted: string[]): SourceRows {
  const present = new Set(
    (source.query(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const columns = wanted.filter((column) => present.has(column));
  if (columns.length === 0) return { columns, rows: [] };
  return {
    columns,
    rows: source.query(`SELECT ${columns.join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>,
  };
}

function copyRows(database: Database, table: string, source: SourceRows): void {
  if (source.rows.length === 0) return;
  const placeholders = source.columns.map((_, index) => `?${index + 1}`).join(", ");
  const insert = database.query(
    `INSERT OR IGNORE INTO ${table} (${source.columns.join(", ")}) VALUES (${placeholders})`,
  );
  for (const row of source.rows) {
    insert.run(...(source.columns.map((column) => row[column] ?? null) as Array<string | number | null>));
  }
}
