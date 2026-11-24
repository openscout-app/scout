import { randomUUID } from "node:crypto";
import {
  SCOUT_ROUTINE_LIMITS,
  type DurableAction,
  type DurableAttempt,
  type DurableCheckbackMetadata,
  type ScoutPostLink,
  type ScoutRoutineRun,
} from "@openscout/protocol";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { runSandboxedFunction, type SandboxFunction, type SandboxRun } from "./task-callback-sandbox.js";

/**
 * Routines: checkback durable actions in `routine` mode. Each one holds a
 * JavaScript module and a due time. When it comes due the runtime runs the
 * module in the callback sandbox, with `scout.post` as its one way to act, and
 * then moves the due time on by the recurrence or ends the routine.
 *
 * One timer, armed for the earliest due time; nothing polls. A firing first
 * records a lease, so a runtime that stops mid-run fires that routine again
 * once the lease runs out (at least once, never in parallel). A runtime that
 * was down across several due times fires once and skips to the next slot.
 */
const LEASE_MS = 60_000;
/** setTimeout's ceiling; a later due time re-arms when this one fires. */
const MAX_TIMER_MS = 2_147_483_647;

export class RoutineError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export type RoutinePostInput = { routine: DurableAction; text: string; links?: ScoutPostLink[] };

export interface RoutineRunnerDeps {
  nodeId: string;
  listActions(): Iterable<DurableAction>;
  getAction(actionId: string): DurableAction | null;
  runDurableWrite: <T>(work: () => Promise<T>) => Promise<T>;
  commitEntries: (
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
  ) => Promise<unknown>;
  post(input: RoutinePostInput): Promise<{ id: string }>;
  /** Read-only facts about the runtime, passed to the module as `data.runtime`. */
  facts?(): Record<string, unknown>;
  runCode?: (input: { code: string; data: Record<string, unknown>; scout: Record<string, SandboxFunction> }) => Promise<SandboxRun>;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export type RoutineCreateInput = {
  title: string;
  code: string;
  /** First due time; defaults to now. */
  dueAt?: number;
  everyMs?: number;
  ownerId?: string;
  currentDirectory?: string;
};

function metadataOf(action: DurableAction): DurableCheckbackMetadata {
  return (action.metadata ?? {}) as DurableCheckbackMetadata;
}

export function isRoutine(action: DurableAction | null | undefined): action is DurableAction {
  return Boolean(action && action.kind === "checkback" && metadataOf(action).mode === "routine");
}

export function routineEveryMs(action: DurableAction): number | undefined {
  const recurrence = metadataOf(action).recurrence as { everyMs?: unknown } | undefined;
  const everyMs = recurrence && typeof recurrence === "object" ? recurrence.everyMs : undefined;
  return typeof everyMs === "number" && Number.isFinite(everyMs) && everyMs >= SCOUT_ROUTINE_LIMITS.minEveryMs ? everyMs : undefined;
}

const LIVE = new Set<DurableAction["state"]>(["pending", "waiting", "leased", "running"]);

/** When this routine next needs the runner: its due time, or its lease end while it runs. */
function wakeAt(action: DurableAction): number | undefined {
  if (!LIVE.has(action.state)) return undefined;
  if (action.state === "leased" || action.state === "running") return action.leaseExpiresAt ?? 0;
  const dueAt = metadataOf(action).dueAt;
  return typeof dueAt === "number" && Number.isFinite(dueAt) ? dueAt : undefined;
}

/** The first slot on the `dueAt + k * everyMs` grid that is after `now`. */
export function nextDueAt(dueAt: number, everyMs: number, now: number): number {
  if (dueAt > now) return dueAt;
  return dueAt + (Math.floor((now - dueAt) / everyMs) + 1) * everyMs;
}

export class RoutineRunner {
  private timer: unknown;
  private stopped = true;
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly owner: string;

