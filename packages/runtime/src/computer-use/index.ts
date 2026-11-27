/**
 * Scout Computer runtime bridge: resolves the local ScoutComputer helper app,
 * maintains a persistent JSON-RPC WebSocket connection to its supervision agent
 * (for drive leases and HUD notes), manages the off-screen virtual agent layer
 * + PiP viewer, and executes native macOS desktop commands (windows, screenshots,
 * focus, Accessibility inspection, blink/foreground input, OCR) behind structured
 * ComputerReceipts.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import type {
  ComputerActKind,
  ComputerLayerBounds,
  ComputerLayerStatus,
  ComputerReceipt,
  ComputerStatus,
} from "@openscout/protocol";

const execFileAsync = promisify(execFile);

const DEFAULT_AGENT_PORT = 4319;
const HOST_COMMAND_TIMEOUT_MS = 20_000;
const LAYER_STATE_WAIT_MS = 3_000;
const LAYER_CLOSE_WAIT_MS = 3_000;
const LAYER_CONTROL_WAIT_MS = 1_500;
const LAYER_POLL_MS = 40;

export type ScoutComputerAgentRpc = (
  method: string,
  params?: Record<string, string>,
) => Promise<{ ok: boolean; result?: Record<string, string>; error?: string }>;

export type ScoutComputerOptions = {
  binaryPath?: string;
  agentPort?: number;
  agentLayerRoot?: string;
  execImpl?: (file: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
  agentRpcImpl?: ScoutComputerAgentRpc;
  isAliveImpl?: (pid: number) => boolean;
  signalImpl?: (pid: number, signal: NodeJS.Signals) => void;
  /** Require an approved Scout Computer lease for live foreground input when the agent is reachable (default: true). */
  requireDriveLease?: boolean;
};

export type ComputerDriveLeaseSummary = {
  leaseId: string;
  agent?: string;
  task?: string;
  mode?: string;
  status?: string;
  pointerControl?: boolean;
};

export type ComputerTargetSelector = {
  bundleId?: string;
  app?: string;
  pid?: number;
};

export type ComputerLayerOpenOptions = {
  bundleId?: string;
  pid?: number;
  width?: number;
  height?: number;
  pip?: boolean;
  windowId?: number;
  windowTitle?: string;
  owner?: "caller" | "detached";
};

