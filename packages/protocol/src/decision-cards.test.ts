import { describe, expect, test } from "bun:test";

import {
  applyDecisionToTask,
  decisionDraftFromInput,
  findPriorDecision,
  renderOperatorCardAnswerText,
  validateDecisionCard,
  validateOperatorCardAnswer,
  type DecisionCard,
  type PermissionCard,
} from "./decision-cards.js";
import { validateTaskAsk, type ScoutTaskAsk } from "./tasks.js";

const card = (patch: Partial<DecisionCard> = {}): DecisionCard => ({
  kind: "decision",
  version: 1,
  question: "Which pricing table ships?",
  pick: { key: "A", why: "Shows every plan at once." },
  options: [
    { key: "A", label: "All plans", result: "One table with Free, Starter and Pro.", undo: "easy" },
    { key: "B", label: "Pro only", result: "Only Pro, with a link to the rest.", undo: "easy",
      picture: { attachmentId: "m.decision.0", width: 800, height: 600, callouts: [{ n: 3, box: [10, 10, 100, 50], note: "Price" }] } },
  ],
  door: "two_way",
  ...patch,
});

// A decision in the decision-pack data format (fields only; written for this test).
const packDecision = {
  id: "pricing-table",
  version: 2,
  status: "open",
  title: "Which pricing table ships?",
  bluf: "I recommend A: it shows every plan at once.",
  door: "two_way",
  gate: "none",
  default_key: "A",
  cost_of_wait: "Launch page waits on this.",
  impact: "Everyone who visits pricing.",
  options: [
    { key: "A", button: "All plans", result: "One table, all plans.", undo: "easy", recommended: true,
      shots: [{ role: "option-A", path: "shots/a.png", px: [800, 600], callouts: [{ n: 1, box: [0, 0, 50, 50], note: "Free tier" }] }] },
    { key: "B", button: "Pro only", result: "Only Pro.", undo: "hard" },
  ],
  history_check: { result: "doubtful", quote: "Show all plans, always.", quote_date_local: "2026-11-02", quote_choice_key: "A" },
};

describe("decision-pack mapping", () => {
  test("maps a pack decision into our card shape", () => {
    const draft = decisionDraftFromInput({ project: "site", decisions: [packDecision] });
    expect(draft.question).toBe("Which pricing table ships?");
    expect(draft.pick).toEqual({ key: "A", why: "it shows every plan at once." });
    expect(draft.options.map((option) => option.label)).toEqual(["All plans", "Pro only"]);
    expect(draft.options[0]!.picture).toEqual({ path: "shots/a.png", width: 800, height: 600, callouts: [{ n: 1, box: [0, 0, 50, 50], note: "Free tier" }] });
    expect(draft.options[1]!.undo).toBe("hard");
    expect(draft.defaultKey).toBe("A");
    expect(draft.costOfWait).toBe("Launch page waits on this.");
    expect(draft.details).toContain("Impact: Everyone who visits pricing.");
    expect(draft.alreadyDecided).toEqual({ quote: "Show all plans, always.", at: "2026-11-02", key: "A" });
    expect(draft.source).toEqual({ kind: "decision-pack", project: "site", id: "pricing-table", version: 2 });
    expect(validateDecisionCard(draft, { origin: "agent", pictures: "path" })).toEqual([]);
  });

  test("drops a default on a one-way or gated decision", () => {
    expect(decisionDraftFromInput({ ...packDecision, door: "one_way" }).defaultKey).toBeUndefined();
    expect(decisionDraftFromInput({ ...packDecision, gate: "operator" }).defaultKey).toBeUndefined();
  });

  test("selects one decision by id and refuses an ambiguous pack", () => {
    const pack = { decisions: [packDecision, { ...packDecision, id: "other" }] };
    expect(() => decisionDraftFromInput(pack)).toThrow(/2 open decisions/);
    expect(decisionDraftFromInput(pack, "other").source?.id).toBe("other");
    expect(() => decisionDraftFromInput(pack, "missing")).toThrow(/no decision with id missing/);
  });

  test("requires exactly one recommended option", () => {
    const none = { ...packDecision, options: packDecision.options.map((option) => ({ ...option, recommended: false })) };
    expect(() => decisionDraftFromInput(none)).toThrow(/exactly one option needs recommended/);
  });

  test("passes our own shape through", () => {
    const { pick, ...rest } = card();
    expect(decisionDraftFromInput({ ...rest, pick })).toEqual(card());
  });
});

