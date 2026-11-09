/**
 * Herdr workspace digest — the presentation layer over {@link HerdrSessionTopology}.
 *
 * The raw projection is faithful but shapeless: a complex session is several
 * workspaces × tabs × panes, and handing that whole tree to an operator (or to
 * an assistant that has to answer for it) buries the one thing they came for.
 * A digest ranks, groups, bounds, and describes it.
 *
 * Four commitments, in order of how much they matter:
 *
 * 1. **Attention leads.** A `blocked` pane is the only thing in a herdr session
 *    that is actually waiting on a person. It comes first, always, before any
 *    inventory. Everything else is context for it.
 * 2. **Directory is the grouping axis, not the tab.** Operators think "which
 *    repo", herdr thinks "which tab". Grouping is by the pane's literal working
 *    directory — no repo-root inference, because a guessed grouping presented as
 *    a fact is worse than an honest fragmented one.
 * 3. **Shape is described, not dumped.** A tab's layout becomes one readable
 *    phrase ("2×2 grid", "3 columns (2 · 1 · 1)") derived from the pane rects.
 * 4. **Bounded and honest.** Panes are capped and truncation is declared;
 *    `unknown` never collapses into `done`; a persisted projection is labeled
 *    last-known rather than passed off as live.
 *
 * There are no mutation verbs here, for the same reason there are none in the
 * topology projection: herdr owns workspaces, tabs and panes, and Scout's layer
 * is coordination over whatever host is present. A digest pane carries the
 * herdr `target` string so a caller can construct a handoff; performing it is
 * the herdr client's job.
 */

import type {
  HerdrAgentSessionRef,
  HerdrAgentStatus,
  HerdrPaneProjection,
  HerdrSessionTopology,
  HerdrTabLayout,
  HerdrTopologyUnavailableReason,
  TerminalSessionClients,
} from "./terminal-host-topology.js";

/** Total emitted panes across every group before the digest declares truncation. */
export const HERDR_DIGEST_PANE_CAP = 40;
/** Ceiling on each of the two lead lists; attention is a shortlist, not an inventory. */
export const HERDR_DIGEST_LEAD_CAP = 12;

export type HerdrStatusCounts = Record<HerdrAgentStatus, number>;

export type HerdrDigestPane = {
  /**
   * Observed host locator: terminal id when reported, else pane id. This is
   * not a Scout address or a guaranteed CLI target (Herdr versions differ).
   * Read handoffs use the host session + pane id. Null on a saved projection.
   */
  target: string | null;
  paneId: string;
  workspaceId: string;
  tabId: string;
  /** Operator-assigned pane name, not a Scout agent address. */
  name?: string | null;
  label: string | null;
  /** Herdr-reported identity, not a verified Scout session binding. */
  agentSession?: HerdrAgentSessionRef | null;
  /** Detected agent label ("claude", "codex"), or null for a plain shell. */
  agent: string | null;
  status: HerdrAgentStatus;
  /** Working directory: the foreground process's when known, else the pane's. */
  directory: string | null;
  focused: boolean;
  /**
   * Scrollback backlog depth in lines. The cheapest activity signal a
   * projection carries — a deep backlog on an idle pane is work that already
   * happened, not work happening. Null when herdr did not report scroll state.
   */
  backlog: number | null;
  /**
   * Git branch at the pane's working directory, as the host read it. Null
   * outside a git checkout or on a detached HEAD. Absent when it was not read.
   * See {@link HerdrPaneProjection.gitBranch}.
   */
  gitBranch?: string | null;
};

export type HerdrDigestGroup = {
  /** The panes' literal shared working directory; null when they report none. */
  directory: string | null;
  /** Last path segment — how an operator names the place. */
  name: string;
  counts: HerdrStatusCounts;
  panes: HerdrDigestPane[];
  /** Panes in this group dropped by the pane cap. */
  omitted: number;
  /**
   * What was dropped, by status. A collapsed label has to carry its own scent:
   * a reader decides whether the hidden rows matter from the label alone, so
   * "2 idle not shown" is a usable label and "2 not shown" is not.
   */
  omittedCounts: HerdrStatusCounts;
};

export type HerdrDigestShape = {
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  tabLabel: string;
  paneCount: number;
  /** One readable phrase for the arrangement, e.g. "2×2 grid". */
  arrangement: string;
  zoomed: boolean;
  focused: boolean;
};

