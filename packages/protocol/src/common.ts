export type ScoutId = string;

export type ScoutAttributionSource = "local-admin" | "scoped" | "system" | "unverified";

export interface ScoutAttribution {
  actorId: ScoutId;
  rootActorId: ScoutId;
  source: ScoutAttributionSource;
  claimedActorId?: ScoutId;
}

export type ActorKind =
  | "person"
  | "helper"
  | "agent"
  | "session"
  | "system"
  | "bridge"
  | "device";

export type AgentState =
  | "registered"
  | "attaching"
  | "waking"
  | "offline"
  | "idle"
  | "active"
  | "waiting"
  | "working"
  | "unreachable"
  | "failed"
  | "superseded"
  | "stopped";

export type VisibilityScope = "private" | "workspace" | "public" | "system";

export type DeliveryStatus =
  // Outbox lifecycle
  | "accepted"        // local journal write done, awaiting forward
  | "peer_acked"      // peer broker journaled the envelope
  | "running"         // target agent claimed the flight
  | "completed"       // terminal success
  | "deferred"        // within retry window — see DeliveryMetadata.nextAttemptAt
  | "failed"          // terminal failure — see DeliveryMetadata.failureReason
  | "cancelled"
  // Legacy values kept for backwards-compatible journal replay
  | "pending"
  | "leased"
  | "sent"
  | "acknowledged";

export type DeliveryFailureReason =
  | "peer_unreachable"   // TCP/network failure — retry-able
  | "peer_rejected"      // peer broker explicitly refused — not retried
  | "agent_offline"      // peer ACK'd but target agent never claimed
  | "timeout"
  | "harness_error"
  | "dispatch"           // ambiguous label — see metadata.scoutDispatch
  | "cancelled";

export type DeliveryPolicy = "best_effort" | "must_ack" | "durable" | "ephemeral";

export type DeliveryTargetKind =
  | "participant"
  | "agent"
  | "bridge"
  | "device"
  | "voice_session"
  | "webhook";

export type DeliveryTransport =
  | "local_socket"
  | "websocket"
  | "pairing_bridge"
  | "peer_broker"
  | "http"
  | "mcp_poll"
  | "devin_cloud_cli"
  | "webhook"
  | "telegram"
  | "discord"
  | "sms"
  | "email"
  | "tts"
  | "native_voice"
  | "claude_channel"
  | "claude_stream_json"
  | "codex_app_server"
  | "codex_exec"
  | "claude_resume"
  | "pi_rpc"
  | "grok_acp"
  | "kimi_acp"
  | "cursor_acp"
  | "opencode_acp"
  | "devin_acp"
  | "tmux"
  | "ghostty"
  | "cursor_exec"
  | "cursor_cli_text"
  | "cursor_cli_stream_json"
  | "cursor_sdk_local";

export type DeliveryReason =
  | "conversation_visibility"
  | "direct_message"
  | "mention"
  | "thread_reply"
  | "invocation"
  | "bridge_outbound"
  | "speech";

export type AdvertiseScope = "local" | "mesh";

export type ShareMode = "local" | "summary" | "shared";

export interface MetadataMap {
  [key: string]: unknown;
}
