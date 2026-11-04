import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";

import type {
  ActorIdentity,
  AgentBrokerFeed,
  AgentDefinition,
  AgentEndpoint,
  CollaborationEvent,
  CollaborationRecord,
  ControlCommand,
  ConversationBinding,
  ConversationDefinition,
  ConversationProjectionSnapshot,
  InvocationRequest,
  MessageReactionRecord,
  MessageRecord,
  NodeDefinition,
  ScoutCapabilityAvailabilityDecision,
  ScoutCapabilityMatrixSnapshot,
  ScoutDeliverRequest,
  ScoutDeliverResponse,
  ThreadEventEnvelope,
  ThreadSnapshot,
  ThreadWatchCloseRequest,
  ThreadWatchOpenRequest,
  ThreadWatchOpenResponse,
  ThreadWatchRenewRequest,
  ThreadWatchRenewResponse,
} from "@openscout/protocol";

import type { RuntimeRegistrySnapshot, RuntimeRegistrySnapshotQuery, RuntimeNotificationRoutingSnapshot } from "./registry.js";
import type { BrokerRouteTargetInput } from "./scout-dispatcher.js";
import type { InvocationLifecycleSummary } from "./invocation-lifecycle-read-model.js";
import type { BrokerRuntimeCatalogSnapshot } from "./broker-runtime-catalog-service.js";

export type ScoutBrokerBuildIdentity = {
  packageName: string;
  version: string | null;
  commit?: string | null;
  branch?: string | null;
  buildId?: string | null;
  buildNumber?: string | null;
  mode?: "dev" | "production";
};

export type ScoutBrokerChildServiceState =
  | "running"
  | "starting"
  | "stopped"
  | "unknown"
  | "unavailable";

export type ScoutBrokerChildServiceSnapshot = {
  /** Explicit start intent, even when a child could not be spawned. */
  expected?: boolean;
  state: ScoutBrokerChildServiceState;
  managed: boolean;
  managedBy?: "broker" | "web" | "base" | "external" | "unknown";
  pid?: number | null;
  port?: number | null;
  url?: string | null;
  healthy?: boolean | null;
  recovery?: import("./broker-web-control-service.js").WebRecoveryStatus;
  detail?: string | null;
};

export type ScoutBrokerChildServiceSnapshots = {
  web?: ScoutBrokerChildServiceSnapshot;
  terminalRelay?: ScoutBrokerChildServiceSnapshot;
  localEdge?: ScoutBrokerChildServiceSnapshot;
  [name: string]: ScoutBrokerChildServiceSnapshot | undefined;
};

export type ScoutBrokerProjectionStatus = {
  state: "ready" | "warming" | "degraded" | "disabled";
  detail: string | null;
};

export type ScoutBrokerStartupStatus = import("./broker-startup-traffic-gate.js").BrokerStartupTrafficGateSnapshot;

/** Whether the broker can write. `ok` on health stays liveness; this says if writes land. */
export type ScoutBrokerStorageStatus = {
  journal: import("./broker-journal.js").BrokerJournalWriteStatus;
};

export type ScoutBrokerHealthPayload = {
  ok: boolean;
  nodeId: string | null;
  meshId: string | null;
  build?: ScoutBrokerBuildIdentity;
  services?: ScoutBrokerChildServiceSnapshots;
  projection?: ScoutBrokerProjectionStatus;
  startup?: ScoutBrokerStartupStatus;
  storage?: ScoutBrokerStorageStatus;
  counts: {
    nodes: number;
    actors: number;
    /** Operator-facing top-level agent count. Raw storage count is `agentRecords`. */
    agents: number;
    agentRecords?: number;
    rawAgentRecords?: number;
    configuredAgents?: number;
    scoutManagedAgents?: number;
    currentAgentRegistrations?: number;
    localAgentRegistrations?: number;
    remoteAgentRegistrations?: number;
    staleAgentRegistrations?: number;
    retiredAgentRegistrations?: number;
    oneTimeAgentCards?: number;
    persistentAgentCards?: number;
    conversations: number;
    /** Null until historical membership is fully covered. */
    messages: number | null;
    flights: number;
    collaborationRecords: number;
  } | null;
};

export type ScoutBrokerJsonRequestTrace = {
  transport: "unix_socket" | "http";
  socketPath?: string;
  socketFallbackError?: string;
};

