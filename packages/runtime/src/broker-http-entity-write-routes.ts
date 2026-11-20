import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  CollaborationEvent,
  CollaborationRecord,
  ControlCommand,
  ConversationBinding,
  ConversationDefinition,
  FlightRecord,
  NodeDefinition,
  ThreadWatchCloseRequest,
  ThreadWatchOpenRequest,
  ThreadWatchRenewRequest,
} from "@openscout/protocol";

import type { ActiveScoutBrokerService } from "./broker-api.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import { brokerAttributionFor, brokerAttributionFromMetadata, brokerAttributionRequiresOperator, brokerPersonActorIds } from "./broker-attribution.js";
import { WorkClaimConflictError } from "./broker-work-claims.js";
import {
  badRequest,
  json,
  readRequestBody,
  threadWatchError,
} from "./broker-http-helpers.js";

export type BrokerHttpEntityWriteRouteDeps = {
  brokerService: Pick<
    ActiveScoutBrokerService,
    "executeCommand" | "openThreadWatch" | "renewThreadWatch" | "closeThreadWatch"
  >;
  recordFlight: (flight: FlightRecord) => Promise<void>;
  snapshot?: () => RuntimeSnapshot;
};

export type BrokerHttpEntityWriteRouteInput = {
  method: string;
  url: URL;
  request: RuntimeHttpRequestLike;
  response: RuntimeHttpResponseLike;
  deps: BrokerHttpEntityWriteRouteDeps;
};

