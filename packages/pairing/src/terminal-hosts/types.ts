import type {
  TerminalSurface,
  TerminalSurfaceState,
} from "@openscout/protocol";

/**
 * Verbs a terminal surface can be asked to perform.
 *
 * `force-quit-bridge` is a Scout-side concept — it tears down the relay bridge,
 * not anything on the host — so every host supports it and no adapter
 * implements it.
 */
export type TerminalHostControlAction =
  | "interrupt"
  | "quit"
  | "stop-job"
  | "restart-resume"
  | "detach"
  | "release"
  | "force-quit"
  | "force-quit-bridge";

/**
 * What a host can actually do, declared rather than discovered by watching a
 * route return 400. Clients render supported actions only, which is how the
 * dead-end buttons disappear without special-casing a backend name.
 *
 * A capability is a property of the host, not of this machine: `attach: true`
 * means "this kind of host can be attached to", while whether the binary is
 * installed is {@link TerminalHostAvailability}. Keeping them apart is what
 * lets an adapter ship for a host nobody has installed yet.
 */
export type TerminalHostCapabilities = {
  /** The host supports attaching a client to a live session at all. */
  attach: boolean;
  /**
   * Scout's own terminal relay can materialize this host inside a tile. This is
   * narrower than {@link attach}: the relay is vendored from Hudson and only
   * knows pty/tmux/zellij, so a host can be perfectly attachable in a real
   * terminal and still not renderable in a browser. Saying so is what keeps the
   * UI from offering a tile that cannot connect.
   */
  relayAttach: boolean;
  /** Scout can open a read-only view of a surface. */
  observe: boolean;
  /** Scout can write input into a surface without a relay attached. */
  sendInput: boolean;
  /** Scout can read rendered output back out of a surface. */
  capture: boolean;
  /** Scout can materialize a host session headlessly, with no terminal attached. */
  create: boolean;
  /** Scout can enumerate the host's sessions. */
  list: boolean;
  /** The host reports agent state instead of Scout inferring it from a rendered frame. */
  observedAgentState: boolean;
  /** Verbs the host itself performs. */
  control: readonly TerminalHostControlAction[];
  /**
   * Verbs that need harness-aware process surgery layered over the host
   * (walking the process tree, reading a Claude transcript). These are not
   * host features; they are Scout features that currently only work over one
   * host, and saying so is more honest than folding them into `control`.
   */
  harnessControl: readonly TerminalHostControlAction[];
};

/** Whether this machine can actually reach the host right now. */
export type TerminalHostAvailability = {
  installed: boolean;
  /** Version string when the host reports one cheaply. */
  version?: string | null;
  /** Operator-facing reason the host is unusable, when it is. */
  reason?: string | null;
  /**
   * True when this reading came from cache after the CURRENT check failed.
   * A stale `installed: true` is a memory, not an observation: it exists so a
   * momentarily busy machine does not look like a machine with no terminal
   * hosts, and any caller about to actually shell out should re-probe rather
   * than act on it.
   */
  stale?: boolean;
  /** When the reading it reports was actually taken. */
  checkedAt?: number;
};

export type TerminalHostSession = {
  name: string;
  state: TerminalSurfaceState;
  attachedClients?: number | null;
  cwd?: string | null;
  currentCommand?: string | null;
  /**
   * The active window's name, when the host has windows. Under tmux's
   * automatic-rename it follows {@link currentCommand}.
   */
  windowName?: string | null;
  /**
   * The active pane's title, as a harness or person set it. Null when nobody
   * did: a host's default title (tmux uses the host name) is not reported.
   */
  paneTitle?: string | null;
  paneId?: string | null;
  /** Anything host-specific worth surfacing. Must not carry socket paths. */
  metadata?: Record<string, unknown>;
};

export type TerminalHostContext = {
  env?: NodeJS.ProcessEnv;
};

export type TerminalHostControlResult = {
  delivered: boolean;
  /** Why not, when `delivered` is false and the reason is known. */
  reason?: string | null;
};

export type TerminalHostCreateInput = {
  sessionName: string;
  cwd?: string | null;
  /**
   * Command to run as the new session's first process — a saved cell's harness
   * resume command, when it has one. A host that cannot start a session with a
   * command must ignore this and report `resumed: false` rather than create an
   * empty shell and let the caller assume the harness came back.
   */
  resumeCommand?: string | null;
};

export type TerminalHostCreateResult = {
  created: boolean;
  /**
   * Whether {@link TerminalHostCreateInput.resumeCommand} actually ran in the
   * new session. Null when none was asked for. The distinction is the whole
   * point: "the tile is back" and "an empty shell is back where your agent used
   * to be" are different answers and an operator is owed the right one.
   */
  resumed?: boolean | null;
  /** Why not, when something did not happen and the reason is known. */
  reason?: string | null;
};

/**
 * One terminal host, behind one interface.
 *
 * Adapters sit ABOVE `terminal-relay-session.ts`, which is vendored from Hudson
 * under a sync fence and holds most of the repo's per-backend branching. Per
 * SCO-076 Hudson owns the reusable terminal primitive; Scout owns the registry
 * and the routing over it. Nothing here may edit or require editing a vendored
 * file.
 */
export type TerminalHostAdapter = {
  /** Stable host id. Matches `TerminalSurface.backend` for hosts the protocol names. */
  readonly id: string;
  /** Short operator-facing name. */
  readonly label: string;
  /**
   * What the host gives you, in the property that matters rather than the tool
   * identity — the phrasing macOS's backend picker already uses, and the reason
   * an operator who does not know tmux never has to learn it.
   */
  readonly description: string;
  readonly capabilities: TerminalHostCapabilities;

  probe(context?: TerminalHostContext): Promise<TerminalHostAvailability>;
  list(context?: TerminalHostContext): Promise<TerminalHostSession[]>;
  /** Build the durable surface descriptor for one of this host's sessions. */
  surface(session: TerminalHostSession, context?: TerminalHostContext): TerminalSurface;
  /** Present only when {@link TerminalHostCapabilities.create} is true. */
  create?(
    input: TerminalHostCreateInput,
    context?: TerminalHostContext,
  ): Promise<TerminalHostCreateResult>;
  /** Present only when {@link TerminalHostCapabilities.control} is non-empty. */
  control?(
    action: TerminalHostControlAction,
    target: { sessionName: string; paneId?: string | null },
    context?: TerminalHostContext,
  ): Promise<TerminalHostControlResult>;
  /** Present only when {@link TerminalHostCapabilities.capture} is true. */
  capture?(
    target: { sessionName: string; paneId?: string | null; lines?: number },
    context?: TerminalHostContext,
  ): Promise<string | null>;
  /** Present only when {@link TerminalHostCapabilities.observedAgentState} is true. */
  observedAgents?(
    target: { sessionName: string },
    context?: TerminalHostContext,
  ): Promise<Array<{ target: string; name: string | null; status: "idle" | "working" | "blocked" | "done" | "unknown" }>>;
};
