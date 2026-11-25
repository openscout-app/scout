import { findHarnessEntry } from "../harness-catalog.js";
import { findLiveClaudeSession } from "../claude-session-records.js";
import { locateHarnessSession } from "../session-locator.js";
import {
  CODEX_APP_LOCATION, codexActivity, codexThreadHeldByChatGPTApp,
  findCodexTranscript, probeSessionInputHosts, type InPlaceActivity, type InPlaceReadDeps,
} from "./deliver.js";
import { latticesReachable } from "./lattices-composer.js";

export type SessionInputActivity = "idle" | "busy" | "waiting" | "unknown";
export type SessionInputProvenance = "observed" | "inferred" | "unobserved";
export type SessionInputAlternative = "draft" | "live_host" | "gui_app" | "resume";
type DirectVia = "runtime" | "codex-daemon";
type HostVia = "herdr" | "orca" | "tmux" | "terminal";

export type SessionInputRoute = {
  location: string | null;
  provenance: SessionInputProvenance;
  activity: SessionInputActivity;
  /** Whether this transport can accept input during an active turn. */
  canSteerWhileBusy: boolean;
  /** Whether this route's owner accepts queued input, not just a steering message. */
  canQueue: boolean;
  alternatives: readonly SessionInputAlternative[];
  label: string;
  reason: string;
} & (
  | { kind: "answer_gate"; via: "permission" | "question" | "harness" }
  | { kind: "live_direct"; via: DirectVia | "claude-channel" }
  | { kind: "live_host"; via: HostVia }
  | { kind: "gui_app"; via: "lattices" | "codex-app" }
  | { kind: "resume"; via: "harness" }
  | { kind: "handoff_only"; via: null }
);

export type SessionInputRouteInput = {
  /** The native session ID, not an agent name or Scout card ID. */
  sessionId: string;
  harness: string;
};

type DirectInput = {
  location: string;
  activity: SessionInputActivity;
  canSteerWhileBusy?: boolean;
  canQueue?: boolean;
};

export type InspectSessionInputRouteDeps = InPlaceReadDeps & {
  /** Host-owned reads, bound to the exact native session and harness. Null means absent; throw if the read failed. */
  readAnswerGate?: (input: SessionInputRouteInput) => Promise<{ kind: "permission" | "question"; location: string } | null>;
  /** The transport owner supplies this evidence; an endpoint alias or a reachable daemon alone is not a live route. */
  readDirectInput?: (input: SessionInputRouteInput, via: DirectVia) => Promise<DirectInput | null>;
  /** Optional exact-session lifecycle evidence, e.g. from another harness's session store. */
  readSessionState?: (input: SessionInputRouteInput) => Promise<"stopped" | "live" | "unknown">;
  /** Future desktop/window observers provide evidence only; they never focus or open anything. */
  readCodexDesktop?: (input: SessionInputRouteInput) => Promise<{ location: string; activity: SessionInputActivity } | null>;
  /** Status only: the inspector cannot call computer actions. */
  latticesCall?: NonNullable<Parameters<typeof latticesReachable>[0]>;
};

function route<T extends Pick<SessionInputRoute, "kind" | "via">>(
  choice: T, label: string, reason: string,
  details: Partial<Omit<SessionInputRoute, "kind" | "via" | "label" | "reason">> = {},
) {
  return {
    location: null, provenance: "observed" as SessionInputProvenance, activity: "unknown" as SessionInputActivity,
    canSteerWhileBusy: false, canQueue: false, alternatives: [] as readonly SessionInputAlternative[],
    ...details, ...choice, label, reason,
  };
}

function handoff(reason: string, observed = false): SessionInputRoute {
  return route({ kind: "handoff_only", via: null }, "Hand off manually", reason,
    { provenance: observed ? "observed" : "unobserved" });
}

function answerGate(via: "permission" | "question" | "harness", location: string): SessionInputRoute {
  return route({ kind: "answer_gate", via }, "Answer the session first",
    "The session is waiting on a permission decision or question.", { location, activity: "waiting" });
}

/**
 * Inspect the current input options. This does not reserve a route, start a
 * transport, or submit anything. Actuators must recheck before sending.
 */
