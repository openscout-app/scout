import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteControlPlaneStore } from "@openscout/runtime";
import { createScoutCommandContext } from "../context.ts";
import { mergeTerminalSurfaces, parseZellijSessionList, runSessionCommand } from "./session.ts";

async function runSessionJson(args: string[], cwd = "/Users/test/dev/openscout"): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const context = createScoutCommandContext({
    cwd,
    env: {
      ...process.env,
      HOME: "/Users/test",
      SCOUT_HOME: undefined,
      OPENSCOUT_HOME: undefined,
      ZELLIJ_SOCKET_DIR: undefined,
      OPENSCOUT_ZELLIJ_SOCKET_DIR: undefined,
    },
    outputMode: "json",
    stdout(line) {
      lines.push(line);
    },
    stderr() {},
    isTty: false,
  });

  await runSessionCommand(context, args);

  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("runSessionCommand intake", () => {
  test("plans a deterministic tmux-backed Claude session intake", async () => {
    const payload = await runSessionJson(["intake", "claude", "claude-session-123", "--dry-run"]);

    expect(payload.action).toBe("session_intake");
    expect(payload.harness).toBe("claude");
    expect(payload.backend).toBe("tmux");
    expect(payload.sourceSessionId).toBe("claude-session-123");
    expect(payload.tmuxSession).toMatch(/^scout-claude-openscout-[a-f0-9]{10}$/);
    expect(payload.terminalSession).toBe(payload.tmuxSession);
    expect(payload.cwd).toBe("/Users/test/dev/openscout");
    expect(payload.resumeCommand).toBe("claude --resume claude-session-123");
    expect(payload.created).toBe(false);
    expect(payload.dryRun).toBe(true);
    expect(payload.terminalSurface).toEqual({
      backend: "tmux",
      sessionName: payload.tmuxSession,
      paneId: null,
      attachCommand: ["tmux", "attach", "-t", payload.tmuxSession],
      observeCommand: null,
      relay: {
        backend: "tmux",
        sessionName: payload.tmuxSession,
        tmuxSession: payload.tmuxSession,
      },
    });
    expect(payload.relay).toEqual({
      backend: "tmux",
      sessionName: payload.tmuxSession,
      tmuxSession: payload.tmuxSession,
    });
  });

  test("uses Codex resume cwd metadata and explicit tmux names", async () => {
    const payload = await runSessionJson([
      "handoff",
      "--harness",
      "codex",
      "--session",
      "codex-session-123",
      "--project",
      "/Users/test/dev/my app",
      "--name",
      "scout-codex-custom",
      "--dry-run",
    ]);

    expect(payload.harness).toBe("codex");
    expect(payload.backend).toBe("tmux");
    expect(payload.tmuxSession).toBe("scout-codex-custom");
    expect(payload.terminalSession).toBe("scout-codex-custom");
    expect(payload.cwd).toBe("/Users/test/dev/my app");
    expect(payload.resumeCommand).toBe("codex resume -C '/Users/test/dev/my app' codex-session-123");
    expect(payload.attachCommand).toBe("tmux attach -t scout-codex-custom");
  });

  test("plans an interchangeable Zellij surface", async () => {
    const payload = await runSessionJson([
      "intake",
      "--backend",
      "zellij",
      "--harness",
      "claude",
      "--session",
      "claude-session-123",
      "--dry-run",
    ]);

    expect(payload.harness).toBe("claude");
    expect(payload.backend).toBe("zellij");
    expect(payload.terminalSession).toMatch(/^scout-claude-openscout-[a-f0-9]{10}$/);
    expect(payload.zellijSession).toBe(payload.terminalSession);
    expect(payload.tmuxSession).toBeUndefined();
    expect(payload.resumeCommand).toBe("claude --resume claude-session-123");
    expect(payload.attachCommand).toBe(`env ZELLIJ_SOCKET_DIR=/Users/test/.openscout/zellij-sockets zellij attach ${payload.terminalSession}`);
    expect(payload.observeCommand).toBe(`env ZELLIJ_SOCKET_DIR=/Users/test/.openscout/zellij-sockets zellij watch ${payload.terminalSession}`);
    expect(payload.terminalSurface).toEqual({
      backend: "zellij",
      sessionName: payload.terminalSession,
      paneId: null,
      attachCommand: [
        "env",
        "ZELLIJ_SOCKET_DIR=/Users/test/.openscout/zellij-sockets",
        "zellij",
        "attach",
        payload.terminalSession,
      ],
      observeCommand: [
        "env",
        "ZELLIJ_SOCKET_DIR=/Users/test/.openscout/zellij-sockets",
        "zellij",
        "watch",
        payload.terminalSession,
      ],
      relay: {
        backend: "zellij",
        sessionName: payload.terminalSession,
        zellijSession: payload.terminalSession,
      },
      socketDir: "/Users/test/.openscout/zellij-sockets",
    });
  });

  test("merges rematerialized surfaces without duplicating backend sessions", () => {
    const first = {
      backend: "tmux" as const,
      sessionName: "scout-tmux-demo",
      paneId: null,
      attachCommand: ["tmux", "attach", "-t", "scout-tmux-demo"],
      observeCommand: null,
      relay: { backend: "tmux" as const, sessionName: "scout-tmux-demo", tmuxSession: "scout-tmux-demo" },
      state: "live" as const,
    };
    const updated = {
      ...first,
      attachCommand: ["tmux", "attach-session", "-t", "scout-tmux-demo"],
      state: "detached" as const,
    };
    const zellij = {
      backend: "zellij" as const,
      sessionName: "scout-zj-demo",
      paneId: "terminal_0",
      attachCommand: ["env", "ZELLIJ_SOCKET_DIR=/tmp/z", "zellij", "attach", "scout-zj-demo"],
      observeCommand: ["env", "ZELLIJ_SOCKET_DIR=/tmp/z", "zellij", "watch", "scout-zj-demo"],
      relay: { backend: "zellij" as const, sessionName: "scout-zj-demo", zellijSession: "scout-zj-demo" },
      state: "live" as const,
      socketDir: "/tmp/z",
    };

    expect(mergeTerminalSurfaces([first], updated)).toEqual([updated]);
    expect(mergeTerminalSurfaces([first], zellij).map((surface) => surface.backend)).toEqual(["tmux", "zellij"]);
  });

  test("parses colorized zellij session names", () => {
    expect(parseZellijSessionList("\x1B[32;1mscout-zj-demo\x1B[m [Created \x1B[35;1m3s\x1B[m ago]\n"))
      .toEqual(["scout-zj-demo"]);
  });

  test("lists registered terminal sessions from the control-plane registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-session-list-"));
    try {
      const dbPath = join(root, "control-plane.sqlite");
      const store = new SQLiteControlPlaneStore(dbPath);
      try {
        store.upsertTerminalSession({
          harness: "claude",
          sourceSessionId: "claude-session-123",
          cwd: "/Users/test/dev/openscout",
          resumeCommand: "claude --resume claude-session-123",
          surfaces: [{
            backend: "zellij",
            sessionName: "scout-zj-demo",
            paneId: "terminal_0",
            attachCommand: ["env", "ZELLIJ_SOCKET_DIR=/tmp/z", "zellij", "attach", "scout-zj-demo"],
            observeCommand: ["env", "ZELLIJ_SOCKET_DIR=/tmp/z", "zellij", "watch", "scout-zj-demo"],
            relay: { backend: "zellij", sessionName: "scout-zj-demo", zellijSession: "scout-zj-demo" },
            state: "live",
            socketDir: "/tmp/z",
          }],
        });
      } finally {
        store.close();
      }

      const lines: string[] = [];
      const context = createScoutCommandContext({
        cwd: "/Users/test/dev/openscout",
        env: {
          ...process.env,
          HOME: "/Users/test",
          OPENSCOUT_CONTROL_PLANE_DB: dbPath,
        },
        outputMode: "json",
        stdout(line) {
          lines.push(line);
        },
        stderr() {},
        isTty: false,
      });

      await runSessionCommand(context, ["list", "--backend", "zellij"]);

      const payload = JSON.parse(lines[0]!) as { count: number; sessions: Array<{ sourceSessionId: string }> };
      expect(payload.count).toBe(1);
      expect(payload.sessions[0]?.sourceSessionId).toBe("claude-session-123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects harnesses without resume metadata", async () => {
    const context = createScoutCommandContext({
      cwd: "/Users/test/dev/openscout",
      outputMode: "json",
      stdout() {},
      stderr() {},
      isTty: false,
    });

    await expect(runSessionCommand(context, ["intake", "flue", "flue-session-123", "--dry-run"]))
      .rejects
      .toThrow("does not advertise a resume command");
  });
});
