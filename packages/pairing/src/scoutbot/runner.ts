import { assistantClaimHeaders, startAssistantAnswerer } from "./answerer-claim.ts";
import { handleDiagnosticCommand } from "./report.ts";
import type {
  ScoutBrokerAgentRecord,
  ScoutBrokerConversationRecord,
  ScoutBrokerEndpointRecord,
  ScoutBrokerFlightRecord,
  ScoutBrokerMessageRecord,
  ScoutBrokerSnapshot,
  OutgoingAttachmentInput,
} from "../core/broker/service.ts";
import type { ActorIdentity } from "@openscout/protocol";
import { resolveOperatorName } from "@openscout/runtime/config";
import {
  loadScoutBrokerContext,
  resolveScoutBrokerUrl,
  normalizeOutgoingAttachments,
} from "../core/broker/service.ts";
import {
  parseScoutbotDirectives,
  scoutbotDirectiveMetadata,
  type ScoutbotReasoningEffort,
} from "./directives.ts";
import { prefilterHandle } from "./prefilter.ts";
import {
  buildScoutbotThreadConversation,
  ScoutbotThreadMapStore,
  type ScoutbotThreadListResponse,
  type ScoutbotThreadRecord,
  type ScoutbotThreadPins,
} from "./thread-map.ts";
import {
  SCOUTBOT_AGENT_ID,
  SCOUTBOT_DISPLAY_NAME,
  SCOUTBOT_ENDPOINT_ID,
  SCOUTBOT_HANDLE,
  SCOUTBOT_ROLE_CONFIG,
  SCOUTBOT_RUNTIME_INSTANCE_ID,
  scoutbotCodexLaunchArgs,
  scoutbotProvenance,
} from "@openscout/runtime/harnesses";

export interface ScoutbotRunnerHandle {
  /** Set when bootstrap could not reach the broker; this handle answers nothing. */
  readonly inert?: true;
  stop(): Promise<void>;
  getThreads(): Promise<ScoutbotThreadListResponse>;
  createThread(input: { name: string; model: string; reasoningEffort?: string; pins?: ScoutbotThreadPins }): Promise<ScoutbotThreadRecord>;
  postOperatorMessage(input: {
    body: string;
    threadId?: string | null;
    attachments?: OutgoingAttachmentInput[];
    replyToMessageId?: string | null;
  }): Promise<ScoutbotThreadMessageResult>;
}

export type ScoutbotThreadMessageResult = {
  usedBroker: boolean;
  threadId?: string;
  conversationId?: string;
  messageId?: string;
  invokedTargets: string[];
  unresolvedTargets: string[];
};

export interface ScoutbotRunnerLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface StartScoutbotRunnerOptions {
  brokerBaseUrl?: string;
  currentDirectory: string;
  log?: ScoutbotRunnerLog;
  threadMap?: ScoutbotThreadMapStore;
}

export type PostScoutbotOperatorMessageInput = {
  brokerBaseUrl?: string;
  currentDirectory: string;
  body: string;
  threadId?: string | null;
  attachments?: OutgoingAttachmentInput[];
  source?: string;
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
  referenceMessageIds?: string[];
  deviceId?: string;
  bootstrap?: boolean;
  log?: ScoutbotRunnerLog;
  threadMap?: ScoutbotThreadMapStore;
};

const defaultLog: ScoutbotRunnerLog = {
  info: (msg) => { console.log(`[scoutbot] ${msg}`); },
  warn: (msg) => { console.warn(`[scoutbot] ${msg}`); },
};

const SCOUTBOT_RUNNER_KEY = "__openscoutScoutbotRunnerV2__";
const LEGACY_SCOUTBOT_RUNNER_KEY = "__openscoutScoutbotRunner__";
type RunnerRegistry = { handle: ScoutbotRunnerHandle | null };
function runnerRegistry(): RunnerRegistry {
  const g = globalThis as unknown as Record<string, unknown>;
  let entry = g[SCOUTBOT_RUNNER_KEY] as RunnerRegistry | undefined;
  if (!entry) {
    entry = { handle: null };
    g[SCOUTBOT_RUNNER_KEY] = entry;
  }
  return entry;
}

