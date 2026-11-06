import type { DeliveryAttempt, DeliveryIntent } from "@openscout/protocol";

import { desc, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Declarative mirror of the canonical control-plane SQL schema
// (`CONTROL_PLANE_SQLITE_SCHEMA` in `schema.ts`). Phase 0 of the Drizzle
// schema/migration adoption: every control-plane table, constraint and index
// is modeled here, and `drizzle-schema-parity.test.ts` proves the DDL
// generated from this module is structurally identical to the raw string.
//
// The raw SQL string remains the runtime authority until Phase 1 seeds the
// baseline migration — do NOT wire this into the boot migrator yet.
const epochMsNow = sql`(CAST(strftime('%s','now') AS INTEGER) * 1000)`;

// -- nodes -------------------------------------------------------------------
export const nodesTable = sqliteTable("nodes", {
  id: text("id").primaryKey(),
  meshId: text("mesh_id").notNull(),
  name: text("name").notNull(),
  hostName: text("host_name"),
  advertiseScope: text("advertise_scope").notNull(),
  brokerUrl: text("broker_url"),
  tailnetName: text("tailnet_name"),
  capabilitiesJson: text("capabilities_json"),
  labelsJson: text("labels_json"),
  metadataJson: text("metadata_json"),
  lastSeenAt: integer("last_seen_at"),
  registeredAt: integer("registered_at").notNull(),
}, (table) => [
  index("idx_nodes_mesh_id").on(table.meshId),
]);

// -- machines ----------------------------------------------------------------
// One row per physical machine, assembled from evidence rather than declared.
// A machine is NOT a node: most rows here are tailnet peers or LAN neighbours
// that never run Scout, and a node row exists only for the ones that do. No
// foreign key to `nodes` for that reason — the join is by identity key, and a
// node being forgotten must not delete the machine it ran on.
export const machinesTable = sqliteTable("machines", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  // Sorted durable identity keys, JSON array. This is the join key set the
  // next inventory pass seeds its grouping with, so a machine seen by one
  // channel today and another tomorrow stays one record.
  identityKeysJson: text("identity_keys_json").notNull(),
  isSelf: integer("is_self").notNull().default(0),
  scoutNodeId: text("scout_node_id"),
  meshId: text("mesh_id"),
  tailnetId: text("tailnet_id"),
  tailnetName: text("tailnet_name"),
  hostNamesJson: text("host_names_json"),
  addressesJson: text("addresses_json"),
  macAddressesJson: text("mac_addresses_json"),
  capabilitiesJson: text("capabilities_json"),
  routesJson: text("routes_json"),
  evidenceJson: text("evidence_json"),
  pinned: integer("pinned").notNull().default(0),
  notes: text("notes"),
  metadataJson: text("metadata_json"),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
}, (table) => [
  index("idx_machines_last_seen_at").on(desc(table.lastSeenAt)),
  index("idx_machines_scout_node_id").on(table.scoutNodeId),
]);

