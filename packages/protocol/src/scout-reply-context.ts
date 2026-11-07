import type { ScoutId } from "./common.js";
import type { InvocationAction } from "./invocations.js";

export type ScoutReplyPath = "final_response" | "mcp_reply";

export interface ScoutReplyContext {
  mode: "broker_reply";
  fromAgentId: ScoutId;
  toAgentId: ScoutId;
  conversationId: ScoutId;
  messageId: ScoutId;
  replyToMessageId: ScoutId;
  replyPath: ScoutReplyPath;
  action?: InvocationAction;
  completion?: { invocationId: string; flightId: string; revision: number };
  /**
   * The requester's closing step (`ask --when-done`). `requesterNodeId` is set
   * only when the requester is on another host, where the worker cannot act.
   */
  whenDone?: { step: string; requesterNodeId?: ScoutId };
}
