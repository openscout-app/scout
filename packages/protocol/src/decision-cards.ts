/**
 * Decision cards: the one shape every surface shows for an operator ask.
 *
 * The runtime makes the card once and stores it on the ask's question record.
 * Surfaces only display it and send a {@link OperatorCardAnswer} back. They
 * keep no decision logic of their own.
 *
 * A card comes from one of three places:
 * - the agent, with `scout ask --operator --decision <file>` (our shape, or one
 *   decision from a decision-pack `pack.json`);
 * - the runtime, which synthesizes it from the ask's fields and words;
 * - a permission request, which the runtime turns into a `permission` card.
 *
 * The functions here are pure. They read no files and call no model.
 */

export const DECISION_CARD_VERSION = 1 as const;
export const DECISION_KEYS = ["A", "B", "C"] as const;
export type DecisionKey = (typeof DECISION_KEYS)[number];

export const DECISION_CARD_LIMITS = Object.freeze({
  question: 60,
  label: 18,
  synthesizedLabel: 60,
  result: 90,
  why: 160,
  costOfWait: 120,
  calloutNote: 90,
  details: 4_000,
  quote: 400,
  note: 2_000,
  callouts: 9,
  pictures: 3,
});

export type DecisionCallout = {
  n: number;
  /** `[x, y, w, h]` in the image's own pixels. */
  box: [number, number, number, number];
  note: string;
};

/** A picture is a runtime attachment on the ask's message, never a local path. */
export type DecisionPicture = {
  attachmentId: string;
  width: number;
  height: number;
  callouts?: DecisionCallout[];
};

/** `unknown` appears only on synthesized cards, when the source does not say. */
export type DecisionUndo = "easy" | "hard" | "unknown";
export type DecisionDoor = "one_way" | "two_way" | "unknown";

export type DecisionOption = {
  key: DecisionKey;
  /** Button text, one or two words. */
  label: string;
  /** What happens if the operator picks it. */
  result: string;
  undo: DecisionUndo;
  picture?: DecisionPicture;
};

/** An earlier answer on record for the same topic. Shown, never applied. */
export type DecisionAlreadyDecided = {
  /** The operator's own words. */
  quote: string;
  /** ISO 8601 time of that answer. */
  at: string;
  /** The option on this card that the earlier answer names, when it names one. */
  key?: DecisionKey;
  /** The question record that holds the earlier answer. */
  recordId?: string;
};

export type DecisionCardSource =
  | { kind: "decision-pack"; project?: string; id: string; version: number };

export type DecisionCard = {
  kind: "decision";
  version: typeof DECISION_CARD_VERSION;
  /** Plain words, no PR, ticket or file ids. Those go in `details`. */
  question: string;
  /** The agent's pick. Required on an agent's card; a synthesized card has one only when the source names it. */
  pick?: { key: DecisionKey; why: string };
  options: DecisionOption[];
  door: DecisionDoor;
  /** Two-way doors only. Applies at the task's existing answer deadline. */
  defaultKey?: DecisionKey;
  costOfWait?: string;
  /** Markdown. Ids, PRs and paths live only here. */
  details?: string;
  alreadyDecided?: DecisionAlreadyDecided;
  source?: DecisionCardSource;
};

/** The answers the runtime can carry out for a permission request today. */
export type PermissionAnswerKind = "allow_once" | "allow_always" | "deny";

export type PermissionCard = {
  kind: "permission";
  version: typeof DECISION_CARD_VERSION;
  question: string;
  action: {
    /** "Run a command", "Edit a file". */
    summary: string;
    tool?: string;
    command?: string;
    target?: string;
    fields?: Array<{ key: string; value: string }>;
  };
  /** Where it runs. A session appears by its alias or name, never by a raw id. */
  where: { project?: string; session?: string; harness?: string; host?: string };
  /** What an approval grants. */
  scope: string;
  /** The session's own words on why, when the request carries them. */
  reason?: string;
  answers: Array<{ kind: PermissionAnswerKind; label: string; grants?: string[] }>;
  alreadyDecided?: DecisionAlreadyDecided;
};

