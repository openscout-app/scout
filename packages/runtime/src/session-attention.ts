import { attentionContextBeforeBlock, type AttentionContext } from "@openscout/agent-sessions";
import { normalizeApprovalRequest } from "@openscout/agent-sessions/protocol/approval-normalization";
import type {
  ActionBlock,
  NormalizedApprovalRequest,
  QuestionBlock,
  SessionState,
  TurnState,
} from "@openscout/agent-sessions";

export type SessionAttentionKind =
  | "question"
  | "approval"
  | "failed_action"
  | "failed_turn"
  | "session_error"
  | "native_attention";

export type SessionAttentionSeverity = "critical" | "warning" | "info";

export type SessionAttentionItem = {
  id: string;
  kind: SessionAttentionKind;
  title: string;
  summary: string | null;
  detail: string | null;
  sessionId: string;
  sessionName: string;
  adapterType: string;
  turnId: string | null;
  blockId: string | null;
  version: number | null;
  updatedAt: number;
  severity: SessionAttentionSeverity;
  sourceLabel: string;
  actionKind?: ActionBlock["action"]["kind"];
  approval?: NormalizedApprovalRequest;
  context?: AttentionContext | null;
};

export type ProjectSessionAttentionOptions = {
  now?: number;
  pendingApprovalIds?: Iterable<string>;
};

type NativeAttentionCandidate = {
  status: string;
  idPart: string;
  title: string | null;
  summary: string | null;
  detail: string | null;
  turnId: string | null;
  blockId: string | null;
  version: number | null;
  updatedAt: number | null;
  severity: SessionAttentionSeverity;
};

const BLOCKED_STATUS_PATTERN =
  /\b(blocked|needs[-_\s]?input|awaiting[-_\s]?(input|answer|approval)|waiting[-_\s]?for[-_\s]?(input|approval)|requires[-_\s]?action)\b/i;
const INACTIVE_ATTENTION_STATUS_PATTERN =
  /\b(cleared|resolved|complete|completed|done|idle|inactive|unblocked|dismissed|cancelled|canceled|answered|approved|denied|ok|healthy|ready)\b/i;

export function sessionApprovalAttentionId(
  sessionId: string,
  turnId: string,
  blockId: string,
  version: number,
): string {
  return `approval:${sessionId}:${turnId}:${blockId}:v${version}`;
}

export function projectSessionsAttention(
  snapshots: readonly SessionState[],
  options: ProjectSessionAttentionOptions = {},
): SessionAttentionItem[] {
  return sortSessionAttentionItems(
    snapshots.flatMap((snapshot) => projectSessionAttention(snapshot, options)),
  );
}

export function projectSessionAttention(
  snapshot: SessionState,
  options: ProjectSessionAttentionOptions = {},
): SessionAttentionItem[] {
  const now = options.now ?? Date.now();
  const pendingApprovalIds = new Set(options.pendingApprovalIds ?? []);
  const items: SessionAttentionItem[] = [];
  const recentTurnIds = recentAttentionTurnIds(snapshot);
  let projectedFailedTurn = false;

  for (const turn of snapshot.turns) {
    const updatedAt = turnUpdatedAt(turn, now);
    const isRecentAttentionTurn = recentTurnIds.has(turn.id);

    for (const blockState of turn.blocks) {
      const block = blockState.block;
      if (block.type === "question" && block.questionStatus === "awaiting_answer") {
        items.push(questionAttentionItem(snapshot, turn, block, updatedAt));
        continue;
      }

      if (block.type !== "action") {
        continue;
      }

      const approval = normalizeApprovalRequest(snapshot.session, turn.id, block);
      if (approval) {
        const id = sessionApprovalAttentionId(
          approval.sessionId,
          approval.turnId,
          approval.blockId,
          approval.version,
        );
        if (!pendingApprovalIds.has(id)) {
          items.push(approvalAttentionItem(snapshot, turn, approval, updatedAt));
        }
      }

      if (isRecentAttentionTurn && actionFailed(block)) {
        items.push(failedActionAttentionItem(snapshot, turn, block, updatedAt));
      }
    }

    if (isRecentAttentionTurn && turn.status === "error") {
      projectedFailedTurn = true;
      items.push(failedTurnAttentionItem(snapshot, turn, updatedAt));
    }
  }

  const nativeAttention = nativeAttentionCandidate(snapshot, now);
  if (nativeAttention) {
    items.push(nativeAttentionItem(snapshot, nativeAttention, now));
  }

  if (snapshot.session.status === "error" && !projectedFailedTurn) {
    items.push(sessionErrorAttentionItem(snapshot, now));
  }

  return sortSessionAttentionItems(items);
}

