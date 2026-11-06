import { afterEach, describe, expect, test } from "bun:test";

import { agentRosterTag, type AgentDefinition, type AgentEndpoint } from "@openscout/protocol";

import {
  AgentRosterError,
  AgentRosterService,
  ROSTER_IDLE_FREE_MS,
  withRosterTags,
  type AgentRosterRegistryView,
} from "./agent-roster-service.js";
import { AgentRosterStore } from "./agent-roster-store.js";
import { BrokerDeliveryRouter } from "./broker-delivery-routing.js";
import { configureControlPlaneDatabase, migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

const NODE = "node-local";
const DAY = 24 * 60 * 60_000;
const START = Date.UTC(2026, 9, 1);

function agent(id: string, handle: string, project: string | null, metadata: Record<string, unknown> = {}): AgentDefinition {
  return {
    id,
    definitionId: handle,
    displayName: handle,
    handle,
    selector: handle,
    defaultSelector: handle,
    agentClass: "worker",
    capabilities: [],
    wakePolicy: "auto",
    homeNodeId: NODE,
    authorityNodeId: NODE,
    advertiseScope: "local",
    metadata: { ...(project ? { project } : {}), ...metadata },
  } as AgentDefinition;
}

function endpoint(id: string, agentId: string, metadata: Record<string, unknown> = {}): AgentEndpoint {
  return {
    id,
    agentId,
    nodeId: NODE,
    harness: "claude",
    transport: "claude_stream_json",
    state: "idle",
    metadata,
  } as AgentEndpoint;
}

type Registry = {
  agents: Record<string, AgentDefinition>;
  actors: Record<string, { createdAt?: number }>;
  endpoints: Record<string, AgentEndpoint>;
};

const databases: ControlPlaneSqliteTransactionalDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close?.();
});