export type OperatorCard = DecisionCard | PermissionCard;

export type DecisionAnswerKind = "pick" | "take_pick" | "disagree_go" | "something_else" | "show_more" | "keep_earlier";

export type DecisionAnswerRegion = {
  optionKey: DecisionKey;
  calloutN?: number;
  /** `[x, y, w, h]` in the picture's own pixels. */
  boxPx?: [number, number, number, number];
};

export type DecisionAnswer = {
  kind: DecisionAnswerKind;
  key?: DecisionKey;
  note?: string;
  regions?: DecisionAnswerRegion[];
};

export type PermissionAnswer = { kind: PermissionAnswerKind; note?: string };

export type OperatorCardAnswer = DecisionAnswer | PermissionAnswer;

/** Where the card came from. */
export type OperatorCardOrigin = "agent" | "synthesized" | "permission";

/**
 * A card as it crosses the wire from an agent: each picture names an index
 * into the request's `decisionImages`. The runtime binds the images and
 * returns a {@link DecisionCard} that holds attachment ids instead.
 */
export type DecisionCardSubmission = Omit<DecisionCard, "options"> & {
  options: Array<Omit<DecisionOption, "picture"> & {
    picture?: { image: number; callouts?: DecisionCallout[] };
  }>;
};

/** A card read from a file, before its picture paths are read. */
export type DecisionCardDraft = Omit<DecisionCard, "options"> & {
  options: Array<Omit<DecisionOption, "picture"> & {
    picture?: { path: string; width?: number; height?: number; callouts?: DecisionCallout[] };
  }>;
};

const ID_IN_TEXT = /(?:^|\s)#\d+\b|\b(?:PR|MR|issue)\s*#?\d+\b|\b[A-Z]{2,10}-\d+\b|(?:^|\s)(?:\.{0,2}\/|~\/)\S+|\b\S+\.(?:ts|tsx|js|mjs|json|md|rs|py|swift|go|yml|yaml|toml)\b/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isKey(value: unknown): value is DecisionKey {
  return typeof value === "string" && (DECISION_KEYS as readonly string[]).includes(value);
}

function maxLength(errors: string[], where: string, value: string | undefined, max: number): void {
  if (value !== undefined && value.length > max) errors.push(`${where}: ${value.length} characters, max ${max}`);
}

function validCallouts(errors: string[], where: string, callouts: unknown, size?: { width?: number; height?: number }): void {
  if (callouts === undefined) return;
  if (!Array.isArray(callouts)) { errors.push(`${where}: must be a list`); return; }
  if (callouts.length > DECISION_CARD_LIMITS.callouts) errors.push(`${where}: at most ${DECISION_CARD_LIMITS.callouts} callouts`);
  const seen = new Set<number>();
  callouts.forEach((callout, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(callout)) { errors.push(`${at}: not an object`); return; }
    const n = callout.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) errors.push(`${at}.n: must be a whole number from 1`);
    else if (seen.has(n)) errors.push(`${at}.n: duplicate ${n}`);
    else seen.add(n);
    const box = callout.box;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      errors.push(`${at}.box: must be [x, y, w, h], non-negative numbers in image pixels`);
    } else if (size?.width && size.height && (box[0]! + box[2]! > size.width + 0.5 || box[1]! + box[3]! > size.height + 0.5)) {
      errors.push(`${at}.box: falls outside the ${size.width}x${size.height} image`);
    }
    if (!str(callout.note)) errors.push(`${at}.note: missing`);
    maxLength(errors, `${at}.note`, str(callout.note), DECISION_CARD_LIMITS.calloutNote);
  });
}

