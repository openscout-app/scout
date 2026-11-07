import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { basename, join } from "node:path";

import type { BrokerPermissionService } from "./broker-permission-service.js";
import {
  parseClaudeSessionRecord,
  readBoundedClaudeFile,
  readClaudeSessionRecords,
  resolveClaudeSessionRecordsDirectory,
  type ClaudeSessionRecord,
} from "./claude-session-records.js";
import type { ManagedPermissionPrompt, PermissionDecision } from "./managed-permission.js";

/**
 * Permission requests from native Claude Code sessions: ones the operator
 * started themselves, in any terminal, tmux or as a background session.
 *
 * Claude Code runs a `PermissionRequest` hook while its permission dialog is
 * on screen. The hook (`scout permission-hook claude`) opens a request here
 * and waits on it in short polls. The operator answers it on the board, and
 * the hook hands the decision back to Claude Code. The dialog stays live in
 * the session the whole time: when it is answered there instead, Claude Code
 * records the session as no longer waiting, and the request closes.
 *
 * Nothing here types into a session. A request ends when its session stops
 * waiting, when its session ends, or when its hook stops polling.
 */

export type NativePermissionAsk = {
  harness: "claude";
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: unknown;
};

export type NativePermissionOpened =
  | { requestId: string }
  | { skipped: "no_live_session" | "scout_managed" };

export type NativePermissionOutcome =
  | { state: "open" }
  | { state: "decided"; decision: "allow" | "deny" }
  | { state: "ended"; reason: string };

export class NativePermissionAskError extends Error {}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; settled: boolean };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const box = { settled: false } as Deferred<T>;
  box.promise = new Promise<T>((done) => { resolve = done; });
  box.resolve = (value) => { if (!box.settled) { box.settled = true; resolve(value); } };
  return box;
}

type Live = {
  id: string;
  pid: number;
  procStart: string | null;
  sessionId: string;
  file: string;
  sawWaiting: boolean;
  decision: Deferred<PermissionDecision>;
  delivered: Deferred<void>;
  ended: Deferred<string>;
  lease: ReturnType<typeof setTimeout> | null;
};

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_TEXT = 2_000;
/** How long a hook may go between polls before its request is taken as abandoned. */
export const NATIVE_PERMISSION_LEASE_MS = 20_000;
/** The longest one poll is held open. */
export const NATIVE_PERMISSION_MAX_WAIT_MS = 10_000;
/** How long a decision waits for its hook to take it before it counts as undelivered. */
const DELIVERY_TIMEOUT_MS = 5_000;

export type NativePermissionDeps = {
  permissions: Pick<BrokerPermissionService, "raise" | "withdraw">;
  /** Claude Code's session registry (`~/.claude/sessions`). */
  directory?: string;
  readRecords?: () => Promise<ClaudeSessionRecord[]>;
  readRecord?: (file: string) => Promise<ClaudeSessionRecord | null>;
  /** Watches the registry directory; calls back with a changed file's name. Returns the unwatch function. */
  watch?: (directory: string, onChange: (file: string) => void) => () => void;
  /** Whether Scout launched this session itself; those already raise requests of their own. */
  launchedByScout?: (record: ClaudeSessionRecord) => Promise<boolean>;
  notify?: (input: { requestId: string; prompt: ManagedPermissionPrompt; actorId: string }) => void;
  leaseMs?: number;
  deliveryTimeoutMs?: number;
  now?: () => number;
};

export class NativePermissionRequests {
  private readonly live = new Map<string, Live>();
  private unwatch: (() => void) | null = null;
  private readonly directory: string;

  constructor(private readonly deps: NativePermissionDeps) {
    this.directory = deps.directory ?? resolveClaudeSessionRecordsDirectory();
  }

