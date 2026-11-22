/**
 * The runtime's side of Scout Hub: pull sealed chunks from the inbox, open
 * them with this runtime's key, append them to mirror transcripts, then delete
 * them from the inbox. It reads the config on every pass, so `scout hub init`
 * takes effect without a restart.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyChunkToMirror, mirrorPathForHeader } from "./mirror.js";
import { openHubChunk, type HubChunkHeader, type HubKeyPair } from "./seal.js";
import { loadHubConfig, loadHubIdentity, resolveHubClaudeMirrorRoot, resolveHubHome } from "./state.js";

export type HubInboxItem = { key: string; size: number; uploaded: string };

export class HubInboxError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class HubInboxClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new HubInboxError(`Inbox ${init.method ?? "GET"} ${path} answered ${response.status}`, response.status);
    return response;
  }

  async health(): Promise<{ ok: boolean; pending?: number }> {
    return (await this.request("/v1/inbox/health")).json() as Promise<{ ok: boolean; pending?: number }>;
  }

  async pending(after?: string, limit = 100): Promise<{ items: HubInboxItem[]; cursor: string | null }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set("after", after);
    return (await this.request(`/v1/inbox/pending?${query}`)).json() as Promise<{ items: HubInboxItem[]; cursor: string | null }>;
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request(`/v1/inbox/chunks/${encodeURIComponent(key)}`)).arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.request(`/v1/inbox/chunks/${encodeURIComponent(key)}`, { method: "DELETE" });
  }
}

export type HubCollectSummary = {
  at: string;
  configured: boolean;
  fetched: number;
  appended: number;
  duplicate: number;
  waiting: number;
  rejected: number;
  sessions: string[];
  error?: string;
  notes: string[];
};

type Opened = { key: string; header: HubChunkHeader; data: Uint8Array; target: string };

export type HubCollectorOptions = {
  home?: string;
  mirrorRoot?: string;
  intervalMs?: number;
  maxItemsPerPass?: number;
  fetch?: typeof fetch;
  log?: (message: string) => void;
};

export class HubCollectorService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<HubCollectSummary> | null = null;
  private stopped = true;
  private lastError: string | null = null;

  constructor(private readonly options: HubCollectorOptions = {}) {}

  private get home(): string {
    return this.options.home ?? resolveHubHome();
  }

  private get mirrorRoot(): string {
    return this.options.mirrorRoot ?? resolveHubClaudeMirrorRoot();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(1_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.collectOnce().finally(() => this.schedule(this.options.intervalMs ?? 15_000));
    }, delayMs);
    this.timer.unref?.();
  }

  /** One pass. Concurrent calls share the pass in progress. */
  collectOnce(): Promise<HubCollectSummary> {
    this.running ??= this.pass().finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(): Promise<HubCollectSummary> {
    const summary: HubCollectSummary = {
      at: new Date().toISOString(), configured: false, fetched: 0, appended: 0, duplicate: 0, waiting: 0, rejected: 0, sessions: [], notes: [],
    };
    let config;
    let identity: HubKeyPair | null;
    try {
      config = loadHubConfig(this.home);
      identity = loadHubIdentity(this.home);
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
      return this.finish(summary);
    }
    if (!config || !identity) return summary;
    summary.configured = true;
    const lock = join(this.home, "collect.lock");
    try {
      mkdirSync(lock);
    } catch {
      // Another process (the CLI or the runtime) is collecting. Take over a lock left by a crash.
      try {
        if (Date.now() - statSync(lock).mtimeMs < 5 * 60_000) { summary.notes.push("another collector is running"); return summary; }
      } catch { /* gone already */ }
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
    }
    try {
      await this.drain(new HubInboxClient(config.inbox, config.readToken, this.options.fetch), identity, summary);
      this.lastError = null;
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    return this.finish(summary);
  }

  private async drain(client: HubInboxClient, identity: HubKeyPair, summary: HubCollectSummary): Promise<void> {
    const max = this.options.maxItemsPerPass ?? 500;
    const opened: Opened[] = [];
    let cursor: string | undefined;
    while (summary.fetched < max) {
      const page = await client.pending(cursor, Math.min(100, max - summary.fetched));
      for (const item of page.items) {
        summary.fetched += 1;
        const bytes = await client.get(item.key);
        try {
          const { header, data } = openHubChunk(bytes, identity);
          const target = mirrorPathForHeader(this.mirrorRoot, header);
          if ("reason" in target) throw new Error(target.reason);
          opened.push({ key: item.key, header, data, target: target.path });
        } catch (error) {
          // Not sealed to this runtime, or not a chunk we accept. It can never apply.
          summary.rejected += 1;
          summary.notes.push(`${item.key}: ${error instanceof Error ? error.message : String(error)}`);
          await client.delete(item.key);
        }
      }
      if (!page.cursor || page.items.length === 0) break;
      cursor = page.cursor;
    }
    // Within one pass, apply each file's chunks in offset order.
    opened.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : a.header.offset - b.header.offset));
    const sessions = new Set<string>();
    for (const chunk of opened) {
      const result = applyChunkToMirror(this.mirrorRoot, chunk.header, chunk.data);
      if (result.outcome === "gap") {
        // An earlier chunk has not arrived yet. Leave this one in the inbox.
        summary.waiting += 1;
        continue;
      }
      if (result.outcome === "appended") { summary.appended += 1; sessions.add(`${chunk.header.label}/${chunk.header.sessionId}`); }
      if (result.outcome === "duplicate") summary.duplicate += 1;
      if (result.outcome === "rejected") { summary.rejected += 1; summary.notes.push(`${chunk.key}: ${result.reason}`); }
      await client.delete(chunk.key);
    }
    summary.sessions = [...sessions];
  }

  private finish(summary: HubCollectSummary): HubCollectSummary {
    if (summary.error && summary.error !== this.lastError) this.options.log?.(`[openscout-runtime] Scout Hub collect failed: ${summary.error}`);
    this.lastError = summary.error ?? null;
    if (summary.configured || summary.error) {
      try {
        writeFileSync(join(this.home, "status.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
      } catch { /* status is best effort */ }
    }
    return summary;
  }
}
