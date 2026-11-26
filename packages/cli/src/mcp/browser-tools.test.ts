import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserActionRequest, BrowserReceipt } from "@openscout/protocol";
import { BrowserRouter, type BrowserAdapter } from "@openscout/runtime";
import { registerBrowserTools } from "./browser-tools.ts";

function fakeAdapter(id: BrowserAdapter["id"]): BrowserAdapter {
  return {
    id,
    async health() {
      return { id, available: true, mode: id === "scout-companion" ? "companion" : "managed" };
    },
    async execute(request: BrowserActionRequest): Promise<BrowserReceipt> {
      return {
        ok: true,
        action: request.action,
        adapter: id,
        mode: id === "scout-companion" ? "companion" : "managed",
        url: request.url,
        viewport: request.viewport,
        controlAvailable: true,
        data: request.action === "tabs" ? { tabs: [{ id: "tab-1", url: "https://example.com" }] } : undefined,
        at: 1000,
      };
    },
  };
}

describe("MCP browser tools", () => {
  test("registers and executes all 10 Scout browser_* tools cleanly", async () => {
    const server = new McpServer({ name: "scout-test", version: "0.0.1" });
    const router = new BrowserRouter([fakeAdapter("scout-companion"), fakeAdapter("scout-native")]);
    registerBrowserTools(server, router);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "browser_click",
        "browser_close",
        "browser_fill",
        "browser_open",
        "browser_profiles",
        "browser_resize",
        "browser_screenshot",
        "browser_snapshot",
        "browser_status",
        "browser_tabs",
      ]);

      const tabsRes = await client.callTool({ name: "browser_tabs", arguments: {} });
      expect(tabsRes.isError).toBe(false);
      expect(JSON.parse((tabsRes.content as Array<{ text: string }>)[0]!.text).data.tabs).toHaveLength(1);

      const resizeRes = await client.callTool({
        name: "browser_resize",
        arguments: { width: 390, height: 844, mobile: true },
      });
      expect(resizeRes.isError).toBe(false);
      expect(JSON.parse((resizeRes.content as Array<{ text: string }>)[0]!.text).viewport).toEqual({
        width: 390,
        height: 844,
        deviceScaleFactor: undefined,
        mobile: true,
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
