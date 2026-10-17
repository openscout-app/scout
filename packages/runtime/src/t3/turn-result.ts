export type T3TurnState = "unconfirmed" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type T3SourceTerminalState = "completed" | "error" | "interrupted";

export interface T3TurnCorrelation {
  /** Exact Scout-generated user message ID persisted before submitting to T3. */
  messageId: string;
  /** A turn association previously observed and durably recorded by the broker. */
  turnId?: string;
  /** A terminal state previously observed for that same durably bound turn. */
  terminalState?: T3SourceTerminalState;
}

export interface T3TurnResult {
  turnId?: string;
  state: T3TurnState;
  output?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Resolve a result from source-owned evidence without confusing a turn's final
 * response with a newer turn or a mid-turn checkpoint. Persist a returned turnId
 * before later snapshots can replace latestTurn. Canonical timestamps come from
 * T3's accepted user message, since T3 rewrites the caller's submitted timestamp.
 */
export function resolveT3TurnResult(threadValue: unknown, correlation: T3TurnCorrelation): T3TurnResult {
  const thread = record(threadValue);
  const messages = Array.isArray(thread?.messages) ? thread.messages.map(record).filter(value => value !== undefined) : [];
  const sourceMessage = messages.find(message => message.id === correlation.messageId && message.role === "user");
  if (!sourceMessage) return { state: "unconfirmed" };

  const latest = record(thread?.latestTurn);
  const sourceTurnId = id(sourceMessage.turnId);
  if (sourceTurnId && correlation.turnId && sourceTurnId !== correlation.turnId) return { state: "unconfirmed" };
  const canonicalTime = typeof sourceMessage.createdAt === "string" && Number.isFinite(Date.parse(sourceMessage.createdAt))
    ? sourceMessage.createdAt : undefined;
  const timeBoundTurnId = canonicalTime && latest?.requestedAt === canonicalTime ? id(latest.turnId) : undefined;
  const turnId = sourceTurnId ?? correlation.turnId ?? timeBoundTurnId;
  if (!turnId) return { state: "unconfirmed" };

  const sameLatest = latest?.turnId === turnId;
  const sourceState = sameLatest ? latest.state
    : correlation.turnId === turnId ? correlation.terminalState : undefined;
  if (sourceState === "error") return { turnId, state: "failed" };
  if (sourceState === "interrupted") return { turnId, state: "cancelled" };
  if (sourceState === "running") return { turnId, state: "running" };
  if (sourceState !== "completed") return { turnId, state: "waiting" };

  let assistantMessageId = sameLatest ? id(latest.assistantMessageId) : undefined;
  if (!assistantMessageId && correlation.turnId === turnId && correlation.terminalState === "completed") {
    // Checkpoints choose a message only after separate durable terminal proof.
    // T3 also creates them for mid-turn turn.diff.updated events.
    const checkpoints = Array.isArray(thread?.checkpoints) ? thread.checkpoints.map(record) : [];
    assistantMessageId = id(checkpoints.find(checkpoint => checkpoint?.turnId === turnId)?.assistantMessageId);
  }
  const final = assistantMessageId ? messages.find(message => message.id === assistantMessageId
    && message.role === "assistant" && message.turnId === turnId && message.streaming === false) : undefined;
  return typeof final?.text === "string" && final.text.trim()
    ? { turnId, state: "completed", output: final.text }
    : { turnId, state: "waiting" };
}
