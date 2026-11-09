import { captureRegistries } from "./broker-registry-capture.js";
import { isAttachedLiveTerminalEndpoint, isAttachedLiveTerminalEndpointAlive } from "./live-terminal-session.js";
import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
} from "@openscout/protocol";

import type { LocalAgentBinding } from "./local-agents.js";
import { latestTmuxSessionObservations, withObservedTmuxSession } from "./relay-endpoint-session-observation.js";
import type { RelayAgentOverride } from "./setup.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

type LocalAgentSyncRuntime = {
  snapshot(): RuntimeSnapshot;
  peek?(): Readonly<RuntimeSnapshot>;
};

export type RelayAgentOverrides = Record<string, RelayAgentOverride>;

export type BrokerLocalAgentSyncServiceOptions = {
  nodeId: string;
  configuredCoreAgentIds: string[];
  runtime: LocalAgentSyncRuntime;
  registrySignature: () => Promise<string | null>;
  migrateRelayAgentKeys: () => Promise<void>;
  readRelayAgentOverrides: () => Promise<RelayAgentOverrides>;
  loadRegisteredLocalAgentBindings: (
    nodeId: string,
    options?: { ensureOnline?: boolean; agentIds?: string[] },
  ) => Promise<LocalAgentBinding[]>;
  clearGitBranchCache: () => void;
  isGeneratedLocalAgentMetadata: (metadata: Record<string, unknown> | undefined) => boolean;
  isLocalAgentEndpointAlive: (endpoint: AgentEndpoint) => boolean;
  isLocalAgentEndpointAliveAsync?: (endpoint: AgentEndpoint) => Promise<boolean>;
  isLocalAgentSessionAlive: (sessionId: string) => boolean;
  isLocalAgentSessionAliveAsync?: (sessionId: string) => Promise<boolean>;
  shouldDisableGeneratedCodexEndpoint: (endpoint: AgentEndpoint) => boolean;
  upsertActor: (actor: ActorIdentity) => Promise<void>;
  upsertAgent: (agent: AgentDefinition) => Promise<void>;
  persistEndpoint: (endpoint: AgentEndpoint) => Promise<void>;
  retireLegacyPairingSessionAgents: () => Promise<void>;
  reconcileManagedPairingEndpoints: () => Promise<void>;
  reconcileStaleWorkingFlights: () => Promise<void>;
  reconcileStaleLocalDeliveries: () => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
};

const managedLocalSessionTransports = new Set<AgentEndpoint["transport"]>([
  "claude_stream_json",
  "codex_app_server",
  "pi_rpc",
  "grok_acp",
  "kimi_acp",
  "devin_acp",
  "tmux",
]);

export function staleLocalAgentReplacementId(
  definitionId: string | null,
  activeAgentIdsByDefinition: Map<string, string[]>,
): string | null {
  if (!definitionId) {
    return null;
  }

  const matches = activeAgentIdsByDefinition.get(definitionId) ?? [];
  if (matches.length === 1) {
    return matches[0] ?? null;
  }
  if (matches.length > 1) {
    const mainCandidate = matches.find((id) => /\.(main|master)\./.test(id));
    return mainCandidate ?? matches[0] ?? null;
  }
  return null;
}

export function staleRegistrationMetadataMatches(
  metadata: Record<string, unknown> | undefined,
  replacementAgentId: string | null,
): boolean {
  if (metadata?.staleLocalRegistration !== true) {
    return false;
  }
  if (!replacementAgentId) {
    return true;
  }
  const existingReplacement = typeof metadata.replacedByAgentId === "string"
    ? metadata.replacedByAgentId.trim()
    : "";
  return existingReplacement === replacementAgentId;
}

export function staleLocalRegistrationMetadata(
  metadata: Record<string, unknown> | undefined,
  staleAt: number,
  replacementAgentId: string | null,
): Record<string, unknown> {
  const existingReplacement = typeof metadata?.replacedByAgentId === "string"
    ? metadata.replacedByAgentId.trim()
    : "";
  const next: Record<string, unknown> = {
    ...(metadata ?? {}),
    staleLocalRegistration: true,
    staleAt,
  };
  if (replacementAgentId) {
    next.replacedByAgentId = replacementAgentId;
  } else if (existingReplacement) {
    next.replacedByAgentId = existingReplacement;
  } else {
    delete next.replacedByAgentId;
  }
  return next;
}

