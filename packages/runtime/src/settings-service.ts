import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_SETTINGS_CATALOG,
  type ResolvedSetting,
  type SettingCatalogEntry,
  type SettingRisk,
  type SettingsCatalog,
} from "./settings-catalog.js";
import { assertTestIsolatedUserData, resolveOpenScoutHome } from "./support-paths.js";
import {
  applyUserConfigField,
  clearUserConfigField,
  formatUserConfigFieldGet,
  formatUserConfigFieldValue,
  parseUserConfigFieldValue,
  runUserConfigFieldAfterSet,
  type UserConfigFieldSaveContext,
} from "./user-config-fields.js";
import {
  loadUserConfig,
  loadUserConfigFresh,
  saveUserConfig,
  type OpenScoutUserConfig,
} from "./user-config.js";

/**
 * Who is asking to change settings, as the risk gate sees it.
 *
 * - `operator`: the person who owns this Scout. An operator caller approves a
 *   `confirm` change by making it. The CLI run by a person is an operator
 *   caller.
 * - `agent`: any other caller (an agent, Scoutbot, an MCP client). Its
 *   `confirm` changes return "needs approval" and are not written.
 */
export type SettingsCallerAuthority = "operator" | "agent";

export type SettingsActor = {
  authority: SettingsCallerAuthority;
  /** Stable caller id for the change log, such as `cli` or an agent id. */
  id: string;
  /** The surface the change came through, such as `scout settings`. */
  via?: string;
};

/** The actor for a person who runs `scout settings` or `scout config`. */
export function operatorCliActor(via = "scout settings"): SettingsActor {
  return { authority: "operator", id: "cli", via };
}

/** One setting as `list` and `get` return it. */
export type SettingView = SettingCatalogEntry & {
  /** Stored value, or null when the setting is not set. */
  value: unknown;
  /** Value as text. For an unset setting this may show the default in effect. */
  display: string;
  isSet: boolean;
};

/**
 * - `not-required`: the setting is `apply`.
 * - `operator`: the setting is `confirm` and the caller is the operator.
 * - `required`: the setting is `confirm` and the operator must approve it.
 */
export type SettingApproval = "not-required" | "operator" | "required";

export type SettingChange = {
  id: string;
  risk: SettingRisk;
  action: "set" | "unset";
  /** Stored value before the change, or null. */
  from: unknown;
  /** Stored value after the change, or null. */
  to: unknown;
  fromDisplay: string;
  toDisplay: string;
  approval: SettingApproval;
};

/**
 * - `applied`: the changes were written.
 * - `dry-run`: the changes are valid and nothing was written.
 * - `needs-approval`: at least one change needs the operator; nothing was written.
 * - `unchanged`: every value already matched; nothing was written.
 */
export type SettingsApplyStatus = "applied" | "dry-run" | "needs-approval" | "unchanged";

export type SettingsApplyResult = {
  status: SettingsApplyStatus;
  changes: SettingChange[];
  /** Ids in the patch whose value already matched. */
  unchanged: string[];
  /** Ids that need operator approval before the patch can be written. */
  needsApproval: string[];
};

/** A whole set of changes: setting id to new value, or null to unset it. */
export type SettingsPatch = Record<string, unknown>;

export type SettingsIssueCode = "unknown-setting" | "invalid-value" | "not-changeable" | "invalid-patch";

export type SettingsIssue = {
  id: string;
  code: SettingsIssueCode;
  message: string;
};

export class SettingsError extends Error {
  readonly issues: SettingsIssue[];

  constructor(issues: SettingsIssue[]) {
    super(issues.map((issue) => (issue.id ? `${issue.id}: ${issue.message}` : issue.message)).join("\n"));
    this.name = "SettingsError";
    this.issues = issues;
  }

  get code(): SettingsIssueCode {
    return this.issues[0]?.code ?? "invalid-patch";
  }
}

export type SettingsChangeLogEntry = {
  at: string;
  /** Groups the changes of one `apply`. */
  batch: string;
  actor: SettingsActor;
  id: string;
  owner: SettingCatalogEntry["owner"];
  risk: SettingRisk;
  action: "set" | "unset";
  from: unknown;
  to: unknown;
  approval: SettingApproval;
};

export type SettingsWriteOptions = {
  actor: SettingsActor;
  /** Validate and return the diff without writing anything. */
  dryRun?: boolean;
  /** Passed to after-set hooks (for example, the onboarding name sync). */
  context?: UserConfigFieldSaveContext;
};

