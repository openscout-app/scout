import {
  normalizeScoutLaunchableHarness,
  normalizeAgentSelectorSegment,
  parseScoutRuntimeSpec,
  SCOUT_REASONING_EFFORTS,
  SCOUT_RESERVED_RUNTIME_PROFILE_IDS,
} from "@openscout/protocol";
import {
  describeProvisionalAgentNamePool,
  normalizeProvisionalAgentNamesSetting,
} from "./provisional-agent-names-config.js";
import {
  loadUserConfig,
  resolveOperatorHandle,
  resolveOperatorName,
  type CommsChannel,
  type CommsTone,
  type CommsVerbosity,
  type InterruptThreshold,
  type OpenScoutUserConfig,
  type ProvisionalAgentNamesMode,
  type RuntimePresetConfig,
  type TailThinkingMode,
  type WorktreeRetireMode,
} from "./user-config.js";

export type UserConfigFieldKind = "string" | "number" | "enum" | "string-list";

export type UserConfigFieldDefinition = {
  /** CLI identifier, e.g. scout config set <id> <value> */
  id: string;
  /** Key in ~/.openscout/user.json */
  key: keyof OpenScoutUserConfig;
  label: string;
  kind: UserConfigFieldKind;
  summary?: string;
  /** Include in `scout config` / `scout config show` summary output */
  showInSummary?: boolean;
  enumValues?: readonly string[];
  aliases?: readonly string[];
  /** Parse CLI args after the field id. Undefined means unset. */
  parse?: (args: string[]) => unknown;
  /** Value for scout config get (defaults to stored config[key]). */
  resolveGet?: (config: OpenScoutUserConfig) => string;
  /** One-line value for scout config show. */
  formatSummary?: (config: OpenScoutUserConfig) => string;
  /** Custom render of a parsed value for set output (defaults follow `kind`). */
  formatValue?: (value: unknown) => string;
  apply?: (config: OpenScoutUserConfig, value: unknown) => void;
  clear?: (config: OpenScoutUserConfig) => void;
};

export type UserConfigFieldSaveContext = {
  currentDirectory?: string;
};

export type UserConfigFieldAfterSetHook = (
  context: UserConfigFieldSaveContext,
  value: unknown,
) => void | Promise<void>;

const INTERRUPT_THRESHOLDS = ["always", "blocking-only", "batched", "never"] as const;
const COMMS_CHANNELS = ["here", "mobile", "here+mobile"] as const;
const COMMS_VERBOSITIES = ["terse", "normal", "detailed"] as const;
const COMMS_TONES = ["direct", "warm", "formal"] as const;
const AGENT_NAME_MODES = ["replace", "extend"] as const;
const TAIL_THINKING_MODES = ["hide", "tag"] as const;
const WORKTREE_RETIRE_MODES = ["on", "off"] as const;

function parseStringValue(args: string[]): string | undefined {
  const value = args.join(" ").trim();
  return value || undefined;
}

function parseNumberValue(args: string[]): number | undefined {
  const raw = args[0]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`expected a number, got "${raw}"`);
  }
  return value;
}

