import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCardlessSessionActor, buildCardlessSessionEndpoint } from "./broker-cardless-session.js";
import { migrateControlPlaneDatabaseSchema, resolveControlPlaneDrizzleMigrationsFolder } from "./control-plane-migrations.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";

const migrationsFolder = resolveControlPlaneDrizzleMigrationsFolder();
const migrations = readMigrationFiles({ migrationsFolder });
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};
const actorTargetMigration = journal.entries.find((entry) => entry.tag === "0019_session_actor_targets");
if (!actorTargetMigration) throw new Error("Missing actor-target migration fixture boundary");
// This fixture must stay before the actor-target rebuild even after later
// migrations are appended. Dropping only the newest migration silently made
// the supposed legacy fixture already use actor foreign keys after 0020 landed.
const legacyMigrations = migrations.filter((migration) => migration.folderMillis < actorTargetMigration.when);

function legacyDatabase(ledger: boolean): Database {
  const db = new Database(":memory:");
  db.exec('CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  for (const migration of legacyMigrations) {
    for (const sql of migration.sql) db.exec(sql);
    if (ledger) db.query('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)')
      .run(migration.hash, migration.folderMillis);
  }
  db.exec(`
    PRAGMA user_version = 17;
    PRAGMA foreign_keys = ON;
    INSERT INTO nodes (id, mesh_id, name, advertise_scope, registered_at) VALUES ('node', 'mesh', 'Node', 'local', 1);
    INSERT INTO actors (id, kind, display_name) VALUES ('agent', 'agent', 'Agent');
    INSERT INTO agents (id, definition_id, agent_class, capabilities_json, wake_policy, home_node_id, authority_node_id, advertise_scope)
      VALUES ('agent', 'agent', 'general', '[]', 'on_demand', 'node', 'node', 'local');
    INSERT INTO agent_endpoints (id, agent_id, node_id, harness, transport, state)
      VALUES ('endpoint', 'agent', 'node', 'claude', 'tmux', 'idle');
    INSERT INTO runtime_sessions (id, agent_id, endpoint_id, node_id, harness, transport, state, primary_alias, last_seen_at, updated_at)
      VALUES ('runtime-session', 'agent', 'endpoint', 'node', 'claude', 'tmux', 'idle', 'alias', 1, 1);
    INSERT INTO runtime_session_aliases (alias, session_id, alias_kind, agent_id, endpoint_id, node_id, harness, transport, first_seen_at, last_seen_at)
      VALUES ('alias', 'runtime-session', 'scout', 'agent', 'endpoint', 'node', 'claude', 'tmux', 1, 1);
    INSERT INTO invocations (id, requester_id, requester_node_id, target_agent_id, action, task, created_at)
      VALUES ('invocation', 'agent', 'node', 'agent', 'chat', 'preserve task', 1);
    INSERT INTO flights (id, invocation_id, requester_id, target_agent_id, state, output)
      VALUES ('flight', 'invocation', 'agent', 'agent', 'completed', 'preserve output');
    UPDATE invocations SET flight_id='flight', state='completed', output='preserve output' WHERE id='invocation';
    INSERT INTO activity_items (id, kind, ts, invocation_id, flight_id, agent_id)
      VALUES ('activity', 'flight', 1, 'invocation', 'flight', 'agent');
  `);
  expect((db.query("PRAGMA foreign_key_list(agent_endpoints)").all() as Array<{ table: string }>)
    .some((fk) => fk.table === "agents")).toBe(true);
  return db;
}

