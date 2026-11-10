/**
 * Work lifecycles.
 *
 * A lifecycle is a document: stations, the moves between them, and rules. The
 * runtime compiles it into a small state machine, and every work item that has
 * a placement is an instance of that machine. A station maps to exactly one
 * WorkItemState, so `state` stays the shared floor that every view agrees on and
 * the station adds the detail.
 *
 * Each move runs only deterministic checks (`decideWorkMove`). Judges are prose
 * criteria; a move into a station with judges is recorded as pending review, and
 * a reviewer agent settles it later on a heartbeat. No model runs on a move.
 */
import type { WorkItemRecord, WorkItemState } from "./collaboration.js";

export const WORK_LIFECYCLE_SCHEMA = "openscout.work-lifecycle.v1" as const;

export type WorkStationId = string;

/** Deterministic predicates over the facts of a move. */
export type WorkLifecycleCheck =
  | { kind: "has_owner" }
  | { kind: "has_waiting_on" }
  | { kind: "has_note" }
  | { kind: "has_label"; label: string }
  | { kind: "lacks_label"; label: string }
  | { kind: "has_evidence"; evidence: string }
  | { kind: "mover_is_owner" }
  | { kind: "mover_is_not_owner" }
  | { kind: "children_settled" };

export type WorkLifecycleCheckKind = WorkLifecycleCheck["kind"];

/** What a failed check does to the move. */
export type WorkRuleEffect = "deny" | "hold" | "consult" | "advise";

export interface WorkLifecycleRule {
  id: string;
  check: WorkLifecycleCheck;
  effect: WorkRuleEffect;
  /** Shown to the mover when the check fails. */
  message: string;
  /** Recorded but not enforced: the outcome is kept, the verdict ignores it. */
  shadow?: boolean;
}

/** A prose criterion a reviewer agent applies on the heartbeat. */
export interface WorkLifecycleJudge {
  id: string;
  criterion: string;
}

export interface WorkStation {
  id: WorkStationId;
  name: string;
  state: WorkItemState;
  purpose?: string;
  /** The station used for items in `state` that have no placement yet. */
  primary?: boolean;
  /** Checked on every move into this station. */
  rules?: WorkLifecycleRule[];
  /** Applied on the heartbeat to moves into this station. */
  judges?: WorkLifecycleJudge[];
}

export interface WorkTransition {
  /** A station id, or "*" for any station. */
  from: WorkStationId | "*";
  to: WorkStationId;
  name?: string;
  rules?: WorkLifecycleRule[];
}

export interface WorkLifecycle {
  schema: typeof WORK_LIFECYCLE_SCHEMA;
  id: string;
  name: string;
  version: number;
  description?: string;
  /** Column order. */
  stations: WorkStation[];
  transitions: WorkTransition[];
}

/** Where an item sits in a lifecycle. Stored on the work item. */
export interface WorkPlacement {
  lifecycleId: string;
  lifecycleVersion: number;
  station: WorkStationId;
  /** Increments on every recorded move; a review names the revision it judged. */
  revision: number;
  movedAt: number;
  /** Set while judges on the current station have not settled the move. */
  reviewPending?: boolean;
}

export interface WorkMoveEvidence {
  kind: string;
  ref: string;
  observedAt?: number;
}

export type WorkMoveVerdict = "allow" | "deny" | "hold" | "consult";

export interface WorkMoveReason {
  ruleId: string;
  scope: "transition" | "station" | "graph";
  check: WorkLifecycleCheckKind | "transition";
  outcome: "pass" | "fail";
  effect: WorkRuleEffect;
  message: string;
  shadow?: boolean;
}

/** The facts a decision read, snapshotted so a replay sees what the move saw. */
export interface WorkMoveFacts {
  state: WorkItemState;
  ownerId?: string | null;
  labels: string[];
  waitingOn: boolean;
  note: boolean;
  evidence: string[];
  children: { total: number; settled: number };
}

