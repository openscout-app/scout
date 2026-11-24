import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import {
  isInsideDirectory,
  lastJsonObject,
  runningAppsElsewhere,
  runInstallAll,
  serviceEnvironment,
  type InstallAllDependencies,
  type InstallAllOptions,
  type InstallAllRunResult,
} from "./install-all.ts";
import { parseInstallArgs } from "./install.ts";

const HOME = "/h";
const PKG = "/h/.bun/install/global/node_modules/@openscout/scout";
const BIN = "/h/.bun/bin";
const CHECKOUT = "/h/dev/scout";
const PLIST = "/h/Library/LaunchAgents/app.openscout.plist";
const TARGET = "0.5.3";

type Call = { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string };

type Host = {
  files: Map<string, string>;
  links: Map<string, string>;
  service: { WorkingDirectory: string; ProgramArguments: string[]; EnvironmentVariables: Record<string, string> } | null;
  calls: Call[];
  copies: Array<[string, string]>;
  web: { version?: string; installedVersions: string[]; installed: boolean; key: string | null };
  app: string;
  bunFails: "link" | "all" | null;
  ps: string;
};

function packageJson(version: string): string {
  return JSON.stringify({
    name: "@openscout/scout",
    version,
    bin: { scout: "./bin/scout", "openscout-runtime": "./bin/openscout-runtime.mjs" },
  });
}

/** The MacBook Air as found: scout linked to a checkout, the service started from it. */
function airHost(): Host {
  const files = new Map<string, string>([
    [`${PKG}/package.json`, packageJson("0.4.2")],
    [`${PKG}/bin/scout`, ""],
    [`${PKG}/bin/openscout-runtime.mjs`, ""],
    [`${CHECKOUT}/packages/cli/bin/scout`, ""],
    [`${BIN}/bun`, ""],
    [PLIST, "<plist/>"],
  ]);
  return {
    files,
    links: new Map([
      [`${BIN}/scout`, `${CHECKOUT}/packages/cli/bin/scout`],
      [`${BIN}/openscout-runtime`, `${PKG}/bin/openscout-runtime.mjs`],
    ]),
    service: {
      WorkingDirectory: `${CHECKOUT}/packages/runtime`,
      ProgramArguments: [`${PKG}/bin/scoutd`, "supervise"],
      EnvironmentVariables: {
        OPENSCOUT_BROKER_HOST: "0.0.0.0",
        OPENSCOUT_BROKER_URL: "https://192.168.18.11:43110",
        OPENSCOUT_ADVERTISE_SCOPE: "mesh",
        OPENSCOUT_INSTANCE: "prod",
        OPENSCOUT_BROKER_SERVICE_MODE: "dev",
        OPENSCOUT_MESH_RENDEZVOUS_URL: "https://mesh.example",
        PATH: "/old/path",
        HOME,
      },
    },
    calls: [],
    copies: [],
    web: { installedVersions: [], installed: false, key: null },
    app: "0.4.0",
    bunFails: "link",
    ps: "/Applications/Scout.app/Contents/MacOS/Scout\n/usr/sbin/cfprefsd agent\n",
  };
}

function currentHost(): Host {
  const host = airHost();
  host.files.set(`${PKG}/package.json`, packageJson(TARGET));
  host.links.set(`${BIN}/scout`, `${PKG}/bin/scout`);
  host.service!.WorkingDirectory = PKG;
  host.service!.EnvironmentVariables.OPENSCOUT_RUNTIME_PACKAGE_DIR = PKG;
  host.app = TARGET;
  host.web = { installedVersions: [TARGET], installed: true, key: "keychain" };
  host.bunFails = null;
  return host;
}

function ok(stdout = ""): InstallAllRunResult {
  return { status: 0, stdout, stderr: "" };
}

