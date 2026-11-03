import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyCheckoutOpenScoutInstanceDefault,
  applyOpenScoutInstanceEnvironment,
  assertOpenScoutInstanceIsolation,
  checkoutOpenScoutInstanceName,
  claimOpenScoutInstance,
  entrypointSupportsOpenScoutInstances,
  OPENSCOUT_INSTANCE_AVOIDED_PORTS,
  readOpenScoutInstanceLedger,
  selectInstanceAwareEntrypoint,
  deriveOpenScoutInstanceLayout,
  deriveOpenScoutInstancePorts,
  findOpenScoutCheckout,
  findOpenScoutInstanceIsolationViolations,
  normalizeOpenScoutInstanceName,
  OPENSCOUT_PROD_PORTS,
  openScoutInstanceMeshRefusal,
  openScoutInstancePortBase,
  selectStatuslineOpenScoutInstance,
  buildUserSpawnEnvironment,
  listOpenScoutInstances,
  OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS,
  releaseOpenScoutInstance,
  selectCliOpenScoutInstance,
  buildMultiplexerServerEnvironment,
  repairOpenScoutInstanceRegistry,
  migrateLegacyOpenScoutInstanceLedger,
  openScoutInstanceRegistryDir,
} from "./instance.ts";
import { normalizeScoutInstanceName, scoutUserSpawnEnvironment } from "../../agent-sessions/src/scout-state-paths.ts";

// Not under /home: macOS mounts it with autofs, and every path lookup there
// costs milliseconds, which pushed this file past the test timeout.
const HOME = "/openscout-test-home/tester";
const base = { home: HOME, hostname: "Archie.local", platform: "linux" } as const;

describe("instance names", () => {
  test("unset, empty, default and production all mean prod", () => {
    for (const raw of [undefined, "", "  ", "default", "PROD", "production"]) {
      expect(normalizeOpenScoutInstanceName(raw)).toBe("prod");
    }
  });

  test("normalizes separators and case", () => {
    expect(normalizeOpenScoutInstanceName("Dev_Feature.X")).toBe("dev-feature-x");
  });

  test("rejects names that cannot be a directory or label segment", () => {
    expect(() => normalizeOpenScoutInstanceName("../etc")).toThrow("Invalid OPENSCOUT_INSTANCE");
    expect(() => normalizeOpenScoutInstanceName("a".repeat(41))).toThrow("Invalid OPENSCOUT_INSTANCE");
    expect(() => normalizeOpenScoutInstanceName("dev/x")).toThrow("Invalid OPENSCOUT_INSTANCE");
  });
});

describe("derivation table", () => {
  test("prod is exactly the legacy layout", () => {
    const layout = deriveOpenScoutInstanceLayout({ ...base, env: {} });
    expect(layout).toMatchObject({
      name: "prod",
      isProd: true,
      root: null,
      openscoutHome: `${HOME}/.openscout`,
      controlHome: `${HOME}/.openscout/control-plane`,
      supportDirectory: `${HOME}/.local/share/openscout`,
      relayHub: `${HOME}/.openscout/relay`,
      scoutHome: `${HOME}/.scout`,
      pairingHome: `${HOME}/.scout/pairing`,
      brokerSocketPath: `${HOME}/.local/share/openscout/runtime/broker.sock`,
      serviceLabel: "app.openscout",
      systemdUnitName: "scout.service",
      nodeQualifier: "archie",
      nodeId: null,
      meshAllowed: true,
    });
    expect(layout.ports).toEqual({ ...OPENSCOUT_PROD_PORTS });
  });

  test("prod on macOS keeps Application Support", () => {
    const layout = deriveOpenScoutInstanceLayout({ ...base, platform: "darwin", env: {} });
    expect(layout.supportDirectory).toBe(`${HOME}/Library/Application Support/OpenScout`);
  });

  test("prod honours XDG_DATA_HOME", () => {
    const layout = deriveOpenScoutInstanceLayout({ ...base, env: { XDG_DATA_HOME: "/data" } });
    expect(layout.supportDirectory).toBe("/data/openscout");
  });

  test("a named instance derives everything under one root, identically on macOS and Linux", () => {
    for (const platform of ["linux", "darwin"]) {
      const layout = deriveOpenScoutInstanceLayout({ ...base, platform, env: { OPENSCOUT_INSTANCE: "dev" } });
      const root = `${HOME}/.openscout/instances/dev`;
      expect(layout).toMatchObject({
        name: "dev",
        isProd: false,
        root,
        openscoutHome: root,
        controlHome: `${root}/control-plane`,
        supportDirectory: `${root}/support`,
        relayHub: `${root}/relay`,
        scoutHome: root,
        pairingHome: `${root}/pairing`,
        localEdgeDirectory: `${root}/local-edge`,
        brokerSocketPath: `${root}/support/runtime/broker.sock`,
        appSocketPath: `${root}/run/scout-app.sock`,
        probesSocketPath: `${root}/run/scoutd-probes.sock`,
        nodeName: "archie-dev",
        nodeQualifier: "archie-dev",
        nodeId: "archie-dev-openscout",
        serviceLabel: "app.openscout.dev",
        systemdUnitName: "scout-dev.service",
        meshAllowed: false,
      });
    }
  });

  test("OPENSCOUT_INSTANCE_ROOT relocates the whole instance", () => {
    const layout = deriveOpenScoutInstanceLayout({
      ...base,
      env: { OPENSCOUT_INSTANCE: "ci", OPENSCOUT_INSTANCE_ROOT: "/scratch/ci" },
    });
    expect(layout.controlHome).toBe("/scratch/ci/control-plane");
    expect(layout.pairingHome).toBe("/scratch/ci/pairing");
  });
});

describe("port blocks", () => {
  test("dev owns the first block; offsets mirror prod", () => {
    const ports = deriveOpenScoutInstancePorts("dev", {});
    expect(ports.broker).toBe(24400);
    for (const [key, prodPort] of Object.entries(OPENSCOUT_PROD_PORTS)) {
      expect(ports[key as keyof typeof ports] - ports.broker).toBe(prodPort - OPENSCOUT_PROD_PORTS.broker);
    }
  });

  test("other names hash deterministically into blocks that never touch prod or worktree bands", () => {
    const prodPorts = new Set<number>(Object.values(OPENSCOUT_PROD_PORTS));
    const seen = new Map<string, number>();
    for (let index = 0; index < 200; index += 1) {
      const name = `dev-worktree-${index}`;
      const portBase = openScoutInstancePortBase(name, {});
      expect(openScoutInstancePortBase(name, {})).toBe(portBase);
      expect(portBase).toBeGreaterThanOrEqual(24450);
      expect((portBase - 24400) % 50).toBe(0);
      for (const port of Object.values(deriveOpenScoutInstancePorts(name, {}))) {
        expect(prodPorts.has(port)).toBe(false);
        // Below the Linux (32768+) and macOS (49152+) ephemeral ranges.
        expect(port).toBeGreaterThanOrEqual(24400);
        expect(port).toBeLessThan(32768);
      }
      seen.set(name, portBase);
    }
    expect(new Set(seen.values()).size).toBeGreaterThan(40);
  });

  test("OPENSCOUT_INSTANCE_PORT_BASE pins a block", () => {
    expect(deriveOpenScoutInstancePorts("dev-a", { OPENSCOUT_INSTANCE_PORT_BASE: "50000" }).web).toBe(50010);
  });
});

