/**
 * Flight outcomes and liveness (docs/specs/flight-supervisor.md).
 *
 * A finished flight ended because something reported an end: the run
 * (`completed`, `failed`) or an operator or replacement (`cancelled`). A dead
 * flight stopped without reporting an end, and its owner's supervisor stopped
 * waiting for it.
 *
 * On the wire a dead flight is `state: "failed"` with `metadata.outcome:
 * "dead"`, so peers and readers that know only the seven flight states still
 * treat it as terminal. Read outcomes with {@link flightOutcome}, never from
 * `state` alone.
 */

import type { FlightRecord } from "./invocations.js";

export type FlightOutcome = "completed" | "failed" | "cancelled" | "dead";
export type FlightOutcomeCategory = "finished" | "unfinished";

export const DEAD_FLIGHT_CAUSES = [
  /** The session process or its endpoint is gone, with no reply. */
  "session_gone",
  /** The same session finished a turn dispatched after this one. */
  "session_moved_on",
  /** The target agent was retired or replaced by a new registration. */
  "agent_retired",
  /** No evidence of progress for `deadAfter` (off unless configured). */
  "no_progress",
  /** A handoff to another node was never confirmed. */
  "handoff_unconfirmed",
  /** The owner node stayed unreachable for `ownerLostAfter`. */
  "owner_unreachable",
  /** Closed by the reconcile pass before the supervisor existed. */
  "legacy_reconciled",
] as const;
export type DeadFlightCause = typeof DEAD_FLIGHT_CAUSES[number];

export const DEAD_FLIGHT_ACTIONS: Record<DeadFlightCause, string> = {
  session_gone: "The session ended without a reply. Inspect its transcript, then retry in a fresh session or drop this work.",
  session_moved_on: "The session went on to later work without replying to this. Check whether that work covered it; mark done or retry.",
  agent_retired: "The agent was retired. Ask its replacement, or drop this work.",
  no_progress: "The session stopped making progress. Inspect it, then retry, mark done or drop this work.",
  handoff_unconfirmed: "The other machine never confirmed the work. Check that it is online, then retry.",
  owner_unreachable: "The machine running this work stopped answering. Check it; its own record wins when it returns.",
  legacy_reconciled: "Closed by an older reconcile pass. Inspect the run, then retry, mark done or drop this work.",
};

export type FlightLiveness = "active" | "idle" | "stalled";

export type SupervisorDeadlines = {
  tickIntervalMs: number;
  quietAfterMs: number;
  stalledAfterMs: number;
  goneGraceMs: number;
  /** Null: silence alone never makes a flight dead. */
  deadAfterMs: number | null;
};

export const DEFAULT_SUPERVISOR_DEADLINES: SupervisorDeadlines = {
  tickIntervalMs: 15_000,
  quietAfterMs: 2 * 60_000,
  stalledAfterMs: 10 * 60_000,
  goneGraceMs: 60_000,
  deadAfterMs: null,
};

type FlightLike = Pick<FlightRecord, "state" | "metadata">;

function metadataString(flight: FlightLike, key: string): string | null {
  const value = flight.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** True for a flight its supervisor closed without a reported end. */
export function isDeadFlight(flight: FlightLike): boolean {
  if (flight.state !== "failed") return false;
  if (metadataString(flight, "outcome") === "dead") return true;
  // Records closed by the old reconcile pass are guesses, not reported errors.
  return flight.metadata?.reconciledStaleFlight === true;
}

export function flightOutcome(flight: FlightLike): FlightOutcome | null {
  switch (flight.state) {
    case "completed":
    case "cancelled":
      return flight.state;
    case "failed":
      return isDeadFlight(flight) ? "dead" : "failed";
    default:
      return null;
  }
}

export function flightOutcomeCategory(outcome: FlightOutcome): FlightOutcomeCategory {
  return outcome === "dead" ? "unfinished" : "finished";
}

export function deadFlightCause(flight: FlightLike): DeadFlightCause | null {
  if (!isDeadFlight(flight)) return null;
  const cause = metadataString(flight, "deathCause");
  return DEAD_FLIGHT_CAUSES.includes(cause as DeadFlightCause) ? cause as DeadFlightCause : "legacy_reconciled";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * When the work really ended, or null. A dead flight never ended: the time
 * it was closed is when someone stopped waiting, not when work stopped. No
 * ordering rule may compare a dead flight's close time with a start time.
 */
export function flightFinishedAt(flight: Pick<FlightRecord, "state" | "metadata" | "completedAt">): number | null {
  const outcome = flightOutcome(flight);
  if (outcome === null || outcome === "dead") return null;
  return finiteNumber(flight.completedAt);
}

export function flightDeclaredDeadAt(flight: Pick<FlightRecord, "state" | "metadata" | "completedAt">): number | null {
  if (!isDeadFlight(flight)) return null;
  return finiteNumber(flight.metadata?.declaredDeadAt)
    ?? finiteNumber(flight.metadata?.reconciledAt)
    ?? finiteNumber(flight.completedAt);
}

/** The node whose supervisor owns this flight, or null when no node claimed it. */
export function flightOwnerNodeId(flight: Pick<FlightRecord, "metadata">): string | null {
  const supervisor = flight.metadata?.supervisor;
  if (supervisor && typeof supervisor === "object" && !Array.isArray(supervisor)) {
    const nodeId = (supervisor as Record<string, unknown>).nodeId;
    if (typeof nodeId === "string" && nodeId.trim()) return nodeId.trim();
  }
  const ack = flight.metadata?.dispatchAck;
  if (ack && typeof ack === "object" && !Array.isArray(ack)) {
    const nodeId = (ack as Record<string, unknown>).nodeId;
    if (typeof nodeId === "string" && nodeId.trim()) return nodeId.trim();
  }
  return null;
}

/** Newest evidence the flight itself carries: start, dispatch, turn end, or a recorded observation. */
export function flightLastEvidenceAt(flight: Pick<FlightRecord, "metadata" | "startedAt">): number {
  const ack = flight.metadata?.dispatchAck;
  const acknowledgedAt = ack && typeof ack === "object" && !Array.isArray(ack)
    ? finiteNumber((ack as Record<string, unknown>).acknowledgedAt)
    : null;
  return Math.max(
    finiteNumber(flight.startedAt) ?? 0,
    acknowledgedAt ?? 0,
    finiteNumber(flight.metadata?.awaitingFinalSince) ?? 0,
    finiteNumber(flight.metadata?.lastEvidenceAt) ?? 0,
  );
}

/**
 * How lively a running flight looks. A display field: it never changes the
 * flight's state. `sessionGone` is true when the owner knows the session
 * process has ended.
 */
export function flightLiveness(input: {
  lastEvidenceAt: number;
  now: number;
  sessionGone?: boolean;
  deadlines?: Pick<SupervisorDeadlines, "quietAfterMs" | "stalledAfterMs">;
}): FlightLiveness {
  if (input.sessionGone) return "stalled";
  const deadlines = input.deadlines ?? DEFAULT_SUPERVISOR_DEADLINES;
  const silentMs = input.now - input.lastEvidenceAt;
  if (input.lastEvidenceAt <= 0 || silentMs >= deadlines.stalledAfterMs) return "stalled";
  if (silentMs >= deadlines.quietAfterMs) return "idle";
  return "active";
}

/** The liveness a flight last recorded, or null. */
export function recordedFlightLiveness(flight: FlightLike): FlightLiveness | null {
  const value = metadataString(flight, "liveness");
  return value === "active" || value === "idle" || value === "stalled" ? value : null;
}