export async function startScoutbotRunner(
  options: StartScoutbotRunnerOptions,
): Promise<ScoutbotRunnerHandle> {
  const log = options.log ?? defaultLog;
  const baseUrl = options.brokerBaseUrl ?? resolveScoutBrokerUrl();
  const threadMap = options.threadMap ?? new ScoutbotThreadMapStore();

  const registry = runnerRegistry();
  stopLegacyRunner(log);
  if (registry.handle) {
    log.info("stopping prior runner before starting fresh");
    const prior = registry.handle;
    registry.handle = null;
    await prior.stop().catch(() => undefined);
  }

  const claimant = startAssistantAnswerer({ mode: "web",
    request: (path, init) => fetch(new URL(path, baseUrl), init), warn: message => log.warn(message),
  }, async signal => {
    const boot = await ensureScoutbotBootstrapped({ baseUrl, currentDirectory: options.currentDirectory, threadMap, log });
    if (!boot || signal.aborted) return;
    await runEventLoop({ baseUrl, threadMap, signal, log });
  });
  await claimant.ready;

  const handle: ScoutbotRunnerHandle = {
    async stop() {
      await claimant.stop();
      const current = runnerRegistry();
      if (current.handle === handle) current.handle = null;
    },
    async getThreads() {
      const ctx = await loadScoutBrokerContext(baseUrl);
      if (!ctx) throw new Error("broker unreachable");
      await threadMap.ensureDefaultThread({ snapshot: ctx.snapshot, transport: "codex_app_server", transportSessionId: null });
      return threadMap.list();
    },
    async createThread(input) {
      const ctx = await loadScoutBrokerContext(baseUrl);
      if (!ctx) throw new Error("broker unreachable");
      const thread = await threadMap.createThread(input.name, { ...input, transportSessionId: null });
      const conversation = buildScoutbotThreadConversation(thread, ctx.snapshot, ctx.node.id);
      if (conversation) await postScoutbotThreadConversation(baseUrl, ctx.snapshot, conversation);
      return thread;
    },
    async postOperatorMessage(input) {
      return postScoutbotOperatorMessage({
        brokerBaseUrl: baseUrl,
        currentDirectory: options.currentDirectory,
        body: input.body,
        threadId: input.threadId,
        attachments: input.attachments,
        replyToMessageId: input.replyToMessageId,
        source: "scout-web",
        log,
        threadMap,
      });
    },
  };
  registry.handle = handle;
  log.info("runner started; broker claim selects the active answerer");
  return handle;
}

export async function postScoutbotOperatorMessage(
  input: PostScoutbotOperatorMessageInput,
): Promise<ScoutbotThreadMessageResult> {
  const log = input.log ?? defaultLog;
  const baseUrl = input.brokerBaseUrl ?? resolveScoutBrokerUrl();
  const threadMap = input.threadMap ?? new ScoutbotThreadMapStore();

  // UI posting is independent of answerer ownership. Thread resolution below
  // initializes a default thread without registering or waking the assistant.
  const thread = await resolvePostTargetThread({
    baseUrl,
    threadMap,
    threadId: input.threadId,
  });
  if (!thread) {
    if (input.threadId?.trim()) {
      throw new Error(`Unknown scoutbot thread ${input.threadId}`);
    }
    return { usedBroker: false, invokedTargets: [], unresolvedTargets: [] };
  }
  if (input.threadId?.trim() && thread.threadId !== input.threadId.trim()) {
    throw new Error(`Unknown scoutbot thread ${input.threadId}`);
  }
  const post = async () => {
    // A reply may have learned the provider session while admission was queued.
    let currentThread = await threadMap.getThread(thread.threadId) ?? thread;
    if (currentThread.model && !currentThread.transportSessionId) {
      const ctx = await loadScoutBrokerContext(baseUrl);
      const reply = Object.values(ctx?.snapshot.messages ?? {})
        .filter((message) => message.conversationId === thread.conversationId && message.actorId === SCOUTBOT_AGENT_ID)
        .sort((a, b) => b.createdAt - a.createdAt).find((message) => scoutbotReplyTransportSessionId(message));
      const providerSession = reply ? scoutbotReplyTransportSessionId(reply) : null;
      if (providerSession) currentThread = await threadMap.setThreadTransportSessionId(thread.threadId, providerSession) ?? currentThread;
    }
    return postOperatorThreadMessage({
      baseUrl, thread: currentThread, body: input.body, attachments: input.attachments,
      source: input.source ?? "scout-web", clientMessageId: input.clientMessageId,
      replyToMessageId: input.replyToMessageId, referenceMessageIds: input.referenceMessageIds,
      deviceId: input.deviceId, log,
    });
  };
  if (!thread.model) return post();
  const directives = parseScoutbotDirectives(stripMentions(input.body));
  if (directives.directives.targetSessionId || directives.command?.name === "steer"
    || (directives.directives.reasoningEffort && directives.directives.reasoningEffort !== thread.reasoningEffort)) {
    throw new Error("scoutbot_runtime_fixed: This conversation retains its model and session. Start a new conversation to change runtime, or use @session context references.");
  }
  return admitScoutbotTurn(`${baseUrl}:${thread.threadId}`, thread, async () => {
    const ctx = await loadScoutBrokerContext(baseUrl);
    if (!ctx) throw new Error("broker unreachable");
    return ctx.snapshot;
  }, post);
}

async function resolvePostTargetThread(input: {
  baseUrl: string;
  threadMap: ScoutbotThreadMapStore;
  threadId?: string | null;
}): Promise<ScoutbotThreadRecord | null> {
  const explicitThreadId = input.threadId?.trim();
  if (explicitThreadId) {
    return input.threadMap.getThread(explicitThreadId);
  }

  const threadList = await input.threadMap.list();
  const existing = threadList.threads.find((candidate) => candidate.threadId === threadList.defaultThreadId) ?? null;
  if (existing) return existing;

  const ctx = await loadScoutBrokerContext(input.baseUrl);
  if (!ctx) return null;
  return input.threadMap.ensureDefaultThread({
    snapshot: ctx.snapshot,
    transportSessionId: null,
    transport: "codex_app_server",
  });
}

