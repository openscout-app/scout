import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drainSharedMcpOptIn, readSharedMcpOptIn, writeSharedMcpOptIn } from "@openscout/runtime/shared-mcp";

import {
  enableSharedScoutMcp,
  installScoutMcpForHosts,
  parseMcpInstallCommandOptions,
} from "./mcp-install.ts";

const SHARED_URL = "http://127.0.0.1:43115/mcp";
type Call = { command: string; args: string[] };

function recordingRunner(calls: Call[], getStatus = 0) {
  return (command: string, args: string[]) => {
    calls.push({ command, args });
    return { status: args[1] === "get" ? getStatus : 0, stdout: "", stderr: "" };
  };
}

describe("shared Scout MCP install", () => {
  const noStdio = () => {
    throw new Error("a shared install needs no stdio launcher");
  };

  test("points Codex and Claude Code at the shared URL, replacing their entries, and leaves Zed alone", () => {
    const calls: Call[] = [];
    const outcomes = installScoutMcpForHosts({
      env: process.env,
      hosts: ["codex", "claude", "zed"],
      force: false,
      dryRun: false,
      sharedUrl: SHARED_URL,
      resolveHostPath: (host) => `/tmp/${host}`,
      resolveLaunchCommand: noStdio,
      run: recordingRunner(calls),
    });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["installed", "installed", "skipped"]);
    expect(outcomes[2]?.detail).toBe("Skipped zed: it keeps its own Scout MCP server.");
    expect(calls).toEqual([
      { command: "/tmp/codex", args: ["mcp", "get", "scout"] },
      { command: "/tmp/codex", args: ["mcp", "remove", "scout"] },
      { command: "/tmp/codex", args: ["mcp", "add", "scout", "--url", SHARED_URL] },
      { command: "/tmp/claude", args: ["mcp", "get", "scout"] },
      { command: "/tmp/claude", args: ["mcp", "remove", "--scope", "user", "scout"] },
      { command: "/tmp/claude", args: ["mcp", "add", "--scope", "user", "--transport", "http", "scout", SHARED_URL] },
    ]);
  });

  test("preserves native Antigravity entries and only upserts Scout on request", () => {
    const calls: string[][] = [];
    let listing = "scout-alt stdio /somewhere";
    const install = (force = false, dryRun = false) => installScoutMcpForHosts({
      env: {}, hosts: ["antigravity"], force, dryRun,
      resolveHostPath: () => "agy",
      resolveLaunchCommand: () => ({ command: "/bin/scout", args: ["mcp"] }),
      run: (_command, args) => {
        calls.push(args);
        return { status: 0, stdout: args[1] === "list" ? listing : "", stderr: "" };
      },
    })[0]?.status;
    expect(install(false, true)).toBe("installed");
    expect(calls).toEqual([["mcp", "list"]]);
    expect(install()).toBe("installed");
    expect(calls.at(-1)).toEqual(["mcp", "add", "--type", "stdio", "scout", "/bin/scout", "mcp"]);
    listing = "scout   stdio   /custom/scout";
    expect(install()).toBe("already_installed");
    expect(calls.at(-1)).toEqual(["mcp", "list"]);
    expect(install(true)).toBe("installed");
    expect(calls.filter(args => args[1] === "remove")).toEqual([]);
  });

  test("adds without removing when a host has no scout entry", () => {
    const calls: Call[] = [];
    installScoutMcpForHosts({
      env: process.env, hosts: ["codex"], force: false, dryRun: false, sharedUrl: SHARED_URL,
      resolveHostPath: () => "/tmp/codex", resolveLaunchCommand: noStdio, run: recordingRunner(calls, 1),
    });
    expect(calls.map((call) => call.args[1])).toEqual(["get", "add"]);
  });

  function sharedInput(supportDirectory: string, calls: Call[], overrides: Partial<Parameters<typeof enableSharedScoutMcp>[0]> = {}) {
    return {
      env: process.env,
      hosts: ["codex", "claude"] as Array<"codex" | "claude">,
      dryRun: false,
      supportDirectory,
      instance: { name: "prod", isProd: true },
      port: 43115,
      resolveHostPath: (host: string) => `/tmp/${host}`,
      run: recordingRunner(calls),
      waitForServer: async () => true,
      ...overrides,
    };
  }

  test("refuses on a development instance, since the host configs are global", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    const calls: Call[] = [];
    await expect(enableSharedScoutMcp(sharedInput(dir, calls, { instance: { name: "dev2", isProd: false } })))
      .rejects.toThrow('only on the main instance (this is "dev2")');
    expect(readSharedMcpOptIn(dir)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("takes back its opt-in and changes no host when the server never answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    const calls: Call[] = [];
    let sawOptIn = false;
    await expect(enableSharedScoutMcp(sharedInput(dir, calls, {
      waitForServer: async () => {
        sawOptIn = readSharedMcpOptIn(dir) !== null;
        return false;
      },
    }))).rejects.toThrow("so no host config was changed");
    expect(sawOptIn).toBe(true);
    expect(readSharedMcpOptIn(dir)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("keeps an earlier opt-in when the server does not answer this time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    writeSharedMcpOptIn(dir, 43115, 1);
    await expect(enableSharedScoutMcp(sharedInput(dir, [], { waitForServer: async () => false }))).rejects.toThrow();
    expect(readSharedMcpOptIn(dir)?.enabledAt).toBe(1);
  });

  test("a failed re-enable leaves a draining opt-in draining", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    writeSharedMcpOptIn(dir, 43115, 1);
    drainSharedMcpOptIn(dir);
    let stateWhileWaiting: string | undefined;
    await expect(enableSharedScoutMcp(sharedInput(dir, [], {
      waitForServer: async () => {
        stateWhileWaiting = readSharedMcpOptIn(dir)?.state;
        return false;
      },
    }))).rejects.toThrow();
    expect(stateWhileWaiting).toBe("on");
    expect(readSharedMcpOptIn(dir)?.state).toBe("draining");
  });

  test("writes the opt-in, waits for the server, then switches the hosts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    const calls: Call[] = [];
    const lines = await enableSharedScoutMcp(sharedInput(dir, calls, {
      waitForServer: async (port) => {
        expect(calls).toEqual([]);
        return port === 43115;
      },
    }));
    expect(readSharedMcpOptIn(dir)).toMatchObject({ port: 43115, url: SHARED_URL });
    expect(calls.filter((call) => call.args[1] === "add").length).toBe(2);
    expect(lines[0]).toBe(`The shared Scout MCP server is on at ${SHARED_URL}, run by scout-base.`);
    expect(lines.at(-1)).toContain("New Codex and Claude Code sessions use it.");
  });

  test("dry-run writes nothing and shows the commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    const calls: Call[] = [];
    const lines = await enableSharedScoutMcp(sharedInput(dir, calls, {
      dryRun: true,
      waitForServer: async () => {
        throw new Error("dry-run does not wait for the server");
      },
    }));
    expect(readSharedMcpOptIn(dir)).toBeNull();
    expect(existsSync(join(dir, "shared-mcp.json"))).toBe(false);
    expect(calls.every((call) => call.args[1] === "get")).toBe(true);
    expect(lines).toContain(`[codex] Would run: /tmp/codex mcp add scout --url ${SHARED_URL}`);
  });
});

