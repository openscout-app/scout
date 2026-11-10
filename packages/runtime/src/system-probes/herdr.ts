import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { emptyHerdrSessionTopology } from "@openscout/protocol";
import type {
  HerdrAgentSessionRef,
  HerdrLayoutRect,
  HerdrPaneProjection,
  HerdrSessionTopology,
  HerdrTabLayout,
  HerdrTabProjection,
  HerdrTopologyUnavailableReason,
  HerdrWorkspaceProjection,
  TerminalSessionClients,
} from "@openscout/protocol";


import type { RuntimeEnv } from "../portable-types.js";

import { defineProbeFamily, probeRunOutput, type ProbeCtx, type ProbeSnapshot } from "./registry.js";
import { execProbeFile, execSystemFile } from "./exec.js";
import { gitRevParseProbe } from "./git.js";
import { runWithScoutdFallback } from "./scoutd-client.js";
import {
  readClientProcessTable,
  readMacAppIndex,
  summarizeTerminalClients,
  type ClientProcessTable,
  type TerminalClientRef,
} from "./terminal-clients.js";

const HERDR_TTL_MS = 5_000;
const HERDR_TIMEOUT_MS = 2_000;

export type HerdrSessionInfo = {
  name: string;
  isDefault: boolean;
  running: boolean;
  /** Server-local only — never forward to browser clients. */
  sessionDir: string | null;
};

/**
 * Agent state as the host reports it, rather than as Scout infers it from
 * screen-scraping a rendered composer. Only meaningful while the session's
 * herdr server is running; a stopped session simply reports no agents.
 */
export type HerdrAgentInfo = {
  /** Pane id, which `herdr agent <verb> <target>` accepts. */
  target: string;
  name: string | null;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
  cwd: string | null;
};

function herdrBin(env: RuntimeEnv = process.env): string {
  return env.OPENSCOUT_HERDR_BIN?.trim() || "herdr";
}

/**
 * The parts of an environment that decide what `herdr session list` answers:
 * which binary runs, where it is found, and which config home its sessions
 * live in. Everything else in an environment is noise for this probe.
 */
type HerdrProbeTarget = { bin: string; path: string; home: string; xdgConfigHome: string | null };

function herdrProbeTarget(env: RuntimeEnv): HerdrProbeTarget {
  return {
    bin: herdrBin(env),
    path: env.PATH ?? "",
    home: env.HOME?.trim() || homedir(),
    // Kept apart from HOME: herdr resolves its config as $XDG_CONFIG_HOME/herdr
    // and falls back to ~/.config only when XDG is unset. Synthesizing a value
    // for it here would relocate the config dir and hide every real session.
    xdgConfigHome: env.XDG_CONFIG_HOME?.trim() || null,
  };
}

function parseHerdrProbeKey(key: string): HerdrProbeTarget {
  try {
    const parsed = JSON.parse(key) as Partial<HerdrProbeTarget>;
    if (typeof parsed?.bin === "string" && typeof parsed.path === "string" && typeof parsed.home === "string") {
      return {
        bin: parsed.bin,
        path: parsed.path,
        home: parsed.home,
        xdgConfigHome: typeof parsed.xdgConfigHome === "string" && parsed.xdgConfigHome.trim()
          ? parsed.xdgConfigHome.trim()
          : null,
      };
    }
  } catch {
    // A caller-supplied opaque string key; fall through to this process.
  }
  return herdrProbeTarget(process.env);
}

/**
 * One cache entry per ENVIRONMENT, the way the tmux and zellij probes key on
 * socket path and socket dir.
 *
 * This used to collapse every environment to the literal string `"default"`,
 * so a caller passing an environment with no herdr on its PATH was served the
 * inventory collected for a completely different environment — nine live
 * sessions from a probe that should have found none. A client-supplied socket
 * path is still never accepted, which is the property the old comment was
 * reaching for; that is achieved by deriving the key from an environment
 * instead of taking one.
 */
export function herdrProbeKey(input?: string | { env?: RuntimeEnv } | null): string {
  if (typeof input === "string") return input.trim() || "default";
  return JSON.stringify(herdrProbeTarget(input?.env ?? process.env));
}

export function parseHerdrSessionListJson(output: string): HerdrSessionInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return [];
  }

  const sessions = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : [];

  const out: HerdrSessionInfo[] = [];
  for (const entry of sessions) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const isDefault = record.default === true || name === "default";
    const running = record.running === true;
    const sessionDir = typeof record.session_dir === "string" && record.session_dir.trim()
      ? record.session_dir.trim()
      : typeof record.sessionDir === "string" && record.sessionDir.trim()
        ? record.sessionDir.trim()
        : null;
    out.push({ name, isDefault, running, sessionDir });
  }
  return out;
}

/** Attach argv for a discovered Herdr session. Never includes socket paths. */
export function buildHerdrAttachCommand(session: Pick<HerdrSessionInfo, "name" | "isDefault">): string[] {
  if (session.isDefault || session.name === "default") {
    return ["herdr"];
  }
  return ["herdr", "session", "attach", session.name];
}