function stopLegacyRunner(log: ScoutbotRunnerLog): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const legacy = g[LEGACY_SCOUTBOT_RUNNER_KEY] as { handle?: { stop?: () => Promise<void> } | null } | undefined;
  const handle = legacy?.handle;
  if (!handle?.stop) return;
  if (legacy) legacy.handle = null;
  log.info("stopping legacy scoutbot runner");
  void handle.stop().catch(() => undefined);
}

async function ensureScoutbotBootstrapped(input: {
  baseUrl: string;
  currentDirectory: string;
  threadMap: ScoutbotThreadMapStore;
  log: ScoutbotRunnerLog;
}): Promise<boolean> {
  const ctx = await loadScoutBrokerContext(input.baseUrl);
  if (!ctx) {
    input.log.warn(`broker unreachable at ${input.baseUrl}; runner is inert`);
    return false;
  }

  await ensureScoutbotRegistered(input.baseUrl, ctx.snapshot, ctx.node.id, input.currentDirectory, input.log);
  const refreshed = await loadScoutBrokerContext(input.baseUrl);
  const snapshot = refreshed?.snapshot ?? ctx.snapshot;
  const nodeId = refreshed?.node.id ?? ctx.node.id;
  const endpoint = findScoutbotEndpoint(snapshot, nodeId) ?? buildScoutbotEndpoint(nodeId, input.currentDirectory);
  const warmedEndpoint = await ensureScoutbotEndpointSession(input.baseUrl, endpoint, input.log);
  const transportSessionId = scoutbotEndpointTransportSessionId(warmedEndpoint);
  const thread = await input.threadMap.ensureDefaultThread({
    snapshot,
    transportSessionId,
    transport: endpoint.transport ?? "codex_app_server",
  });
  const latest = await loadScoutBrokerContext(input.baseUrl);
  const conversation = buildScoutbotThreadConversation(thread, latest?.snapshot ?? snapshot, latest?.node.id ?? nodeId);
  if (conversation) {
    await postScoutbotThreadConversation(input.baseUrl, latest?.snapshot ?? snapshot, conversation);
  }
  return true;
}

/**
 * Scoutbot threads are operator ⇄ scoutbot DMs. On a fresh install nothing has
 * registered the operator actor yet, and the conversation's member row has a
 * foreign key on actors, so register the operator first.
 */
async function postScoutbotThreadConversation(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  conversation: ScoutBrokerConversationRecord,
): Promise<void> {
  if (!snapshot.actors?.[SCOUTBOT_OPERATOR_ACTOR_ID]) {
    await postJson(baseUrl, "/v1/actors", buildScoutbotOperatorActor());
  }
  await postJson(baseUrl, "/v1/conversations", conversation);
}

const SCOUTBOT_OPERATOR_ACTOR_ID = "operator";

function buildScoutbotOperatorActor(): ActorIdentity {
  return {
    id: SCOUTBOT_OPERATOR_ACTOR_ID,
    kind: "person",
    displayName: resolveOperatorName().trim() || SCOUTBOT_OPERATOR_ACTOR_ID,
    handle: SCOUTBOT_OPERATOR_ACTOR_ID,
    labels: ["scout"],
    metadata: { source: "scoutbot" },
  };
}

async function ensureScoutbotRegistered(
  baseUrl: string,
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
  currentDirectory: string,
  log: ScoutbotRunnerLog,
): Promise<void> {
  const actor = buildScoutbotActor(nodeId);
  const agent = buildScoutbotAgent(nodeId);
  const endpoint = normalizeScoutbotEndpoint(
    findScoutbotEndpoint(snapshot, nodeId),
    buildScoutbotEndpoint(nodeId, currentDirectory),
  );

  if (!snapshot.actors?.[SCOUTBOT_AGENT_ID]) {
    await postJson(baseUrl, "/v1/actors", actor);
  }
  const existingAgent = snapshot.agents?.[SCOUTBOT_AGENT_ID];
  if (!existingAgent || !hasCurrentScoutbotAgentRegistration(existingAgent, nodeId)) {
    await postJson(baseUrl, "/v1/agents", agent);
  }
  const existingEndpoint = findScoutbotEndpoint(snapshot, nodeId);
  if (
    !existingEndpoint
    || existingEndpoint.state === "offline"
    || existingEndpoint.metadata?.source !== "scoutbot"
    || !hasCurrentScoutbotRuntimeConfig(existingEndpoint)
    || isInvalidScoutbotSessionEndpoint(existingEndpoint)
  ) {
    await postJson(baseUrl, "/v1/endpoints", endpoint);
    log.info(`registered endpoint ${endpoint.id}`);
  }
}

function buildScoutbotActor(_nodeId: string): ActorIdentity {
  return {
    id: SCOUTBOT_AGENT_ID,
    kind: "agent",
    displayName: SCOUTBOT_DISPLAY_NAME,
    handle: SCOUTBOT_HANDLE,
    labels: ["assistant", "scout", "scoutbot"],
    metadata: {
      source: "scoutbot",
      brokerRegistered: true,
      role: "operator-assistant",
    },
  };
}

