/**
 * Mesh trust cone P1.5 bind controller (docs/proposals/mesh-trust-cone.md §11.5):
 * one module owns desired/actual bind state (scope, addresses, URLs, TLS
 * identity, mDNS) and applies transactional flips without process restart.
 *
 * Mesh-scope posture: loopback plaintext (owned by the daemon, not here) +
 * non-loopback TLS listeners on selected interfaces + mDNS. Local scope:
 * TLS and mDNS stand down. Gate enforce for remote is keyed off
 * `hasNonLoopbackListener` (§11.6).
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  findLanIPv4Address,
  findTailscaleIPv4Address,
  isLoopbackHost,
  writePersistedAdvertiseScope,
  type BrokerAdvertiseScope,
} from "./broker-process-manager.js";
import { orderMeshDialUrls } from "./mesh-dial-order.js";
import { closeServer, listenTcp } from "./broker-server-lifecycle.js";
import {
  MeshMdnsService,
  meshMdnsEnabled,
  type MdnsResponderFactory,
  type MeshMdnsPeer,
} from "./mesh-mdns-service.js";
import {
  loadOrCreateTlsIdentity,
  type NodeTlsIdentity,
} from "./node-tls-identity.js";
import type { RuntimeEnv } from "./portable-types.js";
import { openScoutInstanceMeshRefusal } from "./instance.js";

export {
  MESH_BIND_CONFIG_FILE,
  meshBindConfigPath,
  readPersistedAdvertiseScope,
  writePersistedAdvertiseScope,
  type MeshBindPersistedConfig,
} from "./broker-process-manager.js";

export type MeshBindState = {
  scope: BrokerAdvertiseScope;
  port: number;
  /** Addresses with live non-loopback TLS listeners */
  tlsAddresses: string[];
  /** Peer-facing endpoint URLs (https when TLS is active) */
  endpoints: string[];
  /** Primary peer-reachable broker URL (https preferred) */
  brokerUrl: string;
  tlsSpkiFingerprint: string | null;
  mdnsAdvertising: boolean;
  /** §11.6: any non-loopback TLS listener is open */
  hasNonLoopbackListener: boolean;
};

export type MeshBindHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export type MeshBindUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

export type MeshBindControllerDeps = {
  port: number;
  /** Full node key ID (for TLS cert subject + mDNS) */
  keyId: string;
  /** Shared request stack (gate → router), same as the plaintext server */
  handleHttp: MeshBindHttpHandler;
  handleUpgrade?: MeshBindUpgradeHandler;
  /** Prefer loopback control URL when no TLS address is up */
  loopbackBrokerUrl: string;
  supportDirectory?: string;
  env?: RuntimeEnv;
  logger?: Pick<Console, "log" | "warn">;
  /** Injectable for tests; default enumerates LAN + Tailscale IPv4 */
  resolveTlsAddresses?: () => string[];
  /**
   * How often mesh scope re-reads the interface addresses, so an interface
   * that appears after boot (Tailscale connecting late) gets a listener.
   * 0 turns the watch off. Default MESH_BIND_ADDRESS_POLL_MS.
   */
  addressPollMs?: number;
  loadTlsIdentity?: () => Promise<NodeTlsIdentity>;
  mdnsResponderFactory?: MdnsResponderFactory;
  onPeerFound?: (peer: MeshMdnsPeer) => void;
  onPeerLost?: (peer: MeshMdnsPeer) => void;
  /**
   * Called after every successful flip so the daemon can refresh the node
   * registry row, signed card endpoints, and host-info.
   */
  onStateChange?: (state: MeshBindState) => void | Promise<void>;
  /**
   * Persist desired scope for reboot restore. Default writes mesh-bind.json
   * under the support directory.
   */
  persistDesiredScope?: (scope: BrokerAdvertiseScope) => void;
};

