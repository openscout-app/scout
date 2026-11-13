import { describe, expect, test } from "bun:test";

import type { ActorIdentity, AgentEndpoint, NodeDefinition } from "@openscout/protocol";

import {
  MESH_SESSION_START_PATH,
  MESH_SESSION_WAKE_PATH,
  rankPeersForProjectPath,
  resolveMeshHost,
  meshHostDispatchPeers,
  suggestHostForProjectPath,
  startSessionOnPeers,
  flatDispatchSessionId,
  isCodexThreadHeldByWriter,
  wakeLocalHarnessSession,
  wakeSessionOnPeers,
  type LocalSessionWakeDeps,
  type PeerSessionWakeResponse,
} from "./broker-session-wake.js";
import type { SessionLocateResult } from "./session-locator.js";

const NATIVE_SESSION_ID = "4fad8bb9-b4d3-4432-be75-8cfd636e78c0";

function locatedSession(): SessionLocateResult {
  return {
    ok: true,
    session: {
      harness: "claude",
      nativeSessionId: NATIVE_SESSION_ID,
      cwd: "/Users/art/dev/openscout",
      path: `/Users/art/.claude/projects/-Users-art-dev-openscout/${NATIVE_SESSION_ID}.jsonl`,
      lastActivityAt: 100,
      match: "filename",
    },
  };
}

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: flatDispatchSessionId("claude", NATIVE_SESSION_ID),
    nodeId: "node-local",
    harness: "claude",
    transport: "claude_stream_json",
    state: "idle",
    sessionId: NATIVE_SESSION_ID,
    metadata: { cardless: true },
    ...input,
  } as AgentEndpoint;
}

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "mesh-1",
    name: "Peer",
    advertiseScope: "mesh",
    registeredAt: 100,
    brokerUrl: "http://peer.example:43110",
    ...input,
  };
}

function createLocalDeps(input: {
  locate?: SessionLocateResult;
  endpoints?: Record<string, AgentEndpoint>;
  resumable?: boolean;
} = {}) {
  const upsertedActors: ActorIdentity[] = [];
  const upsertedEndpoints: AgentEndpoint[] = [];
  const deps: LocalSessionWakeDeps = {
    nodeId: "node-local",
    registry: {
      async upsertActor(actor) {
        upsertedActors.push(actor);
      },
      async upsertEndpoint(nextEndpoint) {
        upsertedEndpoints.push(nextEndpoint);
      },
    },
    snapshotEndpoints: () => input.endpoints ?? {},
    harnessSupportsResume: () => input.resumable ?? true,
    locate: () => input.locate ?? locatedSession(),
    findLiveClaudeSession: async () => null,
  };
  return { deps, upsertedActors, upsertedEndpoints };
}

