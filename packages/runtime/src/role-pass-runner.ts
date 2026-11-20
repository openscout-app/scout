import type {
  CollaborationRecord,
  FlightRecord,
  InvocationRequest,
  ScoutDeliverRequest,
  ScoutRoleAssignment,
  ScoutRoleSlot,
  ScoutRoleSlotStamp,
} from "@openscout/protocol";
import {
  SCOUT_ROLE_PASS_METADATA_KEY,
  SCOUT_ROLE_SLOT_LIMITS,
  parseRolePassAnswer,
  rolePassAssignmentId,
} from "@openscout/protocol";

import { readRoleSlot, RoleSlotError, writeRoleSlot } from "./role-slots-store.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

/** The requester of every pass: the runtime itself, so no one's chat collects them. */
export const ROLE_PASS_REQUESTER_ID = "system";

/** Bounds on what one pass reads, so a large board cannot grow the brief without limit. */
export const ROLE_PASS_BUNDLE_LIMITS = { openMax: 80, changedMax: 40, summaryMaxChars: 280 } as const;

export interface RolePassBoardCard {
  workId: string;
  revision: number;
  station: string;
  stationName: string;
  open: boolean;
}

export interface RolePassCardView {
  id: string;
  title: string;
  station: string;
  state: string;
  owner?: string;
  nextMove?: string;
  waitingOn?: string;
  summary?: string;
  updatedAt: number;
  revision: number;
  /** For a changed card: the revision the last slot read, or null when it was not read. */
  readRevision?: number | null;
}

export interface RolePassBundle {
  assignmentId: string;
  /** The slot version this pass writes over. */
  version: number;
  /** Every card this pass may cite, with its revision now. */
  stamp: ScoutRoleSlotStamp;
  lastSlot: Pick<ScoutRoleSlot, "sentences" | "writtenAt"> | null;
  /** Cards that moved since the last slot's stamp: open cards it did not read at this revision, and stamped cards that closed or changed. */
  changed: RolePassCardView[];
  /** Every open card, newest change first. Done cards are never read. */
  open: RolePassCardView[];
  truncated: { open: number; changed: number };
}

/**
 * The evidence one pass starts from. Code reads the board; the pass reads only
 * this, plus whatever records it chooses to open.
 */
