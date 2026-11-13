import { parseReplyWaitingOn, type FlightRecord, type InvocationRequest, type ReplyWaitingOn } from "./invocations.js";
import type { MessageRecord } from "./messages.js";

/** Opt-in v1: ordinary asks retain their existing final-response behavior. */
export type ScoutCompletionRequest = { mode: "explicit" };
export type ScoutCompletionRelation = { parentFlightId: string; kind: "joined" | "continuation" };
export type ScoutCompletionReply = {
  /** `blocked` keeps the task open and moves its flight to waiting on `waitingOn`. */
  kind: "progress" | "final" | "blocked";
  outcome?: "failed";
  waitingOn?: ReplyWaitingOn;
  /**
   * Set by the runtime on a final reply that arrived while its flight waited
   * on an open permission request: it was recorded as blocked instead.
   */
  held?: "final";
  invocationId: string;
  flightId: string;
  revision: number;
};
export type ScoutCompletionState = {
  version: 1;
  revision: number;
  obligations: Array<{ invocationId: string; flightId: string; kind: "joined" | "continuation" }>;
  /** The execution ended; only an explicit broker reply may finish this ask. */
  awaitingFinal?: boolean;
};
export const SCOUT_COMPLETION_CAPABILITY = "explicit-completion/1";
export const SCOUT_COMPLETION_MAX_OBLIGATIONS = 64;
export function hasExplicitCompletion(invocation: InvocationRequest): boolean {
  return (invocation.metadata?.completion as ScoutCompletionRequest | undefined)?.mode === "explicit";
}
export function flightCompletion(flight: Pick<FlightRecord, "metadata"> | null | undefined): ScoutCompletionState | undefined {
  const value = flight?.metadata?.completion as ScoutCompletionState | undefined;
  if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.obligations) || value.obligations.length > SCOUT_COMPLETION_MAX_OBLIGATIONS
    || value.obligations.some(item => !item || typeof item.invocationId !== "string" || !item.invocationId
      || typeof item.flightId !== "string" || !item.flightId || (item.kind !== "joined" && item.kind !== "continuation"))) return undefined;
  return value;
}
export function completionReply(message: Pick<MessageRecord, "metadata">): ScoutCompletionReply | undefined {
  const value = message.metadata?.completionReply as ScoutCompletionReply | undefined;
  return value && (value.kind === "progress" || value.kind === "final"
    || (value.kind === "blocked" && value.outcome === undefined && parseReplyWaitingOn(value.waitingOn) !== undefined))
    && typeof value.invocationId === "string" && Boolean(value.invocationId)
    && typeof value.flightId === "string" && Boolean(value.flightId)
    && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value : undefined;
}

/** The reply as its sender submitted it, before the runtime held a final as blocked. */
export function submittedCompletionReply(reply: ScoutCompletionReply | undefined): ScoutCompletionReply | undefined {
  if (reply?.held !== "final") return reply;
  const { held: _held, waitingOn: _waitingOn, ...submitted } = reply;
  return { ...submitted, kind: "final" };
}
