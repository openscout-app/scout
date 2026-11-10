/** Immutable, runtime-owned snapshots selected by an agent, not conversation attachments. */
export interface ScoutShow {
  id: string;
  itemId: string;
  supersedes?: string;
  agentId: string;
  sessionId?: string;
  harness?: string;
  nodeId: string;
  projectRoot: string;
  worktree: string;
  branch?: string;
  sourcePath: string;
  kind: "image" | "video" | "document" | "other";
  mediaType: string;
  byteSize: number;
  sha256: string;
  caption?: string;
  createdAt: number;
}
export const SHOW_LIMITS = {
  fileBytes: 128 * 1024 * 1024,
  storeBytes: 1024 * 1024 * 1024,
  records: 10_000,
  captionCharacters: 4000,
} as const;
