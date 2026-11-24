import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOCTOR_CHECK_NAMES } from "./doctor-checks.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "core-readiness-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const marker = join(root, "private-command-called");
  for (const name of ["brew", "caddy", "security", "secret-tool", "node"]) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\nexit 91\n`);
    chmodSync(file, 0o755);
  }
  const env = {
    ...process.env, HOME: root, OPENSCOUT_HOME: join(root, "scout"),
    OPENSCOUT_SUPPORT_DIRECTORY: join(root, "support"), OPENSCOUT_CONTROL_HOME: join(root, "control"),
    OPENSCOUT_RELAY_HUB: join(root, "relay"), OPENSCOUT_BROKER_URL: "http://127.0.0.1:1",
    OPENSCOUT_BROKER_SOCKET_PATH: join(root, "absent.sock"), OPENSCOUT_SCOUTD_BIN: "/usr/bin/false",
    OPENSCOUT_PROBES_SOCKET: join(root, "absent-probes.sock"), OPENSCOUT_SKIP_USER_PROJECT_HINTS: "1",
    OPENSCOUT_SERVICE_ADAPTER: "headless-foreground", OPENSCOUT_ADVERTISE_SCOPE: "local",
    OPENSCOUT_NODE_BIN: join(bin, "node"), OPENSCOUT_CADDY_BIN: join(bin, "caddy"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  return { root, marker, env };
}
test("the default assessment contains only core checks, never CA or private Web-PTY prerequisites", () => {
  expect([...DOCTOR_CHECK_NAMES]).toEqual(["broker", "native", "runtimes", "mesh-bridge", "probes"]);
});
test("real source setup is headless/core-only even with hostile private dependency executables on PATH", () => {
  const f = fixture();
  const main = resolve(import.meta.dir, "../main.ts");
  const result = Bun.spawnSync([process.execPath, main, "setup", "--source-root", f.root, "--json"], { cwd: f.root, env: f.env, timeout: 20000, killSignal: "SIGKILL" });
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  const report = JSON.parse(result.stdout.toString());
  expect(report).toMatchObject({ schema: "scout.setup.v2", scope: "core", outcome: "handoff", nextStep: "openscout-runtime broker", webUrl: null, browserGuidance: null, appReadiness: { status: "not_checked", reason: "private_app_scope" } });
  expect(report.localEdge).toBeUndefined();
  expect(report.terminalPty).toBeUndefined();
  expect(existsSync(f.marker)).toBe(false);
});
test("owned doctor worker uses the core bootstrap and refuses obsolete private checks", () => {
  const f = fixture();
  const main = resolve(import.meta.dir, "../main.ts");
  const result = Bun.spawnSync([process.execPath, main, "__doctor-check", "runtimes"], { cwd: f.root, env: f.env, timeout: 10000, killSignal: "SIGKILL" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ name: "runtimes" });
  expect(existsSync(f.marker)).toBe(false);
  for (const name of ["local-edge", "terminal"]) {
    const refused = Bun.spawnSync([process.execPath, main, "__doctor-check", name], { cwd: f.root, env: f.env, timeout: 10000, killSignal: "SIGKILL" });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("invalid diagnostic check");
  }
});
test("doctor JSON/detail/fix use only core observation and never invoke private dependency helpers", () => {
  const f = fixture();
  const child = join(f.root, "child.ts");
  const source = (path: string) => resolve(import.meta.dir, path);
  const runtime = (path: string) => Bun.resolveSync(`@openscout/runtime/${path}`, import.meta.dir);
  writeFileSync(child, `