function agentUrlFor(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

export function defaultAgentLayerStateDir(): string {
  return resolvePath(homedir(), "Library/Application Support/Computer/agent-screen");
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function discoverRunningBinary(
  execImpl: (file: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>,
): Promise<string | null> {
  try {
    const { stdout } = await execImpl("/bin/ps", ["-axo", "command="], { timeout: 2_000 });
    for (const rawLine of stdout.split(/\r?\n/)) {
      const match = /^(\/[^\n]*?\/ScoutComputer\.app\/Contents\/MacOS\/ScoutComputer)(?:\s|$)/.exec(rawLine.trim());
      if (match?.[1] && existsSync(match[1])) {
        return match[1];
      }
    }
  } catch {
    // ignore ps failures
  }
  return null;
}

export async function resolveScoutComputerBinary(
  options: ScoutComputerOptions = {},
): Promise<string | null> {
  const execImpl = options.execImpl ?? ((file, args, opts) => execFileAsync(file, args, { ...opts, maxBuffer: 8 * 1024 * 1024 }));
  const direct = [
    options.binaryPath,
    process.env.SCOUT_COMPUTER_BIN,
    "/Applications/ScoutComputer.app/Contents/MacOS/ScoutComputer",
    join(homedir(), "Applications/ScoutComputer.app/Contents/MacOS/ScoutComputer"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of direct) {
    if (existsSync(candidate)) return candidate;
  }
  return discoverRunningBinary(execImpl);
}

function parseJsonOrText(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

interface WindowOrderEntry {
  owner?: string;
  bundleId?: string;
  pid?: number;
  title?: string;
}

interface RawLayerStateFile {
  pid: number;
  displayId?: number;
  bounds?: ComputerLayerBounds;
  pip?: boolean;
  paused?: boolean;
  takenOver?: boolean;
  windows?: Array<{
    windowId?: number;
    pid?: number;
    bundleId?: string;
    title?: string;
    frame?: ComputerLayerBounds;
    originalFrame?: ComputerLayerBounds;
  }>;
}

interface RawLayerRequestFile {
  owner?: "caller" | "detached";
  ownerPid?: number;
  subject?: { bundleId?: string; pid?: number };
  pid?: number;
}

async function resolveTarget(
  target: ComputerTargetSelector | undefined,
  runWindowOrder: () => Promise<WindowOrderEntry[]>,
): Promise<{ pid?: number; bundleId?: string } | { error: string }> {
  if (!target) return {};
  if (target.pid !== undefined) return { pid: target.pid, bundleId: target.bundleId };
  if (target.bundleId) return { bundleId: target.bundleId };
  if (!target.app) return {};

  const needle = target.app.trim().toLowerCase();
  const windows = await runWindowOrder();
  const exact = windows.filter((w) => w.owner?.trim().toLowerCase() === needle);
  const matches = exact.length > 0
    ? exact
    : windows.filter((w) => w.owner?.trim().toLowerCase().includes(needle));

  const first = matches[0];
  if (!first) {
    return {
      error: `No running app window matched '${target.app}'. Call scout_computer_windows to see running apps or pass bundleId/pid.`,
    };
  }
  // Prefer pid when multiple distinct pids share the same bundleId so ScoutComputer never fails with ambiguousApplication.
  const distinctPids = new Set(matches.map((m) => m.pid).filter((p): p is number => typeof p === "number"));
  if (first.bundleId && distinctPids.size <= 1) {
    return { bundleId: first.bundleId, pid: first.pid };
  }
  if (typeof first.pid === "number") {
    return { pid: first.pid, bundleId: first.bundleId };
  }
  return { bundleId: first.bundleId };
}

function appendResolvedTargetArgs(args: string[], resolved: { pid?: number; bundleId?: string }): void {
  if (resolved.pid !== undefined && !resolved.bundleId) {
    args.push("--pid", String(resolved.pid));
  } else if (resolved.bundleId) {
    args.push("--bundle-id", resolved.bundleId);
  } else if (resolved.pid !== undefined) {
    args.push("--pid", String(resolved.pid));
  }
}

function pointInBounds(x: number, y: number, bounds: ComputerLayerBounds | undefined): boolean {
  if (!bounds) return true;
  return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
}

function layerSubjectFromStatus(status: ComputerLayerStatus): { bundleId?: string; pid?: number } | undefined {
  if (status.subject?.bundleId || status.subject?.pid !== undefined) {
    return status.subject;
  }
  const first = status.layer?.windows?.[0];
  if (!first) return undefined;
  return first.bundleId ? { bundleId: first.bundleId } : first.pid !== undefined ? { pid: first.pid } : undefined;
}

export interface ScoutComputerClient {
  status(): Promise<ComputerStatus>;
  driveStatus(): Promise<{ connected: boolean; state: string; leases: ComputerDriveLeaseSummary[] }>;
  driveBegin(options: {
    task: string;
    mode?: "background" | "attention";
    agent?: string;
    sessionId?: string;
    project?: string;
    watchBundleId?: string;
    attentionApproval?: string;
    showSupervisionLabel?: boolean;
    pointerControl?: boolean;
  }): Promise<ComputerReceipt>;
  driveRelease(options: { leaseId: string; outcome?: "done" | "failed" | "cancelled" | string; summary?: string }): Promise<ComputerReceipt>;
  driveNote(options: { line: string; leaseId?: string }): Promise<ComputerReceipt>;
  layerStatus(): Promise<ComputerLayerStatus>;
  layerOpen(options?: ComputerLayerOpenOptions): Promise<ComputerReceipt>;
  layerClose(): Promise<ComputerReceipt>;
  layerSnapshot(options?: { windowId?: number; full?: boolean; out?: string }): Promise<ComputerReceipt>;
  layerPip(): Promise<ComputerReceipt>;
  listWindows(options?: ComputerTargetSelector & { raise?: boolean }): Promise<ComputerReceipt>;
  screenshot(options?: ComputerTargetSelector & {
    windowId?: number;
    region?: { x: number; y: number; width: number; height: number };
    outputPath?: string;
  }): Promise<ComputerReceipt>;
  focus(options: ComputerTargetSelector & { title?: string; launch?: boolean }): Promise<ComputerReceipt>;
  inspect(options: ComputerTargetSelector): Promise<ComputerReceipt>;
  act(options: {
    kind: ComputerActKind;
    target?: ComputerTargetSelector;
    leaseId?: string;
    x?: number;
    y?: number;
    toX?: number;
    toY?: number;
    deltaX?: number;
    deltaY?: number;
    text?: string;
    key?: string;
    modifiers?: string[];
    title?: string;
    role?: string;
    value?: string;
    imagePath?: string;
  }): Promise<ComputerReceipt>;
  close?(): void;
}

const LIVE_INPUT_KINDS = new Set<ComputerActKind>(["click", "type", "key", "scroll", "drag"]);

function parseDriveSnapshot(raw: string | undefined): { state: string; leases: ComputerDriveLeaseSummary[] } {
  if (!raw) return { state: "idle", leases: [] };
  try {
    const parsed = JSON.parse(raw) as { state?: string; leases?: ComputerDriveLeaseSummary[] };
    return {
      state: typeof parsed.state === "string" ? parsed.state : "idle",
      leases: Array.isArray(parsed.leases) ? parsed.leases : [],
    };
  } catch {
    return { state: "idle", leases: [] };
  }
}

function findActiveLease(
  leases: ComputerDriveLeaseSummary[],
  requestedLeaseId?: string,
  requireAttention = false,
): ComputerDriveLeaseSummary | null {
  const active = leases.filter((lease) => {
    if (lease.status !== "driving") return false;
    if (!requireAttention) return true;
    return lease.mode === "attention" || lease.pointerControl === true;
  });
  if (requestedLeaseId) {
    return active.find((lease) => lease.leaseId === requestedLeaseId) ?? null;
  }
  return active[0] ?? null;
}

/**
 * Persistent WebSocket RPC client for ScoutComputerAgent.
 * Keeping the socket open for the client lifetime keeps active drive leases
 * alive until explicitly released or the MCP process exits.
 */
class PersistentAgentRpc {
  private socket?: WebSocket;
  private connectPromise?: Promise<WebSocket | null>;
  private readonly pending = new Map<string, {
    resolve: (value: { ok: boolean; result?: Record<string, string>; error?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly port: number) {}

  async call(
    method: string,
    params: Record<string, string> = {},
  ): Promise<{ ok: boolean; result?: Record<string, string>; error?: string }> {
    const socket = await this.ensureConnected();
    if (!socket) {
      return { ok: false, error: `Scout Computer agent is not reachable at ${agentUrlFor(this.port)}.` };
    }
    const id = `scout-${Date.now()}-${randomUUID().slice(0, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Scout Computer agent at ${agentUrlFor(this.port)} timed out on ${method}.` });
      }, 2_500);
      this.pending.set(id, { resolve, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: (err as Error).message });
      }
    });
  }

  close(): void {
    try {
      this.socket?.close(1000, "Scout Computer client closed");
    } catch {
      // ignore
    }
    this.socket = undefined;
    this.failPending("Scout Computer agent connection closed.");
  }

  private async ensureConnected(): Promise<WebSocket | null> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (!this.connectPromise) {
      this.connectPromise = this.connectOnce().finally(() => {
        this.connectPromise = undefined;
      });
    }
    return this.connectPromise;
  }

  private connectOnce(): Promise<WebSocket | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (socket: WebSocket | null) => {
        if (settled) return;
        settled = true;
        resolve(socket);
      };
      try {
        const socket = new WebSocket(agentUrlFor(this.port));
        const timer = setTimeout(() => {
          try { socket.close(); } catch {}
          done(null);
        }, 1_000);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          this.installSocket(socket);
          done(socket);
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          done(null);
        }, { once: true });
      } catch {
        done(null);
      }
    });
  }

  private installSocket(socket: WebSocket): void {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          id?: string;
          ok?: boolean;
          result?: Record<string, string>;
          error?: string;
        };
        if (!payload.id) return;
        const waiter = this.pending.get(payload.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(payload.id);
        waiter.resolve({
          ok: Boolean(payload.ok),
          result: payload.result,
          error: payload.error,
        });
      } catch {
        // ignore non-matching frames
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.failPending("Scout Computer agent connection closed.");
    });
  }

  private failPending(error: string): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error });
    }
    this.pending.clear();
  }
}

