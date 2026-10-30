import type { FlightRecord, InvocationRequest, QuestionRecord } from "@openscout/protocol";
import type { ManagedPermissionPrompt, PermissionDecision } from "./managed-permission.js";

export class PermissionDeliveryUnconfirmedError extends Error {}
/** Nothing can answer this request any more. Its record is settled. */
export class PermissionRequestEndedError extends Error {
  constructor(message: string, readonly sessionOpen: boolean) { super(message); }
}

export type PermissionReattachment = { prompt?: ManagedPermissionPrompt; sessionOpen: boolean };
type PermissionRequest = { sessionId: string; projectRoot: string; version: string; invocationId?: string; nodeId?: string };
type Pending = { invocationId: string; prompt: ManagedPermissionPrompt; busy: boolean; done: boolean; adopted?: boolean; error?: Error };

const ENDED_FLIGHT_STATES = ["cancelled", "failed", "completed"];

export class BrokerPermissionService {
  private readonly pending = new Map<string, Pending>();
  private readonly adopting = new Map<string, Promise<Pending>>();
  private reconciling?: Promise<{ adopted: string[]; closed: string[]; failed: string[] }>;
  constructor(private readonly deps: {
    operatorId: string;
    nodeId: string;
    createId: () => string;
    record: (record: QuestionRecord) => Promise<unknown>;
    read: (id: string) => QuestionRecord | undefined;
    /** Open question records, scanned when the service reconciles. */
    requests: () => QuestionRecord[];
    flight: (invocationId: string) => FlightRecord | undefined;
    /** Whether this runtime ran the invocation. Places records written before they carried a node. */
    localInvocation: (invocationId: string) => boolean;
    /** Finds the prompt a session still shows for a record whose waiter was lost. */
    reattach: (request: { sessionId: string; projectRoot: string; text: string }) => Promise<PermissionReattachment>;
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
      metadata: { permissionRequest: { sessionId: prompt.sessionId, projectRoot: prompt.projectRoot, nodeId: this.deps.nodeId,
        invocationId: invocation.id, flightId: flight?.id, version: prompt.version, decisions: prompt.decisions, decisionLabels: prompt.decisionLabels } },
    };
    const pending: Pending = { invocationId: invocation.id, prompt, busy: false, done: false };
    this.pending.set(id, pending);
    try {
      await this.deps.record(record);
      await this.deps.transition(invocation.id, "waiting", id);
      this.deps.notify(invocation, record, prompt);
      while (!pending.done) {
        await this.sleep(500);
        const currentFlight = this.deps.flight(invocation.id);
        if (currentFlight && ENDED_FLIGHT_STATES.includes(currentFlight.state)) {
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
    const opened = this.deps.read(id);
    if (!opened || opened.state !== "open") throw new PermissionRequestEndedError("Permission request is already settled.", false);
    // A restart loses the waiter. Rebind to the session, or settle the record.
    const pending = this.pending.get(id) ?? await this.adopt(opened);
    const record = this.deps.read(id) ?? opened;
    if (record.state !== "open" || pending.done) throw new PermissionRequestEndedError("Permission request is already settled.", false);
    if (pending.busy) throw new Error("Permission request is already being answered.");
    if (pending.prompt.version !== version) throw new Error("Permission request changed. Refresh.");
    if (!pending.prompt.decisions.includes(decision)) throw new Error("The harness does not offer this permission scope.");
    // A recorded attempt means keys may already have reached the harness.
    if (actuationAttempted(record)) {
      throw new Error("A decision may already have been sent. Open the session.");
    }
    pending.busy = true;
    let actuated = false;
    try {
      if (!await pending.prompt.isCurrent()) throw new Error("Permission prompt is no longer present. Refresh.");
      // Mark actuation durably before keys. A failed send is ambiguous: never replay automatically.
      await this.deps.record({ ...record, updatedAt: Date.now(), metadata: { ...record.metadata, permissionActuation: { decision, at: Date.now(), status: "attempt" } } });
      // An adopted prompt outlived its flight. The session itself is still waiting on it.
      const flight = pending.adopted ? undefined : this.deps.flight(pending.invocationId);
      if (flight && ENDED_FLIGHT_STATES.includes(flight.state)) throw new Error("Permission request's flight is no longer active.");
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
    } finally {
      pending.busy = false;
      if (pending.adopted && pending.done && this.pending.get(id) === pending) this.pending.delete(id);
    }
  }

  /**
   * The operator stops waiting on an open request to them: a permission request
   * no session here waits on, or a question an agent asked. Sends nothing to any
   * session. A request a session still waits on is answered, not dismissed.
   */
  async dismiss(id: string): Promise<void> {
    // A rebind under way decides whether a session still waits on this request.
    await this.adopting.get(id)?.catch(() => undefined);
    const record = this.deps.read(id);
    if (!record || record.state !== "open") throw new PermissionRequestEndedError("Request is already settled.", false);
    if (record.ownerId !== this.deps.operatorId) throw new Error("Only requests to the operator can be dismissed.");
    const pending = this.pending.get(id);
    if (pending?.busy) throw new Error("Permission request is already being answered.");
    if (pending && !pending.done) throw new Error("The session is still waiting on this request. Allow or deny it.");
    await this.close(id, "Dismissed by the operator", "declined");
  }

  /**
   * Rebinds or settles every open request of this host that nothing waits on.
   * Runs after a restart and on a sweep, so no record outlives its prompt.
   */
  reconcile(): Promise<{ adopted: string[]; closed: string[]; failed: string[] }> {
    this.reconciling ??= (async () => {
      const result = { adopted: [] as string[], closed: [] as string[], failed: [] as string[] };
      for (const record of this.deps.requests()) {
        if (record.state !== "open" || !permissionRequest(record) || !this.owns(record) || this.pending.has(record.id)) continue;
        try {
          await this.adopt(record);
          result.adopted.push(record.id);
        } catch (error) {
          (error instanceof PermissionRequestEndedError ? result.closed : result.failed).push(record.id);
        }
      }
      return result;
    })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }

  private adopt(record: QuestionRecord): Promise<Pending> {
    let adoption = this.adopting.get(record.id);
    if (!adoption) {
      adoption = this.bind(record).finally(() => this.adopting.delete(record.id));
      this.adopting.set(record.id, adoption);
    }
    return adoption;
  }

  private async bind(record: QuestionRecord): Promise<Pending> {
    const request = permissionRequest(record);
    if (!request) throw new Error("Not a permission request.");
    if (!this.owns(record)) throw new Error("Permission request belongs to another host.");
    // Keys may already have reached the harness. Never rebind and send again.
    if (actuationAttempted(record)) return this.settle(record.id, "A decision may already have been sent. Check the session.", true);
    // A failed lookup is not evidence that the prompt is gone. It throws, and the record stays for the next pass.
    const found = await this.deps.reattach({ sessionId: request.sessionId, projectRoot: request.projectRoot, text: record.summary ?? "" });
    const current = this.deps.read(record.id);
    if (!current || current.state !== "open") throw new PermissionRequestEndedError("Permission request is already settled.", found.sessionOpen);
    const live = this.pending.get(record.id);
    if (live) return live;
    if (!found.prompt) {
      return this.settle(record.id, found.sessionOpen
        ? "The session no longer shows this prompt."
        : "Nothing is waiting on this request any more.", found.sessionOpen);
    }
    const prompt = found.prompt;
    if (prompt.version !== request.version) {
      // Same prompt, moved cursor: answers must carry the version shown now.
      await this.deps.record({ ...current, summary: prompt.text, updatedAt: Date.now(),
        metadata: { ...current.metadata, permissionRequest: { ...current.metadata?.permissionRequest as object, version: prompt.version, decisions: prompt.decisions } } });
    }
    const pending: Pending = { invocationId: request.invocationId ?? "", prompt, busy: false, done: false, adopted: true };
    this.pending.set(record.id, pending);
    void this.watch(record.id, pending);
    return pending;
  }

  /** An adopted prompt has no flight to follow. Watch the session until the prompt leaves. */
  private async watch(id: string, pending: Pending): Promise<void> {
    try {
      while (!pending.done) {
        await this.sleep(500);
        if (pending.busy || pending.done) continue;
        if (!await pending.prompt.isCurrent() && !pending.busy && !pending.done) {
          pending.done = true;
          await this.close(id, "Prompt is no longer present", "closed");
        }
      }
    } catch {
      // A failed check is not evidence that the prompt left. Release the binding; the next pass looks again.
    } finally {
      if (!pending.busy && this.pending.get(id) === pending) this.pending.delete(id);
    }
  }

  private async settle(id: string, answer: string, sessionOpen: boolean): Promise<never> {
    await this.close(id, answer, "declined");
    throw new PermissionRequestEndedError(answer, sessionOpen);
  }

  private owns(record: QuestionRecord): boolean {
    const request = permissionRequest(record);
    if (request?.nodeId) return request.nodeId === this.deps.nodeId;
    return Boolean(request?.invocationId && this.deps.localInvocation(request.invocationId));
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? (value => new Promise(resolve => setTimeout(resolve, value))))(ms);
  }

  private async close(id: string, answer: string, state: "closed" | "declined"): Promise<void> {
    const record = this.deps.read(id);
    if (record) await this.deps.record({ ...record, state, answer, answeredById: this.deps.operatorId,
      nextMoveOwnerId: undefined, answeredAt: Date.now(), closedAt: Date.now(), updatedAt: Date.now() });
  }
}

function permissionRequest(record: QuestionRecord): PermissionRequest | undefined {
  const value = record.metadata?.permissionRequest as Partial<PermissionRequest> | undefined;
  return typeof value?.sessionId === "string" && typeof value.projectRoot === "string" && typeof value.version === "string"
    ? value as PermissionRequest : undefined;
}

function actuationAttempted(record: QuestionRecord): boolean {
  return (record.metadata?.permissionActuation as { status?: string } | undefined)?.status === "attempt";
}
