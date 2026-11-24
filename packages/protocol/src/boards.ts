/**
 * Boards: the read a Kanban client draws from.
 *
 * A board is one work lifecycle. Its columns are the lifecycle's stations, in
 * order, and its cards are the work items placed on it, with the content a
 * card shows. The runtime produces the whole read from its own records, so a
 * client needs nothing but `GET /v1/boards` and `GET /v1/boards/:id`.
 *
 * Moves, reviews and claims stay at `/v1/work/*`. A card's `next` lists the
 * columns a move can name.
 */
import type {
  CollaborationAcceptanceState,
  CollaborationPriority,
  WorkItemState,
} from "./collaboration.js";
import type { FlightState } from "./invocations.js";
import type { WorkStationId } from "./work-lifecycle.js";

/** The `:id` that names the runtime's default lifecycle. */
export const DEFAULT_BOARD_ID = "default" as const;

/** One board in `GET /v1/boards`. */
export interface BoardSummary {
  /** The lifecycle id. */
  id: string;
  name: string;
  version: number;
  /** The lifecycle the runtime uses for an item that names none. */
  isDefault: boolean;
}

export interface BoardListResponse {
  boards: BoardSummary[];
}

export interface BoardHeader {
  id: string;
  name: string;
  version: number;
  /** The lifecycle document's hash; it changes when the columns or moves change. */
  hash: string;
  description: string | null;
}

/** A lifecycle station. Columns come in the lifecycle's order. */
export interface BoardColumn {
  id: WorkStationId;
  name: string;
  /** The work item state an item takes in this column. */
  state: WorkItemState;
  purpose: string | null;
}

export interface BoardTransition {
  /** A column id, or "*" for any column. */
  from: WorkStationId | "*";
  to: WorkStationId;
  name: string | null;
}

/** Where the item lives in an external work system, from its `externalContext.source`. */
export interface BoardCardSource {
  adapterId: string;
  instanceId: string;
  workItemId: string;
  url: string | null;
}

/** The item's newest flight that has not ended. */
export interface BoardCardFlight {
  id: string;
  state: FlightState;
  /** From the flight's latest session. */
  harness: string | null;
  sessionId: string | null;
  startedAt: number | null;
}

export interface BoardCard {
  workId: string;
  /** The column the item sits in. */
  column: WorkStationId;
  /** The placement revision; a review names the revision it judged. */
  revision: number;
  /** Set while the column's judges have not settled the last move. */
  reviewPending: boolean;
  /** Columns a move from here can name. */
  next: WorkStationId[];
  title: string;
  summary: string | null;
  state: WorkItemState;
  acceptanceState: CollaborationAcceptanceState;
  priority: CollaborationPriority | null;
  ownerId: string | null;
  ownerName: string | null;
  nextMoveOwnerId: string | null;
  nextMoveOwnerName: string | null;
  conversationId: string | null;
  parentId: string | null;
  parentTitle: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * The newest of: the item's latest event, its latest flight (end or start),
   * and the record's own update. `lastMeaningfulSummary` is that one's text.
   */
  lastMeaningfulAt: number;
  lastMeaningfulSummary: string | null;
  source: BoardCardSource | null;
  activeFlight: BoardCardFlight | null;
}

/** `GET /v1/boards/:id`. */
export interface BoardRead {
  board: BoardHeader;
  columns: BoardColumn[];
  transitions: BoardTransition[];
  /** In the runtime's board order: most recently updated first. */
  cards: BoardCard[];
}

export interface BoardReadQuery {
  /** Show items closed at or after this time (ms). Defaults to the last seven days. */
  closedSince?: number;
  /** At most this many cards. Defaults to 100, at most 500, as on `/v1/work/board`. */
  limit?: number;
}
