import {
  ROSTER_NUMBER_MAX,
  agentRosterTag,
  cleanHeldProjectCode,
  cleanProjectCode,
  parseRosterAddress,
  parseRosterNumber,
  projectCodeRefusal,
  rosterCode,
  rosterIdentityMonogram,
  rosterLabel,
  rosterNumberText,
  rosterProjectCodeCandidates,
  rosterProjectKey,
  type AgentDefinition,
  type AgentEndpoint,
  type AgentRosterDiagnosticCode,
  type AgentRosterEntry,
  type AgentRosterImportConflict,
  type AgentRosterImportRequest,
  type AgentRosterImportResult,
  type AgentRosterListResult,
  type AgentRecordWithRoster,
  type AgentRosterResolveResult,
  type AgentRosterTag,
  type RosterProjectCodeSetRequest,
  type RosterProjectRecord,
} from "@openscout/protocol";

import type { AgentRosterStore, RosterAgentRow, RosterProjectRow } from "./agent-roster-store.js";

/**
 * The agent roster (docs/agent-roster.md): a three-digit number per agent,
 * one roster across projects, and a two- or three-letter code per project.
 *
 * The same agent is the same Scout agent id. A number never follows a
 * handle, a display name or a session: agents that share the handle
 * `claude` hold one number each, and every session of one agent shares its
 * number because sessions do not mint agent ids.
 *
 * An agent takes the lowest free number the first time the runtime sees it
 * active (registered, or its endpoint touched, within `activeWindowMs`).
 * It keeps that number across restarts and sessions. It gives the number up
 * once it is deleted or retired (no longer listed) for `goneGraceMs`, so a
 * re-registration inside that window keeps it. It also gives the number up
 * after `idleFreeMs` with no activity; if it comes back after that, it takes
 * a new number like any newcomer.
 */

/** How long an agent stays deleted or retired before its number is freed: the apps' ROSTER_GONE_MS. */
export const ROSTER_GONE_GRACE_MS = 10 * 60_000;
/** How recently an agent must have been active for the runtime to number it. */
export const ROSTER_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/**
 * How long a listed agent can go with no activity before its number is
 * freed. The idle time counts from the agent's latest activity, or from
 * when it took its number if that is later.
 */
export const ROSTER_IDLE_FREE_MS = 30 * 24 * 60 * 60_000;
/**
 * How far the latest activity must move before the roster writes it down.
 * The stored activity outlives the endpoints it came from, so an agent whose
 * endpoint is pruned does not look idle; writing it at most hourly keeps
 * reconcile from writing a row on every registry change. The service keeps
 * the unwritten part in memory and writes it at once when the registry stops
 * showing it.
 */
export const ROSTER_ACTIVITY_WRITE_STEP_MS = 60 * 60_000;
/**
 * How far ahead of the runtime's clock an activity time may be and still
 * count, as clock skew. A time further ahead is ignored rather than read as
 * now, so a bad timestamp cannot keep an agent active.
 */
export const ROSTER_CLOCK_SKEW_MS = 5 * 60_000;

/** The registry fields the roster reads. */
export type AgentRosterRegistryView = {
  agents: Readonly<Record<string, AgentDefinition>>;
  actors?: Readonly<Record<string, { createdAt?: number }>>;
  endpoints?: Readonly<Record<string, AgentEndpoint>>;
};

export type AgentRosterServiceOptions = {
  store: AgentRosterStore;
  registry: () => AgentRosterRegistryView;
  now?: () => number;
  goneGraceMs?: number;
  activeWindowMs?: number;
  idleFreeMs?: number;
  log?: (message: string) => void;
};

export type AgentRosterReconcileResult = {
  assigned: Array<{ agentId: string; number: number }>;
  /** `gone`: deleted or retired past the grace. `idle`: no activity for `idleFreeMs`. */
  freed: Array<{ agentId: string; number: number; reason: "gone" | "idle" }>;
  /** Agents seen active that found no free number. */
  unnumbered: number;
};

export class AgentRosterError extends Error {
  constructor(
    readonly code: AgentRosterDiagnosticCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentRosterError";
  }
}

const AGENT_ACTIVITY_KEYS = [
  "lastSeenAt",
  "lastActivityAt",
  "updatedAt",
  "registeredAt",
  "startedAt",
  "lastCompletedAt",
] as const;

