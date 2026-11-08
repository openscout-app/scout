import { channelNaturalKeyFromMetadata, directChannelNaturalKey } from "@openscout/protocol";

type Conversation = { id: string; kind?: string; participantIds?: string[]; metadata?: Record<string, unknown> };
type Snapshot = {
  endpoints?: Record<string, { agentId: string; sessionId?: string | null; metadata?: Record<string, unknown> }>;
  conversations?: Record<string, Conversation>;
  messages?: Record<string, { conversationId: string; createdAt: number }>;
};

/** Match observed identity metadata, never the message body or a guessed id. */
export function conversationIdForSession(snapshot: Snapshot, sessionId: string): string | null {
  const endpoints = Object.values(snapshot.endpoints ?? {}).filter(endpoint =>
    endpoint.sessionId === sessionId || endpoint.metadata?.nativeSessionId === sessionId || endpoint.metadata?.externalSessionId === sessionId);
  const ids = new Set(endpoints.map(endpoint => conversationIdForAgent(snapshot, endpoint.agentId)).filter((id): id is string => !!id));
  return ids.size === 1 ? [...ids][0]! : null;
}

export function conversationIdForAgent(snapshot: Snapshot, agentId: string): string | null {
  const conversations = Object.values(snapshot.conversations ?? {});
  const key = directChannelNaturalKey(["operator", agentId]);
  const direct = conversations.find(conversation => channelNaturalKeyFromMetadata(conversation.metadata) === key);
  if (direct) return direct.id;
  const latest = (id: string) => Object.values(snapshot.messages ?? {}).reduce((at, message) => message.conversationId === id ? Math.max(at, message.createdAt) : at, 0);
  return conversations.filter(conversation => conversation.kind !== "channel" && conversation.participantIds?.includes(agentId))
    .sort((a, b) => latest(b.id) - latest(a.id))[0]?.id ?? null;
}
