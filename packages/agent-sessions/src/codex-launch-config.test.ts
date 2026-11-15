import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildScoutMcpCodexLaunchArgs, codexHomeScoutMcpEntry } from "./codex-launch-config";

const homes: string[] = [];
function codexHome(config?: string): string {
  const home = mkdtempSync(resolve(tmpdir(), "scout-codex-home-"));
  homes.push(home);
  if (config !== undefined) writeFileSync(join(home, "config.toml"), config);
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const SHARED_URL = "http://127.0.0.1:43115/mcp";

describe("buildScoutMcpCodexLaunchArgs", () => {
  test("builds Scout MCP config overrides for the current context root", () => {
    const args = buildScoutMcpCodexLaunchArgs({
      currentDirectory: "/Users/guest/dev/openscout",
      env: {
        ...process.env,
        CODEX_HOME: codexHome(),
        OPENSCOUT_MCP_SHARED_URL: undefined,
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
    const home = codexHome();
    const args = buildScoutMcpCodexLaunchArgs({
      currentDirectory: home,
      env: { PATH: "", CODEX_HOME: home, OPENSCOUT_BUN_BIN: process.execPath },
    });
    const commandArgs = JSON.parse(args[3]!.slice(args[3]!.indexOf("=") + 1));
    expect(commandArgs).toEqual([
      resolve(import.meta.dir, "../../cli/bin/scout.mjs"), "mcp", "--context-root", home,
    ]);
  });

  test("an explicit CLI override still wins over the source checkout", () => {
    const args = buildScoutMcpCodexLaunchArgs({
      currentDirectory: import.meta.dir,
      env: { PATH: "", CODEX_HOME: codexHome(), OPENSCOUT_CLI_BIN: process.execPath },
    });
    expect(JSON.parse(args[1]!.slice(args[1]!.indexOf("=") + 1))).toBe(process.execPath);
    expect(JSON.parse(args[3]!.slice(args[3]!.indexOf("=") + 1)))
      .toEqual(["mcp", "--context-root", import.meta.dir]);
  });

  test("points a home with no scout entry at the shared server while it is on", () => {
    const args = buildScoutMcpCodexLaunchArgs({
      currentDirectory: import.meta.dir,
      env: { PATH: "", CODEX_HOME: codexHome('model = "gpt-5"\n'), OPENSCOUT_CLI_BIN: process.execPath,
        OPENSCOUT_MCP_SHARED_URL: SHARED_URL },
    });
    expect(args).toEqual(["-c", `mcp_servers.scout.url=${JSON.stringify(SHARED_URL)}`]);
  });

  test("adds nothing when the home already points scout at a url", () => {
    // stdio keys on top of a url entry make Codex refuse the server.
    const home = codexHome('[mcp_servers.scout]\nurl = "http://127.0.0.1:43115/mcp"\n');
    for (const shared of [SHARED_URL, undefined]) {
      expect(buildScoutMcpCodexLaunchArgs({
        currentDirectory: import.meta.dir,
        env: { PATH: "", CODEX_HOME: home, OPENSCOUT_CLI_BIN: process.execPath, OPENSCOUT_MCP_SHARED_URL: shared },
      })).toEqual([]);
    }
  });

  test("keeps a home's stdio entry on stdio even while the shared server is on", () => {
    const args = buildScoutMcpCodexLaunchArgs({
      currentDirectory: import.meta.dir,
      env: { PATH: "", CODEX_HOME: codexHome('[mcp_servers.scout]\ncommand = "scout"\nargs = ["mcp"]\n'),
        OPENSCOUT_CLI_BIN: process.execPath, OPENSCOUT_MCP_SHARED_URL: SHARED_URL },
    });
    expect(args[1]).toBe(`mcp_servers.scout.command=${JSON.stringify(process.execPath)}`);
    expect(args).toHaveLength(6);
  });
});

describe("codexHomeScoutMcpEntry", () => {
  test("reads the scout table and ignores servers that only share the prefix", () => {
    const entry = (config: string) => codexHomeScoutMcpEntry({ CODEX_HOME: codexHome(config) });
    expect(entry('[mcp_servers.scout-hosted]\nurl = "https://example.test/mcp"\n')).toBeNull();
    expect(entry('[mcp_servers.scout]\ncommand = "scout"\n[mcp_servers.scout.env]\nurl = "x"\n')).toBe("command");
    expect(entry('[mcp_servers."scout"]\nurl = "http://127.0.0.1:43115/mcp"\n')).toBe("url");
    expect(entry('mcp_servers.scout.url = "http://127.0.0.1:43115/mcp"\n')).toBe("url");
    expect(codexHomeScoutMcpEntry({ CODEX_HOME: codexHome() })).toBeNull();
  });
});
