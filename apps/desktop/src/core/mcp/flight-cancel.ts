import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CancelScoutFlightResult } from "../broker/service.ts";

export function registerFlightCancelTool(server: McpServer, cancel: (flightId: string) => Promise<CancelScoutFlightResult>): void {
  server.registerTool("flight_cancel", {
    title: "Cancel a Queued Flight",
    description: "Cancel a local broker flight only before submission. Uses the broker lifecycle guard, including for thread-held queued delivery. Running/submitting flights are refused; terminal flights return their actual state. Never stops the native app or archives its thread.",
    inputSchema: z.object({ flightId: z.string().trim().min(1).max(200) }),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ flightId }) => {
    const result = await cancel(flightId);
    return { content: [{ type: "text" as const, text: result.ok ? `Flight ${flightId}: ${result.state}` : result.detail }], structuredContent: result, ...(result.ok ? {} : { isError: true }) };
  });
}