export function buildRolePassBundle(input: {
  assignmentId: string;
  slot: ScoutRoleSlot | null;
  cards: readonly RolePassBoardCard[];
  record: (workId: string) => CollaborationRecord | undefined;
}): RolePassBundle {
  const read = input.slot?.stamp ?? {};
  const view = (card: RolePassBoardCard, withRead: boolean): RolePassCardView | null => {
    const record = input.record(card.workId);
    if (!record || record.kind !== "work_item") return null;
    const summary = record.summary?.trim();
    return {
      id: card.workId,
      title: record.title,
      station: card.stationName,
      state: record.state,
      ...(record.ownerId ? { owner: record.ownerId } : {}),
      ...(record.nextMoveOwnerId ? { nextMove: record.nextMoveOwnerId } : {}),
      ...(record.waitingOn?.label ? { waitingOn: record.waitingOn.label } : {}),
      ...(summary ? { summary: summary.slice(0, ROLE_PASS_BUNDLE_LIMITS.summaryMaxChars) } : {}),
      updatedAt: record.updatedAt,
      revision: card.revision,
      ...(withRead ? { readRevision: Object.prototype.hasOwnProperty.call(read, card.workId) ? read[card.workId]! : null } : {}),
    };
  };
  const has = (workId: string) => Object.prototype.hasOwnProperty.call(read, workId);
  const changedCards = input.cards.filter((card) => card.open
    ? !has(card.workId) || read[card.workId] !== card.revision
    : has(card.workId) && read[card.workId] !== card.revision);
  const openCards = input.cards.filter((card) => card.open);
  const changed = changedCards.map((card) => view(card, true)).filter((card): card is RolePassCardView => card !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const open = openCards.map((card) => view(card, false)).filter((card): card is RolePassCardView => card !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const shownChanged = changed.slice(0, ROLE_PASS_BUNDLE_LIMITS.changedMax);
  const shownOpen = open.slice(0, ROLE_PASS_BUNDLE_LIMITS.openMax);
  // The stamp is what the pass actually saw: every open card, and the closed
  // ones it is told about. A sentence may cite any of them.
  const stamp: ScoutRoleSlotStamp = {};
  for (const card of [...shownOpen, ...shownChanged]) {
    if (Object.keys(stamp).length >= SCOUT_ROLE_SLOT_LIMITS.stampMax) break;
    stamp[card.id] = card.revision;
  }
  return {
    assignmentId: input.assignmentId,
    version: input.slot?.version ?? 0,
    stamp,
    lastSlot: input.slot ? { sentences: input.slot.sentences, writtenAt: input.slot.writtenAt } : null,
    changed: shownChanged,
    open: shownOpen,
    truncated: { open: open.length - shownOpen.length, changed: changed.length - shownChanged.length },
  };
}

/** The brief for one pass: the job, the rules, the evidence, and the answer's shape. */
export function rolePassBrief(bundle: RolePassBundle): string {
  const limits = SCOUT_ROLE_SLOT_LIMITS;
  const evidence = {
    lastSummary: bundle.lastSlot,
    changedSinceLastSummary: bundle.changed,
    openCards: bundle.open,
    ...(bundle.truncated.open || bundle.truncated.changed ? { notShown: bundle.truncated } : {}),
  };
  return [
    "You hold the PM role for this Scout runtime. Rewrite the short summary at the head of the Kanban.",
    "",
    "The summary tells a person, in a few seconds, what moved, what is stuck, and what waits on whom.",
    "",
    "Rules:",
    `- At most ${limits.sentencesMax} sentences, each under ${limits.sentenceMaxChars} characters. Fewer is better. An empty list is right when nothing needs saying.`,
    "- Each sentence cites the ids of the cards it is about, from the evidence below. A sentence that cites nothing, or a card not listed, is refused.",
    "- Lead with what changed since the last summary. Keep a line from the last summary only if it is still true.",
    "- Plain words. Name agents by the ids in the evidence. No praise, no filler, no guesses about work you did not read.",
    "- You may read any record or session the evidence names. Do not ask agents questions on this pass, and do not move cards.",
    "",
    "Evidence (JSON):",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
    "",
    "End your answer with exactly one JSON block in this shape, and nothing after it:",
    "```json",
    "{\"sentences\": [{\"text\": \"One sentence.\", \"cites\": [\"<card id>\"]}]}",
    "```",
  ].join("\n");
}

/**
 * The ask that starts one pass: a fresh background session (Scout-managed
 * harness state, never a pane in front of the operator), no work item, marked
 * as the pass lock.
 */
export function rolePassDeliverRequest(input: {
  assignment: ScoutRoleAssignment;
  bundle: RolePassBundle;
  nodeId: string;
  now: number;
  reason: string;
}): ScoutDeliverRequest {
  const { assignment, bundle } = input;
  return {
    requestId: `role-pass-${assignment.id}-v${bundle.version}-${input.now}`,
    requesterId: ROLE_PASS_REQUESTER_ID,
    requesterNodeId: input.nodeId,
    targetAgentId: assignment.agentId,
    body: rolePassBrief(bundle),
    intent: "consult",
    ensureAwake: true,
    execution: { session: "new", placement: "background" },
    invocationMetadata: {
      source: "role-pass",
      [SCOUT_ROLE_PASS_METADATA_KEY]: assignment.id,
      rolePassRoleId: assignment.roleId,
      rolePassReason: input.reason,
      rolePassVersion: bundle.version,
      rolePassStamp: bundle.stamp,
    },
  };
}

export type RolePassApplyResult =
  | { kind: "not_a_pass" }
  | { kind: "written"; slot: ScoutRoleSlot }
  | { kind: "skipped"; reason: string };

/**
 * When a pass flight completes, write its answer to the slot. The version and
 * stamp come from the pass's own invocation, never from the answer, so a pass
 * can cite only what code showed it and cannot write over a newer slot.
 */
export function applyRolePassAnswer(
  db: ControlPlaneSqliteDatabase,
  input: { flight: FlightRecord; invocation: InvocationRequest | undefined; now?: number },
): RolePassApplyResult {
  const metadata = input.invocation?.metadata;
  const assignmentId = rolePassAssignmentId(metadata);
  if (!assignmentId || !input.invocation) return { kind: "not_a_pass" };
  if (input.flight.state !== "completed") return { kind: "skipped", reason: `pass ${input.flight.state}` };
  const sentences = parseRolePassAnswer(input.flight.output ?? input.flight.summary);
  if (!sentences) return { kind: "skipped", reason: "the answer carried no sentences block" };
  const version = metadata?.rolePassVersion;
  const stamp = metadata?.rolePassStamp;
  if (typeof version !== "number" || !stamp || typeof stamp !== "object") {
    return { kind: "skipped", reason: "the pass invocation carried no version or stamp" };
  }
  try {
    const slot = writeRoleSlot(db, {
      assignmentId,
      actorId: input.invocation.targetAgentId,
      expectedVersion: version,
      stamp: stamp as ScoutRoleSlotStamp,
      sentences,
    }, input.now);
    return { kind: "written", slot };
  } catch (error) {
    if (error instanceof RoleSlotError) return { kind: "skipped", reason: `${error.status}: ${error.message}` };
    throw error;
  }
}

/** The slot a pass for this assignment would start from. */
export function rolePassBundleFor(
  db: ControlPlaneSqliteDatabase,
  input: { assignmentId: string; cards: readonly RolePassBoardCard[]; record: (workId: string) => CollaborationRecord | undefined },
): RolePassBundle {
  return buildRolePassBundle({ ...input, slot: readRoleSlot(db, input.assignmentId) });
}
