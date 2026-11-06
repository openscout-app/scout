import type { AgentHarness } from "./actors.js";
import type { MetadataMap, ScoutId } from "./common.js";
import type { ScoutPermissionProfile } from "./permission-policy.js";
import type { ScoutExecutionResolution } from "./runtime-execution.js";

export type InvocationAction =
  | "consult"
  | "execute"
  | "summarize"
  | "status"
  | "wake";

export type FlightState =
  | "queued"
  | "waking"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type InvocationSessionPolicy =
  | "new"
  | "reuse"
  | "existing"
  | "fork"
  /** @deprecated use reuse */
  | "any";

/**
 * Where a newly created harness session should be discoverable.
 * `attached` (Codex only) runs the session on an already-running Codex
 * app-server (the daemon control socket) instead of a Scout-spawned one.
 */
export type SessionPlacement = "background" | "foreground" | "attached";

export type InvocationForkSourceKind =
  | "native_thread_clone"
  | "scout_state_snapshot";

export interface InvocationForkContextOptions {
  maxMessages?: number;
  maxBytes?: number;
  includeBrokerRecords?: boolean;
  includeObservedHarnessMaterial?: boolean;
}

export interface InvocationSessionLineage {
  parentSessionId?: ScoutId;
  parentHarnessThreadId?: string;
  forkSourceKind?: InvocationForkSourceKind;
  forkSourceId?: ScoutId | string;
  forkedAt?: number;
  metadata?: MetadataMap;
}

export interface InvocationExecutionPreference {
  harness?: AgentHarness;
  model?: string;
  reasoningEffort?: string;
  permissionProfile?: ScoutPermissionProfile;
  /**
   * Background sessions use Scout-managed harness state. Foreground sessions
   * use the operator's native harness state so the task is openable there.
   */
  placement?: SessionPlacement;
  /**
   * Controls whether work should enter fresh model context, opportunistically
   * reuse a warm compatible session, continue one exact session, or fork a new
   * execution session from prior state. The legacy "any" value is a
   * compatibility alias for "reuse"; exact continuation requires targetSessionId.
   */
  session?: InvocationSessionPolicy;
  targetSessionId?: ScoutId;
  forkFromStateId?: ScoutId;
  forkFromSessionId?: ScoutId;
  forkContext?: InvocationForkContextOptions;
  lineage?: InvocationSessionLineage;
  /**
   * Hard per-turn execution budget in milliseconds, honoured only by the ACP
   * wrappers (Grok, Kimi, OpenCode, Devin, Cursor). Tmux, Claude stream-JSON,
   * Codex app-server, and Pi RPC do not implement a turn budget. Distinct
   * from the requester's wait budget (`timeoutMs`): a caller willing to wait
   * 24 h does not license a 24 h turn. When set it takes precedence over the
   * OPENSCOUT_ACP_HARD_CEILING_MS default (typically to raise it); bounded to
   * 6 h at the command boundary and always clamped to the administrator
   * maximum OPENSCOUT_ACP_HARD_CEILING_MAX_MS (default 6 h).
   */
  turnBudgetMs?: number;
}

/** Correlation only; neither origin nor trace creates a completion dependency. */
export interface AskOrigin {
  sessionAddress?: string;
  runningFlightId?: ScoutId;
  source: "verified" | "claimed" | "unknown";
}