function sortSessionAttentionItems(items: SessionAttentionItem[]): SessionAttentionItem[] {
  return [...items].sort((left, right) => {
    const bySeverity = severityRank(left.severity) - severityRank(right.severity);
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return right.updatedAt - left.updatedAt;
  });
}

function severityRank(severity: SessionAttentionSeverity): number {
  switch (severity) {
    case "critical":
      return 0;
    case "warning":
      return 1;
    default:
      return 2;
  }
}

function recentAttentionTurnIds(snapshot: SessionState): Set<string> {
  const turnIds = new Set<string>();
  const currentTurn = snapshot.currentTurnId
    ? snapshot.turns.find((turn) => turn.id === snapshot.currentTurnId)
    : undefined;
  if (currentTurn) {
    turnIds.add(currentTurn.id);
  }

  const latestTurn = snapshot.turns.at(-1);
  if (latestTurn) {
    turnIds.add(latestTurn.id);
  }

  return turnIds;
}

function turnUpdatedAt(turn: TurnState, fallback: number): number {
  return Number.isFinite(turn.endedAt) ? turn.endedAt! : turn.startedAt ?? fallback;
}

function sessionLabel(snapshot: SessionState): string {
  return snapshot.session.name?.trim() || snapshot.session.id;
}

function sourceLabel(snapshot: SessionState, label: string): string {
  const adapter = snapshot.session.adapterType?.trim();
  return adapter ? `${adapter} ${label}` : label;
}

function questionAttentionItem(
  snapshot: SessionState,
  turn: TurnState,
  block: QuestionBlock,
  updatedAt: number,
): SessionAttentionItem {
  const options = block.options
    .map((option) => option.label.trim())
    .filter(Boolean)
    .join(", ");
  return {
    id: `session-question:${snapshot.session.id}:${turn.id}:${block.id}`,
    kind: "question",
    context: attentionContextBeforeBlock(turn, block.id),
    title: block.header?.trim() || "Session needs input",
    summary: compactAttentionSummary(block.question),
    detail: options ? `Options: ${options}` : null,
    sessionId: snapshot.session.id,
    sessionName: sessionLabel(snapshot),
    adapterType: snapshot.session.adapterType,
    turnId: turn.id,
    blockId: block.id,
    version: null,
    updatedAt,
    severity: "warning",
    sourceLabel: sourceLabel(snapshot, "question"),
  };
}

function approvalAttentionItem(
  snapshot: SessionState,
  turn: TurnState,
  approval: NormalizedApprovalRequest,
  updatedAt: number,
): SessionAttentionItem {
  return {
    id: sessionApprovalAttentionId(
      approval.sessionId,
      approval.turnId,
      approval.blockId,
      approval.version,
    ),
    kind: "approval",
    context: attentionContextBeforeBlock(turn, approval.blockId),
    title: approval.title,
    summary: compactAttentionSummary(approval.description),
    detail: approval.detail,
    sessionId: snapshot.session.id,
    sessionName: approval.sessionName || sessionLabel(snapshot),
    adapterType: approval.adapterType || snapshot.session.adapterType,
    turnId: turn.id,
    blockId: approval.blockId,
    version: approval.version,
    updatedAt,
    severity: approval.risk === "high" ? "critical" : "warning",
    sourceLabel: `${approval.adapterType} approval`,
    actionKind: approval.actionKind,
    approval,
  };
}

function actionFailed(block: ActionBlock): boolean {
  return block.status === "failed" || block.action.status === "failed";
}

function failedActionAttentionItem(
  snapshot: SessionState,
  turn: TurnState,
  block: ActionBlock,
  updatedAt: number,
): SessionAttentionItem {
  return {
    id: `session-action-failed:${snapshot.session.id}:${turn.id}:${block.id}`,
    kind: "failed_action",
    title: failedActionTitle(block),
    summary: compactAttentionSummary(block.action.output) ?? "A session action failed.",
    detail: actionDetail(block),
    sessionId: snapshot.session.id,
    sessionName: sessionLabel(snapshot),
    adapterType: snapshot.session.adapterType,
    turnId: turn.id,
    blockId: block.id,
    version: null,
    updatedAt,
    severity: "critical",
    sourceLabel: sourceLabel(snapshot, "action"),
    actionKind: block.action.kind,
  };
}