/** Create-or-attach argv for a Scout-owned named Herdr session. */
export function buildHerdrCreateAttachCommand(sessionName: string): string[] {
  const name = sessionName.trim();
  if (!name || name === "default") return ["herdr"];
  return ["herdr", "--session", name];
}

/**
 * Argv that brings a named Herdr session into existence with NO terminal
 * attached: the session's own headless server. `herdr --session <name>` needs a
 * TTY because it launches the client too; this is the half Scout wants, and the
 * session then shows up in `herdr session list` for anyone to attach to.
 */
export function buildHerdrStartServerCommand(sessionName: string): string[] {
  const name = sessionName.trim();
  if (!name || name === "default") return ["herdr", "server"];
  return ["herdr", "--session", name, "server"];
}

/** Argv for the first workspace inside a Scout-created Herdr session. */
export function buildHerdrWorkspaceCreateCommand(
  sessionName: string,
  input: { cwd?: string | null; label?: string | null } = {},
): string[] {
  const args = ["herdr", "--session", sessionName.trim(), "workspace", "create"];
  if (input.cwd?.trim()) args.push("--cwd", input.cwd.trim());
  if (input.label?.trim()) args.push("--label", input.label.trim());
  args.push("--no-focus");
  return args;
}

const HERDR_DEFAULT_SESSION = "default";

/**
 * The session a process is a herdr client of, read from its command line, or
 * null when it is not a client. A client is bare `herdr` (the default
 * session), `herdr --session X`, `herdr -s X`, `herdr --session=X`, or
 * `herdr session attach X`. Servers (`herdr server`), one-shot commands
 * (`herdr session list`, `herdr --version`) and remote attaches are not
 * clients of a session on this host.
 *
 * `ps` prints argv joined by spaces, so splitting alone cannot keep a herdr
 * path that holds a space together. `executable` is the process table's
 * `comm`; on macOS that is argv[0] in full. When it begins the command line it
 * marks where the executable ends. Otherwise (Linux reports a short kernel
 * name) the first whitespace-separated token is the executable.
 */
export function parseHerdrClientSession(command: string, executable?: string | null): string | null {
  const line = command.trim();
  const exe = executable?.trim();
  const leading = exe && (line === exe || line.startsWith(`${exe} `)) ? exe : null;
  const rest = (leading ? line.slice(leading.length) : line).split(/\s+/u).filter(Boolean);
  const bin = leading ?? rest.shift();
  if (!bin || basename(bin) !== "herdr") return null;
  let session = HERDR_DEFAULT_SESSION;
  let index = 0;
  while (index < rest.length && rest[index]!.startsWith("-")) {
    const flag = rest[index]!;
    if (flag === "--session" || flag === "-s") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) return null;
      session = value;
      index += 2;
    } else if (flag.startsWith("--session=")) {
      const value = flag.slice("--session=".length);
      if (!value) return null;
      session = value;
      index += 1;
    } else {
      return null;
    }
  }
  const positional = rest.slice(index);
  if (positional.length === 0) return session;
  if (positional.length === 3 && positional[0] === "session" && positional[1] === "attach") return positional[2]!;
  return null;
}

/**
 * Herdr client processes on this host, with the session each attaches to.
 * `table` supplies each pid's `comm`, which tells the executable from its
 * arguments when its path holds a space.
 */
export function herdrClientRefs(
  commandRows: readonly { pid: number; command: string }[],
  table?: ClientProcessTable,
): TerminalClientRef[] {
  return commandRows.flatMap((row) => {
    const session = parseHerdrClientSession(row.command, table?.get(row.pid)?.comm);
    return session ? [{ pid: row.pid, session }] : [];
  });
}

/**
 * Herdr clients attached to one session, counted from this host's process
 * table. Null when the process table could not be read.
 */
export async function readHerdrSessionClients(sessionName: string): Promise<TerminalSessionClients | null> {
  const processes = await readClientProcessTable();
  if (!processes) return null;
  return summarizeTerminalClients(herdrClientRefs(processes.commandRows, processes.table), sessionName, {
    table: processes.table,
    apps: readMacAppIndex,
  });
}

/**
 * `herdr agent list` answers over the socket API in JSON, wrapped as
 * `{ id, result: { agents: [...] } }`. Parse defensively: a status the schema
 * grows later reads as "unknown" rather than being guessed at, and an empty
 * result is an ordinary state (the session's server is not running).
 */
export function parseHerdrAgentList(output: string): HerdrAgentInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return [];
  }
  const result = parsed && typeof parsed === "object" && "result" in parsed
    ? (parsed as { result?: unknown }).result
    : parsed;
  const agents = result && typeof result === "object" && Array.isArray((result as { agents?: unknown }).agents)
    ? (result as { agents: unknown[] }).agents
    : [];

  const out: HerdrAgentInfo[] = [];
  for (const entry of agents) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const target = typeof record.pane_id === "string" && record.pane_id.trim()
      ? record.pane_id.trim()
      : typeof record.terminal_id === "string" && record.terminal_id.trim()
        ? record.terminal_id.trim()
        : null;
    if (!target) continue;
    out.push({
      target,
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : null,
      status: normalizeHerdrAgentStatus(record.agent_status),
      cwd: typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : null,
    });
  }
  return out;
}

