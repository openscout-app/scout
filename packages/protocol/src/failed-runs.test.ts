import { expect, test } from "bun:test";
import { FAILED_RUN_CAUSES, failedRunCause, failedRunRetryable, FAILED_RUN_ACTIONS } from "./failed-runs.js";

test.each(FAILED_RUN_CAUSES)("%s is a closed cause with an explicit next action", cause => {
  expect(failedRunCause({ metadata: { failureCause: cause } })).toBe(cause);
  expect(failedRunRetryable(cause)).toBe(cause === "endpoint_lost" || cause === "harness_start");
  expect(FAILED_RUN_ACTIONS[cause].length).toBeGreaterThan(20);
});

test("legacy and unrecognized causes are unknown without parsing error prose", () => {
  expect(failedRunCause({})).toBe("unknown");
  expect(failedRunCause({ metadata: { failureCause: "typo", summary: "disk full; superseded" } })).toBe("unknown");
});