describe("card validation", () => {
  const agent = { origin: "agent", pictures: "attachment" } as const;

  test("accepts a valid card", () => expect(validateDecisionCard(card(), agent)).toEqual([]));

  test("needs exactly one pick on an agent card", () => {
    expect(validateDecisionCard(card({ pick: undefined }), agent)).toContain("decision.pick: name exactly one pick, with a line of why");
    expect(validateDecisionCard(card({ pick: { key: "C" as "A", why: "x" } }), agent)).toContain("decision.pick.key: must name one of the options");
    expect(validateDecisionCard(card({ pick: undefined }), { ...agent, origin: "synthesized" })).toEqual([]);
  });

  test("needs 2 or 3 options keyed in order", () => {
    const one = card({ options: [card().options[0]!] });
    expect(validateDecisionCard(one, agent)).toContain("decision.options: give 2 or 3 options");
    const four = card({ options: [...card().options, { ...card().options[0]!, key: "C", label: "x" }, { ...card().options[0]!, key: "C", label: "y" }] });
    expect(validateDecisionCard(four, agent)).toContain("decision.options: give 2 or 3 options");
    const swapped = card({ options: [card().options[1]!, card().options[0]!] });
    expect(validateDecisionCard(swapped, agent).some((problem) => problem.includes(".key: must be A"))).toBe(true);
  });

  test("allows a default only on a two-way door", () => {
    expect(validateDecisionCard(card({ defaultKey: "A" }), agent)).toEqual([]);
    expect(validateDecisionCard(card({ door: "one_way", defaultKey: "A" }), agent)).toContain("decision.defaultKey: a default is allowed only on a two-way door");
  });

  test("keeps ids out of the question and callouts inside the picture", () => {
    expect(validateDecisionCard(card({ question: "Merge PR #260?" }), agent).some((problem) => problem.startsWith("decision.question"))).toBe(true);
    const outside = card();
    outside.options[1]!.picture!.callouts![0]!.box = [700, 500, 200, 200];
    expect(validateDecisionCard(outside, agent).some((problem) => problem.includes("falls outside"))).toBe(true);
  });

  test("a task's options and default follow the card", () => {
    expect(applyDecisionToTask({ operator: true }, card({ defaultKey: "B" }))).toEqual({ operator: true, options: ["All plans", "Pro only"], defaultAction: "Pro only" });
    expect(() => applyDecisionToTask({ options: ["Yes", "No"] }, card())).toThrow(/--option must match/);
    expect(() => applyDecisionToTask({ defaultAction: "Ship" }, card({ door: "one_way" }))).toThrow(/needs a two-way door/);
    expect(() => applyDecisionToTask({ permission: true }, card())).toThrow(/permission/);
  });

  test("validateTaskAsk takes a decision only on an operator task, with its images", () => {
    const submission = { ...card(), options: [card().options[0]!, { ...card().options[1]!, picture: { image: 0 } }] };
    const ask = (patch: Partial<ScoutTaskAsk>): ScoutTaskAsk => ({ version: 1, operator: true, decision: submission as ScoutTaskAsk["decision"], ...patch });
    expect(() => validateTaskAsk(ask({}), { decisionImages: 1 })).not.toThrow();
    expect(() => validateTaskAsk(ask({}), { decisionImages: 0 })).toThrow(/decision images/);
    expect(() => validateTaskAsk(ask({ fyi: true }), { decisionImages: 1 })).toThrow();
  });
});

