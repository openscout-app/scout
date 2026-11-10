import {
  invokeAcpAgent,
  type AcpAgentInvocationResult,
} from "./acp-agent-invocation.js";

export interface GrokAcpInvocationOptions {
  sessionId: string;
  poolKey?: string;
  resumeSessionId?: string;
  cwd: string;
  prompt: string;
  /** Provider-native ACP session id, reported as soon as the session exists. */
  onNativeSession?: (nativeSessionId: string) => Promise<void> | void;
  name?: string;
  timeoutMs?: number;
  hardCeilingMs?: number;
  adapterOptions?: Record<string, unknown>;
}

export type GrokAcpInvocationResult = AcpAgentInvocationResult;

export async function invokeGrokAcpAgent(
  options: GrokAcpInvocationOptions,
): Promise<GrokAcpInvocationResult> {
  return await invokeAcpAgent({
    ...options,
    adapterType: "grok-acp",
    label: "Grok ACP",
    // Interactive. A session/request_permission is raised to the operator and
    // answered with the ACP result. Kimi and Devin pass auto_approve instead.
  });
}
