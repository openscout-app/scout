import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type {
  AgentEndpoint,
  AgentHarness,
  InvocationRequest,
} from "@openscout/protocol";
import { normalizeAgentSelectorSegment } from "@openscout/protocol";

import { buildLocalAgentDirectInvocationPrompt } from "./local-agents.js";
import { openPairingLocalChannel } from "./pairing-local-socket.js";
import { resolveOpenScoutPairingHomeForEnv } from "./support-paths.js";
import { resolvePairingPort } from "./local-config.js";

const PAIRING_CONNECT_TIMEOUT_MS = 1_500;
const PAIRING_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PAIRING_POLL_INTERVAL_MS = 350;
const DEFAULT_PAIRING_INVOCATION_TIMEOUT_MS = 45_000;
const MAX_SYNTHETIC_OUTPUT_CHARS = 1_200;

type PairingSessionStatus = "connecting" | "active" | "idle" | "error" | "closed";
type PairingTurnStatus = "streaming" | "completed" | "interrupted" | "error";
type PairingBlockStatus = "started" | "streaming" | "completed" | "failed";
type PairingActionStatus = "pending" | "running" | "completed" | "failed" | "awaiting_approval";
type PairingQuestionStatus = "awaiting_answer" | "answered" | "denied";

type PairingActionApproval = {
  version: number;
  description?: string;
  risk?: "low" | "medium" | "high";
};

type PairingActionBase = {
  status: PairingActionStatus;
  output: string;
  approval?: PairingActionApproval;
};

type PairingCommandAction = PairingActionBase & {
  kind: "command";
  command: string;
  exitCode?: number;
};

type PairingFileChangeAction = PairingActionBase & {
  kind: "file_change";
  path: string;
  diff?: string;
};

type PairingToolCallAction = PairingActionBase & {
  kind: "tool_call";
  toolName: string;
  toolCallId: string;
  input?: unknown;
  result?: unknown;
};

type PairingSubagentAction = PairingActionBase & {
  kind: "subagent";
  agentId: string;
  agentName?: string;
  prompt?: string;
};

type PairingAction = PairingCommandAction | PairingFileChangeAction | PairingToolCallAction | PairingSubagentAction;

type PairingBlockBase = {
  id: string;
  turnId: string;
  status: PairingBlockStatus;
  index: number;
};

type PairingTextBlock = PairingBlockBase & {
  type: "text";
  text: string;
};

type PairingReasoningBlock = PairingBlockBase & {
  type: "reasoning";
  text: string;
};

type PairingActionBlock = PairingBlockBase & {
  type: "action";
  action: PairingAction;
};

type PairingFileBlock = PairingBlockBase & {
  type: "file";
  mimeType: string;
  name?: string;
  data: string;
};

type PairingErrorBlock = PairingBlockBase & {
  type: "error";
  message: string;
  code?: string;
};

type PairingQuestionBlock = PairingBlockBase & {
  type: "question";
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  questionStatus: PairingQuestionStatus;
  answer?: string[];
};

type PairingBlock =
  | PairingTextBlock
  | PairingReasoningBlock
  | PairingActionBlock
  | PairingFileBlock
  | PairingErrorBlock
  | PairingQuestionBlock;

type PairingBlockState = {
  block: PairingBlock;
  status: "streaming" | "completed";
};

export type PairingSession = {
  id: string;
  name: string;
  adapterType: string;
  status: PairingSessionStatus;
  cwd?: string;
  model?: string;
  providerMeta?: Record<string, unknown>;
};

export type PairingTurnState = {
  id: string;
  status: PairingTurnStatus;
  blocks: PairingBlockState[];
  startedAt: number;
  endedAt?: number;
};

export type PairingSessionState = {
  session: PairingSession;
  turns: PairingTurnState[];
  currentTurnId?: string;
};

type PairingRuntimeStatus =
  | "stopped"
  | "starting"
  | "connecting"
  | "connected"
  | "paired"
  | "closed"
  | "error";

type PairingRuntimeSnapshot = {
  status: PairingRuntimeStatus;
};

type PairingConfig = {
  port?: number;
};

type PairingBridgeResponseEnvelope<T> =
  | {
      id: number;
      jsonrpc?: string;
      result?: { type: "data"; data: T } | { type: "started" | "stopped" };
      error?: never;
    }
  | {
      id: number | null;
      jsonrpc?: string;
      error: {
        code?: number;
        message?: string;
        data?: Record<string, unknown>;
      };
      result?: never;
    };