function buildScoutbotAgent(nodeId: string): ScoutBrokerAgentRecord {
  return {
    ...buildScoutbotActor(nodeId),
    kind: "agent",
    definitionId: SCOUTBOT_HANDLE,
    selector: `@${SCOUTBOT_HANDLE}`,
    defaultSelector: `@${SCOUTBOT_HANDLE}`,
    agentClass: "operator",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "keep_warm",
    homeNodeId: nodeId,
    authorityNodeId: nodeId,
    advertiseScope: "local",
    metadata: {
      source: "scoutbot",
      brokerRegistered: true,
      role: "operator-assistant",
      summary: "Operator-facing fleet concierge backed by the broker's local session adapter.",
      roleConfig: SCOUTBOT_ROLE_CONFIG,
    },
  };
}

function buildScoutbotEndpoint(nodeId: string, currentDirectory: string): ScoutBrokerEndpointRecord {
  const reasoningEffort = SCOUTBOT_ROLE_CONFIG.defaults.reasoningEffort;
  return {
    id: `${SCOUTBOT_ENDPOINT_ID}.${nodeId}`,
    agentId: SCOUTBOT_AGENT_ID,
    nodeId,
    harness: "codex",
    transport: "codex_app_server",
    state: "waiting",
    cwd: currentDirectory,
    projectRoot: currentDirectory,
    metadata: {
      source: "scoutbot",
      managedByScout: true,
      sessionBacked: true,
      externalSource: "local-session",
      attachedTransport: "codex_app_server",
      agentName: SCOUTBOT_AGENT_ID,
      definitionId: SCOUTBOT_HANDLE,
      runtimeInstanceId: SCOUTBOT_RUNTIME_INSTANCE_ID,
      roleConfig: SCOUTBOT_ROLE_CONFIG,
      systemPrompt: SCOUTBOT_ROLE_CONFIG.systemPrompt,
      toolGrants: SCOUTBOT_ROLE_CONFIG.grants,
      permissionProfile: "observe",
      permissionEnforcement: "native",
      approvalPolicy: "never",
      sandbox: "read-only",
      shellTool: false,
      reasoningEffort,
      launchArgs: scoutbotCodexLaunchArgs(),
      projectRoot: currentDirectory,
      transport: "codex_app_server",
      startedAt: String(Date.now()),
    },
  };
}

function findScoutbotEndpoint(snapshot: ScoutBrokerSnapshot, nodeId?: string): ScoutBrokerEndpointRecord | null {
  const endpoints = Object.values((snapshot as { endpoints?: Record<string, ScoutBrokerEndpointRecord> }).endpoints ?? {})
    .filter((endpoint) => endpoint.agentId === SCOUTBOT_AGENT_ID
      && endpoint.transport === "codex_app_server"
      && endpoint.metadata?.isolatedExecution !== true);
  return endpoints.find((endpoint) => endpoint.nodeId === nodeId && endpoint.state !== "offline")
    ?? endpoints.find((endpoint) => endpoint.state !== "offline")
    ?? endpoints[0]
    ?? null;
}

function normalizeScoutbotEndpoint(
  existing: ScoutBrokerEndpointRecord | null,
  fallback: ScoutBrokerEndpointRecord,
): ScoutBrokerEndpointRecord {
  if (!existing || isInvalidScoutbotSessionEndpoint(existing)) return fallback;
  // Strip session identity from the existing endpoint metadata before
  // merging. The broker endpoint reflects current runtime state; it
  // should only be set by the transport when it actually issues a
  // session. Carrying these fields across re-registrations is what made
  // the broken `019e6a9a-...` UUID survive restarts. The thread-map
  // file is the source of truth.
  const existingMetadata = { ...(existing.metadata ?? {}) };
  delete existingMetadata.threadId;
  delete existingMetadata.externalSessionId;
  delete existingMetadata.targetSessionId;
  return {
    ...fallback,
    id: existing.id || fallback.id,
    state: existing.state === "offline" ? "waiting" : existing.state,
    metadata: {
      ...existingMetadata,
      ...(fallback.metadata ?? {}),
    },
  };
}

function isInvalidScoutbotSessionEndpoint(endpoint: ScoutBrokerEndpointRecord): boolean {
  const lastError = String(endpoint.metadata?.lastError ?? "").toLowerCase();
  return lastError.includes("no rollout found for thread id")
    || lastError.includes("codex_app_server session unavailable")
    || lastError.includes("session unavailable");
}

function hasCurrentScoutbotRuntimeConfig(endpoint: ScoutBrokerEndpointRecord): boolean {
  const launchArgs = Array.isArray(endpoint.metadata?.launchArgs)
    ? endpoint.metadata.launchArgs
    : [];
  return metadataString(endpoint.metadata, "systemPrompt") === SCOUTBOT_ROLE_CONFIG.systemPrompt
    && metadataString(endpoint.metadata, "reasoningEffort") === SCOUTBOT_ROLE_CONFIG.defaults.reasoningEffort
    && metadataString(endpoint.metadata, "approvalPolicy") === "never"
    && metadataString(endpoint.metadata, "sandbox") === "read-only"
    && endpoint.metadata?.shellTool === false
    && JSON.stringify(launchArgs) === JSON.stringify(scoutbotCodexLaunchArgs());
}

