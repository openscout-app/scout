/**
 * Filesystem path helpers for the web server's read-side queries: home-path
 * compaction and harness log/session resolvers. Lifted from db-queries.ts as
 * part of SCO-031 Phase A.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { localAgentLogsDirectory, resolveOpenScoutPairingHome } from "@openscout/runtime/config";

import { metadataString } from "./parse.ts";

/* ── Compact home paths (~/...) ── */

export const HOME = homedir();

export function compact(p: string | null): string | null {
  if (!p) return null;
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

export function pairingHarnessLogPath(
  adapterType: string | null,
  sessionId: string | null,
): string | null {
  const normalizedAdapter = adapterType?.trim();
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedAdapter || !normalizedSessionId) {
    return null;
  }
  return join(resolveOpenScoutPairingHome(), normalizedAdapter, normalizedSessionId, "logs", "stdout.log");
}

export function localAgentHarnessLogPath(agentId: string): string {
  return join(localAgentLogsDirectory(agentId), "stdout.log");
}

const TRANSPORT_ADAPTER_LOG_NAMESPACE: Record<string, string> = {
  codex_app_server: "codex",
  claude_stream_json: "claude",
  pi_rpc: "pi",
};

function adapterLogNamespaceForTransport(transport: string | null | undefined): string | null {
  const normalized = transport?.trim();
  return normalized ? TRANSPORT_ADAPTER_LOG_NAMESPACE[normalized] ?? null : null;
}

/** Runtime/tmux refs — not provider harness conversation ids. */
export function isTransportSessionRef(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^relay[-:]/i.test(trimmed);
}

function providerHarnessSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || isTransportSessionRef(trimmed)) return null;
  return trimmed;
}

const DEFAULT_PROVIDER_SESSION_METADATA_KEYS = [
  "externalSessionId",
  "threadId",
] as const;

const EXTERNAL_PROVIDER_SESSION_METADATA_KEYS = [
  "externalSessionId",
] as const;

const THREAD_FIRST_PROVIDER_SESSION_METADATA_KEYS = [
  "threadId",
  "externalSessionId",
] as const;

type ProviderSessionMetadataKey = typeof DEFAULT_PROVIDER_SESSION_METADATA_KEYS[number];

type HarnessSessionContext = {
  endpointSessionId: string | null;
  metadata: Record<string, unknown> | undefined;
};

type HarnessSessionResolver = (context: HarnessSessionContext) => string | null;

function normalizedTransport(transport: string | null | undefined): string | null {
  return transport?.trim() || null;
}

function firstProviderHarnessSessionId(candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const sessionId = providerHarnessSessionId(candidate);
    if (sessionId) return sessionId;
  }
  return null;
}

function providerSessionIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: readonly ProviderSessionMetadataKey[],
): string | null {
  return firstProviderHarnessSessionId(keys.map((key) => metadataString(metadata, key)));
}

function resolveNoProviderHarnessSessionId(): string | null {
  return null;
}

/**
 * A tmux endpoint's own session id is the tmux session name, never a harness
 * session. The harness id it exposes is only what the broker observed from the
 * harness's own records and wrote back as the endpoint's external alias.
 */
function resolveObservedOnlyHarnessSessionId({ endpointSessionId, metadata }: HarnessSessionContext): string | null {
  if (metadata?.pendingExternalSession === true || typeof metadata?.externalSessionAdoptedAt === "number") return null;
  const observed = providerHarnessSessionId(metadataString(metadata, "observedSessionId"));
  const evidence = metadata?.observedSessionEvidence;
  if (!observed || observed === endpointSessionId || !evidence || typeof evidence !== "object"
    || (evidence as Record<string, unknown>).source !== "claude-session-record") return null;
  // Conflicting aliases indicate an observation has not repaired the binding.
  for (const key of ["externalSessionId", "nativeSessionId", "threadId"]) {
    const alias = metadataString(metadata, key);
    if (alias && alias !== observed) return null;
  }
  return observed;
}

function resolveDefaultHarnessSessionId({ metadata }: HarnessSessionContext): string | null {
  return providerSessionIdFromMetadata(metadata, DEFAULT_PROVIDER_SESSION_METADATA_KEYS);
}

function resolveThreadFirstHarnessSessionId({ metadata }: HarnessSessionContext): string | null {
  return providerSessionIdFromMetadata(metadata, THREAD_FIRST_PROVIDER_SESSION_METADATA_KEYS);
}

function resolvePairingBridgeHarnessSessionId({ metadata }: HarnessSessionContext): string | null {
  const attachedTransport = metadataString(metadata, "attachedTransport");
  const metadataKeys = attachedTransport === "codex_app_server"
    ? THREAD_FIRST_PROVIDER_SESSION_METADATA_KEYS
    : EXTERNAL_PROVIDER_SESSION_METADATA_KEYS;
  return providerSessionIdFromMetadata(metadata, metadataKeys);
}

