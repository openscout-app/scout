import type { ScoutId } from "./common.js";
import type { InvocationAction } from "./invocations.js";
import type { ScoutTaskCallback } from "./tasks.js";

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
   * The requester's callback (`ask --callback`): a named function the runtime
   * on the worker's host runs when the task completes.
   */
  callback?: ScoutTaskCallback;
}
