/**
 * Memory snapshots on request. scoutd watches every Scout process's footprint and the host's memory pressure
 * (crates/scoutd/src/memory_watch.rs) and decides what to do; a process only describes what it holds when asked.
 *
 * When `OPENSCOUT_MEMORY_SNAPSHOT_DIR` is set, the process registers in `<dir>/registered/<pid>` and, on SIGUSR2,
 * writes `<dir>/<role>-<pid>-<time>.json`: its memory use, its heap's most common object types, and its probes.
 * scoutd signals only registered processes, because SIGUSR2's default action ends a process that has no handler.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MB = 1024 * 1024;
export const MEMORY_SNAPSHOT_DIR_ENV = "OPENSCOUT_MEMORY_SNAPSHOT_DIR";

/** The JavaScript heap's most common live object types: a growing type names what is being kept. */
type HeapStats = { heapSize: number; objectCount: number; objectTypeCounts: Record<string, number> };
let heapStats: (() => HeapStats) | undefined;
// Loaded lazily: the module stays importable outside Bun, where it reports without heap types.
const heapStatsReady: Promise<void> = typeof Bun === "undefined"
  ? Promise.resolve()
  : import("bun:jsc").then((jsc) => { heapStats = jsc.heapStats as () => HeapStats; }, () => {});

export function heapObjectTypes(limit = 20): { heapSizeMb?: number; objectCount?: number; types?: [string, number][] } {
  try {
    if (!heapStats) return {};
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

export function memoryUsageMb(): { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number } {
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

export function memorySnapshot(role: string, probes?: Record<string, () => unknown>, now = Date.now()) {
  return {
    role,
    pid: process.pid,
    at: new Date(now).toISOString(),
    uptimeS: Math.round(process.uptime()),
    ...memoryUsageMb(),
    jsc: heapObjectTypes(),
    probes: runMemoryProbes(probes),
  };
}

/**
 * Register for snapshots and answer SIGUSR2. Returns a function that unregisters; without the env var it does nothing.
 */
export function installMemorySnapshot(options: {
  role: string;
  probes?: Record<string, () => unknown>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): () => void {
  const dir = (options.env ?? process.env)[MEMORY_SNAPSHOT_DIR_ENV]?.trim();
  if (!dir) return () => {};
  const log = options.log ?? ((line: string) => console.warn(line));
  const registration = join(dir, "registered", String(process.pid));
  const onSignal = async () => {
    try {
      await heapStatsReady;
      const snapshot = memorySnapshot(options.role, options.probes);
      const file = join(dir, `${options.role}-${process.pid}-${snapshot.at.replace(/[:.]/g, "-")}.json`);
      writeFileSync(file, JSON.stringify(snapshot, null, 2));
      log(`[memory-snapshot] ${options.role} rss=${snapshot.rssMb}MB heap=${snapshot.heapUsedMb}MB -> ${file}`);
    } catch (error) {
      log(`[memory-snapshot] ${options.role} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const unregister = () => { try { rmSync(registration, { force: true }); } catch { /* scoutd drops it on exit */ } };
  process.on("SIGUSR2", onSignal);
  try {
    mkdirSync(join(dir, "registered"), { recursive: true });
    writeFileSync(registration, options.role);
  } catch (error) {
    log(`[memory-snapshot] ${options.role} could not register: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.once("exit", unregister);
  return () => {
    process.off("SIGUSR2", onSignal);
    process.off("exit", unregister);
    unregister();
  };
}
