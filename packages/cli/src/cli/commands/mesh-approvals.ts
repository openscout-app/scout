import type { TrustedPeerRecord } from "@openscout/protocol";
import {
  meshApprovalsConfigPath,
  readMeshApprovalsConfig,
  writeMeshApprovalsConfig,
  type MeshApprovalsConfig,
} from "@openscout/runtime";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/config";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";
import { listMeshTrustedPeers } from "../../lib/core/mesh/trust-service.ts";

export const MESH_APPROVALS_HELP = `scout mesh approvals — answer another Mac's permission requests here

  scout mesh approvals              Show who this machine shares with, and whether it watches
  scout mesh approvals share <peer>    Let <peer> see and answer this machine's approvals
  scout mesh approvals unshare <peer>  Stop sharing with <peer>
  scout mesh approvals watch on|off    Show approvals from peers that share with this machine

<peer> is a trusted peer's label, node id, fingerprint, or key id (see scout mesh peers).
Sharing is off until you turn it on, per peer, on the machine whose sessions ask.
`;

type ApprovalsView = MeshApprovalsConfig & { sharedWith: Array<{ keyId: string; label: string | null }> };

export function resolveTrustedPeer(peers: TrustedPeerRecord[], reference: string): TrustedPeerRecord {
  const wanted = reference.trim().toLowerCase();
  const live = peers.filter((peer) => !peer.revokedAt);
  const exact = live.filter((peer) => [peer.keyId, peer.fingerprint, peer.label, peer.nodeId ?? ""]
    .some((value) => value.toLowerCase() === wanted));
  const matches = exact.length ? exact : live.filter((peer) =>
    (wanted.length >= 8 && peer.keyId.toLowerCase().startsWith(wanted))
    || peer.nodeId?.toLowerCase() === `${wanted}-openscout`);
  if (matches.length !== 1) {
    throw new ScoutCliError(matches.length
      ? `"${reference}" matches ${matches.length} trusted peers; use the key id`
      : `no trusted peer matches "${reference}" (see scout mesh peers)`);
  }
  return matches[0]!;
}

function render(view: ApprovalsView): string {
  const lines = [
    view.sharedWith.length
      ? `Sharing approvals with: ${view.sharedWith.map((peer) => peer.label ?? `${peer.keyId.slice(0, 12)}…`).join(", ")}`
      : "Sharing approvals with: nobody",
    `Watching other machines: ${view.watch ? "on" : "off"}`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function runMeshApprovalsCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const [action = "", target] = args;
  if (action === "help" || action === "--help" || action === "-h") {
    context.output.writeText(MESH_APPROVALS_HELP);
    return;
  }
  const path = meshApprovalsConfigPath(resolveOpenScoutSupportPaths().supportDirectory);
  const config = readMeshApprovalsConfig(path);
  const peers = await listMeshTrustedPeers(resolveScoutBrokerUrl()).catch(() => [] as TrustedPeerRecord[]);

  if (action === "share" || action === "unshare") {
    if (!target) throw new ScoutCliError(`usage: scout mesh approvals ${action} <peer>`);
    const peer = resolveTrustedPeer(peers, target);
    config.share = action === "share"
      ? [...new Set([...config.share, peer.keyId])]
      : config.share.filter((keyId) => keyId !== peer.keyId);
    writeMeshApprovalsConfig(path, config);
  } else if (action === "watch") {
    if (target !== "on" && target !== "off") throw new ScoutCliError("usage: scout mesh approvals watch on|off");
    config.watch = target === "on";
    writeMeshApprovalsConfig(path, config);
  } else if (action !== "" && action !== "status") {
    throw new ScoutCliError(`unknown mesh approvals action: ${action}`);
  }

  const view: ApprovalsView = {
    ...config,
    sharedWith: config.share.map((keyId) => ({ keyId, label: peers.find((peer) => peer.keyId === keyId)?.label ?? null })),
  };
  context.output.writeValue(view, render);
}
