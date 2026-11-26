import type { AgentEndpoint } from "@openscout/protocol";

import {
  buildPairingSessionCandidate,
  type PairingSession,
  type PairingSessionCandidate,
} from "./pairing-session-agents.js";
import {
  clearEndpointFailureMetadata,
  endpointStateAfterSuccessfulSessionWarmup,
} from "./local-agents.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import type { ManagedLocalSessionTransport } from "./broker-managed-session-helpers.js";
import type { BrokerManagedSessionService } from "./broker-managed-session-service.js";
import type { RexStartInput } from "./rex-terminal.js";
import type { LiveTerminalSession } from "./live-terminal-session.js";

export type ManagedPairingAttachBody = {
  externalSessionId?: string;
  agentId?: string;
  alias?: string;
  displayName?: string;
};

export type ManagedPairingDetachBody = {
  agentId?: string;
  alias?: string;
};

export type ManagedLocalSessionAttachBody = {
  externalSessionId?: string;
  transport?: ManagedLocalSessionTransport | "tmux" | "ghostty" | "rex";
  cwd?: string;
  projectRoot?: string;
  agentId?: string;
  alias?: string;
  displayName?: string;
  liveTerminal?: LiveTerminalSession;
};

export type ManagedLocalSessionEnsureBody = {
  agentId?: string;
  endpointId?: string;
};

export type ManagedLocalSessionDetachBody = {
  agentId?: string;
  alias?: string;
};

export type BrokerManagedSessionHttpServiceDeps = {
  startRexSession: BrokerManagedSessionService["startRexSession"];
  nodeId: string;
  runtimeSnapshot: () => RuntimeSnapshot;
  processCwd: () => string;
  listPairingSessions: () => Promise<PairingSession[]>;
  attachManagedPairingSession: (input: {
    externalSessionId: string;
    agentId?: string;
    alias?: string;
    displayName?: string;
  }) => Promise<{ agentId: string; selector: string | null; endpointId: string }>;
  detachManagedPairingSession: (
    input: ManagedPairingDetachBody,
  ) => Promise<{ agentId: string; endpointId: string | null; detached: boolean }>;
  attachManagedLocalSession: (input: {
    externalSessionId: string;
    transport: ManagedLocalSessionTransport | "tmux" | "ghostty" | "rex";
    cwd: string;
    projectRoot?: string;
    agentId?: string;
    alias?: string;
    displayName?: string;
    liveTerminal?: LiveTerminalSession;
  }) => Promise<{ agentId: string; selector: string | null; endpointId: string; sessionId: string }>;
  detachManagedLocalSession: (
    input: ManagedLocalSessionDetachBody,
  ) => Promise<{ agentId: string; endpointId: string | null; detached: boolean }>;
  ensureLocalSessionEndpointOnline: (endpoint: AgentEndpoint) => Promise<{
    externalSessionId?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  persistEndpoint: (endpoint: AgentEndpoint) => Promise<void>;
  now?: () => number;
};

export class BrokerManagedSessionHttpService {
  constructor(private readonly deps: BrokerManagedSessionHttpServiceDeps) {}

  readonly startRexSession = (input: RexStartInput) => this.deps.startRexSession(input);

  readonly listPairingSessionCandidates = async (): Promise<PairingSessionCandidate[]> => {
    const sessions = await this.deps.listPairingSessions();
    return sessions.map((session) => buildPairingSessionCandidate(session));
  };

  readonly attachPairingSession = async (
    input: ManagedPairingAttachBody,
  ): Promise<{ ok: true; agentId: string; selector: string | null; endpointId: string }> => {
    const result = await this.deps.attachManagedPairingSession({
      externalSessionId: String(input.externalSessionId ?? ""),
      agentId: input.agentId,
      alias: input.alias,
      displayName: input.displayName,
    });
    return { ok: true, ...result };
  };

  readonly detachPairingSession = async (
    input: ManagedPairingDetachBody,
  ): Promise<{ ok: true; agentId: string; endpointId: string | null; detached: boolean }> => {
    const result = await this.deps.detachManagedPairingSession(input);
    return { ok: true, ...result };
  };

  readonly attachLocalSession = async (
    input: ManagedLocalSessionAttachBody,
  ): Promise<{ ok: true; agentId: string; selector: string | null; endpointId: string; sessionId: string }> => {
    const result = await this.deps.attachManagedLocalSession({
      externalSessionId: String(input.externalSessionId ?? ""),
      transport: input.transport ?? "codex_app_server",
      cwd: String(input.cwd ?? this.deps.processCwd()),
      projectRoot: input.projectRoot,
      agentId: input.agentId,
      alias: input.alias,
      displayName: input.displayName,
      ...(input.liveTerminal ? { liveTerminal: input.liveTerminal } : {}),
    });
    return { ok: true, ...result };
  };

  readonly ensureLocalSession = async (
    input: ManagedLocalSessionEnsureBody,
  ): Promise<{ ok: true; endpoint: AgentEndpoint; externalSessionId: string | null }> => {
    const snapshot = this.deps.runtimeSnapshot();
    const endpoint = input.endpointId?.trim()
      ? snapshot.endpoints[input.endpointId.trim()]
      : Object.values(snapshot.endpoints).find((candidate) => (
        candidate.agentId === input.agentId?.trim()
        && candidate.nodeId === this.deps.nodeId
        && (candidate.transport === "codex_app_server" || candidate.transport === "claude_stream_json" || candidate.transport === "antigravity_acp")
        && candidate.state !== "offline"
      ));
    if (!endpoint) {
      throw new Error("local session endpoint not found");
    }
    if (endpoint.transport !== "codex_app_server" && endpoint.transport !== "claude_stream_json" && endpoint.transport !== "antigravity_acp") {
      throw new Error(`endpoint ${endpoint.id} does not use a local session transport`);
    }

    const sessionResult = await this.deps.ensureLocalSessionEndpointOnline(endpoint);
    const externalSessionId = sessionResult.externalSessionId?.trim();
    const nextEndpoint: AgentEndpoint = {
      ...endpoint,
      state: endpointStateAfterSuccessfulSessionWarmup(endpoint.state),
      metadata: {
        ...clearEndpointFailureMetadata(endpoint.metadata),
        ...(externalSessionId ? {
          externalSessionId,
          threadId: endpoint.transport === "codex_app_server" ? externalSessionId : endpoint.metadata?.threadId,
        } : {}),
        lastEnsuredAt: this.deps.now?.() ?? Date.now(),
      },
    };
    await this.deps.persistEndpoint(nextEndpoint);
    return {
      ok: true,
      endpoint: nextEndpoint,
      externalSessionId: externalSessionId ?? null,
    };
  };

  readonly detachLocalSession = async (
    input: ManagedLocalSessionDetachBody,
  ): Promise<{ ok: true; agentId: string; endpointId: string | null; detached: boolean }> => {
    const result = await this.deps.detachManagedLocalSession(input);
    return { ok: true, ...result };
  };
}
