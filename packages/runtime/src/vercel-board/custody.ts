import { randomUUID } from "node:crypto";
import type { VercelBoardConnectionConfig, FlightRecord } from "@openscout/protocol";
import { flightWaitingOn } from "@openscout/protocol";
import { VercelBoardHttpError, VercelBoardUnknownOutcomeError, type VercelBoardBlockKind, type VercelBoardTransport } from "./client.js";
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
  /** The flight waits on a person: the task is held on the board and the claim has ended. */
  | { kind: "blocked"; row: VercelBoardCustodyRow; reason: string }
  /** The flight moved again: Scout unblocked the task and claimed it as the same role, in `row`. */
  | { kind: "resumed"; row: VercelBoardCustodyRow; from: VercelBoardCustodyRow }
  /** The agent finished, but the claim was gone and the task moved on. The result stays in Scout. */
  | { kind: "finished_claim_lost"; row: VercelBoardCustodyRow; result: string };

type ClaimInput = {
  taskId: string; workId: string; agentId: string; startedBy: string;
  /** The role profile to claim as. Absent means the connection's own profile. */
  profile?: string;
  /** The dispatch policy that chose this claim, when the runtime did. */
  policy?: string;
  dependencyContext?: { channel: string; owner: string; needs: string[]; lines: string[] };
};

export interface VercelBoardCustodyDeps {
  connection: Pick<VercelBoardConnectionConfig, "id" | "principal" | "profile">;
  transport: VercelBoardTransport;
  store: VercelBoardStore;
  /** Grant the Scout side: deliver the task to the agent, attached to the projected work item. */
  dispatch(input: ClaimInput & { task: VercelBoardWireMessage; attemptId: string }): Promise<{ flightId: string }>;
  flight(flightId: string): Pick<FlightRecord, "state" | "output" | "error" | "summary" | "metadata"> | undefined;
  cancelFlight?(flightId: string, reason: string): Promise<void>;
  notify?(notice: VercelBoardCustodyNotice): Promise<void> | void;
  now?: () => number;
  leaseSeconds?: number;
  firstLeaseSeconds?: number;
}

const terminal = (state: FlightRecord["state"] | undefined) => state === "completed" || state === "failed" || state === "cancelled";
const SETTLED_STATE: Record<VercelBoardSettleOutcome, string> = { completed: "completed", failed: "failed", released: "ready" };
type CustodyFlight = Pick<FlightRecord, "state" | "output" | "error" | "summary" | "metadata">;

/** What a person is asked for, in Board's words: an answer, or an approval. */
function blockOf(flight: CustodyFlight): { reason: string; kind: VercelBoardBlockKind } {
  const waiting = flightWaitingOn(flight as FlightRecord);
  const reason = (waiting?.summary ?? flight.summary ?? "Waiting on the operator.").trim() || "Waiting on the operator.";
  return { reason, kind: waiting?.kind === "question" ? "needs_input" : "awaiting_approval" };
}

/**
 * Whether the runtime published the harness's final output as the agent's
 * reply. Harnesses that return their answer (a Codex app server, ACP) are told
 * that their final response is the reply and cannot run `reply --ref`; the
 * runtime posts that output as a result reply, which is their verb. A
 * superseded result reply was refused, so it is not one.
 */
function repliedByFinalResponse(flight: CustodyFlight): boolean {
  const intent = flight.metadata?.resultReply as { status?: unknown } | undefined;
  return !!intent && typeof intent === "object" && (intent.status === "pending" || intent.status === "delivered");
}

/**
 * How a finished flight settles its task. Only a verb ends it: a final
 * `reply --ref`, or a final response the runtime published as the reply,
 * completes; a failed reply fails. A harness failure fails. A turn that ends
 * without a verb, or a cancel, releases the task; its text stays in Scout and
 * never reads as the task's result.
 */
