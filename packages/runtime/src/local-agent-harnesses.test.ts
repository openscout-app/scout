import { expect, test } from "bun:test";
import { SCOUT_LAUNCHABLE_HARNESSES } from "@openscout/protocol";
import { SUPPORTED_LOCAL_AGENT_HARNESSES, SUPPORTED_SCOUT_HARNESSES } from "./local-agent-harnesses.js";
import { SUPPORTED_LOCAL_AGENT_HARNESSES as legacyLocal, SUPPORTED_SCOUT_HARNESSES as legacyScout } from "./local-agents.js";

test("lightweight harness metadata preserves the public adapter exports", () => {
  expect(SUPPORTED_LOCAL_AGENT_HARNESSES).toEqual(["claude", "codex", "grok", "grok-acp", "kimi", "pi", "cursor", "opencode", "devin", "antigravity"]);
  expect(SUPPORTED_SCOUT_HARNESSES).toEqual(SCOUT_LAUNCHABLE_HARNESSES);
  expect(legacyLocal).toBe(SUPPORTED_LOCAL_AGENT_HARNESSES);
  expect(legacyScout).toBe(SUPPORTED_SCOUT_HARNESSES);
});
