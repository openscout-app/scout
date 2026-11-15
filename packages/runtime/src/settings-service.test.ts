import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createSettingsCatalog,
  SETTINGS_CATALOG,
  type SettingCatalogEntry,
} from "./settings-catalog.js";
import {
  createSettingsService,
  operatorCliActor,
  SettingsError,
  type SettingsActor,
} from "./settings-service.js";
import { resetUserConfigCache } from "./user-config.js";
import { registerUserConfigFieldAfterSet, USER_CONFIG_FIELDS } from "./user-config-fields.js";

const priorHome = process.env.OPENSCOUT_HOME;
let home = "";

const operator = operatorCliActor();
const agent: SettingsActor = { authority: "agent", id: "agent-hudson", via: "test" };

function userConfigPath(): string {
  return join(home, "user.json");
}

function changeLogPath(): string {
  return join(home, "settings-changes.jsonl");
}

function readUserConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(userConfigPath(), "utf8"));
}

function seedUserConfig(config: Record<string, unknown>): void {
  writeFileSync(userConfigPath(), JSON.stringify(config, null, 2) + "\n");
  resetUserConfigCache();
}

async function expectIssues(promise: Promise<unknown>): Promise<SettingsError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsError);
    return error as SettingsError;
  }
  throw new Error("expected a SettingsError");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scout-settings-"));
  process.env.OPENSCOUT_HOME = home;
  resetUserConfigCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.OPENSCOUT_HOME;
  else process.env.OPENSCOUT_HOME = priorHome;
  resetUserConfigCache();
});

describe("settings catalog", () => {
  test("wraps every profile field once, as a core setting", () => {
    expect(SETTINGS_CATALOG.map((entry) => entry.id)).toEqual(USER_CONFIG_FIELDS.map((field) => field.id));
    for (const entry of SETTINGS_CATALOG) {
      const field = USER_CONFIG_FIELDS.find((candidate) => candidate.id === entry.id)!;
      expect(entry.scope).toBe("core");
      expect(entry.kind).toBe(field.kind);
      expect(entry.owner).toEqual({ store: "user-config", path: "~/.openscout/user.json", key: String(field.key) });
      // Allowed values come from the field registry, not a copy.
      expect(entry.enumValues).toBe(field.enumValues);
      expect(entry.description.length).toBeGreaterThan(20);
      expect(["apply", "confirm", "never"]).toContain(entry.risk);
    }
  });

  test("asks for approval on identity, applies preferences", () => {
    const risk = (id: string) => SETTINGS_CATALOG.find((entry) => entry.id === id)?.risk;
    for (const id of ["name", "handle", "pronouns", "bio"]) expect(risk(id)).toBe("confirm");
    for (const id of ["verbosity", "tone", "quiet-hours", "working-hours", "agent-names"]) expect(risk(id)).toBe("apply");
  });

  test("refuses entries that point at no profile field", () => {
    const entry: SettingCatalogEntry = { ...SETTINGS_CATALOG[0]!, id: "ghost", owner: { store: "user-config", path: "", key: "ghost" } };
    expect(() => createSettingsCatalog([entry])).toThrow(/no field for key "ghost"/);
  });
});

describe("settings service: read", () => {
  test("list and get show stored values, defaults and catalog data", () => {
    seedUserConfig({ verbosity: "detailed" });
    const service = createSettingsService();
    const verbosity = service.get("verbosity");
    expect(verbosity).toEqual(expect.objectContaining({
      id: "verbosity", value: "detailed", display: "detailed", isSet: true, risk: "apply", kind: "enum",
    }));
    expect(service.get("tone")).toEqual(expect.objectContaining({ value: null, isSet: false }));
    expect(service.list().map((view) => view.id)).toEqual(SETTINGS_CATALOG.map((entry) => entry.id));
  });

  test("get rejects an unknown id", () => {
    const service = createSettingsService();
    expect(() => service.get("nope")).toThrow(SettingsError);
  });
});

