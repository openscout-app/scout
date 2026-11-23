/**
 * Board review: a saved routine, a preview of what a run would pin, and the
 * run itself.
 *
 * The caller names a routine and a Board item. Everything else is the
 * runtime's: which connection and channel may be read, which project and
 * harness review, the item's version on the board, and the commit checked out
 * in the project. A run records a manual review occurrence and dispatches it
 * through the same services as every other manual review, so a retry reads
 * the same ticket and the reviewer's work is an ordinary work item.
 *
 * Order matters here. Local checks come before the Board credential is
 * touched, and a request that a stored run already answers reads nothing from
 * the board at all.
 */
import {
  MANUAL_REVIEW_BOARD_ARTIFACT_KIND,
  manualReviewBoardInputSource,
  manualReviewBoardRunDifferences,
  manualReviewBoardScope,
  validateManualReviewBoardPreviewRequest,
  validateManualReviewBoardRoutineSaveRequest,
  validateManualReviewBoardRunRequest,
  type ManualReviewBoardPreviewRequest,
  type ManualReviewBoardPreviewResponse,
  type ManualReviewBoardRoutine,
  type ManualReviewBoardRoutineSaveRequest,
  type ManualReviewBoardRoutineSaveResponse,
  type ManualReviewBoardRunRequest,
  type ManualReviewBoardRunResponse,
  type ManualReviewDispatchTarget,
  type ManualReviewPinnedField,
  type ScoutAttribution,
} from "@openscout/protocol";

import { ManualReviewBoardError, type ManualReviewBoardRoutineStore } from "./manual-review-board-routines.js";
import type { ManualReviewDispatchOptions, ManualReviewDispatchService } from "./manual-review-dispatch.js";
import type { ManualReviewOccurrenceService } from "./manual-review-occurrences.js";
import { ManualReviewProjectError, manualReviewProjectReader, type ManualReviewProjectReader } from "./manual-review-project.js";
import { VercelBoardServiceError } from "./vercel-board/service.js";

/** The two Board reads a review needs. `BrokerVercelBoardService` provides them. */
export type ManualReviewBoardReads = {
  /** Local configuration only: may a routine name this connection and channel. */
  reviewChannel(request: { connectionId: string; channel: string }): Promise<void>;
  /** One read of one item, after every local check. Never a write. */
  reviewGrant(request: { connectionId: string; channel: string; itemId: string }): {
    check: () => void;
    read: () => Promise<{ id: string; version: number; pinSource: () => string }>;
  };
};

export type ManualReviewBoardServiceDeps = {
  routines: ManualReviewBoardRoutineStore;
  occurrences: Pick<ManualReviewOccurrenceService, "record" | "lookup">;
  dispatch: Pick<ManualReviewDispatchService, "dispatch">;
  /** Absent on a host with no Board adapter. Read when a request needs it, so it may be set after this service is built. */
  board: () => ManualReviewBoardReads | null | undefined;
  project?: ManualReviewProjectReader;
  now?: () => number;
};

function invalid(errors: string[]): ManualReviewBoardError {
  return new ManualReviewBoardError(400, { error: "invalid_manual_review_request", detail: errors.join("; ") });
}

export class ManualReviewBoardService {
  private readonly project: ManualReviewProjectReader;

  constructor(private readonly deps: ManualReviewBoardServiceDeps) {
    this.project = deps.project ?? manualReviewProjectReader;
  }

  readonly list = (filter: { connectionId?: string; channel?: string } = {}): ManualReviewBoardRoutine[] =>
    this.deps.routines.list(filter);

