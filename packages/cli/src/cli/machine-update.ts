/**
 * Named-machine update planning (`scout update Air Mini`).
 *
 * Everything here is pure: resolution, version comparison, and the decision for
 * one machine. The command file owns the I/O — the machine inventory, ssh, and
 * the local installer — so the rules that decide whether a box gets touched can
 * be tested without a network or a second Mac.
 *
 * This planner deliberately stops short of mutating a remote machine. See
 * `REMOTE_EXECUTION_GAP` and docs/eng/named-machine-update.md for why.
 */

import {
  machineLabel,
  machinePresence,
  type MachinePresence,
  type MachineRecord,
} from "@openscout/protocol";
import { classifyScoutBridgeCommand, type ScoutBridgeKind } from "@openscout/runtime/routing";

/* ── Version comparison ── */

/**
 * Strict release semver: `1.2.3`, optionally `-rc.1` and `+build`.
 *
 * Deliberately narrow. A runtime reporting `dev`, `main`, or a bare commit has
 * no orderable version, and guessing one is how a dev checkout gets "upgraded"
 * to an older release. Anything that is not a release triple parses to null and
 * the machine is reported unreadable instead.
 */
const RELEASE_VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export type ParsedReleaseVersion = {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, or null for a final release. */
  prerelease: string[] | null;
};

export function parseReleaseVersion(value: string | null | undefined): ParsedReleaseVersion | null {
  const trimmed = (value ?? "").trim().replace(/^v/i, "");
  const match = RELEASE_VERSION_PATTERN.exec(trimmed);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : null;
  // "1.2.3-" and "1.2.3-rc..1" are malformed, not prereleases.
  if (prerelease?.some((identifier) => identifier.length === 0)) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrereleaseIdentifiers(left: string[], right: string[]): -1 | 0 | 1 {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    // A shorter identifier list has lower precedence: rc.1 < rc.1.1.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const x = Number(a);
      const y = Number(b);
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    // Numeric identifiers always rank below alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Order two release versions, or null when either side is not a release
 * version. Null is never treated as "older" — a version we could not read must
 * not look like a machine that needs an update.
 */
export function compareReleaseVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): -1 | 0 | 1 | null {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return null;

  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // A prerelease ranks below the release it leads to: 0.2.101-rc.1 < 0.2.101.
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
}

/* ── Resolving names to machines ── */

export type MachineResolution =
  | { kind: "resolved"; reference: string; machine: MachineRecord }
  | { kind: "unknown"; reference: string; candidates: string[] }
  | { kind: "ambiguous"; reference: string; candidates: string[] };

function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\.local\.?$/, "");
}

function machineNameKeys(machine: MachineRecord): string[] {
  return [machine.displayName ?? "", machine.name, ...machine.hostNames]
    .map(normalizeNameKey)
    .filter((value) => value.length > 0);
}

/**
 * Exact names only.
 *
 * This selects targets for a mutation, so a prefix or fuzzy match is not an
 * acceptable guess: "Air" quietly matching "Airborne" would restart the wrong
 * machine. An unrecognized name fails closed with the candidate list.
 */
function matchExact(reference: string, machines: readonly MachineRecord[]): MachineRecord[] {
  const needle = normalizeNameKey(reference);
  if (!needle) return [];
  return machines.filter((machine) => machineNameKeys(machine).includes(needle));
}

/**
 * Turn positional arguments into machines, one argument per machine.
 *
 * argv boundaries are the operator's own grouping and are honoured literally:
 * `scout update Air Mini` is two machines, `scout update "Air Mini"` is one.
 * The shell already answered this question, so the planner does not re-guess it
 * by joining arguments back together.
 */
export function resolveMachineReferences(
  args: readonly string[],
  machines: readonly MachineRecord[],
): MachineResolution[] {
  const references = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  const allLabels = machines.map((machine) => machineLabel(machine)).sort();

  const seen = new Set<string>();
  const resolutions: MachineResolution[] = [];
  for (const reference of references) {
    const matches = matchExact(reference, machines);
    if (matches.length === 1) {
      const machine = matches[0]!;
      // The same box named two ways is still one box, and updating it twice is
      // not a second update — it is a second restart.
      if (seen.has(machine.id)) continue;
      seen.add(machine.id);
      resolutions.push({ kind: "resolved", reference, machine });
      continue;
    }
    if (matches.length > 1) {
      resolutions.push({
        kind: "ambiguous",
        reference,
        candidates: matches.map((machine) => machineLabel(machine)).sort(),
      });
      continue;
    }
    resolutions.push({ kind: "unknown", reference, candidates: allLabels });
  }
  return resolutions;
}

