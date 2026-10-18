import { registerIntegrationTools } from "./integrations.ts";
import { loadScoutMeshOverview, renderScoutMeshOverviewLines, type ScoutMeshMachine, type ScoutMeshOverview } from "../mesh/overview.ts";
import {
  detectCurrentLiveTerminalSession,
  type LiveTerminalDetection,
  type LiveTerminalSession,
} from "@openscout/runtime/live-terminal-session";
import { registerChatListeningTools } from "./chat-listening-tools.ts";
import { chatListeningRequest } from "../../cli/commands/chat-listening.ts";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BUILT_IN_AGENT_DEFINITION_IDS,
  diagnoseAgentIdentity,
  flightCompletion,
  type ScoutCompletionReply,
  formatMinimalAgentIdentity,
  parseScoutRuntimeSpec,
  parseAgentIdentity,
  parseScoutComposerRouteTarget,
  SCOUT_LAUNCHABLE_HARNESSES,
  SCOUT_REASONING_EFFORTS,
  SCOUT_RESERVED_RUNTIME_PROFILE_IDS,
  validateScoutAgentNameForWrite,
  type AgentIdentityCandidate,
  type AgentState,
  type ScoutAgentCard,
  type ScoutDeliverRequest,
  type ScoutReplyContext,
  type RouteAliasBinding,
  type RouteAliasResolveResult,
} from "@openscout/protocol";
import {
  findNearestProjectRoot,
  loadResolvedRelayAgents,
  type ResolvedRelayAgentConfig,
} from "@openscout/runtime/setup";
import { resolveHost, resolveWebPort } from "@openscout/runtime/local-config";
import {
  reporterHarness,
  submitDiagnosticReport,
  type DiagnosticOptions,
  type DiagnosticReceipt,
} from "@openscout/runtime/diagnostic-report";
import { hostname } from "node:os";
import * as z from "zod/v4";

import {
  createScoutAgentCard,
  upScoutAgent,
  type ScoutAgentStatus,
} from "../agents/service.ts";
import {
  askScoutAgentById,
  askScoutQuestion,
  askScoutSessionById,
  attachScoutManagedLocalSession,
  listScoutAgents,
  loadScoutFlight,
  loadScoutInvocationLifecycle,
  loadScoutBrokerContext,
  loadScoutMessages,
  readScoutBrokerFeed,
  readScoutLabelFeed,
  readScoutLabelBrief,
  resolveScoutBrokerUrl,
  resolveScoutSenderId,
  sendScoutMessage,
  sendScoutMessageToAgentIds,
  replyToScoutMessage,
  type OutgoingAttachmentInput,
  type ScoutManagedLocalSessionAttachment,
  updateScoutWorkItem,
  waitForScoutFlight,
  type ScoutAskByIdResult,
  type ScoutAskResult,
  type ScoutAgentBrokerFeed,
  type ScoutFlightRecord,
  type ScoutInvocationLifecycleRecord,
  type ScoutLabelBrief,
  type ScoutLabelFeed,
  type ScoutBrokerMessageRecord,
  type ScoutMessagePostResult,
  type ScoutReplyPostResult,
  type ScoutTrackedWorkItem,
  type ScoutWorkItemUpdate,
  type ScoutWorkItemInput,
  type ScoutStructuredMessagePostResult,
  type ScoutWhoEntry,
} from "../broker/service.ts";
import {
  readScoutTailEvents,
  type ScoutTailRecentResult,
  type TailEvent,
  type TailEventKind,
} from "../tail/service.ts";
import {
  scoutAskHandler as defaultScoutAskHandler,
  type ScoutAskHandler,
} from "../broker/ask.ts";
import type {
  ScoutAskReplyMode,
  ScoutAskReceipt,
} from "../broker/ask-types.ts";
import { classifySendInteraction } from "../broker/send-interaction.ts";
import { SCOUT_APP_VERSION } from "../../shared/product.ts";
import { registerAttachmentReaderTool } from "./attachment-reader.ts";
import { herdrWorkspacesDependencies, registerHerdrWorkspaceTools } from "./herdr-workspaces.ts";
import { registerRoutingTools, routingToolDependencies } from "./routing-tools.ts";
import { registerRouteContext } from "./route-context.ts";
import { routeContextDependencies } from "../mesh/route-context.ts";
import { registerSessionSendTool, sessionSendDependencies } from "./session-send.ts";
import { registerSessionDiscoveryTools, sessionDiscoveryDependencies } from "./session-discovery.ts";
import { waitForStdioServerClosure } from "./stdio-server-lifecycle.ts";

const AGENT_STATE_VALUES = [
  "offline",
  "idle",
  "active",
  "waiting",
  "discovered",
] as const;
const REGISTRATION_KIND_VALUES = [
  "broker",
  "configured",
  "discovered",
] as const;
const RESOLVE_KIND_VALUES = ["resolved", "ambiguous", "unresolved"] as const;
const MESSAGE_ROUTE_KIND_VALUES = ["dm", "channel", "broadcast"] as const;
const MESSAGE_ROUTING_ERROR_VALUES = [
  "missing_destination",
  "multi_target_requires_explicit_channel",
] as const;
const REPLY_MODE_VALUES = ["none", "inline", "notify"] as const;
const REPLY_DELIVERY_VALUES = ["none", "inline", "mcp_notification"] as const;
const LOCAL_AGENT_HARNESS_VALUES = SCOUT_LAUNCHABLE_HARNESSES;
const TAIL_EVENT_KIND_VALUES = [
  "user",
  "assistant",
  "tool",
  "tool-result",
  "system",
  "other",
] as const;
const DEFAULT_ASK_ACK_TIMEOUT_SECONDS = 30;
export const SCOUT_MCP_UI_META_KEY = "openscout/ui";

const scoutAgentNameInputSchema = z.string().min(1).superRefine((value, context) => {
  const result = validateScoutAgentNameForWrite(value);
  if (!result.ok) {
    context.addIssue({ code: "custom", message: result.message });
  }
});

type SearchableAgentState = (typeof AGENT_STATE_VALUES)[number];
type SearchRegistrationKind = (typeof REGISTRATION_KIND_VALUES)[number];

function normalizeSearchableAgentState(
  state: AgentState | SearchableAgentState | null | undefined,
  fallback: SearchableAgentState,
): SearchableAgentState {
  if (!state || state === "registered") {
    return fallback;
  }
  return AGENT_STATE_VALUES.includes(state as SearchableAgentState)
    ? state as SearchableAgentState
    : fallback;
}

type ScoutMcpToolIconMeta = {
  kind: "semantic";
  name: "agent";
  fallbackGlyph: "@";
};

type ScoutMcpAgentAvatarMeta = {
  kind: "agent-avatar";
  monogramField: "displayName";
  fallbackField: "handle";
  colorSeedField: "agentId";
  fallbackGlyph: "@";
};

export type ScoutMcpAgentPickerFieldMeta = {
  kind: "agent-picker";
  selection: "single" | "multiple";
  sourceTool: "agents_search";
  resolveTool?: "agents_resolve";
  sourceArguments: {
    query: { from: "value" };
    currentDirectory: { fromToolArgument: "currentDirectory" };
  };
  resultPath: ["structuredContent", "candidates"];
  valueField: "label" | "agentId" | "sessionId";
  labelField: "label";
  descriptionField: "displayName";
  badgeFields: ["harness", "model", "workspace", "node"];
  icon: ScoutMcpAgentAvatarMeta;
  search: {
    minQueryLength: 0;
    debounceMs: 100;
    cacheBy: ["currentDirectory"];
  };
};

export type ScoutMcpToolUiMeta = {
  icon: ScoutMcpToolIconMeta;
  fields?: Record<string, ScoutMcpAgentPickerFieldMeta>;
};

type ScoutMcpReplyMode = (typeof REPLY_MODE_VALUES)[number];

type ScoutFollowPreferredView = "tail" | "session" | "chat" | "work";

type ScoutFollowIds = {
  flightId: string | null;
  invocationId: string | null;
  conversationId: string | null;
  workId: string | null;
  sessionId?: string | null;
  targetAgentId: string | null;
};

type ScoutFollowLinks = {
  follow: string | null;
  tail: string | null;
  session: string | null;
  chat: string | null;
  work: string | null;
  agent: string | null;
  observe: string | null;
};

type ScoutReplyNotificationParams = {
  status: "completed" | "failed";
  currentDirectory: string;
  senderId: string;
  targetAgentId: string | null;
  targetLabel: string | null;
  conversationId: string | null;
  messageId: string | null;
  bindingRef?: string | null;
  flightId: string;
  flight: ScoutFlightRecord | null;
  output: string | null;
  error: string | null;
  workItem: ScoutTrackedWorkItem | null;
  workId: string | null;
  workUrl: string | null;
  ids?: ScoutFollowIds;
  links?: ScoutFollowLinks;
  followUrl?: string | null;
};

const scoutAgentToolIconMeta: ScoutMcpToolIconMeta = {
  kind: "semantic",
  name: "agent",
  fallbackGlyph: "@",
};

const scoutAgentAvatarMeta: ScoutMcpAgentAvatarMeta = {
  kind: "agent-avatar",
  monogramField: "displayName",
  fallbackField: "handle",
  colorSeedField: "agentId",
  fallbackGlyph: "@",
};

// Host UIs can use this private extension to power live agent pickers until
// MCP standardizes dynamic completion directly on tool arguments.
function createAgentPickerFieldMeta(input: {
  selection: "single" | "multiple";
  valueField: "label" | "agentId" | "sessionId";
  resolveTool?: "agents_resolve";
}): ScoutMcpAgentPickerFieldMeta {
  return {
    kind: "agent-picker",
    selection: input.selection,
    sourceTool: "agents_search",
    resolveTool: input.resolveTool,
    sourceArguments: {
      query: { from: "value" },
      currentDirectory: { fromToolArgument: "currentDirectory" },
    },
    resultPath: ["structuredContent", "candidates"],
    valueField: input.valueField,
    labelField: "label",
    descriptionField: "displayName",
    badgeFields: ["harness", "model", "workspace", "node"],
    icon: scoutAgentAvatarMeta,
    search: {
      minQueryLength: 0,
      debounceMs: 100,
      cacheBy: ["currentDirectory"],
    },
  };
}

function createToolUiMeta(fields?: Record<string, ScoutMcpAgentPickerFieldMeta>) {
  const value: ScoutMcpToolUiMeta = {
    icon: scoutAgentToolIconMeta,
  };
  if (fields && Object.keys(fields).length > 0) {
    value.fields = fields;
  }
  return {
    [SCOUT_MCP_UI_META_KEY]: value,
  } satisfies Record<string, unknown>;
}

function hasExplicitAgentSender(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENSCOUT_AGENT?.trim());
}

function defaultMcpSenderId(env: NodeJS.ProcessEnv): string | undefined {
  const replyContext = parseScoutReplyContextFromEnv(env);
  const activeAgentId = replyContext?.toAgentId?.trim();
  if (activeAgentId) {
    return activeAgentId;
  }

  // Let the shared sender resolver preserve OPENSCOUT_AGENT exactly when this
  // MCP server is running inside a managed agent session. Human-started MCP
  // clients keep the canonical operator actor id.
  return hasExplicitAgentSender(env) ? undefined : "operator";
}

async function resolveMcpSenderId(
  deps: Pick<ScoutMcpDependencies, "resolveSenderId">,
  senderId: string | null | undefined,
  currentDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return deps.resolveSenderId(
    senderId ?? defaultMcpSenderId(env),
    currentDirectory,
    env,
  );
}

const targetLabelInputSchema = z
  .string()
  .describe("Scout agent handle to contact when a specific target is known, such as @talkie, or a saved situated target such as target:talkie or ⌖talkie. For fresh capability work prefer projectPath plus optional harness; do not guess generic handles like claude.main. Treat harness/model/profile as instance constraints, not the base agent identity.")
  .optional();

const targetAgentIdInputSchema = z
  .string()
  .describe("Exact Scout agent/card id when already known, such as talkie.master.mini. This is not a session target; use targetSessionId for exact prior context.")
  .optional();

const targetSessionIdInputSchema = z
  .string()
  .describe("Exact Scout session to continue: a copyable session address (sess.<token>@<host>, from `scout session address` or a receipt's targetSessionAddress / returnAddress.sessionAddress) or a session id. Agent-card targets create fresh sessions; pass targetSessionId only when you intentionally want prior context from a specific CODEX_THREAD_ID or attached runtime session. An address never falls back to a fresh session.")
  .optional();

const projectPathInputSchema = z
  .string()
  .min(1)
  .describe("Project root to ask when you do not have a specific agent in mind; pair with harness when the capability matters. Scout resolves or creates the concrete worker and returns durable follow-up handles.")
  .optional();

const mentionAgentIdsInputSchema = z
  .array(z.string())
  .describe("Exact Scout agent ids to target directly when you already know them")
  .optional();

const attachmentsInputSchema = z
  .array(
    z.object({
      mediaType: z
        .string()
        .describe("MIME type, e.g. image/png or image/jpeg"),
      url: z
        .string()
        .describe("HTTP(S) URL where the attachment can be fetched"),
      fileName: z.string().optional(),
    }),
  )
  .describe(
    "Link-backed attachments (e.g. images). Each needs a mediaType and a fetchable url; agents should pass URLs they already have rather than uploading bytes.",
  )
  .optional();

export type ScoutMcpAgentCandidate = {
  agentId: string;
  label: string;
  defaultLabel: string | null;
  displayName: string;
  handle: string | null;
  selector: string | null;
  defaultSelector: string | null;
  state: SearchableAgentState;
  registrationKind: SearchRegistrationKind;
  routable: boolean;
  harness: string | null;
  model: string | null;
  workspace: string | null;
  node: string | null;
  projectRoot: string | null;
  transport: string | null;
  sessionId?: string | null;
};

export type ScoutMcpResolveResult = {
  kind: (typeof RESOLVE_KIND_VALUES)[number];
  candidate: ScoutMcpAgentCandidate | null;
  candidates: ScoutMcpAgentCandidate[];
};

type InternalAgentDirectoryEntry = {
  agentId: string;
  definitionId: string;
  displayName: string;
  handle: string | null;
  selector: string | null;
  defaultSelector: string | null;
  state: SearchableAgentState;
  registrationKind: SearchRegistrationKind;
  routable: boolean;
  harness: string | null;
  model: string | null;
  workspace: string | null;
  node: string | null;
  projectRoot: string | null;
  transport: string | null;
  sessionId: string | null;
};

type ScoutMcpDependencies = {
  /** Files a note with the OpenScout team (local copy first, then upload). */
  submitFeedback: (options: DiagnosticOptions) => Promise<DiagnosticReceipt>;
  resolveSenderId: (
    senderId: string | null | undefined,
    currentDirectory: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<string>;
  resolveBrokerUrl: () => string;
  loadMessages: (input: {
    channel?: string;
    conversationId?: string;
    participantId?: string;
    inboxOnly?: boolean;
    since?: number;
    limit?: number;
    baseUrl?: string;
  }) => Promise<ScoutBrokerMessageRecord[]>;
  readBrokerFeed: (input: {
    agentId: string;
    since?: number | null;
    limit?: number;
    includeAcknowledged?: boolean;
    baseUrl?: string;
  }) => Promise<ScoutAgentBrokerFeed | null>;
  readTailEvents: (input: {
    limit?: number;
    sources?: string[];
    kinds?: TailEventKind[];
    sessionId?: string;
    project?: string;
    cwd?: string;
    query?: string;
    transcripts?: boolean;
    baseUrl?: string;
  }) => Promise<ScoutTailRecentResult>;
  searchAgents: (input: {
    query?: string;
    currentDirectory: string;
    limit?: number;
  }) => Promise<ScoutMcpAgentCandidate[]>;
  resolveAgent: (input: {
    label: string;
    currentDirectory: string;
  }) => Promise<ScoutMcpResolveResult>;
  createAgentCard: (input: {
    projectPath: string;
    agentName?: string;
    displayName?: string;
    harness?: (typeof LOCAL_AGENT_HARNESS_VALUES)[number];
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    permissionProfile?: string;
    currentDirectory: string;
    createdById?: string;
    oneTimeUse?: boolean;
    ttlMs?: number;
  }) => Promise<ScoutAgentCard>;
  startAgent: (input: {
    projectPath: string;
    agentName?: string;
    harness?: (typeof LOCAL_AGENT_HARNESS_VALUES)[number];
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    permissionProfile?: string;
    currentDirectory: string;
  }) => Promise<ScoutAgentStatus>;
  attachCurrentLocalSession: (input: {
    externalSessionId: string;
    transport: "codex_app_server" | "tmux" | "ghostty";
    currentDirectory: string;
    projectRoot?: string;
    agentId?: string;
    alias?: string;
    displayName?: string;
    liveTerminal?: LiveTerminalSession;
  }) => Promise<ScoutManagedLocalSessionAttachment>;
  detectCurrentLiveTerminalSession: () => Promise<LiveTerminalDetection>;
  sendMessage: (input: {
    requestId?: string;
    senderId: string;
    body: string;
    targetLabel?: string;
    channel?: string;
    shouldSpeak?: boolean;
    currentDirectory: string;
    source?: string;
    wake?: boolean;
    operatorSignal?: ScoutDeliverRequest["operatorSignal"];
    aliasScope?: import("@openscout/protocol").RouteAliasScope;
  }) => Promise<ScoutMessagePostResult>;
  sendMessageToAgentIds: (input: {
    senderId: string;
    body: string;
    targetAgentIds: string[];
    channel?: string;
    shouldSpeak?: boolean;
    currentDirectory: string;
    source?: string;
  }) => Promise<ScoutStructuredMessagePostResult>;
  replyMessage: (input: {
    requestId?: string;
    completion?: ScoutCompletionReply;
    senderId: string;
    body: string;
    conversationId: string;
    replyToMessageId: string;
    shouldSpeak?: boolean;
    attachments?: OutgoingAttachmentInput[];
    currentDirectory: string;
    source?: string;
  }) => Promise<ScoutReplyPostResult>;
  scoutAskHandler: ScoutAskHandler;
  askQuestion: (input: {
    senderId: string;
    targetLabel: string;
    body: string;
    workItem?: ScoutWorkItemInput;
    channel?: string;
    shouldSpeak?: boolean;
    labels?: string[];
    replyToSessionId?: string;
    replyMode?: ScoutAskReplyMode;
    currentDirectory: string;
    source?: string;
    aliasScope?: import("@openscout/protocol").RouteAliasScope;
  }) => Promise<ScoutAskResult>;
  askAgentById: (input: {
    senderId: string;
    targetAgentId: string;
    body: string;
    workItem?: ScoutWorkItemInput;
    channel?: string;
    shouldSpeak?: boolean;
    labels?: string[];
    replyToSessionId?: string;
    replyMode?: ScoutAskReplyMode;
    currentDirectory: string;
    source?: string;
  }) => Promise<ScoutAskByIdResult>;
  askSessionById: (input: {
    senderId: string;
    targetSessionId: string;
    body: string;
    workItem?: ScoutWorkItemInput;
    channel?: string;
    shouldSpeak?: boolean;
    labels?: string[];
    replyToSessionId?: string;
    replyMode?: ScoutAskReplyMode;
    currentDirectory: string;
    source?: string;
  }) => Promise<ScoutAskByIdResult>;
  updateWorkItem: (
    input: ScoutWorkItemUpdate,
  ) => Promise<ScoutTrackedWorkItem | null>;
  waitForFlight: (
    baseUrl: string,
    flightId: string,
    options?: {
      timeoutSeconds?: number;
      signal?: AbortSignal;
      invocationId?: string;
      onUpdate?: (flight: ScoutFlightRecord, detail: string) => void;
    },
  ) => Promise<ScoutFlightRecord>;
  getFlight: (
    baseUrl: string,
    flightId: string,
  ) => Promise<ScoutFlightRecord | null>;
  getInvocationLifecycle?: (
    baseUrl: string,
    invocationId: string,
  ) => Promise<ScoutInvocationLifecycleRecord | null>;
  readLabelBrief: (
    label: string,
    baseUrl: string,
  ) => Promise<ScoutLabelBrief | null>;
  readLabelFeed: (
    label: string,
    baseUrl: string,
    options?: { since?: number | null; limit?: number | null },
  ) => Promise<ScoutLabelFeed | null>;
  loadMeshOverview?: (machine?: string) => Promise<ScoutMeshOverview>;
};

const flightSchema = z.object({
  id: z.string(),
  invocationId: z.string(),
  requesterId: z.string(),
  targetAgentId: z.string(),
  state: z.string(),
  summary: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const invocationLifecycleSchema = z.object({
  invocationId: z.string(),
  flightId: z.string().optional(),
  state: z.string(),
  targetAgentId: z.string().optional(),
  targetEndpointId: z.string().optional(),
  peerNodeId: z.string().optional(),
  peerFlightId: z.string().optional(),
  workId: z.string().optional(),
  actionId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  acknowledgedAt: z.number().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  expiresAt: z.number().optional(),
  lastProgressAt: z.number().optional(),
  terminal: z.object({}).catchall(z.unknown()).optional(),
  deliveries: z.array(z.object({}).catchall(z.unknown())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).catchall(z.unknown());

const labelBriefFlightSchema = z.object({
  id: z.string(),
  invocationId: z.string(),
  state: z.string(),
  requesterId: z.string(),
  targetAgentId: z.string(),
  summary: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  labels: z.array(z.string()),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  workId: z.string().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  lastActivityAt: z.number().nullable(),
});

const labelBriefWorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  ownerId: z.string().nullable(),
  nextMoveOwnerId: z.string().nullable(),
  summary: z.string().nullable(),
  labels: z.array(z.string()),
  updatedAt: z.number(),
});

const labelBriefSchema = z.object({
  label: z.string(),
  generatedAt: z.number(),
  lastActivityAt: z.number().nullable(),
  participants: z.array(z.string()),
  counts: z.object({
    flights: z.number(),
    activeFlights: z.number(),
    workItems: z.number(),
  }),
  flightsByState: z.record(z.string(), z.number()),
  activeFlights: z.array(labelBriefFlightSchema),
  recentFlights: z.array(labelBriefFlightSchema),
  workItems: z.array(labelBriefWorkItemSchema),
});

const labelFeedEventSchema = z.object({
  id: z.string(),
  label: z.string(),
  at: z.number(),
  kind: z.enum([
    "message",
    "invocation_created",
    "flight_started",
    "flight_state",
    "flight_completed",
    "flight_failed",
    "flight_cancelled",
    "work_event",
    "work_snapshot",
  ]),
  category: z.enum(["message", "invocation", "flight", "work"]),
  actorId: z.string().nullable(),
  targetAgentId: z.string().nullable(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  invocationId: z.string().nullable(),
  flightId: z.string().nullable(),
  workId: z.string().nullable(),
  state: z.string().nullable(),
  eventKind: z.string().nullable(),
  summary: z.string(),
  labels: z.array(z.string()),
});

const labelFeedSchema = z.object({
  label: z.string(),
  generatedAt: z.number(),
  cursor: z.string().nullable(),
  since: z.number().nullable(),
  counts: z.object({
    events: z.number(),
    messages: z.number(),
    invocations: z.number(),
    flights: z.number(),
    workEvents: z.number(),
  }),
  events: z.array(labelFeedEventSchema),
});

const trackedWorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  state: z.enum(["open", "working", "waiting", "review", "done", "cancelled"]),
  acceptanceState: z.enum(["none", "pending", "accepted", "reopened"]),
  ownerId: z.string().nullable(),
  nextMoveOwnerId: z.string().nullable(),
  conversationId: z.string().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]).nullable(),
});

const workItemInputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  labels: z.array(z.string()).optional(),
  parentId: z.string().optional(),
  acceptanceState: z
    .enum(["none", "pending", "accepted", "reopened"])
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const waitingOnSchema = z.object({
  kind: z.enum([
    "actor",
    "work_item",
    "approval",
    "artifact",
    "condition",
  ]),
  label: z.string().min(1),
  targetId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const progressSchema = z.object({
  completedSteps: z.number().optional(),
  totalSteps: z.number().optional(),
  checkpoint: z.string().optional(),
  summary: z.string().optional(),
  percent: z.number().optional(),
});

const workItemUpdateSchema = z.object({
  workId: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().nullable().optional(),
  state: z
    .enum(["open", "working", "waiting", "review", "done", "cancelled"])
    .optional(),
  acceptanceState: z
    .enum(["none", "pending", "accepted", "reopened"])
    .optional(),
  ownerId: z.string().nullable().optional(),
  nextMoveOwnerId: z.string().nullable().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).nullable().optional(),
  labels: z.array(z.string()).optional(),
  waitingOn: waitingOnSchema.nullable().optional(),
  progress: progressSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  eventSummary: z.string().optional(),
});

const agentCandidateSchema = z.object({
  agentId: z.string(),
  label: z.string(),
  defaultLabel: z.string().nullable(),
  displayName: z.string(),
  handle: z.string().nullable(),
  selector: z.string().nullable(),
  defaultSelector: z.string().nullable(),
  state: z.enum(AGENT_STATE_VALUES),
  registrationKind: z.enum(REGISTRATION_KIND_VALUES),
  routable: z.boolean(),
  harness: z.string().nullable(),
  model: z.string().nullable(),
  workspace: z.string().nullable(),
  node: z.string().nullable(),
  projectRoot: z.string().nullable(),
  transport: z.string().nullable(),
  sessionId: z.string().nullable().optional(),
});

const scoutReturnAddressSchema = z.object({
  actorId: z.string(),
  handle: z.string(),
  displayName: z.string().optional(),
  selector: z.string().optional(),
  defaultSelector: z.string().optional(),
  conversationId: z.string().optional(),
  replyToMessageId: z.string().optional(),
  nodeId: z.string().optional(),
  projectRoot: z.string().optional(),
  sessionId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const scoutAgentCardLifecycleSchema = z.object({
  kind: z.enum(["persistent", "one_time"]),
  createdAt: z.number().optional(),
  createdById: z.string().optional(),
  expiresAt: z.number().optional(),
  maxUses: z.number().optional(),
  inboxConversationId: z.string().optional(),
});

const scoutAgentCardSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  definitionId: z.string(),
  displayName: z.string(),
  handle: z.string(),
  selector: z.string().optional(),
  defaultSelector: z.string().optional(),
  projectName: z.string().optional(),
  projectRoot: z.string(),
  currentDirectory: z.string(),
  harness: z.enum(LOCAL_AGENT_HARNESS_VALUES),
  transport: z.string(),
  sessionId: z.string().optional(),
  branch: z.string().optional(),
  createdAt: z.number(),
  createdById: z.string().optional(),
  brokerRegistered: z.boolean(),
  inboxConversationId: z.string().optional(),
  lifecycle: scoutAgentCardLifecycleSchema.optional(),
  returnAddress: scoutReturnAddressSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const localAgentStatusSchema = z.object({
  agentId: z.string(),
  definitionId: z.string(),
  projectName: z.string(),
  projectRoot: z.string(),
  sessionId: z.string(),
  startedAt: z.number(),
  harness: z.enum(LOCAL_AGENT_HARNESS_VALUES),
  transport: z.string(),
  isOnline: z.boolean(),
  source: z.string(),
});

const whoAmISchema = z.object({
  currentDirectory: z.string(),
  brokerUrl: z.string(),
  defaultSenderId: z.string(),
});

const brokerMessageSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    actorId: z.string(),
    originNodeId: z.string(),
    class: z.enum(["agent", "log", "system", "status", "artifact"]),
    body: z.string(),
    replyToMessageId: z.string().optional(),
    threadConversationId: z.string().optional(),
    mentions: z
      .array(
        z.object({
          actorId: z.string(),
          label: z.string().optional(),
        }),
      )
      .optional(),
    attachments: z
      .array(
        z
          .object({
            id: z.string(),
            mediaType: z.string(),
            fileName: z.string().optional(),
            blobKey: z.string().optional(),
            url: z.string().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
    speech: z
      .object({
        text: z.string(),
        voice: z.string().optional(),
        interruptible: z.boolean().optional(),
      })
      .optional(),
    audience: z
      .object({
        visibleTo: z.array(z.string()).optional(),
        notify: z.array(z.string()).optional(),
        invoke: z.array(z.string()).optional(),
        reason: z.string().optional(),
      })
      .optional(),
    visibility: z.string(),
    policy: z.string(),
    createdAt: z.number(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());

const messagesInboxResultSchema = z.object({
  currentDirectory: z.string(),
  brokerUrl: z.string(),
  senderId: z.string(),
  limit: z.number(),
  since: z.number().nullable(),
  messages: z.array(brokerMessageSchema),
});

const messagesChannelResultSchema = z.object({
  currentDirectory: z.string(),
  brokerUrl: z.string(),
  channel: z.string(),
  limit: z.number(),
  since: z.number().nullable(),
  messages: z.array(brokerMessageSchema),
});

const brokerFeedRecordSchema = z.record(z.string(), z.unknown());

const brokerFeedItemSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "message",
    "status",
    "invocation",
    "flight",
    "delivery",
    "delivery_attempt",
    "dispatch",
    "unblock_request",
  ]),
  severity: z.enum(["info", "status", "warning", "error"]),
  at: z.number(),
  title: z.string(),
  summary: z.string(),
  agentId: z.string().optional(),
  actorId: z.string().optional(),
  targetAgentId: z.string().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  invocationId: z.string().optional(),
  flightId: z.string().optional(),
  deliveryId: z.string().optional(),
  dispatchId: z.string().optional(),
  unblockRequestId: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  source: z.enum(["activity", "snapshot", "delivery", "dispatch", "unblock_request"]),
  message: brokerFeedRecordSchema.optional(),
  invocation: brokerFeedRecordSchema.optional(),
  flight: brokerFeedRecordSchema.optional(),
  delivery: brokerFeedRecordSchema.optional(),
  deliveryAttempt: brokerFeedRecordSchema.optional(),
  dispatch: brokerFeedRecordSchema.optional(),
  unblockRequest: brokerFeedRecordSchema.optional(),
  metadata: brokerFeedRecordSchema.optional(),
}).catchall(z.unknown());

const brokerFeedSchema = z.object({
  currentDirectory: z.string(),
  brokerUrl: z.string(),
  found: z.boolean(),
  agentId: z.string(),
  generatedAt: z.number(),
  since: z.number().nullable(),
  limit: z.number(),
  cursor: z.number().nullable(),
  status: z.object({
    agentId: z.string(),
    displayName: z.string().optional(),
    found: z.boolean(),
    agentState: z.string().optional(),
    endpoints: z.array(z.object({
      id: z.string(),
      nodeId: z.string(),
      harness: z.string(),
      transport: z.string(),
      state: z.string(),
      sessionId: z.string().optional(),
      projectRoot: z.string().optional(),
      cwd: z.string().optional(),
      lastError: z.string().optional(),
      lastFailureStage: z.string().optional(),
      updatedAt: z.number().optional(),
    }).catchall(z.unknown())),
    activeFlightIds: z.array(z.string()),
    pendingDeliveryIds: z.array(z.string()),
    errorCount: z.number(),
    warningCount: z.number(),
    lastError: z.string().optional(),
    lastActivityAt: z.number().optional(),
  }).catchall(z.unknown()),
  counts: z.object({
    items: z.number(),
    messages: z.number(),
    statuses: z.number(),
    invocations: z.number(),
    flights: z.number(),
    deliveries: z.number(),
    deliveryAttempts: z.number(),
    dispatches: z.number(),
    errors: z.number(),
    warnings: z.number(),
  }),
  items: z.array(brokerFeedItemSchema),
});

const tailEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  source: z.string(),
  sessionId: z.string(),
  pid: z.number(),
  parentPid: z.number().nullable(),
  project: z.string(),
  cwd: z.string(),
  harness: z.string(),
  kind: z.enum(TAIL_EVENT_KIND_VALUES),
  summary: z.string(),
  raw: z.unknown().optional(),
});

const tailEventsResultSchema = z.object({
  currentDirectory: z.string(),
  brokerUrl: z.string(),
  generatedAt: z.number(),
  limit: z.number(),
  cursor: z.string().nullable(),
  filters: z.object({
    sources: z.array(z.string()),
    kinds: z.array(z.enum(TAIL_EVENT_KIND_VALUES)),
    sessionId: z.string().nullable(),
    project: z.string().nullable(),
    cwd: z.string().nullable(),
    query: z.string().nullable(),
    transcripts: z.boolean(),
  }),
  counts: z.object({
    events: z.number(),
    sources: z.number(),
    sessions: z.number(),
  }),
  events: z.array(tailEventSchema),
});

const searchResultSchema = z.object({
  currentDirectory: z.string(),
  query: z.string(),
  candidates: z.array(agentCandidateSchema),
  /**
   * Set when the query names a mesh machine: whether it answers, what it
   * holds, and the ask that starts fresh work there. Agent cards on a machine
   * can all be offline while the machine itself is up.
   */
  machine: z.record(z.string(), z.unknown()).optional(),
});

const resolveResultSchema = z.object({
  currentDirectory: z.string(),
  label: z.string(),
  kind: z.enum(RESOLVE_KIND_VALUES),
  candidate: agentCandidateSchema.nullable(),
  candidates: z.array(agentCandidateSchema),
});

const startSuggestionSchema = z.object({
  tool: z.literal("agents_start"),
  targetLabel: z.string().nullable(),
  agentName: z.string().nullable(),
  harness: z.enum(LOCAL_AGENT_HARNESS_VALUES).nullable(),
  model: z.string().nullable(),
  projectPath: z.string(),
  currentDirectory: z.string(),
});

const followIdsSchema = z.object({
  flightId: z.string().nullable(),
  invocationId: z.string().nullable(),
  conversationId: z.string().nullable(),
  workId: z.string().nullable(),
  sessionId: z.string().nullable(),
  targetAgentId: z.string().nullable(),
});

const followLinksSchema = z.object({
  follow: z.string().nullable().describe("Share this URL with the user as 'Follow the task'. Opens the work ticket when available."),
  tail: z.string().nullable().describe("Secondary diagnostic view of session events; use the work ticket for task progress."),
  session: z.string().nullable(),
  chat: z.string().nullable(),
  work: z.string().nullable().describe("Durable work ticket: request, status, progress, and results. Preferred user-facing task link."),
  agent: z.string().nullable(),
  observe: z.string().nullable(),
});

const sendRoutingAdviceSchema = z.object({
  code: z.enum(MESSAGE_ROUTING_ERROR_VALUES),
  summary: z.string(),
  nextAction: z.string(),
});