export type HerdrWorkspaceDigest = {
  session: string;
  /** True only for a projection read from a running herdr server. */
  live: boolean;
  observedAt: number;
  /** Set when the projection is the persisted last-known state, not a live read. */
  savedAt: number | null;
  /**
   * Why a non-live projection is not live. `unreadable` means a server for the
   * session IS running and did not answer — the digest must not present that as
   * a stopped session. Null on a live read.
   */
  unavailable: HerdrTopologyUnavailableReason | null;
  /**
   * Herdr clients attached to the session, counted on its host. Set only when
   * the projection carried them: a live read whose process table was
   * readable. Absent otherwise. See {@link TerminalSessionClients}.
   */
  clients?: TerminalSessionClients["clients"];
  /** Apps those clients run in. Present whenever `clients` is. */
  apps?: TerminalSessionClients["apps"];
  totals: {
    workspaces: number;
    tabs: number;
    panes: number;
    /** Panes herdr recognized an agent in. The rest are plain shells. */
    agents: number;
  };
  counts: HerdrStatusCounts;
  /** Blocked panes — the only entries that represent something waiting on a person. */
  needsYou: HerdrDigestPane[];
  /** Panes herdr observed as working, bounded. */
  working: HerdrDigestPane[];
  groups: HerdrDigestGroup[];
  shapes: HerdrDigestShape[];
  truncated: boolean;
  /** Caveats the reader must carry with the numbers. Never decorative. */
  notes: string[];
};

const EMPTY_COUNTS: HerdrStatusCounts = { blocked: 0, working: 0, idle: 0, done: 0, unknown: 0 };

/** Attention order. Blocked outranks working because it is the only state that waits on a person. */
const STATUS_RANK: Record<HerdrAgentStatus, number> = {
  blocked: 5,
  working: 4,
  idle: 3,
  done: 2,
  unknown: 1,
};

export function herdrStatusRank(status: HerdrAgentStatus): number {
  return STATUS_RANK[status];
}

function emptyCounts(): HerdrStatusCounts {
  return { ...EMPTY_COUNTS };
}

function totalCount(counts: HerdrStatusCounts): number {
  return counts.blocked + counts.working + counts.idle + counts.done + counts.unknown;
}

function paneDirectory(pane: HerdrPaneProjection): string | null {
  return pane.foregroundCwd ?? pane.cwd ?? null;
}

function directoryName(directory: string | null): string {
  if (!directory) return "no directory";
  const segments = directory.replace(/\/+$/, "").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? directory;
}

function toDigestPane(pane: HerdrPaneProjection): HerdrDigestPane {
  return {
    target: pane.terminalId ?? pane.paneId ?? null,
    paneId: pane.paneId,
    workspaceId: pane.workspaceId,
    tabId: pane.tabId,
    name: pane.name ?? null,
    label: pane.label,
    agentSession: pane.agentSession,
    agent: pane.agent,
    status: pane.agentStatus,
    directory: paneDirectory(pane),
    focused: pane.focused,
    backlog: pane.scroll?.maxOffsetFromBottom ?? null,
    ...(pane.gitBranch !== undefined ? { gitBranch: pane.gitBranch } : {}),
  };
}

/**
 * Rank panes for a lead list: attention state, then the focused pane (where the
 * operator's eyes already are), then the deepest backlog, then pane id so the
 * order never wobbles between polls.
 */
function compareLeadPanes(left: HerdrDigestPane, right: HerdrDigestPane): number {
  const byStatus = STATUS_RANK[right.status] - STATUS_RANK[left.status];
  if (byStatus !== 0) return byStatus;
  if (left.focused !== right.focused) return left.focused ? -1 : 1;
  const byBacklog = (right.backlog ?? -1) - (left.backlog ?? -1);
  if (byBacklog !== 0) return byBacklog;
  return left.paneId.localeCompare(right.paneId, undefined, { numeric: true });
}

/**
 * Describe a tab's arrangement from its pane rects.
 *
 * Panes sharing an x start a column; panes sharing a y start a row. A layout
 * whose columns all hold the same number of panes is a grid and is named as
 * one; anything else is named by its columns and their depths, which is both
 * shorter and more truthful than inventing a name for an irregular split.
 */
