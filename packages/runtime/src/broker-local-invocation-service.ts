import { withManagedPermissionContext } from "./managed-permission.js";
import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";
import { isCodexAppServerControlError } from "@openscout/agent-sessions/local";
import { readRuntimeMessage } from "./broker-message-records.js";
import {
  buildScoutReturnAddress,
  runtimeDimensionResolution,
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type ConversationDefinition,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type ScoutCodexAppServerIdentity,
  type ScoutExecutionResolution,
} from "@openscout/protocol";

import {
  invokeA2AHttpEndpoint,
  isA2AHttpEndpoint,
  type A2AHttpInvocationResult,
} from "./a2a-http-endpoint.js";
import { latestEndpointForAgent } from "./broker-endpoint-selection.js";
import {
  localEndpointProviderSessionId,
  localEndpointTraceSessionId,
  observedRuntimeForEndpoint,
  observedModelForExpected,
  promoteLocalEndpointProviderSession,
} from "./broker-local-endpoint-resolver.js";
import {
  clearedTransientStatusMetadata,
  dispatchAckStrategyForEndpoint,
  endpointMatchesTargetSession,
  invocationTargetSessionId,
  isTerminalFlightState,
  shouldNotifyInvocationRequester,
  staleLocalEndpointReason,
  type InvocationStatusPatch,
} from "./broker-local-invocation-helpers.js";
import { isBrokerRunnableLocalAgentTransport, isDirectLocalAgentTransport } from "./local-agent-transports.js";
import { SCOUT_MESSAGE_ATTACHMENTS_CONTEXT_KEY } from "./local-agents.js";
import type { PairingInvocationResult } from "./pairing-session-agents.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import { isRequesterWaitTimeoutError } from "./requester-timeout.js";
import { isDispatchStalledError } from "./dispatch-stalled.js";
import { isDeliveryBlockedError } from "./delivery-blocked.js";
import { isCodexAppServerExitError, isCodexThreadHeldExternallyError } from "./codex-app-server.js";
import { sessionAliasAckSummary } from "./session-alias.js";
import { createInvocationResultReplyIntent, invocationResultMessageId } from "./broker-invocation-result-delivery-service.js";

// How long a thread_held_externally park waits before the recovery sweep may
// retry the resume. Bounds the resume-attempt cadence while an external app
// (e.g. the Codex desktop app) holds the thread's writer lock.
const HELD_THREAD_RETRY_DELAY_MS = 30_000;

type LocalInvocationRuntime = {
  actor(actorId: string): ActorIdentity | undefined;
  agent(agentId: string): AgentDefinition | undefined;
  conversation(conversationId: string): ConversationDefinition | undefined;
  message(messageId: string): MessageRecord | undefined;
  readMessage?(messageId:string):Promise<MessageRecord|undefined>;
  flightForInvocation(invocationId: string): FlightRecord | undefined;
  snapshot(): RuntimeSnapshot;
};

type LocalInvocationTargetIdentity = {
  id: string;
  displayName: string;
  handle?: string;
  definitionId?: string;
  selector?: string;
  defaultSelector?: string;
};

type LocalInvocationEndpointResolver = {
  activeLocalEndpointForAgent(
    agentId: string,
    harness?: AgentEndpoint["harness"],
    targetSessionId?: string,
  ): AgentEndpoint | undefined;
  resolveLocalEndpointForInvocation(invocation: InvocationRequest): Promise<AgentEndpoint | undefined>;
  prepareLocalEndpointForInvocation(endpoint: AgentEndpoint): Promise<AgentEndpoint>;
};

type LocalAgentInvocationResult = {
  output: string;
  externalSessionId?: string | null;
  metadata?: Record<string, unknown>;
};

type LocalAgentInvocationHooks = {
  onSessionObserved?: (metadata: Record<string, unknown>) => Promise<void> | void;
};

type InvocationExecutorResult =
  | PairingInvocationResult
  | A2AHttpInvocationResult
  | LocalAgentInvocationResult;

