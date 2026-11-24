import type { DeliveryPolicy, DeliveryReason, DeliveryStatus, DeliveryTargetKind, DeliveryTransport } from "@openscout/protocol";
import type { BrokerJournalEntry } from "./broker-journal.js";

// Fixed vocabulary only: this table never retains journal IDs, bodies, metadata,
// unknown values or record objects. Missing/new protocol values pass through.
const vocabulary = [
  "participant", "agent", "bridge", "device", "voice_session", "webhook",
  "local_socket", "websocket", "pairing_bridge", "peer_broker", "http", "telegram",
  "discord", "sms", "email", "tts", "native_voice", "claude_channel",
  "claude_stream_json", "codex_app_server", "codex_exec", "claude_resume", "pi_rpc",
  "grok_acp", "kimi_acp", "cursor_acp", "opencode_acp", "antigravity_acp", "devin_acp", "tmux", "ghostty", "rex", "cursor_exec",
  "cursor_cli_text", "cursor_cli_stream_json", "cursor_sdk_local",
  "best_effort", "must_ack", "durable", "ephemeral",
  "conversation_visibility", "direct_message", "mention", "thread_reply",
  "invocation", "bridge_outbound", "speech",
  "accepted", "peer_acked", "running", "completed", "deferred", "failed",
  "cancelled", "pending", "leased", "sent", "acknowledged",
] as const satisfies readonly (DeliveryPolicy | DeliveryReason | DeliveryStatus | DeliveryTargetKind | DeliveryTransport)[];
const shared = new Map<string, string>(vocabulary.map(value => [value, value]));
const deliveryFields = ["targetKind", "transport", "policy", "reason", "status"] as const;

function shareField(record: unknown, field: string): void {
  if (!record || typeof record !== "object" || !Object.hasOwn(record, field)) return;
  const values = record as Record<string, unknown>;
  const value = values[field];
  if (typeof value !== "string") return;
  const replacement = shared.get(value);
  if (replacement !== undefined) values[field] = replacement;
}

/** Mutates only a freshly JSON-parsed, broker-owned replay entry. String values,
 * key membership/order, unknown fields and nested objects remain unchanged. */
export function shareLoadedRecordStrings(entry: BrokerJournalEntry): void {
  if (entry.kind === "deliveries.record" && Array.isArray(entry.deliveries)) {
    for (const delivery of entry.deliveries) {
      for (const field of deliveryFields) shareField(delivery, field);
    }
  } else if (entry.kind === "delivery.status.update") {
    shareField(entry, "status");
  } else if (entry.kind === "message.record") {
    shareField(entry.message, "class");
  }
}
