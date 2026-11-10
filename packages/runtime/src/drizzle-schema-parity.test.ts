import { Database } from "bun:sqlite";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { beforeAll, describe, expect, test } from "bun:test";

import { applyControlPlaneDrizzleMigrations } from "./control-plane-migrations.js";
import {
  controlPlaneDrizzleSchema,
  DURABLE_ACTIONS_DUE_AT_INDEX_SQL,
} from "./drizzle-schema.js";
import { CONTROL_PLANE_SQLITE_SCHEMA } from "./schema.js";
import { WEB_READ_INDEXES_SQL } from "./web-read-indexes.js";

// Phase 0 gate: prove the DDL generated from the declarative Drizzle schema
// (`drizzle-schema.ts`) is structurally identical to the canonical raw SQL
// (`CONTROL_PLANE_SQLITE_SCHEMA`). The raw string stays the runtime authority;
// this test fails loudly the moment the two definitions drift.
//
// Comparison strategy — both databases are real SQLite; we compare SQLite's own
// introspection, so only cosmetic rendering differences are tolerated:
//   • Tables: pragma table_info + foreign_key_list. This normalizes away
//     identifier quoting, keyword case, whitespace, DEFAULT/NOT NULL clause
//     order, and inline-vs-table-level FOREIGN KEY rendering, while still
//     catching any column/type/default/NOT NULL/PK/FK drift.
//   • Named indexes: normalized sqlite_master SQL text (name + normalized SQL).
//     This is the layer that verifies partial `WHERE` predicates, expression
//     bodies and ASC/DESC ordering that pragmas do not expose.
//   • Every index (structural): descriptor set from pragma index_list/xinfo,
//     keyed by structure (not name), so a genuinely missing/extra index fails
//     in either direction — and an inline `UNIQUE(...)` constraint is matched
//     to the equivalent unique index Drizzle renders for it.

// The one index drizzle-kit 0.31.10 cannot serialize: its expression body
// (COALESCE/json_extract) contains commas and the migration renderer splits on
// every comma. We drop the mangled statement and apply the escape-hatch DDL.
const EXPRESSION_INDEX_NAME = "idx_durable_actions_kind_due_at_updated_at";
const REQUESTER_RECENCY_INDEX_NAME = "idx_invocations_requester_recency";
const RECOVERY_INDEX_NAME = "idx_invocations_completed_recovery";

/**
 * Lowercase everything outside single-quoted string literals so SQL keywords
 * and type names collapse while (case-sensitive) literals — e.g. the JSON path
 * `'$.dueAt'` — are preserved.
 */
