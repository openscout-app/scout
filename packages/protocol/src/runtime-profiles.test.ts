import { describe, expect, test } from "bun:test";

import {
  normalizeReservedRuntimeProfileId,
  normalizeRuntimeProfileReasoningEffort,
  SCOUT_RESERVED_RUNTIME_PROFILE_IDS,
} from "./runtime-profiles.js";

describe("runtime profile syntax", () => {
  test("publishes only deterministic reserved natural-language names", () => {
    expect(SCOUT_RESERVED_RUNTIME_PROFILE_IDS).toEqual([
      "antigravity",
      "fable",
      "kimi",
      "grok",
      "opus",
      "oc",
      "opencode",
    ]);
    expect(normalizeReservedRuntimeProfileId(" FABLE ")).toBe("fable");
    expect(normalizeReservedRuntimeProfileId(" OC ")).toBe("oc");
    expect(normalizeReservedRuntimeProfileId("Composer Review")).toBeNull();
  });

  test("normalizes optional effort without accepting guesses", () => {
    expect(normalizeRuntimeProfileReasoningEffort("XHIGH")).toBe("xhigh");
    expect(normalizeRuntimeProfileReasoningEffort("very-high")).toBeNull();
  });
});