  /**
   * Create or replace a routine. The project is stored as its canonical path,
   * so a later read compares the same path this save checked.
   */
  readonly save = async (
    request: ManualReviewBoardRoutineSaveRequest,
    attribution: ScoutAttribution,
  ): Promise<ManualReviewBoardRoutineSaveResponse> => {
    const errors = validateManualReviewBoardRoutineSaveRequest(request);
    if (errors.length > 0) throw invalid(errors);
    const saved = this.deps.routines.get(request.id);
    if (!request.enabled && (saved || request.expectedVersion !== 0)) {
      // Turning off a grant is a local CAS, not a reconfiguration. Preserve
      // its saved fields even if the project or connection has vanished.
      return this.deps.routines.save({
        ...(saved ?? request), enabled: false, expectedVersion: request.expectedVersion, savedById: attribution.actorId,
      });
    }
    let projectPath: string;
    try {
      projectPath = await this.project.canonical(request.projectPath);
    } catch (error) {
      if (error instanceof ManualReviewProjectError) {
        throw new ManualReviewBoardError(400, { error: `manual_review_${error.code}`, detail: error.message });
      }
      throw error;
    }
    await this.boardCall(board => board.reviewChannel({ connectionId: request.connectionId, channel: request.channel }));
    return this.deps.routines.save({
      id: request.id,
      name: request.name,
      connectionId: request.connectionId,
      channel: request.channel,
      projectPath,
      harness: request.harness,
      enabled: request.enabled,
      expectedVersion: request.expectedVersion,
      savedById: attribution.actorId,
    });
  };

  /** What a run requested now would pin. Reads the board once and writes nothing anywhere. */
  readonly preview = async (request: ManualReviewBoardPreviewRequest): Promise<ManualReviewBoardPreviewResponse> => {
    const errors = validateManualReviewBoardPreviewRequest(request);
    if (errors.length > 0) throw invalid(errors);
    return (await this.read(this.enabledRoutine(request.routineId), request.itemId)).pins;
  };

  /**
   * Start the review the operator previewed, or return the ticket of the run
   * this request ID already started.
   *
   * A request ID that already has a run is answered from the stored record:
   * its pins must match the request, and the board is not read. A new run is
   * admitted only when the routine version, the item's version and the
   * checked-out commit are all still what the request states.
   */
  readonly run = async (
    request: ManualReviewBoardRunRequest,
    attribution: ScoutAttribution,
    options: ManualReviewDispatchOptions = {},
  ): Promise<ManualReviewBoardRunResponse> => {
    const errors = validateManualReviewBoardRunRequest(request);
    if (errors.length > 0) throw invalid(errors);
    const scope = manualReviewBoardScope(request.routineId);
    const stored = this.deps.occurrences.lookup({ scope, requestId: request.requestId });
    if (stored) {
      const differs = manualReviewBoardRunDifferences(stored, request);
      if (differs.length > 0) {
        throw new ManualReviewBoardError(409, {
          error: "manual_review_conflict",
          detail: `This request ID already names a run with different pins (${differs.join(", ")}). Its record is unchanged. Use a new request ID for a new run.`,
          differs,
          occurrence: stored,
        });
      }
      if (stored.dispatch) {
        // Recover acceptance from Scout before checking the live grant.
        // Only a retry that could start work needs another authorized read.
        return this.deps.dispatch.dispatch({ scope, requestId: request.requestId, target: stored.dispatch.target, attribution }, {
          ...options,
          prepareBoardAsk: async () => (await this.readRun(request)).prepare(),
        });
      }
    }

    const { pins: current, check, prepare } = await this.readRun(request);
    const prepared = prepare();
    const routine = current.routine;

    await this.deps.occurrences.record({
      scope,
      requestId: request.requestId,
      input: current.input,
      artifact: { ...current.artifact, observedAt: this.deps.now?.() ?? Date.now() },
      routine: { id: routine.id, version: routine.version },
      requestedById: attribution.actorId,
    }, check);
    const target: ManualReviewDispatchTarget = { kind: "project_path", projectPath: routine.projectPath, harness: routine.harness };
    return this.deps.dispatch.dispatch({ scope, requestId: request.requestId, target, attribution }, {
      ...options, prepareBoardAsk: () => prepared,
    });
  };

  private checkRoutine(id: string, version: number): ManualReviewBoardRoutine {
    const routine = this.enabledRoutine(id);
    if (routine.version !== version) {
      throw this.changed(["routine.version"], `Routine ${id} is saved at version ${routine.version}, not ${version}.`);
    }
    return routine;
  }

