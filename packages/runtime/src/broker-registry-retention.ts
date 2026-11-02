import type { AgentEndpoint } from "@openscout/protocol";

import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";
import type { RegistryDeleteResult } from "./broker-durable-record-store.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

/**
 * Registry retention: a rotation-old, offline, unreferenced registration is
 * stale — regardless of how it was registered. Relay-registry sessions,
 * cardless sessions, isolated sessions and scout-channel endpoints all age
 * out on the same rule; age, state and references gate eligibility, never
 * provenance. Manifest-registered agents that are still real get re-registered
 * by the local-agents sync — that churn is deliberate and cheaper than keeping
 * tens of thousands of dead rows in every snapshot.
 */
export const DEFAULT_REGISTRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type RegistryRetentionPlan = {
  endpointIds: string[];
  agentIds: string[];
  actorIds: string[];
};

export type RegistryRetentionDeleteHooks = {
  deleteEndpoint: (endpointId: string) => Promise<RegistryDeleteResult | void>;
  deleteAgent: (agentId: string) => Promise<RegistryDeleteResult | void>;
  deleteActor: (actorId: string) => Promise<RegistryDeleteResult | void>;
};

export type RegistryRetentionApplyResult = {
  endpoints: number;
  agents: number;
  actors: number;
  /** Deletes declined by a write-time eligibility veto, per category. */
  skipped: { endpoints: number; agents: number; actors: number };
  failures: number;
};

/** Endpoint states that count as still-live plumbing for an agent. */
const LIVE_ENDPOINT_STATES = new Set(["idle", "active", "waiting"]);

/** Metadata timestamp keys treated as last-activity evidence, in one place so
 * endpoints, agents and nodes share the same notion of "touched at". */
const ACTIVITY_METADATA_KEYS = [
  "retiredAt",
  "lastFailedAt",
  "lastSeenAt",
  "lastActivityAt",
  "updatedAt",
  "registeredAt",
  // The cardless-session reaper's evidence keys.
  "startedAt",
  "lastCompletedAt",
] as const;

