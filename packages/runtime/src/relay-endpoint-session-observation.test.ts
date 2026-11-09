import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEndpoint } from "@openscout/protocol";

import { buildCardlessSessionEndpoint } from "./broker-cardless-session.js";
import { flatDispatchSessionId } from "./broker-session-wake.js";
import { loadRegisteredLocalAgentBindings, type LocalAgentBinding } from "./local-agents.js";
import {
  latestTmuxSessionObservations,
  relayEndpointsTakingObservation,
  verifiedTmuxSessionObservation,
  withObservedTmuxSession,
} from "./relay-endpoint-session-observation.js";
import { sessionObservationMetadata, type LocalEndpointSessionObservation } from "./session-observation.js";

const NODE_ID = "node-test";
const CARD_ID = "session-mabc123-x1y2z3";
const CLAUDE_SESSION_ID = "11111111-2222-4333-8444-555555555555";
const RESUMED_SESSION_ID = "66666666-7777-4888-9999-aaaaaaaaaaaa";

const savedEnv = {
  OPENSCOUT_SUPPORT_DIRECTORY: process.env.OPENSCOUT_SUPPORT_DIRECTORY,
  OPENSCOUT_NODE_QUALIFIER: process.env.OPENSCOUT_NODE_QUALIFIER,
  OPENSCOUT_HOME: process.env.OPENSCOUT_HOME,
  OPENSCOUT_OPERATOR_NAME: process.env.OPENSCOUT_OPERATOR_NAME,
  OPENSCOUT_OPERATOR_HANDLE: process.env.OPENSCOUT_OPERATOR_HANDLE,
};
let tempRoot = "";
let projectRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "openscout-relay-observation-"));
  projectRoot = join(tempRoot, "projects", "demo");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(tempRoot, "support"), { recursive: true });
  mkdirSync(join(tempRoot, "home"), { recursive: true });
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(tempRoot, "support");
  process.env.OPENSCOUT_NODE_QUALIFIER = "test-node";
  process.env.OPENSCOUT_HOME = join(tempRoot, "home");
  process.env.OPENSCOUT_OPERATOR_NAME = "operator";
  process.env.OPENSCOUT_OPERATOR_HANDLE = "operator";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

/** The relay-agents.json entry Scout writes when it starts a session-backed tmux worker. */
async function relayBindingForTmuxWorker(definitionId: string, launchArgs: string[] = []): Promise<LocalAgentBinding> {
  writeFileSync(join(tempRoot, "support", "relay-agents.json"), JSON.stringify({
    version: 1,
    agents: {
      [definitionId]: {
        agentId: definitionId,
        definitionId,
        projectName: "demo",
        projectRoot,
        source: "manual",
        startedAt: 1_700_000_000,
        launchArgs,
        defaultHarness: "claude",
        harnessProfiles: {
          claude: { cwd: projectRoot, transport: "tmux", sessionId: definitionId, launchArgs },
        },
        runtime: { cwd: projectRoot, harness: "claude", transport: "tmux", sessionId: definitionId, wakePolicy: "on_demand" },
      },
    },
  }), "utf8");
  const [binding] = await loadRegisteredLocalAgentBindings(NODE_ID);
  if (!binding) throw new Error("relay binding was not built");
  return binding;
}

/** What Claude Code's process record for a tmux pane yields once the broker reads it. */
function tmuxObservation(tmuxSession: string, sessionId: string, observedAt: number): LocalEndpointSessionObservation {
  return {
    sessionId,
    runtime: { harness: "claude", model: "claude-test-model" },
    runtimeSource: "claude-session-record",
    evidence: {
      source: "claude-session-record",
      tmuxSession,
      tmuxPane: "%7",
      pid: 4242,
      recordPath: "/claude/sessions/4242.json",
      nameMatched: true,
      cwdMatched: true,
      liveCandidates: 1,
    },
    observedAt,
  };
}