export type SettingsService = {
  catalog: SettingsCatalog;
  list(): SettingView[];
  get(id: string): SettingView;
  /** Parse CLI words (`scout settings set <id> <words...>`) into a value for `set`. */
  parseInput(id: string, words: string[]): unknown;
  set(id: string, value: unknown, options: SettingsWriteOptions): Promise<SettingsApplyResult>;
  unset(id: string, options: SettingsWriteOptions): Promise<SettingsApplyResult>;
  apply(patch: SettingsPatch, options: SettingsWriteOptions): Promise<SettingsApplyResult>;
  readChangeLog(options?: { limit?: number }): SettingsChangeLogEntry[];
};

export type CreateSettingsServiceOptions = {
  catalog?: SettingsCatalog;
  now?: () => number;
  /** Defaults to `settings-changes.jsonl` in the OpenScout home directory. */
  changeLogPath?: () => string;
};

export function defaultSettingsChangeLogPath(): string {
  return join(resolveOpenScoutHome(), "settings-changes.jsonl");
}

function storedValue(config: OpenScoutUserConfig, setting: ResolvedSetting): unknown {
  const value = config[setting.field.key];
  return value === undefined ? null : value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function describeKind(entry: SettingCatalogEntry): string {
  switch (entry.kind) {
    case "string":
      return "text";
    case "number":
      return "a number";
    case "enum":
      return `one of: ${(entry.enumValues ?? []).join(", ")}`;
    case "string-list":
      return "a list of text items (an array, or one comma-separated string)";
    default:
      return entry.kind;
  }
}

/**
 * Check a JSON value against the entry's kind. Returns undefined for "unset"
 * (null, an empty string, or an empty list).
 */
function normalizeInput(setting: ResolvedSetting, raw: unknown): unknown {
  const { entry, field } = setting;
  if (raw === null || raw === undefined) return undefined;
  const wrongKind = () => new Error(`expects ${describeKind(entry)}, got ${JSON.stringify(raw)}`);

  switch (entry.kind) {
    case "string": {
      if (typeof raw !== "string") throw wrongKind();
      return raw.trim() || undefined;
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw wrongKind();
      return raw;
    }
    case "enum": {
      if (typeof raw !== "string" || !(entry.enumValues ?? []).includes(raw.trim())) throw wrongKind();
      return raw.trim();
    }
    case "string-list": {
      if (typeof raw === "string") {
        return raw.trim() ? parseUserConfigFieldValue(field, [raw]) : undefined;
      }
      if (!Array.isArray(raw)) throw wrongKind();
      // Runtime presets also take { id, label?, runtime } objects; the field validates them.
      const itemsOk = raw.every((item) =>
        typeof item === "string" || (field.id === "runtime-presets" && typeof item === "object" && item !== null));
      if (!itemsOk) throw wrongKind();
      return raw.length === 0 ? undefined : raw;
    }
    default:
      throw wrongKind();
  }
}

export function createSettingsService(options: CreateSettingsServiceOptions = {}): SettingsService {
  const catalog = options.catalog ?? DEFAULT_SETTINGS_CATALOG;
  const now = options.now ?? Date.now;
  const changeLogPath = options.changeLogPath ?? defaultSettingsChangeLogPath;

  function resolveOrThrow(id: string): ResolvedSetting {
    const setting = catalog.resolve(id);
    if (!setting) {
      throw new SettingsError([{
        id,
        code: "unknown-setting",
        message: `unknown setting; known ids: ${catalog.entries.map((entry) => entry.id).join(", ")}`,
      }]);
    }
    return setting;
  }

  function view(setting: ResolvedSetting, config: OpenScoutUserConfig): SettingView {
    const value = storedValue(config, setting);
    return {
      ...setting.entry,
      value,
      display: formatUserConfigFieldGet(setting.field, config),
      isSet: value !== null,
    };
  }

  function appendChangeLog(entries: SettingsChangeLogEntry[]): void {
    if (entries.length === 0) return;
    assertTestIsolatedUserData("write the OpenScout settings change log", "OPENSCOUT_HOME");
    const path = changeLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  }

  async function apply(patch: SettingsPatch, writeOptions: SettingsWriteOptions): Promise<SettingsApplyResult> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new SettingsError([{ id: "", code: "invalid-patch", message: "a settings patch is a JSON object of setting id to value (null unsets)" }]);
    }
    const ids = Object.keys(patch);
    if (ids.length === 0) {
      throw new SettingsError([{ id: "", code: "invalid-patch", message: "the settings patch is empty" }]);
    }

    const current = loadUserConfigFresh();
    const next: OpenScoutUserConfig = { ...current };
    const issues: SettingsIssue[] = [];
    const seen = new Map<string, string>();
    const accepted: Array<{ setting: ResolvedSetting; value: unknown }> = [];

    for (const id of ids) {
      const setting = catalog.resolve(id);
      if (!setting) {
        issues.push({ id, code: "unknown-setting", message: "unknown setting" });
        continue;
      }
      const canonical = setting.entry.id;
      const earlier = seen.get(canonical);
      if (earlier !== undefined) {
        issues.push({ id, code: "invalid-patch", message: `names the same setting as ${earlier}` });
        continue;
      }
      seen.set(canonical, id);
      if (setting.entry.risk === "never") {
        issues.push({ id, code: "not-changeable", message: "this setting cannot be changed through Scout settings" });
        continue;
      }
      try {
        const value = normalizeInput(setting, patch[id]);
        if (value === undefined) {
          clearUserConfigField(next, setting.field);
        } else {
          applyUserConfigField(next, setting.field, value);
        }
        accepted.push({ setting, value });
      } catch (error) {
        issues.push({ id, code: "invalid-value", message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (issues.length > 0) throw new SettingsError(issues);

    const changes: SettingChange[] = [];
    const unchanged: string[] = [];
    for (const { setting } of accepted) {
      const from = storedValue(current, setting);
      const to = storedValue(next, setting);
      if (sameValue(from, to)) {
        unchanged.push(setting.entry.id);
        continue;
      }
      const approval: SettingApproval = setting.entry.risk === "confirm"
        ? (writeOptions.actor.authority === "operator" ? "operator" : "required")
        : "not-required";
      changes.push({
        id: setting.entry.id,
        risk: setting.entry.risk,
        action: to === null ? "unset" : "set",
        from,
        to,
        fromDisplay: from === null ? "" : formatUserConfigFieldValue(setting.field, from),
        toDisplay: to === null ? "" : formatUserConfigFieldValue(setting.field, to),
        approval,
      });
    }
    const needsApproval = changes.filter((change) => change.approval === "required").map((change) => change.id);
    const result = (status: SettingsApplyStatus): SettingsApplyResult => ({ status, changes, unchanged, needsApproval });

    if (writeOptions.dryRun) return result("dry-run");
    if (needsApproval.length > 0) return result("needs-approval");

    if (changes.length > 0) {
      saveUserConfig(next);
      const at = new Date(now()).toISOString();
      const batch = randomUUID();
      appendChangeLog(changes.map((change) => ({
        at,
        batch,
        actor: writeOptions.actor,
        id: change.id,
        owner: catalog.resolve(change.id)!.entry.owner,
        risk: change.risk,
        action: change.action,
        from: change.from,
        to: change.to,
        approval: change.approval,
      })));
    }
    // After-set hooks run for every accepted set, as `scout config set` always
    // did: the name hook also records that the operator answered onboarding.
    for (const { setting, value } of accepted) {
      await runUserConfigFieldAfterSet(setting.field, writeOptions.context ?? {}, value);
    }
    return result(changes.length > 0 ? "applied" : "unchanged");
  }

  return {
    catalog,
    list() {
      const config = loadUserConfig();
      return catalog.entries.map((entry) => view(catalog.resolve(entry.id)!, config));
    },
    get(id) {
      return view(resolveOrThrow(id), loadUserConfig());
    },
    parseInput(id, words) {
      const setting = resolveOrThrow(id);
      try {
        return parseUserConfigFieldValue(setting.field, words) ?? null;
      } catch (error) {
        throw new SettingsError([{
          id: setting.entry.id,
          code: "invalid-value",
          message: error instanceof Error ? error.message : String(error),
        }]);
      }
    },
    set(id, value, writeOptions) {
      return apply({ [id]: value }, writeOptions);
    },
    unset(id, writeOptions) {
      return apply({ [id]: null }, writeOptions);
    },
    apply,
    readChangeLog(readOptions = {}) {
      const path = changeLogPath();
      if (!existsSync(path)) return [];
      const entries = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as SettingsChangeLogEntry];
          } catch {
            return [];
          }
        });
      return readOptions.limit === undefined ? entries : entries.slice(-readOptions.limit);
    },
  };
}
