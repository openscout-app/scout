import { describe, expect, test } from "bun:test";

import type { AgentEndpoint } from "@openscout/protocol";

import {
  appleScriptString,
  findHarnessAncestor,
  isAttachedLiveTerminalEndpoint,
  isAttachedLiveTerminalEndpointAliveSnapshot,
  normalizeTty,
  parseProcessRows,
} from "./live-terminal-session.js";

const PS_OUTPUT = [
  "    1     0 ??       /sbin/launchd",
  "  900     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty",
  "  901   900 ttys009  -zsh",
  "85103   901 ttys009  grok",
  "85200 85103 ttys009  /Users/you/.bun/bin/bun /Users/you/.local/bin/scout mcp",
  "69633   901 ttys017  claude --resume 9ce71018",
  "69700 69633 ttys017  node scout mcp",
].join("\n");

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-live",
    agentId: "agent-live",
    nodeId: "node-1",
    harness: "grok",
    transport: "tmux",
    state: "idle",
    pane: "%12",
    metadata: { attachedLive: true, livePid: process.pid, liveTty: "ttys009" },
    ...input,
  };
}

describe("live terminal session detection", () => {
  test("walks up from the MCP server to the harness that launched it", () => {
    const rows = parseProcessRows(PS_OUTPUT);
    expect(findHarnessAncestor(rows, 85200)).toEqual(expect.objectContaining({ pid: 85103, harness: "grok", tty: "ttys009" }));
    expect(findHarnessAncestor(rows, 69700)).toEqual(expect.objectContaining({ pid: 69633, harness: "claude" }));
  });

  test("finds no harness when none is above the process", () => {
    expect(findHarnessAncestor(parseProcessRows(PS_OUTPUT), 901)).toBeNull();
  });
});

describe("attached live terminal endpoints", () => {
  test("only tmux endpoints marked attachedLive with a pane qualify", () => {
    expect(isAttachedLiveTerminalEndpoint(endpoint())).toBe(true);
    expect(isAttachedLiveTerminalEndpoint(endpoint({ pane: undefined }))).toBe(false);
    expect(isAttachedLiveTerminalEndpoint(endpoint({ metadata: {} }))).toBe(false);
    expect(isAttachedLiveTerminalEndpoint(endpoint({ transport: "claude_channel" }))).toBe(false);
    expect(isAttachedLiveTerminalEndpoint(endpoint({
      transport: "ghostty",
      pane: undefined,
      metadata: { attachedLive: true, livePid: process.pid, liveTty: "ttys013", ghosttyTerminalId: "D0B1E807" },
    }))).toBe(true);
  });

  test("snapshot liveness follows the attached harness process", () => {
    expect(isAttachedLiveTerminalEndpointAliveSnapshot(endpoint())).toBe(true);
    expect(isAttachedLiveTerminalEndpointAliveSnapshot(endpoint({ state: "offline" }))).toBe(false);
    expect(isAttachedLiveTerminalEndpointAliveSnapshot(endpoint({
      metadata: { attachedLive: true, livePid: 2_147_483_000, liveTty: "ttys009" },
    }))).toBe(false);
  });
});

describe("terminal input helpers", () => {
  test("normalizes macOS ps ttys to tmux's form", () => {
    expect(normalizeTty("s018")).toBe("ttys018");
    expect(normalizeTty("/dev/ttys018")).toBe("ttys018");
    expect(normalizeTty("pts/3")).toBe("pts/3");
  });

  test("quotes text safely for AppleScript", () => {
    expect(appleScriptString('say "hi" \\ back')).toBe('"say \\"hi\\" \\\\ back"');
  });
});
