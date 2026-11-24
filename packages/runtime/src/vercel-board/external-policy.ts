import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { VercelBoardDispatchConfig, VercelBoardExternalStepConfig } from "@openscout/protocol";
import { findScoutExtension, scoutExtensionDigest, type ScoutExtension } from "../scout-extensions.js";
import type { VercelBoardDispatchStep, VercelBoardDispatchStepResult } from "./policy.js";

/**
 * An out-of-process dispatch step. The operator installs a trusted local
 * artifact with `scout extensions install`, pins its digest in the dispatch
 * settings, and names it in a chain as `external:<name>`. Each decision runs
 * the extension's command once, with one JSON request on stdin, and reads one
 * JSON answer from stdout. Nothing is loaded into the runtime.
 *
 * A missing or refused extension, a changed digest, a timeout, a non-zero
 * exit, more output than the bound, or an answer outside the contract skips
 * the task. The step never claims on a bad answer.
 */

export const VERCEL_BOARD_EXTERNAL_POLICY_PROTOCOL = 1;
export const VERCEL_BOARD_EXTERNAL_POLICY_DEFAULT_TIMEOUT_MS = 2_000;
/** The argument the command gets, so one extension can serve several hooks and its CLI verb. */
export const VERCEL_BOARD_EXTERNAL_POLICY_ARGV = ["vercel-board-dispatch"];
const OUTPUT_LIMIT = 64 * 1024;

export interface VercelBoardExternalPolicyDeps {
  env: NodeJS.ProcessEnv;
  find?: (name: string, env: NodeJS.ProcessEnv) => ScoutExtension | undefined;
  digest?: (extension: ScoutExtension) => string;
  /** The runtime's own directory, first on the child's PATH so `#!/usr/bin/env bun` resolves. */
  runtimeDir?: string;
}

/** The extension the config names, verified against its pinned digest. Throws with the reason it cannot run. */
export function resolveVercelBoardExternalPolicy(config: VercelBoardExternalStepConfig, deps: VercelBoardExternalPolicyDeps): ScoutExtension {
  const extension = (deps.find ?? findScoutExtension)(config.extension, deps.env);
  if (!extension) throw new Error(`extension ${config.extension} is not installed`);
  if (extension.refused) throw new Error(`extension ${config.extension} is refused: ${extension.refused}`);
  let digest: string;
  try { digest = (deps.digest ?? scoutExtensionDigest)(extension); } catch { throw new Error(`extension ${config.extension} cannot be digested`); }
  if (digest !== config.digest) throw new Error(`extension ${config.extension} has digest ${digest}, not the pinned ${config.digest}`);
  return extension;
}

/** Run one command with a JSON request on stdin. Resolves its stdout; rejects on timeout, a non-zero exit or too much output. */
function runOnce(command: string, input: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Its own process group, so a timeout also stops anything the command started.
    const child = spawn(command, VERCEL_BOARD_EXTERNAL_POLICY_ARGV, { stdio: ["pipe", "pipe", "ignore"], env, detached: true });
    const stop = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      child.kill("SIGKILL");
    };
    let out = "";
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { stop(); reject(error); } else resolvePromise(out);
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > OUTPUT_LIMIT) finish(new Error("answered more than 64 KiB"));
    });
    child.on("error", error => finish(new Error(`could not start: ${error.message}`)));
    child.on("close", (code, signal) => finish(code === 0 ? undefined : new Error(signal ? `stopped by ${signal}` : `exited ${code}`)));
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(input);
  });
}

