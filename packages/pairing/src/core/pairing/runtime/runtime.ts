import type { AdmitAccountDevice } from "./account-admission.ts";
import type { PairingRequestBinding, LocalApprovalPairingOpportunity } from "@openscout/runtime/pairing-local-socket";
import { pairingTrustOwner, type PairingOpportunity } from "@openscout/runtime/pairing-security/trust-owner";
import { homedir } from "node:os";

import {
  createAcpAdapter as createAcp,
  createClaudeCodeAdapter as createClaudeCode,
  createCodexAdapter as createCodex,
  createAntigravityAcpAdapter,
  createDevinAcpAdapter as createDevinAcp,
  createGrokAcpAdapter as createGrokAcp,
  createKimiAcpAdapter as createKimiAcp,
  createOpenAiCompatAdapter as createOpenAI,
  createOpencodeAdapter as createOpenCode,
  createOpencodeAcpAdapter as createOpenCodeAcp,
  createOpencodeV2Adapter as createOpenCodeV2,
  createPiAdapter as createPi,
  type AdapterFactory,
} from "@openscout/agent-sessions";
import { Bridge } from "./bridge/bridge.ts";
import { type AdapterEntry, resolveConfig, type SessionEntry } from "./bridge/config.ts";
import { startFileServer, type FileServer } from "./bridge/fileserver.ts";
import { connectToRelay, type RelayConnection, type RelayEventHandlers } from "./bridge/relay-client.ts";
import { startBridgeServerTRPC as startBridgeServer } from "./bridge/server-trpc.ts";
import { createQRPayload, loadOrCreateIdentity, type KeyPair, type QRPayload } from "./security.ts";

export type PairingRuntimeEvents = RelayEventHandlers;

export type PairingRuntimeRelayEndpoint = {
  relayUrl: string;
  advertisedRelayUrl?: string | null;
  fallbackRelayUrls?: string[];
};

export type StartedPairingRuntime = {
  bridge: Bridge;
  fileServer: FileServer;
  identity: KeyPair;
  config: ReturnType<typeof resolveConfig>;
  relayConnection: RelayConnection | null;
  relayConnections: RelayConnection[];
  qrPayload: QRPayload | null;
  accountRoom: string | null;
  openPairing: () => {windowId: string; payload: QRPayload};
  cancelPairing: (windowId?: string) => void;
  approvalPairing: (action: "open" | "read" | "cancel", binding: PairingRequestBinding) => LocalApprovalPairingOpportunity | null;
  stop: () => Promise<void>;
};

export function createPairingAdapterRegistry(configAdapters?: Record<string, AdapterEntry>) {
  const adapters: Record<string, AdapterFactory> = {
    "claude-code": createClaudeCode,
    acp: createAcp,
    codex: createCodex,
    "antigravity-acp": createAntigravityAcpAdapter,
    "devin-acp": createDevinAcp,
    "grok-acp": createGrokAcp,
    "kimi-acp": createKimiAcp,
    pi: createPi,
    opencode: createOpenCode,
    "opencode-acp": createOpenCodeAcp,
    "opencode-v2": createOpenCodeV2,
    openai: createOpenAI,
  };

  if (configAdapters) {
    for (const [name, entry] of Object.entries(configAdapters)) {
      const baseFactory = adapters[entry.type];
      if (!baseFactory) {
        console.warn(`[pairing] config adapter "${name}" references unknown type "${entry.type}" — skipped`);
        continue;
      }

      adapters[name] = (adapterConfig) => {
        const merged = {
          ...adapterConfig,
          options: { ...entry.options, ...adapterConfig.options },
        };
        return baseFactory(merged);
      };
    }
  }

  return adapters;
}

