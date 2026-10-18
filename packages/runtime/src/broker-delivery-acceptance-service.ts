import { isExternalSessionEndpoint } from "./external-session-transport.js";
import { acceptSessionInput, recoverSessionInputDelivery, validateSessionInputRequest, type SessionInputDeliveryOptions } from "./broker-session-input-delivery.js";
import { BrokerCommandAdmission } from "./broker-storage-pressure.js";
import { acceptedDeliveryResponse, deliveryRequestMessageId, deliveryRequestInvocationId, recoverAcceptedInvocation, recoverAcceptedDelivery, type DeliveryAcceptanceEnvelope } from "./broker-delivery-receipt-recovery.js";
import { readMessageRecord } from "./broker-message-records.js";
import { iterateMessageRecordsAsync } from "./broker-message-records.js";
import {
  SCOUT_DISPATCHER_AGENT_ID,
  createScoutExecutionResolution,
  normalizeScoutRuntimeModel,
  validateScoutRuntimeTuple,
  type AgentDefinition,
  type AgentEndpoint,
  type ConversationDefinition,
  type FlightRecord,
  type InvocationRequest,
  type MessageAttachment,
  type MessageRecord,
  type ScoutDeliverRequest,
  type ScoutDeliverResponse,
  type ScoutDeliverRouteKind,
  type ScoutDispatchEnvelope,
  type ScoutDispatchRecord,
  type ScoutDispatchUnavailableTarget,
  type ScoutOwnedRuntimeCatalog,
  type ScoutReturnAddress,
} from "@openscout/protocol";

import {
  brokerOperatorSignalSchema,
} from "./broker-command-boundary-schemas.js";
import {
  buildDeliveryReceipt,
  callerContextForDelivery,
  executionWithRouteParams,
  normalizeScoutLabels,
  projectHostRouteTarget,
  projectPathRouteTarget,
  remediationForDispatch,
  type InvocationResolution,
} from "./broker-delivery-routing.js";
import { executionForBrokerRuntimeProfile } from "./broker-runtime-profiles.js";
import type { DeliveryWorkItemResolution } from "./broker-work-item-store.js";
import {
  askedLabelForRouteTarget,
  buildDispatchEnvelope,
  routeChannelForTarget,
  type BrokerRouteTargetInput,
  type RuntimeSnapshot,
} from "./scout-dispatcher.js";
import { sessionActorAlias } from "./session-alias.js";
import { endpointMatchesTargetSessionAddress, runtimeSessionAddressForSessionId } from "./runtime-session-address.js";
import type { BrokerRequestReceipts } from "./broker-request-receipts.js";

type EnsureBrokerDeliveryConversationInput = {
  requesterId: string;
  targetAgentId?: string;
  channel?: string;
};

type OperatorDeliveryIssueKind = "unassigned_scout" | "rejected" | "unavailable";

type OperatorDeliveryIssueInput = {
  kind: OperatorDeliveryIssueKind;
  requestId: string;
  requesterId: string;
  requesterNodeId: string;
  targetLabel: string;
  detail: string;
  originConversationId?: string;
  originMessageId?: string;
};

type ChannelAttentionPointerInput = {
  requesterId: string;
  requesterNodeId: string;
  targetAgentId: string;
  targetLabel: string;
  channel: string;
  intent: ScoutDeliverRequest["intent"];
  conversation: ConversationDefinition;
  message: MessageRecord;
  createdAt: number;
  replyToSessionId?: string;
  collaborationRecordId?: string;
};

export type BrokerDeliveryAcceptanceServiceOptions = SessionInputDeliveryOptions & {
  nodeId: string;
  operatorActorId: string;
  requestReceipts?: BrokerRequestReceipts;
  commandAdmission?: BrokerCommandAdmission;
  readAcceptedMessage?: (id: string) => Promise<MessageRecord | undefined>;
  readAcceptedInvocation?: (id: string) => Promise<InvocationRequest | undefined>;
  runtimeSnapshot: () => RuntimeSnapshot;
  /**
   * Live runtime-catalog snapshot (BrokerRuntimeCatalogService.read). Tuple
   * validation runs against it so a catalog newer than the shipped default is
   * honored; when absent or failing, validation falls back to the bundled
   * catalog — that is what the bundled copy is for.
   */
  readRuntimeCatalog?: () => Promise<{ catalog: ScoutOwnedRuntimeCatalog }>;
  createId: (prefix: string) => string;
  syncRegisteredLocalAgentsIfChanged: (reason: string) => Promise<void>;
  metadataStringValue: (metadata: Record<string, unknown> | undefined, key: string) => string | null;
  messageRefCandidateForRouteTarget: (payload: BrokerRouteTargetInput) => string | null;
  resolveBrokerMessageRef: (snapshot: RuntimeSnapshot, ref: string) => MessageRecord | null | Promise<MessageRecord|null>;
  ensureBrokerActorForDelivery: (actorId: string) => Promise<void>;
  ensureBrokerDeliveryConversation: (
    input: EnsureBrokerDeliveryConversationInput,
  ) => Promise<ConversationDefinition>;
  brokerRouteKind: (
    conversation: Pick<ConversationDefinition, "id" | "kind" | "metadata">,
  ) => ScoutDeliverRouteKind;
  messageVisibilityForConversation: (
    conversation?: ConversationDefinition,
  ) => MessageRecord["visibility"];
  brokerActorDisplayName: (snapshot: RuntimeSnapshot, actorId: string) => string;
  brokerTargetLabel: (agent: AgentDefinition) => string;
  homeEndpointForAgent: (snapshot: RuntimeSnapshot, agentId: string) => AgentEndpoint | null;
  titleCaseName: (value: string) => string;
  buildBrokerReturnAddressForActor: (
    snapshot: RuntimeSnapshot,
    actorId: string,
    options?: {
      conversationId?: string;
      replyToMessageId?: string;
      sessionId?: string;
    },
  ) => ScoutReturnAddress;
  isOperatorDeliveryTarget: (payload: BrokerRouteTargetInput) => boolean;
  isLocalScoutProductTarget: (payload: BrokerRouteTargetInput) => boolean;
  onlineConversationNotifyTargets: (
    conversation: ConversationDefinition,
    requesterId: string,
  ) => string[];
  resolveBrokerDeliveryTargetWithImplicitProjectAgent: (
    input: BrokerRouteTargetInput & {
      execution?: InvocationRequest["execution"];
      projectAgent?: ScoutDeliverRequest["projectAgent"];
    },
    options: {
      requesterId?: string;
      currentDirectory?: string;
      reason: string;
    },
  ) => Promise<InvocationResolution>;
  createCardlessProjectSession?: (input: {
    projectPath: string;
    /** Mesh machine named by `--on`; the session starts there or nowhere. */
    host?: string;
    execution?: InvocationRequest["execution"];
    projectAgent?: ScoutDeliverRequest["projectAgent"];
    requesterId: string;
    createdAt: number;
  }) => Promise<Extract<InvocationResolution, { kind: "resolved_session" }>>;
  recordScoutDispatch: (
    envelope: ScoutDispatchEnvelope,
    options?: {
      invocationId?: string;
      conversationId?: string;
      requesterId?: string;
    },
  ) => Promise<{ record: ScoutDispatchRecord }>;
  describeUnavailableDeliveryTarget: (
    snapshot: RuntimeSnapshot,
    agent: AgentDefinition,
    targetSessionId?: string,
  ) => ScoutDispatchUnavailableTarget | null;
  buildUnavailableDispatchEnvelope: (
    askedLabel: string,
    unavailable: ScoutDispatchUnavailableTarget,
  ) => ScoutDispatchEnvelope;
  recordDeliveryWorkItemIfNeeded: (input: {
    payload: ScoutDeliverRequest;
    requestId: string;
    requesterId: string;
    targetAgentId: string;
    conversationId: string;
    createdAt: number;
  }) => Promise<DeliveryWorkItemResolution>;
  deliveryWorkItemResolutionForTell: (payload: ScoutDeliverRequest) => DeliveryWorkItemResolution;
  prepareDeliveryWorkItemIfNeeded?: BrokerDeliveryAcceptanceServiceOptions["recordDeliveryWorkItemIfNeeded"];
  postConversationMessage: (message: MessageRecord) => Promise<unknown>;
  acceptInvocation: (invocation: InvocationRequest, message?: MessageRecord, workItem?: DeliveryWorkItemResolution["pendingCreation"]) => Promise<FlightRecord>;
  dispatchAcceptedInvocation: (invocation: InvocationRequest) => Promise<void>;
  queueOperatorDeliveryIssue: (input: OperatorDeliveryIssueInput) => void;
  recordOperatorNeed?: (message: MessageRecord, signal: NonNullable<ScoutDeliverRequest["operatorSignal"]>) => Promise<void>;
  queueOperatorSignal: (input: {
    signal: NonNullable<ScoutDeliverRequest["operatorSignal"]>;
    messageId: string;
    conversationId: string;
    requesterId: string;
    requesterNodeId: string;
    body?: string;
    requesterName?: string;
    projectRoot?: string;
    createdAt?: number;
  }) => void;
  warn?: (message: string, detail?: unknown) => void;
  now?: () => number;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }
}

