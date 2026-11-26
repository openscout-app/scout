/**
 * Scout native managed-Chrome adapter: discovers persistent non-headless Chrome
 * identities under Scout's (and existing Action's) ChromeProfiles roots,
 * auto-launches real Chrome when idle, discovers its active DevTools port
 * (via DevToolsActivePort or configured port), and drives pages over native
 * WebSocket CDP with zero external browser binaries.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  BrowserActionRequest,
  BrowserAdapterHealth,
  BrowserLease,
  BrowserProfileInfo,
  BrowserReceipt,
} from "@openscout/protocol";
import type { BrowserAdapter } from "./adapter.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CDP_PORT = 9334;
const DEFAULT_PROFILE_NAME = "agent-browser";
const CDP_CALL_TIMEOUT_MS = 12_000;
const CHROME_LAUNCH_TIMEOUT_MS = 8_000;

export interface CdpSessionLike {
  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  close(): void;
}

export type ScoutNativeBrowserOptions = {
  supportDir?: string;
  cdpPort?: number;
  chromeBin?: string;
  defaultProfile?: string;
  fetchImpl?: typeof fetch;
  /** Optional injection for unit tests to avoid opening a real CDP WebSocket. */
  connectCdp?: (wsUrl: string) => Promise<CdpSessionLike>;
  /** Optional injection for unit tests to avoid spawning real Chrome. */
  launchChrome?: (args: {
    chromeBin: string;
    profileDir: string;
    cdpPort: number;
    url?: string;
    background?: boolean;
  }) => Promise<void>;
  /** Optional injection for opening a URL in the user's regular Chrome. */
  openRegularUrl?: (url: string) => Promise<void>;
};

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "CDP command failed"));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connect timed out")), CDP_CALL_TIMEOUT_MS);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket connect failed")); }, { once: true });
    });
    return new CdpSession(socket);
  }

  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const reply = await this.call<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (reply.exceptionDetails) {
      throw new Error(
        reply.exceptionDetails.exception?.description
        ?? reply.exceptionDetails.text
        ?? "Page script threw",
      );
    }
    return reply.result?.value as T;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // ignore close races
    }
  }
}

export function resolveChromeBinary(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.SCOUT_CHROME_BIN,
    process.env.CHROME_PATH,
    ...(process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ]),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function listProfileDir(root: string, source: "scout" | "action"): Promise<BrowserProfileInfo[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, source }));
  } catch {
    return [];
  }
}

async function readDevToolsActivePort(profileDir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(profileDir, "DevToolsActivePort"), "utf8");
    const firstLine = raw.split(/\r?\n/)[0]?.trim();
    const port = firstLine ? Number(firstLine) : NaN;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

const SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  const cssSelector = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const testId = el.getAttribute("data-testid");
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
    const aria = el.getAttribute("aria-label");
    if (aria && aria.length <= 60) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
    const name = el.getAttribute("name");
    if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift("#" + CSS.escape(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const interactiveSelector = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="textbox"], [role="checkbox"], [role="menuitem"], [contenteditable="true"]';
  const elements = [];
  for (const el of document.querySelectorAll(interactiveSelector)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    elements.push({
      selector: cssSelector(el),
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      label: el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || text || null,
      text,
      value: typeof el.value === "string" ? el.value.slice(0, 120) : null,
      href: el.getAttribute("href") || null,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    });
    if (elements.length >= 100) break;
  }
  const active = document.activeElement && document.activeElement !== document.body
    ? { tagName: document.activeElement.tagName.toLowerCase(), selector: cssSelector(document.activeElement) }
    : null;
  const textExcerpt = (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 2400);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 },
    activeElement: active,
    elements,
    textExcerpt,
  };
})()`;

function buildClickScript(selector?: string, label?: string): string {
  return `(() => {
    const query = ${JSON.stringify({ selector: selector ?? null, label: label ?? null })};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none";
    };
    let target = null;
    if (query.selector) {
      try {
        target = [...document.querySelectorAll(query.selector)].find(visible) || document.querySelector(query.selector);
      } catch {
        // selector might actually be a human label
      }
    }
    const want = (query.label || (!target && query.selector) || "").trim().toLowerCase();
    if (!target && want) {
      const candidates = [...document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], label')].filter(visible);
      const labelOf = (el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder"), el.innerText, el.textContent, el.value]
        .filter((v) => typeof v === "string")
        .map((v) => v.replace(/\\s+/g, " ").trim().toLowerCase())
        .filter(Boolean);
      target = candidates.find((el) => labelOf(el).some((v) => v === want))
        || candidates.find((el) => labelOf(el).some((v) => v.includes(want)));
    }
    if (!target) return { ok: false, error: "Element not found: " + (query.selector || query.label) };
    target.scrollIntoView({ block: "center", inline: "center" });
    if (typeof target.focus === "function") target.focus();
    target.click();
    return {
      ok: true,
      url: location.href,
      title: document.title,
      tagName: target.tagName.toLowerCase(),
      text: (target.innerText || target.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
    };
  })()`;
}

function buildFillScript(selector: string | undefined, label: string | undefined, text: string): string {
  return `(() => {
    const query = ${JSON.stringify({ selector: selector ?? null, label: label ?? null, text })};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none";
    };
    let target = null;
    if (query.selector) {
      try {
        target = [...document.querySelectorAll(query.selector)].find(visible) || document.querySelector(query.selector);
      } catch {}
    }
    const want = (query.label || (!target && query.selector) || "").trim().toLowerCase();
    if (!target && want) {
      const candidates = [...document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
      const labelOf = (el) => [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.getAttribute("title"), el.id]
        .filter((v) => typeof v === "string")
        .map((v) => v.replace(/\\s+/g, " ").trim().toLowerCase())
        .filter(Boolean);
      target = candidates.find((el) => labelOf(el).some((v) => v === want))
        || candidates.find((el) => labelOf(el).some((v) => v.includes(want)));
    }
    if (!target) return { ok: false, error: "Editable element not found: " + (query.selector || query.label) };
    target.scrollIntoView({ block: "center", inline: "center" });
    if (typeof target.focus === "function") target.focus();
    if (target.isContentEditable) {
      target.textContent = query.text;
    } else {
      const proto = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(target, query.text);
      else target.value = query.text;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ok: true,
      url: location.href,
      title: document.title,
      tagName: target.tagName.toLowerCase(),
    };
  })()`;
}

export function createScoutNativeBrowserAdapter(options: ScoutNativeBrowserOptions = {}): BrowserAdapter {
  const supportDir = options.supportDir ?? join(homedir(), "Library/Application Support");
  const defaultCdpPort = options.cdpPort
    ?? Number(process.env.SCOUT_BROWSER_DEBUG_PORT ?? process.env.ACTION_BROWSER_DEBUG_PORT ?? DEFAULT_CDP_PORT);
  const defaultProfile = options.defaultProfile ?? process.env.SCOUT_BROWSER_PROFILE ?? DEFAULT_PROFILE_NAME;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function discoverProfiles(): Promise<BrowserProfileInfo[]> {
    const [scoutProfiles, actionProfiles] = await Promise.all([
      listProfileDir(join(supportDir, "Scout/ChromeProfiles"), "scout"),
      listProfileDir(join(supportDir, "Action/ChromeProfiles"), "action"),
    ]);
    const seen = new Set(scoutProfiles.map((p) => p.name));
    return [...scoutProfiles, ...actionProfiles.filter((p) => !seen.has(p.name))];
  }

  async function resolveProfileDir(profileName: string): Promise<string> {
    const scoutDir = join(supportDir, "Scout/ChromeProfiles", profileName);
    if (existsSync(scoutDir)) return scoutDir;
    const actionDir = join(supportDir, "Action/ChromeProfiles", profileName);
    if (existsSync(actionDir)) return actionDir;
    await mkdir(scoutDir, { recursive: true });
    return scoutDir;
  }

  async function probeCdpPort(port: number): Promise<{ port: number; wsUrl?: string } | null> {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_200),
      });
      if (!response.ok) return null;
      const payload = (await response.json().catch(() => ({}))) as { webSocketDebuggerUrl?: string };
      return { port, wsUrl: payload.webSocketDebuggerUrl };
    } catch {
      return null;
    }
  }

  async function findLiveCdpPort(profileName?: string): Promise<{ port: number; wsUrl?: string } | null> {
    const names = [profileName, defaultProfile].filter((v): v is string => Boolean(v));
    for (const name of names) {
      for (const root of ["Scout/ChromeProfiles", "Action/ChromeProfiles"]) {
        const activePort = await readDevToolsActivePort(join(supportDir, root, name));
        if (activePort) {
          const hit = await probeCdpPort(activePort);
          if (hit) return hit;
        }
      }
    }
    return probeCdpPort(defaultCdpPort);
  }

  async function defaultLaunchChrome(args: {
    chromeBin: string;
    profileDir: string;
    cdpPort: number;
    url?: string;
    background?: boolean;
  }): Promise<void> {
    const chromeArgs = [
      `--user-data-dir=${args.profileDir}`,
      `--remote-debugging-port=${args.cdpPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      ...(args.url ? [args.url] : ["about:blank"]),
    ];
    if (process.platform === "darwin" && args.background) {
      const appBundle = args.chromeBin.includes(".app/Contents/MacOS/")
        ? args.chromeBin.slice(0, args.chromeBin.indexOf(".app/Contents/MacOS/") + 4)
        : args.chromeBin;
      const child = spawn("open", ["-n", "-g", "-a", appBundle, "--args", ...chromeArgs], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return;
    }
    const child = spawn(args.chromeBin, chromeArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  async function ensureCdpReady(profileName: string, url?: string, background?: boolean): Promise<{ port: number; wsUrl?: string }> {
    const existing = await findLiveCdpPort(profileName);
    if (existing) return existing;

    const chromeBin = resolveChromeBinary(options.chromeBin);
    if (!chromeBin) {
      throw new Error("Google Chrome was not found on this host. Set SCOUT_CHROME_BIN or install Google Chrome.");
    }
    const profileDir = await resolveProfileDir(profileName);
    const launcher = options.launchChrome ?? defaultLaunchChrome;
    await launcher({ chromeBin, profileDir, cdpPort: defaultCdpPort, url, background });

    const deadline = Date.now() + CHROME_LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const activePort = (await readDevToolsActivePort(profileDir)) ?? defaultCdpPort;
      const ready = await probeCdpPort(activePort);
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Managed Chrome launched with profile '${profileName}' but DevTools did not respond on port ${defaultCdpPort}.`);
  }

  async function listPageTargets(port: number): Promise<CdpTarget[]> {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Chrome CDP /json/list returned HTTP ${response.status}`);
    const targets = (await response.json()) as CdpTarget[];
    return targets.filter((t) => t.type === "page" && Boolean(t.webSocketDebuggerUrl));
  }

  async function pickTarget(port: number, request: BrowserActionRequest): Promise<CdpTarget> {
    const targets = await listPageTargets(port);
    if (targets.length === 0) {
      throw new Error("Managed Chrome has no open page tabs. Call browser_open first.");
    }
    if (request.tabId) {
      const exact = targets.find((t) => t.id === request.tabId);
      if (exact) return exact;
    }
    if (request.url) {
      const matched = targets.find((t) => t.url === request.url || t.url.startsWith(request.url!));
      if (matched) return matched;
    }
    return targets[0]!;
  }

  async function openNewTab(port: number, url: string): Promise<CdpTarget> {
    const encoded = encodeURIComponent(url);
    for (const method of ["PUT", "GET"] as const) {
      try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/json/new?${encoded}`, {
          method,
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const target = (await res.json()) as CdpTarget;
          if (target.webSocketDebuggerUrl) return target;
        }
      } catch {
        // try fallback method
      }
    }
    const targets = await listPageTargets(port);
    if (targets[0]) return targets[0];
    throw new Error("Could not create a new tab in managed Chrome.");
  }

  const connectCdp = options.connectCdp ?? ((wsUrl: string) => CdpSession.connect(wsUrl));

  async function withPage<T>(target: CdpTarget, fn: (session: CdpSessionLike) => Promise<T>): Promise<T> {
    const session = await connectCdp(target.webSocketDebuggerUrl!);
    try {
      return await fn(session);
    } finally {
      session.close();
    }
  }

  async function defaultOpenRegularUrl(url: string): Promise<void> {
    if (process.platform === "darwin") {
      await execFileAsync("open", ["-a", "Google Chrome", url], { timeout: 5_000 });
      return;
    }
    await execFileAsync("xdg-open", [url], { timeout: 5_000 });
  }

  return {
    id: "scout-native",

    async health(): Promise<BrowserAdapterHealth> {
      const profiles = await discoverProfiles();
      const live = await findLiveCdpPort();
      const chromeBin = resolveChromeBinary(options.chromeBin);
      if (live) {
        return {
          id: "scout-native",
          available: true,
          mode: "managed",
          bridgeUrl: `http://127.0.0.1:${live.port}`,
          profiles: profiles.map((p, idx) => ({ ...p, active: idx === 0 })),
        };
      }
      return {
        id: "scout-native",
        available: Boolean(chromeBin),
        mode: "managed",
        bridgeUrl: `http://127.0.0.1:${defaultCdpPort}`,
        profiles,
        reason: chromeBin
          ? profiles.length > 0
            ? "Managed non-headless Chrome ready (auto-launches on first open)."
            : `Non-headless Chrome ready (auto-creates '${defaultProfile}' profile on first open).`
          : "Google Chrome binary not found on this host.",
      };
    },

    async execute(request: BrowserActionRequest, lease?: BrowserLease): Promise<BrowserReceipt> {
      const at = Date.now();
      const profileName = request.profile ?? lease?.profile ?? defaultProfile;

      if (request.action === "profiles") {
        const profiles = await discoverProfiles();
        return {
          ok: true,
          action: "profiles",
          adapter: "scout-native",
          mode: "managed",
          leaseId: lease?.leaseId,
          controlAvailable: true,
          data: { profiles, defaultProfile },
          at,
        };
      }

      if (request.mode === "regular") {
        if (request.action === "open" && request.url) {
          try {
            const opener = options.openRegularUrl ?? defaultOpenRegularUrl;
            await opener(request.url);
            return {
              ok: true,
              action: "open",
              adapter: "scout-native",
              mode: "regular",
              leaseId: lease?.leaseId,
              url: request.url,
              controlAvailable: false,
              data: { note: "Opened in regular Chrome (open-only handoff; use Scout Computer or Scout Browser Companion for DOM control)." },
              at,
            };
          } catch (error) {
            return {
              ok: false,
              action: "open",
              adapter: "scout-native",
              mode: "regular",
              leaseId: lease?.leaseId,
              url: request.url,
              controlAvailable: false,
              error: error instanceof Error ? error.message : String(error),
              at,
            };
          }
        }
        return {
          ok: false,
          action: request.action,
          adapter: "scout-native",
          mode: "regular",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: false,
          error: "Regular Chrome is open-only; use managed Chrome (scout-native), Scout Browser Companion (scout-companion), or computer_* tools.",
          at,
        };
      }

      try {
        if (request.action === "open") {
          if (!request.url) {
            return {
              ok: false,
              action: "open",
              adapter: "scout-native",
              mode: "managed",
              leaseId: lease?.leaseId,
              controlAvailable: true,
              error: "browser open requires a url.",
              at,
            };
          }
          const wasRunning = Boolean(await findLiveCdpPort(profileName));
          const cdp = await ensureCdpReady(profileName, request.url, request.background);
          let target: CdpTarget;
          if (!wasRunning) {
            target = await pickTarget(cdp.port, { ...request, url: request.url });
          } else if (request.newTab) {
            target = await openNewTab(cdp.port, request.url);
          } else {
            const targets = await listPageTargets(cdp.port);
            target = targets[0] ?? await openNewTab(cdp.port, request.url);
          }
          const pageInfo = await withPage(target, async (session) => {
            await session.call("Page.enable");
            if (!request.background) {
              await session.call("Page.bringToFront").catch(() => {});
            }
            if (wasRunning && !request.newTab && target.url !== request.url) {
              await session.call("Page.navigate", { url: request.url! });
            }
            // Wait briefly for initial DOM ready so immediate snapshot/screenshot sees the page.
            const waitDeadline = Date.now() + 4_000;
            while (Date.now() < waitDeadline) {
              const state = await session.evaluate<{ readyState: string; url: string; title: string }>(
                "({ readyState: document.readyState, url: location.href, title: document.title })",
              ).catch(() => null);
              if (state && state.readyState !== "loading" && (state.url !== "about:blank" || request.url === "about:blank")) {
                return state;
              }
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
            return session.evaluate<{ readyState: string; url: string; title: string }>(
              "({ readyState: document.readyState, url: location.href, title: document.title })",
            );
          });
          return {
            ok: true,
            action: "open",
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: pageInfo.url || request.url,
            title: pageInfo.title,
            controlAvailable: true,
            data: { tabId: target.id, cdpPort: cdp.port, profile: profileName },
            at,
          };
        }

        const cdp = await findLiveCdpPort(profileName);
        if (!cdp) {
          return {
            ok: false,
            action: request.action,
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            controlAvailable: false,
            error: `Managed Chrome is not running for profile '${profileName}'. Call browser_open first.`,
            at,
          };
        }

        if (request.action === "tabs") {
          const targets = await listPageTargets(cdp.port);
          return {
            ok: true,
            action: "tabs",
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            controlAvailable: true,
            data: {
              cdpPort: cdp.port,
              tabs: targets.map((t, idx) => ({ id: t.id, title: t.title, url: t.url, active: idx === 0 })),
            },
            at,
          };
        }

        if (request.action === "close") {
          if (request.scope === "browser" && cdp.wsUrl) {
            const browserSession = await connectCdp(cdp.wsUrl);
            try {
              await browserSession.call("Browser.close");
            } finally {
              browserSession.close();
            }
            return {
              ok: true,
              action: "close",
              adapter: "scout-native",
              mode: "managed",
              leaseId: lease?.leaseId,
              controlAvailable: true,
              data: { closed: "browser", cdpPort: cdp.port },
              at,
            };
          }
          const target = await pickTarget(cdp.port, request);
          await fetchImpl(`http://127.0.0.1:${cdp.port}/json/close/${encodeURIComponent(target.id)}`, {
            signal: AbortSignal.timeout(3_000),
          });
          return {
            ok: true,
            action: "close",
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: target.url,
            title: target.title,
            controlAvailable: true,
            data: { closed: "tab", tabId: target.id },
            at,
          };
        }

        const target = await pickTarget(cdp.port, request);

        if (request.action === "snapshot") {
          const snapshot = await withPage(target, (session) =>
            session.evaluate<{
              url: string;
              title: string;
              viewport?: { width: number; height: number; deviceScaleFactor?: number };
              elements: unknown[];
              textExcerpt: string;
            }>(SNAPSHOT_SCRIPT),
          );
          return {
            ok: true,
            action: "snapshot",
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: snapshot.url,
            title: snapshot.title,
            viewport: snapshot.viewport,
            controlAvailable: true,
            snapshot,
            data: { tabId: target.id, elementCount: snapshot.elements.length },
            at,
          };
        }

        if (request.action === "click") {
          const result = await withPage(target, (session) =>
            session.evaluate<{ ok: boolean; error?: string; url?: string; title?: string; tagName?: string; text?: string }>(
              buildClickScript(request.selector, request.label),
            ),
          );
          return {
            ok: result.ok,
            action: "click",
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: result.url ?? target.url,
            title: result.title ?? target.title,
            controlAvailable: true,
            data: result,
            error: result.ok ? undefined : (result.error ?? "Click failed"),
            at,
          };
        }

        if (request.action === "fill") {
          const result = await withPage(target, (session) =>
            session.evaluate<{ ok: boolean; error?: string; url?: string; title?: string; tagName?: string }>(
              buildFillScript(request.selector, request.label, request.text ?? ""),
            ),
          );
          return {
            ok: result.ok,
            action: "fill",
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: result.url ?? target.url,
            title: result.title ?? target.title,
            controlAvailable: true,
            data: result,
            error: result.ok ? undefined : (result.error ?? "Fill failed"),
            at,
          };
        }

        if (request.action === "resize") {
          await withPage(target, async (session) => {
            if (request.reset || !request.viewport) {
              await session.call("Emulation.clearDeviceMetricsOverride");
            } else {
              await session.call("Emulation.setDeviceMetricsOverride", {
                width: request.viewport.width,
                height: request.viewport.height,
                deviceScaleFactor: request.viewport.deviceScaleFactor ?? 2,
                mobile: Boolean(request.viewport.mobile),
              });
            }
          });
          return {
            ok: true,
            action: "resize",
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: target.url,
            title: target.title,
            viewport: request.reset ? undefined : request.viewport,
            controlAvailable: true,
            data: { reset: Boolean(request.reset), tabId: target.id },
            at,
          };
        }

        if (request.action === "screenshot") {
          const shot = await withPage(target, async (session) => {
            await session.call("Page.enable");
            const { data } = await session.call<{ data: string }>("Page.captureScreenshot", {
              format: "png",
            });
            const meta = await session.evaluate<{ url: string; title: string }>(
              "({ url: location.href, title: document.title })",
            ).catch(() => ({ url: target.url, title: target.title }));
            return { data, ...meta };
          });
          const outPath = request.outputPath?.trim()
            || join(tmpdir(), `scout-browser-${at}.png`);
          const bytes = Buffer.from(shot.data, "base64");
          await writeFile(outPath, bytes);
          return {
            ok: true,
            action: "screenshot",
            adapter: "scout-native",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: shot.url,
            title: shot.title,
            controlAvailable: true,
            artifactPath: outPath,
            data: { bytes: bytes.length, tabId: target.id },
            at,
          };
        }

        return {
          ok: false,
          action: request.action,
          adapter: "scout-native",
          mode: "managed",
          leaseId: lease?.leaseId,
          url: target.url,
          controlAvailable: true,
          error: `Action '${request.action}' is not supported by scout-native.`,
          at,
        };
      } catch (error) {
        return {
          ok: false,
          action: request.action,
          adapter: "scout-native",
          mode: "managed",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: false,
          error: error instanceof Error ? error.message : String(error),
          at,
        };
      }
    },
  };
}
