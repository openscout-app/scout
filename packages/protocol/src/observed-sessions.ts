/** Session identity is never a conversation, agent or terminal id. */
export type ObservedSessionIdentity = { nodeId: string; harness: string; nativeSessionId: string };
export type ObservedSessionLink = { kind: "agent" | "conversation" | "terminal"; id: string };
export type SessionReadAvailability = "not_scanned" | "available" | "unavailable" | "unknown";
/** Shared bounded host/session reads; existing session availability members stay unchanged. */
export type HostReadAvailability = SessionReadAvailability | "partial";
export type ObservedSessionSource = { harness: string; availability: SessionReadAvailability; processes: SessionReadAvailability };
export type ObservedSessionRead = {
  identity: ObservedSessionIdentity;
  links: ObservedSessionLink[];
  cwd: string | null;
  /** The session's name in Scout's order: operator name, then work title, then harness title. */
  title: string | null;
  /** Which part `title` came from; null when the session has no name. */
  titleSource?: import("./session-names.js").SessionNameSource | null;
  /** The harness's own title, kept so a surface can show "renamed from …". */
  harnessTitle?: string | null;
  observedAt: number;
  availability: SessionReadAvailability;
  identityConflict: boolean;
};
export type ObservedSessionInventory = {
  schema: "scout.observed-sessions/v1";
  nodeId: string;
  scannedAt: number | null;
  availability: HostReadAvailability;
  sources: ObservedSessionSource[];
  sessions: ObservedSessionRead[];
  coverage: { kind: "cached_window"; scope: string | null; truncated: boolean; links: { agents: "available" | "unavailable"; conversations: "unsupported"; terminals: "unsupported" } };
};