/* ── Reading a machine ── */

/**
 * What a probe of one machine found. `null` means "could not read", never
 * "absent" — the difference decides whether we are allowed to act.
 */
export type MachineUpdateReading = {
  appVersion: string | null;
  cliVersion: string | null;
  runtimeVersion: string | null;
  /** scoutd's own verdict. It owns artifact comparison; we do not redo it. */
  runtimeIntentional: boolean | null;
  runtimeState: string | null;
  runtimeCommit: string | null;
  /**
   * Scout processes running outside the managed suite — MCP and channel
   * bridges owned by live harness sessions. Null means "could not be read",
   * which is never treated as zero.
   */
  unmanagedScoutProcesses: UnmanagedScoutProcess[] | null;
  /**
   * The managed suite's own verdict. Null means "could not be read", which is
   * never treated as healthy.
   */
  suite: MachineSuiteStatus | null;
  probeError: string | null;
};

export function emptyReading(probeError: string | null = null): MachineUpdateReading {
  return {
    appVersion: null,
    cliVersion: null,
    runtimeVersion: null,
    runtimeIntentional: null,
    runtimeState: null,
    runtimeCommit: null,
    unmanagedScoutProcesses: null,
    suite: null,
    probeError,
  };
}

/**
 * A Scout bridge is a Scout CLI entry invoked with `mcp` or `channel`.
 *
 * Both halves are load-bearing. Matching any command that mentions an
 * openscout path counts a harness session's log pipe
 * (`sh -c cat >> ".../logs/stdout.log"`), its `tmux new-session`, and its
 * `launch.sh` — on 2026-09-14 that inflated Air to 30 and Mini to 56 against
 * an audited 18 and 25. Requiring the subcommand as the first word after the
 * entry reproduces the audit exactly on both hosts.
 *
 * `scout.ts` belongs in the entry set: Mini runs its bridges from a source
 * checkout as `packages/cli/bin/scout.mjs mcp`.
 * `main.mjs` belongs too: a bundled install launches its bridges as
 * `bun <package>/dist/main.mjs mesh bridge`.
 */
export type { ScoutBridgeKind };

/**
 * Which bridge a command is, or null when it is not one.
 *
 * `mesh bridge` is here for the same reason as the other two — it is a durable
 * Scout process that pins its code at launch — even though the 2026-09-14 fleet
 * ran none, so including it leaves the audited 18 and 25 unchanged. The app and
 * the menu bar item are deliberately absent: the app's version is compared as a
 * component already, and counting it again would double-report it. Matching is
 * anchored on the launch shape (runtime + entrypoint), so a prompt that quotes
 * a bridge command is not one.
 */
export function classifyScoutBridge(command: string): ScoutBridgeKind | null {
  return classifyScoutBridgeCommand(command);
}

/** Harnesses that hold Scout MCP and channel bridges open. */
const CLIENT_MARKERS = new Set(["claude", "codex", "cursor", "grok", "kimi", "opencode", "devin", "pi"]);

/**
 * The suite's own mesh bridge runs under launchd, not a harness session.
 *
 * It is in no `scout app status` layer and neither an install nor `scout app
 * restart` bounces it, so it belongs in the inventory — but telling an operator
 * to restart the harness session holding it is advice that cannot be followed.
 */
const LAUNCHD_PARENT_PID = 1;

export type UnmanagedScoutProcess = {
  pid: number;
  ppid: number | null;
  /** `ps` etime, e.g. `05:41:12`. */
  elapsed: string | null;
  /** Entry path plus subcommand, without flags. */
  command: string;
  /** Which bridge this is. */
  bridge: ScoutBridgeKind;
  /** The harness holding it open, read from the parent process. */
  client: string | null;
  /** The parent's own command, so an unknown client is inspectable without SSH. */
  parentCommand: string | null;
  /** Observed job identity; ps alone cannot prove this, so currently null. */
  launchdLabel: string | null;
};

