import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildScoutMcpCodexLaunchArgs } from "./codex-launch-config";

describe("buildScoutMcpCodexLaunchArgs", () => {
  test("builds Scout MCP config overrides for the current context root", () => {
    const args = buildScoutMcpCodexLaunchArgs({
      currentDirectory: "/Users/guest/dev/openscout",
      env: {
        ...process.env,
        OPENSCOUT_SETUP_CWD: "/Users/guest",
      },
    });

    expect(args).toHaveLength(6);
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("-c");
    expect(args[4]).toBe("-c");
    expect(args[1]?.startsWith("mcp_servers.scout.command=")).toBe(true);
    expect(args[3]?.startsWith("mcp_servers.scout.args=")).toBe(true);
    expect(args[5]).toBe(`mcp_servers.scout.cwd=${JSON.stringify("/Users/guest")}`);

    const rawCommand = args[1]?.split("=", 2)[1] ?? "";
    const rawArgs = args[3]?.split("=", 2)[1] ?? "";
    const command = JSON.parse(rawCommand) as string;
    const scoutArgs = JSON.parse(rawArgs) as string[];

    expect(command.length).toBeGreaterThan(0);
    expect(scoutArgs).toContain("mcp");
    expect(scoutArgs).toContain("--context-root");
    expect(scoutArgs.at(-1)).toBe("/Users/guest");
  });
  test("resolves the real core CLI when no scout is on PATH", () => {
    const home = mkdtempSync(resolve(tmpdir(), "scout-mcp-core-home-"));
    try {
      const args = buildScoutMcpCodexLaunchArgs({
        currentDirectory: home,
        env: { PATH: "", OPENSCOUT_BUN_BIN: process.execPath },
      });
      const commandArgs = JSON.parse(args[3]!.slice(args[3]!.indexOf("=") + 1));
      expect(commandArgs).toEqual([
        resolve(import.meta.dir, "../../cli/bin/scout.mjs"), "mcp", "--context-root", home,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an explicit CLI override still wins over the source checkout", () => {
    const args = buildScoutMcpCodexLaunchArgs({
      currentDirectory: import.meta.dir,
      env: { PATH: "", OPENSCOUT_CLI_BIN: process.execPath },
    });
    expect(JSON.parse(args[1]!.slice(args[1]!.indexOf("=") + 1))).toBe(process.execPath);
    expect(JSON.parse(args[3]!.slice(args[3]!.indexOf("=") + 1)))
      .toEqual(["mcp", "--context-root", import.meta.dir]);
  });

});