const sendResultSchema = z.object({
  currentDirectory: z.string(),
  senderId: z.string(),
  mode: z.enum(["body_mentions", "explicit_targets", "target_label"]),
  interaction: z.enum(["work", "message"]).optional(),
  usedBroker: z.boolean(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  flightId: z.string().nullable().optional(),
  invocationId: z.string().nullable().optional(),
  workId: z.string().nullable().optional(),
  replyMode: z.enum(["notify", "none"]).nullable().optional(),
  notification: z.object({
    method: z.literal("notifications/scout/reply"),
    status: z.enum(["scheduled", "not_scheduled"]),
  }).nullable().optional(),
  wake: z.boolean().optional(),
  invokedTargetIds: z.array(z.string()),
  unresolvedTargetIds: z.array(z.string()),
  targetDiagnostic: z.object({}).catchall(z.unknown()).nullable(),
  startSuggestion: startSuggestionSchema.nullable().optional(),
  routingAdvice: sendRoutingAdviceSchema.nullable().optional(),
  routeKind: z.enum(MESSAGE_ROUTE_KIND_VALUES).nullable(),
  routingError: z.enum(MESSAGE_ROUTING_ERROR_VALUES).nullable(),
  ids: followIdsSchema.optional(),
  links: followLinksSchema.optional(),
  followUrl: z.string().nullable().optional(),
});

const operatorSignalResultSchema = z.object({
  currentDirectory: z.string(),
  senderId: z.string(),
  kind: z.enum(["notify", "consult"]),
  status: z.enum(["recorded", "not_recorded"]),
  blocking: z.literal(false),
  replyExpectation: z.enum(["none", "optional"]),
  notificationDelivery: z.enum(["unconfirmed", "not_attempted"]),
  defaultAction: z.string().nullable(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  signalId: z.string().nullable(),
  routingError: z.string().nullable(),
});

const nonBlankToolStringSchema = z.string().refine(
  (value) => value.trim().length > 0,
  { message: "Must contain non-whitespace text" },
).transform((value) => value.trim());

const completionIdentitySchema = z.object({
  invocationId: z.string().min(1).regex(/\S/),
  flightId: z.string().min(1).regex(/\S/),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const completionReplySchema = completionIdentitySchema.extend({ kind: z.enum(["progress", "final"]) });
const completionRequestSchema = z.object({ mode: z.literal("explicit") });
const completionRelationSchema = z.object({
  parentFlightId: nonBlankToolStringSchema,
  kind: z.enum(["joined", "continuation"]),
});
const completionStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0),
  obligations: z.array(z.object({
    invocationId: z.string(), flightId: z.string(), kind: z.enum(["joined", "continuation"]),
  })),
  awaitingFinal: z.boolean().optional(),
});

const replyContextSchema = z.object({
  completion: completionIdentitySchema.optional(),
  mode: z.literal("broker_reply"),
  fromAgentId: z.string(),
  toAgentId: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  replyToMessageId: z.string(),
  replyPath: z.enum(["final_response", "mcp_reply"]),
  action: z.string().optional(),
});

const currentReplyContextResultSchema = z.object({
  active: z.boolean(),
  context: replyContextSchema.nullable(),
});

const replyResultSchema = z.object({
  currentDirectory: z.string(),
  senderId: z.string(),
  usedBroker: z.boolean(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  replyToMessageId: z.string().nullable(),
  notifiedActorIds: z.array(z.string()),
  routingError: z
    .enum([
      "missing_reply_context",
      "unknown_conversation",
      "unknown_reply_target",
      "reply_target_conversation_mismatch",
    ])
    .nullable(),
});

const cardCreateResultSchema = z.object({
  currentDirectory: z.string(),
  senderId: z.string(),
  card: scoutAgentCardSchema,
});

const agentStartResultSchema = z.object({
  currentDirectory: z.string(),
  requestedLabel: z.string().nullable(),
  agentName: z.string().nullable(),
  projectPath: z.string(),
  harness: z.enum(LOCAL_AGENT_HARNESS_VALUES).nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  agent: localAgentStatusSchema,
  exactTargetAgentId: z.string(),
  nextTargetLabel: z.string(),
});

const currentSessionAttachResultSchema = z.object({
  currentDirectory: z.string(),
  externalSessionId: z.string(),
  transport: z.enum(["codex_app_server", "tmux", "ghostty"]),
  harness: z.string().optional(),
  surface: z.string().optional(),
  agentId: z.string(),
  selector: z.string().nullable(),
  endpointId: z.string(),
  sessionId: z.string(),
});

const askResultSchema = z.object({
  currentDirectory: z.string(),
  senderId: z.string(),
  targetAgentId: z.string().nullable(),
  targetSessionId: z.string().nullable().optional(),
  targetLabel: z.string().nullable(),
  replyToSessionId: z.string().nullable().optional(),
  usedBroker: z.boolean(),
  awaited: z.boolean(),
  waitStatus: z.enum(["not_requested", "acknowledged", "completed", "terminal", "pending"]).optional(),
  replyMode: z.enum(REPLY_MODE_VALUES).optional(),
  delivery: z.enum(REPLY_DELIVERY_VALUES).optional(),
  notification: z
    .object({
      method: z.literal("notifications/scout/reply"),
      status: z.enum(["scheduled", "not_scheduled"]),
    })
    .nullable()
    .optional(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  flight: flightSchema.nullable(),
  flightId: z.string().nullable(),
  output: z.string().nullable(),
  unresolvedTargetId: z.string().nullable(),
  unresolvedTargetLabel: z.string().nullable(),
  workItem: trackedWorkItemSchema.nullable(),
  workId: z.string().nullable(),
  workUrl: z.string().nullable(),
  ids: followIdsSchema.optional(),
  links: followLinksSchema.optional(),
  followUrl: z.string().nullable().optional(),
  targetDiagnostic: z.object({}).catchall(z.unknown()).nullable(),
  startSuggestion: startSuggestionSchema.nullable().optional(),
});

const askReceiptSchema = z.object({
  completion: completionStateSchema.extend({ invocationId: z.string(), flightId: z.string() }).optional(),
  parentCompletion: z.object({ flightId: z.string(), revision: z.number().int().min(0) }).optional(),
  links: followLinksSchema.optional(),
  followUrl: z.string().nullable().optional(),
  ok: z.boolean(),
  state: z.enum(["queued", "completed", "failed", "ambiguous"]),
  ids: z.object({
    targetAgentId: z.string().optional(),
    invocationId: z.string().optional(),
    flightId: z.string().optional(),
    conversationId: z.string().optional(),
    messageId: z.string().optional(),
    workId: z.string().optional(),
    bindingRef: z.string().optional(),
  }),
  delivery: z.enum(REPLY_DELIVERY_VALUES).optional(),
  notification: z
    .object({
      method: z.literal("notifications/scout/reply"),
      status: z.enum(["scheduled", "not_scheduled"]),
    })
    .optional(),
  next: z
    .object({
      tool: z.enum(["agents_resolve", "agents_search", "agents_start"]),
      arguments: z.record(z.string(), z.unknown()),
      reason: z.string(),
    })
    .optional(),
  error: z
    .object({
      code: z.enum(["broker_unreachable", "invalid_request", "preflight_failed"]),
      message: z.string(),
    })
    .optional(),
});

const invocationLookupResultSchema = z.object({
  currentDirectory: z.string(),
  flightId: z.string(),
  found: z.boolean(),
  waitStatus: z.enum(["not_requested", "completed", "terminal", "pending"]).optional(),
  terminal: z.boolean(),
  flight: flightSchema.nullable(),
  lifecycle: invocationLifecycleSchema.nullable().optional(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  ids: followIdsSchema.optional(),
  links: followLinksSchema.optional(),
  followUrl: z.string().nullable().optional(),
});

const workUpdateResultSchema = z.object({
  currentDirectory: z.string(),
  senderId: z.string(),
  usedBroker: z.boolean(),
  workItem: trackedWorkItemSchema.nullable(),
  workId: z.string().nullable(),
  workUrl: z.string().nullable(),
});


function parseScoutReplyContextFromEnv(env: NodeJS.ProcessEnv): ScoutReplyContext | null {
  const contextFile = env.OPENSCOUT_REPLY_CONTEXT_FILE?.trim();
  if (contextFile) {
    try {
      const rawFileJson = readFileSync(contextFile, "utf8").trim();
      if (rawFileJson) {
        const parsed = JSON.parse(rawFileJson) as Partial<ScoutReplyContext>;
        if (isScoutReplyContext(parsed)) {
          return parsed;
        }
      }
    } catch {
      // A missing or partially-written reply context file just means there is no
      // active broker reply turn for this long-lived MCP server right now.
    }
  }

  const rawJson = env.OPENSCOUT_REPLY_CONTEXT?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Partial<ScoutReplyContext>;
      if (isScoutReplyContext(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  const mode = env.OPENSCOUT_REPLY_MODE?.trim();
  const fromAgentId = env.OPENSCOUT_REPLY_FROM_AGENT_ID?.trim();
  const toAgentId = env.OPENSCOUT_REPLY_TO_AGENT_ID?.trim();
  const conversationId = env.OPENSCOUT_REPLY_CONVERSATION_ID?.trim();
  const messageId = env.OPENSCOUT_REPLY_MESSAGE_ID?.trim();
  const replyToMessageId = env.OPENSCOUT_REPLY_TO_MESSAGE_ID?.trim() || messageId;
  const replyPath = env.OPENSCOUT_REPLY_PATH?.trim() || "mcp_reply";
  if (mode === "broker_reply" && fromAgentId && toAgentId && conversationId && messageId && replyToMessageId && (replyPath === "final_response" || replyPath === "mcp_reply")) {
    return {
      mode: "broker_reply",
      fromAgentId,
      toAgentId,
      conversationId,
      messageId,
      replyToMessageId,
      replyPath,
      ...(env.OPENSCOUT_REPLY_ACTION?.trim() ? { action: env.OPENSCOUT_REPLY_ACTION.trim() as ScoutReplyContext["action"] } : {}),
    };
  }

  return null;
}

function isScoutReplyContext(value: Partial<ScoutReplyContext>): value is ScoutReplyContext {
  return value.mode === "broker_reply"
    && typeof value.fromAgentId === "string"
    && value.fromAgentId.length > 0
    && typeof value.toAgentId === "string"
    && value.toAgentId.length > 0
    && typeof value.conversationId === "string"
    && value.conversationId.length > 0
    && typeof value.messageId === "string"
    && value.messageId.length > 0
    && typeof value.replyToMessageId === "string"
    && value.replyToMessageId.length > 0
    && (value.replyPath === "final_response" || value.replyPath === "mcp_reply");
}

function createTextContent(value: unknown): [{ type: "text"; text: string }] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function createPlainTextContent(
  text: string,
): [{ type: "text"; text: string }] {
  return [{ type: "text", text }];
}

type SendRoutingAdvice = z.infer<typeof sendRoutingAdviceSchema>;

function buildSendRoutingAdvice(
  routingError: string | null | undefined,
): SendRoutingAdvice | null {
  if (routingError === "missing_destination") {
    return {
      code: "missing_destination",
      summary: "no destination",
      nextAction:
        "Pass one targetAgentId or targetLabel for a DM, or pass channel for a group update.",
    };
  }
  if (routingError === "multi_target_requires_explicit_channel") {
    return {
      code: "multi_target_requires_explicit_channel",
      summary: "multiple targets need an explicit channel",
      nextAction:
        "Pass channel for group coordination, or send separate one-target DMs.",
    };
  }
  return null;
}

function isSessionObserveUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const pathname = new URL(url).pathname;
    return pathname.startsWith("/sessions/")
      || /\/agents\/[^/]+\/sessions\//.test(pathname);
  } catch {
    return url.startsWith("/sessions/")
      || /\/agents\/[^/]+\/sessions\//.test(url);
  }
}

function renderFollowLinkText(result: {
  followUrl?: string | null;
  links?: ScoutFollowLinks;
}): string {
  const workUrl = result.links?.work;
  if (workUrl) {
    return ` Follow the task: ${workUrl}`;
  }
  const observeUrl = result.links?.observe ?? result.followUrl ?? null;
  const tailUrl = result.links?.tail ?? null;
  const observeLabel = isSessionObserveUrl(observeUrl)
    ? "Observe session"
    : "Observe agent";
  if (observeUrl && tailUrl && tailUrl !== observeUrl) {
    return ` ${observeLabel}: ${observeUrl} Scout tail: ${tailUrl}`;
  }
  if (observeUrl) {
    return ` ${observeLabel}: ${observeUrl}`;
  }
  if (tailUrl) {
    return ` Scout tail: ${tailUrl}`;
  }
  return "";
}

function renderMcpSendSummary(result: {
  senderId?: string;
  interaction?: "work" | "message";
  usedBroker: boolean;
  conversationId: string | null;
  messageId: string | null;
  invokedTargetIds: string[];
  unresolvedTargetIds: string[];
  routingError: string | null;
  targetDiagnostic?: Record<string, unknown> | null;
  startSuggestion?: ScoutMcpStartSuggestion | null;
  routingAdvice?: SendRoutingAdvice | null;
  flightId?: string | null;
  invocationId?: string | null;
  replyMode?: "notify" | "none" | null;
  notification?: { status: string } | null;
  wake?: boolean;
  followUrl?: string | null;
}): string {
  if (!result.usedBroker) {
    return result.interaction === "work"
      ? "Scout broker is not reachable; tracked send was not created."
      : "Scout broker is not reachable; message was not sent.";
  }
  if (result.routingError) {
    const advice = result.routingAdvice ?? buildSendRoutingAdvice(result.routingError);
    if (advice) {
      return `Message was not sent: ${advice.summary}. ${advice.nextAction}`;
    }
    return `Message was not sent: ${result.routingError}.`;
  }
  if (result.unresolvedTargetIds.length > 0) {
    return renderUnroutedTargetSummary({
      kind: "Message",
      target: result.unresolvedTargetIds.join(", "),
      targetDiagnostic: result.targetDiagnostic,
      startSuggestion: result.startSuggestion,
    });
  }
  if (result.interaction === "work") {
    const target = result.invokedTargetIds[0] ?? "target";
    const details = [
      result.invocationId ? `invocation ${result.invocationId}` : null,
      result.flightId ? `flight ${result.flightId}` : null,
    ].filter(Boolean).join(", ");
    const detailText = details ? `; ${details}` : "";
    const route = result.conversationId ? ` in ${result.conversationId}` : "";
    const followText = renderFollowLinkText(result);
    const followHint = result.flightId
      ? ` Follow with invocations_wait flightId=${result.flightId}.`
      : "";
    if (result.replyMode === "none") {
      return `Tracked send to ${target}${detailText}${route}. Completion notifications suppressed; the result stays tracked.${followHint}${followText}`;
    }
    const notificationText = result.notification?.status === "scheduled"
      ? " An MCP reply notification is scheduled."
      : "";
    const requester = result.senderId ?? "the requester";
    return `Tracked send to ${target}${detailText}${route}. Completion will be reported back to ${requester}; a requested callback is not proof of receipt.${notificationText}${followHint}${followText}`;
  }
  const destination = result.invokedTargetIds.length > 0
    ? ` to ${result.invokedTargetIds.join(", ")}`
    : "";
  const route = result.conversationId ? ` in ${result.conversationId}` : "";
  const message = result.messageId ? ` (${result.messageId})` : "";
  const followText = renderFollowLinkText(result);
  const wakeText = result.wake && result.flightId
    ? ` Wake queued as ${result.flightId}.${followText}`
    : result.flightId
    ? ` Dispatch queued as ${result.flightId}.${followText}`
    : "";
  return `Message sent${destination}${route}${message}.${wakeText}`;
}

function renderMcpAskSummary(result: {
  usedBroker: boolean;
  targetAgentId: string | null;
  targetLabel: string | null;
  flightId: string | null;
  workId: string | null;
  unresolvedTargetId: string | null;
  unresolvedTargetLabel: string | null;
  output: string | null;
  delivery?: string;
  notification?: { status: string } | null;
  waitStatus?: string;
  flight?: ScoutFlightRecord | null;
  followUrl?: string | null;
  links?: ScoutFollowLinks;
  targetDiagnostic?: Record<string, unknown> | null;
  startSuggestion?: ScoutMcpStartSuggestion | null;
}): string {
  if (!result.usedBroker) {
    return "Scout broker is not reachable; ask was not sent.";
  }
  const unresolved = result.unresolvedTargetId ?? result.unresolvedTargetLabel;
  if (unresolved) {
    return renderUnroutedTargetSummary({
      kind: "Ask",
      target: unresolved,
      targetDiagnostic: result.targetDiagnostic,
      startSuggestion: result.startSuggestion,
    });
  }
  const target = result.targetAgentId ?? result.targetLabel ?? "target";
  const details = [
    result.flightId ? `flight ${result.flightId}` : null,
    result.workId ? `work ${result.workId}` : null,
  ].filter(Boolean);
  const detailText = details.length > 0 ? `; ${details.join(", ")}` : "";
  const followText = renderFollowLinkText(result);
  if (result.waitStatus === "pending" && result.flightId) {
    const state = result.flight?.state ? ` ${result.flight.state}` : "";
    return `Ask dispatch is still${state}; use invocations_wait with flightId=${result.flightId}.${followText}`;
  }
  if (result.waitStatus === "acknowledged" && result.flightId) {
    const state = result.flight?.state ? ` ${result.flight.state}` : "";
    return `Ask acknowledged${state}; use invocations_wait with flightId=${result.flightId}.${followText}`;
  }
  if (result.output) {
    return result.output;
  }
  if (result.notification?.status === "not_scheduled" && result.flightId) {
    return `Ask sent to ${target}${detailText}; MCP notification was not scheduled. Use invocations_wait with flightId=${result.flightId}.${followText}`;
  }
  if (result.delivery === "mcp_notification") {
    return `Ask sent to ${target}; reply will be delivered by MCP notification${detailText}.${followText}`;
  }
  return `Ask sent to ${target}${detailText}.${followText}`;
}

function renderMcpAskPrimitiveSummary(receipt: ScoutAskReceipt): string {
  if (receipt.ok) {
    const target = receipt.ids.targetAgentId
      ? ` to ${receipt.ids.targetAgentId}`
      : "";
    const flight = receipt.ids.flightId ? `; flight ${receipt.ids.flightId}` : "";
    const work = receipt.ids.workId ? `; work ${receipt.ids.workId}` : "";
    let delivery = "";
    if (receipt.notification?.status === "not_scheduled") {
      delivery = receipt.ids.flightId
        ? ` MCP notification was not scheduled; use invocations_wait with flightId=${receipt.ids.flightId}.`
        : " MCP notification was not scheduled.";
    } else if (receipt.delivery === "mcp_notification") {
      delivery = receipt.notification?.status === "scheduled"
        ? " Reply will be delivered by MCP notification."
        : receipt.ids.flightId
          ? ` MCP notification was not scheduled; use invocations_wait with flightId=${receipt.ids.flightId}.`
          : " MCP notification was not scheduled.";
    }
    return `Ask ${receipt.state}${target}${flight}${work}.${delivery}`;
  }
  if (receipt.next) {
    return `Ask was not sent: ${receipt.next.reason}`;
  }
  if (receipt.error) {
    return `Ask was not sent: ${receipt.error.message}`;
  }
  return "Ask was not sent.";
}

function resolveAskReplyMode(input: {
  awaitReply?: boolean;
  replyMode?: ScoutMcpReplyMode;
}): ScoutMcpReplyMode {
  if (input.replyMode) {
    return input.replyMode;
  }
  // Default to notify so an ask that omits replyMode still pushes its reply
  // back to the caller; "none" silently dropped replies. Callers opt out by
  // passing replyMode "none" (ids only) or "inline" explicitly.
  return input.awaitReply ? "inline" : "notify";
}

function areMcpReplyNotificationsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OPENSCOUT_MCP_ENABLE_NOTIFICATIONS?.trim() === "1";
}

function resolveMcpReplyToSessionId(
  explicitSessionId: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return explicitSessionId?.trim() || env.CODEX_THREAD_ID?.trim() || undefined;
}

function workUrlFor(
  workItem: ScoutTrackedWorkItem | null | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  return workItem
    ? buildScoutPath(resolveScoutWebOrigin(env), `/work/${encodeURIComponent(workItem.id)}`)
    : null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function resolveScoutWebOrigin(env: NodeJS.ProcessEnv): string {
  const publicOrigin = env.OPENSCOUT_WEB_PUBLIC_ORIGIN?.trim();
  if (publicOrigin) {
    return trimTrailingSlash(publicOrigin);
  }

  const configuredPort = Number.parseInt(
    env.OPENSCOUT_WEB_PORT?.trim() || env.SCOUT_WEB_PORT?.trim() || "",
    10,
  );
  const port = Number.isFinite(configuredPort)
    ? configuredPort
    : resolveWebPort();
  const rawHost =
    env.OPENSCOUT_WEB_HOST?.trim() ||
    env.SCOUT_WEB_HOST?.trim() ||
    resolveHost();
  const host = rawHost === "0.0.0.0" || rawHost === "::"
    ? "127.0.0.1"
    : rawHost;
  return `http://${host}:${port}`;
}

function buildScoutPath(origin: string, path: string): string {
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildFollowPath(
  ids: ScoutFollowIds,
  preferredView: ScoutFollowPreferredView,
): string | null {
  const params = new URLSearchParams();
  params.set("view", preferredView);
  if (ids.flightId) params.set("flightId", ids.flightId);
  if (ids.invocationId) params.set("invocationId", ids.invocationId);
  if (ids.conversationId) params.set("conversationId", ids.conversationId);
  if (ids.workId) params.set("workId", ids.workId);
  if (ids.sessionId) params.set("sessionId", ids.sessionId);
  if (ids.targetAgentId) params.set("targetAgentId", ids.targetAgentId);
  const query = params.toString();
  return query === `view=${preferredView}` ? null : `/follow?${query}`;
}

function buildScoutFollowArtifacts(
  input: {
    flight: ScoutFlightRecord | null;
    conversationId: string | null;
    workItem: ScoutTrackedWorkItem | null;
    workId?: string | null;
    flightId?: string | null;
    invocationId?: string | null;
    targetSessionId?: string | null;
    targetAgentId: string | null;
  },
  env: NodeJS.ProcessEnv,
): { ids: ScoutFollowIds; links: ScoutFollowLinks; followUrl: string | null } {
  const ids: ScoutFollowIds = {
    flightId: input.flight?.id ?? input.flightId ?? null,
    invocationId: input.flight?.invocationId ?? input.invocationId ?? null,
    conversationId: input.conversationId ?? metadataStringValue(input.flight?.metadata, "conversationId"),
    workId: input.workItem?.id
      ?? input.workId
      ?? metadataStringValue(input.flight?.metadata, "workId")
      ?? metadataStringValue(input.flight?.metadata, "collaborationRecordId"),
    sessionId: input.targetSessionId ?? null,
    targetAgentId: input.targetAgentId ?? input.flight?.targetAgentId ?? null,
  };
  const origin = resolveScoutWebOrigin(env);
  const observePath = ids.sessionId && ids.targetAgentId
    ? `/agents/${encodeURIComponent(ids.targetAgentId)}/sessions/${encodeURIComponent(ids.sessionId)}`
    : ids.sessionId
    ? `/sessions/${encodeURIComponent(ids.sessionId)}`
    : ids.targetAgentId
    ? `/agents/${encodeURIComponent(ids.targetAgentId)}?tab=observe`
    : null;
  const followPath = (ids.workId ? `/work/${encodeURIComponent(ids.workId)}` : null)
    ?? observePath
    ?? (ids.conversationId ? `/c/${encodeURIComponent(ids.conversationId)}` : null)
    ?? buildFollowPath(ids, "tail");

  const follow = followPath ? buildScoutPath(origin, followPath) : null;
  const tailPath = buildFollowPath(ids, "tail");
  const sessionPath = buildFollowPath(ids, "session");
  const observe = observePath ? buildScoutPath(origin, observePath) : null;
  const links: ScoutFollowLinks = {
    follow,
    tail: tailPath ? buildScoutPath(origin, tailPath) : null,
    session: sessionPath ? buildScoutPath(origin, sessionPath) : null,
    chat: ids.conversationId
      ? buildScoutPath(origin, `/c/${encodeURIComponent(ids.conversationId)}`)
      : null,
    work: ids.workId
      ? buildScoutPath(origin, `/work/${encodeURIComponent(ids.workId)}`)
      : null,
    agent: ids.targetAgentId
      ? buildScoutPath(origin, `/agents/${encodeURIComponent(ids.targetAgentId)}?tab=message`)
      : null,
    observe,
  };

  return { ids, links, followUrl: follow };
}

function isTerminalFlightState(state: string | null | undefined): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

type ScoutMcpFlightWaitStatus =
  | "not_requested"
  | "acknowledged"
  | "completed"
  | "terminal"
  | "pending";

async function loadInvocationLifecycleForFlight(input: {
  deps: ScoutMcpDependencies;
  brokerUrl: string;
  flight: ScoutFlightRecord | null;
}): Promise<ScoutInvocationLifecycleRecord | null> {
  if (!input.flight?.invocationId || !input.deps.getInvocationLifecycle) {
    return null;
  }
  return await input.deps.getInvocationLifecycle(
    input.brokerUrl,
    input.flight.invocationId,
  );
}

function isAcknowledgedFlightState(state: string | null | undefined): boolean {
  return state === "running" || state === "waiting";
}

async function waitForFlightForMcp(input: {
  deps: ScoutMcpDependencies;
  brokerUrl: string;
  flight: ScoutFlightRecord | null;
  timeoutSeconds?: number;
}): Promise<{ flight: ScoutFlightRecord | null; waitStatus: ScoutMcpFlightWaitStatus }> {
  if (!input.flight) {
    return { flight: null, waitStatus: "not_requested" };
  }

  const deadline =
    typeof input.timeoutSeconds === "number" && input.timeoutSeconds > 0
      ? Date.now() + input.timeoutSeconds * 1000
      : Date.now() + DEFAULT_ASK_ACK_TIMEOUT_SECONDS * 1000;
  let latestFlight = input.flight;

  while (true) {
    if (latestFlight.state === "completed") {
      return { flight: latestFlight, waitStatus: "completed" };
    }
    if (isTerminalFlightState(latestFlight.state)) {
      return { flight: latestFlight, waitStatus: "terminal" };
    }
    if (isAcknowledgedFlightState(latestFlight.state)) {
      return { flight: latestFlight, waitStatus: "acknowledged" };
    }
    if (deadline !== null && Date.now() > deadline) {
      return { flight: latestFlight, waitStatus: "pending" };
    }
    latestFlight = await input.deps.getFlight(input.brokerUrl, input.flight.id) ?? latestFlight;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function buildInvocationLookupContent(input: {
  currentDirectory: string;
  flightId: string;
  flight: ScoutFlightRecord | null;
  lifecycle?: ScoutInvocationLifecycleRecord | null;
  waitStatus?: "not_requested" | "completed" | "terminal" | "pending";
  env: NodeJS.ProcessEnv;
}) {
  const followArtifacts = buildScoutFollowArtifacts(
    {
      flight: input.flight,
      conversationId: null,
      workItem: null,
      targetAgentId: input.lifecycle?.targetAgentId ?? input.flight?.targetAgentId ?? null,
    },
    input.env,
  );
  const terminal = isTerminalFlightState(input.flight?.state);
  return {
    currentDirectory: input.currentDirectory,
    flightId: input.flightId,
    found: Boolean(input.flight),
    waitStatus: input.waitStatus,
    terminal,
    flight: input.flight,
    lifecycle: input.lifecycle ?? null,
    output: input.flight?.output
      ?? input.flight?.summary
      ?? null,
    error: input.flight?.error
      ?? null,
    ids: followArtifacts.ids,
    links: followArtifacts.links,
    followUrl: followArtifacts.followUrl,
  };
}

function renderInvocationLookupSummary(result: {
  flightId: string;
  found: boolean;
  waitStatus?: string;
  flight: ScoutFlightRecord | null;
  output: string | null;
  error: string | null;
  followUrl?: string | null;
  links?: ScoutFollowLinks;
}): string {
  if (!result.found || !result.flight) {
    return `Flight ${result.flightId} was not found.`;
  }
  if (result.flight.state === "completed" && result.output) {
    return result.output;
  }
  if ((result.flight.state === "failed" || result.flight.state === "cancelled") && result.error) {
    return result.error;
  }
  const followText = renderFollowLinkText(result);
  if (result.waitStatus === "pending") {
    return `Flight ${result.flightId} is still ${result.flight.state}.${followText}`;
  }
  return `Flight ${result.flightId} is ${result.flight.state}.${followText}`;
}

function renderMcpLabelBriefSummary(brief: ScoutLabelBrief & { found: boolean }): string {
  if (!brief.found) {
    return `Label ${brief.label} was not found.`;
  }
  const pieces = [
    `Label ${brief.label}`,
    `${brief.counts.activeFlights} active flights`,
    `${brief.counts.flights} total flights`,
    `${brief.counts.workItems} work items`,
  ];
  const active = brief.activeFlights
    .slice(0, 3)
    .map((flight) => `${flight.id} ${flight.state} -> ${flight.targetAgentId}`)
    .join("; ");
  const recent = active ? ` Active: ${active}.` : "";
  return `${pieces.join("; ")}.${recent}`;
}

function renderMcpLabelFeedSummary(feed: ScoutLabelFeed & { found: boolean }): string {
  if (!feed.found) {
    return `Label ${feed.label} feed is unavailable.`;
  }
  const latest = feed.events.at(-1);
  const latestText = latest
    ? ` Latest: ${latest.kind} from ${latest.actorId ?? "unknown"} - ${latest.summary}`
    : " No events yet.";
  return `Label ${feed.label}; ${feed.counts.events} events; cursor ${feed.cursor ?? "none"}.${latestText}`;
}

function renderMcpBrokerFeedSummary(feed: ScoutAgentBrokerFeed & { found: boolean }): string {
  if (!feed.found) {
    return `Broker feed for ${feed.agentId} is unavailable.`;
  }
  const latest = feed.items[0];
  const latestText = latest
    ? ` Latest: ${latest.kind} ${latest.severity} - ${latest.summary}`
    : " No broker events yet.";
  return `Broker feed for ${feed.agentId}; ${feed.counts.items} items; ${feed.counts.errors} errors; ${feed.counts.warnings} warnings; cursor ${feed.cursor ?? "none"}.${latestText}`;
}

function renderMcpTailEventsSummary(result: z.infer<typeof tailEventsResultSchema>): string {
  const latest = result.events.at(-1);
  const filterText = [
    result.filters.sources.length ? `sources=${result.filters.sources.join(",")}` : null,
    result.filters.kinds.length ? `kinds=${result.filters.kinds.join(",")}` : null,
    result.filters.sessionId ? `session=${result.filters.sessionId}` : null,
    result.filters.project ? `project=${result.filters.project}` : null,
    result.filters.query ? `query=${result.filters.query}` : null,
  ].filter(Boolean).join("; ");
  const latestText = latest
    ? ` Latest: ${latest.source} ${latest.kind} ${latest.project} - ${latest.summary}`
    : " No tail events yet.";
  const scope = filterText ? ` (${filterText})` : "";
  return `Tail events${scope}; ${result.counts.events} events; ${result.counts.sources} sources; ${result.counts.sessions} sessions; cursor ${result.cursor ?? "none"}.${latestText}`;
}

function resolveCurrentCodexThreadId(env: NodeJS.ProcessEnv): string {
  const threadId = env.CODEX_THREAD_ID?.trim();
  if (!threadId) {
    throw new Error(
      "The current host session is not an attachable Codex session. Expected CODEX_THREAD_ID in the environment.",
    );
  }
  return threadId;
}

function sendScoutReplyNotification(
  server: McpServer,
  params: ScoutReplyNotificationParams,
): Promise<void> {
  return server.server.notification({
    method: "notifications/scout/reply",
    params,
  });
}

const notificationLifetimes = new WeakMap<McpServer, AbortSignal>();

function scheduleScoutReplyNotification(input: {
  server: McpServer;
  deps: ScoutMcpDependencies;
  brokerUrl: string;
  flight: Pick<ScoutFlightRecord, "id"> & Partial<Pick<ScoutFlightRecord, "invocationId">>;
  context: Omit<
    ScoutReplyNotificationParams,
    "status" | "flight" | "output" | "error"
  >;
}): void {
  const signal = notificationLifetimes.get(input.server);
  void (async () => {
    try {
      // A queued dispatch may not have materialized the flight yet; give it
      // a few beats before treating the wait failure as terminal.
      let completedFlight: ScoutFlightRecord | undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          completedFlight = await input.deps.waitForFlight(
            input.brokerUrl,
            input.flight.id,
            { signal, invocationId: input.flight.invocationId },
          );
          break;
        } catch (error) {
          if (signal?.aborted || attempt >= 2) throw error;
          await delay(2_000, undefined, { signal });
        }
      }
      await sendScoutReplyNotification(input.server, {
        ...input.context,
        status: "completed",
        flight: completedFlight,
        output: completedFlight.output ?? completedFlight.summary ?? null,
        error: null,
      });
    } catch (error) {
      if (signal?.aborted) return;
      await sendScoutReplyNotification(input.server, {
        ...input.context,
        status: "failed",
        flight: null,
        output: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })().catch(() => {
    // The MCP client may have disconnected by the time the flight finishes.
  });
}

function normalizeSearchValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/^@+/, "") ?? "";
}

type ScoutMcpStartSuggestion = z.infer<typeof startSuggestionSchema>;

function parseStartTargetLabel(
  targetLabel: string | null | undefined,
): {
  agentName: string | null;
  harness: (typeof LOCAL_AGENT_HARNESS_VALUES)[number] | null;
  model: string | null;
} {
  const rawLabel = targetLabel?.trim();
  if (!rawLabel) {
    return { agentName: null, harness: null, model: null };
  }

  const label = rawLabel.replace(/^@+/, "");
  const harnessMatch = label.match(/(?:#|harness:)(claude|codex|cursor|devin|grok|kimi|opencode|pi)\b/i);
  const shorthandModelMatch = label.match(/\?([^#\s.]+)/);
  const qualifiedModelMatch = label.match(/(?:^|\.)model:([^#?\s.]+)/i);
  const base = label
    .split("?")[0]
    ?.split("#")[0]
    ?.replace(/\.harness:.*/i, "")
    ?? "";
  const agentName = base.split(".")[0]?.trim() || null;
  const harnessValue = harnessMatch?.[1]?.toLowerCase();
  const harness = LOCAL_AGENT_HARNESS_VALUES.find((value) => value === harnessValue) ?? null;
  const model =
    shorthandModelMatch?.[1]?.trim()
    || qualifiedModelMatch?.[1]?.trim()
    || null;

  return { agentName, harness, model };
}

async function buildStartSuggestionForTarget(
  targetLabel: string | null | undefined,
  currentDirectory: string,
): Promise<ScoutMcpStartSuggestion | null> {
  const trimmedLabel = targetLabel?.trim();
  if (!trimmedLabel) {
    return null;
  }
  const parsed = parseStartTargetLabel(trimmedLabel);
  const projectPath =
    await findNearestProjectRoot(currentDirectory) ?? currentDirectory;
  return {
    tool: "agents_start",
    targetLabel: trimmedLabel,
    agentName: parsed.agentName,
    harness: parsed.harness,
    model: parsed.model,
    projectPath,
    currentDirectory,
  };
}

function normalizeModelConstraint(value: string | null | undefined): string {
  return value?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
}

function candidateMatchesStartConstraints(
  candidate: ScoutMcpAgentCandidate,
  parsed: ReturnType<typeof parseStartTargetLabel>,
): boolean {
  if (parsed.harness && candidate.harness !== parsed.harness) {
    return false;
  }
  if (parsed.model) {
    const requested = normalizeModelConstraint(parsed.model);
    const candidateModel = normalizeModelConstraint(candidate.model);
    if (!candidateModel || (
      candidateModel !== requested && !candidateModel.includes(requested)
    )) {
      return false;
    }
  }
  return true;
}

async function diagnosePreciseTargetLabel(input: {
  deps: Pick<ScoutMcpDependencies, "resolveAgent">;
  targetLabel: string | null | undefined;
  currentDirectory: string;
}): Promise<{
  blocked: boolean;
  startSuggestion: ScoutMcpStartSuggestion | null;
  diagnostic: Record<string, unknown> | null;
}> {
  const label = input.targetLabel?.trim();
  if (!label) {
    return { blocked: false, startSuggestion: null, diagnostic: null };
  }
  const parsed = parseStartTargetLabel(label);
  if (!parsed.harness && !parsed.model) {
    return { blocked: false, startSuggestion: null, diagnostic: null };
  }

  const resolution = await input.deps.resolveAgent({
    label,
    currentDirectory: input.currentDirectory,
  });
  const matchingCandidates = [
    resolution.candidate,
    ...resolution.candidates,
  ].filter((candidate): candidate is ScoutMcpAgentCandidate => {
    if (!candidate) return false;
    return candidateMatchesStartConstraints(candidate, parsed);
  });
  if (matchingCandidates.length === 1) {
    return { blocked: false, startSuggestion: null, diagnostic: null };
  }

  return {
    blocked: true,
    startSuggestion: await buildStartSuggestionForTarget(
      label,
      input.currentDirectory,
    ),
    diagnostic: {
      kind: resolution.kind === "resolved"
        ? "target_constraint_mismatch"
        : resolution.kind === "ambiguous"
          ? "target_constraint_ambiguous"
          : "target_unresolved",
      label,
      requested: {
        agentName: parsed.agentName,
        harness: parsed.harness,
        model: parsed.model,
      },
      resolvedCandidate: resolution.candidate
        ? {
            agentId: resolution.candidate.agentId,
            harness: resolution.candidate.harness,
            model: resolution.candidate.model,
          }
        : null,
      matchingCandidateIds: matchingCandidates.map((candidate) => candidate.agentId),
    },
  };
}

function renderStartSuggestionText(
  startSuggestion: ScoutMcpStartSuggestion | null | undefined,
): string {
  if (!startSuggestion) {
    return "";
  }
  const args = [
    startSuggestion.agentName
      ? `agentName="${startSuggestion.agentName}"`
      : null,
    startSuggestion.harness ? `harness="${startSuggestion.harness}"` : null,
    startSuggestion.model ? `model="${startSuggestion.model}"` : null,
    `projectPath="${startSuggestion.projectPath}"`,
  ].filter(Boolean);
  return ` If this should be a new session, call agents_start with ${args.join(", ")} and then retry using the returned exactTargetAgentId.`;
}

function renderExactTargetNoStartSuggestionText(
  targetDiagnostic: Record<string, unknown> | null | undefined,
): string {
  const diagnosticKind = typeof targetDiagnostic?.kind === "string"
    ? targetDiagnostic.kind
    : "";
  if (
    diagnosticKind !== "exact_target_id_unresolved" &&
    diagnosticKind !== "exact_target_ids_unresolved"
  ) {
    return "";
  }
  return " Exact targetAgentId paths cannot infer agents_start arguments; use agents_search to pick an existing agent, or call agents_start with a targetLabel/agentName/harness/model and retry with the returned exactTargetAgentId.";
}

function renderUnroutedTargetSummary(input: {
  kind: "Message" | "Ask";
  target: string;
  targetDiagnostic?: Record<string, unknown> | null;
  startSuggestion?: ScoutMcpStartSuggestion | null;
}): string {
  const diagnosticKind = typeof input.targetDiagnostic?.kind === "string"
    ? input.targetDiagnostic.kind
    : "";
  if (diagnosticKind === "target_constraint_mismatch") {
    return `${input.kind} was not sent; target constraints did not match any resolved agent: ${input.target}.${renderStartSuggestionText(input.startSuggestion)}`;
  }
  if (diagnosticKind === "target_constraint_ambiguous") {
    return `${input.kind} was not sent; target constraints matched multiple agents: ${input.target}.${renderStartSuggestionText(input.startSuggestion)}`;
  }
  return `${input.kind} was not sent; unresolved target: ${input.target}.${renderStartSuggestionText(input.startSuggestion)}${renderExactTargetNoStartSuggestionText(input.targetDiagnostic)}`;
}

function buildExactTargetIdsDiagnostic(
  targetAgentIds: string[],
): Record<string, unknown> | null {
  const unresolvedTargetIds = [
    ...new Set(targetAgentIds.map((value) => value.trim()).filter(Boolean)),
  ];
  if (unresolvedTargetIds.length === 0) {
    return null;
  }
  return {
    kind: unresolvedTargetIds.length === 1
      ? "exact_target_id_unresolved"
      : "exact_target_ids_unresolved",
    unresolvedTargetIds,
    startSuggestionAvailable: false,
    detail:
      "Exact targetAgentId routing does not include enough label information to infer safe agents_start arguments.",
  };
}

function isCanonicalOpenScoutProjectRoot(
  projectRoot: string | null | undefined,
): boolean {
  if (!projectRoot) {
    return false;
  }
  return normalizeSearchValue(basename(resolve(projectRoot))) === "openscout";
}

function isSameProjectRoot(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return resolve(left) === resolve(right);
}

function matchesObviousProjectLocalAlias(
  value: string | null | undefined,
  query: string,
): boolean {
  const normalized = normalizeSearchValue(value);
  if (!normalized || !query) {
    return false;
  }
  return normalized === query
    || normalized.startsWith(`${query}-`)
    || normalized.startsWith(`${query}.`)
    || normalized.startsWith(`${query}_`)
    || normalized.startsWith(`${query} `);
}

function scoreProjectLocalCandidate(
  candidate: ScoutMcpAgentCandidate,
  currentProjectRoot: string,
  query: string,
): number {
  if (!isSameProjectRoot(candidate.projectRoot, currentProjectRoot)) {
    return -1;
  }

  const values = [
    candidate.defaultLabel,
    candidate.label,
    candidate.handle,
    candidate.selector,
    candidate.defaultSelector,
    candidate.displayName,
    candidate.agentId,
  ];
  const matches = values.filter((value) =>
    matchesObviousProjectLocalAlias(value, query),
  );
  if (matches.length === 0) {
    return -1;
  }

  return 1000 + rankState(candidate.state) * 20 + (candidate.routable ? 50 : 0);
}

async function findPreferredProjectLocalCandidate(
  candidates: ScoutMcpAgentCandidate[],
  rawLabel: string,
  currentDirectory: string,
): Promise<ScoutMcpAgentCandidate | null> {
  const query = normalizeSearchValue(rawLabel);
  if (!query) {
    return null;
  }

  const currentProjectRoot =
    await findNearestProjectRoot(currentDirectory) ?? currentDirectory;
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreProjectLocalCandidate(candidate, currentProjectRoot, query),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return left.candidate.agentId.localeCompare(right.candidate.agentId);
    });

  if (scored.length === 0) {
    return null;
  }
  if (scored.length > 1 && scored[0]?.score === scored[1]?.score) {
    return null;
  }
  return scored[0]?.candidate ?? null;
}

function normalizedStringOrNull(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function metadataStringValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isBuiltInDirectoryAgent(agent: {
  id: string;
  definitionId?: string;
  metadata?: Record<string, unknown>;
}): boolean {
  const definitionId =
    agent.definitionId
    || metadataStringValue(agent.metadata, "definitionId")
    || agent.id;
  return BUILT_IN_AGENT_DEFINITION_IDS.has(definitionId);
}

function rankState(state: SearchableAgentState): number {
  switch (state) {
    case "active":
      return 5;
    case "waiting":
      return 4;
    case "idle":
      return 3;
    case "offline":
      return 2;
    case "discovered":
    default:
      return 1;
  }
}

function isRoutableState(state: SearchableAgentState): boolean {
  return state === "active" || state === "waiting" || state === "idle";
}

function preferredWhoEntry(
  entry: ScoutWhoEntry | undefined,
  fallback: SearchableAgentState,
): { state: SearchableAgentState; registrationKind: SearchRegistrationKind } {
  const state = normalizeSearchableAgentState(entry?.state, fallback);
  if (!entry) {
    return {
      state,
      registrationKind: fallback === "discovered" ? "discovered" : "configured",
    };
  }

  return {
    state,
    registrationKind: entry.registrationKind,
  };
}

function choosePreferredEndpoint(
  endpoints: Array<{
    state?: AgentState;
    harness?: string;
    transport?: string;
    projectRoot?: string;
    cwd?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }>,
) {
  const orderedStates: AgentState[] = ["active", "waiting", "idle", "offline"];
  for (const state of orderedStates) {
    const match = endpoints.find((endpoint) => endpoint.state === state);
    if (match) {
      return match;
    }
  }
  return endpoints[0] ?? null;
}

function buildIdentityCandidate(
  entry: InternalAgentDirectoryEntry,
): AgentIdentityCandidate {
  const aliases = [entry.selector, entry.defaultSelector, entry.handle].filter(
    (value): value is string => Boolean(value && value.trim().length > 0),
  );
  if (
    normalizeSearchValue(entry.definitionId) === "openscout"
    || normalizeSearchValue(entry.handle) === "openscout"
    || normalizeSearchValue(entry.defaultSelector) === "openscout"
  ) {
    aliases.push("@scout");
  }

  return {
    agentId: entry.agentId,
    definitionId: entry.definitionId,
    ...(entry.workspace ? { workspaceQualifier: entry.workspace } : {}),
    ...(entry.node ? { nodeQualifier: entry.node } : {}),
    ...(entry.harness ? { harness: entry.harness } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    aliases,
  };
}

interface AgentCandidateDirectory {
  candidates: ScoutMcpAgentCandidate[];
  identityCandidates: AgentIdentityCandidate[];
  identityByCandidate: Map<ScoutMcpAgentCandidate, AgentIdentityCandidate>;
}

// Minimally-disambiguated display labels cost O(directory size) per candidate
// to compute, and broker snapshots can carry thousands of directory entries —
// eagerly labeling every candidate once took minutes of CPU and starved the
// mesh bridge's event loop. Candidates therefore start with a cheap label and
// tool calls decorate only the candidates they actually return.
function buildAgentCandidateDirectory(
  entries: InternalAgentDirectoryEntry[],
): AgentCandidateDirectory {
  const identityCandidates = entries.map((entry) => buildIdentityCandidate(entry));
  const identityByCandidate = new Map<ScoutMcpAgentCandidate, AgentIdentityCandidate>();
  const candidates = entries.map((entry, index) => {
    const defaultLabel = entry.defaultSelector
      ? `@${entry.defaultSelector}`
      : null;
    const candidate: ScoutMcpAgentCandidate = {
      agentId: entry.agentId,
      label: defaultLabel ?? `@${entry.agentId}`,
      defaultLabel,
      displayName: entry.displayName,
      handle: entry.handle,
      selector: entry.selector,
      defaultSelector: entry.defaultSelector,
      state: entry.state,
      registrationKind: entry.registrationKind,
      routable: entry.routable,
      harness: entry.harness,
      model: entry.model,
      workspace: entry.workspace,
      node: entry.node,
      projectRoot: entry.projectRoot,
      transport: entry.transport,
      sessionId: entry.sessionId,
    };
    identityByCandidate.set(candidate, identityCandidates[index]);
    return candidate;
  });
  return { candidates, identityCandidates, identityByCandidate };
}

function withMinimalLabel(
  candidate: ScoutMcpAgentCandidate,
  directory: AgentCandidateDirectory,
): ScoutMcpAgentCandidate {
  const identity = directory.identityByCandidate.get(candidate);
  if (!identity) return candidate;
  return {
    ...candidate,
    label: formatMinimalAgentIdentity(identity, directory.identityCandidates),
  };
}

const MAX_DECORATED_CANDIDATES = 50;

function withMinimalLabels(
  candidates: ScoutMcpAgentCandidate[],
  directory: AgentCandidateDirectory,
): ScoutMcpAgentCandidate[] {
  return candidates.map((candidate, index) =>
    index < MAX_DECORATED_CANDIDATES ? withMinimalLabel(candidate, directory) : candidate,
  );
}

function isOpenScoutNamedCandidate(
  candidate: ScoutMcpAgentCandidate,
): boolean {
  const agentIdHead = normalizeSearchValue(candidate.agentId).split(".")[0] ?? "";
  return [
    candidate.handle,
    candidate.defaultSelector,
    candidate.defaultLabel,
    agentIdHead,
  ].some((value) => normalizeSearchValue(value) === "openscout");
}

function findPreferredStableScoutCandidate(
  candidates: ScoutMcpAgentCandidate[],
): ScoutMcpAgentCandidate | null {
  const scored = candidates
    .filter((candidate) => (
      isCanonicalOpenScoutProjectRoot(candidate.projectRoot)
      && isOpenScoutNamedCandidate(candidate)
    ))
    .map((candidate) => ({
      candidate,
      score: rankState(candidate.state) * 20 + (candidate.routable ? 50 : 0),
    }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return left.candidate.agentId.localeCompare(right.candidate.agentId);
    });

  if (scored.length === 0) {
    return null;
  }
  if (scored.length > 1 && scored[0]?.score === scored[1]?.score) {
    return null;
  }
  return scored[0]?.candidate ?? null;
}

function scoreTextCandidate(
  value: string | null | undefined,
  query: string,
): number {
  const normalizedValue = normalizeSearchValue(value);
  if (!normalizedValue) return -1;

  if (normalizedValue === query) return 900;
  if (normalizedValue.startsWith(query)) return 700;
  if (
    normalizedValue.split(/[\s._:/-]+/).some((part) => part.startsWith(query))
  )
    return 500;
  if (normalizedValue.includes(query)) return 300;
  return -1;
}

function scoreAgentCandidate(
  candidate: ScoutMcpAgentCandidate,
  query: string,
): number {
  const stateBonus =
    rankState(candidate.state) * 20 + (candidate.routable ? 25 : 0);
  if (!query) return stateBonus;

  const haystacks = [
    candidate.label,
    candidate.defaultLabel,
    candidate.displayName,
    candidate.handle,
    candidate.selector,
    candidate.defaultSelector,
    candidate.agentId,
    candidate.harness,
    candidate.model,
    candidate.workspace,
    candidate.node,
    candidate.projectRoot ? basename(candidate.projectRoot) : null,
  ];
  let best = -1;
  for (const value of haystacks) {
    best = Math.max(best, scoreTextCandidate(value, query));
  }
  if (
    (query === "scout" || query === "openscout")
    && isCanonicalOpenScoutProjectRoot(candidate.projectRoot)
  ) {
    best = Math.max(best, 900);
  }
  if (best < 0) return -1;
  return best + stateBonus;
}

function exactCandidateMatches(
  candidate: ScoutMcpAgentCandidate,
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return false;

  return [
    candidate.agentId,
    candidate.label,
    candidate.defaultLabel,
    candidate.handle,
    candidate.selector,
    candidate.defaultSelector,
    candidate.model,
  ].some((value) => normalizeSearchValue(value) === normalizedQuery);
}

async function loadScoutAgentDirectory(
  currentDirectory: string,
): Promise<InternalAgentDirectoryEntry[]> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    throw new Error(
      `Broker is not reachable at ${resolveScoutBrokerUrl()}. Run scout setup first.`,
    );
  }

  const [setup, whoEntries] = await Promise.all([
    loadResolvedRelayAgents({ currentDirectory }),
    listScoutAgents({ currentDirectory }),
  ]);

  const whoByAgentId = new Map(
    whoEntries.map((entry) => [entry.agentId, entry]),
  );
  const directory = new Map<string, InternalAgentDirectoryEntry>();

  const upsert = (entry: InternalAgentDirectoryEntry) => {
    const existing = directory.get(entry.agentId);
    if (!existing) {
      directory.set(entry.agentId, entry);
      return;
    }

    directory.set(entry.agentId, {
      ...existing,
      ...entry,
      displayName: entry.displayName || existing.displayName,
      handle: entry.handle ?? existing.handle,
      selector: entry.selector ?? existing.selector,
      defaultSelector: entry.defaultSelector ?? existing.defaultSelector,
      harness: entry.harness ?? existing.harness,
      model: entry.model ?? existing.model,
      workspace: entry.workspace ?? existing.workspace,
      node: entry.node ?? existing.node,
      projectRoot: entry.projectRoot ?? existing.projectRoot,
      transport: entry.transport ?? existing.transport,
      sessionId: entry.sessionId ?? existing.sessionId,
      state:
        rankState(entry.state) >= rankState(existing.state)
          ? entry.state
          : existing.state,
      registrationKind:
        entry.registrationKind === "broker"
          ? entry.registrationKind
          : existing.registrationKind,
      routable: entry.routable || existing.routable,
    });
  };

  for (const discovered of setup.discoveredAgents) {
    const whoEntry = whoByAgentId.get(discovered.agentId);
    const identity = preferredWhoEntry(
      whoEntry,
      discovered.registrationKind === "discovered" ? "discovered" : "offline",
    );
    upsert({
      agentId: discovered.agentId,
      definitionId: discovered.definitionId,
      displayName: discovered.displayName,
      handle:
        discovered.instance.selector ||
        discovered.instance.defaultSelector ||
        null,
      selector: discovered.instance.selector || null,
      defaultSelector: discovered.instance.defaultSelector || null,
      state: identity.state,
      registrationKind: identity.registrationKind,
      routable: isRoutableState(identity.state),
      harness: discovered.runtime.harness ?? discovered.defaultHarness,
      model: null,
      workspace: discovered.instance.workspaceQualifier || null,
      node: discovered.instance.nodeQualifier || null,
      projectRoot: discovered.projectRoot,
      transport: discovered.runtime.transport ?? null,
      sessionId: null,
    });
  }

  for (const agent of Object.values(broker.snapshot.agents ?? {})) {
    if (agent.id === "operator") continue;
    if (isBuiltInDirectoryAgent(agent)) continue;

    const endpoints = Object.values(broker.snapshot.endpoints ?? {}).filter(
      (endpoint) => endpoint.agentId === agent.id,
    );
    const preferredEndpoint = choosePreferredEndpoint(endpoints);
    const whoEntry = whoByAgentId.get(agent.id);
    const state = normalizeSearchableAgentState(
      whoEntry?.state ?? preferredEndpoint?.state,
      "offline",
    );

    upsert({
      agentId: agent.id,
      definitionId: agent.definitionId || agent.id,
      displayName: agent.displayName || agent.handle || agent.id,
      handle: normalizedStringOrNull(agent.handle),
      selector: normalizedStringOrNull(agent.selector),
      defaultSelector: normalizedStringOrNull(agent.defaultSelector),
      state,
      registrationKind: whoEntry?.registrationKind ?? "broker",
      routable: isRoutableState(state),
      harness: normalizedStringOrNull(preferredEndpoint?.harness),
      model: normalizedStringOrNull(
        typeof preferredEndpoint?.metadata?.model === "string"
          ? preferredEndpoint.metadata.model
          : typeof agent.metadata?.model === "string"
            ? agent.metadata.model
            : null,
      ),
      workspace: normalizedStringOrNull(agent.workspaceQualifier),
      node: normalizedStringOrNull(agent.nodeQualifier),
      projectRoot: normalizedStringOrNull(
        preferredEndpoint?.projectRoot ?? preferredEndpoint?.cwd,
      ),
      transport: normalizedStringOrNull(preferredEndpoint?.transport),
      sessionId: normalizedStringOrNull(preferredEndpoint?.sessionId),
    });
  }

  return [...directory.values()].sort((left, right) => {
    const stateDelta = rankState(right.state) - rankState(left.state);
    if (stateDelta !== 0) return stateDelta;
    return left.displayName.localeCompare(right.displayName);
  });
}

export async function searchScoutAgentsForMcp(input: {
  query?: string;
  currentDirectory: string;
  limit?: number;
}): Promise<ScoutMcpAgentCandidate[]> {
  const debugTiming = process.env.OPENSCOUT_MCP_DEBUG_TIMING === "1";
  let mark = performance.now();
  const lap = (label: string) => {
    if (!debugTiming) return;
    console.error(`searchScoutAgentsForMcp ${label} ${Math.round(performance.now() - mark)}ms`);
    mark = performance.now();
  };
  const entries = await loadScoutAgentDirectory(input.currentDirectory);
  lap("load");
  const directory = buildAgentCandidateDirectory(entries);
  const candidates = directory.candidates;
  lap("candidates");
  const normalizedQuery = normalizeSearchValue(input.query);
  const currentProjectRoot =
    await findNearestProjectRoot(input.currentDirectory) ?? input.currentDirectory;
  lap("projectRoot");
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));

  const result = candidates
    .map((candidate) => ({
      candidate,
      score:
        scoreAgentCandidate(candidate, normalizedQuery)
        + Math.max(
          0,
          scoreProjectLocalCandidate(candidate, currentProjectRoot, normalizedQuery),
        ),
    }))
    .filter((entry) => normalizedQuery.length === 0 || entry.score >= 0)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      const stateDelta =
        rankState(right.candidate.state) - rankState(left.candidate.state);
      if (stateDelta !== 0) return stateDelta;
      return left.candidate.displayName.localeCompare(
        right.candidate.displayName,
      );
    })
    .slice(0, limit)
    .map((entry) => withMinimalLabel(entry.candidate, directory));
  lap("score+sort+decorate");
  return result;
}

export async function resolveScoutAgentForMcp(input: {
  label: string;
  currentDirectory: string;
}): Promise<ScoutMcpResolveResult> {
  const rawLabel = input.label.trim();
  if (!rawLabel) {
    return { kind: "unresolved", candidate: null, candidates: [] };
  }

  const entries = await loadScoutAgentDirectory(input.currentDirectory);
  const directory = buildAgentCandidateDirectory(entries);
  const candidates = directory.candidates;
  const exactMatches = candidates.filter((candidate) =>
    exactCandidateMatches(candidate, rawLabel),
  );
  if (["scout", "openscout"].includes(normalizeSearchValue(rawLabel))) {
    const preferredStableScoutCandidate = findPreferredStableScoutCandidate(candidates);
    if (preferredStableScoutCandidate) {
      return {
        kind: "resolved",
        candidate: withMinimalLabel(preferredStableScoutCandidate, directory),
        candidates: [],
      };
    }
  }

  if (exactMatches.length === 1) {
    return {
      kind: "resolved",
      candidate: withMinimalLabel(exactMatches[0], directory),
      candidates: [],
    };
  }
  const preferredProjectLocalCandidate = await findPreferredProjectLocalCandidate(
    candidates,
    rawLabel,
    input.currentDirectory,
  );
  if (preferredProjectLocalCandidate) {
    return {
      kind: "resolved",
      candidate: withMinimalLabel(preferredProjectLocalCandidate, directory),
      candidates: [],
    };
  }
  if (exactMatches.length > 1) {
    return {
      kind: "ambiguous",
      candidate: null,
      candidates: withMinimalLabels(exactMatches, directory),
    };
  }

  const selector = parseAgentIdentity(
    rawLabel.startsWith("@") ? rawLabel : `@${rawLabel}`,
  );
  if (!selector) {
    return { kind: "unresolved", candidate: null, candidates: [] };
  }

  const diagnosis = diagnoseAgentIdentity(selector, directory.identityCandidates);

  if (diagnosis.kind === "resolved") {
    const match =
      candidates.find(
        (candidate) => candidate.agentId === diagnosis.match.agentId,
      ) ?? null;
    return {
      kind: match ? "resolved" : "unresolved",
      candidate: match ? withMinimalLabel(match, directory) : null,
      candidates: [],
    };
  }
  if (diagnosis.kind === "ambiguous") {
    const ambiguous = diagnosis.candidates
      .map((candidate) =>
        candidates.find((entry) => entry.agentId === candidate.agentId),
      )
      .filter((candidate): candidate is ScoutMcpAgentCandidate =>
        Boolean(candidate),
      );
    const preferredAmbiguousCandidate = await findPreferredProjectLocalCandidate(
      ambiguous,
      rawLabel,
      input.currentDirectory,
    );
    if (preferredAmbiguousCandidate) {
      return {
        kind: "resolved",
        candidate: withMinimalLabel(preferredAmbiguousCandidate, directory),
        candidates: [],
      };
    }
    return {
      kind: "ambiguous",
      candidate: null,
      candidates: withMinimalLabels(ambiguous, directory),
    };
  }

  return { kind: "unresolved", candidate: null, candidates: [] };
}

function defaultScoutMcpDependencies(
  env: NodeJS.ProcessEnv,
): ScoutMcpDependencies {
  return {
    submitFeedback: (feedback) => submitDiagnosticReport(feedback),
    resolveSenderId: (senderId, currentDirectory, scopedEnv) =>
      resolveScoutSenderId(senderId, currentDirectory, scopedEnv),
    resolveBrokerUrl: () =>
      env.OPENSCOUT_BROKER_URL?.trim() || resolveScoutBrokerUrl(),
    loadMessages: (input) => loadScoutMessages(input),
    readBrokerFeed: (input) => readScoutBrokerFeed(input),
    readTailEvents: (input) => readScoutTailEvents(input),
    searchAgents: ({ query, currentDirectory, limit }) =>
      searchScoutAgentsForMcp({ query, currentDirectory, limit }),
    resolveAgent: ({ label, currentDirectory }) =>
      resolveScoutAgentForMcp({ label, currentDirectory }),
    createAgentCard: ({
      projectPath,
      agentName,
      displayName,
      harness,
      model,
      provider,
      reasoningEffort,
      permissionProfile,
      currentDirectory,
      createdById,
      oneTimeUse,
      ttlMs,
    }) =>
      createScoutAgentCard({
        projectPath,
        agentName,
        displayName,
        harness,
        model,
        provider,
        reasoningEffort,
        permissionProfile,
        currentDirectory,
        createdById,
        oneTimeUse,
        ttlMs,
      }),
    startAgent: ({
      projectPath,
      agentName,
      harness,
      model,
      provider,
      reasoningEffort,
      permissionProfile,
      currentDirectory,
    }) =>
      upScoutAgent({
        projectPath,
        agentName,
        harness,
        model,
        provider,
        reasoningEffort,
        permissionProfile,
        currentDirectory,
      }),
    attachCurrentLocalSession: ({
      externalSessionId,
      transport,
      currentDirectory,
      projectRoot,
      agentId,
      alias,
      displayName,
      liveTerminal,
    }) =>
      attachScoutManagedLocalSession({
        externalSessionId,
        transport,
        currentDirectory,
        projectRoot,
        agentId,
        alias,
        displayName,
        liveTerminal,
      }),
    detectCurrentLiveTerminalSession: () => detectCurrentLiveTerminalSession(),
    sendMessage: ({
      requestId,
      senderId,
      body,
      targetLabel,
      channel,
      shouldSpeak,
      currentDirectory,
      source,
      wake,
      operatorSignal,
      aliasScope,
    }) =>
      sendScoutMessage({
        requestId,
        senderId,
        body,
        targetLabel,
        channel,
        shouldSpeak,
        currentDirectory,
        source,
        wake,
        operatorSignal,
        aliasScope,
      }),
    sendMessageToAgentIds: ({
      senderId,
      body,
      targetAgentIds,
      channel,
      shouldSpeak,
      currentDirectory,
      source,
    }) =>
      sendScoutMessageToAgentIds({
        senderId,
        body,
        targetAgentIds,
        channel,
        shouldSpeak,
        currentDirectory,
        source,
      }),
    replyMessage: ({
      requestId,
      completion,
      senderId,
      body,
      conversationId,
      replyToMessageId,
      shouldSpeak,
      attachments,
      currentDirectory,
      source,
    }) =>
      replyToScoutMessage({
        requestId,
        completion,
        senderId,
        body,
        conversationId,
        replyToMessageId,
        shouldSpeak,
        attachments,
        currentDirectory,
        source,
      }),
    scoutAskHandler: defaultScoutAskHandler,
    askQuestion: ({
      senderId,
      targetLabel,
      body,
      workItem,
      channel,
      shouldSpeak,
      labels,
      replyToSessionId,
      replyMode,
      currentDirectory,
      source,
      aliasScope,
    }) =>
      askScoutQuestion({
        senderId,
        targetLabel,
        body,
        workItem,
        channel,
        shouldSpeak,
        labels,
        replyToSessionId,
        replyMode,
        currentDirectory,
        source,
        aliasScope,
      }),
    askAgentById: ({
      senderId,
      targetAgentId,
      body,
      workItem,
      channel,
      shouldSpeak,
      labels,
      replyToSessionId,
      replyMode,
      currentDirectory,
      source,
    }) =>
      askScoutAgentById({
        senderId,
        targetAgentId,
        body,
        workItem,
        channel,
        shouldSpeak,
        labels,
        replyToSessionId,
        replyMode,
        currentDirectory,
        source,
      }),
    askSessionById: ({
      senderId,
      targetSessionId,
      body,
      workItem,
      channel,
      shouldSpeak,
      labels,
      replyToSessionId,
      replyMode,
      currentDirectory,
      source,
    }) =>
      askScoutSessionById({
        senderId,
        targetSessionId,
        body,
        workItem,
        channel,
        shouldSpeak,
        labels,
        replyToSessionId,
        replyMode,
        currentDirectory,
        source,
      }),
    updateWorkItem: (input) => updateScoutWorkItem(input),
    waitForFlight: (baseUrl, flightId, options) =>
      waitForScoutFlight(baseUrl, flightId, options),
    getFlight: (baseUrl, flightId) => loadScoutFlight(baseUrl, flightId),
    getInvocationLifecycle: (baseUrl, invocationId) =>
      loadScoutInvocationLifecycle(baseUrl, invocationId),
    readLabelBrief: (label, baseUrl) => readScoutLabelBrief(label, baseUrl),
    readLabelFeed: (label, baseUrl, options) =>
      readScoutLabelFeed(label, options, baseUrl),
    loadMeshOverview: (machine) => loadScoutMeshOverview(machine ? { machine } : {}),
  };
}

function resolveToolCurrentDirectory(
  currentDirectory: string | undefined,
  fallback: string,
): string {
  const trimmed = currentDirectory?.trim();
  return trimmed || fallback;
}

/**
 * Server instructions: the one Scout text every connected session reads on
 * its first turn, in every harness. Each line names what to reach for and
 * when; it is not a feature list. Keep it short — reach is the point.
 */
export const SCOUT_MCP_INSTRUCTIONS = [
  "Scout carries work between agents on this machine and on the operator's other mesh machines.",
  "- Another agent should do something: `ask` (owned work, returns a receipt). An FYI only: `messages_send`.",
  "- Work on another machine: `ask` with `on` (the machine, e.g. archie), `projectPath` (the folder on that machine) and `runtime` or `harness`. Scout starts a fresh session there and forwards the ask. Do not ssh in to launch an agent or copy briefs by hand.",
  "- Which machines exist, what they hold: `hosts_list` (live; each machine's projects and the exact ask for it). Don't know an agent's name: `agents_search`. Never invent names.",
  "- After an ask: the receipt is proof it was accepted; `invocations_wait` / `invocations_get` follow it, including work running on another machine.",
  "- The operator: `consult_operator` for a question or permission request, `notify_operator` for news.",
  "- When Scout cannot do what you need, say which call failed and how, instead of working around it silently.",
].join("\n");

export function createScoutMcpServer(options: {
  defaultCurrentDirectory: string;
  env?: NodeJS.ProcessEnv;
  dependencies?: Partial<ScoutMcpDependencies>;
  toolFilter?: (toolName: string) => boolean;
}): McpServer {
  const env = options.env ?? process.env;
  const deps: ScoutMcpDependencies = {
    ...defaultScoutMcpDependencies(env),
    ...options.dependencies,
  };

  const server = new McpServer({
    name: "openscout",
    version: SCOUT_APP_VERSION,
  }, {
    instructions: SCOUT_MCP_INSTRUCTIONS,
  });

  const notificationLifetime = new AbortController();
  notificationLifetimes.set(server, notificationLifetime.signal);
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    notificationLifetime.abort();
    previousOnClose?.();
  };

  // Tool exposure policy must gate registration itself, not a later
  // tools/list projection: an unregistered tool rejects tools/call too.
  const toolFilter = options.toolFilter;
  if (toolFilter) {
    const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    server.registerTool = ((name: string, ...rest: unknown[]) => {
      if (!toolFilter(name)) return undefined;
      return registerTool(name, ...rest);
    }) as typeof server.registerTool;
  }

  registerRoutingTools(server, routingToolDependencies(deps.resolveBrokerUrl()));
  registerRouteContext(server, routeContextDependencies({ brokerUrl: deps.resolveBrokerUrl() }),
    !toolFilter || (toolFilter("route_context") && toolFilter("ask")));
  registerSessionDiscoveryTools(server, sessionDiscoveryDependencies(resolveScoutWebOrigin(env), { env }));
  registerHerdrWorkspaceTools(server, herdrWorkspacesDependencies(resolveScoutWebOrigin(env), { env }));
  registerSessionSendTool(server, sessionSendDependencies(env));
  registerAttachmentReaderTool(server, {
    currentContext: () => parseScoutReplyContextFromEnv(env),
    message: async (id) => (await loadScoutBrokerContext(deps.resolveBrokerUrl()))?.snapshot.messages?.[id] ?? null,
    webOrigin: resolveScoutWebOrigin(env),
    env,
  });

  const aliasBrokerRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(new URL(path, deps.resolveBrokerUrl()), {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
    if (!response.ok) throw new Error(payload.detail ?? payload.error ?? `broker returned HTTP ${response.status}`);
    return payload;
  };

  registerIntegrationTools(server, aliasBrokerRequest);

  registerChatListeningTools(server, (operation, body) => chatListeningRequest(
    { env },
    operation, body,
  ));

  const aliasToolCaller = async (senderId: string | undefined, currentDirectory: string) => ({
    actorId: await resolveMcpSenderId(deps, senderId, currentDirectory, env),
    currentDirectory,
    metadata: {
      ...((env.OPENSCOUT_SESSION_ID?.trim() || env.CODEX_THREAD_ID?.trim() || env.CLAUDE_CODE_SESSION_ID?.trim())
        ? { sessionId: env.OPENSCOUT_SESSION_ID?.trim() || env.CODEX_THREAD_ID?.trim() || env.CLAUDE_CODE_SESSION_ID?.trim() }
        : {}),
    },
  });

  const EXTERNAL_SESSION_TOOL_TITLES = {
    attach: "Attach External Session",
    get: "Get External Session",
    poll: "Poll External Session",
    ack: "Acknowledge External Session Item",
    reply: "Reply to External Session Item",
  } as const;

  // The hosted bridge pins resolveSenderId to the authenticated OAuth identity.
  // Never accept ownerId, API credentials, provider URLs or agentId from this tool.
  for (const operation of ["attach", "get", "poll", "ack", "reply"] as const) {
    server.registerTool(`sessions_${operation}`, {
      title: EXTERNAL_SESSION_TOOL_TITLES[operation],
      description: operation === "attach"
        ? "Attach your existing conversation to an isolated MCP mailbox (default, no extra credentials). Returns sessionId for exact asks and replyToSessionId. Optional connectionId selects an operator-configured provider API instead. Native identity is caller-asserted for polling; this never starts or wakes a host."
        : operation === "poll" ? "Read this session mailbox with bounded pagination. Polling does not execute work or wake a host. Work remains listed until replied; never re-execute acknowledged work. Restart pagination without a cursor on each polling cycle."
        : operation === "ack" ? "Acknowledge receipt of a mailbox item. This does not complete work; use sessions_reply for the final answer. Acknowledged result notifications leave the mailbox."
        : operation === "reply"
        ? "Reply to the exact Scout delivery address supplied with your task. Completes its original flight; retries with the same body are idempotent."
        : "Inspect your attached external session and return transport.",
      inputSchema: z.object(operation === "attach"
        ? { connectionId: z.string().min(1).optional(), nativeSessionId: z.string().min(1).max(512) }
        : operation === "get" ? { sessionId: z.string().min(1) }
        : operation === "poll" ? { sessionId: z.string().min(1), cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(50).optional() }
        : operation === "ack" ? { sessionId: z.string().min(1), deliveryId: z.string().min(1) }
        : { sessionId: z.string().min(1), deliveryId: z.string().min(1), replyToken: z.string().min(1).max(256).optional(), body: z.string().min(1).max(100_000) }),
      annotations: { readOnlyHint: operation === "get" || operation === "poll", idempotentHint: true, destructiveHint: false, openWorldHint: operation === "attach" },
    }, async (input) => {
      const ownerId = await resolveMcpSenderId(deps, undefined, options.defaultCurrentDirectory, env);
      const result = await aliasBrokerRequest(`/v1/external-sessions/${operation}`, { method: "POST", body: JSON.stringify({ ...input, ownerId }) });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  }

  const aliasScopeSchema = {
    projectRoot: z.string().optional(),
    nodeId: z.string().optional(),
    currentDirectory: z.string().optional(),
    senderId: z.string().optional(),
  };

  server.registerTool(
    "aliases_set",
    {
      title: "Set Scout Route Alias",
      description: "Create a scoped broker-owned pointer to one existing durable agent or exact session. This never creates or mutates an agent card.",
      inputSchema: z.object({
        alias: scoutAgentNameInputSchema,
        to: z.string().optional(),
        self: z.enum(["session", "agent"]).optional(),
        replace: z.boolean().optional(),
        expectedRevision: z.number().int().positive().optional(),
        expiresAt: z.number().int().positive().optional(),
        ...aliasScopeSchema,
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const currentDirectory = resolveToolCurrentDirectory(input.currentDirectory, options.defaultCurrentDirectory);
      const target = input.to ? parseScoutComposerRouteTarget(input.to) : undefined;
      if (input.to && !target) throw new Error(`invalid route target: ${input.to}`);
      const result = await aliasBrokerRequest<{ binding: RouteAliasBinding }>("/v1/aliases", {
        method: "POST",
        body: JSON.stringify({
          alias: input.alias,
          target,
          self: input.self,
          replace: input.replace,
          expectedRevision: input.expectedRevision,
          expiresAt: input.expiresAt,
          scope: { projectRoot: input.projectRoot, nodeId: input.nodeId },
          caller: await aliasToolCaller(input.senderId, currentDirectory),
        }),
      });
      return { content: createTextContent(result), structuredContent: { ...result } };
    },
  );

  server.registerTool(
    "aliases_list",
    {
      title: "List Scout Route Aliases",
      description: "List scoped route pointers without adding them to the configured-agent roster.",
      inputSchema: z.object({
        includeInactive: z.boolean().optional(),
        targetAgentId: z.string().optional(),
        targetSessionId: z.string().optional(),
        ...aliasScopeSchema,
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const currentDirectory = resolveToolCurrentDirectory(input.currentDirectory, options.defaultCurrentDirectory);
      const params = new URLSearchParams({ currentDirectory });
      if (input.projectRoot) params.set("projectRoot", input.projectRoot);
      if (input.nodeId) params.set("nodeId", input.nodeId);
      if (input.includeInactive) params.set("includeInactive", "true");
      if (input.targetAgentId) params.set("targetAgentId", input.targetAgentId);
      if (input.targetSessionId) params.set("targetSessionId", input.targetSessionId);
      const result = await aliasBrokerRequest<{ bindings: RouteAliasBinding[] }>(`/v1/aliases?${params}`);
      return { content: createTextContent(result), structuredContent: result };
    },
  );

  server.registerTool(
    "aliases_resolve",
    {
      title: "Resolve Scout Route Alias",
      description: "Resolve one alias without waking or delivering, returning the pinned target/revision proof and separate availability state.",
      inputSchema: z.object({ alias: z.string().min(1), bindingId: z.string().optional(), ...aliasScopeSchema }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const currentDirectory = resolveToolCurrentDirectory(input.currentDirectory, options.defaultCurrentDirectory);
      const result = await aliasBrokerRequest<RouteAliasResolveResult>("/v1/aliases/resolve", {
        method: "POST",
        body: JSON.stringify({
          alias: input.alias,
          bindingId: input.bindingId,
          scope: { projectRoot: input.projectRoot, nodeId: input.nodeId },
          caller: await aliasToolCaller(input.senderId, currentDirectory),
        }),
      });
      return { content: createTextContent(result), structuredContent: { ...result } };
    },
  );

  const registerAliasMutationTool = (
    name: "aliases_repoint" | "aliases_unset",
    description: string,
  ): void => {
    server.registerTool(
      name,
      {
        title: name === "aliases_repoint" ? "Repoint Scout Route Alias" : "Unset Scout Route Alias",
        description,
        inputSchema: z.object({
          alias: z.string().min(1),
          bindingId: z.string().optional(),
          to: z.string().optional(),
          expectedRevision: z.number().int().positive().optional(),
          ...aliasScopeSchema,
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: name === "aliases_unset", openWorldHint: false },
      },
      async (input) => {
        const currentDirectory = resolveToolCurrentDirectory(input.currentDirectory, options.defaultCurrentDirectory);
        let bindingId = input.bindingId;
        if (!bindingId) {
          const resolved = await aliasBrokerRequest<RouteAliasResolveResult>("/v1/aliases/resolve", {
            method: "POST",
            body: JSON.stringify({
              alias: input.alias,
              scope: { projectRoot: input.projectRoot, nodeId: input.nodeId },
              caller: await aliasToolCaller(input.senderId, currentDirectory),
            }),
          });
          bindingId = resolved.binding?.id;
        }
        if (!bindingId) throw new Error(`unknown alias ${input.alias}`);
        const target = input.to ? parseScoutComposerRouteTarget(input.to) : undefined;
        if (name === "aliases_repoint" && !target) throw new Error("aliases_repoint requires to");
        const result = await aliasBrokerRequest<{ binding: RouteAliasBinding }>(`/v1/aliases/${encodeURIComponent(bindingId)}`, {
          method: name === "aliases_repoint" ? "PATCH" : "DELETE",
          body: JSON.stringify({
            target,
            expectedRevision: input.expectedRevision,
            scope: { projectRoot: input.projectRoot, nodeId: input.nodeId },
            caller: await aliasToolCaller(input.senderId, currentDirectory),
          }),
        });
        return { content: createTextContent(result), structuredContent: result };
      },
    );
  };

  registerAliasMutationTool("aliases_repoint", "Atomically move an existing alias binding to another canonical agent/session target and increment its revision.");
  registerAliasMutationTool("aliases_unset", "Soft-revoke an alias for future dispatch while retaining authorized revision history.");

  server.registerTool(
    "whoami",
    {
      title: "Scout Whoami",
      description:
        "Inspect the default Scout sender identity and broker URL for a working directory. Use this when host or workspace context is unclear; direct ask and messages_send calls can route without a whoami preflight.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
      }),
      outputSchema: whoAmISchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, senderId }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const defaultSenderId = await resolveMcpSenderId(
        deps,
        senderId,
        resolvedCurrentDirectory,
        env,
      );
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        brokerUrl: deps.resolveBrokerUrl(),
        defaultSenderId,
      };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "hosts_list",
    {
      title: "Scout Mesh Hosts",
      description:
        "List the operator's machines, read live: whether each answers, what it is doing, the projects it holds (absolute paths to pass as projectPath), and the ask that starts work there. Use before `ask` with `on` when you need a machine name or a folder on it. A machine that does not answer comes back with the reason, not as idle.",
      inputSchema: z.object({
        host: z.string().optional().describe("One machine (name or node id); omit for all."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ host }) => {
      const load = deps.loadMeshOverview ?? ((machine?: string) => loadScoutMeshOverview(machine ? { machine } : {}));
      const overview = await load(host?.trim() || undefined);
      return {
        content: [{ type: "text" as const, text: renderScoutMeshOverviewLines(overview, { projectsPerMachine: host ? 64 : 8, roots: true }).join("\n") }],
        structuredContent: overview as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "feedback_send",
    {
      title: "Send Scout Feedback",
      description:
        "File feedback about Scout itself with the OpenScout team: a bug, a rough edge, a missing capability. The note is redacted, saved locally, then uploaded; the report names the sender (agent, harness, project, host). Set diagnostics only when the note is about Scout misbehaving on this machine — it attaches bounded, redacted service logs. This is not a message to another agent; use messages_send or ask for that.",
      inputSchema: z.object({
        note: z.string().trim().min(1).max(8000),
        diagnostics: z.boolean().optional(),
        localOnly: z.boolean().optional(),
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        status: z.enum(["uploaded", "saved"]),
        localPath: z.string(),
        error: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ note, diagnostics, localOnly, currentDirectory, senderId }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      // Naming the sender is best effort: feedback must still file when the
      // broker is down, which is often exactly what the note is about.
      const agentId = await resolveMcpSenderId(deps, senderId, resolvedCurrentDirectory, env)
        .catch(() => env.OPENSCOUT_AGENT?.trim() || undefined);
      const projectRoot = await findNearestProjectRoot(resolvedCurrentDirectory).catch(() => null);
      const receipt = await deps.submitFeedback({
        message: note,
        diagnostics: diagnostics ?? false,
        localOnly: localOnly ?? false,
        version: SCOUT_APP_VERSION,
        client: "mcp",
        reporter: {
          agentId,
          harness: reporterHarness(env),
          project: basename(projectRoot ?? resolvedCurrentDirectory),
          host: hostname(),
        },
      });
      const structuredContent = { ...receipt };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "messages_inbox",
    {
      title: "Read Scout Inbox",
      description:
        "Read recent direct or addressed Scout broker messages for the current sender identity. Use this instead of curling broker HTTP endpoints when an MCP host needs its latest messages.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        since: z.number().optional(),
      }),
      outputSchema: messagesInboxResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, senderId, limit, since }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const resolvedSenderId = await resolveMcpSenderId(
        deps,
        senderId,
        resolvedCurrentDirectory,
        env,
      );
      const brokerUrl = deps.resolveBrokerUrl();
      const resolvedLimit = limit ?? 20;
      const messages = await deps.loadMessages({
        participantId: resolvedSenderId,
        inboxOnly: true,
        since,
        limit: resolvedLimit,
        baseUrl: brokerUrl,
      });
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        brokerUrl,
        senderId: resolvedSenderId,
        limit: resolvedLimit,
        since: since ?? null,
        messages,
      };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "messages_channel",
    {
      title: "Read Scout Channel",
      description:
        "Read recent Scout broker messages from a named channel. Use this instead of curling broker HTTP endpoints when an MCP host needs channel history.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        channel: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        since: z.number().optional(),
      }),
      outputSchema: messagesChannelResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, channel, limit, since }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const brokerUrl = deps.resolveBrokerUrl();
      const resolvedChannel = channel?.trim() || "shared";
      const resolvedLimit = limit ?? 20;
      const messages = await deps.loadMessages({
        channel: resolvedChannel,
        since,
        limit: resolvedLimit,
        baseUrl: brokerUrl,
      });
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        brokerUrl,
        channel: resolvedChannel,
        limit: resolvedLimit,
        since: since ?? null,
        messages,
      };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "broker_feed",
    {
      title: "Read Agent Broker Feed",
      description:
        "Fetch a native broker view of messages, status, delivery, dispatch, unblock, and error records for one agent. Use this instead of stitching together messages, flights, deliveries, and broker errors by hand.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
        agentId: z.string().optional(),
        since: z.number().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        includeAcknowledged: z.boolean().optional(),
      }),
      outputSchema: brokerFeedSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, senderId, agentId, since, limit, includeAcknowledged }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const resolvedAgentId = agentId?.trim()
        || await resolveMcpSenderId(
          deps,
          senderId,
          resolvedCurrentDirectory,
          env,
        );
      const brokerUrl = deps.resolveBrokerUrl();
      const resolvedLimit = limit ?? 80;
      const feed = await deps.readBrokerFeed({
        agentId: resolvedAgentId,
        since: since ?? null,
        limit: resolvedLimit,
        includeAcknowledged: includeAcknowledged ?? false,
        baseUrl: brokerUrl,
      });
      if (!feed) {
        const empty = {
          currentDirectory: resolvedCurrentDirectory,
          brokerUrl,
          found: false,
          agentId: resolvedAgentId,
          generatedAt: Date.now(),
          since: since ?? null,
          limit: resolvedLimit,
          cursor: null,
          status: {
            agentId: resolvedAgentId,
            found: false,
            endpoints: [],
            activeFlightIds: [],
            pendingDeliveryIds: [],
            errorCount: 0,
            warningCount: 0,
          },
          counts: {
            items: 0,
            messages: 0,
            statuses: 0,
            invocations: 0,
            flights: 0,
            deliveries: 0,
            deliveryAttempts: 0,
            dispatches: 0,
            errors: 0,
            warnings: 0,
          },
          items: [],
        };
        return {
          content: createPlainTextContent(`Scout broker is not reachable; broker feed for ${resolvedAgentId} is unavailable.`),
          structuredContent: empty,
        };
      }
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        brokerUrl,
        found: feed.status.found,
        ...feed,
      };
      return {
        content: createPlainTextContent(renderMcpBrokerFeedSummary(structuredContent)),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "tail_events",
    {
      title: "Read Tail Events",
      description:
        "Read recent observed harness events from the broker tail firehose. Use this for local situational awareness about Claude, Codex, and other native harness activity without importing harness transcripts as Scout messages.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        sources: z.array(z.string()).optional(),
        kinds: z.array(z.enum(TAIL_EVENT_KIND_VALUES)).optional(),
        sessionId: z.string().optional(),
        project: z.string().optional(),
        cwd: z.string().optional(),
        query: z.string().optional(),
        transcripts: z.boolean().optional(),
      }),
      outputSchema: tailEventsResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      currentDirectory,
      limit,
      sources,
      kinds,
      sessionId,
      project,
      cwd,
      query,
      transcripts,
    }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const brokerUrl = deps.resolveBrokerUrl();
      const resolvedLimit = limit ?? 80;
      const result = await deps.readTailEvents({
        limit: resolvedLimit,
        sources,
        kinds,
        sessionId: sessionId?.trim() || undefined,
        project: project?.trim() || undefined,
        cwd: cwd?.trim() || undefined,
        query: query?.trim() || undefined,
        transcripts: transcripts ?? false,
        baseUrl: brokerUrl,
      });
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        brokerUrl,
        generatedAt: result.generatedAt,
        limit: result.limit,
        cursor: result.cursor,
        filters: {
          sources: sources ?? [],
          kinds: kinds ?? [],
          sessionId: sessionId?.trim() || null,
          project: project?.trim() || null,
          cwd: cwd?.trim() || null,
          query: query?.trim() || null,
          transcripts: transcripts ?? false,
        },
        counts: {
          events: result.events.length,
          sources: new Set(result.events.map((event) => event.source)).size,
          sessions: new Set(result.events.map((event) => event.sessionId)).size,
        },
        events: result.events,
      };
      return {
        content: createPlainTextContent(renderMcpTailEventsSummary(structuredContent)),
        structuredContent,
      };
    },
  );



  server.registerTool(
    "current_reply_context",
    {
      title: "Current Scout Reply Context",
      description:
        "Inspect whether this MCP host has an active Scout broker reply context. Use this to distinguish replying to an inbound Scout ask from sending a new message.",
      inputSchema: z.object({}),
      outputSchema: currentReplyContextResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      let context = parseScoutReplyContextFromEnv(env);
      if (context?.completion) {
        const identity = completionIdentitySchema.safeParse(context.completion);
        if (!identity.success) throw new Error("Current explicit completion context has invalid identity.");
        const flight = await deps.getFlight(deps.resolveBrokerUrl(), identity.data.flightId);
        const completion = flightCompletion(flight);
        if (!flight || !completion || flight.invocationId !== identity.data.invocationId
          || flight.targetAgentId !== context.toAgentId
          || ["completed", "failed", "cancelled"].includes(flight.state)) {
          throw new Error("Current explicit completion flight is unavailable or terminal; refresh the reply context before replying.");
        }
        context = { ...context, completion: { ...identity.data, revision: completion.revision } };
      }
      const structuredContent = {
        active: Boolean(context),
        context,
      };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "messages_reply",
    {
      title: "Reply to Scout Message",
      description:
        "Reply in an existing Scout conversation/thread. Replies with completion report explicit progress or final completion for a flight; refresh current_reply_context first and supply a stable requestId. A final is rejected while joined work is pending; submit a new final after it settles. Other replies are normal threaded conversation messages. If conversationId and replyToMessageId are omitted, this uses the current ScoutReplyContext. If there is no active context, use messages_send for a new message or ask for a new request.",
      inputSchema: z.object({
        requestId: z.string().min(1).max(256).optional(),
        completion: completionReplySchema.optional(),
        body: z.string().min(1),
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
        conversationId: z.string().optional(),
        replyToMessageId: z.string().optional(),
        shouldSpeak: z.boolean().optional(),
        attachments: attachmentsInputSchema,
      }),
      outputSchema: replyResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      requestId,
      completion,
      body,
      currentDirectory,
      senderId,
      conversationId,
      replyToMessageId,
      shouldSpeak,
      attachments,
    }) => {
      if (completion && !requestId?.trim()) {
        throw new Error("Explicit completion replies require a stable requestId; reuse it when retrying.");
      }
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const context = parseScoutReplyContextFromEnv(env);
      const resolvedConversationId = conversationId?.trim() || context?.conversationId || "";
      const resolvedReplyToMessageId = replyToMessageId?.trim() || context?.replyToMessageId || "";
      const resolvedSenderId = await resolveMcpSenderId(
        deps,
        senderId ?? context?.toAgentId,
        resolvedCurrentDirectory,
        env,
      );

      if (!resolvedConversationId || !resolvedReplyToMessageId) {
        const structuredContent = {
          currentDirectory: resolvedCurrentDirectory,
          senderId: resolvedSenderId,
          usedBroker: true,
          conversationId: resolvedConversationId || null,
          messageId: null,
          replyToMessageId: resolvedReplyToMessageId || null,
          notifiedActorIds: [],
          routingError: "missing_reply_context" as const,
        };
        return {
          content: createPlainTextContent(
            "No active Scout broker reply context. Use messages_send for a new message, use ask for a new request, or pass conversationId and replyToMessageId explicitly.",
          ),
          structuredContent,
        };
      }

      const result = await deps.replyMessage({
        ...(requestId ? { requestId } : {}),
        ...(completion ? { completion } : {}),
        senderId: resolvedSenderId,
        body,
        conversationId: resolvedConversationId,
        replyToMessageId: resolvedReplyToMessageId,
        shouldSpeak,
        attachments,
        currentDirectory: resolvedCurrentDirectory,
        source: "scout-mcp",
      });
      if (completion && (!result.usedBroker || !result.messageId || result.routingError)) {
        throw new Error(`Explicit completion reply was not accepted: ${result.routingError ?? "canonical broker receipt unavailable"}; retry with the same requestId.`);
      }
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        senderId: resolvedSenderId,
        usedBroker: result.usedBroker,
        conversationId: result.conversationId ?? resolvedConversationId,
        messageId: result.messageId ?? null,
        replyToMessageId: result.replyToMessageId ?? resolvedReplyToMessageId,
        notifiedActorIds: result.notifiedActorIds,
        routingError: result.routingError ?? null,
      };
      return {
        content: createPlainTextContent(
          result.routingError
            ? `Reply was not sent: ${result.routingError}.`
            : `Reply sent in ${structuredContent.conversationId}${structuredContent.messageId ? ` (${structuredContent.messageId})` : ""}.`,
        ),
        structuredContent,
      };
    },
  );


  server.registerTool(
    "session_attach_current",
    {
      title: "Attach Current Session",
      description:
        "Give the current live harness session a Scout address so other agents' messages and asks land in this same process. Codex attaches by CODEX_THREAD_ID. Claude, Grok and other TUIs attach when they run in a tmux pane or a Ghostty terminal: asks are typed into that surface (without changing focus) and Scout never starts a replacement beside it. In any other terminal the call refuses and says why instead of creating a spawn-on-demand card.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        projectPath: z.string().optional(),
        agentId: z.string().optional(),
        alias: z.string().optional(),
        displayName: z.string().optional(),
      }),
      outputSchema: currentSessionAttachResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, projectPath, agentId, alias, displayName }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const common = {
        currentDirectory: resolvedCurrentDirectory,
        projectRoot: projectPath?.trim() ? resolve(projectPath.trim()) : undefined,
        agentId: agentId?.trim() || undefined,
        alias: alias?.trim() || undefined,
        displayName: displayName?.trim() || undefined,
      };
      if (env.CODEX_THREAD_ID?.trim()) {
        const externalSessionId = resolveCurrentCodexThreadId(env);
        const attached = await deps.attachCurrentLocalSession({
          ...common,
          externalSessionId,
          transport: "codex_app_server",
        });
        const structuredContent = {
          currentDirectory: resolvedCurrentDirectory,
          externalSessionId,
          transport: "codex_app_server" as const,
          agentId: attached.agentId,
          selector: attached.selector ?? null,
          endpointId: attached.endpointId,
          sessionId: attached.sessionId,
        };
        return {
          content: createPlainTextContent(
            `Current Codex session attached as ${attached.selector ?? attached.agentId}.`,
          ),
          structuredContent,
        };
      }

      const detection = await deps.detectCurrentLiveTerminalSession();
      if (!detection.ok) {
        throw new Error(
          `This session cannot be attached: ${detection.detail}`
            + (detection.reason === "no_surface"
              ? " Run the harness inside tmux or Ghostty to make it reachable in place."
              : ""),
        );
      }
      const live = detection.session;
      const surfaceLabel = live.surface.backend === "tmux"
        ? `tmux pane ${live.surface.pane} (${live.surface.session})`
        : `Ghostty terminal ${live.surface.terminalId}`;
      const attached = await deps.attachCurrentLocalSession({
        ...common,
        externalSessionId: live.nativeSessionId ?? "",
        transport: live.surface.backend,
        liveTerminal: live,
      });
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        externalSessionId: live.nativeSessionId ?? "",
        transport: live.surface.backend,
        harness: live.harness,
        surface: surfaceLabel,
        agentId: attached.agentId,
        selector: attached.selector ?? null,
        endpointId: attached.endpointId,
        sessionId: attached.sessionId,
      };
      return {
        content: createPlainTextContent(
          `Current ${live.harness} session attached as ${attached.selector ?? attached.agentId}; `
            + `asks are typed into ${surfaceLabel}.`,
        ),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "card_create",
    {
      title: "Create Scout Agent Card",
      description:
        "Create a Scout agent card with a reply-ready return address. Agent-created cards default to one-time use so short-lived review/probe identities do not crowd the system; pass oneTimeUse=false for a persistent card. One target stays private by default; group coordination still requires an explicit channel elsewhere.",
      inputSchema: z.object({
        projectPath: z.string().optional(),
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
        agentName: scoutAgentNameInputSchema.optional(),
        displayName: z.string().optional(),
        harness: z.enum(LOCAL_AGENT_HARNESS_VALUES).optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        reasoningEffort: z.string().optional(),
        permissionProfile: z.string().optional(),
        oneTimeUse: z.boolean().optional(),
        ttlSeconds: z.number().positive().optional(),
      }),
      outputSchema: cardCreateResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      projectPath,
      currentDirectory,
      senderId,
      agentName,
      displayName,
      harness,
      model,
      provider,
      reasoningEffort,
      permissionProfile,
      oneTimeUse,
      ttlSeconds,
    }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const resolvedSenderId = await resolveMcpSenderId(
        deps,
        senderId,
        resolvedCurrentDirectory,
        env,
      );
      const card = await deps.createAgentCard({
        projectPath: resolve(projectPath?.trim() || resolvedCurrentDirectory),
        agentName: agentName?.trim() || undefined,
        displayName: displayName?.trim() || undefined,
        harness,
        model: model?.trim() || undefined,
        provider: provider?.trim() || undefined,
        reasoningEffort: reasoningEffort?.trim() || undefined,
        permissionProfile: permissionProfile?.trim() || undefined,
        currentDirectory: resolvedCurrentDirectory,
        createdById: resolvedSenderId,
        oneTimeUse: oneTimeUse ?? true,
        ttlMs: ttlSeconds === undefined ? undefined : Math.round(ttlSeconds * 1000),
      });
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        senderId: resolvedSenderId,
        card,
      };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "agents_start",
    {
      title: "Start Scout Agent",
      description:
        "Start or create a concrete local Scout agent session before routing work to it. Use this when the user asks for a new session, or when a precise label such as @openscout#claude is unresolved. For agent-to-agent work, retry with ask after the session exists.",
      inputSchema: z.object({
        targetLabel: z
          .string()
          .describe(
            "Optional desired Scout label, such as @openscout#claude?sonnet. Explicit fields override values inferred from this label.",
          )
          .optional(),
        agentName: scoutAgentNameInputSchema.optional(),
        projectPath: z.string().optional(),
        currentDirectory: z.string().optional(),
        harness: z.enum(LOCAL_AGENT_HARNESS_VALUES).optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        reasoningEffort: z.string().optional(),
        permissionProfile: z.string().optional(),
      }),
      outputSchema: agentStartResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      targetLabel,
      agentName,
      projectPath,
      currentDirectory,
      harness,
      model,
      provider,
      reasoningEffort,
      permissionProfile,
    }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const parsedLabel = parseStartTargetLabel(targetLabel);
      const resolvedAgentName =
        agentName?.trim() || parsedLabel.agentName || undefined;
      const resolvedHarness = harness ?? parsedLabel.harness ?? undefined;
      const resolvedModel = model?.trim() || parsedLabel.model || undefined;
      const resolvedProjectPath = resolve(
        projectPath?.trim() || resolvedCurrentDirectory,
      );
      const agent = await deps.startAgent({
        projectPath: resolvedProjectPath,
        agentName: resolvedAgentName,
        harness: resolvedHarness,
        model: resolvedModel,
        provider: provider?.trim() || undefined,
        reasoningEffort: reasoningEffort?.trim() || undefined,
        permissionProfile: permissionProfile?.trim() || undefined,
        currentDirectory: resolvedCurrentDirectory,
      });
      const nextTargetLabel = resolvedModel
        ? `@${agent.definitionId}#${agent.harness}?${resolvedModel}`
        : `@${agent.definitionId}#${agent.harness}`;
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        requestedLabel: targetLabel?.trim() || null,
        agentName: resolvedAgentName ?? null,
        projectPath: resolvedProjectPath,
        harness: resolvedHarness ?? null,
        model: resolvedModel ?? null,
        provider: provider?.trim() || null,
        agent,
        exactTargetAgentId: agent.agentId,
        nextTargetLabel,
      };
      return {
        content: createPlainTextContent(
          `Started ${agent.agentId} (${agent.harness}) for ${agent.projectRoot}. Use exactTargetAgentId="${agent.agentId}" for the next route.`,
        ),
        structuredContent,
      };
    },
  );

  /** The mesh machine a search query names, read live; undefined when it names none. */
  async function machineForQuery(query: string): Promise<ScoutMeshMachine | undefined> {
    const host = query.replace(/^@/, "").trim();
    if (!host || /\s/.test(host)) return undefined;
    const load = deps.loadMeshOverview ?? ((machine?: string) => loadScoutMeshOverview(machine ? { machine } : {}));
    try {
      const overview = await load(host);
      return overview.machines.length === 1 ? overview.machines[0] : undefined;
    } catch {
      // Not a machine name, or the broker could not list machines: the agent
      // search above still answers on its own.
      return undefined;
    }
  }

  server.registerTool(
    "agents_search",
    {
      title: "Search Scout Agents",
      description:
        "Search the live Scout broker and discovered agent inventory for routing candidates. Use this when the target is unknown or ambiguous, not as a required preflight for every send. When the query names a machine (e.g. archie), the result also says whether that machine answers, its projects, and the `ask` with `on` that starts fresh work there; offline agent cards do not mean the machine is down.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Partial handle, label, or display name to search for")
          .optional(),
        currentDirectory: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      outputSchema: searchResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: createToolUiMeta(),
    },
    async ({ query, currentDirectory, limit }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const trimmedQuery = query?.trim() ?? "";
      const [candidates, machine] = await Promise.all([
        deps.searchAgents({
          query,
          currentDirectory: resolvedCurrentDirectory,
          limit,
        }),
        machineForQuery(trimmedQuery),
      ]);
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        query: trimmedQuery,
        candidates,
        ...(machine ? { machine: machine as unknown as Record<string, unknown> } : {}),
      };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "agents_resolve",
    {
      title: "Resolve Scout Agent",
      description:
        "Resolve one exact Scout agent handle or return ambiguity details. Use this when a short handle may be ambiguous; explicit target sends can let the broker resolve in one call.",
      inputSchema: z.object({
        label: z
          .string()
          .min(1)
          .describe("Scout agent handle or selector, such as @talkie. Use harness/model/profile qualifiers only when you need a specific instance."),
        currentDirectory: z.string().optional(),
      }),
      outputSchema: resolveResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: createToolUiMeta(),
    },
    async ({ label, currentDirectory }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const resolution = await deps.resolveAgent({
        label,
        currentDirectory: resolvedCurrentDirectory,
      });
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        label,
        kind: resolution.kind,
        candidate: resolution.candidate,
        candidates: resolution.candidates,
      };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "ask",
    {
      title: "Ask",
      description:
        "Ask another agent to answer, review, try, build, compare, or give feedback — on this machine or on another mesh machine. To start work on another machine, pass `on` (the machine, e.g. archie) with `projectPath` as the folder on that machine, plus harness/runtime; Scout starts a fresh session there and forwards the ask, so never ssh in to launch an agent yourself. Exact runtime requests accept `runtime` as harness/model/effort (for example codex/gpt-5.6-sol/xhigh), or separate harness/model/reasoningEffort fields. A profile is a base preset and explicit dimensions override it when legal. Exact runtime requests create a fresh isolated session; targetSessionId fails closed unless the selected session's observed runtime matches. Ask may create message, invocation, flight, delivery, and work records as side effects; use invocations_get/invocations_wait and the execution-resolution receipt to verify requested, resolved, and observed values.",
      inputSchema: z.object({
        completion: completionRequestSchema.optional().describe("Require an explicit final reply; exact local id or session targets only, with a stable requestId."),
        relation: completionRelationSchema.optional().describe("Join child work or continue a parent flight; requires a stable requestId."),
        requestId: z.string().min(1).max(256).optional().describe("Requester-scoped idempotency key; reuse on retries."),
        to: z
          .string()
          .min(1)
          .optional()
          .describe("Agent id, label, sibling, specialist, recent collaborator, target:<name>, or ⌖name."),
        targetSessionId: targetSessionIdInputSchema,
        projectPath: projectPathInputSchema,
        on: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Mesh machine to start the session on (e.g. archie). Requires projectPath, read as a path on that machine (sent as typed, `~` expands there). Starts a fresh session; list machines with whoami or `scout machines`.",
          ),
        aliasProject: z.string().optional().describe("Explicit project root for a to=alias:<name> target."),
        aliasHost: z.string().optional().describe("Explicit authority node id/name for a to=alias:<name> target."),
        body: z.string().min(1),
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
        replyToSessionId: z
          .string()
          .optional()
          .describe(
            "Optional requester session that should receive the eventual reply. When omitted, Codex MCP uses the current CODEX_THREAD_ID when available.",
          ),
        labels: z.array(z.string()).optional(),
        workItem: workItemInputSchema.optional(),
        channel: z.string().optional(),
        shouldSpeak: z.boolean().optional(),
        replyMode: z
          .enum(REPLY_MODE_VALUES)
          .describe(
            "Reply delivery mode (default 'notify'): 'notify' returns durable ids quickly and emits notifications/scout/reply when OPENSCOUT_MCP_ENABLE_NOTIFICATIONS=1 (always on for the hosted bridge), 'inline' waits briefly, and 'none' returns durable ids only.",
          )
          .optional(),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Caller wait budget in seconds for inline waits only; it never cancels or fails the broker ask."),
        runtime: z
          .string()
          .optional()
          .describe("Shell-safe RuntimeSpec: harness[/model[/effort]], such as codex/gpt-5.6-sol/xhigh."),
        profile: z
          .enum(SCOUT_RESERVED_RUNTIME_PROFILE_IDS)
          .optional()
          .describe("Runtime preset base. Explicit harness/model/reasoningEffort fields may override compatible dimensions."),
        harness: z.enum(LOCAL_AGENT_HARNESS_VALUES).optional(),
        model: z.string().min(1).optional(),
        reasoningEffort: z.enum(SCOUT_REASONING_EFFORTS).optional(),
        placement: z
          .enum(["background", "foreground", "attached"])
          .optional()
          .describe(
            "Where a newly created harness session lives. Background is Scout-managed (default); foreground is openable in the operator's native harness UI. Codex supports foreground. Attached means a terminal-backed session; an existing session must already match the requested placement.",
          ),
        workspace: z.enum(["same", "new_worktree"]).optional(),
        session: z
          .enum(["reuse", "new"])
          .optional()
          .describe("Compatibility hint. Agent-card targets are always fresh-session requests; use targetSessionId to continue exact prior context."),
        wait: z
          .boolean()
          .optional()
          .describe("Compatibility alias for replyMode='inline'."),
      }),
      outputSchema: askReceiptSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: createToolUiMeta({
        to: createAgentPickerFieldMeta({
          selection: "single",
          valueField: "label",
          resolveTool: "agents_resolve",
        }),
      }),
    },
    async ({
      requestId,
      completion,
      relation,
      to,
      targetSessionId,
      projectPath,
      on: onHost,
      aliasProject,
      aliasHost,
      body,
      currentDirectory,
      senderId,
      replyToSessionId,
      labels,
      workItem,
      channel,
      shouldSpeak,
      replyMode,
      timeoutSeconds,
      runtime,
      profile,
      harness,
      model,
      reasoningEffort,
      placement,
      workspace,
      session,
      wait,
    }) => {
      if ((completion || relation) && !requestId?.trim()) {
        throw new Error("Explicit completion asks require a stable requestId; reuse it when retrying.");
      }
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const resolvedSenderId = await resolveMcpSenderId(
        deps,
        senderId,
        resolvedCurrentDirectory,
        env,
      );
      const resolvedReplyToSessionId = resolveMcpReplyToSessionId(
        replyToSessionId,
        env,
      );
      const resolvedReplyMode = resolveAskReplyMode({
        awaitReply: wait,
        replyMode,
      });
      const replyNotificationsEnabled = areMcpReplyNotificationsEnabled(env);
      const targetSession = targetSessionId?.trim();
      const targetTo = targetSession ? `session:${targetSession}` : to?.trim();
      const parsedRuntime = runtime ? parseScoutRuntimeSpec(runtime) : null;
      const runtimeConflict = parsedRuntime?.ok
        ? ([
            ["harness", harness, parsedRuntime.value.harness],
            ["model", model, parsedRuntime.value.model],
            ["reasoningEffort", reasoningEffort, parsedRuntime.value.reasoningEffort],
          ] as const).find(([, explicit, literal]) => (
            explicit && literal && explicit.toLowerCase() !== literal.toLowerCase()
          ))
        : undefined;
      const resolvedHarness = harness ?? (parsedRuntime?.ok ? parsedRuntime.value.harness : undefined);
      const resolvedModel = model ?? (parsedRuntime?.ok ? parsedRuntime.value.model : undefined);
      const resolvedReasoningEffort = reasoningEffort
        ?? (parsedRuntime?.ok ? parsedRuntime.value.reasoningEffort : undefined);
      // A path on another machine is that machine's to resolve.
      const targetProjectPath = projectPath?.trim() && onHost?.trim()
        ? projectPath.trim()
        : projectPath?.trim()
        ? resolve(resolvedCurrentDirectory, projectPath.trim())
        : !targetTo && !profile && (runtime || resolvedHarness || resolvedModel || resolvedReasoningEffort)
          ? resolvedCurrentDirectory
        : undefined;
      let structuredContent: ScoutAskReceipt = parsedRuntime && !parsedRuntime.ok
        ? {
            ok: false,
            state: "failed" as const,
            ids: {},
            error: { code: "invalid_request" as const, message: `runtime_spec_invalid: ${parsedRuntime.error}` },
          }
        : runtimeConflict
          ? {
              ok: false,
              state: "failed" as const,
              ids: {},
              error: {
                code: "invalid_request" as const,
                message: `runtime_conflict: conflicting runtime ${runtimeConflict[0]}: explicit ${runtimeConflict[1]} and literal ${runtimeConflict[2]}`,
              },
            }
        : profile && targetTo
          ? {
              ok: false,
              state: "failed" as const,
              ids: {},
              error: {
                code: "invalid_request" as const,
                message: "runtime_conflict: profile is a launch target; do not combine it with to",
              },
            }
        : targetTo && targetProjectPath
        ? {
            ok: false,
            state: "failed" as const,
            ids: {},
            error: {
              code: "invalid_request" as const,
              message: "provide either to or projectPath, not both",
            },
          }
        : await deps.scoutAskHandler({
            requestId,
            ...(completion ? { completion } : {}),
            ...(relation ? { relation } : {}),
            senderId: resolvedSenderId,
            ...(profile
              ? {
                  runtimeProfile: profile,
                  ...(targetProjectPath ? { projectPath: targetProjectPath } : {}),
                }
              : targetProjectPath
              ? { projectPath: targetProjectPath }
              : { to: targetTo ?? "" }),
            body,
            ...(resolvedHarness ? { harness: resolvedHarness } : {}),
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(resolvedReasoningEffort ? { reasoningEffort: resolvedReasoningEffort } : {}),
            ...(placement ? { placement } : {}),
            ...(runtime ? { runtimeLiteral: runtime } : {}),
            ...((runtime || harness || model || reasoningEffort) ? {
              executionSource: {
                ...(resolvedHarness
                  ? { harness: harness ? "flag" as const : "literal" as const }
                  : {}),
                ...(resolvedModel
                  ? { model: model ? "flag" as const : "literal" as const }
                  : {}),
                ...(resolvedReasoningEffort
                  ? { reasoningEffort: reasoningEffort ? "flag" as const : "literal" as const }
                  : {}),
              },
            } : {}),
            ...(workspace ? { workspace } : {}),
            ...(session ? { session } : {}),
            ...(workItem ? { workItem } : {}),
            ...(labels ? { labels } : {}),
            ...(channel ? { channel } : {}),
            ...(shouldSpeak !== undefined ? { shouldSpeak } : {}),
            ...(resolvedReplyToSessionId ? { replyToSessionId: resolvedReplyToSessionId } : {}),
            replyMode: resolvedReplyMode,
            currentDirectory: resolvedCurrentDirectory,
            source: "scout-mcp",
            ...(onHost?.trim() ? { host: onHost.trim() } : {}),
            aliasScope: aliasProject || aliasHost ? {
              ...(aliasProject ? { projectRoot: resolve(resolvedCurrentDirectory, aliasProject) } : {}),
              ...(aliasHost ? { nodeId: aliasHost } : {}),
            } : undefined,
          });

      if (resolvedReplyMode === "inline" && structuredContent.ids.flightId) {
        try {
          const flight = await deps.waitForFlight(
            deps.resolveBrokerUrl(),
            structuredContent.ids.flightId,
            timeoutSeconds ? { timeoutSeconds } : undefined,
          );
          structuredContent = {
            ...structuredContent,
            state: flight.state === "completed"
              ? "completed"
              : flight.state === "failed" || flight.state === "cancelled"
                ? "failed"
                : "queued",
            ok: flight.state !== "failed" && flight.state !== "cancelled",
            ids: {
              ...structuredContent.ids,
              targetAgentId: flight.targetAgentId,
              invocationId: flight.invocationId,
              flightId: flight.id,
            },
          };
        } catch {
          // Keep the initial receipt; callers can follow by flight id.
        }
      } else if (
        resolvedReplyMode === "notify"
        && replyNotificationsEnabled
        && structuredContent.ids.flightId
      ) {
        // Queued dispatches materialize their flight after the receipt
        // returns, so schedule by flight id and let the scheduler's wait
        // absorb materialization instead of gating on an immediate fetch.
        const flight = await deps.getFlight(
          deps.resolveBrokerUrl(),
          structuredContent.ids.flightId,
        ).catch(() => null);
        const followArtifacts = buildScoutFollowArtifacts(
          {
            flight,
            workId: structuredContent.ids.workId,
            flightId: structuredContent.ids.flightId,
            invocationId: structuredContent.ids.invocationId,
            conversationId: structuredContent.ids.conversationId ?? null,
            workItem: null,
            targetAgentId: structuredContent.ids.targetAgentId ?? flight?.targetAgentId ?? null,
          },
          env,
        );
        scheduleScoutReplyNotification({
          server,
          deps,
          brokerUrl: deps.resolveBrokerUrl(),
          flight: flight ?? { id: structuredContent.ids.flightId },
          context: {
            currentDirectory: resolvedCurrentDirectory,
            senderId: resolvedSenderId,
            targetAgentId: structuredContent.ids.targetAgentId ?? flight?.targetAgentId ?? null,
            targetLabel: targetTo ?? targetProjectPath ?? null,
            conversationId: structuredContent.ids.conversationId ?? null,
            messageId: structuredContent.ids.messageId ?? null,
            bindingRef: structuredContent.ids.bindingRef ? `ref:${structuredContent.ids.bindingRef}` : null,
            flightId: structuredContent.ids.flightId,
            workItem: null,
            workId: structuredContent.ids.workId ?? null,
            workUrl: followArtifacts.links.work,
            ids: followArtifacts.ids,
            links: followArtifacts.links,
            followUrl: followArtifacts.followUrl,
          },
        });
        structuredContent = {
          ...structuredContent,
          delivery: "mcp_notification" as const,
          notification: {
            method: "notifications/scout/reply" as const,
            status: "scheduled" as const,
          },
        };
      }
      if (structuredContent.ok && !structuredContent.delivery) {
        structuredContent = {
          ...structuredContent,
          delivery: resolvedReplyMode === "inline"
            ? "inline"
            : "none",
          ...(resolvedReplyMode === "notify"
            ? {
                notification: {
                  method: "notifications/scout/reply" as const,
                  status: "not_scheduled" as const,
                },
              }
            : {}),
        };
      }

      const followArtifacts = buildScoutFollowArtifacts({
        flight: null,
        flightId: structuredContent.ids.flightId,
        invocationId: structuredContent.ids.invocationId,
        workId: structuredContent.ids.workId,
        workItem: null,
        conversationId: structuredContent.ids.conversationId ?? null,
        targetAgentId: structuredContent.ids.targetAgentId ?? null,
        targetSessionId: targetSession ?? null,
      }, env);
      return {
        content: createPlainTextContent(
          renderMcpAskPrimitiveSummary(structuredContent) + renderFollowLinkText(followArtifacts),
        ),
        structuredContent: {
          ...structuredContent,
          links: followArtifacts.links,
          followUrl: followArtifacts.followUrl,
        },
      };
    },
  );

  const sendOperatorSignal = async (input: {
    kind: "notify" | "consult";
    body: string;
    defaultAction?: string;
    currentDirectory?: string;
    senderId?: string;
  }) => {
    const resolvedCurrentDirectory = resolveToolCurrentDirectory(
      input.currentDirectory,
      options.defaultCurrentDirectory,
    );
    const resolvedSenderId = await resolveMcpSenderId(
      deps,
      input.senderId,
      resolvedCurrentDirectory,
      env,
    );
    const replyExpectation = input.kind === "consult" ? "optional" as const : "none" as const;
    const defaultAction = input.defaultAction?.trim() || null;
    const body = input.kind === "consult" && defaultAction
      ? `${input.body}\n\nDefault if there is no reply: ${defaultAction}`
      : input.body;
    const result = await deps.sendMessage({
      senderId: resolvedSenderId,
      body,
      targetLabel: "@operator",
      currentDirectory: resolvedCurrentDirectory,
      source: "scout-mcp",
      wake: false,
      operatorSignal: {
        ...(input.kind === "consult"
          ? {
              kind: "consult" as const,
              blocking: false as const,
              replyExpectation: "optional" as const,
              defaultAction: defaultAction!,
            }
          : {
              kind: "notify" as const,
              blocking: false as const,
              replyExpectation: "none" as const,
            }),
      },
    });
    const messageId = result.messageId ?? null;
    const routingError = result.routingError
      ?? (result.unresolvedTargets.length > 0
        ? "operator_unavailable"
        : result.usedBroker && !messageId
        ? "missing_broker_receipt"
        : null);
    const structuredContent = {
      currentDirectory: resolvedCurrentDirectory,
      senderId: resolvedSenderId,
      kind: input.kind,
      status: routingError || !result.usedBroker ? "not_recorded" as const : "recorded" as const,
      blocking: false as const,
      replyExpectation,
      notificationDelivery: routingError || !result.usedBroker
        ? "not_attempted" as const
        : "unconfirmed" as const,
      defaultAction,
      conversationId: result.conversationId ?? null,
      messageId,
      signalId: messageId,
      routingError: routingError ?? (!result.usedBroker ? "broker_unreachable" : null),
    };
    const summary = structuredContent.status === "recorded"
      ? input.kind === "consult"
        ? `Optional consultation recorded (${messageId}); notification delivery is unconfirmed. Continue with the declared default unless the operator replies.`
        : `Operator signal recorded (${messageId}); notification delivery is unconfirmed. Continue working.`
      : `Operator signal was not recorded: ${structuredContent.routingError}.`;
    return {
      content: createPlainTextContent(summary),
      structuredContent,
    };
  };

  server.registerTool(
    "notify_operator",
    {
      title: "Notify Operator",
      description:
        "Send the human operator a useful, non-blocking FYI and continue working. This creates a durable broker message for delivery and correlation, but it does not create a flight, request a reply, or change task lifecycle. Do not use it for routine progress chatter or when work cannot safely continue.",
      inputSchema: z.object({
        message: nonBlankToolStringSchema,
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
      }),
      outputSchema: operatorSignalResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ message, currentDirectory, senderId }) =>
      sendOperatorSignal({
        kind: "notify",
        body: message,
        currentDirectory,
        senderId,
      }),
  );

  server.registerTool(
    "consult_operator",
    {
      title: "Consult Operator Without Blocking",
      description:
        "Ask the human operator for optional advice while continuing the current task. Always declare the safe default action you will take if no reply arrives. This creates a durable, replyable broker message but no invocation, flight, waiting state, or lifecycle transition. Use a blocking human-input mechanism instead when there is no responsible default.",
      inputSchema: z.object({
        question: nonBlankToolStringSchema,
        defaultAction: nonBlankToolStringSchema,
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
      }),
      outputSchema: operatorSignalResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ question, defaultAction, currentDirectory, senderId }) =>
      sendOperatorSignal({
        kind: "consult",
        body: question,
        defaultAction,
        currentDirectory,
        senderId,
      }),
  );

  // Hosted tiers filter out agents_start; only point at it when it is registered.
  const canStartAgents = !options.toolFilter || options.toolFilter("agents_start");
  server.registerTool(
    "messages_send",
    {
      title: "Send Scout Message",
      description:
        "Post a broker-backed Scout message/update/reply. Use this for heads-up, threaded conversation, and status when no new owned-work lifecycle is needed. Pass targets as fields: one explicit target without a channel becomes a DM, group delivery requires an explicit channel, and the body remains payload text. Targeted DMs are dispatched by the broker when the target can be reached; callers should not preflight wake/session mechanics. " +
        (canStartAgents ? "Use targetAgentId when agents_start returned exactTargetAgentId; this bypasses label resolution but remains an agent/card target, not a sticky session. " : "") +
        "Use channel='shared' only for shared updates. Pass targetLabel for the single-call broker-resolved path; mentionAgentIds remains available for exact-id compatibility. " +
        (canStartAgents ? "If a requested new or precise target is unresolved or mismatched, call agents_start and retry with the returned exactTargetAgentId instead of substituting a different agent. " : "If a requested target is unresolved or mismatched, report it instead of substituting a different agent. ") +
        "For new agent-to-agent work, use ask instead. To continue prior context, pass targetSessionId through ask. " +
        "Opt-in: interaction='work' turns one directed send into tracked work on the ask lifecycle (same as scout send --tracked); the default stays message-only.",
      inputSchema: z.object({
        requestId: z.string().min(1).max(256).optional().describe("Requester-scoped idempotency key; reuse on retries."),
        body: z.string().min(1),
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
        targetAgentId: targetAgentIdInputSchema,
        targetLabel: targetLabelInputSchema,
        aliasProject: z.string().optional().describe("Explicit project root for targetLabel=alias:<name>."),
        aliasHost: z.string().optional().describe("Explicit authority node id/name for targetLabel=alias:<name>."),
        channel: z.string().optional(),
        shouldSpeak: z.boolean().optional(),
        mentionAgentIds: mentionAgentIdsInputSchema,
        interaction: z
          .enum(["message", "work"])
          .describe(
            "Default 'message': a durable FYI/update with no owned work (the CLI's scout send / scout tell). Pass 'work' to opt one directed target into tracked work on the ask invocation lifecycle (the CLI's scout send --tracked): returns with durable handles and reports completion back to the sender. 'work' fails closed on channel, multi-target, ref-reply, and [ask:...] completion sends. For richer work options (projectPath, harness, runtime, inline wait) use ask.",
          )
          .optional(),
        replyMode: z
          .enum(["notify", "none"])
          .describe(
            "interaction='work' only. 'notify' (default) reports completion back to the requesting agent/session; 'none' suppresses the completion callback while keeping the tracked result inspectable via invocations_wait.",
          )
          .optional(),
        wake: z
          .boolean()
          .describe(
            "Advanced override: force a visible wake turn after posting. Omit this for normal targeted DMs; the broker dispatches reachable targets automatically. Redundant with interaction='work', which already dispatches.",
          )
          .optional(),
      }),
      outputSchema: sendResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: createToolUiMeta({
        targetAgentId: createAgentPickerFieldMeta({
          selection: "single",
          valueField: "agentId",
        }),
        targetLabel: createAgentPickerFieldMeta({
          selection: "single",
          valueField: "label",
          resolveTool: "agents_resolve",
        }),
        mentionAgentIds: createAgentPickerFieldMeta({
          selection: "multiple",
          valueField: "agentId",
        }),
      }),
    },
    async ({
      requestId,
      body,
      currentDirectory,
      senderId,
      targetAgentId,
      targetLabel,
      aliasProject,
      aliasHost,
      channel,
      shouldSpeak,
      mentionAgentIds,
      interaction,
      replyMode,
      wake,
    }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const resolvedSenderId = await resolveMcpSenderId(
        deps,
        senderId,
        resolvedCurrentDirectory,
        env,
      );
      if (requestId && (!targetLabel?.trim() || targetAgentId || mentionAgentIds?.length || interaction === "work" || wake)) {
        throw new Error("requestId messages_send requires targetLabel and message-only delivery; use ask for work");
      }
      const explicitTargetIds = [
        ...new Set(
          [
            targetAgentId,
            ...(mentionAgentIds ?? []),
          ].map((value) => value?.trim()).filter((value): value is string =>
            Boolean(value),
          ),
        ),
      ];

      if (replyMode && interaction !== "work") {
        throw new Error(
          "replyMode applies only to interaction='work' (tracked sends). A plain messages_send is a message-only FYI; drop replyMode, or use ask.",
        );
      }

      // Main's contract: messages_send is message-only by default. Tracked work
      // is opt-in (interaction='work', the CLI's `scout send --tracked`) and only
      // for one directed target; channel, multi-target, reply-shaped, and
      // [ask:...] completion sends never become work, so completion replies can
      // never recursively launch work.
      const resolvedInteraction = interaction === "work"
        ? explicitTargetIds.length === 1
          ? classifySendInteraction({ targetLabel: explicitTargetIds[0], channel, body })
          : explicitTargetIds.length === 0
            ? classifySendInteraction({ targetLabel, channel, body })
            : "message"
        : "message";
      if (interaction === "work" && explicitTargetIds.length > 0 && targetLabel?.trim()) {
        throw new Error(
          "interaction='work' takes exactly one routing field: pass targetAgentId or targetLabel, not both (mentionAgentIds counts as targetAgentId).",
        );
      }
      if (interaction === "work" && resolvedInteraction !== "work") {
        throw new Error(
          "interaction='work' needs exactly one directed target (targetAgentId or targetLabel) with no channel; channel posts, multi-target sends, ref replies, and [ask:...] completion bodies are message-only and never create work. Drop interaction, or use ask.",
        );
      }

      if (resolvedInteraction === "work") {
        const trackedTargetId = explicitTargetIds[0] ?? null;
        const trackedLabel = trackedTargetId ?? targetLabel?.trim() ?? "";
        const resolvedReplyMode = replyMode ?? "notify";
        const resolvedReplyToSessionId = resolveMcpReplyToSessionId(
          undefined,
          env,
        );

        if (!trackedTargetId) {
          const parsedRouteTarget = parseScoutComposerRouteTarget(trackedLabel);
          const targetCheck = parsedRouteTarget?.kind === "route_alias"
            ? { blocked: false as const }
            : await diagnosePreciseTargetLabel({
                deps,
                targetLabel: trackedLabel,
                currentDirectory: resolvedCurrentDirectory,
              });
          if (targetCheck.blocked) {
            const structuredContent = {
              currentDirectory: resolvedCurrentDirectory,
              senderId: resolvedSenderId,
              mode: "target_label" as const,
              interaction: "work" as const,
              usedBroker: true,
              conversationId: null,
              messageId: null,
              flightId: null,
              invocationId: null,
              workId: null,
              replyMode: resolvedReplyMode,
              notification: null,
              wake: wake ?? false,
              bindingRef: null,
              invokedTargetIds: [],
              unresolvedTargetIds: [trackedLabel],
              targetDiagnostic: targetCheck.diagnostic,
              startSuggestion: targetCheck.startSuggestion,
              routingAdvice: null,
              routeKind: null,
              routingError: null,
            };
            return {
              content: createPlainTextContent(
                renderMcpSendSummary(structuredContent),
              ),
              structuredContent,
            };
          }
        }

        const result = trackedTargetId
          ? await deps.askAgentById({
              senderId: resolvedSenderId,
              targetAgentId: trackedTargetId,
              body,
              ...(shouldSpeak !== undefined ? { shouldSpeak } : {}),
              ...(resolvedReplyToSessionId
                ? { replyToSessionId: resolvedReplyToSessionId }
                : {}),
              replyMode: resolvedReplyMode,
              currentDirectory: resolvedCurrentDirectory,
              source: "scout-mcp-send",
            })
          : await deps.askQuestion({
              senderId: resolvedSenderId,
              targetLabel: trackedLabel,
              body,
              ...(shouldSpeak !== undefined ? { shouldSpeak } : {}),
              ...(resolvedReplyToSessionId
                ? { replyToSessionId: resolvedReplyToSessionId }
                : {}),
              replyMode: resolvedReplyMode,
              currentDirectory: resolvedCurrentDirectory,
              source: "scout-mcp-send",
              aliasScope: aliasProject || aliasHost ? {
                ...(aliasProject ? { projectRoot: resolve(resolvedCurrentDirectory, aliasProject) } : {}),
                ...(aliasHost ? { nodeId: aliasHost } : {}),
              } : undefined,
            });

        const unresolvedTargetIds = [
          ...("unresolvedTargetId" in result && result.unresolvedTargetId
            ? [result.unresolvedTargetId]
            : []),
          ...("unresolvedTarget" in result && result.unresolvedTarget
            ? [result.unresolvedTarget]
            : []),
        ];
        const flight = result.flight ?? null;
        const bindingRef = "bindingRef" in result && result.bindingRef
          ? `ref:${result.bindingRef}`
          : null;
        const startSuggestion = unresolvedTargetIds.length > 0 && !trackedTargetId
          ? await buildStartSuggestionForTarget(
              unresolvedTargetIds[0] ?? trackedLabel,
              resolvedCurrentDirectory,
            )
          : null;
        const followArtifacts = buildScoutFollowArtifacts(
          {
            flight,
            conversationId: result.conversationId ?? null,
            workItem: result.workItem ?? null,
            targetAgentId: flight?.targetAgentId ?? trackedTargetId ?? null,
          },
          env,
        );
        let notification:
          | {
              method: "notifications/scout/reply";
              status: "scheduled" | "not_scheduled";
            }
          | null = null;
        if (
          resolvedReplyMode === "notify"
          && unresolvedTargetIds.length === 0
          && result.usedBroker
        ) {
          if (areMcpReplyNotificationsEnabled(env) && flight) {
            scheduleScoutReplyNotification({
              server,
              deps,
              brokerUrl: deps.resolveBrokerUrl(),
              flight,
              context: {
                currentDirectory: resolvedCurrentDirectory,
                senderId: resolvedSenderId,
                targetAgentId: flight.targetAgentId ?? trackedTargetId ?? null,
                targetLabel: trackedLabel,
                conversationId: result.conversationId ?? null,
                messageId: result.messageId ?? null,
                bindingRef,
                flightId: flight.id,
                workItem: null,
                workId: result.workItem?.id ?? null,
                workUrl: null,
                ids: followArtifacts.ids,
                links: followArtifacts.links,
                followUrl: followArtifacts.followUrl,
              },
            });
            notification = {
              method: "notifications/scout/reply",
              status: "scheduled",
            };
          } else {
            notification = {
              method: "notifications/scout/reply",
              status: "not_scheduled",
            };
          }
        }
        const structuredContent = {
          currentDirectory: resolvedCurrentDirectory,
          senderId: resolvedSenderId,
          mode: trackedTargetId
            ? "explicit_targets" as const
            : "target_label" as const,
          interaction: "work" as const,
          usedBroker: result.usedBroker,
          conversationId: result.conversationId ?? null,
          messageId: result.messageId ?? null,
          flightId: flight?.id ?? null,
          invocationId: flight?.invocationId ?? null,
          workId: result.workItem?.id ?? null,
          replyMode: resolvedReplyMode,
          notification,
          wake: wake ?? false,
          bindingRef,
          invokedTargetIds: flight?.targetAgentId
            ? [flight.targetAgentId]
            : unresolvedTargetIds.length === 0
                && result.usedBroker
                && trackedTargetId
              ? [trackedTargetId]
              : [],
          unresolvedTargetIds,
          targetDiagnostic: result.targetDiagnostic
            ?? (trackedTargetId
              ? buildExactTargetIdsDiagnostic(unresolvedTargetIds)
              : null),
          startSuggestion,
          routingAdvice: null,
          routeKind: null,
          routingError: null,
          ids: followArtifacts.ids,
          links: followArtifacts.links,
          followUrl: followArtifacts.followUrl,
        };
        return {
          content: createPlainTextContent(
            renderMcpSendSummary(structuredContent),
          ),
          structuredContent,
        };
      }

      if (explicitTargetIds.length > 0) {
        if (wake) {
          const results = await Promise.all(
            explicitTargetIds.map((targetAgentId) =>
              deps.askAgentById({
                senderId: resolvedSenderId,
                targetAgentId,
                body,
                channel,
                shouldSpeak,
                currentDirectory: resolvedCurrentDirectory,
                source: "scout-mcp",
              }),
            ),
          );
          const firstResult = results[0];
          const firstFlight = results.find((result) => result.flight)?.flight ?? null;
          const unresolvedTargetIds = results
            .map((result) => result.unresolvedTargetId)
            .filter((value): value is string => Boolean(value));
          const targetDiagnostic =
            firstResult?.targetDiagnostic ??
            buildExactTargetIdsDiagnostic(unresolvedTargetIds);
          const startSuggestion = null;
          const followArtifacts = buildScoutFollowArtifacts(
            {
              flight: firstFlight,
              conversationId: firstResult?.conversationId ?? null,
              workItem: null,
              targetAgentId: firstFlight?.targetAgentId ?? null,
            },
            env,
          );
          const structuredContent = {
            currentDirectory: resolvedCurrentDirectory,
            senderId: resolvedSenderId,
            mode: "explicit_targets" as const,
            interaction: "message" as const,
            usedBroker: results.some((result) => result.usedBroker),
            conversationId: firstResult?.conversationId ?? null,
            messageId: firstResult?.messageId ?? null,
            flightId: firstFlight?.id ?? null,
            wake: true,
            invokedTargetIds: results
              .map((result) => result.flight?.targetAgentId)
              .filter((value): value is string => Boolean(value)),
            unresolvedTargetIds,
            targetDiagnostic,
            startSuggestion,
            routingAdvice: null,
            routeKind: null,
            routingError: null,
            ids: followArtifacts.ids,
            links: followArtifacts.links,
            followUrl: followArtifacts.followUrl,
          };
          return {
            content: createPlainTextContent(
              renderMcpSendSummary(structuredContent),
            ),
            structuredContent,
          };
        }

        const result = await deps.sendMessageToAgentIds({
          senderId: resolvedSenderId,
          body,
          targetAgentIds: explicitTargetIds,
          channel,
          shouldSpeak,
          currentDirectory: resolvedCurrentDirectory,
          source: "scout-mcp",
        });
        const startSuggestion = null;
        const followArtifacts = buildScoutFollowArtifacts(
          {
            flight: result.flight ?? null,
            conversationId: result.conversationId ?? null,
            workItem: null,
            targetAgentId: result.flight?.targetAgentId ?? null,
          },
          env,
        );
        const structuredContent = {
          currentDirectory: resolvedCurrentDirectory,
          senderId: resolvedSenderId,
          mode: "explicit_targets" as const,
          interaction: "message" as const,
          usedBroker: result.usedBroker,
          conversationId: result.conversationId ?? null,
          messageId: result.messageId ?? null,
          flightId: result.flight?.id ?? null,
          wake: wake ?? false,
          invokedTargetIds: result.invokedTargetIds,
          unresolvedTargetIds: result.unresolvedTargetIds,
          targetDiagnostic:
            result.targetDiagnostic ??
            buildExactTargetIdsDiagnostic(result.unresolvedTargetIds),
          startSuggestion,
          routingAdvice: buildSendRoutingAdvice(result.routingError ?? null),
          routeKind: result.routeKind ?? null,
          routingError: result.routingError ?? null,
          ids: followArtifacts.ids,
          links: followArtifacts.links,
          followUrl: followArtifacts.followUrl,
        };
        return {
          content: createPlainTextContent(
            renderMcpSendSummary(structuredContent),
          ),
          structuredContent,
        };
      }

      if (targetLabel?.trim()) {
        const parsedRouteTarget = parseScoutComposerRouteTarget(targetLabel);
        const targetCheck = parsedRouteTarget?.kind === "route_alias"
          ? { blocked: false as const }
          : await diagnosePreciseTargetLabel({
              deps,
              targetLabel,
              currentDirectory: resolvedCurrentDirectory,
            });
        if (targetCheck.blocked) {
          const structuredContent = {
            currentDirectory: resolvedCurrentDirectory,
            senderId: resolvedSenderId,
            mode: "target_label" as const,
            interaction: "message" as const,
            usedBroker: true,
            conversationId: null,
            messageId: null,
            flightId: null,
            wake: wake ?? false,
            bindingRef: null,
            invokedTargetIds: [],
            unresolvedTargetIds: [targetLabel.trim()],
            targetDiagnostic: targetCheck.diagnostic,
            startSuggestion: targetCheck.startSuggestion,
            routingAdvice: null,
            routeKind: null,
            routingError: null,
          };
          return {
            content: createPlainTextContent(
              renderMcpSendSummary(structuredContent),
            ),
            structuredContent,
          };
        }
        const result = await deps.sendMessage({
          requestId,
          senderId: resolvedSenderId,
          body,
          targetLabel: targetLabel.trim(),
          channel,
          shouldSpeak,
          currentDirectory: resolvedCurrentDirectory,
          source: "scout-mcp",
          wake,
          aliasScope: aliasProject || aliasHost ? {
            ...(aliasProject ? { projectRoot: resolve(resolvedCurrentDirectory, aliasProject) } : {}),
            ...(aliasHost ? { nodeId: aliasHost } : {}),
          } : undefined,
        });
        const startSuggestion = result.unresolvedTargets.length > 0
          ? await buildStartSuggestionForTarget(
            result.unresolvedTargets[0] ?? targetLabel.trim(),
            resolvedCurrentDirectory,
          )
          : null;
        const followArtifacts = buildScoutFollowArtifacts(
          {
            flight: result.flight ?? null,
            conversationId: result.conversationId ?? null,
            workItem: null,
            targetAgentId: result.flight?.targetAgentId ?? null,
          },
          env,
        );
        const structuredContent = {
          currentDirectory: resolvedCurrentDirectory,
          senderId: resolvedSenderId,
          mode: "target_label" as const,
          interaction: "message" as const,
          usedBroker: result.usedBroker,
          conversationId: result.conversationId ?? null,
          messageId: result.messageId ?? null,
          flightId: result.flight?.id ?? null,
          wake: wake ?? false,
          bindingRef: result.bindingRef ? `ref:${result.bindingRef}` : null,
          invokedTargetIds: result.invokedTargets,
          unresolvedTargetIds: result.unresolvedTargets,
          targetDiagnostic: result.targetDiagnostic ?? null,
          startSuggestion,
          routingAdvice: buildSendRoutingAdvice(result.routingError ?? null),
          routeKind: result.routeKind ?? null,
          routingError: result.routingError ?? null,
          ids: followArtifacts.ids,
          links: followArtifacts.links,
          followUrl: followArtifacts.followUrl,
        };
        return {
          content: createPlainTextContent(
            renderMcpSendSummary(structuredContent),
          ),
          structuredContent,
        };
      }

      const result = await deps.sendMessage({
        senderId: resolvedSenderId,
        body,
        channel,
        shouldSpeak,
        currentDirectory: resolvedCurrentDirectory,
        source: "scout-mcp",
        wake,
      });
      const startSuggestion = result.unresolvedTargets.length > 0
        ? await buildStartSuggestionForTarget(
          result.unresolvedTargets[0],
          resolvedCurrentDirectory,
        )
        : null;
      const followArtifacts = buildScoutFollowArtifacts(
        {
          flight: result.flight ?? null,
          conversationId: result.conversationId ?? null,
          workItem: null,
          targetAgentId: result.flight?.targetAgentId ?? null,
        },
        env,
      );
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        senderId: resolvedSenderId,
        mode: "body_mentions" as const,
        interaction: "message" as const,
        usedBroker: result.usedBroker,
        conversationId: result.conversationId ?? null,
        messageId: result.messageId ?? null,
        flightId: result.flight?.id ?? null,
        wake: wake ?? false,
        bindingRef: result.bindingRef ? `ref:${result.bindingRef}` : null,
        invokedTargetIds: result.invokedTargets,
        unresolvedTargetIds: result.unresolvedTargets,
        targetDiagnostic: result.targetDiagnostic ?? null,
        startSuggestion,
        routingAdvice: buildSendRoutingAdvice(result.routingError ?? null),
        routeKind: result.routeKind ?? null,
        routingError: result.routingError ?? null,
        ids: followArtifacts.ids,
        links: followArtifacts.links,
        followUrl: followArtifacts.followUrl,
      };
      return {
        content: createPlainTextContent(
          renderMcpSendSummary(structuredContent),
        ),
        structuredContent,
      };
    },
  );

  if (env.OPENSCOUT_EXPOSE_DEPRECATED_INVOCATIONS_ASK === "1") {
  server.registerTool(
    "invocations_ask",
    {
      title: "Deprecated Scout Invocation Ask",
      description:
        "DEPRECATED compatibility surface. Do not use this as an agent front door; use ask to talk to the broker. Agent/card targets create fresh sessions; only targetSessionId continues exact prior context. Ask creates broker invocation and flight records as side effects, then use invocations_get or invocations_wait to observe those records. This tool is hidden unless OPENSCOUT_EXPOSE_DEPRECATED_INVOCATIONS_ASK=1 is set for an older client.",
      inputSchema: z
        .object({
          body: z.string().min(1),
          currentDirectory: z.string().optional(),
          senderId: z.string().optional(),
          targetSessionId: targetSessionIdInputSchema,
          targetAgentId: targetAgentIdInputSchema,
          targetLabel: targetLabelInputSchema,
          replyToSessionId: z
            .string()
            .describe(
              "Optional requester session that should receive the eventual reply. When omitted, Codex MCP uses the current CODEX_THREAD_ID when available.",
            )
            .optional(),
          labels: z.array(z.string()).optional(),
          workItem: workItemInputSchema.optional(),
          channel: z.string().optional(),
          shouldSpeak: z.boolean().optional(),
          awaitReply: z
            .boolean()
            .describe("Compatibility alias for replyMode='inline'.")
            .optional(),
          replyMode: z
            .enum(REPLY_MODE_VALUES)
            .describe(
              "Reply delivery mode (default 'notify'): 'inline' returns a quick acknowledgement or immediate completion, 'notify' returns durable ids and emits notifications/scout/reply when OPENSCOUT_MCP_ENABLE_NOTIFICATIONS=1 (always on for the hosted bridge), and 'none' returns durable ids only. Inline acknowledgement waits use timeoutSeconds only as a caller wait budget.",
            )
            .optional(),
          timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Caller wait budget in seconds for inline waits only; it never cancels or fails the broker ask."),
        })
        .refine(
          (value) =>
            Boolean(value.targetSessionId?.trim() || value.targetAgentId?.trim() || value.targetLabel?.trim()),
          {
            message: "Provide targetSessionId, targetAgentId, or targetLabel.",
            path: ["targetSessionId"],
          },
        ),
      outputSchema: askResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: createToolUiMeta({
        targetSessionId: createAgentPickerFieldMeta({
          selection: "single",
          valueField: "sessionId",
        }),
        targetAgentId: createAgentPickerFieldMeta({
          selection: "single",
          valueField: "agentId",
        }),
        targetLabel: createAgentPickerFieldMeta({
          selection: "single",
          valueField: "label",
          resolveTool: "agents_resolve",
        }),
      }),
    },
    async ({
      body,
      currentDirectory,
      senderId,
      targetSessionId,
      targetAgentId,
      targetLabel,
      replyToSessionId,
      labels,
      workItem,
      channel,
      shouldSpeak,
      awaitReply,
      replyMode,
      timeoutSeconds,
    }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const resolvedSenderId = await resolveMcpSenderId(
        deps,
        senderId,
        resolvedCurrentDirectory,
        env,
      );
      const resolvedReplyMode = resolveAskReplyMode({ awaitReply, replyMode });
      const shouldAwait = resolvedReplyMode === "inline";
      const replyNotificationsEnabled = areMcpReplyNotificationsEnabled(env);
      const resolvedReplyToSessionId = resolveMcpReplyToSessionId(
        replyToSessionId,
        env,
      );

      if (targetSessionId?.trim()) {
        const trimmedTargetSessionId = targetSessionId.trim();
        const result = await deps.askSessionById({
          senderId: resolvedSenderId,
          targetSessionId: trimmedTargetSessionId,
          body,
          workItem,
          channel,
          shouldSpeak,
          labels,
          replyToSessionId: resolvedReplyToSessionId,
          replyMode: resolvedReplyMode,
          currentDirectory: resolvedCurrentDirectory,
          source: "scout-mcp",
        });
        const waitResult = shouldAwait
          ? await waitForFlightForMcp({
              deps,
              brokerUrl: deps.resolveBrokerUrl(),
              flight: result.flight ?? null,
              timeoutSeconds,
            })
          : { flight: null, waitStatus: "not_requested" as const };
        const completedFlight = waitResult.flight;
        const trackedWorkItem = result.workItem ?? null;
        const notificationScheduled =
          resolvedReplyMode === "notify"
          && replyNotificationsEnabled
          && Boolean(result.flight);
        const followArtifacts = buildScoutFollowArtifacts(
          {
            flight: completedFlight ?? result.flight ?? null,
            conversationId: result.conversationId ?? null,
            workItem: trackedWorkItem,
            targetSessionId: trimmedTargetSessionId,
            targetAgentId: result.flight?.targetAgentId ?? null,
          },
          env,
        );
        if (notificationScheduled && result.flight) {
          scheduleScoutReplyNotification({
            server,
            deps,
            brokerUrl: deps.resolveBrokerUrl(),
            flight: result.flight,
            context: {
              currentDirectory: resolvedCurrentDirectory,
              senderId: resolvedSenderId,
              targetAgentId: result.flight.targetAgentId ?? null,
              targetLabel: null,
              conversationId: result.conversationId ?? null,
              messageId: result.messageId ?? null,
              flightId: result.flight.id,
              workItem: trackedWorkItem,
              workId: trackedWorkItem?.id ?? null,
              workUrl: workUrlFor(trackedWorkItem, env),
              ids: followArtifacts.ids,
              links: followArtifacts.links,
              followUrl: followArtifacts.followUrl,
            },
          });
        }
        const unresolvedTargetId = result.unresolvedTargetId ?? null;
        const structuredContent = {
          currentDirectory: resolvedCurrentDirectory,
          senderId: resolvedSenderId,
          targetAgentId: result.flight?.targetAgentId ?? null,
          targetSessionId: trimmedTargetSessionId,
          targetLabel: null,
          replyToSessionId: resolvedReplyToSessionId ?? null,
          usedBroker: result.usedBroker,
          awaited: shouldAwait,
          waitStatus: waitResult.waitStatus,
          replyMode: resolvedReplyMode,
          delivery: notificationScheduled
            ? "mcp_notification" as const
            : shouldAwait
              ? "inline" as const
              : "none" as const,
          notification: resolvedReplyMode === "notify"
            ? {
                method: "notifications/scout/reply" as const,
                status: notificationScheduled ? "scheduled" as const : "not_scheduled" as const,
              }
            : null,
          conversationId: result.conversationId ?? null,
          messageId: result.messageId ?? null,
          flight: completedFlight ?? result.flight ?? null,
          flightId: completedFlight?.id ?? result.flight?.id ?? null,
          output:
            waitResult.waitStatus === "completed" || waitResult.waitStatus === "terminal"
              ? completedFlight?.output ?? completedFlight?.summary ?? null
              : null,
          unresolvedTargetId,
          unresolvedTargetLabel: null,
          workItem: trackedWorkItem,
          workId: trackedWorkItem?.id ?? null,
          workUrl: workUrlFor(trackedWorkItem, env),
          ids: followArtifacts.ids,
          links: followArtifacts.links,
          followUrl: followArtifacts.followUrl,
          targetDiagnostic:
            result.targetDiagnostic ??
            buildExactTargetIdsDiagnostic(unresolvedTargetId ? [unresolvedTargetId] : []),
          startSuggestion: null,
        };
        return {
          content: createPlainTextContent(
            renderMcpAskSummary(structuredContent),
          ),
          structuredContent,
        };
      }

      if (targetAgentId?.trim()) {
        const result = await deps.askAgentById({
          senderId: resolvedSenderId,
          targetAgentId: targetAgentId.trim(),
          body,
          workItem,
          channel,
          shouldSpeak,
          labels,
          replyToSessionId: resolvedReplyToSessionId,
          replyMode: resolvedReplyMode,
          currentDirectory: resolvedCurrentDirectory,
          source: "scout-mcp",
        });
        const waitResult = shouldAwait
          ? await waitForFlightForMcp({
              deps,
              brokerUrl: deps.resolveBrokerUrl(),
              flight: result.flight ?? null,
              timeoutSeconds,
            })
          : { flight: null, waitStatus: "not_requested" as const };
        const completedFlight = waitResult.flight;
        const trackedWorkItem = result.workItem ?? null;
        const notificationScheduled =
          resolvedReplyMode === "notify"
          && replyNotificationsEnabled
          && Boolean(result.flight);
        const followArtifacts = buildScoutFollowArtifacts(
          {
            flight: completedFlight ?? result.flight ?? null,
            conversationId: result.conversationId ?? null,
            workItem: trackedWorkItem,
            targetAgentId: targetAgentId.trim(),
          },
          env,
        );
        if (notificationScheduled && result.flight) {
          scheduleScoutReplyNotification({
            server,
            deps,
            brokerUrl: deps.resolveBrokerUrl(),
            flight: result.flight,
            context: {
              currentDirectory: resolvedCurrentDirectory,
              senderId: resolvedSenderId,
              targetAgentId: targetAgentId.trim(),
              targetLabel: null,
              conversationId: result.conversationId ?? null,
              messageId: result.messageId ?? null,
              flightId: result.flight.id,
              workItem: trackedWorkItem,
              workId: trackedWorkItem?.id ?? null,
              workUrl: workUrlFor(trackedWorkItem, env),
              ids: followArtifacts.ids,
              links: followArtifacts.links,
              followUrl: followArtifacts.followUrl,
            },
          });
        }
        const unresolvedTargetId = result.unresolvedTargetId ?? null;
        const structuredContent = {
          currentDirectory: resolvedCurrentDirectory,
          senderId: resolvedSenderId,
          targetAgentId: targetAgentId.trim(),
          targetSessionId: null,
          targetLabel: null,
          replyToSessionId: resolvedReplyToSessionId ?? null,
          usedBroker: result.usedBroker,
          awaited: shouldAwait,
          waitStatus: waitResult.waitStatus,
          replyMode: resolvedReplyMode,
          delivery: notificationScheduled
            ? "mcp_notification" as const
            : shouldAwait
              ? "inline" as const
              : "none" as const,
          notification: resolvedReplyMode === "notify"
            ? {
                method: "notifications/scout/reply" as const,
                status: notificationScheduled ? "scheduled" as const : "not_scheduled" as const,
              }
            : null,
          conversationId: result.conversationId ?? null,
          messageId: result.messageId ?? null,
          flight: completedFlight ?? result.flight ?? null,
          flightId: completedFlight?.id ?? result.flight?.id ?? null,
          output:
            waitResult.waitStatus === "completed" || waitResult.waitStatus === "terminal"
              ? completedFlight?.output ?? completedFlight?.summary ?? null
              : null,
          unresolvedTargetId,
          unresolvedTargetLabel: null,
          workItem: trackedWorkItem,
          workId: trackedWorkItem?.id ?? null,
          workUrl: workUrlFor(trackedWorkItem, env),
          ids: followArtifacts.ids,
          links: followArtifacts.links,
          followUrl: followArtifacts.followUrl,
          targetDiagnostic:
            result.targetDiagnostic ??
            buildExactTargetIdsDiagnostic(unresolvedTargetId ? [unresolvedTargetId] : []),
          startSuggestion: null,
        };
        return {
          content: createPlainTextContent(
            renderMcpAskSummary(structuredContent),
          ),
          structuredContent,
        };
      }

      const targetCheck = await diagnosePreciseTargetLabel({
        deps,
        targetLabel,
        currentDirectory: resolvedCurrentDirectory,
      });
      if (targetCheck.blocked) {
        const structuredContent = {
          currentDirectory: resolvedCurrentDirectory,
          senderId: resolvedSenderId,
          targetAgentId: null,
          targetSessionId: null,
          targetLabel: targetLabel!.trim(),
          replyToSessionId: resolvedReplyToSessionId ?? null,
          usedBroker: true,
          awaited: shouldAwait,
          waitStatus: "not_requested" as const,
          replyMode: resolvedReplyMode,
          delivery: "none" as const,
          notification: null,
          conversationId: null,
          messageId: null,
          flight: null,
          flightId: null,
          output: null,
          unresolvedTargetId: null,
          unresolvedTargetLabel: targetLabel!.trim(),
          workItem: null,
          workId: null,
          workUrl: null,
          targetDiagnostic: targetCheck.diagnostic,
          startSuggestion: targetCheck.startSuggestion,
        };
        return {
          content: createPlainTextContent(
            renderMcpAskSummary(structuredContent),
          ),
          structuredContent,
        };
      }

      const result = await deps.askQuestion({
        senderId: resolvedSenderId,
        targetLabel: targetLabel!.trim(),
        body,
        workItem,
        channel,
        shouldSpeak,
        labels,
        replyToSessionId: resolvedReplyToSessionId,
        replyMode: resolvedReplyMode,
        currentDirectory: resolvedCurrentDirectory,
        source: "scout-mcp",
      });
      const waitResult = shouldAwait
        ? await waitForFlightForMcp({
            deps,
            brokerUrl: deps.resolveBrokerUrl(),
            flight: result.flight ?? null,
            timeoutSeconds,
          })
        : { flight: null, waitStatus: "not_requested" as const };
      const completedFlight = waitResult.flight;
      const trackedWorkItem = result.workItem ?? null;
      const notificationScheduled =
        resolvedReplyMode === "notify"
        && replyNotificationsEnabled
        && Boolean(result.flight);
      const followArtifacts = buildScoutFollowArtifacts(
        {
          flight: completedFlight ?? result.flight ?? null,
          conversationId: result.conversationId ?? null,
          workItem: trackedWorkItem,
          targetAgentId: result.flight?.targetAgentId ?? null,
        },
        env,
      );
      if (notificationScheduled && result.flight) {
        scheduleScoutReplyNotification({
          server,
          deps,
          brokerUrl: deps.resolveBrokerUrl(),
          flight: result.flight,
          context: {
            currentDirectory: resolvedCurrentDirectory,
            senderId: resolvedSenderId,
            targetAgentId: result.flight.targetAgentId ?? null,
            targetLabel: targetLabel!.trim(),
            conversationId: result.conversationId ?? null,
            messageId: result.messageId ?? null,
            bindingRef: result.bindingRef ? `ref:${result.bindingRef}` : null,
            flightId: result.flight.id,
            workItem: trackedWorkItem,
            workId: trackedWorkItem?.id ?? null,
            workUrl: workUrlFor(trackedWorkItem, env),
            ids: followArtifacts.ids,
            links: followArtifacts.links,
            followUrl: followArtifacts.followUrl,
          },
        });
      }
      const startSuggestion = result.unresolvedTarget
        ? await buildStartSuggestionForTarget(
            result.unresolvedTarget,
            resolvedCurrentDirectory,
          )
        : null;
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        senderId: resolvedSenderId,
        targetAgentId: result.flight?.targetAgentId ?? null,
        targetSessionId: null,
        targetLabel: targetLabel!.trim(),
        replyToSessionId: resolvedReplyToSessionId ?? null,
        usedBroker: result.usedBroker,
        awaited: shouldAwait,
        waitStatus: waitResult.waitStatus,
        replyMode: resolvedReplyMode,
        delivery: notificationScheduled
          ? "mcp_notification" as const
          : shouldAwait
            ? "inline" as const
            : "none" as const,
        notification: resolvedReplyMode === "notify"
          ? {
              method: "notifications/scout/reply" as const,
              status: notificationScheduled ? "scheduled" as const : "not_scheduled" as const,
            }
          : null,
        conversationId: result.conversationId ?? null,
        messageId: result.messageId ?? null,
        bindingRef: result.bindingRef ? `ref:${result.bindingRef}` : null,
        flight: completedFlight ?? result.flight ?? null,
        flightId: completedFlight?.id ?? result.flight?.id ?? null,
        output:
          waitResult.waitStatus === "completed" || waitResult.waitStatus === "terminal"
            ? completedFlight?.output ?? completedFlight?.summary ?? null
            : null,
        unresolvedTargetId: null,
        unresolvedTargetLabel: result.unresolvedTarget ?? null,
        workItem: trackedWorkItem,
        workId: trackedWorkItem?.id ?? null,
        workUrl: workUrlFor(trackedWorkItem, env),
        ids: followArtifacts.ids,
        links: followArtifacts.links,
        followUrl: followArtifacts.followUrl,
        targetDiagnostic: result.targetDiagnostic ?? null,
        startSuggestion,
      };
      return {
        content: createPlainTextContent(
          renderMcpAskSummary(structuredContent),
        ),
        structuredContent,
      };
    },
  );
  }

  server.registerTool(
    "invocations_get",
    {
      title: "Get Scout Ask",
      description:
        "Fetch the current broker flight state for a previously-created Scout ask or invocation. Use this with a flightId returned by ask to observe long-running work without blocking the original ask call.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        flightId: z.string().min(1),
      }),
      outputSchema: invocationLookupResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, flightId }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const trimmedFlightId = flightId.trim();
      const brokerUrl = deps.resolveBrokerUrl();
      const flight = await deps.getFlight(brokerUrl, trimmedFlightId);
      const lifecycle = await loadInvocationLifecycleForFlight({
        deps,
        brokerUrl,
        flight,
      });
      const structuredContent = buildInvocationLookupContent({
        currentDirectory: resolvedCurrentDirectory,
        flightId: trimmedFlightId,
        flight,
        lifecycle,
        waitStatus: "not_requested",
        env,
      });
      return {
        content: createPlainTextContent(
          renderInvocationLookupSummary(structuredContent),
        ),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "invocations_wait",
    {
      title: "Wait For Scout Ask",
      description:
        "Wait briefly for a previously-created Scout ask flight to finish, then return the latest flight state. This is a bounded follow-up wait, not the long-running ask submission path.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        flightId: z.string().min(1),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(300)
          .default(30)
          .describe("Caller wait budget in seconds; elapsed time returns the latest state and does not cancel or fail the ask."),
      }),
      outputSchema: invocationLookupResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, flightId, timeoutSeconds }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const trimmedFlightId = flightId.trim();
      const brokerUrl = deps.resolveBrokerUrl();
      let flight: ScoutFlightRecord | null = null;
      let waitStatus: "completed" | "terminal" | "pending" = "pending";

      try {
        flight = await deps.waitForFlight(
          brokerUrl,
          trimmedFlightId,
          { timeoutSeconds },
        );
        waitStatus = "completed";
      } catch (error) {
        flight = await deps.getFlight(brokerUrl, trimmedFlightId);
        if (isTerminalFlightState(flight?.state)) {
          waitStatus = "terminal";
        } else if (
          !(error instanceof Error) ||
          !error.message.includes("Timed out waiting for flight")
        ) {
          throw error;
        }
      }
      const lifecycle = await loadInvocationLifecycleForFlight({
        deps,
        brokerUrl,
        flight,
      });

      const structuredContent = buildInvocationLookupContent({
        currentDirectory: resolvedCurrentDirectory,
        flightId: trimmedFlightId,
        flight,
        lifecycle,
        waitStatus,
        env,
      });
      return {
        content: createPlainTextContent(
          renderInvocationLookupSummary(structuredContent),
        ),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "labels_brief",
    {
      title: "Brief Scout Label",
      description:
        "Fetch a compact, non-chatty brief for records sharing a Scout label. Labels are lightweight coordination metadata: they can mean a goal, release, milestone, incident, or any local convention without creating a lifecycle.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        label: z.string().min(1),
      }),
      outputSchema: labelBriefSchema.extend({
        currentDirectory: z.string(),
        found: z.boolean(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, label }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const trimmedLabel = label.trim();
      const brief = await deps.readLabelBrief(trimmedLabel, deps.resolveBrokerUrl());
      if (!brief) {
        const empty = {
          currentDirectory: resolvedCurrentDirectory,
          found: false,
          label: trimmedLabel,
          generatedAt: Date.now(),
          lastActivityAt: null,
          participants: [],
          counts: {
            flights: 0,
            activeFlights: 0,
            workItems: 0,
          },
          flightsByState: {},
          activeFlights: [],
          recentFlights: [],
          workItems: [],
        };
        return {
          content: createPlainTextContent("Scout broker is not reachable; label brief is unavailable."),
          structuredContent: empty,
        };
      }
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        found: true,
        ...brief,
      };
      return {
        content: createPlainTextContent(renderMcpLabelBriefSummary(structuredContent)),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "labels_feed",
    {
      title: "Read Scout Label Feed",
      description:
        "Fetch a normalized firehose-style event backlog for records sharing a Scout label. Use this to see whether label-scoped work is moving without parsing harness-native session files.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        label: z.string().min(1),
        since: z.number().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      outputSchema: labelFeedSchema.extend({
        currentDirectory: z.string(),
        found: z.boolean(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, label, since, limit }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const trimmedLabel = label.trim();
      const feed = await deps.readLabelFeed(trimmedLabel, deps.resolveBrokerUrl(), {
        since: since ?? null,
        limit: limit ?? 80,
      });
      if (!feed) {
        const empty = {
          currentDirectory: resolvedCurrentDirectory,
          found: false,
          label: trimmedLabel,
          generatedAt: Date.now(),
          cursor: null,
          since: since ?? null,
          counts: {
            events: 0,
            messages: 0,
            invocations: 0,
            flights: 0,
            workEvents: 0,
          },
          events: [],
        };
        return {
          content: createPlainTextContent("Scout broker is not reachable; label feed is unavailable."),
          structuredContent: empty,
        };
      }
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        found: true,
        ...feed,
      };
      return {
        content: createPlainTextContent(renderMcpLabelFeedSummary(structuredContent)),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "work_update",
    {
      title: "Update Scout Work",
      description:
        "Update a durable Scout work item and append a matching collaboration event. Use this for progress, waiting, review, and done transitions instead of sending a second ad hoc status message.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
        work: workItemUpdateSchema,
      }),
      outputSchema: workUpdateResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ currentDirectory, senderId, work }) => {
      const resolvedCurrentDirectory = resolveToolCurrentDirectory(
        currentDirectory,
        options.defaultCurrentDirectory,
      );
      const resolvedSenderId = await resolveMcpSenderId(
        deps,
        senderId,
        resolvedCurrentDirectory,
        env,
      );
      const workItem = await deps.updateWorkItem({
        ...work,
        actorId: resolvedSenderId,
        source: "scout-mcp",
      });
      const structuredContent = {
        currentDirectory: resolvedCurrentDirectory,
        senderId: resolvedSenderId,
        usedBroker: workItem !== null,
        workItem,
        workId: workItem?.id ?? null,
        workUrl: workUrlFor(workItem, env),
      };
      return {
        content: createTextContent(structuredContent),
        structuredContent,
      };
    },
  );

  return server;
}

export async function runScoutMcpServer(options: {
  defaultCurrentDirectory: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const server = createScoutMcpServer({
    defaultCurrentDirectory: options.defaultCurrentDirectory,
    env: options.env,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await waitForStdioServerClosure({ server, transport });
}
