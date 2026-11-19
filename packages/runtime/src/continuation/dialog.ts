/**
 * Live Claude TUI dialog parser.
 *
 * Reads only the visible pane snapshot. Does not ingest scrollback as Scout
 * messages. A dialog with activity or a composer under it is stale, not live.
 */

export type ContinuationDialogKind =
  | "permission"
  | "question"
  | "plan"
  | "hold"
  | "unknown";

export type ContinuationOptionKind = "allow" | "allow_always" | "deny" | "other";

export type ContinuationDialogOption = {
  index: number;
  label: string;
  selected: boolean;
  kind: ContinuationOptionKind;
};

export type ContinuationDialogAction = "bash" | "edit" | "write";

export type ContinuationDialog = {
  kind: ContinuationDialogKind;
  live: boolean;
  title: string | null;
  command: string | null;
  /** Which tool the dialog is for, from its header. Null when there was no header. */
  action: ContinuationDialogAction | null;
  /**
   * True only when `command` is the whole command: read from under a tool
   * header, one line, not clamped. Anything else must not be auto-continued.
   */
  commandExact: boolean;
  permissionRule: string | null;
  options: ContinuationDialogOption[];
};

const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const ANSI_OSC = /\x1B\][^\x07]*(?:\x07|\x1B\\)/gu;
const FOOTER = /\bEsc to cancel\b/i;
const PROCEED = /\bDo you want to proceed\?/i;
const PERMISSION_RULE = /\bPermission rule\s+(.+?)\s+requires confirmation/i;
const REQUIRES_APPROVAL = /\bThis command requires approval\b/i;
const HOLD = /\bauto mode held this action\b/i;
const PLAN_PROMPT = /\bYes, and use auto mode\b|\bNo, keep planning\b/i;
const POST_PROMPT_ACTIVITY = /(?:^|\n)\s*(?:⏺|●)\s+(?:Bash|Edit|Glob|Grep|Read|Search|Task|Update|WebFetch|WebSearch|Write)\b/imu;
const READY_COMPOSER = /^\s*(?:[❯›]\s*|[│┃]\s*[>❯]\s*)/mu;
const OPTION_LINE = /^\s*(❯|›)?\s*(\d+)\.\s+(\S.*)$/u;
const COMMAND_HEADER = /^\s*(Bash command|Edit file|Write file)\s*$/i;
const MAX_COMMAND_CHARS = 500;

export function stripTerminalControls(value: string): string {
  return value.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replaceAll("\r", "");
}

export function parseContinuationDialog(paneBody: string): ContinuationDialog {
  const lines = stripTerminalControls(paneBody).split(/\n/u);
  const lastContent = findLastIndex(lines, (line) => line.trim().length > 0);
  if (lastContent < 0) {
    return emptyDialog();
  }

  const holdIndex = findLastIndex(lines, (line) => HOLD.test(line));
  if (holdIndex >= 0 && !staleAfter(lines, holdIndex, lastContent)) {
    return {
      kind: "hold",
      live: true,
      title: "Auto mode held this action",
      ...commandNear(lines, holdIndex),
      permissionRule: null,
      options: parseOptions(lines, holdIndex + 1, lastContent),
    };
  }

  const footerIndex = findLastIndex(lines, (line) => FOOTER.test(line));
  const proceedIndex = findLastIndex(
    lines,
    (line, index) => (footerIndex < 0 || index < footerIndex) && PROCEED.test(line),
  );
  if (proceedIndex < 0) {
    if (PLAN_PROMPT.test(paneBody)) {
      return {
        kind: "plan",
        live: !staleAfter(lines, lastContent, lastContent),
        title: "Plan approval",
        command: null,
        action: null,
        commandExact: false,
        permissionRule: null,
        options: [],
      };
    }
    return emptyDialog();
  }

  if (staleAfter(lines, footerIndex >= 0 ? footerIndex : proceedIndex, lastContent)) {
    return emptyDialog();
  }

  // Only the options of the live dialog: after its question, before its footer.
  const options = parseOptions(lines, proceedIndex + 1, footerIndex >= 0 ? footerIndex - 1 : lastContent);
  if (PLAN_PROMPT.test(paneBody) || options.some((option) => /keep planning/i.test(option.label))) {
    return {
      kind: "plan",
      live: true,
      title: "Plan approval",
      command: null,
      action: null,
      commandExact: false,
      permissionRule: null,
      options,
    };
  }

  // Only the live dialog's own markers count. Anything at or above the end of
  // an earlier dialog (its question, menu, or footer), or above the live
  // dialog's tool header, is history and must not name the live command.
  const previousDialogEnd = findLastIndex(
    lines,
    (line, index) => index < proceedIndex && (PROCEED.test(line) || FOOTER.test(line) || OPTION_LINE.test(line)),
  );
  const liveHeader = findLastIndex(
    lines,
    (line, index) => index < proceedIndex && index > previousDialogEnd && COMMAND_HEADER.test(line),
  );
  const floor = Math.max(previousDialogEnd, liveHeader);
  const permissionIndex = findLastIndex(
    lines,
    (line, index) => index > floor && index < proceedIndex && PERMISSION_RULE.test(line),
  );
  const approvalIndex = findLastIndex(
    lines,
    (line, index) => index > floor && index < proceedIndex && REQUIRES_APPROVAL.test(line),
  );
  const rule = permissionIndex >= 0
    ? lines[permissionIndex]?.match(PERMISSION_RULE)?.[1]?.trim() ?? null
    : null;
  const command = liveHeader >= 0
    ? commandNear(lines, permissionIndex >= 0 ? permissionIndex : approvalIndex >= 0 ? approvalIndex : proceedIndex)
    : { ...commandNear(lines, proceedIndex), action: null, commandExact: false };

  if (options.length === 0) {
    return {
      kind: "unknown",
      live: true,
      title: "Claude needs input",
      ...command,
      permissionRule: rule,
      options,
    };
  }

  return {
    kind: "permission",
    live: true,
    title: rule ? `Permission rule ${rule}` : "Command requires approval",
    ...command,
    permissionRule: rule,
    options,
  };
}