function clientNameFor(command: string): string | null {
  // Exact match on the executable name. A prefix match attributes `pip`,
  // `ping`, and `pinentry` to `pi`.
  const executable = command.split(/\s+/)[0]?.split("/").pop()?.toLowerCase() ?? "";
  return CLIENT_MARKERS.has(executable) ? executable : null;
}

/**
 * List Scout processes that the managed suite does not own.
 *
 * These are the MCP and channel bridges held open by live harness sessions.
 * They keep running their original JavaScript across an install — on
 * 2026-09-14, Air and Mini had 18 and 25 of them still on pre-update code after
 * app, CLI, and runtime all reached 0.2.101, and a broker restart did not
 * replace them.
 *
 * The pids and owning clients are listed, not just counted: reconnecting one
 * means finding the harness session that holds it, and a bare number does not
 * tell an operator where to go.
 *
 * Input is `ps -axo pid=,ppid=,etime=,args=`; `ownedPids` come from the layers
 * of `scout app status --json`.
 */
export function listUnmanagedScoutProcesses(
  psOutput: string,
  ownedPids: ReadonlySet<number>,
): UnmanagedScoutProcess[] {
  const rows: { pid: number; ppid: number; elapsed: string; command: string }[] = [];
  const byPid = new Map<number, string>();

  for (const line of psOutput.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const args = parts.slice(3).join(" ");
    // Cut at the first flag: the entry and its subcommand are all the
    // classifier needs, and a harness's flags routinely carry unrelated paths.
    const command = args.split(" --")[0]!;
    byPid.set(pid, command);
    rows.push({ pid, ppid, elapsed: parts[2]!, command });
  }

  const unmanaged: UnmanagedScoutProcess[] = [];
  for (const row of rows) {
    if (ownedPids.has(row.pid)) continue;
    const bridge = classifyScoutBridge(row.command);
    if (!bridge) continue;
    const parent = byPid.get(row.ppid) ?? null;
    // PID 1 may be a launchd job or an orphan; it cannot prove a job label.
    const launchd = bridge === "mesh" && row.ppid === LAUNCHD_PARENT_PID;
    unmanaged.push({
      pid: row.pid,
      ppid: row.ppid,
      elapsed: row.elapsed,
      command: row.command,
      bridge,
      client: launchd ? "launchd" : parent ? clientNameFor(parent) : null,
      parentCommand: parent,
      launchdLabel: null,
    });
  }
  return unmanaged;
}

/** Group bridges by the harness holding them, for a readable next step. */
export function summarizeBridgeClients(processes: readonly UnmanagedScoutProcess[]): string {
  const byClient = new Map<string, number[]>();
  for (const process of processes) {
    const key = process.client ?? "unknown";
    byClient.set(key, [...(byClient.get(key) ?? []), process.pid]);
  }
  return [...byClient.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([client, pids]) => `${client} (${pids.length}: ${pids.slice(0, 6).join(", ")}${pids.length > 6 ? "…" : ""})`)
    .join("; ");
}

/**
 * The managed suite's own account of itself.
 *
 * `layers.pids` alone says which processes the suite owns; it does not say
 * whether every service is actually up, or whether one of them is a Scout
 * binary from somewhere other than the installed bundle. A machine whose app
 * and menu layers are empty while a source build holds those roles has three
 * current component versions and a suite that is not running the versions we
 * just compared, so it cannot be reported as settled.
 */
export type MachineSuiteStatus = {
  running: boolean;
  /** Layers the suite declares but has no process for. */
  missingLayers: string[];
  /** Scout processes holding a suite role that the installed bundle does not own. */
  foreign: { layer: string; pid: number | null; executable: string | null }[];
  /** The suite's own problem strings, verbatim. */
  problems: string[];
  /** A short, readable list of everything wrong, for the report. */
  issues: string[];
  state: "healthy" | "service-problems";
};

