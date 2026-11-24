import { ScoutCommandUnavailableError } from "./command-unavailable.ts";
import { executeScoutExtensionContext } from "./extension-context-executor.ts";
export { scoutExtensionContextStdio, stopScoutExtensionContextChild } from "./extension-context-executor.ts";
import { inputRefusal } from "./extension-input-grants.ts";
import { loadScoutExtensionChannelHost, scoutExtensionContextBackend } from "./extension-context-host.ts";
import { realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { findScoutExtension, scoutExtensionRoots, type ScoutExtension } from "@openscout/runtime/extensions";
import { readScoutExtensionInstallReceipt } from "./extension-install.ts";
import { contextRefusal, encodeScoutExtensionContext, projectScoutExtensionContext, type ScoutExtensionContext, type ScoutExtensionSelection } from "./extension-context.ts";

export function prepareScoutExtensionContext(input: {
  extension: ScoutExtension; env: NodeJS.ProcessEnv; selection: ScoutExtensionSelection | undefined;
  cli: ScoutExtensionContext["cli"]; brokerUrl: string; ports?: { broker?: number; web?: number; pairing?: number };
}): ScoutExtensionContext {
  const { extension, env } = input;
  if (!input.selection || !extension.invocation) contextRefusal(extension.name);
  try {
    const receipt = readScoutExtensionInstallReceipt(extension.name, env);
    if (!receipt.treeDigest || receipt.status !== "installed") throw new Error();
    return projectScoutExtensionContext({ selection: input.selection, invocation: extension.invocation,
      cli: input.cli, brokerUrl: input.brokerUrl, ports: input.ports,
      extension: { name: extension.name, selectedRoot: realpathSync(extension.root), readRoots: scoutExtensionRoots(env).map(root => resolve(input.cli.cwd, root)),
        artifact: receipt.publishedGeneration, version: receipt.version, treeDigest: receipt.treeDigest } });
  } catch { contextRefusal(extension.name); }
}

function sameSelection(extension: ScoutExtension, frame: ScoutExtensionContext, env: NodeJS.ProcessEnv): boolean {
  try {
    const current = findScoutExtension(extension.name, env), receipt = readScoutExtensionInstallReceipt(extension.name, env);
    return !!current && !current.refused && current.api === 2 && current.command === extension.command
      && JSON.stringify(current.invocation) === JSON.stringify(extension.invocation)
      && (env.OPENSCOUT_INSTANCE?.trim() || "prod") === frame.selection.instance
      && frame.selection.uid === process.getuid?.()
      && realpathSync(current.root) === frame.extensions.selectedRoot
      && realpathSync(join(current.root, current.name)) === frame.extensions.artifact
      && receipt.publishedGeneration === frame.extensions.artifact && receipt.treeDigest === frame.extensions.treeDigest;
  } catch { return false; }
}
export async function runScoutExtensionWithContext(extension: ScoutExtension, args: readonly string[], env: NodeJS.ProcessEnv,
  frame: ScoutExtensionContext, selectionEnv: NodeJS.ProcessEnv): Promise<number> {
  const wire = encodeScoutExtensionContext(frame);
  if (!sameSelection(extension, frame, selectionEnv)) contextRefusal(extension.name, "selection_changed");
  if (!scoutExtensionContextBackend()) contextRefusal(extension.name, "context_backend_unproven");
  return runScoutExtensionWithQualifiedContext(extension,args,env,frame,selectionEnv,wire);
}
/** Internal post-gate executor seam. Not a CLI/env switch or package export.
 * Public dispatch must pass the literal product gate before reaching this body.
 */
export async function runScoutExtensionWithQualifiedContext(extension: ScoutExtension,args:readonly string[],env:NodeJS.ProcessEnv,
  frame:ScoutExtensionContext,selectionEnv:NodeJS.ProcessEnv,wire=encodeScoutExtensionContext(frame)):Promise<number> {
  // Credential transport is independently unqualified. Never run a declaration with an absent channel.
  if (extension.invocation?.credentialInputs?.length) inputRefusal(extension.name, "input_backend_unproven");
  try {
    const host = await loadScoutExtensionChannelHost().catch(() => contextRefusal(extension.name, "context_backend_unproven"));
    // Loading is async, but the final selection check and host allocation are not.
    if (!sameSelection(extension, frame, selectionEnv)) contextRefusal(extension.name, "selection_changed");
    return await executeScoutExtensionContext({command:extension.command,args,env,cwd:frame.cli.cwd,wire},()=>{ try {return host.allocateExtensionChannel("context");} catch {contextRefusal(extension.name,"context_backend_unproven");} });
  } catch (error) { if (error instanceof ScoutCommandUnavailableError) throw error; contextRefusal(extension.name, "context_delivery_failed"); }
}
