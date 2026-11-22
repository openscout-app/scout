/**
 * The whole path with real parts: the reporter runs under Node as a Claude Code
 * hook would run it, posts to this Worker (served locally over an in-memory
 * bucket), and the runtime's collector turns the chunks back into a mirror
 * transcript identical to the source.
 */
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectClaudeCode,
  HubCollectorService,
  loadOrCreateHubIdentity,
  saveHubConfig,
} from "../../../packages/runtime/src/hub/index.ts";
import { serveLocalInbox } from "./serve-local.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

test("a cloud transcript arrives in the mirror byte for byte", async () => {
  const work = mkdtempSync(join(tmpdir(), "scout-hub-e2e-"));
  const inbox = serveLocalInbox({ readToken: "shr_e2e", writeToken: "shw_e2e" });
  cleanup.push(() => { inbox.server.stop(true); rmSync(work, { recursive: true, force: true }); });

  // The runtime side: key pair and config.
  const hubHome = join(work, "hub");
  const mirrorRoot = join(hubHome, "claude", "projects");
  const config = { v: 1 as const, inbox: inbox.url, readToken: "shr_e2e", writeToken: "shw_e2e", createdAt: "" };
  saveHubConfig(config, hubHome);
  const identity = loadOrCreateHubIdentity(hubHome);

  // The repo, connected.
  const repo = join(work, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  connectClaudeCode({ repoRoot: repo, config, recipientPublicKey: identity.publicKey, label: "hub-spike" });

  // The sandbox's transcript, with an image and a subagent.
  const session = "4f1d2c3b-aaaa-4bbb-8ccc-0123456789ab";
  const projectDir = join(work, "root", ".claude", "projects", "-home-user-repo");
  mkdirSync(join(projectDir, session, "subagents"), { recursive: true });
  const transcript = join(projectDir, `${session}.jsonl`);
  const subagent = join(projectDir, session, "subagents", "agent-a1b2c3.jsonl");
  const image = Buffer.alloc(200_000, 7).toString("base64");
  writeFileSync(transcript, [
    JSON.stringify({ type: "user", sessionId: session, cwd: "/home/user/repo", message: { content: [{ type: "text", text: "look" }] } }),
    JSON.stringify({ type: "user", sessionId: session, message: { content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: image } }] }] } }),
    "",
  ].join("\n"));
  writeFileSync(subagent, `${JSON.stringify({ type: "assistant", sessionId: session, isSidechain: true })}\n`);

  // Async, so this process's inbox can answer while the reporter runs.
  const runReporter = async (args: string[], env: Record<string, string>, input: object) => {
    const child = Bun.spawn(["node", join(repo, ".claude", "scout", "report.mjs"), ...args], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      env: { PATH: process.env.PATH!, SCOUT_HUB_STATE_DIR: join(work, "state"), ...env },
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
  };
  const hook = (args: string[]) => runReporter(args, { CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_e2e" },
    { session_id: session, transcript_path: transcript, cwd: "/home/user/repo", hook_event_name: "Stop" });

  await hook(["flush", "--wait"]);
  // A line still being written is held back until it ends.
  appendFileSync(transcript, '{"type":"assistant","sessionId":"' + session + '"}\n{"type":"partial');
  await hook(["flush", "--wait"]);

  const collector = new HubCollectorService({ home: hubHome, mirrorRoot });
  const first = await collector.collectOnce();
  expect(first).toMatchObject({ configured: true, rejected: 0, waiting: 0 });
  expect(first.appended).toBeGreaterThanOrEqual(3);
  expect(inbox.bucket.objects.size).toBe(0);

  const mirrored = join(mirrorRoot, "hub-spike", `${session}.jsonl`);
  const source = readFileSync(transcript, "utf8");
  expect(readFileSync(mirrored, "utf8")).toBe(source.slice(0, source.lastIndexOf("\n") + 1));
  expect(readFileSync(join(mirrorRoot, "hub-spike", session, "subagents", "agent-a1b2c3.jsonl"), "utf8")).toBe(readFileSync(subagent, "utf8"));
  expect(readFileSync(mirrored, "utf8")).toContain(image);

  // The line finishes; the detached flush (what PostToolUse runs) delivers it.
  appendFileSync(transcript, '"}\n');
  await hook(["flush"]);
  const deadline = Date.now() + 10_000;
  while (inbox.bucket.objects.size === 0 && Date.now() < deadline) await Bun.sleep(100);
  await collector.collectOnce();
  expect(readFileSync(mirrored, "utf8")).toBe(readFileSync(transcript, "utf8"));

  // Nothing is sent from a local (non-cloud) session.
  const before = inbox.bucket.objects.size;
  appendFileSync(transcript, '{"type":"user"}\n');
  await runReporter(["flush", "--wait"], {}, { session_id: session, transcript_path: transcript });
  expect(inbox.bucket.objects.size).toBe(before);
}, 30_000);