  constructor(private readonly deps: RoutineRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((run, ms) => {
      const handle = setTimeout(run, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.owner = `routines@${deps.nodeId}`;
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  list(): DurableAction[] {
    return [...this.deps.listActions()].filter(isRoutine).sort((a, b) => a.createdAt - b.createdAt);
  }

  async create(input: RoutineCreateInput): Promise<DurableAction> {
    const title = input.title?.trim();
    if (!title || title.length > 120) throw new RoutineError("routine_title_required");
    const code = input.code;
    if (typeof code !== "string" || !code.trim() || code.length > SCOUT_ROUTINE_LIMITS.codeCharacters) throw new RoutineError("routine_code_invalid");
    if (input.everyMs !== undefined && (!Number.isSafeInteger(input.everyMs) || input.everyMs < SCOUT_ROUTINE_LIMITS.minEveryMs)) {
      throw new RoutineError("routine_every_too_short");
    }
    const now = this.now();
    const dueAt = input.dueAt ?? now;
    if (!Number.isSafeInteger(dueAt)) throw new RoutineError("routine_due_invalid");
    const id = `routine-${randomUUID()}`;
    const action = await this.deps.runDurableWrite(async () => {
      const live = this.list().filter(routine => LIVE.has(routine.state)).length;
      if (live >= SCOUT_ROUTINE_LIMITS.maxRoutines) throw new RoutineError("routine_limit_reached", 409);
      const metadata: DurableCheckbackMetadata = {
        dueAt, mode: "routine", title, code, runs: 0,
        ...(input.everyMs ? { recurrence: { everyMs: input.everyMs } } : {}),
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        ...(input.currentDirectory ? { currentDirectory: input.currentDirectory } : {}),
      };
      const created: DurableAction = {
        id, kind: "checkback", subjectId: id, authorityCellId: this.deps.nodeId, state: "pending",
        leaseGeneration: 0, createdAt: now, updatedAt: now, metadata,
      };
      await this.deps.commitEntries({ kind: "durable.action.record", action: created }, async () => {});
      return created;
    });
    this.arm();
    return action;
  }

  async cancel(actionId: string): Promise<DurableAction> {
    const action = await this.deps.runDurableWrite(async () => {
      const current = this.deps.getAction(actionId);
      if (!isRoutine(current)) throw new RoutineError("routine_not_found", 404);
      if (!LIVE.has(current.state)) return current;
      const next: DurableAction = { ...current, state: "cancelled", leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: this.now() };
      await this.deps.commitEntries({ kind: "durable.action.record", action: next }, async () => {});
      return next;
    });
    this.arm();
    return action;
  }

  /** Arm the one timer for the earliest wake time. Cheap; call after any routine write. */
  arm(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    let earliest: number | undefined;
    for (const routine of this.list()) {
      if (this.inFlight.has(routine.id)) continue;
      const at = wakeAt(routine);
      if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at;
    }
    if (earliest === undefined) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, earliest - this.now()));
    this.timer = this.setTimer(() => { this.timer = undefined; void this.fireDue(); }, delay);
  }

  /** Fire every routine that is due now. Resolves when they have all finished. */
  async fireDue(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const due = this.list().filter(routine => !this.inFlight.has(routine.id) && (wakeAt(routine) ?? Infinity) <= now);
    const runs = due.map(routine => this.fire(routine.id));
    this.arm();
    await Promise.all(runs);
  }

  private async fire(actionId: string): Promise<void> {
    this.inFlight.add(actionId);
    try {
      const firedAt = this.now();
      const leased = await this.deps.runDurableWrite(async () => {
        const current = this.deps.getAction(actionId);
        if (!isRoutine(current) || (wakeAt(current) ?? Infinity) > firedAt) return null;
        const next: DurableAction = {
          ...current, state: "running", leaseOwner: this.owner,
          leaseGeneration: current.leaseGeneration + 1, leaseExpiresAt: firedAt + LEASE_MS, updatedAt: firedAt,
        };
        await this.deps.commitEntries({ kind: "durable.action.record", action: next }, async () => {});
        return next;
      });
      if (!leased) return;
      const metadata = metadataOf(leased);
      const run = Number(metadata.runs ?? 0) + 1;
      const posts: string[] = [];
      const post: SandboxFunction = async (arg) => {
        const input = (typeof arg === "string" ? { text: arg } : arg) as { text?: unknown; links?: unknown } | null;
        if (!input || typeof input.text !== "string") throw new Error("scout.post takes a string or { text, links }");
        if (posts.length >= SCOUT_ROUTINE_LIMITS.postsPerRun) throw new Error(`a routine posts at most ${SCOUT_ROUTINE_LIMITS.postsPerRun} times per run`);
        const links = Array.isArray(input.links) ? input.links as ScoutPostLink[] : undefined;
        const created = await this.deps.post({ routine: leased, text: input.text, links });
        posts.push(created.id);
        return { id: created.id };
      };
      const lastFired = metadata.lastRun as ScoutRoutineRun | undefined;
      const runCode = this.deps.runCode ?? runSandboxedFunction;
      const result = await runCode({
        code: String(metadata.code ?? ""),
        data: {
          routine: {
            id: leased.id, title: metadata.title ?? "", run, firedAt, dueAt: metadata.dueAt,
            ...(lastFired ? { lastFiredAt: lastFired.at } : {}),
            ...(routineEveryMs(leased) ? { everyMs: routineEveryMs(leased) } : {}),
          },
          runtime: this.deps.facts?.() ?? {},
        },
        scout: { post },
      }).catch((error: unknown): SandboxRun => ({ ok: false, error: error instanceof Error ? error.message : String(error), logs: [] }));
      const completedAt = this.now();
      const lastRun: ScoutRoutineRun = {
        at: firedAt, ok: result.ok, posts,
        ...(result.ok ? {} : { error: result.error }),
        ...(result.logs.length ? { logs: result.logs.slice(0, 5) } : {}),
      };
      await this.deps.runDurableWrite(async () => {
        const current = this.deps.getAction(actionId);
        // Cancelled, or taken over after the lease ran out: this run's outcome is not the routine's.
        if (!current || current.leaseOwner !== this.owner || current.leaseGeneration !== leased.leaseGeneration) return;
        const everyMs = routineEveryMs(current);
        const currentMetadata = metadataOf(current);
        const next: DurableAction = {
          ...current,
          state: everyMs ? "pending" : result.ok ? "completed" : "failed",
          leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: completedAt,
          metadata: {
            ...currentMetadata, runs: run, lastRun,
            dueAt: everyMs ? nextDueAt(currentMetadata.dueAt, everyMs, completedAt) : currentMetadata.dueAt,
          },
        };
        const attempt: DurableAttempt = {
          id: `${actionId}:run:${run}`, actionId, attempt: run, state: result.ok ? "completed" : "failed",
          leaseGeneration: leased.leaseGeneration, startedAt: firedAt, completedAt,
          ...(result.ok ? {} : { error: result.error }),
          metadata: { posts, ...(result.logs.length ? { logs: result.logs.slice(0, 5) } : {}) },
        };
        await this.deps.commitEntries([
          { kind: "durable.attempt.record", attempt },
          { kind: "durable.action.record", action: next },
        ], async () => {});
      });
      this.deps.log?.(`[openscout-runtime] routine ${actionId} (${metadata.title ?? ""}) run ${run} ${result.ok ? "ran" : `failed: ${result.error}`}; posts ${posts.join(", ") || "none"}`);
    } catch (error) {
      this.deps.log?.(`[openscout-runtime] routine ${actionId} did not run: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.inFlight.delete(actionId);
      this.arm();
    }
  }
}