function resolveClaudeStreamJsonHarnessSessionId(
  { endpointSessionId, metadata }: HarnessSessionContext,
): string | null {
  const externalSessionId = firstProviderHarnessSessionId([metadataString(metadata, "externalSessionId")]);
  if (externalSessionId) {
    return externalSessionId;
  }

  const runtimeInstanceId = metadataString(metadata, "runtimeInstanceId")
    ?? metadataString(metadata, "runtimeSessionId");
  const endpoint = endpointSessionId?.trim() ?? null;
  if (!endpoint || endpoint === runtimeInstanceId) {
    return null;
  }
  return providerHarnessSessionId(endpoint);
}

function resolvePiRpcHarnessSessionId(
  { endpointSessionId, metadata }: HarnessSessionContext,
): string | null {
  return firstProviderHarnessSessionId([
    metadataString(metadata, "externalSessionId"),
    metadataString(metadata, "threadId"),
    endpointSessionId,
  ]);
}

const HARNESS_SESSION_RESOLVERS: Record<string, HarnessSessionResolver> = {
  tmux: resolveObservedOnlyHarnessSessionId,
  zellij: resolveNoProviderHarnessSessionId,
  pairing_bridge: resolvePairingBridgeHarnessSessionId,
  codex_app_server: resolveThreadFirstHarnessSessionId,
  claude_stream_json: resolveClaudeStreamJsonHarnessSessionId,
  pi_rpc: resolvePiRpcHarnessSessionId,
};

function harnessSessionResolverForTransport(transport: string | null): HarnessSessionResolver {
  if (!transport) return resolveDefaultHarnessSessionId;
  return HARNESS_SESSION_RESOLVERS[transport] ?? resolveDefaultHarnessSessionId;
}

const PREWARMED_CODEX_AGENT_STATE = "available";

function shouldExposeHarnessSessionIdForAgent(
  transport: string | null,
  agentState: string | null | undefined,
): boolean {
  const state = agentState?.trim();
  const isPrewarmedCodexAppServer = normalizedTransport(transport) === "codex_app_server"
    && state === PREWARMED_CODEX_AGENT_STATE;
  return !isPrewarmedCodexAppServer;
}

/** Idle codex app-server sessions keep a persisted thread but lanes bind only on active work. */
export function resolveHarnessSessionIdForAgent(
  transport: string | null,
  endpointSessionId: string | null,
  metadata: Record<string, unknown> | undefined,
  agentState: string | null | undefined,
): string | null {
  const resolved = resolveHarnessSessionId(transport, endpointSessionId, metadata);
  if (!resolved) return null;
  if (!shouldExposeHarnessSessionIdForAgent(transport, agentState)) {
    return null;
  }
  return resolved;
}

export function resolveHarnessSessionId(
  transport: string | null,
  endpointSessionId: string | null,
  metadata: Record<string, unknown> | undefined,
): string | null {
  return harnessSessionResolverForTransport(normalizedTransport(transport))({
    endpointSessionId,
    metadata,
  });
}

type HarnessLogPathContext = {
  agentId: string;
  endpointSessionId: string | null;
  metadata: Record<string, unknown> | undefined;
};

type HarnessLogPathResolver = (context: HarnessLogPathContext) => string | null;

function resolvePairingBridgeHarnessLogPath(
  { endpointSessionId, metadata }: HarnessLogPathContext,
): string | null {
  const pairingSessionId = metadataString(metadata, "pairingSessionId") ?? endpointSessionId;
  const adapterType = metadataString(metadata, "pairingAdapterType")
    ?? adapterLogNamespaceForTransport(metadataString(metadata, "attachedTransport"));
  return pairingHarnessLogPath(adapterType, pairingSessionId);
}

function resolveLocalAgentHarnessLogPath({ agentId }: HarnessLogPathContext): string {
  return localAgentHarnessLogPath(agentId);
}

const HARNESS_LOG_PATH_RESOLVERS: Record<string, HarnessLogPathResolver> = {
  pairing_bridge: resolvePairingBridgeHarnessLogPath,
  codex_app_server: resolveLocalAgentHarnessLogPath,
  claude_stream_json: resolveLocalAgentHarnessLogPath,
  pi_rpc: resolveLocalAgentHarnessLogPath,
};

function harnessLogPathResolverForTransport(transport: string | null): HarnessLogPathResolver | null {
  if (!transport) return null;
  return HARNESS_LOG_PATH_RESOLVERS[transport] ?? null;
}

export function resolveHarnessLogPath(
  agentId: string,
  transport: string | null,
  endpointSessionId: string | null,
  metadata: Record<string, unknown> | undefined,
): string | null {
  const resolver = harnessLogPathResolverForTransport(normalizedTransport(transport));
  return resolver?.({ agentId, endpointSessionId, metadata }) ?? null;
}