describe("wakeLocalHarnessSession", () => {
  test("passes locate misses through untouched", async () => {
    const { deps, upsertedEndpoints } = createLocalDeps({
      locate: {
        ok: false,
        reason: "session_unknown",
        detail: "no harness session store entry",
        remediation: "check the id",
      },
    });

    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    expect(result).toEqual({
      ok: false,
      reason: "session_unknown",
      detail: "no harness session store entry",
      remediation: "check the id",
    });
    expect(upsertedEndpoints).toEqual([]);
  });

  test("refuses harnesses without a resume command", async () => {
    const { deps } = createLocalDeps({ resumable: false });

    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: "session_not_resumable",
    }));
  });

  test("registers a cardless flat-dispatch endpoint for a located session", async () => {
    const { deps, upsertedActors, upsertedEndpoints } = createLocalDeps();

    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    if (!result.ok) {
      throw new Error(`expected ok result, got ${result.reason}: ${result.detail}`);
    }
    expect(result.endpoint.nodeId).toBe("node-local");
    expect(result.endpoint.agentId).toBe(flatDispatchSessionId("claude", NATIVE_SESSION_ID));
    expect(result.endpoint.metadata?.nativeSessionId).toBe(NATIVE_SESSION_ID);
    expect(result.actor?.id).toBe(flatDispatchSessionId("claude", NATIVE_SESSION_ID));
    expect(upsertedActors).toHaveLength(1);
    expect(upsertedEndpoints).toHaveLength(1);
  });

  test("reuses a live endpoint already registered for the session", async () => {
    const existing = endpoint({ id: "endpoint-existing", state: "active" });
    const { deps, upsertedEndpoints } = createLocalDeps({
      endpoints: { [existing.id]: existing },
    });

    deps.findLiveClaudeSession = async () => ({ sessionId: NATIVE_SESSION_ID });
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    expect(result).toEqual({ ok: true, endpoint: existing });
    expect(upsertedEndpoints).toEqual([]);
  });

  test("correlates a pending live tmux endpoint before registering a flat worker", async () => {
    const pending = endpoint({ transport: "tmux", agentId: "original", sessionId: "scout-session", metadata: { pendingExternalSession: true } });
    const { deps, upsertedActors, upsertedEndpoints } = createLocalDeps({ endpoints: { original: pending } });
    deps.observeEndpointSession = async () => ({ sessionId: NATIVE_SESSION_ID, runtime: { harness: "claude" }, runtimeSource: "process", evidence: { pid: 123 }, observedAt: 100 });
    deps.findLiveClaudeSession = async () => { throw new Error("must not scan after binding"); };
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.endpoint.agentId).toBe("original");
    expect(upsertedActors).toHaveLength(0);
    expect(upsertedEndpoints[0]?.metadata?.externalSessionId).toBe(NATIVE_SESSION_ID);
  });

  test("collapses registry and isolated projections of one observed pane", async () => {
    const registry = endpoint({ id: "registry", transport: "tmux", agentId: "original", sessionId: "scout-session", metadata: { lastStartedAt: 100 } });
    const isolated = endpoint({ ...registry, id: "isolated", metadata: { isolatedExecution: true, lastStartedAt: 200 } });
    const { deps, upsertedActors, upsertedEndpoints } = createLocalDeps({ endpoints: { registry, isolated } });
    deps.observeEndpointSession = async () => ({ sessionId: NATIVE_SESSION_ID, runtime: { harness: "claude" }, runtimeSource: "process", evidence: { pid: 123, tmuxSession: "scout-session", tmuxPane: "%16" }, observedAt: 100 });
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.endpoint.id).toBe("isolated");
    expect(upsertedActors).toHaveLength(0);
    expect(upsertedEndpoints).toHaveLength(1);
  });

  test("refuses distinct live process owners of one native id", async () => {
    const one = endpoint({ id: "one", transport: "tmux" });
    const two = endpoint({ ...one, id: "two" });
    const { deps, upsertedEndpoints } = createLocalDeps({ endpoints: { one, two } });
    deps.observeEndpointSession = async (candidate) => ({ sessionId: NATIVE_SESSION_ID, runtime: { harness: "claude" }, runtimeSource: "process", evidence: { pid: candidate.id === "one" ? 123 : 124, tmuxSession: "scout-session", tmuxPane: "%16" }, observedAt: 100 });
    expect(await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID })).toMatchObject({ ok: false, reason: "session_ambiguous" });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("does not inspect unrelated terminal endpoints while waking a native session", async () => {
    const stopped = endpoint({ transport: "tmux", state: "stopped" });
    const { deps, upsertedEndpoints } = createLocalDeps({ endpoints: { stopped } });
    deps.observeEndpointSession = async () => { throw new Error("stopped pane is missing"); };
    expect((await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID })).ok).toBe(true);
    expect(upsertedEndpoints).toHaveLength(1);
  });

  test("refuses to launch another worker for an unbound live native session", async () => {
    const { deps, upsertedActors, upsertedEndpoints } = createLocalDeps();
    deps.findLiveClaudeSession = async () => ({ sessionId: NATIVE_SESSION_ID });
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });
    expect(result).toMatchObject({ ok: false, reason: "session_live_unbound" });
    expect(upsertedActors).toHaveLength(0);
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("fails closed when process ownership cannot be inspected", async () => {
    const { deps, upsertedEndpoints } = createLocalDeps();
    deps.findLiveClaudeSession = async () => { throw new Error("tmux unavailable"); };
    expect(await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID })).toMatchObject({ ok: false, reason: "session_runtime_unobserved" });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("does not reuse a stale adopted tmux alias", async () => {
    const stale = endpoint({ transport: "tmux", metadata: { externalSessionId: NATIVE_SESSION_ID, externalSessionAdoptedAt: 100 } });
    const { deps, upsertedEndpoints } = createLocalDeps({ endpoints: { stale } });
    deps.observeEndpointSession = async () => null;
    deps.findLiveClaudeSession = async () => ({ sessionId: NATIVE_SESSION_ID });
    expect(await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID })).toMatchObject({ ok: false, reason: "session_live_unbound" });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("re-registers over a terminal endpoint instead of reusing it", async () => {
    const stopped = endpoint({ id: "endpoint-stopped", state: "stopped" });
    const { deps, upsertedEndpoints } = createLocalDeps({
      endpoints: { [stopped.id]: stopped },
    });

    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    expect(result.ok).toBe(true);
    expect(upsertedEndpoints).toHaveLength(1);
  });
});