// -- trusted_peers -----------------------------------------------------------
export const trustedPeersTable = sqliteTable("trusted_peers", {
  keyId: text("key_id").primaryKey(),
  publicKey: text("public_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  nodeId: text("node_id"),
  label: text("label").notNull(),
  tier: text("tier").notNull(),
  grantedVia: text("granted_via").notNull(),
  grantedAt: integer("granted_at").notNull(),
  expiresAt: integer("expires_at"),
  revokedAt: integer("revoked_at"),
  lastSeenAt: integer("last_seen_at"),
  metadataJson: text("metadata_json"),
  // §11.2: SHA-256 hex of the peer TLS certificate's SubjectPublicKeyInfo DER.
  // Nullable — Tailscale-path peers and pre-P1.5 enrollments have no pin.
  tlsSpkiFingerprint: text("tls_spki_fingerprint"),
}, (table) => [
  check("trusted_peers_tier_check", sql`${table.tier} IN ('observe', 'control')`),
  index("idx_trusted_peers_node_id").on(table.nodeId),
  index("idx_trusted_peers_label").on(table.label),
]);

// -- peer_nonces -------------------------------------------------------------
export const peerNoncesTable = sqliteTable("peer_nonces", {
  peerKeyId: text("peer_key_id").notNull(),
  nonce: text("nonce").notNull(),
  seenAt: integer("seen_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.peerKeyId, table.nonce] }),
  index("idx_peer_nonces_seen_at").on(table.seenAt),
]);

// -- actors ------------------------------------------------------------------
export const actorsTable = sqliteTable("actors", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  displayName: text("display_name").notNull(),
  handle: text("handle"),
  labelsJson: text("labels_json"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochMsNow),
});

// -- agents ------------------------------------------------------------------
export const agentsTable = sqliteTable("agents", {
  id: text("id").primaryKey().references(() => actorsTable.id, { onDelete: "cascade" }),
  definitionId: text("definition_id").notNull(),
  nodeQualifier: text("node_qualifier"),
  workspaceQualifier: text("workspace_qualifier"),
  selector: text("selector"),
  defaultSelector: text("default_selector"),
  agentClass: text("agent_class").notNull(),
  capabilitiesJson: text("capabilities_json").notNull(),
  wakePolicy: text("wake_policy").notNull(),
  homeNodeId: text("home_node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  authorityNodeId: text("authority_node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  advertiseScope: text("advertise_scope").notNull(),
  ownerId: text("owner_id"),
  metadataJson: text("metadata_json"),
}, (table) => [
  index("idx_agents_home_node_id").on(table.homeNodeId),
  index("idx_agents_authority_node_id").on(table.authorityNodeId),
]);

// -- agent_endpoints ---------------------------------------------------------
export const agentEndpointsTable = sqliteTable("agent_endpoints", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => actorsTable.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  harness: text("harness").notNull(),
  transport: text("transport").notNull(),
  state: text("state").notNull(),
  address: text("address"),
  sessionId: text("session_id"),
  pane: text("pane"),
  cwd: text("cwd"),
  projectRoot: text("project_root"),
  metadataJson: text("metadata_json"),
  updatedAt: integer("updated_at").notNull().default(epochMsNow),
}, (table) => [
  index("idx_agent_endpoints_agent_updated_at").on(table.agentId, desc(table.updatedAt)),
  index("idx_agent_endpoints_roster_recency").on(
    desc(sql`CASE
      WHEN ${table.updatedAt} IS NULL THEN NULL
      WHEN CAST(${table.updatedAt} AS REAL) < 1000000000000
        THEN CAST(CAST(${table.updatedAt} AS REAL) * 1000 AS INTEGER)
      ELSE CAST(${table.updatedAt} AS INTEGER)
    END`),
    table.agentId,
  ),
  index("idx_agent_endpoints_node_id").on(table.nodeId),
]);

// -- runtime_sessions --------------------------------------------------------
export const runtimeSessionsTable = sqliteTable("runtime_sessions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => actorsTable.id, { onDelete: "cascade" }),
  endpointId: text("endpoint_id").notNull().references(() => agentEndpointsTable.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  harness: text("harness").notNull(),
  transport: text("transport").notNull(),
  state: text("state").notNull(),
  primaryAlias: text("primary_alias").notNull(),
  externalSessionId: text("external_session_id"),
  cwd: text("cwd"),
  projectRoot: text("project_root"),
  startedAt: integer("started_at"),
  lastSeenAt: integer("last_seen_at").notNull(),
  endedAt: integer("ended_at"),
  expiresAt: integer("expires_at"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochMsNow),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_runtime_sessions_agent_last_seen").on(table.agentId, desc(table.lastSeenAt)),
  index("idx_runtime_sessions_endpoint_last_seen").on(table.endpointId, desc(table.lastSeenAt)),
  index("idx_runtime_sessions_node_id").on(table.nodeId),
  index("idx_runtime_sessions_external").on(table.externalSessionId),
  index("idx_runtime_sessions_expires").on(table.expiresAt).where(sql`expires_at IS NOT NULL`),
]);

// -- runtime_session_aliases -------------------------------------------------
export const runtimeSessionAliasesTable = sqliteTable("runtime_session_aliases", {
  alias: text("alias").notNull(),
  sessionId: text("session_id").notNull().references(() => runtimeSessionsTable.id, { onDelete: "cascade" }),
  aliasKind: text("alias_kind").notNull(),
  agentId: text("agent_id").notNull().references(() => actorsTable.id, { onDelete: "cascade" }),
  endpointId: text("endpoint_id").notNull().references(() => agentEndpointsTable.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  harness: text("harness").notNull(),
  transport: text("transport").notNull(),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  expiresAt: integer("expires_at"),
}, (table) => [
  primaryKey({ columns: [table.alias, table.sessionId] }),
  index("idx_runtime_session_aliases_alias").on(table.alias, desc(table.lastSeenAt)),
  index("idx_runtime_session_aliases_session").on(table.sessionId),
  index("idx_runtime_session_aliases_endpoint").on(table.endpointId),
  index("idx_runtime_session_aliases_node_id").on(table.nodeId),
  index("idx_runtime_session_aliases_expires").on(table.expiresAt).where(sql`expires_at IS NOT NULL`),
]);

// -- route_alias_bindings ---------------------------------------------------
// User-managed route pointers. Deliberately distinct from the observed
// runtime_session_aliases lookup index above.
export const routeAliasBindingsTable = sqliteTable("route_alias_bindings", {
  id: text("id").primaryKey(),
  normalizedAlias: text("normalized_alias").notNull(),
  displayAlias: text("display_alias"),
  ownerRealmId: text("owner_realm_id").notNull(),
  scopeProjectKey: text("scope_project_key").notNull(),
  scopeProjectRoot: text("scope_project_root"),
  scopeNodeId: text("scope_node_id").notNull(),
  targetKind: text("target_kind").notNull(),
  targetAgentId: text("target_agent_id"),
  targetSessionId: text("target_session_id"),
  targetEndpointId: text("target_endpoint_id"),
  targetNodeId: text("target_node_id").notNull(),
  targetHarness: text("target_harness"),
  targetSnapshotJson: text("target_snapshot_json").notNull(),
  state: text("state").notNull(),
  revision: integer("revision").notNull(),
  createdByActorId: text("created_by_actor_id").notNull(),
  updatedByActorId: text("updated_by_actor_id").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at"),
  revokedAt: integer("revoked_at"),
  metadataJson: text("metadata_json"),
}, (table) => [
  check("route_alias_bindings_target_kind_check", sql`${table.targetKind} IN ('agent', 'session')`),
  check("route_alias_bindings_state_check", sql`${table.state} IN ('active', 'unset', 'expired')`),
  check("route_alias_bindings_revision_check", sql`${table.revision} >= 1`),
  check("route_alias_bindings_target_shape_check", sql`(
    (${table.targetKind} = 'agent' AND ${table.targetAgentId} IS NOT NULL AND ${table.targetSessionId} IS NULL AND ${table.targetEndpointId} IS NULL AND ${table.targetHarness} IS NULL)
    OR
    (${table.targetKind} = 'session' AND ${table.targetAgentId} IS NOT NULL AND ${table.targetSessionId} IS NOT NULL AND ${table.targetEndpointId} IS NOT NULL AND ${table.targetHarness} IS NOT NULL)
  )`),
  uniqueIndex("idx_route_alias_bindings_active_scope")
    .on(table.ownerRealmId, table.scopeProjectKey, table.scopeNodeId, table.normalizedAlias)
    .where(sql`state = 'active'`),
  index("idx_route_alias_bindings_target_agent").on(table.targetAgentId),
  index("idx_route_alias_bindings_target_session").on(table.targetSessionId),
  index("idx_route_alias_bindings_scope_updated").on(
    table.ownerRealmId,
    table.scopeProjectKey,
    table.scopeNodeId,
    desc(table.updatedAt),
  ),
  index("idx_route_alias_bindings_expires").on(table.expiresAt).where(sql`expires_at IS NOT NULL`),
]);

// -- route_alias_revisions --------------------------------------------------
export const routeAliasRevisionsTable = sqliteTable("route_alias_revisions", {
  id: text("id").primaryKey(),
  bindingId: text("binding_id").notNull(),
  revision: integer("revision").notNull(),
  operation: text("operation").notNull(),
  oldTargetJson: text("old_target_json"),
  newTargetJson: text("new_target_json"),
  oldTargetSnapshotJson: text("old_target_snapshot_json"),
  newTargetSnapshotJson: text("new_target_snapshot_json"),
  actorId: text("actor_id").notNull(),
  authorityNodeId: text("authority_node_id").notNull(),
  createdAt: integer("created_at").notNull(),
  reason: text("reason"),
  requestId: text("request_id"),
}, (table) => [
  uniqueIndex("idx_route_alias_revisions_binding_revision").on(table.bindingId, table.revision),
  index("idx_route_alias_revisions_binding_created").on(table.bindingId, desc(table.createdAt)),
]);

// -- conversations -----------------------------------------------------------
export const conversationsTable = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  visibility: text("visibility").notNull(),
  shareMode: text("share_mode").notNull(),
  authorityNodeId: text("authority_node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  topic: text("topic"),
  parentConversationId: text("parent_conversation_id").references((): AnySQLiteColumn => conversationsTable.id, { onDelete: "set null" }),
  messageId: text("message_id"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochMsNow),
}, (table) => [
  index("idx_conversations_created_at").on(desc(table.createdAt)),
  // idx_conversations_authority_node_id lives only in the imperative
  // migration array. The raw schema exec cannot conditionally create an
  // index, so declaring it here would generate unsafe DDL for legacy pilot
  // databases whose conversations table predates authority_node_id.
]);

// -- conversation_members ----------------------------------------------------
export const conversationMembersTable = sqliteTable("conversation_members", {
  conversationId: text("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => actorsTable.id, { onDelete: "cascade" }),
  role: text("role"),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.actorId] }),
  index("idx_conversation_members_actor").on(table.actorId, table.conversationId),
]);

