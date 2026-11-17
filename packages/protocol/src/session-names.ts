/**
 * Session names: what a harness session is called on Scout surfaces.
 *
 * The harness gives a session a title early and rarely updates it. Scout keeps
 * two local overlays on top of that title, and every session read applies the
 * same order:
 *
 *   1. `operator` — a name the operator set (`scout session rename`).
 *   2. `work`     — the title of the work item the session is doing now.
 *   3. `harness`  — the harness's own title.
 *
 * Names are local metadata on the node that observes the session. Scout never
 * writes them into the harness's own session files.
 */

export type SessionNameSource = "operator" | "work" | "harness";

export const SESSION_NAME_MAX_LENGTH = 120;

/** One stored operator name, keyed by the observed identity on this node. */
export type SessionNameRecord = {
  harness: string;
  nativeSessionId: string;
  name: string;
  setByActorId: string;
  createdAt: number;
  updatedAt: number;
};

/** The work item a derived name came from. */
export type SessionNameDerivation = { kind: "work_item"; id: string; agentId: string };

/** The resolved name of one session, with the parts it was chosen from. */
export type SessionNameResolution = {
  /** The name to show, or null when no part has one. */
  name: string | null;
  source: SessionNameSource | null;
  operatorName: string | null;
  derivedName: string | null;
  derivedFrom: SessionNameDerivation | null;
  harnessTitle: string | null;
};

/**
 * Selects a session to rename. Give the exact pair (`harness` and
 * `nativeSessionId`), or a `selector`: a native session id, `<harness>:<id>`,
 * an agent or session actor id, or a session address (`sess.<token>@<host>`).
 */
export type SessionNameSetRequest = {
  selector?: string;
  harness?: string;
  nativeSessionId?: string;
  /** The new name. Null, empty or whitespace clears the operator name. */
  name: string | null;
  actorId?: string;
};

export type SessionNameSetResult = {
  ok: true;
  action: "set" | "cleared" | "unchanged";
  session: { harness: string; nativeSessionId: string };
  record: SessionNameRecord | null;
  resolution: SessionNameResolution;
};

export type SessionNameListResult = { names: SessionNameRecord[] };

export class SessionNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNameError";
  }
}

/**
 * Trims and collapses whitespace. Returns null for an empty name, which means
 * "clear". Throws on control characters or a name over the length limit.
 */
export function normalizeSessionName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new SessionNameError("a session name must be a string");
  if (/[\x00-\x08\x0b-\x1f\x7f]/u.test(value)) {
    throw new SessionNameError("a session name cannot contain control characters");
  }
  const name = value.replace(/\s+/gu, " ").trim();
  if (!name) return null;
  if ([...name].length > SESSION_NAME_MAX_LENGTH) {
    throw new SessionNameError(`a session name can be at most ${SESSION_NAME_MAX_LENGTH} characters`);
  }
  return name;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return trimmed || null;
}

/** Applies the session name order: operator, then work, then harness. */
export function resolveSessionName(input: {
  operatorName?: string | null;
  derivedName?: string | null;
  derivedFrom?: SessionNameDerivation | null;
  harnessTitle?: string | null;
}): SessionNameResolution {
  const operatorName = clean(input.operatorName);
  const derivedName = clean(input.derivedName);
  const harnessTitle = clean(input.harnessTitle);
  const derivedFrom = derivedName ? input.derivedFrom ?? null : null;
  if (operatorName) {
    return { name: operatorName, source: "operator", operatorName, derivedName, derivedFrom, harnessTitle };
  }
  if (derivedName) {
    return { name: derivedName, source: "work", operatorName, derivedName, derivedFrom, harnessTitle };
  }
  return {
    name: harnessTitle,
    source: harnessTitle ? "harness" : null,
    operatorName,
    derivedName,
    derivedFrom,
    harnessTitle,
  };
}
