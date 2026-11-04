/** Foreground, named-instance projection-latch smoke test. Never installs a service.
 * Run after `bun run scoutd:build`: `bun scripts/scoutd-health-recovery-smoke.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoutBrokerPaths } from "../packages/protocol/src/broker-routes.ts";
import { applyOpenScoutInstanceEnvironment } from "../packages/runtime/src/instance.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = join(root, "target/debug/scoutd");
if (!existsSync(binary)) throw new Error("Build scoutd first: bun run scoutd:build");
const sourceDirectory = join(root, "packages/runtime/src");
const injectedSource = join(sourceDirectory, `.scoutd-health-smoke.${process.pid}.ts`);
const original = readFileSync(join(sourceDirectory, "broker-daemon.ts"), "utf8");
const boundary = "    await projection.warm();";
if (!original.includes(boundary)) throw new Error("Projection open boundary moved; update this smoke test");
const scratch = mkdtempSync(join(tmpdir(), "scoutd-health-smoke-"));
const packageDirectory = join(scratch, "package");
mkdirSync(join(packageDirectory, "bin"), { recursive: true });
const env: Record<string, string | undefined> = { ...process.env, OPENSCOUT_INSTANCE: `dev-health-smoke-${process.pid}` };
const { layout } = applyOpenScoutInstanceEnvironment(env);
if (layout.isProd || layout.ports.broker === 43110 || layout.serviceLabel === "app.openscout") throw new Error("Instance isolation failed");
mkdirSync(layout.runtimeDirectory, { recursive: true });
const fault = join(layout.runtimeDirectory, "projection-open-fault");
writeFileSync(fault, "injected projection open failure", { flag: "wx" });
writeFileSync(injectedSource, original.replace(boundary,
  '    if (process.env.OPENSCOUT_HEALTH_SWEEP_FAULT && await Bun.file(process.env.OPENSCOUT_HEALTH_SWEEP_FAULT).exists()) throw new Error("projection open fault (dev smoke)");\n' + boundary), { flag: "wx" });
const bootstrap = new URL("../packages/runtime/src/instance-bootstrap.ts", import.meta.url).href;
const base = new URL("../packages/runtime/src/base-daemon.ts", import.meta.url).href;
writeFileSync(join(packageDirectory, "bin/openscout-runtime.mjs"), `
await import(${JSON.stringify(bootstrap)});
process.env.OPENSCOUT_RUNTIME_PACKAGE_DIR = ${JSON.stringify(packageDirectory)};
await import(process.argv[2] === "base" ? ${JSON.stringify(base)} : ${JSON.stringify(pathToFileURL(injectedSource).href)});
`);
Object.assign(env, {
  OPENSCOUT_RUNTIME_PACKAGE_DIR: packageDirectory,
  OPENSCOUT_SCOUTD_BIN: binary,
  OPENSCOUT_HEALTH_SWEEP_FAULT: fault,
  // Exercise state/restart, not operator delivery or app-owned children.
  OPENSCOUT_HEALTH_SWEEP_TEST_NO_NOTIFY: "1",
  OPENSCOUT_BASE_PAIRING_ENABLED: "0", OPENSCOUT_BASE_MENU_ENABLED: "0",
  OPENSCOUT_BASE_EDGE_ENABLED: "0", OPENSCOUT_BASE_START_WEB: "0",
  OPENSCOUT_CORE_AGENTS: "", OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "0",
});
const logPath = join(scratch, "supervisor.log");
const log = Bun.file(logPath);
let child: ReturnType<typeof Bun.spawn> | undefined;
const brokerBase = `http://127.0.0.1:${layout.ports.broker}`;
const healthUrl = new URL(scoutBrokerPaths.health, brokerBase);
let degraded = false, recovered = false, cleared = false;
let lastPid: number | undefined;
try {
  child = Bun.spawn([binary, "supervise"], { cwd: root, env, stdout: log, stderr: log });
  for (let elapsed = 0; elapsed < 360; elapsed++) {
    await Bun.sleep(1000);
    if (child.exitCode !== null) throw new Error(`Supervisor exited early: ${child.exitCode}; see ${logPath}`);
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
      const health = await response.json() as { startup?: { phase?: string; mutationsAdmitted?: boolean } };
      const state = JSON.parse(readFileSync(join(layout.runtimeDirectory, "scoutd-state.json"), "utf8"));
      if (health.startup?.phase === "degraded" && !degraded) {
        degraded = true; lastPid = state.basePid;
        console.log(JSON.stringify({ event: "degraded", elapsed, basePid: lastPid, startup: health.startup }));
        unlinkSync(fault);
      }
      if (degraded && health.startup?.mutationsAdmitted && !recovered) {
        if (state.basePid === lastPid) throw new Error("Readiness returned without a supervised-child restart");
        recovered = true;
        console.log(JSON.stringify({ event: "recovered", elapsed, basePid: state.basePid, startup: health.startup }));
      }
      if (recovered) {
        const sweep = JSON.parse(readFileSync(join(layout.runtimeDirectory, "scoutd-health.json"), "utf8"));
        if (!sweep.conditions.some((condition: { condition: string }) => condition.condition === "startup-projection")) {
          cleared = true; console.log(JSON.stringify({ event: "condition-cleared", elapsed })); break;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("without a supervised-child restart")) throw error;
      // Transient probes during shutdown/startup are expected.
    }
  }
  if (!degraded || !recovered || !cleared) throw new Error(`Recovery incomplete: degraded=${degraded}, recovered=${recovered}, cleared=${cleared}; see ${logPath}`);
} finally {
  // Signal only the child handle created by this script.
  if (child) { child.kill("SIGTERM"); await child.exited; }
  if (existsSync(injectedSource)) unlinkSync(injectedSource);
  if (existsSync(fault)) unlinkSync(fault);
  console.log(JSON.stringify({ supervisorExit: child?.exitCode, instance: layout.name, stateDirectory: layout.runtimeDirectory, logPath, sharedService: "untouched" }));
}
