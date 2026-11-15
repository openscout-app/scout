import { describe, expect, test } from "bun:test";
import { isolateOpenScoutUserDataForTests } from "./test-user-data-isolation.ts";

isolateOpenScoutUserDataForTests();

import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ActorIdentity, AgentDefinition, AgentEndpoint } from "@openscout/protocol";

import {
  buildAgentLabelCandidates,
  buildDispatchEnvelope,
  resolveBrokerRouteTarget,
  resolveAgentLabel,
  type RuntimeSnapshot,
} from "./scout-dispatcher.js";
import { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";
import { createInMemoryControlRuntime } from "./broker.js";
import { isInactiveLocalAgent } from "./broker-endpoint-selection.js";

function makeAgent(input: {
  id: string;
  definitionId: string;
  workspaceQualifier?: string;
  nodeQualifier?: string;
  handle?: string;
  selector?: string;
  authorityNodeId?: string;
  homeNodeId?: string;
  metadata?: Record<string, unknown>;
}): AgentDefinition {
  return {
    id: input.id,
    kind: "agent",
    displayName: input.id,
    handle: input.handle,
    class: "general",
    capabilities: ["chat"],
    harness: "claude",
    wakePolicy: "on_demand",
    authorityNodeId: input.authorityNodeId ?? "node.local",
    homeNodeId: input.homeNodeId ?? input.authorityNodeId ?? "node.local",
    advertiseScope: "local",
    shareMode: "local",
    labels: [],
    metadata: {
      definitionId: input.definitionId,
      ...(input.workspaceQualifier ? { workspaceQualifier: input.workspaceQualifier } : {}),
      ...(input.nodeQualifier ? { nodeQualifier: input.nodeQualifier } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
      ...(input.metadata ?? {}),
    },
  };
}

function makeSessionActor(input: {
  id: string;
  handle: string;
  displayName?: string;
}): ActorIdentity {
  return {
    id: input.id,
    kind: "session",
    displayName: input.displayName ?? input.handle,
    handle: input.handle,
    metadata: { cardless: true, handle: input.handle },
  };
}

function makeSnapshot(
  agents: AgentDefinition[],
  endpoints: AgentEndpoint[] = [],
  flights: RuntimeSnapshot["flights"] = {},
  actors: Record<string, ActorIdentity> = {},
): RuntimeSnapshot {
  const agentMap: Record<string, AgentDefinition> = {};
  for (const agent of agents) agentMap[agent.id] = agent;
  const endpointMap: Record<string, AgentEndpoint> = {};
  for (const endpoint of endpoints) endpointMap[endpoint.id] = endpoint;
  return {
    agents: agentMap,
    endpoints: endpointMap,
    actors,
    nodes: {},
    conversations: {},
    bindings: {},
    flights,
    messages: [],
    deliveries: [],
    collaborations: {},
    collaborationEvents: [],
  } as unknown as RuntimeSnapshot;
}

function makeEndpoint(input: {
  id: string;
  agentId: string;
  harness: AgentEndpoint["harness"];
  model?: string;
  sessionId?: string;
  projectRoot?: string;
  state?: AgentEndpoint["state"];
  nodeId?: string;
  transport?: AgentEndpoint["transport"];
  metadata?: Record<string, unknown>;
}): AgentEndpoint {
  return {
    id: input.id,
    agentId: input.agentId,
    nodeId: input.nodeId ?? "node.local",
    harness: input.harness,
    transport: input.transport ?? (input.harness === "codex" ? "codex_app_server" : "claude_stream_json"),
    state: input.state ?? "idle",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.projectRoot ? { projectRoot: input.projectRoot, cwd: input.projectRoot } : {}),
    metadata: {
      ...(input.model ? { model: input.model } : {}),
      ...(input.metadata ?? {}),
    },
  };
}

const helpers = {
  isStale: () => false,
  homeEndpointFor: () => null,
};

describe("resolveAgentLabel", () => {
  test("returns unparseable for empty input", () => {
    const snapshot = makeSnapshot([]);
    expect(resolveAgentLabel(snapshot, "", { helpers }).kind).toBe("unparseable");
    expect(resolveAgentLabel(snapshot, "   ", { helpers }).kind).toBe("unparseable");
  });

  test("returns unknown when no candidate matches", () => {
    const snapshot = makeSnapshot([makeAgent({ id: "arc.main", definitionId: "arc" })]);
    const result = resolveAgentLabel(snapshot, "@nobody", { helpers });
    expect(result.kind).toBe("unknown");
  });

  test("keeps model-qualified near misses unknown with candidate context", () => {
    const talkie = makeAgent({
      id: "talkie.main.node",
      definitionId: "talkie",
      workspaceQualifier: "main",
    });
    const snapshot = makeSnapshot(
      [talkie],
      [
        makeEndpoint({
          id: "endpoint-talkie",
          agentId: talkie.id,
          harness: "claude",
          projectRoot: "/Users/you/dev/talkie",
        }),
      ],
    );

    const result = resolveAgentLabel(snapshot, "@talkie.harness:claude.model:sonnet", { helpers });

    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.candidates?.map((agent) => agent.id)).toEqual([talkie.id]);
      expect(result.detail).toContain("requested model:sonnet");
      expect(result.detail).toContain("do not advertise a model");
    }
  });

  test("resolves bare provisional handles to project-prefixed session aliases", () => {
    const sessionId = "session-chopin-1";
    const snapshot = makeSnapshot(
      [],
      [
        makeEndpoint({
          id: "endpoint-chopin",
          agentId: sessionId,
          harness: "codex",
          projectRoot: "/Users/you/dev/scope",
          metadata: { cardless: true, handle: "project-chopin" },
        }),
      ],
      {},
      {
        [sessionId]: makeSessionActor({
          id: sessionId,
          handle: "project-chopin",
          displayName: "Project Chopin",
        }),
      },
    );
    const result = resolveAgentLabel(snapshot, "@chopin", { helpers });
    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.actorId).toBe(sessionId);
    }
  });

  test("resolves target handles to saved session aliases", () => {
    const sessionId = "session-mw-talkie-1";
    const snapshot = makeSnapshot(
      [],
      [
        makeEndpoint({
          id: "endpoint-mw-talkie",
          agentId: sessionId,
          harness: "codex",
          projectRoot: "/Users/you/dev/talkie",
          metadata: { cardless: true, handle: "project-mw-talkie" },
        }),
      ],
      {},
      {
        [sessionId]: makeSessionActor({
          id: sessionId,
          handle: "project-mw-talkie",
          displayName: "Mission Writer Talkie",
        }),
      },
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "target_handle", handle: "mw-talkie", value: "target:mw-talkie" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.actorId).toBe(sessionId);
    }
  });

  test("resolves target label text to saved session aliases", () => {
    const sessionId = "session-mw-talkie-1";
    const snapshot = makeSnapshot(
      [],
      [
        makeEndpoint({
          id: "endpoint-mw-talkie",
          agentId: sessionId,
          harness: "codex",
          projectRoot: "/Users/you/dev/talkie",
          metadata: { cardless: true, handle: "project-mw-talkie" },
        }),
      ],
      {},
      {
        [sessionId]: makeSessionActor({
          id: sessionId,
          handle: "project-mw-talkie",
          displayName: "Mission Writer Talkie",
        }),
      },
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { targetLabel: "target:mw-talkie" },
      { helpers },
    );

    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.actorId).toBe(sessionId);
    }
  });

  test("does not treat unknown target handles as fresh agent labels", () => {
    const agent = makeAgent({ id: "agent-mw-talkie", definitionId: "mw-talkie", handle: "mw-talkie" });
    const snapshot = makeSnapshot([agent]);

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "target_handle", handle: "mw-talkie", value: "target:mw-talkie" } },
      { helpers },
    );

    expect(result).toMatchObject({
      kind: "unknown",
      label: "target:mw-talkie",
    });
  });

  test("resolves repeated cardless handles to the latest reachable session", () => {
    const olderSessionId = "session-chopin-old";
    const newerSessionId = "session-chopin-new";
    const snapshot = makeSnapshot(
      [],
      [
        makeEndpoint({
          id: "endpoint-chopin-old",
          agentId: olderSessionId,
          harness: "codex",
          sessionId: olderSessionId,
          projectRoot: "/Users/you/dev/scope",
          metadata: {
            cardless: true,
            handle: "project-chopin",
            lastStartedAt: 1_000,
          },
        }),
        makeEndpoint({
          id: "endpoint-chopin-new",
          agentId: newerSessionId,
          harness: "codex",
          sessionId: newerSessionId,
          projectRoot: "/Users/you/dev/scope",
          metadata: {
            cardless: true,
            handle: "project-chopin",
            lastStartedAt: 5_000,
          },
        }),
      ],
      {},
      {
        [olderSessionId]: makeSessionActor({
          id: olderSessionId,
          handle: "project-chopin",
        }),
        [newerSessionId]: makeSessionActor({
          id: newerSessionId,
          handle: "project-chopin",
        }),
      },
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "agent_label", label: "@project-chopin" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.actorId).toBe(newerSessionId);
    }
  });

  test("returns resolved when a single candidate matches", () => {
    const snapshot = makeSnapshot([makeAgent({ id: "arc.main", definitionId: "arc" })]);
    const result = resolveAgentLabel(snapshot, "@arc", { helpers });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("arc.main");
    }
  });

  test("resolves broker-registered external agents by handle", () => {
    const snapshot = makeSnapshot([
      makeAgent({
        id: "weather-a2a.local",
        definitionId: "weather-a2a-local",
        handle: "weather-a2a",
        metadata: {
          brokerRegistered: true,
        },
      }),
    ]);

    const result = resolveAgentLabel(snapshot, "@weather-a2a", { helpers });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("weather-a2a.local");
    }
  });

  test("reserves @scout instead of routing it through normal agent identity", () => {
    const snapshot = makeSnapshot([
      makeAgent({ id: "openscout.main.mini", definitionId: "openscout", nodeQualifier: "mini", workspaceQualifier: "main" }),
      makeAgent({ id: "ranger.main.mini", definitionId: "ranger", nodeQualifier: "mini", workspaceQualifier: "main" }),
    ]);
    const result = resolveAgentLabel(snapshot, "@scout", { helpers });
    expect(result.kind).toBe("unknown");
  });

  test("keeps product handles reserved when the local orchestrator is separate", () => {
    const snapshot = makeSnapshot([
      makeAgent({
        id: "openscout.main.mini",
        definitionId: "openscout",
        nodeQualifier: "mini",
        workspaceQualifier: "main",
        metadata: {
          projectRoot: "/tmp/openscout",
          registrationSource: "manual",
          staleLocalRegistration: true,
        },
      }),
      makeAgent({
        id: "ranger.main.mini",
        definitionId: "ranger",
        nodeQualifier: "mini",
        workspaceQualifier: "main",
        metadata: {
          projectRoot: "/tmp/openscout",
          registrationSource: "manifest",
        },
      }),
    ]);
    const result = resolveAgentLabel(snapshot, "@scout", {
      helpers: {
        ...helpers,
        isStale: (agent) => agent?.metadata?.staleLocalRegistration === true,
      },
    });
    expect(result.kind).toBe("unknown");
    const legacyResult = resolveAgentLabel(snapshot, "@openscout", {
      helpers: {
        ...helpers,
        isStale: (agent) => agent?.metadata?.staleLocalRegistration === true,
      },
    });
    expect(legacyResult.kind).toBe("unknown");
  });

  test("routes qualified openscout project agents despite the reserved product handle", () => {
    const snapshot = makeSnapshot(
      [
        makeAgent({
          id: "openscout.feat-web-design-system.arts-mac-mini-local",
          definitionId: "openscout",
          nodeQualifier: "arts-mac-mini-local",
          workspaceQualifier: "feat-web-design-system",
          selector: "@openscout.feat-web-design-system.node:arts-mac-mini-local",
        }),
      ],
      [
        makeEndpoint({
          id: "endpoint.openscout.codex",
          agentId: "openscout.feat-web-design-system.arts-mac-mini-local",
          harness: "codex",
          state: "waiting",
        }),
      ],
    );

    const qualified = resolveAgentLabel(
      snapshot,
      "@openscout.feat-web-design-system.node:arts-mac-mini-local",
      { helpers },
    );
    expect(qualified.kind).toBe("resolved");
    if (qualified.kind === "resolved") {
      expect(qualified.agent.id).toBe("openscout.feat-web-design-system.arts-mac-mini-local");
    }

    const codex = resolveAgentLabel(
      snapshot,
      "@openscout.feat-web-design-system.arts-mac-mini-local#codex",
      { helpers },
    );
    expect(codex.kind).toBe("resolved");
    if (codex.kind === "resolved") {
      expect(codex.agent.id).toBe("openscout.feat-web-design-system.arts-mac-mini-local");
    }
  });

  test("returns ambiguous when multiple agents share the same label", () => {
    const snapshot = makeSnapshot([
      makeAgent({ id: "scoutie.main.mini", definitionId: "scoutie", nodeQualifier: "mini", workspaceQualifier: "main" }),
      makeAgent({ id: "scoutie.mini.main", definitionId: "scoutie", nodeQualifier: "mini", workspaceQualifier: "main" }),
    ]);
    const result = resolveAgentLabel(snapshot, "@scoutie", { helpers });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((agent) => agent.id).sort()).toEqual([
        "scoutie.main.mini",
        "scoutie.mini.main",
      ]);
    }
  });

  test("local-authority preference collapses cross-node ambiguity", () => {
    const snapshot = makeSnapshot([
      makeAgent({ id: "hudson.local", definitionId: "hudson", authorityNodeId: "node.local" }),
      makeAgent({ id: "hudson.remote", definitionId: "hudson", authorityNodeId: "node.remote" }),
    ]);
    const result = resolveAgentLabel(snapshot, "@hudson", {
      preferLocalNodeId: "node.local",
      helpers,
    });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("hudson.local");
    }
  });

  test("skips stale local agents via helper predicate", () => {
    const fresh = makeAgent({ id: "arc.fresh", definitionId: "arc" });
    const stale = makeAgent({ id: "arc.stale", definitionId: "arc" });
    const snapshot = makeSnapshot([fresh, stale]);
    const result = resolveAgentLabel(snapshot, "@arc", {
      helpers: {
        ...helpers,
        isStale: (agent) => agent?.id === "arc.stale",
      },
    });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("arc.fresh");
    }
  });

  test("does not resolve labels that only match stale local agents", () => {
    const snapshot = makeSnapshot([
      makeAgent({
        id: "arc.stale",
        definitionId: "arc",
        metadata: {
          staleLocalRegistration: true,
          replacedByAgentId: "arc.fresh",
        },
      }),
    ]);
    const result = resolveAgentLabel(snapshot, "@arc", {
      helpers: {
        ...helpers,
        isStale: (agent) => agent?.metadata?.staleLocalRegistration === true,
      },
    });
    expect(result.kind).toBe("unknown");
  });

  test("resolves shorthand harness and model labels from endpoint metadata", () => {
    const codex55 = makeAgent({ id: "lattices.codex-55", definitionId: "lattices" });
    const codex54 = makeAgent({ id: "lattices.codex-54", definitionId: "lattices" });
    const claudeSonnet = makeAgent({ id: "lattices.sonnet", definitionId: "lattices" });
    const snapshot = makeSnapshot(
      [codex55, codex54, claudeSonnet],
      [
        makeEndpoint({ id: "endpoint.codex-55", agentId: codex55.id, harness: "codex", model: "gpt-5.5" }),
        makeEndpoint({ id: "endpoint.codex-54", agentId: codex54.id, harness: "codex", model: "gpt-5.4" }),
        makeEndpoint({ id: "endpoint.sonnet", agentId: claudeSonnet.id, harness: "claude", model: "claude-sonnet-4-6" }),
      ],
    );

    const codexResult = resolveAgentLabel(snapshot, "@lattices#codex?5.5", { helpers });
    expect(codexResult.kind).toBe("resolved");
    if (codexResult.kind === "resolved") {
      expect(codexResult.agent.id).toBe("lattices.codex-55");
    }

    const sonnetResult = resolveAgentLabel(snapshot, "@lattices#claude?sonnet", { helpers });
    expect(sonnetResult.kind).toBe("resolved");
    if (sonnetResult.kind === "resolved") {
      expect(sonnetResult.agent.id).toBe("lattices.sonnet");
    }
  });
});

