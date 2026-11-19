import { randomUUID } from "node:crypto";
import type { VercelBoardConnectionConfig, FlightRecord } from "@openscout/protocol";
import { VercelBoardHttpError, VercelBoardUnknownOutcomeError, type VercelBoardTransport } from "./client.js";
import { vercelBoardPrincipalOf } from "./projection.js";
import type { VercelBoardCustodyRow, VercelBoardSettleOutcome, VercelBoardStore } from "./store.js";
import type { VercelBoardWireMessage } from "./wire.js";

/** Vercel caps a lease at 300 seconds. The local board allows more; Scout designs for the lower cap. */
export const VERCEL_BOARD_LEASE_SECONDS = 300;
/**
 * The first claim asks for a short lease. The claim request has no
 * idempotency key and Board shows the token once, so a lost answer leaves a
 * claim Scout cannot use; a short lease bounds that stall.
 */
export const VERCEL_BOARD_FIRST_LEASE_SECONDS = 60;

export class VercelBoardClaimError extends Error {
  constructor(readonly code: "claim_in_progress" | "claim_unknown" | "claim_refused" | "dispatch_failed" | "not_claimable", message: string, readonly status = 409) {
    super(message);
    this.name = "VercelBoardClaimError";
  }
}

export type VercelBoardCustodyNotice =
  | { kind: "lost"; row: VercelBoardCustodyRow; cause: string }
  | { kind: "settled"; row: VercelBoardCustodyRow; outcome: VercelBoardSettleOutcome }
  /** The agent finished, but the claim was gone and the task moved on. The result stays in Scout. */
  | { kind: "finished_claim_lost"; row: VercelBoardCustodyRow; result: string };

type ClaimInput = {
  taskId: string; workId: string; agentId: string; startedBy: string;
  dependencyContext?: { channel: string; owner: string; needs: string[]; lines: string[] };
};

export interface VercelBoardCustodyDeps {
  connection: Pick<VercelBoardConnectionConfig, "id" | "principal">;
  transport: VercelBoardTransport;
  store: VercelBoardStore;
  /** Grant the Scout side: deliver the task to the agent, attached to the projected work item. */
  dispatch(input: ClaimInput & { task: VercelBoardWireMessage; attemptId: string }): Promise<{ flightId: string }>;
  flight(flightId: string): Pick<FlightRecord, "state" | "output" | "error" | "summary"> | undefined;
  cancelFlight?(flightId: string, reason: string): Promise<void>;
  notify?(notice: VercelBoardCustodyNotice): Promise<void> | void;
  now?: () => number;
  leaseSeconds?: number;
  firstLeaseSeconds?: number;
}

const terminal = (state: FlightRecord["state"] | undefined) => state === "completed" || state === "failed" || state === "cancelled";
const SETTLED_STATE: Record<VercelBoardSettleOutcome, string> = { completed: "completed", failed: "failed", released: "ready" };

/**
 * Claim custody. Runtime code, never an agent: claim, renew, settle and
 * retry. The operator starts each claim. The claim request is never retried
 * after an unknown outcome.
 */
export class VercelBoardCustody {
  private readonly now: () => number;
  private readonly lease: number;
  private readonly firstLease: number;
  /** Attempts this process is still claiming or dispatching; a tick leaves them alone. */
  private readonly inFlight = new Set<string>();
  constructor(private readonly deps: VercelBoardCustodyDeps) {
    this.now = deps.now ?? Date.now;
    this.lease = deps.leaseSeconds ?? VERCEL_BOARD_LEASE_SECONDS;
    this.firstLease = Math.min(deps.firstLeaseSeconds ?? VERCEL_BOARD_FIRST_LEASE_SECONDS, this.lease);
  }

  async claim(input: ClaimInput): Promise<VercelBoardCustodyRow> {
    const { connection, store, transport } = this.deps;
    const active = store.activeCustody(connection.id).find(row => row.taskId === input.taskId);
    if (active) {
      throw active.state === "claim_unknown"
        ? new VercelBoardClaimError("claim_unknown", `An earlier claim on ${input.taskId} got no answer. Its lease lapses by ${new Date(active.createdAt + active.leaseSeconds * 1000).toISOString()}; claim again after that.`)
        : new VercelBoardClaimError("claim_in_progress", `Scout already holds or is settling ${input.taskId}.`);
    }
    const attemptId = randomUUID();
    store.insertCustody({ connectionId: connection.id, taskId: input.taskId, attemptId, epoch: null, token: null, until: null,
      leaseSeconds: this.firstLease, agentId: input.agentId, workId: input.workId, startedBy: input.startedBy, flightId: null,
      state: "claiming", outcome: null, result: null, detail: null });
    this.inFlight.add(attemptId);
    try {
      return await this.claimAttempt(input, attemptId);
    } finally {
      this.inFlight.delete(attemptId);
    }
  }

