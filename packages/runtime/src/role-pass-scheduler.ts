import type { ControlEvent, ScoutRoleAssignment, ScoutRolePassPolicy } from "@openscout/protocol";
import { rolePassAssignmentId } from "@openscout/protocol";

/**
 * Coalesces work changes into role passes. One dirty bit per assignment and
 * no queue: a work change marks it, and after the role's quiet window (or its
 * longest wait) one pass starts. A pass that is still running is the lock;
 * the runtime reads it from the flights, so it survives a restart. A change
 * that lands during a pass leaves the bit set, and a pass that completes with
 * the bit set schedules one more. A failed pass schedules nothing; the next
 * change does.
 */
export interface RolePassSchedulerDeps {
  /** Active assignments whose role defines a pass, with that pass policy. */
  passAssignments(): ReadonlyArray<{ assignment: ScoutRoleAssignment; policy: ScoutRolePassPolicy }>;
  /** The unended flight that holds this assignment's pass lock, if any. */
  runningPass(assignmentId: string): { flightId: string } | null;
  /** Whether the slot is behind the board. Page opens start a pass only then. */
  behind(assignmentId: string): boolean;
  startPass(assignment: ScoutRoleAssignment, reason: RolePassReason): Promise<{ flightId: string }>;
  /** The invocation metadata behind a flight, to recognise a pass ending. */
  invocationMetadata(invocationId: string): Record<string, unknown> | undefined;
  /** The holder-independent kind check: is this record id a work item? */
  isWorkItem(recordId: string): boolean;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  warn?: (message: string, error?: unknown) => void;
}

export type RolePassReason = "work.changed" | "page.open";

export interface RolePassEnsureResult {
  flightId: string | null;
  started: boolean;
  behind: boolean;
}

export class RolePassError extends Error {
  constructor(readonly status: 404, message: string) {
    super(message);
  }
}

interface PassState {
  dirtySince: number | null;
  timer: unknown;
  starting: Promise<{ flightId: string }> | null;
}

const TERMINAL_FLIGHT_STATES = new Set(["completed", "failed", "cancelled"]);

export class RolePassScheduler {
  private readonly states = new Map<string, PassState>();
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: RolePassSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((run, ms) => {
      const handle = setTimeout(run, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Feed every control event. Cheap for events that are not work changes. */
  noteEvent(event: ControlEvent): void {
    if (event.kind === "flight.updated") {
      this.notePassEnd(event.payload.flight);
      return;
    }
    const change = workChange(event, (id) => this.deps.isWorkItem(id));
    if (!change) return;
    for (const { assignment, policy } of this.deps.passAssignments()) {
      // The holder's own changes never start its pass.
      if (change.actorId && change.actorId === assignment.agentId) continue;
      this.markDirty(assignment.id, policy);
    }
  }

  /**
   * Page open: return the running pass, or start one when the slot is behind.
   * Never starts a second pass.
   */
  async ensure(assignmentId: string): Promise<RolePassEnsureResult> {
    const entry = this.deps.passAssignments().find((candidate) => candidate.assignment.id === assignmentId);
    if (!entry) throw new RolePassError(404, `No active assignment ${assignmentId} with a pass.`);
    const state = this.state(assignmentId);
    if (state.starting) {
      const { flightId } = await state.starting;
      return { flightId, started: false, behind: true };
    }
    const running = this.deps.runningPass(assignmentId);
    if (running) return { flightId: running.flightId, started: false, behind: this.deps.behind(assignmentId) };
    if (!this.deps.behind(assignmentId)) return { flightId: null, started: false, behind: false };
    const { flightId } = await this.start(entry.assignment, "page.open");
    return { flightId, started: true, behind: true };
  }

  /** Whether the assignment has a change waiting for a pass. For tests and status. */
  dirty(assignmentId: string): boolean {
    return this.states.get(assignmentId)?.dirtySince != null;
  }

  stop(): void {
    for (const state of this.states.values()) {
      if (state.timer != null) this.clearTimer(state.timer);
      state.timer = null;
    }
  }

  private state(assignmentId: string): PassState {
    let state = this.states.get(assignmentId);
    if (!state) {
      state = { dirtySince: null, timer: null, starting: null };
      this.states.set(assignmentId, state);
    }
    return state;
  }

  private markDirty(assignmentId: string, policy: ScoutRolePassPolicy): void {
    const state = this.state(assignmentId);
    state.dirtySince ??= this.now();
    this.schedule(assignmentId, policy);
  }

  private schedule(assignmentId: string, policy: ScoutRolePassPolicy): void {
    const state = this.state(assignmentId);
    if (state.dirtySince == null) return;
    if (state.timer != null) this.clearTimer(state.timer);
    const untilCap = state.dirtySince + policy.maxWaitMs - this.now();
    const delay = Math.max(0, Math.min(policy.quietMs, untilCap));
    state.timer = this.setTimer(() => this.fire(assignmentId), delay);
  }

  private fire(assignmentId: string): void {
    const state = this.state(assignmentId);
    state.timer = null;
    if (state.starting || state.dirtySince == null) return;
    // A running pass keeps the bit; its end schedules the next one.
    if (this.deps.runningPass(assignmentId)) return;
    const entry = this.deps.passAssignments().find((candidate) => candidate.assignment.id === assignmentId);
    if (!entry) {
      state.dirtySince = null;
      return;
    }
    void this.start(entry.assignment, "work.changed").catch((error) => {
      this.deps.warn?.(`[openscout-runtime] role pass for ${assignmentId} did not start`, error);
    });
  }

  private start(assignment: ScoutRoleAssignment, reason: RolePassReason): Promise<{ flightId: string }> {
    const state = this.state(assignment.id);
    if (state.timer != null) this.clearTimer(state.timer);
    state.timer = null;
    state.dirtySince = null;
    const starting = this.deps.startPass(assignment, reason).finally(() => {
      if (state.starting === starting) state.starting = null;
    });
    state.starting = starting;
    return starting;
  }

  private notePassEnd(flight: { invocationId: string; state: string }): void {
    if (!TERMINAL_FLIGHT_STATES.has(flight.state)) return;
    const assignmentId = rolePassAssignmentId(this.deps.invocationMetadata(flight.invocationId) as never);
    if (!assignmentId) return;
    const state = this.states.get(assignmentId);
    if (!state || state.dirtySince == null || flight.state !== "completed") return;
    const entry = this.deps.passAssignments().find((candidate) => candidate.assignment.id === assignmentId);
    if (entry) this.schedule(assignmentId, entry.policy);
  }
}

/**
 * The work item a control event changed and who changed it, or null when it
 * changed no work item. An upsert names the record's creator, not the writer,
 * so only an appended event says who acted.
 */
export function workChange(
  event: ControlEvent,
  isWorkItem: (recordId: string) => boolean,
): { recordId: string; actorId: string | null } | null {
  if (event.kind === "collaboration.upserted") {
    return event.payload.record.kind === "work_item" ? { recordId: event.payload.record.id, actorId: null } : null;
  }
  if (event.kind === "collaboration.event.appended") {
    const { recordId, actorId } = event.payload.event;
    return recordId && isWorkItem(recordId) ? { recordId, actorId: actorId ?? null } : null;
  }
  return null;
}
