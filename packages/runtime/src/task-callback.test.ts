import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightRecord, InvocationRequest } from "@openscout/protocol";
import { buildLocalAgentDirectInvocationPrompt, buildLocalAgentNudge, buildScoutReplyContext } from "./local-agents.js";
import {
  callbackRunsHere,
  describeTaskCallbackRun,
  invocationCallbackCode,
  namedPaths,
  runTaskCallback,
  taskCallbackResult,
} from "./task-callback.js";

const OPEN_FIRST = "export default async ({ result, scout }) => { if (result.files[0]) await scout.open(result.files[0]); };";
/** A callback file whose default export is `fn`. */
const file = (fn: string) => `export default ${fn};`;
const invocation = (patch: Partial<InvocationRequest> = {}, code = OPEN_FIRST): InvocationRequest => ({
  id: "inv-1",
  requesterId: "operator",
  requesterNodeId: "node-home",
  targetAgentId: "ranger",
  targetNodeId: "node-home",
  action: "execute",
  task: "Write the study.",
  conversationId: "dm.operator.ranger",
  messageId: "msg-1",
  ensureAwake: true,
  stream: false,
  createdAt: 1,
  metadata: { callback: { code } },
  ...patch,
});
const flight = (patch: Partial<FlightRecord> = {}): FlightRecord => ({
  id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "ranger", state: "completed", ...patch,
});

const scratch = mkdtempSync(join(tmpdir(), "task-callback-test-"));
const page = join(scratch, "study.html");
const spaced = join(scratch, "study page.html");
const notes = join(scratch, "notes.md");
const script = join(scratch, "run.command");
for (const file of [page, spaced, notes, script]) writeFileSync(file, "x");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Opened = [string, string][];
const opener = (opened: Opened) => async (path: string, mode: string) => { opened.push([path, mode]); return { exitCode: 0 }; };
const never = async () => { throw new Error("must not open"); };

