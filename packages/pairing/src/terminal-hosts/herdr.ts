import { spawn } from "node:child_process";

import {
  buildHerdrAttachCommand,
  buildHerdrStartServerCommand,
  buildHerdrWorkspaceCreateCommand,
  execSystemFile,
  herdrSessionsProbe,
  invalidateHerdrSessions,
  parseHerdrAgentList,
  readHerdrSessions,
  readHerdrTopology,
} from "@openscout/runtime/system-probes";
import { formatTerminalSurfaceId } from "@openscout/protocol";
import type { HerdrSessionTopology, TerminalSurface } from "@openscout/protocol";

import { errorReason, probeCommand } from "./tmux.ts";
import { readHerdrLastKnownState, type HerdrLastKnownState } from "./herdr-session-state.ts";
import type {
  TerminalHostAdapter,
  TerminalHostSession,
} from "./types.ts";
import { buildUserSpawnEnvironment } from "@openscout/runtime/instance";

const HERDR_TIMEOUT_MS = 2_000;

export const herdrTerminalHost: TerminalHostAdapter = {
  id: "herdr",
  label: "Herdr",
  description: "Persistent agent workspace that survives closing this window",
  capabilities: {
    attach: true,
    // The relay spawns the full Herdr client (`herdr --session <name>`) in its
    // PTY; detaching the relay closes that client only, the Herdr server and
    // panes keep running. Proven live against the vendored relay build.
    relayAttach: true,
    // Herdr has no read-only attach; `agent read` is a capture, not a view.
    observe: false,
    sendInput: true,
    capture: true,
    // `herdr --session <name> server` brings a named session into existence
    // with no terminal attached, and `workspace create` gives it a first
    // workspace. Scout creates the SESSION and stops there: herdr already owns
    // workspaces, tabs, and panes, and Scout's layer is coordination over
    // whatever host is present, not a second layout manager.
    create: true,
    list: true,
    // The whole reason to prefer herdr: `herdr agent wait --status` answers the
    // question tmux delivery verification infers from rendered TUI frames.
    observedAgentState: true,
    // Only the Scout-side verb. herdr has no detach: `herdr session` is
    // list/attach/stop/delete, and the `herdr agent focus` this once called
    // FOCUSES an agent pane — the opposite action, against a target type
    // (terminal ids, agent names, pane ids) that a session name is not, with
    // the `--session` scoping every other verb here passes dropped, so it
    // addressed the default session whatever session the surface belonged to.
    // A herdr session outliving Scout is still true; it is just not something
    // Scout performs, so it is not a capability.
    control: ["force-quit-bridge"],
    harnessControl: [],
  },

  async probe(context = {}) {
    return probeCommand("herdr", ["--version"], context);
  },

  async list(context = {}) {
    const snapshot = await herdrSessionsProbe.for({ env: context.env ?? process.env }).fresh();
    return Promise.all((snapshot.value ?? []).map(async (session): Promise<TerminalHostSession> => {
      // A herdr session that is not running still exists and still reattaches;
      // it is detached, not exited. Its persisted layout is the only honest
      // answer to "what was in it" while the server is down.
      const lastKnown = !session.running && session.sessionDir
        ? await readHerdrLastKnownState(session.sessionDir)
        : null;
      const topology = session.running ? await readHerdrTopology(session.name, { env: context.env }) : null;
      const liveCwd = topology?.running
        ? topology.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes))
          .map((pane) => pane.foregroundCwd ?? pane.cwd).find(Boolean)
        : null;
      const cwd = liveCwd ?? lastKnown?.cwds[0];
      return {
        name: session.name,
        state: session.running ? "live" : "detached",
        // Counted on this host from its process table; absent when unread.
        ...(topology?.clients !== undefined ? { attachedClients: topology.clients } : {}),
        // The last-known pane cwd stands in for a live one: a stopped session
        // has no current directory, but "where was this" is what the row needs.
        ...(cwd ? { cwd } : {}),
        metadata: {
          isDefault: session.isDefault,
          running: session.running,
          ...(lastKnown ? { lastKnownLayout: lastKnown } : {}),
          ...(topology?.apps ? { apps: topology.apps } : {}),
        },
      };
    }));
  },

  surface(session): TerminalSurface {
    const isDefault = session.metadata?.isDefault === true || session.name === "default";
    return {
      surfaceId: formatTerminalSurfaceId({ backend: "herdr", hostSession: session.name }),
      backend: "herdr",
      sessionName: session.name,
      paneId: session.paneId ?? null,
      attachCommand: buildHerdrAttachCommand({ name: session.name, isDefault }),
      observeCommand: null,
      relay: { backend: "herdr", sessionName: session.name },
      state: session.state,
    };
  },

  async create(input, context = {}) {
    const sessionName = input.sessionName.trim();
    if (!sessionName || sessionName === "default") {
      return { created: false, reason: "the default herdr session is not Scout's to create" };
    }
    const env = context.env ?? process.env;
    try {
      // Starting a stopped session brings back the layout it saved, so it only
      // needs a first workspace when there is nothing to restore; seeding one
      // anyway left a stray "Scout" workspace behind on every restart.
      const existing = (await readHerdrSessions({ env, maxAgeMs: 0 }))
        .find((session) => session.name === sessionName);
      const lastKnown = existing?.sessionDir ? await readHerdrLastKnownState(existing.sessionDir) : null;
      // The session server runs for as long as the session does, so it is
      // spawned detached rather than awaited: awaiting it would hang until the
      // operator stopped the session.
      const [serverBin, ...serverArgs] = buildHerdrStartServerCommand(sessionName);
      // The session server's env is every pane's env: a user-facing spawn.
      const spawnFailure = await spawnDetachedHerdrServer(
        serverBin!,
        serverArgs,
        buildUserSpawnEnvironment(env) as NodeJS.ProcessEnv,
      );
      if (spawnFailure) {
        return {
          created: false,
          reason: errorReason(spawnFailure) ?? `${serverBin} could not be started`,
        };
      }
      await waitForHerdrSession(sessionName, env);
      if (herdrSessionNeedsFirstWorkspace(lastKnown)) {
        const [, ...workspaceArgs] = buildHerdrWorkspaceCreateCommand(sessionName, {
          cwd: input.cwd,
          label: "Scout",
        });
        await execSystemFile("herdr", workspaceArgs, { timeoutMs: 5_000, env });
      }
      // Scout creates the herdr SESSION and its first workspace and stops
      // there; herdr owns what runs inside. `herdr agent start` could launch a
      // harness, but nothing here knows enough to claim it resumed the saved
      // one, so the caller is told the session came back without it.
      return {
        created: true,
        resumed: input.resumeCommand?.trim() ? false : null,
        ...(input.resumeCommand?.trim()
          ? { reason: "Scout creates the herdr session; the harness inside it was not resumed" }
          : {}),
      };
    } catch (error) {
      return { created: false, reason: errorReason(error) };
    }
  },

  async capture(target, context = {}) {
    try {
      // Session names scope the command; agent read requires a pane target.
      const paneId = target.paneId ?? herdrPreviewPane(
        await readHerdrTopology(target.sessionName, { env: context.env }),
      );
      if (!paneId) return null;
      const { stdout } = await execSystemFile("herdr", [
        "--session",
        target.sessionName,
        "agent",
        "read",
        paneId,
        "--source",
        "visible",
        "--format",
        "text",
      ], { timeoutMs: HERDR_TIMEOUT_MS, env: context.env, maxStdoutBytes: 1024 * 1024 });
      return unwrapHerdrPaneRead(stdout);
    } catch {
      return null;
    }
  },

  async observedAgents(target, context = {}) {
    try {
      const { stdout } = await execSystemFile("herdr", ["--session", target.sessionName, "agent", "list"], {
        timeoutMs: HERDR_TIMEOUT_MS,
        env: context.env,
        maxStdoutBytes: 256 * 1024,
      });
      return parseHerdrAgentList(stdout);
    } catch {
      // The session's herdr server is not running. That is an ordinary state,
      // not a failure: report no observed agents and let the caller fall back.
      return [];
    }
  },
};

