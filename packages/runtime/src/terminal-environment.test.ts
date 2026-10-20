import { describe, expect, test } from "bun:test";

import {
  buildInteractiveTerminalEnvironment,
  buildInteractiveTerminalShellDirectives,
  INHERITED_CLAUDE_SESSION_ENV_KEYS,
  INHERITED_MULTIPLEXER_PANE_ENV_KEYS,
  INHERITED_INSTANCE_ENV_KEYS,
  wrapUserSpawnPaneCommand,
} from "./terminal-environment.js";
import { SCOUT_USER_SPAWN_STRIPPED_ENV_KEYS } from "../../agent-sessions/src/scout-state-paths.ts";
import { execSystemFile } from "./system-probes/exec.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildInteractiveTerminalEnvironment", () => {
  test("does not leak supervisor no-color policy into an interactive PTY", () => {
    const env = buildInteractiveTerminalEnvironment({
      PATH: "/usr/bin",
      NO_COLOR: "1",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
    });
    expect(env.NO_COLOR).toBeUndefined();
  });

  test("preserves explicit interactive color capabilities", () => {
    const env = buildInteractiveTerminalEnvironment(
      { COLORTERM: "24bit", FORCE_COLOR: "2", NO_COLOR: "1" },
      { TERM: "xterm-256color" },
    );

    expect(env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "24bit",
      FORCE_COLOR: "2",
    });
    expect(env.NO_COLOR).toBeUndefined();
  });

  test("does not leak parent Claude session identity into a fresh terminal", () => {
    const inherited = Object.fromEntries(
      INHERITED_CLAUDE_SESSION_ENV_KEYS.map((key) => [key, "inherited"]),
    );
    const env = buildInteractiveTerminalEnvironment({
      PATH: "/usr/bin",
      ...inherited,
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
    });

    for (const key of INHERITED_CLAUDE_SESSION_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    // Only the parent-session markers go; deliberate configuration stays.
    expect(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe("1");
  });

  test("does not leak the pane identity of a multiplexer Scout was launched inside", () => {
    const inherited = Object.fromEntries(
      INHERITED_MULTIPLEXER_PANE_ENV_KEYS.map((key) => [key, "inherited"]),
    );
    const env = buildInteractiveTerminalEnvironment({
      PATH: "/usr/bin",
      ...inherited,
      HERDR_BIN_PATH: "/opt/homebrew/bin/herdr",
    });

    // With HERDR_ENV set, `herdr --session x` refuses to start at all, and an
    // agent in the tile would drive the pane Scout was launched from.
    for (const key of INHERITED_MULTIPLEXER_PANE_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    // Where to find the binary is not pane identity, so it survives.
    expect(env.HERDR_BIN_PATH).toBe("/opt/homebrew/bin/herdr");
  });
});

describe("instance env at user-facing spawns", () => {
  test("a terminal starts without any instance-derived key, with only the client pointer", () => {
    const env = buildInteractiveTerminalEnvironment({
      PATH: "/usr/bin",
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_PARENT_PID: "4242",
      OPENSCOUT_SERVICE_LABEL: "app.openscout.dev",
      OPENSCOUT_BROKER_SERVICE_MODE: "dev",
      OPENSCOUT_INSTANCE_EXPLICIT: "1",
      OPENSCOUT_BROKER_PORT: "24400",
      OPENSCOUT_CONTROL_HOME: "/home/u/.openscout/instances/dev/control-plane",
      OPENSCOUT_BROKER_URL: "http://127.0.0.1:24400",
    });
    for (const key of INHERITED_INSTANCE_ENV_KEYS.filter((key) => key !== "OPENSCOUT_CLIENT_INSTANCE")) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.OPENSCOUT_CLIENT_INSTANCE).toBe("dev");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("the runtime, agent-sessions and scoutd strip lists stay in sync", () => {
    expect([...SCOUT_USER_SPAWN_STRIPPED_ENV_KEYS].sort()).toEqual([...INHERITED_INSTANCE_ENV_KEYS].sort());
    // scoutd's tmux.newSession list (Rust) is parsed from source.
    const rust = readFileSync(join(import.meta.dir, "..", "..", "..", "crates", "scoutd", "src", "probes.rs"), "utf8");
    const block = /TMUX_SERVER_STRIPPED_ENV_KEYS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? "";
    const rustKeys = [...block.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]);
    expect(rustKeys.length).toBeGreaterThan(10);
    expect(rustKeys.sort()).toEqual([...INHERITED_INSTANCE_ENV_KEYS].sort());
  });

  test("H1: a prod spawner's overrides reach its panes and launch scripts; a dev spawner's do not", () => {
    const prodDirectives = buildInteractiveTerminalShellDirectives({ OPENSCOUT_INSTANCE: "prod", OPENSCOUT_BROKER_PORT: "45555" }).join("\n");
    expect(prodDirectives).toContain("export OPENSCOUT_BROKER_PORT=45555");
    expect(prodDirectives).toContain("export OPENSCOUT_CLIENT_INSTANCE=prod");
    const devDirectives = buildInteractiveTerminalShellDirectives({ OPENSCOUT_INSTANCE: "dev", OPENSCOUT_BROKER_PORT: "24400" }).join("\n");
    expect(devDirectives).not.toContain("export OPENSCOUT_BROKER_PORT");
    expect(devDirectives).toContain("export OPENSCOUT_CLIENT_INSTANCE=dev");
  });

  test("M1: a tmux server Scout starts locally has a clean global env; the pointer reaches only the pane", async () => {
    if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "openscout-tmux-server-env-"));
    const socket = join(dir, "sock");
    const outFile = join(dir, "pane-env");
    const previousProbesSocket = process.env.OPENSCOUT_PROBES_SOCKET;
    // This case checks the local spawner; native scoutd has separate conformance coverage.
    process.env.OPENSCOUT_PROBES_SOCKET = join(dir, "absent-probes.sock");
    // A dev web/broker process: pinned instance + derived env + pointer.
    const serviceEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TERM: "xterm",
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_BROKER_PORT: "24400",
      OPENSCOUT_CLIENT_INSTANCE: "dev",
      OPENSCOUT_PARENT_PID: "1",
    };
    try {
      await execSystemFile("tmux", [
        "-S", socket, "new-session", "-d", "-s", "scout",
        wrapUserSpawnPaneCommand(`env > ${outFile}; sleep 5`, serviceEnv),
      ], { timeoutMs: 5_000, env: serviceEnv });
      const global = Bun.spawnSync(["tmux", "-S", socket, "show-environment", "-g"]).stdout.toString();
      expect(global).not.toMatch(/^OPENSCOUT_/m);
      for (let attempt = 0; attempt < 50 && !existsSync(outFile); attempt += 1) Bun.sleepSync(50);
      Bun.sleepSync(100);
      const pane = readFileSync(outFile, "utf8");
      expect(pane).toMatch(/^OPENSCOUT_CLIENT_INSTANCE=dev$/m);
      expect(pane).not.toMatch(/^OPENSCOUT_INSTANCE=/m);
      expect(pane).not.toMatch(/^OPENSCOUT_BROKER_PORT=/m);
    } finally {
      if (previousProbesSocket === undefined) delete process.env.OPENSCOUT_PROBES_SOCKET;
      else process.env.OPENSCOUT_PROBES_SOCKET = previousProbesSocket;
      Bun.spawnSync(["tmux", "-S", socket, "kill-server"]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the no-command pane keeps tmux's default-command", () => {
    if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "openscout-tmux-default-command-"));
    const socket = join(dir, "sock");
    const outFile = join(dir, "ran");
    try {
      Bun.spawnSync(["tmux", "-S", socket, "new-session", "-d", "-s", "first", "sleep 10"], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm" },
      });
      Bun.spawnSync(["tmux", "-S", socket, "set-option", "-g", "default-command", `touch ${outFile}; sleep 5`]);
      Bun.spawnSync(["tmux", "-S", socket, "new-session", "-d", "-s", "second", wrapUserSpawnPaneCommand(null, { OPENSCOUT_INSTANCE: "prod" })], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm" },
      });
      for (let attempt = 0; attempt < 50 && !existsSync(outFile); attempt += 1) Bun.sleepSync(50);
      expect(existsSync(outFile)).toBe(true);
    } finally {
      Bun.spawnSync(["tmux", "-S", socket, "kill-server"]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(e) a pre-existing tmux server does not leak instance env into new panes", () => {
    if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "openscout-tmux-leak-"));
    const socket = join(dir, "sock");
    const leaky = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TERM: "xterm",
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_BROKER_PORT: "24400",
      OPENSCOUT_CONTROL_HOME: "/x/dev/control-plane",
      OPENSCOUT_PARENT_PID: "1",
    };
    try {
      // The server is first started from a shell that carried a dev instance.
      expect(Bun.spawnSync(["tmux", "-S", socket, "new-session", "-d", "-s", "first", "sleep 30"], { env: leaky }).exitCode).toBe(0);
      const outFile = join(dir, "pane-env");
      // Scout later opens a pane from a prod service, through the wrapper.
      const command = wrapUserSpawnPaneCommand(`env > ${outFile}`, { OPENSCOUT_INSTANCE: "prod" });
      expect(Bun.spawnSync(["tmux", "-S", socket, "new-session", "-d", "-s", "second", command], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm" },
      }).exitCode).toBe(0);
      for (let attempt = 0; attempt < 50 && !existsSync(outFile); attempt += 1) Bun.sleepSync(50);
      Bun.sleepSync(100);
      const paneEnv = readFileSync(outFile, "utf8");
      expect(paneEnv).not.toMatch(/^OPENSCOUT_INSTANCE=/m);
      expect(paneEnv).not.toMatch(/^OPENSCOUT_BROKER_PORT=/m);
      expect(paneEnv).not.toMatch(/^OPENSCOUT_CONTROL_HOME=/m);
      expect(paneEnv).not.toMatch(/^OPENSCOUT_PARENT_PID=/m);
      expect(paneEnv).toMatch(/^OPENSCOUT_CLIENT_INSTANCE=prod$/m);

      // Without the wrapper the same server would have leaked them (control).
      const leakedFile = join(dir, "pane-env-unwrapped");
      Bun.spawnSync(["tmux", "-S", socket, "new-session", "-d", "-s", "third", `env > ${leakedFile}`], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm" },
      });
      for (let attempt = 0; attempt < 50 && !existsSync(leakedFile); attempt += 1) Bun.sleepSync(50);
      Bun.sleepSync(100);
      expect(readFileSync(leakedFile, "utf8")).toMatch(/^OPENSCOUT_INSTANCE=dev$/m);
    } finally {
      Bun.spawnSync(["tmux", "-S", socket, "kill-server"]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildInteractiveTerminalShellDirectives", () => {
  test("removes an inherited color opt-out and preserves explicit capabilities", () => {
    expect(buildInteractiveTerminalShellDirectives({})).toEqual([
      "unset NO_COLOR",
      `unset ${INHERITED_CLAUDE_SESSION_ENV_KEYS.join(" ")}`,
      `unset ${INHERITED_INSTANCE_ENV_KEYS.join(" ")}`,
      "export OPENSCOUT_CLIENT_INSTANCE=prod",
      'export COLORTERM="${COLORTERM:-truecolor}"',
      'export FORCE_COLOR="${FORCE_COLOR:-1}"',
    ]);
  });

  test("leaves multiplexer pane identity alone — these run inside a real pane", () => {
    const directives = buildInteractiveTerminalShellDirectives().join("\n");
    for (const key of INHERITED_MULTIPLEXER_PANE_ENV_KEYS) {
      // Whole names only: OPENSCOUT_ZELLIJ_SOCKET_DIR is an instance key, not ZELLIJ.
      expect(directives).not.toMatch(new RegExp(`(^|[^A-Z0-9_])${key}([^A-Z0-9_]|$)`));
    }
  });
});
