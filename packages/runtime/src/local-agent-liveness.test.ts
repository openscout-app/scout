import { expect, test } from "bun:test";
import type { AgentEndpoint } from "@openscout/protocol";
import { isLocalAgentEndpointAlive, isLocalAgentEndpointAliveAsync } from "./local-agents.js";

const external: AgentEndpoint = {
  id: "external-with-no-local-process", agentId: "cloud", nodeId: "local",
  harness: "devin", transport: "http", state: "idle", sessionId: "no-such-tmux-session",
  metadata: { externalSession: true, nativeSessionId: "devin-abcdef" },
};

test("external receive transports do not require a local tmux process", async () => {
  for (const transport of ["http", "mcp_poll", "devin_cloud_cli"] as const) {
    const endpoint = { ...external, transport };
    expect(isLocalAgentEndpointAlive(endpoint)).toBe(true);
    expect(await isLocalAgentEndpointAliveAsync(endpoint)).toBe(true);
    for (const state of ["offline", "failed", "stopped"] as const) {
      expect(isLocalAgentEndpointAlive({ ...endpoint, state })).toBe(false);
    }
  }
  // A generic HTTP record does not gain receive capability just from its state.
  expect(isLocalAgentEndpointAlive({ ...external, metadata: {} })).toBe(false);
});
