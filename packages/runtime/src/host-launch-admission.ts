// Worker starts share one budget across brokers belonging to this macOS user.
// Durable work stays in each broker's journal. This file stores only host timing.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { nativeDarwinProcessSource } from "./supervision-handoff/darwin-process-source.js";
import { execSystemFile } from "./system-probes/exec.js";
import { openRuntimeSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { isTestRunnerProcess } from "./support-paths.js";

export type HostPressure = "normal" | "warning" | "critical";
type Budget = { nextStart: number; recovering: number; normalSince: number | null; sampledAt: number };
type Ticket = {
  needed: () => boolean;
  onWait: (reason: string) => Promise<void>;
  parked?: Promise<void>;
  finish: (admitted: boolean) => void;
  fail: (error: unknown) => void;
};
export class HostLaunchDeferred extends Error {
  readonly code = "host_launch_deferred";
  readonly retryable = true;
  constructor(readonly reason: string, readonly retryAt: number) {
    super(`Local worker start deferred until the next check: ${reason}.`);
  }
}

const SAMPLE_MS = 1_000;
const NORMAL_START_MS = 2_000;
const CAUTIOUS_START_MS = 10_000;
const RECOVERY_MS = 30_000;

export async function readMacHostPressure(): Promise<HostPressure> {
  let level: number;
  if (typeof Bun !== "undefined") {
    level = nativeDarwinProcessSource().memoryPressureLevel();
  } else {
    const result = await execSystemFile("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
      timeoutMs: 1_000, maxStdoutBytes: 32, maxStderrBytes: 256,
    });
    level = Number(result.stdout.trim());
  }
  switch (level) {
    case 1: return "normal";
    case 2: return "warning";
    case 4: return "critical";
    default: throw new Error("Unrecognized macOS memory pressure level");
  }
}

function hostBudgetPath(): string {
  // Broker fixtures redirect support data. They must never spend the user's budget.
  if (isTestRunnerProcess()) {
    const directory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    if (!directory) throw new Error("Test broker needs an isolated support directory");
    return join(directory, "launch-admission.sqlite");
  }
  return join(homedir(), "Library", "Caches", "OpenScout", "launch-admission.sqlite");
}

export class HostLaunchAdmission {
  private database?: ControlPlaneSqliteTransactionalDatabase;
  private sample?: { at: number; value: Promise<HostPressure> };
  private held?: HostLaunchDeferred;
  private readonly queue = new Set<Ticket>();
  private draining = false;

  constructor(private readonly options: {
    path?: string;
    pressure?: () => Promise<HostPressure>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}) {}

  /** Queued callers share one host probe and timer. Parking journals once per wait. */
  wait(needed: Ticket["needed"], onWait: Ticket["onWait"]): Promise<boolean> {
    return new Promise((finish, fail) => {
      const ticket: Ticket = { needed, onWait, finish, fail };
      this.queue.add(ticket);
      if (this.draining) this.park(ticket, "waiting for an earlier local worker");
      else void this.drain();
    });
  }

  private park(ticket: Ticket, reason: string): void {
    if (!ticket.parked) ticket.parked = ticket.onWait(reason).catch(error => {
      this.queue.delete(ticket);
      ticket.fail(error);
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.size) {
        const ticket = this.queue.values().next().value!;
        try {
          await ticket.parked;
          if (this.queue.has(ticket) && ticket.needed()) {
            await this.reserve();
            ticket.finish(ticket.needed());
          } else ticket.finish(false);
        } catch (error) {
          if (error instanceof HostLaunchDeferred) {
            this.park(ticket, error.reason);
            // Drop cancelled and superseded work even during prolonged pressure.
            for (const queued of this.queue) {
              if (!queued.needed()) { this.queue.delete(queued); queued.finish(false); }
            }
            const delay = Math.max(1, error.retryAt - (this.options.now ?? Date.now)());
            if (this.queue.size) await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
            continue;
          }
          ticket.fail(error);
        }
        this.queue.delete(ticket);
      }
    } finally { this.draining = false; }
  }

