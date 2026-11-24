import { expect, test } from "bun:test";
import { SCOUT_MCP_LOCAL_DEFAULT_TOOLS } from "@openscout/protocol";
import { parseMcpInstallCommandOptions } from "./mcp-install.ts";
import { parseMcpCommandOptions, parseMcpServeCommandOptions, renderMcpCommandHelp } from "./mcp.ts";

test("help distinguishes the default coordination tools from opt-in groups", () => {
  const help = renderMcpCommandHelp();
  for (const name of SCOUT_MCP_LOCAL_DEFAULT_TOOLS) expect(help).toContain(name);
  for (const flag of ["--profile full", "--profile git,work", "OPENSCOUT_MCP_PROFILE", "--notifications"]) expect(help).toContain(flag);
});

test("stdio and serve preserve transport options alongside a profile", () => {
  expect(parseMcpCommandOptions(["--context-root", "/tmp/project", "--notifications", "--profile=work"], "/tmp/default", {}))
    .toMatchObject({ currentDirectory: "/tmp/project", enableNotifications: true, profile: { name: "work" } });
  expect(parseMcpCommandOptions([], "/tmp/default", {}))
    .toMatchObject({ currentDirectory: "/tmp/default", enableNotifications: false });
  expect(parseMcpServeCommandOptions(["--port", "8020", "--idle-timeout", "3", "--profile", "git", "--notifications"], {}))
    .toMatchObject({ host: "127.0.0.1", port: 8020, idleTimeoutMs: 3000, notifications: true, profile: { name: "git" } });
  expect(() => parseMcpServeCommandOptions(["--host", "0.0.0.0"], {})).toThrow("loopback");
});

test.each([
  ["stdio", (args: string[], env: NodeJS.ProcessEnv) => parseMcpCommandOptions(args, "/tmp", env)],
  ["serve", parseMcpServeCommandOptions],
  ["install", (args: string[], env: NodeJS.ProcessEnv) => parseMcpInstallCommandOptions(["--host", "codex", ...args], env)],
] as const)("%s: flag replaces env; invalid selections fail before startup or install", (_, parse) => {
  const env = { OPENSCOUT_MCP_PROFILE: "full" };
  expect(parse([], env).profile?.name).toBe("full");
  expect(parse(["--profile=default"], env).profile?.includes("diff_read")).toBe(false);
  const profile = parse(["--profile", "work,git"], env).profile!;
  expect(profile.name).toBe("git,work");
  expect(["ask", "work_move", "diff_read"].every(profile.includes)).toBe(true);
  expect(profile.includes("sessions_rename")).toBe(false);
  for (const args of [["--profile"], ["--profile=__proto__"], ["--profile=git,"], ["--profile=full,git"]]) {
    expect(() => parse(args, env)).toThrow();
  }
  expect(() => parse([], { OPENSCOUT_MCP_PROFILE: "typo" })).toThrow("Invalid MCP profile");
});
