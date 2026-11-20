// Boot-path tests for the managed-migration layer (Phase 1 of
// plans/drizzle-schema-migrations.md): virgin databases build through the
// drizzle migrator, pre-baseline databases get the baseline seeded as
// already-applied, and a database stamped by a newer build refuses to open.
// The idempotent repair property itself is pinned by sqlite-store.test.ts.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";

import {
  CONTROL_PLANE_SCHEMA_MIGRATIONS,
  applyControlPlaneSchemaMigrations,
  assertControlPlaneSchemaNotNewer,
  migrateControlPlaneDatabaseSchema,
  resolveControlPlaneDrizzleMigrationsFolder,
} from "./control-plane-migrations.js";
import { CONTROL_PLANE_SCHEMA_VERSION, CONTROL_PLANE_SQLITE_SCHEMA } from "./schema.js";

const migrations = readMigrationFiles({
  migrationsFolder: resolveControlPlaneDrizzleMigrationsFolder(),
});
const baseline = migrations[0]!;
const fullChainLedger = migrations.map((m) => ({
  hash: m.hash,
  created_at: m.folderMillis,
}));

function ledgerRows(db: Database): Array<{ hash: string; created_at: number }> {
  return db
    .query('SELECT hash, created_at FROM "__drizzle_migrations" ORDER BY created_at')
    .all() as Array<{ hash: string; created_at: number }>;
}

