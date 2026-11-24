import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readinessWarmupExit, warmReadinessFixture } from "../test-fixtures/warm-readiness-fixture.ts";

// Separate processes keep module mocks out of the other command tests. The
// setup service is synthetic; actual command output and process exit are not.
// Stage each script in its own hook and warm imports only. The early exit is
// before runSetupCommand: every assertion below sees the FIRST real invocation.
// Keep the existing synchronous guard unchanged pending the fence-accounted follow-up.
for (const mode of ["plain", "json"] as const) {
  for (const status of ["error", "missing", "skipped", "ready", "installed"]) {
    describe(`setup process ${mode}: local edge ${status}`, () => {
      let home: string;
      let child: string;
      let env: NodeJS.ProcessEnv;
      beforeAll(async () => {
        home = mkdtempSync(join(tmpdir(), "scout-setup-process-"));
        const service = resolve(import.meta.dir, "../../lib/core/setup/service.ts");
        const command = resolve(import.meta.dir, "setup.ts");
        const context = resolve(import.meta.dir, "../context.ts");
        child = join(home, "child.ts");
        writeFileSync(child, `
import { mock } from "bun:test";
import { healthyCoreReport } from ${JSON.stringify(resolve(import.meta.dir, "../test-fixtures/core-report.ts"))};
const report = {
  coreReport: healthyCoreReport(),
  currentDirectory: ${JSON.stringify(home)},
  setup: { supportDirectory: "fixture", settingsPath: "fixture", harnessCatalogPath: "fixture",
    relayAgentsPath: "fixture", managedInstallsPath: "fixture", currentProjectConfigPath: null,
    createdProjectConfig: false, projectInventory: [],
    settings: { discovery: { workspaceRoots: [] }, agents: { defaultHarness: "codex" } } },
  broker: { health: { ok: true }, reachable: true, serviceAdapter: "headless-foreground",
    label: "fixture", brokerUrl: "http://127.0.0.1:1", stdoutLogPath: "fixture", stderrLogPath: "fixture" },
  brokerWarning: null,
  catalog: { entries: [{ name: "codex", label: "Codex", harness: "codex",
    readinessReport: { state: "ready", ready: true, detail: "synthetic" } }] },
  scoutSkill: { entries: [] }, claudeStatusline: { status: "skipped", wrapperPath: "fixture" },
  scope: "core", appReadiness: { status: "not_checked", reason: "private_app_scope", detail: "Private app readiness is not checked." },
  // Old app-side fields cannot turn core readiness into a failure.
  localEdge: { status: ${JSON.stringify(status)}, detail: "stale app-side report" },
};
mock.module(${JSON.stringify(service)}, () => ({ runScoutSetup: async () => report }));
const { runSetupCommand } = await import(${JSON.stringify(command)});
const { createScoutCommandContext } = await import(${JSON.stringify(context)});
${readinessWarmupExit()}
await runSetupCommand(createScoutCommandContext({ cwd: ${JSON.stringify(home)}, outputMode: ${JSON.stringify(mode)}, isTty: false }), ["--source-root", ${JSON.stringify(home)}]);
`);
        env = { ...process.env, HOME: home, OPENSCOUT_HOME: join(home, ".openscout"),
          OPENSCOUT_SUPPORT_DIRECTORY: join(home, "support"), OPENSCOUT_CONTROL_HOME: join(home, "control"),
          OPENSCOUT_RELAY_HUB: join(home, "relay"), OPENSCOUT_BROKER_URL: "http://127.0.0.1:1",
          OPENSCOUT_BROKER_SOCKET_PATH: join(home, "absent.sock") };
        await warmReadinessFixture(child, { env });
      });
      afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });
      test(`setup process ${mode}: local edge ${status}`, () => {
        const result = Bun.spawnSync([process.execPath, child], { env, timeout: 20_000 });
        const stdout = result.stdout.toString();
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
        const headline = "Scout core is available. Coding-agent sign-in has not been checked.";
        if (mode === "json") {
          const report = JSON.parse(stdout);
          expect(report.outcome).toBe("ready");
          expect(report.headline).toBe(headline);
          expect(report.localEdge.status).toBe(status);
          expect(report.nextStep).toBe("scout whoami");
          expect(report.webUrl).toBeNull();
        } else {
          expect(stdout).toContain(headline);
          expect(stdout).not.toContain("Browser:");
        }
      });
    });
  }
}

// The headless handoff through the REAL runScoutSetup mapping: only the
// onboarding run is synthetic. Private app diagnostics are never invoked.
const HANDOFF_DETAIL = "Next step: run `openscout-runtime broker` in this shell or under your process manager. "
  + "The headless service adapter leaves broker start to that foreground process.";
const HANDOFF_CASES = {
  handoff: { fails: false },
  "handoff with broker warning": { fails: true },
  "handoff with skill error": { fails: true },
  "handoff with local edge error": { fails: false },
} as const;

