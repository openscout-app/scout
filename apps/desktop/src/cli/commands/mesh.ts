import type { ScoutCommandContext } from "../context.ts";
import {
  loadMeshStatus,
  loadMeshDoctorReport,
  runMeshDiscover,
  runMeshJoin,
  runMeshLeave,
  runMeshPing,
  loadMeshNodes,
} from "../../core/mesh/service.ts";
import {
  renderMeshStatus,
  renderMeshDoctor,
  renderMeshDiscover,
  renderMeshJoin,
  renderMeshPing,
  renderMeshNodes,
} from "../../ui/terminal/mesh.ts";
import {
  runMeshCardCommand,
  runMeshEnrollCommand,
  runMeshGrantCommand,
  runMeshPeersCommand,
  runMeshRevokeCommand,
  runMeshTrustCommand,
} from "./mesh-trust.ts";

import { resolveScoutBrokerUrl } from "../../core/broker/service.ts";
import { runMeshGuestsCommand } from "./mesh-guests.ts";

const MESH_HELP = `scout mesh — Mesh status and diagnostics

Subcommands:
  scout mesh              Show mesh status (default)
  scout mesh doctor       Full mesh diagnostics
  scout mesh nodes        List known mesh nodes
  scout mesh discover     Probe for remote mesh nodes
  scout mesh ping <node>  Ping a specific node by ID, name, or URL

Join / leave:
  scout mesh join         Announce, discover peers, and sync their agents
  scout mesh leave        Withdraw mesh announcement (stay local-only)
  scout mesh announce     Alias for join

Presence (docs/proposals/mesh-trust-cone.md §11.5):
  scout mesh bind mesh    Same as join
  scout mesh bind local   Same as leave

MCP gateway (docs/eng/sco-095-remote-mcp-gateway.md):
  scout mesh bridge       Hold the outbound MCP relay connection (spike harness)

Scoped identity and resource access:
  scout mesh access       Person/service keys, policy, grants, and signed calls

Approvals across machines:
  scout mesh approvals    Share this Mac's permission requests with a peer, or watch theirs

Direct guest access:
  scout mesh guests       List, grant, or revoke key-bound guest access (--help)

Legacy machine trust (docs/proposals/mesh-trust-cone.md):
  scout mesh peers        List trusted peers
  scout mesh grant        Adjust a peer's tier
  scout mesh revoke       Revoke a trusted peer
  scout mesh card         Print this node's signed node card (--json)
  scout mesh enroll       SAS enrollment, or ssh://… for SSH bootstrap (§3c)
  scout mesh trust        install-grant (machine-local SSH half)
`;

export async function runMeshCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const subcommand = args[0] ?? "";

  switch (subcommand) {
    case "":
    case "status": {
      const report = await loadMeshStatus();
      context.output.writeValue(report, renderMeshStatus);
      return;
    }

    case "doctor": {
      const report = await loadMeshDoctorReport();
      context.output.writeValue(report, renderMeshDoctor);
      return;
    }

    case "nodes": {
      const result = await loadMeshNodes();
      context.output.writeValue(result, renderMeshNodes);
      return;
    }

    case "discover": {
      const report = await runMeshDiscover();
      context.output.writeValue(report, renderMeshDiscover);
      return;
    }

    case "ping": {
      const target = args[1]?.trim();
      if (!target) {
        context.stderr("Usage: scout mesh ping <node-id|name|url>");
        return;
      }
      const report = await runMeshPing(target);
      context.output.writeValue(report, renderMeshPing);
      return;
    }

    case "join": {
      const report = await runMeshJoin();
      context.output.writeValue(report, renderMeshJoin);
      return;
    }

    case "leave": {
      const report = await runMeshLeave();
      context.output.writeValue(report, renderMeshStatus);
      return;
    }

    case "announce": {
      const report = await runMeshJoin();
      context.output.writeValue(report, renderMeshJoin);
      return;
    }

    case "bind": {
      const scope = args[1]?.trim().toLowerCase();
      if (scope === "mesh") {
        const report = await runMeshJoin();
        context.output.writeValue(report, renderMeshJoin);
        return;
      }
      if (scope === "local") {
        const report = await runMeshLeave();
        context.output.writeValue(report, renderMeshStatus);
        return;
      }
      context.stderr("Usage: scout mesh bind <mesh|local>");
      return;
    }

    case "bridge": {
      const { runMeshBridgeCommand } = await import("./mesh-bridge.ts");
      await runMeshBridgeCommand(context, args.slice(1));
      return;
    }

    case "access": {
      const { runMeshAccessCommand } = await import("./mesh-access.ts");
      await runMeshAccessCommand(context, args.slice(1));
      return;
    }

    case "approvals": {
      const { runMeshApprovalsCommand } = await import("./mesh-approvals.ts");
      await runMeshApprovalsCommand(context, args.slice(1));
      return;
    }

    case "guests":
      await runMeshGuestsCommand(context, args.slice(1), { brokerUrl: resolveScoutBrokerUrl() });
      return;

    case "peers":
      await runMeshPeersCommand(context, args.slice(1));
      return;

    case "grant":
      await runMeshGrantCommand(context, args.slice(1));
      return;

    case "revoke":
      await runMeshRevokeCommand(context, args.slice(1));
      return;

    case "card":
      await runMeshCardCommand(context, args.slice(1));
      return;

    case "enroll":
      await runMeshEnrollCommand(context, args.slice(1));
      return;

    case "trust":
      await runMeshTrustCommand(context, args.slice(1));
      return;

    case "help":
    case "--help":
    case "-h": {
      context.output.writeText(MESH_HELP);
      return;
    }

    default: {
      context.stderr(`Unknown mesh subcommand: ${subcommand}`);
      context.output.writeText(MESH_HELP);
    }
  }
}
