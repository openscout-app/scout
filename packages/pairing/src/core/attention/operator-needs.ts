/**
 * Declared operator needs that are still unanswered.
 *
 * `scout need` posts a message carrying `metadata.operatorSignal` of kind
 * `need` and pushes the phone, but creates no session attention item and no
 * collaboration record — so neither inbox source ever showed it, and a tapped
 * "An agent is asking" alert landed on an empty inbox. This projects the
 * declaration itself: a need is pending until the operator speaks in that
 * conversation after it. Nothing here is inferred from agent state.
 */

export type OperatorNeedMessage = {
  id: string;
  conversationId: string;
  actorId: string;
  body?: string | null;
  createdAt: number;
  metadata?: Record<string, unknown> | null;
};

export type PendingOperatorNeed = {
  messageId: string;
  conversationId: string;
  actorId: string;
  question: string;
  options: string[];
  blockedReason: string | null;
  createdAt: number;
  /** Declared with `--permission` (`operatorSignal.requestKind === "permission"`). */
  permission?: true;
};

/** A need nobody answered in a week is history, not a queue item. */
export const OPERATOR_NEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The actor the runtime records for a local sender that claims a person without proving it. */
const UNVERIFIED_LOCAL_ACTOR_ID = "local-unverified";

/**
 * Whether a message is the operator speaking. Without a local admin key, the
 * runtime records a web or phone message that claims the operator as
 * `local-unverified` and keeps the claim in `attribution.claimedActorId`.
 * Those are the operator's replies. A sender with its own identity (an agent,
 * a scoped principal) never speaks for the operator, whatever it claims.
 */
function speaksForOperator(message: OperatorNeedMessage, operators: ReadonlySet<string>): boolean {
  if (operators.has(message.actorId)) return true;
  if (message.actorId !== UNVERIFIED_LOCAL_ACTOR_ID) return false;
  const attribution = message.metadata?.attribution;
  if (!attribution || typeof attribution !== "object" || Array.isArray(attribution)) return false;
  const claimed = (attribution as Record<string, unknown>).claimedActorId;
  return typeof claimed === "string" && operators.has(claimed);
}

export function pendingOperatorNeeds(input: {
  messages: Iterable<OperatorNeedMessage>;
  operatorIds: readonly string[];
  now?: number;
}): PendingOperatorNeed[] {
  const now = input.now ?? Date.now();
  const operators = new Set(input.operatorIds);
  const needs: PendingOperatorNeed[] = [];
  // Latest operator message per conversation: any later reply answers the need.
  const lastOperatorReply = new Map<string, number>();

  for (const message of input.messages) {
    if (speaksForOperator(message, operators)) {
      const previous = lastOperatorReply.get(message.conversationId) ?? 0;
      if (message.createdAt > previous) lastOperatorReply.set(message.conversationId, message.createdAt);
      continue;
    }
    const signal = message.metadata?.operatorSignal;
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) continue;
    const record = signal as Record<string, unknown>;
    if (record.kind !== "need") continue;
    if (now - message.createdAt > OPERATOR_NEED_MAX_AGE_MS) continue;
    const question = text(record.question) ?? text(message.body);
    if (!question) continue;
    needs.push({
      messageId: message.id,
      conversationId: message.conversationId,
      actorId: message.actorId,
      question,
      options: Array.isArray(record.options) ? record.options.flatMap((option) => text(option) ?? []) : [],
      blockedReason: text(record.blockedReason),
      createdAt: message.createdAt,
      ...(record.requestKind === "permission" ? { permission: true as const } : {}),
    });
  }

  return needs
    .filter((need) => (lastOperatorReply.get(need.conversationId) ?? 0) <= need.createdAt)
    .sort((left, right) => right.createdAt - left.createdAt);
}
