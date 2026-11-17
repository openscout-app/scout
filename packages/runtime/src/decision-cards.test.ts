import { describe, expect, test } from "bun:test";

import type {
  DecisionCard,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  QuestionRecord,
  ScoutOperatorSignal,
  ScoutTaskReply,
} from "@openscout/protocol";

import { BrokerDecisionCardService, DecisionAnswerError } from "./broker-decision-cards.js";
import { bindDecisionCard, decisionPictureAttachmentId, imagePixelSize } from "./decision-card-binding.js";
import { decisionSynthesisConfigured, createDecisionModel } from "./decision-synthesis-model.js";
import {
  cardFromModelOutput,
  decisionSourceHash,
  synthesizeDecisionCard,
  type DecisionModel,
  type DecisionSynthesisSource,
} from "./decision-synthesis.js";
import { permissionCardFromAsk, permissionCardFromRequest } from "./permission-card.js";

/* Real ask shapes, from this week's operator asks. */
const KEY_ASK: DecisionSynthesisSource = {
  question: "For the For you digest work: may I have an Anthropic API key for real Sonnet/Haiku runs? Store it with 'secret set ANTHROPIC_API_KEY' (I will read it only through 'secret run'), or tell me to go ahead without it.",
  body: "For the For you digest work: may I have an Anthropic API key for real Sonnet/Haiku runs? Store it with 'secret set ANTHROPIC_API_KEY' (I will read it only through 'secret run'), or tell me to go ahead without it.",
  options: [],
  because: "The For you digest calls Sonnet 5.5 and Haiku 5.5, and this host has no Anthropic key.",
  defaultAction: "Build and test it against a stubbed model, take screenshots with rules-only cards (which cover permission, review, push and blocked), and report real per-digest cost as not measured.",
  answerDeadline: Date.parse("2026-11-16T18:17:00Z"),
};
const MERGE_ASK: DecisionSynthesisSource = {
  question: "PR 205 is green locally. Merge it now, or wait for the app side?",
  body: "PR 205 is green locally. Merge it now, or wait for the app side? I'd go with merging now: the app reads the new field only when present.",
  options: ["Merge now", "Wait for the app"],
};
const STATUS_ASK: DecisionSynthesisSource = {
  question: "What is the hostname of the build box you want this on?",
  body: "What is the hostname of the build box you want this on?",
  options: [],
};

const fakeModel = (output: unknown, usage = { inputTokens: 1000, outputTokens: 250 }): DecisionModel & { calls: number } => {
  const model = {
    model: "claude-haiku-5-5",
    calls: 0,
    async extract() { model.calls += 1; return { output, usage }; },
  };
  return model;
};

