import { isRexSurface, startRexAgent, type RexStartInput } from "./rex-terminal.js";
import { resolve } from "node:path";

import type {
  AgentDefinition,
  AgentEndpoint,
} from "@openscout/protocol";

import {
  buildManagedPairingEndpointBinding,
  buildPairingSessionCandidate,
  type EnsurePairingSessionForCodexThreadInput,
  type PairingSession,
} from "./pairing-session-agents.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import type { LiveTerminalSession } from "./live-terminal-session.js";
import {
  buildLiveTerminalEndpointBinding,
  buildLiveTerminalSessionAgent,
  buildManagedLocalSessionAgent,
  buildManagedLocalSessionPairingEndpointBinding,
  buildManagedPairingAgent,
  isLegacyPairingSessionMetadata,
  legacyPairingEndpoints,
  managedLocalSessionDefaultDisplayName,
  managedLocalSessionEndpointForAgent,
  managedPairingEndpointForAgent,
  managedPairingEndpoints,
  normalizeManagedAgentSelector,
  pairingExternalSessionId,
  resolveManagedSessionAttachTarget,
  sameSerializedRecord,
  suggestedLiveTerminalSelector,
  suggestedManagedLocalSessionSelector,
  uniqueManagedAgentSelector,
  updateManagedSessionAgent,
  type ManagedLocalSessionTransport,
} from "./broker-managed-session-helpers.js";

type BrokerManagedSessionRuntime = {
  snapshot(): RuntimeSnapshot;
};

export type BrokerManagedSessionServiceOptions = {
  nodeId: string;
  runtime: BrokerManagedSessionRuntime;
  createId: (prefix: string) => string;
  isInactiveLocalAgent: (agent: AgentDefinition | undefined) => boolean;
  upsertAgent: (agent: AgentDefinition) => Promise<void>;
  persistEndpoint: (endpoint: AgentEndpoint) => Promise<void>;
  findPairingSession: (externalSessionId: string) => Promise<PairingSession | null>;
  getPairingSessionSnapshot: (externalSessionId: string) => Promise<{ session: PairingSession } | null>;
  ensurePairingSessionForCodexThread: (input: EnsurePairingSessionForCodexThreadInput) => Promise<PairingSession>;
  shutdownLocalSessionEndpoint: (endpoint: AgentEndpoint) => Promise<unknown>;
  now?: () => number;
  log?: (message: string) => void;
};

export type ManagedPairingAttachInput = {
  externalSessionId: string;
  agentId?: string;
  alias?: string;
  displayName?: string;
};

export type ManagedPairingDetachInput = {
  agentId?: string;
  alias?: string;
};

export type ManagedLocalSessionAttachInput = {
  externalSessionId: string;
  transport: ManagedLocalSessionTransport | "tmux" | "ghostty" | "rex";
  cwd: string;
  projectRoot?: string;
  agentId?: string;
  alias?: string;
  displayName?: string;
  /** Required with transport "tmux" / "ghostty": the operator's own live harness. */
  liveTerminal?: LiveTerminalSession;
};

export type ManagedLocalSessionDetachInput = {
  agentId?: string;
  alias?: string;
};

export class BrokerManagedSessionService {
  constructor(private readonly options: BrokerManagedSessionServiceOptions) {}

