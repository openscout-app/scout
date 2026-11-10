import {
  invokeAcpAgent,
  type AcpAgentInvocationResult,
} from "./acp-agent-invocation.js";

export interface OpencodeAcpInvocationOptions {
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

export type OpencodeAcpInvocationResult = AcpAgentInvocationResult;

function requestedModel(options: OpencodeAcpInvocationOptions): string | null {
  const model = options.adapterOptions?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

/**
 * OpenCode can report a provider-side rejection or an ACP-incompatible model as
 * a *successful* turn that emitted no text and burned no tokens. Left alone
 * that reaches Scout as an agent which replied with nothing, which is far worse
 * than a failure: it looks like a working provider and silently poisons a
 * rotation. A real turn always spends input tokens on the prompt, so zero usage
 * plus no output is never legitimate.
 */
function assertProviderProducedATurn(
  result: AcpAgentInvocationResult,
  options: OpencodeAcpInvocationOptions,
): void {
  if (result.output.trim()) {
    return;
  }

  const usage = result.usage;
  const spentTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.totalTokens ?? 0);
  if (spentTokens > 0) {
    return;
  }

  const model = requestedModel(options);
  throw new Error(
    `OpenCode ACP returned an empty turn without consuming any tokens`
    + `${model ? ` for model "${model}"` : ""}.`
    + ` The model may be unavailable, temporarily rejected, or incompatible with`
    + ` OpenCode's ACP transport. Run \`opencode run -m <model> "hi"\` to inspect`
    + ` provider errors; if that succeeds, choose a different model for OpenCode ACP.`,
  );
}

export async function invokeOpencodeAcpAgent(
  options: OpencodeAcpInvocationOptions,
): Promise<OpencodeAcpInvocationResult> {
  const result = await invokeAcpAgent({
    ...options,
    adapterType: "opencode-acp",
    label: "OpenCode ACP",
  });

  assertProviderProducedATurn(result, options);
  return result;
}