export function clearStaleLocalEndpointMetadata(
  metadata: AgentEndpoint["metadata"],
): AgentEndpoint["metadata"] {
  const {
    staleLocalRegistration,
    staleAt,
    replacedByAgentId,
    ...rest
  } = metadata ?? {};
  void staleLocalRegistration;
  void staleAt;
  void replacedByAgentId;
  return rest;
}

function missingTmuxSessionError(endpoint: AgentEndpoint): string {
  const sessionId = endpoint.sessionId
    ?? (typeof endpoint.metadata?.tmuxSession === "string"
      ? String(endpoint.metadata.tmuxSession)
      : null);
  return sessionId ? `tmux session missing: ${sessionId}` : "tmux session missing";
}

/**
 * A registry binding describes a configured-but-not-running tmux endpoint as
 * waiting. Once liveness reconciliation has proven that same session missing,
 * preserve its offline diagnostic instead of toggling waiting -> offline on
 * every otherwise-unrelated registry refresh.
 */
export function preserveMissingTmuxEndpointState(
  previous: AgentEndpoint | undefined,
  next: AgentEndpoint,
): AgentEndpoint {
  if (
    previous?.state !== "offline"
    || next.state !== "waiting"
    || next.transport !== "tmux"
    || previous.metadata?.lastError !== missingTmuxSessionError(next)
  ) {
    return next;
  }

  const lastFailedAt = previous.metadata?.lastFailedAt;
  return {
    ...next,
    state: "offline",
    metadata: {
      ...(next.metadata ?? {}),
      lastError: previous.metadata.lastError,
      ...(lastFailedAt === undefined ? {} : { lastFailedAt }),
    },
  };
}

export function coreAgentPreferenceRank(agentId: string): number {
  if (/\.(main)\./.test(agentId)) {
    return 0;
  }
  if (/\.(master)\./.test(agentId)) {
    return 1;
  }
  return 2;
}

export function resolveConfiguredCoreAgentId(
  configuredId: string,
  overrides: RelayAgentOverrides,
): string {
  if (overrides[configuredId]) {
    return configuredId;
  }

  const matches = Object.entries(overrides)
    .filter(([registeredId, override]) => {
      const definitionId = override.definitionId ?? registeredId.split(".")[0];
      return definitionId === configuredId;
    })
    .map(([registeredId]) => registeredId);
  if (matches.length === 0) {
    return configuredId;
  }

  return matches.sort((left, right) =>
    coreAgentPreferenceRank(left) - coreAgentPreferenceRank(right)
      || left.localeCompare(right),
  )[0]!;
}

export class BrokerLocalAgentSyncService {
  private registeredLocalAgentsRegistrySignature: string | null = null;
  private registeredLocalAgentsSyncInFlight: Promise<void> | null = null;

  constructor(private readonly options: BrokerLocalAgentSyncServiceOptions) {}

  async syncIfChanged(reason: string): Promise<void> {
    while (true) {
      const nextSignature = await this.options.registrySignature();
      if (nextSignature === this.registeredLocalAgentsRegistrySignature) {
        return;
      }

      if (this.registeredLocalAgentsSyncInFlight) {
        await this.registeredLocalAgentsSyncInFlight;
        continue;
      }

      this.options.clearGitBranchCache();
      this.options.log?.(`[openscout-runtime] local agent registry changed (${reason}); refreshing registered agents`);
      await this.sync();
    }
  }

  async bootstrap(): Promise<void> {
    await this.options.migrateRelayAgentKeys();
    await this.sync();
    await this.options.retireLegacyPairingSessionAgents();
    await this.options.reconcileManagedPairingEndpoints();
    await this.ensureCoreLocalAgentsOnline();
  }

