import { randomUUID } from "node:crypto";

import {
  CONVERSATION_PROJECTION_VERSION,
  EPOCH_MILLISECONDS_FLOOR,
  compareConversationProjectionItems,
  conversationNaturalKey,
  epochMs,
  isOpaqueChannelId,
  observedSessionFeedId,
  scoutConversationFeedId,
  stableChannelId,
  type ConversationKind,
  type ConversationProjectionCursor,
  type ConversationProjectionDelta,
  type ConversationProjectionEvent,
  type ConversationProjectionItem,
  type ConversationProjectionSnapshot,
  type MessageRecord,
  type ObservedActivity,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { configuredOperatorActorIds } from "./conversations/legacy-ids.js";
import type { ObservedSessionProjectionUpdate } from "./observed-session-reducer.js";
import type {
  ControlPlaneSqliteDatabase,
  ControlPlaneSqliteTransactionalDatabase,
} from "./sqlite-adapter.js";

export const CONVERSATION_PROJECTION_LAUNCH_LIMIT = 32;
export const CONVERSATION_PROJECTION_MAX_LIST_LIMIT = 160;
export const CONVERSATION_PROJECTION_DEFAULT_EVENT_LIMIT = 200;
export const CONVERSATION_PROJECTION_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const CONVERSATION_PROJECTION_EVENT_MAX_ROWS = 50_000;
export const CONVERSATION_PROJECTION_EVENT_MAX_BYTES = 32 * 1_024 * 1_024;
export const CONVERSATION_PROJECTION_EVENT_PRUNE_INTERVAL = 256;
export const CONVERSATION_PROJECTION_ACTIVE_OBSERVED_LIMIT = 4_096;
const SCOUT_PROJECTION_REDIRECT_SOURCE = "__scout_feed_redirect__";
const CONVERSATION_PROJECTION_REDIRECT_LIMIT = 256;

type ProjectionMetaRow = {
  projection_id: string;
  projection_version: number;
  head_seq: number;
  min_replayable_seq: number;
  updated_at: number;
};

type ProjectionItemRow = {
  feed_id: string;
  entity_kind: string;
  kind: string;
  conversation_id: string | null;
  runtime_session_id: string | null;
  source: string | null;
  source_session_id: string | null;
  title: string | null;
  alias: string | null;
  natural_key: string | null;
  project_root: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
  agent_id: string | null;
  agent_name: string | null;
  current_branch: string | null;
  authority_node_id: string | null;
  authority_node_name: string | null;
  parent_conversation_id: string | null;
  anchor_message_id: string | null;
  activity_state: string;
  last_message_id: string | null;
  last_message_at: number | null;
  last_activity_at: number;
  message_count: number;
  unread_count: number;
  participant_count: number;
  preview: string | null;
  last_engaged_at: number | null;
  source_fresh_at: number | null;
  visibility_state: string;
  updated_seq: number;
  updated_at: number;
};

type ConversationRow = {
  id: string;
  kind: string;
  title: string;
  authority_node_id: string;
  parent_conversation_id: string | null;
  message_id: string | null;
  metadata_json: string | null;
  created_at: number;
};

type ParticipantRow = {
  actor_id: string;
  actor_kind: string | null;
  display_name: string | null;
  actor_metadata_json: string | null;
  agent_id: string | null;
  workspace_qualifier: string | null;
  agent_metadata_json: string | null;
};

type EndpointRow = {
  id: string;
  agent_id: string;
  harness: string;
  state: string;
  session_id: string | null;
  cwd: string | null;
  project_root: string | null;
  metadata_json: string | null;
  updated_at: number;
};

type LatestMessageRow = {
  id: string;
  actor_id: string;
  body: string;
  metadata_json: string | null;
  created_at: number;
};

type InvocationActivityRow = {
  state: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
};

type ProjectionEventRow = {
  seq: number;
  projection_id: string;
  ts: number;
  payload_json: string;
};

export type ConversationProjectionStoreOptions = {
  readArchivedMessage?: (id: string) => MessageRecord | undefined;
  now?: () => number;
  createProjectionId?: () => string;
  operatorActorIds?: readonly string[];
  eventRetentionMs?: number;
  eventMaxRows?: number;
  eventMaxBytes?: number;
  eventPruneInterval?: number;
};

export type ConversationProjectionMeta = {
  projectionId: string;
  projectionVersion: number;
  headSeq: number;
  minReplayableSeq: number;
  updatedAt: number;
};

export type ConversationProjectionEventPage = {
  projectionId: string;
  projectionVersion: number;
  headSeq: number;
  minReplayableSeq: number;
  cursorExpired: boolean;
  reason?: "projection_reset" | "cursor_too_old";
  events: ConversationProjectionEvent[];
  hasMore: boolean;
};

type PendingItemChange = {
  current: ConversationProjectionItem | null;
  desired: ConversationProjectionItem;
};

type ConversationProjectionGroup = {
  canonical: ConversationRow;
  members: ConversationRow[];
  naturalKey: string | null;
};

type BrokerBatchProjectionHints = {
  newMessagesByConversation: Map<string, MessageRecord[]>;
  forceUnreadRecount: Set<string>;
};

type MessageStatsRow = {
  message_count: number;
  latest_message_id: string | null;
  latest_message_at: number | null;
};

const CONVERSATION_KINDS = new Set<ConversationKind>([
  "channel",
  "direct",
  "group_direct",
  "thread",
  "system",
]);

const OBSERVED_ACTIVITIES = new Set<ObservedActivity>([
  "idle",
  "queued",
  "waking",
  "thinking",
  "executing",
  "working",
  "waiting_for_input",
  "waiting_on_actor",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
  "stalled",
  "offline",
  "unknown",
]);

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataObject(metadata: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = metadata[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metadataTimestamp(metadata: Record<string, unknown>, key: string): number {
  return epochMs(metadata[key]) ?? 0;
}

function metadataSessionId(metadata: Record<string, unknown>): string | null {
  return metadataString(metadata, "targetSessionId")
    ?? metadataString(metadata, "responderSessionId")
    ?? metadataString(metadata, "sessionId")
    ?? metadataString(metadata, "externalSessionId")
    ?? metadataString(metadata, "threadId");
}

function truncatePreview(value: string | null | undefined, maxChars = 240): string | null {
  if (value == null) return null;
  if (value.length <= maxChars) return value;
  let sliced = value.slice(0, maxChars);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

function formatChannelAlias(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function conversationAlias(row: ConversationRow, metadata: Record<string, unknown>): string | null {
  const explicit = metadataString(metadata, "alias");
  if (explicit) return explicit;
  const channel = metadataString(metadata, "channel");
  if (channel && channel !== "system") return formatChannelAlias(channel);
  return row.kind === "channel" ? formatChannelAlias(row.title) : null;
}

function humanizeWorkspaceName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const base = trimmed.split("/").at(-1)?.trim() || trimmed;
  if (!base) return null;
  return base
    .split(/[-_]+/gu)
    .filter(Boolean)
    .map((token) => `${token[0]?.toUpperCase() ?? ""}${token.slice(1)}`)
    .join(" ");
}

function endpointStateRank(state: string): number {
  switch (state) {
    case "active":
    case "working":
      return 5;
    case "waiting":
      return 4;
    case "idle":
      return 3;
    case "attaching":
    case "waking":
      return 2;
    case "registered":
      return 1;
    default:
      return 0;
  }
}

function endpointStartedAt(row: EndpointRow): number {
  const metadata = parseJsonObject(row.metadata_json);
  return Math.max(
    metadataTimestamp(metadata, "lastStartedAt"),
    metadataTimestamp(metadata, "startedAt"),
  );
}

function endpointActivityAt(row: EndpointRow): number {
  const metadata = parseJsonObject(row.metadata_json);
  return Math.max(
    metadataTimestamp(metadata, "lastCompletedAt"),
    metadataTimestamp(metadata, "lastStartedAt"),
    metadataTimestamp(metadata, "lastFailedAt"),
    metadataTimestamp(metadata, "staleAt"),
    metadataTimestamp(metadata, "startedAt"),
  );
}

function compareEndpointPreference(left: EndpointRow, right: EndpointRow): number {
  return endpointStateRank(right.state) - endpointStateRank(left.state)
    || endpointStartedAt(right) - endpointStartedAt(left)
    || endpointActivityAt(right) - endpointActivityAt(left)
    || right.id.localeCompare(left.id);
}

/**
 * Whether this endpoint is inside a turn the broker started and has not seen
 * end. `lastStartedAt`/`lastCompletedAt` are written only by the invocation
 * dispatcher (broker-local-invocation-service), so they are turn facts —
 * unlike `startedAt`, which a presence heartbeat stamps with a process start.
 */
function endpointTurnIsOpen(row: EndpointRow): boolean {
  const metadata = parseJsonObject(row.metadata_json);
  const startedAt = metadataTimestamp(metadata, "lastStartedAt");
  return startedAt > 0 && startedAt > metadataTimestamp(metadata, "lastCompletedAt");
}

function activityForEndpoint(endpoint: EndpointRow | null): ObservedActivity {
  switch (endpoint?.state) {
    // Two different producers write `active`, and they do not mean the same
    // thing. The invocation dispatcher writes it at turn start (stamping
    // `lastStartedAt`, then `idle` + `lastCompletedAt` at the end); a presence
    // heartbeat — `scout channel`, which re-registers every 15s — writes it for
    // as long as a process is connected. Reading presence as work pins every
    // conversation for that agent at "working" for the life of the process,
    // which is what put a permanent spinner on the $HOME project row.
    case "active":
      return endpointTurnIsOpen(endpoint) ? "working" : "idle";
    case "working":
      return "working";
    case "waiting":
      return "waiting_for_input";
    case "attaching":
    case "waking":
      return "waking";
    case "failed":
      return "failed";
    case "offline":
    case "unreachable":
    case "superseded":
    case "stopped":
      return "offline";
    case "registered":
    case "idle":
      return "idle";
    default:
      return endpoint ? "unknown" : "idle";
  }
}

function normalizedHarnessIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/[\s_]+/gu, "-");
  if (!normalized) return null;
  const aliases: Record<string, string> = {
    "claude-code": "claude",
    "codex-cli": "codex",
    "cursor-agent": "cursor",
    "cursor-cli": "cursor",
    "grok-cli": "grok",
    "kimi-code": "kimi",
    "antigravity-acp": "antigravity",
    "devin-acp": "devin",
    "devin-cli": "devin",
    "open-code": "opencode",
    "opencode-cli": "opencode",
    "pi-cli": "pi",
  };
  return aliases[normalized] ?? normalized;
}

function harnessesCompatible(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizedHarnessIdentity(left);
  const normalizedRight = normalizedHarnessIdentity(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function activityForInvocation(row: InvocationActivityRow | null): ObservedActivity | null {
  switch (row?.state) {
    case "queued":
      return "queued";
    case "waking":
      return "waking";
    case "running":
      return "working";
    case "waiting":
      return "waiting_for_input";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

function invocationActivityAt(row: InvocationActivityRow | null): number {
  return Math.max(
    epochMs(row?.completed_at) ?? 0,
    epochMs(row?.started_at) ?? 0,
    epochMs(row?.created_at) ?? 0,
  );
}

function resolvedConversationActivity(
  endpoint: EndpointRow | null,
  invocation: InvocationActivityRow | null,
): ObservedActivity {
  const invocationActivity = activityForInvocation(invocation);
  if (!invocationActivity) return activityForEndpoint(endpoint);
  if (
    invocationActivity === "queued"
    || invocationActivity === "waking"
    || invocationActivity === "working"
    || invocationActivity === "waiting_for_input"
  ) {
    return invocationActivity;
  }
  // A terminal flight is authoritative until the endpoint contains evidence
  // that a later turn began. Endpoint heartbeat/updated_at is deliberately not
  // such evidence; otherwise an always-active endpoint would immediately erase
  // completed/failed/cancelled.
  return endpoint && endpointStartedAt(endpoint) > invocationActivityAt(invocation)
    ? activityForEndpoint(endpoint)
    : invocationActivity;
}

function normalizedKind(value: string): ConversationKind {
  return CONVERSATION_KINDS.has(value as ConversationKind)
    ? value as ConversationKind
    : "system";
}

function normalizedActivity(value: string): ObservedActivity {
  return OBSERVED_ACTIVITIES.has(value as ObservedActivity)
    ? value as ObservedActivity
    : "unknown";
}

function itemFromRow(row: ProjectionItemRow): ConversationProjectionItem {
  return {
    feedId: row.feed_id,
    entityKind: row.entity_kind === "observed_session" ? "observed_session" : "scout_conversation",
    kind: row.kind === "observed_session" ? "observed_session" : normalizedKind(row.kind),
    conversationId: row.conversation_id,
    runtimeSessionId: row.runtime_session_id,
    source: row.source,
    sourceSessionId: row.source_session_id,
    title: row.title,
    alias: row.alias,
    naturalKey: row.natural_key,
    projectRoot: row.project_root,
    harness: row.harness,
    model: row.model,
    effort: row.effort,
    agentId: row.agent_id,
    agentName: row.agent_name,
    currentBranch: row.current_branch,
    authorityNodeId: row.authority_node_id,
    authorityNodeName: row.authority_node_name,
    parentConversationId: row.parent_conversation_id,
    anchorMessageId: row.anchor_message_id,
    activityState: normalizedActivity(row.activity_state),
    lastMessageId: row.last_message_id,
    lastMessageAt: row.last_message_at,
    lastActivityAt: row.last_activity_at,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    participantCount: row.participant_count,
    preview: row.preview,
    lastEngagedAt: row.last_engaged_at,
    sourceFreshAt: row.source_fresh_at,
    visibilityState: row.visibility_state === "hidden" ? "hidden" : "visible",
    updatedSeq: row.updated_seq,
    updatedAt: row.updated_at,
  };
}

function semanticItemValue(item: ConversationProjectionItem): Omit<ConversationProjectionItem, "updatedSeq" | "updatedAt"> {
  const { updatedSeq: _updatedSeq, updatedAt: _updatedAt, ...semantic } = item;
  return semantic;
}

function itemSemanticallyEqual(
  left: ConversationProjectionItem | null,
  right: ConversationProjectionItem,
): boolean {
  return Boolean(left)
    && JSON.stringify(semanticItemValue(left!)) === JSON.stringify(semanticItemValue(right));
}

function metaFromRow(row: ProjectionMetaRow): ConversationProjectionMeta {
  return {
    projectionId: row.projection_id,
    projectionVersion: row.projection_version,
    headSeq: row.head_seq,
    minReplayableSeq: row.min_replayable_seq,
    updatedAt: row.updated_at,
  };
}

function normalizedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

/**
 * Rebuildable V6/SCO-102 conversation summary projection.
 *
 * The caller invokes {@link applyBrokerBatch} only after the canonical SQLite
 * rows for that retained broker batch have been applied. This class then reads
 * just the affected conversations and commits materialized rows, the one
 * self-contained replay event, and the cursor head in one SQLite transaction.
 * Coalesced observed-session folds enter through the companion method and use
 * the same transaction, event log, identity map, and cursor lineage.
 */
export class ConversationProjectionStore {
  private readonly readArchivedMessage?: (id: string) => MessageRecord | undefined;
  private readonly now: () => number;
  private readonly createProjectionId: () => string;
  private readonly operatorActorIds: readonly string[];
  private readonly eventRetentionMs: number;
  private readonly eventMaxRows: number;
  private readonly eventMaxBytes: number;
  private readonly eventPruneInterval: number;

  constructor(
    private readonly db: ControlPlaneSqliteTransactionalDatabase,
    options: ConversationProjectionStoreOptions = {},
  ) {
    this.readArchivedMessage = options.readArchivedMessage;
    this.now = options.now ?? Date.now;
    this.createProjectionId = options.createProjectionId ?? randomUUID;
    this.eventRetentionMs = positiveInteger(
      options.eventRetentionMs,
      CONVERSATION_PROJECTION_EVENT_RETENTION_MS,
    );
    this.eventMaxRows = positiveInteger(
      options.eventMaxRows,
      CONVERSATION_PROJECTION_EVENT_MAX_ROWS,
    );
    this.eventMaxBytes = positiveInteger(
      options.eventMaxBytes,
      CONVERSATION_PROJECTION_EVENT_MAX_BYTES,
    );
    this.eventPruneInterval = positiveInteger(
      options.eventPruneInterval,
      CONVERSATION_PROJECTION_EVENT_PRUNE_INTERVAL,
    );
    this.operatorActorIds = [...new Set(
      (options.operatorActorIds ?? configuredOperatorActorIds())
        .map((value) => value.trim())
        .filter(Boolean),
    )];
  }

  meta(): ConversationProjectionMeta {
    return this.db.transaction(() => metaFromRow(this.ensureMeta()))();
  }

  applyBrokerBatch(entries: readonly BrokerJournalEntry[]): ConversationProjectionEvent | null {
    if (entries.length === 0) return null;
    return this.db.transaction(() => {
      this.ensureMeta();
      const affected = this.affectedConversationIds(entries);
      const hints = this.prepareBrokerBatchProjectionHints(entries);
      // A retained message id may be corrected from one conversation to
      // another. The canonical upsert has already landed, so the fact table is
      // the only surviving preimage; include every conversation it asks us to
      // recount, not just the entry's new conversation id.
      for (const conversationId of hints.forceUnreadRecount) {
        affected.add(conversationId);
      }
      if (affected.size === 0) return null;
      return this.commitAffected(affected, hints);
    })();
  }

  /** Alias used by composition roots that already call retained writes batches. */
  applyBatch(entries: readonly BrokerJournalEntry[]): ConversationProjectionEvent | null {
    return this.applyBrokerBatch(entries);
  }

  /**
   * Commit one coalesced batch from the private transcript observer. The
   * reducer has already collapsed noisy source events to a complete latest
   * state per session; this method owns durable identity/linkage and enters the
   * same projection cursor lineage as broker-authored batches.
   */
  applyObservedSessionBatch(
    updates: readonly ObservedSessionProjectionUpdate[],
  ): ConversationProjectionEvent | null {
    if (updates.length === 0) return null;
    return this.db.transaction(() => {
      const meta = this.ensureMeta();
      const changesByFeedId = new Map<string, PendingItemChange>();
      const redirectsByFromId = new Map<string, string>();
      const redirectTargets = new Map<string, ConversationProjectionItem>();
      const aliases: Array<{ source: string; sourceSessionId: string; feedId: string }> = [];

      for (const update of [...updates].sort((left, right) => (
        left.feedId.localeCompare(right.feedId)
      ))) {
        const expectedFeedId = observedSessionFeedId(update.source, update.sourceSessionId);
        if (update.feedId !== expectedFeedId) continue;

        const currentObserved = this.readProjectedItem(expectedFeedId);
        if (
          currentObserved?.sourceFreshAt != null
          && update.sourceFreshAt < currentObserved.sourceFreshAt
        ) {
          continue;
        }
        const observed = this.observedItem(update, currentObserved, meta.head_seq);
        const linkedScout = this.linkedScoutItem(update);
        if (!linkedScout) {
          if (!itemSemanticallyEqual(currentObserved, observed)) {
            changesByFeedId.set(observed.feedId, {
              current: currentObserved,
              desired: observed,
            });
          }
          aliases.push({
            source: update.source,
            sourceSessionId: update.sourceSessionId,
            feedId: observed.feedId,
          });
          continue;
        }

        const hiddenObserved = { ...observed, visibilityState: "hidden" as const };
        if (!itemSemanticallyEqual(currentObserved, hiddenObserved)) {
          changesByFeedId.set(hiddenObserved.feedId, {
            current: currentObserved,
            desired: hiddenObserved,
          });
        }
        const mergedScout = this.mergeObservedContribution(linkedScout, observed);
        if (!itemSemanticallyEqual(linkedScout, mergedScout)) {
          changesByFeedId.set(mergedScout.feedId, {
            current: linkedScout,
            desired: mergedScout,
          });
        }
        if (
          expectedFeedId !== linkedScout.feedId
          && currentObserved?.visibilityState === "visible"
        ) {
          redirectsByFromId.set(expectedFeedId, linkedScout.feedId);
          redirectTargets.set(linkedScout.feedId, mergedScout);
        }
        aliases.push({
          source: update.source,
          sourceSessionId: update.sourceSessionId,
          feedId: linkedScout.feedId,
        });
      }

      const event = this.commitChanges(
        meta,
        changesByFeedId,
        redirectsByFromId,
        redirectTargets,
      );
      const now = this.now();
      for (const alias of aliases) {
        this.persistSourceAlias(alias.source, alias.sourceSessionId, alias.feedId, now);
      }
      return event;
    })();
  }

  /**
   * Bring every Scout-owned projection row to the canonical post-replay state.
   * Existing observed-session rows are deliberately left untouched.
   */
  reconcileAll(): ConversationProjectionEvent | null {
    return this.db.transaction(() => {
      this.rebuildAllMessageStats();
      const ids = new Set(
        this.db.query<{ id: string }>("SELECT id FROM conversations ORDER BY id").all()
          .map((row) => row.id),
      );
      for (const row of this.db.query<{ conversation_id: string }>(
        `SELECT conversation_id
         FROM conversation_projection_items
         WHERE entity_kind = 'scout_conversation'
           AND conversation_id IS NOT NULL`,
      ).all()) {
        ids.add(row.conversation_id);
      }
      return this.commitAffected(ids);
    })();
  }

  snapshot(limitInput?: number): ConversationProjectionSnapshot {
    const limit = normalizedLimit(
      limitInput,
      CONVERSATION_PROJECTION_LAUNCH_LIMIT,
      CONVERSATION_PROJECTION_MAX_LIST_LIMIT,
    );
    return this.db.transaction(() => {
      const meta = this.ensureMeta();
      const total = this.db.query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM conversation_projection_items WHERE visibility_state = 'visible'",
      ).get()?.total ?? 0;
      const rows = this.db.query<ProjectionItemRow>(
        `SELECT *
         FROM conversation_projection_items
         WHERE visibility_state = 'visible'
         ORDER BY last_activity_at DESC, feed_id ASC
         LIMIT ?1`,
      ).all(limit);
      const engagedFeedId = this.db.query<{ feed_id: string }>(
        `SELECT feed_id
         FROM conversation_projection_items
         WHERE visibility_state = 'visible'
           AND last_engaged_at IS NOT NULL
         ORDER BY last_engaged_at DESC, last_activity_at DESC, feed_id ASC
         LIMIT 1`,
      ).get()?.feed_id ?? null;
      const sourceFreshAt = this.db.query<{ source_fresh_at: number | null }>(
        `SELECT MAX(source_fresh_at) AS source_fresh_at
         FROM conversation_projection_items
         WHERE visibility_state = 'visible'`,
      ).get()?.source_fresh_at ?? null;
      const visibleFeedIds = new Set(rows.map((row) => row.feed_id));
      const identityRedirects = this.db.query<{
        from_feed_id: string;
        to_feed_id: string;
      }>(
        `SELECT redirects.source_session_id AS from_feed_id,
                redirects.feed_id AS to_feed_id
         FROM conversation_projection_sources redirects
         JOIN conversation_projection_items target
           ON target.feed_id = redirects.feed_id
          AND target.visibility_state = 'visible'
         WHERE redirects.source = ?1
           AND redirects.source_session_id <> redirects.feed_id
         ORDER BY redirects.last_seen_at DESC, redirects.source_session_id ASC
         LIMIT ?2`,
      ).all(SCOUT_PROJECTION_REDIRECT_SOURCE, CONVERSATION_PROJECTION_REDIRECT_LIMIT)
        .filter((redirect) => visibleFeedIds.has(redirect.to_feed_id))
        .map((redirect) => ({
          fromFeedId: redirect.from_feed_id,
          toFeedId: redirect.to_feed_id,
        }));

      return {
        projectionId: meta.projection_id,
        projectionVersion: meta.projection_version,
        sequence: meta.head_seq,
        generatedAt: this.now(),
        sourceFreshAt,
        items: rows.map(itemFromRow),
        total,
        hasMore: total > rows.length,
        engagedFeedId,
        identityRedirects,
      };
    })();
  }

  /**
   * Bounded restart seed for the private observed-session reducer and tail
   * lifecycle registry. Hidden linked rows remain eligible: they still carry
   * the observed half of a Scout/adapter identity and must be allowed to age.
   */
  persistedActiveObservedSessionUpdates(
    limitInput = CONVERSATION_PROJECTION_ACTIVE_OBSERVED_LIMIT,
  ): ObservedSessionProjectionUpdate[] {
    const limit = normalizedLimit(
      limitInput,
      CONVERSATION_PROJECTION_ACTIVE_OBSERVED_LIMIT,
      CONVERSATION_PROJECTION_ACTIVE_OBSERVED_LIMIT,
    );
    const rows = this.db.query<ProjectionItemRow>(
      `SELECT *
       FROM conversation_projection_items
       WHERE entity_kind = 'observed_session'
         AND source IS NOT NULL
         AND source_session_id IS NOT NULL
         AND activity_state IN ('queued', 'waking', 'thinking', 'executing', 'working', 'stalled')
       ORDER BY last_activity_at DESC, feed_id ASC
       LIMIT ?1`,
    ).all(limit);
    return rows.map((row) => {
      const source = row.source!.trim();
      const sourceSessionId = row.source_session_id!.trim();
      const sourceFreshAt = row.source_fresh_at ?? row.last_activity_at;
      return {
        feedId: row.feed_id,
        entityKind: "observed_session" as const,
        source,
        sourceSessionId,
        runtimeSessionId: row.runtime_session_id?.trim() || sourceSessionId,
        title: row.title?.trim() || `${source} session`,
        project: null,
        projectRoot: row.project_root,
        cwd: row.project_root,
        harness: row.harness?.trim() || source,
        activityState: normalizedActivity(row.activity_state),
        preview: row.preview,
        lastActivityAt: row.last_activity_at,
        sourceFreshAt,
        lastEventId: row.last_message_id
          ?? `projection-seed:${row.feed_id}:${sourceFreshAt}`,
        lastEventKind: "system" as const,
      };
    });
  }

  eventsSince(
    cursor: ConversationProjectionCursor,
    limitInput = CONVERSATION_PROJECTION_DEFAULT_EVENT_LIMIT,
  ): ConversationProjectionEventPage {
    const limit = normalizedLimit(limitInput, CONVERSATION_PROJECTION_DEFAULT_EVENT_LIMIT, 1_000);
    return this.db.transaction(() => {
      const meta = this.ensureMeta();
      const common = {
        projectionId: meta.projection_id,
        projectionVersion: meta.projection_version,
        headSeq: meta.head_seq,
        minReplayableSeq: meta.min_replayable_seq,
      };
      if (cursor.projectionId !== meta.projection_id) {
        return {
          ...common,
          cursorExpired: true,
          reason: "projection_reset" as const,
          events: [],
          hasMore: false,
        };
      }
      if (cursor.seq < meta.min_replayable_seq - 1) {
        return {
          ...common,
          cursorExpired: true,
          reason: "cursor_too_old" as const,
          events: [],
          hasMore: false,
        };
      }

      const rows = this.db.query<ProjectionEventRow>(
        `SELECT seq, projection_id, ts, payload_json
         FROM conversation_projection_events
         WHERE projection_id = ?1 AND seq > ?2
         ORDER BY seq ASC
         LIMIT ?3`,
      ).all(meta.projection_id, cursor.seq, limit);
      const events = rows.map((row): ConversationProjectionEvent => ({
        projectionId: row.projection_id,
        seq: row.seq,
        ts: row.ts,
        delta: JSON.parse(row.payload_json) as ConversationProjectionDelta,
      }));
      const lastSeq = events.at(-1)?.seq ?? cursor.seq;
      return {
        ...common,
        cursorExpired: false,
        events,
        hasMore: lastSeq < meta.head_seq,
      };
    })();
  }

  private ensureMeta(): ProjectionMetaRow {
    const current = this.db.query<ProjectionMetaRow>(
      `SELECT projection_id, projection_version, head_seq, min_replayable_seq, updated_at
       FROM conversation_projection_meta
       WHERE singleton = 1`,
    ).get();
    if (current?.projection_version === CONVERSATION_PROJECTION_VERSION) {
      return current;
    }

    const now = this.now();
    const replacement: ProjectionMetaRow = {
      projection_id: this.createProjectionId(),
      projection_version: CONVERSATION_PROJECTION_VERSION,
      head_seq: 0,
      min_replayable_seq: 1,
      updated_at: now,
    };
    // A missing meta row with retained state is also an invalid lineage. The
    // projection is disposable; canonical conversations/messages remain intact.
    this.db.query("DELETE FROM conversation_projection_sources").run();
    this.db.query("DELETE FROM conversation_projection_items").run();
    this.db.query("DELETE FROM conversation_projection_events").run();
    this.db.query("DELETE FROM conversation_projection_message_facts").run();
    this.db.query("DELETE FROM conversation_projection_message_stats").run();
    this.db.query(
      `INSERT INTO conversation_projection_meta (
         singleton, projection_id, projection_version, head_seq,
         min_replayable_seq, updated_at
       ) VALUES (1, ?1, ?2, 0, 1, ?3)
       ON CONFLICT(singleton) DO UPDATE SET
         projection_id = excluded.projection_id,
         projection_version = excluded.projection_version,
         head_seq = excluded.head_seq,
         min_replayable_seq = excluded.min_replayable_seq,
         updated_at = excluded.updated_at`,
    ).run(replacement.projection_id, replacement.projection_version, now);
    return replacement;
  }

  private prepareBrokerBatchProjectionHints(
    entries: readonly BrokerJournalEntry[],
  ): BrokerBatchProjectionHints {
    const hints: BrokerBatchProjectionHints = {
      newMessagesByConversation: new Map(),
      forceUnreadRecount: new Set(),
    };

    for (const entry of entries) {
      if (entry.kind === "conversation.upsert") {
        hints.forceUnreadRecount.add(entry.conversation.id);
        continue;
      }
      if (entry.kind === "conversation.read_cursor.upsert") {
        hints.forceUnreadRecount.add(entry.cursor.conversationId);
        continue;
      }
      if (entry.kind !== "message.record") continue;

      const message = entry.message;
      const initialized = Boolean(this.db.query<{ found: number }>(
        `SELECT 1 AS found
         FROM conversation_projection_message_stats
         WHERE conversation_id = ?1`,
      ).get(message.conversationId));
      if (!initialized) {
        // Existing deployments and direct store consumers may encounter a
        // conversation before the disposable aggregate has been warmed. One
        // bounded backfill establishes the baseline; subsequent appends are
        // O(1) and idempotent through the fact row.
        this.rebuildMessageStatsForConversation(message.conversationId);
        hints.forceUnreadRecount.add(message.conversationId);
        continue;
      }

      const priorFact = this.db.query<{ conversation_id: string; created_at: number }>(
        `SELECT conversation_id, created_at
         FROM conversation_projection_message_facts
         WHERE message_id = ?1`,
      ).get(message.id);
      const createdAt = epochMs(message.createdAt) ?? 0;
      if (priorFact) {
        // Message ids are normally immutable, but the canonical store accepts
        // idempotent corrective upserts. Facts intentionally stay compact and
        // do not retain actor identity, so conservatively recount unread state
        // for a repeated id; otherwise agent -> operator corrections leave the
        // materialized unread badge stale.
        hints.forceUnreadRecount.add(message.conversationId);
        if (
          priorFact.conversation_id !== message.conversationId
          || priorFact.created_at !== createdAt
        ) {
          const priorConversationId = priorFact.conversation_id;
          this.db.query(
            `UPDATE conversation_projection_message_facts
             SET conversation_id = ?2, created_at = ?3
             WHERE message_id = ?1`,
          ).run(message.id, message.conversationId, createdAt);
          this.rebuildMessageStatsForConversation(priorConversationId);
          if (priorConversationId !== message.conversationId) {
            this.rebuildMessageStatsForConversation(message.conversationId);
          }
          hints.forceUnreadRecount.add(priorConversationId);
          hints.forceUnreadRecount.add(message.conversationId);
        }
        continue;
      }

      this.db.query(
        `INSERT INTO conversation_projection_message_facts (
           message_id, conversation_id, created_at
         ) VALUES (?1, ?2, ?3)`,
      ).run(message.id, message.conversationId, createdAt);
      const stats = this.db.query<MessageStatsRow>(
        `SELECT message_count, latest_message_id, latest_message_at
         FROM conversation_projection_message_stats
         WHERE conversation_id = ?1`,
      ).get(message.conversationId)!;
      const becomesLatest = stats.latest_message_at == null
        || createdAt > stats.latest_message_at
        || (createdAt === stats.latest_message_at && message.id > (stats.latest_message_id ?? ""));
      this.db.query(
        `UPDATE conversation_projection_message_stats
         SET message_count = message_count + 1,
             latest_message_id = ?2,
             latest_message_at = ?3
         WHERE conversation_id = ?1`,
      ).run(
        message.conversationId,
        becomesLatest ? message.id : stats.latest_message_id,
        becomesLatest ? createdAt : stats.latest_message_at,
      );
      const pending = hints.newMessagesByConversation.get(message.conversationId) ?? [];
      pending.push(message);
      hints.newMessagesByConversation.set(message.conversationId, pending);
    }
    return hints;
  }

  private rebuildAllMessageStats(): void {
    this.db.query("DELETE FROM conversation_projection_message_facts").run();
    this.db.query("DELETE FROM conversation_projection_message_stats").run();
    this.db.query(
      `INSERT INTO conversation_projection_message_facts (
         message_id, conversation_id, created_at
       )
       SELECT id,
              conversation_id,
              CASE
                WHEN created_at > 0 AND created_at < ${EPOCH_MILLISECONDS_FLOOR}
                  THEN created_at * 1000
                ELSE created_at
              END
       FROM messages`,
    ).run();
    this.db.query(
      `INSERT INTO conversation_projection_message_stats (
         conversation_id, message_count, latest_message_id, latest_message_at
       )
       SELECT facts.conversation_id,
              COUNT(*),
              (
                SELECT latest.message_id
                FROM conversation_projection_message_facts latest
                WHERE latest.conversation_id = facts.conversation_id
                ORDER BY latest.created_at DESC, latest.message_id DESC
                LIMIT 1
              ),
              MAX(facts.created_at)
       FROM conversation_projection_message_facts facts
       GROUP BY facts.conversation_id`,
    ).run();
  }

  private rebuildMessageStatsForConversation(conversationId: string): void {
    this.db.query(
      "DELETE FROM conversation_projection_message_facts WHERE conversation_id = ?1",
    ).run(conversationId);
    this.db.query(
      `INSERT INTO conversation_projection_message_facts (
         message_id, conversation_id, created_at
       )
       SELECT id,
              conversation_id,
              CASE
                WHEN created_at > 0 AND created_at < ${EPOCH_MILLISECONDS_FLOOR}
                  THEN created_at * 1000
                ELSE created_at
              END
       FROM messages
       WHERE conversation_id = ?1`,
    ).run(conversationId);
    const aggregate = this.db.query<MessageStatsRow>(
      `SELECT COUNT(*) AS message_count,
              (
                SELECT message_id
                FROM conversation_projection_message_facts
                WHERE conversation_id = ?1
                ORDER BY created_at DESC, message_id DESC
                LIMIT 1
              ) AS latest_message_id,
              MAX(created_at) AS latest_message_at
       FROM conversation_projection_message_facts
       WHERE conversation_id = ?1`,
    ).get(conversationId) ?? {
      message_count: 0,
      latest_message_id: null,
      latest_message_at: null,
    };
    this.db.query(
      `INSERT INTO conversation_projection_message_stats (
         conversation_id, message_count, latest_message_id, latest_message_at
       ) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(conversation_id) DO UPDATE SET
         message_count = excluded.message_count,
         latest_message_id = excluded.latest_message_id,
         latest_message_at = excluded.latest_message_at`,
    ).run(
      conversationId,
      aggregate.message_count,
      aggregate.latest_message_id,
      aggregate.latest_message_at,
    );
  }

  private affectedConversationIds(entries: readonly BrokerJournalEntry[]): Set<string> {
    const ids = new Set<string>();
    const addMemberConversations = (actorId: string): void => {
      for (const row of this.db.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM conversation_members WHERE actor_id = ?1",
      ).all(actorId)) {
        ids.add(row.conversation_id);
      }
    };

    for (const entry of entries) {
      switch (entry.kind) {
        case "conversation.upsert":
          ids.add(entry.conversation.id);
          break;
        case "message.record":
          ids.add(entry.message.conversationId);
          break;
        case "conversation.read_cursor.upsert":
          ids.add(entry.cursor.conversationId);
          break;
        case "invocation.record":
          if (entry.invocation.conversationId) ids.add(entry.invocation.conversationId);
          break;
        case "flight.record": {
          const row = this.db.query<{ conversation_id: string | null }>(
            "SELECT conversation_id FROM invocations WHERE id = ?1",
          ).get(entry.flight.invocationId);
          if (row?.conversation_id) ids.add(row.conversation_id);
          break;
        }
        case "actor.upsert":
          addMemberConversations(entry.actor.id);
          break;
        case "agent.upsert":
          addMemberConversations(entry.agent.id);
          break;
        case "agent.endpoint.upsert":
          addMemberConversations(entry.endpoint.agentId);
          break;
        case "agent.endpoint.delete":
          if (entry.agentId) {
            // The entry carries its preimage — the member lookup is exact
            // (membership-removal upserts in the same batch already marked
            // the affected rooms anyway).
            addMemberConversations(entry.agentId);
          } else {
            // Legacy entries (pre-preimage journals) carry only endpointId and
            // canonical application has already removed it — re-evaluate
            // direct chats conservatively.
            for (const row of this.db.query<{ id: string }>(
              "SELECT id FROM conversations WHERE kind = 'direct'",
            ).all()) {
              ids.add(row.id);
            }
          }
          break;
        case "agent.delete":
        case "actor.delete": {
          if (entry.conversationIds) {
            // The preimage lists the memberships captured before the cascade
            // delete — re-evaluate exactly those conversations.
            for (const id of entry.conversationIds) ids.add(id);
          } else {
            // Legacy entries have no preimage and the member rows are already
            // gone — re-evaluate every direct conversation.
            for (const row of this.db.query<{ id: string }>(
              "SELECT id FROM conversations WHERE kind = 'direct'",
            ).all()) {
              ids.add(row.id);
            }
          }
          break;
        }
        case "node.upsert":
          for (const row of this.db.query<{ id: string }>(
            "SELECT id FROM conversations WHERE authority_node_id = ?1",
          ).all(entry.node.id)) {
            ids.add(row.id);
          }
          break;
        case "collaboration.record":
          if (entry.record.conversationId) ids.add(entry.record.conversationId);
          break;
        default:
          break;
      }
    }
    return ids;
  }

  private commitAffected(
    ids: ReadonlySet<string>,
    hints?: BrokerBatchProjectionHints,
  ): ConversationProjectionEvent | null {
    const meta = this.ensureMeta();
    if (ids.size === 0) return null;

    const { groups, missingIds } = this.projectionGroups(ids);
    const changesByFeedId = new Map<string, PendingItemChange>();
    const redirectsByFromId = new Map<string, string>();
    const redirectTargets = new Map<string, ConversationProjectionItem>();
    const observedAliases: Array<{ source: string; sourceSessionId: string; feedId: string }> = [];

    // A missing canonical row is not proof of an explicit hard delete. Keep the
    // projection identity and transition a formerly visible row to hidden.
    for (const conversationId of missingIds) {
      const current = this.readProjectedConversation(conversationId);
      if (current?.visibilityState === "visible") {
        changesByFeedId.set(current.feedId, {
          current,
          desired: {
            ...current,
            visibilityState: "hidden",
            updatedAt: this.now(),
          },
        });
      }
    }

    for (const group of groups.values()) {
      const currents = this.readProjectedGroup(group);
      const expectedFeedId = scoutConversationFeedId(group.canonical.id);
      const priorSummary = currents.find((item) => item.feedId === expectedFeedId)
        ?? currents.find((item) => item.visibilityState === "visible")
        ?? currents[0]
        ?? null;
      let desired = this.reduceConversationGroup(group, meta.head_seq, priorSummary, hints);
      if (desired.visibilityState === "visible") {
        for (const observed of this.observedContributionsForScout(desired)) {
          desired = this.mergeObservedContribution(desired, observed);
          if (observed.visibilityState === "visible") {
            changesByFeedId.set(observed.feedId, {
              current: observed,
              desired: {
                ...observed,
                visibilityState: "hidden",
                updatedAt: this.now(),
              },
            });
          }
          if (observed.feedId !== desired.feedId) {
            redirectsByFromId.set(observed.feedId, desired.feedId);
            redirectTargets.set(desired.feedId, desired);
          }
          if (observed.source && observed.sourceSessionId) {
            observedAliases.push({
              source: observed.source,
              sourceSessionId: observed.sourceSessionId,
              feedId: desired.feedId,
            });
          }
        }
      }
      const primary = currents.find((item) => item.feedId === desired.feedId) ?? null;
      if (!itemSemanticallyEqual(primary, desired)) {
        changesByFeedId.set(desired.feedId, { current: primary, desired });
      }

      for (const current of currents) {
        if (current.feedId === desired.feedId) continue;
        if (current.visibilityState === "visible") {
          if (desired.visibilityState === "visible") {
            redirectsByFromId.set(current.feedId, desired.feedId);
            redirectTargets.set(desired.feedId, desired);
          }
          changesByFeedId.set(current.feedId, {
            current,
            desired: {
              ...current,
              visibilityState: "hidden",
              updatedAt: this.now(),
            },
          });
        }
      }
    }

    const event = this.commitChanges(meta, changesByFeedId, redirectsByFromId, redirectTargets);
    const now = this.now();
    for (const alias of observedAliases) {
      this.persistSourceAlias(alias.source, alias.sourceSessionId, alias.feedId, now);
    }
    return event;
  }

  private commitChanges(
    meta: ProjectionMetaRow,
    changesByFeedId: ReadonlyMap<string, PendingItemChange>,
    redirectsByFromId: ReadonlyMap<string, string>,
    redirectTargets: ReadonlyMap<string, ConversationProjectionItem> = new Map(),
  ): ConversationProjectionEvent | null {
    const changes = [...changesByFeedId.values()];
    if (changes.length === 0 && redirectsByFromId.size === 0) return null;
    const hasVisibleDelta = changes.some(({ current, desired }) => (
      desired.visibilityState === "visible" || current?.visibilityState === "visible"
    )) || redirectsByFromId.size > 0;
    const seq = hasVisibleDelta ? meta.head_seq + 1 : meta.head_seq;
    const now = this.now();
    const persisted = changes.map(({ current, desired }) => ({
      current,
      desired: { ...desired, updatedSeq: seq, updatedAt: now },
    }));
    for (const change of persisted) {
      this.writeItem(change.desired);
    }

    if (!hasVisibleDelta) {
      this.db.query(
        "UPDATE conversation_projection_meta SET updated_at = ?1 WHERE singleton = 1",
      ).run(now);
      return null;
    }

    const upsertedByFeedId = new Map<string, ConversationProjectionItem>();
    for (const { desired } of persisted) {
      if (desired.visibilityState === "visible") {
        upsertedByFeedId.set(desired.feedId, desired);
      }
    }
    for (const target of redirectTargets.values()) {
      if (target.visibilityState === "visible") {
        upsertedByFeedId.set(target.feedId, { ...target, updatedSeq: seq, updatedAt: now });
      }
    }
    const upserted = [...upsertedByFeedId.values()].sort(compareConversationProjectionItems);
    const notVisible = [...new Set(persisted
      .filter(({ current, desired }) => (
        current?.visibilityState === "visible" && desired.visibilityState === "hidden"
      ))
      .map(({ desired }) => desired.feedId))]
      .sort();
    const identityRedirects = [...redirectsByFromId.entries()]
      .filter(([fromFeedId, toFeedId]) => fromFeedId !== toFeedId)
      .map(([fromFeedId, toFeedId]) => ({ fromFeedId, toFeedId }))
      .sort((left, right) => left.fromFeedId.localeCompare(right.fromFeedId));
    const delta: ConversationProjectionDelta = {
      upserted,
      notVisible,
      hardDeleted: [],
      identityRedirects,
    };
    for (const redirect of identityRedirects) {
      this.persistIdentityRedirect(redirect.fromFeedId, redirect.toFeedId, now);
    }
    const event: ConversationProjectionEvent = {
      projectionId: meta.projection_id,
      seq,
      ts: now,
      delta,
    };
    this.db.query(
      `INSERT INTO conversation_projection_events (seq, projection_id, ts, payload_json)
       VALUES (?1, ?2, ?3, ?4)`,
    ).run(seq, meta.projection_id, now, JSON.stringify(delta));
    const minReplayableSeq = this.pruneEvents(
      meta.projection_id,
      seq,
      now,
      meta.min_replayable_seq,
    );
    this.db.query(
      `UPDATE conversation_projection_meta
       SET head_seq = ?1,
           min_replayable_seq = ?2,
           updated_at = ?3
       WHERE singleton = 1`,
    ).run(seq, minReplayableSeq, now);
    return event;
  }

  private pruneEvents(
    projectionId: string,
    headSeq: number,
    now: number,
    currentMinReplayableSeq: number,
  ): number {
    if (headSeq % this.eventPruneInterval !== 0) {
      return currentMinReplayableSeq;
    }

    const oldestRetainedAt = now - this.eventRetentionMs;
    const oldestRetainedSeq = Math.max(1, headSeq - this.eventMaxRows + 1);
    this.db.query(
      `DELETE FROM conversation_projection_events
       WHERE projection_id = ?1
         AND (ts < ?2 OR seq < ?3)`,
    ).run(projectionId, oldestRetainedAt, oldestRetainedSeq);

    const rows = this.db.query<{ seq: number; payload_bytes: number }>(
      `SELECT seq, length(CAST(payload_json AS BLOB)) AS payload_bytes
       FROM conversation_projection_events
       WHERE projection_id = ?1
       ORDER BY seq DESC`,
    ).all(projectionId);
    let retainedBytes = 0;
    let oldestWithinBudget: number | null = null;
    for (const row of rows) {
      const nextBytes = retainedBytes + Math.max(0, row.payload_bytes);
      if (oldestWithinBudget !== null && nextBytes > this.eventMaxBytes) break;
      retainedBytes = nextBytes;
      oldestWithinBudget = row.seq;
    }
    if (oldestWithinBudget !== null) {
      this.db.query(
        `DELETE FROM conversation_projection_events
         WHERE projection_id = ?1 AND seq < ?2`,
      ).run(projectionId, oldestWithinBudget);
    }

    return this.db.query<{ min_seq: number | null }>(
      `SELECT MIN(seq) AS min_seq
       FROM conversation_projection_events
       WHERE projection_id = ?1`,
    ).get(projectionId)?.min_seq ?? headSeq + 1;
  }

  private persistIdentityRedirect(fromFeedId: string, toFeedId: string, now: number): void {
    // Collapse redirect chains and repoint any observed source aliases attached
    // to the superseded feed before retaining the old feed id as a client alias.
    this.db.query(
      `UPDATE conversation_projection_sources
       SET feed_id = ?1, last_seen_at = ?2
       WHERE feed_id = ?3`,
    ).run(toFeedId, now, fromFeedId);
    this.db.query(
      `INSERT INTO conversation_projection_sources (
         source, source_session_id, feed_id, first_seen_at, last_seen_at
       ) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(source, source_session_id) DO UPDATE SET
         feed_id = excluded.feed_id,
         last_seen_at = excluded.last_seen_at`,
    ).run(SCOUT_PROJECTION_REDIRECT_SOURCE, fromFeedId, toFeedId, now);
    this.db.query(
      `DELETE FROM conversation_projection_sources
       WHERE source = ?1 AND source_session_id = feed_id`,
    ).run(SCOUT_PROJECTION_REDIRECT_SOURCE);
  }

  private readProjectedConversation(conversationId: string): ConversationProjectionItem | null {
    const row = this.db.query<ProjectionItemRow>(
      `SELECT *
       FROM conversation_projection_items
       WHERE entity_kind = 'scout_conversation' AND conversation_id = ?1`,
    ).get(conversationId);
    return row ? itemFromRow(row) : null;
  }

  private readProjectedItem(feedId: string): ConversationProjectionItem | null {
    const row = this.db.query<ProjectionItemRow>(
      "SELECT * FROM conversation_projection_items WHERE feed_id = ?1",
    ).get(feedId);
    return row ? itemFromRow(row) : null;
  }

  private observedItem(
    update: ObservedSessionProjectionUpdate,
    current: ConversationProjectionItem | null,
    updatedSeq: number,
  ): ConversationProjectionItem {
    const isMessage = update.lastEventKind === "user" || update.lastEventKind === "assistant";
    const isNewMessage = isMessage && current?.lastMessageId !== update.lastEventId;
    return {
      feedId: update.feedId,
      entityKind: "observed_session",
      kind: "observed_session",
      conversationId: null,
      runtimeSessionId: update.runtimeSessionId,
      source: update.source,
      sourceSessionId: update.sourceSessionId,
      title: truncatePreview(update.title, 96),
      alias: null,
      naturalKey: null,
      projectRoot: update.projectRoot ?? update.cwd ?? current?.projectRoot ?? null,
      harness: update.harness,
      model: current?.model ?? null,
      effort: current?.effort ?? null,
      agentId: null,
      agentName: null,
      currentBranch: current?.currentBranch ?? null,
      authorityNodeId: null,
      authorityNodeName: null,
      parentConversationId: null,
      anchorMessageId: null,
      activityState: update.activityState,
      lastMessageId: isMessage ? update.lastEventId : current?.lastMessageId ?? null,
      lastMessageAt: isMessage ? update.lastActivityAt : current?.lastMessageAt ?? null,
      lastActivityAt: Math.max(current?.lastActivityAt ?? 0, update.lastActivityAt),
      messageCount: Math.max(0, current?.messageCount ?? 0) + (isNewMessage ? 1 : 0),
      unreadCount: 0,
      participantCount: 0,
      preview: truncatePreview(update.preview),
      lastEngagedAt: current?.lastEngagedAt ?? null,
      sourceFreshAt: Math.max(current?.sourceFreshAt ?? 0, update.sourceFreshAt),
      visibilityState: "visible",
      updatedSeq,
      updatedAt: this.now(),
    };
  }

  private linkedScoutItem(update: ObservedSessionProjectionUpdate): ConversationProjectionItem | null {
    const mapped = this.db.query<ProjectionItemRow>(
      `SELECT item.*
       FROM conversation_projection_sources source
       JOIN conversation_projection_items item ON item.feed_id = source.feed_id
       WHERE source.source = ?1
         AND source.source_session_id = ?2
         AND item.entity_kind = 'scout_conversation'
       LIMIT 1`,
    ).get(update.source, update.sourceSessionId);
    if (mapped) return itemFromRow(mapped);

    const candidates = this.db.query<ProjectionItemRow>(
      `SELECT *
       FROM conversation_projection_items
       WHERE entity_kind = 'scout_conversation'
         AND runtime_session_id = ?1
       ORDER BY CASE visibility_state WHEN 'visible' THEN 0 ELSE 1 END,
                last_activity_at DESC,
       feed_id ASC
       LIMIT 16`,
    ).all(update.runtimeSessionId);
    const candidate = candidates
      .map(itemFromRow)
      .find((item) => harnessesCompatible(item.harness, update.source));
    return candidate ?? null;
  }

  private mergeObservedContribution(
    scout: ConversationProjectionItem,
    observed: ConversationProjectionItem,
  ): ConversationProjectionItem {
    const brokerOwnsActivity = new Set<ObservedActivity>([
      "waiting_for_input",
      "waiting_on_actor",
      "blocked",
      "review",
    ]).has(scout.activityState);
    const observedIsFresher = observed.lastActivityAt >= scout.lastActivityAt;
    return {
      ...scout,
      runtimeSessionId: scout.runtimeSessionId ?? observed.runtimeSessionId,
      source: scout.source ?? observed.source,
      sourceSessionId: scout.sourceSessionId ?? observed.sourceSessionId,
      title: scout.title ?? observed.title,
      projectRoot: scout.projectRoot ?? observed.projectRoot,
      harness: scout.harness ?? observed.harness,
      model: scout.model ?? observed.model,
      effort: scout.effort ?? observed.effort,
      currentBranch: scout.currentBranch ?? observed.currentBranch,
      activityState: !brokerOwnsActivity && observedIsFresher
        ? observed.activityState
        : scout.activityState,
      lastActivityAt: Math.max(scout.lastActivityAt, observed.lastActivityAt),
      preview: scout.preview ?? observed.preview,
      sourceFreshAt: Math.max(scout.sourceFreshAt ?? 0, observed.sourceFreshAt ?? 0) || null,
      updatedAt: this.now(),
    };
  }

  private observedContributionsForScout(
    scout: ConversationProjectionItem,
  ): ConversationProjectionItem[] {
    const result = new Map<string, ConversationProjectionItem>();
    if (scout.runtimeSessionId) {
      for (const row of this.db.query<ProjectionItemRow>(
        `SELECT *
         FROM conversation_projection_items
         WHERE entity_kind = 'observed_session'
           AND (runtime_session_id = ?1 OR source_session_id = ?1)
         ORDER BY source_fresh_at DESC, feed_id ASC`,
      ).all(scout.runtimeSessionId)) {
        const item = itemFromRow(row);
        if (harnessesCompatible(scout.harness, item.source ?? item.harness)) {
          result.set(row.feed_id, item);
        }
      }
    }
    for (const alias of this.db.query<{ source: string; source_session_id: string }>(
      `SELECT source, source_session_id
       FROM conversation_projection_sources
       WHERE feed_id = ?1 AND source <> ?2
       ORDER BY last_seen_at DESC, source ASC, source_session_id ASC`,
    ).all(scout.feedId, SCOUT_PROJECTION_REDIRECT_SOURCE)) {
      const feedId = observedSessionFeedId(alias.source, alias.source_session_id);
      const item = this.readProjectedItem(feedId);
      if (item?.entityKind === "observed_session") result.set(feedId, item);
    }
    return [...result.values()].sort((left, right) => (
      (right.sourceFreshAt ?? 0) - (left.sourceFreshAt ?? 0)
      || left.feedId.localeCompare(right.feedId)
    ));
  }

  private persistSourceAlias(
    source: string,
    sourceSessionId: string,
    feedId: string,
    now: number,
  ): void {
    this.db.query(
      `INSERT INTO conversation_projection_sources (
         source, source_session_id, feed_id, first_seen_at, last_seen_at
       ) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(source, source_session_id) DO UPDATE SET
         feed_id = excluded.feed_id,
         last_seen_at = excluded.last_seen_at`,
    ).run(source, sourceSessionId, feedId, now);
  }

  private projectionGroups(ids: ReadonlySet<string>): {
    groups: Map<string, ConversationProjectionGroup>;
    missingIds: string[];
  } {
    const requestedRows: ConversationRow[] = [];
    const missingIds: string[] = [];
    for (const id of [...ids].sort()) {
      const row = this.readConversationRow(id);
      if (row) requestedRows.push(row);
      else missingIds.push(id);
    }

    let namedChannelGroups: Map<string, ConversationRow[]> | null = null;
    const loadNamedChannelGroups = (): Map<string, ConversationRow[]> => {
      if (namedChannelGroups) return namedChannelGroups;
      namedChannelGroups = new Map();
      for (const candidate of this.db.query<ConversationRow>(
        `SELECT id, kind, title, authority_node_id, parent_conversation_id,
                message_id, metadata_json, created_at
         FROM conversations
         WHERE kind = 'channel'
         ORDER BY id ASC`,
      ).all()) {
        const naturalKey = conversationNaturalKey({
          id: candidate.id,
          kind: candidate.kind,
          metadata: parseJsonObject(candidate.metadata_json),
        });
        if (!naturalKey) continue;
        const members = namedChannelGroups.get(naturalKey) ?? [];
        members.push(candidate);
        namedChannelGroups.set(naturalKey, members);
      }
      return namedChannelGroups;
    };

    const groups = new Map<string, ConversationProjectionGroup>();
    for (const row of requestedRows) {
      const naturalKey = row.kind === "channel"
        ? conversationNaturalKey({
          id: row.id,
          kind: row.kind,
          metadata: parseJsonObject(row.metadata_json),
        })
        : null;
      const members = naturalKey
        ? loadNamedChannelGroups().get(naturalKey) ?? [row]
        : [row];
      const expectedStableId = naturalKey ? stableChannelId(naturalKey) : null;
      const canonical = members.find((candidate) => candidate.id === expectedStableId)
        ?? [...members].sort((left, right) => left.id.localeCompare(right.id))[0]!;
      groups.set(canonical.id, { canonical, members, naturalKey });
    }
    return { groups, missingIds };
  }

  private readConversationRow(conversationId: string): ConversationRow | null {
    return this.db.query<ConversationRow>(
      `SELECT id, kind, title, authority_node_id, parent_conversation_id,
              message_id, metadata_json, created_at
       FROM conversations
       WHERE id = ?1`,
    ).get(conversationId);
  }

  private readProjectedGroup(group: ConversationProjectionGroup): ConversationProjectionItem[] {
    const ids = group.members.map((member) => member.id);
    const placeholders = ids.map(() => "?").join(", ");
    const naturalPredicate = group.naturalKey ? " OR natural_key = ?" : "";
    const params = group.naturalKey ? [...ids, group.naturalKey] : ids;
    return this.db.query<ProjectionItemRow>(
      `SELECT *
       FROM conversation_projection_items
       WHERE entity_kind = 'scout_conversation'
         AND (conversation_id IN (${placeholders})${naturalPredicate})
       ORDER BY feed_id ASC`,
    ).all(...params).map(itemFromRow);
  }

  private reduceConversationGroup(
    group: ConversationProjectionGroup,
    updatedSeq: number,
    priorSummary: ConversationProjectionItem | null,
    hints?: BrokerBatchProjectionHints,
  ): ConversationProjectionItem {
    const row = group.canonical;
    const conversationIds = group.members.map((member) => member.id);
    const placeholders = conversationIds.map(() => "?").join(", ");

    const metadata = parseJsonObject(row.metadata_json);
    const participantCount = this.db.query<{ count: number }>(
      `SELECT COUNT(DISTINCT actor_id) AS count
       FROM conversation_members
       WHERE conversation_id IN (${placeholders})`,
    ).get(...conversationIds)?.count ?? 0;
    // Only direct conversations need rich participant identity to select their
    // counterpart. Channel/group/thread rows use scalar COUNT/EXISTS queries;
    // materializing a 10k-member roster on every message defeated the point of
    // the incremental summary table.
    const participants = row.kind === "direct"
      ? this.db.query<ParticipantRow>(
        `SELECT DISTINCT cm.actor_id,
                a.kind AS actor_kind,
                a.display_name,
                a.metadata_json AS actor_metadata_json,
                ag.id AS agent_id,
                ag.workspace_qualifier,
                ag.metadata_json AS agent_metadata_json
         FROM conversation_members cm
         LEFT JOIN actors a ON a.id = cm.actor_id
         LEFT JOIN agents ag ON ag.id = cm.actor_id
         WHERE cm.conversation_id IN (${placeholders})
         ORDER BY cm.actor_id ASC`,
      ).all(...conversationIds)
      : [];
    const operatorIds = new Set(this.operatorActorIds);
    const operatorParticipates = this.operatorActorIds.length > 0 && Boolean(
      this.db.query<{ found: number }>(
        `SELECT 1 AS found
         FROM conversation_members
         WHERE conversation_id IN (${placeholders})
           AND actor_id IN (${this.operatorActorIds.map(() => "?").join(", ")})
         LIMIT 1`,
      ).get(...conversationIds, ...this.operatorActorIds),
    );
    // In an agent-to-agent DM neither participant is the operator. The ask's
    // target is the worker to observe; alphabetical member order is not routing.
    const targetAgentId = row.kind === "direct"
      ? this.db.query<{ target_agent_id: string }>(
        `SELECT target_agent_id FROM invocations
         WHERE conversation_id IN (${placeholders})
         ORDER BY CASE WHEN created_at > 0 AND created_at < ${EPOCH_MILLISECONDS_FLOOR}
           THEN created_at * 1000 ELSE created_at END DESC, id DESC
         LIMIT 1`,
      ).get(...conversationIds)?.target_agent_id
      : undefined;
    const directParticipant = row.kind === "direct"
      ? participants.find((participant) => participant.actor_id === targetAgentId && !operatorIds.has(participant.actor_id))
        ?? participants.find((participant) => !operatorIds.has(participant.actor_id) && participant.agent_id !== null)
        ?? participants.find((participant) => participant.agent_id !== null)
        ?? participants.find((participant) => !operatorIds.has(participant.actor_id))
        ?? null
      : null;
    const agentMetadata = parseJsonObject(
      directParticipant?.agent_metadata_json ?? directParticipant?.actor_metadata_json,
    );
    const endpoint = directParticipant
      ? this.preferredEndpoint(directParticipant.actor_id, agentMetadata)
      : null;
    const endpointMetadata = parseJsonObject(endpoint?.metadata_json);
    const invocationActivity = this.db.query<InvocationActivityRow>(
      `SELECT state, created_at, started_at, completed_at
       FROM invocations
       WHERE conversation_id IN (${placeholders})
         AND state IS NOT NULL
       ORDER BY CASE
         WHEN COALESCE(completed_at, started_at, created_at) > 0
          AND COALESCE(completed_at, started_at, created_at) < ${EPOCH_MILLISECONDS_FLOOR}
           THEN COALESCE(completed_at, started_at, created_at) * 1000
         ELSE COALESCE(completed_at, started_at, created_at)
       END DESC,
       created_at DESC,
       id DESC
       LIMIT 1`,
    ).get(...conversationIds);
    for (const conversationId of conversationIds) {
      const initialized = this.db.query<{ found: number }>(
        `SELECT 1 AS found
         FROM conversation_projection_message_stats
         WHERE conversation_id = ?1`,
      ).get(conversationId);
      if (!initialized) this.rebuildMessageStatsForConversation(conversationId);
    }
    const messageCount = this.db.query<{ count: number }>(
      `SELECT COALESCE(SUM(message_count), 0) AS count
       FROM conversation_projection_message_stats
       WHERE conversation_id IN (${placeholders})`,
    ).get(...conversationIds)?.count ?? 0;
    const latestMessage = this.db.query<LatestMessageRow>(
      `SELECT message.id,
              message.actor_id,
              message.body,
              message.metadata_json,
              stats.latest_message_at AS created_at
       FROM conversation_projection_message_stats stats
       JOIN messages message ON message.id = stats.latest_message_id
       WHERE stats.conversation_id IN (${placeholders})
       ORDER BY stats.latest_message_at DESC, message.id DESC
       LIMIT 1`,
    ).get(...conversationIds);
    const archived = latestMessage && this.readArchivedMessage?.(latestMessage.id);
    if (latestMessage && archived) {
      latestMessage.body = archived.body;
      latestMessage.metadata_json = archived.metadata ? JSON.stringify(archived.metadata) : null;
    }
    const lastMessageAt = epochMs(latestMessage?.created_at) ?? null;
    let lastReadAt: number | null = null;
    let unreadCount = 0;
    for (const memberId of conversationIds) {
      const memberReadAt = this.operatorReadAt(memberId);
      if (memberReadAt !== null) {
        lastReadAt = Math.max(lastReadAt ?? 0, memberReadAt);
      }
    }
    const forceUnreadRecount = !hints
      || !priorSummary
      || conversationIds.some((conversationId) => hints.forceUnreadRecount.has(conversationId))
      || (priorSummary.lastEngagedAt ?? null) !== lastReadAt;
    if (forceUnreadRecount) {
      for (const memberId of conversationIds) {
        const memberReadAt = this.operatorReadAt(memberId);
        if (memberReadAt !== null) unreadCount += this.unreadCount(memberId, memberReadAt);
      }
    } else {
      unreadCount = priorSummary.unreadCount;
      if (lastReadAt !== null) {
        for (const conversationId of conversationIds) {
          for (const message of hints.newMessagesByConversation.get(conversationId) ?? []) {
            const createdAt = epochMs(message.createdAt) ?? 0;
            if (createdAt > lastReadAt && !operatorIds.has(message.actorId)) unreadCount += 1;
          }
        }
      }
    }
    const isChild = group.members.some((member) => (
      Boolean(member.parent_conversation_id && member.message_id)
    ));
    const retired = agentMetadata.retiredFromFleet === true;
    const failedLaunchStub = this.isFailedLaunchStub(endpoint);
    let visible = isOpaqueChannelId(row.id) && row.kind !== "system";
    if (row.kind === "direct") {
      visible = visible
        && Boolean(directParticipant)
        && Boolean(directParticipant?.display_name || directParticipant?.agent_id)
        && !retired
        && !failedLaunchStub
        && (isChild || messageCount > 0);
    } else if (row.kind === "channel" || row.kind === "group_direct") {
      visible = visible && (isChild || messageCount > 0 || operatorParticipates);
    } else if (row.kind === "thread") {
      visible = visible && (isChild || messageCount > 0);
    }

    const projectRoot = endpoint?.project_root ?? endpoint?.cwd ?? null;
    const agentName = directParticipant
      ? humanizeWorkspaceName(projectRoot)
        ?? directParticipant.display_name
        ?? directParticipant.actor_id
      : null;
    const latestMessageMetadata = parseJsonObject(latestMessage?.metadata_json);
    const createdAt = group.members.reduce(
      (latest, member) => Math.max(latest, epochMs(member.created_at) ?? 0),
      0,
    );
    const lastActivityAt = Math.max(
      lastMessageAt ?? 0,
      endpoint ? endpointActivityAt(endpoint) : 0,
      invocationActivityAt(invocationActivity),
      createdAt,
    );
    const authorityNodeName = this.db.query<{ name: string }>(
      "SELECT name FROM nodes WHERE id = ?1",
    ).get(row.authority_node_id)?.name ?? null;

    return {
      feedId: scoutConversationFeedId(row.id),
      entityKind: "scout_conversation",
      kind: normalizedKind(row.kind),
      conversationId: row.id,
      runtimeSessionId: metadataSessionId(latestMessageMetadata) ?? endpoint?.session_id ?? null,
      source: null,
      sourceSessionId: null,
      title: agentName ?? row.title,
      alias: conversationAlias(row, metadata),
      naturalKey: conversationNaturalKey({
        id: row.id, kind: row.kind, metadata,
      }) ?? group.naturalKey,
      projectRoot,
      harness: endpoint?.harness ?? null,
      model: metadataString(endpointMetadata, "model")
        ?? metadataString(agentMetadata, "model"),
      effort: metadataString(endpointMetadata, "reasoningEffort")
        ?? metadataString(endpointMetadata, "effort")
        ?? metadataString(agentMetadata, "reasoningEffort")
        ?? metadataString(agentMetadata, "effort"),
      agentId: directParticipant?.actor_id ?? null,
      agentName,
      currentBranch: metadataString(endpointMetadata, "branch")
        ?? metadataString(endpointMetadata, "workspaceQualifier")
        ?? metadataString(agentMetadata, "branch")
        ?? metadataString(agentMetadata, "workspaceQualifier")
        ?? directParticipant?.workspace_qualifier
        ?? null,
      authorityNodeId: row.authority_node_id,
      authorityNodeName,
      parentConversationId: row.parent_conversation_id,
      anchorMessageId: row.message_id,
      activityState: resolvedConversationActivity(endpoint, invocationActivity),
      lastMessageId: latestMessage?.id ?? null,
      lastMessageAt,
      lastActivityAt,
      messageCount,
      unreadCount,
      participantCount,
      preview: truncatePreview(latestMessage?.body),
      lastEngagedAt: lastReadAt,
      sourceFreshAt: null,
      visibilityState: visible ? "visible" : "hidden",
      updatedSeq,
      updatedAt: this.now(),
    };
  }

  private preferredEndpoint(agentId: string, agentMetadata: Record<string, unknown>): EndpointRow | null {
    const rows = this.db.query<EndpointRow>(
      `SELECT id, agent_id, harness, state, session_id, cwd, project_root,
              metadata_json, updated_at
       FROM agent_endpoints
       WHERE agent_id = ?1`,
    ).all(agentId);
    const retired = agentMetadata.retiredFromFleet === true;
    if (retired) return null;
    return rows
      .filter((row) => parseJsonObject(row.metadata_json).staleLocalRegistration !== true)
      .sort(compareEndpointPreference)[0] ?? null;
  }

  private isFailedLaunchStub(endpoint: EndpointRow | null): boolean {
    if (!endpoint || endpoint.state !== "offline") return false;
    const metadata = parseJsonObject(endpoint.metadata_json);
    const hasSession = Boolean(endpoint.session_id?.trim())
      || Boolean(metadataString(metadata, "externalSessionId"))
      || Boolean(metadataString(metadata, "threadId"));
    return metadata.cardless === true
      && metadata.pendingExternalSession === true
      && !hasSession
      && (
        metadata.lastError != null
        || metadata.lastFailedAt != null
      );
  }

  private operatorReadAt(conversationId: string): number | null {
    if (this.operatorActorIds.length === 0) return null;
    const placeholders = this.operatorActorIds.map(() => "?").join(", ");
    const row = this.db.query<{ last_read_at: number | null }>(
      `SELECT MAX(CASE
         WHEN last_read_at > 0 AND last_read_at < ${EPOCH_MILLISECONDS_FLOOR}
           THEN last_read_at * 1000
         ELSE last_read_at
       END) AS last_read_at
       FROM conversation_read_cursors
       WHERE conversation_id = ?
         AND actor_id IN (${placeholders})`,
    ).get(conversationId, ...this.operatorActorIds);
    const value = epochMs(row?.last_read_at);
    return value && value > 0 ? value : null;
  }

  private unreadCount(conversationId: string, readAt: number): number {
    const params: Array<string | number> = [conversationId, readAt];
    let operatorPredicate = "";
    if (this.operatorActorIds.length > 0) {
      operatorPredicate = `AND actor_id NOT IN (${this.operatorActorIds.map(() => "?").join(", ")})`;
      params.push(...this.operatorActorIds);
    }
    return this.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ?
         AND CASE
           WHEN created_at > 0 AND created_at < ${EPOCH_MILLISECONDS_FLOOR}
             THEN created_at * 1000
           ELSE created_at
         END > ?
         ${operatorPredicate}`,
    ).get(...params)?.count ?? 0;
  }

  private writeItem(item: ConversationProjectionItem): void {
    this.db.query(
      `INSERT INTO conversation_projection_items (
         feed_id, entity_kind, kind, conversation_id, runtime_session_id,
         source, source_session_id, title, alias, natural_key, project_root,
         harness, model, effort, agent_id, agent_name, current_branch,
         authority_node_id, authority_node_name, parent_conversation_id,
         anchor_message_id, activity_state, last_message_id, last_message_at,
         last_activity_at, message_count, unread_count, participant_count,
         preview, last_engaged_at, source_fresh_at, visibility_state,
         updated_seq, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )
       ON CONFLICT(feed_id) DO UPDATE SET
         entity_kind = excluded.entity_kind,
         kind = excluded.kind,
         conversation_id = excluded.conversation_id,
         runtime_session_id = excluded.runtime_session_id,
         source = excluded.source,
         source_session_id = excluded.source_session_id,
         title = excluded.title,
         alias = excluded.alias,
         natural_key = excluded.natural_key,
         project_root = excluded.project_root,
         harness = excluded.harness,
         model = excluded.model,
         effort = excluded.effort,
         agent_id = excluded.agent_id,
         agent_name = excluded.agent_name,
         current_branch = excluded.current_branch,
         authority_node_id = excluded.authority_node_id,
         authority_node_name = excluded.authority_node_name,
         parent_conversation_id = excluded.parent_conversation_id,
         anchor_message_id = excluded.anchor_message_id,
         activity_state = excluded.activity_state,
         last_message_id = excluded.last_message_id,
         last_message_at = excluded.last_message_at,
         last_activity_at = excluded.last_activity_at,
         message_count = excluded.message_count,
         unread_count = excluded.unread_count,
         participant_count = excluded.participant_count,
         preview = excluded.preview,
         last_engaged_at = excluded.last_engaged_at,
         source_fresh_at = excluded.source_fresh_at,
         visibility_state = excluded.visibility_state,
         updated_seq = excluded.updated_seq,
         updated_at = excluded.updated_at`,
    ).run(
      item.feedId,
      item.entityKind,
      item.kind,
      item.conversationId,
      item.runtimeSessionId,
      item.source,
      item.sourceSessionId,
      item.title,
      item.alias,
      item.naturalKey,
      item.projectRoot,
      item.harness,
      item.model,
      item.effort,
      item.agentId,
      item.agentName,
      item.currentBranch,
      item.authorityNodeId,
      item.authorityNodeName,
      item.parentConversationId,
      item.anchorMessageId,
      item.activityState,
      item.lastMessageId,
      item.lastMessageAt,
      item.lastActivityAt,
      item.messageCount,
      item.unreadCount,
      item.participantCount,
      item.preview,
      item.lastEngagedAt,
      item.sourceFreshAt,
      item.visibilityState,
      item.updatedSeq,
      item.updatedAt,
    );
  }
}

/** Read-only convenience for web/native shadow readers that already own a DB. */
export function readConversationProjectionItems(
  db: ControlPlaneSqliteDatabase,
  limitInput = CONVERSATION_PROJECTION_LAUNCH_LIMIT,
): ConversationProjectionItem[] {
  const limit = normalizedLimit(
    limitInput,
    CONVERSATION_PROJECTION_LAUNCH_LIMIT,
    CONVERSATION_PROJECTION_MAX_LIST_LIMIT,
  );
  return db.query<ProjectionItemRow>(
    `SELECT *
     FROM conversation_projection_items
     WHERE visibility_state = 'visible'
     ORDER BY last_activity_at DESC, feed_id ASC
     LIMIT ?1`,
  ).all(limit).map(itemFromRow);
}