describe("applyOpenScoutInstanceEnvironment", () => {
  test("prod pins OPENSCOUT_INSTANCE and keeps every env override", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin", OPENSCOUT_BROKER_PORT: "45000" };
    const result = applyOpenScoutInstanceEnvironment(env, base);
    expect(result.applied).toEqual([]);
    expect(env).toEqual({ PATH: "/bin", OPENSCOUT_BROKER_PORT: "45000", OPENSCOUT_INSTANCE: "prod" });
  });

  test("a non-prod instance overwrites every derived key; ambient values never win", () => {
    const env: Record<string, string | undefined> = {
      OPENSCOUT_INSTANCE: "Dev",
      OPENSCOUT_WEB_PORT: "47000",
      OPENSCOUT_BROKER_PORT: "43110",
      OPENSCOUT_CONTROL_HOME: `${HOME}/.openscout/control-plane`,
      OPENSCOUT_BROKER_URL: "http://127.0.0.1:43110",
      OPENSCOUT_BROKER_INTERNAL_URL: "https://lan.example:43110",
      OPENSCOUT_SERVICE_LABEL: "app.openscout",
      OPENSCOUT_PAIRING_DIR: `${HOME}/.scout/pairing`,
    };
    applyOpenScoutInstanceEnvironment(env, base);
    expect(env).toMatchObject({
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_HOME: `${HOME}/.openscout/instances/dev`,
      OPENSCOUT_CONTROL_HOME: `${HOME}/.openscout/instances/dev/control-plane`,
      OPENSCOUT_SUPPORT_DIRECTORY: `${HOME}/.openscout/instances/dev/support`,
      OPENSCOUT_PAIRING_HOME: `${HOME}/.openscout/instances/dev/pairing`,
      OPENSCOUT_SCOUT_HOME: `${HOME}/.openscout/instances/dev`,
      OPENSCOUT_BROKER_SOCKET_PATH: `${HOME}/.openscout/instances/dev/support/runtime/broker.sock`,
      OPENSCOUT_BROKER_PORT: "24400",
      OPENSCOUT_WEB_PORT: "24410",
      OPENSCOUT_PAIRING_PORT: "24420",
      OPENSCOUT_NODE_QUALIFIER: "archie-dev",
      OPENSCOUT_NODE_ID: "archie-dev-openscout",
      OPENSCOUT_SERVICE_LABEL: "app.openscout.dev",
    });
    expect(env.OPENSCOUT_BROKER_URL).toBeUndefined();
    expect(env.OPENSCOUT_BROKER_INTERNAL_URL).toBeUndefined();
    expect(env.OPENSCOUT_PAIRING_DIR).toBeUndefined();
    expect(findOpenScoutInstanceIsolationViolations({ ...base, env })).toEqual([]);
  });

  test("a broker URL that targets the instance's own broker is kept (a broker → web child)", () => {
    const env: Record<string, string | undefined> = {
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_BROKER_INTERNAL_URL: "http://127.0.0.1:24400",
    };
    applyOpenScoutInstanceEnvironment(env, base);
    expect(env.OPENSCOUT_BROKER_INTERNAL_URL).toBe("http://127.0.0.1:24400");
  });

  test("non-prod customization goes through OPENSCOUT_INSTANCE_* or the instance's config.json", () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-instance-config-"));
    try {
      mkdirSync(join(home, ".openscout", "instances", "dev"), { recursive: true });
      writeFileSync(join(home, ".openscout", "instances", "dev", "config.json"), JSON.stringify({ ports: { web: 24477 } }));
      const env: Record<string, string | undefined> = { OPENSCOUT_INSTANCE: "dev", OPENSCOUT_WEB_PORT: "9999" };
      applyOpenScoutInstanceEnvironment(env, { ...base, home });
      expect(env.OPENSCOUT_WEB_PORT).toBe("24477");
      const based: Record<string, string | undefined> = { OPENSCOUT_INSTANCE: "dev", OPENSCOUT_INSTANCE_PORT_BASE: "29000" };
      applyOpenScoutInstanceEnvironment(based, { ...base, home });
      expect(based.OPENSCOUT_BROKER_PORT).toBe("29000");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fences a non-prod instance off the mesh unless opted in", () => {
    const env: Record<string, string | undefined> = {
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_MESH_SEEDS: "https://peer:43110",
      OPENSCOUT_MESH_SHARED_TOKEN: "prod-secret",
      OPENSCOUT_ADVERTISE_SCOPE: "mesh",
    };
    const result = applyOpenScoutInstanceEnvironment(env, base);
    expect(env.OPENSCOUT_MESH_SEEDS).toBe("");
    expect(env.OPENSCOUT_MESH_SHARED_TOKEN).toBeUndefined();
    expect(env.OPENSCOUT_ADVERTISE_SCOPE).toBe("local");
    expect(env.OPENSCOUT_NETWORK_DISCOVERY_ENABLED).toBe("0");
    expect(env.OPENSCOUT_MESH_RENDEZVOUS_URL).toBe("false");
    expect(result.meshFenced).toContain("OPENSCOUT_MESH_SHARED_TOKEN");
    expect(openScoutInstanceMeshRefusal(env)).toContain("OPENSCOUT_INSTANCE_MESH=1");

    const optedIn: Record<string, string | undefined> = {
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_INSTANCE_MESH: "1",
      OPENSCOUT_MESH_SEEDS: "https://peer:24400",
      OPENSCOUT_PUSH_RELAY_SESSION: "osn_session_x",
    };
    applyOpenScoutInstanceEnvironment(optedIn, base);
    expect(optedIn.OPENSCOUT_MESH_SEEDS).toBe("https://peer:24400");
    expect(optedIn.OPENSCOUT_PUSH_RELAY_SESSION).toBeUndefined();
    expect(openScoutInstanceMeshRefusal(optedIn)).toBeNull();
    expect(openScoutInstanceMeshRefusal({})).toBeNull();
  });
});

