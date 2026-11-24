import { tailscaleStatusProbe } from "@openscout/runtime/setup";

export async function getMobileMeshStatus() {
  const summary = tailscaleStatusProbe.read().value;
  const peers = summary?.peers ?? [];
  return {
    tailscale: {
      available: summary !== null,
      running: summary?.running ?? false,
      backendState: summary?.backendState ?? null,
      health: summary?.health ?? [],
      peers,
      onlineCount: peers.filter((peer) => peer.online).length,
    },
  };
}