describe("wakeSessionOnPeers", () => {
  function createPeerDeps(input: {
    responses: Record<string, PeerSessionWakeResponse | Error>;
  }) {
    const upsertedActors: ActorIdentity[] = [];
    const upsertedEndpoints: AgentEndpoint[] = [];
    const posts: Array<{ brokerBaseUrl: string; path: string; payload: unknown }> = [];
    const deps = {
      localNodeId: "node-local",
      registry: {
        async upsertActor(actor: ActorIdentity) {
          upsertedActors.push(actor);
        },
        async upsertEndpoint(nextEndpoint: AgentEndpoint) {
          upsertedEndpoints.push(nextEndpoint);
        },
      },
      postJson: async <TResponse,>(brokerBaseUrl: string, path: string, payload: unknown): Promise<TResponse> => {
        posts.push({ brokerBaseUrl, path, payload });
        const response = input.responses[brokerBaseUrl];
        if (response instanceof Error) {
          throw response;
        }
        return response as TResponse;
      },
    };
    return { deps, posts, upsertedActors, upsertedEndpoints };
  }

  test("adopts the endpoint from the first peer that owns the session", async () => {
    const peerEndpoint = endpoint({ id: "endpoint-peer", nodeId: "node-b" });
    const peerActor: ActorIdentity = {
      id: peerEndpoint.agentId,
      kind: "session",
      displayName: "openscout:4fad8bb9",
      handle: peerEndpoint.agentId,
      metadata: { cardless: true },
    } as ActorIdentity;
    const { deps, posts, upsertedActors, upsertedEndpoints } = createPeerDeps({
      responses: {
        "http://a.example:43110": { ok: false, reason: "session_unknown", detail: "not here" },
        "http://b.example:43110": { ok: true, endpoint: peerEndpoint, actor: peerActor },
      },
    });
    const result = await wakeSessionOnPeers(
      { ...deps, peers: [
        node({ id: "node-a", brokerUrl: "http://a.example:43110" }),
        node({ id: "node-b", brokerUrl: "http://b.example:43110" }),
      ] },
      { nativeSessionId: NATIVE_SESSION_ID, harness: "claude" },
    );

    expect(result).toEqual({ ok: true, peerNodeId: "node-b", endpoint: peerEndpoint });
    expect(posts.map((post) => post.path)).toEqual([MESH_SESSION_WAKE_PATH, MESH_SESSION_WAKE_PATH]);
    expect(posts[0]?.payload).toEqual({ nativeSessionId: NATIVE_SESSION_ID, harness: "claude" });
    expect(upsertedActors).toEqual([peerActor]);
    expect(upsertedEndpoints).toEqual([peerEndpoint]);
  });

  test("ignores endpoints a peer claims but does not own", async () => {
    const { deps, upsertedEndpoints } = createPeerDeps({
      responses: {
        // A peer must return an endpoint bound to its own node id.
        "http://b.example:43110": { ok: true, endpoint: endpoint({ nodeId: "node-elsewhere" }) },
      },
    });

    const result = await wakeSessionOnPeers(
      { ...deps, peers: [node({ id: "node-b", brokerUrl: "http://b.example:43110" })] },
      { nativeSessionId: NATIVE_SESSION_ID },
    );

    expect(result).toEqual({ ok: false, peersTried: 1 });
    expect(upsertedEndpoints).toEqual([]);
  });

  test("continues past transport failures and reports peers tried", async () => {
    const { deps } = createPeerDeps({
      responses: {
        "http://a.example:43110": new Error("connect ECONNREFUSED"),
        "http://b.example:43110": { ok: false, reason: "session_unknown", detail: "not here" },
      },
    });

    const result = await wakeSessionOnPeers(
      { ...deps, peers: [
        node({ id: "node-a", brokerUrl: "http://a.example:43110" }),
        node({ id: "node-b", brokerUrl: "http://b.example:43110" }),
      ] },
      { nativeSessionId: NATIVE_SESSION_ID },
    );

    expect(result).toEqual({ ok: false, peersTried: 2 });
  });

  test("skips peers without a broker url and itself", async () => {
    const { deps, posts } = createPeerDeps({ responses: {} });

    const result = await wakeSessionOnPeers(
      { ...deps, peers: [
        node({ id: "node-local", brokerUrl: "http://self.example:43110" }),
        node({ id: "node-silent", brokerUrl: undefined }),
      ] },
      { nativeSessionId: NATIVE_SESSION_ID },
    );

    expect(result).toEqual({ ok: false, peersTried: 0 });
    expect(posts).toEqual([]);
  });
});