  async sync(): Promise<void> {
    if (this.registeredLocalAgentsSyncInFlight) {
      await this.registeredLocalAgentsSyncInFlight;
      return;
    }

    this.registeredLocalAgentsSyncInFlight = this.syncUntilRegistryStable();
    try {
      await this.registeredLocalAgentsSyncInFlight;
    } finally {
      this.registeredLocalAgentsSyncInFlight = null;
    }
  }

  private async syncUntilRegistryStable(): Promise<void> {
    while (true) {
      const startedSignature = await this.options.registrySignature();
      await this.syncSnapshot();
      const finishedSignature = await this.options.registrySignature();
      if (finishedSignature === startedSignature) {
        this.registeredLocalAgentsRegistrySignature = finishedSignature;
        return;
      }
      this.options.log?.("[openscout-runtime] local agent registry changed during sync; refreshing registered agents again");
    }
  }

  private async syncSnapshot(): Promise<void> {
    const bindings = await this.options.loadRegisteredLocalAgentBindings(this.options.nodeId);
    const previousEndpoints = captureRegistries(this.options.runtime, ["endpoints"]).endpoints;
    // A registry binding is rebuilt from relay-agents.json and knows nothing the
    // harness reported. Keep the verified tmux observation of its session, from
    // its own last record or from the session-backed endpoint Scout invoked.
    const observations = latestTmuxSessionObservations(Object.values(previousEndpoints));
    this.options.log?.(
      `[openscout-runtime] local agent sync found ${bindings.length} registered agent${bindings.length === 1 ? "" : "s"}`,
    );

    for (const binding of bindings) {
      if (binding.actor.id !== binding.agent.id) {
        await this.options.upsertActor(binding.actor);
      }
      await this.options.upsertAgent(binding.agent);
      const endpoint = withObservedTmuxSession(
        preserveMissingTmuxEndpointState(
          previousEndpoints[binding.endpoint.id],
          binding.endpoint,
        ),
        observations,
      );
      await this.options.persistEndpoint(endpoint);
      this.options.log?.(
        `[openscout-runtime] local agent ${binding.agent.id} -> ${endpoint.transport}:${endpoint.sessionId ?? endpoint.id}`,
      );
    }

    await this.archiveSupersededLocalTransportEndpoints(bindings);
    await this.archiveStaleRegisteredLocalAgents(bindings);
    await this.options.reconcileStaleWorkingFlights();
    await this.options.reconcileStaleLocalDeliveries();
    await this.reconcileLocalEndpointStates();
  }

  async archiveStaleRegisteredLocalAgents(bindings: LocalAgentBinding[]): Promise<void> {
    const activeAgentIds = new Set(bindings.map((binding) => binding.agent.id));
    const activeAgentIdsByDefinition = bindings.reduce((map, binding) => {
      const definitionId = binding.agent.definitionId?.trim();
      if (!definitionId) {
        return map;
      }

      const next = map.get(definitionId) ?? [];
      next.push(binding.agent.id);
      map.set(definitionId, next);
      return map;
    }, new Map<string, string[]>());
    const snapshot = captureRegistries(this.options.runtime, ["agents", "endpoints"]);
    const staleAt = this.now();

    for (const endpoint of Object.values(snapshot.endpoints)) {
      if (activeAgentIds.has(endpoint.agentId) || !this.options.isGeneratedLocalAgentMetadata(endpoint.metadata)) {
        continue;
      }

      const agent = snapshot.agents[endpoint.agentId];
      if (agent?.authorityNodeId && agent.authorityNodeId !== this.options.nodeId) {
        continue;
      }
      // Archived registrations are durable history, not candidates for
      // resurrection. The current registry binding above is responsible for
      // bringing a session back online. Avoid probing every retired endpoint
      // on each broker start -- large pilot journals can retain thousands.
      if (endpoint.state !== "offline" && await this.isLocalAgentEndpointAlive(endpoint)) {
        if (endpoint.metadata?.staleLocalRegistration === true) {
          await this.options.persistEndpoint({
            ...endpoint,
            metadata: clearStaleLocalEndpointMetadata(endpoint.metadata),
          });
        }
        continue;
      }
      const replacementAgentId = staleLocalAgentReplacementId(
        typeof agent?.definitionId === "string" ? agent.definitionId : null,
        activeAgentIdsByDefinition,
      );

      if (agent && !staleRegistrationMetadataMatches(agent.metadata, replacementAgentId)) {
        await this.options.upsertAgent({
          ...agent,
          metadata: staleLocalRegistrationMetadata(agent.metadata, staleAt, replacementAgentId),
        });
      }

      if (endpoint.state === "offline" && staleRegistrationMetadataMatches(endpoint.metadata, replacementAgentId)) {
        continue;
      }

      await this.options.persistEndpoint({
        ...endpoint,
        state: "offline",
        metadata: {
          ...staleLocalRegistrationMetadata(endpoint.metadata, staleAt, replacementAgentId),
          lastError: "superseded local agent registration replaced by current setup",
          lastFailedAt: staleAt,
        },
      });
      this.options.log?.(`[openscout-runtime] archived superseded local endpoint ${endpoint.id}`);
    }
  }