function executionResolutionWithObservedEndpoint(
  resolution: ScoutExecutionResolution | null | undefined,
  endpoint: AgentEndpoint,
  fallbackObservedAt: number,
): ScoutExecutionResolution | null {
  if (!resolution) {
    return null;
  }
  const observed = observedRuntimeForEndpoint(endpoint);
  const hasObserved = Boolean(observed.harness || observed.model || observed.reasoningEffort);
  const metadataObservedAt = endpoint.metadata?.observedRuntimeAt;
  const observedAt = typeof metadataObservedAt === "number" && Number.isFinite(metadataObservedAt)
    ? metadataObservedAt
    : fallbackObservedAt;
  const dimension = (key: "harness" | "model" | "reasoningEffort") => runtimeDimensionResolution({
    requested: resolution[key].requested,
    resolved: resolution[key].resolved,
    source: resolution[key].source,
    observed: (key === "model" ? observedModelForExpected(observed, resolution[key].resolved) : observed[key])
      ?? resolution[key].observed,
    observedAt: observed[key] ? observedAt : resolution[key].observedAt,
  });
  const sessionId = localEndpointTraceSessionId(endpoint);
  const codexAppServer = codexAppServerIdentityForEndpoint(endpoint) ?? resolution.codexAppServer;
  return {
    ...resolution,
    harness: dimension("harness"),
    model: dimension("model"),
    reasoningEffort: dimension("reasoningEffort"),
    ...(sessionId ? { sessionId } : {}),
    ...(hasObserved ? { observedAt } : {}),
    ...(codexAppServer ? { codexAppServer } : {}),
  };
}

/** Which Codex app-server served this endpoint, as recorded from `initialize`. */
function codexAppServerIdentityForEndpoint(endpoint: AgentEndpoint): ScoutCodexAppServerIdentity | undefined {
  const value = endpoint.metadata?.codexAppServer;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.connection !== "spawned" && record.connection !== "attached") return undefined;
  return record as unknown as ScoutCodexAppServerIdentity;
}

async function invocationWithOriginatingMessageAttachments(
  invocation: InvocationRequest,
  runtime: LocalInvocationRuntime,
): Promise<InvocationRequest> {
  if (!invocation.messageId) {
    return invocation;
  }

  const attachments = (await readRuntimeMessage(runtime,invocation.messageId))?.attachments;
  if (!attachments?.length) {
    return invocation;
  }

  return {
    ...invocation,
    context: {
      ...(invocation.context ?? {}),
      [SCOUT_MESSAGE_ATTACHMENTS_CONTEXT_KEY]: attachments.map((attachment) => ({
        id: attachment.id,
        mediaType: attachment.mediaType,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
        ...(attachment.url ? { url: attachment.url } : {}),
        ...(attachment.blobKey ? { blobKey: attachment.blobKey } : {}),
      })),
    },
  };
}

export type BrokerLocalInvocationServiceOptions = {
  nodeId: string;
  runtime: LocalInvocationRuntime;
  endpointResolver: LocalInvocationEndpointResolver;
  activeInvocationTasks: Map<string, Promise<void>>;
  /**
   * Applies a status patch to the invocation's current flight and funnels it
   * through the durable write path (recordFlight), so terminal-state hooks
   * (normalizeRecordedFlight, promoteInvocationFlightToWork,
   * maybeForwardFlightToAuthority) keep firing. Returns the persisted record.
   * Throws if the invocation has no recorded flight — dispatch persists the
   * initial flight before launch, so a missing flight is an invariant breach.
   */
  transitionInvocation: (
    invocationId: string,
    patch: InvocationStatusPatch,
  ) => Promise<FlightRecord>;
  persistEndpoint: (endpoint: AgentEndpoint) => Promise<void>;
  /** Durable metadata write that must not trigger queued dispatch recovery. */
  persistEndpointWithoutRecovery: (endpoint: AgentEndpoint) => Promise<void>;
  deferInvocationRetry?: (invocationId: string, notBeforeTs: number) => void;
  postInvocationStatusMessage: (
    invocation: InvocationRequest,
    flight: { id?: string; summary?: string; error?: string },
  ) => Promise<void>;
  deliverInvocationResult: (invocationId: string) => Promise<unknown>;
  existingBrokerReplyForInvocation: (
    invocation: InvocationRequest,
    agentId: string,
    sinceMs: number,
  ) => MessageRecord | null | Promise<MessageRecord|null>;
  completeInvocationForBrokerReply: (
    invocation: InvocationRequest,
    reply: MessageRecord,
  ) => Promise<boolean>;
  messageVisibilityForConversation: (conversation?: ConversationDefinition) => MessageRecord["visibility"];
  scoutbotReplyProvenanceMetadata: (invocation: InvocationRequest) => Record<string, unknown>;
  invokePairingSessionEndpoint: (
    endpoint: AgentEndpoint,
    invocation: InvocationRequest,
  ) => Promise<PairingInvocationResult>;
  invokeA2AHttpEndpoint?: (
    endpoint: AgentEndpoint,
    invocation: InvocationRequest,
  ) => Promise<A2AHttpInvocationResult>;
  invokeLocalAgentEndpoint: (
    endpoint: AgentEndpoint,
    invocation: InvocationRequest,
    hooks?: LocalAgentInvocationHooks,
  ) => Promise<LocalAgentInvocationResult>;
  error?: (message: string, detail?: unknown) => void;
  warn?: (message: string) => void;
  now?: () => number;
};

