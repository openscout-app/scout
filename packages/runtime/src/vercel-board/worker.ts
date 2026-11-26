import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VercelBoardCredentialReference, VercelBoardPlanTask } from "@openscout/protocol";
import { VercelBoardHttpError, VercelBoardUnknownOutcomeError, parseVercelBoardChannelRef, type VercelBoardBlockKind, type VercelBoardBoardRef, type VercelBoardChannelRef, type VercelBoardClaimGrant, type VercelBoardMe, type VercelBoardTransport } from "./client.js";
import { boardResultExcerpt, parseVercelBoardEvent, parseVercelBoardMessage, parseVercelBoardMessagesPage, parseVercelBoardTaskSummary, type VercelBoardWireMessage } from "./wire.js";

/**
 * The Vercel transport: a supervised Node worker that runs `@vercel/board`.
 *
 * The runtime keeps everything with state: claim tokens (custody), the renew
 * timer, the cursors (compare-and-set) and the outbox. The worker carries one
 * typed call at a time from a closed set and keeps none of it. The runtime
 * starts it under `secret run --map <entry>=VERCEL_BOARD_TOKEN`, so the token goes
 * from the secret helper into the worker's environment and never through the
 * runtime.
 */

export type VercelBoardWorkerTarget = { kind: "vercel"; team: string; board: string } | { kind: "memory" };

export class VercelBoardWorkerError extends Error {
  constructor(readonly code: "worker_unavailable" | "node_unavailable", message: string, readonly fix?: string) {
    super(message);
    this.name = "VercelBoardWorkerError";
  }
}

export interface VercelBoardWorkerOptions {
  /** The Node executable. Default: SCOUT_VERCEL_BOARD_NODE, then `node` on PATH. */
  node?: string;
  /** The worker script. Default: the worker shipped with the runtime. */
  script?: string;
  /** The secret helper. Default: `secret` on PATH. */
  secretExecutable?: string;
  startTimeoutMs?: number;
  /** First wait after the worker exits; it doubles to five minutes. */
  restartBackoffMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** `@vercel/board` 0.52.0 needs Node 22.18 or newer. Run it on Node 24. */
export const VERCEL_BOARD_WORKER_MIN_NODE: readonly [number, number] = [22, 18];
const WORKER_PROTOCOL = 1;
const SECRET_ENV = ["VERCEL_BOARD_TOKEN", "BOARD_TOKEN", "BOARD_URL", "VERCEL_OIDC_TOKEN", "VERCEL_AUTH_TOKEN", "VERCEL_TOKEN", "NODE_OPTIONS"];
const MAX_LINE = 32 * 1024 * 1024;
const READ_TIMEOUT_MS = 30_000;
// `@vercel/board` retries a write on 429 and 503 with backoff, which can take
// about 25 seconds. A write that runs past this reads as outcome unknown.
const WRITE_TIMEOUT_MS = 45_000;
const WRITES = new Set(["ensureChannel", "post", "createTask", "createBatch", "claim", "renew", "complete", "fail", "release", "labels"]);

/** Resolve only the worker shipped with this runtime, never a command from a caller. */
export function resolveVercelBoardWorkerScript(): string {
  const bundled = fileURLToPath(new URL("./vercel-board-worker.mjs", import.meta.url));
  if (existsSync(bundled)) return bundled;
  const script = fileURLToPath(new URL("../../../vercel-board-worker/src/worker.mjs", import.meta.url));
  if (!existsSync(script)) {
    throw new VercelBoardWorkerError("worker_unavailable", "The Board worker is missing from this runtime.", "Reinstall Scout or rebuild the CLI from a checkout");
  }
  return script;
}

function childEnv(base: NodeJS.ProcessEnv, token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of SECRET_ENV) delete env[name];
  if (token !== undefined) env.VERCEL_BOARD_TOKEN = token;
  return env;
}

