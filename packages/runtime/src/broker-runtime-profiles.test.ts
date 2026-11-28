import { describe, expect, test } from "bun:test";

import {
  executionForBrokerRuntimeProfile,
  resolveBrokerRuntimeProfile,
} from "./broker-runtime-profiles.js";

describe("broker runtime profiles", () => {
  test("owns the reserved profile execution definitions", () => {
    expect(resolveBrokerRuntimeProfile("Fable")?.execution).toEqual({
      harness: "claude",
      model: "fable",
      session: "new",
    });
    expect(resolveBrokerRuntimeProfile("Carbon")?.execution).toEqual({
      harness: "antigravity",
      model: "gemini-4-carbon",
      session: "new",
    });
    expect(resolveBrokerRuntimeProfile("Neon")?.execution).toEqual({
      harness: "antigravity",
      model: "gemini-4-neon",
      session: "new",
    });
    expect(resolveBrokerRuntimeProfile("Kimi")?.execution).toEqual({
      harness: "kimi",
      session: "new",
    });
    expect(resolveBrokerRuntimeProfile("Grok")?.execution).toEqual({
      harness: "grok",
      session: "new",
    });
    expect(resolveBrokerRuntimeProfile("Opus")?.execution).toEqual({
      harness: "claude",
      model: "opus",
      session: "new",
    });
    expect(resolveBrokerRuntimeProfile("oc")?.execution).toEqual({
      harness: "opencode",
      session: "new",
    });
    expect(resolveBrokerRuntimeProfile("OpenCode")?.execution).toEqual({
      harness: "opencode",
      session: "new",
    });
  });

  test("accepts only known optional effort values", () => {
    expect(executionForBrokerRuntimeProfile({
      profileId: "opus",
      reasoningEffort: "HIGH",
    })).toEqual({
      harness: "claude",
      model: "opus",
      reasoningEffort: "high",
      session: "new",
    });
    expect(executionForBrokerRuntimeProfile({
      profileId: "carbon",
      reasoningEffort: "HIGH",
    })).toEqual({
      harness: "antigravity",
      model: "gemini-4-carbon",
      reasoningEffort: "high",
      session: "new",
    });
    expect(executionForBrokerRuntimeProfile({
      profileId: "neon",
      reasoningEffort: "XHIGH",
    })).toEqual({
      harness: "antigravity",
      model: "gemini-4-neon",
      reasoningEffort: "xhigh",
      session: "new",
    });
    expect(executionForBrokerRuntimeProfile({
      profileId: "opus",
      reasoningEffort: "surprise-me",
    })).toBeNull();
    expect(executionForBrokerRuntimeProfile({
      profileId: "kimi",
      reasoningEffort: "high",
    })).toBeNull();
    expect(executionForBrokerRuntimeProfile({
      profileId: "grok",
      reasoningEffort: "high",
    })).toBeNull();
    expect(resolveBrokerRuntimeProfile("composer-review")).toBeNull();
  });
});
