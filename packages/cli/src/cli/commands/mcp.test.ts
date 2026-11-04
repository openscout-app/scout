import { describe, expect, test } from "bun:test";

import { parseMcpCommandOptions, renderMcpCommandHelp } from "./mcp.ts";

describe("renderMcpCommandHelp", () => {
  test("lists the canonical Scout MCP coordination loop", () => {
    const help = renderMcpCommandHelp();

    expect(help).toContain("whoami");
    expect(help).toContain("messages_inbox");
    expect(help).toContain("messages_channel");
    expect(help).toContain("broker_feed");
    expect(help).toContain("session_attach_current");
    expect(help).toContain("agents_start");
    expect(help).toContain("agents_search");
    expect(help).toContain("ask");
    expect(help).toContain("reply");
    expect(help).toContain("ask + operator");
    expect(help).not.toContain("messages_send");
    expect(help).not.toContain("invocations_ask");
    expect(help).toContain("invocations_get");
    expect(help).toContain("invocations_wait");
    expect(help).toContain("work_update");
    expect(help).toContain("card_create");
    expect(help).toContain("--notifications");
    expect(help).toContain("scout mcp install");
  });
});

describe("parseMcpCommandOptions", () => {
  test("parses notification-enabled stdio mode", () => {
    expect(parseMcpCommandOptions(
      ["--context-root", "/tmp/project", "--notifications"],
      "/tmp/default",
    )).toEqual({
      currentDirectory: "/tmp/project",
      enableNotifications: true,
    });
  });

  test("keeps notifications disabled by default", () => {
    expect(parseMcpCommandOptions([], "/tmp/default")).toEqual({
      currentDirectory: "/tmp/default",
      enableNotifications: false,
    });
  });
});
