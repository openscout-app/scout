import { createScoutCommandContext } from "./context.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_OPENSCOUT_MESH_RELAY_URL, DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL } from "@openscout/protocol";
import { expect, test } from "bun:test";
import { collectDoctorCheck, doctorBunReport, doctorMeshBridgeCheck, doctorBrokerCheck, doctorNativeCheck, doctorWorkerCommand, renderDoctorAssessment, renderDoctorCheck, runDoctorCheck } from "./doctor-checks.ts";
import type { BrokerServiceStatus } from "@openscout/runtime/daemon";

const input = { cwd: process.cwd(), env: process.env };

test("transport failure is inconclusive, while a received unhealthy result is impaired", () => {
  const broker = (reachable: boolean, ok: boolean) => ({ health: { reachable, ok } }) as BrokerServiceStatus;
  expect(doctorBrokerCheck(broker(false, false)).state).toBe("inconclusive");
  expect(doctorBrokerCheck(broker(true, false)).state).toBe("impaired");
  expect(doctorBrokerCheck(broker(true, true)).state).toBe("working");
  expect(doctorBrokerCheck({ ...broker(true, false), health: { ...broker(true, false).health, state: "timed_out" } }).state).toBe("inconclusive");
});

test("a live broker whose journal writes fail is impaired", () => {
  const check = doctorBrokerCheck({ health: { reachable: true, ok: true, storage: { journal: {
    state: "failing", since: 1, lastFailedAt: 2, failures: 4, code: "ENOSPC", error: "ENOSPC: no space left on device, write",
  } } } } as BrokerServiceStatus);
  expect(check.state).toBe("impaired");
  expect(check.detail).toContain("journal writes are failing (ENOSPC)");
  expect(doctorBrokerCheck({ health: { reachable: true, ok: true, storage: { journal: { state: "ok" } } } } as BrokerServiceStatus).state).toBe("working");
});

test("one stalled subprocess does not prevent useful checks from finishing", async () => {
  const completed: string[] = [];
  const slow = runDoctorCheck("native", { ...input, timeoutMs: 150,
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  }).then(result => { completed.push(result.name); return result; });
  const fast = runDoctorCheck("broker", { ...input, timeoutMs: 1_000,
    command: [process.execPath, "-e", 'console.log(JSON.stringify({ name: "broker", state: "working", detail: "Health responded OK." }))'],
  }).then(result => { completed.push(result.name); return result; });
  const [unknown, working] = await Promise.all([slow, fast]);
  expect(completed).toEqual(["broker", "native"]);
  expect(unknown.state).toBe("inconclusive");
  expect(unknown.detail).toContain("No result within");
  expect(working.state).toBe("working");
  const assessment = renderDoctorAssessment([working, unknown]);
  expect(assessment).toContain("1 working, 0 impaired, 1 inconclusive");
  expect(assessment).toContain("not a confirmed failure");
  expect(assessment).toContain("Next:");
});

test("bad output, failed launch and failed diagnostic are inconclusive", async () => {
  for (const command of [
    [process.execPath, "-e", 'console.log("not json")'],
    [process.execPath, "-e", "process.exit(1)"],
    ["/does-not-exist/scout"],
  ]) {
    expect((await runDoctorCheck("broker", { ...input, command })).state).toBe("inconclusive");
  }
});

test("source, bundled JS and compiled entry points relaunch correctly", () => {
  expect(doctorWorkerCommand("/bin/bun", "/repo/scout.ts")).toEqual(["/bin/bun", "/repo/scout.ts"]);
  expect(doctorWorkerCommand("/bin/bun", "/pkg/main.mjs")).toEqual(["/bin/bun", "/pkg/main.mjs"]);
  expect(doctorWorkerCommand("/bin/scout", "/$bunfs/root/scout.ts")).toEqual(["/bin/scout"]);
});