describe("statusline targets prod unless asked otherwise", () => {
  test("an inherited dev instance env and client pointer are dropped", () => {
    const env: Record<string, string | undefined> = { OPENSCOUT_INSTANCE: "dev", OPENSCOUT_CLIENT_INSTANCE: "dev" };
    applyOpenScoutInstanceEnvironment(env, base);
    expect(selectStatuslineOpenScoutInstance(env)).toBe("prod");
    expect(env.OPENSCOUT_INSTANCE).toBe("prod");
    expect(env.OPENSCOUT_SUPPORT_DIRECTORY).toBeUndefined();
    expect(env.OPENSCOUT_CLIENT_INSTANCE).toBeUndefined();
  });

  test("an explicit --instance flag or OPENSCOUT_STATUSLINE_INSTANCE wins", () => {
    expect(selectStatuslineOpenScoutInstance({ OPENSCOUT_INSTANCE: "dev", OPENSCOUT_INSTANCE_EXPLICIT: "1" })).toBe("dev");
    expect(selectStatuslineOpenScoutInstance({ OPENSCOUT_STATUSLINE_INSTANCE: "dev-x" })).toBe("dev-x");
  });
});

describe("isolation rails", () => {
  test("a clean instance passes and prod is never checked", () => {
    const env: Record<string, string | undefined> = { OPENSCOUT_INSTANCE: "dev" };
    applyOpenScoutInstanceEnvironment(env, base);
    expect(findOpenScoutInstanceIsolationViolations({ ...base, env })).toEqual([]);
    expect(findOpenScoutInstanceIsolationViolations({
      ...base,
      env: { OPENSCOUT_BROKER_PORT: "43110", OPENSCOUT_CONTROL_HOME: `${HOME}/.openscout/control-plane` },
    })).toEqual([]);
  });

  test("refuses prod ports, prod directories, prod's service and prod's identity in an effective config", () => {
    // What reaches the rails without apply: a service config built from
    // explicit values (systemd install, broker extras) or OPENSCOUT_INSTANCE_* knobs.
    const env: Record<string, string | undefined> = {
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_BROKER_PORT: "43110",
      OPENSCOUT_PAIRING_PORT: "43129",
      OPENSCOUT_CONTROL_HOME: `${HOME}/.openscout/control-plane`,
      OPENSCOUT_SUPPORT_DIRECTORY: `${HOME}/.local/share/openscout`,
      OPENSCOUT_PAIRING_HOME: `${HOME}/.scout/pairing`,
      OPENSCOUT_HOME: `${HOME}/.openscout`,
      OPENSCOUT_BROKER_URL: "http://127.0.0.1:43110",
      OPENSCOUT_SERVICE_LABEL: "app.openscout",
      OPENSCOUT_NODE_QUALIFIER: "archie",
    };
    const joined = findOpenScoutInstanceIsolationViolations({ ...base, env }).join("\n");
    expect(joined).toContain("OPENSCOUT_BROKER_PORT=43110 is one of prod's ports");
    expect(joined).toContain("pairing relay (OPENSCOUT_PAIRING_PORT+1)=43130");
    expect(joined).toContain("OPENSCOUT_CONTROL_HOME");
    expect(joined).toContain("OPENSCOUT_SUPPORT_DIRECTORY");
    expect(joined).toContain("OPENSCOUT_PAIRING_HOME");
    expect(joined).toContain("OPENSCOUT_HOME=");
    expect(joined).toContain("targets prod's broker");
    expect(joined).toContain("OPENSCOUT_SERVICE_LABEL=app.openscout is prod's service");
    expect(joined).toContain("OPENSCOUT_NODE_QUALIFIER=archie is prod's node identity");
    expect(() => assertOpenScoutInstanceIsolation("the broker", { ...base, env }))
      .toThrow('Refusing to start the broker for OpenScout instance "dev"');
  });

  test("OPENSCOUT_INSTANCE_* knobs that land on prod are refused after apply", () => {
    const env: Record<string, string | undefined> = {
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_INSTANCE_PORT_BASE: "43110",
      OPENSCOUT_INSTANCE_ROOT: `${HOME}/.scout`,
    };
    applyOpenScoutInstanceEnvironment(env, base);
    const joined = findOpenScoutInstanceIsolationViolations({ ...base, env }).join("\n");
    expect(joined).toContain("OPENSCOUT_BROKER_PORT=43110 is one of prod's ports");
    expect(joined).toContain("OPENSCOUT_HOME=");
  });

  test("subdirectories of prod's directories are refused; the instances tree is not", () => {
    const env = {
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_RELAY_HUB: `${HOME}/.scout/pairing/relay`,
      OPENSCOUT_CONTROL_HOME: `${HOME}/.openscout/instances/dev/cp`,
    };
    const violations = findOpenScoutInstanceIsolationViolations({ ...base, env });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("OPENSCOUT_RELAY_HUB");
  });
});