const versions = new Map<string, Promise<string>>();
/** `node --version`, bounded. Cached per executable. */
function nodeVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  let known = versions.get(executable);
  if (!known) {
    known = new Promise<string>((resolve, reject) => {
      const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "ignore"], env: childEnv(env) });
      let output = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, 5_000);
      child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 64) child.kill("SIGKILL"); });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(new Error(`exit ${code}`)); });
    });
    known.catch(() => versions.delete(executable));
    versions.set(executable, known);
  }
  return known;
}

export async function checkVercelBoardWorkerNode(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fix = "Install Node 24 and point the broker at it: SCOUT_VERCEL_BOARD_NODE=<path to node 24>";
  let version: string;
  try { version = await nodeVersion(executable, env); }
  catch { throw new VercelBoardWorkerError("node_unavailable", `The Board worker needs Node, and ${executable} did not run.`, fix); }
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  const [needMajor, needMinor] = VERCEL_BOARD_WORKER_MIN_NODE;
  if (!Number.isFinite(major) || major! < needMajor || (major === needMajor && minor! < needMinor)) {
    throw new VercelBoardWorkerError("node_unavailable", `The Board worker needs Node ${needMajor}.${needMinor} or newer; ${executable} is ${version}.`, fix);
  }
  return version;
}

/** The command that starts the worker. A `secret_cli` credential goes through `secret run`; the runtime never holds that token. */
export function vercelBoardWorkerCommand(credential: VercelBoardCredentialReference | null, node: string, script: string, secretExecutable = "secret"): { executable: string; args: string[] } {
  if (credential?.backend === "secret_cli") {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(credential.key)) throw new VercelBoardWorkerError("worker_unavailable", "The credential reference must name a secret entry, never hold a token.");
    return { executable: secretExecutable, args: ["run", "--map", `${credential.key}=VERCEL_BOARD_TOKEN`, "--", node, script] };
  }
  return { executable: node, args: [script] };
}

type WorkerError =
  | { kind: "http"; status: number; code: string; message: string; hint?: string; retryAfterMs?: number }
  | { kind: "unknown"; code: string }
  | { kind: "aborted" }
  | { kind: "protocol"; code: string; message: string };