function normalizeHerdrAgentStatus(value: unknown): HerdrAgentInfo["status"] {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "idle":
      return "idle";
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

/**
 * Run the listing in the environment the KEY names, not in this process's.
 *
 * The key already encodes the binary, the PATH, and the config home, so
 * rebuilding an environment from it is what makes the cache entry honest: the
 * answer stored under a key is the answer that key's environment produces.
 * Previously the environment a caller supplied was thrown away here and the
 * probe always ran against `process.env`.
 */
async function readHerdrSessionsLocal(key: string, ctx: ProbeCtx): Promise<HerdrSessionInfo[]> {
  const target = parseHerdrProbeKey(key);
  {
    // XDG_CONFIG_HOME is forwarded only when the probed environment set it.
    // Forcing it to HOME when unset relocates herdr's config dir from
    // ~/.config/herdr to ~/herdr, and the inventory collapses to a phantom
    // "default" while every real session disappears from discovery.
    const env: RuntimeEnv = { ...process.env, PATH: target.path, HOME: target.home };
    if (target.xdgConfigHome) env.XDG_CONFIG_HOME = target.xdgConfigHome;
    else delete env.XDG_CONFIG_HOME;
    const { stdout } = await execProbeFile(ctx, target.bin, ["session", "list", "--json"], {
      env,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    const parsed = JSON.parse(stdout) as unknown;
    const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as { sessions?: unknown }).sessions : null;
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name.trim())) {
      throw new Error("Invalid Herdr session inventory");
    }
    return parseHerdrSessionListJson(stdout);
  }
}

export const herdrSessionsProbe = defineProbeFamily<string | { env?: RuntimeEnv } | null, HerdrSessionInfo[]>({
  id: "herdr.sessions",
  ttlMs: HERDR_TTL_MS,
  timeoutMs: HERDR_TIMEOUT_MS,
  maxKeys: 8,
  idleKeyTtlMs: 5 * 60_000,
  maxConcurrentKeys: 1,
  normalizeKey: herdrProbeKey,
  run: (key, ctx) => {
    // scoutd answers from ITS environment, so it cannot serve a key that names
    // a different one. It does not serve this family today; asking anyway once
    // it does would silently reintroduce the bug this key was widened to fix.
    if (key !== herdrProbeKey(process.env ? { env: process.env } : null)) {
      return readHerdrSessionsLocal(key, ctx).then((value) => probeRunOutput(value, { backend: "local" }));
    }
    return runWithScoutdFallback({
      probeId: "herdr.sessions",
      key,
      ctx,
      local: () => readHerdrSessionsLocal(key, ctx),
    });
  },
});

/** Preserve probe failures for HTTP readers; the legacy array helper remains tolerant. */
export async function readHerdrSessionsSnapshot(options: { env?: RuntimeEnv; maxAgeMs?: number } = {}): Promise<ProbeSnapshot<HerdrSessionInfo[]>> {
  const handle = herdrSessionsProbe.for({ env: options.env });
  const cached = handle.snapshot();
  const maxAgeMs = options.maxAgeMs ?? HERDR_TTL_MS;
  // fresh() deliberately forces failed probes; passive readers must also cache
  // failure, otherwise an absent executable is spawned on every HTTP request.
  if (cached.error && Date.now() - cached.error.at <= maxAgeMs && maxAgeMs > 0) return cached;
  return handle.fresh({ maxAgeMs });
}

export async function readHerdrSessions(options: { env?: RuntimeEnv; maxAgeMs?: number } = {}): Promise<HerdrSessionInfo[]> {
  const snapshot = await readHerdrSessionsSnapshot(options);
  return snapshot.error ? [] : snapshot.value ?? [];
}

export function invalidateHerdrSessions(options: { env?: RuntimeEnv; reason?: string } = {}): void {
  herdrSessionsProbe.invalidate({ env: options.env }, options.reason);
}

/**
 * Whether the herdr binary is present. Availability is not a capability: herdr
 * may be installed while a given session's server is stopped, in which case the
 * agent-state verbs return nothing rather than failing the host.
 */
