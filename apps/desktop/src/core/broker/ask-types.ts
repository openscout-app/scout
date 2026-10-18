import type { AgentHarness, ScoutCompletionRequest, ScoutCompletionRelation, ScoutCompletionState, RouteAliasScope, ScoutExecutionResolution, SessionPlacement } from "@openscout/protocol";

export type ScoutAskWorkspace = "same" | "new_worktree";
export type ScoutAskSession = "reuse" | "new";
export type ScoutAskReplyMode = "inline" | "notify" | "none";

export type ScoutAskSenderContext = {
  agentId?: string;
  project?: string;
  cwd?: string;
  worktree?: "same" | "isolated" | "unknown";
  lastTargetId?: string;
};

type ScoutAskCommandBase = {
  requestId?: string;
  completion?: ScoutCompletionRequest;
  relation?: ScoutCompletionRelation;
  senderId: string;
  /** Exact IDs are sent directly; legacy mode resolves explicit --as names locally. */
  senderResolution?: "exact" | "legacy";
  body: string;
  harness?: AgentHarness;
  model?: string;
  reasoningEffort?: string;
  placement?: SessionPlacement;
  runtimeLiteral?: string;
  executionSource?: Partial<Record<"harness" | "model" | "reasoningEffort", "flag" | "literal">>;
  workspace?: ScoutAskWorkspace;
  session?: ScoutAskSession;
  senderContext?: ScoutAskSenderContext;
  workItem?: {
    title: string;
    summary?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    labels?: string[];
    parentId?: string;
    acceptanceState?: "none" | "pending" | "accepted" | "reopened";
    metadata?: Record<string, unknown>;
  };
  labels?: string[];
  replyToSessionId?: string;
  replyMode?: ScoutAskReplyMode;
  channel?: string;
  shouldSpeak?: boolean;
  currentDirectory?: string;
  source?: string;
  aliasScope?: RouteAliasScope;
  /**
   * The mesh machine to start the session on (`--on archie`). Requires a
   * projectPath, which is then read as a path on that machine, unresolved here.
   */
  host?: string;
};

type ScoutAskTargetInput =
  | { to: string; projectPath?: never; runtimeProfile?: never; existingHandle?: never }
  | { to?: never; projectPath: string; runtimeProfile?: never; existingHandle?: never }
  | { to?: never; projectPath?: string; runtimeProfile: string; existingHandle?: never }
  | { to?: never; projectPath?: never; runtimeProfile?: never; existingHandle: string }
  | { to?: undefined; projectPath?: undefined; runtimeProfile?: undefined; existingHandle?: undefined };

export type ScoutAskCommand = ScoutAskCommandBase & ScoutAskTargetInput;

export type ScoutAskState =
  | "queued"
  | "completed"
  | "failed"
  | "ambiguous";

export type ScoutAskNextCall = {
  tool: "agents_resolve" | "agents_search" | "agents_start";
  arguments: Record<string, unknown>;
  reason: string;
};

export type ScoutAskError = {
  code: "broker_unreachable" | "invalid_request" | "preflight_failed";
  message: string;
};

export type ScoutAskReceipt = {
  ok: boolean;
  state: ScoutAskState;
  ids: {
    targetAgentId?: string;
    invocationId?: string;
    flightId?: string;
    conversationId?: string;
    messageId?: string;
    workId?: string;
    bindingRef?: string;
    sessionAlias?: string;
  };
  delivery?: "none" | "inline" | "mcp_notification";
  executionResolution?: ScoutExecutionResolution;
  completion?: ScoutCompletionState & { invocationId: string; flightId: string };
  parentCompletion?: { flightId: string; revision: number };
  notification?: {
    method: "notifications/scout/reply";
    status: "scheduled" | "not_scheduled";
  };
  next?: ScoutAskNextCall;
  error?: ScoutAskError;
};
