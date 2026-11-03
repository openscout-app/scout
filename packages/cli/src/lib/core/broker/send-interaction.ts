import { parseScoutComposerRouteTarget } from "@openscout/protocol";

export const LEGACY_ASK_COMPLETION_TAG = /\[ask:[^\]\s]+\]/i;

export type ScoutSendInteraction = "work" | "message";

// Directed sends are tracked work; every reply-shaped or group-shaped route
// stays message-only so completion notifications and legacy [ask:...] answers
// can never recursively launch work on the requester, and channel members are
// never woken. Execution intent is never inferred from body mentions. Shared
// by retained transport callers so they preserve
// one classification.
export function classifySendInteraction(input: {
  targetLabel?: string;
  targetRef?: string;
  channel?: string;
  body: string;
}): ScoutSendInteraction {
  if (!input.targetLabel?.trim() || input.targetRef?.trim() || input.channel?.trim()) {
    return "message";
  }
  const parsed = parseScoutComposerRouteTarget(input.targetLabel);
  if (
    parsed?.kind === "channel"
    || parsed?.kind === "broadcast"
    || parsed?.kind === "binding_ref"
  ) {
    return "message";
  }
  if (LEGACY_ASK_COMPLETION_TAG.test(input.body)) {
    return "message";
  }
  return "work";
}