describe("answers", () => {
  test("each decision answer kind validates and renders one line", () => {
    const withPrior = card({ alreadyDecided: { quote: "All plans.", at: "2026-11-02T10:00:00.000Z", key: "A" } });
    const cases: Array<[Parameters<typeof renderOperatorCardAnswerText>[1], string]> = [
      [{ kind: "pick", key: "B", note: "only Pro, not Starter", regions: [{ optionKey: "B", calloutN: 3 }] }, "B (Pro only): only Pro, not Starter. Pointed at callout 3 on B."],
      [{ kind: "take_pick" }, "A (All plans), your pick."],
      [{ kind: "disagree_go", note: "the table is long" }, "A (All plans), your pick, but I have a concern: the table is long."],
      [{ kind: "something_else", note: "ship no table yet" }, "None of these: ship no table yet."],
      [{ kind: "show_more", note: "mobile layout" }, "Show me more before I decide: mobile layout."],
      [{ kind: "keep_earlier" }, "Keep my earlier answer from 2026-11-02, A (All plans): \"All plans.\""],
    ];
    for (const [answer, line] of cases) {
      expect(validateOperatorCardAnswer(withPrior, answer)).toEqual([]);
      expect(renderOperatorCardAnswerText(withPrior, answer)).toBe(line);
    }
  });

  test("refuses answers that do not fit the card", () => {
    expect(validateOperatorCardAnswer(card(), { kind: "pick", key: "C" })).toContain("answer.key: must name one of the options");
    expect(validateOperatorCardAnswer(card(), { kind: "disagree_go" })).toContain("answer.note: say the concern");
    expect(validateOperatorCardAnswer(card(), { kind: "something_else" })).toContain("answer.note: say what to do instead");
    expect(validateOperatorCardAnswer(card(), { kind: "keep_earlier" })).toContain("answer.kind: this card has no earlier answer to keep");
    expect(validateOperatorCardAnswer(card({ pick: undefined }), { kind: "take_pick" })).toContain("answer.kind: this card has no pick to take");
    expect(validateOperatorCardAnswer(card(), { kind: "pick", key: "A", regions: [{ optionKey: "A", calloutN: 1 }] }))
      .toContain("answer.regions[0].calloutN: option A has no callout 1");
  });

  test("a permission card takes only the answers it offers", () => {
    const permission: PermissionCard = {
      kind: "permission", version: 1, question: "Run bun test?", action: { summary: "Run bun test", tool: "Bash", command: "bun test" },
      where: { project: "scout" }, scope: "This one call.", answers: [{ kind: "allow_once", label: "Allow once" }, { kind: "deny", label: "Deny" }],
    };
    expect(validateOperatorCardAnswer(permission, { kind: "allow_once" })).toEqual([]);
    expect(validateOperatorCardAnswer(permission, { kind: "allow_always" })).toEqual(["answer.kind: this request offers allow_once, deny"]);
    expect(renderOperatorCardAnswerText(permission, { kind: "deny", note: "not on main" })).toBe("Deny. not on main.");
  });
});

describe("history check", () => {
  const prior = [
    { recordId: "q1", question: "Which pricing table ships on the launch page?", options: ["All plans", "Pro only"], answer: "Pro only. Starter confuses people.", answeredAt: Date.parse("2026-11-03T09:00:00Z") },
    { recordId: "q2", question: "Which pricing table ships on the launch page?", options: ["All plans", "Pro only"], answer: "All plans", answeredAt: Date.parse("2026-11-01T09:00:00Z") },
    { recordId: "q3", question: "Should the docs site use dark mode by default?", answer: "Yes", answeredAt: Date.parse("2026-11-04T09:00:00Z") },
  ];

  test("a clear match carries the latest answer, its date and its option", () => {
    const found = findPriorDecision({ question: "Which pricing table ships on the launch page?", options: ["All plans", "Pro only"] }, prior);
    expect(found).toEqual({ quote: "Pro only. Starter confuses people.", at: "2026-11-03T09:00:00.000Z", key: "B", recordId: "q1" });
  });

  test("a different topic or different options do not match", () => {
    expect(findPriorDecision({ question: "Which font ships on the launch page?" }, prior)).toBeUndefined();
    expect(findPriorDecision({ question: "Which pricing table ships on the launch page?", options: ["Monthly", "Yearly"] }, prior)).toBeUndefined();
  });

  test("never matches the ask itself", () => {
    expect(findPriorDecision({ question: "Should the docs site use dark mode by default?", recordId: "q3" }, prior)).toBeUndefined();
  });
});
