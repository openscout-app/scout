import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScoutComputerClient } from "@openscout/runtime";
import { registerComputerTools } from "./computer-tools.ts";

function fakeComputerClient(): ScoutComputerClient {
  return {
    async status() {
      return {
        available: true,
        binaryPath: "/Applications/ScoutComputer.app/Contents/MacOS/ScoutComputer",
        agentUrl: "ws://127.0.0.1:4319",
        agentConnected: true,
        permissions: { accessibility: "granted", screenRecording: "granted" },
      };
    },
    async listWindows(opts) {
      return { ok: true, action: "windows", data: { query: opts ?? {}, windows: [{ id: 1, title: "Scout" }] }, at: 1000 };
    },
    async screenshot(opts) {
      return { ok: true, action: "screenshot", outputPath: opts?.outputPath ?? "/tmp/test.png", at: 1000 };
    },
    async focus(opts) {
      return { ok: true, action: "focus", data: opts, at: 1000 };
    },
    async inspect(opts) {
      return { ok: true, action: "inspect", data: { target: opts, elements: [] }, at: 1000 };
    },
    async act(opts) {
      return { ok: true, action: opts.kind, data: opts, at: 1000 };
    },
  };
}

describe("MCP computer tools", () => {
  test("registers and executes all 6 Scout computer_* tools", async () => {
    const server = new McpServer({ name: "scout-computer-test", version: "0.0.1" });
    registerComputerTools(server, fakeComputerClient());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "computer_act",
        "computer_focus",
        "computer_inspect",
        "computer_screenshot",
        "computer_status",
        "computer_windows",
      ]);

      const statusRes = await client.callTool({ name: "computer_status", arguments: {} });
      expect(statusRes.isError).toBe(false);
      const statusText = (statusRes.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(statusText).agentConnected).toBe(true);

      const shotRes = await client.callTool({
        name: "computer_screenshot",
        arguments: { app: "Google Chrome", outputPath: "/tmp/chrome.png" },
      });
      expect(shotRes.isError).toBe(false);
      expect(JSON.parse((shotRes.content as Array<{ text: string }>)[0]!.text).outputPath).toBe("/tmp/chrome.png");

      const actRes = await client.callTool({
        name: "computer_act",
        arguments: { kind: "click", x: 10, y: 20 },
      });
      expect(actRes.isError).toBe(false);
      expect(JSON.parse((actRes.content as Array<{ text: string }>)[0]!.text).action).toBe("click");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