export async function isHerdrAvailable(options: { env?: RuntimeEnv } = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.OPENSCOUT_HERDR_BIN?.trim()) return true;
  try {
    const { stdout } = await execProbeFile(
      {
        probeId: "herdr.which",
        signal: AbortSignal.timeout(HERDR_TIMEOUT_MS),
        timeoutMs: HERDR_TIMEOUT_MS,
        startedAt: Date.now(),
      },
      "which",
      ["herdr"],
      { maxStdoutBytes: 4_096, maxStderrBytes: 1_024 },
    );
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session topology projection
//
// Herdr owns workspaces/tabs/panes; Scout reads them. The projection is built
// from the session's three list commands, all of which answer
// `{ id, result: { ... } }` JSON over the socket API. A session whose server
// is stopped answers with connection-refused on stderr and a non-zero exit —
// that projects as `{ running: false, workspaces: [] }`, an ordinary state,
// not an error (the same reasoning as `observedAgents`).

const HERDR_TOPOLOGY_TTL_MS = 2_000;

export type HerdrTopologyRead = { topology: HerdrSessionTopology; availability: "available" | "partial" | "unavailable" };
type HerdrTopologyCacheEntry = { at: number; value: HerdrTopologyRead };
const herdrTopologyPending = new Map<string, Promise<HerdrTopologyRead>>();
const HERDR_TOPOLOGY_CACHE_CAP = 64;
const herdrTopologyCache = new Map<string, HerdrTopologyCacheEntry>();

function herdrTopologyCacheKey(sessionName: string, env: RuntimeEnv): string {
  return `${herdrProbeKey({ env })}|${sessionName}`;
}

function unwrapHerdrResult(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const result = "result" in parsed ? (parsed as { result?: unknown }).result : parsed;
  return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
}

function herdrString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function herdrNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function herdrLayoutRect(value: unknown): HerdrLayoutRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = herdrNumber(record.x);
  const y = herdrNumber(record.y);
  const width = herdrNumber(record.width);
  const height = herdrNumber(record.height);
  return x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null;
}

/**
 * Per-tab layout geometry from `herdr --session <n> api snapshot`
 * (`result.snapshot.layouts[]`), keyed by tab id. Tabs the snapshot does not
 * cover simply project with `layout: null` — geometry is additive, never a
 * reason to drop a tab.
 */
export function parseHerdrSnapshotLayouts(snapshot: string): Map<string, HerdrTabLayout> {
  const result = unwrapHerdrResult(snapshot);
  const snapshotRaw = result && typeof result.snapshot === "object" && result.snapshot !== null
    ? (result.snapshot as Record<string, unknown>)
    : null;
  const layoutsRaw = Array.isArray(snapshotRaw?.layouts) ? (snapshotRaw.layouts as unknown[]) : [];

  const layouts = new Map<string, HerdrTabLayout>();
  for (const entry of layoutsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const tabId = herdrString(record.tab_id);
    const workspaceId = herdrString(record.workspace_id);
    const area = herdrLayoutRect(record.area);
    if (!tabId || !workspaceId || !area) continue;
    const panes = (Array.isArray(record.panes) ? (record.panes as unknown[]) : [])
      .flatMap((pane) => {
        if (!pane || typeof pane !== "object") return [];
        const paneRecord = pane as Record<string, unknown>;
        const paneId = herdrString(paneRecord.pane_id);
        const rect = herdrLayoutRect(paneRecord.rect);
        return paneId && rect ? [{ paneId, focused: paneRecord.focused === true, rect }] : [];
      });
    const splits = (Array.isArray(record.splits) ? (record.splits as unknown[]) : [])
      .flatMap((split) => {
        if (!split || typeof split !== "object") return [];
        const splitRecord = split as Record<string, unknown>;
        const direction = herdrString(splitRecord.direction);
        const narrowed: "right" | "down" | null = direction === "right" || direction === "down" ? direction : null;
        return [{
          id: herdrString(splitRecord.id),
          direction: narrowed,
          ratio: herdrNumber(splitRecord.ratio),
          rect: herdrLayoutRect(splitRecord.rect),
        }];
      });
    layouts.set(tabId, {
      tabId,
      workspaceId,
      area,
      focusedPaneId: herdrString(record.focused_pane_id),
      zoomed: record.zoomed === true,
      panes,
      splits,
    });
  }
  return layouts;
}

/**
 * Build the workspace/tab/pane tree from the three list payloads. Pure, so the
 * mapping is unit-tested against captured 0.7.x output without a herdr server.
 * Unknown agent statuses read as "unknown"; entries without ids are dropped
 * rather than guessed at.
 */
