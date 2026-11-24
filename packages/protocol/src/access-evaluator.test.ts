import { describe, expect, test } from "bun:test";

import { ACCESS_EVALUATOR_CASES, runAccessEvaluatorCases } from "./access-evaluator-cases.js";
import { can } from "./access-evaluator.js";

describe("can", () => {
  test("the shared case table has unique names", () => {
    const names = ACCESS_EVALUATOR_CASES.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const item of ACCESS_EVALUATOR_CASES) {
    test(item.name, () => {
      expect(can(item.principal, item.action, item.resource, item.turn, { now: item.now })).toEqual(item.expect);
    });
  }

  test("runAccessEvaluatorCases reports a disagreeing evaluator", () => {
    expect(runAccessEvaluatorCases(can)).toEqual([]);
    const failures = runAccessEvaluatorCases(() => ({ effect: "allow" }));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((failure) => failure.actual.effect === "allow")).toBe(true);
  });
});
