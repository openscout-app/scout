/* ── Shared types for the Scout web UI ── */
import type { SearchFilters } from "./knowledge-search.ts";
import type {
  WebActivityItem,
  WebAgent,
  WebAgentAuthorityProfile,
  WebAgentBrokerActivity,
  WebAgentRun,
  WebAgentRuntimePolicy,
  WebBrokerDiagnostics,
  WebBrokerDiagnosticsSource,
  WebBrokerDialogueItem,
  WebBrokerHistoryKey,
  WebBrokerRouteAttempt,
  WebFleetActivity,
  WebFleetAsk,
  WebFleetAttentionItem,
  WebFleetState,
  WebFlight,
  WebFollowTarget,
  WebServedMessage,
  WebTerminalSurfaceDescriptor,
  WebWorkDetailResponse,
  WebWorkInvocation,
  WebWorkItem,
  WebWorkTimelineItem,
  WebWorkTimelineKind,
} from "../../shared/api/web.ts";
import type {
  WorkInventoryAgentRef,
  WorkInventoryConfidence,
  WorkInventoryMode,
  WorkInventorySessionRef,
  WorkInventorySource,
  WorkMaterial,
  WorkMaterialContent,
  WorkMaterialEvidence,
  WorkMaterialKind,
  WorkMaterialStatus,
  WorkMaterialsInventory,
} from "../../shared/api/work-materials.ts";
import type {
  ObserveFile,
  ObserveMetadata,
  ObservePulse,
  ObserveSessionMeta,
  ObserveUsageMeta,
} from "../../shared/api/observe.ts";
import type {
  AgentObservePayload as ServedAgentObservePayload,
  ObserveData as ServedObserveData,
  ObserveEvent as ServedObserveEvent,
} from "../../shared/api/observe.ts";
import type {
  ObservedHarnessAgent,
  ObservedHarnessGroup,
  ObservedHarnessRelationship,
  ObservedHarnessSourceRef,
  ObservedHarnessTask,
  ObservedHarnessTopology,
} from "@openscout/agent-sessions";
import type {
  PlanDocument,
  PlanDocumentKind,
  PlanDocumentSource,
  PlanDocumentStatus,
  PlanDocumentStep,
  PlanDocumentStepStatus,
  PlanDocumentsResponse,
} from "../../shared/api/plans.ts";
import type {
  Broadcast,
  BroadcastTier,
} from "../../shared/api/broadcasts.ts";
import type {
  WebMeshOpsFlight,
  WebMeshOpsHost,
  WebMeshOpsItem,
} from "../../shared/api/web.ts";
import type {
  AgentRunMetrics,
  MessageAttachment,
} from "@openscout/protocol";
import type {
  MeshIssue,
} from "../../shared/api/mesh.ts";
export type {
  MeshIssue,
} from "../../shared/api/mesh.ts";
export type {
  AgentRunMetrics,
  MessageAttachment,
} from "@openscout/protocol";
export type {
  WebMeshOpsFlight,
  WebMeshOpsHost,
  WebMeshOpsItem,
} from "../../shared/api/web.ts";
export type {
  Broadcast,
  BroadcastTier,
} from "../../shared/api/broadcasts.ts";
export type {
  PlanDocument,
  PlanDocumentKind,
  PlanDocumentSource,
  PlanDocumentStatus,
  PlanDocumentStep,
  PlanDocumentStepStatus,
  PlanDocumentsResponse,
} from "../../shared/api/plans.ts";
export type {
  ObservedHarnessAgent,
  ObservedHarnessGroup,
  ObservedHarnessRelationship,
  ObservedHarnessSourceRef,
  ObservedHarnessTask,
  ObservedHarnessTopology,
} from "@openscout/agent-sessions";
export type {
  ObserveFile,
  ObserveMetadata,
  ObservePulse,
  ObserveSessionMeta,
  ObserveUsageMeta,
} from "../../shared/api/observe.ts";
export type {
  WorkInventoryAgentRef,
  WorkInventoryConfidence,
  WorkInventoryMode,
  WorkInventorySessionRef,
  WorkInventorySource,
  WorkMaterial,
  WorkMaterialContent,
  WorkMaterialEvidence,
  WorkMaterialKind,
  WorkMaterialStatus,
  WorkMaterialsInventory,
} from "../../shared/api/work-materials.ts";
/**
 * An observe event as the client handles it. The floor view also builds
 * events from tail records and marks agent-to-agent messages with
 * `communication`; the server never sends that field.
 */