describe("startSessionOnPeers", () => {
  function createStartDeps(input: {
    responses: Record<string, PeerSessionWakeResponse | Error>;
    roots?: Record<string, string[]>;
  }) {
    const upsertedActors: ActorIdentity[] = [];
    const upsertedEndpoints: AgentEndpoint[] = [];
    const posts: Array<{ brokerBaseUrl: string; path: string; payload: unknown }> = [];
    const deps = {
      localNodeId: "node-local",
      peerProjectRoots: (nodeId: string) => input.roots?.[nodeId] ?? [],
      registry: {
        async upsertActor(actor: ActorIdentity) {
          upsertedActors.push(actor);
        },
        async upsertEndpoint(nextEndpoint: AgentEndpoint) {
          upsertedEndpoints.push(nextEndpoint);
        },
      },
      postJson: async <TResponse,>(brokerBaseUrl: string, path: string, payload: unknown): Promise<TResponse> => {
        posts.push({ brokerBaseUrl, path, payload });
        const response = input.responses[brokerBaseUrl];
        if (response instanceof Error) {
          throw response;
        }
        return (response ?? { ok: false, reason: "project_unknown", detail: "not here" }) as TResponse;
      },
    };
    return { deps, posts, upsertedActors, upsertedEndpoints };
  }

  test("asks the peer whose agents live under the same home first and adopts its endpoint", async () => {
    const peerEndpoint = endpoint({ id: "endpoint-mini", nodeId: "node-mini", sessionId: "session-new" });
    const peerActor = { id: peerEndpoint.agentId, kind: "session", displayName: "agentlist.io" } as ActorIdentity;
    const { deps, posts, upsertedActors, upsertedEndpoints } = createStartDeps({
      roots: {
        "node-air": ["/Users/art/dev/openscout"],
        "node-mini": ["/Users/arach/dev/talkie"],
      },
      responses: {
        "http://mini.example:43110": { ok: true, endpoint: peerEndpoint, actor: peerActor },
      },
    });

    const result = await startSessionOnPeers(
      { ...deps, peers: [
        node({ id: "node-air", brokerUrl: "http://air.example:43110" }),
        node({ id: "node-mini", brokerUrl: "http://mini.example:43110" }),
      ] },
      { projectPath: "/Users/arach/dev/agentlist.io", harness: "claude", model: "claude-opus-5-5" },
    );

    expect(result).toEqual({ ok: true, peerNodeId: "node-mini", endpoint: peerEndpoint, actor: peerActor });
    expect(posts).toEqual([{
      brokerBaseUrl: "http://mini.example:43110",
      path: MESH_SESSION_START_PATH,
      payload: { projectPath: "/Users/arach/dev/agentlist.io", harness: "claude", model: "claude-opus-5-5" },
    }]);
    expect(upsertedActors).toEqual([peerActor]);
    expect(upsertedEndpoints).toEqual([peerEndpoint]);
  });

  test("falls through peers that do not have the project and reports how many were asked", async () => {
    const { deps, posts } = createStartDeps({
      responses: { "http://a.example:43110": new Error("connect ECONNREFUSED") },
    });

    const result = await startSessionOnPeers(
      { ...deps, peers: [
        node({ id: "node-a", brokerUrl: "http://a.example:43110" }),
        node({ id: "node-b", brokerUrl: "http://b.example:43110" }),
        node({ id: "node-local", brokerUrl: "http://self.example:43110" }),
      ] },
      { projectPath: "/srv/missing" },
    );

    expect(result).toEqual({
      ok: false,
      peersTried: 2,
      failures: [
        { peerNodeId: "node-a", host: "peer", reason: "peer_unreachable", detail: "connect ECONNREFUSED" },
        { peerNodeId: "node-b", host: "peer", reason: "project_unknown", detail: "not here" },
      ],
    });
    expect(posts.map((post) => post.brokerBaseUrl)).toEqual(["http://a.example:43110", "http://b.example:43110"]);
  });

  test("refuses an endpoint the peer does not own", async () => {
    const { deps, upsertedEndpoints } = createStartDeps({
      responses: { "http://b.example:43110": { ok: true, endpoint: endpoint({ nodeId: "node-elsewhere" }) } },
    });

    const result = await startSessionOnPeers(
      { ...deps, peers: [node({ id: "node-b", brokerUrl: "http://b.example:43110" })] },
      { projectPath: "/srv/project" },
    );

    expect(result).toEqual({
      ok: false,
      peersTried: 1,
      failures: [{
        peerNodeId: "node-b",
        host: "peer",
        reason: "endpoint_owner_mismatch",
        detail: "returned an endpoint owned by node-elsewhere",
      }],
    });
    expect(upsertedEndpoints).toEqual([]);
  });

  test("ranks peers by shared path depth, then id", () => {
    const peers = [node({ id: "node-c" }), node({ id: "node-b" }), node({ id: "node-a" })];
    const ranked = rankPeersForProjectPath(peers, "/Users/arach/dev/x", (id) => ({
      "node-b": ["/Users/arach/dev/talkie"],
      "node-c": ["/Users/art/dev/openscout"],
    })[id] ?? []);

    expect(ranked.map((peer) => peer.id)).toEqual(["node-b", "node-c", "node-a"]);
  });
});