export interface WorkMoveDecision {
  verdict: WorkMoveVerdict;
  lifecycleId: string;
  lifecycleVersion: number;
  lifecycleHash: string;
  from: WorkStationId;
  to: WorkStationId;
  toState: WorkItemState;
  reasons: WorkMoveReason[];
  /** Judges that a reviewer applies later; empty means nothing to review. */
  judges: string[];
  review: "pending" | "not_needed";
  facts: WorkMoveFacts;
}

export type WorkMoveReviewStatus = "pending" | "not_needed" | "confirmed" | "reopened" | "consulted" | "stale";

/** One row of the move ledger. Denied and held moves are recorded too. */
export interface WorkMoveRecord {
  id: string;
  itemId: string;
  lifecycleId: string;
  lifecycleVersion: number;
  from: WorkStationId;
  to: WorkStationId;
  moverId: string;
  verdict: WorkMoveVerdict;
  decision: WorkMoveDecision;
  evidence: WorkMoveEvidence[];
  note?: string;
  /** The placement revision this move produced, when it was applied. */
  revision?: number;
  review: WorkMoveReviewStatus;
  reviewNote?: string;
  reviewedById?: string;
  reviewedAt?: number;
  createdAt: number;
}

export type WorkReviewVerdict = "confirm" | "reopen" | "consult";

// ---------------------------------------------------------------------------
// Validation and compilation

const WORK_ITEM_STATES: readonly WorkItemState[] = ["open", "working", "waiting", "review", "done", "cancelled"];
const CHECK_KINDS: readonly WorkLifecycleCheckKind[] = [
  "has_owner", "has_waiting_on", "has_note", "has_label", "lacks_label", "has_evidence",
  "mover_is_owner", "mover_is_not_owner", "children_settled",
];
const EFFECTS: readonly WorkRuleEffect[] = ["deny", "hold", "consult", "advise"];

function isTerminalState(state: WorkItemState): boolean {
  return state === "done" || state === "cancelled";
}

export function validateWorkLifecycle(doc: WorkLifecycle): string[] {
  const errors: string[] = [];
  if (doc.schema !== WORK_LIFECYCLE_SCHEMA) errors.push(`schema must be ${WORK_LIFECYCLE_SCHEMA}`);
  if (!doc.id?.trim()) errors.push("id is required");
  if (!doc.name?.trim()) errors.push("name is required");
  if (!Number.isInteger(doc.version) || doc.version < 1) errors.push("version must be a positive integer");
  if (!Array.isArray(doc.stations) || doc.stations.length === 0) {
    errors.push("at least one station is required");
    return errors;
  }
  const ids = new Set<string>();
  const ruleIds = new Set<string>();
  const checkRule = (rule: WorkLifecycleRule, where: string) => {
    if (!rule.id?.trim()) errors.push(`${where}: rule id is required`);
    else if (ruleIds.has(rule.id)) errors.push(`${where}: duplicate rule id ${rule.id}`);
    else ruleIds.add(rule.id);
    if (!CHECK_KINDS.includes(rule.check?.kind)) errors.push(`${where}: unknown check ${String(rule.check?.kind)}`);
    if ((rule.check?.kind === "has_label" || rule.check?.kind === "lacks_label") && !rule.check.label?.trim()) errors.push(`${where}: ${rule.check.kind} needs a label`);
    if (rule.check?.kind === "has_evidence" && !rule.check.evidence?.trim()) errors.push(`${where}: has_evidence needs an evidence kind`);
    if (!EFFECTS.includes(rule.effect)) errors.push(`${where}: unknown effect ${String(rule.effect)}`);
    if (!rule.message?.trim()) errors.push(`${where}: rule ${rule.id} needs a message`);
  };
  const primaries = new Map<WorkItemState, string>();
  for (const station of doc.stations) {
    if (!station.id?.trim()) { errors.push("station id is required"); continue; }
    if (station.id === "*") errors.push("station id * is reserved");
    if (ids.has(station.id)) errors.push(`duplicate station ${station.id}`);
    ids.add(station.id);
    if (!WORK_ITEM_STATES.includes(station.state)) errors.push(`station ${station.id}: unknown state ${String(station.state)}`);
    if (station.primary) {
      if (primaries.has(station.state)) errors.push(`station ${station.id}: state ${station.state} already has a primary station`);
      primaries.set(station.state, station.id);
    }
    for (const rule of station.rules ?? []) checkRule(rule, `station ${station.id}`);
    for (const judge of station.judges ?? []) {
      if (!judge.id?.trim() || !judge.criterion?.trim()) errors.push(`station ${station.id}: a judge needs an id and a criterion`);
    }
  }
  for (const t of doc.transitions ?? []) {
    const where = `transition ${t.from}->${t.to}`;
    if (t.from !== "*" && !ids.has(t.from)) errors.push(`${where}: unknown station ${t.from}`);
    if (!ids.has(t.to)) errors.push(`${where}: unknown station ${t.to}`);
    for (const rule of t.rules ?? []) checkRule(rule, where);
  }
  if (errors.length) return errors;

  // Every station must be able to reach a terminal station: no item gets stuck.
  const machine = buildMachine(doc);
  for (const station of doc.stations) {
    if (!canReachTerminal(machine, station.id)) errors.push(`station ${station.id} cannot reach a done or cancelled station`);
  }
  return errors;
}