  async retireLegacyPairingSessionAgents(): Promise<void> {
    const snapshot = this.options.runtime.snapshot();
    const retiredAt = this.now();

    for (const endpoint of legacyPairingEndpoints(snapshot, this.options.nodeId)) {
      const nextEndpoint = {
        ...endpoint,
        state: "offline" as const,
        metadata: {
          ...(endpoint.metadata ?? {}),
          legacyAutoSync: true,
          retiredFromFleet: true,
          stalePairingSession: true,
          retiredAt,
          lastError: "legacy pairing auto-sync retired; re-attach through Scout to manage this session",
          lastFailedAt: retiredAt,
        },
      };
      if (!sameSerializedRecord(endpoint, nextEndpoint)) {
        await this.options.persistEndpoint(nextEndpoint);
        this.log(`[openscout-runtime] retired legacy pairing endpoint ${endpoint.id}`);
      }
    }

    for (const agent of Object.values(snapshot.agents)) {
      if (!isLegacyPairingSessionMetadata(agent.metadata)) {
        continue;
      }
      if (agent.authorityNodeId && agent.authorityNodeId !== this.options.nodeId) {
        continue;
      }

      const nextAgent = {
        ...agent,
        metadata: {
          ...(agent.metadata ?? {}),
          legacyAutoSync: true,
          retiredFromFleet: true,
          stalePairingSession: true,
          retiredAt,
        },
      };
      if (!sameSerializedRecord(agent, nextAgent)) {
        await this.options.upsertAgent(nextAgent);
        this.log(`[openscout-runtime] retired legacy pairing agent ${agent.id}`);
      }
    }
  }

  async reconcileManagedPairingEndpoints(): Promise<void> {
    const snapshot = this.options.runtime.snapshot();

    for (const endpoint of managedPairingEndpoints(snapshot, this.options.nodeId)) {
      const externalSessionId = pairingExternalSessionId(endpoint);
      if (!externalSessionId) {
        if (endpoint.state !== "offline") {
          await this.options.persistEndpoint({
            ...endpoint,
            state: "offline",
            metadata: {
              ...(endpoint.metadata ?? {}),
              stalePairingSession: true,
              lastError: "pairing binding has no active external session id",
              lastFailedAt: this.now(),
            },
          });
        }
        continue;
      }

      const sessionSnapshot = await this.options.getPairingSessionSnapshot(externalSessionId);
      if (!sessionSnapshot) {
        const nextEndpoint = {
          ...endpoint,
          state: "offline" as const,
          metadata: {
            ...(endpoint.metadata ?? {}),
            stalePairingSession: true,
            lastError: `pairing session ${externalSessionId} is offline or unreachable`,
            lastFailedAt: this.now(),
          },
        };
        if (!sameSerializedRecord(endpoint, nextEndpoint)) {
          await this.options.persistEndpoint(nextEndpoint);
          this.log(`[openscout-runtime] reconciled offline pairing binding ${endpoint.id}`);
        }
        continue;
      }

      const agent = snapshot.agents[endpoint.agentId];
      const nextEndpoint = buildManagedPairingEndpointBinding({
        agentId: endpoint.agentId,
        nodeId: this.options.nodeId,
        session: sessionSnapshot.session,
        existingEndpoint: endpoint,
        agentName: agent?.handle ?? agent?.displayName ?? endpoint.agentId,
      });
      if (!sameSerializedRecord(endpoint, nextEndpoint)) {
        await this.options.persistEndpoint(nextEndpoint);
        this.log(`[openscout-runtime] reconciled pairing binding ${endpoint.id} -> ${externalSessionId}`);
      }
    }
  }

