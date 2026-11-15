import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ActorIdentity, AgentEndpoint, NodeDefinition } from "@openscout/protocol";
import { scoutNodeMatchesSessionHost, scoutSessionHostForNode } from "@openscout/protocol";

import type { ExactSessionWakeInput } from "./broker-delivery-routing.js";
import {
  buildCardlessSessionActor,
  buildCardlessSessionEndpoint,
  resolveCardlessSessionSpawnTarget,
  type CardlessSessionRegistry,
} from "./broker-cardless-session.js";
import { compareLocalEndpointPreference, endpointCandidateState } from "./broker-endpoint-selection.js";
import { findLiveClaudeSession } from "./claude-session-records.js";
import { sessionObservationMetadata, type LocalEndpointSessionObservation } from "./session-observation.js";
import { locateHarnessSession } from "./session-locator.js";
import { execSystemFile } from "./system-probes/exec.js";

/**
 * Flat session dispatch, local rung (T3) plus mesh rung (T4).
 *
 * T3: locate the native session in this machine's harness store and register a
 * cardless flat-dispatch endpoint for it (extracted from the broker daemon so
 * the mesh wake route can run the identical wake on behalf of a peer).
 *
 * T4: when the local store misses, ask trusted reachable peers to run their own
 * T3 via `POST /v1/mesh/sessions/wake`; the winning peer returns the endpoint
 * it registered (owned by its node id) so the origin broker can adopt it and
 * dispatch through the existing cross-node forwarding path.
 */

/** Set when the wake continued a live session as a Scout-owned fork instead of resuming it. */
export type ForkedSessionWake = {
  /** The live session the fork branched from (left untouched). */
  sourceSessionId: string;
  /** The fork's own native session id; the reply is delivered here. */
  sessionId: string;
};

export type LocalSessionWakeResult =
  | { ok: true; endpoint: AgentEndpoint; actor?: ActorIdentity; forkedSession?: ForkedSessionWake }
  | { ok: false; reason: string; detail: string; remediation?: string };

export type LocalSessionWakeDeps = {
  nodeId: string;
  registry: CardlessSessionRegistry;
  snapshotEndpoints: () => Record<string, AgentEndpoint>;
  actorFor?: (actorId: string) => ActorIdentity | undefined;
  /** Whether the harness advertises a resume command (findHarnessEntry(h)?.resume). */
  harnessSupportsResume: (harness: string) => boolean;
  locate?: typeof locateHarnessSession;
  observeEndpointSession?: (endpoint: AgentEndpoint) => Promise<LocalEndpointSessionObservation | null>;
  findLiveClaudeSession?: (nativeSessionId: string) => Promise<{ sessionId: string } | null>;
  /**
   * Whether a Codex thread is held open by another writer (its CLI, desktop
   * app, or another app-server). Only consulted when the caller opts into
   * `forkIfLive`; plain exact-session wakes keep the park-until-released path.
   */
  isCodexThreadLive?: (threadId: string) => Promise<boolean>;
  /** Mints the native id for a new fork. Test seam. */
  createForkSessionId?: () => string;
  log?: (message: string) => void;
};

/**
 * Codex enforces one writer per thread with a lock file under
 * `$CODEX_HOME/thread-writer-locks/<thread>.lock`, removed on release. The lock
 * file is live evidence only while a process holds it open; a leftover file
 * with no holder (crash) is stale. Probe failures fail closed (throw).
 */
export async function isCodexThreadHeldByWriter(threadId: string, options: {
  codexHome?: string;
  exists?: (path: string) => boolean;
  holders?: (path: string) => Promise<string[]>;
} = {}): Promise<boolean> {
  const codexHome = options.codexHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  const lockPath = join(codexHome, "thread-writer-locks", `${threadId}.lock`);
  if (!(options.exists ?? existsSync)(lockPath)) return false;
  const holders = await (options.holders ?? lockFileHolders)(lockPath);
  return holders.length > 0;
}

async function lockFileHolders(path: string): Promise<string[]> {
  try {
    const result = await execSystemFile("lsof", ["-t", path], { timeoutMs: 3000, maxStdoutBytes: 4096 });
    return result.stdout.split(/\s+/u).filter(Boolean);
  } catch (error) {
    const failure = error as { exitCode?: number; stdout?: string; stderr?: string };
    // lsof exits 1 with no output when nothing holds the file open.
    if (failure.exitCode === 1 && !failure.stderr?.trim()) return [];
    throw error;
  }
}

