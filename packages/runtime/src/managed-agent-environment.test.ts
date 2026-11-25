import { describe, expect, test } from "bun:test";

import {
  buildManagedAgentEnvironment,
  buildManagedAgentShellExports,
} from "./managed-agent-environment";

describe("buildManagedAgentEnvironment", () => {
  test("overrides the relay identity and context root for managed agent sessions", () => {
    const env = buildManagedAgentEnvironment({
      agentName: "dewey.node.workspace",
      currentDirectory: "/tmp/worktrees/feature-x",
      baseEnv: {
        PATH: "/usr/bin",
        OPENSCOUT_AGENT: "operator",
        OPENSCOUT_SETUP_CWD: "/tmp/old",
      },
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENSCOUT_AGENT).toBe("dewey.node.workspace");
    expect(env.OPENSCOUT_SETUP_CWD).toBe("/tmp/worktrees/feature-x");
    expect(env.OPENSCOUT_MANAGED_AGENT).toBe("1");
    expect(env.OPENSCOUT_CREW_ROLE).toBeUndefined();
  });

  test("exports OPENSCOUT_CREW_ROLE when a crew role is provided", () => {
    const env = buildManagedAgentEnvironment({
      agentName: "dewey.node.workspace",
      currentDirectory: "/tmp/worktrees/feature-x",
      crewRole: "worker",
      baseEnv: {},
    });
    expect(env.OPENSCOUT_CREW_ROLE).toBe("worker");
  });
});

describe("buildManagedAgentShellExports", () => {
  test("renders shell-safe exports for managed agent launch scripts", () => {
    expect(buildManagedAgentShellExports({
      agentName: "dewey.node.workspace",
      currentDirectory: "/tmp/worktrees/feature x",
    })).toEqual([
      'export OPENSCOUT_AGENT="dewey.node.workspace"',
      'export OPENSCOUT_SETUP_CWD="/tmp/worktrees/feature x"',
      'export OPENSCOUT_MANAGED_AGENT="1"',
    ]);
  });
});