// -- messages ----------------------------------------------------------------
export const messagesTable = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => actorsTable.id, { onDelete: "restrict" }),
  originNodeId: text("origin_node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  class: text("class").notNull(),
  body: text("body").notNull(),
  replyToMessageId: text("reply_to_message_id").references((): AnySQLiteColumn => messagesTable.id, { onDelete: "set null" }),
  threadConversationId: text("thread_conversation_id").references(() => conversationsTable.id, { onDelete: "set null" }),
  speechJson: text("speech_json"),
  audienceJson: text("audience_json"),
  visibility: text("visibility").notNull(),
  policy: text("policy").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_messages_conversation_created_at").on(table.conversationId, table.createdAt),
  // Match the native thread ordering, including historical seconds timestamps.
  index("idx_messages_conversation_epoch_id").on(
    table.conversationId,
    sql`CASE WHEN created_at > 0 AND created_at < 1000000000000 THEN created_at * 1000 ELSE created_at END DESC`,
    desc(table.id),
  ),
  index("idx_messages_epoch_id").on(sql`CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC`, table.id),
  index("idx_messages_created_at").on(desc(table.createdAt)),
  index("idx_messages_actor_created_at").on(table.actorId, desc(table.createdAt)),
  index("idx_messages_origin_node_id").on(table.originNodeId),
]);

// -- message_mentions --------------------------------------------------------
export const messageMentionsTable = sqliteTable("message_mentions", {
  messageId: text("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => actorsTable.id, { onDelete: "cascade" }),
  label: text("label"),
}, (table) => [
  primaryKey({ columns: [table.messageId, table.actorId] }),
]);

// -- message_reactions -------------------------------------------------------
export const messageReactionsTable = sqliteTable("message_reactions", {
  messageId: text("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => actorsTable.id, { onDelete: "restrict" }),
  emoji: text("emoji").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.messageId, table.actorId, table.emoji] }),
  index("idx_message_reactions_message").on(table.messageId),
]);

