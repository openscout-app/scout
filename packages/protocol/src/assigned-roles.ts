/**
 * Assigned roles: small explicit duties with hooks and allowed actions.
 *
 * Not agentClass, harness, or identity. No assignment → no hooks → no mission log.
 * First role: orchestrator (mission spine + cheap mission log).
 *
 * See docs/proposals/assigned-roles-and-mission-log.md
 */

import type { MetadataMap, ScoutId } from "./common.js";

/* ── Hook moments ── */

export const SCOUT_ROLE_HOOK_IDS = [
  "mission.started",
  "turn.ended",
  "delegation.created",
  "child.updated",
  "waiting.entered",
  "mission.heartbeat",
  "mission.finished",
] as const;

export type ScoutRoleHookId = (typeof SCOUT_ROLE_HOOK_IDS)[number];

/**
 * Scout-side lifecycle moments (broker fires these; role definitions bind actions).
 * Distinct from optional soft "hooks" the agent may also honor.
 */
export const SCOUT_ROLE_LIFECYCLE_EVENT_IDS = [
  "ask.completed",
  "ask.failed",
  "work.completed",
] as const;

export type ScoutRoleLifecycleEventId = (typeof SCOUT_ROLE_LIFECYCLE_EVENT_IDS)[number];

/** Who must hold the role for a lifecycle binding to run. */
export type ScoutRoleLifecycleWhen = "target" | "requester" | "either";

/* ── Actions (v0 string ids; expand as tools land) ── */

export const SCOUT_MISSION_LOG_APPEND = "mission_log.append" as const;
export const SCOUT_WORK_CHILD_LINK = "work.child_link" as const;
export const SCOUT_WORK_SET_NEXT_MOVE = "work.set_next_move" as const;
/** Write the role's slot: one short summary the runtime keeps per assignment. Checked by the runtime. */
export const SCOUT_SLOT_WRITE = "slot.write" as const;

export const SCOUT_ROLE_ACTION_IDS = [
  SCOUT_MISSION_LOG_APPEND,
  SCOUT_WORK_CHILD_LINK,
  SCOUT_WORK_SET_NEXT_MOVE,
  SCOUT_SLOT_WRITE,
] as const;

/** Closed set for catalog authoring; open only at untrusted boundaries if needed. */
export type ScoutRoleActionId = (typeof SCOUT_ROLE_ACTION_IDS)[number];

/**
 * Role-owned function at a lifecycle moment.
 * Example: orchestrator → on ask.completed → mission_log.append (post_ask_summary).
 */
export interface ScoutRoleLifecycleBinding {
  on: ScoutRoleLifecycleEventId;
  action: ScoutRoleActionId;
  when: ScoutRoleLifecycleWhen;
  /**
   * Stable function id for logs/telemetry (role-defined name of the behavior).
   * e.g. post_ask_summary, post_work_summary
   */
  functionId: string;
}

/* ── Catalog ── */

export const SCOUT_ORCHESTRATOR_ROLE_ID = "orchestrator" as const;
export const SCOUT_PM_ROLE_ID = "pm" as const;

/** Built-in role ids. Future roles append here and stay closed in the catalog. */
export type ScoutBuiltinRoleId = typeof SCOUT_ORCHESTRATOR_ROLE_ID | typeof SCOUT_PM_ROLE_ID;

/** Role id on definitions/assignments; catalog rows use built-ins. */
export type ScoutRoleId = ScoutBuiltinRoleId | (string & {});

