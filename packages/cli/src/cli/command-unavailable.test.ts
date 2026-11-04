import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { mutateScoutExtension } from "./extension-install.ts";
import { findScoutExtension } from "./extensions.ts";
import { findScoutCommandRegistration } from "./registry.ts";

const verb = "reserved-fixture";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "scout-reserved-")); dirs.push(dir);
  const home = join(dir, "home"), extensions = join(home, ".scout", "extensions"), bin = join(dir, "bin");
  mkdirSync(extensions, { recursive: true, mode: 0o700 }); mkdirSync(bin, { mode: 0o700 });
  const events = join(dir, "events"), preload = join(dir, "preload.ts");
  const record = `appendFileSync(${JSON.stringify(events)}, name + "\\n")`;
  writeFileSync(preload, `import {mock} from "bun:test"; import {appendFileSync} from "node:fs";
    import {SCOUT_COMMANDS} from ${JSON.stringify(resolve(import.meta.dir, "registry.ts"))};
    SCOUT_COMMANDS.push({name:${JSON.stringify(verb)}, summary:"Test-only reserved command", provider:"extension", install:"Repair the matching artifact."});
    const record = name => ${record};
    mock.module(${JSON.stringify(resolve(import.meta.dir, "broker-update.ts"))}, () => ({
      brokerUpdateDebugEnabled: () => false, ensureBrokerUptodate: async () => record("maintenance"),
    }));
    mock.module(${JSON.stringify(resolve(import.meta.dir, "scoutd.ts"))}, () => ({
      runNativeScoutdJson: async () => {record("lifecycle"); throw Error("forbidden native action");},
    }));
    mock.module(${JSON.stringify(resolve(import.meta.dir, "commands/ask.ts"))}, () => ({
      runAskWithOptions: async () => {record("implicit_ask"); console.log("implicit ask fixture");},
    }));
    mock.module(${JSON.stringify(resolve(import.meta.dir, "commands/index.ts"))}, () => ({
      loadScoutCommandHandler: async name => async () => {record("builtin:"+name); console.log("builtin fixture");},
    }));`);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENSCOUT|SCOUT)_/.test(key) && !["FORCE_COLOR", "CLICOLOR_FORCE", "NO_COLOR"].includes(key)));
  const env = { ...inherited, HOME: home, OPENSCOUT_EXTENSIONS_HOME: extensions, OPENSCOUT_BROKER_URL: "http://127.0.0.1:43110", PATH: bin + delimiter + (inherited.PATH ?? ""), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  // A PATH executable is deliberately present for every refusal case.
  writeFileSync(join(bin, `scout-${verb}`), `#!/bin/sh\nprintf 'path_lookup\\n' >> '${events}'\n`, { mode: 0o700 });
  const artifact = (name = verb, extra: Record<string, unknown> = {}) => {
    const source = join(dir, `source-${name}`); mkdirSync(source, { recursive: true, mode: 0o700 });
    writeFileSync(join(source, "extension.json"), JSON.stringify({ api: 1, version: "1.0.0", command: "run", ...extra }), { mode: 0o600 });
    writeFileSync(join(source, "run"), `#!/bin/sh\nprintf 'extension\\n' >> '${events}'\nprintf '%s\\n' "$SCOUT_OUTPUT" "$OPENSCOUT_BROKER_URL" "$@"\nexit 23\n`, { mode: 0o700 });
    return source;
  };
  const install = (name = verb, extra: Record<string, unknown> = {}) => mutateScoutExtension("install", name, artifact(name, extra), env);
  const run = async (args: string[], entry = "main.ts", selectedEnv: NodeJS.ProcessEnv = env) => {
    writeFileSync(events, "");
    const child = Bun.spawn([process.execPath, "--preload", preload, resolve(import.meta.dir, entry), ...args], { env: selectedEnv, cwd: dir, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr, events: readFileSync(events, "utf8").trim().split("\n").filter(Boolean) };
    } finally { clearTimeout(timer); await child.exited; }
  };
  return { dir, home, extensions, env, artifact, install, run };
}