export function parseHerdrTopology(inputs: {
  workspaceList?: string;
  tabList?: string;
  paneList?: string;
  agentList?: string;
  snapshot?: string;
}): HerdrWorkspaceProjection[] {
  const workspaceResult = inputs.workspaceList ? unwrapHerdrResult(inputs.workspaceList) : null;
  const tabResult = inputs.tabList ? unwrapHerdrResult(inputs.tabList) : null;
  const paneResult = inputs.paneList ? unwrapHerdrResult(inputs.paneList) : null;
  const agentResult = inputs.agentList ? unwrapHerdrResult(inputs.agentList) : null;
  const agentsRaw = Array.isArray(agentResult?.agents) ? agentResult.agents : [];
  const namesByTerminal = new Map<string, { paneId: string; name: string }>();
  const duplicateTerminals = new Set<string>();
  for (const entry of agentsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const agent = entry as Record<string, unknown>;
    const terminalId = herdrString(agent.terminal_id);
    const paneId = herdrString(agent.pane_id);
    const name = herdrString(agent.name);
    if (!terminalId || !paneId || !name) continue;
    if (namesByTerminal.has(terminalId)) duplicateTerminals.add(terminalId);
    namesByTerminal.set(terminalId, { paneId, name });
  }
  const layoutsByTab = inputs.snapshot ? parseHerdrSnapshotLayouts(inputs.snapshot) : new Map<string, HerdrTabLayout>();

  const workspacesRaw = Array.isArray(workspaceResult?.workspaces)
    ? (workspaceResult.workspaces as unknown[])
    : [];
  const tabsRaw = Array.isArray(tabResult?.tabs) ? (tabResult.tabs as unknown[]) : [];
  const panesRaw = Array.isArray(paneResult?.panes) ? (paneResult.panes as unknown[]) : [];

  const panesByTab = new Map<string, HerdrPaneProjection[]>();
  for (const entry of panesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const paneId = herdrString(record.pane_id);
    const tabId = herdrString(record.tab_id);
    const workspaceId = herdrString(record.workspace_id);
    if (!paneId || !tabId || !workspaceId) continue;
    const terminalId = herdrString(record.terminal_id);
    // Some Herdr versions expose the assigned name only in agent list. Join
    // by the actual terminal AND pane, never title/cwd or enumeration order.
    // A pane replaced between the two reads must not inherit its old name.
    const namedAgent = terminalId && !duplicateTerminals.has(terminalId) ? namesByTerminal.get(terminalId) : undefined;
    const agentSessionRaw = record.agent_session;
    const agentSession: HerdrAgentSessionRef | null = agentSessionRaw && typeof agentSessionRaw === "object"
      ? (() => {
          const ref = agentSessionRaw as Record<string, unknown>;
          const agent = herdrString(ref.agent);
          const kind = herdrString(ref.kind);
          const source = herdrString(ref.source);
          const value = herdrString(ref.value);
          return agent && kind && source && value ? { agent, kind, source, value } : null;
        })()
      : null;
    const scrollRaw = record.scroll;
    const scrollRecord = scrollRaw && typeof scrollRaw === "object"
      ? (scrollRaw as Record<string, unknown>)
      : null;
    const scroll = scrollRecord
      && typeof scrollRecord.max_offset_from_bottom === "number"
      && typeof scrollRecord.offset_from_bottom === "number"
      && typeof scrollRecord.viewport_rows === "number"
      ? {
          maxOffsetFromBottom: scrollRecord.max_offset_from_bottom,
          offsetFromBottom: scrollRecord.offset_from_bottom,
          viewportRows: scrollRecord.viewport_rows,
        }
      : null;
    const pane: HerdrPaneProjection = {
      paneId,
      terminalId,
      tabId,
      workspaceId,
      // Current herdr reports the title separately and keeps `label` for the
      // name the operator assigned (`--label`, or a rename). Only when a title
      // exists is `label` that name; alone, it is an older herdr's title.
      name: herdrString(record.name)
        ?? (herdrString(record.terminal_title_stripped) ?? herdrString(record.terminal_title)
          ? herdrString(record.label)
          : null)
        ?? (namedAgent?.paneId === paneId ? namedAgent.name : null),
      // herdr reports a pane's human-readable string as its terminal title, not
      // as `label`: `terminal_title` carries the agent's own status glyphs and
      // `terminal_title_stripped` the plain text. Reading `label` alone left
      // every pane nameless, so callers fell back to the pane id and a session
      // full of real work read as "w1:p1, w2:p1, w3:p1".
      label: herdrString(record.terminal_title_stripped)
        ?? herdrString(record.terminal_title)
        ?? herdrString(record.label),
      agent: herdrString(record.agent),
      agentStatus: normalizeHerdrAgentStatus(record.agent_status),
      agentSession,
      cwd: herdrString(record.cwd),
      foregroundCwd: herdrString(record.foreground_cwd),
      focused: record.focused === true,
      scroll,
    };
    const list = panesByTab.get(tabId) ?? [];
    list.push(pane);
    panesByTab.set(tabId, list);
  }

  const tabsByWorkspace = new Map<string, HerdrTabProjection[]>();
  for (const entry of tabsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const tabId = herdrString(record.tab_id);
    const workspaceId = herdrString(record.workspace_id);
    if (!tabId || !workspaceId) continue;
    const tab: HerdrTabProjection = {
      tabId,
      workspaceId,
      label: herdrString(record.label),
      number: herdrNumber(record.number),
      focused: record.focused === true,
      agentStatus: normalizeHerdrAgentStatus(record.agent_status),
      panes: panesByTab.get(tabId) ?? [],
      layout: layoutsByTab.get(tabId) ?? null,
    };
    const list = tabsByWorkspace.get(workspaceId) ?? [];
    list.push(tab);
    tabsByWorkspace.set(workspaceId, list);
  }

  const workspaces: HerdrWorkspaceProjection[] = [];
  for (const entry of workspacesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const workspaceId = herdrString(record.workspace_id);
    if (!workspaceId) continue;
    workspaces.push({
      workspaceId,
      label: herdrString(record.label),
      number: herdrNumber(record.number),
      focused: record.focused === true,
      activeTabId: herdrString(record.active_tab_id),
      agentStatus: normalizeHerdrAgentStatus(record.agent_status),
      tabs: tabsByWorkspace.get(workspaceId) ?? [],
    });
  }
  return workspaces;
}

