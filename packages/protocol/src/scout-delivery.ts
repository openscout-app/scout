import type { ScoutCompletionRequest, ScoutCompletionRelation } from "./completion.js";
import type { ConversationDefinition } from "./conversations.js";
import type { MetadataMap, ScoutId } from "./common.js";
import type {
  CollaborationAcceptanceState,
  CollaborationPriority,
  WorkItemRecord,
} from "./collaboration.js";
import type { FlightRecord, InvocationExecutionPreference } from "./invocations.js";
import type { MessageAttachment, MessageRecord } from "./messages.js";
import type {
  ScoutCallerContext,
  ScoutDispatchRecord,
  ScoutRoutePolicy,
  ScoutRouteTarget,
} from "./scout-dispatch.js";
import type { RouteAliasResolutionProof } from "./route-aliases.js";
import type {
  ScoutExecutionResolution,
  ScoutRuntimeResolutionSource,
} from "./runtime-execution.js";

export type ScoutDeliverIntent = "tell" | "consult";

export type ScoutOperatorSignalKind = "notify" | "consult" | "need";

/**
 * An agent-authored signal for its human operator.
 *
 * The three kinds are separated by what the agent does next, which is the only
 * distinction the operator actually acts on:
 *
 *   notify  — FYI. The agent keeps going and expects nothing back.
 *   consult — input would help, and the agent has already decided what it will
 *             do without it (`defaultAction`). Silence is a valid answer.
 *   need    — the agent cannot proceed. Silence is NOT an answer, so this is
 *             the only kind that is blocking, and the only one that raises the
 *             operator's requests surface.
 *
 * `notify` and `consult` stay conversational side effects: they never create a
 * flight and never imply the agent is waiting. `need` is the exception on
 * purpose — it is the agent declaring that the next move is yours.
 *
 * This is the declared counterpart to harness-level attention inference. An
 * inferred stall says "something looks stuck"; a `need` says "here is exactly
 * what I want from you", authored by the agent, and cannot be created without
 * a question (enforced at the CLI boundary, not filtered downstream).
 */
export type ScoutOperatorSignal =
  | {
      kind: "notify";
      blocking: false;
      replyExpectation: "none";
    }
  | {
      kind: "consult";
      blocking: false;
      replyExpectation: "optional";
      defaultAction: string;
    }
  | {
      kind: "need";
      blocking: true;
      replyExpectation: "required";
      /** What the agent is asking for. Never empty — that is the whole point. */
      question: string;
      requestKind?: "permission";
      /** Optional discrete choices, when the answer is a selection. */
      options?: string[];
      /** Why the agent cannot continue without it. */
      blockedReason?: string;
    };

export type ScoutDeliverRouteKind = "dm" | "channel" | "broadcast";

export type ScoutProjectAgentPersistence = "one_time" | "sticky";

export interface ScoutProjectAgentSpec {
  persistence?: ScoutProjectAgentPersistence;
  /** Human-addressable handle, without requiring the caller to include "@". */
  handle?: string;
}

export type ScoutDeliveryRemediationKind =
  | "choose_target"
  | "register_target"
  | "wake_target"
  | "retry_later"
  | "use_current_registration"
  | "session_reference_not_attachable"
  /** @deprecated use use_current_registration or session_reference_not_attachable */
  | "stale_reference";

export type ScoutDeliverRejectReason =
  | "unknown_target"
  | "ambiguous_target"
  | "invalid_target"
  | "missing_target";

/** Advertised by /v1/node before clients may request live session input. */
export const SCOUT_SESSION_INPUT_RECEIPTS_CAPABILITY = "session-input-receipts/1";

/** Input submission is not an invocation or proof of execution completion. */
export interface ScoutSessionInputReceipt {
  kind: "in_place";
  state: "submitted";
  sessionId: ScoutId;
  harness: "claude" | "codex";
  via: "herdr" | "orca" | "tmux" | "lattices" | "scout-app";
  location: string;
}