  async attachManagedPairingSession(
    input: ManagedPairingAttachInput,
  ): Promise<{ agentId: string; selector: string | null; endpointId: string }> {
    const externalSessionId = input.externalSessionId.trim();
    if (!externalSessionId) {
      throw new Error("externalSessionId is required");
    }

    const session = await this.options.findPairingSession(externalSessionId);
    if (!session) {
      throw new Error(`pairing session ${externalSessionId} is not available`);
    }

    const requestedSelector = input.alias?.trim()
      ? normalizeManagedAgentSelector(input.alias)
      : undefined;
    const snapshot = this.options.runtime.snapshot();
    const selectorOptions = this.selectorOptions();
    const existingAgent = resolveManagedSessionAttachTarget(snapshot, {
      agentId: input.agentId,
      selector: requestedSelector,
    }, selectorOptions);

    const targetSelector = existingAgent
      ? (
        requestedSelector
        ?? existingAgent.selector
        ?? existingAgent.defaultSelector
        ?? (typeof existingAgent.metadata?.selector === "string" ? String(existingAgent.metadata.selector) : null)
        ?? uniqueManagedAgentSelector(snapshot, buildPairingSessionCandidate(session).suggestedSelector, {
          ...selectorOptions,
          currentAgentId: existingAgent.id,
        })
      )
      : uniqueManagedAgentSelector(
        snapshot,
        requestedSelector ?? buildPairingSessionCandidate(session).suggestedSelector,
        selectorOptions,
      );

    const agent = existingAgent
      ? updateManagedSessionAgent(existingAgent, {
        selector: targetSelector ?? undefined,
        displayName: input.displayName,
      })
      : buildManagedPairingAgent({
        session,
        selector: targetSelector ?? uniqueManagedAgentSelector(
          snapshot,
          buildPairingSessionCandidate(session).suggestedSelector,
          selectorOptions,
        ),
        displayName: input.displayName,
        nodeId: this.options.nodeId,
        createId: this.options.createId,
      });

    await this.options.upsertAgent(agent);

    const existingEndpoint = managedPairingEndpointForAgent(this.options.runtime.snapshot(), agent.id);
    const endpoint = buildManagedPairingEndpointBinding({
      agentId: agent.id,
      nodeId: this.options.nodeId,
      session,
      existingEndpoint,
      agentName: agent.handle ?? agent.displayName,
    });
    await this.options.persistEndpoint(endpoint);

    return {
      agentId: agent.id,
      selector: agent.selector ?? agent.defaultSelector ?? null,
      endpointId: endpoint.id,
    };
  }

  async detachManagedPairingSession(
    input: ManagedPairingDetachInput,
  ): Promise<{ agentId: string; endpointId: string | null; detached: boolean }> {
    const requestedSelector = input.alias?.trim()
      ? normalizeManagedAgentSelector(input.alias)
      : undefined;
    const snapshot = this.options.runtime.snapshot();
    const agent = resolveManagedSessionAttachTarget(snapshot, {
      agentId: input.agentId,
      selector: requestedSelector,
    }, this.selectorOptions());

    if (!agent) {
      throw new Error("Detach requires an existing Scout-managed agent id or alias.");
    }

    const endpoint = managedPairingEndpointForAgent(snapshot, agent.id);
    if (!endpoint) {
      return { agentId: agent.id, endpointId: null, detached: false };
    }

    const detachedAt = this.now();
    const nextEndpoint = {
      ...endpoint,
      state: "offline" as const,
      sessionId: undefined,
      metadata: {
        ...(endpoint.metadata ?? {}),
        detachedAt,
        stalePairingSession: false,
        externalSessionId: undefined,
        pairingSessionId: undefined,
        lastError: "pairing session detached",
        lastFailedAt: detachedAt,
      },
    };
    await this.options.persistEndpoint(nextEndpoint);
    return {
      agentId: agent.id,
      endpointId: nextEndpoint.id,
      detached: true,
    };
  }

