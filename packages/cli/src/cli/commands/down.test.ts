import { afterEach, describe, expect, mock, test } from "bun:test";
import * as harnesses from "@openscout/runtime/harnesses";
import type { ScoutOutput } from "../output.ts";

afterEach(() => {
  mock.restore();
});

describe("runDownCommand", () => {
  test("stops an agent resolved from a project-name alias", async () => {
    const downScoutAgent = mock(async (target: string) => {
      if (target === "openscout") {
        return null;
      }
      return {
        agentId: target,
        definitionId: "smoke",
        projectName: "Openscout",
        projectRoot: "/tmp/openscout",
        sessionId: "relay-smoke",
        startedAt: 123,
        harness: "codex",
        transport: "codex_app_server",
        isOnline: false,
        source: "manual",
      };
    });
    const resolveLocalAgentByName = mock(async (_name: string, options?: { matchProjectName?: boolean }) => {
      if (options?.matchProjectName) {
        return {
          agentId: "smoke.main.mini",
          definitionId: "smoke",
          projectRoot: "/tmp/openscout",
        };
      }
      return null;
    });
    const writeValue = mock(() => {});
    const output: ScoutOutput = {
      mode: "plain",
      writeText: mock(() => {}),
      writeValue,
    };

    mock.module("@openscout/runtime/harnesses", () => ({
      ...harnesses,
      resolveLocalAgentByName,
    }));
    mock.module("../../lib/core/agents/service.ts", () => ({
      downAllScoutAgents: mock(async () => []),
      downScoutAgent,
    }));
    mock.module("../../lib/ui/terminal/agents.ts", () => ({
      renderScoutAgentStatusList: () => "",
      renderScoutDownResult: () => "",
    }));

    const { runDownCommand } = await import("./down.ts");
    await runDownCommand({
      cwd: "/tmp/current",
      env: {},
      stdout: () => {},
      stderr: () => {},
      output,
      isTty: false,
    }, ["openscout"]);

    expect(resolveLocalAgentByName.mock.calls).toEqual([
      ["openscout"],
      ["openscout", { matchProjectName: true }],
    ]);
    expect(downScoutAgent.mock.calls).toEqual([
      ["openscout"],
      ["smoke.main.mini"],
    ]);
    expect(writeValue).toHaveBeenCalledTimes(1);
  });
});