  /** The hook saw a permission dialog: open a request for it, unless Scout already handles the session. */
  async open(ask: NativePermissionAsk): Promise<NativePermissionOpened> {
    validateAsk(ask);
    const records = (await (this.deps.readRecords ?? (() => readClaudeSessionRecords({ directory: this.directory })))())
      .filter((record) => record.sessionId === ask.sessionId);
    const record = records.find((candidate) => candidate.status === "waiting")
      ?? records.sort((a, b) => (b.statusUpdatedAt ?? 0) - (a.statusUpdatedAt ?? 0))[0];
    if (!record) return { skipped: "no_live_session" };
    if (await (this.deps.launchedByScout ?? (async () => false))(record)) return { skipped: "scout_managed" };

    const now = (this.deps.now ?? Date.now)();
    const live: Live = {
      id: "", pid: record.pid, procStart: record.procStart, sessionId: ask.sessionId,
      file: basename(record.recordPath), sawWaiting: record.status === "waiting",
      decision: deferred(), delivered: deferred(), ended: deferred(), lease: null,
    };
    const prompt: ManagedPermissionPrompt = {
      sessionId: ask.sessionId,
      projectRoot: ask.cwd,
      text: describeNativePermission(ask),
      version: createHash("sha256").update(JSON.stringify([ask.sessionId, record.pid, ask.toolName, ask.toolInput ?? null, now])).digest("hex"),
      decisions: ["once", "deny"],
      isCurrent: async () => !live.ended.settled,
      answer: async (decision) => {
        if (live.ended.settled) throw new Error("The session no longer waits on this request.");
        live.decision.resolve(decision);
        const taken = await Promise.race([
          live.delivered.promise.then(() => true),
          live.ended.promise.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.deps.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS)),
        ]);
        if (!taken) throw new Error("The session's hook did not take the decision. Answer it in the session.");
      },
    };
    const actorId = `native:${ask.harness}:${ask.sessionId}`;
    live.id = await this.deps.permissions.raise({
      prompt, actorId,
      native: { harness: ask.harness, pid: record.pid, tool: ask.toolName, ...(record.jobId ? { jobId: record.jobId } : {}) },
    });
    this.live.set(live.id, live);
    this.renew(live);
    this.watchRegistry();
    this.deps.notify?.({ requestId: live.id, prompt, actorId });
    return { requestId: live.id };
  }

  /**
   * The hook's poll: the decision once there is one, the end once the session
   * stops waiting, otherwise open after `waitMs`. Each poll renews the lease.
   */
  async wait(requestId: string, waitMs: number): Promise<NativePermissionOutcome> {
    const live = this.live.get(requestId);
    if (!live) return { state: "ended", reason: "Nothing waits on this request." };
    this.renew(live);
    const ms = Math.max(0, Math.min(NATIVE_PERMISSION_MAX_WAIT_MS, Math.floor(waitMs)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      live.decision.promise,
      live.ended.promise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
    if (timer) clearTimeout(timer);
    // An end wins over a decision not yet taken: the session already moved on, so it is never delivered late.
    if (live.ended.settled) return { state: "ended", reason: await live.ended.promise };
    if (live.decision.settled) {
      const decision = await live.decision.promise;
      live.delivered.resolve();
      this.forget(live);
      return { state: "decided", decision: decision === "deny" ? "deny" : "allow" };
    }
    this.renew(live);
    return { state: "open" };
  }

  /** Open requests and their sessions, for diagnostics and tests. */
  pending(): Array<{ requestId: string; sessionId: string; pid: number }> {
    return [...this.live.values()].map((live) => ({ requestId: live.id, sessionId: live.sessionId, pid: live.pid }));
  }

  /** A registry file changed: end each request whose session stopped waiting or went away. */
  async registryChanged(file: string): Promise<void> {
    const watching = [...this.live.values()].filter((live) => live.file === file);
    if (watching.length === 0) return;
    const record = await (this.deps.readRecord ?? ((name: string) => readRegistryRecord(this.directory, name)))(file).catch(() => undefined);
    if (record === undefined) return;
    for (const live of watching) {
      if (!record || record.pid !== live.pid || record.sessionId !== live.sessionId || (live.procStart && record.procStart !== live.procStart)) {
        await this.end(live, "The session ended.");
      } else if (record.status === "waiting") {
        live.sawWaiting = true;
      } else if (live.sawWaiting) {
        await this.end(live, "Answered in the session.");
      }
    }
  }

  /** Stops watching and ends every open request, as the runtime shuts down. */
  async close(): Promise<void> {
    for (const live of [...this.live.values()]) await this.end(live, "The runtime stopped.");
    this.stopWatching();
  }

  private renew(live: Live): void {
    if (live.lease) clearTimeout(live.lease);
    live.lease = setTimeout(() => { void this.end(live, "The session stopped waiting."); }, this.deps.leaseMs ?? NATIVE_PERMISSION_LEASE_MS);
    live.lease.unref?.();
  }

  private async end(live: Live, reason: string): Promise<void> {
    if (live.ended.settled || live.delivered.settled) return;
    live.ended.resolve(reason);
    this.forget(live);
    await this.deps.permissions.withdraw(live.id, reason).catch(() => undefined);
  }

  private forget(live: Live): void {
    if (live.lease) clearTimeout(live.lease);
    live.lease = null;
    // A request the hook is still polling stays readable until its end is taken.
    setTimeout(() => {
      if (this.live.get(live.id) === live) this.live.delete(live.id);
      if (this.live.size === 0) this.stopWatching();
    }, 1_000).unref?.();
  }

  private watchRegistry(): void {
    if (this.unwatch) return;
    const start = this.deps.watch ?? watchDirectory;
    try {
      this.unwatch = start(this.directory, (file) => { void this.registryChanged(file); });
    } catch {
      // No watcher: requests still end by their lease, a decision, or the hook going away.
      this.unwatch = null;
    }
  }

  private stopWatching(): void {
    this.unwatch?.();
    this.unwatch = null;
  }
}

function watchDirectory(directory: string, onChange: (file: string) => void): () => void {
  const watcher = watch(directory, { persistent: false }, (_event, name) => {
    if (typeof name === "string" && /^\d+\.json$/u.test(name)) onChange(name);
  });
  return () => watcher.close();
}

/** Null when the file is gone or no longer a session record; it throws only on a failed read. */
async function readRegistryRecord(directory: string, file: string): Promise<ClaudeSessionRecord | null> {
  const path = join(directory, file);
  const raw = await readBoundedClaudeFile(path);
  return raw ? parseClaudeSessionRecord(raw, path) : null;
}

function validateAsk(ask: NativePermissionAsk): void {
  if (ask?.harness !== "claude") throw new NativePermissionAskError("harness must be claude");
  if (typeof ask.sessionId !== "string" || !SESSION_ID.test(ask.sessionId)) throw new NativePermissionAskError("sessionId is required");
  if (typeof ask.cwd !== "string" || !ask.cwd.startsWith("/") || ask.cwd.length > 4096) throw new NativePermissionAskError("cwd must be an absolute path");
  if (typeof ask.toolName !== "string" || !ask.toolName.trim() || ask.toolName.length > 200) throw new NativePermissionAskError("toolName is required");
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function field(input: unknown, key: string): string | null {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** What the board shows: what the session wants to do, as Claude Code's dialog says it. */
export function describeNativePermission(ask: Pick<NativePermissionAsk, "toolName" | "toolInput">): string {
  const input = ask.toolInput;
  const lines: string[] = [];
  switch (ask.toolName) {
    case "Bash": {
      lines.push("Run a command:", field(input, "command") ?? "(no command)");
      const description = field(input, "description");
      if (description) lines.push("", description);
      break;
    }
    case "Edit":
    case "MultiEdit":
      lines.push(`Edit ${field(input, "file_path") ?? "a file"}`);
      break;
    case "Write":
      lines.push(`Write ${field(input, "file_path") ?? "a file"}`);
      break;
    case "NotebookEdit":
      lines.push(`Edit ${field(input, "notebook_path") ?? "a notebook"}`);
      break;
    case "WebFetch":
      lines.push(`Fetch ${field(input, "url") ?? "a page"}`);
      break;
    case "WebSearch":
      lines.push(`Search the web for ${field(input, "query") ?? "something"}`);
      break;
    default: {
      lines.push(`Use ${ask.toolName}`);
      let json = "";
      try { json = JSON.stringify(input ?? {}); } catch { json = ""; }
      if (json && json !== "{}") lines.push(clip(json, 600));
    }
  }
  return clip(lines.join("\n"), MAX_TEXT);
}