describe("synthesis never invents", () => {
  test("keeps the asker's --option labels verbatim and grounds the pick in their words", () => {
    const result = cardFromModelOutput(MERGE_ASK, {
      isChoice: true, question: "Merge now or wait for the app?",
      options: [
        { label: "Merge now", quote: "Merge it now", result: "Lands today; the app reads the field when present.", undo: "easy" },
        { label: "Wait for the app", quote: "wait for the app side", result: "Lands with the app change.", undo: "easy" },
        { label: "Close it", quote: "close the PR", result: "Invented.", undo: "hard" },
      ],
      pick: { label: "Merge now", quote: "I'd go with merging now", why: "The app reads the new field only when present." },
      door: "two_way",
    });
    expect(result.outcome).toBe("card");
    if (result.outcome !== "card") return;
    expect(result.card.options.map((option) => option.label)).toEqual(["Merge now", "Wait for the app"]);
    expect(result.card.pick).toEqual({ key: "A", why: "The app reads the new field only when present." });
    expect(result.card.question).toBe("Merge now or wait for the app?");
  });

  test("drops options and a pick the ask does not say", () => {
    const result = cardFromModelOutput({ ...MERGE_ASK, body: MERGE_ASK.question }, {
      isChoice: true, question: "Merge or wait?",
      options: [{ label: "Merge now", quote: "Merge it now", result: "x", undo: "easy" }],
      pick: { label: "Merge now", quote: "Merging is safest", why: "made up" },
      door: "two_way",
    });
    expect(result.outcome).toBe("card");
    if (result.outcome !== "card") return;
    expect(result.card.pick).toBeUndefined();
    // "Wait for the app" was not described, so it says only its own label and an unknown undo.
    expect(result.card.options[1]).toEqual({ key: "B", label: "Wait for the app", result: "Wait for the app", undo: "unknown" });
    expect(result.card.door).toBe("two_way");
  });

  test("a quote must back a preference to become the pick", () => {
    const result = cardFromModelOutput(MERGE_ASK, {
      isChoice: true, question: "", options: [], pick: { label: "Merge now", quote: "PR 205 is green locally", why: "green" }, door: "unknown",
    });
    expect(result.outcome === "card" && result.card.pick).toBeFalsy();
  });

  test("an ask with no stated choice stays a question", () => {
    expect(cardFromModelOutput(STATUS_ASK, { isChoice: false, question: "", options: [], pick: null, door: "unknown" }).outcome).toBe("question");
    // Even when the model claims a choice, its options must be quoted from the ask.
    const invented = cardFromModelOutput(STATUS_ASK, {
      isChoice: true, question: "", door: "unknown", pick: null,
      options: [{ label: "build-1", quote: "build-1", result: "x", undo: "easy" }, { label: "build-2", quote: "build-2", result: "y", undo: "easy" }],
    });
    expect(invented).toEqual({ outcome: "question", reason: "fewer than two options are stated in the ask" });
  });

  test("the key ask: two choices quoted from its words, two-way because it has a default", () => {
    const result = cardFromModelOutput(KEY_ASK, {
      isChoice: true, question: "Give me an API key, or go without?",
      options: [
        { label: "Store a key", quote: "Store it with 'secret set ANTHROPIC_API_KEY'", result: "Real Sonnet/Haiku runs and a measured cost.", undo: "easy" },
        { label: "Go without", quote: "tell me to go ahead without it", result: "Stubbed model; cost reported as not measured.", undo: "easy" },
      ],
      pick: null, door: "two_way",
    });
    expect(result.outcome).toBe("card");
    if (result.outcome !== "card") return;
    expect(result.card.options.map((option) => option.label)).toEqual(["Store a key", "Go without"]);
    expect(result.card.pick).toBeUndefined();
    expect(result.card.door).toBe("two_way");
    expect(result.card.costOfWait).toContain("Unanswered by 18:17 UTC");
  });

  test("more than three --option values stay a question", () => {
    expect(cardFromModelOutput({ ...MERGE_ASK, options: ["a", "b", "c", "d"] }, { isChoice: true, options: [] }).outcome).toBe("question");
  });
});

describe("synthesis plumbing", () => {
  test("the cache key covers the text, fields, prompt and model", () => {
    const base = decisionSourceHash(MERGE_ASK, "claude-haiku-5-5");
    expect(decisionSourceHash({ ...MERGE_ASK, body: `  ${MERGE_ASK.body.replace(/ /gu, "  ")}\n` }, "claude-haiku-5-5")).toBe(base);
    expect(decisionSourceHash({ ...MERGE_ASK, options: ["Merge now"] }, "claude-haiku-5-5")).not.toBe(base);
    expect(decisionSourceHash({ ...MERGE_ASK, defaultAction: "Merge now" }, "claude-haiku-5-5")).not.toBe(base);
    expect(decisionSourceHash(MERGE_ASK, "other-model")).not.toBe(base);
  });

  test("a failed or empty model call is reported, never a card", async () => {
    const failing: DecisionModel = { model: "claude-haiku-5-5", async extract() { throw new Error("timeout"); } };
    expect(await synthesizeDecisionCard(MERGE_ASK, failing)).toEqual({ outcome: "failed", error: "timeout" });
    expect((await synthesizeDecisionCard(MERGE_ASK, fakeModel(null))).outcome).toBe("failed");
  });

  test("no credential, no model", () => {
    const empty = { ANTHROPIC_CONFIG_DIR: "/nonexistent-scout-test" } as NodeJS.ProcessEnv;
    expect(decisionSynthesisConfigured(empty)).toBe(false);
    expect(createDecisionModel(empty)).toBeUndefined();
    expect(decisionSynthesisConfigured({ ...empty, ANTHROPIC_API_KEY: "x" })).toBe(true);
    expect(decisionSynthesisConfigured({ ...empty, ANTHROPIC_API_KEY: "x", SCOUT_DECISION_SYNTHESIS: "0" })).toBe(false);
  });
});

