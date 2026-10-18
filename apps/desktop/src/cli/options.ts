import { parseSetupCommandOptions as parseLifecycleSetupOptions } from "../../../../packages/cli/bin/lifecycle-preflight.mjs";
import { resolve } from "node:path";

import {
  epochMs,
  type ScoutCompletionRequest,
  type ScoutCompletionRelation,
  normalizeAgentSelectorSegment,
  normalizeReservedRuntimeProfileId,
  normalizeRuntimeProfileReasoningEffort,
  isScoutLaunchableHarness,
  parseScoutRuntimeSpec,
  parseScoutComposerRoute,
  parseScoutComposerRouteTarget,
  SCOUT_RESERVED_RUNTIME_PROFILE_IDS,
} from "@openscout/protocol";

import { ScoutCliError } from "./errors.ts";

type ContextRootOptions = {
  currentDirectory: string;
  args: string[];
};

type TargetableMessageOptions = ContextRootOptions & {
  agentName: string | null;
  targetLabel?: string;
  targetRef?: string;
  channel?: string;
  harness?: string;
  shouldSpeak: boolean;
  wake: boolean;
  message: string;
  messageFile?: string;
  aliasProject?: string;
  aliasHost?: string;
};

export type ScoutSendCommandOptions = TargetableMessageOptions & {
  /** Opt in to tracked work on the ask invocation lifecycle. */
  tracked: boolean;
  noNotifs: boolean;
  wait: boolean;
  timeoutSeconds?: number;
};

export type ScoutTellCommandOptions = TargetableMessageOptions;

export type ScoutSetupCommandOptions = {
  currentDirectory: string;
  sourceRoots: string[];
  defaultHarness: string | null;
};

export type ScoutAskCommandOptions = ContextRootOptions & {
  agentName: string | null;
  requestId?: string;
  completion?: ScoutCompletionRequest;
  relation?: ScoutCompletionRelation;
  targetLabel?: string;
  existingTargetHandle?: string;
  runtimeProfile?: string;
  runtimeLiteral?: string;
  executionSource?: Partial<Record<"harness" | "model" | "reasoningEffort", "flag" | "literal">>;
  model?: string;
  reasoningEffort?: string;
  targetRef?: string;
  projectPath?: string;
  channel?: string;
  harness?: string;
  session?: "new";
  timeoutSeconds?: number;
  replyMode?: "inline" | "notify" | "none";
  placement?: "background" | "foreground" | "attached";
  labels?: string[];
  message: string;
  promptFile?: string;
  aliasProject?: string;
  aliasHost?: string;
  /** `--on <host>`: start the session on that mesh machine; --project is a path there. */
  onHost?: string;
};

export type ScoutImplicitAskCommandOptions = ScoutAskCommandOptions;

export type ScoutWatchCommandOptions = ContextRootOptions & {
  agentName: string | null;
  channel?: string;
  conversationId?: string;
  since?: number;
  limit?: number;
  once: boolean;
};

export type ScoutChannelCommandOptions = ContextRootOptions & {
  channel?: string;
  latest?: number;
  markRead: boolean;
};

export type ScoutInboxCommandOptions = ContextRootOptions & {
  agentName: string | null;
  latest: number;
  since?: number;
};

export type ScoutLatestCommandOptions = ContextRootOptions & {
  agentId?: string;
  actorId?: string;
  channel?: string;
  conversationId?: string;
  limit: number;
  messages: boolean;
};

export type ScoutCardCreateCommandOptions = ContextRootOptions & {
  projectPath: string;
  agentName?: string;
  displayName?: string;
  harness?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  permissionProfile?: string;
  requesterId: string | null;
  noInput?: boolean;
  oneTimeUse?: boolean;
};

export type ScoutMonitorCommandOptions = ContextRootOptions & {
  channel?: string;
  limit: number;
  intervalMs: number;
};

export type ScoutDoctorCommandOptions = ContextRootOptions & {
  detail: boolean;
  json: boolean;
  fix: boolean;
  yes: boolean;
};

function missingFlagValue(flag: string): never {
  throw new ScoutCliError(`missing value for ${flag}`);
}

function unexpectedArgs(commandName: string, args: string[]): never {
  throw new ScoutCliError(`unexpected arguments for ${commandName}: ${args.join(" ")}`);
}

function parseFlagValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index] ?? "";
  if (current === flag) {
    const value = args[index + 1];
    if (!value) {
      missingFlagValue(flag);
    }
    return { value, nextIndex: index + 1 };
  }

  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    return { value: current.slice(prefix.length), nextIndex: index };
  }

  missingFlagValue(flag);
}

function parseSinceTimestamp(value: string): number {
  const trimmed = value.trim();
  const duration = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (duration) {
    const amount = Number.parseFloat(duration[1] ?? "");
    const unit = (duration[2] ?? "").toLowerCase();
    const unitMs = unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
    return Date.now() - amount * unitMs;
  }

  const parsedEpoch = epochMs(trimmed);
  if (parsedEpoch !== null) {
    return parsedEpoch;
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return parsedDate;
  }

  throw new ScoutCliError(`invalid since value: ${value}`);
}

function appendLabelValues(target: string[], value: string): void {
  for (const entry of value.split(",")) {
    const label = entry.trim();
    if (label && !target.includes(label)) {
      target.push(label);
    }
  }
}

function flagNameFor(current: string, flagNames: readonly string[]): string | null {
  return flagNames.find((flag) => current === flag || current.startsWith(`${flag}=`)) ?? null;
}

function resolveInputFilePath(
  currentDirectory: string,
  filePath: string,
): string {
  return resolve(currentDirectory, filePath);
}

function rejectMixedBodySources(kind: "message" | "question"): never {
  throw new ScoutCliError(
    kind === "message"
      ? "provide either an inline message or --message-file/--body-file, not both"
      : "provide either an inline question or --prompt-file/--body-file, not both",
  );
}

function parseAskSessionPreference(
  value: string,
): NonNullable<ScoutAskCommandOptions["session"]> {
  if (value === "new") {
    return value;
  }
  throw new ScoutCliError(`invalid session: ${value}`);
}

function mergeAskSessionPreference(
  current: ScoutAskCommandOptions["session"],
  next: NonNullable<ScoutAskCommandOptions["session"]>,
): NonNullable<ScoutAskCommandOptions["session"]> {
  if (current && current !== next) {
    throw new ScoutCliError("provide only one ask session preference");
  }
  return next;
}

function shouldInferCurrentProjectAskTarget(input: {
  targetLabel?: string | null;
  projectPath?: string;
  harness?: string;
  model?: string;
  reasoningEffort?: string;
  session?: ScoutAskCommandOptions["session"];
}): boolean {
  return !input.targetLabel
    && !input.projectPath
    && Boolean(input.harness || input.model || input.reasoningEffort || input.session);
}

type NaturalLanguageAskTarget =
  | {
      kind: "existing_handle";
      handle: string;
      message: string;
    }
  | {
      kind: "runtime_profile";
      profile: string;
      reasoningEffort?: string;
      message: string;
    }
  | {
      kind: "runtime_spec";
      literal: string;
      harness: string;
      model?: string;
      reasoningEffort?: string;
      message: string;
    };

