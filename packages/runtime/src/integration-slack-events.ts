import { slackDeliveryId } from "./slack-identities.js";
import type { ScoutDeliverResponse } from "@openscout/protocol";
import { z } from "zod";
import { BrokerIntegrationSetupService, IntegrationSetupError } from "./broker-integration-setup.js";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";

export const INTEGRATION_SLACK_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS integration_slack_events (
  operation_id TEXT NOT NULL REFERENCES integration_setup_operations(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  progress_json TEXT,
  result_completed_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_slack_pending_events
  ON integration_slack_events (operation_id, state, received_at);
`;
const stamp = z.string().regex(/^\d+\.\d+$/);
// Strip Slack's deprecated verification-token field and other unused payload
// metadata; keep only observed content required to recover this adapter event.
const envelopeSchema = z.object({
  envelope_id: z.string().min(1).max(256), type: z.literal("events_api"),
  payload: z.object({ event_id: z.string().min(1).max(256), team_id: z.string(), api_app_id: z.string(),
    event: z.object({ type: z.enum(["app_mention", "message"]), channel: z.string(), user: z.string(), ts: stamp, thread_ts: stamp.optional(),
      channel_type: z.string().optional(), text: z.string().max(100_000).optional(), bot_id: z.string().optional(), subtype: z.string().optional(),
      files: z.array(z.object({ id: z.string().max(256), name: z.string().max(512).optional(), title: z.string().max(512).optional(), mimetype: z.string().max(256).optional(), size: z.number().nonnegative().optional(), url_private_download: z.string().max(4096).optional(), url_private: z.string().max(4096).optional() })).max(20).optional(),
    }),
  }),
});
const requestSchema = z.object({
  generation: z.number().int().positive(), token: z.string().min(1).max(256),
  action: z.enum(["receive", "pending", "complete", "failed", "progress", "watches", "result_complete"]),
  progress: z.object({ ts: stamp, mode: z.enum(["task_card", "text"]), title: z.string().max(512) }).strict().optional(),
  afterRowId: z.number().int().nonnegative().optional(),
  envelope: z.unknown().optional(), eventId: z.string().min(1).max(256).optional(),
}).strict();

export class IntegrationSlackEvents {
  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase, private readonly setup: BrokerIntegrationSetupService, private readonly now = Date.now) {}
  request(id: string, input: unknown): Record<string, unknown> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new IntegrationSetupError("invalid_event_request", "Invalid Slack event request.", 400);
    const request = parsed.data;
    this.setup.workerRequest(id, { action: "check", generation: request.generation, token: request.token });
    const operation = this.setup.authorizeWorker({ operationId: id, generation: request.generation, token: request.token, expiresAt: 0 });
    const now = this.now();
    if (request.action === "receive") {
      const parsedEnvelope = envelopeSchema.safeParse(request.envelope);
      if (!parsedEnvelope.success) return { accepted: false };
      const envelope = parsedEnvelope.data;
      const { event, event_id: eventId } = envelope.payload;
      if (envelope.payload.team_id !== operation.workspaceId || envelope.payload.api_app_id !== operation.appId
        || (event.bot_id && !event.user) || event.subtype || event.user === operation.credentials?.botUserId
        || !operation.credentials?.allowedUserIds.includes(event.user)
        || (event.type === "message" && (event.channel_type !== "im" || !event.channel.startsWith("D")))
        || (event.type === "app_mention" && !operation.credentials.allowedChannelIds.includes(event.channel))) return { accepted: false };
      const routing = event.type === "app_mention" ? this.setup.classifyMention(id, event.text ?? "") : "addressed";
      if (routing === "not_addressed") return { accepted: false };
      const thread = this.database.query<{ binding_revision: number }>("SELECT binding_revision FROM integration_slack_threads WHERE operation_id = ?1 AND channel_id = ?2 AND thread_ts = ?3").get(id, event.channel, event.thread_ts ?? event.ts);
      const routingIssue = routing === "ambiguous" ? "ambiguous_project_mentions" : thread && thread.binding_revision !== operation.binding.revision ? "binding_changed" : undefined;
      const storedEnvelope = { ...envelope, ...(routingIssue ? { routingIssue } : {}) };
      return this.database.transaction(() => {
        const existing = this.database.query<{ state: string }>("SELECT state FROM integration_slack_events WHERE operation_id = ?1 AND event_id = ?2").get(id, eventId);
        if (existing) return { accepted: true, duplicate: true, state: existing.state };
        const pending = this.database.query<{ count: number }>("SELECT COUNT(*) AS count FROM integration_slack_events WHERE operation_id = ?1 AND state = 'pending'").get(id)!;
        if (pending.count >= 1000) throw new IntegrationSetupError("event_queue_full", "Slack event recovery queue is full; persistence was not acknowledged.", 503);
        this.database.query("INSERT INTO integration_slack_events (operation_id,event_id,channel_id,thread_ts,binding_revision,envelope_json,delivery_key,state,next_attempt_at,received_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?8,?8)")
          .run(id, eventId, event.channel, event.thread_ts ?? event.ts, operation.binding.revision, JSON.stringify(storedEnvelope), slackDeliveryId(operation.workspaceId!, event.channel, event.ts, id), now);
        return { accepted: true, duplicate: false, state: "pending" };
      })();
    }
    if (request.action === "pending") {
      // Do not overtake a failed earlier request in the same Slack thread.
      const rows = this.database.query<{ envelope_json: string; progress_json: string | null }>(`SELECT current.envelope_json, current.progress_json FROM integration_slack_events AS current
        WHERE current.operation_id = ?1 AND current.state = 'pending' AND current.binding_revision = ?2 AND current.next_attempt_at <= ?3
          AND NOT EXISTS (SELECT 1 FROM integration_slack_events AS earlier WHERE earlier.operation_id = current.operation_id
            AND earlier.channel_id = current.channel_id AND earlier.thread_ts = current.thread_ts AND earlier.state = 'pending'
            AND (earlier.received_at < current.received_at OR (earlier.received_at = current.received_at AND earlier.rowid < current.rowid)))
        ORDER BY current.received_at, current.rowid LIMIT 100`).all(id, operation.binding.revision, now);
      this.database.query("DELETE FROM integration_slack_events WHERE operation_id = ?1 AND state = 'processed' AND (result_completed_at IS NOT NULL OR progress_json IS NULL) AND updated_at < ?2").run(id, now - 7 * 86_400_000);
      return { events: rows.map(row => ({ envelope: JSON.parse(row.envelope_json), progress: row.progress_json ? JSON.parse(row.progress_json) : null })) };
    }
    if (request.action === "watches") {
      const rows = this.database.query<{ row_id: number; event_id: string; channel_id: string; thread_ts: string; progress_json: string; response_json: string; updated_at: number }>(`SELECT event.rowid AS row_id,event.event_id,event.channel_id,event.thread_ts,event.progress_json,delivery.response_json,event.updated_at
        FROM integration_slack_events AS event JOIN integration_slack_deliveries AS delivery
        ON event.operation_id = delivery.operation_id AND event.delivery_key = delivery.event_key
        WHERE event.operation_id = ?1 AND event.binding_revision = ?2 AND event.progress_json IS NOT NULL
          AND event.result_completed_at IS NULL AND delivery.response_json IS NOT NULL AND event.rowid > ?3
        ORDER BY event.rowid LIMIT 100`).all(id, operation.binding.revision, request.afterRowId ?? 0);
      return { nextAfterRowId: rows.length === 100 ? rows.at(-1)!.row_id : 0, bindings: rows.flatMap(row => {
        const response = JSON.parse(row.response_json) as ScoutDeliverResponse;
        if (response.kind !== "delivery" || !response.flight?.invocationId) return [];
        const progress = JSON.parse(row.progress_json) as { ts: string; mode: string; title: string };
        return [{ eventId: row.event_id, installationId: id, bindingRevision: operation.binding.revision, teamId: operation.workspaceId,
          channelId: row.channel_id, threadTs: row.thread_ts, conversationId: response.receipt.conversationId, messageId: response.receipt.messageId,
          bindingRef: response.receipt.messageId, projectPath: operation.binding.projectPath, responseTs: progress.ts, progressMode: progress.mode,
          title: progress.title, flightId: response.flight.id, invocationId: response.flight.invocationId, workId: response.workItem?.id, updatedAt: row.updated_at }];
      }) };
    }
    if (!request.eventId) throw new IntegrationSetupError("event_id_required", "A persisted event ID is required.", 400);
    if (request.action === "progress") {
      if (!request.progress) throw new IntegrationSetupError("progress_required", "A Slack progress message receipt is required.", 400);
      // The first recorded message wins; a lost post acknowledgement may leave
      // an orphan Slack message but cannot silently redirect result delivery.
      this.database.query("UPDATE integration_slack_events SET progress_json = COALESCE(progress_json, ?1), updated_at = ?2 WHERE operation_id = ?3 AND event_id = ?4 AND binding_revision = ?5")
        .run(JSON.stringify(request.progress), now, id, request.eventId, operation.binding.revision);
    } else if (request.action === "result_complete") {
      this.database.query("UPDATE integration_slack_events SET result_completed_at = ?1, updated_at = ?1 WHERE operation_id = ?2 AND event_id = ?3 AND binding_revision = ?4")
        .run(now, id, request.eventId, operation.binding.revision);
    } else if (request.action === "complete") {
      this.database.query(`UPDATE integration_slack_events SET state = 'processed', updated_at = ?1,
        result_completed_at = CASE WHEN progress_json IS NULL OR NOT EXISTS (
          SELECT 1 FROM integration_slack_deliveries AS delivery WHERE delivery.operation_id = integration_slack_events.operation_id
            AND delivery.event_key = integration_slack_events.delivery_key AND json_extract(delivery.response_json, '$.flight.invocationId') IS NOT NULL
        ) THEN COALESCE(result_completed_at, ?1) ELSE result_completed_at END WHERE operation_id = ?2 AND event_id = ?3 AND binding_revision = ?4`)
        .run(now, id, request.eventId, operation.binding.revision);
    } else {
      this.database.query("UPDATE integration_slack_events SET attempts = attempts + 1, next_attempt_at = ?1, updated_at = ?2 WHERE operation_id = ?3 AND event_id = ?4 AND state = 'pending' AND binding_revision = ?5")
        .run(now + 15_000, now, id, request.eventId, operation.binding.revision);
    }
    return { recorded: true };
  }
}