describe("permission cards", () => {
  const request = (patch: Record<string, unknown> = {}): QuestionRecord => ({
    id: "perm-1", kind: "question", state: "open", acceptanceState: "none", title: "Permission request", summary: "Command requires approval",
    createdById: "agent-1", ownerId: "operator", createdAt: 1, updatedAt: 1,
    metadata: { permissionRequest: {
      sessionId: "s-raw-id", projectRoot: "/work/scout", version: "v1", decisions: ["once", "project", "deny"],
      decisionLabels: { once: "Allow once", project: "Allow always", deny: "Deny" },
      native: { harness: "claude", tool: "Bash", context: { text: "Running the unit tests before the PR.", source: "assistant" },
        display: { action: "Run bun test", command: "bun test src", note: "Run the runtime unit tests" }, alwaysRules: ["Bash(bun test:*)"] },
      ...patch,
    } },
  } as unknown as QuestionRecord);

  test("names the action, where, scope, reason and only the backed answers", () => {
    const card = permissionCardFromRequest(request(), { session: "scout-decision-cards" })!;
    expect(card.question).toBe("Run bun test?");
    expect(card.action).toEqual({ summary: "Run bun test", tool: "Bash", command: "bun test src" });
    expect(card.where).toEqual({ project: "scout", session: "scout-decision-cards", harness: "claude" });
    expect(card.reason).toBe("Run the runtime unit tests");
    expect(card.answers.map((answer) => answer.kind)).toEqual(["allow_once", "allow_always", "deny"]);
    expect(card.answers[1]!.grants).toEqual(["Bash(bun test:*)"]);
    expect(card.scope).toContain("Bash(bun test:*)");
    expect(JSON.stringify(card)).not.toContain("s-raw-id");
  });

  test("no always unless the runtime backs it; no reason unless the request has one", () => {
    const card = permissionCardFromRequest(request({ decisions: ["once", "deny"], native: { tool: "mcp__scout__ask", context: { text: "user said hi", source: "user" } } }))!;
    expect(card.answers.map((answer) => answer.kind)).toEqual(["allow_once", "deny"]);
    expect(card.reason).toBeUndefined();
    expect(card.action.tool).toBe("ask (scout)");
    expect(card.question).toBe("Command requires approval?");
  });

  test("an agent's --permission ask offers allow and deny", () => {
    const card = permissionCardFromAsk({ question: "May I force-push the docs branch?", because: "History is wrong", project: "scout" });
    expect(card.answers.map((answer) => answer.kind)).toEqual(["allow_once", "deny"]);
    expect(card.reason).toBe("History is wrong");
  });
});

