import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setCrewRole, type CrewReachabilityChecker } from "@openscout/runtime/crew";

import { createScoutCommandContext } from "../context.ts";
import { renderWhoAmICommandHelp, runWhoAmICommand } from "./whoami.ts";

describe("whoami command help", () => {
  test("documents sender and broker context", () => {
    const help = renderWhoAmICommandHelp();

    expect(help).toContain("Show the current Scout sender and broker context.");
    expect(help).toContain("default sender id");
    expect(help).toContain("OPENSCOUT_AGENT");
    expect(help).toContain("broker URL");
  });

  test("prints help before setup or broker access", async () => {
    const lines: string[] = [];
    const context = createScoutCommandContext({
      cwd: "/tmp/openscout-test",
      env: {},
      stdout: (line) => lines.push(line),
      stderr: () => undefined,
      isTty: false,
    });

    await runWhoAmICommand(context, ["-h"]);

    expect(lines.join("\n")).toContain("Usage: scout whoami");
  });
});

describe("whoami report", () => {
  test("includes the Herdr managed agent name when present", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openscout-whoami-"));
    try {
      const lines: string[] = [];
      const context = createScoutCommandContext({
        cwd,
        env: {
          HERDR_ENV: "1",
          HERDR_PANE_ID: "w1:p2",
          HERDR_AGENT: "pi",
          HERDR_AGENT_NAME: "worker",
        },
        stdout: (line) => lines.push(line),
        stderr: () => undefined,
        isTty: false,
      });

      await runWhoAmICommand(context, []);

      const output = lines.join("\n");
      expect(output).toContain("Herdr Agent: worker");
      expect(output).toContain("Host Harness: pi (HERDR_AGENT_NAME)");
      expect(output).toContain("Default Sender: worker.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("surfaces only available crew roles and active seat posture", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-whoami-crew-"));
    try {
      const home = join(root, "openscout-home");
      const cwd = join(root, "repo");
      mkdirSync(cwd, { recursive: true });
      setCrewRole("lane", { runtime: "antigravity/gemini-fixture" }, { env: { OPENSCOUT_HOME: home } });
      setCrewRole("worker", { runtime: "codex", pool: 4 }, { env: { OPENSCOUT_HOME: home } });
      setCrewRole("stylist", { runtime: "kimi" }, { env: { OPENSCOUT_HOME: home } });

      const checker: CrewReachabilityChecker = {
        checkHarness: (harness) => ["antigravity", "codex"].includes(harness)
          ? { harness, available: true, state: "ready", detail: `${harness} ready` }
          : { harness, available: false, state: "missing", detail: `${harness} missing` },
      };

      const lines: string[] = [];
      const context = createScoutCommandContext({
        cwd,
        env: { OPENSCOUT_HOME: home, OPENSCOUT_CREW_ROLE: "lane" },
        stdout: (line) => lines.push(line),
        stderr: () => undefined,
        isTty: false,
      });

      await runWhoAmICommand(context, [], { crewChecker: checker });
      const output = lines.join("\n");
      expect(output).toContain("Active Seat: lane (antigravity/gemini-fixture)");
      expect(output).toContain("Seat Posture:");
      expect(output).toContain("Crew Roles: lane=antigravity/gemini-fixture · worker=codex x4");
      expect(output).not.toContain("stylist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
