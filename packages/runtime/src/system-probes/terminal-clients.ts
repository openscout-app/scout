import { basename } from "node:path";

import type { TerminalSessionClients } from "@openscout/protocol";

import { defineProbe, type ProbeCtx } from "./registry.js";
import { execProbeFile } from "./exec.js";
import { psRuntimeProbe, type ProcessCommandRow, type ProcessRow } from "./ps.js";

/**
 * Which app a terminal client runs in.
 *
 * A multiplexer client (`tmux attach`, `herdr session attach`) is a process in
 * some terminal. To name that terminal, walk the client's parent pids until one
 * runs from inside a `.app` bundle. Some terminal apps attach through a
 * windowless helper app; LaunchServices (`lsappinfo`) and launchd say which
 * visible app owns that helper, so the answer is the app a person sees.
 *
 * macOS only. Elsewhere clients are still counted and `apps` is empty.
 */

/** One client process attached to a named multiplexer session. */
export type TerminalClientRef = { pid: number; session: string };

export type ClientProcessEntry = { ppid: number; comm: string | null; command: string | null };
export type ClientProcessTable = Map<number, ClientProcessEntry>;

/** One running app as `lsappinfo list` reports it. */
export type MacAppRecord = {
  name: string;
  asn: string | null;
  bundleId: string | null;
  bundlePath: string | null;
  executablePath: string | null;
  pid: number | null;
  /** "Foreground", "UIElement" or "BackgroundOnly". */
  type: string | null;
  parentAsn: string | null;
  /** launchd job labels the app has loaded, e.g. a helper it keeps running. */
  loadedJobs: string[];
};

export type MacAppIndex = {
  apps: MacAppRecord[];
  /** pid → launchd job label, from `launchctl list`. */
  launchdLabels: Map<number, string>;
};

const MAX_PARENT_HOPS = 64;
const CLIENT_APP_CACHE_TTL_MS = 60_000;
const CLIENT_APP_CACHE_CAP = 512;
const MAC_APPS_TTL_MS = 30_000;
const MAC_APPS_TIMEOUT_MS = 2_000;
const PS_MAX_AGE_MS = 5_000;

const ASN_PATTERN = /ASN:0x[0-9a-f]+-0x[0-9a-f]+/iu;

function positivePid(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  const pid = Number.parseInt(value, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function quotedValue(line: string, field: string): string | null {
  const prefix = `${field}=`;
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  // `bundleID=[ NULL ]` is how lsappinfo prints an absent value.
  if (!rest.startsWith("\"") || !rest.endsWith("\"") || rest.length < 2) return null;
  return rest.slice(1, -1) || null;
}

/**
 * Parse `lsappinfo list`. Each app is a numbered header line followed by
 * indented `key=value` lines; anything this parser does not recognize is
 * skipped rather than guessed at.
 */
export function parseLsappinfoList(output: string): MacAppRecord[] {
  const apps: MacAppRecord[] = [];
  let current: MacAppRecord | null = null;
  for (const line of output.split(/\r?\n/u)) {
    const header = /^\s*\d+\)\s+"(.*)"\s+(ASN:0x[0-9a-f]+-0x[0-9a-f]+)/iu.exec(line);
    if (header) {
      current = {
        name: header[1] ?? "",
        asn: header[2] ?? null,
        bundleId: null,
        bundlePath: null,
        executablePath: null,
        pid: null,
        type: null,
        parentAsn: null,
        loadedJobs: [],
      };
      apps.push(current);
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("bundleID=")) {
      current.bundleId = quotedValue(trimmed, "bundleID");
    } else if (trimmed.startsWith("bundle path=")) {
      current.bundlePath = quotedValue(trimmed, "bundle path");
    } else if (trimmed.startsWith("executable path=")) {
      current.executablePath = quotedValue(trimmed, "executable path");
    } else if (trimmed.startsWith("pid = ")) {
      current.pid = positivePid(/^pid = (\d+)/u.exec(trimmed)?.[1]);
      current.type = /\btype="([^"]*)"/u.exec(trimmed)?.[1] || null;
    } else if (trimmed.startsWith("parentASN=")) {
      current.parentAsn = ASN_PATTERN.exec(trimmed)?.[0] ?? null;
    } else if (trimmed.startsWith("loadedJobs:")) {
      current.loadedJobs = [...trimmed.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
    }
  }
  return apps.filter((app) => app.name);
}

