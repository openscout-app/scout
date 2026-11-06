import { basename } from "node:path";

import {
  BUILT_IN_AGENT_DEFINITION_IDS,
  normalizeAgentSelectorSegment,
  parseScoutComposerRouteTarget,
} from "@openscout/protocol";
import {
  buildRelayAgentInstance,
  findNearestProjectRoot,
  readProjectConfig,
  readRelayAgentOverrides,
} from "@openscout/runtime/setup";
import { isCodingAgentHost } from "@openscout/runtime";
import { resolveOperatorName } from "@openscout/runtime/user-config";

export function resolveScoutAgentName(agentName?: string | null): string {
  const trimmed = agentName?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (process.env.OPENSCOUT_AGENT?.trim()) {
    return process.env.OPENSCOUT_AGENT.trim();
  }
  return resolveOperatorName();
}

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export function resolveHerdrAgentName(env: NodeJS.ProcessEnv): string | null {
  const herdrEnv = env.HERDR_ENV?.trim().toLowerCase();
  if (!herdrEnv || !TRUTHY_ENV_VALUES.has(herdrEnv)) {
    return null;
  }
  if (!env.HERDR_PANE_ID?.trim()) {
    return null;
  }
  return normalizeAgentSelectorSegment(env.HERDR_AGENT_NAME ?? "") || null;
}

export function resolveHumanAskSenderName(
  agentName: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (agentName?.trim()) {
    return agentName.trim();
  }
  if (isCodingAgentHost(env)) {
    return undefined;
  }
  return "operator";
}

function resolveConfiguredSenderIdForProjectRoot(
  overrides: Awaited<ReturnType<typeof readRelayAgentOverrides>>,
  projectRoot: string,
  preferredDefinitionIds: string[] = [],
  allowProjectFallback = true,
): string | null {
  let fallbackSenderId: string | null = null;
  const normalizedPreferredDefinitionIds = preferredDefinitionIds
    .map((value) => normalizeAgentSelectorSegment(value))
    .filter(Boolean);

  for (const preferredDefinitionId of normalizedPreferredDefinitionIds) {
    for (const [agentId, override] of Object.entries(overrides)) {
      if (BUILT_IN_AGENT_DEFINITION_IDS.has(agentId)) {
        continue;
      }
      if (!override.projectRoot || override.projectRoot !== projectRoot) {
        continue;
      }
      if (override.definitionId === preferredDefinitionId) {
        return agentId;
      }
    }
  }

  if (!allowProjectFallback) {
    return null;
  }

  for (const [agentId, override] of Object.entries(overrides)) {
    if (BUILT_IN_AGENT_DEFINITION_IDS.has(agentId)) {
      continue;
    }
    if (!override.projectRoot || override.projectRoot !== projectRoot) {
      continue;
    }
    fallbackSenderId ??= agentId;
  }
  return fallbackSenderId;
}

async function inferSenderIdForProjectRoot(
  projectRoot: string,
  preferredDefinitionIds: string[] = [],
): Promise<string> {
  const overrides = await readRelayAgentOverrides();
  const projectConfig = await readProjectConfig(projectRoot);
  const configuredDefinitionId = normalizeAgentSelectorSegment(
    projectConfig?.agent?.id?.trim() ?? "",
  );
  const normalizedPreferredDefinitionIds = preferredDefinitionIds
    .map((value) => normalizeAgentSelectorSegment(value))
    .filter(Boolean);
  const preferredDefinitionId = normalizedPreferredDefinitionIds[0];
  if (preferredDefinitionId) {
    const preferredSenderId = resolveConfiguredSenderIdForProjectRoot(
      overrides,
      projectRoot,
      [preferredDefinitionId],
      false,
    );
    return preferredSenderId
      ?? buildRelayAgentInstance(preferredDefinitionId, projectRoot).id;
  }
  const projectDefaultDefinitionIds = [
    configuredDefinitionId,
    projectConfig?.project?.id,
    basename(projectRoot),
  ].filter((value): value is string => Boolean(value));
  const configuredSenderId = resolveConfiguredSenderIdForProjectRoot(
    overrides,
    projectRoot,
    projectDefaultDefinitionIds,
  );
  if (configuredSenderId) {
    return configuredSenderId;
  }

  const definitionId =
    configuredDefinitionId ||
    normalizeAgentSelectorSegment(basename(projectRoot)) ||
    "agent";
  return buildRelayAgentInstance(definitionId, projectRoot).id;
}

export async function resolveScoutSenderId(
  agentName: string | null | undefined,
  currentDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (agentName?.trim()) {
    return agentName.trim();
  }
  if (env.OPENSCOUT_AGENT?.trim()) {
    return env.OPENSCOUT_AGENT.trim();
  }
  const herdrAgentName = resolveHerdrAgentName(env);
  const projectRoot = await findNearestProjectRoot(currentDirectory);
  if (!projectRoot) {
    return herdrAgentName
      ? buildRelayAgentInstance(herdrAgentName, currentDirectory).id
      : resolveOperatorName();
  }
  return inferSenderIdForProjectRoot(
    projectRoot,
    herdrAgentName ? [herdrAgentName] : [],
  );
}

/**
 * Rendezvous participants represent the current live harness session when the
 * host exposes one. Ordinary Scout sender resolution intentionally remains
 * project-agent based; Match needs the narrower identity so two concurrent
 * sessions in the same project cannot collapse into one participant.
 */
export async function resolveScoutMatchParticipantId(
  sessionIdOverride: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const sessionId = sessionIdOverride?.trim()
    || env.OPENSCOUT_SESSION_ID?.trim()
    || env.CODEX_THREAD_ID?.trim()
    || env.OPENSCOUT_CODEX_THREAD_ID?.trim()
    || env.CLAUDE_CODE_SESSION_ID?.trim()
    || env.CLAUDE_SESSION_ID?.trim()
    || env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim();
  if (!sessionId) {
    throw new Error(
      "scout match requires a live session identity; run it inside a Claude or Codex session, or pass --session <id>",
    );
  }
  const candidate = sessionId.startsWith("session:")
    ? sessionId
    : `session:${sessionId}`;
  const parsed = parseScoutComposerRouteTarget(candidate);
  if (parsed?.kind !== "session_id" || !parsed.value) {
    throw new Error("match session id is not a valid Scout session address");
  }
  return parsed.value;
}

/** Only a native identity actually supplied by the harness determines this claim. */
export function claimedSessionHarness(sessionId: string | undefined, env: NodeJS.ProcessEnv): "codex" | "claude" | undefined {
  if (!sessionId) return undefined;
  if ([env.CODEX_THREAD_ID, env.OPENSCOUT_CODEX_THREAD_ID].some(id => id?.trim() === sessionId)) return "codex";
  if ([env.CLAUDE_CODE_SESSION_ID, env.CLAUDE_SESSION_ID, env.CLAUDE_CODE_REMOTE_SESSION_ID].some(id => id?.trim() === sessionId)) return "claude";
  return undefined;
}

export function claimedSessionId(env: NodeJS.ProcessEnv): string | undefined {
  return env.CODEX_THREAD_ID?.trim() || env.OPENSCOUT_CODEX_THREAD_ID?.trim()
    || env.CLAUDE_CODE_SESSION_ID?.trim() || env.CLAUDE_SESSION_ID?.trim()
    || env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim() || env.OPENSCOUT_SESSION_ID?.trim() || undefined;
}
