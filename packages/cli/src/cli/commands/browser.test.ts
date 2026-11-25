import { describe, expect, test } from "bun:test";
import type { BrowserActionRequest, BrowserAdapterHealth, BrowserReceipt } from "@openscout/protocol";
import { BrowserRouter, type BrowserAdapter } from "@openscout/runtime";
import { createScoutCommandContext, type ScoutCommandContext } from "../context.ts";
import { runBrowserCommand } from "./browser.ts";

function makeContext(outputMode: "plain" | "json" = "plain"): { context: ScoutCommandContext; lines: string[] } {
  const lines: string[] = [];
  const context = createScoutCommandContext({
    cwd: process.cwd(),
    env: {},
    outputMode,
    stdout: (line) => { lines.push(line); },
    stderr: (line) => { lines.push(line); },
    isTty: false,
  });
  return { context, lines };
}

function stubAdapter(id: BrowserAdapter["id"], available: boolean, mode: BrowserAdapterHealth["mode"] = "companion"): BrowserAdapter {
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
        data: request.action === "profiles" ? { profiles: [{ name: "work", source: "action" }] } : undefined,
        at: 1000,
      };
    },
  };
}

describe("scout browser CLI", () => {
  test("prints adapter health for status", async () => {
    const router = new BrowserRouter([
      stubAdapter("scout-companion", true, "companion"),
      stubAdapter("browser-use", false, "managed"),
    ]);
    const { context, lines } = makeContext("json");
    await runBrowserCommand(context, ["status", "--json"], router);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as { adapters: BrowserAdapterHealth[] };
    expect(payload.adapters.map((a) => a.id)).toEqual(["scout-companion", "browser-use"]);
  });

  test("routes open through the router and enforces origin allow-lists", async () => {
    const router = new BrowserRouter([stubAdapter("scout-companion", true, "companion")]);
    const okRun = makeContext("plain");
    await runBrowserCommand(okRun.context, ["open", "https://example.com", "--allow-origin", "https://example.com"], router);
    expect(okRun.lines[0]).toContain("open: ok (scout-companion · https://example.com)");

    const blockedRun = makeContext("plain");
    await expect(
      runBrowserCommand(blockedRun.context, ["open", "https://other.example", "--allow-origin", "https://example.com"], router),
    ).rejects.toThrow("Origin not permitted");
  });

  test("lists profiles via scout-native", async () => {
    const router = new BrowserRouter([stubAdapter("scout-native", true, "managed")]);
    const { context, lines } = makeContext("plain");
    await runBrowserCommand(context, ["profiles"], router);
    expect(lines[0]).toBe("work (action)");
  });
});