  // A single in-flight probe serves concurrent requests. Reservations themselves
  // are serialized across processes by an immediate SQLite transaction.
  async reserve(): Promise<void> {
    const now = this.options.now ?? Date.now;
    const at = now();
    if (this.held && at < this.held.retryAt && this.held.retryAt - at <= CAUTIOUS_START_MS) throw this.held;
    try {
      if (!this.sample || at < this.sample.at || at - this.sample.at >= SAMPLE_MS) {
        this.sample = { at, value: (this.options.pressure ?? readMacHostPressure)() };
      }
      const sample = this.sample;
      const pressure = await sample.value;
      const time = now();
      if (time < sample.at || time - sample.at > 5 * SAMPLE_MS) {
        throw new HostLaunchDeferred("refreshing host pressure", time + SAMPLE_MS);
      }
      const database = this.open();
      const hold = database.transaction(() => {
        const prior = database.query<Budget>("SELECT nextStart, recovering, normalSince, sampledAt FROM budget WHERE id = 1").get()!;
        const next = { ...prior };
        let wait: HostLaunchDeferred | undefined;
        // A delayed result from another broker cannot erase a newer critical sample.
        if (sample.at < prior.sampledAt && prior.sampledAt - sample.at <= RECOVERY_MS) {
          return new HostLaunchDeferred("refreshing host pressure", time + SAMPLE_MS);
        }
        if (prior.nextStart - time > CAUTIOUS_START_MS) next.nextStart = time;
        if (prior.recovering && (sample.at < prior.sampledAt || sample.at - prior.sampledAt > 5 * SAMPLE_MS)) next.normalSince = null;
        if (prior.recovering || pressure === "critical") next.sampledAt = sample.at;
        if (pressure === "critical" || (prior.recovering && pressure === "warning")) {
          next.recovering = 1;
          next.normalSince = null;
          wait = new HostLaunchDeferred("host memory pressure", time + SAMPLE_MS);
        } else if (prior.recovering && (next.normalSince === null || time < next.normalSince + RECOVERY_MS)) {
          next.normalSince ??= time;
          wait = new HostLaunchDeferred("host memory is recovering", time + SAMPLE_MS);
        } else if (time < next.nextStart) {
          wait = new HostLaunchDeferred("another local worker just started", prior.nextStart);
        } else {
          next.nextStart = time + (prior.recovering || pressure === "warning" ? CAUTIOUS_START_MS : NORMAL_START_MS);
          next.recovering = 0;
          next.sampledAt = sample.at;
          next.normalSince = null;
        }
        if (next.sampledAt !== prior.sampledAt || next.nextStart !== prior.nextStart || next.recovering !== prior.recovering || next.normalSince !== prior.normalSince) {
          database.query("UPDATE budget SET nextStart = ?, recovering = ?, normalSince = ?, sampledAt = ? WHERE id = 1")
            .run(next.nextStart, next.recovering, next.normalSince, next.sampledAt);
        }
        return wait;
      })();
      if (hold) throw hold;
      this.held = undefined;
    } catch (error) {
      this.held = error instanceof HostLaunchDeferred ? error
        : new HostLaunchDeferred(error instanceof Error && /pressure/i.test(error.message)
          ? "host memory pressure unavailable" : "host launch budget unavailable", now() + SAMPLE_MS);
      throw this.held;
    }
  }

  private open(): ControlPlaneSqliteTransactionalDatabase {
    if (this.database) return this.database;
    const path = this.options.path ?? hostBudgetPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = openRuntimeSqliteDatabase(path, { create: true }) as ControlPlaneSqliteTransactionalDatabase;
    try {
      db.exec("PRAGMA busy_timeout=0");
      db.exec("CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY, nextStart INTEGER NOT NULL, recovering INTEGER NOT NULL, normalSince INTEGER, sampledAt INTEGER NOT NULL)");
      db.exec("INSERT OR IGNORE INTO budget VALUES (1, 0, 0, NULL, 0)");
      this.database = db;
      return db;
    } catch (error) {
      db.close?.();
      throw error;
    }
  }

  close(): void { this.database?.close?.(); this.database = undefined; }
}

// Direct warmups and durable dispatch use the same user-wide host budget.
// Direct callers receive a retryable refusal before a restart can stop its worker.
export const macHostLaunchAdmission = process.platform === "darwin" ? new HostLaunchAdmission() : undefined;


// Bind a reservation to the dispatch that was allowed to reuse a live worker.
// A transport that loses that worker must spend a start slot before replacing it.
export const warmWorkerContinuation = new AsyncLocalStorage<{ endpointId: string; reserve: () => Promise<void> }>();
