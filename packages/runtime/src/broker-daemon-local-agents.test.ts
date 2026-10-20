import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon local agent routing", () => {
  test("starts a cardless project session when the project path has no registered participant", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "implicit-project");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {});
    // Claude has trusted this folder, so the cardless session keeps tmux;
    // an untrusted folder would route to headless claude_stream_json.
    writeFileSync(join(controlHome, ".claude.json"), JSON.stringify({
      projects: { [join(controlHome, "projects")]: { hasTrustDialogAccepted: true } },
    }));

    const harness = await broker.startBroker({
      controlHome,
      env: {
        HOME: controlHome,
        CLAUDE_CONFIG_DIR: "",
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      receipt?: { targetAgentId?: string };
      flight?: { targetAgentId: string; state: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-project-auto-card",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "project_path",
        projectPath: "~/projects/implicit-project",
      },
      body: "Review this project without a pre-created card.",
      intent: "consult",
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toMatch(/^session-/);
    expect(response.receipt?.targetAgentId).toBe(response.targetAgentId);
    expect(response.flight?.targetAgentId).toBe(response.targetAgentId);
    expect(response.flight?.state).toBe("queued");

    const snapshot = await broker.getJson<{
      actors: Record<string, { kind: string; displayName?: string; handle?: string; metadata?: Record<string, unknown> }>;
      agents: Record<string, unknown>;
      endpoints: Record<string, {
        agentId: string;
        harness?: string;
        transport?: string;
        projectRoot?: string;
        metadata?: Record<string, unknown>;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(snapshot.actors[response.targetAgentId!]?.handle).toMatch(/^project-/);
    expect(snapshot.actors[response.targetAgentId!]?.displayName).toMatch(/^implicit-project-/);
    expect(snapshot.actors[response.targetAgentId!]).toEqual(expect.objectContaining({
      kind: "session",
      metadata: expect.objectContaining({
        cardless: true,
        handle: expect.stringMatching(/^project-/),
        projectRoot,
      }),
    }));
    expect(snapshot.agents[response.targetAgentId!]).toBeUndefined();
    expect(Object.values(snapshot.endpoints)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: response.targetAgentId,
        harness: "claude",
        transport: "tmux",
        projectRoot,
        metadata: expect.objectContaining({
          cardless: true,
          pendingExternalSession: true,
        }),
      }),
    ]));
  }, 15_000);

  test("applies a broker runtime profile to a fresh current-project session", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "profile-project");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {});

    const harness = await broker.startBroker({
      controlHome,
      env: {
        HOME: controlHome,
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    const response = await broker.postJson<{
      accepted: boolean;
      targetAgentId?: string;
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-profile-opus",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "runtime_profile",
        profile: "opus",
        projectPath: projectRoot,
        reasoningEffort: "high",
      },
      body: "Review this project with the Opus profile.",
      intent: "consult",
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toMatch(/^session-/);
    const snapshot = await broker.getJson<{
      endpoints: Record<string, {
        agentId: string;
        harness?: string;
        projectRoot?: string;
        metadata?: Record<string, unknown>;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(Object.values(snapshot.endpoints)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: response.targetAgentId,
        harness: "claude",
        projectRoot,
        metadata: expect.objectContaining({
          model: "claude-opus-5-5",
          reasoningEffort: "high",
          launchArgs: ["--model", "claude-opus-5-5", "--effort", "high"],
        }),
      }),
    ]));
  }, 15_000);

  test("rejects unsupported ACP runtime profile effort before creating a session", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "profile-project");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {});

    const harness = await broker.startBroker({
      controlHome,
      env: {
        HOME: controlHome,
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    for (const profile of ["grok", "kimi"]) {
      const response = await broker.postJsonStatus(harness.baseUrl, "/v1/deliver", {
        id: `deliver-profile-${profile}-effort`,
        caller: {
          actorId: "operator",
          nodeId: harness.nodeId,
        },
        target: {
          kind: "runtime_profile",
          profile,
          projectPath: projectRoot,
          reasoningEffort: "high",
        },
        body: `Review this project with the ${profile} profile.`,
        intent: "consult",
        ensureAwake: false,
        createdAt: Date.now(),
      });

      expect(response.status).toBe(422);
      expect(response.body).toEqual(expect.objectContaining({
        kind: "rejected",
        accepted: false,
        reason: "invalid_target",
        rejection: expect.objectContaining({
          kind: "unparseable",
          askedLabel: `profile:${profile}`,
        }),
      }));
    }

    const snapshot = await broker.getJson<{
      endpoints: Record<string, { metadata?: Record<string, unknown> }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(Object.values(snapshot.endpoints).filter((endpoint) =>
      endpoint.metadata?.cardless === true
    )).toHaveLength(0);
  }, 15_000);

  test("uses stream JSON only when the cardless Claude backup transport is explicit", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "stream-json-backup");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {});

    const harness = await broker.startBroker({
      controlHome,
      env: {
        HOME: controlHome,
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
        OPENSCOUT_CLAUDE_CARDLESS_TRANSPORT: "claude_stream_json",
      },
    });

    const response = await broker.postJson<{
      accepted: boolean;
      targetAgentId?: string;
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-project-stream-json-backup",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "project_path",
        projectPath: projectRoot,
      },
      body: "Use the explicitly configured backup transport.",
      intent: "consult",
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response.accepted).toBe(true);
    const snapshot = await broker.getJson<{
      endpoints: Record<string, { agentId: string; harness?: string; transport?: string }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(Object.values(snapshot.endpoints)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: response.targetAgentId,
        harness: "claude",
        transport: "claude_stream_json",
      }),
    ]));
  }, 15_000);

  test("starts and invokes a Grok ACP cardless session for project routing", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "grok-acp-project");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {});
    const fakeBin = mkdtempSync(join(tmpdir(), "openscout-fake-grok-"));
    broker.temporaryDirectories.add(fakeBin);
    const fakeGrokPath = join(fakeBin, "grok");
    const fakeGrokLogPath = join(fakeBin, "events.log");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const logPath = process.env.OPENSCOUT_TEST_GROK_LOG;

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};
  if (logPath) appendFileSync(logPath, method + ":" + String(params.sessionId ?? "") + "\\n");

  if (method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: false },
          sessionCapabilities: { close: {} }
        },
        agentInfo: { name: "grok-acp", title: "Grok ACP", version: "test" },
        authMethods: [{ id: "xai.api_key" }]
      }
    }));
    continue;
  }

  if (method === "authenticate") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }

  if (method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "fake-grok-acp-session" } }));
    continue;
  }

  if (method === "session/set_model") {
    if (logPath) appendFileSync(logPath, "model:" + String(params.modelId ?? "") + "\\n");
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }

  if (method === "session/prompt") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "grok-acp-ok" }
        }
      }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    continue;
  }

  if (method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }
}
`, "utf8");
    chmodSync(fakeGrokPath, 0o755);

    const harness = await broker.startBroker({
      controlHome,
      env: {
        HOME: controlHome,
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SCOUT_XAI_API_KEY: "test-key",
        OPENSCOUT_TEST_GROK_LOG: fakeGrokLogPath,
      },
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      flight?: { id: string; targetAgentId: string; state: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-project-grok-acp",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "project_path",
        projectPath: projectRoot,
      },
      body: "Reply with exactly grok-acp-ok.",
      intent: "consult",
      execution: {
        harness: "grok-acp",
        model: "grok-4.5",
        session: "new",
      },
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toMatch(/^session-/);
    expect(response.flight?.targetAgentId).toBe(response.targetAgentId);

    const completed = await broker.waitFor(
      () => broker.getJson<{
        endpoints: Record<string, {
        agentId: string;
        harness?: string;
        transport?: string;
        sessionId?: string;
          metadata?: Record<string, unknown>;
        }>;
        flights: Record<string, { state: string; summary?: string; metadata?: Record<string, unknown> }>;
      }>(harness.baseUrl, "/v1/snapshot"),
      (snapshot) => Object.values(snapshot.endpoints).some((endpoint) =>
        endpoint.agentId === response.targetAgentId
        && endpoint.harness === "grok-acp"
        && endpoint.transport === "grok_acp"
        && endpoint.metadata?.pendingExternalSession === false
      ) && Boolean(response.flight?.id && snapshot.flights[response.flight.id]?.state === "completed"),
    );

    const endpoint = Object.values(completed.endpoints).find((candidate) =>
      candidate.agentId === response.targetAgentId
      && candidate.harness === "grok-acp"
      && candidate.transport === "grok_acp"
    );
    expect(endpoint).toEqual(expect.objectContaining({
      sessionId: response.targetAgentId,
      metadata: expect.objectContaining({
        cardless: true,
        pendingExternalSession: false,
        externalSessionId: "fake-grok-acp-session",
        adapterType: "grok-acp",
        model: "grok-4.5",
      }),
    }));

    const grokEvents = readFileSync(fakeGrokLogPath, "utf8");
    expect(grokEvents).toContain("session/set_model:fake-grok-acp-session\nmodel:grok-4.5");
    expect(grokEvents.indexOf("session/set_model:")).toBeLessThan(grokEvents.indexOf("session/prompt:"));

    expect(completed.flights[response.flight!.id]).toEqual(expect.objectContaining({
      state: "completed",
      output: expect.stringContaining("grok-acp-ok"),
      metadata: expect.objectContaining({
        dispatchAck: expect.objectContaining({
          transport: "grok_acp",
        }),
      }),
    }));
  }, 15_000);

  test("starts and invokes a Kimi ACP cardless session for project routing", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "kimi-acp-project");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {});
    const fakeBin = mkdtempSync(join(tmpdir(), "openscout-fake-kimi-"));
    broker.temporaryDirectories.add(fakeBin);
    const fakeKimiPath = join(fakeBin, "kimi");
    writeFileSync(fakeKimiPath, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const message = JSON.parse(line);
  const { id, method } = message;
  const params = message.params ?? {};
  if (method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { close: {} }, loadSession: true },
        agentInfo: { name: "Kimi Code CLI", version: "test" },
        authMethods: [{ id: "login" }]
      }
    }));
  } else if (method === "authenticate") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  } else if (method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "fake-kimi-acp-session" } }));
  } else if (method === "session/prompt") {
    console.log(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "kimi-acp-ok" } } }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
  } else if (method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  }
}
`, "utf8");
    chmodSync(fakeKimiPath, 0o755);

    const harness = await broker.startBroker({
      controlHome,
      env: {
        HOME: controlHome,
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
        KIMI_CLI_BIN: fakeKimiPath,
      },
    });

    const response = await broker.postJson<{
      accepted: boolean;
      targetAgentId?: string;
      flight?: { id: string; targetAgentId: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-project-kimi-acp",
      caller: { actorId: "operator", nodeId: harness.nodeId },
      target: { kind: "project_path", projectPath: projectRoot },
      body: "Reply with exactly kimi-acp-ok.",
      intent: "consult",
      execution: { harness: "kimi", session: "new" },
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toMatch(/^session-/);
    const completed = await broker.waitFor(
      () => broker.getJson<{
        endpoints: Record<string, {
          agentId: string;
          harness?: string;
          transport?: string;
          metadata?: Record<string, unknown>;
        }>;
        flights: Record<string, { state: string; output?: string; metadata?: Record<string, unknown> }>;
      }>(harness.baseUrl, "/v1/snapshot"),
      (snapshot) => Object.values(snapshot.endpoints).some((endpoint) =>
        endpoint.agentId === response.targetAgentId
        && endpoint.harness === "kimi"
        && endpoint.transport === "kimi_acp"
        && endpoint.metadata?.pendingExternalSession === false
      ) && Boolean(response.flight?.id && snapshot.flights[response.flight.id]?.state === "completed"),
    );

    const endpoint = Object.values(completed.endpoints).find((candidate) =>
      candidate.agentId === response.targetAgentId && candidate.transport === "kimi_acp"
    );
    expect(endpoint?.metadata).toEqual(expect.objectContaining({
      cardless: true,
      pendingExternalSession: false,
      externalSessionId: "fake-kimi-acp-session",
      adapterType: "kimi-acp",
    }));
    expect(completed.flights[response.flight!.id]).toEqual(expect.objectContaining({
      state: "completed",
      output: expect.stringContaining("kimi-acp-ok"),
      metadata: expect.objectContaining({
        dispatchAck: expect.objectContaining({ transport: "kimi_acp" }),
      }),
    }));
  }, 15_000);

  test("starts a cardless project session instead of using a registered card when one-time was requested", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "fresh-route");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {
      "fresh-route": {
        agentId: "fresh-route",
        definitionId: "fresh-route",
        displayName: "Fresh Project",
        projectName: "Fresh Project",
        projectRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-fresh-route-codex",
          wakePolicy: "on_demand",
        },
        capabilities: ["chat", "invoke", "deliver"],
      },
    });

    const harness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      receipt?: { targetAgentId?: string };
      flight?: { targetAgentId: string; state: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-project-one-time-agent",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "project_path",
        projectPath: projectRoot,
      },
      body: "Review this project in fresh Codex context.",
      intent: "consult",
      execution: {
        harness: "codex",
        session: "new",
      },
      projectAgent: {
        persistence: "one_time",
      },
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toMatch(/^session-/);
    expect(response.receipt?.targetAgentId).toBe(response.targetAgentId);
    expect(response.flight?.targetAgentId).toBe(response.targetAgentId);
    expect(response.flight?.state).toBe("queued");

    const snapshot = await broker.getJson<{
      agents: Record<string, unknown>;
      endpoints: Record<string, { agentId: string; metadata?: Record<string, unknown> }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(snapshot.agents[response.targetAgentId!]).toBeUndefined();
    expect(snapshot.agents["fresh-route.test-node"]).toBeDefined();
    expect(Object.values(snapshot.endpoints)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: response.targetAgentId,
        metadata: expect.objectContaining({ cardless: true }),
      }),
    ]));
  }, 15_000);

  test("starts a cardless project session when existing project cards are ambiguous", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "ambiguous-project");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {
      "ambiguous-one": {
        agentId: "ambiguous-one",
        definitionId: "ambiguous-one",
        displayName: "Ambiguous One",
        projectName: "Ambiguous Project",
        projectRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-ambiguous-one-codex",
          wakePolicy: "on_demand",
        },
        capabilities: ["chat", "invoke", "deliver"],
      },
      "ambiguous-two": {
        agentId: "ambiguous-two",
        definitionId: "ambiguous-two",
        displayName: "Ambiguous Two",
        projectName: "Ambiguous Project",
        projectRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-ambiguous-two-codex",
          wakePolicy: "on_demand",
        },
        capabilities: ["chat", "invoke", "deliver"],
      },
    });

    const harness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      receipt?: { targetAgentId?: string };
      flight?: { targetAgentId: string; state: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-project-auto-card-ambiguous",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "project_path",
        projectPath: projectRoot,
      },
      body: "Review this project without choosing from existing sessions.",
      intent: "consult",
      execution: {
        harness: "codex",
        session: "new",
      },
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toMatch(/^session-/);
    expect(response.targetAgentId).not.toBe("ambiguous-one.test-node");
    expect(response.targetAgentId).not.toBe("ambiguous-two.test-node");
    expect(response.receipt?.targetAgentId).toBe(response.targetAgentId);
    expect(response.flight?.targetAgentId).toBe(response.targetAgentId);
    expect(response.flight?.state).toBe("queued");

    const snapshot = await broker.getJson<{
      agents: Record<string, unknown>;
      endpoints: Record<string, { agentId: string; metadata?: Record<string, unknown> }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(snapshot.agents[response.targetAgentId!]).toBeUndefined();
    expect(snapshot.agents["ambiguous-one.test-node"]).toBeDefined();
    expect(snapshot.agents["ambiguous-two.test-node"]).toBeDefined();
    expect(Object.values(snapshot.endpoints)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: response.targetAgentId,
        metadata: expect.objectContaining({ cardless: true }),
      }),
    ]));
  }, 15_000);

  test("refreshes registered local agents before resolving broker-owned delivery", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "openscout");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {});

    // Capability-only stubs: these tests queue work and never execute a harness.
    // Do not let a developer's installed binaries decide admission.
    const fakeBin = join(controlHome, "capability-bin");
    mkdirSync(fakeBin, { recursive: true });
    for (const name of ["codex", "claude", "tmux"]) {
      const path = join(fakeBin, name);
      writeFileSync(path, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    }
    const harness = await broker.startBroker({
      controlHome,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        OPENSCOUT_CODEX_BIN: join(fakeBin, "codex"),
        CODEX_BIN: join(fakeBin, "codex"),
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    await broker.postJson(harness.baseUrl, "/v1/deliver", {
      id: "deliver-prime-empty-registry-refresh",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "channel",
        channel: "shared",
      },
      body: "prime registry signature before refresh",
      intent: "tell",
      createdAt: Date.now(),
    });

    broker.writeRelayAgentRegistry(supportDirectory, {
      hudson: {
        agentId: "hudson",
        definitionId: "hudson",
        displayName: "Hudson",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-hudson-codex",
          wakePolicy: "on_demand",
        },
        capabilities: ["chat", "invoke", "deliver"],
      },
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      receipt?: { targetAgentId?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-hudson-after-registry-change",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@hudson",
      },
      body: "@hudson registry changed while the broker was already running",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toBe("hudson.test-node");
    expect(response.receipt?.targetAgentId).toBe("hudson.test-node");
  }, 15_000);

  test("routes harness-qualified labels as target params, not exact sessions", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "hudson");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {
      hudson: {
        agentId: "hudson",
        definitionId: "hudson",
        displayName: "Hudson",
        projectName: "Hudson",
        projectRoot,
        source: "manual",
        defaultHarness: "claude",
        runtime: {
          cwd: projectRoot,
          harness: "claude",
          transport: "tmux",
          sessionId: "relay-hudson-claude",
          wakePolicy: "on_demand",
        },
        capabilities: ["chat", "invoke", "deliver"],
      },
    });

    // Capability-only stubs: these tests queue work and never execute a harness.
    // Do not let a developer's installed binaries decide admission.
    const fakeBin = join(controlHome, "capability-bin");
    mkdirSync(fakeBin, { recursive: true });
    for (const name of ["codex", "claude", "tmux"]) {
      const path = join(fakeBin, name);
      writeFileSync(path, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    }
    const harness = await broker.startBroker({
      controlHome,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        OPENSCOUT_CODEX_BIN: join(fakeBin, "codex"),
        CODEX_BIN: join(fakeBin, "codex"),
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      flight?: { invocationId: string; targetAgentId: string };
      receipt?: { targetAgentId?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-hudson-codex-param",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@hudson.harness:codex",
      },
      body: "Hudson should receive this through a Codex-constrained route.",
      intent: "consult",
      ensureAwake: false,
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toBe("hudson.test-node");
    expect(response.receipt?.targetAgentId).toBe("hudson.test-node");

    const snapshot = await broker.getJson<{
      invocations: Record<string, { execution?: { harness?: string } }>;
    }>(harness.baseUrl, "/v1/snapshot");
    const invocation = snapshot.invocations[response.flight!.invocationId];
    expect(invocation?.execution?.harness).toBe("codex");
  }, 15_000);

  test("reconciles queued flights when their local agent is archived as stale", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "openscout");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {});

    const harness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    await broker.postJson(harness.baseUrl, "/v1/deliver", {
      id: "deliver-prime-empty-registry",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "channel",
        channel: "shared",
      },
      body: "prime registry signature",
      intent: "tell",
      createdAt: Date.now(),
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "hudson.main.mini",
      kind: "agent",
      definitionId: "hudson",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@hudson.main.node:mini",
      defaultSelector: "@hudson",
      displayName: "Hudson",
      handle: "hudson",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        source: "relay-agent-registry",
        projectRoot,
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    await broker.postJson(harness.baseUrl, "/v1/actors", { id: "operator", kind: "person", displayName: "Operator" });
    const accepted = await broker.seedQueuedInvocation(harness, {
      id: "inv-stale-race", requesterId: "operator", requesterNodeId: harness.nodeId,
      targetAgentId: "hudson.main.mini", task: "race before stale sync", action: "consult",
      ensureAwake: true, stream: false, createdAt: Date.now(),
    });

    expect(accepted.accepted).toBe(true);
    expect(accepted.flight?.targetAgentId).toBe("hudson.main.mini");
    const flightId = accepted.flight!.id;
    await broker.waitFor(
      () => broker.getJson<{ flights: Record<string, { state: string }> }>(harness.baseUrl, "/v1/snapshot"),
      (snapshot) => snapshot.flights[flightId]?.state === "queued",
    );

    broker.writeRelayAgentRegistry(supportDirectory, {
      hudson: {
        agentId: "hudson.test-node",
        definitionId: "hudson",
        displayName: "Hudson",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-hudson-codex",
          wakePolicy: "on_demand",
        },
        capabilities: ["chat", "invoke", "deliver"],
      },
    });

    await broker.postJson(harness.baseUrl, "/v1/deliver", {
      id: "deliver-trigger-stale-sync",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "channel",
        channel: "shared",
      },
      body: "trigger registry sync",
      intent: "tell",
      createdAt: Date.now(),
    });

    const reconciled = await broker.waitFor(
      () => broker.getJson<{
        agents: Record<string, { metadata?: Record<string, unknown> }>;
        endpoints: Record<string, { agentId: string; metadata?: Record<string, unknown> }>;
        flights: Record<string, { state: string; error?: string; metadata?: Record<string, unknown> }>;
      }>(harness.baseUrl, "/v1/snapshot"),
      (snapshot) => Boolean(
        snapshot.agents["hudson.test-node"]
        && snapshot.flights[flightId]?.state === "queued",
      ),
      { attempts: 120 },
    );

    expect(reconciled.agents["hudson.main.mini"]?.metadata?.staleLocalRegistration).not.toBe(true);
    expect(Object.values(reconciled.endpoints).some((endpoint) => (
      endpoint.agentId === "hudson.main.mini"
      && endpoint.metadata?.staleLocalRegistration === true
    ))).toBe(false);
    expect(reconciled.flights[flightId]).toMatchObject({
      state: "queued",
    });
    expect(reconciled.flights[flightId]?.metadata?.reconciledStaleFlight).not.toBe(true);
  }, 15_000);

  test("marks archived local registrations stale on the agent row", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const supportDirectory = join(controlHome, "support");
    const projectRoot = join(controlHome, "projects", "talkie");
    mkdirSync(projectRoot, { recursive: true });
    broker.writeRelayAgentRegistry(supportDirectory, {
      talkie: {
        agentId: "talkie",
        definitionId: "talkie",
        displayName: "Talkie",
        projectName: "Talkie",
        projectRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-talkie-codex",
          wakePolicy: "on_demand",
        },
        capabilities: ["chat", "invoke", "deliver"],
      },
    });

    const harness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
        OPENSCOUT_CORE_AGENTS: "",
        OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
        OPENSCOUT_NODE_QUALIFIER: "test-node",
      },
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "talkie.test-node",
      kind: "agent",
      definitionId: "talkie",
      nodeQualifier: "test-node",
      selector: "@talkie.node:test-node",
      defaultSelector: "@talkie",
      displayName: "Talkie",
      handle: "talkie",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        source: "relay-agent-registry",
        projectRoot,
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-talkie-old",
      agentId: "talkie.test-node",
      nodeId: harness.nodeId,
      harness: "codex",
      transport: "codex_app_server",
      state: "waiting",
      address: null,
      sessionId: "relay-talkie-codex",
      pane: null,
      cwd: projectRoot,
      projectRoot,
      metadata: {
        source: "relay-agent-registry",
        definitionId: "talkie",
        projectRoot,
      },
    });

    await Bun.sleep(5);
    broker.writeRelayAgentRegistry(supportDirectory, {});
    await broker.postJson(harness.baseUrl, "/v1/deliver", {
      id: "deliver-trigger-talkie-stale-sync",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "channel",
        channel: "shared",
      },
      body: "trigger registry sync",
      intent: "tell",
      createdAt: Date.now(),
    });

    const snapshot = await broker.waitFor(
      () => broker.getJson<{
        agents: Record<string, { metadata?: Record<string, unknown> }>;
        endpoints: Record<string, { state?: string; metadata?: Record<string, unknown> }>;
      }>(harness.baseUrl, "/v1/snapshot"),
      (value) => value.agents["talkie.test-node"]?.metadata?.staleLocalRegistration === true,
    );

    expect(snapshot.agents["talkie.test-node"]?.metadata?.staleLocalRegistration).toBe(true);
    expect(snapshot.endpoints["endpoint-talkie-old"]?.state).toBe("offline");
    expect(snapshot.endpoints["endpoint-talkie-old"]?.metadata?.staleLocalRegistration).toBe(true);
  }, 15_000);
});