describe("settings service: validation", () => {
  test("rejects unknown ids, bad enum values and wrong kinds, and writes nothing", async () => {
    const service = createSettingsService();
    const error = await expectIssues(service.apply({
      "nope": "x",
      "tone": "loud",
      "hue": "195",
      "bio": 42,
      "agent-names": [1, 2],
      "verbosity": "terse",
    }, { actor: operator }));
    expect(error.issues).toEqual([
      { id: "nope", code: "unknown-setting", message: "unknown setting" },
      expect.objectContaining({ id: "tone", code: "invalid-value", message: expect.stringContaining("direct, warm, formal") }),
      expect.objectContaining({ id: "hue", code: "invalid-value", message: expect.stringContaining("a number") }),
      expect.objectContaining({ id: "bio", code: "invalid-value", message: expect.stringContaining("text") }),
      expect.objectContaining({ id: "agent-names", code: "invalid-value" }),
    ]);
    expect(existsSync(userConfigPath())).toBe(false);
    expect(existsSync(changeLogPath())).toBe(false);
  });

  test("runs the field's own validation (runtime presets)", async () => {
    const service = createSettingsService();
    const error = await expectIssues(service.set("runtime-presets", ["claude=claude/opus"], { actor: operator }));
    expect(error.issues[0]).toEqual(expect.objectContaining({ id: "runtime-presets", code: "invalid-value" }));
    expect(error.issues[0]!.message).toContain("collides with a launchable harness");
  });

  test("parses CLI words with the field parser", () => {
    const service = createSettingsService();
    expect(service.parseInput("hue", ["210"])).toBe(210);
    expect(service.parseInput("agent-names", ["ada,", "grace"])).toEqual(["ada", "grace"]);
    expect(() => service.parseInput("tone", ["loud"])).toThrow(SettingsError);
  });

  test("rejects an empty or non-object patch", async () => {
    const service = createSettingsService();
    expect((await expectIssues(service.apply({}, { actor: operator }))).code).toBe("invalid-patch");
    expect((await expectIssues(service.apply([] as never, { actor: operator }))).code).toBe("invalid-patch");
  });
});

describe("settings service: risk", () => {
  test("never entries are rejected for every caller", async () => {
    const lockedTone = { ...SETTINGS_CATALOG.find((entry) => entry.id === "tone")!, risk: "never" as const };
    const service = createSettingsService({ catalog: createSettingsCatalog([lockedTone]) });
    for (const actor of [operator, agent]) {
      const error = await expectIssues(service.set("tone", "warm", { actor }));
      expect(error.issues).toEqual([expect.objectContaining({ id: "tone", code: "not-changeable" })]);
    }
    expect(existsSync(userConfigPath())).toBe(false);
  });

  test("confirm entries need approval from an agent and write nothing", async () => {
    const service = createSettingsService();
    const result = await service.apply({ name: "Grace", tone: "warm" }, { actor: agent });
    expect(result.status).toBe("needs-approval");
    expect(result.needsApproval).toEqual(["name"]);
    expect(result.changes.map((change) => [change.id, change.approval])).toEqual([
      ["name", "required"],
      ["tone", "not-required"],
    ]);
    // The whole patch waits: the apply-risk tone change is not written either.
    expect(existsSync(userConfigPath())).toBe(false);
    expect(existsSync(changeLogPath())).toBe(false);
  });

  test("an agent may change apply entries", async () => {
    const service = createSettingsService();
    const result = await service.set("tone", "warm", { actor: agent });
    expect(result.status).toBe("applied");
    expect(readUserConfig().tone).toBe("warm");
  });

  test("the operator approves confirm entries by making the change", async () => {
    const service = createSettingsService();
    const result = await service.set("name", "Grace", { actor: operator });
    expect(result.status).toBe("applied");
    expect(result.changes[0]!.approval).toBe("operator");
    expect(readUserConfig().name).toBe("Grace");
  });
});

