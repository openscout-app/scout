import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { isOpaqueChannelId, mintChannelId } from "@openscout/protocol";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

import type {
  ScoutBrokerConversationRecord,
  ScoutBrokerSnapshot,
} from "../core/broker/service.ts";
import {
  SCOUTBOT_DEFAULT_THREAD_ID,
  SCOUTBOT_DEFAULT_THREAD_NAME,
} from "@openscout/runtime/scoutbot-role";

export type ScoutbotThreadPins = {
  projectRoot?: string;
  topic?: string;
  originatingEventId?: string;
} | null;

export type ScoutbotThreadRuntime = {
  model?: string;
  reasoningEffort?: string;
};

export type ScoutbotThreadRecord = ScoutbotThreadRuntime & {
  threadId: string;
  name: string;
  conversationId: string;
  transportSessionId: string | null;
  transport: "codex_app_server" | string;
  pins: ScoutbotThreadPins;
  lastActiveAt: number;
  archivedAt?: number | null;
};

export type ScoutbotThreadListResponse = {
  threads: ScoutbotThreadRecord[];
  defaultThreadId: string;
};

type StoredThreadMap = {
  version: 1;
  defaultThreadId: string;
  threads: ScoutbotThreadRecord[];
};

export type EnsureDefaultThreadOptions = {
  snapshot?: ScoutBrokerSnapshot | null;
  transportSessionId?: string | null;
  transport?: string;
  now?: number;
};

export type CreateThreadOptions = ScoutbotThreadRuntime & {
  threadId?: string;
  transportSessionId: string | null;
  conversationId?: string;
  transport?: string;
  pins?: ScoutbotThreadPins;
  now?: number;
};

export class ScoutbotThreadMapStore {
  readonly filePath: string;

  constructor(filePath = defaultScoutbotThreadMapPath()) {
    this.filePath = filePath;
  }

  async getThreads(): Promise<ScoutbotThreadRecord[]> {
    const map = await this.read();
    return map.threads.filter((thread) => !thread.archivedAt);
  }

  async list(): Promise<ScoutbotThreadListResponse> {
    const map = await this.read();
    return {
      threads: map.threads.filter((thread) => !thread.archivedAt),
      defaultThreadId: map.defaultThreadId,
    };
  }

  async getThread(threadId: string): Promise<ScoutbotThreadRecord | null> {
    const normalized = threadId.trim();
    if (!normalized) return null;
    const map = await this.read();
    return map.threads.find((thread) => thread.threadId === normalized && !thread.archivedAt) ?? null;
  }

  async getThreadByConversationId(conversationId: string): Promise<ScoutbotThreadRecord | null> {
    const normalized = conversationId.trim();
    if (!normalized) return null;
    const map = await this.read();
    return map.threads.find((thread) => thread.conversationId === normalized && !thread.archivedAt) ?? null;
  }

  async ensureDefaultThread(options: EnsureDefaultThreadOptions): Promise<ScoutbotThreadRecord> {
    return serializeThreadMapMutation(this.filePath, async () => {
      const now = options.now ?? Date.now();
      const map = await this.read();
      const existing = map.threads.find((thread) => thread.threadId === map.defaultThreadId);
      if (existing) {
        const conversationId = isOpaqueChannelId(existing.conversationId)
          ? existing.conversationId
          : chooseDefaultConversationId(options.snapshot);
        const next = {
          ...existing,
          conversationId,
          transportSessionId: options.transportSessionId !== undefined ? normalizeSessionId(options.transportSessionId) : existing.transportSessionId,
          transport: options.transport ?? existing.transport,
        };
        if (sameThread(existing, next)) return existing;
        const updated = replaceThread(map, next);
        await this.write(updated);
        return next;
      }

      const conversationId = chooseDefaultConversationId(options.snapshot);
      const thread: ScoutbotThreadRecord = {
        threadId: SCOUTBOT_DEFAULT_THREAD_ID,
        name: SCOUTBOT_DEFAULT_THREAD_NAME,
        conversationId,
        transportSessionId: normalizeSessionId(options.transportSessionId),
        transport: options.transport ?? "codex_app_server",
        pins: null,
        lastActiveAt: now,
      };
      await this.write({
        version: 1,
        defaultThreadId: SCOUTBOT_DEFAULT_THREAD_ID,
        threads: [thread, ...map.threads],
      });
      return thread;
    });
  }

