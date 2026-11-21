import { basename, resolve } from "node:path";

import {
  normalizeAgentSelectorSegment,
  type AgentDefinition,
  type AgentEndpoint,
} from "@openscout/protocol";

import {
  buildManagedPairingEndpointBinding,
  buildPairingSessionCandidate,
  type PairingSession,
} from "./pairing-session-agents.js";
import type { LiveTerminalSession } from "./live-terminal-session.js";
import { resolveAgentLabel, type RuntimeSnapshot } from "./scout-dispatcher.js";

export type ManagedLocalSessionTransport = "codex_app_server" | "claude_stream_json";

export function localAgentMetadataSource(metadata: Record<string, unknown> | undefined): string | null {
  const source = metadata?.source;
  return typeof source === "string" && source.trim().length > 0 ? source : null;
}

export function localAgentMetadataFlag(metadata: Record<string, unknown> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

export function isGeneratedLocalAgentMetadata(metadata: Record<string, unknown> | undefined): boolean {
  const source = localAgentMetadataSource(metadata);
  return source === "relay-agent-registry" || source === "project-inferred";
}

export function isPairingSessionMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return localAgentMetadataSource(metadata) === "pairing-session";
}

export function isManagedPairingSessionMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return isPairingSessionMetadata(metadata) && localAgentMetadataFlag(metadata, "managedByScout");
}

export function isLegacyPairingSessionMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return isPairingSessionMetadata(metadata) && !localAgentMetadataFlag(metadata, "managedByScout");
}

export function isLocalSessionMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return localAgentMetadataSource(metadata) === "local-session";
}

export function isManagedLocalSessionMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return isLocalSessionMetadata(metadata) && localAgentMetadataFlag(metadata, "managedByScout");
}

export function pairingExternalSessionId(endpoint: AgentEndpoint): string | null {
  const direct = endpoint.sessionId?.trim();
  if (direct) {
    return direct;
  }

  const external = endpoint.metadata?.externalSessionId;
  return typeof external === "string" && external.trim().length > 0 ? external.trim() : null;
}

export function normalizeManagedAgentSelector(value: string): string {
  const normalized = normalizeAgentSelectorSegment(value.trim().replace(/^@+/, ""));
  if (!normalized) {
    throw new Error("Alias must contain at least one alphanumeric character.");
  }
  return `@${normalized}`;
}

export function selectorHandle(selector: string): string {
  return selector.replace(/^@+/, "");
}

export function uniqueManagedAgentSelector(
  snapshot: RuntimeSnapshot,
  requestedSelector: string,
  options: {
    nodeId: string;
    isInactiveLocalAgent: (agent: AgentDefinition | undefined) => boolean;
    currentAgentId?: string;
  },
): string {
  const normalized = normalizeManagedAgentSelector(requestedSelector);
  const base = selectorHandle(normalized);
  let candidate = normalized;

  for (let counter = 2; counter <= 101; counter += 1) {
    const resolution = resolveAgentLabel(snapshot, candidate, {
      preferLocalNodeId: options.nodeId,
      helpers: { isStale: options.isInactiveLocalAgent },
    });

    if (resolution.kind === "unknown") {
      return candidate;
    }

    if (resolution.kind === "resolved" && resolution.agent.id === options.currentAgentId) {
      return candidate;
    }

    candidate = `@${base}-${counter}`;
  }

  throw new Error(`Unable to allocate a unique Scout alias for ${normalized}.`);
}

export function pairingAgentDisplayName(session: PairingSession): string {
  return buildPairingSessionCandidate(session).name;
}

export function buildManagedPairingAgent(input: {
  session: PairingSession;
  selector: string;
  displayName?: string;
  nodeId: string;
  createId: (prefix: string) => string;
}): AgentDefinition {
  const id = input.createId("pairing-agent");
  const displayName = input.displayName?.trim() || pairingAgentDisplayName(input.session);
  const handle = selectorHandle(input.selector);
  return {
    id,
    kind: "agent",
    definitionId: id,
    displayName,
    handle,
    labels: ["pairing", "managed", input.session.adapterType],
    metadata: {
      source: "scout-managed",
      managedByScout: true,
      identityKind: "scout_managed_pairing_agent",
      externalSource: "pairing-session",
      selector: input.selector,
      defaultSelector: input.selector,
      sessionBacked: true,
    },
    selector: input.selector,
    defaultSelector: input.selector,
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "manual",
    homeNodeId: input.nodeId,
    authorityNodeId: input.nodeId,
    advertiseScope: "local",
  };
}

