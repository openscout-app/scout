import type { AgentEndpoint, CollaborationRecord, FlightRecord } from "@openscout/protocol";

import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";
import { isCardlessSessionEndpoint } from "./broker-cardless-session.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

export const DEFAULT_CARDLESS_SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

function metadataTimestamp(endpoint: AgentEndpoint, key: string): number {
  const raw = endpoint.metadata?.[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function activeFlightForAgent(flight: FlightRecord, agentId: string): boolean {
  return flight.targetAgentId === agentId && !isTerminalFlightState(flight.state);
}

export function activeCollaborationForAgent(record: CollaborationRecord, agentId: string): boolean {
  const addressed = record.ownerId === agentId || record.nextMoveOwnerId === agentId;
  if (!addressed) return false;
  if (record.kind === "work_item") {
    return record.state !== "done" && record.state !== "cancelled";
  }
  return record.state !== "closed" && record.state !== "declined";
}

export function lastSessionActivity(snapshot: RuntimeRegistrySnapshot, endpoint: AgentEndpoint): number {
  let latest = Math.max(
    metadataTimestamp(endpoint, "startedAt"),
    metadataTimestamp(endpoint, "lastCompletedAt"),
    metadataTimestamp(endpoint, "lastFailedAt"),
  );
  for (const flight of Object.values(snapshot.flights)) {
    if (flight.targetAgentId !== endpoint.agentId) continue;
    latest = Math.max(latest, flight.completedAt ?? flight.startedAt ?? 0);
  }
  for (const record of Object.values(snapshot.collaborationRecords)) {
    if (record.ownerId === endpoint.agentId || record.nextMoveOwnerId === endpoint.agentId) {
      latest = Math.max(latest, record.updatedAt);
    }
  }
  return latest;
}

export function idleCardlessSessionExpiryCandidates(
  snapshot: RuntimeRegistrySnapshot,
  input: { nodeId: string; now?: number; idleTtlMs?: number },
): AgentEndpoint[] {
  const now = input.now ?? Date.now();
  const idleTtlMs = Math.max(60_000, input.idleTtlMs ?? DEFAULT_CARDLESS_SESSION_IDLE_TTL_MS);
  return Object.values(snapshot.endpoints).filter((endpoint) => {
    if (endpoint.nodeId !== input.nodeId || endpoint.state !== "idle") return false;
    if (!isCardlessSessionEndpoint(endpoint)) return false;
    if (Object.values(snapshot.flights).some((flight) => activeFlightForAgent(flight, endpoint.agentId))) {
      return false;
    }
    if (Object.values(snapshot.collaborationRecords).some((record) =>
      activeCollaborationForAgent(record, endpoint.agentId),
    )) {
      return false;
    }
    const lastActivity = lastSessionActivity(snapshot, endpoint);
    return lastActivity > 0 && lastActivity + idleTtlMs <= now;
  });
}