export function describeHerdrArrangement(
  layout: HerdrTabLayout | null,
  paneCount: number,
): string {
  if (paneCount <= 0) return "no panes";
  if (paneCount === 1) return "single pane";
  const panes = layout?.panes ?? [];
  if (panes.length !== paneCount) return `${paneCount} panes (layout unavailable)`;

  const columns = new Map<number, number>();
  const rows = new Map<number, number>();
  for (const pane of panes) {
    columns.set(pane.rect.x, (columns.get(pane.rect.x) ?? 0) + 1);
    rows.set(pane.rect.y, (rows.get(pane.rect.y) ?? 0) + 1);
  }
  if (columns.size === 1) return `${paneCount} stacked rows`;
  if (rows.size === 1) return `${paneCount} side-by-side columns`;

  const depths = [...columns.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, count]) => count);
  const first = depths[0] ?? 0;
  if (depths.every((depth) => depth === first) && first * columns.size === paneCount) {
    return `${first}×${columns.size} grid`;
  }
  return `${columns.size} columns (${depths.join(" · ")})`;
}

/**
 * Build the digest for one herdr session topology.
 *
 * Pure: the same topology always digests to the same value, so the whole
 * presentation is testable without a herdr server.
 */
export function digestHerdrTopology(
  topology: HerdrSessionTopology,
  options: { paneCap?: number; leadCap?: number } = {},
): HerdrWorkspaceDigest {
  const paneCap = options.paneCap ?? HERDR_DIGEST_PANE_CAP;
  const leadCap = options.leadCap ?? HERDR_DIGEST_LEAD_CAP;

  const counts = emptyCounts();
  const shapes: HerdrDigestShape[] = [];
  const all: HerdrDigestPane[] = [];
  let tabTotal = 0;
  let agentTotal = 0;

  for (const workspace of topology.workspaces) {
    const workspaceLabel = workspace.label ?? (workspace.number != null ? `workspace ${workspace.number}` : workspace.workspaceId);
    for (const tab of workspace.tabs) {
      tabTotal += 1;
      shapes.push({
        workspaceId: workspace.workspaceId,
        workspaceLabel,
        tabId: tab.tabId,
        tabLabel: tab.label ?? (tab.number != null ? `tab ${tab.number}` : tab.tabId),
        paneCount: tab.panes.length,
        arrangement: describeHerdrArrangement(tab.layout, tab.panes.length),
        zoomed: tab.layout?.zoomed ?? false,
        focused: workspace.focused && tab.focused,
      });
      for (const pane of tab.panes) {
        const digestPane = toDigestPane(pane);
        if (!topology.running) {
          digestPane.target = null;
          digestPane.status = "unknown";
        }
        counts[digestPane.status] += 1;
        if (digestPane.agent) agentTotal += 1;
        all.push(digestPane);
      }
    }
  }

  // Groups are filled in rank order so the pane cap spends its budget on the
  // panes that matter, not on whichever directory herdr happened to list first.
  const ranked = [...all].sort(compareLeadPanes);
  const kept = ranked.slice(0, paneCap);
  const droppedByDirectory = new Map<string, HerdrStatusCounts>();
  for (const pane of ranked.slice(paneCap)) {
    const key = pane.directory ?? "";
    let dropped = droppedByDirectory.get(key);
    if (!dropped) {
      dropped = emptyCounts();
      droppedByDirectory.set(key, dropped);
    }
    dropped[pane.status] += 1;
  }

  const groupsByDirectory = new Map<string, HerdrDigestGroup>();
  for (const pane of all) {
    const key = pane.directory ?? "";
    let group = groupsByDirectory.get(key);
    if (!group) {
      group = {
        directory: pane.directory,
        name: directoryName(pane.directory),
        counts: emptyCounts(),
        panes: [],
        omitted: totalCount(droppedByDirectory.get(key) ?? EMPTY_COUNTS),
        omittedCounts: { ...(droppedByDirectory.get(key) ?? EMPTY_COUNTS) },
      };
      groupsByDirectory.set(key, group);
    }
    group.counts[pane.status] += 1;
  }
  const keptIds = new Set(kept.map((pane) => `${pane.workspaceId}/${pane.paneId}`));
  for (const pane of all) {
    if (!keptIds.has(`${pane.workspaceId}/${pane.paneId}`)) continue;
    groupsByDirectory.get(pane.directory ?? "")?.panes.push(pane);
  }

  const groups = [...groupsByDirectory.values()];
  for (const group of groups) group.panes.sort(compareLeadPanes);
  // Groups sort by what is waiting, then what is moving, then size — the same
  // precedence the lead lists use, applied one level up.
  groups.sort((left, right) =>
    right.counts.blocked - left.counts.blocked
    || right.counts.working - left.counts.working
    || (right.panes.length + right.omitted) - (left.panes.length + left.omitted)
    || left.name.localeCompare(right.name, undefined, { numeric: true }));

  const notes: string[] = [];
  if (!topology.running) {
    // "Last known" is only useful with a when: a layout saved an hour ago and
    // one saved in March are the same claim with very different weight.
    const saved = topology.savedAt ? ` Last saved ${new Date(topology.savedAt).toISOString()}.` : "";
    notes.push(topology.unavailable === "unreadable"
      // The session IS running; herdr just would not answer. Saying "stopped"
      // here would be the one thing a digest must never do — state, of live
      // work, that it is not live.
      ? `A herdr server for this session is running but did not answer, so this is the persisted last-known layout, not what is on screen. The usual cause is a protocol skew between the installed herdr client and a long-lived server; restarting that session's server (which exits its pane processes) is what clears it.${saved}`
      : `Not live: this is the persisted last-known layout. Agent status, terminal ids and geometry are absent from it — no pane here is claimed to be running.${saved}`);
  }
  if (counts.unknown > 0) {
    notes.push(
      `${counts.unknown} ${counts.unknown === 1 ? "pane reports" : "panes report"} unknown: herdr sees an agent it cannot classify. Unknown is the absence of a signal, not completion.`,
    );
  }

  return {
    session: topology.session,
    live: topology.running,
    observedAt: topology.observedAt,
    savedAt: topology.savedAt ?? null,
    unavailable: topology.running ? null : topology.unavailable ?? "not_running",
    // Clients are a live-read fact; a saved layout never claims them.
    ...(topology.running && typeof topology.clients === "number"
      ? { clients: topology.clients, apps: [...(topology.apps ?? [])] }
      : {}),
    totals: {
      workspaces: topology.workspaces.length,
      tabs: tabTotal,
      panes: all.length,
      agents: agentTotal,
    },
    counts,
    needsYou: ranked.filter((pane) => pane.status === "blocked").slice(0, leadCap),
    working: ranked.filter((pane) => pane.status === "working").slice(0, leadCap),
    groups,
    shapes,
    truncated: all.length > paneCap,
    notes,
  };
}

