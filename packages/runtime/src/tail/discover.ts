import type { DiscoveredProcess, TailAttribution } from "./types.js";
import { readProcessCwd, readProcessDiscoveryRows } from "../system-probes/ps.js";

const PARENT_HOP_LIMIT = 10;
const PROCESS_LIST_CACHE_MS = readNonNegativeIntEnv("OPENSCOUT_TAIL_PROCESS_CACHE_MS", 1000);
/**
 * A process's working directory rarely changes, and reading it costs one
 * `lsof` spawn per process. Keep a read this long for the same process.
 */
const CWD_CACHE_TTL_MS = readNonNegativeIntEnv("OPENSCOUT_TAIL_CWD_CACHE_MS", 10 * 60_000);
/** A failed read (process gone, permission) is retried sooner. */
const CWD_MISS_CACHE_TTL_MS = Math.min(CWD_CACHE_TTL_MS, 60_000);
const CWD_CACHE_LIMIT = 1_024;
/** `etime` has one-second resolution and ps and the clock are read apart. */
const START_TIME_TOLERANCE_S = 3;

export type RawProcess = {
  pid: number;
  ppid: number;
  etime: string;
  /** See DiscoveredProcess.cpuPct. */
  cpuPct?: number;
  /** See DiscoveredProcess.rssKb. */
  rssKb?: number;
  command: string;
};

let processListCache: { expiresAt: number; promise: Promise<RawProcess[]> } | null = null;
let processListPins = 0;
let processReader = () => readProcessDiscoveryRows(PROCESS_LIST_CACHE_MS);

type CwdCacheEntry = { startedAtSec: number | null; cwd: string | null; readAt: number };
const cwdCache = new Map<number, CwdCacheEntry>();
let cwdReader: (pid: number) => Promise<string | null> = (pid) => readProcessCwd(pid, 1_000);

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

async function readProcessListUncached(): Promise<RawProcess[]> {
  const rows = await processReader();
  pruneCwdCache(rows);
  return rows;
}

export async function listProcesses(): Promise<RawProcess[]> {
  const now = Date.now();
  if (processListCache && (processListPins > 0 || now < processListCache.expiresAt)) {
    return processListCache.promise;
  }

  let promise = readProcessListUncached();
  promise = promise.catch((error) => {
    if (processListCache?.promise === promise) {
      processListCache = null;
    }
    throw error;
  });
  processListCache = {
    expiresAt: now + PROCESS_LIST_CACHE_MS,
    promise,
  };
  return promise;
}

/**
 * Run one discovery pass against one process list. Sources run one after
 * another, so without this a slow source lets the short cache expire and the
 * next source runs `ps` again and sees a slightly different process table.
 */
export async function withProcessListPass<T>(run: () => Promise<T>): Promise<T> {
  if (processListPins === 0 && processListCache && Date.now() >= processListCache.expiresAt) {
    processListCache = null;
  }
  processListPins++;
  try {
    return await run();
  } finally {
    processListPins--;
  }
}

/** The optional resource fields a source copies onto its DiscoveredProcess. */
export function processResourceFields(proc: RawProcess): Pick<DiscoveredProcess, "cpuPct" | "rssKb"> {
  return {
    ...(typeof proc.cpuPct === "number" ? { cpuPct: proc.cpuPct } : {}),
    ...(typeof proc.rssKb === "number" ? { rssKb: proc.rssKb } : {}),
  };
}

export function commandBasename(command: string): string {
  const firstToken = command.split(/\s+/)[0] ?? "";
  const slashIdx = firstToken.lastIndexOf("/");
  return slashIdx >= 0 ? firstToken.slice(slashIdx + 1) : firstToken;
}

export function isClaudeBinary(command: string): boolean {
  const base = commandBasename(command);
  if (base === "claude") return true;
  if (base.startsWith("claude ")) return true;
  // Reject anything else even if "claude" appears in args (e.g. helpers).
  return false;
}