export function herdrPreviewPane(topology: HerdrSessionTopology): string | null {
  if (!topology.running) return null;
  const workspace = topology.workspaces.find((entry) => entry.focused) ?? topology.workspaces[0];
  const tab = workspace?.tabs.find((entry) => entry.focused) ?? workspace?.tabs[0];
  const pane = tab?.panes.find((entry) => entry.focused) ?? tab?.panes[0];
  return pane?.paneId ?? null;
}

/**
 * `agent read --format text` still answers in the CLI's JSON envelope
 * (`{id, result:{read:{text}}}`); the pane's captured text is inside. Peel it
 * when the envelope is present, pass anything else through untouched.
 */
export function unwrapHerdrPaneRead(output: string): string {
  try {
    const parsed = JSON.parse(output.trim()) as unknown;
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      const result = (parsed as { result?: unknown }).result;
      const text = result && typeof result === "object" && "read" in result
        ? (result as { read?: { text?: unknown } }).read?.text
        : null;
      if (typeof text === "string") return text;
    }
  } catch {
    // Not JSON — already plain text.
  }
  return output;
}

/**
 * A herdr session server outlives this request by design, so it is spawned
 * detached and unref'd. `execSystemFile` would wait for it to exit.
 *
 * Resolves with the spawn failure, or null once the child is running.
 *
 * The await is not incidental. `spawn()` does not throw when the binary is
 * missing: it reports ENOENT asynchronously through the child's `error` event,
 * and an EventEmitter `error` with no listener is re-thrown on the event loop,
 * where no `try`/`catch` around this call can reach it. With herdr uninstalled
 * — or uninstalled between the availability probe and this call, which is
 * exactly the race a 30-second availability cache makes possible — that took
 * the whole web process down. Node and Bun both guarantee exactly one of
 * `spawn` or `error` fires, so waiting for whichever it is costs one tick on
 * the happy path and turns a crash into `{created: false}` with a reason.
 */
function spawnDetachedHerdrServer(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Error | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, detached: true, stdio: "ignore" });
    } catch (error) {
      resolve(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // Stays attached after it resolves: a later `error` on a child nothing is
    // listening to is the same crash, just further away.
    child.once("error", (error: Error) => resolve(error));
    child.once("spawn", () => {
      child.unref();
      resolve(null);
    });
  });
}

/** Wait for the new session to appear before driving it. */
/** A session with a saved layout restores its own workspaces; only an empty one needs a first. */
export function herdrSessionNeedsFirstWorkspace(lastKnown: HerdrLastKnownState | null): boolean {
  return !lastKnown || lastKnown.workspaces === 0;
}

async function waitForHerdrSession(sessionName: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    invalidateHerdrSessions({ env, reason: "herdr.create" });
    const sessions = await readHerdrSessions({ env, maxAgeMs: 0 });
    if (sessions.some((session) => session.name === sessionName)) return;
  }
  throw new Error(`herdr session ${sessionName} did not start`);
}