for (const ledger of [true, false]) {
  test(`actor target upgrade preserves existing work and cascaded children (${ledger ? "managed" : "pre-ledger"})`, () => {
    const db = legacyDatabase(ledger);
    try {
      const tables = ["agent_endpoints", "runtime_sessions", "runtime_session_aliases", "invocations", "flights", "activity_items"];
      const before = Object.fromEntries(tables.map((table) => [table, db.query(`SELECT * FROM ${table}`).all()]));
      for (const table of tables) expect(before[table]).toHaveLength(1);
      migrateControlPlaneDatabaseSchema(db);
      for (const table of tables) {
        const expected = table === "invocations"
          ? before[table].map(row => ({ ...(row as Record<string, unknown>), origin_json: null, trace_json: null })) : before[table];
        expect(db.query(`SELECT * FROM ${table}`).all()).toEqual(expected);
        expect((db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).some((fk) => fk.table === "agents")).toBe(false);
      }
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.exec("INSERT INTO actors (id, kind, display_name) VALUES ('session', 'session', 'Session')");
      db.exec("UPDATE agent_endpoints SET agent_id='session'; UPDATE invocations SET target_agent_id='session'; UPDATE flights SET target_agent_id='session'; UPDATE activity_items SET agent_id='session'; UPDATE runtime_sessions SET agent_id='session'; UPDATE runtime_session_aliases SET agent_id='session'");
      expect(db.query("SELECT id FROM agents WHERE id='session'").get()).toBeNull();
      expect(() => db.exec("UPDATE agent_endpoints SET agent_id='missing'")).toThrow(/FOREIGN KEY/);
      migrateControlPlaneDatabaseSchema(db);
      expect(db.query("SELECT output FROM flights").get()).toEqual({ output: "preserve output" });
    } finally { db.close(); }
  });
}

test("failed migration rolls back data, schema and ledger and restores foreign keys", () => {
  const db = legacyDatabase(true);
  try {
    db.exec("PRAGMA foreign_keys=OFF; UPDATE agent_endpoints SET node_id='missing'; PRAGMA foreign_keys=ON;");
    const ledger = db.query('SELECT * FROM "__drizzle_migrations"').all();
    const schema = db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    const endpoint = db.query("SELECT * FROM agent_endpoints").all();
    expect(() => migrateControlPlaneDatabaseSchema(db)).toThrow(/foreign-key validation/);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query('SELECT * FROM "__drizzle_migrations"').all()).toEqual(ledger);
    expect(db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schema);
    expect(db.query("SELECT * FROM agent_endpoints").all()).toEqual(endpoint);
    expect((db.query("PRAGMA foreign_key_list(agent_endpoints)").all() as Array<{ table: string }>).some((fk) => fk.table === "agents")).toBe(true);
    expect(db.query("SELECT output FROM flights").get()).toEqual({ output: "preserve output" });
  } finally { db.close(); }
});

test("real cardless session writes persist endpoint, invocation and flight without an agent card", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-session-actor-regression-"));
  const path = join(root, "control-plane.sqlite");
  const store = new SQLiteControlPlaneStore(path);
  try {
    store.upsertNode({ id: "node", meshId: "mesh", name: "Node", advertiseScope: "local", registeredAt: 1 });
    store.upsertActor({ id: "operator", kind: "human", displayName: "Operator" });
    const input = { sessionId: "session-regression", nodeId: "node", cwd: root, harness: "claude" as const, transport: "tmux" as const };
    const actor = buildCardlessSessionActor(input);
    const endpoint = buildCardlessSessionEndpoint(input);
    store.upsertActor(actor);
    store.upsertEndpoint(endpoint);
    store.recordInvocation({ id: "invocation", requesterId: "operator", requesterNodeId: "node", targetAgentId: actor.id, action: "chat", task: "regression", createdAt: 1 });
    store.recordFlight({ id: "flight", invocationId: "invocation", requesterId: "operator", targetAgentId: actor.id, state: "completed", output: "captured", startedAt: 1, completedAt: 2 });
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("SELECT id FROM agents").all()).toEqual([]);
      expect(db.query("SELECT agent_id FROM agent_endpoints").get()).toEqual({ agent_id: actor.id });
      expect(db.query("SELECT target_agent_id, output FROM flights").get()).toEqual({ target_agent_id: actor.id, output: "captured" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