function parseNaturalLanguageAskTarget(
  input: string,
  options: { allowMissingMessage?: boolean } = {},
): NaturalLanguageAskTarget | null {
  const trimmed = input.trim();
  if (/^agent\b/i.test(trimmed)) {
    const match = trimmed.match(/^agent\s+(.+?)\s+to(?:\s+(.+))?$/i);
    if (!match) {
      throw new ScoutCliError(
        'existing-target asks use "agent <name> to <request>"',
      );
    }
    const handle = normalizeAgentSelectorSegment(match[1] ?? "");
    const message = (match[2] ?? "").trim();
    if (!handle || (!message && !options.allowMissingMessage)) {
      throw new ScoutCliError(
        'existing-target asks use "agent <name> to <request>"',
      );
    }
    return { kind: "existing_handle", handle, message };
  }

  const leadingToken = trimmed.match(/^(\S+)(?:\s+|$)([\s\S]*)$/u);
  const runtimeToken = leadingToken?.[1] ?? "";
  const runtimeCandidate = runtimeToken.includes("/")
    || (isScoutLaunchableHarness(runtimeToken) && !normalizeReservedRuntimeProfileId(runtimeToken))
    ? parseScoutRuntimeSpec(runtimeToken)
    : null;
  if (runtimeCandidate?.ok) {
    const message = (leadingToken?.[2] ?? "").replace(/^to\b[\s,;:-]*/i, "").trim();
    if (!message && !options.allowMissingMessage) {
      throw new ScoutCliError(`runtime ${runtimeToken} requires a request`);
    }
    return {
      kind: "runtime_spec",
      literal: runtimeToken,
      ...runtimeCandidate.value,
      message,
    };
  }
  if (runtimeCandidate && !runtimeCandidate.ok) {
    throw new ScoutCliError(runtimeCandidate.error);
  }

  const firstToken = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)(.*)$/s);
  const profile = firstToken
    ? normalizeReservedRuntimeProfileId(firstToken[1] ?? "")
    : null;
  if (!profile) {
    return null;
  }

  let remainder = (firstToken?.[2] ?? "").replace(/^[\s,;:-]+/, "");
  let reasoningEffort: string | undefined;
  const withEffort = remainder.match(/^with\s+(\S+)\s+effort\b[\s,;:-]*/i);
  if (withEffort) {
    const normalized = normalizeRuntimeProfileReasoningEffort(withEffort[1] ?? "");
    if (!normalized) {
      throw new ScoutCliError(`invalid runtime profile effort: ${withEffort[1]}`);
    }
    reasoningEffort = normalized;
    remainder = remainder.slice(withEffort[0].length);
  } else {
    const effortToken = remainder.match(/^(\S+)(?:\s+|$)/);
    const normalized = effortToken
      ? normalizeRuntimeProfileReasoningEffort(effortToken[1] ?? "")
      : null;
    if (normalized && effortToken) {
      reasoningEffort = normalized;
      remainder = remainder.slice(effortToken[0].length);
    }
  }

  const message = remainder.replace(/^to\b[\s,;:-]*/i, "").trim();
  if (!message && !options.allowMissingMessage) {
    throw new ScoutCliError(`runtime profile ${profile} requires a request`);
  }
  return {
    kind: "runtime_profile",
    profile,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    message,
  };
}

function parseRuntimeProfileFlag(value: string): string {
  const profile = normalizeReservedRuntimeProfileId(value);
  if (!profile) {
    throw new ScoutCliError(
      `unknown runtime profile: ${value}; expected ${SCOUT_RESERVED_RUNTIME_PROFILE_IDS.join(", ")}`,
    );
  }
  return profile;
}

function parseRuntimeProfileEffortFlag(value: string): string {
  const effort = normalizeRuntimeProfileReasoningEffort(value);
  if (!effort) {
    throw new ScoutCliError(`invalid runtime profile effort: ${value}`);
  }
  return effort;
}

function parseRuntimeLiteralFlag(value: string) {
  const parsed = parseScoutRuntimeSpec(value);
  if (!parsed.ok) {
    throw new ScoutCliError(`runtime_spec_invalid: ${parsed.error}`);
  }
  return parsed.value;
}

function mergeRuntimeDimension(
  dimension: string,
  explicitValue: string | undefined,
  literalValue: string | undefined,
): string | undefined {
  if (explicitValue && literalValue && explicitValue.toLowerCase() !== literalValue.toLowerCase()) {
    throw new ScoutCliError(
      `runtime_conflict: conflicting runtime ${dimension}: explicit ${explicitValue} and literal ${literalValue}`,
    );
  }
  return explicitValue ?? literalValue;
}

function mergeRuntimeProfileReasoningEffort(
  flagEffort: string | undefined,
  naturalEffort: string | undefined,
): string | undefined {
  if (flagEffort && naturalEffort && flagEffort !== naturalEffort) {
    throw new ScoutCliError(
      `runtime_conflict: conflicting runtime profile efforts: --effort ${flagEffort} and natural-language effort ${naturalEffort}`,
    );
  }
  return naturalEffort ?? flagEffort;
}

function rejectUnsupportedRuntimeProfileEffort(
  profile: string,
  reasoningEffort: string | undefined,
): void {
  // Grok takes effort over ACP on `session/set_model`; the others expose no
  // equivalent through their transports.
  if (reasoningEffort && (profile === "kimi" || profile === "oc" || profile === "opencode")) {
    throw new ScoutCliError(
      `reasoning_effort_harness_mismatch: ${profile} runtime profile does not support reasoning effort through its ACP transport`,
    );
  }
}

