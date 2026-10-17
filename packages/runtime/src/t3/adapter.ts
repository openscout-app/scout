import { createHash } from "node:crypto";
import type { ExternalWorkContext, WorkItemRecord } from "@openscout/protocol";
import { T3RpcClient, type T3RpcRequestOptions } from "./rpc-client.js";

/** The instance id is operator-owned and remains stable across token rotation. */
export interface T3Connection { id: string; url: string; tokenEnv: string }
export function t3Connections(env: NodeJS.ProcessEnv): T3Connection[] {
  let input: unknown;
  try { input = JSON.parse(env.OPENSCOUT_T3_CONNECTIONS || "[]"); }
  catch { throw new Error("t3_connections_invalid"); }
  if (!Array.isArray(input) || input.length > 32) throw new Error("t3_connections_invalid");
  const ids = new Set<string>();
  return input.map(value => {
    const c = object(value);
    if (typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id)
      || typeof c.url !== "string" || typeof c.tokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(c.tokenEnv)) throw new Error("t3_connections_invalid");
    // Validate without making a connection or resolving credentials.
    const url = new URL(c.url);
    if (!["https:", "wss:", "http:", "ws:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !["/", "/ws"].includes(url.pathname)
      || (["http:", "ws:"].includes(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("t3_connection_url_invalid");
    ids.add(c.id);
    return { id: c.id, url: c.url, tokenEnv: c.tokenEnv };
  });
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("t3_invalid_response");
  return value as Record<string, any>;
}
export function sourceId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("t3_invalid_source_id");
  return value;
}
export const t3ScopedId = (prefix: string, ...ids: string[]) => `${prefix}-${createHash("sha256").update(JSON.stringify(ids)).digest("hex").slice(0, 32)}`;

export class T3Adapter {
  constructor(readonly connection: T3Connection, private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clientFactory = (options: { url: string; token: string }) => new T3RpcClient(options)) {}
  private async withClient<T>(fn: (client: T3RpcClient) => Promise<T>): Promise<T> {
    const token = this.env[this.connection.tokenEnv]?.trim();
    if (!token) throw new Error("t3_credential_missing");
    const client = this.clientFactory({ url: this.connection.url, token });
    try { return await fn(client); } finally { client.close(); }
  }
  async call<T = unknown>(tag: string, payload: unknown, options: T3RpcRequestOptions = {}): Promise<T> {
    return this.withClient(client => client.call<T>(tag, payload, options));
  }
  private async snapshot(tag: string, payload: unknown, options: T3RpcRequestOptions = {}): Promise<Record<string, any>> {
    return this.withClient(async client => {
      for await (const value of client.stream<unknown>(tag, payload, options)) {
        const frame = object(value);
        if (frame.kind === "snapshot") return object(frame.snapshot);
        throw new Error("t3_snapshot_required");
      }
      throw new Error("t3_snapshot_missing");
    });
  }
  async inspect() {
    const snapshot = await this.snapshot("orchestration.subscribeShell", {});
    if (!Array.isArray(snapshot.projects) || !Array.isArray(snapshot.threads)) throw new Error("t3_invalid_shell");
    return snapshot as { projects: Record<string, any>[]; threads: Record<string, any>[]; snapshotSequence: number };
  }
  async thread(threadId: string, options: T3RpcRequestOptions = {}) {
    const snapshot = await this.snapshot("orchestration.subscribeThread", { threadId: sourceId(threadId) }, options);
    const thread = object(snapshot.thread);
    if (thread.id !== threadId || !Array.isArray(thread.messages) || !Array.isArray(thread.activities)) throw new Error("t3_thread_identity_mismatch");
    sourceId(thread.projectId);
    if (typeof thread.runtimeMode !== "string" || typeof thread.interactionMode !== "string") throw new Error("t3_invalid_thread_modes");
    return thread;
  }
  async project(projectId: string) {
    const shell = await this.inspect();
    const project = shell.projects.find(p => p.id === projectId);
    if (!project || typeof project.workspaceRoot !== "string") throw new Error("t3_project_not_found");
    return project;
  }
  async board(projectId: string) {
    const project = await this.project(projectId);
    const result = object(await this.call("projects.loadAgentBoard", { cwd: project.workspaceRoot, createIfMissing: false }));
    const board = object(result.board);
    if (!Array.isArray(board.cards) || board.cards.length > 10_000) throw new Error("t3_invalid_board");
    return { project, board };
  }
  start(thread: Record<string, any>, input: { commandId: string; messageId: string; text: string; createdAt: string }, signal?: AbortSignal) {
    return this.call("orchestration.dispatchCommand", {
      type: "thread.turn.start", commandId: input.commandId, threadId: sourceId(thread.id),
      message: { messageId: input.messageId, role: "user", text: input.text, attachments: [] },
      runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode, createdAt: input.createdAt,
    }, { signal });
  }
}

/** Pure projection of source-owned facts. A passing review still awaits a person. */
export function t3CardWorkItem(connectionId: string, projectId: string, cardValue: unknown, now: number): WorkItemRecord {
  const card = object(cardValue), cardId = sourceId(card.id), state = sourceId(card.state);
  const runtime = card.runtime ? object(card.runtime) : {};
  if (card.dependencies !== undefined && !Array.isArray(card.dependencies)) throw new Error("t3_invalid_dependencies");
  const actor = t3ScopedId("t3", connectionId, projectId);
  const waiting = ["Blocked", "Needs Decision"].includes(state);
  const review = state === "Review";
  const terminal = ["Done", "Canceled"].includes(state);
  const human = t3ScopedId("t3-owner", connectionId, projectId);
  const repairing = state === "Diagnosing" && Boolean(runtime.repairRequestedAt);
  const stages = [
    ...(runtime.implementationRunId ? [{ id: "implementation", kind: "implementation", state: state === "Running" ? "running" : "observed", threadId: sourceId(runtime.implementationRunId) }] : []),
    ...(card.reviewBypass ? [{ id: "review", kind: "review", state: "bypassed" }]
      : runtime.reviewRunId ? [{ id: "review", kind: "review", state: state === "Reviewing" ? "running" : "observed", threadId: sourceId(runtime.reviewRunId) }] : []),
    ...(runtime.repairRequestedAt ? [{ id: "repair", kind: "repair", state: repairing ? "running" : "observed", ...(runtime.implementationRunId ? { threadId: sourceId(runtime.implementationRunId) } : {}) }] : []),
  ];
  const externalContext: ExternalWorkContext = {
    source: { adapterId: "t3-orchestrator", instanceId: connectionId, projectId, workItemId: cardId },
    observedAt: now, sourceState: state,
    board: { id: projectId, title: "T3 project board", column: { id: state, title: state } },
    // Board workflow status does not establish a provider's execution status.
    workflow: { stages,
      ...(state === "Reviewing" && runtime.reviewRunId ? { activeStageId: "review" }
        : repairing && runtime.implementationRunId ? { activeStageId: "repair" }
        : state === "Running" && runtime.implementationRunId ? { activeStageId: "implementation" } : {}),
      humanAcceptance: { required: true, state: state === "Done" ? "accepted" : "pending", sourceState: state },
    },
  };
  const createdAt = typeof card.createdAt === "string" && Number.isFinite(Date.parse(card.createdAt)) ? Date.parse(card.createdAt) : now;
  const updatedAt = typeof card.updatedAt === "string" && Number.isFinite(Date.parse(card.updatedAt)) ? Date.parse(card.updatedAt) : now;
  return {
    id: t3ScopedId("t3-work", connectionId, projectId, cardId), kind: "work_item", title: sourceId(card.title),
    ...(typeof card.intentBrief?.intent === "string" ? { summary: card.intentBrief.intent } : {}),
    ...(Array.isArray(card.dependencies) ? { relations: card.dependencies.map((dependency: unknown) => ({
      kind: "depends_on" as const, targetId: t3ScopedId("t3-work", connectionId, projectId, sourceId(dependency)),
      metadata: { adapterId: "t3-orchestrator", instanceId: connectionId, projectId, workItemId: dependency },
    })) } : {}),
    state: state === "Done" ? "done" : state === "Canceled" ? "cancelled" : review ? "review" : waiting ? "waiting"
      : ["Running", "Reviewing", "Diagnosing"].includes(state) ? "working" : "open",
    acceptanceState: state === "Done" ? "accepted" : "pending", createdById: actor, ownerId: actor,
    nextMoveOwnerId: review || waiting ? human : actor, requestedById: human,
    createdAt, updatedAt: Math.max(createdAt, now),
    ...(terminal ? { completedAt: updatedAt } : {}),
    ...(waiting ? { waitingOn: { kind: "condition" as const, label: typeof runtime.currentDecisionQuestion === "string" ? runtime.currentDecisionQuestion : typeof runtime.currentError === "string" ? runtime.currentError : state } } : {}),
    externalContext,
    metadata: { sourceIntentBrief: card.intentBrief,
      sourcePriority: typeof card.priority === "number" ? card.priority : undefined,
      sourceArea: typeof card.area === "string" ? card.area : undefined,
      sourceSlice: typeof card.slice === "string" ? card.slice : undefined },
  };
}
