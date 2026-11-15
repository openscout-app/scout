/**
 * Local peer lookup for the shared Scout MCP server.
 *
 * A stdio MCP server learns its session from the environment and directory
 * its harness launched it with. A shared server has no launch, so it asks
 * the OS instead: which local process owns the other end of this TCP
 * connection, and what environment and directory does that process run in.
 * Same-user, same-host only: this is Scout's local trust model, and it does
 * not hold once a connection comes from another machine.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;
const PROCARGS_BUFFER_BYTES = 1024 * 1024;

type SysctlFn = (
  name: Int32Array,
  namelen: number,
  oldp: Uint8Array,
  oldlenp: BigUint64Array,
  newp: null,
  newlen: number,
) => number;

let sysctl: SysctlFn | null | undefined;

async function loadSysctl(): Promise<SysctlFn | null> {
  if (sysctl !== undefined) return sysctl;
  if (process.platform !== "darwin") return (sysctl = null);
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    sysctl = lib.symbols.sysctl as unknown as SysctlFn;
  } catch {
    sysctl = null;
  }
  return sysctl;
}

/**
 * Parse a KERN_PROCARGS2 buffer: int32 argc, the executable path, NUL
 * padding, argc NUL-terminated arguments, then NUL-terminated `KEY=value`
 * environment strings, ending at the first empty string.
 */
export function parseProcArgs2(buffer: Uint8Array): { argv: string[]; env: Record<string, string> } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.byteLength < 4) return { argv: [], env: {} };
  const argc = view.getInt32(0, true);
  const decoder = new TextDecoder();
  let offset = 4;
  const readString = () => {
    const end = buffer.indexOf(0, offset);
    const stop = end === -1 ? buffer.byteLength : end;
    const value = decoder.decode(buffer.subarray(offset, stop));
    offset = stop + 1;
    return value;
  };
  readString(); // executable path
  while (offset < buffer.byteLength && buffer[offset] === 0) offset += 1;
  const argv: string[] = [];
  for (let i = 0; i < argc && offset < buffer.byteLength; i += 1) argv.push(readString());
  const env: Record<string, string> = {};
  while (offset < buffer.byteLength) {
    const entry = readString();
    if (!entry) break;
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return { argv, env };
}

/**
 * The environment a local process runs with, or null when it cannot be read.
 * Same user only. macOS returns an empty environment for its own platform
 * binaries (/bin/*); harnesses are not platform binaries.
 */
export async function readProcessEnvironment(pid: number): Promise<Record<string, string> | null> {
  const fn = await loadSysctl();
  if (!fn) return null;
  const buffer = new Uint8Array(PROCARGS_BUFFER_BYTES);
  const size = new BigUint64Array([BigInt(buffer.byteLength)]);
  const rc = fn(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]), 3, buffer, size, null, 0);
  if (rc !== 0) return null;
  return parseProcArgs2(buffer.subarray(0, Number(size[0]))).env;
}

// A stuck lsof or ps must not hold a session open.
const PROBE_TIMEOUT_MS = 3_000;

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

/**
 * The pid that owns the client end of a loopback TCP connection. `lsof`
 * lists both ends of the socket pair; the client end is the one whose
 * local port is the client port (the server end's local port is the
 * listening port), which also holds when both ends are one process.
 */
export function parseLsofPeer(output: string, clientPort: number): number | null {
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) {
      const local = line.slice(1).split("->")[0] ?? "";
      if (local.endsWith(`:${clientPort}`)) return pid;
    }
  }
  return null;
}

export async function findLoopbackPeerPid(clientPort: number): Promise<number | null> {
  return parseLsofPeer(await run(["lsof", "-nP", `-iTCP:${clientPort}`, "-sTCP:ESTABLISHED", "-Fpn"]), clientPort);
}