export async function startPairingRuntime(options?: {
  relayUrl?: string | null;
  advertisedRelayUrl?: string | null;
  fallbackRelayUrls?: string[];
  relayEndpoints?: PairingRuntimeRelayEndpoint[];
  relayEvents?: PairingRuntimeEvents;
  onPairingOpportunity?: (payload: QRPayload | null) => void;
  /** Trusted host owner-decision path. No callback means no account room. */
  admitAccountDevice?: AdmitAccountDevice;
}) : Promise<StartedPairingRuntime> {
  const config = resolveConfig();
  const identity = loadOrCreateIdentity();
  const adapters = createPairingAdapterRegistry(config.adapters);
  const bridge = new Bridge({
    port: config.port,
    adapters,
  });

  let qrPayload: QRPayload;
  let relayConnections: RelayConnection[] = [];
  let pairingConnections: RelayConnection[] = [];
  let accountConnections: RelayConnection[] = [];
  const accountRoom = typeof options?.admitAccountDevice === "function" ? crypto.randomUUID() : null;
  const retiredConnections = new Set<RelayConnection>();
  const reconnectRoom = crypto.randomUUID();
  type ApprovalWindow = { requestId: string; payload: QRPayload; opportunity: PairingOpportunity; connections: RelayConnection[];
    timer?: ReturnType<typeof setTimeout>; closed: boolean; publicKey?: string };
  const approvalWindows = new Map<string, ApprovalWindow>();
  // Keep only spent IDs for the runtime lifetime, not permission or QR data.
  const spentApprovalRequests = new Set<string>();
  function closeApproval(window: ApprovalWindow) {
    spentApprovalRequests.add(window.requestId);
    window.closed = true;
    window.opportunity.cancel();
    for (const connection of window.connections) {
      retiredConnections.add(connection);
      connection.retire(() => retiredConnections.delete(connection));
    }
    window.connections = [];
  }
  function approvalPairing(action: "open" | "read" | "cancel", binding: PairingRequestBinding): LocalApprovalPairingOpportunity | null {
    let window = approvalWindows.get(binding.requestId);
    // Cancel is terminal even if controller startup has not opened the window.
    if (action === "cancel") {
      spentApprovalRequests.add(binding.requestId);
      if (window) closeApproval(window);
      return null;
    }
    if (window && window.publicKey !== binding.publicKey) throw new Error("Pairing request binding changed");
    // A missing window is unknown (for example after restart), not spent.
    const spentResult = action === "read" ? {status: "spent" as const} : null;
    if (!window && spentApprovalRequests.has(binding.requestId)) return spentResult;
    if (!window && action === "open") {
      if (approvalWindows.size >= 32) throw new Error("Too many pairing windows");
      const payload = Object.freeze({...qrPayload, room: crypto.randomUUID(), expiresAt: Date.now() + 300_000});
      window = { requestId: binding.requestId, payload, publicKey: binding.publicKey, closed: false, connections: [],
        opportunity: pairingTrustOwner().openPairingOpportunity(payload.room, payload.expiresAt, binding.publicKey, binding.authorityStamp) };
      approvalWindows.set(binding.requestId, window);
      const current = window;
      try { window.connections = connectRelays("pairing", payload, window); }
      catch (error) { closeApproval(window); approvalWindows.delete(binding.requestId); throw error; }
      window.timer = setTimeout(() => { closeApproval(current); approvalWindows.delete(binding.requestId); }, 300_000);
    }
    if (!window) return null;
    if (window.closed) return spentResult;
    if (!window.opportunity.isOpen()) { closeApproval(window); return spentResult; }
    return {windowId: window.opportunity.id, payload: window.payload};
  }
  let opportunity: PairingOpportunity | null = null;
  let opportunityTimer: ReturnType<typeof setTimeout> | undefined;
  function cancelPairing(windowId?: string) {
    if (windowId && opportunity?.id !== windowId) return;
    opportunity?.cancel(); opportunity = null;
    clearTimeout(opportunityTimer);
    for (const connection of pairingConnections) {
      retiredConnections.add(connection);
      connection.retire(() => retiredConnections.delete(connection));
    }
    pairingConnections = [];
    options?.onPairingOpportunity?.(null);
  }
  function openPairing() {
    cancelPairing();
    // Pairing is unindexed; the stable reconnect room never changes.
    const payload = Object.freeze({...qrPayload, room: crypto.randomUUID(), expiresAt: Date.now() + 300_000});
    opportunity = pairingTrustOwner().openPairingOpportunity(payload.room, payload.expiresAt);
    qrPayload = payload;
    try { pairingConnections = connectRelays("pairing", payload); }
    catch (error) { cancelPairing(); throw error; }
    opportunityTimer = setTimeout(() => cancelPairing(), 300_000);
    options?.onPairingOpportunity?.(payload);
    return {windowId: opportunity.id, payload};
  }
  const server = startBridgeServer({
    bridge,
    port: config.port,
    // Local workflow control always authenticates the host's Noise identity.
    pairingControl: (action, windowId, binding) => {
      if (binding && action.startsWith("request-")) {
        return approvalPairing(action.slice(8) as "open" | "read" | "cancel", binding);
      }
      if (action === "open") return openPairing();
      cancelPairing(windowId); return null;
    },
    secure: config.secure,
    identity: config.secure ? identity : undefined,
  });
  const fileServer = startFileServer({ port: config.port + 2, bridge });

  const relayEndpoints = resolveRelayEndpoints(config, options);
  const advertisedRelayUrls = dedupeRelayUrls(relayEndpoints.flatMap((endpoint) => [
    advertisedRelayUrl(endpoint),
    ...(endpoint.fallbackRelayUrls ?? []),
  ]));
  const primaryRelayUrl = advertisedRelayUrls[0] ?? null;
  if (!primaryRelayUrl) {
    fileServer.stop();
    server.stop();
    throw new Error("Pairing relay URL is not configured.");
  }

  qrPayload = createQRPayload(identity.publicKey, primaryRelayUrl, advertisedRelayUrls.slice(1));
  function connectRelays(kind: "pairing" | "reconnect" | "account", payload: QRPayload, approval?: ApprovalWindow): RelayConnection[] {
    const connections: RelayConnection[] = [];
    try {
      for (const endpoint of relayEndpoints) connections.push(connectToRelay(endpoint.relayUrl.trim(), identity, bridge, {
        secure: true,
        publicRelayUrl: advertisedRelayUrl(endpoint),
        kind,
        reconnectRoom,
        qrPayload: payload,
        // Approval rooms never enter QR state, status detail, or status events.
        events: approval ? undefined : options?.relayEvents,
        privateRoom: Boolean(approval) || kind === "account",
        ...(kind === "account" ? { admitNewDevice: options?.admitAccountDevice } : {}),
        ...(approval ? {
          onPeerAdmitted: () => closeApproval(approval),
          authorizePeer: (key: string, room: string, live: () => boolean) => {
            if (approval.closed) return false;
            try {
              const admitted = approval.opportunity.admit(key, room, live);
              if (!admitted && !approval.opportunity.isOpen()) closeApproval(approval);
              return admitted;
            } catch (error) { closeApproval(approval); throw error; }
          },
        } : kind === "pairing" ? {
          onPeerAdmitted: () => cancelPairing(),
          admitNewPeer: (key: string, room: string, live: () => boolean) => {
            const current = opportunity;
            if (!current) return false;
            try {
              const admitted = current.admit(key, room, live);
              if (!admitted) cancelPairing(current.id);
              return admitted;
            } catch (error) {
              cancelPairing(current.id);
              throw error;
            }
          },
        } : {}),
      }));
      return connections;
    } catch (error) {
      for (const connection of connections) connection.disconnect();
      throw error;
    }
  }
  try {
    relayConnections = connectRelays("reconnect", {...qrPayload, room: reconnectRoom});
    if (accountRoom) accountConnections = connectRelays("account", {...qrPayload, room: accountRoom});
  } catch (error) {
    for (const relayConnection of [...relayConnections, ...accountConnections]) {
      relayConnection.disconnect();
    }
    fileServer.stop();
    server.stop();
    throw error;
  }

  await autoStartConfiguredSessions(bridge, config.sessions);

  return {
    bridge,
    fileServer,
    identity,
    config,
    get relayConnection() { return relayConnections[0] ?? null; },
    get relayConnections() { return [...relayConnections, ...accountConnections, ...pairingConnections, ...[...approvalWindows.values()].flatMap(window => window.connections), ...retiredConnections]; },
    get qrPayload() { return qrPayload; },
    accountRoom,
    openPairing,
    cancelPairing,
    approvalPairing,
    async stop() {
      cancelPairing();
      for (const window of approvalWindows.values()) { clearTimeout(window.timer); closeApproval(window); }
      approvalWindows.clear();
      for (const relayConnection of [...relayConnections, ...accountConnections, ...pairingConnections, ...retiredConnections]) {
        relayConnection.disconnect();
      }
      fileServer.stop();
      await bridge.shutdown();
      server.stop();
    },
  };
}

