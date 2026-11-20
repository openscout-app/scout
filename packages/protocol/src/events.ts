import type { ScoutId } from "./common.js";
import type { NodeDefinition } from "./mesh.js";
import type { ConversationBinding, ConversationDefinition } from "./conversations.js";
import type { DeliveryAttempt, DeliveryIntent } from "./deliveries.js";
import type { FlightRecord, InvocationRequest } from "./invocations.js";
import type { MessageRecord } from "./messages.js";
import type { ConversationReadCursor } from "./read-receipts.js";
import type { AgentDefinition, AgentEndpoint, ActorIdentity } from "./actors.js";
import type { CollaborationEvent, CollaborationRecord } from "./collaboration.js";
import type { ScoutDispatchRecord } from "./scout-dispatch.js";
import type { PresenceBeat } from "./presence.js";
import type { ObservedActivity } from "./observed-status.js";
import type { VercelBoardHandoff } from "./vercel-board.js";

export const OPENSCOUT_CONTROL_EVENT_VERSION = 1 as const;

export interface ControlEventBase<K extends string, P> {
  id: ScoutId;
  kind: K;
  ts: number;
  actorId: ScoutId;
  nodeId?: ScoutId;
  /**
   * Schema version of the control-event envelope. Optional by design: legacy
   * persisted events pre-date the version field and carry no `v`, yet must
   * still satisfy this type so they can be replayed. After
   * {@link normalizeControlEvent}, `v` is always present.
   */
  readonly v?: typeof OPENSCOUT_CONTROL_EVENT_VERSION;
  payload: P;
}

export type NodeUpsertedEvent = ControlEventBase<"node.upserted", {
  node: NodeDefinition;
}>;

export type ActorRegisteredEvent = ControlEventBase<"actor.registered", {
  actor: ActorIdentity;
}>;

export type AgentRegisteredEvent = ControlEventBase<"agent.registered", {
  agent: AgentDefinition;
}>;

export type AgentEndpointUpsertedEvent = ControlEventBase<"agent.endpoint.upserted", {
  endpoint: AgentEndpoint;
}>;

export type AgentEndpointDeletedEvent = ControlEventBase<"agent.endpoint.deleted", {
  endpointId: string;
}>;

export type ConversationUpsertedEvent = ControlEventBase<"conversation.upserted", {
  conversation: ConversationDefinition;
}>;

export type BindingUpsertedEvent = ControlEventBase<"binding.upserted", {
  binding: ConversationBinding;
}>;

export type MessagePostedEvent = ControlEventBase<"message.posted", {
  message: MessageRecord;
}>;

export type MessageCorrectedEvent = ControlEventBase<"message.corrected", { message: MessageRecord }>;

export type ConversationReadCursorUpdatedEvent = ControlEventBase<"conversation.read_cursor.updated", {
  cursor: ConversationReadCursor;
}>;

export type InvocationRequestedEvent = ControlEventBase<"invocation.requested", {
  invocation: InvocationRequest;
}>;

export type FlightUpdatedEvent = ControlEventBase<"flight.updated", {
  flight: FlightRecord;
}>;

export type DeliveryPlannedEvent = ControlEventBase<"delivery.planned", {
  delivery: DeliveryIntent;
}>;

export type DeliveryAttemptedEvent = ControlEventBase<"delivery.attempted", {
  attempt: DeliveryAttempt;
}>;

export type DeliveryStateChangedEvent = ControlEventBase<"delivery.state.changed", {
  delivery: DeliveryIntent;
  previousStatus?: DeliveryIntent["status"];
}>;

export type CollaborationUpsertedEvent = ControlEventBase<"collaboration.upserted", {
  record: CollaborationRecord;
}>;

export type CollaborationEventAppendedEvent = ControlEventBase<"collaboration.event.appended", {
  event: CollaborationEvent;
}>;

export type ScoutDispatchedEvent = ControlEventBase<"scout.dispatched", {
  dispatch: ScoutDispatchRecord;
}>;

