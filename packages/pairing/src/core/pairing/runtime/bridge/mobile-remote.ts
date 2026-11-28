// Mobile Remote — macOS host control over Scout's encrypted pairing bridge.
//
// Trusted paired iOS and watchOS devices already authenticate over LAN,
// Tailscale, and Scout Relay (OSN). These handlers expose keyboard, text
// insertion, trackpad, screen preview, app switching, image paste, and optional
// host dictation on that same encrypted bridge — no separate pairing flow.
//
// Security posture:
// - Every RPC is gated by live `credentialBinding` verification in `router.ts`
//   (Noise key + live socket + current pairing authority stamp), and mutating
//   or capture operations re-validate `admit()` immediately before side effects
//   so unpairing stops remote control promptly.
// - Host policy (`SCOUT_MOBILE_REMOTE*` env vars or `~/.openscout/remote-policy.json`)
//   provides a hard kill switch and per-capability toggles; compound actions
//   (clipboard + Cmd+V) require every capability they exercise.
// - Screen-lock guard fails CLOSED: locked or unverifiable sessions deny input,
//   clipboard paste, app switching, dictation, and screen capture.
// - Per-peer sliding-window rate limits + in-flight state coalescing bound
//   process and socket fan-out.
// - Temp artifacts (screen captures, pasted images, HID compile scratch) stay in
//   private `0o700` dirs under `~/.openscout/` (`0o600` files) and are unlinked
//   in `finally` — zero permanent disk growth, never `/tmp`.
// - Image pastes verify pre-decode size limits and magic bytes before touching
//   disk or NSPasteboard.
// - High-impact actions and denials emit structured `remote:audit` logs without
//   recording typed text, clipboard contents, or image bytes.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "./log.ts";

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

export type MobileRemoteCapability =
  | "input"
  | "screen"
  | "clipboard"
  | "apps"
  | "dictate";

export type MobileRemoteRateBucket =
  | "state"
  | "trackpad"
  | "input"
  | "screen"
  | "paste"
  | "apps"
  | "dictate";

export type ScreenLockStatus = "unlocked" | "locked" | "unknown";

export interface MobileRemotePolicy {
  enabled: boolean;
  input: boolean;
  screen: boolean;
  clipboard: boolean;
  apps: boolean;
  dictate: boolean;
  allowWhileLocked: boolean;
}

export interface MobileRemoteContext {
  deviceId?: string;
  /** Re-validates live credential binding immediately before host side effects. */
  admit?: () => void;
}

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
  screenLocked?: boolean;
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

export const MAX_REMOTE_TEXT_LENGTH = 16_384;
export const MAX_PASTE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PASTE_IMAGE_BASE64_LENGTH = Math.ceil((MAX_PASTE_IMAGE_BYTES * 4) / 3) + 64;
const MIN_SCREEN_WIDTH = 320;
const MAX_SCREEN_WIDTH = 1440;
const DEFAULT_SCREEN_WIDTH = 960;
const MAX_TRACKPAD_DELTA = 2_400;
const TRACKPAD_LOCK_CACHE_TTL_MS = 250;
const STATE_CACHE_TTL_MS = 750;

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

const RATE_LIMITS: Record<MobileRemoteRateBucket, { max: number; windowMs: number }> = {
  state: { max: 8, windowMs: 3_000 },
  trackpad: { max: 180, windowMs: 2_000 },
  input: { max: 60, windowMs: 2_000 },
  screen: { max: 4, windowMs: 2_000 },
  paste: { max: 4, windowMs: 10_000 },
  apps: { max: 10, windowMs: 5_000 },
  dictate: { max: 10, windowMs: 5_000 },
};

// MARK: - Policy, Rate Limiting, Validation & Audit

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return undefined;
}

