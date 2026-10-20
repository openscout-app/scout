import { loadScoutBrokerContext } from "../../../broker/service.ts";
import { buildMobileMeshNodes, type MobileMeshNodesResponse } from "./mobile-mesh-nodes-view.ts";

/**
 * `mobile/mesh/nodes`: the broker's known mesh nodes (the registry
 * `scout mesh nodes` reads), one per host, with the agents the broker
 * attributes to each. Null when the broker can't be read.
 */
export async function getMobileMeshNodes(options: { all?: boolean } = {}): Promise<MobileMeshNodesResponse | null> {
  const context = await loadScoutBrokerContext();
  if (!context) return null;
  const snapshot = context.snapshot;
  return buildMobileMeshNodes({
    all: options.all,
    localNodeId: context.node?.id ?? null,
    nodes: snapshot.nodes ?? {},
    agents: snapshot.agents ?? {},
    endpoints: snapshot.endpoints ?? {},
    flights: snapshot.flights ?? {},
    invocations: snapshot.invocations ?? {},
    messages: snapshot.messages ?? {},
    now: Date.now(),
  });
}
