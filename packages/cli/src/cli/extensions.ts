import { runScoutExtensionWithContext } from "./extension-context-runner.ts";
import { contextRefusal, type ScoutExtensionContext } from "./extension-context.ts";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { ScoutExtension } from "@openscout/runtime/extensions";
export * from "@openscout/runtime/extensions";
type Env = NodeJS.ProcessEnv;

/**
 * Run an extension in the foreground and return its exit status. SIGTERM and
 * SIGHUP are forwarded, so a supervisor such as launchd that signals scout's PID
 * stops the extension too instead of orphaning it. Ctrl-C already reaches the
 * extension through the terminal's process group, so scout only waits for it.
 */
export async function runScoutExtension(extension: ScoutExtension, args: readonly string[], env: Env,
  invocation?: { frame: ScoutExtensionContext; selectionEnv: Env }): Promise<number> {
  if (extension.api === 2) {
    if (!invocation) contextRefusal(extension.name);
    return runScoutExtensionWithContext(extension, args, env, invocation.frame, invocation.selectionEnv);
  }
  return runScoutApi1Extension(extension, args, env);
}
async function runScoutApi1Extension(extension: ScoutExtension, args: readonly string[], env: Env): Promise<number> {
  const child = spawn(extension.command, args, { env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  const wait = () => {};
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  process.on("SIGINT", wait);
  try {
    return await new Promise<number>((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolveStatus(signal ? 128 + (osConstants.signals[signal] ?? 1) : code ?? 1));
    });
  } finally {
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
    process.off("SIGINT", wait);
  }
}

export { scoutExtensionTreeDigest, isScoutExtensionTreeDigest, SCOUT_EXTENSION_TREE_DIGEST_SCHEME, type ScoutExtensionTreeDigest } from "./extension-tree-digest.ts";