export function resolveMobileRemotePolicy(options?: {
  env?: Record<string, string | undefined>;
  policyPath?: string;
}): MobileRemotePolicy {
  const env = options?.env ?? process.env;
  const policyPath = options?.policyPath ?? join(homedir(), ".openscout", "remote-policy.json");

  let filePolicy: Partial<MobileRemotePolicy> = {};
  if (existsSync(policyPath)) {
    try {
      const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        filePolicy = parsed as Partial<MobileRemotePolicy>;
      }
    } catch {
      // Fail closed if the operator wrote a malformed policy file.
      return {
        enabled: false,
        input: false,
        screen: false,
        clipboard: false,
        apps: false,
        dictate: false,
        allowWhileLocked: false,
      };
    }
  }

  const pick = (envKey: string, fileVal: boolean | undefined, fallback: boolean): boolean => {
    const fromEnv = parseBoolEnv(env[envKey]);
    if (fromEnv !== undefined) return fromEnv;
    if (typeof fileVal === "boolean") return fileVal;
    return fallback;
  };

  const enabled = pick("SCOUT_MOBILE_REMOTE", filePolicy.enabled, true);
  return {
    enabled,
    input: enabled && pick("SCOUT_MOBILE_REMOTE_INPUT", filePolicy.input, true),
    screen: enabled && pick("SCOUT_MOBILE_REMOTE_SCREEN", filePolicy.screen, true),
    clipboard: enabled && pick("SCOUT_MOBILE_REMOTE_CLIPBOARD", filePolicy.clipboard, true),
    apps: enabled && pick("SCOUT_MOBILE_REMOTE_APPS", filePolicy.apps, true),
    dictate: enabled && pick("SCOUT_MOBILE_REMOTE_DICTATE", filePolicy.dictate, true),
    allowWhileLocked: pick("SCOUT_MOBILE_REMOTE_ALLOW_WHILE_LOCKED", filePolicy.allowWhileLocked, false),
  };
}

export function requiredCapabilitiesAllowed(
  policy: MobileRemotePolicy,
  capabilities: readonly MobileRemoteCapability[],
): boolean {
  if (!policy.enabled) return false;
  for (const cap of capabilities) {
    if (!policy[cap]) return false;
  }
  return true;
}

export function parseScreenLockOutput(stdout: string): ScreenLockStatus {
  const trimmed = stdout.trim();
  if (trimmed === "0") return "unlocked";
  if (trimmed === "1") return "locked";
  return "unknown";
}

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();

  consume(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const cutoff = now - windowMs;
    const prev = this.windows.get(key);
    const active = prev ? prev.filter((ts) => ts > cutoff) : [];
    if (active.length >= max) {
      this.windows.set(key, active);
      return false;
    }
    active.push(now);
    this.windows.set(key, active);
    if (this.windows.size > 256) {
      for (const [k, list] of this.windows) {
        if (list.length === 0 || list[list.length - 1]! <= cutoff) {
          this.windows.delete(k);
        }
      }
    }
    return true;
  }

  reset(): void {
    this.windows.clear();
  }
}

const remoteRateLimiter = new SlidingWindowRateLimiter();

function checkRateLimit(deviceId: string | undefined, bucket: MobileRemoteRateBucket): boolean {
  const limit = RATE_LIMITS[bucket];
  const key = `${deviceId ?? "unknown"}:${bucket}`;
  return remoteRateLimiter.consume(key, limit.max, limit.windowMs);
}

function verifyAdmitted(action: string, ctx?: MobileRemoteContext): string | null {
  if (!ctx?.admit) return null;
  try {
    ctx.admit();
    return null;
  } catch {
    auditRemote(action, ctx.deviceId, "denied", "revoked");
    return "Remote control session expired or was revoked; reconnect the paired device.";
  }
}

function auditRemote(
  action: string,
  deviceId: string | undefined,
  outcome: "ok" | "denied" | "error",
  detail?: string,
): void {
  const peer = deviceId ? deviceId.slice(0, 12) : "unknown";
  const suffix = detail ? ` (${detail})` : "";
  if (outcome === "denied") {
    log.warn("remote:audit", `${action} peer=${peer} outcome=denied${suffix}`);
  } else {
    log.info("remote:audit", `${action} peer=${peer} outcome=${outcome}${suffix}`);
  }
}