/** Read the suite's verdict out of a `scout app status --json` payload. */
export function readSuiteStatus(payload: unknown): MachineSuiteStatus | null {
  if (!isRecord(payload) || !Array.isArray(payload.layers)) return null;

  const missingLayers: string[] = [];
  for (const layer of payload.layers) {
    if (!isRecord(layer) || typeof layer.layer !== "string") continue;
    const pids = Array.isArray(layer.pids) ? layer.pids : [];
    if (pids.length === 0) missingLayers.push(layer.layer);
  }

  const foreign: MachineSuiteStatus["foreign"] = [];
  for (const entry of Array.isArray(payload.foreign) ? payload.foreign : []) {
    if (!isRecord(entry)) continue;
    foreign.push({
      layer: typeof entry.layer === "string" ? entry.layer : "unknown",
      pid: typeof entry.pid === "number" && Number.isFinite(entry.pid) ? entry.pid : null,
      executable: typeof entry.executable === "string" ? entry.executable : null,
    });
  }

  const problems = (Array.isArray(payload.problems) ? payload.problems : [])
    .filter((problem): problem is string => typeof problem === "string");

  const running = payload.running === true;
  const issues: string[] = [];
  if (!running) issues.push("the suite is not running");
  for (const problem of problems) issues.push(problem);
  // Name the owner: "foreign" is only actionable if you can see what took the role.
  for (const entry of foreign) {
    issues.push(`${entry.layer} is held by a foreign build${entry.pid === null ? "" : ` (pid ${entry.pid})`}`
      + `${entry.executable === null ? "" : `: ${entry.executable}`}`);
  }
  // A missing layer the suite did not already complain about in `problems`.
  for (const layer of missingLayers) {
    if (problems.some((problem) => problem.includes(layer))) continue;
    issues.push(`no ${layer} process is running`);
  }

  return {
    running,
    missingLayers,
    foreign,
    problems,
    issues,
    state: issues.length > 0 ? "service-problems" : "healthy",
  };
}

/** Pull the managed suite's pids out of a `scout app status --json` payload. */
export function readOwnedSuitePids(payload: unknown): Set<number> {
  const pids = new Set<number>();
  if (!isRecord(payload) || !Array.isArray(payload.layers)) return pids;
  for (const layer of payload.layers) {
    if (!isRecord(layer) || !Array.isArray(layer.pids)) continue;
    for (const pid of layer.pids) {
      if (typeof pid === "number" && Number.isFinite(pid)) pids.add(pid);
    }
  }
  return pids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Pull the observed runtime identity out of a `scoutd status --json` payload.
 *
 * The runtime version is `runtimeFreshness.version`, falling back to
 * `scoutdState.runtimeBuild.version`. Neither `health.build` nor a discovery
 * card's `version` is used: an installed artifact can still advertise `dev` on
 * its card, so reading the card would report the wrong version for a machine
 * that is in fact on a release.
 */
export function readRuntimeIdentityFromScoutdStatus(payload: unknown): {
  runtimeVersion: string | null;
  runtimeIntentional: boolean | null;
  runtimeState: string | null;
  runtimeCommit: string | null;
} {
  const outer = isRecord(payload) ? payload : null;
  // scoutd emits this shape from `status --json` and nested under `status` in
  // the doctor report; accept both, the same way the freshness extractor does.
  const record = outer && isRecord(outer.status) ? outer.status : outer;
  const freshness = record && isRecord(record.runtimeFreshness) ? record.runtimeFreshness : null;
  const state = record && isRecord(record.scoutdState) ? record.scoutdState : null;
  const runtimeBuild = state && isRecord(state.runtimeBuild) ? state.runtimeBuild : null;

  return {
    runtimeVersion: readString(freshness?.version) ?? readString(runtimeBuild?.version),
    runtimeIntentional: typeof freshness?.intentional === "boolean" ? freshness.intentional : null,
    runtimeState: readString(freshness?.state),
    runtimeCommit: readString(freshness?.artifactCommit) ?? readString(runtimeBuild?.commit),
  };
}

/**
 * Find the runtime identity inside a `scout doctor --json` stream.
 *
 * The stream is NDJSON, and scoutd's status is nested several levels down
 * (`report.nativeDaemon.raw.status`, among others) at a path that is an
 * implementation detail of the doctor report. Searching for the shape instead
 * of the path keeps this from breaking when the report is reorganized.
 *
 * Only a `runtimeFreshness` carrying a version counts: the doctor also emits a
 * trimmed copy with the decision fields but no version, and reading that one
 * would report the runtime as unreadable on a perfectly healthy machine.
 */
export function readRuntimeIdentityFromDoctorStream(stdout: string): {
  runtimeVersion: string | null;
  runtimeIntentional: boolean | null;
  runtimeState: string | null;
  runtimeCommit: string | null;
} {
  function search(value: unknown, depth = 0): Record<string, unknown> | null {
    if (depth > 12 || !isRecord(value)) return null;
    const freshness = value.runtimeFreshness;
    if (isRecord(freshness) && readString(freshness.version)) return value;
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          const found = search(item, depth + 1);
          if (found) return found;
        }
        continue;
      }
      const found = search(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const host = search(parsed);
    if (host) return readRuntimeIdentityFromScoutdStatus(host);
  }
  return { runtimeVersion: null, runtimeIntentional: null, runtimeState: null, runtimeCommit: null };
}