export interface CompiledWorkStation extends WorkStation {
  index: number;
  terminal: boolean;
  /** Reachable stations and the rules on each move. */
  next: Map<WorkStationId, WorkLifecycleRule[]>;
}

/** A lifecycle compiled into a state machine. Pure; safe to cache by hash. */
export interface CompiledWorkLifecycle {
  doc: WorkLifecycle;
  id: string;
  version: number;
  hash: string;
  stations: Map<WorkStationId, CompiledWorkStation>;
  order: WorkStationId[];
  /** The station for an item that has a state but no placement. */
  stationForState(state: WorkItemState): WorkStationId;
  can(from: WorkStationId, to: WorkStationId): boolean;
  nextStations(from: WorkStationId): WorkStationId[];
}

function buildMachine(doc: WorkLifecycle): Map<WorkStationId, CompiledWorkStation> {
  const stations = new Map<WorkStationId, CompiledWorkStation>();
  doc.stations.forEach((s, index) => stations.set(s.id, { ...s, index, terminal: isTerminalState(s.state), next: new Map() }));
  for (const t of doc.transitions) {
    const sources = t.from === "*" ? [...stations.keys()] : [t.from];
    for (const from of sources) {
      if (from === t.to) continue;
      const station = stations.get(from);
      if (!station) continue;
      const existing = station.next.get(t.to) ?? [];
      station.next.set(t.to, [...existing, ...(t.rules ?? [])]);
    }
  }
  return stations;
}

function canReachTerminal(stations: Map<WorkStationId, CompiledWorkStation>, start: WorkStationId): boolean {
  const seen = new Set<WorkStationId>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const station = stations.get(id);
    if (!station) continue;
    if (station.terminal) return true;
    queue.push(...station.next.keys());
  }
  return false;
}