export function sanitizeRemoteError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const lower = raw.toLowerCase();
  if (
    lower.includes("accessibility")
    || lower.includes("assistive access")
    || lower.includes("not allowed to send keystrokes")
    || lower.includes("1002")
    || lower.includes("axisprocesstrusted")
  ) {
    return "Grant Accessibility permission to Scout's runtime in System Settings > Privacy & Security > Accessibility.";
  }
  if (
    lower.includes("screen recording")
    || lower.includes("could not create image from display")
    || lower.includes("cannot capture")
  ) {
    return "Grant Screen Recording permission to Scout's runtime in System Settings > Privacy & Security > Screen Recording.";
  }
  if (lower.includes("timed out") || lower.includes("etimedout")) {
    return "Mac remote action timed out.";
  }
  return fallback;
}

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

export function sanitizeRemoteTypeText(text: string): string | null {
  if (!text || text.length > MAX_REMOTE_TEXT_LENGTH) return null;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return null;
    }
  }
  return text;
}

export function matchesImageMagicBytes(bytes: Buffer, ext: string): boolean {
  if (bytes.length < 12) return false;
  switch (ext) {
    case "png":
      return (
        bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a
      );
    case "jpg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "webp":
      return (
        bytes.subarray(0, 4).toString("ascii") === "RIFF"
        && bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case "heic":
      return bytes.subarray(4, 8).toString("ascii") === "ftyp";
    default:
      return false;
  }
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
  if (stripped.length > MAX_PASTE_IMAGE_BASE64_LENGTH) {
    return { ok: false, error: "Image exceeds the 10 MB remote paste limit" };
  }
  const bytes = Buffer.from(stripped, "base64");
  if (bytes.length === 0) {
    return { ok: false, error: "Image payload could not be decoded" };
  }
  if (bytes.length > MAX_PASTE_IMAGE_BYTES) {
    return { ok: false, error: "Image exceeds the 10 MB remote paste limit" };
  }
  if (!matchesImageMagicBytes(bytes, ext)) {
    return { ok: false, error: "Image bytes do not match declared format" };
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

function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirPath, 0o700);
  } catch {}
}

function hostDictationSocketPath(): string {
  const override = process.env.SCOUT_HOST_DICTATION_SOCKET?.trim();
  if (override) return override;
  return join(homedir(), ".openscout", "run", "dictation.sock");
}