  private async readRun(request: ManualReviewBoardRunRequest) {
    const read = await this.read(this.checkRoutine(request.routineId, request.routineVersion), request.itemId);
    const current = read.pins;
    const differs: ManualReviewPinnedField[] = [];
    if (current.input.version !== request.inputVersion) differs.push("input.version");
    if (current.artifact.revision !== request.revision) differs.push("artifact.revision");
    if (differs.length > 0) {
      throw this.changed(differs, "The Board item or the checked-out commit changed after the preview.", current);
    }
    return read;
  }

  private routine(routineId: string): ManualReviewBoardRoutine {
    const routine = this.deps.routines.get(routineId);
    if (!routine) {
      throw new ManualReviewBoardError(404, { error: "manual_review_routine_not_found", detail: `No Board review routine is saved as ${routineId}.` });
    }
    return routine;
  }

  private requireEnabled(routine: ManualReviewBoardRoutine): void {
    if (!routine.enabled) {
      throw new ManualReviewBoardError(409, {
        error: "manual_review_routine_disabled",
        detail: `Routine ${routine.id} is disabled. It reads nothing and starts nothing until it is enabled again.`,
      });
    }
  }

  private enabledRoutine(routineId: string): ManualReviewBoardRoutine {
    const routine = this.routine(routineId);
    this.requireEnabled(routine);
    return routine;
  }

  private changed(differs: ManualReviewPinnedField[], why: string, current?: ManualReviewBoardPreviewResponse): ManualReviewBoardError {
    return new ManualReviewBoardError(409, {
      error: "manual_review_preview_changed",
      detail: `${why} No new review started. Preview again, then run with a new request ID.`,
      differs,
      ...(current ? { current } : {}),
    });
  }

  /**
   * Read what an enabled routine would pin for one item. The project is read
   * first: it is local, and a project that is gone means no Board read at all.
   */
  private async read(routine: ManualReviewBoardRoutine, itemId: string) {
    const board = this.boardAdapter();
    const grant = this.translateBoard(() => board.reviewGrant({ connectionId: routine.connectionId, channel: routine.channel, itemId }));
    const check = () => {
      this.checkRoutine(routine.id, routine.version);
      if (this.deps.board() !== board) {
        throw new ManualReviewBoardError(409, { error: "vercel_board_changed", detail: "The Board adapter changed while preparing the review." });
      }
      this.translateBoard(grant.check);
    };
    let revision: string;
    try {
      const canonical = await this.project.canonical(routine.projectPath);
      if (canonical !== routine.projectPath) {
        throw new ManualReviewProjectError("project_not_found", `The project of routine ${routine.id} no longer resolves to the path it was saved with. Save the routine again.`);
      }
      revision = await this.project.head(canonical);
    } catch (error) {
      if (error instanceof ManualReviewProjectError) {
        throw new ManualReviewBoardError(409, { error: `manual_review_${error.code}`, detail: error.message });
      }
      throw error;
    }
    check();
    let item: Awaited<ReturnType<typeof grant.read>>;
    try { item = await grant.read(); }
    catch (error) { throw this.boardError(error); }
    check();
    const pins: ManualReviewBoardPreviewResponse = {
      routine,
      input: { source: manualReviewBoardInputSource(routine.connectionId, routine.channel), id: item.id, version: String(item.version) },
      artifact: { kind: MANUAL_REVIEW_BOARD_ARTIFACT_KIND, ref: routine.projectPath, revision },
    };
    return { pins, check, prepare: () => {
      check();
      return { reference: this.translateBoard(item.pinSource), check };
    } };
  }

  private boardAdapter(): ManualReviewBoardReads {
    const board = this.deps.board();
    if (!board) {
      throw new ManualReviewBoardError(503, { error: "vercel_board_unavailable", detail: "This runtime has no Vercel Board adapter running." });
    }
    return board;
  }

  private boardError(error: unknown): unknown {
    return error instanceof VercelBoardServiceError
      ? new ManualReviewBoardError(error.status, { error: error.code, detail: error.message, ...(error.fix ? { fix: error.fix } : {}) })
      : error;
  }

  private translateBoard<T>(call: () => T): T {
    try { return call(); }
    catch (error) { throw this.boardError(error); }
  }

  private async boardCall<T>(call: (board: ManualReviewBoardReads) => Promise<T>): Promise<T> {
    try { return await call(this.boardAdapter()); }
    catch (error) { throw this.boardError(error); }
  }
}