  async attachManagedLocalSession(
    input: ManagedLocalSessionAttachInput,
  ): Promise<{ agentId: string; selector: string | null; endpointId: string; sessionId: string }> {
    if (input.transport === "tmux" || input.transport === "ghostty" || input.transport === "rex") {
      return this.attachLiveTerminalSession(input);
    }

    const externalSessionId = input.externalSessionId.trim();
    if (!externalSessionId) {
      throw new Error("externalSessionId is required");
    }

    if (input.transport !== "codex_app_server" && input.transport !== "claude_stream_json") {
      throw new Error(`unsupported local session transport ${input.transport}`);
    }

    if (input.transport !== "codex_app_server") {
      throw new Error("local session attach currently supports codex_app_server only");
    }

    const cwd = resolve(input.cwd.trim() || process.cwd());
    const projectRoot = resolve(input.projectRoot?.trim() || cwd);
    const requestedSelector = input.alias?.trim()
      ? normalizeManagedAgentSelector(input.alias)
      : undefined;
    const snapshot = this.options.runtime.snapshot();
    const selectorOptions = this.selectorOptions();
    const existingAgent = resolveManagedSessionAttachTarget(snapshot, {
      agentId: input.agentId,
      selector: requestedSelector,
    }, selectorOptions);

    const targetSelector = existingAgent
      ? (
        requestedSelector
        ?? existingAgent.selector
        ?? existingAgent.defaultSelector
        ?? (typeof existingAgent.metadata?.selector === "string" ? String(existingAgent.metadata.selector) : null)
        ?? uniqueManagedAgentSelector(
          snapshot,
          suggestedManagedLocalSessionSelector({ transport: input.transport, cwd, projectRoot }),
          {
            ...selectorOptions,
            currentAgentId: existingAgent.id,
          },
        )
      )
      : uniqueManagedAgentSelector(
        snapshot,
        requestedSelector ?? suggestedManagedLocalSessionSelector({ transport: input.transport, cwd, projectRoot }),
        selectorOptions,
      );

    const agent = existingAgent
      ? updateManagedSessionAgent(existingAgent, {
        selector: targetSelector ?? undefined,
        displayName: input.displayName,
      })
      : buildManagedLocalSessionAgent({
        transport: input.transport,
        selector: targetSelector ?? uniqueManagedAgentSelector(
          snapshot,
          suggestedManagedLocalSessionSelector({ transport: input.transport, cwd, projectRoot }),
          selectorOptions,
        ),
        cwd,
        projectRoot,
        displayName: input.displayName,
        nodeId: this.options.nodeId,
        createId: this.options.createId,
      });

    const existingEndpoint = managedLocalSessionEndpointForAgent(
      this.options.runtime.snapshot(),
      agent.id,
      this.options.nodeId,
    );
    const session = await this.options.ensurePairingSessionForCodexThread({
      threadId: externalSessionId,
      cwd,
      name: input.displayName?.trim() || managedLocalSessionDefaultDisplayName({ transport: input.transport, cwd, projectRoot }),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
    });
    const endpoint = buildManagedLocalSessionPairingEndpointBinding({
      agentId: agent.id,
      transport: input.transport,
      threadId: externalSessionId,
      session,
      cwd,
      projectRoot,
      existingEndpoint,
      selector: agent.selector ?? agent.defaultSelector ?? null,
      definitionId: agent.handle ?? agent.displayName,
      nodeId: this.options.nodeId,
    });

    if (existingEndpoint && existingEndpoint.transport !== "pairing_bridge") {
      await this.options.shutdownLocalSessionEndpoint(existingEndpoint).catch(() => undefined);
    }
    await this.options.upsertAgent(agent);
    await this.options.persistEndpoint(endpoint);

    return {
      agentId: agent.id,
      selector: agent.selector ?? agent.defaultSelector ?? null,
      endpointId: endpoint.id,
      sessionId: endpoint.sessionId ?? session.id,
    };
  }

  async startRexSession(input: RexStartInput) {
    const agentId = this.options.createId("local-session-agent");
    return startRexAgent(input, agentId, (liveTerminal, displayName) =>
      this.attachLiveTerminalSession({
        externalSessionId: "", transport: "rex", cwd: input.projectPath, liveTerminal, displayName,
        alias: `${displayName}-${agentId}`,
      }, agentId));
  }

