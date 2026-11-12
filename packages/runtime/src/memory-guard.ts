/**
 * Memory guard: a long-running Scout process notes what it holds when it grows too large, and restarts before it
 * takes the host down.
 *
 * - Over the soft limit (3 GB by default) it records a snapshot at most once a minute.
 * - Over the hard limit (4 GB by default) it records a final snapshot and the process exits, so its supervisor starts
 *   a fresh one. After two such exits in 30 minutes it stops exiting and keeps recording, so a load that regrows at
 *   once does not turn into a restart loop.
 *
 * Each snapshot is one `[memory-guard]` log line and a JSON file in the process's log folder; the newest 12 are kept.
 */
import { heapStats } from "bun:jsc";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MB = 1024 * 1024;
export const MEMORY_GUARD_SOFT_EVERY_MS = 60_000;
export const MEMORY_GUARD_EXIT_WINDOW_MS = 30 * 60_000;
export const MEMORY_GUARD_EXITS_PER_WINDOW = 2;
const SNAPSHOTS_KEPT = 12;

export type MemoryGuardLimits = { softBytes: number; hardBytes: number };
export type MemoryGuardAction = "none" | "soft" | "hard-exit" | "hard-held";

/** `OPENSCOUT_<NAME>_MEMORY_SOFT_MB` and `_HARD_MB` move the limits; 0 turns one off. */
export function memoryGuardLimits(name: string, env: NodeJS.ProcessEnv = process.env): MemoryGuardLimits {
  const mb = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const key = name.toUpperCase();
  return {
    softBytes: mb(env[`OPENSCOUT_${key}_MEMORY_SOFT_MB`], 3072) * MB,
    hardBytes: mb(env[`OPENSCOUT_${key}_MEMORY_HARD_MB`], 4096) * MB,
  };
}

/** What the guard does at this size, given when it last noted a soft snapshot or a held exit, and its recent exits. */
export function memoryGuardAction(input: {
  rss: number;
  now: number;
  limits: MemoryGuardLimits;
  lastSoftAt: number;
  lastHeldAt: number;
  recentExits: number[];
}): MemoryGuardAction {
  const { rss, now, limits } = input;
  if (limits.hardBytes > 0 && rss >= limits.hardBytes) {
    if (input.recentExits.length < MEMORY_GUARD_EXITS_PER_WINDOW) return "hard-exit";
    return now - input.lastHeldAt >= MEMORY_GUARD_SOFT_EVERY_MS ? "hard-held" : "none";
  }
  if (limits.softBytes > 0 && rss >= limits.softBytes && now - input.lastSoftAt >= MEMORY_GUARD_SOFT_EVERY_MS) return "soft";
  return "none";
}

/** The JavaScript heap's most common live object types: a growing type names what is being kept. */
export function heapObjectTypes(limit = 20): { heapSizeMb?: number; objectCount?: number; types?: [string, number][] } {
  try {
    const stats = heapStats();
    return {
      heapSizeMb: Math.round(stats.heapSize / MB),
      objectCount: stats.objectCount,
      types: Object.entries(stats.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, limit),
    };
  } catch {
    return {};
  }
}

export function memoryUsageMb(): Record<string, number> {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / MB),
    heapUsedMb: Math.round(usage.heapUsed / MB),
    heapTotalMb: Math.round(usage.heapTotal / MB),
    externalMb: Math.round(usage.external / MB),
    arrayBuffersMb: Math.round(usage.arrayBuffers / MB),
  };
}

/** Run each named report; one that throws reports its error instead of losing the snapshot. */
export function runMemoryProbes(probes: Record<string, () => unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, probe] of Object.entries(probes)) {
    try { out[name] = probe(); } catch (error) { out[name] = { error: error instanceof Error ? error.message : String(error) }; }
  }
  return out;
}

/** Where a process keeps its snapshots and its record of recent guard exits. */
export class MemoryGuardRecord {
  readonly #exitsFile: string;
  constructor(private readonly dir: string, private readonly name: string) {
    this.#exitsFile = join(dir, `${name}-memory-guard-exits.json`);
  }

  recentExits(now: number): number[] {
    try {
      const list = JSON.parse(readFileSync(this.#exitsFile, "utf8"));
      return Array.isArray(list) ? list.filter((x): x is number => typeof x === "number" && now - x < MEMORY_GUARD_EXIT_WINDOW_MS) : [];
    } catch { return []; }
  }

  noteExit(now: number): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.#exitsFile, JSON.stringify([...this.recentExits(now), now]));
    } catch { /* best effort: the log line still carries the snapshot */ }
  }

  /** Log the snapshot as one line and keep it as a file. */
  write(snapshot: { reason: string; at: string; rssMb: number } & Record<string, unknown>, log: (line: string) => void): void {
    log(`[memory-guard] ${this.name} ${snapshot.reason} rss=${snapshot.rssMb}MB ${JSON.stringify(snapshot)}`);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${this.name}-memory-guard-${snapshot.at.replace(/[:.]/g, "-")}-${snapshot.reason}.json`), JSON.stringify(snapshot, null, 2));
      const prefix = `${this.name}-memory-guard-`;
      const kept = readdirSync(this.dir).filter((f) => f.startsWith(prefix) && /\d/.test(f.slice(prefix.length, prefix.length + 1)) && f.endsWith(".json")).sort();
      for (const old of kept.slice(0, Math.max(0, kept.length - SNAPSHOTS_KEPT))) rmSync(join(this.dir, old), { force: true });
    } catch { /* the log line already carries the snapshot */ }
  }
}
