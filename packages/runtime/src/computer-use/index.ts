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

export type ScoutComputerOptions = {
  binaryPath?: string;
  agentPort?: number;
  execImpl?: (file: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
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

export function createScoutComputerClient(options: ScoutComputerOptions = {}): ScoutComputerClient {
  const agentPort = options.agentPort ?? Number(process.env.SCOUT_COMPUTER_PORT ?? DEFAULT_AGENT_PORT);
  const execImpl = options.execImpl
    ?? ((file, args, opts) => execFileAsync(file, args, { ...opts, maxBuffer: 8 * 1024 * 1024 }));

  async function probeAgent(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const socket = new WebSocket(agentUrlFor(agentPort));
        const timer = setTimeout(() => {
          try { socket.close(); } catch {}
          done(false);
        }, 1_200);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          try { socket.close(); } catch {}
          done(true);
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          done(false);
        }, { once: true });
      } catch {
        done(false);
      }
    });
  }

  async function runHost(action: string, subcommand: string, args: string[]): Promise<ComputerReceipt> {
    const at = Date.now();
    if (process.platform !== "darwin") {
      return {
        ok: false,
        action,
        error: "Scout Computer native desktop automation is currently available on macOS.",
        at,
      };
    }
    const bin = await resolveScoutComputerBinary({ ...options, execImpl });
    if (!bin) {
      return {
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
        ok: true,
        action,
        ...(outputPath ? { outputPath } : {}),
        data: parsed,
        at,
      };
    } catch (error) {
      const err = error as { stderr?: string; stdout?: string; message?: string };
      const detail = err.stderr?.trim() || err.stdout?.trim() || err.message || `ScoutComputer ${subcommand} failed`;
      return {
        ok: false,
        action,
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
      return { receipt: { ok: false, action, error: resolved.error, at: Date.now() } };
    }
    return { resolved };
  }

  return {
    async status(): Promise<ComputerStatus> {
      const agentUrl = agentUrlFor(agentPort);
      const [binaryPath, agentConnected] = await Promise.all([
        resolveScoutComputerBinary({ ...options, execImpl }),
        probeAgent(),
      ]);
      if (!binaryPath) {
        return {
          available: false,
          binaryPath: null,
          agentUrl,
          agentConnected,
          reason: "ScoutComputer.app was not found. Launch ScoutComputer.app or set SCOUT_COMPUTER_BIN.",
        };
      }
      const permReceipt = await runHost("status", "status", []);
      const permissions = permReceipt.ok && permReceipt.data && typeof permReceipt.data === "object"
        ? (permReceipt.data as ComputerStatus["permissions"])
        : undefined;
      return {
        available: true,
        binaryPath,
        agentUrl,
        agentConnected,
        permissions,
        reason: agentConnected ? undefined : "ScoutComputer binary found; background agent is not listening on port 4319 yet.",
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
      switch (opts.kind) {
        case "click":
          if (opts.x === undefined || opts.y === undefined) {
            return { ok: false, action: "click", error: "click requires x and y coordinates.", at: Date.now() };
          }
          return runHost("click", "click-point", ["--x", String(opts.x), "--y", String(opts.y)]);
        case "type": {
          if (opts.text === undefined) {
            return { ok: false, action: "type", error: "type requires text.", at: Date.now() };
          }
          if (opts.target?.bundleId || opts.target?.app) {
            const res = await resolveSelectorOrError("type", opts.target);
            if ("receipt" in res) return res.receipt;
            if (res.resolved.bundleId) {
              return runHost("type", "type-app-text", ["--bundle-id", res.resolved.bundleId, "--text", opts.text]);
            }
          }
          return runHost("type", "type-text", ["--text", opts.text]);
        }
        case "key": {
          if (!opts.key) {
            return { ok: false, action: "key", error: "key requires a key name.", at: Date.now() };
          }
          if (opts.modifiers?.length) args.push("--modifiers", opts.modifiers.join(","));
          if (opts.target?.bundleId || opts.target?.app) {
            const res = await resolveSelectorOrError("key", opts.target);
            if ("receipt" in res) return res.receipt;
            if (res.resolved.bundleId) {
              return runHost("key", "press-app-key", ["--bundle-id", res.resolved.bundleId, "--key", opts.key, ...args]);
            }
          }
          return runHost("key", "press-key", ["--key", opts.key, ...args]);
        }
        case "scroll":
          if (opts.deltaY !== undefined) args.push("--delta-y", String(opts.deltaY));
          if (opts.deltaX !== undefined) args.push("--delta-x", String(opts.deltaX));
          if (opts.x !== undefined) args.push("--x", String(opts.x));
          if (opts.y !== undefined) args.push("--y", String(opts.y));
          return runHost("scroll", "scroll", args);
        case "drag":
          if (opts.x === undefined || opts.y === undefined || opts.toX === undefined || opts.toY === undefined) {
            return { ok: false, action: "drag", error: "drag requires x, y, toX, and toY.", at: Date.now() };
          }
          return runHost("drag", "drag", [
            "--from-x", String(opts.x),
            "--from-y", String(opts.y),
            "--to-x", String(opts.toX),
            "--to-y", String(opts.toY),
          ]);
        case "ax_press": {
          const res = await resolveSelectorOrError("ax_press", opts.target);
          if ("receipt" in res) return res.receipt;
          if (!res.resolved.bundleId) {
            return { ok: false, action: "ax_press", error: "ax_press requires bundleId or a running app name.", at: Date.now() };
          }
          args.push("--bundle-id", res.resolved.bundleId);
          if (opts.title) args.push("--label", opts.title);
          if (opts.role) args.push("--role", opts.role);
          return runHost("ax_press", "press-accessibility-element", args);
        }
        case "ax_set": {
          const res = await resolveSelectorOrError("ax_set", opts.target);
          if ("receipt" in res) return res.receipt;
          if (!res.resolved.bundleId) {
            return { ok: false, action: "ax_set", error: "ax_set requires bundleId or a running app name.", at: Date.now() };
          }
          args.push("--bundle-id", res.resolved.bundleId);
          if (opts.title) args.push("--label", opts.title);
          if (opts.role) args.push("--role", opts.role);
          if (opts.value !== undefined) args.push("--value", opts.value);
          return runHost("ax_set", "set-accessibility-value", args);
        }
        case "ocr":
          if (!opts.imagePath) {
            return { ok: false, action: "ocr", error: "ocr requires imagePath.", at: Date.now() };
          }
          return runHost("ocr", "ocr-screenshot", ["--input", opts.imagePath]);
      }
    },
  };
}