/**
 * An agent entered a new activity.
 *
 * Emitted on **transition only** — heartbeats bump the broker's presence map in
 * place and put nothing on the wire. This event is ephemeral by construction:
 * it must never be persisted and must never enter the shared control-event
 * backlog (see {@link isEphemeralControlEvent}). The presence map *is* its
 * backlog — latest-per-agent — and subscribers receive that map on connect.
 */
export type PresenceUpdatedEvent = ControlEventBase<"presence.updated", {
  beat: PresenceBeat;
  /** Absent when the agent had no prior presence entry. */
  previousActivity?: ObservedActivity;
}>;

/** Runtime-owned bridge requests and failures. Credential/config values are never event payloads. */
export type MeshBridgeLifecycleEvent = ControlEventBase<"mesh.bridge.lifecycle", {
  action: "configure" | "enable" | "disable" | "request-restart";
  phase: "requested" | "failed";
}>;

/**
 * A hand-off on a Vercel Board, live. Ephemeral: the custodian's mirror of
 * the board's task events is its record, and a replay derives from it.
 */
export type VercelBoardHandoffEvent = ControlEventBase<"vercel_board.handoff", {
  handoff: VercelBoardHandoff;
}>;

/**
 * A role wrote its slot. Ephemeral: the slot row is the record; a reader that
 * missed this reads the slot.
 */
export type RoleSlotWrittenEvent = ControlEventBase<"role.slot.written", {
  assignmentId: ScoutId;
  roleId: string;
  version: number;
}>;

export type ControlEvent =
  | MeshBridgeLifecycleEvent
  | RoleSlotWrittenEvent
  | VercelBoardHandoffEvent
  | NodeUpsertedEvent
  | ActorRegisteredEvent
  | AgentRegisteredEvent
  | AgentEndpointUpsertedEvent
  | AgentEndpointDeletedEvent
  | ConversationUpsertedEvent
  | BindingUpsertedEvent
  | MessagePostedEvent
  | MessageCorrectedEvent
  | ConversationReadCursorUpdatedEvent
  | InvocationRequestedEvent
  | FlightUpdatedEvent
  | DeliveryPlannedEvent
  | DeliveryAttemptedEvent
  | DeliveryStateChangedEvent
  | CollaborationUpsertedEvent
  | CollaborationEventAppendedEvent
  | ScoutDispatchedEvent
  | PresenceUpdatedEvent;

/**
 * Control-event kinds that are ephemeral by construction.
 *
 * Ephemeral events ride the in-memory control bus for live fan-out and are
 * dropped everywhere else: no SQLite row, no journal entry, no place in the
 * shared bounded backlog. Presence traffic creating zero durable records is a
 * hard constraint, so the durable and backlog paths check this set rather than
 * trusting every call site to route correctly.
 */
export const EPHEMERAL_CONTROL_EVENT_KINDS: ReadonlySet<ControlEvent["kind"]> = new Set<ControlEvent["kind"]>([
  "presence.updated",
  "vercel_board.handoff",
  "role.slot.written",
]);

/** True when the event must never be persisted or backlogged. */
export function isEphemeralControlEvent(event: Pick<ControlEvent, "kind">): boolean {
  return EPHEMERAL_CONTROL_EVENT_KINDS.has(event.kind);
}

/**
 * Stamp the current envelope version onto a control event when it is missing.
 *
 * The `v` field is optional on {@link ControlEventBase} so that legacy events
 * persisted before versioning existed still satisfy the type (the package
 * deliberately preserves legacy shapes for replay). This helper is the bridge:
 * use it on the stamp-on-write path so newly produced events carry `v`, and on
 * the normalize-on-read path so replayed legacy events are upgraded to the
 * current version. It is a pure function — the input is never mutated.
 */
export function normalizeControlEvent<E extends ControlEvent>(
  event: E,
): E & { v: typeof OPENSCOUT_CONTROL_EVENT_VERSION } {
  return { ...event, v: event.v ?? OPENSCOUT_CONTROL_EVENT_VERSION };
}