  async archiveSupersededLocalTransportEndpoints(bindings: LocalAgentBinding[]): Promise<void> {
    const activeByAgentHarness = new Map<string, AgentEndpoint>();
    const activeByAgent = new Map<string, AgentEndpoint>();
    const activeAgentIds = new Set<string>();
    for (const binding of bindings) {
      const endpoint = binding.endpoint;
      activeAgentIds.add(endpoint.agentId);
      activeByAgent.set(endpoint.agentId, endpoint);
      activeByAgentHarness.set(`${endpoint.agentId}\0${endpoint.nodeId}\0${endpoint.harness ?? ""}`, endpoint);
    }

    const snapshot = captureRegistries(this.options.runtime, ["agents", "endpoints"]);
    const retiredAt = this.now();
    for (const endpoint of Object.values(snapshot.endpoints)) {
      if (endpoint.nodeId !== this.options.nodeId) {
        continue;
      }
      if (!managedLocalSessionTransports.has(endpoint.transport)) {
        continue;
      }
      // An agent absent from the current registry is handled by the stale
      // registration reconciler; this pass only compares transport profiles
      // for an agent that still has a current local binding.
      if (!activeAgentIds.has(endpoint.agentId)) {
        continue;
      }
      const active = activeByAgentHarness.get(`${endpoint.agentId}\0${endpoint.nodeId}\0${endpoint.harness ?? ""}`);
      const replacement = active ?? activeByAgent.get(endpoint.agentId);
      // The selected local binding is the source of truth for the agent's
      // current harness. If that harness changed entirely (for example
      // Claude/tmux -> Kimi ACP), there is no same-harness replacement to
      // compare against, but the old managed endpoint is still stale and
      // must not keep the agent looking active through the wrong runtime.
      if (!replacement || replacement.id === endpoint.id || replacement.transport === endpoint.transport) {
        continue;
      }
      if (endpoint.state === "offline" && endpoint.metadata?.supersededLocalTransport === true) {
        continue;
      }

      await this.options.persistEndpoint({
        ...endpoint,
        state: "offline",
        metadata: {
          ...(endpoint.metadata ?? {}),
          supersededLocalTransport: true,
          replacedByEndpointId: replacement.id,
          replacedByTransport: replacement.transport,
          retiredAt,
          lastError: `superseded by ${replacement.transport} local agent endpoint`,
          lastFailedAt: retiredAt,
        },
      });
      this.options.log?.(`[openscout-runtime] archived superseded local transport endpoint ${endpoint.id} -> ${replacement.id}`);
    }
  }