// -- message_attachments -----------------------------------------------------
export const messageAttachmentsTable = sqliteTable("message_attachments", {
  id: text("id").notNull(),
  messageId: text("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }),
  mediaType: text("media_type").notNull(),
  fileName: text("file_name"),
  blobKey: text("blob_key"),
  url: text("url"),
  metadataJson: text("metadata_json"),
  blobRefJson: text("blob_ref_json"),
}, (table) => [primaryKey({ columns: [table.messageId, table.id] })]);

// -- conversation_read_cursors -----------------------------------------------
export const conversationReadCursorsTable = sqliteTable("conversation_read_cursors", {
  conversationId: text("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => actorsTable.id, { onDelete: "cascade" }),
  readerNodeId: text("reader_node_id").references(() => nodesTable.id, { onDelete: "set null" }),
  lastReadMessageId: text("last_read_message_id").references(() => messagesTable.id, { onDelete: "set null" }),
  lastReadSeq: integer("last_read_seq"),
  lastReadAt: integer("last_read_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  metadataJson: text("metadata_json"),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.actorId] }),
  index("idx_read_cursors_conversation_updated_at").on(table.conversationId, desc(table.updatedAt)),
  index("idx_read_cursors_reader_node_id").on(table.readerNodeId),
]);

// Full payloads at these locations are canonical after hot payload relocation.
export const brokerHistoryAnchorsTable = sqliteTable("broker_history_anchors", {
  kind: text("kind").notNull(),
  id: text("id").notNull(),
  locationJson: text("location_json").notNull(),
}, table => [primaryKey({ columns: [table.kind, table.id] })]);

// -- broker_journal_projection_checkpoints ---------------------------------
// Opaque journal barrier retained after a complete SQLite projection replay.
// It is recovery metadata, not broker domain state.
export const brokerJournalProjectionCheckpointsTable = sqliteTable("broker_journal_projection_checkpoints", {
  projectionId: text("projection_id").primaryKey(),
  projectionVersion: integer("projection_version").notNull(),
  barrierId: text("barrier_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// -- conversation_projection_* ---------------------------------------------
// Shared V6/SCO-102 conversation list projection. These tables are a
// rebuildable read model; canonical conversations/messages remain above.
export const conversationProjectionMetaTable = sqliteTable("conversation_projection_meta", {
  singleton: integer("singleton").primaryKey(),
  projectionId: text("projection_id").notNull(),
  projectionVersion: integer("projection_version").notNull(),
  headSeq: integer("head_seq").notNull(),
  minReplayableSeq: integer("min_replayable_seq").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  check("conversation_projection_meta_singleton_check", sql`${table.singleton} = 1`),
]);

export const conversationProjectionItemsTable = sqliteTable("conversation_projection_items", {
  feedId: text("feed_id").primaryKey(),
  entityKind: text("entity_kind").notNull(),
  kind: text("kind").notNull(),
  conversationId: text("conversation_id"),
  runtimeSessionId: text("runtime_session_id"),
  source: text("source"),
  sourceSessionId: text("source_session_id"),
  title: text("title"),
  alias: text("alias"),
  naturalKey: text("natural_key"),
  projectRoot: text("project_root"),
  harness: text("harness"),
  model: text("model"),
  effort: text("effort"),
  agentId: text("agent_id"),
  agentName: text("agent_name"),
  currentBranch: text("current_branch"),
  authorityNodeId: text("authority_node_id"),
  authorityNodeName: text("authority_node_name"),
  parentConversationId: text("parent_conversation_id"),
  anchorMessageId: text("anchor_message_id"),
  activityState: text("activity_state").notNull(),
  lastMessageId: text("last_message_id"),
  lastMessageAt: integer("last_message_at"),
  lastActivityAt: integer("last_activity_at").notNull(),
  messageCount: integer("message_count").notNull().default(0),
  unreadCount: integer("unread_count").notNull().default(0),
  participantCount: integer("participant_count").notNull().default(0),
  preview: text("preview"),
  lastEngagedAt: integer("last_engaged_at"),
  sourceFreshAt: integer("source_fresh_at"),
  visibilityState: text("visibility_state").notNull().default("visible"),
  updatedSeq: integer("updated_seq").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  check(
    "conversation_projection_items_entity_kind_check",
    sql`${table.entityKind} IN ('scout_conversation', 'observed_session')`,
  ),
  check(
    "conversation_projection_items_visibility_check",
    sql`${table.visibilityState} IN ('visible', 'hidden')`,
  ),
  index("idx_conversation_projection_recent").on(
    table.visibilityState,
    desc(table.lastActivityAt),
    table.feedId,
  ),
  index("idx_conversation_projection_project_recent").on(
    table.projectRoot,
    table.visibilityState,
    desc(table.lastActivityAt),
  ),
  index("idx_conversation_projection_engaged").on(
    table.visibilityState,
    desc(table.lastEngagedAt),
    desc(table.lastActivityAt),
    table.feedId,
  ),
  index("idx_conversation_projection_source_fresh").on(
    table.visibilityState,
    desc(table.sourceFreshAt),
  ),
  index("idx_conversation_projection_runtime_session").on(
    table.entityKind,
    table.runtimeSessionId,
  ),
  index("idx_conversation_projection_source_session").on(
    table.entityKind,
    table.sourceSessionId,
  ),
  uniqueIndex("idx_conversation_projection_conversation")
    .on(table.conversationId)
    .where(sql`conversation_id IS NOT NULL`),
]);

// Incremental message aggregates backing the summary rows. Facts make journal
// re-delivery idempotent; stats keep the hot message path O(batch) instead of
// recounting an arbitrarily long transcript after every append.
export const conversationProjectionMessageFactsTable = sqliteTable("conversation_projection_message_facts", {
  messageId: text("message_id").primaryKey().references(() => messagesTable.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_conversation_projection_message_facts_conversation").on(
    table.conversationId,
    table.createdAt,
    table.messageId,
  ),
]);

export const conversationProjectionMessageStatsTable = sqliteTable("conversation_projection_message_stats", {
  conversationId: text("conversation_id").primaryKey().references(() => conversationsTable.id, { onDelete: "cascade" }),
  messageCount: integer("message_count").notNull().default(0),
  latestMessageId: text("latest_message_id"),
  latestMessageAt: integer("latest_message_at"),
});

export const conversationProjectionSourcesTable = sqliteTable("conversation_projection_sources", {
  source: text("source").notNull(),
  sourceSessionId: text("source_session_id").notNull(),
  feedId: text("feed_id").notNull().references(() => conversationProjectionItemsTable.feedId, { onDelete: "cascade" }),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.source, table.sourceSessionId] }),
  index("idx_conversation_projection_sources_feed").on(table.feedId),
]);

export const conversationProjectionEventsTable = sqliteTable("conversation_projection_events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  projectionId: text("projection_id").notNull(),
  ts: integer("ts").notNull(),
  payloadJson: text("payload_json").notNull(),
}, (table) => [
  index("idx_conversation_projection_events_projection_seq").on(table.projectionId, table.seq),
  index("idx_conversation_projection_events_ts").on(table.ts),
]);

// -- invocations -------------------------------------------------------------
export const invocationsTable = sqliteTable("invocations", {
  id: text("id").primaryKey(),
  requesterId: text("requester_id").notNull().references(() => actorsTable.id, { onDelete: "restrict" }),
  requesterNodeId: text("requester_node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  targetAgentId: text("target_agent_id").notNull().references(() => actorsTable.id, { onDelete: "restrict" }),
  targetNodeId: text("target_node_id").references(() => nodesTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  task: text("task").notNull(),
  collaborationRecordId: text("collaboration_record_id").references(() => collaborationRecordsTable.id, { onDelete: "set null" }),
  conversationId: text("conversation_id").references(() => conversationsTable.id, { onDelete: "set null" }),
  messageId: text("message_id").references(() => messagesTable.id, { onDelete: "set null" }),
  contextJson: text("context_json"),
  executionJson: text("execution_json"),
  ensureAwake: integer("ensure_awake").notNull().default(1),
  stream: integer("stream").notNull().default(1),
  timeoutMs: integer("timeout_ms"),
  labelsJson: text("labels_json"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
  // Flight status columns (flight→invocation storage merge, expand/dual-write
  // phase): mirror the latest flight so invocations can serve reads alone.
  // flight_metadata_json stays separate from metadata_json: request metadata
  // and execution-status metadata are distinct facts, and recordInvocation
  // replays rebuild metadata_json from the request (which would wipe merged
  // status keys).
  flightId: text("flight_id"),
  state: text("state"),
  summary: text("summary"),
  output: text("output"),
  error: text("error"),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
  flightMetadataJson: text("flight_metadata_json"),
  executionResolutionJson: text("execution_resolution_json"),
  originJson: text("origin_json"),
  traceJson: text("trace_json"),
}, (table) => [
  index("idx_invocations_state").on(table.state),
  index("idx_invocations_requester_recency").on(table.requesterId, sql`COALESCE(completed_at, started_at, created_at) DESC`),
  index("idx_invocations_target_created_at").on(table.targetAgentId, table.createdAt),
  index("idx_invocations_requester_created_at").on(table.requesterId, desc(table.createdAt)),
  index("idx_invocations_conversation_created_at").on(table.conversationId, desc(table.createdAt)),
  index("idx_invocations_requester_node_id").on(table.requesterNodeId),
  index("idx_invocations_target_node_id").on(table.targetNodeId),
  // idx_invocations_flight_id lives only in the imperative migration array
  // (like idx_invocations_collaboration_record_id_created_at): the raw schema
  // exec runs before the imperative column-adds, so an index here would crash
  // legacy databases whose invocations table predates the flight_id column.
]);

// -- flights -----------------------------------------------------------------
export const flightsTable = sqliteTable("flights", {
  id: text("id").primaryKey(),
  invocationId: text("invocation_id").notNull().references(() => invocationsTable.id, { onDelete: "cascade" }),
  requesterId: text("requester_id").notNull().references(() => actorsTable.id, { onDelete: "restrict" }),
  targetAgentId: text("target_agent_id").notNull().references(() => actorsTable.id, { onDelete: "restrict" }),
  state: text("state").notNull(),
  summary: text("summary"),
  output: text("output"),
  error: text("error"),
  labelsJson: text("labels_json"),
  metadataJson: text("metadata_json"),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
}, (table) => [
  index("idx_flights_target_state").on(table.targetAgentId, table.state),
  index("idx_flights_invocation_id").on(table.invocationId),
]);

// -- bindings ----------------------------------------------------------------
export const bindingsTable = sqliteTable("bindings", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  mode: text("mode").notNull(),
  externalChannelId: text("external_channel_id").notNull(),
  externalThreadId: text("external_thread_id"),
  metadataJson: text("metadata_json"),
});

// -- deliveries --------------------------------------------------------------
// Typed handle for the delivery query layer (sqlite-store.ts). $type<> keeps
// the domain unions on the raw-SQL read path.
export const deliveriesTable = sqliteTable("deliveries", {
  id: text("id").primaryKey(),
  messageId: text("message_id").references(() => messagesTable.id, { onDelete: "cascade" }),
  invocationId: text("invocation_id").references(() => invocationsTable.id, { onDelete: "cascade" }),
  targetId: text("target_id").notNull(),
  targetNodeId: text("target_node_id").references(() => nodesTable.id, { onDelete: "set null" }),
  targetKind: text("target_kind").$type<DeliveryIntent["targetKind"]>().notNull(),
  transport: text("transport").$type<DeliveryIntent["transport"]>().notNull(),
  reason: text("reason").$type<DeliveryIntent["reason"]>().notNull(),
  policy: text("policy").$type<DeliveryIntent["policy"]>().notNull(),
  status: text("status").$type<DeliveryIntent["status"]>().notNull(),
  bindingId: text("binding_id").references(() => bindingsTable.id, { onDelete: "set null" }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochMsNow),
}, (table) => [
  index("idx_deliveries_status_transport").on(table.status, table.transport),
  index("idx_deliveries_failure_epoch_id").on(sql`CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC`, table.id).where(sql`status IN ('failed', 'cancelled')`),
  index("idx_deliveries_created_at").on(desc(table.createdAt)),
  index("idx_deliveries_target_status_created_id").on(table.targetId, table.status, table.createdAt, table.id),
  index("idx_deliveries_target_node_id").on(table.targetNodeId),
]);

// -- delivery_attempts -------------------------------------------------------
export const deliveryAttemptsTable = sqliteTable("delivery_attempts", {
  id: text("id").primaryKey(),
  deliveryId: text("delivery_id").notNull().references(() => deliveriesTable.id, { onDelete: "cascade" }),
  attempt: integer("attempt").notNull(),
  status: text("status").$type<DeliveryAttempt["status"]>().notNull(),
  error: text("error"),
  externalRef: text("external_ref"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_delivery_attempts_epoch_id").on(sql`CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC`, table.id),
  index("idx_delivery_attempts_created_at").on(desc(table.createdAt)),
]);

// -- durable_actions ---------------------------------------------------------
// NOTE: `idx_durable_actions_kind_due_at_updated_at` is an expression index
// whose COALESCE/json_extract body contains commas. drizzle-kit 0.31.10's
// migration renderer splits an `sql` index expression on every comma, so it
// cannot emit this index. It is declared below via the `sql` escape hatch for
// documentation, and `DURABLE_ACTIONS_DUE_AT_INDEX_SQL` carries the exact DDL
// the parity test applies in its place. See deliverable (c) / the parity test.
export const durableActionsTable = sqliteTable("durable_actions", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  subjectId: text("subject_id").notNull(),
  authorityCellId: text("authority_cell_id").notNull(),
  state: text("state").notNull(),
  idempotencyKey: text("idempotency_key"),
  leaseOwner: text("lease_owner"),
  leaseGeneration: integer("lease_generation").notNull().default(0),
  leaseExpiresAt: integer("lease_expires_at"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_durable_actions_idempotency_key")
    .on(table.authorityCellId, table.kind, table.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
  index("idx_durable_actions_authority_state_lease").on(table.authorityCellId, table.state, table.leaseExpiresAt),
  index("idx_durable_actions_subject").on(table.kind, table.subjectId),
  // Escape hatch (see note above): drizzle-kit cannot render this. Kept in the
  // declarative model; substituted by DURABLE_ACTIONS_DUE_AT_INDEX_SQL.
  index("idx_durable_actions_kind_due_at_updated_at").on(
    table.kind,
    sql`COALESCE(CAST(json_extract(metadata_json, '$.dueAt') AS REAL), CAST(json_extract(metadata_json, '$.due_at') AS REAL))`,
    table.updatedAt,
  ),
]);

// Exact DDL for the expression index drizzle-kit cannot serialize. Matches the
// raw statement in schema.ts; the parity test asserts it stays in lockstep.
export const DURABLE_ACTIONS_DUE_AT_INDEX_SQL =
  `CREATE INDEX idx_durable_actions_kind_due_at_updated_at
  ON durable_actions (
    kind,
    COALESCE(
      CAST(json_extract(metadata_json, '$.dueAt') AS REAL),
      CAST(json_extract(metadata_json, '$.due_at') AS REAL)
    ),
    updated_at
  )`;

// -- durable_attempts --------------------------------------------------------
export const durableAttemptsTable = sqliteTable("durable_attempts", {
  id: text("id").primaryKey(),
  actionId: text("action_id").notNull().references(() => durableActionsTable.id, { onDelete: "cascade" }),
  attempt: integer("attempt").notNull(),
  state: text("state").notNull(),
  leaseGeneration: integer("lease_generation").notNull(),
  error: text("error"),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
  metadataJson: text("metadata_json"),
}, (table) => [
  unique().on(table.actionId, table.attempt),
  index("idx_durable_attempts_action_attempt").on(table.actionId, table.attempt),
]);

// -- durable_checkpoints -----------------------------------------------------
export const durableCheckpointsTable = sqliteTable("durable_checkpoints", {
  actionId: text("action_id").notNull().references(() => durableActionsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  payloadJson: text("payload_json"),
  ownerAttemptId: text("owner_attempt_id").references(() => durableAttemptsTable.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.actionId, table.name] }),
]);

// -- durable_signals ---------------------------------------------------------
export const durableSignalsTable = sqliteTable("durable_signals", {
  actionId: text("action_id").notNull().references(() => durableActionsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  payloadJson: text("payload_json"),
  emittedAt: integer("emitted_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.actionId, table.name] }),
]);

// -- collaboration_records ---------------------------------------------------
export const collaborationRecordsTable = sqliteTable("collaboration_records", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  state: text("state").notNull(),
  acceptanceState: text("acceptance_state").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  createdById: text("created_by_id").notNull().references(() => actorsTable.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").references(() => actorsTable.id, { onDelete: "set null" }),
  nextMoveOwnerId: text("next_move_owner_id").references(() => actorsTable.id, { onDelete: "set null" }),
  conversationId: text("conversation_id").references(() => conversationsTable.id, { onDelete: "set null" }),
  parentId: text("parent_id").references((): AnySQLiteColumn => collaborationRecordsTable.id, { onDelete: "set null" }),
  priority: text("priority"),
  labelsJson: text("labels_json"),
  relationsJson: text("relations_json"),
  detailJson: text("detail_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_collaboration_records_state").on(table.state),
  index("idx_collaboration_records_updated_at").on(table.updatedAt),
  index("idx_collaboration_records_kind_state_updated_at").on(table.kind, table.state, desc(table.updatedAt)),
  index("idx_collaboration_records_parent_kind_state_updated_at").on(table.parentId, table.kind, table.state, desc(table.updatedAt)),
  index("idx_collaboration_records_owner_kind_state_updated_at").on(table.ownerId, table.kind, table.state, desc(table.updatedAt)),
  index("idx_collaboration_records_next_move_owner_kind_state_updated_at").on(table.nextMoveOwnerId, table.kind, table.state, desc(table.updatedAt)),
]);

// -- collaboration_events ----------------------------------------------------
export const collaborationEventsTable = sqliteTable("collaboration_events", {
  id: text("id").primaryKey(),
  recordId: text("record_id").notNull().references(() => collaborationRecordsTable.id, { onDelete: "cascade" }),
  recordKind: text("record_kind").notNull(),
  kind: text("kind").notNull(),
  actorId: text("actor_id").notNull().references(() => actorsTable.id, { onDelete: "restrict" }),
  summary: text("summary"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_collaboration_events_record_created_at").on(table.recordId, table.createdAt),
]);

// -- context_blocks ---------------------------------------------------------
// Constructive prompt-facing state. Source material is cited through
// source_refs_json; provider transcripts are never copied into messages.
export const contextBlocksTable = sqliteTable("context_blocks", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  memoryKind: text("memory_kind"),
  state: text("state").notNull(),
  scopeKind: text("scope_kind").notNull(),
  scopeId: text("scope_id"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  summary: text("summary"),
  projectionMode: text("projection_mode").notNull(),
  mutability: text("mutability").notNull(),
  createdById: text("created_by_id").notNull(),
  ownerId: text("owner_id"),
  sourceRefsJson: text("source_refs_json").notNull(),
  confidence: real("confidence"),
  tokenBudget: integer("token_budget"),
  freshnessJson: text("freshness_json"),
  version: integer("version").notNull(),
  supersedesId: text("supersedes_id"),
  contentHash: text("content_hash").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_context_blocks_scope_state_updated_at").on(
    table.scopeKind,
    table.scopeId,
    table.state,
    desc(table.updatedAt),
  ),
  index("idx_context_blocks_kind_state_updated_at").on(
    table.kind,
    table.state,
    desc(table.updatedAt),
  ),
]);

// -- context_packs ----------------------------------------------------------
// Immutable, bounded assemblies used to seed a new or forked work session.
export const contextPacksTable = sqliteTable("context_packs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  purpose: text("purpose").notNull(),
  targetJson: text("target_json").notNull(),
  sectionsJson: text("sections_json").notNull(),
  contextBlockIdsJson: text("context_block_ids_json").notNull(),
  sourceRefsJson: text("source_refs_json").notNull(),
  budgetJson: text("budget_json").notNull(),
  limitationsJson: text("limitations_json").notNull(),
  contentHash: text("content_hash").notNull(),
  createdById: text("created_by_id").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_context_packs_created_at").on(desc(table.createdAt)),
]);

// -- events ------------------------------------------------------------------
export const eventsTable = sqliteTable("events", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  actorId: text("actor_id").notNull(),
  nodeId: text("node_id"),
  ts: integer("ts").notNull(),
  payloadJson: text("payload_json").notNull(),
}, (table) => [
  index("idx_events_kind_ts").on(table.kind, table.ts),
]);

// -- thread_events -----------------------------------------------------------
export const threadEventsTable = sqliteTable("thread_events", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  authorityNodeId: text("authority_node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  actorId: text("actor_id").references(() => actorsTable.id, { onDelete: "set null" }),
  ts: integer("ts").notNull(),
  payloadJson: text("payload_json").notNull(),
  notificationJson: text("notification_json"),
}, (table) => [
  unique().on(table.conversationId, table.seq),
  index("idx_thread_events_conversation_seq").on(table.conversationId, desc(table.seq)),
  index("idx_thread_events_conversation_ts").on(table.conversationId, desc(table.ts)),
  index("idx_thread_events_authority_node_id").on(table.authorityNodeId),
]);

// -- thread_cursors ----------------------------------------------------------
export const threadCursorsTable = sqliteTable("thread_cursors", {
  conversationId: text("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  authorityNodeId: text("authority_node_id").notNull().references(() => nodesTable.id, { onDelete: "restrict" }),
  lastAppliedSeq: integer("last_applied_seq").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.authorityNodeId] }),
  index("idx_thread_cursors_authority_node_id").on(table.authorityNodeId),
]);

// -- scout_dispatches --------------------------------------------------------
export const scoutDispatchesTable = sqliteTable("scout_dispatches", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  askedLabel: text("asked_label").notNull(),
  detail: text("detail").notNull(),
  invocationId: text("invocation_id"),
  conversationId: text("conversation_id"),
  requesterId: text("requester_id"),
  dispatcherNodeId: text("dispatcher_node_id").notNull(),
  dispatchedAt: integer("dispatched_at").notNull(),
  payloadJson: text("payload_json").notNull(),
}, (table) => [
  index("idx_dispatches_epoch_id").on(sql`CASE WHEN dispatched_at IS NULL THEN NULL WHEN CAST(dispatched_at AS REAL) < 1000000000000 THEN CAST(CAST(dispatched_at AS REAL) * 1000 AS INTEGER) ELSE CAST(dispatched_at AS INTEGER) END DESC`, table.id),
  index("idx_scout_dispatches_dispatched_at").on(desc(table.dispatchedAt)),
  index("idx_scout_dispatches_conversation_ts").on(table.conversationId, desc(table.dispatchedAt)),
]);

// -- activity_items ----------------------------------------------------------
export const activityItemsTable = sqliteTable("activity_items", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  ts: integer("ts").notNull(),
  conversationId: text("conversation_id").references(() => conversationsTable.id, { onDelete: "cascade" }),
  messageId: text("message_id").references(() => messagesTable.id, { onDelete: "cascade" }),
  invocationId: text("invocation_id").references(() => invocationsTable.id, { onDelete: "cascade" }),
  flightId: text("flight_id").references(() => flightsTable.id, { onDelete: "cascade" }),
  recordId: text("record_id").references(() => collaborationRecordsTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => actorsTable.id, { onDelete: "set null" }),
  counterpartId: text("counterpart_id").references(() => actorsTable.id, { onDelete: "set null" }),
  agentId: text("agent_id").references(() => actorsTable.id, { onDelete: "set null" }),
  workspaceRoot: text("workspace_root"),
  sessionId: text("session_id"),
  title: text("title"),
  summary: text("summary"),
  payloadJson: text("payload_json"),
}, (table) => [
  index("idx_activity_items_agent_ts").on(table.agentId, desc(table.ts)),
  index("idx_activity_items_actor_ts").on(table.actorId, desc(table.ts)),
  index("idx_activity_items_conversation_ts").on(table.conversationId, desc(table.ts)),
  index("idx_activity_items_epoch").on(sql`CASE WHEN ts IS NULL THEN NULL WHEN CAST(ts AS REAL) < 1000000000000 THEN CAST(CAST(ts AS REAL) * 1000 AS INTEGER) ELSE CAST(ts AS INTEGER) END DESC`),
  index("idx_activity_items_ts").on(desc(table.ts)),
  index("idx_activity_items_workspace_ts").on(table.workspaceRoot, desc(table.ts)),
  index("idx_activity_items_kind_ts").on(table.kind, desc(table.ts)),
  index("idx_activity_items_session_ts").on(table.sessionId, desc(table.ts)),
]);

// -- budget_usage_events -----------------------------------------------------
export const budgetUsageEventsTable = sqliteTable("budget_usage_events", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  source: text("source").notNull(),
  provider: text("provider"),
  harness: text("harness"),
  transport: text("transport"),
  model: text("model"),
  agentId: text("agent_id"),
  endpointId: text("endpoint_id"),
  sessionId: text("session_id"),
  projectRoot: text("project_root"),
  conversationId: text("conversation_id"),
  messageId: text("message_id"),
  invocationId: text("invocation_id"),
  flightId: text("flight_id"),
  workId: text("work_id"),
  occurredAt: integer("occurred_at").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningOutputTokens: integer("reasoning_output_tokens"),
  cacheCreationInputTokens: integer("cache_creation_input_tokens"),
  cacheReadInputTokens: integer("cache_read_input_tokens"),
  totalTokens: integer("total_tokens"),
  estimatedUsd: real("estimated_usd"),
  billedUsd: real("billed_usd"),
  currency: text("currency"),
  dedupKey: text("dedup_key"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochMsNow),
}, (table) => [
  index("idx_budget_usage_events_scope_occurred").on(table.scope, desc(table.occurredAt)),
  index("idx_budget_usage_events_session_occurred").on(table.sessionId, desc(table.occurredAt)),
  index("idx_budget_usage_events_invocation").on(table.invocationId, desc(table.occurredAt)),
  index("idx_budget_usage_events_flight").on(table.flightId, desc(table.occurredAt)),
  uniqueIndex("idx_budget_usage_events_dedup")
    .on(table.scope, table.source, table.dedupKey)
    .where(sql`dedup_key IS NOT NULL AND dedup_key != ''`),
]);

