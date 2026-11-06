import { WEB_READ_INDEXES_SQL } from "./web-read-indexes.js";
import { INTEGRATION_SLACK_EVENTS_SCHEMA } from "./integration-slack-events.js";
import { INTEGRATION_SLACK_DELIVERY_SCHEMA } from "./integration-slack-delivery.js";
import { INTEGRATION_WORKER_SQLITE_SCHEMA } from "./integration-worker-leases.js";
import { INTEGRATION_SETUP_SQLITE_SCHEMA } from "./integration-setup-schema.js";
import { GUEST_GRANTS_SQLITE_SCHEMA } from "./guest-access.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";
import { readMigrationFiles } from "drizzle-orm/migrator";

import {
  CONTROL_PLANE_RUNTIME_SESSION_SQLITE_SCHEMA,
  CONTROL_PLANE_HISTORY_ANCHORS_SQLITE_SCHEMA,
  CONTROL_PLANE_SCHEMA_VERSION,
  CONTROL_PLANE_SQLITE_SCHEMA,
  MACHINES_SQLITE_SCHEMA,
  CONTROL_PLANE_TERMINAL_SESSION_SQLITE_SCHEMA,
  CONTROL_PLANE_TERMINAL_WORKSPACE_SQLITE_SCHEMA,
} from "./schema.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";
import {
  canonicalMeshNodeId,
  stripBonjourCollisionSuffix,
} from "./node-identity.js";

export type ControlPlaneSchemaMigration = {
  id: string;
  description: string;
  apply: (database: ControlPlaneSqliteDatabase) => void;
};

function hasColumn(database: ControlPlaneSqliteDatabase, tableName: string, columnName: string): boolean {
  const escapedTableName = tableName.replaceAll("'", "''");
  const rows = database.query(
    `SELECT name FROM pragma_table_info('${escapedTableName}')`,
  ).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function hasTable(database: ControlPlaneSqliteDatabase, tableName: string): boolean {
  const row = database.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
  ).get(tableName);
  return Boolean(row);
}

// The legacy column names also carry cardless session actors. Requiring an
// agents row rejects valid broker-owned sessions and cascades into lost flight
// projections. Keep the actor foreign key; do not manufacture agent cards.
const ACTOR_TARGET_TABLES = [
  "agent_endpoints", "runtime_sessions", "runtime_session_aliases",
  "invocations", "flights", "activity_items",
] as const;

function hasLegacyAgentTarget(database: ControlPlaneSqliteDatabase, table: string): boolean {
  return (database.query(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string }>)
    .some((foreignKey) => foreignKey.table === "agents");
}

