import { configureManagedPermissionHandler, withManagedPermissionContext } from "./managed-permission.js";
import type { InvocationRequest } from "@openscout/protocol";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { OBSERVED_HARNESS_TOPOLOGY_META_KEY } from "@openscout/agent-sessions";
import { getOrCreateCodexAppServerClient } from "@openscout/agent-sessions/local";
import {
  buildCodexAppServerSessionSnapshot,
  buildCodexRolloutSessionSnapshot,
  CodexAppServerExitError,
  ensureCodexAppServerAgentOnline,
  getCodexAppServerAgentSnapshot,
  invokeCodexAppServerAgent,
  isCodexAppServerExitError,
  isCodexAppServerAgentAlive,
  normalizeCodexAppServerLaunchArgs,
  readCodexAppServerModelFromLaunchArgs,
  readCodexAppServerReasoningEffortFromLaunchArgs,
  resolveCodexExecutableCandidates,
  sendCodexAppServerAgent,
  startCodexAppServerAgent,
  shutdownCodexAppServerAgent,
} from "./codex-app-server";

const tempPaths = new Set<string>();
const originalCodexBin = process.env.OPENSCOUT_CODEX_BIN;
const originalOpenAIAPIKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  configureManagedPermissionHandler(undefined);
  if (originalOpenAIAPIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIAPIKey;
  }
  if (originalCodexBin === undefined) {
    delete process.env.OPENSCOUT_CODEX_BIN;
  } else {
    process.env.OPENSCOUT_CODEX_BIN = originalCodexBin;
  }

  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