// -- budget_quota_window_snapshots -------------------------------------------
export const budgetQuotaWindowSnapshotsTable = sqliteTable("budget_quota_window_snapshots", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  provider: text("provider"),
  harness: text("harness"),
  transport: text("transport"),
  model: text("model"),
  agentId: text("agent_id"),
  endpointId: text("endpoint_id"),
  sessionId: text("session_id"),
  userId: text("user_id"),
  accountId: text("account_id"),
  planType: text("plan_type"),
  label: text("label").notNull(),
  windowKind: text("window_kind"),
  usedPercent: real("used_percent"),
  percentRemaining: real("percent_remaining"),
  used: real("used"),
  limitValue: real("limit_value"),
  resetAt: integer("reset_at"),
  windowMs: integer("window_ms"),
  capturedAt: integer("captured_at").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochMsNow),
}, (table) => [
  index("idx_budget_quota_windows_session_captured").on(table.sessionId, desc(table.capturedAt)),
  index("idx_budget_quota_windows_provider_label").on(table.provider, table.label, desc(table.capturedAt)),
]);

// -- mobile_push_registrations -----------------------------------------------
export const mobilePushRegistrationsTable = sqliteTable("mobile_push_registrations", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  platform: text("platform").notNull(),
  appBundleId: text("app_bundle_id").notNull(),
  apnsEnvironment: text("apns_environment").notNull(),
  pushToken: text("push_token").notNull(),
  authorizationStatus: text("authorization_status").notNull(),
  appVersion: text("app_version"),
  buildNumber: text("build_number"),
  deviceModel: text("device_model"),
  systemVersion: text("system_version"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_mobile_push_registrations_device_bundle_env").on(
    table.deviceId,
    table.platform,
    table.appBundleId,
    table.apnsEnvironment,
  ),
  uniqueIndex("idx_mobile_push_registrations_push_token").on(table.pushToken),
  index("idx_mobile_push_registrations_device_updated_at").on(table.deviceId, desc(table.updatedAt)),
]);