describe("parseMcpInstallCommandOptions", () => {
  test("parses repeated hosts and flags", () => {
    const options = parseMcpInstallCommandOptions(
      ["--host", "codex", "--host=claude", "--force", "--dry-run"],
      process.env,
    );

    expect(options).toEqual({
      hosts: ["codex", "claude"],
      force: true,
      dryRun: true,
      shared: false,
    });
    expect(parseMcpInstallCommandOptions(["--shared", "--host", "codex"], process.env).shared).toBe(true);
  });

  test("accepts Antigravity and Zed and rejects unknown hosts", () => {
    expect(parseMcpInstallCommandOptions(["--host", "antigravity"], process.env).hosts).toEqual(["antigravity"]);
    expect(parseMcpInstallCommandOptions(["--host", "zed"], process.env).hosts).toEqual(["zed"]);
    expect(() => parseMcpInstallCommandOptions(["--host", "vim"], process.env))
      .toThrow("expected codex, claude, zed, or antigravity");
  });
});

describe("installScoutMcpForHosts", () => {
  test("reports already-installed hosts without changing them", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const outcomes = installScoutMcpForHosts({
      env: process.env,
      hosts: ["codex", "claude"],
      force: false,
      dryRun: false,
      resolveHostPath: (host) => `/tmp/${host}`,
      resolveLaunchCommand: () => ({
        command: "/tmp/scout",
        args: ["mcp"],
      }),
      run: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(outcomes).toEqual([
      {
        host: "codex",
        status: "already_installed",
        detail: "Codex already has a scout MCP entry.",
      },
      {
        host: "claude",
        status: "already_installed",
        detail: "Claude Code already has a scout MCP entry.",
      },
    ]);
    expect(calls).toEqual([
      { command: "/tmp/codex", args: ["mcp", "get", "scout"] },
      { command: "/tmp/claude", args: ["mcp", "get", "scout"] },
    ]);
  });

  test("replaces an existing Codex entry when forced", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const responses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const outcomes = installScoutMcpForHosts({
      env: process.env,
      hosts: ["codex"],
      force: true,
      dryRun: false,
      resolveHostPath: () => "/tmp/codex",
      resolveLaunchCommand: () => ({
        command: "/tmp/scout",
        args: ["mcp"],
      }),
      run: (command, args) => {
        calls.push({ command, args });
        return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
      },
    });

    expect(outcomes).toEqual([
      {
        host: "codex",
        status: "installed",
        detail: "Installed scout MCP for Codex.",
      },
    ]);
    expect(calls).toEqual([
      { command: "/tmp/codex", args: ["mcp", "get", "scout"] },
      { command: "/tmp/codex", args: ["mcp", "remove", "scout"] },
      { command: "/tmp/codex", args: ["mcp", "add", "scout", "--", "/tmp/scout", "mcp"] },
    ]);
  });

  test("supports dry-run installs", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const outcomes = installScoutMcpForHosts({
      env: process.env,
      hosts: ["claude"],
      force: false,
      dryRun: true,
      resolveHostPath: () => "/tmp/claude",
      resolveLaunchCommand: () => ({
        command: "/tmp/scout",
        args: ["mcp"],
      }),
      run: (command, args) => {
        calls.push({ command, args });
        return { status: 1, stdout: "", stderr: "missing" };
      },
    });

    expect(outcomes).toEqual([
      {
        host: "claude",
        status: "installed",
        detail: "Would run: /tmp/claude mcp add --scope user scout -- /tmp/scout mcp",
      },
    ]);
    expect(calls).toEqual([
      { command: "/tmp/claude", args: ["mcp", "get", "scout"] },
    ]);
  });
});