export type PairingBridgeClient = {
  query<T>(path: string, input?: Record<string, unknown>): Promise<T>;
  mutation<T>(path: string, input?: Record<string, unknown>): Promise<T>;
  close(): void;
};

export type PairingBridgeClientFactory = (port: number) => Promise<PairingBridgeClient>;

export type PairingSessionCandidate = {
  externalSessionId: string;
  name: string;
  adapterType: string;
  status: PairingSessionStatus;
  cwd?: string;
  model?: string;
  providerMeta?: Record<string, unknown>;
  suggestedSelector: string;
};

export type PairingInvocationResult = {
  output: string;
};

export type EnsurePairingSessionForCodexThreadInput = {
  threadId: string;
  cwd?: string;
  name?: string;
  systemPrompt?: string;
};

export type EnsurePairingSessionForAdapterInput = {
  adapterType: string;
  cwd?: string;
  name?: string;
  options?: Record<string, unknown>;
};

type PairingSessionDiscoveryOptions = {
  createClient?: PairingBridgeClientFactory;
  port?: number;
};

type PairingInvocationOptions = PairingSessionDiscoveryOptions & {
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

function pairingPaths(): {
  configPath: string;
  runtimeStatePath: string;
} {
  const rootDir = resolveOpenScoutPairingHomeForEnv(process.env);
  return {
    configPath: join(rootDir, "config.json"),
    runtimeStatePath: join(rootDir, "runtime.json"),
  };
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function resolvePairingBridgePort(options: PairingSessionDiscoveryOptions = {}): number | null {
  if (typeof options.port === "number" && Number.isFinite(options.port) && options.port > 0) {
    return options.port;
  }

  const { configPath, runtimeStatePath } = pairingPaths();
  const configExists = existsSync(configPath);
  const runtimeSnapshot = readJsonFile<PairingRuntimeSnapshot>(runtimeStatePath);

  if (!configExists && !runtimeSnapshot) {
    return null;
  }

  if (runtimeSnapshot && (
    runtimeSnapshot.status === "stopped"
    || runtimeSnapshot.status === "closed"
    || runtimeSnapshot.status === "error"
  )) {
    return null;
  }

  const config = readJsonFile<PairingConfig>(configPath);
  return Number.isFinite(config?.port) && (config?.port ?? 0) > 0
    ? Number(config?.port)
    // Env (OPENSCOUT_PAIRING_PORT, set per instance), ~/.openscout/config.json,
    // then this OPENSCOUT_INSTANCE's default: never prod's 43130 from a dev instance.
    : resolvePairingPort();
}

async function createPairingBridgeClient(port: number): Promise<PairingBridgeClient> {
  let nextRequestId = 1;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };

  const handleMessage = (raw: string) => {
    let payload: PairingBridgeResponseEnvelope<unknown>;
    try {
      payload = JSON.parse(raw) as PairingBridgeResponseEnvelope<unknown>;
    } catch {
      return;
    }

    if (typeof payload.id !== "number") {
      return;
    }

    const request = pending.get(payload.id);
    if (!request) {
      return;
    }

    pending.delete(payload.id);
    if ("error" in payload && payload.error) {
      request.reject(new Error(payload.error.message || "Pairing bridge RPC failed."));
      return;
    }

    const result = payload.result;
    if (!result || result.type !== "data") {
      request.reject(new Error("Pairing bridge returned an unexpected response."));
      return;
    }

    request.resolve(result.data);
  };

  const channel = await openPairingLocalChannel(port, {
    onMessage: handleMessage,
    onClose: () => rejectPending(new Error("Pairing bridge connection closed.")),
  }, { timeoutMs: PAIRING_CONNECT_TIMEOUT_MS });

  function call<T>(
    method: "query" | "mutation",
    path: string,
    input?: Record<string, unknown>,
  ): Promise<T> {
    if (!channel.isOpen()) {
      return Promise.reject(new Error("Pairing bridge is not connected."));
    }

    const id = nextRequestId++;
    const requestPayload = {
      id,
      jsonrpc: "2.0",
      method,
      params: {
        path,
        ...(input ? { input } : {}),
      },
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Pairing bridge request timed out for ${path}.`));
      }, PAIRING_REQUEST_TIMEOUT_MS);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      channel.send(JSON.stringify(requestPayload));
    });
  }

  return {
    query<T>(path: string, input?: Record<string, unknown>) {
      return call<T>("query", path, input);
    },
    mutation<T>(path: string, input?: Record<string, unknown>) {
      return call<T>("mutation", path, input);
    },
    close() {
      channel.close();
      rejectPending(new Error("Pairing bridge client closed."));
    },
  };
}

async function withPairingBridgeClient<T>(
  options: PairingSessionDiscoveryOptions,
  run: (client: PairingBridgeClient) => Promise<T>,
): Promise<T> {
  const port = resolvePairingBridgePort(options);
  if (!port) {
    throw new Error("The pairing bridge is not currently configured or running.");
  }

  const client = await (options.createClient ?? createPairingBridgeClient)(port);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

function normalizePairingSlug(...segments: Array<string | null | undefined>): string {
  return segments
    .map((segment) => normalizeAgentSelectorSegment(segment ?? ""))
    .filter(Boolean)
    .join("-");
}

function shortPairingSessionId(sessionId: string): string {
  const normalized = normalizeAgentSelectorSegment(sessionId);
  return normalized.slice(0, 8) || "session";
}

function pairingProjectLabel(session: PairingSession): string | null {
  const cwd = session.cwd?.trim();
  return cwd ? basename(cwd) : null;
}

function pairingDisplayName(session: PairingSession, shortId: string): string {
  const explicit = session.name?.trim();
  if (explicit) {
    return explicit;
  }

  const project = pairingProjectLabel(session);
  const adapterLabel = session.adapterType.trim() || "pairing";
  return project ? `${adapterLabel} ${project}` : `${adapterLabel} ${shortId}`;
}

function pairingHandleBase(session: PairingSession): string {
  const adapterSlug = normalizeAgentSelectorSegment(session.adapterType) || "pairing";
  const projectSlug = normalizeAgentSelectorSegment(pairingProjectLabel(session) ?? "");
  const nameSlug = normalizeAgentSelectorSegment(session.name ?? "");
  return normalizePairingSlug(adapterSlug, projectSlug || nameSlug || "session") || "pairing-session";
}

function pairingHarness(adapterType: string): AgentHarness {
  const normalized = adapterType.trim().toLowerCase();
  if (normalized.includes("codex")) {
    return "codex";
  }
  // Checked before the claude branch: OpenCode used to be reported as claude
  // because Scout had no opencode harness to attribute it to.
  if (normalized.includes("opencode")) {
    return "opencode";
  }
  if (normalized === "devin-acp" || normalized.includes("devin")) {
    return "devin";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("pi")) {
    return "native";
  }
  if (normalized === "grok-acp" || (normalized.includes("grok") && normalized.includes("acp"))) {
    return "grok-acp";
  }
  if (normalized === "kimi-acp" || normalized.includes("kimi")) {
    return "kimi";
  }
  return "bridge";
}

function pairingEndpointState(status: PairingSession["status"]): AgentEndpoint["state"] {
  switch (status) {
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "connecting":
      return "waiting";
    case "error":
    case "closed":
      return "offline";
  }

  return "offline";
}

function suggestedPairingSelector(session: PairingSession): string {
  const shortId = shortPairingSessionId(session.id);
  const baseHandle = pairingHandleBase(session);
  const handle = normalizePairingSlug(baseHandle, shortId) || `pairing-${shortId}`;
  return `@${handle}`;
}

export function buildPairingSessionCandidate(session: PairingSession): PairingSessionCandidate {
  const shortId = shortPairingSessionId(session.id);
  const displayName = pairingDisplayName(session, shortId);
  return {
    externalSessionId: session.id,
    name: displayName,
    adapterType: session.adapterType,
    status: session.status,
    cwd: session.cwd,
    model: session.model,
    providerMeta: session.providerMeta,
    suggestedSelector: suggestedPairingSelector(session),
  };
}

export function buildManagedPairingEndpointBinding(input: {
  agentId: string;
  nodeId: string;
  session: PairingSession;
  existingEndpoint?: AgentEndpoint | null;
  agentName?: string;
}): AgentEndpoint {
  const nodeSlug = normalizeAgentSelectorSegment(input.nodeId) || "local";
  const projectRoot = input.session.cwd?.trim() || undefined;
  const existingMetadata = input.existingEndpoint?.metadata ?? {};
  const attachedAt = typeof existingMetadata.attachedAt === "number"
    ? existingMetadata.attachedAt
    : Date.now();

  return {
    id: input.existingEndpoint?.id ?? `endpoint.${input.agentId}.${nodeSlug}.pairing`,
    agentId: input.agentId,
    nodeId: input.nodeId,
    harness: pairingHarness(input.session.adapterType),
    transport: "pairing_bridge",
    state: pairingEndpointState(input.session.status),
    cwd: projectRoot,
    projectRoot,
    sessionId: input.session.id,
    metadata: {
      ...existingMetadata,
      source: "pairing-session",
      managedByScout: true,
      sessionBacked: true,
      externalSessionId: input.session.id,
      pairingSessionId: input.session.id,
      pairingAdapterType: input.session.adapterType,
      projectRoot,
      sessionName: input.session.name ?? buildPairingSessionCandidate(input.session).name,
      model: input.session.model,
      providerMeta: input.session.providerMeta,
      attachedAt,
      lastSeenAt: Date.now(),
      stalePairingSession: false,
      agentName: input.agentName ?? (
        typeof existingMetadata.agentName === "string" && existingMetadata.agentName.trim().length > 0
          ? String(existingMetadata.agentName)
          : input.agentId
      ),
    },
  };
}

export async function listPairingSessions(
  options: PairingSessionDiscoveryOptions = {},
): Promise<PairingSession[]> {
  const port = resolvePairingBridgePort(options);
  if (!port) {
    return [];
  }

  return withPairingBridgeClient(
    { ...options, port },
    async (client) => client.query<PairingSession[]>("session.list"),
  );
}

export async function getPairingSessionSnapshot(
  sessionId: string,
  options: PairingSessionDiscoveryOptions = {},
): Promise<PairingSessionState | null> {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) {
    return null;
  }

  try {
    return await withPairingBridgeClient(
      options,
      async (client) => client.query<PairingSessionState>("session.snapshot", { sessionId: trimmedSessionId }),
    );
  } catch {
    return null;
  }
}

/** Every open session's snapshot, read over one bridge connection. */
export async function listPairingSessionSnapshots(
  options: PairingSessionDiscoveryOptions = {},
): Promise<PairingSessionState[]> {
  const port = resolvePairingBridgePort(options);
  if (!port) {
    return [];
  }

  return withPairingBridgeClient({ ...options, port }, async (client) => {
    const sessions = await client.query<PairingSession[]>("session.list");
    const snapshots = await Promise.all(sessions
      .filter((session) => session.status !== "closed")
      .map((session) => client
        .query<PairingSessionState>("session.snapshot", { sessionId: session.id })
        .catch(() => null)));
    return snapshots.filter((snapshot): snapshot is PairingSessionState => snapshot !== null);
  });
}

/** Answers one pending action approval through the bridge's own decide path. */
export async function decidePairingApproval(
  input: { sessionId: string; turnId: string; blockId: string; version: number; decision: "approve" | "deny"; reason?: string },
  options: PairingSessionDiscoveryOptions = {},
): Promise<void> {
  await withPairingBridgeClient(options, (client) => client.mutation<{ ok: true }>("actionDecide", {
    sessionId: input.sessionId,
    turnId: input.turnId,
    blockId: input.blockId,
    version: input.version,
    decision: input.decision,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  }));
}

export async function findPairingSession(
  sessionId: string,
  options: PairingSessionDiscoveryOptions = {},
): Promise<PairingSession | null> {
  const snapshot = await getPairingSessionSnapshot(sessionId, options);
  if (snapshot) {
    return snapshot.session;
  }

  const sessions = await listPairingSessions(options);
  return sessions.find((session) => session.id === sessionId) ?? null;
}

function pairingSessionThreadId(session: PairingSession): string | null {
  const providerMeta = session.providerMeta;
  if (!providerMeta || typeof providerMeta !== "object") {
    return null;
  }

  for (const key of ["threadId", "requestedThreadId", "externalSessionId"]) {
    const value = providerMeta[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

export async function ensurePairingSessionForCodexThread(
  input: EnsurePairingSessionForCodexThreadInput,
  options: PairingSessionDiscoveryOptions = {},
): Promise<PairingSession> {
  const threadId = input.threadId.trim();
  if (!threadId) {
    throw new Error("threadId is required");
  }

  return withPairingBridgeClient(options, async (client) => {
    const sessions = await client.query<PairingSession[]>("session.list");
    const existing = sessions.find((session) => (
      session.adapterType.trim().toLowerCase() === "codex"
      && pairingSessionThreadId(session) === threadId
    ));
    if (existing) {
      return existing;
    }

    return client.mutation<PairingSession>("session.create", {
      adapterType: "codex",
      name: input.name,
      cwd: input.cwd,
      options: {
        threadId,
        requireExistingThread: true,
        ...(input.systemPrompt?.trim()
          ? { systemPrompt: input.systemPrompt.trim() }
          : {}),
      },
    });
  });
}

export async function ensurePairingSessionForAdapter(
  input: EnsurePairingSessionForAdapterInput,
  options: PairingSessionDiscoveryOptions = {},
): Promise<PairingSession> {
  const adapterType = input.adapterType.trim();
  if (!adapterType) {
    throw new Error("adapterType is required");
  }

  return withPairingBridgeClient(options, async (client) =>
    client.mutation<PairingSession>("session.create", {
      adapterType,
      name: input.name,
      cwd: input.cwd,
      ...(input.options ? { options: input.options } : {}),
    })
  );
}

function truncateSyntheticOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_SYNTHETIC_OUTPUT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SYNTHETIC_OUTPUT_CHARS - 1).trimEnd()}…`;
}

function actionApprovalSummary(block: PairingActionBlock): string {
  const approval = block.action.approval;
  if (approval?.description?.trim()) {
    return `Waiting for approval: ${approval.description.trim()}`;
  }

  switch (block.action.kind) {
    case "command":
      return `Waiting for approval: run \`${block.action.command}\``;
    case "file_change":
      return `Waiting for approval: edit ${block.action.path}`;
    case "tool_call":
      return `Waiting for approval: use ${block.action.toolName}`;
    case "subagent":
      return `Waiting for approval: launch ${block.action.agentName ?? block.action.agentId}`;
  }

  return "Waiting for approval.";
}

function questionSummary(block: PairingQuestionBlock): string {
  return `Waiting for input: ${block.question.trim()}`;
}

function turnRequiresAttention(turn: PairingTurnState): boolean {
  return turn.blocks.some(({ block }) => (
    (block.type === "question" && block.questionStatus === "awaiting_answer")
    || (block.type === "action" && block.action.status === "awaiting_approval")
  ));
}

function summarizeTurn(turn: PairingTurnState): {
  text: string | null;
  errors: string[];
  attention: string[];
} {
  const textParts: string[] = [];
  const fallbackParts: string[] = [];
  const errorParts: string[] = [];
  const attentionParts: string[] = [];

  for (const blockState of turn.blocks) {
    const block = blockState.block;
    switch (block.type) {
      case "text": {
        const next = block.text.trim();
        if (next) {
          textParts.push(next);
        }
        break;
      }
      case "error": {
        const next = block.message.trim();
        if (next) {
          errorParts.push(next);
        }
        break;
      }
      case "question":
        if (block.questionStatus === "awaiting_answer") {
          attentionParts.push(questionSummary(block));
        }
        break;
      case "action":
        if (block.action.status === "awaiting_approval") {
          attentionParts.push(actionApprovalSummary(block));
        }
        if (block.action.output.trim()) {
          fallbackParts.push(truncateSyntheticOutput(block.action.output));
        }
        break;
      case "file":
        if (block.name?.trim()) {
          fallbackParts.push(`Produced file: ${block.name.trim()}`);
        }
        break;
      default:
        break;
    }
  }

  const primaryText = textParts.length > 0
    ? textParts.join("\n\n")
    : (fallbackParts.length > 0 ? fallbackParts.join("\n\n") : null);

  return {
    text: primaryText,
    errors: errorParts,
    attention: attentionParts,
  };
}

function completedTurnOutput(turn: PairingTurnState): string {
  const summary = summarizeTurn(turn);
  const parts = [
    summary.text,
    summary.attention.length > 0 ? summary.attention.join("\n") : null,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  if (parts.length > 0) {
    return parts.join("\n\n");
  }

  return "The live session completed without a text reply.";
}

function runningTurnOutput(turn: PairingTurnState): string {
  const summary = summarizeTurn(turn);
  const liveTraceNote = "The live session is still running. Open the trace to follow or continue it.";
  const parts = [
    summary.text,
    summary.attention.length > 0 ? summary.attention.join("\n") : null,
    liveTraceNote,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));
  return parts.join("\n\n");
}

function failedTurnError(turn: PairingTurnState): string {
  const summary = summarizeTurn(turn);
  if (summary.errors.length > 0) {
    return summary.errors.join("\n\n");
  }
  if (summary.text) {
    return summary.text;
  }
  return "The live session failed to complete the requested turn.";
}

function invocationTurn(
  snapshot: PairingSessionState,
  priorTurnIds: Set<string>,
  currentTurnId?: string | null,
): PairingTurnState | null {
  if (currentTurnId) {
    const current = snapshot.turns.find((turn) => turn.id === currentTurnId);
    if (current) {
      return current;
    }
  }

  const addedTurns = snapshot.turns.filter((turn) => !priorTurnIds.has(turn.id));
  if (addedTurns.length > 0) {
    return addedTurns[addedTurns.length - 1] ?? null;
  }

  return null;
}

function terminalTurn(turn: PairingTurnState): boolean {
  return turn.status === "completed" || turn.status === "interrupted" || turn.status === "error";
}

function endpointMetadataString(endpoint: AgentEndpoint, key: string): string | null {
  const value = endpoint.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function endpointMetadataBoolean(endpoint: AgentEndpoint, key: string): boolean {
  return endpoint.metadata?.[key] === true;
}

function useDirectSessionTaskPrompt(endpoint: AgentEndpoint, invocation: InvocationRequest): boolean {
  if (invocation.action !== "consult") {
    return false;
  }

  const sessionBacked = endpointMetadataBoolean(endpoint, "sessionBacked");
  if (sessionBacked) {
    return true;
  }

  const source = endpointMetadataString(endpoint, "source");
  const externalSource = endpointMetadataString(endpoint, "externalSource");
  const attachedTransport = endpointMetadataString(endpoint, "attachedTransport");
  const isLocalSession = source === "local-session" || externalSource === "local-session";
  const isLocalRuntimeAttachment = attachedTransport === "codex_app_server" || attachedTransport === "claude_stream_json";

  return isLocalSession || isLocalRuntimeAttachment;
}

function pairingInvocationPrompt(endpoint: AgentEndpoint, agentName: string, invocation: InvocationRequest): string {
  if (useDirectSessionTaskPrompt(endpoint, invocation)) {
    return invocation.task;
  }

  return buildLocalAgentDirectInvocationPrompt(agentName, invocation);
}

async function readPairingSnapshot(client: PairingBridgeClient, sessionId: string): Promise<PairingSessionState> {
  return client.query<PairingSessionState>("session.snapshot", { sessionId });
}

export async function invokePairingSessionEndpoint(
  endpoint: AgentEndpoint,
  invocation: InvocationRequest,
  options: PairingInvocationOptions = {},
): Promise<PairingInvocationResult> {
  const sessionId = endpoint.sessionId?.trim();
  if (!sessionId) {
    throw new Error(`Endpoint ${endpoint.id} is missing a pairing session id.`);
  }

  const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? DEFAULT_PAIRING_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? invocation.timeoutMs ?? DEFAULT_PAIRING_INVOCATION_TIMEOUT_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const agentName = String(endpoint.metadata?.agentName ?? endpoint.metadata?.definitionId ?? endpoint.agentId);

  return withPairingBridgeClient(options, async (client) => {
    const before = await readPairingSnapshot(client, sessionId);
    const priorTurnIds = new Set<string>(before.turns.map((turn) => turn.id));
    const prompt = pairingInvocationPrompt(endpoint, agentName, invocation);

    await client.mutation<{ ok: boolean }>("prompt.send", {
      sessionId,
      text: prompt,
    });

    const deadline = Date.now() + timeoutMs;
    let observedTurn: PairingTurnState | null = null;

    while (Date.now() <= deadline) {
      const snapshot = await readPairingSnapshot(client, sessionId);
      const nextTurn = invocationTurn(snapshot, priorTurnIds, observedTurn?.id);
      if (nextTurn) {
        observedTurn = nextTurn;
      }

      if (observedTurn) {
        if (observedTurn.status === "error") {
          throw new Error(failedTurnError(observedTurn));
        }
        if (turnRequiresAttention(observedTurn) || terminalTurn(observedTurn)) {
          return {
            output: completedTurnOutput(observedTurn),
          };
        }
      }

      await sleep(pollIntervalMs);
    }

    if (observedTurn) {
      return {
        output: runningTurnOutput(observedTurn),
      };
    }

    return {
      output: "The prompt was delivered to the live session, but it has not surfaced a new observable turn yet. Open the trace to continue.",
    };
  });
}