function lowercaseOutsideStringLiterals(input: string): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === "'") {
      // Handle '' escapes: a doubled quote stays inside the literal.
      if (inQuote && input[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    out += inQuote ? ch : ch.toLowerCase();
  }
  return out;
}

/**
 * Canonicalize a CREATE statement so only cosmetic differences are erased:
 * strip SQL comments, `IF NOT EXISTS`, identifier quoting (backticks/double
 * quotes), keyword case, whitespace, and spacing around punctuation.
 */
function normalizeSql(rawSql: string): string {
  let s = rawSql;
  s = s.replace(/--[^\n]*/g, " "); // line comments
  s = s.replace(/[`"]/g, ""); // identifier quoting (single quotes preserved)
  s = s.replace(/\bif\s+not\s+exists\b/gi, " ");
  s = lowercaseOutsideStringLiterals(s);
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s*([(),])\s*/g, "$1"); // spacing around ( ) ,
  s = s.replace(/,\)/g, ")"); // trailing commas
  return s;
}

type ColumnFingerprint = {
  name: string;
  type: string;
  notnull: number | null;
  dflt: string | null;
  pk: number;
};

type ForeignKeyFingerprint = {
  table: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
};

type TableFingerprint = {
  columns: ColumnFingerprint[];
  foreignKeys: ForeignKeyFingerprint[];
};

function normalizeDefault(value: string): string {
  return lowercaseOutsideStringLiterals(value).replace(/\s+/g, " ").trim();
}

function tableFingerprint(db: Database, tableName: string): TableFingerprint {
  const info = db
    .query(`PRAGMA table_info('${tableName.replaceAll("'", "''")}')`)
    .all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
  const columns: ColumnFingerprint[] = info.map((c) => ({
    name: c.name,
    type: String(c.type).toLowerCase(),
    // SQLite lets a TEXT PRIMARY KEY hold NULL; Drizzle emits an explicit
    // NOT NULL on PK columns. Both are functionally identical for the app, so
    // NOT NULL is not compared on PK columns.
    notnull: c.pk > 0 ? null : c.notnull,
    dflt: c.dflt_value == null ? null : normalizeDefault(String(c.dflt_value)),
    pk: c.pk,
  }));
  const foreignKeys: ForeignKeyFingerprint[] = (
    db
      .query(`PRAGMA foreign_key_list('${tableName.replaceAll("'", "''")}')`)
      .all() as Array<{
        table: string;
        from: string;
        to: string | null;
        on_update: string;
        on_delete: string;
      }>
  )
    .map((f) => ({
      table: f.table,
      from: f.from,
      to: f.to,
      onUpdate: String(f.on_update).toLowerCase(),
      onDelete: String(f.on_delete).toLowerCase(),
    }))
    .sort((a, b) =>
      `${a.from}->${a.table}.${a.to}`.localeCompare(`${b.from}->${b.table}.${b.to}`),
    );
  return { columns, foreignKeys };
}

/** Representation-agnostic descriptor for a single index (name excluded). */
function indexDescriptors(db: Database): string[] {
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  const descriptors: string[] = [];
  for (const tableName of tables) {
    const list = db
      .query(`PRAGMA index_list('${tableName.replaceAll("'", "''")}')`)
      .all() as Array<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>;
    for (const idx of list) {
      // Primary-key auto-indexes are already covered by the pk ordinals in the
      // table fingerprint.
      if (idx.origin === "pk") continue;
      const cols = (
        db
          .query(`PRAGMA index_xinfo('${idx.name.replaceAll("'", "''")}')`)
          .all() as Array<{ name: string | null; desc: number; key: number }>
      )
        .filter((c) => c.key === 1)
        .map((c) => `${c.name ?? "(expr)"}:${c.desc}`);
      descriptors.push(
        JSON.stringify({
          table: tableName,
          unique: idx.unique === 1,
          partial: idx.partial === 1,
          cols,
        }),
      );
    }
  }
  return descriptors.sort();
}

function objectNames(db: Database, type: "table" | "index"): string[] {
  return (
    db
      .query(
        `SELECT name FROM sqlite_master WHERE type='${type}' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function namedIndexSql(db: Database): Map<string, string> {
  const rows = db
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string; sql: string }>;
  return new Map(rows.map((r) => [r.name, r.sql]));
}

let rawDb: Database;
let drizzleDb: Database;
let generatedStatements: string[];

beforeAll(async () => {
  // DB A — canonical raw schema.
  rawDb = new Database(":memory:");
  rawDb.exec("PRAGMA foreign_keys = ON;");
  rawDb.exec(CONTROL_PLANE_SQLITE_SCHEMA);
  // These two invocation indexes are installed after legacy column repairs,
  // rather than in the raw schema that must also open pre-status tables.
  rawDb.exec(WEB_READ_INDEXES_SQL);

  // DB B — DDL generated from the declarative Drizzle schema.
  const current = await generateSQLiteDrizzleJson(
    controlPlaneDrizzleSchema as unknown as Record<string, unknown>,
  );
  const empty = await generateSQLiteDrizzleJson({});
  generatedStatements = await generateSQLiteMigration(empty, current);

  drizzleDb = new Database(":memory:");
  drizzleDb.exec("PRAGMA foreign_keys = ON;");
  const tableStmts = generatedStatements.filter((s) => /CREATE TABLE/i.test(s));
  const indexStmts = generatedStatements.filter(
    (s) => !/CREATE TABLE/i.test(s)
      && !s.includes(EXPRESSION_INDEX_NAME)
      && !s.includes(REQUESTER_RECENCY_INDEX_NAME)
      && !s.includes(RECOVERY_INDEX_NAME),
  );
  for (const stmt of tableStmts) drizzleDb.exec(stmt);
  for (const stmt of indexStmts) drizzleDb.exec(stmt);
  // Apply the escape-hatch index drizzle-kit cannot render.
  drizzleDb.exec(DURABLE_ACTIONS_DUE_AT_INDEX_SQL);
  // drizzle-kit's renderer also quotes comma-separated COALESCE arguments as
  // separate column names. Render this index from the declarative snapshot,
  // not the raw-schema constant, so the strict parity comparisons still catch
  // expression, column, uniqueness, predicate, and ordering drift.
  const recovery = current.tables.invocations!.indexes[RECOVERY_INDEX_NAME]!;
  expect(recovery.columns).toHaveLength(3);
  drizzleDb.exec(`CREATE ${recovery.isUnique ? "UNIQUE " : ""}INDEX ${RECOVERY_INDEX_NAME}
    ON invocations ("${recovery.columns[0]}", ${recovery.columns[1]}, ${recovery.columns[2]})
    WHERE ${recovery.where};`);
  const recency = current.tables.invocations!.indexes[REQUESTER_RECENCY_INDEX_NAME]!;
  expect(recency.columns).toHaveLength(2);
  const requesterColumn = recency.columns[0]!.replaceAll('"', '""');
  drizzleDb.exec(`CREATE ${recency.isUnique ? "UNIQUE " : ""}INDEX ${REQUESTER_RECENCY_INDEX_NAME}
    ON invocations ("${requesterColumn}", ${recency.columns[1]})${recency.where ? ` WHERE ${recency.where}` : ""};`);
});

describe("control-plane schema parity: raw SQL vs Drizzle", () => {
  test("drizzle-kit generates the full baseline under bun", () => {
    // Sanity: the programmatic API produced a CREATE TABLE per modeled table.
    const createdTables = generatedStatements.filter((s) => /CREATE TABLE/i.test(s));
    expect(createdTables.length).toBe(
      objectNames(rawDb, "table").length,
    );
  });

  test("same set of tables", () => {
    expect(objectNames(drizzleDb, "table")).toEqual(objectNames(rawDb, "table"));
  });

  test("every table has identical columns, defaults, PKs and foreign keys", () => {
    const tableNames = objectNames(rawDb, "table");
    const mismatches: string[] = [];
    for (const tableName of tableNames) {
      const rawFp = tableFingerprint(rawDb, tableName);
      const drizzleFp = tableFingerprint(drizzleDb, tableName);
      const rawJson = JSON.stringify(rawFp, null, 2);
      const drizzleJson = JSON.stringify(drizzleFp, null, 2);
      if (rawJson !== drizzleJson) {
        mismatches.push(
          `\n### ${tableName}\n--- raw ---\n${rawJson}\n--- drizzle ---\n${drizzleJson}`,
        );
      }
    }
    expect(mismatches.join("\n")).toBe("");
  });

  test("every raw named index exists in Drizzle with identical normalized SQL", () => {
    const rawIndexes = namedIndexSql(rawDb);
    const drizzleIndexes = namedIndexSql(drizzleDb);
    const problems: string[] = [];
    for (const [name, rawSql] of rawIndexes) {
      const drizzleSql = drizzleIndexes.get(name);
      if (drizzleSql === undefined) {
        problems.push(`\nMISSING in drizzle: ${name}\n  raw: ${normalizeSql(rawSql)}`);
        continue;
      }
      const rawNorm = normalizeSql(rawSql);
      const drizzleNorm = normalizeSql(drizzleSql);
      if (rawNorm !== drizzleNorm) {
        problems.push(
          `\nDRIFT: ${name}\n  raw    : ${rawNorm}\n  drizzle: ${drizzleNorm}`,
        );
      }
    }
    expect(problems.join("\n")).toBe("");
  });

  test("structural index descriptor sets match in both directions", () => {
    // Representation-agnostic: catches any missing/extra index and matches an
    // inline UNIQUE(...) constraint to the unique index Drizzle emits for it.
    expect(indexDescriptors(drizzleDb)).toEqual(indexDescriptors(rawDb));
  });

  test("the expression index drizzle-kit cannot render is present and correct", () => {
    const rawSql = namedIndexSql(rawDb).get(EXPRESSION_INDEX_NAME);
    const drizzleSql = namedIndexSql(drizzleDb).get(EXPRESSION_INDEX_NAME);
    expect(rawSql).toBeDefined();
    expect(drizzleSql).toBeDefined();
    expect(normalizeSql(drizzleSql!)).toBe(normalizeSql(rawSql!));
  });
});