function metadataTimestamp(record: { metadata?: Record<string, unknown> }, key: string): number {
  const raw = record.metadata?.[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Latest activity timestamp across the shared metadata keys; 0 = unknown age. */
function lastRegistryActivity(record: { metadata?: Record<string, unknown> }): number {
  let latest = 0;
  for (const key of ACTIVITY_METADATA_KEYS) {
    latest = Math.max(latest, metadataTimestamp(record, key));
  }
  return latest;
}

function nodeLastSeen(node: { lastSeenAt?: number; registeredAt?: number }): number {
  return node.lastSeenAt ?? node.registeredAt ?? 0;
}

export function registryRetentionPlan(
  snapshot: RuntimeRegistrySnapshot,
  input: {
    nodeId: string;
    now?: number;
    /**
     * Explicit boundary from the day clock (see retention-clock.ts). When
     * absent, a rolling `now − retentionMs` cutoff is derived for tests.
     */
    cutoff?: number;
    retentionMs?: number;
    /**
     * First-registration times from the durable store (`actors.created_at`).
     * The snapshot's `createdAt` covers actors stamped at upsert time; this
     * map covers rows journaled before the stamp existed.
     */
    actorCreatedAtById?: ReadonlyMap<string, number>;
  },
): RegistryRetentionPlan {
  const now = input.now ?? Date.now();
  const retentionMs = Math.max(60 * 60_000, input.retentionMs ?? DEFAULT_REGISTRY_RETENTION_MS);
  const cutoff = input.cutoff ?? now - retentionMs;
  const actorCreatedAt = (actorId: string): number =>
    snapshot.actors[actorId]?.createdAt ?? input.actorCreatedAtById?.get(actorId) ?? 0;

  // Node set: our own nodeId plus every nodeId that is NOT a live remote peer.
  // A live peer re-advertises its own records, so its registrations are never
  // ours to reap; a dead peer's records are as stale as ours — and this
  // machine's own historical nodeIds (hostname drift) are indistinguishable
  // from dead peers, which is exactly where the backlog lives.
  const livePeerIds = new Set<string>();
  for (const node of Object.values(snapshot.nodes)) {
    if (node.id === input.nodeId) continue;
    if (nodeLastSeen(node) > cutoff) livePeerIds.add(node.id);
  }
  const inNodeSet = (recordNodeId: string | undefined | null): boolean =>
    recordNodeId === input.nodeId || !recordNodeId || !livePeerIds.has(recordNodeId);
  const inNodeSetRequired = (recordNodeId: string): boolean =>
    recordNodeId === input.nodeId || !livePeerIds.has(recordNodeId);

  const endpointCandidateIds = new Set<string>();
  const endpointLastActivity = new Map<string, number>();
  const endpointIdsByAgentId = new Map<string, string[]>();
  for (const endpoint of Object.values(snapshot.endpoints)) {
    const list = endpointIdsByAgentId.get(endpoint.agentId) ?? [];
    list.push(endpoint.id);
    endpointIdsByAgentId.set(endpoint.agentId, list);

    if (!inNodeSetRequired(endpoint.nodeId)) continue;
    if (endpoint.state !== "offline" && endpoint.state !== "stopped") continue;
    const lastActivity = lastRegistryActivity(endpoint);
    // Unknown age is kept: a record with no timestamp at all never expires.
    if (lastActivity <= 0 || lastActivity > cutoff) continue;
    endpointCandidateIds.add(endpoint.id);
    endpointLastActivity.set(endpoint.id, lastActivity);
  }

  const terminalFlightByInvocationId = new Map<string, boolean>();
  for (const flight of Object.values(snapshot.flights)) {
    terminalFlightByInvocationId.set(
      flight.invocationId,
      isTerminalFlightState(flight.state)
        && (terminalFlightByInvocationId.get(flight.invocationId) ?? true),
    );
  }

  // Conversation membership is deliberately NOT a veto: channels auto-enrol
  // every agent, so a roster slot is not evidence of life. Member rows
  // cascade-delete with the actor and rosters are recomputed from
  // conversation_members, so a dead agent vanishes from channel rosters —
  // the desired outcome.
  const agentIds: string[] = [];
  const agentCandidateIds = new Set<string>();
  for (const agent of Object.values(snapshot.agents)) {
    const endpoints = (endpointIdsByAgentId.get(agent.id) ?? [])
      .map((id) => snapshot.endpoints[id])
      .filter((endpoint): endpoint is AgentEndpoint => endpoint !== undefined);

    // Any endpoint still in a live state keeps the agent, whatever node it is
    // on; then every remaining endpoint must itself be a delete candidate.
    if (endpoints.some((endpoint) => LIVE_ENDPOINT_STATES.has(endpoint.state))) continue;
    if (endpoints.some((endpoint) => !endpointCandidateIds.has(endpoint.id))) continue;

    // Not the target of in-flight work: a non-terminal flight, or an
    // invocation that never produced a terminal flight.
    if (Object.values(snapshot.flights).some(
      (flight) => flight.targetAgentId === agent.id && !isTerminalFlightState(flight.state),
    )) continue;
    if (Object.values(snapshot.invocations).some((invocation) => {
      if (invocation.targetAgentId !== agent.id) return false;
      return terminalFlightByInvocationId.get(invocation.id) !== true;
    })) continue;

    // Age gate: the newest evidence across the agent's own metadata, its
    // endpoints' activity, and — last resort — the actor's first-registration
    // stamp (a registration with no later evidence has been idle since it was
    // registered). A record with no timestamp anywhere is kept.
    let lastActivity = Math.max(lastRegistryActivity(agent), actorCreatedAt(agent.id));
    for (const endpoint of endpoints) {
      lastActivity = Math.max(
        lastActivity,
        endpointLastActivity.get(endpoint.id) ?? lastRegistryActivity(endpoint),
      );
    }
    if (lastActivity <= 0 || lastActivity > cutoff) continue;

    // homeNodeId/authorityNodeId on a live peer means the record belongs to
    // another node — never ours to delete.
    if (!inNodeSet(agent.homeNodeId) || !inNodeSet(agent.authorityNodeId)) continue;

    agentIds.push(agent.id);
    agentCandidateIds.add(agent.id);
  }

  // Referenced actors keep their rows — they are the display names behind
  // history. These are the same identities the RESTRICT foreign keys protect;
  // the store-level reference count re-checks them authoritatively at delete
  // time (journal/snapshot drift is possible between plan and write).
  const referencedActorIds = new Set<string>();
  for (const message of Object.values(snapshot.messages)) {
    referencedActorIds.add(message.actorId);
  }
  for (const invocation of Object.values(snapshot.invocations)) {
    referencedActorIds.add(invocation.requesterId);
    referencedActorIds.add(invocation.targetAgentId);
  }
  for (const flight of Object.values(snapshot.flights)) {
    referencedActorIds.add(flight.requesterId);
    referencedActorIds.add(flight.targetAgentId);
  }
  for (const record of Object.values(snapshot.collaborationRecords)) {
    // Ownership counts for every record, terminal or not — the actor is the
    // display identity behind history, and SQLite's SET NULL would otherwise
    // silently erase the owner of an open work item.
    referencedActorIds.add(record.createdById);
    if (record.ownerId) referencedActorIds.add(record.ownerId);
    if (record.nextMoveOwnerId) referencedActorIds.add(record.nextMoveOwnerId);
  }
  // ownerId is a plain column (no FK) but is still a live reference.
  for (const agent of Object.values(snapshot.agents)) {
    if (!agentCandidateIds.has(agent.id) && agent.ownerId) {
      referencedActorIds.add(agent.ownerId);
    }
  }

  const actorIds: string[] = [];
  for (const actor of Object.values(snapshot.actors)) {
    if (actor.kind !== "agent" && actor.kind !== "session") continue;
    // The actor leaves with its agent row — or was never backed by one
    // (cardless sessions register actor+endpoint, no agent). A surviving
    // agents row means the identity still exists.
    const agent = snapshot.agents[actor.id];
    if (agent && !agentCandidateIds.has(agent.id)) continue;
    // Cardless actors carry endpoints without an agents row, so the agent
    // check above never sees their plumbing. Every canonical endpoint
    // pointing at this actor must itself be a delete candidate — otherwise
    // the delete leaves a live (or merely non-candidate) endpoint dangling
    // over a missing actor identity.
    const endpoints = (endpointIdsByAgentId.get(actor.id) ?? [])
      .map((id) => snapshot.endpoints[id])
      .filter((endpoint): endpoint is AgentEndpoint => endpoint !== undefined);
    if (endpoints.some((endpoint) => !endpointCandidateIds.has(endpoint.id))) continue;
    if (referencedActorIds.has(actor.id)) continue;
    if (!agent) {
      // No backing agent row: the actor's own first-registration stamp is the
      // only age evidence. Unknown age is kept.
      const createdAt = actorCreatedAt(actor.id);
      if (createdAt <= 0 || createdAt > cutoff) continue;
    }
    actorIds.push(actor.id);
  }

  // Sorted for deterministic application order (stable tests, stable logs).
  return {
    endpointIds: [...endpointCandidateIds].sort(),
    agentIds: agentIds.sort(),
    actorIds: actorIds.sort(),
  };
}

export type RegistryRetentionVerdict = { ok: boolean; reason?: string };

export type RegistryRetentionEvaluator = {
  endpointEligible(
    snapshot: Readonly<RuntimeRegistrySnapshot>,
    endpointId: string,
  ): RegistryRetentionVerdict;
  agentEligible(
    snapshot: Readonly<RuntimeRegistrySnapshot>,
    agentId: string,
  ): RegistryRetentionVerdict;
  actorEligible(
    snapshot: Readonly<RuntimeRegistrySnapshot>,
    actorId: string,
  ): RegistryRetentionVerdict;
};

/**
 * Write-time revalidation of the planner's per-record rules, evaluated inside
 * the serialized durable writer against the CURRENT canonical snapshot. A
 * plan can go stale between computation and application — revivals, fresh
 * references, and peer check-ins queued ahead of the delete must win, so each
 * guard re-runs the same rules on live state instead of trusting the plan.
 *
 * Cost note: each eligibility call scans the current reference inventory
 * (endpoints, agents, messages, invocations, flights, collaboration records),
 * so a sweep is O(deletes × inventory). Measured on the live registry
 * (~19k actors): ~10k evaluator calls at ≈0.23 ms each (~2.3 s for the actor
 * category) — acceptable inside the serialized writer today. If the inventory
 * grows, the follow-up is writer-maintained reference indexes (e.g. actorId →
 * referencing-record sets updated by the same journal entries that mutate
 * them) so a check is a map lookup instead of a scan. No optimization now.
 */
export function createRegistryRetentionEvaluator(input: {
  nodeId: string;
  now?: number;
  /** Explicit week-clock boundary; a rolling `now − retentionMs` cutoff is derived when absent. */
  cutoff?: number;
  retentionMs?: number;
  actorCreatedAtById?: ReadonlyMap<string, number>;
}): RegistryRetentionEvaluator {
  const now = input.now ?? Date.now();
  const retentionMs = Math.max(60 * 60_000, input.retentionMs ?? DEFAULT_REGISTRY_RETENTION_MS);
  const cutoff = input.cutoff ?? now - retentionMs;
  const actorCreatedAt = (snapshot: Readonly<RuntimeRegistrySnapshot>, actorId: string): number =>
    snapshot.actors[actorId]?.createdAt ?? input.actorCreatedAtById?.get(actorId) ?? 0;

  // Recomputed per call — canonical `nodes` can gain a live peer mid-sweep.
  const nodeSet = (snapshot: Readonly<RuntimeRegistrySnapshot>) => {
    const livePeerIds = new Set<string>();
    for (const node of Object.values(snapshot.nodes)) {
      if (node.id === input.nodeId) continue;
      if (nodeLastSeen(node) > cutoff) livePeerIds.add(node.id);
    }
    return {
      inNodeSet: (recordNodeId: string | undefined | null): boolean =>
        recordNodeId === input.nodeId || !recordNodeId || !livePeerIds.has(recordNodeId),
      inNodeSetRequired: (recordNodeId: string): boolean =>
        recordNodeId === input.nodeId || !livePeerIds.has(recordNodeId),
    };
  };

  const endpointEligible = (
    snapshot: Readonly<RuntimeRegistrySnapshot>,
    endpointId: string,
  ): RegistryRetentionVerdict => {
    const endpoint = snapshot.endpoints[endpointId];
    if (!endpoint) return { ok: false, reason: "endpoint-missing" };
    if (!nodeSet(snapshot).inNodeSetRequired(endpoint.nodeId)) {
      return { ok: false, reason: "live-peer-node" };
    }
    if (endpoint.state !== "offline" && endpoint.state !== "stopped") {
      return { ok: false, reason: `state-${endpoint.state}` };
    }
    const lastActivity = lastRegistryActivity(endpoint);
    if (lastActivity <= 0) return { ok: false, reason: "unknown-age" };
    if (lastActivity > cutoff) return { ok: false, reason: "recent-activity" };
    return { ok: true };
  };

  const agentEligible = (
    snapshot: Readonly<RuntimeRegistrySnapshot>,
    agentId: string,
  ): RegistryRetentionVerdict => {
    const agent = snapshot.agents[agentId];
    if (!agent) return { ok: false, reason: "agent-missing" };
    const endpoints = Object.values(snapshot.endpoints)
      .filter((endpoint) => endpoint.agentId === agentId);
    if (endpoints.some((endpoint) => LIVE_ENDPOINT_STATES.has(endpoint.state))) {
      return { ok: false, reason: "live-endpoint" };
    }
    for (const endpoint of endpoints) {
      const verdict = endpointEligible(snapshot, endpoint.id);
      if (!verdict.ok) return { ok: false, reason: `endpoint-${endpoint.id}:${verdict.reason}` };
    }

    const terminalFlightByInvocationId = new Map<string, boolean>();
    for (const flight of Object.values(snapshot.flights)) {
      if (flight.targetAgentId === agentId && !isTerminalFlightState(flight.state)) {
        return { ok: false, reason: "active-flight" };
      }
      terminalFlightByInvocationId.set(
        flight.invocationId,
        isTerminalFlightState(flight.state)
          && (terminalFlightByInvocationId.get(flight.invocationId) ?? true),
      );
    }
    for (const invocation of Object.values(snapshot.invocations)) {
      if (invocation.targetAgentId !== agentId) continue;
      if (terminalFlightByInvocationId.get(invocation.id) !== true) {
        return { ok: false, reason: "open-invocation" };
      }
    }

    let lastActivity = Math.max(lastRegistryActivity(agent), actorCreatedAt(snapshot, agent.id));
    for (const endpoint of endpoints) {
      lastActivity = Math.max(lastActivity, lastRegistryActivity(endpoint));
    }
    if (lastActivity <= 0) return { ok: false, reason: "unknown-age" };
    if (lastActivity > cutoff) return { ok: false, reason: "recent-activity" };

    const { inNodeSet } = nodeSet(snapshot);
    if (!inNodeSet(agent.homeNodeId) || !inNodeSet(agent.authorityNodeId)) {
      return { ok: false, reason: "live-peer-node" };
    }
    return { ok: true };
  };

  const actorEligible = (
    snapshot: Readonly<RuntimeRegistrySnapshot>,
    actorId: string,
  ): RegistryRetentionVerdict => {
    const actor = snapshot.actors[actorId];
    if (!actor) return { ok: false, reason: "actor-missing" };
    if (actor.kind !== "agent" && actor.kind !== "session") {
      return { ok: false, reason: `kind-${actor.kind}` };
    }
    // A surviving agents row means the identity still exists — its delete
    // either ran earlier in this sweep or the agent was never a candidate.
    if (snapshot.agents[actorId]) return { ok: false, reason: "agent-row-survives" };

    // A surviving canonical endpoint vetoes the delete. Actor deletes run
    // after the endpoint category, so an endpoint still pointing at this
    // actor is either a revival committed mid-sweep or was never a
    // candidate — cardless actors carry endpoints with no agents row, so
    // nothing else catches them. Deleting would leave a live endpoint
    // dangling over a missing actor identity.
    for (const endpoint of Object.values(snapshot.endpoints)) {
      if (endpoint.agentId === actorId) {
        return { ok: false, reason: `endpoint-survives:${endpoint.id}` };
      }
    }

    for (const message of Object.values(snapshot.messages)) {
      if (message.actorId === actorId) return { ok: false, reason: "message-reference" };
    }
    for (const invocation of Object.values(snapshot.invocations)) {
      if (invocation.requesterId === actorId || invocation.targetAgentId === actorId) {
        return { ok: false, reason: "invocation-reference" };
      }
    }
    for (const flight of Object.values(snapshot.flights)) {
      if (flight.requesterId === actorId || flight.targetAgentId === actorId) {
        return { ok: false, reason: "flight-reference" };
      }
    }
    for (const record of Object.values(snapshot.collaborationRecords)) {
      if (record.createdById === actorId
        || record.ownerId === actorId
        || record.nextMoveOwnerId === actorId) {
        return { ok: false, reason: "collaboration-reference" };
      }
    }
    for (const agent of Object.values(snapshot.agents)) {
      if (agent.ownerId === actorId) return { ok: false, reason: "agent-owner" };
    }

    // Age gate, same as the planner: with no surviving agent row the actor's
    // first-registration stamp is the only age evidence — a record created
    // recently (or with no timestamp anywhere) is kept.
    const createdAt = actorCreatedAt(snapshot, actorId);
    if (createdAt <= 0) return { ok: false, reason: "unknown-age" };
    if (createdAt > cutoff) return { ok: false, reason: "recent-activity" };
    return { ok: true };
  };

  return { endpointEligible, agentEligible, actorEligible };
}

/**
 * Execute a retention plan in bounded batches so a large backlog (the first
 * sweep can plan tens of thousands of deletes) cannot starve the event loop.
 * Order is fixed — endpoints before agents before actors — so each delete is
 * applied while the plan's own dependency order still holds.
 */
export async function applyRegistryRetentionPlan(
  plan: RegistryRetentionPlan,
  hooks: RegistryRetentionDeleteHooks,
  options: {
    batchSize?: number;
    /** Inter-batch yield; `delayMs` is nonzero when pacing has kicked in. */
    yieldTurn?: (delayMs?: number) => Promise<void>;
    onProgress?: (completed: number, total: number) => void;
    onFailure?: (category: "endpoint" | "agent" | "actor", id: string, error: unknown) => void;
    /** Called once when a slow batch forces the batch size down. */
    onPaceAdjust?: (newBatchSize: number) => void;
    now?: () => number;
  } = {},
): Promise<RegistryRetentionApplyResult> {
  let batchSize = Math.max(1, options.batchSize ?? 500);
  const yieldTurn = options.yieldTurn
    ?? ((delayMs = 0) => delayMs > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      : new Promise<void>((resolve) => setImmediate(resolve)));
  const now = options.now ?? (() => performance.now());
  const progressEvery = 5_000;
  const result: RegistryRetentionApplyResult = {
    endpoints: 0,
    agents: 0,
    actors: 0,
    skipped: { endpoints: 0, agents: 0, actors: 0 },
    failures: 0,
  };
  const total = plan.endpointIds.length + plan.agentIds.length + plan.actorIds.length;
  let completed = 0;
  let paceAdjusted = false;

  const runCategory = async (
    category: "endpoint" | "agent" | "actor",
    ids: string[],
    remove: (id: string) => Promise<RegistryDeleteResult | void>,
    count: (removed: number) => void,
    countSkipped: () => void,
  ): Promise<void> => {
    for (let offset = 0; offset < ids.length;) {
      const batch = ids.slice(offset, offset + batchSize);
      offset += batch.length;
      const batchStart = now();
      for (const id of batch) {
        try {
          const outcome = await remove(id);
          // A {deleted:false} outcome is a write-time veto — the planner's
          // candidate was re-checked inside the serialized writer and lost.
          // Count it separately so the summary never claims it was removed.
          if (outcome && outcome.deleted === false) countSkipped();
          else count(1);
        } catch (error) {
          result.failures += 1;
          options.onFailure?.(category, id, error);
        }
        completed += 1;
        if (completed % progressEvery === 0) options.onProgress?.(completed, total);
      }
      const batchMs = now() - batchStart;
      // Slow batches mean the deletes are contending with live traffic —
      // halve the batch (floor 25) and yield longer so the broker keeps
      // serving between chunks.
      const slow = batchMs > 5_000;
      if (slow && batchSize > 25) {
        batchSize = Math.max(25, Math.floor(batchSize / 2));
        if (!paceAdjusted) {
          paceAdjusted = true;
          options.onPaceAdjust?.(batchSize);
        }
      }
      if (offset < ids.length) await yieldTurn(slow ? 250 : 0);
    }
  };

  await runCategory("endpoint", plan.endpointIds, hooks.deleteEndpoint,
    (n) => { result.endpoints += n; },
    () => { result.skipped.endpoints += 1; });
  await runCategory("agent", plan.agentIds, hooks.deleteAgent,
    (n) => { result.agents += n; },
    () => { result.skipped.agents += 1; });
  await runCategory("actor", plan.actorIds, hooks.deleteActor,
    (n) => { result.actors += n; },
    () => { result.skipped.actors += 1; });
  if (completed % progressEvery !== 0 || completed === 0) {
    options.onProgress?.(completed, total);
  }
  return result;
}