export interface ScoutRoleDefinition {
  id: ScoutRoleId;
  label: string;
  summary: string;
  hooks: readonly ScoutRoleHookId[];
  actions: readonly ScoutRoleActionId[];
  /**
   * Scout-enforced lifecycle functions for this role.
   * Fired by the broker at ask/work boundaries — not agent-loaded hooks.
   */
  lifecycle?: readonly ScoutRoleLifecycleBinding[];
  /**
   * Scope kinds in which only one agent may hold this role at a time: one per
   * mission for "mission", one in all for "agent", one per project root for
   * "project". The runtime refuses a second holder unless the assigner opts out.
   */
  singleHolder?: readonly ScoutRoleAssignmentScope["kind"][];
  /**
   * The role runs a pass when work changes: one ask to the holder, coalesced.
   * A work change marks the assignment dirty; after `quietMs` without another
   * change, or `maxWaitMs` after the first, one pass starts. Changes made by
   * the holder itself never mark it.
   */
  pass?: ScoutRolePassPolicy;
}

export interface ScoutRolePassPolicy {
  quietMs: number;
  maxWaitMs: number;
}

/**
 * Invocation metadata that marks an ask as a role pass. The value is the
 * assignment id. An unended flight with this mark is the pass lock, and a
 * marked ask never becomes a work item.
 */
export const SCOUT_ROLE_PASS_METADATA_KEY = "rolePass" as const;

