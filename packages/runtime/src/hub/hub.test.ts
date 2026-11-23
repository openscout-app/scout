import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHistorySessionSnapshot } from "@openscout/agent-sessions";

import { ClaudeSource } from "../tail/claude-source.js";
import { readSessionFileScan } from "../system-probes/sessions.js";
import { connectClaudeCode, disconnectClaudeCode, reporterCommand, reporterSha256 } from "./connect.js";
import { applyChunkToMirror, mirrorPathForHeader } from "./mirror.js";
import { REPORTER_SOURCE } from "./reporter-source.js";
import { generateHubKeyPair, openHubChunk, sealHubChunk, type HubChunkHeader } from "./seal.js";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-hub-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT;
  delete process.env.OPENSCOUT_HUB_CLAUDE_MIRROR_ROOT;
});

const SESSION = "0b6c5c1e-1111-4222-8333-944445555666";
const header = (overrides: Partial<HubChunkHeader> = {}): HubChunkHeader => ({
  v: 1, kind: "claude-code.transcript", sessionId: SESSION, remoteSessionId: "cse_test", label: "hub-spike",
  file: `${SESSION}.jsonl`, offset: 0, seq: 0, cwd: "/home/user/repo", sentAt: "2026-11-22T00:00:00.000Z", ...overrides,
});

async function importReporter(): Promise<{
  seal(header: HubChunkHeader, data: Uint8Array, recipient: Uint8Array): Buffer;
  readPieces(path: string, offset: number, maxPiece?: number): { pieces: Array<{ offset: number; data: Buffer }>; size: number };
}> {
  const path = join(tempDir(), "report.mjs");
  writeFileSync(path, REPORTER_SOURCE);
  return import(path);
}

