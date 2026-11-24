import type { VercelBoardConnectionConfig, VercelBoardMirrorState } from "@openscout/protocol";
import { VercelBoardHttpError, type VercelBoardTransport } from "./client.js";
import { VercelBoardMirror, vercelBoardDerivedHandoffs, vercelBoardHandoffOf, vercelBoardOriginOf, type VercelBoardTaskEventRow } from "./mirror.js";
import type { VercelBoardStore } from "./store.js";
import type { VercelBoardWireMessage } from "./wire.js";

export interface VercelBoardFollowerDeps {
  connection: Pick<VercelBoardConnectionConfig, "id" | "principal" | "profile">;
  transport: VercelBoardTransport;
  store: VercelBoardStore;
  mirror: VercelBoardMirror;
  /**
   * Side effects for changed task roots, before the read commits: custody
   * checks and promoted work items. Must be idempotent, since a lost commit
   * replays the read.
   */
  apply(roots: VercelBoardWireMessage[]): Promise<void>;
  /** Messages the board deleted or no longer has, before the read commits. Idempotent. */
  missing?(ids: string[]): Promise<void>;
  /** After the commit: the hand-offs the read recorded for the first time. */
  published?(rows: VercelBoardTaskEventRow[]): void;
  /** After the commit: the task roots the copy now holds at a newer version. The dispatcher wakes on a ready one. */
  committed?(channel: string, roots: VercelBoardWireMessage[]): void;
  /** A channel enters a backfill or a re-read, or ends one. */
  phase?(channel: string, state: VercelBoardMirrorState): void;
  now?: () => number;
}

/** The newest messages a backfill reads: one bulk call. Older threads come in through the task list. */
const BACKFILL_MESSAGES = 500;
const TASK_LIST_PAGES = 50;
/** Board keeps 30 days of events. A cursor near that age is read again rather than trusted. */
const FEED_RETENTION_MS = 29 * 24 * 60 * 60_000;

interface Read {
  messages: Map<string, VercelBoardWireMessage>;
  deleted: Set<string>;
  events: VercelBoardTaskEventRow[];
}

/**
 * Keeps a mirrored channel's copy. A narrowed caller reads each channel's own
 * feed: one cursor per channel. Each event carries its message as it is after
 * the event, so the copy applies it without a read; versions drop repeats.
 */
export class VercelBoardFollower {
  private readonly now: () => number;

