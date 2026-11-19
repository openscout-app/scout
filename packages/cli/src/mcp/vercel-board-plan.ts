import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { VercelBoardPlanRequest, VercelBoardPlanResponse } from "@openscout/protocol";

export type VercelBoardPlanToolDeps = {
  plan: (request: VercelBoardPlanRequest) => Promise<VercelBoardPlanResponse>;
  resolveSender: (senderId: string | undefined, currentDirectory: string | undefined) => Promise<string>;
};

function createTextContent(value: unknown): [{ type: "text"; text: string }] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** The Board planning tool. It writes planned tasks to a connected Board; ordinary tasks between agents stay in Scout. */
export function registerVercelBoardPlanTool(server: McpServer, deps: VercelBoardPlanToolDeps): void {
  server.registerTool(
    "vercel_board_plan",
    {
      title: "Plan Work on a Vercel Board",
      description:
        "Write planned tasks to a connected Vercel Board, with needs between them. This is the only way Scout puts work on a Board; use it for planned work only, never for ordinary tasks between agents (use ask for those). "
        + "OUTWARD-FACING: each task is posted on the team's board as the operator, and Board's own sync can carry it to Slack or GitHub. "
        + "A planned task is open to any worker under the operator's principal from the moment it is written. "
        + "The tool creates Board tasks only. They show in the channel's Scout room (conversationId); none becomes a Scout work item unless the operator promotes it. "
        + "Pass the Scout task you are planning for as planningTaskId (it is written on each task as a label) and a stable requestId: the same requestId returns the same tasks.",
      inputSchema: z.object({
        currentDirectory: z.string().optional(),
        senderId: z.string().optional(),
        connectionId: z.string().describe("The board connection, as scout integration status vercel-board names it."),
        channel: z.string().describe("A followed Board channel, for example scout/work."),
        planningTaskId: z.string().describe("The Scout task or work item this plan serves."),
        requestId: z.string().describe("Idempotency key for the whole plan."),
        tasks: z.array(z.object({
          key: z.string().optional().describe("A name for this task inside the plan, so later tasks can need it."),
          text: z.string().describe("The task as the board shows it. First line is the title."),
          labels: z.record(z.string(), z.string()).optional(),
          needs: z.array(z.union([z.string(), z.object({ key: z.string() })])).optional().describe("Board task IDs, or { key } of an earlier task in this plan."),
        })).min(1).max(50),
      }),
      outputSchema: z.object({
        senderId: z.string(),
        connectionId: z.string(),
        channel: z.string(),
        conversationId: z.string(),
        tasks: z.array(z.object({ taskId: z.string(), key: z.string().optional(), state: z.string() })),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ currentDirectory, senderId, connectionId, channel, planningTaskId, requestId, tasks }) => {
      const resolvedSenderId = await deps.resolveSender(senderId, currentDirectory);
      const result = await deps.plan({ connectionId, channel, planningTaskId, requestId, actorId: resolvedSenderId, tasks });
      const structuredContent = { senderId: resolvedSenderId, ...result };
      return { content: createTextContent(structuredContent), structuredContent };
    },
  );
}