/**
 * One row, led by whatever is most specific to this pane.
 *
 * Rows that all begin `term-w1:p1`, `term-w1:p2` share a long prefix, and a
 * scanning reader learns to skip the opening of every line — so the identity
 * column becomes the one column nobody reads. The lead is therefore the pane's
 * label when it has one, and its pane id when it does not, since a short id
 * differs within the first couple of characters where a terminal id does not.
 *
 * The pane id is enough to act on: `herdr agent <verb>` accepts the pane
 * currently hosting an agent as a target. The directory is the basename only —
 * the full path is carried once, in the grouped section, and repeating it on
 * every row buys nothing.
 */
function paneLine(pane: HerdrDigestPane): string {
  const title = pane.name ?? pane.label;
  const parts = title
    ? [title, pane.agent ?? "shell", pane.paneId]
    : [pane.paneId, pane.agent ?? "shell"];
  if (pane.name && pane.label && pane.name !== pane.label) parts.push(pane.label);
  if (pane.directory) parts.push(directoryName(pane.directory));
  parts.push(pane.status);
  if (pane.agentSession) parts.push(`reported ${pane.agentSession.agent} ${pane.agentSession.kind}:${pane.agentSession.value}`);
  if (pane.focused) parts.push("focused");
  return `  ${parts.join("  ")}`;
}

/** "2 idle not shown" — a collapsed label a reader can decide from. */
function omittedLabel(counts: HerdrStatusCounts): string | null {
  const total = totalCount(counts);
  if (total === 0) return null;
  const order: HerdrAgentStatus[] = ["blocked", "working", "idle", "done", "unknown"];
  const present = order.filter((status) => counts[status] > 0);
  if (present.length === 1) return `+${total} ${present[0]} not shown`;
  return `+${total} not shown (${present.map((status) => `${counts[status]} ${status}`).join(" · ")})`;
}