function failedTurnAttentionItem(
  snapshot: SessionState,
  turn: TurnState,
  updatedAt: number,
): SessionAttentionItem {
  return {
    id: `session-turn-error:${snapshot.session.id}:${turn.id}`,
    kind: "failed_turn",
    title: "Session turn failed",
    summary: failedTurnSummary(turn),
    detail: `Turn ${turn.id}`,
    sessionId: snapshot.session.id,
    sessionName: sessionLabel(snapshot),
    adapterType: snapshot.session.adapterType,
    turnId: turn.id,
    blockId: null,
    version: null,
    updatedAt,
    severity: "critical",
    sourceLabel: sourceLabel(snapshot, "turn"),
  };
}

function sessionErrorAttentionItem(
  snapshot: SessionState,
  now: number,
): SessionAttentionItem {
  const latestTurn = snapshot.turns.at(-1);
  return {
    id: `session-error:${snapshot.session.id}`,
    kind: "session_error",
    title: "Session error",
    summary: sessionErrorSummary(snapshot),
    detail: snapshot.session.cwd ?? null,
    sessionId: snapshot.session.id,
    sessionName: sessionLabel(snapshot),
    adapterType: snapshot.session.adapterType,
    turnId: latestTurn?.id ?? null,
    blockId: null,
    version: null,
    updatedAt: latestTurn ? turnUpdatedAt(latestTurn, now) : now,
    severity: "critical",
    sourceLabel: sourceLabel(snapshot, "session"),
  };
}

function nativeAttentionItem(
  snapshot: SessionState,
  candidate: NativeAttentionCandidate,
  now: number,
): SessionAttentionItem {
  return {
    id: `session-native:${snapshot.session.id}:${candidate.idPart}${
      candidate.version !== null ? `:v${candidate.version}` : ""
    }`,
    kind: "native_attention",
    title: candidate.title ?? nativeAttentionTitle(candidate.status),
    // The title says it; a stock line under it only repeated the title.
    summary: candidate.summary ?? "",
    detail: candidate.detail,
    sessionId: snapshot.session.id,
    sessionName: sessionLabel(snapshot),
    adapterType: snapshot.session.adapterType,
    turnId: candidate.turnId,
    blockId: candidate.blockId,
    version: candidate.version,
    updatedAt: candidate.updatedAt ?? now,
    severity: candidate.severity,
    sourceLabel: sourceLabel(snapshot, "native"),
  };
}

function failedActionTitle(block: ActionBlock): string {
  switch (block.action.kind) {
    case "command":
      return "Command failed";
    case "file_change":
      return "File action failed";
    case "tool_call":
      return "Tool call failed";
    case "subagent":
      return "Subagent action failed";
  }
}

function actionDetail(block: ActionBlock): string | null {
  switch (block.action.kind) {
    case "command":
      return compactAttentionSummary(block.action.command, 180);
    case "file_change":
      return compactAttentionSummary(block.action.path, 180);
    case "tool_call":
      return compactAttentionSummary(block.action.toolName, 180);
    case "subagent":
      return compactAttentionSummary(block.action.agentName ?? block.action.agentId, 180);
  }
}

function failedTurnSummary(turn: TurnState): string {
  for (const blockState of turn.blocks) {
    const block = blockState.block;
    if (block.type === "error") {
      const summary = compactAttentionSummary(block.message);
      if (summary) {
        return summary;
      }
    }
  }

  for (const blockState of turn.blocks) {
    const block = blockState.block;
    if (block.type === "action" && actionFailed(block)) {
      return compactAttentionSummary(block.action.output)
        ?? actionDetail(block)
        ?? "A session action failed during this turn.";
    }
  }

  return "The session reported that the turn failed.";
}

function sessionErrorSummary(snapshot: SessionState): string {
  const providerMeta = metadataRecord(snapshot.session.providerMeta);
  return firstMetadataString(
    providerMeta,
    "error",
    "lastError",
    "errorMessage",
    "message",
    "statusDetail",
    "detail",
  ) ?? "The session is currently in an error state.";
}

function nativeAttentionTitle(status: string): string {
  const normalized = status.replace(/[-_]+/g, " ").trim().toLowerCase();
  if (normalized.includes("approval")) {
    return "Waiting on your approval";
  }
  if (normalized.includes("input") || normalized.includes("answer")) {
    return "Waiting on your answer";
  }
  return "Waiting on you";
}

