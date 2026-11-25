import {
  normalizeReservedRuntimeProfileId,
  normalizeRuntimeProfileReasoningEffort,
  type InvocationExecutionPreference,
  type ScoutReservedRuntimeProfileId,
} from "@openscout/protocol";

export interface BrokerRuntimeProfile {
  id: ScoutReservedRuntimeProfileId;
  displayName: string;
  supportsReasoningEffort: boolean;
  execution: InvocationExecutionPreference & { session: "new" };
}

const BROKER_RUNTIME_PROFILES: Record<ScoutReservedRuntimeProfileId, BrokerRuntimeProfile> = {
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    supportsReasoningEffort: true,
    execution: { harness: "antigravity", session: "new" },
  },
  fable: {
    id: "fable",
    displayName: "Fable",
    supportsReasoningEffort: true,
    execution: { harness: "claude", model: "fable", session: "new" },
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi",
    supportsReasoningEffort: false,
    execution: { harness: "kimi", session: "new" },
  },
  grok: {
    id: "grok",
    displayName: "Grok",
    supportsReasoningEffort: false,
    execution: { harness: "grok", session: "new" },
  },
  opus: {
    id: "opus",
    displayName: "Opus",
    supportsReasoningEffort: true,
    execution: { harness: "claude", model: "opus", session: "new" },
  },
  oc: {
    id: "oc",
    displayName: "OpenCode",
    supportsReasoningEffort: false,
    execution: { harness: "opencode", session: "new" },
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    supportsReasoningEffort: false,
    execution: { harness: "opencode", session: "new" },
  },
};

export function resolveBrokerRuntimeProfile(
  profileId: string,
): BrokerRuntimeProfile | null {
  const normalized = normalizeReservedRuntimeProfileId(profileId);
  return normalized ? BROKER_RUNTIME_PROFILES[normalized] : null;
}

export function executionForBrokerRuntimeProfile(input: {
  profileId: string;
  reasoningEffort?: string;
}): InvocationExecutionPreference | null {
  const profile = resolveBrokerRuntimeProfile(input.profileId);
  if (!profile) {
    return null;
  }
  const reasoningEffort = input.reasoningEffort
    ? normalizeRuntimeProfileReasoningEffort(input.reasoningEffort)
    : null;
  if (input.reasoningEffort && !reasoningEffort) {
    return null;
  }
  if (reasoningEffort && !profile.supportsReasoningEffort) {
    return null;
  }
  return {
    ...profile.execution,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