export function updateManagedSessionAgent(
  agent: AgentDefinition,
  input: {
    selector?: string;
    displayName?: string;
  },
): AgentDefinition {
  const nextSelector = input.selector ?? agent.selector ?? agent.defaultSelector
    ?? (typeof agent.metadata?.selector === "string" ? String(agent.metadata.selector) : undefined);
  const nextDisplayName = input.displayName?.trim() || agent.displayName;
  const nextMetadata = {
    ...(agent.metadata ?? {}),
    managedByScout: true,
    sessionBacked: true,
    ...(nextSelector ? { selector: nextSelector, defaultSelector: nextSelector } : {}),
  };

  return {
    ...agent,
    displayName: nextDisplayName,
    handle: nextSelector ? selectorHandle(nextSelector) : agent.handle,
    selector: nextSelector,
    defaultSelector: nextSelector ?? agent.defaultSelector,
    metadata: nextMetadata,
  };
}

export function managedLocalSessionDefaultDisplayName(input: {
  transport: ManagedLocalSessionTransport;
  projectRoot?: string;
  cwd: string;
}): string {
  const projectName = basename(input.projectRoot ?? input.cwd) || input.cwd;
  return input.transport === "codex_app_server"
    ? `Codex (${projectName})`
    : `Claude (${projectName})`;
}

export function suggestedManagedLocalSessionSelector(input: {
  transport: ManagedLocalSessionTransport;
  projectRoot?: string;
  cwd: string;
}): string {
  const projectName = normalizeAgentSelectorSegment(basename(input.projectRoot ?? input.cwd) || "session") || "session";
  const prefix = input.transport === "codex_app_server" ? "codex" : "claude";
  return `@${prefix}-${projectName}`;
}

export function buildManagedLocalSessionAgent(input: {
  transport: ManagedLocalSessionTransport;
  selector: string;
  cwd: string;
  projectRoot?: string;
  displayName?: string;
  nodeId: string;
  createId: (prefix: string) => string;
}): AgentDefinition {
  const id = input.createId("local-session-agent");
  const displayName = input.displayName?.trim() || managedLocalSessionDefaultDisplayName(input);
  const handle = selectorHandle(input.selector);
  return {
    id,
    kind: "agent",
    definitionId: id,
    displayName,
    handle,
    labels: ["local-session", "managed", input.transport],
    metadata: {
      source: "scout-managed",
      managedByScout: true,
      identityKind: "scout_managed_local_session_agent",
      externalSource: "local-session",
      selector: input.selector,
      defaultSelector: input.selector,
      sessionBacked: true,
      attachedTransport: input.transport,
    },
    selector: input.selector,
    defaultSelector: input.selector,
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "manual",
    homeNodeId: input.nodeId,
    authorityNodeId: input.nodeId,
    advertiseScope: "local",
  };
}

export function buildManagedLocalSessionEndpointBinding(input: {
  agentId: string;
  transport: ManagedLocalSessionTransport;
  harness: "codex" | "claude";
  sessionId: string;
  cwd: string;
  projectRoot?: string;
  existingEndpoint?: AgentEndpoint | null;
  selector?: string | null;
  definitionId?: string | null;
  nodeId: string;
}): AgentEndpoint {
  const runtimeInstanceId = typeof input.existingEndpoint?.metadata?.runtimeInstanceId === "string"
    && input.existingEndpoint.metadata.runtimeInstanceId.trim().length > 0
    ? input.existingEndpoint.metadata.runtimeInstanceId.trim()
    : typeof input.existingEndpoint?.metadata?.runtimeSessionId === "string"
      && input.existingEndpoint.metadata.runtimeSessionId.trim().length > 0
      ? input.existingEndpoint.metadata.runtimeSessionId.trim()
      : `attached-${input.agentId}`;
  const projectRoot = resolve(input.projectRoot ?? input.cwd);
  const cwd = resolve(input.cwd);
  const projectName = basename(projectRoot) || projectRoot;
  const definitionId = input.definitionId?.trim() || selectorHandle(input.selector ?? input.agentId);

  return {
    id: input.existingEndpoint?.id ?? `endpoint.${input.agentId}.${input.nodeId}.${input.transport}`,
    agentId: input.agentId,
    nodeId: input.nodeId,
    harness: input.harness,
    transport: input.transport,
    state: "idle",
    cwd,
    projectRoot,
    sessionId: input.sessionId,
    metadata: {
      ...(input.existingEndpoint?.metadata ?? {}),
      source: "local-session",
      managedByScout: true,
      sessionBacked: true,
      externalSource: "local-session",
      agentName: input.agentId,
      definitionId,
      runtimeSessionId: undefined,
      runtimeInstanceId,
      transport: input.transport,
      project: projectName,
      projectRoot,
      threadId: input.transport === "codex_app_server" ? input.sessionId : undefined,
      externalSessionId: input.sessionId,
      startedAt: String(Date.now()),
    },
  };
}

