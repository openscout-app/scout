import type { ScoutId } from "./common.js";

/*
 * The agent roster: a short code that names an agent everywhere. Each agent
 * the runtime lists holds a three-digit roster number (001–999), one roster
 * across projects, so the number alone names the agent. Each project holds a
 * code of two or three capitals, so an agent reads as `OS-003` (drawn as
 * "OS 003").
 *
 * The runtime is the only writer. It keys a number by the agent's Scout
 * agent id, never its handle: two agents that share a handle such as
 * `claude` hold two numbers.
 */

export const ROSTER_NUMBER_MIN = 1;
export const ROSTER_NUMBER_MAX = 999;

/** How a roster number was given: by the runtime on first sight, or by an import of the apps' local roster. */
export type AgentRosterNumberSource = "auto" | "import";

/** How a project code was given: the default from its name, the operator's choice, or an import. */
export type RosterProjectCodeSource = "default" | "operator" | "import";

/** One agent's place on the roster. */
export interface AgentRosterEntry {
  agentId: ScoutId;
  /** The roster number, 1–999. */
  number: number;
  /** The number as three digits: `"003"`. */
  numberText: string;
  /** The key of the agent's project (`projectKey`), or null for an agent with no project. */
  projectKey: string | null;
  /** The agent's project name, as the agent record carries it. */
  project: string | null;
  /** The project's code, or null when the agent has no project or its project has no code. */
  projectCode: string | null;
  /** The address form: `"OS-003"`, or `"003"` for an agent with no project code. */
  code: string;
  /** The display form: `"OS 003"`, or `"003"`. */
  label: string;
  source: AgentRosterNumberSource;
  assignedAt: number;
  /** Set while the agent is deleted or retired; the number is freed once the grace period passes. */
  goneAt?: number;
}

/** A project's code record. */
export interface RosterProjectRecord {
  /** The project's name, trimmed and in lower case. */
  projectKey: string;
  /** The project's name as the runtime first saw it. */
  name: string;
  /** Two or three capitals, or null when every candidate is held by another project. */
  code: string | null;
  codeSource: RosterProjectCodeSource;
  /** The code the project's name gives by default (`identityMonogram`). */
  defaultCode: string;
  createdAt: number;
  updatedAt: number;
}

/** A compact copy of an agent's roster place, for agent records in CLI and MCP output. */
export interface AgentRosterTag {
  number: number;
  numberText: string;
  projectCode: string | null;
  code: string;
  label: string;
}

export interface AgentRosterListResult {
  agents: AgentRosterEntry[];
  projects: RosterProjectRecord[];
  capacity: { max: number; held: number };
}

export interface RosterProjectCodeSetRequest {
  /** The project's name or key. */
  project: string;
  /** Two or three capitals; null gives the project back its default code. */
  code: string | null;
}

/** One agent's number and project code, as an app handed them out locally. */
export interface AgentRosterImportEntry {
  agentId: ScoutId;
  /** The roster number: 3, or "003". */
  number: number | string;
  /** The code the app showed for the agent's project; null or absent for none. */
  projectCode?: string | null;
}

export interface AgentRosterImportRequest {
  entries: AgentRosterImportEntry[];
  /** Report what the import would do without writing anything. */
  dryRun?: boolean;
}

export type AgentRosterImportConflictReason =
  | "invalid_entry"
  | "duplicate_agent"
  | "duplicate_number"
  | "unknown_agent"
  | "agent_not_listed"
  | "number_held"
  | "agent_already_imported"
  | "invalid_project_code"
  | "no_project"
  | "project_code_held"
  | "project_code_differs";

export interface AgentRosterImportConflict {
  agentId: string;
  number?: number;
  projectCode?: string | null;
  reason: AgentRosterImportConflictReason;
  detail: string;
  /** The agent or project that holds what the entry asked for. */
  heldBy?: string;
}

export interface AgentRosterImportResult {
  dryRun: boolean;
  /** Entries whose numbers the runtime now holds for them. */
  imported: Array<{ agentId: ScoutId; number: number; code: string }>;
  /** Agents the runtime had numbered itself, moved off a number an entry took. */
  renumbered: Array<{ agentId: ScoutId; from: number; to: number | null }>;
  /** Project codes the import set. */
  projectCodes: Array<{ projectKey: string; code: string }>;
  conflicts: AgentRosterImportConflict[];
}

export type AgentRosterDiagnosticCode =
  | "invalid_roster_address"
  | "unknown_roster_number"
  | "unknown_project_code"
  | "roster_code_mismatch"
  | "roster_agent_gone"
  | "invalid_project_code"
  | "project_code_held"
  | "unknown_project";

export interface AgentRosterResolveResult {
  address: string;
  resolved: boolean;
  entry?: AgentRosterEntry;
  diagnostic?: { code: AgentRosterDiagnosticCode; detail: string };
}

