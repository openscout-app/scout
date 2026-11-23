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
   * The runtime-issued credential for this turn (`st1.…`). Present it with an
   * action taken for the asker; a surface that checks access refuses an agent
   * action on someone's behalf without one. It expires, and dies with the flight.
   */
  turn?: { credential: string; flightId: string; expiresAt: number };
}
