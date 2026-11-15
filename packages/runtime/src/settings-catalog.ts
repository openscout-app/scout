import {
  USER_CONFIG_FIELDS,
  type UserConfigFieldDefinition,
  type UserConfigFieldKind,
} from "./user-config-fields.js";

/**
 * The settings catalog: every setting Scout lets the operator, an agent, or
 * Scoutbot read and change through one controlled entry point.
 *
 * Profile settings are not redefined here. Each `core` entry wraps a field of
 * {@link USER_CONFIG_FIELDS}, which stays the one source of truth for the key,
 * kind, allowed values, parsing and storage. This module adds only what the
 * field registry does not know: scope, owner, risk, and a description an agent
 * can act on.
 */

/**
 * Where a setting applies.
 * - `core`: the Scout runtime on this machine reads it.
 * - `shared-app`: the Scout apps read it and share it between devices.
 * - `device`: one device or app install reads it.
 *
 * Only `core` entries exist now. The other scopes are reserved for the app
 * settings that later steps bring into the catalog.
 */
export type SettingScope = "core" | "shared-app" | "device";

/**
 * What a caller may do with a setting through this entry point.
 * - `apply`: any caller may change it.
 * - `confirm`: the operator must approve the change. An operator caller
 *   approves by making the change; any other caller gets "needs approval".
 * - `never`: no caller may change it through this entry point.
 */
export type SettingRisk = "apply" | "confirm" | "never";

export type SettingKind = UserConfigFieldKind;

/** Where a setting's value lives. */
export type SettingOwner = {
  /** `user-config` is `user.json` in the OpenScout home directory. */
  store: "user-config";
  /** Display path of the store. */
  path: string;
  /** Key inside the store. */
  key: string;
};

export type SettingCatalogEntry = {
  id: string;
  scope: SettingScope;
  owner: SettingOwner;
  kind: SettingKind;
  /** Allowed values for an `enum` setting. */
  enumValues?: readonly string[];
  label: string;
  /** Plain-words description: what the setting does and what values mean. */
  description: string;
  risk: SettingRisk;
  aliases?: readonly string[];
};

type SettingPolicy = {
  risk: SettingRisk;
  description: string;
};

const USER_CONFIG_STORE_PATH = "~/.openscout/user.json";

/**
 * Risk and description for each profile field, keyed by field id.
 *
 * Identity fields (`name`, `handle`, `pronouns`, `bio`) are `confirm`: other
 * agents and people see them, and `handle` is the operator's routing address.
 * `interrupt-threshold` and `channel` are `confirm` too: they decide whether
 * and where the operator hears from agents, so an agent must not be able to
 * quiet the operator's own alerts. `agent-names-file` is `confirm` because it
 * points the runtime at a file on disk. Everything else is a preference and
 * is `apply`.
 */