/** `ps -o etime` is `[[dd-]hh:]mm:ss`. Returns seconds, or null when unparseable. */
export function parseEtimeSeconds(etime: string): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function processStartSec(etime: string | undefined, now: number): number | null {
  const elapsed = etime ? parseEtimeSeconds(etime) : null;
  return elapsed === null ? null : Math.floor(now / 1000) - elapsed;
}

function pruneCwdCache(rows: readonly { pid: number }[]): void {
  if (cwdCache.size === 0) return;
  const live = new Set(rows.map((row) => row.pid));
  for (const pid of cwdCache.keys()) {
    if (!live.has(pid)) cwdCache.delete(pid);
  }
}

/**
 * The working directory of `pid`, cached per process: `etime` gives the
 * process's start time, so a reused pid is a cache miss. Without `etime` the
 * read is cached only by pid.
 */
export async function readCwd(pid: number, etime?: string): Promise<string | null> {
  const now = Date.now();
  const startedAtSec = processStartSec(etime, now);
  const cached = cwdCache.get(pid);
  if (cached) {
    const sameProcess = cached.startedAtSec === null || startedAtSec === null
      || Math.abs(cached.startedAtSec - startedAtSec) <= START_TIME_TOLERANCE_S;
    const ttl = cached.cwd === null ? CWD_MISS_CACHE_TTL_MS : CWD_CACHE_TTL_MS;
    if (sameProcess && now - cached.readAt < ttl) return cached.cwd;
  }
  const cwd = await cwdReader(pid);
  cwdCache.delete(pid);
  cwdCache.set(pid, { startedAtSec, cwd, readAt: Date.now() });
  while (cwdCache.size > CWD_CACHE_LIMIT) {
    const oldest = cwdCache.keys().next().value;
    if (oldest === undefined) break;
    cwdCache.delete(oldest);
  }
  return cwd;
}

/** Test seam: forget cached process lists and working directories, and optionally replace the cwd reader. */
export function resetDiscoverCachesForTest(
  reader?: (pid: number) => Promise<string | null>,
  readProcesses?: () => Promise<RawProcess[]>,
): void {
  processListCache = null;
  processListPins = 0;
  processReader = readProcesses ?? (() => readProcessDiscoveryRows(PROCESS_LIST_CACHE_MS));
  cwdCache.clear();
  cwdReader = reader ?? ((pid) => readProcessCwd(pid, 1_000));
}

export function classifyAttribution(parentChain: { command: string }[]): TailAttribution {
  for (const ancestor of parentChain) {
    const cmd = ancestor.command.toLowerCase();
    if (cmd.includes("/openscout") || cmd.includes("openscout/") || cmd.includes("packages/runtime")) {
      return "scout-managed";
    }
    if (cmd.includes("/hudson") || cmd.includes("dev/hudson") || cmd.includes("hudson/")) {
      return "hudson-managed";
    }
  }
  return "unattributed";
}

/** @deprecated Use classifyAttribution. */
export const classifyHarness = classifyAttribution;

export function buildParentChain(
  startPid: number,
  byPid: Map<number, RawProcess>,
): { pid: number; command: string }[] {
  const chain: { pid: number; command: string }[] = [];
  let cursor = byPid.get(startPid)?.ppid ?? 0;
  let hops = 0;
  const seen = new Set<number>();
  while (cursor > 1 && hops < PARENT_HOP_LIMIT && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byPid.get(cursor);
    if (!parent) break;
    chain.push({ pid: parent.pid, command: parent.command });
    cursor = parent.ppid;
    hops++;
  }
  return chain;
}

export async function discoverClaudeProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const claudes = all.filter((p) => isClaudeBinary(p.command));
  const out: DiscoveredProcess[] = [];

  await Promise.all(
    claudes.map(async (proc) => {
      const cwd = await readCwd(proc.pid, proc.etime);
      const parentChain = buildParentChain(proc.pid, byPid);
      const harness = classifyAttribution(parentChain);
      out.push({
        pid: proc.pid,
        ppid: proc.ppid,
        command: proc.command,
        etime: proc.etime,
        ...processResourceFields(proc),
        cwd,
        harness,
        parentChain,
        source: "claude",
      });
    }),
  );

  out.sort((a, b) => a.pid - b.pid);
  return out;
}