// -- briefings ---------------------------------------------------------------
// Typed handle for the Briefing Room query layer (packages/web/server/db/briefings.ts).
export const briefingsTable = sqliteTable("briefings", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"fleet-home" | "tour">().notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  recommendation: text("recommendation"),
  preparedAt: integer("prepared_at").notNull(),
  ttlMs: integer("ttl_ms").notNull(),
  briefJson: text("brief_json").notNull(),
  observationsJson: text("observations_json").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  callJson: text("call_json").notNull(),
  /**
   * Canonical markdown body (SCO-037 step 3). Nullable for backward
   * compatibility with rows persisted before the markdown pipeline.
   */
  markdown: text("markdown"),
  createdAt: integer("created_at").notNull().default(epochMsNow),
}, (table) => [
  index("idx_briefings_created_at").on(desc(table.createdAt)),
  index("idx_briefings_kind_created_at").on(table.kind, desc(table.createdAt)),
]);

// -- role_assignments --------------------------------------------------------
// Explicit assigned roles (orchestrator, later qa/sre). Not agentClass/identity.
// See docs/proposals/assigned-roles-and-mission-log.md
export const roleAssignmentsTable = sqliteTable("role_assignments", {
  id: text("id").primaryKey(),
  roleId: text("role_id").notNull(),
  agentId: text("agent_id").notNull(),
  /** mission | agent | project */
  scopeKind: text("scope_kind").notNull(),
  /** work-item id when scope_kind=mission; null for agent; unused for project */
  missionId: text("mission_id"),
  /** project root when scope_kind=project */
  projectRoot: text("project_root"),
  assignedById: text("assigned_by_id").notNull(),
  assignedAt: integer("assigned_at").notNull(),
  active: integer("active").notNull().default(1),
  revokedAt: integer("revoked_at"),
  revokedById: text("revoked_by_id"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochMsNow),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_role_assignments_agent_active").on(table.agentId, table.active),
  index("idx_role_assignments_mission_role_active").on(table.missionId, table.roleId, table.active),
  index("idx_role_assignments_role_active").on(table.roleId, table.active),
]);

