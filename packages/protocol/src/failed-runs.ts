import type { FlightRecord } from "./invocations.js";

export const FAILED_RUN_CAUSES = ["superseded", "endpoint_lost", "harness_start", "disk_full", "harness_error", "unknown"] as const;
export type FailedRunCause = typeof FAILED_RUN_CAUSES[number];

export function failedRunCause(flight: Pick<FlightRecord, "metadata">): FailedRunCause {
  const cause = flight.metadata?.failureCause;
  return FAILED_RUN_CAUSES.includes(cause as FailedRunCause) ? cause as FailedRunCause : "unknown";
}

/** Retry is a deliberate fresh ask, never an automatic response to failure. */
export function failedRunRetryable(cause: FailedRunCause): boolean {
  return cause === "endpoint_lost" || cause === "harness_start";
}

export const FAILED_RUN_ACTIONS: Record<FailedRunCause, string> = {
  superseded: "Inspect the newest run; mark done or drop if it belongs to different work.",
  endpoint_lost: "Restore the target's availability, then retry in a fresh session.",
  harness_start: "Check the harness, project directory and login, then retry in a fresh session.",
  disk_full: "Free disk space first. Inspect the failed run, then create a new ask or drop this work.",
  harness_error: "Inspect the harness error and permissions. Create a corrected ask, mark done or drop.",
  unknown: "Inspect the failed run before creating a new ask, marking done or dropping this work.",
};

export interface WorkRetryRequest {
  workId: string;
  /** Start at 1. Reuse the same attempt after an uncertain receipt. */
  attempt: number;
}

export interface WorkRetryResponse {
  workId: string;
  attempt: number;
  requestId: string;
  invocationId: string;
  flightId: string;
}
