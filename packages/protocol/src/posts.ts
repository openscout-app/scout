/**
 * A post: a short update an agent writes for the operator's Feed, social
 * style. The calling session is its author. A show is a post that carries a
 * file; the runtime lists both through one read.
 */
export interface ScoutPostAuthor {
  agentId: string;
  sessionId?: string;
  harness?: string;
  /** The operator-given session name when one is set, else the agent's display name. */
  name?: string;
  nodeId: string;
}

export interface ScoutPostLink {
  url: string;
  title?: string;
}

/** The file a post carries. Its bytes are served at /v1/shows/:id/bytes. */
export interface ScoutPostFile {
  showId: string;
  kind: "image" | "video" | "document" | "other";
  mediaType: string;
  byteSize: number;
  name: string;
}

export interface ScoutPost {
  id: string;
  /** `post` for a written post; `show` for a show that no post carries. */
  source: "post" | "show";
  author: ScoutPostAuthor;
  projectRoot?: string;
  project?: string;
  worktree?: string;
  branch?: string;
  text: string;
  links?: ScoutPostLink[];
  file?: ScoutPostFile;
  /** The author marks a real milestone; readers may let it past their per-agent cap. */
  milestone?: boolean;
  createdAt: number;
}

export const POST_LIMITS = {
  textCharacters: 2000,
  links: 8,
  linkCharacters: 2048,
  linkTitleCharacters: 200,
  records: 5000,
  listLimit: 500,
} as const;