interface Pending { op: string; resolve(value: any): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
interface Running { child: ChildProcess; generation: number; pending: Map<number, Pending>; ready: Promise<void>; fatal?: string }

export interface VercelBoardWorkerInput {
  target: VercelBoardWorkerTarget;
  profile: string;
  /** Every profile a call may name: the connection's role list. `profile` is always one of them. */
  profiles?: string[];
  /** The `x-board-can` text. The worker applies it to every call. */
  can: string;
  /** Null only for the in-memory test board. */
  credential: VercelBoardCredentialReference | null;
  /** Reads an `env` or `file` credential, which the runtime then hands to the worker's environment. */
  readToken?: () => Promise<string>;
}

/**
 * One worker per connection. It starts on the first call, restarts with
 * backoff when it exits, and is killed with its process group on stop. Each
 * start is a new generation: the worker answers only calls of its own, and
 * answers from an older process are dropped.
 */
export class VercelBoardWorkerSupervisor {
  private running?: Running;
  private starting?: Promise<Running>;
  private generation = 0;
  private nextId = 1;
  private restartAt = 0;
  private backoffMs: number;
  private lastFailure?: string;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly input: VercelBoardWorkerInput, private readonly options: VercelBoardWorkerOptions & { now?: () => number } = {}) {
    this.backoffMs = options.restartBackoffMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  status(): { running: boolean; generation: number; lastFailure?: string; restartAt?: number } {
    return {
      running: Boolean(this.running), generation: this.generation,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}), ...(this.restartAt > this.now() ? { restartAt: this.restartAt } : {}),
    };
  }

  /** Start now, and say why not. Connect uses it to fail with the reason instead of at the first read. */
  async start(): Promise<void> {
    await this.ensure();
  }

  stop(): void {
    this.stopped = true;
    const running = this.running;
    this.running = undefined;
    if (running) this.end(running, "The Board worker was stopped.");
  }

  private terminate(child: ChildProcess): void {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
  }

  /** Fail every call still out. A write that was sent may have landed. */
  private end(running: Running, reason: string): void {
    this.terminate(running.child);
    for (const [id, pending] of running.pending) {
      running.pending.delete(id);
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(WRITES.has(pending.op) ? new VercelBoardUnknownOutcomeError(pending.op, new Error("worker_exited")) : new VercelBoardHttpError(502, "worker_exited", reason));
    }
  }

  private async ensure(): Promise<Running> {
    if (this.stopped) throw new VercelBoardHttpError(503, "worker_stopped", "The Board worker is stopped.");
    if (this.running) return this.running;
    if (this.starting) return this.starting;
    const wait = this.restartAt - this.now();
    if (wait > 0) {
      throw new VercelBoardHttpError(503, "worker_unavailable", `The Board worker is restarting after: ${this.lastFailure ?? "an exit"}. Next start in ${Math.ceil(wait / 1000)}s.`);
    }
    this.starting = this.spawn().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private failed(reason: string): void {
    this.lastFailure = reason.slice(0, 500);
    this.restartAt = this.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 300_000);
  }

  private async spawn(): Promise<Running> {
    const env = this.options.env ?? process.env;
    const node = this.options.node ?? env.SCOUT_VERCEL_BOARD_NODE ?? "node";
    let command: { executable: string; args: string[] };
    let token: string | undefined;
    try {
      const script = this.options.script ?? resolveVercelBoardWorkerScript();
      await checkVercelBoardWorkerNode(node, env);
      command = vercelBoardWorkerCommand(this.input.credential, node, script, this.options.secretExecutable);
      if (this.input.credential && this.input.credential.backend !== "secret_cli") {
        if (!this.input.readToken) throw new VercelBoardWorkerError("worker_unavailable", "No reader for the connection's credential.");
        token = await this.input.readToken();
      }
    } catch (error) {
      this.failed(error instanceof Error ? error.message : "The Board worker did not start.");
      throw error;
    }
    const generation = ++this.generation;
    const child = spawn(command.executable, command.args, {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      env: childEnv(env, token),
    });
    const pending = new Map<number, Pending>();
    let settleReady!: { resolve(): void; reject(error: unknown): void };
    const ready = new Promise<void>((resolve, reject) => { settleReady = { resolve, reject }; });
    const running: Running = { child, generation, pending, ready };
    const startTimer = setTimeout(() => {
      settleReady.reject(new VercelBoardHttpError(503, "worker_unavailable", "The Board worker did not start in time."));
      this.terminate(child);
    }, this.options.startTimeoutMs ?? 60_000);

    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) { running.fatal = "The Board worker sent an oversized line."; this.terminate(child); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { running.fatal = "The Board worker sent a line that is not JSON."; this.terminate(child); return; }
        if (message.ready === true) {
          if (message.generation !== generation || message.protocol !== WORKER_PROTOCOL) { running.fatal = "The Board worker answered another generation or protocol."; this.terminate(child); return; }
          clearTimeout(startTimer);
          settleReady.resolve();
          continue;
        }
        if (typeof message.fatal === "string") { running.fatal = message.fatal.slice(0, 500); continue; }
        const call = pending.get(message.id);
        if (!call) continue; // a call that timed out or was cancelled
        pending.delete(message.id);
        clearTimeout(call.timer);
        call.cleanup();
        if (message.ok === true) call.resolve(message.value);
        else call.reject(this.errorOf(call.op, message.error as WorkerError));
      }
    });
    child.stdin!.on("error", () => this.terminate(child));
    child.on("error", error => { running.fatal ??= `The Board worker did not run: ${error.message}`; this.terminate(child); });
    child.once("close", code => {
      clearTimeout(startTimer);
      const reason = running.fatal ?? `The Board worker exited (${code ?? "signal"}).`;
      settleReady.reject(new VercelBoardHttpError(503, "worker_unavailable", reason));
      if (this.running === running) this.running = undefined;
      this.end(running, reason);
      if (!this.stopped) this.failed(reason);
    });
    child.stdin!.write(`${JSON.stringify({ protocol: WORKER_PROTOCOL, generation, profile: this.input.profile, profiles: [...new Set([this.input.profile, ...(this.input.profiles ?? [])])], can: this.input.can, target: this.input.target })}\n`);

    await ready;
    if (this.stopped) { this.end(running, "The Board worker was stopped."); throw new VercelBoardHttpError(503, "worker_stopped", "The Board worker is stopped."); }
    this.running = running;
    this.backoffMs = this.options.restartBackoffMs ?? 10_000;
    this.lastFailure = undefined;
    return running;
  }

  private errorOf(op: string, error: WorkerError | undefined): Error {
    if (!error || typeof error !== "object") return new VercelBoardHttpError(502, "worker_protocol", "The Board worker answered no error.");
    if (error.kind === "unknown") return new VercelBoardUnknownOutcomeError(op, new Error(String(error.code).slice(0, 64)));
    if (error.kind === "aborted") return new DOMException("The call was cancelled.", "AbortError");
    if (error.kind === "protocol") return new VercelBoardHttpError(502, String(error.code).slice(0, 64), String(error.message).slice(0, 500));
    const code = typeof error.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "remote_error";
    return new VercelBoardHttpError(Number.isInteger(error.status) ? error.status : 502, code, String(error.message ?? "").slice(0, 500), typeof error.retryAfterMs === "number" ? error.retryAfterMs : undefined, typeof error.hint === "string" ? error.hint.slice(0, 500) : undefined);
  }

  /**
   * One call. A call that never reached the worker is a refusal: nothing was
   * sent. A write the worker took and did not answer is outcome unknown, and
   * is never sent again from here.
   */
  async call<T = any>(op: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number; as?: string | null } = {}): Promise<T> {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("The call was cancelled.", "AbortError");
    const running = await this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!running.pending.delete(id)) return;
        clearTimeout(timer);
        try { running.child.stdin!.write(`${JSON.stringify({ cancel: id })}\n`); } catch { /* the worker is gone */ }
        reject(WRITES.has(op) ? new VercelBoardUnknownOutcomeError(op, new Error("cancelled")) : options.signal!.reason ?? new DOMException("The call was cancelled.", "AbortError"));
      };
      const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        if (!running.pending.delete(id)) return;
        cleanup();
        try { running.child.stdin!.write(`${JSON.stringify({ cancel: id })}\n`); } catch { /* the worker is gone */ }
        reject(WRITES.has(op) ? new VercelBoardUnknownOutcomeError(op, new Error("timeout")) : new VercelBoardHttpError(502, "unreachable", "The board did not answer in time."));
      }, options.timeoutMs ?? (WRITES.has(op) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS));
      running.pending.set(id, { op, resolve, reject, timer, cleanup });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        running.child.stdin!.write(`${JSON.stringify({ id, gen: running.generation, op, args, ...(options.as !== undefined ? { as: options.as } : {}) })}\n`);
      } catch {
        running.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        reject(new VercelBoardHttpError(503, "worker_unavailable", "The Board worker is not running."));
      }
    });
  }
}

