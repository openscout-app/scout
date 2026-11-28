// Mobile Remote — macOS host control over Scout's encrypted pairing bridge.
//
// Trusted paired iOS and watchOS devices already authenticate over LAN,
// Tailscale, and Scout Relay (OSN). These handlers expose keyboard, text
// insertion, trackpad, screen preview, app switching, image paste, and optional
// host dictation on that same encrypted bridge — no separate pairing flow.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MobileRemoteModifier = "command" | "control" | "option" | "shift";

export type MobileRemoteTrackpadEvent =
  | "move"
  | "click"
  | "rightClick"
  | "doubleClick"
  | "scroll";

export type MobileRemoteDictateAction =
  | "start"
  | "stop"
  | "cancel"
  | "toggle"
  | "status";

export interface MobileRemoteApp {
  name: string;
  bundleId: string | null;
  pid: number;
  active: boolean;
  windowTitle?: string | null;
}

export interface MobileRemoteState {
  ok: boolean;
  host: string;
  platform: string;
  frontmostApp: MobileRemoteApp | null;
  capabilities: {
    keyboard: boolean;
    trackpad: boolean;
    screen: boolean;
    apps: boolean;
    insertText: boolean;
    pasteImage: boolean;
    hostDictation: boolean;
  };
  hostDictation: {
    available: boolean;
    state: string | null;
  };
}

export interface MobileRemoteActionResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface MobileRemoteScreenFrame {
  ok: boolean;
  mimeType: string;
  width: number;
  height: number;
  base64: string;
  capturedAt: number;
  error?: string;
}

export interface MobileRemoteAppsResult {
  ok: boolean;
  apps: MobileRemoteApp[];
  error?: string;
}

export interface MobileRemotePasteImageResult {
  ok: boolean;
  path?: string;
  pasted: boolean;
  error?: string;
}

export interface MobileRemoteDictateResult {
  ok: boolean;
  available: boolean;
  state?: string;
  detail?: string;
  error?: string;
}

export interface AppleScriptKeySpec {
  kind: "keyCode" | "keystroke";
  code?: number;
  char?: string;
  modifiers: string[];
}

const MAX_REMOTE_TEXT_LENGTH = 16_384;
const MAX_PASTE_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_SCREEN_WIDTH = 320;
const MAX_SCREEN_WIDTH = 1440;
const DEFAULT_SCREEN_WIDTH = 960;
const MAX_TRACKPAD_DELTA = 2_400;

const NAMED_KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  forwarddelete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
};

const MODIFIER_MAP: Record<MobileRemoteModifier, string> = {
  command: "command down",
  control: "control down",
  option: "option down",
  shift: "shift down",
};

const ALLOWED_IMAGE_MIMES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
};

export function clampScreenMaxWidth(maxWidth?: number): number {
  if (typeof maxWidth !== "number" || !Number.isFinite(maxWidth)) {
    return DEFAULT_SCREEN_WIDTH;
  }
  return Math.max(MIN_SCREEN_WIDTH, Math.min(MAX_SCREEN_WIDTH, Math.round(maxWidth)));
}

export function clampTrackpadDelta(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-MAX_TRACKPAD_DELTA, Math.min(MAX_TRACKPAD_DELTA, value));
}

export function resolveAppleScriptKeySpec(
  rawKey: string,
  rawModifiers?: readonly string[],
): AppleScriptKeySpec | null {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;

  const modifiers: string[] = [];
  for (const mod of rawModifiers ?? []) {
    const normalized = mod.trim().toLowerCase() as MobileRemoteModifier;
    const mapped = MODIFIER_MAP[normalized];
    if (mapped && !modifiers.includes(mapped)) {
      modifiers.push(mapped);
    }
  }

  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED_KEY_CODES, lower)) {
    return {
      kind: "keyCode",
      code: NAMED_KEY_CODES[lower],
      modifiers,
    };
  }

  const chars = Array.from(trimmed);
  if (chars.length === 1) {
    const ch = chars[0]!;
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && codePoint !== 0x7f) {
      return {
        kind: "keystroke",
        char: ch,
        modifiers,
      };
    }
  }

  return null;
}