function parseContextRootPrefix(
  args: string[],
  defaultCurrentDirectory: string,
): ContextRootOptions {
  let currentDirectory = defaultCurrentDirectory;
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (current === "--context-root" || current.startsWith("--context-root=")) {
      const parsed = parseFlagValue(args, index, "--context-root");
      currentDirectory = resolve(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    rest.push(current);
  }

  return { currentDirectory, args: rest };
}

const SCOUT_MENTION_PATTERN = /(^|[\s([{'"`])@([A-Za-z0-9][A-Za-z0-9._/:-]*(?:#[A-Za-z0-9][A-Za-z0-9._/:-]*)?(?:\?[A-Za-z0-9][A-Za-z0-9._/:-]*)?)(?=$|[\s)\]}",.!?:;'"`])/g;

type MentionMatch = {
  label: string;
  start: number;
  end: number;
};

function extractMentionTargets(input: string): MentionMatch[] {
  const matches: MentionMatch[] = [];

  for (const match of input.matchAll(SCOUT_MENTION_PATTERN)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const label = match[2] ?? "";
    const start = match.index ?? 0;
    matches.push({
      label,
      start: start + prefix.length,
      end: start + fullMatch.length,
    });
  }

  return matches;
}

function stripMention(input: string, mention: MentionMatch): string {
  const before = input.slice(0, mention.start);
  const after = input.slice(mention.end);
  return `${before}${after}`.replace(/\s+/g, " ").trim();
}

type ComposerRoutedBody = {
  targetLabel?: string;
  targetRef?: string;
  projectPath?: string;
  channel?: string;
  message: string;
};

function mergeComposerChannel(
  existing: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!next) {
    return existing;
  }
  if (existing && existing !== next) {
    throw new ScoutCliError(`route channel ${next} conflicts with --channel ${existing}`);
  }
  return next;
}

function parseComposerRoutedBody(
  input: string,
  commandName: "ask" | "send",
  currentDirectory: string,
): ComposerRoutedBody | null {
  const parsed = parseScoutComposerRoute(input);
  if (!parsed.route) {
    const [diagnostic] = parsed.diagnostics;
    if (diagnostic) {
      throw new ScoutCliError(diagnostic.message);
    }
    return null;
  }

  const { target } = parsed.route;
  if (target.kind === "agent_label") {
    return {
      targetLabel: target.label,
      message: parsed.body,
    };
  }
  if (target.kind === "existing_handle" || target.kind === "runtime_profile") {
    throw new ScoutCliError(`${target.kind} is an internal ask route and cannot be used with >>`);
  }
  if (target.kind === "route_alias") {
    return {
      targetLabel: target.value ?? `alias:${target.alias}`,
      message: parsed.body,
    };
  }
  if (target.kind === "target_handle") {
    return {
      targetLabel: target.value ?? `target:${target.handle}`,
      message: parsed.body,
    };
  }
  if (target.kind === "binding_ref") {
    return {
      targetLabel: `ref:${target.ref}`,
      targetRef: target.ref,
      message: parsed.body,
    };
  }
  if (target.kind === "session_id") {
    if (commandName === "send") {
      throw new ScoutCliError("send route operator must target an agent label, target handle, ref, channel, or broadcast");
    }
    return {
      targetLabel: target.value ?? `session:${target.sessionId}`,
      message: parsed.body,
    };
  }
  if (target.kind === "project_path") {
    if (commandName === "send") {
      throw new ScoutCliError("send route operator must target an agent label, target handle, ref, channel, or broadcast");
    }
    return {
      projectPath: resolveInputFilePath(currentDirectory, target.projectPath),
      message: parsed.body,
    };
  }
  if (target.kind === "channel") {
    if (commandName === "ask") {
      throw new ScoutCliError("ask route operator must target an agent label, target handle, ref, or project path");
    }
    return {
      channel: target.channel,
      message: parsed.body,
    };
  }
  if (target.kind === "broadcast") {
    if (commandName === "ask") {
      throw new ScoutCliError("ask route operator must target an agent label, target handle, ref, or project path");
    }
    return {
      channel: "shared",
      message: parsed.body,
    };
  }

  throw new ScoutCliError(
    `${commandName} route operator does not support agent id targets yet; use an agent label, target handle, ref, or project path`,
  );
}

export function parseSetupCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutSetupCommandOptions {
  try { return parseLifecycleSetupOptions(args, defaultCurrentDirectory); }
  catch (error) { throw new ScoutCliError((error as Error).message); }
}

export function parseContextRootCommandOptions(
  commandName: string,
  args: string[],
  defaultCurrentDirectory: string,
): ContextRootOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  if (parsed.args.length > 0) {
    unexpectedArgs(commandName, args);
  }
  return parsed;
}

export function parseWhoCommandOptions(args: string[], defaultCurrentDirectory: string): ContextRootOptions & { machine?: string } {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let machine: string | undefined;
  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index]!;
    if (current === "--machine" || current.startsWith("--machine=")) {
      const flag = parseFlagValue(parsed.args, index, "--machine");
      if (!flag.value.trim() || flag.value.startsWith("--")) missingFlagValue("--machine");
      machine = flag.value.trim();
      index = flag.nextIndex;
    } else {
      unexpectedArgs("who", args);
    }
  }
  return { ...parsed, machine };
}

export function parseDoctorCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutDoctorCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let detail = false;
  let json = false;
  let fix = false;
  let yes = false;

  for (const current of parsed.args) {
    if (current === "--detail") { detail = true; continue; }
    if (current === "--json") {
      json = true;
      continue;
    }
    if (current === "--fix") {
      fix = true;
      continue;
    }
    if (current === "--yes" || current === "-y") {
      yes = true;
      continue;
    }
    unexpectedArgs("doctor", args);
  }

  if (yes && !fix) {
    throw new ScoutCliError("--yes requires --fix");
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    detail,
    json,
    fix,
    yes,
  };
}

export function parseSendCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutSendCommandOptions {
  return parseTargetableMessageCommandOptions("send", args, defaultCurrentDirectory);
}

export function parseTellCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutTellCommandOptions {
  const {
    tracked: _tracked,
    noNotifs: _noNotifs,
    wait: _wait,
    timeoutSeconds: _timeout,
    ...options
  } = parseTargetableMessageCommandOptions("tell", args, defaultCurrentDirectory);
  return options;
}

const SEND_TRACKED_FLAGS = ["--tracked", "--no-notifs", "--wait", "--timeout"] as const;
const REPEATED_DESTINATION_ERROR =
  "provide exactly one destination: repeated --to/--ref flags are not merged (use --channel for a group thread)";

function parseTargetableMessageCommandOptions(
  commandName: "send" | "tell",
  args: string[],
  defaultCurrentDirectory: string,
): ScoutSendCommandOptions {
  const allowTrackedFlags = commandName === "send";
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let agentName: string | null = null;
  let targetLabel: string | undefined;
  let targetRef: string | undefined;
  let channel: string | undefined;
  let shouldSpeak = false;
  let wake = false;
  let tracked = false;
  let noNotifs = false;
  let wait = false;
  let timeoutSeconds: number | undefined;
  let harness: string | undefined;
  let messageFile: string | undefined;
  let aliasProject: string | undefined;
  let aliasHost: string | undefined;
  const messageParts: string[] = [];

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (
      !allowTrackedFlags
      && SEND_TRACKED_FLAGS.some((flag) => current === flag || current.startsWith(`${flag}=`))
    ) {
      throw new ScoutCliError(
        `${current.split("=")[0]} is for work: use \`scout ask\` (\`--notify\` to return right away); \`scout tell\` posts a message only and never creates work`,
      );
    }
    if (allowTrackedFlags && current === "--tracked") {
      tracked = true;
      continue;
    }
    if (allowTrackedFlags && current === "--no-notifs") {
      noNotifs = true;
      continue;
    }
    if (allowTrackedFlags && current === "--wait") {
      wait = true;
      continue;
    }
    if (allowTrackedFlags && (current === "--timeout" || current.startsWith("--timeout="))) {
      const value = parseFlagValue(parsed.args, index, "--timeout");
      const parsedTimeout = Number(value.value);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        throw new ScoutCliError("--timeout must be a positive number of seconds");
      }
      timeoutSeconds = parsedTimeout;
      index = value.nextIndex;
      continue;
    }
    if (current === "--as" || current.startsWith("--as=")) {
      const value = parseFlagValue(parsed.args, index, "--as");
      agentName = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--to" || current.startsWith("--to=")) {
      if (targetLabel !== undefined) {
        throw new ScoutCliError(REPEATED_DESTINATION_ERROR);
      }
      const value = parseFlagValue(parsed.args, index, "--to");
      targetLabel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--ref" || current.startsWith("--ref=")) {
      if (targetLabel !== undefined) {
        throw new ScoutCliError(REPEATED_DESTINATION_ERROR);
      }
      const value = parseFlagValue(parsed.args, index, "--ref");
      targetRef = value.value.replace(/^ref:/, "");
      targetLabel = `ref:${targetRef}`;
      index = value.nextIndex;
      continue;
    }
    if (current === "--channel" || current.startsWith("--channel=")) {
      const value = parseFlagValue(parsed.args, index, "--channel");
      channel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--harness" || current.startsWith("--harness=")) {
      const value = parseFlagValue(parsed.args, index, "--harness");
      harness = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--alias-project" || current.startsWith("--alias-project=")) {
      const value = parseFlagValue(parsed.args, index, "--alias-project");
      aliasProject = resolveInputFilePath(parsed.currentDirectory, value.value);
      index = value.nextIndex;
      continue;
    }
    if (current === "--alias-host" || current.startsWith("--alias-host=")) {
      const value = parseFlagValue(parsed.args, index, "--alias-host");
      aliasHost = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--speak") {
      shouldSpeak = true;
      continue;
    }
    if (current === "--wake") {
      if (!allowTrackedFlags) {
        throw new ScoutCliError(
          "--wake forces a dispatch turn; `scout tell` never wakes or launches a target. Use `scout ask` when the target should act",
        );
      }
      wake = true;
      continue;
    }
    const fileFlag = flagNameFor(current, ["--message-file", "--body-file"]);
    if (fileFlag) {
      if (messageFile) {
        throw new ScoutCliError("message file was provided more than once");
      }
      const value = parseFlagValue(parsed.args, index, fileFlag);
      messageFile = resolveInputFilePath(parsed.currentDirectory, value.value);
      index = value.nextIndex;
      continue;
    }
    messageParts.push(current);
  }

  let message = messageParts.join(" ").trim();
  if (!targetLabel && !targetRef) {
    const routed = parseComposerRoutedBody(message, "send", parsed.currentDirectory);
    if (routed) {
      targetLabel = routed.targetLabel;
      targetRef = routed.targetRef;
      channel = mergeComposerChannel(channel, routed.channel);
      message = routed.message;
    }
  }
  if (message && messageFile) {
    rejectMixedBodySources("message");
  }
  if (!message && !messageFile) {
    throw new ScoutCliError("no message provided");
  }
  if ((aliasProject || aliasHost) && parseScoutComposerRouteTarget(targetLabel ?? "")?.kind !== "route_alias") {
    throw new ScoutCliError("--alias-project/--alias-host require --to alias:<name>");
  }
  if (timeoutSeconds !== undefined && !wait) {
    throw new ScoutCliError("--timeout requires --wait");
  }
  if ((noNotifs || wait) && !tracked) {
    throw new ScoutCliError(
      `${noNotifs ? "--no-notifs" : "--wait"} applies to tracked sends; add --tracked (or use \`scout ask\`). A plain \`scout send\` is a message-only FYI.`,
    );
  }
  if (noNotifs && wait) {
    throw new ScoutCliError("--no-notifs and --wait are mutually exclusive: --wait returns the result inline");
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    agentName,
    targetLabel,
    targetRef,
    channel,
    shouldSpeak,
    wake,
    tracked,
    noNotifs,
    wait,
    timeoutSeconds,
    harness,
    message,
    messageFile,
    aliasProject,
    aliasHost,
  };
}