describe("source checkout defaults", () => {
  function makeCheckout(kind: "main" | "worktree", folder: string): string {
    const root = join(mkdtempSync(join(tmpdir(), "openscout-instance-checkout-")), folder);
    mkdirSync(join(root, "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "runtime", "src", "instance.ts"), "");
    if (kind === "main") mkdirSync(join(root, ".git"));
    else writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    return root;
  }

  test("main checkout → dev, linked worktree → dev-<folder>", () => {
    const main = makeCheckout("main", "openscout");
    const worktree = makeCheckout("worktree", "openscout-instances");
    try {
      const mainCheckout = findOpenScoutCheckout(join(main, "packages", "runtime", "src"));
      expect(mainCheckout).toEqual({ root: main, isLinkedWorktree: false });
      expect(checkoutOpenScoutInstanceName(mainCheckout!)).toBe("dev");
      const linked = findOpenScoutCheckout(join(worktree, "packages", "runtime", "src"));
      expect(checkoutOpenScoutInstanceName(linked!)).toBe("dev-openscout-instances");
    } finally {
      rmSync(join(main, ".."), { recursive: true, force: true });
      rmSync(join(worktree, ".."), { recursive: true, force: true });
    }
  });

  test("an explicit instance always wins; outside a checkout nothing changes", () => {
    const main = makeCheckout("main", "openscout");
    const moduleDir = join(main, "packages", "runtime", "src");
    const home = join(main, "..", "home");
    const outside = join(main, "..", "outside");
    mkdirSync(outside);
    try {
      const unset: Record<string, string | undefined> = {};
      expect(applyCheckoutOpenScoutInstanceDefault(moduleDir, unset, home)).toBe("dev");
      expect(unset.OPENSCOUT_INSTANCE).toBe("dev");

      const explicit: Record<string, string | undefined> = { OPENSCOUT_INSTANCE: "prod" };
      expect(applyCheckoutOpenScoutInstanceDefault(moduleDir, explicit, home)).toBeNull();
      expect(explicit.OPENSCOUT_INSTANCE).toBe("prod");

      // Only an unset OPENSCOUT_INSTANCE takes the default; markers don't matter.
      expect(applyCheckoutOpenScoutInstanceDefault(moduleDir, { OPENSCOUT_PARENT_PID: String(process.ppid) }, home)).toBe("dev");
      expect(applyCheckoutOpenScoutInstanceDefault(moduleDir, { OPENSCOUT_INSTANCE: "  " }, home)).toBe("dev");

      // This fixture has no checkout within its own search scope, even when
      // the harness puts TMPDIR inside a real Scout checkout.
      expect(findOpenScoutCheckout(moduleDir, main)).toEqual({ root: main, isLinkedWorktree: false });
      expect(findOpenScoutCheckout(outside, outside)).toBeNull();
      const outsideEnv: Record<string, string | undefined> = {};
      expect(applyCheckoutOpenScoutInstanceDefault(outside, outsideEnv, home, outside)).toBeNull();
      expect(outsideEnv).toEqual({});
      expect(() => findOpenScoutCheckout(moduleDir, outside)).toThrow("must contain");
    } finally {
      rmSync(join(main, ".."), { recursive: true, force: true });
    }
  });
});


describe("services pin, user-facing spawns strip, clients follow a pointer", () => {
  function checkoutDir(): string {
    const root = join(mkdtempSync(join(tmpdir(), "openscout-instance-model-")), "openscout");
    mkdirSync(join(root, "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "runtime", "src", "instance.ts"), "");
    mkdirSync(join(root, ".git"));
    return root;
  }

  test("(b) an agent shell under a dev broker reaches dev through the client pointer", () => {
    const broker: Record<string, string | undefined> = { OPENSCOUT_INSTANCE: "dev", PATH: "/bin" };
    applyOpenScoutInstanceEnvironment(broker, base);
    const agent = buildUserSpawnEnvironment(broker);
    for (const key of OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS.filter((key) => key !== "OPENSCOUT_CLIENT_INSTANCE")) {
      expect(agent[key]).toBeUndefined();
    }
    expect(agent.OPENSCOUT_CLIENT_INSTANCE).toBe("dev");
    expect(agent.PATH).toBe("/bin");
    // `scout ask` in that shell: the CLI follows the pointer to dev's broker.
    expect(selectCliOpenScoutInstance(agent)).toBe("dev");
    applyOpenScoutInstanceEnvironment(agent, base);
    expect(agent.OPENSCOUT_BROKER_PORT).toBe("24400");
    // An explicit choice beats the pointer.
    expect(selectCliOpenScoutInstance({ OPENSCOUT_CLIENT_INSTANCE: "dev", OPENSCOUT_INSTANCE: "prod" })).toBe("prod");
  });

  test("(c) `bun run dev` from a prod agent shell becomes dev with dev ports, even with a prod broker URL", () => {
    const root = checkoutDir();
    try {
      const prodBroker: Record<string, string | undefined> = {
        OPENSCOUT_BROKER_PORT: "43110",
        OPENSCOUT_CONTROL_HOME: `${HOME}/.openscout/control-plane`,
      };
      applyOpenScoutInstanceEnvironment(prodBroker, base);
      const shell = { ...buildUserSpawnEnvironment(prodBroker), OPENSCOUT_BROKER_URL: "http://127.0.0.1:43110" };
      // Service bootstraps never read the client pointer.
      expect(applyCheckoutOpenScoutInstanceDefault(join(root, "packages", "runtime", "src"), shell, HOME)).toBe("dev");
      applyOpenScoutInstanceEnvironment(shell, base);
      expect(shell.OPENSCOUT_BROKER_PORT).toBe("24400");
      expect(shell.OPENSCOUT_BROKER_URL).toBeUndefined();
      expect(findOpenScoutInstanceIsolationViolations({ ...base, env: shell })).toEqual([]);
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  test("(d)/N2 an explicit OPENSCOUT_INSTANCE=prod inside a checkout stays prod with its overrides", () => {
    const root = checkoutDir();
    try {
      const env: Record<string, string | undefined> = { OPENSCOUT_INSTANCE: "prod", OPENSCOUT_BROKER_PORT: "45001", OPENSCOUT_CLIENT_INSTANCE: "dev" };
      expect(applyCheckoutOpenScoutInstanceDefault(join(root, "packages", "runtime", "src"), env, HOME)).toBeNull();
      applyOpenScoutInstanceEnvironment(env, base);
      expect(env.OPENSCOUT_INSTANCE).toBe("prod");
      expect(env.OPENSCOUT_BROKER_PORT).toBe("45001");
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  test("N3: a forking wrapper (sh without exec) under a pinned service stays on the pinned instance", () => {
    const root = checkoutDir();
    const script = join(root, "packages", "runtime", "src", "probe.ts");
    writeFileSync(script, `import { applyCheckoutOpenScoutInstanceDefault } from ${JSON.stringify(join(import.meta.dir, "instance.ts"))};
applyCheckoutOpenScoutInstanceDefault(import.meta.dir, process.env, "/nonexistent-home");
console.log(process.env.OPENSCOUT_INSTANCE);
`);
    try {
      // The unit/plist pins OPENSCOUT_INSTANCE; a wrapper shell forks (no exec).
      const wrapper = `"${process.execPath}" "${script}"; true`;
      const result = Bun.spawnSync(["sh", "-c", wrapper], {
        env: { PATH: process.env.PATH, OPENSCOUT_INSTANCE: "prod", OPENSCOUT_INSTANCE_REGISTRY: join(root, "registry") },
      });
      expect(result.stdout.toString().trim()).toBe("prod");
      const unpinned = Bun.spawnSync(["sh", "-c", wrapper], {
        env: { PATH: process.env.PATH, OPENSCOUT_INSTANCE_REGISTRY: join(root, "registry") },
      });
      expect(unpinned.stdout.toString().trim()).toBe("dev");
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });
});

describe("checkout instance names are unique per checkout", () => {
  function checkout(folder: string, linked: boolean): string {
    const root = join(mkdtempSync(join(tmpdir(), "openscout-instance-name-")), folder);
    mkdirSync(join(root, "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "runtime", "src", "instance.ts"), "");
    if (linked) writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    else mkdirSync(join(root, ".git"));
    return root;
  }

  test("a worktree folder named dev does not alias the main checkout", () => {
    expect(checkoutOpenScoutInstanceName({ root: "/x/dev", isLinkedWorktree: true })).toBe("dev-dev");
    expect(checkoutOpenScoutInstanceName({ root: "/x/openscout", isLinkedWorktree: false })).toBe("dev");
  });

  test("a second clone gets <name>-<hash> once the first owns the name", () => {
    const first = checkout("openscout", false);
    const second = checkout("openscout", false);
    const dir = mkdtempSync(join(tmpdir(), "openscout-instance-ledger-"));
    const env = { OPENSCOUT_INSTANCE_REGISTRY: join(dir, "registry") };
    try {
      const firstEnv: Record<string, string | undefined> = { ...env };
      expect(applyCheckoutOpenScoutInstanceDefault(join(first, "packages", "runtime", "src"), firstEnv, HOME)).toBe("dev");
      const secondEnv: Record<string, string | undefined> = { ...env };
      const name = applyCheckoutOpenScoutInstanceDefault(join(second, "packages", "runtime", "src"), secondEnv, HOME);
      expect(name).toMatch(/^dev-[0-9a-f]{4}$/);
      // The first checkout keeps its name.
      expect(applyCheckoutOpenScoutInstanceDefault(join(first, "packages", "runtime", "src"), { ...env }, HOME)).toBe("dev");
    } finally {
      for (const path of [first, second]) rmSync(join(path, ".."), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("instance-aware entrypoints", () => {
  test("a non-prod instance skips a stale pre-instance build; prod takes the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "openscout-instance-entry-"));
    try {
      const stale = join(dir, "stale.mjs");
      const fresh = join(dir, "fresh.mjs");
      const source = join(dir, "pairing-runtime-controller.ts");
      writeFileSync(stale, "console.log('old build')\n");
      writeFileSync(fresh, "const k = 'OPENSCOUT_INSTANCE_MESH';\n");
      writeFileSync(source, "");
      expect(entrypointSupportsOpenScoutInstances(stale)).toBe(false);
      expect(entrypointSupportsOpenScoutInstances(fresh)).toBe(true);
      expect(selectInstanceAwareEntrypoint([stale, fresh], {})).toBe(stale);
      expect(selectInstanceAwareEntrypoint([stale, fresh], { OPENSCOUT_INSTANCE: "dev" })).toBe(fresh);
      expect(selectInstanceAwareEntrypoint([stale, source], { OPENSCOUT_INSTANCE: "dev" })).toBe(source);
      expect(selectInstanceAwareEntrypoint([stale], { OPENSCOUT_INSTANCE: "dev" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 4: user spawns keep prod's overrides", () => {
  test("H1: a prod service on override ports keeps them in its agents; non-prod still strips", () => {
    const prod: Record<string, string | undefined> = {
      OPENSCOUT_INSTANCE: "prod",
      OPENSCOUT_BROKER_PORT: "45555",
      OPENSCOUT_BROKER_URL: "http://127.0.0.1:45555",
      OPENSCOUT_CONTROL_HOME: "/tmp/live-pass/control",
      OPENSCOUT_SUPPORT_DIRECTORY: "/tmp/live-pass/support",
      OPENSCOUT_RELAY_HUB: "/tmp/live-pass/relay",
      OPENSCOUT_PARENT_PID: "1",
      OPENSCOUT_SERVICE_LABEL: "app.openscout",
      OPENSCOUT_BROKER_SERVICE_MODE: "prod",
    };
    const agent = buildUserSpawnEnvironment(prod);
    expect(agent).toMatchObject({
      OPENSCOUT_CLIENT_INSTANCE: "prod",
      OPENSCOUT_BROKER_PORT: "45555",
      OPENSCOUT_BROKER_URL: "http://127.0.0.1:45555",
      OPENSCOUT_CONTROL_HOME: "/tmp/live-pass/control",
      OPENSCOUT_SUPPORT_DIRECTORY: "/tmp/live-pass/support",
      OPENSCOUT_RELAY_HUB: "/tmp/live-pass/relay",
    });
    for (const key of ["OPENSCOUT_INSTANCE", "OPENSCOUT_PARENT_PID", "OPENSCOUT_SERVICE_LABEL", "OPENSCOUT_BROKER_SERVICE_MODE"]) {
      expect(agent[key]).toBeUndefined();
    }
    // `scout` in that agent reaches the override broker, not 43110.
    selectCliOpenScoutInstance(agent);
    applyOpenScoutInstanceEnvironment(agent, base);
    expect(agent.OPENSCOUT_BROKER_PORT).toBe("45555");

    const dev = buildUserSpawnEnvironment({ OPENSCOUT_INSTANCE: "dev", OPENSCOUT_BROKER_PORT: "24400" });
    expect(dev.OPENSCOUT_BROKER_PORT).toBeUndefined();
    expect(dev.OPENSCOUT_CLIENT_INSTANCE).toBe("dev");
    // The server env for a multiplexer has no instance key at all.
    expect(buildMultiplexerServerEnvironment({ ...prod, PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  test("a prod user spawn drops the runtime package dir and every OPENSCOUT_INSTANCE_* knob", () => {
    const prod = {
      OPENSCOUT_INSTANCE: "prod",
      OPENSCOUT_RUNTIME_PACKAGE_DIR: "/opt/openscout/runtime",
      OPENSCOUT_INSTANCE_ROOT: "/tmp/elsewhere",
      OPENSCOUT_INSTANCE_PORT_BASE: "29900",
      OPENSCOUT_INSTANCE_MESH: "1",
      OPENSCOUT_BROKER_PORT: "43110",
      PATH: "/bin",
    };
    const agent = buildUserSpawnEnvironment(prod);
    for (const key of [
      "OPENSCOUT_INSTANCE",
      "OPENSCOUT_RUNTIME_PACKAGE_DIR",
      "OPENSCOUT_INSTANCE_ROOT",
      "OPENSCOUT_INSTANCE_PORT_BASE",
      "OPENSCOUT_INSTANCE_MESH",
    ]) {
      expect(agent[key]).toBeUndefined();
    }
    expect(agent).toMatchObject({ OPENSCOUT_CLIENT_INSTANCE: "prod", OPENSCOUT_BROKER_PORT: "43110", PATH: "/bin" });
    expect(scoutUserSpawnEnvironment(prod)).toEqual(agent as NodeJS.ProcessEnv);
  });

  test("an invalid spawner instance warns and falls back to the prod pointer", () => {
    expect(buildUserSpawnEnvironment({ OPENSCOUT_INSTANCE: "../bad" }).OPENSCOUT_CLIENT_INSTANCE).toBe("prod");
  });

  test("agent-sessions mirrors the runtime normalizer and strip semantics", () => {
    for (const raw of ["Dev_X", "dev.feature", " PROD ", "default", "", "dev-a", "a".repeat(41), "../x"]) {
      let runtime: string | null;
      try {
        runtime = normalizeOpenScoutInstanceName(raw);
      } catch {
        runtime = null;
      }
      expect(normalizeScoutInstanceName(raw)).toBe(runtime);
    }
    const prod = { OPENSCOUT_INSTANCE: "prod", OPENSCOUT_BROKER_PORT: "45555", OPENSCOUT_PARENT_PID: "1" };
    expect(scoutUserSpawnEnvironment(prod)).toEqual(buildUserSpawnEnvironment(prod) as NodeJS.ProcessEnv);
    const dev = { OPENSCOUT_INSTANCE: "Dev_X", OPENSCOUT_BROKER_PORT: "24400" };
    expect(scoutUserSpawnEnvironment(dev)).toEqual(buildUserSpawnEnvironment(dev) as NodeJS.ProcessEnv);
  });
});

describe("round 4: non-prod overwrite covers host, URLs by host+port and secondary homes", () => {
  test("broker host, a same-port URL on another host and chat/zellij/jetstream homes are not inherited", () => {
    const env: Record<string, string | undefined> = {
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_BROKER_HOST: "192.168.1.5",
      OPENSCOUT_BROKER_URL: "http://192.168.1.5:24400",
      OPENSCOUT_BROKER_INTERNAL_URL: "http://127.0.0.1:24400",
      OPENSCOUT_CHAT_HOME: `${HOME}/.openscout/chat`,
      OPENSCOUT_ZELLIJ_SOCKET_DIR: `${HOME}/.openscout/zellij-sockets`,
      OPENSCOUT_JETSTREAM_HOME: `${HOME}/.local/share/openscout/jetstream`,
    };
    applyOpenScoutInstanceEnvironment(env, base);
    expect(env.OPENSCOUT_BROKER_HOST).toBeUndefined();
    expect(env.OPENSCOUT_BROKER_URL).toBeUndefined();
    expect(env.OPENSCOUT_BROKER_INTERNAL_URL).toBe("http://127.0.0.1:24400");
    expect(env.OPENSCOUT_CHAT_HOME).toBeUndefined();
    expect(env.OPENSCOUT_ZELLIJ_SOCKET_DIR).toBeUndefined();
    expect(env.OPENSCOUT_JETSTREAM_HOME).toBeUndefined();
    expect(findOpenScoutInstanceIsolationViolations({ ...base, env })).toEqual([]);
  });
});


describe("instance registry (slots + claims)", () => {
  function registry(): { env: Record<string, string | undefined>; dir: string; home: string } {
    const home = mkdtempSync(join(tmpdir(), "openscout-registry-"));
    const dir = join(home, ".openscout", "instances");
    return { env: { OPENSCOUT_INSTANCE_REGISTRY: dir }, dir, home };
  }
  const claimScript = (home: string) => {
    const script = join(home, "claim.ts");
    writeFileSync(script, `import { claimOpenScoutInstance } from ${JSON.stringify(join(import.meta.dir, "instance.ts"))};
const entry = claimOpenScoutInstance(process.argv[2]!, process.env, ${JSON.stringify(home)});
console.log(JSON.stringify(entry));
`);
    return script;
  };

  test("thirty names claim thirty distinct blocks, none holding a well-known port; claims are stable", () => {
    const { env, home } = registry();
    try {
      const bases = new Map<string, number>();
      for (let index = 0; index < 30; index += 1) {
        const name = `dev-feature-${index}`;
        bases.set(name, claimOpenScoutInstance(name, env, home)!.portBase);
      }
      expect(new Set(bases.values()).size).toBe(30);
      for (const portBase of bases.values()) {
        expect(portBase).not.toBe(24400);
        for (const avoided of OPENSCOUT_INSTANCE_AVOIDED_PORTS) {
          expect(avoided >= portBase && avoided < portBase + 50).toBe(false);
        }
      }
      const view = readOpenScoutInstanceLedger(env, home);
      for (const [name, portBase] of bases) {
        expect(view.instances[name]!.portBase).toBe(portBase);
        expect(view.slots![portBase]).toBe(name);
        expect(claimOpenScoutInstance(name, env, home)!.portBase).toBe(portBase);
        expect(deriveOpenScoutInstanceLayout({ ...base, home, env: { ...env, OPENSCOUT_INSTANCE: name } }).ports.broker).toBe(portBase);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wx race: 3 rounds of 35 concurrent claimers never share or lose a block (~112 usable blocks)", async () => {
    const { env, home } = registry();
    try {
      const script = claimScript(home);
      for (let round = 0; round < 3; round += 1) {
        const names = Array.from({ length: 35 }, (_, index) => `dev-race-${round}-${index}`);
        const children = names.map((name) => Bun.spawn([process.execPath, script, name], {
          env: { ...process.env, NODE_ENV: "", ...env },
          stdout: "pipe",
          stderr: "pipe",
        }));
        const codes = await Promise.all(children.map((child) => child.exited));
        const failures = await Promise.all(children.map(async (child, index) =>
          codes[index] === 0 ? null : `${names[index]}: ${await new Response(child.stderr).text()}`));
        expect(failures.filter(Boolean)).toEqual([]);
      }
      const view = readOpenScoutInstanceLedger(env, home);
      expect(Object.keys(view.instances)).toHaveLength(105);
      const bases = Object.values(view.instances).map((entry) => entry.portBase);
      expect(new Set(bases).size).toBe(105);
      for (const [name, entry] of Object.entries(view.instances)) expect(view.slots![entry.portBase]).toBe(name);
      expect(Object.keys(view.slots!)).toHaveLength(105);
      // Past capacity, a claim fails with the commands that free a block.
      for (let index = 0; index < 20; index += 1) {
        try {
          claimOpenScoutInstance(`dev-overflow-${index}`, env, home);
        } catch (error) {
          expect(String(error)).toContain("scout instance release <name>");
          return;
        }
      }
      throw new Error("expected the registry to run out of blocks");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("a stalled (SIGSTOPped) claimer cannot clobber a block another instance took meanwhile", async () => {
    const { env, home } = registry();
    try {
      const script = claimScript(home);
      // dev-a reserves its slot, then stalls before writing its claim.
      const stalled = Bun.spawn([process.execPath, script, "dev-a"], {
        env: { ...process.env, NODE_ENV: "", ...env, OPENSCOUT_INSTANCE_REGISTRY_TEST_STALL_MS: "1500" },
        stdout: "pipe",
      });
      let held: number | undefined;
      for (let attempt = 0; attempt < 100 && held === undefined; attempt += 1) {
        Bun.sleepSync(20);
        const slots = readOpenScoutInstanceLedger(env, home).slots ?? {};
        held = Object.entries(slots).find(([, owner]) => owner === "dev-a")?.[0] as unknown as number | undefined;
      }
      expect(held).toBeDefined();
      process.kill(stalled.pid, "SIGSTOP");
      // dev-b insists on that block; with no claim behind it the slot is an orphan.
      const thief = claimOpenScoutInstance("dev-b", {
        ...env,
        OPENSCOUT_INSTANCE_PORT_BASE: String(held),
        OPENSCOUT_INSTANCE_REGISTRY_ORPHAN_GRACE_MS: "0",
      }, home)!;
      expect(thief.portBase).toBe(Number(held));
      process.kill(stalled.pid, "SIGCONT");
      expect(await stalled.exited).toBe(0);
      const view = readOpenScoutInstanceLedger(env, home);
      expect(view.instances["dev-b"]!.portBase).toBe(Number(held));
      expect(view.slots![Number(held)]).toBe("dev-b");
      // dev-a noticed it lost the slot and took another block.
      expect(view.instances["dev-a"]!.portBase).not.toBe(Number(held));
      expect(view.slots![view.instances["dev-a"]!.portBase]).toBe("dev-a");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("crash between slot and claim: the orphan is reclaimable after the grace period, or by its owner", () => {
    const { env, dir, home } = registry();
    try {
      mkdirSync(join(dir, ".slots"), { recursive: true });
      const slot = join(dir, ".slots", "29000");
      writeFileSync(slot, "dev-crashed\n");
      // Young orphan: an explicit claim is refused (it might be a slow claimer).
      expect(() => claimOpenScoutInstance("dev-x", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "29000" }, home))
        .toThrow('held by OpenScout instance "dev-crashed"');
      // Its owner restarting just finishes the claim.
      expect(claimOpenScoutInstance("dev-crashed", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "29000" }, home)!.portBase).toBe(29000);
      // An old orphan (no claim) is reclaimed by someone else.
      writeFileSync(join(dir, ".slots", "29050"), "dev-gone\n");
      utimesSync(join(dir, ".slots", "29050"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      expect(claimOpenScoutInstance("dev-y", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "29050" }, home)!.portBase).toBe(29050);
      expect(readFileSync(join(dir, ".slots", "29050"), "utf8").trim()).toBe("dev-y");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an explicit port base reserves its slot and collides loudly; dev owns 24400", () => {
    const { env, home } = registry();
    try {
      expect(claimOpenScoutInstance("dev", env, home)!.portBase).toBe(24400);
      expect(() => claimOpenScoutInstance("dev-z", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "24400" }, home))
        .toThrow('held by OpenScout instance "dev"');
      claimOpenScoutInstance("dev-p", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "29500" }, home);
      // Moving the explicit base releases the old slot.
      claimOpenScoutInstance("dev-p", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "29550" }, home);
      const view = readOpenScoutInstanceLedger(env, home);
      expect(view.slots![29550]).toBe("dev-p");
      expect(view.slots![29500]).toBeUndefined();
      expect(view.instances["dev-p"]).toMatchObject({ portBase: 29550, explicitBase: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refused knobs are never recorded; never claims under a test runner without a registry", () => {
    const { env, home } = registry();
    try {
      expect(claimOpenScoutInstance("dev-bad", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "43110" }, home)).toBeNull();
      expect(claimOpenScoutInstance("dev-bad", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "43100" }, home)).toBeNull();
      expect(claimOpenScoutInstance("dev-bad", { ...env, OPENSCOUT_INSTANCE_ROOT: join(home, ".scout") }, home)).toBeNull();
      expect(readOpenScoutInstanceLedger(env, home).instances).toEqual({});
      expect(claimOpenScoutInstance("dev-unclaimed", {}, HOME)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("release removes the instance's own slot and claim; a corrupt claim only affects its instance", async () => {
    const { env, dir, home } = registry();
    try {
      const a = claimOpenScoutInstance("dev-a", env, home)!;
      claimOpenScoutInstance("dev-b", env, home);
      expect(releaseOpenScoutInstance("dev-a", env, home)?.portBase).toBe(a.portBase);
      expect(readOpenScoutInstanceLedger(env, home).slots![a.portBase]).toBeUndefined();
      expect(() => releaseOpenScoutInstance("prod", env, home)).toThrow("cannot be released");

      writeFileSync(join(dir, ".claims", "dev-b.json"), "{ broken");
      expect(() => deriveOpenScoutInstanceLayout({ ...base, home, env: { ...env, OPENSCOUT_INSTANCE: "dev-b" } }))
        .toThrow("scout instance repair");
      // Others are unaffected, `dev` and explicit bases still derive.
      expect(claimOpenScoutInstance("dev-c", env, home)).not.toBeNull();
      expect(deriveOpenScoutInstanceLayout({ ...base, home, env: { ...env, OPENSCOUT_INSTANCE: "dev" } }).ports.broker).toBe(24400);
      expect((await listOpenScoutInstances(env, home)).corruptClaims).toEqual(["dev-b"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a checkout gone while its instance still runs is not pruned; once nothing runs it is", async () => {
    const { env, home } = registry();
    const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    try {
      const checkout = join(home, "moved-checkout");
      mkdirSync(checkout);
      // Pin the block on the live listener so a "running" port is in it.
      claimOpenScoutInstance("dev-moved", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: String(listener.port) }, home, checkout);
      rmSync(checkout, { recursive: true, force: true });
      expect((await listOpenScoutInstances(env, home)).instances["dev-moved"]).toBeDefined();
      listener.stop(true);
      const after = await listOpenScoutInstances(env, home);
      expect(after.instances["dev-moved"]).toBeUndefined();
      expect(after.pruned).toEqual(["dev-moved"]);
    } finally {
      listener.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("migration imports a legacy ledger once; an unreadable one is moved aside", () => {
    const { env, dir, home } = registry();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".ledger.json"), JSON.stringify({
        version: 1,
        instances: {
          "dev-old": { portBase: 26000, claimedAt: 1 },
          "dev-rooted": { portBase: 26050, root: join(home, "elsewhere"), claimedAt: 2 },
        },
      }));
      // Read-only derivation already sees the legacy blocks.
      expect(deriveOpenScoutInstanceLayout({ ...base, home, env: { ...env, OPENSCOUT_INSTANCE: "dev-old" } }).ports.broker).toBe(26000);
      const result = migrateLegacyOpenScoutInstanceLedger(env, home);
      expect(result.imported.sort()).toEqual(["dev-old", "dev-rooted"]);
      expect(existsSync(join(dir, ".ledger.json.migrated"))).toBe(true);
      const view = readOpenScoutInstanceLedger(env, home);
      expect(view.instances["dev-rooted"]).toMatchObject({ portBase: 26050, root: join(home, "elsewhere") });
      expect(view.slots![26000]).toBe("dev-old");

      writeFileSync(join(dir, ".ledger.json"), "{ nope");
      expect(migrateLegacyOpenScoutInstanceLedger(env, home).corrupt).toContain(".ledger.json.corrupt-");
      expect(existsSync(join(dir, ".ledger.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("repair", () => {
  function registry(): { env: Record<string, string | undefined>; dir: string; home: string } {
    const home = mkdtempSync(join(tmpdir(), "openscout-repair-"));
    const dir = join(home, ".openscout", "instances");
    return { env: { OPENSCOUT_INSTANCE_REGISTRY: dir }, dir, home };
  }

  test("a healthy registry is left alone (refused without --force, untouched with it)", () => {
    const { env, home } = registry();
    try {
      claimOpenScoutInstance("dev-pinned", { ...env, OPENSCOUT_INSTANCE_PORT_BASE: "29900" }, home);
      claimOpenScoutInstance("dev-rooted", { ...env, OPENSCOUT_INSTANCE_ROOT: join(home, "relocated") }, home);
      mkdirSync(join(home, "relocated"), { recursive: true });
      const before = readOpenScoutInstanceLedger(env, home);
      expect(repairOpenScoutInstanceRegistry(env, home).healthy).toBe(true);
      const forced = repairOpenScoutInstanceRegistry(env, home, { force: true });
      expect(forced.rebuilt).toEqual([]);
      expect(readOpenScoutInstanceLedger(env, home).instances).toEqual(before.instances);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("corrupt claims are rebuilt from their slot (a running instance keeps its block) or root evidence", () => {
    const { env, dir, home } = registry();
    try {
      const running = claimOpenScoutInstance("dev-running", env, home)!;
      claimOpenScoutInstance("dev-other", env, home);
      writeFileSync(join(dir, ".claims", "dev-running.json"), "{ broken");
      // A root with evidence of its block but no claim or slot (legacy loss).
      const evidenced = join(dir, "dev-evidence", "support");
      mkdirSync(evidenced, { recursive: true });
      writeFileSync(join(evidenced, ".host-info"), JSON.stringify({ ports: { broker: 27450 } }));
      // A root with nothing to go on.
      mkdirSync(join(dir, "dev-blank"), { recursive: true });

      const report = repairOpenScoutInstanceRegistry(env, home);
      expect(report.healthy).toBe(false);
      expect(report.rebuilt).toContainEqual({ name: "dev-running", portBase: running.portBase, source: "slot" });
      expect(report.rebuilt).toContainEqual({ name: "dev-evidence", portBase: 27450, source: "root .host-info" });
      expect(report.unresolved.some((line) => line.startsWith("dev-blank:"))).toBe(true);
      const view = readOpenScoutInstanceLedger(env, home);
      expect(view.instances["dev-running"]!.portBase).toBe(running.portBase);
      expect(view.slots![27450]).toBe("dev-evidence");
      expect(view.corruptClaims).toEqual([]);
      expect(readdirSync(join(dir, ".claims")).some((file) => file.startsWith("dev-running.json.corrupt-"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a released instance is not resurrected; a new claim clears the mark", () => {
    const { env, dir, home } = registry();
    try {
      const claimed = claimOpenScoutInstance("dev-gone", env, home)!;
      const root = join(dir, "dev-gone");
      mkdirSync(join(root, "support"), { recursive: true });
      writeFileSync(join(root, "support", ".host-info"), JSON.stringify({ ports: { broker: claimed.portBase } }));
      releaseOpenScoutInstance("dev-gone", env, home);
      expect(existsSync(join(root, ".released"))).toBe(true);

      expect(repairOpenScoutInstanceRegistry(env, home).healthy).toBe(true);
      const forced = repairOpenScoutInstanceRegistry(env, home, { force: true });
      expect(forced.rebuilt).toEqual([]);
      const view = readOpenScoutInstanceLedger(env, home);
      expect(view.instances["dev-gone"]).toBeUndefined();
      expect(Object.values(view.slots ?? {})).not.toContain("dev-gone");

      claimOpenScoutInstance("dev-gone", env, home);
      expect(existsSync(join(root, ".released"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a pruned instance is not resurrected", async () => {
    const { env, dir, home } = registry();
    try {
      const checkout = join(home, "checkout");
      mkdirSync(checkout, { recursive: true });
      const claimed = claimOpenScoutInstance("dev-pruned", env, home, checkout)!;
      const root = join(dir, "dev-pruned");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "config.json"), JSON.stringify({ ports: { broker: claimed.portBase } }));
      rmSync(checkout, { recursive: true });

      expect((await listOpenScoutInstances(env, home)).pruned).toEqual(["dev-pruned"]);
      expect(existsSync(join(root, ".released"))).toBe(true);
      expect(repairOpenScoutInstanceRegistry(env, home).healthy).toBe(true);
      expect(repairOpenScoutInstanceRegistry(env, home, { force: true }).rebuilt).toEqual([]);
      expect(readOpenScoutInstanceLedger(env, home).instances["dev-pruned"]).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("root evidence naming prod's port, a misaligned or out-of-range base is rejected and reported", () => {
    const { env, dir, home } = registry();
    try {
      const evidence: Record<string, unknown> = {
        "dev-prodport": 43110,
        "dev-misaligned": 27455,
        "dev-low": 24350,
        "dev-high": 30400,
        "dev-avoided": 27000,
        "dev-string": "27450",
      };
      for (const [name, broker] of Object.entries(evidence)) {
        mkdirSync(join(dir, name, "support"), { recursive: true });
        writeFileSync(join(dir, name, "support", ".host-info"), JSON.stringify({ ports: { broker } }));
      }
      const report = repairOpenScoutInstanceRegistry(env, home);
      expect(report.rebuilt).toEqual([]);
      for (const name of Object.keys(evidence)) {
        expect(report.unresolved.some((line) => line.startsWith(`${name}:`) && line.includes("not a valid instance block"))).toBe(true);
      }
      const view = readOpenScoutInstanceLedger(env, home);
      expect(view.instances).toEqual({});
      expect(view.slots).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a rebuilt claim keeps the custom root and checkout still readable in the broken file", () => {
    const { env, dir, home } = registry();
    try {
      const customRoot = join(home, "elsewhere", "dev-custom");
      const checkout = join(home, "checkout");
      mkdirSync(customRoot, { recursive: true });
      mkdirSync(checkout, { recursive: true });
      const claimed = claimOpenScoutInstance("dev-custom", { ...env, OPENSCOUT_INSTANCE_ROOT: customRoot }, home, checkout)!;
      writeFileSync(
        join(dir, ".claims", "dev-custom.json"),
        `{ "portBase": ${claimed.portBase}, "root": ${JSON.stringify(customRoot)}, "checkout": ${JSON.stringify(checkout)}, "claimedAt": tru`,
      );
      const report = repairOpenScoutInstanceRegistry(env, home);
      expect(report.rebuilt).toContainEqual({ name: "dev-custom", portBase: claimed.portBase, source: "slot" });
      const entry = readOpenScoutInstanceLedger(env, home).instances["dev-custom"]!;
      expect(entry.root).toBe(customRoot);
      expect(entry.checkout).toBe(checkout);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a custom root's evidence is used when its slot is gone too", () => {
    const { env, dir, home } = registry();
    try {
      const customRoot = join(home, "elsewhere", "dev-custom");
      mkdirSync(join(customRoot, "support"), { recursive: true });
      writeFileSync(join(customRoot, "support", ".host-info"), JSON.stringify({ ports: { broker: 27450 } }));
      mkdirSync(join(dir, ".claims"), { recursive: true });
      writeFileSync(join(dir, ".claims", "dev-custom.json"), `{ "root": ${JSON.stringify(customRoot)}, broken`);
      const report = repairOpenScoutInstanceRegistry(env, home);
      expect(report.rebuilt).toContainEqual({ name: "dev-custom", portBase: 27450, source: "root .host-info" });
      expect(readOpenScoutInstanceLedger(env, home).instances["dev-custom"]!.root).toBe(customRoot);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