function observed(endpoint: AgentEndpoint, observation: LocalEndpointSessionObservation): AgentEndpoint {
  return { ...endpoint, metadata: { ...endpoint.metadata, ...sessionObservationMetadata(endpoint, observation) } };
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The client's tmux rule, as the web roster applies it to agent metadata
 * merged with endpoint metadata: only an observed binding from Claude's
 * process record counts, and a disagreeing provider alias voids it.
 */
function clientTmuxHarnessSessionId(binding: LocalAgentBinding, endpoint: AgentEndpoint): string | null {
  const metadata = { ...binding.agent.metadata, ...endpoint.metadata } as Record<string, unknown>;
  if (metadata.pendingExternalSession === true || typeof metadata.externalSessionAdoptedAt === "number") return null;
  const observedId = metadataString(metadata, "observedSessionId");
  const evidence = metadata.observedSessionEvidence as Record<string, unknown> | undefined;
  if (!observedId || observedId === endpoint.sessionId || evidence?.source !== "claude-session-record") return null;
  for (const key of ["externalSessionId", "nativeSessionId", "threadId"]) {
    const alias = metadataString(metadata, key);
    if (alias && alias !== observedId) return null;
  }
  return observedId;
}

describe("Scout session card relay copy", () => {
  test("is built without a harness session, so clients cannot map it", async () => {
    const relay = await relayBindingForTmuxWorker(CARD_ID);

    expect(relay.agent.id).toBe(`${CARD_ID}.test-node`);
    expect(relay.endpoint.transport).toBe("tmux");
    expect(relay.endpoint.sessionId).toBe(CARD_ID);
    expect(relay.endpoint.metadata?.source).toBe("relay-agent-registry");
    expect(clientTmuxHarnessSessionId(relay, relay.endpoint)).toBeNull();
  });

  test("takes the verified observation recorded on the card's own endpoint", async () => {
    const relay = await relayBindingForTmuxWorker(CARD_ID);
    const card = observed(
      buildCardlessSessionEndpoint({ sessionId: CARD_ID, handle: "project-demo-1", transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: NODE_ID }),
      tmuxObservation(CARD_ID, CLAUDE_SESSION_ID, 2_000),
    );

    const [updated, ...rest] = relayEndpointsTakingObservation(card, [card, relay.endpoint]);

    expect(rest).toHaveLength(0);
    expect(updated?.id).toBe(relay.endpoint.id);
    expect(updated?.state).toBe(relay.endpoint.state);
    expect(updated?.sessionId).toBe(CARD_ID);
    expect(updated?.metadata?.observedSessionId).toBe(CLAUDE_SESSION_ID);
    expect(updated?.metadata?.observedSessionEvidence).toMatchObject({
      source: "claude-session-record",
      tmuxSession: CARD_ID,
      observedAt: 2_000,
      mirroredFromEndpointId: card.id,
    });
    // Native-id matching keeps resolving to the card's own endpoint only.
    expect(updated?.metadata?.externalSessionId).toBeUndefined();
    expect(clientTmuxHarnessSessionId(relay, updated!)).toBe(CLAUDE_SESSION_ID);
  });

  test("keeps the observation when the registry rebuilds the binding", async () => {
    const relay = await relayBindingForTmuxWorker(CARD_ID);
    const card = observed(
      buildCardlessSessionEndpoint({ sessionId: CARD_ID, transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: NODE_ID }),
      tmuxObservation(CARD_ID, CLAUDE_SESSION_ID, 2_000),
    );
    const [mirrored] = relayEndpointsTakingObservation(card, [relay.endpoint]);
    const rebuilt = await relayBindingForTmuxWorker(CARD_ID);

    // The card endpoint may have been retired; the relay copy's own record still carries it.
    const kept = withObservedTmuxSession(rebuilt.endpoint, latestTmuxSessionObservations([mirrored!]));

    expect(kept.metadata?.observedSessionId).toBe(CLAUDE_SESSION_ID);
    expect(kept.metadata?.observedSessionEvidence).toMatchObject({ mirroredFromEndpointId: card.id });
    expect(clientTmuxHarnessSessionId(rebuilt, kept)).toBe(CLAUDE_SESSION_ID);
  });

  test("stays unknown while Claude has not been observed in the tmux session", async () => {
    const relay = await relayBindingForTmuxWorker(CARD_ID);
    // A freshly registered card owes its provider id: nothing proves which Claude runs there.
    const pending = buildCardlessSessionEndpoint({ sessionId: CARD_ID, transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: NODE_ID });

    expect(pending.metadata?.pendingExternalSession).toBe(true);
    expect(relayEndpointsTakingObservation(pending, [relay.endpoint])).toEqual([]);
    expect(withObservedTmuxSession(relay.endpoint, latestTmuxSessionObservations([pending]))).toBe(relay.endpoint);
  });
});

describe("flat Claude relay copy", () => {
  test("does not trust the uuid in its handle before Claude is observed", async () => {
    const flatId = flatDispatchSessionId("claude", CLAUDE_SESSION_ID);
    const relay = await relayBindingForTmuxWorker(flatId, ["--resume", CLAUDE_SESSION_ID]);
    const flat = buildCardlessSessionEndpoint({
      sessionId: flatId,
      handle: flatId,
      transport: "tmux",
      harness: "claude",
      cwd: projectRoot,
      nodeId: NODE_ID,
      externalSessionId: CLAUDE_SESSION_ID,
      nativeSessionId: CLAUDE_SESSION_ID,
      flatDispatch: true,
    });

    // The requested resume id is what Scout asked for, not what Claude reported.
    expect(verifiedTmuxSessionObservation(flat)).toBeNull();
    expect(relayEndpointsTakingObservation(flat, [relay.endpoint])).toEqual([]);
    expect(clientTmuxHarnessSessionId(relay, relay.endpoint)).toBeNull();
  });

  test("takes the session Claude reports for the resumed tmux worker", async () => {
    const flatId = flatDispatchSessionId("claude", CLAUDE_SESSION_ID);
    const relay = await relayBindingForTmuxWorker(flatId, ["--resume", CLAUDE_SESSION_ID]);
    const flat = observed(buildCardlessSessionEndpoint({
      sessionId: flatId,
      handle: flatId,
      transport: "tmux",
      harness: "claude",
      cwd: projectRoot,
      nodeId: NODE_ID,
      externalSessionId: CLAUDE_SESSION_ID,
      nativeSessionId: CLAUDE_SESSION_ID,
      flatDispatch: true,
    }), tmuxObservation(flatId, CLAUDE_SESSION_ID, 3_000));

    const [updated] = relayEndpointsTakingObservation(flat, [relay.endpoint]);

    expect(relay.agent.id).toBe(`${flatId}.test-node`);
    expect(clientTmuxHarnessSessionId(relay, updated!)).toBe(CLAUDE_SESSION_ID);
  });

  test("reports the observed session when Claude runs a different one than the handle names", async () => {
    const flatId = flatDispatchSessionId("claude", CLAUDE_SESSION_ID);
    const relay = await relayBindingForTmuxWorker(flatId, ["--resume", CLAUDE_SESSION_ID]);
    const flat = observed(buildCardlessSessionEndpoint({
      sessionId: flatId,
      transport: "tmux",
      harness: "claude",
      cwd: projectRoot,
      nodeId: NODE_ID,
      externalSessionId: CLAUDE_SESSION_ID,
      nativeSessionId: CLAUDE_SESSION_ID,
      flatDispatch: true,
    }), tmuxObservation(flatId, RESUMED_SESSION_ID, 3_000));

    const [updated] = relayEndpointsTakingObservation(flat, [relay.endpoint]);

    expect(clientTmuxHarnessSessionId(relay, updated!)).toBe(RESUMED_SESSION_ID);
  });
});

describe("relay observation boundaries", () => {
  test("does not cross tmux sessions or nodes", async () => {
    const relay = await relayBindingForTmuxWorker(CARD_ID);
    const otherSession = observed(
      buildCardlessSessionEndpoint({ sessionId: "session-other-aaaaaa", transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: NODE_ID }),
      tmuxObservation("session-other-aaaaaa", CLAUDE_SESSION_ID, 2_000),
    );
    const otherNode = observed(
      buildCardlessSessionEndpoint({ sessionId: CARD_ID, transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: "node-peer" }),
      tmuxObservation(CARD_ID, CLAUDE_SESSION_ID, 2_000),
    );

    expect(relayEndpointsTakingObservation(otherSession, [relay.endpoint])).toEqual([]);
    expect(relayEndpointsTakingObservation(otherNode, [relay.endpoint])).toEqual([]);
    expect(withObservedTmuxSession(relay.endpoint, latestTmuxSessionObservations([otherSession, otherNode]))).toBe(relay.endpoint);
  });

  test("never writes into another session-backed endpoint", () => {
    const card = observed(
      buildCardlessSessionEndpoint({ sessionId: CARD_ID, transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: NODE_ID }),
      tmuxObservation(CARD_ID, CLAUDE_SESSION_ID, 2_000),
    );
    const sibling = buildCardlessSessionEndpoint({ sessionId: CARD_ID, transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: NODE_ID });
    const siblingCopy = { ...sibling, id: `${sibling.id}.copy` };

    expect(relayEndpointsTakingObservation(card, [siblingCopy])).toEqual([]);
  });

  test("ignores caller-adopted identity", async () => {
    const relay = await relayBindingForTmuxWorker(CARD_ID);
    const card = observed(
      buildCardlessSessionEndpoint({ sessionId: CARD_ID, transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: NODE_ID }),
      tmuxObservation(CARD_ID, CLAUDE_SESSION_ID, 2_000),
    );
    const adopted = { ...card, metadata: { ...card.metadata, externalSessionAdoptedAt: 1_500 } };

    expect(relayEndpointsTakingObservation(adopted, [relay.endpoint])).toEqual([]);
  });

  test("keeps the newer observation and clears a stale alias", async () => {
    const relay = await relayBindingForTmuxWorker(CARD_ID);
    const card = buildCardlessSessionEndpoint({ sessionId: CARD_ID, transport: "tmux", harness: "claude", cwd: projectRoot, nodeId: NODE_ID });
    const newer = observed(relay.endpoint, tmuxObservation(CARD_ID, RESUMED_SESSION_ID, 5_000));
    const older = observed(card, tmuxObservation(CARD_ID, CLAUDE_SESSION_ID, 2_000));

    expect(relayEndpointsTakingObservation(older, [newer])).toEqual([]);

    // A direct observation of the relay copy left an alias; a newer card observation replaces it.
    const stale = observed(relay.endpoint, tmuxObservation(CARD_ID, CLAUDE_SESSION_ID, 2_000));
    const fresh = observed(card, tmuxObservation(CARD_ID, RESUMED_SESSION_ID, 6_000));
    const [updated] = relayEndpointsTakingObservation(fresh, [stale]);

    expect(stale.metadata?.externalSessionId).toBe(CLAUDE_SESSION_ID);
    expect(updated?.metadata?.externalSessionId).toBeNull();
    expect(clientTmuxHarnessSessionId(relay, updated!)).toBe(RESUMED_SESSION_ID);
  });
});