export function settlementOf(flight: CustodyFlight): { outcome: VercelBoardSettleOutcome; result?: string; detail?: string } {
  const replied = flight.metadata?.completedByBrokerReply === true || repliedByFinalResponse(flight);
  if (flight.state === "completed" && replied) return { outcome: "completed", result: flight.output ?? flight.summary ?? "Done." };
  if (flight.state === "failed") return { outcome: "failed", result: flight.error ?? flight.output ?? flight.summary ?? "The Scout agent failed." };
  if (flight.state === "cancelled") return { outcome: "released", detail: "the Scout flight was cancelled" };
  return { outcome: "released", result: flight.output ?? undefined, detail: "the agent ended its turn without a verb" };
}

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
      leaseSeconds: this.firstLease, agentId: input.agentId, workId: input.workId, startedBy: input.startedBy, profile: input.profile ?? connection.profile, flightId: null,
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
      grant = await transport.as(input.profile ?? connection.profile).claim(input.taskId, this.firstLease);
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
    if (row.state === "blocked") return this.tickBlocked(row);
    // held
    const flight = row.flightId ? this.deps.flight(row.flightId) : undefined;
    // A finished flight settles even when the lease lapsed while this host was
    // away: the settle fails with claim_lost, and resolveAmbiguousSettle claims
    // again and completes with the result when nobody took the task since.
    if (flight && terminal(flight.state)) return this.settleFinished(row, flight);
    if (row.until !== null && now >= row.until) return this.lost(row, "lease expired");
    // A flight that waits on a person holds the task on the board instead of renewing a claim nobody works.
    if (flight?.state === "waiting") return this.block(row, flight);
    // Renew only while the Scout flight is alive. A dead agent stops renewals, and Board hands the task on.
    if (!flight) return;
    const elapsed = row.until === null ? 0 : row.leaseSeconds * 1000 - (row.until - now);
    if (elapsed < (row.leaseSeconds * 1000) / 3) return;
    try {
      const renewed = await this.as(row).renew(row.taskId, { epoch: row.epoch!, token: row.token! }, this.lease);
      store.updateCustody(connection.id, row.attemptId, { until: renewed.until, leaseSeconds: this.lease });
    } catch (error) {
      if (error instanceof VercelBoardHttpError && (error.code === "claim_lost" || error.code === "task_finished")) return this.lost(row, error.code);
      throw error;
    }
  }

  /** The transport for a row's claim: the profile it was claimed as. */
  private as(row: VercelBoardCustodyRow): VercelBoardTransport {
    return this.deps.transport.as(row.profile ?? this.deps.connection.profile);
  }

  private settleFinished(row: VercelBoardCustodyRow, flight: CustodyFlight): Promise<void> {
    const { outcome, result, detail } = settlementOf(flight);
    if (detail) this.deps.store.updateCustody(this.deps.connection.id, row.attemptId, { detail });
    return this.settle(row, outcome, result);
  }

  /** Hold the task for a person. Board ends the claim; Scout keeps the row until the flight moves. */
  private async block(row: VercelBoardCustodyRow, flight: CustodyFlight): Promise<void> {
    const { connection, store } = this.deps;
    const { reason, kind } = blockOf(flight);
    try {
      await this.as(row).block(row.taskId, { epoch: row.epoch!, token: row.token! }, reason, kind);
    } catch (error) {
      if (error instanceof VercelBoardHttpError && (error.code === "claim_lost" || error.code === "task_finished")) return this.lost(row, error.code);
      throw error;
    }
    store.updateCustody(connection.id, row.attemptId, { state: "blocked", outcome: "blocked", token: null, until: null, detail: `${kind}: ${reason}`.slice(0, 1000) });
    await this.deps.notify?.({ kind: "blocked", row: store.custody(connection.id, row.attemptId)!, reason });
  }

  private async tickBlocked(row: VercelBoardCustodyRow): Promise<void> {
    const flight = row.flightId ? this.deps.flight(row.flightId) : undefined;
    if (!flight || flight.state === "waiting" || flight.state === "queued" || flight.state === "waking") return;
    if (flight.state === "cancelled") {
      this.deps.store.updateCustody(this.deps.connection.id, row.attemptId, { state: "settled", detail: "the Scout flight was cancelled while the task was held" });
      return;
    }
    const next = await this.resume(row);
    if (next && terminal(flight.state)) await this.settleFinished(next, flight);
  }

  /**
   * The flight moved again. Lift the hold as the principal (the task's owner),
   * then claim as the same role in a new row: a row per claim, one flight
   * across them. A claim with no answer is never sent again.
   */
  private async resume(row: VercelBoardCustodyRow): Promise<VercelBoardCustodyRow | null> {
    const { connection, store, transport } = this.deps;
    try { await transport.as(null).unblock(row.taskId); }
    catch (error) {
      // Someone lifted it already, or it moved on: the claim answers which.
      if (!(error instanceof VercelBoardHttpError) || error.status >= 500) throw error;
    }
    const attemptId = randomUUID();
    store.insertCustody({ connectionId: connection.id, taskId: row.taskId, attemptId, epoch: null, token: null, until: null,
      leaseSeconds: this.firstLease, agentId: row.agentId, workId: row.workId, startedBy: row.startedBy, profile: row.profile, flightId: row.flightId,
      state: "claiming", outcome: null, result: null, detail: `resumed from ${row.attemptId}` });
    store.updateCustody(connection.id, row.attemptId, { state: "settled" });
    try {
      const grant = await this.as(row).claim(row.taskId, this.firstLease);
      store.updateCustody(connection.id, attemptId, { epoch: grant.claim.epoch, token: grant.claim.token, until: grant.claim.until, state: "held" });
    } catch (error) {
      if (error instanceof VercelBoardUnknownOutcomeError) {
        store.updateCustody(connection.id, attemptId, { state: "claim_unknown", detail: "The claim after the hold got no answer. Not retried: the lease lapses." });
        return null;
      }
      const code = error instanceof VercelBoardHttpError ? error.code : "error";
      store.updateCustody(connection.id, attemptId, { state: "lost", detail: `claim after the hold refused: ${code}` });
      await this.lostFlight(store.custody(connection.id, attemptId)!, `claim after the hold refused: ${code}`);
      return null;
    }
    const next = store.custody(connection.id, attemptId)!;
    await this.deps.notify?.({ kind: "resumed", row: next, from: store.custody(connection.id, row.attemptId)! });
    return next;
  }

  /**
   * The follower saw the task. If the task moved on while Scout holds it
   * (another epoch, an edited root, a delete, an expiry), the claim is lost.
   */
  async observe(message: VercelBoardWireMessage): Promise<void> {
    const task = message.task;
    if (!task) return;
    const active = this.deps.store.activeCustody(this.deps.connection.id);
    const blocked = active.find(entry => entry.taskId === message.id && entry.state === "blocked");
    if (blocked) {
      // Held for a person: only a cancel or someone else's claim ends Scout's part. A lifted hold waits for the flight.
      if (task.state === "canceled") await this.lostBlocked(blocked, `canceled${task.reason ? `: ${task.reason}` : ""}`);
      else if (task.state === "claimed" && task.epoch !== blocked.epoch) await this.lostBlocked(blocked, `claimed by ${task.claim ? vercelBoardPrincipalOf(task.claim.actor) : "another worker"}`);
      return;
    }
    const row = active.find(entry => entry.taskId === message.id && entry.state === "held");
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

  private async lostBlocked(row: VercelBoardCustodyRow, cause: string): Promise<void> {
    this.deps.store.updateCustody(this.deps.connection.id, row.attemptId, { state: "lost", detail: cause });
    await this.lostFlight(this.deps.store.custody(this.deps.connection.id, row.attemptId)!, cause);
  }

  private async lost(row: VercelBoardCustodyRow, cause: string): Promise<void> {
    const { connection, store } = this.deps;
    store.updateCustody(connection.id, row.attemptId, { state: "lost", detail: cause });
    await this.lostFlight(store.custody(connection.id, row.attemptId)!, cause);
  }

  private async lostFlight(row: VercelBoardCustodyRow, cause: string): Promise<void> {
    const { connection, store } = this.deps;
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
    // A settling row never carries `blocked`: that row ends in a new one.
    const outcome: VercelBoardSettleOutcome = !row.outcome || row.outcome === "blocked" ? "released" : row.outcome;
    const grant = { epoch: row.epoch!, token: row.token! };
    const as = this.as(row);
    try {
      if (outcome === "completed") await as.complete(row.taskId, grant, row.result ?? undefined);
      else if (outcome === "failed") await as.fail(row.taskId, grant, row.result ?? "failed");
      else await as.release(row.taskId, grant);
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
        const as = this.as(row);
        const grant = await as.claim(row.taskId, this.firstLease);
        if (outcome === "completed") await as.complete(row.taskId, grant.claim, row.result ?? undefined);
        else await as.fail(row.taskId, grant.claim, row.result ?? "failed");
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