/** Nonzero lowercase W3C trace and span identifiers. */
export interface AskTrace {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface InvocationRequest {
  origin: AskOrigin;
  /** Absent only on asks recorded before trace context was introduced. */
  trace?: AskTrace;
  /** Input carrier only. The runtime consumes it at creation, never on replay. */
  traceparent?: string;
  /** Caller-supplied, requester-scoped idempotency key. */
  requestId?: string;
  id: ScoutId;
  requesterId: ScoutId;
  requesterNodeId: ScoutId;
  targetAgentId: ScoutId;
  targetNodeId?: ScoutId;
  action: InvocationAction;
  task: string;
  collaborationRecordId?: ScoutId;
  conversationId?: ScoutId;
  messageId?: ScoutId;
  context?: MetadataMap;
  execution?: InvocationExecutionPreference;
  executionResolution?: ScoutExecutionResolution;
  ensureAwake: boolean;
  stream: boolean;
  timeoutMs?: number;
  labels?: string[];
  createdAt: number;
  metadata?: MetadataMap;
}

/** A new flight cannot be planned without its creation-time trace. */
export interface TracedInvocationRequest extends InvocationRequest {
  trace: AskTrace;
}

export interface FlightRecord {
  id: ScoutId;
  invocationId: ScoutId;
  requesterId: ScoutId;
  targetAgentId: ScoutId;
  state: FlightState;
  summary?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  labels?: string[];
  metadata?: MetadataMap;
}

/**
 * One concrete harness session used while executing a flight. Flights are the
 * stable coordination handle; sessions are ephemeral execution resources and
 * may change when a dispatch is retried, resumed, or replaced.
 */
export interface FlightSessionTraceEntry {
  sessionId: ScoutId;
  endpointId?: ScoutId;
  nodeId?: ScoutId;
  harness?: AgentHarness;
  transport?: string;
  strategy?: string;
  placement?: SessionPlacement;
  executionResolution?: ScoutExecutionResolution;
  startedAt: number;
  lastAcknowledgedAt: number;
  endedAt?: number;
}

export interface FlightDispatchAcknowledgement {
  sessionId?: ScoutId | null;
  /**
   * Provisional session id replaced by `sessionId` for this same dispatch.
   * Absent for a real transition between two concrete provider sessions.
   */
  refinesSessionId?: ScoutId | null;
  endpointId?: ScoutId | null;
  nodeId?: ScoutId | null;
  harness?: AgentHarness | null;
  transport?: string | null;
  strategy?: string | null;
  placement?: SessionPlacement | null;
  executionResolution?: ScoutExecutionResolution | null;
  acknowledgedAt?: number | null;
}

function cleanTraceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanTraceTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function cleanTracePlacement(value: unknown): SessionPlacement | undefined {
  return value === "background" || value === "foreground" || value === "attached" ? value : undefined;
}

function parseFlightSessionTraceEntry(value: unknown): FlightSessionTraceEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = cleanTraceString(record.sessionId);
  const startedAt = cleanTraceTimestamp(record.startedAt);
  const lastAcknowledgedAt = cleanTraceTimestamp(record.lastAcknowledgedAt) ?? startedAt;
  if (!sessionId || startedAt === undefined || lastAcknowledgedAt === undefined) return null;
  const harness = cleanTraceString(record.harness);
  const executionResolution = record.executionResolution
    && typeof record.executionResolution === "object"
    && !Array.isArray(record.executionResolution)
    ? record.executionResolution as ScoutExecutionResolution
    : undefined;
  return {
    sessionId,
    ...(cleanTraceString(record.endpointId) ? { endpointId: cleanTraceString(record.endpointId) } : {}),
    ...(cleanTraceString(record.nodeId) ? { nodeId: cleanTraceString(record.nodeId) } : {}),
    ...(harness ? { harness: harness as AgentHarness } : {}),
    ...(cleanTraceString(record.transport) ? { transport: cleanTraceString(record.transport) } : {}),
    ...(cleanTraceString(record.strategy) ? { strategy: cleanTraceString(record.strategy) } : {}),
    ...(cleanTracePlacement(record.placement) ? { placement: cleanTracePlacement(record.placement) } : {}),
    ...(executionResolution ? { executionResolution } : {}),
    startedAt,
    lastAcknowledgedAt,
    ...(cleanTraceTimestamp(record.endedAt) !== undefined
      ? { endedAt: cleanTraceTimestamp(record.endedAt) }
      : {}),
  };
}

function parseDispatchAcknowledgement(value: unknown): FlightDispatchAcknowledgement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = cleanTraceString(record.sessionId);
  const acknowledgedAt = cleanTraceTimestamp(record.acknowledgedAt);
  if (!sessionId || acknowledgedAt === undefined) return null;
  const harness = cleanTraceString(record.harness);
  const executionResolution = record.executionResolution
    && typeof record.executionResolution === "object"
    && !Array.isArray(record.executionResolution)
    ? record.executionResolution as ScoutExecutionResolution
    : null;
  return {
    sessionId,
    refinesSessionId: cleanTraceString(record.refinesSessionId) ?? null,
    endpointId: cleanTraceString(record.endpointId) ?? null,
    nodeId: cleanTraceString(record.nodeId) ?? null,
    harness: harness ? harness as AgentHarness : null,
    transport: cleanTraceString(record.transport) ?? null,
    strategy: cleanTraceString(record.strategy) ?? null,
    placement: cleanTracePlacement(record.placement) ?? null,
    executionResolution,
    acknowledgedAt,
  };
}