function scoutbotEndpointTransportSessionId(endpoint: ScoutBrokerEndpointRecord): string | null {
  if (isInvalidScoutbotSessionEndpoint(endpoint)) return null;
  return metadataString(endpoint.metadata, "threadId")
    ?? metadataString(endpoint.metadata, "externalSessionId")
    ?? endpoint.sessionId?.trim()
    ?? null;
}

async function ensureScoutbotEndpointSession(
  baseUrl: string,
  endpoint: ScoutBrokerEndpointRecord,
  log: ScoutbotRunnerLog,
): Promise<ScoutBrokerEndpointRecord> {
  try {
    const result = await postJson<{
      ok: true;
      endpoint?: ScoutBrokerEndpointRecord;
    }>(
      baseUrl,
      "/v1/local-sessions/ensure",
      { agentId: endpoint.agentId, endpointId: endpoint.id },
      { timeoutMs: 2_000 },
    );
    return result.endpoint ?? endpoint;
  } catch (error) {
    log.warn(`session warmup skipped: ${describeError(error)}`);
    return endpoint;
  }
}

async function postOperatorThreadMessage(input: {
  baseUrl: string;
  thread: ScoutbotThreadRecord;
  body: string;
  attachments?: OutgoingAttachmentInput[];
  source: string;
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
  referenceMessageIds?: string[];
  deviceId?: string;
  log: ScoutbotRunnerLog;
}): Promise<ScoutbotThreadMessageResult> {
  const ctx = await loadScoutBrokerContext(input.baseUrl);
  if (!ctx) {
    return { usedBroker: false, invokedTargets: [], unresolvedTargets: [] };
  }
  const conversation = ctx.snapshot.conversations[input.thread.conversationId]
    ?? buildScoutbotThreadConversation(input.thread, ctx.snapshot, ctx.node.id);
  if (conversation && !ctx.snapshot.conversations[input.thread.conversationId]) {
    await postScoutbotThreadConversation(input.baseUrl, ctx.snapshot, conversation);
  }

  const parsed = parseScoutbotDirectives(input.body);
  const now = Date.now();
  const messageId = createId("msg");
  const transportSessionId = parsed.directives.targetSessionId
    ?? input.thread.transportSessionId?.trim()
    ?? null;
  await postJson(input.baseUrl, "/v1/messages", {
    id: messageId,
    conversationId: input.thread.conversationId,
    actorId: "operator",
    originNodeId: ctx.node.id,
    class: "agent",
    body: input.body.trim(),
    replyToMessageId: input.replyToMessageId ?? undefined,
    mentions: [{ actorId: SCOUTBOT_AGENT_ID, label: "@scoutbot" }],
    attachments: normalizeOutgoingAttachments(input.attachments),
    audience: { notify: [SCOUTBOT_AGENT_ID], reason: "direct_message" },
    visibility: "private",
    policy: "durable",
    createdAt: now,
    metadata: {
      source: input.source,
      ...scoutbotDirectiveMetadata(parsed),
      destinationKind: "scoutbot_thread",
      destinationId: input.thread.threadId,
      scoutbotThreadId: input.thread.threadId,
      ...(transportSessionId ? { targetSessionId: transportSessionId } : {}),
      referenceMessageIds: input.referenceMessageIds ?? [],
      clientMessageId: input.clientMessageId ?? null,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      relayMessageId: messageId,
      returnAddress: {
        actorId: "operator",
        conversationId: input.thread.conversationId,
        replyToMessageId: messageId,
        ...(transportSessionId ? { sessionId: transportSessionId } : {}),
      },
    },
  });

  return {
    usedBroker: true,
    threadId: input.thread.threadId,
    conversationId: input.thread.conversationId,
    messageId,
    invokedTargets: [SCOUTBOT_AGENT_ID],
    unresolvedTargets: [],
  };
}

interface RunEventLoopOptions {
  baseUrl: string;
  threadMap: ScoutbotThreadMapStore;
  signal: AbortSignal;
  log: ScoutbotRunnerLog;
}

async function runEventLoop(options: RunEventLoopOptions): Promise<void> {
  let attempt = 0;
  while (!options.signal.aborted) {
    try {
      await streamOnce(options);
      attempt = 0;
    } catch (error) {
      if (options.signal.aborted) return;
      attempt += 1;
      const delayMs = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
      options.log.warn(`event stream dropped (attempt ${attempt}): ${describeError(error)}; retrying in ${delayMs}ms`);
      await sleep(delayMs, options.signal);
    }
  }
}

async function streamOnce(options: RunEventLoopOptions): Promise<void> {
  options.log.info(`connecting event stream at ${options.baseUrl}`);
  const response = await fetch(new URL("/v1/events/stream", options.baseUrl), {
    headers: { accept: "text/event-stream" },
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`/v1/events/stream returned ${response.status}`);
  }
  options.log.info("event stream connected");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!options.signal.aborted) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let split = nextBlock(buffer);
    while (split) {
      buffer = split.rest;
      void handleBlock(split.block, options).catch((error) => {
        options.log.warn(`event handler failed: ${describeError(error)}`);
      });
      split = nextBlock(buffer);
    }
  }
}

function nextBlock(buffer: string): { block: string; rest: string } | null {
  const idx = buffer.indexOf("\n\n");
  if (idx === -1) return null;
  return { block: buffer.slice(0, idx), rest: buffer.slice(idx + 2) };
}

