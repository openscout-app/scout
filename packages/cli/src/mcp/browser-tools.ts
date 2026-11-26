import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { BROWSER_ADAPTER_IDS, type BrowserReceipt } from "@openscout/protocol";
import { createDefaultBrowserRouter, type BrowserRouter } from "@openscout/runtime";

const adapterSchema = z.enum(BROWSER_ADAPTER_IDS).optional();
const modeSchema = z.enum(["companion", "managed", "regular", "remote"]).optional();

function formatReceipt(receipt: BrowserReceipt) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }],
    isError: !receipt.ok,
  };
}

/**
 * Register Scout Computer's browser_* MCP tools onto the Scout MCP server.
 * All calls route through one shared BrowserRouter so leases, origin
 * allow-lists, secret cutoffs, and adapter fallback apply uniformly.
 */
export function registerBrowserTools(
  server: McpServer,
  router: BrowserRouter = createDefaultBrowserRouter(),
  defaultDriverId = "scout-mcp",
): void {
  server.registerTool(
    "browser_status",
    {
      description: "Check Scout's real non-headless browser adapters (Chrome/Safari companion, managed Chrome over CDP, Safari, external engines) and active lease. Prefer Scout browser tools over headless browsing.",
      inputSchema: {},
    },
    async () => {
      const [adapters, lease] = [await router.health(), router.currentLease()];
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ adapters, lease }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "browser_profiles",
    {
      description: "List persistent non-headless Chrome profiles available to Scout (including existing Action profiles).",
      inputSchema: {},
    },
    async () => {
      const receipt = await router.execute({
        action: "profiles",
        driverId: defaultDriverId,
        adapter: "scout-native",
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_open",
    {
      description: "Open a URL in a real non-headless browser through Scout (prefers live Chrome/Safari companion, then auto-launched managed Chrome over CDP, then Safari). Use this instead of headless browsers.",
      inputSchema: {
        url: z.string().url(),
        profile: z.string().optional(),
        adapter: adapterSchema,
        mode: modeSchema,
        newTab: z.boolean().optional(),
        background: z.boolean().optional(),
        allowOrigins: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "open",
        driverId: defaultDriverId,
        url: args.url,
        profile: args.profile,
        adapter: args.adapter,
        mode: args.mode,
        newTab: args.newTab,
        background: args.background,
        policy: args.allowOrigins?.length ? { allowOrigins: args.allowOrigins } : undefined,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_tabs",
    {
      description: "List open tabs in Scout's active non-headless browser session.",
      inputSchema: {
        profile: z.string().optional(),
        adapter: adapterSchema,
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "tabs",
        driverId: defaultDriverId,
        profile: args.profile,
        adapter: args.adapter,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_snapshot",
    {
      description: "Inspect the live DOM, interactive elements, selectors, and text of the active non-headless browser page.",
      inputSchema: {
        adapter: adapterSchema,
        profile: z.string().optional(),
        tabId: z.string().optional(),
        url: z.string().optional(),
        secretCutoffOrigins: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "snapshot",
        driverId: defaultDriverId,
        adapter: args.adapter,
        profile: args.profile,
        tabId: args.tabId,
        url: args.url,
        policy: args.secretCutoffOrigins?.length ? { secretCutoffOrigins: args.secretCutoffOrigins } : undefined,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_click",
    {
      description: "Click an element on the active page by CSS selector or visible text label.",
      inputSchema: {
        selector: z.string().optional(),
        label: z.string().optional(),
        profile: z.string().optional(),
        tabId: z.string().optional(),
        adapter: adapterSchema,
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "click",
        driverId: defaultDriverId,
        selector: args.selector,
        label: args.label,
        profile: args.profile,
        tabId: args.tabId,
        adapter: args.adapter,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_fill",
    {
      description: "Fill text into an input, textarea, or editable field on the active page by CSS selector or visible label.",
      inputSchema: {
        selector: z.string().optional(),
        label: z.string().optional(),
        text: z.string(),
        profile: z.string().optional(),
        tabId: z.string().optional(),
        adapter: adapterSchema,
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "fill",
        driverId: defaultDriverId,
        selector: args.selector,
        label: args.label,
        text: args.text,
        profile: args.profile,
        tabId: args.tabId,
        adapter: args.adapter,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_resize",
    {
      description: "Resize the active browser viewport (with optional mobile emulation) or reset it to default.",
      inputSchema: {
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        mobile: z.boolean().optional(),
        deviceScaleFactor: z.number().positive().optional(),
        reset: z.boolean().optional(),
        profile: z.string().optional(),
        tabId: z.string().optional(),
        adapter: adapterSchema,
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "resize",
        driverId: defaultDriverId,
        viewport: args.width && args.height
          ? {
              width: args.width,
              height: args.height,
              mobile: args.mobile,
              deviceScaleFactor: args.deviceScaleFactor,
            }
          : undefined,
        reset: args.reset,
        profile: args.profile,
        tabId: args.tabId,
        adapter: args.adapter,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_screenshot",
    {
      description: "Capture a PNG screenshot of the active non-headless browser tab and return the saved file path.",
      inputSchema: {
        adapter: adapterSchema,
        profile: z.string().optional(),
        tabId: z.string().optional(),
        url: z.string().optional(),
        outputPath: z.string().optional(),
        secretCutoffOrigins: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "screenshot",
        driverId: defaultDriverId,
        adapter: args.adapter,
        profile: args.profile,
        tabId: args.tabId,
        url: args.url,
        outputPath: args.outputPath,
        policy: args.secretCutoffOrigins?.length ? { secretCutoffOrigins: args.secretCutoffOrigins } : undefined,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_close",
    {
      description: "Close the active tab or managed browser session.",
      inputSchema: {
        scope: z.enum(["tab", "browser"]).optional(),
        profile: z.string().optional(),
        tabId: z.string().optional(),
        adapter: adapterSchema,
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "close",
        driverId: defaultDriverId,
        scope: args.scope,
        profile: args.profile,
        tabId: args.tabId,
        adapter: args.adapter,
      });
      return formatReceipt(receipt);
    },
  );
}
