import type { MetadataMap, ScoutAttribution } from "@openscout/protocol";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import type { RuntimeRequestTransportContext } from "./portable-types.js";

export const UNAUTHENTICATED_LOCAL_ACTOR_ID = "local-unverified";

export function brokerAttributionFor(input: {
  claimedActorId?: string;
  context?: RuntimeRequestTransportContext;
  personActorIds?: ReadonlySet<string>;
  parent?: ScoutAttribution;
  unverifiedPeer?: boolean;
}): ScoutAttribution {
  const claimed = input.claimedActorId?.trim() || undefined;
  const person = claimed === "operator" || Boolean(claimed && input.personActorIds?.has(claimed));
  const source = input.unverifiedPeer ? "unverified" : !input.context ? "system" : input.context.operator ? "local-admin" : input.context.scoped ? "scoped" : "unverified";
  const actorId = input.context?.scoped?.principalId
    ?? ((input.context?.peer || input.unverifiedPeer) && claimed ? claimed
      : source === "unverified"
        ? person || !claimed ? UNAUTHENTICATED_LOCAL_ACTOR_ID : claimed ?? "operator"
        : source === "local-admin" && person && claimed !== "operator" ? UNAUTHENTICATED_LOCAL_ACTOR_ID : claimed ?? "operator");
  return {
    actorId,
    rootActorId: input.parent?.rootActorId ?? actorId,
    source,
    ...(claimed && claimed !== actorId ? { claimedActorId: claimed } : {}),
  };
}

export function brokerAttributionFromMetadata(metadata: MetadataMap | undefined): ScoutAttribution | undefined {
  const value = metadata?.attribution as Partial<ScoutAttribution> | undefined;
  if (!value || typeof value.actorId !== "string" || !value.actorId.trim()
    || typeof value.rootActorId !== "string" || !value.rootActorId.trim()
    || !["local-admin", "scoped", "system", "unverified"].includes(value.source ?? "")) return undefined;
  return {
    actorId: value.actorId,
    rootActorId: value.rootActorId,
    source: value.source as ScoutAttribution["source"],
    ...(typeof value.claimedActorId === "string" && value.claimedActorId.trim() ? { claimedActorId: value.claimedActorId } : {}),
  };
}

export function brokerPersonActorIds(snapshot: RuntimeSnapshot): ReadonlySet<string> {
  return new Set(Object.values(snapshot.actors ?? {}).filter(actor => actor.kind === "person").map(actor => actor.id));
}

export function brokerAttributionRequiresOperator(context: RuntimeRequestTransportContext | undefined): boolean {
  return !context || context.operator === true;
}

export function brokerAttributionParentForRef(snapshot: RuntimeSnapshot, raw: string): ScoutAttribution | undefined {
  const ref = raw.replace(/^ref:/, "");
  const direct = snapshot.invocations?.[ref];
  if (direct) return brokerAttributionFromMetadata(direct.metadata);
  const directFlight = snapshot.flights?.[ref];
  if (directFlight) return brokerAttributionFromMetadata(snapshot.invocations?.[directFlight.invocationId]?.metadata);
  const binding = Object.values(snapshot.bindings ?? {}).find(item => item.externalThreadId === ref || item.id === ref);
  const bindingInvocationId = binding?.metadata?.invocationId;
  if (typeof bindingInvocationId === "string") return brokerAttributionFromMetadata(snapshot.invocations?.[bindingInvocationId]?.metadata);
  const candidates = Object.values(snapshot.flights ?? {}).filter(item => item.id === ref
    || (ref.length >= 8 && item.id.endsWith(ref)) || item.invocationId === ref
    || item.metadata?.bindingRef === ref || (binding && item.invocationId === binding.metadata?.invocationId));
  if (candidates.length === 1) return brokerAttributionFromMetadata(snapshot.invocations?.[candidates[0]!.invocationId]?.metadata);
  const message = snapshot.messages?.[ref];
  if (message) {
    const invocation = Object.values(snapshot.invocations ?? {}).find(item => item.messageId === message.id);
    return brokerAttributionFromMetadata(invocation?.metadata ?? message.metadata);
  }
  const record = snapshot.collaborationRecords?.[ref];
  if (record) return brokerAttributionFromMetadata(record.metadata);
  if (ref.startsWith("msg-request-")) return brokerAttributionParentForRef(snapshot, ref.replace(/^msg-request-/, "inv-request-"));
  return undefined;
}
