import {
  findPriorDecision,
  renderOperatorCardAnswerText,
  normalizeDecisionCard,
  validateDecisionCard,
  validateOperatorCardAnswer,
  type DecisionAnswer,
  type DecisionCard,
  type DecisionSynthesisInfo,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type OperatorCard,
  type OperatorCardAnswer,
  type OperatorCardOrigin,
  type OperatorCardView,
  type PermissionAnswer,
  type PriorOperatorAnswer,
  type QuestionRecord,
  type ScoutOperatorSignal,
  type ScoutTaskReply,
} from "@openscout/protocol";

import {
  costOfWaitFor,
  decisionSourceHash,
  synthesizeDecisionCard,
  type DecisionModel,
  type DecisionSynthesisResult,
  type DecisionSynthesisSource,
} from "./decision-synthesis.js";
import { PERMISSION_DECISION_FOR_ANSWER, permissionCardFromAsk, permissionCardFromRequest, type PermissionCardWhere } from "./permission-card.js";

/**
 * The runtime's half of decision cards. It makes each operator ask's card
 * once, keeps it on the ask's question record, and carries an answer back to
 * the asking session through the task's reply path. Surfaces only read.
 *
 * Record metadata it owns, on `operator-question:<message>` and permission
 * request records:
 * - `operatorCard`, `operatorCardOrigin`: the card, when there is one;
 * - `decisionSynthesis`: what synthesis did, so a surface can tell "no card"
 *   from "not yet";
 * - `decisionAnswer`: the operator's structured answer;
 * - `decisionRequests`: show_more answers while the task stays open.
 */

export class DecisionAnswerError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

type StoredAnswer = NonNullable<OperatorCardView["answer"]>;

export type BrokerDecisionCardServiceOptions = {
  operatorActorId: string;
  record: (id: string) => QuestionRecord | undefined;
  /** Every question record, open and closed. */
  questionRecords: () => Iterable<QuestionRecord>;
  writeRecord: (record: QuestionRecord) => Promise<unknown>;
  message: (id: string) => Promise<MessageRecord | undefined> | MessageRecord | undefined;
  invocation: (id: string) => InvocationRequest | undefined;
  currentFlight: (invocationId: string) => FlightRecord | undefined;
  /** How to name where an actor's session runs: its alias, harness and project. Never a raw id. */
  where: (input: { actorId?: string; sessionId?: string }) => PermissionCardWhere & { project?: string };
  /** The task reply path (BrokerTaskService.reply). */
  reply: (input: ScoutTaskReply, extra: { metadata: Record<string, unknown> }) => Promise<unknown>;
  /** The permission decide path (BrokerPermissionService.decide). */
  decidePermission: (id: string, version: string, decision: "once" | "project" | "deny") => Promise<void>;
  /** Undefined when no model is configured: asks without a card stay plain. */
  model?: DecisionModel;
  now?: () => number;
  log?: (message: string, detail?: unknown) => void;
};

function withoutCostOfWait(card: DecisionCard): DecisionCard {
  const { costOfWait: _wait, ...rest } = card;
  return rest;
}