export type ObserveEvent = ServedObserveEvent & {
  communication?: { from: string; to: string; received: true; bodyAvailable: boolean };
};

export type ObserveData = Omit<ServedObserveData, "events"> & { events: ObserveEvent[] };

export type AgentObservePayload = Omit<ServedAgentObservePayload, "data"> & { data: ObserveData };

export type Agent = WebAgent;

export type AgentBrokerActivity = WebAgentBrokerActivity;

export type AgentAuthorityProfile = WebAgentAuthorityProfile;

export type AgentRuntimePolicy = WebAgentRuntimePolicy;

export type TerminalSurfaceDescriptor = WebTerminalSurfaceDescriptor;

export type HarnessTopologyObservation = {
  id: string;
  source: string;
  observedAt: string;
  changedAt: number;
  fingerprint: string;
  summary: {
    groups: number;
    agents: number;
    tasks: number;
    relationships: number;
  };
  topology: ObservedHarnessTopology;
};

export type HarnessTopologySnapshot = {
  generatedAt: number;
  observations: HarnessTopologyObservation[];
  totals: {
    sources: number;
    groups: number;
    agents: number;
    tasks: number;
    relationships: number;
  };
};

export type AgentConfigurationRuntime = {
  id: string;
  label: string;
  description: string;
  state: "ready" | "configured" | "installed" | "missing";
  detail: string;
  binaryPath: string | null;
  loginCommand: string | null;
  capabilities: string[];
  source: "builtin" | "local";
};

export type AgentConfigurationProvider = {
  id: string;
  name: string;
  protocol: "openai-compatible";
  status: "configured" | "missing";
  baseUrl: string;
  docsUrl: string;
  envKeys: string[];
  note: string;
};

export type AgentConfigurationAgent = {
  id: string;
  name: string;
  source: "broker";
  status: string;
  harness: string | null;
  transport: string | null;
  model: string | null;
  projectRoot: string | null;
  cwd: string | null;
  capabilities: string[];
  conversationId: string | null;
};

export type LocalAgentConfigState = {
  agentId: string;
  editable: boolean;
  model: string | null;
  permissionProfile: string | null;
  systemPrompt: string;
  runtime: {
    cwd: string;
    harness: string;
    transport: string;
    sessionId: string;
    wakePolicy: string;
  };
  launchArgs: string[];
  capabilities: string[];
  applyMode: "restart" | (string & {});
  templateHint: string;
};

export type AgentConfigurationProject = {
  id: string;
  title: string;
  root: string;
  source: string;
  registrationKind: string;
  defaultHarness: string;
  projectConfigPath: string | null;
};

export type AgentConfigurationIntegration = {
  id: string;
  name: string;
  status: "enabled" | "disabled" | "running" | "error";
  detail: string;
  source: "bridge" | "broker" | "system";
};

export type AgentConfigurationState = {
  generatedAt: number;
  context: {
    currentDirectory: string;
    workspaceRoots: string[];
    hiddenProjectCount: number;
    defaultHarness: string;
    defaultTransport: string;
    defaultCapabilities: string[];
    sessionPrefix: string;
  };
  broker: {
    label: string;
    reachable: boolean;
    healthy: boolean;
    nodeId: string | null;
    agentCount: number;
    messageCount: number;
    error: string | null;
  };
  runtimes: AgentConfigurationRuntime[];
  providers: AgentConfigurationProvider[];
  agents: AgentConfigurationAgent[];
  projects: AgentConfigurationProject[];
  integrations: AgentConfigurationIntegration[];
  toolContext: {
    mcpServerCount: number;
    note: string;
  };
  gaps: string[];
};

export type Message = WebServedMessage;

export type ActivityItem = WebActivityItem;

export type BrokerRouteAttempt = WebBrokerRouteAttempt;