export type DecisionValidationMode = {
  /** An agent's card must name a pick and know its doors; a synthesized one may not. */
  origin: "agent" | "synthesized";
  /** What a picture must hold: a file path (draft), an image index (submission) or an attachment (card). */
  pictures: "path" | "image" | "attachment";
  /** Submission only: how many images the request carries. */
  imageCount?: number;
};

/**
 * Field rules for a decision card. Returns `path: problem` strings, empty when
 * the card is valid. The rules: 2–3 options keyed A, B, C in order; exactly
 * one pick (agent cards); a default only on a two-way door.
 */
export function validateDecisionCard(card: unknown, mode: DecisionValidationMode): string[] {
  const errors: string[] = [];
  if (!isRecord(card)) return ["decision: not an object"];
  if (card.kind !== undefined && card.kind !== "decision") errors.push("decision.kind: must be decision");
  const question = str(card.question);
  if (!question) errors.push("decision.question: missing");
  maxLength(errors, "decision.question", question, DECISION_CARD_LIMITS.question);
  if (question && mode.origin === "agent" && ID_IN_TEXT.test(question)) {
    errors.push("decision.question: keep ids, PR numbers and paths out of the question; put them in details");
  }
  const options = card.options;
  const keys: DecisionKey[] = [];
  if (!Array.isArray(options) || options.length < 2 || options.length > 3) {
    errors.push("decision.options: give 2 or 3 options");
  } else {
    options.forEach((option, index) => {
      const at = `decision.options[${index}]`;
      if (!isRecord(option)) { errors.push(`${at}: not an object`); return; }
      if (option.key !== DECISION_KEYS[index]) errors.push(`${at}.key: must be ${DECISION_KEYS[index]}`);
      else keys.push(DECISION_KEYS[index]!);
      const label = str(option.label);
      if (!label) errors.push(`${at}.label: missing`);
      // A synthesized card keeps an asker's `--option` label verbatim, so it may be longer.
      maxLength(errors, `${at}.label`, label, mode.origin === "synthesized" ? DECISION_CARD_LIMITS.synthesizedLabel : DECISION_CARD_LIMITS.label);
      const result = str(option.result);
      if (!result) errors.push(`${at}.result: missing`);
      maxLength(errors, `${at}.result`, result, DECISION_CARD_LIMITS.result);
      const undo = option.undo;
      if (!(undo === "easy" || undo === "hard" || (mode.origin === "synthesized" && undo === "unknown"))) {
        errors.push(`${at}.undo: must be easy or hard`);
      }
      const picture = option.picture;
      if (picture === undefined) return;
      if (!isRecord(picture)) { errors.push(`${at}.picture: not an object`); return; }
      if (mode.pictures === "path") {
        if (!str(picture.path)) errors.push(`${at}.picture.path: missing`);
        validCallouts(errors, `${at}.picture.callouts`, picture.callouts, picture as { width?: number; height?: number });
      } else if (mode.pictures === "image") {
        const image = picture.image;
        if (typeof image !== "number" || !Number.isInteger(image) || image < 0 || (mode.imageCount !== undefined && image >= mode.imageCount)) {
          errors.push(`${at}.picture.image: must index the request's decision images`);
        }
        validCallouts(errors, `${at}.picture.callouts`, picture.callouts);
      } else {
        if (!str(picture.attachmentId)) errors.push(`${at}.picture.attachmentId: missing`);
        if (typeof picture.width !== "number" || typeof picture.height !== "number" || picture.width <= 0 || picture.height <= 0) {
          errors.push(`${at}.picture: width and height must be positive`);
        }
        validCallouts(errors, `${at}.picture.callouts`, picture.callouts, picture as { width?: number; height?: number });
      }
    });
    const labels = options.map((option) => (isRecord(option) ? str(option.label)?.toLowerCase() : undefined)).filter(Boolean);
    if (new Set(labels).size !== labels.length) errors.push("decision.options: labels must differ");
  }
  const pick = card.pick;
  if (pick === undefined) {
    if (mode.origin === "agent") errors.push("decision.pick: name exactly one pick, with a line of why");
  } else if (!isRecord(pick) || !isKey(pick.key) || !keys.includes(pick.key)) {
    errors.push("decision.pick.key: must name one of the options");
  } else {
    if (!str(pick.why)) errors.push("decision.pick.why: missing");
    maxLength(errors, "decision.pick.why", str(pick.why), DECISION_CARD_LIMITS.why);
  }
  const door = card.door;
  if (!(door === "one_way" || door === "two_way" || (mode.origin === "synthesized" && door === "unknown"))) {
    errors.push("decision.door: must be one_way or two_way");
  }
  if (card.defaultKey !== undefined) {
    if (!isKey(card.defaultKey) || !keys.includes(card.defaultKey as DecisionKey)) errors.push("decision.defaultKey: must name one of the options");
    if (door !== "two_way") errors.push("decision.defaultKey: a default is allowed only on a two-way door");
  }
  maxLength(errors, "decision.costOfWait", str(card.costOfWait), DECISION_CARD_LIMITS.costOfWait);
  maxLength(errors, "decision.details", str(card.details), DECISION_CARD_LIMITS.details);
  if (card.alreadyDecided !== undefined) {
    const prior = card.alreadyDecided;
    if (!isRecord(prior) || !str(prior.quote) || !str(prior.at)) errors.push("decision.alreadyDecided: needs the operator's quote and the date");
    else if (prior.key !== undefined && (!isKey(prior.key) || !keys.includes(prior.key))) errors.push("decision.alreadyDecided.key: must name one of the options");
  }
  return errors;
}