/** Parse `launchctl list` (`PID\tStatus\tLabel`) into pid → label, running jobs only. */
export function parseLaunchctlList(output: string): Map<number, string> {
  const labels = new Map<number, string>();
  for (const line of output.split(/\r?\n/u)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const pid = positivePid(parts[0]?.trim());
    const label = parts.slice(2).join("\t").trim();
    if (pid && label) labels.set(pid, label);
  }
  return labels;
}

/**
 * The outermost `.app` bundle an executable path runs from. A helper nested in
 * its owner (`Owner.app/Contents/Frameworks/Owner Helper.app/...`) resolves to
 * the owner. The bundle must be followed by `/Contents/`, so an app path that
 * appears only as an argument (`/usr/bin/open /Applications/X.app`) does not.
 */
export function outermostAppBundle(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/")) return null;
  return /^(\/.*?\.app)\/Contents\//u.exec(path)?.[1] ?? null;
}

export function buildClientProcessTable(rows: readonly ProcessRow[], commandRows: readonly ProcessCommandRow[]): ClientProcessTable {
  const table: ClientProcessTable = new Map();
  for (const row of rows) table.set(row.pid, { ppid: row.ppid, comm: row.comm || null, command: null });
  for (const row of commandRows) {
    const existing = table.get(row.pid);
    if (existing) existing.command = row.command || null;
    else table.set(row.pid, { ppid: row.ppid, comm: null, command: row.command || null });
  }
  return table;
}

/** The nearest process, starting at `pid` itself, that runs from inside an app bundle. */
export function findAppAncestor(pid: number, table: ClientProcessTable): { pid: number; bundlePath: string } | null {
  const seen = new Set<number>();
  let current = pid;
  for (let hops = 0; current > 1 && hops < MAX_PARENT_HOPS && !seen.has(current); hops += 1) {
    seen.add(current);
    const row = table.get(current);
    if (!row) return null;
    // `comm` is the executable path; argv can carry arguments with spaces.
    const bundlePath = outermostAppBundle(row.comm) ?? outermostAppBundle(row.command);
    if (bundlePath) return { pid: current, bundlePath };
    current = row.ppid;
  }
  return null;
}

function isForegroundApp(app: MacAppRecord | null | undefined): boolean {
  return app?.type === "Foreground";
}

/**
 * The name a person would recognize for the app a client runs in. A visible
 * app answers for itself. A helper answers with the app that owns it: its
 * LaunchServices parent, or the visible app that loaded its launchd job. With
 * no owner known, the helper's own name stands, then the bundle's file name.
 */
export function macAppDisplayName(ancestor: { pid: number; bundlePath: string }, index: MacAppIndex | null): string {
  const fallback = basename(ancestor.bundlePath).replace(/\.app$/iu, "");
  if (!index) return fallback;
  const registered = index.apps.find((app) => app.pid === ancestor.pid)
    ?? index.apps.find((app) => app.bundlePath === ancestor.bundlePath)
    ?? null;
  if (registered && isForegroundApp(registered)) return registered.name;
  const parentAsn = registered?.parentAsn;
  const parent = parentAsn ? index.apps.find((app) => app.asn === parentAsn) : undefined;
  if (parent && isForegroundApp(parent)) return parent.name;
  const label = index.launchdLabels.get(ancestor.pid);
  if (label) {
    const owner = index.apps.find((app) => isForegroundApp(app) && app.loadedJobs.includes(label));
    if (owner) return owner.name;
  }
  return registered?.name || fallback;
}

type CachedClientApp = { signature: string; app: string | null; at: number };

export type TerminalClientSummaryDeps = {
  table: ClientProcessTable;
  /** Loaded at most once per summary, and only when a client needs it. */
  apps: () => Promise<MacAppIndex | null>;
  platform?: NodeJS.Platform;
  cache?: Map<number, CachedClientApp>;
  now?: () => number;
};

const clientAppCache = new Map<number, CachedClientApp>();

function processSignature(entry: ClientProcessEntry): string {
  return `${entry.comm ?? ""}\u0000${entry.command ?? ""}`;
}

/**
 * Count the clients of one session and name the apps they run in. Pids are
 * de-duplicated. The pid → app walk is cached by pid, and a cached answer is
 * reused only while that pid still runs the same command, so a recycled pid is
 * walked again.
 */