describe("resolveBrokerRouteTarget", () => {
  test("resolves an explicit existing selector after normalization", () => {
    const target = makeAgent({
      id: "composer-review.agent",
      definitionId: "reviewer",
      selector: "@Composer.Review",
    });
    const snapshot = makeSnapshot([target]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "existing_handle", handle: "composer review" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe(target.id);
    }
  });

  test("does not treat duplicate definition IDs or an exact agent ID as an existing handle", () => {
    const snapshot = makeSnapshot([
      makeAgent({ id: "composer-review", definitionId: "composer-review" }),
      makeAgent({ id: "composer-review.remote", definitionId: "composer-review" }),
    ]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "existing_handle", handle: "composer-review" } },
      { helpers },
    );

    expect(result).toEqual({
      kind: "unknown",
      label: "@composer-review",
      detail: "no live agent handle, selector, or session handle exactly matches @composer-review",
    });
  });

  test("resolves an explicit existing handle exactly and never prefers a local duplicate", () => {
    const local = makeAgent({
      id: "composer-review.local",
      definitionId: "composer-review",
      handle: "composer-review",
      authorityNodeId: "node.local",
    });
    const remote = makeAgent({
      id: "composer-review.remote",
      definitionId: "composer-review",
      handle: "composer-review",
      authorityNodeId: "node.remote",
    });
    const snapshot = makeSnapshot([local, remote]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "existing_handle", handle: "composer-review" } },
      { preferLocalNodeId: "node.local", helpers },
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.id)).toEqual([
        "composer-review.local",
        "composer-review.remote",
      ]);
      expect(result.detail).toContain(
        "agent:composer-review.local, agent:composer-review.remote",
      );
    }
  });

  test("fails closed when multiple live sessions share an exact handle", () => {
    const first = makeSessionActor({
      id: "session-composer-review-one",
      handle: "composer-review",
    });
    const second = makeSessionActor({
      id: "session-composer-review-two",
      handle: "composer-review",
    });
    const snapshot = makeSnapshot(
      [],
      [
        makeEndpoint({
          id: "endpoint-composer-review-one",
          agentId: first.id,
          harness: "codex",
          sessionId: first.id,
        }),
        makeEndpoint({
          id: "endpoint-composer-review-two",
          agentId: second.id,
          harness: "claude",
          sessionId: second.id,
        }),
      ],
      {},
      { [first.id]: first, [second.id]: second },
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "existing_handle", handle: "composer-review" } },
      { helpers },
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toEqual([]);
      expect(result.detail).toContain(
        "session:session-composer-review-one, session:session-composer-review-two",
      );
    }
  });

  test("fails closed when an exact existing handle names both an agent and a session", () => {
    const agent = makeAgent({
      id: "composer-review.agent",
      definitionId: "composer-review",
      handle: "composer-review",
    });
    const sessionActor = makeSessionActor({
      id: "session-composer-review",
      handle: "composer-review",
    });
    const snapshot = makeSnapshot(
      [agent],
      [makeEndpoint({
        id: "endpoint-composer-review",
        agentId: sessionActor.id,
        harness: "codex",
        sessionId: sessionActor.id,
      })],
      {},
      { [sessionActor.id]: sessionActor },
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "existing_handle", handle: "composer-review" } },
      { helpers },
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.detail).toContain(
        "agent:composer-review.agent, session:session-composer-review",
      );
    }
  });

  test("resolves runtime profiles through their explicit current-project route", () => {
    const projectRoot = "/tmp/openscout";
    const target = makeAgent({ id: "openscout.main", definitionId: "openscout-app" });
    const snapshot = makeSnapshot(
      [target],
      [makeEndpoint({
        id: "endpoint.openscout",
        agentId: target.id,
        harness: "claude",
        projectRoot,
      })],
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      {
        target: {
          kind: "runtime_profile",
          profile: "fable",
          projectPath: projectRoot,
        },
      },
      { helpers },
    );
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe(target.id);
    }

    expect(resolveBrokerRouteTarget(
      snapshot,
      {
        target: {
          kind: "runtime_profile",
          profile: "composer-review",
          projectPath: projectRoot,
        },
      },
      { helpers },
    )).toEqual({
      kind: "unknown",
      label: "profile:composer-review",
      detail: 'unknown runtime profile "composer-review"',
    });
  });

  test("resolves typed agent-label targets without caller-side preflight", () => {
    const snapshot = makeSnapshot([makeAgent({ id: "arc.main", definitionId: "arc" })]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "agent_label", label: "@arc" } },
      { helpers },
    );
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("arc.main");
    }
  });

  test("treats harness-qualified labels as route params when no exact endpoint exists", () => {
    const snapshot = makeSnapshot([makeAgent({ id: "hudson.main", definitionId: "hudson" })]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "agent_label", label: "@hudson.harness:codex" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("hudson.main");
    }
  });

  test("resolves typed direct agent ids before label parsing", () => {
    const snapshot = makeSnapshot([makeAgent({ id: "arc.main", definitionId: "arc" })]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "agent_id", agentId: "arc.main" }, targetLabel: "@other" },
      { helpers },
    );
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("arc.main");
    }
  });

  test("resolves exact session targets through native endpoint aliases", () => {
    const target = makeAgent({ id: "talkie.main", definitionId: "talkie" });
    const targetEndpoint = makeEndpoint({
      id: "endpoint.talkie.main.local.codex_app_server",
      agentId: target.id,
      harness: "codex",
      sessionId: "relay-talkie-codex",
      metadata: {
        externalSessionId: "codex-thread-talkie",
        threadId: "codex-thread-talkie",
        runtimeInstanceId: "relay-talkie-codex",
      },
    });
    const snapshot = makeSnapshot(
      [target],
      [targetEndpoint],
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId: "codex-thread-talkie" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe(target.id);
    }

    const handle = runtimeSessionHandleForEndpoint(targetEndpoint);
    expect(handle).not.toBeNull();
    const canonical = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId: handle! } },
      { helpers },
    );
    expect(canonical.kind).toBe("resolved");
  });

  test("collapses same-harness agent projections for one native session", () => {
    const sessionId = "session-msmj8lfe-plfxbs";
    const projections = [
      makeAgent({ id: "session-msmj8lfe-plfxbs", definitionId: "reviewer" }),
      makeAgent({ id: "session-msmj8lfe-plfxbs.review-a.node-1", definitionId: "reviewer" }),
      makeAgent({ id: "session-msmj8lfe-plfxbs.review-b.node-2", definitionId: "reviewer" }),
      makeAgent({ id: "session-msmj8lfe-plfxbs.review-c.node-3", definitionId: "reviewer" }),
    ];
    const snapshot = makeSnapshot(
      projections,
      projections.map((agent, index) => makeEndpoint({
        id: `endpoint.${agent.id}`,
        agentId: agent.id,
        harness: "claude",
        state: index === 2 ? "active" : "idle",
        sessionId: `relay-${index}`,
        metadata: {
          externalSessionId: sessionId,
          nativeSessionId: sessionId,
          lastStartedAt: 1_000 + index,
        },
      })),
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("session-msmj8lfe-plfxbs.review-b.node-2");
    }
  });

  test("keeps a shared transport alias ambiguous across distinct native sessions", () => {
    const first = makeAgent({ id: "reviewer.first", definitionId: "reviewer" });
    const second = makeAgent({ id: "reviewer.second", definitionId: "reviewer" });
    const snapshot = makeSnapshot(
      [first, second],
      [
        makeEndpoint({
          id: "endpoint.reviewer.first",
          agentId: first.id,
          harness: "claude",
          state: "idle",
          metadata: { nativeSessionId: "native-first", tmuxSession: "work" },
        }),
        makeEndpoint({
          id: "endpoint.reviewer.second",
          agentId: second.id,
          harness: "claude",
          state: "active",
          metadata: { nativeSessionId: "native-second", tmuxSession: "work" },
        }),
      ],
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId: "work" } },
      { helpers },
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.id)).toEqual([
        "reviewer.first",
        "reviewer.second",
      ]);
      expect(result.detail).toContain("session:claude:native-first");
      expect(result.detail).toContain("session:claude:native-second");
    }
  });

  test("collapses a relay copy of one scout session onto the endpoint that holds the native id", () => {
    const scoutSessionId = "session-card";
    const nativeId = "claude-session-1";
    const live = makeAgent({ id: scoutSessionId, definitionId: "reviewer" });
    const relay = makeAgent({ id: `${scoutSessionId}.relay`, definitionId: "reviewer" });
    const snapshot = makeSnapshot(
      [live, relay],
      [
        makeEndpoint({
          id: "endpoint.live",
          agentId: live.id,
          harness: "claude",
          transport: "http",
          state: "idle",
          sessionId: scoutSessionId,
          metadata: {
            externalSessionId: nativeId,
            nativeSessionId: null,
            observedSessionId: nativeId,
          },
        }),
        makeEndpoint({
          id: "endpoint.relay",
          agentId: relay.id,
          harness: "claude",
          transport: "tmux",
          state: "active",
          sessionId: scoutSessionId,
          metadata: {
            source: "relay-agent-registry",
            tmuxSession: scoutSessionId,
            runtimeInstanceId: scoutSessionId,
            observedSessionId: nativeId,
          },
        }),
      ],
    );

    const bySession = resolveBrokerRouteTarget(snapshot, { targetSessionId: scoutSessionId }, { helpers });
    expect(bySession.kind).toBe("resolved");
    if (bySession.kind === "resolved") expect(bySession.agent.id).toBe(live.id);

    const byNative = resolveBrokerRouteTarget(
      snapshot,
      {
        target: {
          kind: "session_id",
          sessionId: nativeId,
          harness: "claude",
          value: `session:claude:${nativeId}`,
        },
      },
      { helpers },
    );
    expect(byNative.kind).toBe("resolved");
    if (byNative.kind === "resolved") expect(byNative.agent.id).toBe(live.id);
  });

  test("prefers the cardless endpoint that holds the native id over an active relay copy", () => {
    const sessionId = "session-card";
    const nativeId = "claude-session-1";
    const snapshot = makeSnapshot(
      [],
      [
        makeEndpoint({
          id: "endpoint.live",
          agentId: sessionId,
          harness: "claude",
          transport: "http",
          state: "idle",
          sessionId,
          metadata: { externalSessionId: nativeId, observedSessionId: nativeId },
        }),
        makeEndpoint({
          id: "endpoint.relay",
          agentId: `${sessionId}-relay`,
          harness: "claude",
          transport: "tmux",
          state: "active",
          sessionId,
          metadata: {
            source: "relay-agent-registry",
            tmuxSession: sessionId,
            runtimeInstanceId: sessionId,
            observedSessionId: nativeId,
          },
        }),
      ],
    );

    const result = resolveBrokerRouteTarget(snapshot, { targetSessionId: sessionId }, { helpers });
    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.actorId).toBe(sessionId);
      expect(result.session.endpoint.id).toBe("endpoint.live");
    }
  });

  test("keeps a shared transport alias ambiguous when one side has no native id", () => {
    const first = makeAgent({ id: "reviewer.first", definitionId: "reviewer" });
    const second = makeAgent({ id: "reviewer.second", definitionId: "reviewer" });
    const snapshot = makeSnapshot(
      [first, second],
      [
        makeEndpoint({
          id: "endpoint.reviewer.first",
          agentId: first.id,
          harness: "claude",
          state: "idle",
          metadata: { tmuxSession: "work" },
        }),
        makeEndpoint({
          id: "endpoint.reviewer.second",
          agentId: second.id,
          harness: "claude",
          state: "active",
          metadata: { nativeSessionId: "native-second", tmuxSession: "work" },
        }),
      ],
    );

    const result = resolveBrokerRouteTarget(snapshot, { targetSessionId: "work" }, { helpers });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.detail).toContain("session:claude:native-second");
    }
  });

  test("keeps one scout session ambiguous when its projections name different native ids", () => {
    const scoutSessionId = "session-card";
    const first = makeAgent({ id: "reviewer.first", definitionId: "reviewer" });
    const second = makeAgent({ id: "reviewer.second", definitionId: "reviewer" });
    const snapshot = makeSnapshot(
      [first, second],
      [
        makeEndpoint({
          id: "endpoint.reviewer.first",
          agentId: first.id,
          harness: "claude",
          sessionId: scoutSessionId,
          metadata: { externalSessionId: "native-a" },
        }),
        makeEndpoint({
          id: "endpoint.reviewer.second",
          agentId: second.id,
          harness: "claude",
          sessionId: scoutSessionId,
          metadata: { externalSessionId: "native-b" },
        }),
      ],
    );

    const result = resolveBrokerRouteTarget(snapshot, { targetSessionId: scoutSessionId }, { helpers });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.detail).toContain("session:claude:native-a");
      expect(result.detail).toContain("session:claude:native-b");
    }
  });

  test("keeps a shared cardless alias ambiguous across distinct native sessions", () => {
    const snapshot = makeSnapshot(
      [],
      [
        makeEndpoint({
          id: "endpoint.cardless.first",
          agentId: "session.first",
          harness: "claude",
          state: "idle",
          metadata: { nativeSessionId: "native-first", tmuxSession: "work" },
        }),
        makeEndpoint({
          id: "endpoint.cardless.second",
          agentId: "session.second",
          harness: "claude",
          state: "active",
          metadata: { nativeSessionId: "native-second", tmuxSession: "work" },
        }),
      ],
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId: "work" } },
      { helpers },
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toEqual([]);
      expect(result.detail).toContain("session:claude:native-first");
      expect(result.detail).toContain("session:claude:native-second");
    }
  });

  test("ignores a stale foreign-harness projection when one live session remains", () => {
    const claude = makeAgent({ id: "reviewer.claude", definitionId: "reviewer" });
    const codex = makeAgent({ id: "reviewer.codex", definitionId: "reviewer" });
    const sessionId = "native-review";
    const snapshot = makeSnapshot(
      [claude, codex],
      [
        makeEndpoint({
          id: "endpoint.reviewer.claude",
          agentId: claude.id,
          harness: "claude",
          metadata: { nativeSessionId: sessionId },
        }),
        makeEndpoint({
          id: "endpoint.reviewer.codex",
          agentId: codex.id,
          harness: "codex",
          metadata: { tmuxSession: sessionId, staleLocalRegistration: true },
        }),
      ],
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.agent.id).toBe(claude.id);
  });

  test("prefers the local node among projections of one native session", () => {
    const local = makeAgent({ id: "reviewer.local", definitionId: "reviewer" });
    const remote = makeAgent({ id: "reviewer.remote", definitionId: "reviewer" });
    const sessionId = "native-review";
    const snapshot = makeSnapshot(
      [local, remote],
      [
        makeEndpoint({
          id: "endpoint.reviewer.local",
          agentId: local.id,
          harness: "claude",
          nodeId: "node.local",
          state: "idle",
          metadata: { nativeSessionId: sessionId },
        }),
        makeEndpoint({
          id: "endpoint.reviewer.remote",
          agentId: remote.id,
          harness: "claude",
          nodeId: "node.remote",
          state: "active",
          metadata: { nativeSessionId: sessionId },
        }),
      ],
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId } },
      { preferLocalNodeId: "node.local", helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.agent.id).toBe(local.id);
  });

  test("uses harness-qualified session routes to disambiguate native session ids", () => {
    const codex = makeAgent({ id: "talkie.codex", definitionId: "talkie" });
    const claude = makeAgent({ id: "talkie.claude", definitionId: "talkie" });
    const snapshot = makeSnapshot(
      [codex, claude],
      [
        makeEndpoint({
          id: "endpoint.talkie.codex",
          agentId: codex.id,
          harness: "codex",
          sessionId: "relay-talkie-codex",
          metadata: {
            externalSessionId: "native-thread-shared",
            threadId: "native-thread-shared",
          },
        }),
        makeEndpoint({
          id: "endpoint.talkie.claude",
          agentId: claude.id,
          harness: "claude",
          sessionId: "relay-talkie-claude",
          metadata: {
            externalSessionId: "native-thread-shared",
            threadId: "native-thread-shared",
          },
        }),
      ],
    );

    const ambiguous = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId: "native-thread-shared" } },
      { helpers },
    );
    expect(ambiguous.kind).toBe("ambiguous");
    if (ambiguous.kind === "ambiguous") {
      expect(ambiguous.detail).toContain("multiple harnesses (claude, codex)");
      expect(ambiguous.detail).toContain("session:<harness>:native-thread-shared");
    }

    const qualified = resolveBrokerRouteTarget(
      snapshot,
      {
        target: {
          kind: "session_id",
          sessionId: "native-thread-shared",
          harness: "codex",
          value: "session:codex:native-thread-shared",
        },
      },
      { helpers },
    );
    expect(qualified.kind).toBe("resolved");
    if (qualified.kind === "resolved") {
      expect(qualified.agent.id).toBe(codex.id);
    }
  });

  test("uses execution harness to scope targetSessionId-only routes", () => {
    const codex = makeAgent({ id: "openscout.codex", definitionId: "openscout" });
    const claude = makeAgent({ id: "openscout.claude", definitionId: "openscout" });
    const snapshot = makeSnapshot(
      [codex, claude],
      [
        makeEndpoint({
          id: "endpoint.openscout.codex",
          agentId: codex.id,
          harness: "codex",
          metadata: { threadId: "native-thread-shared" },
        }),
        makeEndpoint({
          id: "endpoint.openscout.claude",
          agentId: claude.id,
          harness: "claude",
          metadata: { threadId: "native-thread-shared" },
        }),
      ],
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      {
        targetSessionId: "native-thread-shared",
        execution: { harness: "claude" },
      },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe(claude.id);
    }
  });

  test("resolves binding refs from flight id suffixes", () => {
    const agent = makeAgent({ id: "openscout.main", definitionId: "openscout" });
    const snapshot = makeSnapshot([agent], [], {
      "flt-1234567890abcdef": {
        id: "flt-1234567890abcdef",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: agent.id,
        state: "completed",
      },
    });

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "binding_ref", ref: "90abcdef" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe(agent.id);
    }
  });

  test("resolves binding refs to cardless session targets", () => {
    const sessionId = "session-chopin-1";
    const snapshot = makeSnapshot(
      [],
      [
        makeEndpoint({
          id: "endpoint-chopin",
          agentId: sessionId,
          harness: "codex",
          sessionId,
          projectRoot: "/Users/you/dev/scope",
          metadata: { cardless: true, handle: "project-chopin" },
        }),
      ],
      {
        "flt-1234567890abcdef": {
          id: "flt-1234567890abcdef",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: sessionId,
          state: "completed",
        },
      },
      {
        [sessionId]: makeSessionActor({
          id: sessionId,
          handle: "project-chopin",
        }),
      },
    );

    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "binding_ref", ref: "90abcdef" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.actorId).toBe(sessionId);
    }
  });

  test("keeps stale direct agent ids on the explicitly requested agent", () => {
    const snapshot = makeSnapshot([
      makeAgent({
        id: "ranger.main.mini",
        definitionId: "ranger",
        metadata: {
          staleLocalRegistration: true,
          replacedByAgentId: "ranger.codex-vox-getting-started.mini",
        },
      }),
      makeAgent({
        id: "ranger.codex-vox-getting-started.mini",
        definitionId: "ranger",
      }),
    ]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { targetAgentId: "ranger.main.mini", targetLabel: "ranger.main.mini" },
      {
        helpers: {
          ...helpers,
          isStale: (agent) => agent?.metadata?.staleLocalRegistration === true,
        },
      },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("ranger.main.mini");
    }
  });

  test("resolves typed project path targets by broker-owned project root", () => {
    const projectRoot = "/tmp/talkie";
    const target = makeAgent({
      id: "talkie.main",
      definitionId: "talkie",
      metadata: { projectRoot },
    });
    const snapshot = makeSnapshot([target]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "project_path", projectPath: projectRoot } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("talkie.main");
    }
  });

  test("expands home-relative project path targets before matching broker roots", () => {
    const projectRoot = resolve(homedir(), "dev", "openscout");
    const target = makeAgent({
      id: "openscout.main",
      definitionId: "openscout",
      metadata: { projectRoot },
    });
    const snapshot = makeSnapshot([target]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "project_path", projectPath: "~/dev/openscout" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("openscout.main");
    }
  });

  test("prefers the reachable project path target when several agents share the project", () => {
    const projectRoot = "/tmp/talkie";
    const offline = makeAgent({
      id: "talkie.offline",
      definitionId: "talkie",
      metadata: { projectRoot },
    });
    const online = makeAgent({
      id: "talkie.online",
      definitionId: "talkie-helper",
      metadata: { projectRoot },
    });
    const snapshot = makeSnapshot(
      [offline, online],
      [makeEndpoint({
        id: "endpoint.online",
        agentId: online.id,
        harness: "codex",
        projectRoot,
        state: "idle",
      })],
    );
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "project_path", projectPath: projectRoot } },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe("talkie.online");
    }
  });

  test("keeps project path routing ahead of mismatched agent id hints", () => {
    const projectRoot = "/tmp/talkie";
    const otherRoot = "/tmp/other";
    const target = makeAgent({
      id: "talkie.main",
      definitionId: "talkie",
      metadata: { projectRoot },
    });
    const wrongProject = makeAgent({
      id: "other.main",
      definitionId: "other",
      metadata: { projectRoot: otherRoot },
    });
    const snapshot = makeSnapshot(
      [target, wrongProject],
      [
        makeEndpoint({
          id: "endpoint.talkie",
          agentId: target.id,
          harness: "codex",
          projectRoot,
          state: "idle",
        }),
        makeEndpoint({
          id: "endpoint.other",
          agentId: wrongProject.id,
          harness: "codex",
          projectRoot: otherRoot,
          state: "idle",
        }),
      ],
    );
    const result = resolveBrokerRouteTarget(
      snapshot,
      {
        target: { kind: "project_path", projectPath: projectRoot },
        targetAgentId: wrongProject.id,
      },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe(target.id);
    }
  });

  test("uses matching agent id hints within a project path route", () => {
    const projectRoot = "/tmp/talkie";
    const defaultTarget = makeAgent({
      id: "talkie.default",
      definitionId: "talkie",
      metadata: { projectRoot },
    });
    const selectedTarget = makeAgent({
      id: "talkie.selected",
      definitionId: "talkie-alt",
      metadata: { projectRoot },
    });
    const snapshot = makeSnapshot(
      [defaultTarget, selectedTarget],
      [
        makeEndpoint({
          id: "endpoint.default",
          agentId: defaultTarget.id,
          harness: "codex",
          projectRoot,
          state: "idle",
        }),
      ],
    );
    const result = resolveBrokerRouteTarget(
      snapshot,
      {
        target: { kind: "project_path", projectPath: projectRoot },
        targetAgentId: selectedTarget.id,
      },
      { helpers },
    );

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.agent.id).toBe(selectedTarget.id);
    }
  });

  test("keeps project path routing ambiguous when the broker cannot choose", () => {
    const projectRoot = "/tmp/talkie";
    const snapshot = makeSnapshot([
      makeAgent({ id: "talkie.one", definitionId: "talkie", metadata: { projectRoot } }),
      makeAgent({ id: "talkie.two", definitionId: "talkie-alt", metadata: { projectRoot } }),
    ]);
    const result = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "project_path", projectPath: projectRoot } },
      { helpers },
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((agent) => agent.id).sort()).toEqual([
        "talkie.one",
        "talkie.two",
      ]);
    }
  });
});

