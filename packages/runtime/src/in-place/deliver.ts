import { callLattices, submitLatticesComposer, type LatticesCall } from "./lattices-composer.js";
// A reply to a session that is open somewhere goes INTO that session, where it
// runs — never to a background copy or a fork. The operator started it in a
// place; the words belong in that place.
//
// Finding the place:
//   - Herdr's own report. With its agent integration installed, Herdr names
//     the harness session each pane holds, so a session id finds its pane.
//   - The harness process. Claude Code records which process holds a session;
//     Codex locks the thread file. That process's environment names the pane
//     its terminal host spawned it in (HERDR_PANE_ID, ORCA_TERMINAL_HANDLE,
//     TMUX_PANE) — the same answer, with no integration needed.
//
// Getting in, in the order of `IN_PLACE_HOSTS` (OPENSCOUT_IN_PLACE_ORDER
// overrides it):
//   herdr    — `herdr agent prompt`, which submits through Herdr's agent surface.
//   orca     — `orca terminal send --enter`, Orca's own terminal input.
//   tmux     — a bracketed paste and Enter, the dispatch Scout uses for its panes.
//   terminal — a Claude session in a plain terminal tab, typed into by its tty
//              through Lattices' computer-use surface.
// A Codex thread held by the ChatGPT app's Codex (its app-server is stdio-only,
// so no process can join it) gets the words through the app's own thread link
// (`codex://threads/<id>?prompt=`). Scout.app's combined focus + Return has no
// activity guard at the actuator, so that submission path is refused. When
// Scout.app is unavailable, Lattices can focus an unambiguous text composer,
// recheck activity, and press Return; the thread's transcript confirms it.
//
// Hosts are exact, so a session normally matches one. The order decides only
// between two that both hold it — a Herdr pane inside a tmux session.
// When none finds the session live, the caller decides what happens next:
// the phone resumes the exact session, the CLI and MCP say so and stop.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readHerdrSessions, readHerdrTopology } from "../system-probes/herdr.js";
import { execSystemFile } from "../system-probes/exec.js";
import { findLiveClaudeSession, type ClaudeSessionRecord } from "../claude-session-records.js";
import { listScoutLaunchedTmuxSessions, sendTmuxPrompt, tmuxPaneTailUnsentComposerText } from "../local-agents.js";

import { openLineTail, type LineTail } from "./line-tail.js";
import { readOrcaAgents, sendOrcaPrompt, type OrcaAgent } from "./orca.js";
import {
  innermostProcessHost,
  processHostLocations,
  readProcessHostEnv,
  type ProcessHostEnv,
  type ProcessHostLocation,
} from "./process-host.js";
import { askScoutApp, type ScoutAppReply } from "./scout-app-socket.js";

export type InPlaceHost = "herdr" | "orca" | "tmux" | "terminal";
export type InPlaceVia = "herdr" | "orca" | "tmux" | "lattices" | "scout-app";

/** The preferred order when more than one host holds a session. */
export const IN_PLACE_HOSTS: readonly InPlaceHost[] = ["herdr", "orca", "tmux", "terminal"];

export type InPlaceDelivery =
  | { ok: true; via: InPlaceVia; location: string; delivered?: "draft" }
  | { ok: false; code: "busy" | "activity_unknown"; via: InPlaceVia; location: string; detail: string }
  | { ok: false; code: "draft_unsupported"; detail: string }
  /** The session is live but can't take words right now (e.g. a permission prompt is up). */
  | { ok: false; code: "session_blocked"; via: InPlaceVia; location: string }
  /**
   * The session is live in a place Scout found but couldn't type into.
   * `nothingSent` is set only when Scout refused before touching the place;
   * without it the words may have reached the composer.
   */
  | { ok: false; code: "in_place_failed"; via: InPlaceVia; location: string; detail: string; nothingSent?: true }
  /** Live in an app only the Scout app can reach, and the Scout app can't right now. */
  | { ok: false; code: "scout_app_unavailable" | "scout_app_accessibility"; via: InPlaceVia; location: string }
  /** No live place holds this session. */
  | { ok: false; code: "not_live" }
  /** Exact session identity could not be established before any input. */
  | { ok: false; code: "session_runtime_unobserved" | "session_ambiguous" };

export type HerdrPaneMatch = { session: string; paneId: string; status: string | null; harness?: string; sessionKind?: string };