/**
 * The Scout node ids a machine has been observed under.
 *
 * The remote helper verifies the node it landed on against these before it
 * installs anything, so an ssh alias that resolves somewhere unexpected cannot
 * quietly update the wrong machine.
 */
export function scoutNodeIdsFor(machine: Pick<MachineRecord, "evidence" | "scoutNodeId">): string[] {
  const ids = new Set<string>();
  if (machine.scoutNodeId) ids.add(machine.scoutNodeId);
  for (const item of machine.evidence ?? []) {
    if (item.kind === "scout" && typeof item.nodeId === "string" && item.nodeId.length > 0) {
      ids.add(item.nodeId);
    }
  }
  return [...ids];
}

/* ── Per-machine planning ── */

export type MachineUpdateState =
  | "offline"
  | "unreadable"
  | "source-owned"
  | "up-to-date"
  | "suite-problems"
  | "bridges-pending"
  | "convergence-unverified"
  | "update-available"
  | "downgrade-blocked";

/** How far this process can actually carry the machine. */
export type MachineUpdateExecution =
  /** Nothing to do, or nothing we are permitted to do. */
  | "none"
  /** We can run the real installer here and re-read the result. */
  | "local-install"
  /**
   * A signed candidate can be installed remotely through the update helper.
   * Native app only — the CLI and runtime stay pending afterwards.
   */
  | "remote-candidate-install"
  /** An update is genuinely due, but this process can only report it. */
  | "planner-only";

export type MachineComponent = "app" | "cli" | "runtime";
export type MachineComponentStatus = "current" | "behind" | "ahead" | "unreadable";

export type MachineComponentReport = {
  name: MachineComponent;
  version: string | null;
  status: MachineComponentStatus;
};

export type MachineUpdatePlan = {
  machineId: string;
  label: string;
  isSelf: boolean;
  presence: MachinePresence;
  state: MachineUpdateState;
  execution: MachineUpdateExecution;
  components: MachineComponentReport[];
  reading: MachineUpdateReading;
  targetVersion: string | null;
  reason: string;
};

/**
 * The one thing a remote named update cannot do today.
 *
 * Idleness is *not* the gap: `readScoutBrokerSnapshot` already reports active
 * flights, so "does this node have work in flight" is answerable. What is
 * missing is an authenticated remote install that returns a verified
 * post-install state. SSH can dispatch a command, but a dispatch is not a
 * result, and this command must not report a convergence it never observed.
 */
export const REMOTE_EXECUTION_GAP =
  "Remote execution has no verified post-install state: ssh can dispatch an install, but a "
  + "dispatch is not a result, and app, CLI, and runtime converge separately. Node idleness is "
  + "already readable from the broker snapshot; the receipt is what is missing.";

function componentStatus(version: string | null, target: string | null): MachineComponentStatus {
  const order = compareReleaseVersions(version, target);
  if (order === null) return "unreadable";
  if (order === 0) return "current";
  return order < 0 ? "behind" : "ahead";
}