function countsLine(counts: HerdrStatusCounts): string {
  const order: HerdrAgentStatus[] = ["blocked", "working", "idle", "done", "unknown"];
  const parts = order.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${status}`);
  return parts.length ? parts.join(" · ") : "no panes";
}

/**
 * Render a digest as the text an operator should actually read.
 *
 * Ordering is the whole design: what is waiting, then what is moving, then
 * where things live, then how the screen is arranged. A reader who stops after
 * the first section has still got the answer that mattered.
 *
 * Section heads are verb phrases rather than bare nouns, and there is no
 * trailing caveat block: a qualifier that changes how a count should be read
 * sits directly under that count, because a scanning reader reaches the top of
 * the output and not the bottom of it.
 */
export function renderHerdrWorkspaceDigest(digest: HerdrWorkspaceDigest): string {
  const lines: string[] = [];
  const state = digest.live
    ? "live"
    : digest.unavailable === "unreadable" ? "running, not readable" : "not running";
  const { workspaces, tabs, panes } = digest.totals;
  lines.push(
    `herdr · ${digest.session} — ${state} · ${workspaces} workspace${workspaces === 1 ? "" : "s"}, ${tabs} tab${tabs === 1 ? "" : "s"}, ${panes} pane${panes === 1 ? "" : "s"} (${countsLine(digest.counts)})`,
  );
  // Caveats sit under the counts they qualify, not in a block at the bottom.
  // A qualifier that changes how a number should be read is body text; a
  // scanning reader never reaches a footnote, and these are the lines that stop
  // someone believing `unknown` meant done or that a stale layout was current.
  for (const note of digest.notes) lines.push(`  ${note}`);
  lines.push(`  Observed ${new Date(digest.observedAt).toISOString()}; pane names are host labels, not Scout addresses.`);

  if (digest.needsYou.length) {
    lines.push("", "Requests");
    for (const pane of digest.needsYou) lines.push(paneLine(pane));
  }
  if (digest.working.length) {
    lines.push("", "Working now");
    for (const pane of digest.working) lines.push(paneLine(pane));
  }

  if (digest.groups.length) {
    lines.push("", "Grouped by directory");
    for (const group of digest.groups) {
      const total = totalCount(group.counts);
      const where = group.directory ? ` (${group.directory})` : "";
      const hidden = omittedLabel(group.omittedCounts);
      lines.push(`  ${group.name}${where} — ${total} pane${total === 1 ? "" : "s"} · ${countsLine(group.counts)}${hidden ? ` · ${hidden}` : ""}`);
      for (const pane of group.panes) lines.push(`  ${paneLine(pane)}`);
    }
  }

  if (digest.shapes.length) {
    lines.push("", "Arranged like this");
    for (const shape of digest.shapes) {
      const marks = [shape.arrangement];
      if (shape.zoomed) marks.push("zoomed");
      if (shape.focused) marks.push("focused");
      // The tab id leads because two workspaces can carry the same label, and
      // a label can itself contain the separator — the id cannot do either.
      lines.push(`  ${shape.tabId}  ${shape.workspaceLabel} / ${shape.tabLabel} — ${marks.join(" · ")}`);
    }
  }

  return lines.join("\n");
}

/** Local, TTL-cached host observation; never a verified Scout session binding. */
export type HerdrWorkspaceAvailability = Exclude<import("./observed-sessions.js").ObservedSessionInventory["availability"], "unknown">;
export type HerdrWorkspacesRead = {
  schema: "scout.herdr-workspaces/v1";
  nodeId: string;
  scannedAt: number | null;
  availability: HerdrWorkspaceAvailability;
  reason: "not_scanned" | "session_list_unavailable" | null;
  requestedSession: string | null;
  count: number;
  digests: Array<HerdrWorkspaceDigest & { availability: HerdrWorkspaceAvailability }>;
  truncated: boolean;
  coverage: {
    kind: "ttl_cached_probes";
    scope: "this_host_only";
    listedSessions: number | null;
    limits: { sessions: number; enumeratedSessions: number; workspacesPerSession: number; tabsPerSession: number; inputPanesPerSession: number; emittedPanesPerSession: number; leadsPerSession: number; concurrentSessions: number };
  };
};