export type DeliverInPlaceDeps = {
  findHerdrPane?: (sessionId: string, harness?: string | null) => Promise<HerdrPaneMatch | null>;
  /** Surface-bound composer read, immediately before input. Missing/failed reads refuse. */
  composerEmpty?: (place: { via: InPlaceVia; location: string }) => Promise<boolean>;
  promptHerdr?: (match: HerdrPaneMatch, body: string) => Promise<void>;
  findClaudeRecord?: (sessionId: string) => Promise<ClaudeSessionRecord | null>;
  /** The tmux sessions Scout launched itself, by the mark it leaves on them. */
  scoutLaunchedTmuxSessions?: () => Promise<Set<string>>;
  /** Pids of processes holding a Codex thread, other than the ChatGPT app. */
  codexThreadPids?: (sessionId: string) => Promise<number[]>;
  /** The pane a process's terminal host spawned it in, if any. */
  locateProcess?: (pid: number) => Promise<ProcessHostLocation | null>;
  /** Panes the caller itself runs in; never typed into. Defaults to this process's environment. */
  self?: ProcessHostLocation[];
  /** The caller's own terminal, never typed into. Defaults to this process's tty. */
  selfTty?: () => Promise<string | null>;
  readOrcaAgents?: () => Promise<OrcaAgent[]>;
  promptOrca?: (terminalHandle: string, body: string) => Promise<void>;
  promptTmux?: (target: string, body: string) => Promise<void>;
  /** Text a person typed into the pane's composer and has not sent, if any. */
  tmuxComposerDraft?: (target: string) => Promise<string | null>;
  ttyForPid?: (pid: number) => Promise<string | null>;
  typeIntoTty?: (tty: string, body: string) => Promise<void>;
  /** Whether the ChatGPT app's Codex holds this thread's writer lock. */
  codexHeldByApp?: (sessionId: string) => Promise<boolean>;
  /** Opens only the exact thread link; never submits. */
  draftCodexApp?: (sessionId: string, body: string) => Promise<void>;
  codexActivity?: (sessionId: string) => Promise<"idle" | "busy" | "unknown">;
  latticesCall?: LatticesCall;
  /** Lattices submission override for tests; never bypasses the Scout.app refusal. */
  typeIntoCodexApp?: (sessionId: string, body: string) => Promise<void>;
  /** The Scout app's socket; injectable for tests. */
  askScoutApp?: (request: { op: string; [field: string]: unknown }) => Promise<ScoutAppReply>;
  /** Preferred host order; defaults to OPENSCOUT_IN_PLACE_ORDER, then IN_PLACE_HOSTS. */
  order?: readonly InPlaceHost[];
};

const HERDR_TIMEOUT_MS = 4_000;

/**
 * The host order, from OPENSCOUT_IN_PLACE_ORDER ("orca,herdr,tmux,terminal")
 * when set. Hosts it leaves out keep their default order after the ones it
 * names, so a partial override never switches a host off.
 */
