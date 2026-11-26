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
 * Register Scout Computer's native desktop MCP tools onto the Scout MCP server.
 */
export function registerComputerTools(
  server: McpServer,
  client: ScoutComputerClient = createScoutComputerClient(),
): void {
  server.registerTool(
    "computer_status",
    {
      description: "Check Scout Computer availability, background agent connection, and macOS Accessibility and Screen Recording permissions.",
      inputSchema: {},
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
    "computer_windows",
    {
      description: "List on-screen macOS windows for an app (by bundleId, app name, or pid), or list top-level window order when omitted.",
      inputSchema: {
        bundleId: z.string().optional(),
        app: z.string().optional(),
        pid: z.number().int().positive().optional(),
        raise: z.boolean().optional(),
      },
    },
    async (args) => formatReceipt(await client.listWindows(args)),
  );

  server.registerTool(
    "computer_screenshot",
    {
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
    },
    async (args) => formatReceipt(await client.screenshot(args)),
  );

  server.registerTool(
    "computer_focus",
    {
      description: "Launch or activate a macOS app, or raise and focus a specific window by title via Scout Computer.",
      inputSchema: {
        bundleId: z.string().optional(),
        app: z.string().optional(),
        pid: z.number().int().positive().optional(),
        title: z.string().optional(),
        launch: z.boolean().optional(),
      },
    },
    async (args) => formatReceipt(await client.focus(args)),
  );

  server.registerTool(
    "computer_inspect",
    {
      description: "Inspect a macOS app's Accessibility UI tree via Scout Computer before acting.",
      inputSchema: {
        bundleId: z.string().optional(),
        app: z.string().optional(),
        pid: z.number().int().positive().optional(),
      },
    },
    async (args) => formatReceipt(await client.inspect(args)),
  );

  server.registerTool(
    "computer_act",
    {
      description: "Perform a native desktop action via Scout Computer: click, type, key, scroll, drag, ax_press, ax_set, or ocr.",
      inputSchema: {
        kind: z.enum(["click", "type", "key", "scroll", "drag", "ax_press", "ax_set", "ocr"]),
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
    },
    async (args) => {
      const { bundleId, app, pid, ...rest } = args;
      const target = bundleId || app || pid !== undefined ? { bundleId, app, pid } : undefined;
      return formatReceipt(await client.act({ ...rest, target }));
    },
  );
}