export async function handleBrokerHttpEntityWriteRoute(
  input: BrokerHttpEntityWriteRouteInput,
): Promise<boolean> {
  const { method, url, request, response, deps } = input;
  const { brokerService, recordFlight } = deps;
  const attributionSnapshot = () => deps.snapshot?.() ?? ({ actors: {} } as RuntimeSnapshot);

  if (method === "POST" && url.pathname === "/v1/commands") {
    if (!brokerAttributionRequiresOperator(request.transportContext)) {
      json(response, 403, { error: "operator_attribution_required" });
      return true;
    }
    try {
      const command = await readRequestBody<ControlCommand>(request);
      const result = await brokerService.executeCommand(command);
      json(response, 200, result);
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/thread-watches/open") {
    try {
      const body = await readRequestBody<ThreadWatchOpenRequest>(request);
      json(response, 200, await brokerService.openThreadWatch?.(body));
    } catch (error) {
      threadWatchError(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/thread-watches/renew") {
    try {
      const body = await readRequestBody<ThreadWatchRenewRequest>(request);
      json(response, 200, await brokerService.renewThreadWatch?.(body));
    } catch (error) {
      threadWatchError(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/thread-watches/close") {
    try {
      const body = await readRequestBody<ThreadWatchCloseRequest>(request);
      json(response, 200, await brokerService.closeThreadWatch?.(body));
    } catch (error) {
      threadWatchError(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/nodes") {
    try {
      const node = await readRequestBody<NodeDefinition>(request);
      await brokerService.executeCommand({ kind: "node.upsert", node });
      json(response, 200, { ok: true, nodeId: node.id });
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/actors") {
    try {
      const actor = await readRequestBody<ActorIdentity>(request);
      const attribution = brokerAttributionFor({ claimedActorId: actor.id, context: request.transportContext,
        personActorIds: brokerPersonActorIds(attributionSnapshot()) });
      if (actor.kind === "person" && (attribution.source === "unverified" || attribution.actorId !== actor.id)) {
        json(response, 403, { error: "person_attribution_unverified" });
        return true;
      }
      const existing = attributionSnapshot().actors?.[actor.id];
      if (existing?.kind === "person" && actor.kind !== "person" && !brokerAttributionRequiresOperator(request.transportContext)) {
        json(response, 403, { error: "person_attribution_unverified" });
        return true;
      }
      await brokerService.executeCommand({ kind: "actor.upsert", actor });
      json(response, 200, { ok: true, actorId: actor.id });
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/agents") {
    try {
      const agent = await readRequestBody<AgentDefinition>(request);
      const existing = attributionSnapshot().actors?.[agent.id];
      if (existing?.kind === "person" && !brokerAttributionRequiresOperator(request.transportContext)) {
        json(response, 403, { error: "person_attribution_unverified" });
        return true;
      }
      await brokerService.executeCommand({ kind: "agent.upsert", agent });
      json(response, 200, { ok: true, agentId: agent.id });
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/endpoints") {
    try {
      const endpoint = await readRequestBody<AgentEndpoint>(request);
      await brokerService.executeCommand({
        kind: "agent.endpoint.upsert",
        endpoint,
      });
      json(response, 200, { ok: true, endpointId: endpoint.id });
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/conversations") {
    try {
      const conversation = await readRequestBody<ConversationDefinition>(request);
      await brokerService.executeCommand({
        kind: "conversation.upsert",
        conversation,
      });
      json(response, 200, { ok: true, conversationId: conversation.id });
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/bindings") {
    try {
      const binding = await readRequestBody<ConversationBinding>(request);
      await brokerService.executeCommand({ kind: "binding.upsert", binding });
      json(response, 200, { ok: true, bindingId: binding.id });
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/collaboration/records") {
    try {
      const record = await readRequestBody<CollaborationRecord>(request);
      const snapshot = attributionSnapshot();
      const parent = brokerAttributionFromMetadata(record.parentId ? snapshot.collaborationRecords?.[record.parentId]?.metadata : undefined);
      const attribution = brokerAttributionFor({ claimedActorId: record.createdById, context: request.transportContext,
        personActorIds: brokerPersonActorIds(snapshot), parent });
      const attributed = {
        ...record,
        createdById: attribution.actorId,
        ...(record.kind === "question" ? {
          ...(record.askedById !== undefined ? { askedById: attribution.actorId } : {}),
          ...(record.answeredById !== undefined ? { answeredById: attribution.actorId } : {}),
        } : {}),
        metadata: { ...record.metadata, attribution },
      } as CollaborationRecord;
      const result = await brokerService.executeCommand({
        kind: "collaboration.upsert",
        record: attributed,
      });
      json(response, 200, result);
    } catch (error) {
      if (error instanceof WorkClaimConflictError) json(response, error.status, error.conflict);
      else badRequest(response, error);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/collaboration/events") {
    try {
      const event = await readRequestBody<CollaborationEvent>(request);
      const snapshot = attributionSnapshot();
      const parent = brokerAttributionFromMetadata(snapshot.collaborationRecords?.[event.recordId]?.metadata);
      const attribution = brokerAttributionFor({ claimedActorId: event.actorId, context: request.transportContext,
        personActorIds: brokerPersonActorIds(snapshot), parent });
      const result = await brokerService.executeCommand({
        kind: "collaboration.event.append",
        event: { ...event, actorId: attribution.actorId, metadata: { ...event.metadata, attribution } },
      });
      json(response, 200, result);
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }


  if (
    method === "POST"
    && (url.pathname === "/v1/flights" || url.pathname === "/v1/mesh/flights")
  ) {
    try {
      const flight = await readRequestBody<FlightRecord>(request);
      const snapshot = attributionSnapshot();
      const parent = brokerAttributionFromMetadata(snapshot.invocations?.[flight.invocationId]?.metadata);
      const attribution = brokerAttributionFor({ claimedActorId: flight.requesterId, context: request.transportContext,
        personActorIds: brokerPersonActorIds(snapshot), parent, unverifiedPeer: url.pathname.startsWith("/v1/mesh/") });
      await recordFlight({ ...flight, requesterId: attribution.actorId, metadata: { ...flight.metadata, attribution } });
      json(response, 200, { ok: true, flightId: flight.id });
    } catch (error) {
      badRequest(response, error);
    }
    return true;
  }

  return false;
}
