import { randomUUID } from "node:crypto";
import type { AgentEndpoint } from "@openscout/protocol";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS, userSpawnPaneAssignments } from "./instance.js";
import type { LiveTerminalSession } from "./live-terminal-session.js";
import { execSystemFile, ProbeCommandError } from "./system-probes/exec.js";
import { INHERITED_CLAUDE_SESSION_ENV_KEYS } from "./terminal-environment.js";
import { resolveExecutableFromSearch } from "./tool-resolution.js";

export type RexSurface = { backend: "rex"; sessionId: string; windowId: string; blockId: string };
type RexProcess = { pid: number; name: string; invoked_path?: string; argv0?: string; script?: string; cwd?: string };
type RexProcessRead = { foreground?: RexProcess; child?: RexProcess; ancestors?: RexProcess[]; last_exit: { exit_code: number } | null };
export type RexStartInput = { sessionId: string; projectPath: string; harness: "codex" | "claude"; name?: string };
export type RexStatusInput = { sessionId: string; blockId?: string };

function isId(value: unknown, kind: string): value is string {
  return typeof value === "string" && value.startsWith(kind + ":")
    && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.slice(kind.length + 1));
}

export function isRexSurface(value: unknown): value is RexSurface {
  const surface = value as Partial<RexSurface> | undefined;
  return surface?.backend === "rex" && isId(surface.sessionId, "session")
    && isId(surface.windowId, "window") && isId(surface.blockId, "block");
}

async function rex(args: string[], input?: string): Promise<string> {
  const bundle = join(homedir(), "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS");
  const bin = resolveExecutableFromSearch({ names: ["rex"], extraDirectories: process.platform === "darwin" ? [bundle] : [] });
  if (!bin) throw new Error("Rex CLI unavailable. Install rex on the runtime host.");
  const env = { ...process.env };
  // Every operation targets the runtime host's Rex server and an explicit ID.
  for (const key of ["REX_SERVER", "REX_CLIENT", "REX_SESSION", "REX_BLOCK", "REX_WINDOW"]) delete env[key];
  try {
    const { stdout } = await execSystemFile(bin.path, ["--autostart=false", "--timeout=3s", ...args], {
      timeoutMs: 4000, maxStdoutBytes: 1024 * 1024, env, input,
    });
    return stdout;
  } catch (error) {
    if (error instanceof ProbeCommandError && error.stderr?.trim()) throw new Error(error.stderr.trim().split("\n")[0]);
    throw error;
  }
}

function requireSessionId(sessionId: string): void {
  if (!isId(sessionId, "session")) throw new Error("Provide the full local Rex session ID (REX_SESSION) for this operation.");
}

function blockArgs({ sessionId, blockId }: { sessionId: string; blockId: string }): string[] {
  requireSessionId(sessionId);
  if (!isId(blockId, "block")) throw new Error("Provide the full Rex block ID returned by the launch.");
  return ["-s", sessionId, "-b", blockId];
}

async function readProcess(surface: RexStatusInput & { blockId: string }): Promise<RexProcessRead> {
  return JSON.parse(await rex(["block", "call", ...blockArgs(surface), "process"]));
}

export function isRexHarness(process: RexProcess | undefined, harness: string): boolean {
  return Boolean(process && Number.isSafeInteger(process.pid) && process.pid > 1
    && [process.name, process.invoked_path, process.argv0, process.script].some(path =>
      path && [harness, harness + ".js"].includes(basename(path))));
}

export async function rexHarnessPresent(surface: RexSurface, pid: number, harness: string): Promise<boolean> {
  const processes = await readProcess(surface);
  if (processes.last_exit) return false;
  return [processes.foreground, processes.child, ...(processes.ancestors ?? [])]
    .some(candidate => candidate?.pid === pid && isRexHarness(candidate, harness));
}

export function rexBindings(endpoints: AgentEndpoint[], nodeId: string, input: RexStatusInput) {
  return endpoints.flatMap(endpoint => {
    const surface = endpoint.metadata?.terminalSurface;
    if (endpoint.nodeId !== nodeId || endpoint.transport !== "rex" || !isRexSurface(surface)
      || surface.sessionId !== input.sessionId || (input.blockId && surface.blockId !== input.blockId)) return [];
    return [{ agentId: endpoint.agentId, endpointId: endpoint.id, blockId: surface.blockId, state: endpoint.state }];
  });
}

type RexWindow = {
  window_id: string;
  label?: string;
  focused_block_id?: string;
  layers: { blocks: { block_id: string; label?: string }[] }[];
};