import { mock, expect } from "bun:test";
const forbid=()=>{throw Error("private readiness invoked");};
mock.module(${JSON.stringify(source("../../../../apps/desktop/src/core/setup/local-edge-dependencies.ts"))},()=>({ensureScoutLocalEdgeDependencies:forbid,inspectScoutLocalEdgeDependencies:forbid}));
mock.module(${JSON.stringify(source("../../../../apps/desktop/src/core/setup/terminal-pty-dependencies.ts"))},()=>({inspectScoutTerminalPtyDependencies:forbid}));
const setup=await import(${JSON.stringify(runtime("setup"))});
const settings={discovery:{workspaceRoots:[]},agents:{defaultHarness:"codex",defaultCapabilities:[],sessionPrefix:"fixture"}};
mock.module(${JSON.stringify(runtime("setup"))},()=>({
 ...setup,
 loadResolvedRelayAgents:async()=>({supportDirectory:"fixture",settingsPath:"fixture",harnessCatalogPath:"fixture",relayAgentsPath:"fixture",managedInstallsPath:"fixture",currentProjectConfigPath:null,settings,projectInventory:[]}),
 loadSystemProbeDoctorReport:async()=>({socketPath:"fixture",supportedProbeIds:[],families:[],warnings:[]}),
}));
const catalog=await import(${JSON.stringify(runtime("harnesses"))});
let reads=0;
mock.module(${JSON.stringify(runtime("harnesses"))},()=>({...catalog,loadHarnessCatalogSnapshot:async(options)=>{expect(options).toEqual({localOnly:true});reads++;return {entries:[]};}}));
const broker=await import(${JSON.stringify(source("../lib/core/broker/service.ts"))});
mock.module(${JSON.stringify(source("../lib/core/broker/service.ts"))},()=>({...broker,readScoutCapabilityMatrix:async()=>null}));
mock.module(${JSON.stringify(source("../lib/app/host/runtime-service-client.ts"))},()=>({getRuntimeBrokerServiceStatus:async()=>({health:{ok:true},reachable:true,serviceAdapter:"headless-foreground"})}));
let fixes=[];
const native=await import(${JSON.stringify(source("./scoutd.ts"))});
mock.module(${JSON.stringify(source("./scoutd.ts"))},()=>({...native,loadNativeScoutdDoctorReport:async(input)=>{fixes.push(input.fix);return native.normalizeNativeScoutdDoctorReport({raw:{},scoutdPath:null,source:null,available:false});}}));
const {runDoctorCommand}=await import(${JSON.stringify(source("./commands/doctor.ts"))});
const {createScoutCommandContext}=await import(${JSON.stringify(source("./context.ts"))});
for(const args of [["--json"],["--detail"],["--fix","--yes"]]) {
 const lines=[];const json=args.includes("--json");
 await runDoctorCommand(createScoutCommandContext({cwd:process.env.HOME,env:process.env,outputMode:json?"json":"plain",stdout:s=>lines.push(s)}),args);
 if(json){const events=lines.map(s=>JSON.parse(s));expect(events.every(e=>e.schema==="scout.doctor.core/v1"&&e.scope==="core")).toBe(true);const report=events.at(-1).report;expect(report.optional.app.availability).toBe("not_checked");expect(report.localEdge).toBeUndefined();expect(report.terminalPty).toBeUndefined();}
 else {expect(lines.join("\\n")).toContain("Scope: core only");expect(lines.join("\\n")).not.toContain("Web terminal (Node PTY relay)");}
}
expect(reads).toBe(3);expect(fixes).toEqual([false,true]);
`);
  const result = Bun.spawnSync([process.execPath, child], { cwd: f.root, env: f.env, timeout: 20000, killSignal: "SIGKILL" });
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  expect(existsSync(f.marker)).toBe(false);
});
// Bun build plugins run in an owned child so neither its loader nor plugin
// cache can affect another file in the --isolate source suite.
test("bundled Node setup and doctor stay on the public headless graph", () => {
  const f = fixture();
  const node = Bun.which("node");
  expect(node).not.toBeNull();
  const child = join(f.root, "node-proof.ts");
  writeFileSync(child, String.raw`