export function buildManagedLocalSessionPairingEndpointBinding(input: {
  agentId: string;
  transport: ManagedLocalSessionTransport;
  threadId: string;
  session: PairingSession;
  cwd: string;
  projectRoot?: string;
  existingEndpoint?: AgentEndpoint | null;
  selector?: string | null;
  definitionId?: string | null;
  nodeId: string;
}): AgentEndpoint {
  const projectRoot = resolve(input.projectRoot ?? input.cwd);
  const cwd = resolve(input.cwd);
  const projectName = basename(projectRoot) || projectRoot;
  const definitionId = input.definitionId?.trim() || selectorHandle(input.selector ?? input.agentId);
  const base = buildManagedPairingEndpointBinding({
    agentId: input.agentId,
    nodeId: input.nodeId,
    session: input.session,
    existingEndpoint: input.existingEndpoint ?? null,
    agentName: input.agentId,
  });

  return {
    ...base,
    cwd,
    projectRoot,
    metadata: {
      ...(base.metadata ?? {}),
      source: "local-session",
      externalSource: "local-session",
      attachedTransport: input.transport,
      definitionId,
      agentName: input.agentId,
      project: projectName,
      projectRoot,
      threadId: input.threadId,
      externalSessionId: input.threadId,
      pairingSessionId: input.session.id,
      pairingAdapterType: input.session.adapterType,
      startedAt: String(Date.now()),
    },
  };
}

const LIVE_TERMINAL_HARNESS_NAMES: Record<LiveTerminalSession["harness"], string> = {
  claude: "Claude",
  grok: "Grok",
  codex: "Codex",
  pi: "Pi",
  kimi: "Kimi",
  opencode: "OpenCode",
};

export function liveTerminalDefaultDisplayName(input: { harness: LiveTerminalSession["harness"]; projectRoot?: string; cwd: string }): string {
  const projectName = basename(input.projectRoot ?? input.cwd) || input.cwd;
  return `${LIVE_TERMINAL_HARNESS_NAMES[input.harness]} (${projectName})`;
}

export function suggestedLiveTerminalSelector(input: { harness: LiveTerminalSession["harness"]; projectRoot?: string; cwd: string }): string {
  const projectName = normalizeAgentSelectorSegment(basename(input.projectRoot ?? input.cwd) || "session") || "session";
  return `@${input.harness}-${projectName}`;
}

export function buildLiveTerminalSessionAgent(input: {
  live: LiveTerminalSession;
  selector: string;
  cwd: string;
  projectRoot?: string;
  displayName?: string;
  nodeId: string;
  id: string;
}): AgentDefinition {
  const id = input.id;
  return {
    id,
    kind: "agent",
    definitionId: id,
    displayName: input.displayName?.trim() || liveTerminalDefaultDisplayName({ harness: input.live.harness, ...input }),
    handle: selectorHandle(input.selector),
    labels: ["local-session", "managed", "live-terminal", input.live.harness],
    metadata: {
      source: "scout-managed",
      managedByScout: true,
      identityKind: "scout_managed_local_session_agent",
      externalSource: "local-session",
      selector: input.selector,
      defaultSelector: input.selector,
      sessionBacked: true,
      attachedTransport: input.live.surface.backend,
      attachedLive: true,
    },
    selector: input.selector,
    defaultSelector: input.selector,
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "manual",
    homeNodeId: input.nodeId,
    authorityNodeId: input.nodeId,
    advertiseScope: "local",
  };
}

/**
 * Endpoint for a harness the operator started in their own terminal (a tmux
 * pane or a Ghostty terminal). `attachedLive` tells delivery to type into that
 * surface and never spawn, resume or fork a replacement when it is gone.
 */
export function buildLiveTerminalEndpointBinding(input: {
  agentId: string;
  live: LiveTerminalSession;
  cwd: string;
  projectRoot?: string;
  existingEndpoint?: AgentEndpoint | null;
  selector?: string | null;
  definitionId?: string | null;
  nodeId: string;
}): AgentEndpoint {
  const projectRoot = resolve(input.projectRoot ?? input.cwd);
  const cwd = resolve(input.cwd);
  const { live } = input;
  const { surface } = live;
  return {
    id: input.existingEndpoint?.id ?? `endpoint.${input.agentId}.${input.nodeId}.${surface.backend}`,
    agentId: input.agentId,
    nodeId: input.nodeId,
    harness: live.harness,
    transport: surface.backend,
    state: "idle",
    cwd,
    projectRoot,
    ...(surface.backend === "tmux"
      ? { sessionId: surface.session, pane: surface.pane }
      : { sessionId: surface.backend === "rex" ? surface.blockId : surface.terminalId }),
    metadata: {
      source: "local-session",
      managedByScout: true,
      sessionBacked: true,
      externalSource: "local-session",
      agentName: input.agentId,
      definitionId: input.definitionId?.trim() || selectorHandle(input.selector ?? input.agentId),
      project: basename(projectRoot) || projectRoot,
      projectRoot,
      attachedLive: true,
      placement: "attached",
      livePid: live.pid,
      ...(live.tty ? { liveTty: live.tty } : {}),
      ...(live.nativeSessionId
        ? { externalSessionId: live.nativeSessionId, nativeSessionId: live.nativeSessionId }
        : {}),
      ...(surface.backend === "tmux"
        ? {
          tmuxSession: surface.session,
          tmuxPane: surface.pane,
          terminalSurface: { backend: "tmux", sessionName: surface.session, paneId: surface.pane },
        }
        : surface.backend === "rex" ? { terminalSurface: surface } : {
          ghosttyTerminalId: surface.terminalId,
          terminalSurface: { backend: "ghostty", terminalId: surface.terminalId },
        }),
      startedAt: String(Date.now()),
    },
  };
}