export class BrokerLocalInvocationService {
  readonly #activeEndpointTasks = new Map<string, Promise<void>>();

  constructor(private readonly options: BrokerLocalInvocationServiceOptions) {}

  /**
   * Direct local adapters execute on this service's canonical endpoint lane.
   * Availability may admit the next command while the prior completed flight
   * still awaits its idle endpoint write; execution remains serialized below.
   * Codex is excluded: an uncertain submission can release this lane while its
   * native turn remains unresolved, so it cannot yet promise queued execution.
   * Terminal transports, remote endpoints and other adapters do not inherit it.
   */
  supportsQueuedEndpoint(endpoint: AgentEndpoint): boolean {
    return endpoint.nodeId === this.options.nodeId
      && endpoint.transport !== "codex_app_server"
      && isDirectLocalAgentTransport(endpoint.transport);
  }

  hasActiveInvocation(invocationId: string): boolean {
    return this.options.activeInvocationTasks.has(invocationId);
  }

  launch(invocation: InvocationRequest): void {
    if (this.options.activeInvocationTasks.has(invocation.id)) {
      return;
    }

    const task = Promise.resolve()
      .then(() => withManagedPermissionContext(invocation, () => this.execute(invocation)))
      .catch((error) => {
        this.options.error?.(`[openscout-runtime] local invocation ${invocation.id} crashed:`, error);
      })
      .finally(() => {
        this.options.activeInvocationTasks.delete(invocation.id);
      });
    this.options.activeInvocationTasks.set(invocation.id, task);
  }

  async execute(invocation: InvocationRequest): Promise<void> {
    if (this.currentFlightIsTerminal(invocation.id)) return;
    const agent = this.options.runtime.agent(invocation.targetAgentId);
    const actor = this.options.runtime.actor(invocation.targetAgentId) ?? agent;
    const target = localInvocationTargetIdentity(invocation.targetAgentId, agent, actor);
    let endpoint: AgentEndpoint | undefined;
    const previousEndpoint = this.options.endpointResolver.activeLocalEndpointForAgent(
      invocation.targetAgentId,
      invocation.execution?.harness,
      invocationTargetSessionId(invocation),
    );

    try {
      endpoint = await this.options.endpointResolver.resolveLocalEndpointForInvocation(invocation);
    } catch (error) {
      await this.handlePreparationError(invocation, target, error);
      return;
    }
    if (this.currentFlightIsTerminal(invocation.id)) return;

    if (!endpoint) {
      await this.executeOnEndpoint(invocation, endpoint, previousEndpoint);
      return;
    }

    // Resolve aliases before scheduling. The endpoint is the stable execution
    // owner even when preparation promotes its provider session identity.
    // Fresh isolated endpoints get independent lanes for the same agent.
    const ownerKey = [endpoint.nodeId, endpoint.harness, endpoint.id].join("\u0000");
    const previousTask = this.#activeEndpointTasks.get(ownerKey);
    const task = (previousTask ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.executeOnEndpoint(invocation, endpoint, previousEndpoint));
    this.#activeEndpointTasks.set(ownerKey, task);
    try {
      await task;
    } finally {
      if (this.#activeEndpointTasks.get(ownerKey) === task) {
        this.#activeEndpointTasks.delete(ownerKey);
      }
    }
  }