/** Stable short hash of the document (FNV-1a over canonical JSON). */
export function hashWorkLifecycle(doc: WorkLifecycle): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>).sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  let h = 0x811c9dc5;
  const text = canonical(doc);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function compileWorkLifecycle(doc: WorkLifecycle): CompiledWorkLifecycle {
  const errors = validateWorkLifecycle(doc);
  if (errors.length) throw new Error(`invalid work lifecycle ${doc.id}: ${errors.join("; ")}`);
  const stations = buildMachine(doc);
  const order = doc.stations.map((s) => s.id);
  const byState = new Map<WorkItemState, WorkStationId>();
  for (const s of doc.stations) if (s.primary) byState.set(s.state, s.id);
  for (const s of doc.stations) if (!byState.has(s.state)) byState.set(s.state, s.id);
  return {
    doc,
    id: doc.id,
    version: doc.version,
    hash: hashWorkLifecycle(doc),
    stations,
    order,
    stationForState(state) {
      const id = byState.get(state);
      if (id) return id;
      // A lifecycle without a station for this state: fall back to the first
      // station whose state is terminal-equal, else the first station.
      const fallback = doc.stations.find((s) => isTerminalState(s.state) === isTerminalState(state));
      return (fallback ?? doc.stations[0]!).id;
    },
    can(from, to) {
      return stations.get(from)?.next.has(to) ?? false;
    },
    nextStations(from) {
      return order.filter((id) => stations.get(from)?.next.has(id));
    },
  };
}

/**
 * The lifecycle as an XState v5 machine config, for visualizers and for anyone
 * who wants to run it with XState. Events are `MOVE.<station>`; rules become
 * named guards, and judges become tags.
 */
export function workLifecycleToXState(machine: CompiledWorkLifecycle, initial?: WorkStationId): Record<string, unknown> {
  const states: Record<string, unknown> = {};
  for (const id of machine.order) {
    const s = machine.stations.get(id)!;
    const on: Record<string, unknown> = {};
    for (const [to, rules] of s.next) {
      const entry = machine.stations.get(to)?.rules ?? [];
      const guards = [...rules, ...entry].filter((r) => r.effect !== "advise").map((r) => r.id);
      on[`MOVE.${to}`] = guards.length ? { target: to, guard: { type: "rules", params: { rules: guards } } } : { target: to };
    }
    states[id] = {
      description: s.purpose ?? s.name,
      tags: [s.state, ...(s.judges ?? []).map((j) => `judge:${j.id}`)],
      meta: { name: s.name, state: s.state },
      on,
      ...(s.terminal && s.next.size === 0 ? { type: "final" } : {}),
    };
  }
  return { id: machine.id, version: String(machine.version), initial: initial ?? machine.stationForState("open"), states };
}

// ---------------------------------------------------------------------------
// Deciding a move

export interface WorkMoveInput {
  item: Pick<WorkItemRecord, "state" | "ownerId" | "labels" | "waitingOn"> & { placement?: WorkPlacement | null };
  to: WorkStationId;
  moverId: string;
  note?: string;
  evidence?: WorkMoveEvidence[];
  /** Waiting reason supplied with the move, counted as waitingOn. */
  waitingOn?: unknown;
  children?: Array<{ state: WorkItemState }>;
}

export function workMoveFacts(input: WorkMoveInput): WorkMoveFacts {
  const children = input.children ?? [];
  return {
    state: input.item.state,
    ownerId: input.item.ownerId ?? null,
    labels: [...(input.item.labels ?? [])],
    waitingOn: Boolean(input.waitingOn ?? input.item.waitingOn),
    note: Boolean(input.note?.trim()),
    evidence: [...new Set((input.evidence ?? []).map((e) => e.kind))],
    children: { total: children.length, settled: children.filter((c) => isTerminalState(c.state)).length },
  };
}

function runCheck(check: WorkLifecycleCheck, facts: WorkMoveFacts, moverId: string): boolean {
  switch (check.kind) {
    case "has_owner": return Boolean(facts.ownerId);
    case "has_waiting_on": return facts.waitingOn;
    case "has_note": return facts.note;
    case "has_label": return facts.labels.includes(check.label);
    case "lacks_label": return !facts.labels.includes(check.label);
    case "has_evidence": return facts.evidence.includes(check.evidence);
    case "mover_is_owner": return Boolean(facts.ownerId) && facts.ownerId === moverId;
    case "mover_is_not_owner": return !facts.ownerId || facts.ownerId !== moverId;
    case "children_settled": return facts.children.settled === facts.children.total;
  }
}

const VERDICT_RANK: Record<WorkMoveVerdict, number> = { allow: 0, hold: 1, consult: 2, deny: 3 };