function controlPlaneTableCount(db: Database): number {
  const row = db
    .query(
      "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name != '__drizzle_migrations'",
    )
    .get() as { c: number };
  return row.c;
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("control-plane managed migrations", () => {
  test("the checked-in journal has the baseline", () => {
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(baseline.folderMillis).toBeGreaterThan(0);
    expect(baseline.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("preserves the historical schema v14 context migration identity at schema v20", () => {
    const contextMigration = migrations.find((migration) => migration.folderMillis === 1783665705710);

    expect(CONTROL_PLANE_SCHEMA_VERSION).toBe(20);
    expect(contextMigration?.hash).toBe("e576221a4547e38a8d92027deb1124055459bf800c12c562840cdcf6fbb8b560");
  });

  test("upgrades a fully ledgered schema v14 database through the current migration chain", () => {
    const db = new Database(":memory:");
    const v14Migrations = migrations.filter((migration) => migration.folderMillis <= 1783665705710);
    expect(v14Migrations).toHaveLength(4);
    db.exec(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    for (const migration of v14Migrations) {
      db.transaction(() => {
        for (const statement of migration.sql) db.exec(statement);
        db.query(
          'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
        ).run(migration.hash, migration.folderMillis);
      })();
    }
    db.exec("PRAGMA user_version = 14");
    db.query(
      "INSERT INTO actors (id, kind, display_name) VALUES ('actor-v14', 'agent', 'Survivor')",
    ).run();
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_assignments'").get(),
    ).toBeNull();

    migrateControlPlaneDatabaseSchema(db);

    expect(ledgerRows(db)).toEqual(fullChainLedger);
    expect(userVersion(db)).toBe(CONTROL_PLANE_SCHEMA_VERSION);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_assignments'").get(),
    ).toEqual({ name: "role_assignments" });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'route_alias_bindings'").get(),
    ).toEqual({ name: "route_alias_bindings" });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broker_journal_projection_checkpoints'").get(),
    ).toEqual({ name: "broker_journal_projection_checkpoints" });
    expect(
      db.query("SELECT name FROM pragma_table_info('invocations') WHERE name = 'execution_resolution_json'").get(),
    ).toEqual({ name: "execution_resolution_json" });
    expect(
      db.query("SELECT display_name FROM actors WHERE id = 'actor-v14'").get(),
    ).toEqual({ display_name: "Survivor" });
  });

  test("reconciles the historical v15 role migration lineage without replaying its tables", () => {
    const db = new Database(":memory:");
    db.exec(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );

    for (const migration of migrations.slice(0, 3)) {
      for (const statement of migration.sql) db.exec(statement);
      db.query(
        'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
      ).run(migration.hash, migration.folderMillis);
    }

    const roleMigration = migrations.find((migration) => migration.folderMillis === 1784834739171)!;
    for (const statement of roleMigration.sql) db.exec(statement);
    const legacyLedger = [
      ["0b135c4d057d5c26bddb07d1cbda3f027bd2ef4d90babfc2e23fede3ff8be5cb", 1784647043307],
      ["7df85f271d1a6e9e37552adf3dc2f1869ca0f685b343aaf328488aeb11a2f64d", 1784666969459],
      ["7b2b31c19f753638f597e2f73dee3855a84f3d4c6aec7e615825745d81928aac", 1784667568249],
    ] as const;
    for (const [hash, createdAt] of legacyLedger) {
      db.query(
        'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
      ).run(hash, createdAt);
    }
    db.exec("PRAGMA user_version = 15");
    db.query(
      `INSERT INTO role_assignments (
         id, role_id, agent_id, scope_kind, assigned_by_id, assigned_at, updated_at
       ) VALUES ('role-keeper', 'reviewer', 'agent-keeper', 'global', 'operator', 10, 10)`,
    ).run();

    migrateControlPlaneDatabaseSchema(db);

    const reconciledHashes = new Set(ledgerRows(db).map((row) => row.hash));
    expect(fullChainLedger.every((row) => reconciledHashes.has(row.hash))).toBe(true);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_blocks'").get(),
    ).toEqual({ name: "context_blocks" });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'route_alias_bindings'").get(),
    ).toEqual({ name: "route_alias_bindings" });
    expect(db.query("SELECT agent_id FROM role_assignments WHERE id = 'role-keeper'").get()).toEqual({
      agent_id: "agent-keeper",
    });
    expect(userVersion(db)).toBe(CONTROL_PLANE_SCHEMA_VERSION);
  });

  test("reconciles v17 databases that received execution resolution before its Drizzle migration", () => {
    const db = new Database(":memory:");
    const executionResolutionMigrationIndex = migrations.findIndex((migration) =>
      migration.sql.some((statement) => statement.includes("execution_resolution_json"))
    );
    expect(executionResolutionMigrationIndex).toBeGreaterThan(0);

    db.exec(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    for (const migration of migrations.slice(0, executionResolutionMigrationIndex)) {
      for (const statement of migration.sql) db.exec(statement);
      db.query(
        'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
      ).run(migration.hash, migration.folderMillis);
    }
    db.exec("ALTER TABLE invocations ADD COLUMN execution_resolution_json TEXT");
    db.exec(`PRAGMA user_version = ${CONTROL_PLANE_SCHEMA_VERSION}`);

    migrateControlPlaneDatabaseSchema(db);

    expect(ledgerRows(db)).toEqual(fullChainLedger);
    expect(
      db.query("SELECT count(*) AS count FROM pragma_table_info('invocations') WHERE name = 'execution_resolution_json'").get(),
    ).toEqual({ count: 1 });
    expect(userVersion(db)).toBe(CONTROL_PLANE_SCHEMA_VERSION);
  });

  test("virgin database boots through the migrator: full chain executed, ledger recorded", () => {
    const db = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(db);

    // A seeded ledger on an empty database is impossible (seeding requires
    // existing tables), so these rows prove the migrator ran the chain.
    expect(ledgerRows(db)).toEqual(fullChainLedger);
    expect(controlPlaneTableCount(db)).toBeGreaterThan(30);
    expect(userVersion(db)).toBe(CONTROL_PLANE_SCHEMA_VERSION);
  });

  test("existing raw-schema database gets the whole chain seeded, data intact", () => {
    const db = new Database(":memory:");
    // A pre-ledger production state: raw schema (current full shape) +
    // imperative array + version stamp + the empty ledger table the
    // pre-baseline migrate() call left behind. Seeding must record the whole
    // chain — replaying any migration (e.g. 0001's plain ADD COLUMNs) over
    // this database would fail.
    db.exec(CONTROL_PLANE_SQLITE_SCHEMA);
    applyControlPlaneSchemaMigrations(db);
    db.exec(`PRAGMA user_version = ${CONTROL_PLANE_SCHEMA_VERSION};`);
    db.exec(
      'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    db.query(
      "INSERT INTO actors (id, kind, display_name) VALUES ('actor-1', 'agent', 'Keeper')",
    ).run();

    migrateControlPlaneDatabaseSchema(db);

    expect(ledgerRows(db)).toEqual(fullChainLedger);
    const survivor = db
      .query("SELECT display_name FROM actors WHERE id = 'actor-1'")
      .get() as { display_name: string };
    expect(survivor.display_name).toBe("Keeper");
  });

  test("pre-drizzle-spike database (no ledger table at all) seeds cleanly", () => {
    const db = new Database(":memory:");
    db.exec(CONTROL_PLANE_SQLITE_SCHEMA);

    migrateControlPlaneDatabaseSchema(db);

    expect(ledgerRows(db)).toEqual(fullChainLedger);
  });

  test("partially created database (interrupted first boot) seeds and repairs", () => {
    const db = new Database(":memory:");
    // Only the baseline's first table exists — the seed condition must treat
    // any non-empty database as existing so the baseline's plain CREATE TABLE
    // statements never replay; the raw-schema repair layer fills in the rest.
    db.exec(baseline.sql[0]!);
    expect(controlPlaneTableCount(db)).toBe(1);

    migrateControlPlaneDatabaseSchema(db);

    expect(ledgerRows(db)).toEqual(fullChainLedger);
    expect(controlPlaneTableCount(db)).toBeGreaterThan(30);
  });

  test("running the full migration twice keeps exactly one ledger row per migration", () => {
    const db = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(db);
    migrateControlPlaneDatabaseSchema(db);
    expect(ledgerRows(db)).toEqual(fullChainLedger);
  });

  test("legacy two-column conversations table crosses the index migration before authority is added", () => {
    const db = new Database(":memory:");
    const meshIndexMigrationIndex = migrations.findIndex(
      (migration) => migration.folderMillis === 1788388739548,
    );
    expect(meshIndexMigrationIndex).toBeGreaterThan(0);

    db.exec(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    for (const migration of migrations.slice(0, meshIndexMigrationIndex)) {
      for (const statement of migration.sql) db.exec(statement);
      db.query(
        'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
      ).run(migration.hash, migration.folderMillis);
    }

    // This is the pre-ledger pilot shape that can survive into a database
    // whose migration ledger was later seeded. Replacing the baseline table
    // here leaves every other pre-0015 object at its real checked-in shape.
    db.exec("DROP TABLE conversations");
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    expect(
      db.query("SELECT name FROM pragma_table_info('conversations') WHERE name = 'authority_node_id'").get(),
    ).toBeNull();

    migrateControlPlaneDatabaseSchema(db);

    expect(ledgerRows(db)).toEqual(fullChainLedger);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversations_authority_node_id'").get(),
    ).toBeNull();

    db.exec("ALTER TABLE conversations ADD COLUMN authority_node_id TEXT");
    migrateControlPlaneDatabaseSchema(db);

    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversations_authority_node_id'").get(),
    ).toEqual({ name: "idx_conversations_authority_node_id" });
  });

  test("mesh-node repair predicates stay indexed while repeated boots remain self-healing", () => {
    const planDb = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(planDb);

    const repairPredicates = [
      ["agents", "home_node_id", "idx_agents_home_node_id"],
      ["agents", "authority_node_id", "idx_agents_authority_node_id"],
      ["agent_endpoints", "node_id", "idx_agent_endpoints_node_id"],
      ["runtime_sessions", "node_id", "idx_runtime_sessions_node_id"],
      ["runtime_session_aliases", "node_id", "idx_runtime_session_aliases_node_id"],
      ["conversations", "authority_node_id", "idx_conversations_authority_node_id"],
      ["conversation_read_cursors", "reader_node_id", "idx_read_cursors_reader_node_id"],
      ["messages", "origin_node_id", "idx_messages_origin_node_id"],
      ["deliveries", "target_node_id", "idx_deliveries_target_node_id"],
      ["invocations", "requester_node_id", "idx_invocations_requester_node_id"],
      ["invocations", "target_node_id", "idx_invocations_target_node_id"],
      ["thread_events", "authority_node_id", "idx_thread_events_authority_node_id"],
      ["thread_cursors", "authority_node_id", "idx_thread_cursors_authority_node_id"],
      ["trusted_peers", "node_id", "idx_trusted_peers_node_id"],
    ] as const;

    for (const [table, column, indexName] of repairPredicates) {
      const plan = planDb
        .query(`EXPLAIN QUERY PLAN UPDATE ${table} SET ${column} = ?1 WHERE ${column} = ?2`)
        .all("canonical-node", "ghost-node") as Array<{ detail: string }>;
      expect(plan.some((step) => step.detail.includes(indexName))).toBe(true);
      expect(plan.some((step) => step.detail.includes(`SCAN ${table}`))).toBe(false);
    }
    planDb.close();

    const db = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(db);
    db.exec(`
      INSERT INTO nodes (
        id, mesh_id, name, host_name, advertise_scope, registered_at
      ) VALUES (
        'air-6-local-openscout', 'openscout', 'air-6.local', 'air-6.local', 'local', 1
      );
      INSERT INTO actors (id, kind, display_name)
        VALUES ('agent-air', 'agent', 'Air');
      INSERT INTO agents (
        id, definition_id, agent_class, capabilities_json, wake_policy,
        home_node_id, authority_node_id, advertise_scope
      ) VALUES (
        'agent-air', 'agent-air', 'general', '[]', 'on_demand',
        'air-6-local-openscout', 'air-6-local-openscout', 'local'
      );
    `);

    migrateControlPlaneDatabaseSchema(db);

    expect(
      db.query("SELECT home_node_id, authority_node_id FROM agents WHERE id = 'agent-air'").get(),
    ).toEqual({
      home_node_id: "air-local-openscout",
      authority_node_id: "air-local-openscout",
    });
    expect(db.query("SELECT id FROM nodes WHERE id = 'air-6-local-openscout'").get()).toBeNull();
    expect(db.query("SELECT id FROM nodes WHERE id = 'air-local-openscout'").get()).toEqual({
      id: "air-local-openscout",
    });
  });

  test("briefings-markdown backfill adds the column to pre-v8 databases", () => {
    const db = new Database(":memory:");
    db.exec(CONTROL_PLANE_SQLITE_SCHEMA);
    // Simulate a database provisioned before schema v8, whose briefings table
    // predates the markdown column (the CREATE IF NOT EXISTS repair layer
    // cannot add columns to an existing table).
    db.exec("ALTER TABLE briefings DROP COLUMN markdown");

    migrateControlPlaneDatabaseSchema(db);

    const cols = db.query("PRAGMA table_info('briefings')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "markdown")).toBe(true);
  });

  function seedDivergedInvocation(db: Database): void {
    db.exec(`
      INSERT INTO invocations (id, requester_id, requester_node_id, target_agent_id, action, task, created_at)
        VALUES ('inv-1', 'operator', 'node-1', 'agent-1', 'consult', 'reconcile me', 100);
      INSERT INTO flights (id, invocation_id, requester_id, target_agent_id, state, summary, output, metadata_json, started_at, completed_at)
        VALUES ('flight-1', 'inv-1', 'operator', 'agent-1', 'completed', 'Done', 'Output', '{"model":"probe"}', 110, 120);
      UPDATE invocations
        SET flight_id = 'wrong-flight', state = 'running', summary = 'STALE',
            output = NULL, error = 'STALE', started_at = 999, completed_at = NULL,
            flight_metadata_json = NULL
        WHERE id = 'inv-1';
    `);
  }

  function shadowRow(db: Database): Record<string, unknown> {
    return db
      .query(
        `SELECT flight_id, state, summary, output, error, started_at, completed_at, flight_metadata_json
         FROM invocations WHERE id = 'inv-1'`,
      )
      .get() as Record<string, unknown>;
  }

  const healedShadow = {
    flight_id: "flight-1",
    state: "completed",
    summary: "Done",
    output: "Output",
    error: null,
    started_at: 110,
    completed_at: 120,
    flight_metadata_json: '{"model":"probe"}',
  };

  test("pre-ledger database with a diverged shadow heals: seed-all marks 0002 applied, so the imperative reconcile must repair it", () => {
    // The #297 adversarial review's blocker scenario: a pre-ledger database
    // seeds the whole chain as already-applied, so the checked-in 0002
    // wholesale reconciliation never executes — the imperative
    // invocation-flight-status-reconcile entry is the only thing standing
    // between a stale shadow and the read switch.
    const db = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(db);
    seedDivergedInvocation(db);
    db.exec('DROP TABLE "__drizzle_migrations"');

    migrateControlPlaneDatabaseSchema(db);

    expect(ledgerRows(db)).toEqual(fullChainLedger);
    expect(shadowRow(db)).toEqual(healedShadow);
  });

  test("shadow reconcile is self-healing: a diverged shadow on a fully-ledgered database converges on the next boot", () => {
    // Covers divergence from any source after the ledgered migration already
    // ran once — crash windows on builds before the dual-write became
    // transactional, manual edits, raw /v1/flights posts.
    const db = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(db);
    seedDivergedInvocation(db);

    migrateControlPlaneDatabaseSchema(db);

    expect(shadowRow(db)).toEqual(healedShadow);
  });

  test("refuses to open a database stamped by a newer build", () => {
    const db = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(db);
    db.exec(`PRAGMA user_version = ${CONTROL_PLANE_SCHEMA_VERSION + 1};`);

    expect(() => migrateControlPlaneDatabaseSchema(db)).toThrow(/newer build/);
    expect(() => assertControlPlaneSchemaNotNewer(db)).toThrow(
      new RegExp(`v${CONTROL_PLANE_SCHEMA_VERSION + 1}.*v${CONTROL_PLANE_SCHEMA_VERSION}`),
    );
  });

  test("a database at exactly the current version opens", () => {
    const db = new Database(":memory:");
    migrateControlPlaneDatabaseSchema(db);
    expect(() => migrateControlPlaneDatabaseSchema(db)).not.toThrow();
  });
});

