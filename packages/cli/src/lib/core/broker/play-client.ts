import { scoutBrokerPaths, type ScoutPlayRunRequest, type ScoutPlayRunResult, type ScoutPlaySummary } from "@openscout/protocol";
import { requestScoutBrokerJson } from "@openscout/runtime/client";
import { resolveBrokerSocketPathForBaseUrl } from "@openscout/runtime/daemon";
import type { ScoutAskReceipt } from "./ask-types.ts";

export function playClient(url: string) {
  const socketPath = resolveBrokerSocketPathForBaseUrl(url);
  return {
    list: () => requestScoutBrokerJson<{ plays: ScoutPlaySummary[] }>(url, scoutBrokerPaths.v1.plays, { socketPath }),
    run: (input: ScoutPlayRunRequest) => requestScoutBrokerJson<ScoutPlayRunResult>(url, scoutBrokerPaths.v1.playsRun,
      { method: "POST", body: input, socketPath }),
  };
}

// The runtime returns the broker's delivery receipt. Adapt it only for the
// existing CLI/MCP ask presentation; native clients use the wire receipt.
export function playAskReceipt({ receipt }: ScoutPlayRunResult): ScoutAskReceipt {
  const { workId, flightId, invocationId, bindingRef, sessionAlias, conversationId, messageId, targetAgentId } = receipt;
  return { ok: true, state: "queued", executionResolution: receipt.executionResolution, workPageUnavailable: receipt.workPageUnavailable,
    ids: { workId, flightId, invocationId, bindingRef, sessionAlias, conversationId, messageId, targetAgentId, sessionId: receipt.targetSessionId } };
}
