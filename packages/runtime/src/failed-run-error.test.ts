import { PermissionDeliveryUnconfirmedError } from "./broker-permission-service.js";
import { expect, test } from "bun:test";
import { FailedRunError, failureCauseForError } from "./failed-run-error.js";

test("errno survives wrapping and overrides the outer classification", () => {
  const disk = Object.assign(new Error("No reply file"), { code: "ENOSPC" });
  expect(failureCauseForError(new FailedRunError("harness_start", "submit failed", { cause: disk }), "unknown")).toBe("disk_full");
  expect(failureCauseForError(new FailedRunError("harness_start", "No composer"), "unknown")).toBe("harness_start");
  expect(failureCauseForError(new Error("ENOSPC in arbitrary prose"), "unknown")).toBe("unknown");
  const cycle = { cause: undefined as unknown }; cycle.cause = cycle;
  expect(failureCauseForError(cycle, "unknown")).toBe("unknown");
});


test("a permission delivery failure cannot become a retryable startup failure", () => {
  expect(failureCauseForError(new PermissionDeliveryUnconfirmedError("Keys were not acknowledged"), "harness_start")).toBe("harness_error");
});