/**
 * Project a stopped session's persisted `session.json` into the same topology
 * shape a live read produces. Herdr owns the file and may grow or rename any
 * field, so parsing is defensive: anything unreadable is absent, never guessed.
 * Persisted tabs carry no ids and no geometry, so tab ids are synthesized from
 * position (`<workspace>:t<n>`) and `layout` is null; agent status reads
 * "unknown" because a stopped session has no live status to report.
 *
 * Returns null when the value is not a session state at all (caller treats it
 * as "nothing persisted"); a valid state with zero workspaces returns [].
 */
export function parseHerdrPersistedTopology(value: unknown): HerdrWorkspaceProjection[] | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const workspacesRaw = root.workspaces;
  if (!Array.isArray(workspacesRaw)) return null;
  const activeWorkspace = herdrNumber(root.active) ?? herdrNumber(root.selected) ?? 0;

  const workspaces: HerdrWorkspaceProjection[] = [];
  workspacesRaw.forEach((entry, workspaceIndex) => {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const workspaceId = herdrString(record.id) ?? `w${workspaceIndex + 1}`;
    const identityCwd = herdrString(record.identity_cwd);
    const tabsRaw = Array.isArray(record.tabs) ? record.tabs : [];
    const activeTab = herdrNumber(record.active_tab) ?? 0;
    const tabNumbers = Array.isArray(record.public_tab_numbers) ? record.public_tab_numbers : [];

    const tabs: HerdrTabProjection[] = tabsRaw.flatMap((tabEntry, tabIndex) => {
      if (!tabEntry || typeof tabEntry !== "object") return [];
      const tabRecord = tabEntry as Record<string, unknown>;
      const tabId = `${workspaceId}:t${tabIndex + 1}`;
      const focusedPane = herdrNumber(tabRecord.focused);
      const panesRaw = tabRecord.panes && typeof tabRecord.panes === "object"
        ? Object.entries(tabRecord.panes as Record<string, unknown>)
        : [];
      const panes: HerdrPaneProjection[] = panesRaw.flatMap(([paneKey, paneEntry]) => {
        if (!paneEntry || typeof paneEntry !== "object") return [];
        const paneRecord = paneEntry as Record<string, unknown>;
        const agentSessionRaw = paneRecord.agent_session;
        // The agent name alone already answers "what lives here" — keep it even
        // when the ref is partial; the full ref needs every field.
        const agentRef = agentSessionRaw && typeof agentSessionRaw === "object"
          ? agentSessionRaw as Record<string, unknown>
          : null;
        const agentName = agentRef ? herdrString(agentRef.agent) : null;
        const agentSession: HerdrAgentSessionRef | null = (() => {
          if (!agentRef) return null;
          const kind = herdrString(agentRef.kind);
          const source = herdrString(agentRef.source);
          const refValue = herdrString(agentRef.value);
          return agentName && kind && source && refValue
            ? { agent: agentName, kind, source, value: refValue }
            : null;
        })();
        return [{
          paneId: paneKey,
          // Persisted panes have no live terminal id; herdr mints it at start.
          terminalId: null,
          tabId,
          workspaceId,
          name: herdrString(paneRecord.name),
          label: null,
          agent: agentName,
          agentStatus: "unknown" as const,
          agentSession,
          cwd: herdrString(paneRecord.cwd) ?? identityCwd,
          foregroundCwd: null,
          focused: focusedPane !== null && Number(paneKey) === focusedPane,
          scroll: null,
        }];
      });
      return [{
        tabId,
        workspaceId,
        label: herdrString(tabRecord.custom_name),
        number: herdrNumber(tabNumbers[tabIndex]) ?? tabIndex + 1,
        focused: tabIndex === activeTab,
        agentStatus: "unknown" as const,
        panes,
        layout: null,
      }];
    });

    workspaces.push({
      workspaceId,
      label: herdrString(record.custom_name),
      number: workspaceIndex + 1,
      focused: workspaceIndex === activeWorkspace,
      activeTabId: tabs[activeTab]?.tabId ?? tabs[0]?.tabId ?? null,
      agentStatus: "unknown",
      tabs,
    });
  });
  return workspaces;
}

/**
 * The stopped-session projection: the persisted layout from
 * `<sessionDir>/session.json`, stamped with the file's mtime as the session's
 * last known change. Null when there is no readable persisted state — the
 * caller then falls back to the empty projection.
 */
/**
 * Why the live read failed, decided by the session list rather than by parsing
 * an error. A herdr CLI failure carries no stderr through the probe layer, and
 * the session list already answers the only question that matters: does a
 * server for this session exist? If one does and it still did not answer, the
 * projection must not claim the session is stopped.
 */
