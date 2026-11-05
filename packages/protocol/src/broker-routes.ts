// Canonical client-side paths for the broker HTTP API. The routes defined here
// are served by the broker runtime; a route-inventory test ensures every entry
// in this map matches a live implementation.

export const scoutBrokerPaths = {
  health: "/health",
  v1: {
    home: "/v1/home",
    node: "/v1/node",
    snapshot: "/v1/snapshot",
    notificationRouting: "/v1/notification-routing",
    conversationProjection: "/v1/conversation-projection",
    capabilities: "/v1/capabilities",
    runtimeCatalog: "/v1/runtime-catalog",
    topologySnapshot: "/v1/topology/snapshot",
    meshNodes: "/v1/mesh/nodes",
    // Observe-tier compact node state. Read against a PEER broker's base URL
    // through the signed/pinned mesh client; the local home feed is never
    // widened for remote callers (mesh trust cone §4).
    meshNodeState: "/v1/mesh/node-state",
    tailDiscover: "/v1/tail/discover",
    tailRecent: "/v1/tail/recent",
    repoWatchSnapshot: "/v1/repo-watch/snapshot",
    machines: "/v1/machines",
    machinesScan: "/v1/machines/scan",
    messages: "/v1/messages",
    messageReactions: "/v1/message-reactions",
    messageReactionsRemove: "/v1/message-reactions/remove",
    brokerMessages: "/v1/broker/messages",
    eventsStream: "/v1/events/stream",
    commands: "/v1/commands",
    actors: "/v1/actors",
    agents: "/v1/agents",
    endpoints: "/v1/endpoints",
    conversations: "/v1/conversations",
    invocations: "/v1/invocations",
    flights: "/v1/flights",
    deliver: "/v1/deliver",
    rendezvousMatch: "/v1/rendezvous/match",
    aliases: "/v1/aliases",
    aliasesResolve: "/v1/aliases/resolve",
    roster: "/v1/roster",
    rosterProjectCode: "/v1/roster/projects/code",
    rosterImport: "/v1/roster/import",
    rosterResolve: "/v1/roster/resolve",
    activity: "/v1/activity",
    collaborationRecords: "/v1/collaboration/records",
    collaborationEvents: "/v1/collaboration/events",
    workBoard: "/v1/work/board",
    workLifecycles: "/v1/work/lifecycles",
    workMoves: "/v1/work/moves",
    workMove: "/v1/work/move",
    workReview: "/v1/work/review",
    pairingAttach: "/v1/pairing/attach",
    pairingDetach: "/v1/pairing/detach",
    localSessionsAttach: "/v1/local-sessions/attach",
    localSessionsDetach: "/v1/local-sessions/detach",
  },
} as const;

export function scoutBrokerMessagesListPath(search: URLSearchParams): string {
  const q = search.toString();
  return q ? `${scoutBrokerPaths.v1.messages}?${q}` : scoutBrokerPaths.v1.messages;
}

export function scoutBrokerMessagesPath(search: URLSearchParams): string {
  const q = search.toString();
  return q
    ? `${scoutBrokerPaths.v1.brokerMessages}?${q}`
    : scoutBrokerPaths.v1.brokerMessages;
}

/** Name a conversation. An empty title hands it back to automatic naming. */
export function scoutBrokerConversationTitlePath(conversationId: string): string {
  return `${scoutBrokerPaths.v1.conversations}/${encodeURIComponent(conversationId)}/title`;
}

export function scoutBrokerInvocationPath(invocationId: string): string {
  return `${scoutBrokerPaths.v1.invocations}/${encodeURIComponent(invocationId)}`;
}

export function scoutBrokerInvocationStreamPath(invocationId: string): string {
  return `${scoutBrokerInvocationPath(invocationId)}/stream`;
}

export function scoutBrokerInvocationLifecyclePath(invocationId: string): string {
  return `${scoutBrokerInvocationPath(invocationId)}/lifecycle`;
}

export function scoutBrokerMachinePath(machineRef: string): string {
  return `${scoutBrokerPaths.v1.machines}/${encodeURIComponent(machineRef)}`;
}
