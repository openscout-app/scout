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
        source: "scout-computer",
        available: true,
        binaryPath: "/Applications/ScoutComputer.app/Contents/MacOS/ScoutComputer",
        agentUrl: "ws://127.0.0.1:4319",
        agentConnected: true,
        driveState: "idle",
        activeLeaseId: null,
        layer: { active: false, owner: "caller" },
        permissions: { accessibility: "granted", screenRecording: "granted" },
      };
    },
    async driveStatus() {
      return { connected: true, state: "idle", leases: [] };
    },
    async driveBegin(opts) {
      return { source: "scout-computer", ok: true, action: "drive_begin", leaseId: "lease-1", data: opts, at: 1000 };
    },
    async driveRelease(opts) {
      return { source: "scout-computer", ok: true, action: "drive_release", leaseId: opts.leaseId, at: 1000 };
    },
    async driveNote(opts) {
      return { source: "scout-computer", ok: true, action: "drive_note", leaseId: opts.leaseId, data: { line: opts.line }, at: 1000 };
    },
    async layerStatus() {
      return { active: true, owner: "caller", pid: 4242, subject: { bundleId: "com.google.Chrome" } };
    },
    async layerOpen(opts) {
      return { source: "scout-computer", ok: true, action: "layer_open", data: { active: true, subject: opts }, at: 1000 };
    },
    async layerClose() {
      return { source: "scout-computer", ok: true, action: "layer_close", data: { active: false }, at: 1000 };
    },
    async layerSnapshot(opts) {
      return { source: "scout-computer", ok: true, action: "layer_snapshot", outputPath: opts?.out ?? "/tmp/layer.png", at: 1000 };
    },
    async layerPip() {
      return { source: "scout-computer", ok: true, action: "layer_pip", data: { active: true }, at: 1000 };
    },
    async listWindows(opts) {
      return { source: "scout-computer", ok: true, action: "windows", data: { query: opts ?? {}, windows: [{ id: 1, title: "Scout" }] }, at: 1000 };
    },
    async screenshot(opts) {
      return { source: "scout-computer", ok: true, action: "screenshot", outputPath: opts?.outputPath ?? "/tmp/test.png", at: 1000 };
    },
    async focus(opts) {
      return { source: "scout-computer", ok: true, action: "focus", data: opts, at: 1000 };
    },
    async inspect(opts) {
      return { source: "scout-computer", ok: true, action: "inspect", data: { target: opts, elements: [] }, at: 1000 };
    },
    async act(opts) {
      return { source: "scout-computer", ok: true, action: opts.kind, data: opts, at: 1000 };
    },
  };
}

describe("MCP scout_computer_* tools", () => {
  test("registers and executes all 15 scout_computer_* tools", async () => {
    const server = new McpServer({ name: "scout-computer-test", version: "0.0.1" });
    registerComputerTools(server, fakeComputerClient());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "scout_computer_act",
        "scout_computer_drive_begin",
        "scout_computer_drive_note",
        "scout_computer_drive_release",
        "scout_computer_drive_status",
        "scout_computer_focus",
        "scout_computer_inspect",
        "scout_computer_layer_close",
        "scout_computer_layer_open",
        "scout_computer_layer_pip",
        "scout_computer_layer_snapshot",
        "scout_computer_layer_status",
        "scout_computer_screenshot",
        "scout_computer_status",
        "scout_computer_windows",
      ]);

      for (const tool of tools) {
        expect(tool.name.startsWith("scout_computer_")).toBe(true);
        expect(tool.title?.startsWith("Scout Computer · ")).toBe(true);
      }

      const statusRes = await client.callTool({ name: "scout_computer_status", arguments: {} });
      expect(statusRes.isError).toBe(false);
      expect(JSON.parse((statusRes.content as Array<{ text: string }>)[0]!.text).agentConnected).toBe(true);

      const driveRes = await client.callTool({
        name: "scout_computer_drive_begin",
        arguments: { task: "Verify settings" },
      });
      expect(driveRes.isError).toBe(false);
      expect(JSON.parse((driveRes.content as Array<{ text: string }>)[0]!.text).leaseId).toBe("lease-1");

      const noteRes = await client.callTool({
        name: "scout_computer_drive_note",
        arguments: { line: "Checking robots.txt", leaseId: "lease-1" },
      });
      expect(noteRes.isError).toBe(false);
      expect(JSON.parse((noteRes.content as Array<{ text: string }>)[0]!.text).data.line).toBe("Checking robots.txt");

      const layerOpenRes = await client.callTool({
        name: "scout_computer_layer_open",
        arguments: { bundleId: "com.google.Chrome", windowTitle: "Cloudflare" },
      });
      expect(layerOpenRes.isError).toBe(false);
      expect(JSON.parse((layerOpenRes.content as Array<{ text: string }>)[0]!.text).action).toBe("layer_open");

      const layerSnapRes = await client.callTool({
        name: "scout_computer_layer_snapshot",
        arguments: { out: "/tmp/layer-snap.png" },
      });
      expect(layerSnapRes.isError).toBe(false);
      expect(JSON.parse((layerSnapRes.content as Array<{ text: string }>)[0]!.text).outputPath).toBe("/tmp/layer-snap.png");

      const actRes = await client.callTool({
        name: "scout_computer_act",
        arguments: { kind: "click", x: 10, y: 20 },
      });
      expect(actRes.isError).toBe(false);
      expect(JSON.parse((actRes.content as Array<{ text: string }>)[0]!.text).action).toBe("click");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