const invalid = (what: string) => new VercelBoardHttpError(502, "worker_protocol", `The Board worker answered no ${what}.`);
const record = (value: unknown, what: string): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(what);
  return value as Record<string, any>;
};
const time = (value: unknown, what: string): number => {
  const at = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(at)) throw invalid(what);
  return at;
};

/** `VercelBoardTransport` over the worker. Answers are checked here as they would be from HTTP. */
export class VercelBoardWorkerTransport implements VercelBoardTransport {
  /** `profile` undefined writes as the worker's bootstrap profile; null as the principal. */
  constructor(readonly worker: VercelBoardWorkerSupervisor, private readonly profile?: string | null) {}

  private call<T = any>(op: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    return this.worker.call<T>(op, args, { ...options, ...(this.profile !== undefined ? { as: this.profile } : {}) });
  }

  as(profile: string | null): VercelBoardTransport {
    return new VercelBoardWorkerTransport(this.worker, profile);
  }

  async me(signal?: AbortSignal): Promise<VercelBoardMe> {
    const me = record(await this.call("me", {}, { signal }), "identity");
    if (typeof me.principal !== "string" || typeof me.actor !== "string") throw invalid("principal");
    const expires = me.expiresAt === null || me.expiresAt === undefined ? null : time(me.expiresAt, "expiry");
    return { actor: me.actor, principal: me.principal, profile: typeof me.profile === "string" ? me.profile : null, expiresAt: expires };
  }