export function resolveInPlaceOrder(env: NodeJS.ProcessEnv = process.env): InPlaceHost[] {
  const named = (env.OPENSCOUT_IN_PLACE_ORDER ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .map((entry) => (entry === "lattices" ? "terminal" : entry))
    .filter((entry): entry is InPlaceHost => (IN_PLACE_HOSTS as readonly string[]).includes(entry));
  const unique = [...new Set(named)];
  return [...unique, ...IN_PLACE_HOSTS.filter((host) => !unique.includes(host))];
}

/**
 * Scout's own background continuations run in tmux sessions it names
 * `flat-<harness>-<id>`. They are copies, not the place the operator works,
 * so a reply never targets one.
 *
 * Where the process runs is the evidence. The `--name` Scout launches with is
 * not: Claude Code keeps a session's name when it is resumed, so a session
 * Scout once continued still carries that name in the pane where the operator
 * opens it later.
 */
export function isScoutBackgroundCopy(record: ClaudeSessionRecord): boolean {
  return (record.tmux?.session ?? "").startsWith("flat-");
}

/**
 * The Claude process that has a session open for a person, passing over the
 * copies Scout runs itself. Throws when the processes cannot be read: that is
 * not the same as finding none.
 */
export async function findClaudeSessionOutsideScout(
  sessionId: string,
  deps: Pick<DeliverInPlaceDeps, "scoutLaunchedTmuxSessions"> & {
    find?: (sessionId: string, options: { skip: (record: ClaudeSessionRecord) => boolean }) => Promise<ClaudeSessionRecord | null>;
  } = {},
): Promise<ClaudeSessionRecord | null> {
  const launched = await (deps.scoutLaunchedTmuxSessions ?? listScoutLaunchedTmuxSessions)().catch(() => new Set<string>());
  return (deps.find ?? findLiveClaudeSession)(sessionId, {
    skip: (candidate) => isScoutBackgroundCopy(candidate) || Boolean(candidate.tmux && launched.has(candidate.tmux.session)),
  });
}

/** Every place one session is held, gathered before any is tried. */
type Candidates = {
  herdr: HerdrPaneMatch | null;
  orca: { terminalHandle: string; paneKey: string | null } | null;
  tmux: { target: string; location: string } | null;
  /** The Claude process, for typing into a plain terminal tab. */
  terminalPid: number | null;
  /** Claude's own record of the live process, which carries its activity. */
  claude: ClaudeSessionRecord | null;
  /** A harness process other than Scout's own background copy has the session open. */
  held: boolean;
};

type GatheredCandidates =
  | { ok: true; candidates: Candidates }
  | { ok: false; code: "session_runtime_unobserved" | "session_ambiguous" };

/** Find every place that holds the session. Nothing is typed. */
async function gatherInPlaceCandidates(
  input: { sessionId: string; harness: string | null; requireExactHarness?: boolean },
  deps: DeliverInPlaceDeps,
): Promise<GatheredCandidates> {
  const { sessionId, harness } = input;
  const candidates: Candidates = { herdr: null, orca: null, tmux: null, terminalPid: null, claude: null, held: false };

  // Herdr names the session itself when its integration is installed.
  if (input.requireExactHarness && !harness) return { ok: false, code: "session_runtime_unobserved" };
  try {
    candidates.herdr = await (deps.findHerdrPane ?? findHerdrPaneForSession)(sessionId, input.requireExactHarness ? harness : undefined);
  } catch (error) {
    if (input.requireExactHarness) return { ok: false, code: errorText(error).startsWith("session_ambiguous:") ? "session_ambiguous" : "session_runtime_unobserved" };
  }
  if (input.requireExactHarness && candidates.herdr
    && (candidates.herdr.harness !== harness || candidates.herdr.sessionKind !== "id")) {
    return { ok: false, code: "session_runtime_unobserved" };
  }

  // The process holding the session, and the panes its environment names.
  const pids: number[] = [];
  if (!harness || harness === "claude") {
    const launched = await (deps.scoutLaunchedTmuxSessions ?? listScoutLaunchedTmuxSessions)().catch(() => new Set<string>());
    const scoutCopy = (candidate: ClaudeSessionRecord) => isScoutBackgroundCopy(candidate)
      || Boolean(candidate.tmux && launched.has(candidate.tmux.session));
    // Scout's copy and the operator's pane can hold one session at once; the
    // operator's is the one to find.
    let record: ClaudeSessionRecord | null;
    try {
      record = await (deps.findClaudeRecord ?? ((id: string) => findLiveClaudeSession(id, { skip: scoutCopy })))(sessionId);
    } catch {
      // A read that failed (a tmux or ps timeout) does not say the session is
      // closed. A caller that must know says so, and nothing is resumed
      // beside a session that may be running.
      if (input.requireExactHarness) return { ok: false, code: "session_runtime_unobserved" };
      record = null;
    }
    if (record && !scoutCopy(record)) {
      pids.push(record.pid);
      candidates.claude = record;
      // A process whose pane could not be shown to hold it is open, but
      // neither that pane nor its terminal is a place to type.
      if (!record.paneUnverified) candidates.terminalPid = record.pid;
      if (record.tmux && !record.paneUnverified) {
        candidates.tmux = {
          target: record.tmux.pane ?? record.tmux.session,
          location: `tmux ${record.tmux.session}${record.tmux.pane ? ` · ${record.tmux.pane}` : ""}`,
        };
      }
    }
  }
  if (!harness || harness === "codex") {
    pids.push(...await (deps.codexThreadPids ?? codexThreadHolderPids)(sessionId).catch(() => []));
  }
  candidates.held = pids.length > 0;
  for (const pid of pids) {
    const location = await (deps.locateProcess ?? locateProcessHost)(pid).catch(() => null);
    if (location?.host === "herdr" && !candidates.herdr) {
      candidates.herdr = { session: location.session, paneId: location.paneId, status: null };
    } else if (location?.host === "orca" && !candidates.orca) {
      candidates.orca = { terminalHandle: location.terminalHandle, paneKey: location.paneKey };
    }
    // TMUX_PANE is not used: a pane id like %12 is unique only within its
    // tmux server, and sending it to the default socket could type into a
    // stranger's pane. Claude's own record names the server and pane.
  }

  // Whatever the evidence, the caller's own pane is never a target: typing
  // there would hand the sender its own words as a new prompt.
  const self = deps.self ?? processHostLocations(process.env as ProcessHostEnv);
  if (candidates.herdr && self.some((own) => own.host === "herdr"
    && own.session === candidates.herdr?.session && own.paneId === candidates.herdr?.paneId)) {
    candidates.herdr = null;
  }
  if (candidates.orca && self.some((own) => own.host === "orca"
    && own.terminalHandle === candidates.orca?.terminalHandle)) {
    candidates.orca = null;
  }
  return { ok: true, candidates };
}

/**
 * `composing` is a free prompt with a person's unsent text in it: typing there
 * would send their draft along with the words.
 */
export type InPlaceActivity = "idle" | "busy" | "blocked" | "composing" | "unknown";

/** Where a session is open and whether it can take a new turn. Nothing is typed. */
export type InPlaceProbe =
  | { live: true; via: InPlaceVia; location: string; activity: InPlaceActivity }
  /**
   * No place Scout can type into. `held` says a harness process still has the
   * session open, so it is running somewhere out of reach, not closed.
   */
  | { live: false; code: "not_live"; held: boolean }
  /** The session's identity could not be established; nothing may be typed. */
  | { live: false; code: "session_runtime_unobserved" | "session_ambiguous" };

/**
 * Look for the place a session is open, in the same order `deliverInPlace`
 * would use, and report what that place or the harness says it is doing.
 * `unknown` means neither gave a signal.
 */
export async function probeInPlace(
  input: { sessionId: string; harness?: string | null; requireExactHarness?: boolean },
  deps: DeliverInPlaceDeps = {},
): Promise<InPlaceProbe> {
  const { sessionId } = input;
  const harness = input.harness?.trim().toLowerCase() || null;
  const gathered = await gatherInPlaceCandidates({ sessionId, harness, requireExactHarness: input.requireExactHarness }, deps);
  if (!gathered.ok) return { live: false, code: gathered.code };
  const { candidates } = gathered;

  const harnessActivity = async (): Promise<InPlaceActivity> => {
    if (harness === "codex") return await (deps.codexActivity ?? codexActivity)(sessionId).catch(() => "unknown" as const);
    const status = candidates.claude?.status;
    // "shell" is a finished turn with a background shell still running: the
    // prompt is free. A shell command inside a turn reads "busy".
    if (status === "idle" || status === "shell") return "idle";
    if (status === "busy") return "busy";
    if (status === "waiting") return "blocked";
    return "unknown";
  };

  const order = deps.order ?? resolveInPlaceOrder();
  for (const host of order) {
    if (host === "herdr" && candidates.herdr) {
      const status = candidates.herdr.status;
      const activity: InPlaceActivity = status === "blocked" ? "blocked"
        : status === "working" ? "busy"
        : status === "idle" || status === "done" ? "idle"
        : await harnessActivity();
      return { live: true, via: "herdr", location: herdrLocation(candidates.herdr), activity };
    }
    if (host === "orca" && candidates.orca) {
      const { location, agent } = await orcaPlace(candidates.orca, deps);
      const activity: InPlaceActivity = agent?.state === "blocked" || agent?.state === "waiting" ? "blocked" : await harnessActivity();
      return { live: true, via: "orca", location, activity };
    }
    if (host === "tmux" && candidates.tmux) {
      let activity = await harnessActivity();
      if (activity === "idle" && await tmuxDraft(candidates.tmux.target, deps)) activity = "composing";
      return { live: true, via: "tmux", location: candidates.tmux.location, activity };
    }
  }

  if (harness === "codex") {
    const held = await (deps.codexHeldByApp ?? codexThreadHeldByChatGPTApp)(sessionId).catch(() => false);
    if (!held) return { live: false, code: "not_live", held: candidates.held };
    return { live: true, via: "scout-app", location: CODEX_APP_LOCATION, activity: await harnessActivity() };
  }

  const unreachable: InPlaceProbe = { live: false, code: "not_live", held: candidates.held };
  if (!order.includes("terminal") || candidates.terminalPid === null) return unreachable;
  const tty = await (deps.ttyForPid ?? ttyForPid)(candidates.terminalPid).catch(() => null);
  if (!tty) return unreachable;
  const ownTty = await (deps.selfTty ?? callerTty)().catch(() => null);
  if (tty === ownTty) return unreachable;
  return { live: true, via: "lattices", location: `terminal ${tty}`, activity: await harnessActivity() };
}

const PROBE_CONFIRM_READINGS = 3;
const PROBE_CONFIRM_MS = 500;

/**
 * `probeInPlace`, for a caller that acts on one answer. A single reading can
 * fail, or catch Claude's own record half written, and Claude Code has no
 * guard against a second copy resumed beside a live session. So a Claude
 * session reads as not open only on two readings in a row, and a reading that
 * could not see the session is taken again before it is reported.
 */
export async function probeInPlaceConfirmed(
  input: { sessionId: string; harness?: string | null; requireExactHarness?: boolean },
  deps: DeliverInPlaceDeps = {},
  options: { sleep?: (ms: number) => Promise<void>; probe?: typeof probeInPlace } = {},
): Promise<InPlaceProbe> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const probe = options.probe ?? probeInPlace;
  const claude = input.harness?.trim().toLowerCase() === "claude";
  let notOpen = 0;
  let last: InPlaceProbe | null = null;
  let failure: unknown = null;
  for (let reading = 0; reading < PROBE_CONFIRM_READINGS; reading += 1) {
    if (reading > 0) await sleep(PROBE_CONFIRM_MS);
    try {
      last = await probe(input, deps);
      failure = null;
    } catch (error) {
      failure = error;
      last = null;
      notOpen = 0;
      continue;
    }
    if (last.live) return last;
    if (last.code !== "not_live") {
      notOpen = 0;
      continue;
    }
    if (last.held || !claude) return last;
    notOpen += 1;
    if (notOpen >= 2) return last;
  }
  if (failure !== null) throw failure;
  // "Not open" seen once, after a reading that could not see: not established.
  if (last && !last.live && last.code === "not_live") return { live: false, code: "session_runtime_unobserved" };
  return last ?? { live: false, code: "session_runtime_unobserved" };
}

