import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InvocationRequest } from "@openscout/protocol";

import { invokeGrokAcpAgent } from "./grok-acp-invocation.js";
import { shutdownAllAcpAgentSessions } from "./acp-agent-invocation.js";
import { configureManagedPermissionHandler, withManagedPermissionContext } from "./managed-permission.js";
import { isRequesterWaitTimeoutError } from "./requester-timeout.js";

const originalPath = process.env.PATH;
const originalScoutXaiApiKey = process.env.SCOUT_XAI_API_KEY;
const originalXaiApiKey = process.env.XAI_API_KEY;
const originalGrokCliBin = process.env.GROK_CLI_BIN;
const originalGrokDelay = process.env.OPENSCOUT_TEST_GROK_DELAY_MS;
const originalGrokLog = process.env.OPENSCOUT_TEST_GROK_LOG;
const originalGrokExitAfterPrompt = process.env.OPENSCOUT_TEST_GROK_EXIT_AFTER_PROMPT;
const originalGrokRejectModel = process.env.OPENSCOUT_TEST_GROK_REJECT_MODEL;
const originalGrokPermission = process.env.OPENSCOUT_TEST_GROK_PERMISSION;
const tempDirs = new Set<string>();

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-grok-acp-"));
  tempDirs.add(directory);
  return directory;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFakeGrok(directory: string): { binDir: string; grokPath: string; logPath: string } {
  const binDir = join(directory, "bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = join(directory, "grok.log");
  const grokPath = join(binDir, "grok");
  writeFileSync(grokPath, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const logPath = process.env.OPENSCOUT_TEST_GROK_LOG;
const delayMs = Number(process.env.OPENSCOUT_TEST_GROK_DELAY_MS || "0");
const exitAfterPrompt = process.env.OPENSCOUT_TEST_GROK_EXIT_AFTER_PROMPT === "1";
const rejectModel = process.env.OPENSCOUT_TEST_GROK_REJECT_MODEL === "1";
const askPermission = process.env.OPENSCOUT_TEST_GROK_PERMISSION === "1";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptRequestId = null;

function log(value) {
  if (logPath) appendFileSync(logPath, value + "\\n");
}
process.on("exit", () => log("process:exit"));
process.on("SIGTERM", () => {
  log("process:sigterm");
  process.exit(0);
});

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};
  log(method + ":" + (params.sessionId ?? ""));

  if (method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: false },
          sessionCapabilities: { close: {}, resume: {} }
        },
        agentInfo: { name: "grok-acp", title: "Grok ACP", version: "test" },
        authMethods: [{ id: "xai.api_key" }]
      }
    }));
    continue;
  }

  if (method === "authenticate") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }

  if (method === "session/new") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { sessionId: "fake-grok-acp-session", models: { currentModelId: "grok-4.6" } },
    }));
    continue;
  }

  if (method === "session/set_model") {
    log("model:" + (params.modelId ?? ""));
    log("effort:" + (params._meta?.reasoningEffort ?? ""));
    console.log(JSON.stringify(rejectModel
      ? { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }
      : { jsonrpc: "2.0", id, result: {} }));
    continue;
  }

  if (method === "session/resume") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }

  if (id === "permission-1" && message.result) {
    log("permission:" + JSON.stringify(message.result));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId || "fake-grok-acp-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "grok-acp-ok" }
        }
      }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } }));
    continue;
  }

  if (method === "session/prompt") {
    if (askPermission) {
      promptRequestId = id;
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "call-perm", title: "Run protected action", kind: "execute", status: "pending" },
          options: [
            { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" }
          ]
        }
      }));
      continue;
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "grok-acp-ok" }
        }
      }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    if (exitAfterPrompt) setTimeout(() => process.exit(0), 10);
    continue;
  }

  if (method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }
}
`, "utf8");
  chmodSync(grokPath, 0o755);
  return { binDir, grokPath, logPath };
}

function configureFakeGrok(input: { binDir: string; grokPath: string; logPath: string; delayMs: number }): void {
  process.env.PATH = `${input.binDir}:${originalPath ?? ""}`;
  process.env.GROK_CLI_BIN = input.grokPath;
  process.env.SCOUT_XAI_API_KEY = "test-key";
  process.env.OPENSCOUT_TEST_GROK_LOG = input.logPath;
  process.env.OPENSCOUT_TEST_GROK_DELAY_MS = String(input.delayMs);
}

afterEach(async () => {
  await shutdownAllAcpAgentSessions();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalScoutXaiApiKey === undefined) delete process.env.SCOUT_XAI_API_KEY;
  else process.env.SCOUT_XAI_API_KEY = originalScoutXaiApiKey;
  if (originalXaiApiKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = originalXaiApiKey;
  if (originalGrokCliBin === undefined) delete process.env.GROK_CLI_BIN;
  else process.env.GROK_CLI_BIN = originalGrokCliBin;
  if (originalGrokDelay === undefined) delete process.env.OPENSCOUT_TEST_GROK_DELAY_MS;
  else process.env.OPENSCOUT_TEST_GROK_DELAY_MS = originalGrokDelay;
  if (originalGrokLog === undefined) delete process.env.OPENSCOUT_TEST_GROK_LOG;
  else process.env.OPENSCOUT_TEST_GROK_LOG = originalGrokLog;
  if (originalGrokExitAfterPrompt === undefined) delete process.env.OPENSCOUT_TEST_GROK_EXIT_AFTER_PROMPT;
  else process.env.OPENSCOUT_TEST_GROK_EXIT_AFTER_PROMPT = originalGrokExitAfterPrompt;
  if (originalGrokRejectModel === undefined) delete process.env.OPENSCOUT_TEST_GROK_REJECT_MODEL;
  else process.env.OPENSCOUT_TEST_GROK_REJECT_MODEL = originalGrokRejectModel;
  if (originalGrokPermission === undefined) delete process.env.OPENSCOUT_TEST_GROK_PERMISSION;
  else process.env.OPENSCOUT_TEST_GROK_PERMISSION = originalGrokPermission;
  configureManagedPermissionHandler(undefined);
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("invokeGrokAcpAgent", () => {
  test("fails unsupported resumed model selection without fallback and terminates the ACP process", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });
    process.env.OPENSCOUT_TEST_GROK_REJECT_MODEL = "1";

    await expect(invokeGrokAcpAgent({
      sessionId: "grok-rejected-model",
      resumeSessionId: "provider-existing-session",
      cwd: directory,
      prompt: "must not run",
      timeoutMs: 2_000,
      adapterOptions: { model: "grok-4.5" },
    })).rejects.toThrow("session/set_model failed (-32601): Method not found");

    await sleep(50);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("session/resume:provider-existing-session");
    expect(log).toContain("session/set_model:provider-existing-session\nmodel:grok-4.5");
    expect(log).not.toContain("session/new:");
    expect(log).not.toContain("session/prompt:");
    expect(log).toContain("session/close:provider-existing-session");
    expect(log).toContain("process:sigterm");
  });

  test("raises an ACP permission and answers it with allow once", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });
    process.env.OPENSCOUT_TEST_GROK_PERMISSION = "1";
    const seen: string[] = [];
    configureManagedPermissionHandler(async (_invocation, prompt) => {
      seen.push(prompt.text);
      expect(prompt.decisions).toEqual(["once", "deny"]);
      expect(prompt.decisionLabels).toMatchObject({ once: "Allow once", deny: "Deny" });
      expect(await prompt.isCurrent()).toBe(true);
      await prompt.answer("once");
      expect(await prompt.isCurrent()).toBe(false);
    });

    const result = await withManagedPermissionContext({ id: "inv-grok-permission" } as InvocationRequest, () => invokeGrokAcpAgent({
      sessionId: "grok-permission",
      cwd: directory,
      prompt: "run it",
      timeoutMs: 5_000,
    }));

    expect(result.output).toContain("grok-acp-ok");
    expect(seen).toEqual(["Grok ACP asks permission: Run protected action"]);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain('permission:{"outcome":{"outcome":"selected","optionId":"allow-once"}}');
  });

  test("denies an ACP permission with the reject option", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });
    process.env.OPENSCOUT_TEST_GROK_PERMISSION = "1";
    configureManagedPermissionHandler(async (_invocation, prompt) => {
      await prompt.answer("deny");
    });

    const result = await withManagedPermissionContext({ id: "inv-grok-permission-deny" } as InvocationRequest, () => invokeGrokAcpAgent({
      sessionId: "grok-permission-deny",
      cwd: directory,
      prompt: "run it",
      timeoutMs: 5_000,
    }));

    expect(result.output).toContain("grok-acp-ok");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain('permission:{"outcome":{"outcome":"selected","optionId":"reject-once"}}');
  });

  test("selects the requested model through ACP before the first prompt", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });

    const result = await invokeGrokAcpAgent({
      sessionId: "grok-model",
      cwd: directory,
      prompt: "reply",
      timeoutMs: 2_000,
      adapterOptions: { model: "grok-4.5" },
    });

    expect(result.output).toContain("grok-acp-ok");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("session/set_model:fake-grok-acp-session\nmodel:grok-4.5");
    expect(log.indexOf("session/set_model:")).toBeLessThan(log.indexOf("session/prompt:"));
  });

  test("recreates a pooled ACP session when the requested model changes", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });

    await invokeGrokAcpAgent({
      sessionId: "grok-model-change",
      cwd: directory,
      prompt: "first",
      timeoutMs: 2_000,
      adapterOptions: { model: "grok-4.5" },
    });
    await invokeGrokAcpAgent({
      sessionId: "grok-model-change",
      cwd: directory,
      prompt: "second",
      timeoutMs: 2_000,
      adapterOptions: { model: "grok-4.6" },
    });

    const log = readFileSync(logPath, "utf8");
    expect(log.match(/initialize:/g)).toHaveLength(2);
    expect(log).toContain("model:grok-4.5");
    expect(log).toContain("session/resume:fake-grok-acp-session\n");
    expect(log).toContain("session/set_model:fake-grok-acp-session\nmodel:grok-4.6");
    expect(log.lastIndexOf("model:grok-4.6")).toBeLessThan(log.lastIndexOf("session/prompt:"));
  });

  test("sends the requested reasoning effort alongside the model", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });

    await invokeGrokAcpAgent({
      sessionId: "grok-effort",
      cwd: directory,
      prompt: "reply",
      timeoutMs: 2_000,
      adapterOptions: { model: "grok-4.5", reasoningEffort: "low" },
    });

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("session/set_model:fake-grok-acp-session\nmodel:grok-4.5\neffort:low");
  });

  test("applies an effort-only request against the session's current model", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });

    // Grok resets effort to the model default on any set_model that omits it,
    // so effort alone still has to name a model — the one the session reports.
    await invokeGrokAcpAgent({
      sessionId: "grok-effort-only",
      cwd: directory,
      prompt: "reply",
      timeoutMs: 2_000,
      adapterOptions: { reasoningEffort: "xhigh" },
    });

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("session/set_model:fake-grok-acp-session\nmodel:grok-4.6\neffort:xhigh");
  });

  test("reuses the pooled session only while model and effort both hold", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });

    await invokeGrokAcpAgent({
      sessionId: "grok-effort-change",
      cwd: directory,
      prompt: "first",
      timeoutMs: 2_000,
      adapterOptions: { model: "grok-4.6", reasoningEffort: "low" },
    });
    await invokeGrokAcpAgent({
      sessionId: "grok-effort-change",
      cwd: directory,
      prompt: "second",
      timeoutMs: 2_000,
      adapterOptions: { model: "grok-4.6", reasoningEffort: "high" },
    });

    const log = readFileSync(logPath, "utf8");
    expect(log.match(/initialize:/g)).toHaveLength(2);
    expect(log).toContain("effort:high");
  });

  test("keeps one ACP process attached across sequential turns", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 10 });

    const result = await invokeGrokAcpAgent({
      sessionId: "grok-fast",
      cwd: directory,
      prompt: "reply",
      timeoutMs: 2_000,
    });

    expect(result.output).toContain("grok-acp-ok");
    expect(result.sessionId).toBe("fake-grok-acp-session");

    const second = await invokeGrokAcpAgent({
      sessionId: "grok-fast",
      cwd: directory,
      prompt: "reply again",
      timeoutMs: 2_000,
    });

    expect(second.output).toContain("grok-acp-ok");
    const log = readFileSync(logPath, "utf8");
    expect(log.match(/initialize:/g)).toHaveLength(1);
    expect(log.match(/session\/new:/g)).toHaveLength(1);
    expect(log.match(/session\/prompt:/g)).toHaveLength(2);
    expect(log).not.toContain("session/close:");
  });

  test("wait-budget expiry throws requester timeout and leaves ACP session alive until turn end", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 600 });

    let error: unknown;
    try {
      await invokeGrokAcpAgent({
        sessionId: "grok-slow",
        cwd: directory,
        prompt: "reply later",
        timeoutMs: 100,
      });
    } catch (caught) {
      error = caught;
    }

    expect(isRequesterWaitTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({
      timeoutMs: 100,
      label: "Grok ACP",
    });
    await sleep(150);
    expect(existsSync(logPath) ? readFileSync(logPath, "utf8") : "").not.toContain("session/close");

    await sleep(600);
    expect(readFileSync(logPath, "utf8")).not.toContain("session/close:");
  });

  test("starts a new process and resumes the provider session after an idle process exit", async () => {
    const directory = tempDir();
    const { binDir, grokPath, logPath } = writeFakeGrok(directory);
    configureFakeGrok({ binDir, grokPath, logPath, delayMs: 0 });
    process.env.OPENSCOUT_TEST_GROK_EXIT_AFTER_PROMPT = "1";

    const first = await invokeGrokAcpAgent({
      sessionId: "grok-cold",
      poolKey: "endpoint-grok-cold",
      cwd: directory,
      prompt: "first",
      timeoutMs: 2_000,
    });
    await sleep(100);

    const second = await invokeGrokAcpAgent({
      sessionId: "grok-cold",
      poolKey: "endpoint-grok-cold",
      cwd: directory,
      prompt: "second",
      timeoutMs: 2_000,
    });

    expect(second.sessionId).toBe(first.sessionId);
    const log = readFileSync(logPath, "utf8");
    expect(log.match(/initialize:/g)).toHaveLength(2);
    expect(log.match(/session\/new:/g)).toHaveLength(1);
    expect(log).toContain("session/resume:fake-grok-acp-session");
  });
});