const FORK_SESSION_ID = "9b1c2d3e-0000-4000-8000-000000000001";
const CODEX_THREAD_ID = "019fbee7-2a7f-7eb0-84bf-da22717c74d0";

function locatedCodexSession(): SessionLocateResult {
  return {
    ok: true,
    session: {
      harness: "codex",
      nativeSessionId: CODEX_THREAD_ID,
      cwd: "/Users/art/dev/blink",
      path: `/Users/art/.codex/sessions/2026/09/24/rollout-${CODEX_THREAD_ID}.jsonl`,
      lastActivityAt: 100,
      match: "session_meta id",
    },
  };
}

describe("wakeLocalHarnessSession fork-if-live", () => {
  test("continues a live Claude session as a Scout-owned fork with a pre-minted id", async () => {
    const { deps, upsertedEndpoints } = createLocalDeps();
    deps.findLiveClaudeSession = async () => ({ sessionId: NATIVE_SESSION_ID });
    deps.createForkSessionId = () => FORK_SESSION_ID;
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID, harness: "claude", forkIfLive: true });
    expect(result).toMatchObject({ ok: true, forkedSession: { sourceSessionId: NATIVE_SESSION_ID, sessionId: FORK_SESSION_ID } });
    expect(upsertedEndpoints).toHaveLength(1);
    const fork = upsertedEndpoints[0]!;
    expect(fork.agentId).toBe(flatDispatchSessionId("claude", FORK_SESSION_ID));
    expect(fork.transport).toBe("tmux");
    expect(fork.metadata).toMatchObject({
      flatDispatch: true,
      nativeSessionId: FORK_SESSION_ID,
      externalSessionId: FORK_SESSION_ID,
      forkedFromSessionId: NATIVE_SESSION_ID,
    });
  });

  test("reuses the existing fork of a still-live source instead of forking again", async () => {
    const prior = endpoint({
      id: "endpoint-fork",
      agentId: flatDispatchSessionId("claude", FORK_SESSION_ID),
      transport: "tmux",
      state: "idle",
      sessionId: flatDispatchSessionId("claude", FORK_SESSION_ID),
      metadata: { flatDispatch: true, nativeSessionId: FORK_SESSION_ID, forkedFromSessionId: NATIVE_SESSION_ID, startedAt: "100" },
    });
    const { deps, upsertedEndpoints } = createLocalDeps({ endpoints: { [prior.id]: prior } });
    deps.observeEndpointSession = async () => null;
    deps.findLiveClaudeSession = async () => ({ sessionId: NATIVE_SESSION_ID });
    deps.createForkSessionId = () => { throw new Error("must not mint a second fork"); };
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID, harness: "claude", forkIfLive: true });
    expect(result).toMatchObject({ ok: true, endpoint: { id: "endpoint-fork" }, forkedSession: { sessionId: FORK_SESSION_ID } });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("an idle Claude session resumes in place even when fork-if-live is requested", async () => {
    const { deps, upsertedEndpoints } = createLocalDeps();
    deps.createForkSessionId = () => { throw new Error("must not fork an idle session"); };
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID, harness: "claude", forkIfLive: true });
    expect(result.ok).toBe(true);
    expect(result.ok && result.forkedSession).toBeFalsy();
    expect(upsertedEndpoints[0]?.metadata?.nativeSessionId).toBe(NATIVE_SESSION_ID);
  });

  test("still fails closed when Claude liveness cannot be observed", async () => {
    const { deps, upsertedEndpoints } = createLocalDeps();
    deps.findLiveClaudeSession = async () => { throw new Error("tmux unavailable"); };
    expect(await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID, forkIfLive: true })).toMatchObject({ ok: false, reason: "session_runtime_unobserved" });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("refuses a Codex thread held by another writer when fork-if-live is requested", async () => {
    const { deps, upsertedEndpoints } = createLocalDeps({ locate: locatedCodexSession() });
    deps.isCodexThreadLive = async () => true;
    expect(await wakeLocalHarnessSession(deps, { nativeSessionId: CODEX_THREAD_ID, harness: "codex", forkIfLive: true }))
      .toMatchObject({ ok: false, reason: "session_live_fork_unsupported" });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("wakes a Codex thread no one holds, and fails closed when the lock probe fails", async () => {
    const free = createLocalDeps({ locate: locatedCodexSession() });
    free.deps.isCodexThreadLive = async () => false;
    expect((await wakeLocalHarnessSession(free.deps, { nativeSessionId: CODEX_THREAD_ID, harness: "codex", forkIfLive: true })).ok).toBe(true);
    expect(free.upsertedEndpoints[0]?.metadata?.threadId).toBe(CODEX_THREAD_ID);

    const unknown = createLocalDeps({ locate: locatedCodexSession() });
    unknown.deps.isCodexThreadLive = async () => { throw new Error("lsof failed"); };
    expect(await wakeLocalHarnessSession(unknown.deps, { nativeSessionId: CODEX_THREAD_ID, harness: "codex", forkIfLive: true }))
      .toMatchObject({ ok: false, reason: "session_runtime_unobserved" });
  });

  test("plain Codex exact wakes never consult the writer lock", async () => {
    const { deps } = createLocalDeps({ locate: locatedCodexSession() });
    deps.isCodexThreadLive = async () => { throw new Error("must not probe without opt-in"); };
    expect((await wakeLocalHarnessSession(deps, { nativeSessionId: CODEX_THREAD_ID, harness: "codex" })).ok).toBe(true);
  });
});

