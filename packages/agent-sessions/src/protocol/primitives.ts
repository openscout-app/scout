// Session protocol primitives.
//
// These types define the universal vocabulary for AI session observability.
// Every adapter — regardless of the backend (Claude Code, Codex, Gemini,
// Ollama, a browser extension, etc.) — maps its native events onto these
// primitives.  Clients render these.
//
// Aligned with Vercel AI SDK LanguageModelV3 content types where possible,
// but transport-agnostic.

// ---------------------------------------------------------------------------
// Session — a long-lived connection to one agent
// ---------------------------------------------------------------------------

export type SessionStatus = "connecting" | "active" | "idle" | "error" | "closed";

export interface Session {
  /** Unique session identifier (UUID). */
  id: string;
  /** Human-readable label (e.g. "Claude Code — pairing repo"). */
  name: string;
  /** Adapter type that produced this session. */
  adapterType: string;
  /** Current lifecycle status. */
  status: SessionStatus;
  /** Working directory on the host machine, if applicable. */
  cwd?: string;
  /** Model identifier, if known (e.g. "claude-sonnet-4-20250514"). */
  model?: string;
  /** Harness-reported reasoning/thinking effort, if available. */
  reasoningEffort?: string;
  /** Provider-specific metadata (AI SDK providerOptions pattern). */
  providerMeta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Observed harness topology
// ---------------------------------------------------------------------------

export const OBSERVED_HARNESS_TOPOLOGY_META_KEY = "observedTopology";

/**
 * Read-only topology discovered from a harness-owned ecosystem.
 *
 * This is intentionally not a Scout-owned coordination model. Adapters may
 * attach it to Session.providerMeta to explain what a harness is doing, such as
 * a Claude Code lead coordinating teammates, but Scout must not mutate the
 * upstream harness files or runtime state that produced it.
 */
export interface ObservedHarnessTopology {
  schemaVersion: "openscout.observed-harness-topology.v1";
  ownership: "harness_observed";
  source: string;
  observedAt: string;
  groups: ObservedHarnessGroup[];
  agents: ObservedHarnessAgent[];
  tasks: ObservedHarnessTask[];
  relationships: ObservedHarnessRelationship[];
  sourceRefs?: ObservedHarnessSourceRef[];
  limitations?: string[];
}

export interface ObservedHarnessSourceRef {
  id: string;
  kind: "file" | "directory" | "event" | "provider";
  ref: string;
  label?: string;
}

export interface ObservedHarnessGroup {
  id: string;
  kind: "team" | string;
  name?: string;
  sourceRef?: string;
  providerMeta?: Record<string, unknown>;
}

export interface ObservedHarnessAgent {
  id: string;
  name?: string;
  role?: string;
  type?: string;
  status?: string;
  externalSessionId?: string;
  cwd?: string;
  model?: string;
  sourceRef?: string;
  providerMeta?: Record<string, unknown>;
}

export interface ObservedHarnessTask {
  id: string;
  title?: string;
  state?: string;
  assigneeId?: string;
  dependencyIds?: string[];
  sourceRef?: string;
  providerMeta?: Record<string, unknown>;
}

export interface ObservedHarnessRelationship {
  id: string;
  kind: "leads" | "member_of" | "spawned" | "assigned_to" | "depends_on" | string;
  fromId: string;
  toId: string;
  sourceRef?: string;
  providerMeta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Turn — one request/response cycle within a session
// ---------------------------------------------------------------------------

export type TurnStatus = "started" | "streaming" | "completed" | "failed" | "stopped";

export interface Turn {
  /** Unique turn identifier. */
  id: string;
  /** Parent session. */
  sessionId: string;
  /** Lifecycle status. */
  status: TurnStatus;
  /** ISO-8601 timestamp when the turn started. */
  startedAt: string;
  /** ISO-8601 timestamp when the turn reached a terminal state. */
  endedAt?: string;
  /** Ordered sequence of content blocks produced during this turn. */
  blocks: Block[];
}

// ---------------------------------------------------------------------------
// Block — a discrete unit of content within a turn
//
// Aligned with AI SDK V3 content types:
//   text       → LanguageModelV3TextContent
//   reasoning  → LanguageModelV3ReasoningContent
//   action     → LanguageModelV3ToolCall + ToolResult (unified)
//   file       → LanguageModelV3FileContent
//   error      → (no direct equivalent — protocol extension)
//   question   → AskUserQuestion interactive prompt (protocol extension)
// ---------------------------------------------------------------------------

export type BlockStatus = "started" | "streaming" | "completed" | "failed";

export type Block = TextBlock | ReasoningBlock | ActionBlock | FileBlock | ErrorBlock | QuestionBlock;

interface BlockBase {
  /** Unique block identifier within the turn. */
  id: string;
  /** Parent turn. */
  turnId: string;
  /** Lifecycle status. */
  status: BlockStatus;
  /** Monotonic index for stable ordering. */
  index: number;
}

/** Free-form text from the agent (markdown). */
export interface TextBlock extends BlockBase {
  type: "text";
  text: string;
}

/** Agent's internal reasoning / chain-of-thought (may be collapsed in UI). */
export interface ReasoningBlock extends BlockBase {
  type: "reasoning";
  text: string;
}

/**
 * The agent performing an action.  The `kind` field carries structured
 * metadata so the client can render specialized views (diff viewer for
 * file_change, terminal for command, generic card for unknown tools).
 *
 * Aligns with AI SDK V3 tool-call + tool-result, but unified into a single
 * block with lifecycle tracking rather than two separate content parts.
 */
export interface ActionBlock extends BlockBase {
  type: "action";
  action: Action;
}

/** File content produced by the agent (images, generated files). */
export interface FileBlock extends BlockBase {
  type: "file";
  /** MIME type (e.g. "image/png", "text/plain"). */
  mimeType: string;
  /** File name or path, if known. */
  name?: string;
  /** Base64-encoded data, or a URI reference. */
  data: string;
}

/** Something went wrong during this block. */
export interface ErrorBlock extends BlockBase {
  type: "error";
  message: string;
  code?: string;
  truncation?: {
    omittedBytes: number;
    maxRetainedBytes: number;
    sourceRef?: string;
  };
}

/**
 * The agent is asking the user a question (AskUserQuestion tool call).
 * Status lifecycle:
 *   "awaiting_answer" → user sees the card and picks an option
 *   "answered"        → user replied; answer is recorded
 *   "denied"          → the tool was blocked (permission denial)
 */
export type QuestionBlockStatus = "awaiting_answer" | "answered" | "denied";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionBlock extends BlockBase {
  type: "question";
  /** Short header shown above the question (e.g. "Next surface"). */
  header?: string;
  /** The question text. */
  question: string;
  /** Selectable options, if any. */
  options: QuestionOption[];
  /** Whether multiple options can be selected. */
  multiSelect: boolean;
  /** Current question lifecycle status. */
  questionStatus: QuestionBlockStatus;
  /** The user's chosen answer label(s), set once answered. */
  answer?: string[];
}

// ---------------------------------------------------------------------------
// Action variants — the `kind` discriminator on ActionBlock
// ---------------------------------------------------------------------------

export type Action =
  | FileChangeAction
  | CommandAction
  | ToolCallAction
  | SubagentAction;

interface ActionBase {
  /** Current status of the action. */
  status: "pending" | "running" | "completed" | "failed" | "awaiting_approval";
  /** Streaming output text (terminal output, diff chunks, etc.). */
  output: string;

