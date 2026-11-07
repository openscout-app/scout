import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightRecord, InvocationRequest } from "@openscout/protocol";
import { buildLocalAgentDirectInvocationPrompt, buildLocalAgentNudge, buildScoutReplyContext } from "./local-agents.js";
import {
  callbackLine,
  callbackRunsHere,
  describeTaskCallbackRun,
  invocationCallback,
  openableFiles,
  runTaskCallback,
} from "./task-callback.js";

const invocation = (patch: Partial<InvocationRequest> = {}): InvocationRequest => ({
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
  metadata: { callback: "open" },
  ...patch,
});
const flight = (patch: Partial<FlightRecord> = {}): FlightRecord => ({
  id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "ranger", state: "completed", ...patch,
});

const scratch = mkdtempSync(join(tmpdir(), "task-callback-test-"));
const page = join(scratch, "study.html");
const spaced = join(scratch, "study page.html");
writeFileSync(page, "<h1>Study</h1>");
writeFileSync(spaced, "<h1>Study</h1>");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("ask --callback open", () => {
  test("reads only a known function from task metadata", () => {
    expect(invocationCallback(invocation())).toBe("open");
    expect(invocationCallback(invocation({ metadata: { callback: "notify" } }))).toBeUndefined();
    expect(invocationCallback(invocation({ metadata: { callback: 'open "$SCOUT_LINK"' } }))).toBeUndefined();
    expect(invocationCallback(invocation({ metadata: {} }))).toBeUndefined();
  });

  test("finds document paths in a reply, in order, and skips links and other files", () => {
    const reply = [
      "Done. Studio: http://scout.local:43140/plans/study.html",
      "Page: [study](/Users/me/plans/study.html), also `~/plans/deck.pdf`.",
      "Encoded: file:///tmp/a%20b.png. Script: /tmp/run.command and /tmp/notes.md",
      "Quoted: `/Users/me/Application Support/page.html`.",
    ].join("\n");
    expect(openableFiles(reply)).toEqual([
      "/Users/me/plans/study.html",
      join(homedir(), "plans/deck.pdf"),
      "/tmp/a b.png",
      "/Users/me/Application Support/page.html",
    ]);
  });

  test("runs only on the worker's runtime, and only when the task completes", () => {
    expect(callbackRunsHere(flight(), invocation(), "node-home")).toBe(true);
    expect(callbackRunsHere(flight({ state: "failed" }), invocation(), "node-home")).toBe(false);
    expect(callbackRunsHere(flight({ state: "cancelled" }), invocation(), "node-home")).toBe(false);
    const remote = invocation({ targetNodeId: "node-remote" });
    expect(callbackRunsHere(flight(), remote, "node-home")).toBe(false);
    expect(callbackRunsHere(flight(), remote, "node-remote")).toBe(true);
    expect(callbackRunsHere(flight(), invocation({ targetNodeId: undefined }), "node-home")).toBe(true);
    expect(callbackRunsHere(flight(), invocation({ metadata: {} }), "node-home")).toBe(false);
    expect(callbackRunsHere(flight(), invocation(), "")).toBe(false);
  });

  test("opens the first named page that exists, through the host's reveal probe", async () => {
    const opened: [string, string][] = [];
    const run = await runTaskCallback({
      flight: flight({ output: `Missing: /nowhere/old.html\nReady: file://${encodeURI(spaced)}` }),
      invocation: invocation(), nodeId: "node-home", platform: "darwin",
      open: async (path, mode) => { opened.push([path, mode]); return { exitCode: 0 }; },
    });
    expect(opened).toEqual([[spaced, "darwinOpen"]]);
    expect(run).toEqual({ callback: "open", outcome: "opened", target: spaced });
    expect(describeTaskCallbackRun("inv-1", run!)).toBe(`[openscout-runtime] callback open for task inv-1 opened ${spaced}`);
    expect(await runTaskCallback({ flight: flight({ output: `Ready: \`${spaced}\`` }), invocation: invocation(), nodeId: "node-home",
      platform: "linux", open: async (path, mode) => { opened.push([path, mode]); } })).toMatchObject({ outcome: "opened", target: spaced });
    expect(opened.at(-1)).toEqual([spaced, "xdgOpen"]);
  });

  test("reports a reply with nothing to open, a failed opener, and a host with no opener", async () => {
    const never = async () => { throw new Error("must not open"); };
    expect(await runTaskCallback({ flight: flight({ output: "No page this time." }), invocation: invocation(), nodeId: "node-home", open: never }))
      .toEqual({ callback: "open", outcome: "nothing_to_open" });
    expect(await runTaskCallback({ flight: flight({ output: page }), invocation: invocation(), nodeId: "node-home", platform: "darwin",
      open: async () => ({ exitCode: 1 }) })).toMatchObject({ outcome: "failed", target: page, detail: "exited 1" });
    expect(await runTaskCallback({ flight: flight({ output: page }), invocation: invocation(), nodeId: "node-home", platform: "darwin",
      open: async () => { throw new Error("probe refused"); } })).toMatchObject({ outcome: "failed", detail: "probe refused" });
    expect(await runTaskCallback({ flight: flight({ output: page }), invocation: invocation(), nodeId: "node-home", platform: "win32", open: never }))
      .toMatchObject({ outcome: "failed", detail: "no opener on win32" });
    expect(await runTaskCallback({ flight: flight({ output: page }), invocation: invocation(), nodeId: "node-other", open: never }))
      .toBeUndefined();
  });

  test("the worker is told the runtime opens the page, and not to open it itself", () => {
    expect(buildScoutReplyContext("ranger", invocation())?.callback).toBe("open");
    expect(buildScoutReplyContext("ranger", invocation({ metadata: {} }))).not.toHaveProperty("callback");
    const prompt = buildLocalAgentDirectInvocationPrompt("ranger", invocation());
    const block = prompt.indexOf("<!-- SCOUT CALLBACK -->");
    expect(block).toBeGreaterThan(prompt.indexOf("<!-- SCOUT BROKER REPLY MODE -->"));
    expect(block).toBeLessThan(prompt.indexOf("<!-- SCOUT SESSION SEARCH -->"));
    expect(prompt).toContain("Do not open it yourself.");
    expect(buildLocalAgentDirectInvocationPrompt("ranger", invocation({ metadata: {} }))).not.toContain("SCOUT CALLBACK");
    expect(buildLocalAgentNudge("ranger", invocation(), "flt-1")).toContain(callbackLine(invocation())!);
    expect(buildLocalAgentNudge("ranger", invocation({ metadata: {} }), "flt-1")).not.toContain("runtime opens the page");
  });
});
