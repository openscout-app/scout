import { bindManagedPermissionRequester } from "./managed-permission.js";
import type { RuntimeEnv } from "./portable-types.js";
import { lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { readCodexRolloutUsageObservation } from "@openscout/agent-sessions/adapters/codex/usage";
import type {
  ActionBlock,
  BlockState,
  ReasoningBlock,
  SessionState,
  TextBlock,
  TurnState,
} from "@openscout/agent-sessions";
import { CodexObservedTopologyTracker } from "@openscout/agent-sessions/adapters/codex/topology";
import { OBSERVED_HARNESS_TOPOLOGY_META_KEY } from "@openscout/agent-sessions/protocol/primitives";
import {
  CodexAppServerExitError,
  CodexThreadHeldExternallyError,
  ensureCodexAppServerLocalAgentOnline,
  interruptCodexAppServerLocalAgent,
  invokeCodexAppServerLocalAgent,
  isCodexAppServerExitError,
  isCodexThreadHeldExternallyError,
  isCodexAppServerLocalAgentAlive,
  normalizeCodexAppServerLaunchArgs,
  readCodexAppServerModelFromLaunchArgs,
  readCodexAppServerReasoningEffortFromLaunchArgs,
  sendCodexAppServerLocalAgent,
  shutdownCodexAppServerLocalAgent,
  startCodexAppServerLocalAgent,
  steerCodexAppServerLocalAgent,
  type CodexAppServerInvocationOptions,
  type CodexAppServerExitKind,
  type CodexAppServerIdentity,
  type CodexAppServerSessionOptions,
  type CodexAppServerTurnResult,
  type CodexAppServerShutdownOptions,
  type CodexAppServerSteerOptions,
} from "@openscout/agent-sessions/local";
import { epochMs } from "@openscout/protocol";
import { buildManagedAgentEnvironment } from "./managed-agent-environment.js";
import type { CodexApprovalPolicy, CodexSandboxMode } from "./permission-policy.js";

export {
  resolveCodexExecutableCandidates,
  resolveCodexExecutableInventory,
} from "@openscout/agent-sessions/codex-executable";

export {
  CodexAppServerExitError,
  CodexThreadHeldExternallyError,
  isCodexAppServerExitError,
  isCodexThreadHeldExternallyError,
  normalizeCodexAppServerLaunchArgs,
  readCodexAppServerModelFromLaunchArgs,
  readCodexAppServerReasoningEffortFromLaunchArgs,
};
export type {
  CodexAppServerExitKind,
  CodexAppServerIdentity,
  CodexAppServerShutdownOptions,
};

type SessionRequestOptions = CodexAppServerSessionOptions & {
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
  crewRole?: string;
};

type InvocationOptions = CodexAppServerInvocationOptions & SessionRequestOptions;
type SteerOptions = CodexAppServerSteerOptions & SessionRequestOptions;
type InterruptOptions = SessionRequestOptions;

export type CodexSessionSnapshotOptions = Pick<
  SessionRequestOptions,
  "agentName" | "sessionId" | "cwd"
>;

function isCodexThreadGlobalMessage(message: Record<string, unknown>): boolean {
  const result = message.result as Record<string, unknown> | undefined;
  const thread = result?.thread as Record<string, unknown> | undefined;
  return typeof thread?.id === "string";
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function metadataRecord(metadata: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

async function readOptionalJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readOptionalFile(filePath);
  return raw ? parseJsonRecord(raw) : null;
}

const CODEX_ROLLOUT_STALE_ACTIVE_TURN_MS = 10 * 60 * 1000;

type CodexRolloutSnapshotProjectionOptions = {
  nowMs?: number;
  staleActiveTurnMs?: number;
};

function codexThreadStatusToSessionStatus(status: string | undefined): SessionState["session"]["status"] {
  switch (status) {
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "error":
      return "error";
    default:
      return "connecting";
  }
}

function codexTurnStatusToTurnStatus(status: string | undefined): TurnState["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "error";
    default:
      return "streaming";
  }
}

function stringifyCodexItem(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseCodexTimestamp(value: unknown): number | undefined {
  const parsedEpoch = epochMs(value);
  if (parsedEpoch !== null) {
    return parsedEpoch;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function parseCodexMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function extractCodexReasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const content = Array.isArray(item.content) ? item.content : [];

  const summaryText = summary
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.summary === "string") {
        return record.summary;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  const contentText = content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      const record = entry as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");

  return [summaryText, contentText].filter(Boolean).join("\n\n").trim();
}

function extractCodexMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      const record = entry as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function extractCodexUserMessageText(item: Record<string, unknown>): string {
  const text = extractCodexMessageText(item);
  if (text) {
    return text;
  }
  return typeof item.text === "string" ? item.text.trim() : "";
}

function renderCodexActionOutput(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }

  if (item.action !== undefined) {
    return stringifyCodexItem(item.action);
  }

  return stringifyCodexItem(item);
}

function buildCodexActionBlock(
  item: Record<string, unknown>,
  turnId: string,
  index: number,
): ActionBlock {
  return {
    id: typeof item.id === "string" ? item.id : `${turnId}:action:${index}`,
    turnId,
    index,
    type: "action",
    status: "streaming",
    action: {
      kind: "tool_call",
      toolName: typeof item.type === "string" ? item.type : "unknown",
      toolCallId: typeof item.id === "string" ? item.id : `${turnId}:action:${index}`,
      input: item,
      output: "",
      status: "running",
    },
  };
}

function buildCodexRolloutActionBlock(
  item: Record<string, unknown>,
  turnId: string,
  index: number,
): ActionBlock {
  const itemType = typeof item.type === "string" ? item.type : "tool_call";
  const toolCallId = typeof item.call_id === "string"
    ? item.call_id
    : `${turnId}:action:${index}`;
  const toolName = typeof item.name === "string"
    ? item.name
    : itemType === "web_search_call"
      ? "web_search"
      : itemType;
  const input = itemType === "function_call"
    ? parseCodexMaybeJson(item.arguments)
    : itemType === "custom_tool_call"
      ? item.input
      : item;

  return {
    id: toolCallId,
    turnId,
    index,
    type: "action",
    status: "streaming",
    action: {
      kind: "tool_call",
      toolName,
      toolCallId,
      input,
      output: "",
      status: "running",
    },
  };
}

function finalizeCodexTurnBlocks(
  turn: TurnState & { nextBlockIndex: number },
  status: "completed" | "interrupted" | "error",
): void {
  for (const blockState of turn.blocks) {
    if (blockState.status === "completed") {
      continue;
    }

    blockState.status = "completed";
    blockState.block.status = "completed";
    if (blockState.block.type === "action") {
      blockState.block.action.status = status === "completed" ? "completed" : "failed";
    }
  }
}

function setCodexProviderMeta(
  snapshot: SessionState,
  threadId: string | null,
  threadPath: string | null,
): void {
  if (!threadId && !threadPath) {
    return;
  }

  snapshot.session.providerMeta = {
    ...(snapshot.session.providerMeta ?? {}),
    ...(threadId ? { threadId } : {}),
    ...(threadPath ? { threadPath } : {}),
  };
}

function ensureCodexProviderMetaRecord(
  snapshot: SessionState,
  key: string,
): Record<string, unknown> {
  const providerMeta = snapshot.session.providerMeta && typeof snapshot.session.providerMeta === "object"
    ? snapshot.session.providerMeta
    : {};
  snapshot.session.providerMeta = providerMeta;

  const existing = metadataRecord(providerMeta, key);
  if (existing) {
    return existing;
  }

  const next: Record<string, unknown> = {};
  providerMeta[key] = next;
  return next;
}

function setObserveString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    target[key] = value.trim();
  }
}

function setObserveNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

export function buildCodexAppServerSessionSnapshot(
  raw: string,
  options: CodexSessionSnapshotOptions,
  targetThreadId?: string | null,
): SessionState | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let resolvedThreadId = targetThreadId?.trim() || null;
  if (!resolvedThreadId) {
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        const resultThread = (message.result as Record<string, unknown> | undefined)?.thread as Record<string, unknown> | undefined;
        const paramsThread = (message.params as Record<string, unknown> | undefined)?.thread as Record<string, unknown> | undefined;
        const params = message.params as Record<string, unknown> | undefined;
        const nextThreadId = typeof resultThread?.id === "string"
          ? resultThread.id
          : typeof paramsThread?.id === "string"
            ? paramsThread.id
            : typeof params?.threadId === "string"
              ? params.threadId
            : null;
        if (nextThreadId) {
          resolvedThreadId = nextThreadId;
        }
      } catch {
        // Ignore malformed lines in snapshot mode.
      }
    }
  }

  const snapshot: SessionState = {
    session: {
      id: options.sessionId,
      name: options.agentName,
      adapterType: "codex_app_server",
      status: resolvedThreadId ? "idle" : "connecting",
      cwd: options.cwd,
      providerMeta: resolvedThreadId ? { threadId: resolvedThreadId } : undefined,
    },
    turns: [],
  };

  const turnsById = new Map<string, TurnState & { nextBlockIndex: number }>();
  const blocksById = new Map<string, BlockState>();
  const topologyTracker = new CodexObservedTopologyTracker({
    cwd: options.cwd,
    threadId: resolvedThreadId,
    sessionName: options.agentName,
  });

  const ensureTurn = (turnId: string) => {
    const existing = turnsById.get(turnId);
    if (existing) {
      return existing;
    }

    const turn: TurnState & { nextBlockIndex: number } = {
      id: turnId,
      status: "streaming",
      blocks: [],
      startedAt: Date.now(),
      nextBlockIndex: 0,
    };
    turnsById.set(turnId, turn);
    snapshot.turns.push(turn);
    snapshot.currentTurnId = turnId;
    snapshot.session.status = "active";
    return turn;
  };

  const completeBlock = (blockState: BlockState | undefined) => {
    if (!blockState) {
      return;
    }

    blockState.status = "completed";
    blockState.block.status = "completed";
  };

  for (const line of lines) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const params = message.params as Record<string, unknown> | undefined;
    const result = message.result as Record<string, unknown> | undefined;
    const paramsThread = params?.thread as Record<string, unknown> | undefined;
    const resultThread = result?.thread as Record<string, unknown> | undefined;
    const lineThreadId = typeof params?.threadId === "string"
      ? params.threadId
      : typeof paramsThread?.id === "string"
        ? paramsThread.id
        : typeof resultThread?.id === "string"
          ? resultThread.id
          : null;
    if (resolvedThreadId) {
      if (lineThreadId && lineThreadId !== resolvedThreadId) {
        continue;
      }
      if (!lineThreadId && !isCodexThreadGlobalMessage(message)) {
        continue;
      }
    }

    const resultModel = typeof result?.model === "string" ? result.model : null;
    if (resultThread && resultModel) {
      snapshot.session.model = resultModel;
    }
    if (typeof resultThread?.path === "string") {
      snapshot.session.providerMeta = {
        ...(snapshot.session.providerMeta ?? {}),
        threadId: resolvedThreadId ?? resultThread.id,
        threadPath: resultThread.path,
      };
    }
    if (typeof resultThread?.cwd === "string") {
      snapshot.session.cwd = resultThread.cwd;
    }
    if (resultThread) {
      topologyTracker.updateThread(resultThread);
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      if (paramsThread) {
        topologyTracker.updateThread(paramsThread);
      }
      if (typeof paramsThread?.path === "string") {
        snapshot.session.providerMeta = {
          ...(snapshot.session.providerMeta ?? {}),
          threadId: resolvedThreadId ?? paramsThread.id,
          threadPath: paramsThread.path,
        };
      }
      if (typeof paramsThread?.cwd === "string") {
        snapshot.session.cwd = paramsThread.cwd;
      }
      if (typeof paramsThread?.name === "string" && paramsThread.name.trim()) {
        snapshot.session.name = paramsThread.name;
      }
      continue;
    }

    if (message.method === "thread/status/changed") {
      const status = (params?.status as Record<string, unknown> | undefined)?.type;
      snapshot.session.status = codexThreadStatusToSessionStatus(typeof status === "string" ? status : undefined);
      continue;
    }

    if (message.method === "turn/started") {
      const turn = params?.turn as Record<string, unknown> | undefined;
      if (typeof turn?.id === "string") {
        ensureTurn(turn.id);
      }
      continue;
    }

    if (message.method === "item/started") {
      const item = params?.item as Record<string, unknown> | undefined;
      const turnId = typeof params?.turnId === "string" ? params.turnId : null;
      const itemType = typeof item?.type === "string" ? item.type : "";
      const itemId = typeof item?.id === "string" ? item.id : null;
      if (!turnId || !item || !itemId || !itemType) {
        continue;
      }
      topologyTracker.observeItem(item, "started");

      const turn = ensureTurn(turnId);
      if (itemType === "userMessage") {
        const block: TextBlock = {
          id: itemId,
          turnId,
          index: turn.nextBlockIndex++,
          type: "text",
          text: extractCodexUserMessageText(item),
          status: "streaming",
        };
        const blockState: BlockState = { block, status: "streaming" };
        turn.blocks.push(blockState);
        blocksById.set(itemId, blockState);
        continue;
      }

      if (itemType === "agentMessage") {
        const block: TextBlock = {
          id: itemId,
          turnId,
          index: turn.nextBlockIndex++,
          type: "text",
          text: typeof item.text === "string" ? item.text : "",
          status: "streaming",
        };
        const blockState: BlockState = { block, status: "streaming" };
        turn.blocks.push(blockState);
        blocksById.set(itemId, blockState);
        continue;
      }

      if (itemType === "reasoning") {
        const text = extractCodexReasoningText(item);
        if (!text) {
          continue;
        }

        const block: ReasoningBlock = {
          id: itemId,
          turnId,
          index: turn.nextBlockIndex++,
          type: "reasoning",
          text,
          status: "streaming",
        };
        const blockState: BlockState = { block, status: "streaming" };
        turn.blocks.push(blockState);
        blocksById.set(itemId, blockState);
        continue;
      }

      const block = buildCodexActionBlock(item, turnId, turn.nextBlockIndex++);
      const blockState: BlockState = { block, status: "streaming" };
      turn.blocks.push(blockState);
      blocksById.set(block.id, blockState);
      continue;
    }

    if (message.method === "item/agentMessage/delta") {
      const itemId = typeof params?.itemId === "string" ? params.itemId : null;
      const delta = typeof params?.delta === "string" ? params.delta : "";
      const blockState = itemId ? blocksById.get(itemId) : undefined;
      if (blockState?.block.type === "text") {
        (blockState.block as TextBlock).text += delta;
      }
      continue;
    }

    if (message.method === "item/completed") {
      const item = params?.item as Record<string, unknown> | undefined;
      const turnId = typeof params?.turnId === "string" ? params.turnId : null;
      const itemType = typeof item?.type === "string" ? item.type : "";
      const itemId = typeof item?.id === "string" ? item.id : null;
      if (!turnId || !item || !itemId || !itemType) {
        continue;
      }
      topologyTracker.observeItem(item, "completed");

      if (itemType === "userMessage") {
        const turn = ensureTurn(turnId);
        let blockState = blocksById.get(itemId);
        if (!blockState) {
          const block: TextBlock = {
            id: itemId,
            turnId,
            index: turn.nextBlockIndex++,
            type: "text",
            text: "",
            status: "streaming",
          };
          blockState = { block, status: "streaming" };
          turn.blocks.push(blockState);
          blocksById.set(itemId, blockState);
        }
        if (blockState.block.type === "text") {
          (blockState.block as TextBlock).text = extractCodexUserMessageText(item);
        }
        completeBlock(blockState);
        continue;
      }

      if (itemType === "agentMessage") {
        const turn = ensureTurn(turnId);
        let blockState = blocksById.get(itemId);
        if (!blockState) {
          const block: TextBlock = {
            id: itemId,
            turnId,
            index: turn.nextBlockIndex++,
            type: "text",
            text: "",
            status: "streaming",
          };
          blockState = { block, status: "streaming" };
          turn.blocks.push(blockState);
          blocksById.set(itemId, blockState);
        }
        if (blockState.block.type === "text" && typeof item.text === "string" && item.text.length > 0) {
          (blockState.block as TextBlock).text = item.text;
        }
        completeBlock(blockState);
        continue;
      }

      if (itemType === "reasoning") {
        const text = extractCodexReasoningText(item);
        if (!text) {
          continue;
        }

        const turn = ensureTurn(turnId);
        let blockState = blocksById.get(itemId);
        if (!blockState) {
          const block: ReasoningBlock = {
            id: itemId,
            turnId,
            index: turn.nextBlockIndex++,
            type: "reasoning",
            text,
            status: "streaming",
          };
          blockState = { block, status: "streaming" };
          turn.blocks.push(blockState);
          blocksById.set(itemId, blockState);
        }
        if (blockState.block.type === "reasoning" && text) {
          (blockState.block as ReasoningBlock).text = text;
        }
        completeBlock(blockState);
        continue;
      }

      const turn = ensureTurn(turnId);
      let blockState = blocksById.get(itemId);
      if (!blockState) {
        const block = buildCodexActionBlock(item, turnId, turn.nextBlockIndex++);
        blockState = { block, status: "streaming" };
        turn.blocks.push(blockState);
        blocksById.set(itemId, blockState);
      }
      if (blockState.block.type === "action") {
        blockState.block.action.output = renderCodexActionOutput(item);
        blockState.block.action.status = "completed";
      }
      completeBlock(blockState);
      continue;
    }

    if (message.method === "turn/completed") {
      const turn = params?.turn as Record<string, unknown> | undefined;
      if (!turn || typeof turn.id !== "string") {
        continue;
      }

      const turnState = ensureTurn(turn.id);
      turnState.status = codexTurnStatusToTurnStatus(typeof turn.status === "string" ? turn.status : undefined);
      turnState.endedAt = Date.now();
      if (snapshot.currentTurnId === turn.id) {
        snapshot.currentTurnId = undefined;
      }
      snapshot.session.status = turnState.status === "error" ? "error" : "idle";
      continue;
    }

    if (message.method === "error") {
      snapshot.session.status = "error";
    }
  }

  if (!resolvedThreadId && snapshot.turns.length === 0) {
    return null;
  }

  const topology = topologyTracker.toTopology();
  if (topology) {
    snapshot.session.providerMeta = {
      ...(snapshot.session.providerMeta ?? {}),
      [OBSERVED_HARNESS_TOPOLOGY_META_KEY]: topology,
    };
  }

  return snapshot;
}

