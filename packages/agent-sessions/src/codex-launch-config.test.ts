import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildScoutMcpCodexLaunchArgs,
  codexHomeScoutMcpEntry,
  registerSharedScoutMcpClient,
  resolveScoutMcpCodexLaunch,
} from "./codex-launch-config";

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
  test("builds Scout MCP config overrides for the current context root", async () => {
    const args = await buildScoutMcpCodexLaunchArgs({
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
  test("resolves the real core CLI when no scout is on PATH", async () => {
    const home = codexHome();
    const args = await buildScoutMcpCodexLaunchArgs({
      currentDirectory: home,
      env: { PATH: "", CODEX_HOME: home, OPENSCOUT_BUN_BIN: process.execPath },
    });
    const commandArgs = JSON.parse(args[3]!.slice(args[3]!.indexOf("=") + 1));
    expect(commandArgs).toEqual([
      resolve(import.meta.dir, "../../cli/bin/scout.mjs"), "mcp", "--context-root", home,
    ]);
  });

  test("an explicit CLI override still wins over the source checkout", async () => {
    const args = await buildScoutMcpCodexLaunchArgs({
      currentDirectory: import.meta.dir,
      env: { PATH: "", CODEX_HOME: codexHome(), OPENSCOUT_CLI_BIN: process.execPath },
    });
    expect(JSON.parse(args[1]!.slice(args[1]!.indexOf("=") + 1))).toBe(process.execPath);
    expect(JSON.parse(args[3]!.slice(args[3]!.indexOf("=") + 1)))
      .toEqual(["mcp", "--context-root", import.meta.dir]);
  });

  const answers = {
    none: { status: 1, stdout: "", stderr: "Error: No MCP server named 'scout' found.\n" },
    url: { status: 0, stdout: JSON.stringify({ name: "scout", transport: { type: "streamable_http", url: SHARED_URL } }), stderr: "" },
    stdio: { status: 0, stdout: JSON.stringify({ name: "scout", transport: { type: "stdio", command: "scout", args: ["mcp"] } }), stderr: "" },
    broken: { status: 1, stdout: "", stderr: "Error: failed to parse config.toml\n" },
  };
  const launch = async (answer: keyof typeof answers, shared: string | null = SHARED_URL) => {
    const asked: Array<string | undefined> = [];
    const args = await buildScoutMcpCodexLaunchArgs({
      currentDirectory: import.meta.dir,
      env: { PATH: "", CODEX_HOME: "/codex-home", OPENSCOUT_CLI_BIN: process.execPath, OPENSCOUT_MCP_SHARED_URL: shared ?? undefined },
      codexExecutable: "/bin/codex",
      mcpGet: async (executable, env) => {
        asked.push(`${executable} ${env.CODEX_HOME}`);
        return answers[answer];
      },
    });
    return { args, asked };
  };

  test("asks Codex about the target home", async () => {
    expect((await launch("none")).asked).toEqual(["/bin/codex /codex-home"]);
  });

  test("points a home with no scout entry at the shared server while it is on", async () => {
    expect((await launch("none")).args).toEqual(["-c", `mcp_servers.scout.url=${JSON.stringify(SHARED_URL)}`]);
    expect((await launch("none", null)).args).toHaveLength(6);
  });

  test("adds nothing when the home already points scout at a url", async () => {
    // stdio keys on top of a url entry make Codex refuse the server.
    expect((await launch("url")).args).toEqual([]);
    expect((await launch("url", null)).args).toEqual([]);
  });

  test("keeps a home's stdio entry on stdio even while the shared server is on", async () => {
    const { args } = await launch("stdio");
    expect(args[1]).toBe(`mcp_servers.scout.command=${JSON.stringify(process.execPath)}`);
    expect(args).toHaveLength(6);
  });

  test("adds nothing when Codex cannot say, so a url entry is never mixed with stdio keys", async () => {
    expect((await launch("broken")).args).toEqual([]);
    const result = await resolveScoutMcpCodexLaunch({
      currentDirectory: import.meta.dir,
      env: { PATH: "", CODEX_HOME: "/codex-home", OPENSCOUT_CLI_BIN: process.execPath, OPENSCOUT_MCP_SHARED_URL: SHARED_URL },
      codexExecutable: "/bin/codex",
      mcpGet: async () => answers.broken,
    });
    expect(result).toMatchObject({ args: [], usesUrl: false });
    expect(result.unknownReason).toContain("CODEX_HOME=/codex-home");
  });

  test("marks the launches that reach Scout MCP over a URL", async () => {
    const usesUrl = async (answer: keyof typeof answers, shared: string | undefined) => (await resolveScoutMcpCodexLaunch({
      currentDirectory: import.meta.dir,
      env: { PATH: "", OPENSCOUT_CLI_BIN: process.execPath, OPENSCOUT_MCP_SHARED_URL: shared },
      codexExecutable: "/bin/codex",
      mcpGet: async () => answers[answer],
    })).usesUrl;
    expect(await Promise.all([usesUrl("none", SHARED_URL), usesUrl("url", undefined), usesUrl("stdio", SHARED_URL), usesUrl("none", undefined)]))
      .toEqual([true, true, false, false]);
  });

  test("registers an app-server as a shared-server client by pid", async () => {
    const dir = join(codexHome(), "clients");
    expect(registerSharedScoutMcpClient({ OPENSCOUT_MCP_SHARED_CLIENTS_DIR: dir }, 4321)).toBeNull();
    expect(readdirSync(dir)).toEqual(["4321"]);
    expect(registerSharedScoutMcpClient({}, 4321)).toBeNull();
  });

  test("uses stdio when no Codex executable is given", async () => {
    expect(await buildScoutMcpCodexLaunchArgs({
      currentDirectory: import.meta.dir,
      env: { PATH: "", OPENSCOUT_CLI_BIN: process.execPath, OPENSCOUT_MCP_SHARED_URL: SHARED_URL },
    })).toHaveLength(6);
  });
});

describe("codexHomeScoutMcpEntry without a Codex it can run", () => {
  test("reports unknown when the executable cannot start", async () => {
    const home = codexHome();
    expect(await codexHomeScoutMcpEntry({ ...process.env, CODEX_HOME: home }, join(home, "no-codex"))).toBe("unknown");
  });
});

describe("codexHomeScoutMcpEntry with the real Codex CLI", () => {
  const codex = Bun.which("codex");
  test.skipIf(!codex)("reads a commented table header and a missing entry the way Codex does", async () => {
    const entry = (config?: string) => codexHomeScoutMcpEntry({ ...process.env, CODEX_HOME: codexHome(config) }, codex!);
    expect(await entry('[mcp_servers.scout] # shared transport\nurl = "http://127.0.0.1:43115/mcp"\n')).toBe("url");
    expect(await entry('mcp_servers.scout = { url = "http://127.0.0.1:43115/mcp" }\n')).toBe("url");
    expect(await entry('[mcp_servers.scout-hosted]\nurl = "https://example.test/mcp"\n')).toBeNull();
    expect(await entry('[mcp_servers.scout]\ncommand = "scout"\nargs = ["mcp"]\n')).toBe("command");
    expect(await entry()).toBeNull();
  });
});