export type ScoutBrokerJsonWithTrace<T> = {
  value: T;
  trace: ScoutBrokerJsonRequestTrace;
};

export type ScoutBrokerMessageQuery = {
  conversationId?: string;
  participantId?: string;
  inboxOnly?: boolean;
  since?: number | null;
  limit?: number;
};

export type ScoutBrokerAgentFeedQuery = {
  agentId: string;
  since?: number | null;
  limit?: number;
  includeAcknowledged?: boolean;
};

export type ScoutBrokerActivityQuery = {
  agentId?: string;
  actorId?: string;
  conversationId?: string;
  limit?: number;
};

export type ScoutBrokerConversationProjectionQuery = {
  limit?: number;
};

export type ScoutBrokerCollaborationRecordQuery = {
  conversationId?: string;
  includeThreads?: boolean;
  orderByCreatedAt?: boolean;
  afterCreatedAt?: number;
  afterId?: string;
  kind?: string;
  state?: string;
  ownerId?: string;
  nextMoveOwnerId?: string;
  limit?: number;
};

export type ScoutBrokerCollaborationEventQuery = {
  recordId?: string;
  limit?: number;
};

export type ScoutBrokerThreadEventQuery = {
  conversationId: string;
  afterSeq?: number;
  limit?: number;
};

export type ScoutBrokerInvocationLifecycleQuery = {
  invocationId: string;
};

export type ScoutBrokerCapabilitiesQuery = {
  force?: boolean;
};

export type ScoutBrokerCapabilityAvailabilityQuery = {
  capabilityId: string;
  methodName?: string;
  requireReady?: boolean;
  force?: boolean;
};

