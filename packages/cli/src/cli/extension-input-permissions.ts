import { selectedScoutExtensionInvocation } from "./extension-context.ts";
import { normalizeScoutExtensionDestination } from "@openscout/runtime/extensions";
import { resolveScoutHome } from "@openscout/runtime/config";
import type { ScoutCommandContext } from "./context.ts";
import { grantScoutExtensionInput, inputRefusal, listScoutExtensionInputGrants, revokeScoutExtensionInputGrant, scoutExtensionGrantStore, selectedScoutExtensionInput, type ExtensionInputSelection } from "./extension-input-grants.ts";

export function runExtensionInputPermissions(context: ScoutCommandContext, args: string[]): void {
  const invalid = () => inputRefusal("extensions", "input_policy_invalid");
  if (args[0] === "list" && args.length === 1) {
    const policy = listScoutExtensionInputGrants(context.env);
    context.output.writeValue({ path: scoutExtensionGrantStore(context.env), ...policy }, value => `${value.grants.length} exact-tree grants (${value.path})`); return;
  }
  if (args[0] === "revoke" && args.length === 2) {
    const result = revokeScoutExtensionInputGrant(context.env, args[1]!);
    context.output.writeValue(result, value => `${value.id}: revoked`); return;
  }
  const [action, name] = args;
  if (!name || !/^[a-z][a-z0-9-]{0,39}$/.test(name) || !["inspect", "grant"].includes(action!)) invalid();
  const captured = selectedScoutExtensionInvocation();
  if (!captured) inputRefusal("extensions", "context_invalid");
  const selection: ExtensionInputSelection = { uid: captured.uid, home: captured.home, instance: captured.layout.name,
    instanceRoot: captured.layout.root, scoutHome: resolveScoutHome({ env: context.env, home: captured.home }), endpoint: captured.values.OPENSCOUT_DIST_URL };
  const { binding, extension } = selectedScoutExtensionInput(name!, context.env, selection);
  if (action === "inspect") {
    if (args.length !== 2) invalid();
    context.output.writeValue({ binding, declaration: extension.invocation, originEvidence: "unknown-local", store: scoutExtensionGrantStore(context.env) }, value => `${value.binding.verb}: SCOUT_DIST_KEY; UID ${value.binding.uid}; instance ${value.binding.instance}; root ${value.binding.extensionRoot.path}; unknown/local origin; purpose: ${value.declaration!.credentialInputs![0]!.purpose}; exact tree ${value.binding.treeDigest}; declaration ${value.binding.declarationDigest}; ${value.binding.destination.origin}${value.binding.destination.basePath}`); return;
  }
  if (args.includes("--continuity")) inputRefusal(name!, "input_provenance_unverified");
  const flags = new Map<string, string>(); let acknowledged = false;
  for (let index = 2; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--acknowledge-unknown-origin") { if (acknowledged) invalid(); acknowledged = true; continue; }
    if (!["--tree-digest", "--declaration-digest", "--input", "--destination"].includes(key) || flags.has(key)) invalid();
    const value = args[++index]; if (!value || value.startsWith("--")) invalid(); flags.set(key, value!);
  }
  if (!acknowledged || flags.size !== 4) invalid();
  let destination: { origin: string; basePath: string };
  try { destination = normalizeScoutExtensionDestination(flags.get("--destination")!); } catch { invalid(); }
  if (flags.get("--tree-digest") !== binding.treeDigest || flags.get("--declaration-digest") !== binding.declarationDigest
    || flags.get("--input") !== binding.input || destination!.origin !== binding.destination.origin || destination!.basePath !== binding.destination.basePath) inputRefusal(name!, "input_not_authorized");
  const grant = grantScoutExtensionInput(context.env, binding, () => selectedScoutExtensionInput(name!, context.env, selection).binding);
  context.output.writeValue(grant, value => `${value.id}: granted to the exact selected tree; origin remains unknown/local`);
}