export async function readProcessCwd(pid: number): Promise<string | null> {
  const out = await run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const line = out.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

async function parentPid(pid: number): Promise<number | null> {
  const out = (await run(["ps", "-o", "ppid=", "-p", String(pid)])).trim();
  const value = Number(out);
  return Number.isFinite(value) && value > 1 ? value : null;
}

async function processName(pid: number): Promise<string> {
  return (await run(["ps", "-o", "comm=", "-p", String(pid)])).trim();
}

type ClaudeSessionFile = { sessionId?: string; cwd?: string; tmux?: string; name?: string; kind?: string };

async function readClaudeSessionFile(pid: number): Promise<ClaudeSessionFile | null> {
  try {
    return JSON.parse(await readFile(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf8")) as ClaudeSessionFile;
  } catch {
    return null;
  }
}

export type PeerIdentity = {
  pid: number;
  /** The harness process the identity came from (the peer or an ancestor). */
  harnessPid: number;
  harness: "claude" | "codex" | "unknown";
  processName: string;
  sessionId: string | null;
  cwd: string | null;
  /** The environment a stdio child of this harness would have seen. */
  env: Record<string, string>;
};

/**
 * Resolve the harness session behind a local process. Claude records each
 * session in `~/.claude/sessions/<pid>.json`; anything else falls back to
 * the process's own environment and directory. Walks a few ancestors in
 * case the connection comes from a helper the harness started.
 */
/** Session ids a process inherited from whoever launched it. They name the launcher, not the process. */
const INHERITED_SESSION_KEYS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "OPENSCOUT_SESSION_ID"];

function withoutInheritedSession(env: Record<string, string>): Record<string, string> {
  const copy = { ...env };
  for (const key of INHERITED_SESSION_KEYS) delete copy[key];
  return copy;
}

function harnessKind(name: string): "claude" | "codex" | null {
  const base = name.split("/").pop() ?? "";
  if (/^claude\b/.test(base)) return "claude";
  if (/^codex\b/.test(base)) return "codex";
  return null;
}

/** Claude writes its pid file during startup, sometimes after it opens MCP connections. */
async function waitForClaudeSessionFile(pid: number, budgetMs = 3000): Promise<ClaudeSessionFile | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const file = await readClaudeSessionFile(pid);
    if (file?.sessionId || Date.now() >= deadline) return file?.sessionId ? file : null;
    await Bun.sleep(100);
  }
}

async function claudeIdentity(pid: number, harnessPid: number, file: ClaudeSessionFile): Promise<PeerIdentity> {
  const env = withoutInheritedSession((await readProcessEnvironment(harnessPid)) ?? {});
  return {
    pid,
    harnessPid,
    harness: "claude",
    processName: await processName(harnessPid),
    sessionId: file.sessionId!,
    cwd: file.cwd ?? env.PWD ?? null,
    env: { ...env, CLAUDE_CODE_SESSION_ID: file.sessionId! },
  };
}

export async function resolvePeerIdentity(pid: number): Promise<PeerIdentity> {
  const name = await processName(pid);
  const kind = harnessKind(name);
  const ownEnv = (await readProcessEnvironment(pid)) ?? {};

  // A harness speaks for itself. Any session id in its environment was
  // inherited from the session that launched it (a Claude started inside
  // another Claude carries the parent's CLAUDE_CODE_SESSION_ID), so only
  // the harness's own records count.
  if (kind === "claude") {
    const file = await waitForClaudeSessionFile(pid);
    if (file) return claudeIdentity(pid, pid, file);
  }
  if (kind) {
    const env = withoutInheritedSession(ownEnv);
    return {
      pid, harnessPid: pid, harness: kind, processName: name,
      // Codex runs several threads in one app-server process, so the thread
      // behind a connection is not in its environment. Open question.
      sessionId: null,
      cwd: (await readProcessCwd(pid)) ?? env.PWD ?? null,
      env,
    };
  }

  // Not a harness: a helper or script. Its own session id (set for it by
  // the harness, as for a stdio child) wins; otherwise the nearest Claude
  // ancestor.
  const ownSessionId = ownEnv.OPENSCOUT_SESSION_ID || ownEnv.CODEX_THREAD_ID || ownEnv.CLAUDE_CODE_SESSION_ID || null;
  if (!ownSessionId) {
    let current = await parentPid(pid);
    for (let depth = 0; current && depth < 4; depth += 1) {
      const file = await readClaudeSessionFile(current);
      if (file?.sessionId) return claudeIdentity(pid, current, file);
      current = await parentPid(current);
    }
  }
  return {
    pid,
    harnessPid: pid,
    harness: ownEnv.CODEX_THREAD_ID ? "codex" : ownEnv.CLAUDE_CODE_SESSION_ID ? "claude" : "unknown",
    processName: name,
    sessionId: ownSessionId,
    cwd: (await readProcessCwd(pid)) ?? ownEnv.PWD ?? null,
    env: ownEnv,
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