export type MeshBindController = {
  getState(): MeshBindState;
  hasNonLoopbackListener(): boolean;
  /** Apply desired scope transactionally; rollback on failure. */
  applyScope(scope: BrokerAdvertiseScope): Promise<MeshBindState>;
  /** Boot path: open listeners for the env/persisted scope once. */
  start(initialScope: BrokerAdvertiseScope): Promise<MeshBindState>;
  /**
   * Re-read the interface addresses and, in mesh scope, open listeners for new
   * ones and close listeners for gone ones. No-op when the set is unchanged.
   */
  refreshAddresses(): Promise<MeshBindState>;
  stop(): Promise<void>;
};

type LiveTlsListener = {
  address: string;
  server: HttpsServer;
};

/** Interface reads are cheap; Tailscale connecting late is noticed within this. */
export const MESH_BIND_ADDRESS_POLL_MS = 10_000;

function sameAddressSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((address) => set.has(address));
}

/**
 * Selected non-loopback IPv4 addresses for §11.3 TLS listeners: primary LAN
 * plus Tailscale CGNAT when present. Conservative — no IPv6, no wildcards.
 */
export function findMeshTlsBindAddresses(
  interfaces?: NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>,
  tailscaleOnly = false,
): string[] {
  const addresses: string[] = [];
  const lan = findLanIPv4Address(interfaces);
  if (lan && !tailscaleOnly) addresses.push(lan);
  const tailscale = findTailscaleIPv4Address(interfaces);
  if (tailscale && !addresses.includes(tailscale)) addresses.push(tailscale);
  return addresses;
}

