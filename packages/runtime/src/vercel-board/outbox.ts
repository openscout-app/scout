import type { VercelBoardConnectionConfig, VercelBoardPlanTask } from "@openscout/protocol";
import { VercelBoardHttpError, VercelBoardUnknownOutcomeError, type VercelBoardTransport } from "./client.js";
import { vercelBoardScopedId } from "./projection.js";
import type { VercelBoardOutboxRow, VercelBoardStore } from "./store.js";
import type { VercelBoardWireMessage } from "./wire.js";

export type VercelBoardPostRequest = { channel?: string; re?: string; text: string; labels?: Record<string, string> };
export type VercelBoardPlanBatchRequest = { channel: string; tasks: VercelBoardPlanTask[] };

/** A Board client `id` from a Scout ID: the same Scout write always carries the same `id`. */
export const vercelBoardClientId = (connectionId: string, scoutId: string): string => vercelBoardScopedId("scout", connectionId, scoutId);

export class VercelBoardOutboxError extends Error {
  constructor(readonly code: "outcome_unknown" | "refused" | "rate_limited", message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "VercelBoardOutboxError";
  }
}

/**
 * Outbound writes: one serial lane per thread (or per plan channel). A write
 * whose answer was lost is read back by its client `id` before it is sent
 * again, so a resend never makes a second post.
 */
export class VercelBoardOutbox {
  private readonly lanes = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: { connection: Pick<VercelBoardConnectionConfig, "id">; transport: VercelBoardTransport; store: VercelBoardStore }) {}

  /** Queue a post and send its lane up to and including it. */
  async post(input: { scoutId: string; lane: string; request: VercelBoardPostRequest }): Promise<VercelBoardWireMessage> {
    const clientId = vercelBoardClientId(this.deps.connection.id, input.scoutId);
    this.deps.store.enqueue({ connectionId: this.deps.connection.id, clientId, lane: input.lane, kind: "post", request: input.request });
    return this.waitFor<VercelBoardWireMessage>(input.lane, clientId);
  }

  /** Queue a plan (one task batch) and send it. */
  async plan(input: { scoutId: string; lane: string; request: VercelBoardPlanBatchRequest }): Promise<VercelBoardWireMessage[]> {
    const clientId = vercelBoardClientId(this.deps.connection.id, input.scoutId);
    this.deps.store.enqueue({ connectionId: this.deps.connection.id, clientId, lane: input.lane, kind: "plan", request: input.request });
    return this.waitFor<VercelBoardWireMessage[]>(input.lane, clientId);
  }

  /** Send every lane with work queued. Used on start and on a timer. */
  async drainAll(): Promise<void> {
    for (const lane of this.deps.store.pendingLanes(this.deps.connection.id)) {
      await this.serial(lane, () => this.drain(lane)).catch(() => undefined);
    }
  }

  private async waitFor<T>(lane: string, clientId: string): Promise<T> {
    await this.serial(lane, () => this.drain(lane, clientId));
    const row = this.deps.store.outboxRow(this.deps.connection.id, clientId)!;
    if (row.state === "done") return row.response as T;
    if (row.state === "failed") throw new VercelBoardOutboxError("refused", row.error ?? "The board refused the write.");
    throw new VercelBoardOutboxError("outcome_unknown", "The write was sent and no answer came back. It stays queued and is checked by its id before any resend.");
  }

  private serial<T>(lane: string, work: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.lanes.set(lane, next.finally(() => { if (this.lanes.get(lane) === next) this.lanes.delete(lane); }).catch(() => undefined));
    return next;
  }

  /** Send the lane in order. Stop at a write whose outcome is unknown, or once `until` is settled. */
  private async drain(lane: string, until?: string): Promise<void> {
    const { connection, store } = this.deps;
    for (let guard = 0; guard < 1000; guard++) {
      const head = store.laneHead(connection.id, lane);
      if (!head) return;
      const settled = await this.send(head);
      if (!settled) return;
      if (head.clientId === until) return;
    }
  }

  /** Returns true when the row reached `done` or `failed`. */
  private async send(row: VercelBoardOutboxRow): Promise<boolean> {
    const { connection, store, transport } = this.deps;
    // A write that may have landed is read back by its id first.
    if (row.attempts > 0 || row.state === "unknown") {
      const landed = row.kind === "post" ? await transport.postById(row.clientId) : await transport.batch(row.clientId);
      if (landed) {
        store.markOutbox(connection.id, row.clientId, { state: "done", response: landed });
        return true;
      }
    }
    store.markOutbox(connection.id, row.clientId, { state: row.state, attempt: true });
    try {
      const response = row.kind === "post"
        ? await transport.post({ ...(row.request as VercelBoardPostRequest), id: row.clientId })
        : await transport.createBatch({ ...(row.request as VercelBoardPlanBatchRequest), id: row.clientId });
      store.markOutbox(connection.id, row.clientId, { state: "done", response });
      return true;
    } catch (error) {
      if (error instanceof VercelBoardUnknownOutcomeError) {
        store.markOutbox(connection.id, row.clientId, { state: "unknown", error: "no answer" });
        return false;
      }
      if (error instanceof VercelBoardHttpError) {
        if (error.code === "duplicate_id") {
          const landed = row.kind === "post" ? await transport.postById(row.clientId) : await transport.batch(row.clientId);
          if (landed) { store.markOutbox(connection.id, row.clientId, { state: "done", response: landed }); return true; }
        }
        if (error.status === 429) {
          store.markOutbox(connection.id, row.clientId, { state: row.state, error: "rate_limited" });
          throw new VercelBoardOutboxError("rate_limited", "The board is rate limiting this credential.", error.retryAfterMs);
        }
        if (error.status >= 500 || error.status === 401) {
          store.markOutbox(connection.id, row.clientId, { state: row.state, error: error.code });
          return false;
        }
        store.markOutbox(connection.id, row.clientId, { state: "failed", error: `${error.code}: ${error.message}` });
        return true;
      }
      throw error;
    }
  }
}