// -- mission_log_entries -----------------------------------------------------
// Cheap orchestrator situation log (not chat). mission_id is a work-item id in v0.
export const missionLogEntriesTable = sqliteTable("mission_log_entries", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull(),
  nodeId: text("node_id"),
  at: integer("at").notNull(),
  seq: integer("seq").notNull(),
  actorId: text("actor_id").notNull(),
  kind: text("kind").notNull(),
  intent: text("intent").notNull(),
  status: text("status").notNull(),
  checkpoint: text("checkpoint"),
  blockersJson: text("blockers_json"),
  refsJson: text("refs_json"),
  note: text("note"),
  metadataJson: text("metadata_json"),
}, (table) => [
  uniqueIndex("idx_mission_log_entries_mission_seq").on(table.missionId, table.seq),
  index("idx_mission_log_entries_mission_at").on(table.missionId, desc(table.at)),
  index("idx_mission_log_entries_actor_at").on(table.actorId, desc(table.at)),
]);

// Broker-owned integration setup; credentials live in the host secret facility.
export const integrationSetupOperationsTable = sqliteTable("integration_setup_operations", {
  id: text("id").primaryKey(),
  ownerRealmId: text("owner_realm_id").notNull(),
  scopeKey: text("scope_key").notNull(),
  workspaceKey: text("workspace_key").notNull(),
  appId: text("app_id"),
  revision: integer("revision").notNull(),
  recordJson: text("record_json").notNull(),
}, (table) => [
  check("integration_setup_revision_check", sql`${table.revision} >= 1`),
  unique().on(table.ownerRealmId, table.scopeKey, table.workspaceKey),
  uniqueIndex("idx_integration_setup_app").on(table.ownerRealmId, table.workspaceKey, table.appId).where(sql`app_id IS NOT NULL`),
]);
export const integrationSetupRequestsTable = sqliteTable("integration_setup_requests", {
  ownerRealmId: text("owner_realm_id").notNull(),
  requestKey: text("request_key").notNull(),
  requestHash: text("request_hash").notNull(),
  operationId: text("operation_id").notNull().references(() => integrationSetupOperationsTable.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.ownerRealmId, table.requestKey] })]);