describe("settings service: apply", () => {
  test("returns the diff with the risk of each change", async () => {
    seedUserConfig({ tone: "direct", verbosity: "terse", bio: "Builds Scout" });
    const service = createSettingsService();
    const result = await service.apply({
      tone: "warm",
      verbosity: "terse",
      bio: null,
      "agent-names": "ada, grace",
    }, { actor: operator });
    expect(result.status).toBe("applied");
    expect(result.unchanged).toEqual(["verbosity"]);
    expect(result.changes).toEqual([
      { id: "tone", risk: "apply", action: "set", from: "direct", to: "warm", fromDisplay: "direct", toDisplay: "warm", approval: "not-required" },
      { id: "bio", risk: "confirm", action: "unset", from: "Builds Scout", to: null, fromDisplay: "Builds Scout", toDisplay: "", approval: "operator" },
      { id: "agent-names", risk: "apply", action: "set", from: null, to: ["ada", "grace"], fromDisplay: "", toDisplay: "ada, grace", approval: "not-required" },
    ]);
    expect(readUserConfig()).toEqual({ tone: "warm", verbosity: "terse", provisionalAgentNames: ["ada", "grace"] });
  });

  test("dry run returns the diff and writes nothing", async () => {
    seedUserConfig({ tone: "direct" });
    const before = readFileSync(userConfigPath(), "utf8");
    const service = createSettingsService();
    const result = await service.apply({ tone: "formal", name: "Grace" }, { actor: agent, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(result.changes.map((change) => change.id)).toEqual(["tone", "name"]);
    expect(result.needsApproval).toEqual(["name"]);
    expect(readFileSync(userConfigPath(), "utf8")).toBe(before);
    expect(existsSync(changeLogPath())).toBe(false);
  });

  test("a patch that changes nothing writes nothing", async () => {
    seedUserConfig({ tone: "warm" });
    const service = createSettingsService();
    const result = await service.set("tone", "warm", { actor: operator });
    expect(result).toEqual({ status: "unchanged", changes: [], unchanged: ["tone"], needsApproval: [] });
    expect(existsSync(changeLogPath())).toBe(false);
  });

  test("runs after-set hooks for accepted sets", async () => {
    const seen: unknown[] = [];
    registerUserConfigFieldAfterSet("pronouns", (_context, value) => {
      seen.push(value);
    });
    const service = createSettingsService();
    await service.set("pronouns", "they/them", { actor: operator });
    await service.set("pronouns", "they/them", { actor: operator });
    await service.set("pronouns", "she/her", { actor: agent });
    expect(seen).toEqual(["they/them", "they/them"]);
  });
});

describe("settings change log", () => {
  test("appends each change with old and new value, time and actor", async () => {
    let clock = Date.parse("2026-11-12T10:00:00.000Z");
    const service = createSettingsService({ now: () => clock });
    await service.apply({ tone: "warm", verbosity: "detailed" }, { actor: operator });
    clock += 60_000;
    await service.unset("tone", { actor: agent });

    const entries = service.readChangeLog();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual(expect.objectContaining({
      at: "2026-11-12T10:00:00.000Z",
      actor: operator,
      id: "tone",
      owner: { store: "user-config", path: "~/.openscout/user.json", key: "tone" },
      risk: "apply",
      action: "set",
      from: null,
      to: "warm",
      approval: "not-required",
    }));
    expect(entries[1]!.batch).toBe(entries[0]!.batch);
    expect(entries[2]).toEqual(expect.objectContaining({
      at: "2026-11-12T10:01:00.000Z", actor: agent, id: "tone", action: "unset", from: "warm", to: null,
    }));
    expect(entries[2]!.batch).not.toBe(entries[0]!.batch);
    expect(service.readChangeLog({ limit: 1 })).toEqual([entries[2]!]);
  });
});