function parseEnumValue<T extends string>(args: string[], allowed: readonly T[]): T | undefined {
  const value = args[0]?.trim() as T | undefined;
  if (!value) return undefined;
  if (!allowed.includes(value)) {
    throw new Error(`expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

function parseCommaSeparatedList(args: string[]): string[] {
  const names = normalizeProvisionalAgentNamesSetting(
    args.join(" ").split(",").map((entry) => entry.trim()).filter(Boolean),
  );
  return names;
}

function formatStoredString(value: string | undefined): string {
  return value?.trim() ?? "";
}

function formatStoredNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function formatStoredEnum(value: string | undefined): string {
  return value?.trim() ?? "";
}

function formatStoredStringList(value: string[] | undefined): string {
  return normalizeProvisionalAgentNamesSetting(value).join(", ");
}

function setConfigValue<K extends keyof OpenScoutUserConfig>(
  config: OpenScoutUserConfig,
  key: K,
  value: OpenScoutUserConfig[K],
): void {
  config[key] = value;
}

// ── Runtime lists ────────────────────────────────────────────────────────────
//
// `runtimeShortlist` and `runtimePresets` are validated here once and shared by
// `scout config set` and `POST /api/user`, so the CLI grammar and the HTTP body
// can never drift apart. Specs go through `parseScoutRuntimeSpec`; preset ids
// are slugified and refused when they collide with reserved profile names,
// launchable harness ids, or reasoning-effort words — grammar words cannot be
// reassigned.

export function normalizeRuntimeShortlistInput(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("runtime-shortlist expects a list of <harness>[/<model>] specs");
  }
  const specs = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  for (const spec of specs) {
    const parsed = parseScoutRuntimeSpec(spec);
    if (!parsed.ok) {
      throw new Error(`invalid runtime spec "${spec}": ${parsed.error}`);
    }
    if (parsed.value.reasoningEffort) {
      throw new Error(`invalid runtime spec "${spec}": shortlist entries pin a model, not an effort — use runtime-presets for effort`);
    }
  }
  return specs;
}

/**
 * Slugified preset ids are grammar-adjacent: `scout ask fable` and
 * `scout ask claude/opus-5/medium` already mean something, so a user preset may
 * not take those words.
 */
export function normalizeRuntimePresetId(raw: unknown): string {
  const id = normalizeAgentSelectorSegment(typeof raw === "string" ? raw : "");
  if (!id) {
    throw new Error("runtime preset needs an id — use id[:Label]=<harness>[/<model>[/<effort>]]");
  }
  if ((SCOUT_RESERVED_RUNTIME_PROFILE_IDS as readonly string[]).includes(id)) {
    throw new Error(`runtime preset id "${id}" is a reserved runtime profile name`);
  }
  if (normalizeScoutLaunchableHarness(id)) {
    throw new Error(`runtime preset id "${id}" collides with a launchable harness`);
  }
  if ((SCOUT_REASONING_EFFORTS as readonly string[]).includes(id)) {
    throw new Error(`runtime preset id "${id}" collides with a reasoning effort`);
  }
  return id;
}

export function normalizeRuntimePresetInput(value: unknown): RuntimePresetConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime preset must be { id, label?, runtime }");
  }
  const record = value as Record<string, unknown>;
  const id = normalizeRuntimePresetId(record.id);
  const runtime = typeof record.runtime === "string" ? record.runtime.trim() : "";
  const parsed = parseScoutRuntimeSpec(runtime);
  if (!parsed.ok) {
    throw new Error(`invalid runtime spec for preset "${id}": ${parsed.error}`);
  }
  const label = typeof record.label === "string" && record.label.trim()
    ? record.label.trim()
    : undefined;
  return { id, ...(label ? { label } : {}), runtime };
}

/** `id[:Label]=<harness>[/<model>[/<effort>]]` — the field grammar. */
export function parseRuntimePresetItem(item: string): RuntimePresetConfig {
  const trimmed = item.trim();
  const eq = trimmed.indexOf("=");
  if (eq < 0) {
    throw new Error(`preset "${trimmed}" must be id[:Label]=<harness>[/<model>[/<effort>]]`);
  }
  const head = trimmed.slice(0, eq).trim();
  const runtime = trimmed.slice(eq + 1).trim();
  const colon = head.indexOf(":");
  const id = colon < 0 ? head : head.slice(0, colon).trim();
  const label = colon < 0 ? undefined : head.slice(colon + 1).trim() || undefined;
  return normalizeRuntimePresetInput({ id, ...(label ? { label } : {}), runtime });
}

export function normalizeRuntimePresetsInput(value: unknown): RuntimePresetConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("runtime-presets expects a list of id[:Label]=<spec> items");
  }
  return value.map((entry) =>
    typeof entry === "string" ? parseRuntimePresetItem(entry) : normalizeRuntimePresetInput(entry));
}

export function formatRuntimePresetSetting(preset: RuntimePresetConfig): string {
  return `${preset.id}${preset.label ? `:${preset.label}` : ""}=${preset.runtime}`;
}

function clearConfigValue(
  config: OpenScoutUserConfig,
  key: keyof OpenScoutUserConfig,
): void {
  delete config[key];
}

export const USER_CONFIG_FIELDS: readonly UserConfigFieldDefinition[] = [
  {
    id: "name",
    key: "name",
    label: "Display name",
    kind: "string",
    summary: "Operator display name",
    showInSummary: true,
    parse: parseStringValue,
    resolveGet: () => resolveOperatorName(),
    formatSummary: (config) => {
      const resolved = resolveOperatorName();
      return `${resolved}${config.name ? "" : " (default)"}`;
    },
  },
  {
    id: "handle",
    key: "handle",
    label: "Handle",
    kind: "string",
    summary: "Operator @mention handle",
    showInSummary: true,
    parse: parseStringValue,
    resolveGet: () => resolveOperatorHandle(),
    formatSummary: (config) => {
      const resolved = resolveOperatorHandle();
      return `@${resolved}${config.handle ? "" : " (default)"}`;
    },
  },
  {
    id: "pronouns",
    key: "pronouns",
    label: "Pronouns",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.pronouns),
    formatSummary: (config) => formatStoredString(config.pronouns) || "—",
  },
  {
    id: "hue",
    key: "hue",
    label: "Identity hue",
    kind: "number",
    parse: parseNumberValue,
    resolveGet: (config) => formatStoredNumber(config.hue),
    formatSummary: (config) => formatStoredNumber(config.hue) || "195 (default)",
  },
  {
    id: "bio",
    key: "bio",
    label: "Operator bio",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.bio),
    formatSummary: (config) => formatStoredString(config.bio) || "—",
  },
  {
    id: "timezone",
    key: "timezone",
    label: "Timezone",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.timezone),
    formatSummary: (config) => formatStoredString(config.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  {
    id: "working-hours",
    key: "workingHours",
    label: "Working hours",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.workingHours),
    formatSummary: (config) => formatStoredString(config.workingHours) || "08:00 – 18:00 (default)",
  },
  {
    id: "interrupt-threshold",
    key: "interruptThreshold",
    label: "Interrupt threshold",
    kind: "enum",
    enumValues: INTERRUPT_THRESHOLDS,
    parse: (args) => parseEnumValue(args, INTERRUPT_THRESHOLDS),
    resolveGet: (config) => formatStoredEnum(config.interruptThreshold),
    formatSummary: (config) => formatStoredEnum(config.interruptThreshold) || "blocking-only (default)",
    apply: (config, value) => {
      setConfigValue(config, "interruptThreshold", value as InterruptThreshold);
    },
  },
  {
    id: "tail-thinking",
    key: "tailThinking",
    label: "Tail thinking beats",
    kind: "enum",
    enumValues: TAIL_THINKING_MODES,
    summary: "Show a marker for thinking the model returned without text (hide | tag)",
    parse: (args) => parseEnumValue(args, TAIL_THINKING_MODES),
    resolveGet: (config) => formatStoredEnum(config.tailThinking),
    formatSummary: (config) => formatStoredEnum(config.tailThinking) || "hide (default)",
    apply: (config, value) => {
      setConfigValue(config, "tailThinking", value as TailThinkingMode);
    },
  },
  {
    id: "batch-window",
    key: "batchWindow",
    label: "Batch window",
    kind: "number",
    parse: parseNumberValue,
    resolveGet: (config) => formatStoredNumber(config.batchWindow),
    formatSummary: (config) => formatStoredNumber(config.batchWindow) || "15 (default)",
  },
  {
    id: "channel",
    key: "channel",
    label: "Comms channel",
    kind: "enum",
    enumValues: COMMS_CHANNELS,
    parse: (args) => parseEnumValue(args, COMMS_CHANNELS),
    resolveGet: (config) => formatStoredEnum(config.channel),
    formatSummary: (config) => formatStoredEnum(config.channel) || "here+mobile (default)",
    apply: (config, value) => {
      setConfigValue(config, "channel", value as CommsChannel);
    },
  },
  {
    id: "verbosity",
    key: "verbosity",
    label: "Comms verbosity",
    kind: "enum",
    enumValues: COMMS_VERBOSITIES,
    parse: (args) => parseEnumValue(args, COMMS_VERBOSITIES),
    resolveGet: (config) => formatStoredEnum(config.verbosity),
    formatSummary: (config) => formatStoredEnum(config.verbosity) || "terse (default)",
    apply: (config, value) => {
      setConfigValue(config, "verbosity", value as CommsVerbosity);
    },
  },
  {
    id: "tone",
    key: "tone",
    label: "Comms tone",
    kind: "enum",
    enumValues: COMMS_TONES,
    parse: (args) => parseEnumValue(args, COMMS_TONES),
    resolveGet: (config) => formatStoredEnum(config.tone),
    formatSummary: (config) => formatStoredEnum(config.tone) || "direct (default)",
    apply: (config, value) => {
      setConfigValue(config, "tone", value as CommsTone);
    },
  },
  {
    id: "quiet-hours",
    key: "quietHours",
    label: "Quiet hours",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.quietHours),
    formatSummary: (config) => formatStoredString(config.quietHours) || "22:00 – 07:00 (default)",
  },
  {
    id: "agent-names",
    key: "provisionalAgentNames",
    label: "Ephemeral agent names",
    kind: "string-list",
    summary: "Comma-separated rotation pool for one-off agents",
    showInSummary: true,
    parse: (args) => parseCommaSeparatedList(args),
    resolveGet: (config) => formatStoredStringList(config.provisionalAgentNames),
    formatSummary: (config) => describeProvisionalAgentNamePool(config),
    apply: (config, value) => {
      const names = Array.isArray(value) ? normalizeProvisionalAgentNamesSetting(value) : [];
      if (names.length === 0) {
        clearConfigValue(config, "provisionalAgentNames");
      } else {
        setConfigValue(config, "provisionalAgentNames", names);
      }
    },
    clear: (config) => clearConfigValue(config, "provisionalAgentNames"),
  },
  {
    id: "agent-names-mode",
    key: "provisionalAgentNamesMode",
    label: "Ephemeral agent name pool mode",
    kind: "enum",
    enumValues: AGENT_NAME_MODES,
    summary: "replace = your list only; extend = yours then Scout defaults",
    parse: (args) => parseEnumValue(args, AGENT_NAME_MODES),
    resolveGet: (config) => formatStoredEnum(config.provisionalAgentNamesMode) || "replace",
    formatSummary: (config) => formatStoredEnum(config.provisionalAgentNamesMode) || "replace (default)",
    apply: (config, value) => {
      setConfigValue(config, "provisionalAgentNamesMode", value as ProvisionalAgentNamesMode);
    },
  },
  {
    id: "agent-names-file",
    key: "provisionalAgentNamesFile",
    label: "Ephemeral agent names file",
    kind: "string",
    summary: "Advanced JSON pool override path",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.provisionalAgentNamesFile),
    formatSummary: (config) => formatStoredString(config.provisionalAgentNamesFile) || "—",
  },
  {
    id: "runtime-shortlist",
    key: "runtimeShortlist",
    label: "Runtime model shortlist",
    kind: "string-list",
    summary: "Models pinned first in runtime pickers (<harness>[/<model>], comma-separated)",
    parse: (args) =>
      normalizeRuntimeShortlistInput(
        args.join(" ").split(",").map((entry) => entry.trim()).filter(Boolean),
      ),
    resolveGet: (config) => (config.runtimeShortlist ?? []).join(", "),
    formatSummary: (config) => (config.runtimeShortlist ?? []).join(", ") || "—",
    formatValue: (value) => (Array.isArray(value) ? value.join(", ") : ""),
    apply: (config, value) => {
      const specs = normalizeRuntimeShortlistInput(value);
      if (specs.length === 0) {
        clearConfigValue(config, "runtimeShortlist");
      } else {
        setConfigValue(config, "runtimeShortlist", specs);
      }
    },
    clear: (config) => clearConfigValue(config, "runtimeShortlist"),
  },
  {
    id: "runtime-presets",
    key: "runtimePresets",
    label: "Runtime presets",
    kind: "string-list",
    summary: "Named runtime tuples: id[:Label]=<harness>[/<model>[/<effort>]], comma-separated",
    parse: (args) =>
      normalizeRuntimePresetsInput(
        args.join(" ").split(",").map((entry) => entry.trim()).filter(Boolean),
      ),
    resolveGet: (config) =>
      (config.runtimePresets ?? []).map(formatRuntimePresetSetting).join(", "),
    formatSummary: (config) =>
      (config.runtimePresets ?? []).map(formatRuntimePresetSetting).join(", ") || "—",
    formatValue: (value) =>
      Array.isArray(value) ? value.map(formatRuntimePresetSetting).join(", ") : "",
    apply: (config, value) => {
      const presets = normalizeRuntimePresetsInput(value);
      if (presets.length === 0) {
        clearConfigValue(config, "runtimePresets");
      } else {
        setConfigValue(config, "runtimePresets", presets);
      }
    },
    clear: (config) => clearConfigValue(config, "runtimePresets"),
  },
  {
    id: "worktree-retire",
    key: "worktreeRetire",
    label: "Retire idle agent worktrees",
    kind: "enum",
    enumValues: WORKTREE_RETIRE_MODES,
    summary: "Remove idle, clean, merged .scout-worktrees on a schedule (on | off)",
    showInSummary: true,
    parse: (args) => parseEnumValue(args, WORKTREE_RETIRE_MODES),
    resolveGet: (config) => formatStoredEnum(config.worktreeRetire),
    formatSummary: (config) => {
      const mode = formatStoredEnum(config.worktreeRetire) || "on (default)";
      const hours = formatStoredNumber(config.worktreeRetireIdleHours) || "24";
      return `${mode}, after ${hours}h idle`;
    },
    apply: (config, value) => {
      if (value === undefined) clearConfigValue(config, "worktreeRetire");
      else setConfigValue(config, "worktreeRetire", value as WorktreeRetireMode);
    },
  },
  {
    id: "worktree-retire-idle-hours",
    key: "worktreeRetireIdleHours",
    label: "Worktree idle hours",
    kind: "number",
    parse: (args) => {
      const value = parseNumberValue(args);
      if (value !== undefined && value < 1) throw new Error("expected at least 1 hour");
      return value;
    },
    resolveGet: (config) => formatStoredNumber(config.worktreeRetireIdleHours),
    formatSummary: (config) => formatStoredNumber(config.worktreeRetireIdleHours) || "24 (default)",
  },
] as const;

const USER_CONFIG_FIELD_INDEX = new Map<string, UserConfigFieldDefinition>(
  USER_CONFIG_FIELDS.flatMap((field) => [
    [field.id, field],
    ...(field.aliases ?? []).map((alias) => [alias, field] as const),
  ]),
);

export function findUserConfigField(id: string): UserConfigFieldDefinition | undefined {
  return USER_CONFIG_FIELD_INDEX.get(id.trim());
}

export function listUserConfigFieldIds(): string[] {
  return USER_CONFIG_FIELDS.map((field) => field.id);
}

export function parseUserConfigFieldValue(
  field: UserConfigFieldDefinition,
  args: string[],
): unknown {
  if (args.length === 0) {
    return undefined;
  }
  const parser = field.parse ?? defaultParserForKind(field);
  return parser(args);
}

function defaultParserForKind(field: UserConfigFieldDefinition): (args: string[]) => unknown {
  switch (field.kind) {
    case "string":
      return parseStringValue;
    case "number":
      return parseNumberValue;
    case "enum":
      if (!field.enumValues?.length) {
        throw new Error(`field ${field.id} is missing enumValues`);
      }
      return (args) => parseEnumValue(args, field.enumValues!);
    case "string-list":
      return parseCommaSeparatedList;
    default:
      return parseStringValue;
  }
}

export function applyUserConfigField(
  config: OpenScoutUserConfig,
  field: UserConfigFieldDefinition,
  value: unknown,
): void {
  if (field.apply) {
    field.apply(config, value);
    return;
  }

  if (value === undefined) {
    clearUserConfigField(config, field);
    return;
  }

  setConfigValue(config, field.key, value as OpenScoutUserConfig[typeof field.key]);
}

export function clearUserConfigField(
  config: OpenScoutUserConfig,
  field: UserConfigFieldDefinition,
): void {
  if (field.clear) {
    field.clear(config);
    return;
  }
  clearConfigValue(config, field.key);
}

export function formatUserConfigFieldGet(
  field: UserConfigFieldDefinition,
  config: OpenScoutUserConfig = loadUserConfig(),
): string {
  if (field.resolveGet) {
    return field.resolveGet(config);
  }
  const value = config[field.key];
  return formatUserConfigFieldValue(field, value);
}

export function formatUserConfigFieldValue(
  field: UserConfigFieldDefinition,
  value: unknown,
): string {
  if (field.formatValue) {
    return field.formatValue(value);
  }
  switch (field.kind) {
    case "number":
      return value === undefined || value === null ? "" : String(value);
    case "string-list":
      return formatStoredStringList(Array.isArray(value) ? value : undefined);
    case "enum":
    case "string":
      return typeof value === "string" ? value : "";
    default:
      return value === undefined || value === null ? "" : String(value);
  }
}

export function formatUserConfigFieldSummary(
  field: UserConfigFieldDefinition,
  config: OpenScoutUserConfig = loadUserConfig(),
): string {
  if (field.formatSummary) {
    return field.formatSummary(config);
  }
  return formatUserConfigFieldGet(field, config) || "—";
}

export function formatUserConfigSetMessage(
  field: UserConfigFieldDefinition,
  value: unknown,
): string {
  if (value === undefined) {
    if (field.id === "name") {
      return `Name reset to default: ${resolveOperatorName()}`;
    }
    if (field.id === "handle") {
      return `Handle reset to default: @${resolveOperatorHandle()}`;
    }
    if (field.id === "agent-names") {
      return "agent-names cleared (built-in pool)";
    }
    return `${field.id} cleared`;
  }

  const formatted = formatUserConfigFieldValue(field, value);
  if (field.id === "name") {
    return `Name set to: ${formatted}`;
  }
  if (field.id === "handle") {
    return `Handle set to: ${formatted}`;
  }
  return `${field.id} set to: ${formatted || "(empty)"}`;
}

export function listUserConfigSummaryLines(
  config: OpenScoutUserConfig = loadUserConfig(),
): string[] {
  return USER_CONFIG_FIELDS
    .filter((field) => field.showInSummary)
    .map((field) => `${field.id}: ${formatUserConfigFieldSummary(field, config)}`);
}

const USER_CONFIG_FIELD_AFTER_SET: Partial<
  Record<string, UserConfigFieldAfterSetHook>
> = {};

export function registerUserConfigFieldAfterSet(
  id: string,
  hook: UserConfigFieldAfterSetHook,
): void {
  USER_CONFIG_FIELD_AFTER_SET[id] = hook;
}

export async function runUserConfigFieldAfterSet(
  field: UserConfigFieldDefinition,
  context: UserConfigFieldSaveContext,
  value: unknown,
): Promise<void> {
  const hook = USER_CONFIG_FIELD_AFTER_SET[field.id];
  if (!hook) return;
  await hook(context, value);
}

export function formatUserConfigUsageLines(): string[] {
  const ids = listUserConfigFieldIds();
  return [
    "usage: scout config [show]",
    "       scout config list",
    "       scout config get <id>",
    "       scout config set <id> [value]",
    "       scout config agent-names [show]",
    "       scout config agent-names init [--empty] [--extend]",
    "       scout config set agent-names-init-file [--empty]",
    "",
    "ids:",
    ...ids.map((id) => `  ${id}`),
  ];
}