function normalizeDeliveryAttachments(
  attachments: ScoutDeliverRequest["attachments"],
  createId: (prefix: string) => string,
): MessageAttachment[] | undefined {
  if (!attachments?.length) {
    return undefined;
  }
  const normalized: MessageAttachment[] = [];
  for (const attachment of attachments) {
    const mediaType = attachment?.mediaType?.trim();
    const url = attachment?.url?.trim();
    const blobKey = attachment?.blobKey?.trim();
    if (!mediaType || (!url && !blobKey)) {
      continue;
    }
    normalized.push({
      id: attachment.id?.trim() || createId("att"),
      mediaType,
      fileName: attachment.fileName?.trim() || undefined,
      url: url || undefined,
      blobKey: blobKey || undefined,
      metadata: attachment.metadata,
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export class BrokerDeliveryAcceptanceService {
  private readonly defaultAdmission = new BrokerCommandAdmission();
  constructor(private readonly options: BrokerDeliveryAcceptanceServiceOptions) {}

  private channelAttentionPointerBody(input: {
    channel: string;
    targetLabel: string;
    intent: ScoutDeliverRequest["intent"];
    messageId: string;
  }): string {
    const workNoun = input.intent === "consult" ? "work request" : "message";
    return [
      `Broker notice: #${input.channel} has a ${workNoun} for ${input.targetLabel}.`,
      `Canonical message: ${input.messageId}.`,
      `Reply in #${input.channel}.`,
    ].join(" ");
  }

  private async postChannelAttentionPointer(input: ChannelAttentionPointerInput): Promise<MessageRecord | null> {
    if (
      !input.channel.trim()
      || input.conversation.kind === "direct"
      || input.targetAgentId === input.requesterId
    ) {
      return null;
    }

    const pointerConversation = await this.options.ensureBrokerDeliveryConversation({
      requesterId: input.requesterId,
      targetAgentId: input.targetAgentId,
    });
    const snapshot = this.options.runtimeSnapshot();
    const messageId = this.options.createId("msg");
    const returnAddress = this.options.buildBrokerReturnAddressForActor(snapshot, input.requesterId, {
      conversationId: input.conversation.id,
      replyToMessageId: input.message.id,
      sessionId: input.replyToSessionId,
    });
    const pointer: MessageRecord = {
      id: messageId,
      conversationId: pointerConversation.id,
      actorId: input.requesterId,
      originNodeId: input.requesterNodeId,
      class: "status",
      body: this.channelAttentionPointerBody({
        channel: input.channel,
        targetLabel: input.targetLabel,
        intent: input.intent,
        messageId: input.message.id,
      }),
      mentions: [{ actorId: input.targetAgentId, label: input.targetLabel }],
      audience: {
        notify: [input.targetAgentId],
        reason: "direct_message",
      },
      visibility: this.options.messageVisibilityForConversation(pointerConversation),
      policy: "durable",
      createdAt: input.createdAt,
      metadata: {
        source: "broker-channel-attention",
        brokerGenerated: true,
        attentionKind: "channel_pointer",
        relayChannel: "dm",
        relayTarget: input.targetAgentId,
        relayTargetIds: [input.targetAgentId],
        relayMessageId: messageId,
        channelPointer: {
          channel: input.channel,
          conversationId: input.conversation.id,
          messageId: input.message.id,
          intent: input.intent,
          targetAgentId: input.targetAgentId,
          ...(input.collaborationRecordId ? { collaborationRecordId: input.collaborationRecordId } : {}),
        },
        returnAddress,
      },
    };
    await this.options.postConversationMessage(pointer);
    return pointer;
  }

  private async postChannelAttentionPointerBestEffort(input: ChannelAttentionPointerInput): Promise<void> {
    try {
      await this.postChannelAttentionPointer(input);
    } catch (error) {
      this.options.warn?.(
        `[openscout-runtime] broker channel attention pointer failed for message ${input.message.id}`,
        error,
      );
    }
  }

  async accept(
    payload: ScoutDeliverRequest,
    options: { signal?: AbortSignal; receiptReserved?: boolean; admissionReserved?: boolean } = {},
  ): Promise<ScoutDeliverResponse> {
    throwIfAborted(options.signal);
    validateSessionInputRequest(payload);
    if (payload.sessionDelivery && (!this.options.requestReceipts || !this.options.submitSessionInput || !this.options.upsertSessionInputActor)) {
      throw new Error("session_input_unsupported: broker requires durable session input receipts");
    }
    const admission = this.options.commandAdmission ?? this.defaultAdmission;
    if (options.receiptReserved) {
      const release = options.admissionReserved ? undefined : admission.reserve(payload);
      try { return await this.acceptCommand(payload); } finally { release?.(); }
    }
    if (payload.requestId && this.options.requestReceipts) {
      const { requesterId } = callerContextForDelivery(payload, {
        operatorActorId: this.options.operatorActorId, nodeId: this.options.nodeId,
      });
      // Both transport paths enter this boundary. Once reserved, caller abort
      // stops waiting; it cannot interrupt the broker-owned durable command.
      return this.options.requestReceipts.run(requesterId, payload.requestId, "deliver", payload,
        () => this.acceptCommand(payload),
        async () => this.recoverReceipt(requesterId, payload.requestId!), () => admission.reserve(payload));
    }
    const release = admission.reserve(payload);
    try { return await this.acceptCommand(payload, options); } finally { release(); }
  }

  /** Router-owned receipts must reserve capacity before writing their unknown ledger entry. */
  reserveCommand(payload: ScoutDeliverRequest): () => void {
    return (this.options.commandAdmission ?? this.defaultAdmission).reserve(payload);
  }

  async recoverReceipt(requesterId: string, requestId: string): Promise<ScoutDeliverResponse | null> {
    // The invocation witnesses reused message IDs and remote conversation
    // authority. Consult its hot record before requiring a cold message read.
    const invocationId = deliveryRequestInvocationId(requesterId, requestId);
    const invocation = this.options.readAcceptedInvocation
      ? await this.options.readAcceptedInvocation(invocationId)
      : this.options.runtimeSnapshot().invocations[invocationId];
    const recovered = recoverAcceptedInvocation(invocation, requesterId, requestId);
    if (recovered) return recovered;
    const id = deliveryRequestMessageId(requesterId, requestId);
    const message = this.options.readAcceptedMessage
      ? await this.options.readAcceptedMessage(id)
      : await readMessageRecord(this.options.runtimeSnapshot().messages, id);
    return recoverSessionInputDelivery(message, requesterId, requestId) ?? recoverAcceptedDelivery(message, requesterId, requestId);
  }

  private async acceptCommand(
    payload: ScoutDeliverRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScoutDeliverResponse> {
    const requestId = payload.requestId?.trim() || payload.id?.trim() || this.options.createId("deliver");
    const createdAt = typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt)
      ? payload.createdAt
      : this.now();
    const { requesterId, requesterNodeId } = callerContextForDelivery(payload, {
      operatorActorId: this.options.operatorActorId,
      nodeId: this.options.nodeId,
    });
    if (payload.sessionDelivery) {
      const submitted = await acceptSessionInput(payload, { requesterId, requesterNodeId, createdAt }, this.options);
      if (submitted) return submitted;
    }
    const initialSnapshot = this.options.runtimeSnapshot();
    let completionEndpointId: string | undefined;
    if (payload.completion || payload.relation) {
      // Before resolution can wake/start any session. The first version accepts
      // only exact known local identities, never aliases, fresh projects or mesh.
      const target = payload.target;
      const agentId = target?.kind === "agent_id" ? target.agentId : payload.targetAgentId;
      const sessionId = target?.kind === "session_id" ? target.sessionId : payload.targetSessionId;
      const sessionSelector = target?.kind === "session_id" && target.host ? `${sessionId}@${target.host}` : sessionId;
      const matches = sessionSelector ? Object.values(initialSnapshot.endpoints).filter(item =>
        endpointMatchesTargetSessionAddress(initialSnapshot, item, sessionSelector) && (!agentId || item.agentId === agentId)) : [];
      const endpoint = sessionId ? matches.length === 1 ? matches[0] : undefined
        : agentId ? this.options.homeEndpointForAgent(initialSnapshot, agentId) : null;
      if (payload.intent !== "consult" || !payload.requestId?.trim() || requesterNodeId !== this.options.nodeId
        || payload.channel || payload.sessionDelivery || payload.execution?.session === "fork"
        || payload.execution?.harness || payload.execution?.model || payload.execution?.reasoningEffort
        || payload.execution?.placement || payload.projectAgent
        || payload.execution?.forkFromSessionId || payload.execution?.forkFromStateId
        || (payload.completion && payload.completion.mode !== "explicit") || (target && target.kind !== "agent_id" && target.kind !== "session_id")
        || (target?.kind === "session_id" && target.forkIfLive)
        || !endpoint || endpoint.nodeId !== this.options.nodeId || isExternalSessionEndpoint(endpoint)
        || ["http", "mcp_poll", "pairing_bridge", "devin_cloud_cli"].includes(endpoint.transport)) {
        throw new Error("completion_route_unsupported: use a stable requestId and an exact existing local agent id or session");
      }
      completionEndpointId = endpoint.id;
    }
    const clientMessageId = this.options.metadataStringValue(
      payload.messageMetadata,
      "clientMessageId",
    );
    const existingMessage = clientMessageId
      ? await firstMatchingMessage(initialSnapshot.messages, (message) => message.actorId === requesterId
        && this.options.metadataStringValue(message.metadata, "clientMessageId") === clientMessageId, { actorId: requesterId, clientMessageId })
      : undefined;

    // A bridge acknowledgement can be lost after the broker commits the
    // message and flight. Stable client/request ids make the retry a read of the
    // original transaction instead of a second delivery.
    if (
      existingMessage
      && this.options.metadataStringValue(existingMessage.metadata, "deliveryRequestId") === requestId
    ) {
      const conversation = initialSnapshot.conversations[existingMessage.conversationId];
      if (conversation) {
        const invocation = Object.values(initialSnapshot.invocations)
          .find((candidate) => candidate.messageId === existingMessage.id);
        const flight = invocation
          ? Object.values(initialSnapshot.flights)
              .find((candidate) => candidate.invocationId === invocation.id)
          : undefined;
        const targetAgentId = invocation?.targetAgentId
          ?? this.options.metadataStringValue(existingMessage.metadata, "relayTarget")
          ?? existingMessage.mentions?.[0]?.actorId;
        const targetSessionId = this.options.metadataStringValue(
          existingMessage.metadata,
          "targetSessionId",
        ) ?? undefined;
        const routeKind = this.options.brokerRouteKind(conversation);
        const targetLabel = targetAgentId
          ? this.options.brokerActorDisplayName(initialSnapshot, targetAgentId)
          : "target";
        const bindingRef = flight?.id.slice(-8);
        const sessionAlias = targetAgentId
          ? sessionActorAlias(initialSnapshot, targetAgentId) ?? undefined
          : undefined;
        return {
          kind: "delivery",
          accepted: true,
          routeKind,
          receipt: buildDeliveryReceipt({
            requestId,
            routeKind,
            requesterId,
            requesterNodeId,
            targetAgentId,
            targetSessionId,
            targetSessionAddress: runtimeSessionAddressForSessionId(this.options.runtimeSnapshot(), targetSessionId) ?? undefined,
            targetLabel,
            sessionAlias,
            bindingRef,
            conversationId: conversation.id,
            messageId: existingMessage.id,
            flightId: flight?.id,
          }),
          conversation,
          message: existingMessage,
          ...(targetAgentId ? { targetAgentId } : {}),
          ...(targetSessionId ? { targetSessionId } : {}),
          ...(sessionAlias ? { sessionAlias } : {}),
          ...(bindingRef ? { bindingRef } : {}),
          ...(flight ? { flight } : {}),
        };
      }
    }
    const operatorSignal = payload.operatorSignal
      ? brokerOperatorSignalSchema.parse(payload.operatorSignal)
      : undefined;
    if (operatorSignal) {
      if (!this.options.isOperatorDeliveryTarget(payload)) {
        throw new Error("operator signals must target the operator directly");
      }
      if (payload.intent !== "tell") {
        throw new Error("operator signals must use tell intent");
      }
      if (
        payload.channel?.trim()
        || payload.target?.kind === "channel"
        || payload.target?.kind === "broadcast"
      ) {
        throw new Error("operator signals cannot use channels or broadcast routing");
      }
      if (
        payload.ensureAwake !== undefined
        || payload.execution !== undefined
        || payload.workItem !== undefined
        || payload.collaborationRecordId !== undefined
        || payload.projectAgent !== undefined
        || payload.invocationMetadata !== undefined
      ) {
        throw new Error("operator signals cannot carry work or invocation lifecycle fields");
      }
    }
    const isLocalScoutProductTarget = this.options.isLocalScoutProductTarget(payload);
    if (!isLocalScoutProductTarget) {
      await this.options.syncRegisteredLocalAgentsIfChanged("delivery");
    }
    throwIfAborted(options.signal);
    const askedLabel = askedLabelForRouteTarget(payload);
    const routeExecution = executionWithRouteParams(payload);
    const requestedTargetSessionId =
      payload.target?.kind === "session_id"
        ? payload.target.sessionId.trim()
        : payload.targetSessionId?.trim()
        || payload.execution?.targetSessionId?.trim()
        || this.options.metadataStringValue(payload.invocationMetadata, "targetSessionId")
        || this.options.metadataStringValue(payload.messageMetadata, "targetSessionId")
        || undefined;
    const runtimeCatalogSnapshot = await this.options.readRuntimeCatalog?.().catch(() => null);
    const normalizedModel = routeExecution?.harness && routeExecution.model
      ? normalizeScoutRuntimeModel(routeExecution.harness, routeExecution.model, runtimeCatalogSnapshot?.catalog)
      : null;
    if (normalizedModel && !normalizedModel.ok) {
      throw new Error(`invalid_model: ${normalizedModel.error}`);
    }
    const execution = routeExecution
      ? {
          ...routeExecution,
          ...(normalizedModel?.ok ? { model: normalizedModel.resolved } : {}),
        }
      : undefined;
    const runtimeIssues = validateScoutRuntimeTuple(
      { ...execution, ...(requestedTargetSessionId ? { targetSessionId: requestedTargetSessionId } : {}) },
      undefined,
      runtimeCatalogSnapshot?.catalog ?? undefined,
    );
    if (runtimeIssues.length > 0) {
      const issue = runtimeIssues[0]!;
      throw new Error(`${issue.code}: ${issue.message}`);
    }
    const isProfileExecution = payload.target?.kind === "runtime_profile";
    const executionSourceFor = (dimension: "harness" | "model" | "reasoningEffort"): "profile" | "flag" => (
      payload.executionSource?.[dimension] === "literal"
        ? "flag"
        : isProfileExecution && !payload.execution?.[dimension] ? "profile" : "flag"
    );
    const executionResolution = createScoutExecutionResolution({
      requested: payload.execution,
      resolved: execution,
      source: {
        ...(execution?.harness ? { harness: payload.executionSource?.harness ?? executionSourceFor("harness") } : {}),
        ...(execution?.model ? { model: payload.executionSource?.model ?? executionSourceFor("model") } : {}),
        ...(execution?.reasoningEffort ? { reasoningEffort: payload.executionSource?.reasoningEffort ?? executionSourceFor("reasoningEffort") } : {}),
      },
      resolvedAt: createdAt,
    });
    const deliveryChannel = routeChannelForTarget(payload) ?? payload.channel?.trim();
    const attachments = normalizeDeliveryAttachments(payload.attachments, this.options.createId);
    const replyToSessionId =
      payload.replyToSessionId?.trim()
      || this.options.metadataStringValue(payload.invocationMetadata, "replyToSessionId")
      || this.options.metadataStringValue(payload.messageMetadata, "replyToSessionId")
      || undefined;
    const labels = normalizeScoutLabels(payload.labels);
    const typedChannelTarget = payload.target?.kind === "channel" || payload.target?.kind === "broadcast";
    const hasAgentTarget = Boolean(
      payload.target?.kind === "agent_id"
        || payload.target?.kind === "agent_label"
        || payload.target?.kind === "existing_handle"
        || payload.target?.kind === "runtime_profile"
        || payload.target?.kind === "route_alias"
        || payload.target?.kind === "target_handle"
        || payload.target?.kind === "session_id"
        || payload.target?.kind === "project_path",
    ) || (!payload.target && Boolean(payload.targetSessionId?.trim() || payload.targetAgentId?.trim() || payload.targetLabel?.trim()));

    const messageRef = this.options.messageRefCandidateForRouteTarget(payload);
    const replyTarget = messageRef
      ? await this.options.resolveBrokerMessageRef(this.options.runtimeSnapshot(), messageRef)
      : null;
    throwIfAborted(options.signal);
    if (replyTarget) {
      await this.options.ensureBrokerActorForDelivery(requesterId);
      await this.options.ensureBrokerActorForDelivery(replyTarget.actorId);
      const snapshot = this.options.runtimeSnapshot();
      const conversation = snapshot.conversations[replyTarget.conversationId];
      if (conversation) {
        const messageId = this.options.createId("msg");
        const routeKind = this.options.brokerRouteKind(conversation);
        const notifyTargets = replyTarget.actorId !== requesterId ? [replyTarget.actorId] : [];
        const message: MessageRecord = {
          id: messageId,
          conversationId: conversation.id,
          actorId: requesterId,
          originNodeId: requesterNodeId,
          class: conversation.kind === "system" ? "system" : "agent",
          body: payload.body.trim(),
      ...(attachments ? { attachments } : {}),
          replyToMessageId: replyTarget.id,
          ...(payload.speechText?.trim() ? { speech: { text: payload.speechText.trim() } } : {}),
          audience: {
            reason: "thread_reply",
            ...(notifyTargets.length > 0 ? { notify: notifyTargets } : {}),
          },
          visibility: this.options.messageVisibilityForConversation(conversation),
          policy: "durable",
          createdAt,
          metadata: {
            ...(payload.messageMetadata ?? {}),
            ...(labels.length ? { labels } : {}),
            relayChannel: conversation.kind === "direct" ? "dm" : conversation.id.replace(/^channel\./, ""),
            relayMessageId: messageId,
            relayTarget: replyTarget.actorId,
            relayTargetIds: notifyTargets,
            returnAddress: this.options.buildBrokerReturnAddressForActor(snapshot, requesterId, {
              conversationId: conversation.id,
              replyToMessageId: messageId,
              sessionId: replyToSessionId,
            }),
          },
        };
        await this.options.postConversationMessage(message);
        throwIfAborted(options.signal);
        return {
          kind: "delivery",
          accepted: true,
          routeKind,
          receipt: buildDeliveryReceipt({
            requestId,
            routeKind,
            requesterId,
            requesterNodeId,
            targetLabel: `ref:${replyTarget.id}`,
            conversationId: conversation.id,
            messageId,
          }),
          conversation,
          message,
        };
      }
    }

    if (this.options.isOperatorDeliveryTarget(payload)) {
      await this.options.ensureBrokerActorForDelivery(requesterId);
      await this.options.ensureBrokerActorForDelivery(this.options.operatorActorId);
      const conversation = await this.options.ensureBrokerDeliveryConversation({
        requesterId,
        targetAgentId: this.options.operatorActorId,
        channel: deliveryChannel,
      });
      const snapshot = this.options.runtimeSnapshot();
      const messageId = this.options.createId("msg");
      const routeKind = this.options.brokerRouteKind(conversation);
      const notifyTargets = requesterId !== this.options.operatorActorId ? [this.options.operatorActorId] : [];
      const message: MessageRecord = {
        id: messageId,
        conversationId: conversation.id,
        actorId: requesterId,
        originNodeId: requesterNodeId,
        class: conversation.kind === "system" ? "system" : "agent",
        body: payload.body.trim(),
      ...(attachments ? { attachments } : {}),
        ...(payload.replyToMessageId?.trim() ? { replyToMessageId: payload.replyToMessageId.trim() } : {}),
        mentions: [{ actorId: this.options.operatorActorId, label: "@operator" }],
        ...(payload.speechText?.trim() ? { speech: { text: payload.speechText.trim() } } : {}),
        audience: {
          reason: conversation.kind === "direct" ? "direct_message" : "mention",
          ...(notifyTargets.length > 0 ? { notify: notifyTargets } : {}),
        },
        visibility: this.options.messageVisibilityForConversation(conversation),
        policy: "durable",
        createdAt,
        metadata: {
          ...(payload.messageMetadata ?? {}),
          ...(labels.length ? { labels } : {}),
          ...(operatorSignal
            ? { operatorSignal, operatorSignalId: messageId }
            : {}),
          relayChannel: deliveryChannel || (conversation.kind === "direct" ? "dm" : "shared"),
          relayTarget: this.options.operatorActorId,
          relayTargetIds: notifyTargets,
          relayMessageId: messageId,
          returnAddress: this.options.buildBrokerReturnAddressForActor(snapshot, requesterId, {
            conversationId: conversation.id,
            replyToMessageId: messageId,
            sessionId: replyToSessionId,
          }),
        },
      };
      await this.options.postConversationMessage(message);
      if (operatorSignal) {
        if (operatorSignal.kind === "need") await this.options.recordOperatorNeed?.(message, operatorSignal);
        const requesterAgent = snapshot.agents[requesterId];
        const requesterActor = snapshot.actors[requesterId];
        const requesterEndpoint = Object.values(snapshot.endpoints)
          .find((endpoint) => endpoint.agentId === requesterId && (endpoint.projectRoot || endpoint.cwd));
        const requesterProjectRoot = requesterEndpoint?.projectRoot ?? requesterEndpoint?.cwd;
        this.options.queueOperatorSignal({
          signal: operatorSignal,
          messageId,
          conversationId: conversation.id,
          requesterId,
          requesterNodeId,
          body: message.body,
          requesterName: requesterAgent?.handle
            ?? requesterActor?.handle
            ?? requesterAgent?.displayName
            ?? requesterActor?.displayName
            ?? requesterId,
          ...(requesterProjectRoot ? { projectRoot: requesterProjectRoot } : {}),
          createdAt,
        });
      }
      throwIfAborted(options.signal);
      return {
        kind: "delivery",
        accepted: true,
        routeKind,
        receipt: buildDeliveryReceipt({
          requestId,
          routeKind,
          requesterId,
          requesterNodeId,
          targetAgentId: this.options.operatorActorId,
          targetLabel: "@operator",
          conversationId: conversation.id,
          messageId,
        }),
        conversation,
        message,
        targetAgentId: this.options.operatorActorId,
      };
    }

    if (isLocalScoutProductTarget) {
      // An unassigned Scout target only *fails* when the caller is blocked on a
      // reply nobody is going to write. A `tell` is fire-and-forget: the message
      // lands durably in the Scout thread and the next operator session to
      // attach reads it, so it stays an accepted delivery and carries none of
      // the failure lifecycle metadata.
      const expectsReply = payload.intent === "consult";
      await this.options.ensureBrokerActorForDelivery(requesterId);
      await this.options.ensureBrokerActorForDelivery(SCOUT_DISPATCHER_AGENT_ID);
      const conversation = await this.options.ensureBrokerDeliveryConversation({
        requesterId,
        targetAgentId: SCOUT_DISPATCHER_AGENT_ID,
        channel: deliveryChannel,
      });
      const snapshot = this.options.runtimeSnapshot();
      const messageId = this.options.createId("msg");
      const routeKind = this.options.brokerRouteKind(conversation);
      const detail = `${this.options.titleCaseName(requesterId)} sent a ${
        expectsReply ? "request" : "message"
      } to Scout, but no operator session accepted it.`;
      const rejection = expectsReply
        ? (await this.options.recordScoutDispatch(
          buildDispatchEnvelope(
            {
              kind: "unknown",
              label: askedLabel || "Scout",
              detail,
            },
            askedLabel || "Scout",
            this.options.nodeId,
            snapshot,
            { homeEndpointFor: this.options.homeEndpointForAgent },
          ),
          { requesterId },
        )).record
        : null;
      throwIfAborted(options.signal);
      const message: MessageRecord = {
        id: messageId,
        conversationId: conversation.id,
        actorId: requesterId,
        originNodeId: requesterNodeId,
        class: conversation.kind === "system" ? "system" : "agent",
        body: payload.body.trim(),
      ...(attachments ? { attachments } : {}),
        ...(payload.replyToMessageId?.trim() ? { replyToMessageId: payload.replyToMessageId.trim() } : {}),
        mentions: [{ actorId: SCOUT_DISPATCHER_AGENT_ID, label: "@scout" }],
        ...(payload.speechText?.trim() ? { speech: { text: payload.speechText.trim() } } : {}),
        audience: {
          notify: [],
          reason: conversation.kind === "direct" ? "direct_message" : "mention",
        },
        visibility: this.options.messageVisibilityForConversation(conversation),
        policy: "durable",
        createdAt,
        metadata: {
          ...(payload.messageMetadata ?? {}),
          ...(labels.length ? { labels } : {}),
          requestId,
          ...(rejection
            ? {
              dispatchId: rejection.id,
              replyExpectation: "required",
              routingState: "failed",
            }
            : {}),
          relayChannel: deliveryChannel || (conversation.kind === "direct" ? "dm" : "shared"),
          relayTarget: SCOUT_DISPATCHER_AGENT_ID,
          relayTargetIds: [SCOUT_DISPATCHER_AGENT_ID],
          relayMessageId: messageId,
          returnAddress: this.options.buildBrokerReturnAddressForActor(snapshot, requesterId, {
            conversationId: conversation.id,
            replyToMessageId: messageId,
            sessionId: replyToSessionId,
          }),
        },
      };
      await this.options.postConversationMessage(message);
      throwIfAborted(options.signal);
      this.options.queueOperatorDeliveryIssue({
        kind: "unassigned_scout",
        requestId,
        requesterId,
        requesterNodeId,
        targetLabel: askedLabel || "Scout",
        detail,
        // Only mirror a failure back into the thread when the delivery actually
        // failed; an accepted `tell` would otherwise be contradicted in place.
        ...(rejection
          ? { originConversationId: conversation.id, originMessageId: messageId }
          : {}),
      });
      if (rejection) {
        return {
          kind: "rejected",
          accepted: false,
          reason: "unknown_target",
          rejection,
          remediation: remediationForDispatch(rejection),
        };
      }
      return {
        kind: "delivery",
        accepted: true,
        routeKind,
        receipt: buildDeliveryReceipt({
          requestId,
          routeKind,
          requesterId,
          requesterNodeId,
          targetAgentId: SCOUT_DISPATCHER_AGENT_ID,
          targetLabel: "Scout",
          conversationId: conversation.id,
          messageId,
        }),
        conversation,
        message,
        targetAgentId: SCOUT_DISPATCHER_AGENT_ID,
      };
    }

    if (deliveryChannel && (typedChannelTarget || !hasAgentTarget) && payload.intent === "tell") {
      await this.options.ensureBrokerActorForDelivery(requesterId);
      const conversation = await this.options.ensureBrokerDeliveryConversation({
        requesterId,
        channel: deliveryChannel,
      });
      const snapshot = this.options.runtimeSnapshot();
      const messageId = this.options.createId("msg");
      const routeKind = this.options.brokerRouteKind(conversation);
      const notifyTargets = conversation.kind === "direct"
        ? []
        : this.options.onlineConversationNotifyTargets(conversation, requesterId);
      const message: MessageRecord = {
        id: messageId,
        conversationId: conversation.id,
        actorId: requesterId,
        originNodeId: requesterNodeId,
        class: conversation.kind === "system" ? "system" : "agent",
        body: payload.body.trim(),
      ...(attachments ? { attachments } : {}),
        ...(payload.replyToMessageId?.trim() ? { replyToMessageId: payload.replyToMessageId.trim() } : {}),
        ...(payload.speechText?.trim() ? { speech: { text: payload.speechText.trim() } } : {}),
        audience: {
          reason: conversation.kind === "direct" ? "direct_message" : "conversation_visibility",
          ...(notifyTargets.length > 0 ? { notify: notifyTargets } : {}),
        },
        visibility: this.options.messageVisibilityForConversation(conversation),
        policy: "durable",
        createdAt,
        metadata: {
          ...(payload.messageMetadata ?? {}),
          ...(labels.length ? { labels } : {}),
          relayChannel: deliveryChannel,
          relayMessageId: messageId,
          returnAddress: this.options.buildBrokerReturnAddressForActor(snapshot, requesterId, {
            conversationId: conversation.id,
            replyToMessageId: messageId,
            sessionId: replyToSessionId,
          }),
        },
      };
      await this.options.postConversationMessage(message);
      throwIfAborted(options.signal);
      return {
        kind: "delivery",
        accepted: true,
        routeKind,
        receipt: buildDeliveryReceipt({
          requestId,
          routeKind,
          requesterId,
          requesterNodeId,
          targetLabel: deliveryChannel,
          conversationId: conversation.id,
          messageId,
        }),
        conversation,
        message,
      };
    }

    const projectPath = projectPathRouteTarget(payload);
    const projectHost = projectHostRouteTarget(payload);
    const validRuntimeProfileRoute = payload.target?.kind !== "runtime_profile"
      || Boolean(executionForBrokerRuntimeProfile({
        profileId: payload.target.profile,
        reasoningEffort: payload.target.reasoningEffort,
      }));
    const shouldCreateCardlessProjectSession =
      Boolean(projectPath)
      && validRuntimeProfileRoute
      && payload.intent === "consult"
      && !payload.targetAgentId?.trim()
      && !requestedTargetSessionId
      && ((execution?.session ?? "new") === "new" || execution?.session === "fork")
      && Boolean(this.options.createCardlessProjectSession);
    if (projectHost && !shouldCreateCardlessProjectSession) {
      throw new Error(
        `--on ${projectHost} starts a fresh session in ${projectPath}; it cannot continue or target an existing session or agent. `
        + "Drop --to/--session to start fresh there, or address the existing session as sess.<token>@<host>.",
      );
    }
    const resolved = shouldCreateCardlessProjectSession
      ? await this.options.createCardlessProjectSession!({
          projectPath: projectPath!,
          ...(projectHost ? { host: projectHost } : {}),
          execution,
          projectAgent: payload.projectAgent,
          requesterId,
          createdAt,
        })
      : await this.options.resolveBrokerDeliveryTargetWithImplicitProjectAgent({
          ...payload,
          execution,
        }, {
          requesterId,
          currentDirectory: payload.caller?.currentDirectory?.trim() || projectPath,
          reason: "project delivery target",
        });
    throwIfAborted(options.signal);

    if (resolved.kind !== "resolved" && resolved.kind !== "resolved_session") {
      const { record } = await this.options.recordScoutDispatch(
        buildDispatchEnvelope(
          resolved,
          askedLabel,
          this.options.nodeId,
          this.options.runtimeSnapshot(),
          { homeEndpointFor: this.options.homeEndpointForAgent },
        ),
        {
          requesterId,
        },
      );
      throwIfAborted(options.signal);
      this.options.queueOperatorDeliveryIssue({
        kind: "rejected",
        requestId,
        requesterId,
        requesterNodeId,
        targetLabel: askedLabel || "Scout",
        detail: `Scout could not route ${askedLabel || "the requested target"} from ${this.options.titleCaseName(requesterId)}: ${record.detail}`,
      });
      return {
        kind: "rejected",
        accepted: false,
        reason: resolved.kind === "ambiguous"
          ? "ambiguous_target"
          : resolved.kind === "unknown"
          ? "unknown_target"
          : askedLabel.trim().length > 0
          ? "invalid_target"
          : "missing_target",
        rejection: record,
        remediation: remediationForDispatch(record),
      };
    }

    // SCO-070: a cardless session resolves to an endpoint, not an agent card.
    // Read identity/label off `target`; branch availability on endpoint state.
    const target = resolved.kind === "resolved"
      ? {
          actorId: resolved.agent.id,
          label: this.options.brokerTargetLabel(resolved.agent),
          endpoint: undefined as AgentEndpoint | undefined,
        }
      : {
          actorId: resolved.session.actorId,
          label: resolved.session.label,
          endpoint: resolved.session.endpoint as AgentEndpoint | undefined,
        };
    const aliasResolution = resolved.aliasResolution;
    const sessionFork = resolved.kind === "resolved_session" ? resolved.sessionFork : undefined;
    const receiptSessionId = sessionFork?.sessionId
      ?? requestedTargetSessionId
      ?? (aliasResolution?.target.kind === "session" ? aliasResolution.target.sessionId : undefined)
      ?? (resolved.kind === "resolved_session" ? resolved.session.sessionId : undefined);

    // SCO-098: a resolved session endpoint is never refused for being
    // offline right now. The resolver already dropped terminal/stale
    // endpoints, so "unavailable" here means the harness exited — exactly the
    // store-and-forward case: record the message, dispatch, and let the
    // invocation path wake the session or park the flight as
    // queued_until_online until an attach/retry trigger delivers it.
    const unavailable = resolved.kind === "resolved"
      ? this.options.describeUnavailableDeliveryTarget(
          this.options.runtimeSnapshot(),
          resolved.agent,
          requestedTargetSessionId,
        )
      : null;
    if (unavailable) {
      const targetLabel = askedLabel || target.label;
      const { record } = await this.options.recordScoutDispatch(
        this.options.buildUnavailableDispatchEnvelope(targetLabel, unavailable),
        {
          requesterId,
        },
      );
      throwIfAborted(options.signal);
      this.options.queueOperatorDeliveryIssue({
        kind: "unavailable",
        requestId,
        requesterId,
        requesterNodeId,
        targetLabel,
        detail: `Scout could not reach ${targetLabel} for ${this.options.titleCaseName(requesterId)}: ${record.detail}`,
      });
      return {
        kind: "question",
        accepted: false,
        question: record,
        remediation: remediationForDispatch(record),
      };
    }

    await this.options.ensureBrokerActorForDelivery(requesterId);
    const conversation = await this.options.ensureBrokerDeliveryConversation({
      requesterId,
      targetAgentId: target.actorId,
      channel: deliveryChannel,
    });
    if ((payload.completion || payload.relation) && conversation.authorityNodeId !== this.options.nodeId) {
      throw new Error("completion_remote_conversation_unsupported");
    }

    const workResolution = payload.intent === "consult"
      ? await (this.options.prepareDeliveryWorkItemIfNeeded ?? this.options.recordDeliveryWorkItemIfNeeded)({
          payload: aliasResolution && payload.workItem
            ? {
                ...payload,
                workItem: {
                  ...payload.workItem,
                  metadata: {
                    ...(payload.workItem.metadata ?? {}),
                    aliasResolution,
                  },
                },
              }
            : payload,
          requestId,
          requesterId,
          targetAgentId: target.actorId,
          conversationId: conversation.id,
          createdAt,
        })
      : this.options.deliveryWorkItemResolutionForTell(payload);
    throwIfAborted(options.signal);
    const workRecord = workResolution.record;
    const collaborationRecordId = workResolution.collaborationRecordId;
    const snapshot = this.options.runtimeSnapshot();
    // A routing-recoverable mobile message is already durable in this direct
    // conversation. Once its target becomes available, reuse that record and
    // attach the invocation instead of posting a duplicate bubble.
    const reusableMessage = existingMessage?.conversationId === conversation.id
      ? existingMessage
      : undefined;
    const messageId = reusableMessage?.id ?? (payload.requestId ? deliveryRequestMessageId(requesterId, payload.requestId) : this.options.createId("msg"));
    const targetLabel = target.label;
    const routeKind = this.options.brokerRouteKind(conversation);
    const message: MessageRecord = {
      ...(reusableMessage ?? {}),
      id: messageId,
      conversationId: conversation.id,
      actorId: requesterId,
      originNodeId: requesterNodeId,
      class: conversation.kind === "system" ? "system" : "agent",
      body: payload.body.trim(),
      ...(attachments ? { attachments } : {}),
      ...(payload.replyToMessageId?.trim() ? { replyToMessageId: payload.replyToMessageId.trim() } : {}),
      mentions: [{ actorId: target.actorId, label: targetLabel }],
      ...(payload.speechText?.trim() ? { speech: { text: payload.speechText.trim() } } : {}),
      audience: {
        notify: [target.actorId],
        reason: conversation.kind === "direct" ? "direct_message" : "mention",
      },
      visibility: this.options.messageVisibilityForConversation(conversation),
      policy: "durable",
      createdAt: reusableMessage?.createdAt ?? createdAt,
      metadata: {
        ...(reusableMessage?.metadata ?? {}),
        ...(payload.messageMetadata ?? {}),
        deliveryRequestId: requestId,
        ...(payload.requestId ? { requestId: payload.requestId, requestIntent: payload.intent } : {}),
        ...(labels.length ? { labels } : {}),
        ...(receiptSessionId ? { targetSessionId: receiptSessionId } : {}),
        ...(aliasResolution ? { aliasResolution } : {}),
        requesterDisplayName: this.options.brokerActorDisplayName(snapshot, requesterId),
        targetDisplayName: this.options.brokerActorDisplayName(snapshot, target.actorId),
        relayChannel: deliveryChannel || (conversation.kind === "direct" ? "dm" : "shared"),
        relayTarget: target.actorId,
        relayTargetIds: [target.actorId],
        relayMessageId: messageId,
        ...(collaborationRecordId ? { collaborationRecordId, workId: collaborationRecordId } : {}),
        returnAddress: this.options.buildBrokerReturnAddressForActor(snapshot, requesterId, {
          conversationId: conversation.id,
          replyToMessageId: messageId,
          sessionId: replyToSessionId,
        }),
      },
    };
    const postAttentionPointer = async () => { if (deliveryChannel) {
      await this.postChannelAttentionPointerBestEffort({
        requesterId,
        requesterNodeId,
        targetAgentId: target.actorId,
        targetLabel,
        channel: deliveryChannel,
        intent: payload.intent,
        conversation,
        message,
        createdAt,
        replyToSessionId,
        collaborationRecordId,
      });
    } };

    const shouldDispatchTargetTurn =
      payload.intent === "consult"
      || (payload.intent === "tell"
        && conversation.kind === "direct"
        && payload.ensureAwake !== false);

    if (!shouldDispatchTargetTurn) {
      throwIfAborted(options.signal);
      await this.options.postConversationMessage(message);
      await postAttentionPointer();
      const receipt = buildDeliveryReceipt({
        requestId,
        routeKind,
        requesterId,
        requesterNodeId,
        targetAgentId: target.actorId,
        targetSessionId: receiptSessionId,
        targetSessionAddress: runtimeSessionAddressForSessionId(this.options.runtimeSnapshot(), receiptSessionId) ?? undefined,
        targetLabel,
        aliasResolution,
        conversationId: conversation.id,
        messageId,
        executionResolution,
      });
      return {
        kind: "delivery",
        accepted: true,
        routeKind,
        receipt,
        conversation,
        message,
        targetAgentId: target.actorId,
        ...(receiptSessionId ? { targetSessionId: receiptSessionId } : {}),
        ...(aliasResolution ? { aliasResolution } : {}),
        ...(workRecord?.kind === "work_item" ? { workItem: workRecord } : {}),
      };
    }

    const invocationMetadata = {
      ...(typeof payload.messageMetadata?.source === "string" && payload.invocationMetadata?.source === undefined
        ? { source: payload.messageMetadata.source }
        : {}),
      ...(payload.invocationMetadata ?? {}),
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
      ...(receiptSessionId ? { targetSessionId: receiptSessionId } : {}),
      ...(aliasResolution ? { aliasResolution } : {}),
      ...(payload.intent === "tell" && payload.invocationMetadata?.sourceIntent === undefined
        ? { sourceIntent: "direct_message" }
        : {}),
    };
    const baseInvocationExecution = execution ?? {};
    // A cardless spawn may normalize the requested harness (e.g. grok runs as
    // grok-acp). The invocation must ask for the harness the spawned endpoint
    // actually runs, or endpoint filtering never matches and the ask parks.
    const spawnedHarness = shouldCreateCardlessProjectSession ? target.endpoint?.harness : undefined;
    const invocationExecution = {
      ...baseInvocationExecution,
      ...(spawnedHarness && baseInvocationExecution.harness && spawnedHarness !== baseInvocationExecution.harness
        ? { harness: spawnedHarness }
        : {}),
      ...(receiptSessionId
        ? { session: "existing" as const, targetSessionId: receiptSessionId }
        : baseInvocationExecution.session
        ? {}
        : { session: "new" as const }),
    };
    const invocation: InvocationRequest = {
      id: payload.requestId ? deliveryRequestInvocationId(requesterId, payload.requestId) : this.options.createId("inv"),
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
      requesterId,
      requesterNodeId,
      targetAgentId: target.actorId,
      ...((payload.completion || payload.relation) ? { targetNodeId: this.options.nodeId } : {}),
      action: payload.intent === "tell" ? "wake" : "consult",
      task: payload.body.trim(),
      ...(collaborationRecordId ? { collaborationRecordId } : {}),
      conversationId: conversation.id,
      messageId,
      ...(Object.keys(invocationExecution).length > 0 ? { execution: invocationExecution } : {}),
      executionResolution,
      ensureAwake: payload.ensureAwake ?? true,
      stream: false,
      createdAt,
      ...(labels.length ? { labels } : {}),
      metadata: {
        ...invocationMetadata,
        completion: payload.completion,
        completionRelation: payload.relation,
        completionLocalNodeId: payload.completion || payload.relation ? this.options.nodeId : undefined,
        completionEndpointId,
        ...(labels.length ? { labels } : {}),
        ...(receiptSessionId ? { targetSessionId: receiptSessionId } : {}),
        ...(aliasResolution ? { aliasResolution } : {}),
        requesterDisplayName: this.options.brokerActorDisplayName(snapshot, requesterId),
        targetDisplayName: this.options.brokerActorDisplayName(snapshot, target.actorId),
        relayChannel: deliveryChannel || (conversation.kind === "direct" ? "dm" : "shared"),
        relayTarget: target.actorId,
        ...(collaborationRecordId ? { collaborationRecordId, workId: collaborationRecordId } : {}),
        returnAddress: this.options.buildBrokerReturnAddressForActor(snapshot, requesterId, {
          conversationId: conversation.id,
          replyToMessageId: messageId,
          sessionId: replyToSessionId,
        }),
      },
    };
    const sessionAlias = sessionActorAlias(snapshot, target.actorId) ?? undefined;
    const acceptance: DeliveryAcceptanceEnvelope = {
      version: 1, requesterId, requestId,
      response: {
        kind: "delivery", accepted: true, routeKind, conversation, targetAgentId: target.actorId,
        ...(receiptSessionId ? { targetSessionId: receiptSessionId } : {}),
        ...(aliasResolution ? { aliasResolution } : {}),
        ...(sessionAlias ? { sessionAlias } : {}),
        ...(workRecord?.kind === "work_item" ? { workItem: workRecord } : {}),
      },
      receiptInput: {
        requestId, routeKind, requesterId, requesterNodeId, targetAgentId: target.actorId,
        targetSessionId: receiptSessionId,
        targetSessionAddress: runtimeSessionAddressForSessionId(this.options.runtimeSnapshot(), receiptSessionId) ?? undefined,
        targetLabel, sessionAlias, conversationId: conversation.id, messageId, aliasResolution, executionResolution,
      },
    };
    if (payload.requestId) message.metadata = { ...message.metadata, scoutAcceptance: acceptance };
    // The original receipt and initial flight are recoverable from the same
    // atomic journal frame, even if the process dies before receipt-file save.
    throwIfAborted(options.signal);
    const flight = await this.options.acceptInvocation(invocation, message, workResolution.pendingCreation);
    if (payload.completion) invocation.metadata = { ...invocation.metadata, completionFlightId: flight.id };
    this.options.dispatchAcceptedInvocation(invocation).catch((error) => {
      this.options.warn?.(`[openscout-runtime] background dispatch failed for invocation ${invocation.id}:`, error);
    });
    void postAttentionPointer();
    return acceptedDeliveryResponse(message, acceptance, flight);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

async function firstMatchingMessage(records: Record<string, MessageRecord>, predicate: (record: MessageRecord) => boolean, selection?: import("./broker-message-records.js").MessageSelection): Promise<MessageRecord | undefined> {
  for await (const record of iterateMessageRecordsAsync(records, { selection })) if (predicate(record)) return record;
  return undefined;
}
