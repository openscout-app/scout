import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { refusesLoopbackHttpProxy } from "./mesh-loopback-proxy.js";
import { webStartContextFromRequest } from "./broker-web-control-service.js";
import { createBaseEdgeRefresh } from "./base-edge-refresh.js";
import { webStartRequestHeaders } from "./web-start-context.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Execute the actual watch wiring with fake bindings, not base-daemon's boot
// side effects. No broker, Caddy, mDNS, app or machine configuration starts.
const basePath = new URL("./base-daemon.ts", import.meta.url);
const source = readFileSync(basePath, "utf8");
const tree = ts.createSourceFile(
  String(basePath),
  source,
  ts.ScriptTarget.Latest,
  true,
);
function declaration(name: string): string {
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
      return statement.getText(tree);
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (d) => d.name.getText(tree) === name,
      )
    )
      return statement.getText(tree);
  }
  throw new Error("Missing actual base declaration " + name);
}
function watchHarness() {
  const gate = deferred<string[]>();
  const builds: string[][] = [],
    effects: unknown[] = [];
  let reads = 0;
  const factory = ts.transpileModule(
    `
    let shuttingDown = false, edgeGeneration = 0, edgeLanOnly = false, edgeRestartDelayMs = 0;
    const RESTART_MIN_DELAY_MS = 1000;
    let caddyProcess = { killed: false, kill() { effects.push("kill"); } };
    const edgeAdvertisements = { stop() { effects.push("stop"); }, update(...args) { effects.push(args); } };
    ${declaration("stopEdgeProcesses")}
    ${declaration("edgeWatchRefresh")}
    return { refresh: () => edgeWatchRefresh.refresh(),
      shutdown: () => { shuttingDown = true; },
      stop: () => stopEdgeProcesses(),
      replace: () => { caddyProcess = { killed: false, kill() {} }; },
      generation: () => { edgeGeneration++; },
    };
  `,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
  const harness = new Function(
    "createBaseEdgeRefresh",
    "readTailscaleSelfWebHosts",
    "resolveEdgeConfig",
    "resolveOpenScoutLocalEdgeAdvertisements",
    "resolveScoutLanNetworks",
    "effects",
    factory,
  )(
    createBaseEdgeRefresh,
    () => {
      reads++;
      return gate.promise;
    },
    (hosts: string[]) => {
      builds.push(hosts);
      return { lanOnly: false, scheme: "http", hosts };
    },
    (config: unknown) => config,
    () => [],
    effects,
  );
  return { ...harness, gate, effects, builds, reads: () => reads };
}

test("base interval joins one held lookup and builds only after hosts resolve", async () => {
  const h = watchHarness(),
    a = h.refresh(),
    b = h.refresh();
  try {
    expect(h.reads()).toBe(1);
    expect(a).toBe(b);
    expect(h.builds).toEqual([]);
    expect(h.effects).toEqual([]);
  } finally {
    h.gate.resolve(["fixture.ts.net"]);
    await Promise.all([a, b]);
  }
  expect(h.builds).toEqual([["fixture.ts.net"]]);
  expect(h.effects.length).toBe(1);
});

for (const action of ["shutdown", "stop", "replace", "generation"] as const)
  test(`base post-await ownership recheck rejects ${action} during a held lookup`, async () => {
    const h = watchHarness(),
      work = h.refresh();
    h[action]();
    const before = [...h.effects];
    h.gate.resolve(["old.ts.net"]);
    await work;
    expect(h.effects).toEqual(before);
    expect(h.builds).toEqual([]);
  });

test("refresh failure is observed, releases single flight and permits next request", async () => {
  const gate = deferred<string[]>();
  let reads = 0;
  const effects: string[][] = [];
  const refresh = createBaseEdgeRefresh({
    current: () => ({ generation: 1, owner: null }),
    readHosts: () => (++reads === 1 ? gate.promise : Promise.resolve(["new"])),
    apply: (hosts) => {
      effects.push(hosts);
    },
  });
  const first = refresh.refresh();
  gate.reject(new Error("lookup failed"));
  await expect(first).rejects.toThrow("lookup failed");
  await refresh.refresh();
  expect(effects).toEqual([["new"]]);
});

test("inactive start/watch does not look up hosts and apply errors do not poison next refresh", async () => {
  let eligible = false,
    reads = 0,
    applies = 0;
  const refresh = createBaseEdgeRefresh({
    current: () => (eligible ? { generation: 1, owner: null } : null),
    readHosts: async () => {
      reads++;
      return [];
    },
    apply: () => {
      if (++applies === 1) throw new Error("apply failed");
    },
  });
  await refresh.refresh();
  expect(reads).toBe(0);
  eligible = true;
  await expect(refresh.refresh()).rejects.toThrow("apply failed");
  await refresh.refresh();
  expect(applies).toBe(2);
});

test("all base host paths are explicit fresh-on-miss; no sync or stale-only fallback", () => {
  expect(source).not.toContain("readTailscaleSelfWebHostsSync");
  expect(declaration("resolveEdgeConfig")).toContain("tailnetHosts: string[]");
  expect(source).not.toMatch(/resolveEdgeConfig\(\)/);
  expect(declaration("spawnBroker")).toContain(
    "await readTailscaleSelfWebHosts()",
  );
  expect(declaration("spawnBroker")).toContain(
    "if (shuttingDown || brokerProcess) return",
  );
  expect(declaration("startWebWhenBrokerIsReady")).toContain(
    "await readTailscaleSelfWebHosts()",
  );
  expect(declaration("startWebWhenBrokerIsReady")).toContain(
    "if (shuttingDown) return",
  );
  expect(declaration("edgeStartRefresh")).toContain("edgeGeneration");
  expect(declaration("edgeStartRefresh")).toContain(
    "!shuttingDown && !caddyProcess",
  );
  expect(source).toContain("await spawnBroker()");
  expect(source).toContain("await startLocalEdge()");
});

for (const action of ["none", "shutdown", "stop", "successor"] as const)
  test(`actual base start wiring handles ${action} across its awaited lookup`, async () => {
    const gate = deferred<string[]>(),
      effects: string[][] = [];
    let reads = 0;
    const body = ts.transpileModule(
      `
      let shuttingDown = false, edgeGeneration = 0, caddyProcess = null;
      const openScoutInstanceBootstrap = { layout: { isProd: true } };
      const process = { platform: "darwin", env: {} };
      ${declaration("edgeStartRefresh")}
      return { start: () => edgeStartRefresh.refresh(),
        shutdown: () => { shuttingDown = true; },
        stop: () => { edgeGeneration++; },
        successor: () => { caddyProcess = {}; },
      };
    `,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const h = new Function(
      "createBaseEdgeRefresh",
      "readTailscaleSelfWebHosts",
      "shouldStartOpenScoutLocalEdge",
      "startLocalEdgeWithHosts",
      body,
    )(
      createBaseEdgeRefresh,
      () => {
        reads++;
        return gate.promise;
      },
      () => true,
      (hosts: string[]) => effects.push(hosts),
    );
    const a = h.start(),
      b = h.start();
    if (action !== "none") h[action]();
    gate.resolve(["fresh.ts.net"]);
    await Promise.all([a, b]);
    expect(reads).toBe(1);
    expect(effects).toEqual(action === "none" ? [["fresh.ts.net"]] : []);
  });

function childHarness() {
  const body = ts.transpileModule(
    `
    let edgeGeneration = 0, caddyProcess = null, edgeLanOnly = false, shuttingDown = false;
    const edgeLanWatchTimer = {}, EDGE_PROCESS_NAME = "fixture-edge", process = { env: {} };
    let stops = 0, restarts = 0;
    const children = [];
    const edgeAdvertisements = { update() {}, stop() { stops++; } };
    function spawn() {
      const handlers = {};
      const child = { pid: children.length + 1, killed: false,
        kill() { this.killed = true; }, once(name, callback) { handlers[name] = callback; },
        emit(name) { const callback = handlers[name]; delete handlers[name]; callback?.(0, null); },
      };
      children.push(child); return child;
    }
    function scheduleEdgeRestart() { restarts++; }
    const log = () => {}, warn = () => {}, logFile = () => 0;
    const resolveEdgeConfig = () => ({ scheme: "http" }), resolveOpenScoutLocalEdgeAdvertisements = () => [];
    const resolveLocalEdgeCaddyfilePath = () => "/fixture/Caddyfile", resolveCaddyExecutable = () => "fixture-only";
    const dirname = () => "/fixture", join = (...parts) => parts.join("/"), ensureDirectory = () => {};
    const renderOpenScoutCaddyfile = () => "fixture", writeFileSync = () => {};
    ${declaration("stopEdgeProcesses")}
    ${declaration("startLocalEdgeWithHosts")}
    return { start: () => startLocalEdgeWithHosts([]), stop: () => stopEdgeProcesses(), children,
      state: () => ({ generation: edgeGeneration, current: caddyProcess, stops, restarts }),
    };
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return new Function(body)();
}

test("retired Caddy exit cannot invalidate a new pending start generation", () => {
  const h = childHarness();
  h.start();
  const old = h.children[0];
  h.stop();
  const generation = h.state().generation;
  old.emit("exit");
  expect(h.state().generation).toBe(generation);
  expect(h.state().restarts).toBe(1);
});
test("retired Caddy exit cannot stop an already-started successor", () => {
  const h = childHarness();
  h.start();
  const old = h.children[0];
  h.stop();
  h.start();
  const next = h.children[1],
    before = h.state();
  old.emit("exit");
  expect(h.state()).toEqual(before);
  expect(next.killed).toBe(false);
});

test("actual base startup and retry use allowlisted metadata without proxy headers", async () => {
  const requests: Request[] = [];
  let retries = 0;
  const factory = ts.transpileModule(`
    let webStartInFlight = false, shuttingDown = false;
    const process = { env: {} };
    const brokerControlUrl = "http://127.0.0.1:24400";
    const log = () => {}, warn = () => {};
    ${declaration("forwardedProtoForEdgeScheme")}
    ${declaration("startWebWhenBrokerIsReady").replaceAll("import.meta.url", JSON.stringify(import.meta.url))}
    return startWebWhenBrokerIsReady;
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const start = new Function(
    "waitForBrokerHealth", "readTailscaleSelfWebHosts", "resolveEdgeConfig",
    "fetch", "scheduleWebStartRetry", "resolveLegacyWebEntry", "dirname", "fileURLToPath", "webStartRequestHeaders", factory,
  )(
    async () => true,
    async () => ["mesh.example.test"],
    () => ({ portalHost: "mesh.example.test", scheme: "https" }),
    async (url: URL, init: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      const headers = Object.fromEntries(request.headers);
      expect(refusesLoopbackHttpProxy("loopback", headers)).toBe(false);
      expect(webStartContextFromRequest({ headers }, new Set(["mesh.example.test"]))).toEqual({
        publicOrigin: "https://mesh.example.test", trustedHost: "mesh.example.test",
      });
      return Response.json(requests.length === 1 ? { ok: false, error: "warming up" } : { ok: true, pid: 1234 },
        { status: requests.length === 1 ? 503 : 200 });
    },
    () => { retries++; },
    () => "/fixture/web.mjs",
    dirname,
    fileURLToPath,
    webStartRequestHeaders,
  );
  await start();
  expect(retries).toBe(1);
  await start();
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => request.method === "POST" && new URL(request.url).pathname === "/v1/web/start")).toBe(true);
  expect(retries).toBe(1);
});