export function createScoutComputerClient(options: ScoutComputerOptions = {}): ScoutComputerClient {
  const agentPort = options.agentPort ?? Number(process.env.SCOUT_COMPUTER_PORT ?? DEFAULT_AGENT_PORT);
  const requireDriveLease = options.requireDriveLease ?? true;
  const layerRoot = options.agentLayerRoot ?? defaultAgentLayerStateDir();
  const execImpl = options.execImpl
    ?? ((file, args, opts) => execFileAsync(file, args, { ...opts, maxBuffer: 8 * 1024 * 1024 }));
  const isAlive = options.isAliveImpl ?? defaultIsAlive;
  const signalProcess = options.signalImpl ?? defaultSignal;

  const persistentRpc = options.agentRpcImpl ? null : new PersistentAgentRpc(agentPort);
  const agentRpc: ScoutComputerAgentRpc = options.agentRpcImpl
    ?? ((method, params) => persistentRpc!.call(method, params));

  function layerPaths() {
    return {
      stop: resolvePath(layerRoot, "layer.stop"),
      state: resolvePath(layerRoot, "state.json"),
      request: resolvePath(layerRoot, "request.json"),
      log: resolvePath(layerRoot, "layer.log"),
      controlRequest: resolvePath(layerRoot, "control.request.json"),
      controlReply: resolvePath(layerRoot, "control.reply.json"),
      handoff: resolvePath(layerRoot, "handoff.json"),
    };
  }

  async function clearLayerFiles(): Promise<void> {
    const paths = layerPaths();
    await Promise.all([
      rm(paths.state, { force: true }),
      rm(paths.request, { force: true }),
      rm(paths.stop, { force: true }),
      rm(paths.controlRequest, { force: true }),
      rm(paths.controlReply, { force: true }),
    ]);
  }

  async function readLayerStatus(): Promise<ComputerLayerStatus> {
    const paths = layerPaths();
    const [request, state, handoff] = await Promise.all([
      readJsonFile<RawLayerRequestFile>(paths.request),
      readJsonFile<RawLayerStateFile>(paths.state),
      readJsonFile<Record<string, unknown>>(paths.handoff),
    ]);
    const owner = request?.owner ?? "caller";
    const pid = state?.pid ?? request?.pid;
    if (!pid) {
      if (state || request) await clearLayerFiles();
      return { active: false, owner, ...(handoff ? { handoff } : {}) };
    }
    if (!isAlive(pid)) {
      await clearLayerFiles();
      return { active: false, owner, ...(handoff ? { handoff } : {}) };
    }
    return {
      active: true,
      owner,
      pid,
      ...(request?.subject ? { subject: request.subject } : {}),
      ...(state ? { layer: state } : {}),
      ...(handoff ? { handoff } : {}),
    };
  }

  async function waitForLayerExit(pid: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await sleep(LAYER_POLL_MS);
    }
    return !isAlive(pid);
  }

  async function closeLayerInternal(): Promise<ComputerLayerStatus> {
    const paths = layerPaths();
    await rm(paths.handoff, { force: true });
    const [request, state] = await Promise.all([
      readJsonFile<RawLayerRequestFile>(paths.request),
      readJsonFile<RawLayerStateFile>(paths.state),
    ]);
    const pid = state?.pid ?? request?.pid;
    const owner = request?.owner ?? "caller";
    if (!pid && !state && !request) {
      return { active: false, owner };
    }
    await mkdir(layerRoot, { recursive: true });
    await writeFile(paths.stop, "stop\n");
    let gone = pid ? await waitForLayerExit(pid, LAYER_CLOSE_WAIT_MS) : true;
    if (!gone && pid) {
      signalProcess(pid, "SIGTERM");
      gone = await waitForLayerExit(pid, 1_500);
    }
    if (gone) {
      await clearLayerFiles();
    }
    return {
      active: !gone,
      owner,
      ...(request?.subject ? { subject: request.subject } : {}),
      ...(gone ? {} : { pid }),
    };
  }

  async function readDriveStatus(): Promise<{ connected: boolean; state: string; leases: ComputerDriveLeaseSummary[] }> {
    const res = await agentRpc("drive.status", {});
    if (!res.ok) {
      return { connected: false, state: "disconnected", leases: [] };
    }
    const snapshot = parseDriveSnapshot(res.result?.snapshot);
    return { connected: true, ...snapshot };
  }

  async function runHost(action: string, subcommand: string, args: string[], leaseId?: string): Promise<ComputerReceipt> {
    const at = Date.now();
    if (process.platform !== "darwin") {
      return {
        source: "scout-computer",
        ok: false,
        action,
        error: "Scout Computer native desktop automation is currently available on macOS.",
        at,
      };
    }
    const bin = await resolveScoutComputerBinary({ ...options, execImpl });
    if (!bin) {
      return {
        source: "scout-computer",
        ok: false,
        action,
        error: "ScoutComputer.app was not found. Start ScoutComputer.app or set SCOUT_COMPUTER_BIN.",
        at,
      };
    }
    try {
      const { stdout } = await execImpl(bin, [subcommand, ...args], { timeout: HOST_COMMAND_TIMEOUT_MS });
      const parsed = parseJsonOrText(stdout);
      const outputPath = typeof (parsed as { outputPath?: unknown })?.outputPath === "string"
        ? (parsed as { outputPath: string }).outputPath
        : undefined;
      return {
        source: "scout-computer",
        ok: true,
        action,
        ...(leaseId ? { leaseId } : {}),
        ...(outputPath ? { outputPath } : {}),
        data: parsed,
        at,
      };
    } catch (error) {
      const err = error as { stderr?: string; stdout?: string; message?: string };
      const detail = err.stderr?.trim() || err.stdout?.trim() || err.message || `ScoutComputer ${subcommand} failed`;
      return {
        source: "scout-computer",
        ok: false,
        action,
        ...(leaseId ? { leaseId } : {}),
        error: detail,
        at,
      };
    }
  }

  async function queryWindowOrder(): Promise<WindowOrderEntry[]> {
    const receipt = await runHost("windows", "window-order", []);
    if (!receipt.ok || !receipt.data || typeof receipt.data !== "object") return [];
    const list = (receipt.data as { windows?: unknown }).windows;
    return Array.isArray(list) ? (list as WindowOrderEntry[]) : [];
  }

  async function resolveSelectorOrError(
    action: string,
    selector?: ComputerTargetSelector,
  ): Promise<{ resolved: { pid?: number; bundleId?: string } } | { receipt: ComputerReceipt }> {
    const resolved = await resolveTarget(selector, queryWindowOrder);
    if ("error" in resolved) {
      return { receipt: { source: "scout-computer", ok: false, action, error: resolved.error, at: Date.now() } };
    }
    return { resolved };
  }

  async function verifyFrontmostTarget(
    action: string,
    resolved: { pid?: number; bundleId?: string },
  ): Promise<ComputerReceipt | null> {
    if (resolved.pid === undefined && !resolved.bundleId) return null;
    const windows = await queryWindowOrder();
    if (!windows.length) return null;
    const frontmost = windows[0]!;
    if (resolved.pid !== undefined && frontmost.pid !== undefined && frontmost.pid !== resolved.pid) {
      return {
        source: "scout-computer",
        ok: false,
        action,
        error: `Scout Computer refused ${action}: target pid ${resolved.pid} is not frontmost (active window is ${frontmost.owner ?? "unknown"} pid ${frontmost.pid}). Focus the target window or open an agent layer with scout_computer_layer_open before sending input.`,
        at: Date.now(),
      };
    }
    if (
      resolved.pid === undefined &&
      resolved.bundleId &&
      frontmost.bundleId &&
      frontmost.bundleId !== resolved.bundleId
    ) {
      return {
        source: "scout-computer",
        ok: false,
        action,
        error: `Scout Computer refused ${action}: target ${resolved.bundleId} is not frontmost (active window is ${frontmost.owner ?? frontmost.bundleId}). Focus the target window or open an agent layer with scout_computer_layer_open before sending input.`,
        at: Date.now(),
      };
    }
    return null;
  }

  return {
    close() {
      persistentRpc?.close();
    },

    async status(): Promise<ComputerStatus> {
      const agentUrl = agentUrlFor(agentPort);
      const [binaryPath, drive, layer] = await Promise.all([
        resolveScoutComputerBinary({ ...options, execImpl }),
        readDriveStatus(),
        readLayerStatus(),
      ]);
      const activeLease = findActiveLease(drive.leases);
      if (!binaryPath) {
        return {
          source: "scout-computer",
          available: false,
          binaryPath: null,
          agentUrl,
          agentConnected: drive.connected,
          driveState: drive.state,
          activeLeaseId: activeLease?.leaseId ?? null,
          layer,
          reason: "ScoutComputer.app was not found. Launch ScoutComputer.app or set SCOUT_COMPUTER_BIN.",
        };
      }
      const permReceipt = await runHost("status", "status", []);
      const permissions = permReceipt.ok && permReceipt.data && typeof permReceipt.data === "object"
        ? (permReceipt.data as ComputerStatus["permissions"])
        : undefined;
      return {
        source: "scout-computer",
        available: true,
        binaryPath,
        agentUrl,
        agentConnected: drive.connected,
        driveState: drive.state,
        activeLeaseId: activeLease?.leaseId ?? null,
        layer,
        permissions,
        reason: drive.connected ? undefined : "ScoutComputer binary found; background agent is not listening on port 4319 yet.",
      };
    },

    async driveStatus() {
      return readDriveStatus();
    },

    async driveBegin(opts): Promise<ComputerReceipt> {
      const at = Date.now();
      const params: Record<string, string> = {
        agent: opts.agent?.trim() || process.env.OPENSCOUT_AGENT?.trim() || "scout",
        task: opts.task.trim(),
        mode: opts.mode ?? "background",
        showSupervisionLabel: opts.showSupervisionLabel === false ? "false" : "true",
      };
      if (opts.sessionId) params.sessionId = opts.sessionId;
      if (opts.project) params.project = opts.project;
      if (opts.watchBundleId) params.watchBundleId = opts.watchBundleId;
      if (opts.attentionApproval) params.attentionApproval = opts.attentionApproval;
      if (opts.pointerControl) params.pointerControl = "true";
      const res = await agentRpc("drive.begin", params);
      if (!res.ok) {
        return {
          source: "scout-computer",
          ok: false,
          action: "drive_begin",
          error: res.error ?? "Scout Computer rejected drive.begin.",
          at,
        };
      }
      const lease = res.result?.lease ? (parseJsonOrText(res.result.lease) as ComputerDriveLeaseSummary) : undefined;
      return {
        source: "scout-computer",
        ok: true,
        action: "drive_begin",
        ...(lease?.leaseId ? { leaseId: lease.leaseId } : {}),
        data: { status: res.result?.status, lease, reason: res.result?.reason },
        at,
      };
    },

    async driveRelease(opts): Promise<ComputerReceipt> {
      const at = Date.now();
      const params: Record<string, string> = { leaseId: opts.leaseId };
      if (opts.outcome) params.outcome = opts.outcome;
      if (opts.summary) params.summary = opts.summary;
      const res = await agentRpc("drive.release", params);
      if (!res.ok) {
        return {
          source: "scout-computer",
          ok: false,
          action: "drive_release",
          leaseId: opts.leaseId,
          error: res.error ?? "Scout Computer failed to release drive lease.",
          at,
        };
      }
      return {
        source: "scout-computer",
        ok: true,
        action: "drive_release",
        leaseId: opts.leaseId,
        data: res.result,
        at,
      };
    },

    async driveNote(opts): Promise<ComputerReceipt> {
      const at = Date.now();
      const line = opts.line.trim();
      if (!line) {
        return { source: "scout-computer", ok: false, action: "drive_note", error: "drive_note requires a non-empty line.", at };
      }
      const params: Record<string, string> = { line };
      if (opts.leaseId) params.leaseId = opts.leaseId;
      const res = await agentRpc("drive.note", params);
      if (!res.ok) {
        return {
          source: "scout-computer",
          ok: false,
          action: "drive_note",
          ...(opts.leaseId ? { leaseId: opts.leaseId } : {}),
          error: res.error ?? "Scout Computer rejected drive.note.",
          at,
        };
      }
      return {
        source: "scout-computer",
        ok: true,
        action: "drive_note",
        ...(opts.leaseId ? { leaseId: opts.leaseId } : {}),
        data: { line, ...(res.result ?? {}) },
        at,
      };
    },

    async layerStatus(): Promise<ComputerLayerStatus> {
      return readLayerStatus();
    },

    async layerOpen(opts: ComputerLayerOpenOptions = {}): Promise<ComputerReceipt> {
      const at = Date.now();
      if (opts.bundleId && opts.pid !== undefined) {
        return { source: "scout-computer", ok: false, action: "layer_open", error: "Pass bundleId or pid, not both.", at };
      }
      if ((opts.width === undefined) !== (opts.height === undefined)) {
        return { source: "scout-computer", ok: false, action: "layer_open", error: "width and height must be provided together.", at };
      }
      const owner = opts.owner ?? "caller";
      const closed = await closeLayerInternal();
      if (closed.active) {
        return {
          source: "scout-computer",
          ok: false,
          action: "layer_open",
          error: `Previous agent layer (pid ${closed.pid}) did not exit; refusing to open another.`,
          at,
        };
      }

      const paths = layerPaths();
      await mkdir(layerRoot, { recursive: true });
      await Promise.all([
        rm(paths.stop, { force: true }),
        rm(paths.state, { force: true }),
        rm(paths.log, { force: true }),
      ]);

      const args = ["--stop-file", paths.stop, "--state-file", paths.state, "--debug-log", paths.log];
      if (owner === "caller") {
        args.push("--parent-pid", String(process.pid));
      }
      if (opts.bundleId) {
        args.push("--bundle-id", opts.bundleId);
      } else if (opts.pid !== undefined) {
        args.push("--pid", String(opts.pid));
      }
      if (opts.width !== undefined && opts.height !== undefined) {
        args.push("--width", String(opts.width), "--height", String(opts.height));
      }
      if (opts.pip !== undefined) {
        args.push("--pip", opts.pip ? "on" : "off");
      }
      if (opts.windowId !== undefined) {
        args.push("--window-id", String(opts.windowId));
      }
      if (opts.windowTitle) {
        args.push("--window-title", opts.windowTitle);
      }

      const launchReceipt = await runHost("layer_open", "agent-screen", args);
      if (!launchReceipt.ok) return launchReceipt;

      const reply = (launchReceipt.data ?? {}) as { status?: string; detail?: string };
      if (reply.status !== "agent-screen-running") {
        return {
          source: "scout-computer",
          ok: false,
          action: "layer_open",
          error: `agent-screen did not start: ${reply.detail ?? reply.status ?? "no reply"}`,
          at,
        };
      }
      const parsedPid = reply.detail ? Number(reply.detail) : Number.NaN;
      const replyPid = Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
      const subject = opts.bundleId
        ? { bundleId: opts.bundleId }
        : opts.pid !== undefined
          ? { pid: opts.pid }
          : undefined;
      const sidecar: RawLayerRequestFile = {
        owner,
        ...(owner === "caller" ? { ownerPid: process.pid } : {}),
        ...(subject ? { subject } : {}),
        ...(replyPid ? { pid: replyPid } : {}),
      };
      await writeFile(paths.request, `${JSON.stringify(sidecar, null, 2)}\n`);

      const deadline = Date.now() + LAYER_STATE_WAIT_MS;
      let state: RawLayerStateFile | null = null;
      while (Date.now() < deadline) {
        state = await readJsonFile<RawLayerStateFile>(paths.state);
        if (state && typeof state.pid === "number") break;
        await sleep(LAYER_POLL_MS);
      }
      if (!state) {
        await closeLayerInternal();
        return {
          source: "scout-computer",
          ok: false,
          action: "layer_open",
          error: "agent-screen replied but never wrote its state file.",
          at,
        };
      }
      if (!sidecar.pid) {
        sidecar.pid = state.pid;
        await writeFile(paths.request, `${JSON.stringify(sidecar, null, 2)}\n`);
      }

      return {
        source: "scout-computer",
        ok: true,
        action: "layer_open",
        data: {
          active: true,
          owner,
          pid: state.pid,
          ...(subject ? { subject } : {}),
          layer: state,
        },
        at,
      };
    },

    async layerClose(): Promise<ComputerReceipt> {
      const at = Date.now();
      const status = await closeLayerInternal();
      return {
        source: "scout-computer",
        ok: !status.active,
        action: "layer_close",
        data: status,
        ...(status.active ? { error: `Agent layer (pid ${status.pid}) is still active.` } : {}),
        at,
      };
    },

    async layerSnapshot(opts = {}): Promise<ComputerReceipt> {
      const at = Date.now();
      const status = await readLayerStatus();
      if (!status.active || !status.layer) {
        return { source: "scout-computer", ok: false, action: "layer_snapshot", error: "No agent layer is up.", at };
      }
      const paths = layerPaths();
      const out = resolvePath(opts.out ?? resolvePath(layerRoot, "snapshots", `layer-${Date.now()}.png`));
      const id = randomUUID();
      await rm(paths.controlReply, { force: true });
      await writeFile(
        paths.controlRequest,
        `${JSON.stringify({
          id,
          op: "snapshot",
          out,
          ...(opts.windowId !== undefined ? { windowId: opts.windowId } : {}),
          full: opts.full === true,
        })}\n`,
      );
      signalProcess(status.layer.pid, "SIGUSR2");

      const deadline = Date.now() + LAYER_CONTROL_WAIT_MS;
      while (Date.now() < deadline) {
        const reply = await readJsonFile<{ id?: string; ok?: boolean; path?: string; detail?: string } & Record<string, unknown>>(
          paths.controlReply,
        );
        if (reply?.id === id) {
          const { id: _id, ...result } = reply;
          if (!result.ok) {
            return {
              source: "scout-computer",
              ok: false,
              action: "layer_snapshot",
              error: `agent-screen snapshot failed: ${result.detail ?? "no detail"}`,
              at,
            };
          }
          return {
            source: "scout-computer",
            ok: true,
            action: "layer_snapshot",
            outputPath: typeof result.path === "string" ? result.path : out,
            data: result,
            at,
          };
        }
        await sleep(10);
      }
      return { source: "scout-computer", ok: false, action: "layer_snapshot", error: "agent-screen did not answer snapshot.", at };
    },

    async layerPip(): Promise<ComputerReceipt> {
      const at = Date.now();
      const status = await readLayerStatus();
      if (!status.active || !status.layer) {
        return { source: "scout-computer", ok: false, action: "layer_pip", error: "No agent layer is up.", at };
      }
      if (!status.layer.pip) {
        signalProcess(status.layer.pid, "SIGUSR1");
        const deadline = Date.now() + 1_000;
        while (Date.now() < deadline) {
          await sleep(50);
          const next = await readLayerStatus();
          if (next.layer?.pip) {
            return { source: "scout-computer", ok: true, action: "layer_pip", data: next, at };
          }
        }
      }
      return { source: "scout-computer", ok: true, action: "layer_pip", data: await readLayerStatus(), at };
    },

    async listWindows(opts = {}): Promise<ComputerReceipt> {
      if (!opts.bundleId && !opts.app && opts.pid === undefined) {
        return runHost("windows", "window-order", []);
      }
      const res = await resolveSelectorOrError("windows", opts);
      if ("receipt" in res) return res.receipt;
      const args: string[] = [];
      appendResolvedTargetArgs(args, res.resolved);
      if (opts.raise) args.push("--raise", "true");
      return runHost("windows", "list-app-windows", args);
    },

    async screenshot(opts = {}): Promise<ComputerReceipt> {
      const outputPath = opts.outputPath?.trim() || join(tmpdir(), `scout-computer-${Date.now()}.png`);
      if (opts.region) {
        return runHost("screenshot", "screenshot-region", [
          "--x", String(opts.region.x),
          "--y", String(opts.region.y),
          "--width", String(opts.region.width),
          "--height", String(opts.region.height),
          "--output", outputPath,
        ]);
      }
      if (opts.bundleId || opts.app || opts.pid !== undefined) {
        const res = await resolveSelectorOrError("screenshot", opts);
        if ("receipt" in res) return res.receipt;
        const args: string[] = [];
        appendResolvedTargetArgs(args, res.resolved);
        if (opts.windowId !== undefined) args.push("--window-id", String(opts.windowId));
        args.push("--output", outputPath);
        return runHost("screenshot", "screenshot-app-window", args);
      }
      return runHost("screenshot", "screenshot-screen", ["--output", outputPath]);
    },

    async focus(opts): Promise<ComputerReceipt> {
      if (opts.launch && opts.bundleId) {
        return runHost("focus", "launch-app", ["--bundle-id", opts.bundleId]);
      }
      const res = await resolveSelectorOrError("focus", opts);
      if ("receipt" in res) return res.receipt;
      const args: string[] = [];
      appendResolvedTargetArgs(args, res.resolved);
      if (opts.title) {
        args.push("--title", opts.title);
        return runHost("focus", "focus-window", args);
      }
      return runHost("focus", "activate-app", args);
    },

    async inspect(opts): Promise<ComputerReceipt> {
      const res = await resolveSelectorOrError("inspect", opts);
      if ("receipt" in res) return res.receipt;
      const args: string[] = [];
      appendResolvedTargetArgs(args, res.resolved);
      return runHost("inspect", "inspect-app-ui", args);
    },

    async act(opts): Promise<ComputerReceipt> {
      const args: string[] = [];
      let activeLeaseId: string | undefined;

      // Check whether this act routes as an off-screen blink act on the active agent layer.
      const layerStatus = await readLayerStatus();
      const layerSubject = layerStatus.active ? layerSubjectFromStatus(layerStatus) : undefined;
      const canBlinkClick = Boolean(
        layerStatus.active
          && opts.kind === "click"
          && opts.x !== undefined
          && opts.y !== undefined
          && pointInBounds(opts.x, opts.y, layerStatus.layer?.bounds),
      );
      const explicitTarget = opts.target?.bundleId || opts.target?.pid !== undefined || opts.target?.app;
      const matchesLayerSubject = Boolean(
        layerSubject
          && (!explicitTarget
            || (opts.target?.bundleId && opts.target.bundleId === layerSubject.bundleId)
            || (opts.target?.pid !== undefined && opts.target.pid === layerSubject.pid)),
      );
      const canBlinkKeyboard = Boolean(
        layerStatus.active
          && (opts.kind === "type" || opts.kind === "key")
          && matchesLayerSubject
          && (opts.target?.bundleId || opts.target?.pid !== undefined || layerSubject?.bundleId || layerSubject?.pid !== undefined),
      );
      const isBlinkAct = canBlinkClick || canBlinkKeyboard;

      if (isBlinkAct && layerStatus.layer?.paused) {
        return {
          source: "scout-computer",
          ok: false,
          action: opts.kind,
          error: "Scout Computer agent layer is paused by the operator; wait until resumed before acting.",
          at: Date.now(),
        };
      }
      if (isBlinkAct && layerStatus.layer?.takenOver) {
        return {
          source: "scout-computer",
          ok: false,
          action: opts.kind,
          error: "Operator took over the Scout Computer agent layer; stop and call scout_computer_layer_close to acknowledge.",
          at: Date.now(),
        };
      }

      // Require an approved Scout Computer lease before live input:
      // - Blink acts on the agent layer are allowed under any active lease (background or attention).
      // - Foreground acts on the user's live desktop require an approved attention/pointerControl lease.
      if (LIVE_INPUT_KINDS.has(opts.kind) && requireDriveLease) {
        const drive = await readDriveStatus();
        if (drive.connected) {
          const lease = findActiveLease(drive.leases, opts.leaseId, !isBlinkAct);
          if (!lease) {
            return {
              source: "scout-computer",
              ok: false,
              action: opts.kind,
              error: isBlinkAct
                ? `Scout Computer blocked ${opts.kind}: call scout_computer_drive_begin first to hold an active drive lease.`
                : `Scout Computer blocked ${opts.kind}: foreground desktop input requires an approved Scout Computer attention lease (or move the app off-screen with scout_computer_layer_open).`,
              at: Date.now(),
            };
          }
          activeLeaseId = lease.leaseId;
          await agentRpc("drive.touch", {
            leaseId: lease.leaseId,
            axTier: isBlinkAct ? "blink" : "attention",
            ...(opts.target?.bundleId ? { watchBundleId: opts.target.bundleId } : {}),
            watchActivity: `Scout Computer · ${opts.kind}`,
          });
        }
      }

      switch (opts.kind) {
        case "click": {
          if (opts.x === undefined || opts.y === undefined) {
            return { source: "scout-computer", ok: false, action: "click", error: "click requires x and y coordinates.", at: Date.now() };
          }
          if (canBlinkClick) {
            return runHost("click", "blink-click", ["--x", String(opts.x), "--y", String(opts.y)], activeLeaseId);
          }
          if (opts.target) {
            const res = await resolveSelectorOrError("click", opts.target);
            if ("receipt" in res) return res.receipt;
            const mismatch = await verifyFrontmostTarget("click", res.resolved);
            if (mismatch) return mismatch;
          }
          return runHost("click", "click-point", ["--x", String(opts.x), "--y", String(opts.y)], activeLeaseId);
        }
        case "type": {
          if (opts.text === undefined) {
            return { source: "scout-computer", ok: false, action: "type", error: "type requires text.", at: Date.now() };
          }
          if (canBlinkKeyboard) {
            const blinkTarget = opts.target?.bundleId || opts.target?.pid !== undefined
              ? { bundleId: opts.target.bundleId, pid: opts.target.pid }
              : layerSubject!;
            const targetArgs: string[] = [];
            appendResolvedTargetArgs(targetArgs, blinkTarget);
            return runHost("type", "blink-type", [...targetArgs, "--text", opts.text], activeLeaseId);
          }
          if (!opts.target?.bundleId && !opts.target?.app && opts.target?.pid === undefined) {
            return {
              source: "scout-computer",
              ok: false,
              action: "type",
              error: "Scout Computer refused type: pass target (app, bundleId, or pid) so text cannot land in the wrong window.",
              at: Date.now(),
            };
          }
          const res = await resolveSelectorOrError("type", opts.target);
          if ("receipt" in res) return res.receipt;
          const mismatch = await verifyFrontmostTarget("type", res.resolved);
          if (mismatch) return mismatch;
          const targetArgs: string[] = [];
          appendResolvedTargetArgs(targetArgs, res.resolved);
          return runHost("type", "type-app-text", [...targetArgs, "--text", opts.text], activeLeaseId);
        }
        case "key": {
          if (!opts.key) {
            return { source: "scout-computer", ok: false, action: "key", error: "key requires a key name.", at: Date.now() };
          }
          if (opts.modifiers?.length) args.push("--modifiers", opts.modifiers.join(","));
          if (canBlinkKeyboard) {
            const blinkTarget = opts.target?.bundleId || opts.target?.pid !== undefined
              ? { bundleId: opts.target.bundleId, pid: opts.target.pid }
              : layerSubject!;
            const targetArgs: string[] = [];
            appendResolvedTargetArgs(targetArgs, blinkTarget);
            return runHost("key", "blink-key", [...targetArgs, "--key", opts.key, ...args], activeLeaseId);
          }
          if (!opts.target?.bundleId && !opts.target?.app && opts.target?.pid === undefined) {
            return {
              source: "scout-computer",
              ok: false,
              action: "key",
              error: "Scout Computer refused key: pass target (app, bundleId, or pid) so keystrokes cannot land in the wrong window.",
              at: Date.now(),
            };
          }
          const res = await resolveSelectorOrError("key", opts.target);
          if ("receipt" in res) return res.receipt;
          const mismatch = await verifyFrontmostTarget("key", res.resolved);
          if (mismatch) return mismatch;
          const targetArgs: string[] = [];
          appendResolvedTargetArgs(targetArgs, res.resolved);
          return runHost("key", "press-app-key", [...targetArgs, "--key", opts.key, ...args], activeLeaseId);
        }
        case "scroll": {
          if (opts.target) {
            const res = await resolveSelectorOrError("scroll", opts.target);
            if ("receipt" in res) return res.receipt;
            const mismatch = await verifyFrontmostTarget("scroll", res.resolved);
            if (mismatch) return mismatch;
          }
          if (opts.deltaY !== undefined) args.push("--delta-y", String(opts.deltaY));
          if (opts.deltaX !== undefined) args.push("--delta-x", String(opts.deltaX));
          if (opts.x !== undefined) args.push("--x", String(opts.x));
          if (opts.y !== undefined) args.push("--y", String(opts.y));
          return runHost("scroll", "scroll", args, activeLeaseId);
        }
        case "drag": {
          if (opts.x === undefined || opts.y === undefined || opts.toX === undefined || opts.toY === undefined) {
            return { source: "scout-computer", ok: false, action: "drag", error: "drag requires x, y, toX, and toY.", at: Date.now() };
          }
          if (opts.target) {
            const res = await resolveSelectorOrError("drag", opts.target);
            if ("receipt" in res) return res.receipt;
            const mismatch = await verifyFrontmostTarget("drag", res.resolved);
            if (mismatch) return mismatch;
          }
          return runHost("drag", "drag", [
            "--from-x", String(opts.x),
            "--from-y", String(opts.y),
            "--to-x", String(opts.toX),
            "--to-y", String(opts.toY),
          ], activeLeaseId);
        }
        case "ax_press": {
          const res = await resolveSelectorOrError("ax_press", opts.target);
          if ("receipt" in res) return res.receipt;
          if (!res.resolved.bundleId && res.resolved.pid === undefined) {
            return { source: "scout-computer", ok: false, action: "ax_press", error: "ax_press requires bundleId, pid, or a running app name.", at: Date.now() };
          }
          appendResolvedTargetArgs(args, res.resolved);
          if (opts.title) args.push("--label", opts.title);
          if (opts.role) args.push("--role", opts.role);
          return runHost("ax_press", "press-accessibility-element", args, activeLeaseId);
        }
        case "ax_set": {
          const res = await resolveSelectorOrError("ax_set", opts.target);
          if ("receipt" in res) return res.receipt;
          if (!res.resolved.bundleId && res.resolved.pid === undefined) {
            return { source: "scout-computer", ok: false, action: "ax_set", error: "ax_set requires bundleId, pid, or a running app name.", at: Date.now() };
          }
          appendResolvedTargetArgs(args, res.resolved);
          if (opts.title) args.push("--label", opts.title);
          if (opts.role) args.push("--role", opts.role);
          if (opts.value !== undefined) args.push("--value", opts.value);
          return runHost("ax_set", "set-accessibility-value", args, activeLeaseId);
        }
        case "ocr":
          if (!opts.imagePath) {
            return { source: "scout-computer", ok: false, action: "ocr", error: "ocr requires imagePath.", at: Date.now() };
          }
          return runHost("ocr", "ocr-screenshot", ["--input", opts.imagePath]);
      }
    },
  };
}