/**
 * Read a flight's ordered session history. Legacy records that only contain a
 * dispatch acknowledgement are projected as a one-session trace.
 */
export function flightSessionTrace(
  flightOrMetadata: Pick<FlightRecord, "metadata"> | MetadataMap | null | undefined,
): FlightSessionTraceEntry[] {
  const metadata = (
    flightOrMetadata && "metadata" in flightOrMetadata
      ? (flightOrMetadata as Pick<FlightRecord, "metadata">).metadata
      : flightOrMetadata
  ) as MetadataMap | null | undefined;
  const recorded = Array.isArray(metadata?.sessionTrace)
    ? metadata.sessionTrace
      .map(parseFlightSessionTraceEntry)
      .filter((entry): entry is FlightSessionTraceEntry => entry !== null)
    : [];
  if (recorded.length > 0) return recorded;

  const dispatchAck = parseDispatchAcknowledgement(metadata?.dispatchAck);
  if (!dispatchAck?.sessionId || dispatchAck.acknowledgedAt === null || dispatchAck.acknowledgedAt === undefined) {
    return [];
  }
  return [{
    sessionId: dispatchAck.sessionId,
    ...(dispatchAck.endpointId ? { endpointId: dispatchAck.endpointId } : {}),
    ...(dispatchAck.nodeId ? { nodeId: dispatchAck.nodeId } : {}),
    ...(dispatchAck.harness ? { harness: dispatchAck.harness } : {}),
    ...(dispatchAck.transport ? { transport: dispatchAck.transport } : {}),
    ...(dispatchAck.strategy ? { strategy: dispatchAck.strategy } : {}),
    ...(dispatchAck.placement ? { placement: dispatchAck.placement } : {}),
    startedAt: dispatchAck.acknowledgedAt,
    lastAcknowledgedAt: dispatchAck.acknowledgedAt,
  }];
}

/** Append a dispatch acknowledgement without losing earlier session identity. */
export function recordFlightSessionDispatch(
  metadata: MetadataMap | null | undefined,
  acknowledgement: unknown,
): MetadataMap {
  const dispatchAck = parseDispatchAcknowledgement(acknowledgement);
  const nextMetadata: MetadataMap = { ...(metadata ?? {}), dispatchAck: acknowledgement };
  if (!dispatchAck?.sessionId || dispatchAck.acknowledgedAt === null || dispatchAck.acknowledgedAt === undefined) {
    return nextMetadata;
  }

  const trace = flightSessionTrace(metadata).map((entry) => ({ ...entry }));
  const previous = trace.at(-1);
  const refinesSameDispatch = Boolean(
    previous
    && dispatchAck.refinesSessionId
    && previous.sessionId === dispatchAck.refinesSessionId
    && previous.sessionId !== dispatchAck.sessionId
    && previous.endpointId
    && dispatchAck.endpointId
    && previous.endpointId === dispatchAck.endpointId
    && previous.startedAt === dispatchAck.acknowledgedAt,
  );
  if (
    previous
    && (previous.sessionId === dispatchAck.sessionId || refinesSameDispatch)
    && (previous.endpointId ?? null) === (dispatchAck.endpointId ?? null)
  ) {
    // A transport can acknowledge with Scout's provisional routing id, then
    // refine that same acknowledgement once the provider id is known. The
    // unchanged endpoint and timestamp prove this is identity promotion, not
    // a second harness session span.
    if (refinesSameDispatch) {
      previous.sessionId = dispatchAck.sessionId;
    }
    previous.lastAcknowledgedAt = Math.max(previous.lastAcknowledgedAt, dispatchAck.acknowledgedAt);
    previous.strategy = dispatchAck.strategy ?? previous.strategy;
    previous.placement = dispatchAck.placement ?? previous.placement;
    previous.harness = dispatchAck.harness ?? previous.harness;
    previous.transport = dispatchAck.transport ?? previous.transport;
    previous.nodeId = dispatchAck.nodeId ?? previous.nodeId;
    previous.executionResolution = dispatchAck.executionResolution ?? previous.executionResolution;
    delete previous.endedAt;
  } else {
    if (previous && previous.endedAt === undefined) {
      previous.endedAt = dispatchAck.acknowledgedAt;
    }
    trace.push({
      sessionId: dispatchAck.sessionId,
      ...(dispatchAck.endpointId ? { endpointId: dispatchAck.endpointId } : {}),
      ...(dispatchAck.nodeId ? { nodeId: dispatchAck.nodeId } : {}),
      ...(dispatchAck.harness ? { harness: dispatchAck.harness } : {}),
      ...(dispatchAck.transport ? { transport: dispatchAck.transport } : {}),
      ...(dispatchAck.strategy ? { strategy: dispatchAck.strategy } : {}),
      ...(dispatchAck.placement ? { placement: dispatchAck.placement } : {}),
      ...(dispatchAck.executionResolution ? { executionResolution: dispatchAck.executionResolution } : {}),
      startedAt: dispatchAck.acknowledgedAt,
      lastAcknowledgedAt: dispatchAck.acknowledgedAt,
    });
  }
  nextMetadata.sessionTrace = trace;
  return nextMetadata;
}