function metadataOf(record: QuestionRecord): Record<string, unknown> {
  return (record.metadata ?? {}) as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function invocationIdForMessage(messageId: string): string {
  return messageId.replace(/^msg-request-/u, "inv-request-");
}

export class BrokerDecisionCardService {
  private readonly cache = new Map<string, DecisionSynthesisResult & { model: string }>();
  private cacheLoaded = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();

  constructor(private readonly options: BrokerDecisionCardServiceOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** Waits for queued synthesis. Tests and shutdown use it. */
  idle(): Promise<void> { return this.queue; }

  /* -------------------------------------------------------------- */
  /* making cards                                                    */
  /* -------------------------------------------------------------- */

  /**
   * Called once the ask's question record exists. An agent's card is stored as
   * given; a `--permission` ask becomes a permission card; anything else is
   * queued for synthesis. Never throws: a card is extra, the ask stands.
   */
  async register(message: MessageRecord, signal: ScoutOperatorSignal): Promise<void> {
    try {
      const id = `operator-question:${message.id}`;
      const record = this.options.record(id);
      if (!record || record.state !== "open" || metadataOf(record).operatorCard || metadataOf(record).decisionSynthesis) return;
      const invocation = this.options.invocation(invocationIdForMessage(message.id));
      const given = message.metadata?.decisionCard as DecisionCard | undefined;
      const agentCard = given ? normalizeDecisionCard(given) : undefined;
      if (agentCard && !validateDecisionCard(agentCard, { origin: "agent", pictures: "attachment" }).length) {
        await this.storeCard(id, this.withHistory(agentCard, record), "agent");
        return;
      }
      if (signal.kind === "need" && signal.requestKind === "permission") {
        const where = this.options.where({ actorId: message.actorId });
        await this.storeCard(id, permissionCardFromAsk({ question: signal.question, because: signal.blockedReason, ...where }), "permission");
        return;
      }
      if (signal.kind === "notify" || !this.options.model) return;
      this.enqueue(id, this.sourceFor(message, signal, invocation));
    } catch (error) {
      this.options.log?.("[openscout-runtime] decision card registration failed", error);
    }
  }

  /** Startup: synthesize for open asks that have neither a card nor a synthesis result, newest first, at most `limit`. */
  async resume(limit = 20): Promise<number> {
    if (!this.options.model) return 0;
    const open = [...this.options.questionRecords()]
      .filter((record) => record.state === "open" && record.id.startsWith("operator-question:")
        && !metadataOf(record).operatorCard && !metadataOf(record).decisionSynthesis && metadataOf(record).requestKind !== "permission")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    let queued = 0;
    for (const record of open) {
      const messageId = text(metadataOf(record).operatorNeedMessageId);
      const message = messageId ? await this.options.message(messageId) : undefined;
      const signal = message?.metadata?.operatorSignal as ScoutOperatorSignal | undefined;
      if (!message || !signal || signal.kind === "notify") continue;
      if (message.metadata?.decisionCard) { await this.register(message, signal); continue; }
      this.enqueue(record.id, this.sourceFor(message, signal, this.options.invocation(invocationIdForMessage(message.id))));
      queued += 1;
    }
    return queued;
  }

  private sourceFor(message: MessageRecord, signal: Exclude<ScoutOperatorSignal, { kind: "notify" }>, invocation?: InvocationRequest): DecisionSynthesisSource {
    const metadata = invocation?.metadata ?? {};
    const need = signal.kind === "need" ? signal : undefined;
    const options = Array.isArray(metadata.options) ? (metadata.options as unknown[]).flatMap((option) => text(option) ?? []) : need?.options ?? [];
    const because = text(metadata.because) ?? need?.blockedReason;
    const defaultAction = text(metadata.defaultAction) ?? (signal.kind === "consult" ? signal.defaultAction : undefined);
    return {
      question: need?.question ?? message.body,
      body: message.body,
      options,
      ...(because ? { because } : {}),
      ...(defaultAction ? { defaultAction } : {}),
      ...(typeof metadata.operatorAnswerDeadline === "number" ? { answerDeadline: metadata.operatorAnswerDeadline } : {}),
    };
  }

  private enqueue(recordId: string, source: DecisionSynthesisSource): void {
    if (this.pending.has(recordId)) return;
    this.pending.add(recordId);
    // One call at a time: a burst of asks costs a burst of small calls, never a fan-out.
    this.queue = this.queue.then(() => this.synthesize(recordId, source)).catch((error) => {
      this.options.log?.("[openscout-runtime] decision synthesis failed", error);
    }).finally(() => { this.pending.delete(recordId); });
  }

  private loadCache(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    for (const record of this.options.questionRecords()) {
      const info = metadataOf(record).decisionSynthesis as DecisionSynthesisInfo | undefined;
      if (!info?.sourceHash || info.outcome === "failed" || !info.model) continue;
      const card = metadataOf(record).operatorCard as DecisionCard | undefined;
      if (info.outcome === "card" && card?.kind === "decision") {
        // Per-ask fields are not part of the cached card: the history check and the cost of waiting.
        const { alreadyDecided: _prior, costOfWait: _wait, ...rest } = card;
        this.cache.set(info.sourceHash, { outcome: "card", card: rest, model: info.model });
      } else if (info.outcome === "question") {
        this.cache.set(info.sourceHash, { outcome: "question", reason: "cached", model: info.model });
      }
    }
  }

  private async synthesize(recordId: string, source: DecisionSynthesisSource): Promise<void> {
    const model = this.options.model;
    if (!model) return;
    this.loadCache();
    const sourceHash = decisionSourceHash(source, model.model);
    const cached = this.cache.get(sourceHash);
    const result = cached ?? { ...await synthesizeDecisionCard(source, model, () => this.now()), model: model.model };
    if (!cached && result.outcome !== "failed") this.cache.set(sourceHash, result.outcome === "card" ? { ...result, card: withoutCostOfWait(result.card) } : result);
    const durationMs = cached ? undefined : result.durationMs;
    const info: DecisionSynthesisInfo = {
      outcome: result.outcome,
      sourceHash,
      model: model.model,
      via: model.via,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(cached ? { cached: true } : {}),
      ...(result.outcome === "failed" ? { error: result.error.slice(0, 300) } : result.outcome === "question" && !cached ? { error: result.reason.slice(0, 300) } : {}),
      at: this.now(),
    };
    const record = this.options.record(recordId);
    if (!record || record.state !== "open") return;
    if (result.outcome === "card") {
      const costOfWait = costOfWaitFor(source);
      const card: DecisionCard = { ...withoutCostOfWait(result.card), ...(costOfWait ? { costOfWait } : {}) };
      await this.patch(record, { operatorCard: this.withHistory(card, record), operatorCardOrigin: "synthesized", decisionSynthesis: info });
    } else {
      await this.patch(record, { decisionSynthesis: info });
    }
  }

  private async storeCard(recordId: string, card: OperatorCard, origin: OperatorCardOrigin): Promise<void> {
    const record = this.options.record(recordId);
    if (record) await this.patch(record, { operatorCard: card, operatorCardOrigin: origin });
  }

  /** Card bookkeeping is not activity: the record keeps its updatedAt. */
  private async patch(record: QuestionRecord, metadata: Record<string, unknown>): Promise<void> {
    const current = this.options.record(record.id) ?? record;
    await this.options.writeRecord({ ...current, metadata: { ...current.metadata, ...metadata } });
  }

  /* -------------------------------------------------------------- */
  /* history                                                         */
  /* -------------------------------------------------------------- */

  /** The operator's earlier answers on record, for the history check. */
  priorAnswers(): PriorOperatorAnswer[] {
    const prior: PriorOperatorAnswer[] = [];
    for (const record of this.options.questionRecords()) {
      if (record.state !== "closed" || !record.id.startsWith("operator-question:") || metadataOf(record).requestKind === "permission") continue;
      const answered = metadataOf(record).decisionAnswer as StoredAnswer | undefined;
      if (answered?.by === "default") continue;
      const answer = text(record.answer);
      if (!answer || typeof record.answeredAt !== "number") continue;
      const card = metadataOf(record).operatorCard as OperatorCard | undefined;
      prior.push({
        recordId: record.id,
        question: text(record.summary) ?? record.title,
        ...(card?.kind === "decision" ? { options: card.options.map((option) => option.label) } : {}),
        answer,
        answeredAt: record.answeredAt,
      });
    }
    return prior;
  }

  private withHistory(card: DecisionCard, record: QuestionRecord): DecisionCard {
    if (card.alreadyDecided) return card;
    const prior = findPriorDecision({
      question: [card.question, text(record.summary) ?? ""].join(" "),
      options: card.options.map((option) => option.label),
      recordId: record.id,
    }, this.priorAnswers());
    return prior ? { ...card, alreadyDecided: prior } : card;
  }

  /* -------------------------------------------------------------- */
  /* reads                                                           */
  /* -------------------------------------------------------------- */

  resolveRecord(id: string): QuestionRecord | undefined {
    const direct = this.options.record(id);
    if (direct?.kind === "question") return direct;
    const viaMessage = this.options.record(`operator-question:${id}`);
    if (viaMessage?.kind === "question") return viaMessage;
    if (id.startsWith("inv-request-")) return this.options.record(`operator-question:${id.replace(/^inv-request-/u, "msg-request-")}`);
    return undefined;
  }

  async view(id: string): Promise<OperatorCardView | undefined> {
    const record = this.resolveRecord(id);
    return record ? this.viewOf(record) : undefined;
  }

  async list(input: { state?: "open" | "all"; limit?: number } = {}): Promise<OperatorCardView[]> {
    const records = [...this.options.questionRecords()]
      .filter((record) => record.id.startsWith("operator-question:") || metadataOf(record).permissionRequest)
      .filter((record) => input.state === "all" || record.state === "open")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(input.limit ?? 50, 200)));
    return Promise.all(records.map((record) => this.viewOf(record)));
  }

  private cardFor(record: QuestionRecord): { card?: OperatorCard; origin?: OperatorCardOrigin } {
    const metadata = metadataOf(record);
    if (metadata.permissionRequest) {
      const request = metadata.permissionRequest as { sessionId?: string };
      const card = permissionCardFromRequest(record, this.options.where({ actorId: record.askedById, sessionId: request.sessionId }));
      return card ? { card, origin: "permission" } : {};
    }
    const card = metadata.operatorCard as OperatorCard | undefined;
    return card ? { card, origin: (metadata.operatorCardOrigin as OperatorCardOrigin | undefined) ?? "synthesized" } : {};
  }

  private async viewOf(record: QuestionRecord): Promise<OperatorCardView> {
    const metadata = metadataOf(record);
    const messageId = text(metadata.operatorNeedMessageId);
    const message = messageId ? await this.options.message(messageId) : undefined;
    const invocation = messageId ? this.options.invocation(invocationIdForMessage(messageId)) : undefined;
    const flight = invocation ? this.options.currentFlight(invocation.id) : undefined;
    const taskMeta = invocation?.metadata ?? {};
    const permission = metadata.permissionRequest as { decisionLabels?: Record<string, string>; decisions?: string[] } | undefined;
    const answer = metadata.decisionAnswer as StoredAnswer | undefined;
    const requests = Array.isArray(metadata.decisionRequests) ? metadata.decisionRequests as Array<{ note?: string; at: number }> : undefined;
    const { card, origin } = this.cardFor(record);
    const defaulted = flight?.metadata?.operatorOutcome === "proceeded_with_default";
    const state: OperatorCardView["state"] = record.state === "open"
      ? defaulted ? "defaulted" : requests?.length ? "needs_material" : "open"
      : answer?.by === "default" || defaulted ? "defaulted" : record.answer || answer ? "answered" : "closed";
    const options = Array.isArray(taskMeta.options) ? (taskMeta.options as unknown[]).flatMap((option) => text(option) ?? [])
      : permission ? (permission.decisions ?? []).map((decision) => permission.decisionLabels?.[decision] ?? decision) : [];
    return {
      id: record.id,
      ...(messageId ? { messageId } : {}),
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(invocation ? { taskId: invocation.id } : {}),
      ...(record.askedById ? { askedBy: record.askedById } : {}),
      createdAt: record.createdAt,
      state,
      plain: {
        question: text(message?.body) ?? text(record.summary) ?? record.title,
        options,
        ...(text(taskMeta.because) ? { because: text(taskMeta.because) } : {}),
        ...(text(taskMeta.defaultAction) ? { defaultAction: text(taskMeta.defaultAction) } : {}),
        ...(typeof taskMeta.operatorAnswerDeadline === "number" ? { answerDeadline: taskMeta.operatorAnswerDeadline } : {}),
      },
      ...(card ? { card, origin } : {}),
      ...(metadata.decisionSynthesis ? { synthesis: metadata.decisionSynthesis as DecisionSynthesisInfo } : {}),
      ...(answer ? { answer } : defaulted && text(taskMeta.defaultAction) && card?.kind === "decision" ? { answer: this.defaultAnswer(card, text(taskMeta.defaultAction)!, flight) } : {}),
      ...(requests?.length ? { requests } : {}),
    };
  }

  private defaultAnswer(card: DecisionCard, defaultAction: string, flight?: FlightRecord): StoredAnswer {
    const option = card.options.find((entry) => entry.key === card.defaultKey) ?? card.options.find((entry) => entry.label === defaultAction);
    const answer: DecisionAnswer = option ? { kind: "pick", key: option.key } : { kind: "something_else", note: defaultAction };
    return { answer, text: `No answer in time; went ahead with the default, ${option ? `${option.key} (${option.label})` : defaultAction}.`, at: flight?.completedAt ?? this.now(), by: "default" };
  }

  /* -------------------------------------------------------------- */
  /* answers                                                         */
  /* -------------------------------------------------------------- */

  /**
   * Record the operator's answer and carry it to the asking session through
   * the task's reply path. `requestId` makes a retried answer a no-op.
   */
  async answer(input: { id: string; answer: OperatorCardAnswer; requestId: string }): Promise<OperatorCardView> {
    if (!input.requestId?.trim()) throw new DecisionAnswerError("answer requires a requestId");
    const record = this.resolveRecord(input.id);
    if (!record) throw new DecisionAnswerError(`no operator ask ${input.id}`, 404);
    // The same requestId again is a retry of an answer already taken: return
    // the card as it stands now, and send nothing.
    if (this.answeredBy(record, input.requestId)) return this.viewOf(record);
    const { card } = this.cardFor(record);
    if (!card) throw new DecisionAnswerError("this ask has no card; answer it in its thread", 409);
    const problems = validateOperatorCardAnswer(card, input.answer);
    if (problems.length) throw new DecisionAnswerError(problems.join("; "));
    if (record.state !== "open") throw new DecisionAnswerError("this ask is already settled", 409);
    const at = this.now();
    const line = renderOperatorCardAnswerText(card, input.answer);
    const stored: StoredAnswer = { answer: input.answer, text: line, at, by: "operator", requestId: input.requestId };

    if (card.kind === "permission" && metadataOf(record).permissionRequest) {
      const request = metadataOf(record).permissionRequest as { version: string };
      await this.options.decidePermission(record.id, request.version, PERMISSION_DECISION_FOR_ANSWER[(input.answer as PermissionAnswer).kind]);
      await this.patch(record, { decisionAnswer: stored });
      return (await this.view(record.id))!;
    }

    const messageId = text(metadataOf(record).operatorNeedMessageId);
    const invocation = messageId ? this.options.invocation(invocationIdForMessage(messageId)) : undefined;
    if (!invocation) throw new DecisionAnswerError("this ask is not a task, so a card answer cannot reach its asker; answer it in its thread", 409);
    if (input.answer.kind === "show_more") {
      // The task stays open. The asker gets a progress reply naming what to add.
      await this.options.reply({ requestId: input.requestId, senderId: this.options.operatorActorId, ref: invocation.id,
        body: `${line} Send the card again with more material: what each option looks like, what it changes, and what it costs to undo.`, progress: true },
      { metadata: { decisionAnswer: stored } });
      const requests = Array.isArray(metadataOf(record).decisionRequests) ? metadataOf(record).decisionRequests as unknown[] : [];
      await this.patch(record, { decisionRequests: [...requests, { ...(input.answer.note?.trim() ? { note: input.answer.note.trim() } : {}), at, requestId: input.requestId }] });
      return (await this.view(record.id))!;
    }
    // A final reply. Settling the question record copies decisionAnswer from it.
    await this.options.reply({ requestId: input.requestId, senderId: this.options.operatorActorId, ref: invocation.id, body: line },
      { metadata: { decisionAnswer: stored } });
    return (await this.view(record.id))!;
  }

  /** Whether the answer or show_more with this requestId is already on the record. */
  private answeredBy(record: QuestionRecord, requestId: string): boolean {
    const metadata = metadataOf(record);
    if ((metadata.decisionAnswer as StoredAnswer | undefined)?.requestId === requestId) return true;
    const requests = Array.isArray(metadata.decisionRequests) ? metadata.decisionRequests as Array<{ requestId?: string }> : [];
    return requests.some((entry) => entry?.requestId === requestId);
  }

  /**
   * When a two-way ask's window runs out, the task proceeds with its default
   * (BrokerTaskService.expireOperatorTasks). This closes its question record so
   * the card leaves the queue, and records the default as the answer.
   */
  async settleDefaulted(): Promise<void> {
    for (const record of this.options.questionRecords()) {
      if (record.state !== "open" || !record.id.startsWith("operator-question:")) continue;
      const card = metadataOf(record).operatorCard as OperatorCard | undefined;
      if (card?.kind === "permission") continue;
      const messageId = text(metadataOf(record).operatorNeedMessageId);
      const invocation = messageId ? this.options.invocation(invocationIdForMessage(messageId)) : undefined;
      const flight = invocation ? this.options.currentFlight(invocation.id) : undefined;
      const defaultAction = text(invocation?.metadata?.defaultAction);
      if (!invocation || !defaultAction || flight?.metadata?.operatorOutcome !== "proceeded_with_default") continue;
      // Only a two-way door defaults. An agent's one-way card is refused a
      // default when it is asked; a plain ask with a default reads as two-way.
      if (card && card.door !== "two_way") continue;
      const stored: StoredAnswer = card ? this.defaultAnswer(card, defaultAction, flight)
        : { answer: { kind: "something_else", note: defaultAction }, text: `No answer in time; went ahead with the default: ${defaultAction}.`, at: flight.completedAt ?? this.now(), by: "default" };
      await this.options.writeRecord({ ...record, state: "closed", answer: stored.text, answeredAt: stored.at, closedAt: stored.at,
        nextMoveOwnerId: undefined, updatedAt: stored.at, metadata: { ...record.metadata, decisionAnswer: stored } });
    }
  }
}
