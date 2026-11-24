import { existsSync, mkdirSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

import {
  certStatusProbe,
  execSystemFile,
  tailscaleStatusProbe,
  type TailscaleStatusSummary,
} from "@openscout/runtime/setup";

import { pairingLog } from "./log.ts";
import { startRelay, type RelayOptions } from "./relay/relay.ts";
import { resolveOpenScoutPairingHome } from "@openscout/runtime/config";

function pairingDir(): string {
  return resolveOpenScoutPairingHome();
}

export interface TLSPair {
  cert: string;
  key: string;
}

interface TailscaleStatusProbe {
  backendState: string | null;
  dnsName: string | null;
  online: boolean;
  health: string[];
}

export type StartedManagedRelay = {
  relayUrl: string;
  connectUrl: string;
  fallbackRelayUrls: string[];
  stop: () => void;
};

export type ResolvedRelayEndpoint = {
  relayUrl: string;
  connectUrl: string;
  fallbackRelayUrls: string[];
  options: RelayOptions;
};

export type RelayEndpointResolutionOptions = {
  localAddress?: string | null;
  tls?: TLSPair | null;
};

async function findStoredTailscaleCert(hostname: string): Promise<TLSPair | null> {
  if (!existsSync(pairingDir())) {
    return null;
  }

  const certPath = join(pairingDir(), `${hostname}.crt`);
  const keyPath = join(pairingDir(), `${hostname}.key`);
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    return null;
  }

  if (!await storedCertificateLooksPubliclyTrusted(certPath)) {
    return null;
  }

  return { cert: certPath, key: keyPath };
}

async function storedCertificateLooksPubliclyTrusted(certPath: string): Promise<boolean> {
  const snapshot = await certStatusProbe.for(certPath).fresh({ maxAgeMs: 5 * 60_000 });
  return snapshot.value?.publiclyTrusted === true;
}

function statusProbeFromSummary(summary: TailscaleStatusSummary | null): TailscaleStatusProbe | null {
  if (!summary) {
    return null;
  }
  const dnsName = typeof summary.self?.dnsName === "string"
    ? summary.self.dnsName.replace(/\.$/, "")
    : "";
  return {
    backendState: summary.backendState,
    dnsName: dnsName || null,
    online: summary.self?.online !== false,
    health: summary.health,
  };
}

async function readTailscaleStatus(): Promise<TailscaleStatusProbe | null> {
  const snapshot = await tailscaleStatusProbe.fresh({ maxAgeMs: 5_000 });
  return statusProbeFromSummary(snapshot.value);
}

export function resolveRelayEndpointForTailscaleStatus(
  port: number,
  tailscale: TailscaleStatusProbe | null,
  options: RelayEndpointResolutionOptions = {},
): ResolvedRelayEndpoint {
  const backendState = tailscale?.backendState?.trim().toLowerCase() ?? "";
  const hostname = tailscale?.dnsName ?? null;
  const tailscaleRunning = backendState === "running" && tailscale?.online !== false && Boolean(hostname);
  const tls = tailscaleRunning
    ? options.tls ?? null
    : null;
  const scheme = tls ? "wss" : "ws";
  const connectUrl = `${scheme}://127.0.0.1:${port}`;
  const localAddress = options.localAddress !== undefined
    ? normalizedOptionalAddress(options.localAddress)
    : findLocalNetworkAddress();
  const localRelayUrl = !tls && localAddress ? `ws://${localAddress}:${port}` : null;
  const tailnetRelayUrl = tailscaleRunning && hostname ? `${scheme}://${hostname}:${port}` : null;
  const fallbackRelayUrls = tailnetRelayUrl && localRelayUrl ? [tailnetRelayUrl] : [];

  if (tailnetRelayUrl && tls) {
    return {
      relayUrl: tailnetRelayUrl,
      connectUrl,
      fallbackRelayUrls: [],
      options: { tls } satisfies RelayOptions,
    };
  }

  if (localRelayUrl) {
    return {
      relayUrl: localRelayUrl,
      connectUrl,
      fallbackRelayUrls,
      options: {} satisfies RelayOptions,
    };
  }

  if (tailnetRelayUrl) {
    pairingLog.warn("relay", "tailscale is running without TLS; falling back to insecure websocket relay", {
      hostname,
      port,
    });
    return {
      relayUrl: tailnetRelayUrl,
      connectUrl,
      fallbackRelayUrls: [],
      options: {} satisfies RelayOptions,
    };
  }

  if (hostname && backendState && backendState !== "running") {
    pairingLog.warn("relay", "tailscale hostname detected but tailscale is not running; using local-only relay endpoint", {
      hostname,
      backendState,
      health: tailscale?.health ?? [],
      port,
    });
  }

  return {
    relayUrl: connectUrl,
    connectUrl,
    fallbackRelayUrls: [],
    options: {} satisfies RelayOptions,
  };
}

