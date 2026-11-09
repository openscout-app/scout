/**
 * Herdr session topology, projected for Scout clients.
 *
 * Herdr owns the real thing: workspaces, tabs, panes, layouts, and the agent
 * records inside them. This type is a READ-ONLY PROJECTION of that topology —
 * what Scout's terminals view needs to represent a herdr session faithfully
 * without becoming a second layout manager. Layout coordinates and split
 * ratios are included read-only so a client can render the arrangement
 * faithfully; there are deliberately no mutation verbs here: if a client wants
 * to change the topology, the handoff is the herdr client itself (`herdr
 * session attach`, `herdr agent focus`), not a Scout control.
 *
 * The server builds this from `herdr --session <n> workspace list`,
 * `tab list`, and `pane list` JSON, with assigned names from `agent list`
 * joined by terminal + pane id, plus the per-tab layout geometry from
 * `herdr --session <n> api snapshot`. Two host facts herdr does not report
 * ride along on a live read: the session's attached clients and the apps they
 * run in (from the host's process table), and each pane's git branch. A
 * session whose server is stopped
 * projects from its persisted `session.json` instead — same shape, marked by
 * `running: false` and `savedAt`; geometry, terminal ids, and live agent
 * status are simply absent from a persisted projection. A session with no
 * persisted state projects as `{ running: false, workspaces: [] }` — an
 * ordinary state, not an error.
 */

/** Agent state as herdr reports it, never as Scout infers it. */
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * The harness-native session reference herdr reports for a pane (e.g. a Claude
 * session id). Opaque to Scout: carried so clients can correlate, never parsed.
 */
export type HerdrAgentSessionRef = {
  agent: string;
  kind: string;
  source: string;
  value: string;
};

export type HerdrPaneProjection = {
  paneId: string;
  /** Herdr's terminal identity; CLI read commands use the separately carried pane id. */
  terminalId: string | null;
  tabId: string;
  workspaceId: string;
  /** Operator-assigned Herdr name; distinct from the changing terminal title. */
  name?: string | null;
  label: string | null;
  /** Detected/reported agent label, e.g. "claude". Null for plain shells. */
  agent: string | null;
  agentStatus: HerdrAgentStatus;
  agentSession: HerdrAgentSessionRef | null;
  cwd: string | null;
  foregroundCwd: string | null;
  focused: boolean;
  /**
   * Scrollback position as herdr reports it. `maxOffsetFromBottom` is the
   * pane's backlog depth — the cheapest activity signal the projection has.
   * Null when the host does not report scroll state (older herdr).
   */
  scroll: HerdrPaneScroll | null;
  /**
   * Git branch checked out at the pane's working directory (the foreground cwd
   * when herdr reports one). Herdr does not report it; the host reads it.
   * Null when the directory is not in a git checkout or HEAD is detached.
   * Absent when it was not read: a persisted projection, or an older host.
   */
  gitBranch?: string | null;
};

export type HerdrPaneScroll = {
  maxOffsetFromBottom: number;
  offsetFromBottom: number;
  viewportRows: number;
};

/**
 * Layout geometry for one tab, read from `herdr api snapshot`. Rects are
 * absolute terminal cell coordinates as herdr reports them (the area includes
 * herdr's chrome offset); clients normalize against `area` to render a
 * proportional replica.
 */
export type HerdrLayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type HerdrLayoutPane = {
  paneId: string;
  focused: boolean;
  rect: HerdrLayoutRect;
};

export type HerdrLayoutSplit = {
  id: string | null;
  direction: "right" | "down" | null;
  ratio: number | null;
  rect: HerdrLayoutRect | null;
};

export type HerdrTabLayout = {
  tabId: string;
  workspaceId: string;
  area: HerdrLayoutRect;
  focusedPaneId: string | null;
  zoomed: boolean;
  panes: HerdrLayoutPane[];
  splits: HerdrLayoutSplit[];
};

export type HerdrTabProjection = {
  tabId: string;
  workspaceId: string;
  label: string | null;
  number: number | null;
  focused: boolean;
  agentStatus: HerdrAgentStatus;
  panes: HerdrPaneProjection[];
  /** Per-tab pane geometry; null when the snapshot did not cover this tab. */
  layout: HerdrTabLayout | null;
};

export type HerdrWorkspaceProjection = {
  workspaceId: string;
  label: string | null;
  number: number | null;
  focused: boolean;
  activeTabId: string | null;
  agentStatus: HerdrAgentStatus;
  tabs: HerdrTabProjection[];
};

/**
 * Why a projection is not live.
 *
 * `not_running` is the ordinary case: no herdr server answers for this session,
 * so its persisted layout is the honest thing to show.
 *
 * `unreadable` is the case worth naming. A herdr server for this session IS
 * running, but it did not answer the topology commands — a protocol skew
 * between the installed client and a long-lived server is the common cause,
 * and a busy server or a timeout look the same from here. Collapsing that into
 * `not_running` would state, of live work, that it is not running. The
 * projection says which it is so a reader never has to guess.
 */
export type HerdrTopologyUnavailableReason = "not_running" | "unreadable";

/**
 * Terminal clients attached to one multiplexer session, as the session's own
 * host counts them from its process table. A remote session therefore carries
 * the answer from the machine it runs on, not from the machine reading it.
 */
export type TerminalSessionClients = {
  /** Client processes attached to the session. */
  clients: number;
  /**
   * Display names of the macOS apps those clients run in, de-duplicated, in
   * the order of the first client seen in each. A helper app that attaches on
   * behalf of another app reports the app that owns it. Always empty on other
   * platforms, and for clients that run outside any app (for example over ssh).
   */
  apps: string[];
};

export type HerdrSessionTopology = {
  /** Herdr session name, e.g. "openscout". */
  session: string;
  /** Whether the session's herdr server answered. */
  running: boolean;
  workspaces: HerdrWorkspaceProjection[];
  /** Server wall-clock when the projection was observed. */
  observedAt: number;
  /**
   * When the projection came from the persisted session state (server stopped),
   * the mtime of that state — the session's last known change. Absent when the
   * projection is live.
   */
  savedAt?: number | null;
  /**
   * Why this projection is not live. Set only when `running` is false; absent
   * on a live read. See {@link HerdrTopologyUnavailableReason}.
   */
  unavailable?: HerdrTopologyUnavailableReason | null;
  /**
   * Herdr clients attached to this session, counted on its host. Set only on a
   * live read; absent when the projection is persisted or the host's process
   * table could not be read. See {@link TerminalSessionClients}.
   */
  clients?: TerminalSessionClients["clients"];
  /** Apps those clients run in. Present whenever `clients` is. */
  apps?: TerminalSessionClients["apps"];
};

export function emptyHerdrSessionTopology(
  session: string,
  running: boolean,
  unavailable?: HerdrTopologyUnavailableReason | null,
): HerdrSessionTopology {
  return {
    session,
    running,
    workspaces: [],
    observedAt: Date.now(),
    ...(running ? {} : { unavailable: unavailable ?? "not_running" }),
  };
}
