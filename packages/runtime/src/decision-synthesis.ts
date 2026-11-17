import { createHash } from "node:crypto";

import {
  DECISION_CARD_LIMITS,
  DECISION_KEYS,
  validateDecisionCard,
  type DecisionCard,
  type DecisionDoor,
  type DecisionKey,
  type DecisionUndo,
} from "@openscout/protocol";

/**
 * Synthesis turns a plain operator ask into a decision card, once per ask.
 *
 * Structured fields come first: `--option` labels are the options, verbatim,
 * and `--default-action` makes the door two-way. A small model reads the words
 * only to fill what the fields do not say. Code then checks every option and
 * any pick against the ask's own text. Whatever the model returns, a card never
 * holds an option or a pick the ask does not contain. If there is no real
 * choice, the ask stays a question.
 */

export const DECISION_SYNTHESIS_PROMPT_VERSION = 2;
/** Labels from `--option` are kept verbatim, so they may run past the 18 characters an agent's card allows. */
const SYNTHESIZED_LABEL_MAX = DECISION_CARD_LIMITS.synthesizedLabel;

export type DecisionSynthesisSource = {
  question: string;
  body: string;
  options: string[];
  because?: string;
  defaultAction?: string;
  answerDeadline?: number;
};

/** The cache key: the same ask text, fields, prompt and model always reuse one result. */
export function decisionSourceHash(source: DecisionSynthesisSource, model: string): string {
  const normalized = {
    v: DECISION_SYNTHESIS_PROMPT_VERSION,
    model,
    question: source.question.trim().replace(/\s+/gu, " "),
    body: source.body.trim().replace(/\s+/gu, " "),
    options: source.options.map((option) => option.trim()),
    because: source.because?.trim().replace(/\s+/gu, " ") ?? "",
    defaultAction: source.defaultAction?.trim() ?? "",
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export type DecisionModelOutput = {
  isChoice: boolean;
  question: string;
  options: Array<{ label: string; quote: string; result: string; undo: "easy" | "hard" | "unknown" }>;
  pick: { label: string; quote: string; why: string } | null;
  door: "one_way" | "two_way" | "unknown";
};

export const DECISION_MODEL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isChoice", "question", "options", "pick", "door"],
  properties: {
    isChoice: { type: "boolean", description: "True only if the ask offers the operator two or three distinct courses of action to choose between." },
    question: { type: "string", description: "The decision in plain words, at most 60 characters. No ids, PR numbers or paths." },
    options: {
      type: "array",
      description: "The courses of action the ask itself offers, in the order it offers them. Empty if it offers none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "quote", "result", "undo"],
        properties: {
          label: { type: "string", description: "One or two words for a button. When fixed labels are given, copy the label exactly." },
          quote: { type: "string", description: "The exact words from the ask that state this option, copied character for character." },
          result: { type: "string", description: "What happens if the operator picks it, at most 90 characters, using only what the ask says." },
          undo: { type: "string", enum: ["easy", "hard", "unknown"], description: "Whether the ask says it can be undone easily. unknown if the ask does not say." },
        },
      },
    },
    pick: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["label", "quote", "why"],
          properties: {
            label: { type: "string", description: "The label of the option the asker says they prefer." },
            quote: { type: "string", description: "The exact words where the asker states that preference." },
            why: { type: "string", description: "The asker's reason, at most 160 characters, from the ask's words." },
          },
        },
      ],
      description: "Only when the asker explicitly recommends or prefers one option. Otherwise null.",
    },
    door: { type: "string", enum: ["one_way", "two_way", "unknown"], description: "one_way if the ask says the choice is hard to reverse, two_way if easy to reverse, unknown otherwise." },
  },
} as const;

export const DECISION_SYSTEM_PROMPT = [
  "You read one question an AI agent sent to the human operator of a software project, and you lay it out as a decision card.",
  "You extract. You never add. Every option must be a course of action the question itself offers, and its quote must be copied exactly from the question.",
  "Set isChoice to false when the question asks for information, a free-text answer, an approval with no alternative, or offers more than three options.",
  "A pick exists only when the asker explicitly recommends or prefers one option, in words you can quote. A default or a first-listed option is not a pick.",
  "Keep labels to one or two words. Keep the question short and plain.",
].join(" ");

export function decisionModelPrompt(source: DecisionSynthesisSource): string {
  const lines = [
    "<question>",
    source.body.trim(),
    "</question>",
  ];
  if (source.because?.trim()) lines.push("<asker_reason>", source.because.trim(), "</asker_reason>");
  if (source.options.length) {
    lines.push("<fixed_labels>", ...source.options.map((option) => `- ${option}`), "</fixed_labels>",
      "The asker gave these option labels. Use them as the options, in this order, with these exact labels. Quote the words that describe each one, or the label itself.");
  }
  if (source.defaultAction?.trim()) lines.push(`<default_if_unanswered>${source.defaultAction.trim()}</default_if_unanswered>`);
  return lines.join("\n");
}

