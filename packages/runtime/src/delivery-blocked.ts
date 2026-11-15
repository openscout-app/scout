/**
 * Delivery failed for a reason that says nothing bad about the endpoint's
 * process: the harness is alive but cannot work (logged out), Scout refused
 * to type into a live session that is not the one the ask named, or an ask
 * could not be delivered into the place a session is open. The flight fails
 * with the reason; the endpoint keeps its pre-invocation state so later asks
 * still route to it.
 */
export type DeliveryBlockedStage =
  | "harness_not_logged_in"
  | "exact_session_mismatch"
  /** The session is open, and which pane holds it could not be verified. */
  | "in_place_unverified"
  /** The session is running where Scout cannot type. */
  | "in_place_unreachable"
  /** Neither the place nor the harness says whether the session is mid-turn. */
  | "in_place_activity_unknown"
  /** The session stayed busy for the whole hold. */
  | "in_place_hold_expired"
  /** Typing into the place failed. */
  | "in_place_failed"
  /** The turn that took the ask was interrupted. */
  | "in_place_turn_aborted"
  /** The session was closed after the ask was typed and before it answered. */
  | "in_place_session_closed"
  /** The ask names the session that sent it. */
  | "in_place_self";

export class DeliveryBlockedError extends Error {
  readonly code = "DELIVERY_BLOCKED";
  readonly stage: DeliveryBlockedStage;
  /** One short sentence for the flight summary. */
  readonly summary: string;

  constructor(input: { stage: DeliveryBlockedStage; summary: string; message: string }) {
    super(input.message);
    this.name = "DeliveryBlockedError";
    this.stage = input.stage;
    this.summary = input.summary;
  }
}

export function isDeliveryBlockedError(error: unknown): error is DeliveryBlockedError {
  return error instanceof DeliveryBlockedError
    || (
      Boolean(error)
      && typeof error === "object"
      && (error as { code?: unknown }).code === "DELIVERY_BLOCKED"
      && typeof (error as { stage?: unknown }).stage === "string"
      && typeof (error as { summary?: unknown }).summary === "string"
    );
}