async function readTextFileEventually(
  filePath: string,
  predicate: (text: string) => boolean = () => true,
  timeoutMs = 1_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const text = readFileSync(filePath, "utf8");
      if (predicate(text)) {
        return text;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function writeFakeCodexExecutable(baseDirectory: string, firstTurnFailure?: string): string {
  const executablePath = join(baseDirectory, "fake-codex");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
let turns = 0;
const firstTurnFailure = ${JSON.stringify(firstTurnFailure ?? null)};

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    const threadId = String(params.threadId ?? "thread-unknown");
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    const thread = { id: threadId, path: \`/tmp/\${threadId}.jsonl\`, cwd };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "thread/start") {
    console.log(JSON.stringify({ id, error: { message: "thread/start should not be called in this test" } }));
    continue;
  }

  if (method === "turn/start") {
    const threadId = String(params.threadId ?? "thread-unknown");
    if (++turns === 1 && firstTurnFailure) {
      console.log(JSON.stringify({ id, result: { turn: { id: "turn-1" } } }));
      console.log(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "failed", error: { message: firstTurnFailure } } } }));
      continue;
    }
    // A different turn on this same thread finishes while our start RPC is in flight.
    console.log(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: "neighbor" } } }));
    console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId: "neighbor", itemId: "neighbor-msg", delta: "Unrelated output" } }));
    console.log(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "neighbor", status: "completed" } } }));
    console.log(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: "turn-1", status: "inProgress", items: [] } } }));
    console.log(JSON.stringify({ method: "item/started", params: { threadId, turnId: "turn-1", item: { type: "agentMessage", id: "msg-1", text: "" } } }));
    console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", itemId: "msg-1", delta: "Attached session reply" } }));
    console.log(JSON.stringify({ method: "item/completed", params: { threadId, turnId: "turn-1", item: { type: "agentMessage", id: "msg-1", text: "Attached session reply" } } }));
    console.log(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed", error: null } } }));
    console.log(JSON.stringify({ id, result: { turn: { id: "turn-1" } } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeMissingRolloutFakeCodexExecutable(baseDirectory: string): {
  executablePath: string;
  methodsPath: string;
  rolloutPath: string;
  startedThreadId: string;
} {
  const executablePath = join(baseDirectory, "fake-codex-missing-rollout");
  const methodsPath = join(baseDirectory, "methods.log");
  const rolloutPath = join(baseDirectory, "replacement-thread.jsonl");
  const startedThreadId = "replacement-thread";
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";

const methodsPath = ${JSON.stringify(methodsPath)};
const rolloutPath = ${JSON.stringify(rolloutPath)};
const startedThreadId = ${JSON.stringify(startedThreadId)};
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};
  appendFileSync(methodsPath, \`\${method}\\n\`, "utf8");

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    const threadId = String(params.threadId ?? "thread-unknown");
    console.log(JSON.stringify({ id, error: { message: \`no rollout found for thread id \${threadId}\` } }));
    continue;
  }

  if (method === "thread/start") {
    const thread = { id: startedThreadId, path: rolloutPath, cwd: params.cwd ?? null };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "turn/start") {
    writeFileSync(rolloutPath, "{}\\n", "utf8");
    const threadId = String(params.threadId ?? startedThreadId);
    const turn = { id: "turn-replacement", status: "inProgress", items: [] };
    console.log(JSON.stringify({ id, result: { turn } }));
    console.log(JSON.stringify({ method: "turn/started", params: { threadId, turn } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return { executablePath, methodsPath, rolloutPath, startedThreadId };
}

function writeHeldThreadFakeCodexExecutable(baseDirectory: string): {
  executablePath: string;
  methodsPath: string;
} {
  const executablePath = join(baseDirectory, "fake-codex-held-thread");
  const methodsPath = join(baseDirectory, "methods.log");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const methodsPath = ${JSON.stringify(methodsPath)};
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};
  appendFileSync(methodsPath, \`\${method}\\n\`, "utf8");

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    const threadId = String(params.threadId ?? "thread-unknown");
    console.log(JSON.stringify({ id, error: { code: -32600, message: \`thread/resume failed: thread \${threadId} already has an active writer\` } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return { executablePath, methodsPath };
}

function writeArgCaptureFakeCodexExecutable(baseDirectory: string): {
  executablePath: string;
  argsPath: string;
  envPath: string;
} {
  const executablePath = join(baseDirectory, "fake-codex-args");
  const argsPath = join(baseDirectory, "codex-args.json");
  const envPath = join(baseDirectory, "codex-env.json");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";
import { writeFileSync } from "node:fs";

writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), "utf8");
writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({
  CODEX_HOME: process.env.CODEX_HOME ?? null,
}), "utf8");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    const threadId = String(params.threadId ?? "thread-unknown");
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    const thread = { id: threadId, path: \`/tmp/\${threadId}.jsonl\`, cwd };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return { executablePath, argsPath, envPath };
}

function writeThreadParamCaptureFakeCodexExecutable(baseDirectory: string): {
  executablePath: string;
  paramsPath: string;
} {
  const executablePath = join(baseDirectory, "fake-codex-thread-params");
  const paramsPath = join(baseDirectory, "codex-thread-params.json");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";
import { writeFileSync } from "node:fs";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/start" || method === "thread/resume") {
    writeFileSync(${JSON.stringify(paramsPath)}, JSON.stringify({ method, params }), "utf8");
    const threadId = String(params.threadId ?? "thread-started");
    const thread = { id: threadId, path: \`/tmp/\${threadId}.jsonl\`, cwd: params.cwd ?? null };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return { executablePath, paramsPath };
}

function writeSteerableFakeCodexExecutable(baseDirectory: string): string {
  const executablePath = join(baseDirectory, "fake-codex-steer");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let activeThreadId = "thread-unknown";
let activeTurnId = "turn-1";

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/start") {
    activeThreadId = "thread-created-1";
    const thread = { id: activeThreadId, path: null, cwd: params.cwd };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "thread/resume") {
    const threadId = String(params.threadId ?? "thread-unknown");
    activeThreadId = threadId;
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    const thread = { id: threadId, path: \`/tmp/\${threadId}.jsonl\`, cwd };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "turn/start") {
    activeThreadId = String(params.threadId ?? activeThreadId);
    activeTurnId = "turn-1";
    console.log(JSON.stringify({ id, result: { turn: { id: activeTurnId } } }));
    console.log(JSON.stringify({ method: "turn/started", params: { threadId: activeThreadId, turn: { id: activeTurnId, status: "inProgress", items: [] } } }));
    continue;
  }

  if (method === "turn/steer") {
    console.log(JSON.stringify({ id, result: {} }));
    console.log(JSON.stringify({ method: "item/started", params: { threadId: activeThreadId, turnId: activeTurnId, item: { type: "agentMessage", id: "msg-1", text: "" } } }));
    console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: activeThreadId, turnId: activeTurnId, itemId: "msg-1", delta: "Steered current session reply" } }));
    console.log(JSON.stringify({ method: "item/completed", params: { threadId: activeThreadId, turnId: activeTurnId, item: { type: "agentMessage", id: "msg-1", text: "Steered current session reply" } } }));
    console.log(JSON.stringify({ method: "turn/completed", params: { threadId: activeThreadId, turn: { id: activeTurnId, status: "completed", error: null } } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeLateCompletionFakeCodexExecutable(baseDirectory: string): string {
  const executablePath = join(baseDirectory, "fake-codex-late-completion");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let activeThreadId = "thread-unknown";
let activeTurnId = "turn-1";

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    activeThreadId = String(params.threadId ?? "thread-unknown");
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    const thread = { id: activeThreadId, path: \`/tmp/\${activeThreadId}.jsonl\`, cwd };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "turn/start") {
    activeThreadId = String(params.threadId ?? activeThreadId);
    activeTurnId = "turn-1";
    console.log(JSON.stringify({ id, result: { turn: { id: activeTurnId } } }));
    console.log(JSON.stringify({ method: "turn/started", params: { threadId: activeThreadId, turn: { id: activeTurnId, status: "inProgress", items: [] } } }));
    setTimeout(() => {
      console.log(JSON.stringify({ method: "item/started", params: { threadId: activeThreadId, turnId: activeTurnId, item: { type: "agentMessage", id: "msg-1", text: "" } } }));
      console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: activeThreadId, turnId: activeTurnId, itemId: "msg-1", delta: "Late completion reply" } }));
      console.log(JSON.stringify({ method: "item/completed", params: { threadId: activeThreadId, turnId: activeTurnId, item: { type: "agentMessage", id: "msg-1", text: "Late completion reply" } } }));
      console.log(JSON.stringify({ method: "turn/completed", params: { threadId: activeThreadId, turn: { id: activeTurnId, status: "completed", error: null } } }));
    }, 150);
    continue;
  }

  if (method === "turn/interrupt") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeHangingFakeCodexExecutable(baseDirectory: string): string {
  const executablePath = join(baseDirectory, "fake-codex-hanging");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.0.0");
  process.exit(0);
}

// The launch first asks "codex mcp get scout --json". A real Codex answers
// at once; this home has no scout entry. Only the app-server hangs.
if (process.argv[2] === "mcp") {
  console.error("No MCP server named 'scout' found.");
  process.exit(1);
}

setInterval(() => {}, 1_000);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    const threadId = String(params.threadId ?? "thread-unknown");
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    const thread = { id: threadId, path: \`/tmp/\${threadId}.jsonl\`, cwd };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "turn/start") {
    const threadId = String(params.threadId ?? "thread-unknown");
    console.log(JSON.stringify({ id, result: { turn: { id: "turn-hanging" } } }));
    console.log(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: "turn-hanging", status: "inProgress", items: [] } } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeSigtermOnTurnFakeCodexExecutable(baseDirectory: string): string {
  const executablePath = join(baseDirectory, "fake-codex-sigterm-on-turn");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let activeThreadId = "thread-unknown";

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    activeThreadId = String(params.threadId ?? "thread-unknown");
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    const thread = { id: activeThreadId, path: \`/tmp/\${activeThreadId}.jsonl\`, cwd };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "turn/start") {
    activeThreadId = String(params.threadId ?? activeThreadId);
    console.log(JSON.stringify({ id, result: { turn: { id: "turn-sigterm" } } }));
    console.log(JSON.stringify({ method: "turn/started", params: { threadId: activeThreadId, turn: { id: "turn-sigterm", status: "inProgress", items: [] } } }));
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 10);
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeDynamicToolFakeCodexExecutable(baseDirectory: string, serverMethod = "item/tool/call", decisions?: string[]): {
  executablePath: string;
  responsePath: string;
} {
  const executablePath = join(baseDirectory, "fake-codex-dynamic-tool");
  const responsePath = join(baseDirectory, "dynamic-tool-response.json");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let activeThreadId = "thread-unknown";

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    activeThreadId = String(params.threadId ?? "thread-unknown");
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    const thread = { id: activeThreadId, path: \`/tmp/\${activeThreadId}.jsonl\`, cwd };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "turn/start") {
    activeThreadId = String(params.threadId ?? activeThreadId);
    console.log(JSON.stringify({ id, result: { turn: { id: "turn-1" } } }));
    console.log(JSON.stringify({ method: "turn/started", params: { threadId: activeThreadId, turn: { id: "turn-1", status: "inProgress", items: [] } } }));
    console.log(JSON.stringify({
      id: "server-request-1",
      method: ${JSON.stringify(serverMethod)},
      params: {
        availableDecisions: ${JSON.stringify(decisions) ?? "undefined"},
        threadId: activeThreadId,
        turnId: "turn-1",
        callId: "call-1",
        tool: "read_thread_terminal",
        arguments: {},
      },
    }));
    continue;
  }

  if (id === "server-request-1") {
    writeFileSync(${JSON.stringify(responsePath)}, JSON.stringify(message, null, 2));
    console.log(JSON.stringify({ method: "item/started", params: { threadId: activeThreadId, turnId: "turn-1", item: { type: "agentMessage", id: "msg-1", text: "" } } }));
    console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: activeThreadId, turnId: "turn-1", itemId: "msg-1", delta: "Recovered after tool rejection" } }));
    console.log(JSON.stringify({ method: "item/completed", params: { threadId: activeThreadId, turnId: "turn-1", item: { type: "agentMessage", id: "msg-1", text: "Recovered after tool rejection" } } }));
    console.log(JSON.stringify({ method: "turn/completed", params: { threadId: activeThreadId, turn: { id: "turn-1", status: "completed", error: null } } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return { executablePath, responsePath };
}

describe("buildCodexAppServerSessionSnapshot", () => {
  test("projects agent messages and tool activity from app-server history", () => {
    const raw = [
      JSON.stringify({
        id: "2",
        result: {
          thread: {
            id: "thread-1",
            path: "/tmp/thread-1.jsonl",
            cwd: "/repo",
          },
          model: "gpt-5.4",
        },
      }),
      JSON.stringify({
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: { type: "active" },
        },
      }),
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      }),
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-1", text: "" },
        },
      }),
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Hello from Codex",
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-1", text: "Hello from Codex" },
        },
      }),
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "webSearch", id: "ws-1", query: "", action: { type: "other" } },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webSearch",
            id: "ws-1",
            query: "latest traces",
            action: { type: "search", queries: ["latest traces"] },
          },
        },
      }),
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null },
        },
      }),
    ].join("\n");

    const snapshot = buildCodexAppServerSessionSnapshot(raw, {
      agentName: "amplink",
      sessionId: "relay-amplink",
      cwd: "/repo",
    }, "thread-1");

    expect(snapshot).not.toBeNull();
    expect(snapshot?.session.model).toBe("gpt-5.4");
    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.turns[0]?.status).toBe("completed");
    expect(snapshot?.turns[0]?.blocks).toHaveLength(2);
    expect(snapshot?.turns[0]?.blocks[0]?.block.type).toBe("text");
    expect(snapshot?.turns[0]?.blocks[0]?.block.type === "text" && snapshot.turns[0].blocks[0].block.text).toBe("Hello from Codex");
    expect(snapshot?.turns[0]?.blocks[1]?.block.type).toBe("action");
    if (snapshot?.turns[0]?.blocks[1]?.block.type === "action") {
      expect(snapshot.turns[0].blocks[1].block.action.toolName).toBe("webSearch");
      expect(snapshot.turns[0].blocks[1].block.action.output).toContain("latest traces");
    }
  });

  test("projects observed Codex subagent topology from app-server history", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-snapshot-topology-"));
    tempPaths.add(tempRoot);

    const raw = [
      JSON.stringify({
        id: "2",
        result: {
          thread: {
            id: "thread-parent",
            path: "/tmp/thread-parent.jsonl",
            cwd: tempRoot,
          },
        },
      }),
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-parent",
          turnId: "turn-1",
          item: {
            type: "collabToolCall",
            id: "collab-1",
            tool: "spawn_agent",
            senderThreadId: "thread-parent",
            receiverThreadId: "thread-child",
            prompt: "Check the database migration.",
            agentStatus: "inProgress",
          },
        },
      }),
    ].join("\n");

    const snapshot = buildCodexAppServerSessionSnapshot(raw, {
      agentName: "codex-parent",
      sessionId: "relay-codex-parent",
      cwd: tempRoot,
    }, "thread-parent");

    const topology = snapshot?.session.providerMeta?.[OBSERVED_HARNESS_TOPOLOGY_META_KEY] as Record<string, unknown> | undefined;
    expect(topology).toEqual(expect.objectContaining({
      ownership: "harness_observed",
      source: "codex-subagents",
      agents: expect.arrayContaining([
        expect.objectContaining({ id: "codex-thread-agent:thread-parent", role: "lead" }),
        expect.objectContaining({ id: "codex-thread-agent:thread-child", role: "subagent" }),
      ]),
      tasks: expect.arrayContaining([
        expect.objectContaining({
          id: "codex-task:collab-1",
          title: "Check the database migration.",
          assigneeId: "codex-thread-agent:thread-child",
        }),
      ]),
    }));
  });

  test("ignores item events without a thread id once the target thread is known", () => {
    const raw = [
      JSON.stringify({
        id: "2",
        result: {
          thread: {
            id: "thread-1",
            path: "/tmp/thread-1.jsonl",
            cwd: "/repo",
          },
          model: "gpt-5.4",
        },
      }),
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      }),
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-ignored", text: "wrong session bleed" },
        },
      }),
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-1", text: "kept" },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-1", text: "kept" },
        },
      }),
    ].join("\n");

    const snapshot = buildCodexAppServerSessionSnapshot(raw, {
      agentName: "amplink",
      sessionId: "relay-amplink",
      cwd: "/repo",
    }, "thread-1");

    expect(snapshot).not.toBeNull();
    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.turns[0]?.blocks).toHaveLength(1);
    expect(snapshot?.turns[0]?.blocks[0]?.block.type).toBe("text");
    expect(snapshot?.turns[0]?.blocks[0]?.block.type === "text" && snapshot.turns[0].blocks[0].block.text).toBe("kept");
  });

  test("includes user messages so local trace reflects both sides of the turn", () => {
    const raw = [
      JSON.stringify({
        id: "2",
        result: {
          thread: {
            id: "thread-1",
            path: "/tmp/thread-1.jsonl",
            cwd: "/repo",
          },
          model: "gpt-5.4",
        },
      }),
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "ping from local codex chat" }],
          },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "pong",
          },
        },
      }),
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null },
        },
      }),
    ].join("\n");

    const snapshot = buildCodexAppServerSessionSnapshot(raw, {
      agentName: "amplink",
      sessionId: "relay-amplink",
      cwd: "/repo",
    }, "thread-1");

    expect(snapshot).not.toBeNull();
    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.turns[0]?.blocks).toHaveLength(2);
    expect(snapshot?.turns[0]?.blocks[0]?.block.type).toBe("text");
    expect(snapshot?.turns[0]?.blocks[0]?.block.type === "text" && snapshot.turns[0].blocks[0].block.text)
      .toBe("ping from local codex chat");
    expect(snapshot?.turns[0]?.blocks[1]?.block.type).toBe("text");
    expect(snapshot?.turns[0]?.blocks[1]?.block.type === "text" && snapshot.turns[0].blocks[1].block.text)
      .toBe("pong");
  });

  test("prefers the canonical rollout thread file when runtime state provides a thread path", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-rollout-test-"));
    tempPaths.add(tempRoot);

    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(logsDirectory, { recursive: true });

    const rolloutPath = join(tempRoot, "rollout-thread-1.jsonl");
    const rollout = [
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.000Z",
        type: "session_meta",
        payload: {
          id: "thread-1",
          cwd: "/repo",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.100Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
          started_at: 1776390878,
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.200Z",
        type: "turn_context",
        payload: {
          turn_id: "turn-1",
          cwd: "/repo",
          model: "gpt-5.4",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.300Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from the real thread" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.400Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "echo hi" }),
          call_id: "call-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.500Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "hi\n",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.600Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          completed_at: 1776390878,
        },
      }),
    ].join("\n");
    writeFileSync(rolloutPath, rollout, "utf8");

    writeFileSync(join(runtimeDirectory, "state.json"), JSON.stringify({
      threadId: "thread-1",
      threadPath: rolloutPath,
    }, null, 2));
    writeFileSync(join(runtimeDirectory, "codex-thread-id.txt"), "thread-1\n");
    writeFileSync(join(logsDirectory, "stdout.log"), [
      JSON.stringify({
        id: "1",
        result: {
          thread: {
            id: "thread-1",
            path: "/tmp/thread-1.jsonl",
            cwd: "/repo",
          },
          model: "gpt-5.4",
        },
      }),
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-stale", status: "inProgress", items: [] },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-stale",
          item: { type: "agentMessage", id: "msg-stale", text: "stale stdout log" },
        },
      }),
    ].join("\n"), "utf8");

    const snapshot = await getCodexAppServerAgentSnapshot({
      agentName: "codex-here",
      sessionId: "attached-codex-here",
      cwd: "/repo",
      systemPrompt: "unused",
      runtimeDirectory,
      logsDirectory,
      threadId: "thread-1",
      launchArgs: [],
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.session.providerMeta?.threadId).toBe("thread-1");
    expect(snapshot?.session.providerMeta?.threadPath).toBe(rolloutPath);
    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.turns[0]?.id).toBe("turn-1");
    expect(snapshot?.turns[0]?.blocks).toHaveLength(2);
    expect(snapshot?.turns[0]?.blocks[0]?.block.type).toBe("text");
    expect(snapshot?.turns[0]?.blocks[0]?.block.type === "text" && snapshot.turns[0].blocks[0].block.text).toBe("Hello from the real thread");
    expect(snapshot?.turns[0]?.blocks[1]?.block.type).toBe("action");
    if (snapshot?.turns[0]?.blocks[1]?.block.type === "action") {
      expect(snapshot.turns[0].blocks[1].block.action.toolName).toBe("exec_command");
      expect(snapshot.turns[0].blocks[1].block.action.output).toBe("hi\n");
    }
  });

  test("captures Codex rollout token usage and quota windows", () => {
    const observedAt = Date.parse("2026-04-17T01:54:39.000Z");
    const weeklyResetAt = Date.parse("2026-04-24T00:00:00.000Z");
    const raw = [
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.000Z",
        type: "session_meta",
        payload: {
          id: "thread-budget",
          cwd: "/repo",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.100Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-budget",
          model_context_window: 200000,
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.200Z",
        type: "turn_context",
        payload: {
          turn_id: "turn-budget",
          cwd: "/repo",
          model: "gpt-5.4",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:39.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            model_context_window: 200000,
            total_token_usage: {
              input_tokens: 501000,
              cached_input_tokens: 250,
              output_tokens: 80,
              reasoning_output_tokens: 20,
              total_tokens: 501080,
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 250,
              output_tokens: 80,
              reasoning_output_tokens: 20,
              total_tokens: 1080,
            },
          },
          rate_limits: {
            plan_type: "plus",
            primary: {
              used_percent: 64,
              reset_after_seconds: 1800,
              window_minutes: 300,
            },
            secondary: {
              percent_remaining: 72,
              reset_at: "2026-04-24T00:00:00.000Z",
              window_seconds: 604800,
              used: 28,
              limit: 100,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:40.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-budget",
        },
      }),
    ].join("\n");

    const snapshot = buildCodexRolloutSessionSnapshot(
      raw,
      {
        agentName: "codex-budget",
        sessionId: "attached-codex-budget",
        cwd: "/repo",
      },
      "thread-budget",
      "/tmp/budget-thread.jsonl",
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.session.providerMeta?.observeUsage).toEqual(expect.objectContaining({
      contextInputTokens: 1000,
      inputTokens: 501000,
      cacheReadInputTokens: 250,
      outputTokens: 80,
      reasoningOutputTokens: 20,
      totalTokens: 501080,
      contextWindowTokens: 200000,
      planType: "plus",
    }));
    expect(snapshot?.session.providerMeta?.observeQuota).toEqual(expect.objectContaining({
      provider: "openai",
      planType: "plus",
      capturedAt: observedAt,
    }));
    expect(snapshot?.session.providerMeta?.observeQuota?.windows).toEqual([
      expect.objectContaining({
        label: "5h",
        windowKind: "primary",
        usedPercent: 64,
        resetAt: observedAt + 1800 * 1000,
        windowMs: 300 * 60 * 1000,
      }),
      expect.objectContaining({
        label: "7d",
        windowKind: "secondary",
        percentRemaining: 72,
        resetAt: weeklyResetAt,
        windowMs: 604800 * 1000,
        used: 28,
        limit: 100,
      }),
    ]);
  });

  test("retires a quiet unfinished rollout turn when no blocks are still streaming", () => {
    const rolloutPath = "/tmp/quiet-thread.jsonl";
    const raw = [
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.000Z",
        type: "session_meta",
        payload: {
          id: "thread-quiet",
          cwd: "/repo",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.100Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-quiet",
          started_at: "2026-04-17T01:54:38.100Z",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:40.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "echo done" }),
          call_id: "call-quiet",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:41.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-quiet",
          output: "done\n",
        },
      }),
    ].join("\n");

    const snapshot = buildCodexRolloutSessionSnapshot(
      raw,
      {
        agentName: "codex-quiet",
        sessionId: "attached-codex-quiet",
        cwd: "/repo",
      },
      "thread-quiet",
      rolloutPath,
      {
        nowMs: Date.parse("2026-04-17T02:05:00.000Z"),
        staleActiveTurnMs: 10 * 60 * 1000,
      },
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.session.status).toBe("idle");
    expect(snapshot?.currentTurnId).toBeUndefined();
    expect(snapshot?.turns[0]?.status).toBe("interrupted");
    expect(snapshot?.turns[0]?.endedAt).toBe(Date.parse("2026-04-17T01:54:41.000Z"));
    expect(snapshot?.session.providerMeta?.threadPath).toBe(rolloutPath);
    expect(snapshot?.session.providerMeta?.observeRuntime).toEqual(expect.objectContaining({
      staleActiveTurn: true,
      staleActiveTurnReason: "No Codex rollout activity after an unfinished turn.",
    }));
  });

  test("keeps a quiet rollout active when a tool block is still streaming", () => {
    const raw = [
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.000Z",
        type: "session_meta",
        payload: {
          id: "thread-active-tool",
          cwd: "/repo",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:38.100Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-active-tool",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T01:54:40.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "sleep 900" }),
          call_id: "call-active-tool",
        },
      }),
    ].join("\n");

    const snapshot = buildCodexRolloutSessionSnapshot(
      raw,
      {
        agentName: "codex-active-tool",
        sessionId: "attached-codex-active-tool",
        cwd: "/repo",
      },
      "thread-active-tool",
      "/tmp/active-tool-thread.jsonl",
      {
        nowMs: Date.parse("2026-04-17T02:05:00.000Z"),
        staleActiveTurnMs: 10 * 60 * 1000,
      },
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.session.status).toBe("active");
    expect(snapshot?.currentTurnId).toBe("turn-active-tool");
    expect(snapshot?.turns[0]?.status).toBe("streaming");
    expect(snapshot?.session.providerMeta?.observeRuntime).not.toEqual(expect.objectContaining({
      staleActiveTurn: true,
    }));
  });
});

describe("ensureCodexAppServerAgentOnline", () => {
  test("classifies encoded SIGTERM exit codes as external interruptions", () => {
    const error = new CodexAppServerExitError({
      agentName: "codex-encoded-sigterm",
      exitCode: 143,
      signal: null,
    });

    expect(error.exitKind).toBe("external_sigterm");
    expect(error.noteworthy).toBe(true);
    expect(error.message).toBe("Codex app-server for codex-encoded-sigterm was interrupted by SIGTERM.");
  });

  test("keeps bundled Codex app candidates before PATH candidates for inventory", () => {
    const candidates = resolveCodexExecutableCandidates({
      HOME: "/Users/tester",
      PATH: ["/custom/bin", "/opt/homebrew/bin"].join(delimiter),
    });

    expect(candidates.indexOf("/custom/bin/codex")).toBeGreaterThan(-1);
    expect(candidates.indexOf("/Applications/Codex.app/Contents/Resources/codex")).toBeGreaterThan(-1);
    expect(candidates.indexOf("/Applications/Codex.app/Contents/Resources/codex")).toBeLessThan(
      candidates.indexOf("/custom/bin/codex"),
    );
  });

  test("keeps explicit Codex binary overrides first", () => {
    expect(resolveCodexExecutableCandidates({
      HOME: "/Users/tester",
      PATH: "/custom/bin",
      OPENSCOUT_CODEX_BIN: "/explicit/codex",
      CODEX_BIN: "/fallback/codex",
    }).slice(0, 2)).toEqual([
      "/explicit/codex",
      "/fallback/codex",
    ]);
  });

  test("reports a missing working directory before spawning Codex", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-missing-cwd-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const missingCwd = join(tempRoot, "missing-project");

    const options = {
      agentName: "codex-missing-cwd",
      sessionId: "attached-codex-missing-cwd",
      cwd: missingCwd,
      systemPrompt: "Start a session.",
      runtimeDirectory,
      logsDirectory,
      launchArgs: [],
    } as const;

    await expect(ensureCodexAppServerAgentOnline(options)).rejects.toThrow(
      `Codex app-server cwd does not exist for codex-missing-cwd: ${missingCwd}`,
    );

    const stderr = readFileSync(join(logsDirectory, "stderr.log"), "utf8");
    expect(stderr).toContain(`Codex app-server cwd does not exist for codex-missing-cwd: ${missingCwd}`);
  });

  for (const reason of ["Selected model is at capacity (serverOverloaded)", "Provider refused this turn's content"]) {
    test(`a rejected turn leaves the same Codex process ready for its next turn: ${reason}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "codex-failed-turn-")); tempPaths.add(root);
      process.env.OPENSCOUT_CODEX_BIN = writeFakeCodexExecutable(root, reason);
      const deltas: string[] = [];
      const options = { agentName: "failed-turn", sessionId: "failed-turn", cwd: root, systemPrompt: "Fixture",
        onDelta: (delta: string) => deltas.push(delta),
        threadId: "thread-fixture", requireExistingThread: true, runtimeDirectory: join(root, "runtime"), logsDirectory: join(root, "logs") };
      try {
        const first = await ensureCodexAppServerAgentOnline(options);
        expect(first.codexAppServer?.pid).toBeGreaterThan(0);
        await expect(invokeCodexAppServerAgent({ ...options, prompt: "Fail this turn" })).rejects.toThrow(reason);
        expect(isCodexAppServerAgentAlive(options)).toBe(true);
        const next = await ensureCodexAppServerAgentOnline(options);
        expect(next.codexAppServer?.pid).toBe(first.codexAppServer?.pid);
        const result = await invokeCodexAppServerAgent({ ...options, prompt: "Deliver the next turn" });
        expect(result.output).toBe("Attached session reply");
        expect(deltas.join("")).toBe("Attached session reply");
      } finally { await shutdownCodexAppServerAgent(options); }
    });
  }

  test("keeps a new thread provisional until its first rollout-backed turn", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-provisional-thread-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const threadIdPath = join(runtimeDirectory, "codex-thread-id.txt");
    const fixture = writeMissingRolloutFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = fixture.executablePath;

    const options = {
      agentName: "codex-provisional-thread",
      sessionId: "codex-provisional-thread",
      cwd: process.cwd(),
      systemPrompt: "Start a new session.",
      runtimeDirectory,
      logsDirectory,
      launchArgs: [],
    } as const;

    try {
      const online = await ensureCodexAppServerAgentOnline(options);
      expect(online).toEqual({
        threadId: fixture.startedThreadId,
        durableThreadId: null,
        codexAppServer: expect.objectContaining({ connection: "spawned", socketPath: null, capabilityGaps: [] }),
      });
      expect(existsSync(threadIdPath)).toBe(false);

      await startCodexAppServerAgent({
        ...options,
        prompt: "Create the first rollout.",
      });

      const durable = await ensureCodexAppServerAgentOnline(options);
      expect(durable).toEqual({
        threadId: fixture.startedThreadId,
        durableThreadId: fixture.startedThreadId,
        codexAppServer: expect.objectContaining({ connection: "spawned" }),
      });
      expect(readFileSync(threadIdPath, "utf8").trim()).toBe(fixture.startedThreadId);
      const methods = readFileSync(fixture.methodsPath, "utf8");
      expect(methods).toContain("thread/start\nturn/start\n");
      expect(methods).not.toContain("thread/resume");
    } finally {
      await shutdownCodexAppServerAgent(options, { resetThread: true });
    }
  });

  test("replaces a missing stored rollout without caching the new thread before its rollout exists", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-rollout-recovery-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const threadIdPath = join(runtimeDirectory, "codex-thread-id.txt");
    const sessionCatalogPath = join(runtimeDirectory, "session-catalog.json");
    const fixture = writeMissingRolloutFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = fixture.executablePath;
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(threadIdPath, "missing-stored-thread\n", "utf8");
    writeFileSync(sessionCatalogPath, JSON.stringify({
      activeSessionId: "missing-stored-thread",
      sessions: [{
        id: "missing-stored-thread",
        startedAt: 1,
        cwd: process.cwd(),
        harness: "codex",
        transport: "codex_app_server",
        model: null,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }],
    }, null, 2));

    const options = {
      agentName: "codex-rollout-recovery",
      sessionId: "codex-rollout-recovery",
      cwd: process.cwd(),
      systemPrompt: "Start a replacement session.",
      runtimeDirectory,
      logsDirectory,
      launchArgs: [],
    } as const;

    try {
      const online = await ensureCodexAppServerAgentOnline(options);
      expect(online.threadId).toBe(fixture.startedThreadId);
      expect(online.durableThreadId).toBeNull();
      expect(readFileSync(fixture.methodsPath, "utf8")).toContain("thread/resume\nthread/start\n");
      expect(existsSync(threadIdPath)).toBe(false);
      const recoveredCatalog = JSON.parse(readFileSync(sessionCatalogPath, "utf8")) as {
        activeSessionId?: string | null;
        sessions?: Array<{ id?: string; endedAt?: number }>;
      };
      expect(recoveredCatalog.activeSessionId).toBeNull();
      expect(recoveredCatalog.sessions?.[0]).toEqual(expect.objectContaining({
        id: "missing-stored-thread",
        endedAt: expect.any(Number),
      }));

      const pendingState = JSON.parse(readFileSync(join(runtimeDirectory, "state.json"), "utf8")) as {
        threadId?: string | null;
        threadPath?: string | null;
      };
      expect(pendingState.threadId).toBeNull();
      expect(pendingState.threadPath).toBeNull();

      const turn = await startCodexAppServerAgent({
        ...options,
        prompt: "Create the rollout.",
      });
      expect(turn.threadId).toBe(fixture.startedThreadId);
      expect(readFileSync(threadIdPath, "utf8").trim()).toBe(fixture.startedThreadId);

      const durableState = JSON.parse(readFileSync(join(runtimeDirectory, "state.json"), "utf8")) as {
        threadId?: string | null;
        threadPath?: string | null;
      };
      expect(durableState.threadId).toBe(fixture.startedThreadId);
      expect(durableState.threadPath).toBe(fixture.rolloutPath);

      const catalog = JSON.parse(readFileSync(sessionCatalogPath, "utf8")) as {
        activeSessionId?: string | null;
      };
      expect(catalog.activeSessionId).toBe(fixture.startedThreadId);
    } finally {
      await shutdownCodexAppServerAgent(options, { resetThread: true });
    }
  });

  test("preserves an unrelated active catalog when a stale stored rollout is missing", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-unrelated-catalog-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const threadIdPath = join(runtimeDirectory, "codex-thread-id.txt");
    const sessionCatalogPath = join(runtimeDirectory, "session-catalog.json");
    const fixture = writeMissingRolloutFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = fixture.executablePath;
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(threadIdPath, "missing-stored-thread\n", "utf8");
    writeFileSync(sessionCatalogPath, JSON.stringify({
      activeSessionId: "unrelated-active-thread",
      sessions: [{
        id: "unrelated-active-thread",
        startedAt: 1,
        cwd: process.cwd(),
        harness: "codex",
        transport: "codex_app_server",
        model: null,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }],
    }, null, 2));

    const options = {
      agentName: "codex-unrelated-catalog",
      sessionId: "codex-unrelated-catalog",
      cwd: process.cwd(),
      systemPrompt: "Start a replacement session.",
      runtimeDirectory,
      logsDirectory,
      launchArgs: [],
    } as const;

    try {
      await ensureCodexAppServerAgentOnline(options);
      const catalog = JSON.parse(readFileSync(sessionCatalogPath, "utf8")) as {
        activeSessionId?: string | null;
        sessions?: Array<{ id?: string; endedAt?: number }>;
      };
      expect(catalog.activeSessionId).toBe("unrelated-active-thread");
      expect(catalog.sessions?.[0]).toEqual({
        id: "unrelated-active-thread",
        startedAt: 1,
        cwd: process.cwd(),
        harness: "codex",
        transport: "codex_app_server",
        model: null,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } finally {
      await shutdownCodexAppServerAgent(options, { resetThread: true });
    }
    const catalogAfterReset = JSON.parse(readFileSync(sessionCatalogPath, "utf8")) as {
      activeSessionId?: string | null;
      sessions?: Array<{ id?: string; endedAt?: number }>;
    };
    expect(catalogAfterReset.activeSessionId).toBe("unrelated-active-thread");
    expect(catalogAfterReset.sessions?.[0]?.endedAt).toBeUndefined();
  });

  test("reports a missing cached rollout as stored when an existing thread is required", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-stored-rollout-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const threadIdPath = join(runtimeDirectory, "codex-thread-id.txt");
    const fixture = writeMissingRolloutFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = fixture.executablePath;
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(threadIdPath, "missing-stored-thread\n", "utf8");

    const options = {
      agentName: "codex-required-stored-rollout",
      sessionId: "codex-required-stored-rollout",
      cwd: process.cwd(),
      systemPrompt: "Resume the stored session.",
      runtimeDirectory,
      logsDirectory,
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    try {
      await expect(ensureCodexAppServerAgentOnline(options)).rejects.toThrow(
        "Failed to resume stored Codex thread missing-stored-thread: no rollout found for thread id missing-stored-thread",
      );
      expect(readFileSync(fixture.methodsPath, "utf8")).not.toContain("thread/start");
      expect(existsSync(threadIdPath)).toBe(false);
      expect(existsSync(join(runtimeDirectory, "session-catalog.json"))).toBe(false);
      expect(readFileSync(join(logsDirectory, "stderr.log"), "utf8")).toContain(
        "failed to resume stored Codex thread missing-stored-thread",
      );
    } finally {
      await shutdownCodexAppServerAgent(options, { resetThread: true });
    }
  });

  test("reports an explicitly requested missing rollout as requested", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-requested-rollout-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const fixture = writeMissingRolloutFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = fixture.executablePath;

    const options = {
      agentName: "codex-required-requested-rollout",
      sessionId: "codex-required-requested-rollout",
      cwd: process.cwd(),
      systemPrompt: "Resume the requested session.",
      runtimeDirectory,
      logsDirectory,
      threadId: "missing-requested-thread",
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    try {
      await expect(ensureCodexAppServerAgentOnline(options)).rejects.toThrow(
        "Failed to resume requested Codex thread missing-requested-thread: no rollout found for thread id missing-requested-thread",
      );
      expect(readFileSync(fixture.methodsPath, "utf8")).not.toContain("thread/start");
      expect(readFileSync(join(logsDirectory, "stderr.log"), "utf8")).toContain(
        "failed to resume requested Codex thread missing-requested-thread",
      );
    } finally {
      await shutdownCodexAppServerAgent(options, { resetThread: true });
    }
  });

  test("classifies an externally held thread as held-externally, not a generic resume failure", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-held-thread-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const fixture = writeHeldThreadFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = fixture.executablePath;

    const options = {
      agentName: "codex-held-thread",
      sessionId: "codex-held-thread",
      cwd: process.cwd(),
      systemPrompt: "Resume the requested session.",
      runtimeDirectory,
      logsDirectory,
      threadId: "held-requested-thread",
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    try {
      // SCO-098: the single-writer conflict is a distinct, retryable state —
      // the thread exists and is open in another app-server. Callers park
      // delivery on this code instead of latching the endpoint offline.
      await expect(ensureCodexAppServerAgentOnline(options)).rejects.toMatchObject({
        code: "CODEX_THREAD_HELD_EXTERNALLY",
        threadId: "held-requested-thread",
      });
      expect(readFileSync(fixture.methodsPath, "utf8")).not.toContain("thread/start");
    } finally {
      await shutdownCodexAppServerAgent(options, { resetThread: true });
    }
  });

  test("normalizes legacy model launch args for app-server sessions", () => {
    expect(normalizeCodexAppServerLaunchArgs(["--model", "gpt-5.4-mini"])).toEqual([
      "-c",
      "model=\"gpt-5.4-mini\"",
    ]);
  });

  test("expands GPT model shorthand for app-server sessions", () => {
    expect(normalizeCodexAppServerLaunchArgs(["--model", "astra"])).toEqual([
      "-c",
      "model=\"gpt-6-astra\"",
    ]);
    expect(readCodexAppServerModelFromLaunchArgs(["--model", "gpt-6"])).toBe("gpt-6-astra");
    expect(normalizeCodexAppServerLaunchArgs(["--model", "5.6"])).toEqual([
      "-c",
      "model=\"gpt-5.6-sol\"",
    ]);
    expect(normalizeCodexAppServerLaunchArgs(["--model", "5.5"])).toEqual([
      "-c",
      "model=\"gpt-5.5\"",
    ]);
    expect(readCodexAppServerModelFromLaunchArgs(["--model", "gpt-5.6"])).toBe("gpt-5.6-sol");
    expect(readCodexAppServerModelFromLaunchArgs(["--model", "5.5"])).toBe("gpt-5.5");
    expect(readCodexAppServerModelFromLaunchArgs(["-c", "model=\"5.4-mini\""])).toBe("gpt-5.4-mini");
  });

  test("normalizes reasoning effort launch args for app-server sessions", () => {
    const launchArgs = normalizeCodexAppServerLaunchArgs(["--reasoning-effort", "xhigh"]);
    expect(launchArgs).toEqual([
      "-c",
      "model_reasoning_effort=\"xhigh\"",
    ]);
    expect(readCodexAppServerReasoningEffortFromLaunchArgs(launchArgs)).toBe("xhigh");
  });

  test("passes launch args through to the spawned app-server process", async () => {
    // An unrelated inherited key must not suppress the selected operator sign-in.
    process.env.OPENAI_API_KEY = "unrelated-test-provider-key";
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-launch-args-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const operatorCodexHome = join(tempRoot, "operator-codex-home");
    const operatorAuth = join(tempRoot, "operator-auth.json");
    writeFileSync(operatorAuth, "{}", "utf8");
    const { executablePath, argsPath, envPath } = writeArgCaptureFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = executablePath;

    const options = {
      agentName: "codex-launch-args",
      sessionId: "attached-codex-launch-args",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory,
      logsDirectory,
      threadId: "thread-launch-args-1",
      requireExistingThread: true,
      launchArgs: ["--model", "gpt-5.4-mini", "--reasoning-effort", "high", "--config", "sandbox_workspace_write.enabled=true"],
      env: {
        CODEX_HOME: operatorCodexHome,
        OPENSCOUT_CODEX_AUTH_SOURCE: operatorAuth,
      },
    } as const;

    await ensureCodexAppServerAgentOnline(options);

    const argv = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    expect(argv).toContain("app-server");
    expect(argv).toContain("model=\"gpt-5.4-mini\"");
    expect(argv).toContain("model_reasoning_effort=\"high\"");
    expect(argv).toContain("--config");
    expect(argv).toContain("sandbox_workspace_write.enabled=true");
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--reasoning-effort");
    const env = JSON.parse(readFileSync(envPath, "utf8")) as { CODEX_HOME?: string | null };
    expect(env.CODEX_HOME).toBe(operatorCodexHome);
    expect(lstatSync(join(operatorCodexHome, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(operatorCodexHome, "auth.json"))).toBe(operatorAuth);

    await shutdownCodexAppServerAgent(options);
  });

  test("logs OpenScout-initiated SIGTERM shutdowns as proactive stops", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-proactive-shutdown-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    process.env.OPENSCOUT_CODEX_BIN = writeHangingFakeCodexExecutable(tempRoot);

    const options = {
      agentName: "codex-proactive-shutdown",
      sessionId: "attached-codex-proactive-shutdown",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory,
      logsDirectory,
      threadId: "thread-proactive-shutdown-1",
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    await ensureCodexAppServerAgentOnline(options);
    await shutdownCodexAppServerAgent(options, {
      reason: "OpenScout test requested shutdown",
    });

    const expected = "[openscout] Codex app-server stopped for codex-proactive-shutdown: OpenScout test requested shutdown";
    const stderr = await readTextFileEventually(join(logsDirectory, "stderr.log"), (text) => text.includes(expected));
    expect(stderr).toContain(expected);
    expect(stderr).not.toContain("Codex app-server exited for codex-proactive-shutdown");
  });

  test("classifies OpenScout shutdowns during active turns as proactive", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-active-shutdown-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    process.env.OPENSCOUT_CODEX_BIN = writeHangingFakeCodexExecutable(tempRoot);

    const options = {
      agentName: "codex-active-shutdown",
      sessionId: "attached-codex-active-shutdown",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory,
      logsDirectory,
      threadId: "thread-active-shutdown-1",
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    await ensureCodexAppServerAgentOnline(options);
    const activeTurn = invokeCodexAppServerAgent({
      ...options,
      prompt: "keep working",
      timeoutMs: 5_000,
    }).then(
      () => undefined,
      (error) => error as unknown,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await shutdownCodexAppServerAgent(options, {
      reason: "OpenScout test stopped an active turn",
    });

    const thrown = await activeTurn;

    expect(isCodexAppServerExitError(thrown)).toBe(true);
    expect((thrown as { exitKind?: string }).exitKind).toBe("proactive_shutdown");
    expect((thrown as { noteworthy?: boolean }).noteworthy).toBe(true);
    expect((thrown as Error).message).toBe(
      "Codex app-server session for codex-active-shutdown was stopped by OpenScout: OpenScout test stopped an active turn.",
    );
  });

  test("returns when Codex accepts a turn without waiting for completion", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-nonblocking-start-test-"));
    tempPaths.add(tempRoot);
    const options = {
      agentName: "codex-nonblocking-start",
      sessionId: "attached-codex-nonblocking-start",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory: join(tempRoot, "runtime"),
      logsDirectory: join(tempRoot, "logs"),
      threadId: "thread-nonblocking-start-1",
      requireExistingThread: true,
      launchArgs: [],
    } as const;
    process.env.OPENSCOUT_CODEX_BIN = writeHangingFakeCodexExecutable(tempRoot);

    let startDeadline: ReturnType<typeof setTimeout> | null = null;
    const receipt = await Promise.race([
      startCodexAppServerAgent({ ...options, prompt: "keep working" }),
      new Promise<never>((_resolve, reject) => {
        startDeadline = setTimeout(() => reject(new Error("start did not return")), 5_000);
      }),
    ]).finally(() => {
      if (startDeadline) clearTimeout(startDeadline);
    });
    expect(receipt).toEqual({
      threadId: "thread-nonblocking-start-1",
      turnId: "turn-hanging",
    });
    await expect(startCodexAppServerAgent({ ...options, prompt: "second turn" }))
      .rejects.toThrow("already has an active turn");

    await shutdownCodexAppServerAgent(options);
  });

  test("classifies unexpected SIGTERM exits as noteworthy interruptions", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-external-sigterm-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    process.env.OPENSCOUT_CODEX_BIN = writeSigtermOnTurnFakeCodexExecutable(tempRoot);

    const options = {
      agentName: "codex-external-sigterm",
      sessionId: "attached-codex-external-sigterm",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory,
      logsDirectory,
      threadId: "thread-external-sigterm-1",
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    let thrown: unknown;
    try {
      await invokeCodexAppServerAgent({
        ...options,
        prompt: "trigger sigterm",
        timeoutMs: 5_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(isCodexAppServerExitError(thrown)).toBe(true);
    expect((thrown as { exitKind?: string }).exitKind).toBe("external_sigterm");
    expect((thrown as { noteworthy?: boolean }).noteworthy).toBe(true);
    expect((thrown as Error).message).toBe(
      "Codex app-server for codex-external-sigterm was interrupted by SIGTERM.",
    );

    const expected = "Codex app-server for codex-external-sigterm was interrupted by SIGTERM.";
    const stderr = await readTextFileEventually(join(logsDirectory, "stderr.log"), (text) => text.includes(expected));
    expect(stderr).toContain(expected);
    expect(stderr).not.toContain("Codex app-server exited for codex-external-sigterm (SIGTERM)");

    await shutdownCodexAppServerAgent(options);
  });

  test("passes requested permission posture as Codex thread parameters", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-permission-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const { executablePath, paramsPath } = writeThreadParamCaptureFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = executablePath;

    const options = {
      agentName: "codex-permission",
      sessionId: "attached-codex-permission",
      cwd: process.cwd(),
      systemPrompt: "Start with a safer native Codex posture.",
      runtimeDirectory,
      logsDirectory,
      launchArgs: [],
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    } as const;

    await ensureCodexAppServerAgentOnline(options);

    const captured = JSON.parse(readFileSync(paramsPath, "utf8")) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(captured.method).toBe("thread/start");
    expect(captured.params.approvalPolicy).toBe("on-request");
    expect(captured.params.sandbox).toBe("workspace-write");

    await shutdownCodexAppServerAgent(options, { resetThread: true });
  });

  test("resumes a requested thread id without starting a new thread", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-attach-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    process.env.OPENSCOUT_CODEX_BIN = writeFakeCodexExecutable(tempRoot);

    const threadId = "123e4567-e89b-12d3-a456-426614174000";
    const options = {
      agentName: "codex-here",
      sessionId: "attached-codex-here",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory,
      logsDirectory,
      threadId,
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    const online = await ensureCodexAppServerAgentOnline(options);
    expect(online.threadId).toBe(threadId);
    expect(online.durableThreadId).toBe(threadId);

    const state = JSON.parse(readFileSync(join(runtimeDirectory, "state.json"), "utf8")) as {
      threadId?: string;
      requestedThreadId?: string | null;
      requireExistingThread?: boolean;
    };
    expect(state.threadId).toBe(threadId);
    expect(state.requestedThreadId).toBe(threadId);
    expect(state.requireExistingThread).toBe(true);

    const catalog = JSON.parse(readFileSync(join(runtimeDirectory, "session-catalog.json"), "utf8")) as {
      activeSessionId: string | null;
      sessions: Array<{ id: string; cwd: string; harness?: string; transport?: string }>;
    };
    expect(catalog.activeSessionId).toBe(threadId);
    expect(catalog.sessions).toContainEqual(expect.objectContaining({
      id: threadId,
      cwd: process.cwd(),
      harness: "codex",
      transport: "codex_app_server",
    }));

    const snapshot = await getCodexAppServerAgentSnapshot(options);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.session.providerMeta?.threadId).toBe(threadId);

    await shutdownCodexAppServerAgent(options, { resetThread: true });

    const closedCatalog = JSON.parse(readFileSync(join(runtimeDirectory, "session-catalog.json"), "utf8")) as {
      activeSessionId: string | null;
      sessions: Array<{ id: string; endedAt?: number }>;
    };
    expect(closedCatalog.activeSessionId).toBeNull();
    expect(closedCatalog.sessions.find((session) => session.id === threadId)?.endedAt).toBeNumber();
  });

  test("steers the current turn instead of starting a second one", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-steer-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    process.env.OPENSCOUT_CODEX_BIN = writeSteerableFakeCodexExecutable(tempRoot);

    const options = {
      agentName: "codex-here",
      sessionId: "attached-codex-here",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory,
      logsDirectory,
      threadId: "thread-steer-1",
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    await ensureCodexAppServerAgentOnline(options);
    const first = invokeCodexAppServerAgent({
      ...options,
      prompt: "first prompt",
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = sendCodexAppServerAgent({
      ...options,
      prompt: "follow-up prompt",
      timeoutMs: 5_000,
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.output).toBe("Steered current session reply");
    expect(secondResult.output).toBe("Steered current session reply");

    await shutdownCodexAppServerAgent(options);
  });

  test("promoting a started thread into a session selector never replaces its active client", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-promotion-test-"));
    tempPaths.add(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = writeSteerableFakeCodexExecutable(tempRoot);
    const options = {
      agentName: "codex-promoted", sessionId: "scout-promoted", cwd: process.cwd(),
      systemPrompt: "Keep the same session.", runtimeDirectory: join(tempRoot, "runtime"),
      logsDirectory: join(tempRoot, "logs"), launchArgs: ["--reasoning-effort", "high"],
    };
    const online = await ensureCodexAppServerAgentOnline(options);
    const first = invokeCodexAppServerAgent({ ...options, prompt: "review", timeoutMs: 5000 });
    // Wait for the fake server's actual turn/start, not a guessed sleep.
    await readTextFileEventually(join(tempRoot, "logs", "stdout.log"), text => text.includes('"turn/started"'));
    const followup = { ...options, threadId: online.threadId, requireExistingThread: true };
    const client = getOrCreateCodexAppServerClient(options);
    expect(client.matches({ ...followup, threadId: "different-thread" })).toBe(false);
    expect(client.matches({ ...followup, launchArgs: ["--reasoning-effort", "low"] })).toBe(false);
    expect(client.matches({ ...followup, launchArgs: ["--model", "different-model"] })).toBe(false);
    expect(client.matches({ ...followup, sandbox: "read-only" })).toBe(false);
    try {
      const [a, b] = await Promise.all([first, sendCodexAppServerAgent({ ...followup, prompt: "follow-up", timeoutMs: 5000 })]);
      expect(a.output).toBe("Steered current session reply");
      expect(b.output).toBe(a.output);
      expect(existsSync(join(tempRoot, "logs", "stderr.log"))
        ? readFileSync(join(tempRoot, "logs", "stderr.log"), "utf8") : "")
        .not.toContain("launch options changed");
    } finally {
      await shutdownCodexAppServerAgent(followup);
    }
  });

  test("requester timeout does not interrupt a late-completing turn", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-late-completion-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    process.env.OPENSCOUT_CODEX_BIN = writeLateCompletionFakeCodexExecutable(tempRoot);

    const options = {
      agentName: "codex-late",
      sessionId: "attached-codex-late",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory,
      logsDirectory,
      threadId: "thread-late-1",
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    let timeoutError: unknown;
    try {
      await invokeCodexAppServerAgent({
        ...options,
        prompt: "late prompt",
        timeoutMs: 50,
      });
    } catch (error) {
      timeoutError = error;
    }

    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toBe("Timed out after 50ms waiting for codex-late.");
    expect((timeoutError as { code?: string }).code).toBe("REQUESTER_WAIT_TIMEOUT");
    expect((timeoutError as { label?: string }).label).toBe("codex-late");
    expect((timeoutError as { timeoutMs?: number }).timeoutMs).toBe(50);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = await getCodexAppServerAgentSnapshot(options);
    expect(snapshot?.turns.at(-1)?.status).toBe("completed");
    expect(snapshot?.turns.at(-1)?.blocks.at(-1)?.block.type).toBe("text");
    expect((snapshot?.turns.at(-1)?.blocks.at(-1)?.block as { text?: string } | undefined)?.text).toBe("Late completion reply");

    await shutdownCodexAppServerAgent(options);
  });

  test.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])("routes %s into a managed permission and responds on the same app-server", async method => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-approval-test-")); tempPaths.add(tempRoot);
    const { executablePath, responsePath } = writeDynamicToolFakeCodexExecutable(tempRoot, method);
    process.env.OPENSCOUT_CODEX_BIN = executablePath;
    const options = { agentName: "approval-agent", sessionId: "approval-session", cwd: process.cwd(), systemPrompt: "test",
      runtimeDirectory: join(tempRoot, "runtime"), logsDirectory: join(tempRoot, "logs"), threadId: "thread-approval", requireExistingThread: true };
    const requests: string[] = [];
    configureManagedPermissionHandler(async (invocation, prompt) => {
      expect(invocation.id).toBe("inv-approval"); expect(prompt.sessionId).toBe("thread-approval");
      expect(prompt.decisions).toEqual(["once", "deny"]); expect(await prompt.isCurrent()).toBe(true);
      requests.push(prompt.text); await prompt.answer("once"); expect(await prompt.isCurrent()).toBe(false);
    });
    try {
      const result = await withManagedPermissionContext({ id: "inv-approval" } as InvocationRequest,
        () => invokeCodexAppServerAgent({ ...options, prompt: "approval test", timeoutMs: 5_000 }));
      expect(result.output).toBe("Recovered after tool rejection"); expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(method);
      expect(JSON.parse(readFileSync(responsePath, "utf8"))).toEqual({ id: "server-request-1", result: { decision: "accept" } });
    } finally { await shutdownCodexAppServerAgent(options); }
  });

  test.each(["decline", "cancel"])("preserves native negative decision %s", async nativeDecision => {
    const method = "item/commandExecution/requestApproval";
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-approval-test-")); tempPaths.add(tempRoot);
    const { executablePath, responsePath } = writeDynamicToolFakeCodexExecutable(tempRoot, method, ["accept", nativeDecision]);
    process.env.OPENSCOUT_CODEX_BIN = executablePath;
    const options = { agentName: "approval-agent", sessionId: "approval-session", cwd: process.cwd(), systemPrompt: "test",
      runtimeDirectory: join(tempRoot, "runtime"), logsDirectory: join(tempRoot, "logs"), threadId: "thread-approval", requireExistingThread: true };
    const requests: string[] = [];
    configureManagedPermissionHandler(async (invocation, prompt) => {
      expect(invocation.id).toBe("inv-approval"); expect(prompt.sessionId).toBe("thread-approval");
      expect(prompt.decisions).toEqual(["once", "deny"]); expect(await prompt.isCurrent()).toBe(true);
      requests.push(prompt.text); expect(prompt.decisionLabels?.deny).toBe(nativeDecision === "cancel" ? "Cancel" : "Deny"); await prompt.answer("deny"); expect(await prompt.isCurrent()).toBe(false);
    });
    try {
      const result = await withManagedPermissionContext({ id: "inv-approval" } as InvocationRequest,
        () => invokeCodexAppServerAgent({ ...options, prompt: "approval test", timeoutMs: 5_000 }));
      expect(result.output).toBe("Recovered after tool rejection"); expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(method);
      expect(JSON.parse(readFileSync(responsePath, "utf8"))).toEqual({ id: "server-request-1", result: { decision: nativeDecision } });
    } finally { await shutdownCodexAppServerAgent(options); }
  });

  test("rejects unsupported dynamic tool calls with a valid JSON-RPC error", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-dynamic-tool-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "runtime");
    const logsDirectory = join(tempRoot, "logs");
    const { executablePath, responsePath } = writeDynamicToolFakeCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = executablePath;

    const options = {
      agentName: "codex-here",
      sessionId: "attached-codex-here",
      cwd: process.cwd(),
      systemPrompt: "Resume the existing session without changing its identity or prior context.",
      runtimeDirectory,
      logsDirectory,
      threadId: "thread-dynamic-tool-1",
      requireExistingThread: true,
      launchArgs: [],
    } as const;

    const result = await invokeCodexAppServerAgent({
      ...options,
      prompt: "trigger a desktop-origin follow-up",
      timeoutMs: 5_000,
    });

    expect(result.output).toBe("Recovered after tool rejection");

    const response = JSON.parse(readFileSync(responsePath, "utf8")) as {
      id: string;
      error?: {
        code?: number;
        message?: string;
      };
    };
    expect(response.id).toBe("server-request-1");
    expect(response.error).toEqual({
      code: -32000,
      message: "dynamic tool call `read_thread_terminal` is not supported by openscout-runtime",
    });

    await shutdownCodexAppServerAgent(options);
  });

});