const CODEX_APP_LOCATION = "the ChatGPT app’s Codex";

function herdrLocation(pane: HerdrPaneMatch): string {
  return `Herdr ${pane.session} · ${pane.paneId}`;
}

async function orcaPlace(
  terminal: { terminalHandle: string; paneKey: string | null },
  deps: DeliverInPlaceDeps,
): Promise<{ location: string; agent: OrcaAgent | null }> {
  const agents = terminal.paneKey
    ? await (deps.readOrcaAgents ?? readOrcaAgents)().catch(() => [])
    : [];
  const agent = agents.find((entry) => entry.paneKey === terminal.paneKey) ?? null;
  const where = agent?.worktreePath?.split("/").filter(Boolean).slice(-2).join("/") ?? null;
  return { location: `Orca ${where ? `${where} · ` : ""}${terminal.terminalHandle}`, agent };
}

/** Called once every check has passed, immediately before the first keystroke. */
export type BeforeKeystroke = (place: { via: InPlaceVia; location: string }) => Promise<void> | void;

/**
 * The keystroke itself. `before` runs first and can refuse it: a caller that
 * must record "about to type" durably types nothing when that record fails.
 */
async function typeAt(
  place: { via: InPlaceVia; location: string },
  before: BeforeKeystroke | undefined,
  type: () => Promise<void>,
): Promise<InPlaceDelivery> {
  try {
    await before?.(place);
  } catch (error) {
    return { ok: false, code: "in_place_failed", ...place, nothingSent: true, detail: errorText(error) };
  }
  try {
    await type();
    return { ok: true, ...place };
  } catch (error) {
    return { ok: false, code: "in_place_failed", ...place, detail: errorText(error) };
  }
}