  async ensureCoreLocalAgentsOnline(): Promise<void> {
    if (this.options.configuredCoreAgentIds.length === 0) {
      this.options.log?.("[openscout-runtime] no configured core local agents to warm");
      return;
    }

    const overrides = await this.options.readRelayAgentOverrides();
    const resolvedIds = this.options.configuredCoreAgentIds.map((configuredId) =>
      resolveConfiguredCoreAgentId(configuredId, overrides),
    );

    const coreBindings = await this.options.loadRegisteredLocalAgentBindings(this.options.nodeId, {
      ensureOnline: true,
      agentIds: resolvedIds,
    });

    if (coreBindings.length === 0) {
      this.options.log?.("[openscout-runtime] no configured core local agents to warm");
      return;
    }

    this.options.log?.(
      `[openscout-runtime] warming ${coreBindings.length} core local agent${coreBindings.length === 1 ? "" : "s"}`,
    );

    const observations = latestTmuxSessionObservations(
      Object.values(captureRegistries(this.options.runtime, ["endpoints"]).endpoints),
    );
    for (const binding of coreBindings) {
      if (binding.actor.id !== binding.agent.id) {
        await this.options.upsertActor(binding.actor);
      }
      await this.options.upsertAgent(binding.agent);
      await this.options.persistEndpoint(withObservedTmuxSession(binding.endpoint, observations));
      this.options.log?.(
        `[openscout-runtime] core local agent ready ${binding.agent.id} -> ${binding.endpoint.transport}:${binding.endpoint.sessionId ?? binding.endpoint.id}`,
      );
    }
  }

  private async reconcileLocalEndpointStates(): Promise<void> {
    const snapshot = captureRegistries(this.options.runtime, ["agents", "endpoints"]);
    for (const endpoint of Object.values(snapshot.endpoints)) {
      // This service owns only the current node's process/session liveness.
      // Probing remote tmux identifiers locally is both expensive and can
      // incorrectly retire a healthy endpoint on another machine.
      if (endpoint.nodeId !== this.options.nodeId) {
        continue;
      }

      if (endpoint.transport === "ghostty" && isAttachedLiveTerminalEndpoint(endpoint)) {
        if (endpoint.state !== "offline" && !await isAttachedLiveTerminalEndpointAlive(endpoint)) {
          await this.options.persistEndpoint({
            ...endpoint,
            state: "offline",
            metadata: {
              ...(endpoint.metadata ?? {}),
              lastError: "attached Ghostty terminal or its harness is gone",
              lastFailedAt: this.now(),
            },
          });
        }
        continue;
      }

      if (endpoint.transport === "tmux") {
        if (endpoint.state === "offline") {
          continue;
        }
        const sessionId = endpoint.sessionId
          ?? (typeof endpoint.metadata?.tmuxSession === "string" ? String(endpoint.metadata.tmuxSession) : null);
        const sessionAlive = isAttachedLiveTerminalEndpoint(endpoint)
          ? await isAttachedLiveTerminalEndpointAlive(endpoint)
          : sessionId ? await this.isLocalAgentSessionAlive(sessionId) : false;
        if (!sessionAlive) {
          await this.options.persistEndpoint({
            ...endpoint,
            state: "offline",
            metadata: {
              ...(endpoint.metadata ?? {}),
              lastError: missingTmuxSessionError(endpoint),
              lastFailedAt: this.now(),
            },
          });
          this.options.log?.(`[openscout-runtime] marked stale tmux endpoint offline ${endpoint.id}`);
          continue;
        }
      }

      if (!this.options.shouldDisableGeneratedCodexEndpoint(endpoint)) {
        continue;
      }

      if (endpoint.state === "offline") {
        continue;
      }

      await this.options.persistEndpoint({
        ...endpoint,
        state: "offline",
        metadata: {
          ...(endpoint.metadata ?? {}),
          disabledReason: "synthetic_executor_disabled",
        },
      });
      this.options.log?.(`[openscout-runtime] disabled synthetic endpoint ${endpoint.id}`);
    }
  }

  private async isLocalAgentEndpointAlive(endpoint: AgentEndpoint): Promise<boolean> {
    // Startup and invalidation windows can leave the synchronous probe snapshot cold.
    // Before archiving a generated local registration, force the async/fresh liveness path.
    if (this.options.isLocalAgentEndpointAlive(endpoint)) {
      return true;
    }
    return await this.options.isLocalAgentEndpointAliveAsync?.(endpoint) ?? false;
  }

  private async isLocalAgentSessionAlive(sessionId: string): Promise<boolean> {
    // Same cold-snapshot guard for endpoint state reconciliation.
    if (this.options.isLocalAgentSessionAlive(sessionId)) {
      return true;
    }
    return await this.options.isLocalAgentSessionAliveAsync?.(sessionId) ?? false;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