describe("isCodexThreadHeldByWriter", () => {
  test("no lock file means no writer", async () => {
    expect(await isCodexThreadHeldByWriter("t1", { codexHome: "/codex", exists: () => false, holders: async () => { throw new Error("unreached"); } })).toBe(false);
  });

  test("a lock file with a holding process is a live writer; one without is stale", async () => {
    const seen: string[] = [];
    const holders = async (path: string) => { seen.push(path); return ["4242"]; };
    expect(await isCodexThreadHeldByWriter("t1", { codexHome: "/codex", exists: () => true, holders })).toBe(true);
    expect(seen).toEqual(["/codex/thread-writer-locks/t1.lock"]);
    expect(await isCodexThreadHeldByWriter("t1", { codexHome: "/codex", exists: () => true, holders: async () => [] })).toBe(false);
  });
});

describe("suggestHostForProjectPath", () => {
  const archie = { id: "archie-openscout", meshId: "openscout", name: "archie" } as NodeDefinition;
  const hutch = { id: "hutch-openscout", meshId: "openscout", name: "hutch" } as NodeDefinition;
  const roots: Record<string, string[]> = {
    "archie-openscout": ["/home/arach/renders/arsenal-x", "/home/arach/dev/peal"],
    "hutch-openscout": ["/root/dev/peal"],
  };
  const lookup = (id: string) => roots[id] ?? [];

  test("names the one peer holding a repo with that folder name", () => {
    expect(suggestHostForProjectPath("/Users/art/renders/arsenal-x/", [archie, hutch], lookup))
      .toEqual({ host: "archie", root: "/home/arach/renders/arsenal-x" });
  });

  test("stays quiet when the name is ambiguous or unknown", () => {
    expect(suggestHostForProjectPath("~/dev/peal", [archie, hutch], lookup)).toBeUndefined();
    expect(suggestHostForProjectPath("~/dev/nowhere", [archie, hutch], lookup)).toBeUndefined();
  });
});