export type BrokerDialogueItem = WebBrokerDialogueItem;

export type BrokerHistoryKey = WebBrokerHistoryKey;

export type BrokerDiagnosticsSource = WebBrokerDiagnosticsSource;

export type BrokerDiagnostics = WebBrokerDiagnostics;

export type FleetActivity = WebFleetActivity;

export type FleetAsk = WebFleetAsk;

export type FleetAttentionItem = WebFleetAttentionItem;

export type FleetState = WebFleetState;

export type PairingSnapshot = {
  qrValue?: string | null;
  expiresAt?: number;
  relay?: string | null;
} | null;

export type TrustedPeer = {
  fingerprint: string;
  name: string | null;
  pairedAtLabel: string;
  lastSeenLabel: string;
};

export type PairingState = {
  status: string;
  statusLabel: string;
  statusDetail: string | null;
  isRunning: boolean;
  commandLabel: string;
  pairing: PairingSnapshot;
  lastUpdatedLabel: string | null;
  relay: string | null;
  secure: boolean;
  identityFingerprint: string | null;
  connectedPeerFingerprint: string | null;
  trustedPeerCount: number;
  trustedPeers: TrustedPeer[];
  pendingApprovals: PairingApprovalRequest[];
};

export type PairingApprovalRequest = {
  sessionId: string;
  sessionName: string;
  adapterType: string;
  turnId: string;
  blockId: string;
  version: number;
  risk: "low" | "medium" | "high";
  title: string;
  description: string;
  detail: string | null;
  actionKind: "command" | "file_change" | "tool_call" | "subagent";
  actionStatus: string;
};

export type OperatorAttentionKind = "approval" | "configuration" | "ask" | "work_item" | "question" | "session";
export type OperatorAttentionActionKind = "approve" | "deny" | "open" | "configure" | "copy" | "dismiss";

export type OperatorAttentionAction = {
  kind: OperatorAttentionActionKind;
  label: string;
  route?: Route;
  value?: string;
  recordId?: string;
  recordKind?: "work_item" | "question";
  flightId?: string;
};

export type OperatorAttentionItem = {
  id: string;
  kind: OperatorAttentionKind;
  title: string;
  summary: string | null;
  detail: string | null;
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  updatedAt: number;
  severity: "critical" | "warning" | "info";
  sourceLabel: string;
  permission?: { requestId: string; version: string; sessionId: string; projectRoot: string; flightId?: string };
  approval?: PairingApprovalRequest;
  /** A declared question's offered answers; one is sent as the operator's reply. */
  answer?: { conversationId: string; replyToMessageId: string; options: string[] };
  actions: OperatorAttentionAction[];
};

export type OperatorAttentionState = {
  generatedAt: number;
  totals: {
    all: number;
    approvals: number;
    configuration: number;
    collaboration: number;
  };
  items: OperatorAttentionItem[];
};

export type AgentRunState =
  | "queued"
  | "waking"
  | "running"
  | "waiting"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
  | (string & {});

export type AgentRunSource =
  | "ask"
  | "message"
  | "schedule"
  | "recipe"
  | "external_issue"
  | "manual"
  | "eval"
  | "unknown"
  | (string & {});

export type AgentRunReviewState =
  | "none"
  | "needed"
  | "blocked"
  | "approved"
  | "rejected"
  | (string & {});

export type AgentRun = WebAgentRun;

export type RunItem = AgentRun;

export type RunsResponse =
  | RunItem[]
  | {
      generatedAt?: number;
      runs: RunItem[];
      totals?: Record<string, number | undefined>;
    };

export type Flight = WebFlight;

export type FlightSessionTrace = {
  sessionId: string;
  endpointId?: string;
  nodeId?: string;
  harness?: string;
  transport?: string;
  strategy?: string;
  startedAt: number;
  lastAcknowledgedAt: number;
  endedAt?: number;
};

export type WorkInvocation = WebWorkInvocation;

export type WorkItem = WebWorkItem;

/** An inbox row: agent + conversation summary merged. */
export type InboxEntry = {
  agent: Agent;
  conversationId: string;
  preview: string | null;
  previewActor: string | null;
  messageCount: number;
  lastMessageAt: number | null;
};