describe("buildAgentLabelCandidates", () => {
  test("surfaces selector aliases from metadata", () => {
    const snapshot = makeSnapshot([
      makeAgent({ id: "hudson.main", definitionId: "hudson", selector: "@huddy" }),
    ]);
    const [candidate] = buildAgentLabelCandidates(snapshot, helpers);
    expect(candidate.aliases).toEqual(["@huddy"]);
    expect(candidate.definitionId).toBe("hudson");
  });
});

describe("buildDispatchEnvelope", () => {
  const snapshot = makeSnapshot([]);

  test("shapes ambiguous envelope with candidate summaries", () => {
    const arcMain = makeAgent({ id: "arc.main", definitionId: "arc", workspaceQualifier: "main" });
    const arcSuper = makeAgent({
      id: "arc.super",
      definitionId: "arc",
      workspaceQualifier: "super-refactor",
    });
    const envelope = buildDispatchEnvelope(
      { kind: "ambiguous", label: "@arc", candidates: [arcMain, arcSuper] },
      "@arc",
      "node.local",
      snapshot,
      helpers,
    );
    expect(envelope.kind).toBe("ambiguous");
    expect(envelope.askedLabel).toBe("@arc");
    expect(envelope.dispatcherNodeId).toBe("node.local");
    expect(envelope.candidates).toHaveLength(2);
    expect(envelope.candidates[0].agentId).toBe("arc.main");
    expect(envelope.candidates[0].workspace).toBe("main");
  });

  test("shapes unknown envelope with no candidates", () => {
    const envelope = buildDispatchEnvelope(
      { kind: "unknown", label: "@ghost" },
      "@ghost",
      "node.local",
      snapshot,
      helpers,
    );
    expect(envelope.kind).toBe("unknown");
    expect(envelope.candidates).toEqual([]);
    expect(envelope.detail).toContain("@ghost");
  });

  test("shapes unknown envelope with near-match candidates", () => {
    const talkie = makeAgent({
      id: "talkie.main.node",
      definitionId: "talkie",
      workspaceQualifier: "main",
    });
    const endpoint = makeEndpoint({
      id: "endpoint-talkie",
      agentId: talkie.id,
      harness: "claude",
      projectRoot: "/Users/you/dev/talkie",
    });
    const envelope = buildDispatchEnvelope(
      {
        kind: "unknown",
        label: "@talkie.harness:claude.model:sonnet",
        detail: "no exact agent matches @talkie.harness:claude.model:sonnet; requested model:sonnet, but matching candidates do not advertise a model",
        candidates: [talkie],
      },
      "@talkie.harness:claude.model:sonnet",
      "node.local",
      makeSnapshot([talkie], [endpoint]),
      {
        ...helpers,
        homeEndpointFor: (_snapshot, agentId) => agentId === talkie.id ? endpoint : null,
      },
    );

    expect(envelope.kind).toBe("unknown");
    expect(envelope.detail).toContain("requested model:sonnet");
    expect(envelope.candidates).toHaveLength(1);
    expect(envelope.candidates[0].agentId).toBe(talkie.id);
    expect(envelope.candidates[0].endpointState).toBe("online");
    expect(envelope.candidates[0].transport).toBe("claude_stream_json");
  });

  test("shapes unparseable envelope", () => {
    const envelope = buildDispatchEnvelope(
      { kind: "unparseable", label: "###" },
      "###",
      "node.local",
      snapshot,
      helpers,
    );
    expect(envelope.kind).toBe("unparseable");
    expect(envelope.askedLabel).toBe("###");
    expect(envelope.detail).toContain("###");
  });
});

