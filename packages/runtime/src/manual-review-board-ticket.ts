import {
  assertValidCollaborationEvent, assertValidCollaborationRecord, manualReviewBoardScope,
  type CollaborationEvent, type CollaborationRecord, type CompiledWorkLifecycle, type FlightRecord,
  type ManualReviewOccurrence, type ScoutAttribution, type WorkItemRecord,
} from "@openscout/protocol";
import { planWorkMove, planWorkReview } from "./broker-work-lifecycles.js";
import { ManualReviewBoardError } from "./manual-review-board-routines.js";
import { manualReviewWorkId } from "./manual-review-dispatch.js";

interface TicketDeps {
  work: (id: string) => CollaborationRecord | null | undefined;
  occurrence: (id: string) => ManualReviewOccurrence | null;
  latestFlight: (workId: string) => FlightRecord | undefined;
  lifecycle: (record: WorkItemRecord) => CompiledWorkLifecycle;
  children: (id: string) => WorkItemRecord[];
  write: <T>(action: () => Promise<T>) => Promise<T>;
  commit: (work: WorkItemRecord, events: CollaborationEvent[]) => Promise<void>;
}

function missing(): never {
  throw new ManualReviewBoardError(404, { error: "board_ticket_not_found", detail: "No Board review ticket has this work ID." });
}

function conflict(detail: string): never {
  throw new ManualReviewBoardError(409, { error: "board_review_not_ready", detail });
}

/** Reopening and accepting operate entirely on the original Scout records. */
export class ManualReviewBoardTickets {
  constructor(private readonly deps: TicketDeps) {}

  private resolve(workId: string) {
    if (!/^work-manual-review-[0-9a-f]{32}$/.test(workId)) return missing();
    const occurrence = this.deps.occurrence(workId.slice("work-".length));
    const work = this.deps.work(workId);
    const ticket = occurrence?.dispatch?.ticket;
    const target = occurrence?.dispatch?.target;
    if (!work || work.kind !== "work_item" || !occurrence?.routine || !ticket || target?.kind !== "project_path"
      || occurrence.scope !== manualReviewBoardScope(occurrence.routine.id) || manualReviewWorkId(occurrence.id) !== workId
      || ticket.workId !== workId || work.metadata?.manualReviewOccurrenceId !== occurrence.id
      || work.metadata?.source !== "scout-manual-review") return missing();
    const { input, artifact, routine } = occurrence;
    // Expose the provenance, without projecting source text or raw provider responses.
    const pins = { workId, input: { source: input.source, id: input.id, version: input.version },
      artifact: { kind: artifact.kind, ref: artifact.ref, revision: artifact.revision },
      routine: { id: routine.id, version: routine.version }, target };
    return { work, ticket, pins };
  }

  read(workId: string) {
    const { work, pins } = this.resolve(workId);
    return { ...pins, state: work.state, acceptanceState: work.acceptanceState };
  }

  accept(workId: string, attribution: ScoutAttribution) {
    return this.deps.write(async () => {
      const { work, ticket, pins } = this.resolve(workId);
      if (work.state === "done" && work.acceptanceState === "accepted") {
        return { ...pins, state: work.state, acceptanceState: work.acceptanceState };
      }
      const flight = this.deps.latestFlight(workId);
      if (work.state !== "review" || work.acceptanceState !== "pending" || flight?.id !== ticket.flightId
        || flight.invocationId !== ticket.invocationId || flight.state !== "completed") {
        return conflict("This ticket must have its completed reviewer result before it can be accepted.");
      }
      const machine = this.deps.lifecycle(work);
      const actorId = attribution.actorId;
      const now = Math.max(Date.now(), work.updatedAt);
      const moveId = workId + ":accept:" + now;
      const move = planWorkMove(machine, work, { workId, actorId, attribution, to: machine.stationForState("done"),
        note: "Operator accepted the Board review." }, { now, moveId, children: this.deps.children(workId) });
      if (!move.record || !move.event || !move.move || move.move.revision === undefined) {
        return conflict(move.decision.reasons.filter(reason => reason.outcome === "fail").map(reason => reason.message).join(" ") || "The work lifecycle did not allow acceptance.");
      }
      const events = [move.event];
      let accepted: WorkItemRecord = { ...move.record, acceptanceState: "accepted" };
      if (move.move.review === "pending") {
        const review = planWorkReview(machine, move.record, move.move, { workId, moveId, actorId, attribution,
          revision: move.move.revision, verdict: "confirm" }, { now, eventId: moveId + ":review" });
        if (review.status !== "confirmed" || !review.record) return conflict("The work item moved before the review was accepted.");
        accepted = { ...review.record, acceptanceState: "accepted" };
        events.push(review.event);
      } else {
        events[0] = { ...move.event, kind: "accepted", summary: "Operator accepted the Board review." };
      }
      assertValidCollaborationRecord(accepted);
      for (const event of events) assertValidCollaborationEvent(event, accepted);
      await this.deps.commit(accepted, events);
      return { ...pins, state: accepted.state, acceptanceState: accepted.acceptanceState };
    });
  }
}