export const integrationWorkerLeasesTable = sqliteTable("integration_worker_leases", {
  operationId: text("operation_id").primaryKey().references(() => integrationSetupOperationsTable.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").notNull(),
  generation: integer("generation").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  state: text("state").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  check("integration_worker_generation_check", sql`${table.generation} >= 1`),
  check("integration_worker_state_check", sql`${table.state} IN ('starting', 'connected', 'stopped')`),
]);

export const integrationSlackThreadsTable = sqliteTable("integration_slack_threads", {
  operationId: text("operation_id").notNull().references(() => integrationSetupOperationsTable.id, { onDelete: "restrict" }),
  channelId: text("channel_id").notNull(), threadTs: text("thread_ts").notNull(), bindingRevision: integer("binding_revision").notNull(),
  bindingRef: text("binding_ref").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.operationId, table.channelId, table.threadTs] })]);
export const integrationSlackDeliveriesTable = sqliteTable("integration_slack_deliveries", {
  operationId: text("operation_id").notNull().references(() => integrationSetupOperationsTable.id, { onDelete: "restrict" }),
  eventKey: text("event_key").notNull(), channelId: text("channel_id").notNull(), threadTs: text("thread_ts").notNull(), userId: text("user_id").notNull(),
  bindingRevision: integer("binding_revision").notNull(), requestJson: text("request_json").notNull(), responseJson: text("response_json"), updatedAt: integer("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.operationId, table.eventKey] }), index("idx_integration_slack_pending_thread").on(table.operationId, table.channelId, table.threadTs).where(sql`response_json IS NULL`)]);

export const integrationSlackEventsTable = sqliteTable("integration_slack_events", {
  operationId: text("operation_id").notNull().references(() => integrationSetupOperationsTable.id, { onDelete: "restrict" }),
  eventId: text("event_id").notNull(), channelId: text("channel_id").notNull(), threadTs: text("thread_ts").notNull(), bindingRevision: integer("binding_revision").notNull(),
  envelopeJson: text("envelope_json").notNull(), deliveryKey: text("delivery_key").notNull(), progressJson: text("progress_json"), resultCompletedAt: integer("result_completed_at"), state: text("state").notNull(), attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull(), receivedAt: integer("received_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.operationId, table.eventId] }), check("integration_slack_event_state_check", sql`${table.state} IN ('pending', 'processed')`), index("idx_integration_slack_pending_events").on(table.operationId, table.state, table.receivedAt)]);

export const controlPlaneDrizzleSchema = {
  integrationSlackEventsTable,
  integrationSlackThreadsTable,
  integrationSlackDeliveriesTable,
  integrationWorkerLeasesTable,
  integrationSetupOperationsTable,
  integrationSetupRequestsTable,
  nodes: nodesTable,
  machines: machinesTable,
  trustedPeers: trustedPeersTable,
  peerNonces: peerNoncesTable,
  actors: actorsTable,
  agents: agentsTable,
  agentEndpoints: agentEndpointsTable,
  runtimeSessions: runtimeSessionsTable,
  runtimeSessionAliases: runtimeSessionAliasesTable,
  routeAliasBindings: routeAliasBindingsTable,
  routeAliasRevisions: routeAliasRevisionsTable,
  conversations: conversationsTable,
  conversationMembers: conversationMembersTable,
  messages: messagesTable,
  messageMentions: messageMentionsTable,
  messageReactions: messageReactionsTable,
  messageAttachments: messageAttachmentsTable,
  conversationReadCursors: conversationReadCursorsTable,
  brokerHistoryAnchors: brokerHistoryAnchorsTable,
  brokerJournalProjectionCheckpoints: brokerJournalProjectionCheckpointsTable,
  conversationProjectionMeta: conversationProjectionMetaTable,
  conversationProjectionItems: conversationProjectionItemsTable,
  conversationProjectionMessageFacts: conversationProjectionMessageFactsTable,
  conversationProjectionMessageStats: conversationProjectionMessageStatsTable,
  conversationProjectionSources: conversationProjectionSourcesTable,
  conversationProjectionEvents: conversationProjectionEventsTable,
  invocations: invocationsTable,
  flights: flightsTable,
  bindings: bindingsTable,
  deliveries: deliveriesTable,
  deliveryAttempts: deliveryAttemptsTable,
  durableActions: durableActionsTable,
  durableAttempts: durableAttemptsTable,
  durableCheckpoints: durableCheckpointsTable,
  durableSignals: durableSignalsTable,
  collaborationRecords: collaborationRecordsTable,
  collaborationEvents: collaborationEventsTable,
  contextBlocks: contextBlocksTable,
  contextPacks: contextPacksTable,
  events: eventsTable,
  threadEvents: threadEventsTable,
  threadCursors: threadCursorsTable,
  scoutDispatches: scoutDispatchesTable,
  activityItems: activityItemsTable,
  budgetUsageEvents: budgetUsageEventsTable,
  budgetQuotaWindowSnapshots: budgetQuotaWindowSnapshotsTable,
  mobilePushRegistrations: mobilePushRegistrationsTable,
  briefings: briefingsTable,
  roleAssignments: roleAssignmentsTable,
  missionLogEntries: missionLogEntriesTable,
} as const;