describe("versioned routing indexes", () => {
  test("renames and retirement invalidate exact-label matches without hiding ambiguity", async () => {
    const runtime = createInMemoryControlRuntime();
    const first = makeAgent({ id: "first", definitionId: "worker", handle: "xyz" });
    await runtime.upsertAgent(first);
    const options = { helpers: { isStale: isInactiveLocalAgent } };
    const lookup = (label: string) => resolveAgentLabel(runtime.routingSnapshot(), label, options);
    expect(lookup("xyz")).toEqual({ kind: "resolved", agent: first });
    await runtime.upsertAgent(makeAgent({ id: "second", definitionId: "worker", handle: "xyz", authorityNodeId: "remote" }));
    expect(lookup("xyz").kind).toBe("ambiguous");
    await runtime.upsertAgent({ ...first, handle: "renamed" });
    const previousName = lookup("xyz");
    expect(previousName.kind === "resolved" && previousName.agent.id).toBe("second");
    await runtime.upsertAgent({ ...runtime.agent("second")!, metadata: { retiredFromFleet: true } });
    expect(lookup("xyz").kind).toBe("unknown");
    expect(lookup("renamed").kind).toBe("resolved");
    runtime.deleteAgent("first");
    expect(lookup("renamed").kind).toBe("unknown");
  });

  test("endpoint refresh replaces model and exact-session aliases, including cardless actor handles", async () => {
    const runtime = createInMemoryControlRuntime();
    const agent = makeAgent({ id: "one", definitionId: "worker" });
    await runtime.upsertAgent(agent);
    const endpoint = makeEndpoint({ id: "endpoint", agentId: "one", harness: "codex", model: "gpt-first", sessionId: "session-old" });
    await runtime.upsertEndpoint(endpoint);
    const target = (sessionId: string) => resolveBrokerRouteTarget(runtime.routingSnapshot(), { target: { kind: "session_id", sessionId } }, { helpers });
    expect(target("session-old").kind).toBe("resolved");
    expect(resolveAgentLabel(runtime.routingSnapshot(), "worker#codex?gpt-first", { helpers }).kind).toBe("resolved");
    runtime.refreshEndpointSilently({ ...endpoint, sessionId: "session-new", metadata: { model: "gpt-second" } });
    expect(target("session-old").kind).toBe("unknown");
    expect(target("session-new").kind).toBe("resolved");
    expect(resolveAgentLabel(runtime.routingSnapshot(), "worker#codex?gpt-first", { helpers }).kind).toBe("unknown");
    await runtime.upsertActor(makeSessionActor({ id: "cardless", handle: "solo" }));
    await runtime.upsertEndpoint(makeEndpoint({ id: "cardless-endpoint", agentId: "cardless", harness: "codex" }));
    expect(resolveAgentLabel(runtime.routingSnapshot(), "solo", { helpers }).kind).toBe("resolved_session");
    await runtime.upsertActor(makeSessionActor({ id: "cardless", handle: "renamed-solo" }));
    expect(resolveAgentLabel(runtime.routingSnapshot(), "solo", { helpers }).kind).toBe("unknown");
    runtime.deleteEndpoint("cardless-endpoint");
    expect(resolveAgentLabel(runtime.routingSnapshot(), "renamed-solo", { helpers }).kind).toBe("unknown");
  });

  test("mutable standalone snapshots do not retain cached results across calls", () => {
    const snapshot = makeSnapshot([makeAgent({ id: "one", definitionId: "worker", handle: "xyz" })]);
    expect(resolveAgentLabel(snapshot, "xyz", { helpers }).kind).toBe("resolved");
    snapshot.agents.one = { ...snapshot.agents.one!, handle: "renamed" };
    expect(resolveAgentLabel(snapshot, "xyz", { helpers }).kind).toBe("unknown");
    expect(resolveAgentLabel(snapshot, "renamed", { helpers }).kind).toBe("resolved");
  });
});