describe("ask --callback", () => {
  test("reads only well-formed callback code from task metadata", () => {
    expect(invocationCallbackCode(invocation())).toBe(OPEN_FIRST);
    for (const callback of ["open", { code: "  " }, { code: 7 }, { code: "x".repeat(16_001) }, null]) {
      expect(invocationCallbackCode(invocation({ metadata: { callback } }))).toBeUndefined();
    }
    expect(invocationCallbackCode(invocation({ metadata: {} }))).toBeUndefined();
  });

  test("finds the absolute paths a reply names, in order, and skips links", () => {
    const reply = [
      "Done. Studio: http://scout.local:43140/plans/study.html",
      "Page: [study](/Users/me/plans/study.html), also `~/plans/deck.pdf`.",
      "Encoded: file:///tmp/a%20b.png. Notes: /tmp/notes.md and /Users/me/plans/study.html again",
      "Quoted: `/Users/me/Application Support/page.html`.",
    ].join("\n");
    expect(namedPaths(reply)).toEqual([
      "/Users/me/plans/study.html",
      join(homedir(), "plans/deck.pdf"),
      "/tmp/a b.png",
      "/tmp/notes.md",
      "/Users/me/Application Support/page.html",
    ]);
  });

  test("the result is data: task, state, reply and the files that exist", async () => {
    const output = `Wrote \`${spaced}\` and ${notes}; the old /nowhere/draft.html is gone.`;
    expect(await taskCallbackResult(flight({ output }), invocation())).toEqual({
      taskId: "inv-1", state: "completed", reply: output, files: [spaced, notes],
    });
    expect(await taskCallbackResult(flight({ state: "failed", summary: "Ran out of time." }), invocation()))
      .toEqual({ taskId: "inv-1", state: "failed", reply: "Ran out of time.", files: [] });
  });

  test("runs on the worker's runtime once the task ends, whatever the end", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(callbackRunsHere(flight({ state }), invocation(), "node-home")).toBe(true);
    }
    expect(callbackRunsHere(flight({ state: "running" }), invocation(), "node-home")).toBe(false);
    const remote = invocation({ targetNodeId: "node-remote" });
    expect(callbackRunsHere(flight(), remote, "node-home")).toBe(false);
    expect(callbackRunsHere(flight(), remote, "node-remote")).toBe(true);
    // An ordinary ask names no target node: the worker's node comes from the
    // dispatch or the target agent, never from the requester.
    const unnamed = invocation({ targetNodeId: undefined });
    expect(callbackRunsHere(flight(), unnamed, "node-home")).toBe(false);
    const remoteAgent = { authorityNodeId: "node-remote", homeNodeId: "node-remote" };
    expect(callbackRunsHere(flight(), unnamed, "node-home", remoteAgent)).toBe(false);
    expect(callbackRunsHere(flight(), unnamed, "node-remote", remoteAgent)).toBe(true);
    const localAgent = { authorityNodeId: "node-home", homeNodeId: "node-home" };
    expect(callbackRunsHere(flight(), unnamed, "node-home", localAgent)).toBe(true);
    const acked = flight({ metadata: { dispatchAck: { nodeId: "node-remote" } } });
    expect(callbackRunsHere(acked, unnamed, "node-home", localAgent)).toBe(false);
    expect(callbackRunsHere(acked, unnamed, "node-remote")).toBe(true);
    // A session target with an endpoint and no agent card, ended before dispatch.
    expect(callbackRunsHere(flight(), unnamed, "node-home", undefined, "node-home")).toBe(true);
    expect(callbackRunsHere(flight(), unnamed, "node-home", undefined, "node-remote")).toBe(false);
    expect(callbackRunsHere(flight(), invocation({ metadata: {} }), "node-home")).toBe(false);
    expect(callbackRunsHere(flight(), invocation(), "")).toBe(false);
  });

  test("the asker's function opens the page through the host's reveal probe", async () => {
    const opened: Opened = [];
    const run = await runTaskCallback({
      flight: flight({ output: `Missing: /nowhere/old.html\nReady: file://${encodeURI(spaced)}` }),
      invocation: invocation(), nodeId: "node-home", platform: "darwin", open: opener(opened),
    });
    expect(opened).toEqual([[spaced, "darwinOpen"]]);
    expect(run).toEqual({ ok: true, opened: [spaced], logs: [] });
    expect(describeTaskCallbackRun("inv-1", run!)).toEqual([`[openscout-runtime] callback for task inv-1 ran; opened ${spaced}`]);

    const chooser = `async ({ result, scout }) => {
      const page = result.files.find((file) => file.endsWith(".html"));
      console.log(result.state, result.files.length);
      if (page) console.log("opened", await scout.open(page));
    }`;
    const linux = await runTaskCallback({
      flight: flight({ output: `Notes ${notes}, page \`${page}\`` }), invocation: invocation({}, file(chooser)),
      nodeId: "node-home", platform: "linux", open: opener(opened),
    });
    expect(linux).toEqual({ ok: true, opened: [page], logs: ["completed 2", `opened ${page}`] });
    expect(opened.at(-1)).toEqual([page, "xdgOpen"]);
    expect(describeTaskCallbackRun("inv-1", linux!)).toContain(`[openscout-runtime] callback for task inv-1 log: opened ${page}`);
  });

  test("scout.open opens existing documents only, and a few per callback", async () => {
    const tryOpen = (target: string, platform: NodeJS.Platform = "darwin") => runTaskCallback({
      flight: flight(), invocation: invocation({}, file(`({ scout }) => scout.open(${JSON.stringify(target)})`)),
      nodeId: "node-home", platform, open: never,
    });
    expect(await tryOpen(script)).toMatchObject({ ok: false, error: `Error: scout.open opens html, pdf and image files only, not ${script}` });
    expect(await tryOpen(notes)).toMatchObject({ ok: false, error: expect.stringContaining("html, pdf and image files only") });
    expect(await tryOpen("study.html")).toMatchObject({ ok: false, error: expect.stringContaining("absolute path") });
    expect(await tryOpen("/nowhere/study.html")).toMatchObject({ ok: false, error: "Error: scout.open found no file at /nowhere/study.html" });
    expect(await tryOpen(page, "win32")).toMatchObject({ ok: false, error: "Error: scout.open has no opener on win32" });

    const opened: Opened = [];
    const many = await runTaskCallback({
      flight: flight(), invocation: invocation({}, file(`async ({ scout }) => { for (let i = 0; i < 9; i++) await scout.open(${JSON.stringify(page)}) }`)),
      nodeId: "node-home", platform: "darwin", open: opener(opened),
    });
    expect(many).toMatchObject({ ok: false, error: "Error: scout.open opens at most 5 files per callback" });
    expect(opened).toHaveLength(5);
    expect(describeTaskCallbackRun("inv-1", many!)[0]).toStartWith("[openscout-runtime] callback for task inv-1 failed: Error: scout.open opens at most 5");
  });

  test("a failed opener, a broken function and another host's task are reported or skipped", async () => {
    expect(await runTaskCallback({ flight: flight({ output: page }), invocation: invocation(), nodeId: "node-home", platform: "darwin",
      open: async () => ({ exitCode: 1 }) })).toMatchObject({ ok: false, opened: [], error: "Error: the opener exited 1" });
    expect(await runTaskCallback({ flight: flight({ output: page }), invocation: invocation({}, file("({ result ) =>")), nodeId: "node-home", open: never }))
      .toMatchObject({ ok: false, error: expect.stringContaining("SyntaxError") });
    expect(await runTaskCallback({ flight: flight({ output: page }), invocation: invocation({}, file("() => new Promise(() => {})")), nodeId: "node-home",
      open: never, limits: { timeoutMs: 200 } })).toMatchObject({ ok: false, error: "the callback did not finish within 0.2s" });
    expect(await runTaskCallback({ flight: flight({ output: page }), invocation: invocation(), nodeId: "node-other", open: never })).toBeUndefined();
    expect(await runTaskCallback({ flight: flight({ output: "No page this time." }), invocation: invocation(), nodeId: "node-home", open: never }))
      .toEqual({ ok: true, opened: [], logs: [] });
  });

  test("the worker is not told about the callback", () => {
    const code = file("({ scout }) => scout.open('/tmp/secret-marker.html')");
    const withCallback = invocation({}, code);
    expect(buildLocalAgentDirectInvocationPrompt("ranger", withCallback)).toBe(buildLocalAgentDirectInvocationPrompt("ranger", invocation({ metadata: {} })));
    expect(buildLocalAgentNudge("ranger", withCallback, "flt-1")).not.toContain("secret-marker");
    expect(JSON.stringify(buildScoutReplyContext("ranger", withCallback))).not.toContain("secret-marker");
  });
});