  /**
   * Present when retained action payload or output was truncated to the
   * StateTracker / normalizer backlog cap (SCO-042-C009).
   */
  truncation?: {
    omittedBytes: number;
    maxRetainedBytes: number;
    sourceRef?: string;
  };

  /** Present when status is "awaiting_approval". */
  approval?: {
    /** Monotonic version — incremented each time this action's approval
     *  state changes. Prevents stale client responses from taking effect. */
    version: number;
    /** Human-readable description of what's being requested. */
    description?: string;
    /** Risk level hint for UI treatment (color, prominence). */
    risk?: "low" | "medium" | "high";
  };
}

/** Agent editing a file (maps to AI SDK file-change tool pattern). */
export interface FileChangeAction extends ActionBase {
  kind: "file_change";
  path: string;
  diff?: string;
}

/** Agent executing a shell command. */
export interface CommandAction extends ActionBase {
  kind: "command";
  command: string;
  exitCode?: number;
}

/** Generic tool invocation (AI SDK V3 tool-call). */
export interface ToolCallAction extends ActionBase {
  kind: "tool_call";
  toolName: string;
  toolCallId: string;
  input?: unknown;
  result?: unknown;
}

/** Agent spawning or coordinating with a sub-agent. */
export interface SubagentAction extends ActionBase {
  kind: "subagent";
  agentId: string;
  agentName?: string;
  prompt?: string;
}

// ---------------------------------------------------------------------------
// Delta — a streaming update to a block
//
// Mirrors the AI SDK V3 stream part lifecycle:
//   block:start  → text-start / reasoning-start / tool-input-start
//   block:delta  → text-delta / reasoning-delta / tool-input-delta
//   block:end    → text-end / reasoning-end / tool-output-available
// ---------------------------------------------------------------------------

export type Delta =
  | BlockStartDelta
  | BlockTextDelta
  | BlockActionOutputDelta
  | BlockActionStatusDelta
  | BlockActionApprovalDelta
  | BlockQuestionAnswerDelta
  | BlockEndDelta;

/** A new block has started within a turn. */
export interface BlockStartDelta {
  event: "block:start";
  sessionId: string;
  turnId: string;
  block: Block;
}

/** Append text to a text or reasoning block. */
export interface BlockTextDelta {
  event: "block:delta";
  sessionId: string;
  turnId: string;
  blockId: string;
  text: string;
}

/** Append output to an action block (terminal output, diff chunk, etc.). */
export interface BlockActionOutputDelta {
  event: "block:action:output";
  sessionId: string;
  turnId: string;
  blockId: string;
  output: string;
  /** Bytes omitted from this output delta, not a cumulative block total. */
  truncation?: {
    omittedBytes: number;
    maxRetainedBytes: number;
    sourceRef: string;
  };
}

/** Action status changed (pending → running → completed/failed). */
export interface BlockActionStatusDelta {
  event: "block:action:status";
  sessionId: string;
  turnId: string;
  blockId: string;
  status: Action["status"];
  /** Set on completion — exit code, result, etc. */
  meta?: Record<string, unknown>;
}

/** Structured ACP request data, not inferred from the approval card text. */
export type AcpPermissionToolCall = {
  title?: unknown;
  kind?: unknown;
  rawInput?: unknown;
  locations?: unknown;
  offersAllowOnce: boolean;
};

/** Action transitioned to awaiting_approval — client renders approve/deny UI. */
export interface BlockActionApprovalDelta {
  event: "block:action:approval";
  sessionId: string;
  turnId: string;
  blockId: string;
  approval: {
    version: number;
    description?: string;
    risk?: "low" | "medium" | "high";
    acpToolCall?: AcpPermissionToolCall;
  };
}

/** User answered a question block — updates questionStatus + answer. */
export interface BlockQuestionAnswerDelta {
  event: "block:question:answer";
  sessionId: string;
  turnId: string;
  blockId: string;
  questionStatus: QuestionBlockStatus;
  answer?: string[];
}

/** A block has reached a terminal state. */
export interface BlockEndDelta {
  event: "block:end";
  sessionId: string;
  turnId: string;
  blockId: string;
  status: BlockStatus;
}

// ---------------------------------------------------------------------------
// Turn lifecycle events
// ---------------------------------------------------------------------------

export type TurnEvent =
  | { event: "turn:start"; sessionId: string; turn: Turn }
  | { event: "turn:end"; sessionId: string; turnId: string; status: TurnStatus }
  | { event: "turn:error"; sessionId: string; turnId: string; message: string };

// ---------------------------------------------------------------------------
// Session lifecycle events
// ---------------------------------------------------------------------------

export type SessionEvent =
  | { event: "session:update"; session: Session }
  | { event: "session:closed"; sessionId: string };

// ---------------------------------------------------------------------------
// AgentSessionStreamEvent — the wire union of all session messages
// ---------------------------------------------------------------------------

export type AgentSessionStreamEvent = Delta | TurnEvent | SessionEvent;

// ---------------------------------------------------------------------------
// Prompt — user input going into a session
// ---------------------------------------------------------------------------

export interface Prompt {
  /** Target session. */
  sessionId: string;
  /** Text content. */
  text: string;
  /** File paths mentioned / attached. */
  files?: string[];
  /** Images attached (base64). */
  images?: Array<{ mimeType: string; data: string }>;
  /** Provider-specific options pass-through. */
  providerOptions?: Record<string, unknown>;
}

/** User answering a QuestionBlock. Routed from client → embedding runtime → adapter. */
export interface QuestionAnswer {
  sessionId: string;
  /** The block ID of the QuestionBlock being answered. */
  blockId: string;
  /** Selected option labels. */
  answer: string[];
}