async function classifyHerdrUnavailable(
  sessionName: string,
  env: RuntimeEnv,
): Promise<{ reason: HerdrTopologyUnavailableReason; sessionDir: string | null }> {
  try {
    const sessions = await readHerdrSessions({ env });
    const session = sessions.find((entry) => entry.name === sessionName);
    return {
      reason: session?.running ? "unreadable" : "not_running",
      sessionDir: session?.sessionDir ?? null,
    };
  } catch {
    return { reason: "not_running", sessionDir: null };
  }
}

async function readPersistedHerdrTopology(
  sessionName: string,
  env: RuntimeEnv,
  unavailable: { reason: HerdrTopologyUnavailableReason; sessionDir: string | null },
): Promise<HerdrSessionTopology | null> {
  try {
    if (!unavailable.sessionDir) return null;
    const path = join(unavailable.sessionDir, "session.json");
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let raw: string, savedAt: number;
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > 512 * 1024) return null;
      // Bound the actual read too: the file can grow after stat.
      const bytes = Buffer.alloc(512 * 1024 + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 512 * 1024) return null;
      raw = bytes.toString("utf8", 0, bytesRead); savedAt = stats.mtimeMs;
    } finally { await file.close(); }
    const workspaces = parseHerdrPersistedTopology(JSON.parse(raw));
    if (workspaces === null) return null;
    return {
      session: sessionName,
      running: false,
      workspaces,
      observedAt: Date.now(),
      savedAt,
      unavailable: unavailable.reason,
    };
  } catch {
    return null;
  }
}
/** Distinct pane directories a live read looks up a branch for; the rest stay absent. */
const HERDR_BRANCH_DIRECTORY_CAP = 32;

function herdrPaneDirectory(pane: { foregroundCwd: string | null; cwd: string | null }): string | null {
  return pane.foregroundCwd ?? pane.cwd;
}

/**
 * The git branch at each pane directory named in a `pane list` payload. Uses
 * the cached `git rev-parse` probe, so a directory is read at most once a
 * minute. A detached HEAD or a directory outside git maps to null; a failed
 * read is left out, so the pane's branch stays absent rather than null.
 */
async function readHerdrPaneBranches(paneList: string): Promise<Map<string, string | null>> {
  const panes = unwrapHerdrResult(paneList)?.panes;
  if (!Array.isArray(panes)) return new Map();
  const directories = [...new Set(panes.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const directory = herdrPaneDirectory({ foregroundCwd: herdrString(record.foreground_cwd), cwd: herdrString(record.cwd) });
    return directory?.startsWith("/") ? [directory] : [];
  }))].slice(0, HERDR_BRANCH_DIRECTORY_CAP);
  const entries = await Promise.all(directories.map(async (directory): Promise<[string, string | null] | null> => {
    try {
      const snapshot = await gitRevParseProbe.for({ repoRoot: directory, kind: "abbrevRefHead" }).fresh({ maxAgeMs: 60_000 });
      // A failed read (a timeout) is not "no branch": leave the pane unread.
      if (snapshot.error && snapshot.value === null) return null;
      const branch = snapshot.value?.trim();
      return [directory, branch && branch !== "HEAD" ? branch : null];
    } catch {
      return null;
    }
  }));
  return new Map(entries.filter((entry): entry is [string, string | null] => entry !== null));
}

/** Set `gitBranch` on every pane whose directory was looked up. */
export function withHerdrPaneBranches(
  workspaces: HerdrWorkspaceProjection[],
  branches: ReadonlyMap<string, string | null>,
): HerdrWorkspaceProjection[] {
  if (branches.size === 0) return workspaces;
  for (const workspace of workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        const directory = herdrPaneDirectory(pane);
        if (directory && branches.has(directory)) pane.gitBranch = branches.get(directory) ?? null;
      }
    }
  }
  return workspaces;
}