export async function inspectSessionInputRoute(
  input: SessionInputRouteInput,
  deps: InspectSessionInputRouteDeps = {},
): Promise<SessionInputRoute> {
  const harness = input.harness?.trim().toLowerCase();
  const target = { sessionId: input.sessionId, harness };
  if (!harness || !target.sessionId?.trim() || /[\x00-\x1f]/u.test(target.sessionId)) {
    return handoff("Choose an exact native session ID and harness.");
  }

  try {
    const gate = await deps.readAnswerGate?.(target);
    if (gate) return answerGate(gate.kind, gate.location);
    if (deps.ownSessionIds?.includes(target.sessionId)) return handoff("The caller's own session is not an input target.", true);

    let direct: (DirectInput & { via: DirectVia }) | undefined;
    const directOrder: DirectVia[] = harness === "codex" ? ["runtime", "codex-daemon"] : ["runtime"];
    for (const via of directOrder) {
      const observation = await deps.readDirectInput?.(target, via);
      if (!observation) continue;
      if (observation.activity === "waiting") return answerGate("harness", observation.location);
      direct ??= { ...observation, via };
    }

    const places = await probeSessionInputHosts(target, deps);
    if (places.ok && places.blocked) return answerGate("harness", places.blocked.location);
    if (!places.ok && places.code === "session_ambiguous") return handoff("More than one surface claims this session. Verify where it is open.");
    if (!places.ok && !direct) return handoff("Could not verify the session's live harness and surface.");

    const desktop = harness === "codex"
      ? await deps.readCodexDesktop?.(target)
        ?? (await (deps.codexHeldByApp ?? codexThreadHeldByChatGPTApp)(target.sessionId)
          ? { location: CODEX_APP_LOCATION, activity: await (deps.codexActivity ?? codexActivity)(target.sessionId).catch(() => "unknown" as const) }
          : null)
      : null;
    if (desktop?.activity === "waiting") return answerGate("harness", desktop.location);

    const desktopReachable = desktop !== null && await latticesReachable(deps.latticesCall);
    const alternatives: SessionInputAlternative[] = desktopReachable ? ["gui_app", "draft"] : desktop ? ["draft"] : [];
    const host = places.ok ? places.host : null;
    const channel = places.ok ? places.channel : null;
    const transport = direct ?? (channel && { via: "claude-channel" as const, location: channel.location,
      activity: routeActivity(channel.activity), canSteerWhileBusy: true, canQueue: false });
    if (transport) {
      if (host) alternatives.unshift("live_host");
      return route({ kind: "live_direct", via: transport.via }, "Reply directly",
        "A live transport accepts input for this exact session without typing into a composer.", {
          location: transport.location, activity: transport.activity,
          canSteerWhileBusy: transport.canSteerWhileBusy === true, canQueue: transport.canQueue === true,
          alternatives,
        });
    }
    if (host) {
      const via: HostVia = host.via === "herdr" || host.via === "orca" || host.via === "tmux" ? host.via : "terminal";
      return route({ kind: "live_host", via }, "Reply in the live session",
        host.activity === "composing" ? "The composer contains unsent text." : "The session has a live host. Sending requires a fresh composer check.", {
          location: host.location,
          activity: routeActivity(host.activity),
          alternatives,
        });
    }
    if (desktop) {
      return route({ kind: "gui_app", via: desktopReachable ? "lattices" : "codex-app" }, desktopReachable ? "Reply in Codex" : "Draft in Codex",
        desktopReachable ? "The desktop app holds this thread. Lattices can check the composer before sending."
          : "The desktop app holds this thread, but guarded submission is unavailable.", {
          location: desktop.location, activity: desktop.activity, alternatives: ["draft"],
        });
    }
    if (places.ok && places.held) return handoff("The session is running, but no verified input surface is reachable.", true);

    const state = await deps.readSessionState?.(target) ?? await readLocalSessionState(target, deps);
    if (state === "live") return handoff("The session is running, but no verified input surface is reachable.", true);
    if (state !== "stopped") return handoff("No live surface or stopped session could be verified.");

    const entry = findHarnessEntry(harness);
    const resume = entry?.resume ? entry : null;
    if (harness === "codex" && await latticesReachable(deps.latticesCall)) {
      const activity = await (deps.codexActivity ?? codexActivity)(target.sessionId).catch(() => "unknown" as const);
      return route({ kind: "gui_app", via: "lattices" }, "Open and reply in Codex",
        "The stopped thread can be opened by ID. Sending requires a fresh idle and composer check.", {
          location: CODEX_APP_LOCATION, provenance: "inferred", activity, alternatives: resume ? ["resume"] : [],
        });
    }
    if (resume) return route({ kind: "resume", via: "harness" }, `Resume in ${resume.label}`,
      "The harness supports resuming this stopped session by ID.", { provenance: "inferred" });
    return handoff("This harness does not expose a native resume route for the stopped session.", true);
  } catch {
    return handoff("Could not verify the session's input route. Check where it is open.");
  }
}

function routeActivity(activity: InPlaceActivity): SessionInputActivity {
  return activity === "composing" ? "busy" : activity === "blocked" ? "waiting" : activity;
}

async function readLocalSessionState(input: SessionInputRouteInput, deps: InPlaceReadDeps): Promise<"stopped" | "live" | "unknown"> {
  if (input.harness === "codex") {
    return await (deps.findCodexTranscript ?? findCodexTranscript)(input.sessionId) ? "stopped" : "unknown";
  }
  if (input.harness === "claude") {
    // The surface search excludes Scout's own managed copies; those still
    // count as live ownership and must not be offered a competing resume.
    if (await (deps.findClaudeRecord ?? findLiveClaudeSession)(input.sessionId)) return "live";
    return locateHarnessSession({ nativeSessionId: input.sessionId, harness: input.harness }).ok ? "stopped" : "unknown";
  }
  return "unknown";
}