/** A conversation from the sessions list (any kind, not just DMs). */
export type SessionEntry = {
  id: string;
  /** Broker conversation ids coalesced into this canonical Chat. */
  equivalentConversationIds?: string[];
  kind: string;
  title: string;
  alias?: string | null;
  naturalKey?: string | null;
  participantIds: string[];
  participants?: Array<{
    actorId: string;
    kind?: string | null;
    displayName: string;
    label: string;
    scopedAlias?: string | null;
    agentId?: string | null;
    sessionId?: string | null;
    harness?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    transport?: string | null;
    workspaceRoot?: string | null;
  }>;
  /**
   * True total participant count. `participantIds`/`participants` may be
   * capped server-side for large channel rosters — prefer this for counts.
   */
  participantCount?: number;
  authorityNodeId?: string | null;
  authorityNodeName?: string | null;
  executionNodeId?: string | null;
  executionNodeName?: string | null;
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  model?: string | null;
  /** Broker-owned session identity for a session-backed conversation. */
  sessionId?: string | null;
  harnessSessionId: string | null;
  harnessLogPath: string | null;
  currentBranch: string | null;
  preview: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  workspaceRoot: string | null;
  /** Work item of the ask that started or last steered this session. */
  workItemId?: string | null;
  /** That work item's title. */
  workItemTitle?: string | null;
  /** First line of that ask's task, as plain text. */
  currentTask?: string | null;
};

export type ConversationEntry = SessionEntry;

export type TmuxPeekPayload = {
  available: boolean;
  agentId: string;
  sessionId: string | null;
  capturedAt: number;
  body: string;
  lineCount: number;
  columnCount: number;
  truncated: boolean;
  reason: string | null;
};

export type SessionCatalogEntry = {
  id: string;
  startedAt: number;
  endedAt?: number;
  cwd: string;
  harness?: string;
  transport?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  provider?: string | null;
  source?: string;
  historyPath?: string;
  surfaceSessionId?: string | null;
  harnessSessionId?: string | null;
  externalSessionId?: string | null;
  threadId?: string | null;
  runtimeSessionId?: string | null;
  canObserve?: boolean;
  canTakeover?: boolean;
};

export type SessionCatalog = {
  activeSessionId: string | null;
  sessions: SessionCatalogEntry[];
};

export type SessionCatalogWithResume = SessionCatalog & {
  agentId: string;
  harness: string | null;
  resumeCommand: string | null;
  resumeCwd: string | null;
};

export type LocalAgentContextState = {
  agentId: string;
  state: "fresh" | "aging" | "stale";
  reason: string | null;
  generatedAt: number;
  activeSessionId: string | null;
  sessionStartedAt: number | null;
  sessionAgeMs: number | null;
  turnCount: number;
  currentTurnActive: boolean;
  contextWindow: {
    contextInputTokens: number | null;
    totalTokens: number | null;
    contextWindowTokens: number | null;
    usedPercent: number | null;
  } | null;
  canAutoReset: boolean;
  policy: {
    maxTurns: number;
    maxAgeMs: number;
    agingRatio: number;
  };
  model: string | null;
  harness: string;
  transport: string;
};

export type InterruptThreshold = "always" | "blocking-only" | "batched" | "never";
export type CommsChannel = "here" | "mobile" | "here+mobile";
export type CommsVerbosity = "terse" | "normal" | "detailed";
export type CommsTone = "direct" | "warm" | "formal";
export type ProvisionalAgentNamesMode = "replace" | "extend";
export type ProvisionalAgentNamePoolSource =
  | "default"
  | "user-settings-replace"
  | "user-settings-extend"
  | "env-file"
  | "user-config-file"
  | "home-json";