function nativeAttentionCandidate(
  snapshot: SessionState,
  now: number,
): NativeAttentionCandidate | null {
  const providerMeta = metadataRecord(snapshot.session.providerMeta);
  if (!providerMeta) {
    return null;
  }

  const direct = candidateFromRecord("provider", providerMeta, now, false);
  if (direct) {
    return direct;
  }

  const keys = [
    "nativeAttention",
    "operatorAttention",
    "attention",
    "nativeStatus",
    "sessionStatus",
    "status",
    "blocked",
    "needsInput",
    "needs_input",
  ];

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(providerMeta, key)) {
      continue;
    }
    const candidate = candidateFromValue(key, providerMeta[key], providerMeta, now);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function candidateFromValue(
  key: string,
  value: unknown,
  root: Record<string, unknown>,
  now: number,
): NativeAttentionCandidate | null {
  if (value === true) {
    return {
      status: key,
      idPart: stableNativeIdPart(key),
      title: firstMetadataString(root, "title", "attentionTitle"),
      summary: firstMetadataString(root, "summary", "attentionSummary", "blockedReason", "needsInputReason", "reason", "message"),
      detail: firstMetadataString(root, "detail", "statusDetail"),
      turnId: metadataString(root, "turnId"),
      blockId: metadataString(root, "blockId"),
      version: metadataNumber(root, "version"),
      updatedAt: metadataTimestamp(root, now),
      severity: nativeSeverity(root),
    };
  }

  if (typeof value === "string") {
    if (isInactiveAttentionStatus(value)) {
      return null;
    }
    if (!isBlockedStatus(value) && !isAttentionKey(key)) {
      return null;
    }
    return {
      status: value,
      idPart: stableNativeIdPart(value || key),
      title: firstMetadataString(root, "title", "attentionTitle"),
      summary: firstMetadataString(root, "summary", "attentionSummary", "blockedReason", "needsInputReason", "reason", "message"),
      detail: firstMetadataString(root, "detail", "statusDetail"),
      turnId: metadataString(root, "turnId"),
      blockId: metadataString(root, "blockId"),
      version: metadataNumber(root, "version"),
      updatedAt: metadataTimestamp(root, now),
      severity: nativeSeverity(root),
    };
  }

  const record = metadataRecord(value);
  if (!record) {
    return null;
  }

  return candidateFromRecord(key, record, now, isAttentionKey(key));
}

function candidateFromRecord(
  key: string,
  record: Record<string, unknown>,
  now: number,
  keyImpliesAttention: boolean,
): NativeAttentionCandidate | null {
  const explicitStatus = firstMetadataString(record, "status", "state", "kind", "type", "category");
  const booleanBlocked =
    record.blocked === true
    || record.needsInput === true
    || record.needs_input === true
    || record.awaitingInput === true
    || record.awaiting_input === true;
  const status = explicitStatus ?? (booleanBlocked || keyImpliesAttention ? key : null);

  if (explicitStatus && isInactiveAttentionStatus(explicitStatus)) {
    return null;
  }

  if (!status || (!isBlockedStatus(status) && !booleanBlocked && !keyImpliesAttention)) {
    return null;
  }

  const idSource =
    firstMetadataString(record, "id", "attentionId", "blockerId", "blockId", "turnId")
    ?? status
    ?? key;
  return {
    status,
    idPart: stableNativeIdPart(idSource),
    title: firstMetadataString(record, "title", "label"),
    summary: firstMetadataString(record, "summary", "message", "reason", "description"),
    detail: firstMetadataString(record, "detail", "statusDetail", "hint"),
    turnId: metadataString(record, "turnId"),
    blockId: metadataString(record, "blockId"),
    version: metadataNumber(record, "version"),
    updatedAt: metadataTimestamp(record, now),
    severity: nativeSeverity(record),
  };
}

function isAttentionKey(key: string): boolean {
  return /attention|blocked|needs[-_]?input|awaiting[-_]?input/i.test(key);
}

function isBlockedStatus(value: string): boolean {
  return BLOCKED_STATUS_PATTERN.test(value);
}

function isInactiveAttentionStatus(value: string): boolean {
  return INACTIVE_ATTENTION_STATUS_PATTERN.test(value);
}

function stableNativeIdPart(value: string): string {
  const stable = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stable || "blocked";
}

function nativeSeverity(record: Record<string, unknown>): SessionAttentionSeverity {
  const severity = metadataString(record, "severity")?.toLowerCase();
  if (severity === "critical" || severity === "warning" || severity === "info") {
    return severity;
  }
  return "warning";
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadataString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataNumber(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataTimestamp(
  record: Record<string, unknown> | null | undefined,
  fallback: number,
): number | null {
  const value =
    record?.updatedAt
    ?? record?.updated_at
    ?? record?.timestamp
    ?? record?.ts
    ?? record?.createdAt;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return fallback;
}

function firstMetadataString(
  record: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = metadataString(record, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function compactAttentionSummary(value: string | null | undefined, max = 220): string | null {
  const compacted = (value ?? "").replace(/\s+/g, " ").trim();
  if (!compacted) {
    return null;
  }
  return compacted.length > max ? `${compacted.slice(0, max - 1)}...` : compacted;
}