  async createThread(name: string, opts: CreateThreadOptions): Promise<ScoutbotThreadRecord> {
    return serializeThreadMapMutation(this.filePath, async () => {
      const map = await this.read();
      const now = opts.now ?? Date.now();
      const threadId = opts.threadId?.trim() || `thr-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const conversationId = opts.conversationId?.trim() || mintChannelId(randomUUID);
      const thread: ScoutbotThreadRecord = {
        threadId,
        name: name.trim() || threadId,
        conversationId,
        transportSessionId: normalizeSessionId(opts.transportSessionId),
        transport: opts.transport ?? "codex_app_server",
        pins: opts.pins ?? null,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        lastActiveAt: now,
      };
      await this.write({
        ...map,
        threads: [...map.threads.filter((candidate) => candidate.threadId !== threadId), thread],
      });
      return thread;
    });
  }

  async archiveThread(threadId: string): Promise<ScoutbotThreadRecord | null> {
    return serializeThreadMapMutation(this.filePath, async () => {
      const map = await this.read();
      const thread = map.threads.find((candidate) => candidate.threadId === threadId);
      if (!thread || thread.threadId === map.defaultThreadId) return null;
      const archived = { ...thread, archivedAt: Date.now() };
      await this.write(replaceThread(map, archived));
      return archived;
    });
  }

  async touchThread(threadId: string, now = Date.now()): Promise<void> {
    return serializeThreadMapMutation(this.filePath, async () => {
      const map = await this.read();
      const thread = map.threads.find((candidate) => candidate.threadId === threadId);
      if (!thread) return;
      await this.write(replaceThread(map, { ...thread, lastActiveAt: now }));
    });
  }

  async setThreadTransportSessionId(
    threadId: string,
    transportSessionId: string | null | undefined,
    now = Date.now(),
  ): Promise<ScoutbotThreadRecord | null> {
    return serializeThreadMapMutation(this.filePath, async () => {
      const normalized = normalizeSessionId(transportSessionId);
      const map = await this.read();
      const thread = map.threads.find((candidate) => candidate.threadId === threadId);
      if (!thread) return null;
      const next = { ...thread, transportSessionId: normalized, lastActiveAt: now };
      if (sameThread(thread, next)) return thread;
      await this.write(replaceThread(map, next));
      return next;
    });
  }

  private async read(): Promise<StoredThreadMap> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredThreadMap>;
      const threads = Array.isArray(parsed.threads)
        ? parsed.threads.filter(isThreadRecord).map((thread) => ({
          ...thread,
          transportSessionId: normalizeSessionId(thread.transportSessionId),
        }))
        : [];
      return {
        version: 1,
        defaultThreadId: typeof parsed.defaultThreadId === "string" && parsed.defaultThreadId.trim()
          ? parsed.defaultThreadId
          : SCOUTBOT_DEFAULT_THREAD_ID,
        threads,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, defaultThreadId: SCOUTBOT_DEFAULT_THREAD_ID, threads: [] };
      }
      throw error;
    }
  }

  private async write(map: StoredThreadMap): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

export function defaultScoutbotThreadMapPath(): string {
  return join(resolveOpenScoutSupportPaths().supportDirectory, "scoutbot-threads.json");
}

export function chooseDefaultConversationId(snapshot?: ScoutBrokerSnapshot | null): string {
  const existing = Object.values(snapshot?.conversations ?? {}).find(
    (conversation) =>
      conversation.metadata?.scoutbotThreadId === SCOUTBOT_DEFAULT_THREAD_ID
      && isOpaqueChannelId(conversation.id),
  );
  return existing?.id ?? mintChannelId(randomUUID);
}

export function buildScoutbotThreadConversation(
  thread: ScoutbotThreadRecord,
  snapshot: ScoutBrokerSnapshot,
  nodeId: string,
): ScoutBrokerConversationRecord | null {
  const existing = snapshot.conversations[thread.conversationId];
  if (existing) return null;
  const participantIds = ["operator", "scoutbot"].sort();
  return {
    id: thread.conversationId,
    kind: "direct",
    title: thread.name === SCOUTBOT_DEFAULT_THREAD_NAME ? "Scout · default" : `Scout · ${thread.name}`,
    visibility: "private",
    shareMode: "local",
    authorityNodeId: nodeId,
    participantIds,
    metadata: {
      surface: "scoutbot",
      scoutbotThreadId: thread.threadId,
      transportSessionId: thread.transportSessionId,
      transport: thread.transport,
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
    },
  };
}

function isThreadRecord(value: unknown): value is ScoutbotThreadRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ScoutbotThreadRecord>;
  return typeof record.threadId === "string"
    && typeof record.name === "string"
    && typeof record.conversationId === "string"
    && (typeof record.transportSessionId === "string" || record.transportSessionId === null || record.transportSessionId === undefined)
    && typeof record.transport === "string"
    && typeof record.lastActiveAt === "number";
}

function normalizeSessionId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function replaceThread(map: StoredThreadMap, thread: ScoutbotThreadRecord): StoredThreadMap {
  return {
    ...map,
    threads: map.threads.map((candidate) => candidate.threadId === thread.threadId ? thread : candidate),
  };
}

function sameThread(left: ScoutbotThreadRecord, right: ScoutbotThreadRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Runner events and HTTP requests share this map; serialize their complete
// mutations so a reply cannot erase a concurrently-created conversation.
const threadMapMutations = new Map<string, Promise<unknown>>();
async function serializeThreadMapMutation<T>(path: string, update: () => Promise<T>): Promise<T> {
  const previous = threadMapMutations.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  threadMapMutations.set(path, next);
  try { return await next; }
  finally { if (threadMapMutations.get(path) === next) threadMapMutations.delete(path); }
}