function describeComponents(components: readonly MachineComponentReport[], status: MachineComponentStatus): string {
  return components
    .filter((component) => component.status === status)
    .map((component) => `${component.name} ${component.version ?? "unreadable"}`)
    .join(", ");
}

export function planMachineUpdate(input: {
  machine: MachineRecord;
  reading: MachineUpdateReading;
  targetVersion: string | null;
  /** A signed candidate is available to install remotely through the helper. */
  remoteCandidate?: boolean;
  now?: number;
}): MachineUpdatePlan {
  const { machine, reading, targetVersion } = input;

  // App, CLI, and runtime are three separately installed things that converge
  // on one release. Comparing only the app would call a machine current while
  // its CLI still points at an older package — exactly the Mini case, where
  // app 0.2.100 ran against a CLI symlinked to 0.2.98.
  const components: MachineComponentReport[] = [
    { name: "app", version: reading.appVersion, status: componentStatus(reading.appVersion, targetVersion) },
    { name: "cli", version: reading.cliVersion, status: componentStatus(reading.cliVersion, targetVersion) },
    {
      name: "runtime",
      version: reading.runtimeVersion,
      status: componentStatus(reading.runtimeVersion, targetVersion),
    },
  ];

  const base = {
    machineId: machine.id,
    label: machineLabel(machine),
    isSelf: machine.isSelf,
    presence: machinePresence(machine, input.now ?? Date.now()),
    components,
    reading,
    targetVersion,
  };

  if (base.presence === "offline" && !machine.isSelf) {
    return {
      ...base,
      state: "offline",
      execution: "none",
      reason: "Offline — nothing has seen it recently, so its versions cannot be read.",
    };
  }

  // scoutd's verdict comes first. Moving a deliberately source-owned runtime
  // onto a published artifact is an ownership transition, and the operator
  // should make it explicitly rather than have a fleet command decide.
  if (reading.runtimeIntentional === true) {
    return {
      ...base,
      state: "source-owned",
      execution: "none",
      reason:
        `Runtime is intentionally source-owned (${reading.runtimeState ?? "pinned"}) — held. `
        + "Changing its ownership is an explicit operator decision, not this command's.",
    };
  }

  if (reading.probeError) {
    return {
      ...base,
      state: "unreadable",
      execution: "none",
      reason: `Versions could not be read: ${reading.probeError}`,
    };
  }

  const ahead = describeComponents(components, "ahead");
  if (ahead) {
    return {
      ...base,
      state: "downgrade-blocked",
      execution: "none",
      reason: `Newer than ${targetVersion} (${ahead}) — refusing to downgrade.`,
    };
  }

  if (!parseReleaseVersion(targetVersion)) {
    // Blame the target, not the machine. Every component would read as
    // unreadable here, which would wrongly look like three broken installs.
    return {
      ...base,
      state: "unreadable",
      execution: "none",
      reason: `No readable target release version (${targetVersion ?? "unknown"}) to compare against.`,
    };
  }

  const unreadable = describeComponents(components, "unreadable");
  if (unreadable) {
    // Not "up to date" and not "behind" — unknown. Saying either would be a
    // claim about a version nobody could read.
    return {
      ...base,
      state: "unreadable",
      execution: "none",
      reason: `Not a readable release version: ${unreadable}.`,
    };
  }

  const behind = describeComponents(components, "behind");
  if (!behind) {
    const suite = reading.suite;
    // A missing service, or one held by a build the installed bundle does not
    // own, means the versions we just compared are not what the suite is
    // actually running. That is not "current" at whole-suite scope.
    if (suite && suite.state === "service-problems") {
      return {
        ...base,
        state: "suite-problems",
        execution: "none",
        reason:
          `app, CLI, and runtime are on ${targetVersion}, but the managed suite reports `
          + `${suite.issues.length} problem${suite.issues.length === 1 ? "" : "s"}: `
          + `${suite.issues.join("; ")}.`,
      };
    }

    const bridges = reading.unmanagedScoutProcesses;
    if (suite === null || bridges === null) {
      // Defaulting either read to "fine" would turn a failed read into a
      // convergence claim, which is the one thing it cannot support.
      const missing = [
        suite === null ? "the managed suite's status" : null,
        bridges === null ? "the bridge audit" : null,
      ].filter((item): item is string => item !== null);
      return {
        ...base,
        state: "convergence-unverified",
        execution: "none",
        reason:
          `app, CLI, and runtime are on ${targetVersion}, but ${missing.join(" and ")} could not be `
          + "read, so whether the whole suite runs that version is unknown.",
      };
    }
    if (bridges.length > 0) {
      // Version equality does not identify code already loaded by a bridge.
      return {
        ...base,
        state: "bridges-pending",
        execution: "none",
        reason:
          `app, CLI, and runtime are on ${targetVersion}, but ${bridges.length} Scout process`
          + `${bridges.length === 1 ? "" : "es"} outside the managed suite have unverified release `
          + `identities: ${summarizeBridgeClients(bridges)}. Reconnecting one needs the harness session `
          + "that holds it.",
      };
    }
    return {
      ...base,
      state: "up-to-date",
      execution: "none",
      reason: `app, CLI, and runtime are all on ${targetVersion}.`,
    };
  }

  if (machine.isSelf) {
    return {
      ...base,
      state: "update-available",
      execution: "local-install",
      reason: `Behind ${targetVersion}: ${behind}.`,
    };
  }

  // A signed candidate can go out through the helper, which verifies the node
  // identity and an idle broker before it installs. It installs the native app
  // and nothing else, so the CLI and runtime stay pending either way.
  if (input.remoteCandidate && scoutNodeIdsFor(machine).length > 0) {
    return {
      ...base,
      state: "update-available",
      execution: "remote-candidate-install",
      reason:
        `Behind ${targetVersion}: ${behind}. The helper installs the native app only; `
        + "CLI and runtime remain pending afterwards.",
    };
  }

  return {
    ...base,
    state: "update-available",
    execution: "planner-only",
    reason: input.remoteCandidate
      ? `Behind ${targetVersion}: ${behind}. No Scout node identity to verify remotely, so the `
        + "helper cannot confirm which machine it landed on."
      : `Behind ${targetVersion}: ${behind}. This command cannot execute it. ${REMOTE_EXECUTION_GAP}`,
  };
}