/**
 * The station an item is in now. `state` is the floor: a placement counts only
 * while its station still maps to the item's state, so a writer that changes
 * `state` without a move (an older client, a flight ending) moves the card to
 * the primary station for the new state instead of leaving it stale.
 */
export function currentWorkStation(machine: CompiledWorkLifecycle, item: WorkMoveInput["item"]): WorkStationId {
  const placed = item.placement;
  const station = placed && placed.lifecycleId === machine.id ? machine.stations.get(placed.station) : undefined;
  if (station && station.state === item.state) return station.id;
  return machine.stationForState(item.state);
}

/** Read the placement a runtime stored in work item metadata. */
export function workPlacementOf(record: { metadata?: Record<string, unknown> | null }): WorkPlacement | null {
  const value = record.metadata?.workPlacement as WorkPlacement | undefined;
  if (!value || typeof value !== "object" || typeof value.lifecycleId !== "string" || typeof value.station !== "string") return null;
  return value;
}

// ---------------------------------------------------------------------------
// Runtime API shapes

export interface WorkMoveRequest {
  workId: string;
  to: WorkStationId;
  actorId?: string;
  note?: string;
  evidence?: WorkMoveEvidence[];
  /** A waiting reason, required by stations that map to `waiting`. */
  waitingOn?: { kind?: string; label: string; targetId?: string };
  /**
   * Claim the item before the checks run: the mover becomes the owner under a
   * lease. Fails with a conflict when someone else holds an active claim.
   */
  claim?: boolean;
  /** The mover's session, recorded on the claim. */
  sessionAddress?: string;
  /** Lease length for the claim. */
  leaseMs?: number;
  /** Decide without recording anything. */
  dryRun?: boolean;
}

export interface WorkMoveResponse {
  decision: WorkMoveDecision;
  /** Absent for a dry run and for a denied move. */
  move?: WorkMoveRecord;
  applied: boolean;
}

export interface WorkReviewRequest {
  workId: string;
  moveId: string;
  verdict: WorkReviewVerdict;
  /** The placement revision the reviewer judged; a later move makes the review stale. */
  revision: number;
  actorId?: string;
  note?: string;
}

export interface WorkReviewResponse {
  move: WorkMoveRecord;
  status: WorkMoveReviewStatus;
  /** Set when a reopen moved the item. */
  station?: WorkStationId;
}

export interface WorkLifecycleSummary {
  lifecycle: WorkLifecycle;
  hash: string;
  builtIn: boolean;
  /** The XState export, for visualizers. */
  machine: Record<string, unknown>;
}

/**
 * Decide a move with deterministic checks only. Gates combine strictest-first:
 * deny, then consult, then hold, then allow. Advise and shadow rules are kept
 * as reasons and never change the verdict.
 */