export type OperatorProfile = {
  name: string;
  handle: string;
  pronouns: string;
  hue: number;
  bio: string;
  timezone: string;
  workingHours: string;
  interruptThreshold: InterruptThreshold;
  batchWindow: number;
  channel: CommsChannel;
  verbosity: CommsVerbosity;
  tone: CommsTone;
  quietHours: string;
  provisionalAgentNames: string[];
  provisionalAgentNamesMode: ProvisionalAgentNamesMode;
  provisionalAgentNamesResolvedCount: number;
  provisionalAgentNamesPreview: string[];
  provisionalAgentNamesSource: ProvisionalAgentNamePoolSource;
  /**
   * Editing drafts for the runtime lists — comma-separated `harness/model`
   * specs and one `id[:Label]=harness/model/effort` per line. `save` translates
   * them into the API arrays; the server validates and answers 400 with the
   * reason when a spec does not parse.
   */
  runtimeShortlistText: string;
  runtimePresetsText: string;
};

export type MeshStatus = {
  brokerUrl: string;
  health: {
    reachable: boolean;
    ok: boolean;
    nodeId: string | null;
    meshId: string | null;
    build?: {
      packageName: string;
      version: string | null;
      commit?: string | null;
      branch?: string | null;
      buildId?: string | null;
      buildNumber?: string | null;
      mode?: "dev" | "production";
    } | null;
    error: string | null;
  };
  localNode: {
    id: string;
    name: string;
    meshId?: string;
    hostName?: string;
    advertiseScope?: string;
    brokerUrl?: string;
    capabilities?: string[];
  } | null;
  meshId: string | null;
  identity: {
    name: string | null;
    nodeId: string | null;
    meshId: string | null;
    modeLabel: string;
    discoverable: boolean;
    announceUrl: string | null;
    discoveryDetail: string;
  };
  nodes: Record<
    string,
    {
      id: string;
      name: string;
      meshId?: string;
      hostName?: string;
      advertiseScope?: string;
      brokerUrl?: string;
      capabilities?: string[];
      registeredAt?: number;
      lastSeenAt?: number;
      /**
       * High-level host facts a node announces to the mesh. All fields optional
       * so the UI can render placeholders before the broker fills them in.
       */
      host?: {
        scoutVersion?: string;
        os?: string;
        arch?: string;
        cpuCores?: number;
        memoryGb?: number;
        storageCapacityGb?: number;
        network?: string;
      };
    }
  >;
  tailscale: {
    available: boolean;
    running: boolean;
    backendState: string | null;
    health: string[];
    onlineCount: number;
    peers: Array<{
      id: string;
      name: string;
      dnsName?: string;
      hostName?: string;
      addresses: string[];
      online: boolean;
      os?: string;
    }>;
  };
  issues: MeshIssue[];
  warnings: string[];
};

export type WorkTimelineKind = WebWorkTimelineKind;

export type WorkTimelineItem = WebWorkTimelineItem;

export type WorkDetail = WebWorkDetailResponse;

/* ── Mesh Ops (`GET /api/mesh-ops`) ── */

export type MeshOpsAttention = "interrupt" | "badge" | "silent";

export type MeshOpsResponse = {
  generatedAt: string;
  items: WebMeshOpsItem[];
  hosts: WebMeshOpsHost[];
};

export type DispatchFilter = "all" | "delivered" | "failed";

/** Dispatch time window, relative to now. `all` means every loaded row. */
export type DispatchWindow = "1h" | "today" | "24h" | "7d" | "all";
export type MessagesSort = "recent" | "name" | "unread";
export type SearchMode = "knowledge" | "indexer";
export type ProjectSet = "live" | "ephemeral" | "archived";
/** Unscoped: "agents" (default) is the activity feed; "projects" is the project list. */
export type ProjectsIndexView = "agents" | "sessions" | "projects";
export type ProjectStateFilter = "needs" | "live" | "idle";
export type MachineScopedRoute = {
  machineId?: string;
};

