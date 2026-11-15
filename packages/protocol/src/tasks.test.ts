import { expect, test } from "bun:test";
import { taskNotificationPolicy, validateTaskAsk, validateTaskReply, type ScoutTaskAsk } from "./tasks.js";

const task = (patch: Partial<ScoutTaskAsk> = {}): ScoutTaskAsk => ({ version: 1, ...patch });
const CALLBACK = "export default ({ result, scout }) => scout.open(result.files[0]);";
test.each([
  [{}, {}, "exactly one"],
  [{ operator: true }, { to: "worker" }, "exactly one"],
  [{ options: ["yes"] }, { to: "worker" }, "--option"],
  [{ operator: true, fyi: true, options: ["yes"] }, {}, "--option"],
  [{ permission: true }, { to: "worker" }, "--permission requires --operator"],
  [{ permission: true, because: "needs a deploy" }, { capability: true }, "--permission requires --operator"],
  [{ because: "  " }, { to: "worker" }, "--because cannot be empty"],
  [{ fyi: true, ref: "task" }, {}, "--fyi"],
  [{ fyi: true, continue: "task" }, {}, "--fyi"],
  [{ fyi: true }, { capability: true }, "--fyi"],
  [{ cancel: true }, { to: "worker" }, "--cancel"],
  [{ defaultAction: "yes" }, { to: "worker" }, "--default-action"],
  [{ operator: true, fyi: true, defaultAction: "yes" }, {}, "--default-action"],
  [{}, { channel: "shared" }, "--channel"],
  [{ operator: true, defaultAction: "yes", options: ["no"] }, {}, "one of the options"],
  [{ operator: true, defaultAction: "yes", permission: true }, {}, "permission requests block"],
  [{ ref: "task" }, { execution: true }, "execution flags"],
  [{ fyi: true }, { to: "worker", execution: true }, "execution flags"],
  [{ continue: "task" }, { relation: true }, "--continue-for"],
  [{ operator: true, window: 10 }, {}, "--default-action"],
  [{ operator: true, window: 0 }, {}, "--window"],
  [{ operator: true, window: NaN }, {}, "--window"],
  [{ callback: { code: "  " } }, { to: "worker" }, "--callback takes a JavaScript module file"],
  [{ callback: "open" as never }, { to: "worker" }, "--callback takes a JavaScript module file"],
  [{ callback: { code: "x".repeat(16_001) } }, { to: "worker" }, "up to 16000 characters"],
  [{ callback: { code: CALLBACK }, fyi: true }, { to: "worker" }, "--callback belongs"],
  [{ callback: { code: CALLBACK }, ref: "task" }, {}, "--callback belongs"],
  [{ callback: { code: CALLBACK }, ref: "task", cancel: true }, {}, "--callback belongs"],
  [{ callback: { code: CALLBACK }, operator: true }, {}, "--callback belongs"],
  [{ callback: { code: CALLBACK }, fyi: true }, { channel: "shared" }, "--callback belongs"],
] as const)("invalid ask %# fails before effects", (patch, route, error) => {
  expect(() => validateTaskAsk(task(patch), route)).toThrow(error);
});
test.each([
  [{}, { to: "worker" }],
  [{}, { capability: true }],
  [{ ref: "task" }, {}],
  [{ ref: "task", cancel: true }, {}],
  [{ continue: "task" }, { execution: true }],
  [{ operator: true, notify: true }, {}],
  // A reason rides on any ask; --notify on an agent ask returns on acceptance.
  [{ because: "the release branch is red" }, { to: "worker" }],
  [{ because: "the release branch is red" }, { capability: true }],
  [{ because: "scope changed", ref: "task" }, {}],
  [{ because: "scope changed", continue: "task" }, {}],
  [{ because: "news", fyi: true }, { to: "worker" }],
  [{ operator: true, permission: true, because: "needs a deploy" }, {}],
  [{ notify: true }, { to: "worker" }],
  [{ notify: true }, { capability: true }],
  [{ operator: true, defaultAction: "yes", options: ["yes", "no"] }, {}],
  [{ operator: true, fyi: true, notify: true }, {}],
  [{ fyi: true }, { channel: "shared" }],
  [{ callback: { code: CALLBACK } }, { to: "worker" }],
  [{ callback: { code: CALLBACK } }, { capability: true }],
  [{ callback: { code: CALLBACK }, continue: "task" }, { execution: true }],
] as const)("valid ask %#", (patch, route) => {
  expect(() => validateTaskAsk(task(patch), route)).not.toThrow();
});
test.each([{}, { ref: "task", to: "message" }, { ref: "task", progress: true, failed: true },
  { to: "message", progress: true }, { to: "message", failed: true }])("invalid reply %#", reply => {
  expect(() => validateTaskReply(reply)).toThrow();
});
test("notification policy separates FYIs, interrupting questions and normal defaults", () => {
  expect(taskNotificationPolicy(task({ operator: true, fyi: true }))).toEqual({ requested: false, priority: "interrupting" });
  expect(taskNotificationPolicy(task({ operator: true, fyi: true, notify: true }))).toEqual({ requested: true, priority: "interrupting" });
  expect(taskNotificationPolicy(task({ operator: true }))).toEqual({ requested: true, priority: "interrupting" });
  expect(taskNotificationPolicy(task({ operator: true, defaultAction: "staging" }))).toEqual({ requested: true, priority: "normal" });
});