export function decideWorkMove(machine: CompiledWorkLifecycle, input: WorkMoveInput): WorkMoveDecision {
  const from = currentWorkStation(machine, input.item);
  const facts = workMoveFacts(input);
  const target = machine.stations.get(input.to);
  const base = {
    lifecycleId: machine.id,
    lifecycleVersion: machine.version,
    lifecycleHash: machine.hash,
    from,
    to: input.to,
    facts,
  };
  if (!target) {
    return { ...base, verdict: "deny", toState: input.item.state, judges: [], review: "not_needed",
      reasons: [{ ruleId: "graph", scope: "graph", check: "transition", outcome: "fail", effect: "deny", message: `No station ${input.to} in ${machine.id}.` }] };
  }
  if (from === input.to) {
    return { ...base, verdict: "deny", toState: target.state, judges: [], review: "not_needed",
      reasons: [{ ruleId: "graph", scope: "graph", check: "transition", outcome: "fail", effect: "deny", message: `Already in ${target.name}.` }] };
  }
  if (!machine.can(from, input.to)) {
    const fromName = machine.stations.get(from)?.name ?? from;
    return { ...base, verdict: "deny", toState: target.state, judges: [], review: "not_needed",
      reasons: [{ ruleId: "graph", scope: "graph", check: "transition", outcome: "fail", effect: "deny", message: `${fromName} cannot move to ${target.name}.` }] };
  }
  const reasons: WorkMoveReason[] = [];
  let verdict: WorkMoveVerdict = "allow";
  const apply = (rules: WorkLifecycleRule[], scope: "transition" | "station") => {
    for (const rule of rules) {
      const pass = runCheck(rule.check, facts, input.moverId);
      reasons.push({ ruleId: rule.id, scope, check: rule.check.kind, outcome: pass ? "pass" : "fail", effect: rule.effect, message: rule.message, ...(rule.shadow ? { shadow: true } : {}) });
      if (pass || rule.shadow || rule.effect === "advise") continue;
      const effect = rule.effect as WorkMoveVerdict;
      if (VERDICT_RANK[effect] > VERDICT_RANK[verdict]) verdict = effect;
    }
  };
  apply(machine.stations.get(from)!.next.get(input.to) ?? [], "transition");
  apply(target.rules ?? [], "station");
  const judges = (target.judges ?? []).map((j) => j.id);
  return {
    ...base,
    verdict,
    toState: target.state,
    reasons,
    judges,
    review: verdict === "allow" && judges.length ? "pending" : "not_needed",
  };
}

// ---------------------------------------------------------------------------
// The shipped example. One example among many; not the product.

export const DEFAULT_WORK_LIFECYCLE: WorkLifecycle = {
  schema: WORK_LIFECYCLE_SCHEMA,
  id: "scout.default",
  name: "Default",
  version: 1,
  description: "An example lifecycle. Agents move their own work; review is a station with rules, not an approval.",
  stations: [
    { id: "backlog", name: "Backlog", state: "open", purpose: "Captured, not yet planned." },
    { id: "ready", name: "Ready", state: "open", primary: true, purpose: "Planned and ready to start." },
    {
      id: "doing", name: "Doing", state: "working", purpose: "Someone is working on it.",
      rules: [{ id: "doing-by-owner", check: { kind: "mover_is_owner" }, effect: "hold", message: "Only the owner starts it. Claim it first." }],
    },
    {
      id: "waiting", name: "Waiting", state: "waiting", purpose: "Blocked on something named.",
      rules: [{ id: "waiting-names-blocker", check: { kind: "has_waiting_on" }, effect: "deny", message: "Say what it is waiting on." }],
    },
    { id: "review", name: "In review", state: "review", purpose: "Done by the owner; another agent checks it." },
    {
      id: "done", name: "Done", state: "done", purpose: "Delivered.",
      rules: [{ id: "done-children-settled", check: { kind: "children_settled" }, effect: "hold", message: "Settle the sub-items first." }],
      judges: [{ id: "definition-of-done", criterion: "The change is merged or delivered, the question of whoever asked is answered, and any follow-up that was promised exists as its own item." }],
    },
    {
      id: "dropped", name: "Dropped", state: "cancelled", purpose: "Not doing it.",
      rules: [{ id: "dropped-has-reason", check: { kind: "has_note" }, effect: "deny", message: "Say why it is dropped." }],
    },
  ],
  transitions: [
    { from: "backlog", to: "ready" },
    { from: "ready", to: "backlog" },
    { from: "backlog", to: "doing" },
    { from: "ready", to: "doing" },
    { from: "doing", to: "ready" },
    { from: "doing", to: "waiting" },
    { from: "waiting", to: "doing" },
    { from: "doing", to: "review" },
    { from: "review", to: "doing", name: "Send back" },
    { from: "review", to: "done" },
    { from: "doing", to: "done" },
    { from: "done", to: "doing", name: "Reopen" },
    { from: "*", to: "dropped" },
    { from: "dropped", to: "backlog", name: "Restore" },
  ],
};