  async ensureChannel(channel: string): Promise<void> {
    await this.call("ensureChannel", { channel });
  }

  async events(query: { channel: string; after?: string; wait?: number; signal?: AbortSignal }) {
    const wait = query.wait === undefined ? undefined : Math.max(0, Math.min(Math.floor(query.wait), 300));
    const answer = record(await this.call("events", { channel: query.channel, ...(query.after ? { after: query.after } : {}), ...(wait !== undefined ? { wait } : {}) }, {
      signal: query.signal, timeoutMs: (wait ?? 0) * 1000 + READ_TIMEOUT_MS,
    }), "event page");
    if (!Array.isArray(answer.events) || answer.events.length > 1000) throw invalid("event list");
    if (typeof answer.cursor !== "string" && typeof answer.cursor !== "number") throw invalid("cursor");
    return { events: answer.events.map(parseVercelBoardEvent), cursor: String(answer.cursor) };
  }

  async tasks(query: { channel: string; state?: string; after?: string; limit?: number }) {
    const answer = record(await this.call("tasks", { ...query }), "task page");
    if (!Array.isArray(answer.tasks)) throw invalid("task list");
    return { tasks: answer.tasks.map(parseVercelBoardTaskSummary), cursor: answer.cursor === null || answer.cursor === undefined ? null : String(answer.cursor) };
  }

