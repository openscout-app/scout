import type { ClassifiedPrompt } from "@openscout/agent-sessions";
import type { ObservedSessionSource } from "@openscout/protocol";

/**
 * Launch attribution for a tailed transcript. The runtime/harness name shown
 * to users is carried by `source` ("claude", "codex", "quad", ...).
 */
export type TailAttribution = "scout-managed" | "hudson-managed" | "unattributed";

/** @deprecated Use TailAttribution for the `harness` field. */
export type TailHarness = TailAttribution;

export type TailDiscoveryScope = "hot" | "shallow" | "deep";

export type TailDiscoveryOptions = {
  force?: boolean;
  scope?: TailDiscoveryScope;
  limit?: number;
};

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
  /** A user turn split by its harness's adapter into the operator's words and
   *  the harness's own markup. Present when the source's adapter classifies
   *  prompts; render from this rather than parsing `summary`. */
  prompt?: ClassifiedPrompt;
  raw?: unknown;
};

export type DiscoveredProcess = {
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

/**
 * The tool call a waiting session asks about, as its own prompt shows it:
 * a heading ("Bash command", "Edit file") and the command, path or address.
 * Observed from the transcript; it is context, not an answer path.
 */
export type TailPendingToolCall = {
  toolUseId: string;
  tool: string;
  title: string;
  subject: string | null;
  detail: string | null;
  subjectKind: "command" | "path" | "url" | "query" | "arguments" | null;
  at: number | null;
  alsoPending: number;
};

export type DiscoveredTranscript = {
  /** Harness-native title (custom title > agent name > AI title; newest of each wins). */
  title?: string | null;
  /** Claude registry values, without inferred busy/idle semantics. */
  status?: "busy" | "idle" | "shell" | "waiting" | null;
  statusUpdatedAt?: number | null;
  waitingFor?: string | null;
  attention?: {
    kind: "ask";
    source: "herdr" | "registry";
    reason?: string | null;
    since?: number | null;
    /** The call the session waits on, read from its transcript (a tool_use with no tool_result). */
    pending?: TailPendingToolCall | null;
  } | null;
  /** Claude workflow run containing this child transcript. */
  workflowRunId?: string | null;

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
  /** Timestamp of the latest parseable event in the transcript, when available. */
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

export type DiscoverySnapshot = {
  /** Availability belongs to the cached pass, not the time of this read. */
  readStatus?: { initialized: boolean; scope: TailDiscoveryScope | null; sources: ObservedSessionSource[] };
  generatedAt: number;
  processes: DiscoveredProcess[];
  transcripts: DiscoveredTranscript[];
  issues?: TailDiscoveryIssue[];
  totals: {
    total: number;
    scoutManaged: number;
    hudsonManaged: number;
    unattributed: number;
    transcripts: number;
  };
};

export type TailContext = {
  process: DiscoveredProcess;
  transcript: DiscoveredTranscript;
  transcriptPath: string;
  lineOffset: number;
  /**
   * Per-transcript parser scratch space. Sources that need to correlate adjacent
   * records, such as tool calls and later tool results, can store lightweight
   * derived state here without changing the wire event shape.
   */
  state?: Record<string, unknown>;
};

export interface TranscriptSource {
  readonly name: string;
  /** Empty legacy adapters can hide IO failures; only an explicit report proves empty. */
  discoveryAvailability?: () => "available" | "unavailable" | "unknown";
  discoverProcesses(): Promise<DiscoveredProcess[]> | DiscoveredProcess[];
  discoverTranscripts(
    processes: DiscoveredProcess[],
    scope?: TailDiscoveryScope,
  ): Promise<DiscoveredTranscript[]> | DiscoveredTranscript[];
  parseLine(line: string, ctx: TailContext): TailEvent | null;
  parseFile?(text: string, ctx: TailContext): TailEvent | TailEvent[] | null;
  /** Locate one exact session outside the discovery activity window. */
  findTranscript?(sessionRef: string): DiscoveredTranscript | null;
}