export type ActiveScoutBrokerService = {
  /** Local assistant answerer leases; never included in snapshots. */
  assistantClaims?: import("./broker-assistant-claims.js").BrokerAssistantClaims;
  baseUrl: string;
  matchesBaseUrl?: (baseUrl: string) => boolean;
  readHealth: () => Promise<ScoutBrokerHealthPayload>;
  readHome?: () => Promise<unknown>;
  /** Observe-tier compact node state; absent on brokers that predate it. */
  readMeshNodeState?: (query?: import("./mesh-node-state.js").MeshNodeStateQuery) => Promise<unknown> | unknown;
  readNode: () => Promise<NodeDefinition>;
  readSnapshot: (query?: RuntimeRegistrySnapshotQuery) => Promise<RuntimeRegistrySnapshot>;
  readNotificationRouting?: () => Promise<RuntimeNotificationRoutingSnapshot>;
  withSnapshot?: <T>(query:RuntimeRegistrySnapshotQuery,consume:(snapshot:RuntimeRegistrySnapshot)=>Promise<T>,options?:{signal?:AbortSignal})=>Promise<T>;
  readConversationProjection?: (
    query: ScoutBrokerConversationProjectionQuery,
  ) => Promise<ConversationProjectionSnapshot | null>;
  readCapabilities?: (
    query?: ScoutBrokerCapabilitiesQuery,
  ) => Promise<ScoutCapabilityMatrixSnapshot>;
  readRuntimeCatalog?: (
    query?: ScoutBrokerCapabilitiesQuery,
  ) => Promise<BrokerRuntimeCatalogSnapshot>;
  readCapabilityAvailability?: (
    query: ScoutBrokerCapabilityAvailabilityQuery,
  ) => Promise<ScoutCapabilityAvailabilityDecision>;
  readMessages?: (
    query: ScoutBrokerMessageQuery,
  ) => Promise<MessageRecord[]>;
  readAgentBrokerFeed?: (
    query: ScoutBrokerAgentFeedQuery,
  ) => Promise<AgentBrokerFeed>;
  readInvocationLifecycle?: (
    query: ScoutBrokerInvocationLifecycleQuery,
  ) => Promise<InvocationLifecycleSummary | null>;
  readActivity?: (query: ScoutBrokerActivityQuery) => Promise<unknown>;
  readCollaborationRecords?: (
    query: ScoutBrokerCollaborationRecordQuery,
  ) => Promise<unknown>;
  readCollaborationEvents?: (
    query: ScoutBrokerCollaborationEventQuery,
  ) => Promise<unknown>;
  readThreadEvents?: (
    query: ScoutBrokerThreadEventQuery,
  ) => Promise<ThreadEventEnvelope[]>;
  readThreadSnapshot?: (conversationId: string) => Promise<ThreadSnapshot>;
  openThreadWatch?: (
    request: ThreadWatchOpenRequest,
  ) => Promise<ThreadWatchOpenResponse>;
  renewThreadWatch?: (
    request: ThreadWatchRenewRequest,
  ) => Promise<ThreadWatchRenewResponse>;
  closeThreadWatch?: (
    request: ThreadWatchCloseRequest,
  ) => Promise<{ ok: boolean; watchId: string }>;
  executeCommand: (command: ControlCommand) => Promise<unknown>;
  postConversationMessage?: (message: MessageRecord) => Promise<unknown>;
  upsertMessageReaction?: (input: {
    channelId: string;
    messageId: string;
    actorId: string;
    emoji: string;
    createdAt: number;
  }) => Promise<{ replayed: boolean }>;
  removeMessageReaction?: (input: {
    channelId: string;
    messageId: string;
    actorId: string;
    emoji: string;
  }) => Promise<{ replayed: boolean }>;
  listMessageReactions?: (channelId: string) => Promise<MessageReactionRecord[]>;
  deliver?: (
    request: ScoutDeliverRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<ScoutDeliverResponse>;
  invokeAgent?: (
    request: InvocationRequest & BrokerRouteTargetInput,
  ) => Promise<unknown>;
};

export type ActiveScoutBrokerServiceResult<T> =
  | { handled: false }
  | { handled: true; value: T };

export type ScoutBrokerJsonRequestOptions<T> = {
  // Both transports (fetch and the unix-socket http client) pass the verb
  // straight through, so this list is a contract choice, not a limitation.
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  socketPath?: string | null;
  signal?: AbortSignal;
  acceptErrorJson?: (value: unknown) => value is T;
};

type ScoutBrokerWireResponse = {
  ok: boolean;
  status: number;
  text: string;
};

type ScoutBrokerWireResult = {
  response: ScoutBrokerWireResponse;
  trace: ScoutBrokerJsonRequestTrace;
};

const activeScoutBrokerServices: ActiveScoutBrokerService[] = [];
const DEFAULT_BROKER_JSON_REQUEST_TIMEOUT_MS = 30_000;

function handled<T>(value: T): ActiveScoutBrokerServiceResult<T> {
  return { handled: true, value };
}

function unhandled<T>(): ActiveScoutBrokerServiceResult<T> {
  return { handled: false };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function requestHeaders(options: ScoutBrokerJsonRequestOptions<any>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined && !("content-type" in lowercaseKeys(headers))) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

function lowercaseKeys(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    result[key.toLowerCase()] = value[key] ?? "";
  }
  return result;
}

function requestBody(options: ScoutBrokerJsonRequestOptions<any>): string | undefined {
  return options.body === undefined ? undefined : JSON.stringify(options.body);
}

async function requestBrokerOverHttp<T>(
  baseUrl: string,
  path: string,
  options: ScoutBrokerJsonRequestOptions<T>,
): Promise<ScoutBrokerWireResponse> {
  const response = await fetch(new URL(path, normalizeBaseUrl(baseUrl)), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: requestHeaders(options),
    body: requestBody(options),
    signal: options.signal,
  });
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
}

