import { invokeAcpAgent, type AcpAgentInvocationResult } from "./acp-agent-invocation.js";

export interface CursorAcpInvocationOptions {
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

export type CursorAcpInvocationResult = AcpAgentInvocationResult;

export async function invokeCursorAcpAgent(
  options: CursorAcpInvocationOptions,
): Promise<CursorAcpInvocationResult> {
  return await invokeAcpAgent({
    ...options,
    adapterType: "cursor-acp",
    label: "Cursor ACP",
    adapterOptions: {
      cursorExtensions: true,
      cursorInteractionMode: "safe_reject",
      permissionMode: "safe_reject",
    },
  });
}
