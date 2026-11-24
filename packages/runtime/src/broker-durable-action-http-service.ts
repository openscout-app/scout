import type {
  DurableAction,
  DurableActionHeartbeatInput,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { isManualReviewAction } from "./manual-review-occurrences.js";

export type DurableActionHeartbeatBody = {
  owner: string;
  generation: number;
  leaseMs: number;
  heartbeatAt?: number;
};

export type BrokerDurableActionHttpResult = {
  status: number;
  body: unknown;
};

export type BrokerDurableActionHttpServiceDeps = {
  runDurableWrite: <T>(work: () => Promise<T>) => Promise<T>;
  commitEntries: (
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ) => Promise<BrokerJournalEntry[]>;
  heartbeatDurableAction: (input: DurableActionHeartbeatInput) => Promise<DurableAction | null>;
  getDurableAction: (actionId: string) => DurableAction | null | undefined;
  now?: () => number;
};

export class BrokerDurableActionHttpService {
  constructor(private readonly deps: BrokerDurableActionHttpServiceDeps) {}

  readonly recordAction = async (
    action: DurableAction,
  ): Promise<{ ok: true; actionId: string }> => {
    if (!action.id?.trim()) {
      throw new Error("action.id is required");
    }
    await this.deps.runDurableWrite(async () => {
      // This write replaces the record under the ID. A manual review occurrence
      // and a saved review routine are written by their own services, and never
      // replaced from here.
      if (isManualReviewAction(action) || isManualReviewAction(this.deps.getDurableAction(action.id))) {
        throw new Error("manual review records are written through the manual review entry points");
      }
      await this.deps.commitEntries(
        { kind: "durable.action.record", action },
        async () => {},
      );
    });
    return { ok: true, actionId: action.id };
  };

  readonly heartbeat = async (
    actionIdInput: string,
    body: DurableActionHeartbeatBody,
  ): Promise<BrokerDurableActionHttpResult> => {
    const actionId = actionIdInput.trim();
    if (!actionId || !body.owner?.trim()) {
      throw new Error("actionId and owner are required.");
    }
    if (!Number.isFinite(body.generation) || body.generation < 0) {
      throw new Error("generation must be a non-negative number.");
    }
    if (!Number.isFinite(body.leaseMs) || body.leaseMs <= 0) {
      throw new Error("leaseMs must be a positive number.");
    }
    const heartbeatAt = Number.isFinite(body.heartbeatAt)
      ? body.heartbeatAt!
      : this.deps.now?.() ?? Date.now();
    const heartbeat = await this.deps.heartbeatDurableAction({
      actionId,
      owner: body.owner.trim(),
      generation: body.generation,
      leaseMs: body.leaseMs,
      heartbeatAt,
    });
    if (!heartbeat) {
      const current = this.deps.getDurableAction(actionId);
      if (!current) {
        return {
          status: 404,
          body: {
            error: "not_found",
            detail: "durable action not found",
          },
        };
      }
      return {
        status: 409,
        body: {
          error: "conflict",
          detail: "durable action lease is stale, terminal, or owned by another worker",
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        actionId,
        leaseOwner: heartbeat.leaseOwner,
        leaseGeneration: heartbeat.leaseGeneration,
        leaseExpiresAt: heartbeat.leaseExpiresAt,
      },
    };
  };
}
