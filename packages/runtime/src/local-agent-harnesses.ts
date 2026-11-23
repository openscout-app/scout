import { SCOUT_LAUNCHABLE_HARNESSES, type AgentHarness } from "@openscout/protocol";

/** Routing metadata is safe for CLI clients to import without loading adapters. */
export const SUPPORTED_LOCAL_AGENT_HARNESSES: AgentHarness[] = ["claude", "codex", "grok", "grok-acp", "kimi", "pi", "cursor", "opencode", "devin", "antigravity"];
export const SUPPORTED_SCOUT_HARNESSES: AgentHarness[] = [...SCOUT_LAUNCHABLE_HARNESSES];