/**
 * Idle activity is not evidence of an empty composer. Current Herdr, Orca and
 * plain-terminal actuators provide no such read, so refuse before checkpointing
 * or typing. Do not fall through to another actuator for the same live session.
 */
async function typeWithEmptyComposer(
  place: { via: InPlaceVia; location: string },
  deps: DeliverInPlaceDeps,
  before: BeforeKeystroke | undefined,
  type: () => Promise<void>,
): Promise<InPlaceDelivery> {
  const empty = await deps.composerEmpty?.(place).catch(() => false);
  if (empty !== true) return {
    ok: false, code: "in_place_failed", ...place, nothingSent: true,
    detail: "Cannot prove this surface's composer is empty; unsent text could be overwritten. Nothing was typed. Send manually or move the session to a supported surface.",
  };
  return typeAt(place, before, type);
}

export async function deliverInPlace(
  input: {
    sessionId: string;
    harness?: string | null;
    body: string;
    requireExactHarness?: boolean;
    mode?: "submit" | "draft";
    beforeKeystroke?: BeforeKeystroke;
  },
  deps: DeliverInPlaceDeps = {},
): Promise<InPlaceDelivery> {
  const { sessionId, body } = input;
  const before = input.beforeKeystroke;
  const harness = input.harness?.trim().toLowerCase() || null;

  // Draft is deliberately handled before any terminal or Accessibility actuator.
  // A missing harness must not accidentally turn a draft into a submitted prompt.
  if (input.mode === "draft") {
    if (harness !== "codex") return { ok: false, code: "draft_unsupported", detail: "Draft mode requires --harness codex and an app-held thread; nothing was sent." };
    const held = await (deps.codexHeldByApp ?? codexThreadHeldByChatGPTApp)(sessionId).catch(() => false);
    if (!held) return { ok: false, code: "not_live" };
    try {
      await (deps.draftCodexApp ?? draftCodexApp)(sessionId, body);
      return { ok: true, delivered: "draft", via: "scout-app", location: "the ChatGPT app’s Codex composer (not sent)" };
    } catch (error) {
      return { ok: false, code: "in_place_failed", via: "scout-app", location: "the ChatGPT app’s Codex composer", detail: errorText(error) };
    }
  }

  const gathered = await gatherInPlaceCandidates({ sessionId, harness, requireExactHarness: input.requireExactHarness }, deps);
  if (!gathered.ok) return { ok: false, code: gathered.code };
  const { candidates } = gathered;

  for (const host of deps.order ?? resolveInPlaceOrder()) {
    if (host === "herdr" && candidates.herdr) return promptHerdrCandidate(candidates.herdr, body, deps, before);
    if (host === "orca" && candidates.orca) return promptOrcaCandidate(candidates.orca, body, deps, before);
    if (host === "tmux" && candidates.tmux) {
      const { target, location } = candidates.tmux;
      // Checked again here, just before the paste: a person may have started
      // typing since the probe.
      if (await tmuxDraft(target, deps)) {
        return { ok: false, code: "busy", via: "tmux", location, detail: "The composer holds unsent text. Nothing was typed." };
      }
      return typeAt({ via: "tmux", location }, before, () => (deps.promptTmux ?? promptTmuxPane)(target, body));
    }
  }

  // A Codex thread open in the ChatGPT app: nothing above can reach it.
  if (harness === "codex") {
    const held = await (deps.codexHeldByApp ?? codexThreadHeldByChatGPTApp)(sessionId).catch(() => false);
    if (!held) return { ok: false, code: "not_live" };
    const location = "the ChatGPT app’s Codex";
    let via: InPlaceVia = "scout-app";
    const activity = await (deps.codexActivity ?? codexActivity)(sessionId).catch(() => "unknown" as const);
    if (activity !== "idle") return { ok: false, code: activity === "busy" ? "busy" : "activity_unknown", via, location, detail: "Nothing submitted. Use mode=draft (--draft) to fill the composer, or queue with ask and wait for app release." };
    // Check the app can finish before the link puts words in the composer,
    // so a refusal never leaves a half-sent reply sitting there.
    const ask = deps.askScoutApp ?? ((request) => askScoutApp(request, { timeoutMs: 3_000 }));
    const status = await ask({ op: "status" });
    if (!status.ok) {
      // A call to an already-running daemon is a probe, never an app launch.
      try { await (deps.latticesCall ?? callLattices)("daemon.status", {}); via = "lattices"; }
      catch { return { ok: false, code: "scout_app_unavailable", via, location }; }
    }
    if (status.ok && status.accessibility !== "granted") return { ok: false, code: "scout_app_accessibility", via, location };
    if (status.ok) {
      // composer.submit combines focus + Return without a thread-bound idle
      // check between them. A preflight here cannot guard a turn started by
      // focus. Refuse before opening the URL; do not send ignored safety flags
      // to an old actuator or bypass this refusal through another backend.
      return { ok: false, code: "in_place_failed", via, location, nothingSent: true, detail: "Scout.app cannot recheck thread activity after focus and before Return; nothing opened or submitted. Use mode=draft (--draft) and send manually." };
    }
    return typeAt({ via, location }, before, () =>
      (deps.typeIntoCodexApp ?? ((id, words) => typeIntoCodexAppWithLattices(id, words, deps.latticesCall, deps.codexActivity)))(sessionId, body));
  }

  // A plain terminal tab: only Claude Code records the process to type into.
  const order = deps.order ?? resolveInPlaceOrder();
  if (!order.includes("terminal") || candidates.terminalPid === null) return { ok: false, code: "not_live" };
  const tty = await (deps.ttyForPid ?? ttyForPid)(candidates.terminalPid).catch(() => null);
  if (!tty) return { ok: false, code: "not_live" };
  // The sender's own tab: typing there would feed it its own words.
  const ownTty = await (deps.selfTty ?? callerTty)().catch(() => null);
  if (tty === ownTty) return { ok: false, code: "not_live" };
  return typeWithEmptyComposer({ via: "lattices", location: `terminal ${tty}` }, deps, before, () => (deps.typeIntoTty ?? typeIntoTtyWithLattices)(tty, body));
}