/** Stable scout session marker for a native id so re-asks hit the same endpoint. */
export function flatDispatchSessionId(harness: string, nativeSessionId: string): string {
  return `flat-${harness}-${nativeSessionId}`;
}

export async function wakeLocalHarnessSession(
  deps: LocalSessionWakeDeps,
  input: ExactSessionWakeInput,
): Promise<LocalSessionWakeResult> {
  const locate = deps.locate ?? locateHarnessSession;
  const located = locate({
    nativeSessionId: input.nativeSessionId,
    harness: input.harness,
    projectPath: input.projectPath,
  });
  if (!located.ok) {
    return {
      ok: false,
      reason: located.reason,
      detail: located.detail,
      ...(located.remediation ? { remediation: located.remediation } : {}),
    };
  }

  const session = located.session;
  if (!deps.harnessSupportsResume(session.harness)) {
    return {
      ok: false,
      reason: "session_not_resumable",
      detail: `harness "${session.harness}" does not advertise a resume command`,
      remediation: `bring a ${session.harness} worker online first, or use a resumable harness`,
    };
  }

  let spawn: ReturnType<typeof resolveCardlessSessionSpawnTarget>;
  try {
    spawn = resolveCardlessSessionSpawnTarget(session.harness);
  } catch (error) {
    return {
      ok: false,
      reason: "session_not_resumable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const cwd = session.cwd || input.projectPath?.trim();
  if (!cwd) {
    return {
      ok: false,
      reason: "session_not_resumable",
      detail: `session ${session.nativeSessionId} has no cwd; pass --project`,
      remediation: `scout ask --to session:${session.harness}:${session.nativeSessionId} --project <cwd>`,
    };
  }

  const scoutSessionId = flatDispatchSessionId(session.harness, session.nativeSessionId);
  const endpoints = Object.values(deps.snapshotEndpoints()).filter((endpoint) => endpoint.nodeId === deps.nodeId);
  // A tmux endpoint's cached alias is not proof of which Claude process owns
  // its pane. Correlate first so an exact continuation cannot create a second
  // worker merely because the original endpoint lacks its provider id.
  if (session.harness === "claude") {
    try {
      const matches: AgentEndpoint[] = [];
      const physicalOwners = new Set<string>();
      for (const endpoint of endpoints) {
        if (endpoint.transport !== "tmux" || endpoint.harness !== "claude" || endpointCandidateState(endpoint.state) === "offline") continue;
        const observed = await deps.observeEndpointSession?.(endpoint);
        if (observed?.sessionId !== session.nativeSessionId) continue;
        const { pid, tmuxSession, tmuxPane } = observed.evidence;
        // Registry and isolated projections can describe the same live pane.
        // Only concrete process evidence permits collapsing those projections.
        const ownerKey = typeof pid === "number" && Number.isInteger(pid) && pid > 0
          && typeof tmuxSession === "string" && tmuxSession.length > 0
          && typeof tmuxPane === "string" && tmuxPane.length > 0
          ? JSON.stringify([pid, tmuxSession, tmuxPane])
          : `unverified-owner:${endpoint.id}`;
        physicalOwners.add(ownerKey);
        matches.push({ ...endpoint, metadata: { ...endpoint.metadata, ...sessionObservationMetadata(endpoint, observed) } });
      }
      if (physicalOwners.size > 1) {
        return { ok: false, reason: "session_ambiguous", detail: `session ${session.nativeSessionId} has multiple live tmux process owners` };
      }
      matches.sort((left, right) => compareLocalEndpointPreference(left, right) || left.id.localeCompare(right.id));
      if (matches[0]) {
        const endpoint = matches[0];
        await deps.registry.upsertEndpoint(endpoint);
        return { ok: true, endpoint, ...(deps.actorFor?.(endpoint.agentId) ? { actor: deps.actorFor(endpoint.agentId) } : {}) };
      }

    } catch (error) {
      return { ok: false, reason: "session_runtime_unobserved", detail: `cannot verify live ownership of session ${session.nativeSessionId}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const existing = endpoints.find((endpoint) => {
    if (session.harness === "claude" && endpoint.transport === "tmux") return false;
    if (typeof endpoint.metadata?.externalSessionAdoptedAt === "number") return false;
    const aliases = [endpoint.sessionId, endpoint.metadata?.externalSessionId, endpoint.metadata?.threadId, endpoint.metadata?.nativeSessionId]
      .map((value) => typeof value === "string" ? value.trim() : "");
    return aliases.includes(session.nativeSessionId) || endpoint.agentId === scoutSessionId;
  });
  if (existing && existing.state !== "offline" && existing.state !== "failed" && existing.state !== "stopped") {
    return { ok: true, endpoint: existing, ...(deps.actorFor?.(existing.agentId) ? { actor: deps.actorFor(existing.agentId) } : {}) };
  }

  if (session.harness === "claude") {
    try {
      const live = await (deps.findLiveClaudeSession ?? findLiveClaudeSession)(session.nativeSessionId);
      if (live) {
        if (input.forkIfLive) {
          return forkLiveClaudeSession(deps, { sourceSessionId: session.nativeSessionId, cwd, endpoints });
        }
        return { ok: false, reason: "session_live_unbound", detail: `session ${session.nativeSessionId} is already running without a verified Scout endpoint`, remediation: "attach the existing session before retrying its exact continuation" };
      }
    } catch (error) {
      return { ok: false, reason: "session_runtime_unobserved", detail: `cannot verify live ownership of session ${session.nativeSessionId}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // Codex has no fork path here yet (Scout's app-server transport only resumes
  // or starts threads), so a caller that asked for fork-if-live must not get a
  // second writer on a thread the operator still has open.
  if (session.harness === "codex" && input.forkIfLive) {
    try {
      if (await (deps.isCodexThreadLive ?? isCodexThreadHeldByWriter)(session.nativeSessionId)) {
        return {
          ok: false,
          reason: "session_live_fork_unsupported",
          detail: `codex session ${session.nativeSessionId} is open in another Codex app and cannot be forked from Scout yet`,
          remediation: "close the session where it is open, then retry",
        };
      }
    } catch (error) {
      return { ok: false, reason: "session_runtime_unobserved", detail: `cannot verify whether codex session ${session.nativeSessionId} is open elsewhere: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const cardlessInput = {
    sessionId: scoutSessionId,
    handle: scoutSessionId,
    transport: spawn.transport,
    harness: spawn.harness,
    cwd,
    projectRoot: cwd,
    nodeId: deps.nodeId,
    externalSessionId: session.nativeSessionId,
    nativeSessionId: session.nativeSessionId,
    flatDispatch: true,
    displayName: `${basename(cwd)}:${session.nativeSessionId.slice(0, 8)}`,
  };
  try {
    const actor = buildCardlessSessionActor(cardlessInput);
    const endpoint = buildCardlessSessionEndpoint(cardlessInput);
    await deps.registry.upsertActor(actor);
    await deps.registry.upsertEndpoint(endpoint);
    deps.log?.(
      `[openscout-runtime] flat-dispatch wake ${session.harness}:${session.nativeSessionId} via ${spawn.transport} cwd=${cwd}`,
    );
    return { ok: true, endpoint, actor };
  } catch (error) {
    return {
      ok: false,
      reason: "session_wake_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function isTerminalEndpointState(state: AgentEndpoint["state"] | undefined): boolean {
  return state === "offline" || state === "failed" || state === "stopped";
}

/**
 * Continue a Claude session that is live in the operator's terminal as a
 * Scout-owned fork: `claude --resume <source> --fork-session --session-id <fork>`
 * branches the source history into a new session id we mint up front, so the
 * source transcript and its terminal are never written by Scout. Repeat asks
 * while the source stays live reuse the same fork.
 */
async function forkLiveClaudeSession(
  deps: LocalSessionWakeDeps,
  input: { sourceSessionId: string; cwd: string; endpoints: AgentEndpoint[] },
): Promise<LocalSessionWakeResult> {
  const priorForks = input.endpoints
    .filter((endpoint) =>
      endpoint.harness === "claude"
      && endpoint.metadata?.flatDispatch === true
      && endpoint.metadata?.forkedFromSessionId === input.sourceSessionId
      && typeof endpoint.metadata?.nativeSessionId === "string")
    .sort((left, right) => Number(right.metadata?.startedAt ?? 0) - Number(left.metadata?.startedAt ?? 0));
  const prior = priorForks[0];
  const forkSessionId = prior ? String(prior.metadata!.nativeSessionId) : (deps.createForkSessionId ?? randomUUID)();
  const forkedSession = { sourceSessionId: input.sourceSessionId, sessionId: forkSessionId };
  if (prior && !isTerminalEndpointState(prior.state)) {
    return { ok: true, endpoint: prior, forkedSession, ...(deps.actorFor?.(prior.agentId) ? { actor: deps.actorFor(prior.agentId) } : {}) };
  }

  let spawn: ReturnType<typeof resolveCardlessSessionSpawnTarget>;
  try {
    spawn = resolveCardlessSessionSpawnTarget("claude");
  } catch (error) {
    return { ok: false, reason: "session_not_resumable", detail: error instanceof Error ? error.message : String(error) };
  }
  const scoutSessionId = flatDispatchSessionId("claude", forkSessionId);
  const cardlessInput = {
    sessionId: scoutSessionId,
    handle: scoutSessionId,
    transport: spawn.transport,
    harness: spawn.harness,
    cwd: input.cwd,
    projectRoot: input.cwd,
    nodeId: deps.nodeId,
    externalSessionId: forkSessionId,
    nativeSessionId: forkSessionId,
    flatDispatch: true,
    displayName: `${basename(input.cwd)}:${forkSessionId.slice(0, 8)} (fork of ${input.sourceSessionId.slice(0, 8)})`,
  };
  try {
    const actor = buildCardlessSessionActor(cardlessInput);
    const built = buildCardlessSessionEndpoint(cardlessInput);
    const endpoint: AgentEndpoint = {
      ...built,
      metadata: { ...built.metadata, forkedFromSessionId: input.sourceSessionId },
    };
    await deps.registry.upsertActor(actor);
    await deps.registry.upsertEndpoint(endpoint);
    deps.log?.(
      `[openscout-runtime] flat-dispatch fork claude:${input.sourceSessionId} -> ${forkSessionId} (source is live) cwd=${input.cwd}`,
    );
    return { ok: true, endpoint, actor, forkedSession };
  } catch (error) {
    return { ok: false, reason: "session_wake_failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

export type PeerSessionWakeResponse = {
  ok: boolean;
  reason?: string;
  detail?: string;
  remediation?: string;
  endpoint?: AgentEndpoint;
  actor?: ActorIdentity;
};

export type PeerSessionWakeDeps = {
  localNodeId: string;
  /** Candidate peers, already filtered to reachable trusted nodes. */
  peers: NodeDefinition[];
  postJson: <TResponse>(brokerBaseUrl: string, path: string, payload: unknown) => Promise<TResponse>;
  registry: CardlessSessionRegistry;
  log?: (message: string) => void;
};

export type PeerSessionWakeResult =
  | { ok: true; peerNodeId: string; endpoint: AgentEndpoint }
  | { ok: false; peersTried: number };

export const MESH_SESSION_WAKE_PATH = "/v1/mesh/sessions/wake";

/**
 * T4: ask each candidate peer to locate + wake the session in its own harness
 * store. On the first hit, adopt the peer-owned endpoint (and session actor)
 * into the local registry — the same rows mesh agent sync would deliver — so
 * the caller can re-resolve and dispatch through peer forwarding.
 */
export async function wakeSessionOnPeers(
  deps: PeerSessionWakeDeps,
  input: ExactSessionWakeInput,
): Promise<PeerSessionWakeResult> {
  let tried = 0;
  for (const peer of deps.peers) {
    if (!peer.brokerUrl || peer.id === deps.localNodeId) continue;
    tried += 1;
    let response: PeerSessionWakeResponse;
    try {
      response = await deps.postJson<PeerSessionWakeResponse>(peer.brokerUrl, MESH_SESSION_WAKE_PATH, {
        nativeSessionId: input.nativeSessionId,
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      });
    } catch (error) {
      deps.log?.(
        `[openscout-runtime] mesh session wake failed on ${peer.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!response?.ok || !response.endpoint) continue;
    // Endpoint authority stays with the peer: adopt it verbatim, node id and all.
    if (response.endpoint.nodeId !== peer.id) {
      deps.log?.(
        `[openscout-runtime] mesh session wake on ${peer.id} returned endpoint owned by ${response.endpoint.nodeId}; ignoring`,
      );
      continue;
    }
    if (response.actor) {
      await deps.registry.upsertActor(response.actor);
    }
    await deps.registry.upsertEndpoint(response.endpoint);
    deps.log?.(
      `[openscout-runtime] mesh session wake: ${input.nativeSessionId} lives on ${peer.id}; adopted endpoint ${response.endpoint.id}`,
    );
    return { ok: true, peerNodeId: peer.id, endpoint: response.endpoint };
  }
  return { ok: false, peersTried: tried };
}

export const MESH_SESSION_START_PATH = "/v1/mesh/sessions/start";

export type MeshProjectSessionStartInput = {
  projectPath: string;
  harness?: string;
  model?: string;
  reasoningEffort?: string;
  placement?: string;
  requesterId?: string;
};

export type PeerSessionStartResponse = PeerSessionWakeResponse;

export type PeerSessionStartDeps = Omit<PeerSessionWakeDeps, "peers"> & {
  peers: NodeDefinition[];
  /** Project roots of agents homed on a peer, used to try likely owners first. */
  peerProjectRoots: (nodeId: string) => string[];
};

/** Why one peer did not start the session: kept so the asker hears the peer's own words. */
export type PeerSessionStartFailure = {
  peerNodeId: string;
  host: string;
  reason: string;
  detail?: string;
};

export type PeerSessionStartResult =
  | { ok: true; peerNodeId: string; endpoint: AgentEndpoint; actor?: ActorIdentity }
  | { ok: false; peersTried: number; failures: PeerSessionStartFailure[] };

/** What `--on <host>` resolved to among the mesh nodes this broker knows. */
export type MeshHostResolution =
  | { kind: "local" }
  | { kind: "peer"; node: NodeDefinition }
  | { kind: "not_trusted"; node: NodeDefinition }
  | { kind: "unreachable"; node: NodeDefinition }
  | { kind: "unknown"; knownHosts: string[] }
  | { kind: "ambiguous"; nodes: NodeDefinition[] };

/**
 * Resolve the machine an ask names with `--on`. Matching reuses the session
 * address rules (derived label, node id, name, host name), so `archie`,
 * `archie.local` and the full node id all land on the same machine. A name
 * that has multiple equally good matches is `ambiguous`; exact ids and stable
 * qualifiers outrank display-name and normalized hostname aliases.
 */
export function resolveMeshHost(input: {
  host: string;
  localNode?: NodeDefinition;
  nodes: NodeDefinition[];
  trustedNodeIds: ReadonlySet<string>;
  isReachable: (node: NodeDefinition) => boolean;
}): MeshHostResolution {
  const peers = input.nodes.filter((node) => node.id !== input.localNode?.id);
  const all = input.localNode ? [input.localNode, ...peers] : peers;
  // An exact node id names one machine; a label, name or host name can name
  // several, and then the ask is refused rather than landing on whichever
  // matched first (or quietly on this machine).
  const exact = all.filter((node) => node.id === input.host.trim());
  // A stable machine qualifier outranks display-name/hostname aliases. Old
  // mini-local records can advertise "mini" too; they must not shadow the
  // node whose qualifier is exactly "mini". Equal-best matches still refuse.
  const rawHost = (value?: string) => value?.trim().toLowerCase().replace(/\.+$/, "") ?? "";
  const wanted = rawHost(input.host);
  const labelled = all.filter((node) => rawHost(scoutSessionHostForNode(node)) === wanted);
  const named = all.filter((node) => [node.name, node.hostName].some((name) => rawHost(name) === wanted));
  const matches = exact.length ? exact : labelled.length ? labelled : named.length ? named
    : all.filter((node) => scoutNodeMatchesSessionHost(node, input.host));
  if (matches.length > 1) return { kind: "ambiguous", nodes: matches };
  const node = matches[0];
  if (node && node.id === input.localNode?.id) return { kind: "local" };
  if (!node) {
    const knownHosts = [...new Set(peers.map((peer) => scoutSessionHostForNode(peer)).filter(Boolean))].sort();
    return { kind: "unknown", knownHosts };
  }
  if (!input.trustedNodeIds.has(node.id)) return { kind: "not_trusted", node };
  if (!node.brokerUrl || !input.isReachable(node)) return { kind: "unreachable", node };
  return { kind: "peer", node };
}

/**
 * The peers an `--on` ask would be routed to, for checks made before dispatch.
 * Only the node routing picks counts: a stale record that shares the name (an
 * old mini-local advertising "mini") must not refuse an ask the live node can
 * take. An ambiguous name keeps every match; routing refuses it anyway.
 */
export function meshHostDispatchPeers(resolution: MeshHostResolution): NodeDefinition[] {
  switch (resolution.kind) {
    case "peer":
    case "not_trusted":
    case "unreachable":
      return [resolution.node];
    case "ambiguous":
      return resolution.nodes;
    default:
      return [];
  }
}

/**
 * When a project path is not on this node, find the peer that knows a repo of
 * the same folder name, so the error can say exactly which `--on` to add.
 * Only exact last-segment matches count; a guess that might be wrong is worse
 * than the generic hint.
 */
export function suggestHostForProjectPath(
  projectPath: string,
  peers: NodeDefinition[],
  peerProjectRoots: (nodeId: string) => string[],
): { host: string; root: string } | undefined {
  const name = projectPath.replace(/\/+$/, "").split("/").filter(Boolean).pop();
  if (!name || name === "~") return undefined;
  const matches = peers.flatMap((peer) =>
    [...new Set(peerProjectRoots(peer.id))]
      .filter((root) => root.replace(/\/+$/, "").split("/").pop() === name)
      .map((root) => ({ host: scoutSessionHostForNode(peer), root })));
  return matches.length === 1 ? matches[0] : undefined;
}

function sharedPathDepth(left: string, right: string): number {
  const leftParts = left.split("/").filter(Boolean);
  const rightParts = right.split("/").filter(Boolean);
  let depth = 0;
  while (depth < leftParts.length && depth < rightParts.length && leftParts[depth] === rightParts[depth]) {
    depth += 1;
  }
  return depth;
}

/**
 * Order peers by how closely their known project roots match the requested
 * path, so `/Users/arach/dev/x` goes to the machine whose agents live under
 * `/Users/arach` before any other peer is asked.
 */
export function rankPeersForProjectPath(
  peers: NodeDefinition[],
  projectPath: string,
  peerProjectRoots: (nodeId: string) => string[],
): NodeDefinition[] {
  const scored = peers.map((peer) => ({
    peer,
    depth: Math.max(0, ...peerProjectRoots(peer.id).map((root) => sharedPathDepth(projectPath, root))),
  }));
  return scored
    .sort((left, right) => right.depth - left.depth || left.peer.id.localeCompare(right.peer.id))
    .map((entry) => entry.peer);
}

/**
 * New-session twin of T4: the project path does not exist on this machine, so
 * ask trusted reachable peers to start a cardless session there. The first
 * peer that owns the path registers the session under its own node id; the
 * origin adopts that endpoint and dispatches through peer forwarding, exactly
 * as it does for a woken session.
 */
export async function startSessionOnPeers(
  deps: PeerSessionStartDeps,
  input: MeshProjectSessionStartInput,
): Promise<PeerSessionStartResult> {
  let tried = 0;
  const failures: PeerSessionStartFailure[] = [];
  const fail = (peer: NodeDefinition, reason: string, detail?: string) => {
    failures.push({ peerNodeId: peer.id, host: scoutSessionHostForNode(peer), reason, ...(detail ? { detail } : {}) });
  };
  const peers = rankPeersForProjectPath(
    deps.peers.filter((peer) => peer.brokerUrl && peer.id !== deps.localNodeId),
    input.projectPath,
    deps.peerProjectRoots,
  );
  for (const peer of peers) {
    tried += 1;
    let response: PeerSessionStartResponse;
    try {
      response = await deps.postJson<PeerSessionStartResponse>(peer.brokerUrl!, MESH_SESSION_START_PATH, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`[openscout-runtime] mesh session start failed on ${peer.id}: ${message}`);
      fail(peer, "peer_unreachable", message);
      continue;
    }
    if (!response?.ok || !response.endpoint) {
      fail(peer, response?.reason || "start_failed", response?.detail);
      continue;
    }
    if (response.endpoint.nodeId !== peer.id) {
      fail(peer, "endpoint_owner_mismatch", `returned an endpoint owned by ${response.endpoint.nodeId}`);
      deps.log?.(
        `[openscout-runtime] mesh session start on ${peer.id} returned endpoint owned by ${response.endpoint.nodeId}; ignoring`,
      );
      continue;
    }
    if (response.actor) {
      await deps.registry.upsertActor(response.actor);
    }
    await deps.registry.upsertEndpoint(response.endpoint);
    deps.log?.(
      `[openscout-runtime] mesh session start: ${input.projectPath} lives on ${peer.id}; adopted endpoint ${response.endpoint.id}`,
    );
    return { ok: true, peerNodeId: peer.id, endpoint: response.endpoint, ...(response.actor ? { actor: response.actor } : {}) };
  }
  return { ok: false, peersTried: tried, failures };
}