test("assessment stays bounded and selects the impaired check's next action", () => {
  const check = { name: "runtimes" as const, state: "impaired" as const, detail: "missing runtime", next: "scout doctor --detail" };
  expect(renderDoctorCheck(check)).toBe("FAIL runtimes: missing runtime");
  const text = renderDoctorAssessment([check]);
  expect(text).toContain("Assessment: impaired");
  expect(text).toContain("Next: scout doctor --detail");
  expect(text.split("\n").length).toBeLessThan(9);
});

test("deadline reaps the diagnostic process instead of leaving it running", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "scout-deadline-test-"));
  try {
    const pidFile = join(directory, "pid");
    const result = await runDoctorCheck("native", { ...input, timeoutMs: 250,
      command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
    });
    expect(result.state).toBe("inconclusive");
    const pid = Number(await readFile(pidFile, "utf8"));
    // SIGKILL was sent before settlement; allow the OS to deliver and reap it.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("native connected timeout remains inconclusive, while observed failure and stale code remain impaired", () => {
  const report = {
    available: true, error: null, warnings: ["Broker health probe timed out after connecting"],
    status: { reachable: true, healthOk: false, healthState: "timed_out", runtimeFreshness: { state: "current" } },
  } as unknown as Parameters<typeof doctorNativeCheck>[0];
  expect(doctorNativeCheck(report).state).toBe("inconclusive");
  expect(doctorNativeCheck({ ...report, status: { ...report.status!, healthState: "degraded" } }).state).toBe("impaired");
  expect(doctorNativeCheck({ ...report, status: { ...report.status!, runtimeFreshness: { ...report.status!.runtimeFreshness!, state: "stale" } } }).state).toBe("impaired");
});

test("bridge doctor names dir and the rejected pair together without resolving or printing credentials", () => {
  const support = mkdtempSync(join(tmpdir(), "doctor-bridge-"));
  const config = join(support, "mcp-bridge.json");
  try {
    expect(doctorMeshBridgeCheck(support, DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL).state).toBe("working");
    const original = JSON.stringify({ relayUrl: "https://issuer.example.test", dir: "/private/secret-directory",
      token: "DO-NOT-PRINT", tokenKeychainService: "NeverResolveThisService", tokenFile: "/private/secret-file" });
    writeFileSync(config, original);
    const result = doctorMeshBridgeCheck(support, DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL);
    expect(result.state).toBe("impaired");
    expect(renderDoctorCheck(result)).toBe(`FAIL mesh-bridge: Stored bridge config: unsupported dir field; relay/rendezvous pair outside issuer audience (relay=https://issuer.example.test; rendezvous=${new URL(DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL).origin}).`);
    expect(JSON.stringify(result)).not.toContain("DO-NOT-PRINT");
    expect(JSON.stringify(result)).not.toContain("/private/");
    expect(JSON.stringify(result)).not.toContain("NeverResolveThisService");
    expect(readFileSync(config, "utf8")).toBe(original);
    // The amended default pair is valid; a legacy dir still blocks it.
    writeFileSync(config, JSON.stringify({ relayUrl: DEFAULT_OPENSCOUT_MESH_RELAY_URL, dir: "/legacy" }));
    expect(doctorMeshBridgeCheck(support, DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL).detail).toBe("Stored bridge config: unsupported dir field.");
    writeFileSync(config, JSON.stringify({ relayUrl: DEFAULT_OPENSCOUT_MESH_RELAY_URL }));
    expect(doctorMeshBridgeCheck(support, DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL).state).toBe("working");
    writeFileSync(config, "broken JSON");
    expect(doctorMeshBridgeCheck(support, DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL).state).toBe("impaired");
  } finally { rmSync(support, { recursive: true, force: true }); }
});