export function buildCodexRolloutSessionSnapshot(
  raw: string,
  options: CodexSessionSnapshotOptions,
  targetThreadId?: string | null,
  rolloutPath?: string | null,
  projectionOptions: CodexRolloutSnapshotProjectionOptions = {},
): SessionState | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let resolvedThreadId = targetThreadId?.trim() || null;
  const snapshot: SessionState = {
    session: {
      id: options.sessionId,
      name: options.agentName,
      adapterType: "codex_app_server",
      status: resolvedThreadId ? "idle" : "connecting",
      cwd: options.cwd,
    },
    turns: [],
  };
  setCodexProviderMeta(snapshot, resolvedThreadId, rolloutPath ?? null);

  const turnsById = new Map<string, TurnState & { nextBlockIndex: number }>();
  const blocksByCallId = new Map<string, BlockState>();
  let currentTurnId: string | null = null;
  let lastObservedAt: number | null = null;
  let previousInputTokens: number | undefined;

  const ensureTurn = (turnId: string, startedAt?: number) => {
    const existing = turnsById.get(turnId);
    if (existing) {
      if (startedAt && !existing.startedAt) {
        existing.startedAt = startedAt;
      }
      return existing;
    }

    const turn: TurnState & { nextBlockIndex: number } = {
      id: turnId,
      status: "streaming",
      blocks: [],
      startedAt: startedAt ?? Date.now(),
      nextBlockIndex: 0,
    };
    turnsById.set(turnId, turn);
    snapshot.turns.push(turn);
    snapshot.currentTurnId = turnId;
    snapshot.session.status = "active";
    return turn;
  };

  for (const line of lines) {
    const message = parseJsonRecord(line);
    if (!message) {
      continue;
    }

    const timestamp = parseCodexTimestamp(message.timestamp) ?? Date.now();
    lastObservedAt = timestamp;
    const entryType = typeof message.type === "string" ? message.type : "";
    const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
      ? message.payload as Record<string, unknown>
      : undefined;
    if (!payload) {
      continue;
    }

    if (entryType === "session_meta") {
      const sessionThreadId = typeof payload.id === "string" ? payload.id : null;
      if (sessionThreadId) {
        if (resolvedThreadId && sessionThreadId !== resolvedThreadId) {
          return null;
        }
        resolvedThreadId = sessionThreadId;
      }
      if (typeof payload.cwd === "string" && payload.cwd.trim()) {
        snapshot.session.cwd = payload.cwd;
      }
      setCodexProviderMeta(snapshot, resolvedThreadId, rolloutPath ?? null);
      snapshot.session.status = resolvedThreadId ? "idle" : snapshot.session.status;

      const runtime = ensureCodexProviderMetaRecord(snapshot, "observeRuntime");
      setObserveString(runtime, "originator", payload.originator);
      setObserveString(runtime, "cliVersion", payload.cli_version);
      setObserveString(runtime, "modelProvider", payload.model_provider);
      setObserveString(runtime, "source", typeof payload.source === "string" ? payload.source : undefined);
      const git = metadataRecord(payload, "git");
      setObserveString(runtime, "gitBranch", git?.branch);
      continue;
    }

    if (entryType === "turn_context") {
      if (typeof payload.cwd === "string" && payload.cwd.trim()) {
        snapshot.session.cwd = payload.cwd;
      }
      if (typeof payload.model === "string" && payload.model.trim()) {
        snapshot.session.model = payload.model;
      }

      const runtime = ensureCodexProviderMetaRecord(snapshot, "observeRuntime");
      setObserveString(runtime, "approvalPolicy", payload.approval_policy);
      setObserveString(runtime, "effort", payload.effort);
      if (typeof payload.effort === "string" && payload.effort.trim()) {
        snapshot.session.reasoningEffort = payload.effort.trim();
      }
      setObserveString(runtime, "timezone", payload.timezone);
      const sandboxPolicy = metadataRecord(payload, "sandbox_policy");
      setObserveString(runtime, "sandbox", sandboxPolicy?.type);
      continue;
    }

    if (entryType === "event_msg") {
      const payloadType = typeof payload.type === "string" ? payload.type : "";
      if (payloadType === "task_started") {
        const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
        if (!turnId) {
          continue;
        }
        currentTurnId = turnId;
        ensureTurn(turnId, parseCodexTimestamp(payload.started_at) ?? timestamp);
        snapshot.currentTurnId = turnId;
        snapshot.session.status = "active";

        const usage = ensureCodexProviderMetaRecord(snapshot, "observeUsage");
        setObserveNumber(usage, "contextWindowTokens", payload.model_context_window);
        continue;
      }

      if (payloadType === "token_count") {
        const observedUsage = readCodexRolloutUsageObservation(payload, timestamp);
        if (observedUsage) {
          const usage = ensureCodexProviderMetaRecord(snapshot, "observeUsage");
          const fallbackContextInputTokens = observedUsage.inputTokens === undefined || previousInputTokens === undefined
            ? undefined
            : observedUsage.inputTokens - previousInputTokens;
          const contextInputTokens = observedUsage.contextInputTokens !== undefined && observedUsage.contextInputTokens > 0
            ? observedUsage.contextInputTokens
            : fallbackContextInputTokens;
          if (
            contextInputTokens !== undefined
            && contextInputTokens > 0
            && (observedUsage.contextWindowTokens === undefined || contextInputTokens <= observedUsage.contextWindowTokens)
          ) {
            setObserveNumber(usage, "contextInputTokens", contextInputTokens);
          }
          previousInputTokens = observedUsage.inputTokens ?? previousInputTokens;
          setObserveNumber(usage, "inputTokens", observedUsage.inputTokens);
          setObserveNumber(usage, "cacheReadInputTokens", observedUsage.cacheReadInputTokens);
          setObserveNumber(usage, "cacheCreationInputTokens", observedUsage.cacheCreationInputTokens);
          setObserveNumber(usage, "outputTokens", observedUsage.outputTokens);
          setObserveNumber(usage, "reasoningOutputTokens", observedUsage.reasoningOutputTokens);
          setObserveNumber(usage, "totalTokens", observedUsage.totalTokens);
          setObserveNumber(usage, "contextWindowTokens", observedUsage.contextWindowTokens);
          setObserveString(usage, "planType", observedUsage.planType);
        }
        if (observedUsage?.quotaWindows.length) {
          const quota = ensureCodexProviderMetaRecord(snapshot, "observeQuota");
          setObserveString(quota, "provider", "openai");
          setObserveString(quota, "planType", observedUsage.planType);
          setObserveNumber(quota, "capturedAt", timestamp);
          quota.windows = observedUsage.quotaWindows;
        }
      }

      if (payloadType === "task_complete" || payloadType === "turn_aborted") {
        const turnId: string | null = typeof payload.turn_id === "string" ? payload.turn_id : currentTurnId;
        if (!turnId) {
          continue;
        }

        const turn = ensureTurn(turnId);
        turn.status = payloadType === "task_complete"
          ? "completed"
          : payload.reason === "interrupted"
            ? "interrupted"
            : "error";
        turn.endedAt = parseCodexTimestamp(payload.completed_at) ?? timestamp;
        finalizeCodexTurnBlocks(turn, turn.status);

        if (snapshot.currentTurnId === turnId) {
          snapshot.currentTurnId = undefined;
        }
        currentTurnId = currentTurnId === turnId ? null : currentTurnId;
        snapshot.session.status = turn.status === "error" ? "error" : "idle";
      }
      continue;
    }

    if (entryType !== "response_item" || !currentTurnId) {
      continue;
    }

    const turn = ensureTurn(currentTurnId);
    const payloadType = typeof payload.type === "string" ? payload.type : "";

    if (payloadType === "message" && payload.role === "user") {
      const text = extractCodexMessageText(payload);
      if (!text) {
        continue;
      }

      const block: TextBlock = {
        id: `${turn.id}:text:${turn.nextBlockIndex}`,
        turnId: turn.id,
        index: turn.nextBlockIndex++,
        type: "text",
        text,
        status: "completed",
      };
      turn.blocks.push({ block, status: "completed" });
      continue;
    }

    if (payloadType === "message" && payload.role === "assistant") {
      const text = extractCodexMessageText(payload);
      if (!text) {
        continue;
      }

      const block: TextBlock = {
        id: `${turn.id}:text:${turn.nextBlockIndex}`,
        turnId: turn.id,
        index: turn.nextBlockIndex++,
        type: "text",
        text,
        status: "completed",
      };
      turn.blocks.push({ block, status: "completed" });
      continue;
    }

    if (payloadType === "reasoning") {
      const text = extractCodexReasoningText(payload);
      if (!text) {
        continue;
      }

      const block: ReasoningBlock = {
        id: `${turn.id}:reasoning:${turn.nextBlockIndex}`,
        turnId: turn.id,
        index: turn.nextBlockIndex++,
        type: "reasoning",
        text,
        status: "completed",
      };
      turn.blocks.push({ block, status: "completed" });
      continue;
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "web_search_call") {
      const block = buildCodexRolloutActionBlock(payload, turn.id, turn.nextBlockIndex++);
      const blockState: BlockState = { block, status: "streaming" };
      turn.blocks.push(blockState);
      blocksByCallId.set(block.id, blockState);
      continue;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      if (!callId) {
        continue;
      }

      let blockState = blocksByCallId.get(callId);
      if (!blockState) {
        const block = buildCodexRolloutActionBlock({
          type: "tool_call",
          call_id: callId,
          name: "unknown",
        }, turn.id, turn.nextBlockIndex++);
        blockState = { block, status: "streaming" };
        turn.blocks.push(blockState);
        blocksByCallId.set(callId, blockState);
      }

      if (blockState.block.type === "action") {
        blockState.block.action.output = stringifyCodexItem(payload.output);
        blockState.block.action.status = "completed";
      }
      blockState.status = "completed";
      blockState.block.status = "completed";
    }
  }

  if (!resolvedThreadId && snapshot.turns.length === 0) {
    return null;
  }

  setCodexProviderMeta(snapshot, resolvedThreadId, rolloutPath ?? null);

  if (snapshot.currentTurnId && lastObservedAt !== null) {
    const staleActiveTurnMs = projectionOptions.staleActiveTurnMs ?? CODEX_ROLLOUT_STALE_ACTIVE_TURN_MS;
    const nowMs = projectionOptions.nowMs ?? Date.now();
    const turn = turnsById.get(snapshot.currentTurnId);
    const hasStreamingBlocks = turn?.blocks.some((blockState) => blockState.status !== "completed") ?? false;
    if (
      staleActiveTurnMs > 0
      && nowMs - lastObservedAt >= staleActiveTurnMs
      && turn
      && !hasStreamingBlocks
    ) {
      turn.status = "interrupted";
      turn.endedAt = lastObservedAt;
      finalizeCodexTurnBlocks(turn, "interrupted");
      snapshot.currentTurnId = undefined;
      snapshot.session.status = resolvedThreadId ? "idle" : snapshot.session.status;

      const runtime = ensureCodexProviderMetaRecord(snapshot, "observeRuntime");
      runtime.staleActiveTurn = true;
      runtime.staleActiveTurnMs = nowMs - lastObservedAt;
      runtime.staleActiveTurnReason = "No Codex rollout activity after an unfinished turn.";
    }
  }

  snapshot.session.status = snapshot.currentTurnId ? "active" : snapshot.session.status;
  return snapshot;
}

