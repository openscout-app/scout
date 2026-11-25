/**
 * Scout Safari adapter for macOS: drives Safari tabs via AppleScript /
 * `do JavaScript` (async osascript, never sync exec) and detects Safari +
 * `safaridriver` availability. Pairs naturally with the Safari Web Extension
 * variant of Scout's browser companion.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type {
  BrowserActionRequest,
  BrowserAdapterHealth,
  BrowserLease,
  BrowserReceipt,
} from "@openscout/protocol";
import type { BrowserAdapter } from "./adapter.js";

const OSASCRIPT_TIMEOUT_MS = 20_000;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runOsaScript(script: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      reject(new Error("Safari AppleScript timed out."));
    }, OSASCRIPT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

function safariErrorHint(stderr: string): string {
  if (/Allow JavaScript from Apple Events/i.test(stderr)) {
    return "Safari blocked AppleScript JavaScript. Enable Safari > Settings > Developer > Allow JavaScript from Apple Events (or use the Scout Safari Web Extension companion).";
  }
  return stderr.trim().slice(0, 300) || "Safari command failed.";
}

export type ScoutSafariAdapterOptions = {
  platform?: NodeJS.Platform;
  safariExists?: () => Promise<boolean>;
  runScript?: typeof runOsaScript;
};

export function createScoutSafariAdapter(options: ScoutSafariAdapterOptions = {}): BrowserAdapter {
  const platform = options.platform ?? process.platform;
  const safariExists = options.safariExists ?? (() => pathExists("/Applications/Safari.app"));
  const runScript = options.runScript ?? runOsaScript;

  return {
    id: "scout-safari",

    async health(): Promise<BrowserAdapterHealth> {
      if (platform !== "darwin") {
        return {
          id: "scout-safari",
          available: false,
          mode: "managed",
          reason: "Safari automation is only available on macOS.",
        };
      }
      const installed = await safariExists();
      return {
        id: "scout-safari",
        available: installed,
        mode: "managed",
        reason: installed ? undefined : "Safari.app not found.",
      };
    },

    async execute(request: BrowserActionRequest, lease?: BrowserLease): Promise<BrowserReceipt> {
      const at = Date.now();
      const status = await this.health();
      if (!status.available) {
        return {
          ok: false,
          action: request.action,
          adapter: "scout-safari",
          mode: "managed",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: false,
          error: status.reason ?? "Safari is unavailable.",
          at,
        };
      }

      try {
        if (request.action === "open" && request.url) {
          const script = request.newTab
            ? `on run argv
  set targetUrl to item 1 of argv
  tell application "Safari"
    if (count of windows) = 0 then make new document
    tell front window
      set newTab to make new tab with properties {URL:targetUrl}
      set current tab to newTab
    end tell
    return URL of current tab of front window
  end tell
end run`
            : `on run argv
  set targetUrl to item 1 of argv
  tell application "Safari"
    if (count of windows) = 0 then
      make new document with properties {URL:targetUrl}
    else
      set URL of current tab of front window to targetUrl
    end if
    return URL of current tab of front window
  end tell
end run`;
          const res = await runScript(script, [request.url]);
          if (res.code !== 0) {
            return { ok: false, action: "open", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, url: request.url, controlAvailable: false, error: safariErrorHint(res.stderr), at };
          }
          return { ok: true, action: "open", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, url: res.stdout.trim() || request.url, controlAvailable: true, at };
        }

        if (request.action === "tabs") {
          const script = `tell application "Safari"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (name of t) & tab & (URL of t) & linefeed
    end repeat
  end repeat
  return out
end tell`;
          const res = await runScript(script);
          if (res.code !== 0) {
            return { ok: false, action: "tabs", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, controlAvailable: false, error: safariErrorHint(res.stderr), at };
          }
          const tabs = res.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
              const [title, url] = line.split("\t");
              return { title: title ?? "", url: url ?? "" };
            });
          return { ok: true, action: "tabs", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, controlAvailable: true, data: { tabs }, at };
        }

        if (request.action === "snapshot") {
          const js = `(() => JSON.stringify({ url: location.href, title: document.title, interactive: [...document.querySelectorAll('a,button,input,textarea,select,[role=button]')].slice(0, 60).map((el, i) => ({ index: i, tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80) })) }))()`;
          const script = `on run argv
  tell application "Safari"
    return do JavaScript (item 1 of argv) in current tab of front window
  end tell
end run`;
          const res = await runScript(script, [js]);
          if (res.code !== 0) {
            return { ok: false, action: "snapshot", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, controlAvailable: false, error: safariErrorHint(res.stderr), at };
          }
          let snapshot: unknown = res.stdout.trim();
          try { snapshot = JSON.parse(res.stdout.trim()); } catch { /* keep raw */ }
          const snapObj = typeof snapshot === "object" && snapshot !== null ? snapshot as { url?: string; title?: string } : {};
          return {
            ok: true,
            action: "snapshot",
            adapter: "scout-safari",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: snapObj.url,
            title: snapObj.title,
            controlAvailable: true,
            snapshot,
            at,
          };
        }

        if (request.action === "click" && request.selector) {
          const js = `(() => { const el = document.querySelector(${JSON.stringify(request.selector)}); if (!el) return 'MISSING'; el.click(); return 'OK'; })()`;
          const script = `on run argv
  tell application "Safari"
    return do JavaScript (item 1 of argv) in current tab of front window
  end tell
end run`;
          const res = await runScript(script, [js]);
          if (res.code !== 0 || res.stdout.trim() === "MISSING") {
            return {
              ok: false,
              action: "click",
              adapter: "scout-safari",
              mode: "managed",
              leaseId: lease?.leaseId,
              controlAvailable: true,
              error: res.stdout.trim() === "MISSING" ? `Selector not found in Safari: ${request.selector}` : safariErrorHint(res.stderr),
              at,
            };
          }
          return { ok: true, action: "click", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, controlAvailable: true, at };
        }

        if (request.action === "fill" && request.selector) {
          const js = `(() => { const el = document.querySelector(${JSON.stringify(request.selector)}); if (!el) return 'MISSING'; el.focus(); el.value = ${JSON.stringify(request.text ?? "")}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'OK'; })()`;
          const script = `on run argv
  tell application "Safari"
    return do JavaScript (item 1 of argv) in current tab of front window
  end tell
end run`;
          const res = await runScript(script, [js]);
          if (res.code !== 0 || res.stdout.trim() === "MISSING") {
            return {
              ok: false,
              action: "fill",
              adapter: "scout-safari",
              mode: "managed",
              leaseId: lease?.leaseId,
              controlAvailable: true,
              error: res.stdout.trim() === "MISSING" ? `Selector not found in Safari: ${request.selector}` : safariErrorHint(res.stderr),
              at,
            };
          }
          return { ok: true, action: "fill", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, controlAvailable: true, at };
        }

        if (request.action === "close") {
          const script = request.scope === "browser"
            ? `tell application "Safari" to close front window`
            : `tell application "Safari" to close current tab of front window`;
          const res = await runScript(script);
          if (res.code !== 0) {
            return { ok: false, action: "close", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, controlAvailable: false, error: safariErrorHint(res.stderr), at };
          }
          return { ok: true, action: "close", adapter: "scout-safari", mode: "managed", leaseId: lease?.leaseId, controlAvailable: true, at };
        }

        return {
          ok: false,
          action: request.action,
          adapter: "scout-safari",
          mode: "managed",
          leaseId: lease?.leaseId,
          controlAvailable: true,
          error: `Unsupported Safari action: ${request.action}`,
          at,
        };
      } catch (error) {
        return {
          ok: false,
          action: request.action,
          adapter: "scout-safari",
          mode: "managed",
          leaseId: lease?.leaseId,
          controlAvailable: false,
          error: error instanceof Error ? error.message : "Safari automation failed.",
          at,
        };
      }
    },
  };
}
