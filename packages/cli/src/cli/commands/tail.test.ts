import { describe, expect, test } from "bun:test";

import type { TailEvent } from "../../lib/core/tail/service.ts";
import { createScoutCommandContext } from "../context.ts";
import {
  parseTailCommandOptions,
  renderTailCommandHelp,
  renderTailEvent,
  renderTailEvents,
  runTailCommand,
} from "./tail.ts";

function event(overrides: Partial<TailEvent>): TailEvent {
  return {
    id: "evt-1",
    ts: Date.UTC(2026, 7, 17, 18, 32, 1),
    source: "grok",
    sessionId: "sess-1",
    pid: 1,
    parentPid: null,
    project: "blink",
    cwd: "/Users/you/dev/blink",
    harness: "unattributed",
    kind: "system",
    summary: "phase · waiting_for_model",
    ...overrides,
  };
}

describe("tail command", () => {
  test("documents broker tail filters", () => {
    const help = renderTailCommandHelp();

    expect(help).toContain("Usage: scout tail");
    expect(help).toContain("--source <name>");
    expect(help).toContain("--kind <kind>");
    expect(help).toContain("--session <id>");
    expect(help).toContain("--transcripts");
    expect(help).toContain("--verbose");
    expect(help).toContain("Plain output hides harness lifecycle noise");
    expect(help).toContain("--json stays complete");
  });

  test("parses filters and one-shot mode", () => {
    expect(parseTailCommandOptions([
      "--source",
      "codex,claude",
      "--kind",
      "tool-result",
      "--session",
      "sess-1",
      "--query",
      "permission",
      "--limit",
      "25",
      "--once",
      "--raw",
    ])).toEqual({
      limit: 25,
      sources: ["codex", "claude"],
      kinds: ["tool-result"],
      sessionId: "sess-1",
      query: "permission",
      once: true,
      transcripts: false,
      raw: true,
      verbose: false,
    });
  });

  test("parses verbose and debug firehose flags", () => {
    expect(parseTailCommandOptions(["--verbose"]).verbose).toBe(true);
    expect(parseTailCommandOptions(["--debug"]).verbose).toBe(true);
  });

  test("rejects unknown kinds", () => {
    expect(() => parseTailCommandOptions(["--kind", "nope"]))
      .toThrow("unknown tail kind");
  });

  test("prints help before broker access", async () => {
    const lines: string[] = [];
    const context = createScoutCommandContext({
      cwd: "/tmp/openscout-test",
      env: {},
      stdout: (line) => lines.push(line),
      stderr: () => undefined,
      isTty: false,
    });

    await runTailCommand(context, ["-h"]);

    expect(lines.join("\n")).toContain("Usage: scout tail");
  });
});

describe("tail plain rendering", () => {
  const noise = event({ id: "noise", summary: "phase · waiting_for_model" });
  const firstToken = event({ id: "token", summary: "first token" });
  const loop = event({ id: "loop", summary: "loop 3 started" });
  const tool = event({
    id: "work",
    kind: "tool-result",
    summary: "Read · /Users/you/dev/blink/packages/local/src/ui/app/main.js · success",
  });
  const longTool = event({
    id: "long",
    kind: "tool-result",
    summary: "Read · /Users/you/dev/blink/packages/local/src/ui/app/main.js --extra-flag-that-would-wrap-a-herd-pane-and-dump-argv · success",
  });
  const toolStart = event({
    id: "start",
    kind: "tool",
    summary: "Read · /Users/you/dev/blink/packages/local/src/ui/app/main.js",
  });

  test("filters grok lifecycle noise from plain output", () => {
    const rendered = renderTailEvents([noise, firstToken, loop, tool], { columns: 146 });

    expect(rendered).not.toContain("waiting_for_model");
    expect(rendered).not.toContain("first token");
    expect(rendered).not.toContain("loop 3 started");
    expect(renderTailEvents([
      event({ summary: "permission requested · Read" }),
      event({ summary: "permission allow · Read" }),
      tool,
    ], { columns: 83 })).not.toContain("permission");
    expect(rendered).not.toContain("Read ·");
    expect(rendered).toContain("read");
    expect(rendered).toContain("main.js");
    expect(renderTailEvents([toolStart, tool], { columns: 83 })).not.toContain("▸");
    expect(renderTailEvents([toolStart], { columns: 83 })).toBe("");
  });

  test("a known noisy grok phase does not appear by default", () => {
    expect(renderTailEvents([
      event({ summary: "phase · streaming_reasoning" }),
      event({ summary: "phase · streaming_text" }),
      event({ summary: "phase · tool_execution" }),
      event({ summary: "phase · permission_prompt" }),
      event({ summary: "phase · waiting_for_model" }),
    ], { columns: 146 })).toBe("");
  });

  test("verbose and raw still show the firehose", () => {
    const verbose = renderTailEvents([noise, tool], { verbose: true, columns: 146 });
    const raw = renderTailEvents([noise, tool], {
      raw: true,
      columns: 146,
    });

    expect(verbose).toContain("phase · waiting_for_model");
    expect(verbose).toContain("Read ·");
    expect(raw).toContain("phase · waiting_for_model");
    expect(raw).toContain("Read ·");
  });

  test("narrow compact lines stay within the pane width", () => {
    const line = renderTailEvent(longTool, { columns: 146 });

    expect(line.length).toBeLessThanOrEqual(146);
    expect(line).toMatch(/^\d{2}:\d{2}  grok\s+read main\.js/);
    expect(line).not.toContain("/Users/you/dev/blink/packages/local/src/ui/app/main.js");
    expect(line).not.toContain("success");
  });

  test("a thin rail never wraps", () => {
    const line = renderTailEvent(longTool, { columns: 83, color: true });

    expect(line).not.toContain("\n");
    expect([...line.replace(/\x1b\[[0-9;]*m/g, "")].length).toBeLessThanOrEqual(83);
    expect(line).toContain("grok");
    expect(line).toContain("read");
    expect(line).not.toContain("▸");
  });

  test("an extremely narrow colored rail closes ANSI styling", () => {
    const line = renderTailEvent(longTool, { columns: 8, color: true });

    expect(line).toEndWith("\x1b[0m");
    expect([...line.replace(/\x1b\[[0-9;]*m/g, "")].length).toBeLessThanOrEqual(8);
  });
  test("raw payload dump keeps the first line width-bounded", () => {
    const output = renderTailEvent({
      ...longTool,
      raw: { tool_name: "Read", path: "/Users/you/dev/blink/packages/local/src/ui/app/main.js" },
    }, { raw: true, columns: 120 });
    const [first = ""] = output.split("\n");

    expect(first.length).toBeLessThanOrEqual(120);
    expect(output).toContain("\"tool_name\": \"Read\"");
  });
});