  private async claimAttempt(input: ClaimInput, attemptId: string): Promise<VercelBoardCustodyRow> {
    const { connection, store, transport } = this.deps;
    let grant;
    try {
      grant = await transport.claim(input.taskId, this.firstLease);
    } catch (error) {
      if (error instanceof VercelBoardUnknownOutcomeError) {
        store.updateCustody(connection.id, attemptId, { state: "claim_unknown", detail: "The claim was sent and no answer came back. Not retried: the lease lapses." });
        throw new VercelBoardClaimError("claim_unknown", `The claim on ${input.taskId} got no answer. Scout will not retry it; its lease lapses within ${this.firstLease} seconds.`, 504);
      }
      const code = error instanceof VercelBoardHttpError ? error.code : "error";
      store.updateCustody(connection.id, attemptId, { state: "lost", detail: `claim refused: ${code}` });
      throw new VercelBoardClaimError("claim_refused", `The board refused the claim on ${input.taskId}: ${code}.`, error instanceof VercelBoardHttpError && error.status < 500 ? 409 : 502);
    }
    store.updateCustody(connection.id, attemptId, { epoch: grant.claim.epoch, token: grant.claim.token, until: grant.claim.until, state: "held" });
    // The Scout side is granted only after the Board claim lands.
    try {
      const { flightId } = await this.deps.dispatch({ ...input, task: grant.task, attemptId });
      store.updateCustody(connection.id, attemptId, { flightId });
    } catch (error) {
      await this.settle(store.custody(connection.id, attemptId)!, "released").catch(() => undefined);
      throw new VercelBoardClaimError("dispatch_failed", `Board claim landed, but the dispatch to ${input.agentId} failed; the claim was released. ${error instanceof Error ? error.message : ""}`.trim(), 502);
    }
    return store.custody(connection.id, attemptId)!;
  }

  /** One pass over active custody: renew, settle finished work, and expire unknown claims. */
  async tick(): Promise<void> {
    const { connection, store } = this.deps;
    for (const row of store.activeCustody(connection.id)) {
      if (this.inFlight.has(row.attemptId)) continue;
      try { await this.tickRow(row); }
      catch (error) {
        // A rate limit or an outage holds this row; the next tick tries again.
        if (!(error instanceof VercelBoardHttpError) && !(error instanceof VercelBoardUnknownOutcomeError)) throw error;
      }
    }
  }

  private async tickRow(row: VercelBoardCustodyRow): Promise<void> {
    const now = this.now();
    const { connection, store } = this.deps;
    if (row.state === "claim_unknown" || row.state === "claiming") {
      // A `claiming` row here means the runtime stopped mid-claim: the same unknown outcome.
      if (now >= row.createdAt + row.leaseSeconds * 1000) store.updateCustody(connection.id, row.attemptId, { state: "lost", detail: "unanswered claim lapsed" });
      else if (row.state === "claiming") store.updateCustody(connection.id, row.attemptId, { state: "claim_unknown" });
      return;
    }
    if (row.state === "settling") return this.resumeSettle(row);
    // held
    if (row.until !== null && now >= row.until) return this.lost(row, "lease expired");
    const flight = row.flightId ? this.deps.flight(row.flightId) : undefined;
    if (flight && terminal(flight.state)) {
      if (flight.state === "completed") return this.settle(row, "completed", flight.output ?? flight.summary ?? "Done.");
      return this.settle(row, "failed", flight.error ?? flight.summary ?? `The Scout agent ${flight.state === "cancelled" ? "was cancelled" : "failed"}.`);
    }
    // Renew only while the Scout flight is alive. A dead agent stops renewals, and Board hands the task on.
    if (!flight) return;
    const elapsed = row.until === null ? 0 : row.leaseSeconds * 1000 - (row.until - now);
    if (elapsed < (row.leaseSeconds * 1000) / 3) return;
    try {
      const renewed = await this.deps.transport.renew(row.taskId, { epoch: row.epoch!, token: row.token! }, this.lease);
      store.updateCustody(connection.id, row.attemptId, { until: renewed.until, leaseSeconds: this.lease });
    } catch (error) {
      if (error instanceof VercelBoardHttpError && (error.code === "claim_lost" || error.code === "task_finished")) return this.lost(row, error.code);
      throw error;
    }
  }

  /**
   * The follower saw the task. If the task moved on while Scout holds it
   * (another epoch, an edited root, a delete, an expiry), the claim is lost.
   */
  async observe(message: VercelBoardWireMessage): Promise<void> {
    const task = message.task;
    if (!task) return;
    const row = this.deps.store.activeCustody(this.deps.connection.id).find(entry => entry.taskId === message.id && entry.state === "held");
    if (!row) return;
    if (task.epoch === row.epoch && task.state === "claimed") return;
    const cause = task.state === "blocked" && task.blocked?.kind === "edited" ? "root edited by someone else"
      : task.state === "canceled" ? `canceled${task.reason ? `: ${task.reason}` : ""}`
      : task.epoch !== row.epoch ? `claimed by ${task.claim ? vercelBoardPrincipalOf(task.claim.actor) : "another worker"}`
      : `task is ${task.state}`;
    // A settle in flight can race the feed. The settle resolves itself.
    if (task.epoch === row.epoch && (task.state === "completed" || task.state === "failed")) return;
    await this.lost(row, cause);
  }

