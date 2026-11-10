import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acpTurnCeilingMs,
  invokeAcpAgent,
  shutdownAcpAgentSession,
  shutdownAllAcpAgentSessions,
} from "./acp-agent-invocation.js";

const tempPaths = new Set<string>();

describe("acpTurnCeilingMs", () => {
  const original = process.env.OPENSCOUT_ACP_HARD_CEILING_MS;
  const originalMax = process.env.OPENSCOUT_ACP_HARD_CEILING_MAX_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENSCOUT_ACP_HARD_CEILING_MS;
    else process.env.OPENSCOUT_ACP_HARD_CEILING_MS = original;
    if (originalMax === undefined) delete process.env.OPENSCOUT_ACP_HARD_CEILING_MAX_MS;
    else process.env.OPENSCOUT_ACP_HARD_CEILING_MAX_MS = originalMax;
  });

  test("defaults to 60 minutes", () => {
    delete process.env.OPENSCOUT_ACP_HARD_CEILING_MS;
    expect(acpTurnCeilingMs({})).toBe(60 * 60_000);
  });

  test("OPENSCOUT_ACP_HARD_CEILING_MS overrides the default", () => {
    process.env.OPENSCOUT_ACP_HARD_CEILING_MS = `${5 * 60_000}`;
    expect(acpTurnCeilingMs({})).toBe(5 * 60_000);
    process.env.OPENSCOUT_ACP_HARD_CEILING_MS = "not-a-number";
    expect(acpTurnCeilingMs({})).toBe(60 * 60_000);
  });

  test("a requester timeoutMs of 24 hours does not change the ceiling", () => {
    delete process.env.OPENSCOUT_ACP_HARD_CEILING_MS;
    // The requester's wait budget is not an input to the turn budget — a
    // caller willing to wait a day does not license a day-long turn.
    const options = { timeoutMs: 24 * 60 * 60_000 };
    expect(acpTurnCeilingMs(options)).toBe(60 * 60_000);
  });

  test("an explicit hardCeilingMs (invocation execution.turnBudgetMs) overrides the configured default", () => {
    delete process.env.OPENSCOUT_ACP_HARD_CEILING_MS;
    expect(acpTurnCeilingMs({ hardCeilingMs: 4 * 60 * 60_000 })).toBe(4 * 60 * 60_000);
    // An explicit budget is authoritative — it may also lower the ceiling.
    expect(acpTurnCeilingMs({ hardCeilingMs: 5 * 60_000 })).toBe(5 * 60_000);
    process.env.OPENSCOUT_ACP_HARD_CEILING_MS = `${10 * 60_000}`;
    expect(acpTurnCeilingMs({ hardCeilingMs: 4 * 60 * 60_000 })).toBe(4 * 60 * 60_000);
  });

  test("any ceiling source is clamped to the administrator maximum (default 6 h)", () => {
    delete process.env.OPENSCOUT_ACP_HARD_CEILING_MS;
    delete process.env.OPENSCOUT_ACP_HARD_CEILING_MAX_MS;
    // A budget that somehow bypasses the HTTP schema's 6 h bound is still
    // clamped at runtime — the admin maximum is independent of the schema.
    expect(acpTurnCeilingMs({ hardCeilingMs: 24 * 60 * 60_000 })).toBe(6 * 60 * 60_000);
    // So is an oversized configured default.
    process.env.OPENSCOUT_ACP_HARD_CEILING_MS = `${24 * 60 * 60_000}`;
    expect(acpTurnCeilingMs({})).toBe(6 * 60 * 60_000);
  });

  test("OPENSCOUT_ACP_HARD_CEILING_MAX_MS lowers the administrator maximum", () => {
    delete process.env.OPENSCOUT_ACP_HARD_CEILING_MS;
    process.env.OPENSCOUT_ACP_HARD_CEILING_MAX_MS = `${30 * 60_000}`;
    expect(acpTurnCeilingMs({})).toBe(30 * 60_000);
    expect(acpTurnCeilingMs({ hardCeilingMs: 4 * 60 * 60_000 })).toBe(30 * 60_000);
    process.env.OPENSCOUT_ACP_HARD_CEILING_MAX_MS = "not-a-number";
    expect(acpTurnCeilingMs({})).toBe(60 * 60_000);
  });
});

afterEach(async () => {
  await shutdownAllAcpAgentSessions();
  for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
  tempPaths.clear();
});