async function promptHerdrCandidate(
  pane: HerdrPaneMatch,
  body: string,
  deps: DeliverInPlaceDeps,
  before?: BeforeKeystroke,
): Promise<InPlaceDelivery> {
  const location = `Herdr ${pane.session} · ${pane.paneId}`;
  if (pane.status === "blocked") return { ok: false, code: "session_blocked", via: "herdr", location };
  return typeWithEmptyComposer({ via: "herdr", location }, deps, before, () => (deps.promptHerdr ?? promptHerdrPane)(pane, body));
}

async function promptOrcaCandidate(
  terminal: { terminalHandle: string; paneKey: string | null },
  body: string,
  deps: DeliverInPlaceDeps,
  before?: BeforeKeystroke,
): Promise<InPlaceDelivery> {
  const agents = terminal.paneKey
    ? await (deps.readOrcaAgents ?? readOrcaAgents)().catch(() => [])
    : [];
  const agent = agents.find((entry) => entry.paneKey === terminal.paneKey) ?? null;
  const where = agent?.worktreePath?.split("/").filter(Boolean).slice(-2).join("/") ?? null;
  const location = `Orca ${where ? `${where} · ` : ""}${terminal.terminalHandle}`;
  // blocked is a permission prompt; waiting is the agent asking a question.
  // Either way the composer isn't taking a new turn.
  if (agent?.state === "blocked" || agent?.state === "waiting") {
    return { ok: false, code: "session_blocked", via: "orca", location };
  }
  return typeWithEmptyComposer({ via: "orca", location }, deps, before, () => (deps.promptOrca ?? sendOrcaPrompt)(terminal.terminalHandle, body));
}

export async function findHerdrPaneForSession(sessionId: string, harness?: string | null): Promise<HerdrPaneMatch | null> {
  const matches: HerdrPaneMatch[] = [];
  const sessions = await readHerdrSessions({ maxAgeMs: 0 });
  for (const session of sessions) {
    if (!session.running) continue;
    const topology = await readHerdrTopology(session.name).catch(() => null);
    if (!topology?.running) continue;
    for (const workspace of topology.workspaces) {
      for (const tab of workspace.tabs) {
        for (const pane of tab.panes) {
          if (pane.agentSession?.value === sessionId) {
            const match = { session: session.name, paneId: pane.paneId, status: pane.agentStatus ?? null,
              harness: pane.agentSession.agent, sessionKind: pane.agentSession.kind };
            if (!harness) return match;
            matches.push(match);
          }
        }
      }
    }
  }
  const exact = matches.filter(match => match.harness === harness && match.sessionKind === "id");
  if (exact.length > 1) throw new Error("session_ambiguous: multiple Herdr panes report this native session and harness");
  // Return an unmatched observation for strict callers to refuse; absence of
  // matching identity must not be confused with proof that nothing is live.
  return exact[0] ?? matches[0] ?? null;
}

async function locateProcessHost(pid: number): Promise<ProcessHostLocation | null> {
  return innermostProcessHost(await readProcessHostEnv(pid));
}

async function promptHerdrPane(match: HerdrPaneMatch, body: string): Promise<void> {
  // `agent prompt` honors the pane's bracketed-paste mode and sends Enter as
  // one ordered submission; it refuses a pane sitting at an approval dialog.
  await execSystemFile("herdr", ["--session", match.session, "agent", "prompt", match.paneId, body], {
    timeoutMs: HERDR_TIMEOUT_MS,
    maxStdoutBytes: 64 * 1024,
  });
}

async function promptTmuxPane(target: string, body: string): Promise<void> {
  const result = await sendTmuxPrompt(target, body);
  if (!result.submitted) throw new Error("the pane did not accept the prompt");
}

const TMUX_COMPOSER_TAIL_LINES = 40;