async function handleBlock(block: string, options: RunEventLoopOptions): Promise<void> {
  if (options.signal.aborted) return;
  const event = parseSseBlock(block);
  if (event?.eventName !== "message.posted") return;
  const message = extractMessage(event.data);
  if (!message) return;

  const thread = await options.threadMap.getThreadByConversationId(message.conversationId);
  if (!thread) return;
  if (message.actorId === SCOUTBOT_AGENT_ID) {
    const replySessionId = scoutbotReplyTransportSessionId(message);
    if (replySessionId) {
      await options.threadMap.setThreadTransportSessionId(thread.threadId, replySessionId);
      options.log.info(`thread=${thread.threadId} learned transportSession=${shortId(replySessionId)} from reply=${shortId(message.id)}`);
    }
    return;
  }
  if (!isScoutbotAddressedMessage(message)) return;

  const ctx = await loadScoutBrokerContext(options.baseUrl);
  if (!ctx) return;

  const prompt = stripMentions(message.body);
  const prefilter = prefilterHandle(prompt, ctx.snapshot);
  const existingFlight = findScoutbotFlightForMessage(ctx.snapshot, message.id, { includeTerminal: true });
  if (existingFlight && !(prefilter && isScoutbotDirectDeliveryFlight(existingFlight))) {
    options.log.info(`message already has flight id=${shortId(existingFlight.id)} source=${shortId(message.id)}`);
    return;
  }

  options.log.info(`handling thread=${thread.threadId} source=${shortId(message.id)} promptChars=${prompt.length}`);
  if (prefilter) {
    if (prefilter.metadata.matched_rule === "slash.report" || prefilter.metadata.matched_rule === "slash.feedback") {
      prefilter.body = await handleDiagnosticCommand(prompt);
    }
    const steerTargetSessionId = prefilter.metadata.matched_rule === "slash.steer"
      ? metadataString(prefilter.metadata, "targetSessionId")
      : undefined;
    if (steerTargetSessionId) {
      await options.threadMap.setThreadTransportSessionId(thread.threadId, steerTargetSessionId);
      options.log.info(`thread=${thread.threadId} steered transportSession=${shortId(steerTargetSessionId)}`);
    }
    const replyId = await postPrefilterReply({
      baseUrl: options.baseUrl,
      conversation: ctx.snapshot.conversations[thread.conversationId],
      message,
      body: prefilter.body,
      metadata: prefilter.metadata,
      nodeId: ctx.node.id,
      log: options.log,
    });
    await options.threadMap.touchThread(thread.threadId);
    options.log.info(`prefilter reply posted source=${shortId(message.id)} reply=${shortId(replyId)}`);
    return;
  }

  await postScoutbotInvocation({
    baseUrl: options.baseUrl,
    thread,
    message,
    nodeId: ctx.node.id,
  });
  await options.threadMap.touchThread(thread.threadId);
  options.log.info(`invocation posted source=${shortId(message.id)} targetSession=${thread.transportSessionId ? shortId(thread.transportSessionId) : "new"}`);
}

async function postPrefilterReply(input: {
  baseUrl: string;
  conversation: ScoutBrokerConversationRecord | undefined;
  message: ScoutBrokerMessageRecord;
  body: string;
  metadata: Record<string, unknown>;
  nodeId: string;
  log: ScoutbotRunnerLog;
}): Promise<string> {
  if (!input.conversation) {
    throw new Error(`unknown conversation ${input.message.conversationId}`);
  }
  const messageId = createId("msg");
  await postJson(input.baseUrl, "/v1/messages", {
    id: messageId,
    conversationId: input.conversation.id,
    actorId: SCOUTBOT_AGENT_ID,
    originNodeId: input.nodeId,
    class: "agent",
    body: input.body,
    replyToMessageId: input.message.id,
    audience: { notify: [input.message.actorId], reason: "reply" },
    visibility: input.conversation.visibility,
    policy: "durable",
    createdAt: Date.now(),
    metadata: {
      ...scoutbotProvenance({
        requestedBy: input.message.actorId,
        sourceMessageId: input.message.id,
      }),
      ...input.metadata,
      sourcePath: "scoutbot-prefilter",
      relayMessageId: messageId,
    },
  });
  return messageId;
}

async function postScoutbotInvocation(input: {
  baseUrl: string;
  thread: ScoutbotThreadRecord;
  message: ScoutBrokerMessageRecord;
  nodeId: string;
}): Promise<void> {
  await postJson(input.baseUrl, "/v1/invocations", buildScoutbotInvocation(input));
}

