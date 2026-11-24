/**
 * Work items as a feed reads them: each with its owner's reply to the ask,
 * the operator's first words after it, where the owner worked, and its
 * derived presentation when one is current. Served by `GET /v1/feed/work`.
 *
 * A feed keeps its own projection and asks for what changed since its last
 * read; the runtime stays the only writer of these records.
 */

/** Done and review are finished turns; working lends its thread a live lead. */
export type ScoutFeedWorkState = "done" | "review" | "working";

/**
 * The item's derived presentation record (`openscout.derived.v1`, kind
 * "presentation"): current while it names the item's version, stale after.
 */
export interface ScoutFeedWorkPresentation {
  status: "current" | "stale" | "missing";
  title: string | null;
  caption: string | null;
}

export interface ScoutFeedWork {
  id: string;
  title: string;
  state: ScoutFeedWorkState;
  /** The operator accepted the work (acceptance state "accepted"). */
  accepted: boolean;
  /** The operator asked for it (requested by an operator actor). */
  operatorAsked: boolean;
  /** The folder the ask was sent from (its message's senderContext.cwd), when it recorded one. */
  askedFrom: string | null;
  ownerId: string | null;
  ownerName: string | null;
  /** The owner's harness, from its newest endpoint. */
  harness: string | null;
  /** The session recorded on this turn's invocation, not the owner's current endpoint. */
  sessionId: string | null;
  /**
   * The endpoint this turn's session ran on (its trace's newest entry). It
   * stays the same when a session's id changes mid-run, from Scout's routing
   * id to the harness's own, so a feed can tell that two ids are one session.
   */
  endpointId: string | null;
  conversationId: string | null;
  parentId: string | null;
  parentTitle: string | null;
  /** The owner's main checkout. */
  projectRoot: string | null;
  /** Where the owner worked: a linked worktree, or the main checkout. */
  cwd: string | null;
  /** The worktree's branch, when the endpoint recorded one. */
  branch: string | null;
  createdAt: number;
  updatedAt: number;
  /** When the final reply arrived, or when the item last changed. */
  finishedAt: number;
  /** The owner's reply to this turn: its id, and its text up to FEED_WORK_LIMITS.replyCharacters. */
  replyId: string | null;
  reply: string | null;
  /** The operator's first message after the final reply, within FEED_WORK_LIMITS.operatorWindowMs. */
  operator: { id: string | null; text: string; at: number } | null;
  presentation: ScoutFeedWorkPresentation;
}

/**
 * One read. `window`: every item changed since `since`, and before `until`
 * when it names one. `changed`: items changed since `mark`, and those whose
 * conversation got a message since it, not older than `since`. `limit` -1
 * reads every match.
 *
 * A long window is read in slices (`until`): each is a short query, so the
 * runtime answers other requests between them.
 */
export type ScoutFeedWorkRead =
  | { mode: "window"; since: number; until?: number; limit: number }
  | { mode: "changed"; mark: number; since?: number; limit: number };

/** `gone`: items the read matched that a feed no longer keeps (any other state). */
export interface ScoutFeedWorkPage {
  tasks: ScoutFeedWork[];
  gone: string[];
}

export const FEED_WORK_LIMITS = {
  /** A reply is read in full up to this many characters; a feed shows its first sentence. */
  replyCharacters: 6000,
  /** The operator's line is read only this long after the reply, so a later, unrelated message is not taken for it. */
  operatorWindowMs: 3 * 86_400_000,
  /** The most items one read returns when it names a limit. */
  listLimit: 5000,
} as const;