/** A capture that fails says nothing; the paste that follows fails on its own. */
async function tmuxDraft(target: string, deps: DeliverInPlaceDeps): Promise<string | null> {
  return await (deps.tmuxComposerDraft ?? readTmuxComposerDraft)(target).catch(() => null);
}

async function readTmuxComposerDraft(target: string): Promise<string | null> {
  // `-e` keeps the escape sequences, which tell typed text from a suggestion.
  const { stdout } = await execSystemFile("tmux", [
    "capture-pane", "-p", "-e", "-t", target, "-S", `-${TMUX_COMPOSER_TAIL_LINES}`,
  ], { timeoutMs: 2_000, maxStdoutBytes: 256 * 1024 });
  return tmuxPaneTailUnsentComposerText(stdout);
}

/**
 * The terminal the caller runs in. A harness's tool commands and MCP servers
 * often have no tty of their own, so walk up to the first ancestor that does
 * — the agent process sitting in the tab.
 */
async function callerTty(): Promise<string | null> {
  let pid = process.pid;
  for (let depth = 0; depth < 12 && pid > 1; depth += 1) {
    const { stdout } = await execSystemFile("ps", ["-p", String(pid), "-o", "ppid=,tty="], { timeoutMs: 2_000, maxStdoutBytes: 1024 });
    const [ppid, tty] = stdout.trim().split(/\s+/u);
    if (tty && tty !== "??" && tty !== "?") return tty.startsWith("tty") ? tty : `tty${tty}`;
    pid = Number(ppid);
    if (!Number.isInteger(pid)) return null;
  }
  return null;
}

async function ttyForPid(pid: number): Promise<string | null> {
  const { stdout } = await execSystemFile("ps", ["-p", String(pid), "-o", "tty="], { timeoutMs: 2_000, maxStdoutBytes: 1024 });
  const tty = stdout.trim();
  if (!tty || tty === "??") return null;
  return tty.startsWith("tty") ? tty : `tty${tty}`;
}

async function typeIntoTtyWithLattices(tty: string, body: string): Promise<void> {
  await execSystemFile("lattices", [
    "computer", "type-text",
    "--tty", tty,
    "--text", body,
    "--treatment", "execute",
    "--enter",
    "--no-capture",
    "--json",
  ], { timeoutMs: 15_000, maxStdoutBytes: 256 * 1024 });
}

const CHATGPT_APP = "ChatGPT.app/";
const CODEX_APP_OPEN_SETTLE_MS = 1_200;

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/**
 * Codex takes a per-thread writer lock under ~/.codex/thread-writer-locks.
 * Each holder is a process with the thread open, with its command line.
 */
async function codexThreadLockHolders(sessionId: string): Promise<Array<{ pid: number; command: string }>> {
  if (!/^[0-9a-f-]{16,}$/iu.test(sessionId)) return [];
  const lock = join(codexHome(), "thread-writer-locks", `${sessionId}.lock`);
  let pids: string[] = [];
  try {
    const { stdout } = await execSystemFile("lsof", ["-t", lock], { timeoutMs: 3_000, maxStdoutBytes: 4 * 1024 });
    pids = stdout.split(/\s+/u).filter(Boolean);
  } catch {
    return []; // lsof exits 1 when nothing holds the file
  }
  const holders: Array<{ pid: number; command: string }> = [];
  for (const pid of pids) {
    const { stdout } = await execSystemFile("ps", ["-p", pid, "-o", "command="], { timeoutMs: 2_000, maxStdoutBytes: 8 * 1024 })
      .catch(() => ({ stdout: "" }));
    holders.push({ pid: Number(pid), command: stdout });
  }
  return holders;
}

/** Codex processes with the thread open in a terminal, not in the ChatGPT app. */
export async function codexThreadHolderPids(sessionId: string): Promise<number[]> {
  return (await codexThreadLockHolders(sessionId))
    .filter((holder) => !holder.command.includes(CHATGPT_APP) && Number.isInteger(holder.pid))
    .map((holder) => holder.pid);
}

/** When the process holding the lock lives inside ChatGPT.app, the thread is open in the app. */
export async function codexThreadHeldByChatGPTApp(sessionId: string): Promise<boolean> {
  return (await codexThreadLockHolders(sessionId)).some((holder) => holder.command.includes(CHATGPT_APP));
}

/** The URL handler fills the composer; no Accessibility grant or Return key. */
async function draftCodexApp(sessionId: string, body: string): Promise<void> {
  const link = `codex://threads/${encodeURIComponent(sessionId)}?prompt=${encodeURIComponent(body)}`;
  await execSystemFile("open", ["-u", link], { timeoutMs: 5_000, maxStdoutBytes: 4 * 1024 });
}