export function buildScoutbotInvocation(input: {
  thread: ScoutbotThreadRecord;
  message: ScoutBrokerMessageRecord;
  nodeId: string;
}) {
  const invocationId = input.thread.model ? `inv-scoutbot-${input.message.id}` : createId("inv");
  const prompt = stripMentions(input.message.body);
  const parsed = parseScoutbotDirectives(prompt);
  const requestedReasoningEffort =
    (input.thread.reasoningEffort as ScoutbotReasoningEffort | undefined)
    ?? parsed.directives.reasoningEffort
    ?? metadataReasoningEffort(input.message.metadata);
  const transportSessionId =
    parsed.directives.targetSessionId
    ?? metadataString(input.message.metadata, "targetSessionId")
    ?? input.thread.transportSessionId?.trim()
    ?? null;
  const task = parsed.body || parsed.messageBody || prompt;
  const context = scoutbotInvocationDirectiveContext({
    parsed,
    requestedReasoningEffort,
    targetSessionId: transportSessionId,
  });
  return {
    id: invocationId,
    requesterId: input.message.actorId,
    requesterNodeId: input.nodeId,
    targetAgentId: SCOUTBOT_AGENT_ID,
    action: "consult",
    task,
    conversationId: input.thread.conversationId,
    messageId: input.message.id,
    ...(Object.keys(context).length > 0 ? { context } : {}),
    execution: {
      session: transportSessionId ? "existing" : "new",
      ...(transportSessionId ? { targetSessionId: transportSessionId } : {}),
      ...(input.thread.model ? { harness: "codex", model: input.thread.model } : {}),
      ...(input.thread.reasoningEffort ? { reasoningEffort: input.thread.reasoningEffort } : {}),
    },
    ensureAwake: true,
    stream: false,
    createdAt: Date.now(),
    metadata: {
      ...scoutbotProvenance({
        requestedBy: input.message.actorId,
        sourceMessageId: input.message.id,
      }),
      ...scoutbotDirectiveMetadata(parsed),
      ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
      scoutbotThreadId: input.thread.threadId,
      ...(transportSessionId ? { targetSessionId: transportSessionId } : {}),
      relayTarget: SCOUTBOT_AGENT_ID,
      relayChannel: "dm",
      returnAddress: {
        actorId: input.message.actorId,
        conversationId: input.thread.conversationId,
        replyToMessageId: input.message.id,
        ...(transportSessionId ? { sessionId: transportSessionId } : {}),
      },
    },
  };
}

function scoutbotInvocationDirectiveContext(input: {
  parsed: ReturnType<typeof parseScoutbotDirectives>;
  requestedReasoningEffort?: ScoutbotReasoningEffort;
  targetSessionId?: string | null;
}): Record<string, string> {
  const context: Record<string, string> = {};
  if (input.requestedReasoningEffort) {
    context.requestedReasoningEffort = input.requestedReasoningEffort;
  }
  if (input.targetSessionId) {
    context.targetSessionId = input.targetSessionId;
  }
  if (input.parsed.body && input.parsed.body !== input.parsed.original) {
    context.directiveBody = input.parsed.body;
  }
  return context;
}

