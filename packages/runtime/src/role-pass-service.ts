import type {
  CollaborationRecord,
  ControlEvent,
  FlightRecord,
  InvocationRequest,
  ScoutDeliverRequest,
  ScoutDeliverResponse,
  ScoutRoleAssignment,
  ScoutRoleSlot,
} from "@openscout/protocol";
import { SCOUT_ROLE_CATALOG, roleSlotBehind, rolePassAssignmentId } from "@openscout/protocol";

import { listRoleAssignments } from "./assigned-roles-store.js";
import { roleSlotBoardCards, type RoleSlotBoardCard } from "./broker-roles-http.js";
import { applyRolePassAnswer, rolePassBundleFor, rolePassDeliverRequest } from "./role-pass-runner.js";
import { RolePassScheduler, type RolePassEnsureResult } from "./role-pass-scheduler.js";
import { readRoleSlot } from "./role-slots-store.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface RolePassServiceDeps {
  nodeId: string;
  openDb(): ControlPlaneSqliteDatabase | null;
  work: Parameters<typeof roleSlotBoardCards>[0];
  runtime: {
    invocation(invocationId: string): InvocationRequest | undefined;
    flightForInvocation(invocationId: string): FlightRecord | undefined;
    collaborationRecord(recordId: string): CollaborationRecord | undefined;
  };
  /** Every invocation the runtime holds, read once at start to find a pass that outlived a restart. */
  invocations(): Iterable<InvocationRequest>;
  deliver(request: ScoutDeliverRequest): Promise<ScoutDeliverResponse>;
  /** Live fan-out of `role.slot.written`. */
  publish(event: ControlEvent): void;
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Role passes on one runtime: the scheduler, the pass lock read from flights,
 * starting a pass, and writing its answer. The runtime feeds it every control
 * event and every terminal flight.
 */
export class RolePassService {
  readonly scheduler: RolePassScheduler;
  /** The latest pass invocation per assignment. Only the latest can be unended: passes never overlap. */
  private readonly latestPass = new Map<string, { invocationId: string; createdAt: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: RolePassServiceDeps) {
    this.now = deps.now ?? Date.now;
    for (const invocation of deps.invocations()) this.notePassInvocation(invocation);
    this.scheduler = new RolePassScheduler({
      passAssignments: () => this.passAssignments(),
      runningPass: (assignmentId) => this.runningPass(assignmentId),
      behind: (assignmentId) => this.behind(assignmentId),
      startPass: (assignment, reason) => this.startPass(assignment, reason),
      invocationMetadata: (invocationId) => deps.runtime.invocation(invocationId)?.metadata,
      isWorkItem: (recordId) => deps.runtime.collaborationRecord(recordId)?.kind === "work_item",
      now: this.now,
      warn: deps.warn,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
    });
  }

  noteEvent(event: ControlEvent): void {
    if (event.kind === "invocation.requested") this.notePassInvocation(event.payload.invocation);
    this.scheduler.noteEvent(event);
  }

  ensure(assignmentId: string): Promise<RolePassEnsureResult> {
    return this.scheduler.ensure(assignmentId);
  }

  runningPass(assignmentId: string): { flightId: string } | null {
    const latest = this.latestPass.get(assignmentId);
    if (!latest) return null;
    const flight = this.deps.runtime.flightForInvocation(latest.invocationId);
    return flight && !TERMINAL.has(flight.state) ? { flightId: flight.id } : null;
  }

  /**
   * A flight reached a terminal state. When it was a completed pass, write its
   * answer to the slot and announce the new version.
   */
  applyTerminalFlight(db: ControlPlaneSqliteDatabase, flight: FlightRecord, invocation: InvocationRequest | undefined): string | null {
    const result = applyRolePassAnswer(db, { flight, invocation, now: this.now() });
    if (result.kind === "not_a_pass") return null;
    if (result.kind === "skipped") return `role pass ${flight.id} left the slot alone: ${result.reason}`;
    this.publishWritten(result.slot);
    return `role pass ${flight.id} wrote slot ${result.slot.assignmentId} v${result.slot.version}`;
  }

  publishWritten(slot: ScoutRoleSlot): void {
    this.deps.publish({
      id: `role-slot-${slot.assignmentId}-${slot.version}`,
      kind: "role.slot.written",
      ts: slot.writtenAt,
      actorId: slot.writtenById,
      payload: { assignmentId: slot.assignmentId, roleId: slot.roleId, version: slot.version },
    });
  }

  stop(): void {
    this.scheduler.stop();
  }

  private notePassInvocation(invocation: InvocationRequest): void {
    const assignmentId = rolePassAssignmentId(invocation.metadata);
    if (!assignmentId) return;
    const current = this.latestPass.get(assignmentId);
    if (current && current.createdAt > invocation.createdAt) return;
    this.latestPass.set(assignmentId, { invocationId: invocation.id, createdAt: invocation.createdAt });
  }

  private passAssignments() {
    const db = this.deps.openDb();
    if (!db) return [];
    // Per role, so many assignments of other roles never crowd out a pass role.
    return SCOUT_ROLE_CATALOG.flatMap((role) => role.pass
      ? listRoleAssignments(db, { roleId: role.id, activeOnly: true }).map((assignment) => ({ assignment, policy: role.pass! }))
      : []);
  }

  private cards(): RoleSlotBoardCard[] {
    try {
      return roleSlotBoardCards(this.deps.work) ?? [];
    } catch (error) {
      this.deps.warn?.("[openscout-runtime] role pass could not read the board", error);
      return [];
    }
  }

  private behind(assignmentId: string): boolean {
    const db = this.deps.openDb();
    if (!db) return false;
    return roleSlotBehind(readRoleSlot(db, assignmentId)?.stamp, this.cards());
  }

  private async startPass(assignment: ScoutRoleAssignment, reason: string): Promise<{ flightId: string }> {
    const db = this.deps.openDb();
    if (!db) throw new Error("roles store not open");
    const bundle = rolePassBundleFor(db, {
      assignmentId: assignment.id,
      cards: this.cards(),
      record: (workId) => this.deps.runtime.collaborationRecord(workId),
    });
    const response = await this.deps.deliver(rolePassDeliverRequest({ assignment, bundle, nodeId: this.deps.nodeId, now: this.now(), reason }));
    if (response.kind !== "delivery" || !response.flight) {
      throw new Error(`role pass for ${assignment.id} was not accepted (${response.kind})`);
    }
    const invocationId = response.flight.invocationId;
    this.latestPass.set(assignment.id, { invocationId, createdAt: this.now() });
    return { flightId: response.flight.id };
  }
}