// Phase 1 gate: the CHECKED-IN migrations (drizzle/, incl. the hand-fixed
// expression index in the baseline) applied through the real production path
// must also reproduce the raw schema. Where the Phase 0 gate proves the
// declarative model matches, this one proves the shipped migration chain
// matches — it fails when drizzle-schema.ts changes without a generated
// migration, or when a generated migration is edited out of lockstep.
describe("control-plane schema parity: raw SQL vs checked-in migrations", () => {
  let baselineDb: Database;

  beforeAll(() => {
    baselineDb = new Database(":memory:");
    baselineDb.exec("PRAGMA foreign_keys = ON;");
    expect(applyControlPlaneDrizzleMigrations(baselineDb)).toBe(true);
  });

  test("same set of tables", () => {
    expect(objectNames(baselineDb, "table")).toEqual(objectNames(rawDb, "table"));
  });

  test("every table has identical columns, defaults, PKs and foreign keys", () => {
    const mismatches: string[] = [];
    for (const tableName of objectNames(rawDb, "table")) {
      const rawJson = JSON.stringify(tableFingerprint(rawDb, tableName), null, 2);
      const baselineJson = JSON.stringify(tableFingerprint(baselineDb, tableName), null, 2);
      if (rawJson !== baselineJson) {
        mismatches.push(
          `\n### ${tableName}\n--- raw ---\n${rawJson}\n--- migrations ---\n${baselineJson}`,
        );
      }
    }
    expect(mismatches.join("\n")).toBe("");
  });

  test("every raw named index exists with identical normalized SQL", () => {
    const rawIndexes = namedIndexSql(rawDb);
    const baselineIndexes = namedIndexSql(baselineDb);
    const problems: string[] = [];
    for (const [name, rawSql] of rawIndexes) {
      const baselineSql = baselineIndexes.get(name);
      if (baselineSql === undefined) {
        problems.push(`\nMISSING in migrations: ${name}\n  raw: ${normalizeSql(rawSql)}`);
        continue;
      }
      if (normalizeSql(rawSql) !== normalizeSql(baselineSql)) {
        problems.push(
          `\nDRIFT: ${name}\n  raw       : ${normalizeSql(rawSql)}\n  migrations: ${normalizeSql(baselineSql)}`,
        );
      }
    }
    expect(problems.join("\n")).toBe("");
  });

  test("structural index descriptor sets match in both directions", () => {
    expect(indexDescriptors(baselineDb)).toEqual(indexDescriptors(rawDb));
  });
});


test("forward web-read migration tolerates indexes already installed by a pilot repair", () => {
  const database = new Database(":memory:");
  try {
    expect(applyControlPlaneDrizzleMigrations(database)).toBe(true);
    const indexes = indexDescriptors(database);
    // Simulate the previous managed lineage with the same indexes already
    // installed by its idempotent repair or historical local migration.
    database.exec("DELETE FROM __drizzle_migrations WHERE created_at >= 1791900000000");
    expect(applyControlPlaneDrizzleMigrations(database)).toBe(true);
    expect(indexDescriptors(database)).toEqual(indexes);
    expect(database.query("SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE created_at = 1791900000000").get()).toEqual({ count: 1 });
  } finally { database.close(); }
});
