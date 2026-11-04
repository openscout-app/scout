import { expect, test } from "bun:test";
import { parseNotifyCommandOptions } from "./notify.ts";
import { parseOperatorQuestionOptions, renderOperatorQuestionHelp } from "./operator-question.ts";
import { renderScoutHelp } from "../help.ts";
import { isOperatorQuestion, operatorMessageArgs } from "./operator.ts";

test("notify requires intentional content and supports an image", () => {
  expect(() => parseNotifyCommandOptions(["--image", "screen.png"])).toThrow("--message");
  expect(() => parseNotifyCommandOptions(["--message", "  "])).toThrow("non-empty");
  expect(() => parseNotifyCommandOptions(["--to", "other-agent"])).toThrow("unknown notify");
  expect(parseNotifyCommandOptions(["--message", "Review this", "--image", "screen.png"])).toMatchObject({ message: "Review this", image: "screen.png" });
});

test("operator permission is an explicit question, and public help teaches the new verbs", () => {
  expect(parseOperatorQuestionOptions(["--question", "May I deploy to staging?", "--permission"]).permission).toBe(true);
  expect(renderOperatorQuestionHelp()).toContain("does not grant harness permissions");
  const help = renderScoutHelp();
  expect(help).toContain("scout status --all --blocked");
  expect(help).toContain("scout ask --operator");
  expect(help).not.toContain("scout attention");
  expect(help).not.toContain("scout need");
});

test("scout operator routes a plain message to notify and question flags to the operator question", () => {
  expect(isOperatorQuestion(["Build is green"])).toBe(false);
  expect(isOperatorQuestion(["--question", "Staging or prod?"])).toBe(true);
  expect(isOperatorQuestion(["Staging or prod?", "--option", "staging"])).toBe(true);
  expect(operatorMessageArgs(["Build", "is", "green", "--image", "shot.png"]))
    .toEqual(["--message", "Build is green", "--image", "shot.png"]);
  expect(parseNotifyCommandOptions(operatorMessageArgs(["Ready to review"]))).toMatchObject({ message: "Ready to review" });
  expect(operatorMessageArgs(["--message", "Hi", "--json"])).toEqual(["--message", "Hi", "--json"]);
});