/** A roster address as typed: an optional project code and a three-digit number. */
export interface RosterAddress {
  /** The project code in capitals, or null for a bare number. */
  projectCode: string | null;
  number: number;
}

/** A project's key: its name, trimmed and in lower case. */
export function rosterProjectKey(project: string): string {
  return project.trim().toLowerCase();
}

/** Three digits: 3 → "003". */
export function rosterNumberText(number: number): string {
  return String(number).padStart(3, "0");
}

/** The address form: "OS-003", or "003" without a project code. */
export function rosterCode(projectCode: string | null | undefined, number: number): string {
  return projectCode ? `${projectCode}-${rosterNumberText(number)}` : rosterNumberText(number);
}

/** The display form: "OS 003", or "003" without a project code. */
export function rosterLabel(projectCode: string | null | undefined, number: number): string {
  return projectCode ? `${projectCode} ${rosterNumberText(number)}` : rosterNumberText(number);
}

export function isRosterNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= ROSTER_NUMBER_MIN && value <= ROSTER_NUMBER_MAX;
}

/**
 * A project code as it is kept: two or three capitals or digits with at
 * least one letter; null when the value is not one. Digits are accepted
 * because the apps' code field accepts them and a name such as `3d-tools`
 * defaults to `3T`; the letter keeps a code apart from a roster number.
 */
export function cleanProjectCode(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return /^[A-Z0-9]{2,3}$/u.test(code) && /[A-Z]/u.test(code) ? code : null;
}

/**
 * Candidate letter pairs for a name, most natural first: word initials
 * (fabric-ops → FO), then the first letter with each later consonant, then
 * with each later vowel. Every candidate is spelled from the name. The same
 * rule the apps' project marks use, so a default code never renames.
 */
export function rosterBoardCandidates(name: string): string[] {
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const flat = words.join("");
  const first = flat[0] ?? "?";
  const out: string[] = [];
  if (words.length > 1 && /^[A-Z0-9]/.test(words[1]!)) out.push(first + words[1]![0]);
  const rest = [...flat.slice(1)];
  for (const c of rest) if (!/[AEIOU]/.test(c)) out.push(first + c);
  for (const c of rest) if (/[AEIOU]/.test(c)) out.push(first + c);
  if (!out.length) out.push(first + first);
  return [...new Set(out)];
}

function splitCamelCase(name: string): string {
  return name.trim().replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** The two letters a project's name gives by default ("OS" for openscout). The apps' rule, unchanged. */
export function rosterIdentityMonogram(name: string): string {
  const clean = splitCamelCase(name);
  // OpenScout is commonly stored as the all-lowercase checkout basename.
  return clean.toLowerCase() === "openscout" ? "OS" : rosterBoardCandidates(clean || "Agent")[0]!;
}

/**
 * Every code a project's name can take, in the order the runtime tries them
 * when an earlier one is held by another project: the default, the other
 * letter pairs, then three-letter codes spelled from the name.
 */
export function rosterProjectCodeCandidates(name: string): string[] {
  const clean = splitCamelCase(name) || "Agent";
  const pairs = [rosterIdentityMonogram(name), ...rosterBoardCandidates(clean)];
  const flat = clean.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  const triples: string[] = [];
  const first = flat[0];
  if (first) {
    for (let i = 1; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) triples.push(first + flat[i] + flat[j]);
    }
  }
  const out: string[] = [];
  for (const candidate of [...pairs, ...triples]) {
    const code = cleanProjectCode(candidate);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

const ROSTER_ADDRESS_PATTERN = /^@?(?:([A-Za-z0-9]{2,3})[-\s]?)?(\d{3})$/u;

/**
 * A roster address: `OS-003`, `os003`, `OS 003` or a bare `003`. Null when the
 * text is not in that form (it is then an ordinary agent name).
 */
export function parseRosterAddress(input: string | null | undefined): RosterAddress | null {
  const match = input?.trim().match(ROSTER_ADDRESS_PATTERN);
  if (!match) return null;
  const number = Number.parseInt(match[2]!, 10);
  if (!isRosterNumber(number)) return null;
  if (match[1] === undefined) return { projectCode: null, number };
  const projectCode = cleanProjectCode(match[1]);
  return projectCode ? { projectCode, number } : null;
}

/** The roster number from an import entry: 3 or "003"; null when it is not one. */
export function parseRosterNumber(value: number | string | null | undefined): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,3}$/u.test(value.trim())
    ? Number.parseInt(value.trim(), 10)
    : Number.NaN;
  return isRosterNumber(number) ? number : null;
}

export function agentRosterTag(entry: Pick<AgentRosterEntry, "number" | "projectCode">): AgentRosterTag {
  return {
    number: entry.number,
    numberText: rosterNumberText(entry.number),
    projectCode: entry.projectCode,
    code: rosterCode(entry.projectCode, entry.number),
    label: rosterLabel(entry.projectCode, entry.number),
  };
}