for (const state of ["missing", "tombstoned", "refused", "incompatible", "corrupt", "wrong_instance"] as const) {
  test(`reserved ${state}: exact JSON/exit contract, no ask, PATH execution or lifecycle`, async () => {
    const f = fixture();
    if (state !== "missing") f.install();
    const target = join(f.extensions, verb);
    if (state === "tombstoned") mutateScoutExtension("remove", verb, undefined, f.env);
    if (state === "refused") chmodSync(join(target, "run"), 0o600);
    if (state === "incompatible") writeFileSync(join(target, "extension.json"), JSON.stringify({ api: 99, command: "run" }));
    if (state === "corrupt") rmSync(realpathSync(target), { recursive: true }); // dangling managed generation pointer
    if (state === "wrong_instance") writeFileSync(join(target, "extension.json"), JSON.stringify({ api: 1, command: "run", instance: "other" }));
    for (const json of [false, true]) {
      // A runnable implicit ask proves that dropping the reservation cannot hide behind a parse error.
      const result = await f.run([...(json ? ["--json"] : []), verb, "@fixture", "hello"]);
      expect(result.code, result.stderr).toBe(69);
      expect(result.stdout).toBe("");
      if (json) expect(JSON.parse(result.stderr)).toEqual({ schema: "scout.cli.command-unavailable/v1", error: "command_unavailable", command: verb, reason: state });
      else expect(result.stderr).toContain(`(${state})`);
      expect(result.events).toEqual([]);
    }
  });
}

test("absent reserved help refuses in discovery and dispatch, including aliases/global flags", async () => {
  const f = fixture();
  for (const args of [[verb, "--help"], ["--json", verb, "--help"], [verb, "--help", "--json"], ["help", verb], ["help", verb, "--json"], ["relay", verb, "--help", "--json"]]) {
    const result = await f.run(args);
    expect(result.code, result.stderr).toBe(69); expect(result.stdout).toBe(""); expect(result.events).toEqual([]);
    if (args.includes("--json")) expect(JSON.parse(result.stderr)).toEqual({ schema: "scout.cli.command-unavailable/v1", error: "command_unavailable", command: verb, reason: "missing" });
    else expect(result.stderr).toContain("(missing)");
  }
  // The bundled dispatcher also has its own catch, independent of main's discovery catch.
  const direct = await f.run([verb, "--json"], "main-dispatch.ts");
  expect(direct.code).toBe(69); expect(JSON.parse(direct.stderr).reason).toBe("missing"); expect(direct.events).toEqual([]);
});

test("forced color leaves JSON refusals unformatted in discovery and dispatch", async () => {
  const f = fixture();
  const expected = { schema: "scout.cli.command-unavailable/v1", error: "command_unavailable", command: verb, reason: "missing" };
  const cases = [
    { entry: "main.ts", args: [verb, "--help", "--json"] },
    // Any bare --json token selects refusal rendering, even after the argv delimiter.
    { entry: "main.ts", args: [verb, "--", "--json"] },
    { entry: "main-dispatch.ts", args: [verb, "--json"] },
  ];
  for (const { entry, args } of cases) {
    const result = await f.run(args, entry, { ...f.env, FORCE_COLOR: "1" });
    expect(result.code, result.stderr).toBe(69);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual(expected);
    expect(result.stderr).toBe(JSON.stringify(expected) + "\n");
    expect(result.events).toEqual([]);
  }
});

test("a valid reserved extension preserves argv, JSON context and foreground exit", async () => {
  const f = fixture(); f.install(verb, { instance: "prod" });
  const result = await f.run(["--json", verb, "status", "a b", "--literal=value"]);
  expect(result.code, result.stderr).toBe(23); expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toEqual(["json", "http://127.0.0.1:43110", "status", "a b", "--literal=value"]);
  expect(result.events).toEqual(["maintenance", "extension"]);
});

test("built-ins retain maintenance and cannot be overridden by valid extensions", async () => {
  const f = fixture(); f.install("env");
  const result = await f.run(["env"]);
  expect(result.code).toBe(0); expect(result.events).toEqual(["maintenance", "builtin:env"]);
  for (const name of ["app", "menu", "server", "web", "pair", "install"]) {
    expect(findScoutCommandRegistration(name)).toMatchObject({ name });
    expect(findScoutCommandRegistration(name)?.provider).toBeUndefined();
  }
});

test("unknown verbs retain the implicit ask and unknown-help behavior", async () => {
  const f = fixture();
  const ask = await f.run(["unregistered-fixture", "--to", "fixture", "hello"]);
  expect(ask.code).toBe(0); expect(ask.events).toEqual(["maintenance", "implicit_ask"]);
  const unknown = await f.run(["unregistered-fixture"]);
  expect(unknown.code).toBe(1); expect(unknown.events).toEqual(["maintenance"]);
  const help = await f.run(["unregistered-fixture", "--help"]);
  expect(help.code).toBe(1); expect(help.events).toEqual([]);
});