export class DecisionCardError extends Error {
  constructor(readonly problems: string[]) {
    super(`decision card is not valid:\n- ${problems.join("\n- ")}`);
    this.name = "DecisionCardError";
  }
}

/** The option labels, in order. Older readers of `options: string[]` keep working on these. */
type Labeled = { options: Array<{ key: DecisionKey; label: string }> };
export function decisionCardLabels(card: Labeled): string[] {
  return card.options.map((option) => option.label);
}

export function decisionOption<C extends Labeled>(card: C, key: DecisionKey | undefined): C["options"][number] | undefined {
  return key ? card.options.find((option) => option.key === key) : undefined;
}

/**
 * Fold a card into the task's existing fields: `options` from its labels, and
 * `defaultAction` from its default. A card whose fields disagree with the
 * task's own is refused, so the two can never say different things.
 */
export function applyDecisionToTask<T extends { options?: string[]; defaultAction?: string; permission?: boolean }>(
  task: T,
  card: Labeled & Pick<DecisionCard, "defaultKey" | "door">,
): T {
  const labels = decisionCardLabels(card);
  if (task.permission) throw new Error("--decision cannot be combined with --permission: a permission request is its own card");
  if (task.options?.length && (task.options.length !== labels.length || task.options.some((option, i) => option.trim() !== labels[i]))) {
    throw new Error("--option must match the decision's option labels, or be left out");
  }
  const defaultLabel = decisionOption(card, card.defaultKey)?.label;
  if (task.defaultAction !== undefined && task.defaultAction.trim() !== defaultLabel) {
    throw new Error(defaultLabel
      ? `--default-action must be the decision's default, "${defaultLabel}"`
      : "--default-action needs a two-way door and a defaultKey on the decision");
  }
  return { ...task, options: labels, ...(defaultLabel ? { defaultAction: defaultLabel } : {}) };
}

/* ------------------------------------------------------------------ */
/* decision-pack interop                                               */
/* ------------------------------------------------------------------ */

/**
 * Read one decision from a decision-pack `pack.json` (or the decision object
 * itself) into our draft shape. Shots keep their local paths; the caller reads
 * them and the runtime stores them as attachments.
 *
 * `select` picks a decision by id. Without it, the pack must hold exactly one
 * open decision.
 */