function resolveRelayEndpoints(
  config: ReturnType<typeof resolveConfig>,
  options: {
    relayUrl?: string | null;
    advertisedRelayUrl?: string | null;
    fallbackRelayUrls?: string[];
    relayEndpoints?: PairingRuntimeRelayEndpoint[];
  } | undefined,
): PairingRuntimeRelayEndpoint[] {
  const explicit = options?.relayEndpoints
    ?.map((endpoint) => ({
      relayUrl: endpoint.relayUrl.trim(),
      advertisedRelayUrl: endpoint.advertisedRelayUrl?.trim() || endpoint.relayUrl.trim(),
      fallbackRelayUrls: endpoint.fallbackRelayUrls,
    }))
    .filter((endpoint) => endpoint.relayUrl.length > 0) ?? [];
  if (explicit.length > 0) {
    return dedupeRelayEndpoints(explicit);
  }

  const relayUrl = options?.relayUrl?.trim() || config.relay || null;
  if (!relayUrl) {
    return [];
  }
  return [{
    relayUrl,
    advertisedRelayUrl: options?.advertisedRelayUrl?.trim() || relayUrl,
    fallbackRelayUrls: options?.fallbackRelayUrls,
  }];
}

function advertisedRelayUrl(endpoint: PairingRuntimeRelayEndpoint): string {
  return endpoint.advertisedRelayUrl?.trim() || endpoint.relayUrl.trim();
}