export async function summarizeTerminalClients(
  refs: readonly TerminalClientRef[],
  session: string,
  deps: TerminalClientSummaryDeps,
): Promise<TerminalSessionClients> {
  const platform = deps.platform ?? process.platform;
  const cache = deps.cache ?? clientAppCache;
  const now = deps.now ?? Date.now;
  const pids = [...new Set(refs.filter((ref) => ref.session === session).map((ref) => ref.pid))];
  const summary: TerminalSessionClients = { clients: pids.length, apps: [] };
  if (platform !== "darwin") return summary;

  let index: Promise<MacAppIndex | null> | null = null;
  for (const pid of pids) {
    const entry = deps.table.get(pid);
    if (!entry) continue;
    const signature = processSignature(entry);
    const cached = cache.get(pid);
    let app: string | null;
    if (cached && cached.signature === signature && now() - cached.at <= CLIENT_APP_CACHE_TTL_MS) {
      app = cached.app;
    } else {
      const ancestor = findAppAncestor(pid, deps.table);
      let resolvedIndex: MacAppIndex | null = null;
      if (ancestor) {
        index ??= deps.apps().catch(() => null);
        resolvedIndex = await index;
      }
      app = ancestor ? macAppDisplayName(ancestor, resolvedIndex) : null;
      // An answer reached without the app index is a fallback; do not keep it.
      if (!ancestor || resolvedIndex) {
        cache.delete(pid);
        cache.set(pid, { signature, app, at: now() });
        while (cache.size > CLIENT_APP_CACHE_CAP) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
    }
    if (app && !summary.apps.includes(app)) summary.apps.push(app);
  }
  return summary;
}

async function readMacAppsLocal(ctx: ProbeCtx): Promise<{ apps: MacAppRecord[]; launchdLabels: Array<[number, string]> }> {
  if (process.platform !== "darwin") return { apps: [], launchdLabels: [] };
  const [apps, launchdLabels] = await Promise.all([
    execProbeFile(ctx, "lsappinfo", ["list"], { maxStdoutBytes: 2 * 1024 * 1024, maxStderrBytes: 64 * 1024 })
      .then((result) => parseLsappinfoList(result.stdout)),
    // Only helpers need this, and the app index still answers for every
    // registered app without it.
    execProbeFile(ctx, "launchctl", ["list"], { maxStdoutBytes: 1024 * 1024, maxStderrBytes: 64 * 1024 })
      .then((result) => [...parseLaunchctlList(result.stdout)])
      .catch(() => [] as Array<[number, string]>),
  ]);
  return { apps, launchdLabels };
}

/** Running apps and launchd job labels. Apps change rarely, so this is cached for 30s. */
export const macAppsProbe = defineProbe<{ apps: MacAppRecord[]; launchdLabels: Array<[number, string]> }>({
  id: "macos.apps",
  ttlMs: MAC_APPS_TTL_MS,
  timeoutMs: MAC_APPS_TIMEOUT_MS,
  run: (ctx) => readMacAppsLocal(ctx),
});

let macAppIndexMemo: { at: number; index: MacAppIndex } | null = null;
let processTableMemo: { at: number; commandRows: readonly ProcessCommandRow[]; table: ClientProcessTable } | null = null;

export async function readMacAppIndex(): Promise<MacAppIndex | null> {
  // fresh() re-runs a failed probe on every call; hold a recent failure for the
  // TTL instead, so a host where lsappinfo fails is not asked again each read.
  const cached = macAppsProbe.snapshot();
  const snapshot = cached.error && Date.now() - cached.error.at <= MAC_APPS_TTL_MS
    ? cached
    : await macAppsProbe.fresh({ maxAgeMs: MAC_APPS_TTL_MS });
  if (!snapshot.value || snapshot.at === null) return null;
  if (macAppIndexMemo?.at !== snapshot.at) {
    macAppIndexMemo = {
      at: snapshot.at,
      index: { apps: snapshot.value.apps, launchdLabels: new Map(snapshot.value.launchdLabels) },
    };
  }
  return macAppIndexMemo.index;
}

/**
 * The host's process table, shared with every other `ps.runtime` reader.
 * Null when it could not be read, so callers report clients as unknown rather
 * than as zero.
 */
export async function readClientProcessTable(): Promise<{ commandRows: readonly ProcessCommandRow[]; table: ClientProcessTable } | null> {
  const snapshot = await psRuntimeProbe.fresh({ maxAgeMs: PS_MAX_AGE_MS });
  if (!snapshot.value || snapshot.at === null) return null;
  if (processTableMemo?.at !== snapshot.at) {
    processTableMemo = {
      at: snapshot.at,
      commandRows: snapshot.value.commandRows,
      table: buildClientProcessTable(snapshot.value.rows, snapshot.value.commandRows),
    };
  }
  return processTableMemo;
}

/** For tests: forget cached pid → app answers. */
export function resetTerminalClientCachesForTests(): void {
  clientAppCache.clear();
  macAppIndexMemo = null;
  processTableMemo = null;
}