describe("pictures", () => {
  const png = (width: number, height: number) => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bytes.buffer).setUint32(16, width);
    new DataView(bytes.buffer).setUint32(20, height);
    return bytes;
  };

  test("reads PNG, GIF and JPEG sizes", () => {
    expect(imagePixelSize(png(800, 600))).toEqual({ width: 800, height: 600 });
    expect(imagePixelSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00]))).toEqual({ width: 32, height: 16 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0, 0, 0, 0, 0]);
    expect(imagePixelSize(jpeg)).toEqual({ width: 512, height: 256 });
    expect(imagePixelSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("binds pictures to attachments, never paths", () => {
    const card = bindDecisionCard({
      kind: "decision", version: 1, question: "Which header?", pick: { key: "A", why: "Shorter." }, door: "two_way",
      options: [
        { key: "A", label: "Short", result: "One line.", undo: "easy", picture: { image: 0, callouts: [{ n: 1, box: [0, 0, 100, 100], note: "Logo" }] } },
        { key: "B", label: "Tall", result: "Two lines.", undo: "easy" },
      ],
    }, "msg-1", [{ data: Buffer.from(png(800, 600)).toString("base64"), mediaType: "image/png" }]);
    expect(card.options[0]!.picture).toEqual({ attachmentId: decisionPictureAttachmentId("msg-1", 0), width: 800, height: 600, callouts: [{ n: 1, box: [0, 0, 100, 100], note: "Logo" }] });
  });
});

/* ------------------------------------------------------------------ */
/* the service, against in-memory records and a fake reply path        */
/* ------------------------------------------------------------------ */

function harness(input: { model?: DecisionModel; signal?: ScoutOperatorSignal; invocationMeta?: Record<string, unknown>; card?: DecisionCard; body?: string; prior?: QuestionRecord[] } = {}) {
  const records = new Map<string, QuestionRecord>();
  for (const record of input.prior ?? []) records.set(record.id, record);
  const replies: Array<{ input: ScoutTaskReply; metadata: Record<string, unknown> }> = [];
  const flights = new Map<string, FlightRecord>();
  const messageId = "msg-request-abc";
  const signal: ScoutOperatorSignal = input.signal ?? { kind: "need", blocking: true, replyExpectation: "required", question: MERGE_ASK.question };
  const message = {
    id: messageId, conversationId: "dm-1", actorId: "agent-1", originNodeId: "n", class: "agent", body: input.body ?? MERGE_ASK.body, visibility: "private", policy: "durable", createdAt: 10,
    metadata: { operatorSignal: signal, ...(input.card ? { decisionCard: input.card } : {}) },
  } as unknown as MessageRecord;
  const invocation = { id: "inv-request-abc", metadata: { options: MERGE_ASK.options, ...input.invocationMeta } } as unknown as InvocationRequest;
  const questionId = `operator-question:${messageId}`;
  records.set(questionId, {
    id: questionId, kind: "question", state: "open", acceptanceState: "none", title: "Operator question", summary: signal.kind === "need" ? signal.question : message.body,
    createdById: "agent-1", ownerId: "operator", askedById: "operator", conversationId: "dm-1", createdAt: 10, updatedAt: 10,
    metadata: { operatorNeedMessageId: messageId },
  } as unknown as QuestionRecord);
  const service = new BrokerDecisionCardService({
    operatorActorId: "operator",
    record: (id) => records.get(id),
    questionRecords: () => records.values(),
    writeRecord: async (record) => { records.set(record.id, record); },
    message: (id) => (id === messageId ? message : undefined),
    invocation: (id) => (id === invocation.id ? invocation : undefined),
    currentFlight: (id) => flights.get(id),
    where: () => ({ session: "builder", project: "scout" }),
    reply: async (reply, extra) => {
      replies.push({ input: reply, metadata: extra.metadata });
      // What the daemon's settleOperatorQuestion does with a final reply.
      if (!reply.progress) {
        const record = records.get(questionId)!;
        records.set(questionId, { ...record, state: "closed", answer: reply.body, answeredAt: 20, closedAt: 20, metadata: { ...record.metadata, decisionAnswer: extra.metadata.decisionAnswer } });
      }
    },
    decidePermission: async () => {},
    ...(input.model ? { model: input.model } : {}),
    now: () => 20,
  });
  return { service, records, replies, flights, message, signal, questionId };
}

