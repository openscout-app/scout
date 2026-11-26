import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutNativeBrowserAdapter } from "./scout-native.ts";

function makeSupportDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "scout-native-test-"));
  mkdirSync(join(dir, "Scout", "ChromeProfiles", "agent-browser"), { recursive: true });
  mkdirSync(join(dir, "Action", "ChromeProfiles", "work"), { recursive: true });
  mkdirSync(join(dir, "Action", "ChromeProfiles", "agent-browser"), { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("scout-native browser adapter", () => {
  test("discovers Scout and Action Chrome profiles with Scout taking precedence", async () => {
    const { dir, cleanup } = makeSupportDir();
    try {
      const adapter = createScoutNativeBrowserAdapter({
        supportDir: dir,
        chromeBin: process.execPath,
        fetchImpl: (async () => new Response("offline", { status: 503 })) as typeof fetch,
      });

      const receipt = await adapter.execute({ action: "profiles" });
      expect(receipt.ok).toBe(true);
      expect(receipt.adapter).toBe("scout-native");
      const profiles = (receipt.data as { profiles: Array<{ name: string; source: string }> }).profiles;
      expect(profiles.map((p) => `${p.name}:${p.source}`)).toEqual([
        "agent-browser:scout",
        "work:action",
      ]);
    } finally {
      cleanup();
    }
  });

  test("discovers live DevTools port from DevToolsActivePort file", async () => {
    const { dir, cleanup } = makeSupportDir();
    try {
      writeFileSync(join(dir, "Scout", "ChromeProfiles", "agent-browser", "DevToolsActivePort"), "9444\n/devtools/browser/abc\n");
      const seenUrls: string[] = [];
      const adapter = createScoutNativeBrowserAdapter({
        supportDir: dir,
        cdpPort: 9334,
        chromeBin: process.execPath,
        fetchImpl: (async (input: string | URL | Request) => {
          const url = String(input);
          seenUrls.push(url);
          if (url === "http://127.0.0.1:9444/json/version") {
            return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/browser/abc" });
          }
          if (url === "http://127.0.0.1:9444/json/list") {
            return Response.json([
              { id: "tab-1", type: "page", title: "Example", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/tab-1" },
            ]);
          }
          return new Response("not found", { status: 404 });
        }) as typeof fetch,
      });

      const health = await adapter.health();
      expect(health.available).toBe(true);
      expect(health.bridgeUrl).toBe("http://127.0.0.1:9444");
      expect(seenUrls).toContain("http://127.0.0.1:9444/json/version");

      const tabsReceipt = await adapter.execute({ action: "tabs" });
      expect(tabsReceipt.ok).toBe(true);
      const tabs = (tabsReceipt.data as { tabs: Array<{ id: string; url: string }> }).tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]?.id).toBe("tab-1");
    } finally {
      cleanup();
    }
  });

  test("auto-launches non-headless Chrome on open when idle and supports regular mode handoff", async () => {
    const { dir, cleanup } = makeSupportDir();
    try {
      let launched = false;
      let launchedProfileDir = "";
      let openedRegularUrl = "";

      const cdpMethods: string[] = [];
      const adapter = createScoutNativeBrowserAdapter({
        supportDir: dir,
        cdpPort: 9399,
        chromeBin: process.execPath,
        connectCdp: async () => ({
          async call(method) {
            cdpMethods.push(method);
            if (method === "Page.captureScreenshot") {
              return { data: Buffer.from("fake-png").toString("base64") } as never;
            }
            return {} as never;
          },
          async evaluate(expr) {
            if (expr.includes("readyState")) {
              return { readyState: "complete", url: "https://openscout.app", title: "OpenScout" } as never;
            }
            if (expr.includes("interactive")) {
              return { url: "https://openscout.app", title: "OpenScout", text: "Hello", interactive: [] } as never;
            }
            return { ok: true, url: "https://openscout.app", title: "OpenScout" } as never;
          },
          close() {},
        }),
        launchChrome: async ({ profileDir }) => {
          launched = true;
          launchedProfileDir = profileDir;
        },
        openRegularUrl: async (url) => {
          openedRegularUrl = url;
        },
        fetchImpl: (async (input: string | URL | Request) => {
          const url = String(input);
          if (!launched) throw new Error("ECONNREFUSED");
          if (url === "http://127.0.0.1:9399/json/version") {
            return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:9399/devtools/browser/1" });
          }
          if (url === "http://127.0.0.1:9399/json/list") {
            return Response.json([
              { id: "tab-1", type: "page", title: "Docs", url: "https://openscout.app", webSocketDebuggerUrl: "ws://127.0.0.1:9399/devtools/page/tab-1" },
            ]);
          }
          if (url.startsWith("http://127.0.0.1:9399/json/close/")) {
            return new Response("Target is closing", { status: 200 });
          }
          return new Response("not found", { status: 404 });
        }) as typeof fetch,
      });

      const regularReceipt = await adapter.execute({
        action: "open",
        mode: "regular",
        url: "https://openscout.app/docs",
      });
      expect(regularReceipt.ok).toBe(true);
      expect(regularReceipt.mode).toBe("regular");
      expect(openedRegularUrl).toBe("https://openscout.app/docs");
      expect(launched).toBe(false);

      const managedReceipt = await adapter.execute({
        action: "open",
        mode: "managed",
        profile: "work",
        url: "https://openscout.app",
      });
      expect(launched).toBe(true);
      expect(launchedProfileDir).toBe(join(dir, "Action", "ChromeProfiles", "work"));
      expect(managedReceipt.ok).toBe(true);
      expect(managedReceipt.mode).toBe("managed");
      expect(managedReceipt.url).toBe("https://openscout.app");
      expect(cdpMethods).toContain("Page.enable");

      const resizeReceipt = await adapter.execute({
        action: "resize",
        viewport: { width: 390, height: 844, mobile: true },
      });
      expect(resizeReceipt.ok).toBe(true);
      expect(cdpMethods).toContain("Emulation.setDeviceMetricsOverride");

      const shotReceipt = await adapter.execute({
        action: "screenshot",
        outputPath: join(dir, "shot.png"),
      });
      expect(shotReceipt.ok).toBe(true);
      expect(shotReceipt.artifactPath).toBe(join(dir, "shot.png"));

      const closeReceipt = await adapter.execute({ action: "close", tabId: "tab-1" });
      expect(closeReceipt.ok).toBe(true);
      expect((closeReceipt.data as { tabId?: string }).tabId).toBe("tab-1");
    } finally {
      cleanup();
    }
  });
});
