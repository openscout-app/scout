import type { FlightRecord } from "./invocations.js";

export const FAILED_RUN_CAUSES = ["superseded", "endpoint_lost", "harness_start", "disk_full", "harness_error", "unknown"] as const;
export type FailedRunCause = typeof FAILED_RUN_CAUSES[number];

export function failedRunCause(flight: Pick<FlightRecord, "metadata">): FailedRunCause {
  const cause = flight.metadata?.failureCause;
  return FAILED_RUN_CAUSES.includes(cause as FailedRunCause) ? cause as FailedRunCause : "unknown";
}

/**
 * A hint for the card: causes where a plain retry is likely to help. It never
 * gates an explicit retry; retry is a deliberate fresh ask, never automatic.
 */
export function failedRunRetryable(cause: FailedRunCause): boolean {
  return cause === "endpoint_lost" || cause === "harness_start";
}

export const FAILED_RUN_ACTIONS: Record<FailedRunCause, string> = {
  superseded: "Inspect the newest run; mark done or drop if it belongs to different work.",
  endpoint_lost: "Restore the target's availability, then retry in a fresh session.",
  harness_start: "Check the harness, project directory and login, then retry in a fresh session.",
  disk_full: "Free disk space first. Inspect the failed run, then retry, create a new ask or drop this work.",
  harness_error: "Inspect the harness error and permissions. Retry, create a corrected ask, mark done or drop.",
  unknown: "Inspect the failed run, then retry, create a new ask, mark done or drop this work.",
};

export interface WorkRetryRequest {
  workId: string;
  /**
   * Optional; defaults to the next attempt (or the pending one after an
   * uncertain receipt). An explicit value must be that number, or an earlier
   * accepted attempt to recover its receipt.
   */
  attempt?: number;
}

export interface WorkRetryResponse {
  workId: string;
  attempt: number;
  requestId: string;
  invocationId: string;
  flightId: string;
}