const MERGE_OUTPUT = {
  isChoice: true, question: "Merge now or wait for the app?",
  options: [
    { label: "Merge now", quote: "Merge it now", result: "Lands today.", undo: "easy" },
    { label: "Wait for the app", quote: "wait for the app side", result: "Lands with the app.", undo: "easy" },
  ],
  pick: { label: "Merge now", quote: "I'd go with merging now", why: "The app reads the field only when present." },
  door: "two_way",
};

describe("decision card service", () => {
  test("synthesizes once, records the cost, and reuses the cache for the same ask", async () => {
    const model = fakeModel(MERGE_OUTPUT);
    const h = harness({ model });
    await h.service.register(h.message, h.signal);
    await h.service.idle();
    const view = (await h.service.view("inv-request-abc"))!;
    expect(view.origin).toBe("synthesized");
    expect(view.card?.kind).toBe("decision");
    expect(view.synthesis).toMatchObject({ outcome: "card", model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 250, costUsd: 0.000225 });
    // Registering again does nothing: the card is made once.
    await h.service.register(h.message, h.signal);
    await h.service.idle();
    expect(model.calls).toBe(1);
  });

  test("with no model the ask stays plain, with no card at all", async () => {
    const h = harness();
    await h.service.register(h.message, h.signal);
    await h.service.idle();
    const view = (await h.service.view(h.questionId))!;
    expect(view.card).toBeUndefined();
    expect(view.plain).toMatchObject({ question: MERGE_ASK.body, options: ["Merge now", "Wait for the app"] });
    await expect(h.service.answer({ id: h.questionId, answer: { kind: "take_pick" }, requestId: "r1" })).rejects.toBeInstanceOf(DecisionAnswerError);
  });

  test("a failed model call leaves the plain ask and says why", async () => {
    const failing: DecisionModel = { model: "claude-haiku-5-5", async extract() { throw new Error("401 unauthorized"); } };
    const h = harness({ model: failing });
    await h.service.register(h.message, h.signal);
    await h.service.idle();
    const view = (await h.service.view(h.questionId))!;
    expect(view.card).toBeUndefined();
    expect(view.synthesis).toMatchObject({ outcome: "failed", error: "401 unauthorized" });
  });

  test("the history check shows an earlier answer and never answers", async () => {
    const earlier = {
      id: "operator-question:msg-request-old", kind: "question", state: "closed", acceptanceState: "none", title: "Operator question",
      summary: "PR 205 is green locally. Merge it now, or wait for the app side?", createdById: "agent-1", ownerId: "operator",
      createdAt: 1, updatedAt: 2, answer: "Wait for the app. They ship together.", answeredAt: Date.parse("2026-11-12T15:00:00Z"),
      metadata: { operatorCard: { kind: "decision", options: [{ label: "Merge now" }, { label: "Wait for the app" }] } },
    } as unknown as QuestionRecord;
    const h = harness({ model: fakeModel(MERGE_OUTPUT), prior: [earlier] });
    await h.service.register(h.message, h.signal);
    await h.service.idle();
    const view = (await h.service.view(h.questionId))!;
    expect(view.card?.kind === "decision" && view.card.alreadyDecided).toEqual({
      quote: "Wait for the app. They ship together.", at: "2026-11-12T15:00:00.000Z", key: "B", recordId: earlier.id,
    });
    expect(view.state).toBe("open");
    expect(h.replies).toHaveLength(0);
  });

  test("each answer kind round-trips to the asker as a reply with its one-line text", async () => {
    const card: DecisionCard = {
      kind: "decision", version: 1, question: "Merge now or wait for the app?", pick: { key: "A", why: "Safe." }, door: "two_way",
      options: [{ key: "A", label: "Merge now", result: "Lands today.", undo: "easy" }, { key: "B", label: "Wait for the app", result: "Lands later.", undo: "easy" }],
      alreadyDecided: { quote: "Wait for the app.", at: "2026-11-12T15:00:00.000Z", key: "B" },
    };
    const kinds = [
      [{ kind: "pick", key: "B", note: "ship together" }, "B (Wait for the app): ship together."],
      [{ kind: "take_pick" }, "A (Merge now), your pick."],
      [{ kind: "disagree_go", note: "watch the app" }, "A (Merge now), your pick, but I have a concern: watch the app."],
      [{ kind: "something_else", note: "split the PR" }, "None of these: split the PR."],
      [{ kind: "keep_earlier" }, "Keep my earlier answer from 2026-11-12, B (Wait for the app): \"Wait for the app.\""],
    ] as const;
    for (const [answer, line] of kinds) {
      const h = harness({ card });
      await h.service.register(h.message, h.signal);
      const view = await h.service.answer({ id: h.questionId, answer, requestId: `r-${answer.kind}` });
      expect(h.replies).toHaveLength(1);
      expect(h.replies[0]!.input).toMatchObject({ ref: "inv-request-abc", senderId: "operator", body: line });
      expect(h.replies[0]!.input.progress).toBeUndefined();
      expect(h.replies[0]!.metadata.decisionAnswer).toMatchObject({ answer, text: line, by: "operator" });
      expect(view.state).toBe("answered");
      expect(view.answer?.text).toBe(line);
      await expect(h.service.answer({ id: h.questionId, answer, requestId: "again" })).rejects.toThrow(/already settled/);
    }
  });

  test("show_more keeps the task open and asks the agent for more", async () => {
    const h = harness({ model: fakeModel(MERGE_OUTPUT) });
    await h.service.register(h.message, h.signal);
    await h.service.idle();
    const view = await h.service.answer({ id: h.questionId, answer: { kind: "show_more", note: "the app diff" }, requestId: "r1" });
    expect(h.replies[0]!.input.progress).toBe(true);
    expect(h.replies[0]!.input.body).toStartWith("Show me more before I decide: the app diff.");
    expect(view.state).toBe("needs_material");
    expect(view.requests).toEqual([{ note: "the app diff", at: 20 }]);
  });

  test("a two-way default settles the card at the deadline; a one-way card never defaults", async () => {
    const twoWay: DecisionCard = {
      kind: "decision", version: 1, question: "Merge now or wait for the app?", pick: { key: "A", why: "Safe." }, door: "two_way", defaultKey: "B",
      options: [{ key: "A", label: "Merge now", result: "Lands today.", undo: "easy" }, { key: "B", label: "Wait for the app", result: "Lands later.", undo: "easy" }],
    };
    const consult: ScoutOperatorSignal = { kind: "consult", blocking: false, replyExpectation: "optional", defaultAction: "Wait for the app" };
    const proceeded = { id: "f1", invocationId: "inv-request-abc", state: "completed", completedAt: 30, metadata: { operatorOutcome: "proceeded_with_default" } } as unknown as FlightRecord;

    const two = harness({ card: twoWay, signal: consult, invocationMeta: { defaultAction: "Wait for the app" } });
    await two.service.register(two.message, two.signal);
    two.flights.set("inv-request-abc", proceeded);
    await two.service.settleDefaulted();
    const settled = (await two.service.view(two.questionId))!;
    expect(settled.state).toBe("defaulted");
    expect(settled.answer).toMatchObject({ answer: { kind: "pick", key: "B" }, by: "default", at: 30 });
    expect(two.records.get(two.questionId)!.state).toBe("closed");

    const one = harness({ card: { ...twoWay, door: "one_way", defaultKey: undefined }, signal: consult, invocationMeta: { defaultAction: "Wait for the app" } });
    await one.service.register(one.message, one.signal);
    one.flights.set("inv-request-abc", proceeded);
    await one.service.settleDefaulted();
    expect(one.records.get(one.questionId)!.state).toBe("open");
  });
});
