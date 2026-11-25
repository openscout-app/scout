import type { VercelBoardLeadStatus } from "@openscout/protocol";
import type { VercelBoardMirror, VercelBoardPlanEventRow } from "./mirror.js";
import type { VercelBoardLeadRow, VercelBoardStore } from "./store.js";

/** The task events a lead hears about: an end, a wait on the operator, and the operator's answer. */
export const VERCEL_BOARD_LEAD_KINDS = new Set(["completed", "failed", "canceled", "blocked", "unblocked"]);
const BATCH = 50;

export interface VercelBoardLeadNotice {
  lead: string;
  planId: string;
  channel: string;
  /** The first event this notice covers, for an idempotent delivery. */
  from: number;
  events: VercelBoardPlanEventRow[];
  counts: VercelBoardLeadStatus["tasks"];
  done: boolean;
}

export interface VercelBoardLeadDeps {
  connectionId: string;
  store: VercelBoardStore;
  mirror: VercelBoardMirror;
  /** Whether the swarm is on for a channel. Off, the lead is not told. */
  swarm(channel: string): boolean;
  /** Tell the lead. A throw keeps the cursor, so the next pass tells it again. */
  tell(notice: VercelBoardLeadNotice): Promise<void>;
  now?: () => number;
}

/**
 * The lead loop: one per connection. For each plan the operator made through
 * Scout, it reads the plan's task events after its cursor and tells the plan's
 * lead about each end, each wait on the operator, and each answer. It wakes
 * on feed events and on the custody sweep. One pass runs at a time; a wake
 * during a pass runs one more after it, so an event that lands while the lead
 * is being told is told next.
 */
export class VercelBoardLead {
  private running: Promise<void> | null = null;
  private again = false;
  private readonly now: () => number;

  constructor(private readonly deps: VercelBoardLeadDeps) {
    this.now = deps.now ?? Date.now;
  }

  pass(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this.passOnce(); } while (this.again);
      } finally { this.running = null; }
    })();
    return this.running;
  }

  idle(): Promise<void> { return this.running ?? Promise.resolve(); }

  status(): VercelBoardLeadStatus[] {
    return this.deps.store.plans(this.deps.connectionId).map(row => this.statusOf(row));
  }

  private statusOf(row: VercelBoardLeadRow): VercelBoardLeadStatus {
    return {
      planId: row.planId, channel: row.channel, lead: row.lead, cursor: row.cursor,
      tasks: this.deps.mirror.planCounts(this.deps.connectionId, row.planId), done: row.done,
      ...(row.lastNoticeAt ? { lastNoticeAt: row.lastNoticeAt } : {}), ...(row.lastError ? { lastError: row.lastError } : {}),
    };
  }

  private async passOnce(): Promise<void> {
    const { connectionId, store, mirror } = this.deps;
    for (const row of store.plans(connectionId)) {
      if (row.done || !this.deps.swarm(row.channel)) continue;
      const events = mirror.planEvents(connectionId, row.planId, row.cursor, BATCH);
      const counts = mirror.planCounts(connectionId, row.planId);
      const done = counts.open === 0 && counts.blocked === 0 && counts.completed + counts.failed > 0;
      if (!events.length) {
        if (done) store.updatePlan(connectionId, row.planId, { done: true });
        continue;
      }
      const cursor = events.at(-1)!.seq;
      const heard = events.filter(event => VERCEL_BOARD_LEAD_KINDS.has(event.kind));
      // The last batch of a finished plan closes it; an earlier batch leaves more to read.
      const finished = done && events.length < BATCH;
      if (heard.length && row.lead) {
        try {
          await this.deps.tell({ lead: row.lead, planId: row.planId, channel: row.channel, from: events[0]!.seq, events: heard, counts, done: finished });
        } catch (error) {
          store.updatePlan(connectionId, row.planId, { lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
          continue;
        }
        store.updatePlan(connectionId, row.planId, { cursor, lastNoticeAt: this.now(), lastError: null, ...(finished ? { done: true } : {}) });
      } else {
        store.updatePlan(connectionId, row.planId, { cursor, ...(finished ? { done: true } : {}) });
      }
      if (events.length === BATCH) this.again = true;
    }
  }
}