/** The assignment a role pass runs for, or null when the metadata carries no mark. */
export function rolePassAssignmentId(metadata: MetadataMap | undefined): ScoutId | null {
  const value = metadata?.[SCOUT_ROLE_PASS_METADATA_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Orchestrator lifecycle: auto post-ask / post-work summary into mission log. */
export const SCOUT_ORCHESTRATOR_LIFECYCLE: readonly ScoutRoleLifecycleBinding[] = [
  {
    on: "ask.completed",
    action: SCOUT_MISSION_LOG_APPEND,
    when: "either",
    functionId: "post_ask_summary",
  },
  {
    on: "ask.failed",
    action: SCOUT_MISSION_LOG_APPEND,
    when: "either",
    functionId: "post_ask_summary",
  },
  {
    on: "work.completed",
    action: SCOUT_MISSION_LOG_APPEND,
    when: "target",
    functionId: "post_work_summary",
  },
] as const;

export const SCOUT_ORCHESTRATOR_ROLE: ScoutRoleDefinition = {
  id: SCOUT_ORCHESTRATOR_ROLE_ID,
  label: "Orchestrator",
  summary:
    "Owns a long-running mission spine and keeps a cheap mission log current.",
  hooks: SCOUT_ROLE_HOOK_IDS,
  actions: [
    SCOUT_MISSION_LOG_APPEND,
    SCOUT_WORK_CHILD_LINK,
    SCOUT_WORK_SET_NEXT_MOVE,
  ],
  lifecycle: SCOUT_ORCHESTRATOR_LIFECYCLE,
  singleHolder: ["mission"],
};

/**
 * PM: keeps the Kanban's summary current. Its only checked action is writing
 * its slot; one agent holds it.
 */
export const SCOUT_PM_ROLE: ScoutRoleDefinition = {
  id: SCOUT_PM_ROLE_ID,
  label: "PM",
  summary: "Keeps the Kanban's summary current and asks agents only what the records can't answer.",
  hooks: [],
  actions: [SCOUT_SLOT_WRITE],
  singleHolder: ["agent"],
  pass: { quietMs: 20_000, maxWaitMs: 120_000 },
};

/** Built-in catalog. Future roles (qa, sre, reviewer) append here. */
export const SCOUT_ROLE_CATALOG: readonly ScoutRoleDefinition[] = [
  SCOUT_ORCHESTRATOR_ROLE,
  SCOUT_PM_ROLE,
] as const;

/* ── Role slot: one short, cited summary per assignment ── */

export const SCOUT_ROLE_SLOT_LIMITS = {
  sentencesMax: 6,
  sentenceMaxChars: 280,
  citesPerSentenceMax: 8,
  stampMax: 2000,
} as const;

/** Card id to the revision the writer read. What the summary is valid for. */
export type ScoutRoleSlotStamp = Record<ScoutId, number>;

/** One sentence of a slot, with the cards it is about. Every sentence cites at least one stamped card. */
export interface ScoutRoleSlotSentence {
  text: string;
  cites: ScoutId[];
}

export interface ScoutRoleSlot {
  assignmentId: ScoutId;
  roleId: ScoutRoleId;
  /** Bumps on every write; a writer sends the version it read. */
  version: number;
  stamp: ScoutRoleSlotStamp;
  sentences: ScoutRoleSlotSentence[];
  writtenById: ScoutId;
  writtenAt: number;
}

export interface ScoutRoleSlotWriteInput {
  assignmentId: ScoutId;
  actorId: ScoutId;
  /** The slot version the writer read; 0 when there was none. */
  expectedVersion: number;
  stamp: ScoutRoleSlotStamp;
  sentences: ScoutRoleSlotSentence[];
}

/** Shape and citation check for a slot write. A sentence that cites no stamped card is refused. */
export function validateRoleSlotWrite(input: Pick<ScoutRoleSlotWriteInput, "expectedVersion" | "stamp" | "sentences">): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const limits = SCOUT_ROLE_SLOT_LIMITS;
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) errors.push("expectedVersion must be a whole number, 0 or more");
  const stamp = input.stamp && typeof input.stamp === "object" && !Array.isArray(input.stamp) ? input.stamp : null;
  if (!stamp) errors.push("stamp must map card ids to revisions");
  const stamped = Object.entries(stamp ?? {});
  if (stamped.length > limits.stampMax) errors.push(`stamp holds at most ${limits.stampMax} cards`);
  for (const [id, revision] of stamped) {
    if (!id.trim() || !Number.isInteger(revision) || revision < 0) {
      errors.push(`stamp entry ${JSON.stringify(id)} needs a whole revision`);
      break;
    }
  }
  if (!Array.isArray(input.sentences)) {
    errors.push("sentences must be a list");
    return { ok: false, errors };
  }
  if (input.sentences.length > limits.sentencesMax) errors.push(`at most ${limits.sentencesMax} sentences`);
  input.sentences.forEach((sentence, index) => {
    const n = index + 1;
    const text = typeof sentence?.text === "string" ? sentence.text.trim() : "";
    if (!text) errors.push(`sentence ${n} is empty`);
    else if (text.length > limits.sentenceMaxChars) errors.push(`sentence ${n} is over ${limits.sentenceMaxChars} characters`);
    const cites = Array.isArray(sentence?.cites) ? sentence.cites : [];
    if (!cites.length) errors.push(`sentence ${n} cites no card`);
    else if (cites.length > limits.citesPerSentenceMax) errors.push(`sentence ${n} cites more than ${limits.citesPerSentenceMax} cards`);
    const unstamped = cites.filter((id) => typeof id !== "string" || !stamp || !Object.prototype.hasOwnProperty.call(stamp, id));
    if (unstamped.length) errors.push(`sentence ${n} cites cards outside the stamp: ${unstamped.join(", ")}`);
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * True when the board moved since the slot was written: an open card whose
 * revision differs from the stamp (or is missing from it), or a stamped card
 * that has changed since, including one that closed. Cards gone from the board
 * read are ignored.
 */
export function roleSlotBehind(
  stamp: ScoutRoleSlotStamp | undefined,
  cards: ReadonlyArray<{ workId: ScoutId; revision: number; open: boolean }>,
): boolean {
  const read = stamp ?? {};
  for (const card of cards) {
    const has = Object.prototype.hasOwnProperty.call(read, card.workId);
    if (card.open && (!has || read[card.workId] !== card.revision)) return true;
    if (!card.open && has && read[card.workId] !== card.revision) return true;
  }
  return false;
}

/** True when this agent may write the slot of this assignment: it holds it, and its role lists slot.write. */
export function agentMayWriteRoleSlot(opts: {
  agentId: string;
  assignment: ScoutRoleAssignment;
  catalog?: readonly ScoutRoleDefinition[];
}): boolean {
  const { assignment } = opts;
  if (!assignment.active || assignment.agentId !== opts.agentId) return false;
  return Boolean(scoutRoleDefinition(assignment.roleId, opts.catalog)?.actions.includes(SCOUT_SLOT_WRITE));
}

/* ── Assignment scope ── */

/**
 * Mission scope uses a work-item id in v0 (campaign root).
 * Agent scope is a standing duty on that agent.
 * Project scope is reserved for Slice 1+ (requires projectRoot in context).
 */
export type ScoutRoleAssignmentScope =
  | { kind: "mission"; missionId: ScoutId }
  | { kind: "agent" }
  | { kind: "project"; projectRoot: string };

export interface ScoutRoleAssignment {
  id: ScoutId;
  roleId: ScoutRoleId;
  agentId: ScoutId;
  scope: ScoutRoleAssignmentScope;
  assignedById: ScoutId;
  assignedAt: number;
  active: boolean;
  revokedAt?: number;
  revokedById?: ScoutId;
  metadata?: MetadataMap;
}

/** Context used to decide whether an assignment applies. */
export interface ScoutRoleScopeContext {
  missionId?: ScoutId;
  projectRoot?: string;
}

/* ── Mission log (situation plane; not chat) ── */

export const SCOUT_MISSION_LOG_KINDS = [
  "heartbeat",
  "progress",
  "delegation",
  "waiting",
  "decision",
  "risk",
  "integration",
  "done",
  "failed",
] as const;

export type ScoutMissionLogKind = (typeof SCOUT_MISSION_LOG_KINDS)[number];

/** Soft limits for writers, tool schemas, and prompts — single source of truth. */
export const SCOUT_MISSION_LOG_LIMITS = {
  intentMaxWords: 16,
  /** Short current-action line (field name: `status`, not `now`). */
  statusMaxWords: 24,
  noteMaxChars: 240,
} as const;

export interface ScoutMissionLogBlocker {
  label: string;
  ownerId?: ScoutId;
  metadata?: MetadataMap;
}

export interface ScoutMissionLogRefs {
  messageId?: ScoutId;
  flightId?: ScoutId;
  workId?: ScoutId;
  sessionId?: ScoutId;
  invocationId?: ScoutId;
}

/**
 * Cheap structured entry written by an assigned orchestrator (or other role
 * that lists mission_log.append). Prefer short intent/status; optional note max
 * one sentence when truly useful.
 *
 * v0 persistence may map only a subset into work.progress + collaboration_events
 * (lossy). Full fidelity wants an append-only log store in Slice 2+.
 */
export interface ScoutMissionLogEntry {
  id: ScoutId;
  /** Work-item id of the campaign root (v0). */
  missionId: ScoutId;
  /** Child work / flight node when the entry is about a branch. */
  nodeId?: ScoutId;
  at: number;
  /** Per-mission monotonic order; avoids same-ms collisions in UI. */
  seq?: number;
  actorId: ScoutId;
  kind: ScoutMissionLogKind;
  /** Stable goal for this node (keep short). */
  intent: string;
  /** Current action / state (keep short). Not a timestamp. */
  status: string;
  checkpoint?: string;
  blockers?: ScoutMissionLogBlocker[];
  refs?: ScoutMissionLogRefs;
  note?: string;
  metadata?: MetadataMap;
}

export interface ScoutMissionLogAppendInput {
  missionId: ScoutId;
  nodeId?: ScoutId;
  actorId: ScoutId;
  kind: ScoutMissionLogKind;
  intent: string;
  status: string;
  checkpoint?: string;
  blockers?: ScoutMissionLogBlocker[];
  refs?: ScoutMissionLogRefs;
  note?: string;
  metadata?: MetadataMap;
  /** Caller-supplied id; store may assign if omitted. */
  id?: ScoutId;
  at?: number;
  seq?: number;
}

/* ── Helpers ── */

export function scoutRoleDefinition(
  roleId: string,
  catalog: readonly ScoutRoleDefinition[] = SCOUT_ROLE_CATALOG,
): ScoutRoleDefinition | undefined {
  return catalog.find((role) => role.id === roleId);
}

export function isScoutRoleHookId(value: string): value is ScoutRoleHookId {
  return (SCOUT_ROLE_HOOK_IDS as readonly string[]).includes(value);
}

export function isScoutMissionLogKind(value: string): value is ScoutMissionLogKind {
  return (SCOUT_MISSION_LOG_KINDS as readonly string[]).includes(value);
}

export function assignmentAppliesTo(
  assignment: ScoutRoleAssignment,
  ctx: ScoutRoleScopeContext,
): boolean {
  switch (assignment.scope.kind) {
    case "agent":
      return true;
    case "mission":
      return ctx.missionId !== undefined
        && assignment.scope.missionId === ctx.missionId;
    case "project":
      return ctx.projectRoot !== undefined
        && assignment.scope.projectRoot === ctx.projectRoot;
    default:
      return false;
  }
}

export function activeScoutRoleAssignments(
  assignments: readonly ScoutRoleAssignment[],
): ScoutRoleAssignment[] {
  return assignments.filter((assignment) => assignment.active);
}

export function scoutRoleAssignmentsForAgent(
  assignments: readonly ScoutRoleAssignment[],
  agentId: string,
  opts?: { activeOnly?: boolean },
): ScoutRoleAssignment[] {
  const activeOnly = opts?.activeOnly ?? true;
  return assignments.filter((assignment) => {
    if (assignment.agentId !== agentId) return false;
    if (activeOnly && !assignment.active) return false;
    return true;
  });
}

export function scoutRoleAssignmentsForMission(
  assignments: readonly ScoutRoleAssignment[],
  missionId: string,
  opts?: {
    activeOnly?: boolean;
    roleId?: string;
    /** Include standing agent-scope assignments (default true for "who covers this mission"). */
    includeStanding?: boolean;
  },
): ScoutRoleAssignment[] {
  const activeOnly = opts?.activeOnly ?? true;
  const includeStanding = opts?.includeStanding ?? true;
  const ctx: ScoutRoleScopeContext = { missionId };

  return assignments.filter((assignment) => {
    if (activeOnly && !assignment.active) return false;
    if (opts?.roleId && assignment.roleId !== opts.roleId) return false;
    if (assignment.scope.kind === "agent") return includeStanding;
    return assignmentAppliesTo(assignment, ctx);
  });
}

/** Distinct agent ids holding an active role for a mission (incl. standing if enabled). */
export function activeRoleHoldersForMission(
  assignments: readonly ScoutRoleAssignment[],
  missionId: string,
  roleId: string,
  opts?: { includeStanding?: boolean },
): ScoutId[] {
  const rows = scoutRoleAssignmentsForMission(assignments, missionId, {
    activeOnly: true,
    roleId,
    includeStanding: opts?.includeStanding ?? true,
  });
  return [...new Set(rows.map((row) => row.agentId))];
}

/**
 * True when this agent may write the mission log for a mission under the
 * anti-spam rules: active assignment whose definition includes mission_log.append
 * and whose scope applies to the mission (or standing agent-scope).
 */
export function agentMayWriteMissionLog(opts: {
  agentId: string;
  missionId: string;
  assignments: readonly ScoutRoleAssignment[];
  catalog?: readonly ScoutRoleDefinition[];
  projectRoot?: string;
}): boolean {
  const catalog = opts.catalog ?? SCOUT_ROLE_CATALOG;
  const ctx: ScoutRoleScopeContext = {
    missionId: opts.missionId,
    projectRoot: opts.projectRoot,
  };

  for (const assignment of opts.assignments) {
    if (!assignment.active) continue;
    if (assignment.agentId !== opts.agentId) continue;
    if (!assignmentAppliesTo(assignment, ctx)) continue;
    const definition = scoutRoleDefinition(assignment.roleId, catalog);
    if (!definition?.actions.includes(SCOUT_MISSION_LOG_APPEND)) continue;
    return true;
  }
  return false;
}

export function roleDefinitionAllowsHook(
  definition: ScoutRoleDefinition,
  hookId: ScoutRoleHookId,
): boolean {
  return definition.hooks.includes(hookId);
}

export function assignmentsMatchingHook(opts: {
  hookId: ScoutRoleHookId;
  assignments: readonly ScoutRoleAssignment[];
  context?: ScoutRoleScopeContext;
  catalog?: readonly ScoutRoleDefinition[];
}): ScoutRoleAssignment[] {
  const catalog = opts.catalog ?? SCOUT_ROLE_CATALOG;
  const ctx = opts.context ?? {};

  return opts.assignments.filter((assignment) => {
    if (!assignment.active) return false;
    if (!assignmentAppliesTo(assignment, ctx)) return false;
    const definition = scoutRoleDefinition(assignment.roleId, catalog);
    if (!definition || !roleDefinitionAllowsHook(definition, opts.hookId)) {
      return false;
    }
    return true;
  });
}

export type MissionLogEntryValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

/** Soft structural validation for writers and tests (untrusted tool args). */
export function validateMissionLogEntryFields(
  input: Pick<ScoutMissionLogAppendInput, "intent" | "status" | "note" | "kind">,
): MissionLogEntryValidation {
  const errors: string[] = [];
  if (typeof input.intent !== "string" || !input.intent.trim()) {
    errors.push("intent is required");
  } else if (wordCount(input.intent) > SCOUT_MISSION_LOG_LIMITS.intentMaxWords) {
    errors.push(`intent should be ≤ ${SCOUT_MISSION_LOG_LIMITS.intentMaxWords} words`);
  }

  if (typeof input.status !== "string" || !input.status.trim()) {
    errors.push("status is required");
  } else if (wordCount(input.status) > SCOUT_MISSION_LOG_LIMITS.statusMaxWords) {
    errors.push(`status should be ≤ ${SCOUT_MISSION_LOG_LIMITS.statusMaxWords} words`);
  }

  if (typeof input.kind !== "string" || !isScoutMissionLogKind(input.kind)) {
    errors.push(`unknown kind: ${String(input.kind)}`);
  }

  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string") {
      errors.push("note must be a string");
    } else if (input.note.trim().length > SCOUT_MISSION_LOG_LIMITS.noteMaxChars) {
      errors.push(`note should be ≤ ${SCOUT_MISSION_LOG_LIMITS.noteMaxChars} characters`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * The sentences a role pass answered with. The answer ends with a JSON object
 * `{"sentences": [{"text", "cites"}]}`, bare or in a ```json fence; the last
 * such object wins. Null when there is none, so a pass that only talked
 * leaves the slot alone.
 */
export function parseRolePassAnswer(output: string | undefined): ScoutRoleSlotSentence[] | null {
  if (!output?.trim()) return null;
  const candidates: string[] = [];
  for (const match of output.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) candidates.push(match[1]!);
  const start = output.lastIndexOf("{\"sentences\"");
  if (start >= 0) candidates.push(output.slice(start, output.lastIndexOf("}") + 1));
  candidates.push(output);
  for (const text of candidates.reverse()) {
    try {
      const value = JSON.parse(text.trim()) as unknown;
      if (!value || typeof value !== "object" || !Array.isArray((value as { sentences?: unknown }).sentences)) continue;
      return ((value as { sentences: unknown[] }).sentences).map((sentence) => {
        const entry = (sentence ?? {}) as { text?: unknown; cites?: unknown };
        return {
          text: typeof entry.text === "string" ? entry.text : "",
          cites: Array.isArray(entry.cites) ? entry.cites.filter((cite): cite is string => typeof cite === "string") : [],
        };
      });
    } catch {
      // Not this candidate.
    }
  }
  return null;
}
