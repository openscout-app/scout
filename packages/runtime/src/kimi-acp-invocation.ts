import {
  invokeAcpAgent,
  type AcpAgentInvocationResult,
} from "./acp-agent-invocation.js";

export interface KimiAcpInvocationOptions {
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
}

export type KimiAcpInvocationResult = AcpAgentInvocationResult;

export async function invokeKimiAcpAgent(
  options: KimiAcpInvocationOptions,
): Promise<KimiAcpInvocationResult> {
  return await invokeAcpAgent({
    ...options,
    adapterType: "kimi-acp",
    label: "Kimi Code ACP",
    adapterOptions: {
      // These broker-owned invocations have no attached approval consumer.
      // Kimi otherwise waits indefinitely on its first ACP tool call.
      permissionMode: "auto_approve",
    },
  });
}
