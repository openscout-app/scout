import {
  A2A_JSON_RPC_METHODS,
  A2A_LEGACY_JSON_RPC_METHODS,
  a2aAgentCardFromScoutCard,
  a2aTaskFromFlight,
  a2aTextFromMessage,
  a2aTaskStateFromFlightState,
  isA2ATerminalTaskState,
  type A2AAgentCard,
  type A2AJsonRpcRequest,
  type A2AJsonRpcResponse,
  type A2AListTasksParams,
  type A2AListTasksResult,
  type A2ASendMessageParams,
  type A2ATask,
  type A2ATaskIdParams,
  type A2ATaskState,
  type AgentDefinition,
  type FlightRecord,
  type InvocationRequest,
  type ScoutAgentCard,
} from "@openscout/protocol";

import type { LocalAgentBinding } from "./local-agents.js";
import { buildScoutAgentCard } from "./scout-agent-cards.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

type BrokerA2ARuntime = {
  snapshot(): RuntimeSnapshot;
  agent(agentId: string): AgentDefinition | undefined;
};

type ActiveInvocationTasks = {
  has(invocationId: string): boolean;
};

export type BrokerA2AServiceOptions = {
  nodeId: string;
  brokerUrl: string;
  runtime: BrokerA2ARuntime;
  knownInvocations: Map<string, InvocationRequest>;
  activeInvocationTasks: ActiveInvocationTasks;
  createId: (prefix: string) => string;
  acceptInvocation: (invocation: InvocationRequest) => Promise<FlightRecord>;
  dispatchInvocation: (invocation: InvocationRequest) => Promise<void>;
  recordFlight: (flight: FlightRecord) => Promise<void>;
  loadRegisteredLocalAgentBindings: (
    nodeId: string,
    options: { ensureOnline: false },
  ) => Promise<LocalAgentBinding[]>;
  sleep?: (ms: number) => Promise<void>;
  error?: (message: string, detail?: unknown) => void;
};