  constructor(private readonly deps: VercelBoardFollowerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** One read of the feed. Returns the number of messages it changed. */
  async step(channel: string, options: { wait?: number; signal?: AbortSignal } = {}): Promise<number> {
    const { connection, store, transport } = this.deps;
    const stored = store.cursor(connection.id, channel);
    if (!stored) return this.backfill(channel, "backfilling");
    if (this.now() - stored.updatedAt > FEED_RETENTION_MS) return this.backfill(channel, "re_reading");
    let answer;
    try {
      answer = await transport.events({ channel, after: stored.cursor, wait: options.wait, signal: options.signal });
    } catch (error) {
      // The feed no longer has our cursor. Read the channel again; do not replay.
      if (error instanceof VercelBoardHttpError && error.code === "invalid_cursor") return this.backfill(channel, "re_reading");
      throw error;
    }
    const read: Read = { messages: new Map(), deleted: new Set(), events: [] };
    const fetch = new Set<string>();
    for (const event of answer.events) {
      if (event.message) keepNewest(read.messages, event.message);
      else if (event.type === "message.deleted") {
        const id = idOf(event.payload);
        if (id) read.deleted.add(id);
      } else if (event.type.startsWith("task.") || event.type.startsWith("message.")) {
        const id = idOf(event.payload);
        if (id) fetch.add(id);
      }
      const handoff = vercelBoardHandoffOf(connection.id, channel, event, this.now());
      if (handoff) read.events.push(handoff);
    }
    for (const id of fetch) {
      if (read.messages.has(id) || read.deleted.has(id)) continue;
      const message = await transport.message(id);
      if (message?.id === id) keepNewest(read.messages, message);
    }
    return this.commit(channel, stored.cursor, answer.cursor, read, answer.events.length > 0);
  }

  /**
   * Read the channel in bulk: take the feed's head first, then the newest
   * messages in one call and the task list, then each open task the copy
   * holds that both omitted. Following starts at that head, so nothing after
   * it is missed; versions drop what the head's events repeat.
   */
  async backfill(channel: string, state: "backfilling" | "re_reading" = "backfilling"): Promise<number> {
    const { connection, store, transport, mirror } = this.deps;
    this.deps.phase?.(channel, state);
    try {
      const from = store.cursor(connection.id, channel)?.cursor ?? null;
      const head = await transport.events({ channel, wait: 0 });
      const read: Read = { messages: new Map(), deleted: new Set(), events: [] };
      const page = await transport.channelMessages({ channel, limit: BACKFILL_MESSAGES });
      for (const message of page.messages) keepNewest(read.messages, message);
      let after: string | undefined;
      for (let pageIndex = 0; pageIndex < TASK_LIST_PAGES; pageIndex++) {
        const list = await transport.tasks({ channel, after });
        for (const message of list.tasks) keepNewest(read.messages, message);
        if (!list.cursor || !list.tasks.length || list.cursor === after) break;
        after = list.cursor;
      }
      for (const id of mirror.openTasks(connection.id, channel)) {
        if (read.messages.has(id)) continue;
        const message = await transport.message(id);
        if (message?.id === id) keepNewest(read.messages, message);
        else if (!message) read.deleted.add(id);
      }
      const roots = [...read.messages.values()].filter(message => message.task && message.re === null);
      const known = mirror.tasksWithEvents(connection.id, roots.map(root => root.id));
      for (const root of roots) if (!known.has(root.id)) read.events.push(...vercelBoardDerivedHandoffs(connection.id, root, this.now()));
      return await this.commit(channel, from, head.cursor, read, false);
    } finally {
      this.deps.phase?.(channel, "mirrored");
    }
  }

  /**
   * The periodic check: re-list the channel's tasks and take any newer
   * version. It does not move the cursor, so the feed stays the record of
   * what happened in between.
   */
  async refresh(channel: string): Promise<number> {
    const { connection, transport, mirror } = this.deps;
    const roots = new Map<string, VercelBoardWireMessage>();
    let after: string | undefined;
    for (let pageIndex = 0; pageIndex < TASK_LIST_PAGES; pageIndex++) {
      const list = await transport.tasks({ channel, after });
      for (const message of list.tasks) keepNewest(roots, message);
      if (!list.cursor || !list.tasks.length || list.cursor === after) break;
      after = list.cursor;
    }
    const newer = [...roots.values()].filter(root => root.version > (mirror.version(connection.id, root.id) ?? -1));
    if (!newer.length) return 0;
    await this.deps.apply(newer.filter(root => root.task));
    const changed = newer.filter(root => mirror.upsert(connection.id, root, vercelBoardOriginOf(root, connection)));
    const changedRoots = changed.filter(root => root.task && root.re === null);
    if (changedRoots.length) this.deps.committed?.(channel, changedRoots);
    return changed.length;
  }

  private async commit(channel: string, from: string | null, to: string, read: Read, delta: boolean): Promise<number> {
    const { connection, store, mirror } = this.deps;
    const newer = [...read.messages.values()].filter(message => message.version > (mirror.version(connection.id, message.id) ?? -1));
    const roots = newer.filter(message => message.task && message.re === null);
    if (roots.length) await this.deps.apply(roots);
    if (read.deleted.size) await this.deps.missing?.([...read.deleted]);
    const { changed, recorded } = store.commit({
      connectionId: connection.id, channel, from, to, delta,
      apply: () => {
        let changed = 0;
        for (const message of newer) if (mirror.upsert(connection.id, message, vercelBoardOriginOf(message, connection))) changed++;
        for (const id of read.deleted) if (mirror.tombstone(connection.id, id, channel)) changed++;
        return { changed, recorded: mirror.recordEvents(read.events) };
      },
    });
    if (recorded.length) this.deps.published?.(recorded);
    if (roots.length) this.deps.committed?.(channel, roots);
    return changed;
  }
}

function idOf(payload: Record<string, unknown>): string | undefined {
  const id = payload.id;
  return typeof id === "string" && id ? id : typeof id === "number" ? String(id) : undefined;
}

function keepNewest(messages: Map<string, VercelBoardWireMessage>, message: VercelBoardWireMessage): void {
  const current = messages.get(message.id);
  if (!current || message.version >= current.version) messages.set(message.id, message);
}