export type Route =
  | { view: "requests" }
  | ({ view: "inbox" } & MachineScopedRoute)
  | ({
      view: "conversation";
      conversationId: string;
      composeDraft?: string;
    } & MachineScopedRoute)
  | { view: "agent-info"; conversationId: string }
  | ({
      view: "agents-v2";
      /** Path engagement — opens the full profile in the center pane. */
      agentId?: string;
      /** Index selection — inspector peek on the right without leaving the registry. */
      selectedAgentId?: string;
      sessionId?: string;
      conversationId?: string;
      tab?: AgentTab;
      projectSlug?: string;
      harness?: string;
      node?: string;
      set?: ProjectSet;
      indexView?: ProjectsIndexView;
      stateFilter?: ProjectStateFilter;
      showEphemeral?: boolean;
    } & MachineScopedRoute)
  | ({
      view: "messages";
      conversationId?: string;
      /** Agent master view — the agent's DM with its sessions as threads. */
      agentId?: string;
      /** Session conversation raised in the master view's thread side panel. */
      threadId?: string;
    } & MachineScopedRoute)
  | ({
      view: "sessions";
      sessionId?: string;
      agentId?: string;
      flightId?: string;
      compareSessionId?: string;
    } & MachineScopedRoute)
  // `root` pre-selects a project by absolute root — used when drilling in from
  // a project surface ("Worktrees" facet) so the repos view keeps the caller's
  // scope. Deep-linkable as /repos?root=<abs>.
  | ({ view: "repos"; root?: string } & MachineScopedRoute)
  | ({ view: "harnesses" } & MachineScopedRoute)
  // A diff path is absolute + machine-local, so this is intentionally not
  // machine-scoped. Reached by drilling in / "open as page" from the Repos
  // diff panel; deep-linkable as /repo-diff?path=<abs>&layer=…
  | {
      view: "repo-diff";
      path: string;
      layers?: ("unstaged" | "staged" | "branch")[];
      files?: string[];
      sessionId?: string;
      agentId?: string;
      include?: "changed" | "all";
    }
  | { view: "search"; mode?: SearchMode; hitId?: string; filters?: SearchFilters }
  | ({ view: "mesh" } & MachineScopedRoute)
  // Mesh Ops — flagged work-item triage over the mesh; itemId deep-links a row.
  | ({ view: "mesh-ops"; itemId?: string } & MachineScopedRoute)
  | {
      view: "broker";
      attemptId?: string;
      filter?: DispatchFilter;
      /** Focused dispatch parties (node keys). View-only: never a connection change. */
      focus?: string[];
      /** Only dispatches between focused parties. */
      between?: boolean;
      window?: DispatchWindow;
    }
  | {
      view: "code";
      root?: string;
      file?: string;
      project?: string;
      path?: string;
      wt?: string;
      line?: number;
      endLine?: number;
      /** Conversation that handed this file into Code, for an exact return path. */
      returnConversationId?: string;
    }
  | { view: "briefings"; briefingId?: string }
  | ({ view: "activity" } & MachineScopedRoute)
  | { view: "voice" }
  | ({ view: "work"; workId: string } & MachineScopedRoute)
  | {
      view: "settings";
      section?: SettingsSection;
      agentId?: string;
    }
  | {
      view: "ops";
      mode?: OpsMode;
      tailQuery?: string;
      planDocumentId?: string;
      flightId?: string;
      invocationId?: string;
      conversationId?: string;
      workId?: string;
      sessionId?: string;
      targetAgentId?: string;
      /** /ops/week only: "team" swaps in the seeded team mock. */
      dataset?: "team";
      /** /ops/week only: follow the machines live, or only what OTLP exporters send (absent = the snapshot week). */
      source?: "live" | "otlp";
    }
  | ({
      view: "follow";
      preferredView?: FollowPreferredView;
      flightId?: string;
      invocationId?: string;
      conversationId?: string;
      workId?: string;
      sessionId?: string;
      targetAgentId?: string;
    } & MachineScopedRoute)
	  | {
	      view: "terminal";
	      agentId?: string;
	      mode?: "observe" | "takeover";
	      terminalSessionId?: string;
	      terminalSurfaceKey?: string;
	      terminalBackend?: "pty" | "tmux" | "zellij" | "herdr";
	      terminalAgent?: "shell" | "claude" | "codex" | "pi";
	      terminalSessionName?: string;
	      terminalTabId?: string;
	      zellijSocketDir?: string;
	    };