const ENDPOINT_ACTIVITY_KEYS = [
  "lastSeenAt",
  "lastEnsuredAt",
  "lastStartedAt",
  "lastCompletedAt",
  "lastFailedAt",
  "lastResumedAt",
  "lastInterruptedAt",
  "startedAt",
  "updatedAt",
  "registeredAt",
] as const;

function timestampMs(value: unknown): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
    ? (/^\d+(\.\d+)?$/u.test(value.trim()) ? Number(value) : Date.parse(value))
    : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  // Legacy records carry seconds.
  return numeric < 1_000_000_000_000 ? Math.round(numeric * 1000) : numeric;
}

/** An activity time no later than now; 0 when it is past the clock skew allowance. */
function activityAt(at: number, now: number): number {
  return at > now + ROSTER_CLOCK_SKEW_MS ? 0 : Math.min(at, now);
}

function latestMetadataTimestamp(metadata: Record<string, unknown> | undefined, keys: readonly string[], now: number): number {
  let latest = 0;
  for (const key of keys) latest = Math.max(latest, activityAt(timestampMs(metadata?.[key]), now));
  return latest;
}

/** Each agent's latest endpoint activity. */
function endpointActivityByAgent(registry: AgentRosterRegistryView, now: number): Map<string, number> {
  const activity = new Map<string, number>();
  for (const endpoint of Object.values(registry.endpoints ?? {})) {
    const at = latestMetadataTimestamp(endpoint.metadata, ENDPOINT_ACTIVITY_KEYS, now);
    if (at > (activity.get(endpoint.agentId) ?? 0)) activity.set(endpoint.agentId, at);
  }
  return activity;
}

/**
 * When the runtime first saw an agent, and when the agent or one of its
 * endpoints was last active. The activity is never later than now.
 */
function agentActivityAt(
  registry: AgentRosterRegistryView,
  agentId: string,
  agent: AgentDefinition,
  endpointActivity: ReadonlyMap<string, number>,
  now: number,
): { firstSeenAt: number; activeAt: number } {
  const firstSeenAt = timestampMs(registry.actors?.[agentId]?.createdAt)
    || timestampMs(agent.metadata?.["registeredAt"]);
  const activeAt = Math.max(
    activityAt(firstSeenAt, now),
    latestMetadataTimestamp(agent.metadata, AGENT_ACTIVITY_KEYS, now),
    endpointActivity.get(agentId) ?? 0,
  );
  return { firstSeenAt, activeAt };
}

