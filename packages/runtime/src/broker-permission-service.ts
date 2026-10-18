import type { FlightRecord, InvocationRequest, QuestionRecord } from "@openscout/protocol";
import type { ManagedPermissionPrompt, PermissionDecision } from "./managed-permission.js";

export class PermissionDeliveryUnconfirmedError extends Error {}

export class BrokerPermissionService {
  private readonly pending = new Map<string, { invocationId: string; prompt: ManagedPermissionPrompt; busy: boolean; done: boolean; error?: Error }>();
  constructor(private readonly deps: {
    operatorId: string;
    createId: () => string;
    record: (record: QuestionRecord) => Promise<unknown>;
    read: (id: string) => QuestionRecord | undefined;
    flight: (invocationId: string) => FlightRecord | undefined;
    transition: (invocationId: string, state: "waiting" | "running", requestId: string | null) => Promise<unknown>;
    notify: (invocation: InvocationRequest, record: QuestionRecord, prompt: ManagedPermissionPrompt) => void;
    sleep?: (ms: number) => Promise<void>;
  }) {}

  async wait(invocation: InvocationRequest, prompt: ManagedPermissionPrompt): Promise<void> {
    const id = this.deps.createId();
    const flight = this.deps.flight(invocation.id);
    const record: QuestionRecord = {
      id, kind: "question", state: "open", acceptanceState: "none",
      title: "Permission request", summary: prompt.text,
      createdById: invocation.targetAgentId, askedById: invocation.targetAgentId,
      ownerId: this.deps.operatorId, nextMoveOwnerId: this.deps.operatorId,
      conversationId: invocation.conversationId,
      createdAt: Date.now(), updatedAt: Date.now(),
      metadata: { permissionRequest: { sessionId: prompt.sessionId, projectRoot: prompt.projectRoot,
        invocationId: invocation.id, flightId: flight?.id, version: prompt.version, decisions: prompt.decisions, decisionLabels: prompt.decisionLabels } },
    };
    const pending: { invocationId: string; prompt: ManagedPermissionPrompt; busy: boolean; done: boolean; error?: Error } = { invocationId: invocation.id, prompt, busy: false, done: false };
    this.pending.set(id, pending);
    try {
      await this.deps.record(record);
      await this.deps.transition(invocation.id, "waiting", id);
      this.deps.notify(invocation, record, prompt);
      while (!pending.done) {
        await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(500);
        const currentFlight = this.deps.flight(invocation.id);
        if (currentFlight && ["cancelled", "failed", "completed"].includes(currentFlight.state)) {
          throw new Error("Permission request's flight is no longer active.");
        }
        if (!pending.busy && !pending.done && !await prompt.isCurrent()) {
          await this.close(id, "Prompt is no longer present", "closed");
          pending.done = true;
        }
      }
      if (pending.error) throw pending.error;
      await this.deps.transition(invocation.id, "running", null);
    } catch (error) {
      if (!pending.done) await this.close(id, "Permission wait ended without a decision", "declined");
      throw error;
    } finally { this.pending.delete(id); }
  }

  async decide(id: string, version: string, decision: PermissionDecision): Promise<void> {
    const record = this.deps.read(id);
    const pending = this.pending.get(id);
    if (!record || record.state !== "open" || !pending || pending.done) throw new Error("Permission request has no live waiting process. Open the session.");
    if (pending.busy) throw new Error("Permission request is already being answered.");
    if (pending.prompt.version !== version) throw new Error("Permission request changed. Refresh.");
    if (!pending.prompt.decisions.includes(decision)) throw new Error("The harness does not offer this permission scope.");
    // A recorded attempt means keys may already have reached the harness.
    if ((record.metadata?.permissionActuation as { status?: string } | undefined)?.status === "attempt") {
      throw new Error("A decision may already have been sent. Open the session.");
    }
    pending.busy = true;
    let actuated = false;
    try {
      if (!await pending.prompt.isCurrent()) throw new Error("Permission prompt is no longer present. Refresh.");
      // Mark actuation durably before keys. A failed send is ambiguous: never replay automatically.
      await this.deps.record({ ...record, updatedAt: Date.now(), metadata: { ...record.metadata, permissionActuation: { decision, at: Date.now(), status: "attempt" } } });
      const flight = this.deps.flight(pending.invocationId);
      if (flight && ["cancelled", "failed", "completed"].includes(flight.state)) throw new Error("Permission request's flight is no longer active.");
      actuated = true;
      await pending.prompt.answer(decision);
      await this.close(id, decision, "closed");
      pending.done = true;
    } catch (error) {
      pending.error = actuated
        ? new PermissionDeliveryUnconfirmedError(error instanceof Error ? error.message : String(error))
        : error instanceof Error ? error : new Error(String(error));
      // Settle before the close write: if that write fails too, this request
      // must still never be answerable again.
      pending.done = true;
      await this.close(id, `Decision delivery unconfirmed: ${error instanceof Error ? error.message : String(error)}`, "declined")
        .catch(() => undefined);
      throw pending.error;
    } finally { pending.busy = false; }
  }
  private async close(id: string, answer: string, state: "closed" | "declined"): Promise<void> {
    const record = this.deps.read(id);
    if (record) await this.deps.record({ ...record, state, answer, answeredById: this.deps.operatorId,
      nextMoveOwnerId: undefined, answeredAt: Date.now(), closedAt: Date.now(), updatedAt: Date.now() });
  }
}