  async channelMessages(query: { channel: string; after?: string; limit?: number }) {
    const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 500), 500));
    const answer = record(await this.call("messages", { channel: query.channel, ...(query.after ? { after: query.after } : {}), limit }), "messages page");
    try { return parseVercelBoardMessagesPage(answer); } catch { throw invalid("message list"); }
  }

  async message(id: string): Promise<VercelBoardWireMessage | null> {
    const answer = record(await this.call("message", { id }), "message");
    return answer.message ? parseVercelBoardMessage(answer.message) : null;
  }

  async post(input: { channel?: string; re?: string; text: string; labels?: Record<string, string>; id: string; noSync?: boolean }) {
    return parseVercelBoardMessage(record(await this.call("post", { ...input }), "post").message);
  }

  async postById(id: string): Promise<VercelBoardWireMessage | null> {
    const answer = record(await this.call("postById", { id }), "post");
    return answer.message ? parseVercelBoardMessage(answer.message) : null;
  }

  async createTask(input: { channel: string; text: string; labels?: Record<string, string>; id: string; needs?: string[]; noSync?: boolean }) {
    return parseVercelBoardMessage(record(await this.call("createTask", { ...input }), "task").task);
  }

  async createBatch(input: { channel: string; tasks: VercelBoardPlanTask[]; id: string; noSync?: boolean }) {
    const answer = record(await this.call("createBatch", { ...input }), "batch");
    if (!Array.isArray(answer.tasks)) throw invalid("tasks");
    return answer.tasks.map(parseVercelBoardMessage);
  }

  async batch(id: string): Promise<VercelBoardWireMessage[] | null> {
    const answer = record(await this.call("batch", { id }), "batch");
    return Array.isArray(answer.tasks) ? answer.tasks.map(parseVercelBoardMessage) : null;
  }

  async claim(taskId: string, leaseSeconds: number): Promise<{ task: VercelBoardWireMessage; claim: VercelBoardClaimGrant }> {
    const answer = record(await this.call("claim", { taskId, lease: leaseSeconds }), "claim");
    const claim = record(answer.claim, "claim");
    if (!Number.isSafeInteger(claim.epoch) || typeof claim.token !== "string" || !claim.token) throw invalid("claim");
    return { task: parseVercelBoardMessage(answer.task), claim: { epoch: claim.epoch, token: claim.token, until: time(claim.until, "claim expiry") } };
  }

  async renew(taskId: string, grant: { epoch: number; token: string }, leaseSeconds: number) {
    const answer = record(await this.call("renew", { taskId, epoch: grant.epoch, token: grant.token, lease: leaseSeconds }), "renewal");
    return { task: parseVercelBoardMessage(answer.task), until: time(answer.until, "renewal expiry") };
  }

  async complete(taskId: string, grant: { epoch: number; token: string }, result?: string) {
    return parseVercelBoardMessage(record(await this.call("complete", { taskId, epoch: grant.epoch, token: grant.token, ...(result !== undefined ? { result: boardResultExcerpt(result) } : {}) }), "task").task);
  }

  async fail(taskId: string, grant: { epoch: number; token: string }, reason: string) {
    return parseVercelBoardMessage(record(await this.call("fail", { taskId, epoch: grant.epoch, token: grant.token, reason: boardResultExcerpt(reason) }), "task").task);
  }

  async release(taskId: string, grant: { epoch: number; token: string }) {
    return parseVercelBoardMessage(record(await this.call("release", { taskId, epoch: grant.epoch, token: grant.token }), "task").task);
  }

  async block(taskId: string, grant: { epoch: number; token: string }, reason: string, kind: VercelBoardBlockKind) {
    return parseVercelBoardMessage(record(await this.call("block", { taskId, epoch: grant.epoch, token: grant.token, reason: boardResultExcerpt(reason), kind }), "task").task);
  }

  async unblock(taskId: string) {
    return parseVercelBoardMessage(record(await this.call("unblock", { taskId }), "task").task);
  }

  async labels(messageId: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }) {
    await this.call("labels", { id: messageId, change });
  }

  async boards(signal?: AbortSignal): Promise<VercelBoardBoardRef[]> {
    const answer = record(await this.call("boards", {}, { signal }), "board list");
    if (!Array.isArray(answer.boards) || answer.boards.length > 1000) throw invalid("board list");
    return answer.boards.flatMap((value: unknown): VercelBoardBoardRef[] => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name) return [];
      return [{ id: row.id, name: row.name.slice(0, 64), isDefault: row.isDefault === true, connected: row.connected === true }];
    });
  }

  async channels(query: { board: string; prefix?: string; after?: string; limit?: number }) {
    const answer = record(await this.call("channels", { board: query.board, ...(query.prefix ? { prefix: query.prefix } : {}), ...(query.after ? { after: query.after } : {}), ...(query.limit ? { limit: query.limit } : {}) }), "channel list");
    if (!Array.isArray(answer.channels)) throw invalid("channel list");
    const channels = answer.channels.map(parseVercelBoardChannelRef).filter((row: VercelBoardChannelRef | null): row is VercelBoardChannelRef => row !== null);
    return { channels, next: typeof answer.next === "string" && answer.next ? answer.next : null };
  }

  async boardMessages(query: { board: string; channel: string; limit?: number }) {
    const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 500), 500));
    const answer = record(await this.call("boardMessages", { board: query.board, channel: query.channel, limit }), "messages page");
    try { return parseVercelBoardMessagesPage(answer); } catch { throw invalid("message list"); }
  }
}
