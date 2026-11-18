import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRexSurface, readRexStatus, sendRexPrompt, startRexAgent, type RexSurface } from "./rex-terminal.js";

const uuid = "61d4a135-ee83-46b0-b598-9ec8ee75c913";
const surface: RexSurface = { backend: "rex", sessionId: "session:" + uuid, windowId: "window:" + uuid, blockId: "block:" + uuid };
const originalPath = process.env.PATH;
let dir: string;

// Exercise the real argv/stdin boundary, including Rex's creation receipt and
// the two independent checks of who owns input. No terminal server is needed.
const fakeRex = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const target = JSON.parse(fs.readFileSync(path.join(dir, "surface")));
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8");
fs.appendFileSync(path.join(dir, "calls"), JSON.stringify(args) + "\\n");
const reply = value => console.log(JSON.stringify(value));
if (args.includes("new")) {
  reply({ window_id: target.windowId, block_ids: [target.blockId] });
} else if (args.includes("process")) {
  reply({ foreground: { pid: 12345, name: "version", invoked_path: "/bin/claude" }, last_exit: null });
} else if (args.includes("program_status")) {
  reply({ records: [{ state: "blocked", kind: "permission", progress: 42, ...(mode === "blocked" ? { owner: { pid: 12345 } } : {}) }] });
} else if (args.includes("modes")) {
  reply({ modes: [{ name: "bracketed_paste", set: true }] });
} else if (args.includes("send")) {
  const pasted = fs.readFileSync(0, "utf8");
  fs.appendFileSync(path.join(dir, "input"), JSON.stringify(pasted) + "\\n");
  const marker = pasted.match(/\\[Scout [0-9a-f]+\\]/);
  if (marker) fs.writeFileSync(path.join(dir, "marker"), marker[0]);
} else if (args.includes("format")) {
  reply({ content: mode === "picker" ? "› 1. Trust folder" : "❯ " + fs.readFileSync(path.join(dir, "marker"), "utf8") });
} else if (!args.includes("send-key") && !args.includes("close")) {
  throw Error("unexpected rex command");
}
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scout-rex-test-"));
  await Promise.all([
    writeFile(join(dir, "rex"), fakeRex, { mode: 0o755 }),
    writeFile(join(dir, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 }),
    writeFile(join(dir, "surface"), JSON.stringify(surface)),
    writeFile(join(dir, "mode"), "composer"), writeFile(join(dir, "calls"), ""),
  ]);
  process.env.PATH = dir + ":" + originalPath;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

async function calls(): Promise<string[][]> {
  return (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("starts one native window with the new Scout identity and binds the observed harness", async () => {
  const input = { sessionId: surface.sessionId, harness: "claude" as const, projectPath: dir, name: "Review $changes" };
  const receipt = await startRexAgent(input, "agent-child", async (live, name) => {
    expect(live).toMatchObject({ harness: "claude", surface, pid: 12345 });
    expect(live.nativeSessionId).toBeTruthy();
    expect(name).toBe(input.name!);
    return { agentId: "agent-child" };
  });
  expect(receipt).toMatchObject({ agentId: "agent-child", surface });
  const creation = (await calls()).filter(argv => argv.includes("new"));
  expect(creation).toHaveLength(1);
  expect(creation[0]).toEqual(expect.arrayContaining(["--autostart=false", "--focus=false", "--shell=none", surface.sessionId,
    dir, input.name, "OPENSCOUT_AGENT=agent-child", "--session-id"]));
  expect((await readRexStatus(surface)).programStatus).toEqual([{ state: "blocked", kind: "permission", progress: 42 }]);
});

test("rejects a partial parent ID before launch and closes only the created block on a binding failure", async () => {
  expect(isRexSurface({ ...surface, blockId: "" })).toBe(false);
  const input = { sessionId: "focused", projectPath: dir, harness: "claude" as const };
  const reject = async () => { throw new Error("binding failed"); };
  await expect(startRexAgent(input, "child", reject)).rejects.toThrow("full local Rex session ID");
  expect(await calls()).toEqual([]);
  await expect(startRexAgent({ ...input, sessionId: surface.sessionId }, "child", reject)).rejects.toThrow("binding failed");
  expect((await calls()).at(-1)?.slice(2)).toEqual(["block", "close", "-s", surface.sessionId, surface.blockId]);
});

test("delivers literal multiline input to the bound process after a composer receipt", async () => {
  await sendRexPrompt(surface, 12345, "claude", "first\nsecond");
  const sent = (await readFile(join(dir, "input"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(sent[1]).toBe("\x1b[200~first\nsecond\x1b[201~");
  const keys = (await calls()).filter(argv => argv.includes("send-key"));
  expect(keys).toHaveLength(1);
  expect(keys[0]?.slice(2)).toEqual(["send-key", "-s", surface.sessionId, "-b", surface.blockId, "Enter"]);
});

test("never submits to a replaced process or a startup picker", async () => {
  await expect(sendRexPrompt(surface, 34567, "claude", "task")).rejects.toThrow("does not own input");
  expect((await calls()).some(argv => argv.includes("send"))).toBe(false);
  await writeFile(join(dir, "mode"), "blocked");
  await expect(sendRexPrompt(surface, 12345, "claude", "task")).rejects.toThrow("permission");
  expect((await calls()).some(argv => argv.includes("send"))).toBe(false);
  await writeFile(join(dir, "mode"), "picker");
  await expect(sendRexPrompt(surface, 12345, "claude", "task")).rejects.toThrow("composer");
  expect((await calls()).some(argv => argv.includes("send-key"))).toBe(false);
  expect(await readFile(join(dir, "input"), "utf8")).not.toContain("task");
});
