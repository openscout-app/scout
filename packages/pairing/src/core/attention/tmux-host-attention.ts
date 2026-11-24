import type { WebAgent } from "../../shared/api/web.ts";
import type { TmuxHostAttentionRead, TmuxHostAttentionTarget } from "@openscout/protocol";
import { collectTmuxHostAttention as collect, detectClaudeTmuxHostAttention as detect } from "@openscout/runtime/daemon";

/** Private presentation compatibility, also used by the pending Herdr adopter. */
export type TmuxHostAttentionItem = {
  id: string; agentId: string; agentName: string; sessionId: string;
  title: string; summary: string; detail: string | null; updatedAt: number; sourceLabel: string;
};
export type TmuxHostAttentionCapture = (agent: WebAgent, paneTarget: string) => Promise<string | null | { body: string; truncated?: boolean }>;
export function detectClaudeTmuxHostAttention(paneBody: string, input: {
  agentId: string; agentName: string; sessionId: string; now?: number;
}): TmuxHostAttentionItem | null {
  const prompt = detect(paneBody);
  return prompt ? present(prompt, input.agentId, input.agentName, input.sessionId, input.now ?? Date.now()) : null;
}
export async function collectTmuxHostAttention(agents: readonly WebAgent[], capture: TmuxHostAttentionCapture, options: {
  nodeId: string | null; now?: number; captureTimeoutMs?: number; maxCandidates?: number; captureConcurrency?: number;
}): Promise<{ items: TmuxHostAttentionItem[]; read: TmuxHostAttentionRead }> {
  // State ranking is a private product view, not a terminal-host capability.
  const candidates = agents.filter(agent => agent.harness === "claude" && agent.transport === "tmux"
    && !agent.retiredFromFleet && !agent.staleLocalRegistration && agent.terminalSurface?.backend === "tmux"
    && Boolean(agent.terminalSurface.sessionName.trim()))
    .sort((a, b) => hostAttentionStateRank(a.state) - hostAttentionStateRank(b.state)
      || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
  const byId = new Map(candidates.map(agent => [agent.id, agent]));
  const targets: TmuxHostAttentionTarget[] = options.nodeId ? candidates.map(agent => ({
    ref: { nodeId: agent.homeNodeId ?? agent.authorityNodeId ?? options.nodeId!, backend: "tmux",
      hostSession: agent.terminalSurface!.sessionName,
      ...(agent.terminalSurface!.paneId ? { paneId: agent.terminalSurface!.paneId } : {}) },
    harness: agent.harness!, label: agent.name, agentId: agent.id,
    ...(agent.harnessSessionId ? { nativeSession: { nodeId: agent.homeNodeId ?? agent.authorityNodeId ?? options.nodeId!,
      harness: agent.harness!, nativeSessionId: agent.harnessSessionId } } : {}),
  })) : [];
  const read = await collect({ nodeId: options.nodeId, targets, now: options.now, limits: options,
    capture: async (ref, context) => {
      const agent = byId.get(context.target.agentId ?? "");
      return agent ? capture(agent, ref.paneId ?? ref.hostSession) : null;
    },
  });
  return { read, items: read.observations.flatMap(row => row.prompt && row.agentId
    ? [present(row.prompt, row.agentId, row.label, row.ref.hostSession, row.observedAt)] : []) };
}
function present(prompt: { title: string; summary: string; detail: string | null }, agentId: string, agentName: string, sessionId: string, now: number): TmuxHostAttentionItem {
  return { id: `tmux-host-permission:${agentId}:${sessionId}`, agentId, agentName, sessionId,
    title: prompt.title, summary: prompt.summary, detail: prompt.detail, updatedAt: now, sourceLabel: "Claude terminal prompt" };
}
function hostAttentionStateRank(state: string | null): number {
  const value = state?.trim().toLowerCase();
  return value === "needs_attention" || value === "needs-attention" ? 0
    : value === "working" || value === "active" || value === "running" || value === "in_turn" ? 1
      : value === "in_flight" || value === "queued" || value === "waking" || value === "dispatching" ? 2 : 3;
}