describe("vercel board custody roles migration", () => {
  test("an older custody table keeps its rows and then takes a profile and a blocked state", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE vercel_board_custody (
      connection_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, epoch INTEGER, token TEXT, until INTEGER,
      lease_seconds INTEGER NOT NULL, agent_id TEXT NOT NULL, work_id TEXT NOT NULL, started_by TEXT NOT NULL, flight_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('claiming', 'claim_unknown', 'held', 'settling', 'settled', 'lost')),
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'released')),
      result TEXT, detail TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (connection_id, attempt_id))`);
    db.exec("INSERT INTO vercel_board_custody VALUES ('c1', 't1', 'a1', 1, 'tok', 5, 60, 'agent', '', 'operator', 'f1', 'held', NULL, NULL, NULL, 1, 1)");
    const migration = CONTROL_PLANE_SCHEMA_MIGRATIONS.find((entry) => entry.id === "vercel-board-custody-roles")!;
    migration.apply(db as never);
    expect(db.query("SELECT task_id, token, state, profile FROM vercel_board_custody").all()).toEqual([{ task_id: "t1", token: "tok", state: "held", profile: null }]);
    db.exec("UPDATE vercel_board_custody SET state = 'blocked', outcome = 'blocked', profile = 'reviewer'");
    expect(db.query("SELECT state, outcome, profile FROM vercel_board_custody").get()).toEqual({ state: "blocked", outcome: "blocked", profile: "reviewer" });
    // A second run leaves the new shape alone.
    migration.apply(db as never);
    expect(db.query("SELECT count(*) AS c FROM vercel_board_custody").get()).toEqual({ c: 1 });
  });
});
