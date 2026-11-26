import { describe, expect, test } from "bun:test";
import type { ScoutComputerClient } from "@openscout/runtime";
import { createScoutCommandContext, type ScoutCommandContext } from "../context.ts";
import { runComputerCommand } from "./computer.ts";

function makeContext(outputMode: "plain" | "json" = "plain"): { context: ScoutCommandContext; lines: string[] } {
  const lines: string[] = [];
  const context = createScoutCommandContext({
    cwd: process.cwd(),
    env: {},
    outputMode,
    stdout: (line) => { lines.push(line); },
    stderr: (line) => { lines.push(line); },
    isTty: false,
  });
  return { context, lines };
}

function stubClient(): { client: ScoutComputerClient; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = [];
  const client: ScoutComputerClient = {
    async status() {
      calls.push({ method: "status", args: undefined });
      return {
        available: true,
        binaryPath: "/Applications/ScoutComputer.app/Contents/MacOS/ScoutComputer",
        agentUrl: "ws://127.0.0.1:4319",
        agentConnected: true,
        permissions: { accessibility: "granted", screenRecording: "granted" },
      };
    },
    async listWindows(args) {
      calls.push({ method: "listWindows", args });
      return { ok: true, action: "windows", data: { windows: [] }, at: 1000 };
    },
    async screenshot(args) {
      calls.push({ method: "screenshot", args });
      return { ok: true, action: "screenshot", outputPath: args?.outputPath ?? "/tmp/out.png", at: 1000 };
    },
    async focus(args) {
      calls.push({ method: "focus", args });
      return { ok: true, action: "focus", at: 1000 };
    },
    async inspect(args) {
      calls.push({ method: "inspect", args });
      return { ok: true, action: "inspect", data: {}, at: 1000 };
    },
    async act(args) {
      calls.push({ method: "act", args });
      return { ok: true, action: args.kind, data: args, at: 1000 };
    },
  };
  return { client, calls };
}

describe("scout computer CLI", () => {
  test("prints status in plain and json modes", async () => {
    const { client } = stubClient();
    const jsonRun = makeContext("json");
    await runComputerCommand(jsonRun.context, ["status", "--json"], client);
    expect(JSON.parse(jsonRun.lines[0]!).agentConnected).toBe(true);

    const plainRun = makeContext("plain");
    await runComputerCommand(plainRun.context, ["status"], client);
    expect(plainRun.lines[0]).toContain("available: yes");
    expect(plainRun.lines[0]).toContain("agent: connected");
  });

  test("dispatches windows, screenshot, focus, click, key, and ocr subcommands", async () => {
    const { client, calls } = stubClient();
    const run = makeContext("plain");

    await runComputerCommand(run.context, ["windows", "--app", "Google Chrome", "--raise"], client);
    expect(calls.at(-1)).toEqual({
      method: "listWindows",
      args: { bundleId: undefined, app: "Google Chrome", pid: undefined, raise: true },
    });

    await runComputerCommand(run.context, ["screenshot", "--bundle-id", "com.google.Chrome", "--output", "/tmp/c.png"], client);
    expect(run.lines.at(-1)).toContain("/tmp/c.png");

    await runComputerCommand(run.context, ["focus", "--bundle-id", "com.google.Chrome", "--title", "Scout"], client);
    expect(calls.at(-1)?.method).toBe("focus");

    await runComputerCommand(run.context, ["click", "--x", "100", "--y", "200"], client);
    expect(calls.at(-1)).toEqual({ method: "act", args: { kind: "click", x: 100, y: 200 } });

    await runComputerCommand(run.context, ["key", "l", "--modifiers", "cmd,shift", "--bundle-id", "com.google.Chrome"], client);
    expect(calls.at(-1)).toEqual({
      method: "act",
      args: {
        kind: "key",
        key: "l",
        modifiers: ["cmd", "shift"],
        target: { bundleId: "com.google.Chrome", app: undefined, pid: undefined },
      },
    });

    await runComputerCommand(run.context, ["ocr", "/tmp/c.png"], client);
    expect(calls.at(-1)).toEqual({ method: "act", args: { kind: "ocr", imagePath: "/tmp/c.png" } });
  });
});