function repairSessionActorTargets(database: ControlPlaneSqliteDatabase): void {
  for (const table of ACTOR_TARGET_TABLES) {
    if (!hasLegacyAgentTarget(database, table)) continue;
    const foreignKeys = database.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (foreignKeys.foreign_keys !== 0) {
      throw new Error("Session actor target repair requires the control-plane migration transaction with foreign keys suspended.");
    }
    const original = database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1")
      .get(table) as { sql: string };
    const dependents = database.query("SELECT sql FROM sqlite_master WHERE tbl_name = ?1 AND type IN ('index', 'trigger') AND sql IS NOT NULL")
      .all(table) as Array<{ sql: string }>;
    const columns = (database.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(", ");
    const temporary = `__session_actor_${table}`;
    const create = original.sql
      .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\w+)/i, `CREATE TABLE "${temporary}"`)
      .replace(/REFERENCES\s+["`]?agents["`]?\s*\(/gi, 'REFERENCES "actors"(');
    database.exec(create);
    database.exec(`INSERT INTO "${temporary}" (${columns}) SELECT ${columns} FROM "${table}"`);
    database.exec(`DROP TABLE "${table}"`);
    database.exec(`ALTER TABLE "${temporary}" RENAME TO "${table}"`);
    for (const dependent of dependents) database.exec(dependent.sql);
  }
}

// Repair pre-ledger or partially upgraded stores as well as managed migrations.
function repairAttachmentMessageKeys(database: ControlPlaneSqliteDatabase): void {
  if (!hasTable(database, "message_attachments")) return;
  const keys = (database.query("PRAGMA table_info(message_attachments)").all() as Array<{ name: string; pk: number }>)
    .filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
  if (keys.join(",") === "message_id,id") return;
  const blob = hasColumn(database, "message_attachments", "blob_ref_json");
  database.exec(`CREATE TABLE __scoped_message_attachments (
    id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL, file_name TEXT, blob_key TEXT, url TEXT, metadata_json TEXT,
    ${blob ? "blob_ref_json TEXT," : ""}
    PRIMARY KEY (message_id, id));
    INSERT INTO __scoped_message_attachments SELECT id, message_id, media_type, file_name, blob_key, url, metadata_json ${blob ? ", blob_ref_json" : ""} FROM message_attachments;
    DROP TABLE message_attachments;
    ALTER TABLE __scoped_message_attachments RENAME TO message_attachments;`);
}

export const CONTROL_PLANE_SCHEMA_MIGRATIONS: ControlPlaneSchemaMigration[] = [
  { id: "attachment-message-keys", description: "Scopes each attachment binding to its owning canonical message.", apply: repairAttachmentMessageKeys },
  { id: "attachment-blob-ref", description: "Persists typed content bindings, never blob bytes.", apply(database) {
    if (!hasColumn(database, "message_attachments", "blob_ref_json")) database.exec("ALTER TABLE message_attachments ADD COLUMN blob_ref_json TEXT");
  } },
  { id: "broker-history-anchors", description: "Preserves exact canonical history locations and foreign-key identity anchors after payload relocation.",
    apply(database) { database.exec(CONTROL_PLANE_HISTORY_ANCHORS_SQLITE_SCHEMA); } },
  {
    id: "routing-inbox-target-status-index",
    description: "Bounds inbox reads by recipient and state before applying page limits.",
    apply(database) {
      if (hasColumn(database, "deliveries", "target_id")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_deliveries_target_status_created_id ON deliveries (target_id, status, created_at, id)");
      }
    },
  },
  {
    id: "integration-setup-operations",
    description: "Adds broker-owned resumable integration setup and idempotency records.",
    apply(database) { database.exec(INTEGRATION_SETUP_SQLITE_SCHEMA); },
  },
  {
    id: "integration-worker-leases",
    description: "Adds durable, fenced integration worker leases.",
    apply(database) { database.exec(INTEGRATION_WORKER_SQLITE_SCHEMA); },
  },
  {
    id: "integration-slack-deliveries",
    description: "Adds canonical Slack project thread lineage and delivery recovery records.",
    apply(database) { database.exec(INTEGRATION_SLACK_DELIVERY_SCHEMA); },
  },
  {
    id: "integration-slack-events",
    description: "Adds durable observed Slack event intake before Socket Mode acknowledgement.",
    apply(database) { database.exec(INTEGRATION_SLACK_EVENTS_SCHEMA); },
  },
  {
    id: "session-actor-target-foreign-keys",
    description: "Allows canonical session actors in endpoint and work target references without creating agent cards.",
    apply: repairSessionActorTargets,
  },
  {
    id: "runtime-session-mapping-read-model",
    description: "Creates the Scout-owned runtime session and session alias indexes.",
    apply(database) {
      database.exec(CONTROL_PLANE_RUNTIME_SESSION_SQLITE_SCHEMA);
    },
  },
  {
    id: "invocation-collaboration-record-link",
    description: "Adds invocation links back to collaboration records.",
    apply(database) {
      if (!hasColumn(database, "invocations", "collaboration_record_id")) {
        database.exec(
          "ALTER TABLE invocations ADD COLUMN collaboration_record_id TEXT REFERENCES collaboration_records(id) ON DELETE SET NULL",
        );
      }
    },
  },
  {
    id: "invocation-and-flight-labels",
    description: "Adds label metadata columns to invocations and flights.",
    apply(database) {
      if (!hasColumn(database, "invocations", "labels_json")) {
        database.exec("ALTER TABLE invocations ADD COLUMN labels_json TEXT");
      }
      if (!hasColumn(database, "flights", "labels_json")) {
        database.exec("ALTER TABLE flights ADD COLUMN labels_json TEXT");
      }
    },
  },
  {
    id: "invocation-execution-resolution",
    description: "Persists requested, resolved, and observed runtime execution truth on invocations.",
    apply(database) {
      if (!hasColumn(database, "invocations", "execution_resolution_json")) {
        database.exec("ALTER TABLE invocations ADD COLUMN execution_resolution_json TEXT");
      }
    },
  },
  {
    id: "invocation-origin-and-trace",
    description: "Adds ask origin and creation-time trace context without guessing historical values.",
    apply(database) {
      if (!hasColumn(database, "invocations", "origin_json")) database.exec("ALTER TABLE invocations ADD COLUMN origin_json TEXT");
      if (!hasColumn(database, "invocations", "trace_json")) database.exec("ALTER TABLE invocations ADD COLUMN trace_json TEXT");
    },
  },
  {
    id: "terminal-session-registry",
    description: "Creates the Scout-owned terminal session registry (harness session + surfaces).",
    apply(database) {
      database.exec(CONTROL_PLANE_TERMINAL_SESSION_SQLITE_SCHEMA);
    },
  },
  {
    // Purely additive, and deliberately not accompanied by a
    // CONTROL_PLANE_SCHEMA_VERSION bump: bumping would make every older build
    // sharing this control home refuse to open the database
    // (assertControlPlaneSchemaNotNewer), and a new table an older build never
    // reads costs it nothing. Bump when an existing shape changes.
    id: "terminal-workspaces",
    description: "Creates the Scout-owned durable terminal workspace table (named tile arrangements + revive intent).",
    apply(database) {
      database.exec(CONTROL_PLANE_TERMINAL_WORKSPACE_SQLITE_SCHEMA);
    },
  },
  {
    // The table above is created with layout_json, but it already exists
    // without it on machines that ran the branch that introduced it, and
    // `CREATE TABLE IF NOT EXISTS` is a no-op on those — the whole reason the
    // workspace layout silently failed to persist there. A shape change needs
    // a real guarded ALTER, exactly like briefings.markdown below. Still
    // additive, so still no CONTROL_PLANE_SCHEMA_VERSION bump: an older build
    // that never reads this table cannot be hurt by a column on it.
    id: "terminal-workspaces-layout-column",
    description: "Adds terminal_workspaces.layout_json to databases whose table predates authored layouts.",
    apply(database) {
      if (!hasColumn(database, "terminal_workspaces", "layout_json")) {
        database.exec("ALTER TABLE terminal_workspaces ADD COLUMN layout_json TEXT");
      }
    },
  },
  {
    id: "briefings-markdown-column",
    description:
      "Adds briefings.markdown to databases provisioned before schema v8 (folds in the web server's defensive ALTER; SCO-037).",
    apply(database) {
      if (!hasColumn(database, "briefings", "markdown")) {
        database.exec("ALTER TABLE briefings ADD COLUMN markdown TEXT");
      }
    },
  },
  {
    id: "drop-one-orchestrator-unique-index",
    description:
      "Drops partial unique idx_role_assignments_one_orchestrator_per_mission so enforceSingleOrchestrator:false works; default single-orch stays app-enforced.",
    apply(database) {
      database.exec("DROP INDEX IF EXISTS idx_role_assignments_one_orchestrator_per_mission");
    },
  },
  {
    id: "read-model-indexes",
    description: "Creates durable read indexes used by broker and dashboard queries.",
    apply(database) {
      database.exec(`
CREATE INDEX IF NOT EXISTS idx_invocations_collaboration_record_id_created_at
  ON invocations(collaboration_record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invocations_requester_created_at
  ON invocations(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flights_invocation_id
  ON flights(invocation_id);
CREATE INDEX IF NOT EXISTS idx_activity_items_ts
  ON activity_items(ts DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at
  ON conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_endpoints_roster_recency
  ON agent_endpoints (
    CASE
      WHEN updated_at IS NULL THEN NULL
      WHEN CAST(updated_at AS REAL) < 1000000000000
        THEN CAST(CAST(updated_at AS REAL) * 1000 AS INTEGER)
      ELSE CAST(updated_at AS INTEGER)
    END DESC,
    agent_id
  );
`);
      // Some pre-ledger pilot databases have the legacy two-column
      // conversations table. The raw schema cannot conditionally create this
      // index, so keep the repair guarded just like additive columns.
      if (hasColumn(database, "conversations", "authority_node_id")) {
        database.exec(`
CREATE INDEX IF NOT EXISTS idx_conversations_authority_node_id
  ON conversations(authority_node_id);
`);
      }
    },
  },
  {
    id: "invocation-status-columns",
    description:
      "Adds flight status columns to invocations (flight→invocation storage merge, expand/dual-write phase). Data repair lives in invocation-flight-status-reconcile below.",
    apply(database) {
      const statusColumns: Array<[string, string]> = [
        ["flight_id", "TEXT"],
        ["state", "TEXT"],
        ["summary", "TEXT"],
        ["output", "TEXT"],
        ["error", "TEXT"],
        ["started_at", "INTEGER"],
        ["completed_at", "INTEGER"],
      ];
      for (const [name, type] of statusColumns) {
        if (!hasColumn(database, "invocations", name)) {
          database.exec(`ALTER TABLE invocations ADD COLUMN ${name} ${type}`);
        }
      }
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_invocations_flight_id ON invocations(flight_id);",
      );
    },
  },
  {
    id: "invocation-flight-status-reconcile",
    description:
      "Adds flight_metadata_json to invocations (read-switch phase: the latest flight's metadata rides the merged record), then reconciles EVERY shadow column against each invocation's latest flight. Self-healing: runs on every boot, so shadows diverged by any path — pre-ledger databases that seeded 0002 as already-applied, crash windows on builds before the dual-write became transactional, manual edits — converge before reads (which now come from the shadow) can serve them.",
    apply(database) {
      if (!hasColumn(database, "invocations", "flight_metadata_json")) {
        database.exec("ALTER TABLE invocations ADD COLUMN flight_metadata_json TEXT");
      }
      // The flights table has carried every source column since the schema
      // foundation; this guard only skips shapes older than that support
      // floor (nothing to reconcile from — the dual-write populates the
      // shadow from first boot on).
      const reconcileSourceColumns = [
        "invocation_id",
        "state",
        "summary",
        "output",
        "error",
        "metadata_json",
        "started_at",
        "completed_at",
      ];
      if (!reconcileSourceColumns.every((name) => hasColumn(database, "flights", name))) {
        return;
      }
      // Latest flight = newest completion/start timestamp, ties broken by
      // most recent write (recordFlight advances rowid on conflict without
      // replacing the parent key, so rowid order remains write order) — the
      // same ordering its invocation-shadow guard enforces. The IS NOT clauses
      // make the no-divergence boot a pure read. Invocations with no flights at
      // all are left alone.
      // Archived invocation anchors retain their canonical latest flight ID;
      // the corresponding full flight may now live only in historical storage.
      const retainArchivedShadow = hasTable(database, "broker_history_anchors")
        ? "AND NOT EXISTS (SELECT 1 FROM broker_history_anchors h WHERE h.kind='invocation' AND h.id=inv.id)" : "";
      database.exec(`
UPDATE invocations AS inv
SET
  flight_id = latest.id,
  state = latest.state,
  summary = latest.summary,
  output = latest.output,
  error = latest.error,
  started_at = latest.started_at,
  completed_at = latest.completed_at,
  flight_metadata_json = latest.metadata_json
FROM (
  SELECT invocation_id, id, state, summary, output, error, started_at, completed_at, metadata_json,
    ROW_NUMBER() OVER (
      PARTITION BY invocation_id
      ORDER BY COALESCE(completed_at, started_at, 0) DESC, rowid DESC
    ) AS rn
  FROM flights
) AS latest
WHERE latest.invocation_id = inv.id
  ${retainArchivedShadow}
  AND latest.rn = 1
  AND (
    inv.flight_id IS NOT latest.id
    OR inv.state IS NOT latest.state
    OR inv.summary IS NOT latest.summary
    OR inv.output IS NOT latest.output
    OR inv.error IS NOT latest.error
    OR inv.started_at IS NOT latest.started_at
    OR inv.completed_at IS NOT latest.completed_at
    OR inv.flight_metadata_json IS NOT latest.metadata_json
  );
`);
    },
  },
  {
    // Additive nullable column (mesh-trust-cone §11.2), so no
    // CONTROL_PLANE_SCHEMA_VERSION bump — same reasoning as
    // terminal-workspaces above. The guarded ALTER covers databases whose
    // trusted_peers table predates the column and whose Drizzle ledger was
    // seeded as fully applied (or whose 0008 came from a branch build).
    id: "trusted-peers-tls-spki-fingerprint",
    description: "Adds trusted_peers.tls_spki_fingerprint (the §11.2 durable TLS pin) to databases whose table predates it.",
    apply(database) {
      if (!hasColumn(database, "trusted_peers", "tls_spki_fingerprint")) {
        database.exec("ALTER TABLE trusted_peers ADD COLUMN tls_spki_fingerprint TEXT");
      }
    },
  },
  {
    id: "canonicalize-mesh-nodes-and-rehome",
    description: "Re-homes foreign key references on Bonjour collision-suffixed ghost nodes to canonical stable node IDs and prunes ghost nodes.",
    apply(database) {
      if (!hasTable(database, "nodes")) return;
      const nodeRows = database.query("SELECT * FROM nodes").all() as Array<{
        id: string;
        mesh_id: string;
        name: string;
        host_name: string | null;
        advertise_scope: string;
        broker_url: string | null;
        tailnet_name: string | null;
        capabilities_json: string | null;
        labels_json: string | null;
        metadata_json: string | null;
        last_seen_at: number | null;
        registered_at: number;
      }>;
      for (const row of nodeRows) {
        const canonicalId = canonicalMeshNodeId(row.id);
        if (canonicalId && canonicalId !== row.id) {
          const existing = nodeRows.find((r) => r.id === canonicalId);
          if (!existing) {
            database.query(
              `INSERT INTO nodes (
                id, mesh_id, name, host_name, advertise_scope, broker_url, tailnet_name,
                capabilities_json, labels_json, metadata_json, last_seen_at, registered_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
              ON CONFLICT(id) DO UPDATE SET
                last_seen_at = MAX(COALESCE(nodes.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0)),
                broker_url = COALESCE(excluded.broker_url, nodes.broker_url),
                tailnet_name = COALESCE(excluded.tailnet_name, nodes.tailnet_name)`,
            ).run(
              canonicalId,
              row.mesh_id,
              stripBonjourCollisionSuffix(row.name) || row.name,
              stripBonjourCollisionSuffix(row.host_name ?? "") || (row.host_name ?? null),
              row.advertise_scope,
              row.broker_url ?? null,
              row.tailnet_name ?? null,
              row.capabilities_json ?? null,
              row.labels_json ?? null,
              row.metadata_json ?? null,
              row.last_seen_at ?? null,
              row.registered_at,
            );
          }
          database.query("UPDATE agents SET home_node_id = ?1 WHERE home_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE agents SET authority_node_id = ?1 WHERE authority_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE agent_endpoints SET node_id = ?1 WHERE node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE runtime_sessions SET node_id = ?1 WHERE node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE runtime_session_aliases SET node_id = ?1 WHERE node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE conversations SET authority_node_id = ?1 WHERE authority_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE conversation_read_cursors SET reader_node_id = ?1 WHERE reader_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE messages SET origin_node_id = ?1 WHERE origin_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE deliveries SET target_node_id = ?1 WHERE target_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE invocations SET requester_node_id = ?1 WHERE requester_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE invocations SET target_node_id = ?1 WHERE target_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE thread_events SET authority_node_id = ?1 WHERE authority_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE thread_cursors SET authority_node_id = ?1 WHERE authority_node_id = ?2").run(canonicalId, row.id);
          database.query("UPDATE trusted_peers SET node_id = ?1 WHERE node_id = ?2").run(canonicalId, row.id);
          database.query("DELETE FROM nodes WHERE id = ?1").run(row.id);
        }
      }
    },
  },
  {
    // Additive table, so no CONTROL_PLANE_SCHEMA_VERSION bump — same reasoning
    // as the entries above: an older build simply never reads it.
    id: "machines-inventory",
    description: "Creates the durable machine inventory (mesh nodes, tailnet peers, and LAN sightings joined into one record per physical machine).",
    apply(database) {
      if (!hasTable(database, "machines")) {
        database.exec(MACHINES_SQLITE_SCHEMA);
      }
    },
  },
  {
    // Indexes on foreign-key columns that reference `actors`. Without them a
    // DELETE FROM actors triggers a full child-table scan per column — with
    // tens of thousands of runtime_session_aliases rows that made each
    // registry-retention actor delete cost ~30 ms. These live only here (not
    // in CONTROL_PLANE_SQLITE_SCHEMA or the Drizzle schema) because the raw
    // schema exec runs before the imperative column-adds and table rebuilds
    // above, and several of these columns can be absent on legacy tables —
    // the same reason idx_invocations_flight_id is imperative-only.
    id: "actor-foreign-key-indexes",
    description: "Indexes actor foreign-key columns so actor deletes are bounded.",
    apply(database) {
      const indexes: Array<[table: string, column: string, sql: string]> = [
        ["runtime_session_aliases", "agent_id",
          "CREATE INDEX IF NOT EXISTS idx_runtime_session_aliases_agent ON runtime_session_aliases (agent_id)"],
        ["thread_events", "actor_id",
          "CREATE INDEX IF NOT EXISTS idx_thread_events_actor ON thread_events (actor_id)"],
        ["activity_items", "counterpart_id",
          "CREATE INDEX IF NOT EXISTS idx_activity_items_counterpart ON activity_items (counterpart_id)"],
        ["message_mentions", "actor_id",
          "CREATE INDEX IF NOT EXISTS idx_message_mentions_actor ON message_mentions (actor_id)"],
        ["message_reactions", "actor_id",
          "CREATE INDEX IF NOT EXISTS idx_message_reactions_actor ON message_reactions (actor_id)"],
        ["flights", "requester_id",
          "CREATE INDEX IF NOT EXISTS idx_flights_requester ON flights (requester_id)"],
        ["conversation_read_cursors", "actor_id",
          "CREATE INDEX IF NOT EXISTS idx_read_cursors_actor ON conversation_read_cursors (actor_id)"],
        ["collaboration_events", "actor_id",
          "CREATE INDEX IF NOT EXISTS idx_collaboration_events_actor ON collaboration_events (actor_id)"],
        ["collaboration_records", "created_by_id",
          "CREATE INDEX IF NOT EXISTS idx_collaboration_records_created_by ON collaboration_records (created_by_id)"],
      ];
      for (const [table, column, sql] of indexes) {
        if (hasColumn(database, table, column)) database.exec(sql);
      }
    },
  },
  {
    // Additive owner-approved guest grants (docs/proposals/scout-tailscale.md).
    // GuestGrantStore also creates the table on first use; an older build
    // simply never reads it.
    id: "guest-grants",
    description: "Creates guest_grants for owner-approved Scout guest keys, separate from trusted_peers.",
    apply(database) {
      database.exec(GUEST_GRANTS_SQLITE_SCHEMA);
    },
  },
  {
    // The archive pages `events` by `ts < cutoff ORDER BY ts, id`. The only
    // existing index is (kind, ts), so every page was a full table scan —
    // 20+ seconds per 10k rows on a 1.2M-row table, held under the canonical
    // writer. Measured on the live node: ~150 ms per page with this index.
    id: "events-ts-id-index",
    description: "Indexes events (ts, id) so archive paging is bounded.",
    apply(database) {
      if (hasColumn(database, "events", "ts")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_events_ts_id ON events (ts, id)");
      }
    },
  },
  {
    id: "web-read-ordering-indexes",
    description: "Indexes normalized history ordering and active invocation reads without scanning payload history.",
    apply(database) { database.exec(WEB_READ_INDEXES_SQL); },
  },
];

export function configureControlPlaneDatabase(database: ControlPlaneSqliteDatabase): void {
  // busy_timeout must be set before WAL, because journal_mode can need a write lock.
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec("PRAGMA foreign_keys = ON;");
}

export function resolveControlPlaneDrizzleMigrationsFolder(): string {
  // This module runs from several on-disk layouts: packages/runtime/src (dev)
  // and packages/runtime/dist resolve the folder as a sibling of their parent,
  // while the CLI's bundles embed it at two depths (dist/main.mjs and
  // dist/runtime/*.mjs) around the dist/drizzle copy the CLI build makes.
  const candidates = ["../drizzle", "./drizzle"];
  for (const candidate of candidates) {
    const folder = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(join(folder, "meta", "_journal.json"))) {
      return folder;
    }
  }
  return fileURLToPath(new URL(candidates[0]!, import.meta.url));
}

// Identical to the DDL drizzle-orm's bun-sqlite migrator creates for its
// ledger (sqlite-core dialect `migrate`), so seeding and the real migrator
// always agree on the table shape.
const DRIZZLE_MIGRATIONS_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
)
`;

type ControlPlaneDrizzleMigrations = ReturnType<typeof readMigrationFiles>;

// A short-lived role-assignment branch shipped its own 0003-0005 migration
// lineage before the context and route-alias migrations landed on main. Pilot
// databases can therefore contain the final role schema under these hashes,
// while the current journal assigns that equivalent DDL to 0004. Preserve the
// historical rows and add the current identities so the migrator does not
// replay plain CREATE TABLE statements over an already-upgraded database.
const LEGACY_ROLE_MIGRATION_HASHES = [
  "0b135c4d057d5c26bddb07d1cbda3f027bd2ef4d90babfc2e23fede3ff8be5cb",
  "7df85f271d1a6e9e37552adf3dc2f1869ca0f685b343aaf328488aeb11a2f64d",
  "7b2b31c19f753638f597e2f73dee3855a84f3d4c6aec7e615825745d81928aac",
] as const;

const RECONCILED_MAIN_MIGRATION_MILLIS = [
  1783665705710, // context tables: supplied by the idempotent raw-schema repair below
  1784834739171, // role assignments + mission log: equivalent legacy DDL already applied
] as const;

function hasSchemaObject(
  database: ControlPlaneSqliteDatabase,
  type: "table" | "index",
  name: string,
): boolean {
  return database
    .query("SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2 LIMIT 1")
    .get(type, name) !== null;
}

function reconcileLegacyRoleMigrationLineage(
  database: ControlPlaneSqliteDatabase,
  migrations: ControlPlaneDrizzleMigrations,
): void {
  const hasLegacyChain = LEGACY_ROLE_MIGRATION_HASHES.every((hash) =>
    database
      .query('SELECT 1 FROM "__drizzle_migrations" WHERE hash = ?1 LIMIT 1')
      .get(hash) !== null
  );
  if (!hasLegacyChain) {
    return;
  }

  const equivalentRoleShape: Array<["table" | "index", string]> = [
    ["table", "mission_log_entries"],
    ["table", "role_assignments"],
    ["index", "idx_mission_log_entries_mission_seq"],
    ["index", "idx_mission_log_entries_mission_at"],
    ["index", "idx_mission_log_entries_actor_at"],
    ["index", "idx_role_assignments_agent_active"],
    ["index", "idx_role_assignments_mission_role_active"],
    ["index", "idx_role_assignments_role_active"],
  ];
  if (!equivalentRoleShape.every(([type, name]) => hasSchemaObject(database, type, name))) {
    return;
  }

  for (const folderMillis of RECONCILED_MAIN_MIGRATION_MILLIS) {
    const migration = migrations.find((candidate) => candidate.folderMillis === folderMillis);
    if (!migration) {
      continue;
    }
    database
      .query(
        `INSERT INTO "__drizzle_migrations" (hash, created_at)
         SELECT ?1, ?2
         WHERE NOT EXISTS (
           SELECT 1 FROM "__drizzle_migrations" WHERE hash = ?1
         )`,
      )
      .run(migration.hash, migration.folderMillis);
  }
}

function reconcilePreLedgerExecutionResolutionMigration(
  database: ControlPlaneSqliteDatabase,
  migrations: ControlPlaneDrizzleMigrations,
): void {
  const migrationIndex = migrations.findIndex((migration) =>
    migration.sql.some((statement) =>
      statement.includes("ALTER TABLE `invocations` ADD `execution_resolution_json`")
    )
  );
  if (migrationIndex <= 0 || !hasColumn(database, "invocations", "execution_resolution_json")) {
    return;
  }

  const migration = migrations[migrationIndex]!;
  const alreadyRecorded = database
    .query('SELECT 1 FROM "__drizzle_migrations" WHERE hash = ?1 LIMIT 1')
    .get(migration.hash) !== null;
  if (alreadyRecorded) {
    return;
  }

  // The first v17 build shipped the guarded imperative ALTER before its
  // generated Drizzle migration. A database opened by that build therefore
  // has the column and a ledger ending at the prior migration. Only reconcile
  // when every earlier identity is present; inserting the newest timestamp
  // into a partial ledger would otherwise skip unrelated pending migrations.
  const allEarlierMigrationsRecorded = migrations
    .slice(0, migrationIndex)
    .every((candidate) =>
      database
        .query('SELECT 1 FROM "__drizzle_migrations" WHERE hash = ?1 LIMIT 1')
        .get(candidate.hash) !== null
    );
  if (!allEarlierMigrationsRecorded) {
    return;
  }

  database
    .query('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?1, ?2)')
    .run(migration.hash, migration.folderMillis);
}

function seedControlPlaneDrizzleLedger(
  database: ControlPlaneSqliteDatabase,
  migrations: ControlPlaneDrizzleMigrations,
): void {
  if (migrations.length === 0) {
    return;
  }

  // Databases that predate the managed-migration ledger were built by the raw
  // schema exec, which always renders the CURRENT full shape — so every
  // checked-in migration's effects are either already present or covered by
  // the raw-exec/imperative repair layer that runs right after the migrator.
  // Replaying any of them (the baseline's plain CREATE TABLEs, a later
  // migration's plain ADD COLUMNs) over such a database would fail. When the
  // ledger is empty but the database already has tables, record the WHOLE
  // chain as applied; the migrator then only runs migrations added in future
  // builds. (This relies on the standing lockstep discipline: every drizzle
  // migration ships with its raw-schema + imperative-array equivalent, which
  // the parity gates enforce on the raw side.) A truly virgin database keeps
  // an empty ledger so the migrator applies the chain for real. Runs under
  // the caller's IMMEDIATE transaction; the single guarded statement is
  // belt-and-braces on top of that.
  const params: Record<string, string | number> = {};
  const rows = migrations
    .map((migration, i) => {
      params[`$hash${i}`] = migration.hash;
      params[`$createdAt${i}`] = migration.folderMillis;
      return i === 0
        ? `SELECT $hash${i} AS hash, $createdAt${i} AS created_at`
        : `UNION ALL SELECT $hash${i}, $createdAt${i}`;
    })
    .join("\n         ");
  database
    .query(
      `INSERT INTO "__drizzle_migrations" (hash, created_at)
       SELECT hash, created_at FROM (
         ${rows}
       )
       WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations")
         AND EXISTS (
           SELECT 1 FROM sqlite_master
           WHERE type = 'table'
             AND name NOT GLOB 'sqlite_*'
             AND name != '__drizzle_migrations'
         )`,
    )
    .run(params);
}

function controlPlaneDatabaseFilename(database: ControlPlaneSqliteDatabase): string {
  const filename = (database as { filename?: unknown }).filename;
  return typeof filename === "string" && filename.trim() ? filename : "<unknown>";
}

export function applyControlPlaneDrizzleMigrations(database: ControlPlaneSqliteDatabase): boolean {
  const migrationsFolder = resolveControlPlaneDrizzleMigrationsFolder();
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    return false;
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  database.exec(DRIZZLE_MIGRATIONS_LEDGER_SQL);
  seedControlPlaneDrizzleLedger(database, migrations);
  reconcileLegacyRoleMigrationLineage(database, migrations);
  reconcilePreLedgerExecutionResolutionMigration(database, migrations);

  // Inlined replacement for drizzle-orm's bun-sqlite `migrate()`: identical
  // ledger contract (same table shape, same "created_at newer than the last
  // applied row" pending check), but with no internal BEGIN, so the whole
  // check-then-apply runs inside the caller's IMMEDIATE transaction. The
  // upstream migrator reads the ledger BEFORE taking the write lock — two
  // concurrent boots could both decide the same migration was pending, and
  // the loser crashed replaying DDL the winner had already applied.
  const lastApplied = database
    .query('SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1')
    .get() as { created_at: number | string } | null;
  const lastAppliedMillis = lastApplied === null ? null : Number(lastApplied.created_at);
  for (const migration of migrations) {
    if (lastAppliedMillis === null || lastAppliedMillis < migration.folderMillis) {
      for (const statement of migration.sql) {
        // The additive repair layer may already have installed these columns.
        const askColumn = /^ALTER TABLE `invocations` ADD `(origin_json|trace_json)` text;?$/i.exec(statement.trim());
        if (askColumn && hasColumn(database, "invocations", askColumn[1]!)) continue;
        database.exec(statement);
      }
      database
        .query('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?1, ?2)')
        .run(migration.hash, migration.folderMillis);
    }
  }
  return true;
}

export function assertControlPlaneSchemaNotNewer(database: ControlPlaneSqliteDatabase): void {
  const row = database.query("PRAGMA user_version").get() as { user_version: number } | null;
  const stampedVersion = row?.user_version ?? 0;
  if (stampedVersion > CONTROL_PLANE_SCHEMA_VERSION) {
    throw new Error(
      `Control-plane database "${controlPlaneDatabaseFilename(database)}" is stamped schema v${stampedVersion}, ` +
        `but this build only knows v${CONTROL_PLANE_SCHEMA_VERSION}. Refusing to open a ` +
        `database written by a newer build — upgrade OpenScout instead of downgrading.`,
    );
  }
}

export function applyControlPlaneSchemaMigrations(database: ControlPlaneSqliteDatabase): void {
  for (const migration of CONTROL_PLANE_SCHEMA_MIGRATIONS) {
    migration.apply(database);
  }
}

export function stampControlPlaneSchemaVersion(database: ControlPlaneSqliteDatabase): void {
  database.exec(`PRAGMA user_version = ${CONTROL_PLANE_SCHEMA_VERSION};`);
}

// How long a booting process waits for a concurrent migrator to finish before
// giving up. Generous: real migrations complete in well under a second.
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;

export function migrateControlPlaneDatabaseSchema(database: ControlPlaneSqliteDatabase): void {
  // The entire pipeline runs under ONE IMMEDIATE transaction: BEGIN IMMEDIATE
  // takes the database write lock BEFORE any pending-migration check, so
  // concurrent boots fully serialize — the loser blocks at BEGIN (SQLite's
  // busy handler waits), then re-reads a ledger the winner already advanced
  // and applies nothing. Without the up-front lock, two boots in the
  // migration window can both see the same migration as pending and the
  // loser crashes replaying its DDL. The lock also makes the whole migration
  // atomic: a crash mid-pipeline rolls back to the prior shape instead of
  // leaving a half-migrated database.
  //
  // Two pragmas must be set OUTSIDE the transaction: busy_timeout is what
  // makes BEGIN IMMEDIATE wait instead of failing instantly, and journal_mode
  // cannot change into WAL from within a transaction (the raw schema string
  // re-asserts WAL, which is only legal inside a transaction when the mode is
  // not actually changing). Both are idempotent re-asserts of
  // configureControlPlaneDatabase for callers that skipped it; on :memory:
  // test databases the WAL attempt is a silent no-op.
  database.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS};`);
  database.exec("PRAGMA journal_mode = WAL;");
  const previousForeignKeys = (database.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  const previousVersion = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const rebuildsActorTargets = previousVersion < 18
    || ACTOR_TARGET_TABLES.some((table) => hasLegacyAgentTarget(database, table));
  // SQLite ignores foreign_keys changes within a transaction. Table rebuilds
  // with enforcement enabled can cascade-delete unrelated child records when
  // DROP TABLE runs. Suspend before BEGIN, validate before COMMIT, and always
  // restore the caller's enforcement setting, including lock/rollback failures.
  if (rebuildsActorTargets) database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec("BEGIN IMMEDIATE");
    // Checked under the lock so a newer build that migrated while we waited
    // is seen before we touch anything.
    assertControlPlaneSchemaNotNewer(database);
    // Managed migrations run first: a virgin database gets its schema from the
    // baseline through the migrator; an existing database gets the whole chain
    // seeded as already-applied and only newer migrations execute. The raw
    // schema exec and the imperative array then act as the idempotent repair
    // layer, exactly as before.
    applyControlPlaneDrizzleMigrations(database);
    database.exec(CONTROL_PLANE_SQLITE_SCHEMA);
    applyControlPlaneSchemaMigrations(database);
    if (rebuildsActorTargets && database.query("PRAGMA foreign_key_check").get()) {
      throw new Error("Control-plane actor target migration failed foreign-key validation; rolling back.");
    }
    stampControlPlaneSchemaVersion(database);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may already have rolled back (e.g. the connection hit
      // a fatal error); surfacing the original failure matters more.
    }
    throw error;
  } finally {
    database.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? "ON" : "OFF"};`);
    // Back to the standing runtime timeout configureControlPlaneDatabase sets.
    database.exec("PRAGMA busy_timeout = 5000;");
  }
}

export function resolveControlPlaneDatabasePath(): string {
  const explicitPath = process.env.OPENSCOUT_CONTROL_PLANE_DB?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  return join(resolveOpenScoutSupportPaths().controlHome, "control-plane.sqlite");
}