async function generateTailscaleCerts(hostname: string): Promise<TLSPair | null> {
  mkdirSync(pairingDir(), { recursive: true });

  const certPath = join(pairingDir(), `${hostname}.crt`);
  const keyPath = join(pairingDir(), `${hostname}.key`);

  try {
    pairingLog.info("relay", "generating tailscale TLS cert", { hostname });
    await execSystemFile("tailscale", ["cert", "--cert-file", certPath, "--key-file", keyPath, hostname], {
      timeoutMs: 30_000,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 512 * 1024,
    });
    certStatusProbe.invalidate(certPath, "tailscale.cert");
    if (!await storedCertificateLooksPubliclyTrusted(certPath)) {
      pairingLog.warn("relay", "tailscale cert is not publicly trusted; using insecure websocket tailnet relay", {
        hostname,
      });
      return null;
    }
    return { cert: certPath, key: keyPath };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    pairingLog.warn("relay", "tailscale cert failed; using insecure websocket tailnet relay", { hostname, detail });
    return null;
  }
}

async function resolveTls(hostname: string | null): Promise<TLSPair | null> {
  if (!hostname) {
    return null;
  }
  const stored = await findStoredTailscaleCert(hostname);
  if (stored) {
    return stored;
  }
  return await generateTailscaleCerts(hostname);
}

async function resolveRelayEndpoint(port: number) {
  const tailscale = await readTailscaleStatus();
  const backendState = tailscale?.backendState?.trim().toLowerCase() ?? "";
  const hostname = tailscale?.dnsName ?? null;
  const tailscaleRunning = backendState === "running" && tailscale?.online !== false && Boolean(hostname);
  const tls = tailscaleRunning ? await resolveTls(hostname) : null;
  return resolveRelayEndpointForTailscaleStatus(port, tailscale, { tls });
}

export async function suggestedRelayUrl(port = 43131) {
  return (await resolveRelayEndpoint(port)).relayUrl;
}

export async function startManagedRelay(port = 43131): Promise<StartedManagedRelay> {
  const endpoint = await resolveRelayEndpoint(port);
  pairingLog.info("relay", "starting managed relay", {
    relay: endpoint.relayUrl,
    connectUrl: endpoint.connectUrl,
    fallbackRelayUrls: endpoint.fallbackRelayUrls,
    port,
  });
  const relay = startRelay(port, endpoint.options);

  return {
    relayUrl: endpoint.relayUrl,
    connectUrl: endpoint.connectUrl,
    fallbackRelayUrls: endpoint.fallbackRelayUrls,
    stop() {
      pairingLog.info("relay", "stopping managed relay", { relay: endpoint.relayUrl, port });
      relay.stop();
    },
  };
}

function normalizedOptionalAddress(address: string | null | undefined): string | null {
  const trimmed = address?.trim();
  return trimmed ? trimmed : null;
}

function findLocalNetworkAddress(): string | null {
  const candidates: Array<{ name: string; address: string }> = [];
  const interfaces = networkInterfaces();

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      if (!isPrivateIPv4(entry.address) || isLinkLocalIPv4(entry.address) || isTailscaleIPv4(entry.address)) {
        continue;
      }
      candidates.push({ name, address: entry.address });
    }
  }

  candidates.sort((left, right) => {
    const leftScore = localInterfaceScore(left.name);
    const rightScore = localInterfaceScore(right.name);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return left.address.localeCompare(right.address);
  });

  return candidates[0]?.address ?? null;
}

function localInterfaceScore(name: string): number {
  if (/^en\d+$/i.test(name)) {
    return 0;
  }
  if (/^bridge\d*$/i.test(name)) {
    return 2;
  }
  return 1;
}

function isPrivateIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  if (!octets) {
    return false;
  }

  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isLinkLocalIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  return Boolean(octets && octets[0] === 169 && octets[1] === 254);
}

function isTailscaleIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  return Boolean(octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function parseIPv4(address: string): [number, number, number, number] | null {
  const octets = address.split(".");
  if (octets.length !== 4) {
    return null;
  }
  const numbers = octets.map((octet) => Number(octet));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  return numbers as [number, number, number, number];
}