export function createMeshBindController(deps: MeshBindControllerDeps): MeshBindController {
  const logger = deps.logger;
  const env = deps.env ?? process.env;
  let scope: BrokerAdvertiseScope = "local";
  let tlsIdentity: NodeTlsIdentity | null = null;
  let tlsListeners: LiveTlsListener[] = [];
  let mdns: MeshMdnsService | null = null;
  let applying = Promise.resolve();
  let started = false;

  const resolveAddresses = deps.resolveTlsAddresses ?? (() => findMeshTlsBindAddresses(undefined, env.OPENSCOUT_MESH_TLS_TAILSCALE_ONLY === "1"));
  const loadTls = deps.loadTlsIdentity
    ?? (() => loadOrCreateTlsIdentity(
      deps.supportDirectory,
      // Explicit: this is the listener Bun actually serves, and Bun's TLS
      // stack cannot complete a handshake for an Ed25519 leaf (§11.1).
      { nodeKeyId: deps.keyId, algorithm: "ec-p256" },
    ));
  const persist = deps.persistDesiredScope
    ?? ((next: BrokerAdvertiseScope) => writePersistedAdvertiseScope(next, deps.supportDirectory));

  function snapshot(): MeshBindState {
    const tlsAddresses = tlsListeners.map((entry) => entry.address);
    const hasNonLoopbackListener = tlsAddresses.some((address) => !isLoopbackHost(address));
    const httpsEndpoints = orderMeshDialUrls(
      tlsAddresses.map((address) => `https://${address}:${deps.port}`),
    );
    return {
      scope,
      port: deps.port,
      tlsAddresses,
      endpoints: httpsEndpoints.length > 0 ? httpsEndpoints : [deps.loopbackBrokerUrl],
      brokerUrl: httpsEndpoints[0] ?? deps.loopbackBrokerUrl,
      tlsSpkiFingerprint: tlsIdentity?.spkiFingerprint ?? null,
      mdnsAdvertising: mdns?.isAdvertising ?? false,
      hasNonLoopbackListener,
    };
  }

  async function closeAllTls(): Promise<void> {
    const closing = tlsListeners;
    tlsListeners = [];
    await Promise.all(closing.map(async (entry) => {
      try {
        await closeServer(entry.server);
      } catch (error) {
        logger?.warn(
          `[openscout-runtime] mesh bind: failed to close TLS listener on ${entry.address}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }));
  }

  function stopMdns(): void {
    if (!mdns) return;
    try {
      mdns.stop();
    } catch {
      // best effort
    }
    mdns = null;
  }

  function startMdnsIfEnabled(): void {
    stopMdns();
    if (!meshMdnsEnabled(env)) {
      logger?.log("[openscout-runtime] mesh mDNS disabled via OPENSCOUT_MDNS_ENABLED");
      return;
    }
    const service = new MeshMdnsService({
      responderFactory: deps.mdnsResponderFactory,
      logger,
    });
    mdns = service;
    try {
      service.start({
        port: deps.port,
        keyId: deps.keyId,
        tls: true,
      });
      service.startBrowse({
        onPeerFound: deps.onPeerFound,
        onPeerLost: deps.onPeerLost,
      });
    } catch (error) {
      service.stop();
      if (mdns === service) mdns = null;
      throw error;
    }
    logger?.log(`[openscout-runtime] mesh mDNS advertising _openscout._tcp on port ${deps.port} (tls=1)`);
  }

  async function openTlsListeners(addresses: string[], identity: NodeTlsIdentity): Promise<LiveTlsListener[]> {
    const privateKeyPem = identity.keyPair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const opened: LiveTlsListener[] = [];
    try {
      for (const address of addresses) {
        // Spec prefers TLS 1.3; Bun's node:https stack with Ed25519 certs
        // negotiates 1.2 with real clients (openssl) while still serving
        // correctly. Keep minVersion at 1.2 so mixed peers can connect.
        const server = createHttpsServer(
          {
            key: privateKeyPem,
            cert: identity.certificatePem,
            minVersion: "TLSv1.2",
          },
          deps.handleHttp,
        );
        if (deps.handleUpgrade) {
          server.on("upgrade", deps.handleUpgrade);
        }
        await listenTcp(server, { host: address, port: deps.port });
        opened.push({ address, server });
        logger?.log(`[openscout-runtime] mesh TLS listening on https://${address}:${deps.port}`);
      }
      return opened;
    } catch (error) {
      await Promise.all(opened.map((entry) => closeServer(entry.server).catch(() => undefined)));
      throw error;
    }
  }

  async function applyMesh(): Promise<MeshBindState> {
    const addresses = resolveAddresses().filter((address) => address.trim().length > 0);
    if (addresses.length === 0) {
      // Mesh intent without a dialable interface: stand down TLS/mDNS rather
      // than binding a wildcard. Operator still gets scope=mesh in state so
      // status surfaces show the desired posture.
      await closeAllTls();
      stopMdns();
      tlsIdentity = null;
      scope = "mesh";
      const state = snapshot();
      logger?.warn(
        "[openscout-runtime] mesh bind: no non-loopback IPv4 (LAN/Tailscale) available; TLS/mDNS stood down",
      );
      return state;
    }

    const identity = await loadTls();
    const previousListeners = tlsListeners;
    const previousIdentity = tlsIdentity;
    const previousMdns = mdns;

    // A listener on an address we still want keeps serving when the identity
    // is unchanged. Reopening it would collide with itself on the same
    // address and port, so only new addresses open and only gone ones close.
    const sameIdentity = previousIdentity !== null
      && previousIdentity.spkiFingerprint === identity.spkiFingerprint;
    const wanted = new Set(addresses);
    const kept = sameIdentity
      ? previousListeners.filter((entry) => wanted.has(entry.address))
      : [];
    const keptAddresses = new Set(kept.map((entry) => entry.address));
    const dropped = previousListeners.filter((entry) => !kept.includes(entry));
    const toOpen = addresses.filter((address) => !keptAddresses.has(address));

    // A new identity must take over addresses it shares with the old one, so
    // those close first; there is a short gap on them.
    const contested = sameIdentity
      ? []
      : dropped.filter((entry) => wanted.has(entry.address));
    await Promise.all(contested.map((entry) => closeServer(entry.server).catch(() => undefined)));

    let opened: LiveTlsListener[];
    try {
      opened = await openTlsListeners(toOpen, identity);
    } catch (error) {
      // Rollback: keep the previous listeners that are still open.
      tlsListeners = previousListeners.filter((entry) => !contested.includes(entry));
      tlsIdentity = tlsListeners.length > 0 ? previousIdentity : null;
      mdns = previousMdns;
      throw error;
    }

    const nextListeners = addresses
      .map((address) => kept.find((entry) => entry.address === address)
        ?? opened.find((entry) => entry.address === address))
      .filter((entry): entry is LiveTlsListener => entry !== undefined);
    tlsListeners = nextListeners;
    tlsIdentity = identity;
    await Promise.all(
      dropped
        .filter((entry) => !contested.includes(entry))
        .map((entry) => closeServer(entry.server).catch(() => undefined)),
    );
    for (const entry of dropped) {
      logger?.log(`[openscout-runtime] mesh TLS stopped listening on https://${entry.address}:${deps.port}`);
    }

    // mDNS only when we actually have non-loopback TLS up.
    if (nextListeners.some((entry) => !isLoopbackHost(entry.address))) {
      if (previousMdns) {
        // Restart so TXT can refresh tls=1; stop is idempotent.
        try {
          previousMdns.stop();
        } catch {
          // ignore
        }
        mdns = null;
      }
      startMdnsIfEnabled();
    } else {
      stopMdns();
    }

    scope = "mesh";
    return snapshot();
  }

  async function applyLocal(): Promise<MeshBindState> {
    await closeAllTls();
    stopMdns();
    tlsIdentity = null;
    scope = "local";
    return snapshot();
  }

  async function applyScopeInternal(next: BrokerAdvertiseScope): Promise<MeshBindState> {
    // A non-prod OPENSCOUT_INSTANCE never binds the mesh unless opted in.
    const instanceRefusal = next === "mesh" ? openScoutInstanceMeshRefusal() : null;
    if (instanceRefusal) {
      throw new Error(instanceRefusal);
    }
    const previous = snapshot();
    try {
      const state = next === "mesh" ? await applyMesh() : await applyLocal();
      try {
        persist(next);
      } catch (error) {
        logger?.warn(
          `[openscout-runtime] mesh bind: failed to persist desired scope: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      await deps.onStateChange?.(state);
      return state;
    } catch (error) {
      // Best-effort rollback toward the previous scope.
      try {
        if (previous.scope === "mesh") {
          await applyMesh();
        } else {
          await applyLocal();
        }
      } catch {
        // leave whatever state we have
      }
      throw error;
    }
  }

  function enqueue(task: () => Promise<MeshBindState>): Promise<MeshBindState> {
    const run = applying.then(task, task);
    applying = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Mesh scope only: rebind when the interface addresses changed since the
   * listeners opened. Scope and persistence are untouched.
   */
  async function refreshAddressesInternal(): Promise<MeshBindState> {
    if (scope !== "mesh") return snapshot();
    const addresses = resolveAddresses().filter((address) => address.trim().length > 0);
    if (sameAddressSet(addresses, tlsListeners.map((entry) => entry.address))) return snapshot();
    logger?.log(
      `[openscout-runtime] mesh bind: interface addresses changed to [${addresses.join(", ")}]; rebinding`,
    );
    const state = await applyMesh();
    await deps.onStateChange?.(state);
    return state;
  }

  const addressPollMs = deps.addressPollMs ?? MESH_BIND_ADDRESS_POLL_MS;
  let addressTimer: ReturnType<typeof setInterval> | undefined;

  function watchAddresses(): void {
    if (addressTimer || addressPollMs <= 0) return;
    addressTimer = setInterval(() => {
      enqueue(refreshAddressesInternal).catch((error) => {
        logger?.warn(
          `[openscout-runtime] mesh bind: address refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, addressPollMs);
    addressTimer.unref?.();
  }

  function unwatchAddresses(): void {
    if (addressTimer) clearInterval(addressTimer);
    addressTimer = undefined;
  }

  return {
    getState: () => snapshot(),
    hasNonLoopbackListener: () => snapshot().hasNonLoopbackListener,
    applyScope(next) {
      return enqueue(() => applyScopeInternal(next));
    },
    refreshAddresses() {
      return enqueue(refreshAddressesInternal);
    },
    start(initialScope) {
      return enqueue(async () => {
        if (started) return snapshot();
        started = true;
        watchAddresses();
        return applyScopeInternal(initialScope);
      });
    },
    stop() {
      unwatchAddresses();
      return enqueue(async () => {
        await closeAllTls();
        stopMdns();
        tlsIdentity = null;
        started = false;
        scope = "local";
        return snapshot();
      }).then(() => undefined);
    },
  };
}
