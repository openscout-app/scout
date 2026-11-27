import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ComputerReceipt } from "@openscout/protocol";
import { createScoutComputerClient, type ScoutComputerClient } from "@openscout/runtime";

function formatReceipt(receipt: ComputerReceipt) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }],
    isError: !receipt.ok,
  };
}

/**
 * Register Scout Computer's native desktop MCP tools (`scout_computer_*`) onto
 * the Scout MCP server with drive-lease supervision HUD and off-screen agent
 * layer parity.
 */
export function registerComputerTools(
  server: McpServer,
  client: ScoutComputerClient = createScoutComputerClient(),
): void {
  server.registerTool(
    "scout_computer_status",
    {
      title: "Scout Computer · Status",
      description: "Check Scout Computer availability, background agent connection, active drive lease, agent layer state, and macOS Accessibility and Screen Recording permissions.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const status = await client.status();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        isError: !status.available,
      };
    },
  );

  server.registerTool(
    "scout_computer_drive_begin",
    {
      title: "Scout Computer · Begin Drive Lease",
      description: "Announce that Scout is driving this host and show the agent identity and task in the Scout Computer supervision HUD. Background is the default drive mode.",
      inputSchema: {
        task: z.string().min(1),
        agent: z.string().optional(),
        mode: z.enum(["background", "attention"]).optional(),
        sessionId: z.string().optional(),
        project: z.string().optional(),
        watchBundleId: z.string().optional(),
        showSupervisionLabel: z.boolean().optional(),
        pointerControl: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => formatReceipt(await client.driveBegin(args)),
  );

  server.registerTool(
    "scout_computer_drive_release",
    {
      title: "Scout Computer · Release Drive Lease",
      description: "Give control back to the operator and record a terminal outcome on the Scout Computer drive lease.",
      inputSchema: {
        leaseId: z.string().min(1),
        outcome: z.enum(["done", "failed", "cancelled"]).optional(),
        summary: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => formatReceipt(await client.driveRelease(args)),
  );

  server.registerTool(
    "scout_computer_drive_status",
    {
      title: "Scout Computer · Drive Status",
      description: "Read active and recently completed Scout Computer drive leases from the native agent.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const status = await client.driveStatus();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        isError: !status.connected,
      };
    },
  );

  server.registerTool(
    "scout_computer_drive_note",
    {
      title: "Scout Computer · Drive Note",
      description: "Write a short status beat (under 80 characters) to the floating Scout Computer supervision HUD.",
      inputSchema: {
        line: z.string().min(1),
        leaseId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => formatReceipt(await client.driveNote(args)),
  );

  server.registerTool(
    "scout_computer_layer_open",
    {
      title: "Scout Computer · Open Agent Layer",
      description: "Move an app's windows (or a single window by windowId/windowTitle) onto a private virtual display with a small PiP viewer so Scout can act off the operator's screen using blink acts.",
      inputSchema: {
        bundleId: z.string().optional(),
        pid: z.number().int().positive().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        pip: z.boolean().optional(),
        windowId: z.number().int().positive().optional(),
        windowTitle: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => formatReceipt(await client.layerOpen(args)),
  );

  server.registerTool(
    "scout_computer_layer_close",
    {
      title: "Scout Computer · Close Agent Layer",
      description: "Close the Scout Computer agent layer, restore moved windows to their original frames, and remove the virtual display.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => formatReceipt(await client.layerClose()),
  );

  server.registerTool(
    "scout_computer_layer_status",
    {
      title: "Scout Computer · Agent Layer Status",
      description: "Read whether a Scout Computer agent layer is active: display id, bounds, PiP state, pause/takeover state, and windows on the layer.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const status = await client.layerStatus();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        isError: false,
      };
    },
  );

  server.registerTool(
    "scout_computer_layer_snapshot",
    {
      title: "Scout Computer · Snapshot Agent Layer",
      description: "Write a PNG of what is currently on the Scout Computer agent layer from its running capture feed.",
      inputSchema: {
        windowId: z.number().int().positive().optional(),
        full: z.boolean().optional(),
        out: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async (args) => formatReceipt(await client.layerSnapshot(args)),
  );

  server.registerTool(
    "scout_computer_layer_pip",
    {
      title: "Scout Computer · Show Agent Layer Viewer",
      description: "Bring the Scout Computer agent layer picture-in-picture viewer back after the operator closed it.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => formatReceipt(await client.layerPip()),
  );

  server.registerTool(
    "scout_computer_windows",
    {
      title: "Scout Computer · List Windows",
      description: "List on-screen macOS windows for an app (by bundleId, app name, or pid), or list top-level window z-order when omitted.",
      inputSchema: {
        bundleId: z.string().optional(),
        app: z.string().optional(),
        pid: z.number().int().positive().optional(),
        raise: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => formatReceipt(await client.listWindows(args)),
  );

  server.registerTool(
    "scout_computer_screenshot",
    {
      title: "Scout Computer · Screenshot",
      description: "Capture a native macOS screenshot of an app window, a screen region, or the whole screen via Scout Computer and return the saved PNG path.",
      inputSchema: {
        bundleId: z.string().optional(),
        app: z.string().optional(),
        pid: z.number().int().positive().optional(),
        windowId: z.number().int().positive().optional(),
        outputPath: z.string().optional(),
        region: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        }).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async (args) => formatReceipt(await client.screenshot(args)),
  );

  server.registerTool(
    "scout_computer_focus",
    {
      title: "Scout Computer · Focus Window",
      description: "Launch or activate a macOS app, or raise and focus a specific window by title via Scout Computer.",
      inputSchema: {
        bundleId: z.string().optional(),
        app: z.string().optional(),
        pid: z.number().int().positive().optional(),
        title: z.string().optional(),
        launch: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => formatReceipt(await client.focus(args)),
  );

  server.registerTool(
    "scout_computer_inspect",
    {
      title: "Scout Computer · Inspect Accessibility",
      description: "Inspect a macOS app's Accessibility UI tree via Scout Computer before acting.",
      inputSchema: {
        bundleId: z.string().optional(),
        app: z.string().optional(),
        pid: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => formatReceipt(await client.inspect(args)),
  );

  server.registerTool(
    "scout_computer_act",
    {
      title: "Scout Computer · Desktop Action",
      description: "Perform a native desktop action via Scout Computer (click, type, key, scroll, drag, ax_press, ax_set, ocr). Automatically uses blink acts when targeting an active agent layer; foreground input requires an approved drive lease and explicit target verification.",
      inputSchema: {
        kind: z.enum(["click", "type", "key", "scroll", "drag", "ax_press", "ax_set", "ocr"]),
        leaseId: z.string().optional(),
        bundleId: z.string().optional(),
        app: z.string().optional(),
        pid: z.number().int().positive().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        toX: z.number().optional(),
        toY: z.number().optional(),
        deltaX: z.number().optional(),
        deltaY: z.number().optional(),
        text: z.string().optional(),
        key: z.string().optional(),
        modifiers: z.array(z.string()).optional(),
        title: z.string().optional(),
        role: z.string().optional(),
        value: z.string().optional(),
        imagePath: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (args) => {
      const target = args.bundleId || args.app || args.pid !== undefined
        ? { bundleId: args.bundleId, app: args.app, pid: args.pid }
        : undefined;
      return formatReceipt(await client.act({
        kind: args.kind,
        leaseId: args.leaseId,
        target,
        x: args.x,
        y: args.y,
        toX: args.toX,
        toY: args.toY,
        deltaX: args.deltaX,
        deltaY: args.deltaY,
        text: args.text,
        key: args.key,
        modifiers: args.modifiers,
        title: args.title,
        role: args.role,
        value: args.value,
        imagePath: args.imagePath,
      }));
    },
  );
}
