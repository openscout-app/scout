import { canonicalMessageRecord } from "./message-record-canonical.js";
import { ControlPlaneHistoryReader, ControlPlaneHistoryStore, type HistoricalPublication, type HistoricalRecordLocation } from "./control-plane-history-store.js";
import { ControlPlaneHistoryRelocation, ensureHistoryAnchorSchema, type HistoricalTypedReader } from "./control-plane-history-relocation.js";
import type { HistoryRotationPlan } from "./history-rotation.js";
import { NATIVE_READ_THREAD_MAX_MESSAGE_BYTES } from "./conversation-thread-artifact.js";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { and, asc, eq, inArray } from "drizzle-orm";

import {
  canonicalMeshNodeId,
  stripBonjourCollisionSuffix,
} from "./node-identity.js";

import {
  readChatMessageCorrection,
  EPOCH_MILLISECONDS_FLOOR,
  machineSshTargets,
  epochMs,
  normalizeTerminalWorkspaceColumns,
  nowMs,
  parseTerminalWorkspaceLayoutJson,
  scoutConversationFeedId,
} from "@openscout/protocol";
import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  BudgetQuotaWindowSnapshot,
  BudgetUsageRecord,
  CollaborationEvent,
  CollaborationRecord,
  CollaborationRelation,
  CollaborationPriority,
  CollaborationWaitingOn,
  CollaborationProgress,
  WorkItemState,
  QuestionState,
  ControlEvent,
  ConversationBinding,
  ConversationDefinition,
  ConversationReadCursor,
  ConversationThreadLaunchSnapshot,
  DeliveryAttempt,
  DeliveryIntent,
  DurableAction,
  DurableActionCreateInput,
  DurableActionClaimInput,
  DurableActionHeartbeatInput,
  DurableAttempt,
  DurableCheckpoint,
  DurableSignal,
  FlightRecord,
  InvocationRequest,
  MessageAttachment,
  MessageMention,
  MessageReactionRecord,
  MessageRecord,
  NodeDefinition,
  ScoutDispatchRecord,
  TerminalSessionRecord,
  TerminalSessionRecordInput,
  TerminalSurface,
  TerminalWorkspaceCell,
  TerminalWorkspaceRecord,
  TerminalWorkspaceRecordInput,
  ThreadCollaborationEventSummary,
  ThreadCollaborationSummary,
  ThreadEventEnvelope,
  ThreadEventKind,
  ThreadEventNotification,
  ThreadFlightSummary,
  ThreadMessageSummary,
  ThreadSnapshot,
  MachineRecord,
  TrustedPeerRecord,
} from "@openscout/protocol";

import {
  createRuntimeRegistrySnapshot,
  type RuntimeActorIdentity,
  type RuntimeRegistrySnapshot,
} from "./registry.js";
import { openControlPlaneDrizzle } from "./drizzle-client.js";
import {
  openControlPlaneSqliteDatabase,
  type ControlPlaneSqliteBinding,
  type ControlPlaneSqliteDatabase,
  type ControlPlaneSqliteTransactionalDatabase,
} from "./sqlite-adapter.js";
import {
  configureControlPlaneDatabase,
  migrateControlPlaneDatabaseSchema,
} from "./control-plane-migrations.js";
import { Conversations, type ConversationsApi } from "./conversations/api.js";
import {
  deliveryAttemptsTable,
  deliveriesTable,
} from "./drizzle-schema.js";
import { budgetObservationsFromEndpoint } from "./budget-observations.js";
import {
  runtimeSessionHandleForEndpoint,
  runtimeSessionPrimaryAlias,
} from "./runtime-session-handle.js";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const PENDING_EVENT_BUSY_RETRY_MS = 25;

function isTransientSqliteBusyError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      return true;
    }
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("database is locked")
    || message.includes("database is busy")
    || message.includes("sqlite_busy");
}