export function parseAskCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutAskCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let agentName: string | null = null;
  let requestId: string | undefined;
  let completion: ScoutCompletionRequest | undefined;
  let relation: ScoutCompletionRelation | undefined;
  let targetLabel: string | null = null;
  let existingTargetHandle: string | undefined;
  let runtimeProfile: string | undefined;
  let runtimeLiteral: string | undefined;
  let runtimeLiteralModel: string | undefined;
  let runtimeLiteralHarness: string | undefined;
  let runtimeLiteralEffort: string | undefined;
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let explicitHarnessFlag = false;
  let explicitModelFlag = false;
  let explicitEffortFlag = false;
  let targetRef: string | undefined;
  let projectPath: string | undefined;
  let rawProjectPath: string | undefined;
  let onHost: string | undefined;
  let channel: string | undefined;
  let harness: string | undefined;
  let session: ScoutAskCommandOptions["session"];
  let timeoutSeconds: number | undefined;
  let replyMode: ScoutAskCommandOptions["replyMode"];
  let placement: ScoutAskCommandOptions["placement"];
  let promptFile: string | undefined;
  let aliasProject: string | undefined;
  let aliasHost: string | undefined;
  const labels: string[] = [];
  const messageParts: string[] = [];

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (current === "--completion" || current.startsWith("--completion=")) {
      const value = parseFlagValue(parsed.args, index, "--completion");
      if (value.value !== "explicit") throw new ScoutCliError("--completion must be explicit");
      completion = { mode: "explicit" };
      index = value.nextIndex;
      continue;
    }
    if (current === "--join-to" || current.startsWith("--join-to=")
      || current === "--continue-for" || current.startsWith("--continue-for=")) {
      const flag = current.startsWith("--join-to") ? "--join-to" : "--continue-for";
      const value = parseFlagValue(parsed.args, index, flag);
      if (relation) throw new ScoutCliError("--join-to and --continue-for are mutually exclusive and may appear only once");
      if (!value.value.trim()) throw new ScoutCliError(`${flag} requires a parent flight id`);
      relation = { kind: flag === "--join-to" ? "joined" : "continuation", parentFlightId: value.value.trim() };
      index = value.nextIndex;
      continue;
    }
    if (current === "--request-id" || current.startsWith("--request-id=")) {
      const value = parseFlagValue(parsed.args, index, "--request-id");
      requestId = value.value.trim();
      if (!requestId || requestId.length > 256) throw new ScoutCliError("--request-id must contain 1 to 256 characters");
      index = value.nextIndex;
      continue;
    }
    if (current === "--as" || current.startsWith("--as=")) {
      const value = parseFlagValue(parsed.args, index, "--as");
      agentName = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--to" || current.startsWith("--to=")) {
      const value = parseFlagValue(parsed.args, index, "--to");
      targetLabel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--profile" || current.startsWith("--profile=")) {
      const value = parseFlagValue(parsed.args, index, "--profile");
      runtimeProfile = parseRuntimeProfileFlag(value.value);
      index = value.nextIndex;
      continue;
    }
    if (current === "--runtime" || current.startsWith("--runtime=")) {
      const value = parseFlagValue(parsed.args, index, "--runtime");
      const runtime = parseRuntimeLiteralFlag(value.value);
      runtimeLiteral = value.value;
      runtimeLiteralHarness = runtime.harness;
      runtimeLiteralModel = runtime.model;
      runtimeLiteralEffort = runtime.reasoningEffort;
      index = value.nextIndex;
      continue;
    }
    if (current === "--model" || current.startsWith("--model=")) {
      const value = parseFlagValue(parsed.args, index, "--model");
      model = value.value.trim();
      explicitModelFlag = true;
      if (!model) missingFlagValue("--model");
      index = value.nextIndex;
      continue;
    }
    const effortFlag = flagNameFor(current, ["--effort", "--reasoning-effort"]);
    if (effortFlag) {
      const value = parseFlagValue(parsed.args, index, effortFlag);
      reasoningEffort = parseRuntimeProfileEffortFlag(value.value);
      explicitEffortFlag = true;
      index = value.nextIndex;
      continue;
    }
    if (current === "--ref" || current.startsWith("--ref=")) {
      const value = parseFlagValue(parsed.args, index, "--ref");
      targetRef = value.value.replace(/^ref:/, "");
      targetLabel = `ref:${targetRef}`;
      index = value.nextIndex;
      continue;
    }
    if (current === "--project" || current.startsWith("--project=")) {
      const value = parseFlagValue(parsed.args, index, "--project");
      rawProjectPath = value.value;
      projectPath = resolveInputFilePath(parsed.currentDirectory, value.value);
      index = value.nextIndex;
      continue;
    }
    if (current === "--on" || current.startsWith("--on=") || current === "--host" || current.startsWith("--host=")) {
      const flag = current.startsWith("--host") ? "--host" : "--on";
      const value = parseFlagValue(parsed.args, index, flag);
      if (!value.value.trim() || value.value.startsWith("--")) missingFlagValue(flag);
      onHost = value.value.trim();
      index = value.nextIndex;
      continue;
    }
    if (current === "--channel" || current.startsWith("--channel=")) {
      const value = parseFlagValue(parsed.args, index, "--channel");
      channel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--harness" || current.startsWith("--harness=")) {
      const value = parseFlagValue(parsed.args, index, "--harness");
      harness = value.value;
      explicitHarnessFlag = true;
      index = value.nextIndex;
      continue;
    }
    if (current === "--alias-project" || current.startsWith("--alias-project=")) {
      const value = parseFlagValue(parsed.args, index, "--alias-project");
      aliasProject = resolveInputFilePath(parsed.currentDirectory, value.value);
      index = value.nextIndex;
      continue;
    }
    if (current === "--alias-host" || current.startsWith("--alias-host=")) {
      const value = parseFlagValue(parsed.args, index, "--alias-host");
      aliasHost = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--session" || current.startsWith("--session=")) {
      const value = parseFlagValue(parsed.args, index, "--session");
      session = mergeAskSessionPreference(
        session,
        parseAskSessionPreference(value.value),
      );
      index = value.nextIndex;
      continue;
    }
    if (current === "--new") {
      session = mergeAskSessionPreference(session, "new");
      continue;
    }
    if (current === "--timeout" || current.startsWith("--timeout=")) {
      const value = parseFlagValue(parsed.args, index, "--timeout");
      const parsedTimeout = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        throw new ScoutCliError(`invalid timeout: ${value.value}`);
      }
      timeoutSeconds = parsedTimeout;
      index = value.nextIndex;
      continue;
    }
    if (current === "--reply-mode" || current.startsWith("--reply-mode=")) {
      const value = parseFlagValue(parsed.args, index, "--reply-mode");
      if (value.value !== "inline" && value.value !== "notify" && value.value !== "none") {
        throw new ScoutCliError(`invalid reply mode: ${value.value}`);
      }
      replyMode = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--no-wait") {
      replyMode = "none";
      continue;
    }
    if (current === "--notify") {
      replyMode = "notify";
      continue;
    }
    if (current === "--placement" || current.startsWith("--placement=")) {
      const value = parseFlagValue(parsed.args, index, "--placement");
      if (value.value !== "background" && value.value !== "foreground" && value.value !== "attached") {
        throw new ScoutCliError(`invalid placement: ${value.value}`);
      }
      if (placement && placement !== value.value) {
        throw new ScoutCliError(`conflicting placement: ${placement} and ${value.value}`);
      }
      placement = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--foreground" || current === "--background") {
      const requested = current === "--foreground" ? "foreground" : "background";
      if (placement && placement !== requested) {
        throw new ScoutCliError(`conflicting placement: ${placement} and ${requested}`);
      }
      placement = requested;
      continue;
    }
    const labelFlag = flagNameFor(current, ["--label", "--labels"]);
    if (labelFlag) {
      const value = parseFlagValue(parsed.args, index, labelFlag);
      appendLabelValues(labels, value.value);
      index = value.nextIndex;
      continue;
    }
    const fileFlag = flagNameFor(current, ["--prompt-file", "--body-file"]);
    if (fileFlag) {
      if (promptFile) {
        throw new ScoutCliError("prompt file was provided more than once");
      }
      const value = parseFlagValue(parsed.args, index, fileFlag);
      promptFile = resolveInputFilePath(parsed.currentDirectory, value.value);
      index = value.nextIndex;
      continue;
    }
    messageParts.push(current);
  }

  let message = messageParts.join(" ").trim();
  if (!targetLabel && !runtimeProfile) {
    const routed = parseComposerRoutedBody(message, "ask", parsed.currentDirectory);
    if (routed) {
      targetLabel = routed.targetLabel ?? null;
      targetRef = routed.targetRef;
      projectPath = routed.projectPath;
      channel = mergeComposerChannel(channel, routed.channel);
      message = routed.message;
    }
  }
  if (!targetLabel && !runtimeProfile && !runtimeLiteral && message) {
    const natural = parseNaturalLanguageAskTarget(message, {
      allowMissingMessage: Boolean(promptFile),
    });
    if (natural?.kind === "existing_handle") {
      existingTargetHandle = natural.handle;
      message = natural.message;
    } else if (natural?.kind === "runtime_profile") {
      runtimeProfile = natural.profile;
      reasoningEffort = mergeRuntimeProfileReasoningEffort(
        reasoningEffort,
        natural.reasoningEffort,
      );
      message = natural.message;
    } else if (natural?.kind === "runtime_spec") {
      runtimeLiteral = natural.literal;
      runtimeLiteralHarness = natural.harness;
      runtimeLiteralModel = natural.model;
      runtimeLiteralEffort = natural.reasoningEffort;
      message = natural.message;
    }
  }
  harness = mergeRuntimeDimension("harness", harness, runtimeLiteralHarness);
  model = mergeRuntimeDimension("model", model, runtimeLiteralModel);
  reasoningEffort = mergeRuntimeDimension("reasoning effort", reasoningEffort, runtimeLiteralEffort);
  if (onHost) {
    if (!rawProjectPath?.trim()) {
      throw new ScoutCliError(`--on ${onHost} needs --project <path on ${onHost}>: the folder the new session starts in, as it exists on ${onHost}`);
    }
    if (targetLabel || existingTargetHandle || runtimeProfile) {
      throw new ScoutCliError(`--on ${onHost} starts a fresh session from --project; drop --to/--ref/--profile`);
    }
    // The path belongs to the other machine; resolving it here would bake in this machine's home and cwd.
    projectPath = rawProjectPath.trim();
    session ??= "new";
  }
  if (!runtimeProfile && shouldInferCurrentProjectAskTarget({ targetLabel, projectPath, harness, model, reasoningEffort, session })) {
    projectPath = parsed.currentDirectory;
  }
  const parsedExplicitTarget = targetLabel ? parseScoutComposerRouteTarget(targetLabel) : null;
  if (
    (harness || model || reasoningEffort)
    && !session
    && parsedExplicitTarget?.kind !== "session_id"
  ) {
    session = "new";
  }
  const targetCount = [targetLabel || existingTargetHandle, projectPath || runtimeProfile]
    .filter(Boolean).length;
  if (targetLabel && projectPath) {
    throw new ScoutCliError("provide either --to/--ref or --project, not both");
  }
  if (targetCount > 1) {
    throw new ScoutCliError("provide one existing target, or a project/runtime launch target");
  }
  if (targetCount === 0) {
    throw new ScoutCliError("--to <name>, --project <path>, --profile <name>, or natural target is required");
  }
  if (runtimeProfile) {
    rejectUnsupportedRuntimeProfileEffort(runtimeProfile, reasoningEffort);
  }
  if ((model || reasoningEffort) && !harness && !runtimeProfile) {
    throw new ScoutCliError("runtime_target_required: --model/--effort requires --harness, --runtime, or --profile");
  }
  if (message && promptFile) {
    rejectMixedBodySources("question");
  }
  if (!message && !promptFile) {
    throw new ScoutCliError("no question provided");
  }
  if ((aliasProject || aliasHost) && parseScoutComposerRouteTarget(targetLabel ?? "")?.kind !== "route_alias") {
    throw new ScoutCliError("--alias-project/--alias-host require --to alias:<name>");
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    agentName,
    ...(targetLabel ? { targetLabel } : {}),
    ...(requestId ? { requestId } : {}),
    ...(completion ? { completion } : {}),
    ...(relation ? { relation } : {}),
    ...(existingTargetHandle ? { existingTargetHandle } : {}),
    ...(runtimeProfile ? { runtimeProfile } : {}),
    ...(runtimeLiteral ? { runtimeLiteral } : {}),
    ...((runtimeLiteral || explicitHarnessFlag || explicitModelFlag || explicitEffortFlag) ? {
      executionSource: {
        ...(harness ? { harness: explicitHarnessFlag ? "flag" as const : "literal" as const } : {}),
        ...(model ? { model: explicitModelFlag ? "flag" as const : "literal" as const } : {}),
        ...(reasoningEffort
          ? { reasoningEffort: explicitEffortFlag ? "flag" as const : "literal" as const }
          : {}),
      },
    } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    targetRef,
    projectPath,
    channel,
    harness,
    session,
    timeoutSeconds,
    replyMode,
    placement,
    ...(labels.length ? { labels } : {}),
    message,
    promptFile,
    aliasProject,
    aliasHost,
    ...(onHost ? { onHost } : {}),
  };
}