export function validatePasteImageInput(input: {
  base64: string;
  mimeType: string;
}): { ok: true; bytes: Buffer; ext: string; mimeType: string } | { ok: false; error: string } {
  const normalizedMime = input.mimeType.trim().toLowerCase();
  const ext = ALLOWED_IMAGE_MIMES[normalizedMime];
  if (!ext) {
    return { ok: false, error: `Unsupported image type: ${input.mimeType}` };
  }
  const stripped = input.base64.replace(/^data:[^;]+;base64,/i, "").trim();
  if (!stripped) {
    return { ok: false, error: "Image payload is empty" };
  }
  const bytes = Buffer.from(stripped, "base64");
  if (bytes.length === 0) {
    return { ok: false, error: "Image payload could not be decoded" };
  }
  if (bytes.length > MAX_PASTE_IMAGE_BYTES) {
    return { ok: false, error: "Image exceeds the 10 MB remote paste limit" };
  }
  return { ok: true, bytes, ext, mimeType: normalizedMime === "image/jpg" ? "image/jpeg" : normalizedMime };
}

export function parseJxaJson<T>(stdout: string, fallback: T): T {
  const trimmed = stdout.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function hostDictationSocketPath(): string {
  const override = process.env.SCOUT_HOST_DICTATION_SOCKET?.trim();
  if (override) return override;
  return join(homedir(), ".openscout", "run", "dictation.sock");
}

function hostDictationAvailable(): boolean {
  return existsSync(hostDictationSocketPath());
}

async function queryHostDictationSocket(
  payload: Record<string, unknown>,
  timeoutMs = 1_500,
): Promise<{ ok: boolean; response?: Record<string, unknown>; error?: string }> {
  const socketPath = hostDictationSocketPath();
  if (!existsSync(socketPath)) {
    return { ok: false, error: "Host dictation service is not running" };
  }
  return await new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (result: { ok: boolean; response?: Record<string, unknown>; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const socket = createConnection(socketPath);
    const timer = setTimeout(() => finish({ ok: false, error: "Host dictation timed out" }), timeoutMs);

    socket.on("connect", () => {
      const wire = JSON.stringify({ proto: 1, id: randomUUID(), ...payload }) + "\n";
      socket.write(wire);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        finish({ ok: Boolean(parsed.ok ?? true), response: parsed });
      } catch {
        finish({ ok: false, error: "Invalid response from host dictation socket" });
      }
    });

    socket.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });
  });
}

