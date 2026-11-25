import { describe, expect, test } from "bun:test";
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
        controlAvailable: true,
        at: 1000,
      };
    },
  };
}

describe("MCP browser tools", () => {
  test("registers Scout browser_* tools cleanly", () => {
    const server = new McpServer({ name: "scout-test", version: "0.0.1" });
    const router = new BrowserRouter([fakeAdapter("scout-companion"), fakeAdapter("browser-use")]);
    expect(() => registerBrowserTools(server, router)).not.toThrow();
  });
});