export function parseImplicitAskCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutImplicitAskCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let agentName: string | null = null;
  let runtimeProfile: string | undefined;
  let runtimeLiteral: string | undefined;
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let channel: string | undefined;
  let harness: string | undefined;
  let session: ScoutAskCommandOptions["session"];
  let timeoutSeconds: number | undefined;
  let replyMode: ScoutAskCommandOptions["replyMode"];
  let placement: ScoutAskCommandOptions["placement"];
  let promptFile: string | undefined;
  const labels: string[] = [];
  const messageParts: string[] = [];

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (current === "--as" || current.startsWith("--as=")) {
      const value = parseFlagValue(parsed.args, index, "--as");
      agentName = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--profile" || current.startsWith("--profile=")) {
      const value = parseFlagValue(parsed.args, index, "--profile");
      runtimeProfile = parseRuntimeProfileFlag(value.value);
      index = value.nextIndex;
      continue;
    }
    if (current === "--runtime" || current.startsWith("--runtime=")) {
      const value = parseFlagValue(parsed.args, index, "--runtime");
      parseRuntimeLiteralFlag(value.value);
      runtimeLiteral = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--model" || current.startsWith("--model=")) {
      const value = parseFlagValue(parsed.args, index, "--model");
      model = value.value.trim();
      if (!model) missingFlagValue("--model");
      index = value.nextIndex;
      continue;
    }
    const effortFlag = flagNameFor(current, ["--effort", "--reasoning-effort"]);
    if (effortFlag) {
      const value = parseFlagValue(parsed.args, index, effortFlag);
      reasoningEffort = parseRuntimeProfileEffortFlag(value.value);
      index = value.nextIndex;
      continue;
    }
    if (current === "--channel" || current.startsWith("--channel=")) {
      const value = parseFlagValue(parsed.args, index, "--channel");
      channel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--harness" || current.startsWith("--harness=")) {
      const value = parseFlagValue(parsed.args, index, "--harness");
      harness = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--session" || current.startsWith("--session=")) {
      const value = parseFlagValue(parsed.args, index, "--session");
      session = mergeAskSessionPreference(
        session,
        parseAskSessionPreference(value.value),
      );
      index = value.nextIndex;
      continue;
    }
    if (current === "--new") {
      session = mergeAskSessionPreference(session, "new");
      continue;
    }
    if (current === "--timeout" || current.startsWith("--timeout=")) {
      const value = parseFlagValue(parsed.args, index, "--timeout");
      const parsedTimeout = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        throw new ScoutCliError(`invalid timeout: ${value.value}`);
      }
      timeoutSeconds = parsedTimeout;
      index = value.nextIndex;
      continue;
    }
    if (current === "--reply-mode" || current.startsWith("--reply-mode=")) {
      const value = parseFlagValue(parsed.args, index, "--reply-mode");
      if (value.value !== "inline" && value.value !== "notify" && value.value !== "none") {
        throw new ScoutCliError(`invalid reply mode: ${value.value}`);
      }
      replyMode = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--no-wait") {
      replyMode = "none";
      continue;
    }
    if (current === "--notify") {
      replyMode = "notify";
      continue;
    }
    if (current === "--placement" || current.startsWith("--placement=")) {
      const value = parseFlagValue(parsed.args, index, "--placement");
      if (value.value !== "background" && value.value !== "foreground" && value.value !== "attached") {
        throw new ScoutCliError(`invalid placement: ${value.value}`);
      }
      if (placement && placement !== value.value) {
        throw new ScoutCliError(`conflicting placement: ${placement} and ${value.value}`);
      }
      placement = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--foreground" || current === "--background") {
      const requested = current === "--foreground" ? "foreground" : "background";
      if (placement && placement !== requested) {
        throw new ScoutCliError(`conflicting placement: ${placement} and ${requested}`);
      }
      placement = requested;
      continue;
    }
    const labelFlag = flagNameFor(current, ["--label", "--labels"]);
    if (labelFlag) {
      const value = parseFlagValue(parsed.args, index, labelFlag);
      appendLabelValues(labels, value.value);
      index = value.nextIndex;
      continue;
    }
    const fileFlag = flagNameFor(current, ["--prompt-file", "--body-file"]);
    if (fileFlag) {
      if (promptFile) {
        throw new ScoutCliError("prompt file was provided more than once");
      }
      const value = parseFlagValue(parsed.args, index, fileFlag);
      promptFile = resolveInputFilePath(parsed.currentDirectory, value.value);
      index = value.nextIndex;
      continue;
    }
    messageParts.push(current);
  }

  const input = messageParts.join(" ").trim();
  if (!input && !promptFile) {
    throw new ScoutCliError("no question provided");
  }

  const routed = runtimeProfile || runtimeLiteral
    ? null
    : parseComposerRoutedBody(input, "ask", parsed.currentDirectory);
  if (routed) {
    const message = routed.message;
    if (message && promptFile) {
      rejectMixedBodySources("question");
    }
    if (!message && !promptFile) {
      throw new ScoutCliError("no question provided");
    }

    return {
      currentDirectory: parsed.currentDirectory,
      args: parsed.args,
      agentName,
      ...(routed.targetLabel ? { targetLabel: routed.targetLabel } : {}),
      targetRef: routed.targetRef,
      projectPath: routed.projectPath,
      channel: mergeComposerChannel(channel, routed.channel),
      harness,
      model,
      reasoningEffort,
      session,
      timeoutSeconds,
      replyMode,
      placement,
      ...(labels.length ? { labels } : {}),
      message,
      promptFile,
    };
  }

  const natural = !runtimeProfile && !runtimeLiteral && input
    ? parseNaturalLanguageAskTarget(input, {
        allowMissingMessage: Boolean(promptFile),
      })
    : null;
  if (natural || runtimeProfile || runtimeLiteral) {
    const selectedProfile = natural?.kind === "runtime_profile"
      ? natural.profile
      : runtimeProfile;
    if (natural?.kind === "existing_handle") {
      if (runtimeProfile || runtimeLiteral) {
        throw new ScoutCliError("runtime_conflict: existing agent targets cannot also be runtime-profile or RuntimeSpec targets");
      }
      if (natural.message && promptFile) {
        rejectMixedBodySources("question");
      }
      return {
        currentDirectory: parsed.currentDirectory,
        args: parsed.args,
        agentName,
        existingTargetHandle: natural.handle,
        channel,
        harness,
        model,
        reasoningEffort,
        session: session ?? (harness || model || reasoningEffort ? "new" : undefined),
        timeoutSeconds,
        replyMode,
        placement,
        ...(labels.length ? { labels } : {}),
        message: natural.message,
        promptFile,
      };
    }
    if (natural?.kind === "runtime_spec" || runtimeLiteral) {
      const literal = natural?.kind === "runtime_spec" ? natural.literal : runtimeLiteral!;
      const literalRuntime = natural?.kind === "runtime_spec"
        ? natural
        : parseRuntimeLiteralFlag(literal);
      const selectedHarness = mergeRuntimeDimension("harness", harness, literalRuntime.harness);
      const selectedModel = mergeRuntimeDimension("model", model, literalRuntime.model);
      const selectedReasoningEffort = mergeRuntimeDimension(
        "reasoning effort",
        reasoningEffort,
        literalRuntime.reasoningEffort,
      );
      const message = natural?.kind === "runtime_spec" ? natural.message : input;
      if (message && promptFile) rejectMixedBodySources("question");
      if (!message && !promptFile) throw new ScoutCliError("no question provided");
      return {
        currentDirectory: parsed.currentDirectory,
        args: parsed.args,
        agentName,
        projectPath: parsed.currentDirectory,
        runtimeLiteral: literal,
        harness: selectedHarness,
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        session: session ?? "new",
        channel,
        timeoutSeconds,
        replyMode,
        placement,
        ...(labels.length ? { labels } : {}),
        message,
        promptFile,
      };
    }
    if (!selectedProfile) {
      throw new ScoutCliError("runtime profile target is required");
    }
    const selectedReasoningEffort = mergeRuntimeProfileReasoningEffort(
      reasoningEffort,
      natural?.kind === "runtime_profile" ? natural.reasoningEffort : undefined,
    );
    rejectUnsupportedRuntimeProfileEffort(selectedProfile, selectedReasoningEffort);
    const message = natural?.kind === "runtime_profile" ? natural.message : input;
    if (message && promptFile) {
      rejectMixedBodySources("question");
    }
    if (!message && !promptFile) {
      throw new ScoutCliError("no question provided");
    }
    return {
      currentDirectory: parsed.currentDirectory,
      args: parsed.args,
      agentName,
      runtimeProfile: selectedProfile,
      ...(harness ? { harness } : {}),
      ...(model ? { model } : {}),
      reasoningEffort: selectedReasoningEffort,
      session,
      channel,
      timeoutSeconds,
      replyMode,
      placement,
      ...(labels.length ? { labels } : {}),
      message,
      promptFile,
    };
  }

  if ((model || reasoningEffort) && !harness) {
    throw new ScoutCliError("runtime_target_required: --model/--effort requires --harness, --runtime, or --profile");
  }

  const mentions = extractMentionTargets(input);
  if (mentions.length === 0) {
    if (shouldInferCurrentProjectAskTarget({ harness, model, reasoningEffort, session })) {
      const inferredSession = (harness || model || reasoningEffort) && !session ? "new" : session;
      return {
        currentDirectory: parsed.currentDirectory,
        args: parsed.args,
        agentName,
        projectPath: parsed.currentDirectory,
        channel,
        harness,
        model,
        reasoningEffort,
        session: inferredSession,
        timeoutSeconds,
        replyMode,
        placement,
        ...(labels.length ? { labels } : {}),
        message: input,
        promptFile,
      };
    }
    throw new ScoutCliError("implicit ask requires >> target or an @agent mention");
  }
  if (mentions.length > 1) {
    throw new ScoutCliError("implicit ask supports exactly one @agent mention");
  }

  const [target] = mentions;
  const message = stripMention(input, target);
  if (message && promptFile) {
    rejectMixedBodySources("question");
  }
  if (!message && !promptFile) {
    throw new ScoutCliError("no question provided");
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    agentName,
    targetLabel: target.label,
    channel,
    harness,
    model,
    reasoningEffort,
    session: session ?? (harness || model || reasoningEffort ? "new" : undefined),
    timeoutSeconds,
    replyMode,
    placement,
    ...(labels.length ? { labels } : {}),
    message,
    promptFile,
  };
}

