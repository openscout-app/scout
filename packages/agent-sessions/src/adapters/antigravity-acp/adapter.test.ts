import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "./adapter.js";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(model?: string, selected?: string, nativeSessionId?: string, signedOut = false) {
  const dir = mkdtempSync(join(tmpdir(), "scout-antigravity-"));
  roots.push(dir);
  const log = join(dir, "methods");
  const command = join(dir, "agy-fixture");
  writeFileSync(command, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  appendFileSync(process.env.METHOD_LOG, JSON.stringify({ method, params, args: process.argv.slice(2) }) + "\\n");
  if (process.env.SIGNED_OUT && method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } }));
    continue;
  }
  const result = method === "initialize"
    ? { protocolVersion: 1, agentCapabilities: {loadSession:true}, authMethods: [{ id: "oauth-personal" }] }
    : method === "session/set_config_option"
      ? { configOptions: [{ id: params.configId, currentValue: process.env.SELECTED || params.value }] }
      : { sessionId: "native-session" };
  if (id !== undefined) console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}`, { mode: 0o700 });
  return {
    adapter: createAdapter({
      sessionId: "scout-session", name: "Antigravity", cwd: dir,
      env: { METHOD_LOG: log, ...(signedOut ? { SIGNED_OUT: "1" } : {}), ...(selected ? { SELECTED: selected } : {}) },
      options: { command, model, sessionId: nativeSessionId, startupTimeoutMs: 3000 },
    }),
    calls: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
}

test("starts the native stdio harness using its Google login and default model", async () => {
  const { adapter, calls } = fixture();
  try {
    await adapter.start();
    expect(calls()[0].args).toEqual(["acp", "--stdio"]);
    expect(calls().map(call => call.method)).toEqual(["initialize", "session/new"]);
  } finally { await adapter.shutdown(); }
});

test("selects the exact native model after loading a saved session", async () => {
  const { adapter, calls } = fixture("gemini-fixture", undefined, "native-session");
  try {
    await adapter.start();
    expect(calls().map(call => call.method)).toEqual(["initialize", "session/load", "session/set_config_option"]);
    expect(calls().at(-1).params).toMatchObject({ sessionId: "native-session", configId: "model", value: "gemini-fixture" });
  } finally { await adapter.shutdown(); }
});

test("rejects an unconfirmed model before sending any prompt", async () => {
  const { adapter, calls } = fixture("gemini-fixture", "other-model");
  try {
    await expect(adapter.start()).rejects.toThrow("did not confirm model");
    expect(calls().map(call => call.method)).toEqual(["initialize", "session/new", "session/set_config_option"]);
  } finally { await adapter.shutdown(); }
});

test("returns the native login command when Google requires sign-in", async () => {
  const { adapter, calls } = fixture(undefined, undefined, undefined, true);
  try {
    await expect(adapter.start()).rejects.toThrow("agy acp --login");
    expect(calls().map(call => call.method)).toEqual(["initialize", "session/new"]);
  } finally { await adapter.shutdown(); }
});