describe("resolveMeshHost", () => {
  const local = node({ id: "arts-mini-mesh-1", name: "arts-mini", brokerUrl: "http://127.0.0.1:43110" });
  const archie = node({ id: "archie-mesh-1", name: "archie", hostName: "archie.local", brokerUrl: "http://archie:43110" });
  const studio = node({ id: "studio-mesh-1", name: "studio", brokerUrl: "http://studio:43110" });
  const nodes = [local, archie, studio];
  const resolve = (host: string, overrides: Partial<Parameters<typeof resolveMeshHost>[0]> = {}) => resolveMeshHost({
    host,
    localNode: local,
    nodes,
    trustedNodeIds: new Set([archie.id]),
    isReachable: () => true,
    ...overrides,
  });

  test("names a trusted peer by label, host name, or node id", () => {
    expect(resolve("archie")).toEqual({ kind: "peer", node: archie });
    expect(resolve("ARCHIE.local")).toEqual({ kind: "peer", node: archie });
    expect(resolve("archie-mesh-1")).toEqual({ kind: "peer", node: archie });
  });

  test("an exact host qualifier beats stale display-name aliases in either order", () => {
    const mini = node({ id: "mini-mesh-1", name: "mini", hostName: "mini.local" });
    const stale = node({ id: "mini-local-mesh-1", name: "mini", hostName: "mini" });
    for (const order of [[stale, mini], [mini, stale]]) {
      expect(resolve("mini", { nodes: order, trustedNodeIds: new Set([mini.id, stale.id]) }))
        .toEqual({ kind: "peer", node: mini });
      expect(resolve("mini-local", { nodes: order, trustedNodeIds: new Set([mini.id, stale.id]) }))
        .toEqual({ kind: "peer", node: stale });
    }
  });

  test("the pre-dispatch check sees only the node routing picks, not a stale record that shares its name", () => {
    const mini = node({ id: "mini-mesh-1", name: "mini", hostName: "mini.local" });
    const stale = node({ id: "mini-local-mesh-1", name: "mini", hostName: "mini" });
    for (const order of [[stale, mini], [mini, stale]]) {
      expect(meshHostDispatchPeers(resolve("mini", { nodes: order, trustedNodeIds: new Set([mini.id, stale.id]) })))
        .toEqual([mini]);
    }
    expect(meshHostDispatchPeers(resolve("arts-mini"))).toEqual([]);
    expect(meshHostDispatchPeers(resolve("nowhere"))).toEqual([]);
    expect(meshHostDispatchPeers({ kind: "ambiguous", nodes: [mini, stale] })).toEqual([mini, stale]);
  });

  test("normalized host aliases remain usable when no exact qualifier matches", () => {
    expect(resolve("ARCHIE.local.")).toEqual({ kind: "peer", node: archie });
  });

  test("names this machine as local", () => {
    expect(resolve("arts-mini")).toEqual({ kind: "local" });
  });

  test("refuses a known but untrusted peer instead of starting work there", () => {
    expect(resolve("studio")).toEqual({ kind: "not_trusted", node: studio });
  });

  test("reports a trusted peer that is not reachable", () => {
    expect(resolve("archie", { isReachable: () => false })).toEqual({ kind: "unreachable", node: archie });
  });

  test("an unknown name lists the machines it could have meant", () => {
    expect(resolve("acrhie")).toEqual({ kind: "unknown", knownHosts: ["archie", "studio"] });
  });

  test("a name this machine and a peer share is refused, never resolved to local", () => {
    const shadow = node({ id: "mini-mesh-1", name: "shared", brokerUrl: "http://127.0.0.1:43110" });
    const peer = { ...archie, name: "shared" };
    expect(resolve("shared", { localNode: shadow, nodes: [shadow, peer] })).toEqual({ kind: "ambiguous", nodes: [shadow, peer] });
    expect(resolve("archie-mesh-1", { localNode: shadow, nodes: [shadow, archie] })).toEqual({ kind: "peer", node: archie });
  });

  test("two peers with one name are refused whatever their order", () => {
    const a = node({ id: "a-mesh-1", name: "duplicate", brokerUrl: "http://a:43110" });
    const b = node({ id: "b-mesh-1", name: "duplicate", brokerUrl: "http://b:43110" });
    for (const order of [[local, a, b], [local, b, a]]) {
      expect(resolve("duplicate", { nodes: order, trustedNodeIds: new Set([a.id, b.id]) }).kind).toBe("ambiguous");
    }
    expect(resolve("b-mesh-1", { nodes: [local, a, b], trustedNodeIds: new Set([a.id, b.id]) })).toEqual({ kind: "peer", node: b });
  });
});