export interface ScoutDeliverRequest {
  completion?: ScoutCompletionRequest;
  relation?: ScoutCompletionRelation;
  /** Caller-supplied, requester-scoped idempotency key. */
  requestId?: string;
  id?: ScoutId;
  caller?: ScoutCallerContext;
  requesterId?: ScoutId;
  requesterNodeId?: ScoutId;
  body: string;
  attachments?: MessageAttachment[];
  intent: ScoutDeliverIntent;
  /** Operator reply to an exact native session; requires the advertised capability and requestId. */
  sessionDelivery?: "in_place_or_resume";
  target?: ScoutRouteTarget;
  targetLabel?: string;
  targetAgentId?: ScoutId;
  targetSessionId?: ScoutId;
  routePolicy?: ScoutRoutePolicy;
  channel?: string;
  replyToMessageId?: ScoutId;
  replyToSessionId?: ScoutId;
  speechText?: string;
  ensureAwake?: boolean;
  execution?: InvocationExecutionPreference;
  executionSource?: Partial<Record<"harness" | "model" | "reasoningEffort", ScoutRuntimeResolutionSource>>;
  projectAgent?: ScoutProjectAgentSpec;
  labels?: string[];
  createdAt?: number;
  collaborationRecordId?: ScoutId;
  workItem?: {
    id?: ScoutId;
    title: string;
    summary?: string;
    priority?: CollaborationPriority;
    labels?: string[];
    parentId?: ScoutId;
    acceptanceState?: CollaborationAcceptanceState;
    metadata?: MetadataMap;
  };
  messageMetadata?: MetadataMap;
  invocationMetadata?: MetadataMap;
  operatorSignal?: ScoutOperatorSignal;
}

/** HTTP intent discriminant fences older brokers before any session-input side effect.
 * The current boundary normalizes session_input to the consult command above.
 */
export type ScoutDeliverHttpRequest = Omit<ScoutDeliverRequest, "intent"> & {
  intent: ScoutDeliverIntent | "session_input" | "explicit_consult";
};

export interface ScoutDeliveryReceipt {
  requestId: ScoutId;
  routeKind: ScoutDeliverRouteKind;
  requesterId: ScoutId;
  requesterNodeId: ScoutId;
  targetAgentId?: ScoutId;
  targetSessionId?: ScoutId;
  /** Copyable `sess.<token>@<host>` for exact continuation of the target session. */
  targetSessionAddress?: string;
  targetLabel?: string;
  /** Provisional routable pointer (e.g. project-chopin) when target is cardless. */
  sessionAlias?: string;
  bindingRef?: string;
  conversationId: ScoutId;
  messageId: ScoutId;
  flightId?: ScoutId;
  /** Per-dimension requested/resolved launch truth available at acceptance. */
  executionResolution?: ScoutExecutionResolution;
  acceptedAt: number;
  aliasResolution?: RouteAliasResolutionProof;
  inputSubmitted?: ScoutSessionInputReceipt;
}

export interface ScoutDeliveryRemediationAction {
  kind: ScoutDeliveryRemediationKind;
  detail: string;
  targetAgentId?: ScoutId;
  targetLabel?: string;
  dispatchId?: ScoutId;
}

export interface ScoutDeliverAcceptedResponse {
  kind: "delivery";
  accepted: true;
  routeKind: ScoutDeliverRouteKind;
  receipt: ScoutDeliveryReceipt;
  conversation: ConversationDefinition;
  message: MessageRecord;
  targetAgentId?: ScoutId;
  targetSessionId?: ScoutId;
  sessionAlias?: string;
  bindingRef?: string;
  aliasResolution?: RouteAliasResolutionProof;
  flight?: FlightRecord;
  workItem?: WorkItemRecord;
}

/**
 * A routing clarification: delivery was not accepted and the caller is asked to
 * clarify or re-route the carried {@link ScoutDispatchRecord}. This is unrelated to
 * the collaboration `question` kind ({@link QuestionRecord}) — the `question` field
 * here carries the dispatch, and the wire `kind` discriminant stays `"question"` for
 * backward compatibility.
 */
export interface ScoutDeliverClarificationResponse {
  kind: "question";
  accepted: false;
  question: ScoutDispatchRecord;
  remediation?: ScoutDeliveryRemediationAction;
}

/**
 * @deprecated Renamed to {@link ScoutDeliverClarificationResponse}. This routing
 * clarification is distinct from the collaboration `question` kind. Retained as an
 * alias for backward compatibility.
 */
export type ScoutDeliverQuestionResponse = ScoutDeliverClarificationResponse;

export interface ScoutDeliverRejectedResponse {
  kind: "rejected";
  accepted: false;
  reason: ScoutDeliverRejectReason;
  rejection: ScoutDispatchRecord;
  remediation?: ScoutDeliveryRemediationAction;
}

export type ScoutDeliverResponse =
  | ScoutDeliverAcceptedResponse
  | ScoutDeliverClarificationResponse
  | ScoutDeliverRejectedResponse;
