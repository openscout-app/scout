import { buildScoutReturnAddress, type ScoutAgentCard } from "@openscout/protocol";
import { observedRuntimeForEndpoint } from "./broker-local-endpoint-resolver.js";
import { isCardlessSessionEndpoint, isFlatDispatchEndpoint } from "./broker-cardless-session.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Resolve the exact session actor, never a matching cwd, handle, or requested model. */
export function sessionSenderProfile(snapshot: RuntimeSnapshot, actorId: string, nodeId?: string) {
  const actor = snapshot.actors[actorId];
  if (actor?.kind !== "session") return undefined;
  const endpoints = Object.values(snapshot.endpoints).filter((endpoint) =>
    endpoint.agentId === actorId && (!nodeId || endpoint.nodeId === nodeId)
    && isCardlessSessionEndpoint(endpoint) && !isFlatDispatchEndpoint(endpoint));
  if (endpoints.length !== 1) return undefined;
  const endpoint = endpoints[0]!;
  const observed = observedRuntimeForEndpoint(endpoint);
  let lastModel: string | undefined;
  let lastAt = -Infinity;
  if (!observed.model) {
    for (const flight of Object.values(snapshot.flights)) {
      if (flight.targetAgentId !== actorId) continue;
      const ack = object(flight.metadata?.dispatchAck);
      if (ack.endpointId !== endpoint.id) continue;
      const resolution = object(ack.executionResolution);
      const harness = nonempty(object(resolution.harness).observed);
      const model = nonempty(object(resolution.model).observed);
      const at = typeof ack.acknowledgedAt === "number" ? ack.acknowledgedAt : flight.startedAt ?? 0;
      if (model && (!harness || harness === endpoint.harness) && at > lastAt) {
        lastModel = model;
        lastAt = at;
      }
    }
  }
  return { actor, endpoint, model: observed.model ?? lastModel };
}

export function sessionSenderMetadata(
  snapshot: RuntimeSnapshot, actorId: string, nodeId: string, metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const profile = sessionSenderProfile(snapshot, actorId, nodeId);
  if (!profile) return metadata;
  const { harness: _harness, model: _model, ...context } = object(metadata?.senderContext);
  return {
    ...metadata,
    senderContext: {
      ...context,
      agentId: actorId,
      displayName: profile.actor.displayName,
      harness: profile.endpoint.harness,
      ...(profile.model ? { model: profile.model } : {}),
    },
  };
}

/** Read-only discovery card. It does not give a transient session an agent definition. */
export function sessionSenderCard(snapshot: RuntimeSnapshot, actorId: string): ScoutAgentCard | undefined {
  const profile = sessionSenderProfile(snapshot, actorId);
  if (!profile) return undefined;
  const { actor, endpoint, model } = profile;
  const handle = actor.handle ?? actorId;
  const selector = `session:${actorId}`;
  const projectRoot = endpoint.projectRoot ?? endpoint.cwd ?? "";
  return {
    id: actorId, agentId: actorId, definitionId: actorId,
    displayName: actor.displayName,
    handle, selector,
    projectName: nonempty(actor.metadata?.project),
    projectRoot, currentDirectory: endpoint.cwd ?? projectRoot,
    harness: endpoint.harness, transport: endpoint.transport, sessionId: endpoint.sessionId,
    createdAt: Number(endpoint.metadata?.startedAt) || 0,
    brokerRegistered: true,
    returnAddress: buildScoutReturnAddress({ actorId, handle, selector, displayName: actor.displayName, sessionId: endpoint.sessionId }),
    metadata: { sessionBacked: true, cardless: true, endpointId: endpoint.id, ...(model ? { model } : {}) },
  };
}