/**
 * The status for a whole run.
 *
 * `planned` and `partial` exist so a run that did not converge a machine can
 * never be printed or scripted as a completed update. The settled statuses are
 * `components-*` for the same reason — see `VERIFIED_COMPONENTS`.
 */
export type MachineUpdateRunStatus =
  | "components-updated"
  | "components-current"
  | "suite-problems"
  | "bridges-pending"
  | "convergence-unverified"
  | "held"
  | "planned"
  | "partial"
  | "blocked";

/**
 * What a run actually compares — and what it does not.
 *
 * A machine can carry app, CLI, and runtime on the target while its MCP and
 * channel bridges are still pre-update processes: after Air and Mini reached
 * 0.2.101 on all three, 18 and 25 bridges respectively were still running the
 * old checkout, and a broker restart did not replace them. So the settled
 * statuses are named `components-*` rather than `current`/`updated` — the word
 * carries the scope of the claim, and no run of this command means "the fleet
 * is converged".
 */
export const VERIFIED_COMPONENTS = [
  "app",
  "cli",
  "runtime",
  "managed-suite-services",
  "unmanaged-bridge-inventory",
] as const;
/**
 * A bridge's own release identity. The inventory names which processes the
 * suite does not own, with their pids and owning harnesses; nothing reads which
 * build each one is actually running, so an empty inventory is not proof that
 * every Scout process is on the target.
 */
export const UNVERIFIED_COMPONENTS = ["bridge-release-identity"] as const;

/**
 * The only two statuses that exit 0.
 *
 * `components-current` means every component of every named machine is on the
 * target with a healthy suite and no bridge with an unverified release identity. `held` means the
 * only thing left is a source-owned runtime the operator deliberately kept.
 * Everything else — work due, work unfinished, or a reading that failed — is a
 * nonzero exit.
 */
export function isSettledStatus(status: MachineUpdateRunStatus): boolean {
  return status === "components-current" || status === "held";
}

