import { INTEGRATION_SLACK_EVENTS_SCHEMA } from "./integration-slack-events.js";
import { INTEGRATION_SLACK_DELIVERY_SCHEMA } from "./integration-slack-delivery.js";
import { INTEGRATION_WORKER_SQLITE_SCHEMA } from "./integration-worker-leases.js";
import { INTEGRATION_SETUP_SQLITE_SCHEMA } from "./integration-setup-schema.js";
export * from "./drizzle-schema.js";
export { CONTROL_PLANE_SCHEMA_VERSION } from "./schema-version.js";

export const CONTROL_PLANE_RUNTIME_SESSION_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES agent_endpoints(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  harness TEXT NOT NULL,
  transport TEXT NOT NULL,
  state TEXT NOT NULL,
  primary_alias TEXT NOT NULL,
  external_session_id TEXT,
  cwd TEXT,
  project_root TEXT,
  started_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER,
  expires_at INTEGER,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_session_aliases (
  alias TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  alias_kind TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES agent_endpoints(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  harness TEXT NOT NULL,
  transport TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (alias, session_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_sessions_agent_last_seen
  ON runtime_sessions (agent_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_endpoint_last_seen
  ON runtime_sessions (endpoint_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_node_id
  ON runtime_sessions (node_id);
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_external
  ON runtime_sessions (external_session_id);
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_expires
  ON runtime_sessions (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_session_aliases_alias
  ON runtime_session_aliases (alias, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_session_aliases_session
  ON runtime_session_aliases (session_id);
CREATE INDEX IF NOT EXISTS idx_runtime_session_aliases_endpoint
  ON runtime_session_aliases (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_runtime_session_aliases_node_id
  ON runtime_session_aliases (node_id);
CREATE INDEX IF NOT EXISTS idx_runtime_session_aliases_expires
  ON runtime_session_aliases (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS route_alias_bindings (
  id TEXT PRIMARY KEY,
  normalized_alias TEXT NOT NULL,
  display_alias TEXT,
  owner_realm_id TEXT NOT NULL,
  scope_project_key TEXT NOT NULL,
  scope_project_root TEXT,
  scope_node_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('agent', 'session')),
  target_agent_id TEXT,
  target_session_id TEXT,
  target_endpoint_id TEXT,
  target_node_id TEXT NOT NULL,
  target_harness TEXT,
  target_snapshot_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'unset', 'expired')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_by_actor_id TEXT NOT NULL,
  updated_by_actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  metadata_json TEXT,
  CONSTRAINT route_alias_bindings_target_shape_check CHECK (
    (target_kind = 'agent' AND target_agent_id IS NOT NULL AND target_session_id IS NULL AND target_endpoint_id IS NULL AND target_harness IS NULL)
    OR
    (target_kind = 'session' AND target_agent_id IS NOT NULL AND target_session_id IS NOT NULL AND target_endpoint_id IS NOT NULL AND target_harness IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS route_alias_revisions (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL,
  old_target_json TEXT,
  new_target_json TEXT,
  old_target_snapshot_json TEXT,
  new_target_snapshot_json TEXT,
  actor_id TEXT NOT NULL,
  authority_node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reason TEXT,
  request_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_alias_bindings_active_scope
  ON route_alias_bindings (owner_realm_id, scope_project_key, scope_node_id, normalized_alias)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_route_alias_bindings_target_agent
  ON route_alias_bindings (target_agent_id);
CREATE INDEX IF NOT EXISTS idx_route_alias_bindings_target_session
  ON route_alias_bindings (target_session_id);
CREATE INDEX IF NOT EXISTS idx_route_alias_bindings_scope_updated
  ON route_alias_bindings (owner_realm_id, scope_project_key, scope_node_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_alias_bindings_expires
  ON route_alias_bindings (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_alias_revisions_binding_revision
  ON route_alias_revisions (binding_id, revision);
CREATE INDEX IF NOT EXISTS idx_route_alias_revisions_binding_created
  ON route_alias_revisions (binding_id, created_at DESC);
`;

// Scout-owned registry of harness sessions and the disposable terminal surfaces
// they have been materialized through. The source session id is the stable
// identity; surfaces (tmux/zellij/future) are interchangeable. No foreign keys:
// a harness session can be known/resumable without any broker agent endpoint.
export const CONTROL_PLANE_TERMINAL_SESSION_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS terminal_session_registry (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  resume_command TEXT NOT NULL,
  surfaces_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_terminal_session_registry_source
  ON terminal_session_registry (source_session_id);
CREATE INDEX IF NOT EXISTS idx_terminal_session_registry_updated
  ON terminal_session_registry (updated_at DESC);
`;

// Scout-owned durable terminal workspaces: named arrangements of agent-CLI
// tiles. Each cell stores the INTENT needed to re-materialize it (host, session
// name, cwd, resume command), not only the surface it last bound to — a cell
// that remembers only a session name is worthless after a reboot. No foreign
// keys: a workspace may reference surfaces on hosts this node cannot currently
// reach, and losing a host must not delete the layout.
export const CONTROL_PLANE_TERMINAL_WORKSPACE_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS terminal_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  columns_count INTEGER NOT NULL DEFAULT 2,
  -- The authored layout: shape plus column count, where the count may be the
  -- literal "dynamic". columns_count above is the RESOLVED number at the time
  -- of writing, kept for clients that predate layouts; it cannot stand in for
  -- this one, because resolving is lossy in both directions. "dynamic" comes
  -- back pinned to whatever number the tile count produced, and a lanes
  -- workspace with more tiles than the six-column clamp reloads as a grid.
  layout_json TEXT,
  cells_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_terminal_workspaces_updated
  ON terminal_workspaces (updated_at DESC);
`;

// Machine inventory, as the idempotent repair layer for databases that predate
// it. Mirrors the `machines` block inside CONTROL_PLANE_SQLITE_SCHEMA exactly —
// the imperative migration execs this one when the table is missing.
export const MACHINES_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  identity_keys_json TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  scout_node_id TEXT,
  mesh_id TEXT,
  tailnet_id TEXT,
  tailnet_name TEXT,
  host_names_json TEXT,
  addresses_json TEXT,
  mac_addresses_json TEXT,
  capabilities_json TEXT,
  routes_json TEXT,
  evidence_json TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  metadata_json TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_machines_last_seen_at
  ON machines (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_machines_scout_node_id
  ON machines (scout_node_id);
`;

// Do not AUTHOR schema changes here. The declarative model in
// drizzle-schema.ts is the schema authority: edit it there, run `bun run
// db:generate`, commit the generated migration, and then mirror the change
// into this string (see packages/runtime/drizzle/README.md). This string
// remains the idempotent repair layer for existing databases;
// drizzle-schema-parity.test.ts fails the moment it drifts from the model
// or from the checked-in migration chain, so the mirror step cannot be
// skipped or fudged.
export const CONTROL_PLANE_HISTORY_ANCHORS_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS broker_history_anchors (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  location_json TEXT NOT NULL,
  PRIMARY KEY(kind, id)
);
`;

export const CONTROL_PLANE_SQLITE_SCHEMA = `
${CONTROL_PLANE_HISTORY_ANCHORS_SQLITE_SCHEMA}
${INTEGRATION_SETUP_SQLITE_SCHEMA}
${INTEGRATION_WORKER_SQLITE_SCHEMA}
${INTEGRATION_SLACK_DELIVERY_SCHEMA}
${INTEGRATION_SLACK_EVENTS_SCHEMA}
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  name TEXT NOT NULL,
  host_name TEXT,
  advertise_scope TEXT NOT NULL,
  broker_url TEXT,
  tailnet_name TEXT,
  capabilities_json TEXT,
  labels_json TEXT,
  metadata_json TEXT,
  last_seen_at INTEGER,
  registered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  -- Sorted durable identity keys, JSON array. This is the join key set the
  -- next inventory pass seeds its grouping with, so a machine seen by one
  -- channel today and another tomorrow stays one record.
  identity_keys_json TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  scout_node_id TEXT,
  mesh_id TEXT,
  tailnet_id TEXT,
  tailnet_name TEXT,
  host_names_json TEXT,
  addresses_json TEXT,
  mac_addresses_json TEXT,
  capabilities_json TEXT,
  routes_json TEXT,
  evidence_json TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  metadata_json TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trusted_peers (
  key_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  node_id TEXT,
  label TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('observe', 'control')),
  granted_via TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  metadata_json TEXT,
  tls_spki_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS peer_nonces (
  peer_key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (peer_key_id, nonce)
);

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  handle TEXT,
  labels_json TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  node_qualifier TEXT,
  workspace_qualifier TEXT,
  selector TEXT,
  default_selector TEXT,
  agent_class TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  wake_policy TEXT NOT NULL,
  home_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  authority_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  advertise_scope TEXT NOT NULL,
  owner_id TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS agent_endpoints (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  harness TEXT NOT NULL,
  transport TEXT NOT NULL,
  state TEXT NOT NULL,
  address TEXT,
  session_id TEXT,
  pane TEXT,
  cwd TEXT,
  project_root TEXT,
  metadata_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

${CONTROL_PLANE_RUNTIME_SESSION_SQLITE_SCHEMA}

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL,
  share_mode TEXT NOT NULL,
  authority_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  topic TEXT,
  parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT,
  PRIMARY KEY (conversation_id, actor_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  origin_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  class TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  thread_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  speech_json TEXT,
  audience_json TEXT,
  visibility TEXT NOT NULL,
  policy TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  label TEXT,
  PRIMARY KEY (message_id, actor_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, actor_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message
  ON message_reactions (message_id);

CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  file_name TEXT,
  blob_key TEXT,
  url TEXT,
  metadata_json TEXT,
  blob_ref_json TEXT,
  PRIMARY KEY (message_id, id)
);

CREATE TABLE IF NOT EXISTS conversation_read_cursors (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  reader_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  last_read_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  last_read_seq INTEGER,
  last_read_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (conversation_id, actor_id)
);

CREATE TABLE IF NOT EXISTS broker_journal_projection_checkpoints (
  projection_id TEXT PRIMARY KEY,
  projection_version INTEGER NOT NULL,
  barrier_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_projection_meta (
  singleton INTEGER PRIMARY KEY,
  projection_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  head_seq INTEGER NOT NULL,
  min_replayable_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT conversation_projection_meta_singleton_check CHECK (singleton = 1)
);

CREATE TABLE IF NOT EXISTS conversation_projection_items (
  feed_id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL,
  kind TEXT NOT NULL,
  conversation_id TEXT,
  runtime_session_id TEXT,
  source TEXT,
  source_session_id TEXT,
  title TEXT,
  alias TEXT,
  natural_key TEXT,
  project_root TEXT,
  harness TEXT,
  model TEXT,
  effort TEXT,
  agent_id TEXT,
  agent_name TEXT,
  current_branch TEXT,
  authority_node_id TEXT,
  authority_node_name TEXT,
  parent_conversation_id TEXT,
  anchor_message_id TEXT,
  activity_state TEXT NOT NULL,
  last_message_id TEXT,
  last_message_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  participant_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  last_engaged_at INTEGER,
  source_fresh_at INTEGER,
  visibility_state TEXT NOT NULL DEFAULT 'visible',
  updated_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT conversation_projection_items_entity_kind_check
    CHECK (entity_kind IN ('scout_conversation', 'observed_session')),
  CONSTRAINT conversation_projection_items_visibility_check
    CHECK (visibility_state IN ('visible', 'hidden'))
);

CREATE TABLE IF NOT EXISTS conversation_projection_message_facts (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_projection_message_stats (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  message_count INTEGER NOT NULL DEFAULT 0,
  latest_message_id TEXT,
  latest_message_at INTEGER
);

CREATE TABLE IF NOT EXISTS conversation_projection_sources (
  source TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  feed_id TEXT NOT NULL REFERENCES conversation_projection_items(feed_id) ON DELETE CASCADE,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (source, source_session_id)
);

CREATE TABLE IF NOT EXISTS conversation_projection_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  projection_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  requester_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  target_agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  target_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  task TEXT NOT NULL,
  collaboration_record_id TEXT REFERENCES collaboration_records(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  context_json TEXT,
  execution_json TEXT,
  ensure_awake INTEGER NOT NULL DEFAULT 1,
  stream INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER,
  labels_json TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  flight_id TEXT,
  state TEXT,
  summary TEXT,
  output TEXT,
  error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  flight_metadata_json TEXT,
  execution_resolution_json TEXT,
  origin_json TEXT,
  trace_json TEXT
);

CREATE TABLE IF NOT EXISTS flights (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  target_agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  summary TEXT,
  output TEXT,
  error TEXT,
  labels_json TEXT,
  metadata_json TEXT,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS bindings (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  mode TEXT NOT NULL,
  external_channel_id TEXT NOT NULL,
  external_thread_id TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  invocation_id TEXT REFERENCES invocations(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  target_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  target_kind TEXT NOT NULL,
  transport TEXT NOT NULL,
  reason TEXT NOT NULL,
  policy TEXT NOT NULL,
  status TEXT NOT NULL,
  binding_id TEXT REFERENCES bindings(id) ON DELETE SET NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  external_ref TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  authority_cell_id TEXT NOT NULL,
  state TEXT NOT NULL,
  idempotency_key TEXT,
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_attempts (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES durable_actions(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  metadata_json TEXT,
  UNIQUE (action_id, attempt)
);

CREATE TABLE IF NOT EXISTS durable_checkpoints (
  action_id TEXT NOT NULL REFERENCES durable_actions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload_json TEXT,
  owner_attempt_id TEXT REFERENCES durable_attempts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (action_id, name)
);

CREATE TABLE IF NOT EXISTS durable_signals (
  action_id TEXT NOT NULL REFERENCES durable_actions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload_json TEXT,
  emitted_at INTEGER NOT NULL,
  PRIMARY KEY (action_id, name)
);

CREATE TABLE IF NOT EXISTS collaboration_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  acceptance_state TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  created_by_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  owner_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  next_move_owner_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES collaboration_records(id) ON DELETE SET NULL,
  priority TEXT,
  labels_json TEXT,
  relations_json TEXT,
  detail_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collaboration_events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES collaboration_records(id) ON DELETE CASCADE,
  record_kind TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  summary TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_blocks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  memory_kind TEXT,
  state TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary TEXT,
  projection_mode TEXT NOT NULL,
  mutability TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  owner_id TEXT,
  source_refs_json TEXT NOT NULL,
  confidence REAL,
  token_budget INTEGER,
  freshness_json TEXT,
  version INTEGER NOT NULL,
  supersedes_id TEXT,
  content_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  target_json TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  context_block_ids_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  node_id TEXT,
  ts INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  authority_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  ts INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  notification_json TEXT,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS thread_cursors (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  authority_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  last_applied_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, authority_node_id)
);

CREATE TABLE IF NOT EXISTS scout_dispatches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  asked_label TEXT NOT NULL,
  detail TEXT NOT NULL,
  invocation_id TEXT,
  conversation_id TEXT,
  requester_id TEXT,
  dispatcher_node_id TEXT NOT NULL,
  dispatched_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  invocation_id TEXT REFERENCES invocations(id) ON DELETE CASCADE,
  flight_id TEXT REFERENCES flights(id) ON DELETE CASCADE,
  record_id TEXT REFERENCES collaboration_records(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  counterpart_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  workspace_root TEXT,
  session_id TEXT,
  title TEXT,
  summary TEXT,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS budget_usage_events (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  provider TEXT,
  harness TEXT,
  transport TEXT,
  model TEXT,
  agent_id TEXT,
  endpoint_id TEXT,
  session_id TEXT,
  project_root TEXT,
  conversation_id TEXT,
  message_id TEXT,
  invocation_id TEXT,
  flight_id TEXT,
  work_id TEXT,
  occurred_at INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  total_tokens INTEGER,
  estimated_usd REAL,
  billed_usd REAL,
  currency TEXT,
  dedup_key TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

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

CREATE TABLE IF NOT EXISTS mobile_push_registrations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_bundle_id TEXT NOT NULL,
  apns_environment TEXT NOT NULL,
  push_token TEXT NOT NULL,
  authorization_status TEXT NOT NULL,
  app_version TEXT,
  build_number TEXT,
  device_model TEXT,
  system_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Briefing Room: persistent archive of Scoutbot-generated briefs.
-- Each row carries three layers — snapshot (Layer 1), observations (Layer 2),
-- brief + call (Layer 3) — so an operator can audit not just what Scoutbot said
-- but what it read and how it asked. Rolling 100-cap is enforced in code.
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
  -- SCO-037: canonical markdown body. NULL for rows persisted before the
  -- markdown pipeline landed; rows persisted after step 3 of SCO-037 carry
  -- the full markdown document the analyst emitted.
  markdown TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- Assigned roles (orchestrator, later qa/sre). Explicit grant only; not identity.
CREATE TABLE IF NOT EXISTS role_assignments (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  mission_id TEXT,
  project_root TEXT,
  assigned_by_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  revoked_at INTEGER,
  revoked_by_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL
);

-- Mission log: cheap orchestrator situation stream (work-item mission id in v0).
CREATE TABLE IF NOT EXISTS mission_log_entries (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  node_id TEXT,
  at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  checkpoint TEXT,
  blockers_json TEXT,
  refs_json TEXT,
  note TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_mesh_id
  ON nodes (mesh_id);
CREATE INDEX IF NOT EXISTS idx_machines_last_seen_at
  ON machines (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_machines_scout_node_id
  ON machines (scout_node_id);
CREATE INDEX IF NOT EXISTS idx_trusted_peers_node_id
  ON trusted_peers (node_id);
CREATE INDEX IF NOT EXISTS idx_trusted_peers_label
  ON trusted_peers (label);
CREATE INDEX IF NOT EXISTS idx_peer_nonces_seen_at
  ON peer_nonces (seen_at);
CREATE INDEX IF NOT EXISTS idx_agent_endpoints_agent_updated_at
  ON agent_endpoints (agent_id, updated_at DESC);
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
CREATE INDEX IF NOT EXISTS idx_agents_home_node_id
  ON agents (home_node_id);
CREATE INDEX IF NOT EXISTS idx_agents_authority_node_id
  ON agents (authority_node_id);
CREATE INDEX IF NOT EXISTS idx_agent_endpoints_node_id
  ON agent_endpoints (node_id);
CREATE INDEX IF NOT EXISTS idx_conversation_members_actor
  ON conversation_members (actor_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_epoch_id
  ON messages (conversation_id, CASE WHEN created_at > 0 AND created_at < 1000000000000 THEN created_at * 1000 ELSE created_at END DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_epoch_id ON messages (CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_failure_epoch_id ON deliveries (CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC, id) WHERE status IN ('failed', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_dispatches_epoch_id ON scout_dispatches (CASE WHEN dispatched_at IS NULL THEN NULL WHEN CAST(dispatched_at AS REAL) < 1000000000000 THEN CAST(CAST(dispatched_at AS REAL) * 1000 AS INTEGER) ELSE CAST(dispatched_at AS INTEGER) END DESC, id);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_epoch_id ON delivery_attempts (CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC, id);
CREATE INDEX IF NOT EXISTS idx_activity_items_epoch ON activity_items (CASE WHEN ts IS NULL THEN NULL WHEN CAST(ts AS REAL) < 1000000000000 THEN CAST(CAST(ts AS REAL) * 1000 AS INTEGER) ELSE CAST(ts AS INTEGER) END DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_actor_created_at
  ON messages (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_origin_node_id
  ON messages (origin_node_id);
CREATE INDEX IF NOT EXISTS idx_read_cursors_conversation_updated_at
  ON conversation_read_cursors (conversation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_read_cursors_reader_node_id
  ON conversation_read_cursors (reader_node_id);
CREATE INDEX IF NOT EXISTS idx_conversation_projection_recent
  ON conversation_projection_items (visibility_state, last_activity_at DESC, feed_id);
CREATE INDEX IF NOT EXISTS idx_conversation_projection_project_recent
  ON conversation_projection_items (project_root, visibility_state, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_projection_message_facts_conversation
  ON conversation_projection_message_facts (conversation_id, created_at, message_id);
CREATE INDEX IF NOT EXISTS idx_conversation_projection_engaged
  ON conversation_projection_items (
    visibility_state,
    last_engaged_at DESC,
    last_activity_at DESC,
    feed_id
  );
CREATE INDEX IF NOT EXISTS idx_conversation_projection_source_fresh
  ON conversation_projection_items (visibility_state, source_fresh_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_projection_runtime_session
  ON conversation_projection_items (entity_kind, runtime_session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_projection_source_session
  ON conversation_projection_items (entity_kind, source_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_projection_conversation
  ON conversation_projection_items (conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_projection_sources_feed
  ON conversation_projection_sources (feed_id);
CREATE INDEX IF NOT EXISTS idx_conversation_projection_events_projection_seq
  ON conversation_projection_events (projection_id, seq);
CREATE INDEX IF NOT EXISTS idx_conversation_projection_events_ts
  ON conversation_projection_events (ts);
CREATE INDEX IF NOT EXISTS idx_invocations_target_created_at
  ON invocations (target_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invocations_requester_created_at
  ON invocations (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_conversation_created_at
  ON invocations (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_requester_node_id
  ON invocations (requester_node_id);
CREATE INDEX IF NOT EXISTS idx_invocations_target_node_id
  ON invocations (target_node_id);
CREATE INDEX IF NOT EXISTS idx_flights_target_state
  ON flights (target_agent_id, state);
CREATE INDEX IF NOT EXISTS idx_flights_invocation_id
  ON flights (invocation_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status_transport
  ON deliveries (status, transport);
CREATE INDEX IF NOT EXISTS idx_deliveries_created_at
  ON deliveries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_target_status_created_id
  ON deliveries (target_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_target_node_id
  ON deliveries (target_node_id);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_created_at
  ON delivery_attempts (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_actions_idempotency_key
  ON durable_actions (authority_cell_id, kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_durable_actions_authority_state_lease
  ON durable_actions (authority_cell_id, state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_durable_actions_subject
  ON durable_actions (kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_durable_actions_kind_due_at_updated_at
  ON durable_actions (
    kind,
    COALESCE(
      CAST(json_extract(metadata_json, '$.dueAt') AS REAL),
      CAST(json_extract(metadata_json, '$.due_at') AS REAL)
    ),
    updated_at
  );
CREATE INDEX IF NOT EXISTS idx_durable_attempts_action_attempt
  ON durable_attempts (action_id, attempt);
CREATE INDEX IF NOT EXISTS idx_collaboration_records_state
  ON collaboration_records (state);
CREATE INDEX IF NOT EXISTS idx_collaboration_records_updated_at
  ON collaboration_records (updated_at);
CREATE INDEX IF NOT EXISTS idx_collaboration_records_kind_state_updated_at
  ON collaboration_records (kind, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collaboration_records_parent_kind_state_updated_at
  ON collaboration_records (parent_id, kind, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collaboration_records_owner_kind_state_updated_at
  ON collaboration_records (owner_id, kind, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collaboration_records_next_move_owner_kind_state_updated_at
  ON collaboration_records (next_move_owner_id, kind, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collaboration_events_record_created_at
  ON collaboration_events (record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_blocks_scope_state_updated_at
  ON context_blocks (scope_kind, scope_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_blocks_kind_state_updated_at
  ON context_blocks (kind, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_packs_created_at
  ON context_packs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts
  ON events (kind, ts);
CREATE INDEX IF NOT EXISTS idx_thread_events_conversation_seq
  ON thread_events (conversation_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_thread_events_conversation_ts
  ON thread_events (conversation_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_thread_events_authority_node_id
  ON thread_events (authority_node_id);
CREATE INDEX IF NOT EXISTS idx_thread_cursors_authority_node_id
  ON thread_cursors (authority_node_id);
CREATE INDEX IF NOT EXISTS idx_activity_items_agent_ts
  ON activity_items (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_items_actor_ts
  ON activity_items (actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_items_conversation_ts
  ON activity_items (conversation_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_items_ts
  ON activity_items (ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_items_workspace_ts
  ON activity_items (workspace_root, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_items_kind_ts
  ON activity_items (kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_items_session_ts
  ON activity_items (session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_budget_usage_events_scope_occurred
  ON budget_usage_events (scope, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_usage_events_session_occurred
  ON budget_usage_events (session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_usage_events_invocation
  ON budget_usage_events (invocation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_usage_events_flight
  ON budget_usage_events (flight_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_usage_events_dedup
  ON budget_usage_events (scope, source, dedup_key)
  WHERE dedup_key IS NOT NULL AND dedup_key != '';
CREATE INDEX IF NOT EXISTS idx_budget_quota_windows_session_captured
  ON budget_quota_window_snapshots (session_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_quota_windows_provider_label
  ON budget_quota_window_snapshots (provider, label, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at
  ON conversations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scout_dispatches_dispatched_at
  ON scout_dispatches (dispatched_at DESC);
CREATE INDEX IF NOT EXISTS idx_scout_dispatches_conversation_ts
  ON scout_dispatches (conversation_id, dispatched_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_push_registrations_device_bundle_env
  ON mobile_push_registrations (device_id, platform, app_bundle_id, apns_environment);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_push_registrations_push_token
  ON mobile_push_registrations (push_token);
CREATE INDEX IF NOT EXISTS idx_mobile_push_registrations_device_updated_at
  ON mobile_push_registrations (device_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_briefings_created_at
  ON briefings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_briefings_kind_created_at
  ON briefings (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_role_assignments_agent_active
  ON role_assignments (agent_id, active);
CREATE INDEX IF NOT EXISTS idx_role_assignments_mission_role_active
  ON role_assignments (mission_id, role_id, active);
CREATE INDEX IF NOT EXISTS idx_role_assignments_role_active
  ON role_assignments (role_id, active);
-- Single-orchestrator-per-mission is enforced in assignRole() under
-- BEGIN IMMEDIATE (respects enforceSingleOrchestrator: false). A partial UNIQUE
-- index would break the documented allow-multiple override.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_log_entries_mission_seq
  ON mission_log_entries (mission_id, seq);
CREATE INDEX IF NOT EXISTS idx_mission_log_entries_mission_at
  ON mission_log_entries (mission_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_log_entries_actor_at
  ON mission_log_entries (actor_id, at DESC);
`;