export async function readRexStatus(input: RexStatusInput) {
  requireSessionId(input.sessionId);
  if (input.blockId === undefined) {
    const view = JSON.parse(await rex(["session", "inspect", input.sessionId, "--json"]));
    if (view.session_id !== input.sessionId) throw new Error("Rex returned a different session.");
    return {
      sessionId: input.sessionId,
      name: view.label,
      activeWindowId: view.active_window_id,
      windows: (view.windows as RexWindow[]).map(window => ({
        windowId: window.window_id,
        name: window.label,
        focusedBlockId: window.focused_block_id,
        blocks: window.layers.flatMap(layer => layer.blocks.map(block => ({ blockId: block.block_id, name: block.label }))),
      })),
      observedAt: Date.now(),
    };
  }
  const block = { sessionId: input.sessionId, blockId: input.blockId };
  const [process, reports] = await Promise.all([
    readProcess(block), rex(["block", "call", ...blockArgs(block), "program_status"]),
  ]);
  const { records } = JSON.parse(reports);
  if (!Array.isArray(records)) throw new Error("Rex returned an unreadable program status.");
  return { ...block, foreground: process.foreground ?? null, lastExit: process.last_exit,
    programStatus: records, observedAt: Date.now() };
}

export async function startRexAgent<T>(
  input: RexStartInput,
  agentId: string,
  attach: (live: LiveTerminalSession, name: string) => Promise<T>,
) {
  requireSessionId(input.sessionId);
  if (input.harness !== "claude" && input.harness !== "codex") throw new Error("Choose claude or codex for a Rex window.");
  if (typeof input.projectPath !== "string" || !isAbsolute(input.projectPath) || !(await stat(input.projectPath)).isDirectory()) {
    throw new Error("Provide an absolute local project directory.");
  }
  const name = input.name ?? input.harness;
  if (typeof name !== "string" || !name.trim() || name.startsWith("-") || /[\x00-\x1f\x7f]/u.test(name) || name.length > 128) {
    throw new Error("Invalid Rex window name.");
  }
  const executable = resolveExecutableFromSearch({ names: [input.harness], extraDirectories: [join(homedir(), ".local/bin")] });
  if (!executable) throw new Error(`${input.harness} is unavailable on the runtime host.`);
  const unsets = [...OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS, ...INHERITED_CLAUDE_SESSION_ENV_KEYS, "CODEX_THREAD_ID", "OPENSCOUT_SESSION_ID"];
  const nativeSessionId = input.harness === "claude" ? randomUUID() : undefined;
  const harnessArgs = nativeSessionId ? ["--session-id", nativeSessionId, "--name", name] : ["-c", "check_for_update_on_startup=false"];
  const command = ["/usr/bin/env", ...unsets.flatMap(key => ["-u", key]),
    ...userSpawnPaneAssignments().map(([key, value]) => `${key}=${value}`),
    `OPENSCOUT_AGENT=${agentId}`, `OPENSCOUT_SETUP_CWD=${input.projectPath}`, executable.path, ...harnessArgs];
  // Rex creates one window and returns its exact block. Never retry creation on a timeout.
  let created;
  try {
    created = JSON.parse(await rex(["window", "new", "-s", input.sessionId, "--focus=false", "--keep-open", "--shell=none",
      "--cwd", input.projectPath, "--json", name, "--", ...command]));
  } catch (error) {
    throw new Error(`Rex window creation was not confirmed. Inspect session ${input.sessionId} before retrying. ${error}`);
  }
  const surface = { backend: "rex" as const, sessionId: input.sessionId, windowId: created?.window_id, blockId: created?.block_ids?.[0] };
  if (!isRexSurface(surface)) throw new Error(`Rex returned incomplete window IDs. Inspect session ${input.sessionId} before retrying.`);
  try {
    const deadline = Date.now() + 5000;
    do {
      const state = await readProcess(surface);
      if (state.last_exit) throw new Error(`harness exited with code ${state.last_exit.exit_code}`);
      if (state.foreground && isRexHarness(state.foreground, input.harness)) {
        const pid = state.foreground.pid;
        const binding = await attach({ harness: input.harness, pid, surface, nativeSessionId }, name);
        return { ...binding, surface, harness: input.harness, projectPath: input.projectPath };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`Rex did not observe ${input.harness} in the new block`);
  } catch (error) {
    // Only this launch's fresh block can be rolled back. Never close the parent session.
    try { await rex(["block", "close", "-s", surface.sessionId, surface.blockId]); }
    catch { throw new Error(`Launch failed for Rex block ${surface.blockId}. Inspect it in ${surface.sessionId} before retrying. ${error}`); }
    throw error;
  }
}

async function rexScreenTail(args: string[], format: "text" | "html" = "text"): Promise<string> {
  const frame = JSON.parse(await rex(["block", "call", ...args, "format", JSON.stringify({ format, trim: true, max_bytes: 65536 })]));
  if (!frame.id) return frame.content;
  if (!Number.isSafeInteger(frame.total) || frame.total < 1) throw new Error("Rex could not provide the current terminal screen.");
  // format returns the beginning of a large scrollback. Read the recent tail
  // of that same snapshot, with enough room for JSON escaping of its bytes.
  const range = { id: frame.id, offset: Math.max(0, frame.total - (format === "html" ? 32768 : 8192)), max_bytes: 65536 };
  const tail = JSON.parse(await rex(["block", "call", ...args, "blob_read", JSON.stringify(range)]));
  if (!tail.eof || typeof tail.data !== "string") throw new Error("Rex returned an incomplete terminal screen.");
  return tail.data;
}

const COMPOSER_PROMPT = /^\s*[❯›](?:\s|$)/u;
const FAINT_RUN = /<div style="[^"]*\bopacity:\s*0?\.\d+[^"]*">[^<]*<\/div>/g;

function htmlText(html: string): string {
  return html.replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * True when the last prompt line of an HTML screen read holds no typed text.
 * Claude and Codex draw their placeholder faint (opacity below 1), so a faint
 * run after the prompt glyph is not input. A picker row or unsent text is.
 */
export function rexComposerIsEmpty(html: string): boolean {
  const composer = html.split("\n").filter(line => COMPOSER_PROMPT.test(htmlText(line))).at(-1);
  return composer !== undefined && htmlText(composer.replace(FAINT_RUN, "")).replace(COMPOSER_PROMPT, "").trim() === "";
}

export async function sendRexPrompt(surface: RexSurface, pid: number, harness: string, text: string): Promise<void> {
  if (!isRexSurface(surface)) throw new Error("Missing exact Rex block address.");
  const requireForeground = async () => {
    const { foreground } = await readProcess(surface);
    if (foreground?.pid !== pid || !isRexHarness(foreground, harness)) {
      throw new Error(`The attached ${harness} does not own input in Rex block ${surface.blockId}.`);
    }
  };
  await requireForeground();
  if (/[\x00-\x08\x0b-\x1f\x7f]/u.test(text)) throw new Error("Rex prompt contains terminal control characters.");
  const args = blockArgs(surface);
  const [modeRead, statusRead] = await Promise.all([
    rex(["block", "call", ...args, "modes"]),
    rex(["block", "call", ...args, "program_status"]),
  ]);
  const blocked = JSON.parse(statusRead).records.find((record: { state: string; owner?: { pid: number } }) =>
    record.state === "blocked" && record.owner?.pid === pid);
  if (blocked) throw new Error(`Rex reports ${harness} is blocked (${blocked.kind ?? "waiting for input"}) in ${surface.blockId}.`);
  const modes = JSON.parse(modeRead);
  if (!modes.modes?.some((m: { name: string; set: boolean }) => m.name === "bracketed_paste" && m.set === true)) {
    throw new Error("Rex harness is not ready for pasted input. Check its terminal.");
  }
  // Paste nothing unless the screen shows an empty chat composer. A trust,
  // update or session picker, or text the operator has not sent, refuses here.
  if (!rexComposerIsEmpty(await rexScreenTail(args, "html"))) {
    throw new Error(`Rex block ${surface.blockId} has no empty, ready ${harness} composer. Inspect its window before retrying.`);
  }
  // Confirm that a fresh marker actually landed in the composer before Enter.
  const marker = `[Scout ${randomUUID().slice(0, 8)}]`;
  const paste = (value: string) => rex(["send", ...args], "\x1b[200~" + value + "\x1b[201~");
  await paste(marker + " ");
  let inComposer = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const screen = await rexScreenTail(args);
    const showsMarker = screen.split("\n")
      .some(line => /^\s*[❯›]\s*(.*?)\s*$/u.exec(line)?.[1] === marker);
    if (showsMarker) {
      inComposer = true;
      break;
    }
  }
  if (!inComposer) {
    // The composer was empty before the paste, so erasing the marker's own
    // characters restores it. A later ask then finds an empty composer again.
    let erased = false;
    try {
      await requireForeground();
      await rex(["send-key", ...args, ...Array.from({ length: marker.length + 1 }, () => "backspace")]);
      erased = true;
    } catch { /* reported below */ }
    throw new Error(`Rex block ${surface.blockId} did not show the Scout marker in its ${harness} composer`
      + (erased ? "; the marker was erased." : "; the marker could not be erased.")
      + " Inspect its window before retrying.");
  }
  await requireForeground();
  await paste(text);
  await new Promise(resolve => setTimeout(resolve, 150));
  await requireForeground();
  await rex(["send-key", ...args, "Enter"]);
}