test("launch registration uses a stable executable rather than the active package script", async () => {
  const { resolveCurrentScoutMcpLaunchCommand } = await import("./mcp-install.ts");
  expect(resolveCurrentScoutMcpLaunchCommand({ OPENSCOUT_CLI_BIN: process.execPath, PATH: "" }))
    .toEqual({ command: process.execPath, args: ["mcp"] });
});

describe("installScoutMcpForHosts for Zed", () => {
  const launch = { command: "/opt/scout/bin/scout", args: ["mcp"] };

  function installZed(settingsPath: string | null, options: { force?: boolean; dryRun?: boolean } = {}) {
    const [outcome] = installScoutMcpForHosts({
      env: process.env,
      hosts: ["zed"],
      force: options.force ?? false,
      dryRun: options.dryRun ?? false,
      resolveHostPath: () => settingsPath,
      resolveLaunchCommand: () => launch,
      run: () => {
        throw new Error("Zed installs edit settings.json and run no commands");
      },
    });
    return outcome;
  }

  function settingsFile(): string {
    return join(mkdtempSync(join(tmpdir(), "scout-zed-")), "zed", "settings.json");
  }

  test("creates the settings file when Zed has none yet", () => {
    const settingsPath = settingsFile();

    expect(installZed(settingsPath)).toEqual({
      host: "zed",
      status: "installed",
      detail: `Installed scout MCP for Zed in ${settingsPath}.`,
    });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      context_servers: { scout: launch },
    });
    expect(existsSync(`${settingsPath}.scout-backup`)).toBe(false);
  });

  test("edits an existing file, keeps its comments, and saves a backup", () => {
    const settingsPath = settingsFile();
    installZed(settingsPath);
    const original = "// my settings\n{\n  \"vim_mode\": true\n}\n";
    writeFileSync(settingsPath, original);

    expect(installZed(settingsPath)?.status).toBe("installed");
    const next = readFileSync(settingsPath, "utf8");
    expect(next.startsWith("// my settings\n{\n  \"vim_mode\": true,\n  \"context_servers\": {")).toBe(true);
    expect(readFileSync(`${settingsPath}.scout-backup`, "utf8")).toBe(original);

    expect(installZed(settingsPath)).toEqual({
      host: "zed",
      status: "already_installed",
      detail: "Zed already has a scout MCP entry.",
    });
  });

  test("leaves a different scout entry unless forced", () => {
    const settingsPath = settingsFile();
    installZed(settingsPath);
    writeFileSync(settingsPath, "{\n  \"context_servers\": {\n    \"scout\": { \"command\": \"scout\" }\n  }\n}\n");

    expect(installZed(settingsPath)).toEqual({
      host: "zed",
      status: "skipped",
      detail: `Zed has a different scout entry in ${settingsPath}. Rerun with --force to replace it.`,
    });
    expect(installZed(settingsPath, { force: true })?.status).toBe("installed");
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).context_servers.scout).toEqual(launch);
  });

  test("dry-run describes the change without writing", () => {
    const settingsPath = settingsFile();

    expect(installZed(settingsPath, { dryRun: true })).toEqual({
      host: "zed",
      status: "installed",
      detail: `Would add context_servers.scout in ${settingsPath}: /opt/scout/bin/scout mcp`,
    });
    expect(existsSync(settingsPath)).toBe(false);
  });

  test("reports a settings file it cannot edit safely without touching it", () => {
    const settingsPath = settingsFile();
    installZed(settingsPath);
    writeFileSync(settingsPath, "{ \"vim_mode\": }");

    const outcome = installZed(settingsPath);
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toContain("not valid JSON with comments");
    expect(readFileSync(settingsPath, "utf8")).toBe("{ \"vim_mode\": }");
  });

  test("skips Zed when it is not installed", () => {
    expect(installZed(null)).toEqual({
      host: "zed",
      status: "skipped",
      detail: "Skipped zed: Zed not found.",
    });
  });
});
