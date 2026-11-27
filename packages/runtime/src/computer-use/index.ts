/**
 * Scout Computer runtime bridge: resolves the local ScoutComputer helper app,
 * checks its agent WebSocket status (without ever spawning a duplicate listener),
 * and executes native macOS desktop commands (windows, screenshots, focus,
 * Accessibility inspection, input, OCR) behind structured ComputerReceipts.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ComputerActKind, ComputerReceipt, ComputerStatus } from "@openscout/protocol";

const execFileAsync = promisify(execFile);

const DEFAULT_AGENT_PORT = 4319;
const HOST_COMMAND_TIMEOUT_MS = 20_000;

export type ScoutComputerAgentRpc = (
  method: string,
  params?: Record<string, string>,
) => Promise<{ ok: boolean; result?: Record<string, string>; error?: string }>;

export type ScoutComputerOptions = {
  binaryPath?: string;
  agentPort?: number;
  execImpl?: (file: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
  agentRpcImpl?: ScoutComputerAgentRpc;
  /** Require an approved Scout Computer attention lease for live input when the agent is reachable (default: true). */
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

function agentUrlFor(port: number): string {
  return `ws://127.0.0.1:${port}`;
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
      error: `No running app window matched '${target.app}'. Call computer_windows to see running apps or pass bundleId/pid.`,
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

export interface ScoutComputerClient {
  status(): Promise<ComputerStatus>;
  driveStatus(): Promise<{ connected: boolean; state: string; leases: ComputerDriveLeaseSummary[] }>;
  driveBegin(options: {
    task: string;
    mode?: "background" | "attention";
    agent?: string;
    watchBundleId?: string;
    attentionApproval?: string;
    pointerControl?: boolean;
  }): Promise<ComputerReceipt>;
  driveRelease(options: { leaseId: string; outcome?: string; summary?: string }): Promise<ComputerReceipt>;
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

function findActiveAttentionLease(
  leases: ComputerDriveLeaseSummary[],
  requestedLeaseId?: string,
): ComputerDriveLeaseSummary | null {
  const active = leases.filter(
    (lease) =>
      lease.status === "driving" &&
      (lease.mode === "attention" || lease.pointerControl === true),
  );
  if (requestedLeaseId) {
    return active.find((lease) => lease.leaseId === requestedLeaseId) ?? null;
  }
  return active[0] ?? null;
}

export function createScoutComputerClient(options: ScoutComputerOptions = {}): ScoutComputerClient {
  const agentPort = options.agentPort ?? Number(process.env.SCOUT_COMPUTER_PORT ?? DEFAULT_AGENT_PORT);
  const requireDriveLease = options.requireDriveLease ?? true;
  const execImpl = options.execImpl
    ?? ((file, args, opts) => execFileAsync(file, args, { ...opts, maxBuffer: 8 * 1024 * 1024 }));

  async function defaultAgentRpc(
    method: string,
    params: Record<string, string> = {},
  ): Promise<{ ok: boolean; result?: Record<string, string>; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: { ok: boolean; result?: Record<string, string>; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const id = `scout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const socket = new WebSocket(agentUrlFor(agentPort));
        const timer = setTimeout(() => {
          try { socket.close(); } catch {}
          done({ ok: false, error: `Scout Computer agent at ${agentUrlFor(agentPort)} timed out on ${method}.` });
        }, 2_000);
        socket.addEventListener("open", () => {
          try {
            socket.send(JSON.stringify({ id, method, params }));
          } catch (err) {
            clearTimeout(timer);
            try { socket.close(); } catch {}
            done({ ok: false, error: (err as Error).message });
          }
        }, { once: true });
        socket.addEventListener("message", (event) => {
          try {
            const payload = JSON.parse(String(event.data)) as {
              id?: string;
              ok?: boolean;
              result?: Record<string, string>;
              error?: string;
            };
            if (payload.id && payload.id !== id) return;
            clearTimeout(timer);
            try { socket.close(); } catch {}
            done({
              ok: Boolean(payload.ok),
              result: payload.result,
              error: payload.error,
            });
          } catch {
            // ignore non-matching frames
          }
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          done({ ok: false, error: `Scout Computer agent is not reachable at ${agentUrlFor(agentPort)}.` });
        }, { once: true });
      } catch (err) {
        done({ ok: false, error: (err as Error).message });
      }
    });
  }

  const agentRpc: ScoutComputerAgentRpc = options.agentRpcImpl ?? defaultAgentRpc;

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
        error: `Scout Computer refused ${action}: target pid ${resolved.pid} is not frontmost (active window is ${frontmost.owner ?? "unknown"} pid ${frontmost.pid}). Focus the target window before sending input.`,
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
        error: `Scout Computer refused ${action}: target ${resolved.bundleId} is not frontmost (active window is ${frontmost.owner ?? frontmost.bundleId}). Focus the target window before sending input.`,
        at: Date.now(),
      };
    }
    return null;
  }

  return {
    async status(): Promise<ComputerStatus> {
      const agentUrl = agentUrlFor(agentPort);
      const [binaryPath, drive] = await Promise.all([
        resolveScoutComputerBinary({ ...options, execImpl }),
        readDriveStatus(),
      ]);
      const activeLease = findActiveAttentionLease(drive.leases);
      if (!binaryPath) {
        return {
          source: "scout-computer",
          available: false,
          binaryPath: null,
          agentUrl,
          agentConnected: drive.connected,
          driveState: drive.state,
          activeLeaseId: activeLease?.leaseId ?? null,
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
        agent: opts.agent?.trim() || "scout",
        task: opts.task.trim(),
        mode: opts.mode ?? "attention",
        showSupervisionLabel: "true",
      };
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

      // Require an approved Scout Computer drive lease before any live
      // keyboard/pointer injection, and keep the Scout supervision HUD updated.
      if (LIVE_INPUT_KINDS.has(opts.kind) && requireDriveLease) {
        const drive = await readDriveStatus();
        if (drive.connected) {
          const lease = findActiveAttentionLease(drive.leases, opts.leaseId);
          if (!lease) {
            return {
              source: "scout-computer",
              ok: false,
              action: opts.kind,
              error: `Scout Computer blocked ${opts.kind}: foreground desktop input requires an approved Scout Computer attention lease. Approve a drive lease in Scout Computer first.`,
              at: Date.now(),
            };
          }
          activeLeaseId = lease.leaseId;
          await agentRpc("drive.touch", {
            leaseId: lease.leaseId,
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
          if (!opts.target?.bundleId && !opts.target?.app && opts.target?.pid === undefined) {
            return {
              source: "scout-computer",
              ok: false,
              action: "key",
              error: "Scout Computer refused key: pass target (app, bundleId, or pid) so keystrokes cannot land in the wrong window.",
              at: Date.now(),
            };
          }
          if (opts.modifiers?.length) args.push("--modifiers", opts.modifiers.join(","));
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
