import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installScoutMcpForHosts,
  parseMcpInstallCommandOptions,
} from "./mcp-install.ts";

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
    });
  });

  test("accepts zed and rejects unknown hosts", () => {
    expect(parseMcpInstallCommandOptions(["--host", "zed"], process.env).hosts).toEqual(["zed"]);
    expect(() => parseMcpInstallCommandOptions(["--host", "vim"], process.env))
      .toThrow("expected codex, claude, or zed");
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