const USER_CONFIG_SETTING_POLICY: Record<string, SettingPolicy> = {
  "name": {
    risk: "confirm",
    description: "The operator's display name. Agents and apps show it. Unset it to fall back to the account or system name.",
  },
  "handle": {
    risk: "confirm",
    description: "The operator's @mention handle. Agents address the operator by it, so a change moves the operator's address.",
  },
  "pronouns": {
    risk: "confirm",
    description: "The operator's pronouns, as free text. Agents use them when they refer to the operator.",
  },
  "hue": {
    risk: "apply",
    description: "The operator's identity color, as a hue in degrees, such as 195 (the default).",
  },
  "bio": {
    risk: "confirm",
    description: "A short description of the operator that agents can read for context.",
  },
  "timezone": {
    risk: "apply",
    description: "The operator's IANA timezone, such as Europe/Paris. Unset it to use this machine's timezone.",
  },
  "working-hours": {
    risk: "apply",
    description: "The hours the operator works, in the operator's timezone, as text such as 08:00-18:00 (the default).",
  },
  "interrupt-threshold": {
    risk: "confirm",
    description: "When agents may interrupt the operator: always, blocking-only (only when work is blocked), batched (in batches), or never.",
  },
  "tail-thinking": {
    risk: "apply",
    description: "How the tail shows a thinking step that has no text: hide drops it, tag shows a marker.",
  },
  "batch-window": {
    risk: "apply",
    description: "How many minutes to collect non-urgent notices before they go to the operator as one batch. The default is 15.",
  },
  "channel": {
    risk: "confirm",
    description: "Where Scout reaches the operator: here (this machine), mobile (the paired phone), or here+mobile.",
  },
  "verbosity": {
    risk: "apply",
    description: "How much detail agents put in messages to the operator: terse, normal, or detailed.",
  },
  "tone": {
    risk: "apply",
    description: "The tone agents use with the operator: direct, warm, or formal.",
  },
  "quiet-hours": {
    risk: "apply",
    description: "Hours when agents should not disturb the operator, as text such as 22:00-07:00 (the default).",
  },
  "agent-names": {
    risk: "apply",
    description: "Names Scout gives to one-off agents, in rotation. Give a list; unset it to use Scout's built-in names.",
  },
  "agent-names-mode": {
    risk: "apply",
    description: "How agent-names combines with Scout's built-in names: replace uses only the operator's list, extend uses it first and then the built-in names.",
  },
  "agent-names-file": {
    risk: "confirm",
    description: "Path to a JSON file that overrides the agent name pool. Advanced; prefer agent-names.",
  },
  "runtime-shortlist": {
    risk: "apply",
    description: "Models to show first in runtime pickers, as <harness>[/<model>] specs such as claude/opus.",
  },
  "runtime-presets": {
    risk: "apply",
    description: "Named runtime choices, as id[:Label]=<harness>[/<model>[/<effort>]] items. An id cannot reuse a harness, profile, or effort name.",
  },
};

function catalogEntryFromUserConfigField(field: UserConfigFieldDefinition): SettingCatalogEntry {
  const policy = USER_CONFIG_SETTING_POLICY[field.id];
  if (!policy) {
    throw new Error(`settings catalog: user config field "${field.id}" has no risk or description`);
  }
  return {
    id: field.id,
    scope: "core",
    owner: { store: "user-config", path: USER_CONFIG_STORE_PATH, key: String(field.key) },
    kind: field.kind,
    ...(field.enumValues ? { enumValues: field.enumValues } : {}),
    label: field.label,
    description: policy.description,
    risk: policy.risk,
    ...(field.aliases?.length ? { aliases: field.aliases } : {}),
  };
}

export const SETTINGS_CATALOG: readonly SettingCatalogEntry[] = USER_CONFIG_FIELDS.map(catalogEntryFromUserConfigField);

/** A catalog entry and the profile field that stores it. */
export type ResolvedSetting = {
  entry: SettingCatalogEntry;
  field: UserConfigFieldDefinition;
};

/**
 * A settings catalog the service reads. The default catalog is
 * {@link SETTINGS_CATALOG}; tests pass their own to cover risks no shipped
 * entry uses.
 */
export type SettingsCatalog = {
  entries: readonly SettingCatalogEntry[];
  resolve: (id: string) => ResolvedSetting | undefined;
};

export function createSettingsCatalog(
  entries: readonly SettingCatalogEntry[],
  findField: (key: string) => UserConfigFieldDefinition | undefined = (key) =>
    USER_CONFIG_FIELDS.find((field) => String(field.key) === key),
): SettingsCatalog {
  const index = new Map<string, ResolvedSetting>();
  for (const entry of entries) {
    const field = findField(entry.owner.key);
    if (!field) {
      throw new Error(`settings catalog: entry "${entry.id}" has no field for key "${entry.owner.key}"`);
    }
    for (const name of [entry.id, ...(entry.aliases ?? [])]) {
      if (index.has(name)) throw new Error(`settings catalog: duplicate id "${name}"`);
      index.set(name, { entry, field });
    }
  }
  return {
    entries,
    resolve: (id) => index.get(id.trim()),
  };
}

export const DEFAULT_SETTINGS_CATALOG: SettingsCatalog = createSettingsCatalog(SETTINGS_CATALOG);

export function findSettingCatalogEntry(id: string): SettingCatalogEntry | undefined {
  return DEFAULT_SETTINGS_CATALOG.resolve(id)?.entry;
}

export function listSettingIds(catalog: SettingsCatalog = DEFAULT_SETTINGS_CATALOG): string[] {
  return catalog.entries.map((entry) => entry.id);
}