async function runOsascript(
  args: string[],
  options: { timeoutMs?: number; input?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("/usr/bin/osascript", args, {
    timeout: options.timeoutMs ?? 4_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

async function runCommandWithStdin(
  file: string,
  args: string[],
  stdinText: string,
  timeoutMs = 3_000,
): Promise<string> {
  const proc = Bun.spawn([file, ...args], {
    stdin: new Blob([stdinText]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `${file} exited with status ${exitCode}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function readFrontmostMacApp(): Promise<MobileRemoteApp | null> {
  const script = `
ObjC.import('AppKit');
const ws = $.NSWorkspace.sharedWorkspace;
const front = ws.frontmostApplication;
if (!front) {
  JSON.stringify(null);
} else {
  let title = null;
  try {
    const se = Application('System Events');
    const proc = se.applicationProcesses.whose({ frontmost: true })[0];
    if (proc && proc.windows.length > 0) {
      title = String(proc.windows[0].name() || '');
    }
  } catch (e) {}
  JSON.stringify({
    name: ObjC.unwrap(front.localizedName) || 'Mac',
    bundleId: front.bundleIdentifier ? ObjC.unwrap(front.bundleIdentifier) : null,
    pid: Number(front.processIdentifier),
    active: true,
    windowTitle: title && title.length > 0 ? title : null
  });
}
`;
  try {
    const { stdout } = await runOsascript(["-l", "JavaScript", "-e", script], { timeoutMs: 2_500 });
    return parseJxaJson<MobileRemoteApp | null>(stdout, null);
  } catch {
    return null;
  }
}

// MARK: - Native macOS HID helper (compiled once, ~4ms per trackpad gesture)

const HID_HELPER_SWIFT = `
import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\\n").utf8))
    exit(1)
}

guard AXIsProcessTrusted() else {
    fail("Grant Accessibility permission to Scout in System Settings > Privacy & Security > Accessibility.")
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("Usage: scout-hid <move|click|rightClick|doubleClick|scroll> [dx] [dy]") }
let action = args[1]

func currentPoint() -> CGPoint {
    CGEvent(source: nil)?.location ?? CGPoint(x: 400, y: 400)
}

func clampToDisplays(_ point: CGPoint) -> CGPoint {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else { return point }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &displays, &count)
    var union = CGRect.null
    for id in displays {
        union = union.union(CGDisplayBounds(id))
    }
    guard !union.isNull else { return point }
    return CGPoint(
        x: min(max(point.x, union.minX), union.maxX - 1),
        y: min(max(point.y, union.minY), union.maxY - 1)
    )
}

func postMouse(_ type: CGEventType, _ button: CGMouseButton, at point: CGPoint, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        fail("Failed to create mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
}

switch action {
case "move":
    let dx = args.count > 2 ? (Double(args[2]) ?? 0) : 0
    let dy = args.count > 3 ? (Double(args[3]) ?? 0) : 0
    let cur = currentPoint()
    let next = clampToDisplays(CGPoint(x: cur.x + dx, y: cur.y + dy))
    postMouse(.mouseMoved, .left, at: next)
case "click":
    let pt = currentPoint()
    postMouse(.leftMouseDown, .left, at: pt, clickState: 1)
    postMouse(.leftMouseUp, .left, at: pt, clickState: 1)
case "doubleClick":
    let pt = currentPoint()
    postMouse(.leftMouseDown, .left, at: pt, clickState: 1)
    postMouse(.leftMouseUp, .left, at: pt, clickState: 1)
    usleep(35_000)
    postMouse(.leftMouseDown, .left, at: pt, clickState: 2)
    postMouse(.leftMouseUp, .left, at: pt, clickState: 2)
case "rightClick":
    let pt = currentPoint()
    postMouse(.rightMouseDown, .right, at: pt, clickState: 1)
    postMouse(.rightMouseUp, .right, at: pt, clickState: 1)
case "scroll":
    let dx = Int32(args.count > 2 ? (Double(args[2]) ?? 0) : 0)
    let dy = Int32(args.count > 3 ? (Double(args[3]) ?? 0) : 0)
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
        fail("Failed to create scroll event")
    }
    event.post(tap: .cghidEventTap)
default:
    fail("Unknown action: \\(action)")
}
`;

let hidHelperCompilePromise: Promise<string> | null = null;

async function ensureHidHelperBinary(): Promise<string> {
  const hash = createHash("sha256").update(HID_HELPER_SWIFT).digest("hex").slice(0, 10);
  const binDir = join(homedir(), ".openscout", "bin");
  const binPath = join(binDir, `scout-hid-${hash}`);
  if (existsSync(binPath)) return binPath;

  if (!hidHelperCompilePromise) {
    hidHelperCompilePromise = (async () => {
      mkdirSync(binDir, { recursive: true });
      const srcPath = join(tmpdir(), `scout-hid-${hash}-${process.pid}.swift`);
      const tmpOut = `${binPath}.tmp-${process.pid}`;
      writeFileSync(srcPath, HID_HELPER_SWIFT, "utf8");
      try {
        await execFileAsync("/usr/bin/swiftc", ["-O", "-framework", "CoreGraphics", "-framework", "ApplicationServices", srcPath, "-o", tmpOut], {
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        const { renameSync } = await import("node:fs");
        renameSync(tmpOut, binPath);
        return binPath;
      } finally {
        try { unlinkSync(srcPath); } catch {}
        try { if (existsSync(tmpOut)) unlinkSync(tmpOut); } catch {}
        hidHelperCompilePromise = null;
      }
    })();
  }
  return await hidHelperCompilePromise;
}

// MARK: - Public RPC handlers

export async function readMobileRemoteState(): Promise<MobileRemoteState> {
  const mac = isMacOS();
  const frontmostApp = mac ? await readFrontmostMacApp() : null;
  const dictationAvailable = mac && hostDictationAvailable();
  let dictationState: string | null = null;
  if (dictationAvailable) {
    const probe = await queryHostDictationSocket({ cmd: "status" }, 800);
    if (probe.ok && typeof probe.response?.state === "string") {
      dictationState = probe.response.state;
    }
  }
  return {
    ok: mac,
    host: osHostname().replace(/\.local$/i, ""),
    platform: process.platform,
    frontmostApp,
    capabilities: {
      keyboard: mac,
      trackpad: mac,
      screen: mac,
      apps: mac,
      insertText: mac,
      pasteImage: mac,
      hostDictation: dictationAvailable,
    },
    hostDictation: {
      available: dictationAvailable,
      state: dictationState,
    },
  };
}

export async function runMobileRemoteType(input: {
  text?: string;
  key?: string;
  modifiers?: MobileRemoteModifier[];
}): Promise<MobileRemoteActionResult> {
  if (!isMacOS()) {
    return { ok: false, error: "Remote keyboard is only supported on macOS hosts." };
  }

  try {
    if (typeof input.key === "string" && input.key.trim().length > 0) {
      const spec = resolveAppleScriptKeySpec(input.key, input.modifiers);
      if (!spec) {
        return { ok: false, error: `Unsupported key: ${input.key}` };
      }
      const usingClause = spec.modifiers.length > 0 ? ` using {${spec.modifiers.join(", ")}}` : "";
      if (spec.kind === "keyCode") {
        const script = `tell application "System Events" to key code ${spec.code}${usingClause}`;
        await runOsascript(["-e", script], { timeoutMs: 3_000 });
        return { ok: true, detail: input.key };
      }
      const script = `on run argv\nset ch to item 1 of argv\ntell application "System Events" to keystroke ch${usingClause}\nend run`;
      await runOsascript(["-e", script, "--", spec.char!], { timeoutMs: 3_000 });
      return { ok: true, detail: spec.char };
    }

    if (typeof input.text === "string" && input.text.length > 0) {
      if (input.text.length > MAX_REMOTE_TEXT_LENGTH) {
        return { ok: false, error: "Text exceeds maximum length." };
      }
      const script = `on run argv\nset txt to item 1 of argv\ntell application "System Events" to keystroke txt\nend run`;
      await runOsascript(["-e", script, "--", input.text], { timeoutMs: 4_000 });
      return { ok: true, detail: `${input.text.length} chars` };
    }

    return { ok: false, error: "Provide either key or text." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export async function runMobileRemoteInsertText(input: {
  text: string;
  submit?: boolean;
}): Promise<MobileRemoteActionResult> {
  if (!isMacOS()) {
    return { ok: false, error: "Remote text insertion is only supported on macOS hosts." };
  }
  const text = input.text;
  if (!text || text.length === 0) {
    return { ok: false, error: "Text is empty." };
  }
  if (text.length > MAX_REMOTE_TEXT_LENGTH) {
    return { ok: false, error: "Text exceeds maximum length." };
  }

  let previousClipboard: string | null = null;
  try {
    const prev = await execFileAsync("/usr/bin/pbpaste", [], {
      timeout: 1_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    previousClipboard = String(prev.stdout ?? "");
  } catch {
    previousClipboard = null;
  }

  try {
    await runCommandWithStdin("/usr/bin/pbcopy", [], text, 2_000);
    await runOsascript([
      "-e",
      `tell application "System Events" to keystroke "v" using {command down}`,
    ], { timeoutMs: 3_000 });

    if (input.submit) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await runOsascript([
        "-e",
        `tell application "System Events" to key code 36`,
      ], { timeoutMs: 2_000 });
    }

    if (previousClipboard !== null) {
      setTimeout(() => {
        runCommandWithStdin("/usr/bin/pbcopy", [], previousClipboard!, 2_000).catch(() => {});
      }, 350);
    }

    return { ok: true, detail: input.submit ? "Inserted and submitted" : "Inserted" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export async function runMobileRemoteTrackpad(input: {
  event: MobileRemoteTrackpadEvent;
  dx?: number;
  dy?: number;
}): Promise<MobileRemoteActionResult> {
  if (!isMacOS()) {
    return { ok: false, error: "Remote trackpad is only supported on macOS hosts." };
  }

  try {
    const helper = await ensureHidHelperBinary();
    const dx = clampTrackpadDelta(input.dx);
    const dy = clampTrackpadDelta(input.dy);
    const args =
      input.event === "move" || input.event === "scroll"
        ? [input.event, String(dx), String(dy)]
        : [input.event];
    await execFileAsync(helper, args, { timeout: 2_500, maxBuffer: 64 * 1024 });
    return { ok: true, detail: input.event };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export async function readMobileRemoteScreenFrame(input?: {
  maxWidth?: number;
}): Promise<MobileRemoteScreenFrame> {
  const capturedAt = Date.now();
  if (!isMacOS()) {
    return {
      ok: false,
      mimeType: "image/jpeg",
      width: 0,
      height: 0,
      base64: "",
      capturedAt,
      error: "Screen preview is only supported on macOS hosts.",
    };
  }

  const maxWidth = clampScreenMaxWidth(input?.maxWidth);
  const tmpFile = join(tmpdir(), `scout-remote-screen-${randomUUID()}.jpg`);
  try {
    await execFileAsync("/usr/sbin/screencapture", ["-x", "-t", "jpg", tmpFile], {
      timeout: 5_000,
    });
    await execFileAsync("/usr/bin/sips", ["-Z", String(maxWidth), "-s", "formatOptions", "62", tmpFile], {
      timeout: 5_000,
    });
    const dims = await execFileAsync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", tmpFile], {
      timeout: 2_000,
    });
    const widthMatch = String(dims.stdout).match(/pixelWidth:\s*(\d+)/);
    const heightMatch = String(dims.stdout).match(/pixelHeight:\s*(\d+)/);
    const width = widthMatch ? Number(widthMatch[1]) : maxWidth;
    const height = heightMatch ? Number(heightMatch[1]) : Math.round((maxWidth * 9) / 16);

    const bytes = await Bun.file(tmpFile).arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");
    return {
      ok: true,
      mimeType: "image/jpeg",
      width,
      height,
      base64,
      capturedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      mimeType: "image/jpeg",
      width: 0,
      height: 0,
      base64: "",
      capturedAt,
      error: message,
    };
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
}

export async function readMobileRemoteApps(): Promise<MobileRemoteAppsResult> {
  if (!isMacOS()) {
    return { ok: false, apps: [], error: "App switching is only supported on macOS hosts." };
  }

  const script = `
ObjC.import('AppKit');
const ws = $.NSWorkspace.sharedWorkspace;
const front = ws.frontmostApplication;
const frontPid = front ? Number(front.processIdentifier) : -1;
const running = ws.runningApplications;
const out = [];
for (let i = 0; i < running.count; i++) {
  const app = running.objectAtIndex(i);
  if (Number(app.activationPolicy) !== 0) continue;
  const pid = Number(app.processIdentifier);
  const name = ObjC.unwrap(app.localizedName) || 'App';
  const bundleId = app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : null;
  out.push({ name, bundleId, pid, active: pid === frontPid });
}
out.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.name.localeCompare(b.name));
JSON.stringify(out);
`;
  try {
    const { stdout } = await runOsascript(["-l", "JavaScript", "-e", script], { timeoutMs: 3_000 });
    const apps = parseJxaJson<MobileRemoteApp[]>(stdout, []);
    return { ok: true, apps };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, apps: [], error: message };
  }
}

export async function runMobileRemoteActivateApp(input: {
  bundleId?: string;
  pid?: number;
  name?: string;
}): Promise<MobileRemoteActionResult> {
  if (!isMacOS()) {
    return { ok: false, error: "App switching is only supported on macOS hosts." };
  }

  const script = `
ObjC.import('AppKit');
function run(argv) {
  const bundleId = argv[0] || '';
  const pid = Number(argv[1] || '0');
  const name = argv[2] || '';
  const ws = $.NSWorkspace.sharedWorkspace;
  const running = ws.runningApplications;
  let match = null;
  for (let i = 0; i < running.count; i++) {
    const app = running.objectAtIndex(i);
    const appPid = Number(app.processIdentifier);
    const appBundle = app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : '';
    const appName = ObjC.unwrap(app.localizedName) || '';
    if ((pid > 0 && appPid === pid) || (bundleId && appBundle === bundleId) || (name && appName.toLowerCase() === name.toLowerCase())) {
      match = app;
      break;
    }
  }
  if (!match) return JSON.stringify({ ok: false, error: 'Application not found' });
  const ok = Boolean(match.activateWithOptions($.NSApplicationActivateIgnoringOtherApps));
  return JSON.stringify({ ok, detail: ObjC.unwrap(match.localizedName) || '' });
}
`;
  try {
    const { stdout } = await runOsascript(
      [
        "-l",
        "JavaScript",
        "-e",
        script,
        "--",
        input.bundleId ?? "",
        input.pid ? String(input.pid) : "0",
        input.name ?? "",
      ],
      { timeoutMs: 3_000 },
    );
    const parsed = parseJxaJson<MobileRemoteActionResult>(stdout, { ok: false, error: "Failed to activate app" });
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export async function runMobileRemotePasteImage(input: {
  base64: string;
  mimeType: string;
  paste?: boolean;
}): Promise<MobileRemotePasteImageResult> {
  if (!isMacOS()) {
    return { ok: false, pasted: false, error: "Remote image paste is only supported on macOS hosts." };
  }

  const validated = validatePasteImageInput(input);
  if (!validated.ok) {
    return { ok: false, pasted: false, error: validated.error };
  }

  const grabsDir = join(homedir(), "Pictures", "Scout Grabs");
  mkdirSync(grabsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(grabsDir, `scout-grab-${stamp}.${validated.ext}`);
  writeFileSync(filePath, validated.bytes);

  const copyScript = `
ObjC.import('AppKit');
function run(argv) {
  const path = argv[0];
  const img = $.NSImage.alloc.initWithContentsOfFile(path);
  if (!img) return JSON.stringify({ ok: false, error: 'Could not read image' });
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const ok = Boolean(pb.writeObjects($.NSArray.arrayWithObject(img)));
  return JSON.stringify({ ok });
}
`;

  try {
    const { stdout } = await runOsascript(["-l", "JavaScript", "-e", copyScript, "--", filePath], {
      timeoutMs: 4_000,
    });
    const copied = parseJxaJson<{ ok: boolean; error?: string }>(stdout, { ok: false, error: "Clipboard write failed" });
    if (!copied.ok) {
      return { ok: false, path: filePath, pasted: false, error: copied.error };
    }

    const shouldPaste = input.paste !== false;
    if (shouldPaste) {
      await runOsascript([
        "-e",
        `tell application "System Events" to keystroke "v" using {command down}`,
      ], { timeoutMs: 3_000 });
    }
    return { ok: true, path: filePath, pasted: shouldPaste };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, path: filePath, pasted: false, error: message };
  }
}

export async function runMobileRemoteDictate(input: {
  action: MobileRemoteDictateAction;
}): Promise<MobileRemoteDictateResult> {
  if (!isMacOS()) {
    return { ok: false, available: false, error: "Host dictation is only supported on macOS hosts." };
  }
  if (!hostDictationAvailable()) {
    return {
      ok: false,
      available: false,
      error: "Host microphone dictation is not running; use on-device dictation instead.",
    };
  }

  const cmd = input.action === "status"
    ? { cmd: "status" }
    : { cmd: "dictate", mode: input.action };
  const result = await queryHostDictationSocket(cmd, 2_000);
  if (!result.ok) {
    return { ok: false, available: true, error: result.error ?? "Host dictation command failed" };
  }
  return {
    ok: true,
    available: true,
    state: typeof result.response?.state === "string" ? result.response.state : undefined,
    detail: typeof result.response?.detail === "string" ? result.response.detail : input.action,
  };
}