export function managedPairingEndpointForAgent(
  snapshot: RuntimeSnapshot,
  agentId: string,
): AgentEndpoint | null {
  return Object.values(snapshot.endpoints).find((endpoint) => (
    endpoint.agentId === agentId
    && endpoint.transport === "pairing_bridge"
    && isManagedPairingSessionMetadata(endpoint.metadata)
  )) ?? null;
}

export function managedPairingEndpoints(snapshot: RuntimeSnapshot, nodeId: string): AgentEndpoint[] {
  return Object.values(snapshot.endpoints).filter((endpoint) => (
    endpoint.transport === "pairing_bridge"
    && endpoint.nodeId === nodeId
    && isManagedPairingSessionMetadata(endpoint.metadata)
  ));
}

export function legacyPairingEndpoints(snapshot: RuntimeSnapshot, nodeId: string): AgentEndpoint[] {
  return Object.values(snapshot.endpoints).filter((endpoint) => (
    endpoint.transport === "pairing_bridge"
    && endpoint.nodeId === nodeId
    && isLegacyPairingSessionMetadata(endpoint.metadata)
  ));
}

export function managedLocalSessionEndpointForAgent(
  snapshot: RuntimeSnapshot,
  agentId: string,
  nodeId: string,
): AgentEndpoint | null {
  return Object.values(snapshot.endpoints).find((endpoint) => (
    endpoint.agentId === agentId
    && endpoint.nodeId === nodeId
    && (
      endpoint.transport === "codex_app_server"
      || endpoint.transport === "claude_stream_json"
      || endpoint.transport === "pairing_bridge"
      || ((endpoint.transport === "tmux" || endpoint.transport === "ghostty" || endpoint.transport === "rex") && endpoint.metadata?.attachedLive === true)
    )
    && isManagedLocalSessionMetadata(endpoint.metadata)
  )) ?? null;
}

export function resolveManagedSessionAttachTarget(
  snapshot: RuntimeSnapshot,
  input: { agentId?: string; selector?: string },
  options: {
    nodeId: string;
    isInactiveLocalAgent: (agent: AgentDefinition | undefined) => boolean;
  },
): AgentDefinition | null {
  let target: AgentDefinition | null = null;

  const directAgentId = input.agentId?.trim();
  if (directAgentId) {
    const agent = snapshot.agents[directAgentId];
    if (!agent || options.isInactiveLocalAgent(agent)) {
      throw new Error(`unknown Scout agent ${directAgentId}`);
    }
    if (agent.authorityNodeId !== options.nodeId) {
      throw new Error(`agent ${directAgentId} is owned by ${agent.authorityNodeId}, not ${options.nodeId}`);
    }
    target = agent;
  }

  const selector = input.selector?.trim();
  if (!selector) {
    return target;
  }

  const resolution = resolveAgentLabel(snapshot, selector, {
    preferLocalNodeId: options.nodeId,
    helpers: { isStale: options.isInactiveLocalAgent },
  });

  switch (resolution.kind) {
    case "resolved":
      if (resolution.agent.authorityNodeId !== options.nodeId) {
        throw new Error(`alias ${selector} is owned by ${resolution.agent.authorityNodeId}, not ${options.nodeId}`);
      }
      if (target && target.id !== resolution.agent.id) {
        throw new Error(`alias ${selector} already resolves to ${resolution.agent.id}`);
      }
      return resolution.agent;
    case "ambiguous":
      throw new Error(`alias ${selector} is ambiguous across ${resolution.candidates.length} agents`);
    case "unparseable":
      throw new Error(`could not parse alias ${selector}`);
    case "resolved_session":
      // SCO-070: a selector that resolves to a cardless session has no agent
      // card to attach a managed session to — treat like "no card matched".
      return target;
    case "unknown":
      return target;
  }
}

export function sameSerializedRecord<T>(left: T | undefined, right: T): boolean {
  if (!left) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}
