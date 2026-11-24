import { afterEach, describe, expect, mock, test } from "bun:test";
import * as harnesses from "@openscout/runtime/harnesses";
import type { ScoutOutput } from "../output.ts";

const SUPPORTED_LOCAL_AGENT_HARNESSES = ["claude", "codex", "grok", "grok-acp", "kimi", "pi", "cursor", "opencode"];

afterEach(() => {
  mock.restore();
});

describe("runUpCommand", () => {
  test("passes the resolved agent definition through when starting by name", async () => {
    const resolveLocalAgentByName = mock(async (_name: string) => ({
      agentId: "smoke.main.mini",
      definitionId: "smoke",
      projectRoot: "/tmp/openscout",
    }));
    const upScoutAgent = mock(async (_input: unknown) => ({
      agentId: "smoke.main.mini",
      definitionId: "smoke",
      projectName: "Openscout",
      projectRoot: "/tmp/openscout",
      sessionId: "relay-smoke",
      startedAt: 123,
      harness: "codex",
      transport: "codex_app_server",
      isOnline: true,
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
      SUPPORTED_LOCAL_AGENT_HARNESSES,
    }));
    mock.module("../../lib/core/agents/service.ts", () => ({
      upScoutAgent,
    }));
    mock.module("../../lib/core/broker/service.ts", () => ({
      parseScoutHarness: (value?: string) => value,
      parseScoutLocalHarness: (value?: string) => value,
    }));

    const { runUpCommand } = await import("./up.ts");
    await runUpCommand({
      cwd: "/tmp/current",
      env: {},
      stdout: () => {},
      stderr: () => {},
      output,
      isTty: false,
    }, ["smoke"]);

    expect(resolveLocalAgentByName.mock.calls).toEqual([
      ["smoke"],
    ]);
    expect(upScoutAgent.mock.calls).toEqual([
      [{
        projectPath: "/tmp/openscout",
        agentName: "smoke",
        harness: undefined,
        model: undefined,
        provider: undefined,
        reasoningEffort: undefined,
        currentDirectory: "/tmp/current",
      }],
    ]);
    expect(writeValue).toHaveBeenCalledTimes(1);
  });

  test("rejects project-name aliases for named startup targets", async () => {
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

    mock.module("@openscout/runtime/harnesses", () => ({
      ...harnesses,
      resolveLocalAgentByName,
      SUPPORTED_LOCAL_AGENT_HARNESSES,
    }));
    mock.module("../../lib/core/agents/service.ts", () => ({
      upScoutAgent: mock(async () => {
        throw new Error("unexpected startup");
      }),
    }));
    mock.module("../../lib/core/broker/service.ts", () => ({
      parseScoutHarness: (value?: string) => value,
      parseScoutLocalHarness: (value?: string) => value,
    }));

    const { runUpCommand } = await import("./up.ts");
    const output: ScoutOutput = {
      mode: "plain",
      writeText: () => {},
      writeValue: () => {},
    };
    await expect(runUpCommand({
      cwd: "/tmp/current",
      env: {},
      stdout: () => {},
      stderr: () => {},
      output,
      isTty: false,
    }, ["openscout"])).rejects.toThrow(
      'unknown agent "openscout" — that matches project "/tmp/openscout", but the registered agent is "smoke.main.mini". Use `scout up smoke.main.mini` or `scout up "/tmp/openscout"`.',
    );
  });
});

test("up help and unsupported flags never resolve or start an agent", async () => {
  const resolveAgent = mock(async () => { throw new Error("unexpected lookup"); });
  const startAgent = mock(async () => { throw new Error("unexpected start"); });
  mock.module("@openscout/runtime/harnesses", () => ({
    ...harnesses,
    resolveLocalAgentByName: resolveAgent, SUPPORTED_LOCAL_AGENT_HARNESSES,
  }));
  mock.module("../../lib/core/agents/service.ts", () => ({ upScoutAgent: startAgent }));
  const writeText = mock(() => {});
  const context = {
    cwd: "/tmp/current", env: {}, stdout: () => {}, stderr: () => {}, isTty: false,
    output: { mode: "plain" as const, writeText, writeValue: mock(() => {}) },
  };
  const { runUpCommand } = await import("./up.ts");
  for (const flag of ["--help", "-h"]) await runUpCommand(context, [".", flag]);
  expect(writeText.mock.calls.length).toBe(2);
  for (const flag of ["--unsupported", "-x"]) {
    await expect(runUpCommand(context, [".", flag])).rejects.toThrow("unexpected argument");
  }
  expect(resolveAgent).not.toHaveBeenCalled();
  expect(startAgent).not.toHaveBeenCalled();
});
