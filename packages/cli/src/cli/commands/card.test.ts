import { afterEach, describe, expect, mock, test } from "bun:test";
import * as harnesses from "@openscout/runtime/harnesses";
import type { ScoutOutput } from "../output.ts";

const SUPPORTED_LOCAL_AGENT_HARNESSES = ["claude", "codex", "grok", "grok-acp", "kimi", "pi", "cursor", "opencode"];

afterEach(() => {
  mock.restore();
});

function makeContext(output: ScoutOutput) {
  return {
    cwd: "/tmp/current",
    env: {},
    stdout: () => {},
    stderr: () => {},
    output,
    isTty: false,
  };
}

describe("runCardCommand", () => {
  test("updates an existing card through the supported service path", async () => {
    const resolveLocalAgentByName = mock(async (_name: string, _options?: { matchProjectName?: boolean }) => ({
      agentId: "talkie-drift.feat.node",
      definitionId: "talkie-drift",
      projectRoot: "/tmp/talkie",
    }));
    const updateScoutAgentCard = mock(async (_agentId: string, _input: Record<string, unknown>) => ({
      agentId: "talkie-drift.feat.node",
      editable: true,
      model: "claude-opus-4-7",
      permissionProfile: null,
      systemPrompt: "prompt",
      runtime: {
        cwd: "/tmp/talkie",
        harness: "claude",
        transport: "tmux",
        sessionId: "relay-talkie-drift-claude",
        wakePolicy: "on_demand",
      },
      launchArgs: ["--model", "claude-opus-4-7"],
      capabilities: ["chat", "invoke", "deliver"],
      applyMode: "restart",
      templateHint: "hint",
    }));
    const writeValue = mock(() => {});
    const output: ScoutOutput = {
      mode: "plain",
      writeText: mock(() => {}),
      writeValue,
    };

    mock.module("@openscout/runtime/harnesses", () => ({
      ...harnesses,
      resolveLocalAgentByName,
      resolveLocalAgentIdentity: mock(async () => {
        throw new Error("not used");
      }),
      SUPPORTED_LOCAL_AGENT_HARNESSES,
    }));
    mock.module("../../lib/core/agents/service.ts", () => ({
      cleanupScoutAgentCards: mock(async () => ({ inspected: 0, remaining: 0, retired: [] })),
      createScoutAgentCard: mock(async () => {
        throw new Error("not used");
      }),
      retireScoutAgentCard: mock(async () => null),
      updateScoutAgentCard,
    }));
    mock.module("../../lib/core/broker/service.ts", () => ({
      parseScoutLocalHarness: (value?: string) => value,
      resolveScoutAgentName: (value?: string) => value ?? "operator",
    }));
    mock.module("../../lib/ui/terminal/cards.ts", () => ({
      renderScoutAgentCard: mock(() => ""),
    }));

    const { runCardCommand } = await import("./card.ts");
    await runCardCommand(makeContext(output), [
      "update",
      "talkie-drift",
      "--harness",
      "claude",
      "--model",
      "claude-opus-4-7",
      "--restart",
    ]);

    expect(resolveLocalAgentByName.mock.calls).toEqual([
      ["talkie-drift"],
    ]);
    expect(updateScoutAgentCard.mock.calls).toEqual([
      ["talkie-drift.feat.node", {
        harness: "claude",
        model: "claude-opus-4-7",
        reasoningEffort: undefined,
        permissionProfile: undefined,
        restart: true,
      }],
    ]);
    expect(writeValue).toHaveBeenCalledTimes(1);
  });

  test("retires an existing card without touching SQLite directly", async () => {
    const resolveLocalAgentByName = mock(async (_name: string, _options?: { matchProjectName?: boolean }) => ({
      agentId: "talkie-drift.feat.node",
      definitionId: "talkie-drift",
      projectRoot: "/tmp/talkie",
    }));
    const retireScoutAgentCard = mock(async (_agentId: string) => ({
      agentId: "talkie-drift.feat.node",
      definitionId: "talkie-drift",
      projectName: "Talkie",
      projectRoot: "/tmp/talkie",
      sessionId: "relay-talkie-drift-codex",
      startedAt: 123,
      harness: "codex",
      transport: "codex_app_server",
      isOnline: false,
      source: "manual",
    }));
    const writeValue = mock(() => {});
    const output: ScoutOutput = {
      mode: "plain",
      writeText: mock(() => {}),
      writeValue,
    };

    mock.module("@openscout/runtime/harnesses", () => ({
      ...harnesses,
      resolveLocalAgentByName,
      resolveLocalAgentIdentity: mock(async () => {
        throw new Error("not used");
      }),
      SUPPORTED_LOCAL_AGENT_HARNESSES,
    }));
    mock.module("../../lib/core/agents/service.ts", () => ({
      cleanupScoutAgentCards: mock(async () => ({ inspected: 0, remaining: 0, retired: [] })),
      createScoutAgentCard: mock(async () => {
        throw new Error("not used");
      }),
      retireScoutAgentCard,
      updateScoutAgentCard: mock(async () => null),
    }));
    mock.module("../../lib/core/broker/service.ts", () => ({
      parseScoutLocalHarness: (value?: string) => value,
      resolveScoutAgentName: (value?: string) => value ?? "operator",
    }));
    mock.module("../../lib/ui/terminal/cards.ts", () => ({
      renderScoutAgentCard: mock(() => ""),
    }));

    const { runCardCommand } = await import("./card.ts");
    await runCardCommand(makeContext(output), ["retire", "talkie-drift"]);

    expect(resolveLocalAgentByName.mock.calls).toEqual([
      ["talkie-drift"],
    ]);
    expect(retireScoutAgentCard.mock.calls).toEqual([
      ["talkie-drift.feat.node"],
    ]);
    expect(writeValue).toHaveBeenCalledTimes(1);
  });
});
