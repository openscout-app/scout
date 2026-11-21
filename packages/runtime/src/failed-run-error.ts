import { FAILED_RUN_CAUSES, type FailedRunCause } from "@openscout/protocol";

/** Carry a cause at its source instead of teaching the board error prose. */
export class FailedRunError extends Error {
  constructor(readonly failureCause: FailedRunCause, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FailedRunError";
  }
}

export function failureCauseForError(error: unknown, fallback: FailedRunCause): FailedRunCause {
  let classified: FailedRunCause | undefined;
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current);) {
    seen.add(current);
    const value = current as { code?: unknown; failureCause?: unknown; cause?: unknown };
    if (value.code === "ENOSPC") return "disk_full";
    if (!classified && FAILED_RUN_CAUSES.includes(value.failureCause as FailedRunCause)) classified = value.failureCause as FailedRunCause;
    current = value.cause;
  }
  return classified ?? fallback;
}
