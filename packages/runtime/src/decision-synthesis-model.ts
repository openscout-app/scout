import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  invokeClaudeStreamJsonAgent,
  shutdownClaudeStreamJsonAgent,
} from "./claude-stream-json.js";
import type { DecisionModel } from "./decision-synthesis.js";
import { relayAgentLogsDirectory, relayAgentRuntimeDirectory } from "./support-paths.js";
import { resolveClaudeExecutable } from "./tool-resolution.js";

/**
 * The model the harness picks for a card: Claude Code's own `haiku` alias, so
 * the harness resolves it to its current small model. Override it with
 * `SCOUT_DECISION_SYNTHESIS_MODEL` (any value `claude --model` accepts).
 */
export const DECISION_SYNTHESIS_MODEL = "haiku";
/** The broker-side name of the synthesis session. It never appears as an agent. */
export const DECISION_SYNTHESIS_AGENT = "scout-decision-synthesis";
const TIMEOUT_MS = 90_000;

/**
 * The flags that keep a synthesis turn small: the harness's own small model,
 * low effort, no tools, no MCP servers, no skills, and nothing saved to disk.
 * The short system prompt replaces Claude Code's default one.
 */
export function decisionSynthesisLaunchArgs(model: string): string[] {
  return [
    "--model", model,
    "--effort", "low",
    "--tools", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt", "You read text and reply with one JSON object. You use no tools.",
  ];
}

/**
 * Whether this runtime can lay asks out as cards: the Claude CLI resolves,
 * and `SCOUT_DECISION_SYNTHESIS` is not `0` or `off`. The call uses the
 * operator's signed-in harness, so there is no key to configure.
 */
export function decisionSynthesisConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !decisionSynthesisSwitchedOff(env) && resolveClaudeExecutable(env) !== null;
}

function decisionSynthesisSwitchedOff(env: NodeJS.ProcessEnv): boolean {
  const value = env.SCOUT_DECISION_SYNTHESIS?.trim().toLowerCase();
  return value === "0" || value === "off" || value === "false";
}

/** Take the one JSON object out of the harness's reply. Anything else is no output. */
export function parseHarnessJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

type SchemaNode = {
  type?: string;
  enum?: readonly string[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  anyOf?: readonly SchemaNode[];
};

/**
 * The reply's shape, written out for the model: one example object with a
 * placeholder per field, then one rule per field. A raw JSON Schema invites
 * the model to echo the schema itself; the runtime still validates the reply
 * against the schema.
 */
export function describeJsonShape(schema: Record<string, unknown>): string {
  const rules: string[] = [];
  const shape = (node: SchemaNode, path: string): string => {
    if (node.description) rules.push(`- ${path}: ${node.description}`);
    if (node.anyOf) return node.anyOf.map((option) => shape({ ...option, description: undefined }, path)).join(" or ");
    if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
    if (node.type === "object" && node.properties) {
      const fields = Object.entries(node.properties).map(([key, child]) => `${JSON.stringify(key)}: ${shape(child, path ? `${path}.${key}` : key)}`);
      return `{ ${fields.join(", ")} }`;
    }
    if (node.type === "array" && node.items) return `[ ${shape(node.items, `${path}[]`)}, ... ]`;
    if (node.type === "boolean") return "true | false";
    if (node.type === "null") return "null";
    return "\"...\"";
  };
  const example = shape(schema as SchemaNode, "");
  return [`The object has exactly this shape:\n${example}`, `Fields:\n${rules.join("\n")}`].join("\n\n");
}

type ClaudeTurn = typeof invokeClaudeStreamJsonAgent;
type ClaudeShutdown = typeof shutdownClaudeStreamJsonAgent;

/**
 * One turn through Scout's Claude CLI path (`claude --print`, stream-json), on
 * the operator's signed-in harness. Each card gets a fresh session: the turn
 * runs, then the session is shut down and reset, so no card sees another's
 * text. No retries: a failed turn leaves the plain ask.
 */
export function createDecisionModel(
  env: NodeJS.ProcessEnv = process.env,
  deps: { invoke?: ClaudeTurn; shutdown?: ClaudeShutdown; runtimeDirectory?: string; logsDirectory?: string } = {},
): DecisionModel | undefined {
  if (decisionSynthesisSwitchedOff(env)) return undefined;
  if (!deps.invoke && !decisionSynthesisConfigured(env)) return undefined;
  const model = env.SCOUT_DECISION_SYNTHESIS_MODEL?.trim() || DECISION_SYNTHESIS_MODEL;
  const invoke = deps.invoke ?? invokeClaudeStreamJsonAgent;
  const shutdown = deps.shutdown ?? shutdownClaudeStreamJsonAgent;
  const runtimeDirectory = deps.runtimeDirectory ?? relayAgentRuntimeDirectory(DECISION_SYNTHESIS_AGENT);
  const logsDirectory = deps.logsDirectory ?? relayAgentLogsDirectory(DECISION_SYNTHESIS_AGENT);
  // An empty folder: no project instructions load into the turn.
  const cwd = join(runtimeDirectory, "workspace");
  return {
    model,
    via: "claude-cli",
    async extract({ system, prompt, schema }) {
      await mkdir(cwd, { recursive: true });
      const session = {
        agentName: DECISION_SYNTHESIS_AGENT,
        sessionId: "decision-synthesis",
        cwd,
        systemPrompt: [
          system,
          "Reply with exactly one JSON object holding your reading of the question, and nothing else: no prose, no code fence.",
          describeJsonShape(schema),
        ].join("\n\n"),
        runtimeDirectory,
        logsDirectory,
        launchArgs: decisionSynthesisLaunchArgs(model),
      };
      try {
        const { output } = await invoke({ ...session, prompt, timeoutMs: TIMEOUT_MS });
        return { output: parseHarnessJson(output) };
      } finally {
        await shutdown(session, { resetSession: true }).catch(() => undefined);
      }
    },
  };
}