export type AgentTab = "profile" | "config" | "observe" | "message";
export type OpsMode = "advisor" | "mission" | "issues" | "agents" | "tail" | "atop" | "lanes" | "world" | "week";
export type FollowPreferredView = "tail" | "session" | "chat" | "work";
/** URL-addressable settings surface sections (SCO-082 Phase B). */
export type SettingsSection =
  | "assistants"
  | "pairing"
  | "agents"
  | "appearance"
  | "operator"
  | "comms"
  | "credentials"
  | "voice"
  | "terminal"
  | "devices"
  | "mesh"
  | "pro"
  | "system"
  | "about";

export type FollowTarget = WebFollowTarget;

/* ── Tail (Ops > Tail) types ── */

/**
 * Launch attribution for a tailed transcript. The runtime/harness name shown
 * in the UI is `source` ("claude", "codex", "quad", ...).
 */
export type TailAttribution = "scout-managed" | "hudson-managed" | "unattributed";

/** @deprecated Use TailAttribution for the `harness` field. */
export type TailHarness = TailAttribution;
export type TailEventKind =
  | "user"
  | "assistant"
  | "tool"
  | "tool-result"
  | "system"
  | "other";

export type TailEvent = {
  id: string;
  ts: number;
  /** Runtime harness/source name, e.g. "claude", "codex", "quad". */
  source: string;
  sessionId: string;
  pid: number;
  parentPid: number | null;
  project: string;
  cwd: string;
  /** Launch attribution; retained as `harness` for wire compatibility. */
  harness: TailHarness;
  kind: TailEventKind;
  summary: string;
  raw?: unknown;
};

export type TailDiscoveredProcess = {
  pid: number;
  ppid: number;
  command: string;
  etime: string;
  cwd: string | null;
  /** Launch attribution; retained as `harness` for wire compatibility. */
  harness: TailHarness;
  parentChain: { pid: number; command: string }[];
  /** Runtime harness/source name, e.g. "claude", "codex", "quad". */
  source: string;
};

export type TailDiscoveredTranscript = {
  source: string;
  transcriptPath: string;
  sessionId: string | null;
  /** The harness session which spawned this transcript, when it is a child worker. */
  parentSessionId?: string | null;
  /** Harness-owned child worker id (for example Claude's `agent-*.jsonl` id). */
  subagentId?: string | null;
  /** Observed harness-assigned child nickname, when available. */
  agentNickname?: string | null;
  cwd: string | null;
  project: string;
  /** Launch attribution; retained as `harness` for wire compatibility. */
  harness: TailHarness;
  /** Timestamp of the latest parseable transcript event, when available. */
  lastEventAt?: number | null;
  mtimeMs: number;
  size: number;
};

export type TailDiscoveryIssueKind = "transcript_path_collision";

export type TailDiscoveryIssue = {
  kind: TailDiscoveryIssueKind;
  sessionKey: string;
  message: string;
  transcriptPaths: string[];
};

export type TailDiscoverySnapshot = {
  generatedAt: number;
  processes: TailDiscoveredProcess[];
  transcripts?: TailDiscoveredTranscript[];
  issues?: TailDiscoveryIssue[];
  totals: {
    total: number;
    scoutManaged: number;
    hudsonManaged: number;
    unattributed: number;
    transcripts?: number;
  };
};

/* ── Ops types (Plan view) ── */

export type MissionBrief = {
  title: string;
  goal: string;
  rationale: string;
  deadline: string;
  confidence: number;
  lastReproposedMinsAgo: number;
};

export type MissionNodeKind = "mission" | "phase" | "task";
export type MissionNodeState =
  | "proposed"
  | "committed"
  | "inflight"
  | "done"
  | "stuck";

export type MissionTreeNode = {
  id: string;
  kind: MissionNodeKind;
  title: string;
  why?: string;
  state: MissionNodeState;
  assignee?: string;
  confidence?: number;
  progress?: number;
  detail?: string;
  stuckMins?: number;
  children?: MissionTreeNode[];
};

export type PlanChange = {
  id: string;
  kind: "split" | "demote" | "promote" | "unassign" | "add";
  summary: string;
  why: string;
  status: "pending" | "accepted";
  minsAgo: number;
};

export type PlanRisk = {
  id: string;
  title: string;
  detail: string;
  severity: "high" | "med" | "low";
};

export type ToolTickerItem = {
  agent: string;
  tool: string;
  result: string;
};
