import { describe, expect, test } from "bun:test";
import { isolateOpenScoutUserDataForTests } from "./test-user-data-isolation.ts";

isolateOpenScoutUserDataForTests();

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  buildCardlessSessionEndpoint,
  cardlessSessionDisplayName,
  cardlessSessionsForProjectRoot,
  isCardlessSessionEndpoint,
  registerCardlessSession,
  resolveCardlessSessionSpawnTarget,
  resolveSessionPlacement,
} from "./broker-cardless-session.js";
import { resolveBrokerRouteTarget } from "./scout-dispatcher.js";

const helpers = { isStale: () => false };
const PROJECT = "/Users/guest/dev/openscout";

function newRuntime() {
  return createInMemoryControlRuntime({}, { localNodeId: "node-1" });
}

describe("SCO-070 cardless sessions", () => {
  test("maps cardless harnesses to their default and backup transports", () => {
    expect(resolveCardlessSessionSpawnTarget(undefined)).toEqual({ harness: "claude", transport: "tmux" });
    expect(resolveCardlessSessionSpawnTarget("claude")).toEqual({ harness: "claude", transport: "tmux" });
    expect(resolveCardlessSessionSpawnTarget("claude", { claudeTransport: "claude_stream_json" })).toEqual({
      harness: "claude",
      transport: "claude_stream_json",
    });
    expect(resolveCardlessSessionSpawnTarget("codex")).toEqual({ harness: "codex", transport: "codex_app_server" });
    expect(resolveCardlessSessionSpawnTarget("grok")).toEqual({ harness: "grok-acp", transport: "grok_acp" });
    expect(resolveCardlessSessionSpawnTarget("pi")).toEqual({ harness: "pi", transport: "pi_rpc" });
    expect(resolveCardlessSessionSpawnTarget("kimi")).toEqual({ harness: "kimi", transport: "kimi_acp" });
    expect(resolveCardlessSessionSpawnTarget("cursor")).toEqual({
      harness: "cursor",
      transport: "cursor_acp",
    });
  });

  test("an ask from an unseen non-git folder goes headless instead of blocking on Claude's trust dialog", () => {
    // Regression: `scout ask --harness claude --new` from Linea's support folder
    // spawned tmux Claude, which sat on "Yes, I trust this folder" forever.
    const folder = "/Users/me/Library/Application Support/Linea/Scout";
    const untrusted = () => false;
    expect(resolveCardlessSessionSpawnTarget("claude", { cwd: folder, isClaudeFolderTrusted: untrusted }))
      .toEqual({ harness: "claude", transport: "claude_stream_json" });
    expect(resolveCardlessSessionSpawnTarget(undefined, { cwd: folder, isClaudeFolderTrusted: untrusted }))
      .toEqual({ harness: "claude", transport: "claude_stream_json" });
    // A folder Claude already trusts keeps the interactive tmux default.
    expect(resolveCardlessSessionSpawnTarget("claude", { cwd: PROJECT, isClaudeFolderTrusted: () => true }))
      .toEqual({ harness: "claude", transport: "tmux" });
    // An explicit transport override still wins.
    expect(resolveCardlessSessionSpawnTarget("claude", {
      cwd: folder,
      claudeTransport: "tmux",
      isClaudeFolderTrusted: untrusted,
    })).toEqual({ harness: "claude", transport: "tmux" });
    // Other harnesses have no trust dialog and are unaffected.
    expect(resolveCardlessSessionSpawnTarget("codex", { cwd: folder, isClaudeFolderTrusted: untrusted }))
      .toEqual({ harness: "codex", transport: "codex_app_server" });
  });

  test("fails closed on an explicit opencode2 request instead of defaulting to V1 ACP", () => {
    // `opencode2` is the product-V2 integration, not an alias for `opencode`.
    // An explicit unsupported harness must error; only an omitted harness gets
    // the documented claude default.
    expect(resolveCardlessSessionSpawnTarget("opencode")).toEqual({
      harness: "opencode",
      transport: "opencode_acp",
    });
    expect(() => resolveCardlessSessionSpawnTarget("opencode2"))
      .toThrow('cannot auto-spawn a session for harness "opencode2"');
  });

  test("formats display names as {project}-{alias}", () => {
    expect(cardlessSessionDisplayName({ handle: "project-hooke", projectName: "scope" })).toBe("scope-hooke");
    expect(cardlessSessionDisplayName({ handle: "archimedes", projectName: "scope" })).toBe("scope-archimedes");
    expect(cardlessSessionDisplayName({ handle: "project-hooke" })).toBe("hooke");
  });

  test("defaults sessions to background and supports Codex foreground only", () => {
    expect(resolveSessionPlacement("codex", undefined)).toBe("background");
    expect(resolveSessionPlacement("codex", "foreground")).toBe("foreground");
    expect(() => resolveSessionPlacement("claude", "foreground"))
      .toThrow("claude supports background placement only");

    const foreground = buildCardlessSessionEndpoint({
      sessionId: "sess-foreground",
      transport: "codex_app_server",
      harness: "codex",
      cwd: PROJECT,
      nodeId: "node-1",
      placement: "foreground",
    });
    expect(foreground.metadata).toEqual(expect.objectContaining({
      placement: "foreground",
      nativeSurface: "codex_app",
      configurationScope: "operator_inherited",
    }));
  });

  test("attached placement is Codex-only and marks the endpoint to attach, not spawn", () => {
    expect(resolveSessionPlacement("codex", "attached")).toBe("attached");
    expect(() => resolveSessionPlacement("claude", "attached"))
      .toThrow("claude supports background placement only");

    const attached = buildCardlessSessionEndpoint({
      sessionId: "sess-attached",
      transport: "codex_app_server",
      harness: "codex",
      cwd: PROJECT,
      nodeId: "node-1",
      placement: "attached",
    });
    expect(attached.metadata).toEqual(expect.objectContaining({
      placement: "attached",
      codexConnection: "attach",
      configurationScope: "server_inherited",
    }));
    expect(attached.metadata?.nativeSurface).toBeUndefined();
  });

  test("registers a session-kind actor + endpoint with no card", async () => {
    const runtime = newRuntime();
    const result = await registerCardlessSession(runtime, {
      sessionId: "sess-abc12345",
      handle: "archimedes",
      transport: "codex_app_server",
      harness: "codex",
      cwd: PROJECT,
      nodeId: "node-1",
    });
    const snapshot = runtime.snapshot();

    // The actor exists and is session-kind; NO agent card was minted.
    expect(snapshot.actors["sess-abc12345"]?.kind).toBe("session");
    expect(snapshot.actors["sess-abc12345"]?.handle).toBe("archimedes");
    expect(snapshot.actors["sess-abc12345"]?.metadata?.handle).toBe("archimedes");
    expect(snapshot.actors["sess-abc12345"]?.metadata).toEqual(expect.objectContaining({
      harness: "codex",
      transport: "codex_app_server",
      sessionId: "sess-abc12345",
    }));
    expect(snapshot.agents["sess-abc12345"]).toBeUndefined();

    // The endpoint occupies the identity slot with agentId === sessionId.
    const endpoint = snapshot.endpoints[result.endpointId];
    expect(endpoint?.agentId).toBe("sess-abc12345");
    expect(isCardlessSessionEndpoint(endpoint!)).toBe(true);
    expect(endpoint?.metadata?.pendingExternalSession).toBe(true);
    expect(endpoint?.metadata?.placement).toBe("background");
    expect(endpoint?.metadata?.configurationScope).toBe("managed");
    expect(endpoint?.metadata?.handle).toBe("archimedes");
    expect(endpoint?.metadata?.externalSessionId).toBeUndefined();
    expect(endpoint?.metadata?.threadId).toBeUndefined();
  });

  test("a cardless session routes via resolved_session with no ambiguity", async () => {
    const runtime = newRuntime();
    await registerCardlessSession(runtime, {
      sessionId: "sess-route-1",
      handle: "franklin",
      transport: "claude_stream_json",
      harness: "claude",
      cwd: PROJECT,
      nodeId: "node-1",
    });

    const result = resolveBrokerRouteTarget(
      runtime.snapshot(),
      { target: { kind: "session_id", sessionId: "sess-route-1" } },
      { helpers },
    );

    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.actorId).toBe("sess-route-1");
      expect(result.session.endpoint.sessionId).toBe("sess-route-1");
      expect(result.session.nodeId).toBe("node-1");
    }

    const handleResult = resolveBrokerRouteTarget(
      runtime.snapshot(),
      { target: { kind: "agent_label", label: "@franklin" } },
      { helpers },
    );
    expect(handleResult.kind).toBe("resolved_session");
    if (handleResult.kind === "resolved_session") {
      expect(handleResult.session.actorId).toBe("sess-route-1");
      expect(handleResult.session.label).toBe("openscout-franklin");
    }
  });

  test("two cardless sessions in one project each resolve, no ambiguity", async () => {
    const runtime = newRuntime();
    await registerCardlessSession(runtime, {
      sessionId: "sess-a",
      transport: "codex_app_server",
      harness: "codex",
      cwd: PROJECT,
      nodeId: "node-1",
    });
    await registerCardlessSession(runtime, {
      sessionId: "sess-b",
      transport: "codex_app_server",
      harness: "codex",
      cwd: PROJECT,
      nodeId: "node-1",
    });
    const snapshot = runtime.snapshot();

    for (const id of ["sess-a", "sess-b"]) {
      const result = resolveBrokerRouteTarget(
        snapshot,
        { target: { kind: "session_id", sessionId: id } },
        { helpers },
      );
      expect(result.kind).toBe("resolved_session");
    }

    // Both appear under the project (seam 4 grouping).
    const grouped = cardlessSessionsForProjectRoot(snapshot, PROJECT);
    expect(grouped.map((e) => e.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
  });

  test("sessions group under their resolved project root", async () => {
    const runtime = newRuntime();
    await registerCardlessSession(runtime, {
      sessionId: "sess-here",
      transport: "codex_app_server",
      harness: "codex",
      cwd: PROJECT,
      nodeId: "node-1",
    });
    await registerCardlessSession(runtime, {
      sessionId: "sess-elsewhere",
      transport: "codex_app_server",
      harness: "codex",
      cwd: "/Users/guest/dev/hudson",
      nodeId: "node-1",
    });
    const snapshot = runtime.snapshot();

    expect(cardlessSessionsForProjectRoot(snapshot, PROJECT).map((e) => e.sessionId)).toEqual([
      "sess-here",
    ]);
    // Trailing-slash variant normalizes to the same root.
    expect(
      cardlessSessionsForProjectRoot(snapshot, `${PROJECT}/`).map((e) => e.sessionId),
    ).toEqual(["sess-here"]);
  });

  test("expands home-relative paths before storing cardless endpoints", () => {
    const endpoint = buildCardlessSessionEndpoint({
      sessionId: "sess-home",
      transport: "codex_app_server",
      harness: "codex",
      cwd: "~/dev/openscout",
      nodeId: "node-1",
    });

    const projectRoot = join(homedir(), "dev", "openscout");
    expect(endpoint.cwd).toBe(projectRoot);
    expect(endpoint.projectRoot).toBe(projectRoot);
    expect(endpoint.metadata?.projectRoot).toBe(projectRoot);
  });

  test("stores pairing bridge session ids separately from the Scout route owner", () => {
    const endpoint = buildCardlessSessionEndpoint({
      sessionId: "sess-grok-acp",
      transport: "pairing_bridge",
      harness: "grok-acp",
      cwd: PROJECT,
      nodeId: "node-1",
      pairingSessionId: "pairing-grok-acp-1",
      externalSessionId: "pairing-grok-acp-1",
    });

    expect(endpoint.agentId).toBe("sess-grok-acp");
    expect(endpoint.sessionId).toBe("pairing-grok-acp-1");
    expect(endpoint.harness).toBe("grok-acp");
    expect(endpoint.transport).toBe("pairing_bridge");
    expect(endpoint.metadata).toEqual(expect.objectContaining({
      cardless: true,
      pendingExternalSession: false,
      externalSessionId: "pairing-grok-acp-1",
      pairingSessionId: "pairing-grok-acp-1",
      pairingAdapterType: "grok-acp",
    }));
  });

  test("a stale cardless endpoint drops from routing and grouping", () => {
    const live = buildCardlessSessionEndpoint({
      sessionId: "sess-live",
      transport: "codex_app_server",
      harness: "codex",
      cwd: PROJECT,
      nodeId: "node-1",
    });
    const dead = buildCardlessSessionEndpoint({
      sessionId: "sess-dead",
      transport: "codex_app_server",
      harness: "codex",
      cwd: PROJECT,
      nodeId: "node-1",
    });
    dead.metadata = { ...dead.metadata, staleLocalRegistration: true };

    const snapshot = {
      agents: {},
      endpoints: { [live.id]: live, [dead.id]: dead },
      actors: {},
      nodes: {},
      conversations: {},
      bindings: {},
      flights: {},
      messages: [],
      deliveries: [],
      collaborations: {},
      collaborationEvents: [],
    } as unknown as ReturnType<ReturnType<typeof newRuntime>["snapshot"]>;

    const deadResult = resolveBrokerRouteTarget(
      snapshot,
      { target: { kind: "session_id", sessionId: "sess-dead" } },
      { helpers },
    );
    expect(deadResult.kind).toBe("unknown");

    const grouped = cardlessSessionsForProjectRoot(snapshot, PROJECT);
    expect(grouped.map((e) => e.sessionId)).toEqual(["sess-live"]);
    expect(resolve(PROJECT)).toBe(PROJECT);
  });
});
