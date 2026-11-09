import {
  invokeAcpAgent,
  type AcpAgentInvocationResult,
} from "./acp-agent-invocation.js";

export interface DevinAcpInvocationOptions {
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

export type DevinAcpInvocationResult = AcpAgentInvocationResult;

export async function invokeDevinAcpAgent(
  options: DevinAcpInvocationOptions,
): Promise<DevinAcpInvocationResult> {
  return await invokeAcpAgent({
    ...options,
    adapterType: "devin-acp",
    label: "Devin ACP",
    adapterOptions: {
      // These broker-owned invocations have no attached approval consumer.
      // Devin otherwise waits indefinitely on its first ACP tool call.
      permissionMode: "auto_approve",
      ...(options.adapterOptions ?? {}),
    },
  });
}