  private async handlePreparationError(
    invocation: InvocationRequest,
    target: LocalInvocationTargetIdentity,
    error: unknown,
  ): Promise<void> {
    if (this.currentFlightIsTerminal(invocation.id)) return;
    if (isCodexThreadHeldExternallyError(error)) {
      // Wake found the session's thread open in another app (single-writer
      // rule). Park the delivery instead of failing it — the retry sweep
      // redispatches once the deferral elapses.
      const checkedAt = this.now();
      await this.options.transitionInvocation(invocation.id, {
        state: "queued",
        summary: `${target.displayName}'s Codex thread is open in another app. Message stored; will deliver when the thread is released.`,
        metadata: {
          dispatchOutcome: {
            status: "queued_until_online",
            reason: "thread_held_externally",
            checkedAt,
          },
          heldThreadId: error.threadId,
        },
      });
      this.options.deferInvocationRetry?.(invocation.id, checkedAt + HELD_THREAD_RETRY_DELAY_MS);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failedFlight = await this.options.transitionInvocation(invocation.id, {
      state: "failed",
      summary: `${target.displayName} could not be prepared.`,
      error: `Endpoint resolution failed before execution: ${message}`,
      completedAt: this.now(),
      metadata: {
        failureStage: "endpoint_resolution",
      },
    });
    if (failedFlight.state === "failed") {
      await this.options.postInvocationStatusMessage(invocation, failedFlight);
    }
  }

  private async executeOnEndpoint(
    invocation: InvocationRequest,
    resolvedEndpoint: AgentEndpoint | undefined,
    previousEndpoint: AgentEndpoint | undefined,
  ): Promise<void> {
    // A queued task may have been cancelled or completed while its owner was
    // busy. Do not even prepare an executor after that terminal decision.
    if (this.currentFlightIsTerminal(invocation.id)) return;
    const agent = this.options.runtime.agent(invocation.targetAgentId);
    const actor = this.options.runtime.actor(invocation.targetAgentId) ?? agent;
    const target = localInvocationTargetIdentity(invocation.targetAgentId, agent, actor);
    let endpoint = resolvedEndpoint;
    try {
      if (actor && endpoint) {
        // Resolution can precede another turn on this lane. Use its latest
        // provider metadata, but never follow an endpoint into another session.
        const latest = this.options.runtime.snapshot().endpoints[endpoint.id];
        if (latest) {
          if (latest.nodeId !== endpoint.nodeId || latest.harness !== endpoint.harness
            || latest.agentId !== endpoint.agentId || latest.sessionId !== endpoint.sessionId) {
            throw new Error(`Execution owner changed while invocation ${invocation.id} waited for endpoint ${endpoint.id}.`);
          }
          endpoint = latest;
        }
        const targetSessionId = invocationTargetSessionId(invocation);
        if (targetSessionId && !endpointMatchesTargetSession(endpoint, targetSessionId)) {
          throw new Error(`Session ${targetSessionId} no longer belongs to endpoint ${endpoint.id}.`);
        }
        endpoint = await this.options.endpointResolver.prepareLocalEndpointForInvocation(endpoint);
      }
    } catch (error) {
      await this.handlePreparationError(invocation, target, error);
      return;
    }
    if (this.currentFlightIsTerminal(invocation.id)) return;

    if (!actor || !endpoint) {
      const targetSessionId = invocationTargetSessionId(invocation);
      const staleEndpointReason = targetSessionId
        ? staleLocalEndpointReason(latestEndpointForAgent(this.options.runtime.snapshot(), invocation.targetAgentId))
        : null;
      if (staleEndpointReason) {
        const failedFlight = await this.options.transitionInvocation(invocation.id, {
          state: "failed",
          summary: `${target.displayName} could not be prepared.`,
          error: `Endpoint resolution failed before execution: ${staleEndpointReason}`,
          completedAt: this.now(),
          metadata: {
            failureStage: "endpoint_resolution",
            staleLocalRegistration: true,
          },
        });
        await this.options.postInvocationStatusMessage(invocation, failedFlight);
        return;
      }

      await this.options.transitionInvocation(invocation.id, {
        state: "queued",
        summary: `Message stored for ${target.displayName}. Will deliver when online.`,
        metadata: {
          dispatchOutcome: {
            status: "queued_until_online",
            reason: "no_runnable_endpoint",
            checkedAt: this.now(),
          },
        },
      });
      return;
    }

    if (
      endpoint.transport !== "pairing_bridge"
      && !isA2AHttpEndpoint(endpoint)
      && !isBrokerRunnableLocalAgentTransport(endpoint.transport)
    ) {
      const failedFlight = await this.options.transitionInvocation(invocation.id, {
        state: "failed",
        summary: `${target.displayName} has no supported local executor.`,
        error: `Endpoint transport ${endpoint.transport} is registered for ${target.id}, but the broker only routes through direct local agent adapters or A2A HTTP endpoints.`,
        completedAt: this.now(),
      });
      await this.options.postInvocationStatusMessage(invocation, failedFlight);
      return;
    }

    const runningEndpoint: AgentEndpoint = {
      ...endpoint,
      state: "active",
      metadata: {
        ...(endpoint.metadata ?? {}),
        lastInvocationId: invocation.id,
        lastStartedAt: this.now(),
      },
    };
    await this.options.persistEndpoint(runningEndpoint);
    const restoreUnsubmittedEndpoint = () => this.options.persistEndpoint({
      ...runningEndpoint,
      state: endpoint.state,
    });
    if (this.currentFlightIsTerminal(invocation.id)) {
      await restoreUnsubmittedEndpoint();
      return;
    }

    const dispatchAck = {
      strategy: dispatchAckStrategyForEndpoint({
        invocation,
        endpoint: runningEndpoint,
        previousEndpoint,
        now: this.now(),
      }),
      endpointId: runningEndpoint.id,
      transport: runningEndpoint.transport,
      harness: runningEndpoint.harness,
      sessionId: localEndpointTraceSessionId(runningEndpoint),
      nodeId: runningEndpoint.nodeId,
      placement: runningEndpoint.metadata?.placement === "attached"
        ? "attached"
        : runningEndpoint.metadata?.placement === "foreground"
        ? "foreground"
        : runningEndpoint.metadata?.placement === "background"
          ? "background"
          : runningEndpoint.transport === "codex_app_server" ? "foreground" : "background",
      executionResolution: executionResolutionWithObservedEndpoint(
        invocation.executionResolution,
        runningEndpoint,
        this.now(),
      ),
      acknowledgedAt: this.now(),
    };
    const aliasSummary = sessionAliasAckSummary({
      snapshot: this.options.runtime.snapshot(),
      actorId: invocation.targetAgentId,
      endpoint: runningEndpoint,
      strategy: dispatchAck.strategy,
    });
    const runningFlight = await this.options.transitionInvocation(invocation.id, {
      state: "running",
      summary: aliasSummary || `${target.displayName} acknowledged via ${dispatchAck.strategy}.`,
      error: undefined,
      completedAt: undefined,
      metadata: {
        ...clearedTransientStatusMetadata(),
        dispatchAck,
      },
    });
    if (isTerminalFlightState(runningFlight.state) || this.currentFlightIsTerminal(invocation.id)) {
      await restoreUnsubmittedEndpoint();
      return;
    }

    // Carries harness identity observed mid-turn, so every later persist of
    // this endpoint (completion, empty reply, failure) keeps it.
    let liveEndpoint = runningEndpoint;
    try {
      const invocationWithAttachments = await invocationWithOriginatingMessageAttachments(invocation, this.options.runtime);
      // This is the last await before external submission. Cancellation can
      // arrive during attachment reads or any of the preceding durable writes.
      if (this.currentFlightIsTerminal(invocation.id)) {
        await restoreUnsubmittedEndpoint();
        return;
      }
      const result = await this.invokeEndpoint(
        runningEndpoint,
        invocationWithAttachments,
        {
          onSessionObserved: async (metadata) => {
            liveEndpoint = promoteLocalEndpointProviderSession(liveEndpoint, { metadata });
            await this.options.persistEndpoint(liveEndpoint);
          },
        },
      );
      const completedEndpoint = this.completedEndpoint(liveEndpoint, result);
      const completedSessionId = localEndpointTraceSessionId(completedEndpoint);
      const refinesSessionId = (
        dispatchAck.sessionId
        && completedSessionId
        && dispatchAck.sessionId !== completedSessionId
        && !localEndpointProviderSessionId(runningEndpoint)
        && localEndpointProviderSessionId(completedEndpoint) === completedSessionId
      ) ? dispatchAck.sessionId : null;
      const completedDispatchAck = {
        ...dispatchAck,
        sessionId: completedSessionId,
        ...(refinesSessionId ? { refinesSessionId } : {}),
        executionResolution: executionResolutionWithObservedEndpoint(
          invocation.executionResolution,
          completedEndpoint,
          this.now(),
        ),
      };

      if (this.currentFlightIsTerminal(invocation.id)) {
        await this.options.persistEndpoint({ ...completedEndpoint, state: "idle" });
        return;
      }

      if (invocation.action === "wake") {
        await this.options.persistEndpointWithoutRecovery(completedEndpoint);
        if (!this.currentFlightIsTerminal(invocation.id)) {
          await this.options.transitionInvocation(invocation.id, {
            state: "completed",
            summary: `${target.displayName} received the message.`,
            output: result.output,
            completedAt: this.now(),
            metadata: { dispatchAck: completedDispatchAck },
          });
        }

        await this.options.persistEndpoint({
          ...completedEndpoint,
          state: "idle",
        });
        return;
      }

      const postedReply = await this.options.existingBrokerReplyForInvocation(
        invocation,
        target.id,
        runningFlight.startedAt ?? this.now(),
      );
      if (this.currentFlightIsTerminal(invocation.id)) {
        await this.options.persistEndpoint({ ...completedEndpoint, state: "idle" });
        return;
      }
      const output = redactSecrets(postedReply?.body || result.output);
      if (!output.trim()) {
        const failedFlight = await this.options.transitionInvocation(invocation.id, {
          state: "failed",
          summary: `${target.displayName} returned an empty reply.`,
          error: `Local target ${target.id} completed without broker-visible output.`,
          completedAt: this.now(),
          metadata: {
            failureStage: "empty_reply",
            dispatchAck: completedDispatchAck,
          },
        });

        await this.options.persistEndpoint({
          ...liveEndpoint,
          state: "idle",
          metadata: {
            ...(liveEndpoint.metadata ?? {}),
            lastFailedAt: this.now(),
            lastError: failedFlight.error,
          },
        });

        await this.options.postInvocationStatusMessage(invocation, failedFlight);
        return;
      }

      // Make provider identity visible with completion, without waking queued
      // work until the existing post-completion idle transition below.
      await this.options.persistEndpointWithoutRecovery(completedEndpoint);
      if (this.currentFlightIsTerminal(invocation.id)) {
        await this.options.persistEndpoint({ ...completedEndpoint, state: "idle" });
        return;
      }
      const completedAt = this.now();
      const conversation = invocation.conversationId && !postedReply
        ? this.options.runtime.conversation(invocation.conversationId) : undefined;
      const resultReply = conversation && invocation.conversationId
        ? createInvocationResultReplyIntent(invocation.id, {
          id: invocationResultMessageId(invocation.id),
          conversationId: invocation.conversationId,
          actorId: target.id,
          originNodeId: this.options.nodeId,
          class: "agent",
          body: output,
          replyToMessageId: invocation.messageId,
          ...(shouldNotifyInvocationRequester(invocation)
            ? { audience: { notify: [invocation.requesterId] } }
            : { audience: { delivery: "none" } }),
          visibility: this.options.messageVisibilityForConversation(conversation),
          policy: "durable",
          createdAt: completedAt,
          metadata: {
            invocationId: invocation.id,
            flightId: runningFlight.id,
            source: "broker",
            ...this.options.scoutbotReplyProvenanceMetadata(invocation),
            returnAddress: buildScoutReturnAddress({
              actorId: target.id,
              handle: target.handle?.trim() || target.definitionId || target.id,
              displayName: target.displayName,
              selector: target.selector,
              defaultSelector: target.defaultSelector,
              conversationId: invocation.conversationId,
              replyToMessageId: invocation.messageId,
              nodeId: completedEndpoint.nodeId,
              projectRoot: completedEndpoint.projectRoot ?? completedEndpoint.cwd,
              sessionId: completedEndpoint.sessionId,
            }),
            requestedReturnAddress: invocation.metadata?.["returnAddress"],
            responderHarness: completedEndpoint.harness,
            responderTransport: completedEndpoint.transport,
            responderSessionId: completedEndpoint.sessionId ?? "",
            responderCwd: completedEndpoint.cwd ?? "",
            responderProjectRoot: completedEndpoint.projectRoot ?? "",
            responderAgentName: String(completedEndpoint.metadata?.agentName ?? target.handle ?? target.id),
            responderStartedAt: String(completedEndpoint.metadata?.startedAt ?? ""),
            responderNodeId: completedEndpoint.nodeId,
          },
        }) : undefined;
      const completedFlight = await this.options.transitionInvocation(invocation.id, {
        state: "completed",
        summary: `${target.displayName} replied.`,
        output,
        completedAt,
        metadata: { dispatchAck: completedDispatchAck, ...(resultReply ? { resultReply } : {}) },
      });

      await this.options.persistEndpoint({ ...completedEndpoint, state: "idle" });
      if (completedFlight.state !== "completed" || !resultReply) return;
      // Output and the exact reply are durable before posting. Release this
      // execution lane without waiting for a slow conversation authority.
      // Delivery errors remain pending and never become executor attempts.
      try {
        void this.options.deliverInvocationResult(invocation.id).catch((error) => {
          this.options.error?.(`[openscout-runtime] result reply ${invocation.id} remains pending:`, error);
        });
      } catch (error) {
        this.options.error?.(`[openscout-runtime] result reply ${invocation.id} remains pending:`, error);
      }
    } catch (error) {
      await this.handleExecutionError({
        error,
        invocation,
        target,
        runningEndpoint: liveEndpoint,
        runningFlight,
        priorEndpointState: endpoint.state,
      });
    }
  }

  private async invokeEndpoint(
    endpoint: AgentEndpoint,
    invocation: InvocationRequest,
    hooks: LocalAgentInvocationHooks,
  ): Promise<InvocationExecutorResult> {
    if (endpoint.transport === "pairing_bridge") {
      return this.options.invokePairingSessionEndpoint(endpoint, invocation);
    }
    if (isA2AHttpEndpoint(endpoint)) {
      return (this.options.invokeA2AHttpEndpoint ?? invokeA2AHttpEndpoint)(endpoint, invocation);
    }
    return this.options.invokeLocalAgentEndpoint(endpoint, invocation, hooks);
  }

  private completedEndpoint(
    runningEndpoint: AgentEndpoint,
    result: InvocationExecutorResult,
  ): AgentEndpoint {
    const prepared = promoteLocalEndpointProviderSession(runningEndpoint, {
      externalSessionId: "externalSessionId" in result ? result.externalSessionId : undefined,
      metadata: "metadata" in result && result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
        ? result.metadata as Record<string, unknown>
        : {},
    });

    return {
      ...prepared,
      metadata: {
        ...(prepared.metadata ?? {}),
        lastCompletedAt: this.now(),
      },
    };
  }

  private async handleExecutionError(input: {
    error: unknown;
    invocation: InvocationRequest;
    target: LocalInvocationTargetIdentity;
    runningEndpoint: AgentEndpoint;
    runningFlight: FlightRecord;
    priorEndpointState: AgentEndpoint["state"];
  }): Promise<void> {
    const {
      error,
      invocation,
      target,
      runningEndpoint,
      runningFlight,
      priorEndpointState,
    } = input;
    const message = error instanceof Error ? error.message : String(error);
    if (isCodexAppServerControlError(error) && error.submissionUnknown) {
      // The prompt may already have been accepted. Keep that uncertainty
      // durable and never turn a missing control reply into a replay decision.
      if (!this.currentFlightIsTerminal(invocation.id)) {
        await this.options.transitionInvocation(invocation.id, {
          state: "waiting",
          summary: `${target.displayName}'s submission is awaiting provider confirmation.`,
          error: message,
          completedAt: undefined,
          metadata: {
            dispatchOutcome: { status: "submission_unknown", reason: error.code, method: error.method, checkedAt: this.now() },
          },
        });
      }
      return;
    }
    if (isRequesterWaitTimeoutError(error)) {
      const currentFlight = this.options.runtime.flightForInvocation(invocation.id);
      if (currentFlight && isTerminalFlightState(currentFlight.state)) {
        return;
      }
      const postedReply = await this.options.existingBrokerReplyForInvocation(
        invocation,
        target.id,
        runningFlight.startedAt ?? this.now(),
      );
      if (this.currentFlightIsTerminal(invocation.id)) return;
      if (postedReply && await this.options.completeInvocationForBrokerReply(invocation, postedReply)) {
        return;
      }

      await this.options.transitionInvocation(invocation.id, {
        state: "running",
        summary: `${target.displayName} is still working.`,
        error: undefined,
        completedAt: undefined,
        metadata: {
          requesterTimedOut: true,
          timeoutMs: error.timeoutMs,
          timeoutScope: "requester_wait",
        },
      });
      this.options.warn?.(
        `[openscout-runtime] ${target.displayName} is still working; requester wait timed out after ${error.timeoutMs}ms.`,
      );
      return;
    }

    if (isDispatchStalledError(error)) {
      // A late transport error must not overwrite terminal truth another
      // writer already recorded (broker-reply completion, cancellation).
      // Endpoint bookkeeping below still records the transport failure.
      const stalledFlight = this.currentFlightIsTerminal(invocation.id)
        ? null
        : await this.options.transitionInvocation(invocation.id, {
          state: "failed",
          summary: `${target.displayName} dispatch stalled — prompt left in composer after submit + retry.`,
          error: message,
          completedAt: this.now(),
          metadata: {
            failureStage: "dispatch_stalled",
            dispatchStalledSession: error.sessionName,
            dispatchStalledRetries: error.retries,
            dispatchStalledPaneTail: error.paneTail.slice(0, 1_000),
          },
        });

      await this.options.persistEndpoint({
        ...runningEndpoint,
        // A stalled submit verification says nothing about endpoint liveness:
        // every tmux operation, including the final pane capture, succeeded.
        // Restore the state we replaced with "active" for this invocation and
        // leave offline transitions to an actual endpoint/session probe.
        state: priorEndpointState,
        metadata: {
          ...(runningEndpoint.metadata ?? {}),
          lastError: message,
          lastFailedAt: this.now(),
          lastFailureStage: "dispatch_stalled",
        },
      });

      if (stalledFlight) {
        await this.options.postInvocationStatusMessage(invocation, stalledFlight);
      }
      return;
    }

    if (isDeliveryBlockedError(error)) {
      // The process is alive; it just cannot take this ask. Fail the flight with
      // the reason and keep the endpoint routable, as for a stalled dispatch.
      const blockedFlight = this.currentFlightIsTerminal(invocation.id)
        ? null
        : await this.options.transitionInvocation(invocation.id, {
          state: "failed",
          summary: `${target.displayName}: ${error.summary}`,
          error: message,
          completedAt: this.now(),
          metadata: { failureStage: error.stage },
        });

      await this.options.persistEndpoint({
        ...runningEndpoint,
        state: priorEndpointState,
        metadata: {
          ...(runningEndpoint.metadata ?? {}),
          lastError: message,
          lastFailedAt: this.now(),
          lastFailureStage: error.stage,
        },
      });

      if (blockedFlight) {
        await this.options.postInvocationStatusMessage(invocation, blockedFlight);
      }
      return;
    }

    if (isCodexAppServerExitError(error) && error.noteworthy) {
      const interruptedAt = this.now();
      const failureStage = error.exitKind === "proactive_shutdown"
        ? "codex_app_server_proactive_shutdown"
        : "codex_app_server_sigterm";
      const summary = error.exitKind === "proactive_shutdown"
        ? `${target.displayName} was stopped by OpenScout before it could reply.`
        : `${target.displayName} was interrupted by a local Codex app-server SIGTERM.`;
      const interruptedFlight = this.currentFlightIsTerminal(invocation.id)
        ? null
        : await this.options.transitionInvocation(invocation.id, {
          state: "failed",
          summary,
          error: undefined,
          completedAt: interruptedAt,
          metadata: {
            failureStage,
            failureSeverity: "noteworthy",
            noteworthy: true,
            exitKind: error.exitKind,
            exitSignal: error.signal,
            exitCode: error.exitCode,
            ...(error.reason ? { shutdownReason: error.reason } : {}),
          },
        });

      await this.options.persistEndpoint({
        ...runningEndpoint,
        state: "offline",
        metadata: {
          ...(runningEndpoint.metadata ?? {}),
          lastNotice: message,
          lastInterruptedAt: interruptedAt,
          lastInterruptionStage: failureStage,
        },
      });

      if (interruptedFlight) {
        await this.options.postInvocationStatusMessage(invocation, interruptedFlight);
      }
      return;
    }

    if (isCodexThreadHeldExternallyError(error)) {
      const checkedAt = this.now();
      if (!this.currentFlightIsTerminal(invocation.id)) {
        await this.options.transitionInvocation(invocation.id, {
          state: "queued",
          summary: `${target.displayName}'s Codex thread is open in another app. Message stored; will deliver when the thread is released.`,
          error: undefined,
          completedAt: undefined,
          metadata: {
            dispatchOutcome: {
              status: "queued_until_online",
              reason: "thread_held_externally",
              checkedAt,
            },
            heldThreadId: error.threadId,
          },
        });
      }
      // Defer BEFORE persisting: restoring an online endpoint state fires the
      // queued-flight recovery hook, and without the deferral that hook would
      // redispatch this invocation immediately in a hot loop.
      this.options.deferInvocationRetry?.(invocation.id, checkedAt + HELD_THREAD_RETRY_DELAY_MS);
      // The session is not offline — it is open in another application. Keep
      // the endpoint at its pre-invocation state so future sends queue against
      // it instead of being refused, and record the true condition.
      await this.options.persistEndpoint({
        ...runningEndpoint,
        state: priorEndpointState,
        metadata: {
          ...(runningEndpoint.metadata ?? {}),
          lastNotice: message,
          threadHeldExternallyAt: checkedAt,
        },
      });
      return;
    }

    const failedFlight = this.currentFlightIsTerminal(invocation.id)
      ? null
      : await this.options.transitionInvocation(invocation.id, {
        state: "failed",
        summary: `${target.displayName} failed to respond.`,
        error: message,
        completedAt: this.now(),
      });

    await this.options.persistEndpoint({
      ...runningEndpoint,
      state: "offline",
      metadata: {
        ...(runningEndpoint.metadata ?? {}),
        lastError: message,
        lastFailedAt: this.now(),
      },
    });

    if (failedFlight) {
      await this.options.postInvocationStatusMessage(invocation, failedFlight);
    }
  }

  private currentFlightIsTerminal(invocationId: string): boolean {
    const current = this.options.runtime.flightForInvocation(invocationId);
    return Boolean(current && isTerminalFlightState(current.state));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function localInvocationTargetIdentity(
  targetId: string,
  agent: AgentDefinition | undefined,
  actor: ActorIdentity | undefined,
): LocalInvocationTargetIdentity {
  const target: LocalInvocationTargetIdentity = {
    id: targetId,
    displayName: agent?.displayName || actor?.displayName || targetId,
  };
  const handle = agent?.handle ?? actor?.handle;
  if (handle) target.handle = handle;
  if (agent?.definitionId) target.definitionId = agent.definitionId;
  if (agent?.selector) target.selector = agent.selector;
  if (agent?.defaultSelector) target.defaultSelector = agent.defaultSelector;
  return target;
}
