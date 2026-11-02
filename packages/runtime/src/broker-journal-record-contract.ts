import type { BrokerJournalEntry } from "./broker-journal.js";
import type { MessageRecord } from "@openscout/protocol";
import { readableDelivery, readableDeliveryStatus, readableMetadata } from "./broker-record-reader.js";

// Exhaustive classification: a newly added journal kind must be considered
// before this reader can certify historical message absence at a boundary.
export const readableJournalKinds: Record<BrokerJournalEntry["kind"], true> = {
  "control.event.record": true,
  "node.upsert": true, "actor.upsert": true, "agent.upsert": true,
  "agent.delete": true, "actor.delete": true,
  "agent.endpoint.upsert": true, "agent.endpoint.delete": true,
  "conversation.upsert": true, "binding.upsert": true, "message.record": true,
  "conversation.read_cursor.upsert": true, "invocation.record": true,
  "invocation.dispatch_job.record": true, "flight.record": true,
  "collaboration.record": true, "collaboration.event.record": true,
  "deliveries.record": true, "delivery.attempt.record": true,
  "durable.action.record": true, "durable.action.heartbeat": true,
  "durable.attempt.record": true, "durable.checkpoint.record": true,
  "durable.signal.record": true, "journal.replay_barrier": true,
  "delivery.status.update": true, "scout.dispatch.record": true,
  "history.rotate": true,
};

export function readableCanonicalMessage(message: unknown): message is MessageRecord {
  const m = message as MessageRecord | null;
  return Boolean(m && typeof m === "object"
    && [m.id, m.conversationId, m.actorId, m.originNodeId, m.body].every(v => typeof v === "string")
    && Number.isFinite(m.createdAt)
    && ["agent", "log", "system", "status", "artifact"].includes(m.class)
    && ["private", "workspace", "public", "system"].includes(m.visibility)
    && ["best_effort", "must_ack", "durable", "ephemeral"].includes(m.policy));
}

/** Validate physical transactions before any reducer observes their first entry.
 * This guards reducer shape requirements, while leaving semantic authority and
 * future schema versions explicit shared faults rather than guessed repairs. */
export function journalEntryProblem(value: unknown): { reason: string; structural?: boolean } | null {
  const entry = value as Record<string, any> | null;
  if (!entry || !Object.hasOwn(readableJournalKinds, entry.kind)) return { reason: "unsupported_journal_kind", structural: true };
  const object = (v: any) => Boolean(v && typeof v === "object" && !Array.isArray(v));
  const strings = (v: any, fields: string[]) => object(v) && fields.every(field => typeof v[field] === "string");
  const identified = (v: any) => strings(v, ["id"]) && readableMetadata(v.metadata);
  let valid = true;
  switch (entry.kind) {
    case "node.upsert": valid = identified(entry.node); break;
    case "actor.upsert": valid = identified(entry.actor); break;
    case "agent.upsert": valid = identified(entry.agent); break;
    case "agent.endpoint.upsert": valid = identified(entry.endpoint) && strings(entry.endpoint, ["agentId", "nodeId", "transport", "state"]); break;
    case "conversation.upsert": valid = identified(entry.conversation) && Array.isArray(entry.conversation.participantIds) && entry.conversation.participantIds.every((id: unknown) => typeof id === "string"); break;
    case "binding.upsert": valid = identified(entry.binding); break;
    case "agent.delete": valid = typeof entry.agentId === "string"; break;
    case "actor.delete": valid = typeof entry.actorId === "string"; break;
    case "agent.endpoint.delete": valid = typeof entry.endpointId === "string"; break;
    case "message.record": valid = readableCanonicalMessage(entry.message); break;
    case "conversation.read_cursor.upsert": valid = strings(entry.cursor, ["conversationId", "actorId"]); break;
    case "invocation.record": valid = identified(entry.invocation) && strings(entry.invocation, ["requesterId", "targetAgentId", "task", "action"]) && Number.isFinite(entry.invocation.createdAt); break;
    case "invocation.dispatch_job.record": valid = identified(entry.job) && strings(entry.job, ["invocationId", "flightId", "state"]) && Number.isFinite(entry.job.attempts); break;
    case "flight.record": valid = identified(entry.flight) && strings(entry.flight, ["invocationId", "requesterId", "targetAgentId", "state"]); break;
    case "collaboration.record": valid = identified(entry.record); break;
    case "collaboration.event.record": valid = identified(entry.event) && typeof entry.event.recordId === "string"; break;
    case "deliveries.record": valid = Array.isArray(entry.deliveries) && entry.deliveries.every(readableDelivery); break;
    case "delivery.attempt.record": valid = identified(entry.attempt) && typeof entry.attempt.deliveryId === "string"; break;
    case "delivery.status.update": valid = typeof entry.deliveryId === "string" && readableDeliveryStatus(entry.status) && readableMetadata(entry.metadata); break;
    case "durable.action.record": valid = identified(entry.action); break;
    case "durable.action.heartbeat": valid = strings(entry.input, ["actionId", "owner"]) && ["generation", "heartbeatAt", "leaseMs"].every(field => Number.isFinite(entry.input[field])); break;
    case "durable.attempt.record": valid = identified(entry.attempt); break;
    case "durable.checkpoint.record": valid = strings(entry.checkpoint, ["actionId", "name"]) && Number.isFinite(entry.checkpoint.createdAt); break;
    case "durable.signal.record": valid = strings(entry.signal, ["actionId", "name"]) && Number.isFinite(entry.signal.emittedAt); break;
    case "scout.dispatch.record": valid = identified(entry.dispatch); break;
    case "control.event.record": valid = identified(entry.event) && strings(entry.event, ["kind", "actorId"]) && Number.isFinite(entry.event.ts) && object(entry.event.payload)
      && (entry.payloadRecord === undefined || (strings(entry.payloadRecord, ["id", "sha256"]) && ["flight", "message", "invocation"].includes(entry.payloadRecord.field))); break;
    case "journal.replay_barrier":
      return identified(entry.barrier) && typeof entry.barrier.projectionId === "string" ? null : { reason: "invalid_replay_barrier", structural: true };
    case "history.rotate":
      valid = Number.isFinite(entry.cutoff) && Number.isFinite(entry.rotatedAt)
        && (entry.evicted === undefined || (object(entry.evicted) && Object.values(entry.evicted).every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string"))))
        && (entry.publications === undefined || Array.isArray(entry.publications));
      return valid ? null : { reason: "invalid_history_rotation", structural: true };
  }
  return valid ? null : { reason: `malformed_${entry.kind}` };
}