/**
 * Mutable execution status for an invocation. Every field is optional — a
 * freshly-created invocation has no flight or status yet.
 *
 * Note the dispatch job's scheduler state (attempts / leaseOwner /
 * leaseExpiresAt / lastError) is deliberately NOT part of this: it is a distinct
 * concern (worker-lease mechanics), stays its own journal-backed record, and is
 * surfaced separately rather than folded into the domain status.
 */
export interface InvocationStatus {
  /**
   * Durable secondary id of the invocation's flight. Retained as a stable alias
   * so projected run ids (`run:flight:<flightId>`) and follow links survive the
   * flight→invocation storage merge.
   */
  flightId?: ScoutId;
  state?: FlightState;
  summary?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

/**
 * The merged invocation record: the immutable request ({@link InvocationRequest})
 * plus its mutable execution status ({@link InvocationStatus}). This is the
 * single source of truth, from which the flight / work-item / agent-run views are
 * projected. The standalone {@link FlightRecord} remains a compatibility shape
 * over the same status subset.
 */
export type Invocation = InvocationRequest & InvocationStatus;

export function normalizeInvocationSessionPolicy(
  policy: InvocationSessionPolicy | string | null | undefined,
): InvocationSessionPolicy | undefined {
  switch (policy) {
    case "new":
    case "reuse":
    case "existing":
    case "fork":
    case "any":
      return policy;
    default:
      return undefined;
  }
}

export function effectiveInvocationSessionPolicy(
  execution: Pick<
    InvocationExecutionPreference,
    "session" | "targetSessionId" | "forkFromStateId" | "forkFromSessionId"
  > | null | undefined,
): Exclude<InvocationSessionPolicy, "any"> {
  if (!execution) return "new";
  if (execution.forkFromStateId || execution.forkFromSessionId || execution.session === "fork") {
    return "fork";
  }
  if (execution.targetSessionId || execution.session === "existing") {
    return "existing";
  }
  if (execution.session === "reuse" || execution.session === "any") {
    return "reuse";
  }
  return "new";
}

export function validateInvocationExecutionPreference(
  execution: InvocationExecutionPreference | null | undefined,
): string[] {
  if (!execution) return [];

  const errors: string[] = [];
  const policy = effectiveInvocationSessionPolicy(execution);

  if (policy === "existing" && !execution.targetSessionId) {
    errors.push("session existing requires targetSessionId");
  }
  if (policy === "fork" && !execution.forkFromStateId && !execution.forkFromSessionId) {
    errors.push("session fork requires forkFromStateId or forkFromSessionId");
  }
  if (execution.session === "new" && execution.targetSessionId) {
    errors.push("session new cannot target an existing session");
  }
  if (execution.session === "new" && (execution.forkFromStateId || execution.forkFromSessionId)) {
    errors.push("session new cannot include fork source ids");
  }

  return errors;
}