function shouldFallbackFromUnixSocket(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "ENOENT"
    || code === "ECONNREFUSED"
    || code === "ENOTSOCK"
    || code === "EACCES"
    || code === "EINVAL"
    || code === "FailedToOpenSocket";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestBrokerOverUnixSocket<T>(
  socketPath: string,
  baseUrl: string,
  path: string,
  options: ScoutBrokerJsonRequestOptions<T>,
): Promise<ScoutBrokerWireResponse> {
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      reject(Object.assign(new Error(`Scout broker socket does not exist: ${socketPath}`), { code: "ENOENT" }));
      return;
    }

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const url = new URL(path, normalizedBaseUrl);
    const body = requestBody(options);
    const headers = requestHeaders(options);
    if (body !== undefined) {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }

    let settled = false;
    const cleanupAbortListener = () => {
      options.signal?.removeEventListener("abort", handleAbort);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanupAbortListener();
      reject(error);
    };

    const request = httpRequest(
      {
        socketPath,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("aborted", () => {
          rejectOnce(new Error("Scout broker response aborted"));
        });
        response.on("error", rejectOnce);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          cleanupAbortListener();
          resolve({
            ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    const handleAbort = () => {
      const error = options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("Scout broker request aborted");
      rejectOnce(error);
      request.destroy(error);
    };

    request.on("error", rejectOnce);
    if (options.signal) {
      if (options.signal.aborted) {
        handleAbort();
        return;
      }
      options.signal.addEventListener("abort", handleAbort, { once: true });
    }
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

function defaultBrokerRequestSignal(options: ScoutBrokerJsonRequestOptions<unknown>): AbortSignal {
  return options.signal ?? AbortSignal.timeout(DEFAULT_BROKER_JSON_REQUEST_TIMEOUT_MS);
}

async function requestBrokerWire<T>(
  baseUrl: string,
  path: string,
  options: ScoutBrokerJsonRequestOptions<T>,
): Promise<ScoutBrokerWireResult> {
  const requestOptions = {
    ...options,
    signal: defaultBrokerRequestSignal(options),
  };
  const socketOnly = process.env.OPENSCOUT_BROKER_SOCKET_ONLY === "1";
  const socketPath = options.socketPath?.trim();
  if (socketOnly && !socketPath) throw new Error("Scout broker socket-only request has no socket path");
  if (socketPath) {
    try {
      return {
        response: await requestBrokerOverUnixSocket(socketPath, baseUrl, path, requestOptions),
        trace: {
          transport: "unix_socket",
          socketPath,
        },
      };
    } catch (error) {
      if (socketOnly || !shouldFallbackFromUnixSocket(error)) {
        throw error;
      }
      return {
        response: await requestBrokerOverHttp(baseUrl, path, requestOptions),
        trace: {
          transport: "http",
          socketPath,
          socketFallbackError: `${socketPath}: ${errorMessage(error)}`,
        },
      };
    }
  }
  return {
    response: await requestBrokerOverHttp(baseUrl, path, requestOptions),
    trace: {
      transport: "http",
    },
  };
}

/** A completed HTTP response is evidence of reachability, even on failure. */
export class ScoutBrokerHttpError extends Error {
  constructor(
    public readonly status: number,
    path: string,
    /** Raw response text, including non-JSON and empty bodies. */
    public readonly body: string,
    /** Machine-readable top-level JSON `error` token, or absent.
     * Supplied by the request helper when present. */
    public readonly code?: string,
  ) {
    super(`${path} returned ${status}: ${body}`);
    this.name = "ScoutBrokerHttpError";
  }
}

export async function requestScoutBrokerJsonWithTrace<T>(
  baseUrl: string,
  path: string,
  options: ScoutBrokerJsonRequestOptions<T> = {},
): Promise<ScoutBrokerJsonWithTrace<T>> {
  const { response, trace } = await requestBrokerWire(baseUrl, path, options);
  let parsed: unknown;
  let parsedJson = false;
  if (response.text.length > 0) {
    try {
      parsed = JSON.parse(response.text);
      parsedJson = true;
    } catch {
      parsedJson = false;
    }
  }

  if (!response.ok) {
    if (parsedJson && options.acceptErrorJson?.(parsed)) {
      return { value: parsed, trace };
    }
    // The census includes t3_* codes. The final assertion pins end-of-input,
    // even if a future edit adds the multiline flag.
    const code = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && Object.hasOwn(parsed, "error") && "error" in parsed && typeof parsed.error === "string"
      && /^[a-z_][a-z0-9_]{0,127}(?![\s\S])/.test(parsed.error)
      ? parsed.error : undefined;
    throw new ScoutBrokerHttpError(response.status, path, response.text, code);
  }

  if (parsedJson) {
    return { value: parsed as T, trace };
  }
  return { value: undefined as T, trace };
}

export async function requestScoutBrokerJson<T>(
  baseUrl: string,
  path: string,
  options: ScoutBrokerJsonRequestOptions<T> = {},
): Promise<T> {
  const { value } = await requestScoutBrokerJsonWithTrace(baseUrl, path, options);
  return value;
}

function parsePositiveInt(
  value: string | null | undefined,
  fallback?: number,
): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseLimit(value: string | null | undefined): number {
  const parsed = parsePositiveInt(value, 100) ?? 100;
  return Math.min(parsed, 500);
}

function parseBoolean(value: string | null | undefined): boolean | undefined {
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return undefined;
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getActiveServiceForBaseUrl(
  baseUrl: string,
): ActiveScoutBrokerService | null {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  for (let index = activeScoutBrokerServices.length - 1; index >= 0; index -= 1) {
    const service = activeScoutBrokerServices[index];
    if (!service) {
      continue;
    }
    if (typeof service.matchesBaseUrl === "function") {
      if (service.matchesBaseUrl(normalizedBaseUrl)) {
        return service;
      }
      continue;
    }
    if (normalizeBaseUrl(service.baseUrl) === normalizedBaseUrl) {
      return service;
    }
  }
  return null;
}

export function registerActiveScoutBrokerService(
  service: ActiveScoutBrokerService | null,
): void {
  if (!service) {
    activeScoutBrokerServices.length = 0;
    return;
  }

  const normalizedBaseUrl = normalizeBaseUrl(service.baseUrl);
  const existingIndex = activeScoutBrokerServices.findIndex((candidate) =>
    candidate === service
      || normalizeBaseUrl(candidate.baseUrl) === normalizedBaseUrl
  );
  if (existingIndex >= 0) {
    activeScoutBrokerServices[existingIndex] = service;
    return;
  }

  activeScoutBrokerServices.push(service);
}

export function unregisterActiveScoutBrokerService(
  serviceOrBaseUrl?: ActiveScoutBrokerService | string | null,
): void {
  if (!serviceOrBaseUrl) {
    activeScoutBrokerServices.length = 0;
    return;
  }

  const normalizedBaseUrl = normalizeBaseUrl(
    typeof serviceOrBaseUrl === "string"
      ? serviceOrBaseUrl
      : serviceOrBaseUrl.baseUrl,
  );

  for (let index = activeScoutBrokerServices.length - 1; index >= 0; index -= 1) {
    const service = activeScoutBrokerServices[index];
    if (
      service === serviceOrBaseUrl
      || normalizeBaseUrl(service.baseUrl) === normalizedBaseUrl
    ) {
      activeScoutBrokerServices.splice(index, 1);
    }
  }
}

export function getActiveScoutBrokerService(
  baseUrl?: string,
): ActiveScoutBrokerService | null {
  if (!baseUrl) {
    return activeScoutBrokerServices[activeScoutBrokerServices.length - 1] ?? null;
  }
  return getActiveServiceForBaseUrl(baseUrl);
}

export async function maybeReadJsonFromActiveScoutBrokerService<T>(
  baseUrl: string,
  path: string,
): Promise<ActiveScoutBrokerServiceResult<T>> {
  const service = getActiveServiceForBaseUrl(baseUrl);
  if (!service) {
    return unhandled();
  }

  const url = new URL(path, normalizeBaseUrl(baseUrl));

  if (url.pathname === "/health") {
    return handled(await service.readHealth() as T);
  }

  if (url.pathname === "/v1/home") {
    if (!service.readHome) {
      return unhandled();
    }
    return handled(await service.readHome() as T);
  }

  if (url.pathname === "/v1/node") {
    return handled(await service.readNode() as T);
  }

  if (url.pathname === "/v1/snapshot") {
    const requestedScope = url.searchParams.get("scope");
    return handled(await service.readSnapshot({
      since: parsePositiveInt(url.searchParams.get("since")) ?? null,
      scope: requestedScope === "conversations" || requestedScope === "agents" || requestedScope === "identity"
        ? requestedScope
        : undefined,
    }) as T);
  }

  if (url.pathname === "/v1/notification-routing") {
    if (!service.readNotificationRouting) return unhandled();
    return handled(await service.readNotificationRouting() as T);
  }

  if (url.pathname === "/v1/conversation-projection") {
    if (!service.readConversationProjection) {
      return unhandled();
    }
    return handled(await service.readConversationProjection({
      limit: parseLimit(url.searchParams.get("limit")),
    }) as T);
  }

  if (url.pathname === "/v1/capabilities") {
    if (!service.readCapabilities) {
      return unhandled();
    }
    return handled(await service.readCapabilities({
      force: parseBoolean(url.searchParams.get("force")),
    }) as T);
  }

  if (url.pathname === "/v1/capabilities/availability") {
    if (!service.readCapabilityAvailability) {
      return unhandled();
    }
    const capabilityId = trimOrUndefined(url.searchParams.get("capabilityId"));
    if (!capabilityId) {
      return unhandled();
    }
    return handled(await service.readCapabilityAvailability({
      capabilityId,
      methodName: trimOrUndefined(url.searchParams.get("methodName")),
      requireReady: parseBoolean(url.searchParams.get("requireReady")),
      force: parseBoolean(url.searchParams.get("force")),
    }) as T);
  }

  if (url.pathname === "/v1/messages") {
    if (!service.readMessages) {
      return unhandled();
    }
    return handled(await service.readMessages({
      conversationId: trimOrUndefined(url.searchParams.get("conversationId")),
      participantId: trimOrUndefined(url.searchParams.get("participantId")),
      inboxOnly: url.searchParams.get("inboxOnly") === "1",
      since: parsePositiveInt(url.searchParams.get("since")) ?? null,
      limit: parseLimit(url.searchParams.get("limit")),
    }) as T);
  }

  if (url.pathname === "/v1/broker/messages") {
    if (!service.readAgentBrokerFeed) {
      return unhandled();
    }
    const agentId = trimOrUndefined(url.searchParams.get("agentId"));
    if (!agentId) {
      return unhandled();
    }
    return handled(await service.readAgentBrokerFeed({
      agentId,
      since: parsePositiveInt(url.searchParams.get("since")) ?? null,
      limit: parseLimit(url.searchParams.get("limit")),
      includeAcknowledged: url.searchParams.get("includeAcknowledged") === "1"
        || url.searchParams.get("includeAcknowledged") === "true",
    }) as T);
  }

  const invocationLifecycleMatch = url.pathname.match(
    /^\/v1\/invocations\/([^/]+)\/lifecycle$/,
  );
  if (invocationLifecycleMatch) {
    if (!service.readInvocationLifecycle) {
      return unhandled();
    }
    return handled(await service.readInvocationLifecycle({
      invocationId: decodeURIComponent(invocationLifecycleMatch[1] ?? ""),
    }) as T);
  }

  if (url.pathname === "/v1/activity") {
    if (!service.readActivity) {
      return unhandled();
    }
    return handled(await service.readActivity({
      agentId: trimOrUndefined(url.searchParams.get("agentId")),
      actorId: trimOrUndefined(url.searchParams.get("actorId")),
      conversationId: trimOrUndefined(url.searchParams.get("conversationId")),
      limit: parseLimit(url.searchParams.get("limit")),
    }) as T);
  }

  if (url.pathname === "/v1/collaboration/records") {
    if (!service.readCollaborationRecords) {
      return unhandled();
    }
    return handled(await service.readCollaborationRecords({
      conversationId: trimOrUndefined(url.searchParams.get("conversationId")),
      includeThreads: url.searchParams.get("includeThreads") === "true",
      orderByCreatedAt: url.searchParams.get("orderByCreatedAt") === "true",
      afterCreatedAt: url.searchParams.has("afterCreatedAt") ? Number(url.searchParams.get("afterCreatedAt")) : undefined,
      afterId: trimOrUndefined(url.searchParams.get("afterId")),
      kind: trimOrUndefined(url.searchParams.get("kind")),
      state: trimOrUndefined(url.searchParams.get("state")),
      ownerId: trimOrUndefined(url.searchParams.get("ownerId")),
      nextMoveOwnerId: trimOrUndefined(
        url.searchParams.get("nextMoveOwnerId"),
      ),
      limit: parseLimit(url.searchParams.get("limit")),
    }) as T);
  }

  if (url.pathname === "/v1/collaboration/events") {
    if (!service.readCollaborationEvents) {
      return unhandled();
    }
    return handled(await service.readCollaborationEvents({
      recordId: trimOrUndefined(url.searchParams.get("recordId")),
      limit: parseLimit(url.searchParams.get("limit")),
    }) as T);
  }

  const threadEventsMatch = url.pathname.match(
    /^\/v1\/conversations\/([^/]+)\/thread-events$/,
  );
  if (threadEventsMatch) {
    if (!service.readThreadEvents) {
      return unhandled();
    }
    return handled(await service.readThreadEvents({
      conversationId: decodeURIComponent(threadEventsMatch[1] ?? ""),
      afterSeq: parsePositiveInt(url.searchParams.get("afterSeq")) ?? 0,
      limit: parseLimit(url.searchParams.get("limit")),
    }) as T);
  }

  const threadSnapshotMatch = url.pathname.match(
    /^\/v1\/conversations\/([^/]+)\/thread-snapshot$/,
  );
  if (threadSnapshotMatch) {
    if (!service.readThreadSnapshot) {
      return unhandled();
    }
    return handled(await service.readThreadSnapshot(
      decodeURIComponent(threadSnapshotMatch[1] ?? ""),
    ) as T);
  }

  return unhandled();
}

export async function maybePostJsonToActiveScoutBrokerService<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<ActiveScoutBrokerServiceResult<T>> {
  const service = getActiveServiceForBaseUrl(baseUrl);
  if (!service) {
    return unhandled();
  }

  const url = new URL(path, normalizeBaseUrl(baseUrl));

  if (url.pathname === "/v1/commands") {
    return handled(await service.executeCommand(body as ControlCommand) as T);
  }

  if (url.pathname === "/v1/nodes") {
    const node = body as NodeDefinition;
    await service.executeCommand({ kind: "node.upsert", node });
    return handled({ ok: true, nodeId: node.id } as T);
  }

  if (url.pathname === "/v1/actors") {
    const actor = body as ActorIdentity;
    await service.executeCommand({ kind: "actor.upsert", actor });
    return handled({ ok: true, actorId: actor.id } as T);
  }

  if (url.pathname === "/v1/agents") {
    const agent = body as AgentDefinition;
    await service.executeCommand({ kind: "agent.upsert", agent });
    return handled({ ok: true, agentId: agent.id } as T);
  }

  if (url.pathname === "/v1/endpoints") {
    const endpoint = body as AgentEndpoint;
    await service.executeCommand({
      kind: "agent.endpoint.upsert",
      endpoint,
    });
    return handled({ ok: true, endpointId: endpoint.id } as T);
  }

  if (url.pathname === "/v1/conversations") {
    const conversation = body as ConversationDefinition;
    await service.executeCommand({ kind: "conversation.upsert", conversation });
    return handled({ ok: true, conversationId: conversation.id } as T);
  }

  if (url.pathname === "/v1/bindings") {
    const binding = body as ConversationBinding;
    await service.executeCommand({ kind: "binding.upsert", binding });
    return handled({ ok: true, bindingId: binding.id } as T);
  }

  if (url.pathname === "/v1/collaboration/records") {
    return handled(await service.executeCommand({
      kind: "collaboration.upsert",
      record: body as CollaborationRecord,
    }) as T);
  }

  if (url.pathname === "/v1/collaboration/events") {
    return handled(await service.executeCommand({
      kind: "collaboration.event.append",
      event: body as CollaborationEvent,
    }) as T);
  }

  if (url.pathname === "/v1/messages") {
    if (service.postConversationMessage) {
      return handled(await service.postConversationMessage(
        body as MessageRecord,
      ) as T);
    }
    return handled(await service.executeCommand({
      kind: "conversation.post",
      message: body as MessageRecord,
    }) as T);
  }

  if (url.pathname === "/v1/deliver") {
    if (!service.deliver) {
      return unhandled();
    }
    return handled(await service.deliver(body as ScoutDeliverRequest, {
      signal: options.signal,
    }) as T);
  }

  if (url.pathname === "/v1/invocations") {
    const invocation = body as InvocationRequest & BrokerRouteTargetInput;
    if (service.invokeAgent) {
      return handled(await service.invokeAgent(invocation) as T);
    }
    if (invocation.targetLabel) {
      return unhandled();
    }
    return handled(await service.executeCommand({
      kind: "agent.invoke",
      invocation,
    }) as T);
  }

  if (url.pathname === "/v1/thread-watches/open") {
    if (!service.openThreadWatch) {
      return unhandled();
    }
    return handled(await service.openThreadWatch(
      body as ThreadWatchOpenRequest,
    ) as T);
  }

  if (url.pathname === "/v1/thread-watches/renew") {
    if (!service.renewThreadWatch) {
      return unhandled();
    }
    return handled(await service.renewThreadWatch(
      body as ThreadWatchRenewRequest,
    ) as T);
  }

  if (url.pathname === "/v1/thread-watches/close") {
    if (!service.closeThreadWatch) {
      return unhandled();
    }
    return handled(await service.closeThreadWatch(
      body as ThreadWatchCloseRequest,
    ) as T);
  }

  return unhandled();
}