async function typeIntoCodexAppWithLattices(
  sessionId: string,
  body: string,
  latticesCall: LatticesCall = callLattices,
  activity: (sessionId: string) => Promise<"idle" | "busy" | "unknown"> = codexActivity,
): Promise<void> {
  // The bridge holds no Accessibility grant. The link and the transcript need
  // none; focus and Return use the already-running Lattices daemon's grant.
  const transcript = await findCodexTranscript(sessionId);
  const offset = transcript ? (await stat(transcript).catch(() => null))?.size ?? 0 : 0;

  if (!transcript) throw new Error("Cannot verify the target transcript; use draft mode instead.");

  // 1. The app's own thread link picks the thread by id and fills its
  //    composer. `-u` keeps `open` a plain URL open; a lone argument is
  //    rerouted to scoutd's file-reveal verb, which refuses URLs.
  await draftCodexApp(sessionId, body);
  await new Promise((resolve) => setTimeout(resolve, CODEX_APP_OPEN_SETTLE_MS));

  // 2. Lattices anchors on content, verifies it again after focus, and checks
  //    activity before Return. Scout.app's unguarded operation is never used.
  const beforeSubmit = async () => {
    if (await activity(sessionId) !== "idle") throw new Error("Thread is busy or activity is unknown; nothing submitted. Use draft mode or queue with ask.");
  };
  await beforeSubmit();
  await submitLatticesComposer(body, beforeSubmit, latticesCall);

  // 3. Delivered means the thread recorded it, not that a key was pressed.
  if (!transcript) throw new Error("couldn't find this thread's transcript to confirm the reply");
  if (!(await waitForCodexUserMessage(transcript, offset, body))) {
    throw new Error("Return was pressed, but the thread didn't record the reply; inspect the transcript before retrying to avoid duplicates, or use draft mode");
  }
}

type CodexActivity = "idle" | "busy" | "unknown";

/** What one rollout line says about the turn: it began, it ended, nothing, or the line cannot be read. */
function codexLifecycle(line: string): "busy" | "idle" | "unreadable" | null {
  if (!line.trim()) return null;
  try {
    const row = JSON.parse(line);
    if (row.type !== "event_msg") return null;
    if (row.payload?.type === "task_started") return "busy";
    return ["task_complete", "turn_aborted"].includes(row.payload?.type) ? "idle" : null;
  } catch {
    return "unreadable";
  }
}

/** No heuristic based on assistant prose: only harness lifecycle events establish activity. */
export function codexActivityFromTranscript(text: string): CodexActivity {
  let state: CodexActivity = "unknown";
  for (const line of text.split("\n")) {
    const said = codexLifecycle(line);
    if (said === "unreadable") return "unknown"; // An incomplete append cannot establish idle.
    if (said) state = said;
  }
  return state;
}

const CODEX_ACTIVITY_TAILS = 16;
/** Each rollout's state so far, so a probe reads only what was appended since the last one. */
const codexActivityTails = new Map<string, { tail: LineTail; state: CodexActivity }>();

export async function codexActivityFromRollout(path: string): Promise<CodexActivity> {
  let entry = codexActivityTails.get(path);
  if (!entry) {
    if (codexActivityTails.size >= CODEX_ACTIVITY_TAILS) {
      codexActivityTails.delete(codexActivityTails.keys().next().value as string);
    }
    const fresh: { tail: LineTail; state: CodexActivity } = {
      // A rollout that was replaced is read again from its start.
      tail: openLineTail(path, 0, { onReplaced: () => { fresh.state = "unknown"; } }),
      state: "unknown",
    };
    entry = fresh;
    codexActivityTails.set(path, entry);
  }
  const reading = entry;
  const read = await reading.tail.read((line) => {
    const said = codexLifecycle(line);
    if (said) reading.state = said === "unreadable" ? "unknown" : said;
  });
  if (!read) {
    codexActivityTails.delete(path);
    return "unknown";
  }
  // A line still being written may be the start of a turn.
  return reading.state === "idle" && reading.tail.unfinished() ? "unknown" : reading.state;
}

async function codexActivity(sessionId: string): Promise<CodexActivity> {
  const path = await findCodexTranscript(sessionId);
  return path ? codexActivityFromRollout(path) : "unknown";
}

const TRANSCRIPT_CONFIRM_MS = 8_000;

export async function findCodexTranscript(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{16,}$/iu.test(sessionId)) return null;
  const sessions = join(codexHome(), "sessions");
  const { stdout } = await execSystemFile("find", [sessions, "-name", `rollout-*-${sessionId}.jsonl`, "-print", "-quit"], {
    timeoutMs: 5_000,
    maxStdoutBytes: 4 * 1024,
  }).catch(() => ({ stdout: "" }));
  return stdout.trim() || null;
}

/** Reads what the thread appended after `offset`, looking for a user turn with these words. */
async function waitForCodexUserMessage(transcript: string, offset: number, body: string): Promise<boolean> {
  const expected = collapseWhitespace(body);
  const deadline = Date.now() + TRANSCRIPT_CONFIRM_MS;
  while (Date.now() < deadline) {
    const text = await readFile(transcript, "utf8").catch(() => "");
    for (const line of Buffer.from(text, "utf8").subarray(offset).toString("utf8").split("\n")) {
      if (!line.includes('"user"')) continue;
      try {
        const payload = (JSON.parse(line) as { payload?: { role?: string; type?: string; message?: string; content?: Array<{ text?: string }> } }).payload;
        const said = payload?.type === "user_message"
          ? payload.message ?? ""
          : payload?.role === "user" ? (payload.content ?? []).map((part) => part.text ?? "").join(" ") : "";
        if (said && collapseWhitespace(said) === expected) return true;
      } catch {
        // A line still being written; read again.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