export function parseWatchCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutWatchCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let agentName: string | null = null;
  let channel: string | undefined;
  let conversationId: string | undefined;
  let since: number | undefined;
  let limit: number | undefined;
  let once = false;

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (current === "--as" || current.startsWith("--as=")) {
      const value = parseFlagValue(parsed.args, index, "--as");
      agentName = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--channel" || current.startsWith("--channel=")) {
      const value = parseFlagValue(parsed.args, index, "--channel");
      channel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--conversation" || current.startsWith("--conversation=")) {
      const value = parseFlagValue(parsed.args, index, "--conversation");
      conversationId = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--since" || current.startsWith("--since=")) {
      const value = parseFlagValue(parsed.args, index, "--since");
      since = parseSinceTimestamp(value.value);
      index = value.nextIndex;
      continue;
    }
    if (current === "--limit" || current.startsWith("--limit=")) {
      const value = parseFlagValue(parsed.args, index, "--limit");
      const parsedLimit = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new ScoutCliError(`invalid limit: ${value.value}`);
      }
      limit = parsedLimit;
      index = value.nextIndex;
      continue;
    }
    if (current === "--once") {
      once = true;
      continue;
    }
    unexpectedArgs("watch", args);
  }

  if (channel && conversationId) {
    throw new ScoutCliError("provide either --channel or --conversation, not both");
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    agentName,
    channel,
    conversationId,
    since,
    limit,
    once,
  };
}

