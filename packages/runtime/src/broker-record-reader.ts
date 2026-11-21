/** A byte boundary is valid only for the captured journal file identity. */
export type BrokerRecordReadCoverage = {
  source: "broker_journal";
  fileIdentity: string;
  endByteExclusive: number;
};
export type BrokerRecordRead<T> =
  | { kind: "found"; value: T; coverage: BrokerRecordReadCoverage }
  | { kind: "not_found"; coverage: BrokerRecordReadCoverage }
  | { kind: "unavailable"; reason: string; retryable: boolean };

import type { DeliveryIntent } from "@openscout/protocol";
// Exhaustive maps make new protocol enum values an explicit reader decision.
const statuses: Record<DeliveryIntent["status"], true> = {
  accepted:true,peer_acked:true,running:true,completed:true,deferred:true,failed:true,
  cancelled:true,pending:true,leased:true,sent:true,acknowledged:true,
};
const targets: Record<DeliveryIntent["targetKind"],true> = {participant:true,agent:true,bridge:true,device:true,voice_session:true,webhook:true};
const policies: Record<DeliveryIntent["policy"],true> = {best_effort:true,must_ack:true,durable:true,ephemeral:true};
const reasons: Record<DeliveryIntent["reason"],true> = {conversation_visibility:true,direct_message:true,mention:true,thread_reply:true,invocation:true,bridge_outbound:true,speech:true};
const transports: Record<DeliveryIntent["transport"],true> = {
  local_socket:true,websocket:true,pairing_bridge:true,peer_broker:true,http:true,mcp_poll:true,devin_cloud_cli:true,webhook:true,
  telegram:true,discord:true,sms:true,email:true,tts:true,native_voice:true,claude_channel:true,
  claude_stream_json:true,codex_app_server:true,codex_exec:true,claude_resume:true,pi_rpc:true,
  grok_acp:true,kimi_acp:true,cursor_acp:true,opencode_acp:true,devin_acp:true,tmux:true,ghostty:true,rex:true,cursor_exec:true,
  cursor_cli_text:true,cursor_cli_stream_json:true,cursor_sdk_local:true,
};
export function readableDeliveryStatus(value: unknown): value is DeliveryIntent["status"] {
  return typeof value === "string" && Object.hasOwn(statuses,value);
}
export function readableMetadata(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value));
}
export function readableDelivery(value: unknown): value is DeliveryIntent {
  if (!value || typeof value !== "object") return false;
  const d=value as DeliveryIntent;
  return typeof d.id === "string" && typeof d.targetId === "string"
    && typeof d.targetKind === "string" && Object.hasOwn(targets,d.targetKind)
    && typeof d.policy === "string" && Object.hasOwn(policies,d.policy)
    && typeof d.reason === "string" && Object.hasOwn(reasons,d.reason)
    && typeof d.transport === "string" && Object.hasOwn(transports,d.transport)
    && readableDeliveryStatus(d.status)
    && [d.messageId,d.invocationId,d.targetNodeId,d.bindingId,d.leaseOwner].every(v=>v===undefined||typeof v==="string")
    && (d.leaseExpiresAt===undefined || (typeof d.leaseExpiresAt==="number" && Number.isFinite(d.leaseExpiresAt)))
    && readableMetadata(d.metadata);
}

export class BrokerRecordCacheUnavailable extends Error {
  readonly code = "record_cache_unavailable";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BrokerRecordCacheUnavailable";
  }
}