for (const mode of ["plain", "json"] as const) {
  for (const [name, { fails }] of Object.entries(HANDOFF_CASES)) {
    describe(`setup process ${mode}: headless broker ${name}`, () => {
      let home: string;
      let child: string;
      let env: NodeJS.ProcessEnv;
      beforeAll(async () => {
        home = mkdtempSync(join(tmpdir(), "scout-setup-handoff-"));
        const command = resolve(import.meta.dir, "setup.ts");
        const context = resolve(import.meta.dir, "../context.ts");
        const onboardingModule = Bun.resolveSync("@openscout/runtime/setup", import.meta.dir);
        child = join(home, "child.ts");
        writeFileSync(child, `
import { mock } from "bun:test";
const onboarding = { ...(await import(${JSON.stringify(onboardingModule)})) };
mock.module(${JSON.stringify(onboardingModule)}, () => ({
  ...onboarding,
  runOpenScoutOnboardingSetup: async () => ({
    setup: { supportDirectory: "fixture", settingsPath: "fixture", harnessCatalogPath: "fixture",
      relayAgentsPath: "fixture", managedInstallsPath: "fixture", currentProjectConfigPath: null,
      createdProjectConfig: false, projectInventory: [],
      settings: { discovery: { workspaceRoots: [] }, agents: { defaultHarness: "codex" } } },
    broker: { health: { ok: false, reachable: false, error: "connect ECONNREFUSED fixture" }, reachable: false,
      serviceAdapter: "headless-foreground", label: "fixture", brokerUrl: "http://127.0.0.1:1",
      brokerSocketPath: "fixture.sock", stdoutLogPath: "fixture", stderrLogPath: "fixture" },
    brokerWarning: ${JSON.stringify(name === "handoff with broker warning" ? "fixture: broker start failed" : null)},
    brokerHandoff: { command: "openscout-runtime broker", detail: ${JSON.stringify(HANDOFF_DETAIL)} },
    catalog: { entries: [{ name: "codex", label: "Codex", harness: "codex",
      readinessReport: { state: "ready", ready: true, detail: "synthetic" } }] },
    scoutSkill: { entries: ${JSON.stringify(name === "handoff with skill error" ? [{ id: "fixture-skill", status: "error", error: "fixture: skill install failed" }] : [])} },
    claudeStatusline: { status: "skipped", wrapperPath: "fixture" },
    localEdge: ${JSON.stringify(name === "handoff with local edge error" ? {status:"error",detail:"stale app-side error"} : undefined)},
    state: {},
  }),
}));
const { runSetupCommand } = await import(${JSON.stringify(command)});
const { createScoutCommandContext } = await import(${JSON.stringify(context)});
${readinessWarmupExit()}
await runSetupCommand(createScoutCommandContext({ cwd: ${JSON.stringify(home)}, outputMode: ${JSON.stringify(mode)}, isTty: false }), ["--source-root", ${JSON.stringify(home)}]);
`);
        env = { ...process.env, HOME: home, OPENSCOUT_HOME: join(home, ".openscout"),
          OPENSCOUT_SUPPORT_DIRECTORY: join(home, "support"), OPENSCOUT_CONTROL_HOME: join(home, "control"),
          OPENSCOUT_RELAY_HUB: join(home, "relay"), OPENSCOUT_BROKER_URL: "http://127.0.0.1:1",
          OPENSCOUT_BROKER_SOCKET_PATH: join(home, "absent.sock") };
        await warmReadinessFixture(child, { env });
      });
      afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });
      test(`setup process ${mode}: headless broker ${name}`, () => {
        const result = Bun.spawnSync([process.execPath, child], { env, timeout: 20_000 });
        const stdout = result.stdout.toString();
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode, stdout).toBe(fails ? 1 : 0);
        const headline = fails ? "Scout core needs attention." : "Scout is set up. Start the broker to finish.";
        if (mode === "json") {
          const report = JSON.parse(stdout);
          expect(report.localEdge).toBeUndefined();
          expect(report.appReadiness.status).toBe("not_checked");
          expect(report.outcome).toBe(fails ? "failed" : "handoff");
          expect(report.headline).toBe(headline);
          // Failed or handed off, the headless next step is the broker command, never "scout setup".
          expect(report.nextStep).toBe("openscout-runtime broker");
          expect(report.brokerHandoff).toEqual({ command: "openscout-runtime broker", detail: HANDOFF_DETAIL });
        } else {
          expect(stdout).toContain(headline);
          expect(stdout).toContain("Next: openscout-runtime broker");
          if (fails) {
            expect(stdout).toContain("fixture:");
          } else {
            expect(stdout).toContain(HANDOFF_DETAIL);
            expect(stdout).not.toContain("Health error");
            expect(stdout).not.toContain("Error:");
          }
        }
      });
    });
  }
}