test("returns the provider ACP session id and loads it on a follow-up invocation", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "openscout-acp-continuity-"));
  tempPaths.add(tempRoot);
  const executable = join(tempRoot, "fake-acp");
  const logPath = join(tempRoot, "methods.log");
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const log = process.env.METHOD_LOG;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const message = JSON.parse(line);
  const params = message.params ?? {};
  if (message.method) appendFileSync(log, message.method + ":" + (params.sessionId ?? "") + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }));
  } else if (message.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: process.env.NEW_SESSION_ID ?? "provider-session-42" } }));
  } else if (message.method === "session/load") {
    console.log(JSON.stringify(process.env.FAIL_LOAD === "1"
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "session not found" } }
      : { jsonrpc: "2.0", id: message.id, result: {} }));
  } else if (message.method === "session/prompt") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }));
  }
}
`, "utf8");
  chmodSync(executable, 0o755);

  const common = {
    adapterType: "cursor-acp" as const,
    label: "Cursor ACP test",
    sessionId: "scout-session",
    poolKey: "endpoint-cursor",
    cwd: tempRoot,
    prompt: "hello",
    adapterOptions: {
      command: executable,
      args: [],
      env: { METHOD_LOG: logPath },
      requireAuth: false,
      startupTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
    },
  };
  const originalEnv = process.env.METHOD_LOG;
  process.env.METHOD_LOG = logPath;
  try {
    const first = await invokeAcpAgent(common);
    expect(first.sessionId).toBe("provider-session-42");

    const second = await invokeAcpAgent({ ...common, prompt: "hello again" });
    expect(second.sessionId).toBe("provider-session-42");
    let log = readFileSync(logPath, "utf8");
    expect(log.match(/initialize:/g)).toHaveLength(1);
    expect(log.match(/session\/prompt:/g)).toHaveLength(2);
    expect(log).not.toContain("session/load:");

    await shutdownAcpAgentSession({
      adapterType: "cursor-acp",
      sessionId: common.sessionId,
      poolKey: common.poolKey,
    });
    const resumed = await invokeAcpAgent({ ...common, resumeSessionId: first.sessionId });
    expect(resumed.sessionId).toBe("provider-session-42");

    await shutdownAcpAgentSession({
      adapterType: "cursor-acp",
      sessionId: common.sessionId,
      poolKey: common.poolKey,
    });

    process.env.FAIL_LOAD = "1";
    process.env.NEW_SESSION_ID = "provider-session-43";
    const recovered = await invokeAcpAgent({ ...common, resumeSessionId: first.sessionId });
    expect(recovered.sessionId).toBe("provider-session-43");
    expect(recovered.metadata?.providerMeta).toMatchObject({
      acp: {
        sessionRecovery: {
          requestedSessionId: "provider-session-42",
          outcome: "new_session",
        },
      },
    });
    log = readFileSync(logPath, "utf8");
    expect(log).toContain("session/load:provider-session-42");
  } finally {
    delete process.env.FAIL_LOAD;
    delete process.env.NEW_SESSION_ID;
    if (originalEnv === undefined) delete process.env.METHOD_LOG;
    else process.env.METHOD_LOG = originalEnv;
  }
});

test("reports the provider ACP session id while the turn is still running", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "openscout-acp-native-early-"));
  tempPaths.add(tempRoot);
  const executable = join(tempRoot, "fake-acp");
  const releasePath = join(tempRoot, "release");
  // The prompt never answers until the release file exists, and only the
  // onNativeSession callback writes it. So the turn can finish only if the
  // native id was reported mid-turn, before any prompt result.
  writeFileSync(executable, `#!/usr/bin/env bun
import { existsSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }));
  } else if (message.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-native-7" } }));
  } else if (message.method === "session/prompt") {
    while (!existsSync(${JSON.stringify(releasePath)})) await new Promise((resolve) => setTimeout(resolve, 20));
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }));
  }
}
`, "utf8");
  chmodSync(executable, 0o755);

  const reported: string[] = [];
  const result = await invokeAcpAgent({
    adapterType: "cursor-acp",
    label: "ACP early identity test",
    sessionId: "scout-session-early",
    poolKey: "endpoint-early",
    cwd: tempRoot,
    prompt: "long task",
    adapterOptions: {
      command: executable,
      args: [],
      requireAuth: false,
      startupTimeoutMs: 2_000,
      requestTimeoutMs: 5_000,
    },
    onNativeSession: (nativeSessionId) => {
      reported.push(nativeSessionId);
      writeFileSync(releasePath, "go", "utf8");
    },
  });

  expect(reported).toEqual(["grok-native-7"]);
  expect(result.sessionId).toBe("grok-native-7");
  expect(result.output).toBe("done");
}, 15_000);
