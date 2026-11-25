import type { RuntimeEnv } from "./portable-types.js";
const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type CodingAgentHarness = "scout" | "cursor" | "claude" | "codex" | "devin" | "kimi" | "pi" | "antigravity";

export type CodingAgentHostMatch = {
  harness: CodingAgentHarness;
  /** Env var that triggered detection — shown in scout whoami for transparency. */
  signal: string;
};

type HarnessSignal = {
  harness: CodingAgentHarness;
  signal: string;
  matches: (env: RuntimeEnv) => boolean;
};

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized ? TRUTHY.has(normalized) : false;
}

function hasNonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function envEquals(env: RuntimeEnv, key: string, expected: string): boolean {
  return env[key]?.trim().toLowerCase() === expected;
}

function isHerdrManagedAgent(env: RuntimeEnv, kind: string): boolean {
  return isTruthyFlag(env.HERDR_ENV)
    && hasNonEmpty(env.HERDR_PANE_ID)
    && hasNonEmpty(env.HERDR_AGENT_NAME)
    && envEquals(env, "HERDR_AGENT", kind);
}

/** Vendor-documented subprocess/host signals for the top harnesses Scout routes.
 *  Order matters: Scout binding wins, then the most specific vendor flags. */
const HARNESS_SIGNALS: HarnessSignal[] = [
  {
    harness: "scout",
    signal: "OPENSCOUT_AGENT",
    matches: (env) => hasNonEmpty(env.OPENSCOUT_AGENT),
  },
  {
    harness: "scout",
    signal: "OPENSCOUT_MANAGED_AGENT",
    matches: (env) => isTruthyFlag(env.OPENSCOUT_MANAGED_AGENT),
  },
  {
    harness: "cursor",
    signal: "HERDR_AGENT_NAME",
    matches: (env) => isHerdrManagedAgent(env, "cursor"),
  },
  {
    harness: "claude",
    signal: "HERDR_AGENT_NAME",
    matches: (env) => isHerdrManagedAgent(env, "claude"),
  },
  {
    harness: "codex",
    signal: "HERDR_AGENT_NAME",
    matches: (env) => isHerdrManagedAgent(env, "codex"),
  },
  {
    harness: "devin",
    signal: "HERDR_AGENT_NAME",
    matches: (env) => isHerdrManagedAgent(env, "devin"),
  },
  {
    harness: "kimi",
    signal: "HERDR_AGENT_NAME",
    matches: (env) => isHerdrManagedAgent(env, "kimi"),
  },
  {
    harness: "pi",
    signal: "HERDR_AGENT_NAME",
    matches: (env) => isHerdrManagedAgent(env, "pi"),
  },
  {
    harness: "antigravity",
    signal: "HERDR_AGENT_NAME",
    matches: (env) => isHerdrManagedAgent(env, "antigravity") || isHerdrManagedAgent(env, "agy"),
  },
  {
    harness: "antigravity",
    signal: "ANTIGRAVITY_AGENT",
    matches: (env) => isTruthyFlag(env.ANTIGRAVITY_AGENT),
  },
  {
    harness: "antigravity",
    signal: "ANTIGRAVITY_CONVERSATION_ID",
    matches: (env) => hasNonEmpty(env.ANTIGRAVITY_CONVERSATION_ID),
  },
  {
    harness: "cursor",
    signal: "CURSOR_AGENT",
    matches: (env) => isTruthyFlag(env.CURSOR_AGENT),
  },
  {
    harness: "claude",
    signal: "CLAUDECODE",
    matches: (env) => isTruthyFlag(env.CLAUDECODE),
  },
  {
    harness: "claude",
    signal: "CLAUDE_CODE_CHILD_SESSION",
    matches: (env) => isTruthyFlag(env.CLAUDE_CODE_CHILD_SESSION),
  },
  {
    harness: "claude",
    signal: "CLAUDE_CODE_REMOTE",
    matches: (env) => isTruthyFlag(env.CLAUDE_CODE_REMOTE),
  },
  {
    harness: "claude",
    signal: "CLAUDE_CODE_SESSION_ID",
    matches: (env) => hasNonEmpty(env.CLAUDE_CODE_SESSION_ID),
  },
  {
    harness: "claude",
    signal: "CLAUDE_SESSION_ID",
    matches: (env) => hasNonEmpty(env.CLAUDE_SESSION_ID),
  },
  {
    harness: "claude",
    signal: "CLAUDE_CODE_REMOTE_SESSION_ID",
    matches: (env) => hasNonEmpty(env.CLAUDE_CODE_REMOTE_SESSION_ID),
  },
  {
    harness: "codex",
    signal: "AGENT",
    matches: (env) => envEquals(env, "AGENT", "codex"),
  },
  {
    harness: "codex",
    signal: "CODEX_THREAD_ID",
    matches: (env) => hasNonEmpty(env.CODEX_THREAD_ID),
  },
  {
    harness: "codex",
    signal: "OPENSCOUT_CODEX_THREAD_ID",
    matches: (env) => hasNonEmpty(env.OPENSCOUT_CODEX_THREAD_ID),
  },
  {
    harness: "codex",
    signal: "CODEX_CI",
    matches: (env) => isTruthyFlag(env.CODEX_CI),
  },
  {
    harness: "codex",
    signal: "CODEX_SANDBOX",
    matches: (env) => hasNonEmpty(env.CODEX_SANDBOX),
  },
  {
    // Devin CLI exports CHISEL_SESSION_DB (its session database path) into the
    // shells it spawns. Require a devin-scoped value so an unrelated chisel
    // variable cannot misattribute the host.
    harness: "devin",
    signal: "CHISEL_SESSION_DB",
    matches: (env) => hasNonEmpty(env.CHISEL_SESSION_DB) && env.CHISEL_SESSION_DB!.includes("devin"),
  },
];

/** Identify which top harness host spawned this shell, if any. */
export function detectCodingAgentHost(
  env: RuntimeEnv = process.env,
): CodingAgentHostMatch | null {
  for (const entry of HARNESS_SIGNALS) {
    if (entry.matches(env)) {
      return { harness: entry.harness, signal: entry.signal };
    }
  }
  return null;
}

/** True when the current process looks like a coding-agent host rather than a
 *  human operator shell. */
export function isCodingAgentHost(env: RuntimeEnv = process.env): boolean {
  return detectCodingAgentHost(env) !== null;
}
