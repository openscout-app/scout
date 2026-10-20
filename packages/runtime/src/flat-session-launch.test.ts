import { expect, test } from "bun:test";
import type { AgentEndpoint, InvocationRequest } from "@openscout/protocol";
import { isDeliveryBlockedError } from "./delivery-blocked.js";
import { exactClaudeNativeSessionForDelivery, flatSessionEndpointLaunchArgs, requireClaudeNativeSessionBeforeDelivery } from "./local-agents.js";
import { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";

test("flat tmux Claude continuation explicitly resumes its requested native id", () => {
  const endpoint = { transport: "tmux", harness: "claude", metadata: { flatDispatch: true, nativeSessionId: "native-target", launchArgs: ["--model", "opus", "--continue", "--resume", "wrong", "--fork-session", "--session-id=wrong"] } } as AgentEndpoint;
  expect(flatSessionEndpointLaunchArgs(endpoint)).toEqual(["--model", "opus", "--resume", "native-target"]);
});

test("a fork endpoint branches from its live source until the fork's own transcript exists", () => {
  const endpoint = { transport: "tmux", harness: "claude", metadata: { flatDispatch: true, nativeSessionId: "fork-id", forkedFromSessionId: "source-id", launchArgs: ["--model", "opus", "--resume", "source-id"] } } as AgentEndpoint;
  expect(flatSessionEndpointLaunchArgs(endpoint, { claudeSessionExists: () => false }))
    .toEqual(["--model", "opus", "--resume", "source-id", "--fork-session", "--session-id", "fork-id"]);
  expect(flatSessionEndpointLaunchArgs(endpoint, { claudeSessionExists: (id) => id === "fork-id" }))
    .toEqual(["--model", "opus", "--resume", "fork-id"]);
});

test("a flat continuation without native identity cannot launch fresh", () => {
  expect(() => flatSessionEndpointLaunchArgs({ transport: "tmux", harness: "claude", metadata: { flatDispatch: true } } as AgentEndpoint)).toThrow("no native session id");
});

test("ordinary new Claude launches keep their launch arguments", () => {
  expect(flatSessionEndpointLaunchArgs({ transport: "tmux", harness: "claude", metadata: { launchArgs: ["--model", "opus"] } } as AgentEndpoint)).toEqual(["--model", "opus"]);
});


test("a forked flat endpoint guards delivery on the fork id the invocation targets", () => {
  const endpoint = { id: "endpoint.flat-claude-fork-id.node.tmux", sessionId: "flat-claude-fork-id", transport: "tmux", harness: "claude", metadata: { flatDispatch: true, nativeSessionId: "fork-id", forkedFromSessionId: "source-id" } } as AgentEndpoint;
  const invocation = { execution: { session: "existing", targetSessionId: "fork-id" } } as InvocationRequest;
  expect(exactClaudeNativeSessionForDelivery(endpoint, invocation)).toBe("fork-id");
});

test("pre-delivery native guard accepts only the observed requested session", async () => {
  await expect(requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => ({ sessionId: "native-target" }),
  })).resolves.toBeUndefined();
});

test("pre-delivery native guard rejects wrong live process immediately", async () => {
  let waits = 0;
  await expect(requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => ({ sessionId: "wrong-live-session" }),
    wait: async () => { waits += 1; },
  })).rejects.toThrow("no task was sent");
  expect(waits).toBe(0);
});

test("pre-delivery native guard bounds absent evidence and never authorizes delivery", async () => {
  let observations = 0;
  let waits = 0;
  await expect(requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => { observations += 1; return null; },
    wait: async () => { waits += 1; },
    attempts: 3,
  })).rejects.toThrow("no verified live process");
  expect(observations).toBe(3);
  expect(waits).toBe(2);
});

test("pre-delivery native guard allows startup evidence to arrive before sending", async () => {
  let observations = 0;
  await expect(requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => ++observations === 2 ? { sessionId: "native-target" } : null,
    wait: async () => {},
    attempts: 3,
  })).resolves.toBeUndefined();
  expect(observations).toBe(2);
});


test("all exact native tmux targets require the final identity guard", () => {
  const endpoint = { id: "endpoint", sessionId: "scout-session", transport: "tmux", harness: "claude", metadata: { tmuxSession: "pane-session" } } as AgentEndpoint;
  expect(exactClaudeNativeSessionForDelivery(endpoint, { execution: { targetSessionId: "native-target" } } as InvocationRequest)).toBe("native-target");
  expect(exactClaudeNativeSessionForDelivery(endpoint, { metadata: { targetSessionId: "metadata-native" } } as InvocationRequest)).toBe("metadata-native");
  for (const targetSessionId of ["endpoint", "scout-session", "pane-session"]) {
    expect(exactClaudeNativeSessionForDelivery(endpoint, { execution: { targetSessionId } } as InvocationRequest)).toBeNull();
  }
  expect(exactClaudeNativeSessionForDelivery({ ...endpoint, metadata: { flatDispatch: true, externalSessionId: "flat-native" } }, { execution: { targetSessionId: "scout-session" } } as InvocationRequest)).toBe("flat-native");
});

test("a canonical session address continues the endpoint's own native session", () => {
  const endpoint = { id: "endpoint", nodeId: "node-example", sessionId: "scout-session", transport: "tmux", harness: "claude", metadata: { tmuxSession: "pane-session", externalSessionId: "a4b8b9ef-ae5f-4072-b432-31627a320215" } } as AgentEndpoint;
  const handle = runtimeSessionHandleForEndpoint(endpoint)!;
  expect(exactClaudeNativeSessionForDelivery(endpoint, { execution: { targetSessionId: `${handle}@example` } } as InvocationRequest)).toBe("a4b8b9ef-ae5f-4072-b432-31627a320215");
  expect(exactClaudeNativeSessionForDelivery(endpoint, { execution: { targetSessionId: handle } } as InvocationRequest)).toBe("a4b8b9ef-ae5f-4072-b432-31627a320215");
});

test("a canonical address for another session is refused before delivery", () => {
  const endpoint = { id: "endpoint", nodeId: "node-example", transport: "tmux", harness: "claude", metadata: { externalSessionId: "native-a" } } as AgentEndpoint;
  const other = runtimeSessionHandleForEndpoint({ ...endpoint, metadata: { externalSessionId: "native-b" } })!;
  let thrown: unknown;
  try {
    exactClaudeNativeSessionForDelivery(endpoint, { execution: { targetSessionId: `${other}@example` } } as InvocationRequest);
  } catch (error) {
    thrown = error;
  }
  expect(isDeliveryBlockedError(thrown)).toBe(true);
  expect((thrown as Error).message).toContain("no task was sent");
});

test("a wrong live process is a blocked delivery, not a dead endpoint", async () => {
  const rejection = await requireClaudeNativeSessionBeforeDelivery("native-target", {
    observe: async () => ({ sessionId: "wrong-live-session" }),
  }).catch((error: unknown) => error);
  expect(isDeliveryBlockedError(rejection)).toBe(true);
});