describe("Scout Hub sealing", () => {
  test("the runtime opens what the reporter seals, and nothing else", async () => {
    const reporter = await importReporter();
    const keys = generateHubKeyPair();
    const data = Buffer.from('{"type":"user"}\n');
    const opened = openHubChunk(reporter.seal(header(), data, Buffer.from(keys.publicKey)), keys);
    expect(opened.header).toEqual(header());
    expect(Buffer.from(opened.data).toString()).toBe(data.toString());

    const other = generateHubKeyPair();
    expect(() => openHubChunk(reporter.seal(header(), data, Buffer.from(other.publicKey)), keys)).toThrow();
    const tampered = sealHubChunk(header(), data, keys.publicKey);
    tampered[tampered.length - 20] ^= 1;
    expect(() => openHubChunk(tampered, keys)).toThrow();
  });

  test("the reporter source is plain JavaScript that Node can load", async () => {
    const path = join(tempDir(), "report.mjs");
    writeFileSync(path, REPORTER_SOURCE);
    const node = async (args: string[], stdin = "") => {
      const child = Bun.spawn(["node", ...args], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", env: { PATH: process.env.PATH! } });
      const out = await new Response(child.stdout).text();
      return { code: await child.exited, out };
    };
    expect(await node(["--check", path])).toEqual({ code: 0, out: "" });
    expect((await node([path, "version"])).out.trim()).toBe("scout-hub-reporter 1");
    // Outside a cloud session it does nothing, even with a hook payload on stdin.
    expect(await node([path, "flush"], "{}")).toEqual({ code: 0, out: "" });
  });

  test("the reporter sends whole lines only, in pieces that end at line ends", async () => {
    const reporter = await importReporter();
    const path = join(tempDir(), "t.jsonl");
    writeFileSync(path, "aaaa\nbbbb\ncccccccccc\npartial");
    const { pieces } = reporter.readPieces(path, 0, 6);
    expect(pieces.map((piece) => piece.data.toString())).toEqual(["aaaa\n", "bbbb\n", "cccccccccc\n"]);
    expect(pieces.map((piece) => piece.offset)).toEqual([0, 5, 10]);
    expect(reporter.readPieces(path, 21).pieces).toEqual([]);
  });
});

describe("Scout Hub mirror", () => {
  test("headers can only point inside the mirror, at Claude's own layout", () => {
    const root = tempDir();
    expect(mirrorPathForHeader(root, header())).toEqual({ path: join(root, "hub-spike", `${SESSION}.jsonl`) });
    expect(mirrorPathForHeader(root, header({ file: `${SESSION}/subagents/agent-abc123.jsonl` }))).toHaveProperty("path");
    expect(mirrorPathForHeader(root, header({ file: `${SESSION}/subagents/workflows/run-1/agent-abc.jsonl` }))).toHaveProperty("path");
    for (const bad of [
      header({ label: ".." }),
      header({ label: "a/b" }),
      header({ file: `../${SESSION}.jsonl` }),
      header({ file: "other.jsonl" }),
      header({ file: `${SESSION}/subagents/workflows/../agent-abc.jsonl` }),
      header({ sessionId: "../x" }),
      header({ offset: -1 }),
      { ...header(), kind: "something-else" } as unknown as HubChunkHeader,
    ]) {
      expect(mirrorPathForHeader(root, bad)).toHaveProperty("reason");
    }
  });

  test("chunks append in order; repeats are skipped and gaps wait", () => {
    const root = tempDir();
    const path = join(root, "hub-spike", `${SESSION}.jsonl`);
    expect(applyChunkToMirror(root, header({ offset: 4 }), Buffer.from("two\n"))).toMatchObject({ outcome: "gap", have: 0 });
    expect(applyChunkToMirror(root, header(), Buffer.from("one\n"))).toMatchObject({ outcome: "appended", bytes: 4 });
    expect(applyChunkToMirror(root, header({ offset: 4 }), Buffer.from("two\n"))).toMatchObject({ outcome: "appended" });
    expect(applyChunkToMirror(root, header(), Buffer.from("one\n"))).toMatchObject({ outcome: "duplicate" });
    // A reporter that lost its place resends from 0: only the new tail is written.
    expect(applyChunkToMirror(root, header(), Buffer.from("one\ntwo\nthree\n"))).toMatchObject({ outcome: "appended", bytes: 6 });
    expect(applyChunkToMirror(root, header({ offset: 14 }), Buffer.from("no newline"))).toMatchObject({ outcome: "rejected" });
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\nthree\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("scout hub connect claude-code", () => {
  const config = { v: 1 as const, inbox: "https://inbox.example", readToken: "shr_read", writeToken: "shw_write", createdAt: "" };

  test("it writes the reporter and gated hooks, keeps other hooks, and is idempotent", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".claude"));
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "echo theirs" }] };
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ model: "x", hooks: { PostToolUse: [theirs] } }));
    const keys = generateHubKeyPair();

    const first = connectClaudeCode({ repoRoot: repo, config, recipientPublicKey: keys.publicKey });
    expect(first.label).toBe(repo.split("/").pop()!.replace(/^[.-]+/u, ""));
    expect(first.changed.sort()).toEqual([".claude/scout/hub.json", ".claude/scout/report.mjs", ".claude/settings.json"]);
    expect(readFileSync(join(repo, ".claude", "scout", "report.mjs"), "utf8")).toBe(REPORTER_SOURCE);
    const hub = JSON.parse(readFileSync(join(repo, ".claude", "scout", "hub.json"), "utf8"));
    expect(hub).toMatchObject({ inbox: config.inbox, token: "shw_write", reporter: { version: 1, sha256: reporterSha256() } });
    expect(JSON.stringify(hub)).not.toContain("shr_read");
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.model).toBe("x");
    expect(settings.hooks.PostToolUse).toEqual([theirs, { hooks: [{ type: "command", command: reporterCommand("flush") }] }]);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('[ "$CLAUDE_CODE_REMOTE" = true ] && node');

    expect(connectClaudeCode({ repoRoot: repo, config, recipientPublicKey: keys.publicKey }).changed).toEqual([]);

    disconnectClaudeCode(repo);
    expect(JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"))).toEqual({ model: "x", hooks: { PostToolUse: [theirs] } });
  });

  test("it refuses a folder that is not a repo root, and broken settings", () => {
    const keys = generateHubKeyPair();
    expect(() => connectClaudeCode({ repoRoot: tempDir(), config, recipientPublicKey: keys.publicKey })).toThrow(/git repository/);
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.json"), "{ not json");
    expect(() => connectClaudeCode({ repoRoot: repo, config, recipientPublicKey: keys.publicKey })).toThrow(/not valid JSON/);
  });
});

describe("Claude source with a hub mirror", () => {
  test("a mirrored cloud session is discovered under its repo label", async () => {
    const local = tempDir();
    const mirror = tempDir();
    process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = local;
    process.env.OPENSCOUT_HUB_CLAUDE_MIRROR_ROOT = mirror;
    mkdirSync(join(mirror, "hub-spike"), { recursive: true });
    const line = JSON.stringify({ type: "user", sessionId: SESSION, cwd: "/home/user/repo", timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } });
    const path = join(mirror, "hub-spike", `${SESSION}.jsonl`);
    writeFileSync(path, `${line}\n`);

    const found = await ClaudeSource.discoverTranscripts([], "shallow");
    const cloud = found.find((transcript) => transcript.sessionId === SESSION);
    expect(cloud).toMatchObject({ project: "hub-spike", cwd: "/home/user/repo", transcriptPath: path });
    expect(ClaudeSource.findTranscript?.(SESSION)).toMatchObject({ project: "hub-spike" });
    expect(createHistorySessionSnapshot({ path, content: `${line}\n` }).snapshot.session).toMatchObject({
      adapterType: "claude-code", name: "hub-spike",
    });
    expect(await readSessionFileScan({ home: tempDir(), maxAgeDays: 1, limit: 5 })).toEqual([
      expect.objectContaining({ path, project: "hub-spike", agent: "claude-code" }),
    ]);
  });
});
