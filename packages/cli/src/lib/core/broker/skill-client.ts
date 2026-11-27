import { scoutBrokerPaths, type ScoutSkillRunRequest, type ScoutSkillRunResult, type ScoutSkillSummary } from "@openscout/protocol";
import { requestScoutBrokerJson } from "@openscout/runtime/client";
import { resolveBrokerSocketPathForBaseUrl } from "@openscout/runtime/daemon";
import type { ScoutAskReceipt } from "./ask-types.ts";

export function skillClient(url: string) {
  const socketPath = resolveBrokerSocketPathForBaseUrl(url);
  return {
    list: (harness?: string, host?: string) => {
      const query = new URLSearchParams();
      if (harness !== undefined) query.set("harness", harness);
      if (host !== undefined) query.set("host", host);
      return requestScoutBrokerJson<{ skills: ScoutSkillSummary[] }>(url,
        scoutBrokerPaths.v1.skills + (query.size ? "?" + query : ""), { socketPath });
    },
    run: (input: ScoutSkillRunRequest) => requestScoutBrokerJson<ScoutSkillRunResult>(url, scoutBrokerPaths.v1.skillsRun,
      { method: "POST", body: input, socketPath }),
  };
}

// The runtime returns the broker's delivery receipt. Adapt it only for the
// existing CLI/MCP ask presentation; native clients use the wire receipt.
export function skillAskReceipt({ receipt }: ScoutSkillRunResult): ScoutAskReceipt {
  const { workId, flightId, invocationId, bindingRef, sessionAlias, conversationId, messageId, targetAgentId } = receipt;
  return { ok: true, state: "queued", executionResolution: receipt.executionResolution, workPageUnavailable: receipt.workPageUnavailable,
    ids: { workId, flightId, invocationId, bindingRef, sessionAlias, conversationId, messageId, targetAgentId, sessionId: receipt.targetSessionId } };
}