export function parseChannelCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutChannelCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let channel: string | undefined;
  let latest: number | undefined;
  let markRead = false;

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (current === "--channel" || current.startsWith("--channel=")) {
      const value = parseFlagValue(parsed.args, index, "--channel");
      channel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--latest" || current.startsWith("--latest=")) {
      const value = parseFlagValue(parsed.args, index, "--latest");
      const parsedLimit = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new ScoutCliError(`invalid latest count: ${value.value}`);
      }
      latest = parsedLimit;
      index = value.nextIndex;
      continue;
    }
    if (current === "--mark-read" || current === "--read" || current === "--clear") {
      markRead = true;
      continue;
    }
    if (!current.startsWith("-") && !channel) {
      channel = current;
      continue;
    }
    unexpectedArgs("channel", args);
  }

  if (latest && markRead) {
    throw new ScoutCliError("provide either --latest or --mark-read, not both");
  }

  if (channel && !latest && !markRead) {
    throw new ScoutCliError("channel name is only valid with --latest or --mark-read");
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    channel,
    latest,
    markRead,
  };
}

export function parseInboxCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutInboxCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let agentName: string | null = null;
  let latest = 10;
  let since: number | undefined;

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (current === "--as" || current.startsWith("--as=")) {
      const value = parseFlagValue(parsed.args, index, "--as");
      agentName = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--latest" || current.startsWith("--latest=") || current === "--limit" || current.startsWith("--limit=")) {
      const flag = current === "--limit" || current.startsWith("--limit=") ? "--limit" : "--latest";
      const value = parseFlagValue(parsed.args, index, flag);
      const parsedLimit = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new ScoutCliError(`invalid latest count: ${value.value}`);
      }
      latest = parsedLimit;
      index = value.nextIndex;
      continue;
    }
    if (current === "--since" || current.startsWith("--since=")) {
      const value = parseFlagValue(parsed.args, index, "--since");
      since = parseSinceTimestamp(value.value);
      index = value.nextIndex;
      continue;
    }
    unexpectedArgs("inbox", args);
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    agentName,
    latest,
    since,
  };
}