/**
 * The lines of the live dialog's menu: after its last "Do you want to
 * proceed?" and before its footer. Null when there is no live question.
 */
export function liveDialogMenuLines(paneBody: string): string[] | null {
  const lines = stripTerminalControls(paneBody).split(/\n/u);
  const lastContent = findLastIndex(lines, (line) => line.trim().length > 0);
  if (lastContent < 0) return null;
  const footerIndex = findLastIndex(lines, (line) => FOOTER.test(line));
  const proceedIndex = findLastIndex(
    lines,
    (line, index) => (footerIndex < 0 || index < footerIndex) && PROCEED.test(line),
  );
  if (proceedIndex < 0) return null;
  if (staleAfter(lines, footerIndex >= 0 ? footerIndex : proceedIndex, lastContent)) return null;
  return lines.slice(proceedIndex + 1, footerIndex >= 0 ? footerIndex : lastContent + 1);
}

function emptyDialog(): ContinuationDialog {
  return {
    kind: "unknown",
    live: false,
    title: null,
    command: null,
    action: null,
    commandExact: false,
    permissionRule: null,
    options: [],
  };
}

function staleAfter(lines: readonly string[], afterIndex: number, lastContent: number): boolean {
  const rest = lines.slice(afterIndex + 1, lastContent + 1).join("\n");
  return POST_PROMPT_ACTIVITY.test(rest) || READY_COMPOSER.test(rest);
}

function commandNear(
  lines: readonly string[],
  around: number,
): Pick<ContinuationDialog, "command" | "action" | "commandExact"> {
  const headerIndex = findLastIndex(
    lines,
    (line, index) => index < around && COMMAND_HEADER.test(line),
  );
  if (headerIndex >= 0 && around - headerIndex <= 12) {
    const header = lines[headerIndex]?.match(COMMAND_HEADER)?.[1]?.toLowerCase() ?? "";
    const action: ContinuationDialogAction = header.startsWith("bash")
      ? "bash"
      : header.startsWith("edit") ? "edit" : "write";
    // Every line between the header and the rule/question. A second line may
    // be a description or a second command; the text alone cannot tell, so
    // anything but exactly one line is inexact and never auto-continued.
    const block = lines
      .slice(headerIndex + 1, around)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^\/permissions\b/i.test(line));
    if (block.length > 0) {
      const full = block.join("\n");
      return {
        command: clamp(full, MAX_COMMAND_CHARS),
        action,
        commandExact: block.length === 1 && full.length <= MAX_COMMAND_CHARS,
      };
    }
  }
  const previous = lines
    .slice(Math.max(0, around - 6), around)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return { command: previous ? clamp(previous, MAX_COMMAND_CHARS) : null, action: null, commandExact: false };
}

function parseOptions(
  lines: readonly string[],
  start: number,
  end: number,
): ContinuationDialogOption[] {
  const options: ContinuationDialogOption[] = [];
  for (const line of lines.slice(Math.max(0, start), Math.max(0, end + 1))) {
    const match = line.match(OPTION_LINE);
    if (!match) continue;
    const index = Number(match[2]);
    const label = match[3]?.trim() ?? "";
    if (!Number.isInteger(index) || !label) continue;
    options.push({
      index,
      label,
      selected: Boolean(match[1]),
      kind: optionKind(label),
    });
  }
  // A real menu numbers 1..n once each. Anything else is not one dialog.
  if (options.some((option, index) => option.index !== index + 1)) return [];
  return options;
}

function optionKind(label: string): ContinuationOptionKind {
  if (/\bdon'?t ask again\b|\balways allow\b|\ballow all\b|\bduring this session\b|\bfor this session\b|\bswitch to auto mode\b/i.test(label)) {
    return "allow_always";
  }
  if (/^yes\b/i.test(label)) return "allow";
  if (/^no\b/i.test(label)) return "deny";
  return "other";
}

function findLastIndex(
  values: readonly string[],
  predicate: (value: string, index: number) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] ?? "", index)) return index;
  }
  return -1;
}

function clamp(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized;
}