export function a2aJsonRpcResult<TResult>(
  id: A2AJsonRpcRequest["id"],
  result: TResult,
): A2AJsonRpcResponse<TResult> {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function a2aJsonRpcError(
  id: A2AJsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): A2AJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

export function a2aMethodIs(
  method: string,
  canonical: string,
  legacy?: string,
): boolean {
  return method === canonical || (legacy !== undefined && method === legacy);
}

function recordString(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordNumber(input: Record<string, unknown> | undefined, key: string): number | null {
  const value = input?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordBoolean(input: Record<string, unknown> | undefined, key: string): boolean | null {
  const value = input?.[key];
  return typeof value === "boolean" ? value : null;
}

function asMetadataRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

export function a2aTaskContextId(flight: FlightRecord, invocation: InvocationRequest | undefined): string {
  return invocation?.conversationId
    ?? recordString(invocation?.metadata, "a2aContextId")
    ?? recordString(flight.metadata, "a2aContextId")
    ?? flight.id;
}

export function a2aTaskForFlight(flight: FlightRecord, invocation: InvocationRequest | undefined): A2ATask {
  return a2aTaskFromFlight(flight, invocation, {
    contextId: a2aTaskContextId(flight, invocation),
    includeHistory: true,
  });
}

export function a2aRpcUrl(origin: string, agentId?: string): string {
  if (agentId) {
    return `${origin}/v1/a2a/agents/${encodeURIComponent(agentId)}/rpc`;
  }
  return `${origin}/a2a`;
}

export function buildOpenScoutA2ABrokerCard(input: {
  cards: ScoutAgentCard[];
  origin: string;
  nodeId: string;
  brokerUrl: string;
}): A2AAgentCard {
  const skills = input.cards.slice(0, 100).map((card) => ({
    id: card.agentId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || card.agentId,
    name: card.displayName,
    description: card.description ?? `Route work to ${card.displayName} through OpenScout.`,
    tags: ["openscout", card.harness, card.transport],
    inputModes: card.defaultInputModes?.length ? card.defaultInputModes : ["text/plain"],
    outputModes: card.defaultOutputModes?.length ? card.defaultOutputModes : ["text/plain"],
  }));

  return {
    protocolVersion: "1.0",
    name: "OpenScout Broker",
    description: "Local OpenScout broker router for registered Scout agents.",
    url: a2aRpcUrl(input.origin),
    preferredTransport: "JSONRPC",
    provider: {
      organization: "OpenScout",
      url: "https://openscout.app",
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
      extendedAgentCard: true,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: skills.length > 0 ? skills : [{
      id: "openscout-route",
      name: "OpenScout route",
      description: "Route text tasks to a registered OpenScout agent.",
      tags: ["openscout"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    }],
    supportedInterfaces: [
      {
        url: a2aRpcUrl(input.origin),
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        transport: "http",
        tenant: "openscout",
      },
    ],
    metadata: {
      scoutNodeId: input.nodeId,
      scoutBrokerUrl: input.brokerUrl,
      scoutAgentIds: input.cards.map((card) => card.agentId),
      complianceBoundary: "high-trust local pilot",
    },
  };
}

export function a2aTargetAgentId(params: A2ASendMessageParams, pathAgentId?: string): string | null {
  if (pathAgentId?.trim()) {
    return pathAgentId.trim();
  }
  const paramsRecord = params as unknown as Record<string, unknown>;
  const paramsMetadata = asMetadataRecord(params.metadata);
  const messageMetadata = asMetadataRecord(params.message?.metadata);
  return recordString(paramsRecord, "tenant")
    ?? recordString(paramsRecord, "targetAgentId")
    ?? recordString(paramsMetadata, "tenant")
    ?? recordString(paramsMetadata, "targetAgentId")
    ?? recordString(paramsMetadata, "scoutTargetAgentId")
    ?? recordString(messageMetadata, "tenant")
    ?? recordString(messageMetadata, "targetAgentId")
    ?? recordString(messageMetadata, "scoutTargetAgentId");
}

export function a2aBlockingTimeoutMs(params: A2ASendMessageParams): number {
  const configuration = asMetadataRecord(params.configuration);
  const paramsMetadata = asMetadataRecord(params.metadata);
  const timeout = recordNumber(configuration, "timeoutMs") ?? recordNumber(paramsMetadata, "timeoutMs");
  return timeout && timeout > 0 ? Math.min(timeout, 120_000) : 30_000;
}

function a2aTaskIdFromParams(params: unknown): string | null {
  const input = asMetadataRecord(params) as (A2ATaskIdParams & Record<string, unknown>) | undefined;
  return recordString(input, "id") ?? recordString(input, "taskId");
}

function normalizeA2AListLimit(input: A2AListTasksParams | undefined): number {
  const raw = input?.pageSize ?? input?.limit ?? 50;
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100) : 50;
}

function normalizeA2AListOffset(input: A2AListTasksParams | undefined): number {
  const token = input?.pageToken?.trim();
  if (!token) {
    return 0;
  }
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export class BrokerA2AService {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: BrokerA2AServiceOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  }

  async listScoutAgentCards(): Promise<ScoutAgentCard[]> {
    const bindings = await this.options.loadRegisteredLocalAgentBindings(this.options.nodeId, { ensureOnline: false });
    const local = bindings.map((binding) => buildScoutAgentCard(binding, { brokerRegistered: true }));
    const snapshot = this.options.runtime.snapshot();
    const external = Object.values(snapshot.agents)
      .filter((agent) => agent.metadata?.brokerRegistered === true)
      .map((agent) => {
        const endpoint = Object.values(snapshot.endpoints).find((candidate) => candidate.agentId === agent.id);
        return endpoint ? buildScoutAgentCard(
          {
            agent,
            endpoint,
            actor: snapshot.actors[agent.id] ?? { id: agent.id, kind: "agent", displayName: agent.displayName },
          },
          { brokerRegistered: true },
        ) : null;
      })
      .filter((card): card is ScoutAgentCard => Boolean(card));
    const deduped = new Map<string, ScoutAgentCard>();
    for (const card of [...local, ...external]) {
      deduped.set(card.agentId, card);
    }
    return [...deduped.values()];
  }

  async agentCardForRequest(origin: string, agentId?: string): Promise<A2AAgentCard | null> {
    const cards = await this.listScoutAgentCards();
    if (!agentId) {
      return buildOpenScoutA2ABrokerCard({
        cards,
        origin,
        nodeId: this.options.nodeId,
        brokerUrl: this.options.brokerUrl,
      });
    }
    const card = cards.find((candidate) => candidate.agentId === agentId || candidate.handle === agentId);
    if (!card) {
      return null;
    }
    return a2aAgentCardFromScoutCard(card, {
      url: a2aRpcUrl(origin, card.agentId),
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
        extendedAgentCard: true,
      },
    });
  }

  async handleJsonRpc(
    body: A2AJsonRpcRequest | null | undefined,
    origin: string,
    pathAgentId?: string,
  ): Promise<A2AJsonRpcResponse> {
    const id = body?.id ?? null;
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return a2aJsonRpcError(id, -32600, "Invalid JSON-RPC 2.0 request.");
    }

    try {
      if (a2aMethodIs(body.method, A2A_JSON_RPC_METHODS.sendMessage, A2A_LEGACY_JSON_RPC_METHODS.sendMessage)) {
        return a2aJsonRpcResult(id, { task: await this.handleSendMessage(body.params, pathAgentId) });
      }
      if (a2aMethodIs(body.method, A2A_JSON_RPC_METHODS.getTask, A2A_LEGACY_JSON_RPC_METHODS.getTask)) {
        return a2aJsonRpcResult(id, await this.handleGetTask(body.params));
      }
      if (a2aMethodIs(body.method, A2A_JSON_RPC_METHODS.listTasks, A2A_LEGACY_JSON_RPC_METHODS.listTasks)) {
        return a2aJsonRpcResult(id, await this.handleListTasks(body.params, pathAgentId));
      }
      if (a2aMethodIs(body.method, A2A_JSON_RPC_METHODS.cancelTask, A2A_LEGACY_JSON_RPC_METHODS.cancelTask)) {
        return a2aJsonRpcResult(id, await this.handleCancelTask(body.params));
      }
      if (a2aMethodIs(body.method, A2A_JSON_RPC_METHODS.getExtendedAgentCard, A2A_LEGACY_JSON_RPC_METHODS.getExtendedAgentCard)) {
        const card = await this.agentCardForRequest(origin, pathAgentId);
        if (!card) {
          return a2aJsonRpcError(id, -32001, `A2A agent card not found: ${pathAgentId ?? "openscout"}`);
        }
        return a2aJsonRpcResult(id, card);
      }
      if (
        body.method === A2A_JSON_RPC_METHODS.sendStreamingMessage
        || body.method === A2A_LEGACY_JSON_RPC_METHODS.sendStreamingMessage
        || body.method === A2A_JSON_RPC_METHODS.subscribeToTask
        || body.method === A2A_LEGACY_JSON_RPC_METHODS.subscribeToTask
      ) {
        return a2aJsonRpcError(id, -32005, "A2A streaming is not enabled on this high-trust local broker endpoint yet.");
      }
      if (
        body.method === A2A_JSON_RPC_METHODS.createTaskPushNotificationConfig
        || body.method === A2A_JSON_RPC_METHODS.getTaskPushNotificationConfig
        || body.method === A2A_JSON_RPC_METHODS.listTaskPushNotificationConfigs
        || body.method === A2A_JSON_RPC_METHODS.deleteTaskPushNotificationConfig
      ) {
        return a2aJsonRpcError(id, -32005, "A2A push notification configuration is not enabled on this high-trust local broker endpoint yet.");
      }
      return a2aJsonRpcError(id, -32601, `A2A method not found: ${body.method}`);
    } catch (error) {
      const withCode = error as Error & { code?: number; data?: unknown };
      return a2aJsonRpcError(
        id,
        typeof withCode.code === "number" ? withCode.code : -32603,
        withCode.message || "A2A request failed.",
        withCode.data,
      );
    }
  }

  private async waitForTask(
    flight: FlightRecord,
    invocation: InvocationRequest,
    timeoutMs: number,
  ): Promise<A2ATask> {
    const deadline = Date.now() + timeoutMs;
    let current = flight;
    while (Date.now() < deadline) {
      current = this.options.runtime.snapshot().flights[flight.id] ?? current;
      const state = a2aTaskStateFromFlightState(current.state);
      if (isA2ATerminalTaskState(state) || state === "TASK_STATE_INPUT_REQUIRED") {
        return a2aTaskForFlight(current, invocation);
      }
      await this.sleep(100);
    }
    return a2aTaskForFlight(this.options.runtime.snapshot().flights[flight.id] ?? current, invocation);
  }

  private async handleSendMessage(
    params: unknown,
    pathAgentId?: string,
  ): Promise<A2ATask> {
    const input = asMetadataRecord(params) as A2ASendMessageParams | undefined;
    if (!input?.message) {
      throw Object.assign(new Error("SendMessage requires params.message."), {
        code: -32602,
      });
    }

    const targetAgentId = a2aTargetAgentId(input, pathAgentId);
    if (!targetAgentId) {
      throw Object.assign(new Error("A2A SendMessage requires a target agent id via the per-agent endpoint, tenant, targetAgentId, or scoutTargetAgentId."), {
        code: -32602,
      });
    }
    const agent = this.options.runtime.agent(targetAgentId);
    if (!agent) {
      throw Object.assign(new Error(`A2A target agent not found: ${targetAgentId}`), {
        code: -32001,
        data: { targetAgentId },
      });
    }

    const task = a2aTextFromMessage(input.message);
    if (!task) {
      throw Object.assign(new Error("A2A SendMessage requires at least one text part."), {
        code: -32602,
      });
    }

    const messageMetadata = asMetadataRecord(input.message.metadata);
    const contextId = input.message.contextId?.trim()
      ?? recordString(messageMetadata, "a2aContextId")
      ?? undefined;
    const invocation: InvocationRequest = {
      origin: { source: "unknown" },
      id: this.options.createId("a2a-inv"),
      requesterId: recordString(messageMetadata, "scoutRequesterId") ?? "a2a-client",
      requesterNodeId: this.options.nodeId,
      targetAgentId: agent.id,
      action: "consult",
      task,
      ...(contextId ? { conversationId: contextId } : {}),
      messageId: input.message.messageId,
      ensureAwake: true,
      stream: false,
      timeoutMs: a2aBlockingTimeoutMs(input),
      labels: ["a2a"],
      createdAt: Date.now(),
      metadata: {
        ...(asMetadataRecord(input.metadata) ?? {}),
        a2aContextId: contextId,
        a2aMessageId: input.message.messageId,
        a2aRole: input.message.role,
        a2aProtocolVersion: "1.0",
      },
    };

    const flight = await this.options.acceptInvocation(invocation);
    this.options.dispatchInvocation(invocation).catch((error) => {
      this.options.error?.(
        `[openscout-runtime] A2A dispatch failed for invocation ${invocation.id}:`,
        error,
      );
    });

    const blocking = recordBoolean(asMetadataRecord(input.configuration), "blocking") === true;
    return blocking
      ? this.waitForTask(flight, invocation, a2aBlockingTimeoutMs(input))
      : a2aTaskForFlight(flight, invocation);
  }

  private taskById(taskId: string): { flight: FlightRecord; invocation: InvocationRequest | undefined } | null {
    const snapshot = this.options.runtime.snapshot();
    const flight = snapshot.flights[taskId];
    if (!flight) {
      return null;
    }
    return {
      flight,
      invocation: snapshot.invocations[flight.invocationId] ?? this.options.knownInvocations.get(flight.invocationId),
    };
  }

  private async handleGetTask(params: unknown): Promise<A2ATask> {
    const taskId = a2aTaskIdFromParams(params);
    if (!taskId) {
      throw Object.assign(new Error("GetTask requires params.id or params.taskId."), {
        code: -32602,
      });
    }
    const found = this.taskById(taskId);
    if (!found) {
      throw Object.assign(new Error(`A2A task not found: ${taskId}`), {
        code: -32001,
        data: { taskId },
      });
    }
    return a2aTaskForFlight(found.flight, found.invocation);
  }

  private async handleListTasks(
    params: unknown,
    pathAgentId?: string,
  ): Promise<A2AListTasksResult> {
    const input = asMetadataRecord(params) as A2AListTasksParams | undefined;
    const limit = normalizeA2AListLimit(input);
    const offset = normalizeA2AListOffset(input);
    const snapshot = this.options.runtime.snapshot();
    const state = input?.state as A2ATaskState | undefined;
    const rows = Object.values(snapshot.flights)
      .map((flight) => ({
        flight,
        invocation: snapshot.invocations[flight.invocationId] ?? this.options.knownInvocations.get(flight.invocationId),
      }))
      .filter(({ flight, invocation }) => (
        (!pathAgentId || flight.targetAgentId === pathAgentId)
        && (!input?.contextId || a2aTaskContextId(flight, invocation) === input.contextId)
        && (!state || a2aTaskStateFromFlightState(flight.state) === state)
      ))
      .sort((left, right) => (right.flight.startedAt ?? 0) - (left.flight.startedAt ?? 0));
    const page = rows.slice(offset, offset + limit);
    return {
      tasks: page.map(({ flight, invocation }) => a2aTaskForFlight(flight, invocation)),
      pageSize: limit,
      totalSize: rows.length,
      ...(offset + limit < rows.length ? { nextPageToken: String(offset + limit) } : {}),
    };
  }

  private async handleCancelTask(params: unknown): Promise<A2ATask> {
    const taskId = a2aTaskIdFromParams(params);
    if (!taskId) {
      throw Object.assign(new Error("CancelTask requires params.id or params.taskId."), {
        code: -32602,
      });
    }
    const found = this.taskById(taskId);
    if (!found) {
      throw Object.assign(new Error(`A2A task not found: ${taskId}`), {
        code: -32001,
        data: { taskId },
      });
    }
    const state = a2aTaskStateFromFlightState(found.flight.state);
    if (isA2ATerminalTaskState(state)) {
      return a2aTaskForFlight(found.flight, found.invocation);
    }
    if (found.flight.state !== "queued" || this.options.activeInvocationTasks.has(found.flight.invocationId)) {
      throw Object.assign(new Error(`A2A task ${taskId} is already running and cannot be cancelled by the broker yet.`), {
        code: -32004,
        data: { taskId, state },
      });
    }

    const completedAt = Date.now();
    const cancelled: FlightRecord = {
      ...found.flight,
      state: "cancelled",
      summary: "A2A client cancelled the task before it started running.",
      completedAt,
      metadata: {
        ...(found.flight.metadata ?? {}),
        a2aCancelledAt: completedAt,
      },
    };
    await this.options.recordFlight(cancelled);
    return a2aTaskForFlight(cancelled, found.invocation);
  }
}
