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
// (`codex://threads/<id>?prompt=`); the Scout app, which holds the
// Accessibility grant, focuses the composer holding exactly that text and
// presses Return, and the thread's transcript confirms it.
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
import { sendTmuxPrompt } from "../local-agents.js";

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
  | { ok: false; code: "draft_unsupported"; detail: string }
  /** The session is live but can't take words right now (e.g. a permission prompt is up). */
  | { ok: false; code: "session_blocked"; via: InPlaceVia; location: string }
  /** The session is live in a place Scout found but couldn't type into. */
  | { ok: false; code: "in_place_failed"; via: InPlaceVia; location: string; detail: string }
  /** Live in an app only the Scout app can reach, and the Scout app can't right now. */
  | { ok: false; code: "scout_app_unavailable" | "scout_app_accessibility"; via: InPlaceVia; location: string }
  /** No live place holds this session. */
  | { ok: false; code: "not_live" }
  /** Exact session identity could not be established before any input. */
  | { ok: false; code: "session_runtime_unobserved" | "session_ambiguous" };

export type HerdrPaneMatch = { session: string; paneId: string; status: string | null; harness?: string; sessionKind?: string };

export type DeliverInPlaceDeps = {
  findHerdrPane?: (sessionId: string, harness?: string | null) => Promise<HerdrPaneMatch | null>;
  promptHerdr?: (match: HerdrPaneMatch, body: string) => Promise<void>;
  findClaudeRecord?: (sessionId: string) => Promise<ClaudeSessionRecord | null>;
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
  ttyForPid?: (pid: number) => Promise<string | null>;
  typeIntoTty?: (tty: string, body: string) => Promise<void>;
  /** Whether the ChatGPT app's Codex holds this thread's writer lock. */
  codexHeldByApp?: (sessionId: string) => Promise<boolean>;
  /** Opens only the exact thread link; never submits. */
  draftCodexApp?: (sessionId: string, body: string) => Promise<void>;
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
 */
export function isScoutBackgroundCopy(record: ClaudeSessionRecord): boolean {
  const tmuxSession = record.tmux?.session ?? "";
  return tmuxSession.startsWith("flat-") || (record.name ?? "").endsWith("-relay-agent");
}

/** Every place one session is held, gathered before any is tried. */
type Candidates = {
  herdr: HerdrPaneMatch | null;
  orca: { terminalHandle: string; paneKey: string | null } | null;
  tmux: { target: string; location: string } | null;
  /** The Claude process, for typing into a plain terminal tab. */
  terminalPid: number | null;
};

export async function deliverInPlace(
  input: { sessionId: string; harness?: string | null; body: string; requireExactHarness?: boolean; mode?: "submit" | "draft" },
  deps: DeliverInPlaceDeps = {},
): Promise<InPlaceDelivery> {
  const { sessionId, body } = input;
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

  const candidates: Candidates = { herdr: null, orca: null, tmux: null, terminalPid: null };

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
    const record = await (deps.findClaudeRecord ?? findLiveClaudeSession)(sessionId).catch(() => null);
    if (record && !isScoutBackgroundCopy(record)) {
      pids.push(record.pid);
      candidates.terminalPid = record.pid;
      if (record.tmux) {
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

  for (const host of deps.order ?? resolveInPlaceOrder()) {
    if (host === "herdr" && candidates.herdr) return promptHerdrCandidate(candidates.herdr, body, deps);
    if (host === "orca" && candidates.orca) return promptOrcaCandidate(candidates.orca, body, deps);
    if (host === "tmux" && candidates.tmux) {
      const { target, location } = candidates.tmux;
      try {
        await (deps.promptTmux ?? promptTmuxPane)(target, body);
        return { ok: true, via: "tmux", location };
      } catch (error) {
        return { ok: false, code: "in_place_failed", via: "tmux", location, detail: errorText(error) };
      }
    }
  }

  // A Codex thread open in the ChatGPT app: nothing above can reach it.
  if (harness === "codex") {
    const held = await (deps.codexHeldByApp ?? codexThreadHeldByChatGPTApp)(sessionId).catch(() => false);
    if (!held) return { ok: false, code: "not_live" };
    const location = "the ChatGPT app’s Codex";
    const via = "scout-app";
    // Check the app can finish before the link puts words in the composer,
    // so a refusal never leaves a half-sent reply sitting there.
    const ask = deps.askScoutApp ?? ((request) => askScoutApp(request, { timeoutMs: 3_000 }));
    const status = await ask({ op: "status" });
    if (!status.ok) return { ok: false, code: "scout_app_unavailable", via, location };
    if (status.accessibility !== "granted") return { ok: false, code: "scout_app_accessibility", via, location };
    try {
      await (deps.typeIntoCodexApp ?? ((id, words) => typeIntoCodexApp(id, words, deps.askScoutApp)))(sessionId, body);
      return { ok: true, via, location };
    } catch (error) {
      return { ok: false, code: "in_place_failed", via, location, detail: errorText(error) };
    }
  }

  // A plain terminal tab: only Claude Code records the process to type into.
  const order = deps.order ?? resolveInPlaceOrder();
  if (!order.includes("terminal") || candidates.terminalPid === null) return { ok: false, code: "not_live" };
  const tty = await (deps.ttyForPid ?? ttyForPid)(candidates.terminalPid).catch(() => null);
  if (!tty) return { ok: false, code: "not_live" };
  // The sender's own tab: typing there would feed it its own words.
  const ownTty = await (deps.selfTty ?? callerTty)().catch(() => null);
  if (tty === ownTty) return { ok: false, code: "not_live" };
  const location = `terminal ${tty}`;
  try {
    await (deps.typeIntoTty ?? typeIntoTtyWithLattices)(tty, body);
    return { ok: true, via: "lattices", location };
  } catch (error) {
    return { ok: false, code: "in_place_failed", via: "lattices", location, detail: errorText(error) };
  }
}

async function promptHerdrCandidate(
  pane: HerdrPaneMatch,
  body: string,
  deps: DeliverInPlaceDeps,
): Promise<InPlaceDelivery> {
  const location = `Herdr ${pane.session} · ${pane.paneId}`;
  if (pane.status === "blocked") return { ok: false, code: "session_blocked", via: "herdr", location };
  try {
    await (deps.promptHerdr ?? promptHerdrPane)(pane, body);
    return { ok: true, via: "herdr", location };
  } catch (error) {
    return { ok: false, code: "in_place_failed", via: "herdr", location, detail: errorText(error) };
  }
}

async function promptOrcaCandidate(
  terminal: { terminalHandle: string; paneKey: string | null },
  body: string,
  deps: DeliverInPlaceDeps,
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
  try {
    await (deps.promptOrca ?? sendOrcaPrompt)(terminal.terminalHandle, body);
    return { ok: true, via: "orca", location };
  } catch (error) {
    return { ok: false, code: "in_place_failed", via: "orca", location, detail: errorText(error) };
  }
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

async function typeIntoCodexApp(
  sessionId: string,
  body: string,
  ask: DeliverInPlaceDeps["askScoutApp"] = (request) => askScoutApp(request),
): Promise<void> {
  // The bridge holds no Accessibility grant. The link and the transcript need
  // none; the one step that does (focus + Return) runs in the Scout app.
  const transcript = await findCodexTranscript(sessionId);
  const offset = transcript ? (await stat(transcript).catch(() => null))?.size ?? 0 : 0;

  // 1. The app's own thread link picks the thread by id and fills its
  //    composer. `-u` keeps `open` a plain URL open; a lone argument is
  //    rerouted to scoutd's file-reveal verb, which refuses URLs.
  await draftCodexApp(sessionId, body);
  await new Promise((resolve) => setTimeout(resolve, CODEX_APP_OPEN_SETTLE_MS));

  // 2. The Scout app anchors on content (the one composer holding exactly
  //    these words; none or several and it stops) and presses Return there.
  const submitted = await ask({ op: "composer.submit", bundleId: CHATGPT_BUNDLE_ID, text: body });
  if (!submitted.ok) throw new Error(`the Scout app didn't submit it: ${submitted.message}`);

  // 3. Delivered means the thread recorded it, not that a key was pressed.
  if (!transcript) throw new Error("couldn't find this thread's transcript to confirm the reply");
  if (!(await waitForCodexUserMessage(transcript, offset, body))) {
    throw new Error("Return was pressed, but the thread didn't record the reply");
  }
}

/** The ChatGPT app's bundle id (it ships Codex, and registers as such). */
const CHATGPT_BUNDLE_ID = "com.openai.codex";
const TRANSCRIPT_CONFIRM_MS = 8_000;

async function findCodexTranscript(sessionId: string): Promise<string | null> {
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
        if (said && collapseWhitespace(said).includes(expected)) return true;
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
