import { afterEach, describe, expect, mock, test } from "bun:test";
import * as harnesses from "@openscout/runtime/harnesses";

afterEach(() => {
  mock.restore();
});

describe("agent service wiring", () => {
  test("uses the shared runtime agent service with desktop broker dependencies", async () => {
    const fixtureCard = {
      id: "alpha.test-node",
      agentId: "alpha.test-node",
      definitionId: "alpha",
      displayName: "Alpha Agent",
      handle: "alpha",
      projectRoot: "/tmp/alpha",
      currentDirectory: "/tmp/alpha",
      harness: "codex" as const,
      transport: "codex_app_server" as const,
      createdAt: 123,
      brokerRegistered: false,
      returnAddress: {
        actorId: "alpha.test-node",
        handle: "alpha",
      },
      metadata: {},
    };
    const createScoutAgentCard = mock(async (_input: unknown) => fixtureCard);
    const createScoutAgentService = mock((_deps: unknown) => ({
      createScoutAgentCard,
      downAllScoutAgents: mock(async () => []),
      downScoutAgent: mock(async () => null),
      loadScoutAgentStatuses: mock(async () => []),
      retireScoutAgentCard: mock(async () => null),
      restartScoutAgents: mock(async () => []),
      updateScoutAgentCard: mock(async () => null),
      upScoutAgent: mock(async (_input: unknown) => {
        throw new Error("unexpected up");
      }),
    }));
    mock.module("@openscout/runtime/harnesses", () => ({
      ...harnesses,
      createScoutAgentService,
    }));

    const { createScoutAgentCard: wiredCreateScoutAgentCard } = await import("./service.ts");
    const card = await wiredCreateScoutAgentCard({
      projectPath: "/tmp/alpha",
      currentDirectory: "/tmp/alpha",
    });

    expect(card.agentId).toBe("alpha.test-node");
    expect(createScoutAgentService.mock.calls).toHaveLength(1);
    const deps = createScoutAgentService.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof deps.loadScoutBrokerContext).toBe("function");
    expect(typeof deps.openScoutPeerSession).toBe("function");
    expect(typeof deps.registerScoutLocalAgentBinding).toBe("function");
    expect(typeof deps.retireScoutLocalAgentBinding).toBe("function");
    expect(createScoutAgentCard.mock.calls).toEqual([
      [{
        projectPath: "/tmp/alpha",
        currentDirectory: "/tmp/alpha",
      }],
    ]);
  });
});