import { expect } from "bun:test";
import { join } from "node:path";
const root = ${JSON.stringify(f.root)};
const privateInputs: string[] = [];
const built = await Bun.build({
  entrypoints: [${JSON.stringify(resolve(import.meta.dir, "../node-main.ts"))}],
  target: "node", conditions: ["bun"], format: "esm", outdir: root, naming: "node.mjs",
  plugins: [{ name: "reject-private-inputs", setup(build) {
    build.onLoad({ filter: /./ }, args => {
      if (/\/(apps\/desktop|packages\/web)\//.test(args.path)) privateInputs.push(args.path);
      return undefined;
    });
  } }],
});
expect(built.success, built.logs.map(String).join("\n")).toBe(true);
expect(privateInputs).toEqual([]);
for (const args of [["setup", "--source-root", root, "--json"], ["doctor", "--json"], ["doctor", "--fix", "--yes", "--json"]]) {
  const result = Bun.spawnSync([${JSON.stringify(node)}, join(root, "node.mjs"), ...args], {
    cwd: root, env: process.env, timeout: 20_000, killSignal: "SIGKILL",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const report = JSON.parse(result.stdout.toString());
  expect(report).toMatchObject({
    schema: args[0] === "setup" ? "scout.setup.v2" : "scout.doctor.core.node/v1",
    scope: "core", appReadiness: { status: "not_checked", reason: "private_app_scope" },
  });
  expect(report.localEdge).toBeUndefined();
  expect(report.terminalPty).toBeUndefined();
  if (args[0] === "setup") {
    expect(report).toMatchObject({ outcome: "handoff", nextStep: "openscout-runtime broker", webUrl: null });
  } else {
    expect(report.nativeRepairs).toMatchObject({ requested: args.includes("--fix"), supported: false });
  }
}
`);
  const result = Bun.spawnSync([process.execPath, child], { cwd: f.root, env: f.env, timeout: 25_000, killSignal: "SIGKILL" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(existsSync(f.marker)).toBe(false);
}, 30_000);

test("owned mesh-bridge doctor worker reports both stored problems without secret helpers", () => {
  const f = fixture();
  mkdirSync(f.env.OPENSCOUT_SUPPORT_DIRECTORY);
  writeFileSync(join(f.env.OPENSCOUT_SUPPORT_DIRECTORY, "mcp-bridge.json"), JSON.stringify({
    relayUrl: "https://issuer.example.test", dir: "/legacy/private", tokenKeychainService: "NeverResolveThisService",
  }));
  const main = resolve(import.meta.dir, "../main.ts");
  const result = Bun.spawnSync([process.execPath, main, "__doctor-check", "mesh-bridge"], {
    cwd: f.root, env: { ...f.env, OPENSCOUT_MESH_RENDEZVOUS_URL: "https://rendezvous.example.test" },
    timeout: 20000, killSignal: "SIGKILL",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ name: "mesh-bridge", state: "impaired",
    detail: "Stored bridge config: unsupported dir field; relay/rendezvous pair outside issuer audience (relay=https://issuer.example.test; rendezvous=https://rendezvous.example.test)." });
  expect(existsSync(f.marker)).toBe(false);
});

test("owned bridge doctor worker reports disabled publication and skips an env-routed audience", () => {
  const f = fixture();
  mkdirSync(f.env.OPENSCOUT_SUPPORT_DIRECTORY);
  writeFileSync(join(f.env.OPENSCOUT_SUPPORT_DIRECTORY, "mcp-bridge.json"), JSON.stringify({
    relayUrl: "https://issuer.example.test", tokenKeychainService: "NeverResolveThisService",
  }));
  const main = resolve(import.meta.dir, "../main.ts");
  for (const env of [
    { OPENSCOUT_MESH_RENDEZVOUS_URL: " false ", OPENSCOUT_MESH_RENDEZVOUS_TOKEN: "" },
    { OPENSCOUT_MESH_RENDEZVOUS_URL: "0", OPENSCOUT_MESH_RENDEZVOUS_TOKEN: "" },
    { OPENSCOUT_MESH_RENDEZVOUS_URL: "https://other.example.test", OPENSCOUT_MESH_RENDEZVOUS_TOKEN: "SYNTHETIC-ENV-TOKEN" },
  ]) {
    const result = Bun.spawnSync([process.execPath, main, "__doctor-check", "mesh-bridge"], {
      cwd: f.root, env: { ...f.env, ...env }, timeout: 20000, killSignal: "SIGKILL",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const check = JSON.parse(result.stdout.toString());
    expect(check).toMatchObject({ name: "mesh-bridge", state: "working" });
    expect(check.detail).toContain(env.OPENSCOUT_MESH_RENDEZVOUS_TOKEN ? "host credential audience not checked" : "Rendezvous publishing disabled.");
    expect(result.stdout.toString()).not.toContain("SYNTHETIC-ENV-TOKEN");
    expect(existsSync(f.marker)).toBe(false);
  }
});