function stringify(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function currentTimestampMs(): number {
  return nowMs();
}

const RUNTIME_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Hourly quota history is charted over the last week; one bucket of slack
// keeps the oldest charted hour whole.
const QUOTA_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;
const QUOTA_HISTORY_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

const RUNTIME_SESSION_ALIAS_METADATA_KEYS = [
  { key: "sessionId", kind: "metadata_session" },
  { key: "externalSessionId", kind: "external" },
  { key: "threadId", kind: "thread" },
  { key: "nativeSessionId", kind: "native" },
  { key: "runtimeSessionId", kind: "runtime" },
  { key: "runtimeInstanceId", kind: "runtime" },
  { key: "tmuxSession", kind: "tmux" },
  { key: "pairingSessionId", kind: "pairing" },
] as const;

function normalizeTimestampMs(value: number | null | undefined): number | null {
  return epochMs(value);
}

/**
 * Record kinds the history-rotation persistence boundary verifies. For each,
 * `canonicalRecord` produces the exact shape the row→record mappers emit —
 * the persisted field set with every normalization the mapper applies —
 * so an `isDeepStrictEqual` comparison against the journaled record is
 * symmetric by construction: fields the table does not store are dropped,
 * null/undefined collapse identically, and JSON columns get the same
 * stringify→parse round-trip on both sides.
 */
export type PersistedRotationRecordKind =
  | "message"
  | "invocation"
  | "flight"
  | "delivery"
  | "deliveryAttempt"
  | "collaborationEvent";

/** JSON-column normalization — mirrors `stringify`→`parseJson`. */
function jsonCanonical<T>(value: T | null | undefined): T | undefined {
  return value === undefined || value === null
    ? undefined
    : JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Cross-record inputs the write path had when it normalized a record, so the
 * expected (in-memory) side of a persisted-parity comparison can apply the
 * same normalization. Stored rows already embody write-path normalization —
 * callers pass context only for the expected side.
 */
export interface CanonicalRecordContext {
  /**
   * A flight's parent invocation is the identity authority: `recordFlight`
   * rewrites a divergent requester/target to the invocation's identities
   * before writing. Pass the journaled parent invocation here so the
   * canonical form of the expected flight matches the stored row.
   */
  flightInvocation?: Pick<InvocationRequest, "requesterId" | "targetAgentId"> | undefined;
}

export function canonicalRecord<T>(
  kind: PersistedRotationRecordKind,
  record: T,
  context?: CanonicalRecordContext,
): T {
  const r = record as Record<string, unknown>;
  switch (kind) {
    case "message":
      return canonicalMessageRecord(record as unknown as MessageRecord) as T;
    case "invocation":
      return {
        id: r.id,
        requesterId: r.requesterId,
        requesterNodeId: r.requesterNodeId,
        targetAgentId: r.targetAgentId,
        targetNodeId: r.targetNodeId ?? undefined,
        action: r.action,
        task: r.task,
        // recordInvocation stores resolveInvocationCollaborationRecordId's
        // result; applying the same resolver here keeps the canonical form
        // equal by construction. On a stored row the resolver's first clause
        // returns the column itself (trimmed), so this is idempotent.
        collaborationRecordId: resolveInvocationCollaborationRecordId(r as unknown as InvocationRequest),
        conversationId: r.conversationId ?? undefined,
        messageId: r.messageId ?? undefined,
        context: jsonCanonical(r.context),
        execution: jsonCanonical(r.execution),
        executionResolution: jsonCanonical(r.executionResolution),
        ensureAwake: r.ensureAwake === true,
        stream: r.stream === true,
        timeoutMs: r.timeoutMs ?? undefined,
        labels: jsonCanonical(r.labels),
        metadata: jsonCanonical(r.metadata),
        createdAt: r.createdAt,
      } as T;
    case "flight": {
      // recordFlight rewrites a divergent requester/target to the parent
      // invocation's identities before writing. context.flightInvocation is
      // the journaled parent — apply the same normalization to the expected
      // record. Stored rows carry the normalized identity already and are
      // canonicalized without context.
      const identity = context?.flightInvocation;
      return {
        id: r.id,
        invocationId: r.invocationId,
        requesterId: identity?.requesterId ?? r.requesterId,
        targetAgentId: identity?.targetAgentId ?? r.targetAgentId,
        state: r.state,
        summary: r.summary ?? undefined,
        output: r.output ?? undefined,
        error: r.error ?? undefined,
        labels: jsonCanonical(r.labels),
        metadata: jsonCanonical(r.metadata),
        startedAt: r.startedAt ?? undefined,
        completedAt: r.completedAt ?? undefined,
      } as T;
    }
    case "delivery":
      return {
        id: r.id,
        messageId: r.messageId ?? undefined,
        invocationId: r.invocationId ?? undefined,
        targetId: r.targetId,
        targetNodeId: r.targetNodeId ?? undefined,
        targetKind: r.targetKind,
        transport: r.transport,
        reason: r.reason,
        policy: r.policy,
        status: r.status,
        bindingId: r.bindingId ?? undefined,
        leaseOwner: r.leaseOwner ?? undefined,
        leaseExpiresAt: r.leaseExpiresAt ?? undefined,
        metadata: jsonCanonical(r.metadata),
      } as T;
    case "deliveryAttempt":
      return {
        id: r.id,
        deliveryId: r.deliveryId,
        attempt: r.attempt,
        status: r.status,
        error: r.error ?? undefined,
        externalRef: r.externalRef ?? undefined,
        createdAt: r.createdAt,
        metadata: jsonCanonical(r.metadata),
      } as T;
    case "collaborationEvent":
      return {
        id: r.id,
        recordId: r.recordId,
        recordKind: r.recordKind,
        kind: r.kind,
        actorId: r.actorId,
        summary: r.summary ?? undefined,
        metadata: jsonCanonical(r.metadata),
        at: r.at,
      } as T;
  }
}

function stableHash(value: string, length = 20): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function metadataStringValue(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataTimestampValue(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function firstStringValue(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function isSqliteConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  return code.includes("SQLITE_CONSTRAINT")
    || message.includes("SQLITE_CONSTRAINT")
    || message.includes("constraint failed");
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return metadata?.[key];
}

function stringValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadataValue(metadata, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function invocationStringValue(invocation: InvocationRequest, key: string): string | undefined {
  const contextValue = stringValue(invocation.context, key);
  if (contextValue) {
    return contextValue;
  }

  const nestedContext = metadataValue(invocation.context, "collaboration");
  if (nestedContext && typeof nestedContext === "object" && !Array.isArray(nestedContext)) {
    const nestedValue = stringValue(nestedContext as Record<string, unknown>, key);
    if (nestedValue) {
      return nestedValue;
    }
  }

  const metadataEntry = stringValue(invocation.metadata, key);
  if (metadataEntry) {
    return metadataEntry;
  }

  const nestedMetadata = metadataValue(invocation.metadata, "collaboration");
  if (nestedMetadata && typeof nestedMetadata === "object" && !Array.isArray(nestedMetadata)) {
    return stringValue(nestedMetadata as Record<string, unknown>, key);
  }

  return undefined;
}

function resolveInvocationCollaborationRecordId(invocation: InvocationRequest): string | undefined {
  return invocation.collaborationRecordId?.trim()
    || invocationStringValue(invocation, "collaborationRecordId")
    || invocationStringValue(invocation, "recordId");
}

type SQLiteBinding = ControlPlaneSqliteBinding;

type SQLiteStatementLike<Row, Params extends SQLiteBinding[]> = {
  all(...params: Params): Row[];
  get(...params: Params): Row | null;
};

type SQLiteTransactionalDatabase = ControlPlaneSqliteTransactionalDatabase;

function queryAll<Row, Params extends SQLiteBinding[] = []>(
  db: ControlPlaneSqliteDatabase,
  sql: string,
  ...params: Params
): Row[] {
  const statement = db.query(sql) as SQLiteStatementLike<Row, Params>;
  return statement.all(...params);
}

function queryAllDynamic<Row>(
  db: ControlPlaneSqliteDatabase,
  sql: string,
  params: SQLiteBinding[],
): Row[] {
  const statement = db.query(sql) as SQLiteStatementLike<Row, SQLiteBinding[]>;
  return statement.all(...params);
}

/** Bounded `IN`-list chunks — SQLite's bound-parameter limit stays clear. */
function* chunksOf(ids: readonly string[], size = 400): Generator<readonly string[]> {
  for (let start = 0; start < ids.length; start += size) {
    yield ids.slice(start, start + size);
  }
}

function queryGet<Row, Params extends SQLiteBinding[] = []>(
  db: ControlPlaneSqliteDatabase,
  sql: string,
  ...params: Params
): Row | null {
  const statement = db.query(sql) as SQLiteStatementLike<Row, Params>;
  return statement.get(...params);
}

function summarizeText(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

interface ActorRow {
  id: string;
  kind: ActorIdentity["kind"];
  display_name: string;
  handle: string | null;
  labels_json: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface NodeRow {
  id: string;
  mesh_id: string;
  name: string;
  host_name: string | null;
  advertise_scope: NodeDefinition["advertiseScope"];
  broker_url: string | null;
  tailnet_name: string | null;
  capabilities_json: string | null;
  labels_json: string | null;
  metadata_json: string | null;
  last_seen_at: number | null;
  registered_at: number;
}

interface MachineRow {
  id: string;
  display_name: string | null;
  name: string;
  platform: MachineRecord["platform"];
  identity_keys_json: string;
  is_self: number;
  scout_node_id: string | null;
  mesh_id: string | null;
  tailnet_id: string | null;
  tailnet_name: string | null;
  host_names_json: string | null;
  addresses_json: string | null;
  mac_addresses_json: string | null;
  capabilities_json: string | null;
  routes_json: string | null;
  evidence_json: string | null;
  pinned: number;
  notes: string | null;
  metadata_json: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

interface TrustedPeerRow {
  key_id: string;
  public_key: string;
  fingerprint: string;
  node_id: string | null;
  label: string;
  tier: TrustedPeerRecord["tier"];
  granted_via: TrustedPeerRecord["grantedVia"];
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_seen_at: number | null;
  metadata_json: string | null;
  tls_spki_fingerprint: string | null;
}

interface AgentRow {
  id: string;
  definition_id: string;
  node_qualifier: string | null;
  workspace_qualifier: string | null;
  selector: string | null;
  default_selector: string | null;
  agent_class: AgentDefinition["agentClass"];
  capabilities_json: string;
  wake_policy: AgentDefinition["wakePolicy"];
  home_node_id: string;
  authority_node_id: string;
  advertise_scope: AgentDefinition["advertiseScope"];
  owner_id: string | null;
  metadata_json: string | null;
}

interface EndpointRow {
  id: string;
  agent_id: string;
  node_id: string;
  harness: AgentEndpoint["harness"];
  transport: AgentEndpoint["transport"];
  state: AgentEndpoint["state"];
  address: string | null;
  session_id: string | null;
  pane: string | null;
  cwd: string | null;
  project_root: string | null;
  metadata_json: string | null;
}

interface RuntimeSessionRow {
  id: string;
  agent_id: string;
  endpoint_id: string;
  node_id: string;
  harness: string;
  transport: string;
  state: string;
  primary_alias: string;
  external_session_id: string | null;
  cwd: string | null;
  project_root: string | null;
  started_at: number | null;
  last_seen_at: number;
  ended_at: number | null;
  expires_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface RuntimeSessionAliasRow {
  alias: string;
  session_id: string;
  alias_kind: string;
  agent_id: string;
  endpoint_id: string;
  node_id: string;
  harness: string;
  transport: string;
  first_seen_at: number;
  last_seen_at: number;
  expires_at: number | null;
}

export type RuntimeSessionIndexRecord = {
  id: string;
  agentId: string;
  endpointId: string;
  nodeId: string;
  harness: string;
  transport: string;
  state: string;
  primaryAlias: string;
  externalSessionId?: string;
  cwd?: string;
  projectRoot?: string;
  startedAt?: number;
  lastSeenAt: number;
  endedAt?: number;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

export type RuntimeSessionAliasRecord = {
  alias: string;
  sessionId: string;
  aliasKind: string;
  agentId: string;
  endpointId: string;
  nodeId: string;
  harness: string;
  transport: string;
  firstSeenAt: number;
  lastSeenAt: number;
  expiresAt?: number;
};

interface TerminalSessionRow {
  id: string;
  harness: string;
  source_session_id: string;
  cwd: string;
  resume_command: string;
  surfaces_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface TerminalWorkspaceRow {
  id: string;
  name: string;
  purpose: string;
  columns_count: number;
  /** Absent, not just null, on a row read from a table that predates the column. */
  layout_json?: string | null;
  cells_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface BudgetUsageRow {
  id: string;
  scope: BudgetUsageRecord["scope"];
  source: BudgetUsageRecord["source"];
  provider: string | null;
  harness: string | null;
  transport: string | null;
  model: string | null;
  agent_id: string | null;
  endpoint_id: string | null;
  session_id: string | null;
  project_root: string | null;
  conversation_id: string | null;
  message_id: string | null;
  invocation_id: string | null;
  flight_id: string | null;
  work_id: string | null;
  occurred_at: number;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_tokens: number | null;
  estimated_usd: number | null;
  billed_usd: number | null;
  currency: string | null;
  dedup_key: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface BudgetQuotaWindowRow {
  id: string;
  source: BudgetQuotaWindowSnapshot["source"];
  provider: string | null;
  harness: string | null;
  transport: string | null;
  model: string | null;
  agent_id: string | null;
  endpoint_id: string | null;
  session_id: string | null;
  user_id: string | null;
  account_id: string | null;
  plan_type: string | null;
  label: string;
  window_kind: string | null;
  used_percent: number | null;
  percent_remaining: number | null;
  used: number | null;
  limit_value: number | null;
  reset_at: number | null;
  window_ms: number | null;
  captured_at: number;
  metadata_json: string | null;
  created_at: number;
}

interface BudgetUsageListOptions {
  scope?: BudgetUsageRecord["scope"];
  provider?: string;
  agentId?: string;
  endpointId?: string;
  sessionId?: string;
  invocationId?: string;
  flightId?: string;
  since?: number;
  until?: number;
  limit?: number;
}

interface BudgetQuotaWindowListOptions {
  provider?: string;
  agentId?: string;
  endpointId?: string;
  sessionId?: string;
  label?: string;
  source?: BudgetQuotaWindowSnapshot["source"];
  since?: number;
  until?: number;
  limit?: number;
}

function budgetUsageFromRow(row: BudgetUsageRow): BudgetUsageRecord {
  return {
    id: row.id,
    scope: row.scope,
    source: row.source,
    provider: row.provider ?? undefined,
    harness: row.harness ?? undefined,
    transport: row.transport ?? undefined,
    model: row.model ?? undefined,
    agentId: row.agent_id ?? undefined,
    endpointId: row.endpoint_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    projectRoot: row.project_root ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    messageId: row.message_id ?? undefined,
    invocationId: row.invocation_id ?? undefined,
    flightId: row.flight_id ?? undefined,
    workId: row.work_id ?? undefined,
    occurredAt: row.occurred_at,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    reasoningOutputTokens: row.reasoning_output_tokens ?? undefined,
    cacheCreationInputTokens: row.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: row.cache_read_input_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    estimatedUsd: row.estimated_usd ?? undefined,
    billedUsd: row.billed_usd ?? undefined,
    currency: row.currency ?? undefined,
    dedupKey: row.dedup_key ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    createdAt: row.created_at,
  };
}

function normalizedListLimit(value: number | undefined, fallback = 100, max = 500): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function budgetQuotaWindowFromRow(row: BudgetQuotaWindowRow): BudgetQuotaWindowSnapshot {
  return {
    id: row.id,
    source: row.source,
    provider: row.provider ?? undefined,
    harness: row.harness ?? undefined,
    transport: row.transport ?? undefined,
    model: row.model ?? undefined,
    agentId: row.agent_id ?? undefined,
    endpointId: row.endpoint_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    userId: row.user_id ?? undefined,
    accountId: row.account_id ?? undefined,
    planType: row.plan_type ?? undefined,
    label: row.label,
    windowKind: row.window_kind ?? undefined,
    usedPercent: row.used_percent ?? undefined,
    percentRemaining: row.percent_remaining ?? undefined,
    used: row.used ?? undefined,
    limit: row.limit_value ?? undefined,
    resetAt: row.reset_at ?? undefined,
    windowMs: row.window_ms ?? undefined,
    capturedAt: row.captured_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    createdAt: row.created_at,
  };
}

function runtimeSessionFromRow(row: RuntimeSessionRow): RuntimeSessionIndexRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    endpointId: row.endpoint_id,
    nodeId: row.node_id,
    harness: row.harness,
    transport: row.transport,
    state: row.state,
    primaryAlias: row.primary_alias,
    externalSessionId: row.external_session_id ?? undefined,
    cwd: row.cwd ?? undefined,
    projectRoot: row.project_root ?? undefined,
    startedAt: row.started_at ?? undefined,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

/** Deterministic registry id so re-intaking the same harness session updates one record. */
function terminalSessionRegistryId(harness: string, sourceSessionId: string): string {
  return `ts.${stableHash(`${harness}${sourceSessionId}`)}`;
}

function terminalWorkspaceFromRow(row: TerminalWorkspaceRow): TerminalWorkspaceRecord {
  const layout = parseTerminalWorkspaceLayoutJson(row.layout_json);
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    columns: normalizeTerminalWorkspaceColumns(row.columns_count),
    // Absent for a row written before layouts were stored, and for a row from a
    // table that predates the column. The record then carries only the resolved
    // column count and `terminalWorkspaceLayoutOf` infers a shape from it — a
    // fold-forward, not a substitute, which is why the column exists.
    ...(layout ? { layout } : {}),
    cells: parseJson<TerminalWorkspaceCell[]>(row.cells_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function terminalSessionFromRow(row: TerminalSessionRow): TerminalSessionRecord {
  return {
    id: row.id,
    harness: row.harness,
    sourceSessionId: row.source_session_id,
    cwd: row.cwd,
    resumeCommand: row.resume_command,
    surfaces: parseJson<TerminalSurface[]>(row.surfaces_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function machineSshTargetsField(evidence: MachineRecord["evidence"]): Pick<MachineRecord, "sshTargets"> {
  const sshTargets = machineSshTargets(evidence);
  return sshTargets.length > 0 ? { sshTargets } : {};
}

function machineFromRow(row: MachineRow): MachineRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    name: row.name,
    platform: row.platform,
    identityKeys: parseJson<string[]>(row.identity_keys_json, []),
    isSelf: row.is_self === 1,
    ...(row.scout_node_id ? { scoutNodeId: row.scout_node_id } : {}),
    ...(row.mesh_id ? { meshId: row.mesh_id } : {}),
    ...(row.tailnet_id ? { tailnetId: row.tailnet_id } : {}),
    ...(row.tailnet_name ? { tailnetName: row.tailnet_name } : {}),
    hostNames: parseJson<string[]>(row.host_names_json, []),
    addresses: parseJson<string[]>(row.addresses_json, []),
    macAddresses: parseJson<string[]>(row.mac_addresses_json, []),
    capabilities: parseJson<MachineRecord["capabilities"]>(row.capabilities_json, []),
    routes: parseJson<MachineRecord["routes"]>(row.routes_json, []),
    ...machineSshTargetsField(parseJson<MachineRecord["evidence"]>(row.evidence_json, [])),
    evidence: parseJson<MachineRecord["evidence"]>(row.evidence_json, []),
    pinned: row.pinned === 1,
    ...(row.notes ? { notes: row.notes } : {}),
    ...(parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined)
      ? { metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}) }
      : {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function trustedPeerFromRow(row: TrustedPeerRow): TrustedPeerRecord {
  return {
    keyId: row.key_id,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    nodeId: row.node_id ?? undefined,
    label: row.label,
    tier: row.tier,
    grantedVia: row.granted_via,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    tlsSpkiFingerprint: row.tls_spki_fingerprint ?? undefined,
  };
}

function runtimeSessionAliasFromRow(row: RuntimeSessionAliasRow): RuntimeSessionAliasRecord {
  return {
    alias: row.alias,
    sessionId: row.session_id,
    aliasKind: row.alias_kind,
    agentId: row.agent_id,
    endpointId: row.endpoint_id,
    nodeId: row.node_id,
    harness: row.harness,
    transport: row.transport,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at ?? undefined,
  };
}

type RuntimeSessionAliasInput = {
  alias: string;
  aliasKind: string;
};

function runtimeSessionMetadata(endpoint: AgentEndpoint): Record<string, unknown> {
  return endpoint.metadata ?? {};
}

function endpointRuntimeSessionExternalId(endpoint: AgentEndpoint): string | null {
  const metadata = runtimeSessionMetadata(endpoint);
  return firstStringValue(
    metadataStringValue(metadata, "externalSessionId"),
    metadataStringValue(metadata, "threadId"),
    metadataStringValue(metadata, "nativeSessionId"),
    metadataStringValue(metadata, "pairingSessionId"),
  );
}

function endpointRuntimeSessionStartedAt(endpoint: AgentEndpoint, fallback: number): number {
  const metadata = runtimeSessionMetadata(endpoint);
  return metadataTimestampValue(metadata, "sessionStartedAt")
    ?? metadataTimestampValue(metadata, "startedAt")
    ?? metadataTimestampValue(metadata, "lastStartedAt")
    ?? fallback;
}

function endpointRuntimeSessionLastSeenAt(endpoint: AgentEndpoint, fallback: number): number {
  const metadata = runtimeSessionMetadata(endpoint);
  return Math.max(
    metadataTimestampValue(metadata, "lastSeenAt") ?? 0,
    metadataTimestampValue(metadata, "lastEnsuredAt") ?? 0,
    metadataTimestampValue(metadata, "lastStartedAt") ?? 0,
    metadataTimestampValue(metadata, "lastCompletedAt") ?? 0,
    metadataTimestampValue(metadata, "lastFailedAt") ?? 0,
    metadataTimestampValue(metadata, "lastResumedAt") ?? 0,
    metadataTimestampValue(metadata, "lastInterruptedAt") ?? 0,
    fallback,
  );
}

function endpointRuntimeSessionIsTerminal(endpoint: AgentEndpoint): boolean {
  return endpoint.state === "offline" || endpoint.metadata?.staleLocalRegistration === true;
}

function endpointRuntimeSessionState(endpoint: AgentEndpoint): string {
  return endpoint.metadata?.staleLocalRegistration === true ? "superseded" : endpoint.state;
}

function endpointRuntimeSessionAliases(endpoint: AgentEndpoint, scoutSessionId: string): RuntimeSessionAliasInput[] {
  const metadata = runtimeSessionMetadata(endpoint);
  const aliases: RuntimeSessionAliasInput[] = [
    { alias: scoutSessionId, aliasKind: "scout" },
    { alias: endpoint.id, aliasKind: "endpoint" },
  ];
  if (endpoint.sessionId?.trim()) {
    aliases.push({ alias: endpoint.sessionId.trim(), aliasKind: "endpoint_session" });
  }
  for (const entry of RUNTIME_SESSION_ALIAS_METADATA_KEYS) {
    const value = metadataStringValue(metadata, entry.key);
    if (value) {
      aliases.push({ alias: value, aliasKind: entry.kind });
    }
  }
  const provisionalHandle = metadataStringValue(metadata, "handle");
  if (provisionalHandle) {
    aliases.push({ alias: provisionalHandle, aliasKind: "provisional" });
  }
  if (endpoint.agentId?.trim()) {
    aliases.push({ alias: endpoint.agentId.trim(), aliasKind: "session_actor" });
  }

  const unique = new Map<string, RuntimeSessionAliasInput>();
  for (const entry of aliases) {
    const alias = entry.alias.trim();
    if (!alias || unique.has(alias)) {
      continue;
    }
    unique.set(alias, { ...entry, alias });
  }
  return [...unique.values()];
}

interface ConversationRow {
  id: string;
  kind: ConversationDefinition["kind"];
  title: string;
  visibility: ConversationDefinition["visibility"];
  share_mode: ConversationDefinition["shareMode"];
  authority_node_id: string;
  topic: string | null;
  parent_conversation_id: string | null;
  message_id: string | null;
  metadata_json: string | null;
}

interface BindingRow {
  id: string;
  conversation_id: string;
  platform: string;
  mode: ConversationBinding["mode"];
  external_channel_id: string;
  external_thread_id: string | null;
  metadata_json: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  actor_id: string;
  origin_node_id: string;
  class: MessageRecord["class"];
  body: string;
  reply_to_message_id: string | null;
  thread_conversation_id: string | null;
  speech_json: string | null;
  audience_json: string | null;
  visibility: MessageRecord["visibility"];
  policy: MessageRecord["policy"];
  metadata_json: string | null;
  created_at: number;
}

interface ConversationThreadLaunchMessageRow {
  id: string;
  actor_id: string;
  actor_name: string | null;
  body: string;
  class: MessageRecord["class"];
  created_at: number;
}

interface MentionRow {
  message_id: string;
  actor_id: string;
  label: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  media_type: string;
  file_name: string | null;
  blob_key: string | null;
  url: string | null;
  metadata_json: string | null;
}

interface ReadCursorRow {
  conversation_id: string;
  actor_id: string;
  reader_node_id: string | null;
  last_read_message_id: string | null;
  last_read_seq: number | null;
  last_read_at: number;
  updated_at: number;
  metadata_json: string | null;
}

interface InvocationRow {
  id: string;
  requester_id: string;
  requester_node_id: string;
  target_agent_id: string;
  target_node_id: string | null;
  action: InvocationRequest["action"];
  task: string;
  collaboration_record_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  context_json: string | null;
  execution_json: string | null;
  execution_resolution_json: string | null;
  ensure_awake: number;
  stream: number;
  timeout_ms: number | null;
  labels_json: string | null;
  metadata_json: string | null;
  created_at: number;
  // Flight status columns (Phase 3 flight→invocation storage merge, expand
  // phase). Written by the recordFlight dual-write; reads still come from the
  // flights table for now.
  flight_id: string | null;
  state: FlightRecord["state"] | null;
  summary: string | null;
  output: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  flight_metadata_json: string | null;
}

interface FlightRow {
  id: string;
  invocation_id: string;
  requester_id: string;
  target_agent_id: string;
  state: FlightRecord["state"];
  summary: string | null;
  output: string | null;
  error: string | null;
  labels_json: string | null;
  metadata_json: string | null;
  started_at: number | null;
  completed_at: number | null;
}

interface DurableActionRow {
  id: string;
  kind: DurableAction["kind"];
  subject_id: string;
  authority_cell_id: string;
  state: DurableAction["state"];
  idempotency_key: string | null;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface DurableAttemptRow {
  id: string;
  action_id: string;
  attempt: number;
  state: DurableAttempt["state"];
  lease_generation: number;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  metadata_json: string | null;
}

interface DurableCheckpointRow {
  action_id: string;
  name: string;
  payload_json: string | null;
  owner_attempt_id: string | null;
  created_at: number;
}

interface DurableSignalRow {
  action_id: string;
  name: string;
  payload_json: string | null;
  emitted_at: number;
}

function durableActionFromRow(row: DurableActionRow): DurableAction {
  return {
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    authorityCellId: row.authority_cell_id,
    state: row.state,
    idempotencyKey: row.idempotency_key ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function durableAttemptFromRow(row: DurableAttemptRow): DurableAttempt {
  return {
    id: row.id,
    actionId: row.action_id,
    attempt: row.attempt,
    state: row.state,
    leaseGeneration: row.lease_generation,
    error: row.error ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function durableCheckpointFromRow(row: DurableCheckpointRow): DurableCheckpoint {
  return {
    actionId: row.action_id,
    name: row.name,
    payload: parseJson<unknown>(row.payload_json, undefined),
    ownerAttemptId: row.owner_attempt_id ?? undefined,
    createdAt: row.created_at,
  };
}

function durableSignalFromRow(row: DurableSignalRow): DurableSignal {
  return {
    actionId: row.action_id,
    name: row.name,
    payload: parseJson<unknown>(row.payload_json, undefined),
    emittedAt: row.emitted_at,
  };
}

interface CollaborationRecordRow {
  id: string;
  kind: CollaborationRecord["kind"];
  state: string;
  acceptance_state: string;
  title: string;
  summary: string | null;
  created_by_id: string;
  owner_id: string | null;
  next_move_owner_id: string | null;
  conversation_id: string | null;
  parent_id: string | null;
  priority: string | null;
  labels_json: string | null;
  relations_json: string | null;
  detail_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CollaborationEventRow {
  id: string;
  record_id: string;
  record_kind: string;
  kind: string;
  actor_id: string;
  summary: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface EventRow {
  id: string;
  kind: string;
  actor_id: string;
  node_id: string | null;
  ts: number;
  payload_json: string;
}

interface ThreadEventRow {
  id: string;
  conversation_id: string;
  authority_node_id: string;
  seq: number;
  kind: ThreadEventKind;
  actor_id: string | null;
  ts: number;
  payload_json: string;
  notification_json: string | null;
}

interface ThreadCursorRow {
  conversation_id: string;
  authority_node_id: string;
  last_applied_seq: number;
  updated_at: number;
}

type ThreadEventInsert = {
  id: string;
  conversation: ConversationDefinition;
  kind: ThreadEventKind;
  actorId?: string;
  ts: number;
  payload: ThreadEventEnvelope["payload"];
  notification?: ThreadEventNotification;
};

export type ActivityItemKind =
  | "message_posted"
  | "agent_message"
  | "status_message"
  | "ask_opened"
  | "ask_working"
  | "ask_replied"
  | "ask_failed"
  | "handoff_sent"
  | "invocation_recorded"
  | "flight_updated"
  | "collaboration_event";

export type ActivityItem = {
  id: string;
  kind: ActivityItemKind;
  ts: number;
  conversationId?: string;
  messageId?: string;
  invocationId?: string;
  flightId?: string;
  recordId?: string;
  actorId?: string;
  counterpartId?: string;
  agentId?: string;
  workspaceRoot?: string;
  sessionId?: string;
  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;
};

interface ActivityItemRow {
  id: string;
  kind: ActivityItemKind;
  ts: number;
  conversation_id: string | null;
  message_id: string | null;
  invocation_id: string | null;
  flight_id: string | null;
  record_id: string | null;
  actor_id: string | null;
  counterpart_id: string | null;
  agent_id: string | null;
  workspace_root: string | null;
  session_id: string | null;
  title: string | null;
  summary: string | null;
  payload_json: string | null;
}

/**
 * Row→record mappers — the single source of truth for what the durable
 * tables project back into. `loadSnapshot` and the rotation verifier's
 * chunked `read*` lookups share them, and every output passes through
 * `canonicalRecord`, so the verifier can compare a stored row against the
 * journaled record field-for-field.
 */
function messageRecordFromRow(
  row: MessageRow,
  mentions: MessageMention[] | undefined,
  attachments: MessageAttachment[] | undefined,
): MessageRecord {
  return canonicalRecord("message", {
    id: row.id,
    conversationId: row.conversation_id,
    actorId: row.actor_id,
    originNodeId: row.origin_node_id,
    class: row.class,
    body: row.body,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    threadConversationId: row.thread_conversation_id ?? undefined,
    mentions,
    attachments,
    speech: parseJson<MessageRecord["speech"]>(row.speech_json, undefined),
    audience: parseJson<MessageRecord["audience"]>(row.audience_json, undefined),
    visibility: row.visibility,
    policy: row.policy,
    createdAt: normalizeTimestampMs(row.created_at) ?? row.created_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  }) as MessageRecord;
}

function invocationRequestFromRow(row: InvocationRow): InvocationRequest {
  return canonicalRecord("invocation", {
    id: row.id,
    requesterId: row.requester_id,
    requesterNodeId: row.requester_node_id,
    targetAgentId: row.target_agent_id,
    targetNodeId: row.target_node_id ?? undefined,
    action: row.action,
    task: row.task,
    collaborationRecordId: row.collaboration_record_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    messageId: row.message_id ?? undefined,
    context: parseJson<Record<string, unknown> | undefined>(row.context_json, undefined),
    execution: parseJson<InvocationRequest["execution"]>(row.execution_json, undefined),
    executionResolution: parseJson<InvocationRequest["executionResolution"]>(
      row.execution_resolution_json,
      undefined,
    ),
    ensureAwake: row.ensure_awake === 1,
    stream: row.stream === 1,
    timeoutMs: row.timeout_ms ?? undefined,
    labels: parseJson<string[] | undefined>(row.labels_json, undefined),
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    createdAt: row.created_at,
  }) as InvocationRequest;
}

function flightRecordFromRow(row: FlightRow): FlightRecord {
  return canonicalRecord("flight", {
    id: row.id,
    invocationId: row.invocation_id,
    requesterId: row.requester_id,
    targetAgentId: row.target_agent_id,
    state: row.state,
    summary: row.summary ?? undefined,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    labels: parseJson<string[] | undefined>(row.labels_json, undefined),
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  }) as FlightRecord;
}

/** The drizzle deliveries select shape — camelCase columns. */
interface DeliveryProjectionRow {
  id: string;
  messageId: string | null;
  invocationId: string | null;
  targetId: string;
  targetNodeId: string | null;
  targetKind: DeliveryIntent["targetKind"];
  transport: DeliveryIntent["transport"];
  reason: DeliveryIntent["reason"];
  policy: DeliveryIntent["policy"];
  status: DeliveryIntent["status"];
  bindingId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  metadataJson: string | null;
}

function deliveryIntentFromRow(row: DeliveryProjectionRow): DeliveryIntent {
  return canonicalRecord("delivery", {
    id: row.id,
    messageId: row.messageId ?? undefined,
    invocationId: row.invocationId ?? undefined,
    targetId: row.targetId,
    targetNodeId: row.targetNodeId ?? undefined,
    targetKind: row.targetKind,
    transport: row.transport,
    reason: row.reason,
    policy: row.policy,
    status: row.status,
    bindingId: row.bindingId ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadataJson, undefined),
  }) as DeliveryIntent;
}

interface DeliveryAttemptProjectionRow {
  id: string;
  deliveryId: string;
  attempt: number;
  status: DeliveryAttempt["status"];
  error: string | null;
  externalRef: string | null;
  createdAt: number;
  metadataJson: string | null;
}

function deliveryAttemptFromRow(row: DeliveryAttemptProjectionRow): DeliveryAttempt {
  return canonicalRecord("deliveryAttempt", {
    id: row.id,
    deliveryId: row.deliveryId,
    attempt: row.attempt,
    status: row.status,
    error: row.error ?? undefined,
    externalRef: row.externalRef ?? undefined,
    createdAt: row.createdAt,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadataJson, undefined),
  }) as DeliveryAttempt;
}

function collaborationEventFromRow(row: CollaborationEventRow): CollaborationEvent {
  return canonicalRecord("collaborationEvent", {
    id: row.id,
    recordId: row.record_id,
    recordKind: row.record_kind as CollaborationEvent["recordKind"],
    kind: row.kind as CollaborationEvent["kind"],
    actorId: row.actor_id,
    summary: row.summary ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    at: row.created_at,
  }) as CollaborationEvent;
}

function buildCollaborationRecord(row: CollaborationRecordRow): CollaborationRecord {
  const detail = parseJson<Record<string, unknown>>(row.detail_json, {});
  const base = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary ?? undefined,
    createdById: row.created_by_id,
    ownerId: row.owner_id ?? undefined,
    nextMoveOwnerId: row.next_move_owner_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    priority: (row.priority ?? undefined) as CollaborationPriority | undefined,
    labels: parseJson<string[] | undefined>(row.labels_json, undefined),
    relations: parseJson<CollaborationRelation[] | undefined>(row.relations_json, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: (detail as { metadata?: Record<string, unknown> }).metadata,
  };

  const acceptanceState = row.acceptance_state as CollaborationRecord["acceptanceState"];

  // Reconstruct the correct record kind — hardcoding "work_item" here would silently
  // rewrite persisted questions as work items on read (data corruption).
  if (row.kind === "question") {
    return {
      ...base,
      kind: "question",
      state: row.state as QuestionState,
      acceptanceState,
      askedById: detail.askedById as string | undefined,
      answeredById: detail.answeredById as string | undefined,
      answer: detail.answer as string | undefined,
      answeredAt: detail.answeredAt as number | undefined,
      closedAt: detail.closedAt as number | undefined,
    };
  }

  return {
    ...base,
    kind: "work_item",
    state: row.state as WorkItemState,
    acceptanceState,
    requestedById: detail.requestedById as string | undefined,
    waitingOn: detail.waitingOn as CollaborationWaitingOn | undefined,
    progress: detail.progress as CollaborationProgress | undefined,
    startedAt: detail.startedAt as number | undefined,
    reviewRequestedAt: detail.reviewRequestedAt as number | undefined,
    completedAt: detail.completedAt as number | undefined,
  };
}

export class SQLiteControlPlaneStore {
  private readonly db: ControlPlaneSqliteDatabase;
  private readDb: ControlPlaneSqliteDatabase;
  private readonly drizzleDb: ReturnType<typeof openControlPlaneDrizzle>;
  private readonly drizzleReadDb: ReturnType<typeof openControlPlaneDrizzle>;
  private readonly persistEventsBatch: (events: ControlEvent[]) => void;
  private pendingEvents: ControlEvent[] = [];
  private flushPendingEventsTimer: ReturnType<typeof setTimeout> | null = null;
  private conversationsApi: ConversationsApi | null = null;
  private closed = false;
  private lastQuotaHistoryPruneAt = 0;
  private historyReader: ControlPlaneHistoryReader | null = null;
  private historyRelocation: ControlPlaneHistoryRelocation | null = null;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openControlPlaneSqliteDatabase(dbPath, { create: true });
    configureControlPlaneDatabase(this.db);
    migrateControlPlaneDatabaseSchema(this.db);
    ensureHistoryAnchorSchema(this.db);
    this.readDb = openControlPlaneSqliteDatabase(dbPath, { readonly: true });
    this.readDb.exec("PRAGMA busy_timeout = 5000;");
    this.readDb.exec("PRAGMA query_only = ON;");
    this.drizzleDb = openControlPlaneDrizzle(this.db);
    this.drizzleReadDb = openControlPlaneDrizzle(this.readDb);
    this.persistEventsBatch = (this.db as SQLiteTransactionalDatabase).transaction((events: ControlEvent[]) => {
      for (const event of events) this.recordEventDurably(event);
    });
  }

  configureHistory(directory: string): void {
    this.historyReader?.close();
    this.historyReader = new ControlPlaneHistoryReader(directory);
  }

  publishHistoryRotation(plan: HistoryRotationPlan, history: ControlPlaneHistoryStore) {
    return this.relocation().publish(plan, history);
  }

  removePublishedHistory(publication: HistoricalPublication | readonly HistoricalPublication[], allowed: HistoryRotationPlan, history: ControlPlaneHistoryStore) {
    return this.relocation().remove(publication, allowed, history);
  }

  private relocation(): ControlPlaneHistoryRelocation {
    if (this.historyRelocation) return this.historyRelocation;
    const read: HistoricalTypedReader = (kind, ids) => {
      switch (kind) {
        case "message": return this.readMessages(ids);
        case "invocation": return this.readInvocations(ids);
        case "flight": return this.readFlights(ids);
        case "delivery": return this.readDeliveries(ids);
        case "delivery_attempt": return this.readDeliveryAttempts(ids);
        case "collaboration_event": return this.readCollaborationEvents(ids);
      }
    };
    return this.historyRelocation = new ControlPlaneHistoryRelocation(this.db, read);
  }

  readArchivedMessage(id: string): MessageRecord | undefined { return this.anchoredRecord<MessageRecord>("message", id); }

  private anchoredRecord<T>(kind: string, id: string): T | undefined {
    const anchor = this.readDb.query<{ location_json: string }>("SELECT location_json FROM broker_history_anchors WHERE kind=?1 AND id=?2").get(kind, id);
    if (!anchor) return undefined;
    if (!this.historyReader) throw new Error("historical reader not configured for archived anchor");
    return this.historyReader.readLocation<T>(JSON.parse(anchor.location_json) as HistoricalRecordLocation);
  }

  private historicalFallback<T>(kind: string, ids: readonly string[], found: Map<string, T>): Map<string, T> {
    for (const id of ids) {
      const anchored = this.anchoredRecord<T>(kind, id);
      if (anchored !== undefined) { found.set(id, anchored); continue; }
      if (found.has(id) || !this.historyReader) continue;
      const historical = this.historyReader.read<T>(kind, id);
      if (historical !== undefined) found.set(id, historical);
    }
    return found;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  listRuntimeSessions(options: {
    agentId?: string;
    endpointId?: string;
    sessionId?: string;
    includeExpired?: boolean;
    now?: number;
    limit?: number;
  } = {}): RuntimeSessionIndexRecord[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    if (options.agentId) {
      predicates.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options.endpointId) {
      predicates.push("endpoint_id = ?");
      params.push(options.endpointId);
    }
    if (options.sessionId) {
      predicates.push("id = ?");
      params.push(options.sessionId);
    }
    if (!options.includeExpired) {
      predicates.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(options.now ?? currentTimestampMs());
    }
    const limit = normalizedListLimit(options.limit, 100, 1000);
    params.push(limit);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    return queryAllDynamic<RuntimeSessionRow>(
      this.readDb,
      `SELECT *
       FROM runtime_sessions
       ${where}
       ORDER BY last_seen_at DESC, updated_at DESC, id ASC
       LIMIT ?`,
      params,
    ).map(runtimeSessionFromRow);
  }

  listRuntimeSessionAliases(options: {
    alias?: string;
    sessionId?: string;
    includeExpired?: boolean;
    now?: number;
    limit?: number;
  } = {}): RuntimeSessionAliasRecord[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    if (options.alias) {
      predicates.push("alias = ?");
      params.push(options.alias);
    }
    if (options.sessionId) {
      predicates.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (!options.includeExpired) {
      predicates.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(options.now ?? currentTimestampMs());
    }
    const limit = normalizedListLimit(options.limit, 100, 1000);
    params.push(limit);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    return queryAllDynamic<RuntimeSessionAliasRow>(
      this.readDb,
      `SELECT *
       FROM runtime_session_aliases
       ${where}
       ORDER BY last_seen_at DESC, alias ASC, session_id ASC
       LIMIT ?`,
      params,
    ).map(runtimeSessionAliasFromRow);
  }

  resolveRuntimeSessionAlias(alias: string, options: {
    includeExpired?: boolean;
    now?: number;
    limit?: number;
  } = {}): RuntimeSessionIndexRecord[] {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) {
      return [];
    }
    const predicates = ["a.alias = ?"];
    const params: SQLiteBinding[] = [trimmedAlias];
    if (!options.includeExpired) {
      const now = options.now ?? currentTimestampMs();
      predicates.push("(a.expires_at IS NULL OR a.expires_at > ?)");
      params.push(now);
      predicates.push("(s.expires_at IS NULL OR s.expires_at > ?)");
      params.push(now);
    }
    const limit = normalizedListLimit(options.limit, 20, 100);
    params.push(limit);
    return queryAllDynamic<RuntimeSessionRow>(
      this.readDb,
      `SELECT s.*
       FROM runtime_session_aliases a
       JOIN runtime_sessions s ON s.id = a.session_id
       WHERE ${predicates.join(" AND ")}
       ORDER BY a.last_seen_at DESC, s.updated_at DESC, s.id ASC
       LIMIT ?`,
      params,
    ).map(runtimeSessionFromRow);
  }

  // Terminal session registry.
  // A stable harness session (identity) owning N disposable terminal surfaces
  // (tmux/zellij/future). Re-intaking the same harness session updates one
  // record. Surface merge/append policy is the caller's concern (intake);
  // this store persists the record faithfully.

  upsertTerminalSession(input: TerminalSessionRecordInput): TerminalSessionRecord {
    const id = input.id?.trim() || terminalSessionRegistryId(input.harness, input.sourceSessionId);
    const now = currentTimestampMs();
    const surfacesJson = JSON.stringify(input.surfaces ?? []);
    const metadataJson = stringify(input.metadata);
    this.db.query(
      `INSERT INTO terminal_session_registry (
         id, harness, source_session_id, cwd, resume_command, surfaces_json, metadata_json, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         harness = excluded.harness,
         source_session_id = excluded.source_session_id,
         cwd = excluded.cwd,
         resume_command = excluded.resume_command,
         surfaces_json = excluded.surfaces_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(id, input.harness, input.sourceSessionId, input.cwd, input.resumeCommand, surfacesJson, metadataJson, now, now);
    const record = this.getTerminalSession(id);
    if (!record) {
      throw new Error(`failed to persist terminal session registry record ${id}`);
    }
    return record;
  }

  getTerminalSession(id: string): TerminalSessionRecord | null {
    const row = queryGet<TerminalSessionRow, [string]>(
      this.readDb,
      "SELECT * FROM terminal_session_registry WHERE id = ?1",
      id,
    );
    return row ? terminalSessionFromRow(row) : null;
  }

  listTerminalSessions(options: {
    harness?: string;
    sourceSessionId?: string;
    backend?: TerminalSurface["backend"];
    limit?: number;
  } = {}): TerminalSessionRecord[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    if (options.harness) {
      predicates.push("harness = ?");
      params.push(options.harness);
    }
    if (options.sourceSessionId) {
      predicates.push("source_session_id = ?");
      params.push(options.sourceSessionId);
    }
    const limit = normalizedListLimit(options.limit, 100, 1000);
    params.push(limit);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    const records = queryAllDynamic<TerminalSessionRow>(
      this.readDb,
      `SELECT *
       FROM terminal_session_registry
       ${where}
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      params,
    ).map(terminalSessionFromRow);
    if (!options.backend) {
      return records;
    }
    return records.filter((record) =>
      record.surfaces.some((surface) => surface.backend === options.backend),
    );
  }

  // Durable terminal workspaces.
  // A named arrangement of agent-CLI tiles. Cells carry the intent needed to
  // re-materialize them, so a workspace can be rebuilt after a reboot rather
  // than reopening onto a grid of dead session names.

  upsertTerminalWorkspace(input: TerminalWorkspaceRecordInput): TerminalWorkspaceRecord {
    const id = input.id?.trim() || `tw.${stableHash(`${input.name}${currentTimestampMs()}`)}`;
    const now = currentTimestampMs();
    this.db.query(
      `INSERT INTO terminal_workspaces (
         id, name, purpose, columns_count, layout_json, cells_json, metadata_json, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         purpose = excluded.purpose,
         columns_count = excluded.columns_count,
         layout_json = excluded.layout_json,
         cells_json = excluded.cells_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      input.name,
      input.purpose ?? "",
      normalizeTerminalWorkspaceColumns(input.columns),
      // The authored shape, which the resolved column count cannot stand in
      // for: "dynamic" comes back pinned to a number, and a lanes workspace
      // wider than the column clamp comes back a grid.
      input.layout === undefined ? null : JSON.stringify(input.layout),
      JSON.stringify(input.cells ?? []),
      stringify(input.metadata),
      now,
      now,
    );
    const record = this.getTerminalWorkspace(id);
    if (!record) {
      throw new Error(`failed to persist terminal workspace ${id}`);
    }
    return record;
  }

  getTerminalWorkspace(id: string): TerminalWorkspaceRecord | null {
    const row = queryGet<TerminalWorkspaceRow, [string]>(
      this.readDb,
      "SELECT * FROM terminal_workspaces WHERE id = ?1",
      id,
    );
    return row ? terminalWorkspaceFromRow(row) : null;
  }

  listTerminalWorkspaces(options: { limit?: number } = {}): TerminalWorkspaceRecord[] {
    const limit = normalizedListLimit(options.limit, 100, 1000);
    return queryAllDynamic<TerminalWorkspaceRow>(
      this.readDb,
      `SELECT *
       FROM terminal_workspaces
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      [limit],
    ).map(terminalWorkspaceFromRow);
  }

  deleteTerminalWorkspace(id: string): boolean {
    const result = this.db.query("DELETE FROM terminal_workspaces WHERE id = ?1").run(id) as {
      changes?: number;
    };
    return (result.changes ?? 0) > 0;
  }

  pruneExpiredRuntimeSessions(now = currentTimestampMs()): { aliasesDeleted: number; sessionsDeleted: number } {
    const aliasesResult = this.db.query(
      "DELETE FROM runtime_session_aliases WHERE expires_at IS NOT NULL AND expires_at <= ?1",
    ).run(now) as { changes?: number };
    const sessionsResult = this.db.query(
      "DELETE FROM runtime_sessions WHERE expires_at IS NOT NULL AND expires_at <= ?1",
    ).run(now) as { changes?: number };
    return {
      aliasesDeleted: aliasesResult.changes ?? 0,
      sessionsDeleted: sessionsResult.changes ?? 0,
    };
  }

  /**
   * Re-homes historical references from volatile collision-suffixed node rows
   * (e.g. `arachs-mac-mini-292-local-openscout` -> `arachs-mac-mini-local-openscout`)
   * to their canonical stable node IDs and prunes the stale ghost node rows.
   */
  compactAndPruneMeshNodes(options: {
    localNodeId?: string;
    now?: number;
    maxStaleAgeMs?: number;
  } = {}): {
    rehomedNodeCount: number;
    prunedNodeCount: number;
    rehomedMappings: Array<{ from: string; to: string }>;
  } {
    const now = options.now ?? currentTimestampMs();
    const maxStaleAgeMs = options.maxStaleAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const staleCutoff = now - maxStaleAgeMs;

    const nodeRows = this.db.query("SELECT * FROM nodes").all() as NodeRow[];
    const peerRows = this.db.query("SELECT * FROM trusted_peers").all() as TrustedPeerRow[];

    const rehomedMappings: Array<{ from: string; to: string }> = [];
    const rehomeMap = new Map<string, { to: string; candidateRow: NodeRow }>();

    for (const row of nodeRows) {
      const canonicalId = canonicalMeshNodeId(row.id);
      if (canonicalId && canonicalId !== row.id) {
        rehomeMap.set(row.id, { to: canonicalId, candidateRow: row });
      }
    }

    let rehomedNodeCount = 0;
    let prunedNodeCount = 0;

    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      // Step 1: Ensure canonical targets exist with newest metadata
      for (const [staleId, { to: canonicalId, candidateRow }] of rehomeMap.entries()) {
        const existingCanonical = nodeRows.find((r) => r.id === canonicalId);
        if (!existingCanonical) {
          this.db.query(
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
            candidateRow.mesh_id,
            stripBonjourCollisionSuffix(candidateRow.name) || candidateRow.name,
            stripBonjourCollisionSuffix(candidateRow.host_name ?? "") || (candidateRow.host_name ?? null),
            candidateRow.advertise_scope,
            candidateRow.broker_url ?? null,
            candidateRow.tailnet_name ?? null,
            candidateRow.capabilities_json ?? null,
            candidateRow.labels_json ?? null,
            candidateRow.metadata_json ?? null,
            candidateRow.last_seen_at ?? null,
            candidateRow.registered_at,
          );
        } else {
          this.db.query(
            `UPDATE nodes SET
              last_seen_at = MAX(COALESCE(last_seen_at, 0), COALESCE(?1, 0)),
              broker_url = COALESCE(?2, broker_url)
             WHERE id = ?3`,
          ).run(candidateRow.last_seen_at ?? null, candidateRow.broker_url ?? null, canonicalId);
        }

        // Step 2: Re-home foreign key references across all referencing tables
        this.db.query("UPDATE agents SET home_node_id = ?1 WHERE home_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE agents SET authority_node_id = ?1 WHERE authority_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE agent_endpoints SET node_id = ?1 WHERE node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE runtime_sessions SET node_id = ?1 WHERE node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE runtime_session_aliases SET node_id = ?1 WHERE node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE conversations SET authority_node_id = ?1 WHERE authority_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE conversation_read_cursors SET reader_node_id = ?1 WHERE reader_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE messages SET origin_node_id = ?1 WHERE origin_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE deliveries SET target_node_id = ?1 WHERE target_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE invocations SET requester_node_id = ?1 WHERE requester_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE invocations SET target_node_id = ?1 WHERE target_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE thread_events SET authority_node_id = ?1 WHERE authority_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE thread_cursors SET authority_node_id = ?1 WHERE authority_node_id = ?2").run(canonicalId, staleId);
        this.db.query("UPDATE trusted_peers SET node_id = ?1 WHERE node_id = ?2").run(canonicalId, staleId);

        // Step 3: Delete stale ghost node row
        const delRes = this.db.query("DELETE FROM nodes WHERE id = ?1").run(staleId) as { changes?: number };
        if ((delRes.changes ?? 0) > 0) {
          prunedNodeCount++;
          rehomedNodeCount++;
          rehomedMappings.push({ from: staleId, to: canonicalId });
        }
      }

      // Step 3b: Ensure any trusted peers with collision-suffixed node_id are canonicalized
      for (const peer of peerRows) {
        if (peer.node_id) {
          const canonical = canonicalMeshNodeId(peer.node_id);
          if (canonical && canonical !== peer.node_id) {
            this.db.query("UPDATE trusted_peers SET node_id = ?1 WHERE key_id = ?2").run(canonical, peer.key_id);
          }
        }
      }

      // Step 4: Prune any remaining disconnected stale nodes that have 0 references across all tables
      const remainingNodes = this.db.query("SELECT * FROM nodes").all() as NodeRow[];
      for (const row of remainingNodes) {
        if (row.id === options.localNodeId) continue;
        const lastActive = row.last_seen_at ?? row.registered_at;
        if (lastActive > staleCutoff) continue;
        const isTrusted = peerRows.some((p) => p.node_id === row.id);
        if (isTrusted) continue;

        try {
          const delRes = this.db.query("DELETE FROM nodes WHERE id = ?1").run(row.id) as { changes?: number };
          if ((delRes.changes ?? 0) > 0) {
            prunedNodeCount++;
          }
        } catch {
          // Foreign key constraint failure means it has active references; leave it safe
        }
      }
    })();

    return {
      rehomedNodeCount,
      prunedNodeCount,
      rehomedMappings,
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.flushPendingEvents();
    if (this.flushPendingEventsTimer) {
      clearTimeout(this.flushPendingEventsTimer);
      this.flushPendingEventsTimer = null;
    }
    this.historyReader?.close();
    this.readDb.close?.();
    this.db.close?.();
  }

  private flushPendingEvents(): void {
    if (this.pendingEvents.length === 0) {
      return;
    }

    const nextBatch = this.pendingEvents;
    this.pendingEvents = [];
    try {
      this.persistEventsBatch(nextBatch);
    } catch (error) {
      // Preserve FIFO order when another writer temporarily owns SQLite. New
      // arrivals belong after this failed batch, never ahead of or instead of it.
      this.pendingEvents = [...nextBatch, ...this.pendingEvents];
      throw error;
    }
  }

  private schedulePendingEventFlush(delayMs = 0): void {
    if (this.flushPendingEventsTimer) {
      return;
    }

    this.flushPendingEventsTimer = setTimeout(() => {
      this.flushPendingEventsTimer = null;
      try {
        this.flushPendingEvents();
      } catch (error) {
        if (isTransientSqliteBusyError(error)) {
          this.schedulePendingEventFlush(PENDING_EVENT_BUSY_RETRY_MS);
          return;
        }
        throw error;
      }
    }, delayMs);
    this.flushPendingEventsTimer.unref?.();
  }

  loadSnapshot(): RuntimeRegistrySnapshot {
    const snapshot = createRuntimeRegistrySnapshot();

    const nodes = queryAll<NodeRow>(this.readDb, "SELECT * FROM nodes");
    for (const row of nodes) {
      snapshot.nodes[row.id] = {
        id: row.id,
        meshId: row.mesh_id,
        name: row.name,
        hostName: row.host_name ?? undefined,
        advertiseScope: row.advertise_scope,
        brokerUrl: row.broker_url ?? undefined,
        tailnetName: row.tailnet_name ?? undefined,
        capabilities: parseJson<string[]>(row.capabilities_json, []),
        labels: parseJson<string[]>(row.labels_json, []),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
        lastSeenAt: row.last_seen_at ?? undefined,
        registeredAt: row.registered_at,
      };
    }

    const actors = queryAll<ActorRow>(this.readDb, "SELECT * FROM actors");
    for (const row of actors) {
      snapshot.actors[row.id] = {
        id: row.id,
        kind: row.kind,
        displayName: row.display_name,
        handle: row.handle ?? undefined,
        labels: parseJson<string[] | undefined>(row.labels_json, undefined),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
        createdAt: row.created_at,
      };
    }

    const agents = queryAll<AgentRow>(this.readDb, "SELECT * FROM agents");
    for (const row of agents) {
      const actor = snapshot.actors[row.id];
      if (!actor) continue;

      snapshot.agents[row.id] = {
        ...actor,
        kind: "agent",
        definitionId: row.definition_id,
        nodeQualifier: row.node_qualifier ?? undefined,
        workspaceQualifier: row.workspace_qualifier ?? undefined,
        selector: row.selector ?? undefined,
        defaultSelector: row.default_selector ?? undefined,
        agentClass: row.agent_class,
        capabilities: parseJson<AgentDefinition["capabilities"]>(row.capabilities_json, []),
        wakePolicy: row.wake_policy,
        homeNodeId: row.home_node_id,
        authorityNodeId: row.authority_node_id,
        advertiseScope: row.advertise_scope,
        ownerId: row.owner_id ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, actor.metadata),
      };
    }

    const endpoints = queryAll<EndpointRow>(this.readDb, "SELECT * FROM agent_endpoints");
    for (const row of endpoints) {
      snapshot.endpoints[row.id] = {
        id: row.id,
        agentId: row.agent_id,
        nodeId: row.node_id,
        harness: row.harness,
        transport: row.transport,
        state: row.state,
        address: row.address ?? undefined,
        sessionId: row.session_id ?? undefined,
        pane: row.pane ?? undefined,
        cwd: row.cwd ?? undefined,
        projectRoot: row.project_root ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
    }

    const conversations = queryAll<ConversationRow>(this.readDb, "SELECT * FROM conversations");
    const members = queryAll<{ conversation_id: string; actor_id: string }>(
      this.readDb,
      "SELECT conversation_id, actor_id FROM conversation_members",
    );
    const memberMap = new Map<string, string[]>();
    for (const row of members) {
      const list = memberMap.get(row.conversation_id) ?? [];
      list.push(row.actor_id);
      memberMap.set(row.conversation_id, list);
    }
    for (const row of conversations) {
      snapshot.conversations[row.id] = {
        id: row.id,
        kind: row.kind,
        title: row.title,
        visibility: row.visibility,
        shareMode: row.share_mode,
        authorityNodeId: row.authority_node_id,
        participantIds: memberMap.get(row.id) ?? [],
        topic: row.topic ?? undefined,
        parentConversationId: row.parent_conversation_id ?? undefined,
        messageId: row.message_id ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
    }

    const bindings = queryAll<BindingRow>(this.readDb, "SELECT * FROM bindings");
    for (const row of bindings) {
      snapshot.bindings[row.id] = {
        id: row.id,
        conversationId: row.conversation_id,
        platform: row.platform,
        mode: row.mode,
        externalChannelId: row.external_channel_id,
        externalThreadId: row.external_thread_id ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
    }

    const messages = queryAll<MessageRow>(this.readDb, "SELECT * FROM messages WHERE NOT EXISTS (SELECT 1 FROM broker_history_anchors h WHERE h.kind='message' AND h.id=messages.id)");
    const mentionRows = queryAll<MentionRow>(
      this.readDb,
      "SELECT * FROM message_mentions ORDER BY message_id, actor_id",
    );
    const attachmentRows = queryAll<AttachmentRow>(
      this.readDb,
      "SELECT * FROM message_attachments ORDER BY message_id, id",
    );
    const mentionsByMessage = new Map<string, MessageMention[]>();
    const attachmentsByMessage = new Map<string, MessageAttachment[]>();

    for (const row of mentionRows) {
      const list = mentionsByMessage.get(row.message_id) ?? [];
      list.push({ actorId: row.actor_id, label: row.label ?? undefined });
      mentionsByMessage.set(row.message_id, list);
    }
    for (const row of attachmentRows) {
      const list = attachmentsByMessage.get(row.message_id) ?? [];
      list.push({
        id: row.id,
        mediaType: row.media_type,
        fileName: row.file_name ?? undefined,
        blobKey: row.blob_key ?? undefined,
        url: row.url ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      });
      attachmentsByMessage.set(row.message_id, list);
    }

    for (const row of messages) {
      snapshot.messages[row.id] = messageRecordFromRow(
        row,
        mentionsByMessage.get(row.id),
        attachmentsByMessage.get(row.id),
      );
    }

    const readCursorRows = queryAll<ReadCursorRow>(this.readDb, "SELECT * FROM conversation_read_cursors");
    for (const row of readCursorRows) {
      const cursor: ConversationReadCursor = {
        conversationId: row.conversation_id,
        actorId: row.actor_id,
        readerNodeId: row.reader_node_id ?? undefined,
        lastReadMessageId: row.last_read_message_id ?? undefined,
        lastReadSeq: row.last_read_seq ?? undefined,
        lastReadAt: row.last_read_at,
        updatedAt: row.updated_at,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
      snapshot.readCursors[`${cursor.conversationId}\u0000${cursor.actorId}`] = cursor;
    }

    const invocations = queryAll<InvocationRow>(this.readDb, "SELECT * FROM invocations WHERE NOT EXISTS (SELECT 1 FROM broker_history_anchors h WHERE h.kind='invocation' AND h.id=invocations.id)");
    for (const row of invocations) {
      snapshot.invocations[row.id] = invocationRequestFromRow(row);
    }

    const flights = queryAll<FlightRow>(this.readDb, "SELECT * FROM flights");
    for (const row of flights) {
      snapshot.flights[row.id] = flightRecordFromRow(row);
    }

    const collaborationRows = queryAll<CollaborationRecordRow>(
      this.readDb,
      "SELECT * FROM collaboration_records",
    );
    for (const row of collaborationRows) {
      snapshot.collaborationRecords[row.id] = buildCollaborationRecord(row);
    }

    return snapshot;
  }

  recentEvents(limit = 100): ControlEvent[] {
    this.flushPendingEvents();
    const rows = queryAll<EventRow, [number]>(
      this.readDb,
      "SELECT * FROM events ORDER BY ts DESC LIMIT ?1",
      limit,
    ).reverse();

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      actorId: row.actor_id,
      nodeId: row.node_id ?? undefined,
      ts: row.ts,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    })) as ControlEvent[];
  }

  latestThreadSeq(conversationId: string): number {
    const row = queryGet<{ max_seq: number | null }, [string]>(
      this.readDb,
      "SELECT MAX(seq) AS max_seq FROM thread_events WHERE conversation_id = ?1",
      conversationId,
    );
    return row?.max_seq ?? 0;
  }

  oldestThreadSeq(conversationId: string): number {
    const row = queryGet<{ seq: number }, [string]>(
      this.readDb,
      "SELECT seq FROM thread_events WHERE conversation_id = ?1 ORDER BY seq ASC LIMIT 1",
      conversationId,
    );
    return row?.seq ?? 0;
  }

  listThreadEvents(options: {
    conversationId: string;
    afterSeq?: number;
    limit?: number;
  }): ThreadEventEnvelope[] {
    const rows = queryAll<ThreadEventRow, [string, number, number]>(
      this.readDb,
      `SELECT *
      FROM thread_events
      WHERE conversation_id = ?1 AND seq > ?2
      ORDER BY seq ASC
      LIMIT ?3`,
      options.conversationId,
      options.afterSeq ?? 0,
      options.limit ?? 500,
    );

    return rows.map((row) => this.buildThreadEvent(row));
  }

  getThreadSnapshot(conversationId: string): ThreadSnapshot | null {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    return {
      conversation,
      latestSeq: this.latestThreadSeq(conversationId),
      messages: this.listConversationThreadMessages(conversation),
      collaboration: this.listConversationThreadCollaboration(conversation),
      activeFlights: this.listConversationThreadFlights(conversation),
    };
  }

  /**
   * Read the bounded newest page used by the native launch cache directly
   * from indexed canonical tables. This deliberately avoids `loadSnapshot()`,
   * whose whole-database scan is appropriate for compatibility snapshots but
   * would put unrelated control-plane state back on the launch path.
   */
  getConversationThreadLaunchSnapshot(options: {
    conversationId: string;
    projectionId: string;
    projectionVersion: number;
    sequence: number;
    limit?: number;
    generatedAt?: number;
    /** Internal native artifact input only; ordinary thread/history reads stay full. */
    nativePreview?: boolean;
  }): ConversationThreadLaunchSnapshot | null {
    const conversation = this.getConversation(options.conversationId, this.readDb);
    if (!conversation) {
      return null;
    }

    const requestedLimit = Math.floor(options.limit ?? 64);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(64, requestedLimit))
      : 64;
    // JSON escaping can only expand UTF-8 bytes. Four guard bytes keep any
    // partial final UTF-8 code point beyond the artifact's possible body budget.
    // Slice as BLOB so the bound is bytes and embedded NUL does not stop it;
    // the empty BLOB substring needs an explicit empty-text fallback.
    // Only disposable preview input is shortened; stored/history bodies stay full.
    const bodyColumn = options.nativePreview
      ? `COALESCE(CAST(substr(CAST(m.body AS BLOB), 1, ${NATIVE_READ_THREAD_MAX_MESSAGE_BYTES + 4}) AS TEXT), '')`
      : "m.body";
    const rows = queryAll<ConversationThreadLaunchMessageRow, [string, number]>(
      this.readDb,
      `SELECT
        m.id,
        m.actor_id,
        a.display_name AS actor_name,
        ${bodyColumn} AS body,
        m.class,
        m.created_at
      FROM messages m
      LEFT JOIN actors a ON a.id = m.actor_id
      WHERE m.conversation_id = ?1
      ORDER BY CASE
        WHEN m.created_at > 0 AND m.created_at < ${EPOCH_MILLISECONDS_FLOOR}
          THEN m.created_at * 1000
        ELSE m.created_at
      END DESC, m.id DESC
      LIMIT ?2`,
      options.conversationId,
      limit + 1,
    );
    const hasEarlier = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    for (const row of page) {
      const historical = this.anchoredRecord<MessageRecord>("message", row.id);
      if (historical) row.body = options.nativePreview
        ? Buffer.from(historical.body).subarray(0, NATIVE_READ_THREAD_MAX_MESSAGE_BYTES + 4).toString("utf8")
        : historical.body;
    }

    return {
      projectionId: options.projectionId,
      projectionVersion: options.projectionVersion,
      sequence: options.sequence,
      feedId: scoutConversationFeedId(options.conversationId),
      entityKind: "scout_conversation",
      conversationId: options.conversationId,
      cursor: page[0]?.id ?? null,
      hasEarlier,
      generatedAt: options.generatedAt ?? currentTimestampMs(),
      messages: page.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorName: row.actor_name,
        body: row.body,
        class: row.class,
        createdAt: row.created_at,
      })),
    };
  }

  upsertThreadCursor(
    conversationId: string,
    authorityNodeId: string,
    lastAppliedSeq: number,
    updatedAt: number,
  ): void {
    this.db.query(
      `INSERT INTO thread_cursors (
        conversation_id, authority_node_id, last_applied_seq, updated_at
      ) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(conversation_id, authority_node_id) DO UPDATE SET
        last_applied_seq = excluded.last_applied_seq,
        updated_at = excluded.updated_at`,
    ).run(
      conversationId,
      authorityNodeId,
      lastAppliedSeq,
      updatedAt,
    );
  }

  getThreadCursor(conversationId: string, authorityNodeId: string): {
    conversationId: string;
    authorityNodeId: string;
    lastAppliedSeq: number;
    updatedAt: number;
  } | null {
    const row = queryGet<ThreadCursorRow, [string, string]>(
      this.readDb,
      `SELECT *
      FROM thread_cursors
      WHERE conversation_id = ?1 AND authority_node_id = ?2
      LIMIT 1`,
      conversationId,
      authorityNodeId,
    );

    if (!row) {
      return null;
    }

    return {
      conversationId: row.conversation_id,
      authorityNodeId: row.authority_node_id,
      lastAppliedSeq: row.last_applied_seq,
      updatedAt: row.updated_at,
    };
  }

  upsertNode(node: NodeDefinition): void {
    this.db.query(
      `INSERT INTO nodes (
        id, mesh_id, name, host_name, advertise_scope, broker_url, tailnet_name,
        capabilities_json, labels_json, metadata_json, last_seen_at, registered_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT(id) DO UPDATE SET
        mesh_id = excluded.mesh_id,
        name = excluded.name,
        host_name = excluded.host_name,
        advertise_scope = excluded.advertise_scope,
        broker_url = excluded.broker_url,
        tailnet_name = excluded.tailnet_name,
        capabilities_json = excluded.capabilities_json,
        labels_json = excluded.labels_json,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at,
        registered_at = excluded.registered_at`,
    ).run(
      node.id,
      node.meshId,
      node.name,
      node.hostName ?? null,
      node.advertiseScope,
      node.brokerUrl ?? null,
      node.tailnetName ?? null,
      stringify(node.capabilities),
      stringify(node.labels),
      stringify(node.metadata),
      node.lastSeenAt ?? null,
      node.registeredAt,
    );
  }

  /* ── Machines (see @openscout/protocol machines.ts) ── */

  upsertMachine(machine: MachineRecord): void {
    this.db.query(
      `INSERT INTO machines (
        id, display_name, name, platform, identity_keys_json, is_self,
        scout_node_id, mesh_id, tailnet_id, tailnet_name, host_names_json,
        addresses_json, mac_addresses_json, capabilities_json, routes_json,
        evidence_json, pinned, notes, metadata_json, first_seen_at, last_seen_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        name = excluded.name,
        platform = excluded.platform,
        identity_keys_json = excluded.identity_keys_json,
        is_self = excluded.is_self,
        scout_node_id = excluded.scout_node_id,
        mesh_id = excluded.mesh_id,
        tailnet_id = excluded.tailnet_id,
        tailnet_name = excluded.tailnet_name,
        host_names_json = excluded.host_names_json,
        addresses_json = excluded.addresses_json,
        mac_addresses_json = excluded.mac_addresses_json,
        capabilities_json = excluded.capabilities_json,
        routes_json = excluded.routes_json,
        evidence_json = excluded.evidence_json,
        pinned = excluded.pinned,
        notes = excluded.notes,
        metadata_json = excluded.metadata_json,
        -- A rebuild must never move first-seen forward: the operator's answer
        -- to "how long have I known this machine" is the earliest sighting.
        first_seen_at = MIN(machines.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(machines.last_seen_at, excluded.last_seen_at)`,
    ).run(
      machine.id,
      machine.displayName ?? null,
      machine.name,
      machine.platform,
      JSON.stringify(machine.identityKeys),
      machine.isSelf ? 1 : 0,
      machine.scoutNodeId ?? null,
      machine.meshId ?? null,
      machine.tailnetId ?? null,
      machine.tailnetName ?? null,
      JSON.stringify(machine.hostNames),
      JSON.stringify(machine.addresses),
      JSON.stringify(machine.macAddresses),
      JSON.stringify(machine.capabilities),
      JSON.stringify(machine.routes),
      JSON.stringify(machine.evidence),
      machine.pinned ? 1 : 0,
      machine.notes ?? null,
      stringify(machine.metadata),
      machine.firstSeenAt,
      machine.lastSeenAt,
    );
  }

  listMachines(): MachineRecord[] {
    const rows = queryAll<MachineRow>(
      this.readDb,
      "SELECT * FROM machines ORDER BY is_self DESC, last_seen_at DESC",
    );
    return rows.map(machineFromRow);
  }

  machine(id: string): MachineRecord | undefined {
    const row = queryGet<MachineRow, [string]>(
      this.readDb,
      "SELECT * FROM machines WHERE id = ?1 LIMIT 1",
      id,
    );
    return row ? machineFromRow(row) : undefined;
  }

  deleteMachine(id: string): boolean {
    const result = this.db.query("DELETE FROM machines WHERE id = ?1").run(id) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  /**
   * The operator-owned fields, and only those. Everything else on a machine is
   * derived from evidence and would be overwritten by the next inventory pass,
   * so exposing it here would be an edit that silently reverts.
   */
  updateMachineAnnotations(
    id: string,
    input: { displayName?: string | null; notes?: string | null; pinned?: boolean },
  ): MachineRecord | undefined {
    const assignments: string[] = [];
    const params: SQLiteBinding[] = [id];
    const bind = (column: string, value: SQLiteBinding): void => {
      params.push(value);
      assignments.push(`${column} = ?${params.length}`);
    };

    if (input.displayName !== undefined) bind("display_name", input.displayName?.trim() || null);
    if (input.notes !== undefined) bind("notes", input.notes?.trim() || null);
    if (input.pinned !== undefined) bind("pinned", input.pinned ? 1 : 0);
    if (!assignments.length) return this.machine(id);

    this.db.query(`UPDATE machines SET ${assignments.join(", ")} WHERE id = ?1`).run(...params);
    return this.machine(id);
  }

  upsertTrustedPeer(peer: TrustedPeerRecord): void {
    for (const [table, column] of [["guest_grants", "key_id"], ["mesh_access_devices", "key_id"], ["mesh_access_principals", "principal_id"]]) {
      if (this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?1").get(table)
        && this.db.query(`SELECT ${column} FROM ${table} WHERE ${column}=?1 LIMIT 1`).get(peer.keyId)) {
        throw new Error("key_in_use: guest/scoped device/principal keys cannot become legacy mesh peers");
      }
    }
    this.db.query(
      `INSERT INTO trusted_peers (
        key_id, public_key, fingerprint, node_id, label, tier, granted_via,
        granted_at, expires_at, revoked_at, last_seen_at, metadata_json,
        tls_spki_fingerprint
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(key_id) DO UPDATE SET
        public_key = excluded.public_key,
        fingerprint = excluded.fingerprint,
        node_id = excluded.node_id,
        label = excluded.label,
        tier = excluded.tier,
        granted_via = excluded.granted_via,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at,
        last_seen_at = excluded.last_seen_at,
        metadata_json = excluded.metadata_json,
        -- §11.2 pin lifecycle: a tls-absent card/record NEVER clears or
        -- overwrites an existing pin — not on refresh, not on re-enrollment.
        tls_spki_fingerprint = COALESCE(excluded.tls_spki_fingerprint, trusted_peers.tls_spki_fingerprint)`,
    ).run(
      peer.keyId,
      peer.publicKey,
      peer.fingerprint,
      peer.nodeId ?? null,
      peer.label,
      peer.tier,
      peer.grantedVia,
      peer.grantedAt,
      peer.expiresAt ?? null,
      peer.revokedAt ?? null,
      peer.lastSeenAt ?? null,
      stringify(peer.metadata),
      peer.tlsSpkiFingerprint ?? null,
    );
  }

  /**
   * The peer's durable §11.2 TLS pin, when one has been stored. Reads the row
   * directly (no revocation/expiry filter — trust state is a separate check).
   */
  getTlsSpkiFingerprint(keyId: string): string | undefined {
    const row = queryGet<{ tls_spki_fingerprint: string | null }, [string]>(
      this.readDb,
      `SELECT tls_spki_fingerprint
      FROM trusted_peers
      WHERE key_id = ?1
      LIMIT 1`,
      keyId,
    );
    return row?.tls_spki_fingerprint ?? undefined;
  }

  /**
   * Store a peer's §11.2 TLS pin from a verified, well-formed card. The
   * never-clear rule is enforced here too (defense in depth): the pin can
   * only be written or replaced by another well-formed pin, never cleared.
   */
  setTlsSpkiFingerprint(keyId: string, spkiFingerprint: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(spkiFingerprint)) {
      throw new Error("tls pin must be exactly 64 lowercase hex chars (SHA-256 of the certificate's SPKI DER)");
    }
    const result = this.db.query(
      `UPDATE trusted_peers
      SET tls_spki_fingerprint = ?2
      WHERE key_id = ?1`,
    ).run(keyId, spkiFingerprint) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  knownTrustedPeerKey(keyId: string): boolean {
    return Boolean(this.db.query("SELECT key_id FROM trusted_peers WHERE key_id=?1").get(keyId));
  }

  trustedPeer(keyId: string): TrustedPeerRecord | undefined {
    const row = queryGet<TrustedPeerRow, [string, number]>(
      this.readDb,
      `SELECT *
      FROM trusted_peers
      WHERE key_id = ?1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?2)
      LIMIT 1`,
      keyId,
      currentTimestampMs(),
    );
    return row ? trustedPeerFromRow(row) : undefined;
  }

  listTrustedPeers(): TrustedPeerRecord[] {
    const rows = queryAll<TrustedPeerRow, [number]>(
      this.readDb,
      `SELECT *
      FROM trusted_peers
      WHERE revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?1)
      ORDER BY label ASC`,
      currentTimestampMs(),
    );
    return rows.map(trustedPeerFromRow);
  }

  revokeTrustedPeer(keyId: string, at: number): boolean {
    const result = this.db.query(
      `UPDATE trusted_peers
      SET revoked_at = ?2
      WHERE key_id = ?1 AND revoked_at IS NULL`,
    ).run(keyId, at) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  touchTrustedPeerLastSeen(keyId: string, at: number): void {
    this.db.query(
      `UPDATE trusted_peers
      SET last_seen_at = ?2
      WHERE key_id = ?1`,
    ).run(keyId, at);
  }

  // Durable replay protection (mesh-trust-cone §6): insert-before-execute.
  // The (peer_key_id, nonce) PK is the claim; a conflict means the nonce was
  // already seen. The expiry sweep rides the same transaction so a claimed
  // nonce can never race its own cleanup.
  claimPeerNonce(keyId: string, nonce: string, now: number, maxAgeMs: number): boolean {
    const claim = (this.db as SQLiteTransactionalDatabase).transaction(
      (): boolean => {
        this.db.query(
          `DELETE FROM peer_nonces
          WHERE peer_key_id = ?1 AND seen_at < ?2`,
        ).run(keyId, now - maxAgeMs);
        const result = this.db.query(
          `INSERT OR IGNORE INTO peer_nonces (peer_key_id, nonce, seen_at)
          VALUES (?1, ?2, ?3)`,
        ).run(keyId, nonce, now) as { changes?: number };
        return (result.changes ?? 0) > 0;
      },
    );
    return claim();
  }

  upsertActor(actor: RuntimeActorIdentity): void {
    this.db.query(
      `INSERT INTO actors (
        id, kind, display_name, handle, labels_json, metadata_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        display_name = excluded.display_name,
        handle = excluded.handle,
        labels_json = excluded.labels_json,
        metadata_json = excluded.metadata_json`,
    ).run(
      actor.id,
      actor.kind,
      actor.displayName,
      actor.handle ?? null,
      stringify(actor.labels),
      stringify(actor.metadata),
      // First insert wins — the ON CONFLICT clause deliberately omits
      // created_at so re-upserts and replays keep the original stamp.
      actor.createdAt ?? currentTimestampMs(),
    );
  }

  /** Membership preimage for delete journal entries — must be queried BEFORE
   * the actor/agents delete, since the member rows cascade away with it. */
  memberConversationIds(actorId: string): string[] {
    return (this.readDb.query(
      "SELECT conversation_id FROM conversation_members WHERE actor_id = ?1",
    ).all(actorId) as Array<{ conversation_id: string }>).map((row) => row.conversation_id);
  }

  /** First-registration timestamps for every actor — retention's age
   * fallback for rows journaled before `createdAt` rode the entries. */
  actorCreatedAtById(): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of this.readDb.query(
      "SELECT id, created_at FROM actors",
    ).all() as Array<{ id: string; created_at: number }>) {
      map.set(row.id, row.created_at);
    }
    return map;
  }

  upsertAgent(agent: AgentDefinition): void {
    this.db.query(
      `INSERT INTO agents (
        id, definition_id, node_qualifier, workspace_qualifier, selector, default_selector,
        agent_class, capabilities_json, wake_policy, home_node_id, authority_node_id,
        advertise_scope, owner_id, metadata_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(id) DO UPDATE SET
        definition_id = excluded.definition_id,
        node_qualifier = excluded.node_qualifier,
        workspace_qualifier = excluded.workspace_qualifier,
        selector = excluded.selector,
        default_selector = excluded.default_selector,
        agent_class = excluded.agent_class,
        capabilities_json = excluded.capabilities_json,
        wake_policy = excluded.wake_policy,
        home_node_id = excluded.home_node_id,
        authority_node_id = excluded.authority_node_id,
        advertise_scope = excluded.advertise_scope,
        owner_id = excluded.owner_id,
        metadata_json = excluded.metadata_json`,
    ).run(
      agent.id,
      agent.definitionId,
      agent.nodeQualifier ?? null,
      agent.workspaceQualifier ?? null,
      agent.selector ?? null,
      agent.defaultSelector ?? null,
      agent.agentClass,
      stringify(agent.capabilities),
      agent.wakePolicy,
      agent.homeNodeId,
      agent.authorityNodeId,
      agent.advertiseScope,
      agent.ownerId ?? null,
      stringify(agent.metadata),
    );
  }

  upsertEndpoint(endpoint: AgentEndpoint): void {
    // Projection replay is not a fresh observation. Prefer harness-owned
    // timestamps and preserve the prior projection time when the endpoint
    // record carries no observation evidence.
    const observedAt = endpointRuntimeSessionLastSeenAt(endpoint, 0);
    const insertedAt = currentTimestampMs();
    const persisted = this.db.query(
      `INSERT INTO agent_endpoints (
        id, agent_id, node_id, harness, transport, state, address, session_id, pane, cwd,
        project_root, metadata_json, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
        CASE WHEN ?13 > 0 THEN ?13 ELSE ?14 END
      )
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        node_id = excluded.node_id,
        harness = excluded.harness,
        transport = excluded.transport,
        state = excluded.state,
        address = excluded.address,
        session_id = excluded.session_id,
        pane = excluded.pane,
        cwd = excluded.cwd,
        project_root = excluded.project_root,
        metadata_json = excluded.metadata_json,
        updated_at = CASE
          WHEN ?13 > agent_endpoints.updated_at THEN ?13
          ELSE agent_endpoints.updated_at
        END
      RETURNING updated_at`,
    ).get(
      endpoint.id,
      endpoint.agentId,
      endpoint.nodeId,
      endpoint.harness,
      endpoint.transport,
      endpoint.state,
      endpoint.address ?? null,
      endpoint.sessionId ?? null,
      endpoint.pane ?? null,
      endpoint.cwd ?? null,
      endpoint.projectRoot ?? null,
      stringify(endpoint.metadata),
      observedAt,
      insertedAt,
    ) as { updated_at: number } | null;
    const persistedAt = persisted?.updated_at ?? (observedAt || insertedAt);

    this.projectRuntimeSessionForEndpoint(endpoint, persistedAt);
    this.recordEndpointBudgetObservations(endpoint);
  }

  deleteEndpoint(endpointId: string): void {
    this.db.query("DELETE FROM agent_endpoints WHERE id = ?1").run(endpointId);
  }

  /**
   * Remove an agent row and its endpoint rows. `agents.id` has no incoming
   * foreign keys — endpoint/agent rows reference `actors`, not `agents` — so
   * this cannot hit RESTRICT; the retention planner's rules are the gate.
   */
  deleteAgent(agentId: string): void {
    this.db.query("DELETE FROM agent_endpoints WHERE agent_id = ?1").run(agentId);
    this.db.query("DELETE FROM agents WHERE id = ?1").run(agentId);
  }

  /**
   * Remove an actor row. Every referencing table that RESTRICTs on actors
   * (messages, message_reactions, invocations, flights, collaboration_records,
   * collaboration_events) makes this throw loudly rather than silently cascade
   * — a throw here means the retention planner missed a reference.
   */
  deleteActor(actorId: string): void {
    this.db.query("DELETE FROM actors WHERE id = ?1").run(actorId);
  }

  /**
   * Authoritative structural references that keep an agent row live, mirroring
   * the registry-retention planner: any remaining endpoint row, a non-terminal
   * flight, or an invocation that lacks a terminal flight. Conversation
   * membership deliberately does not count — channels auto-enrol every agent,
   * so membership is not evidence of life. The sweep checks this before
   * journaling agent.delete so journal/snapshot drift cannot retire a
   * still-referenced agent.
   */
  agentReferenceCount(agentId: string): number {
    const terminal = "('completed','failed','cancelled')";
    const queries = [
      "SELECT count(*) AS n FROM agent_endpoints WHERE agent_id = ?1",
      `SELECT count(*) AS n FROM flights WHERE target_agent_id = ?1 AND state NOT IN ${terminal}`,
      `SELECT count(*) AS n FROM invocations i WHERE i.target_agent_id = ?1 AND NOT EXISTS (SELECT 1 FROM flights f WHERE f.invocation_id = i.id AND f.state IN ${terminal})`,
    ];
    let total = 0;
    for (const sql of queries) {
      const row = this.db.query(sql).get(agentId) as { n: number } | null;
      total += row?.n ?? 0;
    }
    return total;
  }

  /**
   * Authoritative references to an actor id: every ON DELETE RESTRICT foreign
   * key into actors, the collaboration ownership columns (SET NULL — silent
   * erasure otherwise), plus a surviving agents row and its endpoint rows
   * (both silently consumed by CASCADE otherwise). Conversation membership is
   * deliberately excluded — CASCADE drops roster rows, which is the desired
   * outcome for a dead agent. The sweep checks this before journaling
   * actor.delete; deleteActor still throws on a miss.
   */
  actorReferenceCount(actorId: string): number {
    const queries = [
      "SELECT count(*) AS n FROM agents WHERE id = ?1",
      "SELECT count(*) AS n FROM agent_endpoints WHERE agent_id = ?1",
      "SELECT count(*) AS n FROM messages WHERE actor_id = ?1",
      "SELECT count(*) AS n FROM message_reactions WHERE actor_id = ?1",
      "SELECT count(*) AS n FROM invocations WHERE requester_id = ?1 OR target_agent_id = ?1",
      "SELECT count(*) AS n FROM flights WHERE requester_id = ?1 OR target_agent_id = ?1",
      "SELECT count(*) AS n FROM collaboration_records WHERE created_by_id = ?1 OR owner_id = ?1 OR next_move_owner_id = ?1",
      "SELECT count(*) AS n FROM collaboration_events WHERE actor_id = ?1",
    ];
    let total = 0;
    for (const sql of queries) {
      const row = this.db.query(sql).get(actorId) as { n: number } | null;
      total += row?.n ?? 0;
    }
    return total;
  }

  private markRuntimeSessionsForEndpointEnded(
    endpointId: string,
    keepSessionId: string | null,
    observedAt: number,
  ): void {
    const expiresAt = observedAt + RUNTIME_SESSION_RETENTION_MS;
    if (keepSessionId) {
      this.db.query(
        `UPDATE runtime_sessions
         SET state = CASE WHEN state IN ('offline', 'superseded') THEN state ELSE 'superseded' END,
             ended_at = COALESCE(ended_at, ?1),
             expires_at = COALESCE(expires_at, ?2),
             updated_at = ?3
         WHERE endpoint_id = ?4 AND id != ?5`,
      ).run(observedAt, expiresAt, observedAt, endpointId, keepSessionId);
      this.db.query(
        `UPDATE runtime_session_aliases
         SET expires_at = COALESCE(expires_at, ?1),
             last_seen_at = CASE WHEN last_seen_at > ?2 THEN last_seen_at ELSE ?2 END
         WHERE endpoint_id = ?3 AND session_id != ?4`,
      ).run(expiresAt, observedAt, endpointId, keepSessionId);
      return;
    }

    this.db.query(
      `UPDATE runtime_sessions
       SET state = CASE WHEN state IN ('offline', 'superseded') THEN state ELSE 'superseded' END,
           ended_at = COALESCE(ended_at, ?1),
           expires_at = COALESCE(expires_at, ?2),
           updated_at = ?3
       WHERE endpoint_id = ?4`,
    ).run(observedAt, expiresAt, observedAt, endpointId);
    this.db.query(
      `UPDATE runtime_session_aliases
       SET expires_at = COALESCE(expires_at, ?1),
           last_seen_at = CASE WHEN last_seen_at > ?2 THEN last_seen_at ELSE ?2 END
       WHERE endpoint_id = ?3`,
    ).run(expiresAt, observedAt, endpointId);
  }

  private projectRuntimeSessionForEndpoint(endpoint: AgentEndpoint, observedAt: number): void {
    const primaryAlias = runtimeSessionPrimaryAlias(endpoint);
    if (!primaryAlias) {
      this.markRuntimeSessionsForEndpointEnded(endpoint.id, null, observedAt);
      return;
    }

    const sessionId = runtimeSessionHandleForEndpoint(endpoint, primaryAlias);
    if (!sessionId) {
      this.markRuntimeSessionsForEndpointEnded(endpoint.id, null, observedAt);
      return;
    }
    const lastSeenAt = endpointRuntimeSessionLastSeenAt(endpoint, observedAt);
    const startedAt = endpointRuntimeSessionStartedAt(endpoint, lastSeenAt);
    const terminal = endpointRuntimeSessionIsTerminal(endpoint);
    const endedAt = terminal ? lastSeenAt : null;
    const expiresAt = terminal ? lastSeenAt + RUNTIME_SESSION_RETENTION_MS : null;
    const aliases = endpointRuntimeSessionAliases(endpoint, sessionId);

    this.markRuntimeSessionsForEndpointEnded(endpoint.id, sessionId, lastSeenAt);
    this.db.query(
      `INSERT INTO runtime_sessions (
        id, agent_id, endpoint_id, node_id, harness, transport, state, primary_alias,
        external_session_id, cwd, project_root, started_at, last_seen_at, ended_at,
        expires_at, metadata_json, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        endpoint_id = excluded.endpoint_id,
        node_id = excluded.node_id,
        harness = excluded.harness,
        transport = excluded.transport,
        state = excluded.state,
        primary_alias = excluded.primary_alias,
        external_session_id = excluded.external_session_id,
        cwd = excluded.cwd,
        project_root = excluded.project_root,
        started_at = COALESCE(runtime_sessions.started_at, excluded.started_at),
        last_seen_at = CASE
          WHEN runtime_sessions.last_seen_at > excluded.last_seen_at THEN runtime_sessions.last_seen_at
          ELSE excluded.last_seen_at
        END,
        ended_at = excluded.ended_at,
        expires_at = excluded.expires_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    ).run(
      sessionId,
      endpoint.agentId,
      endpoint.id,
      endpoint.nodeId,
      endpoint.harness,
      endpoint.transport,
      terminal ? endpointRuntimeSessionState(endpoint) : endpoint.state,
      primaryAlias,
      endpointRuntimeSessionExternalId(endpoint),
      endpoint.cwd ?? null,
      endpoint.projectRoot ?? null,
      startedAt,
      lastSeenAt,
      endedAt,
      expiresAt,
      stringify(endpoint.metadata),
      observedAt,
    );

    this.upsertRuntimeSessionAliases(endpoint, sessionId, aliases, lastSeenAt, expiresAt);
  }

  private upsertRuntimeSessionAliases(
    endpoint: AgentEndpoint,
    sessionId: string,
    aliases: RuntimeSessionAliasInput[],
    lastSeenAt: number,
    expiresAt: number | null,
  ): void {
    for (const alias of aliases) {
      this.db.query(
        `INSERT INTO runtime_session_aliases (
          alias, session_id, alias_kind, agent_id, endpoint_id, node_id, harness, transport,
          first_seen_at, last_seen_at, expires_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(alias, session_id) DO UPDATE SET
          alias_kind = excluded.alias_kind,
          agent_id = excluded.agent_id,
          endpoint_id = excluded.endpoint_id,
          node_id = excluded.node_id,
          harness = excluded.harness,
          transport = excluded.transport,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at`,
      ).run(
        alias.alias,
        sessionId,
        alias.aliasKind,
        endpoint.agentId,
        endpoint.id,
        endpoint.nodeId,
        endpoint.harness,
        endpoint.transport,
        lastSeenAt,
        lastSeenAt,
        expiresAt,
      );
    }

    const aliasValues = aliases.map((alias) => alias.alias);
    if (aliasValues.length === 0) {
      this.db.query("DELETE FROM runtime_session_aliases WHERE session_id = ?1").run(sessionId);
      return;
    }
    const placeholders = aliasValues.map(() => "?").join(", ");
    this.db.query(
      `DELETE FROM runtime_session_aliases
       WHERE session_id = ? AND alias NOT IN (${placeholders})`,
    ).run(sessionId, ...aliasValues);
  }

  private recordEndpointBudgetObservations(endpoint: AgentEndpoint): void {
    const observations = budgetObservationsFromEndpoint(endpoint, currentTimestampMs());
    for (const record of observations.usage) {
      this.recordBudgetUsageEvent(record);
    }
    // Prune before writing, so a batch is never deleted in the call that
    // recorded it.
    const now = currentTimestampMs();
    if (observations.quotaWindows.length > 0 && now - this.lastQuotaHistoryPruneAt >= QUOTA_HISTORY_PRUNE_INTERVAL_MS) {
      this.lastQuotaHistoryPruneAt = now;
      this.pruneBudgetQuotaHistory(now);
    }
    for (const snapshot of observations.quotaWindows) {
      this.recordBudgetQuotaWindowSnapshot(snapshot);
    }
  }

  /**
   * Drop hourly quota history older than the charted week. Current-window rows
   * (`budget:quota:<hash>`) are one per window and are never pruned here.
   */
  pruneBudgetQuotaHistory(now = currentTimestampMs()): number {
    const result = this.db.query(
      `DELETE FROM budget_quota_window_snapshots
       WHERE id LIKE 'budget:quota:history:%' AND captured_at < ?1`,
    ).run(now - QUOTA_HISTORY_RETENTION_MS) as { changes?: number };
    return result.changes ?? 0;
  }

  recordBudgetUsageEvent(record: BudgetUsageRecord): void {
    const createdAt = record.createdAt ?? currentTimestampMs();
    this.db.query(
      `INSERT INTO budget_usage_events (
        id, scope, source, provider, harness, transport, model, agent_id, endpoint_id,
        session_id, project_root, conversation_id, message_id, invocation_id, flight_id,
        work_id, occurred_at, input_tokens, output_tokens, reasoning_output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, total_tokens, estimated_usd,
        billed_usd, currency, dedup_key, metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
      )
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        source = excluded.source,
        provider = excluded.provider,
        harness = excluded.harness,
        transport = excluded.transport,
        model = excluded.model,
        agent_id = excluded.agent_id,
        endpoint_id = excluded.endpoint_id,
        session_id = excluded.session_id,
        project_root = excluded.project_root,
        conversation_id = excluded.conversation_id,
        message_id = excluded.message_id,
        invocation_id = excluded.invocation_id,
        flight_id = excluded.flight_id,
        work_id = excluded.work_id,
        occurred_at = excluded.occurred_at,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        total_tokens = excluded.total_tokens,
        estimated_usd = excluded.estimated_usd,
        billed_usd = excluded.billed_usd,
        currency = excluded.currency,
        dedup_key = excluded.dedup_key,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at`,
    ).run(
      record.id,
      record.scope,
      record.source,
      record.provider ?? null,
      record.harness ?? null,
      record.transport ?? null,
      record.model ?? null,
      record.agentId ?? null,
      record.endpointId ?? null,
      record.sessionId ?? null,
      record.projectRoot ?? null,
      record.conversationId ?? null,
      record.messageId ?? null,
      record.invocationId ?? null,
      record.flightId ?? null,
      record.workId ?? null,
      record.occurredAt,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      record.reasoningOutputTokens ?? null,
      record.cacheCreationInputTokens ?? null,
      record.cacheReadInputTokens ?? null,
      record.totalTokens ?? null,
      record.estimatedUsd ?? null,
      record.billedUsd ?? null,
      record.currency ?? null,
      record.dedupKey ?? null,
      stringify(record.metadata),
      createdAt,
    );
  }

  listBudgetUsageEvents(options: BudgetUsageListOptions = {}): BudgetUsageRecord[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    const addPredicate = (sql: string, value: SQLiteBinding): void => {
      predicates.push(sql);
      params.push(value);
    };

    if (options.scope) addPredicate("scope = ?", options.scope);
    if (options.provider) addPredicate("provider = ?", options.provider);
    if (options.agentId) addPredicate("agent_id = ?", options.agentId);
    if (options.endpointId) addPredicate("endpoint_id = ?", options.endpointId);
    if (options.sessionId) addPredicate("session_id = ?", options.sessionId);
    if (options.invocationId) addPredicate("invocation_id = ?", options.invocationId);
    if (options.flightId) addPredicate("flight_id = ?", options.flightId);
    if (typeof options.since === "number") addPredicate("occurred_at >= ?", options.since);
    if (typeof options.until === "number") addPredicate("occurred_at <= ?", options.until);

    const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const rows = queryAllDynamic<BudgetUsageRow>(
      this.readDb,
      `SELECT *
      FROM budget_usage_events
      ${where}
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT ?`,
      [...params, normalizedListLimit(options.limit)],
    );
    return rows.map(budgetUsageFromRow);
  }

  recordBudgetQuotaWindowSnapshot(snapshot: BudgetQuotaWindowSnapshot): void {
    const createdAt = snapshot.createdAt ?? currentTimestampMs();
    this.db.query(
      `INSERT INTO budget_quota_window_snapshots (
        id, source, provider, harness, transport, model, agent_id, endpoint_id,
        session_id, user_id, account_id, plan_type, label, window_kind, used_percent,
        percent_remaining, used, limit_value, reset_at, window_ms, captured_at,
        metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
      )
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        provider = excluded.provider,
        harness = excluded.harness,
        transport = excluded.transport,
        model = excluded.model,
        agent_id = excluded.agent_id,
        endpoint_id = excluded.endpoint_id,
        session_id = excluded.session_id,
        user_id = excluded.user_id,
        account_id = excluded.account_id,
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
    ).run(
      snapshot.id,
      snapshot.source,
      snapshot.provider ?? null,
      snapshot.harness ?? null,
      snapshot.transport ?? null,
      snapshot.model ?? null,
      snapshot.agentId ?? null,
      snapshot.endpointId ?? null,
      snapshot.sessionId ?? null,
      snapshot.userId ?? null,
      snapshot.accountId ?? null,
      snapshot.planType ?? null,
      snapshot.label,
      snapshot.windowKind ?? null,
      snapshot.usedPercent ?? null,
      snapshot.percentRemaining ?? null,
      snapshot.used ?? null,
      snapshot.limit ?? null,
      snapshot.resetAt ?? null,
      snapshot.windowMs ?? null,
      snapshot.capturedAt,
      stringify(snapshot.metadata),
      createdAt,
    );
  }

  listBudgetQuotaWindowSnapshots(options: BudgetQuotaWindowListOptions = {}): BudgetQuotaWindowSnapshot[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    const addPredicate = (sql: string, value: SQLiteBinding): void => {
      predicates.push(sql);
      params.push(value);
    };

    if (options.source) addPredicate("source = ?", options.source);
    if (options.provider) addPredicate("provider = ?", options.provider);
    if (options.agentId) addPredicate("agent_id = ?", options.agentId);
    if (options.endpointId) addPredicate("endpoint_id = ?", options.endpointId);
    if (options.sessionId) addPredicate("session_id = ?", options.sessionId);
    if (options.label) addPredicate("label = ?", options.label);
    if (typeof options.since === "number") addPredicate("captured_at >= ?", options.since);
    if (typeof options.until === "number") addPredicate("captured_at <= ?", options.until);

    const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const rows = queryAllDynamic<BudgetQuotaWindowRow>(
      this.readDb,
      `SELECT *
      FROM budget_quota_window_snapshots
      ${where}
      ORDER BY captured_at DESC, created_at DESC
      LIMIT ?`,
      [...params, normalizedListLimit(options.limit)],
    );
    return rows.map(budgetQuotaWindowFromRow);
  }

  upsertConversation(conversation: ConversationDefinition): void {
    (this.db as SQLiteTransactionalDatabase).transaction((nextConversation: ConversationDefinition) => {
      this.db.query(
        `INSERT INTO conversations (
          id, kind, title, visibility, share_mode, authority_node_id, topic,
          parent_conversation_id, message_id, metadata_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          visibility = excluded.visibility,
          share_mode = excluded.share_mode,
          authority_node_id = excluded.authority_node_id,
          topic = excluded.topic,
          parent_conversation_id = excluded.parent_conversation_id,
          message_id = excluded.message_id,
          metadata_json = excluded.metadata_json`,
      ).run(
        nextConversation.id,
        nextConversation.kind,
        nextConversation.title,
        nextConversation.visibility,
        nextConversation.shareMode,
        nextConversation.authorityNodeId,
        nextConversation.topic ?? null,
        nextConversation.parentConversationId ?? null,
        nextConversation.messageId ?? null,
        stringify(nextConversation.metadata),
        currentTimestampMs(),
      );
      this.db.query("DELETE FROM conversation_members WHERE conversation_id = ?1").run(nextConversation.id);
      for (const participantId of nextConversation.participantIds) {
        this.db.query(
          "INSERT OR REPLACE INTO conversation_members (conversation_id, actor_id) VALUES (?1, ?2)",
        ).run(nextConversation.id, participantId);
      }
    })(conversation);
  }

  upsertBinding(binding: ConversationBinding): void {
    this.db.query(
      `INSERT INTO bindings (
        id, conversation_id, platform, mode, external_channel_id, external_thread_id, metadata_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        platform = excluded.platform,
        mode = excluded.mode,
        external_channel_id = excluded.external_channel_id,
        external_thread_id = excluded.external_thread_id,
        metadata_json = excluded.metadata_json`,
    ).run(
      binding.id,
      binding.conversationId,
      binding.platform,
      binding.mode,
      binding.externalChannelId,
      binding.externalThreadId ?? null,
      stringify(binding.metadata),
    );
  }

  recordMessage(message: MessageRecord): ThreadEventEnvelope[] {
    const activityItem = this.projectMessageActivity(message);
    const threadMessageEvent = readChatMessageCorrection(message.metadata) ? null : this.buildThreadMessageEvent(message, this.readDb);
    let threadEvents: ThreadEventEnvelope[] = [];
    (this.db as SQLiteTransactionalDatabase).transaction((
      nextMessage: MessageRecord,
      nextActivityItem: ActivityItem,
      nextThreadMessageEvent: ThreadEventInsert | null,
    ) => {
      this.db.query(
        `INSERT INTO messages (
          id, conversation_id, actor_id, origin_node_id, class, body, reply_to_message_id,
          thread_conversation_id, speech_json, audience_json, visibility, policy, metadata_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          actor_id = excluded.actor_id,
          origin_node_id = excluded.origin_node_id,
          class = excluded.class,
          body = excluded.body,
          reply_to_message_id = excluded.reply_to_message_id,
          thread_conversation_id = excluded.thread_conversation_id,
          speech_json = excluded.speech_json,
          audience_json = excluded.audience_json,
          visibility = excluded.visibility,
          policy = excluded.policy,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at`,
      ).run(
        nextMessage.id,
        nextMessage.conversationId,
        nextMessage.actorId,
        nextMessage.originNodeId,
        nextMessage.class,
        nextMessage.body,
        nextMessage.replyToMessageId ?? null,
        nextMessage.threadConversationId ?? null,
        stringify(nextMessage.speech),
        stringify(nextMessage.audience),
        nextMessage.visibility,
        nextMessage.policy,
        stringify(nextMessage.metadata),
        nextMessage.createdAt,
      );
      this.db.query("DELETE FROM broker_history_anchors WHERE kind='message' AND id=?1").run(nextMessage.id);
      this.db.query("DELETE FROM message_mentions WHERE message_id = ?1").run(nextMessage.id);
      for (const mention of nextMessage.mentions ?? []) {
        this.db.query(
          "INSERT OR REPLACE INTO message_mentions (message_id, actor_id, label) VALUES (?1, ?2, ?3)",
        ).run(nextMessage.id, mention.actorId, mention.label ?? null);
      }
      this.db.query("DELETE FROM message_attachments WHERE message_id = ?1").run(nextMessage.id);
      for (const attachment of nextMessage.attachments ?? []) {
        this.db.query(
          `INSERT OR REPLACE INTO message_attachments (
            id, message_id, media_type, file_name, blob_key, url, metadata_json
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).run(
          attachment.id,
          nextMessage.id,
          attachment.mediaType,
          attachment.fileName ?? null,
          attachment.blobKey ?? null,
          attachment.url ?? null,
          stringify(attachment.metadata),
        );
      }
      this.recordActivityItem(nextActivityItem);
      threadEvents = nextThreadMessageEvent
        ? [this.appendThreadEvent(nextThreadMessageEvent)]
        : [];
    })(message, activityItem, threadMessageEvent);
    return threadEvents;
  }

  upsertMessageReaction(input: {
    channelId: string;
    messageId: string;
    actorId: string;
    emoji: string;
    createdAt: number;
  }): { replayed: boolean } {
    const message = this.db.query(
      `SELECT id, conversation_id FROM messages WHERE id = ?1`,
    ).get(input.messageId) as { id: string; conversation_id: string } | null;
    if (!message) {
      throw Object.assign(new Error("message not found"), { status: 404, reason: "message_not_found" });
    }
    if (message.conversation_id !== input.channelId) {
      const conversation = this.db.query(
        `SELECT kind, parent_conversation_id FROM conversations WHERE id = ?1`,
      ).get(message.conversation_id) as
        | { kind: string; parent_conversation_id: string | null }
        | null;
      if (
        conversation?.kind !== "thread"
        || conversation.parent_conversation_id !== input.channelId
      ) {
        throw Object.assign(new Error("message is not in this channel"), {
          status: 404,
          reason: "wrong_channel",
        });
      }
    }
    const actor = this.db.query(`SELECT id FROM actors WHERE id = ?1`).get(input.actorId) as
      | { id: string }
      | null;
    if (!actor) {
      throw Object.assign(new Error("actor not found"), { status: 404, reason: "actor_not_found" });
    }
    const result = this.db.query(
      `INSERT OR IGNORE INTO message_reactions (message_id, actor_id, emoji, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).run(input.messageId, input.actorId, input.emoji, input.createdAt) as { changes: number | bigint };
    return { replayed: Number(result.changes) === 0 };
  }

  removeMessageReaction(input: {
    channelId: string;
    messageId: string;
    actorId: string;
    emoji: string;
  }): { replayed: boolean } {
    const message = this.db.query(
      `SELECT id, conversation_id FROM messages WHERE id = ?1`,
    ).get(input.messageId) as { id: string; conversation_id: string } | null;
    if (!message) {
      throw Object.assign(new Error("message not found"), { status: 404, reason: "message_not_found" });
    }
    if (message.conversation_id !== input.channelId) {
      const conversation = this.db.query(
        `SELECT kind, parent_conversation_id FROM conversations WHERE id = ?1`,
      ).get(message.conversation_id) as
        | { kind: string; parent_conversation_id: string | null }
        | null;
      if (
        conversation?.kind !== "thread"
        || conversation.parent_conversation_id !== input.channelId
      ) {
        throw Object.assign(new Error("message is not in this channel"), {
          status: 404,
          reason: "wrong_channel",
        });
      }
    }
    const result = this.db.query(
      `DELETE FROM message_reactions
       WHERE message_id = ?1 AND actor_id = ?2 AND emoji = ?3`,
    ).run(input.messageId, input.actorId, input.emoji) as { changes: number | bigint };
    return { replayed: Number(result.changes) === 0 };
  }

  listMessageReactions(channelId: string): MessageReactionRecord[] {
    const rows = queryAll<{
      message_id: string;
      actor_id: string;
      emoji: string;
      created_at: number;
    }, [string]>(
      this.readDb,
      `SELECT r.message_id, r.actor_id, r.emoji, r.created_at
       FROM message_reactions r
       JOIN messages m ON m.id = r.message_id
       WHERE m.conversation_id = ?1
          OR m.conversation_id IN (
            SELECT id FROM conversations WHERE parent_conversation_id = ?1
          )
       ORDER BY r.created_at ASC, r.emoji ASC`,
      channelId,
    );
    return rows.map((row) => ({
      messageId: row.message_id,
      actorId: row.actor_id,
      emoji: row.emoji,
      createdAt: row.created_at,
    }));
  }

  upsertReadCursor(cursor: ConversationReadCursor): void {
    this.db.query(
      `INSERT INTO conversation_read_cursors (
        conversation_id, actor_id, reader_node_id, last_read_message_id,
        last_read_seq, last_read_at, updated_at, metadata_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(conversation_id, actor_id) DO UPDATE SET
        reader_node_id = excluded.reader_node_id,
        last_read_message_id = excluded.last_read_message_id,
        last_read_seq = excluded.last_read_seq,
        last_read_at = excluded.last_read_at,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json`,
    ).run(
      cursor.conversationId,
      cursor.actorId,
      cursor.readerNodeId ?? null,
      cursor.lastReadMessageId ?? null,
      cursor.lastReadSeq ?? null,
      cursor.lastReadAt,
      cursor.updatedAt,
      stringify(cursor.metadata),
    );
  }

  listReadCursors(conversationId: string): ConversationReadCursor[] {
    const rows = queryAll<ReadCursorRow, [string]>(
      this.readDb,
      `SELECT *
      FROM conversation_read_cursors
      WHERE conversation_id = ?1
      ORDER BY updated_at DESC`,
      conversationId,
    );
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      actorId: row.actor_id,
      readerNodeId: row.reader_node_id ?? undefined,
      lastReadMessageId: row.last_read_message_id ?? undefined,
      lastReadSeq: row.last_read_seq ?? undefined,
      lastReadAt: row.last_read_at,
      updatedAt: row.updated_at,
      metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    }));
  }

  recordInvocation(invocation: InvocationRequest): void {
    // A mesh-forwarded invocation names the sender's message and work record,
    // which this node may never hold. Both columns are ON DELETE SET NULL
    // soft references, so a parent absent here is stored as NULL rather than
    // failing the row — and every flight under it — on the foreign key.
    const collaborationRecordId = this.existingParentId(
      "collaboration_records",
      resolveInvocationCollaborationRecordId(invocation),
    );
    const messageId = this.existingParentId("messages", invocation.messageId);
    this.db.query(
      `INSERT INTO invocations (
        id, requester_id, requester_node_id, target_agent_id, target_node_id, action, task,
        collaboration_record_id, conversation_id, message_id, context_json, execution_json,
        execution_resolution_json, ensure_awake, stream, timeout_ms, labels_json, metadata_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
      ON CONFLICT(id) DO UPDATE SET
        requester_id = excluded.requester_id,
        requester_node_id = excluded.requester_node_id,
        target_agent_id = excluded.target_agent_id,
        target_node_id = excluded.target_node_id,
        action = excluded.action,
        task = excluded.task,
        collaboration_record_id = excluded.collaboration_record_id,
        conversation_id = excluded.conversation_id,
        message_id = excluded.message_id,
        context_json = excluded.context_json,
        execution_json = excluded.execution_json,
        execution_resolution_json = excluded.execution_resolution_json,
        ensure_awake = excluded.ensure_awake,
        stream = excluded.stream,
        timeout_ms = excluded.timeout_ms,
        labels_json = excluded.labels_json,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at`,
    ).run(
      invocation.id,
      invocation.requesterId,
      invocation.requesterNodeId,
      invocation.targetAgentId,
      invocation.targetNodeId ?? null,
      invocation.action,
      invocation.task,
      collaborationRecordId,
      invocation.conversationId ?? null,
      messageId,
      stringify(invocation.context),
      stringify(invocation.execution),
      stringify(invocation.executionResolution),
      invocation.ensureAwake ? 1 : 0,
      invocation.stream ? 1 : 0,
      invocation.timeoutMs ?? null,
      stringify(invocation.labels),
      stringify(invocation.metadata),
      invocation.createdAt,
    );
    this.db.query("DELETE FROM broker_history_anchors WHERE kind='invocation' AND id=?1").run(invocation.id);
    this.recordActivityItem(this.projectInvocationActivity({ ...invocation, messageId: messageId ?? undefined }));
  }

  private existingParentId(table: "messages" | "collaboration_records", id: string | undefined): string | null {
    if (!id) return null;
    return this.db.query(`SELECT 1 FROM ${table} WHERE id = ?1`).get(id) ? id : null;
  }

  recordFlight(flight: FlightRecord, options: { preserveCurrent?: boolean } = {}): ThreadEventEnvelope[] {
    const archivedInvocation = this.anchoredRecord<InvocationRequest>("invocation", flight.invocationId);
    if (archivedInvocation) this.recordInvocation(archivedInvocation);
    let recorded = flight;
    // One transaction so the flight row and the invocation shadow can never
    // durably diverge — a crash between the two writes would otherwise leave
    // a stale shadow until the next boot's self-healing reconcile.
    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      // The invocation is the identity authority: a flight is that
      // invocation's status, so its requester/target cannot disagree with the
      // invocation's. Every broker path already passes matching values; this
      // normalizes the one unguarded writer (raw FlightRecord posts on
      // /v1/flights), whose divergent identity fields readers would otherwise
      // silently override now that they project from the invocation row.
      const identity = this.db.query(
        "SELECT requester_id, target_agent_id FROM invocations WHERE id = ?1",
      ).get(flight.invocationId) as {
        requester_id: string;
        target_agent_id: string;
      } | null;
      if (
        identity &&
        (identity.requester_id !== flight.requesterId ||
          identity.target_agent_id !== flight.targetAgentId)
      ) {
        recorded = {
          ...flight,
          requesterId: identity.requester_id,
          targetAgentId: identity.target_agent_id,
        };
      }

      // Keep the parent key in place: REPLACE deletes it first, which cascades
      // through activity_items.flight_id and turns a status update into child
      // deletion work. Advancing only the internal rowid retains write-order
      // tie-breaking for the boot-time latest-flight reconciliation.
      this.db.query(
        `INSERT INTO flights (
          id, invocation_id, requester_id, target_agent_id, state, summary, output, error,
          labels_json, metadata_json, started_at, completed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(id) DO UPDATE SET
          rowid = CASE WHEN ?13 = 1 THEN flights.rowid ELSE (SELECT COALESCE(MAX(rowid), 0) + 1 FROM flights) END,
          invocation_id = excluded.invocation_id,
          requester_id = excluded.requester_id,
          target_agent_id = excluded.target_agent_id,
          state = excluded.state,
          summary = excluded.summary,
          output = excluded.output,
          error = excluded.error,
          labels_json = excluded.labels_json,
          metadata_json = excluded.metadata_json,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at`,
      ).run(
        recorded.id,
        recorded.invocationId,
        recorded.requesterId,
        recorded.targetAgentId,
        recorded.state,
        recorded.summary ?? null,
        recorded.output ?? null,
        recorded.error ?? null,
        stringify(recorded.labels),
        stringify(recorded.metadata),
        recorded.startedAt ?? null,
        recorded.completedAt ?? null,
        options.preserveCurrent ? 1 : 0,
      );

      // Dual-write the flight's status onto the merged invocation record
      // (Phase 3 flight→invocation storage merge, expand phase). Reads still
      // come from the flights table above; these columns are the shadow copy
      // PR D will read from. No-op when the invocation row is absent. The
      // WHERE guard keeps the shadow on the invocation's LATEST flight — same
      // freshness ordering as the backfill and the read-side projector
      // (COALESCE(completed_at, started_at, 0), ties to the newer write) — so
      // an out-of-order write of an older sibling flight cannot regress it;
      // rewrites of the shadowed flight itself always land.
      this.db.query(
        `UPDATE invocations SET
           flight_id = ?2, state = ?3, summary = ?4, output = ?5, error = ?6,
           started_at = ?7, completed_at = ?8, flight_metadata_json = ?9
         WHERE id = ?1
           AND (?10 = 0 OR flight_id = ?2)
           AND (
             flight_id IS NULL
             OR flight_id = ?2
             OR COALESCE(?8, ?7, 0) >= COALESCE(completed_at, started_at, 0)
           )`,
      ).run(
        recorded.invocationId,
        recorded.id,
        recorded.state,
        recorded.summary ?? null,
        recorded.output ?? null,
        recorded.error ?? null,
        recorded.startedAt ?? null,
        recorded.completedAt ?? null,
        stringify(recorded.metadata),
        options.preserveCurrent ? 1 : 0,
      );
    })();

    this.recordActivityItem(this.projectFlightActivity(recorded));
    return this.recordThreadFlightEvent(recorded);
  }

  recordScoutDispatch(dispatch: ScoutDispatchRecord): void {
    this.db.query(
      `INSERT OR REPLACE INTO scout_dispatches (
        id, kind, asked_label, detail, invocation_id, conversation_id, requester_id,
        dispatcher_node_id, dispatched_at, payload_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).run(
      dispatch.id,
      dispatch.kind,
      dispatch.askedLabel,
      dispatch.detail,
      dispatch.invocationId ?? null,
      dispatch.conversationId ?? null,
      dispatch.requesterId ?? null,
      dispatch.dispatcherNodeId,
      dispatch.dispatchedAt,
      JSON.stringify(dispatch),
    );
  }

  recordCollaborationRecord(record: CollaborationRecord): ThreadEventEnvelope[] {
    const detail: Record<string, unknown> = {
      metadata: record.metadata,
    };

    if (record.kind === "question") {
      detail.askedById = record.askedById;
      detail.answeredById = record.answeredById;
      detail.answer = record.answer;
      detail.answeredAt = record.answeredAt;
      detail.closedAt = record.closedAt;
    } else {
      detail.requestedById = record.requestedById;
      detail.waitingOn = record.waitingOn;
      detail.progress = record.progress;
      detail.startedAt = record.startedAt;
      detail.reviewRequestedAt = record.reviewRequestedAt;
      detail.completedAt = record.completedAt;
    }

    this.db.query(
      `INSERT INTO collaboration_records (
        id, kind, state, acceptance_state, title, summary, created_by_id, owner_id,
        next_move_owner_id, conversation_id, parent_id, priority, labels_json, relations_json,
        detail_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        state = excluded.state,
        acceptance_state = excluded.acceptance_state,
        title = excluded.title,
        summary = excluded.summary,
        created_by_id = excluded.created_by_id,
        owner_id = excluded.owner_id,
        next_move_owner_id = excluded.next_move_owner_id,
        conversation_id = excluded.conversation_id,
        parent_id = excluded.parent_id,
        priority = excluded.priority,
        labels_json = excluded.labels_json,
        relations_json = excluded.relations_json,
        detail_json = excluded.detail_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
    ).run(
      record.id,
      record.kind,
      record.state,
      record.acceptanceState,
      record.title,
      record.summary ?? null,
      record.createdById,
      record.ownerId ?? null,
      record.nextMoveOwnerId ?? null,
      record.conversationId ?? null,
      record.parentId ?? null,
      record.priority ?? null,
      stringify(record.labels),
      stringify(record.relations),
      stringify(detail),
      record.createdAt,
      record.updatedAt,
    );
    return this.recordThreadCollaborationEvent(record);
  }

  recordCollaborationEvent(event: CollaborationEvent): ThreadEventEnvelope[] {
    this.db.query(
      `INSERT OR REPLACE INTO collaboration_events (
        id, record_id, record_kind, kind, actor_id, summary, metadata_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).run(
      event.id,
      event.recordId,
      event.recordKind,
      event.kind,
      event.actorId,
      event.summary ?? null,
      stringify(event.metadata),
      event.at,
    );

    this.recordActivityItem({
      id: `activity:record:${event.id}`,
      kind: "collaboration_event",
      ts: event.at,
      recordId: event.recordId,
      actorId: event.actorId,
      title: summarizeText(event.summary ?? event.kind),
      summary: event.summary ?? event.kind,
      payload: {
        recordKind: event.recordKind,
        kind: event.kind,
        metadata: event.metadata,
      },
    });
    return this.recordThreadCollaborationEventAppend(event);
  }

  listActivityItems(options: {
    agentId?: string;
    actorId?: string;
    conversationId?: string;
    limit?: number;
  } = {}): ActivityItem[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];

    if (options.agentId) {
      filters.push(`agent_id = ?${values.length + 1}`);
      values.push(options.agentId);
    }
    if (options.actorId) {
      filters.push(`actor_id = ?${values.length + 1}`);
      values.push(options.actorId);
    }
    if (options.conversationId) {
      filters.push(`conversation_id = ?${values.length + 1}`);
      values.push(options.conversationId);
    }

    const limit = options.limit ?? 200;
    const sql = [
      "SELECT * FROM activity_items",
      filters.length ? `WHERE ${filters.join(" AND ")}` : "",
      "ORDER BY ts DESC",
      `LIMIT ?${values.length + 1}`,
    ].filter(Boolean).join(" ");
    const rows = queryAll<ActivityItemRow, Array<string | number>>(this.readDb, sql, ...values, limit);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      ts: row.ts,
      conversationId: row.conversation_id ?? undefined,
      messageId: row.message_id ?? undefined,
      invocationId: row.invocation_id ?? undefined,
      flightId: row.flight_id ?? undefined,
      recordId: row.record_id ?? undefined,
      actorId: row.actor_id ?? undefined,
      counterpartId: row.counterpart_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      workspaceRoot: row.workspace_root ?? undefined,
      sessionId: row.session_id ?? undefined,
      title: row.title ?? undefined,
      summary: row.summary ?? undefined,
      payload: parseJson<Record<string, unknown> | undefined>(row.payload_json, undefined),
    }));
  }

  listCollaborationRecords(options: {
    conversationId?: string;
    includeThreads?: boolean;
    orderByCreatedAt?: boolean;
    afterCreatedAt?: number;
    afterId?: string;
    limit?: number;
    kind?: CollaborationRecord["kind"];
    state?: string;
    ownerId?: string;
    nextMoveOwnerId?: string;
  } = {}): CollaborationRecord[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];

    if (options.conversationId) {
      values.push(options.conversationId);
      const slot = `?${values.length}`;
      filters.push(options.includeThreads
        ? `(conversation_id = ${slot} OR conversation_id IN (SELECT id FROM conversations WHERE kind = 'thread' AND parent_conversation_id = ${slot}))`
        : `conversation_id = ${slot}`);
    }
    if (options.afterCreatedAt != null) {
      values.push(options.afterCreatedAt, options.afterId ?? "");
      filters.push(`(created_at > ?${values.length - 1} OR (created_at = ?${values.length - 1} AND id > ?${values.length}))`);
    }

    if (options.kind) {
      filters.push(`kind = ?${values.length + 1}`);
      values.push(options.kind);
    }
    if (options.state) {
      filters.push(`state = ?${values.length + 1}`);
      values.push(options.state);
    }
    if (options.ownerId) {
      filters.push(`owner_id = ?${values.length + 1}`);
      values.push(options.ownerId);
    }
    if (options.nextMoveOwnerId) {
      filters.push(`next_move_owner_id = ?${values.length + 1}`);
      values.push(options.nextMoveOwnerId);
    }

    const limit = options.limit ?? 200;
    const sql = [
      "SELECT * FROM collaboration_records",
      filters.length ? `WHERE ${filters.join(" AND ")}` : "",
      options.orderByCreatedAt ? "ORDER BY created_at ASC, id ASC" : "ORDER BY updated_at DESC",
      `LIMIT ?${values.length + 1}`,
    ].filter(Boolean).join(" ");
    const rows = queryAll<CollaborationRecordRow, Array<string | number>>(this.readDb, sql, ...values, limit);
    return rows.map(buildCollaborationRecord);
  }

  listCollaborationEvents(options: { limit?: number; recordId?: string } = {}): CollaborationEvent[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];

    if (options.recordId) {
      filters.push(`record_id = ?${values.length + 1}`);
      values.push(options.recordId);
    }

    const limit = options.limit ?? 200;
    const sql = [
      "SELECT * FROM collaboration_events",
      filters.length ? `WHERE ${filters.join(" AND ")}` : "",
      "ORDER BY created_at DESC",
      `LIMIT ?${values.length + 1}`,
    ].filter(Boolean).join(" ");
    const rows = queryAll<CollaborationEventRow, Array<string | number>>(this.readDb, sql, ...values, limit);
    return rows.map(collaborationEventFromRow);
  }

  recordDeliveries(deliveries: DeliveryIntent[]): void {
    if (deliveries.length === 0) return;
    const statement = this.db.query(
      `INSERT INTO deliveries (
        id, message_id, invocation_id, target_id, target_node_id, target_kind,
        transport, reason, policy, status, binding_id, lease_owner, lease_expires_at,
        metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
      )
      ON CONFLICT(id) DO UPDATE SET
        message_id = excluded.message_id,
        invocation_id = excluded.invocation_id,
        target_id = excluded.target_id,
        target_node_id = excluded.target_node_id,
        target_kind = excluded.target_kind,
        transport = excluded.transport,
        reason = excluded.reason,
        policy = excluded.policy,
        status = excluded.status,
        binding_id = excluded.binding_id,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        metadata_json = excluded.metadata_json`,
    );
    (this.db as SQLiteTransactionalDatabase).transaction((batch: DeliveryIntent[]) => {
      const createdAtBySource = new Map<string, number>();
      for (const delivery of batch) {
        const sourceKey = delivery.messageId || delivery.invocationId
          ? `${delivery.messageId ?? ""}\u0000${delivery.invocationId ?? ""}`
          : null;
        let createdAt: number;
        if (sourceKey === null) {
          createdAt = this.deliveryCreatedAt(delivery);
        } else {
          const cached = createdAtBySource.get(sourceKey);
          if (cached !== undefined) {
            createdAt = cached;
          } else {
            createdAt = this.deliveryCreatedAt(delivery);
            createdAtBySource.set(sourceKey, createdAt);
          }
        }
        statement.run(
          delivery.id,
          delivery.messageId ?? null,
          delivery.invocationId ?? null,
          delivery.targetId,
          delivery.targetNodeId ?? null,
          delivery.targetKind,
          delivery.transport,
          delivery.reason,
          delivery.policy,
          delivery.status,
          delivery.bindingId ?? null,
          delivery.leaseOwner ?? null,
          delivery.leaseExpiresAt ?? null,
          stringify(delivery.metadata),
          createdAt,
        );
      }
    })(deliveries);
  }

  private deliveryCreatedAt(delivery: DeliveryIntent): number {
    const messageCreatedAt = delivery.messageId
      ? queryGet<{ created_at: number }, [string]>(
          this.db,
          "SELECT created_at FROM messages WHERE id = ?1 LIMIT 1",
          delivery.messageId,
        )?.created_at
      : null;
    const invocationCreatedAt = delivery.invocationId
      ? queryGet<{ created_at: number }, [string]>(
          this.db,
          "SELECT created_at FROM invocations WHERE id = ?1 LIMIT 1",
          delivery.invocationId,
        )?.created_at
      : null;
    return normalizeTimestampMs(messageCreatedAt)
      ?? normalizeTimestampMs(invocationCreatedAt)
      ?? currentTimestampMs();
  }

  listDeliveries(options: {
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    targetId?: string;
    invocationId?: string;
    statuses?: DeliveryIntent["status"][];
    reasons?: DeliveryIntent["reason"][];
    limit?: number;
  } = {}): DeliveryIntent[] {
    const limit = options.limit ?? 200;

    const baseQuery = this.drizzleReadDb
      .select()
      .from(deliveriesTable)
      .orderBy(asc(deliveriesTable.createdAt), asc(deliveriesTable.id))
      .limit(limit);
    const filters = [
      ...(options.invocationId ? [eq(deliveriesTable.invocationId, options.invocationId)] : []),
      ...(options.transport ? [eq(deliveriesTable.transport, options.transport)] : []),
      ...(options.status ? [eq(deliveriesTable.status, options.status)] : []),
      ...(options.targetId ? [eq(deliveriesTable.targetId, options.targetId)] : []),
      ...(options.statuses ? [inArray(deliveriesTable.status, options.statuses)] : []),
      ...(options.reasons ? [inArray(deliveriesTable.reason, options.reasons)] : []),
    ];
    const rows = baseQuery.where(and(...filters)).all() as Array<{
            id: string;
            messageId: string | null;
            invocationId: string | null;
            targetId: string;
            targetNodeId: string | null;
            targetKind: DeliveryIntent["targetKind"];
            transport: DeliveryIntent["transport"];
            reason: DeliveryIntent["reason"];
            policy: DeliveryIntent["policy"];
            status: DeliveryIntent["status"];
            bindingId: string | null;
            leaseOwner: string | null;
            leaseExpiresAt: number | null;
            metadataJson: string | null;
          }>;

    return (rows as DeliveryProjectionRow[]).map(deliveryIntentFromRow);
  }

  /**
   * Positive per-record reads for the rotation persistence boundary: the
   * stored rows come back through the same row→record mappers `loadSnapshot`
   * uses, so the verifier compares a stored record against the journaled
   * record field-for-field (after `canonicalRecord` normalization on both
   * sides). Chunked `IN` lists keep bound-parameter counts bounded; a
   * lookup error propagates so the caller can fail closed.
   */
  readInvocationSnapshot(invocationId: string): { invocation: InvocationRequest | null; flight: FlightRecord | null; deliveries: DeliveryIntent[] } {
    const invocation = this.readInvocations([invocationId]).get(invocationId) ?? null;
    if (!invocation) return { invocation: null, flight: null, deliveries: [] };
    const shadow = this.readDb.query<{ flight_id: string | null }>("SELECT flight_id FROM invocations WHERE id=?1").get(invocationId)?.flight_id;
    const latest = shadow ?? this.readDb.query<{ id: string }>("SELECT id FROM flights WHERE invocation_id=?1 ORDER BY rowid DESC LIMIT 1").get(invocationId)?.id;
    let flight = latest ? this.readFlights([latest]).get(latest) ?? null : null;
    if (!flight && this.historyReader) {
      const location = this.historyReader.page({ kind: "flight", invocationId, order: "desc", limit: 1 })[0];
      if (location) flight = this.historyReader.readLocation<FlightRecord>(location);
    }
    const deliveries = new Map(this.listDeliveries({ invocationId, limit: 500 }).map(delivery => [delivery.id, delivery]));
    for (const location of this.historyReader?.page({ kind: "delivery", invocationId, limit: 500 }) ?? []) {
      if (deliveries.size >= 500) break;
      if (!deliveries.has(location.id)) deliveries.set(location.id, this.historyReader!.readLocation<DeliveryIntent>(location));
    }
    return { invocation, flight, deliveries: [...deliveries.values()] };
  }

  readMessages(ids: readonly string[]): Map<string, MessageRecord> {
    const found = new Map<string, MessageRecord>();
    for (const chunk of chunksOf(ids)) {
      const marks = chunk.map(() => "?").join(", ");
      const rows = queryAllDynamic<MessageRow>(
        this.readDb,
        `SELECT * FROM messages WHERE id IN (${marks})`,
        [...chunk],
      );
      const mentionsByMessage = new Map<string, MessageMention[]>();
      const attachmentsByMessage = new Map<string, MessageAttachment[]>();
      for (const row of queryAllDynamic<MentionRow>(
        this.readDb,
        `SELECT * FROM message_mentions WHERE message_id IN (${marks}) ORDER BY message_id, actor_id`,
        [...chunk],
      )) {
        const list = mentionsByMessage.get(row.message_id) ?? [];
        list.push({ actorId: row.actor_id, label: row.label ?? undefined });
        mentionsByMessage.set(row.message_id, list);
      }
      for (const row of queryAllDynamic<AttachmentRow>(
        this.readDb,
        `SELECT * FROM message_attachments WHERE message_id IN (${marks}) ORDER BY message_id, id`,
        [...chunk],
      )) {
        const list = attachmentsByMessage.get(row.message_id) ?? [];
        list.push({
          id: row.id,
          mediaType: row.media_type,
          fileName: row.file_name ?? undefined,
          blobKey: row.blob_key ?? undefined,
          url: row.url ?? undefined,
          metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
        });
        attachmentsByMessage.set(row.message_id, list);
      }
      for (const row of rows) {
        found.set(row.id, messageRecordFromRow(
          row,
          mentionsByMessage.get(row.id),
          attachmentsByMessage.get(row.id),
        ));
      }
    }
    return this.historicalFallback("message", ids, found);
  }

  readInvocations(ids: readonly string[]): Map<string, InvocationRequest> {
    const found = new Map<string, InvocationRequest>();
    for (const chunk of chunksOf(ids)) {
      const marks = chunk.map(() => "?").join(", ");
      for (const row of queryAllDynamic<InvocationRow>(
        this.readDb,
        `SELECT * FROM invocations WHERE id IN (${marks})`,
        [...chunk],
      )) {
        found.set(row.id, invocationRequestFromRow(row));
      }
    }
    return this.historicalFallback("invocation", ids, found);
  }

  readFlights(ids: readonly string[]): Map<string, FlightRecord> {
    const found = new Map<string, FlightRecord>();
    for (const chunk of chunksOf(ids)) {
      const marks = chunk.map(() => "?").join(", ");
      for (const row of queryAllDynamic<FlightRow>(
        this.readDb,
        `SELECT * FROM flights WHERE id IN (${marks})`,
        [...chunk],
      )) {
        found.set(row.id, flightRecordFromRow(row));
      }
    }
    return this.historicalFallback("flight", ids, found);
  }

  readDeliveries(ids: readonly string[]): Map<string, DeliveryIntent> {
    const found = new Map<string, DeliveryIntent>();
    for (const chunk of chunksOf(ids)) {
      const rows = this.drizzleReadDb
        .select()
        .from(deliveriesTable)
        .where(inArray(deliveriesTable.id, [...chunk]))
        .all() as DeliveryProjectionRow[];
      for (const row of rows) {
        found.set(row.id, deliveryIntentFromRow(row));
      }
    }
    return this.historicalFallback("delivery", ids, found);
  }

  readDeliveryAttempts(ids: readonly string[]): Map<string, DeliveryAttempt> {
    const found = new Map<string, DeliveryAttempt>();
    for (const chunk of chunksOf(ids)) {
      const rows = this.drizzleReadDb
        .select()
        .from(deliveryAttemptsTable)
        .where(inArray(deliveryAttemptsTable.id, [...chunk]))
        .all() as DeliveryAttemptProjectionRow[];
      for (const row of rows) {
        found.set(row.id, deliveryAttemptFromRow(row));
      }
    }
    return this.historicalFallback("delivery_attempt", ids, found);
  }

  readCollaborationEvents(ids: readonly string[]): Map<string, CollaborationEvent> {
    const found = new Map<string, CollaborationEvent>();
    for (const chunk of chunksOf(ids)) {
      const marks = chunk.map(() => "?").join(", ");
      for (const row of queryAllDynamic<CollaborationEventRow>(
        this.readDb,
        `SELECT * FROM collaboration_events WHERE id IN (${marks})`,
        [...chunk],
      )) {
        found.set(row.id, collaborationEventFromRow(row));
      }
    }
    return this.historicalFallback("collaboration_event", ids, found);
  }

  updateDeliveryStatus(
    deliveryId: string,
    status: DeliveryIntent["status"],
    options: {
      metadata?: Record<string, unknown> | undefined;
      leaseOwner?: string | null;
      leaseExpiresAt?: number | null;
    } = {},
  ): void {
    const current = this.drizzleDb
      .select({ metadataJson: deliveriesTable.metadataJson })
      .from(deliveriesTable)
      .where(eq(deliveriesTable.id, deliveryId))
      .get();
    const mergedMetadata = options.metadata
      ? {
          ...parseJson<Record<string, unknown>>(current?.metadataJson, {}),
          ...options.metadata,
        }
      : current?.metadataJson
        ? parseJson<Record<string, unknown>>(current.metadataJson, {})
        : undefined;

    this.drizzleDb
      .update(deliveriesTable)
      .set({
        status,
        leaseOwner: options.leaseOwner ?? null,
        leaseExpiresAt: options.leaseExpiresAt ?? null,
        metadataJson: stringify(mergedMetadata),
      })
      .where(eq(deliveriesTable.id, deliveryId))
      .run();
  }

  listDeliveryAttempts(deliveryId: string): DeliveryAttempt[] {
    const rows = this.drizzleReadDb
      .select()
      .from(deliveryAttemptsTable)
      .where(eq(deliveryAttemptsTable.deliveryId, deliveryId))
      .orderBy(asc(deliveryAttemptsTable.attempt), asc(deliveryAttemptsTable.createdAt))
      .all();

    return (rows as DeliveryAttemptProjectionRow[]).map(deliveryAttemptFromRow);
  }

  recordDeliveryAttempt(attempt: DeliveryAttempt): void {
    this.drizzleDb
      .insert(deliveryAttemptsTable)
      .values({
        id: attempt.id,
        deliveryId: attempt.deliveryId,
        attempt: attempt.attempt,
        status: attempt.status,
        error: attempt.error ?? null,
        externalRef: attempt.externalRef ?? null,
        metadataJson: stringify(attempt.metadata),
        createdAt: attempt.createdAt,
      })
      .onConflictDoUpdate({
        target: deliveryAttemptsTable.id,
        set: {
          deliveryId: attempt.deliveryId,
          attempt: attempt.attempt,
          status: attempt.status,
          error: attempt.error ?? null,
          externalRef: attempt.externalRef ?? null,
          metadataJson: stringify(attempt.metadata),
          createdAt: attempt.createdAt,
        },
      })
      .run();
  }

  createOrGetDurableAction(input: DurableActionCreateInput): {
    action: DurableAction;
    duplicate: boolean;
  } {
    const existing = input.idempotencyKey
      ? queryGet<DurableActionRow, [string, string, string]>(
          this.db,
          `SELECT * FROM durable_actions
           WHERE authority_cell_id = ?1 AND kind = ?2 AND idempotency_key = ?3`,
          input.authorityCellId,
          input.kind,
          input.idempotencyKey,
        )
      : queryGet<DurableActionRow, [string]>(
          this.db,
          "SELECT * FROM durable_actions WHERE id = ?1",
          input.id,
        );
    if (existing) {
      return { action: durableActionFromRow(existing), duplicate: true };
    }

    const action: DurableAction = {
      id: input.id,
      kind: input.kind,
      subjectId: input.subjectId,
      authorityCellId: input.authorityCellId,
      state: "pending",
      idempotencyKey: input.idempotencyKey,
      leaseGeneration: 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      metadata: input.metadata,
    };
    this.recordDurableAction(action);
    return { action, duplicate: false };
  }

  recordDurableAction(action: DurableAction): void {
    this.db.query(
      `INSERT INTO durable_actions (
        id, kind, subject_id, authority_cell_id, state, idempotency_key, lease_owner,
        lease_generation, lease_expires_at, metadata_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT DO UPDATE SET
        kind = excluded.kind,
        subject_id = excluded.subject_id,
        authority_cell_id = excluded.authority_cell_id,
        state = excluded.state,
        idempotency_key = excluded.idempotency_key,
        lease_owner = excluded.lease_owner,
        lease_generation = excluded.lease_generation,
        lease_expires_at = excluded.lease_expires_at,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
    ).run(
      action.id,
      action.kind,
      action.subjectId,
      action.authorityCellId,
      action.state,
      action.idempotencyKey ?? null,
      action.leaseOwner ?? null,
      action.leaseGeneration,
      action.leaseExpiresAt ?? null,
      stringify(action.metadata),
      action.createdAt,
      action.updatedAt,
    );
  }

  getDurableAction(actionId: string): DurableAction | null {
    const row = queryGet<DurableActionRow, [string]>(
      this.readDb,
      "SELECT * FROM durable_actions WHERE id = ?1",
      actionId,
    );
    return row ? durableActionFromRow(row) : null;
  }

  getDurableActionByIdempotencyKey(input: {
    authorityCellId: string;
    kind: DurableAction["kind"];
    idempotencyKey: string;
  }): DurableAction | null {
    const row = queryGet<DurableActionRow, [string, string, string]>(
      this.readDb,
      `SELECT * FROM durable_actions
       WHERE authority_cell_id = ?1 AND kind = ?2 AND idempotency_key = ?3`,
      input.authorityCellId,
      input.kind,
      input.idempotencyKey,
    );
    return row ? durableActionFromRow(row) : null;
  }

  listDueDurableActions(input: {
    kind?: DurableAction["kind"];
    authorityCellId?: string;
    dueAtLte: number;
    claimableAt?: number;
    limit?: number;
  }): DurableAction[] {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
    const claimableAt = input.claimableAt ?? input.dueAtLte;
    const where: string[] = [
      `(
        state IN ('pending', 'waiting')
        OR (
          state NOT IN ('completed', 'failed', 'cancelled')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?1
        )
      )`,
      `COALESCE(
        CAST(json_extract(metadata_json, '$.dueAt') AS REAL),
        CAST(json_extract(metadata_json, '$.due_at') AS REAL)
      ) <= ?2`,
    ];
    const params: Array<string | number> = [claimableAt, input.dueAtLte];

    if (input.kind) {
      params.push(input.kind);
      where.push(`kind = ?${params.length}`);
    }
    if (input.authorityCellId) {
      params.push(input.authorityCellId);
      where.push(`authority_cell_id = ?${params.length}`);
    }
    params.push(limit);

    const rows = this.readDb.query(
      `SELECT *
       FROM durable_actions
       WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(
         CAST(json_extract(metadata_json, '$.dueAt') AS REAL),
         CAST(json_extract(metadata_json, '$.due_at') AS REAL)
       ) ASC,
       updated_at ASC
       LIMIT ?${params.length}`,
    ).all(...params) as DurableActionRow[];
    return rows.map(durableActionFromRow);
  }

  claimDurableAction(input: DurableActionClaimInput): DurableAction | null {
    const current = queryGet<DurableActionRow, [string]>(
      this.db,
      "SELECT * FROM durable_actions WHERE id = ?1",
      input.actionId,
    );
    if (!current) {
      return null;
    }
    const now = input.claimedAt;
    const terminal = current.state === "completed"
      || current.state === "failed"
      || current.state === "cancelled";
    const leaseExpired = current.lease_expires_at !== null && current.lease_expires_at <= now;
    const claimable = current.state === "pending"
      || current.state === "waiting"
      || (!terminal && leaseExpired);
    if (!claimable) {
      return durableActionFromRow(current);
    }

    const nextGeneration = current.lease_generation + 1;
    const leaseExpiresAt = now + input.leaseMs;
    const result = this.db.query(
      `UPDATE durable_actions
       SET state = 'leased',
           lease_owner = ?2,
           lease_generation = ?3,
           lease_expires_at = ?4,
           updated_at = ?5
       WHERE id = ?1
         AND lease_generation = ?6
         AND (
           state IN ('pending', 'waiting')
           OR (
             state NOT IN ('completed', 'failed', 'cancelled')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?5
           )
         )`,
    ).run(
      input.actionId,
      input.owner,
      nextGeneration,
      leaseExpiresAt,
      now,
      current.lease_generation,
    ) as { changes?: number };

    if ((result.changes ?? 0) === 0) {
      // Claim loss is represented by returning the current action. Callers
      // determine ownership by comparing leaseOwner/leaseGeneration to their
      // requested owner and the expected next generation.
      return this.getDurableAction(input.actionId);
    }

    return this.getDurableAction(input.actionId);
  }

  heartbeatDurableAction(input: DurableActionHeartbeatInput): DurableAction | null {
    const leaseExpiresAt = input.heartbeatAt + input.leaseMs;
    const result = this.db.query(
      `UPDATE durable_actions
       SET lease_expires_at = ?4,
           updated_at = ?5
       WHERE id = ?1
         AND lease_owner = ?2
         AND lease_generation = ?3
         AND state NOT IN ('completed', 'failed', 'cancelled')`,
    ).run(
      input.actionId,
      input.owner,
      input.generation,
      leaseExpiresAt,
      input.heartbeatAt,
    ) as { changes?: number };

    return (result.changes ?? 0) > 0
      ? this.getDurableAction(input.actionId)
      : null;
  }

  transitionDurableAction(input: {
    actionId: string;
    owner: string;
    generation: number;
    nextState: DurableAction["state"];
    transitionedAt: number;
    metadata?: Record<string, unknown>;
  }): DurableAction | null {
    const current = queryGet<DurableActionRow, [string]>(
      this.db,
      "SELECT * FROM durable_actions WHERE id = ?1",
      input.actionId,
    );
    if (!current || current.lease_owner !== input.owner || current.lease_generation !== input.generation) {
      return null;
    }
    const metadata = input.metadata
      ? {
          ...parseJson<Record<string, unknown>>(current.metadata_json, {}),
          ...input.metadata,
        }
      : parseJson<Record<string, unknown> | undefined>(current.metadata_json, undefined);
    this.db.query(
      `UPDATE durable_actions
       SET state = ?2,
           metadata_json = ?3,
           updated_at = ?4
       WHERE id = ?1`,
    ).run(input.actionId, input.nextState, stringify(metadata), input.transitionedAt);
    return this.getDurableAction(input.actionId);
  }

  startDurableAttempt(input: {
    id: string;
    actionId: string;
    owner: string;
    generation: number;
    startedAt: number;
    metadata?: Record<string, unknown>;
  }): DurableAttempt | null {
    const createAttempt = (this.db as SQLiteTransactionalDatabase).transaction(
      (): DurableAttempt | null => {
        const action = queryGet<DurableActionRow, [string]>(
          this.db,
          "SELECT * FROM durable_actions WHERE id = ?1",
          input.actionId,
        );
        if (!action || action.lease_owner !== input.owner || action.lease_generation !== input.generation) {
          return null;
        }
        const attemptNumber = (queryGet<{ next_attempt: number | null }, [string]>(
          this.db,
          "SELECT MAX(attempt) + 1 AS next_attempt FROM durable_attempts WHERE action_id = ?1",
          input.actionId,
        )?.next_attempt ?? 1);
        const attempt: DurableAttempt = {
          id: input.id,
          actionId: input.actionId,
          attempt: attemptNumber,
          state: "running",
          leaseGeneration: input.generation,
          startedAt: input.startedAt,
          metadata: input.metadata,
        };
        this.recordDurableAttempt(attempt);
        return attempt;
      },
    );
    try {
      return createAttempt();
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        return null;
      }
      throw error;
    }
  }

  recordDurableAttempt(attempt: DurableAttempt): void {
    this.db.query(
      `INSERT INTO durable_attempts (
        id, action_id, attempt, state, lease_generation, error, started_at,
        completed_at, metadata_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(id) DO UPDATE SET
        action_id = excluded.action_id,
        attempt = excluded.attempt,
        state = excluded.state,
        lease_generation = excluded.lease_generation,
        error = excluded.error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        metadata_json = excluded.metadata_json`,
    ).run(
      attempt.id,
      attempt.actionId,
      attempt.attempt,
      attempt.state,
      attempt.leaseGeneration,
      attempt.error ?? null,
      attempt.startedAt ?? null,
      attempt.completedAt ?? null,
      stringify(attempt.metadata),
    );
  }

  listDurableAttempts(actionId: string): DurableAttempt[] {
    return queryAll<DurableAttemptRow, [string]>(
      this.readDb,
      "SELECT * FROM durable_attempts WHERE action_id = ?1 ORDER BY attempt ASC",
      actionId,
    ).map(durableAttemptFromRow);
  }

  commitDurableCheckpoint(checkpoint: DurableCheckpoint): {
    checkpoint: DurableCheckpoint;
    duplicate: boolean;
  } | null {
    if (!this.durableFactLeaseMatches(
      checkpoint.actionId,
      checkpoint.leaseOwner,
      checkpoint.leaseGeneration,
    )) {
      return null;
    }
    if (checkpoint.ownerAttemptId && !this.durableAttemptStillOwnsAction(
      checkpoint.actionId,
      checkpoint.ownerAttemptId,
    )) {
      return null;
    }
    const existing = queryGet<DurableCheckpointRow, [string, string]>(
      this.db,
      "SELECT * FROM durable_checkpoints WHERE action_id = ?1 AND name = ?2",
      checkpoint.actionId,
      checkpoint.name,
    );
    if (existing) {
      return { checkpoint: durableCheckpointFromRow(existing), duplicate: true };
    }
    this.db.query(
      `INSERT INTO durable_checkpoints (
        action_id, name, payload_json, owner_attempt_id, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).run(
      checkpoint.actionId,
      checkpoint.name,
      stringify(checkpoint.payload),
      checkpoint.ownerAttemptId ?? null,
      checkpoint.createdAt,
    );
    return { checkpoint, duplicate: false };
  }

  emitDurableSignal(signal: DurableSignal): {
    signal: DurableSignal;
    duplicate: boolean;
  } | null {
    if (!this.durableFactLeaseMatches(
      signal.actionId,
      signal.leaseOwner,
      signal.leaseGeneration,
    )) {
      return null;
    }
    const existing = queryGet<DurableSignalRow, [string, string]>(
      this.db,
      "SELECT * FROM durable_signals WHERE action_id = ?1 AND name = ?2",
      signal.actionId,
      signal.name,
    );
    if (existing) {
      return { signal: durableSignalFromRow(existing), duplicate: true };
    }
    this.db.query(
      "INSERT INTO durable_signals (action_id, name, payload_json, emitted_at) VALUES (?1, ?2, ?3, ?4)",
    ).run(signal.actionId, signal.name, stringify(signal.payload), signal.emittedAt);
    return { signal, duplicate: false };
  }

  private durableFactLeaseMatches(
    actionId: string,
    owner: string | undefined,
    generation: number | undefined,
  ): boolean {
    if (!owner && generation === undefined) {
      // Undefined lease identity is the journal replay path. Live command
      // callers should pass both fields so stale owners cannot write facts.
      return true;
    }
    if (!owner || generation === undefined) {
      return false;
    }
    const action = queryGet<DurableActionRow, [string]>(
      this.db,
      "SELECT * FROM durable_actions WHERE id = ?1",
      actionId,
    );
    return Boolean(
      action
      && action.lease_owner === owner
      && action.lease_generation === generation
      && action.state !== "completed"
      && action.state !== "failed"
      && action.state !== "cancelled",
    );
  }

  private durableAttemptStillOwnsAction(
    actionId: string,
    attemptId: string,
  ): boolean {
    const attempt = queryGet<DurableAttemptRow, [string, string]>(
      this.db,
      "SELECT * FROM durable_attempts WHERE id = ?1 AND action_id = ?2",
      attemptId,
      actionId,
    );
    if (!attempt) {
      return false;
    }
    const action = queryGet<DurableActionRow, [string]>(
      this.db,
      "SELECT * FROM durable_actions WHERE id = ?1",
      actionId,
    );
    return Boolean(
      action
      && action.lease_generation === attempt.lease_generation
      && action.state !== "completed"
      && action.state !== "failed"
      && action.state !== "cancelled",
    );
  }

  private recordActivityItem(item: ActivityItem): void {
    this.db.query(
      `INSERT OR REPLACE INTO activity_items (
        id, kind, ts, conversation_id, message_id, invocation_id, flight_id, record_id,
        actor_id, counterpart_id, agent_id, workspace_root, session_id, title, summary, payload_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).run(
      item.id,
      item.kind,
      item.ts,
      item.conversationId ?? null,
      item.messageId ?? null,
      item.invocationId ?? null,
      item.flightId ?? null,
      item.recordId ?? null,
      item.actorId ?? null,
      item.counterpartId ?? null,
      item.agentId ?? null,
      item.workspaceRoot ?? null,
      item.sessionId ?? null,
      item.title ?? null,
      item.summary ?? null,
      stringify(item.payload),
    );
  }

  private projectMessageActivity(message: MessageRecord): ActivityItem {
    const agentId = this.resolveActivityAgentIdForMessage(message);
    const counterpartId = this.resolveCounterpartIdForMessage(message, agentId);
    const agentContext = this.resolveAgentContext(agentId);
    const kind = this.classifyMessageActivity(message, agentId, counterpartId);
    const bodySummary = summarizeText(message.body);

    return {
      id: `activity:message:${message.id}`,
      kind,
      ts: message.createdAt,
      conversationId: message.conversationId,
      messageId: message.id,
      actorId: message.actorId,
      counterpartId: counterpartId ?? undefined,
      agentId: agentId ?? undefined,
      workspaceRoot: agentContext.workspaceRoot ?? undefined,
      sessionId: agentContext.sessionId ?? undefined,
      title: bodySummary,
      summary: kind === "status_message" || kind === "ask_working" || kind === "ask_failed"
        ? bodySummary
        : undefined,
      payload: {
        class: message.class,
        replyToMessageId: message.replyToMessageId ?? null,
        mentionActorIds: (message.mentions ?? []).map((mention) => mention.actorId),
        visibility: message.visibility,
        policy: message.policy,
        agentHarness: agentContext.harness,
      },
    };
  }

  private projectInvocationActivity(invocation: InvocationRequest): ActivityItem {
    const agentContext = this.resolveAgentContext(invocation.targetAgentId);
    return {
      id: `activity:invocation:${invocation.id}`,
      kind: "invocation_recorded",
      ts: invocation.createdAt,
      conversationId: invocation.conversationId ?? undefined,
      messageId: invocation.messageId ?? undefined,
      invocationId: invocation.id,
      actorId: invocation.requesterId,
      counterpartId: invocation.targetAgentId,
      agentId: invocation.targetAgentId,
      workspaceRoot: agentContext.workspaceRoot ?? undefined,
      sessionId: agentContext.sessionId ?? undefined,
      title: summarizeText(invocation.task),
      summary: invocation.action,
      payload: {
        action: invocation.action,
        targetNodeId: invocation.targetNodeId ?? null,
        ensureAwake: invocation.ensureAwake,
        stream: invocation.stream,
        timeoutMs: invocation.timeoutMs ?? null,
        agentHarness: agentContext.harness,
      },
    };
  }

  private projectFlightActivity(flight: FlightRecord): ActivityItem {
    const agentContext = this.resolveAgentContext(flight.targetAgentId);
    return {
      id: `activity:flight:${flight.id}`,
      kind: "flight_updated",
      ts: flight.completedAt ?? flight.startedAt ?? currentTimestampMs(),
      invocationId: flight.invocationId,
      flightId: flight.id,
      actorId: flight.requesterId,
      counterpartId: flight.targetAgentId,
      agentId: flight.targetAgentId,
      workspaceRoot: agentContext.workspaceRoot ?? undefined,
      sessionId: agentContext.sessionId ?? undefined,
      title: summarizeText(flight.summary ?? flight.state),
      summary: flight.error ?? flight.output ?? flight.summary ?? flight.state,
      payload: {
        state: flight.state,
        startedAt: flight.startedAt ?? null,
        completedAt: flight.completedAt ?? null,
        agentHarness: agentContext.harness,
      },
    };
  }

  private classifyMessageActivity(
    message: MessageRecord,
    agentId: string | null,
    counterpartId: string | null,
  ): ActivityItemKind {
    const body = message.body.toLowerCase();
    if (message.class === "status") {
      if (/failed|timed out|error/.test(body)) {
        return "ask_failed";
      }
      if (/working|running|waking|queued/.test(body)) {
        return "ask_working";
      }
      return "status_message";
    }

    if (this.isKnownAgentId(message.actorId) && counterpartId && this.isKnownAgentId(counterpartId) && counterpartId !== message.actorId) {
      return "handoff_sent";
    }

    if (message.replyToMessageId && this.isKnownAgentId(message.actorId)) {
      return "ask_replied";
    }

    if (agentId && message.actorId !== agentId && this.isDirectConversation(message.conversationId)) {
      return "ask_opened";
    }

    if (this.isKnownAgentId(message.actorId)) {
      return "agent_message";
    }

    return "message_posted";
  }

  private isDirectConversation(conversationId: string | undefined, db: ControlPlaneSqliteDatabase = this.readDb): boolean {
    if (!conversationId) {
      return false;
    }
    const row = queryGet<{ kind: string }, [string]>(
      db,
      "SELECT kind FROM conversations WHERE id = ?1 LIMIT 1",
      conversationId,
    );
    return row?.kind === "direct";
  }

  private resolveActivityAgentIdForMessage(message: MessageRecord): string | null {
    if (message.class === "status" && typeof message.metadata?.targetAgentId === "string" && this.isKnownAgentId(message.metadata.targetAgentId)) {
      return message.metadata.targetAgentId;
    }

    if (this.isKnownAgentId(message.actorId)) {
      return message.actorId;
    }

    const mentionedAgentIds = Array.from(new Set(
      (message.mentions ?? [])
        .map((mention) => mention.actorId)
        .filter((actorId) => this.isKnownAgentId(actorId)),
    ));
    if (mentionedAgentIds.length === 1) {
      return mentionedAgentIds[0] ?? null;
    }

    const conversationAgents = this.listConversationAgentIds(message.conversationId).filter((actorId) => actorId !== message.actorId);
    if (conversationAgents.length === 1) {
      return conversationAgents[0] ?? null;
    }

    return null;
  }

  private resolveCounterpartIdForMessage(message: MessageRecord, agentId: string | null): string | null {
    const conversationMembers = this.listConversationMemberIds(message.conversationId).filter((actorId) => actorId !== message.actorId);
    if (agentId && message.actorId !== agentId) {
      return message.actorId;
    }

    const explicitMentions = (message.mentions ?? [])
      .map((mention) => mention.actorId)
      .filter((actorId) => actorId !== message.actorId);
    if (explicitMentions.length === 1) {
      return explicitMentions[0] ?? null;
    }

    if (conversationMembers.length === 1) {
      return conversationMembers[0] ?? null;
    }

    return null;
  }

  private listConversationAgentIds(conversationId: string | undefined, db: ControlPlaneSqliteDatabase = this.readDb): string[] {
    if (!conversationId) {
      return [];
    }

    return queryAll<{ actor_id: string }, [string]>(
      db,
      `SELECT cm.actor_id
      FROM conversation_members cm
      JOIN agents a ON a.id = cm.actor_id
      WHERE cm.conversation_id = ?1`,
      conversationId,
    ).map((row) => row.actor_id);
  }

  private listConversationMemberIds(conversationId: string | undefined, db: ControlPlaneSqliteDatabase = this.readDb): string[] {
    if (!conversationId) {
      return [];
    }

    return queryAll<{ actor_id: string }, [string]>(
      db,
      "SELECT actor_id FROM conversation_members WHERE conversation_id = ?1",
      conversationId,
    ).map((row) => row.actor_id);
  }

  private isKnownAgentId(actorId: string | undefined | null, db: ControlPlaneSqliteDatabase = this.readDb): actorId is string {
    if (!actorId) {
      return false;
    }

    const row = queryGet<{ id: string }, [string]>(
      db,
      "SELECT id FROM agents WHERE id = ?1 LIMIT 1",
      actorId,
    );
    return Boolean(row?.id);
  }

  /** Where the agent works and what runs it, read from its latest endpoint
      when an activity is recorded — so the activity carries its own context
      and readers never join back to a roster that may have moved on. */
  private resolveAgentContext(agentId: string | undefined | null): {
    workspaceRoot: string | null;
    sessionId: string | null;
    harness: string | null;
  } {
    if (!agentId) {
      return { workspaceRoot: null, sessionId: null, harness: null };
    }

    const row = queryGet<Pick<EndpointRow, "project_root" | "cwd" | "session_id" | "harness">, [string]>(
      this.readDb,
      `SELECT project_root, cwd, session_id, harness
      FROM agent_endpoints
      WHERE agent_id = ?1
      ORDER BY updated_at DESC
      LIMIT 1`,
      agentId,
    );

    return {
      workspaceRoot: row?.project_root ?? row?.cwd ?? null,
      sessionId: row?.session_id ?? null,
      harness: row?.harness || null,
    };
  }

  /**
   * SCO-031 §5: lazy singleton `Conversations` api bound to this store.
   * Callers do `store.conversations.findById(id)` rather than reaching for
   * `getConversation` directly. The api owns conversation identity logic
   * (legacy structural-ID parsing, future `ensureByNaturalKey` semantics).
   */
  get conversations(): ConversationsApi {
    if (!this.conversationsApi) {
      this.conversationsApi = new Conversations(this);
    }
    return this.conversationsApi;
  }

  /**
   * @internal SCO-031: writer-side SQLite database exposed to `Conversations`
   * so the api can issue conversation-only queries without opening a third
   * connection. Not part of the public API; downstream code should go through
   * `store.conversations` or other purpose-built methods.
   */
  get writerDb(): ControlPlaneSqliteDatabase {
    return this.db;
  }

  /**
   * Run one synchronous startup-replay batch atomically. Store methods normally
   * read through the separate read-only connection, but dependencies written
   * earlier in this transaction must be visible while deriving activity and
   * thread records. The normal reader is restored even when a write throws.
   */
  runReplayTransaction(operation: () => void): void {
    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      const previousReadDb = this.readDb;
      this.readDb = this.db;
      try {
        operation();
      } finally {
        this.readDb = previousReadDb;
      }
    })();
  }

  /**
   * @internal SCO-031: read-side SQLite database (PRAGMA `query_only`) exposed to
   * `Conversations`. Same caveats as `writerDb` — internal only.
   */
  get readerDb(): ControlPlaneSqliteDatabase {
    return this.readDb;
  }

  /**
   * Load the canonical `ConversationDefinition` for a conversation id, or
   * `null` when the row is unknown. Promoted to public per SCO-031 §13 Q3 so
   * `Conversations.findById` can call it without reaching into a private — the
   * api (`packages/runtime/src/conversations/api.ts`) is the intended caller.
   * Other call sites should prefer `store.conversations.findById` over
   * invoking this directly.
   */
  getConversation(conversationId: string, db: ControlPlaneSqliteDatabase = this.db): ConversationDefinition | null {
    const row = queryGet<ConversationRow, [string]>(
      db,
      "SELECT * FROM conversations WHERE id = ?1 LIMIT 1",
      conversationId,
    );
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      visibility: row.visibility,
      shareMode: row.share_mode,
      authorityNodeId: row.authority_node_id,
      participantIds: this.listConversationMemberIds(row.id, db),
      topic: row.topic ?? undefined,
      parentConversationId: row.parent_conversation_id ?? undefined,
      messageId: row.message_id ?? undefined,
      metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    };
  }

  private buildThreadEvent(row: ThreadEventRow): ThreadEventEnvelope {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      authorityNodeId: row.authority_node_id,
      seq: row.seq,
      kind: row.kind,
      actorId: row.actor_id ?? undefined,
      ts: row.ts,
      payload: parseJson<ThreadEventEnvelope["payload"]>(
        row.payload_json,
        {} as ThreadEventEnvelope["payload"],
      ),
      notification: parseJson<ThreadEventNotification | undefined>(
        row.notification_json,
        undefined,
      ),
    };
  }

  private threadModeForConversation(conversation: ConversationDefinition): "summary" | "shared" {
    return conversation.shareMode === "summary" ? "summary" : "shared";
  }

  private appendThreadEvent(input: ThreadEventInsert): ThreadEventEnvelope {
    const existing = queryGet<ThreadEventRow, [string]>(
      this.db,
      "SELECT * FROM thread_events WHERE id = ?1 LIMIT 1",
      input.id,
    );
    if (existing) {
      return this.buildThreadEvent(existing);
    }

    const nextSeqRow = queryGet<{ next_seq: number | null }, [string]>(
      this.db,
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM thread_events WHERE conversation_id = ?1",
      input.conversation.id,
    );
    const seq = nextSeqRow?.next_seq ?? 1;

    this.db.query(
      `INSERT INTO thread_events (
        id, conversation_id, authority_node_id, seq, kind, actor_id, ts, payload_json, notification_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).run(
      input.id,
      input.conversation.id,
      input.conversation.authorityNodeId,
      seq,
      input.kind,
      input.actorId ?? null,
      input.ts,
      JSON.stringify(input.payload),
      stringify(input.notification),
    );

    return {
      id: input.id,
      conversationId: input.conversation.id,
      authorityNodeId: input.conversation.authorityNodeId,
      seq,
      kind: input.kind,
      actorId: input.actorId,
      ts: input.ts,
      payload: input.payload,
      notification: input.notification,
    };
  }

  private recordThreadMessageEvent(message: MessageRecord): ThreadEventEnvelope[] {
    const input = this.buildThreadMessageEvent(message);
    return input ? [this.appendThreadEvent(input)] : [];
  }

  private buildThreadMessageEvent(message: MessageRecord, db: ControlPlaneSqliteDatabase = this.db): ThreadEventInsert | null {
    const conversation = this.getConversation(message.conversationId, db);
    if (!conversation) {
      return null;
    }

    const payload = this.threadModeForConversation(conversation) === "summary"
      ? { message: this.buildThreadMessageSummary(message) }
      : { message };

    return {
      id: `thread-event:message:${message.id}:${message.createdAt}`,
      conversation,
      kind: "message.posted",
      actorId: message.actorId,
      ts: message.createdAt,
      payload,
      notification: this.buildMessageThreadNotification(message, db),
    };
  }

  private recordThreadFlightEvent(flight: FlightRecord): ThreadEventEnvelope[] {
    const invocation = queryGet<Pick<InvocationRow, "conversation_id">, [string]>(
      this.db,
      "SELECT conversation_id FROM invocations WHERE id = ?1 LIMIT 1",
      flight.invocationId,
    );
    if (!invocation?.conversation_id) {
      return [];
    }

    const conversation = this.getConversation(invocation.conversation_id);
    if (!conversation) {
      return [];
    }

    const payload = this.threadModeForConversation(conversation) === "summary"
      ? { flight: this.buildThreadFlightSummary(flight) }
      : { flight };
    const ts = flight.completedAt ?? flight.startedAt ?? currentTimestampMs();

    return [this.appendThreadEvent({
      id: `thread-event:flight:${flight.id}:${flight.state}:${ts}`,
      conversation,
      kind: "flight.updated",
      actorId: flight.requesterId,
      ts,
      payload,
      notification: this.buildFlightThreadNotification(flight),
    })];
  }

  private recordThreadCollaborationEvent(record: CollaborationRecord): ThreadEventEnvelope[] {
    if (!record.conversationId) {
      return [];
    }

    const conversation = this.getConversation(record.conversationId);
    if (!conversation) {
      return [];
    }

    const payload = this.threadModeForConversation(conversation) === "summary"
      ? { record: this.buildThreadCollaborationSummary(record) }
      : { record };

    return [this.appendThreadEvent({
      id: `thread-event:collaboration:${record.id}:${record.updatedAt}`,
      conversation,
      kind: "collaboration.upserted",
      actorId: record.createdById,
      ts: record.updatedAt,
      payload,
      notification: this.buildCollaborationThreadNotification(record),
    })];
  }

  private recordThreadCollaborationEventAppend(event: CollaborationEvent): ThreadEventEnvelope[] {
    const record = queryGet<CollaborationRecordRow, [string]>(
      this.db,
      "SELECT * FROM collaboration_records WHERE id = ?1 LIMIT 1",
      event.recordId,
    );
    if (!record?.conversation_id) {
      return [];
    }

    const conversation = this.getConversation(record.conversation_id);
    if (!conversation) {
      return [];
    }

    const payload = this.threadModeForConversation(conversation) === "summary"
      ? { event: this.buildThreadCollaborationEventSummary(event) }
      : { event };

    return [this.appendThreadEvent({
      id: `thread-event:collaboration-event:${event.id}:${event.at}`,
      conversation,
      kind: "collaboration.event.appended",
      actorId: event.actorId,
      ts: event.at,
      payload,
      notification: undefined,
    })];
  }

  private buildThreadMessageSummary(message: MessageRecord): ThreadMessageSummary {
    return {
      id: message.id,
      actorId: message.actorId,
      class: message.class,
      replyToMessageId: message.replyToMessageId,
      threadConversationId: message.threadConversationId,
      mentionActorIds: (message.mentions ?? []).map((mention) => mention.actorId),
      createdAt: message.createdAt,
      summary: summarizeText(message.body),
    };
  }

  private buildThreadFlightSummary(flight: FlightRecord): ThreadFlightSummary {
    return {
      id: flight.id,
      invocationId: flight.invocationId,
      requesterId: flight.requesterId,
      targetAgentId: flight.targetAgentId,
      state: flight.state,
      summary: flight.summary,
      error: flight.error,
      startedAt: flight.startedAt,
      completedAt: flight.completedAt,
    };
  }

  private buildThreadCollaborationSummary(record: CollaborationRecord): ThreadCollaborationSummary {
    return {
      id: record.id,
      kind: record.kind,
      state: record.state,
      acceptanceState: record.acceptanceState,
      title: record.title,
      summary: record.summary,
      ownerId: record.ownerId,
      nextMoveOwnerId: record.nextMoveOwnerId,
      updatedAt: record.updatedAt,
    };
  }

  private buildThreadCollaborationEventSummary(event: CollaborationEvent): ThreadCollaborationEventSummary {
    return {
      id: event.id,
      recordId: event.recordId,
      recordKind: event.recordKind,
      kind: event.kind,
      actorId: event.actorId,
      at: event.at,
      summary: event.summary,
    };
  }

  private buildMessageThreadNotification(message: MessageRecord, db: ControlPlaneSqliteDatabase = this.db): ThreadEventNotification | undefined {
    const mentionActorIds = [...new Set(
      (message.mentions ?? [])
        .map((mention) => mention.actorId)
        .filter((actorId) => actorId && actorId !== message.actorId),
    )];
    if (mentionActorIds.length > 0) {
      return {
        tier: "badge",
        targetActorIds: mentionActorIds,
        reason: "mention",
        summary: summarizeText(message.body, 80),
      };
    }

    if (!message.replyToMessageId) {
      return undefined;
    }

    const replyTarget = queryGet<{ actor_id: string }, [string]>(
      db,
      "SELECT actor_id FROM messages WHERE id = ?1 LIMIT 1",
      message.replyToMessageId,
    );
    if (!replyTarget?.actor_id || replyTarget.actor_id === message.actorId) {
      return undefined;
    }

    return {
      tier: "badge",
      targetActorIds: [replyTarget.actor_id],
      reason: "thread_reply",
      summary: summarizeText(message.body, 80),
    };
  }

  private buildFlightThreadNotification(flight: FlightRecord): ThreadEventNotification | undefined {
    if (flight.state === "completed") {
      return {
        tier: "badge",
        targetActorIds: [flight.requesterId],
        reason: "flight_completed",
        summary: summarizeText(flight.summary ?? `${flight.targetAgentId} completed`, 80),
      };
    }

    if (flight.state === "failed") {
      return {
        tier: "interrupt",
        targetActorIds: [flight.requesterId],
        reason: "flight_failed",
        summary: summarizeText(flight.error ?? flight.summary ?? `${flight.targetAgentId} failed`, 80),
      };
    }

    return undefined;
  }

  private buildCollaborationThreadNotification(record: CollaborationRecord): ThreadEventNotification | undefined {
    if (!record.nextMoveOwnerId || record.nextMoveOwnerId === record.createdById) {
      return undefined;
    }

    return {
      tier: "badge",
      targetActorIds: [record.nextMoveOwnerId],
      reason: "next_move",
      summary: summarizeText(record.summary ?? record.title, 80),
    };
  }

  private listConversationThreadMessages(
    conversation: ConversationDefinition,
  ): ThreadSnapshot["messages"] {
    const snapshot = this.loadSnapshot();
    const messages = Object.values(snapshot.messages)
      .filter((message) => message.conversationId === conversation.id)
      .sort((lhs, rhs) => lhs.createdAt - rhs.createdAt);

    return messages.map((message) => (
      this.threadModeForConversation(conversation) === "summary"
        ? this.buildThreadMessageSummary(message)
        : message
    ));
  }

  private listConversationThreadCollaboration(
    conversation: ConversationDefinition,
  ): ThreadSnapshot["collaboration"] {
    const snapshot = this.loadSnapshot();
    const records = Object.values(snapshot.collaborationRecords)
      .filter((record) => record.conversationId === conversation.id)
      .sort((lhs, rhs) => lhs.updatedAt - rhs.updatedAt);

    return records.map((record) => (
      this.threadModeForConversation(conversation) === "summary"
        ? this.buildThreadCollaborationSummary(record)
        : record
    ));
  }

  private listConversationThreadFlights(
    conversation: ConversationDefinition,
  ): ThreadSnapshot["activeFlights"] {
    const rows = queryAll<FlightRow, [string]>(
      this.readDb,
      `SELECT f.*
      FROM flights f
      JOIN invocations i ON i.id = f.invocation_id
      WHERE i.conversation_id = ?1
        AND f.state IN ('queued', 'waking', 'running', 'waiting')
      ORDER BY COALESCE(f.completed_at, f.started_at, 0) ASC`,
      conversation.id,
    );

    return rows.map((row) => {
      const flight: FlightRecord = {
        id: row.id,
        invocationId: row.invocation_id,
        requesterId: row.requester_id,
        targetAgentId: row.target_agent_id,
        state: row.state,
        summary: row.summary ?? undefined,
        output: row.output ?? undefined,
        error: row.error ?? undefined,
        labels: parseJson<string[] | undefined>(row.labels_json, undefined),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
      };

      return this.threadModeForConversation(conversation) === "summary"
        ? this.buildThreadFlightSummary(flight)
        : flight;
    });
  }

  /** Canonical replay writes the event in the caller's transaction before its
   * checkpoint advances. Ordinary UI/event batching retains recordEvent(). */
  recordEventDurably(event: ControlEvent): void {
    this.db.query(`INSERT OR REPLACE INTO events (id, kind, actor_id, node_id, ts, payload_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).run(
      event.id, event.kind, event.actorId, event.nodeId ?? null, event.ts, JSON.stringify(event.payload),
    );
  }

  recordEvent(event: ControlEvent): void {
    this.pendingEvents.push(event);
    this.schedulePendingEventFlush();
  }
}