function dependencies(host: Host): InstallAllDependencies {
  const resolveLink = (path: string): string => host.links.get(path) ?? path;
  return {
    env: { PATH: "/usr/bin", OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT: "1" },
    home: HOME,
    resolveTarget: async () => TARGET,
    readFile: (path) => host.files.get(resolveLink(path)) ?? null,
    exists: (path) => host.files.has(resolveLink(path)),
    isLink: (path) => host.links.has(path),
    realPath: (path) => {
      const resolved = resolveLink(path);
      return host.files.has(resolved) || resolved.startsWith(PKG) || resolved.startsWith(CHECKOUT) ? resolved : null;
    },
    link: (link, target) => {
      host.links.set(link, target.startsWith("/") ? target : `${BIN}/${target}`.replace(/\/[^/]+\/\.\.\//g, "/"));
    },
    copyFile: (from, to) => {
      host.copies.push([from, to]);
    },
    mkdir: () => {},
    now: () => new Date("2026-11-22T20:00:00Z"),
    run: (command, args, options) => {
      host.calls.push({ command, args, env: options?.env, cwd: options?.cwd });
      if (command === "/bin/ps") return ok(host.ps);
      if (command === "/usr/bin/plutil") {
        return host.service ? ok(JSON.stringify(host.service)) : { status: 1, stdout: "", stderr: "no file" };
      }
      if (args[0] === "add") {
        if (host.bunFails === "all") return { status: 1, stdout: "", stderr: "error: network down" };
        host.files.set(`${PKG}/package.json`, packageJson(TARGET));
        return host.bunFails === "link" ? { status: 1, stdout: "", stderr: "Failed to install 1 package" } : ok();
      }
      if (args.includes("service") && args.includes("start")) {
        const env = options?.env ?? {};
        host.service = {
          WorkingDirectory: env.OPENSCOUT_RUNTIME_PACKAGE_DIR!,
          ProgramArguments: [env.OPENSCOUT_SCOUTD_BIN!, "supervise"],
          EnvironmentVariables: Object.fromEntries(
            Object.entries(env).filter((entry): entry is [string, string] => entry[0].startsWith("OPENSCOUT_") && typeof entry[1] === "string"),
          ),
        };
        return ok(`starting\n${JSON.stringify({ reachable: true, health: { ok: true } }, null, 2)}`);
      }
      if (args[0] === "install") {
        if (args.includes("--check")) {
          return ok(JSON.stringify({ installed: host.app, message: `Scout ${host.app}` }));
        }
        const before = host.app;
        const current = before === TARGET && !args.includes("--force");
        host.app = TARGET;
        return ok(JSON.stringify({
          status: current ? "up-to-date" : "updated",
          installed: TARGET,
          message: current ? `Scout ${TARGET} is already installed` : `Updated ${before} → Scout ${TARGET}`,
        }));
      }
      if (args[0] === "web" && args[1] === "status") return ok(JSON.stringify(host.web));
      if (args[0] === "web" && args[1] === "install") return ok();
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    },
  };
}

function options(overrides: Partial<InstallAllOptions> = {}): InstallAllOptions {
  return { version: null, force: false, check: false, restart: true, ...overrides };
}

function quietContext() {
  const out: string[] = [];
  const context = createScoutCommandContext({ outputMode: "json", stdout: (line) => out.push(line), stderr: () => {} });
  return { context, out };
}

function statuses(result: { parts: Array<{ part: string; status: string }> }): Record<string, string> {
  return Object.fromEntries(result.parts.map((part) => [part.part, part.status]));
}

describe("scout install --all", () => {
  test("--force moves a checkout-owned host onto the release and keeps its network settings", async () => {
    const host = airHost();
    const { context } = quietContext();
    const result = await runInstallAll(context, options({ force: true }), dependencies(host));

    expect(statuses(result)).toEqual({ cli: "updated", runtime: "moved", app: "updated", web: "skipped" });
    expect(host.links.get(`${BIN}/scout`)).toBe(`${PKG}/bin/scout`);

    const start = host.calls.find((call) => call.args.includes("start"))!;
    expect(start.cwd).toBe(PKG);
    expect(start.args[0]).toBe(`${PKG}/bin/openscout-runtime.mjs`);
    expect(start.env?.OPENSCOUT_RUNTIME_PACKAGE_DIR).toBe(PKG);
    expect(start.env?.OPENSCOUT_SCOUTD_BIN).toBe(`${PKG}/bin/scoutd`);
    expect(start.env?.OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT).toBe("1");
    expect(start.env?.OPENSCOUT_BROKER_HOST).toBe("0.0.0.0");
    expect(start.env?.OPENSCOUT_BROKER_URL).toBe("https://192.168.18.11:43110");
    expect(start.env?.OPENSCOUT_MESH_RENDEZVOUS_URL).toBe("https://mesh.example");
    expect(start.env?.PATH).toBe("/usr/bin");

    expect(result.backup).toBe("/h/.openscout/backup/app.openscout.plist.20261122-200000");
    expect(host.copies).toEqual([[PLIST, result.backup!]]);

    const app = host.calls.find((call) => call.args[0] === "install" && !call.args.includes("--check"))!;
    expect(app.command).toBe(`${PKG}/bin/scout`);
    expect(app.args).toEqual(["install", "--version", `v${TARGET}`, "--json", "--force"]);

    // The package lands before anything runs from it.
    const order = host.calls.map((call) => call.args[0] === "add" ? "cli" : call.args.includes("start") ? "runtime" : call.args[0]);
    expect(order.indexOf("cli")).toBeLessThan(order.indexOf("runtime"));
    expect(order.indexOf("runtime")).toBeLessThan(order.indexOf("install"));
  });

  test("without --force a checkout-owned command and service are held, not moved", async () => {
    const host = airHost();
    const { context } = quietContext();
    const result = await runInstallAll(context, options(), dependencies(host));

    expect(statuses(result)).toEqual({ cli: "held", runtime: "held", app: "updated", web: "skipped" });
    expect(host.links.get(`${BIN}/scout`)).toBe(`${CHECKOUT}/packages/cli/bin/scout`);
    expect(host.calls.some((call) => call.args.includes("start"))).toBe(false);
    expect(host.copies).toEqual([]);
    expect(result.parts.find((part) => part.part === "runtime")!.message).toContain(`${CHECKOUT}/packages/runtime`);
  });

  test("a host already on the release changes nothing", async () => {
    const host = currentHost();
    const { context } = quietContext();
    const result = await runInstallAll(context, options(), dependencies(host));

    expect(statuses(result)).toEqual({ cli: "up-to-date", runtime: "up-to-date", app: "up-to-date", web: "up-to-date" });
    expect(host.calls.some((call) => call.args[0] === "add")).toBe(false);
    expect(host.calls.some((call) => call.args.includes("start"))).toBe(false);
  });

  test("--force on a current host reinstalls and restarts without a repoint", async () => {
    const host = currentHost();
    const { context } = quietContext();
    const result = await runInstallAll(context, options({ force: true }), dependencies(host));

    expect(statuses(result)).toEqual({ cli: "updated", runtime: "updated", app: "updated", web: "updated" });
    expect(result.parts.find((part) => part.part === "cli")!.message).toBe("@openscout/scout 0.5.3 reinstalled");
    expect(result.parts.find((part) => part.part === "app")!.message).toBe("Scout.app 0.5.3 reinstalled");
    const start = host.calls.find((call) => call.args.includes("start"))!;
    expect(start.env?.OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT).toBeUndefined();
    const web = host.calls.find((call) => call.args[0] === "web" && call.args[1] === "install")!;
    expect(web.args).toEqual(["web", "install", "--version", TARGET, "--no-browser", "--force"]);
  });

  test("an updated package restarts a service that already runs it", async () => {
    const host = currentHost();
    host.files.set(`${PKG}/package.json`, packageJson("0.5.1"));
    const { context } = quietContext();
    const result = await runInstallAll(context, options(), dependencies(host));

    expect(statuses(result).cli).toBe("updated");
    expect(statuses(result).runtime).toBe("updated");
  });

  test("a package that does not install stops the later steps and fails the command", async () => {
    const host = airHost();
    host.bunFails = "all";
    const { context, out } = quietContext();
    await expect(runInstallAll(context, options({ force: true }), dependencies(host))).rejects.toThrow(/CLI did not reach 0\.5\.3/);

    const report = JSON.parse(out.join("\n"));
    expect(statuses(report)).toEqual({ cli: "failed", runtime: "skipped", app: "skipped", web: "skipped" });
    expect(report.parts[0].message).toContain("network down");
    expect(host.calls.some((call) => call.args.includes("start") || call.args[0] === "install")).toBe(false);
  });

  test("--check changes nothing", async () => {
    const host = currentHost();
    host.links.set(`${BIN}/scout`, `${CHECKOUT}/packages/cli/bin/scout`);
    host.app = "0.5.1";
    const { context } = quietContext();
    const result = await runInstallAll(context, options({ check: true }), dependencies(host));

    expect(statuses(result)).toEqual({ cli: "would-change", runtime: "up-to-date", app: "would-change", web: "up-to-date" });
    const readOnly = new Set(["/usr/bin/plutil", "/bin/ps"]);
    expect(host.calls.every((call) => readOnly.has(call.command) || call.args.includes("--check") || call.args.includes("status"))).toBe(true);
    expect(host.copies).toEqual([]);
  });

  test("an app running from a checkout build is held without --force", async () => {
    const host = currentHost();
    host.app = "0.5.1";
    host.ps = `${CHECKOUT}-apps/apps/macos/dist/Scout.app/Contents/MacOS/Scout\n`
      + `${CHECKOUT}-apps/apps/macos/dist/Scout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu\n`;
    const { context } = quietContext();
    const held = await runInstallAll(context, options(), dependencies(host));
    expect(statuses(held).app).toBe("held");
    expect(held.parts.find((part) => part.part === "app")!.message).toContain(`${CHECKOUT}-apps/apps/macos/dist/Scout.app`);
    expect(host.calls.some((call) => call.args[0] === "install" && !call.args.includes("--check"))).toBe(false);

    const forced = await runInstallAll(context, options({ force: true }), dependencies(host));
    expect(statuses(forced).app).toBe("updated");
  });

  test("only a running Scout executable counts, not a command line that names one", () => {
    const run = () => ok([
      "/Applications/Scout.app/Contents/MacOS/Scout",
      "/bin/zsh -c ls /x/dist/Scout.app/Contents/MacOS/Scout",
      "  /x/dist/Scout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu -psn",
      "/x/dist/Scout.app/Contents/MacOS/ScoutHelper",
    ].join("\n"));
    expect(runningAppsElsewhere({ run })).toEqual(["/x/dist/Scout.app"]);
  });

  test("a missing service is left to scout setup", async () => {
    const host = currentHost();
    host.service = null;
    host.files.delete(PLIST);
    const { context } = quietContext();
    const result = await runInstallAll(context, options({ force: true }), dependencies(host));
    expect(statuses(result).runtime).toBe("skipped");
    expect(result.parts.find((part) => part.part === "runtime")!.message).toContain("scout setup");
  });

  test("an installed web app without a sign-in key is held", async () => {
    const host = currentHost();
    host.web = { installedVersions: ["0.5.1"], installed: false, key: null };
    const { context } = quietContext();
    const result = await runInstallAll(context, options(), dependencies(host));
    expect(statuses(result).web).toBe("held");
    expect(host.calls.some((call) => call.args[0] === "web" && call.args[1] === "install")).toBe(false);
  });
});

describe("install --all helpers", () => {
  test("the service environment keeps settings and replaces the owner", () => {
    const env = serviceEnvironment({
      env: { PATH: "/usr/bin", OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT: "1", OPENSCOUT_BROKER_HOST: "127.0.0.1" },
      service: {
        OPENSCOUT_BROKER_HOST: "0.0.0.0",
        OPENSCOUT_RUNTIME_PACKAGE_DIR: CHECKOUT,
        OPENSCOUT_SCOUTD_BIN: `${CHECKOUT}/bin/scoutd`,
        PATH: "/old",
      },
      packageDirectory: PKG,
      repoint: false,
    });
    expect(env.OPENSCOUT_BROKER_HOST).toBe("0.0.0.0");
    expect(env.OPENSCOUT_RUNTIME_PACKAGE_DIR).toBe(PKG);
    expect(env.OPENSCOUT_SCOUTD_BIN).toBe(`${PKG}/bin/scoutd`);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT).toBeUndefined();
  });

  test("the last JSON object wins over progress lines", () => {
    expect(lastJsonObject('Fetching…\n{\n  "a": 1\n}')).toEqual({ a: 1 });
    expect(lastJsonObject("nothing")).toBeNull();
  });

  test("a directory contains itself and its children, not its siblings", () => {
    const real = (path: string) => path;
    expect(isInsideDirectory(PKG, PKG, real)).toBe(true);
    expect(isInsideDirectory(`${PKG}/bin/scoutd`, PKG, real)).toBe(true);
    expect(isInsideDirectory(`${PKG}-old/bin`, PKG, real)).toBe(false);
  });

  test("--all parses and refuses a local candidate", () => {
    expect(parseInstallArgs(["--all", "--force"])).toMatchObject({ all: true, force: true });
    expect(() => parseInstallArgs(["--all", "--candidate", "r.json", "--dmg", "a.dmg"])).toThrow(/published release/);
  });
});
