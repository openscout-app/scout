import type {
  ActorKind,
  AdvertiseScope,
  AgentState,
  DeliveryTransport,
  MetadataMap,
  ScoutId,
} from "./common.js";

export type AgentClass =
  | "general"
  | "builder"
  | "reviewer"
  | "researcher"
  | "operator"
  | "bridge"
  | "system";

export type AgentCapability =
  | "chat"
  | "invoke"
  | "deliver"
  | "speak"
  | "listen"
  | "bridge"
  | "summarize"
  | "review"
  | "execute";

export type AgentEndpointTransport = Extract<
  DeliveryTransport,
  | "local_socket"
  | "http"
  | "mcp_poll"
  | "devin_cloud_cli"
  | "websocket"
  | "pairing_bridge"
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
  | "rex"
  | "cursor_exec"
  | "cursor_cli_text"
  | "cursor_cli_stream_json"
  | "cursor_sdk_local"
>;

export const AGENT_HARNESSES = [
  "codex",
  "claude",
  "grok",
  "grok-acp",
  "kimi",
  "flue",
  "cursor",
  "opencode",
  "devin",
  "native",
  "worker",
  "bridge",
  "http",
  "pi",
] as const;

export type AgentHarness = typeof AGENT_HARNESSES[number];

export type WakePolicy = "manual" | "on_demand" | "keep_warm";

export interface ActorIdentity {
  id: ScoutId;
  kind: ActorKind;
  displayName: string;
  handle?: string;
  labels?: string[];
  metadata?: MetadataMap;
}

export interface AgentDefinition extends ActorIdentity {
  kind: "agent";
  definitionId: ScoutId;
  nodeQualifier?: string;
  workspaceQualifier?: string;
  selector?: string;
  defaultSelector?: string;
  agentClass: AgentClass;
  capabilities: AgentCapability[];
  wakePolicy: WakePolicy;
  homeNodeId: ScoutId;
  authorityNodeId: ScoutId;
  advertiseScope: AdvertiseScope;
  ownerId?: ScoutId;
}

export interface HelperDefinition extends ActorIdentity {
  kind: "helper";
  ownerId: ScoutId;
  nodeId: ScoutId;
  engine: AgentHarness;
  capabilities: AgentCapability[];
}

export interface AgentEndpoint {
  id: ScoutId;
  agentId: ScoutId;
  nodeId: ScoutId;
  harness: AgentHarness;
  transport: AgentEndpointTransport;
  state: AgentState;
  preferred?: boolean;
  address?: string;
  sessionId?: string;
  pane?: string;
  cwd?: string;
  projectRoot?: string;
  metadata?: MetadataMap;
}
