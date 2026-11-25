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
      description: "Report health of Scout's browser adapters (scout-companion, scout-native, browser-use) and the active browser lease.",
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
      description: "List managed Chrome profiles available to Scout (including existing Action profiles).",
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
      description: "Open a URL through Scout's browser surface (defaults to scout-companion -> scout-native -> browser-use).",
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
    "browser_snapshot",
    {
      description: "Capture a DOM/accessibility snapshot of the active page through Scout's browser surface.",
      inputSchema: {
        adapter: adapterSchema,
        url: z.string().optional(),
        secretCutoffOrigins: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "snapshot",
        driverId: defaultDriverId,
        adapter: args.adapter,
        url: args.url,
        policy: args.secretCutoffOrigins?.length ? { secretCutoffOrigins: args.secretCutoffOrigins } : undefined,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_click",
    {
      description: "Click a selector on the active page through Scout's browser surface.",
      inputSchema: {
        selector: z.string().min(1),
        adapter: adapterSchema,
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "click",
        driverId: defaultDriverId,
        selector: args.selector,
        adapter: args.adapter,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_fill",
    {
      description: "Fill text into a selector on the active page through Scout's browser surface.",
      inputSchema: {
        selector: z.string().min(1),
        text: z.string(),
        adapter: adapterSchema,
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "fill",
        driverId: defaultDriverId,
        selector: args.selector,
        text: args.text,
        adapter: args.adapter,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_screenshot",
    {
      description: "Capture a screenshot of the active page through Scout's browser surface.",
      inputSchema: {
        adapter: adapterSchema,
        url: z.string().optional(),
        secretCutoffOrigins: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "screenshot",
        driverId: defaultDriverId,
        adapter: args.adapter,
        url: args.url,
        policy: args.secretCutoffOrigins?.length ? { secretCutoffOrigins: args.secretCutoffOrigins } : undefined,
      });
      return formatReceipt(receipt);
    },
  );

  server.registerTool(
    "browser_close",
    {
      description: "Close the active tab or browser session through Scout's browser surface.",
      inputSchema: {
        scope: z.enum(["tab", "browser"]).optional(),
        adapter: adapterSchema,
      },
    },
    async (args) => {
      const receipt = await router.execute({
        action: "close",
        driverId: defaultDriverId,
        scope: args.scope,
        adapter: args.adapter,
      });
      return formatReceipt(receipt);
    },
  );
}