  /**
   * Bind an agent to a harness the operator is running in their own terminal.
   * Delivery types into that surface; nothing is spawned beside it.
   */
  private async attachLiveTerminalSession(
    input: ManagedLocalSessionAttachInput,
    freshAgentId?: string,
  ): Promise<{ agentId: string; selector: string | null; endpointId: string; sessionId: string }> {
    const live = input.liveTerminal;
    const surface = live?.surface;
    const surfaceOk = surface?.backend === "tmux"
      ? Boolean(surface.pane?.trim() && surface.session?.trim())
      : isRexSurface(surface) || (surface?.backend === "ghostty" && Boolean(surface.terminalId?.trim()));
    if (!live || !surfaceOk || surface?.backend !== input.transport || !Number.isInteger(live.pid) || (surface.backend !== "rex" && !live.tty?.trim())) {
      throw new Error(`${input.transport} attach needs liveTerminal { harness, pid, tty, surface } for that backend`);
    }

    const cwd = resolve(input.cwd.trim() || process.cwd());
    const projectRoot = resolve(input.projectRoot?.trim() || cwd);
    const requestedSelector = input.alias?.trim()
      ? normalizeManagedAgentSelector(input.alias)
      : undefined;
    const snapshot = this.options.runtime.snapshot();
    const selectorOptions = this.selectorOptions();
    const existingAgent = freshAgentId ? null : resolveManagedSessionAttachTarget(snapshot, {
      agentId: input.agentId,
      selector: requestedSelector,
    }, selectorOptions);
    const suggested = suggestedLiveTerminalSelector({ harness: live.harness, cwd, projectRoot });

    const agent = existingAgent
      ? updateManagedSessionAgent(existingAgent, {
        selector: requestedSelector ?? existingAgent.selector ?? undefined,
        displayName: input.displayName,
      })
      : buildLiveTerminalSessionAgent({
        live,
        selector: uniqueManagedAgentSelector(snapshot, requestedSelector ?? suggested, selectorOptions),
        cwd,
        projectRoot,
        displayName: input.displayName,
        nodeId: this.options.nodeId,
        id: freshAgentId ?? this.options.createId("local-session-agent"),
      });

    const existingEndpoint = managedLocalSessionEndpointForAgent(snapshot, agent.id, this.options.nodeId);
    const endpoint = buildLiveTerminalEndpointBinding({
      agentId: agent.id,
      live,
      cwd,
      projectRoot,
      existingEndpoint: existingEndpoint?.transport === live.surface.backend ? existingEndpoint : null,
      selector: agent.selector ?? agent.defaultSelector ?? null,
      definitionId: agent.handle ?? agent.displayName,
      nodeId: this.options.nodeId,
    });

    if (existingEndpoint && existingEndpoint.id !== endpoint.id) {
      if (existingEndpoint.metadata?.attachedLive === true) {
        await this.options.persistEndpoint({ ...existingEndpoint, state: "offline" });
      } else {
        await this.options.shutdownLocalSessionEndpoint(existingEndpoint).catch(() => undefined);
      }
    }
    await this.options.upsertAgent(agent);
    await this.options.persistEndpoint(endpoint);

    return {
      agentId: agent.id,
      selector: agent.selector ?? agent.defaultSelector ?? null,
      endpointId: endpoint.id,
      sessionId: live.nativeSessionId ?? endpoint.sessionId ?? endpoint.id,
    };
  }

  async detachManagedLocalSession(
    input: ManagedLocalSessionDetachInput,
  ): Promise<{ agentId: string; endpointId: string | null; detached: boolean }> {
    const requestedSelector = input.alias?.trim()
      ? normalizeManagedAgentSelector(input.alias)
      : undefined;
    const snapshot = this.options.runtime.snapshot();
    const agent = resolveManagedSessionAttachTarget(snapshot, {
      agentId: input.agentId,
      selector: requestedSelector,
    }, this.selectorOptions());

    if (!agent) {
      throw new Error("Detach requires an existing Scout-managed agent id or alias.");
    }

    const endpoint = managedLocalSessionEndpointForAgent(snapshot, agent.id, this.options.nodeId);
    if (!endpoint) {
      return { agentId: agent.id, endpointId: null, detached: false };
    }

    if (endpoint.transport !== "pairing_bridge") {
      await this.options.shutdownLocalSessionEndpoint(endpoint).catch(() => undefined);
    }
    const detachedAt = this.now();
    const nextEndpoint = {
      ...endpoint,
      state: "offline" as const,
      metadata: {
        ...(endpoint.metadata ?? {}),
        detachedAt,
        lastError: "local session detached",
        lastFailedAt: detachedAt,
      },
    };
    await this.options.persistEndpoint(nextEndpoint);
    return {
      agentId: agent.id,
      endpointId: nextEndpoint.id,
      detached: true,
    };
  }

  private selectorOptions(): {
    nodeId: string;
    isInactiveLocalAgent: (agent: AgentDefinition | undefined) => boolean;
  } {
    return {
      nodeId: this.options.nodeId,
      isInactiveLocalAgent: this.options.isInactiveLocalAgent,
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