for (const damage of ["manifest", "json", "command", "pointer"] as const) {
  test(`a corrupt primary ${damage} blocks a valid legacy-home fallback`, () => {
    const f = fixture();
    const env = { HOME: f.home };
    mutateScoutExtension("install", verb, f.artifact(), env);
    const legacy = join(f.home, ".openscout", "extensions");
    mutateScoutExtension("install", verb, f.artifact(), { ...env, OPENSCOUT_EXTENSIONS_HOME: legacy });
    const target = join(f.extensions, verb);
    if (damage === "manifest") rmSync(join(target, "extension.json"));
    if (damage === "json") writeFileSync(join(target, "extension.json"), "{");
    if (damage === "command") rmSync(join(target, "run"));
    if (damage === "pointer") rmSync(realpathSync(target), { recursive: true });
    expect(findScoutExtension(verb, env)).toMatchObject({ root: f.extensions, refusalReason: "corrupt", refused: expect.any(String) });
  });
}

test("tombstones remain reserved and block legacy-home execution", async () => {
  const f = fixture();
  const env = { HOME: f.home };
  mutateScoutExtension("install", verb, f.artifact(), env);
  mutateScoutExtension("install", verb, f.artifact(), { ...env, OPENSCOUT_EXTENSIONS_HOME: join(f.home, ".openscout", "extensions") });
  mutateScoutExtension("remove", verb, undefined, env);
  expect(findScoutExtension(verb, env)).toMatchObject({ removed: true });
  const result = await f.run([verb, "--json"]);
  expect(result.code).toBe(69); expect(JSON.parse(result.stderr).reason).toBe("tombstoned"); expect(result.events).toEqual([]);
});

test("instance bindings are optional, canonical and checked before installer publication", () => {
  const f = fixture(); const source = f.artifact(verb, { instance: "other" });
  expect(() => mutateScoutExtension("install", verb, source, f.env)).toThrow("selected instance");
  expect(existsSync(join(f.extensions, verb))).toBe(false);
  mutateScoutExtension("install", verb, source, { ...f.env, OPENSCOUT_INSTANCE: "other" });
  expect(findScoutExtension(verb, { ...f.env, OPENSCOUT_INSTANCE: "other" })?.refused).toBeUndefined();
  expect(findScoutExtension(verb, f.env)?.refusalReason).toBe("wrong_instance");
  for (const instance of [null, "", 3, "production", "UPPER CASE"]) {
    writeFileSync(join(f.extensions, verb, "extension.json"), JSON.stringify({ api: 1, command: "run", instance }));
    expect(findScoutExtension(verb, f.env)?.refusalReason).toBe("corrupt");
  }
  // An artifact present only in another extension home is absent, not searched for or executed.
  expect(findScoutExtension(verb, { HOME: f.home, OPENSCOUT_EXTENSIONS_HOME: join(f.dir, "other-home") })).toBeUndefined();
});


test("explicit alternate-instance help refuses a prod-bound artifact without maintenance", async () => {
  const f = fixture(); f.install(verb, { instance: "prod" });
  const result = await f.run(["--instance", "other", verb, "--help", "--json"]);
  expect(result.code, result.stderr).toBe(69);
  expect(JSON.parse(result.stderr).reason).toBe("wrong_instance");
  expect(result.events).toEqual([]);
});

test("a matching alternate-instance artifact dispatches with its selected broker", async () => {
  const f = fixture();
  mutateScoutExtension("install", verb, f.artifact(verb, { instance: "other" }), { ...f.env, OPENSCOUT_INSTANCE: "other" });
  const result = await f.run(["--instance", "other", verb, "status"], "main.ts", { ...f.env, OPENSCOUT_BROKER_URL: undefined });
  expect(result.code, result.stderr).toBe(23);
  const [mode, broker, arg] = result.stdout.trim().split("\n");
  expect(mode).toBe("plain"); expect(broker).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(broker).not.toBe("http://127.0.0.1:43110"); expect(arg).toBe("status");
  expect(result.events).toEqual(["maintenance", "extension"]);
});

test("a mistyped command with no route gets unknown-command help, not ask validation", async () => {
  const f = fixture();
  const typo = await f.run(["stauts"]);
  expect(typo.code).toBe(1);
  expect(typo.stderr).toContain("unknown command: stauts");
  expect(typo.stderr).toContain("scout status");
  expect(typo.stderr).not.toContain("exactly one routing mode");
  const ask = await f.run(["review", "--to", "fixture", "this"]);
  expect(ask.code).toBe(0); expect(ask.events).toContain("implicit_ask");
});