const isText = (value: unknown, max = 500): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** Read an answer, strictly. Anything outside the contract is an error, and an error skips the task. */
export function parseVercelBoardExternalAnswer(raw: string, agents: { agentId: string }[]): VercelBoardDispatchStepResult {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { throw new Error("answered something other than JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("answered something other than a JSON object");
  const note = value.note === undefined ? undefined : isText(value.note) ? value.note : (() => { throw new Error("note must be text"); })();
  if (value.result === "skip") {
    if (!isText(value.reason)) throw new Error("a skip needs a reason");
    return { result: "skip", reason: value.reason };
  }
  if (value.result === "claim") {
    if (!isText(value.agentId, 256)) throw new Error("a claim needs an agentId");
    if (value.profile !== undefined && !isText(value.profile, 64)) throw new Error("profile must be text");
    return { result: "claim", agentId: value.agentId, ...(value.profile ? { profile: value.profile as string } : {}), ...(note ? { note } : {}) };
  }
  if (value.result === "pass") {
    if (value.agents !== undefined && (!Array.isArray(value.agents) || !value.agents.every(id => isText(id, 256)))) throw new Error("agents must be a list of agent IDs");
    if (value.profile !== undefined && !isText(value.profile, 64)) throw new Error("profile must be text");
    const keep = value.agents ? new Set(value.agents as string[]) : undefined;
    return { result: "pass", ...(keep ? { agents: agents.filter(agent => keep.has(agent.agentId)) as never } : {}), ...(value.profile ? { profile: value.profile as string } : {}), ...(note ? { note } : {}) };
  }
  throw new Error("result must be pass, skip or claim");
}

/** The `external:<name>` steps a dispatch block defines. Building them runs nothing. */
export function vercelBoardExternalSteps(dispatch: VercelBoardDispatchConfig | undefined, deps: VercelBoardExternalPolicyDeps): Record<string, VercelBoardDispatchStep> {
  return Object.fromEntries(Object.entries(dispatch?.external ?? {}).map(([name, config]) => [`external:${name}`, vercelBoardExternalStep(name, config, deps)]));
}

/** Why a dispatch block's external steps cannot run: not installed, refused, or not the pinned artifact. */
export function vercelBoardExternalProblems(dispatch: VercelBoardDispatchConfig, deps: VercelBoardExternalPolicyDeps): string[] {
  const problems: string[] = [];
  for (const [name, config] of Object.entries(dispatch.external ?? {})) {
    try { resolveVercelBoardExternalPolicy(config, deps); } catch (error) { problems.push(`dispatch.external.${name}: ${(error as Error).message}`); }
  }
  return problems;
}

/** The step for one `external:<name>` entry. */
export function vercelBoardExternalStep(name: string, config: VercelBoardExternalStepConfig, deps: VercelBoardExternalPolicyDeps): VercelBoardDispatchStep {
  return {
    kind: "external", summary: `Ask extension ${config.extension} (pinned ${config.digest.slice(0, 12)}).`,
    run: async (candidate, state, settings) => {
      const extension = resolveVercelBoardExternalPolicy(config, deps);
      const request = {
        protocol: VERCEL_BOARD_EXTERNAL_POLICY_PROTOCOL, step: `external:${name}`,
        candidate: { ...candidate, connection: { id: candidate.connection.id, principal: candidate.connection.principal, profile: candidate.connection.profile, roles: candidate.connection.roles ?? [] } },
        state: { agents: state.agents, ...(state.profile ? { profile: state.profile } : {}), ...(state.role !== undefined ? { role: state.role } : {}) },
        settings: { policy: settings.policy, trust: settings.trust, labels: settings.labels },
      };
      // No Scout credentials and no runtime URL: a policy decides from the request alone.
      const env: NodeJS.ProcessEnv = {
        PATH: [deps.runtimeDir ?? dirname(process.execPath), deps.env.PATH].filter(Boolean).join(":"),
        ...(deps.env.HOME ? { HOME: deps.env.HOME } : {}),
        SCOUT_EXTENSION_API: String(extension.api ?? 1),
        SCOUT_EXTENSION_NAME: extension.name,
        SCOUT_EXTENSION_HOOK: "vercel-board-dispatch",
      };
      const raw = await runOnce(extension.command, JSON.stringify(request), env, config.timeoutMs ?? VERCEL_BOARD_EXTERNAL_POLICY_DEFAULT_TIMEOUT_MS);
      return parseVercelBoardExternalAnswer(raw, state.agents);
    },
  };
}
