import { describe, expect, test } from "bun:test";
import type { BrowserActionRequest, BrowserAdapterHealth, BrowserReceipt } from "@openscout/protocol";
import { BrowserRouter, type BrowserAdapter } from "./adapter.js";
import { createBrowserUseAdapter } from "./browser-use.js";
import { createScoutSafariAdapter } from "./scout-safari.js";

function fakeAdapter(
  id: BrowserAdapter["id"],
  available: boolean,
  mode: BrowserAdapterHealth["mode"] = "managed",
): BrowserAdapter {
  return {
    id,
    async health() {
      return { id, available, mode };
    },
    async execute(request: BrowserActionRequest): Promise<BrowserReceipt> {
      return {
        ok: true,
        action: request.action,
        adapter: id,
        mode,
        url: request.url,
        controlAvailable: true,
        at: 1_000,
      };
    },
  };
}

describe("BrowserRouter", () => {
  test("selects scout-companion first, then scout-native, then browser-use", async () => {
    const router = new BrowserRouter([
      fakeAdapter("browser-use", true, "managed"),
      fakeAdapter("scout-native", true, "managed"),
      fakeAdapter("scout-companion", true, "companion"),
    ]);
    const receipt = await router.execute({ action: "snapshot", driverId: "agent-1" });
    expect(receipt.ok).toBe(true);
    expect(receipt.adapter).toBe("scout-companion");

    const fallbackRouter = new BrowserRouter([
      fakeAdapter("scout-companion", false, "companion"),
      fakeAdapter("scout-native", false, "managed"),
      fakeAdapter("browser-use", true, "managed"),
    ]);
    const fallback = await fallbackRouter.execute({ action: "snapshot", driverId: "agent-1" });
    expect(fallback.ok).toBe(true);
    expect(fallback.adapter).toBe("browser-use");
  });

  test("enforces single-driver lease exclusivity", async () => {
    const router = new BrowserRouter([fakeAdapter("scout-companion", true, "companion")], { now: () => 10_000 });
    const acquired = await router.acquireLease({ driverId: "agent-a" });
    expect(acquired.ok).toBe(true);

    const blocked = await router.acquireLease({ driverId: "agent-b" });
    expect(blocked.ok).toBe(false);

    const refused = await router.execute({ action: "snapshot", driverId: "agent-b" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("agent-a");

    expect(router.releaseLease("agent-a")).toBe(true);
    const next = await router.acquireLease({ driverId: "agent-b" });
    expect(next.ok).toBe(true);
  });

  test("blocks disallowed origins and secret-cutoff observations", async () => {
    const router = new BrowserRouter([fakeAdapter("scout-companion", true, "companion")]);
    const denied = await router.execute({
      action: "open",
      driverId: "agent-a",
      url: "https://other.example/page",
      policy: { allowOrigins: ["https://allowed.example"] },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("Origin not permitted");

    const cutoff = await router.execute({
      action: "screenshot",
      driverId: "agent-a",
      url: "https://console.example/api-keys",
      policy: { secretCutoffOrigins: ["https://console.example"] },
    });
    expect(cutoff.ok).toBe(false);
    expect(cutoff.error).toContain("secret cutoff");
  });

  test("browser-use adapter runs open and goal actions via injected runner", async () => {
    const calls: string[][] = [];
    const adapter = createBrowserUseAdapter({
      binary: "/usr/local/bin/browser-use",
      runImpl: async (_cmd, args) => {
        calls.push(args);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    const res = await adapter.execute({ action: "open", driverId: "a", url: "https://example.com" });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([["open", "https://example.com"]]);
  });

  test("scout-safari adapter opens URLs and snapshots active tab via injected osascript", async () => {
    const adapter = createScoutSafariAdapter({
      platform: "darwin",
      safariExists: async () => true,
      runScript: async (_script, args) => {
        if (args?.[0]?.startsWith("https://")) return { code: 0, stdout: args[0], stderr: "" };
        return { code: 0, stdout: JSON.stringify({ url: "https://example.com", title: "Example", interactive: [] }), stderr: "" };
      },
    });
    expect((await adapter.health()).available).toBe(true);
    const opened = await adapter.execute({ action: "open", driverId: "a", url: "https://example.com" });
    expect(opened.ok).toBe(true);
    const snap = await adapter.execute({ action: "snapshot", driverId: "a" });
    expect(snap.ok).toBe(true);
    expect(snap.title).toBe("Example");
  });
});
