import type { ActorIdentity, AgentEndpoint, CollaborationRecord, DeliveryIntent, FlightRecord, InvocationRequest, ScoutDeliverRequest, ScoutDeliverResponse } from "@openscout/protocol";
import { runtimeSessionHandleForEndpoint } from "../runtime-session-handle.js";
import { object, sourceId, t3CardWorkItem, t3ScopedId, type T3Adapter } from "./adapter.js";
import { T3RpcError } from "./rpc-client.js";

interface CardRunAdmission {
  nodeId: string;
  endpoints(): AgentEndpoint[];
  persistActor(actor: ActorIdentity): Promise<void>;
  persistEndpoint(endpoint: AgentEndpoint): Promise<void>;
  deliver(request: ScoutDeliverRequest): Promise<ScoutDeliverResponse>;
}

/** Admission creates a normal durable Scout ask before any T3 mutation. */
export async function admitT3CardRun(input: { connectionId: string; projectId: string; cardId: string; requestId: string }, deps: CardRunAdmission) {
  const connectionId = sourceId(input.connectionId), projectId = sourceId(input.projectId);
  const cardId = sourceId(input.cardId), requestId = sourceId(input.requestId);
  const agentId = t3ScopedId("t3", connectionId, projectId);
  const endpointId = t3ScopedId("t3-card-endpoint", deps.nodeId, connectionId, projectId, cardId);
  const previous = deps.endpoints().find(endpoint => endpoint.id === endpointId);
  await deps.persistActor({ id: agentId, kind: "agent", displayName: `T3 ${projectId}`, metadata: { hostIntegration: "t3-orchestrator" } });
  await deps.persistActor({ id: t3ScopedId("t3-owner", connectionId, projectId), kind: "person", displayName: `T3 ${projectId} owner` });
  const endpoint: AgentEndpoint = {
    id: endpointId, agentId, nodeId: deps.nodeId, harness: "bridge", transport: "http", state: previous?.state ?? "idle",
    sessionId: t3ScopedId("t3-card-session", connectionId, projectId, cardId),
    metadata: { ...previous?.metadata, hostIntegration: "t3-orchestrator", externalSession: true, t3Session: true,
      externalSessionId: t3ScopedId("t3-card-session", connectionId, projectId, cardId), connectionId, projectId, t3CardId: cardId },
  };
  await deps.persistEndpoint(endpoint);
  const sessionId = runtimeSessionHandleForEndpoint(endpoint);
  if (!sessionId) throw new Error("t3_card_session_unavailable");
  // Stable content allows the broker to return the same receipt when a client
  // retries its request ID after the card has already advanced.
  return deps.deliver({
    requestId: t3ScopedId("t3-card-request", connectionId, projectId, cardId, requestId),
    requesterNodeId: deps.nodeId, target: { kind: "session_id", sessionId },
    body: `Run T3 board card ${cardId} in project ${projectId}.`, intent: "consult", ensureAwake: true,
    workItem: { title: `T3 card ${cardId}`, acceptanceState: "pending", metadata: { source: "t3-card-run", connectionId, projectId, cardId } },
    invocationMetadata: { source: "t3-card-run", connectionId, projectId, t3CardId: cardId, clientRequestId: requestId },
  });
}

interface BoardRunDependencies {
  nodeId: string;
  adapter: T3Adapter;
  deliveryId: string;
  delivery(id: string): DeliveryIntent | undefined;
  recordDelivery(delivery: DeliveryIntent): Promise<void>;
  mutateDelivery(id: string, update: (current: DeliveryIntent) => DeliveryIntent | null): Promise<DeliveryIntent | undefined>;
  flight(id: string): FlightRecord | undefined;
  update(patch: Partial<FlightRecord>): Promise<void>;
  work(id: string): CollaborationRecord | undefined;
  recordWork(record: CollaborationRecord): Promise<unknown>;
  complete(output: string, turnId: string): Promise<void>;
  pollMs?: number;
  observationWindowMs?: number;
}
const activeFlight = (flight?: FlightRecord) => Boolean(flight && !["completed", "failed", "cancelled"].includes(flight.state));

/**
 * Runs one fresh Ready card once. Successful RPC return establishes ownership.
 * An interrupted RPC cannot be attributed from board changes alone because the
 * T3 scheduler can claim the same Ready card concurrently.
 */
