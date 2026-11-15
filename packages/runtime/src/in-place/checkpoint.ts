// Where a delivery into an open session stands, kept on the task's flight so a
// runtime that restarts can pick the delivery up instead of leaving it open.
//
// The rule that makes a restart safe: "typing" is written before the first
// keystroke. A flight that says "held" was never typed into, so it can be
// delivered again from the start. A flight that says "typing" or "typed" is
// never typed into again; the runtime only watches for its answer.

import type { InPlaceVia } from "./deliver.js";

/** The flight metadata key the checkpoint is stored under. */
export const IN_PLACE_CHECKPOINT_KEY = "inPlace";

export type InPlaceCheckpoint =
  /** Waiting for the session to take a turn. Nothing was typed. */
  | { phase: "held"; since: number }
  /**
   * `typing`: the keystroke was about to be sent; whether it landed is unknown.
   * `typed`: the keystroke was sent.
   */
  | {
    phase: "typing" | "typed";
    /** When the task began waiting for the session. */
    since: number;
    /** When the words were typed. */
    at: number;
    via: InPlaceVia;
    location: string;
    /** Where the transcript ended before the words were typed, when it is read for the answer. */
    transcriptOffset: number | null;
  };

const VIAS: readonly string[] = ["herdr", "orca", "tmux", "lattices", "scout-app"];

function time(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The checkpoint in a flight's metadata, or null when there is none or it is malformed. */
export function readInPlaceCheckpoint(metadata: Record<string, unknown> | null | undefined): InPlaceCheckpoint | null {
  const value = metadata?.[IN_PLACE_CHECKPOINT_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const since = time(raw.since);
  if (since === null) return null;
  if (raw.phase === "held") return { phase: "held", since };
  if (raw.phase !== "typing" && raw.phase !== "typed") return null;
  const at = time(raw.at);
  if (at === null || typeof raw.via !== "string" || !VIAS.includes(raw.via)) return null;
  if (typeof raw.location !== "string" || !raw.location) return null;
  const offset = raw.transcriptOffset;
  if (offset !== null && !(typeof offset === "number" && Number.isInteger(offset) && offset >= 0)) return null;
  return { phase: raw.phase, since, at, via: raw.via as InPlaceVia, location: raw.location, transcriptOffset: offset };
}

/**
 * A running flight whose delivery into an open session can be picked up by a
 * process that is not running it. A flight whose reply wait already ran out is
 * left as it is: it stays open for a reply the session posts itself.
 */
export function isResumableInPlaceFlight(flight: {
  state: string;
  metadata?: Record<string, unknown> | null;
} | undefined): boolean {
  return flight?.state === "running"
    && flight.metadata?.requesterTimedOut !== true
    && readInPlaceCheckpoint(flight.metadata) !== null;
}