async function readHerdrTopologyUncached(sessionName: string, env: RuntimeEnv): Promise<HerdrTopologyRead> {
  const bin = herdrBin(env);
  const exec = (args: string[]) => execSystemFile(bin, ["--session", sessionName, ...args], {
    timeoutMs: HERDR_TIMEOUT_MS,
    env,
    maxStdoutBytes: 512 * 1024,
  });
  try {
    const [workspaceList, tabList, paneList] = await Promise.all(
      (["workspace", "tab", "pane"] as const).map(async (noun) => (await exec([noun, "list"])).stdout),
    );
    // Geometry is additive: an older herdr without `api snapshot` (or a busy
    // one timing out) must not take the whole projection down with it.
    for (const [output, field, ids] of [[workspaceList, "workspaces", ["workspace_id"]], [tabList, "tabs", ["workspace_id", "tab_id"]], [paneList, "panes", ["workspace_id", "tab_id", "pane_id"]]] as const) {
      const entries = unwrapHerdrResult(output)?.[field];
      if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== "object" || ids.some(id => !herdrString(entry[id])))) {
        throw new Error("Invalid Herdr topology inventory");
      }
    }
    // Clients and branches are host facts herdr does not report. Like the
    // geometry, they are additive: failing to read them leaves them absent and
    // does not change the projection's availability.
    const [snapshot, agentList, clients, branches] = await Promise.all([
      exec(["api", "snapshot"]).then((r) => r.stdout).catch(() => undefined),
      exec(["agent", "list"]).then((r) => r.stdout).catch(() => undefined),
      readHerdrSessionClients(sessionName).catch(() => null),
      readHerdrPaneBranches(paneList).catch(() => new Map<string, string | null>()),
    ]);
    const snapshotRoot = snapshot ? unwrapHerdrResult(snapshot)?.snapshot : null;
    const workspaces = withHerdrPaneBranches(parseHerdrTopology({ workspaceList, tabList, paneList, agentList, snapshot }), branches);
    const completeTree = workspaces.length === (unwrapHerdrResult(workspaceList)!.workspaces as unknown[]).length
      && workspaces.reduce((n, w) => n + w.tabs.length, 0) === (unwrapHerdrResult(tabList)!.tabs as unknown[]).length
      && workspaces.reduce((n, w) => n + w.tabs.reduce((n, t) => n + t.panes.length, 0), 0) === (unwrapHerdrResult(paneList)!.panes as unknown[]).length;
    const complete = completeTree && snapshotRoot && typeof snapshotRoot === "object" && Array.isArray((snapshotRoot as Record<string, unknown>).layouts)
      && agentList && Array.isArray(unwrapHerdrResult(agentList)?.agents);
    return { availability: complete ? "available" : "partial", topology: {
      session: sessionName,
      running: true,
      workspaces,
      observedAt: Date.now(),
      ...(clients ? { clients: clients.clients, apps: clients.apps } : {}),
    } };
  } catch {
    // The live read failed. Usually the session's herdr server is simply not
    // running (connection refused) — an ordinary state, and the layout persists
    // on disk, so project that as the last-known topology rather than
    // pretending there is nothing to show. But a RUNNING server can fail the
    // same way (a client/server protocol skew is the common one), and calling
    // that "not running" is a false claim about live work, so the reason is
    // carried on the projection instead of being flattened away.
    const unavailable = await classifyHerdrUnavailable(sessionName, env);
    const persisted = await readPersistedHerdrTopology(sessionName, env, unavailable);
    return { topology: persisted ?? emptyHerdrSessionTopology(sessionName, false, unavailable.reason), availability: persisted ? "partial" : "unavailable" };
  }
}

/**
 * Topology reads are TTL-cached per (environment, session) — the terminals
 * view polls on a few-second cadence and agent status is the only fast-moving
 * part, so a 2s ceiling keeps it live without shelling herdr per render.
 */
export async function readHerdrTopologySnapshot(
  sessionName: string,
  options: { env?: RuntimeEnv; maxAgeMs?: number } = {},
): Promise<HerdrTopologyRead> {
  const session = sessionName.trim();
  if (!session) return { topology: emptyHerdrSessionTopology(session, false), availability: "unavailable" };
  const env = options.env ?? process.env;
  const key = herdrTopologyCacheKey(session, env);
  const cached = herdrTopologyCache.get(key);
  if (cached && Date.now() - cached.at <= (options.maxAgeMs ?? HERDR_TOPOLOGY_TTL_MS)) return cached.value;
  const pending = herdrTopologyPending.get(key);
  if (pending) return pending;
  // Bound cold-key fan-out even when several HTTP requests select different
  // sessions. Do not evict an active read and accidentally spawn it twice.
  for (const [oldKey, entry] of herdrTopologyCache) if (Date.now() - entry.at > HERDR_TOPOLOGY_TTL_MS) herdrTopologyCache.delete(oldKey);
  if (!herdrTopologyCache.has(key) && herdrTopologyCache.size + herdrTopologyPending.size >= HERDR_TOPOLOGY_CACHE_CAP) throw new Error("Herdr topology probe capacity");
  const run = readHerdrTopologyUncached(session, env).then(value => {
    if (herdrTopologyPending.get(key) === run) {
      // Never evict a fresh key to admit another read: that would allow the
      // evicted session to spawn again inside its TTL under query churn.
      herdrTopologyCache.set(key, { at: Date.now(), value });
    }
    return value;
  }).finally(() => { if (herdrTopologyPending.get(key) === run) herdrTopologyPending.delete(key); });
  herdrTopologyPending.set(key, run);
  return run;
}

export async function readHerdrTopology(sessionName: string, options: { env?: RuntimeEnv; maxAgeMs?: number } = {}): Promise<HerdrSessionTopology> {
  return (await readHerdrTopologySnapshot(sessionName, options)).topology;
}

export function invalidateHerdrTopology(
  sessionName?: string,
  options: { env?: RuntimeEnv; reason?: string } = {},
): void {
  void options.reason;
  if (!sessionName) {
    herdrTopologyCache.clear();
    herdrTopologyPending.clear();
    return;
  }
  const suffix = `|${sessionName.trim()}`;
  for (const key of herdrTopologyCache.keys()) if (key.endsWith(suffix)) herdrTopologyCache.delete(key);
  for (const key of herdrTopologyPending.keys()) if (key.endsWith(suffix)) herdrTopologyPending.delete(key);
}