export function decisionDraftFromInput(input: unknown, select?: string): DecisionCardDraft {
  if (!isRecord(input)) throw new DecisionCardError(["decision file: not a JSON object"]);
  if (Array.isArray(input.decisions)) {
    const decisions = input.decisions.filter(isRecord);
    const chosen = select
      ? decisions.filter((decision) => decision.id === select)
      : decisions.filter((decision) => decision.status === undefined || decision.status === "open");
    if (chosen.length !== 1) {
      throw new DecisionCardError([select
        ? `pack.decisions: no decision with id ${select}`
        : `pack.decisions: ${chosen.length} open decisions; name one with --decision <file>#<id>`]);
    }
    return mapDecisionPackDecision(chosen[0]!, str(input.project));
  }
  if (select) throw new DecisionCardError([`decision file: #${select} names a pack decision, but this file is not a pack`]);
  if (Array.isArray(input.options) && input.options.some((option) => isRecord(option) && "button" in option)) {
    return mapDecisionPackDecision(input, undefined);
  }
  return input as unknown as DecisionCardDraft;
}

function stripRecommendation(bluf: string, key: string | undefined): string {
  // "I recommend A: <why>." keeps only the why; the pick is shown on its own.
  return bluf.replace(new RegExp(`^\\s*I\\s+recommend\\s+${key ?? "[ABC]"}\\b\\s*[:,.-]?\\s*`, "iu"), "").trim() || bluf.trim();
}

export function mapDecisionPackDecision(decision: Record<string, unknown>, project?: string): DecisionCardDraft {
  const problems: string[] = [];
  const rawOptions = Array.isArray(decision.options) ? decision.options.filter(isRecord) : [];
  const recommended = rawOptions.filter((option) => option.recommended === true);
  if (recommended.length !== 1) problems.push(`decision.options: exactly one option needs recommended: true (found ${recommended.length})`);
  const door = decision.door === "one_way" || decision.door === "two_way" ? decision.door : undefined;
  if (!door) problems.push("decision.door: must be one_way or two_way");
  const gate = str(decision.gate) ?? "none";
  const pickKey = str(recommended[0]?.key);
  const options = rawOptions.map((option) => {
    const key = str(option.key) as DecisionKey;
    const shots = Array.isArray(option.shots) ? option.shots.filter(isRecord) : [];
    const shot = shots.find((candidate) => candidate.role === `option-${key}`) ?? shots[0];
    const px = Array.isArray(shot?.px) && shot!.px.length === 2 ? shot!.px as number[] : undefined;
    const callouts = Array.isArray(shot?.callouts)
      ? shot!.callouts.filter(isRecord).map((callout) => ({ n: callout.n as number, box: callout.box as DecisionCallout["box"], note: String(callout.note ?? "") }))
      : undefined;
    return {
      key,
      label: str(option.button) ?? "",
      result: str(option.result) ?? "",
      undo: (option.undo === "hard" ? "hard" : "easy") as DecisionUndo,
      ...(shot && str(shot.path) ? { picture: {
        path: str(shot.path)!,
        ...(px ? { width: px[0], height: px[1] } : {}),
        ...(callouts?.length ? { callouts } : {}),
      } } : {}),
    };
  });
  const history = isRecord(decision.history_check) ? decision.history_check : undefined;
  const defaultKey = str(decision.default_key);
  const detailParts = [str(decision.details_md), str(decision.impact) && `Impact: ${str(decision.impact)}`, str(decision.unknowns) && `Unknowns: ${str(decision.unknowns)}`]
    .filter((part): part is string => Boolean(part));
  if (problems.length) throw new DecisionCardError(problems);
  return {
    kind: "decision",
    version: DECISION_CARD_VERSION,
    question: str(decision.title) ?? "",
    pick: { key: pickKey as DecisionKey, why: stripRecommendation(str(decision.bluf) ?? "", pickKey) },
    options,
    door: door!,
    // decision-pack never defaults a gated item; neither do we.
    ...(defaultKey && door === "two_way" && gate === "none" ? { defaultKey: defaultKey as DecisionKey } : {}),
    ...(str(decision.cost_of_wait) ? { costOfWait: str(decision.cost_of_wait) } : {}),
    ...(detailParts.length ? { details: detailParts.join("\n\n") } : {}),
    ...(history?.result === "doubtful" && str(history.quote) ? { alreadyDecided: {
      quote: str(history.quote)!,
      at: str(history.quote_date_local) ?? str(history.at) ?? "",
      ...(isKey(history.quote_choice_key) ? { key: history.quote_choice_key } : {}),
    } } : {}),
    source: {
      kind: "decision-pack",
      ...(project ? { project } : {}),
      id: str(decision.id) ?? "",
      version: typeof decision.version === "number" ? decision.version : 1,
    },
  };
}