function parseSseBlock(block: string): { eventName: string; data: unknown } | null {
  const trimmed = block.trim();
  if (!trimmed) return null;
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (!eventName || dataLines.length === 0) return null;
  try {
    return { eventName, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

function extractMessage(event: unknown): ScoutBrokerMessageRecord | null {
  if (!event || typeof event !== "object") return null;
  if ((event as { kind?: unknown }).kind !== "message.posted") return null;
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return null;
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const record = message as ScoutBrokerMessageRecord;
  return typeof record.id === "string" && typeof record.conversationId === "string" ? record : null;
}

function scoutbotReplyTransportSessionId(message: ScoutBrokerMessageRecord): string | null {
  return metadataString(message.metadata, "targetSessionId")
    ?? metadataString(message.metadata, "responderSessionId")
    ?? metadataString(metadataObject(message.metadata, "returnAddress"), "sessionId")
    ?? null;
}

export function isScoutbotAddressedMessage(message: ScoutBrokerMessageRecord): boolean {
  if (message.mentions?.some((mention) => mention.actorId === SCOUTBOT_AGENT_ID)) return true;
  if (message.audience?.notify?.includes(SCOUTBOT_AGENT_ID)) return true;
  if (metadataString(message.metadata, "destinationId") === SCOUTBOT_AGENT_ID) return true;
  if (metadataString(message.metadata, "relayTarget") === SCOUTBOT_AGENT_ID) return true;
  if (metadataStringArrayIncludes(message.metadata, "relayTargetIds", SCOUTBOT_AGENT_ID)) return true;
  return /(^|\s)@scoutbot(\b|\s|$)/i.test(message.body);
}

function stripMentions(body: string): string {
  // Routing is explicit metadata. Only an optional leading assistant address
  // belongs to the envelope; other mentions and formatting are user payload.
  return body.replace(/^\s*@scoutbot(?=\s|[:,]|$)[:,]?\s*/i, "").trim();
}

type SnapshotWithFlights = ScoutBrokerSnapshot & {
  flights?: Record<string, ScoutBrokerFlightRecord>;
  invocations?: Record<string, { id?: string; messageId?: string; conversationId?: string; targetAgentId?: string }>;
};

const TERMINAL_FLIGHT_STATES = new Set(["completed", "failed", "cancelled"]);
export function findScoutbotFlightForMessage(
  snapshot: ScoutBrokerSnapshot,
  messageId: string,
  options: { includeTerminal?: boolean } = {},
): ScoutBrokerFlightRecord | null {
  const typed = snapshot as SnapshotWithFlights;
  const flights = Object.values(typed.flights ?? {});
  const invocations = typed.invocations ?? {};
  const candidates = flights.filter((flight) => {
    if (flight.targetAgentId !== SCOUTBOT_AGENT_ID) return false;
    if (!options.includeTerminal && TERMINAL_FLIGHT_STATES.has(flight.state)) return false;
    const invocation = invocations[flight.invocationId];
    if (invocation?.messageId === messageId) return true;
    const returnAddress = metadataObject(flight.metadata, "returnAddress");
    return metadataString(returnAddress, "replyToMessageId") === messageId;
  });
  return candidates.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))[0] ?? null;
}

export function isScoutbotDirectDeliveryFlight(flight: ScoutBrokerFlightRecord): boolean {
  if (flight.targetAgentId !== SCOUTBOT_AGENT_ID) return false;
  if (metadataString(flight.metadata, "source") === "scoutbot") return false;
  if (metadataString(flight.metadata, "destinationId") === SCOUTBOT_AGENT_ID) return true;
  if (metadataString(flight.metadata, "relayTarget") === SCOUTBOT_AGENT_ID) return true;
  return false;
}

async function postJson<T = { ok: true }>(
  baseUrl: string,
  path: string,
  body: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = options.timeoutMs ? new AbortController() : null;
  const timer = controller && options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;
  try {
    const res = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...assistantClaimHeaders() },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${path} ${res.status}${text ? ` - ${text}` : ""}`);
    }
    return await res.json().catch(() => ({ ok: true }) as T);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hasScoutbotLabels(agent: ScoutBrokerAgentRecord): boolean {
  const labels = new Set(agent.labels ?? []);
  return labels.has("assistant") && labels.has("scout") && labels.has("scoutbot");
}

export function hasCurrentScoutbotAgentRegistration(agent: ScoutBrokerAgentRecord, nodeId: string): boolean {
  return hasScoutbotLabels(agent)
    && hasCurrentScoutbotAgentConfig(agent)
    && agent.homeNodeId === nodeId
    && agent.authorityNodeId === nodeId
    && agent.advertiseScope === "local"
    && agent.wakePolicy === "keep_warm"
    && agent.metadata?.source === "scoutbot"
    && agent.metadata?.brokerRegistered === true;
}

function hasCurrentScoutbotAgentConfig(agent: ScoutBrokerAgentRecord): boolean {
  const roleConfig = metadataObject(agent.metadata, "roleConfig");
  return metadataString(roleConfig, "systemPrompt") === SCOUTBOT_ROLE_CONFIG.systemPrompt;
}

function metadataObject(metadata: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const SCOUTBOT_REASONING_EFFORTS = new Set<ScoutbotReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function metadataReasoningEffort(metadata: Record<string, unknown> | undefined): ScoutbotReasoningEffort | undefined {
  const value = metadataString(metadata, "reasoningEffort");
  return SCOUTBOT_REASONING_EFFORTS.has(value as ScoutbotReasoningEffort)
    ? value as ScoutbotReasoningEffort
    : undefined;
}

function metadataStringArrayIncludes(
  metadata: Record<string, unknown> | undefined,
  key: string,
  value: string,
): boolean {
  const entry = metadata?.[key];
  return Array.isArray(entry) && entry.some((item) => item === value);
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

const scoutbotAdmissions = new Map<string, Promise<unknown>>();

export function scoutbotThreadHasPendingTurn(thread: ScoutbotThreadRecord, snapshot: ScoutBrokerSnapshot): boolean {
  const messages = Object.values(snapshot.messages ?? {}).filter((message) => message.conversationId === thread.conversationId);
  const latest = messages.filter((message) => message.actorId === "operator")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latest) return false;
  const flight = findScoutbotFlightForMessage(snapshot, latest.id, { includeTerminal: true });
  if (flight && !TERMINAL_FLIGHT_STATES.has(flight.state)) return true;
  if (flight && (flight.state === "failed" || flight.state === "cancelled")) return false;
  const reply = messages.find((message) => message.actorId === SCOUTBOT_AGENT_ID
    && (message.replyToMessageId === latest.id || message.createdAt > latest.createdAt));
  if (!reply) return flight?.state !== "completed" || !thread.transportSessionId;
  // Deterministic replies need no provider history. Model replies must bind
  // their first provider session before another isolated invocation can start.
  return flight?.state === "completed" && !thread.transportSessionId && !scoutbotReplyTransportSessionId(reply);
}

/** Serialize admission until the first durable message is visible to the next
 * caller; pending broker turns are rejected before any second message is written. */
export async function admitScoutbotTurn<T>(
  key: string,
  thread: ScoutbotThreadRecord,
  snapshot: () => Promise<ScoutBrokerSnapshot>,
  post: () => Promise<T>,
): Promise<T> {
  const previous = scoutbotAdmissions.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    if (scoutbotThreadHasPendingTurn(thread, await snapshot())) {
      throw new Error("scoutbot_turn_pending: Wait for Scoutbot's current reply before sending again. Your draft has not been sent.");
    }
    return post();
  });
  scoutbotAdmissions.set(key, next);
  try { return await next; }
  finally { if (scoutbotAdmissions.get(key) === next) scoutbotAdmissions.delete(key); }
}