function dedupeRelayEndpoints(endpoints: PairingRuntimeRelayEndpoint[]): PairingRuntimeRelayEndpoint[] {
  const seen = new Set<string>();
  const out: PairingRuntimeRelayEndpoint[] = [];
  for (const endpoint of endpoints) {
    const relayUrl = endpoint.relayUrl.trim();
    if (!relayUrl || seen.has(relayUrl)) {
      continue;
    }
    seen.add(relayUrl);
    out.push({
      relayUrl,
      advertisedRelayUrl: advertisedRelayUrl(endpoint),
      fallbackRelayUrls: dedupeRelayUrls(endpoint.fallbackRelayUrls ?? []),
    });
  }
  return out;
}

function dedupeRelayUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function autoStartConfiguredSessions(bridge: Bridge, sessions: SessionEntry[] | undefined) {
  if (!sessions?.length) {
    return;
  }

  console.log(`[bridge] auto-starting ${sessions.length} session(s)...`);
  for (const entry of sessions) {
    try {
      const session = await bridge.createSession(entry.adapter, {
        name: entry.name,
        cwd: entry.cwd?.replace(/^~/, homedir()),
        options: entry.options,
      });
      console.log(`[bridge] session started: ${session.name} (${entry.adapter})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] failed to start session "${entry.name}": ${message}`);
    }
  }
}