  private async lost(row: VercelBoardCustodyRow, cause: string): Promise<void> {
    const { connection, store } = this.deps;
    store.updateCustody(connection.id, row.attemptId, { state: "lost", detail: cause });
    // Cancel the Scout side. Do not write to the thread as the holder.
    if (row.flightId && this.deps.cancelFlight) {
      const flight = this.deps.flight(row.flightId);
      if (flight && !terminal(flight.state)) await this.deps.cancelFlight(row.flightId, `The Board task moved on: ${cause}.`).catch(() => undefined);
    }
    await this.deps.notify?.({ kind: "lost", row: store.custody(connection.id, row.attemptId)!, cause });
  }

  private async settle(row: VercelBoardCustodyRow, outcome: VercelBoardSettleOutcome, result?: string): Promise<void> {
    const { connection, store } = this.deps;
    // Store the result before sending: a lost answer or a restart resumes from here.
    store.updateCustody(connection.id, row.attemptId, { state: "settling", outcome, result: result ?? null });
    return this.resumeSettle(store.custody(connection.id, row.attemptId)!);
  }

  private async resumeSettle(row: VercelBoardCustodyRow): Promise<void> {
    const { connection, store, transport } = this.deps;
    const outcome = row.outcome ?? "released";
    const grant = { epoch: row.epoch!, token: row.token! };
    try {
      if (outcome === "completed") await transport.complete(row.taskId, grant, row.result ?? undefined);
      else if (outcome === "failed") await transport.fail(row.taskId, grant, row.result ?? "failed");
      else await transport.release(row.taskId, grant);
    } catch (error) {
      if (error instanceof VercelBoardUnknownOutcomeError) return; // the next tick asks again; epoch and token fence a repeat
      if (!(error instanceof VercelBoardHttpError) || !["claim_lost", "task_finished"].includes(error.code)) throw error;
      return this.resolveAmbiguousSettle(row, outcome);
    }
    store.updateCustody(connection.id, row.attemptId, { state: "settled" });
    await this.deps.notify?.({ kind: "settled", row: store.custody(connection.id, row.attemptId)!, outcome });
  }

  /**
   * A repeated settle answers `claim_lost` whether or not the first one
   * landed. Read the task: the settled state at Scout's epoch means it did.
   */
  private async resolveAmbiguousSettle(row: VercelBoardCustodyRow, outcome: VercelBoardSettleOutcome): Promise<void> {
    const { connection, store, transport } = this.deps;
    const current = await transport.message(row.taskId);
    const task = current?.task;
    if (task && task.epoch === row.epoch && task.state === SETTLED_STATE[outcome]) {
      store.updateCustody(connection.id, row.attemptId, { state: "settled" });
      await this.deps.notify?.({ kind: "settled", row: store.custody(connection.id, row.attemptId)!, outcome });
      return;
    }
    if (outcome === "released") {
      store.updateCustody(connection.id, row.attemptId, { state: "settled", detail: "released or lapsed" });
      return;
    }
    // Nobody claimed it since: claim again and settle with the stored result.
    if (task && task.state === "ready" && task.epoch === row.epoch) {
      try {
        const grant = await transport.claim(row.taskId, this.firstLease);
        if (outcome === "completed") await transport.complete(row.taskId, grant.claim, row.result ?? undefined);
        else await transport.fail(row.taskId, grant.claim, row.result ?? "failed");
        store.updateCustody(connection.id, row.attemptId, { state: "settled", epoch: grant.claim.epoch, token: grant.claim.token, until: grant.claim.until });
        await this.deps.notify?.({ kind: "settled", row: store.custody(connection.id, row.attemptId)!, outcome });
        return;
      } catch (error) {
        if (error instanceof VercelBoardUnknownOutcomeError) {
          store.updateCustody(connection.id, row.attemptId, { state: "lost", detail: "finished here; the second claim got no answer" });
          await this.deps.notify?.({ kind: "finished_claim_lost", row: store.custody(connection.id, row.attemptId)!, result: row.result ?? "" });
          return;
        }
        if (!(error instanceof VercelBoardHttpError)) throw error;
      }
    }
    store.updateCustody(connection.id, row.attemptId, { state: "lost", detail: "finished here, claim lost" });
    await this.deps.notify?.({ kind: "finished_claim_lost", row: store.custody(connection.id, row.attemptId)!, result: row.result ?? "" });
  }
}