function withManagedCodexEnvironment<T extends SessionRequestOptions>(options: T): T {
  const baseEnv: RuntimeEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (typeof value === "string") {
      baseEnv[key] = value;
    } else {
      delete baseEnv[key];
    }
  }

  return {
    ...options,
    processEnv: buildManagedAgentEnvironment({
      agentName: options.agentName,
      currentDirectory: options.cwd,
      ...(options.crewRole ? { crewRole: options.crewRole } : {}),
      baseEnv,
    }),
  };
}

async function prepareManagedCodexAuthentication(options: SessionRequestOptions): Promise<void> {
  const codexHome = options.env?.CODEX_HOME?.trim();
  const authSource = options.env?.OPENSCOUT_CODEX_AUTH_SOURCE?.trim();
  if (!codexHome) return;
  await mkdir(codexHome, { recursive: true });
  // An ambient key may belong to another tool/provider. An explicit operator
  // auth source is authoritative unless this launch explicitly chooses API auth.
  if (!authSource || options.env?.OPENAI_API_KEY?.trim()) return;

  const authTarget = join(codexHome, "auth.json");
  try {
    await lstat(authTarget);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await lstat(authSource);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `background_codex_auth_unavailable: ${authSource} does not exist; `
        + "sign in to Codex or set OPENAI_API_KEY",
      );
    }
    throw error;
  }

  await mkdir(codexHome, { recursive: true });
  try {
    await symlink(authSource, authTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function withPreparedManagedCodexEnvironment<T extends SessionRequestOptions>(options: T): Promise<T> {
  // An attached app-server already has its own CODEX_HOME and auth; Scout's
  // environment never reaches it.
  if (options.connection?.mode === "attach") return options;
  await prepareManagedCodexAuthentication(options);
  const requestPermission = bindManagedPermissionRequester();
  return withManagedCodexEnvironment({ ...options,
    onPermissionRequest: async (request, controls) => {
      const params = request.params ?? {};
      const available = params.availableDecisions;
      const once = !Array.isArray(available) || available.includes("accept");
      const deny = !Array.isArray(available) || available.includes("decline") ? "decline"
        : available.includes("cancel") ? "cancel" : null;
      if (!once || !deny) return false;
      return requestPermission({
        sessionId: String(params.threadId), projectRoot: options.cwd,
        text: JSON.stringify({ method: request.method, ...params }, null, 2),
        version: `${params.threadId}:${params.turnId}:${request.id}`,
        // Codex offers acceptForSession, not a project-wide grant. Do not relabel it.
        decisions: ["once", "deny"], decisionLabels: { deny: deny === "cancel" ? "Cancel" : "Deny" }, isCurrent: async () => controls.isCurrent(),
        answer: async decision => { controls.respond({ decision: decision === "once" ? "accept" : deny }); },
      });
    },
  });
}

export async function ensureCodexAppServerAgentOnline(options: SessionRequestOptions): Promise<{
  threadId: string;
  durableThreadId: string | null;
  codexAppServer?: CodexAppServerIdentity | null;
}> {
  return ensureCodexAppServerLocalAgentOnline(await withPreparedManagedCodexEnvironment(options));
}

export async function invokeCodexAppServerAgent(options: InvocationOptions): Promise<CodexAppServerTurnResult> {
  return invokeCodexAppServerLocalAgent(await withPreparedManagedCodexEnvironment(options));
}

export async function sendCodexAppServerAgent(options: InvocationOptions): Promise<CodexAppServerTurnResult> {
  return sendCodexAppServerLocalAgent(await withPreparedManagedCodexEnvironment(options));
}

export async function startCodexAppServerAgent(
  options: InvocationOptions,
): Promise<{ threadId: string; turnId: string }> {
  return startCodexAppServerLocalAgent(await withPreparedManagedCodexEnvironment(options));
}

export async function steerCodexAppServerAgent(options: SteerOptions): Promise<void> {
  await steerCodexAppServerLocalAgent(await withPreparedManagedCodexEnvironment(options));
}

export async function interruptCodexAppServerAgent(options: InterruptOptions): Promise<void> {
  await interruptCodexAppServerLocalAgent(await withPreparedManagedCodexEnvironment(options));
}

export function isCodexAppServerAgentAlive(options: SessionRequestOptions): boolean {
  return isCodexAppServerLocalAgentAlive(options);
}

export async function getCodexAppServerAgentSnapshot(
  options: SessionRequestOptions,
): Promise<SessionState | null> {
  const stdoutLogPath = join(options.logsDirectory, "stdout.log");
  const threadIdPath = join(options.runtimeDirectory, "codex-thread-id.txt");
  const statePath = join(options.runtimeDirectory, "state.json");
  const [rawLog, persistedThreadId, persistedState] = await Promise.all([
    readOptionalFile(stdoutLogPath),
    readOptionalFile(threadIdPath),
    readOptionalJsonRecord(statePath),
  ]);
  const resolvedThreadId = options.threadId
    ?? persistedThreadId
    ?? metadataString(persistedState ?? undefined, "threadId")
    ?? undefined;
  const persistedThreadPath = metadataString(persistedState ?? undefined, "threadPath");

  if (persistedThreadPath) {
    const rawRollout = await readOptionalFile(persistedThreadPath);
    if (rawRollout) {
      const rolloutSnapshot = buildCodexRolloutSessionSnapshot(
        rawRollout,
        options,
        resolvedThreadId,
        persistedThreadPath,
      );
      if (rolloutSnapshot) {
        return rolloutSnapshot;
      }
    }
  }

  if (!rawLog) {
    return null;
  }

  return buildCodexAppServerSessionSnapshot(rawLog, options, resolvedThreadId);
}

export async function shutdownCodexAppServerAgent(
  options: SessionRequestOptions,
  shutdownOptions: CodexAppServerShutdownOptions = {},
): Promise<void> {
  await shutdownCodexAppServerLocalAgent(options, shutdownOptions);
}