/* ------------------------------------------------------------------ */
/* answers                                                             */
/* ------------------------------------------------------------------ */

/** The answer rules for a card. Returns problems, empty when the answer fits the card. */
export function validateOperatorCardAnswer(card: OperatorCard, answer: unknown): string[] {
  if (!isRecord(answer)) return ["answer: not an object"];
  const note = answer.note;
  if (note !== undefined && (typeof note !== "string" || note.length > DECISION_CARD_LIMITS.note)) {
    return [`answer.note: text of at most ${DECISION_CARD_LIMITS.note} characters`];
  }
  if (card.kind === "permission") {
    const offered = card.answers.map((entry) => entry.kind);
    return offered.includes(answer.kind as PermissionAnswerKind) ? [] : [`answer.kind: this request offers ${offered.join(", ")}`];
  }
  const errors: string[] = [];
  const keys = card.options.map((option) => option.key);
  const hasNote = typeof note === "string" && note.trim().length > 0;
  switch (answer.kind) {
    case "pick":
      if (!isKey(answer.key) || !keys.includes(answer.key)) errors.push("answer.key: must name one of the options");
      break;
    case "take_pick":
      if (!card.pick) errors.push("answer.kind: this card has no pick to take");
      if (answer.key !== undefined && answer.key !== card.pick?.key) errors.push("answer.key: take_pick takes the card's pick");
      break;
    case "disagree_go":
      if (!card.pick) errors.push("answer.kind: this card has no pick to go ahead with");
      if (!hasNote) errors.push("answer.note: say the concern");
      if (answer.key !== undefined && answer.key !== card.pick?.key) errors.push("answer.key: disagree_go goes with the card's pick");
      break;
    case "something_else":
      if (!hasNote) errors.push("answer.note: say what to do instead");
      if (answer.key !== undefined) errors.push("answer.key: something_else names no option");
      break;
    case "show_more":
      if (answer.key !== undefined) errors.push("answer.key: show_more does not choose");
      break;
    case "keep_earlier":
      if (!card.alreadyDecided) errors.push("answer.kind: this card has no earlier answer to keep");
      break;
    default:
      errors.push("answer.kind: must be pick, take_pick, disagree_go, something_else, show_more or keep_earlier");
  }
  const regions = answer.regions;
  if (regions !== undefined) {
    if (!Array.isArray(regions) || regions.length > 12) errors.push("answer.regions: a list of at most 12");
    else regions.forEach((region, index) => {
      const at = `answer.regions[${index}]`;
      if (!isRecord(region) || !isKey(region.optionKey) || !keys.includes(region.optionKey)) { errors.push(`${at}.optionKey: must name one of the options`); return; }
      const picture = decisionOption(card, region.optionKey)?.picture;
      if (region.calloutN !== undefined && !picture?.callouts?.some((callout) => callout.n === region.calloutN)) {
        errors.push(`${at}.calloutN: option ${region.optionKey} has no callout ${String(region.calloutN)}`);
      }
      if (region.boxPx !== undefined) {
        const box = region.boxPx;
        if (!picture) errors.push(`${at}.boxPx: option ${region.optionKey} has no picture`);
        else if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
          || box[0] + box[2] > picture.width + 0.5 || box[1] + box[3] > picture.height + 0.5) {
          errors.push(`${at}.boxPx: must be [x, y, w, h] inside the ${picture.width}x${picture.height} picture`);
        }
      }
    });
  }
  return errors;
}

