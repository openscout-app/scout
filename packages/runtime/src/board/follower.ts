import type { BoardConnectionConfig } from "@openscout/protocol";
import { BoardHttpError, type BoardTransport } from "./client.js";
import type { BoardStore } from "./store.js";
import type { BoardWireMessage } from "./wire.js";

export interface BoardFollowerDeps {
  connection: Pick<BoardConnectionConfig, "id" | "channels">;
  transport: BoardTransport;
  store: BoardStore;
  /** Upsert work items for these task roots. Must be idempotent: a lost cursor commit replays the batch. */
  apply(roots: BoardWireMessage[]): Promise<void>;
  /** Root IDs that Scout shows as not finished in a channel. The reconcile reads each one the task list omits. */
  openRoots(channel: string): string[];
  /** A root the board no longer has: blank it in Scout. */
  applyMissing(rootId: string): Promise<void>;
}

const TASK_LIST_PAGES = 50;

/**
 * Follows one channel's feed. A caller narrowed with `x-board-can` reads each
 * followed channel's own feed, so there is one cursor per channel. Reads are
 * at-least-once; a root applies only when its version is higher than the
 * stored one.
 */
export class BoardFollower {
  constructor(private readonly deps: BoardFollowerDeps) {}

  /** One read. Returns the number of task roots applied. */
  async step(channel: string, options: { wait?: number; signal?: AbortSignal } = {}): Promise<number> {
    const { connection, store, transport } = this.deps;
    const from = store.cursor(connection.id, channel)?.cursor ?? null;
    if (from === null) return this.reconcile(channel);
    let answer;
    try {
      answer = await transport.events({ channel, after: from, wait: options.wait, signal: options.signal });
    } catch (error) {
      // The feed no longer has our cursor, or we were idle past what it keeps. Do not replay.
      if (error instanceof BoardHttpError && error.code === "invalid_cursor") {
        store.dropCursor(connection.id, channel);
        return this.reconcile(channel);
      }
      throw error;
    }
    const roots = new Map<string, BoardWireMessage>();
    const fetchIds = new Set<string>();
    for (const event of answer.events) {
      const message = event.message;
      if (message?.task && message.re === null) keepNewest(roots, message);
      else if (event.type.startsWith("task.") || event.type === "message.deleted" || event.type === "message.edited") {
        const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
        if (id && !(message && message.id === id && message.re === null)) fetchIds.add(id);
      }
    }
    for (const id of fetchIds) {
      if (roots.has(id)) continue;
      const message = await transport.message(id);
      if (message?.task && message.re === null) keepNewest(roots, message);
    }
    const applied = await this.applyNewer(roots);
    store.commitBatch({ connectionId: connection.id, channel, from, to: answer.cursor, versions: applied.versions });
    return applied.count;
  }

  /**
   * First connect, or a rejected cursor: take the head first, then list the
   * channel's tasks and upsert each, then read individually each root Scout
   * shows open that the list omitted. Following then starts at that head, so
   * nothing between the head and the list is missed; versions drop repeats.
   */
  async reconcile(channel: string): Promise<number> {
    const { connection, store, transport } = this.deps;
    const from = store.cursor(connection.id, channel)?.cursor ?? null;
    const head = await transport.events({ channel, wait: 0 });
    const roots = new Map<string, BoardWireMessage>();
    let after: string | undefined;
    for (let page = 0; page < TASK_LIST_PAGES; page++) {
      const list = await transport.tasks({ channel, after });
      for (const message of list.tasks) if (message.task && message.re === null) keepNewest(roots, message);
      if (!list.cursor || !list.tasks.length || list.cursor === after) break;
      after = list.cursor;
    }
    for (const rootId of this.deps.openRoots(channel)) {
      if (roots.has(rootId)) continue;
      const message = await transport.message(rootId);
      if (message?.task && message.re === null) keepNewest(roots, message);
      else if (!message) await this.deps.applyMissing(rootId);
    }
    const applied = await this.applyNewer(roots);
    store.commitBatch({ connectionId: connection.id, channel, from, to: head.cursor, versions: applied.versions });
    return applied.count;
  }

  private async applyNewer(roots: Map<string, BoardWireMessage>): Promise<{ count: number; versions: Map<string, number> }> {
    const { connection, store } = this.deps;
    const newer = [...roots.values()].filter(root => root.version > (store.version(connection.id, root.id) ?? -1));
    if (newer.length) await this.deps.apply(newer);
    return { count: newer.length, versions: new Map(newer.map(root => [root.id, root.version])) };
  }
}

function keepNewest(roots: Map<string, BoardWireMessage>, message: BoardWireMessage): void {
  const current = roots.get(message.id);
  if (!current || message.version >= current.version) roots.set(message.id, message);
}