/** The agent's project name as its record carries it (the apps read the same field). */
export function rosterProjectNameForAgent(agent: AgentDefinition | undefined): string | null {
  const value = agent?.metadata?.["project"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Deleted or retired, for the roster: the runtime no longer lists the agent.
 * Retired from the fleet, or superseded locally. A mesh agent whose peer has
 * gone quiet is not retired; it keeps its number until its record is deleted.
 */
export function isRosterRetiredAgent(agent: AgentDefinition | undefined): boolean {
  if (!agent) return true;
  const metadata = agent.metadata ?? {};
  if (metadata["retiredFromFleet"] === true) return true;
  return metadata["staleLocalRegistration"] === true && metadata["staleMeshRegistration"] !== true;
}

/**
 * A snapshot whose agent records carry their roster tags, for `/v1/snapshot`.
 * The records are copied, never changed. A `roster` field that a record
 * carries without holding a number is dropped. Returns the snapshot itself
 * when there is nothing to add or drop.
 */
export function withRosterTags<T extends { agents?: Record<string, AgentDefinition> }>(
  snapshot: T,
  tags: ReadonlyMap<string, AgentRosterTag>,
): T {
  const agents = snapshot.agents;
  if (!agents) return snapshot;
  let changed = false;
  const tagged: Record<string, AgentRecordWithRoster> = {};
  for (const [agentId, record] of Object.entries(agents)) {
    const tag = tags.get(agentId);
    if (tag) {
      tagged[agentId] = { ...record, roster: tag };
      changed = true;
    } else if (record && "roster" in record) {
      const { roster: _stale, ...rest } = record as AgentRecordWithRoster;
      tagged[agentId] = rest;
      changed = true;
    } else {
      tagged[agentId] = record;
    }
  }
  return changed ? { ...snapshot, agents: tagged } : snapshot;
}

type RosterState = {
  agents: Map<string, RosterAgentRow>;
  byNumber: Map<number, RosterAgentRow>;
  projects: Map<string, RosterProjectRow>;
  codes: Map<string, string>;
};

export class AgentRosterService {
  private readonly now: () => number;
  private readonly goneGraceMs: number;
  private readonly activeWindowMs: number;
  private readonly idleFreeMs: number;
  /** The latest activity reconcile has seen per agent, which can be ahead of the store by less than ROSTER_ACTIVITY_WRITE_STEP_MS. */
  private readonly seenActivity = new Map<string, number>();
  private fullWarned = false;

  constructor(private readonly options: AgentRosterServiceOptions) {
    this.now = options.now ?? Date.now;
    this.goneGraceMs = options.goneGraceMs ?? ROSTER_GONE_GRACE_MS;
    this.activeWindowMs = options.activeWindowMs ?? ROSTER_ACTIVE_WINDOW_MS;
    this.idleFreeMs = options.idleFreeMs ?? ROSTER_IDLE_FREE_MS;
  }

  /** Number newly active agents, mark deleted and retired ones, and free numbers past their grace or idle too long. */
  reconcile(): AgentRosterReconcileResult {
    const registry = this.options.registry();
    const now = this.now();
    const endpointActivity = endpointActivityByAgent(registry, now);
    return this.options.store.transaction(() => {
      const state = this.load();
      const result: AgentRosterReconcileResult = { assigned: [], freed: [], unnumbered: 0 };

      for (const row of [...state.agents.values()]) {
        const agent = registry.agents[row.agentId];
        if (agent && !isRosterRetiredAgent(agent)) {
          const seenAt = agentActivityAt(registry, row.agentId, agent, endpointActivity, now).activeAt;
          const activeAt = this.latestActivity(row, seenAt);
          if (now - Math.max(activeAt, row.assignedAt) >= this.idleFreeMs) {
            this.removeAgent(state, row.agentId);
            this.seenActivity.delete(row.agentId);
            result.freed.push({ agentId: row.agentId, number: row.number, reason: "idle" });
            continue;
          }
          this.seenActivity.set(row.agentId, activeAt);
          const project = rosterProjectNameForAgent(agent);
          const projectKey = project ? rosterProjectKey(project) : null;
          if (project) this.ensureProject(state, project, now);
          if (
            row.goneAt !== null
            || row.projectKey !== projectKey
            || row.project !== project
            || activeAt - row.activeAt >= ROSTER_ACTIVITY_WRITE_STEP_MS
            // The registry no longer shows the latest activity (its endpoint
            // was pruned), so only the store can keep it now.
            || (activeAt > row.activeAt && seenAt < activeAt)
          ) {
            this.writeAgent(state, { ...row, project, projectKey, activeAt, goneAt: null, updatedAt: now });
          }
          continue;
        }
        if (row.goneAt === null) {
          this.writeAgent(state, { ...row, goneAt: now, updatedAt: now });
          continue;
        }
        if (now - row.goneAt >= this.goneGraceMs) {
          this.removeAgent(state, row.agentId);
          this.seenActivity.delete(row.agentId);
          result.freed.push({ agentId: row.agentId, number: row.number, reason: "gone" });
        }
      }

      const newcomers = this.activeNewcomers(registry, state, now, endpointActivity);
      for (const { agentId, agent, activeAt } of newcomers) {
        const number = this.lowestFreeNumber(state);
        if (number === null) {
          result.unnumbered = newcomers.length - result.assigned.length;
          if (!this.fullWarned) {
            this.fullWarned = true;
            this.options.log?.(`[openscout-runtime] agent roster is full (${ROSTER_NUMBER_MAX} numbers held); ${result.unnumbered} active agent(s) have no number`);
          }
          break;
        }
        const project = rosterProjectNameForAgent(agent);
        if (project) this.ensureProject(state, project, now);
        this.writeAgent(state, {
          agentId,
          number,
          project,
          projectKey: project ? rosterProjectKey(project) : null,
          source: "auto",
          assignedAt: now,
          activeAt: Math.min(activeAt, now),
          updatedAt: now,
          goneAt: null,
        });
        result.assigned.push({ agentId, number });
      }
      if (result.unnumbered === 0) this.fullWarned = false;
      return result;
    });
  }

  list(): AgentRosterListResult {
    const state = this.load();
    return {
      agents: [...state.agents.values()]
        .sort((a, b) => a.number - b.number)
        .map((row) => this.entryFrom(state, row)),
      projects: [...state.projects.values()].map((row) => this.projectRecord(row)),
      capacity: { max: ROSTER_NUMBER_MAX, held: state.agents.size },
    };
  }

  entry(agentId: string): AgentRosterEntry | null {
    const state = this.load();
    const row = state.agents.get(agentId);
    return row ? this.entryFrom(state, row) : null;
  }

  /** Roster tags by agent id, for decorating agent records in bulk. */
  tags(): Map<string, AgentRosterTag> {
    const state = this.load();
    const tags = new Map<string, AgentRosterTag>();
    for (const row of state.agents.values()) {
      if (row.goneAt !== null) continue;
      tags.set(row.agentId, agentRosterTag(this.entryFrom(state, row)));
    }
    return tags;
  }

  /** Set a project's code; a null code gives it back its default. Refuses a code another project holds. */
  setProjectCode(request: RosterProjectCodeSetRequest): RosterProjectRecord {
    const name = request.project?.trim();
    if (!name) throw new AgentRosterError("unknown_project", "a project name is required");
    const key = rosterProjectKey(name);
    const now = this.now();
    return this.options.store.transaction(() => {
      const state = this.load();
      let project = state.projects.get(key);
      if (!project) {
        const known = Object.values(this.options.registry().agents)
          .map(rosterProjectNameForAgent)
          .find((candidate) => candidate !== null && rosterProjectKey(candidate) === key);
        if (!known) {
          throw new AgentRosterError("unknown_project", `no agent lists project "${name}"`, { project: name });
        }
        project = this.ensureProject(state, known, now);
      }

      if (request.code === null || request.code === undefined || request.code === "") {
        const code = this.firstFreeCode(state, project.name, key);
        return this.projectRecord(this.writeProject(state, { ...project, code, codeSource: "default", updatedAt: now }));
      }

      const code = cleanProjectCode(request.code);
      if (!code) {
        throw new AgentRosterError("invalid_project_code", projectCodeRefusal(String(request.code)), { code: request.code });
      }
      const holder = state.codes.get(code);
      if (holder && holder !== key) {
        const held = state.projects.get(holder);
        throw new AgentRosterError(
          "project_code_held",
          `${code} is held by project "${held?.name ?? holder}"`,
          { code, heldBy: held?.name ?? holder },
        );
      }
      return this.projectRecord(this.writeProject(state, { ...project, code, codeSource: "operator", updatedAt: now }));
    });
  }

  /**
   * Take the numbers and project codes the apps handed out locally. An
   * entry keeps its number when no other imported agent holds it; a number
   * the runtime gave on its own moves aside (`renumbered`), since the apps'
   * numbers are the ones the operator has seen. Everything else that cannot
   * be kept is reported, never guessed.
   */
  importEntries(request: AgentRosterImportRequest): AgentRosterImportResult {
    const dryRun = request.dryRun === true;
    const registry = this.options.registry();
    const now = this.now();
    const endpointActivity = endpointActivityByAgent(registry, now);
    const run = (): AgentRosterImportResult => {
      const state = this.load();
      const result: AgentRosterImportResult = { dryRun, imported: [], renumbered: [], projectCodes: [], conflicts: [] };
      const conflict = (entry: AgentRosterImportConflict) => result.conflicts.push(entry);
      const claimedNumbers = new Map<number, string>();
      const claimedAgents = new Set<string>();
      const accepted: Array<{
        agentId: string;
        number: number;
        project: string | null;
        projectCode: string | null | undefined;
        activeAt: number;
        /** Already imported on this number: a re-run leaves the row as it is, idle time included. */
        unchanged: boolean;
      }> = [];

      for (const raw of Array.isArray(request.entries) ? request.entries : []) {
        const agentId = typeof raw?.agentId === "string" ? raw.agentId.trim() : "";
        const number = parseRosterNumber(raw?.number as number | string | undefined);
        if (!agentId || number === null) {
          conflict({
            agentId,
            reason: "invalid_entry",
            detail: !agentId ? "entry has no agentId" : `"${String(raw?.number)}" is not a roster number from 001 to 999`,
          });
          continue;
        }
        if (claimedAgents.has(agentId)) {
          conflict({ agentId, number, reason: "duplicate_agent", detail: `${agentId} appears more than once; the first entry was kept` });
          continue;
        }
        const firstClaim = claimedNumbers.get(number);
        if (firstClaim) {
          conflict({ agentId, number, reason: "duplicate_number", detail: `${rosterNumberText(number)} is also claimed by ${firstClaim} earlier in the import`, heldBy: firstClaim });
          continue;
        }
        const agent = registry.agents[agentId];
        if (!agent) {
          conflict({ agentId, number, reason: "unknown_agent", detail: `the runtime does not know agent ${agentId}` });
          continue;
        }
        if (isRosterRetiredAgent(agent)) {
          conflict({ agentId, number, reason: "agent_not_listed", detail: `${agentId} is retired or superseded, so it holds no number` });
          continue;
        }
        const current = state.agents.get(agentId);
        if (current?.source === "import" && current.number !== number) {
          conflict({ agentId, number, reason: "agent_already_imported", detail: `${agentId} already holds imported number ${rosterNumberText(current.number)}`, heldBy: agentId });
          continue;
        }
        const holder = state.byNumber.get(number);
        if (holder && holder.agentId !== agentId && holder.source === "import") {
          conflict({ agentId, number, reason: "number_held", detail: `${rosterNumberText(number)} is held by ${holder.agentId}, imported earlier`, heldBy: holder.agentId });
          continue;
        }
        claimedAgents.add(agentId);
        claimedNumbers.set(number, agentId);
        accepted.push({
          agentId,
          number,
          project: rosterProjectNameForAgent(agent),
          projectCode: raw.projectCode,
          activeAt: Math.max(
            current ? this.latestActivity(current, 0) : 0,
            agentActivityAt(registry, agentId, agent, endpointActivity, now).activeAt,
          ),
          unchanged: current?.source === "import" && current.number === number,
        });
      }

      // Move every accepted agent onto its number. Rows leave the unique
      // number index before any row takes a number, so swaps cannot collide.
      const importedAgentIds = new Set(accepted.map((entry) => entry.agentId));
      const displaced: RosterAgentRow[] = [];
      for (const entry of accepted) {
        const holder = state.byNumber.get(entry.number);
        if (holder && !importedAgentIds.has(holder.agentId)) displaced.push(holder);
      }
      const moving = accepted.filter((entry) => !entry.unchanged);
      for (const entry of moving) this.removeAgent(state, entry.agentId);
      for (const row of displaced) this.removeAgent(state, row.agentId);
      for (const entry of moving) {
        this.writeAgent(state, {
          agentId: entry.agentId,
          number: entry.number,
          project: entry.project,
          projectKey: entry.project ? rosterProjectKey(entry.project) : null,
          source: "import",
          assignedAt: now,
          activeAt: entry.activeAt,
          updatedAt: now,
          goneAt: null,
        });
      }
      for (const row of displaced) {
        const to = this.lowestFreeNumber(state);
        if (to !== null) this.writeAgent(state, { ...row, number: to, assignedAt: now, activeAt: this.latestActivity(row, 0), updatedAt: now });
        result.renumbered.push({ agentId: row.agentId, from: row.number, to });
      }

      // Project codes, first entry per project wins.
      const decided = new Map<string, string | null>();
      for (const entry of accepted) {
        const requested = entry.projectCode;
        if (requested === undefined || requested === null || requested === "") {
          if (entry.project) this.ensureProject(state, entry.project, now);
          continue;
        }
        let code = cleanProjectCode(requested);
        if (!code && entry.project) {
          // A digit passes only as the project's own default (app-2 → A2), which the apps show too.
          const held = cleanHeldProjectCode(requested);
          if (held && held === this.ensureProject(state, entry.project, now).code) code = held;
        }
        if (!code) {
          conflict({ agentId: entry.agentId, number: entry.number, projectCode: requested, reason: "invalid_project_code", detail: projectCodeRefusal(String(requested)) });
          continue;
        }
        if (!entry.project) {
          conflict({ agentId: entry.agentId, number: entry.number, projectCode: code, reason: "no_project", detail: `${entry.agentId} has no project, so ${code} was not set` });
          continue;
        }
        const key = rosterProjectKey(entry.project);
        const project = this.ensureProject(state, entry.project, now);
        const earlier = decided.get(key);
        if (earlier !== undefined) {
          if (earlier !== code) {
            conflict({ agentId: entry.agentId, number: entry.number, projectCode: code, reason: "project_code_differs", detail: `an earlier entry set project "${project.name}" to ${earlier ?? "no code"}`, heldBy: project.name });
          }
          continue;
        }
        if (project.code === code) {
          // The import names the default the project already has. The code
          // does not change, but the import now owns it, so a later import
          // cannot rename the project.
          if (project.codeSource === "default") {
            this.writeProject(state, { ...project, codeSource: "import", updatedAt: now });
          }
          decided.set(key, code);
          continue;
        }
        if (project.codeSource !== "default") {
          decided.set(key, project.code);
          conflict({ agentId: entry.agentId, number: entry.number, projectCode: code, reason: "project_code_differs", detail: `project "${project.name}" already has code ${project.code ?? "none"}, set by ${project.codeSource}`, heldBy: project.name });
          continue;
        }
        const holder = state.codes.get(code);
        if (holder && holder !== key) {
          decided.set(key, project.code);
          const held = state.projects.get(holder);
          conflict({ agentId: entry.agentId, number: entry.number, projectCode: code, reason: "project_code_held", detail: `${code} is held by project "${held?.name ?? holder}"`, heldBy: held?.name ?? holder });
          continue;
        }
        this.writeProject(state, { ...project, code, codeSource: "import", updatedAt: now });
        decided.set(key, code);
        result.projectCodes.push({ projectKey: key, code });
      }

      for (const entry of accepted) {
        const row = state.agents.get(entry.agentId)!;
        result.imported.push({ agentId: entry.agentId, number: entry.number, code: this.entryFrom(state, row).code });
      }
      return result;
    };

    if (!dryRun) return this.options.store.transaction(run);
    // A dry run does the same work inside a transaction it then rolls back.
    let preview: AgentRosterImportResult | null = null;
    try {
      this.options.store.transaction(() => {
        preview = run();
        throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
    return preview!;
  }

  /** Resolve `OS-003`, `os003`, `OS 003` or `003` to the agent that holds it. */
  resolve(address: string): AgentRosterResolveResult {
    const text = address?.trim() ?? "";
    const parsed = parseRosterAddress(text);
    if (!parsed) {
      return this.unresolved(text, "invalid_roster_address", `"${text}" is not a roster code: use OS-003, os003 or 003`);
    }
    const state = this.load();
    const number = rosterNumberText(parsed.number);
    if (parsed.projectCode && !state.codes.has(parsed.projectCode)) {
      return this.unresolved(text, "unknown_project_code", `no project has code ${parsed.projectCode}; scout roster lists the codes`);
    }
    const row = state.byNumber.get(parsed.number);
    if (!row) {
      return this.unresolved(text, "unknown_roster_number", `no agent holds roster number ${number}`);
    }
    const entry = this.entryFrom(state, row);
    if (parsed.projectCode && parsed.projectCode !== entry.projectCode) {
      return {
        ...this.unresolved(text, "roster_code_mismatch", `${parsed.projectCode}-${number} names no agent: ${number} is ${entry.code} (${row.agentId})`),
        entry,
      };
    }
    // The code still belongs to a gone agent until its number frees.
    const agent = this.options.registry().agents[row.agentId];
    if (row.goneAt !== null || !agent || isRosterRetiredAgent(agent)) {
      return { ...this.unresolved(text, "roster_agent_gone", `${entry.code} belonged to ${row.agentId}, which the runtime no longer lists`), entry };
    }
    return { address: text, resolved: true, entry };
  }

  private unresolved(address: string, code: AgentRosterDiagnosticCode, detail: string): AgentRosterResolveResult {
    return { address, resolved: false, diagnostic: { code, detail } };
  }

  private load(): RosterState {
    const agents = new Map<string, RosterAgentRow>();
    const byNumber = new Map<number, RosterAgentRow>();
    for (const row of this.options.store.agents()) {
      agents.set(row.agentId, row);
      byNumber.set(row.number, row);
    }
    const projects = new Map<string, RosterProjectRow>();
    const codes = new Map<string, string>();
    for (const row of this.options.store.projects()) {
      projects.set(row.projectKey, row);
      if (row.code) codes.set(row.code, row.projectKey);
    }
    return { agents, byNumber, projects, codes };
  }

  private writeAgent(state: RosterState, row: RosterAgentRow): void {
    const previous = state.agents.get(row.agentId);
    if (previous && state.byNumber.get(previous.number)?.agentId === row.agentId) {
      state.byNumber.delete(previous.number);
    }
    this.options.store.upsertAgent(row);
    state.agents.set(row.agentId, row);
    state.byNumber.set(row.number, row);
  }

  /** The latest activity known for a row: stored, seen by an earlier reconcile, or seen now. */
  private latestActivity(row: RosterAgentRow, seenAt: number): number {
    return Math.max(row.activeAt, this.seenActivity.get(row.agentId) ?? 0, seenAt);
  }

  private removeAgent(state: RosterState, agentId: string): void {
    const previous = state.agents.get(agentId);
    if (!previous) return;
    this.options.store.deleteAgent(agentId);
    state.agents.delete(agentId);
    if (state.byNumber.get(previous.number)?.agentId === agentId) state.byNumber.delete(previous.number);
  }

  private writeProject(state: RosterState, row: RosterProjectRow): RosterProjectRow {
    const previous = state.projects.get(row.projectKey);
    if (previous?.code && state.codes.get(previous.code) === row.projectKey) state.codes.delete(previous.code);
    this.options.store.upsertProject(row);
    state.projects.set(row.projectKey, row);
    if (row.code) state.codes.set(row.code, row.projectKey);
    return row;
  }

  /** The project's record, made on first sight with its default code (or the first free candidate). */
  private ensureProject(state: RosterState, name: string, now: number): RosterProjectRow {
    const key = rosterProjectKey(name);
    const existing = state.projects.get(key);
    if (existing) return existing;
    return this.writeProject(state, {
      projectKey: key,
      name,
      code: this.firstFreeCode(state, name, key),
      codeSource: "default",
      createdAt: now,
      updatedAt: now,
    });
  }

  private firstFreeCode(state: RosterState, name: string, key: string): string | null {
    for (const candidate of rosterProjectCodeCandidates(name)) {
      const holder = state.codes.get(candidate);
      if (!holder || holder === key) return candidate;
    }
    return null;
  }

  private lowestFreeNumber(state: RosterState): number | null {
    for (let number = 1; number <= ROSTER_NUMBER_MAX; number++) {
      if (!state.byNumber.has(number)) return number;
    }
    return null;
  }

  /** Listed agents without a number, active within the window, in the order the runtime first saw them. */
  private activeNewcomers(
    registry: AgentRosterRegistryView,
    state: RosterState,
    now: number,
    endpointActivity: ReadonlyMap<string, number>,
  ): Array<{ agentId: string; agent: AgentDefinition; firstSeenAt: number; activeAt: number }> {
    const cutoff = now - this.activeWindowMs;
    const newcomers: Array<{ agentId: string; agent: AgentDefinition; firstSeenAt: number; activeAt: number }> = [];
    for (const [agentId, agent] of Object.entries(registry.agents)) {
      if (state.agents.has(agentId) || isRosterRetiredAgent(agent)) continue;
      const { firstSeenAt, activeAt } = agentActivityAt(registry, agentId, agent, endpointActivity, now);
      if (activeAt < cutoff) continue;
      newcomers.push({ agentId, agent, firstSeenAt: firstSeenAt || activeAt, activeAt });
    }
    newcomers.sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
    return newcomers;
  }

  private entryFrom(state: RosterState, row: RosterAgentRow): AgentRosterEntry {
    const projectCode = row.projectKey ? state.projects.get(row.projectKey)?.code ?? null : null;
    return {
      agentId: row.agentId,
      number: row.number,
      numberText: rosterNumberText(row.number),
      projectKey: row.projectKey,
      project: row.project,
      projectCode,
      code: rosterCode(projectCode, row.number),
      label: rosterLabel(projectCode, row.number),
      source: row.source,
      assignedAt: row.assignedAt,
      ...(row.goneAt !== null ? { goneAt: row.goneAt } : {}),
    };
  }

  private projectRecord(row: RosterProjectRow): RosterProjectRecord {
    return {
      projectKey: row.projectKey,
      name: row.name,
      code: row.code,
      codeSource: row.codeSource,
      defaultCode: rosterIdentityMonogram(row.name),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

class DryRunRollback extends Error {}