function setup() {
  const database = openControlPlaneSqliteDatabase(":memory:", { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  configureControlPlaneDatabase(database);
  migrateControlPlaneDatabaseSchema(database);
  databases.push(database);
  const registry: Registry = { agents: {}, actors: {}, endpoints: {} };
  const clock = { now: START };
  const logs: string[] = [];
  const service = new AgentRosterService({
    store: new AgentRosterStore(database),
    registry: () => registry as AgentRosterRegistryView,
    now: () => clock.now,
    log: (message) => logs.push(message),
  });
  const add = (id: string, handle: string, project: string | null, createdAt = clock.now, metadata: Record<string, unknown> = {}) => {
    registry.agents[id] = agent(id, handle, project, metadata);
    registry.actors[id] = { createdAt };
    return registry.agents[id]!;
  };
  return { database, registry, clock, logs, service, add };
}

function numbers(service: AgentRosterService): Record<string, string> {
  return Object.fromEntries(service.list().agents.map((entry) => [entry.agentId, entry.code]));
}

describe("AgentRosterService assignment", () => {
  test("numbers agents in the order the runtime first saw them, one roster across projects", () => {
    const { service, add } = setup();
    add("agent.c", "c", "openscout", START + 3);
    add("agent.a", "a", "peal-bach", START + 1);
    add("agent.b", "b", "openscout", START + 2);

    const result = service.reconcile();

    expect(result.assigned.map((entry) => entry.agentId)).toEqual(["agent.a", "agent.b", "agent.c"]);
    expect(numbers(service)).toEqual({ "agent.a": "PB-001", "agent.b": "OS-002", "agent.c": "OS-003" });
    const entry = service.entry("agent.b")!;
    expect(entry.label).toBe("OS 002");
    expect(entry.numberText).toBe("002");
    expect(service.list().projects.map((project) => [project.projectKey, project.code, project.codeSource])).toEqual([
      ["openscout", "OS", "default"],
      ["peal-bach", "PB", "default"],
    ]);
  });

  test("keeps numbers across restarts and new sessions of the same agent", () => {
    const { database, registry, service, add } = setup();
    add("agent.a", "a", "openscout", START + 1);
    add("agent.b", "b", "openscout", START + 2);
    service.reconcile();

    // A restart: a new service over the same database and a reordered registry.
    const reborn = new AgentRosterService({
      store: new AgentRosterStore(database),
      registry: () => registry as AgentRosterRegistryView,
      now: () => START + DAY,
    });
    registry.actors["agent.a"] = { createdAt: START + 50 };
    registry.endpoints["ep.a.session-2"] = endpoint("ep.a.session-2", "agent.a", { lastStartedAt: START + DAY });
    expect(reborn.reconcile().assigned).toEqual([]);
    expect(numbers(reborn)).toEqual({ "agent.a": "OS-001", "agent.b": "OS-002" });
  });

  test("agents that share a handle each hold their own number", () => {
    const { service, add } = setup();
    add("claude.alpha.node-local", "claude", "alpha", START + 1);
    add("claude.beta.node-local", "claude", "beta", START + 2);
    add("claude.gamma.node-local", "claude", "gamma", START + 3);

    service.reconcile();

    expect(numbers(service)).toEqual({
      "claude.alpha.node-local": "AL-001",
      "claude.beta.node-local": "BT-002",
      "claude.gamma.node-local": "GM-003",
    });
    expect(new Set(service.list().agents.map((entry) => entry.number)).size).toBe(3);
  });

  test("frees a number once the agent has been deleted or retired past the grace, and reuses the lowest", () => {
    const { registry, clock, service, add } = setup();
    add("agent.1", "one", "openscout", START + 1);
    add("agent.2", "two", "openscout", START + 2);
    add("agent.3", "three", "openscout", START + 3);
    add("agent.4", "four", "openscout", START + 4);
    service.reconcile();

    delete registry.agents["agent.2"];
    registry.agents["agent.3"] = agent("agent.3", "three", "openscout", { retiredFromFleet: true });
    service.reconcile();
    // Inside the grace both keep their numbers, and nothing new takes them.
    add("agent.5", "five", "openscout", clock.now);
    service.reconcile();
    expect(numbers(service)).toEqual({
      "agent.1": "OS-001",
      "agent.2": "OS-002",
      "agent.3": "OS-003",
      "agent.4": "OS-004",
      "agent.5": "OS-005",
    });
    expect(service.entry("agent.2")?.goneAt).toBe(START);
    expect(service.resolve("002")).toMatchObject({ resolved: false, diagnostic: { code: "roster_agent_gone" } });

    clock.now += 10 * 60_000;
    const freed = service.reconcile();
    expect(freed.freed.map((entry) => entry.number).sort()).toEqual([2, 3]);

    add("agent.6", "six", "openscout", clock.now);
    add("agent.7", "seven", "openscout", clock.now + 1);
    add("agent.8", "eight", "openscout", clock.now + 2);
    service.reconcile();
    expect(numbers(service)).toMatchObject({ "agent.6": "OS-002", "agent.7": "OS-003", "agent.8": "OS-006" });
  });

  test("an agent that comes back inside the grace keeps its number", () => {
    const { registry, clock, service, add } = setup();
    const original = add("agent.1", "one", "openscout", START + 1);
    service.reconcile();
    delete registry.agents["agent.1"];
    service.reconcile();
    clock.now += 5 * 60_000;
    registry.agents["agent.1"] = original;
    service.reconcile();
    clock.now += 10 * 60_000;
    service.reconcile();
    expect(service.entry("agent.1")).toMatchObject({ code: "OS-001" });
    expect(service.entry("agent.1")?.goneAt).toBeUndefined();
  });

  test("numbers only agents active within the window, and a mesh agent whose peer is quiet keeps its number", () => {
    const { registry, clock, service, add } = setup();
    add("agent.old", "old", "openscout", START - 30 * DAY);
    add("agent.touched", "touched", "openscout", START - 30 * DAY);
    registry.endpoints["ep.touched"] = endpoint("ep.touched", "agent.touched", { lastCompletedAt: new Date(START - DAY).toISOString() });
    add("agent.secs", "secs", "openscout", START - 30 * DAY, { lastSeenAt: Math.round((START - DAY) / 1000) });
    add("agent.mesh", "mesh", "openscout", START);
    service.reconcile();
    expect(Object.keys(numbers(service)).sort()).toEqual(["agent.mesh", "agent.secs", "agent.touched"]);

    registry.agents["agent.mesh"] = agent("agent.mesh", "mesh", "openscout", {
      staleLocalRegistration: true,
      staleMeshRegistration: true,
    });
    clock.now += DAY;
    service.reconcile();
    expect(service.entry("agent.mesh")?.goneAt).toBeUndefined();
  });

  test("frees a number after 30 days with no activity, and an agent that comes back after that takes a new number", () => {
    const { registry, clock, service, add } = setup();
    add("agent.idle", "idle", "openscout", START + 1);
    add("agent.busy", "busy", "openscout", START + 2);
    service.reconcile();
    expect(numbers(service)).toEqual({ "agent.idle": "OS-001", "agent.busy": "OS-002" });
    const touch = (agentId: string) => {
      registry.endpoints[`ep.${agentId}`] = endpoint(`ep.${agentId}`, agentId, { lastSeenAt: clock.now });
    };

    clock.now = START + 1 + ROSTER_IDLE_FREE_MS - 1;
    touch("agent.busy");
    expect(service.reconcile().freed).toEqual([]);
    expect(service.entry("agent.idle")?.code).toBe("OS-001");

    clock.now = START + 1 + ROSTER_IDLE_FREE_MS;
    touch("agent.busy");
    expect(service.reconcile().freed).toEqual([{ agentId: "agent.idle", number: 1, reason: "idle" }]);
    expect(service.entry("agent.idle")).toBeNull();
    expect(service.entry("agent.busy")?.code).toBe("OS-002");
    expect(service.resolve("001")).toMatchObject({ resolved: false, diagnostic: { code: "unknown_roster_number" } });

    // The freed number goes to the next newcomer, lowest first.
    add("agent.new", "new", "openscout", clock.now);
    service.reconcile();
    expect(service.entry("agent.new")?.code).toBe("OS-001");

    // Active again, the idle agent takes a new number.
    touch("agent.idle");
    service.reconcile();
    expect(service.entry("agent.idle")?.code).toBe("OS-003");
  });

  test("the idle time counts from the import when the agent's last activity is older", () => {
    const { clock, service, add } = setup();
    add("agent.old", "old", "openscout", START - 60 * DAY);
    service.reconcile();
    expect(service.entry("agent.old")).toBeNull();

    service.importEntries({ entries: [{ agentId: "agent.old", number: 7 }] });
    clock.now += ROSTER_IDLE_FREE_MS - 1;
    expect(service.reconcile().freed).toEqual([]);
    expect(service.entry("agent.old")?.code).toBe("OS-007");

    clock.now += 1;
    expect(service.reconcile().freed).toEqual([{ agentId: "agent.old", number: 7, reason: "idle" }]);
  });

  test("stops at 999 and says the roster is full", () => {
    const { service, add, logs } = setup();
    for (let index = 0; index < 1001; index++) add(`agent.${index}`, `a${index}`, null, START + index);
    const result = service.reconcile();
    expect(result.assigned).toHaveLength(999);
    expect(result.unnumbered).toBe(2);
    expect(service.list().capacity).toEqual({ max: 999, held: 999 });
    expect(logs.some((line) => line.includes("roster is full"))).toBe(true);
  });
});

describe("AgentRosterService project codes", () => {
  test("a clash takes the next candidate by default and refuses the operator, naming the holder", () => {
    const { service, add } = setup();
    add("agent.a", "a", "openscout", START + 1);
    add("agent.b", "b", "OpenScout-Labs", START + 2);
    service.reconcile();
    expect(service.entry("agent.b")?.projectCode).toBe("OP");

    let error: unknown;
    try {
      service.setProjectCode({ project: "openscout-labs", code: "os" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentRosterError);
    expect((error as AgentRosterError).code).toBe("project_code_held");
    expect((error as AgentRosterError).message).toBe('OS is held by project "openscout"');
    expect((error as AgentRosterError).details).toEqual({ code: "OS", heldBy: "openscout" });
  });

  test("the operator sets, validates and resets a code", () => {
    const { service, add } = setup();
    add("agent.a", "a", "peal-bach", START + 1);
    service.reconcile();

    const set = service.setProjectCode({ project: "Peal-Bach", code: "pbx" });
    expect(set).toMatchObject({ projectKey: "peal-bach", code: "PBX", codeSource: "operator", defaultCode: "PB" });
    expect(service.entry("agent.a")?.code).toBe("PBX-001");

    expect(() => service.setProjectCode({ project: "peal-bach", code: "P" })).toThrow('"P" is not a project code: use two or three letters');
    expect(() => service.setProjectCode({ project: "peal-bach", code: "P8" }))
      .toThrow('"P8" is not a project code: project codes are letters only, two or three of them');
    expect(() => service.setProjectCode({ project: "peal-bach", code: "123" })).toThrow(/letters only/);
    expect(() => service.setProjectCode({ project: "nowhere", code: "NW" })).toThrow(/no agent lists project "nowhere"/);

    const reset = service.setProjectCode({ project: "peal-bach", code: null });
    expect(reset).toMatchObject({ code: "PB", codeSource: "default" });
  });

  test("an operator code for a project with no numbered agent yet is kept for when one arrives", () => {
    const { service, add, registry } = setup();
    add("agent.old", "old", "dormant", START - 60 * DAY);
    service.reconcile();
    expect(service.list().agents).toHaveLength(0);

    service.setProjectCode({ project: "dormant", code: "ZZ" });
    registry.endpoints["ep.old"] = endpoint("ep.old", "agent.old", { lastStartedAt: START });
    service.reconcile();
    expect(service.entry("agent.old")?.code).toBe("ZZ-001");
  });
});

describe("AgentRosterService import", () => {
  test("keeps the apps' numbers, moves runtime numbers aside, and reports every conflict", () => {
    const { service, add, registry } = setup();
    add("agent.a", "a", "openscout", START + 1);
    add("agent.b", "b", "openscout", START + 2);
    add("agent.c", "c", "peal-bach", START + 3);
    add("agent.d", "d", "peal-bach", START + 4);
    add("agent.retired", "r", "openscout", START + 5, { retiredFromFleet: true });
    service.reconcile();
    expect(numbers(service)).toEqual({ "agent.a": "OS-001", "agent.b": "OS-002", "agent.c": "PB-003", "agent.d": "PB-004" });

    const result = service.importEntries({
      entries: [
        { agentId: "agent.b", number: "001", projectCode: "OS" },
        { agentId: "agent.c", number: 7, projectCode: "PX" },
        { agentId: "agent.d", number: 7 },
        { agentId: "agent.b", number: 9 },
        { agentId: "agent.ghost", number: 12 },
        { agentId: "agent.retired", number: 13 },
        { agentId: "agent.a", number: "1000" },
        { agentId: "", number: 14 },
      ],
    });

    expect(result.dryRun).toBe(false);
    expect(result.imported).toEqual([
      { agentId: "agent.b", number: 1, code: "OS-001" },
      { agentId: "agent.c", number: 7, code: "PX-007" },
    ]);
    expect(result.renumbered).toEqual([{ agentId: "agent.a", from: 1, to: 2 }]);
    expect(result.projectCodes).toEqual([{ projectKey: "peal-bach", code: "PX" }]);
    expect(result.conflicts.map((conflict) => [conflict.agentId, conflict.reason])).toEqual([
      ["agent.d", "duplicate_number"],
      ["agent.b", "duplicate_agent"],
      ["agent.ghost", "unknown_agent"],
      ["agent.retired", "agent_not_listed"],
      ["agent.a", "invalid_entry"],
      ["", "invalid_entry"],
    ]);
    expect(result.conflicts[0]).toMatchObject({ number: 7, heldBy: "agent.c" });
    expect(numbers(service)).toEqual({ "agent.a": "OS-002", "agent.b": "OS-001", "agent.c": "PX-007", "agent.d": "PX-004" });
    expect(service.entry("agent.b")?.source).toBe("import");
    expect(service.entry("agent.a")?.source).toBe("auto");
    expect(Object.keys(registry.agents)).toContain("agent.retired");
  });

  test("an imported number is not taken by a later import, and re-running it changes nothing", () => {
    const { service, add } = setup();
    add("agent.a", "a", "openscout", START + 1);
    add("agent.b", "b", "openscout", START + 2);
    service.reconcile();
    const entries = [{ agentId: "agent.a", number: 5 }];
    service.importEntries({ entries });

    const again = service.importEntries({ entries });
    expect(again.imported).toEqual([{ agentId: "agent.a", number: 5, code: "OS-005" }]);
    expect(again.conflicts).toEqual([]);

    const later = service.importEntries({ entries: [{ agentId: "agent.b", number: 5 }, { agentId: "agent.a", number: 6 }] });
    expect(later.conflicts.map((conflict) => [conflict.agentId, conflict.reason, conflict.heldBy])).toEqual([
      ["agent.b", "number_held", "agent.a"],
      ["agent.a", "agent_already_imported", "agent.a"],
    ]);
    expect(numbers(service)).toEqual({ "agent.a": "OS-005", "agent.b": "OS-002" });
  });

  test("reports project codes it cannot set and still keeps the numbers", () => {
    const { service, add } = setup();
    add("agent.a", "a", "openscout", START + 1);
    add("agent.b", "b", "peal-bach", START + 2);
    add("agent.c", "c", "fabric-ops", START + 3);
    add("agent.d", "d", null, START + 4);
    add("agent.e", "e", "fabric-ops", START + 5);
    service.reconcile();
    service.setProjectCode({ project: "peal-bach", code: "PE" });

    const result = service.importEntries({
      entries: [
        { agentId: "agent.a", number: 1, projectCode: "PE" },
        { agentId: "agent.b", number: 2, projectCode: "PB" },
        { agentId: "agent.c", number: 3, projectCode: "F!" },
        { agentId: "agent.d", number: 4, projectCode: "NP" },
        { agentId: "agent.e", number: 5, projectCode: "FO" },
      ],
    });

    expect(result.conflicts.map((conflict) => [conflict.agentId, conflict.reason])).toEqual([
      ["agent.a", "project_code_held"],
      ["agent.b", "project_code_differs"],
      ["agent.c", "invalid_project_code"],
      ["agent.d", "no_project"],
    ]);
    expect(result.conflicts[0]?.detail).toBe('PE is held by project "peal-bach"');
    expect(result.imported.map((entry) => entry.code)).toEqual(["OS-001", "PE-002", "FO-003", "004", "FO-005"]);
  });

  test("an imported code with a digit is refused unless it is the project's own default", () => {
    const { service, add } = setup();
    add("agent.a", "a", "app-2", START + 1);
    add("agent.b", "b", "peal-bach", START + 2);
    service.reconcile();
    expect(service.entry("agent.a")?.projectCode).toBe("A2");

    const result = service.importEntries({
      entries: [
        { agentId: "agent.a", number: 4, projectCode: "a2" },
        { agentId: "agent.b", number: 5, projectCode: "P8" },
      ],
    });
    expect(result.imported.map((entry) => entry.code)).toEqual(["A2-004", "PB-005"]);
    expect(result.projectCodes).toEqual([]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        agentId: "agent.b",
        reason: "invalid_project_code",
        detail: '"P8" is not a project code: project codes are letters only, two or three of them',
      }),
    ]);
  });

  test("a dry run reports the same result and writes nothing", () => {
    const { service, add } = setup();
    add("agent.a", "a", "openscout", START + 1);
    add("agent.b", "b", "openscout", START + 2);
    service.reconcile();
    const before = service.list();

    const preview = service.importEntries({ dryRun: true, entries: [{ agentId: "agent.b", number: 1, projectCode: "OX" }] });
    expect(preview).toMatchObject({
      dryRun: true,
      imported: [{ agentId: "agent.b", number: 1, code: "OX-001" }],
      renumbered: [{ agentId: "agent.a", from: 1, to: 2 }],
      projectCodes: [{ projectKey: "openscout", code: "OX" }],
    });
    expect(service.list()).toEqual(before);
  });
});

describe("AgentRosterService addresses", () => {
  function seeded() {
    const value = setup();
    value.add("agent.a", "a", "openscout", START + 1);
    value.add("agent.b", "b", "peal-bach", START + 2);
    value.add("agent.c", "c", "openscout", START + 3);
    value.service.reconcile();
    return value;
  }

  test("OS-003, os003, OS 003, @OS-003 and 003 name the same agent", () => {
    const { service } = seeded();
    for (const address of ["OS-003", "os003", "OS 003", "@OS-003", "os-003", "003"]) {
      expect(service.resolve(address)).toMatchObject({ resolved: true, entry: { agentId: "agent.c", code: "OS-003" } });
    }
  });

  test("an unknown code fails with a clear message and is never guessed", () => {
    const { service } = seeded();
    expect(service.resolve("XQ-003")).toEqual({
      address: "XQ-003",
      resolved: false,
      diagnostic: { code: "unknown_project_code", detail: "no project has code XQ; scout roster lists the codes" },
    });
    expect(service.resolve("004")).toEqual({
      address: "004",
      resolved: false,
      diagnostic: { code: "unknown_roster_number", detail: "no agent holds roster number 004" },
    });
    expect(service.resolve("PB-003")).toMatchObject({
      resolved: false,
      diagnostic: { code: "roster_code_mismatch", detail: "PB-003 names no agent: 003 is OS-003 (agent.c)" },
    });
    expect(service.resolve("03")).toMatchObject({ resolved: false, diagnostic: { code: "invalid_roster_address" } });
    expect(service.resolve("000")).toMatchObject({ resolved: false, diagnostic: { code: "invalid_roster_address" } });
  });
});

describe("withRosterTags", () => {
  test("copies tagged agent records, drops a stale tag, and returns an unchanged snapshot as is", () => {
    const tag = agentRosterTag({ number: 3, projectCode: "OS" });
    const a = agent("agent.a", "a", "openscout");
    const b = { ...agent("agent.b", "b", "openscout"), roster: agentRosterTag({ number: 9, projectCode: "OS" }) };
    const snapshot = { nodes: {}, agents: { "agent.a": a, "agent.b": b } };

    const tagged = withRosterTags(snapshot, new Map([["agent.a", tag]]));
    expect(tagged.agents["agent.a"]).toEqual({ ...a, roster: tag });
    expect(tagged.agents["agent.b"]).not.toHaveProperty("roster");
    expect(tagged.nodes).toBe(snapshot.nodes);
    expect(a).not.toHaveProperty("roster");
    expect(snapshot.agents["agent.b"]).toHaveProperty("roster");

    const plain = { agents: { "agent.a": a } };
    expect(withRosterTags(plain, new Map())).toBe(plain);
  });
});

describe("BrokerDeliveryRouter roster codes", () => {
  function routed() {
    const value = setup();
    value.add("agent.a", "a", "openscout", START + 1);
    value.add("agent.b", "b", "openscout", START + 2);
    value.add("agent.c", "c", "openscout", START + 3);
    value.registry.endpoints["ep.c"] = endpoint("ep.c", "agent.c");
    value.service.reconcile();
    const snapshot = {
      nodes: { [NODE]: { id: NODE, meshId: "mesh", name: "local", advertiseScope: "local", registeredAt: 1 } },
      actors: {},
      agents: value.registry.agents,
      endpoints: value.registry.endpoints,
      conversations: {},
      messages: {},
      invocations: {},
      flights: {},
      bindings: {},
      deliveries: {},
      collaborationRecords: {},
      collaborationEvents: {},
    } as unknown as RuntimeSnapshot;
    const router = new BrokerDeliveryRouter({
      runtimeSnapshot: () => snapshot,
      nodeId: NODE,
      isInactiveLocalAgent: () => false,
      rosterService: value.service,
    });
    return { ...value, router };
  }

  const options = { requesterId: "operator", reason: "roster test" };

  test("resolves all three spellings wherever an agent label or handle is accepted", async () => {
    const { router } = routed();
    for (const label of ["OS-003", "os003", "003"]) {
      const asLabel = await router.resolveWithImplicitProjectAgent({ target: { kind: "agent_label", label } }, options);
      expect(asLabel).toMatchObject({ kind: "resolved", agent: { id: "agent.c" } });
      const asTargetLabel = await router.resolveWithImplicitProjectAgent({ targetLabel: label }, options);
      expect(asTargetLabel).toMatchObject({ kind: "resolved", agent: { id: "agent.c" } });
      const asHandle = await router.resolveWithImplicitProjectAgent({
        target: { kind: "target_handle", handle: label, value: `@${label}` },
      }, options);
      expect(asHandle).toMatchObject({ kind: "resolved", agent: { id: "agent.c" } });
    }
  });

  test("an unknown roster code returns the roster's diagnostic", async () => {
    const { router } = routed();
    expect(await router.resolveWithImplicitProjectAgent({ target: { kind: "agent_label", label: "OS-042" } }, options)).toEqual({
      kind: "unknown",
      label: "OS-042",
      detail: "no agent holds roster number 042",
      diagnosticCode: "unknown_roster_number",
    });
    expect(await router.resolveWithImplicitProjectAgent({ target: { kind: "agent_label", label: "QQ-001" } }, options)).toMatchObject({
      kind: "unknown",
      diagnosticCode: "unknown_project_code",
    });
  });

  test("a name that only looks like a code still resolves natively when no agent holds the code", async () => {
    const { router, add, registry } = routed();
    add("agent.box", "box100", "openscout", START + 9);
    registry.endpoints["ep.box"] = endpoint("ep.box", "agent.box");
    expect(await router.resolveWithImplicitProjectAgent({ target: { kind: "agent_label", label: "box100" } }, options))
      .toMatchObject({ kind: "resolved", agent: { id: "agent.box" } });
  });
});