export async function runT3BoardCard(invocation: InvocationRequest, endpoint: AgentEndpoint, deps: BoardRunDependencies): Promise<void> {
  const connectionId = sourceId(endpoint.metadata?.connectionId), projectId = sourceId(endpoint.metadata?.projectId);
  const cardId = sourceId(endpoint.metadata?.t3CardId), id = deps.deliveryId;
  const failAuthenticationBeforeSubmission = async (error: unknown): Promise<boolean> => {
    if (!(error instanceof T3RpcError) || error.code !== "authentication") return false;
    await deps.mutateDelivery(id, current => ({ ...current, status: "failed", metadata: { ...current.metadata,
      phase: "rejected", rejectionCode: error.code } }));
    await deps.update({ state: "failed", error: `t3_rpc_${error.code}`, summary: "T3 rejected authentication before the card request was sent. Check the connection credentials before requesting new work.",
      completedAt: Date.now(), metadata: { dispatchOutcome: { status: "not_submitted", method: "t3.projects.runAgentBoardCard", checkedAt: Date.now(), reason: error.code } } });
    return true;
  };
  const observeWork = async (card: unknown) => {
    const record = t3CardWorkItem(connectionId, projectId, card, Date.now());
    const prior = deps.work(record.id);
    await deps.recordWork({ ...prior, ...record, waitingOn: record.waitingOn, completedAt: record.completedAt,
      summary: record.summary, relations: record.relations, conversationId: prior?.conversationId ?? invocation.conversationId,
      metadata: { ...prior?.metadata, ...record.metadata, lastInvocationId: invocation.id, source: "t3-card-run" } });
    return record;
  };
  const readCard = async () => {
    const loaded = await deps.adapter.board(projectId);
    if (loaded.project.id !== projectId) throw new Error("t3_project_identity_mismatch");
    const card = loaded.board.cards.find((value: unknown) => object(value).id === cardId);
    if (!card) throw new Error("t3_card_not_found");
    return { project: loaded.project, card: object(card) };
  };
  let receipt = deps.delivery(id);
  if (!receipt) {
    if (invocation.execution?.harness || invocation.execution?.model || invocation.execution?.reasoningEffort
      || invocation.execution?.permissionProfile || invocation.execution?.session === "fork"
      || ["foreground", "attached"].includes(invocation.execution?.placement ?? "")) throw new Error("t3_runtime_override_unsupported");
    if (!invocation.ensureAwake) throw new Error("t3_awake_only_delivery_unsupported");
    const { project, card } = await readCard();
    const runtime = card.runtime ? object(card.runtime) : {};
    if (card.state !== "Ready" || runtime.implementationRunId) throw new Error("t3_card_requires_fresh_ready");
    await observeWork(card);
    receipt = {
      id, invocationId: invocation.id, messageId: invocation.messageId, targetId: endpoint.agentId, targetNodeId: deps.nodeId,
      targetKind: "agent", transport: "http", reason: "invocation", policy: "durable", status: "sent",
      metadata: { externalSession: true, t3Session: true, endpointId: endpoint.id, connectionId, projectId, t3CardId: cardId,
        phase: "submitting", requestedAt: new Date().toISOString(), baselineState: card.state,
        // A persisted null baseline means no implementation thread was present.
        baselineImplementationThreadId: null, dispatchOutcome: "unconfirmed" },
    };
    await deps.recordDelivery(receipt);
    if (!activeFlight(deps.flight(invocation.id))) return;
    await deps.update({ state: "running", summary: "Submitting the fresh T3 board card.", metadata: { t3Session: true, t3DeliveryId: id, t3CardId: cardId,
      dispatchOutcome: { status: "submission_unknown", method: "t3.projects.runAgentBoardCard", checkedAt: Date.now() } } });
    try {
      // A cancel can arrive while the durable flight update is awaiting I/O.
      if (!activeFlight(deps.flight(invocation.id))) return;
      const result = object(await deps.adapter.call("projects.runAgentBoardCard", { cwd: project.workspaceRoot, cardId }));
      const resultCard = object(result.card);
      if (resultCard.id !== cardId) throw new Error("t3_card_identity_mismatch");
      await observeWork(resultCard);
      const threadId = sourceId(result.threadId);
      if (object(resultCard.runtime).implementationRunId !== threadId) throw new Error("t3_card_thread_identity_mismatch");
      await deps.mutateDelivery(id, current => ({ ...current, status: "acknowledged", metadata: { ...current.metadata, phase: "accepted", threadId, dispatchOutcome: "submitted" } }));
      await deps.update({ metadata: { dispatchOutcome: { status: "submitted", method: "t3.projects.runAgentBoardCard", checkedAt: Date.now() } } });
    } catch (error) {
      if (await failAuthenticationBeforeSubmission(error)) return;
      await deps.update({ state: "waiting", summary: "T3 card submission is unconfirmed. Inspect the source card; Scout will not retry its run or attribute a scheduler-owned run." });
    }
  }
  const until = Date.now() + (deps.observationWindowMs ?? 30 * 60_000);
  while (activeFlight(deps.flight(invocation.id)) && Date.now() < until) {
    try {
      const { card } = await readCard();
      const projected = await observeWork(card);
      receipt = deps.delivery(id)!;
      const runtime = card.runtime ? object(card.runtime) : {};
      const expectedThreadId = receipt.metadata?.threadId;
      if (typeof expectedThreadId !== "string") {
        await deps.mutateDelivery(id, current => ({ ...current, metadata: { ...current.metadata,
          observedState: card.state, observedImplementationThreadId: runtime.implementationRunId ?? null } }));
        await deps.update({ state: "waiting", summary: "T3 card run ownership remains unconfirmed. A changed board alone cannot prove which caller claimed it; no run will be resent." });
        return;
      }
      if (runtime.implementationRunId !== expectedThreadId) {
        await deps.update({ state: "waiting", summary: "T3 card now references another implementation thread. Inspect the source card before continuing." });
        return;
      }
      if (card.state === "Review" || card.state === "Done") {
        const thread = await deps.adapter.thread(expectedThreadId);
        if (thread.projectId !== projectId) throw new Error("t3_project_identity_mismatch");
        if (thread.latestTurn?.state !== "completed") {
          await deps.update({ state: "waiting", summary: "T3 card reached a review or acceptance column while its implementation turn is not completed. Scout is waiting for source execution proof." });
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, deps.pollMs ?? 1500); timer.unref?.(); });
          continue;
        }
        if (!card.reviewBypass && runtime.reviewRunId) {
          const reviewThread = await deps.adapter.thread(sourceId(runtime.reviewRunId));
          if (reviewThread.projectId !== projectId) throw new Error("t3_project_identity_mismatch");
          if (reviewThread.latestTurn?.state !== "completed") {
            await deps.update({ state: "waiting", summary: "T3 card reached a review or acceptance column while its review turn is not completed. Scout is waiting for source execution proof." });
            await new Promise<void>(resolve => { const timer = setTimeout(resolve, deps.pollMs ?? 1500); timer.unref?.(); });
            continue;
          }
        }
        const turnId = sourceId(thread.latestTurn?.turnId);
        await deps.mutateDelivery(id, current => ({ ...current, metadata: { ...current.metadata, t3TurnId: turnId, turnId, observedState: card.state } }));
        await deps.complete(`T3 card ${cardId} reached ${card.state}. ${card.state === "Review" ? "Human acceptance remains pending in T3." : "T3 reports the work accepted."}`, turnId);
        // Normal ask completion can update its own work record. The external
        // card remains a separate observation with the source acceptance gate.
        await observeWork(card);
        return;
      }
      if (card.state === "Canceled") {
        await deps.update({ state: "cancelled", summary: "T3 reports the card cancelled.", completedAt: Date.now() });
        await deps.mutateDelivery(id, current => ({ ...current, status: "completed", metadata: { ...current.metadata, phase: "cancelled", observedState: card.state } }));
        return;
      }
      await deps.update({ state: projected.state === "waiting" ? "waiting" : "running",
        summary: projected.state === "waiting" ? `T3 card is waiting: ${projected.waitingOn?.label ?? card.state}` : `T3 card workflow: ${card.state}.`,
        metadata: { t3CardId: cardId, t3ThreadId: expectedThreadId, t3SourceState: card.state } });
    } catch {
      await deps.update({ state: "waiting", summary: "T3 board is unavailable or inconsistent. Scout will reconcile the existing card after reconnect without launching it again." });
    }
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, deps.pollMs ?? 1500); timer.unref?.(); });
  }
  if (activeFlight(deps.flight(invocation.id))) await deps.update({ state: "waiting", summary: "T3 card observation window ended. Recovery can resume the recorded run; automatic relaunch remains disabled." });
}
