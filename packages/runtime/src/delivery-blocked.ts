/**
 * Delivery failed for a reason that says nothing bad about the endpoint's
 * process: the harness is alive but cannot work (logged out), or Scout refused
 * to type into a live session that is not the one the ask named. The flight
 * fails with the reason; the endpoint keeps its pre-invocation state so later
 * asks still route to it.
 */
export type DeliveryBlockedStage = "harness_not_logged_in" | "exact_session_mismatch";

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