function hostDictationAvailable(): boolean {
  const socketPath = hostDictationSocketPath();
  try {
    const st = lstatSync(socketPath);
    if (!st.isSocket()) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

async function queryHostDictationSocket(
  payload: Record<string, unknown>,
  timeoutMs = 1_500,
): Promise<{ ok: boolean; response?: Record<string, unknown>; error?: string }> {
  const socketPath = hostDictationSocketPath();
  if (!hostDictationAvailable()) {
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

    socket.on("error", () => {
      finish({ ok: false, error: "Host dictation socket error" });
    });
  });
}

async function runOsascript(
  args: string[],
  options: { timeoutMs?: number } = {},
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

// MARK: - Native macOS HID & Lock Helper (compiled once in ~/.openscout/bin)

const HID_HELPER_SWIFT = `
import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\\n").utf8))
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("Usage: scout-hid <locked|move|click|rightClick|doubleClick|scroll> [dx] [dy]") }
let action = args[1]

if action == "locked" {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        print("unknown")
        exit(2)
    }
    let onConsole = (dict["kCGSSessionOnConsoleKey"] as? Bool)
        ?? ((dict["kCGSSessionOnConsoleKey"] as? Int) == 1)
    if !onConsole {
        print("1")
        exit(0)
    }
    if let lockedBool = dict["CGSSessionScreenIsLocked"] as? Bool {
        print(lockedBool ? "1" : "0")
    } else if let lockedInt = dict["CGSSessionScreenIsLocked"] as? Int {
        print(lockedInt == 1 ? "1" : "0")
    } else {
        // On macOS GUI console sessions, CGSSessionScreenIsLocked is omitted when unlocked.
        print("0")
    }
    exit(0)
}

guard AXIsProcessTrusted() else {
    fail("Grant Accessibility permission to Scout in System Settings > Privacy & Security > Accessibility.")
}

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
  ensurePrivateDir(binDir);
  const binPath = join(binDir, `scout-hid-${hash}`);
  if (existsSync(binPath)) {
    const st = lstatSync(binPath);
    if (st.isFile() && !st.isSymbolicLink()) {
      return binPath;
    }
    throw new Error("Refusing to execute non-regular HID helper");
  }

  if (!hidHelperCompilePromise) {
    hidHelperCompilePromise = (async () => {
      const nonce = randomUUID().slice(0, 8);
      const srcPath = join(binDir, `.scout-hid-${hash}-${nonce}.swift`);
      const tmpOut = join(binDir, `.scout-hid-${hash}-${nonce}.bin`);
      writeFileSync(srcPath, HID_HELPER_SWIFT, { encoding: "utf8", mode: 0o600 });
      try {
        await execFileAsync(
          "/usr/bin/swiftc",
          ["-O", "-framework", "CoreGraphics", "-framework", "ApplicationServices", srcPath, "-o", tmpOut],
          { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
        );
        chmodSync(tmpOut, 0o700);
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

let cachedTrackpadLock: { status: ScreenLockStatus; at: number } | null = null;

/**
 * Checks whether the macOS GUI console session is locked.
 * Fails CLOSED (`"unknown"`) on helper errors, timeouts, or unexpected output.
 */
async function checkMacScreenLockStatus(options?: { allowCache?: boolean }): Promise<ScreenLockStatus> {
  if (!isMacOS()) return "unlocked";
  const now = Date.now();
  if (
    options?.allowCache
    && cachedTrackpadLock
    && cachedTrackpadLock.status === "unlocked"
    && now - cachedTrackpadLock.at < TRACKPAD_LOCK_CACHE_TTL_MS
  ) {
    return "unlocked";
  }
  try {
    const helper = await ensureHidHelperBinary();
    const { stdout } = await execFileAsync(helper, ["locked"], { timeout: 2_000, maxBuffer: 1024 });
    const status = parseScreenLockOutput(stdout);
    cachedTrackpadLock = { status, at: Date.now() };
    return status;
  } catch {
    cachedTrackpadLock = null;
    return "unknown";
  }
}

async function guardRemoteAction(
  action: string,
  capabilities: readonly MobileRemoteCapability[],
  bucket: MobileRemoteRateBucket,
  ctx?: MobileRemoteContext,
  options?: { allowLockCache?: boolean },
): Promise<string | null> {
  const revoked = verifyAdmitted(action, ctx);
  if (revoked) return revoked;

  const policy = resolveMobileRemotePolicy();
  if (!requiredCapabilitiesAllowed(policy, capabilities)) {
    auditRemote(action, ctx?.deviceId, "denied", `policy:${capabilities.join("+")}`);
    return "Remote control is disabled by host policy.";
  }
  if (!checkRateLimit(ctx?.deviceId, bucket)) {
    auditRemote(action, ctx?.deviceId, "denied", `rate:${bucket}`);
    return "Remote action rate limit exceeded; slow down.";
  }
  if (!policy.allowWhileLocked) {
    const lockStatus = await checkMacScreenLockStatus({ allowCache: options?.allowLockCache });
    if (lockStatus === "locked") {
      auditRemote(action, ctx?.deviceId, "denied", "screen_locked");
      return "Mac screen is locked.";
    }
    if (lockStatus !== "unlocked") {
      auditRemote(action, ctx?.deviceId, "denied", "lock_unknown");
      return "Mac screen lock state could not be verified.";
    }
  }
  return null;
}

// MARK: - Coalesced State Probe

let cachedStateValue: { state: MobileRemoteState; at: number } | null = null;
let inFlightStatePromise: Promise<MobileRemoteState> | null = null;

async function computeMobileRemoteState(): Promise<MobileRemoteState> {
  const mac = isMacOS();
  const policy = resolveMobileRemotePolicy();
  const lockStatus: ScreenLockStatus = mac ? await checkMacScreenLockStatus() : "unlocked";
  const screenLocked = lockStatus !== "unlocked";
  const unlockedOrAllowed = lockStatus === "unlocked" || policy.allowWhileLocked;
  // Never probe frontmost app/window titles when `apps` capability is disabled.
  const frontmostApp = mac && policy.enabled && policy.apps && unlockedOrAllowed
    ? await readFrontmostMacApp()
    : null;
  const dictationAvailable = mac && policy.dictate && hostDictationAvailable();
  let dictationState: string | null = null;
  if (dictationAvailable && unlockedOrAllowed) {
    const probe = await queryHostDictationSocket({ cmd: "status" }, 800);
    if (probe.ok && typeof probe.response?.state === "string") {
      dictationState = probe.response.state;
    }
  }
  return {
    ok: mac && policy.enabled,
    host: osHostname().replace(/\.local$/i, ""),
    platform: process.platform,
    screenLocked,
    frontmostApp,
    capabilities: {
      keyboard: mac && policy.input && unlockedOrAllowed,
      trackpad: mac && policy.input && unlockedOrAllowed,
      screen: mac && policy.screen && unlockedOrAllowed,
      apps: mac && policy.apps && unlockedOrAllowed,
      insertText: mac && policy.input && policy.clipboard && unlockedOrAllowed,
      pasteImage: mac && policy.clipboard && unlockedOrAllowed,
      hostDictation: dictationAvailable && unlockedOrAllowed,
    },
    hostDictation: {
      available: dictationAvailable,
      state: dictationState,
    },
  };
}

// MARK: - Public RPC handlers

export async function readMobileRemoteState(ctx?: MobileRemoteContext): Promise<MobileRemoteState> {
  if (!checkRateLimit(ctx?.deviceId, "state")) {
    if (cachedStateValue) return cachedStateValue.state;
    return {
      ok: false,
      host: osHostname().replace(/\.local$/i, ""),
      platform: process.platform,
      screenLocked: true,
      frontmostApp: null,
      capabilities: {
        keyboard: false,
        trackpad: false,
        screen: false,
        apps: false,
        insertText: false,
        pasteImage: false,
        hostDictation: false,
      },
      hostDictation: { available: false, state: null },
    };
  }
  const now = Date.now();
  if (cachedStateValue && now - cachedStateValue.at < STATE_CACHE_TTL_MS) {
    return cachedStateValue.state;
  }
  if (!inFlightStatePromise) {
    inFlightStatePromise = computeMobileRemoteState()
      .then((state) => {
        cachedStateValue = { state, at: Date.now() };
        return state;
      })
      .finally(() => {
        inFlightStatePromise = null;
      });
  }
  return await inFlightStatePromise;
}

export async function runMobileRemoteType(
  input: {
    text?: string;
    key?: string;
    modifiers?: MobileRemoteModifier[];
  },
  ctx?: MobileRemoteContext,
): Promise<MobileRemoteActionResult> {
  if (!isMacOS()) {
    return { ok: false, error: "Remote keyboard is only supported on macOS hosts." };
  }
  const denied = await guardRemoteAction("remoteType", ["input"], "input", ctx);
  if (denied) return { ok: false, error: denied };

  try {
    const revokedBeforeExec = verifyAdmitted("remoteType", ctx);
    if (revokedBeforeExec) return { ok: false, error: revokedBeforeExec };

    if (typeof input.key === "string" && input.key.trim().length > 0) {
      const spec = resolveAppleScriptKeySpec(input.key, input.modifiers);
      if (!spec) {
        return { ok: false, error: "Unsupported key." };
      }
      const usingClause = spec.modifiers.length > 0 ? ` using {${spec.modifiers.join(", ")}}` : "";
      if (spec.kind === "keyCode") {
        const script = `tell application "System Events" to key code ${spec.code}${usingClause}`;
        await runOsascript(["-e", script], { timeoutMs: 3_000 });
        return { ok: true, detail: input.key };
      }
      const script = `on run argv\nset ch to item 1 of argv\ntell application "System Events" to keystroke ch${usingClause}\nend run`;
      await runOsascript(["-e", script, "--", spec.char!], { timeoutMs: 3_000 });
      return { ok: true, detail: "key" };
    }

    if (typeof input.text === "string" && input.text.length > 0) {
      const safe = sanitizeRemoteTypeText(input.text);
      if (!safe) {
        return { ok: false, error: "Text contains disallowed control characters or exceeds maximum length." };
      }
      const script = `on run argv\nset txt to item 1 of argv\ntell application "System Events" to keystroke txt\nend run`;
      await runOsascript(["-e", script, "--", safe], { timeoutMs: 4_000 });
      return { ok: true, detail: `${safe.length} chars` };
    }

    return { ok: false, error: "Provide either key or text." };
  } catch (error) {
    auditRemote("remoteType", ctx?.deviceId, "error");
    return { ok: false, error: sanitizeRemoteError(error, "Keystroke failed on Mac.") };
  }
}

export async function runMobileRemoteInsertText(
  input: {
    text: string;
    submit?: boolean;
  },
  ctx?: MobileRemoteContext,
): Promise<MobileRemoteActionResult> {
  if (!isMacOS()) {
    return { ok: false, error: "Remote text insertion is only supported on macOS hosts." };
  }
  // InsertText writes NSPasteboard and injects Cmd+V, so require both capabilities.
  const denied = await guardRemoteAction("remoteInsertText", ["input", "clipboard"], "input", ctx);
  if (denied) return { ok: false, error: denied };

  const text = input.text;
  if (!text || text.length === 0) {
    return { ok: false, error: "Text is empty." };
  }
  if (text.length > MAX_REMOTE_TEXT_LENGTH || text.includes("\0")) {
    return { ok: false, error: "Text exceeds maximum length or contains invalid bytes." };
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

  const revokedBeforePaste = verifyAdmitted("remoteInsertText", ctx);
  if (revokedBeforePaste) return { ok: false, error: revokedBeforePaste };

  try {
    await runCommandWithStdin("/usr/bin/pbcopy", [], text, 2_000);
    await runOsascript([
      "-e",
      `tell application "System Events" to keystroke "v" using {command down}`,
    ], { timeoutMs: 3_000 });

    if (input.submit) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const revokedBeforeSubmit = verifyAdmitted("remoteInsertText", ctx);
      if (revokedBeforeSubmit) return { ok: false, error: revokedBeforeSubmit };
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

    auditRemote("remoteInsertText", ctx?.deviceId, "ok", `${text.length}c submit=${Boolean(input.submit)}`);
    return { ok: true, detail: input.submit ? "Inserted and submitted" : "Inserted" };
  } catch (error) {
    auditRemote("remoteInsertText", ctx?.deviceId, "error");
    return { ok: false, error: sanitizeRemoteError(error, "Text insertion failed on Mac.") };
  }
}

export async function runMobileRemoteTrackpad(
  input: {
    event: MobileRemoteTrackpadEvent;
    dx?: number;
    dy?: number;
  },
  ctx?: MobileRemoteContext,
): Promise<MobileRemoteActionResult> {
  if (!isMacOS()) {
    return { ok: false, error: "Remote trackpad is only supported on macOS hosts." };
  }
  const denied = await guardRemoteAction(
    "remoteTrackpad",
    ["input"],
    "trackpad",
    ctx,
    { allowLockCache: input.event === "move" || input.event === "scroll" },
  );
  if (denied) return { ok: false, error: denied };

  try {
    const helper = await ensureHidHelperBinary();
    const revokedBeforeExec = verifyAdmitted("remoteTrackpad", ctx);
    if (revokedBeforeExec) return { ok: false, error: revokedBeforeExec };

    const dx = clampTrackpadDelta(input.dx);
    const dy = clampTrackpadDelta(input.dy);
    const args =
      input.event === "move" || input.event === "scroll"
        ? [input.event, String(dx), String(dy)]
        : [input.event];
    await execFileAsync(helper, args, { timeout: 2_500, maxBuffer: 64 * 1024 });
    return { ok: true, detail: input.event };
  } catch (error) {
    return { ok: false, error: sanitizeRemoteError(error, "Trackpad gesture failed on Mac.") };
  }
}

export async function readMobileRemoteScreenFrame(
  input?: {
    maxWidth?: number;
  },
  ctx?: MobileRemoteContext,
): Promise<MobileRemoteScreenFrame> {
  const capturedAt = Date.now();
  const emptyFrame = (error: string): MobileRemoteScreenFrame => ({
    ok: false,
    mimeType: "image/jpeg",
    width: 0,
    height: 0,
    base64: "",
    capturedAt,
    error,
  });

  if (!isMacOS()) {
    return emptyFrame("Screen preview is only supported on macOS hosts.");
  }
  const denied = await guardRemoteAction("remoteScreenFrame", ["screen"], "screen", ctx);
  if (denied) return emptyFrame(denied);

  const maxWidth = clampScreenMaxWidth(input?.maxWidth);
  const tmpDir = join(homedir(), ".openscout", "run", "remote-tmp");
  ensurePrivateDir(tmpDir);
  const tmpFile = join(tmpDir, `screen-${randomUUID()}.jpg`);
  try {
    const revokedBeforeCapture = verifyAdmitted("remoteScreenFrame", ctx);
    if (revokedBeforeCapture) return emptyFrame(revokedBeforeCapture);

    await execFileAsync("/usr/sbin/screencapture", ["-x", "-t", "jpg", tmpFile], {
      timeout: 5_000,
    });
    try { chmodSync(tmpFile, 0o600); } catch {}
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

    const revokedBeforeReturn = verifyAdmitted("remoteScreenFrame", ctx);
    if (revokedBeforeReturn) return emptyFrame(revokedBeforeReturn);

    const bytes = await Bun.file(tmpFile).arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");
    auditRemote("remoteScreenFrame", ctx?.deviceId, "ok", `${width}x${height}`);
    return {
      ok: true,
      mimeType: "image/jpeg",
      width,
      height,
      base64,
      capturedAt,
    };
  } catch (error) {
    auditRemote("remoteScreenFrame", ctx?.deviceId, "error");
    return emptyFrame(sanitizeRemoteError(error, "Screen capture failed on Mac."));
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
}

export async function readMobileRemoteApps(
  ctx?: MobileRemoteContext,
): Promise<MobileRemoteAppsResult> {
  if (!isMacOS()) {
    return { ok: false, apps: [], error: "App switching is only supported on macOS hosts." };
  }
  const denied = await guardRemoteAction("remoteApps", ["apps"], "apps", ctx);
  if (denied) return { ok: false, apps: [], error: denied };

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
    return { ok: false, apps: [], error: sanitizeRemoteError(error, "Could not list running apps.") };
  }
}

export async function runMobileRemoteActivateApp(
  input: {
    bundleId?: string;
    pid?: number;
    name?: string;
  },
  ctx?: MobileRemoteContext,
): Promise<MobileRemoteActionResult> {
  if (!isMacOS()) {
    return { ok: false, error: "App switching is only supported on macOS hosts." };
  }
  const denied = await guardRemoteAction("remoteActivateApp", ["apps"], "apps", ctx);
  if (denied) return { ok: false, error: denied };

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
    if (Number(app.activationPolicy) !== 0) continue;
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
    const revokedBeforeExec = verifyAdmitted("remoteActivateApp", ctx);
    if (revokedBeforeExec) return { ok: false, error: revokedBeforeExec };

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
    auditRemote("remoteActivateApp", ctx?.deviceId, parsed.ok ? "ok" : "error", parsed.detail);
    return parsed;
  } catch (error) {
    auditRemote("remoteActivateApp", ctx?.deviceId, "error");
    return { ok: false, error: sanitizeRemoteError(error, "Failed to focus app on Mac.") };
  }
}

export async function runMobileRemotePasteImage(
  input: {
    base64: string;
    mimeType: string;
    paste?: boolean;
  },
  ctx?: MobileRemoteContext,
): Promise<MobileRemotePasteImageResult> {
  if (!isMacOS()) {
    return { ok: false, pasted: false, error: "Remote image paste is only supported on macOS hosts." };
  }
  const shouldPaste = input.paste !== false;
  const requiredCaps: MobileRemoteCapability[] = shouldPaste ? ["clipboard", "input"] : ["clipboard"];
  const denied = await guardRemoteAction("remotePasteImage", requiredCaps, "paste", ctx);
  if (denied) return { ok: false, pasted: false, error: denied };

  const validated = validatePasteImageInput(input);
  if (!validated.ok) {
    auditRemote("remotePasteImage", ctx?.deviceId, "denied", "invalid_image");
    return { ok: false, pasted: false, error: validated.error };
  }

  // Ephemeral private temp file (0o600), unlinked unconditionally in finally
  // so repeated uploads cannot accumulate on disk.
  const tmpDir = join(homedir(), ".openscout", "run", "remote-tmp");
  ensurePrivateDir(tmpDir);
  const tmpFile = join(tmpDir, `paste-${randomUUID()}.${validated.ext}`);
  writeFileSync(tmpFile, validated.bytes, { mode: 0o600 });

  const copyScript = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  const path = argv[0];
  const data = $.NSData.dataWithContentsOfFile(path);
  if (!data) return JSON.stringify({ ok: false, error: 'Could not read image' });
  const img = $.NSImage.alloc.initWithData(data);
  if (!img) return JSON.stringify({ ok: false, error: 'Invalid image payload' });
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const ok = Boolean(pb.writeObjects($.NSArray.arrayWithObject(img)));
  return JSON.stringify({ ok });
}
`;

  try {
    const revokedBeforeCopy = verifyAdmitted("remotePasteImage", ctx);
    if (revokedBeforeCopy) return { ok: false, pasted: false, error: revokedBeforeCopy };

    const { stdout } = await runOsascript(["-l", "JavaScript", "-e", copyScript, "--", tmpFile], {
      timeoutMs: 4_000,
    });
    const copied = parseJxaJson<{ ok: boolean; error?: string }>(stdout, { ok: false, error: "Clipboard write failed" });
    if (!copied.ok) {
      auditRemote("remotePasteImage", ctx?.deviceId, "error", "clipboard");
      return { ok: false, pasted: false, error: copied.error ?? "Clipboard write failed" };
    }

    if (shouldPaste) {
      const revokedBeforePaste = verifyAdmitted("remotePasteImage", ctx);
      if (revokedBeforePaste) return { ok: false, pasted: false, error: revokedBeforePaste };
      await runOsascript([
        "-e",
        `tell application "System Events" to keystroke "v" using {command down}`,
      ], { timeoutMs: 3_000 });
    }
    auditRemote("remotePasteImage", ctx?.deviceId, "ok", `${validated.ext} ${validated.bytes.length}B paste=${shouldPaste}`);
    return { ok: true, pasted: shouldPaste };
  } catch (error) {
    auditRemote("remotePasteImage", ctx?.deviceId, "error");
    return {
      ok: false,
      pasted: false,
      error: sanitizeRemoteError(error, "Image copied, but Cmd+V paste failed on Mac."),
    };
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
}

export async function runMobileRemoteDictate(
  input: {
    action: MobileRemoteDictateAction;
  },
  ctx?: MobileRemoteContext,
): Promise<MobileRemoteDictateResult> {
  if (!isMacOS()) {
    return { ok: false, available: false, error: "Host dictation is only supported on macOS hosts." };
  }
  const denied = await guardRemoteAction("remoteDictate", ["dictate"], "dictate", ctx);
  if (denied) return { ok: false, available: false, error: denied };

  if (!hostDictationAvailable()) {
    return {
      ok: false,
      available: false,
      error: "Host microphone dictation is not running; use on-device dictation instead.",
    };
  }

  const revokedBeforeExec = verifyAdmitted("remoteDictate", ctx);
  if (revokedBeforeExec) return { ok: false, available: true, error: revokedBeforeExec };

  const cmd = input.action === "status"
    ? { cmd: "status" }
    : { cmd: "dictate", mode: input.action };
  const result = await queryHostDictationSocket(cmd, 2_000);
  if (!result.ok) {
    auditRemote("remoteDictate", ctx?.deviceId, "error", input.action);
    return { ok: false, available: true, error: result.error ?? "Host dictation command failed" };
  }
  auditRemote("remoteDictate", ctx?.deviceId, "ok", input.action);
  return {
    ok: true,
    available: true,
    state: typeof result.response?.state === "string" ? result.response.state : undefined,
    detail: typeof result.response?.detail === "string" ? result.response.detail : input.action,
  };
}