export function summarizeMachineUpdateRun(
  plans: readonly MachineUpdatePlan[],
  options: { check: boolean; installed?: readonly string[] },
): { status: MachineUpdateRunStatus; exitCode: number; summary: string } {
  const installed = options.installed ?? [];
  const blocked = plans.filter(
    (plan) => plan.state === "offline" || plan.state === "unreadable" || plan.state === "downgrade-blocked",
  );
  const pending = plans.filter((plan) => plan.state === "update-available");
  const plannerOnly = pending.filter((plan) => plan.execution === "planner-only");
  const summary = describe(plans, pending.length, blocked.length);

  // A held machine is not a failure, but calling the run `current` would claim
  // it sits on the target when it may be many releases behind on purpose.
  const held = plans.some((plan) => plan.state === "source-owned");
  // Bridges outrank `held` and `components-current`: they are outstanding work,
  // and a run with any of them must not read as settled.
  // A broken suite outranks stale bridges: a missing or foreign-owned service
  // means the compared versions are not what the machine is running at all.
  const suiteProblems = plans.some((plan) => plan.state === "suite-problems");
  const bridges = plans.some((plan) => plan.state === "bridges-pending");
  // An unread status ranks below known work and above `held`: it is not proven
  // work, but it is also not permission to call the run settled.
  const unverified = plans.some((plan) => plan.state === "convergence-unverified");
  const settled: MachineUpdateRunStatus = suiteProblems
    ? "suite-problems"
    : bridges
      ? "bridges-pending"
      : unverified
        ? "convergence-unverified"
        : held
          ? "held"
          : "components-current";

  if (options.check) {
    const status: MachineUpdateRunStatus = blocked.length > 0
      ? "blocked"
      : pending.length > 0
        ? "planned"
        : settled;
    // One rule, in both modes: exit 0 means every named machine is settled.
    // Scripts gate on the exit code, and a check that exits 0 while 42 bridges
    // have unverified release identities is the same false complete, moved from the status word to
    // the exit code.
    return { status, exitCode: isSettledStatus(status) ? 0 : 1, summary };
  }

  // Installing is not converging. A machine we installed on that still reports
  // a behind or unreadable component is `partial`, and the run fails.
  if (installed.length > 0) {
    const unconverged = plans.filter(
      (plan) => installed.includes(plan.label) && plan.state !== "up-to-date",
    );
    if (unconverged.length > 0) {
      return { status: "partial", exitCode: 1, summary };
    }
  }

  if (blocked.length > 0) return { status: "blocked", exitCode: 1, summary };
  // An update was requested and not performed. Say so, and fail.
  if (plannerOnly.length > 0) return { status: "planned", exitCode: 1, summary };
  // An install that converged the components but left bridges behind is not a
  // completed update; it fails like any other unfinished run.
  if (suiteProblems) return { status: "suite-problems", exitCode: 1, summary };
  if (bridges) return { status: "bridges-pending", exitCode: 1, summary };
  if (unverified) return { status: "convergence-unverified", exitCode: 1, summary };
  if (installed.length > 0) return { status: "components-updated", exitCode: 0, summary };
  if (pending.length > 0) return { status: "planned", exitCode: 1, summary };
  return { status: settled, exitCode: 0, summary };
}

function describe(plans: readonly MachineUpdatePlan[], pending: number, blocked: number): string {
  const held = plans.filter((plan) => plan.state === "source-owned").length;
  const parts = [`${plans.length} machine${plans.length === 1 ? "" : "s"}`];
  if (pending > 0) parts.push(`${pending} needing an update`);
  const bridges = plans.reduce(
    (total, plan) => total + (plan.reading.unmanagedScoutProcesses?.length ?? 0),
    0,
  );
  if (bridges > 0) parts.push(`${bridges} unmanaged Scout process${bridges === 1 ? "" : "es"}`);
  const suiteProblems = plans.filter((plan) => plan.state === "suite-problems").length;
  if (suiteProblems > 0) parts.push(`${suiteProblems} with suite service problems`);
  const unverified = plans.filter((plan) => plan.state === "convergence-unverified").length;
  if (unverified > 0) parts.push(`${unverified} whose convergence could not be verified`);
  if (held > 0) parts.push(`${held} source-owned and held`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(", ");
}