test("bridge doctor follows publisher env auth, anonymous mode and disable selection without secret resolution", async () => {
  const support = mkdtempSync(join(tmpdir(), "doctor-selection-"));
  const previous = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = support;
  const configPath = join(support, "mcp-bridge.json");
  const original = JSON.stringify({ relayUrl: "https://issuer.example.test", token: "STORED-SECRET",
    tokenKeychainService: "NeverResolveThisService", tokenFile: join(support, "mcp-bridge.token") });
  const inspect = (env: NodeJS.ProcessEnv) => collectDoctorCheck("mesh-bridge", createScoutCommandContext({ env, cwd: support }));
  try {
    writeFileSync(configPath, original);
    for (const auth of [
      { OPENSCOUT_MESH_RENDEZVOUS_TOKEN: " ENV-TOKEN-SECRET " },
      { OPENSCOUT_MESH_RENDEZVOUS_SESSION: " ENV-SESSION-SECRET " },
      { OPENSCOUT_MESH_RENDEZVOUS_ALLOW_ANONYMOUS: "true" },
    ]) {
      const result = await inspect({ OPENSCOUT_MESH_RENDEZVOUS_URL: "http://other.example.test", ...auth });
      expect(result.state).toBe("working");
      expect(result.detail).toContain("host credential audience not checked");
      expect(result.detail).not.toContain("outside issuer audience");
      expect(JSON.stringify(result)).not.toMatch(/STORED-SECRET|ENV-TOKEN-SECRET|ENV-SESSION-SECRET|NeverResolveThisService/);
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }
    for (const disabled of ["false", "FALSE", " false ", "0", " 0 "]) {
      const result = await inspect({ OPENSCOUT_MESH_RENDEZVOUS_URL: disabled, OPENSCOUT_MESH_RENDEZVOUS_TOKEN: "ENV-TOKEN-SECRET" });
      expect(result.state).toBe("working");
      expect(result.detail).toContain("Rendezvous publishing disabled.");
      expect(result.detail).not.toContain("invalid relay/rendezvous");
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }
    // Off settings with no explicit URL also mean no publication; enabled settings select host auth.
    expect((await inspect({})).detail).toContain("Rendezvous publishing disabled.");
    writeFileSync(join(support, "settings.json"), JSON.stringify({ network: { openScoutNetwork: {
      discoveryEnabled: true, rendezvousUrl: DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL,
    } } }));
    expect((await inspect({})).detail).toContain("outside issuer audience");
    expect((await inspect({ OPENSCOUT_MESH_RENDEZVOUS_URL: DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL,
      OPENSCOUT_MESH_RENDEZVOUS_TOKEN: "  ", OPENSCOUT_MESH_RENDEZVOUS_SESSION: " " })).state).toBe("impaired");
    // An env token bypasses only the host audience, not the core bridge's existing launch validation.
    writeFileSync(configPath, JSON.stringify({ relayUrl: DEFAULT_OPENSCOUT_MESH_RELAY_URL, dir: "/legacy" }));
    const legacy = await inspect({ OPENSCOUT_MESH_RENDEZVOUS_URL: "https://other.example.test", OPENSCOUT_MESH_RENDEZVOUS_TOKEN: "ENV-TOKEN-SECRET" });
    expect(legacy.state).toBe("impaired");
    expect(legacy.detail).toContain("unsupported dir field");
    expect(legacy.detail).not.toContain("outside issuer audience");
    const paused = await inspect({ OPENSCOUT_MESH_RENDEZVOUS_URL: "0" });
    expect(paused.state).toBe("impaired");
    expect(paused.detail).toContain("Rendezvous publishing disabled.");
    expect(paused.detail).toContain("unsupported dir field");
    expect(paused.detail).not.toContain("invalid relay/rendezvous");
  } finally {
    if (previous === undefined) delete process.env.OPENSCOUT_SUPPORT_DIRECTORY; else process.env.OPENSCOUT_SUPPORT_DIRECTORY = previous;
    rmSync(support, { recursive: true, force: true });
  }
});

test("doctor reports the executing Bun against the hard floor", () => {
  expect(doctorBunReport("1.4.4")).toEqual({ version: "1.4.4", minimum: "1.4.4", supported: true, upgrade: "bun upgrade" });
  expect(doctorBunReport("1.4.3").supported).toBe(false);
  expect(doctorBunReport("1.3.14").supported).toBe(false);
  expect(doctorBunReport("1.4.4").supported).toBe(true);
});