/** The option an answer goes ahead with, if any. */
export function decisionAnswerKey(card: DecisionCard, answer: DecisionAnswer): DecisionKey | undefined {
  if (answer.kind === "pick") return answer.key;
  if (answer.kind === "take_pick" || answer.kind === "disagree_go") return card.pick?.key;
  if (answer.kind === "keep_earlier") return card.alreadyDecided?.key;
  return undefined;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function regionText(regions: DecisionAnswerRegion[] | undefined): string {
  return (regions ?? []).map((region) => region.calloutN !== undefined
    ? `Pointed at callout ${region.calloutN} on ${region.optionKey}.`
    : region.boxPx ? `Marked [${region.boxPx.map((v) => Math.round(v)).join(", ")}] on ${region.optionKey}.`
    : `Pointed at ${region.optionKey}.`).join(" ");
}

/**
 * The answer as one line, for harnesses that read only text:
 * `B (Pro only): only Pro, not Starter. Pointed at callout 3 on B.`
 */
export function renderOperatorCardAnswerText(card: OperatorCard, answer: OperatorCardAnswer): string {
  const note = answer.note?.trim();
  if (card.kind === "permission") {
    const label = card.answers.find((entry) => entry.kind === answer.kind)?.label ?? answer.kind;
    return [`${label}.`, note ? sentence(note) : ""].filter(Boolean).join(" ");
  }
  const decision = answer as DecisionAnswer;
  const named = (key: DecisionKey | undefined) => {
    const option = decisionOption(card, key);
    return option ? `${option.key} (${option.label})` : "";
  };
  const regions = regionText(decision.regions);
  let head: string;
  switch (decision.kind) {
    case "pick": head = note ? `${named(decision.key)}: ${sentence(note)}` : `${named(decision.key)}.`; break;
    case "take_pick": head = `${named(card.pick?.key)}, your pick.`; break;
    case "disagree_go": head = `${named(card.pick?.key)}, your pick, but I have a concern: ${sentence(note ?? "")}`; break;
    case "something_else": head = `None of these: ${sentence(note ?? "")}`; break;
    case "show_more": head = `Show me more before I decide${note ? `: ${sentence(note)}` : "."}`; break;
    case "keep_earlier": {
      const prior = card.alreadyDecided;
      const key = named(prior?.key);
      head = `Keep my earlier answer${prior?.at ? ` from ${prior.at.slice(0, 10)}` : ""}${key ? `, ${key}` : ""}: "${prior?.quote ?? ""}"${note ? ` ${sentence(note)}` : ""}`;
      break;
    }
    default: head = note ?? "";
  }
  return [head, regions].filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ */
/* history                                                             */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(("a about after all also an and any are as at be been before being both but by can could did do does doing for from "
  + "had has have how i if in into is it its just me more most my no nor not now of on once only or other our out over own same should so some "
  + "such than that the their them then there these they this those through to too under until up very was we were what when where which while "
  + "who whom why will with would you your yours ok okay want wants go use using need needs should shall let lets").split(" "));

/** Content words of a text, lightly stemmed, for topic matching. */
export function decisionTopicTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/[\s-]+/u)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map((word) => word.replace(/(?:ies)$/u, "y").replace(/(?<=[^s])s$/u, "")))];
}