export function parseLatestCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutLatestCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let agentId: string | undefined;
  let actorId: string | undefined;
  let channel: string | undefined;
  let conversationId: string | undefined;
  let limit = 12;
  let messages = false;

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (current === "--agent" || current.startsWith("--agent=")) {
      const value = parseFlagValue(parsed.args, index, "--agent");
      agentId = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--actor" || current.startsWith("--actor=")) {
      const value = parseFlagValue(parsed.args, index, "--actor");
      actorId = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--channel" || current.startsWith("--channel=")) {
      const value = parseFlagValue(parsed.args, index, "--channel");
      channel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--conversation" || current.startsWith("--conversation=")) {
      const value = parseFlagValue(parsed.args, index, "--conversation");
      conversationId = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--limit" || current.startsWith("--limit=")) {
      const value = parseFlagValue(parsed.args, index, "--limit");
      const parsedLimit = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new ScoutCliError(`invalid limit: ${value.value}`);
      }
      limit = parsedLimit;
      index = value.nextIndex;
      continue;
    }
    if (current === "--messages") {
      messages = true;
      continue;
    }
    unexpectedArgs("latest", args);
  }

  if (channel && conversationId) {
    throw new ScoutCliError("provide either --channel or --conversation, not both");
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    agentId,
    actorId,
    channel,
    conversationId,
    limit,
    messages,
  };
}

export function parseCardCreateCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutCardCreateCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let projectPath: string | null = null;
  let agentName: string | undefined;
  let displayName: string | undefined;
  let harness: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let reasoningEffort: string | undefined;
  let permissionProfile: string | undefined;
  let requesterId: string | null = null;
  let noInput = false;
  let oneTimeUse = false;

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (current === "--name" || current.startsWith("--name=")) {
      const value = parseFlagValue(parsed.args, index, "--name");
      agentName = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--display-name" || current.startsWith("--display-name=")) {
      const value = parseFlagValue(parsed.args, index, "--display-name");
      displayName = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--harness" || current.startsWith("--harness=")) {
      const value = parseFlagValue(parsed.args, index, "--harness");
      harness = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--model" || current.startsWith("--model=")) {
      const value = parseFlagValue(parsed.args, index, "--model");
      model = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--provider" || current.startsWith("--provider=")) {
      const value = parseFlagValue(parsed.args, index, "--provider");
      provider = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--reasoning-effort" || current.startsWith("--reasoning-effort=")) {
      const value = parseFlagValue(parsed.args, index, "--reasoning-effort");
      reasoningEffort = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--effort" || current.startsWith("--effort=")) {
      const value = parseFlagValue(parsed.args, index, "--effort");
      reasoningEffort = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--permission-profile" || current.startsWith("--permission-profile=")) {
      const value = parseFlagValue(parsed.args, index, "--permission-profile");
      permissionProfile = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--as" || current.startsWith("--as=")) {
      const value = parseFlagValue(parsed.args, index, "--as");
      requesterId = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--path" || current.startsWith("--path=")) {
      const value = parseFlagValue(parsed.args, index, "--path");
      if (projectPath) {
        throw new ScoutCliError("project path was provided more than once");
      }
      projectPath = resolve(value.value);
      index = value.nextIndex;
      continue;
    }
    if (current === "--no-input") {
      noInput = true;
      continue;
    }
    if (current === "--one-time") {
      oneTimeUse = true;
      continue;
    }
    if (current.startsWith("--")) {
      unexpectedArgs("card create", args);
    }
    if (projectPath) {
      throw new ScoutCliError(`unexpected arguments for card create: ${args.join(" ")}`);
    }
    projectPath = resolve(current);
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    projectPath: projectPath ?? parsed.currentDirectory,
    agentName,
    displayName,
    harness,
    model,
    provider,
    reasoningEffort,
    permissionProfile,
    requesterId,
    noInput,
    oneTimeUse,
  };
}

export function parseMonitorCommandOptions(
  args: string[],
  defaultCurrentDirectory: string,
): ScoutMonitorCommandOptions {
  const parsed = parseContextRootPrefix(args, defaultCurrentDirectory);
  let channel: string | undefined;
  let limit = 12;
  let intervalMs = 1_500;

  for (let index = 0; index < parsed.args.length; index += 1) {
    const current = parsed.args[index] ?? "";
    if (current === "--channel" || current.startsWith("--channel=")) {
      const value = parseFlagValue(parsed.args, index, "--channel");
      channel = value.value;
      index = value.nextIndex;
      continue;
    }
    if (current === "--limit" || current.startsWith("--limit=")) {
      const value = parseFlagValue(parsed.args, index, "--limit");
      const parsedLimit = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new ScoutCliError(`invalid limit: ${value.value}`);
      }
      limit = parsedLimit;
      index = value.nextIndex;
      continue;
    }
    if (current === "--interval" || current.startsWith("--interval=")) {
      const value = parseFlagValue(parsed.args, index, "--interval");
      const parsedInterval = Number.parseInt(value.value, 10);
      if (!Number.isFinite(parsedInterval) || parsedInterval < 250) {
        throw new ScoutCliError(`invalid interval: ${value.value}`);
      }
      intervalMs = parsedInterval;
      index = value.nextIndex;
      continue;
    }
    unexpectedArgs("monitor", args);
  }

  return {
    currentDirectory: parsed.currentDirectory,
    args: parsed.args,
    channel,
    limit,
    intervalMs,
  };
}
