import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findScoutExtension, listScoutExtensions, runScoutExtension, scoutExtensionEnv, scoutExtensionRoots, scoutExtensionsHome } from "./extensions.ts";
import { renderScoutExtensionLines } from "./help.ts";
import { findScoutCommandRegistration, listScoutPrimaryCommands, missingScoutExtensionMessage } from "./registry.ts";

const root = mkdtempSync(join(tmpdir(), "scout-extensions-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}
function install(dir: string, name: string, body: string, manifest: Record<string, unknown> = {}) {
  mkdirSync(join(dir, name, "bin"), { recursive: true });
  writeFileSync(join(dir, name, "extension.json"), JSON.stringify({ api: 1, command: "bin/run", ...manifest }));
  script(join(dir, name, "bin", "run"), body);
}

const home = join(root, "extensions");
const bin = join(root, "bin");
const out = join(root, "out.txt");
install(home, "mesh", `printf '%s|%s|%s|%s|%s\\n' "$*" "$SCOUT_EXTENSION_API" "$SCOUT_OUTPUT" "$OPENSCOUT_BROKER_URL" "\${PATH%%:*}" > "${out}"; exit 3`, { summary: "Mesh from the app" });
install(home, "future", "exit 0", { api: 2 });
mkdirSync(bin);
script(join(bin, "scout-hello"), "exit 0");
const env = { OPENSCOUT_EXTENSIONS_HOME: home, PATH: bin };

describe("scout extensions", () => {
  test("only an installed extension counts: a scout-<verb> on PATH never takes over a verb", () => {
    expect(findScoutExtension("mesh", env)).toMatchObject({ command: join(home, "mesh", "bin", "run"), summary: "Mesh from the app" });
    expect(findScoutExtension("mesh", env)?.refused).toBeUndefined();
    expect(findScoutExtension("hello", env)).toBeUndefined();
    expect(findScoutExtension("../etc", env)).toBeUndefined();
    expect(listScoutExtensions(env).map((e) => e.name)).toEqual(["future", "mesh"]);
  });

  test("extensions live in ~/.scout, and ~/.openscout is still read as a fallback", () => {
    const user = join(root, "user");
    install(join(user, ".openscout", "extensions"), "legacy", "exit 0");
    install(join(user, ".openscout", "extensions"), "both", "exit 0", { summary: "old" });
    install(join(user, ".scout", "extensions"), "both", "exit 0", { summary: "new" });
    const userEnv = { HOME: user };
    expect(scoutExtensionsHome(userEnv)).toBe(join(user, ".scout", "extensions"));
    expect(scoutExtensionRoots(userEnv)).toEqual([join(user, ".scout", "extensions"), join(user, ".openscout", "extensions")]);
    expect(findScoutExtension("both", userEnv)?.summary).toBe("new");
    expect(findScoutExtension("legacy", userEnv)?.root).toBe(join(user, ".openscout", "extensions"));
    expect(listScoutExtensions(userEnv).map((e) => `${e.name}:${e.summary ?? ""}`)).toEqual(["both:new", "legacy:"]);
    // An explicit Scout home is an isolation boundary: no fallback to the real legacy folder.
    expect(scoutExtensionRoots({ HOME: user, SCOUT_HOME: join(root, "isolated") })).toEqual([join(root, "isolated", "extensions")]);
  });

  test("an extension gets the argv and the environment contract, and its exit status comes back", async () => {
    const extension = findScoutExtension("mesh", env)!;
    const status = await runScoutExtension(extension, ["ping", "example"], scoutExtensionEnv({
      env, extension, cliVersion: "0.3.9", outputMode: "json", brokerUrl: "http://127.0.0.1:43110", runtimeDir: "/opt/bun/bin",
    }));
    expect(status).toBe(3);
    expect(readFileSync(out, "utf8").trim()).toBe("ping example|1|json|http://127.0.0.1:43110|/opt/bun/bin");
  });

  test("an extension for another API version, or in a world-writable folder, is refused with the reason", () => {
    expect(findScoutExtension("future", env)?.refused).toContain("built for extension API 2; this scout supports API 1");
    install(home, "loose", "exit 0");
    chmodSync(join(home, "loose"), 0o777);
    expect(findScoutExtension("loose", env)?.refused).toContain("anyone on this machine can write to");
    chmodSync(join(home, "loose"), 0o755);
    expect(findScoutExtension("loose", env)?.refused).toBeUndefined();
    expect(renderScoutExtensionLines(listScoutExtensions(env))).toContain(`future       ${join(home, "future", "bin", "run")} (cannot run)`);
  });

  test("a folder anyone can write to anywhere on the way to the command refuses the extension", () => {
    install(home, "loosebin", "exit 0");
    const binDir = join(home, "loosebin", "bin");
    try {
      chmodSync(binDir, 0o777);
      expect(findScoutExtension("loosebin", env)?.refused).toContain(`anyone on this machine can write to ${realpathSync(binDir)}`);
      chmodSync(binDir, 0o755);
      chmodSync(home, 0o777);
      expect(findScoutExtension("mesh", env)?.refused).toContain(`anyone on this machine can write to ${realpathSync(home)}`);
    } finally {
      chmodSync(binDir, 0o755);
      chmodSync(home, 0o755);
    }
    expect(findScoutExtension("mesh", env)?.refused).toBeUndefined();
  });

  test("an extension runs only files inside its own folder", () => {
    script(join(root, "elsewhere"), "exit 0");
    install(home, "absolute", "exit 0", { command: join(root, "elsewhere") });
    install(home, "dotdot", "exit 0", { command: "../../elsewhere" });
    install(home, "linked", "exit 0");
    rmSync(join(home, "linked", "bin", "run"));
    symlinkSync(join(root, "elsewhere"), join(home, "linked", "bin", "run"));
    for (const name of ["absolute", "dotdot", "linked"]) {
      expect(findScoutExtension(name, env)?.refused).toContain("outside the extension's folder");
    }
    // A symlinked extension folder still works: its command is inside the folder it points to.
    install(join(root, "vendored"), "tool", "exit 0");
    symlinkSync(join(root, "vendored", "tool"), join(home, "tool"));
    expect(findScoutExtension("tool", env)?.refused).toBeUndefined();
  });

  test("an installed extension that cannot run is listed and refused with the reason, never skipped", () => {
    install(home, "nocommand", "exit 0", { command: "" });
    install(home, "noexec", "exit 0");
    chmodSync(join(home, "noexec", "bin", "run"), 0o644);
    expect(findScoutExtension("nocommand", env)?.refused).toContain(`has no "command"`);
    expect(findScoutExtension("noexec", env)?.refused).toContain("permission denied (EACCES)");
    expect(listScoutExtensions(env).filter((e) => e.refused).map((e) => e.name)).toEqual(expect.arrayContaining(["nocommand", "noexec"]));
    // A broken copy in ~/.scout must not let an older copy in ~/.openscout run in its place.
    const user = join(root, "broken-user");
    install(join(user, ".openscout", "extensions"), "stale", "exit 0");
    mkdirSync(join(user, ".scout", "extensions", "stale"), { recursive: true });
    writeFileSync(join(user, ".scout", "extensions", "stale", "extension.json"), "{ not json");
    expect(findScoutExtension("stale", { HOME: user })).toMatchObject({ root: join(user, ".scout", "extensions") });
    expect(findScoutExtension("stale", { HOME: user })?.refused).toContain("cannot read as JSON");
  });

  test("Scout's own variables reach an extension only through the contract", () => {
    const extension = findScoutExtension("mesh", env)!;
    const childEnv = scoutExtensionEnv({
      env: { ...env, HOME: "/home/u", LANG: "C", SCOUT_HOME: "/isolated", OPENSCOUT_RUNTIME_SECRET: "synthetic-test-secret", SCOUT_TUNING: "1" },
      extension, cliVersion: "0.3.9", outputMode: "plain", brokerUrl: "http://127.0.0.1:43110",
    });
    expect(childEnv.OPENSCOUT_RUNTIME_SECRET).toBeUndefined();
    expect(childEnv.SCOUT_TUNING).toBeUndefined();
    expect(childEnv.OPENSCOUT_EXTENSIONS_HOME).toBeUndefined();
    expect(childEnv).toMatchObject({ HOME: "/home/u", LANG: "C", SCOUT_HOME: "/isolated", SCOUT_OUTPUT: "plain", OPENSCOUT_BROKER_URL: "http://127.0.0.1:43110" });
  });

  test("SIGTERM to scout stops the extension instead of orphaning it", async () => {
    const pidFile = join(root, "child.pid");
    install(home, "sleeper", `echo $$ > "${pidFile}"; exec sleep 30`);
    const runner = join(root, "runner.ts");
    writeFileSync(runner, `import { findScoutExtension, runScoutExtension } from ${JSON.stringify(join(import.meta.dir, "extensions.ts"))};
const extension = findScoutExtension("sleeper", { OPENSCOUT_EXTENSIONS_HOME: ${JSON.stringify(home)} })!;
process.exitCode = await runScoutExtension(extension, [], process.env);`);
    const scout = spawn(process.execPath, [runner], { stdio: "ignore" });
    const exited = new Promise<number | null>((resolveExit) => scout.once("exit", (code) => resolveExit(code)));
    let childPid = 0;
    for (let i = 0; i < 100 && !childPid; i += 1) {
      await Bun.sleep(50);
      try { childPid = Number(readFileSync(pidFile, "utf8").trim()); } catch { /* not started yet */ }
    }
    expect(childPid).toBeGreaterThan(0);
    scout.kill("SIGTERM");
    expect(await exited).toBe(143);
    const alive = (() => { try { process.kill(childPid, 0); return true; } catch { return false; } })();
    if (alive) process.kill(childPid, "SIGKILL");
    expect(alive).toBe(false);
  }, 15_000);


  test("strict path components must belong to the current user or root", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    install(home, "owned", "exit 0");
    const strict = [home, join(home, "owned"), join(home, "owned", "bin"), join(home, "owned", "bin", "run")]
      .map(path => realpathSync(path));
    const stat = fs.statSync;
    for (const target of strict) {
      const fakeOwner = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike) => {
        const value = stat(path);
        return String(path) === target ? Object.assign(value, { uid: uid + 1 }) : value;
      }) as typeof fs.statSync);
      try { expect(findScoutExtension("owned", env)?.refused).toContain("not owned by the current user or root"); }
      finally { fakeOwner.mockRestore(); }
    }
    const rootOwner = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike) =>
      Object.assign(stat(path), { uid: 0 })) as typeof fs.statSync);
    try { expect(findScoutExtension("owned", env)?.refused).toBeUndefined(); }
    finally { rootOwner.mockRestore(); }
  });

  test("permission errors are explicit and never allow a legacy fallback", () => {
    install(home, "denied", "exit 0");
    const command = join(home, "denied", "bin", "run");
    const realpath = fs.realpathSync;
    const deniedPath = spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike) => {
      if (String(path) === command) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return realpath(path);
    }) as typeof fs.realpathSync);
    try {
      const reason = findScoutExtension("denied", env)?.refused;
      expect(reason).toContain("permission denied (EACCES)");
      expect(reason).not.toContain("does not exist");
    } finally { deniedPath.mockRestore(); }
    const user = join(root, "denied-user");
    const primary = join(user, ".scout", "extensions");
    install(primary, "same", "exit 0");
    install(join(user, ".openscout", "extensions"), "same", "exit 0");
    const manifest = join(primary, "same", "extension.json");
    const stat = fs.statSync;
    const deniedManifest = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike) => {
      if (String(path) === manifest) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return stat(path);
    }) as typeof fs.statSync);
    try {
      expect(findScoutExtension("same", { HOME: user })).toMatchObject({ root: primary });
      expect(findScoutExtension("same", { HOME: user })?.refused).toContain("permission denied (EACCES)");
    } finally { deniedManifest.mockRestore(); }
  });

  test("a sticky shared ancestor is allowed, but a sticky extensions root is not", () => {
    const shared = join(root, "sticky-parent");
    const extensions = join(shared, "extensions");
    install(extensions, "tool", "exit 0");
    // Bun chmodSync drops the sticky bit; use chmod itself on both macOS and Linux.
    expect(spawnSync("/bin/chmod", ["1777", shared]).status).toBe(0);
    expect(fs.statSync(shared).mode & 0o1000).toBe(0o1000);
    expect(findScoutExtension("tool", { OPENSCOUT_EXTENSIONS_HOME: extensions })?.refused).toBeUndefined();
    try {
      expect(spawnSync("/bin/chmod", ["1777", extensions]).status).toBe(0);
      expect(findScoutExtension("tool", { OPENSCOUT_EXTENSIONS_HOME: extensions })?.refused)
        .toContain("anyone on this machine can write to");
    } finally { expect(spawnSync("/bin/chmod", ["0755", extensions]).status).toBe(0); }
  });

  test("mesh stays built in until its extension ships with an installer", () => {
    // The runtime supervises `scout mesh bridge` (mesh-bridge-supervisor.ts); flipping
    // mesh to an extension before one is installed would stop that bridge on restart.
    expect(findScoutCommandRegistration("mesh")?.provider).toBeUndefined();
    expect(listScoutPrimaryCommands().some((c) => c.name === "mesh")).toBe(true);
    expect(renderScoutExtensionLines([])).toBe("");
  });

  test("a verb left to an extension says how to install it", () => {
    expect(missingScoutExtensionMessage({ name: "mesh", summary: "Mesh", provider: "extension", install: "Install it from oscout/scout." }))
      .toBe("scout mesh is provided by an extension that is not installed. Install it from oscout/scout.");
  });
});
