/**
 * Saved Board review routines.
 *
 * A routine is written as a durable action of kind `manual_review_routine`,
 * so it is journaled, survives a restart, and replays into SQLite with every
 * other durable action. It holds the connection and channel a review may read
 * and the project and harness that review. It holds no credential.
 *
 * A save states the version it replaces. The check and the write share the
 * serialized writer, so of two saves from the same version exactly one wins.
 * A version is never reused: each save makes the next one.
 */
import { createHash } from "node:crypto";

import {
  MANUAL_REVIEW_ROUTINE_ACTION_KIND,
  MANUAL_REVIEW_ROUTINE_METADATA_KEY,
  MANUAL_REVIEW_ROUTINE_SCHEMA_VERSION,
  manualReviewBoardRoutineOf,
  type DurableAction,
  type ManualReviewBoardRoutine,
  type ManualReviewBoardRoutineSaveResponse,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";

export type ManualReviewBoardRoutineStoreDeps = {
  /** The node that holds the routine. Routine IDs are unique within it. */
  authorityCellId: string;
  runDurableWrite: <T>(work: () => Promise<T>) => Promise<T>;
  commitEntries: (
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ) => Promise<BrokerJournalEntry[]>;
  getDurableAction: (actionId: string) => DurableAction | null | undefined;
  /** Journal state, so a list after a restart holds what was saved before it. */
  listDurableActions: (kind: typeof MANUAL_REVIEW_ROUTINE_ACTION_KIND) => DurableAction[];
  now?: () => number;
};

export type ManualReviewBoardFailure = { error: string; detail: string } & Record<string, unknown>;

/**
 * A refusal by the Board review entry point. 400: the request is not valid.
 * 404: no such routine or item. 409: the request does not match what is
 * saved, or what the runtime reads now. Other statuses pass on the Board
 * connection's own refusal.
 */
export class ManualReviewBoardError extends Error {
  constructor(
    readonly status: number,
    readonly body: ManualReviewBoardFailure,
  ) {
    super(body.detail);
    this.name = "ManualReviewBoardError";
  }
}

/** The action ID of a routine on one node. Derived, so a routine is found by ID with no index. */
export function manualReviewBoardRoutineActionId(authorityCellId: string, routineId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([authorityCellId, routineId])).digest("hex");
  return `manual-review-routine-${digest.slice(0, 32)}`;
}

export type ManualReviewBoardRoutineSave = Omit<ManualReviewBoardRoutine, "version"> & {
  expectedVersion: number;
  /** The caller as the runtime attributed it. Kept with the record. */
  savedById: string;
};

export class ManualReviewBoardRoutineStore {
  constructor(private readonly deps: ManualReviewBoardRoutineStoreDeps) {}

  /** The routine saved under an ID, or null. Reads only. */
  readonly get = (routineId: string): ManualReviewBoardRoutine | null => {
    const routine = manualReviewBoardRoutineOf(
      this.deps.getDurableAction(manualReviewBoardRoutineActionId(this.deps.authorityCellId, routineId)),
    );
    return routine && routine.id === routineId ? routine : null;
  };

  /** Saved routines, optionally those of one connection or one channel, by ID. Reads only. */
  readonly list = (filter: { connectionId?: string; channel?: string } = {}): ManualReviewBoardRoutine[] => {
    const routines: ManualReviewBoardRoutine[] = [];
    for (const action of this.deps.listDurableActions(MANUAL_REVIEW_ROUTINE_ACTION_KIND)) {
      if (action.authorityCellId !== this.deps.authorityCellId) continue;
      const routine = manualReviewBoardRoutineOf(action);
      if (!routine) continue;
      if (filter.connectionId && routine.connectionId !== filter.connectionId) continue;
      if (filter.channel && routine.channel !== filter.channel) continue;
      routines.push(routine);
    }
    return routines.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  };

  /**
   * Write the next version of a routine. The caller has checked the fields;
   * this checks only that `expectedVersion` is the saved version.
   */
  readonly save = (input: ManualReviewBoardRoutineSave): Promise<ManualReviewBoardRoutineSaveResponse> => {
    const actionId = manualReviewBoardRoutineActionId(this.deps.authorityCellId, input.id);
    return this.deps.runDurableWrite(async () => {
      const existing = this.deps.getDurableAction(actionId);
      const current = manualReviewBoardRoutineOf(existing);
      if (existing && (!current || current.id !== input.id)) {
        // An older or foreign record holds the ID. It is left as it is.
        throw new ManualReviewBoardError(409, {
          error: "manual_review_routine_version_conflict",
          detail: "The record for this routine ID is not a readable Board review routine. Nothing was written.",
        });
      }
      const savedVersion = current?.version ?? 0;
      if (input.expectedVersion !== savedVersion) {
        throw new ManualReviewBoardError(409, {
          error: "manual_review_routine_version_conflict",
          detail: current
            ? `Routine ${input.id} is saved at version ${current.version}, not ${input.expectedVersion}. Read it again and save from that version.`
            : `No routine is saved as ${input.id}. Create it with expectedVersion 0.`,
          ...(current ? { routine: current } : {}),
        });
      }
      const at = this.deps.now?.() ?? Date.now();
      const routine: ManualReviewBoardRoutine = {
        id: input.id,
        name: input.name,
        version: savedVersion + 1,
        connectionId: input.connectionId,
        channel: input.channel,
        projectPath: input.projectPath,
        harness: input.harness,
        enabled: input.enabled,
      };
      const action: DurableAction = {
        id: actionId,
        kind: MANUAL_REVIEW_ROUTINE_ACTION_KIND,
        subjectId: input.id,
        authorityCellId: this.deps.authorityCellId,
        state: "pending",
        idempotencyKey: input.id,
        leaseGeneration: 0,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        metadata: {
          [MANUAL_REVIEW_ROUTINE_METADATA_KEY]: {
            schemaVersion: MANUAL_REVIEW_ROUTINE_SCHEMA_VERSION,
            ...routine,
            savedById: input.savedById,
            savedAt: at,
          },
        },
      };
      if (!manualReviewBoardRoutineOf(action)) throw new Error("Board review routine is not readable in its stored form");
      await this.deps.commitEntries({ kind: "durable.action.record", action }, async () => {});
      return { routine, created: !current };
    });
  };
}