function norm(value: string): string {
  return value.toLowerCase().normalize("NFKC")
    .replace(/[‘’‚‛]/gu, "'").replace(/[“”„‟]/gu, "\"")
    .replace(/[‐-―]/gu, "-").replace(/[`*_]/gu, "").replace(/\s+/gu, " ").trim();
}

/** A quote counts only if the ask contains it, ignoring case, spacing and markdown marks. */
export function quotedIn(sourceText: string, quote: string): boolean {
  const needle = norm(quote);
  return needle.length >= 2 && norm(sourceText).includes(needle);
}

const PREFERENCE = /\b(recommend|prefer|suggest|i'?d (?:go|pick|choose|take)|i would (?:go|pick|choose|take)|my (?:pick|vote|preference)|lean(?:ing)? (?:toward|towards|to)|best (?:option|choice|bet)|go with)\b/iu;

function shorten(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function plainQuestion(source: DecisionSynthesisSource, proposed: string): string {
  const candidate = proposed.trim();
  if (candidate && candidate.length <= DECISION_CARD_LIMITS.question) return candidate;
  const first = source.question.trim().split(/(?<=[?.!])\s|\n/u)[0] ?? source.question;
  return shorten(first, DECISION_CARD_LIMITS.question);
}

export type DecisionSynthesisOutcome =
  | { outcome: "card"; card: DecisionCard }
  | { outcome: "question"; reason: string };

/**
 * Build the card from the model's reading, keeping only what the ask backs.
 * Pure: the same source and output always give the same result.
 */
export function cardFromModelOutput(source: DecisionSynthesisSource, raw: unknown): DecisionSynthesisOutcome {
  const output = raw as Partial<DecisionModelOutput> | null;
  if (!output || typeof output !== "object" || !Array.isArray(output.options)) return { outcome: "question", reason: "unreadable model output" };
  const sourceText = [source.body, source.because ?? "", ...source.options].join("\n");
  const fixed = source.options.map((option) => option.trim()).filter(Boolean);
  if (fixed.length > 3) return { outcome: "question", reason: `${fixed.length} options; a card holds 2 or 3` };

  let chosen: Array<{ label: string; result: string; undo: DecisionUndo }>;
  if (fixed.length >= 2) {
    // The asker's labels are the options. The model may only describe them.
    chosen = fixed.map((label) => {
      const described = output.options!.find((option) => typeof option?.label === "string" && option.label.trim().toLowerCase() === label.toLowerCase());
      const grounded = described && typeof described.quote === "string" && quotedIn(sourceText, described.quote);
      return {
        label,
        result: grounded && typeof described.result === "string" && described.result.trim() ? shorten(described.result, DECISION_CARD_LIMITS.result) : shorten(label, DECISION_CARD_LIMITS.result),
        undo: grounded && (described.undo === "easy" || described.undo === "hard") ? described.undo : "unknown",
      };
    });
  } else {
    if (output.isChoice !== true) return { outcome: "question", reason: "the ask offers no choice" };
    const seen = new Set<string>();
    chosen = [];
    for (const option of output.options) {
      if (!option || typeof option.label !== "string" || typeof option.quote !== "string") continue;
      const label = option.label.trim();
      if (!label || label.length > SYNTHESIZED_LABEL_MAX || seen.has(label.toLowerCase())) continue;
      if (!quotedIn(sourceText, option.quote)) continue;
      seen.add(label.toLowerCase());
      chosen.push({
        label,
        result: shorten(typeof option.result === "string" && option.result.trim() ? option.result : option.quote, DECISION_CARD_LIMITS.result),
        undo: option.undo === "easy" || option.undo === "hard" ? option.undo : "unknown",
      });
    }
    if (chosen.length < 2) return { outcome: "question", reason: "fewer than two options are stated in the ask" };
    if (chosen.length > 3) return { outcome: "question", reason: "more than three options" };
  }

  const keyed = chosen.map((option, index) => ({ key: DECISION_KEYS[index]!, ...option }));
  const keyFor = (label: string | undefined): DecisionKey | undefined =>
    label ? keyed.find((option) => option.label.toLowerCase() === label.trim().toLowerCase())?.key : undefined;

  let pick: DecisionCard["pick"];
  const proposedPick = output.pick;
  if (proposedPick && typeof proposedPick.quote === "string" && quotedIn(sourceText, proposedPick.quote) && PREFERENCE.test(proposedPick.quote)) {
    const key = keyFor(proposedPick.label);
    if (key) pick = { key, why: shorten(typeof proposedPick.why === "string" && proposedPick.why.trim() ? proposedPick.why : proposedPick.quote, DECISION_CARD_LIMITS.why) };
  }

  const defaultKey = keyFor(source.defaultAction);
  // The asker's own default makes it a two-way door: the task already proceeds
  // without an answer. The model's reading is shown only when there is none.
  const door: DecisionDoor = source.defaultAction ? "two_way"
    : output.door === "one_way" || output.door === "two_way" ? output.door : "unknown";
  const details = source.body.trim().length > DECISION_CARD_LIMITS.question ? shorten(source.body, DECISION_CARD_LIMITS.details) : undefined;
  const card: DecisionCard = {
    kind: "decision",
    version: 1,
    question: plainQuestion(source, typeof output.question === "string" ? output.question : ""),
    ...(pick ? { pick } : {}),
    options: keyed,
    door,
    ...(defaultKey && door === "two_way" ? { defaultKey } : {}),
    ...(source.defaultAction && source.answerDeadline ? { costOfWait: shorten(`Unanswered by ${new Date(source.answerDeadline).toISOString().slice(11, 16)} UTC, it goes ahead with "${source.defaultAction}".`, DECISION_CARD_LIMITS.costOfWait) } : {}),
    ...(details ? { details } : {}),
  };
  const problems = validateDecisionCard(card, { origin: "synthesized", pictures: "attachment" });
  if (problems.length) return { outcome: "question", reason: problems.join("; ") };
  return { outcome: "card", card };
}

/* ------------------------------------------------------------------ */
/* the model                                                           */
/* ------------------------------------------------------------------ */

/** One turn through a harness. A thrown error or `null` output means: keep the plain ask. */
export interface DecisionModel {
  /** The model as the harness names it (`haiku`, or an override). */
  readonly model: string;
  /** The path the turn takes, e.g. `claude-cli`. */
  readonly via: string;
  extract(input: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<{ output: unknown }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check the harness's JSON against `DECISION_MODEL_OUTPUT_SCHEMA`, strictly:
 * every required key, no extra keys, the right types and enum values. Any
 * problem means the plain ask stands. A card built from valid output is then
 * checked again by `validateDecisionCard`.
 */
export function decisionModelOutputProblems(raw: unknown): string[] {
  if (!isPlainObject(raw)) return ["the output is not a JSON object"];
  const problems: string[] = [];
  const exactKeys = (value: Record<string, unknown>, keys: readonly string[], where: string) => {
    for (const key of keys) if (!(key in value)) problems.push(`${where} is missing ${key}`);
    for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push(`${where} has an extra key ${key}`);
  };
  const needString = (value: unknown, where: string) => {
    if (typeof value !== "string") problems.push(`${where} is not a string`);
  };
  const needEnum = (value: unknown, allowed: readonly string[], where: string) => {
    if (typeof value !== "string" || !allowed.includes(value)) problems.push(`${where} is not one of ${allowed.join(", ")}`);
  };

  exactKeys(raw, ["isChoice", "question", "options", "pick", "door"], "the card");
  if (typeof raw.isChoice !== "boolean") problems.push("isChoice is not a boolean");
  needString(raw.question, "question");
  needEnum(raw.door, ["one_way", "two_way", "unknown"], "door");
  if (!Array.isArray(raw.options)) {
    problems.push("options is not an array");
  } else {
    raw.options.forEach((option, index) => {
      const where = `options[${index}]`;
      if (!isPlainObject(option)) {
        problems.push(`${where} is not an object`);
        return;
      }
      exactKeys(option, ["label", "quote", "result", "undo"], where);
      needString(option.label, `${where}.label`);
      needString(option.quote, `${where}.quote`);
      needString(option.result, `${where}.result`);
      needEnum(option.undo, ["easy", "hard", "unknown"], `${where}.undo`);
    });
  }
  if (raw.pick !== null && "pick" in raw) {
    if (!isPlainObject(raw.pick)) {
      problems.push("pick is not null or an object");
    } else {
      exactKeys(raw.pick, ["label", "quote", "why"], "pick");
      needString(raw.pick.label, "pick.label");
      needString(raw.pick.quote, "pick.quote");
      needString(raw.pick.why, "pick.why");
    }
  }
  return problems;
}

export type DecisionSynthesisResult =
  | (DecisionSynthesisOutcome & { durationMs?: number })
  | { outcome: "failed"; error: string; durationMs?: number };

export async function synthesizeDecisionCard(
  source: DecisionSynthesisSource,
  model: DecisionModel,
  now: () => number = Date.now,
): Promise<DecisionSynthesisResult> {
  const started = now();
  try {
    const { output } = await model.extract({ system: DECISION_SYSTEM_PROMPT, prompt: decisionModelPrompt(source), schema: DECISION_MODEL_OUTPUT_SCHEMA as unknown as Record<string, unknown> });
    const durationMs = now() - started;
    if (output === null || output === undefined) return { outcome: "failed", error: "the harness returned no JSON", durationMs };
    const problems = decisionModelOutputProblems(output);
    if (problems.length) return { outcome: "failed", error: `the harness's JSON does not match the card schema: ${problems.slice(0, 4).join("; ")}`, durationMs };
    return { ...cardFromModelOutput(source, output), durationMs };
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error), durationMs: now() - started };
  }
}