export type PriorOperatorAnswer = {
  recordId: string;
  question: string;
  options?: string[];
  answer: string;
  answeredAt: number;
};

function overlap(a: readonly string[], b: readonly string[]): { shared: number; jaccard: number } {
  const right = new Set(b);
  const shared = a.filter((term) => right.has(term)).length;
  const union = new Set([...a, ...b]).size;
  return { shared, jaccard: union ? shared / union : 0 };
}

/**
 * The most recent earlier answer on the same topic, or nothing. A match is
 * clear only when the questions share most of their content words and, when
 * both carry options, the options agree too. The result is shown on the card;
 * it is never used to answer.
 */
export function findPriorDecision(
  current: { question: string; options?: string[]; recordId?: string },
  prior: Iterable<PriorOperatorAnswer>,
): DecisionAlreadyDecided | undefined {
  const terms = decisionTopicTerms(current.question);
  if (terms.length < 2) return undefined;
  const labels = (current.options ?? []).map((label) => label.trim().toLowerCase());
  let best: PriorOperatorAnswer | undefined;
  for (const entry of prior) {
    if (entry.recordId === current.recordId || !entry.answer.trim()) continue;
    const { shared, jaccard } = overlap(terms, decisionTopicTerms(entry.question));
    const exact = current.question.trim().toLowerCase() === entry.question.trim().toLowerCase();
    if (!exact && (jaccard < 0.6 || shared < Math.min(3, terms.length))) continue;
    const priorLabels = (entry.options ?? []).map((label) => label.trim().toLowerCase());
    if (labels.length && priorLabels.length && overlap(labels, priorLabels).jaccard < 0.5) continue;
    if (!best || entry.answeredAt > best.answeredAt) best = entry;
  }
  if (!best) return undefined;
  const answer = best.answer.trim();
  const said = answer.toLowerCase();
  const key = current.options?.findIndex((label) => {
    const l = label.trim().toLowerCase();
    return said === l || said.startsWith(`${l}.`) || said.startsWith(`${l}:`) || said.startsWith(`${l},`) || said.startsWith(`${l} `);
  });
  return {
    quote: answer.length > DECISION_CARD_LIMITS.quote ? `${answer.slice(0, DECISION_CARD_LIMITS.quote - 1)}…` : answer,
    at: new Date(best.answeredAt).toISOString(),
    ...(key !== undefined && key >= 0 ? { key: DECISION_KEYS[key] } : {}),
    recordId: best.recordId,
  };
}

/* ------------------------------------------------------------------ */
/* reads                                                               */
/* ------------------------------------------------------------------ */

export type OperatorCardState = "open" | "needs_material" | "answered" | "defaulted" | "closed";

/** Synthesis bookkeeping, kept beside the card so a surface can say why there is none. */
export type DecisionSynthesisInfo = {
  /** `card`: a card was made. `question`: the text holds no real choice. `failed`: the model call failed; the plain ask stands. */
  outcome: "card" | "question" | "failed";
  sourceHash: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
  at: number;
};

/** What a surface reads: one card, where it came from, and its answer state. */
export type OperatorCardView = {
  /** The question record id (`operator-question:<message>` or a permission request id). */
  id: string;
  messageId?: string;
  conversationId?: string;
  taskId?: string;
  askedBy?: string;
  createdAt: number;
  state: OperatorCardState;
  /** The ask as the agent wrote it. Always present, so a surface without a card still has the plain ask. */
  plain: { question: string; options: string[]; because?: string; defaultAction?: string; answerDeadline?: number };
  /** Absent when no card exists: show the plain ask. Never an empty card. */
  card?: OperatorCard;
  origin?: OperatorCardOrigin;
  synthesis?: DecisionSynthesisInfo;
  answer?: { answer: OperatorCardAnswer; text: string; at: number; by: "operator" | "default" };
  /** show_more answers, oldest first, while the task stays open. */
  requests?: Array<{ note?: string; at: number }>;
};
