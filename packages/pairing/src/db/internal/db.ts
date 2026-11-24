/**
 * Readonly SQLite handle for the web server's direct reads of the control-plane
 * database. Lifted from db-queries.ts as part of SCO-031 Phase A.
 */

import { Database } from "bun:sqlite";
import { observeSqliteDatabase } from "@openscout/runtime/storage";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/config";

/* ── DB path ── */

export function resolveDbPath(): string {
  const controlHome = resolveOpenScoutSupportPaths().controlHome;
  return join(controlHome, "control-plane.sqlite");
}

/* ── Readonly connection (WAL-visible without periodic reopen) ── */

let _db: Database | null = null;
const DB_BUSY_TIMEOUT_MS = 250; // keep UI reads short under broker write contention

export function configureReadonlyDb(db: Database, busyTimeoutMs = DB_BUSY_TIMEOUT_MS): void {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA query_only = ON");
}

/** A caller-owned read connection; close it after use. Zero timeout permits async retries. */
export function openReadonlyDb(busyTimeoutMs = DB_BUSY_TIMEOUT_MS): Database {
  const connection = observeSqliteDatabase(new Database(resolveDbPath(), { readonly: true }), {
    database: "web-control-plane",
  });
  try {
    configureReadonlyDb(connection, busyTimeoutMs);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export function db(): Database {
  if (!_db) {
    _db = openReadonlyDb();
  }
  return _db;
}

/** Call on server shutdown. */
export function closeDb(): void {
  _db?.close();
  _db = null;
}
